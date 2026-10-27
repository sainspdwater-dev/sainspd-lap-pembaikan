// Display-only KML replacement. Never promotes candidate values to asset or
// hydraulic model tables. The active pointer changes only after all clipped
// parts have been copied into an immutable version.
const respond=(body,headers,status=200)=>new Response(JSON.stringify(body),{status,
  headers:{...headers,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const actor=user=>String(user?.username||user?.email||'').trim().slice(0,100);
const allowed=user=>user?.level==='ADMIN'&&actor(user)&&user?.purpose!=='HYDRAULIC_STAGING_TEST';
const batchPattern=/^[a-f0-9-]{36}$/i;

export async function handlePipeMapAction({action,data,env,user,headers}){
  if(action!=='activatePipeMapDraft')return null;
  if(!allowed(user))return respond({status:'error',message:'ADMIN sahaja.'},headers,403);
  if(!env.DB)return respond({status:'error',message:'D1 tidak tersedia.'},headers,503);
  const batchId=String(data.batchId||'').trim();
  if(!batchPattern.test(batchId)||data.confirmReplace!==true)
    return respond({status:'error',message:'Batch ID dan pengesahan gantian diperlukan.'},headers,400);
  const expected=String(data.expectedActiveImportId||'').trim();
  try{
    const draft=await env.DB.prepare(`SELECT batch_id,source_name,declared_source_sha256,polygon_sha256,
      source_line_count,expected_part_count,status,created_by FROM pipe_candidate_imports WHERE batch_id=?`)
      .bind(batchId).first();
    if(!draft||draft.status!=='REVIEW_REQUIRED'||draft.created_by!==actor(user))
      return respond({status:'error',message:'Calon KML lengkap milik ADMIN ini tidak ditemui.'},headers,409);
    const current=await env.DB.prepare('SELECT import_id FROM pipe_map_active WHERE singleton=1').first();
    if(current?.import_id===batchId)return respond({status:'success',importId:batchId,reused:true,
      displayOnly:true,hydraulicChanged:false},headers);
    if((current?.import_id||'')!==expected)
      return respond({status:'error',message:'Versi jajaran aktif telah berubah. Semak semula sebelum mengganti.'},headers,409);
    const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM pipe_candidate_parts WHERE batch_id=?')
      .bind(batchId).first();
    if(Number(count?.n)!==Number(draft.expected_part_count)||Number(count?.n)<1)
      return respond({status:'error',message:'Calon clip belum lengkap; jajaran lama kekal.'},headers,409);
    await env.DB.prepare(`INSERT OR IGNORE INTO pipe_map_imports
        (import_id,source_name,source_sha256,polygon_sha256,source_line_count,
         expected_part_count,created_by,previous_import_id) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(batchId,draft.source_name,draft.declared_source_sha256,draft.polygon_sha256,
          draft.source_line_count,draft.expected_part_count,actor(user),expected||null).run();
    // Copy in bounded chunks. A failed/interrupted copy leaves an inactive,
    // resumable snapshot, never a partially visible layer.
    for(let start=0;start<Number(draft.expected_part_count);start+=250){
      await env.DB.prepare(`INSERT OR IGNORE INTO pipe_map_lines
        (import_id,row_number,zone_name,kml_id,diameter_mm,geometry_json,geometry_length_m,
         min_lng,min_lat,max_lng,max_lat)
        SELECT p.batch_id,p.row_number,p.zone_name,p.kml_id,p.diameter_mm,p.geometry_json,
          p.geometry_length_m,
          (SELECT MIN(CAST(json_extract(value,'$[0]') AS REAL)) FROM json_each(json_extract(p.geometry_json,'$.coordinates'))),
          (SELECT MIN(CAST(json_extract(value,'$[1]') AS REAL)) FROM json_each(json_extract(p.geometry_json,'$.coordinates'))),
          (SELECT MAX(CAST(json_extract(value,'$[0]') AS REAL)) FROM json_each(json_extract(p.geometry_json,'$.coordinates'))),
          (SELECT MAX(CAST(json_extract(value,'$[1]') AS REAL)) FROM json_each(json_extract(p.geometry_json,'$.coordinates')))
        FROM pipe_candidate_parts p WHERE p.batch_id=? AND p.row_number>=? AND p.row_number<?`)
        .bind(batchId,start,start+250).run();
    }
    const copied=await env.DB.prepare('SELECT COUNT(*) AS n FROM pipe_map_lines WHERE import_id=?')
      .bind(batchId).first();
    if(Number(copied?.n)!==Number(draft.expected_part_count))
      return respond({status:'error',message:'Salinan clip tidak lengkap; jajaran lama kekal.'},headers,409);
    const switched=await env.DB.prepare(`INSERT INTO pipe_map_active(singleton,import_id,activated_at)
      VALUES(1,?,CURRENT_TIMESTAMP) ON CONFLICT(singleton) DO UPDATE SET
      import_id=excluded.import_id,activated_at=CURRENT_TIMESTAMP WHERE pipe_map_active.import_id=?`)
      .bind(batchId,expected).run();
    if(Number(switched?.meta?.changes??switched?.changes??0)!==1)
      return respond({status:'error',message:'Versi aktif berubah semasa proses; jajaran baharu tidak diaktifkan.'},headers,409);
    return respond({status:'success',importId:batchId,previousImportId:expected||null,
      lineParts:Number(copied.n),displayOnly:true,hydraulicChanged:false},headers);
  }catch(error){
    console.error('pipe_map_activation_failed',String(error));
    return respond({status:'error',message:'Gantian jajaran gagal; versi aktif tidak berubah.'},headers,503);
  }
}

export async function handlePipeMapRead(request,env,user,headers){
  const url=new URL(request.url);
  if(!['/api/pipe-map-active','/api/pipe-lines'].includes(url.pathname))return null;
  if(!allowed(user))return respond({status:'error',message:'ADMIN sahaja.'},headers,403);
  if(request.method!=='GET')return respond({status:'error',message:'Method not allowed.'},headers,405);
  if(!env.DB)return respond({status:'error',message:'D1 tidak tersedia.'},headers,503);
  try{
    const active=await env.DB.prepare(`SELECT a.import_id,a.activated_at,i.source_name,i.source_sha256,
      i.polygon_sha256,i.source_line_count,i.expected_part_count,i.previous_import_id
      FROM pipe_map_active a JOIN pipe_map_imports i ON i.import_id=a.import_id WHERE a.singleton=1`).first();
    if(url.pathname==='/api/pipe-map-active')
      return respond({status:'success',active:active?{
        importId:active.import_id,activatedAt:active.activated_at,sourceName:active.source_name,
        sourceSha256:active.source_sha256,polygonSha256:active.polygon_sha256,
        sourceLines:active.source_line_count,lineParts:active.expected_part_count,
        previousImportId:active.previous_import_id,displayOnly:true}:null},headers);
    if(!active)return null; // Legacy map remains visible until first confirmed replacement.
    const zone=String(url.searchParams.get('zone')||'').trim();
    if(zone.length>180)return respond({status:'error',message:'Nama DMA terlalu panjang.'},headers,400);
    const limit=Math.min(500,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'500',10)||500));
    const offset=Number.parseInt(url.searchParams.get('offset')||'0',10);
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000)
      return respond({status:'error',message:'Offset tidak sah.'},headers,400);
    let rows;
    if(zone){
      rows=(await env.DB.prepare(`SELECT zone_name,kml_id,diameter_mm,geometry_json,geometry_length_m
        FROM pipe_map_lines WHERE import_id=? AND zone_name=? ORDER BY row_number LIMIT ? OFFSET ?`)
        .bind(active.import_id,zone,limit+1,offset).all()).results||[];
    }else{
      const bbox=String(url.searchParams.get('bbox')||'').split(',').map(Number);
      if(bbox.length!==4||!bbox.every(Number.isFinite)||bbox[0]>=bbox[2]||bbox[1]>=bbox[3]||
        bbox[0]<-180||bbox[2]>180||bbox[1]<-90||bbox[3]>90)
        return respond({status:'error',message:'bbox WGS84 wajib.'},headers,400);
      rows=(await env.DB.prepare(`SELECT zone_name,kml_id,diameter_mm,geometry_json,geometry_length_m
        FROM pipe_map_lines WHERE import_id=? AND min_lng<=? AND max_lng>=?
          AND min_lat<=? AND max_lat>=? ORDER BY row_number LIMIT ? OFFSET ?`)
        .bind(active.import_id,bbox[2],bbox[0],bbox[3],bbox[1],limit+1,offset).all()).results||[];
    }
    const features=rows.slice(0,limit).map(row=>({type:'Feature',geometry:JSON.parse(row.geometry_json),
      properties:{asset_num:row.kml_id,size_mm:row.diameter_mm,material:null,
        dma:row.zone_name,length_m:row.geometry_length_m,source:'KML_SPATIAL_ONLY',
        membership:'SPATIAL_CLIP_ONLY',review_status:'UNVERIFIED'}}));
    return respond({status:'success',importId:active.import_id,zone:zone||null,
      type:'FeatureCollection',features,nextOffset:rows.length>limit?offset+limit:null,
      displayOnly:true},headers);
  }catch(error){
    console.error('pipe_map_read_failed',String(error));
    return respond({status:'error',message:'Lapisan jajaran peta tidak tersedia.'},headers,503);
  }
}
