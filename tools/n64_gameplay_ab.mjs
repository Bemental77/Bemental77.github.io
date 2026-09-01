// N64 JIT gameplay A/B: interpreter vs ?jit over the SAME guest window,
// with input driven so the arms traverse the same scene.
//
//   node tools/n64_gameplay_ab.mjs <rom.z64> [ab|ba] [warmupVI] [windowVI]
//
// Why this exists (n64/docs/jit/TASKS.md "NEXT ACTIONS" #1): the pinned rig
// tools/_jit_speed_ab.mjs settles 20s with NO INPUT and measures whatever
// attract/title scene the ROM lands on. An idle-dominated scene reads
// meaninglessly close to 1.0x -- the GameCube lesson (memory
// gc_jit_execution_ceiling_is_the_deficit_2026_08_29: idle-dominated scenes
// read 1.00x only because ~80% of credited time is skipped idle).
//
// Two structural differences from _jit_speed_ab.mjs:
//
//  1. WINDOWS ARE COUNTED IN VI FRAMES, NOT WALL SECONDS. A wall-clock
//     settle lands a fast arm and a slow arm in DIFFERENT guest scenes, so
//     the two per-frame costs describe different work. Both arms here run
//     warmupVI frames, then exactly windowVI more.
//  2. INPUT IS VI-PACED, NOT WALL-PACED. Key transitions fire on guest VI
//     thresholds, so both arms receive the same input at the same guest
//     time and follow the same trajectory.
//
// Metric of record is per-VI cost, reported two ways:
//   perFrameMs    -- mean wall ms per retro_run (_neil_frame_cost_ms/_n,
//                    timed_retro_run mymain.cpp:903-909). Immune to the
//                    frame limiter, NOT immune to machine load.
//   cpuMsPerFrame -- CPU seconds burned by this browser's process tree per
//                    VI frame. Measures WORK, so it survives an
//                    oversubscribed box; still scaled by CPU_Speed_Limit.
// Load and CPU_Speed_Limit are sampled before AND after every arm; if they
// moved, the round is contaminated (n64/docs/jit/TASKS.md measurement rules).
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const rom = process.argv[2] || 'mariokart.z64';
// Validate the order argument instead of defaulting silently. On 2026-09-01 a
// shell word-splitting bug meant `ba` never reached this script; it fell
// through to the 'ab' default and produced two same-order rounds that LOOKED
// like an alternated pair. Arm-order alternation is the campaign's control for
// monotonic thermal drift, so silently losing it corrupts the result rather
// than failing it. Anything but ab|ba is now fatal.
const orderArg = process.argv[3] ?? 'ab';
if (orderArg !== 'ab' && orderArg !== 'ba') {
  console.error(`arm order must be "ab" or "ba", got ${JSON.stringify(orderArg)}`);
  process.exit(2);
}
const order = orderArg === 'ba' ? ['jit', 'interp'] : ['interp', 'jit'];
const WARMUP_VI = +(process.argv[4] || 600);
const WINDOW_VI = +(process.argv[5] || 900);
const JIT_MODE = process.env.JIT_MODE || 'emit';

function load1() { try { return +execSync("uptime", { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/)[1]; } catch { return null; } }
function speedLimit() { try { return +execSync('pmset -g therm', { encoding: 'utf8' }).match(/CPU_Speed_Limit\s*=\s*(\d+)/)[1]; } catch { return null; } }
function treeCpuSeconds(rootPid) {
  try {
    const rows = execSync('ps -Ao pid=,ppid=,time=', { encoding: 'utf8' }).trim().split('\n');
    const kids = new Map(), cpu = new Map();
    for (const line of rows) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!m) continue;
      const p = m[3].split(':').map(Number);
      cpu.set(+m[1], p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]);
      if (!kids.has(+m[2])) kids.set(+m[2], []);
      kids.get(+m[2]).push(+m[1]);
    }
    let total = 0, stack = [rootPid]; const seen = new Set();
    while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); total += cpu.get(p) || 0; for (const k of kids.get(p) || []) stack.push(k); }
    return total;
  } catch { return null; }
}

const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 600000,
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}


// The shipped keyboard map (input_controller.js:333-352): Enter=Start, m=A,
// n=B, w/a/s/d=analog, arrows=d-pad.
// Schedule is expressed in VI offsets from the run's own start, so both arms
// see the identical guest-time input pattern.
function schedule(untilVI) {
  const s = [];
  for (let i = 0; i < 14; i++) { s.push([60 + i * 30, 'down', 'Enter'], [60 + i * 30 + 10, 'up', 'Enter']); }
  s.push([500, 'down', 'w']);                       // analog forward, held
  for (let v = 520; v < untilVI; v += 24) {
    s.push([v, 'down', 'm'], [v + 8, 'up', 'm']);   // A
    const st = (v / 24) % 4 === 0 ? 'a' : 'd';
    s.push([v + 10, 'down', st], [v + 22, 'up', st]);
    if ((v / 24) % 7 === 0) { s.push([v + 12, 'down', 'Enter'], [v + 18, 'up', 'Enter']); }
  }
  s.push([untilVI, 'up', 'w']);
  return s.sort((a, b) => a[0] - b[0]);
}

async function run(jit) {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const arm = { arm: jit ? 'jit' : 'interp', loadBefore: load1(), limitBefore: speedLimit() };
  await page.goto(`http://localhost:8080/n64/?game=${rom}&autostart${jit ? '&jit=' + JIT_MODE : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.myApp && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 180000 });

  const vi = () => page.evaluate(() => Module._neil_vi_total() >>> 0);
  const sched = schedule(WARMUP_VI + WINDOW_VI);
  let si = 0, held = new Set();
  let last = -1, stalled = Date.now();
  let measuring = false, cpu0 = 0, t0 = 0;
  const target = WARMUP_VI + WINDOW_VI;
  for (;;) {
    const n = await vi();
    if (n !== last) { last = n; stalled = Date.now(); }
    else if (Date.now() - stalled > 60000) { arm.error = `VI stalled at ${n}`; break; }
    while (si < sched.length && sched[si][0] <= n) {
      const [, act, key] = sched[si++];
      if (act === 'down') { if (!held.has(key)) { held.add(key); await page.keyboard.down(key).catch(() => {}); } }
      else { if (held.has(key)) { held.delete(key); await page.keyboard.up(key).catch(() => {}); } }
    }
    if (!measuring && n >= WARMUP_VI) {
      measuring = true;
      arm.viAtMeasureStart = n;
      arm.shotWarm = await (await page.$('#canvas')).screenshot().catch(() => null);
      await page.evaluate(() => { Module._neil_frame_cost_reset(); window.__t0 = performance.now(); });
      cpu0 = treeCpuSeconds(browser.process()?.pid); t0 = Date.now();
    }
    if (n >= target) break;
    // 50ms: at 60 VI/s that is ~3 guest frames per poll, finer than the
    // 8-VI minimum gap in schedule() -- so a down/up pair cannot collapse
    // into one poll and vanish. A coarser poll delivers input at different
    // guest-frame granularity in a fast arm than a slow one, which would
    // put the two arms in different scenes.
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const k of held) await page.keyboard.up(k).catch(() => {});
  const cpu1 = treeCpuSeconds(browser.process()?.pid);
  // if the run stalled before the measure window opened there is no baseline
  // to subtract -- report nothing rather than a number derived from NaN
  const m = measuring
    ? await page.evaluate(() => ({ ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n(), el: (performance.now() - window.__t0) / 1000 }))
    : { ms: 0, n: 0, el: 0 };
  arm.viEnd = await vi();
  arm.stats = jit ? await page.evaluate(() => (window.__jitStats ? window.__jitStats() : null)) : null;
  fs.mkdirSync('/tmp/n64-ab', { recursive: true });
  const shotPath = `/tmp/n64-ab/${rom.replace(/\.z64$/, '')}-${arm.arm}.png`;
  const shot = await (await page.$('#canvas')).screenshot({ path: shotPath }).catch(() => null);
  arm.screenshot = shotPath;
  arm.luminance = shot ? await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return Math.round(s / (d.length / 4) * 10) / 10;
  }, 'data:image/png;base64,' + shot.toString('base64')) : null;
  arm.sceneMovedDuringWindow = arm.shotWarm && shot ? Buffer.compare(arm.shotWarm, shot) !== 0 : null;
  delete arm.shotWarm;
  arm.framesMeasured = m.n;
  arm.perFrameMs = m.n ? Math.round((m.ms / m.n) * 1000) / 1000 : null;
  arm.viRatePerSec = m.el ? Math.round((m.n / m.el) * 10) / 10 : null;
  if (cpu0 !== null && cpu1 !== null && m.n) {
    arm.cpuMsPerFrame = Math.round(((cpu1 - cpu0) * 1000 / m.n) * 100) / 100;
    arm.wallSec = Math.round((Date.now() - t0) / 100) / 10;
  }
  arm.loadAfter = load1(); arm.limitAfter = speedLimit();
  arm.pageErrors = errs.slice(0, 3);
  await ctx.close();
  return arm;
}

const res = {};
// See the note in tools/n64_jit_diff_test.mjs: an unguarded browser.close() is
// how the 2026-08-29 session leaked seven headless Chromes, two of which were
// still burning ~107% of a core each 2 days 17 hours later. run() can throw
// (the waitForFunction at the top of it has a 180 s timeout), so the close has
// to be in a finally.
try {
  for (const a of order) res[a] = await run(a === 'jit');
} finally {
  await browser.close().catch(() => {});
}
const out = {
  rom, order: order.join(','), warmupVI: WARMUP_VI, windowVI: WINDOW_VI, jitMode: JIT_MODE,
  interp: res.interp, jit: res.jit,
  speedupWallX: res.interp.perFrameMs && res.jit.perFrameMs ? Math.round((res.interp.perFrameMs / res.jit.perFrameMs) * 1000) / 1000 : null,
  speedupCpuX: res.interp.cpuMsPerFrame && res.jit.cpuMsPerFrame ? Math.round((res.interp.cpuMsPerFrame / res.jit.cpuMsPerFrame) * 1000) / 1000 : null,
};
// contamination flags -- a round whose machine state moved is not quotable
out.loadSpread = Math.max(res.interp.loadBefore, res.interp.loadAfter, res.jit.loadBefore, res.jit.loadAfter)
  - Math.min(res.interp.loadBefore, res.interp.loadAfter, res.jit.loadBefore, res.jit.loadAfter);
out.limitMoved = new Set([res.interp.limitBefore, res.interp.limitAfter, res.jit.limitBefore, res.jit.limitAfter]).size > 1;
console.log(JSON.stringify(out, null, 1));
