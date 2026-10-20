import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../offline-dashboard.js', import.meta.url), 'utf8');
function harness(server = []) {
  const storage = new Map([['sainsDesktopOffline', 'true'], ['sainsToken', '']]);
  let fetchCalls = 0;
  const writes = [];
  const dialogs = [];
  const toasts = [];
  const element = tag => ({
    tag, children: [], listeners: {}, style: {}, textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute() {}, remove() { dialogs.pop(); }, focus() {}
  });
  const context = {
    window: { sainsDesktop: {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    navigator: { onLine: false },
    document: { addEventListener() {}, getElementById() { return null; }, createElement: element, body: { appendChild(node) { dialogs.push(node); } } },
    rawData: [{ 'NO ADUAN': 'PD-1', 'DMA': 'Sawah Raja', 'CATATAN': 'asal' }],
    filteredData: [],
    populateFilters() {}, applyFilters() {}, updateManagementTable() {}, updateCroTable() {}, closeModals() {}, showToast: (...args) => toasts.push(args),
    parseCustomDate(value) { const [d, m, y] = String(value).split(/[\/\s]/); return new Date(Number(y), Number(m) - 1, Number(d)); },
    fetchFreshData: async () => {},
    AbortSignal,
    fetch: async (url, options = {}) => {
      fetchCalls++;
      if (!context.navigator.onLine) throw new Error('Offline operation contacted the server');
      if (options.method === 'POST') { writes.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'success' }) }; }
      return { ok: true, json: async () => ({ rawData: server }) };
    },
    WORKER_URL: 'https://example.invalid/'
  };
  vm.runInNewContext(code, context);
  return { context, storage, writes, dialogs, toasts, server, online() { storage.set('sainsDesktopOffline', 'false'); storage.set('sainsToken', 'test'); context.navigator.onLine = true; }, get fetchCalls() { return fetchCalls; } };
}

test('offline edit is retained locally without posting to the Worker', async () => {
  const h = harness();
  await h.context.window.sendDesktopMutation('updateData', { 'NO ADUAN': 'PD-1', 'CATATAN': 'lapangan' });
  const queue = JSON.parse(h.storage.get('sainsDesktopDraftQueue'));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].base.CATATAN, 'asal');
  assert.equal(queue[0].data.CATATAN, 'lapangan');
  assert.equal(JSON.parse(h.storage.get('sainsRawData'))[0].CATATAN, 'lapangan');
  assert.equal(h.fetchCalls, 0);
  assert.equal(h.toasts.at(-1)[0].startsWith('Disimpan sebagai draf'), true);
});

test('new offline repair is visible under its real month and survives a cached reload overlay', async () => {
  const h = harness();
  await h.context.window.sendDesktopMutation('addData', {
    'NO ADUAN': 'PD-2', 'TARIKH & MASA TERIMA  ADUAN': '01/10/2026 11:30 am', 'LOKASI / TEMPAT': 'Ujian'
  });
  const cached = JSON.parse(h.storage.get('sainsRawData'));
  assert.equal(cached[0].BULAN, 'Oct-26');
  assert.equal(cached[0]._desktopDraft, true);
  assert.equal(h.toasts.at(-1)[0].startsWith('Disimpan sebagai draf'), true);
  const restored = h.context.window.sainsDesktopOverlayDrafts([{ 'NO ADUAN': 'PD-1', 'BULAN': 'Oct-26' }]);
  assert.equal(restored.find(row => row['NO ADUAN'] === 'PD-2').BULAN, 'Oct-26');
});

test('repeated offline edits preserve original server snapshot, and deletes are blocked', async () => {
  const h = harness();
  await h.context.window.sendDesktopMutation('updateData', { 'NO ADUAN': 'PD-1', 'CATATAN': 'pertama' });
  await h.context.window.sendDesktopMutation('updateData', { 'NO ADUAN': 'PD-1', 'CATATAN': 'kedua' });
  await h.context.window.sendDesktopMutation('deleteData', { noAduan: 'PD-1' });
  const queue = JSON.parse(h.storage.get('sainsDesktopDraftQueue'));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].base.CATATAN, 'asal');
  assert.equal(queue[0].data.CATATAN, 'kedua');
  assert.equal(h.fetchCalls, 0);
});

test('reconnection uploads a non-conflicting draft automatically without a prompt', async () => {
  const h = harness([{ 'NO ADUAN': 'PD-1', 'DMA': 'Sawah Raja', 'CATATAN': 'asal' }]);
  await h.context.window.sendDesktopMutation('updateData', { 'NO ADUAN': 'PD-1', 'CATATAN': 'baru' });
  h.online();
  await h.context.window.sainsDesktopAutoSync();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].action, 'updateData');
  assert.equal(JSON.parse(h.storage.get('sainsDesktopDraftQueue')).length, 0);
  assert.equal(h.dialogs.length, 0);
});

test('changed server record shows exact conflict, No retains draft and does not write', async () => {
  const h = harness([{ 'NO ADUAN': 'PD-1', 'DMA': 'Sawah Raja', 'CATATAN': 'pelayan' }]);
  await h.context.window.sendDesktopMutation('updateData', { 'NO ADUAN': 'PD-1', 'CATATAN': 'komputer' });
  h.online();
  const pending = h.context.window.sainsDesktopAutoSync();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = h.dialogs[0];
  assert.ok(dialog);
  const panel = dialog.children[0];
  const table = panel.children[2].children[0];
  const cells = table.children.flatMap(row => row.children.map(cell => cell.textContent));
  assert.ok(cells.includes('pelayan'));
  assert.ok(cells.includes('komputer'));
  panel.children[5].listeners.click();
  await pending;
  assert.equal(h.writes.length, 0);
  assert.equal(JSON.parse(h.storage.get('sainsDesktopDraftQueue')).length, 1);
});

test('duplicate add becomes update only after Yes; it never appends a second row', async () => {
  const h = harness([{ 'NO ADUAN': 'PD-2', 'CATATAN': 'pelayan' }]);
  await h.context.window.sendDesktopMutation('addData', { 'NO ADUAN': 'PD-2', 'CATATAN': 'komputer' });
  h.online();
  const pending = h.context.window.sainsDesktopAutoSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.dialogs[0]);
  h.dialogs[0].children[0].children[4].listeners.click();
  await pending;
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].action, 'updateData');
});

test('an online duplicate requires approval before updating instead of appending', async () => {
  const h = harness([{ 'NO ADUAN': 'PD-2', 'CATATAN': 'pelayan' }]);
  h.online();
  const pending = h.context.window.sendDesktopMutation('addData', { 'NO ADUAN': 'PD-2', 'CATATAN': 'komputer' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.writes.length, 0);
  h.dialogs[0].children[0].children[5].listeners.click();
  await pending;
  assert.equal(h.writes.length, 0);
});

test('two duplicate server rows cannot be overwritten from desktop', async () => {
  const h = harness([{ 'NO ADUAN': 'PD-2' }, { 'NO ADUAN': 'PD-2' }]);
  await h.context.window.sendDesktopMutation('addData', { 'NO ADUAN': 'PD-2', 'CATATAN': 'draf' });
  h.online();
  const pending = h.context.window.sainsDesktopAutoSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.dialogs[0].children[0].children[4].disabled, true);
  h.dialogs[0].children[0].children[5].listeners.click();
  await pending;
  assert.equal(h.writes.length, 0);
});
