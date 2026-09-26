// Small, lazy TEST MODEL layer in the existing AI Leaflet map. Never active on production host.
(() => {
  const hosted=location.hostname==='sains-hydraulic-gateway-staging.sainspdwater.workers.dev';
  const staging=(hosted||location.hostname==='localhost'||location.hostname==='127.0.0.1')&&
    new URLSearchParams(location.search).get('hydraulicStaging')==='1';
  if(!staging)return;
  const $=id=>document.getElementById(id);
  let layer=null,shown=false,geojson=null,previousView=null,pollTimer=null;
  const endpoint=hosted?`${location.origin}/`:'http://127.0.0.1:8787/';
  const setStatus=(id,value)=>{const element=$(id);if(element)element.textContent=value;};
  const failure=message=>/^Simulation Failed:/i.test(message)?message:`Simulation Failed: ${message}`;
  async function call(action,extra={}){
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',
      'Authorization':`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify({action,...extra})});
    const data=await response.json();
    if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
    return data;
  }
  function clearLayer(){
    if(layer&&typeof aiAgentMap!=='undefined'&&aiAgentMap)aiAgentMap.removeLayer(layer);
    layer=null;shown=false;
    $('ai-test-layer-toggle').textContent='Show TEST layer';
    if(previousView&&typeof aiAgentMap!=='undefined'&&aiAgentMap){aiAgentMap.setView(previousView.center,previousView.zoom);previousView=null;}
  }
  function toggleLayer(){
    if(shown){clearLayer();return;}
    if(!geojson||!window.L)return;
    if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
    if(!aiAgentMap)return;
    previousView={center:aiAgentMap.getCenter(),zoom:aiAgentMap.getZoom()};
    layer=L.geoJSON(geojson,{style:{color:'#d97706',weight:4,dashArray:'6,4'},
      pointToLayer:(feature,latlng)=>L.circleMarker(latlng,{radius:8,color:'#7c3aed',fillColor:'#f59e0b',fillOpacity:0.9}),
      onEachFeature:(feature,item)=>{
        const panel=document.createElement('div');
        const title=document.createElement('strong');title.textContent=`TEST MODEL · ${feature.properties.kind} ${feature.properties.id}`;
        panel.append(title);
        for(const [key,value] of Object.entries(feature.properties)){
          if(key==='kind'||key==='id')continue;
          const row=document.createElement('div');row.textContent=`${key}: ${value}`;panel.append(row);
        }
        item.bindPopup(panel);
      }}).addTo(aiAgentMap);
    const bounds=layer.getBounds();if(bounds.isValid())aiAgentMap.fitBounds(bounds.pad(0.3),{maxZoom:14});
    shown=true;$('ai-test-layer-toggle').textContent='Hide TEST layer';
  }
  function renderJob(job){
    setStatus('ai-test-job-status',job.status);
    $('ai-test-restart-now').disabled=!(job.status==='RUNNING'&&job.testFault==='RESTART_WAIT_TEST_ONLY'&&job.attempts===1&&!job.restartRequestedAt);
    if(job.status==='COMPLETED'){
      geojson=job.geojson;
      const summary=job.summary||{};
      setStatus('ai-test-result',`TEST MODEL / UNCALIBRATED · Minimum pressure ${Number(summary.minimumPressureM).toFixed(3)} m · ${job.engineVersion}. Bukan keputusan SAINS.`);
      $('ai-test-layer-toggle').disabled=!geojson;
      if(shown){clearLayer();toggleLayer();}
    }else if(job.status==='FAILED'||job.status==='CANCELLED'){
      geojson=null;clearLayer();$('ai-test-layer-toggle').disabled=true;
      setStatus('ai-test-result',`Simulation Failed: ${job.errorCode||'Unknown error'}. ${job.errorMessage||'Tiada keputusan hidraulik dihasilkan.'} Tiada GeoJSON atau keputusan hidraulik.`);
    }else setStatus('ai-test-result','Menunggu simulasi model contoh; tiada keputusan SAINS.');
  }
  async function poll(jobId,rateRetries=0){
    try{
      const data=await call('getTestHydraulicJob',{jobId});
      renderJob(data.job);
      if(['QUEUED','RUNNING'].includes(data.job.status))pollTimer=setTimeout(()=>poll(jobId),2000);
    }catch(error){
      if(/rate limit|had permintaan/i.test(error.message)&&rateRetries<20){
        setStatus('ai-test-result','TEST MODEL: had semakan sementara; mencuba semula tanpa mengubah status job.');
        pollTimer=setTimeout(()=>poll(jobId,rateRetries+1),5000);
        return;
      }
      setStatus('ai-test-service','UNAVAILABLE');setStatus('ai-test-result',failure(error.message));
    }
  }
  async function start(testFault,scenario){
    $('ai-test-run').disabled=true;clearTimeout(pollTimer);clearLayer();geojson=null;
    try{
      const data=await call('startTestHydraulicJob',{modelId:'TEST-REFERENCE-LOOP',
        ...(testFault?{testFault}:{}),...(scenario?{scenario}:{})});
      localStorage.setItem('sainsStagingHydraulicJob',data.job.jobId);
      setStatus('ai-test-job-status',data.job.status);
      await poll(data.job.jobId);
    }catch(error){setStatus('ai-test-job-status','FAILED');setStatus('ai-test-service','UNAVAILABLE');setStatus('ai-test-result',failure(error.message));}
    finally{$('ai-test-run').disabled=false;}
  }
  async function restartContainer(){
    const jobId=localStorage.getItem('sainsStagingHydraulicJob');
    if(!jobId)return;
    $('ai-test-restart-now').disabled=true;
    try{
      await call('restartTestHydraulicContainer',{jobId});
      setStatus('ai-test-result','TEST ONLY: Container interrupted while RUNNING; waiting for durable-state recovery.');
    }catch(error){setStatus('ai-test-result',failure(error.message));}
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN')return;
    $('ai-hydraulic-staging')?.classList.remove('hidden');
    $('ai-test-run')?.addEventListener('click',()=>start());
    $('ai-test-head-scenario')?.addEventListener('click',()=>start(null,{type:'SOURCE_HEAD_CHANGE',targetId:'R',headM:113}));
    $('ai-test-timeout')?.addEventListener('click',()=>start('TIMEOUT_TEST_ONLY'));
    $('ai-test-restart-run')?.addEventListener('click',()=>start('RESTART_WAIT_TEST_ONLY'));
    $('ai-test-restart-now')?.addEventListener('click',restartContainer);
    $('ai-test-layer-toggle')?.addEventListener('click',toggleLayer);
    try{const data=await call('getTestHydraulicHealth');
      setStatus('ai-test-engine',data.service.engineVersion?'READY':'ERROR');setStatus('ai-test-service','CONNECTED');
    }catch{setStatus('ai-test-engine','ERROR');setStatus('ai-test-service','UNAVAILABLE');}
    const id=localStorage.getItem('sainsStagingHydraulicJob');
    if(id)poll(id);
  });
})();
