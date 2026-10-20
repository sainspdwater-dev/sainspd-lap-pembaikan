import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];

test('wrong offline code keeps the field usable, then the correct code logs in', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', style: {}, disabled: false, events: {},
      classList: { add() {}, remove() {} },
      addEventListener(type, handler) { this.events[type] = handler; },
      focus() { this.focused = true; }, select() { this.selected = true; }, appendChild() {}
    });
    return elements.get(id);
  };
  const storage = new Map([['sainsRawData', '[]'], ['sainsDesktopDraftQueue', '[{"noAduan":"PD-1"}]']]);
  let attempts = 0;
  let restores = 0;
  const context = {
    document: { getElementById: element, querySelector: () => element('particles'), createElement: () => ({ style: {} }) },
    window: {
      location: { href: 'index.html' },
      sainsDesktop: {
        offlineStatus: async () => ({ available: true, username: 'adminpd' }),
        unlockOffline: async code => {
          attempts++;
          if (code !== 'correct-test-code') throw new Error("Error invoking remote method 'desktop:unlock-offline': Error: Kod offline tidak tepat.");
          return { level: 'ADMIN' };
        }
      },
      sainsDesktopStore: { restore: async () => { restores++; return true; } }
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    }
  };
  vm.runInNewContext(script, context);
  await Promise.resolve();
  const code = element('offlineCode');
  const button = element('offlineLoginBtn');
  code.value = 'wrong-test-code';
  await button.events.click();
  assert.equal(element('offlineLoginError').textContent, 'Kod offline tidak tepat. Cuba semula.');
  assert.equal(code.focused, true);
  assert.equal(code.selected, true);
  assert.equal(button.disabled, false);
  assert.equal(restores, 0, 'a wrong code must not read the local data store');
  assert.equal(storage.get('sainsDesktopDraftQueue'), '[{"noAduan":"PD-1"}]');

  code.value = 'correct-test-code';
  code.events.input();
  await button.events.click();
  assert.equal(attempts, 2);
  assert.equal(restores, 1);
  assert.equal(context.window.location.href, 'dashboard.html');
  assert.equal(storage.get('sainsDesktopOffline'), 'true');
  assert.equal(storage.get('sainsDesktopDraftQueue'), '[{"noAduan":"PD-1"}]');
});
