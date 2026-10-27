import test from 'node:test';
import assert from 'node:assert/strict';
import {planAstraTestCommand} from '../astra-command-core.mjs';

test('explicit synthetic asset selects bounded TEST tools without inventing values',()=>{
  const p=planAstraTestCommand('ASTRA, analisis SYNTH-S5-900. Flow 1500m3/h, average pressure 3bar. Buat hydraulic modelling, calibration, reserve margin, leakage investigation dan 3D.');
  assert.equal(p.exactPipe,'SYNTH-S5-900');
  assert.deepEqual([p.requested.model,p.requested.calibration,p.requested.reserve,p.requested.leak,p.requested.map3d],[true,true,true,true,true]);
  assert.equal(p.basic.flow,1500);assert.equal(p.basic.pressure,3);
  assert.equal(p.basic.diameterMm,null);
  assert.match(p.missing.join(' '),/diameter/);
});
test('ambiguous area never silently resolves to a synthetic Pipe ID',()=>{
  const p=planAstraTestCommand('ASTRA, kalibrasi 900mm Sirusa 5');
  assert.equal(p.exactPipe,null);assert.match(p.missing.join(' '),/Pipe ID TEST tepat/);
});
test('no invented analysis from unsupported natural language',()=>{
  const p=planAstraTestCommand('Sila tunjukkan laporan');
  assert.deepEqual(Object.values(p.requested),[false,false,false,false,false,false]);
});
