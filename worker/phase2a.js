// Phase 2A operational data foundation. No hydraulic or leak-localisation claim.
export const PARAMETERS = Object.freeze({
  flow: { code: 'FLOW', unit: 'm3/h', legacy: 'flow_m3h' },
  inlet: { code: 'INLET_PRESSURE', unit: 'bar', legacy: 'pressure_inlet_bar' },
  cp: { code: 'CP_PRESSURE', unit: 'bar', legacy: 'pressure_cp_bar' },
  nightUse: { code: 'NIGHT_USE', unit: 'm3/h', legacy: 'legitimate_night_use_m3h' }
});
// Keep one import invocation below the D1 Free-plan 50-query ceiling even
// when all four parameters are present (40 inserts + metadata/read queries).
export const IMPORT_CHUNK_ROWS = 10;

const ALIASES = Object.freeze({
  dma: ['dma', 'dma name', 'district metered area', 'zone'],
  recordedAt: ['recorded_at', 'timestamp', 'date time', 'datetime', 'tarikh masa', 'masa bacaan'],
  sensorId: ['sensor id', 'sensor_id', 'meter id', 'meter_id'],
  flow: ['flow', 'flow rate', 'flow_m3h', 'aliran', 'mnf'],
  inlet: ['pressure inlet', 'inlet pressure', 'pressure_inlet_bar', 'tekanan inlet'],
  cp: ['cp pressure', 'pressure cp', 'pressure_cp_bar', 'tekanan cp'],
  nightUse: ['legitimate_night_use_m3h', 'legitimate night use', 'penggunaan sah malam']
});

const cleanHeader = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
const cleanText = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const safeText = value => !/[\u0000-\u001f]/.test(value) && !/^[=+@]/.test(value);
const operatorName = user => cleanText(user.username || user.email || 'dashboard', 120);
const success = (body, headers, status = 200) => new Response(JSON.stringify({ status: 'success', ...body }), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
const failure = (message, headers, status = 400) => new Response(JSON.stringify({ status: 'error', message }), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

export function suggestMapping(headers) {
  const columns = headers.map(String);
  const mapping = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const hits = columns.filter(column => aliases.includes(cleanHeader(column)));
    mapping[field] = hits.length === 1 ? hits[0] : '';
  }
  return mapping;
}

export function parseRecordedAt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { iso: null, status: 'MISSING_TIMESTAMP' };
  const text = String(value).trim();
  let candidate = text;
  let parts;
  if ((parts = text.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/))) {
    candidate = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6] || '00'}+08:00`;
  } else if ((parts = text.match(/^(\d\d?)\/(\d\d?)\/(\d{4})\s+(\d\d?):(\d\d)(?::(\d\d))?$/))) {
    const pad = n => String(n).padStart(2, '0');
    candidate = `${parts[3]}-${pad(parts[2])}-${pad(parts[1])}T${pad(parts[4])}:${parts[5]}:${parts[6] || '00'}+08:00`;
  } else if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(text)) {
    return { iso: null, status: 'INVALID_TIMESTAMP' };
  }
  const date = new Date(candidate);
  if (!Number.isFinite(date.getTime())) return { iso: null, status: 'INVALID_TIMESTAMP' };
  // Date.parse normalises impossible dates; explicitly reject them.
  const m = candidate.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[4]) > 23 || Number(m[5]) > 59) return { iso: null, status: 'INVALID_TIMESTAMP' };
  const dim = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  if (Number(m[3]) > dim) return { iso: null, status: 'INVALID_TIMESTAMP' };
  return { iso: date.toISOString(), status: 'MEASURED' };
}

function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === '') return { absent: true };
  const raw = String(value).trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(raw)) return { error: 'INVALID_VALUE' };
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 10000000) return { error: 'INVALID_VALUE' };
  return { value: number };
}

export function validateMapping(headers, mapping, units = {}) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Pemetaan kolum diperlukan.');
  const known = new Set(headers.map(String));
  const selected = [];
  for (const [field, column] of Object.entries(mapping)) {
    if (!Object.hasOwn(ALIASES, field)) throw new Error(`Medan pemetaan tidak dikenali: ${field}`);
    if (column && !known.has(column)) throw new Error(`Kolum tidak wujud: ${column}`);
    if (column) selected.push(column);
  }
  if (selected.length !== new Set(selected).size) throw new Error('Satu kolum tidak boleh dipetakan kepada dua medan.');
  if (!Object.keys(PARAMETERS).some(field => mapping[field])) throw new Error('Pilih sekurang-kurangnya satu parameter.');
  for (const [field, spec] of Object.entries(PARAMETERS)) {
    if (mapping[field] && units[field] !== spec.unit) throw new Error(`Unit ${field} mesti disahkan sebagai ${spec.unit}.`);
  }
  return true;
}

export async function observationUid(dma, sensorId, parameter, recordedAt) {
  const key = [dma.toUpperCase(), sensorId.toUpperCase(), parameter, recordedAt].join('|');
  const bytes = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function normalizeImportRows(rows, mapping, units, defaultDma = '', offset = 0) {
  const observations = [], issues = [];
  const stats = { rowsDetected: rows.length, rowsAccepted: 0, rowsRejected: 0, missingTimestamp: 0, invalidTimestamp: 0, missingDma: 0, missingCp: 0, invalidValue: 0, unknownParameter: 0, affectedDmas: [] };
  const dmas = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const rowNumber = offset + i + 1;
    const dma = cleanText(mapping.dma ? row[mapping.dma] : defaultDma).toUpperCase();
    const time = parseRecordedAt(mapping.recordedAt ? row[mapping.recordedAt] : null);
    const sensor = cleanText(mapping.sensorId ? row[mapping.sensorId] : '', 120).toUpperCase() || 'DMA_UNSPECIFIED';
    const values = [];
    let invalid = false;
    for (const [field, spec] of Object.entries(PARAMETERS)) {
      if (!mapping[field]) continue;
      const parsed = numeric(row[mapping[field]]);
      if (parsed.error) { issues.push({ rowNumber, code: 'INVALID_VALUE', dma, parameter: spec.code }); stats.invalidValue++; invalid = true; }
      else if (!parsed.absent) values.push({ ...spec, value: parsed.value });
    }
    if (!mapping.cp || numeric(row[mapping.cp]).absent) stats.missingCp++;
    if (!dma || !safeText(dma)) { issues.push({ rowNumber, code: 'MISSING_DMA', dma: '', parameter: '' }); stats.missingDma++; invalid = true; }
    if (!time.iso) {
      // Hold the mapped measurement values as an issue, never as an active
      // reading with the import time masquerading as measurement time.
      const detail = JSON.stringify({ rawTimestamp: mapping.recordedAt ? cleanText(row[mapping.recordedAt],80) : '', sensorId: sensor, values: Object.fromEntries(values.map(item => [item.code,item.value])) }).slice(0,1500);
      issues.push({ rowNumber, code: time.status, dma, parameter: '', detail });
      stats.missingTimestamp += time.status === 'MISSING_TIMESTAMP' ? 1 : 0;
      stats.invalidTimestamp += time.status === 'INVALID_TIMESTAMP' ? 1 : 0;
      invalid = true;
    }
    if (!values.length && !invalid) { issues.push({ rowNumber, code: 'NO_PARAMETER', dma, parameter: '' }); stats.unknownParameter++; invalid = true; }
    if (invalid) { stats.rowsRejected++; continue; }
    stats.rowsAccepted++; dmas.add(dma);
    for (const item of values) observations.push({
      uid: await observationUid(dma, sensor, item.code, time.iso),
      dma, sensorId: sensor, parameter: item.code, value: item.value, unit: units[Object.keys(PARAMETERS).find(k => PARAMETERS[k].code === item.code)],
      recordedAt: time.iso, legacy: item.legacy, rowNumber
    });
  }
  stats.affectedDmas = [...dmas];
  return { observations, issues, stats };
}

function insertObservation(db, item, source, batchId, user, remark = '') {
  const wide = { flow_m3h: null, pressure_inlet_bar: null, pressure_cp_bar: null, legitimate_night_use_m3h: null };
  wide[item.legacy] = item.value;
  return db.prepare(`INSERT OR IGNORE INTO dma_telemetry
    (district_metered_area,recorded_at,flow_m3h,pressure_inlet_bar,pressure_cp_bar,legitimate_night_use_m3h,source,created_by,observation_uid,sensor_id,parameter,value,unit,timestamp_provenance,quality_status,import_batch_id,remark)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.dma,item.recordedAt,wide.flow_m3h,wide.pressure_inlet_bar,wide.pressure_cp_bar,wide.legitimate_night_use_m3h,source,user,item.uid,item.sensorId,item.parameter,item.value,item.unit,'MEASURED','VALID',batchId,remark);
}

function protectName(value) {
  const name = cleanText(value, 180).replace(/[\\/]/g, '_');
  if (!name || !safeText(name)) throw new Error('Nama fail tidak sah.');
  return name;
}

function hasWriteRole(user) { return user.level && user.level !== 'GUEST'; }
function requireAdmin(user, headers) { return user.level === 'ADMIN' ? null : failure('Hanya ADMIN dibenarkan.', headers, 403); }

async function existingUids(db, observations) {
  if (!observations.length) return new Map();
  const unique = [...new Set(observations.map(item => item.uid))];
  const found = new Map();
  for (let i = 0; i < unique.length; i += 80) {
    const piece = unique.slice(i, i + 80);
    const result = await db.prepare(`SELECT observation_uid,value,source FROM dma_telemetry WHERE observation_uid IN (${piece.map(() => '?').join(',')})`).bind(...piece).all();
    for (const row of result.results || []) found.set(row.observation_uid, row);
  }
  return found;
}

async function importChunk(db, data, user, headers) {
  const { batchId, partIndex, isFinal, rows, mapping, units, headers: columns, defaultDma, sourceName, sourceSha256, totalRows } = data;
  if (!/^[a-f0-9-]{36}$/i.test(String(batchId)) || !Number.isInteger(partIndex) || partIndex < 0 || partIndex > 10000) return failure('ID/urutan batch tidak sah.', headers);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > IMPORT_CHUNK_ROWS || !Array.isArray(columns) || columns.length > 100 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return failure(`Maksimum ${IMPORT_CHUNK_ROWS} baris setiap bahagian import.`, headers);
  if (!isFinal && rows.length !== IMPORT_CHUNK_ROWS) return failure('Bahagian bukan akhir mesti penuh dan mengikut turutan.', headers);
  if (!/^[a-f0-9]{64}$/i.test(String(sourceSha256)) || !Number.isInteger(totalRows) || totalRows < rows.length || totalRows > 10000) return failure('Metadata fail tidak sah.', headers);
  if (Boolean(isFinal) !== (partIndex * IMPORT_CHUNK_ROWS + rows.length === totalRows)) return failure('Penanda bahagian akhir tidak sepadan dengan jumlah baris.', headers);
  try { validateMapping(columns, mapping, units); protectName(sourceName); } catch (error) { return failure(error.message, headers); }
  const chunkText = JSON.stringify({ rows, mapping, units, defaultDma:cleanText(defaultDma).toUpperCase(), partIndex, isFinal:Boolean(isFinal) });
  if (chunkText.length > 150000) return failure('Bahagian import terlalu besar.', headers, 413);
  const chunkSha256 = await sha256Text(chunkText);
  const old = await db.prepare('SELECT * FROM operational_import_batches WHERE batch_id=?').bind(batchId).first();
  const batchConfig = JSON.stringify({ mapping, units, defaultDma: cleanText(defaultDma).toUpperCase() });
  if (old && (old.uploaded_by !== operatorName(user) || old.source_sha256 !== sourceSha256 || old.mapping_json !== batchConfig || old.rows_detected !== totalRows)) return failure('Batch ID telah digunakan untuk fail/pemetaan lain.', headers, 409);
  if (!old && partIndex !== 0) return failure('Bahagian pertama mesti dihantar dahulu.', headers, 409);
  const prior = await db.prepare('SELECT chunk_sha256,report_json FROM operational_import_chunks WHERE batch_id=? AND part_index=?').bind(batchId,partIndex).first();
  if (prior) return prior.chunk_sha256 === chunkSha256 ? success({ report: JSON.parse(prior.report_json), replay: true }, headers) : failure('Bahagian batch berubah selepas import.', headers, 409);
  if (old && ['COMPLETED','FAILED'].includes(old.status)) return failure('Batch telah ditutup; gunakan batch ID baharu.', headers, 409);
  const partCount = await db.prepare('SELECT COUNT(*) AS n FROM operational_import_chunks WHERE batch_id=?').bind(batchId).first();
  if ((partCount?.n || 0) !== partIndex) return failure('Bahagian import mesti mengikut turutan.', headers, 409);
  const normalized = await normalizeImportRows(rows, mapping, units, defaultDma, partIndex * IMPORT_CHUNK_ROWS);
  const found = await existingUids(db, normalized.observations);
  const seen = new Set();
  const fresh = [];
  let duplicatesSkipped = 0, conflictsSkipped = 0;
  for (const item of normalized.observations) {
    const previous = found.get(item.uid);
    if (previous || seen.has(item.uid)) {
      duplicatesSkipped++;
      if (previous && Number(previous.value) !== item.value) conflictsSkipped++;
    } else { fresh.push(item); seen.add(item.uid); }
  }
  const report = { ...normalized.stats, observationsInserted: fresh.length, duplicatesSkipped, conflictsSkipped, batchId, partIndex, final: Boolean(isFinal) };
  const finalStatus = isFinal ? ((old?.rows_accepted || 0) + report.rowsAccepted > 0 ? 'COMPLETED' : 'FAILED') : 'PARTIAL';
  const validationSummary = {
    lastPartIndex: partIndex,
    rowsAccepted: (old?.rows_accepted || 0) + report.rowsAccepted,
    rowsRejected: (old?.rows_rejected || 0) + report.rowsRejected,
    missingTimestamp: (old?.missing_timestamp || 0) + report.missingTimestamp,
    invalidTimestamp: (old?.invalid_timestamp || 0) + report.invalidTimestamp,
    missingDma: (old?.missing_dma || 0) + report.missingDma,
    missingCp: (old?.missing_cp || 0) + report.missingCp,
    invalidValue: (old?.invalid_value || 0) + report.invalidValue,
    unknownParameter: (old?.unknown_parameter || 0) + report.unknownParameter
  };
  const statements = [];
  if (!old) statements.push(db.prepare(`INSERT INTO operational_import_batches(batch_id,source_name,source_sha256,mapping_json,uploaded_by,status,rows_detected)
      VALUES(?,?,?,?,?,'IMPORTING',?)`).bind(batchId,protectName(sourceName),sourceSha256,batchConfig,operatorName(user),totalRows));
  for (const item of fresh) statements.push(insertObservation(db,item,'SCADA_CSV',batchId,operatorName(user)));
  const issueRows = new Set();
  for (const issue of normalized.issues) {
    if (issueRows.has(issue.rowNumber)) continue;
    issueRows.add(issue.rowNumber);
    statements.push(db.prepare(`INSERT OR IGNORE INTO operational_import_issues(batch_id,row_number,issue_code,dma,parameter,detail) VALUES(?,?,?,?,?,?)`).bind(batchId,issue.rowNumber,issue.code,issue.dma || null,issue.parameter || '',issue.detail || null));
  }
  statements.push(db.prepare(`INSERT INTO operational_import_chunks(batch_id,part_index,chunk_sha256,report_json) VALUES(?,?,?,?)`).bind(batchId,partIndex,chunkSha256,JSON.stringify(report)));
  statements.push(db.prepare(`UPDATE operational_import_batches SET status=?,completed_at=?,rows_accepted=rows_accepted+?,rows_rejected=rows_rejected+?,duplicates_skipped=duplicates_skipped+?,conflicts_skipped=conflicts_skipped+?,missing_timestamp=missing_timestamp+?,invalid_timestamp=invalid_timestamp+?,missing_dma=missing_dma+?,missing_cp=missing_cp+?,invalid_value=invalid_value+?,unknown_parameter=unknown_parameter+?,validation_summary_json=? WHERE batch_id=?`).bind(finalStatus,isFinal ? new Date().toISOString() : null,report.rowsAccepted,report.rowsRejected,duplicatesSkipped,conflictsSkipped,report.missingTimestamp,report.invalidTimestamp,report.missingDma,report.missingCp,report.invalidValue,report.unknownParameter,JSON.stringify(validationSummary),batchId));
  try {
    const result = await db.batch(statements);
    const actualInserted = result.slice(old ? 0 : 1, (old ? 0 : 1) + fresh.length).reduce((n,entry) => n + (entry.meta?.changes || 0), 0);
    if (actualInserted !== fresh.length) {
      const raced = fresh.length - actualInserted;
      report.observationsInserted = actualInserted;
      report.duplicatesSkipped += raced;
      report.concurrentDuplicates = raced;
      await db.batch([
        db.prepare('UPDATE operational_import_chunks SET report_json=? WHERE batch_id=? AND part_index=?').bind(JSON.stringify(report),batchId,partIndex),
        db.prepare('UPDATE operational_import_batches SET duplicates_skipped=duplicates_skipped+? WHERE batch_id=?').bind(raced,batchId)
      ]);
    }
    return success({ report, batchStatus:finalStatus, message: isFinal ? (finalStatus === 'FAILED' ? 'Import gagal: tiada baris sah.' : 'Import selesai.') : 'Bahagian import disimpan.' }, headers);
  } catch (error) { console.error('Phase 2A import failed', error); return failure('Import gagal; bahagian terdahulu kekal dan boleh disambung semula. Semak log pentadbir.', headers, 500); }
}

async function saveManualAndAld(db, data, user, headers) {
  const dma = cleanText(data.dma).toUpperCase();
  if (!dma || !safeText(dma)) return failure('DMA tidak sah.', headers);
  const row = data.manualTelemetry || {};
  const columns = ['recorded_at','flow_m3h','pressure_inlet_bar','pressure_cp_bar','legitimate_night_use_m3h'];
  const mapping = { recordedAt:'recorded_at', flow:'flow_m3h', inlet:'pressure_inlet_bar', cp:'pressure_cp_bar', nightUse:'legitimate_night_use_m3h' };
  const units = {flow:'m3/h',inlet:'bar',cp:'bar',nightUse:'m3/h'};
  const normalized = await normalizeImportRows([row],mapping,units,dma);
  const manualHasValues = columns.slice(1).some(key => row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== '');
  if (manualHasValues && normalized.stats.rowsRejected) return failure(`Bacaan manual tidak disimpan: ${normalized.issues.map(x => x.code).join(', ')}. Masa bacaan sebenar wajib diisi.`, headers);
  const sensors = Array.isArray(data.sensors) ? data.sensors.slice(0,10) : [];
  const ald = data.ald && ['CONFIRMED_LEAK','NO_LEAK','SUSPECTED'].includes(data.ald.result_status) ? data.ald : null;
  const assessment = data.systemAssessment && typeof data.systemAssessment === 'object' ? data.systemAssessment : null;
  if (assessment && !['NOT_ASSESSED','SUSPECTED_ABNORMAL','NO_ANOMALY','ALD_RECOMMENDED'].includes(assessment.status)) return failure('Status penilaian sistem tidak sah.',headers);
  if (ald && (!['','LEAK','BURST','OTHER'].includes(cleanText(ald.result_category,80)) || (ald.result_status === 'NO_LEAK' && ald.result_category))) return failure('Kategori keputusan ALD tidak sepadan dengan status.',headers);
  if (!manualHasValues && !sensors.length && !ald && !assessment) return failure('Tiada bacaan, sensor, penilaian atau keputusan ALD yang sah.', headers);
  const found = await existingUids(db, normalized.observations);
  const fresh = normalized.observations.filter(item => !found.has(item.uid));
  const conflicts = normalized.observations.filter(item => found.has(item.uid) && Number(found.get(item.uid).value) !== item.value).length;
  const statements = fresh.map(item => insertObservation(db,item,'MANUAL',null,operatorName(user),cleanText(data.remark,500)));
  for (const sensor of sensors) {
    const lat = Number(sensor.latitude), lng = Number(sensor.longitude);
    const type = cleanText(sensor.sensor_type,50).toUpperCase(), name = cleanText(sensor.sensor_name,120);
    if (!['FLOW_METER','PRESSURE_CP','PRV','INLET_PRESSURE'].includes(type) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180 || !safeText(name)) return failure('Butiran sensor tidak sah.', headers);
    statements.push(db.prepare(`INSERT INTO dma_sensors(district_metered_area,sensor_type,sensor_name,latitude,longitude,updated_at,created_by)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(district_metered_area,sensor_type,sensor_name)
      DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,updated_at=CURRENT_TIMESTAMP,created_by=excluded.created_by`).bind(dma,type,name,lat,lng,operatorName(user)));
  }
  const investigationId = cleanText(data.investigationId,80) || crypto.randomUUID();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(investigationId)) return failure('ID penyiasatan tidak sah.', headers);
  const existingInvestigation = await db.prepare('SELECT district_metered_area FROM ald_investigations WHERE investigation_id=?').bind(investigationId).first();
  if (existingInvestigation && existingInvestigation.district_metered_area.toUpperCase() !== dma) return failure('ID penyiasatan milik DMA lain.',headers,409);
  if (assessment || ald) statements.push(db.prepare(`INSERT OR IGNORE INTO ald_investigations(investigation_id,district_metered_area,assessment_status,candidate_pipe_id,assessment_note,created_by)
    VALUES(?,?,?,?,?,?)`).bind(investigationId,dma,cleanText(assessment?.status || 'NOT_ASSESSED',50),cleanText(assessment?.candidatePipeId,100) || null,cleanText(assessment?.note,1000) || null,operatorName(user)));
  if (ald) {
    const inspected = parseRecordedAt(ald.inspected_at);
    if (!inspected.iso) return failure('Masa sebenar pemeriksaan ALD wajib diisi.', headers);
    const leak = ald.estimated_leak_m3h == null || ald.estimated_leak_m3h === '' ? null : numeric(ald.estimated_leak_m3h);
    if (leak?.error) return failure('Kadar kebocoran ALD tidak sah.', headers);
    const eventUid = await observationUid(dma,investigationId,`${ald.result_status}|${cleanText(ald.pipe_id,100)}`,inspected.iso);
    statements.push(db.prepare(`INSERT OR IGNORE INTO ald_results(district_metered_area,inspected_at,location,result_status,estimated_leak_m3h,notes,created_by,investigation_id,pipe_id,result_category,repair_reference,confirmed_by,field_event_uid)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(dma,inspected.iso,cleanText(ald.location,500),ald.result_status,leak?.value ?? null,cleanText(ald.notes,2000),operatorName(user),investigationId,cleanText(ald.pipe_id,100)||null,cleanText(ald.result_category,80)||null,cleanText(ald.repair_reference,120)||null,operatorName(user),eventUid));
  }
  if (!statements.length) return success({ message:'Bacaan sedia ada; tiada rekod baharu ditambah.', duplicatesSkipped: normalized.observations.length, conflictsSkipped: conflicts },headers);
  try { await db.batch(statements); return success({ message:'Pemantauan / ALD disimpan dalam D1.', observationsInserted:fresh.length,duplicatesSkipped:normalized.observations.length-fresh.length,conflictsSkipped:conflicts,investigationId:ald||assessment?investigationId:null },headers); }
  catch (error) { console.error('Phase 2A monitoring save failed', error); return failure('Gagal menyimpan pemantauan; semak log pentadbir.',headers,500); }
}

export function readinessFromData(observations, sensors, hasAssets) {
  const latest = new Map();
  for (const row of observations) if (!latest.has(row.parameter)) latest.set(row.parameter,row);
  const configured = new Set(sensors.map(row => row.sensor_type));
  const statusFor = (parameter,type) => {
    const row = latest.get(parameter);
    if (row) return row.source === 'MANUAL' ? 'READING_MANUAL' : row.source === 'SCADA_CSV' ? 'READING_FROM_SCADA_CSV' : 'AVAILABLE_LEGACY';
    return configured.has(type) ? 'SENSOR_CONFIGURED_NO_READING' : 'SENSOR_NOT_CONFIGURED';
  };
  const parameters = { FLOW:statusFor('FLOW','FLOW_METER'), INLET_PRESSURE:statusFor('INLET_PRESSURE','INLET_PRESSURE'), CP_PRESSURE:statusFor('CP_PRESSURE','PRESSURE_CP'), NIGHT_USE:statusFor('NIGHT_USE','FLOW_METER') };
  const available = value => value.startsWith('READING_') || value === 'AVAILABLE_LEGACY';
  const sensorIdentity = Object.fromEntries([...latest].map(([key,row])=>[key,row.sensor_id && row.sensor_id !== 'DMA_UNSPECIFIED' ? 'IDENTIFIED' : 'UNKNOWN']));
  return { parameters, sensorIdentity, pipeAssets:hasAssets?'AVAILABLE':'MISSING', hydraulicTopology:'MISSING', analysis:{ historical:'UNKNOWN', basicAnomaly:available(parameters.FLOW)?'PARTIAL':'NOT_READY', leakLocalisation:'NOT_READY', hydraulicSimulation:'NOT_READY' }, analysisReasons:{basicAnomaly:'PARTIAL hanya bermaksud ada bacaan flow; baseline masa dan tekanan belum disahkan.'}, latestAt:Object.fromEntries([...latest].map(([key,row])=>[key,row.recorded_at])) };
}

async function storageStatus(db, headers) {
  const result = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM water_assets) AS assetRows,
    (SELECT COUNT(*) FROM pipe_network_segments) AS pipeSegments,
    (SELECT COUNT(*) FROM dma_telemetry) AS telemetryRows,
    (SELECT COUNT(*) FROM ald_results) AS aldRows,
    (SELECT COUNT(*) FROM ai_chat_history) AS chatRows,
    (SELECT COUNT(*) FROM operational_import_batches) AS importBatches,
    (SELECT COUNT(*) FROM operational_import_issues) AS importIssues`).all();
  const lastImport = await db.prepare(`SELECT batch_id,source_name,started_at,completed_at,status,rows_detected,rows_accepted,rows_rejected,duplicates_skipped,missing_timestamp,invalid_timestamp
    FROM operational_import_batches ORDER BY started_at DESC LIMIT 1`).first();
  return success({ databaseBytes:Number.isFinite(result.meta?.size_after)?result.meta.size_after:null, sizeSource:'D1Result.meta.size_after', counts:result.results?.[0]||{}, lastImport:lastImport||null, checkedAt:new Date().toISOString() },headers);
}

async function cleanupCounts(db, category) {
  if (category === 'FAILED_IMPORT_ISSUES') {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM operational_import_issues WHERE batch_id IN
      (SELECT batch_id FROM operational_import_batches WHERE status='FAILED' AND rows_accepted=0)`).first();
    return row?.n || 0;
  }
  if (category === 'SCADA_CSV_OBSERVATIONS') {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM dma_telemetry WHERE source='SCADA_CSV' AND import_batch_id IS NOT NULL").first();
    return row?.n || 0;
  }
  throw new Error('Kategori cleanup tidak dibenarkan.');
}

async function cleanupToken(secret, category, count, issuedAt) {
  const raw = `${category}|${count}|${issuedAt}`;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw));
  return [...new Uint8Array(signature)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function cleanupAction(db, data, user, headers, secret, execute) {
  const category = data.category;
  if (!['FAILED_IMPORT_ISSUES','SCADA_CSV_OBSERVATIONS'].includes(category)) return failure('Kategori cleanup tidak dibenarkan.',headers);
  const before = await cleanupCounts(db,category);
  const assets = (await db.prepare('SELECT COUNT(*) AS n FROM water_assets').first())?.n || 0;
  const segments = (await db.prepare('SELECT COUNT(*) AS n FROM pipe_network_segments').first())?.n || 0;
  const zoneLines = (await db.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').first())?.n || 0;
  const ald = (await db.prepare('SELECT COUNT(*) AS n FROM ald_results').first())?.n || 0;
  const protectedCategories = ['water_assets','pipe_network_segments','pipe_network_zone_lines','DMA polygons','users/security','ald_results','repair history'];
  if (!execute) {
    const issuedAt = Date.now();
    return success({category,eligibleCount:before,protectedCategories,issuedAt,previewToken:await cleanupToken(secret,category,before,issuedAt)},headers);
  }
  if (data.confirmation !== 'CLEANUP' || !Number.isInteger(data.issuedAt) || Date.now()-data.issuedAt>300000 || Date.now()<data.issuedAt) return failure('Pengesahan CLEANUP/pratonton telah luput.',headers,403);
  const expected = await cleanupToken(secret,category,before,data.issuedAt);
  if (data.previewToken !== expected) return failure('Kiraan telah berubah; buka pratonton baharu.',headers,409);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM storage_cleanup_audit WHERE performed_by=? AND attempted_at >= datetime('now','-10 minutes')").bind(operatorName(user)).first();
  if ((recent?.n || 0) >= 3) return failure('Had cleanup pentadbir dicapai; cuba lagi kemudian.',headers,429);
  const cleanupId = crypto.randomUUID();
  await db.prepare(`INSERT INTO storage_cleanup_audit(cleanup_id,performed_by,category,status,before_count,protected_assets_before,protected_segments_before,protected_zone_lines_before,protected_ald_before)
    VALUES(?,?,?,'STARTED',?,?,?,?,?)`).bind(cleanupId,operatorName(user),category,before,assets,segments,zoneLines,ald).run();
  try {
    const deleteSql = category === 'FAILED_IMPORT_ISSUES'
      ? `DELETE FROM operational_import_issues WHERE batch_id IN (SELECT batch_id FROM operational_import_batches WHERE status='FAILED' AND rows_accepted=0)`
      : `DELETE FROM dma_telemetry WHERE source='SCADA_CSV' AND import_batch_id IS NOT NULL`;
    const deleted = await db.prepare(deleteSql).run();
    const after = await cleanupCounts(db,category);
    const assetsAfter = (await db.prepare('SELECT COUNT(*) AS n FROM water_assets').first())?.n || 0;
    const segmentsAfter = (await db.prepare('SELECT COUNT(*) AS n FROM pipe_network_segments').first())?.n || 0;
    const zoneLinesAfter = (await db.prepare('SELECT COUNT(*) AS n FROM pipe_network_zone_lines').first())?.n || 0;
    const aldAfter = (await db.prepare('SELECT COUNT(*) AS n FROM ald_results').first())?.n || 0;
    const safe = assetsAfter===assets && segmentsAfter===segments && zoneLinesAfter===zoneLines && aldAfter===ald;
    await db.prepare(`UPDATE storage_cleanup_audit SET completed_at=CURRENT_TIMESTAMP,status=?,deleted_count=?,after_count=?,protected_assets_after=?,protected_segments_after=?,protected_zone_lines_after=?,protected_ald_after=?,error_code=? WHERE cleanup_id=?`)
      .bind(safe?'COMPLETED':'FAILED',deleted.meta?.changes||0,after,assetsAfter,segmentsAfter,zoneLinesAfter,aldAfter,safe?null:'PROTECTED_COUNT_CHANGED',cleanupId).run();
    return safe ? success({cleanupId,category,beforeCount:before,deletedCount:deleted.meta?.changes||0,afterCount:after,protectedAssets:assetsAfter,protectedSegments:segmentsAfter,protectedZoneLines:zoneLinesAfter,protectedAld:aldAfter},headers)
      : failure('Semakan data dilindungi gagal; hentikan operasi lanjut dan semak audit.',headers,500);
  } catch (error) {
    await db.prepare(`UPDATE storage_cleanup_audit SET completed_at=CURRENT_TIMESTAMP,status='FAILED',error_code=? WHERE cleanup_id=?`).bind(cleanText(error.message,200),cleanupId).run();
    return failure('Cleanup gagal; semak log audit.',headers,500);
  }
}

export async function handlePhase2aAction({ action, data, env, user, headers, secret }) {
  const supported = new Set(['saveDmaMonitoring','previewOperationalImport','importOperationalChunk','getDmaReadiness','getStorageStatus','previewStorageCleanup','executeStorageCleanup']);
  if (!supported.has(action)) return null;
  if (JSON.stringify(data).length > 200000) return failure('Permintaan Phase 2A terlalu besar.',headers,413);
  if (!env.DB) return failure('D1 binding tiada.',headers,503);
  if (['getStorageStatus','previewStorageCleanup','executeStorageCleanup'].includes(action)) {
    const denied = requireAdmin(user,headers); if (denied) return denied;
  } else if (!hasWriteRole(user)) return failure('Akses ditolak.',headers,403);
  if (action === 'previewOperationalImport') {
    if (!Array.isArray(data.headers) || data.headers.length>100 || !Array.isArray(data.rows) || data.rows.length>20) return failure('Pratonton maksimum 20 baris.',headers);
    try { validateMapping(data.headers,data.mapping,data.units); }
    catch(error) { return failure(error.message,headers); }
    const preview = await normalizeImportRows(data.rows,data.mapping,data.units,data.defaultDma);
    return success({preview:{stats:preview.stats,issues:preview.issues.slice(0,20),suggestedMapping:suggestMapping(data.headers)}},headers);
  }
  if (action === 'importOperationalChunk') return importChunk(env.DB,data,user,headers);
  if (action === 'saveDmaMonitoring') return saveManualAndAld(env.DB,data,user,headers);
  if (action === 'getStorageStatus') return storageStatus(env.DB,headers);
  if (action === 'getDmaReadiness') {
    const dma=cleanText(data.dma).toUpperCase(); if (!dma || !safeText(dma)) return failure('Pilih DMA.',headers);
    const obs=await env.DB.prepare('SELECT parameter,source,recorded_at,sensor_id FROM dma_telemetry WHERE UPPER(district_metered_area)=? AND parameter IS NOT NULL ORDER BY recorded_at DESC LIMIT 200').bind(dma).all();
    const sensors=await env.DB.prepare('SELECT sensor_type FROM dma_sensors WHERE UPPER(district_metered_area)=?').bind(dma).all();
    const pipe=await env.DB.prepare('SELECT 1 AS found FROM pipe_network_zone_lines WHERE UPPER(zone_name)=? LIMIT 1').bind(dma).first();
    const assets=pipe || await env.DB.prepare('SELECT 1 AS found FROM water_assets_unique WHERE UPPER(zone)=? LIMIT 1').bind(dma).first();
    return success({dma,readiness:readinessFromData(obs.results||[],sensors.results||[],Boolean(assets))},headers);
  }
  return cleanupAction(env.DB,data,user,headers,secret,action==='executeStorageCleanup');
}
