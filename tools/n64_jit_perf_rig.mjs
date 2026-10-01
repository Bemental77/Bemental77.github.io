#!/usr/bin/env node
// n64_jit_perf_rig.mjs — N64 JIT throughput + bit-identity rig, FRAME-STEPPED.
//
// WHY THIS RIG AND NOT n64_gameplay_ab.mjs / n64_jit_diff_test.mjs
//   Both of those let the core FREE-RUN and read it from outside, so two arms
//   are only ever "roughly the same scene" and input lands on wall time. This
//   rig arms the core's lockstep frame gate BEFORE main() (the exact hook
//   n64/index.html uses for a room: myApp.beforeRun, dist/script.js:233) and
//   then advances the guest itself, ONE VI FIELD PER _neil_ls_run_frame() CALL
//   (mymain.cpp neil_ls_run_frame), with a scripted pad image per frame. So:
//     * every arm executes the IDENTICAL guest frames — frame k of arm A and
//       frame k of arm B are the same emulated work, by construction;
//     * a timing window is a range of FRAME NUMBERS, so a fast arm and a slow
//       arm cannot drift into different scenes (the gameplay_ab lesson);
//     * the input plan can walk MK64's menus into a real race, which no
//       wall-paced driver in this repo has managed (TASKS.md "every window is
//       a MENU").
//
// ARMS
//   --arm NAME=SPEC   (repeatable). SPEC is one of
//       off                 ?jit=off — the cached interpreter (the oracle)
//       head                the emitter as committed at git HEAD, served in
//                           place of /n64/bementalJIT/mips_emit.js
//       tree                the emitter in the working tree (no interception)
//       file:/abs/path.js   any emitter file, served in place of mips_emit.js
//   Default: --arm off=off --arm head=head --arm tree=tree
//   Each arm runs in a FRESH browser context (the game writes EEPROM into
//   IndexedDB, and a second boot that reads the first one's save diverges).
//
// WHAT IS MEASURED (per arm, per round)
//   costMs/frame  — _neil_frame_cost_ms delta / _neil_frame_cost_n delta over
//                   the window: wall ms INSIDE retro_run (mymain.cpp
//                   timed_retro_run). The page's own `cap` is 1000/this/viHz.
//   callMs/frame  — wall ms around each _neil_ls_run_frame() call (includes
//                   mainLoopInner's work outside retro_run).
//   capX          — 1000/costMs/50 (mariokart.z64 is PAL: 50 Hz fields,
//                   n64/index.html:1203). Override with --vihz.
//   fp stream     — _neil_last_fp() after EVERY frame (FNV over GPR/CP0/FPR/
//                   FCR31/PC, libretronew.c). Compared frame by frame across arms.
//   --hash adds, after EVERY frame: an FNV-style hash of all 8 MB of RDRAM and a
//   hash of the rendered framebuffer (gl.readPixels of the default framebuffer,
//   with READ_FRAMEBUFFER and PIXEL_PACK_BUFFER bindings saved and restored).
//   Hashing is outside the timed call, but it is not free — never compare a
//   --hash run's timings with a non --hash run's.
//
// ⚠ A PROFILE IS NOT A SPEED MEASUREMENT (CLAUDE.md gate #10). --profile turns
//   on the CDP sampling profiler for the window of ONE arm and attributes self
//   time (see attribute()). Speed claims come only from unprofiled,
//   interleaved rounds (--rounds R alternates arm order every round).
//
// USAGE
//   npm run web      # the dev server, CLAUDE.md gate #2
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/n64_jit_perf_rig.mjs \
//        --frames 2400 --window 1800:2400 --plan mk64race --cpu 4 --rounds 2
//
// FLAGS
//   --rom FILE        default mariokart.z64
//   --frames N        frames to run per arm (default 1200)
//   --window A:B      timing window, frame numbers (default last third)
//   --plan NAME|steps:f0-f1:ports:mask:ax:ay;...   input plan (default idle)
//   --cpu R           CDP CPU throttle rate for the WINDOW (default 1)
//   --rounds R        interleaved rounds, order alternates (default 1)
//   --hash            RDRAM + framebuffer hash every frame
//   --profile NAME    profile this arm's window (once, in round 0)
//   --shots f1,f2     canvas screenshots at these frames (first round only)
//   --out DIR         screenshots/json (default /tmp/n64-perf-rig)
//   --json PATH       write the full result
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
let puppeteer;
try { puppeteer = createRequire(process.env.HOME + '/probe-deps/')('puppeteer'); }
catch (_e) { puppeteer = (await import('puppeteer')).default; }

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const flags = (n) => argv.flatMap((a, i) => (a === '--' + n && argv[i + 1] != null ? [argv[i + 1]] : []));
const has = (n) => argv.includes('--' + n);

const ROM = flag('rom', 'mariokart.z64');
const FRAMES = +flag('frames', '1200');
const [W0, W1] = (flag('window', '') || `${Math.floor(FRAMES * 2 / 3)}:${FRAMES}`).split(':').map(Number);
const CPU = +flag('cpu', '1');
const ROUNDS = +flag('rounds', '1');
const HASH = has('hash');
// --nofbhash: hash RDRAM every frame but do NOT read the framebuffer back. The
// fb hash is a readPixels with no pack buffer bound, which the page's fbasync
// layer (n64/index.html) intercepts as one of ITS calls — so on a read_always
// title (MK64, DK64, Banjo...) the rig's own witness joins the one-call-offset
// chain it is trying to observe. RDRAM-only hashing takes it out.
const FBHASH = !has('nofbhash');
// --fbseq: record the page's fbasync witness (?fbwitness=1 is added to every
// arm's URL) and report where two arms' readback sequences first differ.
const FBSEQ = has('fbseq');
const PROFILE_ARM = flag('profile', '');
const SHOTS = (flag('shots', '') || '').split(',').filter(Boolean).map(Number);
const OUT = flag('out', '/tmp/n64-perf-rig');
const VIHZ = +flag('vihz', '50');
const BASE = flag('url', 'http://localhost:8080');
const CHUNK = +flag('chunk', '30');
const DUMP_AT = +flag('dumpat', '0');
const JITSPAN = +flag('jitspan', '0');
const JITONLY = flag('jitonly', '') ? fs.readFileSync(flag('jitonly', ''), 'utf8').split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16) >>> 0) : null;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
fs.mkdirSync(OUT, { recursive: true });

// ---- arms ----
const armSpecs = flags('arm').length ? flags('arm') : ['off=off', 'head=head', 'tree=tree'];
const ARMS = armSpecs.map((s) => {
  const eq = s.indexOf('=');
  const name = eq > 0 ? s.slice(0, eq) : s;
  let spec = eq > 0 ? s.slice(eq + 1) : s, query = '';
  const qm = spec.indexOf('?');
  if (qm >= 0) { query = spec.slice(qm + 1); spec = spec.slice(0, qm); }
  // rigslow=R (rig-only, stripped from the page URL): CDP CPU throttle for the
  // WHOLE run of this arm. A TIMING-ONLY control: the guest work is identical,
  // so a hash that moves with it is wall-clock dependence, not the emitter.
  let slow = 0;
  query = query.split('&').filter((kv) => { const m = /^rigslow=(\d+(?:\.\d+)?)$/.exec(kv); if (m) { slow = +m[1]; return false; } return kv; }).join('&');
  let emitter = null;
  if (spec === 'head') {
    const f = path.join(OUT, 'mips_emit.HEAD.js');
    fs.writeFileSync(f, execSync('git show HEAD:n64/bementalJIT/mips_emit.js', { cwd: REPO, maxBuffer: 1 << 26 }));
    emitter = f;
  } else if (spec.startsWith('file:')) emitter = spec.slice(5);
  else if (spec !== 'off' && spec !== 'tree') throw new Error('unknown arm spec ' + spec);
  return { name, spec, query, slow, off: spec === 'off', emitter, emitterSrc: emitter ? fs.readFileSync(emitter) : null };
});

// ---- input plans: [f0, f1, ports[], mask, ax, ay] held over [f0, f1) ----
// mask bits (mymain.cpp neil_ls_set_pad): 0 up 1 down 2 left 3 right 4 A 5 B
// 6 Start 7 Z 8 L 9 R 10 C-up 11 C-down 12 C-left 13 C-right. ax/ay in -1..1.
const B_A = 1 << 4, B_START = 1 << 6;
const PLANS = {
  idle: [],
};
function parsePlan(s) {
  if (PLANS[s]) return PLANS[s];
  if (!s.startsWith('steps:')) throw new Error('unknown plan ' + s);
  return s.slice(6).split(';').filter(Boolean).map((t) => {
    const [span, ports, mask, ax, ay] = t.split(':');
    const [f0, f1] = span.split('-').map(Number);
    return [f0, (f1 == null || isNaN(f1)) ? f0 + 5 : f1, ports.split('').map(Number), +mask, +(ax || 0), +(ay || 0)];
  });
}
const PLAN_NAME = flag('plan', 'idle');
const plan = parsePlan(PLAN_NAME);

// Arm the frame gate before main(), exactly as the page does for a room.
const PRE = `(() => {
  window.__rig = { armed: false, main: false, params: 0 };
  const iv = setInterval(() => {
    const app = window.myApp; if (!app || app.__rigHooked) return;
    app.__rigHooked = true; clearInterval(iv);
    const prev = app.beforeRun ? app.beforeRun.bind(app) : () => {};
    app.beforeRun = function () {
      const r = prev.apply(this, arguments);
      const M = window.Module;
      M._neil_ls_arm(1); if (M._neil_fp_always) M._neil_fp_always(1);
      window.__rig.armed = true;
      const cm = M.callMain;
      M.callMain = function () { const x = cm.apply(this, arguments); window.__rig.main = true; window.__rig.table0 = M.wasmTable.length; return x; };
      return r;
    };
  }, 1);
})();`;

function load1() { try { return +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { return null; } }

const browser = await puppeteer.launch({
  headless: 'new', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,900']
         // --tiercheck: --allow-natives-syntax only makes %IsTurboFanFunction
         // parseable; it changes no tiering decision (CLAUDE.md gate 11 —
         // never --no-liftoff here, the probe measures stock V8).
         .concat(has('tiercheck') ? ['--js-flags=--allow-natives-syntax'] : []),
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

// Shared across arms: the static address of the RDRAM array, learned from the
// bridge param block (recomp.c jit_params[24]). The interpreter arm gets it by
// enabling the bridge with a callback that installs NOTHING (returns 0), which
// leaves the cached interpreter byte-for-byte in charge.
async function runArm(arm, round, opts) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [], logs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { const t = m.text(); if (/\[jit\]|bementalJIT|span rejected/.test(t)) logs.push(t.slice(0, 200)); });
  if (arm.emitterSrc) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/\/n64\/bementalJIT\/mips_emit\.js/.test(req.url())) {
        req.respond({ status: 200, contentType: 'application/javascript', body: arm.emitterSrc });
      } else req.continue();
    });
  }
  await page.evaluateOnNewDocument(PRE);
  const q = (arm.off ? '&jit=off' : '') + (arm.query ? '&' + arm.query : '') + (FBSEQ ? '&fbwitness=1' : '');
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__rig && window.__rig.main === true, { timeout: 240000 });
  if (!arm.off) await page.waitForFunction(() => !!(window.bementalMips && window.myApp && window.myApp.jitCompile), { timeout: 60000 });
  // capture the param block pointer on every compile (and, for the
  // interpreter arm, enable the bridge with a no-install callback)
  await page.evaluate((off) => {
    const app = window.myApp, M = window.Module;
    if (off) {
      app.jitCompile = function (pp) { window.__rig.params = pp; return 0; };
      M._neil_set_jit_bridge(1);
    } else {
      const orig = app.jitCompile;
      app.jitCompile = function (pp) { window.__rig.params = pp; return orig(pp); };
    }
  }, arm.off);
  // --jitonly FILE: compile ONLY the span entries (hex vaddrs, one per line)
  // listed — the span bisect, done rig-side so no page edit is needed. Every
  // compile request's vaddr is recorded either way (res.compiled).
  if (!arm.off) await page.evaluate((allow) => {
    const bm = window.bementalMips, orig = bm.compileSpan, set = allow ? new Set(allow) : null;
    window.__rigCompiled = [];
    bm.compileSpan = function (p, M) {
      const v = p.vaddr >>> 0; window.__rigCompiled.push(v);
      if (set && !set.has(v)) return 0;
      // --jitspan N: truncate every span to its first N instructions (legal:
      // the fall-through exit sets PC = entry + span*stride)
      if (window.__rigJitSpan > 0 && p.span > window.__rigJitSpan) p = Object.assign({}, p, { span: window.__rigJitSpan });
      return orig(p, M);
    };
  }, JITONLY);
  if (!arm.off && JITSPAN) await page.evaluate((n) => { window.__rigJitSpan = n; }, JITSPAN);
  const cdp = await page.createCDPSession();
  if (arm.slow > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: arm.slow });
  const res = { arm: arm.name, round, fp: [], rd: [], fb: [], errs, logs };
  let f = 0;
  const stops = [...new Set([W0, W1, FRAMES, ...(DUMP_AT ? [DUMP_AT] : []), ...(round === 0 ? SHOTS : [])])].filter((x) => x > 0 && x <= FRAMES).sort((a, b) => a - b);
  let costA = null, prof = null, loadA = null, loadB = null, censusA = null, censusB = null, blocksA = 0;
  const runTo = async (to) => {
    while (f < to) {
      const end = Math.min(to, f + CHUNK);
      const chunk = await page.evaluate((from, to, plan, hash, fbhash) => {
        const M = window.Module, out = { fp: [], rd: [], fb: [], ms: 0 };
        let dram = 0;
        if (hash && window.__rig.params) dram = M.HEAPU32[(window.__rig.params >> 2) + 24];
        const gl = M.ctx;
        let px = null;
        for (let f = from; f < to; f++) {
          const pads = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (const [f0, f1, ports, mask, ax, ay] of plan) {
            if (f >= f0 && f < f1) for (const p of ports) { pads[p][0] |= mask; if (ax) pads[p][1] = ax; if (ay) pads[p][2] = ay; }
          }
          for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, pads[p][0], Math.round(pads[p][1] * 32000), Math.round(pads[p][2] * 32000));
          const t0 = performance.now();
          M._neil_ls_run_frame();
          out.ms += performance.now() - t0;
          out.fp.push(M._neil_last_fp() >>> 0);
          if (hash) {
            if (!dram && window.__rig.params) dram = M.HEAPU32[(window.__rig.params >> 2) + 24];
            let h = 0x811c9dc5 | 0;
            if (dram) {
              const w = M.HEAP32, i0 = dram >> 2, i1 = i0 + (0x800000 >> 2);
              for (let i = i0; i < i1; i++) h = Math.imul(h ^ w[i], 16777619);
            }
            out.rd.push(h >>> 0);
            let g = 0;
            if (gl && fbhash) {
              const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
              if (!px || px.length !== W * H * 4) px = new Uint8Array(W * H * 4);
              const pr = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pb = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
              const pa = gl.getParameter(gl.PACK_ALIGNMENT);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
              gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pr); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb); gl.pixelStorei(gl.PACK_ALIGNMENT, pa);
              const u = new Int32Array(px.buffer); g = 0x811c9dc5 | 0;
              for (let i = 0; i < u.length; i++) g = Math.imul(g ^ u[i], 16777619);
              g = (g ^ W ^ (H << 16)) >>> 0;
            }
            out.fb.push(g);
          }
        }
        return out;
      }, f, end, plan, HASH, FBHASH);
      res.fp.push(...chunk.fp); res.rd.push(...chunk.rd); res.fb.push(...chunk.fb);
      if (f >= W0 && end <= W1) res.callMs = (res.callMs || 0) + chunk.ms;
      f = end;
    }
  };
  const enterWindow = async () => {
    if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    loadA = load1();
    costA = await page.evaluate(() => ({ ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n(), t: performance.now() }));
    censusA = await page.evaluate(() => (window.__jitCensusDump ? window.__jitCensusDump() : null));
    blocksA = await page.evaluate(() => (window.__jitStats ? (window.__jitStats().blocks || 0) : 0));
    if (opts.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
  };
  for (const stop of stops) {
    if (f === W0 && costA === null) await enterWindow();
    await runTo(stop);
    if (f === W1) {
      if (opts.profile) prof = (await cdp.send('Profiler.stop')).profile;
      const costB = await page.evaluate(() => ({ ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n(), t: performance.now() }));
      censusB = await page.evaluate(() => (window.__jitCensusDump ? window.__jitCensusDump() : null));
      loadB = load1();
      if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const dn = costB.n - costA.n;
      res.window = [W0, W1];
      res.windowFrames = dn;
      res.costMsPerFrame = +((costB.ms - costA.ms) / dn).toFixed(3);
      res.callMsPerFrame = +(res.callMs / (W1 - W0)).toFixed(3);
      res.wallMsPerFrame = +((costB.t - costA.t) / (W1 - W0)).toFixed(3);
      res.capX = +((1000 / res.costMsPerFrame) / VIHZ).toFixed(3);
      // spans compiled INSIDE the window: compile time is charged to retro_run
      res.compilesInWindow = (await page.evaluate(() => (window.__jitStats ? (window.__jitStats().blocks || 0) : 0))) - blocksA;
      res.load = [loadA, loadB];
    }
    if (f === W0 && costA === null) await enterWindow();
    if (DUMP_AT && f === DUMP_AT) {
      // --dumpat N: write this arm's 8 MB of RDRAM after frame N (diagnosis)
      const b64 = await page.evaluate(() => {
        const M = window.Module, d = M.HEAPU32[(window.__rig.params >> 2) + 24];
        const u = new Uint8Array(M.HEAPU8.buffer, d, 0x800000);
        let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
      });
      fs.writeFileSync(path.join(OUT, `rdram_${arm.name}_r${round}_f${f}.bin`), Buffer.from(b64, 'base64'));
    }
    if (round === 0 && SHOTS.includes(f)) {
      await new Promise((r) => setTimeout(r, 150));
      const el = await page.$('#canvas');
      const file = path.join(OUT, `${arm.name}_f${String(f).padStart(5, '0')}.png`);
      if (el) await el.screenshot({ path: file }); else await page.screenshot({ path: file });
    }
  }
  if (!arm.off) {
    res.compiled = await page.evaluate(() => window.__rigCompiled || []);
    if (flag('jitlist', '')) fs.writeFileSync(flag('jitlist', '') + '.' + arm.name, [...new Set(res.compiled)].map((v) => v.toString(16)).join('\n') + '\n');
  }
  if (FBSEQ) res.fbseq = await page.evaluate(() => (window.__fbAsync && window.__fbAsync.seq) ? window.__fbAsync.seq.map((e) => e.join(':')) : null);
  res.jit = await page.evaluate(() => {
    const s = window.__jitStats ? window.__jitStats() : null;
    const e = window.bementalMips && window.bementalMips.stats;
    if (s && e) { s.cacheHits = e.cacheHits || 0; s.labelEntries = e.labelEntries || 0; s.pageTruncated = e.pageTruncated || 0; s.pinnedBlocks = e.pinnedBlocks || 0; s.pinnedRegs = e.pinnedRegs || 0; }
    return s;
  });
  if (has('tiercheck') && !arm.off) {
    // every table slot added after main() is a JIT block function (the
    // emitter only ever grows the table); ask V8 which tier each one is in
    res.tiers = await page.evaluate(`(() => {
      const T = Module.wasmTable, t0 = window.__rig.table0 || 0, out = { turbofan: 0, liftoff: 0, other: 0, n: 0 };
      for (let i = t0; i < T.length; i++) {
        const f = T.get(i); if (!f) continue; out.n++;
        if (%IsTurboFanFunction(f)) out.turbofan++; else if (%IsLiftoffFunction(f)) out.liftoff++; else out.other++;
      }
      return out;
    })()`).catch((e) => ({ error: String(e).slice(0, 160) }));
    console.log('[tiers ' + arm.name + '] ' + JSON.stringify(res.tiers));
  }
  if (censusB && censusB.length) {
    // WINDOW-ONLY counts: the census accumulates from boot, so subtract the
    // snapshot taken on entering the window
    const a = new Map((censusA || []).map(([k, v]) => [k, v]));
    res.census = censusB.map(([k, v]) => [k, v - (a.get(k) || 0)]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
    console.log('[census ' + arm.name + ' window ' + W0 + '-' + W1 + '] ' + JSON.stringify(res.census.slice(0, 70)));
  }
  if (prof) res.attribution = await attribute(page, prof);
  res.wasmMd5 = null;
  await ctx.close();
  return res;
}

// ---- profile attribution -------------------------------------------------
// The shipped n64wasm.wasm has no name section, so core frames are
// wasm-function[N]. Interpreter ops are recovered EXACTLY: every
// precomp_instr.ops in every compiled page is a wasm-table index, and
// wasmTable.get(idx).name is the function index (JS-API: an exported wasm
// function's name is its index). The mnemonic comes from decoding the guest
// word at precomp_instr.addr out of RDRAM. A sample is then attributed to the
// FIRST labelled frame walking from the leaf toward the root, so work done
// inside an MMIO handler that an interpreter SW called is charged to
// "under interp SW" rather than silently to "core".
async function attribute(page, prof) {
  const labels = await page.evaluate(() => {
    const M = window.Module, pp = window.__rig.params;
    if (!pp) return null;
    const U = M.HEAPU32, q = pp >> 2, out = {};
    const T = M.wasmTable, tlen = T.length;
    const fnIdx = (ti) => { try { const f = T.get(ti); return f ? String(f.name) : null; } catch (e) { return null; } };
    const put = (ti, label) => { const k = fnIdx(ti); if (k !== null && !(k in out)) out[k] = label; };
    put(U[q + 17], 'core:gen_interrupt'); put(U[q + 42], 'core:jump_to_func'); put(U[q + 33], 'core:NOTCOMPILED');
    put(U[q + 21], 'mem:read_rdram'); put(U[q + 22], 'mem:read_rdramb'); put(U[q + 23], 'mem:read_rdramh');
    put(U[q + 28], 'mem:write_rdram'); put(U[q + 29], 'mem:write_rdramb'); put(U[q + 30], 'mem:write_rdramh');
    put(U[q + 39], 'mem:read_rdramd'); put(U[q + 40], 'mem:write_rdramd');
    // distinct handler funcs in the live dispatch tables
    [[18, 'mem:readmem'], [19, 'mem:readmemb'], [20, 'mem:readmemh'], [37, 'mem:readmemd'],
     [25, 'mem:writemem'], [26, 'mem:writememb'], [27, 'mem:writememh'], [38, 'mem:writememd']].forEach(([k, name]) => {
      const base = U[q + k] >> 2, seen = new Set();
      for (let i = 0; i < 0x10000; i++) { const ti = U[base + i]; if (!seen.has(ti)) { seen.add(ti); put(ti, name + '#' + ti); } }
    });
    const blocksBase = U[q + 32] >> 2, stride = U[q + 4], dram = U[q + 24];
    const M_OP = { 2: 'J', 3: 'JAL', 4: 'BEQ', 5: 'BNE', 6: 'BLEZ', 7: 'BGTZ', 8: 'ADDI', 9: 'ADDIU', 10: 'SLTI', 11: 'SLTIU', 12: 'ANDI', 13: 'ORI', 14: 'XORI', 15: 'LUI',
      16: 'COP0', 17: 'COP1', 20: 'BEQL', 21: 'BNEL', 22: 'BLEZL', 23: 'BGTZL', 24: 'DADDI', 25: 'DADDIU', 26: 'LDL', 27: 'LDR',
      32: 'LB', 33: 'LH', 34: 'LWL', 35: 'LW', 36: 'LBU', 37: 'LHU', 38: 'LWR', 39: 'LWU', 40: 'SB', 41: 'SH', 42: 'SWL', 43: 'SW', 44: 'SDL', 45: 'SDR', 46: 'SWR', 47: 'CACHE',
      48: 'LL', 49: 'LWC1', 53: 'LDC1', 55: 'LD', 56: 'SC', 57: 'SWC1', 61: 'SDC1', 63: 'SD' };
    const M_SP = { 0: 'SLL', 2: 'SRL', 3: 'SRA', 4: 'SLLV', 6: 'SRLV', 7: 'SRAV', 8: 'JR', 9: 'JALR', 12: 'SYSCALL', 13: 'BREAK', 15: 'SYNC', 16: 'MFHI', 17: 'MTHI', 18: 'MFLO', 19: 'MTLO',
      20: 'DSLLV', 22: 'DSRLV', 23: 'DSRAV', 24: 'MULT', 25: 'MULTU', 26: 'DIV', 27: 'DIVU', 28: 'DMULT', 29: 'DMULTU', 30: 'DDIV', 31: 'DDIVU', 32: 'ADD', 33: 'ADDU', 34: 'SUB', 35: 'SUBU',
      36: 'AND', 37: 'OR', 38: 'XOR', 39: 'NOR', 42: 'SLT', 43: 'SLTU', 44: 'DADD', 45: 'DADDU', 46: 'DSUB', 47: 'DSUBU', 56: 'DSLL', 58: 'DSRL', 59: 'DSRA', 60: 'DSLL32', 62: 'DSRL32', 63: 'DSRA32' };
    const mn = (w) => {
      const op = w >>> 26;
      if (w === 0) return 'NOP';
      if (op === 0) return M_SP[w & 63] || ('SPECIAL' + (w & 63));
      if (op === 1) return 'REGIMM' + ((w >>> 16) & 31);
      if (op === 17) { const rs = (w >>> 21) & 31; return rs === 8 ? 'BC1' : rs >= 16 ? 'COP1.' + ['S', 'D', '?', '?', 'W', 'L'][rs - 16] + '.' + (w & 63) : 'COP1.' + rs; }
      if (op === 16) return 'COP0.' + ((w >>> 21) & 31);
      return M_OP[op] || ('OP' + op);
    };
    let pages = 0, instrs = 0;
    for (let k = 0; k < 0x100000; k++) {
      const bp = U[blocksBase + k];
      if (!bp) continue;
      const blk = U[bp >> 2], start = U[(bp >> 2) + 1], end = U[(bp >> 2) + 2];
      if (!blk || end <= start) continue;
      pages++;
      const len = (end - start) >>> 2;
      for (let i = 0; i < len; i++) {
        const ip = blk + i * stride, ti = U[ip >> 2];
        if (!ti || ti >= tlen) continue;
        const k2 = fnIdx(ti);
        if (k2 === null || k2 in out) continue;
        const a = (start + i * 4) >>> 0;
        if (a >= 0x80000000 && a < 0xC0000000) {
          const w = U[(dram >> 2) + ((a & 0x7FFFFF) >>> 2)];
          out[k2] = 'interp:' + mn(w); instrs++;
        }
      }
    }
    return { out, pages, instrs };
  });
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const L = labels ? labels.out : {};
  const coreUrl = (u) => /n64wasm\.wasm/.test(u);
  const frameLabel = (n) => {
    const cf = n.callFrame, fn = cf.functionName || '', url = cf.url || '';
    if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)' || fn === '(root)') return fn;
    const m = fn.match(/^(?:wasm-function\[|\$func|\$f)(\d+)\]?$/);
    if (url.startsWith('wasm://') || (m && !coreUrl(url))) {
      if (!coreUrl(url)) return 'jit:block';
    }
    if (m && coreUrl(url)) return L[m[1]] || null;
    if (/n64wasm\.js/.test(url)) return 'glue:' + fn;
    if (/index\.html/.test(url)) return 'page:' + fn;
    if (/mips_emit/.test(url)) return 'jit:emitter-js';
    if (url) return 'js:' + url.split('/').pop().slice(0, 30) + ':' + fn;
    return 'native:' + fn;
  };
  const self = new Map(); let total = 0;
  for (let i = 0; i < prof.samples.length; i++) { const d = prof.timeDeltas[i] || 0; total += d; self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + d); }
  const cat = {}, leafFn = {};
  for (const [id, us] of self) {
    const n = byId.get(id);
    const leaf = frameLabel(n);
    let label = leaf, via = null;
    if (label === null) {
      // unlabelled core function: charge it to the nearest labelled ancestor
      let p = parent.get(id);
      while (p !== undefined) { const l = frameLabel(byId.get(p)); if (l) { via = l; break; } p = parent.get(p); }
      label = 'core(unlabelled) under ' + (via || '?');
      const fk = n.callFrame.functionName + ' under ' + (via || '?');
      leafFn[fk] = (leafFn[fk] || 0) + us;
    }
    cat[label] = (cat[label] || 0) + us;
  }
  const pct = (x) => +(100 * x / total).toFixed(2);
  // WHO is an unlabelled hot function? For the top few, list the table slots
  // that hold it and the guest instructions whose precomp ops point there.
  const hotUnl = Object.entries(leafFn).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k]) => (k.match(/^(?:wasm-function\[|\$func|\$f)(\d+)\]?/) || [])[1]).filter(Boolean);
  const who = hotUnl.length ? await page.evaluate((names) => {
    const M = window.Module, pp = window.__rig.params, U = M.HEAPU32, q = pp >> 2, T = M.wasmTable, out = {};
    const want = new Set(names), slots = {};
    for (let ti = 1; ti < T.length; ti++) { let f = null; try { f = T.get(ti); } catch (e) {} if (f && want.has(String(f.name))) (slots[f.name] = slots[f.name] || []).push(ti); }
    const pidx = {}; for (let k = 0; k < 46; k++) pidx[U[q + k]] = k;
    const blocksBase = U[q + 32] >> 2, stride = U[q + 4], dram = U[q + 24];
    for (const n of names) {
      const ts = slots[n] || [], hits = [];
      for (let k = 0; k < 0x100000 && hits.length < 4; k++) {
        const bp = U[blocksBase + k]; if (!bp) continue;
        const blk = U[bp >> 2], start = U[(bp >> 2) + 1], end = U[(bp >> 2) + 2];
        if (!blk || end <= start) continue;
        for (let i = 0; i < ((end - start) >>> 2) && hits.length < 4; i++) {
          if (ts.includes(U[(blk + i * stride) >> 2])) { const a = (start + i * 4) >>> 0; hits.push(a.toString(16) + ':' + (a >= 0x80000000 && a < 0xC0000000 ? (U[(dram >> 2) + ((a & 0x7FFFFF) >>> 2)] >>> 0).toString(16) : '?')); }
        }
      }
      out[n] = { tableSlots: ts.slice(0, 6), paramIdx: ts.filter((t) => pidx[t] !== undefined).map((t) => pidx[t]), opsAt: hits };
    }
    return out;
  }, hotUnl).catch((e) => ({ error: String(e).slice(0, 120) })) : null;
  return {
    who,
    labelled: labels ? { pages: labels.pages, interpFns: labels.instrs, total: Object.keys(L).length } : null,
    totalMs: +(total / 1000).toFixed(1),
    categories: Object.entries(cat).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, v]) => [k, pct(v)]),
    unlabelledTop: Object.entries(leafFn).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, pct(v)]),
  };
}

const results = [];
try {
  for (let r = 0; r < ROUNDS; r++) {
    const order = (r % 2 === 0) ? ARMS : [...ARMS].reverse();
    for (const arm of order) {
      const res = await runArm(arm, r, { profile: r === 0 && PROFILE_ARM === arm.name });
      results.push(res);
      const summary = { round: r, arm: res.arm, costMsPerFrame: res.costMsPerFrame, callMsPerFrame: res.callMsPerFrame,
        wallMsPerFrame: res.wallMsPerFrame, capX: res.capX, load: res.load, frames: res.fp.length, compilesInWindow: res.compilesInWindow,
        jit: res.jit ? { blocks: res.jit.blocks, nativeOps: res.jit.nativeOps, fallbackOps: res.jit.fallbackOps,
          nullOpsRejects: res.jit.nullOpsRejects, emitFails: res.jit.emitFails, mode: res.jit.mode, cacheHits: res.jit.cacheHits, labelEntries: res.jit.labelEntries, pageTruncated: res.jit.pageTruncated, pinnedBlocks: res.jit.pinnedBlocks, pinnedRegs: res.jit.pinnedRegs } : null,
        errs: res.errs.slice(0, 3), logs: res.logs.slice(0, 4) };
      console.log(JSON.stringify(summary));
      if (res.attribution) console.log(JSON.stringify(res.attribution, null, 1));
    }
  }
} finally {
  await browser.close().catch(() => {});
}

// ---- bit-identity verdicts: every arm against the first arm of round 0 ----
const ref = results[0];
const firstDiff = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; };
let fails = 0;
for (const r of results.slice(1)) {
  const dfp = firstDiff(ref.fp, r.fp), drd = HASH ? firstDiff(ref.rd, r.rd) : -1, dfb = HASH ? firstDiff(ref.fb, r.fb) : -1;
  const ok = dfp < 0 && drd < 0 && dfb < 0 && r.fp.length === FRAMES;
  if (!ok) fails++;
  if (FBSEQ && ref.fbseq && r.fbseq) {
    const d = firstDiff(ref.fbseq, r.fbseq);
    console.log(`[fbseq] ${ref.arm} ${ref.fbseq.length} calls, ${r.arm} ${r.fbseq.length} calls, first difference at call ${d}` +
      (d >= 0 ? ` (${ref.fbseq[d]} vs ${r.fbseq[d]})` : ''));
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${ref.arm}#${ref.round} vs ${r.arm}#${r.round}: frames=${r.fp.length}` +
    ` fpFirstDiff=${dfp}` + (HASH ? ` rdramFirstDiff=${drd} fbFirstDiff=${dfb} rdramDiffFrames=${ref.rd.filter((h, k) => h !== r.rd[k]).length}` : ''));
}
// ---- timing summary: per arm, all rounds ----
const byArm = {};
for (const r of results) (byArm[r.arm] = byArm[r.arm] || []).push(r);
for (const [a, rs] of Object.entries(byArm)) {
  console.log(`[timing] ${a}: costMs/frame ${rs.map((r) => r.costMsPerFrame).join(' / ')}  cap ${rs.map((r) => r.capX).join(' / ')}x  load ${rs.map((r) => (r.load || []).join('->')).join(' / ')}`);
}
const jp = flag('json', '');
if (jp) fs.writeFileSync(jp, JSON.stringify({ argv, rom: ROM, plan: PLAN_NAME, frames: FRAMES, window: [W0, W1], cpu: CPU, results: results.map((r) => ({ ...r, fp: undefined, rd: undefined, fb: undefined, fpHead: r.fp.slice(0, 5) })) }, null, 1));
process.exit(fails ? 1 : 0);
