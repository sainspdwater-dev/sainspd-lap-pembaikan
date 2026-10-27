import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePipeCandidateAction} from '../worker/pipe-candidate-intake.js';
import {handlePipeMapAction,handlePipeMapRead} from '../worker/pipe-map-versions.js';

function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0003_pipe_network.sql','0007_pipe_candidate_drafts.sql','0014_pipe_map_versions.sql'])
    sql.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  sql.prepare(`INSERT INTO pipe_network_imports
    (import_id,source_name,source_sha256,inputs_sha256,line_count,zone_line_count)
    VALUES('old-assets','assets.kml','old','old',1,1)`).run();
  sql.prepare(`INSERT INTO pipe_network_segments
    (import_id,segment_key,geometry_json,geometry_sha256,length_m,min_lng,min_lat,max_lng,max_lat)
    VALUES('old-assets','s1','{}','old',10,101,2,102,3)`).run();
  sql.prepare(`INSERT INTO pipe_network_zone_lines
    (import_id,zone_name,segment_key,part_index,asset_num,geometry_json,length_m,min_lng,min_lat,max_lng,max_lat)
    VALUES('old-assets','DMA A','s1',0,'OLD','{}',10,101,2,102,3)`).run();
  sql.prepare("INSERT INTO pipe_network_active(singleton,import_id) VALUES(1,'old-assets')").run();
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
const activate=(db,data,user=admin)=>handlePipeMapAction({action:'activatePipeMapDraft',data,
  env:{DB:db},user,headers:{}});
const read=(db,path,user=admin)=>handlePipeMapRead(new Request(`https://example.test${path}`),{DB:db},user,{});
async function staged(db,letter){
  const opened=await (await call(db,'beginPipeCandidateDraft',{sourceName:`${letter}.kml`,
    sourceSha256:letter.repeat(64),polygonSha256:'b'.repeat(64),sourceLines:1,
    expectedParts:1,outsideLines:0,multiDmaLines:0,invalidGeometry:0,confirmDraft:true})).json();
  await call(db,'appendPipeCandidateParts',{batchId:opened.batchId,parts:[{rowNumber:0,
    zoneName:'DMA A',kmlId:`KML-${letter}`,diameterMm:300,
    geometry:{type:'LineString',coordinates:[[101.1,2.1],[101.2,2.2]]}}]});
  await call(db,'finalizePipeCandidateDraft',{batchId:opened.batchId});
  return opened.batchId;
}

test('confirmed KML replacement switches display pointer but preserves assets and polygon source',async()=>{
  const {sql,db}=fixture(),first=await staged(db,'a');
  assert.equal((await (await read(db,'/api/pipe-map-active')).json()).active,null);
  const changed=await (await activate(db,{batchId:first,expectedActiveImportId:'',confirmReplace:true})).json();
  assert.equal(changed.status,'success');assert.equal(changed.displayOnly,true);
  assert.equal(sql.prepare('SELECT import_id FROM pipe_network_active').get().import_id,'old-assets');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').get().n,1);
  const map=await (await read(db,'/api/pipe-lines?zone=DMA%20A')).json();
  assert.equal(map.features[0].properties.asset_num,'KML-a');
  assert.equal(map.features[0].properties.review_status,'UNVERIFIED');
  const bbox=await (await read(db,'/api/pipe-lines?bbox=101,2,102,3')).json();
  assert.equal(bbox.features.length,1);
  const second=await staged(db,'c');
  const swapped=await (await activate(db,{batchId:second,expectedActiveImportId:first,confirmReplace:true})).json();
  assert.equal(swapped.previousImportId,first);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_map_imports').get().n,2);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_map_lines').get().n,2);
  assert.equal((await (await read(db,'/api/pipe-lines?zone=DMA%20A')).json()).features[0].properties.asset_num,'KML-c');
  sql.close();
});

test('unauthorized, incomplete, and stale confirmation never replace visible version',async()=>{
  const {sql,db}=fixture(),first=await staged(db,'a');
  assert.equal((await activate(db,{batchId:first,confirmReplace:true},{level:'GUEST',username:'g'})).status,403);
  assert.equal((await activate(db,{batchId:first,confirmReplace:false})).status,400);
  assert.equal((await activate(db,{batchId:first,expectedActiveImportId:'wrong',confirmReplace:true})).status,409);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM pipe_map_active').get().n,0);
  await activate(db,{batchId:first,expectedActiveImportId:'',confirmReplace:true});
  const second=await staged(db,'c');
  assert.equal((await activate(db,{batchId:second,expectedActiveImportId:'',confirmReplace:true})).status,409);
  assert.equal(sql.prepare('SELECT import_id FROM pipe_map_active').get().import_id,first);
  assert.equal((await read(db,'/api/pipe-map-active',{level:'GUEST',username:'g'})).status,403);
  sql.close();
});
