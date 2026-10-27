// ASTRA field observations: pure, deterministic parsing and calculations.
// No inference here can upgrade a measurement or a hydraulic model to VERIFIED.
export const MAX_FIELD_ROWS = 100;
export const MAX_FIELD_FILE_BYTES = 2 * 1024 * 1024;
export const WATER_DENSITY_KG_M3 = 1000;
export const STANDARD_GRAVITY_M_S2 = 9.80665;

const aliases = {
  latitude: ['latitude', 'lat', 'gps latitude', 'latitud'],
  longitude: ['longitude', 'long', 'lng', 'lon', 'gps longitude', 'longitud'],
  pressure: ['pressure', 'tekanan', 'pressure value', 'pressure bar', 'pressure kpa', 'pressure psi'],
  pressureUnit: ['pressure unit', 'unit pressure', 'unit tekanan', 'pressure_unit'],
  pressureType: ['pressure type', 'jenis tekanan', 'pressure_type'],
  timestamp: ['timestamp', 'datetime', 'date time', 'masa bacaan', 'tarikh masa'],
  date: ['date', 'tarikh', 'measurement date'],
  time: ['time', 'masa', 'measurement time'],
  timezone: ['timezone', 'time zone', 'zon masa'],
  sensorId: ['sensor id', 'sensor_id', 'id sensor', 'tag sensor'],
  siteName: ['site name', 'lokasi', 'nama lokasi'],
  pipeId: ['pipe id', 'pipe_id', 'id paip', 'asset id'],
  dma: ['dma', 'district metered area', 'zon'],
  elevationM: ['elevation', 'elevation m', 'elevasi', 'aras m'],
  flow: ['flow', 'aliran', 'flow reading'],
  flowUnit: ['flow unit', 'unit flow', 'unit aliran'],
  notes: ['notes', 'nota', 'catatan']
};
export const FIELD_NAMES = Object.keys(aliases);
const normalizedHeader = value => String(value ?? '').toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const finite = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));

export function detectFieldColumns(headers) {
  const names = headers.map(String), mapping = {}, ambiguous = [];
  for (const [field, options] of Object.entries(aliases)) {
    const matches = names.filter(name => options.includes(normalizedHeader(name)));
    if (matches.length === 1) mapping[field] = matches[0];
    if (matches.length > 1) ambiguous.push(field);
  }
  return { mapping, ambiguous };
}

export function inferPressureUnitFromHeader(header) {
  const value=normalizedHeader(header);
  return { 'pressure bar':'bar', 'pressure kpa':'kPa', 'pressure psi':'psi' }[value]||null;
}

export function parseFieldCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); if (row.some(value => String(value).trim())) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV mempunyai tanda petik yang tidak ditutup.');
  row.push(cell); if (row.some(value => String(value).trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV mesti ada tajuk kolum dan sekurang-kurangnya satu bacaan.');
  const headers = rows.shift().map(value => String(value).trim());
  if (!headers.every(Boolean) || new Set(headers).size !== headers.length) throw new Error('Tajuk kolum CSV kosong atau pendua.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Baris ${index + 2}: bilangan kolum CSV tidak sepadan.`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

export function pressureToKpa(value, unit) {
  const n = Number(value);
  if (!finite(value) || n < 0) throw new Error('Tekanan mesti nombor bukan negatif.');
  const key = normalizedHeader(unit).replaceAll(' ', '');
  const factor = { bar: 100, kpa: 1, psi: 6.894757293168, m: WATER_DENSITY_KG_M3 * STANDARD_GRAVITY_M_S2 / 1000,
    mh2o: WATER_DENSITY_KG_M3 * STANDARD_GRAVITY_M_S2 / 1000 }[key];
  if (!factor) throw new Error('Unit tekanan tidak dikenali; pilih bar, kPa, psi atau mH2O.');
  return n * factor;
}

export function flowToM3s(value, unit) {
  const n = Number(value);
  if (!finite(value) || n < 0) throw new Error('Aliran mesti nombor bukan negatif.');
  const factor = { 'm3/h': 1 / 3600, 'm3/day': 1 / 86400, 'l/s': 0.001, mld: 1000 / 86400 }[normalizedHeader(unit).replaceAll(' ', '')];
  if (!factor) throw new Error('Unit aliran tidak dikenali; pilih m3/h, m3/day, L/s atau MLD.');
  return n * factor;
}

export function distanceToM(value, unit) {
  const n = Number(value);
  if (!finite(value) || n < 0) throw new Error('Jarak mesti nombor bukan negatif.');
  const factor = { m: 1, km: 1000 }[normalizedHeader(unit)];
  if (!factor) throw new Error('Unit jarak tidak dikenali; pilih m atau km.');
  return n * factor;
}

export function extractBasicInputsFromCommand(command) {
  const text=String(command||'');
  const diameter=text.match(/(\d+(?:\.\d+)?)\s*mm\b/i);
  const flow=text.match(/(?:flow|aliran)\s*(\d+(?:\.\d+)?)\s*(m3\/h|m³\/h|m3\/day|m³\/day|l\/s|mld)\b/i);
  const pressure=text.match(/(?:(?:average|purata)\s+)?(?:pressure|tekanan)\s*(?:(?:purata|average)\s*)?(\d+(?:\.\d+)?)\s*(bar|kpa|psi|mh2o)\b/i);
  const asset=text.match(/\d+(?:\.\d+)?\s*mm\s+([^,.;]+)/i);
  const flowUnit=flow?.[2]?.toLowerCase().replace('m³','m3');
  const pressureUnit=pressure?.[2]?.toLowerCase();
  return {
    diameterMm:diameter?Number(diameter[1]):null,
    assetQuery:asset?asset[1].trim().slice(0,100):null,
    flow:flow?Number(flow[1]):null,
    flowUnit:flowUnit==='l/s'?'L/s':flowUnit==='mld'?'MLD':flowUnit||null,
    pressure:pressure?Number(pressure[1]):null,
    pressureUnit:pressureUnit==='kpa'?'kPa':pressureUnit==='mh2o'?'mH2O':pressureUnit||null
  };
}

function parseTimestamp(row, defaults) {
  const supplied = String(row.timestamp ?? '').trim();
  const date = String(row.date ?? '').trim(), time = String(row.time ?? '').trim();
  if (!supplied && !date && !time) return { timestamp: null, timezone: null, timeStatus: 'UNTIMED' };
  let value = supplied;
  if (!value) {
    if (!date || !time) throw new Error('Tarikh dan masa perlu lengkap, atau kosongkan kedua-duanya.');
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date :
      /^\d{2}\/\d{2}\/\d{4}$/.test(date) ? `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}` : null;
    if (!isoDate || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) throw new Error('Tarikh/masa tidak sah; guna YYYY-MM-DD dan HH:mm.');
    const zone = String(row.timezone || defaults.timezone || '').trim();
    if (zone !== 'Asia/Kuala_Lumpur' && zone !== '+08:00') throw new Error('Sahkan zon masa Malaysia (+08:00) atau beri timestamp dengan offset.');
    value = `${isoDate}T${time.length === 5 ? `${time}:00` : time}+08:00`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    throw new Error('Timestamp mesti ISO 8601 dengan offset zon masa.');
  const [year,month,day]=value.slice(0,10).split('-').map(Number);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()+1!==month||calendar.getUTCDate()!==day)
    throw new Error('Tarikh kalendar tidak sah.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10) && /(?:Z|\+00:00)$/.test(value))
    throw new Error('Timestamp tidak sah.');
  return { timestamp: parsed.toISOString(), timezone: String(row.timezone || defaults.timezone || 'offset dalam timestamp'), timeStatus: 'TIMED' };
}

export function normalizeFieldObservation(raw, defaults = {}) {
  const lat = Number(raw.latitude), lng = Number(raw.longitude);
  if (!finite(raw.latitude) || lat < -90 || lat > 90 || !finite(raw.longitude) || lng < -180 || lng > 180)
    throw new Error('Latitude/longitude WGS84 tidak sah.');
  const pressureType = String(raw.pressureType || defaults.pressureType || '').trim().toUpperCase();
  if (!['GAUGE', 'ABSOLUTE', 'PRESSURE_HEAD', 'HYDRAULIC_HEAD'].includes(pressureType))
    throw new Error('Pilih jenis tekanan: gauge, absolute, pressure head atau hydraulic head.');
  const pressureUnit = String(raw.pressureUnit || defaults.pressureUnit || '').trim();
  if (!pressureUnit) throw new Error('Unit tekanan wajib; jangan teka unit.');
  if (['PRESSURE_HEAD','HYDRAULIC_HEAD'].includes(pressureType) &&
      !['m', 'mh2o'].includes(normalizedHeader(pressureUnit).replaceAll(' ', '')))
    throw new Error('Pressure/hydraulic head mesti dalam meter; ia bukan tekanan gauge.');
  const kpa = pressureToKpa(raw.pressure, pressureUnit);
  const flowPresent = raw.flow !== '' && raw.flow !== null && raw.flow !== undefined;
  const flowUnit = String(raw.flowUnit || defaults.flowUnit || '').trim();
  if (flowPresent && !flowUnit) throw new Error('Unit aliran wajib apabila nilai aliran diberi.');
  const time = parseTimestamp(raw, defaults);
  const elevation = raw.elevationM === '' || raw.elevationM == null ? null : Number(raw.elevationM);
  if (elevation !== null && !Number.isFinite(elevation)) throw new Error('Elevasi mesti nombor sah.');
  return {
    latitude: lat, longitude: lng, sourceCrs: 'EPSG:4326',
    originalPressure: Number(raw.pressure), originalPressureUnit: pressureUnit, pressureType,
    normalizedPressureKpa: pressureType === 'HYDRAULIC_HEAD' ? null : kpa,
    hydraulicHeadM: pressureType === 'HYDRAULIC_HEAD' ? Number(raw.pressure) : null,
    originalFlow: flowPresent ? Number(raw.flow) : null, originalFlowUnit: flowPresent ? flowUnit : null,
    normalizedFlowM3s: flowPresent ? flowToM3s(raw.flow, flowUnit) : null,
    elevationM: elevation, ...time,
    sensorId: String(raw.sensorId || '').trim().slice(0, 100) || null,
    siteName: String(raw.siteName || '').trim().slice(0, 160) || null,
    pipeIdHint: String(raw.pipeId || '').trim().slice(0, 100) || null,
    dmaHint: String(raw.dma || '').trim().slice(0, 180) || null,
    notes: String(raw.notes || '').trim().slice(0, 500) || null,
    qualityStatus: 'PENDING_REVIEW', matchStatus: 'UNMATCHED'
  };
}

export function mapFieldRows(rows, mapping, defaults = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_FIELD_ROWS) throw new Error(`Had ${MAX_FIELD_ROWS} bacaan bagi setiap fail.`);
  for (const required of ['latitude', 'longitude', 'pressure']) if (!mapping[required]) throw new Error(`Pemetaan kolum ${required} wajib.`);
  const observations = [], issues = [];
  rows.forEach((row, index) => {
    try {
      const raw = Object.fromEntries(FIELD_NAMES.map(field => [field, mapping[field] ? row[mapping[field]] : undefined]));
      observations.push(normalizeFieldObservation(raw, defaults));
    } catch (error) { issues.push({ row: index + 1, message: error.message }); }
  });
  return { observations, issues };
}

export function calculateBasicHydraulics({ diameterMm, flow, flowUnit, pressure, pressureUnit, pressureType = 'GAUGE', internalDiameterVerified = false }) {
  const diameter = Number(diameterMm);
  if (!finite(diameterMm) || diameter <= 0 || diameter > 10000) throw new Error('Diameter paip mesti positif dan dalam mm.');
  const flowM3s = flowToM3s(flow, flowUnit);
  const areaM2 = Math.PI * (diameter / 1000) ** 2 / 4;
  const type = String(pressureType).toUpperCase();
  if (type !== 'GAUGE') throw new Error('Tekanan untuk pressure head asas mesti tekanan gauge; jangan masukkan absolute/hydraulic head.');
  const pressureKpa = pressureToKpa(pressure, pressureUnit);
  return { flowM3s, flowLs: flowM3s * 1000, flowMld: flowM3s * 86.4,
    areaM2, velocityMs: flowM3s / areaM2, pressureKpa,
    pressureHeadM: pressureKpa * 1000 / (WATER_DENSITY_KG_M3 * STANDARD_GRAVITY_M_S2),
    diameterBasis: internalDiameterVerified ? 'INTERNAL_VERIFIED' : 'NOMINAL_ASSUMED_INTERNAL',
    densityKgM3: WATER_DENSITY_KG_M3, gravityMs2: STANDARD_GRAVITY_M_S2,
    limitation: 'Bukan simulasi rangkaian, reserve margin, kalibrasi atau bukti kebocoran.' };
}
