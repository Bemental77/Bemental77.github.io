// Screens of the page shell: intro (desktop + phone), the pause menu (controls + sound), a remap,
// keyboard play through the page's input layer, and the finish card.
//   node sm64daily/test_ui.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64ui';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const out = {};
// Phone first (touch, portrait).
{
  const page = await browser.newPage();
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await page.goto(url, { waitUntil: 'load' }); await wait(600);
  await page.screenshot({ path: OUT + '-phone-intro.png' });
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__phoneReady = n; r(n, p); }; });
  await page.tap('#play');
  await page.waitForFunction('window.__phoneReady', { timeout: 60000 }); await wait(1500);
  // Touch: push the stick up and tap A; Mario should leave the ground.
  const y0 = await page.evaluate(() => Module._daily_debug_mario_y());
  const a = await page.$eval('#tA', el => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await page.touchscreen.touchStart(a[0], a[1]); await wait(200);
  const y1 = await page.evaluate(() => Module._daily_debug_mario_y());
  await page.touchscreen.touchEnd();
  out.touchJump = { y0, y1, rose: y1 > y0 + 50, touchShown: await page.evaluate(() => !document.getElementById('touch').hidden) };
  await page.screenshot({ path: OUT + '-phone-play.png' });
  await page.close();
}
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
await page.evaluateOnNewDocument(() => { window.__ready = null; window.__results = []; });
await page.goto(url, { waitUntil: 'load' }); await wait(600);
await page.screenshot({ path: OUT + '-intro.png' });
out.days = await page.evaluate(() => [...document.querySelectorAll('.day')].map(b => b.dataset.d + (b.classList.contains('sel') ? '*' : '')));
await page.click('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; const q = window.sm64DailyResult; window.sm64DailyResult = (...a) => { window.__results.push(a); q(...a); }; });
await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
await wait(1500);
// Keyboard through the page: hold W and jump; Mario should move.
const y0 = await page.evaluate(() => Module._daily_debug_mario_y());
await page.keyboard.down('KeyW'); await wait(300); await page.keyboard.down('Space'); await wait(200);
const yJump = await page.evaluate(() => Module._daily_debug_mario_y());
await page.keyboard.up('Space'); await wait(500); await page.keyboard.up('KeyW');
out.keyboardJump = { y0, yJump, rose: yJump > y0 + 50 };
await page.screenshot({ path: OUT + '-play.png' });
// Pause menu (Esc): the game's clock stops.
await page.keyboard.press('Escape'); await wait(400);
const t1 = await page.evaluate(() => Module._daily_debug_mario_y()); await wait(800);
await page.screenshot({ path: OUT + '-menu.png' });
// Remap A to the K key... no: to KeyP, then check it is stored.
await page.click('[data-a="a"][data-k="kb"]'); await wait(100); await page.keyboard.press('KeyP'); await wait(100);
out.remap = await page.evaluate(() => JSON.parse(localStorage.getItem('sm64daily.controls.v1')).a.kb);
await page.click('#tabSound'); await wait(200);
await page.screenshot({ path: OUT + '-sound.png' });
await page.click('#menuDefaults'); await wait(100);
out.afterDefaults = await page.evaluate(() => JSON.parse(localStorage.getItem('sm64daily.controls.v1')).a.kb);
await page.keyboard.press('Escape'); await wait(300);
out.menuClosed = await page.evaluate(() => document.getElementById('menu').hidden);
// Finish by warping.
for (let i = 1; i < out.ready || i < (await page.evaluate(() => window.__ready)); i++) { await page.evaluate((i) => Module._daily_debug_warp(i), i); await wait(250); }
await wait(5500);
await page.screenshot({ path: OUT + '-finish.png' });
out.card = await page.evaluate(() => (document.querySelector('#box h1') || {}).textContent);
out.results = await page.evaluate(() => window.__results);
out.errs = errs;
console.log(JSON.stringify(out));
await browser.close(); process.exit(0);
