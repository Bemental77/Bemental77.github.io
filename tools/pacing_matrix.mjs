// tools/pacing_matrix.mjs — the standing FRAME-PACING gate for the three
// emulator pages (gamecube.html, dreamcast.html, n64/index.html).
//
//   npm run web                            # serve on :8080 first (CLAUDE.md gate #2)
//   node tools/pacing_matrix.mjs
//   node tools/pacing_matrix.mjs --page=gamecube --scene=steady
//   node tools/pacing_matrix.mjs --json > /tmp/pacing.json
//
// ============================================================================
// WHY THIS EXISTS: MEAN FPS CANNOT ANSWER THE QUESTION THAT WAS ASKED
// ============================================================================
// The bar is "60fps or faster flawlessly — no skipping, no lag, no issues
// whatsoever." Every instrument this project has built measures a MEAN: a 1 Hz
// counter delta (gamecube.html:4910 _rateTick, dreamcast.html:1879 the 'fps'
// message, n64/index.html:1841 paintRate). A mean cannot see a hitch. One
// 2.8-second stall inside a 25-second window moves a 60/s mean to 57/s — which
// reads as a pass — and is the single most obvious defect a human can perceive.
//
// "No skipping, no lag" is a statement about the TAIL of a distribution. So
// this rig reports p50/p95/p99/max frame-to-frame interval, the drop and dupe
// counts, and a hitch census with attribution. It deliberately does NOT print a
// mean fps as a verdict, because that is the number that hid the problem.
//
// ============================================================================
// GATE #9 IS STRUCTURAL HERE, NOT A FOOTNOTE
// ============================================================================
// At 1.000x only `nativeHz` distinct frames per second EXIST. Dreamcast PSO and
// GameCube PSO are 30 Hz titles; MP4, SAB and most N64 carts are 60 Hz. So the
// TARGET for a page is the title's own rate, and "30 presents, flat" is a PASS
// for a 30 Hz title, not a 50% failure. Every verdict below is computed against
// `nativeHz`, and the rig refuses to score a page whose nativeHz it could not
// establish from the page's own meter (VOID, no verdict).
//
// ============================================================================
// FOUR RIG BUGS THIS IS BUILT TO DESIGN OUT
// ============================================================================
// BUG 1 — A WEDGED RUN STILL SCREENSHOTS THE LIVE SCENE, and a rig that samples
//   a counter which does not have to advance will happily report a beautiful
//   distribution of zero events. Every cell here requires a MONOTONIC counter to
//   advance (`liveness`), and requires a minimum event count, or it is VOID.
//
// BUG 2 — THE INSTRUMENT IS THE HITCH. A per-frame hook that allocates, or a
//   PerformanceObserver whose queue is drained on the measured thread, perturbs
//   exactly the tail it is measuring. So: every ring is PREALLOCATED
//   (Float64Array, no push, no GC), the hook is two stores, and the rig runs a
//   PERTURBATION PAIR — the same scene instrumented and uninstrumented — and
//   requires the page's OWN 1 Hz meter to agree across the pair. If it does not,
//   the numbers are reported as PERTURBED and carry no verdict.
//   (CLAUDE.md gate #10: never compare a profiled run to an unprofiled one.
//   Here the profiled/unprofiled pair is the CONTROL, not the comparison.)
//
// BUG 3 — rAF IS NOT ONE TICK PER FRAME. All three pages register several rAF
//   callbacks (gamecube.html:5171 _sabPresentTick, :6002 pollGamepads, :6743
//   grantLoop). They all receive the SAME timestamp argument. Counting callbacks
//   gives you the number of registered loops, not the refresh rate. The first
//   cut of this rig measured "rAF p50 = 0.00ms => host refresh ~InfinityHz",
//   which is that bug in its purest form. Every rAF-derived series here is
//   DEDUPED BY THE CALLBACK TIMESTAMP. n64/index.html:1776 has this bug live —
//   `rafTicks++` is outside the `t !== lastPaceT` dedupe at :1782 — so the
//   page's own `shown` over-counts presents whenever a second rAF loop is
//   registered. That is reported, not worked around.
//
// BUG 4 — TWO PAGES CANNOT BE MEASURED THE SAME WAY, AND PRETENDING OTHERWISE
//   MANUFACTURES A NUMBER. gamecube.html presents on the MAIN THREAD
//   (:5157 putImageData, gated by the seqlock at :5121-5139, so one call == one
//   distinct untorn frame) and n64 runs its core on the main thread from
//   Emscripten's rAF scheduler. dreamcast.html PRESENTS NOWHERE ON THE PAGE:
//   the canvas is transferred at :2003 and the worker owns it. Worse — see
//   INSTRUMENT C below — the call the page's own comment names as the present
//   is a NO-OP in the shipped build. So Dreamcast gets a different instrument
//   (the browser compositor), and that instrument is CROSS-VALIDATED on
//   GameCube, where an independent page-side ground truth exists, before it is
//   trusted anywhere.
//
// ============================================================================
// THE THREE INSTRUMENTS
// ============================================================================
// A. PAGE-SIDE PRESENT RING (gamecube, n64) — exact, ~2 stores per frame.
//    gamecube: CanvasRenderingContext2D.prototype.putImageData is wrapped.
//      gamecube.html:5157 is reached ONLY after the seqlock says the frame is
//      new (:5122) and untorn (:5139), so one call is one distinct present.
//      This needs no page edit and cannot be inflated by a repeat.
//    n64: the core runs one mainLoop per rAF tick (mymain.cpp:741, cited at
//      n64/index.html:374). A DISTINCT frame happened iff the core's own VI
//      counter `Module._neil_vi_total()` advanced. So the rig timestamps
//      deduped rAF ticks and splits them into "carried a new guest frame" and
//      "did not" — the second class IS the duplicate/re-present count.
//
// B. LONG ANIMATION FRAME (all three) — the attribution instrument.
//    PerformanceObserver('long-animation-frame') gives duration,
//    blockingDuration and per-script attribution. This is what turns "there was
//    a 2.8 s hitch" into "there was a 2.8 s hitch and here is the script".
//    It is main-thread only, which is stated per page rather than assumed away.
//
// C. THE COMPOSITOR (dreamcast, and the cross-check for gamecube) — CDP
//    tracing, `PipelineReporter` events, whose `frame_reporter.state` is
//    Chrome's OWN presented/dropped accounting
//    (STATE_PRESENTED_ALL / STATE_PRESENTED_PARTIAL / STATE_DROPPED /
//    STATE_NO_UPDATE_DESIRED) plus `affects_smoothness`.
//
//    WHY DREAMCAST NEEDS THIS. dreamcast.html:2888-2891 states presents are
//    driven by guest frame production because "video_cb calls
//    emscripten_webgl_commit_frame()". MEASURED IN THE SHIPPED BUILD, that call
//    is a NO-OP. In dreamcast/flycast_libretro/flycast_worker_emcc.js the wasm
//    import is `_emscripten_webgl_commit_frame = _emscripten_webgl_do_commit_frame`,
//    and that function's entire body is two guard returns and the comment
//    "We would do GL.currentContext.GLctx.commit(); here, but the current
//    implementation in browsers has removed it - swap is implicit, so this
//    function is a no-op for now". The only real `GLctx.commit()` in the file is
//    inside a `registerPreMainLoop` hook guarded on `!explicitSwapControl`,
//    and EmscriptenWorker.cpp:1129 says this context uses explicit control.
//    So the Dreamcast swap is IMPLICIT — the browser presents the worker's
//    OffscreenCanvas on its own schedule — and no page-side or worker-side JS
//    hook can observe it. Only the compositor can.
//
// ============================================================================
// WHAT THIS RIG CANNOT DO — stated, not papered over
// ============================================================================
// Headless Chrome composites against a synthetic BeginFrame source, not a real
// panel's vblank. Present INTERVALS produced by the page's own code (instrument
// A) are real — they are wall-clock stamps taken by the page. Compositor
// numbers (instrument C) are Chrome's accounting against that synthetic vsync
// and are reported as such. `--headful` runs against the real display and is
// what the user's own metric refers to; both are supported and the mode is
// printed with every number, because they are not interchangeable.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.PACING_BASE || 'http://localhost:8080';
const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY_PAGE = argOf('page', null);
const ONLY_SCENE = argOf('scene', null);
const JSON_ONLY = argv.includes('--json');
const HEADFUL = argv.includes('--headful');
const NO_PAIR = argv.includes('--no-perturbation-pair');
const MEASURE_MS = parseInt(argOf('ms', '30000'), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// INSTRUMENT A + B — injected into every page before any of its own script runs.
// Preallocated rings only. No allocation on the hot path.
// ---------------------------------------------------------------------------
function instrument() {
  const CAP = 300000;
  const P = window.__pace = {
    ver: 1,
    // present stamps (page-side), and the parallel "did a new guest frame ride
    // on this one" flag. `novel` is 1 for a distinct frame, 0 for a re-present.
    t: new Float64Array(CAP), novel: new Uint8Array(CAP), n: 0,
    // deduped rAF ticks: the host refresh series. See BUG 3.
    raf: new Float64Array(CAP), rn: 0, _lastRafT: -1,
    loaf: [], loafErr: null, longtask: [],
    marks: [],           // {t, label} — scene boundaries pushed by the rig
    hooked: null,
  };
  const push = (t, novel) => { if (P.n < CAP) { P.t[P.n] = t; P.novel[P.n] = novel ? 1 : 0; P.n++; } };
  P.push = push;

  // ---- A(gamecube): the 2D present. gamecube.html:5157. ----
  try {
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.putImageData;
    proto.putImageData = function (...a) {
      const r = orig.apply(this, a);
      push(performance.now(), 1);          // reached only on a new, untorn frame
      P.hooked = 'putImageData';           // set on FIRE, not on install: every page
      return r;                            // has a 2D context prototype, only one uses it
    };
    P.installed = 'putImageData';
  } catch (e) { P.hookErr = String(e); }

  // ---- the deduped rAF series (all pages). See BUG 3. ----
  // This is ALSO n64's present hook. n64 has no putImageData and no worker: the
  // core runs one mainLoop per rAF tick (mymain.cpp:741, cited at
  // n64/index.html:374), so the rAF tick IS the present, and the tick carried a
  // DISTINCT guest frame iff the core's own VI counter advanced —
  // `Module._neil_vi_total()`, which n64/index.html:496-500 calls "THE
  // AUTHORITY". Reading it after `cb` runs is what makes the novelty flag mean
  // "this tick produced a frame", not "a frame existed before this tick".
  let vi0 = -1;
  try {
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return orig(function (t) {
        const first = (t !== P._lastRafT);
        if (first) { P._lastRafT = t; if (P.rn < CAP) P.raf[P.rn++] = performance.now(); }
        const r = cb(t);
        if (first) {
          const M = window.Module;
          if (M && typeof M._neil_vi_total === 'function') {
            let vi = -1;
            try { vi = M._neil_vi_total() >>> 0; } catch (e) { vi = -1; }
            if (vi >= 0) {
              if (vi0 < 0) vi0 = vi;
              else { push(performance.now(), vi !== vi0); vi0 = vi; }
              P.hooked = 'rAF+_neil_vi_total';
            }
          }
        }
        return r;
      });
    };
  } catch (e) { P.rafErr = String(e); }

  // ---- B: long animation frames + long tasks. ----
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (P.loaf.length >= 4000) break;
        P.loaf.push({
          t: e.startTime, d: e.duration, b: e.blockingDuration || 0,
          rs: (e.renderStart || 0) - e.startTime,
          sl: (e.styleAndLayoutStart || 0) - e.startTime,
          s: (e.scripts || []).map((s) => ({
            n: s.name, i: s.invoker, it: s.invokerType, d: s.duration,
            src: String(s.sourceURL || '').slice(-56),
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { P.loafErr = String(e); }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (P.longtask.length >= 4000) break;
        P.longtask.push({ t: e.startTime, d: e.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { P.ltErr = String(e); }
}

// ---------------------------------------------------------------------------
// STATISTICS. Deliberately no mean-as-verdict.
// ---------------------------------------------------------------------------
// `targetMs` is the NOMINAL period. `refMs` — what a missed slot is counted
// against — defaults to the OBSERVED median instead, and that distinction is
// load-bearing. SM64 renders ~24 distinct frames/s at 1.000x guest speed on real
// hardware too, so its presents land every 2 or 3 refreshes and scoring them
// against a nominal 60 Hz reports ~50% "missed" frames that do not exist. A
// skipped beat is a gap of 2x THE CADENCE THE CONTENT IS ACTUALLY RUNNING AT.
// The separate question — is the content running at the rate it should? — is not
// this function's job; it is answered by produced-vs-presented in `judge`.
function distribution(stamps, targetMs, refMs) {
  if (!stamps || stamps.length < 3) return null;
  const iv = [];
  for (let i = 1; i < stamps.length; i++) iv.push(stamps[i] - stamps[i - 1]);
  const s = iv.slice().sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * f)))];
  const sum = iv.reduce((a, b) => a + b, 0);
  const ref = refMs || q(0.5);
  // A "missed slot" is a gap that swallowed whole target periods. floor(iv/target)-1
  // counts the frames that COULD have been shown in the gap and were not. It is a
  // floor, not an estimate: a 2.5-period gap counts 1, never 1.5.
  let missed = 0, hitches = [];
  for (let i = 0; i < iv.length; i++) {
    const k = Math.floor(iv[i] / ref + 1e-9);
    if (k >= 2) { missed += (k - 1); hitches.push({ at: stamps[i], ms: iv[i], periods: k }); }
  }
  hitches.sort((a, b) => b.ms - a.ms);
  return {
    n: iv.length, spanMs: +(stamps[stamps.length - 1] - stamps[0]).toFixed(1),
    p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2),
    max: +s[s.length - 1].toFixed(2), min: +s[0].toFixed(2),
    meanMs: +(sum / iv.length).toFixed(3),
    meanRate: +(1000 / (sum / iv.length)).toFixed(2),
    // The jitter number a human actually feels: how far the 99th percentile sits
    // above the median period. 1.0 = perfectly flat.
    p99OverP50: +(q(0.99) / q(0.5)).toFixed(2),
    refMs: +ref.toFixed(2),
    missedSlots: missed,
    hitchCount: hitches.length,
    hitches: hitches.slice(0, 25),
  };
}

// Attribute a hitch to the LoAF that overlaps it, and name the worst script.
function attribute(hitches, loaf) {
  const out = [];
  for (const h of hitches) {
    const start = h.at - h.ms;                       // the interval opened here
    let best = null;
    for (const e of loaf) {
      const eEnd = e.t + e.d;
      if (eEnd > start - 2 && e.t < h.at + 2) { if (!best || e.d > best.d) best = e; }
    }
    let why = 'no long-animation-frame overlapped this gap';
    let cls = 'unattributed';
    if (best) {
      const sc = (best.s || []).slice().sort((a, b) => b.d - a.d)[0];
      cls = sc ? 'script' : (best.rs > best.d * 0.5 ? 'render' : 'main-thread-task');
      why = `LoAF ${best.d.toFixed(1)}ms (blocking ${best.b.toFixed(1)}ms)`
          + (sc ? ` — ${sc.it || sc.i || '?'} ${sc.n || ''} ${sc.src ? '@' + sc.src : ''} ${sc.d.toFixed(1)}ms` : ' — no script attribution');
    }
    out.push({ ms: +h.ms.toFixed(1), periods: h.periods, at: +h.at.toFixed(0), cls, why });
  }
  return out;
}

// ---------------------------------------------------------------------------
// COMPOSITOR (INSTRUMENT C). Chrome's own presented/dropped accounting.
// ---------------------------------------------------------------------------
function compositorStats(tracePath) {
  let evs;
  try {
    const j = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    evs = j.traceEvents || j;
  } catch (e) { return { error: 'trace unreadable: ' + String(e).slice(0, 120) }; }
  // THE PRESENT-TO-SCREEN EVENT. `SkiaRenderer::SwapBuffers` is emitted in the
  // viz/GPU process once per composited frame that actually reaches the display,
  // which is the ONLY event that sees a frame drawn by a worker-owned
  // OffscreenCanvas. PipelineReporter, below, lives on the RENDERER's layer tree
  // and reported `presented: 0, STATE_NO_UPDATE_DESIRED: 1415` for a Dreamcast
  // run that was visibly rendering PSO at 30 fps — correct about the main thread,
  // blind to the worker's canvas, and catastrophic if mistaken for a present
  // count. This series is CROSS-VALIDATED against gamecube.html's page-side
  // putImageData ground truth before it is trusted; see `crossValidation` below.
  const swaps = evs.filter((e) => e.name === 'SkiaRenderer::SwapBuffers' && typeof e.ts === 'number')
                   .map((e) => e.ts / 1000).sort((a, b) => a - b);
  // PipelineReporter 'b' events carry frame_reporter.state. Keep only the
  // renderer whose layer tree actually animates (the busiest one) — a browser
  // UI layer tree also reports, and mixing them invents drops.
  const byHost = new Map();
  for (const e of evs) {
    if (e.name !== 'PipelineReporter' || e.ph !== 'b') continue;
    const fr = e.args && e.args.frame_reporter;
    if (!fr) continue;
    const k = String(fr.layer_tree_host_id);
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k).push({ ts: e.ts / 1000, state: fr.state, smooth: !!fr.affects_smoothness });
  }
  if (!byHost.size) return { error: 'no PipelineReporter events in trace' };
  let host = null, bestScore = -1;
  for (const [k, v] of byHost) {
    const score = v.filter((x) => x.smooth).length;
    if (score > bestScore) { bestScore = score; host = k; }
  }
  const rows = byHost.get(host).sort((a, b) => a.ts - b.ts);
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const presented = rows.filter((r) => r.state === 'STATE_PRESENTED_ALL' || r.state === 'STATE_PRESENTED_PARTIAL');
  const droppedSmooth = rows.filter((r) => r.state === 'STATE_DROPPED' && r.smooth).length;
  const stamps = presented.map((r) => r.ts);
  return {
    swapStamps: swaps, swaps: swaps.length,
    layerTreeHostId: host, layerTrees: byHost.size,
    states: counts, presented: presented.length,
    droppedAffectingSmoothness: droppedSmooth,
    // Chrome's own "percent dropped frames" denominator excludes frames where
    // nothing wanted to update, which is the honest denominator for a 30 Hz
    // title on a 60 Hz compositor.
    pctDroppedOfWanted: (presented.length + droppedSmooth) > 0
      ? +(100 * droppedSmooth / (presented.length + droppedSmooth)).toFixed(2) : null,
    stamps,
  };
}

// ---------------------------------------------------------------------------
// PAGE ADAPTERS. Each one knows how to boot its page, what its native rate is,
// and how to read the page's OWN meter (used for liveness and for the
// perturbation control — never as the headline).
// ---------------------------------------------------------------------------
const PAGES = {
  gamecube: {
    id: 'gamecube',
    url: (q) => `/gamecube.html?v=${Date.now()}${q ? '&' + q : ''}`,
    presentSource: 'page (putImageData @ gamecube.html:5157, seqlock-gated :5121-5139)',
    // `published` = distinct frames the renderer FINISHED, read straight off the
    // seqlock (gamecube.html:4928-4932). This is the denominator for "did every
    // frame the guest made reach the screen?"
    producedHz: (m) => (typeof m.published === 'number' && m.published > 0 ? m.published : null),
    // ROM_IDX indexes gamecube.html ROMS[] — 0=MP4(60Hz) 1=SAB(60Hz) 2=PSO(30Hz) 3=240pSuite
    roms: { mp4: 0, sab: 1, pso: 2 },
    async start(page, rom) {
      await page.evaluate((i) => {
        const s = document.getElementById('romSelect');
        if (s) { s.value = String(i); s.dispatchEvent(new Event('change')); }
        const b = document.getElementById('btnStart');
        if (b) b.click();
      }, rom);
    },
    // window.__gcRate (gamecube.html:4870), refreshed 1 Hz by _rateTick (:4910).
    async meter(page) {
      return page.evaluate(() => {
        const r = window.__gcRate || {};
        return { nativeHz: r.nativeHz || null, guestHz: r.guestHz || null, speed: r.speed,
                 published: r.published, shown: r.shown, path: r.path,
                 text: (document.getElementById('fps') || {}).textContent || '' };
      }).catch(() => ({}));
    },
    // BUG 1: liveness. gamecube.html publishes no monotonic frame counter on
    // `window` — `__gcRate.published` (:4870, refreshed 1 Hz at :4910) is a
    // RATE, so a delta of it means nothing. So this page's liveness is "the
    // page's own producer counter reports a nonzero rate at BOTH ends of the
    // measured window", which a wedge cannot satisfy: _rateTick drives
    // published to 0 within a second of the producer stopping.
    async liveness(page) {
      return page.evaluate(() => {
        const r = window.__gcRate || {};
        return { mono: null, rate: typeof r.published === 'number' ? r.published : null };
      }).catch(() => ({ mono: null, rate: null }));
    },
  },

  dreamcast: {
    id: 'dreamcast',
    url: (q) => `/dreamcast.html?v=${Date.now()}${q ? '&' + q : ''}`,
    presentSource: 'compositor ONLY — the page never presents (canvas transferred '
                 + 'dreamcast.html:2003) and emscripten_webgl_commit_frame is a NO-OP in the shipped worker',
    preferCompositor: true,
    producedHz: (m) => (typeof m.fps === 'number' && m.fps > 0 ? m.fps : null),
    roms: { pso: 0 },
    async start(page) {
      await page.evaluate(() => { const b = document.getElementById('btnStart'); if (b) b.click(); });
    },
    // window.__dcProbe() (dreamcast.html:600) is the machine-readable snapshot.
    async meter(page) {
      return page.evaluate(() => {
        const p = (window.__dcProbe && window.__dcProbe()) || {};
        return { nativeHz: 30, fps: p.fps, fields: p.fields, guestX: p.guestX,
                 iters: p.iters, seq: p.seq, text: p.state || '' };
      }).catch(() => ({}));
    },
    async liveness(page) {
      return page.evaluate(() => {
        const p = (window.__dcProbe && window.__dcProbe()) || {};
        // `fps` is distinct frames/s with libretro's dupe sentinel excluded
        // (dreamcast.html:2917-2920), so a stuck emulator reads 0 — which is
        // exactly the property a liveness check needs.
        return { mono: null, rate: typeof p.fps === 'number' ? p.fps : null };
      }).catch(() => ({ mono: null, rate: null }));
    },
  },

  n64: {
    id: 'n64',
    url: (q) => `/n64/?v=${Date.now()}${q ? '&' + q : ''}`,
    // MEASURED: the deduped rAF series is the HOST REFRESH (57-60/s), not presents.
    // `_neil_vi_total` counts VIDEO INTERRUPTS (60/s on NTSC), which happen whether
    // or not the game drew anything -- so "VI advanced" is NOT "a new image exists".
    // In the same 60 s window the compositor swapped 24.26 times/s and the page's own
    // `made` (the core's swapCount) read 21-26. Those two agree; the VI count does not,
    // and treating it as the present series would have reported n64 at 57 presents/s.
    presentSource: 'compositor (SkiaRenderer::SwapBuffers) — the page-side rAF series is the '
                 + 'host refresh, and _neil_vi_total is the VI interrupt, neither of which is a present',
    preferCompositor: true,
    producedHz: (m) => (typeof m.made === 'number' && m.made > 0 ? m.made : null),
    roms: {},
    async start() { /* ?autostart in the query does it */ },
    async meter(page) {
      return page.evaluate(() => {
        const r = window.__n64Rate || {};
        const p = (window.__n64Pace && window.__n64Pace()) || {};
        return { nativeHz: r.viHz || null, gameHz: r.gameHz || null, speed: r.speed,
                 shown: r.shown, made: r.made, viHz: r.viHz, duty: r.duty,
                 paced: p.paced, denied: p.denied, idle: p.idle, notOwed: p.notOwed,
                 paceEnabled: p.enabled, paceWired: p.wired,
                 text: (document.getElementById('fpsLine') || document.getElementById('fps') || {}).textContent || '' };
      }).catch(() => ({}));
    },
    // The only one of the three with a real monotonic counter reachable from
    // the page: the core's own VI-interrupt total, which n64/index.html:496-500
    // calls "THE AUTHORITY" on whether a guest frame actually happened.
    async liveness(page) {
      return page.evaluate(() => {
        let mono = null;
        try { mono = window.Module._neil_vi_total() >>> 0; } catch (e) { mono = null; }
        const r = window.__n64Rate || {};
        return { mono, rate: typeof r.made === 'number' ? r.made : null };
      }).catch(() => ({ mono: null, rate: null }));
    },
  },
};

// ---------------------------------------------------------------------------
// SCENES. A scene is a named condition the page is put in; each one is a
// distribution, because "flawless" has to hold in more than one of them.
// ---------------------------------------------------------------------------
const SCENES = [
  { id: 'boot', what: 'the first window after the first present — shader/pipeline compiles and '
                    + 'cache fill land here, and a first-run hitch is still a hitch a visitor sees.',
    warmupMs: 0 },
  { id: 'steady', what: 'after a warmup. This is the scene the "flawless" claim is really about.',
    warmupMs: 20000 },
];

// ---------------------------------------------------------------------------
// One cell: (page, scene). Fresh profile — cross-origin isolation is
// ORIGIN-SCOPED and persists (device_matrix.mjs:33-41 measured twelve identical
// rows from this exact mistake).
// ---------------------------------------------------------------------------
async function runCell(pg, scene, opts = {}) {
  const out = { page: pg.id, scene: scene.id, instrumented: !opts.bare,
                headless: !HEADFUL, loadAtStart: os.loadavg().map((n) => +n.toFixed(2)),
                consoleErrors: [], pageErrors: [] };
  let dir, browser = null;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), `pace-${pg.id}-${scene.id}-`)); }
  catch (e) { out.error = 'no profile dir: ' + String(e).slice(0, 120); return out; }
  try {
    browser = await puppeteer.launch({
      headless: HEADFUL ? false : 'new', executablePath: CHROME, userDataDir: dir,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
             '--enable-unsafe-webgpu', '--mute-audio'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    page.on('console', (m) => { if (m.type() === 'error' && out.consoleErrors.length < 40) out.consoleErrors.push(m.text().slice(0, 160)); });
    page.on('pageerror', (e) => { if (out.pageErrors.length < 40) out.pageErrors.push(String(e).slice(0, 160)); });
    if (!opts.bare) await page.evaluateOnNewDocument(instrument);

    await page.goto(BASE + pg.url(opts.query), { waitUntil: 'domcontentloaded' });
    // coi-serviceworker self-reloads on a first visit (device_matrix.mjs:306-328).
    // Settle before touching anything, and re-check: reading through the reload
    // is how a rig manufactures the failure it exists to detect.
    for (let i = 0; i < 30; i++) {
      const s = await page.evaluate(() => ({ coi: !!self.crossOriginIsolated, has: !!document.getElementById('btnStart') })).catch(() => null);
      if (s && s.has && (pg.id === 'n64' || s.coi)) break;
      await sleep(500);
    }
    out.coi = await page.evaluate(() => !!self.crossOriginIsolated).catch(() => null);

    await pg.start(page, opts.rom);

    // ---- wait for the FIRST present, with a liveness floor ------------------
    // The BARE arm has no instrument, so it cannot wait on __pace.n. Waiting on
    // the page's own liveness instead is what makes the two arms comparable at
    // all — the first cut waited on __pace.n unconditionally and every bare arm
    // timed out, which silently voided the control on every row.
    const bootT0 = Date.now();
    const live0 = await pg.liveness(page);
    let firstAt = null;
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      const n = opts.bare ? 0 : await page.evaluate(() => window.__pace.n).catch(() => 0);
      const live = await pg.liveness(page);
      const alive = (live.mono !== null && live0.mono !== null && live.mono > live0.mono)
                 || (typeof live.rate === 'number' && live.rate > 0);
      if (n > 0 || alive) { firstAt = Date.now() - bootT0; break; }
      if (Date.now() - bootT0 > 150000) break;
    }
    out.firstPresentMs = firstAt;
    if (firstAt === null) { out.error = 'no frame produced within 150 s — nothing to pace'; }

    if (!out.error) {
      // ---- warm up to the scene, then MARK and measure --------------------
      const warm = opts.warmupMs !== undefined ? opts.warmupMs : scene.warmupMs;
      if (warm) await sleep(warm);
      const liveA = await pg.liveness(page);
      const meterA = await pg.meter(page);
      const windowT0 = Date.now();
      const markIdx = opts.bare ? 0 : await page.evaluate(() => { window.__pace.marks.push({ t: performance.now(), label: 'scene-start' }); return window.__pace.n; }).catch(() => 0);

      let tracePath = null;
      if (opts.trace) {
        tracePath = `/tmp/pacing-trace-${pg.id}-${scene.id}.json`;
        await page.tracing.start({
          categories: ['disabled-by-default-devtools.timeline.frame', 'benchmark', 'cc'],
          path: tracePath,
        }).catch((e) => { out.traceErr = String(e).slice(0, 120); tracePath = null; });
      }
      await sleep(MEASURE_MS);
      if (tracePath) await page.tracing.stop().catch(() => {});

      const liveB = await pg.liveness(page);
      const windowMs = Date.now() - windowT0;   // REAL elapsed, not the requested sleep
      const meterB = await pg.meter(page);
      out.meter = meterB; out.meterAtSceneStart = meterA;
      // BUG 1. Either a monotonic counter advanced across the window, or the
      // page's own frames/s was nonzero at BOTH ends of it. A wedge satisfies
      // neither, and a screenshot satisfies both while proving nothing.
      const monoOk = liveA.mono !== null && liveB.mono !== null && liveB.mono > liveA.mono;
      const rateOk = typeof liveA.rate === 'number' && liveA.rate > 0
                  && typeof liveB.rate === 'number' && liveB.rate > 0;
      out.liveness = { before: liveA, after: liveB, advanced: monoOk || rateOk, via: monoOk ? 'monotonic' : (rateOk ? 'nonzero-rate-both-ends' : 'none') };
      // The perturbation control's comparable: a rate per second, from the
      // page's OWN meter, computed the same way on both arms.
      out.windowMs = windowMs;
      out.controlRate = monoOk ? +(1000 * (liveB.mono - liveA.mono) / windowMs).toFixed(3)
                       : (rateOk ? +((liveA.rate + liveB.rate) / 2).toFixed(3) : null);

      if (!opts.bare) {
        const raw = await page.evaluate((from) => {
          const P = window.__pace;
          const t = Array.from(P.t.slice(from, P.n));
          const novel = Array.from(P.novel.slice(from, P.n));
          // deduped rAF stamps inside the same window
          const t0 = t.length ? t[0] : 0;
          const raf = Array.from(P.raf.slice(0, P.rn)).filter((x) => x >= t0);
          return { t, novel, raf, loaf: P.loaf, longtask: P.longtask,
                   hooked: P.hooked, loafErr: P.loafErr, total: P.n };
        }, markIdx).catch((e) => ({ err: String(e).slice(0, 120) }));
        out.raw = raw;
      }
      if (tracePath) out.compositor = compositorStats(tracePath);

      out.shot = `/tmp/pacing-${pg.id}-${scene.id}${opts.bare ? '-bare' : ''}.png`;
      await page.screenshot({ path: out.shot }).catch(() => { out.shot = null; });
    }
    await page.close().catch(() => {});
  } catch (e) {
    out.error = String(e).slice(0, 260);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Turn a cell into a judged row. nativeHz comes from the PAGE's own meter; if
// the rig cannot establish it, the cell is VOID rather than scored against a
// guessed 60 (that is gate #9's whole point).
// ---------------------------------------------------------------------------
function judge(cell, pg) {
  const v = { page: cell.page, scene: cell.scene };
  if (cell.error) { v.verdict = 'ERROR'; v.why = cell.error; return v; }
  if (!cell.liveness || !cell.liveness.advanced) {
    v.verdict = null;
    v.void = `NO LIVENESS — the page's own counters never proved the emulator was running `
           + `(${JSON.stringify(cell.liveness && cell.liveness.before)} -> `
           + `${JSON.stringify(cell.liveness && cell.liveness.after)}). `
           + `A wedged run still screenshots the live scene, so no distribution is reported.`;
    return v;
  }
  const m = cell.meter || {};
  let nativeHz = m.nativeHz || m.viHz || null;
  const haveComp = cell.compositor && cell.compositor.swaps > 3;
  const havePage = cell.raw && cell.raw.t && cell.raw.t.length > 3;
  const src = (pg.preferCompositor && haveComp) ? 'compositor' : (havePage ? 'page' : (haveComp ? 'compositor' : null));
  if (!src) {
    v.verdict = null;
    v.void = 'NO PRESENT SERIES — neither the page-side hook nor the compositor produced '
           + 'enough events to form a distribution.';
    return v;
  }
  if (!nativeHz) {
    v.verdict = null;
    v.void = `NATIVE RATE UNKNOWN — the page's own meter did not publish nativeHz, so there is `
           + `no honest target to score against (gate #9: a 30 Hz title scored against 60 reads as `
           + `a 50% failure that does not exist).`;
    return v;
  }
  v.nativeHz = nativeHz;
  v.targetMs = +(1000 / nativeHz).toFixed(3);
  v.presentSource = pg.presentSource;

  const stamps = src === 'page' ? cell.raw.t : cell.compositor.swapStamps;
  // For n64 the present series is every deduped rAF tick; the DISTINCT series is
  // the subset that carried a new VI. Both are reported: the first is what the
  // display did, the second is what the game did.
  // PRODUCED vs PRESENTED — criterion 1. The page's own producer counter says how
  // many distinct frames existed; the present series says how many reached the
  // screen. This is the criterion a flatness measure structurally cannot catch:
  // a stream that drops every 10th frame but keeps a perfect median looks flat.
  const prod = pg.producedHz ? pg.producedHz(m) : null;
  v.producedHz = prod;
  v.presentedHz = null; v.lossFrac = null;
  const spanS = stamps.length > 1 ? (stamps[stamps.length - 1] - stamps[0]) / 1000 : 0;
  if (spanS > 0) {
    v.presentedHz = +((stamps.length - 1) / spanS).toFixed(2);
    if (prod) v.lossFrac = +Math.max(0, (prod - v.presentedHz) / prod).toFixed(3);
  }
  v.distinct = distribution(
    src === 'page' && cell.raw.novel ? stamps.filter((_, i) => cell.raw.novel[i]) : stamps, v.targetMs);
  v.presented = distribution(stamps, v.targetMs);
  if (v.distinct && v.presented) {
    v.dupes = v.presented.n - v.distinct.n;
    v.dupeFrac = v.presented.n > 0 ? +(v.dupes / v.presented.n).toFixed(3) : null;
  }
  if (cell.raw && cell.raw.loaf) v.attribution = attribute((v.distinct || v.presented).hitches, cell.raw.loaf);

  // rAF cadence — the host refresh this run sat on. Deduped (BUG 3).
  if (cell.raw && cell.raw.raf && cell.raw.raf.length > 10) {
    const d = distribution(cell.raw.raf, v.targetMs);
    v.hostRefreshHz = d ? +(1000 / d.p50).toFixed(1) : null;
  }

  // PER-SECOND SERIES. gamecube.html's own 1 Hz meter (:_rateTick) reported
  // "60 shown / 60 published" on a window whose per-second series was
  // 46 43 45 41 41 45 39 38 40 38 44 43 47 45 48 46 38 49 50 49 50 53 48 48 51 46 48 59 60 60.
  // It was not lying -- it samples ONE second, and the second you happen to read
  // is the one you get. This series is what makes a ramp distinguishable from a
  // steady state, and it is the reason a 1 Hz meter cannot answer this question.
  if (stamps && stamps.length > 3) {
    const s0 = stamps[0], per = {};
    for (const x of stamps) { const k = Math.floor((x - s0) / 1000); per[k] = (per[k] || 0) + 1; }
    const keys = Object.keys(per).map(Number).sort((a, b) => a - b);
    v.perSecond = keys.slice(0, keys.length - 1).map((k) => per[k]);   // drop the partial tail
  }

  // CROSS-VALIDATION. Where the page-side hook AND the compositor both produced
  // a series, they must agree on the rate. That agreement is what licenses using
  // the compositor alone on Dreamcast, where no page-side hook can exist. If they
  // disagree, the compositor number is reported as UNVALIDATED and nothing on
  // Dreamcast may be quoted from it.
  if (src === 'page' && cell.compositor && cell.compositor.swaps > 3 && v.distinct) {
    const spanS = (cell.compositor.swapStamps[cell.compositor.swaps - 1]
                 - cell.compositor.swapStamps[0]) / 1000;
    const compRate = spanS > 0 ? cell.compositor.swaps / spanS : null;
    const pageRate = v.distinct.meanRate;
    const ratio = (compRate && pageRate) ? compRate / pageRate : null;
    v.crossValidation = {
      pageRate: +pageRate.toFixed(2), compositorRate: compRate ? +compRate.toFixed(2) : null,
      ratio: ratio ? +ratio.toFixed(3) : null,
      agrees: ratio !== null && ratio > 0.9 && ratio < 1.1,
      note: 'page-side putImageData vs viz SkiaRenderer::SwapBuffers over the same window',
    };
  }

  const D = v.distinct || v.presented;
  // THE VERDICT. Not a mean. TWO INDEPENDENT criteria, because either alone can be
  // satisfied by a stream a human would call broken:
  //   LOSS      frames the guest produced that never reached the screen. A stream
  //             can drop 10% and still show a textbook-flat median.
  //   FLATNESS  gaps of 2x the observed cadence or worse -- a skipped beat.
  // FLAT clears both. Anything else names which one it failed.
  const tail = D.p99 / D.p50;
  v.p99OverP50 = +tail.toFixed(2);
  v.missedSlots = D.missedSlots;
  v.worstMs = D.max;
  const lossOk = v.lossFrac === null || v.lossFrac <= 0.01;
  const flatOk = D.missedSlots === 0 && tail <= 1.5;
  if (lossOk && flatOk) v.verdict = 'FLAT';
  else if (lossOk && D.missedSlots === 0) v.verdict = 'JITTERY';
  else v.verdict = 'HITCHING';
  v.why = `p50 ${D.p50}ms / p95 ${D.p95} / p99 ${D.p99} / max ${D.max}; `
        + `${D.missedSlots} gaps >= 2x the ${D.refMs}ms cadence in ${(D.spanMs / 1000).toFixed(1)}s; `
        + (v.lossFrac === null ? 'produced-rate unknown'
           : `produced ${v.producedHz}/s -> presented ${v.presentedHz}/s (${(v.lossFrac * 100).toFixed(1)}% never shown)`);
  return v;
}

// ---------------------------------------------------------------------------
// BUG 2 — THE PERTURBATION CONTROL. The same scene run WITHOUT the instrument.
// The page's own 1 Hz meter must agree across the pair, or the instrumented
// numbers carry no verdict. This is the pacing analogue of device_matrix's
// arm-difference proof: there, an arm had to prove it CHANGED something; here,
// the instrument has to prove it changed NOTHING.
// ---------------------------------------------------------------------------
function perturbationProof(inst, bare) {
  const va = inst.controlRate, vb = bare.controlRate;
  if (typeof va !== 'number' || typeof vb !== 'number' || !(va > 0) || !(vb > 0)) {
    return { ok: false, detail: `could not read the page's own rate on both arms `
      + `(instrumented=${va}, bare=${vb}${bare.error ? '; bare arm: ' + bare.error : ''}) `
      + `— the control cannot be evaluated` };
  }
  const ratio = va / vb;
  return {
    ok: ratio >= 0.93 && ratio <= 1.07,
    detail: `page's own rate, measured identically on both arms: instrumented ${va}/s vs bare ${vb}/s `
          + `(ratio ${ratio.toFixed(3)}; must be 0.93-1.07 or the instrument moved what it measures)`,
  };
}

// ---------------------------------------------------------------------------
async function main() {
  const targets = [];
  const wanted = (id) => !ONLY_PAGE || ONLY_PAGE === id;
  if (wanted('gamecube')) targets.push({ pg: PAGES.gamecube, rom: PAGES.gamecube.roms[argOf('rom', 'mp4')] ?? 0, query: argOf('q', '') });
  if (wanted('dreamcast')) targets.push({ pg: PAGES.dreamcast, rom: 0, query: argOf('q', '') });
  if (wanted('n64')) targets.push({ pg: PAGES.n64, rom: 0, query: 'game=' + argOf('rom64', 'mariokart.z64') + '&autostart' });

  const result = {
    base: BASE, startedAt: new Date().toISOString(), headless: !HEADFUL,
    measureMs: MEASURE_MS,
    load: { at_start: os.loadavg().map((n) => +n.toFixed(2)) },
    rows: [], cells: [],
  };

  for (const t of targets) {
    for (const scene of SCENES) {
      if (ONLY_SCENE && scene.id !== ONLY_SCENE) continue;
      const opts = { rom: t.rom, query: t.query, trace: true };
      const wOverride = argOf('warmup', null);
      if (wOverride !== null && scene.id === 'steady') opts.warmupMs = parseInt(wOverride, 10);
      const cell = await runCell(t.pg, scene, opts);
      result.cells.push(cell);
      const row = judge(cell, t.pg);
      row.what = scene.what;
      row.firstPresentMs = cell.firstPresentMs;
      row.loadAtStart = cell.loadAtStart;
      row.windowMs = cell.windowMs;
      row.shot = cell.shot;
      // The perturbation control runs only on the scene we actually score.
      if (!NO_PAIR && scene.id === 'steady' && row.verdict && row.verdict !== 'ERROR') {
        // Identical in every respect EXCEPT evaluateOnNewDocument(instrument).
        // An earlier cut turned tracing off on the bare arm only, which made the
        // two windows different lengths and different workloads -- the control
        // then blamed the instrument for the rig's own asymmetry.
        const bare = await runCell(t.pg, scene, { ...opts, bare: true });
        result.cells.push(bare);
        const pr = perturbationProof(cell, bare);
        row.perturbation = pr.detail;
        row.perturbationOk = pr.ok;
        if (!pr.ok) { row.voidedVerdict = row.verdict; row.verdict = null;
                      row.void = 'INSTRUMENT PERTURBED THE RUN — ' + pr.detail; }
      }
      result.rows.push(row);
    }
  }
  result.load.at_end = os.loadavg().map((n) => +n.toFixed(2));

  const s = result.rows;
  result.summary = {
    rows: s.length,
    flat: s.filter((x) => x.verdict === 'FLAT').length,
    jittery: s.filter((x) => x.verdict === 'JITTERY').length,
    hitching: s.filter((x) => x.verdict === 'HITCHING').length,
    voided: s.filter((x) => x.verdict === null).length,
    errors: s.filter((x) => x.verdict === 'ERROR').length,
  };
  // THE GATE. Only FLAT clears "no skipping, no lag, no issues whatsoever".
  result.ok = result.summary.hitching === 0 && result.summary.jittery === 0
           && result.summary.errors === 0 && result.summary.voided === 0;

  const outPath = process.env.PACING_OUT || '/tmp/pacing-matrix.json';
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
  if (JSON_ONLY) { console.log(JSON.stringify(result, null, 1)); return; }

  const pad = (x, n) => String(x === null || x === undefined ? '' : x).padEnd(n).slice(0, n);
  console.log(`\nFRAME-PACING MATRIX  base=${BASE}  ${HEADFUL ? 'HEADFUL (real display)' : 'headless (synthetic vsync)'}`
    + `  load ${result.load.at_start[0]} -> ${result.load.at_end[0]}  window=${MEASURE_MS}ms`);
  console.log('\nMean fps is deliberately absent from the verdict. "No skipping, no lag" is a claim');
  console.log('about the TAIL, so the tail is what is scored.\n');
  console.log(`  ${pad('page', 10)} ${pad('scene', 8)} ${pad('verdict', 10)} ${pad('target', 8)} `
    + `${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 9)} ${pad('max', 10)} ${pad('missed', 7)} dupes`);
  for (const r of result.rows) {
    const D = r.distinct || r.presented;
    if (!D) { console.log(`  ${pad(r.page, 10)} ${pad(r.scene, 8)} ${pad(r.verdict === null ? 'VOID' : r.verdict, 10)}`);
              if (r.void) console.log(`      ${r.void}`); if (r.why) console.log(`      ${r.why}`); continue; }
    console.log(`  ${pad(r.page, 10)} ${pad(r.scene, 8)} ${pad(r.verdict === null ? 'VOID' : r.verdict, 10)} `
      + `${pad(r.nativeHz + 'Hz', 8)} ${pad(D.p50, 8)} ${pad(D.p95, 8)} ${pad(D.p99, 9)} ${pad(D.max, 10)} `
      + `${pad(D.missedSlots, 7)} ${r.dupes === undefined ? '' : r.dupes}`);
    if (r.void) console.log(`      VOID: ${r.void}`);
    if (r.perturbation) console.log(`      control: ${r.perturbation}`);
    console.log(`      produced ${r.producedHz}/s -> presented ${r.presentedHz}/s `
      + `(${r.lossFrac === null ? '?' : (r.lossFrac * 100).toFixed(1) + '% NEVER REACHED THE SCREEN'}); `
      + `flatness p99/p50 = ${r.p99OverP50}`);
    if (r.hostRefreshHz) console.log(`      host refresh ~${r.hostRefreshHz}Hz; present source: ${r.presentSource}`);
    if (r.attribution && r.attribution.length) {
      console.log(`      --- hitch census (worst first, ${D.hitchCount} gaps >= 2 periods) ---`);
      for (const a of r.attribution.slice(0, 8)) {
        console.log(`      ${String(a.ms).padStart(9)}ms (${a.periods} periods lost)  [${a.cls}] ${a.why}`);
      }
    }
    if (r.compositor && !r.compositor.error) {
      console.log(`      compositor: swaps-to-screen=${r.compositor.swaps} `
        + `rendererLayerTree presented=${r.compositor.presented} `
        + `droppedAffectingSmoothness=${r.compositor.droppedAffectingSmoothness}`);
    }
    if (r.crossValidation) {
      const cv = r.crossValidation;
      console.log(`      cross-validation: page ${cv.pageRate}/s vs compositor ${cv.compositorRate}/s `
        + `(ratio ${cv.ratio}) -> ${cv.agrees ? 'AGREE' : 'DISAGREE — compositor numbers are UNVALIDATED'}`);
    }
  }
  console.log(`\nSUMMARY ${JSON.stringify(result.summary)}`);
  console.log(`OK = ${result.ok}   (only FLAT clears the bar)`);
  console.log(`full JSON -> ${outPath}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
