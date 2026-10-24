// Boot several days / words, report the challenge, modules and errors, and screenshot each.
//   node sm64daily/test_boot.mjs outPrefix query1 query2 ...   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64boot';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const qs = process.argv.slice(3);
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const wait = ms => new Promise(r => setTimeout(r, ms));
for (const [i, q] of qs.entries()) {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + q, { waitUntil: 'load' });
  await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = [n, p]; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 }).catch(() => {});
  await wait(2500);
  await page.screenshot({ path: `${OUT}-${i}.png` });
  const info = await page.evaluate(() => window.__ready && ({ ready: window.__ready, mode: window.sm64DailyMode, host: window.sm64DailyHost, theme: window.sm64DailyTheme, style: window.sm64DailyStyle,
    mods: (window.sm64DailyModules || []).join(','), obj: Module._daily_debug_objective(), y: Module._daily_debug_mario_y(), on: Module._daily_debug_standing() }));
  console.log(JSON.stringify({ q, info, errs: errs.filter(e => !/favicon/.test(e)).slice(0, 3) }));
  await page.close();
}
await browser.close(); process.exit(0);
