import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');

test('both pipe-size charts include every category in the filtered rows',()=>{
  assert.match(html,/const dSaizPaip = countBy\('SAIZ PAIP'\);/);
  assert.match(html,/const dSaizBaru = countBy\('SAIZ'\);/);
  assert.doesNotMatch(html,/const dSaiz(?:Paip|Baru) = countBy\([^\n]+\.slice\(/);
  assert.match(html,/chart-saiz-paip-summary/);
  assert.match(html,/chart-saiz-baru-summary/);
  assert.match(html,/height:Math\.max\(256,dSaizPaip\.length\*38\)/);
  assert.match(html,/height:Math\.max\(256,dSaizBaru\.length\*38\)/);
});
