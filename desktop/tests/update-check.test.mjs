import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateUpdateManifest, compareVersions, UPDATE_FEED } = require('../update-check.cjs');
const manifest = {
  schema: 1,
  version: '0.2.10',
  release_url: 'https://github.com/sainspdwater-dev/sainspd-lap-pembaikan/releases/tag/desktop-v0.2.10',
  sha256: 'a'.repeat(64),
  web_commit: 'b'.repeat(40),
  published_at: '2026-10-19T00:00:00.000Z'
};

test('only a newer published installer is reported', () => {
  assert.match(UPDATE_FEED, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
  assert.equal(evaluateUpdateManifest(manifest, '0.2.10'), null);
  assert.equal(evaluateUpdateManifest(manifest, '0.3.0'), null);
  const update = evaluateUpdateManifest(manifest, '0.1.4');
  assert.equal(update.version, '0.2.10');
  assert.equal(update.releaseUrl, manifest.release_url);
});

test('untrusted release links and malformed hashes are rejected', () => {
  assert.throws(() => evaluateUpdateManifest({ ...manifest, release_url: 'https://evil.example/setup.exe' }, '0.1.4'));
  assert.throws(() => evaluateUpdateManifest({ ...manifest, sha256: 'missing' }, '0.1.4'));
  assert.throws(() => evaluateUpdateManifest({ ...manifest, web_commit: 'short' }, '0.1.4'));
  assert.throws(() => evaluateUpdateManifest({ ...manifest, version: '0.2.10-beta' }, '0.1.4'));
});
