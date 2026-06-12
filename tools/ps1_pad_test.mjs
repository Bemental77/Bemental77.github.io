// PS1 mobile-controls chain test v2: tap splash Start, wait for the page
// Module runtime (pcsx_ww.js) to init, then press touch buttons via CDP and
// read the pad bytes at Module._get_ptr(1). Captures any 404s en route.
import puppeteer from 'puppeteer';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:8080/ps1.html?mobile';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'],
});
const page = await browser.newPage();
await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(-80), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http' + r.status() + ']', r.url().slice(-90)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000)); // coi reload settle

const cdp = await page.target().createCDPSession();
async function touchAt(x, y, down) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: down ? 'touchStart' : 'touchEnd',
    touchPoints: down ? [{ x, y }] : [],
  });
}
async function tap(id) {
  const el = await page.$('#' + id);
  if (!el) { console.log('MISSING', id); return false; }
  const box = await el.boundingBox();
  if (!box) { console.log('NO BOX', id); return false; }
  await touchAt(box.x + box.width / 2, box.y + box.height / 2, true);
  await new Promise((r) => setTimeout(r, 80));
  await touchAt(0, 0, false);
  return true;
}

console.log('tapping splash start...');
await tap('mobileSplashStart');

// Wait for the page Module runtime (var_setup ran -> _get_ptr available)
let ready = false;
for (let i = 0; i < 45; i++) {
  ready = await page.evaluate(() =>
    typeof Module !== 'undefined' && !!Module.HEAPU8 && typeof Module._get_ptr === 'function');
  if (ready) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('Module runtime ready:', ready,
            '| worker:', await page.evaluate(() => !!window.pcsx_worker));
if (!ready) { await browser.close(); process.exit(1); }

const readPad = () => page.evaluate(() => {
  const p = Module._get_ptr(1);
  return [Module.HEAPU8[p + 6], Module.HEAPU8[p + 7]];
});
console.log('pad idle:', JSON.stringify(await readPad()));

async function hold(id, ms) {
  const el = await page.$('#' + id);
  const box = await el.boundingBox();
  await touchAt(box.x + box.width / 2, box.y + box.height / 2, true);
  await new Promise((r) => setTimeout(r, ms));
  const held = await readPad();
  const cls = await page.evaluate((i) => document.getElementById(i).className, id);
  await touchAt(0, 0, false);
  await new Promise((r) => setTimeout(r, 250));
  const released = await readPad();
  console.log(id, 'held:', JSON.stringify(held), 'class:', JSON.stringify(cls),
              '-> released:', JSON.stringify(released));
}

await hold('mobileCross', 300);   // expect b1: 0xFF -> 0xBF (bit6 clear) -> 0xFF
await hold('mobileStart', 300);   // expect b0: 0xFF -> 0xF7 (bit3 clear) -> 0xFF
// dpad up: top edge of the disc
{
  const el = await page.$('#mobileDpadDisc');
  if (el) {
    const box = await el.boundingBox();
    await touchAt(box.x + box.width / 2, box.y + 6, true);
    await new Promise((r) => setTimeout(r, 300));
    const held = await readPad();
    await touchAt(0, 0, false);
    await new Promise((r) => setTimeout(r, 250));
    console.log('dpad-up held:', JSON.stringify(held), '-> released:', JSON.stringify(await readPad()));
  } else console.log('MISSING mobileDpadDisc');
}
await browser.close();
