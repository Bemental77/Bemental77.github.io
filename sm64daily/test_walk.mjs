// Platforms must hold Mario where they are DRAWN, not just at their centre: warp onto each
// station, check he stands on it, then run toward its edge and check he is still on it (or
// on the next), not falling through.
//   node sm64daily/test_walk.mjs [?query]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = (process.env.URL || 'http://localhost:8080/sm64daily/') + (process.argv[2] || '');
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const page = await browser.newPage(); await page.setViewport({ width: 960, height: 720 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
await page.click('#play');
await page.waitForFunction('window.__ready', { timeout: 60000 });
const n = await page.evaluate(() => window.__ready);
const st = () => page.evaluate(() => ({ on: Module._daily_debug_standing(), y: Module._daily_debug_mario_y() }));
let fails = 0; const rows = [];
for (let i = 0; i < n; i++) {
  await page.evaluate((i) => Module._daily_debug_warp(i), i); await wait(900);
  const a = await st();
  await page.keyboard.down('KeyW'); await wait(600); await page.keyboard.up('KeyW'); await wait(500);
  const b = await st();
  const ok = a.on >= 0 && (b.on >= 0 || b.y > a.y - 150);
  if (!ok) fails++;
  rows.push(`${i}:${ok ? 'ok' : 'FAIL'}(on ${a.on}->${b.on}, y ${a.y}->${b.y})`);
}
console.log(rows.join('  '));
console.log(JSON.stringify({ stations: n, fails }));
await browser.close(); process.exit(fails ? 1 : 0);
