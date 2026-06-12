// End-to-end test for the refreshed /n64/ page (n64/index.html).
//
//   node tools/n64_page_test.mjs [rom-filename.z64]
//
// Desktop pass: ?game=<rom>&autostart — asserts the core boots, frames advance,
// and the canvas shows non-black content.
// Mobile pass: ?mobile — taps the splash Start, then exercises the touch
// overlay (A button + analog stick) and asserts each reaches the core by
// spying on myApp.sendMobileControls (the cwrap the core's per-frame pull
// invokes). Emits one JSON line.
import puppeteer from 'puppeteer';

const rom = process.argv[2] || 'mariokart.z64';
const base = 'http://localhost:8080/n64/';
const result = { rom, desktop: {}, mobile: {} };

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});

async function newPage(r) {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  r.consoleErrors = []; r.pageErrors = []; r.failedRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') r.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => r.pageErrors.push(String(e).slice(0, 200)));
  page.on('response', (resp) => { if (resp.status() >= 400) r.failedRequests.push(`${resp.url()} HTTP${resp.status()}`); });
  return page;
}

const waitRunning = (page) => page.waitForFunction('window.myApp && myApp.rivetsData && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 90000 });

try {
  // ---------- desktop ----------
  {
    const d = result.desktop;
    const page = await newPage(d);
    await page.goto(`${base}?game=${rom}&autostart`, { waitUntil: 'domcontentloaded' });
    await waitRunning(page);
    await new Promise((r2) => setTimeout(r2, +(process.env.N64_SETTLE_MS || 12000)));
    const f0 = await page.evaluate(() => new Promise((res) => { let n = 0; const o = requestAnimationFrame; const c = () => { n++; if (n < 120) o(c); else res(n); }; o(c); }));
    d.rafAlive = f0 >= 120;
    d.status = await page.evaluate(() => document.getElementById('status').textContent);
    d.fpsText = await page.evaluate(() => document.getElementById('fps').textContent);
    const canvas = await page.$('#canvas');
    const shot = await canvas.screenshot({ path: `/tmp/n64-sweep/page-desktop-${rom.replace(/\.z64$/, '')}.png` });
    d.luminance = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const dd = x.getImageData(0, 0, c.width, c.height).data;
      let s = 0; for (let i = 0; i < dd.length; i += 4) s += (dd[i] + dd[i + 1] + dd[i + 2]) / 3;
      return Math.round(s / (dd.length / 4));
    }, 'data:image/png;base64,' + shot.toString('base64'));
    d.ok = d.rafAlive && d.status === 'Running.' && d.luminance > 2;
    await page.close();
  }

  // ---------- mobile ----------
  {
    const m = result.mobile;
    const page = await newPage(m);
    await page.setViewport({ width: 850, height: 400, hasTouch: true, isMobile: true });
    await page.goto(`${base}?mobile&game=${rom}`, { waitUntil: 'domcontentloaded' });
    m.splashVisible = await page.evaluate(() => getComputedStyle(document.getElementById('mobileSplash')).display === 'flex');
    const tap = async (sel) => {
      const el = await page.$(sel); const b = await el.boundingBox();
      const cdp = await page.target().createCDPSession();
      const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    await tap('#mobileSplashStart');
    await waitRunning(page);
    await new Promise((r2) => setTimeout(r2, 4000));
    // spy on the core-bound input call
    await page.evaluate(() => {
      window.__sent = [];
      const orig = myApp.sendMobileControls.bind(myApp);
      myApp.sendMobileControls = (s, x, y) => { window.__sent.push([s, x, y]); return orig(s, x, y); };
    });
    const holdCheck = async (sel, charIdx) => {
      const el = await page.$(sel); const b = await el.boundingBox();
      const cdp = await page.target().createCDPSession();
      const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await new Promise((r2) => setTimeout(r2, 400));
      const held = await page.evaluate((i) => { const l = window.__sent.at(-1); return l && l[0][i] === '1'; }, charIdx);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await new Promise((r2) => setTimeout(r2, 400));
      const released = await page.evaluate((i) => { const l = window.__sent.at(-1); return l && l[0][i] === '0'; }, charIdx);
      await cdp.detach();
      return held && released;
    };
    m.buttonA = await holdCheck('#mobileA', 4);       // char 4 = A
    m.buttonStart = await holdCheck('#mobileStart', 6); // char 6 = START
    m.buttonZ = await holdCheck('#mobileZ', 7);       // char 7 = Z
    // stick: touch upper area of the disc -> y should go positive
    {
      const el = await page.$('#mobileStickDisc'); const b = await el.boundingBox();
      const cdp = await page.target().createCDPSession();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height * 0.15 }] });
      await new Promise((r2) => setTimeout(r2, 400));
      const up = await page.evaluate(() => { const l = window.__sent.at(-1); return l && parseFloat(l[2]) > 0.5; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await new Promise((r2) => setTimeout(r2, 400));
      const centered = await page.evaluate(() => { const l = window.__sent.at(-1); return l && Math.abs(parseFloat(l[2])) < 0.01; });
      await cdp.detach();
      m.stickUp = up && centered;
    }
    const canvas = await page.$('#mobileScreen canvas');
    if (canvas) await canvas.screenshot({ path: `/tmp/n64-sweep/page-mobile-${rom.replace(/\.z64$/, '')}.png` }).catch(() => {});
    m.sentCount = await page.evaluate(() => window.__sent.length);
    m.ok = !!(m.splashVisible && m.buttonA && m.buttonStart && m.buttonZ && m.stickUp);
    await page.close();
  }
} catch (e) {
  result.error = String(e).slice(0, 500);
} finally {
  await browser.close();
}
for (const k of ['desktop', 'mobile']) {
  result[k].consoleErrors = (result[k].consoleErrors || []).slice(0, 6);
  result[k].failedRequests = (result[k].failedRequests || []).slice(0, 6);
}
console.log(JSON.stringify(result, null, 1));
