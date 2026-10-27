import {loadCesium,createGisViewer,addGisContext} from './gis-cesium.mjs';
import {bindBuildingTiles} from './cesium-tiles.mjs';

const leaflet=document.getElementById('map');
const target=document.getElementById('dashboard-cesium-map');
const message=document.getElementById('dashboard-map-mode-status');
const tilesControls=document.getElementById('dashboard-cesium-tiles-controls');
let viewer=null,tilesController=null,mode='leaflet';

function setMessage(text){message.textContent=text;message.classList.toggle('hidden',!text);}
function sync(){
  if(mode!=='cesium'||!viewer)return;
  const C=window.Cesium;
  const context=window.sainsDashboardMapContext?.();
  if(!context)return;
  const result=addGisContext(C,viewer,context);
  const height=Math.min(500000,40000000/Math.pow(2,Math.max(1,Math.min(19,context.zoom||12))));
  viewer.camera.flyTo({destination:C.Cartesian3.fromDegrees(context.center[0],context.center[1],height),duration:0});
  setMessage(`Cesium 3D • ${result.polygonCount} sempadan DMA, ${result.pipeCount} garisan GIS, `+
    `${context.points.length} kes ditapis. ${context.heatmap?'Heatmap 2D kekal aktif apabila kembali ke Leaflet; titik ditunjukkan di 3D.':''} `+
    'Peta asas OSM di atas elipsoid, bukan terrain/kedalaman paip sebenar.');
}
async function switchMode(next){
  if(next===mode)return;
  if(next==='cesium'){
    if(!window.WebGL2RenderingContext){setMessage('WebGL2 tidak tersedia; Leaflet 2D kekal aktif.');return;}
    target.classList.remove('hidden');leaflet.classList.add('hidden');
    tilesControls.classList.remove('hidden');
    try{
      const C=await loadCesium();
      if(!viewer){
        viewer=createGisViewer(C,target);
        tilesController=bindBuildingTiles(C,viewer,tilesControls);
        viewer.imageryLayers.get(0)?.imageryProvider?.errorEvent?.addEventListener(()=>
          setMessage('Imej OSM gagal dimuat. Pilih Leaflet 2D untuk peta operasi; titik dan sempadan GIS tidak diubah.'));
      }
      mode='cesium';sync();
    }catch(error){
      target.classList.add('hidden');leaflet.classList.remove('hidden');
      tilesControls.classList.add('hidden');
      setMessage(`${error.message} Leaflet 2D kekal aktif.`);
      tilesController?.destroy();tilesController=null;
      if(viewer&&!viewer.isDestroyed())viewer.destroy();viewer=null;
      window.sainsMainLeafletMap?.invalidateSize();
      return;
    }
  }else{
    target.classList.add('hidden');leaflet.classList.remove('hidden');
    tilesControls.classList.add('hidden');
    mode='leaflet';
    tilesController?.destroy();tilesController=null;
    if(viewer&&!viewer.isDestroyed())viewer.destroy();viewer=null;
    window.sainsMainLeafletMap?.invalidateSize();
    setMessage('');
  }
  document.querySelectorAll('[data-dashboard-map]').forEach(button=>
    button.setAttribute('aria-pressed',String(button.dataset.dashboardMap===mode)));
}
document.querySelectorAll('[data-dashboard-map]').forEach(button=>
  button.addEventListener('click',()=>switchMode(button.dataset.dashboardMap)));
window.addEventListener('sains-dashboard-map-changed',sync);
window.addEventListener('sains-gis-context-changed',sync);
