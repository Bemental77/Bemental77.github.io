#!/usr/bin/env node
// Drive localhost:8080/gamecube.html in Chrome via puppeteer-core, click Start,
// capture console for DURATION_MS, write to /tmp/gc-page.log.
//
// Usage:
//   node gamecube/tools/drive_gamecube_html.mjs [duration_ms]

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const URL  = process.env.PAGE_URL || 'http://localhost:8080/gamecube.html';
const DURATION_MS = parseInt(process.argv[2] || process.env.DURATION_MS || '20000', 10);
const LOG  = process.env.LOG || '/tmp/gc-page.log';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const logf = fs.createWriteStream(LOG, { flags: 'w' });
const log = (...a) => { const s = a.join(' '); logf.write(s + '\n'); console.error(s); };

log(`[driver] launching chrome → ${URL}, duration=${DURATION_MS}ms`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // SharedArrayBuffer requires COOP/COEP; the site's coi-serviceworker
    // installs them on second load. Enable SAB without the policy check
    // so the first load works headlessly.
    '--enable-features=SharedArrayBuffer',
    '--disable-features=IsolateOrigins,site-per-process',
    // COI bypass for headless.
    '--enable-blink-features=SharedArrayBuffer',
  ],
  defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();

let consoleLines = 0;
page.on('console', msg => {
  consoleLines++;
  const type = msg.type();
  const text = msg.text();
  log(`[console.${type}] ${text}`);
});
page.on('pageerror', err => log(`[pageerror] ${err.message}`));
page.on('error',     err => log(`[error]     ${err.message}`));
page.on('requestfailed', req => log(`[reqfailed] ${req.url()} - ${req.failure()?.errorText}`));

log(`[driver] goto`);
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e => log(`[goto-fail] ${e.message}`));

// COI service worker requires a reload to take effect.
log(`[driver] reload to activate coi-serviceworker`);
await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => log(`[reload-fail] ${e.message}`));

const coi = await page.evaluate(() => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated).catch(() => false);
log(`[driver] crossOriginIsolated=${coi}`);

// Select the ROM by index (defaults to 0; override via ROM_IDX env var).
const ROM_IDX = process.env.ROM_IDX || '0';
const picked = await page.evaluate((idx) => {
  const sel = document.getElementById('romSelect');
  if (!sel) return 'no-select';
  sel.value = String(idx);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'idx=' + idx + ' label=' + (sel.options[sel.selectedIndex]?.textContent || '?');
}).catch(e => 'eval-error: ' + e.message);
log(`[driver] rom select: ${picked}`);

// Click the Start button.
const clicked = await page.evaluate(() => {
  const btn = document.getElementById('btnStart');
  if (!btn) return 'no-btn';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
}).catch(e => 'eval-error: ' + e.message);
log(`[driver] start button: ${clicked}`);

// Capture for duration.
const start = Date.now();
const deadline = start + DURATION_MS;
const tick = () => {
  const elapsed = Date.now() - start;
  log(`[driver] tick elapsed=${elapsed}ms consoleLines=${consoleLines}`);
};
const ticker = setInterval(tick, 5000);
await new Promise(r => setTimeout(r, DURATION_MS));
clearInterval(ticker);

// Final snapshot of crucial state.
const finalState = await page.evaluate(() => {
  return {
    coi: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
    btnStartDisabled: !!document.getElementById('btnStart')?.disabled,
    statusText: document.querySelector('.status')?.textContent || document.body.textContent?.match(/Running|Loading|Error|Stopped/)?.[0] || 'unknown',
  };
}).catch(e => ({ error: e.message }));
log(`[driver] final state: ${JSON.stringify(finalState)}`);
log(`[driver] total console lines captured: ${consoleLines}`);

await browser.close();
logf.end();
console.log(`done. log: ${LOG}`);
