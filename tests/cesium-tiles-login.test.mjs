import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildingStyle, bindBuildingTiles} from '../cesium-tiles.mjs';

const login = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const tiles = readFileSync(new URL('../cesium-tiles.mjs', import.meta.url), 'utf8');

test('3D Tiles styles include color, metadata and category highlight', () => {
  assert.equal(buildingStyle('original'), undefined);
  assert.match(buildingStyle('blue').color, /#2563eb/);
  assert.match(buildingStyle('material').color.conditions[0][0], /building:material/);
  assert.match(buildingStyle('residential').color.conditions[0][0], /residential/);
  assert.match(buildingStyle('office').color.conditions[0][0], /commercial/);
  assert.throws(() => buildingStyle('unknown'));
});

test('both Cesium maps expose a style dropdown backed by authenticated OSM 3D Tiles', () => {
  assert.match(dashboard, /id="dashboard-cesium-tiles-controls"/);
  assert.match(dashboard, /id="astra-cesium-tiles-controls"/);
  assert.equal((dashboard.match(/data-tiles-style/g) || []).length, 2);
  assert.match(tiles, /IonResource\.fromAssetId\(96188, \{accessToken\}\)/);
  assert.match(tiles, /Cesium3DTileset\.fromUrl\(resource\)/);
  assert.doesNotMatch(tiles, /Ion\.defaultAccessToken\s*=/);
  assert.match(tiles, /token\.value = ''/);
});

test('3D Tiles loader applies actual Cesium3DTileStyle and clears the token input', async () => {
  const style = new EventTarget(); style.value = 'residential';
  const token = {value: 'test-read-only-token', focus() {}};
  const load = new EventTarget(); load.disabled = false;
  const message = {textContent: ''};
  const controls = {querySelector(selector) {
    return {'[data-tiles-style]': style, '[data-tiles-token]': token,
      '[data-tiles-load]': load, '[data-tiles-status]': message}[selector];
  }};
  const tileset = {style: null, tileFailed: {addEventListener() {}}, destroy() {}};
  const C = {
    IonResource: {fromAssetId: async (id, options) => {assert.equal(id, 96188);
      assert.equal(options.accessToken, 'test-read-only-token'); return 'resource';}},
    Cesium3DTileset: {fromUrl: async resource => {assert.equal(resource, 'resource'); return tileset;}},
    Cesium3DTileStyle: class {constructor(definition) {this.definition = definition;}},
  };
  const viewer = {isDestroyed: () => false, scene: {primitives: {add: tile => tile}}};
  const controller = bindBuildingTiles(C, viewer, controls);
  load.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(token.value, '');
  assert.match(tileset.style.definition.color.conditions[0][0], /residential/);
  style.value = 'blue'; style.dispatchEvent(new Event('change'));
  assert.match(tileset.style.definition.color, /#2563eb/);
  controller.destroy();
});

test('login keeps only 8-hour absolute expiry and never saves password in localStorage', () => {
  assert.match(dashboard, /const absoluteLimit = 8 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(dashboard, /const idleLimit = 2 \* 60 \* 60 \* 1000/);
  assert.match(login, /autocomplete="username"/);
  assert.match(login, /autocomplete="current-password"/);
  assert.match(login, /id="rememberMe"/);
  assert.match(login, /navigator\.credentials\.store\(new PasswordCredential/);
  assert.doesNotMatch(login, /localStorage\.setItem\([^,]*(?:password|pass|credential)/i);
});

test('legacy 2-hour inactivity no longer logs out, but elapsed 8-hour session does', () => {
  const source = dashboard.match(/function initSessionTimeouts\(\) \{[\s\S]*?\n        \}/)?.[0];
  assert.ok(source);
  const now = 10 * 60 * 60 * 1000;
  const store = new Map([['sainsSessionStart', String(now - 3 * 60 * 60 * 1000)],
    ['sainsLastActivity', String(now - 3 * 60 * 60 * 1000)]]);
  const localStorage = {getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key)};
  const loggedOut = [];
  const init = Function('localStorage', 'Date', 'setInterval', 'safeLogout',
    `${source}; return initSessionTimeouts;`)(localStorage, {now: () => now}, () => {},
    reason => loggedOut.push(reason));
  init();
  assert.deepEqual(loggedOut, []);
  assert.equal(store.has('sainsLastActivity'), false);
  store.set('sainsSessionStart', String(now - 8 * 60 * 60 * 1000 - 1));
  init();
  assert.match(loggedOut[0], /8 jam/);
});
