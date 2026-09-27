// Guidance for the nine existing prompts. It describes evidence, not simulated output.
export const PROMPT_GUIDES = [
  { name:'Analisis Bulanan', purpose:'Trend insiden mengikut bulan; bandingkan hanya dengan bacaan DMA pada tempoh yang sama.', sources:'Rekod aduan bertarikh; D1 aset/telemetri jika tersedia.', hydraulic:'Konteks sejarah untuk kalibrasi; bukan simulasi tekanan.' },
  { name:'Prestasi Kontraktor', purpose:'Semak beban dan susulan pembaikan kontraktor serta perubahan aset selepas kerja.', sources:'Rekod aduan, kontraktor dan pembaikan; rekod as-built jika diluluskan.', hydraulic:'Perubahan fizikal perlu disahkan sebelum versi model dikemas kini.' },
  { name:'Analisis Sirusa Trunk', purpose:'Bandingkan aduan dan aset trunk/retikulasi dalam skop yang dipilih.', sources:'Rekod aduan, D1 aset dan jajaran yang dipadankan; bukan jarak paip rekaan.', hydraulic:'Senario gangguan trunk hanya boleh dikira selepas topologi dan baseline lulus.' },
  { name:'Status Kerja Sivil', purpose:'Jejak penutupan kerja sivil dan kes yang masih memerlukan tindakan.', sources:'Status kerja sivil dalam rekod aduan/pembaikan.', hydraulic:'Status sivil bukan bukti parameter hidraulik; as-built disahkan diperlukan jika paip berubah.' },
  { name:'Cadangan Tukar Paip', purpose:'Susun calon siasatan penggantian berdasarkan insiden dan profil aset.', sources:'Rekod insiden, D1 aset, GIS ber-ID dan keputusan ALD jika ada.', hydraulic:'Keputusan kapasiti/tekanan selepas tukar paip memerlukan senario EPANET yang diluluskan.' },
  { name:'Hotspot Paip Pecah', purpose:'Papar insiden berkoordinat yang berulang; jangan andaikan ia berada pada paip terdekat.', sources:'Koordinat aduan, sejarah kes dan GIS paip yang mempunyai identiti sah.', hydraulic:'Peta hotspot ialah evidens operasi, bukan lokasi bocor yang disahkan oleh model.' },
  { name:'Ramalan Paip Pecah', purpose:'Unjuran indikatif daripada sejarah kes; tunjuk bilangan rekod dan tahap keyakinan.', sources:'Rekod insiden bertarikh dan profil aset D1.', hydraulic:'Bukan ramalan tekanan atau kegagalan hidraulik EPANET.' },
  { name:'Ramalan Paip Bocor', purpose:'Utamakan pemeriksaan menggunakan aliran malam, tekanan dan sejarah ALD.', sources:'D1 telemetri DMA, masa bacaan, penggunaan sah malam dan keputusan ALD.', hydraulic:'Skor risiko tidak mengesahkan bocor; tekanan simulasi hanya selepas model dikalibrasi.' },
  { name:'Penjadualan ALD', purpose:'Susun rondaan lapangan dan rekod keputusan untuk memperbaik evidens berikutnya.', sources:'Hotspot insiden, D1 telemetri, keputusan ALD dan status siasatan.', hydraulic:'Hasil lapangan menguji hipotesis model; AI tidak boleh mengubah model tanpa semakan.' }
];

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const byId=id=>document.getElementById(id);
  const selected=()=>byId('ai-filter-district')?.value?.trim()||'';
  let active=null, requestId=0;
  const ready=async()=>{
    const seq=++requestId, dma=selected(), target=byId('ai-prompt-guide-readiness');
    if(!dma){target.textContent='Pilih satu DMA. Analisis semua DMA tidak membuktikan readiness model tertentu.';return;}
    if(localStorage.getItem('sainsUserLevel')!=='ADMIN'){
      target.textContent='Semakan model terhad kepada ADMIN.';return;
    }
    target.textContent=`${dma}: menyemak status model…`;
    try{
      const response=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json',
        Authorization:`Bearer ${localStorage.getItem('sainsToken')||''}`},body:JSON.stringify({action:'getHydraulicStatus',dma})});
      const data=await response.json();
      if(seq!==requestId)return;
      if(!response.ok||data.status!=='success')throw new Error(data.message||`API ${response.status}`);
      const h=data.hydraulic, missing=Object.values(h.fields||{}).filter(f=>
        !['VERIFIED','MANUAL','NOT APPLICABLE'].includes(String(f.status).toUpperCase()));
      target.textContent=`${dma} · Steady-state ${h.capabilities?.steadyState||'NOT READY'} · Baseline ${h.capabilities?.baseline||'NOT READY'} · ${missing.length} kategori data belum lengkap/disahkan. Prompt operasi bukan hasil EPANET.`;
    }catch(error){if(seq===requestId)target.textContent=`${dma}: status tidak dapat disahkan (${error.message}). Run kekal tidak aktif.`;}
  };
  const chips=[...document.querySelectorAll('#ai-prompt-chips .ai-chip')];
  chips.forEach(chip=>chip.addEventListener('click',()=>{
    active=PROMPT_GUIDES.find(item=>chip.textContent.trim()===item.name);
    if(!active)return;
    byId('ai-prompt-guide-purpose').textContent=`${active.name}: ${active.purpose}`;
    byId('ai-prompt-guide-evidence').textContent=`Sumber perlu diperiksa: ${active.sources} Kaitan hidraulik: ${active.hydraulic}`;
    ready();
  }));
  byId('ai-filter-district')?.addEventListener('change',ready);
  byId('ai-prompt-guide-check')?.addEventListener('click',()=>byId('ai-quick-check')?.click());
  byId('ai-prompt-guide-complete')?.addEventListener('click',()=>byId('ai-quick-complete')?.click());
  byId('ai-prompt-guide-map')?.addEventListener('click',()=>byId('ai-quick-issues')?.click());
  window.aiPromptGuideOnResponse=result=>{
    const evidence=(result.evidence||[]).map(item=>`${item.source} (${Number(item.record_count)||0} rekod)`);
    byId('ai-prompt-guide-evidence').textContent=`Sumber sebenar respons: ${evidence.join('; ')||'tiada sumber boleh disahkan'}. ${active?.hydraulic||'Pilih prompt untuk kaitan model.'}`;
    const h=result.hydraulicContext;
    if(h)byId('ai-prompt-guide-readiness').textContent=`${h.scope||'DMA belum dipilih'} · Baseline ${h.baseline||'NOT_READY'} · Simulasi ${h.simulation||'DISABLED'}. ${h.message||''}`;
    else ready();
  };
});
