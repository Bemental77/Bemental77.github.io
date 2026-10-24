// Every day gets its own course: for each date in a range, build that date's course (in the real
// game, over that date's world) and check no two dates share a world+layout, and each is full length.
//   node sm64daily/test_unique.mjs [firstDate] [days]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const first = process.argv[2] || '2026-10-23', days = +(process.argv[3] || 365);
const NH = 16;
function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const dates = [];
for (let i = 0; i < days; i++) { const d = new Date(first + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + i); dates.push(d.toISOString().slice(0, 10)); }
const info = dates.map(date => { const seed = hash('sm64daily:' + date) | 0; return { date, seed, dow: new Date(date + 'T12:00:00').getDay(), host: ((Math.imul(seed, 2654435761) >>> 0) >>> 8) % NH }; });
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = [];
for (let h = 0; h < NH; h++) {
  const mine = info.filter(x => x.host === h);
  if (!mine.length) continue;
  const page = await browser.newPage();
  // Load the page on one of this world's own dates, so the world is chosen the normal way (no override).
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + '?date=' + mine[0].date, { waitUntil: 'load' });
  await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 90000 });
  const world = await page.evaluate(() => window.sm64DailyHost);
  const res = await page.evaluate((mine) => mine.map(x => {
    const a = Module._daily_debug_gen(x.seed, x.dow) >>> 0, b = Module._daily_debug_gen(x.seed, x.dow) >>> 0;
    const inf = Module._daily_debug_gen_info();
    return { ...x, layout: a, repeatable: a === b, stations: Math.floor(inf / 10000), secs: inf % 10000 };
  }), mine);
  for (const r of res) { r.world = world; out.push(r); }
  console.log(`world ${h} (page says ${world}): ${res.length} days, stations ${Math.min(...res.map(r => r.stations))}-${Math.max(...res.map(r => r.stations))}`);
  await page.close();
}
await browser.close();
const key = r => r.world + ':' + r.layout;
const seen = new Map(), dup = [];
for (const r of out) { if (seen.has(key(r))) dup.push([seen.get(key(r)), r.date]); else seen.set(key(r), r.date); }
const short = out.filter(r => r.stations < 15), notRepeatable = out.filter(r => !r.repeatable), wrongWorld = out.filter(r => r.world !== r.host);
console.log(JSON.stringify({ days: out.length, unique: seen.size, duplicates: dup, short: short.map(r => [r.date, r.stations]), notRepeatable: notRepeatable.map(r => r.date), wrongWorld: wrongWorld.length,
  worldsUsed: [...new Set(out.map(r => r.world))].length, minStations: Math.min(...out.map(r => r.stations)), maxStations: Math.max(...out.map(r => r.stations)) }));
process.exit(0);
