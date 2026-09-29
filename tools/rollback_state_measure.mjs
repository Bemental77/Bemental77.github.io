#!/usr/bin/env node
// CAN THIS CORE ROLL BACK? — the measurement that decides the rollback window.
//
// Rollback netplay applies the local pad on the frame it was pressed, PREDICTS
// the remote pad (repeat its last known value), keeps a savestate per frame,
// and — when the real remote pad arrives and differs from the guess — restores
// the earliest mispredicted frame and re-simulates to the present WITHOUT
// presenting. That is only possible if, for this core:
//   1. save + load are cheap enough to do every frame (size, save ms, load ms);
//   2. a frame runs well under 1/60 s, so up to W frames can be re-simulated
//      inside ONE display tick (frame ms -> the headroom that caps W);
//   3. a save -> load round trip is EXACT: a run with rollbacks must arrive at
//      the byte-identical state a straight run reaches. genesis_determinism_
//      probe.mjs's `rewind` arm reported a divergence for Genesis when the
//      snapshot was taken BEFORE THE FIRST FRAME; this asks the question
//      rollback actually needs (snapshots taken mid-run, every frame).
//
// THE EXACTNESS ARM (the gating one). Two fresh pages, same ROM, cold boot,
// the page's own rAF loop never started (no Start press; `__genFrames` /
// `__snesFrames` must stay 0 — asserted). Port 0 is "local", port 1 is
// "remote" with a scripted pad that changes every few frames.
//   REF  : straight run, the true pads, state hash after EVERY frame.
//   RB   : the rollback algorithm itself — port 1 is only KNOWN `lag` frames
//          late; until then it is predicted as its last known value; every
//          frame's pre-state is snapshotted into a ring; when a late input
//          disagrees with what was used, restore the snapshot of that frame and
//          re-simulate to the present. The state after frame k is hashed only
//          once frame k is CONFIRMED (all inputs <= k known and used).
//   PASS iff every confirmed RB hash equals REF's hash for that frame.
//
// Nothing here is paced: it measures CAPACITY (how fast the core can go), and
// the guest in the product is never run faster than 1.000x (CLAUDE.md gate 9).
//
// USAGE   npm run web   (then)
//   mkdir /tmp/bemental-probe.lock && node tools/rollback_state_measure.mjs; rmdir /tmp/bemental-probe.lock
// FLAGS   --cores genesis,snes   --frames 3000   --lag 6   --window 8   --warm 600
import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const CORES = flag('cores', 'genesis,snes').split(',');
const FRAMES = +flag('frames', 3000);
const LAG = +flag('lag', 6);
const WINDOW = +flag('window', 8);
const WARM = +flag('warm', 600);
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// One driver for both cores; `kind` picks the exports. Installed as source so
// it runs inside the page realm (snapshots never cross to Node).
const FAST = flag('fast', '1') !== '0';   // genesis: gpx_set_fast_savestates(1), when the build has it
// CANON=1: every frame is executed as load(S_k) -> run -> S_{k+1} = save(), on
// BOTH arms. See the header: that makes a frame a pure function of the blob,
// so a re-simulated frame is the same function as a first-time one.
const CANON = flag('canon', '1') !== '0';
const DRIVER = String(function installRbDriver(kind, fast, canon) {
  const M = () => window.Module;
  const G = kind === 'genesis';
  const fnv = (u8, h) => {
    h = h >>> 0;
    const n = u8.length >>> 2;
    if ((u8.byteOffset & 3) === 0) {
      const u32 = new Uint32Array(u8.buffer, u8.byteOffset, n);
      for (let i = 0; i < n; i++) { h ^= u32[i]; h = Math.imul(h, 16777619) >>> 0; }
    }
    for (let b = n << 2; b < u8.length; b++) { h ^= u8[b]; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  };
  // Scripted pads: port 0 = local, port 1 = remote. Remote changes every 5-9
  // frames so predictions fail often.
  const pad = (f, p) => {
    if (p === 0) return ((f >> 4) & 1 ? 0x80 : 0x40) | (((f % 31) === 0) ? 2 : 0) | (((f % 90) < 8) ? 0x800 : 0);
    const seg = Math.floor(f / 7);
    return [0, 0x10, 0x20, 0x40, 0x80, 0x02, 0x01, 0x42, 0x81][(seg * 5 + (seg >> 2)) % 9];
  };
  const D = window.__rb = {
    size: 0, ptr: 0,
    async load(url) {
      const r = await fetch(url); if (!r.ok) throw new Error('rom ' + r.status);
      const b = new Uint8Array(await r.arrayBuffer());
      if (G) {
        const p = M()._gpx_alloc(b.length); M().HEAPU8.set(b, p);
        const s2h = (s) => { const e = new TextEncoder().encode(s); const q = M()._gpx_alloc(e.length + 1); M().HEAPU8.set(e, q); M().HEAPU8[q + e.length] = 0; return q; };
        const n = s2h('rbrom'), e = s2h('gen');
        const ok = M()._gpx_load(p, b.length, n, e);
        M()._gpx_free(p); M()._gpx_free(n); M()._gpx_free(e);
        if (!ok) throw new Error('core refused rom');
        this.size = M()._gpx_state_size() >>> 0;
        this.fastStates = (typeof M()._gpx_set_fast_savestates === 'function') ? (M()._gpx_set_fast_savestates(fast ? 1 : 0), !!fast) : 'not in this build';
      } else {
        const p = M()._my_malloc(b.length); M().HEAPU8.set(b, p);
        M()._startWithRom(p, b.length, 36000); M()._my_free(p);
        this.size = M()._getStateSaveSize() >>> 0;
      }
      this.ptr = G ? M()._gpx_alloc(this.size) : M()._my_malloc(this.size);
      return { romBytes: b.length, stateSize: this.size, fastStates: this.fastStates == null ? null : this.fastStates };
    },
    setPads(f, p0, p1) {
      if (G) { M()._gpx_set_pad(0, p0); M()._gpx_set_pad(1, p1); }
      else { M()._setJoypadInputPort(0, p0); M()._setJoypadInputPort(1, p1); }
    },
    step() { if (G) M()._gpx_run(); else M()._mainLoop(); },
    // save into a JS-owned copy (what a ring slot holds)
    save() {
      if (G) {
        if (!M()._gpx_state_save(this.ptr, this.size)) return null;
        return new Uint8Array(M().HEAPU8.buffer, this.ptr, this.size).slice();
      }
      const q = M()._saveState(); if (!q) return null;
      const out = new Uint8Array(M().HEAPU8.buffer, q, this.size).slice();
      M()._my_free(q); return out;
    },
    loadFrom(u8) {
      M().HEAPU8.set(u8, this.ptr);
      return G ? !!M()._gpx_state_load(this.ptr, this.size) : !!M()._loadState(this.ptr, this.size);
    },
    hashNow() { const s = this.save(); return s ? fnv(s, 0x811c9dc5) : null; },
    hashOf(u8) { return fnv(u8, 0x811c9dc5); },
    warm(n) { for (let f = 0; f < n; f++) { this.setPads(f, pad(f, 0), pad(f, 1)); this.step(); } },
    pageFrames() { return (window.__genFrames | 0) + (window.__snesFrames | 0); },

    // ---- costs ----
    timings(n) {
      const t = (fn) => { const a = performance.now(); fn(); return performance.now() - a; };
      const fr = [], sv = [], ld = [], hs = [];
      let snap = null;
      for (let i = 0; i < n; i++) {
        this.setPads(i, pad(i, 0), pad(i, 1));
        fr.push(t(() => this.step()));
        sv.push(t(() => { snap = this.save(); }));
        hs.push(t(() => this.hashOf(snap)));
      }
      for (let i = 0; i < n; i++) ld.push(t(() => this.loadFrom(snap)));
      // batch timing too: performance.now() resolution under cross-origin
      // isolation is ~5 us, fine for these magnitudes but batch is the check.
      const b0 = performance.now(); for (let i = 0; i < n; i++) this.step(); const batch = (performance.now() - b0) / n;
      // THE CANONICAL STEP AS THE PAGE RUNS IT — ring slots live in the wasm heap
      // (no JS copy): load(slot k) -> run -> save(slot k+1). Genesis saves
      // straight into a slot; SNES's saveState() callocs its own buffer, so
      // its slot IS that pointer (freed when the ring evicts it).
      const cs = [], csSkip = [];
      if (G) {
        const a = M()._gpx_alloc(this.size), b = M()._gpx_alloc(this.size);
        M().HEAPU8.fill(0, a, a + this.size); M().HEAPU8.fill(0, b, b + this.size);
        M()._gpx_state_save(a, this.size);
        let src = a, dst = b;
        for (let pass = 0; pass < 2; pass++) {
          const skip = pass === 1 && typeof M()._gpx_set_video_skip === 'function';
          if (skip) M()._gpx_set_video_skip(1);
          for (let i = 0; i < n; i++) {
            const t0 = performance.now();
            M()._gpx_state_load(src, this.size);
            this.setPads(i, pad(i, 0), pad(i, 1)); this.step();
            M()._gpx_state_save(dst, this.size);
            (pass ? csSkip : cs).push(performance.now() - t0);
            const x = src; src = dst; dst = x;
          }
          if (skip) M()._gpx_set_video_skip(0);
        }
        M()._gpx_free(a); M()._gpx_free(b);
      } else {
        let src = M()._saveState();
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          M()._loadState(src, this.size);
          this.setPads(i, pad(i, 0), pad(i, 1)); this.step();
          const dst = M()._saveState();
          cs.push(performance.now() - t0);
          M()._my_free(src); src = dst;
        }
        M()._my_free(src);
      }
      const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4); };
      const pack = (a) => ({ p50: q(a, 0.5), p90: q(a, 0.9), p99: q(a, 0.99), max: q(a, 1) });
      return { frameMs: pack(fr), frameBatchMs: +batch.toFixed(4), saveMs: pack(sv), loadMs: pack(ld), hashMs: pack(hs),
               canonStepMs: pack(cs), canonStepNoVideoMs: csSkip.length ? pack(csSkip) : null };
    },

    // ---- REF: straight run with the true pads ----
    ref(f0, n) {
      const h = [];
      let cur = this.save();
      for (let f = f0; f < f0 + n; f++) {
        if (canon) this.loadFrom(cur);
        this.setPads(f, pad(f, 0), pad(f, 1)); this.step();
        cur = this.save(); h.push(this.hashOf(cur));
      }
      return h;
    },

    // ---- RB: the rollback algorithm, remote known `lag` frames late ----
    rb(f0, n, lag, W) {
      const ring = new Map();          // frame -> state BEFORE that frame
      const used = new Map();          // frame -> remote pad used
      const known = new Map();         // frame -> true remote pad (arrived)
      let lastKnownF = f0 - 1, lastKnownV = pad(f0 - 1, 1);   // at f0 both agree (warm used the truth)
      const hashes = new Map();        // confirmed frame -> hash of state after it
      let confirmed = f0 - 1;          // all frames <= this are known AND simulated with the truth
      let rollbacks = 0, resim = 0, maxDepth = 0, stalls = 0, loadFail = 0;
      const predict = (k) => { let v = null, best = -1; for (const [kf, kv] of known) if (kf < k && kf > best) { best = kf; v = kv; } return best >= 0 ? v : lastKnownV; };
      const remoteFor = (k) => known.has(k) ? known.get(k) : predict(k);
      let cur = this.save();
      const runOne = (k) => {
        const v = remoteFor(k); ring.set(k, cur); used.set(k, v);
        if (canon) this.loadFrom(cur);
        this.setPads(k, pad(k, 0), v); this.step(); cur = this.save();
      };
      let f = f0;
      const tStart = performance.now();
      while (f < f0 + n) {
        // the remote input for frame f-lag arrives now
        const a = f - lag;
        if (a >= f0) known.set(a, pad(a, 1));
        // earliest mispredicted frame
        let from = Infinity;
        for (const [k, v] of used) if (known.has(k) && known.get(k) !== v && k < from) from = k;
        if (from !== Infinity) {
          const depth = f - from;
          if (depth > W) throw new Error('rollback deeper than the window: ' + depth);
          cur = ring.get(from);
          if (!canon && !this.loadFrom(cur)) loadFail++;
          rollbacks++; if (depth > maxDepth) maxDepth = depth;
          for (let k = from; k < f; k++) { runOne(k); resim++; }
        }
        // advance `confirmed` and hash the newly-confirmed frames (state after k = ring[k+1] or live)
        while (confirmed + 2 < f && known.has(confirmed + 1) && used.get(confirmed + 1) === known.get(confirmed + 1)) {
          confirmed++;
          const after = ring.get(confirmed + 1) || (confirmed + 1 === f ? cur : null);
          if (after) hashes.set(confirmed, this.hashOf(after));
        }
        // window cap: never run more than W frames past the last confirmed one
        if (f - confirmed > W) { stalls++; continue; }
        runOne(f); f++;
        for (const k of Array.from(ring.keys())) if (k < f - W - 2) { ring.delete(k); used.delete(k); known.delete(k); }
      }
      return { hashes: Array.from(hashes.entries()), rollbacks, resim, maxDepth, stalls, loadFail,
               ms: performance.now() - tStart };
    },
  };
  return 'ok';
});

const PAGES = {
  genesis: { page: '/genesis.html', ready: () => !!(window.Module && typeof window.Module._gpx_run === 'function'),
             rom: '/genesis/genesisWasm/roms/Sonic the Hedgehog 3 (USA).gen' },
  snes: { page: '/snes.html', ready: () => !!(window.Module && typeof window.Module._mainLoop === 'function' && window.Module.HEAPU8),
          rom: '/snes/snesWasm/roms/simcity.smc' },
};

const out = { when: new Date().toISOString(), load: '', frames: FRAMES, lag: LAG, window: WINDOW, canon: CANON, fast: FAST, cores: {} };
try { out.load = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) {}
console.log('load: ' + out.load);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'] });
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'rollback_state_measure'); } catch (_e) {}
try {
  for (const kind of CORES) {
    const P = PAGES[kind];
    const open = async () => {
      const pg = await browser.newPage();
      await pg.goto(BASE + P.page, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pg.waitForFunction(P.ready, { timeout: 120000, polling: 200 });
      await pg.evaluate(DRIVER + '; installRbDriver(' + JSON.stringify(kind) + ',' + FAST + ',' + CANON + ');');
      return pg;
    };
    const [A, B] = [await open(), await open()];
    const info = await A.evaluate((u) => window.__rb.load(u), P.rom);
    await B.evaluate((u) => window.__rb.load(u), P.rom);
    await A.evaluate((n) => window.__rb.warm(n), WARM);
    await B.evaluate((n) => window.__rb.warm(n), WARM);
    const h0 = await Promise.all([A, B].map((p) => p.evaluate(() => window.__rb.hashNow())));
    const ref = await A.evaluate((f0, n) => window.__rb.ref(f0, n), WARM, FRAMES);
    const rb = await B.evaluate((f0, n, l, w) => window.__rb.rb(f0, n, l, w), WARM, FRAMES, LAG, WINDOW);
    let cmp = 0, bad = 0, firstBad = null;
    for (const [k, h] of rb.hashes) { cmp++; if (ref[k - WARM] !== h) { bad++; if (firstBad == null) firstBad = k; } }
    // costs measured on a THIRD pass of page A (it is past the exactness run)
    const t = await A.evaluate(() => window.__rb.timings(400));
    const pf = await Promise.all([A, B].map((p) => p.evaluate(() => window.__rb.pageFrames())));
    const r = {
      stateBytes: info.stateSize, romBytes: info.romBytes, fastSavestates: info.fastStates, ...t,
      exact: { startHashesAgree: h0[0] === h0[1], compared: cmp, mismatched: bad, firstMismatchFrame: firstBad,
               rollbacks: rb.rollbacks, resimFrames: rb.resim, maxDepth: rb.maxDepth, windowStalls: rb.stalls,
               loadFailures: rb.loadFail, rbRunMs: Math.round(rb.ms) },
      pageFramesMustBe0: pf,
    };
    // Budget at 60 Hz: one tick has to fit W re-simulated frames (each with a
    // save), one load, and the presented frame (with a save).
    const tick = 1000 / 60;
    // A rollback tick = d re-simulated canonical steps (video skipped when the
    // build can) + the presented canonical step. W = the largest d that fits.
    const resim = r.canonStepNoVideoMs || r.canonStepMs;
    r.maxWindowAt60Hz_p50 = Math.floor((tick - r.canonStepMs.p50) / resim.p50);
    r.maxWindowAt60Hz_p90 = Math.floor((tick - r.canonStepMs.p90) / resim.p90);
    out.cores[kind] = r;
    console.log('\n=== ' + kind + ' ===');
    console.log(JSON.stringify(r, null, 1));
    console.log((bad === 0 && cmp > 0 && pf.every((x) => x === 0))
      ? `EXACT: ${cmp} confirmed frames after ${rb.rollbacks} rollbacks / ${rb.resim} re-simulated frames match the straight run byte-for-byte`
      : `NOT EXACT: ${bad}/${cmp} confirmed frames differ (first at ${firstBad}); page frames ${pf}`);
    await A.close(); await B.close();
  }
} finally {
  try { await browser.close(); } catch (e) {}
}
try { out.loadAfter = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) {}
console.log('load after: ' + out.loadAfter);
const fs = await import('fs');
fs.writeFileSync('/tmp/rollback-state-measure.json', JSON.stringify(out, null, 1));
