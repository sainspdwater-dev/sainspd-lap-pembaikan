import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

for (const file of ['index.html', 'dashboard.html']) {
  test(`${file} inline JavaScript parses`, async () => {
    const html = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
    assert.ok(inline.length > 0);
    for (const source of inline) assert.doesNotThrow(() => new vm.Script(source));
  });
}
