import test from 'node:test';
import assert from 'node:assert/strict';
import {formatMapCoordinate} from '../ai-map-capture.mjs';

test('map coordinate capture formats WGS84 without generating a pressure value',()=>{
  assert.equal(formatMapCoordinate(2.42512349,101.95061749),'2.425123, 101.950617');
  assert.throws(()=>formatMapCoordinate(200,101),/WGS84/);
});
