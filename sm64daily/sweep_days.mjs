// Every day must have a playable course: for N consecutive dates, boot the day's course and
// check its size, that Mario stands on and runs across every station, and that the goal finishes.
//   node sm64daily/sweep_days.mjs <firstDate> <days>   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const first = process.argv[2] || '2026-10-23', days = +(process.argv[3] || 30);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = ['Castle Grounds', 'BoB', 'WF', 'JRB', 'CCM', 'SSL', 'LLL', 'SL', 'TTM', 'THI', 'RR', 'BitDW', 'BitFS', 'BitS', 'DDD', 'Courtyard'];
let bad = 0;
for (let k = 0; k < days; k++) {
  const d = new Date(first + 'T12:00:00'); d.setDate(d.getDate() + k);
  const date = d.toISOString().slice(0, 10);
  const page = await browser.newPage(); await page.setViewport({ width: 640, height: 480 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  await page.goto(url + '?test=1&date=' + date + (process.env.Q || ''), { waitUntil: 'load' });
  await page.waitForSelector('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); };
    const q = window.sm64DailyResult; window.sm64DailyResult = (...a) => { window.__res = a; q(...a); }; });
  await page.click('#play');
  const ok = await page.waitForFunction('window.__ready', { timeout: 60000 }).then(() => true, () => false);
  const n = ok ? await page.evaluate(() => window.__ready) : 0;
  const host = await page.evaluate(() => window.sm64DailyHost);
  const mods = await page.evaluate(() => (window.sm64DailyModules || []).length);
  let walkFails = 0; const failAt = [];
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => Module._daily_debug_warp(i), i); await wait(700);
    const a = await page.evaluate(() => ({ on: Module._daily_debug_standing(), y: Module._daily_debug_mario_y() }));
    await page.keyboard.down('KeyW'); await wait(500); await page.keyboard.up('KeyW'); await wait(400);
    const b = await page.evaluate((i) => ({ on: Module._daily_debug_standing(), y: Module._daily_debug_mario_y(), inside: Module._daily_debug_inside(i) }), i);
    // A fall only counts if Mario was still over the platform's footprint: running off an edge is fine.
    if (a.on < 0 || (b.on < 0 && b.y < a.y - 150 && b.inside === 1)) { walkFails++; failAt.push(i + (a.on < 0 ? ':nostand' : ':fellthrough')); }
  }
  await page.evaluate((n) => Module._daily_debug_warp(n - 1), n); await wait(1500);
  const res = await page.evaluate(() => window.__res || null);
  const good = n >= 20 && walkFails === 0 && res && res[0] === 1 && errs.length === 0;
  if (!good) bad++;
  console.log(JSON.stringify({ date, world: HOSTS[host], stations: n, modules: mods, walkFails, failAt, finished: !!(res && res[0]), errs: errs.length, good }));
  await page.close();
}
console.log(JSON.stringify({ days, bad }));
await browser.close(); process.exit(bad ? 1 : 0);
