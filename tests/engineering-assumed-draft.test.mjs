import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEngineeringRow} from '../engineering-intake.mjs';

const context={modelId:'SAINS-DMA-EXAMPLE',version:1,enteredBy:'admin-test'};
const row={entity_type:'PIPE',entity_id:'N2000372735',parameter:'diameter_mm',value:'300',unit:'mm',
  classification:'ASSUMED',source_ref:'Operator estimate pending asset review',
  effective_at:'2026-09-28T09:00:00+08:00',notes:'TEST EXAMPLE; no source document yet',review_status:'DRAFT'};

test('a labelled assumption can be saved only as a sourced draft, not verified data',()=>{
  const accepted=validateEngineeringRow(row,context);
  assert.equal(accepted.valid,true);
  assert.equal(accepted.record.classification,'ASSUMED');
  assert.equal(accepted.record.reviewStatus,'DRAFT');
  assert.equal(validateEngineeringRow({...row,source_ref:''},context).valid,false);
  assert.equal(validateEngineeringRow({...row,review_status:'APPROVED'},context).valid,false);
});
