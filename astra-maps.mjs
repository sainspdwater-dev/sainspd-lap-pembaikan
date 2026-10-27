import {localMetres,lineCoordinates,makeAstraMapState} from './astra-map-core.mjs';
import {featureLines,extentOfLines} from './gis-view-core.mjs';
import {loadCesium,createGisViewer,addGisContext,flyToGis} from './gis-cesium.mjs';
import {bindBuildingTiles} from './cesium-tiles.mjs';

// Only the AI Agent owns this map switcher. No operational SAINS map is replaced.
export const astraMapState=makeAstraMapState();
const byId=id=>document.getElementById(id);
let cesiumViewer=null,cesiumTilesController=null,threeView=null;
function status(message){byId('astra-map-status').textContent=message;}
function centre(){
  const coords=lineCoordinates(astraMapState.pipeGeometry).flat();
  if(coords.length){const lon=coords.reduce((a,p)=>a+p[0],0)/coords.length;
    const lat=coords.reduce((a,p)=>a+p[1],0)/coords.length;return [lon,lat];}
  if(astraMapState.selectedPosition)return [astraMapState.selectedPosition.longitude,astraMapState.selectedPosition.latitude];
  if(astraMapState.leafletViewport)return [astraMapState.leafletViewport.longitude,astraMapState.leafletViewport.latitude];
  return [101.7946,2.5225];
}
function validPoint(lon,lat){return Number.isFinite(lon)&&Number.isFinite(lat)&&Math.abs(lon)<=180&&Math.abs(lat)<=90;}
function destroyCesium(){
  cesiumTilesController?.destroy();cesiumTilesController=null;
  if(cesiumViewer&&!cesiumViewer.isDestroyed())cesiumViewer.destroy();cesiumViewer=null;
}
function destroyThree(){
  if(!threeView)return;
  cancelAnimationFrame(threeView.frame);
  threeView.target.removeEventListener('click',threeView.onPick);
  threeView.resizeObserver?.disconnect();
  threeView.controls.dispose();
  threeView.scene.traverse(object=>{
    object.geometry?.dispose();
    if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());
    else object.material?.dispose();
  });
  threeView.renderer.dispose();threeView.renderer.forceContextLoss();
  threeView.renderer.domElement.remove();threeView=null;
}
function populateCesium(C){
  const selected=astraMapState.pipeGeometry?[{type:'Feature',geometry:astraMapState.pipeGeometry,
    properties:{asset_num:astraMapState.selectedPipeId||'Dipilih'}}]:[];
  const visible=astraMapState.visibleLayers;
  const context=addGisContext(C,cesiumViewer,{
    polygons:visible.includes('polygons')?(window.koleksiPoligonDMZ||[]):[],
    pipes:visible.includes('pipes')?[...(window.sainsPipeMapFeatures?.ai||[]),...selected]:[]});
  if(visible.includes('points')){
  for(const node of astraMapState.model?.nodes||[]){
    if(!validPoint(node.longitude,node.latitude))continue;
    cesiumViewer.entities.add({name:`Nod TEST ${node.id}`,
      position:C.Cartesian3.fromDegrees(node.longitude,node.latitude),
      point:{pixelSize:7,color:C.Color.YELLOW}});
  }
  for(const row of astraMapState.observations||[]){
    if(!validPoint(row.longitude,row.latitude))continue;
    cesiumViewer.entities.add({name:`Bacaan TEST ${row.observationId} • residual ${Number(row.residualM).toFixed(2)} m`,
      position:C.Cartesian3.fromDegrees(row.longitude,row.latitude),
      point:{pixelSize:9,color:row.residualM>0?C.Color.RED:C.Color.BLUE}});
  }
  for(const row of astraMapState.leakCandidates||[]){
    if(!validPoint(row.longitude,row.latitude))continue;
    cesiumViewer.entities.add({name:`Calon siasatan TEST ${row.nodeId}`,
      position:C.Cartesian3.fromDegrees(row.longitude,row.latitude),
      point:{pixelSize:11,color:C.Color.ORANGE}});
  }
  }
  const selectedExtent=extentOfLines(featureLines(selected));
  flyToGis(C,cesiumViewer,selectedExtent||context.extent,centre());
  status(`Cesium 3D • ${context.polygonCount} sempadan, ${context.pipeCount} garisan GIS. `+
    'Peta OSM pada elipsoid; kedalaman/terrain sebenar tidak diketahui.');
  byId('astra-map-inspector').textContent=!context.polygonCount&&!context.pipeCount?
    'Tiada geometri GIS tersedia untuk pilihan ini.':'';
}
async function showCesium(){
  if(!window.WebGL2RenderingContext)throw Error('WebGL2 tidak tersedia; kekalkan Leaflet.');
  const C=await loadCesium();
  const target=byId('astra-cesium-map');
  if(!cesiumViewer){
    cesiumViewer=createGisViewer(C,target);
    cesiumTilesController=bindBuildingTiles(C,cesiumViewer,byId('astra-cesium-tiles-controls'));
    cesiumViewer.imageryLayers.get(0)?.imageryProvider?.errorEvent?.addEventListener(()=>
      status('Imej OSM gagal dimuat. Pilih Leaflet 2D; sempadan/jajaran masih data GIS tanpa terrain sebenar.'));
    const handler=new C.ScreenSpaceEventHandler(cesiumViewer.scene.canvas);
    handler.setInputAction(event=>{
      const entity=cesiumViewer.scene.pick(event.position)?.id;
      if(entity?.name?.startsWith('Jajaran GIS '))astraMapState.selectedPipeId=entity.name.slice(12);
      status(entity?.name||'Cesium 3D • bumi elipsoid, tanpa terrain/3D buildings berlesen.');
    },C.ScreenSpaceEventType.LEFT_CLICK);
    cesiumViewer._astraHandler=handler;
  }
  populateCesium(C);
}
function disposeCesium(){if(cesiumViewer?._astraHandler)cesiumViewer._astraHandler.destroy();destroyCesium();}
async function showThree(){
  if(!window.WebGL2RenderingContext)throw Error('WebGL2 tidak tersedia; kekalkan Leaflet.');
  const THREE=await import('three');
  const {OrbitControls}=await import('three/addons/controls/OrbitControls.js');
  destroyThree();
  const target=byId('astra-three-map'),width=target.clientWidth||600,height=target.clientHeight||400;
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.setSize(width,height);
  target.append(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color('#eaf3ff');
  scene.add(new THREE.HemisphereLight(0xffffff,0x9ab4c6,2));
  const camera=new THREE.PerspectiveCamera(45,width/height,1,1000000);
  const [lon0,lat0]=centre();let extent=100;
  const makePoint=(lon,lat)=>{const p=localMetres(lon,lat,lon0,lat0);extent=Math.max(extent,Math.abs(p.x),Math.abs(p.y));
    return new THREE.Vector3(p.x,1,-p.y);};
  const selected=astraMapState.pipeGeometry?[{type:'Feature',geometry:astraMapState.pipeGeometry}]:[];
  const allPolygons=window.koleksiPoligonDMZ||[];
  const matchingPolygons=allPolygons.filter(f=>String(f.properties?._fileName||'').toLowerCase()===
    String(astraMapState.selectedDma||'').toLowerCase());
  const visible=astraMapState.visibleLayers;
  const polygons=visible.includes('polygons')?featureLines(astraMapState.pipeGeometry?
    (matchingPolygons.length?matchingPolygons:[]):allPolygons):[];
  const pipes=visible.includes('pipes')?featureLines([...(window.sainsPipeMapFeatures?.ai||[]),...selected]):[];
  const pipeObjects=[];
  for(const [lines,color,height] of [[polygons,0x16a34a,1],[pipes,0x0891b2,5]]){
    for(const line of lines){
      const points=line.coordinates.map(p=>{const v=makePoint(p[0],p[1]);v.y=height;return v;});
      const pipeId=line.properties.asset_num||astraMapState.selectedPipeId||null;
      const selectedPipe=lines===pipes&&pipeId&&pipeId===astraMapState.selectedPipeId;
      const object=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({color:selectedPipe?0xf59e0b:color}));
      if(lines===pipes){object.userData={pipeId,source:'GIS',points};pipeObjects.push(object);}
      scene.add(object);
    }
  }
  for(const node of visible.includes('points')?(astraMapState.model?.nodes||[]):[]){
    if(!validPoint(node.longitude,node.latitude))continue;
    const marker=new THREE.Mesh(new THREE.SphereGeometry(5,8,8),
      new THREE.MeshBasicMaterial({color:0x7c3aed}));
    marker.position.copy(makePoint(node.longitude,node.latitude));scene.add(marker);
  }
  for(const row of visible.includes('points')?(astraMapState.observations||[]):[]){
    if(!validPoint(row.longitude,row.latitude))continue;
    const marker=new THREE.Mesh(new THREE.SphereGeometry(7,8,8),
      new THREE.MeshBasicMaterial({color:row.residualM>0?0xdc2626:0x2563eb}));
    marker.position.copy(makePoint(row.longitude,row.latitude));scene.add(marker);
  }
  scene.add(new THREE.GridHelper(extent*2.5,20,0x94a3b8,0xcbd5e1));
  camera.position.set(extent*1.5,extent*1.8,extent*1.5);camera.lookAt(0,0,0);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.maxDistance=extent*10;
  const initialPosition=camera.position.clone();
  const raycaster=new THREE.Raycaster();raycaster.params.Line.threshold=Math.max(5,extent/80);
  const pointer=new THREE.Vector2();
  const onPick=event=>{
    const rect=renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    raycaster.setFromCamera(pointer,camera);
    const hit=raycaster.intersectObjects(pipeObjects)[0]?.object;
    if(!hit)return;
    astraMapState.selectedPipeId=hit.userData.pipeId;
    pipeObjects.forEach(object=>object.material.color.setHex(object===hit?0xf59e0b:0x0891b2));
    byId('astra-map-inspector').textContent=`Paip GIS ${hit.userData.pipeId||'ID tidak tersedia'} — klik untuk semak, bukan model disahkan.`;
    const focus=hit.userData.points[Math.floor(hit.userData.points.length/2)];
    controls.target.copy(focus);camera.position.copy(focus).add(new THREE.Vector3(extent*.3,extent*.45,extent*.3));
    controls.update();
  };
  target.addEventListener('click',onPick);
  const resizeObserver=new ResizeObserver(()=>{
    const w=target.clientWidth,h=target.clientHeight;if(!w||!h)return;
    renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();
  });resizeObserver.observe(target);
  threeView={renderer,scene,controls,camera,initialPosition,target,onPick,resizeObserver,frame:0};
  const draw=()=>{if(!threeView||astraMapState.engine!=='three')return;
    controls.update();renderer.render(scene,camera);threeView.frame=requestAnimationFrame(draw);};
  draw();
  status(`Three.js Miniature • ${polygons.length} sempadan, ${pipes.length} garisan GIS. `+
    'Grid/ketinggian adalah ilustrasi, bukan terrain atau kedalaman paip sebenar.');
  byId('astra-map-inspector').textContent=!polygons.length&&!pipes.length?
    'Tiada geometri GIS tersedia untuk pilihan ini.':'';
}
async function switchEngine(engine){
  if(!['leaflet','cesium','three'].includes(engine))return;
  const previous=astraMapState.engine;
  if(typeof aiAgentMap!=='undefined'&&aiAgentMap&&previous==='leaflet'){
    const p=aiAgentMap.getCenter();astraMapState.leafletViewport={latitude:p.lat,longitude:p.lng,zoom:aiAgentMap.getZoom()};
  }
  for(const [mode,id] of [['leaflet','ai-agent-map'],['cesium','astra-cesium-map'],['three','astra-three-map']])
    byId(id).classList.toggle('hidden',mode!==engine);
  byId('astra-map-3d-tools').classList.toggle('hidden',engine==='leaflet');
  byId('astra-cesium-tiles-controls').classList.toggle('hidden',engine!=='cesium');
  astraMapState.engine=engine;
  try{
    if(engine==='leaflet'){
      disposeCesium();destroyThree();
      if(typeof aiAgentMap!=='undefined'&&aiAgentMap){aiAgentMap.invalidateSize();
        if(astraMapState.leafletViewport)aiAgentMap.setView(
          [astraMapState.leafletViewport.latitude,astraMapState.leafletViewport.longitude],
          astraMapState.leafletViewport.zoom);}
      status('Leaflet 2D aktif.');
    }else if(engine==='cesium'){destroyThree();await showCesium();}
    else{disposeCesium();await showThree();}
  }catch(error){
    status(`${error.message} Kembali ke Leaflet.`);
    astraMapState.engine='leaflet';
    byId('ai-agent-map').classList.remove('hidden');
    byId('astra-cesium-map').classList.add('hidden');byId('astra-three-map').classList.add('hidden');
    byId('astra-map-3d-tools').classList.add('hidden');
    byId('astra-cesium-tiles-controls').classList.add('hidden');
    disposeCesium();destroyThree();
    if(typeof aiAgentMap!=='undefined'&&aiAgentMap)aiAgentMap.invalidateSize();
  }
  document.querySelectorAll('[data-astra-map]').forEach(button=>
    button.setAttribute('aria-pressed',String(button.dataset.astraMap===astraMapState.engine)));
}
export function updateAstraMapState(patch){
  Object.assign(astraMapState,patch);
  if(astraMapState.engine==='cesium'&&cesiumViewer)populateCesium(window.Cesium);
  if(astraMapState.engine==='three')showThree().catch(error=>status(error.message));
}
document.querySelectorAll('[data-astra-map]').forEach(button=>button.addEventListener('click',
  ()=>switchEngine(button.dataset.astraMap)));
document.querySelectorAll('[data-astra-layer]').forEach(box=>box.addEventListener('change',()=>{
  astraMapState.visibleLayers=[...document.querySelectorAll('[data-astra-layer]:checked')].map(x=>x.dataset.astraLayer);
  if(astraMapState.engine==='cesium'&&cesiumViewer)populateCesium(window.Cesium);
  if(astraMapState.engine==='three')showThree().catch(error=>status(error.message));
}));
byId('astra-map-reset-camera').addEventListener('click',()=>{
  if(astraMapState.engine==='cesium'&&cesiumViewer)populateCesium(window.Cesium);
  if(astraMapState.engine==='three'&&threeView){threeView.controls.target.set(0,0,0);
    threeView.camera.position.copy(threeView.initialPosition);threeView.controls.update();}
});
window.addEventListener('sains-gis-context-changed',()=>{
  if(astraMapState.engine==='cesium'&&cesiumViewer)populateCesium(window.Cesium);
  if(astraMapState.engine==='three')showThree().catch(error=>status(error.message));
});
