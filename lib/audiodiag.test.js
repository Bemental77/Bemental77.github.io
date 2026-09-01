/*
 * lib/audiodiag.test.js — loaded by ?audiotest=1, publishes
 * window.__audioTest = { done, pass, fail, expect, lines, mutants }.
 *
 * Gate on `.done`, never on the object's existence: a rig that latches the
 * object mid-run can read a 1-assertion "clean" result.
 *
 * WHAT THIS TESTS AND WHY IT IS SHAPED THIS WAY.
 * The live audio path is time-dependent and needs a running emulator, so a
 * suite that only asserted against live playback could not run in CI, could
 * not run fast, and would be flaky. So the DECISION LOGIC is pure
 * (AudioDiag.classify / feedRatio / secondsUntilEmpty) and gets synthetic
 * vectors here — the same split that makes GcRate.route testable. The live
 * arm is a small tail of assertions that self-skip when no emulator is running.
 *
 * The mutation matrix at the end is the part that keeps this honest: it
 * verifies each guard by feeding an input that MUST trip it. A suite that only
 * ever feeds healthy inputs passes just as well against a classifier that
 * returns 'HEALTHY' unconditionally.
 */
(function () {
  'use strict';

  var lines = [];
  var pass = 0, fail = 0;

  function ok(name, cond, detail) {
    if (cond) { pass++; lines.push('PASS ' + name); }
    else { fail++; lines.push('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
  }
  function eq(name, got, want) {
    ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
  function near(name, got, want, tol) {
    ok(name, typeof got === 'number' && Math.abs(got - want) <= tol,
      'got ' + got + ' want ' + want + ' +/- ' + tol);
  }

  var A = window.AudioDiag;
  ok('module/present', !!A);
  if (!A) {
    window.__audioTest = { done: true, pass: pass, fail: fail, expect: 1, lines: lines, mutants: [] };
    return;
  }

  // ── nominal rates are hardware facts ────────────────────────────────────
  eq('rates/ps1', A.NOMINAL_RATE.ps1, 44100);
  eq('rates/n64', A.NOMINAL_RATE.n64, 44100);
  eq('rates/gamecube', A.NOMINAL_RATE.gamecube, 32029);
  near('rates/dreamcast-aica', A.NOMINAL_RATE.dreamcast, 44101.43, 0.01);
  // GBA is deliberately null — an unmeasured constant is worse than none.
  eq('rates/gba-is-unestablished', A.NOMINAL_RATE.gba, null);

  // ── feedRatio ───────────────────────────────────────────────────────────
  eq('feedRatio/balanced', A.feedRatio(44100, 44100), 1);
  near('feedRatio/starving', A.feedRatio(40000, 44100), 0.907, 0.001);
  near('feedRatio/saturating', A.feedRatio(48000, 44100), 1.088, 0.001);
  eq('feedRatio/zero-consumed-is-null', A.feedRatio(44100, 0), null);
  eq('feedRatio/negative-consumed-is-null', A.feedRatio(44100, -1), null);

  // ── drift model ─────────────────────────────────────────────────────────
  // The Dreamcast case that is still open: a 16384-frame ring losing 18
  // frames/s. A 60 s run cannot see it; the model says when it bites.
  near('drift/dc-ring-lifetime', A.secondsUntilEmpty(16384, 44083, 44101), 910, 5);
  eq('drift/keeping-up-is-infinite', A.secondsUntilEmpty(16384, 44101, 44101), Infinity);
  eq('drift/producer-ahead-is-infinite', A.secondsUntilEmpty(1000, 48000, 44100), Infinity);
  eq('drift/undetermined-is-null', A.secondsUntilEmpty(1000, null, 44100), null);
  near('drift/fill-time', A.secondsUntilFull(0, 16384, 48000, 44100), 4.2, 0.1);
  eq('drift/full-when-draining-is-infinite', A.secondsUntilFull(0, 16384, 44100, 48000), Infinity);

  // ── classify: the healthy case ──────────────────────────────────────────
  var healthy = {
    ctxState: 'running', framesRendered: 480000, framesAudible: 470000,
    underrunFrames: 0, droppedFrames: 0,
    producedPerSec: 44100, consumedPerSec: 44100,
    srcRate: 44100, dstRate: 44100, resampling: false, destConnects: 1
  };
  eq('classify/healthy', A.classify(healthy).verdict, 'HEALTHY');
  eq('classify/healthy-no-remedy', A.classify(healthy).remedy, 'none');

  // ── MUTATION MATRIX ─────────────────────────────────────────────────────
  // Each row breaks exactly ONE field of the healthy vector and names the
  // verdict that MUST result. This is what proves the guards are load-bearing
  // rather than decorative.
  var mutants = [
    ['no-context',      { ctxState: null },                    'NO-CONTEXT'],
    ['closed',          { ctxState: 'closed' },                 'CLOSED'],
    ['suspended',       { ctxState: 'suspended' },              'SUSPENDED'],
    ['nothing-rendered',{ framesRendered: 0, destConnects: 0 }, 'NO-SINK'],
    ['rendered-silence',{ framesAudible: 0 },                   'SILENT'],
    ['rate-mismatch',   { srcRate: 44100, dstRate: 48000, resampling: false }, 'RATE-MISMATCH'],
    ['underrun',        { underrunFrames: 242230 },             'STARVED'],
    ['dropped',         { droppedFrames: 5000 },                'SATURATED'],
    ['drift-down',      { producedPerSec: 43000 },              'DRIFT-STARVING'],
    ['drift-up',        { producedPerSec: 45000 },              'DRIFT-SATURATING']
  ];
  var mutantResults = [];
  mutants.forEach(function (m) {
    var o = {};
    Object.keys(healthy).forEach(function (k) { o[k] = healthy[k]; });
    Object.keys(m[1]).forEach(function (k) { o[k] = m[1][k]; });
    var got = A.classify(o).verdict;
    mutantResults.push({ mutant: m[0], want: m[2], got: got, pass: got === m[2] });
    eq('mutant/' + m[0], got, m[2]);
  });

  // ── BUFFER-AWARE DRIFT (regression lock) ────────────────────────────────
  // These numbers are the REAL GBA measurement that exposed the bug: produced
  // 47,909.7 f/s into a 48,000 Hz sink with a 4900-frame FIFO. The flat 0.5%
  // tolerance called that HEALTHY while the run produced 6 audible gaps.
  var gba = {
    ctxState: 'running', framesRendered: 1916928, framesAudible: 1644278,
    underrunFrames: 0, droppedFrames: 0,
    producedPerSec: 47909.7, consumedPerSec: 48129.7,
    srcRate: 48000, dstRate: 48000, resampling: false, destConnects: 1
  };
  ok('drift/gba-ratio-is-inside-flat-tolerance',
    Math.abs(A.feedRatio(gba.producedPerSec, gba.consumedPerSec) - 1) < A.RATE_TOL,
    'ratio=' + A.feedRatio(gba.producedPerSec, gba.consumedPerSec));
  eq('drift/without-capacity-flat-tolerance-says-healthy',
    A.classify(gba).verdict, 'HEALTHY');
  eq('drift/with-capacity-it-is-caught',
    A.classify(Object.assign({}, gba, { capacityFrames: 4900 })).verdict, 'DRIFT-STARVING');
  near('drift/gba-buffer-lifetime',
    A.secondsUntilEmpty(4900, gba.producedPerSec, gba.consumedPerSec), 22.3, 0.3);
  // A generous buffer makes the SAME ratio harmless — which is the whole point
  // of making this depth-relative rather than percentage-relative.
  eq('drift/same-ratio-big-buffer-is-healthy',
    A.classify(Object.assign({}, gba, { capacityFrames: 44100 * 60 })).verdict, 'HEALTHY');
  // Overproduction must not be caught by the STARVING branch. 48,300 into
  // 48,129.7 is ratio 1.0035 — inside RATE_TOL — so with a small buffer it must
  // still be HEALTHY rather than being dragged into DRIFT-STARVING by the new
  // capacity check. (48,500 would be ratio 1.0077, legitimately
  // DRIFT-SATURATING; picking that value was a bad assertion, not a bug.)
  eq('drift/overproduction-not-starving',
    A.classify(Object.assign({}, gba, { capacityFrames: 4900, producedPerSec: 48300 })).verdict,
    'HEALTHY');

  // A resampler that IS engaged must clear the mismatch, not merely mask it.
  eq('classify/mismatch-cleared-by-resampler',
    A.classify(Object.assign({}, healthy, { srcRate: 44100, dstRate: 48000, resampling: true })).verdict,
    'HEALTHY');

  // Ordering: a suspended context must win over an underrun count, because a
  // suspended context is WHY the underruns happened and is the actionable one.
  eq('classify/suspend-outranks-underrun',
    A.classify(Object.assign({}, healthy, { ctxState: 'suspended', underrunFrames: 9999 })).verdict,
    'SUSPENDED');

  // ── GATE #9: no code path may propose a forbidden remedy ────────────────
  // Every verdict this classifier can emit is enumerated and its remedy checked
  // against the reject list. This is the mechanical form of "audio must never
  // govern gameplay speed" and of the reverted N64 stretch bandaid.
  var allVectors = [healthy].concat(mutants.map(function (m) {
    var o = {}; Object.keys(healthy).forEach(function (k) { o[k] = healthy[k]; });
    Object.keys(m[1]).forEach(function (k) { o[k] = m[1][k]; });
    return o;
  }));
  var badRemedy = null;
  allVectors.forEach(function (v) {
    var rem = A.classify(v).remedy;
    if (A.FORBIDDEN_REMEDIES.indexOf(rem) >= 0) badRemedy = rem;
  });
  ok('gate9/no-forbidden-remedy-reachable', badRemedy === null, 'reached ' + badRemedy);
  ok('gate9/reject-list-names-time-stretch',
    A.FORBIDDEN_REMEDIES.indexOf('time-stretch') >= 0);
  ok('gate9/reject-list-names-guest-speedup',
    A.FORBIDDEN_REMEDIES.indexOf('speed-up-guest') >= 0);
  ok('gate9/reject-list-names-drc',
    A.FORBIDDEN_REMEDIES.indexOf('dynamic-rate-control') >= 0);

  // ── tolerance is a real threshold, not a rubber stamp ───────────────────
  eq('tol/just-inside-is-healthy',
    A.classify(Object.assign({}, healthy, { producedPerSec: 44100 * (1 + A.RATE_TOL * 0.9) })).verdict,
    'HEALTHY');
  eq('tol/just-outside-is-drift',
    A.classify(Object.assign({}, healthy, { producedPerSec: 44100 * (1 + A.RATE_TOL * 1.5) })).verdict,
    'DRIFT-SATURATING');

  // ── absence is not health ───────────────────────────────────────────────
  // An empty observation must NOT classify as HEALTHY. This is the single most
  // important assertion in the file: the failure mode being guarded against is
  // a page whose audio was never observed reading as fine.
  ok('absence/empty-observation-is-not-healthy',
    A.classify({}).verdict !== 'HEALTHY', A.classify({}).verdict);
  eq('absence/empty-observation-is-no-context', A.classify({}).verdict, 'NO-CONTEXT');
  ok('absence/undefined-arg-is-not-healthy', A.classify().verdict !== 'HEALTHY');

  // ── install()/report() shape ────────────────────────────────────────────
  var before = window.__audioDiag;
  var d = A.install('__test__', { capacity: 4096 });
  ok('install/returns-record', !!d && d.page === '__test__');
  eq('install/capacity-kept', d.capacity, 4096);
  eq('install/nominal-null-for-unknown-page', d.nominalRate, null);
  // Unobserved sink fields must be null, NOT zero — zero would read as "no
  // underruns" when the truth is "nobody looked".
  eq('install/underruns-start-unobserved', d.underrunFrames, null);
  eq('install/consumed-starts-unobserved', d.framesConsumed, null);
  var rep = A.report();
  eq('report/installed', rep.installed, true);
  eq('report/sink-not-observed', rep.sinkObserved, false);
  ok('report/carries-classification', !!rep.classification && !!rep.classification.verdict);
  window.__audioDiag = before;   // leave the page's own record alone

  // ── LIVE ARM (self-skipping) ────────────────────────────────────────────
  // Only asserts when this page actually has a live audio record, so the suite
  // is still meaningful on a page that has not been started.
  var live = window.__audioDiag;
  var liveRan = !!(live && live.page !== '__test__' && (live.batchesFed > 0 || live.framesProduced > 0));
  lines.push('INFO live-arm ' + (liveRan ? 'RAN' : 'SKIPPED (no audio produced yet on this page)'));
  if (liveRan) {
    ok('live/context-not-suspended', live.ctxState !== 'suspended', 'ctxState=' + live.ctxState);
    ok('live/produced-frames', live.framesProduced > 0);
    if (live.nominalRate) {
      var r = A.report();
      ok('live/produced-near-nominal',
        r.producedOverNominal != null && Math.abs(r.producedOverNominal - 1) < 0.10,
        'producedOverNominal=' + r.producedOverNominal);
    }
    ok('live/no-dropped-batches', (live.batchesDropped || 0) === 0
      || live.ctxState === 'suspended',
      'batchesDropped=' + live.batchesDropped);
  }

  window.__audioTest = {
    done: true,
    pass: pass, fail: fail,
    // Minimum assertions the STATIC arm always runs. A rig gates on
    // `pass >= expect && fail === 0`; a short count means the suite was cut
    // off, which is a failure even with zero recorded failures. The live arm
    // adds up to 4 more on top, so this is a floor, not an equality.
    expect: 54,
    liveArmRan: liveRan,
    lines: lines,
    mutants: mutantResults
  };
  try {
    console.log('[audiotest] ' + pass + ' pass, ' + fail + ' fail'
      + (liveRan ? ', live arm ran' : ', live arm skipped'));
    if (fail) console.error('[audiotest] failures:\n' + lines.filter(function (l) { return l.indexOf('FAIL') === 0; }).join('\n'));
  } catch (_e) {}
})();
