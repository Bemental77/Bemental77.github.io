import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const URL = 'http://localhost:8080/gamecube.html';
const LOG = '/tmp/gc-page-pso.log';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DURATION_MS = parseInt(process.argv[2] || '30000', 10);

const logf = fs.createWriteStream(LOG, { flags: 'w' });
const log = (...a) => { logf.write(a.join(' ') + '\n'); console.error(a.join(' ')); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox','--disable-dev-shm-usage','--enable-features=SharedArrayBuffer','--disable-features=IsolateOrigins,site-per-process','--enable-blink-features=SharedArrayBuffer'],
  defaultViewport: { width:1280, height:720 },
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const page = await browser.newPage();
page.on('console', m => log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', e => log(`[pageerror] ${e.message}`));
page.on('requestfailed', r => log(`[reqfailed] ${r.url()} - ${r.failure()?.errorText}`));

await page.evaluateOnNewDocument(() => { try { localStorage.setItem('gcwasm_romIdx','1'); } catch(e){} });
log('[driver] set gcwasm_romIdx=1 (PSO)');
await page.goto(URL, { waitUntil:'networkidle2', timeout:30000 }).catch(e=>log(`[goto-fail] ${e.message}`));
await page.reload({ waitUntil:'networkidle2', timeout:30000 }).catch(e=>log(`[reload-fail] ${e.message}`));
const sel = await page.evaluate(() => document.getElementById('romSelect')?.value || 'no-select');
log(`[driver] romSelect.value = ${sel}`);
const clicked = await page.evaluate(() => { const b = document.getElementById('btnStart'); if (!b) return 'no-btn'; b.click(); return 'clicked'; });
log(`[driver] start: ${clicked}`);
await new Promise(r => setTimeout(r, DURATION_MS));
const status = await page.evaluate(() => ({ status: document.getElementById('status')?.textContent }));
log(`[driver] final: ${JSON.stringify(status)}`);
await browser.close();
logf.end();
