// Same course on two builds? Compares stations/parts (minus extras) and every enemy/coin, per date.
//   node sm64daily/cmp_course.mjs <urlA> <urlB> <firstDate> <days>
import puppeteer from 'puppeteer';
const [A, B, first, days] = [process.argv[2], process.argv[3], process.argv[4] || '2026-10-17', +(process.argv[5] || 8)];
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--no-sandbox'] });
async function course(url, date) {
  const page = await browser.newPage();
  await page.goto(url + '?test=1&date=' + date, { waitUntil: 'load' });
  await page.waitForSelector('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
  await page.click('#play');
  await page.waitForFunction('window.__ready', { timeout: 60000 });
  const c = await page.evaluate(() => { const D = Module, parts = [], dyn = [];
    for (let i = 0; i < D._daily_debug_num_parts(); i++) { const f = j => D._daily_debug_part(i, j); if (f(3) === 2 && f(5) === 0 && f(6) === 0 && f(4) === 0) {} parts.push([f(3), f(0), f(1), f(2)].join(',')); }
    for (let i = 0; i < D._daily_debug_num_dyn(); i++) dyn.push([0, 5, 6].map(f => D._daily_debug_dyn(i, f)).concat(D._daily_debug_dyn(i, 4) ? [] : [1, 2, 3].map(f => D._daily_debug_dyn(i, f))).join(','));
    return { stations: window.__ready, parts, dyn }; });
  await page.close();
  return c;
}
let diff = 0;
for (let k = 0; k < days; k++) {
  const d = new Date(first + 'T12:00:00'); d.setDate(d.getDate() + k); const date = d.toISOString().slice(0, 10);
  const a = await course(A, date), b = await course(B, date);
  const sameDyn = JSON.stringify(a.dyn) === JSON.stringify(b.dyn), sameSt = a.stations === b.stations;
  // Parts: the course's own parts come first; extras (piece parts after the last station) may move.
  const n = Math.min(a.parts.length, b.parts.length); let firstDiff = -1; for (let i = 0; i < n; i++) if (a.parts[i] !== b.parts[i]) { firstDiff = i; break; }
  if (!sameDyn || !sameSt) diff++;
  console.log(JSON.stringify({ date, stations: [a.stations, b.stations], parts: [a.parts.length, b.parts.length], firstPartDiff: firstDiff, dyn: [a.dyn.length, b.dyn.length], sameDyn }));
}
await browser.close(); process.exit(diff ? 1 : 0);
