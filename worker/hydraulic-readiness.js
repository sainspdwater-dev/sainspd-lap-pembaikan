// Capability gates are explicit booleans, not an opaque percentage. A solver
// success cannot upgrade an uncalibrated production model to VALIDATED.
const present = x => typeof x === 'number' && Number.isFinite(x);
const approved = x => x === 'VERIFIED' || x === 'MANUAL';
const countStatus=(missing,total)=>({status:!total||missing===total?'MISSING':missing?'PARTIAL':'READY',missing:total?missing:1,total});
const parameter = (items, field, statusField, extra=()=>true) => {
  const count=items.filter(item=>!present(item[field])||item[field]<=0||!approved(item[statusField])||!extra(item)).length;
  return {status:items.length===0?'MISSING':count===0?'READY':count===items.length?'MISSING':'PARTIAL',missing:items.length?count:1,total:items.length};
};
export function evaluateHydraulicReadiness(model, topology) {
  const nodes=model.nodes||[], pipes=model.pipes||[], sources=model.sources||[], demands=model.demands||[];
  const pipeId=countStatus(pipes.filter(p=>!p.id||!approved(p.pipeIdStatus)||!p.pipeIdSource).length,pipes.length);
  const diameter=parameter(pipes,'diameterMm','diameterStatus',p=>!!p.diameterSource);
  const length=parameter(pipes,'lengthM','lengthStatus',p=>p.lengthSource!=='GEOMETRY_DERIVED'&&!!p.lengthEvidence);
  const roughness=parameter(pipes,'roughness','roughnessStatus',p=>p.roughnessEquation==='HAZEN_WILLIAMS'&&!!p.roughnessSource);
  const elevation={status:'MISSING',missing:1,total:0};
  const junctions=nodes.filter(n=>n.type==='JUNCTION');
  if(junctions.length){elevation.total=junctions.length;elevation.missing=junctions.filter(n=>!present(n.elevationM)||!approved(n.elevationStatus)||!n.elevationSource).length;
    elevation.status=elevation.missing===0?'READY':elevation.missing===junctions.length?'MISSING':'PARTIAL';}
  const demand=countStatus(demands.filter(d=>!present(d.baseM3s)||d.baseM3s<0||!approved(d.status)||!d.allocationMethod||!d.source).length,demands.length);
  const sourceHead=countStatus(sources.filter(s=>!present(s.headM)||!approved(s.headStatus)||!s.source||!s.effectiveAt).length,sources.length);
  // Empty equipment lists are only meaningful after the inventory is signed off.
  const equipment=(items,valid)=>model.equipmentInventoryStatus!=='VERIFIED'?{status:'MISSING',missing:1,total:items.length}:
    {status:items.every(valid)?'READY':'MISSING',missing:items.filter(item=>!valid(item)).length,total:items.length};
  const pumps=equipment(model.pumps||[],p=>!!p.curve&&!!p.status&&approved(p.provenanceStatus));
  const valves=equipment(model.valves||[],v=>!!v.type&&present(v.diameterMm)&&v.diameterMm>0&&present(v.setting)&&!!v.status&&approved(v.provenanceStatus));
  const tanks=equipment(model.tanks||[],t=>['baseElevationM','initialLevelM','minLevelM','maxLevelM','diameterM'].every(k=>present(t[k]))&&
    t.minLevelM<=t.initialLevelM&&t.initialLevelM<=t.maxLevelM&&t.diameterM>0&&approved(t.provenanceStatus));
  const patternIds=new Set((model.patterns||[]).filter(p=>approved(p.status)&&Array.isArray(p.multipliers)&&p.multipliers.length>0&&
    p.multipliers.every(x=>present(x)&&x>=0)).map(p=>p.id));
  const pattern={status:demands.length&&demands.every(d=>patternIds.has(d.patternId))?'READY':'MISSING',
    missing:demands.length?demands.filter(d=>!patternIds.has(d.patternId)).length:1};
  const calibration={status:'MISSING',count:0};
  const topologyReasons=[];
  if(!topology?.summary?.pipeCount||topology.summary.connectedComponents!==1)topologyReasons.push('Network connectivity unresolved');
  if(topology?.issues?.some(i=>i.severity==='CRITICAL'))topologyReasons.push('Critical topology issue');
  if(topology?.reviewStatus!=='VERIFIED'||!topology.reviewedBy||!Number.isFinite(Date.parse(topology.reviewedAt)))
    topologyReasons.push('Signed physical topology review missing');
  if(topology?.links?.some(link=>!link.assetNum))topologyReasons.push('Pipe ID mapping incomplete');
  if(topology?.unresolvedReviewCount>0)topologyReasons.push('Endpoint/crossing review unresolved');
  const topologyReady=topologyReasons.length===0;
  const geometryReady=!!topology?.summary?.pipeCount && topology?.reviewStatus==='VERIFIED' &&
    Array.isArray(topology?.links) && topology.links.length===topology.summary.pipeCount &&
    topology.links.every(link=>!!link.assetNum);
  const temporal={status:model.temporalBoundaryStatus==='VERIFIED'?'READY':'MISSING',missing:model.temporalBoundaryStatus==='VERIFIED'?0:1};
  const fields={topology:{status:topologyReady?'READY':'NOT_READY',components:topology?.summary?.connectedComponents??null,reasons:topologyReasons},
    pipeId,diameter,length,roughness,elevation,demand,sourceHead,pumps,valves,tanks,patterns:pattern,temporal,calibration};
  const mandatory=['topology','pipeId','diameter','length','roughness','elevation','demand','sourceHead','pumps','valves','tanks'];
  const steady=mandatory.every(k=>fields[k].status==='READY');
  const extended=steady&&pattern.status==='READY'&&temporal.status==='READY';
  const issues=[];
  for(const [field,value] of Object.entries(fields)) if(value.status!=='READY') issues.push({field,status:value.status,missing:value.missing??null});
  if((model.assumptions||[]).some(a=>a.approvalStatus!=='APPROVED')) issues.push({field:'unapprovedAssumptions',status:'NOT_READY'});
  const assumptionBlock=issues.some(i=>i.field==='unapprovedAssumptions');
  const baseline=steady&&!assumptionBlock&&model.baseline?.status==='COMPLETED'&&model.baseline.modelVersion===model.version;
  const reasons=steady?['Solver-derived baseline for this reviewed model version required']:
    mandatory.filter(k=>fields[k].status!=='READY').map(k=>`${k}: ${fields[k].status}`);
  if(assumptionBlock)reasons.push('Unapproved engineering assumption');
  const scenario=(ready,extra)=>({status:ready?'READY':'NOT_READY',reasons:ready?[]:[...reasons,...extra]});
  const scenarioCapabilities={PIPE_CLOSED:scenario(baseline,[]),DEMAND_CHANGE:scenario(baseline,[]),
    SOURCE_HEAD_CHANGE:scenario(baseline,[]),SCENARIO_COMPARE:scenario(baseline,[]),
    VALVE_ISOLATION:scenario(baseline&&(model.valves||[]).length>0&&model.valveIsolationReview==='VERIFIED',['Reviewed valve closure topology missing']),
    PUMP_OFF:scenario(baseline&&(model.pumps||[]).length>0,['Reviewed pump curve and status missing']),
    TANK_LEVEL_CHANGE:scenario(baseline&&(model.tanks||[]).length>0,['Reviewed tank operating range missing']),
    FIRE_FLOW:scenario(baseline&&model.fireFlowCriteriaStatus==='VERIFIED',['Approved fire-flow criteria missing']),
    ALTERNATIVE_SUPPLY:scenario(baseline&&model.alternativeSupplyReview==='VERIFIED',['Physical alternative source path unverified'])};
  const capacity=model.capacityBasis||{};
  scenarioCapabilities.RESERVE_MARGIN=scenario(baseline&&capacity.status==='VERIFIED'&&
    ['PIPE_CAPACITY','DMA_SUPPLY_CAPACITY','SOURCE_CAPACITY','TRANSFER_CAPACITY','ALTERNATIVE_SUPPLY_CAPACITY'].includes(capacity.type)&&
    !!capacity.formula&&!!capacity.unit,['Approved capacity type, formula and unit missing']);
  const calibrationStatus=model.calibration?.status;
  const calibrationReady=['CALIBRATED','VALIDATED'].includes(calibrationStatus) &&
    model.calibration?.modelVersion===model.version && model.calibration?.reviewStatus==='APPROVED' &&
    model.calibration?.matchedObservationCount>0;
  const capabilities={geometry:geometryReady?'READY':'NOT_READY',topology:topologyReady?'READY':'NOT_READY',
    steadyState:steady&&!assumptionBlock?'READY':'NOT_READY',
    extendedPeriod:extended&&!assumptionBlock?'READY':'NOT_READY',
    calibration:baseline&&calibrationReady?'READY':'NOT_READY',baseline:baseline?'READY':'NOT_READY',
    scenario:baseline?'READY':'NOT_READY',leakModelling:'NOT_READY',leakLocalisation:'NOT_READY',
    valveIsolation:scenarioCapabilities.VALVE_ISOLATION.status};
  return {status:capabilities.steadyState==='READY'?'READY':pipes.length?'PARTIAL':'NOT_READY',fields,capabilities,
    scenarioCapabilities,issues,calibrationStatus:calibrationReady?calibrationStatus:
      (model.calibration?.matchedObservationCount>0?'CALIBRATION IN PROGRESS':'CALIBRATION DATA INSUFFICIENT'),
    limitations:['Solver convergence does not establish calibration or field validation.',
      ...issues.map(i=>`${i.field}: ${i.status}`),...(model.assumptions||[]).map(a=>`ASSUMPTION: ${a.field} (${a.approvalStatus})`)]};
}
