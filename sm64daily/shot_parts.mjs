// Screenshot parts of a day's course: Mario is put `back` in front of each part, facing it.
//   node sm64daily/shot_parts.mjs <date> <part,part,...> [outPrefix]
import puppeteer from 'puppeteer';
const url = process.env.URL || 'http://localhost:8090/sm64daily/', date = process.argv[2], parts = process.argv[3].split(',').map(Number), out = process.argv[4] || '/tmp/sm64shot';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--mute-audio', '--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage(); await page.setViewport({ width: 800, height: 600 });
await page.goto(url + '?test=1&date=' + date, { waitUntil: 'load' });
await page.waitForSelector('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
await page.click('#play');
await page.waitForFunction('window.__ready', { timeout: 60000 });
const wait = ms => new Promise(r => setTimeout(r, ms));
for (const i of parts) {
  const p = await page.evaluate(i => { const f = j => Module._daily_debug_part(i, j); return { x: f(0), y: f(1), z: f(2), top: f(10) }; }, i);
  const back = +(process.env.BACK || 500), yaw = 0;   // Mario south of it, facing +z (yaw 0)
  await page.evaluate((x, y, z) => Module._daily_debug_put(x, y, z, 0), p.x, p.top + 300, p.z - back);
  await wait(2500);
  await page.screenshot({ path: `${out}-${date}-${i}.png` });
  console.log(i, JSON.stringify(p), `${out}-${date}-${i}.png`);
}
await browser.close();
