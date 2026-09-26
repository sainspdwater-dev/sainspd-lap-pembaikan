// Deployed, TEST-only UI checks. Pass staging code through env; never print it.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = 'https://sains-hydraulic-gateway-staging.sainspdwater.workers.dev/';
(async () => {
  const code = process.env.SAINS_STAGING_TEST_CODE;
  if (!code || code.length < 32) throw new Error('Missing staging TEST code');
  const login = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'hydraulicStagingLogin', code }) });
  const auth = await login.json();
  assert.equal(login.status, 200);
  assert.equal(auth.status, 'success');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 768 } });
    await context.addInitScript(({ token, jobId }) => {
      localStorage.setItem('sainsLoggedIn', 'true');
      localStorage.setItem('sainsUserLevel', 'ADMIN');
      localStorage.setItem('sainsToken', token);
      if (jobId) localStorage.setItem('sainsStagingHydraulicJob', jobId);
    }, { token: auth.token, jobId: process.env.SAINS_COMPLETED_TEST_JOB || '' });
    const page = await context.newPage();
    await page.goto(`${base}dashboard?hydraulicStaging=1`, { waitUntil: 'load', timeout: 45000 });
    await page.locator('#nav-ai').click();
    await page.locator('details').filter({ hasText: 'Hydraulic Model Status — ADMIN' }).locator('summary').first().click();
    const result = page.locator('#ai-test-result');
    if (process.env.SAINS_COMPLETED_TEST_JOB) {
      await page.locator('#ai-test-job-status').getByText('COMPLETED').waitFor({ timeout: 45000 });
      assert.match(await result.innerText(), /TEST MODEL \/ UNCALIBRATED/);
      console.log('refresh_result=PASS job_status=COMPLETED test_layer_enabled=' + await page.locator('#ai-test-layer-toggle').isEnabled());
    }
    await page.locator('#ai-test-timeout').click();
    await page.locator('#ai-test-job-status').getByText('FAILED').waitFor({ timeout: 160000 });
    const message = await result.innerText();
    assert.match(message, /Simulation Failed: TIMEOUT/);
    assert.match(message, /Tiada GeoJSON/);
    assert.equal(await page.locator('#ai-test-layer-toggle').isEnabled(), false);
    console.log('timeout_ui=PASS failure_message=' + message.replace(/\s+/g, ' ').slice(0, 180));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
