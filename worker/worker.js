import { handlePhase2aAction } from './phase2a.js';
import { handlePhase2bAction } from './phase2b.js';
import { handleStagingHydraulicAction, stagingEnabled } from './hydraulic-staging.js';

const rateLimitMap = new Map();

// Analisis ini sengaja dijalankan pada Worker, bukan diserahkan sepenuhnya kepada
// model bahasa. Ini memastikan angka ramalan sentiasa boleh dikesan kepada rekod
// aduan yang dibekalkan oleh dashboard, termasuk jika respons Gemini tergendala.
function getRecordValue(record, names) {
  const keys = Object.keys(record || {});
  for (const name of names) {
    const wanted = name.toUpperCase().replace(/\s+/g, ' ').trim();
    const key = keys.find(k => String(k).toUpperCase().replace(/\s+/g, ' ').trim() === wanted);
    if (key && record[key] !== undefined && record[key] !== null) return String(record[key]).trim();
  }
  return '';
}

function parseIncidentDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (match) {
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const date = new Date(year, Number(match[2]) - 1, Number(match[1]));
    return isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(text);
  return isNaN(date.getTime()) ? null : date;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function labelMonth(date) {
  return new Intl.DateTimeFormat('ms-MY', { month: 'short', year: 'numeric' }).format(date);
}

function parseSelectedMonth(value) {
  const months = { jan: 0, feb: 1, mac: 2, mar: 2, apr: 3, mei: 4, may: 4, jun: 5, jul: 6, ogo: 7, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, dis: 11, dec: 11 };
  const match = String(value || '').trim().match(/^([A-Za-z]{3})[-\s]?(\d{2,4})$/);
  if (!match || months[match[1].toLowerCase()] === undefined) return null;
  const year = Number(match[2].length === 2 ? `20${match[2]}` : match[2]);
  return new Date(year, months[match[1].toLowerCase()], 1);
}

function normaliseText(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function classifyIntent(prompt) {
  const text = normaliseText(prompt);
  if (/KONTRAKTOR|DILAKSANAKAN OLEH/.test(text)) return 'contractor';
  if (/SIVIL|TURAP|CIVIL/.test(text)) return 'civil';
  if (/TUKAR|GANTI|REPLACEMENT|ASSET/.test(text)) return 'replacement';
  if (/ALD|ACTIVE LEAKAGE/.test(text)) return 'ald';
  if (/HOTSPOT|LOKASI/.test(text)) return 'hotspot';
  if (/BULANAN|MONTHLY/.test(text)) return 'monthly';
  if (/RAMAL|FORECAST|UNJUR/.test(text)) return 'forecast';
  return 'overview';
}

function countBy(items, getKey) {
  const result = new Map();
  items.forEach(item => {
    const key = getKey(item) || 'Tidak dinyatakan';
    result.set(key, (result.get(key) || 0) + 1);
  });
  return [...result.entries()].sort((a, b) => b[1] - a[1]);
}

function parseCoordinate(record) {
  const pair = getRecordValue(record, ['KORDINAT', 'Kordinat', 'KOORDINAT']).split(',').map(value => Number(value.trim()));
  return pair.length === 2 && Math.abs(pair[0]) <= 90 && Math.abs(pair[1]) <= 180 ? { lat: pair[0], lng: pair[1] } : null;
}

function safeNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null; const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normaliseDmaName(value) {
  return normaliseText(value).replace(/\bDMA\b/g, '').trim();
}

// Skor ini ialah triage operasi, bukan pengesahan kebocoran. Ia memerlukan ALD
// di tapak sebelum kerja pembaikan diputuskan.
function buildLeakRiskProfile(telemetryRows = [], aldRows = [], params = {}, selectedDma = '') {
  const individualRows = telemetryRows.map(row => ({
    recordedAt: row.recorded_at || row.recordedAt,
    flow: safeNumber(row.flow_m3h),
    inlet: safeNumber(row.pressure_inlet_bar),
    cp: safeNumber(row.pressure_cp_bar),
    legitimate: safeNumber(row.legitimate_night_use_m3h)
  })).filter(row => row.recordedAt);
  const readingsByTime = new Map();
  for (const reading of individualRows) {
    const group = readingsByTime.get(reading.recordedAt) || { recordedAt: reading.recordedAt, flow: null, inlet: null, cp: null, legitimate: null };
    for (const field of ['flow', 'inlet', 'cp', 'legitimate']) {
      if (reading[field] !== null) group[field] = reading[field];
    }
    readingsByTime.set(reading.recordedAt, group);
  }
  const rows = [...readingsByTime.values()].sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  const latest = rows[rows.length - 1];
  // Phase 2A stores one parameter per observation. Assemble the latest
  // measured value of each parameter instead of treating the newest single
  // row as a complete four-parameter reading.
  const latestValue = field => [...rows].reverse().find(row => row[field] !== null)?.[field] ?? null;
  const manualFlow = safeNumber(params.avgMnf) ?? safeNumber(params.avgFlow);
  const manualInlet = safeNumber(params.pressureInlet);
  const manualCp = safeNumber(params.pressureCp);
  const manualLegitimate = safeNumber(params.legitimateNightUse);
  const current = {
    recordedAt: latest?.recordedAt || null,
    flow: latestValue('flow') ?? manualFlow,
    inlet: latestValue('inlet') ?? manualInlet,
    cp: latestValue('cp') ?? manualCp,
    legitimate: latestValue('legitimate') ?? manualLegitimate
  };
  const flow = current.flow;
  const inlet = current.inlet;
  const cp = current.cp;
  const deltaPressure = inlet !== null && cp !== null ? Math.max(0, inlet - cp) : null;
  const historicalDelta = rows.slice(0, -1).map(row => row.inlet !== null && row.cp !== null ? Math.max(0, row.inlet - row.cp) : null).filter(value => value !== null);
  const baselineDelta = median(historicalDelta);
  const historicalFlow = rows.slice(Math.max(0, rows.length - 8), -1).map(row => row.flow).filter(value => value !== null);
  const baselineFlow = median(historicalFlow);
  const legitimate = current.legitimate !== null ? current.legitimate : (flow !== null ? Math.round(flow * 0.15 * 100) / 100 : null);
  const usesIwaFallback = current.legitimate === null && flow !== null;
  const excessNightFlow = flow !== null && legitimate !== null ? Math.max(0, flow - legitimate) : null;

  let score = 0;
  if (flow !== null && legitimate !== null && excessNightFlow !== null) {
    score += Math.min(35, Math.round((excessNightFlow / Math.max(legitimate, 1)) * 12));
  }
  if (deltaPressure !== null && baselineDelta !== null && deltaPressure > baselineDelta) {
    score += Math.min(25, Math.round(((deltaPressure - baselineDelta) / Math.max(baselineDelta, 0.2)) * 18));
  }
  if (cp !== null && cp < 1.0) score += 15;
  if (flow !== null && baselineFlow !== null && flow > baselineFlow) {
    score += Math.min(20, Math.round(((flow - baselineFlow) / Math.max(baselineFlow, 1)) * 15));
  }
  const latestAld = aldRows.sort((a, b) => String(b.inspected_at || '').localeCompare(String(a.inspected_at || '')))[0];
  if (latestAld?.result_status === 'CONFIRMED_LEAK') score += 10;
  if (latestAld?.result_status === 'NO_LEAK') score -= 10;
  score = Math.max(0, Math.min(100, score));
  const status = score >= 65 ? 'HIGH_RISK' : (score >= 35 ? 'ALD_REQUIRED' : 'NORMAL');
  const label = status === 'HIGH_RISK' ? 'Disyaki kebocoran tinggi' : (status === 'ALD_REQUIRED' ? 'Perlu ALD' : 'Corak normal');
  const color = status === 'HIGH_RISK' ? '#dc2626' : (status === 'ALD_REQUIRED' ? '#f97316' : '#16a34a');
  const hasMeasurements = flow !== null || inlet !== null || cp !== null;
  return {
    available: hasMeasurements,
    dma: selectedDma,
    score,
    status,
    label,
    color,
    telemetryCount: rows.length,
    latestAt: current.recordedAt,
    flow,
    inlet,
    cp,
    deltaPressure,
    baselineDelta,
    baselineFlow,
    legitimate,
    usesIwaFallback,
    excessNightFlow,
    latestAld
  };
}

function buildOperationalAnalysis(records, params, prompt, assetProfile = {}, monitoringProfile = {}) {
  const intent = classifyIntent(prompt);
  const selectedDma = String(params?.dma || '').trim();
  const scopeLabel = selectedDma && selectedDma.toLowerCase() !== 'semua' ? selectedDma : 'Semua DMA';
  const selectedTokens = normaliseText(selectedDma).split(' ').filter(token => token.length >= 4 && !/^\d+MM$/.test(token));
  const allIncidents = (Array.isArray(records) ? records : []).map(record => ({
    record,
    category: getRecordValue(record, ['KATEGORI', 'Kategori', 'kategori']),
    districtMeteredArea: getRecordValue(record, ['District Metered Area', 'DISTRICT METERED AREA']),
    dma: getRecordValue(record, ['DMA']),
    location: getRecordValue(record, ['LOKASI / TEMPAT', 'LOKASI', 'Lokasi / Tempat', 'Lokasi']),
    pipeType: getRecordValue(record, ['JENIS PAIP', 'Jenis Paip', 'JENIS PAIP BARU', 'Jenis Paip Baru']) || 'Tidak dinyatakan',
    pipeSize: getRecordValue(record, ['SAIZ PAIP', 'Saiz Paip', 'SAIZ', 'Saiz']) || 'Tidak dinyatakan',
    contractor: getRecordValue(record, ['DILAKSANAKAN OLEH', 'Dilaksanakan Oleh']) || 'Tidak dinyatakan',
    civil: getRecordValue(record, ['SIVIL WORKS', 'Sivil Works']) || 'Tidak dinyatakan',
    date: parseIncidentDate(getRecordValue(record, ['TARIKH & MASA TERIMA ADUAN', 'TARIKH & MASA TERIMA  ADUAN', 'TARIKH TERIMA', 'Tarikh Terima'])),
    coordinate: parseCoordinate(record)
  })).filter(item => /PECAH|BOCOR/i.test(item.category));

  const scopedIncidents = !selectedDma || selectedDma.toLowerCase() === 'semua' ? allIncidents : allIncidents.filter(item => {
    // DMA dan District Metered Area ialah dua medan berbeza. Jangan guna lokasi
    // untuk padanan skop kerana perkataan seperti "Bukit" boleh beri positif palsu.
    const scopeText = normaliseText(`${item.districtMeteredArea} ${item.dma}`);
    // Bukit Kuau Lama dan Baru ialah DMA berlainan. Dua token bersama tidak
    // cukup untuk membezakan kedua-duanya.
    if (/\bBUKIT KUAU (LAMA|BARU)\b/.test(normaliseText(selectedDma))) {
      return scopeText.includes(normaliseText(selectedDma));
    }
    const matchingTokens = selectedTokens.filter(token => scopeText.includes(token)).length;
    return scopeText.includes(normaliseText(selectedDma)) || matchingTokens >= Math.min(2, selectedTokens.length);
  });
  // Jangan mendakwa tiada data hanya kerana nama DMA pada kawalan UI dan sheet tidak sama.
  const usedFallbackScope = Boolean(selectedDma) && !/\bBUKIT KUAU (LAMA|BARU)\b/.test(normaliseText(selectedDma)) && scopedIncidents.length === 0 && allIncidents.length > 0;
  const incidents = usedFallbackScope ? allIncidents : scopedIncidents;
  const targetMonth = parseSelectedMonth(params?.bulan);
  const dated = incidents.filter(item => item.date);
  const latestDate = dated.length ? new Date(Math.max(...dated.map(item => item.date.getTime()))) : null;
  let forecastStart = targetMonth || (latestDate ? new Date(latestDate.getFullYear(), latestDate.getMonth() + 1, 1) : new Date());
  let historical = dated.filter(item => item.date < forecastStart);
  // Contohnya UI mungkin masih memilih May-26 sedangkan rekod semasa bermula
  // pada Sep-26. Dalam keadaan itu gunakan data terkini, bukan ramalan sifar.
  const usedLatestPeriod = historical.length === 0 && dated.length > 0;
  if (usedLatestPeriod && latestDate) {
    forecastStart = new Date(latestDate.getFullYear(), latestDate.getMonth() + 1, 1);
    historical = dated;
  }
  const monthlyBuckets = new Map();
  historical.forEach(item => monthlyBuckets.set(monthKey(item.date), (monthlyBuckets.get(monthKey(item.date)) || 0) + 1));
  const months = [...monthlyBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-3);
  const counts = months.map(([, count]) => count);
  const weightedForecast = counts.length ? counts.reduce((sum, count, index) => sum + count * (index + 1), 0) / counts.reduce((sum, _, index) => sum + index + 1, 0) : 0;
  const forecast = Math.max(0, Math.round(weightedForecast));
  const latest = counts[counts.length - 1] || 0;
  const earlier = counts.length > 1 ? counts.slice(0, -1).reduce((sum, count) => sum + count, 0) / (counts.length - 1) : latest;
  const trendPct = earlier > 0 ? Math.round(((latest - earlier) / earlier) * 100) : (latest ? 100 : 0);
  const range = counts.length > 1 ? `${Math.max(0, Math.floor(weightedForecast - Math.sqrt(Math.max(...counts))))}–${Math.ceil(weightedForecast + Math.sqrt(Math.max(...counts)))}` : `${Math.max(0, forecast - 1)}–${forecast + 1}`;
  const hotspots = countBy(historical.length ? historical : incidents, item => item.location).slice(0, 5);
  const pipeProfiles = countBy(incidents, item => `${item.pipeType} • ${item.pipeSize}`).slice(0, 3);
  const contractors = countBy(incidents, item => item.contractor).slice(0, 3);
  const civilWorks = countBy(incidents, item => item.civil).slice(0, 3);
  const assetGroups = assetProfile.groups || [];
  const confidence = historical.length >= 12 && months.length >= 3 ? 'HIGH' : (historical.length >= 5 && months.length >= 2 ? 'MEDIUM' : 'LOW');
  const trendText = trendPct > 0 ? `menaik ${trendPct}%` : (trendPct < 0 ? `menurun ${Math.abs(trendPct)}%` : 'mendatar');
  const topHotspot = hotspots[0]?.[0] || 'lokasi belum lengkap';
  const topProfile = pipeProfiles[0]?.[0] || 'jenis/saiz belum direkodkan';
  const isHighRisk = forecast >= 3 || trendPct >= 25 || (hotspots[0]?.[1] || 0) >= 3;
  const periodLabel = labelMonth(forecastStart);
  const risk = monitoringProfile;
  let answer = `Analisis ${scopeLabel}: ${incidents.length} kes paip pecah/bocor telah dibandingkan dengan profil aset D1. Risiko utama tertumpu pada ${topHotspot}; profil paip yang paling kerap dilaporkan ialah ${topProfile}.`;
  let action = 'Pantau hotspot dalam rondaan operasi mingguan';
  let reason = `Tumpukan pemeriksaan pada ${topHotspot} dan semak keadaan ${topProfile}.`;

  if (intent === 'forecast') {
    answer = `Unjuran ${periodLabel} bagi ${scopeLabel} ialah sekitar ${forecast} kes paip pecah/bocor dalam 30 hari (julat indikatif ${range} kes). Trend terkini ${trendText}; lokasi risiko utama ialah ${topHotspot} dengan profil ${topProfile}.`;
    action = isHighRisk ? 'Jadualkan ALD dan pemeriksaan tapak dalam 7 hari' : action;
  } else if (intent === 'hotspot') {
    answer = `Hotspot utama ${scopeLabel} ialah ${hotspots.slice(0, 3).map(([name, count]) => `${name} (${count} kes)`).join(', ') || 'belum dapat dikenal pasti'}. Penanda merah pada peta menunjukkan lokasi yang mempunyai koordinat sah.`;
    action = 'Sahkan jajaran paip berhampiran hotspot dan buat pengesanan kebocoran';
  } else if (intent === 'replacement') {
    answer = `Keutamaan calon tukar paip ialah ${topHotspot} kerana rekod insiden berulang pada profil ${topProfile}. Profil aset D1 yang tersedia digunakan sebagai rujukan material, saiz dan panjang jajaran sebelum kerja reka bentuk dibuat.`;
    action = 'Buat siasatan tapak dan sediakan skop penggantian paip';
  } else if (intent === 'ald') {
    answer = `Cadangan ALD: mulakan di ${topHotspot}, kemudian ${hotspots[1]?.[0] || 'hotspot berikutnya'}. Susunan ini berdasarkan kekerapan kes pecah/bocor, bukan andaian semata-mata.`;
    action = 'Laksanakan ALD mengikut turutan hotspot dalam 7 hari';
  } else if (intent === 'contractor') {
    answer = `Beban kerja pembaikan bagi ${scopeLabel} paling banyak direkodkan oleh ${contractors.slice(0, 3).map(([name, count]) => `${name} (${count} kes)`).join(', ') || 'tiada kontraktor direkodkan'}.`;
    action = 'Semak prestasi masa tutup dan kualiti pembaikan kontraktor teratas';
  } else if (intent === 'civil') {
    answer = `Status kerja sivil bagi kes paip pecah/bocor: ${civilWorks.slice(0, 3).map(([name, count]) => `${name} (${count} kes)`).join(', ') || 'tiada status direkodkan'}.`;
    action = 'Sahkan status turap/simen bagi kes yang masih tidak lengkap';
  } else if (intent === 'monthly') {
    answer = `Ringkasan bulanan ${scopeLabel}: ${months.map(([key, count]) => `${labelMonth(new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1))} (${count} kes)`).join(', ') || 'tarikh belum mencukupi'}. Profil paling kerap: ${topProfile}.`;
  }

  if (risk.available) {
    const pressureText = risk.deltaPressure !== null ? `ΔP ${risk.deltaPressure.toFixed(2)} bar` : 'ΔP belum lengkap';
    answer += ` Pemantauan DMA semasa menunjukkan skor risiko ${risk.score}/100 (${risk.label}); ${pressureText}${risk.flow !== null ? `, aliran malam ${risk.flow.toFixed(2)} m³/h` : ''}. Status ini ialah keutamaan siasatan, bukan pengesahan kebocoran.`;
    if (risk.status === 'HIGH_RISK') {
      action = 'Jadualkan ALD dan semakan tekanan di zon ini dalam 24–48 jam';
      reason = `Skor ${risk.score}/100 dipacu oleh aliran/tekanan semasa. Sahkan lokasi melalui ALD sebelum pembaikan.`;
    } else if (risk.status === 'ALD_REQUIRED') {
      action = 'Jadualkan ALD pada zon oren dalam 7 hari';
      reason = `Skor ${risk.score}/100 memerlukan semakan lapangan dan bacaan semula mengikut masa.`;
    }
  }

  const markers = hotspots.map(([location, count]) => {
    const match = incidents.find(item => item.location === location && item.coordinate);
    return match ? { lat: match.coordinate.lat, lng: match.coordinate.lng, title: `RISIKO: ${location}`, summary: `${count} kes • ${match.pipeType} ${match.pipeSize}`, severity: count } : null;
  }).filter(Boolean);
  const findings = [
    `${incidents.length} kes paip pecah/bocor digunakan daripada Pengurusan Data${usedFallbackScope ? '; padanan DMA khusus tidak ditemui, jadi analisis merentas semua DMA digunakan' : ''}${usedLatestPeriod ? '; bulan rujukan yang dipilih tidak mempunyai sejarah, jadi rekod terkini digunakan' : ''}.`,
    `Profil insiden utama: ${pipeProfiles.map(([name, count]) => `${name} (${count} kes)`).join(', ') || 'jenis dan saiz paip belum lengkap'}.`,
    `Hotspot: ${hotspots.slice(0, 3).map(([name, count]) => `${name} (${count} kes)`).join(', ') || 'lokasi belum lengkap'}.`
  ];
  if (assetProfile.available) findings.push(`D1 Master (${assetProfile.sourceScope || 'semua source_file'}): ${assetProfile.assetCount} aset / jumlah panjang ${assetProfile.totalLength} (unit sumber D1) dirujuk; kumpulan dominan ${assetGroups.slice(0, 2).map(group => `${group.material || 'Tidak dinyatakan'} ${group.size || ''} (${group.total_length})`).join(', ')}.`);
  if (risk.available) {
    findings.push(`Pemantauan tekanan DMA: skor heuristik ${risk.score}/100 (${risk.label}), ${risk.telemetryCount} masa bacaan, ${risk.deltaPressure !== null ? `ΔP ${risk.deltaPressure.toFixed(2)} bar` : 'ΔP belum lengkap'}${risk.usesIwaFallback ? '; penggunaan sah malam ESTIMATED menggunakan andaian 15% daripada aliran, bukan bacaan SCADA/manual' : ''}.`);
  } else if (selectedDma) {
    findings.push('Tiada bacaan flow/tekanan DMA tersimpan lagi. Tambah bacaan manual atau import CSV sebelum zon risiko diwarnakan.');
  }

  return {
    status: 'success', intent,
    answer,
    confidence: { level: confidence, reason: `${historical.length} kes bertarikh, ${months.length} bulan rujukan${assetProfile.available ? ' dan profil aset D1' : ''} digunakan.` },
    metrics: [
      { label: intent === 'forecast' ? 'Unjuran 30 hari' : 'Kes paip pecah/bocor', value: intent === 'forecast' ? forecast : incidents.length, unit: 'kes' },
      { label: 'Hotspot utama', value: hotspots[0]?.[1] || 0, unit: 'kes' },
      { label: 'Aset D1 dirujuk', value: assetProfile.available ? assetProfile.assetCount : 'N/A', unit: assetProfile.available ? 'aset' : '' },
      { label: 'Panjang aset D1', value: assetProfile.available ? assetProfile.totalLength : 'N/A', unit: assetProfile.available ? 'unit D1' : '' },
      ...(risk.available ? [{ label: 'Skor Risiko DMA', value: risk.score, unit: '/ 100' }, { label: 'Status Zon', value: risk.label, unit: '' }] : [])
    ],
    findings,
    calculations: [
      ...(intent === 'forecast' ? [{ name: 'Ramalan purata berwajaran 3 bulan', formula: 'Bulan paling baharu menerima wajaran tertinggi.', result: forecast, unit: 'kes / 30 hari' }] : []),
      ...(risk.available ? [{ name: 'Skor risiko kebocoran DMA', formula: 'Gabungan aliran malam melebihi penggunaan sah, perubahan ΔP, tekanan CP rendah, trend aliran dan keputusan ALD. Skor ini untuk triage, bukan pengesahan kebocoran.', result: `${risk.score}/100 — ${risk.label}`, unit: risk.usesIwaFallback ? 'Penggunaan sah: anggaran awal 15% aliran' : 'Penggunaan sah: nilai DMA' }] : [])
    ],
    recommendations: [
      { priority: isHighRisk ? 'HIGH' : 'MEDIUM', action, reason },
      { priority: 'MEDIUM', action: 'Lengkapkan koordinat, jenis dan saiz paip pada rekod baharu', reason: 'Rekod lengkap membolehkan AI memadankan insiden dengan aset dan memetakan risiko dengan lebih tepat.' }
    ],
    evidence: [
      { source: 'Pengurusan Data', description: `Semua rekod kategori paip pecah/bocor${usedFallbackScope ? ' digunakan sebagai fallback kerana nama DMA tidak sepadan secara langsung' : ` dalam skop ${scopeLabel} digunakan`}.`, record_count: incidents.length },
      ...(assetProfile.available ? [{ source: 'D1 water_assets', description: `Profil material, saiz dan panjang aset daripada ${assetProfile.sourceScope || 'D1 Master'}.`, record_count: assetProfile.assetCount }] : []),
      ...(risk.available ? [{ source: 'D1 dma_telemetry', description: `Bacaan flow dan tekanan untuk ${scopeLabel}${risk.latestAt ? `, bacaan terkini ${risk.latestAt}` : ''}.`, record_count: risk.telemetryCount }] : [])
    ],
    map: { enabled: markers.length > 0 || risk.available, markers, risk_zones: risk.available ? [{ dma: risk.dma || scopeLabel, score: risk.score, status: risk.status, label: risk.label, color: risk.color }] : [] }
  };
}

function checkRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return true;
  }
  let record = rateLimitMap.get(ip);
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + windowMs;
    return true;
  }
  if (record.count >= limit) {
    return false;
  }
  record.count++;
  return true;
}

function telemetryValue(row, names) {
  return getRecordValue(row, names);
}

function normaliseTelemetryRow(row, defaultTimestamp, source) {
  const recordedAt = telemetryValue(row, ['recorded_at', 'timestamp', 'tarikh masa', 'datetime', 'masa bacaan']) || defaultTimestamp;
  if (!recordedAt || Number.isNaN(new Date(recordedAt).getTime())) return null;
  const flow = safeNumber(telemetryValue(row, ['flow_m3h', 'flow', 'aliran', 'mnf', 'avg mnf']));
  const inlet = safeNumber(telemetryValue(row, ['pressure_inlet_bar', 'tekanan inlet', 'inlet pressure', 'pressure inlet']));
  const cp = safeNumber(telemetryValue(row, ['pressure_cp_bar', 'tekanan cp', 'cp pressure', 'pressure critical point']));
  const legitimate = safeNumber(telemetryValue(row, ['legitimate_night_use_m3h', 'penggunaan sah malam', 'legitimate night use', 'lnu']));
  if ([flow, inlet, cp, legitimate].every(value => value === null)) return null;
  return {
    recordedAt: new Date(recordedAt).toISOString(), flow, inlet, cp, legitimate,
    source: String(telemetryValue(row, ['source', 'sumber']) || source || 'csv_upload').slice(0, 80)
  };
}

async function runD1Batch(db, statements, chunkSize = 100) {
  for (let index = 0; index < statements.length; index += chunkSize) {
    await db.batch(statements.slice(index, index + chunkSize));
  }
}

async function logAiHistory(db, { dma, sessionId, agentType, role, content, params }) {
  if (!db) return false;
  try {
    await db.prepare(`INSERT INTO ai_chat_history
      (district_metered_area, session_id, agent_type, role, content, params_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(dma || 'Semua DMA', String(sessionId || 'unknown').slice(0, 120), String(agentType || 'nrw_agent').slice(0, 80), role, String(content || '').slice(0, 12000), JSON.stringify(params || {}).slice(0, 12000)).run();
    return true;
  } catch (_) {
    // Migration D1 mungkin belum dijalankan; analisis tidak boleh gagal hanya kerana log.
    return false;
  }
}

// Place these helpers above `export default` in the Cloudflare Worker.
// Call `handlePipeNetworkRequest` AFTER JWT verification and BEFORE generic GET.
// D1 geometry is never served through GitHub Pages or a public unauthenticated URL.

async function handlePipeNetworkRequest(request, env, decodedUser, securityHeaders) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/pipe-lines' && url.pathname !== '/api/pipe-summary') return null;
  const headers = { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method !== 'GET') return reply({ status: 'error', message: 'Method not allowed' }, 405);
  if (decodedUser?.level !== 'ADMIN') return reply({ status: 'error', message: 'Admin sahaja' }, 403);
  if (!env.DB) return reply({ status: 'error', message: 'D1 binding tiada' }, 503);

  try {
    const active = await env.DB.prepare('SELECT import_id FROM pipe_network_active WHERE singleton = 1').first();
    if (!active?.import_id) return reply({ status: 'error', message: 'Jajaran paip belum diaktifkan' }, 503);
    const importId = active.import_id;
    const zone = (url.searchParams.get('zone') || '').trim();
    if (zone.length > 180) return reply({ status: 'error', message: 'Nama zon terlalu panjang' }, 400);

    if (url.pathname === '/api/pipe-summary') {
      if (!zone) return reply({ status: 'error', message: 'Pilih zon untuk ringkasan' }, 400);
      const result = await env.DB.prepare(`
        SELECT COUNT(DISTINCT z.asset_num) AS asset_count,
               COUNT(*) AS line_parts,
               ROUND(COALESCE(SUM(z.length_m), 0), 1) AS length_m
        FROM pipe_network_zone_lines z
        WHERE z.import_id = ? AND z.zone_name = ?
      `).bind(importId, zone).first();
      const groups = await env.DB.prepare(`
        SELECT COALESCE(s.material, 'Tidak dinyatakan') AS material,
               s.size_mm,
               COUNT(DISTINCT z.asset_num) AS asset_count,
               ROUND(COALESCE(SUM(z.length_m), 0), 1) AS length_m
        FROM pipe_network_zone_lines z
        JOIN pipe_network_segments s
          ON s.import_id = z.import_id AND s.segment_key = z.segment_key
        WHERE z.import_id = ? AND z.zone_name = ?
        GROUP BY s.material, s.size_mm
        ORDER BY length_m DESC
        LIMIT 30
      `).bind(importId, zone).all();
      return reply({ status: 'success', importId, zone, ...result, groups: groups.results || [] });
    }

    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '500', 10) || 500));
    const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
      return reply({ status: 'error', message: 'Offset tidak sah' }, 400);
    }
    let rows;
    if (zone) {
      const result = await env.DB.prepare(`
        SELECT z.asset_num, s.material, s.size_mm, s.nrw_zone,
               z.length_m, z.geometry_json
        FROM pipe_network_zone_lines z
        JOIN pipe_network_segments s
          ON s.import_id = z.import_id AND s.segment_key = z.segment_key
        WHERE z.import_id = ? AND z.zone_name = ?
        ORDER BY z.segment_key, z.part_index
        LIMIT ? OFFSET ?
      `).bind(importId, zone, limit + 1, offset).all();
      rows = result.results || [];
    } else {
      // Full-network requests must be constrained to the visible map area.
      const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
      if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]
          || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -90 || bbox[3] > 90) {
        return reply({ status: 'error', message: 'bbox WGS84 wajib untuk seluruh rangkaian' }, 400);
      }
      const result = await env.DB.prepare(`
        SELECT asset_num, material, size_mm, nrw_zone, length_m, geometry_json
        FROM pipe_network_segments
        WHERE import_id = ? AND min_lng <= ? AND max_lng >= ? AND min_lat <= ? AND max_lat >= ?
        ORDER BY segment_key
        LIMIT ? OFFSET ?
      `).bind(importId, bbox[2], bbox[0], bbox[3], bbox[1], limit + 1, offset).all();
      rows = result.results || [];
    }
    const hasMore = rows.length > limit;
    const features = rows.slice(0, limit).map(row => ({
      type: 'Feature',
      properties: {
        asset_num: row.asset_num,
        material: row.material,
        size_mm: row.size_mm,
        nrw_zone: row.nrw_zone,
        length_m: row.length_m,
        ...(zone ? { dma: zone, membership: 'CSV asset ID + clipped polygon' } : {})
      },
      geometry: JSON.parse(row.geometry_json)
    }));
    return reply({ status: 'success', importId, zone: zone || null,
      type: 'FeatureCollection', features, nextOffset: hasMore ? offset + limit : null });
  } catch (error) {
    console.error('pipe_network_query_failed', error);
    return reply({ status: 'error', message: 'Jajaran paip belum tersedia' }, 503);
  }
}

// Call this after buildOperationalAnalysis(...) inside the existing admin-only
// aiAgent branch, before the response and history are saved. This contributes
// measured, clipped pipe inventory; it does not claim to locate a leak.
async function addPipeEvidenceToAiResponse(env, dma, response) {
  if (!env.DB || !dma) return response;
  try {
    const active = await env.DB.prepare('SELECT import_id FROM pipe_network_active WHERE singleton = 1').first();
    if (!active?.import_id) return response;
    const totals = await env.DB.prepare(`
      SELECT COUNT(DISTINCT asset_num) AS asset_count, COUNT(*) AS line_parts,
             ROUND(COALESCE(SUM(length_m), 0), 1) AS length_m
      FROM pipe_network_zone_lines WHERE import_id = ? AND zone_name = ?
    `).bind(active.import_id, dma).first();
    if (!totals?.line_parts) return response;
    const groups = await env.DB.prepare(`
      SELECT COALESCE(s.material, 'Tidak dinyatakan') AS material, s.size_mm,
             ROUND(SUM(z.length_m), 1) AS length_m
      FROM pipe_network_zone_lines z
      JOIN pipe_network_segments s
        ON s.import_id = z.import_id AND s.segment_key = z.segment_key
      WHERE z.import_id = ? AND z.zone_name = ?
      GROUP BY s.material, s.size_mm ORDER BY length_m DESC LIMIT 3
    `).bind(active.import_id, dma).all();
    const dominant = (groups.results || []).map(group =>
      `${group.material} ${group.size_mm ?? '?'} mm (${Math.round(group.length_m)} m)`
    ).join(', ');
    const statement = `Jajaran D1 ${dma}: ${totals.asset_count} ID aset, ${totals.line_parts} bahagian garisan, ${(totals.length_m / 1000).toFixed(2)} km; dominan ${dominant}. Ini tidak mengesahkan kebocoran pada segmen tertentu.`;
    response.answer += ` ${statement}`;
    response.findings.push(statement);
    response.metrics.push({ label: 'Panjang jajaran DMA', value: (totals.length_m / 1000).toFixed(2), unit: 'km' });
    response.evidence.push({ source: 'D1 pipe_network_zone_lines', description: `ID aset CSV dipadankan dengan KML dan garisan dipotong pada poligon DMA ${dma}.`, record_count: totals.line_parts });
  } catch (error) {
    console.error('pipe_analysis_unavailable', error);
  }
  return response;
}

export default { async scheduled(controller, env, ctx) { console.log(JSON.stringify({ event: "scheduled_health_check", cron: controller.cron, scheduledTime: controller.scheduledTime })); },
  async fetch(request, env, ctx) {
    const allowedOrigins = [
      "https://sainspd.github.io",
      "https://sainspdwater-dev.github.io",
      "http://127.0.0.1:5500",
      "http://localhost:5500"
    ];
    const origin = request.headers.get("Origin");
    const corsOrigin = allowedOrigins.includes(origin) ? origin : "https://sainspd.github.io";

    const securityHeaders = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "geolocation=(), microphone=(), camera=()"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: securityHeaders });
    }

    const clientIP = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    try {
      if (!checkRateLimit(`api_${clientIP}`, 60, 60000)) {
        return jsonResp({ status: 'error', message: 'Had permintaan API dilampaui (Rate limit exceeded).' }, securityHeaders, 429);
      }

      if (!env.GOOGLE_SHEET_ID || !env.APP_SECRET) {
        return jsonResp({ status: 'error', message: 'Konfigurasi Pelayan Tidak Lengkap: Sila semak Variable di Cloudflare.' }, securityHeaders, 500);
      }

      const spreadsheetId = env.GOOGLE_SHEET_ID;
      const APP_SECRET = env.APP_SECRET;
      
      const url = new URL(request.url);
      const fetchType = url.searchParams.get('fetch');
      let cachedAccessToken = null;

      async function getAccessToken() {
        if (!cachedAccessToken) {
          cachedAccessToken = await getGoogleAccessToken(env);
        }
        return cachedAccessToken;
      }

      // ==========================================
      // FUNGSI LOGIN & PENGESAHAN PENGGUNA (POST)
      // ==========================================
      if (request.method === "POST") {
        const clonedReq = request.clone();
        let reqData = {};
        try {
          reqData = await clonedReq.json();
        } catch(e) {}

        const action = reqData.action;

        // Local staging rehearsal only. This test credential never exists in
        // production; all subsequent requests still pass the normal JWT gate.
        if (action === 'hydraulicStagingLogin' && stagingEnabled(env, request)) {
          if (!checkRateLimit(`hydraulic_staging_login_${clientIP}`, 3, 60000))
            return jsonResp({ status: 'error', message: 'Terlalu banyak cubaan ujian.' }, securityHeaders, 429);
          const code = env.HYDRAULIC_STAGING_LOGIN_CODE;
          if (!code || String(code).length < 32 || typeof reqData.code !== 'string' ||
              reqData.code.length > 128 || reqData.code !== code)
            return jsonResp({ status: 'error', message: 'Kod staging tidak sah.' }, securityHeaders, 401);
          const token = await signUserJwt({ username: 'phase2bs-admin', level: 'ADMIN',
            purpose: 'HYDRAULIC_STAGING_TEST', exp: Date.now() + 60 * 60 * 1000 }, APP_SECRET);
          return jsonResp({ status: 'success', level: 'ADMIN', token,
            modelType: 'TEST MODEL', sainsModelStatus: 'NOT_READY' }, securityHeaders);
        }

        if (action === 'login') {
          if (!checkRateLimit(`login_${clientIP}`, 5, 60000)) {
            return jsonResp({ status: 'error', message: 'Terlalu banyak cubaan log masuk. Sila cuba lagi selepas 1 minit.' }, securityHeaders, 429);
          }

          const accessToken = await getAccessToken();
          const userRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/USER!A1:D100`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          const userData = await userRes.json();
          const rows = userData.values || [];

          for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === reqData.username) {
              if (rows[i][2] !== 'ACTIVE') return jsonResp({ status: 'error', message: 'Akaun tidak aktif' }, securityHeaders);
              if (reqData.passwordHash.toLowerCase() === String(rows[i][1]).toLowerCase()) {
                
                const token = await signUserJwt({
                  username: rows[i][0],
                  level: rows[i][3],
                  exp: Date.now() + (8 * 60 * 60 * 1000)
                }, APP_SECRET);

                return jsonResp({
                  status: 'success', 
                  level: rows[i][3], 
                  token: token, 
                  message: 'Log masuk berjaya' 
                }, securityHeaders);

              } else {
                return jsonResp({ status: 'error', message: 'Kata laluan salah' }, securityHeaders);
              }
            }
          }
          return jsonResp({ status: 'error', message: 'Pengguna tidak dijumpai' }, securityHeaders);
        }
      }

      // ==========================================
      // SEMAKAN TOKEN JWT
      // ==========================================
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ status: "error", message: "Akses Ditolak: Tiada Token Sesi Sah" }), {
          status: 401, 
          headers: { ...securityHeaders, "Content-Type": "application/json" }
        });
      }

      const userToken = authHeader.split(" ")[1];
      const decodedUser = await verifyUserJwt(userToken, APP_SECRET);
      
      if (!decodedUser) {
        return new Response(JSON.stringify({ status: "error", message: "Akses Ditolak: Token Tidak Sah Atau Luput" }), {
          status: 401, 
          headers: { ...securityHeaders, "Content-Type": "application/json" }
        });
      }

      const pipeResponse = await handlePipeNetworkRequest(request, env, decodedUser, securityHeaders);
      if (pipeResponse) return pipeResponse;

      // ==========================================
      // ENDPOINT D1: ASET PAIP PORT DICKSON
      // ==========================================
      if (url.pathname === "/api/pipes") {
        if (!env.DB) {
          return jsonResp({ status: 'error', message: 'D1 Database binding (DB) belum dikonfigurasi.' }, securityHeaders, 500);
        }
        const zone = url.searchParams.get("zone");
        let query = "SELECT * FROM water_assets";
        let stmt;

        if (zone) {
          query += " WHERE zone = ?";
          stmt = env.DB.prepare(query).bind(zone);
        } else {
          stmt = env.DB.prepare(query);
        }

        const { results } = await stmt.all();
        return jsonResp(results, securityHeaders);
      }

      if (url.pathname === "/api/stats") {
        if (!env.DB) {
          return jsonResp({ status: 'error', message: 'D1 Database binding (DB) belum dikonfigurasi.' }, securityHeaders, 500);
        }
        const searchQuery = url.searchParams.get("q") || "";
        const { results } = await env.DB.prepare(
          "SELECT asset_num, zone, material, size, length FROM water_assets WHERE zone LIKE ? LIMIT 50"
        ).bind(`%${searchQuery}%`).all();
        return jsonResp(results, securityHeaders);
      }

      // ==========================================
      // FUNGSI GET: BACA DATA GOOGLE SHEETS
      // ==========================================
      if (request.method === "GET") {
        const accessToken = await getAccessToken();
        const sheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/raw data!A:AB`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const sheetData = await sheetRes.json();
        const rows = sheetData.values || [];
        const headers = rows.length > 0 ? rows[0] : [];
        const jsonData = [];

        for (let i = 1; i < rows.length; i++) {
          let rowObj = {};
          headers.forEach((h, j) => {
            let headerName = h ? h.toString().trim() : `Col_${j}`;
            let cellVal = rows[i][j] || "";
            
            if (headerName.toUpperCase().includes('TARIKH') && cellVal) {
              cellVal = normalizeDateString(cellVal);
            }
            
            rowObj[headerName] = cellVal;
          });

          if (rowObj['NO ADUAN'] && String(rowObj['NO ADUAN']).trim() !== '') {
            jsonData.push(rowObj);
          }
        }

        if (fetchType === 'all') {
          const dropdowns = await getDropdownData(accessToken, spreadsheetId);
          return jsonResp({ rawData: jsonData, dropdowns: dropdowns }, securityHeaders);
        }

        return jsonResp(jsonData, securityHeaders);
      }

      // ==========================================
      // FUNGSI POST: AI AGENT ORCHESTRATOR & CRUD SHEETS
      // ==========================================
      if (request.method === "POST") {
        const reqData = await request.json();
        const action = reqData.action;

        // Phase 2A actions are additive and use the same verified JWT gate.
        // The old saveDmaMonitoring branch below is retained as a deployment
        // rollback reference, but this handler owns that action now.
        const phase2aResponse = await handlePhase2aAction({
          action, data: reqData, env, user: decodedUser,
          headers: securityHeaders, secret: APP_SECRET
        });
        if (phase2aResponse) return phase2aResponse;
        // Isolated TEST-only staging gateway; absent/disabled in production.
        const stagingHydraulicResponse = await handleStagingHydraulicAction({
          action, data: reqData, env, user: decodedUser, headers: securityHeaders, request
        });
        if (stagingHydraulicResponse) return stagingHydraulicResponse;
        const phase2bResponse = await handlePhase2bAction({
          action, data: reqData, env, user: decodedUser, headers: securityHeaders
        });
        if (phase2bResponse) return phase2bResponse;

        // --- PEMANTAUAN TEKANAN DMA / SENSOR / KEPUTUSAN ALD ---
        if (action === 'saveDmaMonitoring') {
          if (decodedUser.level === 'GUEST') {
            return jsonResp({ status: 'error', message: 'Akses Ditolak: Akaun GUEST tidak dibenarkan menyimpan pemantauan DMA.' }, securityHeaders, 403);
          }
          if (!env.DB) {
            return jsonResp({ status: 'error', message: 'D1 Database binding (DB) belum dikonfigurasi.' }, securityHeaders, 500);
          }
          const dma = String(reqData.dma || '').trim();
          if (!dma || dma.length > 180) {
            return jsonResp({ status: 'error', message: 'District Metered Area wajib dipilih.' }, securityHeaders, 400);
          }
          try {
            const now = new Date().toISOString();
            const uploadedRows = Array.isArray(reqData.telemetryRows) ? reqData.telemetryRows.slice(0, 10000) : [];
            const manualRow = reqData.manualTelemetry && typeof reqData.manualTelemetry === 'object' ? [reqData.manualTelemetry] : [];
            const telemetryRows = [...uploadedRows, ...manualRow]
              .map(row => normaliseTelemetryRow(row, now, row?.source || 'csv_upload'))
              .filter(Boolean);
            const statements = telemetryRows.map(row => env.DB.prepare(`INSERT INTO dma_telemetry
              (district_metered_area, recorded_at, flow_m3h, pressure_inlet_bar, pressure_cp_bar, legitimate_night_use_m3h, source, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .bind(dma, row.recordedAt, row.flow, row.inlet, row.cp, row.legitimate, row.source, decodedUser.username || decodedUser.email || 'dashboard'));

            const sensors = Array.isArray(reqData.sensors) ? reqData.sensors.slice(0, 20) : [];
            for (const sensor of sensors) {
              const latitude = safeNumber(sensor.latitude);
              const longitude = safeNumber(sensor.longitude);
              const type = String(sensor.sensor_type || '').toUpperCase();
              if (!['FLOW_METER', 'PRESSURE_CP', 'PRV'].includes(type) || latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
              statements.push(env.DB.prepare(`INSERT INTO dma_sensors
                (district_metered_area, sensor_type, sensor_name, latitude, longitude, updated_at, created_by)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`)
                .bind(dma, type, String(sensor.sensor_name || type).slice(0, 160), latitude, longitude, decodedUser.username || decodedUser.email || 'dashboard'));
            }

            const ald = reqData.ald && typeof reqData.ald === 'object' ? reqData.ald : null;
            if (ald && ['CONFIRMED_LEAK', 'NO_LEAK', 'SUSPECTED'].includes(String(ald.result_status || ''))) {
              const inspectedAt = ald.inspected_at && !Number.isNaN(new Date(ald.inspected_at).getTime()) ? new Date(ald.inspected_at).toISOString() : now;
              statements.push(env.DB.prepare(`INSERT INTO ald_results
                (district_metered_area, inspected_at, location, result_status, estimated_leak_m3h, notes, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .bind(dma, inspectedAt, String(ald.location || '').slice(0, 500), ald.result_status, safeNumber(ald.estimated_leak_m3h), String(ald.notes || '').slice(0, 2000), decodedUser.username || decodedUser.email || 'dashboard'));
            }
            if (!statements.length) {
              return jsonResp({ status: 'error', message: 'Masukkan sekurang-kurangnya satu bacaan, lokasi sensor, atau keputusan ALD yang sah.' }, securityHeaders, 400);
            }
            await runD1Batch(env.DB, statements);
            return jsonResp({ status: 'success', message: `${telemetryRows.length} bacaan masa, ${sensors.length} sensor dan ${ald ? 1 : 0} keputusan ALD dihantar ke D1 bagi ${dma}.` }, securityHeaders);
          } catch (error) {
            return jsonResp({ status: 'error', message: `Gagal menyimpan pemantauan D1. Pastikan migrasi schema telah dijalankan. (${error.message})` }, securityHeaders, 500);
          }
        }

        // --- TOOL-DRIVEN AI ORCHESTRATOR DENGAN PERLINDUNGAN MENYELURUH ---
        if (action === 'aiAgent') {
          if (decodedUser.level !== 'ADMIN') {
            return jsonResp({ status: 'error', message: 'Akses Ditolak: Hanya akaun Admin sahaja yang dibenarkan menggunakan AI Agent.' }, securityHeaders, 403);
          }

          try {
            const userPrompt = reqData.prompt || "";
            const clientParams = reqData.params || {};
            let records = Array.isArray(reqData.records) ? reqData.records : [];
            // Perlindungan kedua: jika browser belum sempat memuatkan rawData,
            // baca rekod yang sama terus daripada Google Sheet.
            if (records.length === 0) {
              try {
                const accessToken = await getAccessToken();
                const sheetRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/raw data!A:AB`, {
                  headers: { Authorization: `Bearer ${accessToken}` }
                });
                const sheetJson = await sheetRes.json();
                const rows = sheetJson.values || [];
                const headers = rows[0] || [];
                records = rows.slice(1).map(row => headers.reduce((record, header, index) => {
                  record[String(header || `Col_${index}`).trim()] = row[index] || '';
                  return record;
                }, {})).filter(record => getRecordValue(record, ['NO ADUAN', 'No Aduan']));
              } catch (sheetError) {
                // Kekalkan array kosong; respons akan menyatakan sumber yang tiada.
              }
            }

            const tools = {
              query_assets: async (args) => {
                if (!env.DB) return { error: "D1 Database tidak dikonfigurasi." };
                let query = "SELECT COUNT(*) as asset_count, SUM(length) as total_length, material, size FROM water_assets WHERE 1=1";
                let params = [];
                if (args.dma && args.dma !== 'Semua') { query += " AND zone LIKE ?"; params.push(`%${args.dma}%`); }
                if (args.material) { query += " AND material = ?"; params.push(args.material); }
                if (args.diameter) { query += " AND size = ?"; params.push(String(args.diameter)); }
                query += " GROUP BY material, size";
                
                try {
                  const stmt = env.DB.prepare(query);
                  const result = await stmt.bind(...params).all();
                  return { source: "D1", records: result.results };
                } catch (e) { return { error: e.message }; }
              },
              
              query_hotspots: async (args) => {
                const dma = args.dma || clientParams.dma;
                let filtered = records;
                if (dma && dma !== 'Semua') {
                  filtered = filtered.filter(r => getRecordValue(r, ['District Metered Area', 'DISTRICT METERED AREA', 'DMA']).toUpperCase().includes(dma.toUpperCase()));
                }
                const failures = filtered.filter(r => {
                  const cat = getRecordValue(r, ['KATEGORI', 'Kategori', 'kategori']).toUpperCase();
                  return cat.includes("PECAH") || cat.includes("BOCOR");
                });
                
                let hotspots = {};
                failures.forEach(r => {
                  let loc = getRecordValue(r, ['LOKASI / TEMPAT', 'LOKASI', 'Lokasi / Tempat', 'Lokasi']).toUpperCase();
                  if (loc) {
                    const coordinate = getRecordValue(r, ['KORDINAT', 'Kordinat', 'KOORDINAT']).split(',');
                    if(!hotspots[loc]) hotspots[loc] = { count: 0, lat: coordinate[0] || null, lng: coordinate[1] || null };
                    hotspots[loc].count++;
                  }
                });
                
                const topHotspots = Object.entries(hotspots)
                  .sort((a, b) => b[1].count - a[1].count).slice(0, 5)
                  .map(e => ({ location: e[0], incident_count: e[1].count, lat: e[1].lat, lng: e[1].lng }));
                  
                return { source: "Google Sheets", total_failures: failures.length, hotspots: topHotspots };
              }
            };

            // Ringkaskan D1 pada pelayan. D1 digunakan untuk profil material, saiz
            // dan panjang aset; titik peta kekal daripada koordinat aduan yang sah.
            let assetProfile = { available: false, assetCount: 0, totalLength: 0, groups: [], sourceScope: '' };
            if (env.DB) {
              try {
                const assetResult = await env.DB.prepare(`
                  SELECT source_file, material, size, COUNT(*) AS asset_count,
                         COALESCE(SUM(CAST(length AS REAL)), 0) AS total_length
                  FROM water_assets_unique
                  GROUP BY source_file, material, size
                  ORDER BY source_file, asset_count DESC
                  LIMIT 5000
                `).all();
                const allGroups = assetResult.results || [];
                const selectedSource = normaliseText(clientParams.dma);
                const sourceTokens = selectedSource.split(' ').filter(token => token.length >= 3);
                const minTokenMatches = Math.min(2, sourceTokens.length);
                const exactGroups = selectedSource ? allGroups.filter(group =>
                  normaliseText(group.source_file).replace(/ (CSV|XLSX|XLS)$/, '') === selectedSource
                ) : [];
                const matchedGroups = exactGroups.length ? exactGroups : selectedSource && sourceTokens.length ? allGroups.filter(group => {
                  const sourceName = normaliseText(group.source_file);
                  const matchingTokens = sourceTokens.filter(token => sourceName.includes(token)).length;
                  return sourceName.includes(selectedSource) || matchingTokens >= minTokenMatches;
                }) : allGroups;
                // source_file ialah pautan aset kepada District Metered Area. Jika
                // tiada padanan fail, tunjukkan semua D1 secara jelas, bukan data
                // kosong atau padanan palsu.
                const groups = (matchedGroups.length ? matchedGroups : allGroups).sort((a, b) => (Number(b.asset_count) || 0) - (Number(a.asset_count) || 0));
                const sourceFiles = [...new Set(groups.map(group => group.source_file).filter(Boolean))];
                assetProfile = {
                  available: groups.length > 0,
                  assetCount: groups.reduce((sum, group) => sum + (Number(group.asset_count) || 0), 0),
                  totalLength: Math.round(groups.reduce((sum, group) => sum + (Number(group.total_length) || 0), 0) * 100) / 100,
                  groups,
                  sourceScope: matchedGroups.length && selectedSource ? `source_file DMA: ${sourceFiles.slice(0, 3).join(', ')}` : 'semua source_file D1'
                };
              } catch (d1Error) {
                // Analisis aduan terus berjalan jika binding atau data D1 bermasalah.
              }
            }

            let monitoringProfile = { available: false, dma: clientParams.dma || '' };
            if (env.DB && clientParams.dma) {
              try {
                const telemetryResult = await env.DB.prepare(`SELECT recorded_at, flow_m3h, pressure_inlet_bar, pressure_cp_bar, legitimate_night_use_m3h
                  FROM dma_telemetry WHERE UPPER(district_metered_area) = UPPER(?) ORDER BY recorded_at DESC LIMIT 500`).bind(clientParams.dma).all();
                const aldResult = await env.DB.prepare(`SELECT inspected_at, result_status, estimated_leak_m3h
                  FROM ald_results WHERE UPPER(district_metered_area) = UPPER(?) ORDER BY inspected_at DESC LIMIT 50`).bind(clientParams.dma).all();
                monitoringProfile = buildLeakRiskProfile(telemetryResult.results || [], aldResult.results || [], clientParams, clientParams.dma);
              } catch (_) {
                // Jadual modul mungkin belum dimigrasi; analisis sejarah insiden kekal boleh digunakan.
              }
            }

            const operationalResponse = buildOperationalAnalysis(records, clientParams, userPrompt, assetProfile, monitoringProfile);
            await addPipeEvidenceToAiResponse(env, clientParams.dma, operationalResponse);
            const historyContext = { ...clientParams, intent: operationalResponse.intent, risk_score: monitoringProfile.available ? monitoringProfile.score : null };
            const userLogged = await logAiHistory(env.DB, {
              dma: clientParams.dma, sessionId: reqData.sessionId, agentType: reqData.agentType,
              role: 'user', content: userPrompt, params: historyContext
            });
            const assistantLogged = await logAiHistory(env.DB, {
              dma: clientParams.dma, sessionId: reqData.sessionId, agentType: reqData.agentType,
              role: 'assistant', content: operationalResponse.answer, params: historyContext
            });
            operationalResponse.history_logged = userLogged && assistantLogged;
            return jsonResp(operationalResponse, securityHeaders);

          } catch (aiErr) {
            return jsonResp({
              status: "success",
              answer: "Sistem AI berjaya menerima pertanyaan anda. Sila cuba hantar semula soalan.",
              intent: "general",
              confidence: { level: "LOW", reason: "Ralat: " + aiErr.message },
              evidence: [],
              metrics: [],
              calculations: [],
              findings: ["Pemprosesan maklumat diselesaikan secara selamat."],
              recommendations: [{ priority: "LOW", action: "Cuba hantar semula soalan.", reason: "Mengelakkan ralat paparan." }],
              map: { enabled: false, markers: [] }
            }, securityHeaders);
          }
        }

        // --- GOOGLE SHEETS CRUD ACTIONS ---
        if ((action === 'deleteData' || action === 'updateData' || action === 'addData') && decodedUser.level === 'GUEST') {
           return jsonResp({ status: 'error', message: 'Tindakan Ditolak: Akaun GUEST tidak dibenarkan mengubah data.' }, securityHeaders);
        }

        const accessToken = await getAccessToken();
        const allRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/raw data!A:AB`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const allData = await allRes.json();
        const rows = allData.values || [];
        const headers = rows.length > 0 ? rows[0] : [];
        const skipHeaders = ['kpi masa tutup aduan', 'kpi aduan', 'link maps', 'bulan'];

        if (action === 'addData') {
          const dataObj = reqData.data;
          let newRow = new Array(headers.length).fill('');
          
          headers.forEach((header, j) => {
            const cleanHeader = header ? header.toString().trim().toLowerCase() : '';
            if (skipHeaders.includes(cleanHeader)) return;

            for (let key in dataObj) {
              const cleanKey = key.trim().toLowerCase();
              if (cleanKey === cleanHeader || cleanKey.replace(/\s+/g, '') === cleanHeader.replace(/\s+/g, '')) {
                newRow[j] = dataObj[key] !== undefined && dataObj[key] !== null ? dataObj[key] : '';
                break;
              }
            }
          });

          while (newRow.length < 20) newRow.push('');
          const newRowIndex = rows.length + 1;
          processTurapLogic(newRow, newRowIndex);

          let sendLength = headers.length;
          while (sendLength > 0) {
            const h = headers[sendLength - 1] ? headers[sendLength - 1].toString().trim().toLowerCase() : '';
            if (skipHeaders.includes(h) || (newRow[sendLength - 1] === '' && sendLength > 19)) {
              sendLength--;
            } else {
              break;
            }
          }
          const trimmedRow = newRow.slice(0, sendLength);

          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/raw data!A1:append?valueInputOption=USER_ENTERED`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ values: [trimmedRow] })
          });

          return jsonResp({ status: 'success', message: 'Data berjaya ditambah' }, securityHeaders);
        }

        if (action === 'updateData') {
          const dataObj = reqData.data;
          const targetNoAduan = String(dataObj['NO ADUAN'] || dataObj['noAduan'] || dataObj['No Aduan']).trim();
          
          let targetRowIndex = -1;
          let noAduanColIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NO ADUAN');
          if (noAduanColIdx === -1) noAduanColIdx = 0;

          for (let i = 1; i < rows.length; i++) {
            if (String(rows[i][noAduanColIdx]).trim() === targetNoAduan) {
              targetRowIndex = i + 1;
              break;
            }
          }

          if (targetRowIndex === -1) return jsonResp({ status: 'error', message: 'No Aduan tidak dijumpai untuk dikemaskini' }, securityHeaders);

          let updateDataEntries = [];
          headers.forEach((header, j) => {
            const cleanHeader = header ? header.toString().trim().toLowerCase() : '';
            if (skipHeaders.includes(cleanHeader)) return;

            for (let key in dataObj) {
              const cleanKey = key.trim().toLowerCase();
              if (cleanKey === cleanHeader || cleanKey.replace(/\s+/g, '') === cleanHeader.replace(/\s+/g, '')) {
                const valToUpdate = dataObj[key];
                if (valToUpdate !== undefined && valToUpdate !== null) {
                  const colLetter = columnToLetter(j + 1);
                  updateDataEntries.push({
                    range: `raw data!${colLetter}${targetRowIndex}`,
                    values: [[valToUpdate]]
                  });
                }
                break;
              }
            }
          });

          let updatedRow = [...rows[targetRowIndex - 1]];
          while (updatedRow.length < 20) updatedRow.push('');
          headers.forEach((header, j) => {
            const cleanHeader = header ? header.toString().trim().toLowerCase() : '';
            if (skipHeaders.includes(cleanHeader)) return;
            for (let key in dataObj) {
              const cleanKey = key.trim().toLowerCase();
              if (cleanKey === cleanHeader || cleanKey.replace(/\s+/g, '') === cleanHeader.replace(/\s+/g, '')) {
                updatedRow[j] = dataObj[key];
                break;
              }
            }
          });

          processTurapLogic(updatedRow, targetRowIndex);

          [15, 16, 17, 18].forEach(idx => {
            if (idx < headers.length) {
              const colLetter = columnToLetter(idx + 1);
              updateDataEntries.push({
                range: `raw data!${colLetter}${targetRowIndex}`,
                values: [[updatedRow[idx]]]
              });
            }
          });

          let uniqueEntriesMap = {};
          updateDataEntries.forEach(entry => { uniqueEntriesMap[entry.range] = entry; });
          let finalEntries = Object.values(uniqueEntriesMap);

          if (finalEntries.length > 0) {
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: finalEntries })
            });
          }

          return jsonResp({ status: 'success', message: 'Data berjaya dikemaskini' }, securityHeaders);
        }

        if (action === 'deleteData') {
          const targetNoAduan = String(reqData.noAduan).trim();
          
          let targetRowIndex = -1;
          let noAduanColIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NO ADUAN');
          if (noAduanColIdx === -1) noAduanColIdx = 0;

          for (let i = 1; i < rows.length; i++) {
            if (String(rows[i][noAduanColIdx]).trim() === targetNoAduan) {
              targetRowIndex = i + 1;
              break;
            }
          }

          if (targetRowIndex === -1) return jsonResp({ status: 'error', message: 'No Aduan tidak dijumpai untuk dipadam' }, securityHeaders);

          const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          const metaData = await metaRes.json();
          const sheetList = metaData.sheets || [];
          
          let targetSheetId = 0;
          for (const s of sheetList) {
            if (s.properties.title.trim().toLowerCase() === 'raw data') {
              targetSheetId = s.properties.sheetId;
              break;
            }
          }

          const deleteRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: [{
                deleteDimension: {
                  range: { sheetId: targetSheetId, dimension: "ROWS", startIndex: targetRowIndex - 1, endIndex: targetRowIndex }
                }
              }]
            })
          });

          if (!deleteRes.ok) {
            const errJson = await deleteRes.json();
            return jsonResp({ status: 'error', message: 'Gagal padam baris: ' + (errJson.error?.message || 'Unknown') }, securityHeaders);
          }

          return jsonResp({ status: 'success', message: 'Rekod berjaya dipadam' }, securityHeaders);
        }
      }

      return new Response("Method Not Allowed", { status: 405, headers: securityHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: err.message }), {
        status: 500, headers: { ...securityHeaders, "Content-Type": "application/json" }
      });
    }
  }
};

async function signUserJwt(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const header = btoa(JSON.stringify({alg: 'HS256', typ: 'JWT'})).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${b64Sig}`;
}

async function verifyUserJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!isValid) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && Date.now() > payload.exp) return null; 
    return payload;
  } catch(e) { return null; }
}

function jsonResp(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function normalizeDateString(val) {
  if (!val) return "";
  let str = String(val).trim();
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (isoMatch) {
    const [, y, m, d, hh = '00', mm = '00'] = isoMatch;
    return `${d}/${m}/${y} ${hh}:${mm}`;
  }
  return str;
}

async function getDropdownData(accessToken, spreadsheetId) {
  const defaultDropdowns = {
    zon: ['1', '2', '3'],
    kategori: ['PECAH', 'Bocor', 'Lain-lain'],
    jenisPaip: ['AC', 'MS', 'DI', 'UPVC', 'AB3P', 'HDPE', 'GRP', 'Air Valve', 'Coupling Bocor', 'Coupling Patah', 'Stop Cock', 'Tiang Meter Patah', 'Soket Bocor', 'Ferrule Tersumbat', 'Ferrule Bocor', 'Sluice Valve', 'S/S', 'PA', 'GI', 'Saddle', 'Cast Iron'],
    saiz: ['0.5', '0.75', '1', '1.5', '2', '3', '4', '6', '8', '10', '12', '14', '15', '18', '20', '21', '24', '30', '36', '40', '48'],
    sivil: ['Turap', 'Simen', 'Konkrit', 'Interlocking', 'Batu Curve Jalan', 'Road Marking', 'Longkang'],
    pelaksana: ['IU Legacy', 'NJA Prisma', 'Kaza Berkat', 'CTIU', 'Rynzaty', 'IR Vision', 'Namiio Waja', 'ZNA ENT', 'SAINS'],
    dma: ['SIRUSA ZONE 1', 'SIRUSA ZONE 2', 'SIRUSA ZONE 3', 'SAWAH RAJA', 'BKT TUNGGAL', 'SEREMBAN BARAT']
  };

  try {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/DROPDOWN!A1:G100`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    const rows = data.values || [];
    if (rows.length <= 1) return defaultDropdowns;

    let customZon = [], customKategori = [], customJenisPaip = [], customSaiz = [], customSivil = [], customPelaksana = [], customDma = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] !== undefined && String(row[0]).trim() !== '') customZon.push(String(row[0]).trim());
      if (row[1] !== undefined && String(row[1]).trim() !== '') customKategori.push(String(row[1]).trim());
      if (row[2] !== undefined && String(row[2]).trim() !== '') customJenisPaip.push(String(row[2]).trim());
      if (row[3] !== undefined && String(row[3]).trim() !== '') customSaiz.push(String(row[3]).trim());
      if (row[4] !== undefined && String(row[4]).trim() !== '') customSivil.push(String(row[4]).trim());
      if (row[5] !== undefined && String(row[5]).trim() !== '') customPelaksana.push(String(row[5]).trim());
      if (row[6] !== undefined && String(row[6]).trim() !== '') customDma.push(String(row[6]).trim());
    }

    if (customZon.length > 0) defaultDropdowns.zon = [...new Set(customZon)];
    if (customKategori.length > 0) defaultDropdowns.kategori = [...new Set(customKategori)];
    if (customJenisPaip.length > 0) defaultDropdowns.jenisPaip = [...new Set(customJenisPaip)];
    if (customSaiz.length > 0) defaultDropdowns.saiz = [...new Set(customSaiz)];
    if (customSivil.length > 0) defaultDropdowns.sivil = [...new Set(customSivil)];
    if (customPelaksana.length > 0) defaultDropdowns.pelaksana = [...new Set(customPelaksana)];
    if (customDma.length > 0) defaultDropdowns.dma = [...new Set(customDma)];
  } catch (e) {}
  
  return defaultDropdowns;
}

function processTurapLogic(rowArray, rowIndex) {
  const sivilVal = String(rowArray[15] || '').trim().toUpperCase();

  if (sivilVal === "TURAP") {
    if (!rowArray[16]) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const formattedDate = `${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      
      rowArray[16] = formattedDate;

      const next30 = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
      const formattedNext30 = `${pad(next30.getDate())}/${pad(next30.getMonth()+1)}/${next30.getFullYear()} ${pad(next30.getHours())}:${pad(next30.getMinutes())}`;
      
      rowArray[17] = formattedNext30;
      rowArray[18] = `=IF(ISBLANK(R${rowIndex}), "", IF(TODAY()>=INT(R${rowIndex}), 0, INT(R${rowIndex}) - TODAY()))`;
    }
  } else if (sivilVal === "") {
    rowArray[16] = ""; rowArray[17] = ""; rowArray[18] = "";
  }
}

function columnToLetter(col) {
  let letter = '';
  while (col > 0) {
    let remainder = (col - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

async function getGoogleAccessToken(env) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let rawKey = env.GOOGLE_PRIVATE_KEY || "";
  
  let base64Key = rawKey
    .replace(/\\n/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");

  while (base64Key.length % 4 !== 0) { base64Key += "="; }

  let binaryDer;
  try {
    const decoded = atob(base64Key);
    binaryDer = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) { binaryDer[i] = decoded.charCodeAt(i); }
  } catch (err) {
    throw new Error("Format GOOGLE_PRIVATE_KEY tidak sah.");
  }

  const key = await crypto.subtle.importKey(
    "pkcs8", binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
    false, ["sign"]
  );

  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  }, key);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Gagal mendapatkan Google Token.");
  return tokenData.access_token;
}

async function signJwt(payload, privateKey) {
  const sHeader = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const sPayload = JSON.stringify(payload);
  const b64Header = btoa(sHeader).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const b64Payload = btoa(sPayload).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${b64Header}.${b64Payload}`;

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${b64Sig}`;
}
