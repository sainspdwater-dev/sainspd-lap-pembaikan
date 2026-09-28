import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../phase2b-ui.js',import.meta.url),'utf8');

test('DMA map worklist exposes issue-specific navigation and PRV capture',()=>{
  for(const id of ['ai-hydraulic-worklist','ai-issue-diameter','ai-issue-length','ai-issue-prv',
    'ai-issue-list','ai-issue-selected','ai-issue-open-form']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(script,/showIssues\('diameter'\)/);
  assert.match(script,/showIssues\('length'\)/);
  assert.match(script,/byId\('ai-pick-prv-map'\)\.click\(\)/);
  assert.match(script,/goToField\(selectedIssue\.kind\)/);
  assert.match(script,/if\(asset\).*input\.value=asset/);
});

test('map worklist keeps unverified geometry read-only and baseline locked',()=>{
  assert.match(script,/Peta tidak mengisi nilai secara automatik/);
  assert.match(script,/Panjang GIS bukan panjang kejuruteraan yang diluluskan/);
  assert.match(script,/Bilangan ini ialah bahagian GIS, bukan bilangan aset unik yang disahkan/);
  assert.match(script,/byId\('ai-run-real-baseline'\)\.disabled=true/);
  assert.doesNotMatch(script,/action:\s*['"](?:saveHydraulic|approveHydraulic|runHydraulic)/);
});
