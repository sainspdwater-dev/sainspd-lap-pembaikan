// Read-only, evidence-labelled suggestions for an already registered DMA.
// GIS intersections never establish hydraulic topology or engineering length.
const latestKey = (type, id, parameter) => `${type}\u0000${id}\u0000${parameter}`;
const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export async function buildHydraulicAutoFill(db, model) {
  const dma = model.zone_name;
  const active = await db.prepare('SELECT import_id FROM pipe_network_active WHERE singleton=1').bind().first();
  if (!active?.import_id) throw new Error('Jajaran GIS aktif tidak tersedia.');
  const [gisResult, assetResult, reviewResult, linkResult, nodeResult, sourceResult, mappingResult, observationResult] = await Promise.all([
    db.prepare(`SELECT z.asset_num,z.length_m,s.size_mm FROM pipe_network_zone_lines z
      JOIN pipe_network_segments s ON s.import_id=z.import_id AND s.segment_key=z.segment_key
      WHERE z.import_id=? AND z.zone_name=? COLLATE NOCASE ORDER BY z.asset_num LIMIT 2001`)
      .bind(active.import_id,dma).all(),
    db.prepare(`SELECT asset_num,size,length,source_file FROM water_assets_unique
      WHERE source_file=? COLLATE NOCASE ORDER BY asset_num LIMIT 2001`).bind(`${dma}.csv`).all(),
    db.prepare(`SELECT entity_type,entity_id,parameter_name,classification,review_status,value_real,value_text,
      source_ref,effective_at FROM hydraulic_parameter_reviews WHERE model_id=? AND version=?
      ORDER BY entered_at DESC,rowid DESC LIMIT 5001`).bind(model.model_id,model.version).all(),
    db.prepare(`SELECT link_id,link_type,start_node_id,end_node_id FROM hydraulic_links
      WHERE model_id=? AND version=? LIMIT 2001`).bind(model.model_id,model.version).all(),
    db.prepare(`SELECT node_id,node_type,elevation_m FROM hydraulic_nodes
      WHERE model_id=? AND version=? LIMIT 2001`).bind(model.model_id,model.version).all(),
    db.prepare(`SELECT node_id,boundary_type,head_m FROM hydraulic_boundaries
      WHERE model_id=? AND version=? LIMIT 2001`).bind(model.model_id,model.version).all(),
    db.prepare(`SELECT sensor_id,observed_parameter,model_entity_id,source_ref FROM hydraulic_sensor_mappings
      WHERE model_id=? AND version=? AND district_metered_area=? COLLATE NOCASE AND review_status='APPROVED'
      LIMIT 2001`).bind(model.model_id,model.version,dma).all(),
    db.prepare(`SELECT COUNT(*) AS n FROM dma_telemetry t JOIN hydraulic_sensor_mappings m
      ON m.sensor_id=t.sensor_id AND m.observed_parameter=t.parameter
      WHERE m.model_id=? AND m.version=? AND m.district_metered_area=? COLLATE NOCASE
      AND m.review_status='APPROVED' AND t.district_metered_area=? COLLATE NOCASE
      AND t.quality_status='VALID' AND t.source NOT LIKE '%TEST%'`)
      .bind(model.model_id,model.version,dma,dma).first()
  ]);
  const gisRows=gisResult.results||[],assetRows=assetResult.results||[],reviewRows=reviewResult.results||[];
  if ([gisRows,assetRows,linkResult.results||[],nodeResult.results||[],sourceResult.results||[],mappingResult.results||[]]
    .some(rows=>rows.length>2000)||reviewRows.length>5000)
    throw new Error('Inventori melebihi had pratonton selamat; pecahkan DMA sebelum Auto-Fill.');
  const gis=new Map();
  for (const row of gisRows) {
    const id=String(row.asset_num||'').trim();
    if (!id) continue;
    if (!gis.has(id)) gis.set(id,{length:0,sizes:new Set(),parts:0});
    const item=gis.get(id); item.length+=Number(row.length_m)||0; item.parts++;
    if (finitePositive(row.size_mm)) item.sizes.add(Number(row.size_mm));
  }
  const assets=new Map();
  for (const row of assetRows) {
    const id=String(row.asset_num||'').trim();
    if (!id) continue;
    if (!assets.has(id)) assets.set(id,{sizes:new Set(),files:new Set()});
    if (finitePositive(row.size)) assets.get(id).sizes.add(Number(row.size));
    assets.get(id).files.add(String(row.source_file||''));
  }
  const reviews=new Map();
  for (const row of reviewRows) {
    const key=latestKey(row.entity_type,row.entity_id,row.parameter_name);
    if (!reviews.has(key)) reviews.set(key,row);
  }
  const approved=(type,parameter)=>[...reviews.values()].filter(row=>row.entity_type===type&&
    row.parameter_name===parameter&&row.review_status==='APPROVED'&&row.classification!=='MISSING').length;
  const candidates=[],conflicts=[],unresolvedPipeIds=[],alreadyReviewed=[],mapIssues=[];
  const approvedEvidence=(type,id,parameter)=>{
    const row=reviews.get(latestKey(type,id,parameter));
    return row?.review_status==='APPROVED'&&['VERIFIED','MANUAL'].includes(row.classification)&&
      Boolean(row.source_ref&&row.effective_at);
  };
  const add=(id,parameter,value,unit,classification,sourceRef,notes)=>{
    const prior=reviews.get(latestKey('PIPE',id,parameter));
    if (prior) {alreadyReviewed.push(`${id}/${parameter}: ${prior.review_status}`);return;}
    candidates.push({entity_type:'PIPE',entity_id:id,parameter,value:String(value),unit,classification,
      source_ref:sourceRef,effective_at:'',notes,review_status:'DRAFT'});
  };
  let pipeIdsFound=0,diametersFound=0,gisLengthsFound=0;
  for (const [id,line] of [...gis.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const asset=assets.get(id);
    const diameterMatches=Boolean(asset&&asset.sizes.size===1&&line.sizes.size===1&&
      [...asset.sizes][0]===[...line.sizes][0]);
    const issueCodes=[];
    if(!asset)issueCodes.push('PIPE_ID_UNRESOLVED');
    if(!diameterMatches)issueCodes.push('GIS_DIAMETER_MISSING_OR_CONFLICT');
    if(!approvedEvidence('PIPE',id,'length_m'))issueCodes.push('ENGINEERING_LENGTH_UNREVIEWED');
    if(!approvedEvidence('PIPE',id,'hazen_c'))issueCodes.push('ROUGHNESS_UNREVIEWED');
    if(!approvedEvidence('PIPE',id,'from_node_id')||!approvedEvidence('PIPE',id,'to_node_id'))
      issueCodes.push('TOPOLOGY_UNRESOLVED');
    if(issueCodes.length)mapIssues.push({assetNum:id,issueCodes});
    if (!asset) {unresolvedPipeIds.push(id);continue;}
    pipeIdsFound++;
    const sourceFile=[...asset.files][0];
    add(id,'pipe_id',id,'TEXT','VERIFIED',`ASSET:${sourceFile}#${id}`,
      'Pipe ID sepadan antara asset master dan keahlian DMA GIS; masih memerlukan semakan bebas.');
    if (diameterMatches) {
      diametersFound++;
      add(id,'diameter_mm',[...asset.sizes][0],'mm','VERIFIED',`ASSET_MASTER:${sourceFile}#${id}`,
        'Diameter asset master dan GIS sepadan; DRAFT sehingga diluluskan.');
    } else if (asset.sizes.size || line.sizes.size) {
      conflicts.push(`${id}: diameter asset master/GIS tidak lengkap atau tidak sepadan; tidak diisi automatik.`);
    }
    if (line.length>0) {
      gisLengthsFound++;
      add(id,'length_m',Number(line.length.toFixed(3)),'m','ASSUMED',
        `GEOMETRY_DERIVED:${active.import_id}#${id}`,
        'Panjang geometri terpotong dalam DMA sahaja; BUKAN panjang kejuruteraan VERIFIED.');
    }
  }
  const links=linkResult.results||[],nodes=nodeResult.results||[],sources=sourceResult.results||[];
  const sensorMappings=mappingResult.results||[];
  const reviewedEvidence=[...reviews.values()].filter(row=>row.review_status==='APPROVED').slice(0,200)
    .map(row=>({entityType:row.entity_type,entityId:row.entity_id,parameter:row.parameter_name,
      value:row.value_real??row.value_text,classification:row.classification,sourceRef:row.source_ref,
      effectiveAt:row.effective_at}));
  return {
    dma,modelId:model.model_id,version:model.version,sourceImportId:active.import_id,
    summary:{pipeIdsFound,diametersFound,gisLengthsFound,
      reviewedEngineeringLengthsFound:approved('PIPE','length_m'),reviewedHazenCFound:approved('PIPE','hazen_c'),
      nodeElevationsFound:approved('NODE','elevation_m'),demandsFound:approved('NODE','base_demand_m3s'),
      sourceHeadsFound:approved('SOURCE','head_m'),approvedSensorMappingsFound:sensorMappings.length,
      approvedObservationsFound:Number(observationResult?.n||0),
      gisParts:gisRows.length,distinctGisPipeIds:gis.size,modelLinks:links.length,modelNodes:nodes.length,
      modelSources:sources.length},
    missing:['Topologi fizikal diluluskan tidak boleh diterbitkan daripada kedekatan GIS.',
      'Tarikh efektif sumber asset/GIS tidak tersedia; operator mesti mengisi tarikh yang dibuktikan sebelum simpan.',
      'Panjang GIS ialah GEOMETRY_DERIVED, bukan engineering length VERIFIED.',
      ...(approved('PIPE','hazen_c')?[]:['Hazen-Williams C yang diluluskan belum tersedia.']),
      ...(approved('NODE','elevation_m')?[]:['Elevasi nod yang diluluskan belum tersedia.']),
      ...(approved('NODE','base_demand_m3s')?[]:['Base demand yang diluluskan belum tersedia.']),
      ...(approved('SOURCE','head_m')?[]:['Source/reservoir head yang diluluskan belum tersedia.'])],
    conflicts:conflicts.slice(0,200),conflictCount:conflicts.length,
    unresolvedPipeIds:unresolvedPipeIds.slice(0,200),unresolvedPipeIdCount:unresolvedPipeIds.length,
    alreadyReviewed:alreadyReviewed.slice(0,200),alreadyReviewedCount:alreadyReviewed.length,
    reviewedEvidence,
    mapIssues,
    entityIds:{PIPE:[...gis.keys()].sort(),NODE:nodes.map(x=>x.node_id),SOURCE:sources.map(x=>x.node_id),
      VALVE:links.filter(x=>x.link_type==='VALVE').map(x=>x.link_id),
      PUMP:links.filter(x=>x.link_type==='PUMP').map(x=>x.link_id),
      TANK:nodes.filter(x=>x.node_type==='TANK').map(x=>x.node_id)},
    candidates:candidates.slice(0,200),totalCandidates:candidates.length,remainingCandidates:Math.max(0,candidates.length-200),
    persisted:false,notice:'TEST/operasi: pratonton baca sahaja. Tiada nilai disimpan atau diluluskan.'
  };
}
