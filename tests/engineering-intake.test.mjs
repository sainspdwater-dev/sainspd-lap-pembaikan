import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateEngineeringRow,previewEngineeringRows,definitions,IMPORT_COLUMNS} from '../staging-site/engineering-intake.mjs';

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
test('downloadable engineering template matches accepted schema without fabricated values',()=>{
  const csv=readFileSync(new URL('../staging-site/engineering-template.csv',import.meta.url),'utf8').trim().split(/\r?\n/);
  assert.deepEqual(csv[0].split(','),IMPORT_COLUMNS);
  const parameterRows=csv.slice(1).map(line=>Object.fromEntries(IMPORT_COLUMNS.map((key,index)=>[key,line.split(',')[index]||''])));
  assert.ok(parameterRows.every(row=>definitions[row.entity_type]?.[row.parameter]===row.unit));
  assert.ok(parameterRows.every(row=>row.value===''&&row.entity_id===''&&row.review_status==='DRAFT'));
  assert.equal(validateEngineeringRow({...pipe,review_status:'APPROVED'},context).valid,false);
});
test('existing AI Agent exposes selected-DMA Auto-Fill and visible manual DRAFT controls',()=>{
  const html=readFileSync(new URL('../staging-site/dashboard.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('../staging-site/engineering-intake.mjs',import.meta.url),'utf8');
  for(const id of ['ai-filter-district','ai-eng-autofill','ai-eng-preview-autofill','ai-eng-autofill-report',
    'ai-eng-entity-type','ai-eng-entity-id','ai-eng-parameter','ai-eng-value','ai-eng-unit',
    'ai-eng-classification','ai-eng-source','ai-eng-effective','ai-eng-notes','ai-eng-preview-manual',
    'ai-eng-save','ai-eng-cancel','ai-eng-confirm'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Review Status: <strong>DRAFT<\/strong>/);
  assert.match(script,/const selectedDma=\(\)=>byId\('ai-filter-district'\)/);
  assert.match(script,/definitions\[type\]/);
  assert.match(script,/sourceSha256='';await preview\(autoFill\.candidates/);
  assert.match(script,/window\.phase2bRefreshHydraulic\?\.\(\)/);
});
