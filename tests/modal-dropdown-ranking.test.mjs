import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');

test('all Add/Edit datalist comboboxes rank matches without removing other options',()=>{
  assert.match(html,/const inputs = modal\.querySelectorAll\('input\[list\]'\)/);
  assert.match(html,/const all = rankedOptions\(filter\)/);
  assert.match(html,/if \(name === query\) return 0/);
  assert.match(html,/if \(name\.startsWith\(query\)\) return 1/);
  assert.match(html,/if \(name\.includes\(query\)\) return 3/);
  assert.match(html,/return 4/);
  assert.match(html,/\.sort\(\(a, b\) => score\(a\.value\) - score\(b\.value\) \|\| a\.index - b\.index\)/);
  assert.match(html,/panel\.scrollTop = 0/);
  assert.doesNotMatch(html,/getOptions\(\)\.filter\(.*includes\(query\)/);
});

test('typed DMA rises to the top while unmatched options stay visible',()=>{
  const start=html.indexOf('function rankedOptions(filter) {');
  const end=html.indexOf('// === FUNGSI RENDER DENGAN HIGHLIGHT ===',start);
  assert.ok(start>=0&&end>start);
  const options=['SIRUSA ZONE 1','SIRUSA ZONE 2','SIRUSA ZONE 3','SAWAH RAJA','BKT TUNGGAL'];
  const rank=runInNewContext(`${html.slice(start,end)}; rankedOptions`,{getOptions:()=>options});
  const ranked=Array.from(rank('sirusa zone 3'));
  assert.equal(ranked[0],'SIRUSA ZONE 3');
  assert.deepEqual(ranked.slice(1),['SIRUSA ZONE 1','SIRUSA ZONE 2','SAWAH RAJA','BKT TUNGGAL']);
  assert.deepEqual(Array.from(rank('')),options);
});
