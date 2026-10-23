// Boots /sm64daily/, presses Play, waits for the course, screenshots, then holds W + taps Space.
//   node sm64daily/test_page.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64daily';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 720 });
const errs = [], logs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 300))); page.on('console', m => logs.push(m.type() + ' ' + m.text().slice(0, 200))); page.on('response', r => { if (r.status() >= 400) logs.push('error HTTP ' + r.status() + ' ' + r.url()); });
await page.evaluateOnNewDocument(() => { window.__ready = null; window.__results = []; });
await page.goto(url + (process.env.Q || ''), { waitUntil: 'load' });
await page.click('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n) => { window.__ready = n; r(n); }; const q = window.sm64DailyResult; window.sm64DailyResult = (...a) => { window.__results.push(a); q(...a); }; });
const t0 = Date.now();
await page.waitForFunction('window.__ready !== null', { timeout: 60000 }).catch(() => {});
const ready = await page.evaluate(() => window.__ready);
console.log('ready plats=', ready, 'after', Date.now() - t0, 'ms');
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(2500); await page.screenshot({ path: OUT + '-start.png' });
await page.keyboard.down('KeyW'); await wait(700); await page.keyboard.down('Space'); await wait(250); await page.keyboard.up('Space'); await wait(900); await page.keyboard.up('KeyW');
await page.screenshot({ path: OUT + '-jump.png' });
await wait(3000); await page.screenshot({ path: OUT + '-after.png' });
// Walk the course by warping onto each platform in order (daily_debug_warp), as a finisher would.
for (let i = 1; i < ready; i++) { await page.evaluate((i) => Module._daily_debug_warp(i), i); await wait(900); if (process.env.SHOTS) await page.screenshot({ path: OUT + '-st' + String(i).padStart(2, '0') + '.png' }); }
await wait(2500); await page.screenshot({ path: OUT + '-finish.png' });
const card = await page.evaluate(() => ({ h: (document.querySelector('#box h1') || {}).textContent, share: (document.getElementById('share') || {}).textContent, store: localStorage.getItem('sm64daily.v2') }));
console.log('card', JSON.stringify(card));
console.log('results', JSON.stringify(await page.evaluate(() => window.__results)));
console.log('pageErrors', JSON.stringify(errs));
console.log(logs.filter(l => /error|abort|warn/i.test(l)).slice(0, 10).join('\n'));
await browser.close(); process.exit(0);
