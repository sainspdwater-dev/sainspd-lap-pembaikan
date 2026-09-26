import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {handleStagingHydraulicAction} from '../worker/hydraulic-staging.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const python=join(root,'.phase2b-venv','Scripts','python.exe');
const serverScript=join(root,'hydraulic_service','staging_server.py');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function freePort(){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function startServer({port,token,database}){
  const child=spawn(python,[serverScript],{cwd:root,windowsHide:true,
    env:{...process.env,SAINS_STAGING_ENV:'STAGING',SAINS_STAGING_SERVICE_TOKEN:token,
      SAINS_STAGING_DB:database,SAINS_STAGING_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk.toString();});child.stderr.on('data',chunk=>{output+=chunk.toString();});
  return {child,get output(){return output;}};
}
async function ready(port,token,server){
  for(let i=0;i<200;i++){
    if(server.child.exitCode!==null)throw new Error(`staging service exited before health check: ${server.output.slice(-600)}`);
    try{const result=await fetch(`http://127.0.0.1:${port}/v1/health`,{headers:{'X-Sains-Simulation-Token':token}});
      if(result.ok)return;}
    catch{}
    await delay(100);
  }
  throw new Error(`staging service did not become healthy: ${server.output.slice(-600)}`);
}
async function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();
  await Promise.race([exit,delay(5000)]);
}

test('local staging Worker gateway → authenticated Python service → EPANET → persisted result', {timeout:120000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'sains-phase2bs-'));
  const port=await freePort();const token=randomBytes(32).toString('hex');
  const database=join(directory,'test-jobs.sqlite');
  const env={HYDRAULIC_STAGING_MODE:'TEST_ONLY',HYDRAULIC_SERVICE_URL:`http://127.0.0.1:${port}`,
    HYDRAULIC_SERVICE_TOKEN:token};
  const request=new Request('http://127.0.0.1:8787/');
  const user={level:'ADMIN',username:'phase2bs-admin'};
  const call=async(action,data={},overrides={})=>{
    const response=await handleStagingHydraulicAction({action,data,env:{...env,...overrides.env},
      user:overrides.user||user,headers:{},request:overrides.request||request});
    return {code:response.status,body:await response.json()};
  };
  let server=startServer({port,token,database});
  try{
    await ready(port,token,server);
    const noServiceAuth=await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(noServiceAuth.status,401);
    assert.equal((await call('getTestHydraulicHealth')).body.service.status,'CONNECTED');
    assert.equal((await call('getTestHydraulicHealth',{}, {user:{level:'GUEST',username:'guest'}})).code,403);
    assert.equal((await call('getTestHydraulicHealth',{}, {env:{HYDRAULIC_STAGING_MODE:'OFF'}})).code,404);
    assert.equal((await call('startTestHydraulicJob',{modelId:'SAINS-REAL'})).code,400);
    assert.equal((await call('startTestHydraulicJob',{scenario:{type:'DEMAND_CHANGE',targetId:'J1',factor:100}})).code,400);
    assert.equal((await call('startTestHydraulicJob',{junk:'x'.repeat(9000)})).code,413);
    const started=await call('startTestHydraulicJob',{modelId:'TEST-REFERENCE-LOOP'});
    assert.equal(started.code,202);assert.equal(started.body.modelType,'TEST MODEL');
    const id=started.body.job.jobId;
    assert.match(id,/^[0-9a-f-]{36}$/);
    const duplicate=await call('startTestHydraulicJob',{modelId:'TEST-REFERENCE-LOOP'});
    assert.equal(duplicate.body.job.jobId,id);assert.equal(duplicate.body.job.reused,true);
    let completed;
    for(let i=0;i<70;i++){
      completed=await call('getTestHydraulicJob',{jobId:id});
      if(completed.body.job.status==='COMPLETED')break;
      await delay(200);
    }
    assert.equal(completed.body.job.status,'COMPLETED');
    const job=completed.body.job;
    assert.equal(job.modelId,'TEST-REFERENCE-LOOP');
    assert.equal(job.engineVersion,'EPANET 2.2.0');
    assert.ok(Math.abs(job.summary.minimumPressureM-74.59948)<0.03);
    assert.ok(Math.abs(job.result.nodes.J1.headM-99.55843)<0.03);
    assert.ok(Math.abs(job.result.links.P3.flowM3s-0.0075158)<0.0001);
    assert.ok(Math.abs(job.result.links.P3.velocityMs-0.239235)<0.03);
    assert.ok(Math.abs(job.result.links.P3.headlossMperM-0.000445)<0.0001);
    assert.equal(job.geojson.features.length,5);
    assert.ok(job.geojson.features.every(f=>f.properties.kind.startsWith('TEST_')));
    const other=await call('getTestHydraulicJob',{jobId:id},{user:{level:'ADMIN',username:'different-admin'}});
    assert.equal(other.code,403); // service owner check fails closed; gateway does not leak result
    await stop(server.child);
    server=startServer({port,token,database});await ready(port,token,server);
    const afterRestart=await call('getTestHydraulicJob',{jobId:id});
    assert.equal(afterRestart.body.job.status,'COMPLETED');
    assert.equal(afterRestart.body.job.summary.minimumPressureM,job.summary.minimumPressureM);
    const aiReference=await call('aiAgent',{prompt:'What is minimum pressure in the reference model?'});
    assert.match(aiReference.body.answer,/TEST MODEL/);
    assert.match(aiReference.body.answer,/74\.599/);
    const aiSains=await call('aiAgent',{prompt:'Run SAINS production simulation.'});
    assert.match(aiSains.body.answer,/NOT READY/);
    const aiLeak=await call('aiAgent',{prompt:'Where is the leak?'});
    assert.match(aiLeak.body.answer,/tidak tersedia/);
    await stop(server.child);
    assert.equal((await call('getTestHydraulicHealth')).code,503);
  }finally{
    await stop(server.child);
    const prefix=resolve(tmpdir())+sep+'sains-phase2bs-';
    if(!resolve(directory).startsWith(prefix))throw new Error('Refusing unexpected temp cleanup path');
    rmSync(directory,{recursive:true,force:true});
  }
});
