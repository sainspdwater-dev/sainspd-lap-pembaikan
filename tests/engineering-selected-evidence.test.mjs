import test from 'node:test';
import assert from 'node:assert/strict';
import {exactAutoFillCandidate} from '../engineering-intake.mjs';

test('auto-fill suggestion is restricted to the exact asset and parameter',()=>{
  const autoFill={candidates:[
    {entity_type:'PIPE',entity_id:'N2000372736',parameter:'diameter_mm',value:'150'},
    {entity_type:'PIPE',entity_id:'N2000372735',parameter:'pipe_id',value:'N2000372735'}
  ]};
  assert.equal(exactAutoFillCandidate(autoFill,'PIPE','N2000372735','diameter_mm'),null);
  assert.equal(exactAutoFillCandidate(autoFill,'PIPE',' n2000372736 ','diameter_mm')?.value,'150');
  assert.equal(exactAutoFillCandidate(autoFill,'NODE','N2000372736','diameter_mm'),null);
});
