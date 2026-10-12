#!/usr/bin/env node
// ============================================================================
// toaster_bench.mjs — THE STANDING TOASTER GATE.
//
// Product target (user): every emulator page runs 60 fps at exactly 1.000x with
// zero input lag on the SLOWEST hardware — "a toaster". "The test machine is
// overloaded" is not an excuse: a toaster is slower than this box. This tool
// runs lib/bench.js (?bench=1&benchauto=1 — solo window, then a loopback
// 2-player room on pages that have rooms) under a calibrated low-end-device arm
// and reports pass/speed/over/p50/p99 per page, plus HEADROOM: the largest CPU
// throttle rate at which the page still passes.
//
//   npm run web                                   (port 8080, CLAUDE.md gate #2)
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/toaster_bench.mjs [opts]
//
//   --pages n64,ps1,snes,genesis,gba,gamecube,dreamcast   (default: all 7)
//   --rate auto|<n>   CDP CPU throttle rate. auto (default) = calibrate (below).
//   --reps 3          reps at the toaster rate
//   --ladder 1|0      headroom search (1 rep per ladder step), default 1
//   --sec 20          bench window seconds (benchsec)
//   --heap 512        --max-old-space-size MB (low-memory arm); 0 = off
//   --gpu swiftshader|default
//   --throttle duty|cdp   (default duty — see 2. below)
//   --period 2        duty-cycle period ms
//   --proof-only      run calibration + the arm-difference proofs and exit
//   --out <file>      JSON (default /tmp/toaster-bench.json)
//
// ── THE TOASTER ARM ─────────────────────────────────────────────────────────
//   1. --use-angle=swiftshader --enable-unsafe-swiftshader: no GPU. The arm
//      proof is the page's own WebGL renderer string (bench result
//      device.renderer) — it must name SwiftShader, else the cell is VOID.
//   2. CPU throttle on EVERY thread the emulation runs on — page main thread,
//      dedicated workers, NESTED workers, service workers, audio worklets.
//      ⚠ CDP CANNOT DO THIS (measured 2026-10-12, Chrome 141.0.7390.37):
//      Emulation.setCPUThrottlingRate on a worker / service_worker target is
//      REFUSED — "Operation is only supported for pages, not workers" — and the
//      page-level throttle at rate 3 measured slowdown 0.90x on a dedicated
//      worker and 1.05x on a nested one (BenchmarkIndex): it does not reach the
//      threads the emulators run on. That is the same trap device_matrix found
//      for network throttling. (--throttle cdp keeps that arm as the control.)
//      So the default (--throttle duty) is tools/toaster_duty.py: a SIGSTOP /
//      SIGCONT duty cycle on every renderer process of this browser (period
//      --period 2 ms, runs period/R of each period, SCHED_FIFO). Every thread in
//      those processes gets 1/R of its throughput. The GPU process is NOT
//      throttled (SwiftShader rasterizes there on the host CPU), matching CDP's
//      semantics — this flatters GPU-heavy pages. Quantization: a frame can be
//      stretched by up to one off-slice (period·(1-1/R) ≈ 1.7 ms at R=6.2)
//      beyond R× its work, which a genuinely slow CPU would not add.
//      PROOF, every invocation: Lighthouse BenchmarkIndex is timed in the page,
//      a dedicated worker, a nested worker and a service worker at rate 1 and at
//      rate R; any context slowed < 0.5·R VOIDS the run (exit 2). A second,
//      in-run witness: per-frame cost p50 at rate R vs rate 1 (costRatio).
//   3. Low memory: --js-flags=--max-old-space-size=<heap>. Proof:
//      performance.memory.jsHeapSizeLimit must equal the flag (±10%).
//
// ── CALIBRATION (--rate auto) ───────────────────────────────────────────────
//   Replicates Chrome DevTools' own "Calibrated CPU throttling" (DevTools 134+,
//   front_end/panels/mobile_throttling/CalibrationController.ts): it runs the
//   Lighthouse BenchmarkIndex and picks the throttle rate at which the score
//   drops to the reference device's score. DevTools' constants:
//       lowScore = 264   "a low-tier device (like a Moto G4 Power 2022)"
//       midScore = 1000  "a mid-tier device (like a Pixel 5)"
//   The toaster rate is the LOW-TIER one: rate = score(1)/264, then refined
//   once from a measurement at that rate (DevTools bisects to ±10 points).
//   UNCERTAINTY, stated plainly: BenchmarkIndex is a JS string-GC + array-copy
//   loop, not wasm; CDP throttling is time-slicing of each thread, so it does
//   NOT model memory bandwidth, cache size, SIMD width or a weaker GPU — and the
//   GPU process (where SwiftShader rasterizes on the host CPU) is NOT throttled
//   at all, which flatters GPU-heavy pages. A real Moto G Power 2022 also has 8
//   cores to this VM's vCPUs. Treat the rate as ±~30% of a real toaster.
//   MEASURED 2026-10-12 on this 4-vCPU VM: page score at rate 1 = 1723-2004
//   (7 invocations), auto-calibration landed on 6.19 (score 272 at that rate;
//   DevTools' mid-tier/Pixel 5 equivalent = 1.78). The campaign used --rate 6.2.
//   Proof slowdowns at 6.2 (BenchmarkIndex, per invocation): page 7.4-10.2x,
//   worker 5.3-7.2x, nested worker 6.1-6.5x, service worker 5.7-8.8x — the
//   main thread is over-slowed relative to workers (it also hosts the bench).
//   Room caveat (lib/bench.js): the loopback joiner is a same-origin iframe in
//   the SAME renderer, so on main-thread cores (snes, genesis) BOTH players'
//   cores run on ONE main thread — a room cell there is a two-cores-one-thread
//   test, harsher than two real devices.
//
// ── VERDICT ─────────────────────────────────────────────────────────────────
//   Per window: pass = over == 0 && |speed-1| <= 0.005 (lib/bench.js passOf),
//   room fails on desync, a room that never ran fails. Load average is recorded
//   before/after each run; per CLAUDE.md the toaster verdict does NOT excuse
//   load — but a cell is still annotated with it.
// ============================================================================
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const guardMod = (await import('./browser_leak_guard.js')).default;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const PATHS = { n64: '/n64/index.html', ps1: '/ps1.html', snes: '/snes.html', genesis: '/genesis.html', gba: '/gba.html', gamecube: '/gamecube.html', dreamcast: '/dreamcast.html' };
const PAGES = flag('pages', Object.keys(PATHS).join(',')).split(',');
const REPS = +flag('reps', 3);
const LADDER = flag('ladder', '1') !== '0';
const SEC = +flag('sec', 20);
const HEAP = +flag('heap', 512);
const GPU = flag('gpu', 'swiftshader');
const OUT = flag('out', '/tmp/toaster-bench.json');
const PROOF_ONLY = argv.includes('--proof-only');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LOW_SCORE = 264, MID_SCORE = 1000;   // DevTools CalibrationController.ts
const LADDER_RATES = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => os.loadavg().map((x) => +x.toFixed(2));
const log = (...a) => console.log('[toaster]', ...a);
const dbg = (...a) => { if (process.env.TOASTER_DEBUG) console.log('[toaster:dbg]', new Date().toISOString().slice(11, 19), ...a); };

function chromeArgs() {
  const a = ['--no-sandbox', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'];
  if (GPU === 'swiftshader') a.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  if (HEAP > 0) a.push(`--js-flags=--max-old-space-size=${HEAP}`);
  return a;
}
async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-'));
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir, args: chromeArgs(), protocolTimeout: 600000 });
  try { guardMod.guard(b, 'tools/toaster_bench.mjs'); } catch (_e) {}
  b._udd = userDataDir;
  return b;
}
async function close(b) { try { await b.close(); } catch (_e) {} try { fs.rmSync(b._udd, { recursive: true, force: true }); } catch (_e) {} }

// ---- throttle EVERY target --------------------------------------------------
// THROTTLE=duty (default): tools/toaster_duty.py SIGSTOP/SIGCONT duty-cycles every renderer
// process, which slows the page main thread AND every worker in it. THROTTLE=cdp: the CDP
// Emulation.setCPUThrottlingRate path, kept only as the control that shows it does NOT reach
// workers (Chrome 141: "Operation is only supported for pages, not workers").
// Either way a CDP session is opened on every target (service-worker proof evaluates over it).
const THROTTLE = flag('throttle', 'duty');
const DUTY_PERIOD_MS = +flag('period', 2);   // quantization: a frame can stretch by up to one off-slice (period·(1-1/R))
function throttleAll(browser, rate) {
  const seen = new Map();   // target -> record
  const TYPES = new Set(['page', 'worker', 'service_worker', 'shared_worker', 'other']);
  const apply = async (t) => {
    if (seen.has(t) || !TYPES.has(t.type())) return;
    const rec = { type: t.type(), url: (t.url() || '').slice(0, 120), ok: THROTTLE !== 'cdp', err: null };
    seen.set(t, rec);
    try {
      const s = await t.createCDPSession(); rec.session = s;
      if (THROTTLE === 'cdp') { await s.send('Emulation.setCPUThrottlingRate', { rate }); rec.ok = true; }
    } catch (e) { rec.err = String(e.message || e).slice(0, 160); }
  };
  browser.on('targetcreated', apply);
  const iv = setInterval(() => { for (const t of browser.targets()) apply(t); }, 500);
  for (const t of browser.targets()) apply(t);
  let duty = null, statusFile = null;
  if (THROTTLE === 'duty') {
    statusFile = path.join(browser._udd, '..', path.basename(browser._udd) + '.duty.json');
    duty = spawn('python3', [path.join(TOOLS_DIR, 'toaster_duty.py'), String(browser.process().pid), String(rate), String(DUTY_PERIOD_MS), statusFile], { stdio: 'ignore' });
  }
  const dutyStatus = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (_e) { return null; } };
  return { stop: () => { clearInterval(iv); browser.off('targetcreated', apply); const st = dutyStatus(); if (duty) duty.kill('SIGTERM'); try { fs.rmSync(statusFile, { force: true }); } catch (_e) {} return st; },
           dutyStatus,
           records: () => [...seen.values()].map(({ session, ...r }) => r),
           sessionFor: (t) => { const r = seen.get(t); return r && r.session; } };
}

// ---- Lighthouse BenchmarkIndex (verbatim logic from DevTools) ---------------
const BENCH_SRC = `function computeBenchmarkIndex(duration){const halfTime=duration/2;
function gc(){const start=Date.now();let it=0;while(Date.now()-start<halfTime){let s='';for(let j=0;j<10000;j++){s+='a';}if(s.length===1)throw new Error('x');it++;}return Math.round(it/10/((Date.now()-start)/1000));}
function nogc(){const A=[],B=[];for(let i=0;i<100000;i++){A[i]=B[i]=i;}const start=Date.now();let it=0;while(it%10!==0||Date.now()-start<halfTime){const s=it%2===0?A:B,t=it%2===0?B:A;for(let j=0;j<s.length;j++){t[j]=s[j];}it++;}return Math.round(it/10/((Date.now()-start)/1000));}
return (gc()+nogc())/2;}`;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// One browser, one page, contexts: page main thread, dedicated worker, nested
// worker (spawned by that worker), service worker. Returns score per context at `rate`.
async function scoreContexts(rate, reps = 3, durMs = 1000) {
  const b = await launch();
  const th = throttleAll(b, rate);
  const out = { rate, contexts: {} };
  try {
    const p = await b.newPage();
    dbg('proof page goto, rate', rate);
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    dbg('loaded');
    // service worker (registered from a scratch script scoped to /__toaster/ so it controls nothing)
    // Service worker: register the site's own SW file under a scratch scope so it controls nothing.
    await p.evaluate(async () => { try { await navigator.serviceWorker.register('/coi-serviceworker.js', { scope: '/__toaster_proof/' }); } catch (e) { window.__swErr = String(e); } });
    const nsrc = `${BENCH_SRC};self.onmessage=e=>postMessage(computeBenchmarkIndex(e.data));`;
    const wsrc = `${BENCH_SRC};const nested=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(nsrc)}],{type:'text/javascript'})));
self.onmessage=e=>{if(e.data.who==='nested'){nested.onmessage=m=>postMessage(m.data);nested.postMessage(e.data.d);}else postMessage(computeBenchmarkIndex(e.data.d));};`;
    await p.evaluate((src) => {
      window.__w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      window.__wb = (who, d) => new Promise((r) => { window.__w.onmessage = (m) => r(m.data); window.__w.postMessage({ who, d }); });
    }, wsrc);
    await sleep(1500);   // let the sweep throttle the new worker targets
    const run = async (who) => {
      const xs = [];
      for (let i = 0; i < reps; i++) {
        if (who === 'page') xs.push(await p.evaluate(`(${BENCH_SRC})(${durMs})`));
        else xs.push(await p.evaluate((w, d) => window.__wb(w, d), who, durMs));
        await sleep(1200);   // nested worker spawns lazily: give the sweep a chance before rep 2
      }
      return xs;
    };
    for (const who of ['page', 'worker', 'nested']) { dbg('score', who); const xs = await run(who); out.contexts[who] = { median: median(xs), all: xs }; }
    // service worker: evaluate in its own target
    let sw = null;
    for (let i = 0; i < 20 && !sw; i++) { sw = b.targets().find((t) => t.type() === 'service_worker'); if (!sw) await sleep(250); }
    dbg('sw target', !!sw);
    if (sw) {
      // Evaluate over the SAME CDP session that throttled it (puppeteer's sw.worker() hung here).
      await sleep(1000);
      const ses = th.sessionFor(sw);
      const xs = [];
      if (ses) for (let i = 0; i < reps; i++) {
        const r = await Promise.race([ses.send('Runtime.evaluate', { expression: `(${BENCH_SRC})(${durMs})`, returnByValue: true }), sleep(30000).then(() => null)]);
        if (r && r.result) xs.push(r.result.value);
      }
      out.contexts.service_worker = xs.length ? { median: median(xs), all: xs } : { median: null, err: ses ? 'evaluate timed out' : 'no session' };
    } else out.contexts.service_worker = { median: null, err: 'no service_worker target' + (await p.evaluate(() => window.__swErr || '')) };
    out.targets = th.records();
    out.heapLimitMB = await p.evaluate(() => performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null);
  } finally { out.duty = th.stop(); await close(b); }
  return out;
}

async function calibrateAndProve(fixedRate) {
  log('calibration: BenchmarkIndex at rate 1, load', load().join(' '));
  const r1 = await scoreContexts(1);
  let rate = fixedRate;
  let rR, refine = null;
  if (!rate) {
    rate = +(r1.contexts.page.median / LOW_SCORE).toFixed(2);
    const probe = await scoreContexts(rate);
    refine = { firstRate: rate, scoreAtFirst: probe.contexts.page.median };
    rate = +(rate * probe.contexts.page.median / LOW_SCORE).toFixed(2);
    rR = (Math.abs(rate - refine.firstRate) / refine.firstRate < 0.03) ? probe : await scoreContexts(rate);
  } else rR = await scoreContexts(rate);
  const proof = {};
  for (const k of Object.keys(r1.contexts)) {
    const a = r1.contexts[k].median, b = rR.contexts[k].median;
    const slow = a && b ? +(a / b).toFixed(2) : null;
    proof[k] = { score1: a, scoreR: b, slowdown: slow, throttled: slow != null && slow >= 0.5 * rate };
  }
  // V8 reports old-space + young-gen: --max-old-space-size=512 reads 608 MB. Unflagged it is GBs.
  const heapOk = HEAP > 0 ? (r1.heapLimitMB != null && r1.heapLimitMB <= HEAP * 1.25) : null;
  return { rate, refine, lowScore: LOW_SCORE, midScore: MID_SCORE, midRate: +(r1.contexts.page.median / MID_SCORE).toFixed(2),
           scoreAtRate: rR.contexts.page.median, proof, heap: { flagMB: HEAP, jsHeapLimitMB: r1.heapLimitMB, ok: heapOk },
           targetsAtRate: rR.targets, dutyAtRate: rR.duty, throttleMode: THROTTLE, load: load() };
}

// ---- one bench run ------------------------------------------------------------
const passOf = (w) => !!w && !w.error && w.over === 0 && w.speed != null && Math.abs(w.speed - 1) <= 0.005;
async function benchRun(page, rate) {
  const b = await launch();
  const th = throttleAll(b, rate);
  const errs = []; const l0 = load(); const t0 = Date.now();
  let r = null, renderer = null, heapMB = null, maxWorkers = 0, dutySt = null;
  try {
    const p = await b.newPage();
    p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    const url = `${BASE}${PATHS[page]}?bench=1&benchauto=1&benchsec=${SEC}`;
    await p.goto(url, { waitUntil: 'load', timeout: 180000 }).catch((e) => errs.push('goto ' + e.message));
    const deadline = Date.now() + Math.min(40, 8 + 4 * rate) * 60000;
    while (!r && Date.now() < deadline) {
      await sleep(3000);
      r = await p.evaluate(() => window.__benchResult ? Object.assign({ _phase: window.__bench && window.__bench.phase }, window.__benchResult) : null).catch(() => null);
      maxWorkers = Math.max(maxWorkers, b.targets().filter((t) => /worker/.test(t.type())).length);
      if (heapMB == null) heapMB = await p.evaluate(() => performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null).catch(() => null);
    }
    renderer = r && r.device ? r.device.renderer : null;
  } finally { dutySt = th.stop(); }
  const recs = th.records();
  await close(b);
  const w = (s) => s ? { pass: passOf(s), speed: s.speed, over: s.over, frames: s.frames, p50: s.ms && s.ms.p50, p99: s.ms && s.ms.p99,
                          max: s.ms && s.ms.max, budgetMs: s.budgetMs, mode: s.mode, delay: s.delay, error: s.error } : null;
  const ss = GPU !== 'swiftshader' ? null : /swiftshader/i.test(String(renderer || ''));
  return { page, rate, ok: !!r, pass: r ? r.pass : false, solo: r ? w(r.solo) : { pass: false, error: 'no bench result before the deadline' },
           // a room that was attempted (result published from the room phase) and never ran is a FAIL
           room: r && (r.room ? w(r.room) : (r._phase === 'room' ? { pass: false, error: 'room attempted, never ran' } : null)),
           renderer, swiftshaderProof: ss, throttleMode: THROTTLE, duty: dutySt, heapMB, workersSeen: maxWorkers,
           throttled: { targets: recs.length, ok: recs.filter((x) => x.ok).length, types: [...new Set(recs.map((x) => x.type))], failed: recs.filter((x) => !x.ok).slice(0, 4) },
           errors: errs.slice(0, 3), bursts: r && r.bursts ? r.bursts.slice(0, 3) : null, loadBefore: l0, loadAfter: load(), wallS: Math.round((Date.now() - t0) / 1000) };
}

function summarize(rows) {
  const by = (k) => rows.map((x) => x[k]).filter(Boolean);
  const S = (ws) => ws.length ? { pass: `${ws.filter((x) => x.pass).length}/${ws.length}`, speed: ws.map((x) => x.speed), over: ws.map((x) => x.over),
                                  p50: ws.map((x) => x.p50), p99: ws.map((x) => x.p99) } : null;
  return { solo: S(by('solo')), room: S(by('room')) };
}

// ---- --report a.json b.json ...: the table, from saved runs -----------------------
function table(reports) {
  const L = ['| page | window | pass (reps) | speed (reps) | over (reps) | p50 ms | p99 ms | max passing throttle | cost ratio R/1 |', '|---|---|---|---|---|---|---|---|---|'];
  const f = (a, d = 3) => a.map((x) => x == null ? '-' : (typeof x === 'number' ? +x.toFixed(d) : x)).join(' / ');
  for (const rp of reports) for (const [page, P] of Object.entries(rp.pages || {})) for (const k of ['solo', 'room']) {
    const ws = P.reps.map((x) => x[k]).filter(Boolean);
    if (!ws.length) { L.push(`| ${page} | ${k} | n/a (no ${k}) | | | | | | |`); continue; }
    if (ws.every((w) => w.error)) { L.push(`| ${page} | ${k} | 0/${ws.length} (${ws[0].error}) | | | | | ${P.headroom ? P.headroom[k] : '-'} | |`); continue; }
    L.push(`| ${page} | ${k} | ${ws.filter((w) => w.pass).length}/${ws.length} | ${f(ws.map((w) => w.speed), 4)} | ${f(ws.map((w) => w.over), 0)} | ${f(ws.map((w) => w.p50), 1)} | ${f(ws.map((w) => w.p99), 1)} | ${P.headroom ? P.headroom[k] : '-'} | ${P.costRatio ? P.costRatio[k] : '-'} |`);
  }
  return L.join('\n');
}
if (argv[0] === '--report') {
  const reports = argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  console.log(table(reports));
  for (const rp of reports) { const c = rp.calibration; if (c) console.log(`rate ${c.rate} · proof slowdowns ${Object.entries(c.proof).map(([k, v]) => k + '=' + v.slowdown).join(' ')} · heap ${c.heap && c.heap.jsHeapLimitMB} MB · pages ${Object.keys(rp.pages || {}).join(',')} · load ${c.load}`); }
  process.exit(0);
}

// ---- main -----------------------------------------------------------------------
const report = { started: new Date().toISOString(), chrome: CHROME, args: chromeArgs(), sec: SEC, cores: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1) };
const save = () => fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
const fixed = flag('rate', 'auto') === 'auto' ? null : +flag('rate');
report.calibration = await calibrateAndProve(fixed);
save();
const R = report.calibration.rate;
log('toaster rate', R, 'proof', JSON.stringify(report.calibration.proof), 'heap', JSON.stringify(report.calibration.heap));
const unthrottled = Object.entries(report.calibration.proof).filter(([, v]) => !v.throttled).map(([k]) => k);
if (unthrottled.length) { log('VOID: contexts not throttled:', unthrottled.join(',')); report.void = 'not throttled: ' + unthrottled.join(','); save(); if (!PROOF_ONLY) process.exit(2); }
if (PROOF_ONLY) { save(); process.exit(0); }

report.pages = {};
for (const page of PAGES) {
  const P = report.pages[page] = { reps: [], ladder: [], base1: null };
  for (let i = 0; i < REPS; i++) { const x = await benchRun(page, R); P.reps.push(x); save(); log(page, 'rate', R, 'rep', i + 1, JSON.stringify({ pass: x.pass, solo: x.solo, room: x.room, load: x.loadAfter })); }
  P.summary = summarize(P.reps);
  if (LADDER) {
    // HEADROOM, one rep per step, solo and room tracked separately (one bench run yields both).
    // Bisection over LADDER_RATES, cheapest-first: a window that passes at R ascends; one that
    // fails at R is tried at rate 1 first (a page failing UNTHROTTLED has headroom "<1" and
    // needs no more steps), then bisected between 1 and R.
    const res = { solo: new Map(), room: new Map() };
    const rec = (x) => { for (const k of ['solo', 'room']) if (x[k]) res[k].set(x.rate, x[k] ? x[k].pass : false); };
    P.reps.forEach(rec);
    const step = async (rate) => { const x = await benchRun(page, rate); P.ladder.push(x); rec(x); save(); if (rate === 1) P.base1 = x;
      log(page, 'ladder rate', rate, JSON.stringify({ solo: x.solo && x.solo.pass, room: x.room ? x.room.pass : null, load: x.loadAfter })); return x; };
    const maj = (k) => { const ws = P.reps.map((x) => x[k]).filter(Boolean); return ws.length ? ws.filter((w) => w.pass).length * 2 > ws.length : null; };
    const passAt = (k, r) => res[k].has(r) ? res[k].get(r) : undefined;
    const ks = ['solo', 'room'].filter((k) => maj(k) !== null);
    // ascend while passing
    for (const rate of LADDER_RATES.filter((x) => x > R)) {
      const want = ks.filter((k) => maj(k) === true && LADDER_RATES.filter((y) => y > R && y < rate).every((y) => passAt(k, y) !== false));
      if (!want.length) break;
      await step(rate);
    }
    // descend: rate 1 first, then bisect
    const failing = ks.filter((k) => maj(k) !== true);
    if (failing.length) {
      if (!res.solo.has(1) && !res.room.has(1)) await step(1);
      for (const k of failing) {
        if (passAt(k, 1) !== true) continue;
        let lo = 0, hi = LADDER_RATES.findIndex((x) => x >= R);   // pass at LADDER[lo], fail at R
        if (hi < 0) hi = LADDER_RATES.length;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1, r = LADDER_RATES[mid];
          if (passAt(k, r) === undefined) await step(r);
          if (passAt(k, r)) lo = mid; else hi = mid;
        }
      }
    }
    P.headroom = {};
    for (const k of ['solo', 'room']) {
      const passing = [...res[k].entries()].filter(([, v]) => v).map(([r]) => r);
      P.headroom[k] = res[k].size === 0 ? null : (passing.length ? Math.max(...passing) : '<1');
    }
  }
  // Arm-difference witness on the measured path: per-frame p50 at R vs at rate 1.
  if (!P.base1) { P.base1 = await benchRun(page, 1); save(); }
  const ratio = (k) => { const a = P.base1[k] && P.base1[k].p50, bs = P.reps.map((x) => x[k] && x[k].p50).filter((v) => v != null); return a && bs.length ? +(median(bs) / a).toFixed(2) : null; };
  P.costRatio = { solo: ratio('solo'), room: ratio('room') };
  save();
}
report.finished = new Date().toISOString();
save();
console.log(table([report]));
log('wrote', OUT);
