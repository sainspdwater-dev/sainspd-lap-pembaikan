// Explicit non-operational staging gateway. Production has no staging variables.
const TEST_MODEL='TEST-REFERENCE-LOOP';
const json=(body,headers,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json','Cache-Control':'no-store'}});
const localHost=host=>host==='localhost'||host==='127.0.0.1';

export function stagingEnabled(env,request){
  const host=new URL(request.url).hostname;
  return env.HYDRAULIC_STAGING_MODE==='TEST_ONLY' &&
    (localHost(host)||(env.HYDRAULIC_STAGING_HOST && host===env.HYDRAULIC_STAGING_HOST && host!=='laporanpembaikan.sainspdwater.workers.dev'));
}

function validateScenario(value){
  if(value===null||value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Senario ujian tidak sah.');
  const keys=Object.keys(value).sort().join(',');
  if(value.type==='PIPE_CLOSED'&&['P1','P2','P3'].includes(value.targetId)&&keys==='targetId,type')return value;
  if(value.type==='DEMAND_CHANGE'&&['J1','J2'].includes(value.targetId)&&keys==='factor,targetId,type'&&
    typeof value.factor==='number'&&Number.isFinite(value.factor)&&value.factor>=0&&value.factor<=3)return value;
  if(value.type==='SOURCE_HEAD_CHANGE'&&value.targetId==='R'&&keys==='headM,targetId,type'&&
    typeof value.headM==='number'&&Number.isFinite(value.headM)&&value.headM>=0&&value.headM<=200)return value;
  throw new Error('Jenis, sasaran atau nilai senario di luar had ujian.');
}

async function serviceCall(env,user,path,{method='GET',body=null,correlationId}={}){
  if(!env.HYDRAULIC_SERVICE_TOKEN||String(env.HYDRAULIC_SERVICE_TOKEN).length<32)throw new Error('SERVICE_UNAVAILABLE');
  const target=env.HYDRAULIC_SIM_SERVICE ? `https://staging.internal${path}` : `${env.HYDRAULIC_SERVICE_URL||''}${path}`;
  if(!env.HYDRAULIC_SIM_SERVICE && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.HYDRAULIC_SERVICE_URL||''))
    throw new Error('SERVICE_UNAVAILABLE');
  const username=String(user.username||'');
  if(!/^[A-Za-z0-9_.@-]{1,100}$/.test(username))throw new Error('INVALID_REQUESTER');
  const headers={'X-Sains-Simulation-Token':env.HYDRAULIC_SERVICE_TOKEN,'X-Requester':username,
    'X-Correlation-ID':correlationId||crypto.randomUUID(),'Content-Type':'application/json'};
  // A sleeping Cloudflare Container may need a cold start for its health check.
  const options={method,headers,signal:AbortSignal.timeout(path==='/v1/health'?60000:15000)};
  if(body)options.body=JSON.stringify(body);
  const response=await (env.HYDRAULIC_SIM_SERVICE ? env.HYDRAULIC_SIM_SERVICE.fetch(new Request(target,options)) : fetch(target,options));
  if(Number(response.headers.get('Content-Length')||0)>1_048_576)throw new Error('OUTPUT_LIMIT');
  const raw=await response.text();
  if(raw.length>1_048_576)throw new Error('OUTPUT_LIMIT');
  let payload;
  try{payload=JSON.parse(raw);}catch{throw new Error('SERVICE_INVALID_RESPONSE');}
  return {code:response.status,payload};
}

function safeJob(job){
  if(!job||!['QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED'].includes(job.status))throw new Error('SERVICE_INVALID_RESPONSE');
  return {id:job.id,status:job.status,modelId:job.model_id,modelVersion:job.model_version,
    createdAt:job.created_at,startedAt:job.started_at,completedAt:job.completed_at,
    queueDelayMs:job.queue_delay_ms,solverDurationMs:job.solver_duration_ms,persistenceDurationMs:job.persistence_duration_ms,
    engineVersion:job.engine_version,summary:job.summary||null,warnings:job.warnings||[],
    errorCode:job.error_code||null,errorMessage:job.error_message||null,
    result:job.status==='COMPLETED'?job.result:null,
    geojson:job.status==='COMPLETED'?job.geojson:null};
}

export async function handleStagingHydraulicAction({action,data,env,user,headers,request}){
  const actions=new Set(['getTestHydraulicHealth','startTestHydraulicJob','getTestHydraulicJob']);
  const prompt=String(data.prompt||'').toLowerCase().trim();
  const testAi=action==='aiAgent'&&(/test hydraulic baseline|reference model|sains production simulation|where is the leak/.test(prompt));
  if(!actions.has(action)&&!testAi)return null;
  if(!stagingEnabled(env,request))return json({status:'error',message:'Staging test mode is disabled.'},headers,404);
  if(user?.level!=='ADMIN')return json({status:'error',message:'ADMIN sahaja.'},headers,403);
  if(JSON.stringify(data).length>8192)return json({status:'error',message:'Permintaan ujian terlalu besar.'},headers,413);
  const correlationId=crypto.randomUUID();
  try{
    if(testAi&&/sains production simulation|where is the leak/.test(prompt))
      return json({status:'success',answer:'Simulasi SAINS dan lokalisasi kebocoran tidak tersedia: model operasi NOT READY. Tiada keputusan hidraulik dihasilkan.',
        hydraulic:{modelType:'SAINS',modelStatus:'NOT_READY',simulationEnabled:false}},headers);
    if(action==='getTestHydraulicHealth'){
      const {code,payload}=await serviceCall(env,user,'/v1/health',{correlationId});
      if(code!==200)throw new Error('SERVICE_UNAVAILABLE');
      return json({status:'success',service:payload,modelType:'TEST MODEL',sainsModelStatus:'NOT_READY'},headers);
    }
    if(action==='startTestHydraulicJob'||(testAi&&/test hydraulic baseline/.test(prompt))){
      if(data.modelId&&data.modelId!==TEST_MODEL)throw new Error('Hanya model rujukan TEST dibenarkan.');
      const scenario=validateScenario(data.scenario);
      const {code,payload}=await serviceCall(env,user,'/v1/jobs',{method:'POST',body:{modelId:TEST_MODEL,scenario,settings:{durationSeconds:0}},correlationId});
      if(code!==202||!payload.job?.jobId)throw new Error(code===429?'Had job ujian tercapai.':'SERVICE_UNAVAILABLE');
      console.log(JSON.stringify({event:'hydraulic_staging_submit',correlationId,jobId:payload.job.jobId,reused:payload.job.reused}));
      const response={status:'success',job:payload.job,modelType:'TEST MODEL',sainsModelStatus:'NOT_READY'};
      if(testAi)response.answer=`TEST MODEL sahaja: job ${payload.job.jobId} ${payload.job.status}. Model SAINS kekal NOT READY.`;
      return json(response,headers,202);
    }
    const id=action==='getTestHydraulicJob'?String(data.jobId||''):null;
    if(id&&!/^[0-9a-f-]{36}$/.test(id))throw new Error('Job ID tidak sah.');
    const path=id?`/v1/jobs/${id}`:'/v1/jobs/latest';
    const {code,payload}=await serviceCall(env,user,path,{correlationId});
    if(code===404)return json({status:'error',message:'Tiada keputusan model rujukan lagi.'},headers,404);
    if(code===403)return json({status:'error',message:'Akses job ditolak.'},headers,403);
    if(code!==200)throw new Error('SERVICE_UNAVAILABLE');
    const job=safeJob(payload.job);
    const response={status:'success',job,modelType:'TEST MODEL',sainsModelStatus:'NOT_READY'};
    if(testAi){
      if(job.status==='COMPLETED')response.answer=`TEST MODEL / UNCALIBRATED: tekanan minimum model rujukan ${job.summary.minimumPressureM.toFixed(3)} m. Ini bukan tekanan rangkaian SAINS.`;
      else response.answer=`TEST MODEL: job ${job.id} ${job.status}. Tiada nilai tekanan akhir tersedia.`;
    }
    return json(response,headers);
  }catch(error){
    const clientError=!['SERVICE_UNAVAILABLE','SERVICE_INVALID_RESPONSE','OUTPUT_LIMIT','INVALID_REQUESTER','TimeoutError'].includes(error.message)&&
      !/fetch|network|abort/i.test(error.message);
    console.log(JSON.stringify({event:'hydraulic_staging_error',correlationId,errorType:error.name}));
    return json({status:'error',message:clientError?error.message:'Simulation Failed: servis ujian tidak tersedia atau respons tidak sah.'},headers,clientError?400:503);
  }
}
