// Small production-safe status panel in the existing AI Agent; no model runs.
(() => {
  const byId=id=>document.getElementById(id);
  let issueLayer=null,targetPipeLayer=null,issueZone='',issueKind='',selectedIssue=null,currentHydraulic=null,refreshSerial=0,issueSerial=0,targetSerial=0;
  const selectedDma=()=>byId('ai-filter-district')?.value?.trim()||'';
  const openDetails=(target)=>{
    byId('ai-hydraulic-panel').open=true;
    if(target==='intake')byId('ai-engineering-intake').open=true;
    byId(target==='intake'?'ai-engineering-intake':'ai-hydraulic-fields').scrollIntoView({behavior:'smooth',block:'nearest'});
  };
  const fieldGuides={
    pipeId:'PIPE → pipe_id. Padankan Pipe ID kepada daftar aset/as-built; ID GIS sahaja belum membuktikan sambungan hidraulik.',
    diameter:'PIPE → diameter_mm. Rujuk daftar aset atau as-built yang disahkan; bahagian tanpa diameter boleh dilihat melalui Lihat isu pada peta.',
    length:'PIPE → length_m. Masukkan panjang kejuruteraan yang disemak, bukan panjang garisan KML.',
    roughness:'PIPE → hazen_c. Gunakan nilai dan sumber yang diluluskan jurutera; angka Hazen pada borang operasi di atas bukan nilai model yang disahkan.',
    topology:'PIPE → from_node_id dan to_node_id. Kedua-dua nod serta sambungan fizikal perlu disahkan daripada lukisan/as-built atau semakan tapak.',
    elevation:'NODE → elevation_m. Rujuk aras survei atau dataset elevasi yang diluluskan.',
    demand:'NODE → base_demand_m3s. Perlu agihan permintaan kepada nod berserta kaedah/sumber yang disemak.',
    pattern:'PATTERN → multipliers_json. Perlu corak permintaan dan jadual operasi yang disemak.',
    sourceHead:'SOURCE → head_m. Rujuk paras operasi reservoir/sumber pada masa yang berkaitan dan semak unit serta datum.',
    valves:'VALVE → jenis, diameter, setting dan status mengikut inventori peralatan yang disemak. Tandakan tidak berkenaan hanya selepas pengesahan jurutera.',
    pumps:'PUMP → curve_ref dan status daripada inventori/keluk pam yang diluluskan. Sahkan tidak berkenaan jika tiada pam.',
    tanks:'TANK → aras asas, paras awal/min/maks dan diameter daripada as-built/rekod operasi yang disemak. Sahkan tidak berkenaan jika tiada tangki.',
    sensorMapping:'Pemetaan sensor ke nod/paip model memerlukan tag SCADA, lokasi dan bukti liputan yang diluluskan. Borang parameter manual di bawah tidak menggantikan proses pemetaan sensor.',
    calibration:'Pemerhatian tekanan/aliran sebenar perlu dipadankan dengan masa dan lokasi model serta disemak jurutera. Borang parameter manual di bawah bukan proses kelulusan kalibrasi.'
  };
  const goToField=key=>{
    const inputs={pipeId:['PIPE','pipe_id'],diameter:['PIPE','diameter_mm'],length:['PIPE','length_m'],
      roughness:['PIPE','hazen_c'],topology:['PIPE','from_node_id'],elevation:['NODE','elevation_m'],
      demand:['NODE','base_demand_m3s'],pattern:['PATTERN','multipliers_json'],sourceHead:['SOURCE','head_m'],
      valves:['VALVE','setting'],pumps:['PUMP','curve_ref'],tanks:['TANK','initial_level_m']};
    byId('ai-hydraulic-field-guide').textContent=fieldGuides[key]||'Semak sumber kejuruteraan dan proses kelulusan bagi data ini.';
    if(key==='sensorMapping'||key==='calibration'){
      const panel=byId('ai-monitoring-panel');
      panel.scrollIntoView({behavior:'smooth',block:'center'});
      panel.classList.add('ring-2','ring-violet-500');
      setTimeout(()=>panel.classList.remove('ring-2','ring-violet-500'),4000);
      byId('ai-pick-pressure-cp-status').textContent=fieldGuides[key]+' Bacaan/lokasi yang disimpan untuk DMA ini masih memerlukan pemetaan dan semakan model.';
      return;
    }
    if(!inputs[key]){byId('ai-hydraulic-field-guide').scrollIntoView({behavior:'smooth',block:'nearest'});return;}
    openDetails('intake');
    const [type,parameter]=inputs[key],typeControl=byId('ai-eng-entity-type');
    typeControl.value=type;typeControl.dispatchEvent(new Event('change'));
    byId('ai-eng-parameter').value=parameter;byId('ai-eng-parameter').dispatchEvent(new Event('change'));
    byId('ai-eng-report').textContent=fieldGuides[key]+' Masukkan hanya nilai sebenar bersumber; pratonton dan simpan DRAFT sebelum semakan bebas.';
    byId('ai-eng-entity-id').focus();
  };
  const issueField=(code,fields)=>{
    const direct={MISSING_DIAMETER:'diameter',PIPE_ID_MISSING_UNASSIGNED:'pipeId',PIPE_ID_MAPPING_UNVERIFIED:'pipeId',
      LENGTH_PROVENANCE_UNVERIFIED:'length',TOPOLOGY_UNVERIFIED:'topology',ROUGHNESS_MISSING:'roughness',
      ELEVATION_MISSING:'elevation',DEMAND_ALLOCATION_MISSING:'demand',SOURCE_HEAD_MISSING:'sourceHead',
      VALVE_DEFINITION_MISSING:'valves',EQUIPMENT_INVENTORY_UNVERIFIED:'valves',PATTERN_MISSING:'pattern',
      CALIBRATION_MISSING:'calibration'};
    if(direct[code])return direct[code];
    return Object.keys(fields||{}).find(key=>String(code||'').startsWith(`HYDRAULIC_${key.toUpperCase()}_`))||null;
  };
  const renderQuick=(h=null)=>{
    const dma=selectedDma(),admin=localStorage.getItem('sainsUserLevel')==='ADMIN';
    const active=Boolean(dma&&admin);
    for(const id of ['ai-quick-check','ai-quick-autofill','ai-quick-complete'])byId(id).disabled=!active;
    byId('ai-quick-issues').disabled=!active||!(h?.gis?.segmentCount>0);
    byId('ai-quick-view-missing').disabled=!active||!h;
    byId('ai-hydraulic-action-hint').textContent=!admin?'Tindakan model hidraulik untuk ADMIN sahaja.':
      !dma?'Pilih satu DMA untuk menggunakan tindakan model hidraulik.':'Tindakan menggunakan DMA yang dipilih: '+dma;
    byId('ai-hydraulic-quick-title').textContent='HYDRAULIC MODEL — '+(dma||'Pilih DMA');
    const status=byId('ai-hydraulic-quick-status');status.replaceChildren();
    const values=h?[['Data Completion',h.status],['Steady-State',h.capabilities?.steadyState],
      ['Baseline',h.capabilities?.baseline],['Calibration',h.capabilities?.calibration]]:[];
    if(!values.length)status.textContent=dma?'Status belum disemak.':'Status belum disemak.';
    else for(const [label,value] of values){const badge=document.createElement('span');
      badge.textContent=`${label}: ${value||'NOT READY'}`;status.append(badge);}
    const missing=byId('ai-hydraulic-quick-missing');missing.replaceChildren();
    const unresolved=Object.entries(h?.fields||{}).filter(([,field])=>['MISSING','PARTIAL','NOT_READY'].includes(String(field.status).toUpperCase()));
    if(!h)missing.textContent=dma?'Semak model untuk lihat kekurangan.':'Pilih DMA dahulu.';
    else if(!unresolved.length)missing.textContent='Tiada dalam status parameter semasa.';
    else unresolved.forEach(([key,field],index)=>{const button=document.createElement('button');button.type='button';
      button.className='mr-1 mb-1 underline text-violet-700 dark:text-violet-300';
      button.textContent=`${field.label||key} (${field.status})${index<unresolved.length-1?',':''}`;
      button.addEventListener('click',()=>goToField(key));missing.append(button);});
    const stage=!dma?1:h?.capabilities?.baseline==='READY'?6:h?3:2;
    for(const item of byId('ai-hydraulic-workflow').children){const current=Number(item.dataset.step)===stage;
      item.classList.toggle('bg-violet-700',current);item.classList.toggle('text-white',current);}
    byId('ai-baseline-lock-message').hidden=!byId('ai-run-real-baseline').disabled;
    const worklist=byId('ai-hydraulic-worklist');
    worklist.classList.toggle('hidden',!active||!h);
    if(active&&h){
      byId('ai-issue-diameter').textContent=`${h.gis?.missingDiameterParts||0} bahagian tanpa diameter GIS`;
      byId('ai-issue-intro').textContent=`${dma}: ${h.gis?.segmentCount||0} segmen GIS. Pilih jenis isu untuk zum ke garisan yang dapat dipadankan. Data model yang belum diluluskan mungkin belum mempunyai lokasi tepat.`;
    }
  };
  const clearIssueLayer=()=>{
    if(issueLayer&&typeof aiAgentMap!=='undefined'&&aiAgentMap)aiAgentMap.removeLayer(issueLayer);
    issueLayer=null;issueZone='';issueKind='';selectedIssue=null;
    clearTargetPipe();
    byId('ai-issue-list')?.replaceChildren();
    byId('ai-issue-selected')?.classList.add('hidden');
  };
  const clearTargetPipe=()=>{
    if(targetPipeLayer&&typeof aiAgentMap!=='undefined'&&aiAgentMap)aiAgentMap.removeLayer(targetPipeLayer);
    targetPipeLayer=null;
    byId('ai-map-pipe-target')?.classList.add('hidden');
  };
  const highlightPipe=(features,asset,dma)=>{
    clearTargetPipe();
    if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
    aiAgentMap.closePopup();
    targetPipeLayer=L.geoJSON({type:'FeatureCollection',features},{style:{color:'#7c3aed',weight:11,opacity:1}}).addTo(aiAgentMap);
    targetPipeLayer.eachLayer(layer=>layer.bringToFront?.());
    const label=`Pipe ID calon ${asset} · ${features.length} bahagian GIS dalam ${dma}. Garisan ungu ialah lokasi calon, bukan bukti diameter/panjang kejuruteraan.`;
    const target=byId('ai-map-pipe-target');target.textContent=label;target.classList.remove('hidden');
    aiAgentMap.invalidateSize();
    const bounds=targetPipeLayer.getBounds();if(bounds.isValid())aiAgentMap.fitBounds(bounds.pad(0.6),{maxZoom:17});
    if(matchMedia('(max-width: 1023px)').matches)byId('ai-agent-map').scrollIntoView({behavior:'smooth',block:'center'});
    return label;
  };
  const showExactPipe=async()=>{
    const dma=selectedDma(),type=byId('ai-eng-entity-type')?.value,asset=byId('ai-eng-entity-id')?.value.trim();
    const status=byId('ai-eng-pipe-map-status');
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN'){status.textContent='Peta paip ini untuk ADMIN sahaja.';return;}
    if(!dma||type!=='PIPE'||!asset){status.textContent='Pilih DMA, Entity Type PIPE dan Pipe ID sebenar dahulu.';return;}
    const serial=++targetSerial;clearTargetPipe();status.textContent=`Mencari Pipe ID ${asset} dalam jajaran ${dma}…`;
    try{
      const url=new URL('/api/pipe-lines',WORKER_URL);url.searchParams.set('zone',dma);url.searchParams.set('limit','500');
      const response=await fetch(url,{headers:{Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`}});
      const data=await response.json();if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      if(serial!==targetSerial||dma!==selectedDma()||asset!==byId('ai-eng-entity-id').value.trim())return;
      if(data.nextOffset!==null)throw new Error('Senarai paip melebihi 500 bahagian; carian belum lengkap.');
      const matches=(data.features||[]).filter(feature=>String(feature.properties?.asset_num||'').trim()===asset);
      if(!matches.length){status.textContent=`Pipe ID ${asset} tiada padanan garisan yang disahkan dalam GIS ${dma}. Jangan pilih paip berhampiran sebagai ganti; semak ID dan rekod aset.`;return;}
      status.textContent=highlightPipe(matches,asset,dma);
    }catch(error){if(serial===targetSerial)status.textContent=`Tidak dapat tunjuk Pipe ID pada peta: ${error.message}`;}
  };
  const selectIssue=(record)=>{
    selectedIssue=record;
    const asset=String(record.feature.properties?.asset_num||'').trim();
    if(asset)highlightPipe([record.feature],asset,selectedDma());
    else{const bounds=record.layer.getBounds?.();if(bounds?.isValid())aiAgentMap.fitBounds(bounds.pad(0.5),{maxZoom:17});record.layer.openPopup();}
    byId('ai-issue-selected').classList.remove('hidden');
    byId('ai-issue-selected-text').textContent=`${asset?`Pipe ID calon ${asset}`:'Pipe ID belum diketahui'} · ${record.kind==='length'?'Panjang GIS bukan panjang kejuruteraan yang diluluskan. Semak as-built/survei untuk paip yang sama.':'Diameter GIS hilang atau bercanggah. Semak daftar aset/as-built untuk paip yang sama.'} Peta tidak mengisi nilai secara automatik.`;
    byId('ai-issue-selected').scrollIntoView({behavior:'smooth',block:'nearest'});
  };
  const openSelectedIssueForm=()=>{
    if(!selectedIssue)return;
    const asset=String(selectedIssue.feature.properties?.asset_num||'').trim();
    goToField(selectedIssue.kind);
    if(asset){const input=byId('ai-eng-entity-id');input.value=asset;input.dispatchEvent(new Event('input',{bubbles:true}));}
    byId('ai-eng-report').textContent=`${asset?`Pipe ID calon ${asset}`:'Pipe ID belum diketahui'} daripada GIS. Sahkan identiti dan sumber aset sebelum memasukkan nilai; tiada nilai diisi atau disimpan secara automatik.`;
  };
  const showIssues=async(kind='all')=>{
    const dma=byId('ai-filter-district')?.value?.trim();if(!dma)return;
    if(issueLayer&&issueZone===dma&&issueKind===kind){
      if(kind==='all'){clearIssueLayer();return;}
      byId('ai-agent-map').scrollIntoView({behavior:'smooth',block:'center'});return;
    }
    const serial=++issueSerial;
    clearIssueLayer();
    byId('ai-issue-status').textContent='Memuatkan isu yang dapat dipadankan dengan jajaran GIS…';
    try{
      const url=new URL('/api/pipe-lines',WORKER_URL);url.searchParams.set('zone',dma);url.searchParams.set('limit','500');
      const response=await fetch(url,{headers:{Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`}});
      const data=await response.json();if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      if(serial!==issueSerial||dma!==selectedDma())return;
      if(data.nextOffset!==null)throw new Error('Lebih 500 bahagian; paparan isu belum lengkap.');
      let issueByAsset=new Map();
      if(currentHydraulic?.modelId&&currentHydraulic?.modelVersion){
        const detail=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',
          Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify({
          action:'autoFillHydraulicPreview',dma,modelId:currentHydraulic.modelId,version:currentHydraulic.modelVersion})});
        const result=await detail.json();if(serial!==issueSerial||dma!==selectedDma())return;
        if(detail.ok&&result.status==='success')
          issueByAsset=new Map(result.autoFill.mapIssues.map(item=>[String(item.assetNum),item.issueCodes]));
      }
      const codesFor=feature=>issueByAsset.get(String(feature.properties?.asset_num||''))||[];
      const features=data.features.filter(feature=>{
        const codes=codesFor(feature),diameterMissing=!(Number(feature.properties?.size_mm)>0)||codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT');
        if(kind==='diameter')return diameterMissing;
        if(kind==='length')return codes.includes('ENGINEERING_LENGTH_UNREVIEWED');
        return diameterMissing||codes.length>0;
      });
      if(!features.length){
        byId('ai-issue-status').textContent=kind==='length'?'Tiada paip dengan isu panjang yang dapat dipadankan secara sah ke peta. Panjang model masih belum diluluskan; semak daftar aset/as-built.':'Tiada garisan isu yang dapat dilokasikan. Semak rekod aset dan jangan pilih lokasi anggaran.';
        return;
      }
      if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
      const labels={PIPE_ID_UNRESOLVED:'Pipe ID belum dipadankan ke asset master',
        GIS_DIAMETER_MISSING_OR_CONFLICT:'diameter GIS/asset hilang atau bercanggah',
        ENGINEERING_LENGTH_UNREVIEWED:'engineering length belum diluluskan',
        ROUGHNESS_UNREVIEWED:'Hazen-Williams C belum diluluskan',
        TOPOLOGY_UNRESOLVED:'sambungan topologi belum diluluskan'};
      const records=[];
      issueLayer=L.geoJSON({type:'FeatureCollection',features},{style:feature=>{
        const codes=issueByAsset.get(String(feature.properties?.asset_num||''))||[];
        return {color:!(Number(feature.properties?.size_mm)>0)||codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT')
          ?'#dc2626':codes.includes('PIPE_ID_UNRESOLVED')?'#ea580c':'#d97706',weight:6,opacity:0.9};},
        onEachFeature:(feature,layer)=>{const box=document.createElement('div');
          const codes=[...(issueByAsset.get(String(feature.properties?.asset_num||''))||[])];
          if(!(Number(feature.properties?.size_mm)>0)&&!codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT'))
            codes.unshift('GIS_DIAMETER_MISSING_OR_CONFLICT');
          const record={feature,layer,kind:kind==='length'?'length':codes.includes('GIS_DIAMETER_MISSING_OR_CONFLICT')?'diameter':'length'};
          records.push(record);
          box.textContent=`ISU HIDRAULIK · aset ${feature.properties.asset_num||'ID belum disahkan'} · DMA ${dma}: `+
            `${codes.map(code=>labels[code]||code).join('; ')}. Peta tidak mengesahkan topologi atau lokasi nod.`;
          const button=document.createElement('button');button.type='button';
          button.className='block mt-2 underline text-violet-700';
          button.textContent='Buka borang data paip';
          button.addEventListener('click',()=>{selectIssue(record);openSelectedIssueForm();});
          box.append(button);
          layer.bindPopup(box);layer.on('click',()=>selectIssue(record));}}).addTo(aiAgentMap);
      issueZone=dma;issueKind=kind;
      const list=byId('ai-issue-list');list.replaceChildren();
      for(const [index,record] of records.entries()){
        const asset=String(record.feature.properties?.asset_num||'').trim();
        const button=document.createElement('button');button.type='button';
        button.className='block w-full rounded border border-blue-200 bg-white px-2 py-1 text-left hover:border-blue-600 focus-visible:outline-2 focus-visible:outline-blue-600 dark:bg-slate-800';
        button.textContent=`${index+1}. ${asset?`Pipe ID calon ${asset}`:'Bahagian tanpa Pipe ID'} — ${record.kind==='length'?'semak panjang kejuruteraan':'semak diameter'}`;
        button.addEventListener('click',()=>selectIssue(record));list.append(button);
      }
      byId('ai-issue-status').textContent=`${records.length} garisan isu dipaparkan. Klik baris untuk zum ke paip, kemudian buka borang DRAFT. Bilangan ini ialah bahagian GIS, bukan bilangan aset unik yang disahkan.`;
      const bounds=issueLayer.getBounds();if(bounds.isValid())aiAgentMap.fitBounds(bounds.pad(0.25),{maxZoom:15});
      byId('ai-hydraulic-status').textContent+='\nIsu pipe GIS yang boleh dipadankan disorot. Elevasi nod, demand dan source head tanpa lokasi model disahkan kekal dalam senarai status, bukan titik rekaan.';
    }catch(error){
      if(serial!==issueSerial||dma!==selectedDma())return;
      clearIssueLayer();byId('ai-issue-status').textContent=`Peta isu tidak tersedia: ${error.message}`;
      byId('ai-hydraulic-status').textContent+=`\nPeta isu tidak tersedia: ${error.message}`;
    }
  };
  const refresh=async()=>{
    const serial=++refreshSerial;
    const host=byId('ai-hydraulic-status'),issues=byId('ai-hydraulic-issues'),scenarios=byId('ai-hydraulic-scenarios');
    const fields=byId('ai-hydraulic-fields'),capabilities=byId('ai-hydraulic-capabilities');
    if(!host||!issues)return;
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN') {host.textContent='ADMIN sahaja.';issues.replaceChildren();scenarios?.replaceChildren();fields?.replaceChildren();renderQuick();return;}
    const dma=byId('ai-filter-district')?.value?.trim()||'';
    ++issueSerial;++targetSerial;clearIssueLayer();currentHydraulic=null;host.textContent='Menyemak status model…';issues.replaceChildren();scenarios?.replaceChildren();fields?.replaceChildren();
    byId('ai-issue-status').textContent='Tekan jenis isu untuk lihat senarai paip yang boleh dipadankan dengan peta.';
    capabilities.textContent='';byId('ai-run-real-baseline').disabled=true;
    byId('ai-hydraulic-issues-map').disabled=true;
    renderQuick();
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
      if(serial!==refreshSerial||dma!==selectedDma())return;
      if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      const h=data.hydraulic;
      currentHydraulic=h;
      renderQuick(h);
      host.textContent=`${h.zone} · Model ${h.status} · EPANET ${h.engine.integration}\nGIS: ${h.gis.segmentCount} segmen zon; ${h.gis.missingDiameterParts} bahagian tanpa diameter. Segmen sumber tanpa Pipe ID belum dapat dikaitkan secara sah kepada DMA. Panjang GIS bukan panjang aset yang disahkan.`;
      for(const [key,field] of Object.entries(h.fields||{})){
        const item=document.createElement('button');item.type='button';
        item.className='rounded border p-2 text-left hover:border-violet-500 focus-visible:outline-2 focus-visible:outline-violet-600';
        item.textContent=`${field.label}: ${field.status} — ${field.detail} · Klik untuk isi/semak →`;
        item.addEventListener('click',()=>goToField(key));fields.append(item);
      }
      capabilities.textContent=`STEADY-STATE: ${h.capabilities.steadyState} · BASELINE: ${h.capabilities.baseline} · CALIBRATION: ${h.capabilities.calibration} · PIPE FAILURE: ${h.scenarioCapabilities.PIPE_CLOSED?.status||'NOT_READY'} · VALVE ISOLATION: ${h.scenarioCapabilities.VALVE_ISOLATION?.status||'NOT_READY'} · SCENARIO COMPARE: ${h.scenarioCapabilities.SCENARIO_COMPARE?.status||'NOT_READY'}`;
      byId('ai-hydraulic-issues-map').disabled=!(h.gis?.segmentCount>0);
      for(const item of h.issues){const li=document.createElement('li');
        li.append(document.createTextNode(`${item.severity}: ${item.detail} `));
        const key=issueField(item.code,h.fields);
        if(key){const link=document.createElement('button');link.type='button';
          link.className='underline text-violet-700 dark:text-violet-300';
          link.textContent='Isi / semak data →';link.addEventListener('click',()=>goToField(key));li.append(link);}
        issues.append(li);}
      for(const [name,item] of Object.entries(h.scenarioCapabilities||{})){
        const li=document.createElement('li');li.textContent=`${name}: ${item.status} — ${(item.reasons||[]).join(' ')}`;scenarios?.append(li);
      }
    }catch(error){if(serial!==refreshSerial)return;host.textContent=`Status model gagal disemak: ${error.message}. Simulasi tidak dijalankan.`;renderQuick();}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    byId('ai-hydraulic-refresh')?.addEventListener('click',refresh);
    byId('ai-filter-district')?.addEventListener('change',refresh);
    byId('ai-hydraulic-issues-map')?.addEventListener('click',()=>showIssues());
    byId('ai-issue-diameter')?.addEventListener('click',()=>showIssues('diameter'));
    byId('ai-issue-length')?.addEventListener('click',()=>showIssues('length'));
    byId('ai-issue-prv')?.addEventListener('click',()=>{
      byId('ai-issue-status').textContent='Pilih hanya lokasi PRV yang diketahui. Koordinat akan masuk ke borang pemantauan; jenis injap, setting dan sambungan model perlu semakan berasingan.';
      byId('ai-pick-prv-map').click();
    });
    byId('ai-issue-open-form')?.addEventListener('click',openSelectedIssueForm);
    byId('ai-eng-show-pipe-map')?.addEventListener('click',showExactPipe);
    byId('ai-quick-check')?.addEventListener('click',()=>{openDetails('status');refresh();});
    byId('ai-quick-autofill')?.addEventListener('click',()=>{openDetails('intake');window.aiEngQuickAutofill?.();});
    byId('ai-quick-complete')?.addEventListener('click',()=>openDetails('intake'));
    byId('ai-quick-issues')?.addEventListener('click',()=>{openDetails('status');byId('ai-hydraulic-issues-map').click();});
    byId('ai-quick-view-missing')?.addEventListener('click',()=>openDetails('status'));
    byId('ai-guide-manual')?.addEventListener('click',()=>{openDetails('intake');byId('ai-eng-entity-id').focus();});
    byId('ai-guide-file')?.addEventListener('click',()=>{openDetails('intake');byId('ai-eng-file').focus();});
    byId('ai-view-baseline-blockers')?.addEventListener('click',()=>openDetails('status'));
    renderQuick();
  });
  window.phase2bRefreshHydraulic=refresh;
})();
