// Staging-only engineering intake PREVIEW. No network calls, persistence or approval.
export const definitions = {
  PIPE: {pipe_id:'TEXT',from_node_id:'TEXT',to_node_id:'TEXT',diameter_mm:'mm',length_m:'m',hazen_c:'1'},
  NODE: {elevation_m:'m',base_demand_m3s:'m3/s'},
  SOURCE: {head_m:'m'},
  VALVE: {type:'TEXT',diameter_mm:'mm',setting:'1',status:'TEXT'},
  PUMP: {curve_ref:'TEXT',status:'TEXT'},
  TANK: {base_elevation_m:'m',initial_level_m:'m',min_level_m:'m',max_level_m:'m',diameter_m:'m'},
  PATTERN: {multipliers_json:'JSON'},
  MODEL: {equipment_inventory_status:'TEXT',demand_allocation_method:'TEXT',temporal_boundary_status:'TEXT'}
};
export const IMPORT_COLUMNS=['entity_type','entity_id','parameter','value','unit','classification','source_ref','effective_at','notes','review_status'];
const positive = new Set(['diameter_mm','length_m','hazen_c','diameter_m']);
const nonnegative = new Set(['base_demand_m3s']);
const trimmed = value => String(value ?? '').trim();
const isoTime = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export function validateEngineeringRow(row, context) {
  const errors=[];
  const entityType=trimmed(row.entity_type).toUpperCase();
  const entityId=trimmed(row.entity_id);
  const parameter=trimmed(row.parameter).toLowerCase();
  const unit=trimmed(row.unit);
  const classification=trimmed(row.classification).toUpperCase();
  const value=trimmed(row.value);
  const sourceRef=trimmed(row.source_ref);
  const effectiveAt=trimmed(row.effective_at);
  const notes=trimmed(row.notes);
  const reviewStatus=trimmed(row.review_status||'DRAFT').toUpperCase();
  const modelId=trimmed(context.modelId);
  const enteredBy=trimmed(context.enteredBy);
  const version=Number(context.version);
  if (!modelId || modelId.length>100 || /^TEST[-_]/i.test(modelId)) errors.push('Model ID SAINS wajib dan tidak boleh TEST.');
  if (!Number.isSafeInteger(version) || version<1) errors.push('Versi model integer positif wajib.');
  if (!enteredBy || enteredBy.length>100) errors.push('Identiti penyedia wajib.');
  if (!definitions[entityType]) errors.push('Jenis entiti tidak disokong.');
  if (!entityId || entityId.length>120) errors.push('Entity ID wajib; jangan cipta ID tanpa bukti.');
  const expectedUnit=definitions[entityType]?.[parameter];
  if (!expectedUnit) errors.push('Parameter tidak disokong untuk entiti.');
  if (!['VERIFIED','MANUAL','ASSUMED','MISSING'].includes(classification)) errors.push('Klasifikasi tidak sah.');
  if (reviewStatus!=='DRAFT') errors.push('Fail import hanya boleh mengandungi review_status DRAFT; kelulusan jurutera dibuat berasingan.');
  if (classification!=='MISSING' && (!value || !sourceRef)) errors.push('Nilai dan rujukan sumber wajib.');
  if (classification==='MISSING' && value) errors.push('MISSING tidak boleh mempunyai nilai.');
  if (classification!=='MISSING' && !isoTime(effectiveAt)) errors.push('Tarikh efektif ISO dengan zon masa wajib.');
  if (expectedUnit && unit!==expectedUnit) errors.push(`Unit mesti ${expectedUnit}.`);
  if (expectedUnit && !['TEXT','JSON'].includes(expectedUnit) && classification!=='MISSING') {
    const numeric=Number(value);
    if (!Number.isFinite(numeric) || (positive.has(parameter) && numeric<=0) ||
        (nonnegative.has(parameter) && numeric<0) || Math.abs(numeric)>1e9) errors.push('Nilai angka di luar had.');
  }
  if (expectedUnit==='JSON' && classification!=='MISSING') {
    try { const values=JSON.parse(value); if(!Array.isArray(values)||!values.length||
      values.some(x=>typeof x!=='number'||!Number.isFinite(x)||x<0)) errors.push('Corak permintaan JSON tidak sah.'); }
    catch { errors.push('Corak permintaan mesti array JSON.'); }
  }
  if (parameter==='pipe_id' && classification!=='MISSING' && !/^(asset|import|as-built):/i.test(sourceRef))
    errors.push('Pipe ID memerlukan rujukan asset/import/as-built yang boleh diaudit.');
  if (parameter==='length_m' && /GEOMETRY_DERIVED/i.test(sourceRef) && classification==='VERIFIED')
    errors.push('Panjang terbitan geometri tidak boleh dilabel VERIFIED.');
  if (parameter==='hazen_c' && classification==='ASSUMED' &&
      (!/material=/i.test(notes) || !/table_version=/i.test(notes)))
    errors.push('Andaian Hazen-Williams memerlukan material=... dan table_version=... dalam nota.');
  if (parameter==='base_demand_m3s' && classification!=='MISSING' && !/allocation=/i.test(notes))
    errors.push('Permintaan nod memerlukan kaedah agihan dalam nota: allocation=...');
  return {valid:errors.length===0,errors,record:{modelId,version,entityType,entityId,parameter,value,unit,
    classification,sourceRef,effectiveAt,enteredBy,enteredAt:new Date().toISOString(),notes,reviewStatus:'DRAFT',
    isTestData:false}};
}

export function previewEngineeringRows(rows, context) {
  if (!Array.isArray(rows) || rows.length>2000) throw new Error('Had pratonton: 2,000 baris.');
  const checked=rows.map(row=>validateEngineeringRow(row,context));
  const seen=new Map();
  checked.forEach((item,index)=>{
    if(!item.valid)return;
    const key=[item.record.entityType,item.record.entityId,item.record.parameter].join('\u0000');
    const prior=seen.get(key);
    if(prior!==undefined){
      item.valid=false;
      item.errors.push(`Parameter pendua/berkonflik dengan baris ${prior+1}; semak satu nilai berkuat kuasa sahaja.`);
    }else seen.set(key,index);
  });
  return {total:checked.length,valid:checked.filter(x=>x.valid).length,invalid:checked.filter(x=>!x.valid).length,
    classes:Object.fromEntries(['VERIFIED','MANUAL','ASSUMED','MISSING'].map(k=>[k,checked.filter(x=>x.record.classification===k).length])),
    firstErrors:checked.flatMap((x,index)=>x.errors.map(error=>`Baris ${index+1}: ${error}`)).slice(0,12),
    reviewStatus:'DRAFT',persisted:false};
}

if (typeof document!=='undefined') document.addEventListener('DOMContentLoaded',()=>{
  const byId=id=>document.getElementById(id);
  const fields=IMPORT_COLUMNS;
  const aliases={source_ref:'source',effective_at:'effective'};
  const report=message=>{byId('ai-eng-report').textContent=message;};
  const selectedDma=()=>byId('ai-filter-district')?.value?.trim()||'';
  const context=()=>({modelId:byId('ai-eng-model').value,version:byId('ai-eng-version').value,
    enteredBy:byId('ai-eng-operator').value});
  let fileRows=null,sourceSha256='',pending=null;
  const reset=()=>{pending=null;byId('ai-eng-save').disabled=true;byId('ai-eng-confirm').checked=false;};
  const api=async body=>{
    const response=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',
      'Authorization':`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
    return data;
  };
  const base=()=>({dma:selectedDma(),modelId:context().modelId,version:Number(context().version)});
  const preview=async rows=>{
    reset();
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN')return report('ADMIN sahaja.');
    if(!selectedDma())return report('Pilih satu DMA operasi daripada dropdown District Metered Area dahulu.');
    const local=previewEngineeringRows(rows,context());
    report(`VALIDASI SETEMPAT · ${local.valid} diterima; ${local.invalid} ditolak. ${local.firstErrors.join(' | ')}\nBelum disimpan.`);
    if(local.invalid)return;
    try{
      const result=await api({action:'previewHydraulicIntake',...base(),rows,sourceSha256});
      const p=result.preview;
      report(`PRATONTON DMA ${selectedDma()} · ${p.accepted} diterima; ${p.rejected} ditolak.\n`+
        `VERIFIED ${p.classes.VERIFIED}; MANUAL ${p.classes.MANUAL}; ASSUMED ${p.classes.ASSUMED}; MISSING ${p.classes.MISSING}.\n`+
        `${sourceSha256?`SHA-256 fail: ${sourceSha256}\n`:''}${[...p.firstErrors,...p.conflicts].join('\n')}\n${p.message}`);
      if(p.confirmationHash){pending={rows,hash:p.confirmationHash,dma:selectedDma(),modelId:base().modelId,version:base().version,sha:sourceSha256};
        byId('ai-eng-save').disabled=false;}
    }catch(error){report(`Belum boleh disimpan: ${error.message}\nPratonton setempat tidak membuktikan model/DMA telah didaftarkan.`);}
  };
  const manualRow=()=>Object.fromEntries(fields.map(key=>[key,byId(`ai-eng-${(aliases[key]||key).replaceAll('_','-')}`)?.value]));
  byId('ai-eng-preview-manual')?.addEventListener('click',()=>{sourceSha256='';preview([manualRow()]);});
  byId('ai-eng-find-model')?.addEventListener('click',async()=>{
    reset();if(!selectedDma())return report('Pilih DMA dahulu.');
    try{const data=await api({action:'listHydraulicModelsForDma',dma:selectedDma()});
      if(!data.models.length)return report(`Tiada model berdaftar bagi ${selectedDma()}. Semak nama DMA dan GIS sebelum daftar model DRAFT.`);
      byId('ai-eng-model').value=data.models[0].model_id;byId('ai-eng-version').value=data.models[0].version;
      report(`Model ${data.models[0].model_id} v${data.models[0].version} · ${data.models[0].validation_status}. Pilih rekod sebenar dan pratonton dahulu.`);
    }catch(error){report(`Senarai model tidak tersedia: ${error.message}`);}
  });
  byId('ai-eng-register-model')?.addEventListener('click',async()=>{
    reset();if(!selectedDma())return report('Pilih DMA dahulu.');
    if(!window.confirm(`Daftar model DRAFT untuk DMA tepat: ${selectedDma()}? Ini tidak membenarkan simulasi.`))return;
    try{const data=await api({action:'registerHydraulicDraftModel',dma:selectedDma(),confirm:true});
      byId('ai-eng-model').value=data.modelId;byId('ai-eng-version').value=data.version;
      report(`Model DRAFT ${data.modelId} v${data.version} didaftarkan bagi ${data.dma}. STEADY-STATE dan baseline masih NOT READY.`);
      window.phase2bRefreshHydraulic?.();
    }catch(error){report(`Model tidak didaftarkan: ${error.message}`);}
  });
  const mapFields=()=>{
    const keys=Object.keys(fileRows?.[0]||{}),panel=byId('ai-eng-column-map');panel.replaceChildren();
    for(const field of fields){
      const label=document.createElement('label');label.textContent=field.replaceAll('_',' ');
      const select=document.createElement('select');select.id=`ai-eng-map-${field}`;select.className='form-input text-xs';
      const blank=document.createElement('option');blank.value='';blank.textContent='—';select.append(blank);
      for(const key of keys){const option=document.createElement('option');option.value=key;option.textContent=key;select.append(option);}
      select.value=keys.find(key=>key.toLowerCase().replace(/[\s-]+/g,'_')===field)||'';
      select.addEventListener('change',reset);label.append(select);panel.append(label);
    }
  };
  byId('ai-eng-file')?.addEventListener('change',()=>{fileRows=null;sourceSha256='';byId('ai-eng-column-map').replaceChildren();reset();});
  byId('ai-eng-preview-file')?.addEventListener('click',async()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN')return report('ADMIN sahaja.');
    const file=byId('ai-eng-file').files?.[0];
    if(!file||!/\.(csv|xlsx|xls)$/i.test(file.name)||file.size>2*1024*1024)return report('Pilih CSV/Excel sehingga 2 MiB.');
    try{
      if(!fileRows){
        const buffer=await file.arrayBuffer();
        const workbook=window.XLSX.read(buffer,{type:'array',cellDates:false});
        fileRows=window.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{defval:'',raw:false});
        if(fileRows.length<1||fileRows.length>200)throw new Error('Fail mesti mempunyai 1–200 baris setiap batch.');
        const digest=await crypto.subtle.digest('SHA-256',buffer);
        sourceSha256=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
        mapFields();report('Fail dibaca. Semak pemetaan kolum, kemudian tekan Pratonton fail kejuruteraan sekali lagi. Tiada data disimpan.');return;
      }
      const mapped=fileRows.map(row=>Object.fromEntries(fields.map(field=>[field,row[byId(`ai-eng-map-${field}`).value]??''])));
      await preview(mapped);
    }catch(error){fileRows=null;report(`Pratonton gagal: ${error.message}`);}
  });
  byId('ai-eng-save')?.addEventListener('click',async()=>{
    if(!pending||!byId('ai-eng-confirm').checked)return report('Semak pratonton dan tandakan pengesahan sebelum simpan.');
    if(selectedDma()!==pending.dma||base().modelId!==pending.modelId||base().version!==pending.version)return report('DMA/model/versi telah berubah. Pratonton semula.');
    byId('ai-eng-save').disabled=true;
    try{const result=await api({action:'saveHydraulicDraft',...base(),rows:pending.rows,sourceSha256:pending.sha,
      confirmationHash:pending.hash,confirm:true});
      report(`${result.saved} rekod DRAFT disimpan untuk ${pending.dma}. Belum diluluskan; baseline masih dikunci.`);
      window.phase2bRefreshHydraulic?.();
    }catch(error){report(`Simpan gagal: ${error.message}`);}finally{reset();}
  });
  const loadReviews=async()=>{
    const panel=byId('ai-eng-reviews');panel.replaceChildren();
    try{const data=await api({action:'getHydraulicIntake',...base()});
      if(!data.reviews.length){panel.textContent='Tiada rekod semakan untuk model/versi DMA ini.';return;}
      for(const row of data.reviews){const line=document.createElement('div');line.className='border-b py-1';
        line.textContent=`${row.entity_type}/${row.entity_id}/${row.parameter_name}: ${row.value_real??row.value_text??'MISSING'} ${row.unit||''} · ${row.classification} · ${row.review_status} · ${row.source_ref||'tiada sumber'} · ${row.effective_at||'tiada masa'} · oleh ${row.entered_by}`;
        if(row.review_status==='DRAFT')for(const decision of ['APPROVED','REJECTED']){
          const button=document.createElement('button');button.type='button';button.className='ml-2 underline text-violet-700';
          button.textContent=decision==='APPROVED'?'Luluskan':'Tolak';
          button.addEventListener('click',async()=>{
            const note=window.prompt(`Alasan ${decision} untuk ${row.entity_type}/${row.entity_id}/${row.parameter_name} (minimum 8 aksara):`);
            if(note===null)return;
            try{await api({action:'reviewHydraulicDraft',...base(),entryId:row.entry_id,decision,note});
              report(`Semakan ${decision} direkod secara append-only. Readiness disemak semula; baseline kekal dikunci sehingga semua gerbang lulus.`);
              await loadReviews();window.phase2bRefreshHydraulic?.();
            }catch(error){report(`Semakan gagal: ${error.message}`);}
          });line.append(button);
        }
        panel.append(line);}
    }catch(error){panel.textContent=`Rekod tidak tersedia: ${error.message}`;}
  };
  byId('ai-eng-load-reviews')?.addEventListener('click',loadReviews);
  byId('ai-filter-district')?.addEventListener('change',()=>{reset();report('DMA berubah; pratonton semula sebelum menyimpan.');});
  for(const id of ['ai-eng-model','ai-eng-version','ai-eng-operator'])byId(id)?.addEventListener('input',reset);
});

