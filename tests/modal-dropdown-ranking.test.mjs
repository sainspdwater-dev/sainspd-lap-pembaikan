import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');

test('all Add/Edit datalist comboboxes rank matches without removing other options',()=>{
  assert.match(html,/const inputs = modal\.querySelectorAll\('input\[list\]'\)/);
  assert.match(html,/const all = rankedOptions\(filter\)/);
  assert.match(html,/if \(name === query\) return 0/);
  assert.match(html,/if \(name\.startsWith\(query\)\) return 1/);
  assert.match(html,/if \(name\.includes\(query\)\) return 3/);
  assert.match(html,/return 4/);
  assert.match(html,/\.sort\(\(a, b\) => score\(a\.value\) - score\(b\.value\) \|\| a\.index - b\.index\)/);
  assert.match(html,/panel\.scrollTop = 0/);
  assert.doesNotMatch(html,/getOptions\(\)\.filter\(.*includes\(query\)/);
});
