// Pure, deterministic GIS-to-hydraulic topology audit. Geometry is not a
// validated model; no intersecting lines are joined without shared endpoints.
const R = 6371008.8;
const rad = Math.PI / 180;
const key = p => `${p[0].toFixed(8)},${p[1].toFixed(8)}`;
const valid = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
export const distanceMeters = (a,b) => {
  const lat = ((a[1]+b[1])/2)*rad;
  return Math.hypot((a[0]-b[0])*rad*Math.cos(lat),(a[1]-b[1])*rad)*R;
};
const nodeId = p => `HN-${Math.round((p[0]+180)*1e8).toString(36)}-${Math.round((p[1]+90)*1e8).toString(36)}`;
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function lineRelation(a,b,c,d) {
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b),eps=1e-13;
  if(Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))>Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))+eps || Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))>Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]))+eps) return null;
  if([abC,abD,cdA,cdB].every(x=>Math.abs(x)<eps)) {
    const axis=Math.abs(a[0]-b[0])>=Math.abs(a[1]-b[1])?0:1;
    const overlap=Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis]));
    return overlap>eps?'OVERLAPPING_GEOMETRY':null;
  }
  return abC*abD < -eps && cdA*cdB < -eps ? 'CROSSING_UNJOINED':null;
}

export function auditTopology(rows, { snapMeters=0.5, nearMissMeters=2 }={}) {
  if (!Number.isFinite(snapMeters) || snapMeters<0 || snapMeters>20 || !Number.isFinite(nearMissMeters) || nearMissMeters<snapMeters || nearMissMeters>100) throw new Error('Toleransi topologi tidak sah.');
  if (!Array.isArray(rows) || rows.length>10000) throw new Error('Maksimum 10,000 garis setiap audit.');
  const issues=[], edges=[], points=[];
  let multipartSegments=0;
  for (const row of [...rows].sort((a,b)=>String(a.segment_key).localeCompare(String(b.segment_key)))) {
    const id=String(row.segment_key || '').trim();
    if (!id) { issues.push({code:'MISSING_SEGMENT_KEY',severity:'CRITICAL'}); continue; }
    let geom; try { geom=typeof row.geometry_json==='string'?JSON.parse(row.geometry_json):row.geometry_json; } catch { geom=null; }
    const lines=geom?.type==='LineString'?[geom.coordinates]:geom?.type==='MultiLineString'?geom.coordinates:[];
    if(geom?.type==='MultiLineString')multipartSegments++;
    if (!lines.length) { issues.push({code:'INVALID_GEOMETRY',segmentKey:id,severity:'CRITICAL'}); continue; }
    lines.forEach((coords,part)=>{
      if (!Array.isArray(coords) || coords.length<2 || !coords.every(valid)) { issues.push({code:'INVALID_GEOMETRY',segmentKey:id,severity:'CRITICAL'}); return; }
      const a=coords[0].slice(0,2), b=coords.at(-1).slice(0,2);
      if (distanceMeters(a,b)<0.001) issues.push({code:'SAME_ENDPOINTS',segmentKey:id,severity:'WARNING'});
      const edge={segmentKey:id,part,assetNum:row.asset_num||null,a,b,coordinates:coords};
      edges.push(edge); points.push({edge,index:0,coord:a},{edge,index:1,coord:b});
      if (!row.asset_num) issues.push({code:'MISSING_PIPE_ID',segmentKey:id,severity:'MISSING'});
      if (!(Number(row.size_mm)>0)) issues.push({code:'MISSING_DIAMETER',segmentKey:id,severity:'MISSING'});
      if (!(Number(row.length_m)>0)) issues.push({code:'MISSING_LENGTH',segmentKey:id,severity:'MISSING'});
    });
  }
  // Sort before union; representative is always the lowest coordinate key.
  points.sort((a,b)=>key(a.coord).localeCompare(key(b.coord)) || a.edge.segmentKey.localeCompare(b.edge.segmentKey) || a.index-b.index);
  const parent=points.map((_,i)=>i), clusterMembers=new Map(points.map((_,i)=>[i,[i]]));
  let blockedTransitiveSnaps=0;
  const root=i=>{ while(parent[i]!==i) i=parent[i]=parent[parent[i]]; return i; };
  const unite=(i,j)=>{
    const x=root(i),y=root(j); if(x===y)return;
    // Complete-linkage guard: chaining A-B and B-C must not silently join
    // A-C when their separation exceeds the declared tolerance.
    for(const a of clusterMembers.get(x)) for(const b of clusterMembers.get(y)) {
      if(distanceMeters(points[a].coord,points[b].coord)>snapMeters+1e-8){blockedTransitiveSnaps++;return;}
    }
    const keep=Math.min(x,y),drop=Math.max(x,y);
    parent[drop]=keep;
    clusterMembers.get(keep).push(...clusterMembers.get(drop));clusterMembers.delete(drop);
  };
  // Spatial grid to avoid O(N^2) on large imports. Grid sizes are conservative
  // latitude/longitude approximations; final decision uses metric distance.
  const cellDeg=Math.max(snapMeters,0.01)/100000, grid=new Map();
  for(let i=0;i<points.length;i++) {
    const p=points[i].coord, gx=Math.floor(p[0]/cellDeg),gy=Math.floor(p[1]/cellDeg);
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) for(const j of grid.get(`${gx+dx}:${gy+dy}`)||[]) if(distanceMeters(p,points[j].coord)<=snapMeters) unite(i,j);
    const bucket=`${gx}:${gy}`; if(!grid.has(bucket)) grid.set(bucket,[]); grid.get(bucket).push(i);
  }
  const groups=new Map(); points.forEach((p,i)=>{const r=root(i); if(!groups.has(r)) groups.set(r,[]); groups.get(r).push(p);});
  let snappedEndpointCount=0, longSnapClusters=0, maxSnapSpanMeters=0;
  for(const members of groups.values()) {
    const distinct=[...new Map(members.map(p=>[key(p.coord),p.coord])).values()];
    if(distinct.length<2)continue;
    snappedEndpointCount+=members.filter(p=>key(p.coord)!==key(members[0].coord)).length;
    let span=0;
    for(let i=0;i<distinct.length;i++)for(let j=i+1;j<distinct.length;j++)span=Math.max(span,distanceMeters(distinct[i],distinct[j]));
    maxSnapSpanMeters=Math.max(maxSnapSpanMeters,span);
    if(span>1)longSnapClusters++;
  }
  const nodes=[...groups.entries()].map(([r,members])=>{
    const representative=members[0].coord, id=nodeId(representative);
    return {id,longitude:representative[0],latitude:representative[1],source:'GIS_ENDPOINT',generationMethod:`SNAP_${snapMeters}M`,status:'GENERATED',linkedPipeIds:[...new Set(members.map(p=>p.edge.assetNum).filter(Boolean))].sort(),endpointCount:members.length,root:r};
  });
  const byRoot=new Map(nodes.map(n=>[n.root,n]));
  for(let i=0;i<points.length;i++) {const p=points[i];p.edge[p.index===0?'startNode':'endNode']=byRoot.get(root(i)).id;}
  const edgePairs=new Map(), adjacency=new Map(nodes.map(n=>[n.id,new Set()])), degree=new Map(nodes.map(n=>[n.id,0]));
  for(const edge of edges) {
    const pair=[edge.startNode,edge.endNode].sort().join('|');
    if(edgePairs.has(pair)) issues.push({code:'DUPLICATE_EDGE',segmentKey:edge.segmentKey,otherSegmentKey:edgePairs.get(pair),severity:'WARNING'});
    else edgePairs.set(pair,edge.segmentKey);
    adjacency.get(edge.startNode).add(edge.endNode); adjacency.get(edge.endNode).add(edge.startNode);
    degree.set(edge.startNode,degree.get(edge.startNode)+1); degree.set(edge.endNode,degree.get(edge.endNode)+1);
  }
  const seen=new Set(), components=[];
  for(const node of nodes) if(!seen.has(node.id)) {const stack=[node.id], members=[];seen.add(node.id);while(stack.length){const id=stack.pop();members.push(id);for(const next of adjacency.get(id))if(!seen.has(next)){seen.add(next);stack.push(next);}}components.push(members.sort());}
  const componentByNode=new Map(components.flatMap((members,i)=>members.map(id=>[id,i])));
  const counts=components.map(()=>0);for(const edge of edges)counts[componentByNode.get(edge.startNode)]++;
  // Near misses are warnings, never repaired automatically.
  const nearMisses=[], nearGrid=new Map(), nearCell=nearMissMeters/100000||0.00001;
  for(let i=0;i<points.length;i++) {
    const p=points[i].coord,gx=Math.floor(p[0]/nearCell),gy=Math.floor(p[1]/nearCell);
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++) for(const j of nearGrid.get(`${gx+dx}:${gy+dy}`)||[]) {
      if(root(i)===root(j)) continue;
      const d=distanceMeters(p,points[j].coord);
      if(d<=nearMissMeters) nearMisses.push({a:points[i].edge.segmentKey,b:points[j].edge.segmentKey,distanceMeters:Number(d.toFixed(3))});
    }
    const bucket=`${gx}:${gy}`; if(!nearGrid.has(bucket))nearGrid.set(bucket,[]);nearGrid.get(bucket).push(i);
  }
  // Strict interior crossings never create nodes. Sweep-line bbox prefilter
  // avoids a complete N² GIS comparison on ordinary networks.
  const pieces=edges.flatMap(edge=>edge.coordinates.slice(1).map((b,i)=>{
    const a=edge.coordinates[i];return {edge,a,b,minX:Math.min(a[0],b[0]),maxX:Math.max(a[0],b[0]),minY:Math.min(a[1],b[1]),maxY:Math.max(a[1],b[1])};
  })).sort((a,b)=>a.minX-b.minX);
  const intersections=[],active=[];
  let comparisons=0, deferred=false;
  for(const piece of pieces) {
    while(active.length&&active[0].maxX<piece.minX) active.shift();
    for(const other of active) {
      if(other.edge===piece.edge||other.maxY<piece.minY||other.minY>piece.maxY)continue;
      if(++comparisons>2000000){deferred=true;break;}
      const relation=lineRelation(piece.a,piece.b,other.a,other.b);
      if(relation)intersections.push({code:relation,a:piece.edge.segmentKey,b:other.edge.segmentKey});
    }
    if(deferred)break;
    active.push(piece);active.sort((a,b)=>a.maxX-b.maxX);
  }
  const dangling=nodes.filter(n=>degree.get(n.id)===1).map(n=>n.id);
  const isolated=edges.filter(e=>counts[componentByNode.get(e.startNode)]===1).map(e=>e.segmentKey);
  if(components.length>1) issues.push({code:'DISCONNECTED_COMPONENTS',count:components.length,severity:'CRITICAL'});
  if(nearMisses.length) issues.push({code:'NEAR_MISS_ENDPOINTS',count:nearMisses.length,severity:'WARNING'});
  if(longSnapClusters) issues.push({code:'LONG_SNAP_REVIEW',count:longSnapClusters,severity:'WARNING'});
  if(blockedTransitiveSnaps) issues.push({code:'TRANSITIVE_SNAP_BLOCKED',count:blockedTransitiveSnaps,severity:'WARNING'});
  if(intersections.length) issues.push({code:'UNREVIEWED_INTERSECTIONS',count:intersections.length,severity:'WARNING'});
  if(deferred) issues.push({code:'INTERSECTION_AUDIT_INCOMPLETE',severity:'CRITICAL'});
  return {summary:{pipeCount:edges.length,nodeCount:nodes.length,connectedComponents:components.length,isolatedPipes:isolated.length,danglingEndpoints:dangling.length,loops:Math.max(0,edges.length-nodes.length+components.length),nearMissEndpoints:nearMisses.length,intersections:intersections.length,multipartSegments,snappedEndpointCount,longSnapClusters,maxSnapSpanMeters:Number(maxSnapSpanMeters.toFixed(3)),blockedTransitiveSnaps},nodes:nodes.map(({root,...n})=>n),links:edges.map(({coordinates,a,b,...e})=>e),issues,components,isolatedPipes:isolated,danglingNodeIds:dangling,nearMisses,intersections};
}

// Phase 2B preparation only. Candidates are real graph junctions linked to
// the selected asset; this is not leak detection or a probability ranking.
export function candidateJunctions(topology, assetNum) {
  const id=String(assetNum||'').trim();
  if(!id || !topology?.nodes || !topology?.links) return [];
  const linked=new Set(topology.links.filter(link=>link.assetNum===id).flatMap(link=>[link.startNode,link.endNode]));
  return topology.nodes.filter(node=>linked.has(node.id)).map(node=>({nodeId:node.id,assetNum:id,longitude:node.longitude,latitude:node.latitude,source:'HYDRAULIC_TOPOLOGY',status:'CANDIDATE_ONLY'}));
}
