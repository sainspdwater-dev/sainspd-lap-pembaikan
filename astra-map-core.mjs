// Canonical ASTRA geographic state and WGS84-to-local tangent approximation.
const R=6378137;
export function localMetres(longitude,latitude,originLongitude,originLatitude){
  if([longitude,latitude,originLongitude,originLatitude].some(x=>!Number.isFinite(x)))
    throw Error('Koordinat WGS84 tidak sah');
  const radians=Math.PI/180;
  return {x:R*(longitude-originLongitude)*radians*Math.cos(originLatitude*radians),
    y:R*(latitude-originLatitude)*radians};
}
export function lineCoordinates(geometry){
  if(!geometry)return [];
  if(geometry.type==='LineString')return [geometry.coordinates];
  if(geometry.type==='MultiLineString')return geometry.coordinates;
  if(geometry.type==='GeometryCollection')return geometry.geometries.flatMap(lineCoordinates);
  return [];
}
export function makeAstraMapState(){
  return {engine:'leaflet',selectedPipeId:null,selectedNodeId:null,selectedValveId:null,
    selectedDma:null,selectedPosition:null,visibleLayers:['polygons','pipes','points'],activeScenario:null,
    selectedModelId:null,selectedRunId:null,model:null,pipeGeometry:null,
    observations:[],reserve:null,leakCandidates:[],leafletViewport:null};
}
