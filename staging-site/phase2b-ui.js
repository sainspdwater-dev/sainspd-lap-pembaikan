// Small production-safe status panel in the existing AI Agent; no model runs.
(() => {
  const byId=id=>document.getElementById(id);
  const refresh=async()=>{
    const host=byId('ai-hydraulic-status'),issues=byId('ai-hydraulic-issues');
    if(!host||!issues)return;
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN') {host.textContent='ADMIN sahaja.';issues.replaceChildren();return;}
    const dma=byId('ai-filter-district')?.value?.trim()||'';
    host.textContent='Menyemak status model…';issues.replaceChildren();
    try {
      const response=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('sainsToken')}`},body:JSON.stringify({action:'getHydraulicStatus',dma})});
      const data=await response.json();
      if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      const h=data.hydraulic;
      host.textContent=`${h.zone} · Model ${h.status} · EPANET ${h.engine.integration}\nGIS: ${h.gis.segmentCount} segmen, ${h.gis.missingDiameterParts} bahagian tanpa diameter. Panjang GIS adalah GEOMETRY-DERIVED, bukan panjang aset yang disahkan.\nTopology ${h.capabilities.topology}; steady-state ${h.capabilities.steadyState}; extended period ${h.capabilities.extendedPeriod}; kalibrasi ${h.capabilities.calibration}.\nData operasi: CSV/manual snapshot; data ujian Phase 2A tidak digunakan.`;
      for(const item of h.issues){const li=document.createElement('li');li.textContent=`${item.severity}: ${item.detail}`;issues.append(li);}
    }catch(error){host.textContent=`Status model gagal disemak: ${error.message}. Simulasi tidak dijalankan.`;}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    byId('ai-hydraulic-refresh')?.addEventListener('click',refresh);
    byId('ai-filter-district')?.addEventListener('change',refresh);
  });
})();
