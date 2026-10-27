import {extentOfLines,featureLines,validLonLat} from './gis-view-core.mjs';

let loading;
export function loadCesium(){
  if(window.Cesium)return Promise.resolve(window.Cesium);
  if(loading)return loading;
  loading=new Promise((resolve,reject)=>{
    const css=document.createElement('link');css.rel='stylesheet';
    css.href='https://cesium.com/downloads/cesiumjs/releases/1.146/Build/Cesium/Widgets/widgets.css';
    document.head.append(css);
    const script=document.createElement('script');
    script.src='https://cesium.com/downloads/cesiumjs/releases/1.146/Build/Cesium/Cesium.js';
    script.onload=()=>window.Cesium?resolve(window.Cesium):reject(Error('Cesium tidak tersedia.'));
    script.onerror=()=>reject(Error('Cesium CDN tidak dapat dimuatkan.'));
    document.head.append(script);
  }).catch(error=>{loading=null;throw error;});
  return loading;
}
export function createGisViewer(C,target){
  // No ion token or privileged endpoint is needed for this OSM imagery layer.
  const imagery=new C.OpenStreetMapImageryProvider({url:'https://tile.openstreetmap.org/',
    maximumLevel:19,credit:'© OpenStreetMap contributors'});
  const viewer=new C.Viewer(target,{baseLayer:new C.ImageryLayer(imagery),
    terrainProvider:new C.EllipsoidTerrainProvider(),animation:false,timeline:false,
    geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,
    baseLayerPicker:false,infoBox:true});
  viewer.scene.globe.baseColor=C.Color.fromCssColorString('#dbeafe');
  const attribution=document.createElement('a');
  attribution.href='https://www.openstreetmap.org/copyright';
  attribution.target='_blank';attribution.rel='noopener noreferrer';
  attribution.textContent='© OpenStreetMap contributors';
  attribution.setAttribute('aria-label','Lesen peta OpenStreetMap');
  Object.assign(attribution.style,{position:'absolute',bottom:'4px',left:'135px',zIndex:'2',
    padding:'1px 4px',background:'rgba(255,255,255,.88)',color:'#334155',fontSize:'11px'});
  viewer.container.append(attribution);
  return viewer;
}
export function addGisContext(C,viewer,{polygons=[],pipes=[],points=[]}={}){
  viewer.entities.removeAll();
  const polygonLines=featureLines(polygons),pipeLines=featureLines(pipes);
  for(const line of polygonLines){
    viewer.entities.add({name:`Sempadan DMA ${line.properties._fileName||line.properties.name||''}`,
      polyline:{positions:C.Cartesian3.fromDegreesArray(line.coordinates.flatMap(p=>[p[0],p[1]])),
        width:2,material:C.Color.fromCssColorString('#059669')}});
  }
  for(const line of pipeLines){
    viewer.entities.add({name:`Jajaran GIS ${line.properties.asset_num||'Pipe ID tidak dinyatakan'}`,
      description:`Jajaran GIS; parameter hidraulik perlu disemak berasingan.`,
      polyline:{positions:C.Cartesian3.fromDegreesArray(line.coordinates.flatMap(p=>[p[0],p[1]])),
        width:4,material:C.Color.CYAN}});
  }
  for(const point of points){
    if(!validLonLat([point.longitude,point.latitude]))continue;
    viewer.entities.add({name:point.name||'Titik',
      position:C.Cartesian3.fromDegrees(point.longitude,point.latitude),
      point:{pixelSize:9,color:C.Color.fromCssColorString(point.color||'#ef4444'),
        outlineColor:C.Color.WHITE,outlineWidth:1}});
  }
  return {polygonCount:polygonLines.length,pipeCount:pipeLines.length,pointCount:points.length,
    extent:extentOfLines(pipeLines.length?pipeLines:polygonLines)};
}
export function flyToGis(C,viewer,extent,fallback=[101.7946,2.5225]){
  if(extent){
    const pad=.003;
    viewer.camera.flyTo({destination:C.Rectangle.fromDegrees(extent.west-pad,extent.south-pad,
      extent.east+pad,extent.north+pad),duration:0});
  }else viewer.camera.flyTo({destination:C.Cartesian3.fromDegrees(fallback[0],fallback[1],12000),duration:0});
}
