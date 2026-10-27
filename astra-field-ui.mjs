import {MAX_FIELD_FILE_BYTES,MAX_FIELD_ROWS,FIELD_NAMES,detectFieldColumns,parseFieldCsv,
  mapFieldRows,normalizeFieldObservation,calculateBasicHydraulics,flowToM3s,pressureToKpa,inferPressureUnitFromHeader,
  extractBasicInputsFromCommand} from './astra-field-core.mjs';
import {updateAstraMapState} from './astra-maps.mjs';
import {planAstraTestCommand} from './astra-command-core.mjs';
import {renderAstra3Report} from './astra3-results.mjs';

const el=id=>document.getElementById(id);
const status=message=>{el('astra-field-status').textContent=message;};
let fileRows=[],fileMeta=null,observations=[],previewLayer=null,sourceKind='MANUAL';
let candidateLayer=null,modelLayer=null,calibrationLayer=null,analysisLayer=null,currentDatasetId=null,currentRunId=null,matchResults=[],selectedObservation=0;
let modelPreparation=null,preparedQuery=null,calibrationReport=null;
let pendingMapClick=null;
const mapping={};
const label={latitude:'Latitude *',longitude:'Longitude *',pressure:'Tekanan *',pressureUnit:'Unit tekanan',
  pressureType:'Jenis tekanan',timestamp:'Timestamp ISO',date:'Tarikh',time:'Masa',timezone:'Zon masa',
  sensorId:'ID sensor',siteName:'Nama lokasi',pipeId:'Pipe ID (petunjuk)',dma:'DMA (petunjuk)',
  elevationM:'Elevasi (m)',flow:'Aliran',flowUnit:'Unit aliran',notes:'Nota'};

function clearForNewSource(){observations=[];currentDatasetId=null;currentRunId=null;matchResults=[];
  el('astra-match-dataset-id').value='';el('astra-match-run-id').value='';
  el('astra-match-results').replaceChildren();el('astra-match-status').textContent='Sumber berubah; simpan set baharu sebelum mencari calon.';
  el('astra-field-confirm').checked=false;el('astra-field-save').disabled=true;renderTable();paintCandidateLines();}
function defaults(){return {pressureUnit:el('astra-field-pressure-unit').value,pressureType:el('astra-field-pressure-type').value,
  timezone:el('astra-field-timezone').value};}
function paintMarkers(){
  if((typeof aiAgentMap==='undefined'||!aiAgentMap)&&typeof initAiAgentMap==='function')initAiAgentMap();
  if(typeof aiAgentMap==='undefined'||!aiAgentMap||typeof L==='undefined')return;
  if(previewLayer)aiAgentMap.removeLayer(previewLayer);
  previewLayer=L.featureGroup();
  observations.forEach((row,index)=>L.circleMarker([row.latitude,row.longitude],{radius:7,color:index===selectedObservation?'#dc2626':'#0891b2',fillOpacity:0.8})
    .bindPopup(`ASTRA DRAFT • titik ${index+1}<br>Lat ${row.latitude.toFixed(6)}, Lng ${row.longitude.toFixed(6)}<br>${row.originalPressure} ${row.originalPressureUnit} (${row.pressureType})<br>Belum dipadankan ke paip/nod.`)
    .on('click',()=>selectObservation(index))
    .addTo(previewLayer));
  previewLayer.addTo(aiAgentMap);
  if(observations.length){const bounds=previewLayer.getBounds?.();if(bounds?.isValid?.())aiAgentMap.fitBounds(bounds.pad(0.25),{maxZoom:16});}
  paintCandidateLines();
}
function paintCandidateLines(){
  if(typeof aiAgentMap==='undefined'||!aiAgentMap||typeof L==='undefined')return;
  if(candidateLayer)aiAgentMap.removeLayer(candidateLayer);
  candidateLayer=L.featureGroup();
  const selected=matchResults[selectedObservation];
  for(const candidate of selected?.candidates||[]){
    const geometry=candidate.geometry;
    if(!geometry)continue;
    L.geoJSON({type:'Feature',geometry,properties:{}},{style:{color:candidate.geometrySource==='DRAFT_GIS'?'#f97316':
      candidate.dmaRelation==='CROSS_DMA'?'#dc2626':'#7c3aed',weight:candidate.rank===1?6:4,
      dashArray:candidate.geometrySource==='DRAFT_GIS'?'5 5':null}}
    ).addTo(candidateLayer);
  }
  candidateLayer.addTo(aiAgentMap);
}
function renderTable(){
  const target=el('astra-field-table');target.replaceChildren();
  if(!observations.length){if(previewLayer&&typeof aiAgentMap!=='undefined'&&aiAgentMap){aiAgentMap.removeLayer(previewLayer);previewLayer=null;}return;}
  const table=document.createElement('table');table.className='w-full text-left text-[11px] border-collapse';
  const headings=['#','Lat','Lng','Tekanan asal','Jenis','Masa','Padanan'];
  const header=document.createElement('tr');for(const value of headings){const th=document.createElement('th');th.textContent=value;th.className='border p-1';header.append(th);}table.append(header);
  observations.forEach((row,index)=>{const tr=document.createElement('tr');
    [index+1,row.latitude,row.longitude,`${row.originalPressure} ${row.originalPressureUnit}`,row.pressureType,
      row.timestamp||'Tiada masa (bukan untuk kalibrasi)', 'BELUM DIPADANKAN'].forEach(value=>{
      const td=document.createElement('td');td.textContent=String(value);td.className='border p-1';tr.append(td);
    });table.append(tr);});target.append(table);paintMarkers();
}
function renderMapping(headers,detected){
  const target=el('astra-field-mapping');target.replaceChildren();
  for(const field of FIELD_NAMES){
    const wrapper=document.createElement('label');wrapper.textContent=label[field]||field;
    const select=document.createElement('select');select.className='form-input text-xs';select.setAttribute('aria-label',`Kolum ${field}`);
    const blank=document.createElement('option');blank.value='';blank.textContent='Tidak dipetakan';select.append(blank);
    for(const header of headers){const option=document.createElement('option');option.value=header;option.textContent=header;select.append(option);}
    select.value=detected.mapping[field]||'';mapping[field]=select.value;
    select.addEventListener('change',()=>{mapping[field]=select.value;clearForNewSource();status('Pemetaan berubah; jalankan pratonton semula sebelum menyimpan.');});
    wrapper.append(select);target.append(wrapper);
  }
  const warning=detected.ambiguous.length?`Kolum samar: ${detected.ambiguous.join(', ')}. Pilih padanan secara manual.`:'';
  const inferred=inferPressureUnitFromHeader(detected.mapping.pressure);
  if(inferred&&!el('astra-field-pressure-unit').value)el('astra-field-pressure-unit').value=inferred;
  status(`Fail dibaca: ${fileRows.length} baris. Semak pemetaan kolum, unit dan jenis tekanan sebelum pratonton.${inferred?`\nUnit ${inferred} dicadangkan daripada tajuk kolum; sila sahkan.`:''}${warning?`\n${warning}`:''}`);
}
async function readFile(file){
  if(!file||file.size>MAX_FIELD_FILE_BYTES)throw new Error('Fail kosong atau melebihi 2 MiB.');
  const extension=file.name.split('.').pop().toLowerCase();
  if(!['csv','xlsx','json'].includes(extension))throw new Error('Hanya CSV, XLSX atau JSON dibenarkan.');
  let rows;
  if(extension==='csv')rows=parseFieldCsv(await file.text());
  else if(extension==='json'){
    rows=JSON.parse(await file.text());
    if(!Array.isArray(rows)||!rows.every(row=>row&&typeof row==='object'&&!Array.isArray(row)))
      throw new Error('JSON mesti array objek bacaan.');
  }else{
    if(typeof XLSX==='undefined')throw new Error('Pembaca XLSX sedia ada belum dimuatkan.');
    const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:false});
    rows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{defval:'',raw:false});
  }
  if(!rows.length||rows.length>MAX_FIELD_ROWS)throw new Error(`Fail perlu ada 1–${MAX_FIELD_ROWS} bacaan.`);
  const headers=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  const fileBytes=await file.arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',fileBytes);
  const fileHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  clearForNewSource();fileRows=rows;fileMeta={sourceName:file.name,sourceFileSha256:fileHash};sourceKind=extension.toUpperCase();
  renderMapping(headers,detectFieldColumns(headers));
}
function fromManual(){
  if(fileRows.length){fileRows=[];fileMeta=null;clearForNewSource();}
  if(observations.length>=MAX_FIELD_ROWS)throw new Error(`Maksimum ${MAX_FIELD_ROWS} titik manual.`);
  const raw={latitude:el('astra-manual-lat').value,longitude:el('astra-manual-lng').value,
    pressure:el('astra-manual-pressure').value,timestamp:el('astra-manual-timestamp').value,
    sensorId:el('astra-manual-sensor').value,siteName:el('astra-manual-site').value};
  const observation=normalizeFieldObservation(raw,defaults());
  observations.push(observation);sourceKind='MANUAL';fileMeta={sourceName:'Bacaan manual ASTRA',sourceFileSha256:null};
  el('astra-field-confirm').checked=false;el('astra-field-save').disabled=true;
  renderTable();status(`${observations.length} bacaan manual dalam pratonton. Semua DRAFT dan belum dipadankan.`);
}
function chooseManualPointOnMap(){
  if((typeof aiAgentMap==='undefined'||!aiAgentMap)&&typeof initAiAgentMap==='function')initAiAgentMap();
  if(typeof aiAgentMap==='undefined'||!aiAgentMap)throw new Error('Peta AI Agent belum tersedia.');
  if(pendingMapClick)aiAgentMap.off('click',pendingMapClick);
  pendingMapClick=event=>{
    el('astra-manual-lat').value=event.latlng.lat.toFixed(6);
    el('astra-manual-lng').value=event.latlng.lng.toFixed(6);
    pendingMapClick=null;
    status('Koordinat diambil daripada klik peta. Isi tekanan sebenar, pilih unit/jenis dan tambah titik ke pratonton. Lokasi ini belum dipadankan ke paip/nod.');
  };
  aiAgentMap.once('click',pendingMapClick);
  status('Klik lokasi bacaan sebenar pada peta AI Agent. Ini hanya mengisi koordinat DRAFT; ia bukan padanan paip/nod.');
}
function previewFile(){
  if(!fileRows.length)throw new Error('Pilih fail dahulu, kemudian semak pemetaan kolum.');
  const result=mapFieldRows(fileRows,mapping,defaults());
  if(result.issues.length){observations=[];renderTable();throw new Error(result.issues.slice(0,5).map(item=>`Baris ${item.row}: ${item.message}`).join('\n')+
    (result.issues.length>5?`\n... ${result.issues.length-5} isu lagi.`:''));}
  observations=result.observations;el('astra-field-confirm').checked=false;el('astra-field-save').disabled=true;
  renderTable();status(`${observations.length} bacaan sah secara format; ${observations.filter(row=>!row.timestamp).length} tanpa masa tidak layak untuk perbandingan berasaskan masa. Tiada paip/nod disahkan.`);
}
function apiUrl(){
  const local=['localhost','127.0.0.1'].includes(location.hostname);
  const override=local?new URLSearchParams(location.search).get('astraFieldApi'):null;
  if(local&&!override)throw new Error('Simpanan localhost memerlukan Worker setempat berasingan (?astraFieldApi=http://127.0.0.1:8787/). Tiada data dihantar ke produksi.');
  if(!override)return WORKER_URL;
  const url=new URL(override);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('API setempat mesti localhost sahaja.');
  return url.href;
}
async function callWorker(action,body){
  const response=await fetch(apiUrl(),{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify({action,...body})});
  const result=await response.json();
  if(!response.ok||result.status!=='success')throw new Error((result.message||`API menolak permintaan (${response.status}).`)+
    (result.assets?.length?` Pilih satu Pipe ID tepat: ${result.assets.map(a=>a.pipeId).join(', ')}.`:''));
  return result;
}
async function saveDataset(){
  if(!observations.length||!el('astra-field-confirm').checked)throw new Error('Pratonton dan pengesahan DRAFT wajib dahulu.');
  const button=el('astra-field-save');button.disabled=true;
  const body={sourceKind,sourceName:fileMeta.sourceName,sourceFileSha256:fileMeta.sourceFileSha256,observations};
  try{
    status('Menghantar pratonton ke API berautoriti. Belum menulis D1...');
    const preview=await callWorker('previewAstraFieldDataset',body);
    status(`API mengesahkan ${preview.preview.rowCount} bacaan; ${preview.preview.untimedCount} tanpa masa. Menyimpan DRAFT...`);
    const saved=await callWorker('saveAstraFieldDataset',{...body,confirm:true,confirmationHash:preview.preview.confirmationHash});
    currentDatasetId=saved.datasetId;el('astra-match-dataset-id').value=saved.datasetId;
    status(`DRAFT disimpan: ${saved.datasetId} (${saved.rowCount} bacaan${saved.reused?', fail pendua digunakan semula':''}). Tiada aset dipadankan, model diubah atau simulasi dimulakan.`);
  }finally{button.disabled=!observations.length||!el('astra-field-confirm').checked;}
}
async function loadDataset(){
  const id=el('astra-match-dataset-id').value.trim();
  if(!id)throw Error('Masukkan Dataset ID daripada simpanan DRAFT dahulu.');
  const saved=await callWorker('getAstraFieldDataset',{datasetId:id});
  currentDatasetId=id;currentRunId=null;matchResults=[];selectedObservation=0;
  el('astra-match-run-id').value='';el('astra-match-results').replaceChildren();
  observations=saved.observations.map(row=>({observationId:row.observation_id,latitude:row.latitude,
    longitude:row.longitude,originalPressure:row.original_pressure,originalPressureUnit:row.original_pressure_unit,
    pressureType:row.pressure_type,timestamp:row.measured_at,siteName:row.site_name,sensorId:row.sensor_id}));
  renderTable();status(`${observations.length} bacaan DRAFT diambil semula daripada D1. Tiada paip/nod disahkan.`);
  el('astra-match-status').textContent=`DRAFT ${id} diambil semula daripada D1: ${observations.length} bacaan. Belum dipadankan.`;
}
function button(text,handler,style='border border-cyan-700'){
  const element=document.createElement('button');element.type='button';element.textContent=text;
  element.className=`rounded px-2 py-1 mr-1 mt-1 ${style}`;
  element.addEventListener('click',guard(handler));return element;
}
function selectObservation(index){selectedObservation=index;renderMatches();paintCandidateLines();
  if(previewLayer?.eachLayer)previewLayer.eachLayer((layer,i)=>layer.setStyle?.({color:i===index?'#dc2626':'#0891b2'}));}
function renderMatches(){
  const target=el('astra-match-results');target.replaceChildren();
  if(!matchResults.length)return;
  const tabs=document.createElement('div');tabs.className='flex flex-wrap gap-1';
  matchResults.forEach((result,index)=>tabs.append(button(`Titik ${index+1}${index===selectedObservation?' ✓':''}`,
    ()=>selectObservation(index),index===selectedObservation?'bg-cyan-700 text-white':'border border-cyan-700')));
  target.append(tabs);
  const result=matchResults[selectedObservation];if(!result)return;
  const summary=document.createElement('p');summary.className='mt-2 font-semibold';
  summary.textContent=`Titik ${selectedObservation+1} • ${result.dma?.status||'UNRESOLVED'} • DMA: ${(result.dma?.approved||[]).join(', ')||'tiada yang diluluskan'} • ${result.candidates.length} calon teratas${result.candidateCount>result.candidates.length?` daripada ${result.candidateCount}`:''}`;
  target.append(summary);
  if(!result.candidates.length){const p=document.createElement('p');p.textContent='Tiada paip dalam jejari ini. Semak koordinat, polygon dan jejari; jangan pilih paip jauh sebagai ganti.';target.append(p);}
  for(const c of result.candidates){
    const box=document.createElement('div');box.className='mt-2 rounded border p-2';
    const title=document.createElement('p');title.className='font-semibold';
    title.textContent=`#${c.rank} ${c.pipeId||'Pipe ID tidak diketahui'} • ${c.distanceM} m • ${c.status}`;box.append(title);
    for(const text of [`DMA paip: ${c.dmaName||'tidak diketahui'} (${c.dmaRelation})`,
      `Nod: ${c.nodeId||'tiada nod disahkan'} • geometri ${c.geometrySource}`,...(c.reasons||[])]){
      const p=document.createElement('p');p.textContent=text;box.append(p);
    }
    box.append(button('Tunjuk pada peta',()=>{
      selectObservation(selectedObservation);
      if(typeof aiAgentMap!=='undefined'&&aiAgentMap&&c.geometry&&typeof L!=='undefined'){
        const bounds=L.geoJSON({type:'Feature',geometry:c.geometry,properties:{}}).getBounds();
        if(bounds.isValid())aiAgentMap.fitBounds(bounds.pad(0.3),{maxZoom:17});
      }
    }));
    if(c.geometrySource==='ACTIVE_GIS'&&c.dmaRelation==='SAME_DMA'&&
      ['GEOGRAPHICALLY_NEAR','NETWORK_COMPATIBLE'].includes(c.status)){
      const evidence=document.createElement('input');evidence.className='form-input text-xs mt-1';
      evidence.placeholder='Rujukan bukti semakan (wajib, bukan anggaran)';
      evidence.setAttribute('aria-label',`Bukti calon ${c.rank}`);box.append(evidence);
      box.append(button('Sahkan calon',async()=>{
        if(!evidence.value.trim())throw Error('Rujukan bukti semakan wajib sebelum sahkan calon.');
        const response=await callWorker('reviewAstraMatch',{runId:currentRunId,observationId:result.observationId,
          rankNumber:c.rank,decision:'CONFIRM',evidenceRef:evidence.value.trim()});
        el('astra-match-status').textContent=`Semakan direkod: ${response.resultingStatus}. Ini bukan HYDRAULICALLY_VERIFIED dan tidak mengubah model.`;
      },'bg-emerald-700 text-white'));
    }
    box.append(button('Tolak calon',async()=>{
      await callWorker('reviewAstraMatch',{runId:currentRunId,observationId:result.observationId,rankNumber:c.rank,decision:'REJECT'});
      el('astra-match-status').textContent='Penolakan direkod dalam sejarah audit.';
    }));target.append(box);
  }
  target.append(button('Tanda belum selesai',async()=>{
    await callWorker('reviewAstraMatch',{runId:currentRunId,observationId:result.observationId,decision:'UNRESOLVED'});
    el('astra-match-status').textContent='Titik kekal UNRESOLVED; tidak digunakan sebagai input model.';
  }));
  target.append(button('Lihat sejarah semakan',async()=>{
    const history=await callWorker('getAstraMatchHistory',{observationId:result.observationId});
    el('astra-match-status').textContent=history.decisions.length?
      history.decisions.map(d=>`${d.decided_at}: ${d.decision} → ${d.resulting_status} (${d.evidence_ref||'tanpa rujukan'})`).join('\n'):
      'Belum ada keputusan semakan untuk titik ini.';
  }));
}
async function runMatching(){
  const datasetId=el('astra-match-dataset-id').value.trim();if(!datasetId)throw Error('Simpan atau ambil semula Dataset ID dahulu.');
  if(currentDatasetId!==datasetId||!observations.length)await loadDataset();
  const searchRadiusM=Number(el('astra-match-radius').value);
  el('astra-match-status').textContent='Mencari calon geometri dan topologi dalam D1 setempat...';
  const found=await callWorker('runAstraAssetMatching',{datasetId,searchRadiusM});
  currentDatasetId=datasetId;currentRunId=found.runId;el('astra-match-run-id').value=found.runId;
  matchResults=found.results;selectedObservation=0;renderMatches();paintCandidateLines();
  el('astra-match-status').textContent=`Run ${found.runId} direkod (${found.algorithmVersion}). Semua calon perlu semakan; tiada model diubah.`;
}
async function loadRun(){
  const runId=el('astra-match-run-id').value.trim();if(!runId)throw Error('Masukkan Run ID dahulu.');
  const saved=await callWorker('getAstraMatchRun',{runId});
  if(currentDatasetId!==saved.run.dataset_id||!observations.length){
    el('astra-match-dataset-id').value=saved.run.dataset_id;await loadDataset();el('astra-match-run-id').value=runId;
  }
  currentRunId=runId;
  matchResults=saved.observations.map(o=>({observationId:o.observation_id,rowNumber:o.row_number,
    dma:{status:o.dma_status,approved:o.approvedDma||[],draft:o.draftDma||[]},
    candidates:saved.candidates.filter(c=>c.observation_id===o.observation_id).map(c=>({
      rank:c.rank_number,pipeId:c.pipe_id,geometrySource:c.geometry_source,geometry:c.geometry,
      distanceM:c.distance_m,dmaName:c.dma_name,dmaRelation:c.dma_relation,nodeId:c.node_id,
      status:c.match_status,reasons:c.reasons||[]}))}));
  selectedObservation=0;renderMatches();paintCandidateLines();
  el('astra-match-status').textContent=`Run ${runId} diambil semula daripada D1; keputusan semakan tersedia melalui Sejarah.`;
}
function fromCommand(){
  const instruction=el('ai-chat-input')?.value||'';
  const parsed=extractBasicInputsFromCommand(instruction);
  const calibrationTarget=instruction.match(/(?:calibration|kalibrasi)\s+model\s+(.+?)(?:\s+berdasarkan|[,.;]|$)/i);
  if(!parsed.assetQuery&&calibrationTarget)parsed.assetQuery=calibrationTarget[1].trim().slice(0,100);
  if(parsed.diameterMm!==null)el('astra-calc-diameter').value=parsed.diameterMm;
  if(parsed.flow!==null){el('astra-calc-flow').value=parsed.flow;el('astra-calc-flow-unit').value=parsed.flowUnit;}
  if(parsed.pressure!==null){el('astra-calc-pressure').value=parsed.pressure;el('astra-calc-pressure-unit').value=parsed.pressureUnit;}
  if(parsed.assetQuery)el('astra-asset-query').value=parsed.assetQuery;
  if(parsed.assetQuery)el('astra-model-query').value=parsed.assetQuery;
  el('astra-calc-result').textContent='Nilai jelas daripada arahan telah disalin. Sahkan jenis tekanan gauge dan diameter dalaman sebelum menekan Kira. Tiada aset dipadankan secara automatik.';
}
function runCalculation(){
  const result=calculateBasicHydraulics({diameterMm:el('astra-calc-diameter').value,flow:el('astra-calc-flow').value,
    flowUnit:el('astra-calc-flow-unit').value,pressure:el('astra-calc-pressure').value,
    pressureUnit:el('astra-calc-pressure-unit').value,pressureType:'GAUGE',
    internalDiameterVerified:el('astra-calc-internal-verified').checked});
  el('astra-calc-result').textContent=`CALCULATED — aliran ${result.flowM3s.toFixed(5)} m³/s = ${result.flowLs.toFixed(2)} L/s = ${result.flowMld.toFixed(3)} MLD.\n`+
    `Luas keratan ${result.areaM2.toFixed(5)} m²; halaju purata ${result.velocityMs.toFixed(3)} m/s.\n`+
    `Tekanan gauge ${result.pressureKpa.toFixed(2)} kPa; pressure head ${result.pressureHeadM.toFixed(2)} m air (ρ=1000 kg/m³, g=9.80665 m/s²).\n`+
    `${result.diameterBasis==='INTERNAL_VERIFIED'?'Diameter DALAMAN ditandakan disahkan oleh operator.':'Diameter nominal DIANDAIKAN sama dengan diameter dalaman; semak aset/as-built.'}\n${result.limitation}\n`+
    `Input model seterusnya: Pipe ID dan panjang kejuruteraan, from/to node yang disahkan, elevasi, demand, source head serta keadaan injap/pam/tangki. Tiada reserve margin atau leak disimpulkan.`;
}
async function searchAssetContext(){
  const assetQuery=el('astra-asset-query').value.trim();
  if(!assetQuery)throw Error('Masukkan Pipe ID atau nama kawasan untuk carian aset.');
  const diameterRaw=el('astra-calc-diameter').value;
  const result=await callWorker('searchAstraAssetContext',{assetQuery,
    ...(diameterRaw?{diameterMm:Number(diameterRaw)}:{})});
  const assets=result.assets||[],associated=result.observations||[],candidates=result.candidateMatches||[];
  el('astra-asset-result').textContent=`${assets.length} calon aset aktif D1 untuk “${assetQuery}”${diameterRaw?` pada diameter ${diameterRaw} mm`:''}.\n`+
    (assets.length?assets.slice(0,20).map(a=>`${a.asset_num||'Pipe ID tiada'} • ${a.nrw_zone||'DMA tidak diketahui'} • ${a.size_mm||'?'} mm • segmen ${a.segment_key}`).join('\n'):'Tiada padanan aset ditemui. Semak Pipe ID/zon dan sumber GIS yang disahkan.')+
    `\n${candidates.length} titik dengan calon padanan GIS terbaru (belum semestinya disahkan):\n`+
    (candidates.length?candidates.slice(0,20).map(c=>`${c.pipeId}: ${c.match_status}, ${Number(c.distance_m).toFixed(1)} m, ${c.dma_relation}, nod ${c.node_id||'belum dibuktikan'}`).join('\n'):'Tiada calon GIS untuk aset ini.')+
    `\n${associated.length} bacaan lapangan dengan sejarah semakan operator untuk aset calon.\n`+
    associated.slice(0,20).map(o=>`${o.pipeId}: ${o.original_pressure} ${o.original_pressure_unit}, ${o.measured_at||'tanpa masa'}, ${o.resulting_status} (sejarah; bukan kalibrasi)`).join('\n')+
    '\nJarak, identiti zon dan keputusan operator masih perlu semakan. Tiada model atau asset master diubah.';
}
function paintPreparedAsset(report){
  if((typeof aiAgentMap==='undefined'||!aiAgentMap)&&typeof initAiAgentMap==='function')initAiAgentMap();
  if(typeof aiAgentMap==='undefined'||!aiAgentMap||typeof L==='undefined')return;
  if(modelLayer)aiAgentMap.removeLayer(modelLayer);
  const geometry=report.selectedAsset?.geometry;
  modelLayer=L.layerGroup();
  let selectedLayer=null;
  if(geometry){selectedLayer=L.geoJSON({type:'Feature',geometry,properties:{}},{style:{color:'#7c3aed',weight:7}})
    .bindPopup(`ASTRA • ${report.selectedAsset.pipeId} • jajaran aset GIS dipilih; bukan bukti sambungan atau panjang kejuruteraan.`);
    modelLayer.addLayer(selectedLayer);}
  const schematic=report.topology?.schematic;
  const nodePositions=new Map((schematic?.nodes||[]).filter(n=>Number.isFinite(n.latitude)&&Number.isFinite(n.longitude))
    .map(n=>[n.id,[n.latitude,n.longitude]]));
  for(const link of schematic?.links||[]){
    const start=nodePositions.get(link.start),end=nodePositions.get(link.end);
    if(!start||!end)continue;
    modelLayer.addLayer(L.polyline([start,end],{color:link.status==='CLOSED'?'#dc2626':'#475569',
      weight:2,dashArray:'5 6',opacity:0.8}).bindPopup(`SKEMA SAHAJA • ${link.id} • ${link.start} ↔ ${link.end}. Bukan lokasi fizikal paip atau arah aliran.`));
  }
  for(const node of schematic?.nodes||[]){
    const position=nodePositions.get(node.id);if(!position)continue;
    modelLayer.addLayer(L.circleMarker(position,{radius:5,color:node.type==='RESERVOIR'?'#0284c7':'#334155',
      fillOpacity:0.9}).bindPopup(`Nod model ${node.id} • ${node.type} • ${node.origin}. Koordinat nod model; perlu semakan kejuruteraan.`));
  }
  modelLayer.addTo(aiAgentMap);
  if(selectedLayer?.getBounds().isValid())aiAgentMap.fitBounds(selectedLayer.getBounds().pad(0.35),{maxZoom:16});
}
function renderModelPreparation(preparationId,report,candidate){
  modelPreparation={preparationId,report,candidate};el('astra-model-id').value=preparationId;
  updateAstraMapState({selectedPipeId:report.selectedAsset?.pipeId||null,
    selectedDma:report.selectedAsset?.zone||null,selectedModelId:report.modelId||null,
    pipeGeometry:report.selectedAsset?.geometry||null,model:candidate});
  const levels=report.readiness.levels;
  const levelLabels=[['A_BASIC_CALCULATION_READY','A Pengiraan asas'],
    ['B_ASSET_GIS_ANALYSIS_READY','B Analisis aset/GIS'],['C_EXPLORATORY_MODEL_CANDIDATE','C Calon eksploratori'],
    ['D_HYDRAULIC_SIMULATION_READY','D Simulasi TEST'],['E_CALIBRATION_READY','E Kalibrasi'],
    ['F_VALIDATED_ENGINEERING_MODEL','F Model kejuruteraan disahkan']];
  el('astra-model-status').textContent=`Laporan ${preparationId} • ${candidate.label}. Izin eksekusi: ${report.readiness.executionPermission}. Tiada simulasi dijalankan.`;
  el('astra-model-summary').textContent=`Ditemui: ${report.selectedAsset?.pipeId||'tiada Pipe ID tepat'} • DMA ${report.selectedAsset?.zone||'belum sah'} • model ${report.modelId||'tiada'} v${report.modelVersion||'?'}.
Rangkaian: ${report.topology.nodeCount} nod, ${report.topology.linkCount} link, ${report.topology.connectedComponents} komponen; ${report.topology.unsuppliedNodes.length} nod tanpa laluan sumber.
Aset berkait: ${(report.relatedAssets||[]).length} Pipe ID dalam model. Saiz/bahan GIS ialah rujukan, bukan parameter kejuruteraan diluluskan.
Bacaan tekanan berkait: ${report.observations.count} (NETWORK_COMPATIBLE: ${report.observations.networkCompatibleCount}; bukti kalibrasi diluluskan: 0).
${levelLabels.map(([key,label])=>`${label}: ${levels[key]?'SEDIA mengikut skop':'BELUM SEDIA'}`).join('\n')}
Dikira: ${report.calculated.length?report.calculated.map(x=>`${x.name}=${Number(x.value).toFixed(4)} ${x.unit} (${x.basis})`).join('; '):'tiada input mencukupi'}.
Dianggarkan: ${report.estimated.length?report.estimated.map(x=>x.name).join(', '):'tiada nilai diandaikan oleh ASTRA'}.
Masih perlu: ${report.readiness.missing.length?report.readiness.missing.slice(0,12).join('; '):'tiada untuk calon TEST; kelulusan operasi SAINS tetap berasingan'}.
Simulasi dibenarkan: ${report.readiness.executionPermission==='TEST_ONLY'?'calon TEST sahaja melalui aliran sedia ada; bukan SAINS produksi':'TIADA'}.`;
  el('astra-model-evidence').textContent=`Topologi: ${report.topology.direction}\n${report.topology.schematic?.warning||''}\nNod terasing: ${report.topology.isolatedNodes.join(', ')||'tiada'}\nEndpoint belum selesai: ${report.topology.unresolvedEndpoints.join(', ')||'tiada'}\n\n`+
    `Aset paip berkait (GIS sahaja; BUKAN kelulusan kejuruteraan):\n${(report.relatedAssets||[]).map(a=>`${a.pipeId}: ${a.segmentCount} segmen; bahan ${a.materials.join(', ')||'tiada'}; saiz nominal ${a.nominalDiametersMm.join(', ')||'tiada'} mm; panjang GIS ${a.gisLengthM??'tidak diketahui'} m`).join('\n')||'Tiada aset lain dapat dipadankan secara tepat.'}\n\n`+
    `Bacaan tekanan berkait (BUKAN kalibrasi):\n${(report.observations.records||[]).map(o=>`${o.observationId}: ${o.pressure} ${o.unit} (${o.type||'jenis tidak diketahui'}), ${o.measuredAt||'masa tiada'}, nod ${o.nodeId||'belum dipadankan'}, ${o.matchStatus||'status tidak diketahui'}, sensor ${o.sensorId||'tiada'}, kualiti ${o.qualityStatus||'tidak diketahui'}`).join('\n')||'Tiada bacaan operator yang memenuhi syarat.'}\nSela masa: ${report.observations.timeSpanMinutes??'tidak diketahui'} minit. ${report.observations.limitations.join(' ')}\n\n`+
    report.provenance.map(p=>`${p.entityType}/${p.entityId}/${p.parameter}: ${p.value??'MISSING'} ${p.unit||''} • ${p.reviewStatus} • ${p.source||'sumber belum diluluskan'} • ${p.effectiveAt||'masa tidak diketahui'}`).join('\n');
  el('astra-model-export').disabled=report.export.status!=='TEST_CANDIDATE_READY';
  paintPreparedAsset(report);
}
function paintCalibration(report){
  if((typeof aiAgentMap==='undefined'||!aiAgentMap)&&typeof initAiAgentMap==='function')initAiAgentMap();
  if(typeof aiAgentMap==='undefined'||!aiAgentMap||typeof L==='undefined')return;
  if(calibrationLayer)aiAgentMap.removeLayer(calibrationLayer);
  calibrationLayer=L.featureGroup();
  for(const row of report.included||[]){
    if(!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude))continue;
    const color=row.residualM>0?'#dc2626':'#2563eb';
    L.circleMarker([row.latitude,row.longitude],{radius:Math.min(16,6+Math.abs(row.residualM)*2),
      color,fillColor:color,fillOpacity:0.75,weight:2})
      .bindPopup(`ASTRA TEST ${row.observationId}: nod ${row.nodeId}. Diperhati ${row.observedPressureM.toFixed(2)} m; EPANET ${row.simulatedPressureM.toFixed(2)} m; residual ${row.residualM.toFixed(2)} m. Bukan bukti kebocoran.`)
      .addTo(calibrationLayer);
  }
  calibrationLayer.addTo(aiAgentMap);
}
function renderCalibration(runId,report){
  calibrationReport={runId,report};
  updateAstraMapState({selectedRunId:runId,observations:report.included||[]});
  el('astra-cal-id').value=runId;
  el('astra-cal-download').disabled=false;
  const m=report.baseline?.metrics;
  el('astra-cal-status').textContent=`Laporan TEST ${runId} • ${report.status} • ${report.quality||'INSUFFICIENT DATA'}. Tiada model diluluskan atau ditimpa.`;
  el('astra-cal-summary').textContent=`Model ${report.modelId} v${report.modelVersion} • condition ${report.conditionId||'?'} • snapshot ${report.snapshotAt||'tiada'}.
Bacaan sah ${report.included?.length||0}; ditolak ${report.excluded?.length||0}; nod ${m?.nodeCount||0}.
${m?`MAE ${m.maeM.toFixed(3)} m; RMSE ${m.rmseM.toFixed(3)} m; bias ${m.biasM.toFixed(3)} m; maksimum ${m.maxAbsoluteErrorM.toFixed(3)} m.`:'Tiada perbandingan tekanan; simulasi tidak dijalankan.'}
${report.candidate?`Calon ${report.candidate.status}: ${report.candidate.pipeId}, C ${report.candidate.before.toFixed(2)} → ${report.candidate.proposed.toFixed(2)}. RMSE latihan ${report.candidate.trainingBefore.rmseM.toFixed(3)} → ${report.candidate.trainingAfter.rmseM.toFixed(3)} m. Holdout ${report.candidate.holdoutBefore?.rmseM.toFixed(3)||'tiada'} → ${report.candidate.holdoutAfter?.rmseM.toFixed(3)||'tiada'} m.`:'Tiada pelarasan parameter; perbandingan sahaja.'}
${(report.reasons||[]).join(' ')||'Semua kesimpulan kekal terhad kepada TEST sintetik.'}`;
  renderTestChart('astra-cal-chart',(report.included||[]).map(r=>({label:r.nodeId,
    values:[{name:'MEASURED',value:r.observedPressureM,color:'#d97706'},
      {name:'SIMULATED TEST',value:r.simulatedPressureM,color:'#2563eb'}]})),
    'Tekanan nod (m): kuning diukur, biru EPANET TEST.');
  el('astra-cal-evidence').textContent=`Bacaan terlibat (merah: diperhati lebih tinggi; biru: lebih rendah):\n`+
    (report.included||[]).map(r=>`${r.observationId} • nod ${r.nodeId} • ${r.measuredAt} • diperhati ${r.observedPressureM.toFixed(3)} m • simulasi ${r.simulatedPressureM.toFixed(3)} m • residual ${r.residualM.toFixed(3)} m • ketidakpastian ±${r.uncertaintyM.toFixed(3)} m • ${r.sourceRef}`).join('\n')+
    `\n\nDitolak:\n${(report.excluded||[]).map(r=>`${r.observationId||'?'}: ${r.reason}`).join('\n')||'tiada'}`+
    `\n\nDiagnosis:\n${(report.diagnostics||[]).map(d=>`${d.category}: ${d.message}`).join('\n')||'Bukti tidak mencukupi'}`+
    `\n\nKepekaan:\n${report.sensitivity?JSON.stringify(report.sensitivity,null,2):'Tidak diuji; tiada parameter layak/pilihan.'}`;
  paintCalibration(report);
}
function showAnalysisOnMap(report){
  if((typeof aiAgentMap==='undefined'||!aiAgentMap)&&typeof initAiAgentMap==='function')initAiAgentMap();
  if(typeof aiAgentMap==='undefined'||!aiAgentMap||typeof L==='undefined')return;
  if(analysisLayer)aiAgentMap.removeLayer(analysisLayer);
  analysisLayer=L.featureGroup();
  for(const row of report.candidates||[]){
    if(!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude))continue;
    L.circleMarker([row.latitude,row.longitude],{radius:9,color:'#be123c',fillOpacity:0.6})
      .bindPopup(`CALON TEST ${row.nodeId}: RMSE ${row.rmseM.toFixed(3)} m. Siasatan sahaja, bukan kebocoran disahkan.`)
      .addTo(analysisLayer);
  }
  analysisLayer.addTo(aiAgentMap);
}
async function runTestAnalysis(kind){
  const output=el(kind==='reserve'?'astra-reserve-result':'astra-leak-result');
  const conditionId=el(kind==='reserve'?'astra-reserve-condition':'astra-leak-condition').value.trim();
  if(!conditionId)throw Error('Condition ID TEST sintetik diperlukan.');
  const currentQuery=el('astra-model-query').value.trim()||el('astra-asset-query').value.trim();
  if(!modelPreparation||currentQuery&&preparedQuery!==currentQuery)await prepareModel();
  if(!modelPreparation||modelPreparation.report.readiness.executionPermission!=='TEST_ONLY')
    throw Error('Model TEST belum layak dijalankan.');
  output.textContent='Menyemak condition D1 dan menjalankan EPANET TEST...';
  const result=await callWorker(kind==='reserve'?'runAstraTestReserve':'runAstraTestLeak',
    {preparationId:modelPreparation.preparationId,conditionId});
  renderTestAnalysis(kind,result);
  return result;
}
async function retrieveTestAnalysis(kind){
  const runId=el(`astra-${kind}-id`).value.trim();
  if(!runId)throw Error('Masukkan Run ID TEST yang disimpan dahulu.');
  const result=await callWorker('getAstraTestAnalysis',{runId});
  if(result.kind!==(kind==='reserve'?'RESERVE_MARGIN':'LEAK_INVESTIGATION'))throw Error('Run ID ini jenis analisis lain.');
  renderTestAnalysis(kind,result);
}
function renderTestAnalysis(kind,result){
  const output=el(`astra-${kind}-result`);
  el(`astra-${kind}-id`).value=result.runId;
  const r=result.report;
  updateAstraMapState({selectedRunId:result.runId,
    ...(kind==='reserve'?{reserve:r}:{leakCandidates:r.candidates||[]})});
  if(kind==='reserve'){
    const sample=r.scenarios?.filter(s=>Number.isFinite(s.extraDemandM3s)).slice(0,15)||[];
    output.textContent=`Run ${result.runId} • ${r.status} • model ${r.modelId} v${r.modelVersion}.\n`+
      `Aliran semasa ${Number.isFinite(r.currentFlowM3s)?(r.currentFlowM3s*3600).toFixed(2)+' m³/j':'tidak ditentukan'}. `+
      `${r.boundType==='LOWER_BOUND_AT_SEARCH_LIMIT'?'Tambahan sekurang-kurangnya dalam julat carian':'Tambahan sehingga had senario'} ${Number.isFinite(r.additionalFlowM3s)?(r.additionalFlowM3s*3600).toFixed(2)+' m³/j':'tidak boleh dikira'}. `+
      `${r.boundType==='LOWER_BOUND_AT_SEARCH_LIMIT'?'Margin had bawah':'Margin senario'} ${Number.isFinite(r.reserveMarginPercent)?r.reserveMarginPercent.toFixed(1)+'%':'tidak boleh dikira'}.\n`+
      `Had: tekanan ≥${r.limits.minPressureM} m; halaju ≤${r.limits.maxVelocityMs} m/s; sumber ${r.limits.sourceRef}.\n`+
      `Nod kritikal ${r.criticalNode?.nodeId||'tidak diketahui'}; kekangan ${r.governingConstraint?.join(', ')||'baseline gagal'}.\n`+
      `Senario (tambahan m³/j → tekanan min m, lulus):\n${sample.map(s=>`${(s.extraDemandM3s*3600).toFixed(2)} → ${s.criticalNode?.pressureM?.toFixed(2)||'?'}; ${s.feasible?'YA':'TIDAK'}`).join('\n')}\n`+
      `Perubahan demand nod ${r.limits.demandNodeId}:\n${(r.demandScenarios||[]).map(s=>`${s.name}: ${s.result?s.result.feasible?'LULUS':'GAGAL':s.skipReason}`).join('; ')||'tidak diuji'}\n`+
      `${r.formula||''}\n${r.reason}`;
    renderTestChart('astra-reserve-chart',sample.map(s=>({label:`+${(s.extraDemandM3s*3600).toFixed(1)} m³/j`,
      values:[{name:s.feasible?'LULUS':'GAGAL',value:s.criticalNode?.pressureM,color:s.feasible?'#0d9488':'#dc2626'}]})),
      `Tekanan minimum nod kritikal (m), had ${r.limits.minPressureM} m. Ini senario TEST, bukan kapasiti SAINS.`);
  }else{
    output.textContent=`Run ${result.runId} • ${r.status} • ${r.evidenceLevel||'TEST'}\n`+
      `Bacaan sah ${r.included}; RMSE baseline ${Number.isFinite(r.baselineRmseM)?r.baselineRmseM.toFixed(3)+' m':'tiada'}.\n`+
      `Ranking calon nod TEST (RMSE lebih kecil = padanan lebih rapat, bukan pengesahan):\n`+
      `${(r.candidates||[]).map((c,i)=>`${i+1}. ${c.nodeId}: ${c.rmseM.toFixed(3)} m; perubahan ${c.improvementM.toFixed(3)} m`).join('\n')||'Tiada calon sah.'}\n`+
      `Semak alternatif: ${(r.alternativeExplanations||[]).join('; ')}.\n${r.reason}`;
    showAnalysisOnMap(r);
  }
}
function renderTestChart(id,rows,description){
  const target=el(id);target.replaceChildren();
  const valid=rows.filter(r=>r.values.some(v=>Number.isFinite(v.value)&&v.value>=0)).slice(0,15);
  if(!valid.length){target.textContent='Carta tiada: bacaan/senario sah belum tersedia.';return;}
  const max=Math.max(1,...valid.flatMap(r=>r.values.map(v=>Number.isFinite(v.value)?v.value:0)));
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  const height=35+valid.length*40;svg.setAttribute('viewBox',`0 0 640 ${height}`);
  svg.setAttribute('width','640');svg.setAttribute('height',String(height));svg.setAttribute('role','img');
  svg.setAttribute('aria-label',description);
  const add=(tag,attrs,value)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,v] of Object.entries(attrs))n.setAttribute(key,String(v));if(value!==undefined)n.textContent=String(value);svg.append(n);};
  add('text',{x:8,y:18,fill:'#334155','font-size':12},description);
  valid.forEach((row,i)=>{const y=32+i*40;
    add('text',{x:8,y:y+15,fill:'#334155','font-size':11},row.label);
    row.values.forEach((v,j)=>{if(!Number.isFinite(v.value)||v.value<0)return;
      const by=y+j*13;add('rect',{x:170,y:by,width:Math.max(1,400*v.value/max),height:11,fill:v.color});
      add('text',{x:580,y:by+10,fill:'#334155','font-size':10},`${v.value.toFixed(2)} m`);
    });
  });target.append(svg);
}
function downloadCalibrationReport(){
  if(!calibrationReport)return;
  const {runId,report}=calibrationReport,m=report.baseline?.metrics,c=report.candidate;
  const fmt=value=>Number.isFinite(value)?value.toFixed(3):'tidak tersedia';
  const lines=[
    'ASTRA — LAPORAN KALIBRASI HIDRAULIK (DATA SINTETIK TEST SAHAJA)',
    `Run ID: ${runId}`,
    `Model: ${report.modelId} • versi ${report.modelVersion}`,
    `Rangkaian/DMA: ${modelPreparation?.report?.selectedAsset?.zone||'TEST sintetik; DMA sebenar tidak dinilai'}`,
    `Condition ID: ${report.conditionId||'tidak tersedia'} • masa snapshot: ${report.snapshotAt||'tidak tersedia'}`,
    `Status: ${report.status} • kualiti: ${report.quality||'INSUFFICIENT DATA'}`,
    'Model SAINS produksi tidak diubah dan tidak disahkan oleh laporan ini.',
    '', 'DATA LAPANGAN',
    `Jumlah bacaan: ${(report.included?.length||0)+(report.excluded?.length||0)}`,
    `Bacaan sah: ${report.included?.length||0} • ditolak: ${report.excluded?.length||0}`,
    `Nod terliput: ${m?.nodeCount||0} • dataset: ${(report.datasetIds||[]).join(', ')||'tiada'}`,
    '', 'PERBANDINGAN TEKANAN (m turus air)',
    ...((report.included||[]).map(r=>`${r.observationId} | nod ${r.nodeId} | ${r.measuredAt} | diperhati ${fmt(r.observedPressureM)} | EPANET ${fmt(r.simulatedPressureM)} | residual ${fmt(r.residualM)} | ralat mutlak ${fmt(r.absoluteErrorM)} | ketidakpastian ±${fmt(r.uncertaintyM)} | sumber ${r.sourceRef}`)),
    `MAE: ${fmt(m?.maeM)} m • RMSE: ${fmt(m?.rmseM)} m • bias: ${fmt(m?.biasM)} m • ralat maksimum: ${fmt(m?.maxAbsoluteErrorM)} m`,
    '', 'BACAAN DITOLAK',
    ...(report.excluded?.length?report.excluded.map(r=>`${r.observationId||'?'}: ${r.reason}`):['Tiada.']),
    '', 'DIAGNOSTIK — bukan bukti kebocoran',
    ...((report.diagnostics||[]).map(d=>`${d.category}: ${d.message}`)),
    '', 'KEPEKAAN DAN CALON TEST',
    report.sensitivity?`Parameter: ${report.sensitivity.parameter} pada ${report.sensitivity.pipeId}; dP/dC: ${JSON.stringify(report.sensitivity.pressureMPerUnitC)}`:'Kepekaan belum diuji atau bukti tidak mencukupi.',
    c?`Calon ${c.status}: ${c.pipeId}; C asal ${fmt(c.before)}, cadangan ${fmt(c.proposed)}; latihan RMSE ${fmt(c.trainingBefore?.rmseM)} → ${fmt(c.trainingAfter?.rmseM)} m; holdout RMSE ${fmt(c.holdoutBefore?.rmseM)} → ${fmt(c.holdoutAfter?.rmseM)} m; nod holdout bebas: ${c.independentNodeHoldout?'ya':'tidak'}.`:'Tiada perubahan parameter dicadangkan.',
    '', 'KESIMPULAN DAN TINDAKAN',
    ...(report.reasons?.length?report.reasons:['Perbandingan ini terhad kepada model dan bacaan TEST sintetik.']),
    'Semak semula topologi, sumber, demand, sensor dan bukti bebas sebelum sebarang kegunaan kejuruteraan sebenar.'
  ];
  const blob=new Blob([lines.join('\n')+'\n'],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
  link.download=`astra-laporan-kalibrasi-TEST-${runId}.txt`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function runCalibration(){
  const instruction=el('ai-chat-input')?.value||'';
  if(/calibra|kalibra/i.test(instruction)&&!el('astra-model-query').value.trim())fromCommand();
  const currentQuery=el('astra-model-query').value.trim()||el('astra-asset-query').value.trim();
  if(!modelPreparation||currentQuery&&preparedQuery!==currentQuery)await prepareModel();
  const preparationId=el('astra-model-id').value.trim();
  if(preparationId!==modelPreparation?.preparationId)throw Error('Preparation ID berubah; ambil semula laporan model dahulu.');
  const conditionId=el('astra-cal-condition').value.trim();
  if(!conditionId)throw Error('Pilih Condition ID TEST sintetik yang mempunyai masa, head sumber dan demand sepadan.');
  const fitPipeId=el('astra-cal-pipe').value.trim()||undefined;
  const holdoutIds=el('astra-cal-holdout').value.split(',').map(x=>x.trim()).filter(Boolean);
  el('astra-cal-status').textContent='Menyemak bacaan D1, keadaan operasi, kemudian EPANET TEST jika layak...';
  const result=await callWorker('runAstraTestCalibration',{preparationId,conditionId,fitPipeId,holdoutIds});
  renderCalibration(result.runId,result.report);
}
async function retrieveCalibration(){
  const runId=el('astra-cal-id').value.trim();
  if(!runId)throw Error('Masukkan Calibration Run ID dahulu.');
  const result=await callWorker('getAstraTestCalibration',{runId});
  renderCalibration(result.runId,result.report);
}
async function prepareModel(){
  const assetQuery=el('astra-model-query').value.trim()||el('astra-asset-query').value.trim();
  if(!assetQuery)throw Error('Masukkan Pipe ID tepat atau nama kawasan dahulu.');
  const diameter=Number(el('astra-calc-diameter').value)||null;
  const flowRaw=el('astra-calc-flow').value;
  const flowM3h=flowRaw?flowToM3s(Number(flowRaw),el('astra-calc-flow-unit').value)*3600:null;
  const pressureRaw=el('astra-calc-pressure').value;
  const pressureBar=pressureRaw?pressureToKpa(Number(pressureRaw),el('astra-calc-pressure-unit').value)/100:null;
  el('astra-model-status').textContent='Mencari aset D1, link/nod disemak, parameter bersumber dan bacaan berkait...';
  const result=await callWorker('prepareAstraHydraulicModel',{assetQuery,
    commandDiameterMm:diameter,flowM3h,pressureBar});
  preparedQuery=assetQuery;
  renderModelPreparation(result.preparationId,result.report,result.candidate);
}
async function runAstraCommand(){
  const output=el('astra-command-status'),button=el('astra-command-run');
  const plan=planAstraTestCommand(el('astra-command-input').value);
  if(!['localhost','127.0.0.1'].includes(location.hostname)||!new URLSearchParams(location.search).has('astraFieldApi'))
    throw Error('Command Center hanya boleh berhubung dengan Worker TEST localhost; produksi tidak diaktifkan.');
  const results=[];
  const report=()=>{output.textContent=`PENGHALA PERATURAN TEST — bukan keputusan LLM.\n${results.join('\n')}`;};
  button.disabled=true;
  try{
    if(!Object.values(plan.requested).some(Boolean)){
      output.textContent='Tiada alat kejuruteraan yang dikenal pasti. Nyatakan analisis hidraulik, kalibrasi, reserve margin atau siasatan kebocoran TEST.';
      return;
    }
    if(plan.requested.model&&!plan.exactPipe){output.textContent=`Perlu pengesahan identiti aset: ${plan.missing.join(' ')}`;return;}
    const basic=plan.basic;
    if(basic.diameterMm!==null)el('astra-calc-diameter').value=basic.diameterMm;
    if(basic.flow!==null){el('astra-calc-flow').value=basic.flow;el('astra-calc-flow-unit').value=basic.flowUnit;}
    if(basic.pressure!==null){el('astra-calc-pressure').value=basic.pressure;el('astra-calc-pressure-unit').value=basic.pressureUnit;}
    if(plan.exactPipe){el('astra-asset-query').value=plan.exactPipe;el('astra-model-query').value=plan.exactPipe;}
    if(plan.requested.basic){
      if(basic.diameterMm===null||basic.flow===null||basic.pressure===null)
        results.push('Pengiraan asas: TIDAK DIJALANKAN — nyatakan diameter, aliran dan tekanan gauge berunit; sistem tidak meneka.');
      else try{runCalculation();results.push(`Pengiraan asas: CALCULATED. ${el('astra-calc-result').textContent.split('\n')[0]}`);}
        catch(error){results.push(`Pengiraan asas: GAGAL — ${error.message}`);}
      report();
    }
    if(plan.requested.model){
      try{
        results.push('Persediaan model: sedang memeriksa identiti dan readiness D1 TEST...');report();results.pop();
        await prepareModel();
        if(modelPreparation?.report?.selectedAsset?.pipeId!==plan.exactPipe||
          modelPreparation?.report?.modelId!=='TEST-ASTRA-S5'||
          modelPreparation?.report?.readiness?.executionPermission!=='TEST_ONLY')
          throw Error('Aset/model tidak sepadan dengan fixture sintetik TEST; tiada solver dijalankan.');
        results.push(`Persediaan model: TEST_ONLY, ${modelPreparation.report.modelId} v${modelPreparation.report.modelVersion}, ${modelPreparation.preparationId}.`);
        if(basic.flow!==null||basic.pressure!==null)
          results.push('SEMAK KESEPADANAN: aliran/tekanan arahan digunakan untuk pengiraan asas sahaja. Kalibrasi dan senario EPANET menggunakan condition serta bacaan D1 TEST sendiri; input arahan tidak menggantikannya.');
      }catch(error){results.push(`Persediaan model: GAGAL — ${error.message}`);report();return;}
      report();
    }
    const stages=[
      ['calibration',async()=>{el('astra-cal-condition').value='TEST-PH6-CONDITION';await runCalibration();
        return `${calibrationReport?.report?.status||'tiada status'}; MAE ${calibrationReport?.report?.baseline?.metrics?.maeM?.toFixed(3)||'tidak tersedia'} m; ${calibrationReport?.runId||'tiada Run ID'}.`;}],
      ['reserve',async()=>{el('astra-reserve-condition').value='TEST-PH7-CONDITION';const reserve=await runTestAnalysis('reserve');
        if(basic.flow!==null&&Number.isFinite(reserve.report.currentFlowM3s)){
          const requestedM3h=flowToM3s(basic.flow,basic.flowUnit)*3600;
          const baselineM3h=reserve.report.currentFlowM3s*3600;
          if(Math.abs(requestedM3h-baselineM3h)>Math.max(0.05*baselineM3h,0.001))
            results.push(`AMARAN: aliran arahan ${requestedM3h.toFixed(2)} m³/j TIDAK SAMA dengan baseline model TEST ${baselineM3h.toFixed(2)} m³/j. Margin model bukan margin bagi input operator.`);
        }
        return el('astra-reserve-result').textContent.split('\n')[0];}],
      ['leak',async()=>{el('astra-leak-condition').value='TEST-PH8-CONDITION';await runTestAnalysis('leak');
        return el('astra-leak-result').textContent.split('\n')[0];}]
    ];
    for(const [name,fn] of stages){
      if(!plan.requested[name])continue;
      try{results.push(`${name}: sedang dijalankan...`);report();results.pop();
        results.push(`${name}: ${await fn()}`);}catch(error){results.push(`${name}: GAGAL / TIDAK TERSEDIA — ${error.message}`);}
      report();
    }
    if(plan.requested.map3d){
      el('astra-map-selector')?.querySelector('[data-astra-map="cesium"]')?.click();
      results.push('Peta: Cesium 3D diminta; status sebenar dipaparkan pada pemilih peta. Leaflet dan Three.js masih boleh dipilih.');report();
    }
    results.push('Semua analisis di atas ialah DATA SINTETIK TEST. Tiada kalibrasi atau simulasi operasi SAINS diluluskan; calon kebocoran bukan kebocoran disahkan.');report();
  }finally{button.disabled=false;}
}
async function runAstra3Command(){
  const command=el('astra-command-input').value.trim(),button=el('astra-command-run');
  if(!command)throw Error('Tulis soalan atau arahan analisis dahulu.');
  if(!['localhost','127.0.0.1'].includes(location.hostname)||!new URLSearchParams(location.search).has('astraFieldApi'))
    throw Error('ASTRA 3.0 pembangunan hanya tersedia pada Worker/D1 TEST localhost. SAINS produksi tidak diubah.');
  button.disabled=true;
  el('astra3-results').replaceChildren();
  el('astra3-evidence-body').textContent='';
  el('astra3-run-id').value='';
  el('astra-command-status').textContent='Permintaan dihantar kepada Worker TEST. Menunggu jejak alat sebenar; ini bukan penunjuk kemajuan palsu.';
  try{
    const response=await callWorker('runAstra3Investigation',{instruction:command});
    renderAstra3Report(response.report,{results:el('astra3-results'),status:el('astra-command-status'),
      evidence:el('astra3-evidence-body'),runId:response.runId});
    const model=response.report.results?.model;
    if(model?.selectedAsset?.geometry){
      updateAstraMapState({selectedPipeId:model.selectedAsset.pipeId,selectedDma:model.selectedAsset.zone,
        pipeGeometry:model.selectedAsset.geometry,selectedModelId:null});
      paintPreparedAsset(model);
    }
    if(response.report.results?.preparationId){
      try{
        const saved=await callWorker('getAstraHydraulicPreparation',{
          preparationId:response.report.results.preparationId});
        preparedQuery=saved.report.selectedAsset?.pipeId||null;
        el('astra-model-query').value=preparedQuery||'';
        renderModelPreparation(saved.preparationId,saved.report,saved.candidate);
      }catch(error){el('astra-model-status').textContent=`Laporan lanjutan belum dimuatkan: ${error.message}`;}
    }
  }finally{button.disabled=false;}
}
async function retrieveAstra3Command(){
  const runId=el('astra3-run-id').value.trim();
  if(!runId)throw Error('Masukkan Run ID ASTRA 3 TEST.');
  el('astra3-results').replaceChildren();
  el('astra3-evidence-body').textContent='';
  el('astra-command-status').textContent='Mengambil semula laporan TEST yang tersimpan.';
  const response=await callWorker('getAstra3Investigation',{runId});
  renderAstra3Report(response.report,{results:el('astra3-results'),status:el('astra-command-status'),
    evidence:el('astra3-evidence-body'),runId:response.runId});
  const model=response.report.results?.model;
  if(model?.selectedAsset?.geometry){
    updateAstraMapState({selectedPipeId:model.selectedAsset.pipeId,selectedDma:model.selectedAsset.zone,
      pipeGeometry:model.selectedAsset.geometry});
    paintPreparedAsset(model);
  }
}
async function retrieveModel(){
  const preparationId=el('astra-model-id').value.trim();
  const result=await callWorker('getAstraHydraulicPreparation',{preparationId});
  preparedQuery=el('astra-model-query').value.trim()||el('astra-asset-query').value.trim()||result.report.selectedAsset?.pipeId||null;
  renderModelPreparation(result.preparationId,result.report,result.candidate);
}
function downloadModel(){
  if(!modelPreparation||modelPreparation.report.export.status!=='TEST_CANDIDATE_READY')return;
  const blob=new Blob([JSON.stringify(modelPreparation.candidate,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
  link.download=`astra-TEST-candidate-${modelPreparation.preparationId}.json`;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const guard=fn=>async event=>{try{await fn(event);}catch(error){status(error.message);}};
el('astra-field-file')?.addEventListener('change',guard(async()=>readFile(el('astra-field-file').files[0])));
el('astra-field-drop')?.addEventListener('dragover',event=>{event.preventDefault();});
el('astra-field-drop')?.addEventListener('drop',guard(async event=>{event.preventDefault();await readFile(event.dataTransfer.files[0]);}));
el('astra-field-preview')?.addEventListener('click',guard(previewFile));
el('astra-manual-add')?.addEventListener('click',guard(fromManual));
el('astra-manual-map-pick')?.addEventListener('click',guard(chooseManualPointOnMap));
el('astra-field-confirm')?.addEventListener('change',()=>{el('astra-field-save').disabled=!observations.length||!el('astra-field-confirm').checked;});
for(const id of ['astra-field-pressure-unit','astra-field-pressure-type','astra-field-timezone'])el(id)?.addEventListener('change',()=>{
  if(fileRows.length){clearForNewSource();status('Unit/jenis/zon masa berubah; pratonton fail semula.');}
  else if(observations.length){el('astra-field-confirm').checked=false;el('astra-field-save').disabled=true;
    status('Bacaan manual yang sudah ditambah kekal dengan unit/jenis asal. Sahkan semula sebelum simpan.');}
});
el('astra-field-save')?.addEventListener('click',guard(saveDataset));
el('astra-match-load')?.addEventListener('click',guard(loadDataset));
el('astra-match-run')?.addEventListener('click',guard(runMatching));
el('astra-match-load-run')?.addEventListener('click',guard(loadRun));
el('astra-calc-from-command')?.addEventListener('click',fromCommand);
el('astra-command-run')?.addEventListener('click',async()=>{try{await runAstra3Command();}catch(error){el('astra-command-status').textContent=error.message;}});
el('astra-command-legacy')?.addEventListener('click',async()=>{try{await runAstraCommand();}catch(error){el('astra-command-status').textContent=error.message;}});
el('astra3-retrieve')?.addEventListener('click',async()=>{try{await retrieveAstra3Command();}catch(error){el('astra-command-status').textContent=error.message;}});
el('astra-command-input')?.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){
  event.preventDefault();el('astra-command-run')?.click();}});
document.querySelectorAll('[data-astra3-example]').forEach(button=>button.addEventListener('click',()=>{
  el('astra-command-input').value=button.dataset.astra3Example==='synthetic'?
    'ASTRA, analisis paip 900mm Sirusa 5. Flow 1500m3/h, tekanan 3bar. Semak kalibrasi, baki kapasiti dan kebocoran.':
    'ASTRA, analisis paip 300mm Bukit Kuau Lama, walaupun data hidraulik belum lengkap. Terangkan perkara yang boleh dikira dan data yang tidak diketahui.';
  el('astra-command-input').focus();
}));
el('astra-command-advanced')?.addEventListener('click',()=>{el('astra-field-panel').open=true;el('astra-field-panel').scrollIntoView({behavior:'smooth',block:'start'});});
el('astra-command-upload')?.addEventListener('click',()=>{el('astra-field-panel').open=true;el('astra-field-drop').scrollIntoView({behavior:'smooth',block:'center'});
  el('astra-command-status').textContent='Pilih CSV/XLSX/JSON, sahkan pemetaan dan simpan DRAFT dahulu. Bacaan belum menjadi bukti kalibrasi tanpa semakan dan padanan nod.';});
el('astra-asset-search')?.addEventListener('click',async()=>{try{await searchAssetContext();}catch(error){el('astra-asset-result').textContent=error.message;}});
el('astra-model-prepare')?.addEventListener('click',async()=>{try{await prepareModel();}catch(error){el('astra-model-status').textContent=error.message;}});
el('astra-model-retrieve')?.addEventListener('click',async()=>{try{await retrieveModel();}catch(error){el('astra-model-status').textContent=error.message;}});
el('astra-model-export')?.addEventListener('click',downloadModel);
el('astra-cal-run')?.addEventListener('click',async()=>{try{await runCalibration();}catch(error){el('astra-cal-status').textContent=error.message;}});
el('astra-cal-retrieve')?.addEventListener('click',async()=>{try{await retrieveCalibration();}catch(error){el('astra-cal-status').textContent=error.message;}});
el('astra-cal-download')?.addEventListener('click',downloadCalibrationReport);
for(const kind of ['reserve','leak'])el(`astra-${kind}-run`)?.addEventListener('click',async()=>{
  try{await runTestAnalysis(kind);}catch(error){el(`astra-${kind}-result`).textContent=error.message;}
});
for(const kind of ['reserve','leak'])el(`astra-${kind}-retrieve`)?.addEventListener('click',async()=>{
  try{await retrieveTestAnalysis(kind);}catch(error){el(`astra-${kind}-result`).textContent=error.message;}
});
el('astra-calc-run')?.addEventListener('click',async()=>{
  try{runCalculation();}catch(error){el('astra-calc-result').textContent=error.message;return;}
  if(el('astra-asset-query').value.trim()){
    try{await searchAssetContext();}catch(error){el('astra-asset-result').textContent=error.message;}
  }
});
