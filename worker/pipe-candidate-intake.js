// Private ADMIN-only staging of clipped GIS candidates. Never touches the
// authoritative pipe_network_* tables or enables a hydraulic simulation.
const actions=new Set(['beginPipeCandidateDraft','appendPipeCandidateParts',
  'finalizePipeCandidateDraft','getPipeCandidateDraft']);
const reply=(body,headers,status=200)=>new Response(JSON.stringify(body),{status,
  headers:{...headers,'Content-Type':'application/json','Cache-Control':'no-store'}});
const shaPattern=/^[a-f0-9]{64}$/i;
const actor=user=>String(user?.username||user?.email||'').trim().slice(0,100);
class CandidateInputError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const fail=(message,status)=>{throw new CandidateInputError(message,status);};
const num=(value,label,max=100000)=>{
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0||n>max)fail(`${label} tidak sah.`);
  return n;
};
const batchIdOf=value=>{
  const id=String(value||'').trim();
  if(!/^[a-f0-9-]{36}$/i.test(id))fail('Batch ID tidak sah.');
  return id;
};
async function hash(value){
  const bytes=new TextEncoder().encode(value);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function geometryOf(input){
  const geometry=input?.geometry;
  if(geometry?.type!=='LineString'||!Array.isArray(geometry.coordinates)||
    geometry.coordinates.length<2||geometry.coordinates.length>5000)
    fail('Geometri calon mesti LineString WGS84 (2–5,000 titik).');
  const coordinates=geometry.coordinates.map(point=>{
    if(!Array.isArray(point)||point.length<2||!Number.isFinite(point[0])||!Number.isFinite(point[1])||
      Math.abs(point[0])>180||Math.abs(point[1])>90)fail('Koordinat WGS84 tidak sah.');
    return [Number(point[0]),Number(point[1])];
  });
  const text=JSON.stringify({type:'LineString',coordinates});
  if(text.length>120000)fail('Geometri calon terlalu besar.');
  let metres=0;
  for(let i=1;i<coordinates.length;i++){
    const a=coordinates[i-1],b=coordinates[i],rad=Math.PI/180;
    const dLat=(b[1]-a[1])*rad,dLon=(b[0]-a[0])*rad;
    const h=Math.sin(dLat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dLon/2)**2;
    metres+=6371008.8*2*Math.asin(Math.min(1,Math.sqrt(h)));
  }
  if(!Number.isFinite(metres)||metres<=0)fail('Panjang geometri kosong/tidak sah.');
  return {text,metres};
}
async function candidateRow(input,expectedCount,zones){
  const rowNumber=num(input?.rowNumber,'Nombor baris',expectedCount-1);
  const zone=String(input?.zoneName||'').trim();
  if(!zones.has(zone))fail(`DMA ${zone.slice(0,80)} tidak sepadan dengan zon aktif D1; tiada calon disimpan.`,409);
  const kmlId=String(input?.kmlId||'').trim();
  if(kmlId.length>120)fail('ID KML terlalu panjang.');
  const diameterRaw=input?.diameterMm;
  const diameter=diameterRaw===null||diameterRaw===undefined||diameterRaw===''?null:Number(diameterRaw);
  if(diameter!==null&&(!Number.isFinite(diameter)||diameter<=0||diameter>100000))fail('Diameter KML tidak sah.');
  const geometry=geometryOf(input);
  const contentHash=await hash(JSON.stringify([zone,kmlId,diameter,geometry.text]));
  return {rowNumber,zone,kmlId:kmlId||null,diameter,geometry,...{contentHash}};
}
async function fetchDraft(db,id){
  return db.prepare(`SELECT batch_id,source_name,declared_source_sha256,polygon_sha256,
    source_line_count,expected_part_count,outside_line_count,multi_dma_line_count,
    invalid_geometry_count,status,created_by,created_at,finalized_at
    FROM pipe_candidate_imports WHERE batch_id=?`).bind(id).first();
}

export async function handlePipeCandidateAction({action,data,env,user,headers}){
  if(!actions.has(action))return null;
  if(user?.level!=='ADMIN'||!actor(user))return reply({status:'error',message:'ADMIN sahaja.'},headers,403);
  if(user?.purpose==='HYDRAULIC_STAGING_TEST')return reply({status:'error',message:'Token staging TEST tidak boleh mengakses import GIS operasi.'},headers,403);
  if(!env.DB)return reply({status:'error',message:'D1 tidak tersedia; tiada calon disimpan.'},headers,503);
  try{
    if(action==='beginPipeCandidateDraft'){
      const sourceName=String(data.sourceName||'').trim();
      const sourceSha=String(data.sourceSha256||'').toLowerCase();
      const polygonSha=String(data.polygonSha256||'').toLowerCase();
      if(!sourceName||sourceName.length>180||!shaPattern.test(sourceSha)||!shaPattern.test(polygonSha))
        fail('Nama fail dan SHA-256 fail/polygon wajib.');
      const sourceLines=num(data.sourceLines,'Bilangan garisan sumber');
      const expected=num(data.expectedParts,'Bilangan calon',20000);
      const outside=num(data.outsideLines,'Bilangan garisan luar');
      const multi=num(data.multiDmaLines,'Bilangan pertindihan');
      const invalid=num(data.invalidGeometry,'Bilangan geometri tidak sah');
      if(expected<1||sourceLines<1||outside>sourceLines||multi>sourceLines||invalid>sourceLines)
        fail('Ringkasan pratonton tidak konsisten.');
      if(data.confirmDraft!==true)fail('Pengesahan eksplisit simpan DRAFT diperlukan.');
      const prior=await env.DB.prepare(`SELECT batch_id,status,source_line_count,expected_part_count,
        outside_line_count,multi_dma_line_count,invalid_geometry_count FROM pipe_candidate_imports
        WHERE declared_source_sha256=? AND polygon_sha256=? AND created_by=? ORDER BY created_at DESC LIMIT 1`)
        .bind(sourceSha,polygonSha,actor(user)).first();
      if(prior){
        if(Number(prior.expected_part_count)!==expected||Number(prior.source_line_count)!==sourceLines||
          Number(prior.outside_line_count)!==outside||Number(prior.multi_dma_line_count)!==multi||
          Number(prior.invalid_geometry_count)!==invalid)
          fail('Fail/polygon sama mempunyai ringkasan clip berbeza; semak sumber dan algoritma dahulu.',409);
        return reply({status:'success',batchId:prior.batch_id,reused:true,reviewStatus:prior.status,
          expectedParts:expected,activeChanged:false},headers);
      }
      const stored=await env.DB.prepare('SELECT COUNT(*) AS n FROM pipe_candidate_parts').first();
      if(Number(stored?.n||0)+expected>100000)
        fail('Had storan calon GIS D1 dicapai. Semak batch lama secara khusus; tiada cleanup automatik.',409);
      const batchId=crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO pipe_candidate_imports
        (batch_id,source_name,declared_source_sha256,polygon_sha256,source_line_count,
         expected_part_count,outside_line_count,multi_dma_line_count,invalid_geometry_count,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(batchId,sourceName,sourceSha,polygonSha,sourceLines,expected,
          outside,multi,invalid,actor(user)).run();
      return reply({status:'success',batchId,reused:false,reviewStatus:'DRAFT',expectedParts:expected,activeChanged:false},headers);
    }
    const id=batchIdOf(data.batchId),draft=await fetchDraft(env.DB,id);
    if(!draft)return reply({status:'error',message:'Batch calon tidak ditemui.'},headers,404);
    if(action==='getPipeCandidateDraft'){
      const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM pipe_candidate_parts WHERE batch_id=?').bind(id).first();
      const byZone=await env.DB.prepare(`SELECT zone_name,COUNT(*) AS parts,COUNT(DISTINCT kml_id) AS kml_ids,
        SUM(geometry_length_m) AS geometry_length_m FROM pipe_candidate_parts
        WHERE batch_id=? GROUP BY zone_name ORDER BY zone_name`).bind(id).all();
      return reply({status:'success',batch:draft,storedParts:Number(count?.n||0),zones:byZone.results||[],activeChanged:false},headers);
    }
    if(draft.created_by!==actor(user))fail('Hanya penyedia asal boleh melengkapkan batch DRAFT ini.',403);
    if(action==='appendPipeCandidateParts'){
      if(draft.status!=='DRAFT')fail('Batch telah ditutup untuk penambahan.',409);
      if(!Array.isArray(data.parts)||data.parts.length<1||data.parts.length>100)
        fail('Setiap upload mesti mengandungi 1–100 bahagian.');
      const zonesResult=await env.DB.prepare(`SELECT DISTINCT z.zone_name FROM pipe_network_zone_lines z
        JOIN pipe_network_active a ON a.import_id=z.import_id AND a.singleton=1`).all();
      const zones=new Set((zonesResult.results||[]).map(row=>row.zone_name));
      if(!zones.size)fail('Tiada polygon/zon aktif D1 untuk padanan calon.',409);
      const rows=[];const seen=new Set();
      for(const input of data.parts){
        const row=await candidateRow(input,Number(draft.expected_part_count),zones);
        if(seen.has(row.rowNumber))fail('Nombor baris pendua dalam chunk.');
        seen.add(row.rowNumber);rows.push(row);
      }
      const inserts=[];let reused=0;
      for(const row of rows){
        const existing=await env.DB.prepare(`SELECT content_sha256 FROM pipe_candidate_parts
          WHERE batch_id=? AND row_number=?`).bind(id,row.rowNumber).first();
        if(existing){
          if(existing.content_sha256!==row.contentHash)fail(`Baris ${row.rowNumber} bercanggah dengan DRAFT terdahulu.`,409);
          reused++;continue;
        }
        inserts.push(env.DB.prepare(`INSERT INTO pipe_candidate_parts
          (batch_id,row_number,zone_name,kml_id,diameter_mm,geometry_json,content_sha256,geometry_length_m)
          VALUES(?,?,?,?,?,?,?,?)`).bind(id,row.rowNumber,row.zone,row.kmlId,row.diameter,
            row.geometry.text,row.contentHash,row.geometry.metres));
      }
      if(inserts.length)await env.DB.batch(inserts);
      return reply({status:'success',batchId:id,saved:inserts.length,reused,reviewStatus:'DRAFT',activeChanged:false},headers);
    }
    if(draft.status==='REVIEW_REQUIRED')return reply({status:'success',batchId:id,
      reviewStatus:'REVIEW_REQUIRED',activeChanged:false,reused:true},headers);
    const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM pipe_candidate_parts WHERE batch_id=?').bind(id).first();
    if(Number(count?.n)!==Number(draft.expected_part_count))
      fail(`Batch belum lengkap: ${Number(count?.n||0)}/${draft.expected_part_count} bahagian.`,409);
    await env.DB.prepare(`UPDATE pipe_candidate_imports SET status='REVIEW_REQUIRED',finalized_at=CURRENT_TIMESTAMP
      WHERE batch_id=? AND status='DRAFT'`).bind(id).run();
    return reply({status:'success',batchId:id,reviewStatus:'REVIEW_REQUIRED',
      storedParts:Number(count.n),activeChanged:false,
      message:'Calon GIS D1 disimpan untuk semakan. Jajaran aktif, aset dan model hidraulik tidak berubah.'},headers);
  }catch(error){
    if(error instanceof CandidateInputError)return reply({status:'error',message:error.message},headers,error.status);
    console.error('pipe_candidate_intake_failed',String(error));
    return reply({status:'error',message:'Import calon GIS tidak tersedia; jajaran aktif tidak berubah.'},headers,503);
  }
}
