#!/usr/bin/env node
// tools/gba_room_budget_measure.mjs - the GR3 measurement rig: what a link-cable ROOM costs one device, and how it degrades on a slower one.
//
//   node tools/gba_room_budget_measure.mjs --mode calib                      # the speed test: repeatability, and its ratio under a CPU throttle
//   node tools/gba_room_budget_measure.mjs --mode cells  [--cells sbam2,sa32,kirby2]   [--frames 3000]   # ms per room frame, unthrottled
//   node tools/gba_room_budget_measure.mjs --mode cells  --cells kirby3,kirby4
//   node tools/gba_room_budget_measure.mjs --mode throttle [--cells ...] [--rates 4,6] [--secs 40] [--ab]   # a CPU-throttle STAND-IN for a phone
//   node tools/gba_room_budget_measure.mjs --mode slow1  [--cells kirby4] [--rate 6]       # ONE slow device in a room of otherwise normal ones
//   node tools/gba_room_budget_measure.mjs --mode sweep  [--delays 1,2,3,5] [--rates 1,4,6] [--secs 25]    # stalls against the starting input delay
//   node tools/gba_room_budget_measure.mjs --mode rss    [--cells kirby2,kirby4]            # browser memory with N seats (Windows)
//   Options: --json FILE (default <out>/budget-<mode>.json), --out DIR, --png (screenshots), BROWSER_LOCK_TIMEOUT_MS=7200000 to queue behind others.
//
// WHAT THIS IS AND IS NOT. Every number is main-thread milliseconds measured INSIDE the real gba.html in real headless Chrome windows (one window per
// player, --mute-audio, the machine-wide browser lock, tools/headless_cdp_multi.mjs), on a SHARED WINDOWS DESKTOP under SwiftShader. It is not a
// device number. A CPU throttle (CDP Emulation.setCPUThrottlingRate) is a STAND-IN for a slower device: it slows every task on the page by a
// fixed factor and says nothing about a phone's memory system, its thermal limits, or WebKit. Each window shares this one CPU with its siblings, so
// an N-seat room measured here is N pages contending on one machine (a real room has N machines): the cost of a page is therefore, if anything,
// OVERSTATED against a real device of the same speed.
//
// WHAT IT MEASURES (all from window.__gbaBudget(), the page's own recorder - gba.html "THE BUDGET RECORDER"):
//   total   = core step + engine + audio + this tick's canvas upload shared over its frames   (ms per applied room frame)
//   core    = MgbaCore runFrame for ALL seats       engine = lockstep beginFrame/endFrame + the 1-in-60 fingerprint       audio = the AudioPipe pump
//   present = putImageData per tick                 tick   = everything one rAF tick did (a tick over 50 ms is a "long task")
// "headroom" is CAPACITY = 16.7427 ms / cost. It is never a rate: the room runs at exactly 1.000x whatever the headroom (CLAUDE.md gate 9).
// Guards: md5 of dist/mgba_core.wasm (13474b38...) and dist/mgba_core.js (b2d6dba0...) before and after; Windows CPU load before and after each cell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowserMulti } from './headless_cdp_multi.mjs';

// This rig REPORTS TIMING, so it takes the whole machine: the shared browser lock has slots (tools/headless_cdp.mjs), and a measurement taken beside two other Chromes is
// not a measurement. BROWSER_LOCK_EXCLUSIVE=0 opts out (the numbers then carry the load of whoever else ran).
process.env.BROWSER_LOCK_EXCLUSIVE = process.env.BROWSER_LOCK_EXCLUSIVE === undefined ? '1' : process.env.BROWSER_LOCK_EXCLUSIVE;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
// A --plan FILE.json is a list of steps run one after the other in ONE browser (one lock acquisition): [{ "mode": "cells", "--cells": "sbam2,sa32", "--frames": "3000", "--rss": true }, ...].
// While a step runs, its own keys answer opt()/flag(); without --plan the command line does.
let STEP = null;
const flag = (f) => (STEP ? !!STEP[f] : argv.includes(f));
const opt = (f, d) => { if (STEP) return STEP[f] !== undefined ? String(STEP[f]) : d; const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PLAN_FILE = (() => { const i = argv.indexOf('--plan'); return i >= 0 ? argv[i + 1] : null; })();
const STEPS = PLAN_FILE ? JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')) : [null];
const MODE = PLAN_FILE ? 'plan' : opt('--mode', 'cells');
const PORT = Number(process.env.GBA_BUDGET_PORT || 8113);
const CDP_BASE = Number(process.env.GBA_BUDGET_CDP || 9331);
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve(opt('--out', process.env.GBA_BUDGET_OUT || path.join(os.tmpdir(), 'gba-budget')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5file = (p) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
const HZ = 16777216 / 280896, FRAME_MS = 1000 / HZ;
const num = (x, d = 2) => (x == null || !isFinite(x) ? '-' : x.toFixed(d));

const GUARD = { 'gba/mgba/dist/mgba_core.wasm': '13474b3883009819a5ac7304e568cb0a', 'gba/mgba/dist/mgba_core.js': 'b2d6dba079610b9edc18ee994eb2a0b4' };
const guards = () => Object.fromEntries(Object.keys(GUARD).concat(['gba.html', 'gba/gbaWasm/dist/script.js', 'gba/mgba/room.js']).map((f) => [f, md5file(f)]));

function cpuLoad() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 });
    const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null;
  } catch (_e) { return null; }
}
// Private bytes of the test browser's processes (those whose command line names the throwaway profile), by role. Windows only; null elsewhere.
function chromeMemory() {
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*bemental-chrome-*' } | ForEach-Object { $t = 'browser'; if ($_.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }; '{0}|{1}|{2}' -f $t, $_.WorkingSetSize, $_.PrivatePageCount } `;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    const rows = String(r.stdout).split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).map(([t, ws, pv]) => ({ t, wsMiB: +ws / 1048576, privMiB: +pv / 1048576 }));
    const byType = {};
    for (const x of rows) { (byType[x.t] || (byType[x.t] = [])).push(x); }
    const renderers = (byType.renderer || []).slice().sort((a, b) => b.privMiB - a.privMiB);
    return { processes: rows.length, rendererPrivMiB: renderers.map((x) => +x.privMiB.toFixed(0)), rendererWsMiB: renderers.map((x) => +x.wsMiB.toFixed(0)),
      totalPrivMiB: +rows.reduce((a, x) => a + x.privMiB, 0).toFixed(0), totalWsMiB: +rows.reduce((a, x) => a + x.wsMiB, 0).toFixed(0) };
  } catch (_e) { return null; }
}
async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}

// ---- the link smoke scripts (what each title's players press to reach its linked scene) ------------------------------------------
const smoke = await import(pathToFileURL(path.join(ROOT, 'tools/gba_link_smoke.mjs')).href);
const LINK = Object.fromEntries(smoke.TITLES.map((t) => [t.id, t]));
const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
function keysByFrame(steps, seats) {
  const out = [], keys = new Array(seats).fill(0);
  const sel = (t) => (t === 'all' ? [...Array(seats).keys()] : Array.isArray(t) ? t : [t]);
  const maskOf = (names) => String(names).split('+').reduce((m, n) => m | (n === 'NONE' ? 0 : KEY[n.toUpperCase()]), 0);
  const step = (n) => { for (let i = 0; i < n; i++) out.push(keys.slice()); };
  for (const st of steps) {
    const c = st[0];
    if (c === 'wait') step(st[1]);
    else if (c === 'tap') { const hold = st[3] === undefined ? 6 : st[3], gap = st[4] === undefined ? 12 : st[4]; for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(hold); for (const s of sel(st[1])) keys[s] = 0; step(gap); }
    else if (c === 'hold') { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(st[3]); for (const s of sel(st[1])) keys[s] = 0; }
    else if (c === 'mash') { for (let i = 0; i < st[3]; i++) { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(3); for (const s of sel(st[1])) keys[s] = 0; step(5); } }
  }
  return out;
}
const seatKeys = (script, seats, seat) => keysByFrame(script, seats).map((row) => row[seat]);

const SBAM = 'Super Bust-A-Move', KIRBY = 'Kirby Nightmare in Dreamland', SA3 = 'Sonic Advance 3';
const CELLS = {
  sbam2: { id: 'sbam2', title: SBAM, seats: 2, link: 'sbam-2p' },
  sa32: { id: 'sa32', title: SA3, seats: 2, link: 'sa3-2p' },
  kirby2: { id: 'kirby2', title: KIRBY, seats: 2, link: 'kirby-2p' },
  kirby3: { id: 'kirby3', title: KIRBY, seats: 3, link: 'kirby-3p' },
  kirby4: { id: 'kirby4', title: KIRBY, seats: 4, link: 'kirby-4p' },
};

// ---- driving the real page ----------------------------------------------------------------------------------------------------------
const URLQ = (extra = '', db = null) => `${BASE}/gba.html?net=local&roomtest=1${db ? '&gbadb=' + db : ''}${extra}`;
const DBNAMES = ['pA', 'pB', 'pC', 'pD'];
async function clearOrigin(p) { try { await p.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' }); } catch (_e) { /* best effort */ } }
async function openAll(pages, extra = '') {
  await Promise.all(pages.map(async (p, i) => { p.dbName = DBNAMES[i]; await p.navigate(URLQ(extra, p.dbName)); await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 90000, pollMs: 250 }); }));
}
async function setKeys(p, arr) { await p.eval(`window.__gbaRoomTest.keyArr = ${JSON.stringify(arr)}; window.__gbaRoomTest.keys = (f) => window.__gbaRoomTest.keyArr[f] || 0; true`); }
async function hostOpen(A, title, seats) {
  return A.eval(`(async () => {
    document.getElementById('btnNet').click(); document.getElementById('netHostBtn').click();
    const t = document.getElementById('netTitle'); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('change'));
    const s = document.getElementById('netSeats'); s.value = ${JSON.stringify(String(seats))};
    document.getElementById('netOpen').click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); const c = document.getElementById('netCode').textContent.trim(); if (/^[A-Z2-9]{5}$/.test(c)) return c; }
    return null; })()`);
}
async function guestJoin(B, code) {
  await B.eval(`(() => { document.getElementById('btnNet').click(); document.getElementById('netJoinBtn').click(); document.getElementById('netCodeIn').value = ${JSON.stringify(code)}; document.getElementById('netGo').click(); true; })()`);
}
async function admit(A, n = 1) {
  for (let i = 0; i < n; i++) {
    await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 30000, pollMs: 200 });
    await A.eval(`document.getElementById('npApproveAllow').click(); true`);
    await sleep(400);
  }
}
async function formRoom(pages, title, seats) {
  const [A, ...guests] = pages;
  const code = await hostOpen(A, title, seats);
  if (!code) throw new Error('the host never got a room code');
  for (const g of guests) {
    await guestJoin(g, code);
    await admit(A, 1);
    await g.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 });
  }
  return code;
}
const allRunning = (pages, min = 1) => Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().running && window.__gbaNet().roomFrames >= ${min}`, { timeoutMs: 120000, pollMs: 250 })));
const leaveAll = async (pages) => { for (const p of pages.slice().reverse()) { try { await p.eval('window.__gbaNet().leave(true)'); } catch (_e) { /* gone */ } } await sleep(500); };
const throttle = (p, rate) => p.send('Emulation.setCPUThrottlingRate', { rate });
const installObservers = (p) => p.eval(`(() => { window.__lt = { n: 0, ms: 0, max: 0 }; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { __lt.n++; __lt.ms += e.duration; if (e.duration > __lt.max) __lt.max = e.duration; } }).observe({ type: 'longtask' }); return true; } catch (e) { return String(e); } })()`);
const resetLongTasks = (p) => p.eval('window.__lt = { n: 0, ms: 0, max: 0 }; true');
const pctOf = (arr, q) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); const r = q / 100 * (a.length - 1), lo = Math.floor(r), hi = Math.min(a.length - 1, lo + 1); return a[lo] + (a[hi] - a[lo]) * (r - lo); };
function statsOf(arr, overMs = FRAME_MS) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y); let over = 0, sum = 0; for (const v of a) { sum += v; if (v > overMs) over++; }
  return { n: a.length, mean: sum / a.length, p50: pctOf(a, 50), p95: pctOf(a, 95), p99: pctOf(a, 99), max: a[a.length - 1], over, overPct: 100 * over / a.length };
}
// the arm-difference proof: a fixed loop, timed before and after the throttle. The arm is VOID unless it slowed the loop by at least 0.6x the factor.
const loopMs = (p) => p.eval(`(() => { const R = window.__gbaRoomModule; let best = Infinity; for (let i = 0; i < 4; i++) { const t0 = performance.now(); R.calibrationWork(1500000); const dt = performance.now() - t0; if (dt < best) best = dt; } return best; })()`);
async function armProof(p, rate) {
  const before = await loopMs(p);
  await throttle(p, rate);
  const after = await loopMs(p);
  return { rate, beforeMs: before, afterMs: after, ratio: after / before, ok: rate === 1 || after / before >= 0.6 * rate };
}
const calibOf = (p) => p.eval(`window.__gbaRoomModule.calibrate(() => performance.now())`);

// ---- a window of play: rate, stalls, long tasks, cost -------------------------------------------------------------------------------
async function snap(p) {
  return p.eval(`(() => { const n = window.__gbaNet(), b = window.__gbaBudget(), e = n.engine || {}; return { t: performance.now(), frames: n.roomFrames, state: n.state, delay: n.delay, stalls: e.stalls | 0, stallMs: e.stallMs | 0, maxStallMs: e.maxStallMs | 0,
    bn: b ? b.total.n : 0, lt: window.__lt ? { n: window.__lt.n, ms: window.__lt.ms, max: window.__lt.max } : null, lost: b ? b.lostMs : 0, hist: (e.delayHistory || []).length }; })()`);
}
async function playWindow(pages, secs) {
  const a = await Promise.all(pages.map(snap));
  await Promise.all(pages.map(resetLongTasks));
  await sleep(secs * 1000);
  const b = await Promise.all(pages.map(snap));
  const lt = await Promise.all(pages.map((p) => p.eval('window.__lt ? { n: __lt.n, ms: Math.round(__lt.ms), max: Math.round(__lt.max) } : null')));
  return pages.map((p, i) => {
    const dt = (b[i].t - a[i].t) / 1000, df = b[i].frames - a[i].frames;
    return { rate: (df / dt) / HZ, frames: df, secs: dt, stalls: b[i].stalls - a[i].stalls, stallShare: (b[i].stallMs - a[i].stallMs) / (dt * 1000), delay: b[i].delay, delayChanges: b[i].hist - a[i].hist,
      longTasks: lt[i], lostMs: b[i].lost - a[i].lost, state: b[i].state, bn0: a[i].bn, bn1: b[i].bn };
  });
}
async function budgetOf(p, sinceN) {
  const b = await p.eval('window.__gbaBudget({ samples: true })');
  if (!b) return null;
  const tot = b.samples.total, k = sinceN == null ? tot.length : Math.min(tot.length, Math.max(0, b.total.n - sinceN));
  const slice = (a) => a.slice(a.length - k);
  const out = { all: b, cost: statsOf(slice(tot)), tick: statsOf(slice(b.samples.tick), 50), longTicks: b.longTicks, cappedTicks: b.cappedTicks, waitedTicks: b.waitedTicks, lostMs: b.lostMs, tickPolicy: b.tickPolicy,
    core: b.core, engine: b.engine, audio: b.audio, present: b.present };
  delete out.all.samples;
  return out;
}

// ---- modes ----------------------------------------------------------------------------------------------------------------------------
const results = { mode: MODE, started: new Date().toISOString(), node: process.version, guards: { before: guards() }, loadBefore: cpuLoad(), runs: [] };
const SAY = (s = '') => console.log(s);
const row = (cols, w) => cols.map((c, i) => String(c).padStart(w[i])).join(' ');

async function modeCalib(ctx) {
  SAY('\n== calib: the speed test (room.js calibrate) on an idle page, then under a CPU throttle');
  const [p] = ctx.pages;
  await clearOrigin(p); await openAll([p]);
  const runs = [];
  for (let i = 0; i < 30; i++) { runs.push(await calibOf(p)); await sleep(150); }
  const best = runs.map((r) => r.bestMs), spread = runs.map((r) => r.spread);
  const base = statsOf(best);
  SAY(`  unthrottled x30: bestMs median ${num(base.p50, 3)}  p95 ${num(base.p95, 3)}  max ${num(base.max, 3)}  (run-to-run spread of the median ${num(100 * (base.p95 - base.p50) / base.p50, 1)}%)   within-run spread median ${num(100 * pctOf(spread, 50), 1)}%  unreliable runs ${runs.filter((r) => !r.reliable).length}/30`);
  const arms = [];
  for (const rate of [2, 4, 6]) {
    const proof = await armProof(p, rate);
    const rs = []; for (let i = 0; i < 8; i++) { rs.push(await calibOf(p)); await sleep(100); }
    await throttle(p, 1);
    const st = statsOf(rs.map((r) => r.bestMs));
    arms.push({ rate, proof, bestMsMedian: st.p50, ratioToBase: st.p50 / base.p50, unreliable: rs.filter((r) => !r.reliable).length });
    SAY(`  throttle ${rate}x: arm proof loop ${num(proof.beforeMs, 1)} -> ${num(proof.afterMs, 1)} ms (x${num(proof.ratio, 2)}, ${proof.ok ? 'IN EFFECT' : 'VOID'});  speed test bestMs median ${num(st.p50, 3)} = x${num(st.p50 / base.p50, 2)} of unthrottled;  unreliable ${rs.filter((r) => !r.reliable).length}/8`);
  }
  results.runs.push({ kind: 'calib', unthrottled: { bestMs: base, spreadMedian: pctOf(spread, 50), runs: runs.length }, arms, refMsCandidate: base.p50 });
  SAY(`  => CALIBRATION.refMs candidate (median of 30 best trials, this machine): ${num(base.p50, 3)} ms`);
}

async function modeCells(ctx) {
  const frames = Number(opt('--frames', '3000'));
  const want = opt('--cells', 'sbam2,sa32,kirby2').split(',').filter(Boolean);
  for (const id of want) {
    const cell = CELLS[id]; if (!cell) { SAY('unknown cell ' + id); continue; }
    const pages = ctx.pages.slice(0, cell.seats);
    SAY(`\n== cell ${id}: ${cell.title}, ${cell.seats} windows, walk ${smoke.framesOf(LINK[cell.link].script)} frames then ${frames} more in the final scene`);
    const load0 = cpuLoad();
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, cell.title, cell.seats);
    const script = LINK[cell.link].script, total = smoke.framesOf(script);
    await Promise.all(pages.map((p, i) => setKeys(p, seatKeys(script, cell.seats, i))));
    await Promise.all(pages.map(installObservers));
    await allRunning(pages, 1);
    const target = total + frames;
    const t0 = Date.now();
    for (;;) {
      await sleep(3000);
      const st = await Promise.all(pages.map((p) => p.eval('({f: window.__gbaNet().roomFrames, s: window.__gbaNet().state})')));
      if (st.some((x) => x.s === 'desync' || x.s === 'failed')) { SAY('  room stopped: ' + JSON.stringify(st)); break; }
      if (st.every((x) => x.f >= target)) break;
      if (Date.now() - t0 > (target / 40 + 120) * 1000) { SAY('  timeout at ' + JSON.stringify(st)); break; }
    }
    const load1 = cpuLoad();
    const win = await playWindow(pages, 1);   // an instantaneous snapshot for the engine counters
    const per = [];
    for (let i = 0; i < pages.length; i++) {
      const b = await budgetOf(pages[i], null);
      const finalScene = await pages[i].eval(`(() => { const b = window.__gbaBudget({ samples: true }); const t = b.samples.total; return t.slice(Math.max(0, t.length - ${frames})); })()`);
      const walk = await pages[i].eval(`(() => { const b = window.__gbaBudget({ samples: true }); const t = b.samples.total; return t.slice(0, Math.max(0, t.length - ${frames})); })()`);
      per.push({ seat: i, finalScene: statsOf(finalScene), walk: statsOf(walk), parts: { core: b.core, engine: b.engine, audio: b.audio, present: b.present }, tick: b.tick, longTicks: b.longTicks, cappedTicks: b.cappedTicks, waitedTicks: b.waitedTicks, lostMs: b.lostMs });
    }
    const rates = await Promise.all(pages.map((p) => p.eval(`(async () => { const f0 = window.__gbaNet().roomFrames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 6000)); return ((window.__gbaNet().roomFrames - f0) / ((performance.now() - t0) / 1000)) / ${HZ}; })()`)));
    const mem = flag('--rss') ? chromeMemory() : null;
    SAY(`  ${'seat'.padStart(4)} ${'scene'.padStart(8)} ${'n'.padStart(6)} ${'mean'.padStart(7)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(8)} ${'over16.7'.padStart(9)}   headroom(p50) (p95)   [core engine audio present, mean ms]`);
    for (const x of per) for (const [name, s] of [['final', x.finalScene], ['walk', x.walk]]) if (s) {
      SAY(`  ${String(x.seat + 1).padStart(4)} ${name.padStart(8)} ${String(s.n).padStart(6)} ${num(s.mean, 3).padStart(7)} ${num(s.p50, 3).padStart(7)} ${num(s.p95, 3).padStart(7)} ${num(s.p99, 3).padStart(7)} ${num(s.max, 2).padStart(8)} ${(s.over + ' (' + num(s.overPct, 2) + '%)').padStart(9)}   ${num(FRAME_MS / s.p50, 1)}x (${num(FRAME_MS / s.p95, 1)}x)   [${num(x.parts.core.mean, 2)} ${num(x.parts.engine.mean, 2)} ${num(x.parts.audio.mean, 2)} ${num(x.parts.present.mean / Math.max(1, x.tick ? 1 : 1), 2)}]`);
    }
    SAY(`  rate over 6 s after the run: ${rates.map((r) => num(r, 4) + 'x').join(' / ')};  long ticks (>50 ms): ${per.map((x) => x.longTicks).join('/')};  Windows CPU busy ${load0}% -> ${load1}%`);
    if (mem) SAY(`  browser memory (test profile): renderers private MiB ${JSON.stringify(mem.rendererPrivMiB)} working-set ${JSON.stringify(mem.rendererWsMiB)}; all ${mem.processes} processes private ${mem.totalPrivMiB} MiB`);
    results.runs.push({ kind: 'cell', cell: id, title: cell.title, seats: cell.seats, walk: total, frames, per, rates, loads: [load0, load1], memory: mem });
    await leaveAll(pages);
  }
}

async function modeThrottle(ctx) {
  const want = opt('--cells', 'sbam2,sa32,kirby2').split(',').filter(Boolean), rates = opt('--rates', '4,6').split(',').map(Number), secs = Number(opt('--secs', '40'));
  for (const id of want) {
    const cell = CELLS[id]; if (!cell) continue;
    const pages = ctx.pages.slice(0, cell.seats);
    SAY(`\n== throttle ${id}: ${cell.title}, ${cell.seats} windows. The walk runs unthrottled, then EVERY window is slowed (a stand-in for a slow phone) for ${secs} s per arm`);
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    await formRoom(pages, cell.title, cell.seats);
    const script = LINK[cell.link].script, total = smoke.framesOf(script);
    await Promise.all(pages.map((p, i) => setKeys(p, seatKeys(script, cell.seats, i))));
    await Promise.all(pages.map(installObservers));
    await allRunning(pages, total + 300);
    const calib0 = await Promise.all(pages.map(calibOf));
    // baseline window, unthrottled
    const base = await playWindow(pages, 12);
    SAY(`  rate 1x: ${base.map((x) => num(x.rate, 4) + 'x').join(' / ')}`);
    const arms = [{ rate: 1, win: base, calib: calib0.map((c) => c.bestMs) }];
    for (const rate of rates) {
      const proofs = await Promise.all(pages.map((p) => armProof(p, rate)));
      const calib = await Promise.all(pages.map(calibOf));
      const n0 = await Promise.all(pages.map((p) => p.eval('window.__gbaBudget().total.n')));
      const load0 = cpuLoad();
      const win = await playWindow(pages, secs);
      const load1 = cpuLoad();
      const cost = await Promise.all(pages.map((p, i) => budgetOf(p, n0[i])));
      const tickPolicy = flag('--ab') ? [] : null;
      SAY(`  throttle ${rate}x  arm proof (loop ms ratio, need >= ${num(0.6 * rate, 1)}): ${proofs.map((x) => num(x.ratio, 2) + (x.ok ? '' : ' VOID')).join(' / ')}   speed test bestMs ${calib.map((c) => num(c.bestMs, 2)).join('/')} (x${num(calib[0].bestMs / calib0[0].bestMs, 2)} of unthrottled)`);
      SAY(`    rate ${win.map((x) => num(x.rate, 4) + 'x').join(' / ')}  stalls ${win.map((x) => x.stalls).join('/')}  stalled share ${win.map((x) => num(100 * x.stallShare, 0) + '%').join('/')}  delay ${win.map((x) => x.delay).join('/')}  lost ms ${win.map((x) => Math.round(x.lostMs)).join('/')}  long tasks ${win.map((x) => x.longTasks ? x.longTasks.n : '-').join('/')}   load ${load0}% -> ${load1}%`);
      SAY(`    cost per frame (ms): ${cost.map((c) => c.cost ? `n=${c.cost.n} p50 ${num(c.cost.p50, 2)} p95 ${num(c.cost.p95, 2)} p99 ${num(c.cost.p99, 2)} max ${num(c.cost.max, 1)}` : '-').join('  |  ')}`);
      SAY(`    cost / frame time (p50): ${cost.map((c) => c.cost ? num(c.cost.p50 / FRAME_MS, 2) : '-').join('/')}   tick p95 ${cost.map((c) => c.tick ? num(c.tick.p95, 1) : '-').join('/')} ms   capped ticks ${cost.map((c) => c.cappedTicks).join('/')}`);
      const arm = { rate, proofs, calib: calib.map((c) => c.bestMs), win, cost: cost.map((c) => ({ cost: c.cost, tick: c.tick, longTicks: c.longTicks, cappedTicks: c.cappedTicks, lostMs: c.lostMs })), loads: [load0, load1] };
      if (flag('--ab')) {
        // the same room, the same throttle: the old fixed four-frame tick against the cost-adaptive one, alternating, so drift hits both
        arm.ab = [];
        for (const policy of ['fixed', 'adaptive', 'fixed', 'adaptive']) {
          await Promise.all(pages.map((p) => p.eval(`myApp.roomTickPolicy = ${JSON.stringify(policy)}; true`)));
          const w = await playWindow(pages, Math.max(15, secs / 2));
          arm.ab.push({ policy, rate: w.map((x) => x.rate), longTasks: w.map((x) => (x.longTasks || {}).n), longMs: w.map((x) => (x.longTasks || {}).ms), lost: w.map((x) => x.lostMs), secs: w.map((x) => x.secs) });
          SAY(`    A/B ${policy.padEnd(8)} rate ${w.map((x) => num(x.rate, 3)).join('/')}  long tasks (>=50 ms) ${w.map((x) => x.longTasks ? x.longTasks.n : '-').join('/')} in ${num(w[0].secs, 0)} s  longest ${w.map((x) => x.longTasks ? x.longTasks.max : '-').join('/')} ms`);
        }
        await Promise.all(pages.map((p) => p.eval(`myApp.roomTickPolicy = 'adaptive'; true`)));
      }
      await Promise.all(pages.map((p) => throttle(p, 1)));
      arms.push(arm);
      await sleep(4000);
    }
    results.runs.push({ kind: 'throttle', cell: id, title: cell.title, seats: cell.seats, arms });
    await leaveAll(pages);
  }
}

async function modeSlow1(ctx) {
  const id = opt('--cells', 'kirby4'), cell = CELLS[id], rate = Number(opt('--rate', '6')), secs = Number(opt('--secs', '40'));
  const pages = ctx.pages.slice(0, cell.seats);
  SAY(`\n== slow1 ${id}: ${cell.seats} windows, ONE window (the last) slowed ${rate}x after the room is level, the others untouched`);
  await Promise.all(pages.map(clearOrigin)); await openAll(pages);
  await formRoom(pages, cell.title, cell.seats);
  await Promise.all(pages.map(installObservers));
  await allRunning(pages, 300);
  const base = await playWindow(pages, 10);
  SAY(`  before: ${base.map((x) => num(x.rate, 4) + 'x').join(' / ')}`);
  const slow = pages[pages.length - 1];
  const proof = await armProof(slow, rate);
  SAY(`  arm proof on the slowed window: loop ${num(proof.beforeMs, 1)} -> ${num(proof.afterMs, 1)} ms (x${num(proof.ratio, 2)}) ${proof.ok ? 'IN EFFECT' : 'VOID'}`);
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    await sleep(5000);
    samples.push(await Promise.all(pages.map((p) => p.eval(`(() => { const n = window.__gbaNet(); const pc = window.__gbaPace ? window.__gbaPace() : null; return { f: n.roomFrames, delay: n.delay, stalling: n.stalling, notice: pc ? pc.text : null, level: pc ? pc.level : null, culprit: pc ? pc.culprit : null }; })()`))));
  }
  const win = await playWindow(pages, 15);
  SAY(`  slowed: rate ${win.map((x) => num(x.rate, 4) + 'x').join(' / ')}  stalled share ${win.map((x) => num(100 * x.stallShare, 0) + '%').join('/')}`);
  const last = samples[samples.length - 1] || [];
  for (let i = 0; i < last.length; i++) SAY(`  window ${i + 1} says: ${last[i].level ? '[' + last[i].level + ' culprit seat ' + (last[i].culprit == null ? '-' : last[i].culprit + 1) + '] ' + last[i].notice : '(no notice)'}`);
  results.runs.push({ kind: 'slow1', cell: id, rate, proof, base, win, notices: last });
  await throttle(slow, 1);
  await leaveAll(pages);
}

async function modeSweep(ctx) {
  const delays = opt('--delays', '1,2,3,5').split(',').map(Number), rates = opt('--rates', '1,4,6').split(',').map(Number), secs = Number(opt('--secs', '25'));
  const cell = CELLS[opt('--cells', 'sbam2')], pages = ctx.pages.slice(0, cell.seats);
  SAY(`\n== sweep: ${cell.title}, ${cell.seats} windows, starting input delay x CPU throttle on both windows; ${secs} s each; the engine may raise the delay by itself (changes counted)`);
  SAY('  ' + row(['delay', 'throttle', 'rate A', 'rate B', 'stalls A', 'stalls B', 'stall% A', 'stall% B', 'delay end', 'raised'], [6, 8, 8, 8, 8, 8, 8, 8, 9, 6]));
  const rows = [];
  for (const rate of rates) for (const d of delays) {
    await Promise.all(pages.map(clearOrigin)); await openAll(pages, `&delay=${d}`);
    await formRoom(pages, cell.title, cell.seats);
    await allRunning(pages, 120);
    const proofs = rate > 1 ? await Promise.all(pages.map((p) => armProof(p, rate))) : [];
    if (proofs.some((x) => !x.ok)) SAY('  ARM VOID: ' + JSON.stringify(proofs));
    const startDelay = await pages[0].eval('window.__gbaNet().delay');
    const win = await playWindow(pages, secs);
    await Promise.all(pages.map((p) => throttle(p, 1)));
    const r = { rate, wanted: d, startDelay, win };
    rows.push(r);
    SAY('  ' + row([d + (startDelay !== d ? '(' + startDelay + '!)' : ''), rate + 'x', num(win[0].rate, 3), num(win[1].rate, 3), win[0].stalls, win[1].stalls, num(100 * win[0].stallShare, 1), num(100 * win[1].stallShare, 1), win[0].delay, Math.max(win[0].delayChanges, win[1].delayChanges)], [6, 8, 8, 8, 8, 8, 8, 8, 9, 6]));
    await leaveAll(pages);
  }
  results.runs.push({ kind: 'sweep', cell: cell.id, rows });
}

async function modeRss(ctx) {
  for (const id of opt('--cells', 'kirby2,kirby4').split(',')) {
    const cell = CELLS[id]; const pages = ctx.pages.slice(0, cell.seats);
    await Promise.all(pages.map(clearOrigin)); await openAll(pages);
    const idle = chromeMemory();
    await formRoom(pages, cell.title, cell.seats); await allRunning(pages, 300);
    await sleep(3000);
    const live = chromeMemory();
    const js = await Promise.all(pages.map((p) => p.eval('({ heap: myApp && window.__gbaRoomTest.machine() ? window.__gbaRoomTest.machine().core.memory() : null, jsMiB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null })')));
    SAY(`\n== rss ${id}: idle (solo core up) renderers private MiB ${JSON.stringify(idle && idle.rendererPrivMiB)} -> live room ${JSON.stringify(live && live.rendererPrivMiB)}; JS heap ${js.map((x) => num(x.jsMiB, 0)).join('/')} MiB; core sbrk high-water ${js.map((x) => x.heap ? num(x.heap.highWater / 1048576, 1) : '-').join('/')} MiB of ${js[0].heap ? js[0].heap.heapBytes / 1048576 : '-'}`);
    results.runs.push({ kind: 'rss', cell: id, idle, live, js });
    await leaveAll(pages);
  }
}

const srv = await ensureServer();
const seatsOfStep = (st) => { STEP = st; const m = st ? st.mode : opt('--mode', 'cells'); const r = (m === 'sweep' || m === 'calib') ? [2] : opt('--cells', m === 'slow1' ? 'kirby4' : 'sbam2').split(',').map((c) => (CELLS[c] || { seats: 2 }).seats); STEP = null; return r; };
const nWin = Math.max(2, ...STEPS.flatMap(seatsOfStep));
let code = 0;
try {
  await withBrowserMulti({ port: CDP_BASE, windows: nWin, width: 900, height: 700 }, async ({ pages, browserInfo }) => {
    SAY(`gba_room_budget_measure  mode=${MODE}  browser ${browserInfo && browserInfo.Browser}  windows ${nWin}  server ${BASE}${srv.reused ? ' (reused)' : ''}  Windows CPU busy ${results.loadBefore}%`);
    SAY('md5 before: ' + Object.entries(results.guards.before).map(([f, h]) => `${path.basename(f)}=${h.slice(0, 8)}`).join('  '));
    const ctx = { pages };
    results.stepErrors = [];
    for (let si = 0; si < STEPS.length; si++) {
      STEP = STEPS[si];
      const m = STEP ? STEP.mode : opt('--mode', 'cells');
      if (STEPS.length > 1) SAY(`
########## step ${si + 1}/${STEPS.length}: ${m} ${STEP ? JSON.stringify(Object.fromEntries(Object.entries(STEP).filter(([k]) => k !== 'mode'))) : ''}  (Windows CPU busy ${cpuLoad()}%)`);
      try {
        if (m === 'calib') await modeCalib(ctx);
        else if (m === 'cells') await modeCells(ctx);
        else if (m === 'throttle') await modeThrottle(ctx);
        else if (m === 'slow1') await modeSlow1(ctx);
        else if (m === 'sweep') await modeSweep(ctx);
        else if (m === 'rss') await modeRss(ctx);
        else throw new Error('unknown --mode ' + m);
      } catch (e) {
        if (STEPS.length === 1) throw e;
        SAY('STEP FAILED (' + m + '): ' + (e && e.stack || e)); results.stepErrors.push({ step: si, mode: m, error: String(e && e.message || e) });
        for (const p of pages) { try { await p.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch (_x) { /* gone */ } }
      }
      STEP = null;
    }
    const errs = pages.flatMap((p, i) => p.errors.filter((e) => !/favicon/i.test(e)).map((e) => `[win ${i}] ${e}`));
    results.pageErrors = errs;
    SAY('\npage errors: ' + (errs.length ? errs.slice(0, 5).join(' | ') : 'none'));
  });
} catch (e) { code = 1; console.log('RIG FAILED: ' + (e && e.stack || e)); results.error = String(e && e.message || e); }
finally { srv.stop(); }
results.guards.after = guards();
results.loadAfter = cpuLoad();
const same = Object.keys(GUARD).every((f) => results.guards.before[f] === results.guards.after[f] && results.guards.after[f] === GUARD[f]);
SAY(`md5 after : ${Object.entries(results.guards.after).map(([f, h]) => `${path.basename(f)}=${h.slice(0, 8)}`).join('  ')}   wasm+glue unchanged and equal to the pins: ${same ? 'YES' : 'NO (void)'}   Windows CPU busy ${results.loadBefore}% -> ${results.loadAfter}%`);
results.wasmGlueUnchanged = same;
const jf = opt('--json', path.join(OUT, `budget-${MODE}.json`));
fs.writeFileSync(jf, JSON.stringify(results, null, 1));
SAY('json: ' + jf);
process.exit(code || (same ? 0 : 2));
