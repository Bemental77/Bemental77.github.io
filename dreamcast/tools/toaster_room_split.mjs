#!/usr/bin/env node
// ============================================================================
// toaster_room_split.mjs — WHERE THE DREAMCAST ROOM TOASTER CELL'S TIME GOES.
//
// tools/toaster_bench.mjs reads the room at ~0.29x while solo reads ~0.83x
// (rate 6.2). This rig splits that gap into: start-up (seed + room anchor +
// mode switches + JIT refill), steady state, rollback re-simulation, and
// two-console contention — the last by a PAIR-OF-SOLOS control: two solo pages
// at the same rate, each in its own window (own renderer process), exactly the
// room's topology without the room.
//
//   modes: room   host page + joiner in a NEW WINDOW (lib/bench.js ?benchjoin=tab,
//                 the toaster_bench default topology)
//          pair   two solo bench pages, two windows, started together
//          solo   one solo bench page
//
//   bash tools/probe_lock.sh run -- node dreamcast/tools/toaster_room_split.mjs <mode> <rate> <sec> [extra-query] [--name N]
//        [--jextra Q]  joiner's extra query (default: the same extra-query as the host)
//        [--prof S --profat H]  CPU profile of the first page's worker for S s from heartbeat H
//        [--thrat H]  per-thread CPU window opens at heartbeat H (default 12)
//
// Per page and heartbeat it prints t (s since the page's goto), x (aicaX),
// emu/gate/held/drop ms, hbSinceRestore and the room engine's mode/delay/
// resims/frame, plus every [rollback]/[lockstep]/mode console line with its
// time. The summary gives, per page: when the bench's window would open (same
// rule as lib/bench.js A.dreamcast.running + the room's net.running), the mean
// x of the first 20 heartbeats from there (what a 20 s gate reads), and the
// mean x of the last half of the run (steady state).
// Same arm as the gate: SwiftShader, --max-old-space-size=512, the
// tools/toaster_duty.py duty cycle at <rate> on every renderer process.
// Output JSON: /tmp/dc-room-split/<name>.json
// ============================================================================
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const guard = (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default;
const a = process.argv.slice(2);
const mode = a[0] || 'room', rate = +a[1] || 1, secs = +a[2] || 60, extra = a[3] && !a[3].startsWith('--') ? a[3] : '';
const fl = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
const name = fl('name') || `${mode}-${rate}`;
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const OUTD = '/tmp/dc-room-split'; fs.mkdirSync(OUTD, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-room-split-'));
const load0 = os.loadavg();
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: 'new', userDataDir: udd,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=512'], protocolTimeout: 600000 });
guard.guard(b, 'dreamcast/tools/toaster_room_split.mjs');
let duty = null;
if (rate > 1) duty = spawn('python3', [path.join(ROOT, 'tools/toaster_duty.py'), String(b.process().pid), String(rate), '2'], { stdio: 'ignore' });
const bs = await b.target().createCDPSession();
async function newWindow() {
  const { targetId } = await bs.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const t = await b.waitForTarget((x) => (x._targetInfo && x._targetInfo.targetId === targetId) || x._targetId === targetId, { timeout: 30000 });
  return t.page();
}
const prof = +fl('prof') || 0;
async function profile(P) {
  const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()) && (!P.p.target || true));
  const ws = []; for (const t of b.targets()) if (/worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url())) ws.push(t);
  // the emulation worker of THIS page: the one whose opener is the page target
  const pid = P.p.target()._targetId;
  const mine = ws.find((t) => t.opener && t.opener() && t.opener()._targetId === pid) || wt;
  if (!mine) { console.log('no worker target'); return; }
  const s = await mine.createCDPSession(); await s.send('Profiler.enable'); await s.send('Profiler.setSamplingInterval', { interval: 200 }); await s.send('Profiler.start');
  await sleep(prof * 1000); const { profile } = await s.send('Profiler.stop');
  const f = path.join(OUTD, name + '-' + P.tag + '.cpuprofile'); fs.writeFileSync(f, JSON.stringify(profile)); console.log('profile saved ' + f);
}

// ---- per-thread CPU over the steady window (/proc) -----------------------------
// emu ms/s is WALL time inside run_iter and includes time the duty cycle (or a busy
// core) kept the worker off-CPU, so it cannot tell "more work" from "less CPU". This
// reads utime+stime of every thread of every renderer process.
function procKids() { const kids = {};
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; (kids[pp] = kids[pp] || []).push(+d); } catch (_e) {} }
  return kids; }
function threadSample() {
  const kids = procKids(), out = {}, todo = [b.process().pid];
  while (todo.length) { const pid = todo.pop(); for (const c of kids[pid] || []) todo.push(c);
    let type = 'browser'; try { const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); const t = /--type=([\w-]+)/.exec(cl); if (t) type = t[1]; } catch (_e) { continue; }
    let tids = []; try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (_e) { continue; }
    for (const tid of tids) { try { const st = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8'); const comm = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
      const f = st.slice(st.lastIndexOf(')') + 2).split(' '); out[`${type}:${pid}:${tid}:${comm}`] = (+f[11] + +f[12]) * 10; } catch (_e) {} } }
  return { t: Date.now(), m: out }; }
let thrA = null, thrB = null;
const T0 = Date.now(); const ts = () => +((Date.now() - T0) / 1000).toFixed(1);
const pages = [];   // {tag, p, rows, lines, t0}
function attach(tag, p) {
  const P = { tag, p, rows: [], lines: [], errs: [], t0: Date.now() };
  p.on('pageerror', (e) => P.errs.push(String(e.message).slice(0, 200)));
  p.on('console', (m) => { const t = m.text();
    if (/\[rollback\]|\[lockstep\]|lsgo|capacity|rbArm|ENTERS|LEAVES|anchor|seed|\[pswff\]|\[split\]/i.test(t) || (/\[ctxsnap\]/.test(t))) { const L = `${ts()} ${tag} ` + (/\[ctxsnap\]/.test(t) ? '[ctxsnap] ' + (t.match(/ (pc|isk|pswff|chit|cmiss|schedticks|veccnt)=\S+/g) || []).join('') : t.slice(0, 220)); P.lines.push(L); console.log('  ' + L); }
    if (/desync|threw/i.test(t)) P.errs.push(t.slice(0, 200));
    // --profarm: profile this console's worker from the moment rollback mode is armed (the room start-up refill)
    if (prof && a.includes('--profarm') && !P.profd && P === pages[0] && /\[rollback\] ARMED —/.test(t)) { P.profd = true; P.profT0 = ts(); profile(P).then(() => { P.profT1 = ts(); console.log(`profile window ${P.profT0}..${P.profT1}`); }); } });
  pages.push(P); return P;
}
const code = 'Z' + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z2-9]/g, 'Q');
const soloUrl = `${BASE}/dreamcast.html?bench=1&benchauto=1&benchroom=0&benchsec=${secs}${extra}`;
if (mode === 'room') {
  const h = attach('H', await b.newPage());
  await h.p.goto(`${BASE}/dreamcast.html?bench=1&benchauto=1&benchsec=${secs}&benchphase=room&benchjoin=tab&np=${code}&host=1&net=local&game=pso2${extra}`, { waitUntil: 'load', timeout: 180000 });
  let ju = null; for (let i = 0; i < 120 && !ju; i++) { await sleep(500); ju = await h.p.evaluate(() => window.__benchJoinUrl || null).catch(() => null); }
  if (!ju) { console.log('no joiner url'); }
  else { const j = attach('J', await newWindow()); await j.p.goto(BASE + ju + (fl('jextra') != null ? fl('jextra') : extra), { waitUntil: 'load', timeout: 180000 }); }
} else if (mode === 'pair') {
  const A = attach('A', await b.newPage()); const B = attach('B', await newWindow());
  await Promise.all([A.p.goto(soloUrl, { waitUntil: 'load', timeout: 180000 }), B.p.goto(soloUrl, { waitUntil: 'load', timeout: 180000 })]);
} else {
  const A = attach('A', await b.newPage()); await A.p.goto(soloUrl, { waitUntil: 'load', timeout: 180000 });
}
const probe = () => {
  const q = window.__dcProbe && window.__dcProbe(); if (!q) return null;
  let net = null;
  try { const S = window.Netplay && window.Netplay.sessions; const s = S && S[S.length - 1]; const rep = s && s.ls && s.ls.report && s.ls.report();
    if (rep) net = { st: rep.state, f: rep.frame, rb: rep.rollback ? 1 : 0, d: rep.delay, rs: rep.rollback ? rep.rollback.resimFrames : 0, rbs: rep.rollback ? rep.rollback.rollbacks : 0, ds: !!rep.desync }; } catch (e) {}
  return { hb: q.hb, hbMs: q.hbMs, fs: q.fskip, booted: q.booted, gx: q.guestX, x: q.aicaX, pace: q.pace, rest: q.restoring, hbr: q.hbSinceRestore, net,
           vis: document.visibilityState, done: !!window.__benchResult, res: window.__benchResult && (window.__benchResult.room || window.__benchResult.solo) };
};
const limit = (secs + 240 * Math.max(1, rate / 3)) * 1000;
while (Date.now() - T0 < limit) {
  await sleep(1000);
  let allDone = true;
  for (const P of pages) {
    const r = await P.p.evaluate(probe).catch(() => null);
    if (!r) { allDone = false; continue; }
    if (r.booted && (!P.rows.length || P.rows[P.rows.length - 1].hb !== r.hb)) {
      r.t = ts(); P.rows.push(r); const pc = r.pace || {}, n = r.net;
      console.log(`${r.t} ${P.tag} hb${r.hb} x=${(+r.x).toFixed(3)} emu=${pc.emu} gate=${pc.gate} held=${pc.held} drop=${pc.drop} hbr=${r.hbr}${r.rest ? ' REST' : ''}` +
        (n ? ` net=${n.st} f=${n.f} ${n.rb ? 'RB' : 'd' + n.d} rs=${n.rs}${n.ds ? ' DESYNC' : ''}` : '') + (r.vis !== 'visible' ? ' ' + r.vis : '') + (r.fs ? ` fs=${r.fs.frames}/${r.fs.drawn}/${r.fs.skipped}${r.fs.on ? '' : ' off'}${r.fs.why ? ' ' + r.fs.why : ''}` : ''));
      if (!thrA && P.tag === pages[0].tag && r.hbr >= (+fl('thrat') || 12)) { thrA = threadSample(); thrA.T = ts(); }
      if (prof && !P.profd && P.tag === pages[0].tag && r.hbr >= (+fl('profat') || 15)) { P.profd = true; P.profT0 = ts(); await profile(P); P.profT1 = ts(); console.log(`profile window ${P.profT0}..${P.profT1}`); }
    }
    if (r.done && !P.res && !thrB) { thrB = threadSample(); thrB.T = ts(); }
    if (r.done && !P.res) { P.res = r.res; console.log(`${ts()} ${P.tag} RESULT ${JSON.stringify(r.res && { speed: r.res.speed, over: r.res.over, frames: r.res.frames })}`); }
    if (!P.res && !(mode === 'room' && P.tag === 'J')) allDone = false;
  }
  if (allDone && pages.length) break;
}
// ---- summary ------------------------------------------------------------------
const mean = (v) => v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
const out = { name, mode, rate, secs, extra, load0, load1: os.loadavg(), pages: {} };
for (const P of pages) {
  const R = P.rows;
  const isRun = (r) => r.booted && r.gx > 0 && !r.rest && r.hbr >= 2 && (mode !== 'room' || (r.net && (r.net.st === 'running' || r.net.st === 'stalled')));
  const i0 = R.findIndex(isRun);
  const win = i0 >= 0 ? R.slice(i0 + 1, i0 + 1 + 20) : [];   // bench takes the next heartbeats once running
  const all = i0 >= 0 ? R.slice(i0 + 1) : [];
  const steady = all.slice(Math.floor(all.length / 2));
  const sumP = (rows, k) => mean(rows.map((r) => (r.pace || {})[k] || 0));
  out.pages[P.tag] = {
    openT: i0 >= 0 ? R[i0].t : null, firstHbT: R.length ? R[0].t : null,
    win20: { n: win.length, x: mean(win.map((r) => r.x)), emu: sumP(win, 'emu'), gate: sumP(win, 'gate'), xs: win.map((r) => +(+r.x).toFixed(3)) },
    steady: { n: steady.length, x: mean(steady.map((r) => r.x)), emu: sumP(steady, 'emu'), gate: sumP(steady, 'gate'), held: sumP(steady, 'held'), drop: sumP(steady, 'drop') },
    prof: P.profT0 != null ? { t0: P.profT0, t1: P.profT1 } : null, lastNet: R.length ? R[R.length - 1].net : null, res: P.res || null, lines: P.lines, errs: P.errs.slice(0, 8), rows: R.map((r) => ({ t: r.t, hb: r.hb, x: r.x, hbMs: r.hbMs, pace: r.pace, hbr: r.hbr, rest: r.rest, net: r.net })) };
  const o = out.pages[P.tag];
  console.log(`SUMMARY ${P.tag}: open@${o.openT}s  win20 x=${o.win20.x && o.win20.x.toFixed(3)} (n=${o.win20.n}) emu=${o.win20.emu && o.win20.emu.toFixed(0)} gate=${o.win20.gate && o.win20.gate.toFixed(0)}  steady x=${o.steady.x && o.steady.x.toFixed(3)} (n=${o.steady.n}) emu=${o.steady.emu && o.steady.emu.toFixed(0)} gate=${o.steady.gate && o.steady.gate.toFixed(0)} held=${o.steady.held && o.steady.held.toFixed(0)}  bench=${o.res ? o.res.speed : '-'}`);
}

if (thrA && thrB) {
  const dt = (thrB.t - thrA.t) / 1000, rows = [];
  for (const k of Object.keys(thrB.m)) { const d = thrB.m[k] - (thrA.m[k] || 0); if (d / dt > 20) rows.push([k, d / dt]); }
  rows.sort((x, y) => y[1] - x[1]);
  const byProc = {}; for (const [k, v] of rows) { const pr = k.split(':').slice(0, 2).join(':'); byProc[pr] = (byProc[pr] || 0) + v; }
  out.threads = { from: thrA.T, to: thrB.T, top: rows.slice(0, 24), byProc };
  console.log(`THREADS ${thrA.T}..${thrB.T}s (CPU ms per wall s): ` + Object.entries(byProc).map(([k, v]) => k + '=' + v.toFixed(0)).join(' '));
  for (const [k, v] of rows.slice(0, 16)) console.log('  ' + v.toFixed(0).padStart(5) + '  ' + k);
  for (const P of pages) { const w = P.rows.filter((r) => r.t >= thrA.T && r.t <= thrB.T); out.pages[P.tag].thrWinX = mean(w.map((r) => r.x)); out.pages[P.tag].thrGuestS = w.reduce((a, r) => a + (r.x || 0) * (r.hbMs || 1000) / 1000, 0); out.pages[P.tag].thrWallS = w.reduce((a, r) => a + (r.hbMs || 1000) / 1000, 0); console.log(`  ${P.tag} mean x over the thread window ${out.pages[P.tag].thrWinX && out.pages[P.tag].thrWinX.toFixed(3)} (n=${w.length}); guest ${out.pages[P.tag].thrGuestS.toFixed(2)} s in ${out.pages[P.tag].thrWallS.toFixed(2)} s of heartbeat windows`); }
}
console.log('load', load0.map((x) => x.toFixed(2)).join(' '), '->', os.loadavg().map((x) => x.toFixed(2)).join(' '));
fs.writeFileSync(path.join(OUTD, name + '.json'), JSON.stringify(out, null, 1));
for (const P of pages) await P.p.screenshot({ path: path.join(OUTD, `${name}-${P.tag}.png`) }).catch(() => {});
if (duty) duty.kill('SIGTERM'); await b.close(); fs.rmSync(udd, { recursive: true, force: true });
