// Reviewed engineering intake for one registered DMA/model version. This never
// creates a model, changes GIS assets, or starts a hydraulic simulation.
import {previewEngineeringRows, validateEngineeringRow} from '../staging-site/engineering-intake.mjs';
import {buildHydraulicAutoFill} from './hydraulic-autofill.js';

const actions=new Set(['listHydraulicModelsForDma','registerHydraulicDraftModel','getHydraulicIntake','autoFillHydraulicPreview','previewHydraulicIntake','saveHydraulicDraft','reviewHydraulicDraft']);
const reply=(body,headers,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json','Cache-Control':'no-store'}});
const identity=user=>String(user?.username||user?.email||'').trim().slice(0,100);
const contextOf=data=>({modelId:String(data.modelId||'').trim(),version:data.version,enteredBy:''});
const keyOf=row=>[row.entityType,row.entityId,row.parameter].join('\u0000');

async function registeredModel(db,data){
  const dma=String(data.dma||'').trim();
  const modelId=String(data.modelId||'').trim();
  const version=Number(data.version);
  if(!dma||dma.length>180||!modelId||modelId.length>100||!Number.isSafeInteger(version)||version<1)
    throw new Error('Pilih satu DMA dan model/versi berdaftar yang sah.');
  const model=await db.prepare(`SELECT m.zone_name,m.model_id,v.version,v.validation_status
    FROM hydraulic_models m JOIN hydraulic_model_versions v ON v.model_id=m.model_id
    WHERE m.model_id=? AND m.zone_name=? COLLATE NOCASE AND v.version=?`).bind(modelId,dma,version).first();
  if(!model)throw new Error('Model/versi tidak berdaftar bagi DMA dipilih; tiada data disimpan.');
  return model;
}

async function sha256(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

export async function prepareHydraulicIntake(db,data,user){
  const model=await registeredModel(db,data);
  const rows=data.rows;
  if(!Array.isArray(rows)||rows.length<1||rows.length>200)throw new Error('Satu hingga 200 baris diperlukan bagi setiap semakan.');
  if(data.sourceSha256&&!/^[a-f0-9]{64}$/i.test(String(data.sourceSha256)))throw new Error('SHA-256 fail tidak sah.');
  const actor=identity(user);
  if(!actor)throw new Error('Identiti ADMIN yang disahkan diperlukan.');
  const context={...contextOf(data),enteredBy:actor};
  const preview=previewEngineeringRows(rows,context);
  const checked=rows.map(row=>validateEngineeringRow(row,context));
  const conflicts=[];
  const seen=new Set();
  for(let i=0;i<checked.length;i++){
    const record=checked[i].record;
    const key=keyOf(record);
    if(seen.has(key)){conflicts.push(`Baris ${i+1}: parameter pendua dalam batch.`);continue;}
    seen.add(key);
    const prior=await db.prepare(`SELECT entry_id,value_real,value_text,classification,review_status
      FROM hydraulic_parameter_reviews WHERE model_id=? AND version=? AND entity_type=? AND entity_id=? AND parameter_name=?
      ORDER BY entered_at DESC, rowid DESC LIMIT 1`).bind(context.modelId,Number(context.version),record.entityType,record.entityId,record.parameter).first();
    if(prior)conflicts.push(`Baris ${i+1}: ${record.entityType}/${record.entityId}/${record.parameter} sudah mempunyai rekod ${prior.review_status}; semakan penggantian perlu dibuat secara berasingan.`);
  }
  const accepted=preview.valid===rows.length&&conflicts.length===0;
  const hash=await sha256({dma:data.dma,modelId:context.modelId,version:Number(context.version),actor,rows,
    sourceSha256:String(data.sourceSha256||'')});
  return {model,rows:checked.map(x=>x.record),preview:{...preview,accepted:accepted?rows.length:0,
    rejected:accepted?0:rows.length,conflicts,confirmationHash:accepted?hash:null,
    message:accepted?'Sedia untuk simpan sebagai DRAFT; kelulusan jurutera berasingan masih wajib.':'Betulkan semua isu sebelum simpan.'}};
}

async function latestReviews(db,modelId,version){
  const result=await db.prepare(`SELECT entry_id,entity_type,entity_id,parameter_name,value_real,value_text,unit,
      classification,source_ref,source_sha256,effective_at,entered_by,entered_at,review_status,reviewed_by,reviewed_at,review_note
    FROM hydraulic_parameter_reviews WHERE model_id=? AND version=?
    ORDER BY entered_at DESC, rowid DESC LIMIT 1000`).bind(modelId,version).all();
  const seen=new Set();
  return (result.results||[]).filter(row=>{const key=[row.entity_type,row.entity_id,row.parameter_name].join('\u0000');
    if(seen.has(key))return false;seen.add(key);return true;});
}

export async function handleHydraulicIntakeAction({action,data,env,user,headers}){
  if(!actions.has(action))return null;
  if(user?.level!=='ADMIN')return reply({status:'error',message:'ADMIN sahaja.'},headers,403);
  if(user?.purpose==='HYDRAULIC_STAGING_TEST' && ['registerHydraulicDraftModel','saveHydraulicDraft','reviewHydraulicDraft'].includes(action))
    return reply({status:'error',message:'Token TEST staging tidak boleh menulis data model SAINS sebenar.'},headers,403);
  if(!env.DB)return reply({status:'error',message:'D1 hydraulic intake belum tersedia; tiada data disimpan.'},headers,503);
  try{
    if(action==='listHydraulicModelsForDma'||action==='registerHydraulicDraftModel'){
      const dma=String(data.dma||'').trim();
      if(!dma||dma.length>180)return reply({status:'error',message:'Pilih tepat satu DMA.'},headers,400);
      const found=await env.DB.prepare(`SELECT m.model_id,m.zone_name,v.version,v.validation_status
        FROM hydraulic_models m JOIN hydraulic_model_versions v ON v.model_id=m.model_id
        WHERE m.zone_name=? COLLATE NOCASE ORDER BY v.version DESC LIMIT 20`).bind(dma).all();
      const models=found.results||[];
      if(action==='listHydraulicModelsForDma')return reply({status:'success',dma,models},headers);
      if(models.length)return reply({status:'error',message:'Model DMA sudah didaftarkan; pilih versi sedia ada.'},headers,409);
      if(data.confirm!==true)return reply({status:'error',message:'Pengesahan eksplisit diperlukan untuk daftar model DRAFT.'},headers,400);
      const zone=await env.DB.prepare(`SELECT z.zone_name FROM pipe_network_zone_lines z
        JOIN pipe_network_active a ON a.import_id=z.import_id AND a.singleton=1
        WHERE z.zone_name=? COLLATE NOCASE LIMIT 1`).bind(dma).first();
      if(!zone)return reply({status:'error',message:'Nama ini tiada dalam DMA GIS aktif. Mungkin nama paip, bukan DMA; jangan cipta model pada zon yang salah.'},headers,409);
      const canonicalDma=zone.zone_name;
      const modelId=`SAINS-DMA-${(await sha256(canonicalDma)).slice(0,32)}`;
      const actor=identity(user);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO hydraulic_models(model_id,zone_name,owner_scope,created_by) VALUES(?,?,?,?)`)
          .bind(modelId,canonicalDma,'SAINS',actor),
        env.DB.prepare(`INSERT INTO hydraulic_model_versions
          (model_id,version,topology_version,parameter_version,snap_tolerance_m,validation_status,calibration_status,
           active,created_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .bind(modelId,1,'UNREVIEWED','DRAFT',0,'NOT_READY','NOT_STARTED',1,actor,
            'DRAFT engineering intake only; no topology approval or simulation authorization.')
      ]);
      return reply({status:'success',dma:canonicalDma,modelId,version:1,validationStatus:'NOT_READY',baselineEnabled:false},headers);
    }
    const model=await registeredModel(env.DB,data);
    if(action==='autoFillHydraulicPreview'){
      const preview=await buildHydraulicAutoFill(env.DB,model);
      return reply({status:'success',autoFill:preview},headers);
    }
    if(action==='getHydraulicIntake'){
      const reviews=await latestReviews(env.DB,model.model_id,model.version);
      return reply({status:'success',dma:model.zone_name,modelId:model.model_id,version:model.version,reviews,
        baselineEnabled:false,notice:'Nilai DRAFT/ASSUMED tidak mengaktifkan baseline. Topologi dan model sebenar mesti disahkan.'},headers);
    }
    if(action==='reviewHydraulicDraft'){
      const entryId=String(data.entryId||'').trim();
      const decision=String(data.decision||'').toUpperCase();
      const note=String(data.note||'').trim();
      if(!/^[\w-]{8,100}$/.test(entryId)||!['APPROVED','REJECTED'].includes(decision)||note.length<8||note.length>1000)
        return reply({status:'error',message:'Entry ID, keputusan dan alasan semakan (8–1000 aksara) wajib.'},headers,400);
      const draft=await env.DB.prepare(`SELECT * FROM hydraulic_parameter_reviews
        WHERE entry_id=? AND model_id=? AND version=? AND review_status='DRAFT'`).bind(entryId,model.model_id,model.version).first();
      if(!draft)return reply({status:'error',message:'DRAFT tidak ditemui bagi model/DMA ini.'},headers,404);
      if(identity(user)===draft.entered_by)return reply({status:'error',message:'Penyedia tidak boleh meluluskan entri sendiri.'},headers,403);
      const latest=await env.DB.prepare(`SELECT entry_id FROM hydraulic_parameter_reviews
        WHERE model_id=? AND version=? AND entity_type=? AND entity_id=? AND parameter_name=?
        ORDER BY entered_at DESC,rowid DESC LIMIT 1`).bind(model.model_id,model.version,draft.entity_type,draft.entity_id,draft.parameter_name).first();
      if(latest?.entry_id!==entryId)return reply({status:'error',message:'Entri telah diganti; semak rekod terkini.'},headers,409);
      const now=new Date().toISOString(),newId=crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO hydraulic_parameter_reviews
        (entry_id,model_id,version,entity_type,entity_id,parameter_name,value_real,value_text,unit,classification,
         source_ref,source_sha256,effective_at,entered_by,entered_at,review_status,reviewed_by,reviewed_at,review_note,supersedes_entry_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(newId,draft.model_id,draft.version,draft.entity_type,draft.entity_id,
          draft.parameter_name,draft.value_real,draft.value_text,draft.unit,draft.classification,draft.source_ref,
          draft.source_sha256,draft.effective_at,draft.entered_by,now,decision,identity(user),now,note,entryId).run();
      return reply({status:'success',entryId:newId,decision,baselineEnabled:false},headers);
    }
    const prepared=await prepareHydraulicIntake(env.DB,data,user);
    if(action==='previewHydraulicIntake')return reply({status:'success',preview:prepared.preview},headers);
    if(prepared.preview.accepted!==prepared.rows.length)
      return reply({status:'error',message:'Batch tidak sah/berkonflik; tiada data disimpan.',preview:prepared.preview},headers,409);
    if(String(data.confirmationHash||'')!==prepared.preview.confirmationHash||data.confirm!==true)
      return reply({status:'error',message:'Pratonton dan pengesahan tepat diperlukan sebelum simpan.',preview:prepared.preview},headers,400);
    const now=new Date().toISOString();
    const statements=prepared.rows.map(record=>env.DB.prepare(`INSERT INTO hydraulic_parameter_reviews
      (entry_id,model_id,version,entity_type,entity_id,parameter_name,value_real,value_text,unit,classification,
       source_ref,source_sha256,effective_at,entered_by,entered_at,review_status,review_note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),record.modelId,record.version,record.entityType,
        record.entityId,record.parameter,record.classification==='MISSING'||['TEXT','JSON'].includes(record.unit)?null:Number(record.value),
        record.classification==='MISSING'||!['TEXT','JSON'].includes(record.unit)?null:record.value,record.unit,record.classification,
        record.sourceRef,String(data.sourceSha256||'').slice(0,64)||null,record.effectiveAt||null,record.enteredBy,now,'DRAFT',record.notes||null));
    await env.DB.batch(statements);
    return reply({status:'success',saved:statements.length,reviewStatus:'DRAFT',baselineEnabled:false,
      message:'Rekod DRAFT disimpan. Semakan jurutera lain diperlukan sebelum digunakan untuk readiness.'},headers);
  }catch(error){
    const bad=/Pilih satu DMA|tidak berdaftar|Satu hingga|Identiti ADMIN|SHA-256 fail/.test(error.message);
    return reply({status:'error',message:bad?error.message:'Hydraulic intake tidak tersedia atau skema belum dimigrasi; tiada kelulusan automatik.'},headers,bad?400:503);
  }
}
