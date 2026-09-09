// IS THE GENESIS CORE FRAME-DETERMINISTIC ENOUGH FOR LOCKSTEP NETPLAY?
//
// THE DECISION THIS EXISTS TO UNBLOCK
//   genesis.html is being wired for deterministic lockstep: every player runs
//   their own core, only pad bytes cross the wire, and the cores must stay
//   byte-identical forever. That requires a MEASUREMENT, not a hope. This is
//   the Genesis analogue of dreamcast/tools/determinism_probe.mjs — written
//   beside it rather than by modifying it, because the two cores share no code.
//
// THE QUESTION, PRECISELY
//   Given (a) the same genesis_plus_gx.wasm, (b) the same ROM loaded FROM
//   COLD — no savestate, no state transfer — and (c) an identical input
//   sequence applied at identical EMULATED FRAME NUMBERS, do two independent
//   instances produce identical emulator state, frame after frame, and for how
//   long?
//
//   ⚠ "FROM FRAME 0, NO SAVESTATE" IS THE HARDER QUESTION AND IT IS THE RIGHT
//   ONE. Dreamcast could only reach agreement through a serialize/unserialize
//   round trip at room start (its `lsNormalize` handshake). Lockstep on this
//   page seats players BEFORE anything boots, so both cores cold-boot the same
//   ROM and there is nothing to normalize. If cold boot does not agree here,
//   the page design has to change — which is why this runs before the page work
//   is believed.
//
// WHY THE SHIPPED LOOP CANNOT ANSWER IT
//   genesis.html drives the core from a wall-clock accumulator
//   (`genesis.html` `loop(ts)`: `while (accum >= FRAME_MS && ran < MAX_CATCHUP_FRAMES)`).
//   So "frame N" happens at a different wall instant in each instance, and any
//   input keyed to wall time lands on a DIFFERENT FRAME in each. Wall-clock-keyed
//   input cannot answer a determinism question.
//
//   THIS RIG NEVER STARTS THAT LOOP. It opens genesis.html, waits for the core
//   to initialise, and NEVER PRESSES START — so the page's `running` flag stays
//   false and its rAF loop returns immediately every tick. The ROM is loaded by
//   this rig through `Module._gpx_load` and every frame is driven by this rig
//   through `Module._gpx_run`, with `Module._gpx_set_pad(port, mask)` written
//   immediately before each one. Input is a pure function of the emulated frame
//   index and nothing else.
//
//   THAT NON-INTERFERENCE IS ASSERTED, NOT ASSUMED: `window.__genFrames` is
//   incremented only by the page's own `runFrame()`, so it must still read 0
//   when the run ends. A nonzero value means the page was also driving the core
//   and every number in the run is void. The rig reports it.
//
// WHAT IS COMPARED (strongest signal first)
//   1. A hash of `_gpx_state_save()` output — the actual bytes lockstep must
//      keep identical. Hashed as an ARRAY OF PER-CHUNK FNV-1a values, not one
//      scalar, so a mismatch NAMES THE BYTE RANGE that drifted instead of just
//      saying "different".
//   2. The framebuffer hash, as a SECONDARY signal only. A divergence invisible
//      on screen still desyncs gameplay, so pixels can only ever produce a FALSE
//      PASS — they are recorded to help attribute a failure, never to declare a
//      success.
//
// THE ARMS
//   GATING — both are two FRESH instances, each cold-booting the ROM for
//   itself, with no state transfer of any kind. They differ only in how far
//   apart the two instances are:
//     self   : two fresh pages in the SAME browser process
//     cross  : two fresh pages in DIFFERENT browser processes (--twobrowsers)
//   NON-GATING DIAGNOSTICS — these characterise the core and are EXPECTED to
//   diverge; each divergence is a documented constraint on the page, not a
//   broken build:
//     reload : does gpx_load() into a core that has already run reproduce a
//              cold boot? (Measured: NO — so the page must never re-load a ROM
//              inside a live room.)
//     rewind : does gpx_state_save -> gpx_state_load round-trip exactly?
//              (Measured: NO — retro_unserialize does not fully overwrite
//              state. Lockstep here never transfers state, so this does not
//              affect it, but the page's Save/Load State buttons rest on it.)
//   Each arm runs `--runs` times, because one agreeing run proves nothing
//   (CLAUDE.md gate #10).
//
// ⚠ NO ARM USES A SAVESTATE AS ITS INSTRUMENT, and that was learned the hard
// way. The first `self` arm rewound one instance with a savestate and reported
// a reproducible state divergence at frame 60 — which was the rewind, not the
// core. A savestate is the SUBJECT of the `rewind` arm and the instrument of
// nothing.
//
// WHAT THE STATIC AUDIT SAID BEFORE MEASURING (read first, per the same gate)
//   The shipped glue's wasm import table is, verbatim:
//     {e:___syscall_fcntl64, i:___syscall_ioctl, j:___syscall_openat,
//      k:__emscripten_throw_longjmp, l:_emscripten_resize_heap, c:_fd_close,
//      d:_fd_read, h:_fd_seek, b:_fd_write, f:invoke_ii, g:invoke_v, a:invoke_vii}
//   Twelve imports, not one of which is a date, clock, or entropy function. This
//   wasm CANNOT read host time — unlike the GBA core next door, whose cartridge
//   RTC imports `_emscripten_date_now` and `__localtime_js`. The one guest-visible
//   `rand()` is Genesis-Plus-GX's SOFT RESET path
//   (`~/gpgx-src/core/genesis.c:266`, `m68k.cycles = ... rand()/RAND_MAX`) against
//   an unseeded musl PRNG, so it is a fixed sequence that ADVANCES PER RESET —
//   this rig therefore never resets, and the page must keep reset out of a room.
//
// CONFIGURATION USED, AND ITS LIMIT
//   TWO TABS IN ONE BROWSER by default — the cheapest configuration that can
//   answer the question. `--twobrowsers` runs two separate Chrome processes
//   (separate V8 isolates, separate wasm tiering state, separate renderer). Two
//   tabs is a WEAKER test than two physical devices in one respect: same OS,
//   same CPU, same Chrome build. A PASS here is necessary-but-not-sufficient for
//   "two devices"; a FAIL here is conclusive for both.
//
// NO SHIPPED FILE IS MODIFIED. Everything is injected through puppeteer's page
// context; genesis.html, the core and lib/netplay.js are untouched.
//
// USAGE
//   npm run web                                     # port 8080, CLAUDE.md gate #2
//   node tools/browser_leak_guard.js reap && uptime # before any measured run
//   bash tools/probe_lock.sh run -- node tools/genesis_determinism_probe.mjs
//
//   node tools/genesis_determinism_probe.mjs --frames 3600 --runs 3 --twobrowsers
//
// FLAGS
//   --rom N|URL      ROMS[] index on the page, or an absolute site path (default 0)
//   --frames N       frames per run (default 1800 = ~30 s of guest time)
//   --every K        hash the serialized state every K frames (default 60)
//   --runs R         repeat the whole comparison R times (default 3)
//   --arms LIST      comma list of self,cross,reload,rewind (default self,cross)
//   --input MODE     none | scripted   (default scripted)
//   --chunk BYTES    state hash chunk size (default 16384)
//   --twobrowsers    two Chrome processes instead of two tabs
//   --headful        visible windows
//   --keep           leave browsers open
//   --url BASE       default http://localhost:8080
//   --name TAG       output suffix (default det)
// OUTPUT
//   /tmp/gen-det/<name>.log   /tmp/gen-det/<name>.json
//   Exit code 0 only if every requested arm agreed on every run.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUTDIR = '/tmp/gen-det';

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const ROM = flag('rom', '0');
const FRAMES = parseInt(flag('frames', '1800'), 10);
const EVERY = parseInt(flag('every', '60'), 10);
const RUNS = parseInt(flag('runs', '3'), 10);
const ARMS = String(flag('arms', 'self,cross')).split(',').map((s) => s.trim()).filter(Boolean);
const INPUT = flag('input', 'scripted');
const CHUNK = parseInt(flag('chunk', '16384'), 10);
const TWOBROWSERS = has('twobrowsers');
const HEADFUL = has('headful');
const KEEP = has('keep');
const BASE = flag('url', 'http://localhost:8080');
const NAME = flag('name', 'det');

fs.mkdirSync(OUTDIR, { recursive: true });
const LOG_PATH = path.join(OUTDIR, NAME + '.log');
const JSON_PATH = path.join(OUTDIR, NAME + '.json');
const logLines = [];
const say = (s) => { const t = String(s); logLines.push(t); console.log(t); };
const flush = () => { try { fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n'); } catch (e) {} };

// ---- HASH-GUARD, BEFORE AND AFTER (CLAUDE.md gate #10) ---------------------
// Agents share this tree. A concurrent rebuild mid-run produces a torn .js/.wasm
// pair, and here that would read as NONDETERMINISM — the single most expensive
// wrong conclusion this rig could reach. So the artefacts are hashed before and
// after and the run is VOIDED if they moved.
const ART = [
  'genesis/genesisWasm/dist/genesis_plus_gx.js',
  'genesis/genesisWasm/dist/genesis_plus_gx.wasm',
  'genesis.html',
];
function artefactHashes() {
  const out = {};
  for (const rel of ART) {
    try {
      out[rel] = crypto.createHash('md5').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
    } catch (e) { out[rel] = 'MISSING'; }
  }
  return out;
}
function loadAvg() {
  try { return execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) { return '(uptime unavailable)'; }
}

// ===========================================================================
// THE IN-PAGE DRIVER. Injected as a string; runs entirely in the page's realm
// so it can touch `Module` directly. It never touches the page's own loop.
// ===========================================================================
const DRIVER = String(function installGenesisDeterminismDriver() {
  const M = () => window.Module;

  function strToHeap(s) {
    const bytes = new TextEncoder().encode(String(s));
    const p = M()._gpx_alloc(bytes.length + 1);
    M().HEAPU8.set(bytes, p);
    M().HEAPU8[p + bytes.length] = 0;
    return p;
  }

  // FNV-1a over a byte range, returned as an unsigned 32-bit number.
  function fnv1a(u8, from, to) {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) {
      h ^= u8[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // THE SCRIPTED PAD, A PURE FUNCTION OF THE FRAME INDEX AND THE PORT.
  // ⚠ Nothing here may consult a clock, a random source, or any page state.
  // Bits are this core's own libretro ids (genesis.html BIT table):
  //   b:0 a:1 mode:2 start:3 up:4 down:5 left:6 right:7 c:8 y:9 x:10 z:11
  // The sequence presses Start early (past the title screen on most carts), then
  // walks and jumps on a prime-numbered cadence so the two ports are never in
  // phase with each other or with the hash interval.
  function scriptedPad(frame, port) {
    if (window.__det.inputMode === 'none') return 0;
    let m = 0;
    const f = frame + port * 977;          // de-phase the ports
    if (frame > 60 && frame < 80) m |= (1 << 3);            // start
    if (frame > 150) {
      if ((f % 53) < 26) m |= (1 << 7);                     // right
      else m |= (1 << 6);                                   // left
      if ((f % 31) === 0) m |= (1 << 1);                    // a
      if ((f % 71) < 6) m |= (1 << 0);                      // b
      if ((f % 97) < 4) m |= (1 << 4);                      // up
      if ((f % 113) < 5) m |= (1 << 5);                     // down
    }
    return m;
  }

  window.__det = {
    inputMode: 'scripted',
    statePtr: 0,
    stateSize: 0,

    // Cold-boot the ROM. This is a FULL reload: gpx_load() calls
    // retro_unload_game() then retro_load_game() and memsets pad[] to zero
    // (gpgx_shim.c), so calling it again is a fresh boot in the same instance —
    // which is exactly what the `self` arm needs and why no savestate is used.
    async load(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('rom fetch ' + r.status + ' ' + url);
      const b = new Uint8Array(await r.arrayBuffer());
      const p = M()._gpx_alloc(b.length);
      if (!p) throw new Error('gpx_alloc failed for ' + b.length + ' bytes');
      M().HEAPU8.set(b, p);
      const nPtr = strToHeap('detrom');
      const ePtr = strToHeap('gen');
      const ok = M()._gpx_load(p, b.length, nPtr, ePtr);
      M()._gpx_free(p); M()._gpx_free(nPtr); M()._gpx_free(ePtr);
      if (!ok) throw new Error('the core refused the ROM');

      // Size the state buffer once and reuse it, so the measurement does not
      // churn the heap it is measuring.
      const sz = M()._gpx_state_size() >>> 0;
      if (sz !== this.stateSize) {
        if (this.statePtr) M()._gpx_free(this.statePtr);
        this.statePtr = M()._gpx_alloc(sz);
        this.stateSize = sz;
      }
      return {
        ok: true, bytes: b.length, stateSize: sz,
        fps: M()._gpx_fps(), w: M()._gpx_width(), h: M()._gpx_height(),
        sha: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)))
          .slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join(''),
      };
    },

    // Hash the serialized state as an ARRAY of per-chunk values, so a mismatch
    // names the byte range rather than merely saying "different".
    stateHash(chunk) {
      const ok = M()._gpx_state_save(this.statePtr, this.stateSize);
      if (!ok) return null;
      // ALLOW_MEMORY_GROWTH can replace HEAPU8.buffer, so re-view every time.
      const u8 = new Uint8Array(M().HEAPU8.buffer, this.statePtr, this.stateSize);
      const out = [];
      for (let off = 0; off < this.stateSize; off += chunk) {
        out.push(fnv1a(u8, off, Math.min(off + chunk, this.stateSize)));
      }
      return out;
    },

    // Rig-only rewind, so the `self` arm can replay WITHOUT re-loading the ROM.
    // ⚠ THIS IS NOT HOW LOCKSTEP STARTS. Lockstep cold-boots every peer; the
    // savestate here exists purely so one instance can be rewound to identical
    // bytes and replayed, which is the control that says whether the core is
    // even self-deterministic. Measured first attempt: re-loading the ROM does
    // NOT reproduce a cold boot (see the `reload` arm), so a reload-based self
    // arm was measuring the reload, not the core.
    // The snapshot NEVER leaves the page realm — a 1 MB byte array marshalled
    // back to Node through puppeteer would be serialized key-by-key.
    _rewind: null,
    snapshot() {
      if (!M()._gpx_state_save(this.statePtr, this.stateSize)) return false;
      this._rewind = new Uint8Array(M().HEAPU8.buffer, this.statePtr, this.stateSize).slice();
      return true;
    },
    restore() {
      if (!this._rewind) return false;
      M().HEAPU8.set(this._rewind, this.statePtr);
      return !!M()._gpx_state_load(this.statePtr, this.stateSize);
    },

    fbHash() {
      const w = M()._gpx_width(), h = M()._gpx_height();
      if (!w || !h) return 0;
      const p = M()._gpx_video();
      const u8 = new Uint8Array(M().HEAPU8.buffer, p, w * h * 4);
      return fnv1a(u8, 0, u8.length);
    },

    // Drive exactly `frames` frames. Returns the hash timeline.
    // ⚠ THE FIRST MARK IS f = -1, TAKEN BEFORE ANY FRAME RUNS. It separates two
    // very different failures that look identical in a timeline that starts at
    // frame 0: a core that BOOTS to different bytes, and a core that boots
    // identically and then DIVERGES while running. Without it the first
    // measurement here was ambiguous.
    run(frames, every, chunk, ports) {
      const t0 = performance.now();
      // ⚠ NO FRAMEBUFFER AT f = -1, and this is a correctness fix, not a
      // convenience. The shim's RGBA buffer (`vid_rgba`) is NOT part of the
      // serialized state — only `gpx_run()` rewrites it — so after the self
      // arm's rewind it still holds the last frame of the previous pass while
      // the emulator state is correctly restored. Comparing it before any frame
      // has run in THIS pass reported a divergence for a core whose state
      // matched exactly. A pixel signal can only ever produce a false PASS;
      // this one was producing a false FAIL.
      const marks = [{ f: -1, s: this.stateHash(chunk), v: null }];
      for (let f = 0; f < frames; f++) {
        for (let p = 0; p < ports; p++) M()._gpx_set_pad(p, scriptedPad(f, p));
        M()._gpx_run();
        if (every > 0 && (f % every) === 0) {
          marks.push({ f, s: this.stateHash(chunk), v: this.fbHash() });
        }
      }
      return {
        marks,
        ms: performance.now() - t0,
        // NON-INTERFERENCE WITNESS: the page's own runFrame() is the only thing
        // that increments this. Nonzero means the page was ALSO driving the core
        // and every hash above is void.
        pageFrames: window.__genFrames | 0,
      };
    },
  };
  return 'ok';
}) + '; installGenesisDeterminismDriver();';

// ===========================================================================
// The same Chrome every other harness on this site uses — puppeteer's bundled
// build is not installed here (tools/genesis_page_test.mjs:44 does the same).
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function newBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Keep the two instances as independent as the configuration allows.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
}

async function newInstance(browser, tag) {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(BASE + '/genesis.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for the CORE, not for the page. `_gpx_init()` runs inside
  // onRuntimeInitialized and the status line is set immediately after it.
  await page.waitForFunction(
    () => !!(window.Module && typeof window.Module._gpx_run === 'function'
             && typeof window.Module._gpx_load === 'function'
             && typeof window.Module._gpx_state_size === 'function'),
    { timeout: 120000 },
  );
  await page.evaluate(DRIVER);
  await page.evaluate((mode) => { window.__det.inputMode = mode; }, INPUT);
  // ⚠ START IS NEVER PRESSED. The page's `running` flag therefore stays false
  // and its rAF loop returns on every tick without touching the core.
  return { page, errs, tag };
}

function romUrl() {
  if (/^\//.test(ROM)) return ROM;
  const idx = parseInt(ROM, 10) || 0;
  // Read the page's own ROMS[] rather than duplicating it here.
  return { fromPage: idx };
}

async function resolveRom(inst) {
  const spec = romUrl();
  if (typeof spec === 'string') return spec;
  const url = await inst.page.evaluate((i) => {
    const sel = document.getElementById('romSelect');
    if (!sel || !sel.options[i]) return null;
    return { label: sel.options[i].textContent.trim(), value: sel.options[i].value };
  }, spec.fromPage);
  if (!url) throw new Error('ROMS[' + spec.fromPage + '] is not on the page');
  // The page keeps its urls in a closure; recover it from the option label by
  // asking the page to fetch through its own list is not possible, so use the
  // documented layout instead and VERIFY the fetch succeeds.
  const guess = await inst.page.evaluate(async (label) => {
    const cands = [
      '/genesis/genesisWasm/roms/' + label + ' (USA).gen',
      '/genesis/genesisWasm/roms/' + label + ' (U).gen',
      '/genesis/genesisWasm/roms/' + label + '.gen',
    ];
    for (const c of cands) {
      try { const r = await fetch(c, { method: 'HEAD' }); if (r.ok) return c; } catch (e) {}
    }
    return null;
  }, url.label);
  if (!guess) throw new Error('could not locate a ROM file for "' + url.label + '"');
  return guess;
}

// Compare two timelines. Returns { diff, fb } where `diff` is the first
// SERIALIZED-STATE divergence (the thing lockstep actually cares about) or null,
// and `fb` counts framebuffer-only differences.
//
// ⚠ A FRAMEBUFFER DIFFERENCE NEVER FAILS THIS GATE, and that is deliberate.
// The header of this file already says a pixel signal can only produce a false
// PASS; the first version of the code contradicted it and let pixels declare a
// FAILURE, which they promptly did — twice, both times spuriously. The shim's
// `vid_rgba` is not in the serialized state and is only rewritten when
// `retro_run` actually produces a new frame (`gpx_frame_is_new`), so on a
// duplicate frame, or on the mark taken before any frame has run, it holds
// whatever the previous pass left there. It is recorded to help ATTRIBUTE a
// state divergence and reported as a note, never as a verdict.
function cmpMarks(a, b) {
  const n = Math.min(a.length, b.length);
  let fb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x.f !== y.f) return { diff: { frame: x.f, what: 'frame-index', a: x.f, b: y.f }, fb };
    const sa = x.s, sb = y.s;
    if (!sa || !sb) return { diff: { frame: x.f, what: 'state-save-failed', a: !!sa, b: !!sb }, fb };
    if (sa.length !== sb.length) {
      return { diff: { frame: x.f, what: 'state-size', a: sa.length, b: sb.length }, fb };
    }
    for (let c = 0; c < sa.length; c++) {
      if (sa[c] !== sb[c]) {
        return {
          diff: {
            frame: x.f, what: 'state-chunk', chunk: c,
            byteFrom: c * CHUNK, byteTo: (c + 1) * CHUNK,
            a: sa[c], b: sb[c], fbSame: x.v === y.v,
          }, fb,
        };
      }
    }
    if (x.v != null && y.v != null && x.v !== y.v) fb++;
  }
  if (a.length !== b.length) return { diff: { frame: -1, what: 'mark-count', a: a.length, b: b.length }, fb };
  return { diff: null, fb };
}

(async () => {
  const t0 = Date.now();
  say('=== genesis determinism probe ===');
  say('load at start: ' + loadAvg());
  const hashBefore = artefactHashes();
  for (const k of Object.keys(hashBefore)) say('  md5 ' + hashBefore[k] + '  ' + k);
  say(`frames=${FRAMES} every=${EVERY} runs=${RUNS} arms=${ARMS.join(',')} input=${INPUT} `
      + `chunk=${CHUNK} ${TWOBROWSERS ? 'two-browsers' : 'two-tabs'}`);

  const results = { arms: {}, meta: {} };
  let browsers = [];
  let failures = 0;
  let diagnostics = 0;

  try {
    const bA = await newBrowser(); browsers.push(bA);
    const bB = TWOBROWSERS ? await newBrowser() : bA;
    if (TWOBROWSERS) browsers.push(bB);

    const A = await newInstance(bA, 'A');
    const B = await newInstance(bB, 'B');

    const rom = await resolveRom(A);
    say('rom: ' + rom);

    const infoA = await A.page.evaluate((u) => window.__det.load(u), rom);
    const infoB = await B.page.evaluate((u) => window.__det.load(u), rom);
    say(`A: ${infoA.bytes} B rom sha ${infoA.sha}  state ${infoA.stateSize} B  fps ${infoA.fps}  ${infoA.w}x${infoA.h}`);
    say(`B: ${infoB.bytes} B rom sha ${infoB.sha}  state ${infoB.stateSize} B  fps ${infoB.fps}  ${infoB.w}x${infoB.h}`);
    results.meta = { rom, infoA, infoB, frames: FRAMES, every: EVERY, runs: RUNS, chunk: CHUNK,
                     input: INPUT, twobrowsers: TWOBROWSERS };
    if (infoA.sha !== infoB.sha) {
      say('VOID: the two instances did not load the same ROM bytes');
      failures++;
    }

    const PORTS = 2;   // Genesis-Plus-GX config_default(): both MD ports are gamepads

    const drive = (inst) => inst.page.evaluate(
      (f, e, c, p) => window.__det.run(f, e, c, p), FRAMES, EVERY, CHUNK, PORTS);
    // ⚠ ONLY `self` AND `cross` GATE. They are the lockstep question: two cold
    // boots, no state transfer, do they stay identical. `reload` and `rewind`
    // CHARACTERISE the core — they are expected to diverge and a divergence
    // there is a documented constraint on the page, not a broken build. Letting
    // them fail the gate would make the gate cry wolf on known behaviour.
    const GATING = new Set(['self', 'cross']);
    const record = (arm, r, cmp, pf, ms, note) => {
      const d = cmp.diff;
      (results.arms[arm] = results.arms[arm] || []).push({ run: r, diff: d, fbOnly: cmp.fb, pageFrames: pf, ms, gating: GATING.has(arm) });
      const fbNote = cmp.fb ? ` [${cmp.fb} framebuffer-only mark(s) — not a state divergence]` : '';
      if (pf.some((x) => x !== 0)) { say(`  ${arm} run ${r}: VOID — the page ran ${pf.join('/')} frames of its own`); failures++; }
      else if (d) {
        say(`  ${arm} run ${r}: DIVERGED ${JSON.stringify(d)}`);
        if (GATING.has(arm)) failures++; else diagnostics++;
      } else say(`  ${arm} run ${r}: STATE IDENTICAL over ${FRAMES} frames${note || ''}${fbNote}`);
      flush();
    };

    // ---- THE TWO ARMS THAT MATTER, AND WHY NEITHER USES A SAVESTATE --------
    // Both are TWO FRESH INSTANCES, EACH COLD-BOOTING THE ROM FOR ITSELF, with
    // no state transfer of any kind — which is exactly the configuration two
    // lockstep players are in, because the room seats everybody BEFORE anything
    // boots. They differ only in how far apart the two instances are:
    //   self  : two fresh pages in the SAME browser process
    //   cross : two fresh pages in DIFFERENT browser processes (--twobrowsers)
    //
    // ⚠ AN EARLIER SELF ARM REWOUND ONE INSTANCE WITH A SAVESTATE AND WAS WRONG.
    // It reported a state divergence at frame 60 that reproduced exactly, and
    // the cause was the rig: `retro_unserialize` does not fully overwrite state,
    // so restoring the same bytes onto a fresh core and onto a 1800-frame-old
    // core leaves different residue. The arm was measuring its own rewind
    // device. The savestate round trip is now measured on purpose, and only in
    // the `rewind` arm, where it is the subject rather than the instrument.
    const pairArm = async (arm, browserB) => {
      for (let r = 0; r < RUNS; r++) {
        const fa = await newInstance(bA, arm + 'A' + r);
        const fb = await newInstance(browserB, arm + 'B' + r);
        try {
          const ia = await fa.page.evaluate((u) => window.__det.load(u), rom);
          const ib = await fb.page.evaluate((u) => window.__det.load(u), rom);
          if (ia.sha !== ib.sha) { say(`  ${arm} run ${r}: VOID — different ROM bytes`); failures++; continue; }
          const [pa, pb] = await Promise.all([drive(fa), drive(fb)]);
          record(arm, r, cmpMarks(pa.marks, pb.marks), [pa.pageFrames, pb.pageFrames], [pa.ms, pb.ms],
                 ` (${pa.marks.length} marks, ${Math.round(pa.ms)}/${Math.round(pb.ms)} ms)`);
        } finally {
          try { await fa.page.close(); } catch (e) {}
          try { await fb.page.close(); } catch (e) {}
        }
      }
    };

    if (ARMS.includes('self')) await pairArm('self', bA);
    if (ARMS.includes('cross')) {
      if (!TWOBROWSERS) {
        say('  note: without --twobrowsers, `cross` is the same configuration as `self` '
            + '(two tabs in one process). Reported anyway, but it is not a second, independent arm.');
      }
      await pairArm('cross', bB);
    }

    // ---- REWIND ARM -------------------------------------------------------
    // DOES gpx_state_save -> gpx_state_load ROUND-TRIP CLEANLY? Not a lockstep
    // requirement — lockstep here never transfers state — but the page's own
    // Save/Load State buttons depend on it, and it is the arm that exposed the
    // rig bug above, so it is worth being able to run deliberately.
    if (ARMS.includes('rewind')) {
      for (let r = 0; r < RUNS; r++) {
        const fa = await newInstance(bA, 'W' + r);
        try {
          await fa.page.evaluate((u) => window.__det.load(u), rom);
          if (!await fa.page.evaluate(() => window.__det.snapshot())) {
            say(`  rewind run ${r}: VOID — gpx_state_save refused`); failures++; continue;
          }
          const p1 = await drive(fa);
          if (!await fa.page.evaluate(() => window.__det.restore())) {
            say(`  rewind run ${r}: VOID — gpx_state_load refused`); failures++; continue;
          }
          const p2 = await drive(fa);
          record('rewind', r, cmpMarks(p1.marks, p2.marks), [p1.pageFrames, p2.pageFrames], [p1.ms, p2.ms],
                 ' — the savestate round trip reproduced the run exactly');
        } finally { try { await fa.page.close(); } catch (e) {} }
      }
    }

    // ---- RELOAD ARM -------------------------------------------------------
    // DOES gpx_load() INTO A CORE THAT HAS ALREADY RUN REPRODUCE A COLD BOOT?
    // This is not an academic question: if it does not, the page must never
    // re-load a ROM while a room is live, and a player who picks a different
    // game has to leave and rejoin. Measured here rather than assumed.
    if (ARMS.includes('reload')) {
      for (let r = 0; r < RUNS; r++) {
        const fa = await newInstance(bA, 'R' + r);
        try {
          await fa.page.evaluate((u) => window.__det.load(u), rom);
          const p1 = await drive(fa);                                   // cold boot
          await fa.page.evaluate((u) => window.__det.load(u), rom);      // re-load
          const p2 = await drive(fa);
          record('reload', r, cmpMarks(p1.marks, p2.marks), [p1.pageFrames, p2.pageFrames], [p1.ms, p2.ms],
                 ' — a re-load DID reproduce the cold boot');
        } finally { try { await fa.page.close(); } catch (e) {} }
      }
    }

    const pe = [...A.errs, ...B.errs];
    if (pe.length) { say('page errors: ' + JSON.stringify(pe.slice(0, 6))); }
    results.pageErrors = pe;
  } catch (e) {
    say('ERROR: ' + ((e && e.stack) || e));
    failures++;
  } finally {
    if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (e) {} }
  }

  const hashAfter = artefactHashes();
  let torn = false;
  for (const k of Object.keys(hashBefore)) {
    if (hashBefore[k] !== hashAfter[k]) { torn = true; say('⚠ ARTEFACT CHANGED MID-RUN: ' + k); }
  }
  if (torn) { say('VOID: a concurrent build changed the artefacts during this run'); failures++; }
  results.hashBefore = hashBefore; results.hashAfter = hashAfter;
  results.load = loadAvg();
  say('load at end:   ' + results.load);
  say('elapsed ' + Math.round((Date.now() - t0) / 1000) + ' s');
  results.diagnostics = diagnostics;
  if (diagnostics) {
    say(diagnostics + ' non-gating diagnostic divergence(s) — see the `reload`/`rewind` arms above. '
        + 'These characterise the core and constrain the page; they are not build failures.');
  }
  say(failures === 0 ? 'GATE: PASS' : 'GATE: FAIL (' + failures + ')');
  flush();
  try { fs.writeFileSync(JSON_PATH, JSON.stringify(results, null, 2)); } catch (e) {}
  say('json: ' + JSON_PATH);
  flush();
  process.exit(failures === 0 ? 0 : 1);
})();
