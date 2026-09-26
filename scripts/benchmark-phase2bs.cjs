// Controlled static-shell browser benchmark. No production API calls or credentials.
const { chromium } = require('playwright');
const urls = {
  production: 'https://sainspdwater-dev.github.io/sainspd-lap-pembaikan/dashboard.html',
  staging: 'https://sains-hydraulic-gateway-staging.sainspdwater.workers.dev/dashboard?hydraulicStaging=1'
};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const samples = { production: [], staging: [] };
  try {
    for (let i = 0; i < 5; i++) {
      for (const label of i % 2 ? ['staging', 'production'] : ['production', 'staging']) {
        const context = await browser.newContext({ viewport: { width: 1365, height: 768 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.addInitScript(() => {
          localStorage.setItem('sainsLoggedIn', 'true');
          localStorage.setItem('sainsUserLevel', 'ADMIN');
          localStorage.setItem('sainsToken', 'BENCHMARK_INVALID_NO_API');
        });
        await page.route('**/*', async route => {
          if (route.request().method() === 'POST') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"success","data":[],"values":[]}' });
          } else if (route.request().url().includes('laporanpembaikan.sainspdwater.workers.dev')) {
            await route.abort();
          } else await route.continue();
        });
        await page.goto(urls[label], { waitUntil: 'load', timeout: 45000 });
        const result = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const resources = performance.getEntriesByType('resource');
          const scripts = resources.filter(item => /\.js(?:\?|$)/.test(item.name));
          return {
            dclMs: Math.round(nav.domContentLoadedEventEnd),
            loadMs: Math.round(nav.loadEventEnd),
            fcpMs: Math.round(performance.getEntriesByType('paint').find(item => item.name === 'first-contentful-paint')?.startTime || 0),
            transferBytes: nav.transferSize + resources.reduce((sum, item) => sum + item.transferSize, 0),
            scriptTransferBytes: scripts.reduce((sum, item) => sum + item.transferSize, 0),
            scriptCount: scripts.length,
            finalPath: location.pathname
          };
        });
        samples[label].push(result);
        await context.close();
      }
    }
    const metrics = ['dclMs', 'loadMs', 'fcpMs', 'transferBytes', 'scriptTransferBytes', 'scriptCount'];
    const medians = Object.fromEntries(Object.entries(samples).map(([label, rows]) =>
      [label, Object.fromEntries(metrics.map(key => [key, median(rows.map(row => row[key]))]))]));
    console.log(JSON.stringify({ method: 'Chrome headless, same machine/network/viewport, 5 cold-cache samples per origin, interleaved, POST APIs stubbed identically, production API blocked', samples, medians }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
