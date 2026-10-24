// How often each module and challenge is generated, over many seeds on each world.
//   node sm64daily/test_tally.mjs [seedsPerWorld]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const per = +(process.argv[2] || 20);
const NAMES = ['HOP', 'STEPPING', 'DOUBLE_STEPPING', 'THWOMP', 'PENDULUM', 'FIREBAR', 'LONG', 'POWER_STEP', 'TRIPLE', 'WALLKICK', 'POLE', 'SLIDE',
  'ENEMIES', 'AMPS', 'CANNON', 'SWITCH', 'SHELL', 'VANISH', 'METAL', 'WING', 'BARS', 'SAND', 'ICE', 'WIND', 'UPDRAFT', 'POOL', 'GAS', 'BOSS',
  'LEDGES', 'LONGCHAIN', 'CRAWL', 'BREAKWALL', 'PUSHBOX', 'BLUECOIN', 'KICKBOARD', 'GROUND', 'HAZARD'];
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const tally = {}, modes = [0, 0, 0, 0, 0], short = []; let autoSum = 0, distinctSets = new Set();
for (let h = 0; h < 16; h++) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__ready = null; });
  await page.goto(url + '?test=1&host=' + h, { waitUntil: 'load' });
  await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
  const r = await page.evaluate((h, per) => {
    const out = [];
    for (let i = 0; i < per; i++) {
      const seed = (Math.imul(i + 1, 0x9E3779B1) ^ (h * 7919)) | 0;
      Module._daily_debug_gen(seed, i % 7);
      const mods = []; for (let k = 0; ; k++) { const m = Module._daily_debug_modules(k); if (m < 0) break; mods.push(m); }
      out.push({ mode: Module._daily_debug_mode(), mods, info: Module._daily_debug_gen_info(), auto: Module._daily_debug_auto() });
    }
    return out;
  }, h, per);
  for (const x of r) {
    modes[x.mode]++; autoSum += x.auto; distinctSets.add([...new Set(x.mods)].sort().join(','));
    for (const m of x.mods) tally[NAMES[m]] = (tally[NAMES[m]] || 0) + 1;
    if (x.info % 10000 < 97) short.push([h, x.info]);
  }
  await page.close();
}
console.log(JSON.stringify({ courses: 16 * per, modes, avgAutoPiecesDrawn: autoSum / (16 * per), distinctModuleSets: distinctSets.size, tally, never: NAMES.filter(n => !tally[n]), shortCourses: short.length, shortSample: short.slice(0, 8) }));
await browser.close(); process.exit(0);
