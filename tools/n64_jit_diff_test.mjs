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
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
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
  await page.goto(`http://localhost:8080/n64/?game=${rom}&autostart&difftrace${jit ? '&jit=' + JIT_MODE : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.myApp && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 120000 });
  await page.waitForFunction(`Module._neil_diff_count() >= ${FRAMES}`, { timeout: 180000, polling: 500 });
  const sums = await page.evaluate((n) => { const a = []; for (let i = 0; i < n; i++) a.push(Module._neil_diff_get(i) >>> 0); return a; }, FRAMES);
  const stats = jit ? await page.evaluate(() => window.__jitStats ? window.__jitStats() : null) : null;
  await ctx.close();
  return { label, sums, stats, logs };
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
const out = {
  rom, frames: FRAMES, jitMode: JIT_MODE,
  determinismControl: detDiff === -1 ? 'PASS' : `INVALID METHOD: interp runs diverge at frame ${detDiff}`,
  jitVsInterp: detDiff !== -1 ? 'SKIPPED (method invalid)' : (jitDiff === -1 ? 'PASS' : `DIVERGED at frame ${jitDiff}`),
  jitStats: jit.stats,
  errors: { a: interpA.logs.slice(0, 3), b: interpB.logs.slice(0, 3), jit: jit.logs.slice(0, 3) },
};
console.log(JSON.stringify(out, null, 1));
process.exit(detDiff === -1 && jitDiff === -1 ? 0 : 1);
