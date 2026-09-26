// Minimal enhancement of the existing AI Agent tab; no second dashboard.
(() => {
  const FIELDS = [
    ['dma','DMA'],['recordedAt','Masa bacaan'],['sensorId','ID sensor'],
    ['flow','Flow (m³/h)'],['inlet','Tekanan inlet (bar)'],
    ['cp','Tekanan CP (bar)'],['nightUse','Penggunaan sah malam (m³/h)']
  ];
  const ALIASES = {
    dma:['dma','dma name','district metered area','zone'],
    recordedAt:['recorded_at','timestamp','date time','datetime','tarikh masa','masa bacaan'],
    sensorId:['sensor id','sensor_id','meter id','meter_id'],
    flow:['flow','flow rate','flow_m3h','aliran','mnf'],
    inlet:['pressure inlet','inlet pressure','pressure_inlet_bar','tekanan inlet'],
    cp:['cp pressure','pressure cp','pressure_cp_bar','tekanan cp'],
    nightUse:['legitimate_night_use_m3h','legitimate night use','penggunaan sah malam']
  };
  const UNITS = {flow:'m3/h',inlet:'bar',cp:'bar',nightUse:'m3/h'};
  const CHUNK_ROWS = 10;
  const byId = id => document.getElementById(id);
  let upload = null, previewed = false, cleanupPreview = null;

  async function api(body) {
    const res = await fetch(WORKER_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('sainsToken')}`},
      body:JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `API ${res.status}`);
    return data;
  }

  function setReport(id, message, error = false) {
    const el=byId(id); if (!el) return;
    el.textContent=message;
    el.className=`mt-2 whitespace-pre-line ${error?'text-red-700 dark:text-red-300':'text-slate-700 dark:text-slate-200'}`;
  }

  function mapping() {
    return Object.fromEntries(FIELDS.map(([key]) => [key,byId(`ai-map-${key}`)?.value || '']));
  }

  function invalidatePreview() {
    previewed=false;
    byId('ai-confirm-import').disabled=true;
    byId('ai-confirm-import').className='px-2 py-1 bg-slate-500 text-white rounded';
  }

  function drawMapping(columns, rows) {
    const host=byId('ai-import-mapping'); host.replaceChildren();
    for (const [key,label] of FIELDS) {
      const wrap=document.createElement('label'); wrap.className='block font-semibold';
      wrap.textContent=label;
      const select=document.createElement('select'); select.id=`ai-map-${key}`;
      select.className='form-input py-1 text-xs w-full';
      const blank=document.createElement('option'); blank.value=''; blank.textContent='— Tiada kolum —'; select.append(blank);
      for (const column of columns) {
        const option=document.createElement('option'); option.value=column; option.textContent=column; select.append(option);
      }
      const hits=columns.filter(column => ALIASES[key].includes(column.trim().toLowerCase().replace(/\s+/g,' ')));
      if (hits.length===1) select.value=hits[0];
      select.addEventListener('change',invalidatePreview);
      wrap.append(select); host.append(wrap);
    }
    const preview=byId('ai-import-preview'); preview.replaceChildren();
    const table=document.createElement('table'); table.className='min-w-full text-[10px] border-collapse';
    const head=document.createElement('tr');
    for (const column of columns) { const th=document.createElement('th'); th.textContent=column; th.className='border p-1'; head.append(th); }
    table.append(head);
    for (const row of rows.slice(0,5)) {
      const tr=document.createElement('tr');
      for (const column of columns) { const td=document.createElement('td'); td.textContent=String(row[column]??'').slice(0,100); td.className='border p-1'; tr.append(td); }
      table.append(tr);
    }
    preview.append(table);
  }

  window.phase2aHandleFile = async event => {
    const file=event.target.files?.[0];
    upload=null; invalidatePreview();
    if (!file) return;
    if (!/\.(csv|xls|xlsx)$/i.test(file.name) || file.size>2*1024*1024) {
      setReport('ai-import-report','Gunakan CSV/Excel sehingga 2 MiB.',true); return;
    }
    try {
      const buffer=await file.arrayBuffer();
      const workbook=XLSX.read(buffer,{type:'array',cellDates:false});
      const sheet=workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error('Helaian pertama tiada.');
      const rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});
      const columns=Object.keys(rows[0] || {});
      if (!rows.length || !columns.length || rows.length>10000 || columns.length>100) throw new Error('Fail kosong atau melebihi 10,000 baris / 100 kolum.');
      if (columns.some(x=>x.startsWith('__EMPTY'))) throw new Error('Fail mempunyai tajuk kolum kosong; kemaskan tajuk dahulu.');
      const digest=await crypto.subtle.digest('SHA-256',buffer);
      const sha=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      upload={file,rows,columns,sha,batchId:crypto.randomUUID()};
      drawMapping(columns,rows);
      byId('ai-import-panel').classList.remove('hidden');
      byId('ai-import-panel').open=true;
      byId('ai-flow-upload-status').textContent=`${rows.length} baris dikesan. Semak pemetaan sebelum import.`;
      setReport('ai-import-report','Pratonton 5 baris. Unit: flow/night use = m³/h; tekanan = bar. Jika unit fail berbeza, tukar unit dalam fail dahulu.');
    } catch(error) { setReport('ai-import-report',error.message,true); byId('ai-flow-upload-status').textContent='Fail tidak dapat dipratonton.'; }
  };

  window.phase2aResetImport = () => {
    upload=null; invalidatePreview();
    byId('ai-import-panel').classList.add('hidden');
    byId('ai-import-panel').open=false;
    byId('ai-import-mapping').replaceChildren();
    byId('ai-import-preview').replaceChildren();
    setReport('ai-import-report','');
  };

  async function previewImport() {
    if (!upload) return;
    invalidatePreview();
    try {
      const result=await api({action:'previewOperationalImport',headers:upload.columns,rows:upload.rows.slice(0,20),mapping:mapping(),units:UNITS,defaultDma:byId('ai-filter-district').value});
      const s=result.preview.stats;
      setReport('ai-import-report',`Semakan sampel ${s.rowsDetected} baris: diterima ${s.rowsAccepted}, ditolak ${s.rowsRejected}, masa tiada ${s.missingTimestamp}, masa tidak sah ${s.invalidTimestamp}, DMA tiada ${s.missingDma}, CP tiada ${s.missingCp}, nilai tidak sah ${s.invalidValue}.\nImport penuh akan disemak semula oleh pelayan, termasuk baris di luar sampel.`);
      previewed=true;
      byId('ai-confirm-import').disabled=false;
      byId('ai-confirm-import').className='px-2 py-1 bg-emerald-700 text-white rounded';
    } catch(error) { setReport('ai-import-report',error.message,true); }
  }

  async function importFile() {
    if (!upload || !previewed) return;
    const button=byId('ai-confirm-import'); button.disabled=true;
    const map=mapping();
    const totals={rowsDetected:0,rowsAccepted:0,rowsRejected:0,observationsInserted:0,duplicatesSkipped:0,conflictsSkipped:0,missingTimestamp:0,invalidTimestamp:0,missingDma:0,missingCp:0,invalidValue:0,unknownParameter:0};
    const dmas=new Set();
    try {
      const parts=Math.ceil(upload.rows.length/CHUNK_ROWS);
      for (let part=0;part<parts;part++) {
        const result=await api({action:'importOperationalChunk',batchId:upload.batchId,partIndex:part,isFinal:part===parts-1,rows:upload.rows.slice(part*CHUNK_ROWS,(part+1)*CHUNK_ROWS),totalRows:upload.rows.length,sourceName:upload.file.name,sourceSha256:upload.sha,headers:upload.columns,mapping:map,units:UNITS,defaultDma:byId('ai-filter-district').value});
        const report=result.report;
        for (const key of Object.keys(totals)) totals[key]+=Number(report[key]||0);
        for (const dma of report.affectedDmas||[]) dmas.add(dma);
        setReport('ai-import-report',`Import ${part+1}/${parts} bahagian. Batch ${upload.batchId}. Jika terputus, tekan Import sekali lagi untuk sambung.`);
        if (part<parts-1) await new Promise(resolve=>setTimeout(resolve,1100)); // existing Worker 60 requests/minute limit
      }
      setReport('ai-import-report',`${totals.rowsAccepted?'SELESAI':'GAGAL — tiada baris sah'} — Batch ${upload.batchId}\nBaris ${totals.rowsDetected}; diterima ${totals.rowsAccepted}; ditolak ${totals.rowsRejected}.\nBacaan baharu ${totals.observationsInserted}; pendua ${totals.duplicatesSkipped}; konflik ${totals.conflictsSkipped}.\nMasa tiada ${totals.missingTimestamp}; masa tidak sah ${totals.invalidTimestamp}; DMA tiada ${totals.missingDma}; CP tiada ${totals.missingCp}; nilai tidak sah ${totals.invalidValue}; parameter kosong ${totals.unknownParameter}. DMA terjejas ${dmas.size}.`,!totals.rowsAccepted);
      window.phase2aRefreshReadiness?.(); window.phase2aRefreshStorage?.();
    } catch(error) { setReport('ai-import-report',`Import terhenti: ${error.message}\nBatch ${upload.batchId} boleh disambung semula tanpa pendua.`,true); }
    finally { button.disabled=false; }
  }

  window.phase2aRefreshReadiness = async () => {
    const dma=byId('ai-filter-district')?.value?.trim();
    if (!dma) { setReport('ai-readiness-status','Pilih DMA untuk semak kesediaan.'); return; }
    try {
      const data=await api({action:'getDmaReadiness',dma});
      const r=data.readiness;
      const label={READING_MANUAL:'MANUAL',READING_FROM_SCADA_CSV:'SCADA CSV',SENSOR_CONFIGURED_NO_READING:'Sensor ada, bacaan tiada',SENSOR_NOT_CONFIGURED:'Sensor belum dikonfigurasi',AVAILABLE_LEGACY:'Data lama',MISSING:'Tiada',AVAILABLE:'Ada',PARTIAL:'Terhad',NOT_READY:'Belum sedia'};
      const fmt=value=>label[value]||value;
      const unknown=Object.entries(r.sensorIdentity||{}).filter(([,value])=>value==='UNKNOWN').map(([key])=>key);
      setReport('ai-readiness-status',`${dma}: Flow ${fmt(r.parameters.FLOW)}; inlet ${fmt(r.parameters.INLET_PRESSURE)}; CP ${fmt(r.parameters.CP_PRESSURE)}; night use ${fmt(r.parameters.NIGHT_USE)}.\nAset ${fmt(r.pipeAssets)}; topologi hidraulik ${fmt(r.hydraulicTopology)}. Anomali asas ${fmt(r.analysis.basicAnomaly)}; lokalisasi bocor & simulasi ${fmt(r.analysis.leakLocalisation)}.${unknown.length?` Identiti sensor belum diketahui: ${unknown.join(', ')}.`:''}`);
    } catch(error) { setReport('ai-readiness-status',error.message,true); }
  };

  window.phase2aRefreshStorage = async () => {
    if (localStorage.getItem('sainsUserLevel')!=='ADMIN') return;
    try {
      const data=await api({action:'getStorageStatus'});
      const c=data.counts;
      const size=Number.isFinite(data.databaseBytes)?`${(data.databaseBytes/1048576).toFixed(2)} MiB (${data.databaseBytes} bait, tepat)`:'Tidak tersedia';
      const last=data.lastImport?`\nImport terakhir: ${data.lastImport.source_name} (${data.lastImport.status}), ${data.lastImport.rows_accepted}/${data.lastImport.rows_detected} baris diterima.`:'\nBelum ada import SCADA.';
      setReport('ai-storage-status',`D1 connected · ${size} · disemak ${new Date(data.checkedAt).toLocaleString('ms-MY')}\nAset ${c.assetRows}; segmen paip ${c.pipeSegments}; telemetri ${c.telemetryRows}; ALD ${c.aldRows}; chat ${c.chatRows}; batch import ${c.importBatches}; isu import ${c.importIssues}. Kiraan rekod tepat; pecahan saiz mengikut jadual tidak tersedia.${last}`);
      byId('ai-storage-manage').classList.remove('hidden');
    } catch(error) { setReport('ai-storage-status',error.message,true); }
  };

  function invalidateCleanup() {
    cleanupPreview=null; byId('ai-cleanup-execute').disabled=true;
    byId('ai-cleanup-confirmation').value='';
  }
  async function previewCleanup() {
    invalidateCleanup();
    try {
      const data=await api({action:'previewStorageCleanup',category:byId('ai-cleanup-category').value});
      cleanupPreview=data;
      setReport('ai-cleanup-report',`Kategori: ${data.category}. Rekod layak dipadam: ${data.eligibleCount}.\nDILINDUNGI: ${data.protectedCategories.join(', ')}.\nPratonton tamat dalam 5 minit. Taip CLEANUP jika benar-benar mahu meneruskan.`);
    } catch(error) { setReport('ai-cleanup-report',error.message,true); }
  }
  async function executeCleanup() {
    if (!cleanupPreview || byId('ai-cleanup-confirmation').value!=='CLEANUP') return;
    if (!window.confirm(`Padam ${cleanupPreview.eligibleCount} rekod daripada ${cleanupPreview.category}? Tindakan ini tidak boleh dibatalkan dengan butang Undo.`)) return;
    byId('ai-cleanup-execute').disabled=true;
    try {
      const data=await api({action:'executeStorageCleanup',category:cleanupPreview.category,issuedAt:cleanupPreview.issuedAt,previewToken:cleanupPreview.previewToken,confirmation:'CLEANUP'});
      setReport('ai-cleanup-report',`Cleanup ${data.cleanupId}: dipadam ${data.deletedCount}; baki ${data.afterCount}. Aset ${data.protectedAssets}, segmen ${data.protectedSegments}, garis zon ${data.protectedZoneLines}, ALD ${data.protectedAld} dilindungi.`);
      invalidateCleanup(); window.phase2aRefreshStorage?.();
    } catch(error) { setReport('ai-cleanup-report',error.message,true); invalidateCleanup(); }
  }

  document.addEventListener('DOMContentLoaded',()=>{
    byId('ai-preview-import')?.addEventListener('click',previewImport);
    byId('ai-confirm-import')?.addEventListener('click',importFile);
    byId('ai-refresh-readiness')?.addEventListener('click',window.phase2aRefreshReadiness);
    byId('ai-refresh-storage')?.addEventListener('click',window.phase2aRefreshStorage);
    byId('ai-cleanup-category')?.addEventListener('change',invalidateCleanup);
    byId('ai-cleanup-preview')?.addEventListener('click',previewCleanup);
    byId('ai-cleanup-confirmation')?.addEventListener('input',()=>{byId('ai-cleanup-execute').disabled=!(cleanupPreview&&byId('ai-cleanup-confirmation').value==='CLEANUP');});
    byId('ai-cleanup-execute')?.addEventListener('click',executeCleanup);
    byId('ai-filter-district')?.addEventListener('change',()=>window.phase2aRefreshReadiness?.());
    if (localStorage.getItem('sainsUserLevel')==='ADMIN') window.phase2aRefreshStorage();
  });
})();
