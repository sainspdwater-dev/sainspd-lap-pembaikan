import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleHydraulicIntakeAction} from '../worker/hydraulic-intake.js';
import {reviewedDmaStatus} from '../worker/hydraulic-dma-status.js';

function fixture(registered=true){
  const sql=new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0003_pipe_network.sql','0005_hydraulic_foundation.sql','0006_hydraulic_reviewed_parameters.sql'])
    sql.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  if(registered){
    sql.prepare('INSERT INTO hydraulic_models(model_id,zone_name,owner_scope,created_by) VALUES(?,?,?,?)')
      .run('SAINS-BUKIT-KUAU-LAMA','300mm Bukit Kuau Lama','SAINS','admin');
    sql.prepare(`INSERT INTO hydraulic_model_versions
    (model_id,version,topology_version,parameter_version,snap_tolerance_m,validation_status,calibration_status,active,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('SAINS-BUKIT-KUAU-LAMA',1,'UNREVIEWED','DRAFT',0,'NOT_READY','NOT_STARTED',1,'admin');
  }
  const db={prepare(query){const stmt=sql.prepare(query);return {bind(...args){return {
    first:async()=>stmt.get(...args),all:async()=>({results:stmt.all(...args)}),run:async()=>stmt.run(...args)
  };}};},async batch(statements){sql.exec('BEGIN');try{for(const stmt of statements)await stmt.run();sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,db};
}
const row={entity_type:'PIPE',entity_id:'SOURCE-SEGMENT-1',parameter:'diameter_mm',value:'300',unit:'mm',
  classification:'VERIFIED',source_ref:'as-built:sheet-42',effective_at:'2026-09-01T00:00:00+08:00',notes:''};
const request=(action,db,user,extra={})=>handleHydraulicIntakeAction({action,env:{DB:db},user,headers:{},
  data:{dma:'300mm Bukit Kuau Lama',modelId:'SAINS-BUKIT-KUAU-LAMA',version:1,rows:[row],...extra}});
const author={level:'ADMIN',username:'engineer-a'};
test('selected DMA/model binding and staging TEST token gate prevent unsafe writes',async()=>{
  const {sql,db}=fixture();
  assert.equal((await request('saveHydraulicDraft',db,{...author,purpose:'HYDRAULIC_STAGING_TEST'})).status,403);
  assert.equal((await request('previewHydraulicIntake',db,author,{dma:'OTHER'})).status,400);
  assert.equal((await request('saveHydraulicDraft',db,{level:'GUEST',username:'guest'})).status,403);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hydraulic_parameter_reviews').get().n,0);
  sql.close();
});
test('manual/CSV rows require preview hash, persist DRAFT, and independent review is append-only',async()=>{
  const {sql,db}=fixture();
  const preview=await (await request('previewHydraulicIntake',db,author)).json();
  assert.equal(preview.preview.accepted,1);
  assert.equal((await request('saveHydraulicDraft',db,author)).status,400);
  const saved=await (await request('saveHydraulicDraft',db,author,
    {confirm:true,confirmationHash:preview.preview.confirmationHash})).json();
  assert.equal(saved.reviewStatus,'DRAFT');
  const draft=sql.prepare('SELECT * FROM hydraulic_parameter_reviews').get();
  assert.equal(draft.value_real,300);
  assert.equal(draft.source_ref,'as-built:sheet-42');
  assert.equal(draft.entered_by,'engineer-a');
  assert.equal((await request('reviewHydraulicDraft',db,author,{entryId:draft.entry_id,decision:'APPROVED',note:'As-built checked'})).status,403);
  const approved=await (await request('reviewHydraulicDraft',db,{level:'ADMIN',username:'engineer-b'},
    {entryId:draft.entry_id,decision:'APPROVED',note:'As-built checked'})).json();
  assert.equal(approved.decision,'APPROVED');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hydraulic_parameter_reviews').get().n,2);
  assert.equal(sql.prepare('SELECT review_status FROM hydraulic_parameter_reviews WHERE entry_id=?').get(draft.entry_id).review_status,'DRAFT');
  assert.equal((await request('previewHydraulicIntake',db,author).then(x=>x.json())).preview.accepted,0);
  sql.close();
});
test('invalid and duplicate engineering values are rejected without partial writes',async()=>{
  const {sql,db}=fixture();
  const response=await request('previewHydraulicIntake',db,author,{rows:[row,{...row,value:'-2'}]});
  const body=await response.json();
  assert.equal(body.preview.accepted,0);
  assert.ok(body.preview.firstErrors.length);
  assert.equal((await request('saveHydraulicDraft',db,author,{rows:[row,{...row,value:'-2'}],confirm:true,
    confirmationHash:'wrong'})).status,409);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hydraulic_parameter_reviews').get().n,0);
  sql.close();
});
test('per-DMA readiness reflects approved values only and never enables real baseline from one field',async()=>{
  const {sql,db}=fixture();
  sql.prepare(`INSERT INTO hydraulic_links(model_id,version,link_id,link_type,start_node_id,end_node_id)
    VALUES(?,?,?,?,?,?)`).run('SAINS-BUKIT-KUAU-LAMA',1,'SOURCE-SEGMENT-1','PIPE','N1','N2');
  const before=await reviewedDmaStatus(db,'300mm Bukit Kuau Lama');
  assert.equal(before.fields.diameter.status,'MISSING');
  const p=await (await request('previewHydraulicIntake',db,author)).json();
  await request('saveHydraulicDraft',db,author,{confirm:true,confirmationHash:p.preview.confirmationHash});
  assert.equal((await reviewedDmaStatus(db,'300mm Bukit Kuau lama')).fields.diameter.status,'MISSING');
  const draft=sql.prepare('SELECT entry_id FROM hydraulic_parameter_reviews').get();
  await request('reviewHydraulicDraft',db,{level:'ADMIN',username:'engineer-b'},
    {entryId:draft.entry_id,decision:'APPROVED',note:'Checked as-built'});
  const after=await reviewedDmaStatus(db,'300mm Bukit Kuau Lama');
  assert.equal(after.fields.diameter.status,'VERIFIED');
  assert.equal(after.fields.pipeId.status,'MISSING');
  assert.equal(after.steadyState,'NOT_READY');
  assert.equal(after.baseline,'NOT_READY');
  sql.close();
});
test('draft model registration requires an exact existing GIS DMA, preserving its canonical name',async()=>{
  const {sql,db}=fixture(false);
  const invalid=await request('registerHydraulicDraftModel',db,author,{confirm:true,dma:'Not a DMA'});
  assert.equal(invalid.status,409);
  sql.prepare(`INSERT INTO pipe_network_imports(import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count)
    VALUES(?,?,?,?,?,?)`).run('I1','kml','sha','inputs',1,1);
  sql.prepare(`INSERT INTO pipe_network_segments(import_id,segment_key,asset_num,geometry_json,geometry_sha256,length_m,
    min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('I1','S1','P1','{"type":"LineString","coordinates":[[101,2],[101.001,2]]}','g',100,101,2,101.001,2);
  sql.prepare(`INSERT INTO pipe_network_zone_lines(import_id,zone_name,segment_key,part_index,asset_num,geometry_json,
    length_m,min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('I1','300mm Bukit Kuau lama','S1',0,'P1',
      '{"type":"LineString","coordinates":[[101,2],[101.001,2]]}',100,101,2,101.001,2);
  sql.prepare('INSERT INTO pipe_network_active(singleton,import_id) VALUES(1,?)').run('I1');
  const response=await request('registerHydraulicDraftModel',db,author,{confirm:true,dma:'300mm Bukit Kuau Lama'});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.dma,'300mm Bukit Kuau lama');
  assert.equal(body.validationStatus,'NOT_READY');
  assert.equal(sql.prepare('SELECT zone_name FROM hydraulic_models').get().zone_name,'300mm Bukit Kuau lama');
  assert.equal((await request('registerHydraulicDraftModel',db,author,{confirm:true})).status,409);
  sql.close();
});
test('Auto-Fill previews trusted GIS and asset evidence without writing or inventing engineering data',async()=>{
  const {sql,db}=fixture();
  sql.exec(`CREATE TABLE water_assets_unique(asset_num TEXT,size REAL,length REAL,source_file TEXT)`);
  sql.exec(`CREATE TABLE dma_telemetry(district_metered_area TEXT,sensor_id TEXT,parameter TEXT,quality_status TEXT,source TEXT)`);
  sql.prepare(`INSERT INTO pipe_network_imports(import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count)
    VALUES(?,?,?,?,?,?)`).run('I1','kml','sha','inputs',2,2);
  sql.prepare(`INSERT INTO pipe_network_active(singleton,import_id) VALUES(1,?)`).run('I1');
  for(const [key,id,size,length] of [['S1','P1',300,60],['S2','P1',300,40]]){
    sql.prepare(`INSERT INTO pipe_network_segments(import_id,segment_key,asset_num,size_mm,geometry_json,geometry_sha256,length_m,
      min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('I1',key,id,size,'{}','g',length,101,2,101.001,2);
    sql.prepare(`INSERT INTO pipe_network_zone_lines(import_id,zone_name,segment_key,part_index,asset_num,geometry_json,
      length_m,min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('I1','300mm Bukit Kuau Lama',key,0,id,'{}',length,101,2,101.001,2);
  }
  sql.prepare(`INSERT INTO water_assets_unique VALUES(?,?,?,?)`).run('P1',300,99,'300mm Bukit Kuau Lama.csv');
  const response=await request('autoFillHydraulicPreview',db,author);
  assert.equal(response.status,200);
  const data=(await response.json()).autoFill;
  assert.equal(data.summary.pipeIdsFound,1);
  assert.equal(data.summary.diametersFound,1);
  assert.equal(data.summary.gisLengthsFound,1);
  assert.equal(data.summary.gisParts,2);
  assert.equal(data.summary.reviewedHazenCFound,0);
  assert.equal(data.candidates.length,3);
  const length=data.candidates.find(row=>row.parameter==='length_m');
  assert.equal(length.value,'100');
  assert.equal(length.classification,'ASSUMED');
  assert.match(length.source_ref,/^GEOMETRY_DERIVED:/);
  assert.equal(length.effective_at,'');
  assert.equal(data.candidates.some(row=>row.parameter==='hazen_c'||row.parameter==='from_node_id'),false);
  assert.deepEqual(data.mapIssues[0].issueCodes,
    ['ENGINEERING_LENGTH_UNREVIEWED','ROUGHNESS_UNREVIEWED','TOPOLOGY_UNRESOLVED']);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hydraulic_parameter_reviews').get().n,0);
  sql.close();
});
test('Auto-Fill protects existing approved parameters and reports diameter mismatch',async()=>{
  const {sql,db}=fixture();
  sql.exec(`CREATE TABLE water_assets_unique(asset_num TEXT,size REAL,length REAL,source_file TEXT)`);
  sql.exec(`CREATE TABLE dma_telemetry(district_metered_area TEXT,sensor_id TEXT,parameter TEXT,quality_status TEXT,source TEXT)`);
  sql.prepare(`INSERT INTO pipe_network_imports(import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count)
    VALUES(?,?,?,?,?,?)`).run('I1','kml','sha','inputs',1,1);
  sql.prepare(`INSERT INTO pipe_network_active(singleton,import_id) VALUES(1,?)`).run('I1');
  sql.prepare(`INSERT INTO pipe_network_segments(import_id,segment_key,asset_num,size_mm,geometry_json,geometry_sha256,length_m,
    min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('I1','S1','P1',250,'{}','g',50,101,2,101.001,2);
  sql.prepare(`INSERT INTO pipe_network_zone_lines(import_id,zone_name,segment_key,part_index,asset_num,geometry_json,
    length_m,min_lng,min_lat,max_lng,max_lat) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('I1','300mm Bukit Kuau Lama','S1',0,'P1','{}',50,101,2,101.001,2);
  sql.prepare(`INSERT INTO water_assets_unique VALUES(?,?,?,?)`).run('P1',300,50,'300mm Bukit Kuau Lama.csv');
  sql.prepare(`INSERT INTO hydraulic_parameter_reviews(entry_id,model_id,version,entity_type,entity_id,parameter_name,
    value_text,unit,classification,source_ref,effective_at,entered_by,review_status,reviewed_by,reviewed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('APPROVED-1','SAINS-BUKIT-KUAU-LAMA',1,'PIPE','P1','pipe_id',
      'P1','TEXT','VERIFIED','ASSET:source','2026-09-01T00:00:00Z','engineer-a','APPROVED','engineer-b','2026-09-02T00:00:00Z');
  const data=(await (await request('autoFillHydraulicPreview',db,author)).json()).autoFill;
  assert.equal(data.conflictCount,1);
  assert.equal(data.alreadyReviewedCount,1);
  assert.ok(data.mapIssues[0].issueCodes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT'));
  assert.equal(data.candidates.some(row=>row.parameter==='pipe_id'||row.parameter==='diameter_mm'),false);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM hydraulic_parameter_reviews').get().n,1);
  sql.close();
});
