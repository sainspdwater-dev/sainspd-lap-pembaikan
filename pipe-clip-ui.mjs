import {previewPipeClip,clipAuditCsv} from './pipe-clip-preview.mjs';

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded',()=>{
  const byId=id=>document.getElementById(id);
  const progress=byId('ai-pipe-clip-progress'),summary=byId('ai-pipe-clip-summary');
  const comparison=byId('ai-pipe-clip-compare');
  const previewButton=byId('ai-pipe-clip-preview');
  const auditButton=byId('ai-pipe-clip-audit');
  const stageButton=byId('ai-pipe-clip-stage'),stageStatus=byId('ai-pipe-clip-stage-status');
  const confirmation=byId('ai-pipe-clip-confirm');
  let controller=null,stageController=null,clipLayer=null,auditCsv='',currentPreview=null,currentMeta=null;
  const clear=()=>{
    controller?.abort();stageController?.abort();controller=null;stageController=null;
    auditCsv='';currentPreview=null;currentMeta=null;confirmation.value='';
    auditButton.disabled=true;stageButton.disabled=true;previewButton.disabled=false;
    byId('ai-spatial-file').disabled=false;
    if(clipLayer && typeof aiAgentMap!=='undefined' && aiAgentMap)aiAgentMap.removeLayer(clipLayer);
    clipLayer=null;summary.replaceChildren();progress.textContent='Belum ada pratonton. Jajaran aktif D1 tidak berubah.';
    comparison.textContent='Perbandingan versi aktif D1 belum dibuat.';
    stageStatus.textContent='Pratonton dikosongkan. Jika upload DRAFT telah bermula, bahagian yang berjaya dihantar mungkin kekal dalam D1; upload semula fail sama untuk sambung. Jajaran aktif tidak berubah.';
  };
  window.aiPipeClipOnUpload=clear;
  byId('ai-pipe-clip-clear')?.addEventListener('click',clear);
  auditButton?.addEventListener('click',()=>{
    if(!auditCsv)return;
    const url=URL.createObjectURL(new Blob([auditCsv],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='pipe-clip-audit.csv';
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const pause=(milliseconds,signal)=>new Promise((resolve,reject)=>{
    if(signal.aborted)return reject(new DOMException('Upload dibatalkan.','AbortError'));
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},milliseconds);
    const onAbort=()=>{clearTimeout(timer);reject(new DOMException('Upload dibatalkan.','AbortError'));};
    signal.addEventListener('abort',onAbort,{once:true});
  });
  const api=async(body,signal)=>{
    // The existing Worker rate limit is 60 requests/minute per IP. A full-network
    // upload can exceed that limit; retries are safe because rows are idempotent.
    for(let attempt=0;attempt<3;attempt++){
      const response=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',
        Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify(body),signal});
      if(response.status===429&&attempt<2){
        stageStatus.textContent=`Worker sedang mengehadkan permintaan. Menunggu 65 saat sebelum sambung (${attempt+1}/2); jangan tutup halaman.`;
        await pause(65000,signal);continue;
      }
      const result=await response.json();
      if(!response.ok||result.status!=='success')throw new Error(result.message||`API ${response.status}`);
      return result;
    }
  };
  stageButton?.addEventListener('click',async()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN')return stageStatus.textContent='ADMIN sahaja.';
    if(confirmation.value.trim()!=='SIMPAN DRAFT')return stageStatus.textContent='Taip tepat SIMPAN DRAFT untuk mengesahkan.';
    if(!currentPreview||!currentMeta)return stageStatus.textContent='Pratonton dan hash sumber belum lengkap.';
    stageController?.abort();stageController=new AbortController();
    const runController=stageController;
    stageButton.disabled=true;previewButton.disabled=true;
    const fileInput=byId('ai-spatial-file');fileInput.disabled=true;
    try{
      const batch=await api({action:'beginPipeCandidateDraft',sourceName:currentMeta.sourceName,
        sourceSha256:currentMeta.sourceSha256,polygonSha256:currentMeta.polygonSha256,
        sourceLines:currentPreview.sourceLines,expectedParts:currentPreview.stagedParts.length,
        outsideLines:currentPreview.outsideLines,multiDmaLines:currentPreview.multiDmaLines,
        invalidGeometry:currentPreview.invalidGeometry,confirmDraft:true},runController.signal);
      if(batch.reviewStatus==='REVIEW_REQUIRED'){
        stageStatus.textContent=`Batch ${batch.batchId} sudah DRAFT REVIEW_REQUIRED dalam D1. Tiada jajaran aktif berubah.`;
        return;
      }
      const parts=currentPreview.stagedParts;
      for(let start=0;start<parts.length;start+=100){
        if(runController.signal.aborted)return;
        await api({action:'appendPipeCandidateParts',batchId:batch.batchId,
          parts:parts.slice(start,start+100)},runController.signal);
        stageStatus.textContent=`Batch ${batch.batchId}: ${Math.min(start+100,parts.length)}/${parts.length} bahagian calon dihantar. Jajaran aktif tidak berubah.`;
        if(start+100<parts.length)await pause(1500,runController.signal);
      }
      const finished=await api({action:'finalizePipeCandidateDraft',batchId:batch.batchId},runController.signal);
      stageStatus.textContent=`Batch ${batch.batchId}: ${finished.storedParts} calon DRAFT disimpan untuk semakan pemilikan/aset (${finished.reviewStatus}). Tiada pengaktifan jajaran atau model.`;
    }catch(error){if(!runController.signal.aborted)
      stageStatus.textContent=`Upload calon terhenti: ${error.message}. Calon separa mungkin kekal dalam D1; ulang dengan fail dan polygon sama untuk sambung. Jajaran aktif tidak berubah.`;}
    finally{if(stageController===runController){stageButton.disabled=false;previewButton.disabled=false;fileInput.disabled=false;}}
  });
  const showZone=zone=>{
    if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
    if(clipLayer)aiAgentMap.removeLayer(clipLayer);
    clipLayer=L.geoJSON({type:'FeatureCollection',features:zone.mapFeatures},{
      style:{color:'#ea580c',weight:5,opacity:0.9},
      onEachFeature:(feature,layer)=>{
        const id=feature.properties?.asset_num||'ID KML tiada';
        const size=feature.properties?.size_mm?`${feature.properties.size_mm} mm`:'diameter tidak ditemui';
        const box=document.createElement('div');
        box.textContent=`CALON SPATIAL SAHAJA · ${zone.name} · ID KML ${id} · ${size}. Sahkan pemilikan DMA dan data kejuruteraan sebelum import.`;
        layer.bindPopup(box);
      }
    }).addTo(aiAgentMap);
    const polygonMatches=(window.aiDmaPolygonFeatures||[]).filter(item=>item.name===zone.name);
    const bounds=L.latLngBounds([]);
    polygonMatches.forEach(item=>bounds.extend(item.layer.getBounds()));
    if(!bounds.isValid())bounds.extend(clipLayer.getBounds());
    if(bounds.isValid())aiAgentMap.fitBounds(bounds,{padding:[35,35],maxZoom:15});
    progress.textContent=`${zone.name}: ${zone.partCount} bahagian clipped. Peta memaparkan maksimum ${zone.mapFeatures.length} bahagian${zone.mapTruncated?' (sampel sahaja)':''}; angka ringkasan merangkumi semua bahagian.`;
  };
  const render=result=>{
    summary.replaceChildren();
    const note=document.createElement('p');
    note.className='mb-2 text-amber-700 dark:text-amber-300';
    note.textContent=`${result.sourceLines} garisan sumber; ${result.outsideLines} di luar semua polygon; ${result.multiDmaLines} bersilang lebih daripada satu DMA; ${result.invalidGeometry} geometri tidak sah. ID/diameter yang ditunjuk berasal daripada KML dan belum disahkan terhadap daftar aset.`;
    summary.append(note);
    const table=document.createElement('table');table.className='min-w-full text-left border-collapse';
    const head=document.createElement('thead');
    const headRow=document.createElement('tr');
    for(const label of ['DMA','Bahagian clip','ID KML unik','Panjang geometri','Bahagian tanpa ID','Diameter tidak ditemui','Peta']){
      const th=document.createElement('th');th.textContent=label;th.className='border p-1';headRow.append(th);
    }
    head.append(headRow);table.append(head);
    const body=document.createElement('tbody');
    for(const zone of [...result.zones].sort((a,b)=>a.name.localeCompare(b.name))){
      const row=document.createElement('tr');
      const values=[zone.name,zone.partCount,zone.sourceCount,`${(zone.lengthM/1000).toFixed(3)} km`,
        zone.noIdParts,zone.noDiameterParts];
      for(const value of values){const td=document.createElement('td');td.textContent=String(value);td.className='border p-1';row.append(td);}
      const cell=document.createElement('td');cell.className='border p-1';
      const button=document.createElement('button');button.type='button';button.textContent='Lihat';
      button.className='underline text-blue-700 dark:text-blue-300';button.disabled=!zone.partCount;
      button.addEventListener('click',()=>showZone(zone));cell.append(button);row.append(cell);body.append(row);
    }
    table.append(body);summary.append(table);
  };
  previewButton?.addEventListener('click',async()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN'){
      progress.textContent='ADMIN sahaja.';return;
    }
    const data=window.customSpatialGeoJSON;
    if(!data){progress.textContent='Muat naik KML/KMZ/GeoJSON jajaran dahulu.';return;}
    const sourceFile=byId('ai-spatial-file')?.files?.[0];
    if(!sourceFile){progress.textContent='Fail sumber tidak dapat disahkan; muat naik semula.';return;}
    const features=data.type==='FeatureCollection'?data.features:data.type==='Feature'?[data]:[];
    if(!features.some(item=>/LineString$/.test(item.geometry?.type||''))){
      progress.textContent='Fail dimuat naik tiada garisan paip. Pilih fail jajaran, bukan fail polygon sahaja.';return;
    }
    controller?.abort();controller=new AbortController();
    const runController=controller;
    auditCsv='';currentPreview=null;currentMeta=null;auditButton.disabled=true;stageButton.disabled=true;
    comparison.textContent='Menyemak fail sumber dahulu…';
    previewButton.disabled=true;summary.replaceChildren();
    try{
      const result=await previewPipeClip(features,window.aiDmaPolygonFeatures||[],{
        signal:runController.signal,onProgress:({done,total})=>{
          if(runController.signal.aborted)return;
          progress.textContent=`Menyemak ${done.toLocaleString()}/${total.toLocaleString()} fitur… tiada data ditulis ke D1.`;
        }
      });
      if(runController.signal.aborted)return;
      render(result);
      if(!globalThis.crypto?.subtle)throw new Error('Hash SHA-256 fail tidak tersedia; audit tidak boleh disiapkan.');
      const polygonManifest=(window.aiDmaPolygonFeatures||[]).map(item=>({name:item.name,
        geometry:item.feature.geometry})).sort((a,b)=>a.name.localeCompare(b.name));
      const [digest,polygonDigest]=await Promise.all([
        crypto.subtle.digest('SHA-256',await sourceFile.arrayBuffer()),
        crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(polygonManifest)))
      ]);
      if(runController.signal.aborted)return;
      const sha=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const polygonSha=[...new Uint8Array(polygonDigest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      currentPreview=result;
      currentMeta={sourceName:sourceFile.name,sourceSha256:sha,polygonSha256:polygonSha};
      auditCsv=clipAuditCsv(result,{sourceName:sourceFile.name,sourceSha256:sha,
        polygonSha256:polygonSha,createdAt:new Date().toISOString()});
      auditButton.disabled=false;
      stageButton.disabled=result.stagedParts.length===0;
      stageStatus.textContent=result.stagedParts.length
        ?`${result.stagedParts.length} calon boleh disimpan sebagai DRAFT. Taip SIMPAN DRAFT; tiada pemilikan DMA/parameter hidraulik diluluskan.`
        :'Tiada garisan dalam polygon untuk disimpan.';
      progress.textContent=`Pratonton selesai · ${sourceFile.name} · SHA-256 ${sha.slice(0,12)}… Semak setiap DMA; data belum diimport atau diluluskan.`;
      try{
        const url=new URL('/api/pipe-import-active',WORKER_URL);
        const response=await fetch(url,{headers:{Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},
          signal:runController.signal});
        const metadata=await response.json();
        if(runController.signal.aborted)return;
        if(!response.ok||metadata.status!=='success')throw new Error(metadata.message||`API ${response.status}`);
        const active=metadata.active;
        comparison.textContent=active.sourceSha256?.toLowerCase()===sha.toLowerCase()
          ?`Fail sumber sama SHA-256 dengan import D1 aktif (${active.importId}), tetapi versi polygon/hasil clip dan pemilikan DMA belum disahkan. Jangan anggap jajaran calon setara dengan jajaran aktif.`
          :`Fail berbeza daripada import D1 aktif (${active.importId}, ${active.sourceName}, ${active.lineCount} garisan). Pratonton ini tidak menukar versi aktif.`;
      }catch(error){if(!runController.signal.aborted)
        comparison.textContent=`Versi D1 aktif tidak dapat dibandingkan: ${error.message}. Tiada import dibuat.`;}
    }catch(error){if(!runController.signal.aborted)progress.textContent=`Pratonton gagal: ${error.message}. D1 tidak berubah.`;}
    finally{if(controller===runController)previewButton.disabled=false;}
  });
});
