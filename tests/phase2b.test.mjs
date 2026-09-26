import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { auditTopology, candidateJunctions } from '../worker/hydraulic-topology.js';
import { evaluateHydraulicReadiness } from '../worker/hydraulic-readiness.js';
import { handlePhase2bAction, hydraulicIntent, hydraulicScenarioIntent, productionHydraulicStatus } from '../worker/phase2b.js';
import { reviewableTopologyIssues, reviewedIssue } from '../worker/hydraulic-issues.js';

const line=(id,coords,overrides={})=>({segment_key:id,asset_num:id,size_mm:200,length_m:100,geometry_json:JSON.stringify({type:'LineString',coordinates:coords}),...overrides});
test('topology snaps endpoints deterministically but never joins a crossing',()=>{
  const rows=[line('A',[[101,2],[101.001,2]]),line('B',[[101.001002,2],[101.002,2]]),line('C',[[101.0015,1.9995],[101.0015,2.0005]])];
  const a=auditTopology(rows,{snapMeters:0.5,nearMissMeters:2});
  const b=auditTopology([...rows].reverse(),{snapMeters:0.5,nearMissMeters:2});
  assert.deepEqual(a.nodes,b.nodes);
  assert.equal(a.summary.connectedComponents,2);
  assert.equal(a.summary.nodeCount,5);
  assert.ok(a.intersections.some(i=>i.code==='CROSSING_UNJOINED'));
});
test('topology reports duplicate, disconnected, dangling and missing fields',()=>{
  const a=auditTopology([line('A',[[101,2],[101.001,2]]),line('B',[[101.001,2],[101,2]]),line('C',[[102,2],[102.001,2]],{size_mm:null})]);
  assert.equal(a.summary.connectedComponents,2);
  assert.ok(a.issues.some(i=>i.code==='DUPLICATE_EDGE'));
  assert.ok(a.issues.some(i=>i.code==='MISSING_DIAMETER'));
  assert.equal(a.summary.isolatedPipes,1);
  assert.equal(a.summary.danglingEndpoints,2);
});
test('near miss remains unresolved and overlapping geometry is flagged',()=>{
  const a=auditTopology([line('A',[[101,2],[101.001,2]]),line('B',[[101.00101,2],[101.002,2]]),line('C',[[101.0005,2],[101.0015,2]])],{snapMeters:0.2,nearMissMeters:2});
  assert.ok(a.summary.nearMissEndpoints>0);
  assert.ok(a.intersections.some(i=>i.code==='OVERLAPPING_GEOMETRY'));
});
test('snapping never chains a cluster beyond configured tolerance',()=>{
  const origin=[101,2], step=0.000004;
  const rows=[line('A',[origin,[101.01,2]]),line('B',[[101+step,2],[101.02,2]]),line('C',[[101+2*step,2],[101.03,2]])];
  const audit=auditTopology(rows,{snapMeters:0.5,nearMissMeters:2});
  assert.ok(audit.summary.blockedTransitiveSnaps>0);
  assert.ok(audit.summary.maxSnapSpanMeters<=0.5);
});
test('leak candidates are only graph nodes linked to a real pipe ID',()=>{
  const topology=auditTopology([line('S1',[[101,2],[101.001,2]],{asset_num:'PIPE-1'}),line('S2',[[102,2],[102.001,2]],{asset_num:'PIPE-2'})]);
  const candidates=candidateJunctions(topology,'PIPE-1');
  assert.equal(candidates.length,2);
  assert.ok(candidates.every(c=>c.status==='CANDIDATE_ONLY'&&c.assetNum==='PIPE-1'));
  assert.deepEqual(candidateJunctions(topology,'UNKNOWN'),[]);
});
test('topology issue review requires evidence and never edits geometry',async()=>{
  const audit=auditTopology([line('S1',[[101,2],[101.001,2]],{asset_num:null,size_mm:null})]);
  const records=await reviewableTopologyIssues('import-test',audit);
  assert.ok(records.some(r=>r.issueType==='MISSING_PIPE_ID'));
  const missing=records.find(r=>r.issueType==='MISSING_PIPE_ID');
  assert.throws(()=>reviewedIssue(missing,{status:'IGNORED_WITH_REASON'}),/Sebab wajib/);
  assert.throws(()=>reviewedIssue(missing,{status:'AUTO_SUGGESTED'}),/tanpa bukti/);
  const review=reviewedIssue(missing,{status:'MANUAL_REVIEW_REQUIRED',reason:'Semak as-built'});
  assert.equal(review.issueStatus,'MANUAL_REVIEW_REQUIRED');
  assert.equal(audit.links[0].assetNum,null);
});
test('readiness blocks missing engineering inputs and excludes TEST DATA calibration',()=>{
  const topology=auditTopology([line('P1',[[101,2],[101.001,2]])]);
  const model={nodes:[{id:'J',type:'JUNCTION',elevationM:null}],pipes:[{diameterMm:200,lengthM:100,roughness:null}],sources:[],demands:[],observations:[{isTestData:true,qualityStatus:'MEASURED',sensorId:'X',timestamp:'2026-01-01'}]};
  const r=evaluateHydraulicReadiness(model,topology);
  assert.equal(r.capabilities.steadyState,'NOT_READY');
  assert.equal(r.fields.roughness.status,'MISSING');
  assert.equal(r.fields.elevation.status,'MISSING');
  assert.equal(r.calibrationStatus,'CALIBRATION DATA INSUFFICIENT');
});
test('steady-state requires provenance and signed topology, not a demand pattern',()=>{
  const model={version:1,nodes:[{id:'J1',type:'JUNCTION',elevationM:20,elevationStatus:'VERIFIED',elevationSource:'survey'}],
    pipes:[{id:'P1',pipeIdStatus:'VERIFIED',pipeIdSource:'as-built',diameterMm:200,diameterStatus:'VERIFIED',diameterSource:'as-built',
      lengthM:100,lengthStatus:'VERIFIED',lengthSource:'ENGINEERING',lengthEvidence:'as-built',roughness:120,
      roughnessStatus:'VERIFIED',roughnessEquation:'HAZEN_WILLIAMS',roughnessSource:'as-built'}],
    demands:[{baseM3s:0.01,status:'MANUAL',allocationMethod:'metered allocation',source:'approved study'}],
    sources:[{headM:100,headStatus:'VERIFIED',source:'survey',effectiveAt:'2026-01-01T00:00:00Z'}],
    equipmentInventoryStatus:'VERIFIED',pumps:[],valves:[],tanks:[],patterns:[]};
  const topology={summary:{pipeCount:1,connectedComponents:1},issues:[],reviewStatus:'VERIFIED',
    reviewedBy:'Engineer',reviewedAt:'2026-01-01T00:00:00Z',
    links:[{assetNum:'P1'}],unresolvedReviewCount:0};
  const ready=evaluateHydraulicReadiness(model,topology);
  assert.equal(ready.capabilities.steadyState,'READY');
  assert.equal(ready.capabilities.geometry,'READY');
  assert.equal(ready.capabilities.extendedPeriod,'NOT_READY');
  assert.equal(ready.scenarioCapabilities.PIPE_CLOSED.status,'NOT_READY');
  assert.match(ready.scenarioCapabilities.VALVE_ISOLATION.reasons.join(' '),/valve/);
  model.baseline={status:'COMPLETED',modelVersion:1};
  const baseline=evaluateHydraulicReadiness(model,topology);
  assert.equal(baseline.capabilities.baseline,'READY');
  assert.equal(baseline.capabilities.calibration,'NOT_READY');
  assert.equal(baseline.scenarioCapabilities.PIPE_CLOSED.status,'READY');
  assert.equal(baseline.scenarioCapabilities.RESERVE_MARGIN.status,'NOT_READY');
  model.pipes[0].roughnessStatus='ASSUMED';
  assert.equal(evaluateHydraulicReadiness(model,topology).capabilities.steadyState,'NOT_READY');
  model.pipes[0].roughnessStatus='VERIFIED';
  topology.reviewStatus='UNRESOLVED';
  assert.equal(evaluateHydraulicReadiness(model,topology).capabilities.steadyState,'NOT_READY');
});
test('hydraulic intent intercepts simulation, not ordinary asset/history questions',()=>{
  assert.equal(hydraulicIntent('Berapa kali paip P123 pecah?'),false);
  assert.equal(hydraulicIntent('Berapa diameter P123?'),false);
  assert.equal(hydraulicIntent('Kalau paip P123 ditutup, tekanan kawasan sebelah macam mana?'),true);
  assert.equal(hydraulicIntent('Bandingkan normal dengan paip P123 gagal'),true);
  assert.equal(hydraulicIntent('Berapa reserve margin untuk DMA A?'),true);
  assert.equal(hydraulicScenarioIntent('Mana injap perlu tutup?'),'VALVE_ISOLATION');
  assert.equal(hydraulicScenarioIntent('Kalau paip P123 gagal?'),'PIPE_CLOSED');
});
test('candidate migration is additive and creates version/job metadata',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ai_chat_history(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,created_at TEXT);
    CREATE TABLE water_assets(asset_num TEXT,zone TEXT,material TEXT,size TEXT,length REAL);
    CREATE VIEW water_assets_unique AS SELECT DISTINCT * FROM water_assets;`);
  for(const name of ['0001_monitoring_schema.sql','0003_pipe_network.sql','0004_phase2a_operational_foundation.sql']) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare("INSERT INTO water_assets(asset_num,zone) VALUES('KEEP-ME','TEST')").run();
  db.exec(readFileSync(new URL('../migrations/0005_hydraulic_foundation.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM water_assets WHERE asset_num='KEEP-ME'").get().n,1);
  for(const table of ['hydraulic_models','hydraulic_model_versions','hydraulic_nodes','hydraulic_links','hydraulic_demands','hydraulic_patterns','hydraulic_boundaries','hydraulic_model_issues','hydraulic_topology_issues','hydraulic_scenarios','hydraulic_simulation_jobs','hydraulic_calibration_runs']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  db.exec(readFileSync(new URL('../migrations/0006_hydraulic_reviewed_parameters.sql',import.meta.url),'utf8'));
  for(const table of ['hydraulic_parameter_reviews','hydraulic_sensor_mappings'])
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  assert.throws(()=>db.prepare(`INSERT INTO hydraulic_parameter_reviews
    (entry_id,model_id,version,entity_type,entity_id,parameter_name,value_real,classification,entered_by)
    VALUES('x','m',1,'PIPE','p','diameter',200,'VERIFIED','admin')`).run(),/CHECK constraint/);
  db.close();
});
test('hydraulic endpoint is ADMIN only and never returns invented solver results',async()=>{
  const db={prepare:sql=>sql.includes('COUNT(*) AS sourceSegments')?
    {first:async()=>({sourceSegments:5,missingPipeIdSegments:2,missingDiameterSegments:1})}:
    {bind:()=>({first:async()=>({lineParts:3,segmentCount:2,assetCount:2,missingDiameterParts:1,missingGeometryLengthParts:0})})}};
  const status=await productionHydraulicStatus(db,'ZONE TEST');
  assert.equal(status.status,'NOT_READY');
  assert.equal(status.gis.missingPipeIdSegments,2);
  assert.ok(status.issues.some(issue=>issue.code==='PIPE_ID_MISSING'&&issue.count===2));
  assert.equal(status.engine.integration,'TEST_ONLY');
  assert.equal(status.scenarioCapabilities.PIPE_CLOSED.status,'NOT_READY');
  assert.match(status.scenarioCapabilities.RESERVE_MARGIN.reasons.join(' '),/Formula/);
  const denied=await handlePhase2bAction({action:'getHydraulicStatus',data:{dma:'ZONE TEST'},env:{DB:db},user:{level:'GUEST'},headers:{}});
  assert.equal(denied.status,403);
  const allowed=await handlePhase2bAction({action:'aiAgent',data:{prompt:'Kalau paip P1 ditutup apa jadi?',params:{dma:'ZONE TEST'}},env:{DB:db},user:{level:'ADMIN'},headers:{}});
  const payload=await allowed.json();
  assert.equal(payload.status,'success');
  assert.match(payload.answer,/NOT READY/);
  assert.deepEqual(payload.metrics,[]);
  assert.equal(payload.map.enabled,false);
});
test('existing AI page has compact disabled hydraulic controls, not a second map',()=>{
  const html=readFileSync(new URL('../staging-site/dashboard.html',import.meta.url),'utf8');
  assert.match(html,/id="ai-hydraulic-status"/);
  assert.match(html,/id="ai-hydraulic-issues"/);
  assert.match(html,/src="phase2b-ui\.js"/);
  assert.match(html,/disabled title="Model hidraulik belum sedia"/);
  assert.equal((html.match(/id="ai-agent-map"/g)||[]).length,1);
});
