// IS THE DREAMCAST CORE FRAME-DETERMINISTIC ENOUGH FOR LOCKSTEP NETPLAY?
//
// THE DECISION THIS EXISTS TO UNBLOCK
//   `lib/netplay.js:29-40` refuses deterministic lockstep in writing, on the
//   grounds that "Nothing here has been shown to be deterministic to that
//   standard." That is an ASSUMPTION. This rig replaces it with a MEASUREMENT.
//
// THE QUESTION, PRECISELY
//   Given (a) the same flycast_worker_emcc.wasm, (b) the same savestate loaded
//   into two independent instances, and (c) an identical input sequence applied
//   at identical EMULATED FRAME NUMBERS — do the two instances produce identical
//   emulator state, frame after frame, and for how long?
//
// WHY THE SHIPPED PUMP CANNOT ANSWER IT
//   The shipped pump (flycast_worker.js:496-540) is WALL-PACED: it runs one
//   `_emscripten_run_iter()` then inserts a `setTimeout` delay computed from
//   `performance.now()` vs `_flycast_guest_cycles()`. So "frame N" happens at a
//   different wall instant in each instance, and any input keyed to wall time
//   lands on a DIFFERENT FRAME in each. Wall-clock-keyed input cannot answer a
//   determinism question. This rig therefore STOPS the shipped pump
//   (`{cmd:'freerun', on:false}`) and drives `_emscripten_run_iter()` ITSELF,
//   one frame at a time, writing the frame's pad bytes into
//   `_emscripten_get_maple_ptr()` immediately before each iteration. Input is a
//   pure function of the emulated frame index and nothing else.
//
//   NOTE THE GOVERNOR IS NOT ITSELF SUSPECT FOR *CONTENT*: it only chooses WHEN
//   the next iteration starts, never how much work one does (the delay is
//   applied after run_iter returns, flycast_worker.js:527-537). What it does do
//   is make the WALL DURATION of a frame machine-dependent — which matters
//   because of the watchdog, below.
//
// WHAT IS COMPARED (strongest signal first)
//   1. A hash of `retro_serialize()` output — the actual bytes lockstep must
//      keep identical — taken every N frames via `_emscripten_save_state`
//      (EmscriptenWorker.cpp:1579). Hashed as an ARRAY OF PER-CHUNK FNV-1a
//      values, not one scalar, so a mismatch NAMES THE BYTE RANGE that drifted
//      instead of just saying "different".
//   2. `_flycast_guest_cycles()` — an independent scalar. Two instances that
//      agree on the state hash but not the cycle count (or vice versa) is a
//      contradiction that means the rig is dirty, not that a mystery exists.
//   A framebuffer hash is deliberately NOT the primary signal: a divergence
//   invisible on screen still desyncs gameplay, so pixels can only ever produce
//   a FALSE PASS here.
//
// THE CONTROL ARMS — a cross-instance mismatch is uninterpretable without them
//   self   : ONE instance replays the SAME state with the SAME inputs twice.
//            If this fails, the core is not even self-deterministic and no
//            cross-instance number means anything.
//   cross  : two independent instances, same state, same inputs.
//   Each arm runs `--runs` times, because one agreeing run proves nothing
//   (CLAUDE.md gate #10).
//
// KNOWN WALL-CLOCK -> GUEST-STATE LEAK, FOUND BY READING BEFORE MEASURING
//   `dreamcast/flycast-bridge/rec_wasm.cpp:2416-2439` — every 262144 dispatches
//   the SH4 mainloop reads `emscripten_get_now()` and, if THIS run_iter has run
//   longer than 2000 ms of WALL time, sets `ctx->CpuRunning = false`, truncating
//   the guest frame at a wall-dependent point. Its own comment says so:
//   "Lever-4 D2: the watchdog converts host wall-clock into guest trajectory
//   (frames truncated at wall-dependent points — the parity drift's primary
//   source per the static audit)". It is explicitly suppressed while the core's
//   in-process parity gate hashes (`&& !g_parity_hashing`), i.e. the shipped
//   path has it LIVE. The rig reports how many times it fired (the worker logs
//   `[watchdog #N]`) so a divergence can be attributed to it rather than guessed
//   at.
//
// CONFIGURATION USED, AND ITS LIMIT
//   TWO TABS IN ONE BROWSER by default — the cheapest configuration that can
//   answer the question, and it shares the HTTP cache so the 1.1 GB disc is
//   fetched once. `--twobrowsers` runs two separate Chrome processes (separate
//   V8 isolates, separate wasm tiering state, separate renderer). Two tabs is a
//   WEAKER test than two physical devices in one respect: same OS, same CPU,
//   same Chrome build. A PASS here is therefore necessary-but-not-sufficient for
//   "two devices"; a FAIL here is conclusive for both.
//
// NO SHIPPED FILE IS MODIFIED. The stepwise driver is injected into the live
// worker through puppeteer's worker target (`page.workers()`), so
// `flycast_worker.js`, `dreamcast.html` and `lib/netplay.js` are untouched.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime    # gate, CLAUDE.md
//   npm run web                                        # port 8080, gate #2
//   node dreamcast/tools/determinism_probe.mjs --makestate --name mk   # once
//   node dreamcast/tools/determinism_probe.mjs --state /tmp/dc-det/gauntlet.state \
//        --frames 1800 --every 60 --runs 3 --name cross
//
// FLAGS
//   --game KEY       romSelect key (default gauntlet)
//   --name TAG       output suffix (default det)
//   --url BASE       default http://localhost:8080
//   --profile DIR    persistent Chrome profile (keeps the disc in HTTP cache)
//   --makestate      boot, drive to two-player gameplay, save a state, exit
//   --state PATH     savestate to load into BOTH instances (required unless
//                    --makestate). Written/read as raw retro_serialize bytes.
//   --frames N       frames per run (default 1800)
//   --every K        hash the serialized state every K frames (default 60)
//   --runs R         repeat the whole comparison R times (default 3)
//   --arms LIST      comma list of self,cross (default self,cross)
//   --input MODE     none | scripted   (default scripted)
//   --warmup N       DISCARDED passes before each measured pass (default 1).
//                    NOT optional book-keeping — the core's OWN parity gate
//                    burns a warmup arm for this reason, in its own words:
//                    "arm 0: warmup (discarded — fully compiles the window's
//                    blocks so every later arm sees the identical block table;
//                    a first-run compile can interp-route a queued block for one
//                    iter -> different slices)" (EmscriptenWorker.cpp:1637-1641).
//                    A JIT block cache is NOT part of the savestate, so two
//                    instances restoring identical bytes still differ in JIT
//                    warmth. `--warmup 0` measures exactly that case, which is
//                    the case REAL lockstep peers are in.
//   --chunk BYTES    state hash chunk size (default 65536)
//   --twobrowsers    two Chrome processes instead of two tabs
//   --headful        visible windows
//   --keep           leave browsers open
// OUTPUT
//   /tmp/dc-det/<name>.log   /tmp/dc-det/<name>.json
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// HASH-GUARD, BEFORE AND AFTER (CLAUDE.md gate #10). Agents share this tree; a
// concurrent relink mid-run produces a torn .js/.wasm pair whose failure reads
// like an emulator bug — and here it would read like NONDETERMINISM, which is
// exactly the claim under test. Both hashes are printed.
const WASM = path.join(REPO, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const wasmHash = () => {
  try {
    const b = fs.readFileSync(WASM);
    return crypto.createHash('sha256').update(b).digest('hex').slice(0, 16) + ' (' + b.length + ' B)';
  } catch (e) { return 'unreadable: ' + e.message; }
};

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const GAME      = arg('--game', 'gauntlet');
const NAME      = arg('--name', 'det');
const URLBASE   = arg('--url', 'http://localhost:8080');
const PROFILE   = arg('--profile', '/private/tmp/claude-501/dc-det-profile');
const MAKESTATE = has('--makestate');
const STATEPATH = arg('--state', '/tmp/dc-det/' + GAME + '.state');
const FRAMES    = parseInt(arg('--frames', '1800'), 10);
const EVERY     = parseInt(arg('--every', '60'), 10);
const RUNS      = parseInt(arg('--runs', '3'), 10);
const ARMS      = arg('--arms', 'self,cross').split(',').map((s) => s.trim()).filter(Boolean);
const INPUT     = arg('--input', 'scripted');
const CHUNK     = parseInt(arg('--chunk', '65536'), 10);
const WARMUP    = parseInt(arg('--warmup', '1'), 10);
const TWOBROW   = has('--twobrowsers');
const HEADFUL   = has('--headful');
const KEEP      = has('--keep');
const BOOT_MS   = parseInt(arg('--bootms', '600000'), 10);
// Extra query string for dreamcast.html, e.g. --query "noshard=1&noidleskip=1".
// This is how the suspects get BISECTED rather than guessed at.
const QUERY     = arg('--query', '');
// --diffat N: run BOTH instances exactly N frames from the state, pull both
// serialized states back to Node and diff them BYTE BY BYTE. This is what turns
// "chunk 0xa70000 differs" into "these bytes, this region, this device".
const DIFFAT    = parseInt(arg('--diffat', '0'), 10);
const NPORTS    = parseInt(arg('--ports', '2'), 10);
// --freezetime: pin Date.now inside BOTH workers to this fixed epoch-ms for the
// measured window, so every instance sees the same host instant. 0 = off.
const FREEZE    = parseInt(arg('--freezetime', '0'), 10);
// --coldboot: NO savestate. Both instances are anchored with retro_reset and then
// driven frame-gated from frame 0 through the boot sequence. This is the scenario
// the product is actually in -- lockstep peers start at frame 0 with no state file
// -- and it is the one a savestate rig is structurally blind to.
const COLDBOOT  = has('--coldboot');
// --frame0: THE SHIPPING CONFIGURATION. No savestate and no reset: the driver is
// installed as early as the worker exposes its exports, the shipped pump is held
// OFF before it ever runs a frame, and both instances are then driven frame-gated
// from frame 0 through the same boot. Alignment is not assumed -- the anchor gate
// reports guest cycles as well as the state hash, so "the two boots differ" can be
// told apart from "the rig started them at different instants".
const FRAME0    = has('--frame0');
// --equalize: THE DISCRIMINATING EXPERIMENT. In a frame-0/cold arm the two
// machines are not identical at the anchor (a host-clock byte survives). This
// pulls instance A's anchor state and pushes it into BOTH for every run, so the
// start is byte-identical BY CONSTRUCTION. Any divergence that remains therefore
// cannot be the anchor residual propagating -- it is an independent second cause.
const EQUALIZE  = has('--equalize');
// --lockstepreset: call _flycast_lockstep_reset() (the JIT flush + seal-phase
// anchor) in BOTH instances and push NO state. emscripten_load_state does two
// things -- retro_unserialize (emu.stop/loadstate/emu.start) AND this flush -- so
// --equalize cannot say which one produces its collapse. This isolates the flush.
const LSRESET   = has('--lockstepreset');
// --skew N: give instance B N EXTRA discarded frames of history before its
// measured pass. THIS IS THE REALISTIC LOCKSTEP TEST. Two real peers never have
// identical execution history — one sat in the menu longer, one joined late — and
// the JIT block cache, the shard-seal phase (rec_wasm.cpp:2125 seals on the
// unserialized host counter `s_dispatch_count`) and the idle-skip streak
// (rec_wasm.cpp:1611) are NOT part of a savestate. `--skew 0` asks the easy
// question (identical histories); `--skew N` asks the one that decides the
// product.
const SKEW      = parseInt(arg('--skew', '0'), 10);
// --ports N: how many Maple ports the scripted input drives (default 2).
// ⚠ THIS BUILD ONLY PLUGS TWO. `EmscriptenWorker.cpp:1262,1274` call
// retro_set_controller_port_device for ports 0 and 1 ONLY; ports 2 and 3 stay
// MDT_None, and flycast POLLS ONLY A PORT THAT HAS A MAPLE DEVICE ON IT (the
// comment at :1266-1272 says so). The measured Maple bus agrees:
// `p0[1,...] p1[1,...] p2[-1,...] p3[-1,...]`. So --ports 4 writes bytes that
// nothing currently reads; it is here so the rig is ready the moment ports 2-3
// are plugged, and so a 2-vs-4 port comparison is one flag away.

const OUT = '/tmp/dc-det';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const out = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); out.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ POLL FROM NODE, never page.waitForFunction — that polls on rAF and this page
// spends real time with rAF starved by the emulator worker.
async function until(page, fn, ms, everyMs = 500, onTick = null) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) await onTick(Date.now() - t0);
    await sleep(everyMs);
  }
}

const report = {
  wasmBefore: wasmHash(), wasmAfter: null,
  game: GAME, frames: FRAMES, every: EVERY, runs: RUNS, arms: ARMS, input: INPUT,
  chunk: CHUNK, twoBrowsers: TWOBROW, statePath: STATEPATH,
  load: null, results: [], verdict: null,
};

// ---------------------------------------------------------------------------
// THE SCRIPTED INPUT. A PURE FUNCTION OF THE EMULATED FRAME INDEX — this is the
// whole point: two instances at frame f apply byte-identical pad state, with no
// reference to wall time, whatever speed either is running at.
//
// Pad layout is EmscriptenWorker.cpp:1030-1041 (input_state_cb's own comment):
//   bytes 0..7 digital button bitmap (libretro RETRO_DEVICE_ID_JOYPAD ids)
//   bytes 8..9 s16 LE left-stick X, 10..11 left-stick Y
// Port p lives at byte p*64. RETRO id 0 = B (the Dreamcast A / confirm), 3 =
// START. Gauntlet gameplay movement is the ANALOG STICK (the same fact that left
// PSO unable to walk on an all-digital pad, EmscriptenWorker.cpp:1022-1024).
//
// Held in 12-frame phases so the guest sees sustained input rather than 1-frame
// glitches, and START is NEVER pressed — a pause menu would make the arms
// compare a paused game, which is a weaker test, not a stronger one.
// ---------------------------------------------------------------------------
function padScriptSource() {
  return `(function(){
    const PHASE = 12;
    const NPORTS = ${NPORTS};
    const DIRS = [[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
    return function padFor(f, mode) {
      const b = new Uint8Array(256);
      if (mode === 'none') return b;
      const ph = (f / PHASE) | 0;
      for (let p = 0; p < NPORTS; p++) {
        const base = p * 64;
        // Two ports walk DIFFERENT patterns (offset in the ring) so port 1 is
        // not a copy of port 0 — a two-player desync must be reachable.
        const d = DIRS[(ph + p * 3) % DIRS.length];
        const lx = (d[0] * 32767) | 0, ly = (d[1] * 32767) | 0;
        b[base + 8]  = lx & 0xff;        b[base + 9]  = (lx >> 8) & 0xff;
        b[base + 10] = ly & 0xff;        b[base + 11] = (ly >> 8) & 0xff;
        // B (RETRO id 0) pulsed on a different beat per port: attack input.
        if (((ph + p) % 4) === 0) b[base + 0] |= 1 << 0;
      }
      return b;
    };
  })()`;
}

// ---------------------------------------------------------------------------
// THE WORKER-SIDE DRIVER. Injected into the LIVE emulator worker through
// puppeteer's worker target — nothing shipped is edited.
//
// Asyncify is the whole difficulty. `_emscripten_run_iter` CAN SUSPEND: the
// export returns immediately with the C-side in-flight flag still set, and
// re-entering while suspended corrupts the asyncify state machine
// (flycast_worker.js:483-495 documents exactly this). So the driver reads the
// flag through HEAPU8 (a heap read is safe while suspended; a wasm call is not)
// and RETURNS TO THE EVENT LOOP until the rewind completes.
// ---------------------------------------------------------------------------
function installDriverSource() {
  return `(function(){
    const M = self.Module;
    if (!M) return { ok:false, err:'no Module' };
    for (const f of ['_emscripten_run_iter','_emscripten_get_maple_ptr',
                     '_emscripten_save_state','_emscripten_load_state',
                     '_flycast_run_iter_flag_ptr','_flycast_guest_cycles',
                     '_malloc','_free']) {
      if (typeof M[f] !== 'function') return { ok:false, err:'missing export ' + f };
    }
    const flagPtr = M._flycast_run_iter_flag_ptr() >>> 0;
    if (!flagPtr) return { ok:false, err:'run_iter flag ptr is 0' };

    self.__det = {
      active: false,
      holdPump: false,
      watchdogFires: 0,
      suspended: () => M.HEAPU8[flagPtr] !== 0,
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    };
    const D = self.__det;
    D.waitClean = async function(limitMs) {
      const t0 = Date.now();
      while (D.suspended()) {
        await D.sleep(1);
        if (Date.now() - t0 > (limitMs || 30000)) return false;
      }
      return true;
    };

    // Count [watchdog #N] lines. rec_wasm.cpp:2416-2439 is a WALL-CLOCK ->
    // GUEST-TRAJECTORY leak; if it fires, a divergence is explained rather than
    // mysterious. postMessage is wrapped rather than the console so this sees
    // exactly what the page sees.
    if (!D.pmWrapped) {
      const origPM = self.postMessage.bind(self);
      self.postMessage = function(msg, xfer) {
        try {
          if (msg && msg.cmd === 'print' && typeof msg.txt === 'string' &&
              msg.txt.indexOf('[watchdog') === 0) D.watchdogFires++;
        } catch (_) {}
        return xfer ? origPM(msg, xfer) : origPM(msg);
      };
      D.pmWrapped = true;
    }

    // Drop the PAGE's pad/frame traffic while a measured window is running.
    // dreamcast.html's rAF loop keeps posting {cmd:'input'} at ~60 Hz; if that
    // landed between our per-frame pad write and run_iter, the two instances
    // would see DIFFERENT input and the rig would manufacture the very
    // divergence it claims to measure.
    if (!D.msgWrapped) {
      const prev = self.onmessage;
      D.prevOnMessage = prev;
      self.onmessage = function(e) {
        const d = (e && e.data) || {};
        if (D.active && (d.cmd === 'input' || d.cmd === 'runFrame' ||
                         d.cmd === 'saveState' || d.cmd === 'loadState' ||
                         d.cmd === 'reset' || d.cmd === 'freerun')) return;
        // --frame0: the page sends a freerun-on command once the disc is ready.
        // If that lands, the shipped wall-paced pump runs frames we did not drive
        // and the two instances are no longer at a common frame 0.
        if (D.holdPump && (d.cmd === 'freerun' || d.cmd === 'runFrame')) return;
        return prev.call(self, e);
      };
      D.msgWrapped = true;
    }
    // Stop the shipped wall-paced pump. Routed through the ORIGINAL handler so
    // the shim's own setFreerun bookkeeping (stats timer, pace rebase) runs.
    // COLD-BOOT ANCHOR. The savestate arms answer "two peers handed the same
    // bytes"; they CANNOT see anything about the boot phase, because a savestate
    // lands past it. That blindness hid a real regression once already. retro_reset
    // puts the machine back to a deterministic power-on state without any state
    // file, so two instances reset independently should be byte-identical BEFORE a
    // single frame runs -- and that equality is checked, not assumed.
    D.reset = function() {
      try { D.prevOnMessage.call(self, { data: { cmd: 'reset' } }); } catch (_) {}
    };
    D.stopPump = function() {
      try { D.prevOnMessage.call(self, { data: { cmd:'freerun', on:false } }); } catch (_) {}
    };
    D.startPump = function() {
      try { D.prevOnMessage.call(self, { data: { cmd:'freerun', on:true } }); } catch (_) {}
    };

    // ---- state capture / restore -------------------------------------------
    D.saveBytes = async function() {
      if (!(await D.waitClean())) return null;
      const pp = M._malloc(4), ps = M._malloc(4);
      let bytes = null;
      try {
        if (M._emscripten_save_state(pp, ps)) {
          const bufPtr = M.HEAPU32[pp >>> 2], size = M.HEAPU32[ps >>> 2];
          bytes = new Uint8Array(M.HEAPU8.subarray(bufPtr, bufPtr + size));  // copy
          M._free(bufPtr);
        }
      } finally { M._free(pp); M._free(ps); }
      return bytes;
    };
    D.loadBytes = async function(u8) {
      if (!(await D.waitClean())) return false;
      const p = M._malloc(u8.length);
      if (!p) return false;
      try { M.HEAPU8.set(u8, p); return M._emscripten_load_state(p, u8.length) ? true : false; }
      finally { M._free(p); }
    };

    // ---- the hash ------------------------------------------------------------
    // Per-CHUNK FNV-1a, not one scalar: a mismatch must NAME THE BYTE RANGE.
    D.hashState = async function(chunkBytes) {
      const u8 = await D.saveBytes();
      if (!u8) return null;
      const size = u8.length;
      const n = Math.ceil(size / chunkBytes);
      const chunks = new Array(n);
      let total = 2166136261;
      for (let c = 0; c < n; c++) {
        let h = 2166136261;
        const e = Math.min(size, (c + 1) * chunkBytes);
        for (let i = c * chunkBytes; i < e; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); }
        chunks[c] = h >>> 0;
        total ^= chunks[c]; total = Math.imul(total, 16777619);
      }
      return { size, total: total >>> 0, chunks };
    };

    // ---- the frame-gated run -------------------------------------------------
    // ONE _emscripten_run_iter per emulated frame, pad written immediately
    // before it. No wall clock anywhere in the loop's decisions.
    D.run = async function(opts) {
      const padFor = self.__detPadFor;
      // --freezetime: pin the HOST wall clock for the duration of the measured
      // window. emscripten implements the C time() / gettimeofday() family on top
      // of Date.now(), and flycast hands host date/time straight to the guest in
      // at least one place a savestate cannot fix -- the VMU Maple clock device
      // writes host year/month/day/hour/min/sec into the DMA output buffer on
      // every poll (core/hw/maple/maple_devs.cpp:664-696, time(&now) at :673 and
      // localtime at :674). Two instances measured minutes apart therefore see
      // different bytes there. Pinning Date.now makes both see the SAME instant,
      // so if divergence disappears under this arm, host wall-clock reaching the
      // guest is the dominant cause and the fix is a pinned clock, not a mystery.
      let restoreNow = null;
      if (opts.freezeTime) {
        const fixed = opts.freezeTime;
        const orig = Date.now;
        Date.now = function () { return fixed; };
        restoreNow = () => { Date.now = orig; };
      }
      const padPtr = M._emscripten_get_maple_ptr() >>> 0;
      if (!padPtr) return { ok:false, err:'maple ptr is 0' };
      D.active = true;
      const samples = [];
      const wd0 = D.watchdogFires;
      let threw = null, done = 0;
      const tStart = Date.now();
      try {
        for (let f = 0; f < opts.frames; f++) {
          if (!(await D.waitClean())) { threw = 'stuck suspended at frame ' + f; break; }
          M.HEAPU8.set(padFor(f, opts.input), padPtr);
          try {
            M._emscripten_run_iter();
          } catch (err) {
            // An asyncify suspend can escape as a throw of the string 'unwind';
            // that is NOT a failure — wait for the rewind and carry on.
            const isUnwind = err && (err === 'unwind' || err.message === 'unwind');
            if (!isUnwind) { threw = 'run_iter threw at frame ' + f + ': ' + (err && err.message ? err.message : String(err)); break; }
            if (!(await D.waitClean())) { threw = 'unwind never rewound at frame ' + f; break; }
          }
          done = f + 1;
          if (((f + 1) % opts.every) === 0) {
            const h = await D.hashState(opts.chunk);
            if (!h) { threw = 'save_state failed at frame ' + (f + 1); break; }
            samples.push({ frame: f + 1, cycles: M._flycast_guest_cycles(),
                           size: h.size, total: h.total, chunks: h.chunks });
          }
          // Yield so asyncify rewinds and the worker's own timers can run.
          if ((f & 31) === 31) await D.sleep(0);
        }
      } finally { D.active = false; if (restoreNow) restoreNow(); }
      return { ok: !threw, err: threw, framesRun: done, samples,
               wallMs: Date.now() - tStart,
               watchdogFires: D.watchdogFires - wd0 };
    };
    return { ok:true };
  })()`;
}

// ---------------------------------------------------------------------------
// Boot one page to a running emulator.
// ---------------------------------------------------------------------------
async function bootPage(browser, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on('pageerror', (e) => say(`  [${tag} page!] ` + ((e && (e.message || e.type)) || String(e))));
  page.on('console', (m) => {
    const t = m.text();
    if (/\[watchdog|state load|FATAL|threw/.test(t)) say(`  [${tag} console] ` + t);
  });
  await page.goto(URLBASE + '/dreamcast.html' + (QUERY ? '?' + QUERY : ''), { waitUntil: 'domcontentloaded', timeout: 120000 });
  // dreamcast.html registers /coi-serviceworker.js and RELOADS ITSELF. Anything
  // injected before that reload is thrown away, and an evaluate during it throws
  // "Execution context destroyed", which reads exactly like a page crash.
  const isolated = await until(page, () => (self.crossOriginIsolated === true) && typeof window.__dcProbe === 'function', 90000);
  if (!isolated) throw new Error(tag + ': page never became cross-origin isolated');

  // Synthetic port-1 pad + dismiss the controller card. Copied from
  // dreamcast/tools/gauntlet_p2_probe.mjs, where this exact code is what proved
  // the game reacts to port 1. Only needed for --makestate (the measured windows
  // write the pad bytes directly), but installed always so both arms are the
  // same page configuration.
  await page.evaluate(() => {
    const st = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0], on: true };
    window.__p2 = st;
    const orig = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => [];
    const mk = () => ({
      index: 1, id: 'Bemental Det Pad (STANDARD GAMEPAD)', connected: true,
      mapping: 'standard', timestamp: performance.now(),
      buttons: st.buttons.map((v) => ({ pressed: v > 0, touched: v > 0, value: v })),
      axes: st.axes.slice(),
    });
    navigator.getGamepads = function () {
      let real = [];
      try { real = orig() || []; } catch (e) {}
      return [real[0] || null, st.on ? mk() : null, real[2] || null, real[3] || null];
    };
    setInterval(() => {
      const el = document.getElementById('xboxInputPrompt');
      if (el && el.style.display !== 'none') {
        const no = document.getElementById('xboxInputPromptNo');
        if (no) no.click(); else el.style.display = 'none';
      }
    }, 250);
  });

  await page.evaluate((g) => {
    const s = document.getElementById('romSelect');
    s.value = g; s.dispatchEvent(new Event('change'));
    document.getElementById('btnStart').click();
  }, GAME);

  if (FRAME0) {
    let w = null;
    for (let i = 0; i < 900 && !w; i++) {
      w = page.workers().find((x) => /flycast_worker/.test(x.url()));
      if (!w) await sleep(100);
    }
    if (!w) throw new Error(tag + ': flycast worker never appeared');
    let inst = null;
    for (let i = 0; i < 2400; i++) {
      try { inst = await w.evaluate(installDriverSource()); } catch (e) { inst = null; }
      if (inst && inst.ok) break;
      await sleep(50);
    }
    if (!inst || !inst.ok) throw new Error(tag + ': early driver install failed: ' + (inst && inst.err));
    await w.evaluate('self.__det.holdPump = true; self.__det.stopPump(); true');
    await w.evaluate(`self.__detPadFor = ${padScriptSource()}; true`);
    // save_state returns 0 until g_loaded, so a non-zero size IS "the disc is in".
    let size = 0;
    for (let i = 0; i < 2400 && !size; i++) {
      try { size = await w.evaluate('(async()=>{ const b = await self.__det.saveBytes(); return b ? b.length : 0; })()'); }
      catch (e) { size = 0; }
      if (!size) await sleep(250);
    }
    if (!size) throw new Error(tag + ': disc never loaded (save_state stayed 0)');
    const cyc = await w.evaluate('self.Module._flycast_guest_cycles()');
    say(`${tag} FRAME0: pump HELD OFF before any driven frame; state=${size} B guest_cycles=${cyc}`);
    return { tag, page, worker: w };
  }

  let lastPhase = '';
  const booted = await until(page, () => (window.__dcProbe && window.__dcProbe().booted) || false, BOOT_MS, 1000, async () => {
    const p = await page.evaluate(() => { const d = window.__dcProbe(); return d.phase + ' ' + Math.round(100 * d.discBytes / (d.discTotal || 1)) + '%'; }).catch(() => '');
    if (p && p !== lastPhase) { lastPhase = p; say(`  ${tag} booting ` + p); }
  });
  if (!booted) throw new Error(tag + ': never booted');
  const flowing = await until(page, () => { const d = window.__dcProbe(); return d.framesEver && d.distinctEver; }, 180000);
  const pr = await page.evaluate(() => window.__dcProbe());
  say(`${tag} booted phase=${pr.phase} coi=${pr.coi} fps=${pr.fps} distinctFrames=${!!flowing}`);
  if (!flowing) throw new Error(tag + ': booted but no distinct frames — a still picture is not a running emulator');

  // The emulator worker. page.workers() exposes the dedicated worker target, so
  // the driver goes straight into the context that owns Module.
  let worker = null;
  for (let i = 0; i < 60 && !worker; i++) {
    worker = page.workers().find((w) => /flycast_worker/.test(w.url()));
    if (!worker) await sleep(500);
  }
  if (!worker) throw new Error(tag + ': could not find the flycast worker target');
  say(`${tag} worker: ${worker.url()}`);

  const inst = await worker.evaluate(installDriverSource());
  if (!inst || !inst.ok) throw new Error(tag + ': driver install failed: ' + (inst && inst.err));
  await worker.evaluate(`self.__detPadFor = ${padScriptSource()}; true`);
  await worker.evaluate('self.__det.stopPump(); true');
  say(`${tag} driver installed, shipped wall-paced pump STOPPED`);
  return { tag, page, worker };
}

// ---------------------------------------------------------------------------
// Move the savestate bytes across the CDP boundary. Base64 in slices — one
// 25 MB string in a single evaluate is a reliable way to stall the connection.
// ---------------------------------------------------------------------------
const B64_SLICE = 4 << 20;
async function pullState(inst) {
  await inst.worker.evaluate('(async()=>{ self.__detBuf = await self.__det.saveBytes(); return !!self.__detBuf; })()');
  const size = await inst.worker.evaluate('self.__detBuf ? self.__detBuf.length : 0');
  if (!size) return null;
  const parts = [];
  for (let off = 0; off < size; off += B64_SLICE) {
    const b64 = await inst.worker.evaluate(`(function(){
      const u8 = self.__detBuf.subarray(${off}, ${Math.min(size, off + B64_SLICE)});
      let s = ''; const C = 0x8000;
      for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
      return btoa(s);
    })()`);
    parts.push(Buffer.from(b64, 'base64'));
  }
  await inst.worker.evaluate('self.__detBuf = null; true');
  return Buffer.concat(parts);
}
async function pushState(inst, buf) {
  await inst.worker.evaluate(`self.__detIn = new Uint8Array(${buf.length}); self.__detOff = 0; true`);
  for (let off = 0; off < buf.length; off += B64_SLICE) {
    const b64 = buf.subarray(off, Math.min(buf.length, off + B64_SLICE)).toString('base64');
    await inst.worker.evaluate(`(function(){
      const bin = atob(${JSON.stringify(b64)});
      const u8 = self.__detIn;
      for (let i = 0; i < bin.length; i++) u8[self.__detOff + i] = bin.charCodeAt(i);
      self.__detOff += bin.length;
      return self.__detOff;
    })()`);
  }
  const ok = await inst.worker.evaluate('(async()=>{ const r = await self.__det.loadBytes(self.__detIn); self.__detIn = null; return r; })()');
  return !!ok;
}

// ---------------------------------------------------------------------------
// Compare two sample arrays. Reports the FIRST diverging frame and WHICH chunks.
// ---------------------------------------------------------------------------
function compare(a, b) {
  const n = Math.min(a.length, b.length);
  const cmp = { samples: n, matched: 0, firstDivergeFrame: null, firstDivergeChunks: null,
                firstCycleDivergeFrame: null, cycleDeltaAtFirst: null, perSample: [] };
  for (let i = 0; i < n; i++) {
    const A = a[i], B = b[i];
    const same = A.total === B.total && A.size === B.size;
    const cycSame = A.cycles === B.cycles;
    if (same) cmp.matched++;
    if (!same && cmp.firstDivergeFrame === null) {
      cmp.firstDivergeFrame = A.frame;
      const bad = [];
      const m = Math.min(A.chunks.length, B.chunks.length);
      for (let c = 0; c < m; c++) if (A.chunks[c] !== B.chunks[c]) bad.push(c);
      cmp.firstDivergeChunks = {
        differing: bad.length, ofChunks: m, chunkBytes: CHUNK,
        sizesEqual: A.size === B.size, sizeA: A.size, sizeB: B.size,
        firstOffsets: bad.slice(0, 24).map((c) => '0x' + (c * CHUNK).toString(16)),
      };
    }
    if (!cycSame && cmp.firstCycleDivergeFrame === null) {
      cmp.firstCycleDivergeFrame = A.frame;
      cmp.cycleDeltaAtFirst = B.cycles - A.cycles;
    }
    cmp.perSample.push({ frame: A.frame, same, cycSame, cycA: A.cycles, cycB: B.cycles });
  }
  cmp.identical = cmp.matched === n && n > 0 && cmp.firstCycleDivergeFrame === null;
  return cmp;
}

// ---------------------------------------------------------------------------
let browsers = [];
async function finish(code) {
  report.wasmAfter = wasmHash();
  say(`wasm AFTER: ${report.wasmAfter}`);
  if (report.wasmBefore !== report.wasmAfter) say('⚠ WASM CHANGED MID-RUN — a concurrent relink. DISCARD THIS RUN.');
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(report, null, 2));
  say('json -> ' + path.join(OUT, NAME + '.json'));
  if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (_) {} }
  out.end();
  await sleep(150);
  process.exit(code);
}

const LAUNCH = {
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--disk-cache-size=2000000000',
  ],
};

try {
  say(`wasm BEFORE: ${report.wasmBefore}`);
  const uptime = (await import('child_process')).execSync('uptime').toString().trim();
  report.load = uptime;
  say('load: ' + uptime);
  say(`config: ${TWOBROW ? 'TWO BROWSER PROCESSES' : 'TWO TABS IN ONE BROWSER'} | game=${GAME} frames=${FRAMES} every=${EVERY} runs=${RUNS} arms=${ARMS} input=${INPUT} warmup=${WARMUP} skew=${SKEW} ports=${NPORTS} freezetime=${FREEZE}`);
  report.warmup = WARMUP; report.query = QUERY; report.diffatFrames = DIFFAT; report.skew = SKEW; report.ports = NPORTS; report.freezeTime = FREEZE; report.coldbootArm = COLDBOOT; report.frame0 = FRAME0; report.equalize = EQUALIZE; report.lockstepresetArm = LSRESET;
  if (QUERY) say(`query: ?${QUERY}`);

  const b1 = await puppeteer.launch({ ...LAUNCH, userDataDir: PROFILE });
  browsers.push(b1);
  try { require('../../tools/browser_leak_guard.js').guard(b1, 'determinism'); } catch (_e) {}

  // ---- --makestate: boot, drive to two-player gameplay, save, exit ---------
  if (MAKESTATE) {
    const A = await bootPage(b1, 'A');
    // The shipped pump is stopped by bootPage; the drive-to-gameplay script is
    // wall-timed menu taps, so put the normal pump BACK for that phase.
    await A.worker.evaluate('self.__det.startPump(); true');
    say('driving to two-player gameplay with the p2proof PREFIX script ' +
        '(dreamcast/docs/gauntlet-two-players/TASKS.md — the exact sequence that reached ' +
        'the character screen on three consecutive runs on this box)');
    const key = (k) => A.page.evaluate((k) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true })), 60);
    }, k);
    const p2 = (btn) => A.page.evaluate((b) => {
      window.__p2.buttons[b] = 1; setTimeout(() => { window.__p2.buttons[b] = 0; }, 120);
    }, btn);
    const steps = [
      [5000, null], [10000, null], [10000, null], [10000, null],
      [2000, () => key('Enter')], [3000, null],
      [2000, () => key('Enter')], [3000, null],
      [2000, () => key('m')], [3000, null],
      [0, () => p2(9)], [1500, null],
      [0, () => p2(9)], [2500, null],
      [1500, () => key('m')], [1300, null],
      [0, () => p2(0)], [1300, null],
      [0, () => key('m')], [1300, null],
      [0, () => p2(0)], [1300, null],
      [0, () => key('m')], [1300, null],
      [0, () => p2(0)], [1300, null],
      [0, () => key('m')], [1300, null],
      [0, () => p2(0)], [1300, null],
      [2000, null], [3000, null], [5000, null], [5000, null],
    ];
    for (const [d, fn] of steps) { if (d) await sleep(d); if (fn) await fn(); }
    await A.page.screenshot({ path: path.join(OUT, NAME + '-makestate.png') });
    say('screenshot -> ' + path.join(OUT, NAME + '-makestate.png'));
    await A.worker.evaluate('self.__det.stopPump(); true');
    await sleep(500);
    const buf = await pullState(A);
    if (!buf) { say('ABORT: save_state returned nothing'); await finish(3); }
    fs.mkdirSync(path.dirname(STATEPATH), { recursive: true });
    fs.writeFileSync(STATEPATH, buf);
    say(`SAVED ${buf.length} B -> ${STATEPATH}  sha256=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
    report.madeState = { path: STATEPATH, bytes: buf.length };
    await finish(0);
  }

  // ---- the measurement ----------------------------------------------------
  let stateBuf = null;
  if (FRAME0) {
    say('FRAME0 arm: no savestate, no reset — two instances driven from frame 0 through the SAME BOOT. ' +
        'This is the configuration the product actually ships.');
  } else if (COLDBOOT) {
    say('COLD BOOT arm: no savestate. Both instances are anchored with retro_reset and driven ' +
        'frame-gated from frame 0 through the BOOT SEQUENCE — the phase a savestate rig cannot see.');
    report.coldboot = true;
  } else {
    if (!fs.existsSync(STATEPATH)) {
      say(`ABORT: no savestate at ${STATEPATH}. Run with --makestate first.`);
      await finish(2);
    }
    stateBuf = fs.readFileSync(STATEPATH);
    const stateHash = crypto.createHash('sha256').update(stateBuf).digest('hex').slice(0, 16);
    say(`savestate ${stateBuf.length} B sha256=${stateHash} — THE SAME BYTES go into both instances`);
    report.stateBytes = stateBuf.length; report.stateSha = stateHash;
  }
  // One preparation seam for both arms, so nothing else in the rig changes shape.
  let equalBuf = null;
  const prepare = async (inst) => {
    if (LSRESET && !equalBuf) {
      // Mirror what a call site at the end of load_disc would give a fresh boot:
      // every measured pass begins with the flush, nothing else changed.
      await inst.worker.evaluate('(async()=>{ await self.__det.waitClean(); self.Module._flycast_lockstep_reset(); return true; })()');
      if (FRAME0) return true;
    }
    if (equalBuf) return pushState(inst, equalBuf);   // --equalize: identical by construction
    if (FRAME0) return true;   // already at a common frame 0; resetting would undo it
    if (!COLDBOOT) return pushState(inst, stateBuf);
    const ok = await inst.worker.evaluate('(async()=>{ self.__det.reset(); return await self.__det.waitClean(); })()');
    return !!ok;
  };

  let anchorDone = false;
  const anchorGate = async () => {
  // ANCHOR GATE (cold boot only). Two machines reset INDEPENDENTLY must be
  // byte-identical BEFORE a single frame runs. If they are not, lockstep from
  // frame 0 is impossible no matter what the per-frame numbers say, so this is
  // checked first and reported loudly rather than being assumed.
  if ((COLDBOOT || FRAME0) && !anchorDone) {
    anchorDone = true;
    if (!(await prepare(A)) || !(await prepare(B))) {
      say('ABORT: retro_reset anchor failed — cannot establish a common frame 0.');
      await finish(3);
    }
    const ha = await A.worker.evaluate(`self.__det.hashState(${CHUNK})`);
    const hb = await B.worker.evaluate(`self.__det.hashState(${CHUNK})`);
    if (!ha || !hb) { say('ABORT: could not serialize after reset'); await finish(3); }
    const same = ha.total === hb.total && ha.size === hb.size;
    let bad = [];
    for (let c = 0; c < Math.min(ha.chunks.length, hb.chunks.length); c++)
      if (ha.chunks[c] !== hb.chunks[c]) bad.push('0x' + (c * CHUNK).toString(16));
    const how = FRAME0 ? 'frame0, NO reset — pump held off before any frame'
                       : 'after retro_reset';
    say(`ANCHOR (${how}): sizes ${ha.size}/${hb.size} identical=${same}` +
        (same ? '' : ` — ${bad.length} differing chunks @ ${bad.slice(0, 12).join(',')}`));
    report.anchor = { identical: same, sizeA: ha.size, sizeB: hb.size,
                      differingChunks: bad.length, first: bad.slice(0, 24) };
    if (!same) say('⚠ TWO INDEPENDENTLY RESET MACHINES ARE ALREADY DIFFERENT. ' +
                   'Frame-0 lockstep cannot work without shipping a common state.');
    if (LSRESET) {
      const ra = await A.worker.evaluate('(async()=>{ await self.__det.waitClean(); self.Module._flycast_lockstep_reset(); return true; })()');
      const rb = await B.worker.evaluate('(async()=>{ await self.__det.waitClean(); self.Module._flycast_lockstep_reset(); return true; })()');
      say(`LOCKSTEP-RESET called at the anchor in BOTH instances (A=${ra} B=${rb}); NO state pushed. ` +
          'If 261 chunks collapse to ~2, the JIT flush is the ingredient; if it stays at 261, ' +
          'the ingredient is retro_unserialize\'s emu.stop()/emu.start() subsystem restart.');
      report.lockstepReset = { A: !!ra, B: !!rb };
    }
    if (EQUALIZE) {
      equalBuf = await pullState(A);
      if (!equalBuf) { say('ABORT: --equalize could not capture the anchor state'); await finish(3); }
      const okA = await pushState(A, equalBuf), okB = await pushState(B, equalBuf);
      const qa = await A.worker.evaluate(`self.__det.hashState(${CHUNK})`);
      const qb = await B.worker.evaluate(`self.__det.hashState(${CHUNK})`);
      const eq = qa && qb && qa.total === qb.total;
      say(`EQUALIZED at frame 0: pushed A's ${equalBuf.length} B anchor state into BOTH ` +
          `(loadA=${okA} loadB=${okB}) -> hashes identical=${eq}. ` +
          'Any divergence from here is an INDEPENDENT SECOND CAUSE, not the anchor residual.');
      report.equalized = { bytes: equalBuf.length, identical: !!eq };
      if (!eq) { say('ABORT: equalize did not produce identical states — cannot discriminate.'); await finish(3); }
    }
  }
  };


  const A = await bootPage(b1, 'A');
  let B;
  if (TWOBROW) {
    const b2 = await puppeteer.launch({ ...LAUNCH, userDataDir: PROFILE + '-b' });
    browsers.push(b2);
    try { require('../../tools/browser_leak_guard.js').guard(b2, 'determinism'); } catch (_e) {}
    B = await bootPage(b2, 'B');
  } else {
    B = await bootPage(b1, 'B');
  }

  // ---- --diffat N: localize a divergence to actual bytes ------------------
  // A chunk index says "something in this 64 KB moved". That is not an answer.
  // This runs both instances exactly N frames from the shared state, pulls both
  // serialized states back and diffs them byte by byte, so the finding can name
  // a REGION rather than an offset.
  if (DIFFAT > 0) {
    await anchorGate();
    const pass = async (inst) => {
      for (let w = 0; w < WARMUP; w++) {
        if (!(await prepare(inst))) throw new Error('warmup prepare FAILED');
        const rw = await inst.worker.evaluate(`self.__det.run(${JSON.stringify({ frames: DIFFAT, every: DIFFAT + 1, chunk: CHUNK, input: INPUT, freezeTime: FREEZE })})`);
        if (!rw.ok) throw new Error('warmup: ' + rw.err);
      }
      if (!(await prepare(inst))) throw new Error('prepare FAILED');
      const r = await inst.worker.evaluate(`self.__det.run(${JSON.stringify({ frames: DIFFAT, every: DIFFAT + 1, chunk: CHUNK, input: INPUT, freezeTime: FREEZE })})`);
      if (!r.ok) throw new Error(r.err);
      return { r, bytes: await pullState(inst) };
    };
    say(`--diffat ${DIFFAT}: running BOTH instances exactly ${DIFFAT} frames, then diffing the serialized states byte by byte`);
    const pa = await pass(A), pb = await pass(B);
    const a = pa.bytes, b = pb.bytes;
    say(`  A ${a.length} B ${b.length} bytes; cycles A=${pa.r.samples.length ? '' : ''}`);
    const diffs = [];
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n) {
      if (a[i] !== b[i]) {
        const start = i;
        let last = i;
        // Coalesce: bytes within 64 of each other belong to one run.
        while (i < n && i - last <= 64) { if (a[i] !== b[i]) last = i; i++; }
        diffs.push({ start, end: last, len: last - start + 1 });
        i = last + 1;
      } else i++;
    }
    const totalBytes = diffs.reduce((s, d) => s + d.len, 0);
    say(`  DIFFERING RUNS: ${diffs.length}, total differing-ish span ${totalBytes} B, sizes equal=${a.length === b.length}`);
    for (const d of diffs.slice(0, 40)) {
      const s = d.start, e = Math.min(d.end + 1, s + 32);
      say(`    @0x${s.toString(16)} len=${d.len}  A=${Buffer.from(a.subarray(s, e)).toString('hex')}  B=${Buffer.from(b.subarray(s, e)).toString('hex')}`);
    }
    if (diffs.length > 40) say(`    ... and ${diffs.length - 40} more runs`);
    fs.writeFileSync(path.join(OUT, NAME + '-A.state'), a);
    fs.writeFileSync(path.join(OUT, NAME + '-B.state'), b);
    say(`  wrote ${path.join(OUT, NAME + '-A.state')} and -B.state for offline inspection`);
    report.diffat = { frames: DIFFAT, runs: diffs.length, totalBytes,
                      sizesEqual: a.length === b.length, sizeA: a.length, sizeB: b.length,
                      first: diffs.slice(0, 200) };
    await finish(0);
  }

  // A measured pass = WARMUP discarded passes (same state, same inputs, hashing
  // off) then the measured one. See the --warmup note in the header: the JIT
  // block cache is not part of a savestate, so without this the rig measures
  // cold-vs-warm JIT and calls it nondeterminism.
  const runOne = async (inst, label, skewFrames) => {
    if (skewFrames > 0) {
      // Divergent HISTORY, not divergent state: run from the same bytes, then
      // throw the result away. What survives is exactly the host-side residue a
      // savestate does not carry.
      if (!(await prepare(inst))) return { ok: false, err: 'skew prepare FAILED' };
      const rs = await inst.worker.evaluate(`self.__det.run(${JSON.stringify({ frames: skewFrames, every: skewFrames + 1, chunk: CHUNK, input: INPUT, freezeTime: FREEZE })})`);
      if (!rs.ok) return { ok: false, err: 'skew pass: ' + rs.err };
    }
    for (let w = 0; w < WARMUP; w++) {
      if (!(await prepare(inst))) return { ok: false, err: 'warmup prepare FAILED' };
      const rw = await inst.worker.evaluate(`self.__det.run(${JSON.stringify({ frames: FRAMES, every: FRAMES + 1, chunk: CHUNK, input: INPUT, freezeTime: FREEZE })})`);
      if (!rw.ok) return { ok: false, err: 'warmup pass ' + w + ': ' + rw.err };
    }
    const ok = await prepare(inst);
    if (!ok) return { ok: false, err: 'prepare FAILED — a failed restore SILENTLY leaves the previous state running (CLAUDE.md gate #10)' };
    const r = await inst.worker.evaluate(`self.__det.run(${JSON.stringify({ frames: FRAMES, every: EVERY, chunk: CHUNK, input: INPUT, freezeTime: FREEZE })})`);
    r.label = label;
    return r;
  };

  await anchorGate();

  for (let run = 1; run <= RUNS; run++) {
    const entry = { run, arms: {} };
    say(`--- run ${run}/${RUNS} ---`);

    if (ARMS.includes('self')) {
      // CONTROL: one instance, same state, same inputs, twice. If this fails,
      // nothing cross-instance is interpretable.
      const r1 = await runOne(A, 'A#1', 0);
      const r2 = await runOne(A, 'A#2', 0);
      if (!r1.ok || !r2.ok) {
        say(`  self: RIG FAULT r1=${r1.err || 'ok'} r2=${r2.err || 'ok'}`);
        entry.arms.self = { rigFault: true, r1: r1.err, r2: r2.err,
                            framesRun: [r1.framesRun, r2.framesRun] };
      } else {
        const c = compare(r1.samples, r2.samples);
        say(`  self : frames=${r1.framesRun}/${r2.framesRun} samples=${c.samples} matched=${c.matched}` +
            ` identical=${c.identical} firstDiverge=${c.firstDivergeFrame} firstCycleDiverge=${c.firstCycleDivergeFrame}` +
            ` watchdog=${r1.watchdogFires}/${r2.watchdogFires} wall=${r1.wallMs}/${r2.wallMs}ms`);
        if (c.firstDivergeChunks) say(`         chunks differing at first divergence: ${c.firstDivergeChunks.differing}/${c.firstDivergeChunks.ofChunks} @ ${c.firstDivergeChunks.firstOffsets.join(',')}`);
        entry.arms.self = { cmp: c, watchdog: [r1.watchdogFires, r2.watchdogFires],
                            wallMs: [r1.wallMs, r2.wallMs], framesRun: [r1.framesRun, r2.framesRun] };
      }
    }

    if (ARMS.includes('cross')) {
      const ra = await runOne(A, 'A', 0);
      const rb = await runOne(B, 'B', SKEW);
      if (!ra.ok || !rb.ok) {
        say(`  cross: RIG FAULT a=${ra.err || 'ok'} b=${rb.err || 'ok'}`);
        entry.arms.cross = { rigFault: true, a: ra.err, b: rb.err,
                             framesRun: [ra.framesRun, rb.framesRun] };
      } else {
        const c = compare(ra.samples, rb.samples);
        say(`  cross: frames=${ra.framesRun}/${rb.framesRun} samples=${c.samples} matched=${c.matched}` +
            ` identical=${c.identical} firstDiverge=${c.firstDivergeFrame} firstCycleDiverge=${c.firstCycleDivergeFrame}` +
            ` watchdog=${ra.watchdogFires}/${rb.watchdogFires} wall=${ra.wallMs}/${rb.wallMs}ms`);
        if (c.firstDivergeChunks) say(`         chunks differing at first divergence: ${c.firstDivergeChunks.differing}/${c.firstDivergeChunks.ofChunks} @ ${c.firstDivergeChunks.firstOffsets.join(',')}`);
        entry.arms.cross = { cmp: c, watchdog: [ra.watchdogFires, rb.watchdogFires],
                             wallMs: [ra.wallMs, rb.wallMs], framesRun: [ra.framesRun, rb.framesRun] };
      }
    }
    report.results.push(entry);
  }

  // ---- verdict -------------------------------------------------------------
  const tally = (arm) => {
    const rows = report.results.map((r) => r.arms[arm]).filter(Boolean);
    const good = rows.filter((r) => !r.rigFault);
    return {
      runs: rows.length, rigFaults: rows.length - good.length,
      identical: good.filter((r) => r.cmp.identical).length,
      divergeFrames: good.filter((r) => !r.cmp.identical).map((r) => r.cmp.firstDivergeFrame),
      watchdogTotal: good.reduce((s, r) => s + (r.watchdog[0] || 0) + (r.watchdog[1] || 0), 0),
    };
  };
  report.verdict = {};
  for (const a of ARMS) {
    const t = tally(a);
    report.verdict[a] = t;
    say(`VERDICT ${a}: ${t.identical}/${t.runs - t.rigFaults} runs byte-identical over ${FRAMES} frames` +
        (t.rigFaults ? ` (+${t.rigFaults} rig faults)` : '') +
        `; first-divergence frames: ${JSON.stringify(t.divergeFrames)}; watchdog fires: ${t.watchdogTotal}`);
  }
  await finish(0);
} catch (err) {
  say('FATAL: ' + (err && err.stack ? err.stack : String(err)));
  report.fatal = String(err && err.message || err);
  await finish(1);
}
