import test from 'node:test';
import assert from 'node:assert/strict';
import {localMetres,lineCoordinates,makeAstraMapState} from '../astra-map-core.mjs';

test('local WGS84 conversion preserves origin and east/north signs',()=>{
  assert.deepEqual(localMetres(101.95,2.47,101.95,2.47),{x:0,y:0});
  const east=localMetres(101.951,2.47,101.95,2.47);
  const north=localMetres(101.95,2.471,101.95,2.47);
  assert.ok(east.x>110&&east.x<112);
  assert.ok(north.y>111&&north.y<112);
  assert.equal(east.y,0);
});

test('GIS line collections preserve original coordinate arrays',()=>{
  const geometry={type:'MultiLineString',coordinates:[[[101.95,2.47],[101.96,2.48]],[[101.97,2.49],[101.98,2.5]]]};
  assert.deepEqual(lineCoordinates(geometry),geometry.coordinates);
  assert.equal(lineCoordinates(geometry).length,2);
});

test('canonical ASTRA map state contains all selection and analysis fields',()=>{
  const state=makeAstraMapState();
  assert.equal(state.engine,'leaflet');
  for(const key of ['selectedPipeId','selectedNodeId','selectedValveId','selectedDma',
    'selectedPosition','visibleLayers','activeScenario','selectedModelId','selectedRunId',
    'observations','reserve','leakCandidates','leafletViewport'])assert.ok(key in state,key);
});
