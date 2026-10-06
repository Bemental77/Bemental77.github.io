#!/usr/bin/env node
// n64_wall_account.mjs — WHERE DOES THE N64 WORKER'S WALL TIME GO, SECOND BY SECOND?
//
// Drives the page's own benchmark (?bench=1, lib/bench.js) headless — SwiftShader, a fresh
// profile per run — and, beside it, reads the core worker every second:
//   * the GUEST FIELD CLOCK (the worker's viTotal: VI fields the guest lived through) and an
//     INDEPENDENT guest clock: a counter the GAME itself increments in RDRAM once per game frame
//     (--witness, default Super Mario 64 US gGlobalTimer 0x8032D5D4; read through the worker's
//     ?workerrig=clock eval seam, which changes nothing else). Two clocks that agree make the
//     reading a property of the guest, not of the meter.
//   * the worker's wall time: inside fields (busyMs), what the 1.000x governor wrote off
//     (lostMs / reanchors: time a field was owed and none ran, beyond the repayment cap), what it
//     repaid (repaidMs: owed fields run back on schedule, never ahead of it), the GPU guard (GQ held ms),
//     the commit yield (CB holds / forced), frame-skip re-runs (FSK.redoMs), and the remainder
//     — the pace wait (no field owed).
// solo: the bench's solo window. room: the bench's loopback room (both consoles on this box),
// read from the host page's __n64Net() (engine frames, lost/stalls) — the room's core is stepped
// by the room driver, not the field clock.
//
// USAGE (probe lock held, hermetic snapshot served on a free port; or prod):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_wall_account.mjs --url http://localhost:18900 [--mode solo|room] [--sec 20]
//   node n64/tools/n64_wall_account.mjs --url https://caseybement.com --prod      (session proxy, cert check off)
// Emits per-second rows and a JSON summary (--json PATH).
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const MODE = flag('mode', 'solo');
const SEC = +flag('sec', '20');
const EXTRA = flag('q', '');
const WIT = flag('witness', '0x8032D5D4');        // a u32 the game increments per game frame
const WITHZ = +flag('witnesshz', '30');           // SM64 runs its game loop at 30 Hz (2 fields per frame)
const PROD = has('prod') || BASE.startsWith('https');
// --stall MS:EVERY (a measurement arm): the worker is blocked MS ms every EVERY ms (a busy-wait in a
//   timer task — what a preemption, a GC or a compile does to it), installed through the eval seam
const STALL = flag('stall', '').split(':').map(Number);
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --angle default: Chrome's own ANGLE backend (headless: Vulkan on SwiftShader) instead of --use-angle=swiftshader — the
//   bench's second renderer arm, whose room read 0.988-0.998x where SwiftShader-GL read 1.000x
const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--window-size=1280,900'];
if (flag('angle', 'swiftshader') !== 'default') args.push('--use-angle=swiftshader');
if (PROD) { args.push('--ignore-certificate-errors'); if (process.env.HTTPS_PROXY) args.push('--proxy-server=' + process.env.HTTPS_PROXY); }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args, protocolTimeout: 600000 });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, 'n64_wall_account'); } catch (_e) {}

const out = { base: BASE, mode: MODE, sec: SEC, rows: [], result: null };
try {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/\[bench\] (solo|room)|RESULT|⚠/.test(t)) console.log('  > ' + t.slice(0, 200)); });
  // room: straight into the bench's room phase (what its own reload after the solo window opens), with
  // the eval seam on the host, so the host's worker can be read; the bench admits its loopback joiner
  const CC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (let i = 0; i < 5; i++) code += CC[Math.floor(Math.random() * CC.length)];
  const q = MODE === 'solo'
    ? `?bench=1&benchauto=1&benchsec=${SEC}&benchroom=0&workerrig=clock${EXTRA ? '&' + EXTRA : ''}`
    : `?bench=1&benchauto=1&benchsec=${SEC}&benchphase=room&np=${code}&host=1&net=local&game=${encodeURIComponent(flag('game', 'Super Mario 64'))}&workerrig=clock${EXTRA ? '&' + EXTRA : ''}`;
  await page.goto(BASE + '/n64/index.html' + q, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let prev = null;
  // the worker-side reads (eval seam): witness counter, GPU guard, commit yield, frame-skip re-runs
  const EV = `JSON.stringify((function () {
    // RDRAM inside the worker's heap: the JIT's parameter block (self.__n64CorePtrs.dramBase, recomp.c jit_params[24])
    var w = null; try { var a = (${WIT} & 0x7FFFFF) >>> 0, P = self.__n64CorePtrs, base = P && P.dramBase;
      if (base) w = M.HEAPU32[(base + a) >>> 2] >>> 0; } catch (e) { w = null; }
    // the guest CPU's own cycle counter, CP0 Count (recomp.c jit_params[14], caught from the JIT's
    // next compile): mupen schedules a VI field every (V_SYNC+1) x 1500 Count units — 789000 on an
    // NTSC 525-line mode — so Count/s / (789000 x hz) is the guest's clock read off its CPU, a different
    // path from viTotal (and a re-run, which rewinds Count, cannot inflate it)
    if (!self.__cntPtr && self.myApp && self.myApp.jitCompile && !self.myApp.__cntWrapped) {
      var jc = self.myApp.jitCompile; self.myApp.__cntWrapped = true;
      self.myApp.jitCompile = function (pp) { if (!self.__cntPtr) { try { self.__cntPtr = self.__n64JitParams(M, pp).count; } catch (e) {} } return jc.apply(this, arguments); };
    }
    var cnt = self.__cntPtr ? M.HEAPU32[self.__cntPtr >>> 2] >>> 0 : null;
    return { t: performance.timeOrigin + performance.now(), vi: viTotal(), w: w, cnt: cnt, gq: typeof GQ !== 'undefined' ? GQ.heldMs || 0 : null,
             cbH: CB.holds, cbF: CB.forced, redoMs: FSK.redoMs || 0, redo: FSK.redo, lost: CLK.lostMs, rean: CLK.reanchors, busy: CLK.busyMs,
             repaid: typeof REPAY !== 'undefined' ? REPAY.repaidMs : null, lsRepaid: RM && RM.R ? (RM.R.LS.repaidMs || 0) : null,
             ticks: CLK.ticks, notOwed: SCHED.notOwed, raf: SCHED.rafTicks, imm: SCHED.immTicks, tmr: SCHED.tmrTicks, frame: CLK.frame,
             room: !!(RM && RM.R), lsFrame: RM && RM.R ? RM.R.LS.frame : null, lsLost: RM && RM.R ? (RM.R.LS.lostMs || 0) : null,
             lsStallMs: RM && RM.R ? (RM.R.LS.stallMs || 0) : null, lsRean: RM && RM.R ? (RM.R.LS.reanchors | 0) : null,
             lsAdv: RM && RM.R ? (RM.R.LS.advWaits | 0) : null, hz: CLK.viHz || (RM && RM.R ? RM.R.LS.viHz : 0),
             mode: RM && RM.eng ? (RM.eng.rollback ? 'rollback' : 'delay') : null,
             rbk: RM && RM.R && RM.R.RB ? RM.R.RB.rollbacks : null, resim: RM && RM.R && RM.R.RB ? RM.R.RB.resimFrames : null,
             rbSaveMs: RM && RM.R && RM.R.RB ? RM.R.RB.saveMs : null, rbN: RM && RM.R && RM.R.RB ? RM.R.RB.n : null,
             costOver: RM && RM.R ? (RM.R.LS.costOver | 0) : null, costMax: RM && RM.R ? (RM.R.LS.costMax || 0) : null };
  })())`;
  while (Date.now() - t0 < (SEC + (MODE === 'room' ? 240 : 90)) * 1000) {
    await sleep(1000);
    const s = await page.evaluate(async (src) => {
      const W = window.__n64Worker; if (!W || !W.state().booted) return null;
      let v = null;
      try { v = JSON.parse(await W.eval(src)); }
      catch (e) {
        // the bench's room phase reloads the page without the eval seam: the worker's stat stream
        // and the room report (__n64Net) carry what is needed there
        const st = W.state().stat; let n = null; try { n = window.__n64Net && window.__n64Net(); } catch (e2) { n = null; }
        if (!st) return { err: String(e && e.message || e) };
        v = { t: st.at, vi: st.vi, w: null, gq: null, cbH: st.cb ? st.cb.yields : null, cbF: st.cb ? st.cb.forced : null, redoMs: null,
              lost: st.lostMs, rean: st.reanchors, busy: st.busyMs, ticks: st.ticks, notOwed: st.notOwed, raf: st.rafTicks, imm: st.immTicks, tmr: st.tmrTicks,
              room: !!(n && n.frame != null), lsFrame: n ? n.frame : null, lsLost: n ? n.lostMs : null, lsStallMs: n ? n.stallMs : null,
              lsRean: n ? n.reanchors : null, lsAdv: n ? n.advWaits : null, hz: 60, mode: n ? n.mode : null,
              rbk: n && n.rollback && n.rollback.page ? n.rollback.page.rollbacks : null, resim: n && n.rollback && n.rollback.page ? n.rollback.page.resimFrames : null };
        v.t = performance.timeOrigin + performance.now();
      }
      return { v, res: window.__benchResult || null };
    }, EV).catch((e) => ({ err: String(e) }));
    if (!s || s.err || !s.v) { if (s && s.err && !/not available/.test(s.err)) console.log('  ! ' + s.err.slice(0, 160)); continue; }
    if (STALL.length === 2 && STALL[0] > 0 && !out.stallOn) {
      out.stallOn = await page.evaluate((a, b) => window.__n64Worker.eval('(function () { if (self.__stallT) return "already"; self.__stalls = 0; self.__stallT = setInterval(function () { var e = performance.now() + ' + a + '; while (performance.now() < e) {} self.__stalls++; }, ' + b + '); return "on"; })()'), STALL[0], STALL[1]).catch((e) => 'no: ' + e);
      console.log('  stall arm: ' + out.stallOn + ' (' + STALL[0] + ' ms every ' + STALL[1] + ' ms)');
    }
    const v = s.v;
    if (prev && v.t > prev.t) {
      const dt = (v.t - prev.t) / 1000, d = (k) => (v[k] != null && prev[k] != null) ? v[k] - prev[k] : null;
      const hz = v.hz || 60;
      const row = { t: Math.round((Date.now() - t0) / 1000), dt: +dt.toFixed(3), field: +(d('vi') / dt / hz).toFixed(4),
        witness: (v.w != null && prev.w != null) ? +(((v.w - prev.w) >>> 0) / dt / WITHZ).toFixed(4) : null,
        count: (v.cnt != null && prev.cnt != null) ? +(((v.cnt - prev.cnt) >>> 0) / dt / (789000 * hz)).toFixed(4) : null,
        cntPerField: (v.cnt != null && prev.cnt != null && d('vi') > 0) ? Math.round(((v.cnt - prev.cnt) >>> 0) / d('vi')) : null,
        busyMs: +(d('busy') || 0).toFixed(1), lostMs: +(d('lost') || 0).toFixed(1), repaidMs: +(d('repaid') || 0).toFixed(1), rean: d('rean'), gqMs: d('gq') == null ? null : +d('gq').toFixed(1),
        cbHolds: d('cbH'), cbForced: d('cbF'), redoMs: +(d('redoMs') || 0).toFixed(1), ticks: d('ticks'), notOwed: d('notOwed'),
        raf: d('raf'), imm: d('imm'), tmr: d('tmr') };
      if (v.room) Object.assign(row, { room: +(d('lsFrame') / dt / hz).toFixed(4), lsLostMs: +(d('lsLost') || 0).toFixed(1), lsRean: d('lsRean'),
        lsStallMs: +(d('lsStallMs') || 0).toFixed(1), lsRepaidMs: +(d('lsRepaid') || 0).toFixed(1), lsAdv: d('lsAdv'), mode: v.mode, rbk: d('rbk'), resim: d('resim'),
        saveMs: v.rbSaveMs != null ? +(d('rbSaveMs')).toFixed(1) : null, ring: v.rbN, costOver: d('costOver'), costMax: v.costMax != null ? +v.costMax.toFixed(1) : null });
      row.paceWaitMs = +((dt * 1000) - row.busyMs - (row.gqMs || 0) - row.redoMs).toFixed(1);
      out.rows.push(row); console.log(JSON.stringify(row));
    }
    prev = v;
    if (s.res) { out.result = s.res; break; }
  }
  if (!out.result) out.result = await page.evaluate(() => window.__benchResult || null).catch(() => null);
} catch (e) { out.error = String(e && e.message || e); }
finally { await browser.close().catch(() => {}); }

// the measured window: the rows after the warm-up, in the bench's own phase
let R = out.rows.filter((r) => r.t > 4 && r.room == null);
if (MODE === 'room') { const rr = out.rows.filter((r) => r.room != null); R = rr.slice(Math.min(4, rr.length)); }
const sum = (k) => R.reduce((a, r) => a + (r[k] || 0), 0);
const secs = R.reduce((a, r) => a + r.dt, 0);
out.summary = {
  secs: +secs.toFixed(1),
  field: secs ? +(R.reduce((a, r) => a + r.field * r.dt, 0) / secs).toFixed(4) : null,
  witness: R.every((r) => r.witness != null) && secs ? +(R.reduce((a, r) => a + r.witness * r.dt, 0) / secs).toFixed(4) : null,
  count: R.every((r) => r.count != null) && secs ? +(R.reduce((a, r) => a + r.count * r.dt, 0) / secs).toFixed(4) : null,
  room: R.length && R[0].room != null ? +(R.reduce((a, r) => a + (r.room || 0) * r.dt, 0) / secs).toFixed(4) : null,
  perSecondMs: secs ? { busy: +(sum('busyMs') / secs).toFixed(1), lost: +(sum('lostMs') / secs).toFixed(1), gq: +(sum('gqMs') / secs).toFixed(1),
                        redo: +(sum('redoMs') / secs).toFixed(1), paceWait: +(sum('paceWaitMs') / secs).toFixed(1),
                        lsLost: +(sum('lsLostMs') / secs).toFixed(1), lsStall: +(sum('lsStallMs') / secs).toFixed(1),
                        repaid: +(sum('repaidMs') / secs).toFixed(1), lsRepaid: +(sum('lsRepaidMs') / secs).toFixed(1) } : null,
  reanchors: sum('rean'), cbForced: sum('cbForced'),
  bench: out.result ? { solo: out.result.solo && { speed: out.result.solo.speed, ms: out.result.solo.ms, over: out.result.solo.over },
                        room: out.result.room && { speed: out.result.room.speed, mode: out.result.room.mode, ms: out.result.room.ms } } : null,
};
console.log('SUMMARY ' + JSON.stringify(out.summary));
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out));
