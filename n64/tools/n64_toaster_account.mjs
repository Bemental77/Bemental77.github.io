#!/usr/bin/env node
// n64_toaster_account.mjs — WHERE DOES THE N64 CORE WORKER'S WALL TIME GO, ON THE TOASTER?
//
// The toaster arm (tools/toaster_bench.mjs): SwiftShader, every renderer AND the GPU process
// SIGSTOP/SIGCONT duty-cycled at --duty R (tools/toaster_duty.py, period 2 ms). SM64 solo via the
// page's own bench (?bench=1), the core in its worker, ?workerrig=clock (the eval seam; the frame
// clock runs as shipped).
//
// TWO INDEPENDENT ACCOUNTS of the same window:
//  1. JS (installed through the eval seam after --warm s; nothing ships): every task the worker
//     runs (setTimeout / setInterval / rAF / the scheduler's MessageChannel / page messages) is
//     timed, and the gaps between tasks are IDLE (split by what the gap followed: an animation
//     frame, i.e. where an OffscreenCanvas commits, or anything else). Inside the tasks: the core's
//     field (_neil_ls_run_frame) minus what is nested in it, every WebGL2 call by name (the sync
//     ones — readPixels, getBufferSubData, finish, getError, getParameter, fence calls, shader /
//     program queries — apart), snapshots (fsSnap), restores/re-runs, audio, postMessage, stats.
//     Wall-clock buckets: they INCLUDE the time the process was stopped inside them.
//  2. OS (/proc/<pid>/task/<tid>/schedstat, no instrumentation): per thread of the renderer and
//     GPU processes, on-CPU ms/s and run-queue wait ms/s. The core worker's on-CPU share of the
//     process's available time separates "running" from "stopped" (the duty) from "off-CPU while
//     the process could run" (a blocking wait or idle).
// --acct 0 runs the same window with no JS wrappers (the placebo: the wrappers' own cost on the
// field rate), --q adds arm query parameters.
//
//   bash tools/probe_lock.sh run -- node n64/tools/n64_toaster_account.mjs --url http://localhost:18900 [--duty 6.2] [--sec 40] [--warm 25] [--acct 1|0] [--q 'a=b'] [--json PATH]
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const DUTY = +flag('duty', '6.2'), SEC = +flag('sec', '40'), WARM = +flag('warm', '25');
const ACCT = flag('acct', '1') !== '0', EXTRA = flag('q', ''), GPUT = flag('gputhrottle', '1');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROD = BASE.startsWith('https');

const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=' + flag('win', '1280,900')];
if (PROD) { args.push('--ignore-certificate-errors'); if (process.env.HTTPS_PROXY) args.push('--proxy-server=' + process.env.HTTPS_PROXY); }
const udd = mkdtempSync(path.join(os.tmpdir(), 'n64acct-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args, userDataDir: udd, protocolTimeout: 600000 });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, 'n64_toaster_account'); } catch (_e) {}
const bpid = browser.process().pid;
let duty = null; const dutyFile = udd + '.duty.json';
if (DUTY > 1) duty = spawn('python3', [fileURLToPath(new URL('../../tools/toaster_duty.py', import.meta.url)), String(bpid), String(DUTY), '2', dutyFile, GPUT], { stdio: 'ignore' });

// ---- the OS account: every thread of every renderer / GPU process of this browser ----
function procTree() {
  const kids = new Map();
  for (const d of readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue;
    try { const st = readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
      if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(+d); } catch (_e) {} }
  const out = []; const todo = [bpid];
  while (todo.length) { const p = todo.pop(); for (const c of kids.get(p) || []) { todo.push(c);
    try { const cl = readFileSync(`/proc/${c}/cmdline`, 'latin1'); const m = /--type=([a-z-]+)/.exec(cl); if (m) out.push({ pid: c, type: m[1] }); } catch (_e) {} } }
  return out;
}
function threads() {
  const m = new Map();
  for (const p of procTree()) {
    if (p.type !== 'renderer' && p.type !== 'gpu-process') continue;
    let tids = []; try { tids = readdirSync(`/proc/${p.pid}/task`); } catch (_e) { continue; }
    for (const t of tids) { try {
      const ss = readFileSync(`/proc/${p.pid}/task/${t}/schedstat`, 'utf8').trim().split(' ').map(Number);
      const comm = readFileSync(`/proc/${p.pid}/task/${t}/comm`, 'utf8').trim();
      m.set(p.pid + ':' + t, { proc: p.type, pid: p.pid, comm, run: ss[0] / 1e6, wait: ss[1] / 1e6 });
    } catch (_e) {} }
  }
  return m;
}

// ---- the JS account, installed in the core worker through the eval seam ----
const INSTALL = `(function () {
  if (self.__AC) return 'already';
  var now = function () { return performance.now(); };
  var A = self.__AC = { t0: now(), b: {}, n: {}, gl: {}, glN: {}, depth: 0, taskEnd: now(), lastKind: 'boot', taskStart: 0, inTask: 0, glCalls: 0 };
  function add(k, ms) { A.b[k] = (A.b[k] || 0) + ms; A.n[k] = (A.n[k] || 0) + 1; }
  // nesting: a stack of exclusive timers; each frame subtracts its children
  var stack = [];
  function enter(k) { stack.push({ k: k, t: now(), child: 0 }); }
  function leave() { var f = stack.pop(), dt = now() - f.t; add(f.k, dt - f.child); if (stack.length) stack[stack.length - 1].child += dt; }
  function timed(k, fn) { return function () { enter(k); try { return fn.apply(this, arguments); } finally { leave(); } }; }
  // a task: the gap since the last one is idle, by what that one was
  function task(kind, fn) {
    return function () {
      if (A.inTask) return fn.apply(this, arguments);
      var t = now(); add('idle:after-' + A.lastKind, t - A.taskEnd);
      A.inTask = 1; enter('task:' + kind);
      try { return fn.apply(this, arguments); }
      finally { leave(); A.inTask = 0; A.taskEnd = now(); A.lastKind = kind; }
    };
  }
  var st = self.setTimeout, si = self.setInterval, ra = self.requestAnimationFrame;
  self.setTimeout = function (f, ms) { var a = [].slice.call(arguments, 2); return st.call(self, task('timeout', function () { return typeof f === 'function' ? f.apply(this, a) : (0, eval)(f); }), ms); };
  self.setInterval = function (f, ms) { return si.call(self, task('interval', f), ms); };
  if (ra) self.requestAnimationFrame = function (f) { return ra.call(self, task('raf', f)); };
  if (SCHED.chan) { var pm = SCHED.chan.port1.onmessage; SCHED.chan.port1.onmessage = task('imm', pm); }
  var om = self.onmessage; self.onmessage = task('msg', om);
  // inside the tasks
  var rf = M._neil_ls_run_frame; M._neil_ls_run_frame = timed('core', rf);
  ['fsSnap', 'fsRestore', 'fsResolve', 'fsRedo', 'fsPoll', 'audioPump', 'postStats', 'pbPresent', 'gqReady', 'fsWarmStep', 'heapWarmStep', 'applyPads', 'fpsScanStep', 'observeFrame'].forEach(function (n) {
    if (typeof self[n] === 'function') self[n] = timed('js:' + n, self[n]);
  });
  var pmw = self.postMessage; self.postMessage = timed('postMessage', pmw);
  var mpp = MessagePort.prototype.postMessage; MessagePort.prototype.postMessage = timed('postMessage', mpp);
  var SYNC = /^(readPixels|getBufferSubData|finish|flush|clientWaitSync|getSyncParameter|fenceSync|getError|getParameter|getShaderParameter|getProgramParameter|getUniformLocation|getAttribLocation|getShaderInfoLog|getProgramInfoLog|getActiveUniform|getActiveAttrib|getExtension|getSupportedExtensions|getContextAttributes|isContextLost|checkFramebufferStatus|getFramebufferAttachmentParameter|getRenderbufferParameter|getTexParameter|getBufferParameter|getQueryParameter|getQuery|getIndexedParameter|getInternalformatParameter)$/;
  var P = WebGL2RenderingContext.prototype;
  Object.getOwnPropertyNames(P).forEach(function (n) {
    var d = Object.getOwnPropertyDescriptor(P, n); if (!d || typeof d.value !== 'function' || n === 'constructor') return;
    var f = d.value;
    P[n] = function () {
      A.glCalls++;
      var t = now(); stack.push({ k: 'gl', t: t, child: 0 });
      try { return f.apply(this, arguments); }
      finally { var fr = stack.pop(), dt = now() - fr.t; A.gl[n] = (A.gl[n] || 0) + dt; A.glN[n] = (A.glN[n] || 0) + 1;
        add(SYNC.test(n) ? 'gl:sync' : 'gl:cmd', dt); if (stack.length) stack[stack.length - 1].child += dt; }
    };
  });
  return 'installed';
})()`;
const READ = `JSON.stringify((function () { var A = self.__AC; return { t: performance.now(), b: A ? A.b : null, n: A ? A.n : null, gl: A ? A.gl : null, glN: A ? A.glN : null,
  glCalls: A ? A.glCalls : 0, vi: viTotal(), frame: CLK.frame, busy: CLK.busyMs, lost: CLK.lostMs, hz: CLK.viHz,
  fs: { fields: FSK.fields, skipped: FSK.skipped, drawn: FSK.drawn, snaps: FSK.snapsTaken, snapMs: FSK.snapMs, redo: FSK.redo, redoFields: FSK.redoFields, onGpu: FSK.fq.length },
  gq: { held: GQ.held, heldMs: GQ.heldMs, forced: GQ.forced }, cb: { holds: CB.holds, forced: CB.forced },
  pres: { shown: PRES.shown, frames: PRES.frames }, aud: { sent: AUD.sent, dropped: AUD.dropped },
  sched: { ticks: CLK.ticks, imm: SCHED.immTicks, tmr: SCHED.tmrTicks, raf: SCHED.rafTicks, notOwed: SCHED.notOwed, paceHeld: PACECAP.p ? PACECAP.p.held : 0, repayHeld: REPAY.held } }; })())`;

const out = { base: BASE, duty: DUTY, acct: ACCT, q: EXTRA, load0: os.loadavg()[0] };
try {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/RESULT|⚠|\[fskip\]|\[present\]/.test(t)) console.log('  > ' + t.slice(0, 200)); });
  // --game NAME: that title through the page's own ?game=&autostart instead of the bench's (SM64)
  const GAME = flag('game', '');
  const q = GAME ? `?game=${encodeURIComponent(GAME)}&autostart&workerrig=clock${EXTRA ? '&' + EXTRA : ''}`
                 : `?bench=1&benchauto=1&benchsec=${WARM + SEC + 60}&benchroom=0&workerrig=clock${EXTRA ? '&' + EXTRA : ''}`;
  await page.goto(BASE + '/n64/index.html' + q, { waitUntil: 'domcontentloaded' });
  const ev = (src) => page.evaluate((s) => { const W = window.__n64Worker; if (!W || !W.state().booted) return null; return W.eval(s); }, src);
  const tb = Date.now(); let booted = false;
  while (Date.now() - tb < 400000) { await sleep(1000); const r = await ev('1').catch(() => null); if (r != null) { booted = true; break; } }
  if (!booted) throw new Error('worker never booted');
  const tBoot = Date.now(); console.log('booted after ' + ((tBoot - tb) / 1000).toFixed(0) + ' s; warming ' + WARM + ' s');
  await sleep(WARM * 1000);
  if (flag('pageeval', '')) { out.pageEval = await page.evaluate(flag('pageeval', '')).catch((e) => 'ERR ' + e); console.log('pageeval: ' + JSON.stringify(out.pageEval).slice(0, 2000)); }
  if (flag('eval', '')) { out.eval = await ev(flag('eval', '')).catch((e) => 'ERR ' + e); console.log('eval: ' + out.eval); }
  if (ACCT) console.log('install: ' + await ev(INSTALL));
  await sleep(1000);
  const a0 = JSON.parse(await ev(READ)), o0 = threads(), w0 = Date.now();
  // --perf PATH: perf record of the renderer + GPU processes over the window (attribution only)
  let perf = null; const PERF = flag('perf', '');
  if (PERF) { const pids = procTree().filter((p) => p.type === 'renderer' || p.type === 'gpu-process').map((p) => p.pid).join(',');
    perf = spawn(process.env.PERF_BIN || '/usr/lib/linux-tools-6.8.0-147/perf', ['record', '--no-buildid-cache', '-F', '499', '-g', '-p', pids, '-o', PERF], { stdio: 'ignore' }); }
  await sleep(SEC * 1000);
  if (perf) { perf.kill('SIGINT'); await new Promise((r) => perf.on('exit', r)); }
  const a1 = JSON.parse(await ev(READ)), o1 = threads(), w1 = Date.now();
  const wall = a1.t - a0.t, osWall = w1 - w0;
  const dd = (x, y) => { const r = {}; for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) r[k] = (y[k] || 0) - ((x || {})[k] || 0); return r; };
  const B = dd(a0.b, a1.b), N = dd(a0.n, a1.n), GL = dd(a0.gl, a1.gl), GLN = dd(a0.glN, a1.glN);
  const pct = (v) => +(100 * v / wall).toFixed(2);
  const acct = {}; let sum = 0; for (const [k, v] of Object.entries(B).sort((p, q2) => q2[1] - p[1])) { acct[k] = { pct: pct(v), msPerS: +(v / wall * 1000).toFixed(1), n: N[k] }; sum += v; }
  const fields = a1.vi - a0.vi;
  out.js = { wallMs: +wall.toFixed(0), coveredPct: pct(sum), fieldRate: +(fields / (wall / 1000) / (a1.hz || 60)).toFixed(4), fields,
             glCallsPerField: fields ? +((a1.glCalls - a0.glCalls) / fields).toFixed(0) : null, acct,
             glTop: Object.entries(GL).sort((p, q2) => q2[1] - p[1]).slice(0, 25).map(([k, v]) => [k, pct(v), GLN[k]]),
             fs: dd(a0.fs, a1.fs), sched: dd(a0.sched, a1.sched), gq: dd(a0.gq, a1.gq), cb: dd(a0.cb, a1.cb), pres: dd(a0.pres, a1.pres), aud: dd(a0.aud, a1.aud) };
  // OS: per thread ms of CPU per second of wall, and run-queue wait
  const osr = [];
  for (const [k, t1] of o1) { const t0 = o0.get(k); if (!t0) continue; const run = (t1.run - t0.run) / osWall * 1000, wait = (t1.wait - t0.wait) / osWall * 1000;
    if (run > 2) osr.push({ proc: t1.proc, pid: t1.pid, comm: t1.comm, tid: +k.split(':')[1], cpuMsPerS: +run.toFixed(1), rqWaitMsPerS: +wait.toFixed(1) }); }
  osr.sort((p, q2) => q2.cpuMsPerS - p.cpuMsPerS);
  const procs = {}; for (const p of procTree()) { try { procs[p.pid] = readFileSync(`/proc/${p.pid}/cmdline`, 'latin1').split('\0').filter((a) => /^--(type|extension-process|renderer-client-id|utility-sub-type|lang)/.test(a)).join(' '); } catch (_e) {} }
  const byProc = {}; for (const t of osr) byProc[t.pid] = +((byProc[t.pid] || 0) + t.cpuMsPerS).toFixed(1);
  out.os = { wallMs: osWall, threads: osr.slice(0, 24), byProc, procs };
  try { out.dutyStatus = JSON.parse(readFileSync(dutyFile, 'utf8')); } catch (_e) {}
  out.load1 = os.loadavg()[0];
} catch (e) { out.error = String(e && e.stack || e); }
finally { if (duty) duty.kill('SIGTERM'); await browser.close().catch(() => {}); try { rmSync(udd, { recursive: true, force: true }); rmSync(dutyFile, { force: true }); } catch (_e) {} }
console.log('RESULT ' + JSON.stringify(out, null, 1));
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out));
