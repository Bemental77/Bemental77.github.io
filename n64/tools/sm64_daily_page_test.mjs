// End-to-end test of /n64/?daily (n64/daily/daily.js) on the real page and core.
//
//   node n64/tools/sm64_daily_page_test.mjs          (needs the devserver; URL=... to override)
//
//  1. the intro card appears with today's challenge;
//  2. Start restores the start state (Mario at the route's start) and the
//     countdown freezes the guest (VI count does not move);
//  3. the clock runs in GUEST time and real stick input moves Mario;
//  4. writing Mario onto each checkpoint in turn captures it, and the last one
//     ends the run with "Finished!", a stored best and a share line.
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';

const base = process.env.URL || 'http://localhost:8080/n64/';
const SHOT = process.env.SHOT || '/tmp/sm64daily';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 760 });
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const wait = ms => new Promise(r => setTimeout(r, ms));
const R = {}; let fail = 0;
const ck = (name, c, info) => { R[name] = { ok: !!c, info }; if (!c) fail++; console.log((c ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); };
const mario = () => page.evaluate(() => {
  const M = Module, p = M._neil_rdram_ptr(), f = a => M.HEAPF32[(p + (a & 0x1FFFFFFF)) >>> 2];
  return { x: f(0x8033B1AC), y: f(0x8033B1B0), z: f(0x8033B1B4), vi: M._neil_vi_total() };
});

await page.goto(base + '?game=sm64.z64&autostart&daily', { waitUntil: 'load' });
await page.waitForSelector('#sd-go', { timeout: 120000 });
const ch = await page.evaluate(() => window.__sm64daily);
ck('intro-card', !!ch && ch.checkpoints.length > 0, { number: ch && ch.number, cps: ch && ch.checkpoints.length, parVi: ch && ch.parVi });
await page.screenshot({ path: SHOT + '-intro.png' });

await page.click('#sd-go');
await wait(300);
const a = await mario(); await wait(800); const b = await mario();
ck('countdown-freezes-guest', a.vi === b.vi, { viA: a.vi, viB: b.vi });
const route = await page.evaluate(() => fetch('/n64/daily/routes/castle_grounds.json').then(r => r.json()));
ck('start-state-restored', Math.hypot(a.x - route.start.x, a.z - route.start.z) < 5, { mario: a, start: route.start });

await page.waitForFunction(() => document.getElementById('sd-time').textContent !== '2:00.00', { timeout: 10000 });
const t0 = await page.evaluate(() => document.getElementById('sd-time').textContent);
await page.keyboard.down('w'); await wait(1500); await page.keyboard.up('w');
const c = await mario(), t1 = await page.evaluate(() => document.getElementById('sd-time').textContent);
ck('input-moves-mario', Math.hypot(c.x - a.x, c.z - a.z) > 100, { moved: Math.round(Math.hypot(c.x - a.x, c.z - a.z)) });
ck('clock-counts-down', t1 < t0, { t0, t1 });
await page.screenshot({ path: SHOT + '-running.png' });

for (let i = 0; i < ch.checkpoints.length; i++) {
  const cp = ch.checkpoints[i];
  await page.evaluate((cp) => {
    const M = Module, p = M._neil_rdram_ptr(), at = a => (p + (a & 0x1FFFFFFF)) >>> 2;
    M.HEAPF32[at(0x8033B1AC)] = cp.x; M.HEAPF32[at(0x8033B1B0)] = cp.y + 20; M.HEAPF32[at(0x8033B1B4)] = cp.z;
  }, cp);
  await wait(250);
}
await page.waitForFunction(() => /Finished/.test((document.querySelector('#sd-card h2') || {}).textContent || ''), { timeout: 10000 }).catch(() => {});
const end = await page.evaluate(() => ({ h: (document.querySelector('#sd-card h2') || {}).textContent, share: (document.getElementById('sd-share') || {}).textContent,
  store: localStorage.getItem('sm64daily.v1') }));
ck('teleport-run-finishes', end.h === 'Finished!', end.h);
ck('share-line', /SM64 Daily Parkour #\d+\n(🟨)+ \d:\d\d\.\d\d/u.test(end.share || ''), end.share);
ck('best-stored', /"done":true/.test(end.store || ''), end.store);
await page.screenshot({ path: SHOT + '-finished.png' });
ck('no-page-errors', errs.length === 0, errs);
console.log(JSON.stringify({ fail, results: R }));
await browser.close(); process.exit(fail ? 1 : 0);
