import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateBasicHydraulics,detectFieldColumns,mapFieldRows,normalizeFieldObservation,
  parseFieldCsv,pressureToKpa,flowToM3s,distanceToM,inferPressureUnitFromHeader,
  extractBasicInputsFromCommand} from '../astra-field-core.mjs';

test('900 mm, 1500 m3/h, 3 bar gauge: deterministic reference values',()=>{
  assert.deepEqual(extractBasicInputsFromCommand('ASTRA, analisis paip 900mm Sirusa 5. Flow 1500 m3/h, average pressure 3 bar.'),
    {diameterMm:900,assetQuery:'Sirusa 5',flow:1500,flowUnit:'m3/h',pressure:3,pressureUnit:'bar'});
  const result=calculateBasicHydraulics({diameterMm:900,flow:1500,flowUnit:'m3/h',pressure:3,pressureUnit:'bar'});
  assert.ok(Math.abs(result.flowM3s-0.4166666667)<1e-9);
  assert.ok(Math.abs(result.flowLs-416.6667)<1e-3);
  assert.ok(Math.abs(result.flowMld-36)<1e-9);
  assert.ok(Math.abs(result.areaM2-0.6361725)<1e-6);
  assert.ok(Math.abs(result.velocityMs-0.65494)<1e-4);
  assert.ok(Math.abs(result.pressureHeadM-30.5915)<0.01);
  assert.equal(result.diameterBasis,'NOMINAL_ASSUMED_INTERNAL');
});
test('units and physical types remain explicit',()=>{
  assert.ok(Math.abs(flowToM3s(36,'MLD')-0.4166666667)<1e-9);
  assert.ok(Math.abs(pressureToKpa(43.5113,'psi')-300)<0.01);
  assert.equal(distanceToM(1.5,'km'),1500);
  assert.throws(()=>distanceToM(1.5,'miles'),/Unit jarak/);
  assert.equal(inferPressureUnitFromHeader('Pressure Bar'),'bar');
  assert.equal(inferPressureUnitFromHeader('Tekanan'),null);
  assert.throws(()=>calculateBasicHydraulics({diameterMm:900,flow:1,flowUnit:'L/s',pressure:3,pressureUnit:'bar',pressureType:'ABSOLUTE'}),/gauge/);
  assert.throws(()=>pressureToKpa(3,''),/Unit/);
  assert.throws(()=>normalizeFieldObservation({latitude:2.4,longitude:101.8,pressure:3},
    {pressureUnit:'bar',pressureType:'PRESSURE_HEAD'}),/mesti dalam meter/);
});
test('quoted CSV, Malay headers and untimed observation',()=>{
  const rows=parseFieldCsv('Lat,Lng,Tekanan,Nota\n2.4,101.8,3,"Titik, depan sekolah"\n');
  const detected=detectFieldColumns(Object.keys(rows[0]));
  const result=mapFieldRows(rows,detected.mapping,{pressureUnit:'bar',pressureType:'GAUGE'});
  assert.equal(result.issues.length,0);
  assert.equal(result.observations[0].notes,'Titik, depan sekolah');
  assert.equal(result.observations[0].timeStatus,'UNTIMED');
  assert.equal(result.observations[0].qualityStatus,'PENDING_REVIEW');
  assert.equal(result.observations[0].matchStatus,'UNMATCHED');
});
test('separate local date/time, source values and flow units stay traceable',()=>{
  const rows=[{'GPS Latitude':'2.4501','GPS Longitude':'101.9102','Pressure Bar':'3',
    'Tarikh':'28/09/2026','Masa':'09:30','Aliran':'1500','Unit Aliran':'m3/h','ID Sensor':'CP-1'}];
  const detected=detectFieldColumns(Object.keys(rows[0]));
  const result=mapFieldRows(rows,detected.mapping,{pressureUnit:inferPressureUnitFromHeader(detected.mapping.pressure),
    pressureType:'GAUGE',timezone:'Asia/Kuala_Lumpur'});
  assert.deepEqual(result.issues,[]);
  const point=result.observations[0];
  assert.equal(point.originalPressure,3);
  assert.equal(point.originalPressureUnit,'bar');
  assert.equal(point.normalizedPressureKpa,300);
  assert.equal(point.originalFlow,1500);
  assert.ok(Math.abs(point.normalizedFlowM3s-0.4166666667)<1e-9);
  assert.equal(point.timestamp,'2026-09-28T01:30:00.000Z');
  assert.equal(point.timezone,'Asia/Kuala_Lumpur');
});
test('invalid coordinates, unknown unit, ambiguous mapping and bad calendar rejected',()=>{
  const defaults={pressureUnit:'bar',pressureType:'GAUGE'};
  assert.throws(()=>normalizeFieldObservation({latitude:91,longitude:101.8,pressure:3},defaults),/Latitude/);
  assert.throws(()=>normalizeFieldObservation({latitude:' ',longitude:101.8,pressure:3},defaults),/Latitude/);
  assert.throws(()=>normalizeFieldObservation({latitude:2.4,longitude:101.8,pressure:3,pressureType:'GAUGE'},{}),/Unit/);
  assert.deepEqual(detectFieldColumns(['Lat','Latitude','Lng','Pressure']).ambiguous,['latitude']);
  assert.throws(()=>normalizeFieldObservation({latitude:2.4,longitude:101.8,pressure:3,
    timestamp:'2026-02-30T09:30:00+08:00'},defaults),/kalendar/);
  assert.throws(()=>parseFieldCsv('Lat,Lng\n"2.4,101.8'),/tidak ditutup/);
});
