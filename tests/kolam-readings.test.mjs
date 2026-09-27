import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKolamSheet, renderKolamTemplate, normalizeKolamTimestamp } from '../kolam-readings.mjs';

const date = '2026-09-27', time = '11:00';
const sheet = (site, reading, timestamp = '27/09/2026 11:00:00') => [
  [`Site name: ${site}`, ''], ['Measure: Depth', ''], ['Reading Time', 'Ch1 Depth (m)'],
  [timestamp, reading],
];

test('all six distinct Springhill sites match exact placeholders without borrowing a neighbour value', () => {
  const sites = ['Springhill 3 Rsvr', 'Springhill 2 Rsvr', 'Springhill 1', 'Springhill',
    'Bandar Springhill ST', 'Bandar Springhill RSVR'];
  const entries = sites.map((site, index) => extractKolamSheet(sheet(site, index + 1), `${site}.xlsx`, 'Readings', date, time));
  const template = sites.map(site => `${site}: {${site}}M`).join('\n') + '\nUnuploaded: {Other Site}M';
  const { report, coverage } = renderKolamTemplate(template, entries, '27/09/2026', '11:00 AM');
  sites.forEach((site, index) => assert.match(report, new RegExp(`${site}: ${index + 1}M`)));
  assert.match(report, /Unuploaded: Tiada/);
  assert.equal(coverage.found, 6);
  assert.equal(coverage.noFile, 1);
});

test('zero is a real reading, while a blank and a missing minute are not', () => {
  const zero = extractKolamSheet(sheet('Zero Site', 0), 'zero.xlsx', 'Readings', date, time);
  const blank = extractKolamSheet(sheet('Blank Site', ''), 'blank.xlsx', 'Readings', date, time);
  const old = extractKolamSheet(sheet('Old Site', 9, '27/09/2026 10:45:00'), 'old.xlsx', 'Readings', date, time);
  assert.equal(zero.status, 'FOUND');
  assert.equal(zero.value, 0);
  assert.equal(blank.status, 'NO_READING');
  assert.equal(old.status, 'NO_READING');
  assert.equal(renderKolamTemplate('{Zero Site}M', [zero], '', '').report, '0M');
});

test('conflicting sources are never silently chosen', () => {
  const first = extractKolamSheet(sheet('Same Site', 1), 'a.xlsx', 'Readings', date, time);
  const second = extractKolamSheet(sheet('Same Site', 2), 'b.xlsx', 'Readings', date, time);
  const result = renderKolamTemplate('{Same Site}M', [first, second], '', '');
  assert.equal(result.coverage.conflict, 1);
  assert.equal(result.report, 'SEMAK KONFLIK');
});

test('malformed sheet and non-exact timestamp are visibly unresolved', () => {
  const invalid = extractKolamSheet([['Site name: Example'], ['Time', 'Value']], 'bad.xlsx', 'Readings', date, time);
  assert.equal(invalid.status, 'INVALID');
  assert.equal(normalizeKolamTimestamp('27/09/2026 11:00:30'), '2026-09-27 11:00:30');
  assert.equal(extractKolamSheet(sheet('Example', 4, '27/09/2026 11:00:30'), 'late.xlsx', 'Readings', date, time).status, 'NO_READING');
});
