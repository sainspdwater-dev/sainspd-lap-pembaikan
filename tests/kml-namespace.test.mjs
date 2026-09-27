import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareKmlXml} from '../kml-namespace.mjs';

test('repairs only missing xsi namespace in memory',()=>{
  const original='<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document xsi:schemaLocation="schema"><Placemark/></Document></kml>';
  const prepared=prepareKmlXml(original);
  assert.match(prepared.xml,/<kml[^>]*xmlns:xsi="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"/);
  assert.match(prepared.repairNote,/fail asal tidak diubah/);
  assert.equal(original.includes('xmlns:xsi'),false);
  assert.equal(prepareKmlXml(prepared.xml).xml,prepared.xml);
});

test('does not mask unrelated invalid KML',()=>{
  const invalid='<kml><Document><bad></Document></kml>';
  assert.deepEqual(prepareKmlXml(invalid),{xml:invalid,repairNote:''});
});
