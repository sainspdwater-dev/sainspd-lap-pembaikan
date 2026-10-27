import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const astra=readFileSync(new URL('../astra-maps.mjs',import.meta.url),'utf8');
const dashboard=readFileSync(new URL('../dashboard-cesium.mjs',import.meta.url),'utf8');
const cesium=readFileSync(new URL('../gis-cesium.mjs',import.meta.url),'utf8');

test('Dashboard retains its Leaflet map and adds one lazy Cesium selector',()=>{
  assert.match(html,/id="map" class="w-full h-\[500px\]/);
  assert.match(html,/data-dashboard-map="leaflet" aria-pressed="true"/);
  assert.match(html,/data-dashboard-map="cesium" aria-pressed="false"/);
  assert.match(html,/id="dashboard-cesium-map" class="hidden/);
  assert.match(dashboard,/if\(next==='cesium'\)[\s\S]*await loadCesium\(\)/);
});

test('3D GIS views use real OSM imagery and canonical polygon/pipe context',()=>{
  assert.match(cesium,/OpenStreetMapImageryProvider/);
  assert.match(cesium,/tile\.openstreetmap\.org/);
  assert.match(astra,/window\.koleksiPoligonDMZ/);
  assert.match(astra,/window\.sainsPipeMapFeatures/);
  assert.match(dashboard,/sainsDashboardMapContext/);
  assert.match(astra,/Tiada geometri GIS tersedia/);
});

test('production cannot expose localhost-only ASTRA action panel',()=>{
  assert.match(html,/WORKER_URL !== 'http:\/\/127\.0\.0\.1:8787\/'/);
  assert.match(html,/astra3-command-center'\)\.classList\.add\('hidden'\)/);
  assert.match(html,/astra-legacy-prompt-panel'\)\.open = true/);
  assert.match(html,/location\.hostname\) &&[\s\S]*import\('\.\/astra-field-ui\.mjs'\)/);
  assert.doesNotMatch(html,/<script src="astra-field-ui\.mjs"/);
});
