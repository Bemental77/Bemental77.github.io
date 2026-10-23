// Saved run -> ghost link: finish a course, read the saved best run, open its share link in a
// fresh page, and check the ghost is announced and rendered.
//   node sm64daily/test_ghost.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64ghost';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const boot = async (page, u) => {
  await page.goto(u, { waitUntil: 'load' });
  await page.waitForSelector('#play'); const intro = await page.evaluate(() => document.getElementById('box').innerText);
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
  await page.click('#play');
  await page.waitForFunction('window.__ready', { timeout: 60000 });
  return intro;
};
const p1 = await browser.newPage(); await p1.setViewport({ width: 960, height: 720 });
await boot(p1, url);
const n = await p1.evaluate(() => window.__ready);
for (let i = 1; i < n; i++) { await p1.evaluate((i) => Module._daily_debug_warp(i), i); await wait(700); }
await p1.waitForSelector('#share', { timeout: 20000 });
const best = await p1.evaluate(() => { const s = JSON.parse(localStorage.getItem('sm64daily.v3')); return Object.values(s.days)[0].best; });
const share = await p1.evaluate(() => document.getElementById('share').innerText);
console.log('saved run: frames', best.frames, 'path chars', best.path ? best.path.length : 0);
console.log('share text:\n' + share);
const link = url + '#d=' + Object.keys(await p1.evaluate(() => JSON.parse(localStorage.getItem('sm64daily.v3')).days))[0] + '&t=' + best.frames + '&n=Casey&g=' + best.path;
console.log('link length', link.length);
const p2 = await browser.newPage(); await p2.setViewport({ width: 960, height: 720 });
const intro2 = await boot(p2, link);
console.log('friend intro:', intro2.split('\n').slice(0, 6).join(' | '));
await p2.evaluate(() => Module._daily_debug_warp(1)); await wait(1500);
await p2.screenshot({ path: OUT + '-friend.png' });
await browser.close(); process.exit(0);
