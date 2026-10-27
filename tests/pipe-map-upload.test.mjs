import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const upload=readFileSync(new URL('../pipe-map-upload.mjs',import.meta.url),'utf8');

test('dedicated ADMIN KML line tab requires preview and explicit replacement confirmation',()=>{
  for(const id of ['nav-pipe-upload','pipe-upload-content','pipe-upload-file','pipe-upload-preview',
    'pipe-upload-map','pipe-upload-confirm','pipe-upload-replace'])
    assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/pipe-map-upload\.mjs/);
  assert.match(upload,/file\.name\.toLowerCase\(\)\.endsWith\('\.kml'\)/);
  assert.match(upload,/GANTI JAJARAN/);
  assert.match(upload,/previewPipeClip\(features,polygons/);
  assert.match(upload,/confirmReplace:true/);
  assert.match(upload,/polygonIn\(feature\.geometry\)/);
});

test('KML replacement is map-only and does not silently unlock hydraulic model',()=>{
  assert.match(upload,/activatePipeMapDraft/);
  assert.doesNotMatch(upload,/runBaseline|approveHydraulic|pipe_network_active/);
  assert.match(html,/Clip KML untuk paparan sahaja/);
});
