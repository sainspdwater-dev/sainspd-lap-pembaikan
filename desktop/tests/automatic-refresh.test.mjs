import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../offline-dashboard.js', import.meta.url), 'utf8');
const start = source.indexOf('  function refreshAutomatically(force = false) {');
const end = source.indexOf("\n  document.addEventListener('DOMContentLoaded'", start);
assert.ok(start >= 0 && end > start);
const functionSource = source.slice(start, end);

test('rapid focus changes do not repeatedly rebuild dashboard data', async () => {
  let now = 1_000_000;
  let hidden = false;
  let refreshes = 0;
  let syncs = 0;
  let queue = [];
  const context = {
    Date: { now: () => now },
    document: { get hidden() { return hidden; } },
    isOfflineSession: () => false,
    getQueue: () => queue,
    syncing: false,
    lastAutomaticRefresh: now,
    lastAutomaticSync: 0,
    automaticRefreshPending: false,
    window: { sainsDesktopAutoSync: async () => { syncs++; } },
    fetchFreshData: async () => { refreshes++; },
    console,
    Promise
  };
  vm.runInNewContext(`${functionSource}\nglobalThis.runRefresh = refreshAutomatically;`, context);
  context.runRefresh();
  assert.equal(refreshes, 0, 'initial focus should use the already-loaded dashboard');
  now += 2 * 60_000 + 1;
  context.runRefresh();
  context.runRefresh();
  context.runRefresh();
  assert.equal(refreshes, 1);
  await new Promise(resolve => setImmediate(resolve));
  now += 30_000;
  context.runRefresh();
  assert.equal(refreshes, 1);
  hidden = true;
  now += 2 * 60_000;
  context.runRefresh();
  assert.equal(refreshes, 1);
  context.runRefresh(true);
  assert.equal(refreshes, 2, 'reconnection may refresh even while minimized');
  await new Promise(resolve => setImmediate(resolve));
  hidden = false;
  queue = [{ noAduan: 'PD-1' }];
  context.runRefresh();
  context.runRefresh();
  assert.equal(syncs, 1);
  now += 60_001;
  context.runRefresh();
  assert.equal(syncs, 2);
});
