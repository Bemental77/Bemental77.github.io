#!/usr/bin/env node
// n64_field_cost_probe.mjs — WHAT DOES ONE FIELD COST, FIELD BY FIELD, IN A REAL MK64 RACE?
//
// Asked by a real phone (Mali-G715, MK64 PAL room, worker mode): core cost 17.9-18.75 ms a
// field against a 20 ms budget, bursts up to 620 ms. The target is a steady cost well under
// 14 ms with no field over budget. This rig answers "what is the distribution" — mean, p50,
// p99, max, fields over the period — and "where did it go" (the worker's ?costdbg=1 buckets:
// jit / shader / prog / read / gbsd / tex / buf / sync, the rest = core), on the REAL page
// and worker, for ONE deterministic guest trajectory:
//
//   * the core runs in the worker in rig mode (?worker=1&workerrig=1): the worker's frame
//     clock is off and THIS rig steps the guest, one _neil_ls_run_frame per worker TASK,
//     PACED like the shipped clock (a field is due every 1000/viHz ms; a field that is late
//     runs at once as its own task; debt older than two periods is dropped). So the GPU gets
//     the same task boundaries (fences can be seen signalled, the canvas commits) as a live
//     console.
//   * the pad is a pure function of the frame number (--plan): `mk64race` walks MK64 from
//     power-on through title, 1P, Mario GP, 50cc, Mario, Mushroom Cup into LUIGI RACEWAY (the
//     course whose jumbotron makes the game read its own framebuffer) and drives.
//   * the PICTURE is hashed after every measured field (the default framebuffer, read in the
//     same task before it is presented), and full PNGs are saved at --shots frames, so two
//     arms can be compared for "the image is unchanged" field for field.
//   * the CPU fingerprint (_neil_last_fp) of every field is recorded too: two arms of one
//     guest must agree on it exactly (the room-determinism precondition).
//
// USAGE (dev server on a hermetic snapshot, probe lock held for rates):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_field_cost_probe.mjs --url http://localhost:19300 \
//        [--rom mariokart.z64] [--frames 2600] [--from 1900] [--query 'fblazy=0'] [--cpu 1] [--tag A] \
//        [--shots 1950,2200,2500] [--out /tmp/n64-fieldcost]
// Prints one JSON line; writes <out>/<tag>.json (+ PNGs).
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const ROM = flag('rom', 'mariokart.z64');
const BASE = flag('url', 'http://localhost:19300');
const OUT = flag('out', path.join(os.tmpdir(), 'n64-fieldcost'));
const TAG = flag('tag', 'run');
const FRAMES = +flag('frames', '2600');
const FROM = +flag('from', '1900');
const XQ = flag('query', '');
const CPU = +flag('cpu', '1');
const PLAN_NAME = flag('plan', 'mk64race');
const SHOTS = flag('shots', '').split(',').filter(Boolean).map(Number);
const UNPACED = argv.includes('--unpaced');
// --clock: the SHIPPED frame clock runs the guest (?workerrig=clock: commit yield, rAF/timer
// slots, the 1.000x governor, exactly what a player gets); the rig only installs the pad
// function and reads every field's cost back. Reports the achieved guest rate too.
const CLOCK = argv.includes('--clock');
// --nodbg (with --clock): no ?costdbg=1 — the SHIPPED worker, nothing wrapped. Each field's
// cost is then read from the core's own retro_run timer (_neil_frame_cost_ms, mymain.cpp
// timed_retro_run) by the pad function, which runs once before every field.
const NODBG = argv.includes('--nodbg');
// --attr (with --clock --nodbg): per field, where the time went — the core's RSP task timers
// (_neil_attr: 0 gfx task = glide's display list, 1 audio task = HLE alist, 2 other tasks) when the
// build exports them (a DIAGNOSTIC core only: the shipped core exports none of _neil_attr /
// _neil_idle / _neil_count, so on it --attr reports the WebGL time alone), and the time inside every WebGL call (the prototype wrapped, so the
// GL time is a part of the gfx time). Attribution only, never a rate (the wrappers cost time).
const ATTR = argv.includes('--attr');
const ATTR_NOGLT = argv.includes('--attr-nogl-timer');   // the core's timers only: WebGL calls not wrapped
// --profile: a CPU profile of the CORE WORKER over the measured window (attribution only —
// a profiled run is never a rate: CLAUDE.md #10)
const PROFILE = argv.includes('--profile');
const NOPIC = argv.includes('--nopic');       // no picture readback per field (a profile run)
// --rdhash N: every N measured fields, the WHOLE raw state (RDRAM included) is hashed — after
// glide's lazy framebuffer copies are all written (_neil_lfb_flush), when the core has them. Two
// arms then compare what RDRAM holds once every copy owed is made: a lazy arm against the
// eager one (?fblazy=0, or a core without the lazy copy).
const RDHASH = +flag('rdhash', '0');
const LOGRE = new RegExp(flag('logre', '\\[(gl|lfb|fb|jit|shader)\\]'));
const LOGMAX = +flag('logmax', '60');
const TRACEGL = flag('tracegl', '');
const GLCENSUS = argv.includes('--glcensus');
const FINISH = argv.includes('--finish');
// --evalend FILE: a worker-realm expression (the file's text) evaluated after the measured
// window; its JSON-able value lands in res.evalEnd (an inspection seam, e.g. JIT state)
const EVALEND = flag('evalend', '');
const EVALSTART = flag('evalstart', '');   // the same, evaluated once right after boot (clock mode)
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// --wcpu F: every DedicatedWorker thread of this browser (the core worker, the JIT's compile
// worker) is held to F of one core by a cgroup v1 cpu quota — the phone stand-in. A CDP CPU
// throttle does not reach workers ("only supported for pages"). Same method as
// n64_room_burst_probe.mjs. The GPU process (SwiftShader) is not throttled.
const WCPU = +flag('wcpu', '0');
const CG_ROOT = '/sys/fs/cgroup/cpu';
function descendantPids(root) {
  const out = []; let all = [];
  try { all = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch (e) { return out; }
  const ppid = {};
  for (const p of all) { try { ppid[p] = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]; } catch (e) {} }
  const want = new Set([String(root)]); let grew = true;
  while (grew) { grew = false; for (const p of all) if (!want.has(p) && want.has(ppid[p])) { want.add(p); grew = true; } }
  for (const p of want) out.push(+p);
  return out;
}
function throttleStart(browser, frac) {
  const dir = path.join(CG_ROOT, `n64fc-${process.pid}`);
  const cg = { dir, frac, tids: [] };
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'cpu.cfs_period_us'), '2000');
    fs.writeFileSync(path.join(dir, 'cpu.cfs_quota_us'), String(Math.max(1000, Math.round(2000 * frac))));
  } catch (e) { return { frac, err: String(e.message || e).slice(0, 120) }; }
  const bpid = browser.process() && browser.process().pid;
  const scan = () => {
    for (const pid of descendantPids(bpid)) {
      let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (e) { continue; }
      if (!cmd.includes('--type=renderer')) continue;
      let tids = []; try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
      for (const t of tids) {
        if (cg.tids.includes(+t)) continue;
        let comm = ''; try { comm = fs.readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').trim(); } catch (e) { continue; }
        if (!/^DedicatedWorker/.test(comm)) continue;
        try { fs.writeFileSync(path.join(dir, 'tasks'), String(t)); cg.tids.push(+t); } catch (e) {}
      }
    }
  };
  scan(); cg.timer = setInterval(scan, 500);
  return cg;
}
function throttleEnd(cg) {
  if (!cg || !cg.dir) return;
  clearInterval(cg.timer);
  try { const st = fs.readFileSync(path.join(cg.dir, 'cpu.stat'), 'utf8'); cg.stat = st.trim().split('\n').join(' '); } catch (e) {}
  try { for (const t of fs.readFileSync(path.join(cg.dir, 'tasks'), 'utf8').trim().split('\n').filter(Boolean)) fs.writeFileSync(path.join(CG_ROOT, 'tasks'), t); } catch (e) {}
  for (let i = 0; i < 20; i++) { try { fs.rmdirSync(cg.dir); return; } catch (e) {} }
}
fs.mkdirSync(OUT, { recursive: true });
const load1 = () => { try { return +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { return null; } };

// [f0, f1, ports, mask, ax, ay]: mask bits 0 up 1 down 2 left 3 right 4 A 5 B 6 Start 7 Z 8 L 9 R
function plan(name, frames) {
  const p = [];
  if (name === 'mk64race') {
    // title: Start; then one A every 45 fields picks every menu's default (1P, Mario GP,
    // 50cc, OK, Mario, OK, Mushroom Cup, OK) — the race then needs A HELD (accelerate).
    for (let f = 250; f < 700; f += 60) p.push([f, f + 4, [0], 1 << 6, 0, 0]);
    for (let f = 700; f < 1500; f += 45) p.push([f, f + 4, [0], 1 << 4, 0, 0]);
    for (let f = 1500; f < frames; f++) {
      const ph = Math.floor(f / 120) % 4;
      p.push([f, f + 1, [0], 1 << 4, ph === 1 ? 0.5 : ph === 3 ? -0.5 : 0, 0]);
    }
  } else if (name === 'mk642p') {
    // the same walk with TWO players: Right on the player-count screen, then A on both
    // ports (both pick a character) — a 2P Mario GP race, split screen
    for (let f = 250; f < 650; f += 60) p.push([f, f + 4, [0], 1 << 6, 0, 0]);
    p.push([680, 684, [0], 1 << 3, 0, 0]);
    for (let f = 700; f < 1500; f += 45) p.push([f, f + 4, [0, 1], 1 << 4, 0, 0]);
    for (let f = 1500; f < frames; f++) {
      const ph = Math.floor(f / 120) % 4;
      p.push([f, f + 1, [0, 1], 1 << 4, ph === 1 ? 0.5 : ph === 3 ? -0.5 : 0, 0]);
    }
  } else if (name === 'idle') {
    // nothing pressed: the attract loop
  }
  return p;
}
const PLAN = plan(PLAN_NAME, FRAMES);

// Runs in the worker realm. Steps frames [from, to), paced, one field per task.
const RUN = function (from, to, plan, measureFrom, shots, paced, nopic, rdhash, TRACEGL, GLCENSUS, finish) {
  const M = self.Module, D = self.DBG || null;
  const per = 1000 / ((self.CLK && self.CLK.viHz > 0) ? self.CLK.viHz : 60);
  const gl = M.ctx;
  const FB = self.__fbAsync;
  const out = { from, to, dt: [], gw: [], fp: [], pic: [], bk: [], shots: {}, per, rd: [] };
  // RDRAM itself (8 MiB at the JIT bridge's dramBase), so two core builds compare
  const rdHash = () => {
    const P = self.__n64CorePtrs;
    if (!P || !P.dramBase) return -1;
    if (M._neil_lfb_flush) M._neil_lfb_flush();
    const w = M.HEAP32, i0 = P.dramBase >> 2, i1 = i0 + (0x800000 >> 2);
    let h = 0x811c9dc5 | 0;
    for (let i = i0; i < i1; i++) h = Math.imul(h ^ w[i], 16777619);
    return h >>> 0;
  };
  let px = null;
  const picture = (full) => {
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    if (!px || px.length !== W * H * 4) px = new Uint8Array(W * H * 4);
    if (FB) FB.bypass = true;
    try {
      const rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pb = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb);
    } finally { if (FB) FB.bypass = false; }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < px.length; i += 4) { h = Math.imul(h ^ px[i], 16777619); h = Math.imul(h ^ px[i + 1], 16777619); h = Math.imul(h ^ px[i + 2], 16777619); }
    if (full) {
      let s = ''; const u = px; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return { h: h >>> 0, W, H, b64: btoa(s) };
    }
    return h >>> 0;
  };
  const pads = (f) => {
    const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const [f0, f1, ports, mask, ax, ay] of plan) if (f >= f0 && f < f1) for (const q of ports) { P[q][0] |= mask; if (ax) P[q][1] = ax; if (ay) P[q][2] = ay; }
    for (let q = 0; q < 4; q++) M._neil_ls_set_pad(q, P[q][0], Math.round(P[q][1] * 32000), Math.round(P[q][2] * 32000));
  };
  if (M._neil_fp_always) M._neil_fp_always(1);
  // a field that drew nothing leaves the drawing buffer to the compositor (it may be the
  // last committed picture or cleared): its picture is not the field's, so it is not hashed
  if (self.__traceGl === undefined) {
    // --tracegl NAME: log the wasm stack of the first calls to that WebGL entry point (debug)
    self.__traceGl = TRACEGL;
    if (TRACEGL) {
      const P = WebGL2RenderingContext.prototype, f = P[TRACEGL]; let n = 0;
      P[TRACEGL] = function () { if (self.__traceOn && n++ < 400) console.log('[tracegl] ' + TRACEGL + '(' + Array.from(arguments).join(',') + ') ' + new Error().stack.split('\n').slice(2, 9).map((x) => x.trim().replace(/^at /, '').split(' (')[0]).join(' < ')); return f.apply(this, arguments); };
    }
  }
  if (GLCENSUS && !self.__glc) {
    // --glcensus: every WebGL call made inside a measured field, by name
    self.__glc = { on: false, n: {} };
    const P = WebGL2RenderingContext.prototype;
    for (const nm of Object.getOwnPropertyNames(P)) {
      let d; try { d = Object.getOwnPropertyDescriptor(P, nm); } catch (e) { continue; }
      if (!d || typeof d.value !== 'function' || nm === 'constructor') continue;
      const f = d.value;
      P[nm] = function () { if (self.__glc.on) self.__glc.n[nm] = (self.__glc.n[nm] || 0) + 1; return f.apply(this, arguments); };
    }
  }
  if (!self.__drawN) {
    self.__drawN = { n: 0 };
    const P = WebGL2RenderingContext.prototype;
    for (const nm of ['drawArrays', 'drawElements', 'clear']) { const f = P[nm]; P[nm] = function () { self.__drawN.n++; return f.apply(this, arguments); }; }
  }
  // where the JIT's time goes: the synchronous module compile + instantiate vs the rest
  if (!self.__wmWrap) {
    const WM = WebAssembly.Module, WI = WebAssembly.Instance;
    const W = self.__wmWrap = { mods: 0, modMs: 0, modBytes: 0, inst: 0, instMs: 0, maxMod: 0 };
    WebAssembly.Module = function (b) { const t = performance.now(); try { return new WM(b); } finally { const d = performance.now() - t; W.mods++; W.modMs += d; W.modBytes += (b && b.byteLength) || 0; if (d > W.maxMod) W.maxMod = d; } };
    WebAssembly.Module.prototype = WM.prototype;
    WebAssembly.Instance = function (m, i) { const t = performance.now(); try { return new WI(m, i); } finally { W.inst++; W.instMs += performance.now() - t; } };
    WebAssembly.Instance.prototype = WI.prototype;
  }
  return new Promise((resolve) => {
    let f = from, due = performance.now();
    const step = () => {
      const meas = f >= measureFrom;
      self.__traceOn = !!TRACEGL && meas;
      pads(f);
      const b0 = D ? Object.assign({}, D.b) : null;
      const d0 = self.__drawN.n;
      if (self.__glc) self.__glc.on = meas;
      const t0 = performance.now();
      M._neil_ls_run_frame();
      const dt = performance.now() - t0;
      if (self.__glc) self.__glc.on = false;
      // --finish: the GPU's own time for this field — glFinish right after it, timed apart
      let gw = 0;
      if (finish) {
        // the GPU's lag: a fence after this field; how long until it reads signalled
        // (sync status only advances between tasks, so it is polled from later tasks)
        const fs = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
        const fe = { s: fs, t: performance.now(), meas };
        (self.__fences = self.__fences || []).push(fe);
      }
      if (self.__fences) {
        const now2 = performance.now();
        self.__fences = self.__fences.filter((fe) => {
          if (gl.getSyncParameter(fe.s, gl.SYNC_STATUS) === gl.SIGNALED) { if (fe.meas) out.gw.push(+(now2 - fe.t).toFixed(1)); gl.deleteSync(fe.s); return false; }
          return true;
        });
      }
      if (meas) {
        out.dt.push(+dt.toFixed(2));

        out.fp.push(M._neil_last_fp() >>> 0);
        if (rdhash && ((f + 1) % rdhash) === 0) out.rd.push([f + 1, rdHash()]);
        if (D) { const r = {}; for (const k in D.b) { const d = D.b[k] - b0[k]; if (d >= 0.05) r[k] = +d.toFixed(2); } out.bk.push(r); }
        const sh = shots.indexOf(f + 1) >= 0;
        if ((nopic || self.__drawN.n === d0) && !sh) out.pic.push(null);
        else {
          const p = picture(sh);
          if (sh) { out.shots[f + 1] = p; out.pic.push(p.h); } else out.pic.push(p);
        }
      }
      f++;
      if (f >= to) { resolve(out); return; }
      due += per;
      const now = performance.now();
      if (now - due > 2 * per) due = now - 2 * per;          // the governor drops old debt
      setTimeout(step, paced ? Math.max(0, due - now) : 0);
    };
    step();
  });
};

function q(arr, p) { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

// PNG writer (RGBA, flipped: GL rows are bottom-up)
function png(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, (H - 1 - y) * W * 4, (H - y) * W * 4); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6; ih[10] = 0; ih[11] = 0; ih[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const browser = await puppeteer.launch({
  headless: 'new', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 1800000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,900']
         // --jsflags F: V8 flags for a DIAGNOSTIC arm only (a web page cannot set them: CLAUDE.md #11)
         .concat(flag('jsflags', '') ? ['--js-flags=' + flag('jsflags', '')] : []),
});
try { require(path.join(path.dirname(__filename), '../../tools/browser_leak_guard.js')).guard(browser, __filename); } catch (_e) {}
let CG = null;
if (WCPU > 0) CG = throttleStart(browser, WCPU);
const res = { tag: TAG, rom: ROM, url: BASE, query: XQ, frames: FRAMES, from: FROM, cpu: CPU, plan: PLAN_NAME, paced: !UNPACED, load: [load1()], errs: [], logs: [] };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => res.errs.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') res.errs.push('console: ' + t.slice(0, 200)); else if (LOGRE.test(t) && res.logs.length < LOGMAX) res.logs.push(t.slice(0, 240)); });
  let coreWorker = null;
  page.on('workercreated', (w) => { if (/core_worker/.test(w.url())) coreWorker = w; });
  if (CPU > 1) {
    page.on('workercreated', async (w) => { try { await w.client.send('Emulation.setCPUThrottlingRate', { rate: CPU }); res.throttled = (res.throttled || 0) + 1; } catch (e) { res.throttleErr = String(e.message || e).slice(0, 120); } });
  }
  const qs = 'worker=1&workerrig=' + (CLOCK ? 'clock' : '1') + (CLOCK && NODBG ? '' : '&costdbg=1') + (XQ ? '&' + XQ : '');
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart&${qs}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const s = window.__n64Worker && window.__n64Worker.state(); return s && (s.booted || s.fatal); }, { timeout: 240000 });
  const st = await page.evaluate(() => window.__n64Worker.state());
  if (st.fatal) throw new Error('worker fatal: ' + st.fatal);
  await page.waitForFunction(() => window.__n64Worker.state().stat, { timeout: 60000 });
  if (CLOCK) {
    const PLANJ = JSON.stringify(PLAN);
    await page.evaluate((src) => window.__n64Worker.eval(src), `(() => {
      const plan = ${PLANJ};
      self.__rigFields = [];
      if (${NODBG}) {
        // the core's own per-retro_run timer: its delta, read before field f, is field f-1's cost
        let lastMs = null, lastN = null, lastA = null;
        const M = self.Module;
        const ATTR = ${ATTR};
        if (ATTR && ${ATTR_NOGLT}) self.__glT = { ms: 0, n: 0 };
        if (ATTR && !self.__glT) {
          self.__glT = { ms: 0, n: 0 };
          const P = WebGL2RenderingContext.prototype;
          for (const nm of Object.getOwnPropertyNames(P)) {
            let d; try { d = Object.getOwnPropertyDescriptor(P, nm); } catch (e) { continue; }
            if (!d || typeof d.value !== 'function' || nm === 'constructor') continue;
            const fn = d.value;
            P[nm] = function () { const t = performance.now(); try { return fn.apply(this, arguments); } finally { self.__glT.ms += performance.now() - t; self.__glT.n++; } };
          }
        }
        const attrNow = () => ATTR ? [M._neil_attr ? M._neil_attr(0) : 0, M._neil_attr ? M._neil_attr(1) : 0, M._neil_attr ? M._neil_attr(2) : 0, self.__glT.ms, self.__glT.n, M._neil_count ? M._neil_count() : 0, M._neil_idle ? M._neil_idle() : 0, M._neil_attr ? M._neil_attr(4) : 0, M._neil_attr ? M._neil_attr(5) : 0, M._neil_attr ? M._neil_attr(6) : 0].concat(M._neil_attr ? [3,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21].map((k) => M._neil_attr(k)) : []).concat(self.bementalMips && self.bementalMips.async ? [self.bementalMips.async.installed, self.bementalMips.async.pending.size, self.bementalMips.async.ready.length] : []) : null;
        self.__rigAttr = [];
        self.__rigCost = function (f) {
          const ms = M._neil_frame_cost_ms(), n = M._neil_frame_cost_n() >>> 0, a = attrNow();
          if (lastN !== null && n === lastN + 1) {
            self.__rigFields.push(f - 1, ms - lastMs);
            if (a) { const d = a.map((x, i) => x - lastA[i]); if (d[5] < 0) d[5] += 4294967296; if (a.length > 27) { d[27] = a[27]; d[28] = a[28]; } self.__rigAttr.push(d); }
          }
          lastMs = ms; lastN = n; lastA = a;
        };
      }
      self.__n64PadOverride = function (f, q) {
        if (q === 0 && self.__rigCost) self.__rigCost(f);
        let m = 0, ax = 0, ay = 0;
        for (const [f0, f1, ports, mask, x, y] of plan) if (f >= f0 && f < f1 && ports.indexOf(q) >= 0) { m |= mask; if (x) ax = x; if (y) ay = y; }
        return [m, Math.round(ax * 32000), Math.round(ay * 32000)];
      };
      return CLK.frame; })()`);
    if (EVALSTART) res.evalStart = await page.evaluate((src) => window.__n64Worker.eval(src), fs.readFileSync(EVALSTART, 'utf8'));
    const tMark = {};
    let profOnC = false;
    for (;;) {
      const st = await page.evaluate(() => window.__n64Worker.eval('({ f: CLK.frame, t: performance.now() })'));
      if (!tMark.from && st.f >= FROM) tMark.from = st;
      if (PROFILE && !profOnC && st.f >= FROM && coreWorker) {
        await coreWorker.client.send('Profiler.enable');
        await coreWorker.client.send('Profiler.setSamplingInterval', { interval: 500 });
        await coreWorker.client.send('Profiler.start');
        profOnC = true;
      }
      if (st.f >= FRAMES) { tMark.to = st; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (profOnC) {
      const { profile } = await coreWorker.client.send('Profiler.stop');
      fs.writeFileSync(path.join(OUT, `${TAG}.cpuprofile`), JSON.stringify(profile));
      const self = new Map(), byId = new Map();
      for (const n of profile.nodes) byId.set(n.id, n);
      const dts = profile.timeDeltas, smp = profile.samples;
      for (let i = 0; i < smp.length; i++) {
        const n = byId.get(smp[i]); const cf = n.callFrame;
        const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop().split('?')[0];
        self.set(k, (self.get(k) || 0) + (dts[i] || 0));
      }
      const idle = self.get('(idle) ') || 0;
      const tot = [...self.values()].reduce((a, b) => a + b, 0) - idle;
      res.profileBusyMs = Math.round(tot / 1000);
      res.profileTop = [...self.entries()].filter(([k]) => k !== '(idle) ').sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, v]) => [k, +(100 * v / tot).toFixed(2)]);
    }
    const o = await page.evaluate(() => window.__n64Worker.eval(`(() => { const a = self.__rigFields; self.__n64PadOverride = null; return { a: Array.from(a), at: self.__rigAttr || [], per: 1000 / CLK.viHz, lost: CLK.lostMs, reanchors: CLK.reanchors, presents: CLK.presents }; })()`));
    const dt = [], at = [];
    for (let i = 0; i < o.a.length; i += 2) if (o.a[i] >= FROM && o.a[i] < FRAMES) { dt.push(+o.a[i + 1].toFixed(2)); if (o.at.length) at.push(o.at[i >> 1]); }
    if (at.length) {
      // mean ms per field of each part, over all fields and over the heaviest tenth
      const parts = (rows, ds) => { const s = [0, 0, 0, 0, 0, 0]; rows.forEach((r, k) => { s[0] += ds[k]; for (let j = 0; j < 5; j++) s[j + 1] += r[j]; });
        const n = rows.length || 1; return { total: +(s[0] / n).toFixed(2), gfx: +(s[1] / n).toFixed(2), audio: +(s[2] / n).toFixed(2), otherTask: +(s[3] / n).toFixed(2), gl: +(s[4] / n).toFixed(2), glCalls: Math.round(s[5] / n), cpuEtc: +((s[0] - s[1] - s[2] - s[3]) / n).toFixed(2) }; };
      const idx = dt.map((x, i) => i).sort((a, b) => dt[b] - dt[a]);
      const top = idx.slice(0, Math.max(1, Math.floor(dt.length / 10)));
      res.attr = { all: parts(at, dt), heavy10: parts(top.map((i) => at[i]), top.map((i) => dt[i])) };
      res.attrRows = at.map((r, i) => [dt[i]].concat(r.map((x) => +x.toFixed(2))));
    }
    res.per = o.per;
    const sum = dt.reduce((a, b) => a + b, 0);
    res.fields = dt.length;
    res.ms = { mean: +(sum / dt.length).toFixed(2), p50: q(dt, 0.5), p90: q(dt, 0.9), p99: q(dt, 0.99), max: Math.max(...dt),
               overPeriod: dt.filter((x) => x > o.per).length, over14: dt.filter((x) => x > 14).length, over2P: dt.filter((x) => x > 2 * o.per).length };
    res.rate = +(((tMark.to.f - tMark.from.f) / ((tMark.to.t - tMark.from.t) / 1000)) * o.per / 1000).toFixed(4);
    res.clockLostMs = o.lost; res.reanchors = o.reanchors;
    res.stats = await page.evaluate(() => window.__n64Worker.eval(`(() => {
      const M = self.Module, o = {};
      try { if (M._neil_lfb_stats) { const p = M._malloc(32); M._neil_lfb_stats(p); o.lfb = Array.from(M.HEAPU32.subarray(p >> 2, (p >> 2) + 8)); M._free(p); } } catch (e) {}
      if (self.DBG) { o.dbg = self.DBG.report(); o.dbg.dist = self.DBG.dist(4096); }
      if (self.bementalMips && self.bementalMips.async) { const A = self.bementalMips.async; o.jitAsync = { on: A.on, offered: A.offered, installed: A.installed, stale: A.stale, failed: A.failed, pending: A.pending ? A.pending.size : undefined, ready: A.ready ? A.ready.length : undefined, modules: A.modules }; }
      const F = self.__fbAsync; if (F) o.fb = { on: F.on, calls: F.calls, async: F.async, sync: F.sync, blocked: F.blocked, prefetchBlocked: F.prefetchBlocked };
      if (typeof GQ !== 'undefined') o.gq = { on: GQ.on, max: GQ.max, held: GQ.held, heldMs: Math.round(GQ.heldMs), forced: GQ.forced, out: GQ.fences.length };
      return o; })()`));
    if (EVALEND) { try { res.evalEnd = await page.evaluate((src) => window.__n64Worker.eval(src), fs.readFileSync(EVALEND, 'utf8')); } catch (e) { res.evalEndErr = String(e.message || e).slice(0, 300); } }
    const ib = res.stats.dbg && res.stats.dbg.inOver;
    res.bucketsInOver = ib; res.worst = res.stats.dbg && res.stats.dbg.max;
    res.load.push(load1());
    throw { clockDone: true };
  }
  const all = { dt: [], gw: [], fp: [], pic: [], bk: [], rd: [] };
  const CH = 100;
  const t0 = Date.now();
  let profOn = false;
  for (let f = 0; f < FRAMES; f += CH) {
    const to = Math.min(FRAMES, f + CH);
    if (PROFILE && !profOn && f >= FROM && coreWorker) {
      await coreWorker.client.send('Profiler.enable');
      await coreWorker.client.send('Profiler.setSamplingInterval', { interval: 500 });
      await coreWorker.client.send('Profiler.start');
      profOn = true;
    }
    const src = `(${RUN.toString()})(${f}, ${to}, ${JSON.stringify(PLAN)}, ${FROM}, ${JSON.stringify(SHOTS)}, ${!UNPACED}, ${NOPIC}, ${RDHASH}, ${JSON.stringify(TRACEGL)}, ${GLCENSUS}, ${FINISH})`;
    const o = await page.evaluate((s) => window.__n64Worker.eval(s), src);
    res.per = o.per;
    all.dt.push(...o.dt); all.gw.push(...o.gw); all.rd.push(...o.rd); all.fp.push(...o.fp); all.pic.push(...o.pic); all.bk.push(...o.bk);
    for (const k in o.shots) {
      const s = o.shots[k];
      fs.writeFileSync(path.join(OUT, `${TAG}-f${k}.png`), png(s.W, s.H, Buffer.from(s.b64, 'base64')));
    }
  }
  res.wallS = (Date.now() - t0) / 1000;
  if (profOn) {
    const { profile } = await coreWorker.client.send('Profiler.stop');
    fs.writeFileSync(path.join(OUT, `${TAG}.cpuprofile`), JSON.stringify(profile));
    const self = new Map(), byId = new Map();
    for (const n of profile.nodes) byId.set(n.id, n);
    const dt = profile.timeDeltas, smp = profile.samples;
    for (let i = 0; i < smp.length; i++) {
      const n = byId.get(smp[i]); const cf = n.callFrame;
      const u = (cf.url || '').split('/').pop().split('?')[0];
      const k = (cf.functionName || '(anon)') + ' ' + u;
      self.set(k, (self.get(k) || 0) + (dt[i] || 0));
    }
    const tot = [...self.values()].reduce((a, b) => a + b, 0);
    res.profileTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => [k, +(100 * v / tot).toFixed(2)]);
  }
  const dt = all.dt, per = res.per;
  const sum = dt.reduce((s, x) => s + x, 0);
  res.fields = dt.length;
  res.ms = { mean: +(sum / dt.length).toFixed(2), p50: q(dt, 0.5), p90: q(dt, 0.9), p99: q(dt, 0.99), max: Math.max(...dt),
             overPeriod: dt.filter((x) => x > per).length, over14: dt.filter((x) => x > 14).length, over2P: dt.filter((x) => x > 2 * per).length };
  if (all.gw.length) { const g = all.gw, gs = g.reduce((a, b) => a + b, 0); res.gpuWait = { mean: +(gs / g.length).toFixed(2), p50: q(g, 0.5), p99: q(g, 0.99), max: Math.max(...g) }; }
  const bt = {}; for (const r of all.bk) for (const k in r) bt[k] = (bt[k] || 0) + r[k];
  res.bucketsPerField = {}; for (const k in bt) res.bucketsPerField[k] = +(bt[k] / dt.length).toFixed(3);
  res.bucketsPerField.core = +(res.ms.mean - Object.values(bt).reduce((s, x) => s + x, 0) / dt.length).toFixed(3);
  const worst = dt.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).slice(0, 10);
  res.worst = worst.map(([x, i]) => Object.assign({ f: FROM + i, ms: x }, all.bk[i]));
  res.fp = all.fp; res.pic = all.pic; res.rd = all.rd;
  res.stats = await page.evaluate(() => window.__n64Worker.eval(`(() => {
    const M = self.Module, o = {};
    try { if (M._neil_lfb_stats) { const p = M._malloc(32); M._neil_lfb_stats(p); o.lfb = Array.from(M.HEAPU32.subarray(p >> 2, (p >> 2) + 8)); M._free(p); } } catch (e) { o.lfbErr = String(e); }
    try { if (M._neil_shader_stats) { const p = M._malloc(16); M._neil_shader_stats(p); o.shader = Array.from(M.HEAP32.subarray(p >> 2, (p >> 2) + 4)); M._free(p); } } catch (e) {}
    try { if (M._neil_shader_dump) { const n = M._neil_shader_dump(0, 0); const p = M._malloc(n); M._neil_shader_dump(p, n); let s = ''; const u = M.HEAPU8.subarray(p, p + n); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); o.shaderDump = btoa(s); M._free(p); } } catch (e) {}
    try { if (M._neil_gl_shadow_sent) o.glShadow = [M._neil_gl_shadow_sent() >>> 0, M._neil_gl_shadow_dropped() >>> 0]; } catch (e) {}
    const F = self.__fbAsync; if (F) o.fb = { on: F.on, calls: F.calls, async: F.async, sync: F.sync, blocked: F.blocked, prefetched: F.prefetched, prefetchBlocked: F.prefetchBlocked, early: F.early };
    if (self.bementalMips) { const s = self.bementalMips.stats; o.jit = {}; for (const k in s) if (typeof s[k] === 'number') o.jit[k] = s[k]; }
    if (self.DBG) o.dbg = self.DBG.report();
    if (self.__wmWrap) o.wasm = self.__wmWrap;
    if (self.__glc) o.glCensus = self.__glc.n;
    if (self.bementalMips && self.bementalMips.async) { const A = self.bementalMips.async; o.jitAsync = { on: A.on, offered: A.offered, installed: A.installed, stale: A.stale, staleWhy: A.staleWhy, reoffered: A.reoffered, failed: A.failed, pending: A.pending.size, maxInstallMs: +A.maxInstallMs.toFixed(2) }; }
    o.md5hint = (self.Module && self.Module.__wasmV) || null;
    return o; })()`));
  if (res.stats && res.stats.shaderDump) { fs.writeFileSync(path.join(OUT, `${TAG}.glsl`), Buffer.from(res.stats.shaderDump, 'base64')); delete res.stats.shaderDump; }
  res.load.push(load1());
} catch (e) { if (!(e && e.clockDone)) res.fault = String(e && e.stack || e).slice(0, 600); }
finally { if (CG) { throttleEnd(CG); res.wcpu = { frac: CG.frac, tids: CG.tids && CG.tids.length, err: CG.err, stat: CG.stat }; } await browser.close(); }
fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(res));
const brief = Object.assign({}, res); delete brief.fp; delete brief.pic;
console.log(JSON.stringify(brief));
