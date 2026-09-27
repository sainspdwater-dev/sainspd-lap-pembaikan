// Small production-safe status panel in the existing AI Agent; no model runs.
(() => {
  const byId=id=>document.getElementById(id);
  let issueLayer=null,issueZone='',currentHydraulic=null;
  const clearIssueLayer=()=>{if(issueLayer&&typeof aiAgentMap!=='undefined'&&aiAgentMap)aiAgentMap.removeLayer(issueLayer);issueLayer=null;issueZone='';};
  const showIssues=async()=>{
    const dma=byId('ai-filter-district')?.value?.trim();if(!dma)return;
    if(issueLayer&&issueZone===dma){clearIssueLayer();return;}
    clearIssueLayer();
    try{
      const url=new URL('/api/pipe-lines',WORKER_URL);url.searchParams.set('zone',dma);url.searchParams.set('limit','500');
      const response=await fetch(url,{headers:{Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`}});
      const data=await response.json();if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      if(data.nextOffset!==null)throw new Error('Lebih 500 bahagian; paparan isu belum lengkap.');
      let issueByAsset=new Map();
      if(currentHydraulic?.modelId&&currentHydraulic?.modelVersion){
        const detail=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',
          Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify({
          action:'autoFillHydraulicPreview',dma,modelId:currentHydraulic.modelId,version:currentHydraulic.modelVersion})});
        const result=await detail.json();if(detail.ok&&result.status==='success')
          issueByAsset=new Map(result.autoFill.mapIssues.map(item=>[item.assetNum,item.issueCodes]));
      }
      const features=data.features.filter(feature=>!(Number(feature.properties?.size_mm)>0)||
        issueByAsset.has(String(feature.properties?.asset_num||'')));
      if(!features.length){byId('ai-hydraulic-status').textContent+='\nPeta: tiada diameter GIS hilang yang boleh dilokasikan. Isu lain belum mempunyai lokasi disahkan.';return;}
      if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
      const labels={PIPE_ID_UNRESOLVED:'Pipe ID belum dipadankan ke asset master',
        GIS_DIAMETER_MISSING_OR_CONFLICT:'diameter GIS/asset hilang atau bercanggah',
        ENGINEERING_LENGTH_UNREVIEWED:'engineering length belum diluluskan',
        ROUGHNESS_UNREVIEWED:'Hazen-Williams C belum diluluskan',
        TOPOLOGY_UNRESOLVED:'sambungan topologi belum diluluskan'};
      issueLayer=L.geoJSON({type:'FeatureCollection',features},{style:feature=>{
        const codes=issueByAsset.get(String(feature.properties?.asset_num||''))||[];
        return {color:!(Number(feature.properties?.size_mm)>0)||codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT')
          ?'#dc2626':codes.includes('PIPE_ID_UNRESOLVED')?'#ea580c':'#d97706',weight:6,opacity:0.9};},
        onEachFeature:(feature,layer)=>{const box=document.createElement('div');
          const codes=issueByAsset.get(String(feature.properties?.asset_num||''))||[];
          if(!(Number(feature.properties?.size_mm)>0)&&!codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT'))
            codes.unshift('GIS_DIAMETER_MISSING_OR_CONFLICT');
          box.textContent=`ISU HIDRAULIK · aset ${feature.properties.asset_num||'ID belum disahkan'} · DMA ${dma}: `+
            `${codes.map(code=>labels[code]||code).join('; ')}. Peta tidak mengesahkan topologi atau lokasi nod.`;
          layer.bindPopup(box);}}).addTo(aiAgentMap);
      issueZone=dma;const bounds=issueLayer.getBounds();if(bounds.isValid())aiAgentMap.fitBounds(bounds.pad(0.25),{maxZoom:15});
      byId('ai-hydraulic-status').textContent+='\nIsu pipe GIS yang boleh dipadankan disorot. Elevasi nod, demand dan source head tanpa lokasi model disahkan kekal dalam senarai status, bukan titik rekaan.';
    }catch(error){clearIssueLayer();byId('ai-hydraulic-status').textContent+=`\nPeta isu tidak tersedia: ${error.message}`;}
  };
  const refresh=async()=>{
    const host=byId('ai-hydraulic-status'),issues=byId('ai-hydraulic-issues'),scenarios=byId('ai-hydraulic-scenarios');
    const fields=byId('ai-hydraulic-fields'),capabilities=byId('ai-hydraulic-capabilities');
    if(!host||!issues)return;
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN') {host.textContent='ADMIN sahaja.';issues.replaceChildren();scenarios?.replaceChildren();fields?.replaceChildren();return;}
    const dma=byId('ai-filter-district')?.value?.trim()||'';
    clearIssueLayer();currentHydraulic=null;host.textContent='Menyemak status model…';issues.replaceChildren();scenarios?.replaceChildren();fields?.replaceChildren();
    capabilities.textContent='';byId('ai-run-real-baseline').disabled=true;
    byId('ai-hydraulic-issues-map').disabled=true;
    if(!dma){host.textContent='Pilih satu District Metered Area dahulu. Status seluruh rangkaian tidak boleh digunakan sebagai readiness DMA.';return;}
    if(location.hostname==='sains-hydraulic-gateway-staging.sainspdwater.workers.dev'){
      host.textContent=`${dma} · SAINS MODEL: NOT READY · staging TEST terasing daripada D1 operasi. Semakan data sebenar memerlukan akses D1 yang diluluskan. Tiada baseline atau simulasi SAINS dijalankan.`;
      const item=document.createElement('li');item.textContent='MISSING: Pipe ID, topologi fizikal, parameter dan sensor mapping perlu disahkan oleh jurutera. Pratonton entri di bawah tidak menyimpan data.';issues.append(item);
      capabilities.textContent='STEADY-STATE: NOT READY · BASELINE: NOT READY · CALIBRATION: NOT READY · PIPE FAILURE: NOT READY · VALVE ISOLATION: NOT READY · SCENARIO COMPARE: NOT READY';
      return;
    }
    try {
      const response=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('sainsToken')}`},body:JSON.stringify({action:'getHydraulicStatus',dma})});
      const data=await response.json();
      if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      const h=data.hydraulic;
      currentHydraulic=h;
      host.textContent=`${h.zone} · Model ${h.status} · EPANET ${h.engine.integration}\nGIS: ${h.gis.segmentCount} segmen zon; ${h.gis.missingDiameterParts} bahagian tanpa diameter. Segmen sumber tanpa Pipe ID belum dapat dikaitkan secara sah kepada DMA. Panjang GIS bukan panjang aset yang disahkan.`;
      for(const field of Object.values(h.fields||{})){
        const item=document.createElement('div');item.className='rounded border p-1';
        item.textContent=`${field.label}: ${field.status} — ${field.detail}`;fields.append(item);
      }
      capabilities.textContent=`STEADY-STATE: ${h.capabilities.steadyState} · BASELINE: ${h.capabilities.baseline} · CALIBRATION: ${h.capabilities.calibration} · PIPE FAILURE: ${h.scenarioCapabilities.PIPE_CLOSED?.status||'NOT_READY'} · VALVE ISOLATION: ${h.scenarioCapabilities.VALVE_ISOLATION?.status||'NOT_READY'} · SCENARIO COMPARE: ${h.scenarioCapabilities.SCENARIO_COMPARE?.status||'NOT_READY'}`;
      byId('ai-hydraulic-issues-map').disabled=!(h.gis?.segmentCount>0);
      for(const item of h.issues){const li=document.createElement('li');li.textContent=`${item.severity}: ${item.detail}`;issues.append(li);}
      for(const [name,item] of Object.entries(h.scenarioCapabilities||{})){
        const li=document.createElement('li');li.textContent=`${name}: ${item.status} — ${(item.reasons||[]).join(' ')}`;scenarios?.append(li);
      }
    }catch(error){host.textContent=`Status model gagal disemak: ${error.message}. Simulasi tidak dijalankan.`;}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    byId('ai-hydraulic-refresh')?.addEventListener('click',refresh);
    byId('ai-filter-district')?.addEventListener('change',refresh);
    byId('ai-hydraulic-issues-map')?.addEventListener('click',showIssues);
  });
  window.phase2bRefreshHydraulic=refresh;
})();
