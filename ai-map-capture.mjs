export function formatMapCoordinate(lat,lng) {
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)
    throw new Error('Koordinat WGS84 tidak sah.');
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',()=>{
  const byId=id=>document.getElementById(id);
  const button=byId('ai-pick-pressure-cp-map'),status=byId('ai-pick-pressure-cp-status');
  let pending=null,marker=null;
  const map=()=>{
    if(typeof aiAgentMap==='undefined'||!aiAgentMap)initAiAgentMap();
    return aiAgentMap;
  };
  const stop=()=>{
    if(pending && typeof aiAgentMap!=='undefined' && aiAgentMap){
      aiAgentMap.off('click',pending);aiAgentMap.getContainer().style.cursor='';
    }
    pending=null;button.textContent='Pilih titik tekanan CP di peta';
  };
  window.aiMapCaptureClear=()=>{
    stop();
    if(marker && typeof aiAgentMap!=='undefined' && aiAgentMap)aiAgentMap.removeLayer(marker);
    marker=null;
    status.textContent='Koordinat dipilih secara manual; isi tekanan dan masa sebenar sebelum Simpan.';
  };
  button?.addEventListener('click',()=>{
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN'){
      status.textContent='Pemilihan titik bacaan terhad kepada ADMIN.';return;
    }
    if(pending){stop();status.textContent='Pemilihan titik dibatalkan; tiada bacaan disimpan.';return;}
    const m=map();if(!m){status.textContent='Peta belum tersedia.';return;}
    pending=event=>{
      stop();
      try{
        const coordinate=formatMapCoordinate(event.latlng.lat,event.latlng.lng);
        byId('ai-cp-coord').value=coordinate;
        if(marker)m.removeLayer(marker);
        marker=L.circleMarker(event.latlng,{radius:7,color:'#0891b2',weight:3,fillOpacity:0.6})
          .addTo(m).bindPopup('Titik CP dipilih secara manual. Bacaan tekanan dan masa belum diisi.').openPopup();
        status.textContent=`Titik CP ${coordinate} dipilih. Isi tekanan CP (bar) dan masa bacaan sebenar, kemudian semak sebelum Simpan.`;
        byId('ai-pressure-cp').focus({preventScroll:true});
      }catch(error){status.textContent=error.message;}
    };
    m.once('click',pending);m.getContainer().style.cursor='crosshair';
    button.textContent='Batal pilih titik';
    status.textContent='Klik lokasi sensor/ukuran sebenar pada peta. Klik Batal untuk keluar.';
    byId('ai-agent-map').scrollIntoView({behavior:'smooth',block:'center'});
  });
});
