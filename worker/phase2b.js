// Phase 2B production-safe facade. No real model or EPANET service is enabled.
// All hydraulic questions are gated here before the legacy AI prompt path.
const json=(body,headers,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}});
export function hydraulicIntent(prompt) {
  const p=String(prompt||'').toLowerCase();
  if (/(simulasi|simulation|epanet|hidraulik|hydraulic|valve isolation|isolasi injap|pressure.*kalau|tekanan.*kalau|reserve margin|margin rizab|fire flow|aliran kebakaran|alternative supply|bekalan alternatif)/i.test(p)) return true;
  if (/(kalau|jika|sekiranya|if).*(paip|pipe|injap|valve).*(tutup|closed|gagal|failure|pecah)/i.test(p)) return true;
  if (/(mana|which).*(valve|injap).*(tutup|close)|(kawasan mana|where).*(pressure|tekanan).*(jatuh|drop)/i.test(p)) return true;
  if (/(banding|compare).*(normal|baseline).*(paip|pipe).*(gagal|failure|tutup|closed)/i.test(p)) return true;
  return false;
}

export function hydraulicScenarioIntent(prompt) {
  const p=String(prompt||'').toLowerCase();
  if(/(reserve margin|margin rizab)/.test(p))return 'RESERVE_MARGIN';
  if(/(valve|injap|isolasi)/.test(p))return 'VALVE_ISOLATION';
  if(/(alternative supply|bekalan alternatif)/.test(p))return 'ALTERNATIVE_SUPPLY';
  if(/(fire flow|aliran kebakaran)/.test(p))return 'FIRE_FLOW';
  if(/(pump|pam).*(off|gagal|failure)/.test(p))return 'PUMP_OFF';
  if(/(tank|tangki).*(level|paras)/.test(p))return 'TANK_LEVEL_CHANGE';
  if(/(banding|compare)/.test(p))return 'SCENARIO_COMPARE';
  if(/(paip|pipe).*(tutup|closed|gagal|failure|pecah)/.test(p))return 'PIPE_CLOSED';
  if(/(demand|permintaan)/.test(p))return 'DEMAND_CHANGE';
  if(/(source head|head sumber|reservoir)/.test(p))return 'SOURCE_HEAD_CHANGE';
  return null;
}

export async function productionHydraulicStatus(db, dma='') {
  const selected=String(dma||'').trim().slice(0,180);
  const sql=`SELECT COUNT(*) AS lineParts, COUNT(DISTINCT z.segment_key) AS segmentCount,
      COUNT(DISTINCT z.asset_num) AS assetCount,
      SUM(CASE WHEN s.size_mm IS NULL OR s.size_mm<=0 THEN 1 ELSE 0 END) AS missingDiameterParts,
      SUM(CASE WHEN s.length_m<=0 THEN 1 ELSE 0 END) AS missingGeometryLengthParts
    FROM pipe_network_zone_lines z
    JOIN pipe_network_active a ON a.import_id=z.import_id AND a.singleton=1
    JOIN pipe_network_segments s ON s.import_id=z.import_id AND s.segment_key=z.segment_key
    WHERE (?='' OR z.zone_name=?)`;
  const row=await db.prepare(sql).bind(selected,selected).first();
  const count=Number(row?.segmentCount||0);
  const issues=[];
  if(!count) issues.push({code:'NO_PIPE_LINES_FOR_ZONE',severity:'CRITICAL',detail:'Tiada jajaran GIS aktif bagi zon yang dipilih.'});
  if(Number(row?.missingDiameterParts||0)) issues.push({code:'MISSING_DIAMETER',severity:'MISSING',count:Number(row.missingDiameterParts),detail:'Bahagian garisan tanpa diameter aset.'});
  issues.push({code:'PIPE_ID_MAPPING_UNVERIFIED',severity:'MISSING',detail:'Pipe ID untuk keseluruhan GIS belum dipadankan secara deterministik; garisan tanpa asset ID tidak boleh digunakan sebagai link model.'});
  issues.push({code:'LENGTH_PROVENANCE_UNVERIFIED',severity:'MISSING',detail:'Panjang jajaran GIS bukan panjang paip kejuruteraan yang telah disahkan.'});
  // Phase 2A has GIS geometry but no hydraulic model tables in production.
  for(const [code,detail] of [
    ['TOPOLOGY_UNVERIFIED','Nod/sambungan, persilangan dan komponen belum diaudit serta disahkan.'],
    ['ROUGHNESS_MISSING','Nilai kekasaran paip dengan sumber/kelulusan belum direkod.'],
    ['ELEVATION_MISSING','Elevasi nod belum direkod.'],
    ['DEMAND_ALLOCATION_MISSING','Permintaan nod dan kaedah agihan belum direkod.'],
    ['SOURCE_HEAD_MISSING','Head sumber/boundary belum direkod.'],
    ['VALVE_DEFINITION_MISSING','Koordinat PRV sahaja tidak membentuk model injap.'],
    ['EQUIPMENT_INVENTORY_UNVERIFIED','Inventori pam, injap dan tangki belum diluluskan untuk model hidraulik.'],
    ['PATTERN_MISSING','Corak permintaan dan jadual operasi untuk extended-period belum disahkan.'],
    ['CAPACITY_BASIS_MISSING','Reserve margin memerlukan jenis kapasiti, formula dan unit yang diluluskan.'],
    ['CALIBRATION_MISSING','Pemerhatian sebenar yang dipadankan dengan model belum dinilai.']
  ]) issues.push({code,severity:'MISSING',detail});
  const scenarioCapabilities=Object.fromEntries([
    'PIPE_CLOSED','VALVE_ISOLATION','DEMAND_CHANGE','SOURCE_HEAD_CHANGE','PUMP_OFF',
    'TANK_LEVEL_CHANGE','FIRE_FLOW','ALTERNATIVE_SUPPLY','SCENARIO_COMPARE','RESERVE_MARGIN'
  ].map(type=>[type,{status:'NOT_READY',reasons:[
    'Baseline SAINS belum wujud bagi model/subnetwork yang lulus gerbang steady-state.',
    ...(['VALVE_ISOLATION','ALTERNATIVE_SUPPLY'].includes(type)?['Topologi injap/laluan alternatif belum disahkan.']:[]),
    ...(type==='RESERVE_MARGIN'?['Formula dan asas kapasiti belum diluluskan.']:[])
  ]}]));
  return {zone:selected||'Semua zon',gis:{segmentCount:count,lineParts:Number(row?.lineParts||0),assetCount:Number(row?.assetCount||0),missingDiameterParts:Number(row?.missingDiameterParts||0),lengthSource:'GEOMETRY_DERIVED'},
    status:'NOT_READY',modelVersion:null,calibrationStatus:'NOT_STARTED',engine:{version:'EPANET 2.2.0',integration:'TEST_ONLY'},
    capabilities:{topology:'NOT_READY',steadyState:'NOT_READY',extendedPeriod:'NOT_READY',calibration:'NOT_READY',leakLocalisation:'NOT_READY',valveIsolation:'NOT_READY'},issues,
    scenarioCapabilities,
    latestOperationalData:'CSV / manual snapshot only; PHASE2A_RELEASE_TEST excluded from engineering evidence.'};
}

export async function handlePhase2bAction({action,data,env,user,headers}) {
  if(!['getHydraulicStatus','aiAgent'].includes(action)) return null;
  if(action==='aiAgent'&&!hydraulicIntent(data.prompt)) return null;
  if(user?.level!=='ADMIN') return json({status:'error',message:'Akses Ditolak: status/model hidraulik untuk ADMIN sahaja.'},headers,403);
  if(!env.DB) return json({status:'error',message:'D1 tidak tersedia.'},headers,503);
  try {
    const model=await productionHydraulicStatus(env.DB,data.dma||data.params?.dma||'');
    if(action==='getHydraulicStatus') return json({status:'success',hydraulic:model},headers);
    const scenario=hydraulicScenarioIntent(data.prompt);
    const scenarioReason=scenario?` ${scenario}: ${model.scenarioCapabilities[scenario].reasons.join(' ')}`:'';
    return json({status:'success',answer:`Simulasi hidraulik belum boleh dijalankan bagi ${model.zone}. Model rangkaian SAINS berstatus NOT READY. EPANET sudah diuji pada model contoh sahaja, bukan pada rangkaian operasi.${scenarioReason} ${model.issues.slice(0,5).map(i=>i.detail).join(' ')} Tiada nilai tekanan/aliran simulasi dikeluarkan.`,
      confidence:{level:'LOW',reason:'Tiada model hidraulik produksi yang disahkan.'},metrics:[],calculations:[],recommendations:[],
      findings:model.issues.map(i=>i.detail),evidence:[{source:'D1 GIS',description:`${model.gis.segmentCount} segmen dalam zon dipilih; jajaran bukan model hidraulik.`,record_count:model.gis.segmentCount}],
      map:{enabled:false,markers:[],risk_zones:[]},hydraulic:model},headers);
  } catch(error) {
    console.error('Phase 2B status error',error);
    return json({status:'error',message:'Status hidraulik gagal disemak; simulasi tidak dijalankan.'},headers,503);
  }
}
