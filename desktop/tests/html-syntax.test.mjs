import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

for (const file of ['index.html', 'dashboard.html']) {
  test(`${file} inline JavaScript parses`, async () => {
    const html = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const inline = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(match => match[2].trim());
    assert.ok(inline.length > 0);
    for (const [, attributes, source] of inline) {
      if (/\btype=["']importmap["']/i.test(attributes)) {
        assert.doesNotThrow(() => JSON.parse(source));
      } else {
        assert.doesNotThrow(() => new vm.Script(source));
      }
    }
  });
}
