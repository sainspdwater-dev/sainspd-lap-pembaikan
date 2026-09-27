// Read-only planar WGS84 clip preview. Geometry overlap is NOT DMA ownership.
const EPS = 1e-10;
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
const at = (a,b,t) => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
const same = (a,b) => Math.abs(a[0]-b[0])<EPS && Math.abs(a[1]-b[1])<EPS;
const validPoint = p => Array.isArray(p) && p.length>=2 && Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) && Math.abs(p[0])<=180 && Math.abs(p[1])<=90;
const pointOnSegment = (p,a,b) => Math.abs(cross(sub(p,a),sub(b,a)))<EPS &&
  p[0]>=Math.min(a[0],b[0])-EPS && p[0]<=Math.max(a[0],b[0])+EPS &&
  p[1]>=Math.min(a[1],b[1])-EPS && p[1]<=Math.max(a[1],b[1])+EPS;

function inRing(point,ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if(pointOnSegment(point,a,b))return 2;
    if((a[1]>point[1])!==(b[1]>point[1]) &&
      point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside?1:0;
}
function inPolygon(point,rings) {
  const outer=inRing(point,rings[0]);
  if(!outer)return false;
  for(const hole of rings.slice(1))if(inRing(point,hole)===1)return false;
  return true;
}
function segmentCrossingT(a,b,c,d) {
  const r=sub(b,a),s=sub(d,c),den=cross(r,s);
  if(Math.abs(den)<EPS){
    if(Math.abs(cross(sub(c,a),r))>=EPS)return [];
    const len=r[0]*r[0]+r[1]*r[1];
    if(len<EPS)return [];
    return [c,d].filter(p=>pointOnSegment(p,a,b)).map(p=>
      ((p[0]-a[0])*r[0]+(p[1]-a[1])*r[1])/len);
  }
  const q=sub(c,a),t=cross(q,s)/den,u=cross(q,r)/den;
  return t>=-EPS && t<=1+EPS && u>=-EPS && u<=1+EPS?[Math.min(1,Math.max(0,t))]:[];
}
function bbox(coords) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const walk=value=>{
    if(Array.isArray(value) && typeof value[0]==='number'){
      if(!validPoint(value))throw new Error('Koordinat bukan WGS84/EPSG:4326 yang sah.');
      minX=Math.min(minX,value[0]);maxX=Math.max(maxX,value[0]);
      minY=Math.min(minY,value[1]);maxY=Math.max(maxY,value[1]);
    }else if(Array.isArray(value))value.forEach(walk);
  };
  walk(coords);return [minX,minY,maxX,maxY];
}
const boxesOverlap=(a,b)=>a[0]<=b[2] && a[2]>=b[0] && a[1]<=b[3] && a[3]>=b[1];
const polygonParts=geometry=>geometry.type==='Polygon'?[geometry.coordinates]:
  geometry.type==='MultiPolygon'?geometry.coordinates:[];
const lineParts=geometry=>geometry?.type==='LineString'?[geometry.coordinates]:
  geometry?.type==='MultiLineString'?geometry.coordinates:
  geometry?.type==='GeometryCollection'?(geometry.geometries||[]).flatMap(lineParts):[];
export const hasPipeLine=feature=>lineParts(feature?.geometry).length>0;

export function clipLineToPolygon(coordinates,rings) {
  if(!Array.isArray(coordinates)||coordinates.length<2||!rings?.[0]?.length)return [];
  bbox(coordinates);bbox(rings);
  const result=[];let current=[];
  const flush=()=>{if(current.length>1)result.push(current);current=[];};
  for(let i=0;i<coordinates.length-1;i++){
    const a=coordinates[i],b=coordinates[i+1];
    if(same(a,b))continue;
    const cuts=[0,1];
    for(const ring of rings)for(let k=0;k<ring.length-1;k++)
      cuts.push(...segmentCrossingT(a,b,ring[k],ring[k+1]));
    cuts.sort((x,y)=>x-y);
    const unique=cuts.filter((v,index)=>index===0||v-cuts[index-1]>EPS);
    for(let k=0;k<unique.length-1;k++){
      const t0=unique[k],t1=unique[k+1];
      if(t1-t0<EPS)continue;
      if(!inPolygon(at(a,b,(t0+t1)/2),rings)){flush();continue;}
      const start=at(a,b,t0),end=at(a,b,t1);
      if(current.length && !same(current.at(-1),start))flush();
      if(!current.length)current.push(start);
      if(!same(current.at(-1),end))current.push(end);
    }
  }
  flush();return result;
}
function lengthMetres(line) {
  let metres=0;
  for(let i=1;i<line.length;i++){
    const a=line[i-1],b=line[i],rad=Math.PI/180,dLat=(b[1]-a[1])*rad,dLon=(b[0]-a[0])*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dLon/2)**2;
    metres+=6371008.8*2*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  return metres;
}
const sourceId=feature=>String(feature.properties?.asset_num||feature.properties?.AssetNum||
  feature.properties?.name||feature.properties?.Name||'').trim();
const descriptionValue=(description,key)=>{
  const cells=[...String(description||'').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(match=>match[1].replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').trim());
  for(let i=0;i<cells.length-1;i++)if(cells[i].toUpperCase()===key)return cells[i+1];
  return null;
};
const diameter=feature=>{
  const props=feature.properties||{};
  const raw=props.size_mm??props.PIPESIZE??props.diameter_mm??props.Diameter??
    descriptionValue(props.description,'PIPESIZE');
  const value=Number(String(raw??'').replace(/\s*mm$/i,''));
  return Number.isFinite(value)&&value>0?value:null;
};

export async function previewPipeClip(features,zoneFeatures,{onProgress=()=>{},signal,maxFeatures=100000,maxMapParts=500,maxStagedParts=20000}={}) {
  if(!Array.isArray(features)||!Array.isArray(zoneFeatures))throw new Error('Fitur paip/polygon tidak sah.');
  if(features.length>maxFeatures)throw new Error(`Terlalu banyak fitur (${features.length}); guna aliran import pelayan untuk fail ini.`);
  const zones=new Map();
  for(const item of zoneFeatures){
    const feature=item.feature||item,name=String(item.name||feature.properties?.name||feature.properties?.Name||'').trim();
    if(!name||!feature.geometry)continue;
    for(const rings of polygonParts(feature.geometry)){
      if(!rings.length||rings.some(ring=>ring.length<4||!same(ring[0],ring.at(-1))))
        throw new Error(`Polygon ${name} tidak tertutup/sah; clip dihentikan.`);
      const zone=zones.get(name)||{name,polygons:[],partCount:0,sourceIds:new Set(),lengthM:0,
        noIdParts:0,noDiameterParts:0,mapFeatures:[],mapTruncated:false};
      zone.polygons.push({rings,bounds:bbox(rings)});zones.set(name,zone);
    }
  }
  if(!zones.size)throw new Error('Tiada polygon DMA sah dimuatkan. Muat semula peta/polygon dahulu.');
  const summaries=[...zones.values()];
  let sourceLines=0,outsideLines=0,multiDmaLines=0,invalidGeometry=0;
  const stagedParts=[];
  for(let index=0;index<features.length;index++){
    if(signal?.aborted)throw new Error('Pratonton dibatalkan.');
    const feature=features[index],parts=lineParts(feature?.geometry||{});
    if(!parts.length)continue;
    const id=sourceId(feature),size=diameter(feature);
    for(const line of parts){
      if(!Array.isArray(line)||line.length<2){invalidGeometry++;continue;}
      let lineBounds;
      try{lineBounds=bbox(line);}catch{invalidGeometry++;continue;}
      sourceLines++;
      let matchingZones=0;
      for(const zone of summaries){
        let matched=false;
        for(const polygon of zone.polygons){
          if(!boxesOverlap(lineBounds,polygon.bounds))continue;
          for(const clipped of clipLineToPolygon(line,polygon.rings)){
            if(stagedParts.length>=maxStagedParts)throw new Error(`Had ${maxStagedParts} calon dicapai; gunakan import pelayan untuk fail lebih besar.`);
            matched=true;zone.partCount++;zone.lengthM+=lengthMetres(clipped);
            if(id)zone.sourceIds.add(id);else zone.noIdParts++;
            if(size===null)zone.noDiameterParts++;
            stagedParts.push({rowNumber:stagedParts.length,zoneName:zone.name,kmlId:id,
              diameterMm:size,geometry:{type:'LineString',coordinates:clipped}});
            if(zone.mapFeatures.length<maxMapParts)zone.mapFeatures.push({type:'Feature',
              properties:{asset_num:id||null,size_mm:size,dma:zone.name,preview_only:true},
              geometry:{type:'LineString',coordinates:clipped}});
            else zone.mapTruncated=true;
          }
        }
        if(matched)matchingZones++;
      }
      if(!matchingZones)outsideLines++;
      if(matchingZones>1)multiDmaLines++;
    }
    if(index%100===0){onProgress({done:index+1,total:features.length});await new Promise(resolve=>setTimeout(resolve,0));}
  }
  onProgress({done:features.length,total:features.length});
  return {sourceLines,outsideLines,multiDmaLines,invalidGeometry,stagedParts,
    zones:summaries.map(({name,partCount,sourceIds,lengthM,noIdParts,noDiameterParts,mapFeatures,mapTruncated})=>
      ({name,partCount,sourceCount:sourceIds.size,lengthM,noIdParts,noDiameterParts,mapFeatures,mapTruncated}))};
}

export function clipAuditCsv(result,{sourceName='',sourceSha256='',polygonSha256='',createdAt=''}={}) {
  const safe=value=>{
    let text=String(value??'');
    if(/^[\s]*[=+\-@]/.test(text))text=`'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const rows=[['source_name','source_sha256','polygon_sha256','created_at','dma','spatial_parts','unique_kml_ids',
    'geometry_length_km','parts_without_kml_id','parts_without_diameter','outside_lines_all_dmas','multi_dma_lines']];
  for(const zone of result.zones)rows.push([sourceName,sourceSha256,polygonSha256,createdAt,zone.name,
    zone.partCount,zone.sourceCount,(zone.lengthM/1000).toFixed(3),zone.noIdParts,
    zone.noDiameterParts,result.outsideLines,result.multiDmaLines]);
  return rows.map(row=>row.map(safe).join(',')).join('\r\n')+'\r\n';
}
