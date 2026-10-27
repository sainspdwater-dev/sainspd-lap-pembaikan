// Presentation-only ASTRA 3.0 results. Never converts partial evidence into approval.
const fmt=(value,digits=2)=>typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits):'tidak tersedia';
const make=(tag,text,className='')=>{const node=document.createElement(tag);node.textContent=String(text);node.className=className;return node;};
function card(target,title,kind,lines){
  const element=document.createElement('section');element.className='rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-gray-600 dark:bg-gray-900';
  element.append(make('p',`${kind} · ${title}`,'mb-1 font-bold text-slate-800 dark:text-white'));
  for(const line of lines)element.append(make('p',line,'mt-1 text-slate-700 dark:text-gray-200'));
  target.append(element);
}
export function summarizeAstra3(report){
  const r=report.results||{},v=r.calculated||[];
  const get=name=>v.find(x=>x.name===name)?.value;
  const messages=[];
  messages.push(`Aset: ${report.assetResolution?.asset?.asset_num||'BELUM DISAHKAN'} (${report.assetResolution?.status||'tidak diketahui'}).`);
  if(get('flow_m3s')!==undefined)messages.push(`Aliran ${fmt(get('flow_m3s'),5)} m³/s = ${fmt(get('flow_ls'))} L/s = ${fmt(get('flow_mld'),3)} MLD — CALCULATED.`);
  if(get('pressure_head_m')!==undefined)messages.push(`Tekanan gauge setara ${fmt(get('pressure_head_m'))} m air pada lokasi input yang belum disahkan — CALCULATED, bukan head sumber.`);
  messages.push(`Model: ${r.model?.readiness?.executionPermission||'DISABLED'}; kapasiti: ${r.capacityClass||'UNRESOLVED_CAPACITY'}; kebocoran aktif: ${r.leakClass||'TIDAK DITENTUKAN'}.`);
  if(report.conflicts?.length)messages.push(`KONFLIK: ${report.conflicts.join(' ')}`);
  return messages.join('\n');
}
export function renderAstra3Report(report,{results,status,evidence,runId}={}){
  if(!report||!results||!status||!evidence)throw Error('Paparan ASTRA 3 tidak lengkap.');
  const r=report.results||{};
  results.replaceChildren();
  status.textContent=`${report.mode==='CLOUDFLARE_AI_TOOL_PLAN'?'Pelan alat AI':'Pelan deterministik TEST'} · ${report.status}.\n${summarizeAstra3(report)}${report.plannerWarning?`\n${report.plannerWarning}`:''}`;
  if(runId)document.getElementById('astra3-run-id').value=runId;
  const asset=report.assetResolution;
  if(asset?.status==='AMBIGUOUS')card(results,'Identiti aset','PERLU PILIHAN',[
    `Beberapa Pipe ID berpadanan: ${(asset.candidates||[]).join(', ')}. Taip satu Pipe ID tepat sebelum model atau solver.`]);
  else if(!asset?.asset)card(results,'Identiti aset','NOT AVAILABLE',[
    'Tiada aset tunggal dalam D1 TEST. Kiraan input yang sah masih dipaparkan; tiada model SAINS diandaikan.']);
  else card(results,'Aset & model','EVIDENCE',[
    `Pipe ID ${asset.asset.asset_num}; DMA ${asset.asset.nrw_zone||'tidak diketahui'}; diameter GIS nominal ${asset.asset.size_mm??'?'} mm.`,
    `Readiness ${r.model?.readiness?.executionPermission||'DISABLED'}; preparation ${r.preparationId||'tidak tersedia'}.`]);
  const values=r.calculated||[];
  if(values.length)card(results,'Pengiraan terus & bersyarat','CALCULATED / CONDITIONAL',values.map(v=>
    `${v.name}: ${fmt(v.value,v.name==='flow_m3s'?5:3)} ${v.unit} · ${v.class} · ${v.source}.${v.warning?` ${v.warning}`:''}`));
  const reason=r.reasoning;
  if(reason){
    card(results,'Data hilang yang benar-benar menjejaskan keputusan','MISSING DATA',
      (reason.items||[]).length?reason.items.slice(0,8).map(i=>`${i.parameter}: ${i.method}. ${i.reason}`):
        ['Tiada jurang tambahan dikesan oleh engine ini; semak kelulusan model dan bukti sensor secara berasingan.']);
    if(reason.headloss)card(results,'Kehilangan head paip bersyarat','SCENARIO ONLY',[
      `${fmt(reason.headloss.lowM,3)}–${fmt(reason.headloss.highM,3)} m untuk C=${reason.headloss.roughnessRange.join('–')}, sumber ${reason.headloss.sourceRef}.`,
      reason.headloss.warning]);
    if(reason.hypotheses?.length)card(results,'Hipotesis yang belum disahkan','EXPLORATORY',
      reason.hypotheses.map(h=>`${h.parameter}: ${h.variants.join(' / ')} (${h.class})`));
  }
  if(r.calibration)card(results,'Kalibrasi','SIMULATED TEST',[
    `Run ${r.calibration.runId}; status ${r.calibration.report?.status}; bukan kelulusan model SAINS.`]);
  if(r.reserve)card(results,'Baki kapasiti','SIMULATED TEST',[
    `Run ${r.reserve.runId}; kelas ${r.capacityClass}; ${r.reserve.report?.reason||'Had senario dalam laporan lanjut.'}`,
    r.capacityClass==='NOT_APPLICABLE_TO_REQUESTED_FLOW'?
      'Simulasi ini menggunakan aliran baseline TEST yang berbeza daripada arahan operator; tiada baki kapasiti untuk aliran diminta boleh disimpulkan.':'Semak batas model TEST sebelum menggunakan senario ini.']);
  else card(results,'Baki kapasiti','NOT AVAILABLE',['Tiada model dan sempadan yang membenarkan pengiraan kapasiti operasi. Tiada peratus reserve dicipta.']);
  if(r.leak)card(results,'Siasatan kebocoran','SIMULATED TEST',[
    `Run ${r.leak.runId}; ${r.leakClass}. Calon bukan pengesahan kebocoran.`]);
  else card(results,'Siasatan kebocoran','NOT AVAILABLE',['Tiada bukti untuk mengesahkan kebocoran aktif. Keutamaan pemeriksaan sahaja boleh dipertimbangkan.']);
  const field=r.recommendation;
  if(field)card(results,'Satu semakan lapangan paling berguna','CADANGAN KUALITATIF',[
    `${field.what} · Lokasi: ${field.where}.`,`${field.when}.`,`${field.reduces}. ${field.why}`]);
  evidence.textContent=`Jejak alat sebenar:\n${(report.steps||[]).map(s=>`${s.tool}: ${s.status}${s.message?` — ${s.message}`:''}`).join('\n')}\n\n`+
    `Konflik: ${(report.conflicts||[]).join('; ')||'tiada yang dikesan'}\n`+
    `Ralat alat: ${(report.errors||[]).join('; ')||'tiada'}\n`+
    `Ketidakpastian: ${JSON.stringify(reason?.uncertainty||{})}\n`+
    `Liputan bukti: ${JSON.stringify(r.evidenceIndex?.coverage||{})}\n`+
    `Rekod bukti dicari: ${r.evidenceIndex?.records?.length||0}; sumber yang NOT_INDEXED tidak dianggap telah disemak.\n`+
    `Had: ${(report.limitations||[]).join(' ')}`;
}
