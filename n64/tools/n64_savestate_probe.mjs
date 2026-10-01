#!/usr/bin/env node
// n64_savestate_probe.mjs — WHAT DOES AN N64 SAVESTATE COST, AND IS IT EXACT?
//
// The question rollback netplay asks of a core: how big is a state, how long
// do save and load take on this device, and does a restored state continue
// BIT-FOR-BIT as the original did? Answered on the real page with the shipped
// core (n64/N64Wasm/dist), driving it one lockstep frame at a time
// (_neil_ls_arm + _neil_ls_run_frame) with a scripted, frame-numbered input so
// both continuations get identical input:
//   1. boot, arm, run WARM frames;
//   2. save (_neil_serialize: savestates_save_m64p into the 16.8 MB buffer +
//      gzip to MEMFS /savestate.gz) — timed; raw and gz sizes recorded;
//   3. run N frames, recording the per-frame architectural fingerprint
//      (_neil_last_fp: reg/hi/lo/cp0/cp1/FCR31/PC — NOT RDRAM, RSP or RDP);
//   4. load (_neil_unserialize) — timed; run the SAME N frames again;
//   5. compare the two fingerprint streams.
// myApp.SaveStateEvent (the IndexedDB write) is stubbed so only the core's own
// cost is timed. Repeated REPS times; median reported.
//
// USAGE  bash tools/probe_lock.sh run -- node n64/tools/n64_savestate_probe.mjs [--cpu 4] [--mobile] [--frames 180] [--reps 3]
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const CPU = +flag('cpu', '1'), FRAMES = +flag('frames', '180'), REPS = +flag('reps', '3'), WARM = +flag('warm', '600');
const BASE = flag('url', 'http://localhost:8080'), GAME = flag('game', 'Mario Kart 64');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const browser = await puppeteer.launch({ headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { game: GAME, cpu: CPU, mobile: has('mobile'), frames: FRAMES, reps: REPS, warm: WARM };
try {
  const page = await browser.newPage({ type: 'window' });
  if (has('mobile')) await page.emulate({ userAgent: UA, viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } });
  else await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Module && Module._neil_ls_arm && Module._neil_serialize && window.myApp
    && window.myApp.rivetsData && window.myApp.rivetsData.beforeEmulatorStarted === false, { timeout: 240000 });
  if (CPU > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
  const r = await page.evaluate(async (FRAMES, REPS, WARM) => {
    const M = window.Module;
    window.myApp.SaveStateEvent = function () {};           // time the core, not IndexedDB
    M._neil_ls_arm(1); if (M._neil_fp_always) M._neil_fp_always(1);
    // scripted input, a pure function of the frame index: A held, stick sweeping
    const drive = (f) => {
      const mask = (1 << 4) | ((f % 90) < 30 ? (1 << 3) : 0) | ((f % 240) === 7 ? (1 << 6) : 0);
      M._neil_ls_set_pad(0, mask, Math.round(Math.sin(f / 20) * 20000), 0);
      for (let p = 1; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0);
      M._neil_ls_run_frame();
      return M._neil_last_fp() >>> 0;
    };
    let f = 0;
    for (; f < WARM; f++) drive(f);
    const reps = [];
    for (let k = 0; k < REPS; k++) {
      const f0 = f;
      let t0 = performance.now(); M._neil_serialize(); const saveMs = performance.now() - t0;
      let gz = null; try { gz = M.FS.stat('/savestate.gz').size; } catch (e) {}
      const A = []; for (let i = 0; i < FRAMES; i++) A.push(drive(f0 + i));
      t0 = performance.now(); M._neil_unserialize(); const loadMs = performance.now() - t0;
      const B = []; for (let i = 0; i < FRAMES; i++) B.push(drive(f0 + i));
      let firstDiff = -1; for (let i = 0; i < FRAMES; i++) if (A[i] !== B[i]) { firstDiff = i; break; }
      reps.push({ at: f0, saveMs: +saveMs.toFixed(1), loadMs: +loadMs.toFixed(1), gzBytes: gz, exact: firstDiff < 0, firstDiff,
                  distinctFps: new Set(A).size });
      f = f0 + FRAMES;                                          // continue from where both streams ended
      for (let i = 0; i < 60; i++) drive(f++);
    }
    // ---- what a RAW, in-memory save would cost, and how much of it changes ----
    // (a) a 16.8 MB copy within the wasm heap and out of it — the floor of a
    //     no-gzip save/load; (b) consecutive states decompressed and diffed in
    //     4 KB pages: how many pages ONE frame dirties (dirty-page tracking).
    const RAW = 16788288 + 1024;
    const H8 = M.HEAPU8, scratch = new Uint8Array(RAW);
    const copyTimes = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); scratch.set(H8.subarray(0, RAW)); copyTimes.push(performance.now() - t0); }
    copyTimes.sort((a, b) => a - b);
    const gunzip = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const grab = async () => { M._neil_serialize(); return gunzip(M.FS.readFile('/savestate.gz')); };
    const dirty = [];
    let prev = await grab();
    for (const gap of [1, 1, 1, 2, 5, 30]) {
      for (let i = 0; i < gap; i++) drive(f++);
      const cur = await grab();
      let pages = 0, n = Math.min(prev.length, cur.length);
      for (let o = 0; o < n; o += 4096) {
        const e = Math.min(n, o + 4096);
        for (let k = o; k < e; k++) if (prev[k] !== cur[k]) { pages++; break; }
      }
      dirty.push({ frames: gap, dirtyPages: pages, dirtyKB: pages * 4, ofPages: Math.ceil(n / 4096) });
      prev = cur;
    }
    return { reps, rawCopyMs: +copyTimes[2].toFixed(2), rawStateBytes: prev.length, dirty };
  }, FRAMES, REPS, WARM);
  const med = (k) => { const v = r.reps.map((x) => x[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  Object.assign(out, r, { rawBufferBytesDeclared: 16788288 + 1024, medSaveMs: med('saveMs'), medLoadMs: med('loadMs'), medGzBytes: med('gzBytes'),
    allExact: r.reps.every((x) => x.exact) });
} catch (e) { out.error = e.message; }
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
await browser.close().catch(() => {});
