import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../update-ui.js', import.meta.url), 'utf8');

test('a published newer version is visible at the top and opens only on request', async () => {
  let onReady;
  let opened = 0;
  let wrapper;
  const element = () => ({
    hidden: false, style: {}, children: [], events: {}, textContent: '',
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, handler) { this.events[name] = handler; },
    before(child) { wrapper = child; }
  });
  const menu = element();
  const document = {
    addEventListener(name, handler) { if (name === 'DOMContentLoaded') onReady = handler; },
    createElement: element,
    getElementById: id => id === 'live-clock' ? element() : null,
    querySelector: selector => selector.includes('data-role="menu"') ? menu : null
  };
  const window = {
    sainsDesktop: {
      checkUpdate: async () => ({ available: true, version: '0.2.10', currentVersion: '0.1.4' }),
      openUpdate: async () => { opened++; }
    },
    addEventListener() {}
  };
  vm.runInNewContext(code, { document, window, navigator: { onLine: true }, setInterval() {} });
  onReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper.id, 'desktop-update-status');
  const [badge, panel] = wrapper.children;
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /v0\.2\.10/);
  assert.equal(panel.hidden, true, 'notification must not obstruct clicks');
  assert.equal(opened, 0, 'never download or open an installer automatically');
  badge.events.click();
  assert.equal(panel.hidden, false);
  await panel.children[1].events.click();
  assert.equal(opened, 1);
  assert.equal(menu.children.at(-1).textContent, 'Semak kemas kini');
});
