#!/usr/bin/env node
// ============================================================================
// toaster_split.mjs — WHERE A DREAMCAST TOASTER FRAME'S TIME GOES, PER SECOND.
//
// tools/toaster_bench.mjs gives the verdict (pass/speed/over); this gives the
// split behind it, from counters the shipped worker already publishes — no
// instrumentation is added to the page or the core:
//   __dcProbe().pace  {emu, held, gate, paced, wall, drop}  (flycast_worker.js
//                     'ips': emu = inside run_iter, held = render hand-off,
//                     gate = parked on the lockstep gate, drop = governor debt
//                     thrown away)
//   __dcProbe().fskip {frames, drawn, skipped, lagSkips}
//   the worker's [split] line (EmscriptenWorker.cpp): rr / ml / rnd / jit*
// Same arm as the gate: SwiftShader, --max-old-space-size=512, and the
// tools/toaster_duty.py SIGSTOP duty cycle at <rate> on every renderer process.
// --room opens the bench's loopback room directly and prints the joiner (J)
// beside the host. --prof S takes a CDP CPU profile of the emulation worker for
// S seconds once the seed restore has settled (attribution only — CLAUDE.md
// gate 10: never size a win from a profile).
//
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node dreamcast/tools/toaster_split.mjs <rate> <sec> [extra-query] \
//        [--room] [--prof S --profout F.cpuprofile] [--shot F.png] [--gpuoff]
//
// Findings: dreamcast/docs/toaster-split/TASKS.md
// ============================================================================
import { createRequire } from 'module'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const guard = (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default;
const a = process.argv.slice(2); const rate = +a[0] || 1, secs = +a[1] || 30, extra = a[2] && !a[2].startsWith('--') ? a[2] : '';
const fl = (n) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : null; };
const prof = +fl('prof') || 0, shot = fl('shot'), room = a.includes('--room');
// --ab NAME:SECS — an in-run A/B of an EXACT runtime knob (NAME = a _flycast_set_NAME export, js.VAR for a worker global, or fn.FUNC for a worker function called with the arm's value): once the seed restore has
// settled, call Module._flycast_set_NAME(1/0) in the emulation worker, alternating every
// SECS s, and report emulation ms per guest second for each arm over the heartbeats that
// lie wholly inside one arm (the first after each switch is dropped). Interleaving at this
// grain cancels the box's drift, which run-to-run pairs cannot (they read +-8% here).
const ab = fl('ab'); const [abName, abSecs] = ab ? [ab.split(':')[0], +(ab.split(':')[1] || 5)] : [null, 0];
// NAME:SECS:V1:V0 sends V1 / V0 for the two arms (default 1 / 0); NAME:SECS:1:1 is a placebo with the same flushes.
const abVal = ab && ab.split(':').length >= 4 ? { 1: ab.split(':')[2], 0: ab.split(':')[3] } : { 1: '1', 0: '0' };
// The FIRST arm window is discarded: it follows the cold start (boot / state load / first
// compile), not a flush from the other arm, and read +4.5..8.5% slow in placebo runs (1:1).
let abSwitch = 0;
// --abskip N: heartbeats dropped after each switch (default 2). A --abreload switch at the toaster
// rate needs more: the reloaded state's JIT refill spans several heartbeats.
const ABSKIP = +(fl('abskip') || 2);
let abArm = null, abNext = 0, abSkip = 0, abSess = null; const abAcc = { 1: { e: 0, x: 0, n: 0 }, 0: { e: 0, x: 0, n: 0 } };
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'toaster-split-'));
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: 'new', userDataDir: udd,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=512' + (process.env.TS_JSFLAGS ? ' ' + process.env.TS_JSFLAGS : '')], protocolTimeout: 600000 });
guard.guard(b, 'dreamcast/tools/toaster_split.mjs');
let duty = null;
// The GPU process (SwiftShader) is duty-cycled with the renderers (tools/toaster_duty.py gpu=1,
// the gate's arm since 2026-10-15); --gpuoff leaves it at full speed (the old, flattering arm).
const gpuOff = a.includes('--gpuoff');
if (rate > 1) duty = spawn('python3', [path.join(ROOT, 'tools/toaster_duty.py'), String(b.process().pid), String(rate), '2', '-', gpuOff ? '0' : '1'], { stdio: 'ignore' });
console.log(`arm: rate ${rate}, GPU process ${rate > 1 ? (gpuOff ? 'NOT throttled (--gpuoff)' : 'throttled') : 'n/a'}`);
const p = await b.newPage(); const errs = [];
p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
// --dump F: write every [jitdump] module (?jitdump=<pc>|all) to F.<n>.wasm. --census F: at the end, write the
// worker's ?jitcensus=1 report (self.__dcCensusReport) to F as JSON.
const dumpF = fl('dump'); let dumpBuf = null, dumpN = 0;
const censF = fl('census'); let censState = 0;
const peekA = fl('peek');
// --abreload: with --state, every arm switch also re-loads that state, so every arm window
// replays the same guest seconds (a scene that drifts, e.g. an idle level timing out to the title).
const abReload = a.includes('--abreload');
const stateF = fl('state'); let stateHb = -1;
const settled = (r) => r.booted && !r.rest && r.hbr >= 3 && (!stateF || (stateHb >= 0 && r.hb >= stateHb + 5));
p.on('console', (m) => { const t = m.text();
  if (dumpF && /\[jitdump\]/.test(t)) { const body = t.replace(/^.*\[jitdump\] /, '');
    if (/^begin/.test(body)) dumpBuf = []; else if (/^end/.test(body)) { if (dumpBuf) fs.writeFileSync(dumpF + '.' + (dumpN++) + '.wasm', Buffer.from(dumpBuf.join(''), 'base64')); dumpBuf = null; }
    else if (dumpBuf) dumpBuf.push(body.split(' ')[1] || ''); return; } if (/error|threw|desync/i.test(t)) errs.push(t.slice(0, 200)); if (/\[split\]/.test(t)) console.log('  ' + t.replace(/^.*\[split\]/, '[split]').slice(0, 260)); if (/\[(sh4emit|pchist|pswff|gwff|xff|g2|ctxsnap|setg2|armhist|armcode|armtime|aicatime|armff|setarmff|b2ff|setb2ff|lazydisc|glcount|glinfo|lowrender|glsync|glsizes|aicahash)/.test(t)) console.log('  ' + t.slice(0, /ctxsnap/.test(t) ? 4000 : 520)); if (/\[peek\]/.test(t)) console.log(t); });
const code = 'Z' + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z2-9]/g, 'Q');
await p.goto(room ? `${BASE}/dreamcast.html?bench=1&benchauto=1&benchsec=${secs}&benchphase=room&np=${code}&host=1&net=local&game=pso2${extra}` : `${BASE}/dreamcast.html?bench=1&benchauto=1&benchroom=0&benchsec=${secs}${extra}`, { waitUntil: 'load', timeout: 180000 });
let evErrs = 0; if (fl('css')) await p.addStyleTag({ content: fl('css') }).catch((e) => console.log('css failed ' + e));   // --css 'rule' (DIAG: e.g. the canvas's on-screen size)
const rows = []; let profd = false; const t0 = Date.now();
while (Date.now() - t0 < (secs + 240 * Math.max(1, rate / 3)) * 1000) {
  await sleep(1000);
  const r = await p.evaluate(() => { const q = window.__dcProbe && window.__dcProbe(); return q && { hb: q.hb, booted: q.booted, aicaX: q.aicaX, fps: q.fps, pace: q.pace, fs: q.fskip, rest: q.restoring, hbr: q.hbSinceRestore, done: !!window.__benchResult, res: window.__benchResult && (window.__benchResult.room || window.__benchResult.solo), j: (() => { try { const f = document.querySelector('iframe'); const q = f && f.contentWindow.__dcProbe && f.contentWindow.__dcProbe(); return q && { x: q.aicaX, pace: q.pace, fs: q.fskip }; } catch (e) { return null; } })() }; }).catch((e) => { if (++evErrs <= 3) console.log('probe evaluate failed: ' + String(e && e.message || e).slice(0, 200)); return null; });
  if (!r) continue;
  if (stateF && r.booted && !r.rest && r.hbr >= 3 && stateHb < 0) {
    // --state PATH (repo-relative): replace the bench scene with a savestate through the worker's own loadState
    const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    const cs = wt && await wt.createCDPSession().catch(() => null);
    const ev = cs && await cs.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `fetch('/${stateF}').then((x) => x.arrayBuffer()).then((buf) => { self.__abState = buf.slice(0); self.onmessage({ data: { cmd: 'loadState', data: buf } }); return buf.byteLength; })` }).catch((e) => ({ result: { value: String(e) } }));
    console.log('state ' + stateF + ' applied: ' + JSON.stringify(ev && ev.result && ev.result.value)); stateHb = r.hb; if (cs) await cs.detach().catch(() => {});
  }
  if (abName && settled(r) && Date.now() >= abNext && !r.done) {
    const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    if (wt && !abSess) { abSess = await wt.createCDPSession().catch((e) => { console.log('ab session failed ' + e); return null; }); }
    if (abSess) { abArm = abArm === 1 ? 0 : 1; abSwitch++;
      const ev = await abSess.send('Runtime.evaluate', { expression: (abName.startsWith('js.') ? `self.${abName.slice(3)} = ${abArm ? 'true' : 'false'}; 1` : abName.startsWith('fn.') ? `self.${abName.slice(3)}('${abVal[abArm]}'); 1` : `self.Module._flycast_set_${abName}(${abVal[abArm]}); 1`) + (stateF && abReload ? `; self.__abState && self.onmessage({ data: { cmd: 'loadState', data: self.__abState.slice(0) } }); 1` : '') }).catch((e) => ({ exceptionDetails: String(e) }));
      if (ev.exceptionDetails) console.log('ab set failed ' + JSON.stringify(ev.exceptionDetails).slice(0, 200));
      abNext = Date.now() + abSecs * 1000; abSkip = ABSKIP; }
  }
  if (r.booted && (!rows.length || rows[rows.length - 1].hb !== r.hb)) { rows.push(r); const pc = r.pace || {}; const f = r.fs || {};
    if (abArm !== null && abSwitch >= 2) { if (abSkip > 0) abSkip--; else if (+r.aicaX > 0) { const A = abAcc[abArm]; A.e += +pc.emu; A.w = (A.w || 0) + (+pc.wall - (+pc.paced || 0)); A.x += +r.aicaX; A.n++; } }
    console.log(`hb${r.hb} x=${(+r.aicaX).toFixed(3)} fps=${r.fps} emu=${pc.emu} held=${pc.held} gate=${pc.gate} paced=${pc.paced} wall=${pc.wall} drop=${pc.drop} fs=${f.frames}/${f.drawn}/${f.skipped}/${f.lagSkips}` + (r.j && r.j.pace ? ` | J x=${(+r.j.x).toFixed(3)} emu=${r.j.pace.emu} held=${r.j.pace.held} gate=${r.j.pace.gate} paced=${r.j.pace.paced} drop=${r.j.pace.drop}` : '')); }
  if (prof && !profd && settled(r)) {
    profd = true;
    const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    if (wt) { const s = await wt.createCDPSession(); await s.send('Profiler.enable'); await s.send('Profiler.setSamplingInterval', { interval: 200 }); await s.send('Profiler.start');
      await sleep(prof * 1000); const { profile } = await s.send('Profiler.stop'); fs.writeFileSync(fl('profout') || '/tmp/dcsplit.cpuprofile', JSON.stringify(profile)); console.log('profile saved'); }
    else console.log('no worker target', b.targets().map((t) => t.type() + ' ' + t.url()).join('\n'));
  }
  if (censF && settled(r) && (censState === 0 || (censState === 1 && r.done))) {
    const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    const cs = wt && await wt.createCDPSession().catch(() => null);
    const ev = cs && await cs.send('Runtime.evaluate', { expression: 'JSON.stringify(self.__dcCensusReport ? self.__dcCensusReport(60) : null)', returnByValue: true }).catch((e) => ({ result: { value: String(e) } }));
    if (censState === 1) { fs.writeFileSync(censF, (ev && ev.result && ev.result.value) || 'null'); console.log('census saved ' + censF); }
    censState++; if (cs) await cs.detach().catch(() => {});
  }
  if (peekA && r.done) {   // --peek ADDR:BYTES:FILE — guest memory at the end of the run (SH4 view, 16-bit reads)
    const [pa, pn, pf] = peekA.split(':'); const wt = b.targets().find((t) => /worker|other/.test(t.type()) && /flycast_worker\.js/.test(t.url()));
    const cs = wt && await wt.createCDPSession().catch(() => null);
    const ev = cs && await cs.send('Runtime.evaluate', { returnByValue: true, expression: `(function(){ const o = []; for (let i = 0; i < ${+pn}; i += 2) o.push(self.Module._sh4_mem_read16((0x${pa} + i) >>> 0) & 0xffff); return o; })()` }).catch(() => null);
    if (ev && ev.result && ev.result.value) { fs.writeFileSync(pf, Buffer.from(new Uint16Array(ev.result.value).buffer)); console.log('peek saved ' + pf); }
  }
  if (r.done && !r.res) console.log('RESULT has no window: ' + await p.evaluate(() => JSON.stringify(window.__benchResult).slice(0, 600)).catch((e) => String(e)));
  if (r.done) { console.log('RESULT', JSON.stringify(r.res && { speed: r.res.speed, over: r.res.over, frames: r.res.frames, ms: r.res.ms })); break; }
}
if (abName) for (const k of [1, 0]) { const A = abAcc[k]; console.log(`AB ${abName}=${k} emu/guest-s=${A.x ? (A.e / A.x).toFixed(1) : 'n/a'} busy/guest-s=${A.x ? (A.w / A.x).toFixed(1) : 'n/a'} meanx=${A.n ? (A.x / A.n).toFixed(4) : 'n/a'} heartbeats=${A.n}`); }
if (shot) await p.screenshot({ path: shot }).catch(() => {});
console.log('errors', JSON.stringify(errs.slice(0, 5)), 'load', os.loadavg().map((x) => x.toFixed(2)).join(' '));
if (duty) duty.kill('SIGTERM'); await b.close(); fs.rmSync(udd, { recursive: true, force: true });
