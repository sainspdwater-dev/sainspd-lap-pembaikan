import test from 'node:test';
import assert from 'node:assert/strict';
import {featureLines,extentOfLines,safeLeafletBbox} from '../gis-view-core.mjs';

test('GIS context keeps only valid polygon and pipe coordinates',()=>{
  const features=[{geometry:{type:'Polygon',coordinates:[[[101.7,2.4],[101.8,2.4],[101.7,2.4]]]},properties:{name:'DMA'}},
    {geometry:{type:'LineString',coordinates:[[101.75,2.45],[101.77,2.46]]},properties:{asset_num:'PIPE-1'}},
    {geometry:{type:'LineString',coordinates:[[999,2.5],[101.8,2.5]]}}];
  const lines=featureLines(features);
  assert.equal(lines.length,2);
  assert.deepEqual(extentOfLines(lines),{west:101.7,south:2.4,east:101.8,north:2.46});
});

test('Leaflet world-wrapped bounds are clipped to valid WGS84',()=>{
  const bounds={getWest:()=>-189,getEast:()=>190,getSouth:()=>-95,getNorth:()=>95};
  assert.equal(safeLeafletBbox(bounds),'-180,-90,180,90');
  assert.equal(safeLeafletBbox({...bounds,getWest:()=>190}),null);
});
