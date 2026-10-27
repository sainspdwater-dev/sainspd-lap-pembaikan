// Read-only WGS84 geometry helpers shared by the two optional 3D views.
export function validLonLat(point){
  return Array.isArray(point)&&point.length>=2&&Number.isFinite(point[0])&&Number.isFinite(point[1])
    &&Math.abs(point[0])<=180&&Math.abs(point[1])<=90;
}
export function geometryLines(geometry){
  if(!geometry)return [];
  if(geometry.type==='LineString')return [geometry.coordinates];
  if(geometry.type==='MultiLineString')return geometry.coordinates;
  if(geometry.type==='Polygon')return geometry.coordinates;
  if(geometry.type==='MultiPolygon')return geometry.coordinates.flat();
  if(geometry.type==='GeometryCollection')return geometry.geometries.flatMap(geometryLines);
  return [];
}
export function featureLines(features){
  return (features||[]).flatMap(feature=>geometryLines(feature?.geometry)
    .filter(line=>Array.isArray(line)&&line.length>=2&&line.every(validLonLat))
    .map(line=>({coordinates:line,properties:feature.properties||{}})));
}
export function extentOfLines(lines){
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const line of lines||[])for(const point of line.coordinates||line){
    if(!validLonLat(point))continue;
    west=Math.min(west,point[0]);east=Math.max(east,point[0]);
    south=Math.min(south,point[1]);north=Math.max(north,point[1]);
  }
  return Number.isFinite(west)?{west,south,east,north}:null;
}
export function safeLeafletBbox(bounds){
  const west=Math.max(-180,bounds.getWest()),east=Math.min(180,bounds.getEast());
  const south=Math.max(-90,bounds.getSouth()),north=Math.min(90,bounds.getNorth());
  return west<east&&south<north?[west,south,east,north].join(','):null;
}
