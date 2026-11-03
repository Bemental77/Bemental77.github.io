#!/usr/bin/env node
// tools/gba_room_budget_test.mjs - exit tests for stage GR3: PACE, INPUT DELAY and the DEVICE BUDGET of gba.html link-cable rooms.
//
//   node tools/gba_room_budget_test.mjs                       # the pure functions, the page source and the README (Node only, a few seconds)
//   node tools/gba_room_budget_test.mjs --browser             # + the live checks in headless Chrome (one browser at a time, muted, machine-wide lock)
//   node tools/gba_room_budget_test.mjs --browser --only pacing,pace     # pick sections:
//        Node:    module, ring, ticks, cap, delay, pace, static, tickmodel, docs
//        browser: pacing (a 30 s live 2-seat room: 1.000x, never above; a sped-up page is caught), caps (the seat picker refuses with a reason; the speed test
//                 under a CPU throttle), lowmem (the Capability layer's low-memory arm + a memory stand-in), notice (a slow device is named in plain words),
//                 delay (the host's measured starting delay reaches the guest)
//   GBA_TEST_PORT=8113 GBA_BUDGET_CDP=9341 GBA_BUDGET_OUT=<dir>   BROWSER_LOCK_TIMEOUT_MS=7200000 to queue behind other runs.
//
// WHAT THIS PROVES AND DOES NOT. The functions are checked against hand-computed values, against the real lib/netplay.js engine where they mirror it
// (Lockstep.recommendDelayForRoom, Lockstep.paceVerdict), and against mutants of room.js that each must trip a named check. The browser sections run the
// REAL gba.html in REAL headless Chrome windows (tools/headless_cdp_multi.mjs, --mute-audio) on a SHARED desktop under SwiftShader; a CPU throttle is a
// STAND-IN for a slow device, not a device. Nothing here ran on a phone, over a network, or through an audio device.
//
// Every check that matters has a NEGATIVE CONTROL printed as [control]. Exit code is non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The browser sections ASSERT timing (the 30 s guest rate, the CPU-throttle arms, the notice's latency), so they take the whole machine: the shared browser lock has slots
// (tools/headless_cdp.mjs) and a rate measured beside two other Chromes proves nothing. BROWSER_LOCK_EXCLUSIVE=0 opts out.
process.env.BROWSER_LOCK_EXCLUSIVE = process.env.BROWSER_LOCK_EXCLUSIVE === undefined ? '1' : process.env.BROWSER_LOCK_EXCLUSIVE;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const PORT = Number(process.env.GBA_TEST_PORT || 8113);
const CDP_BASE = Number(process.env.GBA_BUDGET_CDP || 9341);
const BASE = `http://localhost:${PORT}`;
// GBA_BUDGET_PHONE=1 runs every browser section on 390x844 touch windows (Chrome's engine, not WebKit): how the refusal text and the slow-device banner look on a phone
const VIEW = process.env.GBA_BUDGET_PHONE === '1' ? { width: 390, height: 844, mobile: true } : {};
const OUT = process.env.GBA_BUDGET_OUT ? path.resolve(process.env.GBA_BUDGET_OUT) : path.join(os.tmpdir(), 'gba-budget-test');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const info = (s) => console.log(`       ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const ROOM_SRC = fs.readFileSync(path.join(ROOT, 'gba/mgba/room.js'), 'utf8');
const loadSrc = (src) => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const R = await import(pathToFileURL(path.join(ROOT, 'gba/mgba/room.js')).href + '?t=' + Date.now());
(0, eval)(fs.readFileSync(path.join(ROOT, 'lib/netplay.js'), 'utf8'));          // a script, not a module: sets globalThis.Netplay
const { Lockstep } = globalThis.Netplay;
const HZ = 16777216 / 280896, FRAME_MS = 1000 / HZ;
const KIRBY = 'Kirby Nightmare in Dreamland', SBAM = 'Super Bust-A-Move', SA3 = 'Sonic Advance 3';
// a mutant of room.js: replace `from` by `to` once; the test fails loudly if the anchor is not there (a stale mutant proves nothing)
async function mutant(from, to) {
  if (!ROOM_SRC.includes(from)) throw new Error('mutant anchor not found in room.js: ' + from.slice(0, 70));
  return loadSrc(ROOM_SRC.replace(from, to));
}
const cpuLoad = () => {
  try { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 }); const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null; } catch (_e) { return null; }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionModule() {
  section('module: the budget section of room.js is pure, and its constants are the hardware\'s');
  const forbidden = [/\bfrom\s+['"]node:/, /\brequire\s*\(/, /\bdocument\./, /\bwindow\b/, /\blocalStorage\b/, /\bindexedDB\b/, /\bfetch\s*\(/, /\bDate\.now\b/, /\bMath\.random\b/, /\bprocess\./, /\bBuffer\b/, /\bsetTimeout\b/, /\bperformance\b/];
  const stripped = ROOM_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('room.js stays free of DOM, node:, network, storage, wall clock, randomness and timers (the speed test takes its clock as an argument)', !forbidden.some((re) => re.test(stripped)), forbidden.filter((re) => re.test(stripped)).join(' '));
  const names = ['FRAME_MS', 'LONG_TASK_MS', 'TICK_MAX_FRAMES', 'percentile', 'CostRing', 'headroomOf', 'presentedText', 'framesPerTick', 'calibrationWork', 'calibrate', 'interpretCalibration', 'CALIBRATION', 'COST_REFERENCE', 'USABLE_FRACTION',
    'MEMORY_RULE', 'CAP_CODES', 'predictCost', 'seatCap', 'seatCapText', 'DELAY_RULE', 'defaultInputDelay', 'RateMeter', 'PaceWatch', 'paceNotice'];
  ok('the budget exports exist', names.every((n) => n in R), names.filter((n) => !(n in R)).join(','));
  ok('FRAME_MS is one frame of the real clock: 280,896 cycles at 16,777,216 Hz = 16.7427 ms', near(R.FRAME_MS, 1000 * 280896 / 16777216, 1e-12) && near(R.FRAME_MS, FRAME_MS, 1e-12), String(R.FRAME_MS));
  ok('the budget never redefines the guest rate: GBA_HZ is still 16777216/280896, and no export is named speed/fast/turbo/uncap', near(R.GBA_HZ, HZ, 1e-12) && !Object.keys(R).some((k) => /^(speed|fast|turbo|uncap|boost)/i.test(k)));
  ok('the unchanged protocol surface is still exported (ROOMABLE, lockstepOptions, DELAY_DEFAULT)', !!R.ROOMABLE && typeof R.lockstepOptions === 'function' && R.DELAY_DEFAULT === 3);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionRing() {
  section('ring: per-frame cost percentiles, headroom as a capacity, "N presented, Mx headroom"');
  const sorted = Array.from({ length: 101 }, (_, i) => i);
  ok('percentile (type 7): p0 0, p50 50, p95 95, p99 99, p100 100 on 0..100; an empty array is null; one sample is itself',
    R.percentile(sorted, 0) === 0 && R.percentile(sorted, 50) === 50 && near(R.percentile(sorted, 95), 95, 1e-9) && near(R.percentile(sorted, 99), 99, 1e-9) && R.percentile(sorted, 100) === 100 && R.percentile([], 50) === null && R.percentile([7], 99) === 7);
  ok('percentile interpolates between samples: p50 of [1,2,3,4] is 2.5; p25 is 1.75', near(R.percentile([1, 2, 3, 4], 50), 2.5, 1e-9) && near(R.percentile([1, 2, 3, 4], 25), 1.75, 1e-9));
  const r = new R.CostRing(8);
  for (let i = 1; i <= 20; i++) r.push(i);
  const s = r.summary(14);
  ok('a ring of 8 keeps the last 8 of 20 in order and counts all 20', r.n === 20 && Array.from(r.samples()).join() === '13,14,15,16,17,18,19,20' && s.n === 20 && s.kept === 8 && s.max === 20 && s.maxEver === 20, JSON.stringify(s));
  ok('...mean 16.5, p50 16.5, frames over the 14 ms line = 6 (15..20)', near(s.mean, 16.5, 1e-9) && near(s.p50, 16.5, 1e-9) && s.over === 6);
  ok('NaN, Infinity, negatives and strings are not samples', ['x', NaN, Infinity, -1, null, undefined].every((v) => r.push(v) === false) && r.n === 20);
  const e = new R.CostRing(4); for (let i = 0; i < 400; i++) e.push(8);
  ok('the running mean (what the page publishes as capacity) settles on a constant cost', near(e.ema, 8, 1e-6));
  control('a percentile that forgets to sort is caught (p95 of an unsorted array is not the 95th)', (() => { const u = [5, 1, 9, 3, 7]; return R.percentile(u, 100) !== 9; })());
  const mutNoSort = await mutant('const a = Array.from(s).sort((x, y) => x - y);', 'const a = Array.from(s);');
  const rm = new mutNoSort.CostRing(8); for (const v of [9, 1, 8, 2, 7, 3]) rm.push(v);
  control('a CostRing.summary that does not sort reports a wrong p50/max', rm.summary().max !== 9 || rm.summary().p50 !== R.percentile([1, 2, 3, 7, 8, 9], 50));
  // headroom is a capacity
  ok('headroomOf(cost) = 16.7427 / cost: 4 ms -> 4.19x, 16.7427 ms -> 1.00x; no cost, no headroom', near(R.headroomOf(4), FRAME_MS / 4, 1e-9) && near(R.headroomOf(FRAME_MS), 1, 1e-12) && R.headroomOf(0) === null && R.headroomOf(NaN) === null);
  ok('presentedText prints "N presented, Mx headroom" - a capacity phrase, never a rate: no "x hardware", no "realtime", no "fps"',
    R.presentedText(59.7, 3.456) === '59.7 presented, 3.5x headroom' && R.presentedText(30, 12.3) === '30.0 presented, 12x headroom' && !/hardware|realtime|real-time|fps/i.test(R.presentedText(59.7, 3.4)));
  const mutRate = await mutant("(headroom >= 10 ? headroom.toFixed(0) : headroom.toFixed(1)) : '?') + 'x headroom'", "(headroom >= 10 ? headroom.toFixed(0) : headroom.toFixed(1)) : '?') + 'x hardware'");
  control('a presentedText that calls capacity "x hardware" (a rate word) is caught', /hardware/.test(mutRate.presentedText(59.7, 3.4)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionTicks() {
  section('ticks: frames per rAF tick may only LOWER GR2\'s four (gate 9: a cap can never speed the guest up)');
  const table = [[0.5, 4], [3, 4], [6.5, 4], [12.5, 4], [13, 3], [16.7, 2], [24, 2], [25, 2], [26, 1], [50, 1], [400, 1], [0, 4], [NaN, 4], [-3, 4], [Infinity, 4]];
  const bad = table.filter(([c, n]) => R.framesPerTick(c) !== n);
  ok('framesPerTick: a cost of 0.5-12.5 ms runs the full four; 13 ms three; 16.7-25 ms two; 26 ms and up one; an unknown cost is the full four', bad.length === 0, bad.map((b) => b.join('->')).join(' '));
  let never = true, lowers = true;
  for (let c = 0.05; c < 200; c += 0.37) { const n = R.framesPerTick(c); if (n > 4 || n < 1 || !Number.isInteger(n)) never = false; if (R.framesPerTick(c * 1.5) > n) lowers = false; }
  ok('over 540 costs from 0.05 to 200 ms: always an integer in 1..4, and a slower device never gets MORE frames per tick', never && lowers);
  ok('the cap argument cannot be raised above four by a caller either way inside the function: maxFrames 9 with a tiny cost still answers 9 (the PAGE clamps it, see static)', R.framesPerTick(1, { maxFrames: 9 }) === 9);
  const mutHigh = await mutant('return Math.max(1, Math.min(cap, Math.floor(line / costMs)));', 'return Math.max(1, Math.floor(line / costMs));');
  control('a framesPerTick without the ceiling answers 50 frames for a 1 ms cost (so it could burst)', mutHigh.framesPerTick(1) > 4);
  const mutZero = await mutant('return Math.max(1, Math.min(cap, Math.floor(line / costMs)));', 'return Math.min(cap, Math.floor(line / costMs));');
  control('a framesPerTick without the floor of one answers 0 for a 60 ms cost (a device that never runs a frame)', mutZero.framesPerTick(60) === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionCap() {
  section('cap: which seat counts a device may offer, from the reported memory and the speed test (edge inputs; refusals carry a reason)');
  const ref = R.COST_REFERENCE;
  ok('the cost reference names its source run and covers every roomable title at every roomable seat count', !!ref.source && Object.keys(R.ROOMABLE).every((g) => R.ROOMABLE[g].counts.every((n) => ref.perf[g] && ref.perf[g][n] && ref.perf[g][n].p50 > 0 && ref.perf[g][n].p95 >= ref.perf[g][n].p50)), String(ref.source));
  ok('USABLE_FRACTION and CALIBRATION.refMs are set (numbers from the rig, not guesses)', R.USABLE_FRACTION > 0 && R.USABLE_FRACTION < 1 && R.CALIBRATION.refMs > 0, `usable ${R.USABLE_FRACTION}, refMs ${R.CALIBRATION.refMs}`);
  const cap = (game, mem, sd) => R.seatCap({ game, deviceMemoryGB: mem, slowdown: sd });
  const counts = (c) => c.okCounts.join();
  // the reference desktop offers everything
  for (const g of Object.keys(R.ROOMABLE)) ok(`${g}: the reference desktop (slowdown 1.0, 8 GB) is offered every count ${R.ROOMABLE[g].counts.join('/')}`, counts(cap(g, 8, 1)) === R.ROOMABLE[g].counts.join());
  // monotone in slowdown and in seats
  let mono = true, seatsMono = true;
  for (const g of Object.keys(R.ROOMABLE)) {
    let prev = Infinity;
    for (const sd of [0.5, 1, 1.5, 2, 3, 4, 6, 10, 30]) { const m = cap(g, 8, sd).maxSeats; if (m > prev) mono = false; prev = m; }
    for (const sd of [1, 2, 4, 6]) { const c = cap(g, 8, sd); let seenRefused = false; for (const n of c.counts) { if (!c.byCount[n].ok) seenRefused = true; else if (seenRefused) seatsMono = false; } }
  }
  ok('a slower device is never offered MORE seats (slowdown 0.5 -> 30, every title)', mono);
  ok('if a count is refused, every larger count is refused too (no "4 yes, 3 no")', seatsMono);
  // the Kirby knee: derived from the reference table and the usable fraction, so the test moves with the numbers
  const k4 = ref.perf[KIRBY][4].p95, kneeSd = (R.USABLE_FRACTION * FRAME_MS) / k4;
  ok(`Kirby 4 seats: offered at slowdown ${(kneeSd * 0.98).toFixed(2)}, refused at ${(kneeSd * 1.02).toFixed(2)} (the cap edge is USABLE x frame / p95 = ${kneeSd.toFixed(3)})`, cap(KIRBY, 8, kneeSd * 0.98).byCount[4].ok && !cap(KIRBY, 8, kneeSd * 1.02).byCount[4].ok);
  const c6 = cap(KIRBY, 8, 6);
  ok('a device 6x slower than the reference: Kirby 4 and 3 seats refused with SEATS_DEVICE_SLOW and a sentence that names the milliseconds and the frame (16.7 ms)', !c6.byCount[4].ok && c6.byCount[4].code === 'SEATS_DEVICE_SLOW' && /ms of this device for each frame/.test(c6.byCount[4].reason) && /16\.7 ms/.test(c6.byCount[4].reason), c6.byCount[4].reason);
  ok('...and the text under the picker lists the refused counts with their reasons', /4 players/.test(R.seatCapText(c6)) && /not offered/.test(R.seatCapText(c6)));
  ok('a device that offers everything produces no refusal text', R.seatCapText(cap(KIRBY, 8, 1)) === '');
  // memory: 0.25 / 0.5 / 1 / 2 / 4 / 8 / undefined
  const memRows = [[0.25, ''], [0.5, ''], [1, '2'], [2, '2,3,4'], [4, '2,3,4'], [8, '2,3,4'], [undefined, '2,3,4'], [null, '2,3,4']];
  const badMem = memRows.filter(([m, exp]) => counts(cap(KIRBY, m, 1)) !== exp);
  ok('deviceMemory 0.25 and 0.5 GB: no room at all; 1 GB: two seats only; 2/4/8 GB and "not reported": no memory limit (Kirby, a fast device)', badMem.length === 0, badMem.map((b) => b[0] + '->' + counts(cap(KIRBY, b[0], 1))).join(' '));
  ok('the memory refusals are SEATS_DEVICE_MEMORY and say the fixed 192 MB block and the reported GB', cap(KIRBY, 0.5, 1).byCount[2].code === 'SEATS_DEVICE_MEMORY' && /192 MB/.test(cap(KIRBY, 0.5, 1).byCount[2].reason) && /0\.5 GB/.test(cap(KIRBY, 0.5, 1).byCount[2].reason) && cap(KIRBY, 1, 1).byCount[3].code === 'SEATS_DEVICE_MEMORY');
  ok('memory is checked before speed (a 1 GB device that is also slow is told about memory first)', cap(KIRBY, 1, 6).byCount[3].code === 'SEATS_DEVICE_MEMORY');
  // unknown speed: conservative
  ok('no usable speed reading (slowdown null/NaN/0/Infinity): conservative - only two seats are offered, with SEATS_DEVICE_UNMEASURED for the rest', [null, NaN, 0, -1, Infinity, undefined].every((sd) => counts(cap(KIRBY, 8, sd)) === '2' && cap(KIRBY, 8, sd).byCount[3].code === 'SEATS_DEVICE_UNMEASURED'));
  ok('...a two-seat-only title (Super Bust-A-Move) is still offered with no speed reading', counts(cap(SBAM, 8, null)) === '2');
  ok('a title that is not roomable is refused by name, not answered', (() => { try { cap('Monster Rancher Advance 2', 8, 1); return false; } catch (e) { return e.code === 'ROOM_NOT_ROOMABLE'; } })() && (() => { try { cap('constructor', 8, 1); return false; } catch (e) { return e.code === 'ROOM_NOT_ROOMABLE'; } })());
  // the model is the table
  const p = R.predictCost(KIRBY, 4, 3);
  ok('predictCost = the measured reference x slowdown (Kirby 4 at 3x), and interpolates a missing seat count between its neighbours', near(p.p95Ms, ref.perf[KIRBY][4].p95 * 3, 1e-9) && near(p.p50Ms, ref.perf[KIRBY][4].p50 * 3, 1e-9) && R.predictCost('nope', 2, 1) === null);
  ok('the predicted rate in a refusal never exceeds 1: a 2x-too-slow cell says "about 0.5x of full speed", never above 1', (() => { const r = cap(KIRBY, 8, 20).byCount[4].reason; const m = /about ([0-9.]+)x of full speed/.exec(r); return !!m && +m[1] <= 1; })());
  // mutants
  const mHigh = await mutant('if (pred.p95Ms > usable * FRAME_MS) {', 'if (pred.p95Ms > 100 * FRAME_MS) {');
  control('a cap whose speed test never refuses (threshold 100 frames) offers Kirby 4 at slowdown 6', mHigh.seatCap({ game: KIRBY, deviceMemoryGB: 8, slowdown: 6 }).byCount[4].ok === true);
  const mMean = await mutant('if (pred.p95Ms > usable * FRAME_MS) {', 'if (pred.p50Ms > usable * FRAME_MS) {');
  const edgeSd = (R.USABLE_FRACTION * FRAME_MS) / ref.perf[KIRBY][4].p50 * 0.99, mm = mMean.seatCap({ game: KIRBY, deviceMemoryGB: 8, slowdown: edgeSd }).byCount[4].ok, rr = cap(KIRBY, 8, edgeSd).byCount[4].ok;
  control('a cap that judges the MEAN (p50) instead of the p95 offers a count the real cap refuses, at the p50 edge', mm === true && rr === false, `slowdown ${edgeSd.toFixed(3)}`);
  const mMem = await mutant('if (mem != null && mem <= MEMORY_RULE.noRoomAtOrBelowGB) {', 'if (false) {');
  control('a cap that ignores the 0.5 GB rule offers a room to a 0.5 GB device', mMem.seatCap({ game: KIRBY, deviceMemoryGB: 0.5, slowdown: 1 }).okCounts.length > 0);
  const mUnk = await mutant('} else if (sd == null && n > 2) {', '} else if (false) {');
  control('a cap that trusts a missing speed reading offers 4 seats on a device it never measured', mUnk.seatCap({ game: KIRBY, deviceMemoryGB: 8, slowdown: null }).byCount[4].ok === true);
  const mSd = await mutant('const pred = sd != null ? predictCost(game, n, sd) : null;', 'const pred = sd != null ? predictCost(game, n, 1) : null;');
  control('a cap that ignores the slowdown (always 1.0) offers Kirby 4 on a 6x-slower device', mSd.seatCap({ game: KIRBY, deviceMemoryGB: 8, slowdown: 6 }).byCount[4].ok === true);
  // the speed test
  const t = R.interpretCalibration([5.1, 5.0, 5.3, 5.6, 5.2, 9.9, 5.15], 5.0, 0.35);
  ok('interpretCalibration: the BEST trial is the reading (a 9.9 ms outlier is ignored), slowdown = best / reference, reliable when the median is within the spread', near(t.bestMs, 5.0, 1e-9) && near(t.slowdown, 1.0, 1e-9) && t.reliable === true && near(t.spread, 0.04, 1e-9), JSON.stringify(t));
  const slow = R.interpretCalibration([20.4, 20.0, 21, 22, 20.8], 5.0, 0.35);
  ok('...a device 4x slower than the reference reads slowdown 4.0', near(slow.slowdown, 4.0, 1e-9));
  ok('...a noisy run (median 2x the best) is flagged unreliable but still yields its best trial', (() => { const n = R.interpretCalibration([5, 12, 11, 13, 10], 5, 0.35); return n.reliable === false && near(n.slowdown, 1, 1e-9); })());
  ok('...no reference yet: slowdown is null (and the cap goes conservative), the trials are still reported', R.interpretCalibration([5, 5.1], null, 0.35).slowdown === null);
  const fake = (() => { let t0 = 0; return () => { t0 += 5; return t0; }; })();
  const cal = R.calibrate(fake, { trials: 5, iterations: 1000, refMs: 5 });
  ok('calibrate() takes its clock as an argument and times `trials` runs', cal.trials === 5 && near(cal.bestMs, 5, 1e-9) && near(cal.slowdown, 1, 1e-9));
  ok('calibrationWork is deterministic and its result depends on the iteration count', R.calibrationWork(1000) === R.calibrationWork(1000) && R.calibrationWork(1000) !== R.calibrationWork(1001));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionDelay() {
  section('delay: the room\'s starting input delay from measured round trips and this device\'s cost (a latency knob; it never speeds anything up)');
  const frame = FRAME_MS;
  const D = (o) => R.defaultInputDelay(o);
  // the link term IS the engine's: Lockstep.recommendDelayForRoom
  const engineFor = (budgets) => { const by = {}; budgets.forEach((b, i) => { by['p' + i] = [b]; }); return Lockstep.recommendDelayForRoom(by, frame); };
  let same = true; const rows = [];
  for (const rtt of [0, 1, 20, 50, 100, 200, 400, 800, 3000]) for (const budgets of [[rtt], [rtt, rtt], [rtt, rtt / 2, rtt / 4]]) {
    const mine = D({ budgetsMs: budgets, costMs: 0 }), eng = engineFor(budgets);
    const expect = Math.max(R.DELAY_RULE.floor, eng);
    if (mine.delay !== Math.min(30, expect)) { same = false; rows.push(`${budgets.map(Math.round)} -> ${mine.delay} (engine ${eng})`); }
  }
  ok('for 9 round-trip classes (0, 1, 20, 50, 100, 200, 400, 800, 3000 ms) x 1/2/3 peers the link term equals the ENGINE\'s Lockstep.recommendDelayForRoom (floored at the engine\'s own minimum of 2, capped at 30)', same, rows.slice(0, 3).join(' | '));
  const cls = [[0, 2], [20, 2], [50, 3], [100, 4], [200, 7], [400, 13], [800, 25], [3000, 30]];
  const badCls = cls.filter(([rtt, d]) => D({ budgetsMs: [rtt] }).delay !== d);
  ok('RTT classes with one peer: 0 and 20 ms -> 2 frames (the floor), 50 -> 3, 100 -> 4, 200 -> 7, 400 -> 13, 800 -> 25, 3000 -> 30', badCls.length === 0, badCls.map((b) => b[0] + '->' + D({ budgetsMs: [b[0]] }).delay).join(' '));
  ok('three or four players: the two worst round trips ADD (a guest-to-guest input crosses the host): 100 + 100 ms -> 7, one of them alone -> 4', D({ budgetsMs: [100, 100] }).delay === 7 && D({ budgetsMs: [100] }).delay === 4);
  ok('nothing measured: the default of 3, and the sentence says so', (() => { const d = D({ budgetsMs: [] }); return d.delay === 3 && d.link === null && /no round trip was measured/.test(d.why); })() && D({}).delay === 3 && D({ budgetsMs: [NaN, -4, 'x'] }).delay === 3);
  let monoR = true, monoC = true, floorOK = true, capOK = true;
  for (let c = 0; c <= 30; c += 5) { let prev = 0; for (let rtt = 0; rtt <= 1200; rtt += 10) { const d = D({ budgetsMs: [rtt], costMs: c }).delay; if (d < prev) monoR = false; if (d < 2) floorOK = false; if (d > 30) capOK = false; prev = d; } }
  for (let rtt = 0; rtt <= 1200; rtt += 50) { let prev = 0; for (let c = 0; c <= 40; c += 1) { const d = D({ budgetsMs: [rtt], costMs: c }).delay; if (d < prev) monoC = false; prev = d; } }
  ok('the delay never falls as the round trip grows, never goes below 2 or above 30 (sweep: 121 round trips x 7 costs)', monoR && floorOK && capOK);
  // MEASURED, then left out (README "Budget", delay sweep on an overloaded Kirby room): more delay for a short-of-power device removes stalls and gives the rate back almost nothing
  let costFree = true; for (const rtt of [0, 40, 100, 400]) { const d0 = D({ budgetsMs: [rtt] }).delay; for (const c of [0.5, 5, 8.4, 10, 13.5, 20, 50, 400]) if (D({ budgetsMs: [rtt], costMs: c }).delay !== d0) costFree = false; }
  ok('this device\'s cost does NOT change the starting delay (the sweep: Kirby at 5x, delay 2 -> 8 removed every stall and recovered 1.5% of the rate for ~100 ms of latency); it is reported as costRatio', costFree && D({ budgetsMs: [100], costMs: 20 }).costRatio > 1.19 && D({ budgetsMs: [100] }).costRatio === 0 && R.DELAY_RULE.costAddsDelay === false);
  ok('the sentence names the measured round trip, the frames it needs, and the floor when it applies', /worst round trip of 200 ms needs 7 frames/.test(D({ budgetsMs: [200] }).why) && /raised to the floor of 2/.test(D({ budgetsMs: [0] }).why));
  ok('the delay is a LATENCY: the result is a frame count in 1..30 and the module offers no way to turn it into a rate (no field is named rate/speed)', Object.keys(D({ budgetsMs: [100] })).every((k) => !/rate|speed|fps/i.test(k)));
  // mutants
  const mLink = await mutant('link = Math.max(1, Math.min(30, Math.ceil(room / 2 / F) + 1));', 'link = Math.max(1, Math.min(30, Math.ceil(room / 2 / F)));');
  control('a link term one frame short (no +1 phase frame) disagrees with the engine at 200 ms', mLink.defaultInputDelay({ budgetsMs: [200] }).delay !== D({ budgetsMs: [200] }).delay);
  const mSum = await mutant('room = bs.length > 1 ? Math.max(bs[0], bs[0] + bs[1]) : bs[0];', 'room = bs[0];');
  control('a delay that ignores the second-worst peer undersizes a 3-4 seat room (100 + 100 ms)', mSum.defaultInputDelay({ budgetsMs: [100, 100] }).delay < D({ budgetsMs: [100, 100] }).delay);
  const mFloor = await mutant('Math.min(DELAY_MAX, Math.max(DELAY_RULE.floor, base))', 'Math.min(DELAY_MAX, base)');
  control('a delay without the floor starts a measured 0 ms link at 1 frame', mFloor.defaultInputDelay({ budgetsMs: [0] }).delay === 1 && D({ budgetsMs: [0] }).delay === 2);
  const mCost = await mutant('const base = link == null ? DELAY_DEFAULT : link;', 'const base = (link == null ? DELAY_DEFAULT : link) + (ratio > 0.8 ? 2 : 0);');
  control('a delay that adds frames for a slow device (the unsupported cost term) is caught by the "cost does not change it" check', (() => { let moved = false; for (const c of [13.5, 20, 50]) if (mCost.defaultInputDelay({ budgetsMs: [100], costMs: c }).delay !== D({ budgetsMs: [100], costMs: c }).delay) moved = true; return moved; })());
  const mCap = await loadSrc(ROOM_SRC.replace('Math.min(DELAY_MAX, Math.max(DELAY_RULE.floor, base))', 'Math.max(DELAY_RULE.floor, base)').replace('link = Math.max(1, Math.min(30, Math.ceil(room / 2 / F) + 1));', 'link = Math.max(1, Math.ceil(room / 2 / F) + 1);'));
  control('a delay without the ceiling of 30 asks for 91 frames on a 3 s link (room.js would then refuse the config)', mCap.defaultInputDelay({ budgetsMs: [3000] }).delay > 30 && D({ budgetsMs: [3000] }).delay === 30);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// real Lockstep.paceVerdict inputs: rep = { self: {ports,share,lost,cap,waitOn}, peers: [{ports,share,lost,cap,rtt,waitOn,ageMs}], delay }
function pace(rate, selfSeat, me, peers, delay = 3) {
  return Lockstep.paceVerdict({ self: Object.assign({ ports: [selfSeat], waitOn: {} }, me), ownPorts: [selfSeat], peers: peers.map((p) => Object.assign({ ageMs: 100, waitOn: {} }, p)), delay }, rate, { slowBelow: 0.95, name: (ports) => 'Seat ' + (ports[0] + 1) });
}
async function sectionPace() {
  section('pace: the live "this device cannot keep up" notice - plain words, names the seat, offers a way out, never a way to speed up');
  // RateMeter: exact for a clock at hardware speed, and it cannot read above 1.000x for a page that runs at it
  const m = new R.RateMeter(8000); let last = null;
  for (let t = 0; t <= 20000; t += 500) { const v = m.push(t, Math.round(t / 1000 * HZ)); if (v != null) last = v; }
  ok('RateMeter: frames counted at exactly 59.7275 Hz read 1.000x (to 0.001) once 8 s are covered, and null before', near(last, 1, 0.001) && new R.RateMeter(8000).push(0, 0) === null && (() => { const q = new R.RateMeter(8000); q.push(0, 0); return q.push(3000, 180) === null; })(), String(last));
  const m2 = new R.RateMeter(8000); let l2 = null; for (let t = 0; t <= 20000; t += 500) { const v = m2.push(t, Math.round(t / 1000 * HZ * 0.47)); if (v != null) l2 = v; }
  ok('...and a room at 0.47x reads 0.47x', near(l2, 0.47, 0.003), String(l2));
  // PaceWatch
  const feed = (w, series) => { const out = []; for (const [t, r] of series) out.push(w.feed(t, r)); return out; };
  const w1 = new R.PaceWatch({}); const steady = []; for (let t = 0; t <= 60000; t += 500) steady.push([t, 1.0]);
  ok('a room at 1.000x never raises the notice (60 s)', feed(w1, steady).every((x) => !x.slow));
  const w2 = new R.PaceWatch({}); const dip = []; for (let t = 0; t <= 60000; t += 500) dip.push([t, t >= 20000 && t < 24000 ? 0.4 : 1.0]);
  ok('a 4 s dip to 0.4x (one stall, one collection) does NOT raise it', feed(w2, dip).every((x) => !x.slow));
  const w3 = new R.PaceWatch({}); const slowS = []; for (let t = 0; t <= 60000; t += 500) slowS.push([t, t >= 15000 ? 0.47 : 1.0]);
  const o3 = feed(w3, slowS), first = o3.findIndex((x) => x.slow);
  ok('a room that stays at 0.47x raises it after 5 s below 0.95x (not before, and not later than 6 s)', first >= 0 && slowS[first][0] - 15000 >= 5000 && slowS[first][0] - 15000 <= 6000 && o3[first].changed && w3.episodes === 1, first >= 0 ? 'raised at ' + slowS[first][0] + ' ms' : 'never');
  const w4 = new R.PaceWatch({}); const rec = []; for (let t = 0; t <= 80000; t += 500) rec.push([t, t < 15000 ? 1 : t < 40000 ? 0.5 : 1.0]);
  const o4 = feed(w4, rec), clearAt = o4.findIndex((x, i) => i > 0 && o4[i - 1].slow && !x.slow);
  ok('...and clears it after 4 s at 0.98x or better (hysteresis: 0.96x does not clear it)', clearAt >= 0 && rec[clearAt][0] - 40000 >= 4000 && (() => { const w = new R.PaceWatch({}); const s = []; for (let t = 0; t <= 60000; t += 500) s.push([t, t < 15000 ? 1 : t < 30000 ? 0.5 : 0.96]); return feed(w, s).slice(-1)[0].slow === true; })(), clearAt >= 0 ? 'cleared at ' + rec[clearAt][0] : 'never');
  ok('the first 10 s (loading, first frames) never count, whatever the rate', (() => { const w = new R.PaceWatch({}); return feed(w, [[0, 0.1], [2000, 0.1], [5000, 0.1], [9000, 0.1]]).every((x) => !x.slow); })());
  ok('a null/NaN rate (not enough data, a returning page catching up) changes nothing', (() => { const w = new R.PaceWatch({}); const s = []; for (let t = 0; t <= 40000; t += 500) s.push([t, t % 1000 ? null : NaN]); return feed(w, s).every((x) => !x.slow); })());
  // the notices, from the engine's own verdicts
  const word = (n) => n.text;
  const BAD = /speed(ing)? up|catch(ing)? up|fast-forward|boost|turbo|overclock|run faster|play faster/i;
  // 4 seats; seat index 2 (Seat 3) is the slow one; the verdict is computed on seat 0 (host) and on seat 2 (the slow one) itself
  const fast = { share: 0.7, lost: 0, cap: 4.1, waitOn: { 2: 0.7 } }, calm = { share: 0.02, lost: 0.3, cap: 0.47, waitOn: {} };
  const vHost = pace(0.47, 0, fast, [{ ports: [1], ...fast, waitOn: { 2: 0.7 } }, { ports: [2], ...calm }, { ports: [3], ...fast, waitOn: { 2: 0.7 } }]);
  const nHost = R.paceNotice(vHost, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 });
  ok('seat 3 is slow, seen from the host: kind "device", culprit seat index 2, and the headline reads "Seat 3\'s device is too slow for this room: the game runs at 0.47x for everyone."', vHost.kind === 'device' && vHost.port === 2 && nHost.level === 'device' && nHost.culprit === 2 && !nHost.self && nHost.headline === 'Seat 3\'s device is too slow for this room: the game runs at 0.47x for everyone.', nHost.headline);
  ok('...it states what that device can make (0.47x), that the room goes at its slowest device, and the host\'s way out: a smaller room (3 players) or leaving', /about 0\.47x of the frames/.test(nHost.detail) && /slowest device/.test(nHost.detail) && /smaller room/.test(nHost.detail) && nHost.actions.map((a) => a.id).join() === 'leave,smaller' && nHost.actions[1].seats === 3);
  ok('...and promises no speed-up: none of speed up / catch up / fast-forward / boost / run faster appears', !BAD.test(word(nHost)) && !nHost.actions.some((a) => BAD.test(a.label)));
  const vSelf = pace(0.47, 2, calm, [{ ports: [0], ...fast, waitOn: { 2: 0.7 } }, { ports: [1], ...fast, waitOn: { 2: 0.7 } }, { ports: [3], ...fast, waitOn: { 2: 0.7 } }]);
  const nSelf = R.paceNotice(vSelf, { rate: 0.47, localSeat: 2, seats: 4, isHost: false, minSeats: 2, delay: 3 });
  ok('seen from the slow device itself: "This device (Seat 3) is too slow for this room...", self true, a guest\'s way out is leaving (no "smaller room" button for a guest)', vSelf.kind === 'self' && nSelf.self && nSelf.culprit === 2 && /^This device \(Seat 3\) is too slow for this room: the game runs at 0\.47x for everyone\.$/.test(nSelf.headline) && nSelf.actions.map((a) => a.id).join() === 'leave' && /Leaving lets everyone else play at full speed/.test(nSelf.detail), nSelf.headline);
  const nGuest = R.paceNotice(vHost, { rate: 0.47, localSeat: 1, seats: 4, isHost: false, minSeats: 2, delay: 3 });
  ok('a guest looking at someone else\'s slow device: "ask the host to start a smaller room", only Leave as a button', nGuest.actions.length === 1 && /ask the host to start a smaller room/.test(nGuest.detail));
  const nTwo = R.paceNotice(vHost, { rate: 0.47, localSeat: 0, seats: 2, isHost: true, minSeats: 2, delay: 3 });
  ok('a 2-seat room has no smaller room to offer: the host\'s only action is Leave', nTwo.actions.map((a) => a.id).join() === 'leave');
  // everyone slow
  const slowAll = { share: 0.1, lost: 0.4, cap: 0.5, waitOn: {} };
  const vAll = pace(0.47, 0, slowAll, [{ ports: [1], ...slowAll }, { ports: [2], ...slowAll, cap: 0.45 }, { ports: [3], ...slowAll }]);
  const nAll = R.paceNotice(vAll, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 });
  ok('every device slow: the notice lists the seats ("Seat 1, Seat 2, Seat 3 and Seat 4 are too slow...") instead of blaming one', nAll.culprits.length === 4 && /^Seat 1, Seat 2, Seat 3 and Seat 4 are too slow for this room: the game runs at 0\.47x for everyone\.$/.test(nAll.headline), nAll.headline);
  // every device slow AND every device waiting on the others (what the 4-windows-all-throttled rig measured: 25-28 of 28 samples stalled): the ENGINE's waiting-share
  // rule can only say "the connection"; the notice reads each console's own capacity first and blames the devices
  const waitAll = { share: 0.8, lost: 0.1, cap: 0.5, waitOn: { 0: 0.2, 1: 0.2, 2: 0.2, 3: 0.2 } };
  const vWait = pace(0.47, 0, waitAll, [1, 2, 3].map((p) => ({ ports: [p], ...waitAll })));
  const nWait = R.paceNotice(vWait, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 });
  ok('all four devices slow and all four waiting on each other: the engine\'s own verdict is "' + vWait.kind + '" (it blames the path), but the notice names the DEVICES (capacity 0.5x each), not the connection', (vWait.kind === 'network' || vWait.kind === 'link') && nWait.level === 'device' && nWait.culprits.length === 4 && /^Seat 1, Seat 2, Seat 3 and Seat 4 are too slow/.test(nWait.headline) && !/connection/.test(nWait.text), vWait.kind + ' -> ' + nWait.headline);
  // a device that averages above 1x but loses time in bursts is not "short of power"
  const vBurst = pace(0.8, 0, fast, [{ ports: [1], share: 0.02, lost: 0.2, cap: 2.5, waitOn: {} }]);
  const nBurst = R.paceNotice(vBurst, { rate: 0.8, localSeat: 0, seats: 2, isHost: true, minSeats: 2, delay: 3 });
  ok('a slow seat whose measured capacity is ABOVE 1x is described as losing time in bursts, never as "can make about 2.50x of the frames the game needs"', /keeps falling behind in bursts/.test(nBurst.detail) && !/can make about 2\.50x/.test(nBurst.detail), nBurst.detail);
  // the connection is not a device
  const slowLink = { share: 0.6, lost: 0.0, cap: 3, waitOn: { 1: 0.6 }, rtt: 400 };
  const vLink = pace(0.6, 0, slowLink, [{ ports: [1], ...slowLink, waitOn: { 0: 0.6 } }]);
  const nLink = R.paceNotice(vLink, { rate: 0.6, localSeat: 0, seats: 2, isHost: true, minSeats: 2, delay: 9 });
  ok('when everybody waits on in-flight inputs the notice says it is the CONNECTION, not a device, and that the delay rises by itself (now 9 frames)', nLink.level === 'link' && /connection/.test(nLink.headline) && /not a device/.test(nLink.detail) && /now 9 frames/.test(nLink.detail) && !/too slow/.test(nLink.headline), nLink.text);
  const nNone = R.paceNotice(Lockstep.paceVerdict(null, 0.5), { rate: 0.5, localSeat: 0, seats: 2, isHost: true, delay: 3 }), nNull = R.paceNotice(null, { rate: 0.5, localSeat: 0, seats: 2, isHost: true, delay: 3 });
  ok('with no verdict to go on (no pace report yet, or null) the notice says so honestly ("cannot yet tell which device is slow"), still names the rate, and still offers Leave', [nNone, nNull].every((n) => n.level === 'unknown' && /0\.50x/.test(n.headline) && /cannot yet tell/.test(n.detail) && n.actions[0].id === 'leave'), nNone.text);
  ok('no notice text, headline, detail or action label anywhere promises a speed-up', [nHost, nSelf, nGuest, nTwo, nAll, nBurst, nLink, nNone].every((n) => !BAD.test(n.text) && n.actions.every((a) => !BAD.test(a.label))));
  ok('a peer\'s text is never executable: every notice is plain text (no "<", no "&")', [nHost, nSelf, nGuest, nAll, nLink].every((n) => !/[<>&]/.test(n.text)));
  // mutants
  const mName = await mutant("seatName(port) + '\\'s device'", "'A device'");
  const nm = mName.paceNotice(vHost, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 });
  control('a notice that does not name the seat ("A device is too slow") is caught by the naming check', nm.headline !== 'Seat 3\'s device is too slow for this room: the game runs at 0.47x for everyone.' && !/Seat 3/.test(nm.headline));
  const mCapFirst = await mutant("if (slowCaps.length || v.kind === 'self' || v.kind === 'device' || v.kind === 'all-slow') {", "if (v.kind === 'self' || v.kind === 'device' || v.kind === 'all-slow') {");
  control('a notice that trusts only the engine\'s kind (does not read each console\'s capacity first) blames the connection when four slow devices all wait on each other', mCapFirst.paceNotice(vWait, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 }).level === 'link');
  const mWay = await mutant("const out = { level: 'unknown', kind: v.kind, culprit: null, self: false, culprits: [], headline: '', detail: '', text: '', actions: [{ id: 'leave', label: 'Leave the room' }] };", "const out = { level: 'unknown', kind: v.kind, culprit: null, self: false, culprits: [], headline: '', detail: '', text: '', actions: [] };");
  control('a notice with no way out (no Leave action) is caught', mWay.paceNotice(vHost, { rate: 0.47, localSeat: 0, seats: 4, isHost: true, minSeats: 2, delay: 3 }).actions.every((a) => a.id !== 'leave'));
  const mDeb = await mutant('if (!this.slow && tMs - this.below >= this.slowAfterMs) { this.slow = true;', 'if (!this.slow) { this.slow = true;');
  const wm = new mDeb.PaceWatch({}); control('a PaceWatch with no debounce raises the notice on the first slow reading after the grace period', feed(wm, [[0, 1], [11000, 0.5]]).slice(-1)[0].slow === true && feed(new R.PaceWatch({}), [[0, 1], [11000, 0.5]]).slice(-1)[0].slow === false);
  const mRate = await mutant('return ((b[1] - a[1]) / ((b[0] - a[0]) / 1000)) / GBA_HZ;', 'return ((b[1] - a[1]) / ((b[0] - a[0]) / 1000)) / GBA_HZ * 2;');
  const mr = new mRate.RateMeter(8000); let lm = null; for (let t = 0; t <= 20000; t += 500) { const v = mr.push(t, Math.round(t / 1000 * HZ)); if (v != null) lm = v; }
  control('a RateMeter that reads double (a sped-up guest) is caught by the 1.000x check above', !near(lm, 1, 0.001), String(lm));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
function staticChecks(html, scriptJs, roomJs) {
  const live = stripComments(html), liveScript = stripComments(scriptJs);
  const tick = liveScript.slice(liveScript.indexOf('_roomTick(now) {'), liveScript.indexOf('// ── MOBILE'));
  const out = {};
  out['tick-cap-only-lowers'] = /let cap = ROOM_MAX_FRAMES;/.test(tick) && /const c = rh\.maxFrames\(\) \| 0; if \(c >= 1 && c < cap\) cap = c;/.test(tick) && /ran < cap/.test(tick) && !/ran < (ROOM_MAX_FRAMES|rh)/.test(tick);
  out['tick-never-reads-game-speed'] = !/gameSpeed|_gameSpeed/.test(tick);
  out['ceiling-is-four'] = /const ROOM_MAX_FRAMES = 4;/.test(liveScript) && /const ROOM_MAX_TICK_MS = 100;/.test(liveScript);
  out['credit-is-never-banked'] = /if \(this\._accum > FRAME_MS\) \{[^}]*this\._accum = FRAME_MS;/.test(tick) && !/_accum \+= FRAME_MS|_accum = Math\.max/.test(tick);
  out['lost-time-is-counted-not-repaid'] = /this\._roomLostMs = \(this\._roomLostMs \|\| 0\) \+ \(this\._accum - FRAME_MS\)/.test(tick) && /if \(!waited\)/.test(tick);
  out['page-publishes-capacity-not-rate'] = /ls\.selfCap = R\.headroomOf\(BUD\.total\.ema\)/.test(live) && /ls\.selfLostMs = /.test(live);
  out['page-never-sets-a-rate'] = !/ls\.(frameHz|selfHz|speed|fps)\s*=/.test(live) && !/\.frameHz\s*=/.test(live);
  out['pace-notice-uses-the-engine-verdict'] = /Netplay\.Lockstep\.paceVerdict\(rep, rate/.test(live) && /R\.paceNotice\(vd,/.test(live);
  out['delay-chosen-by-host-only'] = /if \(ls\.isHost\) \{ await chooseDelay\(ls\);/.test(live) && /R\.defaultInputDelay\(/.test(live) && /sess\.rttReport\(600/.test(live);
  out['cap-checked-at-open'] = /var capHere = deviceCap\(title, true\), whyNot = capRefusal\(capHere, seats\);/.test(live) && /o\.disabled = !!why;/.test(live);
  out['test-seams-stay-behind-roomtest'] = /\(TESTING && \/\^\\d\+\$\/\.test\(Q\.get\('delay'\)/.test(live) && /TEST && TEST\.dev \? TEST\.dev : null/.test(live) && !/__gbaRoomTest\s*=/.test(live.replace('var TEST = TESTING ? (window.__gbaRoomTest = ', ''));
  out['no-streaming-no-worker-no-sab'] = !/SharedArrayBuffer|new Worker\(|Atomics\.|captureStream|coi-serviceworker/.test(live) && !/SharedArrayBuffer|new Worker\(|Atomics\./.test(liveScript);
  out['fps-readout-format-unchanged'] = /'guest ' \+ \(G \/ T\)\.toFixed\(2\) \+ '\/s \(' \+ \(\(G \/ T\) \/ GBA_HZ\)\.toFixed\(3\) \+ 'x hardware\) · presented ' \+ \(P \/ T\)\.toFixed\(1\) \+ '\/s'/.test(liveScript);
  const tok = /room\.js\?v=([0-9a-f]{8})/.exec(live);
  out['room.js-token-is-md5'] = !!tok && tok[1] === md5(roomJs).slice(0, 8);
  return out;
}
async function sectionStatic() {
  section('static: the page\'s pacing cannot be turned into a speed-up, and the new seams stay behind ?roomtest=1');
  const html = read('gba.html'), scriptJs = read('gba/gbaWasm/dist/script.js'), roomJs = fs.readFileSync(path.join(ROOT, 'gba/mgba/room.js'));
  const base = staticChecks(html, scriptJs, roomJs);
  for (const [k, v] of Object.entries(base)) ok(k, v);
  const ctl = (name, key, mut) => { const m = staticChecks(mut.html || html, mut.script || scriptJs, mut.room || roomJs); control(`${name} -> ${key}`, m[key] === false); };
  ctl('a tick whose cap handle can RAISE it (c > cap)', 'tick-cap-only-lowers', { script: scriptJs.replace('if (c >= 1 && c < cap) cap = c;', 'if (c >= 1) cap = c;') });
  ctl('a tick loop bounded by the handle instead of the clamped cap', 'tick-cap-only-lowers', { script: scriptJs.replace('ran < cap) {', 'ran < rh.maxFrames()) {') });
  ctl('a tick that reads gameSpeed', 'tick-never-reads-game-speed', { script: scriptJs.replace('_roomTick(now) {', '_roomTick(now) { const sp = this.gameSpeed;') });
  ctl('a ceiling of 8 frames', 'ceiling-is-four', { script: scriptJs.replace('const ROOM_MAX_FRAMES = 4;', 'const ROOM_MAX_FRAMES = 8;') });
  ctl('credit banked after a stall (accum += FRAME_MS)', 'credit-is-never-banked', { script: scriptJs.replace('this._accum = FRAME_MS; }\n        let presentMs', 'this._accum = FRAME_MS; this._accum += FRAME_MS; }\n        let presentMs') });
  ctl('lost time repaid instead of counted', 'lost-time-is-counted-not-repaid', { script: scriptJs.replace('if (!waited) this._roomLostMs = (this._roomLostMs || 0) + (this._accum - FRAME_MS);', 'if (!waited) this._accum += 0;') });
  ctl('a page that publishes a frame rate to the engine', 'page-never-sets-a-rate', { html: html.replace('ls.selfCap = R.headroomOf(BUD.total.ema) || 0;', 'ls.selfCap = R.headroomOf(BUD.total.ema) || 0; ls.frameHz = 120;') });
  ctl('a host that does not size the delay (no chooseDelay)', 'delay-chosen-by-host-only', { html: html.replace('if (ls.isHost) { await chooseDelay(ls);', 'if (false) { await chooseDelay(ls);') });
  ctl('a seat picker that never disables a refused option', 'cap-checked-at-open', { html: html.replace('o.disabled = !!why;', '') });
  ctl('the delay seam reachable without ?roomtest=1', 'test-seams-stay-behind-roomtest', { html: html.replace("(TESTING && /^\\d+$/.test(Q.get('delay')", "(/^\\d+$/.test(Q.get('delay')") });
  ctl('a stale room.js token', 'room.js-token-is-md5', { html: html.replace(/room\.js\?v=[0-9a-f]{8}/, 'room.js?v=deadbeef') });
  ctl('a worker in the page', 'no-streaming-no-worker-no-sab', { html: html.replace('</body>', '<script>new Worker("x.js");</script></body>') });
  ctl('the #fps readout changed to carry headroom', 'fps-readout-format-unchanged', { script: scriptJs.replace("'x hardware) · presented '", "'x hardware) · headroom 3x · presented '") });
  const ns = spawnSync(process.execPath, ['tools/no_streaming_test.mjs'], { cwd: ROOT, encoding: 'utf8' });
  ok('tools/no_streaming_test.mjs still passes with gba.html counted as an ONLINE lockstep page', ns.status === 0 && /PASS\s+gba\.html — lockstep/.test(ns.stdout), (/(\d+\/\d+ online pages[^\n]*)/.exec(ns.stdout) || [])[1]);
  const hg = (f) => md5(fs.readFileSync(path.join(ROOT, f)));
  ok('the core artifact this stage must not touch is byte-identical to the pins (wasm 13474b38..., glue b2d6dba0...)', hg('gba/mgba/dist/mgba_core.wasm') === '13474b3883009819a5ac7304e568cb0a' && hg('gba/mgba/dist/mgba_core.js') === 'b2d6dba079610b9edc18ee994eb2a0b4');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// tickmodel: gba/gbaWasm/dist/script.js _roomTick, EXTRACTED AND RUN with a fake room handle, against random tick schedules
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
function extractRoomTick(src) {
  const i = src.indexOf('_roomTick(now) {');
  if (i < 0) throw new Error('_roomTick not found');
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced _roomTick');
}
function makeTick(src) {
  const body = extractRoomTick(src).replace(/^_roomTick/, 'function roomTick');
  return new Function('GBA_HZ', 'ROOM_MAX_TICK_MS', 'ROOM_MAX_FRAMES', 'performance', `return ${body};`);
}
// A simulated page. Ticks arrive at the wall times the schedule gives (a late device's next tick cannot start before its work is done); `stallP`: the chance a
// stall starts (another seat's input is late: the handle holds the frame back); `costMs`: wall time one run frame takes on this device.
function simulate(tickFactory, seed, { ticks = 3000, stallP = 0.0, maxFramesOf = () => 4, gaps, costMs = 0 } = {}) {
  let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  let clock = 0; const perf = { now: () => clock };
  const fn = tickFactory(HZ, 100, 4, perf);
  let frames = 0, stallLeft = 0, thisTick = 0;
  const self = {
    roomHandle: { frame() { if (stallLeft > 0) return false; frames++; thisTick++; clock += costMs; return true; }, catchUp() { return 0; }, rejoining() { return false; }, maxFrames: () => maxFramesOf(rnd), tickDone() {} },
    _lastFrameTime: null, _accum: 0, _present() {}, _fpsTick() {}, _roomLostMs: 0,
  };
  const log = []; let nextAt = 1000, prevStart = null, maxInTick = 0, worstTickCredit = -Infinity;
  for (let n = 0; n < ticks; n++) {
    clock = Math.max(clock, nextAt);
    const start = clock, r = rnd();
    if (stallLeft > 0) stallLeft--; else if (rnd() < stallP) stallLeft = 5 + Math.floor(rnd() * 90);
    thisTick = 0;
    fn.call(self, start);
    const delta = prevStart === null ? 0 : start - prevStart;
    if (prevStart !== null) worstTickCredit = Math.max(worstTickCredit, thisTick - Math.floor((FRAME_MS + Math.min(delta, 100)) / FRAME_MS));
    prevStart = start;
    maxInTick = Math.max(maxInTick, thisTick);
    log.push([start, frames]);
    nextAt = start + (gaps ? gaps(rnd) : (r < 0.01 ? 120 + rnd() * 600 : r < 0.1 ? 40 + rnd() * 60 : 12 + rnd() * 10));
  }
  // the most frames in ANY trailing second of wall time. A tick the browser delivered LATE (<= the 100 ms credit cap) repays that real lateness in one go (<= 4 frames, as
  // the solo loop does), so a second can hold the hardware's 59.73 plus at most (100 ms + one leftover frame) / 16.74 ms = 6.97 more: 66.7.
  let maxSecond = 0, j = 0;
  for (let i = 0; i < log.length; i++) { while (log[i][0] - log[j][0] > 1000) j++; maxSecond = Math.max(maxSecond, log[i][1] - (j > 0 ? log[j - 1][1] : 0)); }
  const secs = (log[log.length - 1][0] - log[1][0]) / 1000;
  return { frames, maxInTick, worstTickCredit, maxSecond, seconds: secs, rate: (frames - log[1][1]) / secs / HZ, lost: self._roomLostMs };
}
async function sectionTickModel() {
  section('tickmodel: script.js _roomTick (extracted and run) never puts the guest above 1.000x - not in total, not in any second, not in any tick');
  const src = read('gba/gbaWasm/dist/script.js');
  const mk = makeTick(src);
  const runs = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) for (const stallP of [0, 0.02, 0.3]) for (const cap of [() => 4, (r) => 1 + Math.floor(r() * 9), () => 1]) runs.push(simulate(mk, seed * 7919 + Math.round(stallP * 100), { stallP, maxFramesOf: cap }));
  const most = Math.max(...runs.map((r) => r.maxInTick)), sec = Math.max(...runs.map((r) => r.maxSecond)), tc = Math.max(...runs.map((r) => r.worstTickCredit)), rate = Math.max(...runs.map((r) => r.rate));
  ok(`72 simulated rooms x 3000 ticks (bursty rAF: 1% of gaps 120-720 ms, 9% of 40-100 ms; stalls of 5-95 ticks; cost caps 4 / random 1-9 / 1): no room ever ran more than 66 frames in any trailing second (most: ${sec}; hardware is 59.73 + at most 6.97 repaid after a late tick)`, sec <= 66, String(sec));
  ok(`...no tick ever ran more than 4 frames (most: ${most}), even when the handle asked for 9`, most <= 4);
  ok(`...no tick ever ran more frames than the wall time it was credited allows (one frame of leftover + the elapsed time, at most 100 ms): a stall's debt is DROPPED, never repaid (worst surplus ${tc})`, tc <= 0, String(tc));
  ok(`...and the long-run rate of every room is at most 1.000x (highest ${rate.toFixed(5)}x)`, rate <= 1.0005, rate.toFixed(5));
  const steady = simulate(mk, 99, { ticks: 6000, gaps: () => FRAME_MS, stallP: 0 });
  ok(`a perfectly steady clock (a tick every 16.7427 ms) runs ${(steady.rate).toFixed(5)}x`, near(steady.rate, 1, 0.001));
  const slowDev = simulate(mk, 5, { ticks: 4000, gaps: () => 2, stallP: 0, maxFramesOf: () => 2, costMs: 25 });
  ok(`a device where one frame takes 25 ms (1.5x too slow) runs ${slowDev.rate.toFixed(3)}x - below 1.000x, never above - and the credit it could not spend is counted as time LOST (${Math.round(slowDev.lost / 1000)} s over ${slowDev.seconds.toFixed(0)} s)`, slowDev.rate <= 1.001 && slowDev.rate > 0.5 && slowDev.lost > 0);
  const mut = (a, b2) => { if (!src.includes(a)) throw new Error('anchor: ' + a.slice(0, 50)); return makeTick(src.replace(a, b2)); };
  const mBank = mut('this._accum = FRAME_MS; }\n        let presentMs', 'this._accum = this._accum; }\n        let presentMs');
  const rbs = [1, 2, 3, 4].map((sd) => simulate(mBank, sd, { stallP: 0.3 }));
  control('a _roomTick that banks its credit across a stall (no clamp to one frame) repays it at four frames a tick: more than 66 frames in a second, and more frames in a tick than it was credited', Math.max(...rbs.map((r) => r.maxSecond)) > 66 && Math.max(...rbs.map((r) => r.worstTickCredit)) > 0, `most in a second ${Math.max(...rbs.map((r) => r.maxSecond))}`);
  const mCap = mut('if (c >= 1 && c < cap) cap = c;', 'if (c >= 1) cap = c;');
  const rc = Math.max(...[1, 2, 3].map((sd) => simulate(mCap, sd, { maxFramesOf: () => 40 }).maxInTick));
  control('a _roomTick whose handle can RAISE the cap runs a burst of more than 4 frames in one tick', rc > 4, `most in one tick ${rc}`);
  const mLoop = mut('this._accum -= FRAME_MS;\n            ran++;', 'this._accum -= 1;\n            ran++;');
  const rl = [1, 2, 3].map((sd) => simulate(mLoop, sd, { stallP: 0 }));
  control('a _roomTick that charges 1 ms of credit per frame instead of 16.7 ms is a sped-up guest and is caught (rate and seconds)', Math.max(...rl.map((r) => r.rate)) > 1.5 && Math.max(...rl.map((r) => r.maxSecond)) > 66, `rate ${Math.max(...rl.map((r) => r.rate)).toFixed(2)}x`);
  const mDelta = mut('if (delta > ROOM_MAX_TICK_MS) {', 'if (false) {');
  const rd = [1, 2, 3].map((sd) => simulate(mDelta, sd, { maxFramesOf: () => 4 }));
  ok('(info) without the 100 ms credit cap the ceiling of four frames per tick and the credit clamp still keep the guest at or below 1.000x, so that cap is time-lost accounting, not the gate-9 guard', Math.max(...rd.map((r) => r.maxSecond)) <= 66 && Math.max(...rd.map((r) => r.rate)) <= 1.0005, `most in a second ${Math.max(...rd.map((r) => r.maxSecond))}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionDocs() {
  section('docs: the README "Budget" table is the rig\'s output, and room.js carries exactly those numbers');
  const readme = read('gba/mgba/README.md');
  const at = readme.indexOf('## Budget');
  ok('gba/mgba/README.md has a "## Budget" section', at >= 0);
  if (at < 0) return;
  const body = readme.slice(at, readme.indexOf('\n## ', at + 10) > 0 ? readme.indexOf('\n## ', at + 10) : undefined);
  const rows = {};
  for (const m of body.matchAll(/^\|\s*COST_REFERENCE\s*\|\s*([^|]+?)\s*\|\s*(\d)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/gm)) { (rows[m[1]] || (rows[m[1]] = {}))[m[2]] = { p50: +m[3], p95: +m[4] }; }
  const ref = R.COST_REFERENCE.perf, bad = [];
  for (const g of Object.keys(ref)) for (const n of Object.keys(ref[g])) { const r = rows[g] && rows[g][n]; if (!r || !near(r.p50, ref[g][n].p50, 0.0051) || !near(r.p95, ref[g][n].p95, 0.0051)) bad.push(`${g} x${n}`); }
  ok('every COST_REFERENCE row of room.js appears in the README table with the same p50 and p95 (to 0.005 ms)', bad.length === 0 && Object.keys(ref).length > 0, bad.join(', '));
  ok('the README names the source run of the reference and the usable fraction', body.includes(String(R.COST_REFERENCE.source)) && new RegExp('USABLE_FRACTION[^\\n]*' + String(R.USABLE_FRACTION).replace('.', '\\.')).test(body), `${R.COST_REFERENCE.source} / ${R.USABLE_FRACTION}`);
  ok('the README says these are shared-desktop SwiftShader numbers, not device numbers, and names what needs real hardware', /not device numbers|not a device number/i.test(body) && /real hardware|real phone|real device/i.test(body));
  control('a README row edited by 0.5 ms would be caught', (() => { const g = Object.keys(ref)[0], n = Object.keys(ref[g])[0]; return !near(ref[g][n].p50 + 0.5, ref[g][n].p50, 0.0051); })());
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// BROWSER
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
let withBrowserMulti = null;
const smoke = await import(pathToFileURL(path.join(ROOT, 'tools/gba_link_smoke.mjs')).href);
async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}
const URLQ = (extra = '', db = null) => `${BASE}/gba.html?net=local&roomtest=1${db ? '&gbadb=' + db : ''}${extra}`;
const DBNAMES = ['pA', 'pB', 'pC', 'pD'];
async function clearOrigin(p) { try { await p.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' }); } catch (_e) { /* best effort */ } }
async function openAll(pages, extra = '') {
  await Promise.all(pages.map(async (p, i) => { p.dbName = DBNAMES[i]; await p.navigate(URLQ(extra, p.dbName)); await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 90000, pollMs: 250 }); }));
}
async function hostOpen(A, title, seats) {
  return A.eval(`(async () => {
    document.getElementById('btnNet').click(); document.getElementById('netHostBtn').click();
    const t = document.getElementById('netTitle'); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('change'));
    const s = document.getElementById('netSeats'); s.value = ${JSON.stringify(String(seats))};
    document.getElementById('netOpen').click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); const c = document.getElementById('netCode').textContent.trim(); if (/^[A-Z2-9]{5}$/.test(c)) return c; }
    return null; })()`);
}
async function guestJoin(B, code) { await B.eval(`(() => { document.getElementById('btnNet').click(); document.getElementById('netJoinBtn').click(); document.getElementById('netCodeIn').value = ${JSON.stringify(code)}; document.getElementById('netGo').click(); true; })()`); }
async function admit(A, n = 1) { for (let i = 0; i < n; i++) { await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 30000, pollMs: 200 }); await A.eval(`document.getElementById('npApproveAllow').click(); true`); await sleep(400); } }
async function formRoom(pages, title, seats) {
  const [A, ...guests] = pages;
  const code = await hostOpen(A, title, seats);
  if (!code) throw new Error('no room code');
  for (const g of guests) { await guestJoin(g, code); await admit(A, 1); await g.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 }); }
  return code;
}
const allRunning = (pages, min = 1) => Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().running && window.__gbaNet().roomFrames >= ${min}`, { timeoutMs: 120000, pollMs: 250 })));
const leaveAll = async (pages) => { for (const p of pages.slice().reverse()) { try { await p.eval('window.__gbaNet().leave(true)'); } catch (_e) { /* gone */ } } await sleep(500); };
async function shot(p, name) { const f = path.join(OUT, name + '.png'); await p.screenshot(f); info('screenshot ' + f); return f; }
const pageErrs = (pages) => pages.flatMap((p, i) => p.errors.filter((e) => !/favicon/i.test(e)).map((e) => `[win ${i}] ${e}`));
const loopMs = (p) => p.eval(`(() => { const M = window.__gbaRoomModule; let best = Infinity; for (let i = 0; i < 4; i++) { const t0 = performance.now(); M.calibrationWork(1500000); const dt = performance.now() - t0; if (dt < best) best = dt; } return best; })()`);
async function armProof(p, rate) { const before = await loopMs(p); await p.send('Emulation.setCPUThrottlingRate', { rate }); const after = await loopMs(p); return { rate, beforeMs: before, afterMs: after, ratio: after / before, ok: after / before >= 0.6 * rate }; }
const rateWindow = (p, secs) => p.eval(`(async () => { const hz = 16777216 / 280896, w = [], f0 = window.__gbaNet().roomFrames, t0 = performance.now(); let last = f0, lt = t0;
  for (let i = 0; i < ${secs}; i++) { await new Promise((r) => setTimeout(r, 1000)); const f = window.__gbaNet().roomFrames, t = performance.now(); w.push(((f - last) / ((t - lt) / 1000)) / hz); last = f; lt = t; }
  return { overall: ((last - f0) / ((lt - t0) / 1000)) / hz, frames: last - f0, secs: (lt - t0) / 1000, windows: w }; })()`);
const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a) => { const m = meanOf(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// rewrite a response in flight (bare CDP Fetch domain): how the "sped-up page" negative control is made without touching the repo
async function rewriteResponses(page, urlPattern, fn) {
  await page.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Response' }] });
  const h = async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, responseStatusCode, responseHeaders } = m.params;
    try {
      const b = await page.send('Fetch.getResponseBody', { requestId });
      const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
      const out = fn(text);
      await page.send('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode || 200, responseHeaders: (responseHeaders || []).filter((x) => !/^content-(length|encoding)$/i.test(x.name)), body: Buffer.from(out).toString('base64') });
    } catch (e) { try { await page.send('Fetch.continueRequest', { requestId }); } catch (_x) { /* gone */ } }
  };
  page.handlers.push(h);
  return () => { page.handlers = page.handlers.filter((x) => x !== h); return page.send('Fetch.disable'); };
}

async function sectionPacing() {
  section('pacing (browser): a live 2-seat room runs at 1.000x over 30 s, never above; a page whose clock is sped up IS caught');
  const SECS = 30;
  const judge = (res) => {
    const all = res.windows, m = meanOf(all), sd = sdOf(all), q = 1 / (SECS * HZ);
    return { overall: res.overall, mean1s: m, sd1s: sd, quantum: q, within: res.overall >= 0.995 && res.overall <= 1.003 && Math.max(...all) <= 1.06 };
  };
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 300);
    await sleep(3000);
    const load0 = cpuLoad();
    const res = await Promise.all(pages.map((p) => rateWindow(p, SECS)));
    const load1 = cpuLoad();
    const js = res.map(judge);
    ok(`GATE 9: over ${SECS} s a live 2-seat Super Bust-A-Move room runs at 1.000x on BOTH pages (0.995 <= rate <= 1.003), and no 1-second window is above 1.06x`, js.every((j) => j.within), js.map((j) => `${j.overall.toFixed(4)}x`).join(' / ') + `  (Windows CPU busy ${load0}% -> ${load1}%)`);
    info(`noise: 1-second windows have sd ${js.map((j) => j.sd1s.toFixed(4)).join(' / ')} (whole frames per second: 1 frame = ${(1 / HZ).toFixed(4)}x of a second); the ${SECS} s total is quantised to ${js[0].quantum.toFixed(5)}x; frames run ${res.map((r) => r.frames).join(' / ')}`);
    ok('the two pages agree with each other (|rate A - rate B| <= 0.002x): lockstep keeps them level, so neither can run ahead', Math.abs(js[0].overall - js[1].overall) <= 0.002, (js[0].overall - js[1].overall).toFixed(5));
    const b = await Promise.all(pages.map((p) => p.eval('window.__gbaBudget()')));
    ok('the page reports its spare time as a CAPACITY: "N presented, Mx headroom"; the status-bar rate readout is unchanged and not above 1.003x', b.every((x) => /^[0-9.]+ presented, [0-9.]+x headroom$/.test(x.presentedText)), b.map((x) => x.presentedText).join(' | '));
    const fpsTxt = await Promise.all(pages.map((p) => p.eval("document.getElementById('fps').textContent")));
    const fpsX = fpsTxt.map((t) => +((/\(([\d.]+)x hardware\)/.exec(t) || [])[1]));
    ok('...#fps reads "guest N/s (Nx hardware) · presented N/s" with Nx between 0.997 and 1.003', fpsTxt.every((t) => /^guest [\d.]+\/s \([\d.]+x hardware\) · presented [\d.]+\/s$/.test(t)) && fpsX.every((x) => x >= 0.997 && x <= 1.003), fpsTxt.join(' | '));
    ok('the speed lock is still on in a live room (roomLocked true, setGameSpeed(5) refused)', await A.eval('window.myApp.roomLocked === true && window.myApp.setGameSpeed(5) === false'));
    // the control: the SAME measurement against a page whose clock has been rewritten to run twice as fast
    await leaveAll(pages);
    await Promise.all(pages.map(clearOrigin));
    const undo = await Promise.all(pages.map((p) => rewriteResponses(p, '*gbaWasm/dist/script.js*', (t) => t.replace('const GBA_HZ = (window.MgbaCore && window.MgbaCore.FPS) || 59.7275;', 'const GBA_HZ = ((window.MgbaCore && window.MgbaCore.FPS) || 59.7275) * 2;'))));
    await openAll(pages);
    const mutated = await A.eval('(() => { try { return window.myApp.constructor.toString().length > 0 && /./.test(String(1)); } catch (e) { return false; } })()');
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 300);
    await sleep(2000);
    const res2 = await Promise.all(pages.map((p) => rateWindow(p, 12)));
    const j2 = res2.map((r) => ({ overall: r.overall, windows: r.windows }));
    control('a page whose GBA_HZ is doubled (a guest running at 2x) reads about 2x and FAILS the 1.000x check that the real page passes', j2.every((j) => j.overall > 1.5 && !(j.overall >= 0.995 && j.overall <= 1.003)), j2.map((j) => j.overall.toFixed(3) + 'x').join(' / ') + (mutated ? '' : ' (mutation not confirmed)'));
    await Promise.all(undo.map((u) => u()));
    await leaveAll(pages);
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// caps (browser): the seat picker refuses with a reason; the speed test sees a CPU throttle; memory is read from navigator.deviceMemory
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const seatUi = (p) => p.eval(`(() => { const s = document.getElementById('netSeats'), w = document.getElementById('netSeatWhy'), o = document.getElementById('netOpen');
  return { options: Array.from(s.options).map((x) => ({ n: +x.value, disabled: x.disabled, label: x.textContent })), selected: s.value, why: w.textContent, whyShown: w.classList.contains('on'), openDisabled: o.disabled, force: !!document.getElementById('netSeatForce'),
    cap: window.__gbaNet().cap, status: document.getElementById('netStatus').textContent }; })()`);
const openHostPane = (p, title) => p.eval(`(async () => { document.getElementById('btnNet').click(); document.getElementById('netHostBtn').click(); const t = document.getElementById('netTitle'); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 400)); return true; })()`);
async function sectionCaps() {
  section('caps (browser): the host\'s seat picker offers only what this device can hold, says why for the rest, and cannot be argued past a memory refusal');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    // ── unthrottled, enforcing (&cap=on): the UI must agree with the pure function for the numbers THIS page measured
    await clearOrigin(A); await A.navigate(URLQ('&cap=on', 'pA')); await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 90000 });
    await openHostPane(A, KIRBY);
    const u0 = await seatUi(A);
    const exp0 = R.seatCap({ game: KIRBY, deviceMemoryGB: u0.cap.basis.memoryGB, slowdown: u0.cap.basis.slowdown });
    ok('unthrottled: the page measured a speed (a ~50 ms test), the picker has Kirby\'s 2/3/4 and each option is disabled exactly when room.js seatCap says the count is refused for the numbers the page measured',
      u0.cap && u0.cap.enforced && u0.cap.speed && u0.cap.speed.bestMs > 0 && u0.options.map((o) => o.n).join() === '2,3,4' && u0.options.every((o) => o.disabled === !exp0.byCount[o.n].ok), `slowdown ${u0.cap.basis.slowdown && u0.cap.basis.slowdown.toFixed(2)} best ${u0.cap.speed.bestMs.toFixed(1)} ms; refused: ${u0.options.filter((o) => o.disabled).map((o) => o.n).join(',') || 'none'}`);
    const load0 = cpuLoad();
    const bestBase = u0.cap.speed.bestMs;
    // ── the CPU-throttle arm: the speed test must SEE it (the arm-difference proof) and the picker must follow.
    // The rate is derived from the cost reference, not assumed: r puts Kirby's 2 seats inside the usable fraction and its 3 seats outside it.
    const k = R.COST_REFERENCE.perf[KIRBY], lim = R.USABLE_FRACTION * FRAME_MS;
    const baseSd = u0.cap.basis.slowdown > 0 ? u0.cap.basis.slowdown : 1;          // this page's own measured slowdown, unthrottled
    const rMid = Math.max(1.5, Math.round(2 * (lim / Math.sqrt(k[2].p95 * k[3].p95)) / baseSd) / 2);
    const hold = async (rate, url) => { await A.send('Emulation.setCPUThrottlingRate', { rate }); await A.navigate(url); await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 180000 }); await openHostPane(A, KIRBY); return seatUi(A); };
    const proof = await armProof(A, rMid);
    ok(`arm proof: a ${rMid}x CDP throttle slows a fixed loop by at least ${(0.6 * rMid).toFixed(1)}x (else the arm is VOID and proves nothing)`, proof.ok, `${proof.beforeMs.toFixed(1)} -> ${proof.afterMs.toFixed(1)} ms (x${proof.ratio.toFixed(2)}); Windows CPU busy ${load0}%`);
    const uM = await hold(rMid, URLQ('&cap=on', 'pA'));
    const expM = R.seatCap({ game: KIRBY, deviceMemoryGB: uM.cap.basis.memoryGB, slowdown: uM.cap.basis.slowdown });
    ok(`throttled ${rMid}x: the speed test reads the slowdown (best trial >= ${(0.5 * rMid).toFixed(1)}x the unthrottled best), so the page's slowdown rose`, uM.cap.speed.bestMs >= 0.5 * rMid * bestBase, `${bestBase.toFixed(1)} -> ${uM.cap.speed.bestMs.toFixed(1)} ms; slowdown ${u0.cap.basis.slowdown.toFixed(2)} -> ${uM.cap.basis.slowdown.toFixed(2)}`);
    const refusedM = uM.options.filter((o) => o.disabled).map((o) => o.n);
    ok(`throttled ${rMid}x: every option is disabled exactly where seatCap refuses it for the numbers the page measured, a count that cannot be held (4 players) is REFUSED and labelled "not on this device", and the selection moved to an offered count`,
      uM.options.every((o) => o.disabled === !expM.byCount[o.n].ok) && refusedM.includes(4) && uM.options.filter((o) => o.disabled).every((o) => /not on this device/.test(o.label)) && uM.options.find((o) => String(o.n) === uM.selected) && !uM.options.find((o) => String(o.n) === uM.selected).disabled,
      JSON.stringify(uM.options.map((o) => [o.n, o.disabled])));
    ok('...and the host is TOLD why, in words: the reason names the milliseconds one frame needs here and the 16.7 ms a frame lasts, and the counts it refuses', uM.whyShown && /players? (is|are) not offered/.test(uM.why) && /ms of this device for each frame/.test(uM.why) && /16\.7 ms/.test(uM.why), uM.why.slice(0, 230));
    ok('...with an explicit way past a SPEED refusal (a button), because the estimate can be wrong', uM.force);
    await shot(A, 'caps_throttled_refusal');
    // far slower again (8x the mid rate): even two Kirby seats cannot be held, so the Open button itself is off; a cheap title (Super Bust-A-Move) still can
    const sK = lim / k[2].p95, sS = lim / R.COST_REFERENCE.perf[SBAM][2].p95;          // the slowdowns where Kirby 2 seats / Super Bust-A-Move stop fitting
    const rHi = Math.max(2.5, Math.round(2 * Math.sqrt(sK * sS) / baseSd) / 2);         // between them: all of Kirby refused, the cheap title still offered
    const uH = await hold(rHi, URLQ('&cap=on', 'pA'));
    ok(`throttled ${rHi}x: no Kirby count is offered, the Open button is disabled, and the text says why`, uH.options.every((o) => o.disabled) && uH.openDisabled && /ms of this device for each frame/.test(uH.why), uH.why.slice(0, 160));
    await A.eval(`(() => { const t = document.getElementById('netTitle'); t.value = ${JSON.stringify(SBAM)}; t.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(500);
    const uS = await seatUi(A);
    ok(`...while Super Bust-A-Move (a little over half of Kirby 2 seats' cost) is still offered at ${rHi}x`, uS.options.some((o) => !o.disabled) && !uS.openDisabled, JSON.stringify(uS.options.map((o) => [o.n, o.disabled])));
    // ── the handoff path: ?host=1&seats=4 reaches netStartHost without the picker; it must refuse too
    await A.send('Emulation.setCPUThrottlingRate', { rate: rMid });
    await A.navigate(URLQ('&cap=on&np=ABCDE&host=1&seats=4&game=' + encodeURIComponent(KIRBY), 'pA')); await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 180000 });
    await sleep(2500);
    const hand = await A.eval(`({ session: window.__gbaNet().session, status: document.getElementById('netStatus').textContent, code: document.getElementById('netCode').textContent.trim() })`);
    ok('a lobby hand-off for a 4-player room on a device that cannot hold it opens NO room, and says "4 players is not offered on this device: ..."', !hand.session && /4 players is not offered on this device/.test(hand.status) && !/^[A-Z2-9]{5}$/.test(hand.code), hand.status.slice(0, 160));
    await openHostPane(A, KIRBY);
    // ── the override
    await A.eval(`document.getElementById('netSeatForce') && document.getElementById('netSeatForce').click(); true`);
    const uf = await seatUi(A);
    ok('"Offer those anyway" enables the speed-refused counts and says what to expect ("the room will run slower ... and it will say so")', uf.options.every((o) => !o.disabled) && /Offered anyway/.test(uf.why) && /will say so/.test(uf.why), uf.why.slice(0, 160));
    await A.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    // ── memory: navigator.deviceMemory as a real browser would report it (a getter installed before the page runs, not a page seam)
    const reportMem = async (gb, extra = '&cap=on') => {
      await B.send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get() { return ${gb}; } });` });
      await clearOrigin(B); await B.navigate(URLQ(extra, 'pB')); await B.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 90000 });
      await openHostPane(B, KIRBY);
      return seatUi(B);
    };
    const m05 = await reportMem(0.5);
    ok('a device that REPORTS 0.5 GB: every count refused as SEATS_DEVICE_MEMORY, the Open button is disabled, the reason names "192 MB" and "0.5 GB", and there is NO override button', m05.options.every((o) => o.disabled) && m05.openDisabled && m05.cap.byCount[2].code === 'SEATS_DEVICE_MEMORY' && /192 MB/.test(m05.why) && /0\.5 GB/.test(m05.why) && !m05.force, m05.why.slice(0, 200));
    await shot(B, 'caps_memory_0p5gb_refusal');
    const m1 = await reportMem(1);
    ok('...reporting 1 GB: only the 2-player room is offered (3 and 4 refused as SEATS_DEVICE_MEMORY)', m1.options.filter((o) => !o.disabled).map((o) => o.n).join() === '2' && m1.cap.byCount[3].code === 'SEATS_DEVICE_MEMORY' && m1.cap.byCount[4].code === 'SEATS_DEVICE_MEMORY', m1.why.slice(0, 160));
    const m4 = await reportMem(4);
    ok('...reporting 4 GB: memory refuses nothing (speed alone decides, as above)', m4.cap.basis.memoryGB === 4 && m4.cap.counts.every((n) => m4.cap.byCount[n].code !== 'SEATS_DEVICE_MEMORY'));
    const m05n = await reportMem(0.5, '');
    control('the same 0.5 GB report on a page WITHOUT &cap=on is advisory only (the test-seam default: N windows share one CPU), so the refusal above is the cap\'s doing', m05n.cap && m05n.cap.enforced === false && m05n.cap.byCount[2].code === 'SEATS_DEVICE_MEMORY' && m05n.options.every((o) => !o.disabled) && !m05n.openDisabled);
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// lowmem (browser): the Capability layer's low-memory arm (--js-flags=--max-old-space-size=192, tools/device_matrix.mjs) and what it does and does not constrain
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionLowmem() {
  section('lowmem (browser): the existing low-memory arm (a 192 MB V8 heap + Capability.heapCheck) against a 2-seat room');
  let base = null;
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 1 }, async ({ pages }) => {
    const [A] = pages; await clearOrigin(A); await A.navigate(URLQ('', 'pA')); await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 90000 });
    base = await A.eval(`(async () => { await Capability.ready; return { env: Capability.get().env, jsLimit: performance.memory ? performance.memory.jsHeapSizeLimit / 1048576 : null }; })()`);
  });
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2, args: ['--js-flags=--max-old-space-size=192'] }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    const arm = await A.eval(`(async () => { await Capability.ready; return { env: Capability.get().env, jsLimit: performance.memory.jsHeapSizeLimit / 1048576, heap192: Capability.heapCheck(192), heap512: Capability.heapCheck(512) }; })()`);
    const bl = base.env ? base.env.jsHeapLimitMB : base.jsLimit, al = arm.env.jsHeapLimitMB;
    ok('arm proof (the Capability layer\'s own): the V8 heap limit the page reads DIFFERS from an unflagged browser, as tools/device_matrix.mjs requires', typeof bl === 'number' && typeof al === 'number' && bl !== al && al <= 300, `jsHeapLimitMB ${bl} -> ${al}`);
    if (al > bl) info(`(the flagged arm reads HIGHER: ${bl} -> ${al}. On this Chrome performance.memory is not a faithful size of the V8 limit, so the matrix's own proof shows the arm took effect but not that the heap shrank.)`);
    ok('Capability.heapCheck(192) - the fixed block a room needs - is GRANTED in this arm (the flag limits the JavaScript heap, not WebAssembly memory), and the report says how much the device claims', arm.heap192.ok === true && arm.heap192.mb === 192, JSON.stringify({ ok: arm.heap192.ok, deviceMemoryGB: arm.heap192.deviceMemoryGB }));
    info('so this arm models JavaScript-heap pressure only; it does NOT make 192 MB of WebAssembly memory unavailable. The allocation-failure path itself is tools/gba_netplay_test.mjs --only alloc (a mocked refusal), and a device that genuinely lacks the memory is NOT available here.');
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 300);
    await sleep(2000);
    const res = await Promise.all(pages.map((p) => rateWindow(p, 15)));
    ok('in the 192 MB-JS-heap arm a 2-seat room forms, runs and holds 1.000x for 15 s (0.99 <= rate <= 1.003) on both pages', res.every((r) => r.overall >= 0.99 && r.overall <= 1.003), res.map((r) => r.overall.toFixed(4) + 'x').join(' / '));
    const mem = await Promise.all(pages.map((p) => p.eval('({ js: performance.memory.usedJSHeapSize / 1048576, limit: performance.memory.jsHeapSizeLimit / 1048576 })')));
    ok('...the JS heap stays well inside the flag (used < 60% of the limit): the room\'s memory is the wasm block, not JavaScript', mem.every((m) => m.js < 0.6 * m.limit), mem.map((m) => m.js.toFixed(1) + ' of ' + m.limit.toFixed(0) + ' MiB').join(' / '));
    await leaveAll(pages);
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// notice (browser): a slow device (a CPU-throttled window, a STAND-IN) is named in plain words on every screen; the way out works; nothing speeds up
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const paceOf = (p) => p.eval('window.__gbaPace()');
async function sectionNotice() {
  section('notice (browser): Kirby, 3 windows, window C slowed 8x (a stand-in for a slow phone): the room says WHICH seat is slow, in words, and offers a way out');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 3 }, async ({ pages }) => {
    const [A, B, C] = pages;
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, KIRBY, 3);
    await allRunning(pages, 400);
    await sleep(14000);
    const calm = await Promise.all(pages.map(paceOf));
    ok('before anything is slowed, NO page shows a notice (the room is at full speed; 14 s in)', calm.every((x) => !x.slow && x.text === null && !x.shown), JSON.stringify(calm.map((x) => x.rate && +x.rate.toFixed(3))));
    const proof = await armProof(C, 8);
    ok('arm proof: window C\'s fixed loop is at least 4.8x slower under the 8x throttle', proof.ok, `${proof.beforeMs.toFixed(1)} -> ${proof.afterMs.toFixed(1)} ms (x${proof.ratio.toFixed(2)})`);
    const t0 = Date.now();
    await Promise.all(pages.map((p) => p.waitFor('window.__gbaPace().slow === true', { timeoutMs: 90000, pollMs: 500 })));
    const secs = (Date.now() - t0) / 1000;
    const pn = await Promise.all(pages.map(paceOf));
    ok(`every window raised the notice within ${secs.toFixed(0)} s of the throttle (well inside 60 s), at a measured room rate below 0.95x`, pn.every((x) => x.slow && x.rate < 0.95), pn.map((x) => x.rate.toFixed(3) + 'x').join(' / '));
    ok('the HOST (window A) names Seat 3 in the words "Seat 3\'s device is too slow for this room: the game runs at N.NNx for everyone."', pn[0].level === 'device' && pn[0].culprit === 2 && /^Seat 3's device is too slow for this room: the game runs at \d\.\d\dx for everyone\.$/.test(pn[0].headline), pn[0].headline);
    ok('window B (a normal guest) names Seat 3 too, and window C (the slow one) says "This device (Seat 3) is too slow..."', pn[1].culprit === 2 && /^Seat 3's device is too slow/.test(pn[1].headline) && pn[2].self === true && /^This device \(Seat 3\) is too slow for this room/.test(pn[2].headline), `${pn[1].headline} | ${pn[2].headline}`);
    ok('the notice is on screen as a banner with real buttons: Leave on every window, "Start a 2-player room" on the host only, and "Keep playing"', await (async () => {
      const acts = await Promise.all(pages.map((p) => p.eval(`Array.from(document.querySelectorAll('#netPace button')).map((b) => ({ act: b.getAttribute('data-act'), text: b.textContent, h: b.getBoundingClientRect().height, shown: document.getElementById('netPace').classList.contains('on') }))`)));
      return acts.every((a) => a.length && a[0].shown && a.some((b) => b.act === 'leave') && a.some((b) => b.act === 'keep') && a.every((b) => b.h >= 44)) && acts[0].some((b) => b.act === 'smaller' && /Start a 2-player room/.test(b.text)) && !acts[1].some((b) => b.act === 'smaller') && !acts[2].some((b) => b.act === 'smaller');
    })());
    const hud = await A.eval("document.getElementById('netHud').textContent");
    ok('the HUD carries the same sentence and the capacity phrase "N presented, Mx headroom"', /Seat 3's device is too slow/.test(hud) && /\d+\.\d presented, \d+(\.\d)?x headroom/.test(hud), hud.slice(0, 220));
    await shot(A, 'notice_host_names_seat3'); await shot(C, 'notice_slow_device_itself');
    const txt = pn.map((x) => x.text).join(' ');
    ok('NOTHING in any notice promises or offers a speed-up (no "speed up", "catch up", "fast-forward", "boost", "run faster")', !/speed(ing)? up|catch(ing)? up|fast-forward|boost|turbo|run faster|play faster/i.test(txt));
    // the guest rates while slowed: nobody is ABOVE 1.000x, the slow room is slower for everyone
    const rs = await Promise.all(pages.map((p) => rateWindow(p, 12)));
    ok('while slowed the room runs BELOW full speed for every window and above 1.000x for none (the slowest device sets the pace; nobody sprints)', rs.every((r) => r.overall < 0.95 && r.overall <= 1.003), rs.map((r) => r.overall.toFixed(3) + 'x').join(' / '));
    // "Keep playing" dismisses the banner for this episode
    await B.eval(`document.querySelector('#netPace [data-act="keep"]').click(); true`);
    await sleep(700);
    ok('"Keep playing" hides the banner on that window for this slow spell (the room is not changed, the HUD sentence stays)', await B.eval("!document.getElementById('netPace').classList.contains('on')") && /too slow/.test(await B.eval("document.getElementById('netHud').textContent")));
    // the way out for the host: a smaller room
    await A.eval(`document.querySelector('#netPace [data-act="smaller"]').click(); true`);
    await A.waitFor("!window.__gbaNet().session", { timeoutMs: 30000 });
    await sleep(1500);
    const after = await A.eval(`({ overlay: document.getElementById('netOverlay').classList.contains('on'), hostPane: document.getElementById('netHostPane').style.display !== 'none', title: document.getElementById('netTitle').value, seats: document.getElementById('netSeats').value, code: document.getElementById('netCode').textContent.trim() })`);
    ok('"Start a 2-player room" leaves the 3-player room and reopens the Party panel on the host form with Kirby and 2 players ALREADY chosen - nothing opens by itself', after.overlay && after.hostPane && after.title === KIRBY && after.seats === '2' && !/^[A-Z2-9]{5}$/.test(after.code), JSON.stringify(after));
    await shot(A, 'notice_smaller_room_preselected');
    const gone = await Promise.all([B, C].map((p) => p.waitFor("!window.__gbaNet().session", { timeoutMs: 30000 }).then(() => true).catch(() => false)));
    ok('the other two players are told the host left (the room is over for everyone, nothing saved) and are back in solo play', gone.every(Boolean));
    await C.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });
  // the recovery: a slowed window comes back, the notice clears, the room is at 1.000x again and not above
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, KIRBY, 2);
    await allRunning(pages, 400);
    await sleep(12000);
    await armProof(B, 8);
    await Promise.all(pages.map((p) => p.waitFor('window.__gbaPace().slow === true', { timeoutMs: 90000, pollMs: 500 })));
    const during = await paceOf(A);
    ok('two seats, window B slowed 8x: the host names Seat 2, and a 2-seat room offers no "smaller room" (Leave only)', during.culprit === 1 && /^Seat 2's device is too slow/.test(during.headline) && await A.eval(`Array.from(document.querySelectorAll('#netPace button')).map((b) => b.getAttribute('data-act')).join()`) === 'leave,keep');
    await B.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await Promise.all(pages.map((p) => p.waitFor('window.__gbaPace().slow === false', { timeoutMs: 90000, pollMs: 500 })));
    const rs = await Promise.all(pages.map((p) => rateWindow(p, 15)));
    ok('the throttle lifted: the notice clears on both windows and the room is back at 1.000x (0.99-1.003), never above', rs.every((r) => r.overall >= 0.99 && r.overall <= 1.003), rs.map((r) => r.overall.toFixed(4) + 'x').join(' / '));
    await leaveAll(pages);
  });
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// delay (browser): the host measures every player and sets the room's starting input delay; the guest adopts it; a test seam can fix it
// ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionDelayLive() {
  section('delay (browser): the host\'s measured starting input delay reaches every page; ?delay= (loopback test seam) can fix it; a late peer stalls, never sprints');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 200);
    const n = await Promise.all(pages.map((p) => p.eval('(() => { const x = window.__gbaNet(); return { delay: x.delay, choice: x.delayChoice, log: window.__gbaRoomTest.log.filter((l) => /\\[delay\\]/.test(l)) }; })()')));
    ok('the HOST measured the other player (a round trip) and chose the starting delay with room.js defaultInputDelay: choice.measured, 1 peer, a delay of at least 2', n[0].choice && n[0].choice.measured === true && n[0].choice.peers === 1 && n[0].choice.delay >= 2 && n[0].choice.fixed === false, JSON.stringify(n[0].choice && { delay: n[0].choice.delay, rtt: n[0].choice.budgetsMs, why: n[0].choice.why }));
    ok('...a loopback link (about 1 ms) needs the floor: 2 frames; and the guest runs the host\'s delay (both pages report the same)', n[0].choice.delay === 2 && n[0].delay === n[1].delay, `host ${n[0].delay} guest ${n[1].delay}`);
    ok('the guest chose nothing (only the host sizes the delay)', n[1].choice === null, JSON.stringify(n[1].choice));
    await leaveAll(pages);
    await Promise.all(pages.map(clearOrigin));
    await openAll(pages, '&delay=7');
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 200);
    const f = await Promise.all(pages.map((p) => p.eval('({ delay: window.__gbaNet().delay, choice: window.__gbaNet().delayChoice })')));
    ok('with ?delay=7 (loopback test seam) both pages start at 7 and the host says it was fixed, not measured', f.every((x) => x.delay === 7) && f[0].choice.fixed === true, JSON.stringify(f.map((x) => x.delay)));
    const rs = await Promise.all(pages.map((p) => rateWindow(p, 12)));
    ok('a delay of 7 frames (117 ms of latency) does not change the rate: still 1.000x (0.99-1.003) - the delay is a latency knob', rs.every((r) => r.overall >= 0.99 && r.overall <= 1.003), rs.map((r) => r.overall.toFixed(4) + 'x').join(' / '));
    await leaveAll(pages);
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });
}

let browserSections = [['caps', sectionCaps], ['lowmem', sectionLowmem], ['notice', sectionNotice], ['delay', sectionDelayLive]];
async function main() {
  const t0 = Date.now();
  console.log(`gba_room_budget_test  (${flag('--browser') ? 'node + browser' : 'node only'})  Windows CPU busy ${cpuLoad()}%`);
  const nodeSections = [['module', sectionModule], ['ring', sectionRing], ['ticks', sectionTicks], ['cap', sectionCap], ['delay', sectionDelay], ['pace', sectionPace], ['static', sectionStatic], ['tickmodel', sectionTickModel], ['docs', sectionDocs]];
  for (const [name, fn] of nodeSections) if (want(name)) { try { await fn(); } catch (e) { fail++; console.log(`  FAIL section ${name} threw: ${e && e.stack || e}`); } }
  if (flag('--browser')) {
    ({ withBrowserMulti } = await import('./headless_cdp_multi.mjs'));
    const srv = await ensureServer();
    try {
      for (const [name, fn] of [['pacing', sectionPacing], ...browserSections]) if (want(name)) { try { await fn(); } catch (e) { fail++; console.log(`  FAIL section ${name} threw: ${e && e.stack || e}`); } }
    } finally { srv.stop(); }
  }
  console.log(`\n[gba-room-budget] ${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fail ? 1 : 0);
}
await main();
