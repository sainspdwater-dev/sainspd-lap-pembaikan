import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEngineeringRow,previewEngineeringRows} from '../staging-site/engineering-intake.mjs';

const context={modelId:'SAINS-PD-CANDIDATE',version:1,enteredBy:'engineer-reviewer'};
const pipe={entity_type:'PIPE',entity_id:'SOURCE-SEGMENT-1',parameter:'diameter_mm',value:'300',unit:'mm',
  classification:'VERIFIED',source_ref:'as-built:sheet-42',effective_at:'2026-09-01T00:00:00+08:00',notes:''};
test('engineering import is a DRAFT preview, not an approval or persistence step',()=>{
  const row=validateEngineeringRow(pipe,context);
  assert.equal(row.valid,true);
  assert.equal(row.record.reviewStatus,'DRAFT');
  assert.equal(row.record.isTestData,false);
  assert.equal(previewEngineeringRows([pipe],context).persisted,false);
});
test('missing evidence, inferred length, unallocated demand and invented Pipe ID are blocked',()=>{
  assert.equal(validateEngineeringRow({...pipe,source_ref:''},context).valid,false);
  assert.equal(validateEngineeringRow({...pipe,parameter:'length_m',unit:'m',source_ref:'GEOMETRY_DERIVED:kml'},context).valid,false);
  assert.equal(validateEngineeringRow({...pipe,parameter:'pipe_id',unit:'TEXT',value:'P123',source_ref:'nearby pipe'},context).valid,false);
  assert.equal(validateEngineeringRow({...pipe,entity_type:'NODE',parameter:'base_demand_m3s',unit:'m3/s',value:'0.1'},context).valid,false);
  assert.equal(validateEngineeringRow({...pipe,parameter:'hazen_c',unit:'1',value:'120',classification:'ASSUMED'},context).valid,false);
  assert.equal(validateEngineeringRow(pipe,{...context,modelId:'TEST-REFERENCE-LOOP'}).valid,false);
});
test('MISSING is explicit and has no fabricated value',()=>{
  const row=validateEngineeringRow({...pipe,classification:'MISSING',value:'',source_ref:''},context);
  assert.equal(row.valid,true);
  assert.equal(validateEngineeringRow({...pipe,classification:'MISSING'},context).valid,false);
});
