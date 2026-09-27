import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PROMPT_GUIDES} from '../ai-prompt-hydraulic-guide.mjs';

test('every existing AI chip has a distinct hydraulic evidence guide',()=>{
  const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
  const chips=html.match(/class="ai-chip /g)||[];
  assert.equal(chips.length,9);
  assert.equal(PROMPT_GUIDES.length,chips.length);
  assert.equal(new Set(PROMPT_GUIDES.map(item=>item.name)).size,chips.length);
  for(const item of PROMPT_GUIDES){
    assert.ok(item.purpose&&item.sources&&item.hydraulic);
    assert.match(html,new RegExp(item.name));
  }
  assert.match(html,/id="ai-prompt-guide-readiness"/);
  assert.match(html,/hydraulicContextHtml/);
  assert.match(html,/ai-prompt-hydraulic-guide\.mjs/);
  assert.match(html,/id="ai-pipe-clip-preview"/);
  assert.match(html,/id="ai-pipe-clip-audit" disabled/);
  assert.match(html,/id="ai-pipe-clip-stage" disabled/);
  assert.match(html,/pipe-clip-ui\.mjs/);
  assert.match(html,/layer\.toGeoJSON\(false\)/);
  const clipUi=readFileSync(new URL('../pipe-clip-ui.mjs',import.meta.url),'utf8');
  assert.match(clipUi,/beginPipeCandidateDraft/);
  assert.match(clipUi,/appendPipeCandidateParts/);
  assert.match(clipUi,/finalizePipeCandidateDraft/);
  const mapUi=readFileSync(new URL('../phase2b-ui.js',import.meta.url),'utf8');
  assert.match(mapUi,/Buka borang data paip/);
  assert.match(mapUi,/Sahkan Pipe ID, diameter dan sumber/);
});
