// End-to-end test for the refreshed /n64/ page (n64/index.html).
//
//   node tools/n64_page_test.mjs [rom-filename.z64]
//
// Desktop pass: ?game=<rom>&autostart — asserts the core boots, frames advance,
// and the canvas shows non-black content.
// Mobile pass: ?mobile — taps the splash Start, then exercises the touch
// overlay (A button + analog stick) and asserts each reaches the core by
// spying on myApp.sendMobileControls (the cwrap the core's per-frame pull
// invokes).
// Ratetest pass: ?ratetest=1 — runs the page's own rate-model suite (synthetic
// timings + two real captures) with no emulator, and requires zero failures.
// Meter pass: boots the ROM and asserts the LIVE WIRING the ratetest cannot
// reach — that the cartridge region actually reached the model, that the core's
// frame counters were actually found in its heap, and that the headline the
// user reads is the four-term one and not the old bare "FPS: n".
// Diag pass: opens the diagnostics panel and requires the GPU capability line
// to sit ABOVE the rolling tail (the crux cannot be allowed to scroll away).
// Invariants pass: /n64/ must NOT pull coi-serviceworker.js and must load every
// UI dependency from its own origin.
// Emits one JSON line.
import puppeteer from 'puppeteer';

const rom = process.argv[2] || 'mariokart.z64';
const base = process.env.N64_PAGE_URL || 'http://localhost:8080/n64/';
const result = { rom, desktop: {}, mobile: {}, ratetest: {}, meter: {}, diag: {}, invariants: {} };

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});

async function newPage(r) {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  // Accumulate rather than reset: a pass may open more than one page and all of it counts.
  r.consoleErrors = r.consoleErrors || []; r.pageErrors = r.pageErrors || [];
  r.failedRequests = r.failedRequests || []; r.offOrigin = r.offOrigin || [];
  page.on('console', (m) => { if (m.type() === 'error') r.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => r.pageErrors.push(String(e).slice(0, 200)));
  page.on('response', (resp) => { if (resp.status() >= 400) r.failedRequests.push(`${resp.url()} HTTP${resp.status()}`); });
  // The page self-hosts jQuery/rivets/toastr/FileSaver in /n64/vendor/ precisely so a sibling
  // emulator page's coi service worker cannot break it by isolating this origin. Anything
  // fetched off-origin is a regression of that property.
  page.on('request', (req) => {
    const u = req.url();
    if (!/^https?:\/\/localhost:8080\//.test(u) && !/^(data|blob):/.test(u)) r.offOrigin.push(u.slice(0, 160));
  });
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
    // The bug protocol's step 2: the diagnostics report must be reachable from the PHONE, and
    // BEFORE Start — that pre-boot report is the clean baseline, and it is the only one a device
    // that dies during boot will ever be able to send.
    m.splashDiagVisible = await page.evaluate(() => {
      const b = document.getElementById('mobileSplashDiag');
      return !!b && b.getBoundingClientRect().height > 0;
    });
    if (m.splashDiagVisible) {
      await tap('#mobileSplashDiag');
      await new Promise((r2) => setTimeout(r2, 300));
      m.splashDiagOpens = await page.evaluate(() => document.getElementById('diagPanel').classList.contains('open'));
      m.splashDiagVerdict = await page.evaluate(() => document.getElementById('diagVerdict').textContent.slice(0, 80));
      await page.evaluate(() => document.getElementById('diagClose').click());
      await new Promise((r2) => setTimeout(r2, 200));
    }
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
    m.ok = !!(m.splashVisible && m.buttonA && m.buttonStart && m.buttonZ && m.stickUp &&
              m.splashDiagVisible && m.splashDiagOpens && /^>> /.test(m.splashDiagVerdict || ''));
    await page.close();
  }

  // ---------- rate-model self-test (?ratetest=1), no emulator ----------
  {
    const t = result.ratetest;
    const page = await newPage(t);
    await page.goto(`${base}?ratetest=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__n64RateTest', { timeout: 30000 });
    const r = await page.evaluate(() => ({
      pass: window.__n64RateTest.pass, fail: window.__n64RateTest.fail,
      failures: window.__n64RateTest.lines.filter((l) => l.indexOf('RATETEST FAIL') === 0).slice(0, 12),
    }));
    Object.assign(t, r);
    // ?ratetest must not boot anything: a suite that quietly needs the emulator is not a suite.
    t.noEmulator = await page.evaluate(() => !window.myApp && !window.Module);
    t.ok = r.fail === 0 && r.pass >= 50 && t.noEmulator && t.pageErrors.length === 0;
    await page.close();
  }

  // ---------- live meter: the wiring ?ratetest=1 structurally cannot reach ----------
  {
    const t = result.meter;
    const page = await newPage(t);
    await page.goto(`${base}?game=${rom}&autostart`, { waitUntil: 'domcontentloaded' });
    await waitRunning(page);
    // Several 1 s windows must elapse: the first latches, the rest report.
    await page.waitForFunction('window.__n64Rate && window.__n64Rate.speed !== null', { timeout: 60000 })
      .catch(() => {});
    await new Promise((r2) => setTimeout(r2, +(process.env.N64_METER_MS || 12000)));
    const r = await page.evaluate(() => window.__n64Rate || null);
    t.rate = r && {
      speed: r.speed, speedFrom: r.speedFrom, audioSpeed: r.audioSpeed, viSpeed: r.viSpeed,
      viHz: r.viHz, gameHz: r.gameHz, gameFrac: r.gameFrac, costMs: r.costMs, capVi: r.capVi,
      hwX: r.hwX, capFps: r.capFps, shown: r.shown, made: r.made, disagree: r.disagree,
      ahead: r.ahead, starved: r.starved, audioGaps: r.audioGaps, windows: r.windows,
    };
    t.headline = await page.evaluate(() => document.getElementById('fps').textContent);
    // Region reached the model from the ROM HEADER. mariokart.z64 is country 0x50 = PAL = 50 Hz;
    // this is the one assertion that proves the header read is actually wired to the meter, and
    // it is the exact case a hardcoded 60 gets wrong by 20%.
    const expectViHz = rom === 'mariokart.z64' ? 50 : 60;
    t.regionOk = !!(r && r.viHz === expectViHz);
    t.expectViHz = expectViHz;
    // The core's own frame counters were located in its heap (see N64Rate PRODUCER 3). Without
    // this there is no per-title 120 target at all.
    t.gameRateFound = !!(r && r.gameHz > 0 && r.gameFrac > 0);
    t.capacityMeasured = !!(r && isFinite(r.capVi) && r.capVi > 0 && isFinite(r.hwX) && r.hwX > 0);
    t.speedSane = !!(r && isFinite(r.speed) && r.speed > 0.02 && r.speed < 3 && (r.speedFrom === 'audio' || r.speedFrom === 'vi'));
    // Both witnesses must land on the same answer; they measure one quantity two ways.
    t.witnessesAgree = !!(r && r.disagree === false);
    // Gate #9: the shipped path is never allowed to run the guest ahead of hardware.
    t.notAhead = !!(r && r.ahead === false);
    // The headline must be the four-term readout, not the old bare host-fps counter.
    t.headlineOk = /^speed /.test(t.headline) && /shown \//.test(t.headline) && !/^FPS: \d+$/.test(t.headline);
    t.ok = !!(t.regionOk && t.gameRateFound && t.capacityMeasured && t.speedSane && t.witnessesAgree && t.notAhead && t.headlineOk);
    await page.close();
  }

  // ---------- diagnostics panel ----------
  {
    const t = result.diag;
    const page = await newPage(t);
    await page.goto(`${base}?game=${rom}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!document.getElementById("btnDiag")', { timeout: 20000 });
    // Reachable BEFORE Start — the clean baseline report the bug protocol asks for first.
    await page.click('#btnDiag');
    t.opens = await page.evaluate(() => document.getElementById('diagPanel').classList.contains('open'));
    t.verdict = await page.evaluate(() => document.getElementById('diagVerdict').textContent.slice(0, 220));
    const text = await page.evaluate(() => document.getElementById('diagText').textContent);
    t.len = text.length;
    t.verdictPinned = /^>> /.test(t.verdict);
    t.hasGpu = /\[gl\] WebGL2 = /.test(text);
    t.hasHeapProbe = /\[mem\] 512 MB WebAssembly\.Memory: /.test(text);
    t.hasEnv = /\[env\] .*AudioWorklet=/.test(text);
    t.hasMilestones = /--- HOW FAR IT GOT ---/.test(text);
    // THE EVICTION TEST. The GPU line prints once, earliest. If it only lived in the rolling
    // tail it would be the first thing lost, which is what made both sister pages' reports
    // useless. It must appear ABOVE the tail section.
    t.gpuAboveTail = text.indexOf('[gl] WebGL2 = ') >= 0 &&
                     text.indexOf('[gl] WebGL2 = ') < text.indexOf('--- LAST ');
    t.pinnedSectionPresent = /--- PINNED FACTS/.test(text);
    // Pre-Start, the 512 MB heap probe must have actually run — that is the whole point of the
    // baseline report, and it is the one moment it can run without competing with the core.
    // Asserts the PROBE ran, not that this particular machine has the memory: 'not run' is the
    // failure, since that is the state where the report carries no answer at all.
    t.heapProbeRan = /\[mem\] 512 MB WebAssembly\.Memory: (granted|REFUSED)/.test(text);
    t.baselineVerdict = /^>> NOTHING STARTED YET/.test(t.verdict);
    await page.close();

    // ...and again with the emulator actually running. A HEALTHY boot sends ordinary chatter
    // ("ReadSpecialSettings: DEFAULT") through the core's printErr; the first cut of this panel
    // headlined that as ">> THE CORE PRINTED AN ERROR" on every clean run. The verdict must
    // describe the run, not the loudest string that went past.
    const page2 = await newPage(t);
    await page2.goto(`${base}?game=${rom}&autostart`, { waitUntil: 'domcontentloaded' });
    await waitRunning(page2);
    await page2.waitForFunction('window.__n64Rate && window.__n64Rate.speed !== null', { timeout: 60000 }).catch(() => {});
    await new Promise((r2) => setTimeout(r2, 4000));
    await page2.click('#btnDiag');
    t.runningVerdict = await page2.evaluate(() => document.getElementById('diagVerdict').textContent.slice(0, 200));
    t.runningVerdictOk = /^>> RUNNING/.test(t.runningVerdict);
    await page2.close();

    t.ok = !!(t.opens && t.verdictPinned && t.hasGpu && t.hasHeapProbe && t.hasEnv &&
              t.hasMilestones && t.gpuAboveTail && t.pinnedSectionPresent &&
              t.heapProbeRan && t.baselineVerdict && t.runningVerdictOk);
  }

  // ---------- standing invariants of this page ----------
  {
    const t = result.invariants;
    const src = await (await fetch(`${base}index.html`)).text();
    // n64/index.html deliberately does NOT install coi-serviceworker: N64Wasm is
    // single-threaded and needs no SharedArrayBuffer, and pulling it in would isolate the
    // origin for no gain (CLAUDE.md "WASM emulator architecture" #1).
    t.noCoiServiceWorker = src.indexOf('coi-serviceworker') < 0;
    // UI dependencies self-hosted, so a sibling page's coi worker cannot break this one.
    t.vendorSelfHosted = ['jquery-3.3.1.min.js', 'rivets.bundled.min.js', 'toastr.min.js', 'FileSaver.min.js']
      .every((f) => src.indexOf('/n64/vendor/' + f) >= 0);
    // Nothing loaded off-origin in any of the passes above (eruda is behind ?eruda and unused).
    const off = []
      .concat(result.desktop.offOrigin || [], result.mobile.offOrigin || [],
              result.ratetest.offOrigin || [], result.meter.offOrigin || [], result.diag.offOrigin || []);
    t.offOriginRequests = [...new Set(off)].slice(0, 8);
    t.noOffOrigin = t.offOriginRequests.length === 0;
    t.ok = !!(t.noCoiServiceWorker && t.vendorSelfHosted && t.noOffOrigin);
  }
} catch (e) {
  result.error = String(e).slice(0, 500);
} finally {
  await browser.close();
}
for (const k of ['desktop', 'mobile', 'ratetest', 'meter', 'diag']) {
  result[k].consoleErrors = (result[k].consoleErrors || []).slice(0, 6);
  result[k].failedRequests = (result[k].failedRequests || []).slice(0, 6);
  delete result[k].offOrigin;   // rolled up into result.invariants
}
result.ok = ['desktop', 'mobile', 'ratetest', 'meter', 'diag', 'invariants'].every((k) => result[k].ok === true);
console.log(JSON.stringify(result, null, 1));
