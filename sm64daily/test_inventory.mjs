// Every inventory object (sAuto, daily_lib.inc.h) spawns next to Mario on a course and runs 3 seconds
// without crashing the game. One fresh page per object, so one crash doesn't hide the next.
//   node sm64daily/test_inventory.mjs [from] [to]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const lib = fs.readFileSync(process.env.LIB || '/Users/caseybement/gc_refs/sm64-port/src/game/daily_lib.inc.h', 'utf8');
const names = [...lib.matchAll(/^\s*\{ "(\w+)"/gm)].map(m => m[1]);
const from = +(process.argv[2] || 0), to = +(process.argv[3] || names.length);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
const bad = [];
for (let k = from; k < to; k++) {
  const page = await browser.newPage(); const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + '?test=1&bare=1&host=0&seed=12345', { waitUntil: 'load' }); await page.waitForSelector('#play'); await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 }).catch(() => {});
  await wait(800);
  const pre = errs.length;
  await page.evaluate(k => Module._daily_debug_spawn_auto(k), k).catch(e => errs.push(String(e).slice(0, 120)));
  await wait(3000);
  const alive = await page.evaluate(() => { try { return Module._daily_debug_mario_y() !== undefined; } catch (e) { return false; } }).catch(() => false);
  const ok = errs.length === pre && alive;
  if (!ok) bad.push(names[k]);
  console.log(JSON.stringify({ k, name: names[k], ok, errs: errs.slice(pre, pre + 1) }));
  await page.close();
}
console.log(JSON.stringify({ crashers: bad }));
await browser.close(); process.exit(0);
