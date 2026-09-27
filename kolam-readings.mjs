// Read only the explicitly named site and exact requested minute from each export.
export const normalizeKolamSite = name => String(name || '').normalize('NFKD')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

export function normalizeKolamTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = number => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  const text = String(value ?? '').trim();
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')} ${match[4].padStart(2, '0')}:${match[5]}:${match[6] || '00'}`;
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')} ${match[4].padStart(2, '0')}:${match[5]}:${match[6] || '00'}`;
  return '';
}

export function extractKolamSheet(rows, sourceFile, sheetName, date, time) {
  const cells = Array.isArray(rows) ? rows : [];
  const metadata = cells.slice(0, 30).flat().find(cell => /^\s*site name\s*:/i.test(String(cell ?? '')));
  const siteName = metadata ? String(metadata).replace(/^\s*site name\s*:/i, '').trim() : '';
  const result = { sourceFile, sheetName, siteName, status: 'INVALID', value: null, row: null };
  if (!siteName) return { ...result, reason: 'Site name tidak ditemui dalam fail.' };
  const headerIndex = cells.findIndex(row => Array.isArray(row) && row.some(cell => /^\s*reading time\s*$/i.test(String(cell ?? ''))));
  if (headerIndex < 0) return { ...result, reason: 'Kolum Reading Time tidak ditemui.' };
  const header = cells[headerIndex];
  const timeIndex = header.findIndex(cell => /^\s*reading time\s*$/i.test(String(cell ?? '')));
  const valueColumns = header.map((cell, index) => ({ index, text: String(cell ?? '') }))
    .filter(item => item.index !== timeIndex && /\b(depth|pressure)\b/i.test(item.text));
  if (valueColumns.length !== 1) return { ...result, reason: 'Perlu tepat satu kolum Depth atau Pressure; semak fail ini.' };
  const requested = `${date} ${time}:00`;
  const matches = [];
  for (let index = headerIndex + 1; index < cells.length; index++) {
    const row = cells[index];
    if (!Array.isArray(row) || normalizeKolamTimestamp(row[timeIndex]) !== requested) continue;
    const raw = row[valueColumns[0].index];
    const text = String(raw ?? '').trim();
    const numeric = /^[-+]?\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : NaN;
    if (text === '' || !Number.isFinite(numeric)) return { ...result, status: 'NO_READING', reason: `Bacaan ${date} ${time} kosong atau bukan angka.` };
    matches.push({ value: numeric, row: index + 1 });
  }
  if (!matches.length) return { ...result, status: 'NO_READING', reason: `Masa ${date} ${time} tiada dalam fail.` };
  if (matches.length > 1 && matches.some(item => item.value !== matches[0].value))
    return { ...result, status: 'CONFLICT', reason: `Lebih daripada satu bacaan berbeza pada ${date} ${time}.` };
  return { ...result, status: 'FOUND', value: matches[0].value, row: matches[0].row, metric: valueColumns[0].text };
}

export function renderKolamTemplate(template, entries, dateText, timeText) {
  const bySite = new Map();
  for (const entry of entries) {
    const key = normalizeKolamSite(entry.siteName);
    if (!key) continue;
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(entry);
  }
  const coverage = { total: 0, found: 0, noFile: 0, noReading: 0, conflict: 0, invalid: 0, details: [] };
  const report = template.replace('{TARIKH}', dateText).replace('{MASA}', timeText)
    .replace(/\{([^}]+)\}(M?)/g, (_all, site, unit) => {
      coverage.total++;
      const candidates = bySite.get(normalizeKolamSite(site)) || [];
      const found = candidates.filter(item => item.status === 'FOUND');
      if (found.length && found.every(item => item.value === found[0].value) && candidates.every(item => item.status === 'FOUND')) {
        coverage.found++;
        coverage.details.push({ site, status: 'FOUND', source: found[0].sourceFile, row: found[0].row, value: found[0].value });
        return `${found[0].value}${unit}`;
      }
      const status = !candidates.length ? 'NO_FILE' : found.length > 1 || candidates.some(item => item.status === 'CONFLICT') ? 'CONFLICT' :
        candidates.some(item => item.status === 'INVALID') ? 'INVALID' : 'NO_READING';
      if (status === 'NO_FILE') coverage.noFile++;
      else if (status === 'NO_READING') coverage.noReading++;
      else if (status === 'CONFLICT') coverage.conflict++;
      else coverage.invalid++;
      coverage.details.push({ site, status, source: candidates.map(item => item.sourceFile).join(', '),
        reason: candidates.map(item => item.reason).filter(Boolean).join('; ') });
      return status === 'CONFLICT' ? 'SEMAK KONFLIK' : 'Tiada';
    });
  return { report, coverage };
}
