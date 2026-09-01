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
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Region is a STATIC property of the ROM: country code at header offset 0x3E.
// Codes per the core's own table (N64Wasm/code/.../rom.c:76-99). Handles the
// three byte orders an N64 dump ships in — .z64 big-endian (0x80371240),
// .n64 little-endian (0x40123780), .v64 byte-swapped (0x37804012) — because
// reading offset 0x3E blind gets the wrong byte in two of the three.
function regionFpsFromRom(romName) {
  const roots = ['n64/N64Wasm/roms', 'n64/roms'];
  const path = roots.map((r) => join(r, romName)).find((p) => existsSync(p));
  if (!path) return null;
  let b;
  try { b = readFileSync(path).subarray(0, 0x40); } catch { return null; }
  if (b.length < 0x40) return null;
  const magic = b.readUInt32BE(0);
  if (magic === 0x40123780) {                       // .n64 little-endian
    const w = b.subarray(0x3C, 0x40); b.set([w[3], w[2], w[1], w[0]], 0x3C);
  } else if (magic === 0x37804012) {                // .v64 byte-swapped
    for (let i = 0x3C; i < 0x40; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  } else if (magic !== 0x80371240) {
    return null;                                     // not a recognised N64 image
  }
  const cc = b[0x3E];
  // PAL-region codes: D(Germany) F(France) H(Netherlands) I(Italy) P(Europe)
  // S(Spain) U(Australia) W(Scandinavia) X/Y(Europe variants).
  if ('DFHIPSUWXY'.includes(String.fromCharCode(cc))) return 50;
  // NTSC: E(USA) J(Japan) 7(Beta) A(Asia) C(China) K(Korea) N(Canada)
  if ('EJACKN7'.includes(String.fromCharCode(cc))) return 60;
  return null;
}

// Total CPU seconds burned by THIS browser's process tree (walked from the
// launched pid -- name-matching "Google Chrome" would also catch sibling
// agents' puppeteer probes). CPU time measures WORK, so unlike wall time it
// survives a heavily oversubscribed box; it is still scaled by the CPU's
// clock (see `pmset -g therm` CPU_Speed_Limit).
function treeCpuSeconds(rootPid) {
  try {
    const rows = execSync('ps -Ao pid=,ppid=,time=', { encoding: 'utf8' }).trim().split('\n');
    const kids = new Map(), cpu = new Map();
    for (const line of rows) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) continue;
      const [, pid, ppid, t] = m;
      const p = t.split(/[:]/).map(Number);
      const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
      cpu.set(+pid, secs);
      if (!kids.has(+ppid)) kids.set(+ppid, []);
      kids.get(+ppid).push(+pid);
    }
    let total = 0, stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      total += cpu.get(p) || 0;
      for (const k of kids.get(p) || []) stack.push(k);
    }
    return total;
  } catch { return null; }
}

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
  // Producible CAPACITY, not presented rate. speedPct cannot answer this:
  // IsFrameReady() (mymain.cpp:818-840) pins retro_run to exactly the region
  // rate (60 NTSC / 50 PAL) of WALL CLOCK, so a cheap title screen and
  // saturated gameplay both read ~100%. frameCostMs is the mean wall cost of
  // one retro_run (timed_retro_run, mymain.cpp:903-909) -- immune to the
  // limiter. headroomX = frameBudgetMs / frameCostMs is the real multiple.
  frameCostMs: null, frameCostN: null, headroomX: null, regionFps: null,
};

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

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
  // RUNTIME-READY GATE. This used to be `!!(window.Module && Module.calledRun)`
  // and that is TOOLCHAIN-SPECIFIC: emscripten 6.0.2 guards `calledRun` behind
  // `#if ASSERTIONS` and never assigns it to Module (emsdk/upstream/emscripten/
  // src/postamble.js:117-120), so a release build emits it 0 times — verified,
  // the shipped 3.1.67 n64wasm.js contains "calledRun" 6x and a 6.0.2 rebuild
  // contains it 0x. Gating on it therefore TIMES OUT on a perfectly healthy
  // core built with a modern toolchain, and reads as a silent boot failure
  // (empty pageErrors, empty coreLog) when the emulator is in fact running.
  // Old path is kept first so behaviour on the shipped 3.1.67 dist is unchanged.
  await page.waitForFunction(() => {
    if (!window.Module) return false;
    if (Module.calledRun) return true;             // emscripten <= 5.x
    // emscripten 6.x: onRuntimeInitialized has fired (script.js:1608 wires it to
    // initModule, which clears rivetsData.moduleInitializing — script.js:30,:662)
    // AND the exports this test is about to call are attached.
    return typeof Module._runMainLoop === 'function'
        && typeof Module._neilGetAudioWritePosition === 'function'
        && !!(window.myApp && myApp.rivetsData
              && myApp.rivetsData.moduleInitializing === false);
  }, { timeout: 30000 });
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
  await page.evaluate(() => { Module._neil_frame_cost_reset(); window.__fcT0 = performance.now(); });
  const cpu0 = treeCpuSeconds(browser.process()?.pid);
  const canvas = await page.$('#canvas');
  const shot1 = canvas ? await canvas.screenshot().catch(() => null) : null;
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  const cpu1 = treeCpuSeconds(browser.process()?.pid);
  const fc = await page.evaluate(() => ({
    ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n(),
    el: (performance.now() - window.__fcT0) / 1000,
  }));
  if (fc.n > 0) {
    result.frameCostMs = Math.round((fc.ms / fc.n) * 1000) / 1000;
    result.frameCostN = fc.n;
    // achieved retro_run (VI) rate -- ~60 NTSC / ~50 PAL when keeping up;
    // an independent cross-check on the audio-derived speedPct
    result.viRatePerSec = Math.round((fc.n / fc.el) * 10) / 10;
    // [REGION FIX 2026-08-29] This used to derive regionFps FROM viRatePerSec —
    // circular: it inferred the region from the very rate it was about to judge
    // against that region, so a guest running slow was scored against the wrong
    // divisor and a PAL guest at exactly 1.000x could never be distinguished from
    // an NTSC guest at 0.833x. It then fell back to 60.
    // MEASURED: n64/N64Wasm/roms/mariokart.z64 has country code 0x50 at header
    // offset 0x3E = PAL. Against its real 50 Hz it reads 1.000x; against a
    // hardcoded 60 it reads 0.833x on a guest running at exactly hardware speed.
    // The region is a static property of the ROM, so read it from the header —
    // the same table the core itself uses (N64Wasm/code/.../rom.c:76-99).
    result.regionFps = regionFpsFromRom(rom) ?? null;
    result.regionSource = result.regionFps ? 'rom-header' : 'unknown';
    if (result.regionFps === null) {
      // No header => say so and score against 60, but LABEL it, so a headroom
      // number can never silently inherit a guessed divisor again.
      result.regionFps = 60;
      result.regionSource = 'DEFAULTED-60-UNVERIFIED';
    }
    const budget = 1000 / result.regionFps;
    result.headroomX = Math.round((budget / result.frameCostMs) * 100) / 100;
    if (cpu0 !== null && cpu1 !== null && cpu1 > cpu0) {
      // CPU ms of real work per emulated VI frame -- the load-robust
      // throughput number. headroomCpuX is the capacity multiple this
      // machine WOULD deliver if the emulator got a full core.
      result.cpuMsPerFrame = Math.round(((cpu1 - cpu0) * 1000 / fc.n) * 100) / 100;
      result.headroomCpuX = Math.round((budget / result.cpuMsPerFrame) * 100) / 100;
    }
  }
  result.cpuSpeedLimit = (() => {
    try { return +execSync('pmset -g therm', { encoding: 'utf8' }).match(/CPU_Speed_Limit\s*=\s*(\d+)/)[1]; } catch { return null; }
  })();
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
