// The camera stays Lakitu's free-roam camera (mode 0x10) all along a course: warp to every platform and
// sample the mode — no host-level trigger may lock it (fixed, 8-direction, radial...).
//   node sm64daily/test_camera.mjs query...   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
for (const q of process.argv.slice(2)) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + q, { waitUntil: 'load' }); await page.waitForSelector('#play'); await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
  const n = await page.evaluate(() => window.__ready), modes = {};
  for (let i = 0; i < n; i++) { await page.evaluate(i => Module._daily_debug_warp(i), i); for (let t = 0; t < 3; t++) { await wait(250); const m = await page.evaluate(() => Module._daily_debug_cammode()); modes[m] = (modes[m] || 0) + 1; } }
  console.log(JSON.stringify({ q, platforms: n, cameraModes: modes }));
  await page.close();
}
await browser.close(); process.exit(0);
