const UPDATE_FEED = 'https://raw.githubusercontent.com/sainspdwater-dev/sainspd-lap-pembaikan/main/desktop-update.json';
const RELEASE_PREFIX = 'https://github.com/sainspdwater-dev/sainspd-lap-pembaikan/releases/tag/desktop-v';

function parseVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Versi aplikasi tidak sah.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

function evaluateUpdateManifest(manifest, currentVersion) {
  if (!manifest || manifest.schema !== 1 || !parseVersion(manifest.version)) throw new Error('Format notifikasi kemas kini tidak sah.');
  const expectedUrl = `${RELEASE_PREFIX}${manifest.version}`;
  if (manifest.release_url !== expectedUrl || !/^[a-f0-9]{64}$/i.test(manifest.sha256 || '') ||
      !/^[a-f0-9]{40}$/i.test(manifest.web_commit || '') || !Number.isFinite(Date.parse(manifest.published_at))) {
    throw new Error('Sumber kemas kini tidak dapat disahkan.');
  }
  if (compareVersions(manifest.version, currentVersion) <= 0) return null;
  return {
    version: manifest.version,
    currentVersion,
    releaseUrl: expectedUrl,
    sha256: manifest.sha256.toLowerCase(),
    webCommit: manifest.web_commit.toLowerCase(),
    publishedAt: manifest.published_at
  };
}

module.exports = { UPDATE_FEED, evaluateUpdateManifest, compareVersions };
