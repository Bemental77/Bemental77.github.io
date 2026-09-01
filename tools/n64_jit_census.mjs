// N64 JIT runtime execution census (n64/docs/jit/TASKS.md M2 wave 5b).
//
//   node tools/n64_jit_census.mjs <rom.z64> [warmupVI] [windowVI] [--noinput]
//
// Ranks the REMAINING emitter work by MEASURED EXECUTION FREQUENCY, not by
// compile-time site counts (CLAUDE.md gate #6). Boots the ROM under
// ?jit=census, lets it settle for `warmupVI` VI frames, snapshots the census,
// drives controller input for `windowVI` more frames, and reports the DELTA —
// so the ranking describes the driven window, not the boot logos.
//
// Bucket names come from n64/bementalJIT/mips_emit.js:
//   <MNEM>          a generic interpreter fallback executed (unported opcode)
//   SLOW:<MNEM>     a natively-emitted memory op that took the off-RDRAM arm
//   CU1MISS:<MNEM>  a COP1 op executed with CU1 clear (interp + block exit)
//   #block-iter     block-body iterations (entries + in-block back-edges)
//   #backedge       in-block loop back-edges taken
//   #exit:*         block exits by reason  #gen_interrupt  interrupt polls hit
//
// Input drive uses real key events: the core reads the desktop keyboard
// through SDL scancodes (mymain.cpp:1798-1843 maps config.txt names), with
// the shipped defaults from input_controller.js:333-352 — Enter=Start, m=A,
// n=B, w/a/s/d=analog, arrows=d-pad. --noinput measures the attract/idle mix
// instead (which is NOT a gameplay mix; say which one you ran).
import puppeteer from 'puppeteer';
import fs from 'fs';

const rom = process.argv[2] || 'mariokart.z64';
const args = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const noInput = process.argv.includes('--noinput');
const WARMUP_VI = +(args[0] || 600);
const WINDOW_VI = +(args[1] || 900);
const TOP = +(process.env.CENSUS_TOP || 40);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}


const ctx = await browser.createIncognitoBrowserContext(); // fresh SRAM per run
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

const vi = () => page.evaluate(() => Module._neil_vi_total() >>> 0);
async function waitVI(target, timeoutMs) {
  const t0 = Date.now();
  let last = -1, stalledSince = Date.now();
  for (;;) {
    const n = await vi();
    if (n >= target) return n;
    if (n !== last) { last = n; stalledSince = Date.now(); }
    else if (Date.now() - stalledSince > 30000) throw new Error(`VI stalled at ${n} (target ${target})`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`VI timeout at ${n} (target ${target})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Generic gameplay drive: mash Start through title/menus, then hold analog
// forward while tapping A and steering. Not game-specific, but it keeps the
// guest out of a static menu, which is the whole point of the window.
async function drive(untilVI) {
  const tap = async (k, ms = 90) => { await page.keyboard.down(k); await new Promise((r) => setTimeout(r, ms)); await page.keyboard.up(k); };
  let phase = 0;
  await page.keyboard.down('w'); // analog forward, held for the window
  try {
    while ((await vi()) < untilVI) {
      phase++;
      if (phase <= 12) { await tap('Enter', 120); await new Promise((r) => setTimeout(r, 250)); continue; }
      await tap('m', 120);                                  // A
      await tap(phase % 4 === 0 ? 'a' : 'd', 200);          // steer
      if (phase % 7 === 0) await tap('Enter', 100);
      await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    await page.keyboard.up('w');
  }
}

const out = { rom, warmupVI: WARMUP_VI, windowVI: WINDOW_VI, input: !noInput };
try {
  await page.goto(`http://localhost:8080/n64/?game=${rom}&autostart&jit=census`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.myApp && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 120000 });
  await page.waitForFunction('window.bementalMips && window.bementalMips.censusOn && window.bementalMips.censusOn()', { timeout: 120000 });

  out.viAfterWarmup = await waitVI(WARMUP_VI, 300000);
  const before = await page.evaluate(() => window.__jitCensusDump());
  const statsBefore = await page.evaluate(() => window.__jitStats());

  const target = out.viAfterWarmup + WINDOW_VI;
  if (noInput) await waitVI(target, 300000);
  else await drive(target);
  out.viEnd = await vi();

  const after = await page.evaluate(() => window.__jitCensusDump());
  out.jitStats = await page.evaluate(() => window.__jitStats());
  out.blocksCompiledInWindow = out.jitStats.blocks - statsBefore.blocks;

  // liveness corroboration: VI must have advanced across the window, and the
  // canvas must not be blank (a stalled run screenshots a plausible frame)
  out.viAdvanced = out.viEnd - out.viAfterWarmup;
  fs.mkdirSync('/tmp/n64-census', { recursive: true });
  const shot = await (await page.$('#canvas')).screenshot({ path: `/tmp/n64-census/${rom.replace(/\.z64$/, '')}.png` });
  out.screenshot = `/tmp/n64-census/${rom.replace(/\.z64$/, '')}.png`;
  out.luminance = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return Math.round(s / (d.length / 4));
  }, 'data:image/png;base64,' + shot.toString('base64'));

  const b = new Map(before.map(([k, v]) => [k, v]));
  const delta = after.map(([k, v]) => [k, v - (b.get(k) || 0)]).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
  const structural = delta.filter(([k]) => k.startsWith('#'));
  const fallbacks = delta.filter(([k]) => !k.startsWith('#'));
  const totalFb = fallbacks.reduce((a, [, v]) => a + v, 0);
  const iters = (structural.find(([k]) => k === '#block-iter') || [, 0])[1];
  const exits = structural.filter(([k]) => k.startsWith('#exit:')).reduce((a, [, v]) => a + v, 0);

  out.structural = Object.fromEntries(structural);
  out.blockIterations = iters;
  out.blockExits = exits;
  out.itersPerExit = exits ? +(iters / exits).toFixed(2) : null;
  out.totalFallbackExecutions = totalFb;
  out.fallbacksPerBlockIter = iters ? +(totalFb / iters).toFixed(3) : null;
  out.ranked = fallbacks.slice(0, TOP).map(([k, v]) => ({ op: k, execs: v, pct: +(100 * v / (totalFb || 1)).toFixed(2) }));
  out.pageErrors = pageErrors.slice(0, 5);
  out.ok = out.viAdvanced > 0 && out.luminance > 2 && pageErrors.length === 0;
} catch (e) {
  out.error = String(e).slice(0, 300);
  out.ok = false;
} finally {
  await ctx.close();
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
