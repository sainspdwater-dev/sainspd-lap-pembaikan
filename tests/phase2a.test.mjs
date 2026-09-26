import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePhase2aAction, normalizeImportRows, parseRecordedAt, readinessFromData, suggestMapping } from '../worker/phase2a.js';

const headers = {};
const admin = { username:'admin-test', level:'ADMIN' };
const guest = { username:'guest-test', level:'GUEST' };
const units = {flow:'m3/h',inlet:'bar',cp:'bar',nightUse:'m3/h'};
const columns = ['DMA','Timestamp','Sensor ID','Flow','Pressure Inlet','CP Pressure'];
const mapping = {dma:'DMA',recordedAt:'Timestamp',sensorId:'Sensor ID',flow:'Flow',inlet:'Pressure Inlet',cp:'CP Pressure'};

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE ai_chat_history(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,created_at TEXT);
    CREATE TABLE water_assets(asset_num TEXT,zone TEXT,material TEXT,size TEXT,length REAL);
    CREATE VIEW water_assets_unique AS SELECT DISTINCT * FROM water_assets;`);
  for (const migration of ['0001_monitoring_schema.sql','0003_pipe_network.sql','0004_phase2a_operational_foundation.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
  }
  sqlite.prepare("INSERT INTO water_assets(asset_num,zone,material,size,length) VALUES('P-1','SIRUSA','MS','300',100)").run();
  sqlite.prepare("INSERT INTO pipe_network_imports(import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count) VALUES('import-1','test','x','y',1,1)").run();
  sqlite.prepare("INSERT INTO pipe_network_segments(import_id,segment_key,geometry_json,geometry_sha256,length_m,min_lng,min_lat,max_lng,max_lat) VALUES('import-1','S-1','{}','x',100,101,2,102,3)").run();
  sqlite.prepare("INSERT INTO pipe_network_zone_lines(import_id,zone_name,segment_key,part_index,asset_num,geometry_json,length_m,min_lng,min_lat,max_lng,max_lat) VALUES('import-1','SIRUSA','S-1',0,'P-1','{}',100,101,2,102,3)").run();
  const meta = changes => ({changes,size_after:sqlite.prepare('PRAGMA page_count').get().page_count*sqlite.prepare('PRAGMA page_size').get().page_size});
  const prepare = sql => ({
    bind(...params) { return statement(sql,params); },
    all() { return statement(sql,[]).all(); },
    first() { return statement(sql,[]).first(); },
    run() { return statement(sql,[]).run(); }
  });
  const statement = (sql,params) => ({
    async all() { const rows=sqlite.prepare(sql).all(...params); return {results:rows,meta:meta(0)}; },
    async first() { return sqlite.prepare(sql).get(...params) || null; },
    async run() { const result=sqlite.prepare(sql).run(...params); return {meta:meta(result.changes)}; }
  });
  const db={
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results=[]; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
      catch(error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return {db,sqlite};
}

async function action(db,data,user=admin) {
  const response=await handlePhase2aAction({action:data.action,data,env:{DB:db},user,headers,secret:'test-secret-for-preview'});
  return {status:response.status,body:await response.json()};
}
const batchId=()=>crypto.randomUUID();
const csv=(id,rows,partIndex=0,totalRows=rows.length,isFinal=true) => ({action:'importOperationalChunk',batchId:id,partIndex,isFinal,rows,totalRows,sourceName:'scada.csv',sourceSha256:'a'.repeat(64),headers:columns,mapping,units});

test('timestamp validation never invents a reading time',()=>{
  assert.equal(parseRecordedAt('').status,'MISSING_TIMESTAMP');
  assert.equal(parseRecordedAt('31/02/2026 12:00').status,'INVALID_TIMESTAMP');
  assert.equal(parseRecordedAt('01/09/2026 08:00').iso,'2026-09-01T00:00:00.000Z');
  assert.equal(parseRecordedAt('2026-09-01').status,'INVALID_TIMESTAMP');
});

test('exact mapping, partial rows and invalid timestamps',async()=>{
  assert.equal(suggestMapping(columns).recordedAt,'Timestamp');
  const rows=[
    {DMA:'SIRUSA',Timestamp:'01/09/2026 08:00','Sensor ID':'F-1',Flow:'10','Pressure Inlet':'2.5','CP Pressure':'1.7'},
    {DMA:'SIRUSA',Timestamp:'01/09/2026 09:00','Sensor ID':'F-1',Flow:'11','Pressure Inlet':'2.4','CP Pressure':''},
    {DMA:'SIRUSA',Timestamp:'01/09/2026 10:00','Sensor ID':'F-1',Flow:'12','Pressure Inlet':'','CP Pressure':''},
    {DMA:'SIRUSA',Timestamp:'','Sensor ID':'F-1',Flow:'13','Pressure Inlet':'','CP Pressure':''},
    {DMA:'SIRUSA',Timestamp:'31/02/2026 08:00','Sensor ID':'F-1',Flow:'14','Pressure Inlet':'','CP Pressure':''}
  ];
  const output=await normalizeImportRows(rows,mapping,units);
  assert.equal(output.stats.rowsAccepted,3);
  assert.equal(output.stats.rowsRejected,2);
  assert.equal(output.stats.missingTimestamp,1);
  assert.equal(output.observations.length,6);
});

test('CSV import is idempotent across replay and overlapping files; manual conflict is preserved',async()=>{
  const {db,sqlite}=database();
  const manual=await action(db,{action:'saveDmaMonitoring',dma:'SIRUSA',manualTelemetry:{recorded_at:'01/09/2026 08:00',pressure_cp_bar:1.8},sensors:[],ald:null});
  assert.equal(manual.status,200);
  const id=batchId();
  const rows=[{DMA:'SIRUSA',Timestamp:'01/09/2026 08:00','Sensor ID':'DMA_UNSPECIFIED',Flow:'10','Pressure Inlet':'2.5','CP Pressure':'1.7'}];
  const first=await action(db,csv(id,rows));
  assert.equal(first.status,200);
  assert.equal(first.body.report.observationsInserted,2);
  assert.equal(first.body.report.conflictsSkipped,1);
  const replay=await action(db,csv(id,rows));
  assert.equal(replay.body.replay,true);
  const overlap=await action(db,csv(batchId(),[...rows,{DMA:'SIRUSA',Timestamp:'02/09/2026 08:00','Sensor ID':'DMA_UNSPECIFIED',Flow:'11','Pressure Inlet':'2.4','CP Pressure':''}]));
  assert.equal(overlap.body.report.observationsInserted,2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dma_telemetry').get().n,5);
  assert.equal(sqlite.prepare("SELECT value FROM dma_telemetry WHERE parameter='CP_PRESSURE'").get().value,1.8);
});

test('ALD confirmation links to separate assessment; readiness distinguishes sensor states',async()=>{
  const {db,sqlite}=database();
  const result=await action(db,{action:'saveDmaMonitoring',dma:'SIRUSA',manualTelemetry:{},sensors:[{sensor_type:'PRESSURE_CP',sensor_name:'CP-1',latitude:2.1,longitude:101.8}],systemAssessment:{status:'SUSPECTED_ABNORMAL',candidatePipeId:'P-102'},ald:{inspected_at:'01/09/2026 10:00',result_status:'CONFIRMED_LEAK',result_category:'BURST',pipe_id:'P-108',location:'Jalan X'}});
  assert.equal(result.status,200);
  const row=sqlite.prepare('SELECT a.candidate_pipe_id,f.pipe_id,f.result_category FROM ald_investigations a JOIN ald_results f ON f.investigation_id=a.investigation_id').get();
  assert.equal(row.candidate_pipe_id,'P-102'); assert.equal(row.pipe_id,'P-108'); assert.equal(row.result_category,'BURST');
  const repeated=await action(db,{action:'saveDmaMonitoring',dma:'SIRUSA',investigationId:result.body.investigationId,manualTelemetry:{},sensors:[],ald:{inspected_at:'01/09/2026 10:00',result_status:'CONFIRMED_LEAK',result_category:'BURST',pipe_id:'P-108',location:'Jalan X'}});
  assert.equal(repeated.status,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ald_results').get().n,1);
  const readiness=readinessFromData([], [{sensor_type:'PRESSURE_CP'}],true);
  assert.equal(readiness.parameters.CP_PRESSURE,'SENSOR_CONFIGURED_NO_READING');
  assert.equal(readiness.parameters.FLOW,'SENSOR_NOT_CONFIGURED');
  assert.equal(readiness.hydraulicTopology,'MISSING');
});

test('storage size is measured; cleanup requires ADMIN, preview and typed confirmation; core data survives',async()=>{
  const {db,sqlite}=database();
  const id=batchId();
  const rows=[{DMA:'SIRUSA',Timestamp:'01/09/2026 08:00','Sensor ID':'F-1',Flow:'10','Pressure Inlet':'','CP Pressure':''}];
  assert.equal((await action(db,csv(id,rows))).status,200);
  const status=await action(db,{action:'getStorageStatus'});
  assert.ok(status.body.databaseBytes>0); assert.equal(status.body.sizeSource,'D1Result.meta.size_after');
  assert.equal((await action(db,{action:'previewStorageCleanup',category:'SCADA_CSV_OBSERVATIONS'},guest)).status,403);
  const preview=await action(db,{action:'previewStorageCleanup',category:'SCADA_CSV_OBSERVATIONS'});
  assert.equal(preview.body.eligibleCount,1);
  const denied=await action(db,{action:'executeStorageCleanup',category:'SCADA_CSV_OBSERVATIONS',issuedAt:preview.body.issuedAt,previewToken:preview.body.previewToken,confirmation:'NO'});
  assert.equal(denied.status,403);
  const done=await action(db,{action:'executeStorageCleanup',category:'SCADA_CSV_OBSERVATIONS',issuedAt:preview.body.issuedAt,previewToken:preview.body.previewToken,confirmation:'CLEANUP'});
  assert.equal(done.status,200); assert.equal(done.body.deletedCount,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM water_assets').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pipe_network_segments').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM storage_cleanup_audit').get().n,1);
});

test('interrupted multi-part import resumes without duplication',async()=>{
  const {db,sqlite}=database();
  const id=batchId();
  const rows=Array.from({length:11},(_,i)=>({DMA:'SIRUSA',Timestamp:`${String(i+1).padStart(2,'0')}/09/2026 08:00`,'Sensor ID':'F-1',Flow:String(i+1),'Pressure Inlet':'','CP Pressure':''}));
  const first=await action(db,csv(id,rows.slice(0,10),0,11,false));
  assert.equal(first.status,200);
  assert.equal(sqlite.prepare('SELECT status FROM operational_import_batches').get().status,'PARTIAL');
  const replay=await action(db,csv(id,rows.slice(0,10),0,11,false)); assert.equal(replay.body.replay,true);
  const last=await action(db,csv(id,rows.slice(10),1,11,true)); assert.equal(last.status,200);
  assert.equal(sqlite.prepare('SELECT status FROM operational_import_batches').get().status,'COMPLETED');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dma_telemetry').get().n,11);
});

test('failed timestamp provenance is staged; Smart Cleanup only removes failed issues',async()=>{
  const {db,sqlite}=database();
  const id=batchId();
  const invalid=[{DMA:'SIRUSA',Timestamp:'','Sensor ID':'F-1',Flow:'10','Pressure Inlet':'','CP Pressure':''}];
  const imported=await action(db,csv(id,invalid));
  assert.equal(imported.status,200);
  assert.equal(sqlite.prepare('SELECT status FROM operational_import_batches').get().status,'FAILED');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dma_telemetry').get().n,0);
  const issue=sqlite.prepare('SELECT issue_code,detail FROM operational_import_issues').get();
  assert.equal(issue.issue_code,'MISSING_TIMESTAMP');
  assert.equal(JSON.parse(issue.detail).values.FLOW,10);
  sqlite.prepare("INSERT INTO ald_results(district_metered_area,inspected_at,result_status) VALUES('SIRUSA','2026-09-01T00:00:00Z','CONFIRMED_LEAK')").run();
  const preview=await action(db,{action:'previewStorageCleanup',category:'FAILED_IMPORT_ISSUES'});
  assert.equal(preview.body.eligibleCount,1);
  const done=await action(db,{action:'executeStorageCleanup',category:'FAILED_IMPORT_ISSUES',issuedAt:preview.body.issuedAt,previewToken:preview.body.previewToken,confirmation:'CLEANUP'});
  assert.equal(done.status,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM operational_import_issues').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ald_results').get().n,1);
});

test('server rejects invalid units, oversized chunks and unauthorised imports',async()=>{
  const {db}=database();
  const row={DMA:'SIRUSA',Timestamp:'01/09/2026 08:00','Sensor ID':'F-1',Flow:'10','Pressure Inlet':'','CP Pressure':''};
  const badUnit={...csv(batchId(),[row]),units:{...units,flow:'L/s'}};
  assert.equal((await action(db,badUnit)).status,400);
  assert.equal((await action(db,csv(batchId(),Array.from({length:11},()=>row)))).status,400);
  assert.equal((await action(db,csv(batchId(),[row]),guest)).status,403);
});

test('sensor upsert does not fail when the existing DMA/ALD form is saved twice',async()=>{
  const {db,sqlite}=database();
  const data={action:'saveDmaMonitoring',dma:'SIRUSA',manualTelemetry:{},sensors:[{sensor_type:'PRESSURE_CP',sensor_name:'CP-1',latitude:2.1,longitude:101.8}]};
  assert.equal((await action(db,data)).status,200);
  assert.equal((await action(db,data)).status,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM dma_sensors').get().n,1);
});

test('dashboard inline scripts and Phase 2A control IDs parse',()=>{
  const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]).filter(Boolean);
  for (const body of scripts) assert.doesNotThrow(()=>new Function(body));
  for (const id of ['ai-import-panel','ai-import-mapping','ai-preview-import','ai-confirm-import','ai-readiness-status','ai-storage-status','ai-cleanup-preview','ai-cleanup-confirmation']) assert.ok(html.includes(`id="${id}"`));
  assert.ok(html.includes('phase2a-ui.js'));
});
