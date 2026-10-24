// Finishing plays SM64's star grab (fanfare + Mario holding the star up) and stays on the course.
//   node sm64daily/test_star.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64star';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 720 });
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
await page.evaluateOnNewDocument(() => { window.__ready = null; window.__results = []; });
await page.goto(url + (process.env.Q || ''), { waitUntil: 'load' });
await page.click('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; const q = window.sm64DailyResult; window.sm64DailyResult = (...a) => { window.__results.push([performance.now(), ...a]); q(...a); }; });
await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
const ready = await page.evaluate(() => window.__ready);
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(2000);
for (let i = 1; i < ready - 1; i++) { await page.evaluate((i) => Module._daily_debug_warp(i), i); await wait(250); }
const t0 = await page.evaluate(() => { Module._daily_debug_warp(window.__ready - 1); return performance.now(); });
const shots = [400, 1300, 2100, 3000];
let last = 0;
for (const ms of shots) { await wait(ms - last); last = ms; await page.screenshot({ path: `${OUT}-${ms}.png` }); }
await wait(4000);
const r = await page.evaluate(() => window.__results);
const after = await page.evaluate(() => ({ y: Module._daily_debug_mario_y(), on: Module._daily_debug_standing() }));
console.log(JSON.stringify({ plats: ready, results: r.map(x => ({ msAfterGoal: Math.round(x[0] - t0), done: x[1], frames: x[2] })), after, card: await page.evaluate(() => (document.querySelector('#box h1') || {}).textContent), errs }));
await browser.close(); process.exit(0);
