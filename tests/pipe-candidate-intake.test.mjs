import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePipeCandidateAction} from '../worker/pipe-candidate-intake.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0003_pipe_network.sql','0007_pipe_candidate_drafts.sql'])
    sql.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  sql.prepare(`INSERT INTO pipe_network_imports
    (import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count)
    VALUES('active-1','old.kml','old','old',1,1)`).run();
  sql.prepare(`INSERT INTO pipe_network_segments
    (import_id,segment_key,geometry_json,geometry_sha256,length_m,min_lng,min_lat,max_lng,max_lat)
    VALUES('active-1','s-1','{}','old',10,101,2,102,3)`).run();
  sql.prepare(`INSERT INTO pipe_network_zone_lines
    (import_id,zone_name,segment_key,part_index,asset_num,geometry_json,length_m,min_lng,min_lat,max_lng,max_lat)
    VALUES('active-1','DMA A','s-1',0,'P-OLD','{}',10,101,2,102,3)`).run();
  sql.prepare("INSERT INTO pipe_network_active(singleton,import_id) VALUES(1,'active-1')").run();
  const db={prepare(query){const stmt=sql.prepare(query);return {
    bind(...args){return {first:async()=>stmt.get(...args)||null,
      all:async()=>({results:stmt.all(...args)}),run:async()=>stmt.run(...args)};},
    first:async()=>stmt.get()||null,all:async()=>({results:stmt.all()}),run:async()=>stmt.run()
  };},async batch(statements){sql.exec('BEGIN');try{
    for(const statement of statements)await statement.run();sql.exec('COMMIT');
  }catch(error){sql.exec('ROLLBACK');throw error;}}};
  return {sql,db};
}
const admin={level:'ADMIN',username:'engineer-a'};
const call=(db,action,data={},user=admin)=>handlePipeCandidateAction({action,data,env:{DB:db},user,headers:{}});
const start={sourceName:'new.kml',sourceSha256:'a'.repeat(64),polygonSha256:'b'.repeat(64),
  sourceLines:2,expectedParts:2,outsideLines:0,multiDmaLines:0,invalidGeometry:0,confirmDraft:true};
const part=(rowNumber,x)=>({rowNumber,zoneName:'DMA A',kmlId:`KML-${rowNumber}`,diameterMm:300,
  geometry:{type:'LineString',coordinates:[[101+x,2],[101.001+x,2.001]]}});

test('ADMIN stages clipped candidates in D1 without changing active GIS',async()=>{
  const {sql,db}=fixture();
  const opened=await (await call(db,'beginPipeCandidateDraft',start)).json();
  assert.equal(opened.reviewStatus,'DRAFT');assert.equal(opened.activeChanged,false);
  const reused=await (await call(db,'beginPipeCandidateDraft',start)).json();
  assert.equal(reused.batchId,opened.batchId);assert.equal(reused.reused,true);
  assert.equal((await call(db,'beginPipeCandidateDraft',{...start,outsideLines:1})).status,409);
  const batchId=opened.batchId;
  const first=await (await call(db,'appendPipeCandidateParts',{batchId,parts:[part(0,0)]})).json();
  assert.equal(first.saved,1);
  const retry=await (await call(db,'appendPipeCandidateParts',{batchId,parts:[part(0,0)]})).json();
  assert.equal(retry.reused,1);assert.equal(retry.saved,0);
  assert.equal((await call(db,'appendPipeCandidateParts',{batchId,parts:[part(0,0.01)]})).status,409);
  assert.equal((await call(db,'finalizePipeCandidateDraft',{batchId})).status,409);
  assert.equal((await call(db,'appendPipeCandidateParts',{batchId,parts:[part(1,0.002)]})).status,200);
  const closed=await (await call(db,'finalizePipeCandidateDraft',{batchId})).json();
  assert.equal(closed.reviewStatus,'REVIEW_REQUIRED');assert.equal(closed.activeChanged,false);
  assert.equal((await call(db,'appendPipeCandidateParts',{batchId,parts:[part(1,0.002)]})).status,409);
  const status=await (await call(db,'getPipeCandidateDraft',{batchId})).json();
  assert.equal(status.storedParts,2);assert.equal(status.zones[0].zone_name,'DMA A');
  assert.equal(JSON.stringify(status).includes('coordinates'),false);
  assert.equal(sql.prepare('SELECT import_id FROM pipe_network_active WHERE singleton=1').get().import_id,'active-1');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').get().n,1);
  sql.close();
});

test('guest, staging token, unknown DMA and malformed geometry never write candidates',async()=>{
  const {sql,db}=fixture();
  assert.equal((await call(db,'beginPipeCandidateDraft',start,{level:'GUEST',username:'guest'})).status,403);
  assert.equal((await call(db,'beginPipeCandidateDraft',start,{...admin,purpose:'HYDRAULIC_STAGING_TEST'})).status,403);
  const batchId=(await (await call(db,'beginPipeCandidateDraft',start)).json()).batchId;
  assert.equal((await call(db,'appendPipeCandidateParts',{batchId,parts:[{...part(0,0),zoneName:'OTHER'}]})).status,409);
  assert.equal((await call(db,'appendPipeCandidateParts',{batchId,parts:[{...part(0,0),geometry:{type:'Point',coordinates:[101,2]}}]})).status,400);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_candidate_parts').get().n,0);
  sql.close();
});

test('published Sunggala polygon may be staged for review without an active line',async()=>{
  const {sql,db}=fixture();
  const batchId=(await (await call(db,'beginPipeCandidateDraft',start)).json()).batchId;
  const response=await call(db,'appendPipeCandidateParts',{batchId,parts:[
    {...part(0,0),zoneName:'500mm Sunggala Boundry'}]});
  assert.equal(response.status,200);
  assert.equal(sql.prepare('SELECT zone_name FROM pipe_candidate_parts').get().zone_name,
    '500mm Sunggala Boundry');
  assert.equal(sql.prepare('SELECT import_id FROM pipe_network_active WHERE singleton=1').get().import_id,'active-1');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').get().n,1);
  sql.close();
});
