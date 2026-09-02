// N64 JIT differential harness (n64/docs/jit/TASKS.md M1).
//
//   node tools/n64_jit_diff_test.mjs [rom.z64] [frames] [jitMode]
//
// jitMode selects the ?jit= arm under test (default 'emit'); 'census' gates
// the wave-5b instrumentation, 'nofp' the FP-attribution arm.
//
// Runs the same ROM with no input three times — interpreter (twice: the
// determinism control) and ?jit — collecting the core's per-VI architectural
// checksum stream (_neil_diff_* exports, FNV-1a over reg/hi/lo/cp0/PC at
// every VI boundary). Two interpreter runs must match exactly or the method
// is invalid; interpreter-vs-jit must match exactly or the JIT diverged.
// Reports the first divergent frame index on failure.
import puppeteer from 'puppeteer';

const rom = process.argv[2] || 'mariokart.z64';
const FRAMES = +(process.argv[3] || 600);
const JIT_MODE = process.argv[4] || 'emit';
// RIG LIMIT, fixed 2026-09-02 (n64/docs/jit/TASKS.md "A rig limit this
// exposed"). The 600-VI wait used to be a hardcoded 180 s and the harness
// simply THREW on expiry, so any ROM slower than 3.33 VI/s produced a bare
// stack trace that the sweep recorded as `NOJSON` — indistinguishable from a
// wedge. conker.z64 and gauntletLegends.z64 both failed that way. Now:
//   * the wait is configurable (N64_DIFF_TIMEOUT_MS, default 180 s so an
//     ordinary sweep row costs the same as before),
//   * expiry is CAUGHT and reported as data — which VI the arm reached and
//     whether VI was still advancing — so SLOW and WEDGED are separable,
//   * protocolTimeout is raised, because a single CDP evaluate can otherwise
//     expire while the emulator blocks the main thread and kill the harness
//     with a ProtocolError that says nothing about the ROM (this is what
//     killed the gauntletLegends discriminator).
const WAIT_MS = +(process.env.N64_DIFF_TIMEOUT_MS || 180000);
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  protocolTimeout: +(process.env.N64_PROTOCOL_TIMEOUT_MS || 600000),
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}


async function run(label, jit) {
  // fresh storage per run: the game writes its SRAM/EEPROM into IndexedDB
  // ('<rom>.sram'), and a later run booting with the previous run's save
  // data diverges the moment the game reads it (mariokart: ~frame 80)
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  const logs = [];
  page.on('pageerror', e => logs.push(String(e).slice(0, 150)));
  // &difftrace makes the PAGE enable capture at module-ready — always before
  // the ROM download/callMain, so every run starts capture at VI frame 0
  // (harness-side enabling raced the boot and misaligned streams by ~2 VIs)
  // N64_EXTRA_QS appends arbitrary query params to BOTH arms, so an ablation
  // flag can be bisected without editing this file each time. It is applied to
  // the interpreter arms too on purpose: an option that changed only the jit
  // arm's URL would make the comparison measure the URL, not the emitter.
  const extra = process.env.N64_EXTRA_QS ? '&' + process.env.N64_EXTRA_QS.replace(/^&/, '') : '';
  await page.goto(`http://localhost:8080/n64/?game=${rom}&autostart&difftrace${jit ? '&jit=' + JIT_MODE : ''}${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.myApp && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 120000 });
  // Every read below is BOUNDED. A CDP evaluate runs on the page's main
  // thread — the very thread a slow or wedged emulator is monopolising — so an
  // unbounded read waits out the whole protocolTimeout. Racing it means a
  // blocked page costs seconds, not ten minutes per arm, and `null` is itself
  // the answer ("the main thread never yielded").
  const bounded = (p, ms, dflt) =>
    Promise.race([p.catch(() => dflt), new Promise((r) => setTimeout(() => r(dflt), ms))]);
  // SLOW vs WEDGED: sample VI twice around the wait, so an expiry can say which.
  const vi = () => bounded(page.evaluate(() => Module._neil_vi_total() >>> 0), 15000, null);
  let timedOut = false, viA = null, viB = null;
  try {
    await page.waitForFunction(`Module._neil_diff_count() >= ${FRAMES}`, { timeout: WAIT_MS, polling: 500 });
  } catch (e) {
    timedOut = true;
    viA = await vi();
    await new Promise((r) => setTimeout(r, 5000));
    viB = await vi();
  }
  // `null` (not 0) when the page could not be asked — "unreadable" and "zero"
  // are different facts and must not print the same.
  const got = await bounded(page.evaluate(() => Module._neil_diff_count() >>> 0), 30000, null);
  const n = got === null ? 0 : Math.min(FRAMES, got);
  const sums = await bounded(page.evaluate((k) => { const a = []; for (let i = 0; i < k; i++) a.push(Module._neil_diff_get(i) >>> 0); return a; }, n), 60000, []);
  const stats = jit ? await bounded(page.evaluate(() => window.__jitStats ? window.__jitStats() : null), 30000, null) : null;
  await ctx.close();
  const arm = { label, sums, stats, logs };
  if (timedOut) {
    arm.timedOut = true;
    arm.framesReached = got === null ? 'UNREADABLE (page did not answer)' : n;
    arm.viAtTimeout = viA;
    arm.viAfter5s = viB;
    // VI advancing during the 5 s probe = SLOW; frozen = WEDGED; no CDP answer
    // at all = the main thread never yielded, which is its own third state.
    arm.liveness = (viA === null || viB === null) ? 'NO CDP RESPONSE (main thread never yielded)'
      : (viB > viA ? `SLOW (VI advanced ${viA}->${viB} in 5s = ${((viB - viA) / 5).toFixed(2)} VI/s)`
                   : `WEDGED (VI frozen at ${viA} for 5s)`);
  }
  return arm;
}

function firstDiff(a, b) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; }

// try/finally is load-bearing, not tidiness. The waitForFunction calls above
// have 120-180 s timeouts and THROW on expiry; with the close outside a finally
// the Chrome survives the throw as an orphan still running the emulator page.
// Seven such orphans from the 2026-08-29 session were found still resident on
// 2026-09-01 -- 2 days 17 hours later -- two of them burning ~107% of a core
// EACH (832 and 815 CPU-minutes accumulated), for 230% of leaked CPU in total.
// That silently taxed every measurement taken in between, and this file's own
// documented timeout on thewheel.z64 (TASKS.md:315) is one of the ways it
// happened.
let interpA, interpB, jit;
try {
  interpA = await run('interp-A', false);
  interpB = await run('interp-B', false);
  jit = await run('jit', true);
} finally {
  await browser.close().catch(() => {});
}

const detDiff = firstDiff(interpA.sums, interpB.sums);
const jitDiff = firstDiff(interpA.sums, jit.sums);
// A TRUNCATED stream must never read as PASS. firstDiff only compares as far
// as the shorter arm, so an arm that timed out after 200 of 600 frames and
// matched over those 200 would otherwise report -1 — a manufactured PASS on a
// ROM that never finished. Short = INCOMPLETE, and the timeout row carries the
// SLOW/WEDGED discrimination.
const short = [interpA, interpB, jit].filter((a) => a.sums.length < FRAMES);
const timeouts = [interpA, interpB, jit].filter((a) => a.timedOut)
  .map((a) => ({ arm: a.label, framesReached: a.framesReached, liveness: a.liveness }));
const complete = short.length === 0;
const out = {
  rom, frames: FRAMES, jitMode: JIT_MODE,
  determinismControl: interpA.timedOut || interpB.timedOut
    ? `INCOMPLETE: ${interpA.timedOut ? 'interp-A' : 'interp-B'} timed out`
    : (detDiff === -1 ? 'PASS' : `INVALID METHOD: interp runs diverge at frame ${detDiff}`),
  jitVsInterp: !complete
    ? `INCOMPLETE (${short.map((a) => `${a.label} reached ${a.timedOut && a.framesReached === 'UNREADABLE (page did not answer)' ? 'UNREADABLE' : a.sums.length}/${FRAMES}`).join(', ')})`
    : (detDiff !== -1 ? 'SKIPPED (method invalid)' : (jitDiff === -1 ? 'PASS' : `DIVERGED at frame ${jitDiff}`)),
  // reported even when INCOMPLETE: a divergence inside the frames both arms
  // DID reach is a real divergence, and it is what localises the bug
  firstDivergenceInCommonPrefix: jitDiff,
  timeouts: timeouts.length ? timeouts : undefined,
  jitStats: jit.stats,
  errors: { a: interpA.logs.slice(0, 3), b: interpB.logs.slice(0, 3), jit: jit.logs.slice(0, 3) },
};
console.log(JSON.stringify(out, null, 1));
process.exit(complete && detDiff === -1 && jitDiff === -1 ? 0 : 1);
