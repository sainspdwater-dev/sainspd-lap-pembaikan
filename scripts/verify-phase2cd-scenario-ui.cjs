// One deployed TEST scenario-path check; never submits a SAINS model.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base='https://sains-hydraulic-gateway-staging.sainspdwater.workers.dev/';
(async()=>{
  const code=process.env.SAINS_STAGING_TEST_CODE;
  if(!code || code.length<32)throw new Error('Missing staging TEST code');
  const authResponse=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'hydraulicStagingLogin',code})});
  const auth=await authResponse.json();
  assert.equal(authResponse.status,200);
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1365,height:768}});
    await context.addInitScript(token=>{
      localStorage.setItem('sainsLoggedIn','true');localStorage.setItem('sainsUserLevel','ADMIN');
      localStorage.setItem('sainsToken',token);
    },auth.token);
    const page=await context.newPage();
    await page.goto(`${base}dashboard?hydraulicStaging=1`,{waitUntil:'load',timeout:45000});
    await page.locator('#nav-ai').click();
    await page.locator('details').filter({hasText:'Hydraulic Model Status — ADMIN'}).locator('summary').first().click();
    await page.locator('#ai-test-head-scenario').click();
    await page.locator('#ai-test-job-status').getByText('COMPLETED').waitFor({timeout:90000});
    const result=await page.locator('#ai-test-result').innerText();
    assert.match(result,/TEST MODEL \/ UNCALIBRATED/);
    const jobId=await page.evaluate(()=>localStorage.getItem('sainsStagingHydraulicJob'));
    const retrieved=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${auth.token}`},
      body:JSON.stringify({action:'getTestHydraulicJob',jobId})});
    const payload=await retrieved.json();
    assert.equal(payload.job.status,'COMPLETED');
    assert.equal(payload.job.modelId,'TEST-REFERENCE-LOOP');
    assert.ok(Math.abs(payload.job.summary.minimumPressureM-87.59948)<0.03);
    await page.locator('#ai-test-layer-toggle').click();
    const paths=await page.locator('#ai-agent-map .leaflet-overlay-pane path').count();
    assert.ok(paths>=5);
    console.log(`scenario_ui=PASS type=SOURCE_HEAD_CHANGE model=TEST-REFERENCE-LOOP job=${jobId} pressure_m=${payload.job.summary.minimumPressureM.toFixed(5)} leaflet_paths=${paths} result=${result.slice(0,150)}`);
    await page.reload({waitUntil:'load'});
    await page.locator('#nav-ai').click();
    await page.locator('details').filter({hasText:'Hydraulic Model Status — ADMIN'}).locator('summary').first().click();
    await page.locator('#ai-test-job-status').getByText('COMPLETED').waitFor({timeout:45000});
    console.log('scenario_refresh=PASS');
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
