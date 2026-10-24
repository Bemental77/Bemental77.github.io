// Course quality, per day: parts of different modules that occupy the same space, enemies crowding
// a cannon, and objects wearing a model their behavior never uses (a Boo that isn't a Boo).
//   node sm64daily/test_quality.mjs <firstDate> <days>   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const first = process.argv[2] || '2026-10-24', days = +(process.argv[3] || 1);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const TYPES = ['checker', 'box', 'piece', 'pole', 'firebar', 'obj', 'decor', 'isle'];
let bad = 0;
for (let k = 0; k < days; k++) {
  const d = new Date(first + 'T12:00:00'); d.setDate(d.getDate() + k);
  const date = d.toISOString().slice(0, 10);
  const page = await browser.newPage(); await page.setViewport({ width: 640, height: 480 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  if (process.env.NOREMAP) await page.evaluateOnNewDocument(() => { window.sm64DailyNoRemap = 1; });
  await page.goto(url + '?test=1&date=' + date + (process.env.Q || ''), { waitUntil: 'load' });
  await page.waitForSelector('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
  await page.click('#play');
  const ok = await page.waitForFunction('window.__ready', { timeout: 60000 }).then(() => true, () => false);
  const n = ok ? await page.evaluate(() => window.__ready) : 0;
  const q = await page.evaluate(() => {
    const D = Module, num = D._daily_debug_overlap(-1), pairs = [];
    const modOf = i => { for (let m = 0; D._daily_debug_mod_info(m, 0) >= 0; m++) if (i >= D._daily_debug_mod_info(m, 3) && i < D._daily_debug_mod_info(m, 4)) return D._daily_debug_mod_info(m, 0); return -1; };
    for (let p = 0; p < Math.min(num, 12); p++) {
      const v = D._daily_debug_overlap(p), i = Math.floor(v / 1000), j = v % 1000;
      const str = p => { let t = ''; if (p > 1) for (let a = p; D.HEAPU8[a]; a++) t += String.fromCharCode(D.HEAPU8[a]); return t; };
      const desc = x => [D._daily_debug_part(x, 3), modOf(x), D._daily_debug_part(x, 0), D._daily_debug_part(x, 1), D._daily_debug_part(x, 2), str(D._daily_debug_piece_name(x))];
      pairs.push([i, desc(i), j, desc(j)]);
    }
    return { overlaps: num, pairs, nearCannon: D._daily_debug_near_cannon(700) };
  });
  q.pairs = q.pairs.map(([i, a, j, b]) => `${i}:${TYPES[a[0]]}${a[5] ? '(' + a[5] + ')' : ''}/m${a[1]}@${a[2]},${a[3]},${a[4]} x ${j}:${TYPES[b[0]]}${b[5] ? '(' + b[5] + ')' : ''}/m${b[1]}@${b[2]},${b[3]},${b[4]}`);
  const badModels = new Set();
  for (let i = 0; i < n; i++) {
    await page.evaluate(i => Module._daily_debug_warp(i), i); await wait(500);
    const names = await page.evaluate(() => { const r = []; const c = Module._daily_debug_bad_models(-1);
      for (let i = 0; i < c; i++) { const p = Module._daily_debug_bad_models(i); let t = ''; if (p > 1) for (let a = p; Module.HEAPU8[a]; a++) t += String.fromCharCode(Module.HEAPU8[a]); r.push(t || '?'); } return r; });
    names.forEach(x => badModels.add(x));
  }
  // Up close to every extra and SM64 piece, so what spawns on approach (a hidden Moneybag's
  // Moneybag, a Boo from its cage...) spawns, then every live object's model again.
  const near = await page.evaluate(() => { const r = []; for (let i = 0; i < Module._daily_debug_num_parts(); i++) if (Module._daily_debug_part(i, 3) === 2) r.push([Module._daily_debug_part(i, 0), Module._daily_debug_part(i, 10), Module._daily_debug_part(i, 2)]); return r; });
  for (const [x, y, z] of near) {
    await page.evaluate((x, y, z) => Module._daily_debug_put(x, y, z - 120, 0), x, y + 150, z); await wait(1200);
    const names = await page.evaluate(() => { const r = []; const c = Module._daily_debug_bad_models(-1);
      for (let i = 0; i < c; i++) { const p = Module._daily_debug_bad_models(i); let t = ''; if (p > 1) for (let a = p; Module.HEAPU8[a]; a++) t += String.fromCharCode(Module.HEAPU8[a]); r.push(t || '?'); } return r; });
    names.forEach(x => badModels.add(x));
  }
  const good = q.overlaps === 0 && q.nearCannon === 0 && badModels.size === 0 && errs.length === 0;
  if (!good) bad++;
  console.log(JSON.stringify({ date, stations: n, ...q, badModels: [...badModels], errs, good }));
  await page.close();
}
console.log(JSON.stringify({ days, bad }));
await browser.close(); process.exit(bad ? 1 : 0);
