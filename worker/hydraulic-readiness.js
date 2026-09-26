// Capability gates are explicit booleans, not an opaque percentage. A solver
// success cannot upgrade an uncalibrated production model to VALIDATED.
const present = x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
const parameter = (items, field) => {
  const count=items.filter(item=>!present(item[field])).length;
  return {status:items.length===0?'MISSING':count===0?'READY':count===items.length?'MISSING':'PARTIAL',missing:items.length?count:1,total:items.length};
};
export function evaluateHydraulicReadiness(model, topology) {
  const nodes=model.nodes||[], pipes=model.pipes||[], sources=model.sources||[], demands=model.demands||[];
  const diameter=parameter(pipes,'diameterMm'), length=parameter(pipes,'lengthM'), roughness=parameter(pipes,'roughness');
  const elevation=parameter(nodes.filter(n=>n.type==='JUNCTION'),'elevationM');
  const demand={status:demands.length && demands.every(d=>present(d.baseM3s)&&d.allocationMethod&&d.source)?'READY':'MISSING',missing:demands.length?demands.filter(d=>!present(d.baseM3s)||!d.allocationMethod||!d.source).length:1,total:demands.length};
  const sourceHead={status:sources.length && sources.every(s=>present(s.headM)&&s.source&&s.effectiveAt)?'READY':'MISSING',missing:sources.length?sources.filter(s=>!present(s.headM)||!s.source||!s.effectiveAt).length:1,total:sources.length};
  const pumps={status:(model.pumps||[]).every(p=>p.curve&&p.status)?'READY':'MISSING',missing:(model.pumps||[]).filter(p=>!p.curve||!p.status).length};
  const valves={status:(model.valves||[]).every(v=>v.type&&present(v.diameterMm)&&present(v.setting)&&v.status)?'READY':'MISSING',missing:(model.valves||[]).filter(v=>!v.type||!present(v.diameterMm)||!present(v.setting)||!v.status).length};
  const tanks={status:(model.tanks||[]).every(t=>['baseElevationM','initialLevelM','minLevelM','maxLevelM','diameterM'].every(k=>present(t[k])))?'READY':'MISSING',missing:(model.tanks||[]).filter(t=>!['baseElevationM','initialLevelM','minLevelM','maxLevelM','diameterM'].every(k=>present(t[k]))).length};
  const pattern={status:(model.patterns||[]).length && demands.every(d=>d.patternId)?'READY':'MISSING',missing:demands.filter(d=>!d.patternId).length};
  const observations=(model.observations||[]).filter(o=>!o.isTestData&&o.qualityStatus==='MEASURED'&&o.sensorId&&o.timestamp);
  const calibration={status:observations.length>=2?'PARTIAL':'MISSING',count:observations.length};
  const topologyReady=topology?.summary?.pipeCount>0 && topology.summary.connectedComponents===1 && !topology.issues.some(i=>i.severity==='CRITICAL');
  const fields={topology:{status:topologyReady?'READY':'NOT_READY',components:topology?.summary?.connectedComponents??null},diameter,length,roughness,elevation,demand,sourceHead,pumps,valves,tanks,patterns:pattern,calibration};
  const mandatory=['topology','diameter','length','roughness','elevation','demand','sourceHead','pumps','valves','tanks'];
  const steady=mandatory.every(k=>fields[k].status==='READY');
  const extended=steady&&pattern.status==='READY';
  const issues=[];
  for(const [field,value] of Object.entries(fields)) if(value.status!=='READY') issues.push({field,status:value.status,missing:value.missing??null});
  if((model.assumptions||[]).some(a=>a.approvalStatus!=='APPROVED')) issues.push({field:'unapprovedAssumptions',status:'NOT_READY'});
  const assumptionBlock=issues.some(i=>i.field==='unapprovedAssumptions');
  const capabilities={topology:topologyReady?'READY':'NOT_READY',steadyState:steady&&!assumptionBlock?'READY':'NOT_READY',extendedPeriod:extended&&!assumptionBlock?'READY':'NOT_READY',calibration:steady&&calibration.count>=2&&!assumptionBlock?'PARTIAL':'NOT_READY',leakLocalisation:'NOT_READY',valveIsolation:steady&&(model.valves||[]).length?'PARTIAL':'NOT_READY'};
  return {status:capabilities.steadyState==='READY'?'READY':topologyReady?'PARTIAL':'NOT_READY',fields,capabilities,issues,calibrationStatus:'UNCALIBRATED',limitations:['Solver convergence does not establish calibration or field validation.',...(model.assumptions||[]).map(a=>`ASSUMPTION: ${a.field} (${a.approvalStatus})`)]};
}
