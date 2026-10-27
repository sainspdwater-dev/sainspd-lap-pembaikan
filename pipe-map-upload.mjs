import {previewPipeClip,hasPipeLine} from './pipe-clip-preview.mjs';
import {prepareKmlXml} from './kml-namespace.mjs';

if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',()=>{
  const el=id=>document.getElementById(id);
  const fileInput=el('pipe-upload-file'),previewButton=el('pipe-upload-preview');
  const replaceButton=el('pipe-upload-replace'),confirmation=el('pipe-upload-confirm');
  const progress=el('pipe-upload-progress'),resultStatus=el('pipe-upload-result');
  const activeStatus=el('pipe-upload-active'),summary=el('pipe-upload-summary');
  let map=null,previewLayer=null,polygonLayer=null,preview=null,meta=null,activeId=null,activeLoaded=false,busy=false;
  const token=()=>localStorage.getItem('sainsToken')||'';
  const admin=()=>localStorage.getItem('sainsUserLevel')==='ADMIN';
  const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(value=>value.toString(16).padStart(2,'0')).join('');
  const polygonItems=()=>(window.koleksiPoligonDMZ||[]).map(feature=>({feature,
    name:String(feature.properties?._fileName||feature.properties?.name||feature.properties?.Name||'').trim()}))
    .filter(item=>item.name&&['Polygon','MultiPolygon'].includes(item.feature.geometry?.type));
  const polygonIn=geometry=>geometry?.type==='Polygon'||geometry?.type==='MultiPolygon'||
    (geometry?.type==='GeometryCollection'&&geometry.geometries?.some(polygonIn));
  const request=async(path,options={})=>{
    const response=await fetch(new URL(path,WORKER_URL),{...options,cache:'no-store',
      headers:{Authorization:`Bearer ${token()}`,...options.headers}});
    const body=await response.json();
    if(!response.ok||body.status!=='success'){
      const error=new Error(body.message||`API ${response.status}`);error.httpStatus=response.status;throw error;
    }
    return body;
  };
  const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
  const post=async data=>{
    for(let attempt=0;attempt<3;attempt++){
      try{return await request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}
      catch(error){
        if(error.httpStatus!==429||attempt===2)throw error;
        resultStatus.textContent='Had permintaan Worker dicapai. Menunggu 65 saat sebelum menyambung upload yang sama…';
        await pause(65000);
      }
    }
  };
  const loadActive=async()=>{
    if(!admin())return;
    try{
      const response=await request('/api/pipe-map-active');
      activeId=response.active?.importId||'';activeLoaded=true;
      activeStatus.textContent=response.active
        ?`Jajaran peta aktif: ${response.active.sourceName} · ${response.active.lineParts.toLocaleString()} bahagian clip · ${response.active.activatedAt}. Ini lapisan peta sahaja, bukan model hidraulik.`
        :'Jajaran peta masih menggunakan import lama. Upload KML baharu akan mewujudkan versi paparan yang berasingan; polygon dan model hidraulik tidak berubah.';
    }catch(error){
      activeLoaded=false;activeStatus.textContent=`Status jajaran peta tidak dapat disahkan: ${error.message}. Gantian dikunci.`;
    }
  };
  const initMap=()=>{
    if(!map){
      map=L.map('pipe-upload-map').setView([2.5225,101.7946],11);
      if(!window.sainsDesktop||(navigator.onLine&&localStorage.getItem('sainsDesktopOffline')!=='true'))
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
          maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
    }
    const polygons=polygonItems().map(item=>item.feature);
    if(polygons.length&&!polygonLayer){
      polygonLayer=L.geoJSON({type:'FeatureCollection',features:polygons},{
        style:{color:'#10b981',weight:2,dashArray:'5,5',fillOpacity:.07}}).addTo(map);
      const bounds=polygonLayer.getBounds();if(bounds.isValid())map.fitBounds(bounds,{padding:[20,20]});
    }
    setTimeout(()=>map.invalidateSize(),50);
  };
  const showZone=zone=>{
    initMap();if(previewLayer)map.removeLayer(previewLayer);
    previewLayer=L.geoJSON({type:'FeatureCollection',features:zone.mapFeatures},{
      style:{color:'#ea580c',weight:5,opacity:.9},
      onEachFeature:(feature,layer)=>{
        const props=feature.properties||{};
        const box=document.createElement('div');
        box.textContent=`PRATONTON KML · ${zone.name} · ID ${props.asset_num||'tidak dinyatakan'} · Diameter ${props.size_mm??'tiada'} mm. Clip spatial, belum disahkan untuk hidraulik.`;
        layer.bindPopup(box);
      }}).addTo(map);
    const bounds=L.latLngBounds([]);
    polygonItems().filter(item=>item.name===zone.name).forEach(item=>bounds.extend(L.geoJSON(item.feature).getBounds()));
    if(!bounds.isValid())bounds.extend(previewLayer.getBounds());
    if(bounds.isValid())map.fitBounds(bounds,{padding:[25,25],maxZoom:15});
    progress.textContent=`${zone.name}: ${zone.partCount} bahagian. Peta menunjukkan ${zone.mapFeatures.length}${zone.mapTruncated?' sampel sahaja':''}.`;
  };
  const render=result=>{
    summary.replaceChildren();
    const note=document.createElement('p');note.className='mb-2';
    note.textContent=`${result.sourceLines.toLocaleString()} garisan sumber · ${result.stagedParts.length.toLocaleString()} bahagian clip · ${result.outsideLines} di luar polygon · ${result.multiDmaLines} merentas DMA · ${result.invalidGeometry} geometri tidak sah. Tiada data disimpan lagi.`;
    summary.append(note);
    const table=document.createElement('table');table.className='min-w-full border-collapse text-left';
    const head=document.createElement('tr');
    for(const label of ['DMA','Bahagian clip','ID KML unik','Tanpa ID','Tanpa diameter','Peta']){
      const cell=document.createElement('th');cell.className='border p-1';cell.textContent=label;head.append(cell);
    }
    table.append(head);
    for(const zone of result.zones.filter(item=>item.partCount).sort((a,b)=>a.name.localeCompare(b.name))){
      const row=document.createElement('tr');
      for(const value of [zone.name,zone.partCount,zone.sourceCount,zone.noIdParts,zone.noDiameterParts]){
        const cell=document.createElement('td');cell.className='border p-1';cell.textContent=String(value);row.append(cell);
      }
      const cell=document.createElement('td');cell.className='border p-1';
      const button=document.createElement('button');button.type='button';button.textContent='Lihat';
      button.className='underline text-blue-700 dark:text-blue-300';button.addEventListener('click',()=>showZone(zone));
      cell.append(button);row.append(cell);table.append(row);
    }
    summary.append(table);
  };
  fileInput.addEventListener('change',()=>{
    preview=null;meta=null;confirmation.value='';replaceButton.disabled=true;summary.replaceChildren();
    if(previewLayer&&map){map.removeLayer(previewLayer);previewLayer=null;}
    progress.textContent=fileInput.files?.[0]?`Fail dipilih: ${fileInput.files[0].name}. Klik Pratonton & clip semua DMA.`:'Belum pilih fail.';
    resultStatus.textContent='Jajaran aktif tidak berubah.';
  });
  previewButton.addEventListener('click',async()=>{
    if(!admin())return progress.textContent='ADMIN sahaja.';
    const file=fileInput.files?.[0];
    if(!file||!file.name.toLowerCase().endsWith('.kml'))return progress.textContent='Pilih fail .kml garisan paip.';
    if(file.size>60*1024*1024)return progress.textContent='Fail melebihi 60 MB; gunakan aliran import pelayan.';
    const polygons=polygonItems();
    if(!polygons.length)return progress.textContent='Polygon DMA belum tersedia. Muat semula dashboard dan tunggu peta siap.';
    busy=true;previewButton.disabled=true;replaceButton.disabled=true;
    try{
      progress.textContent='Membaca KML dan menyemak garisan…';
      const prepared=prepareKmlXml(await file.text());
      const parsed=new DOMParser().parseFromString(prepared.xml,'text/xml');
      if(parsed.querySelector('parsererror'))throw new Error('Struktur KML tidak sah.');
      const geo=omnivore.kml.parse(prepared.xml).toGeoJSON(false);
      const features=geo.type==='FeatureCollection'?geo.features:[];
      if(features.some(feature=>polygonIn(feature.geometry)))
        throw new Error('Fail ini mengandungi polygon. Muat naik KML garisan paip sahaja; polygon DMA sedia ada tidak akan diganti.');
      if(!features.some(hasPipeLine))throw new Error('Tiada garisan paip dalam KML.');
      const clipped=await previewPipeClip(features,polygons,{onProgress:({done,total})=>{
        progress.textContent=`Clip ${done.toLocaleString()}/${total.toLocaleString()} fitur…`;}});
      if(!clipped.stagedParts.length)throw new Error('Tiada garisan yang masuk ke polygon DMA; jajaran lama dikekalkan.');
      if(clipped.invalidGeometry)throw new Error(`${clipped.invalidGeometry} geometri tidak sah. Betulkan KML sebelum mengganti jajaran.`);
      const polygonManifest=polygons.map(item=>({name:item.name,geometry:item.feature.geometry}))
        .sort((a,b)=>a.name.localeCompare(b.name));
      const [sourceSha256,polygonSha256]=await Promise.all([
        hash(await file.arrayBuffer()),hash(new TextEncoder().encode(JSON.stringify(polygonManifest)))]);
      preview=clipped;meta={sourceName:file.name,sourceSha256,polygonSha256,file};
      render(clipped);initMap();await loadActive();
      replaceButton.disabled=!activeLoaded;
      progress.textContent=`Pratonton siap: ${file.name} · ${clipped.stagedParts.length.toLocaleString()} bahagian clip dalam ${clipped.zones.filter(zone=>zone.partCount).length} DMA. Semak jadual dan peta dahulu.`;
      resultStatus.textContent=activeLoaded?'Taip GANTI JAJARAN untuk membenarkan penggantian lapisan peta.':'Worker belum menyokong gantian; tiada data diubah.';
    }catch(error){preview=null;meta=null;summary.replaceChildren();progress.textContent=`Pratonton gagal: ${error.message}`;}
    finally{busy=false;previewButton.disabled=false;}
  });
  replaceButton.addEventListener('click',async()=>{
    if(busy||!admin()||!preview||!meta||!activeLoaded)return;
    if(confirmation.value.trim()!=='GANTI JAJARAN')return resultStatus.textContent='Taip tepat GANTI JAJARAN dahulu.';
    if(fileInput.files?.[0]!==meta.file)
      return resultStatus.textContent='Fail telah berubah. Pratonton semula.';
    busy=true;replaceButton.disabled=true;previewButton.disabled=true;fileInput.disabled=true;
    const expectedActiveImportId=activeId;
    try{
      const batch=await post({action:'beginPipeCandidateDraft',sourceName:meta.sourceName,
        sourceSha256:meta.sourceSha256,polygonSha256:meta.polygonSha256,
        sourceLines:preview.sourceLines,expectedParts:preview.stagedParts.length,
        outsideLines:preview.outsideLines,multiDmaLines:preview.multiDmaLines,
        invalidGeometry:preview.invalidGeometry,confirmDraft:true});
      if(batch.reviewStatus!=='REVIEW_REQUIRED'){
        for(let i=0;i<preview.stagedParts.length;i+=100){
          await post({action:'appendPipeCandidateParts',batchId:batch.batchId,
            parts:preview.stagedParts.slice(i,i+100)});
          resultStatus.textContent=`Menyimpan clip ${Math.min(i+100,preview.stagedParts.length).toLocaleString()}/${preview.stagedParts.length.toLocaleString()}… Jajaran lama masih aktif.`;
          if(i+100<preview.stagedParts.length)await pause(1500);
        }
        await post({action:'finalizePipeCandidateDraft',batchId:batch.batchId});
      }
      const verified=await post({action:'getPipeCandidateDraft',batchId:batch.batchId});
      if(Number(verified.storedParts)!==preview.stagedParts.length||verified.batch?.status!=='REVIEW_REQUIRED')
        throw new Error('Bilangan clip dalam D1 tidak sama dengan pratonton; tiada penggantian dibuat.');
      const activated=await post({action:'activatePipeMapDraft',batchId:batch.batchId,
        expectedActiveImportId,confirmReplace:true});
      if(activated.importId!==batch.batchId||!activated.displayOnly)
        throw new Error('Respons pengaktifan tidak sepadan; semak status aktif sebelum mencuba lagi.');
      await loadActive();window.dispatchEvent(new Event('sains-pipe-map-replaced'));
      resultStatus.textContent=`Berjaya: ${activated.lineParts?.toLocaleString()||preview.stagedParts.length.toLocaleString()} garisan clip kini dipaparkan. Versi lama masih tersimpan. Polygon, aset dan model hidraulik tidak berubah.`;
      confirmation.value='';
    }catch(error){resultStatus.textContent=`Gantian gagal/terhenti: ${error.message} Jajaran lama kekal aktif kecuali status aktif di atas menunjukkan versi baharu. Semak status sebelum ulang.`;await loadActive();}
    finally{busy=false;previewButton.disabled=false;fileInput.disabled=false;replaceButton.disabled=false;}
  });
  window.addEventListener('sains-pipe-upload-open',()=>{if(!admin())return;initMap();loadActive();});
});
