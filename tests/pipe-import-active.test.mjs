import test from 'node:test';
import assert from 'node:assert/strict';
import {handlePipeNetworkRequest} from '../worker/worker.js';

const request=method=>new Request('https://worker.example/api/pipe-import-active',{method});
const db={prepare(sql){
  if(sql.includes('pipe_network_active'))return {first:async()=>({import_id:'active-1'})};
  if(sql.includes('pipe_network_imports'))return {bind:()=>({first:async()=>({
    source_name:'PDS_PIPE.kml',source_sha256:'a'.repeat(64),line_count:4203,
    zone_line_count:5000,created_at:'2026-09-27T00:00:00Z'})})};
  throw new Error('Unexpected query');
}};

test('active import metadata is ADMIN-only and contains no geometry',async()=>{
  const denied=await handlePipeNetworkRequest(request('GET'),{DB:db},{level:'GUEST'},{});
  assert.equal(denied.status,403);
  const allowed=await handlePipeNetworkRequest(request('GET'),{DB:db},{level:'ADMIN'},{});
  assert.equal(allowed.status,200);
  const result=await allowed.json();
  assert.equal(result.active.importId,'active-1');
  assert.equal(result.active.sourceSha256,'a'.repeat(64));
  assert.equal(JSON.stringify(result).includes('geometry'),false);
});

test('import metadata endpoint rejects writes',async()=>{
  const result=await handlePipeNetworkRequest(request('POST'),{DB:db},{level:'ADMIN'},{});
  assert.equal(result.status,405);
});
