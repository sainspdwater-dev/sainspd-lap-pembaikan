import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
const source=html.match(/function setInputValue\(id, val\) \{[\s\S]*?\r?\n        \}/)?.[0];
assert.ok(source,'edit modal input helper exists');

function editInputs(){
  const inputs=new Map(['m-dma','m-districtMeteredArea','m-zon'].map(id=>[id,{value:''}]));
  const document={getElementById:id=>inputs.get(id)};
  const parentFolders=['loji linggi','sawah raja','seremban barat'];
  const setInputValue=Function('document','parentFolders',`${source}; return setInputValue;`)(document,parentFolders);
  return {inputs,setInputValue};
}

test('Pengurusan Data edit retains Sawah Raja as DMA after reopening',()=>{
  const {inputs,setInputValue}=editInputs();
  setInputValue('m-dma','SAWAH RAJA');
  assert.equal(inputs.get('m-dma').value,'SAWAH RAJA');
  setInputValue('m-dma','Sawah Raja');
  assert.equal(inputs.get('m-dma').value,'Sawah Raja');
  assert.match(html,/setInputValue\('m-dma', rowData\['DMA'\] \|\| ''\)/);
  assert.match(html,/const dma = document\.getElementById\('m-dma'\)\.value/);
});

test('polygon folder remains excluded only from District Metered Area, not DMA',()=>{
  const {inputs,setInputValue}=editInputs();
  setInputValue('m-districtMeteredArea','Sawah Raja');
  assert.equal(inputs.get('m-districtMeteredArea').value,'');
  setInputValue('m-dma','SEREMBAN BARAT');
  assert.equal(inputs.get('m-dma').value,'SEREMBAN BARAT');
});

test('CRO Key In preserves the typed DMA on both row display and save',()=>{
  assert.match(html,/class="excel-input cro-dma" list="list-dma" value="\$\{escapeHTML\(row\['DMA'\]\|\|''\)\}"/);
  assert.match(html,/"DMA": tr\.querySelector\('\.cro-dma'\)\.value/);
  assert.doesNotMatch(html,/"DMA":\s*districtAreaVal/);
});
