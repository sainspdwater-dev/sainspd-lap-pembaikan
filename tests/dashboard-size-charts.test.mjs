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

test('pipe-length chart includes all lengths and the chart rows are aligned by type',()=>{
  assert.match(html,/const dPanjang = countBy\('PANJANG PAIP \(M\)'\);/);
  assert.doesNotMatch(html,/const dPanjang = countBy\([^\n]+\.slice\(/);
  assert.match(html,/height:Math\.max\(256,dPanjang\.length\*38\)/);
  const pieRow=html.match(/<section[^>]+aria-label="Jenis paip rosak dan paip baru"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  const barRow=html.match(/<section[^>]+aria-label="Saiz dan panjang paip"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(pieRow&&barRow);
  for(const id of ['chart-jenis-paip','chart-jenis-baru'])assert.ok(pieRow.includes(`id="${id}"`));
  for(const id of ['chart-saiz-paip','chart-saiz-baru','chart-panjang-paip'])assert.ok(barRow.includes(`id="${id}"`));
});
