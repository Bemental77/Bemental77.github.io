#!/usr/bin/env node
// CAN THE DREAMCAST CORE ROLL BACK? — the measurement that decides it.
//
// Rollback netplay (lib/netplay.js `rollback`, genesis.html is the working
// integration) applies the local pad on the frame it was sampled, PREDICTS a
// remote pad that has not arrived, keeps a savestate of every frame's start,
// and — when a real input lands that differs from the guess — loads the start
// of the earliest wrong frame and re-simulates to the present without
// presenting. That is only possible if, for THIS core:
//   1. save + load are cheap enough to do every frame (size, save ms, load ms);
//   2. a rollback step (load + D re-simulated frames + saves) fits inside one
//      display tick with headroom;
//   3. a run WITH rollbacks arrives at the byte-identical state a straight run
//      reaches (otherwise the first misprediction is a permanent desync).
//
// NOTHING SHIPPED IS MODIFIED. A stepwise driver is injected into the live
// emulator worker through puppeteer's worker target (the technique
// dreamcast/tools/determinism_probe.mjs uses), the shipped wall-paced pump is
// stopped, and every frame is one _emscripten_run_iter() with the pad bytes
// written immediately before it. Saves and loads go through the SHIPPED
// exports (_emscripten_save_state / _emscripten_load_state), so the numbers
// are what an integration on today's binary would pay.
//
// ARMS (all start from load(S0), so every arm begins with the same state AND
// the same freshly-flushed JIT — see "THE JIT" below):
//   REF1, REF2 : straight runs, true pads, a save before EVERY frame (a real
//                rollback peer saves every frame whether or not it rolls back,
//                so the arms must match in that). REF1 == REF2 is the
//                self-determinism control; without it nothing below means
//                anything.
//   NOINPUT    : straight run, neutral pads. MUST DIFFER from REF — otherwise
//                the scripted input never reached the game and a rollback
//                "pass" would be void (the rig would be predicting a port the
//                game does not read).
//   RB         : the rollback algorithm. The predicted port's real input is
//                only known LAG frames late; until then it is predicted as its
//                last known value (repeat-last, lib/netplay.js _rbPredict).
//                On a misprediction: load the ring state of the earliest wrong
//                frame and re-simulate to the present. The state at the START
//                of frame k is hashed once every input < k is final.
//   PASS iff every hashed RB state equals REF1's for that frame.
//
// THE JIT. Emulator::loadstate (flycast-src/core/emulator.cpp:902-920) calls
// getSh4Executor()->ResetCache() -> bm_ResetCache() -> WasmDynarec::reset()
// -> jit_clear() (rec_wasm.cpp:2356-2423). So EVERY load flushes every
// compiled SH4 block, and the frames after it recompile. This rig measures
// that cost directly (the per-frame ms of the frames after a load).
//
// Nothing here is paced: it measures CAPACITY. The product never runs the
// guest faster than 1.000x (CLAUDE.md gate 9).
//
// USAGE (npm run web first; serialize probes with the lock)
//   node tools/browser_leak_guard.js reap && uptime
//   PUPPETEER_FROM=$HOME/probe-deps/ bash tools/probe_lock.sh run -- \
//     node dreamcast/tools/rollback_measure.mjs --game pso2 \
//          --state dreamcast/states/pso2_pioneer2_lobby.state --name pso-lobby
//   Results + blockers: dreamcast/docs/rollback/TASKS.md
// FLAGS
//   --game KEY        romSelect key (default pso2)
//   --state PATH      savestate to start from (raw retro_serialize bytes)
//   --frames N        frames per arm (default 240)
//   --every K         hash every K frames (default 4)
//   --lag L           frames the predicted port's input arrives late (default 4)
//   --port P          the PREDICTED port (default 0 — the port a 1P scene reads)
//   --warm N          straight frames run after the state load before S0 (default 240)
//   --reps R          timing reps for the isolated save/load microbench (default 12)
//   --query Q         extra dreamcast.html query string
//   --name TAG        output suffix. Output: /tmp/dc-rb/<TAG>.log / .json / .png
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WASM = path.join(REPO, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const md5 = (p) => { try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return 'unreadable'; } };

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const GAME = arg('game', 'pso2');
const STATE = arg('state', '');
const FRAMES = +arg('frames', 240);
const EVERY = +arg('every', 4);
const LAG = +arg('lag', 4);
const PORT = +arg('port', 0);
const WARM = +arg('warm', 240);
const REPS = +arg('reps', 12);
const QUERY = arg('query', '');
const NAME = arg('name', 'rb');
const URLBASE = arg('url', 'http://localhost:8080');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/dc-rb';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logf = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logf.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page.evaluate that cannot hang the rig: the page's main thread can be
// starved by the emulator, and one stuck evaluate would otherwise wait out the
// whole protocol timeout with nothing logged.
const evalT = (page, fn, ms = 15000) => Promise.race([page.evaluate(fn), sleep(ms).then(() => null)]);
async function until(page, fn, ms, everyMs = 500) {
  const t0 = Date.now();
  let lastSay = 0;
  for (;;) {
    let v = null;
    try { v = await evalT(page, fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (Date.now() - lastSay > 15000) {
      lastSay = Date.now();
      const p = await evalT(page, () => { const d = window.__dcProbe && window.__dcProbe(); return d ? (d.phase + ' disc ' + Math.round(100 * d.discBytes / (d.discTotal || 1)) + '% booted=' + d.booted + ' fps=' + d.fps + ' live=' + d.live + ' gated=' + JSON.stringify(d.boot)) : 'no probe'; }, 5000).catch(() => null);
      say('  waiting: ' + (p || '(page did not answer)'));
    }
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// THE WORKER-SIDE DRIVER. Installed as source into the emulator worker.
// ---------------------------------------------------------------------------
function driverSource(PORT, LAG) {
  return `(function(){
    const M = self.Module;
    if (!M) return { ok:false, err:'no Module' };
    for (const f of ['_emscripten_run_iter','_emscripten_get_maple_ptr','_emscripten_save_state',
                     '_emscripten_load_state','_flycast_run_iter_flag_ptr','_flycast_guest_cycles','_malloc','_free']) {
      if (typeof M[f] !== 'function') return { ok:false, err:'missing export ' + f };
    }
    const flagPtr = M._flycast_run_iter_flag_ptr() >>> 0;
    const R = self.__rb = { active:false, watchdog:0, unwinds:0 };
    const suspended = () => M.HEAPU8[flagPtr] !== 0;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    R.waitClean = async function(limit) {
      const t0 = Date.now();
      while (suspended()) { await sleep(1); if (Date.now() - t0 > (limit || 60000)) return false; }
      return true;
    };
    // Count watchdog truncations: rec_wasm.cpp's 2 s frame watchdog converts
    // wall time into guest trajectory. If it fires, a divergence is explained.
    const origPM = self.postMessage.bind(self);
    self.postMessage = function(msg, xfer) {
      try { if (msg && msg.cmd === 'print' && typeof msg.txt === 'string' && msg.txt.indexOf('[watchdog') === 0) R.watchdog++; } catch (_) {}
      return xfer ? origPM(msg, xfer) : origPM(msg);
    };
    // Drop the page's pad/frame traffic during a measured window.
    const prev = self.onmessage;
    R.prev = prev;
    self.onmessage = function(e) {
      const d = (e && e.data) || {};
      if (R.active && (d.cmd === 'input' || d.cmd === 'runFrame' || d.cmd === 'saveState' ||
                       d.cmd === 'loadState' || d.cmd === 'reset' || d.cmd === 'freerun' || d.cmd === 'lsInput')) return;
      return prev.call(self, e);
    };
    R.stopPump = () => { try { prev.call(self, { data: { cmd:'freerun', on:false } }); } catch (_) {} };
    R.startPump = () => { try { prev.call(self, { data: { cmd:'freerun', on:true } }); } catch (_) {} };

    // ---- save / load through the SHIPPED exports ----------------------------
    const pp = M._malloc(4), ps = M._malloc(4);
    R.save = function() {             // -> { ptr, size, ms } ; caller frees ptr
      const t0 = performance.now();
      const ok = M._emscripten_save_state(pp, ps);
      const ms = performance.now() - t0;
      if (!ok) return null;
      return { ptr: M.HEAPU32[pp >>> 2] >>> 0, size: M.HEAPU32[ps >>> 2] >>> 0, ms };
    };
    R.load = function(s) {            // -> ms, or -1 on failure
      const t0 = performance.now();
      const ok = M._emscripten_load_state(s.ptr, s.size);
      const ms = performance.now() - t0;
      return ok ? ms : -1;
    };
    R.free = (s) => { if (s && s.ptr) M._free(s.ptr); };
    R.hash = function(s) {            // FNV-1a over the state words, no copy
      const u8 = M.HEAPU8;
      const n = s.size >>> 2;
      const u32 = new Uint32Array(u8.buffer, s.ptr, n);   // malloc => 8-aligned
      let h = 0x811c9dc5;
      for (let i = 0; i < n; i++) { h ^= u32[i]; h = Math.imul(h, 0x01000193) >>> 0; }
      for (let b = n << 2; b < s.size; b++) { h ^= u8[s.ptr + b]; h = Math.imul(h, 0x01000193) >>> 0; }
      return h >>> 0;
    };
    // ---- one frame -----------------------------------------------------------
    const padPtr = () => M._emscripten_get_maple_ptr() >>> 0;
    R.frame = async function(pads) {  // -> ms (wall, incl. any asyncify suspend)
      if (!(await R.waitClean())) throw new Error('stuck suspended');
      M.HEAPU8.set(pads, padPtr());
      const t0 = performance.now();
      try { M._emscripten_run_iter(); }
      catch (err) {
        const isUnwind = err && (err === 'unwind' || err.message === 'unwind');
        if (!isUnwind) throw err;
        R.unwinds++;
      }
      if (suspended()) { R.unwinds++; if (!(await R.waitClean())) throw new Error('never rewound'); }
      return performance.now() - t0;
    };
    // ---- scripted pads ------------------------------------------------------
    // The PREDICTED port changes every 5-9 frames so predictions fail often;
    // the other port is "local" (known on time) and changes on its own beat.
    // Pad layout (EmscriptenWorker.cpp input_state_cb): bytes 0..7 buttons,
    // 8..9 s16 LE stick X, 10..11 stick Y; port p at p*64.
    const DIRS = [[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
    R.padOf = function(f, port) {     // -> Uint8Array(64)
      const b = new Uint8Array(64);
      if (f < 0) return b;             // before the first known input: neutral
      const seg = port === ${PORT} ? Math.floor(f / 7) : Math.floor(f / 11);
      const d = DIRS[(seg * 5 + (seg >> 2) + port * 3) % DIRS.length];
      const lx = (d[0] * 32767) | 0, ly = (d[1] * 32767) | 0;
      b[8] = lx & 255; b[9] = (lx >> 8) & 255; b[10] = ly & 255; b[11] = (ly >> 8) & 255;
      if (((seg + port) % 3) === 0) b[0] |= 1;         // B = DC A / confirm, pulsed
      return b;
    };
    const image = (f, predictedPortPad) => {
      const u = new Uint8Array(256);
      for (let p = 0; p < 2; p++) u.set(p === ${PORT} ? (predictedPortPad || R.padOf(f, p)) : R.padOf(f, p), p * 64);
      return u;
    };
    const NEUTRAL = new Uint8Array(256);

    // ---- warm: straight frames, no saves -----------------------------------
    R.warm = async function(n) {
      R.active = true;
      try { for (let f = 0; f < n; f++) await R.frame(image(f)); }
      finally { R.active = false; }
      return true;
    };

    // ---- isolated save/load microbench -------------------------------------
    R.bench = async function(reps) {
      R.active = true;
      const out = { saveMs: [], loadMs: [], size: 0, afterLoadFrameMs: [], steadyFrameMs: [] };
      try {
        await R.waitClean();
        // steady-state frame cost, no saves, no loads
        for (let i = 0; i < 60; i++) out.steadyFrameMs.push(await R.frame(image(10000 + i)));
        for (let r = 0; r < reps; r++) {
          await R.waitClean();
          const s = R.save(); if (!s) throw new Error('save failed');
          out.size = s.size; out.saveMs.push(s.ms);
          // 8 frames after the save, then load back and time the 8 frames that
          // follow the LOAD — the recompile cost a rollback would pay.
          for (let i = 0; i < 8; i++) await R.frame(image(20000 + i));
          await R.waitClean();
          const lm = R.load(s); if (lm < 0) throw new Error('load failed');
          out.loadMs.push(lm);
          const row = [];
          for (let i = 0; i < 8; i++) row.push(await R.frame(image(20000 + i)));
          out.afterLoadFrameMs.push(row);
          R.free(s);
        }
      } finally { R.active = false; }
      return out;
    };

    // ---- the arms ----------------------------------------------------------
    R.anchor = null;
    R.setAnchor = async function() { await R.waitClean(); R.anchor = R.save(); return R.anchor ? R.anchor.size : 0; };

    // Straight run: save before every frame; hash the saved start-of-frame state every K.
    R.straight = async function(frames, every, neutral, nosave) {
      R.active = true;
      const hashes = {}, frameMs = [], saveMs = [];
      const wd0 = R.watchdog;
      try {
        await R.waitClean();
        if (R.load(R.anchor) < 0) throw new Error('anchor load failed');
        for (let f = 0; f < frames; f++) {
          await R.waitClean();
          if (!nosave) {
            const s = R.save(); if (!s) throw new Error('save failed at ' + f);
            saveMs.push(s.ms);
            if ((f % every) === 0) hashes[f] = R.hash(s);
            R.free(s);
          }
          frameMs.push(await R.frame(neutral ? NEUTRAL : image(f)));
        }
        await R.waitClean();
        const s = R.save(); hashes[frames] = R.hash(s); R.free(s);
      } finally { R.active = false; }
      return { hashes, frameMs, saveMs, watchdog: R.watchdog - wd0, cycles: M._flycast_guest_cycles() };
    };

    // Rollback run. The predicted port's real input for frame k is known once
    // the loop reaches frame k + LAG. Prediction = last known real input.
    R.rollback = async function(frames, every, lag) {
      R.active = true;
      const ring = new Map();            // frame -> saved start-of-frame state
      const used = new Map();            // frame -> the predicted-port pad it last ran on
      const hashes = {};
      const st = { rollbacks: 0, resim: 0, maxDepth: 0, loadMs: [], resimFrameMs: [], resimSaveMs: [],
                   presentFrameMs: [], firstAfterLoadMs: [], stepMs: [], predictedFrames: 0, mispredicted: 0 };
      const wd0 = R.watchdog;
      let knownTo = -1;                  // real predicted-port input known for every frame <= knownTo
      let hashedTo = -1;
      const predicted = (k) => (k <= knownTo) ? R.padOf(k, ${PORT}) : R.padOf(Math.min(knownTo, k - 1), ${PORT});
      const same = (a, b) => { for (let i = 0; i < 64; i++) if (a[i] !== b[i]) return false; return true; };
      const runFrame = async (k, isResim) => {
        await R.waitClean();
        const s = R.save(); if (!s) throw new Error('save failed at ' + k);
        const old = ring.get(k); if (old) R.free(old);
        ring.set(k, s);
        if (isResim) st.resimSaveMs.push(s.ms);
        const pad = knownTo >= 0 ? predicted(k) : new Uint8Array(64);
        if (k > knownTo) st.predictedFrames++;
        used.set(k, pad);
        return await R.frame(image(k, pad));
      };
      try {
        await R.waitClean();
        if (R.load(R.anchor) < 0) throw new Error('anchor load failed');
        for (let f = 0; f < frames; f++) {
          // 1. inputs arrive: the real pad for frame f - lag is now known.
          let from = Infinity;
          const newKnown = f - lag;
          while (knownTo < newKnown) {
            knownTo++;
            const u = used.get(knownTo);
            if (u && !same(u, R.padOf(knownTo, ${PORT}))) { st.mispredicted++; if (knownTo < from) from = knownTo; }
          }
          // A later frame run on a now-stale prediction is also wrong: the
          // prediction for k > knownTo repeats knownTo, which just changed.
          if (from === Infinity) {
            for (let k = Math.max(0, knownTo + 1); k < f; k++) {
              const u = used.get(k);
              if (u && !same(u, predicted(k))) { from = k; break; }
            }
          }
          // 2. roll back if needed.
          const tStep = performance.now();
          if (from < f) {
            const depth = f - from;
            const s0 = ring.get(from);
            if (!s0) throw new Error('no ring state for frame ' + from);
            await R.waitClean();
            const lm = R.load(s0); if (lm < 0) throw new Error('rollback load failed');
            st.loadMs.push(lm);
            st.rollbacks++; st.resim += depth; if (depth > st.maxDepth) st.maxDepth = depth;
            for (let k = from; k < f; k++) {
              const ms = await runFrame(k, true);
              st.resimFrameMs.push(ms);
              if (k === from) st.firstAfterLoadMs.push(ms);
            }
          }
          // 3. the present frame.
          const pm = await runFrame(f, false);
          if (from < f) { st.presentFrameMs.push(pm); st.stepMs.push(performance.now() - tStep); }
          // 4. hash the start-of-frame states that are now FINAL (every input < k final).
          while (hashedTo + 1 <= knownTo + 1 && hashedTo + 1 <= f) {
            const k = hashedTo + 1;
            if ((k % every) === 0 && ring.get(k)) hashes[k] = R.hash(ring.get(k));
            hashedTo = k;
          }
          // 5. evict what no rollback can reach.
          for (const k of Array.from(ring.keys())) if (k < knownTo - 1) { R.free(ring.get(k)); ring.delete(k); }
        }
      } finally {
        for (const s of ring.values()) R.free(s);
        R.active = false;
      }
      st.watchdog = R.watchdog - wd0;
      return { hashes, stats: st };
    };
    return { ok: true };
  })()`;
}

// WORKER EVALUATION OVER RAW CDP. puppeteer's WebWorker.evaluate() waits for a
// Runtime.executionContextCreated event it subscribes to with once(); on this
// box (puppeteer 25.12, Chrome 140) that event never arrives for the emulator
// worker and every evaluate hangs forever — three runs of this rig stalled
// there. Runtime.evaluate without a contextId runs in the worker's default
// context and returns.
async function wEval(w, expr) {
  const r = await w.client.send('Runtime.evaluate', { expression: String(expr), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('worker threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}

// Push a state file into the worker and load it.
const B64_SLICE = 4 << 20;
async function pushState(worker, buf) {
  await wEval(worker, `self.__rbIn = new Uint8Array(${buf.length}); self.__rbOff = 0; true`);
  for (let off = 0; off < buf.length; off += B64_SLICE) {
    const b64 = buf.subarray(off, Math.min(buf.length, off + B64_SLICE)).toString('base64');
    await wEval(worker, `(function(){
      const bin = atob(${JSON.stringify(b64)}); const u8 = self.__rbIn;
      for (let i = 0; i < bin.length; i++) u8[self.__rbOff + i] = bin.charCodeAt(i);
      self.__rbOff += bin.length; return self.__rbOff; })()`);
  }
  return wEval(worker, `(async()=>{
    const M = self.Module; await self.__rb.waitClean();
    const p = M._malloc(self.__rbIn.length); M.HEAPU8.set(self.__rbIn, p);
    const ok = M._emscripten_load_state(p, self.__rbIn.length) | 0; M._free(p); self.__rbIn = null; return ok; })()`);
}

const stat = (a) => {
  if (!a || !a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: +s[0].toFixed(2), p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), max: +s[s.length - 1].toFixed(2),
           mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) };
};

const report = { wasmMd5Before: md5(WASM), wasmMd5After: null, game: GAME, state: STATE, frames: FRAMES, every: EVERY,
                 lag: LAG, port: PORT, loadBefore: null, loadAfter: null };
let browser = null;
async function finish(code) {
  report.wasmMd5After = md5(WASM);
  report.loadAfter = execSync('uptime').toString().trim();
  say('wasm md5 AFTER: ' + report.wasmMd5After + (report.wasmMd5After === report.wasmMd5Before ? ' (STABLE)' : ' ⚠ CHANGED MID-RUN — DISCARD'));
  say('load after: ' + report.loadAfter);
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(report, null, 2));
  say('json -> ' + path.join(OUT, NAME + '.json'));
  try { if (browser) await browser.close(); } catch (_) {}
  logf.end(); await sleep(100); process.exit(code);
}

try {
  report.loadBefore = execSync('uptime').toString().trim();
  say('wasm md5 BEFORE: ' + report.wasmMd5Before);
  say('load before: ' + report.loadBefore);
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 1800000,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
           '--autoplay-policy=no-user-gesture-required'],
    userDataDir: '/tmp/dc-rb/profile-' + process.pid,
  });
  try { require(path.join(REPO, 'tools', 'browser_leak_guard.js')).guard(browser, 'rollback_measure'); } catch (_) {}
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => say('  [page!] ' + ((e && e.message) || String(e))));
  await page.goto(URLBASE + '/dreamcast.html' + (QUERY ? '?' + QUERY : ''), { waitUntil: 'domcontentloaded', timeout: 120000 });
  if (!(await until(page, () => self.crossOriginIsolated === true && typeof window.__dcProbe === 'function', 90000)))
    throw new Error('page never became cross-origin isolated');
  await page.evaluate(() => setInterval(() => {
    const el = document.getElementById('xboxInputPrompt');
    if (el && el.style.display !== 'none') { const no = document.getElementById('xboxInputPromptNo'); if (no) no.click(); else el.style.display = 'none'; }
  }, 250));
  await page.evaluate((g) => { const s = document.getElementById('romSelect'); s.value = g; s.dispatchEvent(new Event('change')); document.getElementById('btnStart').click(); }, GAME);
  const booted = await until(page, () => window.__dcProbe && window.__dcProbe().booted, 600000, 1000);
  if (!booted) throw new Error('never booted');
  say('booted; waiting for distinct frames');
  await until(page, () => { const d = window.__dcProbe(); return d.framesEver && d.distinctEver; }, 180000);
  say('frames flowing; locating worker');
  const hb = setInterval(() => say('  hb: workers=' + page.workers().map((w) => w.url().split('/').pop()).join(',')), 10000);
  let worker = null;
  // ⚠ NOT /flycast_worker/: that also matches flycast_worker_emcc.worker.js, the
  // PTHREAD pool, whose threads sit in Atomics.wait and never answer an
  // evaluate — the first run of this rig hung there forever. Pick the one
  // worker that answers AND owns Module._emscripten_run_iter.
  for (let i = 0; i < 60 && !worker; i++) {
    for (const w of page.workers()) {
      if (!/flycast_worker\.js/.test(w.url())) continue;
      say('  probing worker ' + w.url().split('/').pop());
      const okw = await Promise.race([wEval(w, '!!(self.Module && self.Module._emscripten_run_iter)').catch(() => false), sleep(3000).then(() => false)]);
      if (okw) { worker = w; break; }
    }
    if (!worker) await sleep(500);
  }
  if (!worker) throw new Error('no flycast worker target');
  clearInterval(hb);
  say('worker ' + worker.url() + '; installing driver');
  const inst = await Promise.race([wEval(worker, driverSource(PORT, LAG)), sleep(60000).then(() => ({ ok: false, err: 'driver install timed out (worker did not answer in 60 s)' }))]);
  if (!inst || !inst.ok) throw new Error('driver install failed: ' + (inst && inst.err));
  await wEval(worker, 'self.__rb.stopPump(); true');
  await sleep(300);
  say('driver installed; shipped pump STOPPED');
  if (STATE) {
    const buf = fs.readFileSync(path.resolve(REPO, STATE));
    const ok = await pushState(worker, buf);
    say(`state ${STATE} (${buf.length} B) load=${ok ? 'OK' : 'FAILED'}`);
    if (!ok) { report.error = 'state load failed'; await finish(3); }
    report.stateBytes = buf.length;
  }
  say(`warm: ${WARM} straight frames`);
  await wEval(worker, `self.__rb.warm(${WARM})`);
  await page.screenshot({ path: path.join(OUT, NAME + '-scene.png') });
  say('scene screenshot -> ' + path.join(OUT, NAME + '-scene.png'));

  // ---- 1. isolated save/load + post-load frame cost ----
  const b = await wEval(worker, `self.__rb.bench(${REPS})`);
  report.bench = {
    stateBytes: b.size, saveMs: stat(b.saveMs), loadMs: stat(b.loadMs), steadyFrameMs: stat(b.steadyFrameMs),
    afterLoadFrameMs: b.afterLoadFrameMs[0] ? b.afterLoadFrameMs[0].map((_, i) => stat(b.afterLoadFrameMs.map((r) => r[i]))) : [],
    afterLoadFirst8SumMs: stat(b.afterLoadFrameMs.map((r) => r.reduce((x, y) => x + y, 0))),
  };
  say('BENCH state=' + b.size + ' B');
  say('BENCH save ms ' + JSON.stringify(report.bench.saveMs));
  say('BENCH load ms ' + JSON.stringify(report.bench.loadMs));
  say('BENCH steady frame ms ' + JSON.stringify(report.bench.steadyFrameMs));
  report.bench.afterLoadFrameMs.forEach((s, i) => say(`BENCH frame #${i + 1} after load ms ` + JSON.stringify(s)));
  say('BENCH first 8 frames after a load, summed ms ' + JSON.stringify(report.bench.afterLoadFirst8SumMs));

  // ---- 2. exactness arms ----
  const size = await wEval(worker, 'self.__rb.setAnchor()');
  say('anchor S0 saved (' + size + ' B)');
  // REF0: the same straight run WITHOUT a save before every frame — separates
  // what the per-frame save costs from what the anchor load's JIT flush costs.
  const ref0 = await wEval(worker, `self.__rb.straight(${FRAMES}, ${EVERY}, false, true)`);
  say(`REF0 (no per-frame saves) done: frame ms ${JSON.stringify(stat(ref0.frameMs))} last60 ${JSON.stringify(stat(ref0.frameMs.slice(-60)))}`);
  report.ref0 = { frameMs: stat(ref0.frameMs), last60FrameMs: stat(ref0.frameMs.slice(-60)) };
  const ref1 = await wEval(worker, `self.__rb.straight(${FRAMES}, ${EVERY}, false)`);
  say(`REF1 done: last60 frame ms ${JSON.stringify(stat(ref1.frameMs.slice(-60)))} frame ms ${JSON.stringify(stat(ref1.frameMs))} save ms ${JSON.stringify(stat(ref1.saveMs))} watchdog=${ref1.watchdog}`);
  const ref2 = await wEval(worker, `self.__rb.straight(${FRAMES}, ${EVERY}, false)`);
  say(`REF2 done: frame ms ${JSON.stringify(stat(ref2.frameMs))} watchdog=${ref2.watchdog}`);
  const noin = await wEval(worker, `self.__rb.straight(${FRAMES}, ${EVERY}, true)`);
  say(`NOINPUT done: watchdog=${noin.watchdog}`);
  const rb = await wEval(worker, `self.__rb.rollback(${FRAMES}, ${EVERY}, ${LAG})`);
  const s = rb.stats;
  say(`RB done: rollbacks=${s.rollbacks} resim=${s.resim} maxDepth=${s.maxDepth} mispredicted=${s.mispredicted} predictedFrames=${s.predictedFrames} watchdog=${s.watchdog}`);

  const cmp = (A, B) => {
    const keys = Object.keys(A).map(Number).filter((k) => B[k] !== undefined).sort((x, y) => x - y);
    let first = null, match = 0;
    for (const k of keys) { if (A[k] === B[k]) match++; else if (first === null) first = k; }
    return { compared: keys.length, matched: match, firstDiverge: first };
  };
  report.exact = {
    selfREF1vsREF2: cmp(ref1.hashes, ref2.hashes),
    controlREFvsNOINPUT: cmp(ref1.hashes, noin.hashes),
    rollbackREF1vsRB: cmp(ref1.hashes, rb.hashes),
  };
  report.rb = {
    rollbacks: s.rollbacks, resimFrames: s.resim, maxDepth: s.maxDepth, mispredicted: s.mispredicted, watchdog: s.watchdog,
    loadMs: stat(s.loadMs), resimFrameMs: stat(s.resimFrameMs), resimSaveMs: stat(s.resimSaveMs),
    firstFrameAfterLoadMs: stat(s.firstAfterLoadMs), presentFrameAfterRollbackMs: stat(s.presentFrameMs),
    wholeRollbackStepMs: stat(s.stepMs),
  };
  report.ref = { frameMs: stat(ref1.frameMs), saveMs: stat(ref1.saveMs) };
  say('EXACT self  REF1 vs REF2   ' + JSON.stringify(report.exact.selfREF1vsREF2));
  say('EXACT ctrl  REF vs NOINPUT ' + JSON.stringify(report.exact.controlREFvsNOINPUT) + '  (must DIFFER)');
  say('EXACT rb    REF1 vs RB     ' + JSON.stringify(report.exact.rollbackREF1vsRB));
  say('RB load ms ' + JSON.stringify(report.rb.loadMs));
  say('RB re-sim frame ms ' + JSON.stringify(report.rb.resimFrameMs));
  say('RB first frame after a load ms ' + JSON.stringify(report.rb.firstFrameAfterLoadMs));
  say('RB whole rollback step (load + resim + present) ms ' + JSON.stringify(report.rb.wholeRollbackStepMs));
  const selfOk = report.exact.selfREF1vsREF2.firstDiverge === null && report.exact.selfREF1vsREF2.compared > 0;
  const ctrlOk = report.exact.controlREFvsNOINPUT.firstDiverge !== null;
  const rbOk = report.exact.rollbackREF1vsRB.firstDiverge === null && report.exact.rollbackREF1vsRB.compared > 0;
  report.verdict = !selfOk ? 'VOID: the core is not self-deterministic in this configuration'
    : !ctrlOk ? 'VOID: the scripted input never reached the game (REF == NOINPUT)'
    : rbOk ? 'EXACT: a run with rollbacks reached the same state as the straight run at every compared frame'
    : 'DIVERGED: the rollback run left the straight run at frame ' + report.exact.rollbackREF1vsRB.firstDiverge;
  say('VERDICT: ' + report.verdict);
  await page.screenshot({ path: path.join(OUT, NAME + '-end.png') });
  await finish(0);
} catch (e) {
  say('ERROR: ' + ((e && e.stack) || e));
  report.error = String((e && e.message) || e);
  await finish(1);
}
