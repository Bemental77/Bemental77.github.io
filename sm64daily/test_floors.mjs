// Every floor is solid: for each station, box and stepping piece of a day's course, with Mario over
// the spot, there is collision at its top at the centre and near each end (not a drawn floor he falls through).
//   node sm64daily/test_floors.mjs <firstDate> <days>   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const first = process.argv[2] || '2026-10-24', days = +(process.argv[3] || 1);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const R_STEP = 0, R_LONGSTEP = 1, R_LIFT = 6;
let bad = 0;
for (let k = 0; k < days; k++) {
  const d = new Date(first + 'T12:00:00'); d.setDate(d.getDate() + k);
  const date = d.toISOString().slice(0, 10);
  const page = await browser.newPage(); await page.setViewport({ width: 640, height: 480 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  await page.goto(url + '?test=1&date=' + date + (process.env.Q || ''), { waitUntil: 'load' });
  await page.waitForSelector('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
  await page.click('#play');
  await page.waitForFunction('window.__ready', { timeout: 60000 });
  await wait(800);
  const parts = await page.evaluate(() => {
    const D = Module, out = [];
    const str = p => { let t = ''; if (p > 1) for (let a = p; D.HEAPU8[a]; a++) t += String.fromCharCode(D.HEAPU8[a]); return t; };
    for (let i = 0; i < D._daily_debug_num_parts(); i++) {
      const f = j => D._daily_debug_part(i, j);
      out.push({ i, type: f(3), x: f(0), y: f(1), z: f(2), yaw: f(7), top: f(10), role: f(11), ex: f(12), ez: f(13), cd: f(14), pitch: f(15), name: str(D._daily_debug_piece_name(i)) });
    }
    return out;
  });
  const floors = parts.filter(p => p.type <= 1 || (p.type === 2 && [R_STEP, R_LONGSTEP, R_LIFT].includes(p.role)));
  const fails = [];
  let tried = 0;
  for (const p of floors) {
    const a = p.yaw / 65536 * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    // Local (x, z) -> world, as SM64 rotates an object's collision by its yaw.
    const pts = p.type === 2 ? [[0, 0], [0.6 * p.ex, 0], [-0.6 * p.ex, 0], [0, 0.6 * p.ez], [0, -0.6 * p.ez]] : [[0, 0], [0.75 * p.ex, 0], [-0.75 * p.ex, 0], [0, 0.75 * p.ez], [0, -0.75 * p.ez]];
    const pf = [];
    for (const [lx, lz] of (p.pitch ? pts.slice(0, 1) : pts)) {   // a ramp's ends are above or below its top
      const x = Math.round(p.x + lx * c + lz * s), z = Math.round(p.z - lx * s + lz * c);
      // Mario above the spot (so collision is loaded as it would be with him there), then: is there
      // floor under it at the part's top?
      await page.evaluate((x, y, z) => Module._daily_debug_put(x, y, z, 0), x, p.top + 400, z);
      await wait(120);
      // Pieces move (lifts, sinkers, spinners): any floor of an object in the column will do.
      const fy = await page.evaluate((x, y, z) => [Module._daily_debug_floor(x, y, z, 0), Module._daily_debug_floor(x, y, z, 2)], x, p.top + (p.type === 2 ? 2500 : 60), z);
      tried++;
      if (!(fy[1] === 1 && fy[0] >= p.top - (p.type === 2 ? 1500 : 40))) pf.push({ part: p.i, type: p.type, name: p.name, at: [lx | 0, lz | 0], floorY: fy[0], object: fy[1], top: p.top, collDist: p.cd });
    }
    // A piece turns (rotators, spinners, bridges): its centre and at least two of its ends.
    if (p.type === 2 ? (pf.some(f => f.at[0] === 0 && f.at[1] === 0) || pf.length > 2) : pf.length) fails.push(...pf);
  }
  const good = fails.length === 0 && errs.length === 0;
  if (!good) bad++;
  console.log(JSON.stringify({ date, floors: floors.length, drops: tried, fails: fails.length, good }));
  for (const f of fails) console.log('  ' + JSON.stringify(f));
  await page.close();
}
console.log(JSON.stringify({ days, bad }));
await browser.close(); process.exit(bad ? 1 : 0);
