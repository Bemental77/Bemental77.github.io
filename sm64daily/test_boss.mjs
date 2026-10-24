// Boss Battles: each boss spawns on its arena and stays there; the Big Bully, knocked into his lava
// moat, dies and his star flies to the arena; touching it ends the run with the dance.
//   node sm64daily/test_boss.mjs [outPrefix]   (URL=http://localhost:8090/sm64daily/)
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
const OUT = process.argv[2] || '/tmp/sm64boss';
const url = process.env.URL || 'http://localhost:8080/sm64daily/';
const SEEDS = { 'King Bob-omb': 'b10', 'King Whomp': 'b20', 'Big Bully': 'b12', 'Wiggler': 'b4', 'Big Boo': 'b3' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
try { (await import('../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
for (const [name, w] of Object.entries(SEEDS)) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await page.evaluateOnNewDocument(() => { window.__ready = null; window.__results = []; });
  await page.goto(url + '?w=' + w, { waitUntil: 'load' });
  await page.waitForSelector('#play', { timeout: 20000 });
  const chip = await page.evaluate(() => document.querySelector('.chip.mode').textContent);
  await page.click('#play');
  await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (n, p) => { window.__ready = n; r(n, p); }; const q = window.sm64DailyResult; window.sm64DailyResult = (...a) => { window.__results.push(a); q(...a); }; });
  await page.waitForFunction('window.__ready !== null', { timeout: 60000 });
  await wait(1000);
  const D = (f, ...a) => page.evaluate((f, a) => Module['_daily_debug_' + f](...a), f, a);
  const stations = await page.evaluate(() => window.__ready);
  const mode = await D('mode');
  let boss = -1; for (let i = 0; i < await D('num_dyn'); i++) if ((await D('dyn', i, 0)) === 10) boss = i;
  const arenaPart = await D('dyn', boss, 5), arenaY = await D('part', arenaPart, 1);
  await D('warp', stations - 2); await wait(800);
  await D('warp', stations - 1); await wait(3000);
  const b = { alive: await D('dyn', boss, 4), dy: (await D('dyn', boss, 2)) - arenaY };
  await page.screenshot({ path: `${OUT}-${w}.png` });
  const out = { name, w, chip, mode, bossAlive: b.alive, bossAboveArena: b.dy, errs };
  if (name === 'Big Bully') {
    // Shove him off the arena onto the lava moat below its edge.
    const ax = await D('part', arenaPart, 0), az = await D('part', arenaPart, 2), hx = await D('part', arenaPart, 5);
    await D('dyn_move', boss, ax + hx + 300, arenaY + 50, az);
    let star = null;
    for (let t = 0; t < 40 && !star; t++) { await wait(250); const sy = await D('star', 1); if (sy !== -99999) star = { y: sy, homeY: await D('star', 3) }; }
    out.bullyDied = !(await D('dyn', boss, 4));
    out.starHomeAboveArena = star ? star.homeY - arenaY : null;
    // Wait for it to arrive, then touch it.
    await wait(6000);
    const sx = await D('star', 0), sy = await D('star', 1), sz = await D('star', 2);
    if (sy !== -99999) { await D('put', sx, sy - 60, sz, 0); }
    await wait(6000);
    out.finished = await page.evaluate(() => window.__results.map(r => r[0]));
    await page.screenshot({ path: `${OUT}-${w}-finish.png` });
  }
  console.log(JSON.stringify(out));
  await page.close();
}
await browser.close(); process.exit(0);
