import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const directory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const profile = await mkdtemp(path.join(os.tmpdir(), 'sains-pd-smoke-'));
const port = 9337;
let child;
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function debuggerPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const pages = await response.json();
      const page = pages.find(item => item.type === 'page' && item.url.includes('127.0.0.1:5500'));
      if (page) return page;
    } catch {}
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}).`);
    await pause(250);
  }
  throw new Error('Electron debugger did not open.');
}

try {
  const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
  const args = process.argv[2] ? ['--smoke-test', `--remote-debugging-port=${port}`] : [directory, '--smoke-test', `--remote-debugging-port=${port}`];
  child = spawn(executable, args, {
    env: { ...process.env, SAINS_DESKTOP_TEST_USER_DATA: profile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', buffer => { errors += buffer.toString(); });
  const page = await debuggerPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  await send('Page.reload', { ignoreCache: true });
  await pause(1500);
  const login = await evaluate("({ title: document.title, button: !!document.getElementById('loginBtn'), setup: !!document.getElementById('desktopOfflineSetup'), bridge: !!window.sainsDesktop, updateBridge: typeof window.sainsDesktop.checkUpdate === 'function', updateControl: !!document.getElementById('desktop-update-status'), lightweight: !document.querySelector('script[src=\"vendor/tailwind.js\"]') && !document.querySelector('.particle'), scrollable: getComputedStyle(document.body).overflowY === 'auto' })");
  if (!login.button || !login.setup || !login.bridge || !login.updateBridge || !login.updateControl || !login.lightweight || !login.scrollable) throw new Error(`Offline login shell failed: ${JSON.stringify(login)} ${errors}`);
  const emptyLogin = await evaluate("(()=>{document.getElementById('loginBtn').click();return {message:document.getElementById('onlineLoginError').textContent,focus:document.activeElement===document.getElementById('username'),overlay:document.getElementById('authOverlay').classList.contains('active')}})()");
  if (!emptyLogin.message || !emptyLogin.focus || emptyLogin.overlay) throw new Error(`Empty online login blocked input: ${JSON.stringify(emptyLogin)} ${errors}`);
  const restored = await evaluate("(async()=>{localStorage.setItem('sainsRawData','[{\"NO ADUAN\":\"OFFLINE-TEST\"}]'); await window.sainsDesktopStore.save(); localStorage.removeItem('sainsRawData'); await window.sainsDesktopStore.restore(); return localStorage.getItem('sainsRawData')})()");
  if (!restored.includes('OFFLINE-TEST')) throw new Error('IndexedDB did not restore saved repair data.');
  await evaluate("(()=>{document.getElementById('desktopOfflineLogin').style.display='block';document.getElementById('offlineCode').value='wrong-smoke-code';document.getElementById('offlineLoginBtn').click()})()");
  for (let attempt = 0; attempt < 40 && !await evaluate("!!document.getElementById('offlineLoginError').textContent"); attempt += 1) await pause(100);
  const offlineRetry = await evaluate("(()=>{const input=document.getElementById('offlineCode');input.value='retry-code';input.dispatchEvent(new Event('input',{bubbles:true}));return {focus:document.activeElement===input,editable:!input.disabled&&input.value==='retry-code',button:!document.getElementById('offlineLoginBtn').disabled,cleared:!document.getElementById('offlineLoginError').textContent}})()");
  if (!offlineRetry.focus || !offlineRetry.editable || !offlineRetry.button || !offlineRetry.cleared) throw new Error(`Offline retry input failed: ${JSON.stringify(offlineRetry)} ${errors}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  const compactLogin = await evaluate("(()=>{const button=document.getElementById('offlineLoginBtn');button.scrollIntoView();return {scrollable:document.documentElement.scrollHeight>innerHeight,buttonVisible:button.getBoundingClientRect().bottom<=innerHeight}})()");
  if (!compactLogin.scrollable || !compactLogin.buttonVisible) throw new Error(`Compact login layout failed: ${JSON.stringify(compactLogin)} ${errors}`);
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate("localStorage.setItem('sainsLoggedIn','true'); localStorage.setItem('sainsUserLevel','ADMIN'); localStorage.setItem('sainsRawData',JSON.stringify([{'NO ADUAN':'PD-1','BULAN':'Oct-26','TARIKH & MASA TERIMA  ADUAN':'01/10/2026 10:00 am'}])); localStorage.setItem('sainsDesktopOffline','true'); localStorage.setItem('sainsSessionStart',Date.now()); localStorage.setItem('sainsLastActivity',Date.now())");
  await send('Page.navigate', { url: 'http://127.0.0.1:5500/dashboard.html' });
  for (let attempt = 0; attempt < 40 && !await evaluate("!!document.getElementById('desktop-offline-status')"); attempt += 1) await pause(250);
  const dashboard = await evaluate("({ title: document.title, ready: document.readyState, bridge: !!window.sainsDesktop, leaflet: typeof L, charts: typeof ApexCharts, offlineBanner: !!document.getElementById('desktop-offline-status'), updateControl: !!document.getElementById('desktop-update-status'), updateManual: [...document.querySelectorAll('#desktop-offline-status button')].some(button => button.textContent === 'Semak kemas kini'), statusTop: document.getElementById('desktop-offline-status')?.getBoundingClientRect().top < 300, statusNotFloating: getComputedStyle(document.getElementById('desktop-offline-status')).position !== 'fixed', count: document.querySelectorAll('script[src^=\"vendor/\"]').length })");
  if (!dashboard.offlineBanner || !dashboard.updateControl || !dashboard.updateManual || !dashboard.statusTop || !dashboard.statusNotFloating || dashboard.leaflet !== 'object' || dashboard.charts !== 'function' || dashboard.count < 10) throw new Error(`Offline dashboard failed: ${JSON.stringify(dashboard)} ${errors}`);
  const draft = await evaluate("(async()=>{await window.sendDesktopMutation('addData',{'NO ADUAN':'PD-2','TARIKH & MASA TERIMA  ADUAN':'01/10/2026 11:30 am','LOKASI / TEMPAT':'Ujian offline'});const toast=document.getElementById('toast-container').textContent;const count=rawData.length;const tableExists=$.fn.DataTable.isDataTable('#managementTable');document.getElementById('nav-update').click();const mgmt=$('#managementTable').DataTable();const rows=mgmt.rows().data().toArray();const inMgmt=rows.some(row=>String(row[1]).includes('PD-2')&&String(row[0]).includes('DRAF OFFLINE'));const search=document.querySelector('#managementTable_filter input');search.focus();search.value='PD-2';search.dispatchEvent(new Event('input',{bubbles:true}));const searchWorks=document.activeElement===search&&mgmt.rows({search:'applied'}).data().toArray().some(row=>String(row[1]).includes('PD-2'));document.getElementById('nav-cro').click();const inCro=[...document.querySelectorAll('#cro-tbody .cro-noAduan')].some(input=>input.value==='PD-2');return {inMgmt,searchWorks,inCro,month:rawData.find(row=>row['NO ADUAN']==='PD-2')?.BULAN,rows:rows.map(row=>[row[0],row[1]]),filter:document.getElementById('mgmt-filter-bulan').value, status:document.getElementById('mgmt-filter-status').value, active:document.activeElement===search,toast,count,tableExists}})()");
  if (!draft.inMgmt || !draft.searchWorks || !draft.inCro || draft.month !== 'Oct-26') throw new Error(`Offline draft display failed: ${JSON.stringify(draft)} ${errors}`);
  const online = await evaluate("(()=>{localStorage.setItem('sainsDesktopOffline','false');localStorage.setItem('sainsToken','smoke-only');localStorage.setItem('sainsDesktopDraftQueue','[]');updateManagementTable();document.getElementById('nav-update').click();const search=document.querySelector('#managementTable_filter input');search.focus();search.value='PD-1';search.dispatchEvent(new Event('input',{bubbles:true}));const found=$('#managementTable').DataTable().rows({search:'applied'}).data().toArray().some(row=>String(row[1]).includes('PD-1'));return {found,focus:document.activeElement===search}})()");
  if (!online.found || !online.focus) throw new Error(`Online mode/Search failed: ${JSON.stringify(online)} ${errors}`);
  console.log('PASS offline login shell:', login);
  console.log('PASS empty online login remains clickable:', emptyLogin);
  console.log('PASS offline retry input after rejected unlock:', offlineRetry);
  console.log('PASS compact login scroll and button reachability:', compactLogin);
  console.log('PASS offline dashboard shell:', dashboard);
  console.log('PASS offline draft in Pengurusan Data/CRO and Search:', { inMgmt: draft.inMgmt, searchWorks: draft.searchWorks, inCro: draft.inCro, month: draft.month });
  console.log('PASS Search after online mode switch:', online);
  socket.send(JSON.stringify({ id: ++serial, method: 'Browser.close' }));
  await pause(150);
} finally {
  socket?.close();
  if (child?.exitCode === null) child.kill();
  // This directory was freshly created by mkdtemp under the OS temporary folder.
  if (profile.startsWith(`${os.tmpdir()}${path.sep}`)) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
