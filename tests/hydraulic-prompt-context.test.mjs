import test from 'node:test';
import assert from 'node:assert/strict';
import {attachHydraulicPromptContext} from '../worker/hydraulic-prompt-context.js';
import {buildOperationalAnalysis} from '../worker/worker.js';

test('all-DMA operational prompt cannot imply a ready hydraulic model',async()=>{
  const response={status:'success',evidence:[{source:'operational',record_count:2}]};
  await attachHydraulicPromptContext(response,null,'');
  assert.equal(response.hydraulicContext.scope,'NO_DMA');
  assert.equal(response.hydraulicContext.simulation,'DISABLED');
  assert.equal(response.evidence.length,1);
});

test('unavailable D1 fails closed without changing operational evidence',async()=>{
  const response={status:'success',answer:'Historical result',evidence:[]};
  await attachHydraulicPromptContext(response,null,'300mm Bukit Kuau lama');
  assert.equal(response.hydraulicContext.baseline,'NOT_READY');
  assert.equal(response.hydraulicContext.simulation,'DISABLED');
  assert.equal(response.answer,'Historical result');
});

test('D1 failure never fabricates readiness or simulation',async()=>{
  const response={status:'success'};
  const db={prepare(){throw new Error('D1 unavailable');}};
  await attachHydraulicPromptContext(response,db,'300mm Bukit Kuau lama');
  assert.equal(response.hydraulicContext.baseline,'NOT_READY');
  assert.equal(response.hydraulicContext.simulation,'DISABLED');
});

test('selected DMA does not borrow another DMA incident on missing match',()=>{
  const records=[{'KATEGORI':'Paip Bocor','District Metered Area':'300mm Bukit Kuau Baru',
    'LOKASI':'Jalan Baru','TARIKH TERIMA':'01/09/2026'}];
  const result=buildOperationalAnalysis(records,{dma:'300mm Bukit Kuau lama'},'Hotspot Paip Pecah');
  assert.equal(result.metrics[0].value,0);
  assert.match(result.findings.join(' '),/tidak dipinjam/);
});

test('missing DMA history is not reported as a zero-case forecast',()=>{
  const result=buildOperationalAnalysis([],{dma:'300mm Bukit Kuau lama'},'Ramalan paip pecah');
  assert.equal(result.metrics[0].value,'N/A');
  assert.match(result.answer,/belum boleh dikira/);
  assert.equal(result.calculations.length,0);
});
