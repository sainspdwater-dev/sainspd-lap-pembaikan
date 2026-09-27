// Evidence summary for one registered DMA. Field labels reflect independently
// APPROVED review records; no field status by itself authorizes a simulation.
export async function reviewedDmaStatus(db,dma){
  const model=await db.prepare(`SELECT m.model_id,v.version,v.validation_status,v.calibration_status
    FROM hydraulic_models m JOIN hydraulic_model_versions v ON v.model_id=m.model_id
    WHERE m.zone_name=? COLLATE NOCASE AND v.active=1 ORDER BY v.version DESC LIMIT 1`).bind(dma).first();
  if(!model)return null;
  const args=[model.model_id,model.version];
  const [linksResult,nodesResult,boundariesResult,reviewsResult,mappingsResult,issuesResult]=await Promise.all([
    db.prepare(`SELECT link_id,link_type FROM hydraulic_links WHERE model_id=? AND version=?`).bind(...args).all(),
    db.prepare(`SELECT node_id,node_type FROM hydraulic_nodes WHERE model_id=? AND version=?`).bind(...args).all(),
    db.prepare(`SELECT node_id,boundary_type FROM hydraulic_boundaries WHERE model_id=? AND version=?`).bind(...args).all(),
    db.prepare(`SELECT entity_type,entity_id,parameter_name,classification,value_real,value_text,source_ref,effective_at
      FROM hydraulic_parameter_reviews WHERE model_id=? AND version=? AND review_status='APPROVED'
      ORDER BY entered_at DESC,rowid DESC LIMIT 10000`).bind(...args).all(),
    db.prepare(`SELECT sensor_id FROM hydraulic_sensor_mappings WHERE model_id=? AND version=? AND district_metered_area=? COLLATE NOCASE
      AND review_status='APPROVED'`).bind(...args,dma).all(),
    db.prepare(`SELECT issue_code,target_id,detail FROM hydraulic_model_issues WHERE model_id=? AND version=? AND resolved_at IS NULL
      LIMIT 200`).bind(...args).all()
  ]);
  const links=linksResult.results||[],nodes=nodesResult.results||[],boundaries=boundariesResult.results||[];
  const reviews=new Map();
  for(const row of reviewsResult.results||[]){
    const key=[row.entity_type,row.entity_id,row.parameter_name].join('\u0000');
    if(!reviews.has(key))reviews.set(key,row);
  }
  const get=(type,id,parameter)=>reviews.get([type,id,parameter].join('\u0000'));
  const make=(label,entities,type,parameter)=>{
    if(!entities.length)return {label,status:'MISSING',detail:'Inventori model DMA belum diisi; jumlah diperlukan belum diketahui.',missing:null,total:0};
    const values=entities.map(id=>get(type,id,parameter));
    const missing=values.filter(row=>!row||row.classification==='MISSING'||!row.source_ref||!row.effective_at).length;
    const classes=new Set(values.filter(Boolean).map(row=>row.classification));
    const status=missing===entities.length?'MISSING':missing?'PARTIAL':classes.size===1?[...classes][0]:'PARTIAL';
    return {label,status,missing,total:entities.length,detail:missing?
      `${missing} daripada ${entities.length} entiti model belum mempunyai nilai yang diluluskan dengan sumber dan masa efektif.`:
      `${entities.length} daripada ${entities.length} entiti mempunyai semakan diluluskan (${[...classes].join('/')}).`};
  };
  const pipeIds=links.filter(x=>x.link_type==='PIPE').map(x=>x.link_id);
  const junctionIds=nodes.filter(x=>x.node_type==='JUNCTION').map(x=>x.node_id);
  const reservoirIds=boundaries.filter(x=>x.boundary_type==='RESERVOIR').map(x=>x.node_id);
  const valveIds=links.filter(x=>x.link_type==='VALVE').map(x=>x.link_id);
  const pumpIds=links.filter(x=>x.link_type==='PUMP').map(x=>x.link_id);
  const tankIds=nodes.filter(x=>x.node_type==='TANK').map(x=>x.node_id);
  const inventory=[...reviews.values()].some(row=>row.entity_type==='MODEL'&&row.parameter_name==='equipment_inventory_status'&&
    row.classification==='VERIFIED'&&row.value_text==='VERIFIED');
  const equipment=(label,ids,type,parameter)=>!ids.length&&inventory?
    {label,status:'NOT APPLICABLE',detail:'Inventori peralatan kosong telah disahkan.'}:make(label,ids,type,parameter);
  const fields={
    pipeId:make('Pipe ID',pipeIds,'PIPE','pipe_id'),diameter:make('Diameter',pipeIds,'PIPE','diameter_mm'),
    length:make('Engineering Length',pipeIds,'PIPE','length_m'),roughness:make('Hazen-Williams C / Roughness',pipeIds,'PIPE','hazen_c'),
    topology:{label:'Topology / Connectivity',status:'MISSING',detail:'Semakan fizikal bertandatangan dan sambungan hidraulik belum dibuktikan.'},
    elevation:make('Node Elevation',junctionIds,'NODE','elevation_m'),
    demand:make('Base Demand',junctionIds,'NODE','base_demand_m3s'),
    pattern:{label:'Demand Pattern',status:'MISSING',detail:'Corak dan tempoh operasi belum disemak.'},
    sourceHead:make('Source / Reservoir Head',reservoirIds,'SOURCE','head_m'),
    valves:equipment('Valve Data',valveIds,'VALVE','setting'),
    pumps:equipment('Pump Data',pumpIds,'PUMP','curve_ref'),
    tanks:equipment('Tank Data',tankIds,'TANK','initial_level_m'),
    sensorMapping:{label:'Sensor Mapping',status:(mappingsResult.results||[]).length?'PARTIAL':'MISSING',
      detail:`${(mappingsResult.results||[]).length} pemetaan diluluskan; liputan sensor dan pemerhatian sebenar belum disahkan.`},
    calibration:{label:'Calibration Observations',status:'MISSING',detail:'Tiada perbandingan kalibrasi bukan TEST yang diluluskan.'}
  };
  if((issuesResult.results||[]).length)fields.topology.detail=`${issuesResult.results.length} isu model belum selesai; semakan fizikal masih diperlukan.`;
  return {modelId:model.model_id,modelVersion:model.version,fields,
    unresolvedModelIssues:issuesResult.results||[],
    inventory:{pipes:pipeIds.length,junctions:junctionIds.length,reservoirs:reservoirIds.length,valves:valveIds.length,pumps:pumpIds.length,tanks:tankIds.length},
    steadyState:'NOT_READY',baseline:'NOT_READY',calibration:'NOT_READY'};
}
