// Staging-only engineering intake PREVIEW. No network calls, persistence or approval.
const definitions = {
  PIPE: {pipe_id:'TEXT',diameter_mm:'mm',length_m:'m',hazen_c:'1'},
  NODE: {elevation_m:'m',base_demand_m3s:'m3/s'},
  SOURCE: {head_m:'m'},
  VALVE: {type:'TEXT',diameter_mm:'mm',setting:'1',status:'TEXT'},
  PUMP: {curve_ref:'TEXT',status:'TEXT'},
  TANK: {base_elevation_m:'m',initial_level_m:'m',min_level_m:'m',max_level_m:'m',diameter_m:'m'},
  PATTERN: {multipliers_json:'JSON'},
  MODEL: {equipment_inventory_status:'TEXT',demand_allocation_method:'TEXT',temporal_boundary_status:'TEXT'}
};
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
  return {total:checked.length,valid:checked.filter(x=>x.valid).length,invalid:checked.filter(x=>!x.valid).length,
    classes:Object.fromEntries(['VERIFIED','MANUAL','ASSUMED','MISSING'].map(k=>[k,checked.filter(x=>x.record.classification===k).length])),
    firstErrors:checked.flatMap((x,index)=>x.errors.map(error=>`Baris ${index+1}: ${error}`)).slice(0,12),
    reviewStatus:'DRAFT',persisted:false};
}

if (typeof document!=='undefined') document.addEventListener('DOMContentLoaded',()=>{
  const byId=id=>document.getElementById(id);
  const report=message=>{byId('ai-eng-report').textContent=message;};
  const context=()=>({modelId:byId('ai-eng-model').value,version:byId('ai-eng-version').value,
    enteredBy:byId('ai-eng-operator').value});
  const display=(preview,sha='')=>report(`PREVIEW ONLY · ${preview.total} baris; sah format ${preview.valid}; perlu pembetulan ${preview.invalid}.\n`+
    `Dakwaan sumber: VERIFIED ${preview.classes.VERIFIED}, MANUAL ${preview.classes.MANUAL}, ASSUMED ${preview.classes.ASSUMED}, MISSING ${preview.classes.MISSING}.\n`+
    `${sha ? `SHA-256 fail: ${sha}\n` : ''}Semua kekal DRAFT; 0 rekod disimpan. Sahkan identiti aset, nilai dan kelulusan jurutera sebelum migrasi.\n`+
    preview.firstErrors.join('\n'));
  byId('ai-eng-preview-manual')?.addEventListener('click',()=>{
    if (localStorage.getItem('sainsUserLevel')!=='ADMIN') return report('ADMIN sahaja.');
    const row=Object.fromEntries(['entity_type','entity_id','parameter','value','unit','classification','source_ref','effective_at','notes']
      .map(key=>[key,byId(`ai-eng-${({source_ref:'source',effective_at:'effective'}[key]||key).replaceAll('_','-')}`)?.value]));
    display(previewEngineeringRows([row],context()));
  });
  byId('ai-eng-preview-file')?.addEventListener('click',async()=>{
    if (localStorage.getItem('sainsUserLevel')!=='ADMIN') return report('ADMIN sahaja.');
    const file=byId('ai-eng-file').files?.[0];
    if(!file || !/\.(csv|xlsx|xls)$/i.test(file.name) || file.size>2*1024*1024) return report('Pilih CSV/Excel sehingga 2 MiB.');
    try {
      const buffer=await file.arrayBuffer();
      const workbook=window.XLSX.read(buffer,{type:'array',cellDates:false});
      const sheet=workbook.Sheets[workbook.SheetNames[0]];
      const rows=window.XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});
      const digest=await crypto.subtle.digest('SHA-256',buffer);
      const sha=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      display(previewEngineeringRows(rows,context()),sha);
    } catch(error) { report(`Pratonton gagal: ${error.message}`); }
  });
});
