#!/usr/bin/env node
// ============================================================================
// room_desync_soak.mjs — DOES A REAL TWO-BROWSER DREAMCAST ROOM STAY IN SYNC
//                        FOR MINUTES, IN A 3D SCENE, WITH BOTH PLAYERS PRESSING?
// ============================================================================
//
// WHY THIS EXISTS. dreamcast/docs/rollback/TASKS.md (f615765) proved that the
// shipped core is NOT a pure function of its savestate: the idle-skip streak
// (rec_wasm.cpp:1625, `static u32 s_isk_streak`, never serialized, never
// reset) and the shard batch-install route both carry HOST HISTORY into the
// guest trajectory, so two runs from one state diverge at frame 3. Dreamcast
// rooms on prod are delay-based LOCKSTEP and depend on exactly that purity. The
// question this rig answers is the product one: does a real room — two Chrome
// PROCESSES, the shipped hand-off URL, the shipped signalling, a real WebRTC
// DataChannel, the shipped seed-at-frame-0 path — fork?
//
// TWO DETECTORS, BECAUSE ONE CAN BE BLIND.
//   1. THE PRODUCT'S OWN: lib/netplay.js Lockstep compares the worker's
//      fingerprint every 60 frames (flycast_worker.js lsWords(): 12 SH4/Holly
//      fields + the 64-bit guest cycle counter). Desync events and
//      report().hashesCompared are read off the engine.
//   2. THE RIG'S: a hash of ALL 16 MB of guest main RAM, taken IN THE WORKER,
//      synchronously, at the SAME clean asyncify boundary the product hashes
//      at (the rig wraps the worker's postMessage and computes it when the
//      worker posts {cmd:'lsHash'}), so both peers hash the state after the
//      same frame f. RAM is located in the wasm heap by content and verified
//      word-for-word against the shipped `_sh4_mem_read32` export; it is
//      re-verified on 64 random words at every hash. A register fingerprint
//      can agree for a while over diverged RAM; this cannot.
//   Neither detector calls _emscripten_save_state: retro_serialize does
//   emu.stop()/emu.start(), which is the normalize side effect and would
//   PERTURB the thing being measured.
//
// ARMS ARE QUERY STRINGS + ONE RIG LEVER, so the page under test is the shipped
// page served from a HERMETIC SNAPSHOT (md5 of every served critical file is
// taken BEFORE and AFTER and printed):
//   --qhost / --qjoin / --query   extra query for host / joiner / both
//   --preroll N   CONTROL: the JOINER's worker runs N real frames from the seed
//                 before the room's frame-0 seed load (the rig intercepts the
//                 seed's loadState in that worker, loads the same bytes, runs
//                 N frames, then lets the page's own load proceed). This gives
//                 the joiner exactly the "host history" the rollback card
//                 measured — a worker that has run frames — while its guest
//                 state at frame 0 is byte-identical to the host's. No product
//                 path reaches it today (a room is always entered on a fresh
//                 worker: lsRestartIntoRoom reloads the page); it is the
//                 control that shows whether that history CAN fork a room.
//
// USAGE (correctness — no probe lock needed; perf numbers are NOT produced here)
//   WEB_ROOT=<snapshot> PORT=18801 node tools/devserver.mjs &
//   node tools/browser_leak_guard.js reap && uptime
//   CHROME_PATH=... node dreamcast/tools/room_desync_soak.mjs --url http://localhost:18801 \
//        --game pso2 --soak 200 --name shipped
//
// FLAGS
//   --url BASE      hermetic snapshot origin (required)
//   --game G        romSelect key (default pso2)
//   --soak S        GUEST seconds to soak after both cores run (default 200),
//                   counted as host lockstep frames / --gfps (default 30, PSO's
//                   render rate) and re-measured at the end from the guest
//                   cycle counter (guestSecondsByCycles). Guest seconds, not
//                   wall: a loaded box runs two cores far below 1.000x.
//   --maxwall S     wall-clock cap for the soak (default 1500)
//   --preroll N     see above (default 0)
//   --save-at S / --load-at S   the HOST presses Save / Load State at guest S
//   --nohook        no worker hook (no RAM detector): proves a result does not
//                   depend on the rig's own instrument
//   --script none|walk   input script (default walk: both players press)
//   --name N        output under /tmp/dc-soak/<N>.{log,json,*.png}
//   --owd MS[:J]    SIMULATED LINK: every RTCDataChannel.send on BOTH pages is
//                   delivered MS ms later (+ uniform 0..J ms jitter, order kept),
//                   so RTT = 2 x MS (+ jitter). The pings the host sizes the
//                   delay from cross the same delayed channel.
//   ALSO MEASURED (2026-10-05, dreamcast/docs/room-input-lag/TASKS.md):
//     * input lag per console: the wall time from the moment the page SAMPLES
//       its local pad for frame F (the engine's beginFrame that schedules F)
//       to the moment that console's worker STARTS run_iter for F. Same epoch
//       clock (timeOrigin + now) on page and worker.
//     * room speed from the guest cycle counter against wall time at the hash
//       checkpoints (after a 5 guest-s warm-up), per console.
//     * the engine's slack (minLead / meanLead), stalls, delay.
//   --keep-profiles
// VERDICTS  IN SYNC · DESYNC · REFUSED (the worker's anchor guard stopped a
//   console that would have forked) · CORE CRASH · FROZEN · VOID. A fork needs
//   no minimum sample; IN SYNC needs >= 10 checkpoints on both detectors.
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const requireFrom = (() => {
  for (const base of [process.cwd() + '/', path.join(os.homedir(), 'probe-deps') + '/', import.meta.url]) {
    try { const r = createRequire(base); r.resolve('puppeteer'); return r; } catch (e) {}
  }
  return createRequire(import.meta.url);
})();
const puppeteer = requireFrom('puppeteer');
const { startBroker } = await import(pathToFileURL(path.join(REPO, 'tools', 'mqtt_ws_broker.mjs')).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const BASE = String(flag('url', '')).replace(/\/$/, '');
if (!BASE) { console.error('--url <hermetic snapshot origin> is required'); process.exit(2); }
const GAME = flag('game', 'pso2');
const SOAK = +flag('soak', '200');
const MAXWALL = +flag('maxwall', '1500');
const PREROLL = +flag('preroll', '0');
// What idle-skip is set to on the joiner AFTER its preroll history (default: ON
// unless the arm's query turned it off, i.e. whatever the page itself asked for).
const SCRIPT = flag('script', 'walk');
const GFPS = +flag('gfps', '30');   // lockstep frames per guest second (PSO renders at 30)
const NAME = flag('name', 'soak-' + Date.now());
const QBOTH = flag('query', '');
const QHOST = flag('qhost', '');
const QJOIN = flag('qjoin', '');
const PREROLL_ISK_AFTER = /noidleskip/.test(QBOTH + QJOIN) ? 0 : 1;
const KEEP_PROFILES = has('keep-profiles');
const OWD = String(flag('owd', '0')).split(':');
const OWD_MS = Math.max(0, +OWD[0] || 0), OWD_JIT = Math.max(0, +OWD[1] || 0);
// --save-at S: the HOST clicks the page's own Save State button at guest second
// S (and --load-at S clicks Load State). One console doing it alone is the
// question: retro_serialize runs emu.stop()/emu.start(), which is exactly the
// side effect the lockstep normalize relies on to CHANGE derived state.
const SAVE_AT = flag('save-at', null) == null ? null : +flag('save-at', '0');
const LOAD_AT = flag('load-at', null) == null ? null : +flag('load-at', '0');
// --nohook: no worker hook at all (no RAM detector, no preroll). The A/B that
// proves the rig's own instrument is not what a result depends on.
const NOHOOK = has('nohook');
// --noram: hook the worker (input lag, speed) but take NO 16 MB RAM hash. The
// hash costs 34-44 ms of the worker every 60 frames, which the other console
// sees as a stall; a timing measurement must not carry it. The verdict then
// rests on the engine's fingerprints, as with --nohook.
const NORAM = has('noram');
const BOOT_MS = +flag('bootms', '420000');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/dc-soak';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
let SOAK_T0 = 0;   // set when the soak proper starts (after the room runs)
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const uptime = () => { try { return execSync('uptime').toString().trim(); } catch (e) { return '?'; } };

const RESULT = { name: NAME, when: new Date().toISOString(), base: BASE, game: GAME, soakGuestS: SOAK, preroll: PREROLL,
                 qhost: QBOTH + QHOST, qjoin: QBOTH + QJOIN, script: SCRIPT, uptimeStart: uptime(), loads: [] };

// ---- md5 of what the server SERVES, before and after ------------------------
const SERVED = ['/dreamcast.html', '/lib/netplay.js', '/dreamcast/flycast_libretro/flycast_worker.js',
                '/dreamcast/flycast_libretro/flycast_worker_emcc.js', '/dreamcast/flycast_libretro/flycast_worker_emcc.wasm',
                '/dreamcast/states/pso2_boot.state'];
async function servedMd5() {
  const out = {};
  for (const p of SERVED) {
    try {
      const r = await fetch(BASE + p);
      const b = Buffer.from(await r.arrayBuffer());
      out[p] = r.ok ? crypto.createHash('md5').update(b).digest('hex') + ' ' + b.length : 'HTTP ' + r.status;
    } catch (e) { out[p] = 'ERR ' + e.message; }
  }
  return out;
}

// ---- the in-page preload: engine + desync capture ---------------------------
const PRELOAD = `(() => {
  const M = window.__soak = { desyncs: [], engine: null, frames: 0, samples: [] };
  const OWD_MS = ${OWD_MS}, OWD_JIT = ${OWD_JIT};
  if (OWD_MS > 0 || OWD_JIT > 0) {
    const send0 = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (d) {
      const ch = this, now = performance.now();
      let v = d;
      if (d instanceof ArrayBuffer) v = d.slice(0);
      else if (ArrayBuffer.isView(d)) v = new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const at = Math.max(ch.__owdLast || 0, now + OWD_MS + Math.random() * OWD_JIT);
      ch.__owdLast = at;
      setTimeout(() => { try { if (ch.readyState === 'open') send0.call(ch, v); } catch (e) {} }, Math.max(0, at - now));
    };
  }
  const hook = () => {
    const L = window.Netplay && window.Netplay.Lockstep;
    if (!L) return false;
    if (L.prototype.__soak) return true;
    L.prototype.__soak = true;
    const emit = L.prototype._emit;
    L.prototype._emit = function (ev, a) {
      try { M.engine = this; if (ev === 'desync') M.desyncs.push({ t: Date.now(), frame: this.frame, d: JSON.parse(JSON.stringify(a || {})) }); } catch (e) {}
      return emit.call(this, ev, a);
    };
    const begin = L.prototype.beginFrame;
    L.prototype.beginFrame = function (pads, opt) {
      M.engine = this;
      // the call that SCHEDULES this console's local pad (lib/netplay.js beginFrame)
      try {
        const f = this.frame;
        if (!this.rollback && (this.state === 'running' || this.state === 'stalled') &&
            this._scheduledTo <= f && (f + this.delay) > this._queuedTo) {
          M.samples.push({ F: f + this.delay, t: performance.timeOrigin + performance.now(), d: this.delay });
          if (M.samples.length > 30000) M.samples.splice(0, 10000);
        }
      } catch (e) {}
      return begin.call(this, pads, opt);
    };
    return true;
  };
  if (!hook()) { const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 10); }
})();`;

// ---- the worker hook ---------------------------------------------------------
// Evaluated INSIDE the flycast worker over raw CDP (puppeteer's
// WebWorker.evaluate never resolves for this worker — rollback_measure.mjs).
function workerHookSrc(prerollN) {
  return `(() => {
  const M = self.Module;
  if (!M || typeof M._emscripten_run_iter !== 'function' || typeof M._sh4_mem_read32 !== 'function') return { ok: false, err: 'Module not ready' };
  if (self.__soak) return { ok: true, again: true };
  const S = self.__soak = { rows: [], err: null, base: -1, cands: null, locMs: 0, verifyBad: 0, hashMs: 0, hashN: 0,
                            prerollWant: ${prerollN | 0}, preroll: null, queued: 0, starts: [], lastStart: 0 };
  // run_iter START time per lockstep frame (input-lag measurement): the pump
  // calls self.Module._emscripten_run_iter() by property, and posts 'lsFrame'
  // with that frame's number right after it returns.
  { const ri = M._emscripten_run_iter;
    M._emscripten_run_iter = function () { S.lastStart = performance.timeOrigin + performance.now(); return ri.apply(this, arguments); }; }
  const RAM = 0x8c000000, RAM_SZ = 16 << 20, WORDS = RAM_SZ >>> 2;
  const rd = (a) => M._sh4_mem_read32(a >>> 0) >>> 0;
  const flagPtr = (typeof M._flycast_run_iter_flag_ptr === 'function') ? (M._flycast_run_iter_flag_ptr() >>> 0) : 0;
  const inflight = () => flagPtr !== 0 && M.HEAPU8[flagPtr] !== 0;
  let rng = 0x9e3779b9;
  const rnd = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng; };
  function fullVerify(base) {
    const H = new Uint32Array(M.HEAPU8.buffer, base, WORDS);
    let bad = 0;
    for (let i = 0; i < WORDS; i++) if (H[i] !== rd(RAM + i * 4)) { if (++bad > 16) break; }
    return bad;
  }
  function locate() {
    const t0 = performance.now();
    const H32 = new Uint32Array(M.HEAPU8.buffer);
    const cands = new Map();
    for (const frac of [0.11, 0.29, 0.47, 0.63, 0.81, 0.93]) {
      const off = (Math.floor(RAM_SZ * frac) & ~63) >>> 0;
      const pat = []; for (let w = 0; w < 16; w++) pat.push(rd(RAM + off + w * 4));
      if (new Set(pat).size < 6) continue;
      let k = 0; while (k < 16 && (pat[k] === 0 || pat[k] === 0xffffffff || pat[k] < 0x10000)) k++;
      if (k >= 16) continue;
      let i = H32.indexOf(pat[k]);
      let guard = 0;
      while (i >= 0 && guard++ < 4096) {
        const s = i - k;
        let ok = s >= 0;
        for (let w = 0; ok && w < 16; w++) if (H32[s + w] !== pat[w]) ok = false;
        if (ok) { const base = s * 4 - off; if (base >= 0) cands.set(base, (cands.get(base) || 0) + 1); }
        i = H32.indexOf(pat[k], i + 1);
      }
    }
    const tried = [];
    let best = -1;
    for (const [base, votes] of cands) {
      const bad = fullVerify(base);
      tried.push({ base, votes, bad });
      if (bad === 0 && best < 0) best = base;
      else if (bad === 0) S.err = 'two candidates both match all of RAM — ambiguous';
    }
    S.cands = tried; S.locMs = Math.round(performance.now() - t0);
    return best;
  }
  function ramHash() {
    if (${NORAM ? 'true' : 'false'}) return null;
    if (S.base < 0) S.base = locate();
    if (S.base < 0) return null;
    // re-verify 64 random words every time — a stale pointer must not pass
    const H = new Uint32Array(M.HEAPU8.buffer, S.base, WORDS);
    for (let j = 0; j < 64; j++) { const i = rnd() % WORDS; if (H[i] !== rd(RAM + i * 4)) { S.verifyBad++; S.base = -1; return null; } }
    const parts = [];
    for (let p = 0; p < 4; p++) {
      let h = 0x811c9dc5 | 0;
      const end = (p + 1) * (WORDS >>> 2);
      for (let i = p * (WORDS >>> 2); i < end; i++) h = Math.imul(h ^ H[i], 16777619);
      parts.push((h >>> 0).toString(16).padStart(8, '0'));
    }
    return parts.join('');
  }
  const prevPost = self.postMessage;
  self.postMessage = function (msg, transfer) {
    try {
      if (msg && msg.cmd === 'lsFrame') {
        S.starts.push(msg.f | 0, S.lastStart);
        if (S.starts.length > 60000) S.starts.splice(0, 20000);
      }
      if (msg && msg.cmd === 'lsHash') {
        const t0 = performance.now();
        const ram = ramHash();
        const dt = performance.now() - t0;
        S.hashMs += dt; S.hashN++;
        let burns = null; try { burns = M._flycast_ctx_snapshot(90) >>> 0; } catch (e) {}
        S.rows.push({ f: msg.f, h: msg.h >>> 0, ram, cyc: M._flycast_guest_cycles(), t: performance.timeOrigin + t0, burns, w: msg.w ? Array.from(msg.w) : null });
        if (S.rows.length > 20000) S.rows.shift();
      }
    } catch (e) { S.err = 'hash threw: ' + (e && e.message || e); }
    return transfer ? prevPost.call(self, msg, transfer) : prevPost.call(self, msg);
  };
  // ---- the PREROLL control (joiner only) ----
  if (S.prerollWant > 0) {
    // ⚠ The shim REASSIGNS self.onmessage (shimOnMessage -> onCmd) once its
    // runtime is up, which may be AFTER this hook runs. So the handler slot is
    // taken over with an accessor: the real event-handler attribute is set to
    // the wrapper once, and every later assignment only changes what the
    // wrapper forwards to.
    let desc = null;
    for (let o = self; o && !desc; o = Object.getPrototypeOf(o)) desc = Object.getOwnPropertyDescriptor(o, 'onmessage');
    let inner = self.onmessage;
    const orig = { call: (t, ev) => (typeof inner === 'function' ? inner.call(t, ev) : undefined) };
    let busy = false; const q = [];
    const wrapper = function (ev) {
      const d = ev && ev.data;
      if (busy) { q.push(ev); S.queued++; return; }
      if (!S.preroll && d && d.cmd === 'loadState' && (d.frame | 0) === 0 && d.data) {
        busy = true;
        (async () => {
          try {
            const src = new Uint8Array(d.data);
            const ptr = M._malloc(src.length); M.HEAPU8.set(src, ptr);
            const ok = M._emscripten_load_state(ptr, src.length) | 0; M._free(ptr);
            const b0 = M._flycast_ctx_snapshot(90) >>> 0;
            // The history is made with idle-skip ON (the shipped default), so the
            // streak really moves; afterwards the setting is put back to what
            // this arm's page asked for (--preroll-isk-after), which is how a
            // fix applied "before the anchor" is tested against real history.
            if (typeof M._flycast_set_idleskip === 'function') M._flycast_set_idleskip(1);
            let ran = 0;
            for (let i = 0; i < S.prerollWant; i++) {
              while (inflight()) await new Promise((r) => setTimeout(r, 4));
              M._emscripten_run_iter(); ran++;
            }
            while (inflight()) await new Promise((r) => setTimeout(r, 4));
            if (typeof M._flycast_set_idleskip === 'function') M._flycast_set_idleskip(${PREROLL_ISK_AFTER});
            S.preroll = { ok, ran, burns: (M._flycast_ctx_snapshot(90) >>> 0) - b0, idleskipAfter: ${PREROLL_ISK_AFTER} };
          } catch (e) { S.preroll = { ok: 0, err: String(e && e.message || e) }; }
          busy = false;
          orig.call(self, ev);
          while (q.length && !busy) orig.call(self, q.shift());
        })();
        return;
      }
      return orig.call(self, ev);
    };
    desc.set.call(self, wrapper);
    Object.defineProperty(self, 'onmessage', { configurable: true, get() { return inner; }, set(v) { inner = v; } });
  }
  return { ok: true };
})()`;
}

async function wEval(w, expr) {
  const r = await w.client.send('Runtime.evaluate', { expression: String(expr), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('worker threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result ? r.result.value : undefined;
}
const withTimeout = (p, ms, v) => Promise.race([p, sleep(ms).then(() => v)]);

// ---- players ---------------------------------------------------------------------
async function launch(role) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcsoak-${role}-`));
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
           '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--disk-cache-size=1', '--window-size=1280,800'],
  });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(browser, fileURLToPath(import.meta.url)); } catch (e) {}
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const P = { role, browser, page, dir, errors: [], log: [], worker: null, gov: { beats: 0, dropMs: 0, drops: 0, maxLag: 0, at: [], soakDropMs: 0, soakBeats: 0 } };
  page.on('pageerror', (e) => P.errors.push(String((e && e.message) || e).slice(0, 300)));
  page.on('console', (m) => {
    const t = m.text();
    // the heartbeat's governor term: guest ms the worker DROPPED (debt past its
    // repay cap) — time a console lost for good, per 2 s window
    const gv = /gov=drop(\d+)ms\/(\d+) lag(\d+)ms/.exec(t);
    if (gv) {
      P.gov.beats++; P.gov.dropMs += +gv[1]; P.gov.drops += +gv[2]; P.gov.maxLag = Math.max(P.gov.maxLag, +gv[3]);
      // when, against the soak's own clock (null = before the room ran), so a
      // drop at the room's start is told apart from one in the steady state
      if (+gv[1] > 0 && P.gov.at.length < 40) P.gov.at.push([SOAK_T0 ? +((Date.now() - SOAK_T0) / 1000).toFixed(1) : null, +gv[1]]);
      if (SOAK_T0) { P.gov.soakDropMs += +gv[1]; P.gov.soakBeats++; }
    }
    if (/desync|lockstep\] (ARMED|FRAME GATE|frame gate|⚠)|\[seed\]|\[vmu\]|normalize|watchdog|threw|REFUS|recover|setidleskip|idle-skip|\[shard\]|determinism|anchor frame|REFUSING|state saved|saveState|state load|stateLoaded|Save State|Load State/i.test(t) && P.log.length < 4000)
      P.log.push(((Date.now() - T0) / 1000).toFixed(1) + ' ' + t.slice(0, 400));
  });
  const mq = '/tmp/npdm/mqtt-5.3.4.min.js';
  if (!fs.existsSync(mq)) execSync(`mkdir -p /tmp/npdm && curl -sS -f -o ${mq} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
  await page.evaluateOnNewDocument(fs.readFileSync(mq, 'utf8'));
  await page.evaluateOnNewDocument(PRELOAD);
  return P;
}
async function prewarm(P) {
  await P.page.goto(BASE + '/dreamcast.html', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60; i++) {
    const ok = await P.page.evaluate(() => !!self.crossOriginIsolated).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}
async function findWorker(P, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const w of P.page.workers()) {
      if (!/flycast_worker\.js/.test(w.url())) continue;
      const ok = await withTimeout(wEval(w, '!!(self.Module && self.Module._emscripten_run_iter && self.Module._sh4_mem_read32)').catch(() => false), 3000, false);
      if (ok) return w;
    }
    await sleep(250);
  }
  return null;
}
const keyEv = (P, k, down) => P.page.evaluate((k, down) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true }));
}, k, down).catch(() => {});

// ---- run ---------------------------------------------------------------------------
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from({ length: 5 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');
let broker = null; const PS = [];
let exitCode = 0;
async function finish() {
  RESULT.uptimeEnd = uptime();
  RESULT.md5After = await servedMd5();
  RESULT.md5Stable = J(RESULT.md5After) === J(RESULT.md5Before);
  say('md5 after  ' + J(RESULT.md5After));
  say('md5 STABLE=' + RESULT.md5Stable + ' · ' + RESULT.uptimeEnd);
  for (const P of PS) RESULT[P.role + 'Log'] = P.log.slice(-400);
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(RESULT, null, 1));
  for (const P of PS) { try { await P.browser.close(); } catch (e) {} if (!KEEP_PROFILES) { try { fs.rmSync(P.dir, { recursive: true, force: true }); } catch (e) {} } }
  try { if (broker) await broker.close(); } catch (e) {}
  say('wrote ' + path.join(OUT, NAME + '.json'));
  logStream.end();
  setTimeout(() => process.exit(exitCode), 300);
}

try {
  say('uptime ' + RESULT.uptimeStart);
  RESULT.md5Before = await servedMd5();
  say('md5 before ' + J(RESULT.md5Before));
  broker = await startBroker({ port: 0 });
  const H = await launch('host'); PS.push(H);
  const G = await launch('joiner'); PS.push(G);
  RESULT.coi = { host: await prewarm(H), joiner: await prewarm(G) };
  const url = (role) => BASE + '/dreamcast.html?np=' + code + '&game=' + encodeURIComponent(GAME) +
    (role === 'host' ? '' : '&join=1') + '&signal=ws&wsbroker=' + encodeURIComponent(broker.url) +
    QBOTH + (role === 'host' ? QHOST : QJOIN);
  RESULT.urls = { host: url('host'), joiner: url('joiner') };
  say('host  ' + RESULT.urls.host);
  say('join  ' + RESULT.urls.joiner);
  await H.page.goto(url('host'), { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40 && broker.stats.clients < 1; i++) await sleep(250);
  await sleep(1500);
  await G.page.goto(url('joiner'), { waitUntil: 'domcontentloaded' });
  // Hook BOTH workers as early as they answer, so frame 0's hash is covered and
  // the joiner's preroll can intercept the seed.
  const hookP = (async () => {
    for (const P of PS) {
      P.worker = await findWorker(P, 240000);
      if (!P.worker) { say(`  ${P.role}: no flycast worker answered`); continue; }
      if (NOHOOK) { say(`  ${P.role}: worker found, NOT hooked (--nohook)`); continue; }
      const want = (P.role === 'joiner') ? PREROLL : 0;
      const r = await withTimeout(wEval(P.worker, workerHookSrc(want)).catch((e) => ({ ok: false, err: e.message })), 60000, { ok: false, err: 'timeout' });
      say(`  ${P.role}: worker hook ${J(r)}`);
    }
  })();
  let admitted = false;
  const tBoot = Date.now();
  let running = false, lastLog = 0, desyncAtStart = false;
  const st = () => Promise.all(PS.map((P) => P.page.evaluate(() => {
    const M = window.__soak; const e = M && M.engine;
    let rep = null; try { rep = e ? e.report() : null; } catch (x) {}
    const p = window.__dcProbe ? window.__dcProbe() : null;
    return { state: e ? e.state : null, frame: e ? e.frame : null, desyncs: M ? M.desyncs.length : 0,
             hashesCompared: rep ? rep.hashesCompared : null, lastAgreed: rep ? rep.lastAgreedFrame : null,
             guestX: p ? p.guestX : null, phase: p ? p.phase : null, fps: p ? p.fps : null };
  }).catch(() => null)));
  while (Date.now() - tBoot < BOOT_MS) {
    if (!admitted) {
      const btn = await H.page.$('#npApproveAllow').catch(() => null);
      if (btn) {
        try { await H.page.click('#npApproveAllow'); } catch (e) { await H.page.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); }).catch(() => {}); }
        admitted = true; say('  host pressed Allow');
      }
    }
    const s = await st();
    if (s.every((x) => x && (x.state === 'running' || x.state === 'stalled') && x.frame > 30)) { running = true; break; }
    // A desync BEFORE the soak is a RESULT, not a void: the engine stops the
    // room on its first mismatched fingerprint, which can be frame 0.
    if (s.some((x) => x && /desync/.test(String(x.state)))) { desyncAtStart = true; running = true; break; }
    // The worker's anchor guard (flycast_worker.js lsAnchorCheck) refusing to
    // run frame 0 is also a RESULT: the console that would have forked the room
    // was stopped instead. Give the other console a moment to report too.
    if (PS.some((P) => P.log.some((l) => /REFUSING frame/.test(l)))) {
      await sleep(5000);
      RESULT.refused = PS.map((P) => ({ role: P.role, line: P.log.find((l) => /REFUSING frame/.test(l)) || null }));
      desyncAtStart = true; running = true; break;
    }
    if (s.some((x) => x && /failed|ended/.test(String(x.state)))) break;
    if (Date.now() - lastLog > 15000) { lastLog = Date.now(); say('  waiting ' + J(s) + ' broker=' + J(broker.stats)); }
    await sleep(1000);
  }
  await hookP;
  RESULT.running = running;
  if (!running) {
    // Say WHY the room did not run: an engine that went to `failed` names it.
    RESULT.engineAtVoid = await Promise.all(PS.map((P) => P.page.evaluate(() => {
      const e = window.__soak && window.__soak.engine; let rep = null; try { rep = e ? e.report() : null; } catch (x) {}
      return e ? { state: e.state, error: e.error || (rep && rep.error) || null, frame: e.frame } : null;
    }).catch((x) => ({ err: x.message }))));
    say('ROOM NEVER RAN on both players — VOID · engines ' + J(RESULT.engineAtVoid));
    RESULT.verdict = 'VOID: room never ran'; exitCode = 3; await finish();
  }
  else {
    const hookState = async (P) => P.worker ? withTimeout(wEval(P.worker, 'self.__soak ? { base: self.__soak.base, cands: self.__soak.cands, err: self.__soak.err, preroll: self.__soak.preroll, queued: self.__soak.queued, n: self.__soak.rows.length } : null').catch((e) => ({ err: e.message })), 30000, null) : null;
    RESULT.hookAtStart = { host: await hookState(H), joiner: await hookState(G) };
    say('hooks at start ' + J(RESULT.hookAtStart));
    if (PREROLL > 0 && !(RESULT.hookAtStart.joiner && RESULT.hookAtStart.joiner.preroll && RESULT.hookAtStart.joiner.preroll.ran === PREROLL)) {
      say('PREROLL DID NOT HAPPEN (the hook missed the seed) — this control arm is VOID');
      RESULT.prerollVoid = true;
    }
    if (!H.worker) H.worker = await findWorker(H, 30000);
    if (!G.worker) G.worker = await findWorker(G, 30000);
    // ⚠ THE SOAK'S CLOCK IS THE HOST ENGINE'S FRAME NUMBER, READ ON THE PAGE —
    // NOT the worker's guest-cycle counter over CDP. Polling Runtime.evaluate
    // into the running emulator worker every 100 ms measured 0.69x -> 0.16x on
    // a solo core (the worker is interrupted for every evaluate), and a room
    // runs at the speed of its slowest peer. One lockstep frame = one
    // retro_run = one frame the game renders; PSO renders at 30/s (measured
    // here: 172 frames in 5.8 guest s), so --gfps 30. The true guest seconds
    // are recomputed at the end from the cycle counter in the hash rows.
    const cyc = (P) => withTimeout(wEval(P.worker, 'self.Module._flycast_guest_cycles()').catch(() => null), 20000, null);
    const c0 = await cyc(H);
    const hostFrame = () => H.page.evaluate(() => { const e = window.__soak && window.__soak.engine; return e ? e.frame : null; }).catch(() => null);
    const f0 = await hostFrame();
    const gsec = async () => { const f = await hostFrame(); return f == null ? null : (f - f0) / GFPS; };
    say(`ROOM RUNNING — soaking ${SOAK} guest s (wall cap ${MAXWALL} s)`);
    SOAK_T0 = Date.now();
    // ---- the input script: pseudo-random but reproducible; both players press ----
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const MOVES = ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'];
    const tW = Date.now();
    let nextShot = 0; const shotAt = [5, Math.floor(SOAK / 2), SOAK - 5];
    let g = 0, lastSay = 0, ended = null, steps = 0, lastG = -1, lastMove = Date.now();
    // ⚠ A hold must end when the room stops, or a FROZEN room (no throw, no
    // frames — the shipped PSO room's heap corruption does exactly that) hangs
    // the rig inside one key press forever. 60 s without a new frame returns,
    // and the main loop's 180 s detector then names it.
    const holdGuest = async (ms) => {
      const t = await gsec();
      let last = t, lastAt = Date.now();
      for (let i = 0; ; i++) {
        const n = await gsec();
        if (n == null || n - t >= ms / 1000) return;
        if (n !== last) { last = n; lastAt = Date.now(); } else if (Date.now() - lastAt > 60000) return;
        if (i > 4 && PS.some((P) => P.log.some((l) => /run_iter threw/.test(l)))) return;
        await sleep(150);
      }
    };
    if (desyncAtStart) { ended = RESULT.refused ? 'ANCHOR GUARD REFUSED frame 0' : 'ENGINE DESYNC before the soak began'; }
    while (!desyncAtStart) {
      g = await gsec();
      if (g == null) { ended = 'host page stopped answering'; break; }
      if (g !== lastG) { lastG = g; lastMove = Date.now(); }
      else if (Date.now() - lastMove > 180000) { ended = 'FROZEN: the room made no frame for 180 s wall at guest ' + g.toFixed(1) + ' s'; break; }
      if (g >= SOAK) break;
      if ((Date.now() - tW) / 1000 > MAXWALL) { ended = 'wall cap'; break; }
      const s = await st();
      const crash = PS.map((P) => P.log.find((l) => /run_iter threw/.test(l))).filter(Boolean);
      if (crash.length) { ended = 'CORE CRASH: ' + crash.map((l) => l.slice(0, 260)).join(' || '); RESULT.crash = crash; break; }
      if (s.some((x) => x && x.desyncs > 0)) { ended = 'ENGINE DESYNC'; break; }
      if (s.some((x) => x && /desync|failed|ended/.test(String(x.state)))) { ended = 'engine state ' + s.map((x) => x && x.state).join('/'); break; }
      if (SAVE_AT != null && !RESULT.savedAt && g >= SAVE_AT) {
        const r = await H.page.evaluate(() => { const b = document.getElementById('btnSave'); if (!b || b.disabled) return 'disabled'; b.click(); return 'clicked'; }).catch((e) => 'threw ' + e.message);
        RESULT.savedAt = { guestS: +g.toFixed(1), r };
        say(`  HOST pressed Save State at guest ${g.toFixed(1)} s: ${r}`);
      }
      if (LOAD_AT != null && !RESULT.loadedAt && g >= LOAD_AT) {
        const r = await H.page.evaluate(() => { const b = document.getElementById('btnLoad'); if (!b || b.disabled) return 'disabled'; b.click(); return 'clicked'; }).catch((e) => 'threw ' + e.message);
        RESULT.loadedAt = { guestS: +g.toFixed(1), r };
        say(`  HOST pressed Load State at guest ${g.toFixed(1)} s: ${r}`);
      }
      if (nextShot < shotAt.length && g >= shotAt[nextShot]) {
        const i = nextShot++;
        for (const P of PS) { const f = path.join(OUT, `${NAME}-${P.role}-${i}.png`); await P.page.screenshot({ path: f }).catch(() => {}); }
        say(`  shots #${i} at guest ${g.toFixed(1)} s`);
      }
      if (Date.now() - lastSay > 20000) {
        lastSay = Date.now();
        const l = os.loadavg()[0]; RESULT.loads.push(+l.toFixed(2));
        say(`  guest ${g.toFixed(1)} s · ${J(s.map((x) => x && { f: x.frame, st: x.state, hc: x.hashesCompared, gX: x.guestX && +x.guestX.toFixed(3) }))} · load ${l.toFixed(2)}`);
      }
      if (SCRIPT === 'walk') {
        // Host walks (port 0 drives the game); the joiner presses too (port 1) so
        // both players' bytes are live in every frame image.
        const k1 = MOVES[Math.floor(rand() * MOVES.length)];
        const k2 = MOVES[Math.floor(rand() * MOVES.length)];
        const dur = 300 + Math.floor(rand() * 1700);
        await keyEv(H, k1, true); await keyEv(G, k2, true);
        await holdGuest(dur);
        await keyEv(H, k1, false); await keyEv(G, k2, false);
        steps++;
        if (rand() < 0.25) { const b = rand() < 0.5 ? 'm' : 'k'; await keyEv(H, b, true); await keyEv(G, 'm', true); await holdGuest(120); await keyEv(H, b, false); await keyEv(G, 'm', false); }
        if (rand() < 0.15) await holdGuest(1000 + Math.floor(rand() * 2000));   // stand still: the frame-wait spin
      } else {
        await sleep(1000);
      }
    }
    RESULT.ended = ended; RESULT.guestS = g; RESULT.wallS = (Date.now() - tW) / 1000; RESULT.steps = steps;
    say(`soak over: ${ended || 'reached ' + SOAK + ' guest s'} · guest ${g && g.toFixed(1)} s in ${RESULT.wallS.toFixed(0)} wall s · ${steps} input steps`);
    // final shots on both
    for (const P of PS) await P.page.screenshot({ path: path.join(OUT, `${NAME}-${P.role}-end.png`) }).catch(() => {});
    // ---- collect ----
    const fin = await st();
    RESULT.final = fin;
    const rowsOf = async (P) => NOHOOK ? '{"rows":[]}' : withTimeout(wEval(P.worker, 'JSON.stringify({ rows: self.__soak.rows, err: self.__soak.err, base: self.__soak.base, verifyBad: self.__soak.verifyBad, hashMs: self.__soak.hashMs, hashN: self.__soak.hashN, preroll: self.__soak.preroll, cands: self.__soak.cands, starts: self.__soak.starts })').catch((e) => JSON.stringify({ err: e.message })), 60000, '{"err":"timeout"}');
    const RH = JSON.parse(await rowsOf(H)), RJ = JSON.parse(await rowsOf(G));
    const engine = await Promise.all(PS.map((P) => P.page.evaluate(() => {
      const M = window.__soak; const e = M && M.engine; let rep = null; try { rep = e ? e.report() : null; } catch (x) {}
      return { desyncs: M ? M.desyncs : null, error: e ? (e.error || null) : null, report: rep ? { state: rep.state, error: rep.error || null, frame: rep.frame, delay: rep.delay, desync: rep.desync, hashesCompared: rep.hashesCompared, hashesSent: rep.hashesSent, lastAgreedFrame: rep.lastAgreedFrame, stalls: rep.stalls, inputsSent: rep.inputsSent, inputsReceived: rep.inputsReceived,
                                 stallMs: rep.stallMs, maxStallMs: rep.maxStallMs, minLead: rep.minLead, meanLead: rep.meanLead, delayHistory: rep.delayHistory } : null,
               samples: M ? M.samples : [],
               probe: window.__dcProbe ? (({ guestX, fps, phase }) => ({ guestX, fps, phase }))(window.__dcProbe()) : null };
    }).catch((e) => ({ err: e.message }))));
    // ---- input lag + room speed (see header) ----
    const lagOf = (samples, starts) => {
      const st = new Map(); for (let i = 0; i + 1 < (starts || []).length; i += 2) st.set(starts[i], starts[i + 1]);
      const xs = [], byD = {};
      for (const sm of (samples || [])) { const t = st.get(sm.F); if (t == null || !(t > 0)) continue; const v = t - sm.t; xs.push(v); (byD[sm.d] = byD[sm.d] || []).push(v); }
      const q = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * p))].toFixed(1); };
      const sum = (a) => ({ n: a.length, mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null, p50: q(a, 0.5), p95: q(a, 0.95), max: q(a, 1) });
      const out = sum(xs); out.byDelay = {}; for (const k in byD) out.byDelay[k] = sum(byD[k]);
      return out;
    };
    const speedOf = (rows) => {
      const r = (rows || []).filter((x) => x.t > 0);
      if (r.length < 3) return null;
      const warm = r.findIndex((x) => (x.cyc - r[0].cyc) / 200e6 >= 5);
      const a = r[warm > 0 ? warm : 0], b = r[r.length - 1];
      if (!(b.t > a.t)) return null;
      return { speed: +(((b.cyc - a.cyc) / 200e6) / ((b.t - a.t) / 1000)).toFixed(4), guestS: +((b.cyc - a.cyc) / 200e6).toFixed(1), wallS: +((b.t - a.t) / 1000).toFixed(1), fromF: a.f, toF: b.f };
    };
    RESULT.inputLag = { host: lagOf(engine[0] && engine[0].samples, RH.starts), joiner: lagOf(engine[1] && engine[1].samples, RJ.starts) };
    RESULT.roomSpeed = { host: speedOf(RH.rows), joiner: speedOf(RJ.rows) };
    for (const e of engine) if (e) delete e.samples;
    say('INPUTLAG host ' + J(RESULT.inputLag.host) + ' · joiner ' + J(RESULT.inputLag.joiner));
    say('SPEED   host ' + J(RESULT.roomSpeed.host) + ' · joiner ' + J(RESULT.roomSpeed.joiner) + (OWD_MS || OWD_JIT ? ' · owd ' + OWD_MS + '+' + OWD_JIT + ' ms' : ''));
    RESULT.owd = { ms: OWD_MS, jitter: OWD_JIT };
    RESULT.gov = { host: H.gov, joiner: G.gov };
    say('GOV     host ' + J(H.gov) + ' · joiner ' + J(G.gov));
    RESULT.engine = { host: engine[0], joiner: engine[1] };
    for (const [k, e] of Object.entries(RESULT.engine)) for (const d of ((e && e.desyncs) || []).slice(0, 2))
      say(`DESYNC  ${k}: ${J(d).slice(0, 1600)}`);
    // ---- compare the RAM detector ----
    const byF = new Map(); for (const r of (RJ.rows || [])) byF.set(r.f, r);
    let compared = 0, ramBad = 0, wBad = 0, firstRam = null, firstW = null, nullRam = 0;
    for (const r of (RH.rows || [])) {
      const o = byF.get(r.f); if (!o) continue;
      if (r.ram == null || o.ram == null) { nullRam++; continue; }
      compared++;
      if (r.ram !== o.ram) { ramBad++; if (firstRam == null) firstRam = { f: r.f, host: r.ram, joiner: o.ram }; }
      if (r.h !== o.h) { wBad++; if (firstW == null) firstW = { f: r.f, host: r.w, joiner: o.w }; }
    }
    const hr = RH.rows || [];
    if (hr.length > 1 && c0 != null) RESULT.guestSecondsByCycles = +((hr[hr.length - 1].cyc - c0) / 200e6).toFixed(1);
    const burns = hr.length ? { first: hr[0].burns, last: hr[hr.length - 1].burns } : null;
    RESULT.ramDetector = { compared, ramMismatches: ramBad, fingerprintMismatches: wBad, firstRam, firstW, nullRam,
                           hostRows: hr.length, joinerRows: (RJ.rows || []).length, lastFrame: hr.length ? hr[hr.length - 1].f : null,
                           hostBase: RH.base, joinerBase: RJ.base, hostCands: RH.cands, joinerCands: RJ.cands,
                           verifyBad: { host: RH.verifyBad, joiner: RJ.verifyBad }, err: { host: RH.err, joiner: RJ.err },
                           hashMsMean: { host: RH.hashN ? +(RH.hashMs / RH.hashN).toFixed(2) : null, joiner: RJ.hashN ? +(RJ.hashMs / RJ.hashN).toFixed(2) : null },
                           hostIdleskipBurns: burns, joinerPreroll: RJ.preroll };
    say('ENGINE  host ' + J(RESULT.engine.host.report) + ' desyncEvents=' + (RESULT.engine.host.desyncs ? RESULT.engine.host.desyncs.length : '?'));
    say('ENGINE  join ' + J(RESULT.engine.joiner.report) + ' desyncEvents=' + (RESULT.engine.joiner.desyncs ? RESULT.engine.joiner.desyncs.length : '?'));
    say('RAM     ' + J(RESULT.ramDetector));
    const engDesync = (RESULT.engine.host.desyncs || []).length + (RESULT.engine.joiner.desyncs || []).length;
    const hc = Math.min((RESULT.engine.host.report || {}).hashesCompared || 0, (RESULT.engine.joiner.report || {}).hashesCompared || 0);
    const sound = (NOHOOK || NORAM || compared >= 10) && hc >= 10 && !RESULT.prerollVoid;
    // A divergence needs no minimum sample — one mismatch is a fork. "In sync"
    // does: it is only a claim over enough compared checkpoints.
    const forked = !RESULT.prerollVoid && (engDesync || ramBad || wBad);
    RESULT.verdict = (RESULT.refused && !forked) ? `REFUSED by the anchor guard, no fork: ${J(RESULT.refused.filter((x) => x.line).map((x) => x.role + ': ' + x.line.slice(0, 200)))}`
      : forked ? `DESYNC (engine events ${engDesync}, RAM mismatches ${ramBad}/${compared}, first RAM @f${firstRam ? firstRam.f : '-'}, fingerprint mismatches ${wBad})`
      : !sound ? `VOID (compared ram=${compared} engine=${hc}${RESULT.prerollVoid ? ', preroll missed' : ''})`
      : NORAM ? `IN SYNC over ${hc} engine fingerprints (--noram: no RAM detector), guest ${g && g.toFixed(1)} s`
      : `IN SYNC over ${compared} RAM checkpoints (to frame ${RESULT.ramDetector.lastFrame}) and ${hc} engine fingerprints, guest ${g && g.toFixed(1)} s`;
    say('VERDICT ' + RESULT.verdict);
    if (forked) exitCode = 1; else if (RESULT.refused) exitCode = 0; else if (!sound) exitCode = 3;
    for (const P of PS) if (P.errors.length) say(`  ${P.role} pageerrors: ${J(P.errors.slice(0, 5))}`);
    RESULT.pageErrors = { host: H.errors, joiner: G.errors };
    await finish();
  }
} catch (e) {
  say('RIG THREW: ' + (e && e.stack || e));
  RESULT.verdict = 'VOID: rig threw ' + (e && e.message);
  exitCode = 4;
  await finish();
}
