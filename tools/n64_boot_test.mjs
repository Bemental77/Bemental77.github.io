// Headless boot/perf test for one N64Wasm ROM.
//
//   node tools/n64_boot_test.mjs <rom-filename.z64> [pageUrl]
//
// Drives the N64Wasm page (default: the dist page on :8080), loads the ROM
// through the same path the Play button uses (load_url -> LoadEmulator).
// The core runs via emscripten_set_main_loop (one RAF tick per host frame;
// mymain.cpp mainLoop), so RAF callback rate == host fps == what the page's
// FPS counter shows. Audio-sync mode (_runMainLoop from onaudioprocess) is
// counted too in case the config enables it. Screenshots the canvas twice to
// classify black/static screens. Emits one JSON line on stdout.
import puppeteer from 'puppeteer';

const rom = process.argv[2];
const pageUrl = process.argv[3] || 'http://localhost:8080/n64/N64Wasm/dist/n64.html';
if (!rom) { console.error('usage: node tools/n64_boot_test.mjs <rom.z64> [pageUrl]'); process.exit(2); }

const SETTLE_MS = +(process.env.N64_SETTLE_MS || 8000);   // boot/settle window before measuring
const MEASURE_MS = +(process.env.N64_MEASURE_MS || 8000); // fps measurement window
const FORCE_ANGRY = process.env.N64_FORCE_ANGRY === '1';  // angrylion software renderer
const LOG_ALL = process.env.N64_LOG_ALL === '1';          // keep every console line

const result = {
  rom, launched: false, hostFps: null, audioSyncFrames: 0,
  emulatorStartedMsg: false, audioState: null,
  blackScreen: null, staticScreen: null, luminance: null,
  consoleErrors: [], coreLog: [], failedRequests: [], pageErrors: [],
  screenshot: null,
};

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.evaluateOnNewDocument(() => {
    window.__rafN = 0;
    const o = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => o((t) => { window.__rafN++; cb(t); });
  });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') result.consoleErrors.push(t.slice(0, 300));
    // core prints route through Module.print -> console.log
    if (LOG_ALL || /mupen64plus|error|Error|abort|exception|warning/i.test(t)) result.coreLog.push(t.slice(0, 300));
    if (t.includes('Starting R4300 emulator')) result.emulatorStartedMsg = true;
  });
  page.on('pageerror', (e) => result.pageErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => result.failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) result.failedRequests.push(`${r.url()} HTTP${r.status()}`); });

  await page.goto(pageUrl, { waitUntil: 'networkidle2' });
  await page.waitForFunction('!!(window.Module && Module.calledRun)', { timeout: 30000 });
  await page.evaluate(() => {
    const orig = Module._runMainLoop;
    window.__audioFrames = 0;
    Module._runMainLoop = function () { window.__audioFrames++; return orig.apply(this, arguments); };
  });

  if (FORCE_ANGRY) await page.evaluate(() => { myApp.rivetsData.forceAngry = true; });
  await page.evaluate((r) => { myApp.load_url('../roms/' + r); }, rom);
  await page.waitForFunction('myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 60000 });
  await page.evaluate(() => myApp.audioContext && myApp.audioContext.resume());
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  result.audioState = await page.evaluate(() => myApp.audioContext?.state ?? 'none');
  // True game speed: the core writes 88200 stereo-int16 samples/s into its
  // 64000-slot ring at full speed. Sampling the write position every 100ms
  // (< ring period) and summing wrapped deltas gives the effective rate.
  await page.evaluate(() => {
    window.__audioRate = { last: Module._neilGetAudioWritePosition(), sum: 0, t0: performance.now() };
    window.__audioRateIv = setInterval(() => {
      const cur = Module._neilGetAudioWritePosition();
      window.__audioRate.sum += (cur - window.__audioRate.last + 64000) % 64000;
      window.__audioRate.last = cur;
    }, 100);
  });
  const r0 = await page.evaluate(() => window.__rafN);
  const a0 = await page.evaluate(() => window.__audioFrames);
  const canvas = await page.$('#canvas');
  const shot1 = canvas ? await canvas.screenshot().catch(() => null) : null;
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  const r1 = await page.evaluate(() => window.__rafN);
  const a1 = await page.evaluate(() => window.__audioFrames);
  result.hostFps = Math.round(((r1 - r0) / (MEASURE_MS / 1000)) * 10) / 10;
  result.audioSyncFrames = a1 - a0;
  result.speedPct = await page.evaluate(() => {
    clearInterval(window.__audioRateIv);
    const el = (performance.now() - window.__audioRate.t0) / 1000;
    return Math.round((window.__audioRate.sum / el / 88200) * 100);
  });

  const shotPath = `/tmp/n64-sweep/${rom.replace(/\.z64$/, '')}.png`;
  const shot2 = canvas ? await canvas.screenshot({ path: shotPath }).catch(() => null) : null;
  if (shot2) result.screenshot = shotPath;
  if (shot1 && shot2) {
    result.staticScreen = Buffer.compare(shot1, shot2) === 0;
    // analyze the final shot's pixels in-browser (2d canvas, no deps)
    const dataUrl = 'data:image/png;base64,' + shot2.toString('base64');
    result.luminance = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return Math.round((sum / (d.length / 4)) * 10) / 10;
    }, dataUrl);
    result.blackScreen = result.luminance !== null && result.luminance < 2;
  }
  result.launched = result.emulatorStartedMsg && (r1 - r0) > 0 && !result.blackScreen;
} catch (e) {
  result.error = String(e).slice(0, 400);
} finally {
  await browser.close();
}
result.coreLog = LOG_ALL ? result.coreLog.slice(-80) : result.coreLog.slice(0, 12);
result.consoleErrors = result.consoleErrors.slice(0, 8);
console.log(JSON.stringify(result));
