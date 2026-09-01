/*
 * lib/audiodiag.js — one shape for "is the audio actually OK" across every
 * emulator page, plus the pure model that decides it.
 *
 * Companion to lib/capability.js. Same three rules:
 *   1. ONE report shape, so one rig can ask every page the same questions.
 *   2. Every field is the result of OBSERVING THE SINK, never of reading a
 *      producer-side counter. A worker can push buffers at a perfect rate into
 *      a graph that is suspended, muted, or never connected, and every
 *      producer counter still reads healthy. This distinction is not academic:
 *      on Dreamcast the worklet had been posting per-second stats that NOTHING
 *      ON THE PAGE LISTENED TO, so the sink had never been observed at all.
 *   3. The decision logic is PURE and separately testable (?audiotest=1), the
 *      way GcRate.route is. A classifier that only runs against a live
 *      emulator can never be regression-tested.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * GATE #9 — THIS MODULE MAY NEVER GOVERN GAMEPLAY SPEED.
 *
 * The guest runs at exactly 1.000x hardware. Audio is downstream of that and
 * must stay downstream. Two remedies are therefore PERMANENTLY out of bounds
 * here, and both have already been tried and rejected on this site:
 *
 *   - Speeding up or slowing down the guest to match the sink. Forbidden
 *     outright.
 *   - Time-stretching / dynamic-rate-controlling the audio to hide a rate
 *     mismatch. This shipped once on N64 (a 0.90 ratio floor), was audible as
 *     warble, and was reverted in `5cfd274e` — "audio can never govern
 *     gameplay again; audible stretch bandaid removed".
 *
 * When this module says STARVED, the correct response is to fix the PRODUCER or
 * the BUFFERING. `classify()` returns a `remedy` field naming the allowed
 * class of fix precisely so that the forbidden ones are never reached for by
 * default. `FORBIDDEN_REMEDIES` is exported and asserted against in the suite.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // Nominal guest audio sample rates. These are HARDWARE facts about the
  // console, not tunables — a page must produce at its console's rate and the
  // sink must consume at the device's rate, and any difference is resampling
  // that somebody has to do explicitly.
  //
  // Cited, not remembered:
  //   dreamcast 44101.43 — AICA emits one frame per AICA_TICK (4535 SH4
  //     cycles) at 200 MHz: 200e6/4535. Used as the guest-clock witness.
  //   gamecube  32029    — derived on gamecube.html from the AI DMA witness
  //     (SendAIBuffer of 8 frames at 4003.5587 fires/s).
  //   ps1       44100    — SPU output rate; dfsound/sdl.c:80 opens at 44100.
  //   n64       44100    — n64/index.html pins the context to 44100 and the
  //     core's ring is read as 88200 int16 entries (= 44100 stereo frames)/s.
  //   gba       null     — NOT ESTABLISHED. The core is vendored with no source
  //     in the repo and `_emuSetSampleRate` (44gba.js) has NO CALL SITE, so the
  //     rate it actually produces at has to be MEASURED, not assumed. Leaving
  //     this null on purpose: a wrong constant here would be worse than none.
  var NOMINAL_RATE = {
    ps1: 44100,
    n64: 44100,
    gamecube: 32029,
    dreamcast: 200000000 / 4535,
    gba: null
  };

  // Remedies this module must never propose. Exported so the suite can assert
  // that no code path returns one.
  var FORBIDDEN_REMEDIES = [
    'speed-up-guest',
    'slow-down-guest',
    'time-stretch',
    'dynamic-rate-control'
  ];

  // Tolerance on the feed ratio before we call it a mismatch. A real device
  // clock and a real guest clock never agree exactly; 0.5% is comfortably
  // above crystal drift and comfortably below anything audible as pitch.
  var RATE_TOL = 0.005;

  // ───────────────────────────── pure model ─────────────────────────────────
  // Everything in this block is a pure function of its arguments: no clock, no
  // DOM, no globals. That is what makes ?audiotest=1 able to test it.

  /**
   * producedFrames / consumedFrames.
   * >1 the producer outruns the sink (buffer grows, then drops)
   * <1 the sink outruns the producer (buffer drains, then underruns)
   */
  function feedRatio(producedFrames, consumedFrames) {
    if (!(consumedFrames > 0)) return null;
    return producedFrames / consumedFrames;
  }

  /**
   * How long the current buffer occupancy survives at the current imbalance.
   * Returns Infinity when the producer keeps up, null when undetermined.
   *
   * This is the number that turns "the ring drifts down ~18 frames/s" from an
   * anecdote into a scheduled failure: at 44100 Hz a 16384-frame ring losing
   * 18 frames/s empties in about 910 s, so a run shorter than that reports a
   * clean 0 underruns and proves nothing.
   */
  function secondsUntilEmpty(fillFrames, producedPerSec, consumedPerSec) {
    if (!(fillFrames >= 0)) return null;
    if (typeof producedPerSec !== 'number' || typeof consumedPerSec !== 'number') return null;
    var deficit = consumedPerSec - producedPerSec;
    if (deficit <= 0) return Infinity;
    return fillFrames / deficit;
  }

  /** Same, for the overflow direction. */
  function secondsUntilFull(fillFrames, capacityFrames, producedPerSec, consumedPerSec) {
    if (!(capacityFrames > 0) || !(fillFrames >= 0)) return null;
    if (typeof producedPerSec !== 'number' || typeof consumedPerSec !== 'number') return null;
    var surplus = producedPerSec - consumedPerSec;
    if (surplus <= 0) return Infinity;
    return (capacityFrames - fillFrames) / surplus;
  }

  /**
   * Classify one sink observation.
   *
   * `o` fields (all optional; absence is handled, never assumed healthy):
   *   ctxState        'running' | 'suspended' | 'closed' | null
   *   framesRendered  frames the output node actually rendered
   *   framesAudible   of those, frames that were not exactly zero
   *   underrunFrames  frames the sink had to zero-fill for lack of data
   *   droppedFrames   frames the producer discarded because the buffer was full
   *   producedPerSec / consumedPerSec
   *   srcRate / dstRate  producer rate and context rate
   *   resampling      whether a resampler is engaged between them
   *   destConnects    how many nodes were connected to the destination
   *
   * Returns { verdict, detail, remedy }. `remedy` names the ALLOWED class of
   * fix and is never one of FORBIDDEN_REMEDIES.
   */
  function classify(o) {
    o = o || {};
    var r = function (verdict, detail, remedy) {
      return { verdict: verdict, detail: detail, remedy: remedy || 'none' };
    };

    if (o.ctxState === null || o.ctxState === undefined) {
      return r('NO-CONTEXT', 'the page never constructed an AudioContext', 'construct-and-connect-a-sink');
    }
    if (o.ctxState === 'closed') {
      return r('CLOSED', 'AudioContext was closed and not rebuilt', 'rebuild-the-context');
    }
    if (o.ctxState === 'suspended') {
      // Autoplay policy, a mute that never got undone, or a tab that was
      // backgrounded and never recovered. All are recoverable on a gesture.
      return r('SUSPENDED', 'AudioContext is suspended — nothing is being rendered', 'resume-on-user-gesture');
    }
    if (o.destConnects === 0 && !(o.framesRendered > 0)) {
      return r('NO-SINK', 'context is running but nothing was connected to destination', 'connect-the-output-node');
    }
    if (!(o.framesRendered > 0)) {
      return r('NO-SINK', 'context reports running but rendered no frames', 'connect-the-output-node');
    }
    if (o.framesAudible === 0) {
      return r('SILENT', 'frames were rendered but every sample was exactly zero', 'fix-the-producer');
    }

    // A rate mismatch with no resampler is the failure that desktop Chrome
    // hides: it honours an odd requested sampleRate, so the mismatch path is
    // never exercised until a device clamps to 48000.
    if (typeof o.srcRate === 'number' && typeof o.dstRate === 'number'
        && o.srcRate > 0 && o.dstRate > 0
        && Math.abs(o.srcRate - o.dstRate) / o.dstRate > RATE_TOL
        && o.resampling === false) {
      return r('RATE-MISMATCH',
        'producer ' + o.srcRate + ' Hz vs context ' + o.dstRate + ' Hz with no resampler engaged',
        'engage-the-resampler-in-the-sink');
    }

    if (o.underrunFrames > 0) {
      return r('STARVED',
        o.underrunFrames + ' frames zero-filled for lack of data',
        'fix-the-producer-or-deepen-the-buffer');
    }
    if (o.droppedFrames > 0) {
      return r('SATURATED',
        o.droppedFrames + ' frames discarded because the buffer was full',
        'deepen-the-buffer-or-drain-faster');
    }

    var fr = feedRatio(o.producedPerSec, o.consumedPerSec);
    if (fr !== null && Math.abs(fr - 1) > RATE_TOL) {
      // Imbalance with no underrun/drop YET — the buffer is absorbing it, and
      // this is exactly the state that reads clean on a short run and fails on
      // a long one.
      return r(fr < 1 ? 'DRIFT-STARVING' : 'DRIFT-SATURATING',
        'feed ratio ' + fr.toFixed(5) + ' — buffer is absorbing an imbalance that has not failed yet',
        fr < 1 ? 'fix-the-producer-or-deepen-the-buffer' : 'deepen-the-buffer-or-drain-faster');
    }

    return r('HEALTHY', 'sink rendered audible frames with no underruns, drops or drift', 'none');
  }

  // ────────────────────────── live instrumentation ──────────────────────────

  /**
   * Install the uniform counter record on a page. Returns window.__audioDiag.
   * Pages increment the fields they can observe; absent fields stay null and
   * are reported as "not observed" rather than as zero.
   */
  function install(pageId, opts) {
    opts = opts || {};
    var d = window.__audioDiag;
    if (d && d.page === pageId) return d;
    d = {
      page: pageId,
      installedAt: (window.performance && performance.now) ? performance.now() : Date.now(),
      nominalRate: (pageId in NOMINAL_RATE) ? NOMINAL_RATE[pageId] : null,
      ctxRate: opts.ctxRate != null ? opts.ctxRate : null,
      srcRate: opts.srcRate != null ? opts.srcRate : null,
      // producer side
      framesProduced: 0, bytesFed: 0, bytesDropped: 0,
      batchesFed: 0, batchesDropped: 0, lastFeedMs: null,
      // sink side — null means NOT OBSERVED, which is different from zero.
      framesConsumed: null, underrunFrames: null, droppedFrames: null,
      fill: null, capacity: opts.capacity != null ? opts.capacity : null,
      resampling: null,
      // context lifecycle
      ctxState: null, suspendEvents: 0, resumeEvents: 0,
      sinkStats: []
    };
    window.__audioDiag = d;
    return d;
  }

  /**
   * Attach to an AudioWorkletNode that posts periodic stats, so the SINK is
   * observed rather than assumed. This is the piece whose absence made the
   * Dreamcast worklet's stats messages fall on the floor.
   */
  function observeSink(node, mapFn) {
    var d = window.__audioDiag;
    if (!d || !node || !node.port) return;
    node.port.addEventListener('message', function (e) {
      try {
        var s = mapFn ? mapFn(e.data) : e.data;
        if (!s || typeof s !== 'object') return;
        if (typeof s.underrunFrames === 'number') d.underrunFrames = s.underrunFrames;
        if (typeof s.consumedFrames === 'number') d.framesConsumed = s.consumedFrames;
        if (typeof s.fill === 'number') d.fill = s.fill;
        if (typeof s.capacity === 'number') d.capacity = s.capacity;
        if (typeof s.resampling === 'boolean') d.resampling = s.resampling;
        if (d.sinkStats.length < 600) d.sinkStats.push({ t: performance.now(), s: s });
      } catch (_e) { /* diagnostics must never break playback */ }
    });
    if (node.port.start) node.port.start();
  }

  /** Track ctx lifecycle so an unrecovered autoplay suspend is visible. */
  function observeContext(ctx) {
    var d = window.__audioDiag;
    if (!d || !ctx) return;
    d.ctxState = ctx.state;
    d.ctxRate = ctx.sampleRate;
    try {
      ctx.addEventListener('statechange', function () {
        d.ctxState = ctx.state;
        if (ctx.state === 'suspended') d.suspendEvents++;
        if (ctx.state === 'running') d.resumeEvents++;
      });
    } catch (_e) {}
  }

  /** Uniform snapshot + verdict. This is what a rig reads. */
  function report() {
    var d = window.__audioDiag;
    if (!d) return { installed: false };
    var span = (d.lastFeedMs != null) ? (d.lastFeedMs - d.installedAt) / 1000 : 0;
    var producedPerSec = span > 1 ? d.framesProduced / span : null;
    var out = {
      installed: true,
      page: d.page,
      nominalRate: d.nominalRate,
      ctxRate: d.ctxRate,
      ctxState: d.ctxState,
      suspendEvents: d.suspendEvents,
      resumeEvents: d.resumeEvents,
      framesProduced: d.framesProduced,
      producedPerSec: producedPerSec,
      framesConsumed: d.framesConsumed,
      underrunFrames: d.underrunFrames,
      droppedFrames: d.droppedFrames,
      bytesFed: d.bytesFed,
      bytesDropped: d.bytesDropped,
      batchesFed: d.batchesFed,
      batchesDropped: d.batchesDropped,
      fill: d.fill,
      capacity: d.capacity,
      resampling: d.resampling,
      sinkObserved: d.framesConsumed !== null || d.underrunFrames !== null
    };
    out.classification = classify({
      ctxState: d.ctxState,
      framesRendered: d.framesConsumed,
      framesAudible: undefined,
      underrunFrames: d.underrunFrames,
      droppedFrames: d.droppedFrames,
      producedPerSec: producedPerSec,
      consumedPerSec: null,
      srcRate: d.srcRate != null ? d.srcRate : d.nominalRate,
      dstRate: d.ctxRate,
      resampling: d.resampling,
      destConnects: undefined
    });
    // Producer-rate honesty check against the console's hardware rate.
    if (producedPerSec && d.nominalRate) {
      out.producedOverNominal = producedPerSec / d.nominalRate;
    }
    return out;
  }

  window.AudioDiag = {
    NOMINAL_RATE: NOMINAL_RATE,
    FORBIDDEN_REMEDIES: FORBIDDEN_REMEDIES,
    RATE_TOL: RATE_TOL,
    feedRatio: feedRatio,
    secondsUntilEmpty: secondsUntilEmpty,
    secondsUntilFull: secondsUntilFull,
    classify: classify,
    install: install,
    observeSink: observeSink,
    observeContext: observeContext,
    report: report
  };

  // ?audiotest=1 — the module's own suite, loaded lazily so a shipped visitor
  // pays nothing. A LITERAL ABSOLUTE URL on purpose: tools/verify_deploy_assets.mjs
  // only asserts on absolute literal URLs it can see statically.
  if (/[?&]audiotest=1/.test(location.search)) {
    var s = document.createElement('script');
    s.src = '/lib/audiodiag.test.js';
    document.head.appendChild(s);
  }
})();
