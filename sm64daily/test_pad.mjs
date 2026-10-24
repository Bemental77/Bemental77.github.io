// A controller starts the game (A on the intro card), the boot goes straight to the course (no logo),
// and the day's music track rotates with the date.
//   node sm64daily/test_pad.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64pad';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const out = {};
for (const date of ['2026-10-23', '2026-10-24']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
  // A fake controller: window.__padA toggles button 0.
  await page.evaluateOnNewDocument(() => {
    window.__ready = null; window.__padA = false;
    navigator.getGamepads = () => [{ id: 'fake', connected: true, index: 0, mapping: 'standard', axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0 && window.__padA, value: i === 0 && window.__padA ? 1 : 0 })) }];
  });
  await page.goto(url + '?test=1&date=' + date, { waitUntil: 'load' });
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; });
  await wait(500);
  const t0 = Date.now();
  await page.evaluate(() => { window.__padA = true; }); await wait(300); await page.evaluate(() => { window.__padA = false; });
  const loading = await page.evaluate(() => (document.querySelector('#box') || {}).textContent);
  const shots = [];
  for (let k = 0; k < 6 && !(await page.evaluate(() => window.__ready !== null)); k++) { await wait(700); const f = `${OUT}-${date}-boot${k}.png`; await page.screenshot({ path: f }); shots.push(f); }
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 }).catch(() => {});
  out[date] = { startedByPad: await page.evaluate(() => window.__ready !== null), readyMs: Date.now() - t0, loadingText: loading, track: await page.evaluate(() => Module._daily_debug_track ? Module._daily_debug_track() : null), card: await page.evaluate(() => document.querySelector('#box').innerText.slice(0,200)), poll: await page.evaluate(() => typeof navigator.getGamepads()[0].buttons[0].pressed), shots, errs };
  await wait(1500); await page.screenshot({ path: `${OUT}-${date}-ready.png` });
  await page.close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);
