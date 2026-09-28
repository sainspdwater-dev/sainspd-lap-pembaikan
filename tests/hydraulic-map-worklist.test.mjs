import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../phase2b-ui.js',import.meta.url),'utf8');
const intake=readFileSync(new URL('../engineering-intake.mjs',import.meta.url),'utf8');

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

test('manual PIPE record can locate its exact ID on the selected DMA map',()=>{
  assert.match(html,/id="ai-eng-show-pipe-map"/);
  assert.match(html,/id="ai-eng-pipe-map-status"/);
  assert.match(html,/id="ai-map-pipe-target"/);
  assert.match(script,/feature\.properties\?\.asset_num\|\|''\)\.trim\(\)===asset/);
  assert.match(script,/Pipe ID.*tiada padanan garisan yang disahkan/);
  assert.match(script,/Garisan ungu ialah lokasi calon, bukan bukti diameter\/panjang kejuruteraan/);
  assert.match(script,/byId\('ai-eng-show-pipe-map'\)\?\.addEventListener\('click',showExactPipe\)/);
});

test('new hydraulic targets clear stale values and never default to VERIFIED',()=>{
  assert.match(html,/id="ai-eng-classification"[^>]*><option value="" selected disabled>/);
  assert.match(intake,/const clearValueForNewTarget=\(\)=>/);
  assert.match(intake,/byId\('ai-eng-entity-id'\)\?\.addEventListener\('input',\(\)=>\{clearValueForNewTarget\(\)/);
  assert.match(intake,/Head sumber\/reservoir \(m\) bukan bacaan pressure gauge \(bar\) secara terus/);
});

test('plain guide distinguishes existing GIS data from a runnable SAINS baseline',()=>{
  assert.match(html,/id="ai-baseline-plain"/);
  assert.match(html,/1\. Baca data sedia ada/);
  assert.match(html,/id="ai-technical-missing"/);
  assert.match(html,/id="ai-run-real-baseline" disabled[^>]*>Run Baseline SAINS — belum tersedia/);
  assert.match(script,/Data GIS\/calon bukan model hidraulik yang sudah diluluskan/);
  assert.match(script,/Run Baseline SAINS masih belum disambung kepada simulasi produksi/);
});
