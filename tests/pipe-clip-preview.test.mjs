import test from 'node:test';
import assert from 'node:assert/strict';
import {clipLineToPolygon,previewPipeClip,clipAuditCsv,hasPipeLine} from '../pipe-clip-preview.mjs';

const square=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
const zone=(name,ring)=>({name,feature:{type:'Feature',properties:{name},
  geometry:{type:'Polygon',coordinates:[ring]}}});
const line=(coords,id,diameter)=>({type:'Feature',properties:{name:id,PIPESIZE:diameter},
  geometry:{type:'LineString',coordinates:coords}});

test('exactly clips a line at DMA boundary without assigning outside part',()=>{
  const result=clipLineToPolygon([[-5,5],[15,5]],[square(0,0,10,10)]);
  assert.deepEqual(result,[[[0,5],[10,5]]]);
});

test('splits a line around an interior hole',()=>{
  const result=clipLineToPolygon([[-5,5],[15,5]],
    [square(0,0,10,10),square(4,4,6,6)]);
  assert.deepEqual(result,[[[0,5],[4,5]],[[6,5],[10,5]]]);
});

test('all-DMA preview reports unidentified assets and overlapping membership separately',async()=>{
  const result=await previewPipeClip([
    line([[-5,5],[15,5]],'P-1','300'),
    line([[2,2],[3,3]],'',null),
    line([[30,30],[31,31]],'P-OUT','100')
  ],[zone('DMA A',square(0,0,10,10)),zone('DMA B',square(8,0,20,10))]);
  assert.equal(result.sourceLines,3);
  assert.equal(result.outsideLines,1);
  assert.equal(result.multiDmaLines,1);
  assert.equal(result.zones[0].partCount,2);
  assert.equal(result.zones[0].noIdParts,1);
  assert.equal(result.zones[0].noDiameterParts,1);
  assert.equal(result.zones[0].sourceCount,1);
  assert.equal(result.zones[1].partCount,1);
  assert.equal(result.zones[1].sourceCount,1);
  assert.equal(result.stagedParts.length,3);
  assert.deepEqual(result.stagedParts.map(part=>part.rowNumber),[0,1,2]);
});

test('invalid WGS84 line is counted, not treated as a DMA segment',async()=>{
  const result=await previewPipeClip([line([[200,1],[201,1]],'bad','300')],
    [zone('DMA A',square(0,0,10,10))]);
  assert.equal(result.invalidGeometry,1);
  assert.equal(result.sourceLines,0);
  assert.equal(result.zones[0].partCount,0);
});

test('identical polygon features in one DMA do not double-stage the same pipe',async()=>{
  const boundary=zone('DMA A',square(0,0,10,10));
  const result=await previewPipeClip([line([[1,5],[9,5]],'P-1','300')],
    [boundary,structuredClone(boundary)]);
  assert.equal(result.duplicatePolygons,1);
  assert.equal(result.zones[0].partCount,1);
  assert.equal(result.stagedParts.length,1);
});

test('KML table description supplies diameter when no direct field exists',async()=>{
  const feature=line([[1,1],[2,2]],'P-2',null);
  delete feature.properties.PIPESIZE;
  feature.properties.description='<table><tr><td>PIPESIZE</td><td>300</td></tr></table>';
  const result=await previewPipeClip([feature],[zone('DMA A',square(0,0,10,10))]);
  assert.equal(result.zones[0].noDiameterParts,0);
});

test('KML MultiGeometry line remains visible to preview and clip',async()=>{
  const feature={type:'Feature',properties:{name:'KML-MULTI'},geometry:{type:'GeometryCollection',
    geometries:[{type:'Point',coordinates:[2,2]},
      {type:'MultiLineString',coordinates:[[[1,1],[2,2]],[[3,3],[4,4]]]}]}};
  assert.equal(hasPipeLine(feature),true);
  const result=await previewPipeClip([feature],[zone('DMA A',square(0,0,10,10))]);
  assert.equal(result.sourceLines,2);
  assert.equal(result.stagedParts.length,2);
});

test('downloadable audit includes file identity and neutralizes spreadsheet formulas',()=>{
  const csv=clipAuditCsv({outsideLines:1,multiDmaLines:2,zones:[{name:'=unsafe',partCount:3,
    sourceCount:2,lengthM:500,noIdParts:1,noDiameterParts:1}]},
    {sourceName:'network.kml',sourceSha256:'ab12',polygonSha256:'cd34',
      sourceNormalization:'missing xmlns:xsi repaired in memory',createdAt:'2026-09-27T00:00:00Z'});
  assert.match(csv,/source_sha256/);
  assert.match(csv,/ab12/);
  assert.match(csv,/polygon_sha256/);
  assert.match(csv,/cd34/);
  assert.match(csv,/source_normalization/);
  assert.match(csv,/duplicate_polygons_skipped/);
  assert.match(csv,/missing xmlns:xsi repaired in memory/);
  assert.match(csv,/"'=unsafe"/);
  assert.match(csv,/,"0.500",/);
});

test('unclosed DMA polygon fails rather than generating a misleading clip',async()=>{
  await assert.rejects(previewPipeClip([line([[1,1],[2,2]],'P-1','300')],
    [zone('DMA A',[[0,0],[10,0],[10,10],[0,10]])]),/tidak tertutup/);
});
