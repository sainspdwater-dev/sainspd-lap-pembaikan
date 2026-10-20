const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { UPDATE_FEED, evaluateUpdateManifest } = require('./update-check.cjs');

if (process.argv.includes('--smoke-test') && process.env.SAINS_DESKTOP_TEST_USER_DATA) {
  const isolated = path.resolve(process.env.SAINS_DESKTOP_TEST_USER_DATA);
  if (!isolated.startsWith(`${os.tmpdir()}${path.sep}`)) throw new Error('Smoke test profile must be inside the temporary directory.');
  app.setPath('userData', isolated);
}

const PORT = 5500; // Already allowed by the existing Worker CORS policy.
const ROOT = path.join(__dirname, 'app');
const WORKER = 'https://laporanpembaikan.sainspdwater.workers.dev/';
let server;
let authenticatedAccount = null;
let failedUnlocks = 0;
let lockedUntil = 0;
let availableUpdate = null;
let cachedUpdateResponse = null;
let updateCheckedAt = 0;
let updateCheckPending = null;

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const profilePath = () => path.join(app.getPath('userData'), 'offline-profile.json');

async function readProfile() {
  try { return JSON.parse(await fs.readFile(profilePath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function storeProfile(profile) {
  const file = profilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(profile), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function serveStatic(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  let requested;
  try { requested = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${PORT}`).pathname); }
  catch { response.writeHead(400).end(); return; }
  const file = path.resolve(ROOT, `.${requested === '/' ? '/index.html' : requested}`);
  if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) { response.writeHead(403).end(); return; }
  fs.readFile(file).then(content => {
    response.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') response.end(); else response.end(content);
  }).catch(() => response.writeHead(404).end());
}

ipcMain.handle('desktop:offline-status', async () => {
  const profile = await readProfile();
  return { available: !!profile, username: profile?.username || null };
});

ipcMain.handle('desktop:online-login', async (_event, { username, passwordHash }) => {
  if (typeof username !== 'string' || typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/.test(passwordHash)) throw new Error('Maklumat log masuk tidak sah.');
  const profile = await readProfile();
  if (profile && profile.username.toLowerCase() !== username.trim().toLowerCase()) throw new Error('Komputer ini sudah disediakan untuk akaun staf lain. Gunakan profil Windows berasingan.');
  const response = await fetch(WORKER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', username: username.trim(), passwordHash }), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (data.status === 'success' && typeof data.token === 'string') {
    authenticatedAccount = { username: username.trim(), level: data.level };
    if (profile) await storeProfile({ ...profile, level: data.level, lastVerifiedAt: new Date().toISOString() });
  }
  return data;
});

ipcMain.handle('desktop:register-offline', async (_event, passphrase) => {
  if (!authenticatedAccount) throw new Error('Log masuk online dahulu.');
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 128) throw new Error('Kod offline mesti sekurang-kurangnya 8 aksara.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Perlindungan data Windows tidak tersedia; akses offline tidak diaktifkan.');
  const salt = crypto.randomBytes(32);
  const digest = await new Promise((resolve, reject) => crypto.scrypt(passphrase, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
  const secret = safeStorage.encryptString(`${salt.toString('hex')}:${digest.toString('hex')}`).toString('base64');
  await storeProfile({ username: authenticatedAccount.username, level: authenticatedAccount.level, secret, createdAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString() });
  return { registered: true };
});

ipcMain.handle('desktop:unlock-offline', async (_event, passphrase) => {
  if (Date.now() < lockedUntil) throw new Error('Terlalu banyak cubaan. Cuba semula selepas beberapa minit.');
  const profile = await readProfile();
  if (!profile || !safeStorage.isEncryptionAvailable()) throw new Error('Akses offline belum disediakan pada komputer ini.');
  const verifiedAt = Date.parse(profile.lastVerifiedAt || profile.createdAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 60_000 || Date.now() - verifiedAt > 7 * 24 * 60 * 60 * 1000) throw new Error('Pengesahan offline melebihi 7 hari. Log masuk online semula untuk memperbaharuinya.');
  const [saltHex, digestHex] = safeStorage.decryptString(Buffer.from(profile.secret, 'base64')).split(':');
  const candidate = await new Promise((resolve, reject) => crypto.scrypt(String(passphrase || ''), Buffer.from(saltHex, 'hex'), 64, (error, key) => error ? reject(error) : resolve(key)));
  const expected = Buffer.from(digestHex, 'hex');
  if (!crypto.timingSafeEqual(candidate, expected)) {
    failedUnlocks += 1;
    if (failedUnlocks >= 5) { lockedUntil = Date.now() + 5 * 60_000; failedUnlocks = 0; }
    throw new Error('Kod offline tidak tepat.');
  }
  failedUnlocks = 0;
  return { username: profile.username, level: profile.level };
});

async function checkForUpdate(force = false) {
  if (process.argv.includes('--smoke-test')) return { available: false, currentVersion: app.getVersion() };
  if (updateCheckPending) return updateCheckPending;
  if (!force && cachedUpdateResponse && Date.now() - updateCheckedAt < 60 * 60_000) return cachedUpdateResponse;
  updateCheckPending = (async () => {
    try {
      const response = await fetch(UPDATE_FEED, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), cache: 'no-store'
      });
      if (response.status === 404) {
        availableUpdate = null;
        cachedUpdateResponse = { available: false, currentVersion: app.getVersion(), reason: 'Tiada pelepasan desktop diterbitkan lagi.' };
      } else {
        if (!response.ok) throw new Error(`Semakan versi gagal (${response.status}).`);
        const update = evaluateUpdateManifest(await response.json(), app.getVersion());
        availableUpdate = update;
        cachedUpdateResponse = update ? { available: true, ...update } : { available: false, currentVersion: app.getVersion() };
      }
      updateCheckedAt = Date.now();
      return cachedUpdateResponse;
    } catch (error) {
      return { available: false, currentVersion: app.getVersion(), error: 'Tidak dapat menyemak kemas kini sekarang. Cuba lagi apabila internet tersedia.' };
    } finally { updateCheckPending = null; }
  })();
  return updateCheckPending;
}

ipcMain.handle('desktop:check-update', (_event, force) => checkForUpdate(force === true));
ipcMain.handle('desktop:open-update', async () => {
  if (!availableUpdate) throw new Error('Tiada kemas kini yang disahkan. Semak versi dahulu.');
  await shell.openExternal(availableUpdate.releaseUrl);
  return true;
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1050, minHeight: 680, show: !process.argv.includes('--smoke-test'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.google\.com\/maps|maps\.google\.com|api\.whatsapp\.com)\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) event.preventDefault();
  });
  window.loadURL(`http://127.0.0.1:${PORT}/index.html`);
}

app.whenReady().then(async () => {
  server = http.createServer(serveStatic);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  createWindow();
}).catch(error => {
  console.error('SAINS PD desktop could not start:', error);
  dialog.showErrorBox('SAINS PD tidak dapat dibuka', `Port setempat ${PORT} mungkin sedang digunakan oleh aplikasi lain. Tutup aplikasi tersebut dan cuba lagi.\n\n${error.message}`);
  app.quit();
});
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
