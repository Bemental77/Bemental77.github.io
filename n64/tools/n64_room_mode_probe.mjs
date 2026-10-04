#!/usr/bin/env node
// n64_room_mode_probe.mjs — DOES THE BENCH'S LOOPBACK ROOM STAY IN ROLLBACK, AND WHAT DOES THE
// CAPACITY GATE SEE WHILE IT DOES?
//
// Drives the page's own benchmark room (?bench=1&benchphase=room: a host page plus a JOINER iframe
// of the same page, both consoles on this box — lib/bench.js) and reads, every second, from BOTH
// consoles' window.__n64Net(): the mode, the engine's capacity need (modeReport().need), the
// published step (selfStepMs) and its parts (run / save / load EMAs, snapshot interval K, window),
// rollbacks and re-simulated frames, the room's frame rate and the governor's written-off time.
// Every mode switch the room makes is printed with the engine's own reason.
//
// USAGE (probe lock held, hermetic snapshot served on a free port):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_room_mode_probe.mjs --url http://localhost:18920 [--sec 40] [--runs 3] [--q extra=1] [--json PATH]
// Per run: seconds in rollback / delay (host's engine mode), mean room speed (engine frames /
// (wall x 60)) over the measured window, governor lost ms, the need's max, and the switches.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const SEC = +flag('sec', '40');
const RUNS = +flag('runs', '1');
const EXTRA = flag('q', '');
const GAME = flag('game', 'Super Mario 64');
// --wslow R:FROM:UNTIL (a measurement arm): from FROM s to UNTIL s of the room (rows' t), the HOST's
//   worker core takes R x its own wall time in _neil_ls_run_frame / the raw save / the raw load
//   (busy-wait, as n64_rollback_probe --wslow) — a device that cannot afford rollback for a while.
//   Installs the page's ?workerrig=clock eval seam (the frame clock runs as shipped).
const WSLOW = flag('wslow', '').split(':').map(Number);
const WSLOW_ON = WSLOW.length === 3 && WSLOW[0] > 1;
// --force-switch DOWN:UP[:DOWN2:UP2...] (TEST SEAM, never a product path): at each DOWN s the HOST
//   engine's _capNeedOf answers 2 until the room is in delay; at each UP s it answers 0.1 (calm 1 s)
//   until the room is back in rollback; then the real judgement is restored. The switch itself —
//   the page's and the engine's halves — is what runs; the rows show what it cost (lostMs, stallMs).
const FSW = flag('force-switch', '').split(':').filter((x) => x !== '').map(Number);
const SEAM = WSLOW_ON || FSW.length > 0;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,900'];

const SAMPLE = () => {
  let n = null; try { n = window.__n64Net && window.__n64Net(); } catch (e) { return { err: String(e) }; }
  if (!n) return null;
  const e = n.engine || {}, m = e.mode || {}, pg = (n.rollback && n.rollback.page) || {}, rr = (n.rollback && n.rollback.engine) || {};
  return { t: performance.timeOrigin + performance.now(), mode: n.mode, frame: n.frame, lost: n.lostMs, stallMs: n.stallMs,
           need: m.need, pending: m.pending, hist: (m.history || []).map((h) => [h.frame, h.to, h.delay, h.why]),
           st: n.step ? n.step.selfStepMs : null, sp: n.step ? n.step.selfPresentMs : null, saveEma: n.step ? n.step.saveEmaMs : null, loadEma: n.step ? n.step.loadEmaMs : null,
           run: pg.runMs, save: pg.saveMs, load: pg.loadMs, k: pg.k, win: rr.window != null ? rr.window : (e.rollback ? e.rollback.window : null),
           wipes: pg.wipes, tlbSame: pg.tlbSameByContent, rb: pg.rollbacks, resim: pg.resimFrames, bridge: pg.bridgeFrames, cost: n.costAvgMs, delay: e.delay, state: e.state };
};

const all = [];
for (let run = 0; run < RUNS; run++) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args, protocolTimeout: 600000 });
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, 'n64_room_mode_probe'); } catch (_e) {}
  const out = { run, rows: [], switches: [], result: null };
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { const t = m.text(); if (/\[bench\] (room|RESULT)|zero-lag|input delay|⚠/.test(t)) console.log('  > ' + t.slice(0, 220)); });
    const CC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (let i = 0; i < 5; i++) code += CC[Math.floor(Math.random() * CC.length)];
    const q = `?bench=1&benchauto=1&benchsec=${SEC}&benchphase=room&np=${code}&host=1&net=local&game=${encodeURIComponent(GAME)}${SEAM ? '&workerrig=clock' : ''}${EXTRA ? '&' + EXTRA : ''}`;
    await page.goto(BASE + '/n64/index.html' + q, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    let prev = null, seenHist = 0;
    while (Date.now() - t0 < (SEC + 240) * 1000) {
      await sleep(1000);
      const h = await page.evaluate(SAMPLE).catch((e) => ({ err: String(e) }));
      const fr = page.frames().find((f) => f !== page.mainFrame() && /n64\/index\.html/.test(f.url()));
      const g = fr ? await fr.evaluate(SAMPLE).catch(() => null) : null;
      const res = await page.evaluate(() => window.__benchResult || null).catch(() => null);
      if (h && !h.err && h.frame != null && h.state === 'running' || (h && h.state === 'stalled')) {
        if (h.hist.length > seenHist) { for (const x of h.hist.slice(seenHist)) { out.switches.push(x); console.log('  SWITCH ' + JSON.stringify(x)); } seenHist = h.hist.length; }
        if (prev && h.t > prev.t) {
          const dt = (h.t - prev.t) / 1000;
          const row = { t: Math.round((Date.now() - t0) / 1000), mode: h.mode, speed: +((h.frame - prev.frame) / dt / 60).toFixed(4),
            lostMs: Math.round((h.lost || 0) - (prev.lost || 0)), stallMs: Math.round((h.stallMs || 0) - (prev.stallMs || 0)),
            need: h.need, st: h.st, sp: h.sp, run: h.run, save: h.save, load: h.load, k: h.k, win: h.win, delay: h.delay, cost: h.cost != null ? +(+h.cost).toFixed(2) : null,
            wipes: h.wipes, tlbSame: h.tlbSame, rb: (h.rb || 0) - (prev.rb || 0), resim: (h.resim || 0) - (prev.resim || 0),
            g: g && !g.err ? { mode: g.mode, st: g.st, sp: g.sp, run: g.run, save: g.save, load: g.load, k: g.k, cost: g.cost != null ? +(+g.cost).toFixed(2) : null } : null };
          out.rows.push(row); console.log(JSON.stringify(row));
        }
        prev = h;
      }
      if (WSLOW_ON && out.rows.length) {
        const tNow = out.rows[out.rows.length - 1].t;
        const want = tNow >= WSLOW[1] && tNow < WSLOW[2] ? WSLOW[0] : 1;
        if (want !== (out.wslowR || 1)) {
          const r = await page.evaluate((R) => window.__n64Worker.eval(`(function (R) {
            var M = self.Module;
            if (!self.__wslow) {
              self.__wslow = { R: R, addedMs: 0 };
              ['_neil_ls_run_frame', '_neil_state_save_raw_fast', '_neil_state_load_raw'].forEach(function (n) {
                var f = M[n]; if (typeof f !== 'function') return;
                M[n] = function () { var R2 = self.__wslow.R, t0 = performance.now(), r = f.apply(this, arguments), d = performance.now() - t0, u = performance.now() + d * (R2 - 1);
                  while (performance.now() < u) {} self.__wslow.addedMs += d * (R2 - 1); return r; };
              });
            }
            self.__wslow.R = R; return R; })(${R})`), want).catch((e) => 'no: ' + e);
          out.wslowR = want; console.log('  WSLOW R=' + want + ' at t=' + tNow + ' (' + r + ')');
        }
      }
      // --stalllog: the HOST engine's stall/resume events (frame, why, ms, mode) — installed once
      if (argv.includes('--stalllog') && SEAM && out.rows.length && !out.stl) {
        out.stl = await page.evaluate(() => window.__n64Worker.eval(`(function (e) { if (!e) return null; if (e.__stl) return 1; e.__stl = [];
          var o = e._emit; e._emit = function (t, d) { if (t === 'stall' || t === 'resume') e.__stl.push([t, d && d.frame, (d && d.why) || '', Math.round((d && d.ms) || 0), e.rollback ? 1 : 0, (d && d.waitingOn) || null]); return o.apply(this, arguments); };
          return 1; })(self.RM && self.RM.eng)`)).catch(() => null);
      }
      if (FSW.length && out.rows.length) {
        const tNow = out.rows[out.rows.length - 1].t;
        let want = null;
        for (let i = 0; i < FSW.length; i++) if (tNow >= FSW[i]) want = i % 2 === 0 ? 'down' : 'up';
        if (want && want !== out.fswDone) {
          const r = await page.evaluate((w) => window.__n64Worker.eval(`(function (e, w) { if (!e) return 'no engine';
            if (!e.__fsOrig) e.__fsOrig = e._capNeedOf;
            var done = w === 'down' ? !e.rollback : !!e.rollback;
            if (done) { e._capNeedOf = e.__fsOrig; return 'done'; }
            if (w === 'down') e._capNeedOf = function () { return 2; };
            else { e._capNeedOf = function () { return 0.1; }; e._capUpCooldown = 1000; e._capDownAt = 0; e._capMemDown = false; }
            return 'forcing'; })(self.RM && self.RM.eng, '${w}')`), want).catch((e) => 'no: ' + e);
          if (r === 'done') { out.fswDone = want; console.log('  FORCE ' + want + ' reached at t=' + tNow); }
        }
      }
      if (res) { out.result = res; break; }
    }
  } catch (e) { out.error = String(e && e.message || e); console.log('  ERROR ' + out.error); }
  finally {
    if (out.stl) { out.stallLog = await (async () => { try { const pg = (await browser.pages()).find((x) => /n64\/index/.test(x.url())); return await pg.evaluate(() => window.__n64Worker.eval('JSON.stringify((self.RM && self.RM.eng && self.RM.eng.__stl) || [])')); } catch (e) { return String(e); } })(); console.log('STALLS ' + out.stallLog); }
    await browser.close().catch(() => {});
  }
  // the measured window: after the bench's warm-up rows
  const R = out.rows.slice(Math.min(3, out.rows.length));
  const n = R.length;
  out.summary = { run, secs: n, rollbackS: R.filter((r) => r.mode === 'rollback').length, delayS: R.filter((r) => r.mode !== 'rollback').length,
    speed: n ? +(R.reduce((a, r) => a + r.speed, 0) / n).toFixed(4) : null, lostMs: R.reduce((a, r) => a + r.lostMs, 0),
    needMax: Math.max(0, ...R.map((r) => r.need || 0)), switches: out.switches.length,
    bench: out.result && out.result.room ? { speed: out.result.room.speed, mode: out.result.room.mode, mean: out.result.room.ms && out.result.room.ms.mean } : null };
  console.log('SUMMARY ' + JSON.stringify(out.summary));
  all.push(out);
}
console.log('ALL ' + JSON.stringify(all.map((o) => o.summary)));
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(all));
