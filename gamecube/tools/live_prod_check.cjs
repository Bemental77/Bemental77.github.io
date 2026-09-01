#!/usr/bin/env node
// Drive the LIVE prod site (caseybement.com/gamecube) with puppeteer to see
// what actually renders + the console error breakdown. Ground-truth check that
// matches what the user sees, and a verification harness after a render fix.
//
//   ROM_IDX=0|1|2|3  (0=MP4 default, 1=SAB, 2=PSO, 3=240pSuite)
//   DURATION_MS=50000   SHOT=/tmp/live.png   URL=https://caseybement.com/gamecube.html
//   QUERY=renderWorker=0   (appended to the page URL)
const puppeteer = require('puppeteer');

(async () => {
  const ROM_IDX = parseInt(process.env.ROM_IDX || '0', 10);
  const DURATION = parseInt(process.env.DURATION_MS || '55000', 10);
  const SHOT = process.env.SHOT || '/tmp/live.png';
  const QUERY = process.env.QUERY ? ('?' + process.env.QUERY) : '';
  const URL = (process.env.URL || 'https://caseybement.com/gamecube.html') + QUERY;

  const counts = { deleteTexture: 0, axpe2: 0, error: 0, viswap: 0, outputxfb: 0, romChunk: 0, pageerror: 0 };
  const samples = [];
  const note = (t) => {
    if (/deleteTexture/.test(t)) counts.deleteTexture++;
    if (/\[ax-pe2\]/.test(t)) counts.axpe2++;
    if (/ViSwap n=/.test(t)) counts.viswap++;
    if (/OutputXFB n=/.test(t)) counts.outputxfb++;
    if (/\[rom\] chunk/.test(t)) counts.romChunk++;
    if (/error|Error|Uncaught|RangeError|TypeError/.test(t) && samples.length < 25) samples.push(t.slice(0, 200));
  };

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
           '--js-flags=--max-old-space-size=4096',
           '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache',
           '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });
  // [leak-guard] a SIGKILLed parent ORPHANS this browser (uncatchable in-process);
  // `node tools/browser_leak_guard.js reap` kills it once this process is gone.
  try { require('../../tools/browser_leak_guard.js').guard(browser, __filename); } catch (_e) {}
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  page.on('console', (m) => note(m.text()));
  page.on('pageerror', (e) => { counts.pageerror++; if (samples.length < 25) samples.push('[pageerror] ' + String(e).slice(0, 200)); });

  console.log('[live] goto ' + URL);
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  // coi-serviceworker may register + reload on first visit; give it a beat then continue.
  await new Promise(r => setTimeout(r, 4000));
  const coi = await page.evaluate(() => ({ ci: self.crossOriginIsolated, hasSel: !!document.getElementById('romSelect') }));
  console.log('[live] crossOriginIsolated=' + coi.ci + ' romSelect=' + coi.hasSel);

  const picked = await page.evaluate((idx) => {
    const sel = document.getElementById('romSelect');
    if (sel) { sel.value = String(idx); sel.dispatchEvent(new Event('change')); }
    const b = document.getElementById('btnStart');
    const label = sel ? sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].text : '?';
    if (b) b.click();
    return label;
  }, ROM_IDX);
  console.log('[live] started ROM_IDX=' + ROM_IDX + ' (' + picked + '), running ' + DURATION + 'ms');

  await new Promise(r => setTimeout(r, DURATION));
  try { await page.screenshot({ path: SHOT, captureBeyondViewport: false }); console.log('[live] screenshot -> ' + SHOT); }
  catch (e) { console.log('[live] screenshot failed: ' + e.message); }

  console.log('[live] COUNTS ' + JSON.stringify(counts));
  console.log('[live] ERROR SAMPLES:');
  samples.forEach(s => console.log('   ' + s));
  await browser.close();
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
