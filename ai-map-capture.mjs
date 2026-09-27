export function formatMapCoordinate(lat,lng) {
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)
    throw new Error('Koordinat WGS84 tidak sah.');
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',()=>{
  const byId=id=>document.getElementById(id);
  const status=byId('ai-pick-pressure-cp-status');
  const targets=[
    {button:'ai-pick-flow-meter-map',input:'ai-flow-meter-coord',label:'Flow Meter',color:'#0284c7'},
    {button:'ai-pick-pressure-cp-map',input:'ai-cp-coord',label:'tekanan CP',color:'#0891b2',focus:'ai-pressure-cp'},
    {button:'ai-pick-prv-map',input:'ai-prv-coord',label:'PRV',color:'#7c3aed'}
  ];
  let pending=null,active=null;
  const markers=new Map();
  const map=()=>{
    if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
    return aiAgentMap;
  };
  const stop=()=>{
    if(pending && typeof aiAgentMap!=='undefined' && aiAgentMap){
      aiAgentMap.off('click',pending);aiAgentMap.getContainer().style.cursor='';
    }
    pending=null;active=null;
    for(const target of targets)byId(target.button).textContent=`Pilih ${target.label} di peta`;
  };
  window.aiMapCaptureClear=()=>{
    stop();
    if(typeof aiAgentMap!=='undefined' && aiAgentMap)for(const marker of markers.values())aiAgentMap.removeLayer(marker);
    markers.clear();
    status.textContent='Koordinat dikosongkan. Klik lokasi sebenar pada peta dan semak sebelum menyimpan.';
  };
  for(const target of targets)byId(target.button)?.addEventListener('click',()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN'){
      status.textContent='Pemilihan lokasi sensor/PRV terhad kepada ADMIN.';return;
    }
    if(pending){
      const wasSame=active===target.button;
      stop();
      if(wasSame){status.textContent='Pemilihan titik dibatalkan; tiada lokasi disimpan.';return;}
    }
    const m=map();if(!m){status.textContent='Peta belum tersedia.';return;}
    active=target.button;
    pending=event=>{
      stop();
      try{
        const coordinate=formatMapCoordinate(event.latlng.lat,event.latlng.lng);
        byId(target.input).value=coordinate;
        if(markers.has(target.button))m.removeLayer(markers.get(target.button));
        markers.set(target.button,L.circleMarker(event.latlng,{radius:7,color:target.color,weight:3,fillOpacity:0.6})
          .addTo(m).bindPopup(`${target.label} dipilih secara manual. Semak lokasi dan DMA sebelum Simpan.`).openPopup());
        status.textContent=`Lokasi ${target.label} ${coordinate} dipilih. Ini belum disimpan; semak DMA dan tekan Simpan Pemantauan / ALD. ${target.label==='PRV'?'Lokasi sahaja bukan tetapan injap hidraulik.':''}`;
        if(target.focus)byId(target.focus).focus({preventScroll:true});
      }catch(error){status.textContent=error.message;}
    };
    m.once('click',pending);m.getContainer().style.cursor='crosshair';
    byId(target.button).textContent='Batal pilih titik';
    status.textContent=`Klik lokasi ${target.label} sebenar pada peta. Klik Batal untuk keluar. Tiada nilai bacaan akan direka.`;
    byId('ai-agent-map').scrollIntoView({behavior:'smooth',block:'center'});
  });
});
