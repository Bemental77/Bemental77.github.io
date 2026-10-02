#!/usr/bin/env node
// n64_room_burst_probe.mjs — A TWO-BROWSER N64 ROOM WITH A PHONE-SHAPED GUEST, MEASURED
// FIELD BY FIELD.
//
// Asked by a real phone (Android Chrome, Mali-G715, MK64 PAL, room guest, worker mode):
// cost 17.9 ms a field against a 20 ms period, 902 fields over a period, one of 620 ms,
// "falls behind in bursts" (room 0.86-0.91x), and "14 shown / 25 made". Per arm this
// rig reports, for BOTH consoles:
//   room rate     frames the gated core ran per wall second / the ROM's field rate
//   stalls        count and ms (who waits on whom)
//   bursts        costOver / costMaxMs / lostMs (room_core's own capacity counters) and,
//                 with ?costdbg=1 in the query, the worker's per-field cost buckets
//                 (jit / shader / prog / read / tex / buf / sync / core) and its slow tasks
//   presentation  the core's made pictures (GameFPS), the worker's `shown` and a SCREEN
//                 witness: on every main-thread animation frame the placeholder canvas is
//                 drawn into a 96x72 2D canvas and hashed; changes per second is what
//                 actually reached the page (a lower bound on distinct pictures)
//   mode          the engine's mode (rollback / delay), every switch, and the step the
//                 capacity gate reads (selfStepMs)
//   desync        the engine's verdict and the fingerprints compared
//
// THE PHONE. Two browser PROCESSES (a BroadcastChannel cannot cross them), paired over the
// shipped signalling path (?signal=ws) through tools/mqtt_ws_broker.mjs, then a real WebRTC
// DataChannel. The guest is mobile-emulated (UA, touch, viewport) and its emulator WORKER is
// held to --worker-cpu of one core by a cgroup v1 cpu quota (a CDP CPU throttle does not reach
// a dedicated worker). ⚠ It is NOT a phone GPU: SwiftShader renders, so a Mali shader-compile
// or driver stall cannot reproduce here, only the CPU side.
//
// USAGE (a dev server on the snapshot first; CLAUDE.md gate #2 — tools/devserver.mjs):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_room_burst_probe.mjs --url http://localhost:19200 \
//        --secs 60 --worker-cpu 0.5 --query costdbg=1 [--qhost ..] [--qjoin ..] [--json PATH]
// Emits one JSON summary line on stdout.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);
const { startBroker } = await import('../../tools/mqtt_ws_broker.mjs');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:19200');
const GAME = flag('game', 'Mario Kart 64');
const SECS = +flag('secs', '60');
const WARM = +flag('warm', '10');
const Q = flag('query', '');
const QH = flag('qhost', Q), QJ = flag('qjoin', Q);
const WCPU = +flag('worker-cpu', '0');       // 0 = no throttle; else the share of ONE core the guest's workers get
const JSON_OUT = flag('json', '');
// --unthrottle-at S: lift the guest's worker throttle S seconds into the measured window (the
// device "gets faster": a gated room must return to zero-lag mode, rbResume, with 0 desyncs).
const UNTHROTTLE_AT = +flag('unthrottle-at', '0');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CG_ROOT = '/sys/fs/cgroup/cpu';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load1 = () => { try { return +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { return null; } };

const MQTT_CACHE = '/tmp/npdm/mqtt-5.3.4.min.js';
if (!fs.existsSync(MQTT_CACHE)) {
  fs.mkdirSync(path.dirname(MQTT_CACHE), { recursive: true });
  execSync(`curl -sS -f -o ${MQTT_CACHE} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
}
const MQTT_SRC = fs.readFileSync(MQTT_CACHE, 'utf8');

// The screen witness, before any page script, on the RAW requestAnimationFrame.
const PRE = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const S = window.__scr = { frames: 0, changes: 0, last: -1, err: null };
  let cv = null, cx = null;
  (function f() {
    raf(f);
    try {
      const src = document.getElementById('canvas');
      if (!src || !window.__n64Worker || !window.__n64Worker.state().booted) return;
      if (!cv) { cv = document.createElement('canvas'); cv.width = 96; cv.height = 72; cx = cv.getContext('2d', { willReadFrequently: true }); }
      cx.drawImage(src, 0, 0, 96, 72);
      const d = cx.getImageData(0, 0, 96, 72).data;
      let h = 0x811c9dc5 | 0;
      for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619);
      S.frames++;
      if (h !== S.last) { S.changes++; S.last = h; }
    } catch (e) { S.err = String(e && e.message || e).slice(0, 200); }
  })();
})();`;

function descendantPids(root) {
  const out = [];
  let all = [];
  try { all = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch (e) { return out; }
  const ppid = {};
  for (const p of all) { try { ppid[p] = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]; } catch (e) {} }
  const want = new Set([String(root)]);
  let grew = true;
  while (grew) { grew = false; for (const p of all) if (!want.has(p) && want.has(ppid[p])) { want.add(p); grew = true; } }
  for (const p of want) out.push(+p);
  return out;
}
function throttleStart(P, frac) {
  const dir = path.join(CG_ROOT, `n64burst-${process.pid}-${P.role}`);
  try {
    fs.mkdirSync(dir);
    // A 2 ms period: the quota is spread finely, so the throttle itself does not manufacture
    // 10 ms holes in a field the way a 10 ms period would.
    fs.writeFileSync(path.join(dir, 'cpu.cfs_period_us'), '2000');
    fs.writeFileSync(path.join(dir, 'cpu.cfs_quota_us'), String(Math.max(1000, Math.round(2000 * frac))));
  } catch (e) { P.cg = { frac, err: String(e.message || e).slice(0, 120) }; return; }
  P.cg = { dir, frac, tids: [] };
  const bpid = P.browser.process() && P.browser.process().pid;
  const scan = () => {
    for (const pid of descendantPids(bpid)) {
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (e) { continue; }
      if (!cmd.includes('--type=renderer')) continue;
      let tids = [];
      try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
      for (const t of tids) {
        if (P.cg.tids.includes(+t)) continue;
        let comm = '';
        try { comm = fs.readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').trim(); } catch (e) { continue; }
        if (!/^DedicatedWorker/.test(comm)) continue;
        try { fs.writeFileSync(path.join(dir, 'tasks'), String(t)); P.cg.tids.push(+t); } catch (e) {}
      }
    }
  };
  scan();
  P.cg.timer = setInterval(scan, 500);
}
function throttleStat(P) {
  if (!P.cg || !P.cg.dir) return null;
  try { const o = {}; for (const l of fs.readFileSync(path.join(P.cg.dir, 'cpu.stat'), 'utf8').trim().split('\n')) { const [k, v] = l.split(' '); o[k] = +v; } return o; } catch (e) { return null; }
}
async function throttleEnd(P) {
  if (!P.cg || !P.cg.dir) return;
  clearInterval(P.cg.timer);
  for (let i = 0; i < 20; i++) { try { fs.rmdirSync(P.cg.dir); return; } catch (e) { await sleep(250); } }
}

async function launch(role, mobile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `n64burst-${role}-`));
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
           '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
           '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800'],
  });
  try { require(path.join(path.dirname(__filename), '../../tools/browser_leak_guard.js')).guard(browser, __filename); } catch (_e) {}
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(120000);
  const P = { role, browser, page, dir, errs: [], log: [] };
  page.on('pageerror', (e) => P.errs.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { const t = m.text(); if (/desync|rollback\]|zero-lag|delay lockstep|capacity|⚠|fault|switch/i.test(t) && P.log.length < 400) P.log.push(t.slice(0, 260)); });
  if (mobile) {
    await page.emulate({ userAgent: ANDROID_UA, viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } });
  } else await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(MQTT_SRC);
  await page.evaluateOnNewDocument(PRE);
  return P;
}

const sample = (P) => P.page.evaluate(() => {
  const n = window.__n64Net ? window.__n64Net() : null;
  const ws = window.__n64Worker ? window.__n64Worker.state() : null;
  const st = ws && ws.stat;
  const e = n && n.engine;
  return {
    t: performance.now(),
    frame: n && n.frame, running: n && n.running, stalls: n && n.stalls, stallMs: n && n.stallMs, viHz: n && n.viHz,
    costOver: n && n.costOver, costMaxMs: n && n.costMaxMs, lostMs: n && n.lostMs, costAvgMs: n && n.costAvgMs,
    step: n && n.step, mode: n && n.mode, delay: e && e.delay, rollback: e && e.rollback, emode: e && e.mode,
    desync: e && e.desync, hcmp: e && e.hashesCompared, state: n && n.state, waitingOn: n && n.waitingOn,
    rb: n && n.rollback && n.rollback.page ? { k: n.rollback.page.k, kChanges: n.rollback.page.kChanges, kWhy: n.rollback.page.kWhy, rollbacks: n.rollback.page.rollbacks,
         maxResimMs: n.rollback.page.maxResimMs, rearms: n.rollback.page.rearms, stepMs: n.rollback.page.stepMs, saveMs: n.rollback.page.saveMs,
         loadMs: n.rollback.page.loadMs, runMs: n.rollback.page.runMs, hidden: n.rollback.page.hidden } : null,
    w: st ? { frame: st.frame, shown: st.shown, animFrames: st.animFrames, fpsText: st.fpsText, dbg: st.dbg || null, vi: st.vi } : null,
    scr: window.__scr ? { frames: window.__scr.frames, changes: window.__scr.changes, err: window.__scr.err } : null,
    u: window.__audioDbg ? window.__audioDbg.u : null,
  };
}).catch((e) => ({ err: String(e.message || e).slice(0, 200) }));

const out = { game: GAME, secs: SECS, qhost: QH, qjoin: QJ, workerCpu: WCPU, load: [load1()] };
let H = null, J = null, broker = null;
try {
  broker = await startBroker({ port: 0 });
  const CODE = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  const url = (role, q) => `${BASE}/n64/?np=${CODE}&game=${encodeURIComponent(GAME)}${role === 'join' ? '&join=1' : ''}&signal=ws&wsbroker=${encodeURIComponent(broker.url)}${q ? '&' + q : ''}`;
  H = await launch('host', false);
  J = await launch('join', true);
  if (WCPU > 0) throttleStart(J, WCPU);
  await H.page.goto(url('host', QH), { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40 && broker.stats.clients < 1; i++) await sleep(250);
  await J.page.goto(url('join', QJ), { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let a = null, b = null;
  while (Date.now() - t0 < 240000) {
    const allow = await H.page.$('#npApproveAllow').catch(() => null);
    if (allow) await H.page.evaluate(() => { const x = document.getElementById('npApproveAllow'); if (x && x.getBoundingClientRect().width) x.click(); }).catch(() => {});
    a = await sample(H); b = await sample(J);
    if (a.running && b.running && a.frame > 30 && b.frame > 30) break;
    await sleep(1000);
  }
  out.startMs = Date.now() - t0;
  if (!(a && b && a.running && b.running)) throw new Error('room never started: host ' + JSON.stringify(a).slice(0, 300) + ' join ' + JSON.stringify(b).slice(0, 300));
  await sleep(WARM * 1000);
  const tl = [];
  const s0 = { h: await sample(H), j: await sample(J) };
  let lh = s0.h, lj = s0.j;
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    if (UNTHROTTLE_AT > 0 && i + 1 === UNTHROTTLE_AT && J.cg && J.cg.dir) {
      try { fs.writeFileSync(path.join(J.cg.dir, 'cpu.cfs_quota_us'), '-1'); out.unthrottledAt = i + 1; } catch (e) { out.unthrottleErr = String(e.message || e); }
    }
    const h = await sample(H), j = await sample(J);
    const r = (x, y) => (x.frame != null && y.frame != null) ? +((y.frame - x.frame) / ((y.t - x.t) / 1000) / (y.viHz || 60)).toFixed(3) : null;
    tl.push({ s: i + 1, hRate: r(lh, h), jRate: r(lj, j), delay: h.delay, rb: h.rollback, jStep: j.step && j.step.selfStepMs,
              jOver: j.costOver - lj.costOver, jMax: j.costMaxMs, jLost: j.lostMs - lj.lostMs,
              hStallMs: h.stallMs - lh.stallMs, jStallMs: j.stallMs - lj.stallMs,
              jShown: j.w && lj.w ? j.w.shown - lj.w.shown : null, jFields: j.w && lj.w ? j.w.frame - lj.w.frame : null,
              jScreen: j.scr && lj.scr ? j.scr.changes - lj.scr.changes : null, jMade: j.w && j.w.fpsText,
              hScreen: h.scr && lh.scr ? h.scr.changes - lh.scr.changes : null, hK: h.rb && h.rb.k });
    lh = h; lj = j;
  }
  const e = { h: lh, j: lj };
  const secs = (e.h.t - s0.h.t) / 1000, viHz = e.h.viHz || 60;
  const d = (k, s) => (e[s][k] != null && s0[s][k] != null) ? e[s][k] - s0[s][k] : null;
  out.viHz = viHz;
  out.rate = { host: +(d('frame', 'h') / secs / viHz).toFixed(4), join: +(d('frame', 'j') / ((e.j.t - s0.j.t) / 1000) / viHz).toFixed(4) };
  out.stalls = { host: d('stalls', 'h'), hostMs: d('stallMs', 'h'), join: d('stalls', 'j'), joinMs: d('stallMs', 'j') };
  out.bursts = { join: { costOver: d('costOver', 'j'), costMaxMs: e.j.costMaxMs, lostMs: d('lostMs', 'j'), costAvgMs: e.j.costAvgMs && +e.j.costAvgMs.toFixed(2),
                         overPerS: +(d('costOver', 'j') / secs).toFixed(2) },
                 host: { costOver: d('costOver', 'h'), costMaxMs: e.h.costMaxMs, lostMs: d('lostMs', 'h'), costAvgMs: e.h.costAvgMs && +e.h.costAvgMs.toFixed(2) } };
  if (e.j.w && s0.j.w) {
    const ws = (e.j.t - s0.j.t) / 1000;
    out.present = { join: { fieldsPerS: +((e.j.w.frame - s0.j.w.frame) / ws).toFixed(2), shownPerS: +((e.j.w.shown - s0.j.w.shown) / ws).toFixed(2),
                            animPerS: +((e.j.w.animFrames - s0.j.w.animFrames) / ws).toFixed(2),
                            screenPerS: +((e.j.scr.changes - s0.j.scr.changes) / ws).toFixed(2), screenRafPerS: +((e.j.scr.frames - s0.j.scr.frames) / ws).toFixed(2),
                            made: e.j.w.fpsText, scrErr: e.j.scr.err } };
    if (e.h.w && s0.h.w) out.present.host = { fieldsPerS: +((e.h.w.frame - s0.h.w.frame) / secs).toFixed(2), shownPerS: +((e.h.w.shown - s0.h.w.shown) / secs).toFixed(2),
                            screenPerS: +((e.h.scr.changes - s0.h.scr.changes) / secs).toFixed(2), made: e.h.w.fpsText };
  }
  // The game's own pictures per second (GameFPS, one value per wall second) averaged over the
  // window, against the screen witness's changes over the same window.
  const gfps = (t) => { const m = /GameFPS: (\d+)/.exec(t || ''); return m ? +m[1] : null; };
  const madeJ = tl.map((x) => gfps(x.jMade)).filter((v) => v != null);
  if (out.present && out.present.join && madeJ.length) {
    out.present.join.madeAvg = +(madeJ.reduce((a, b) => a + b, 0) / madeJ.length).toFixed(2);
    out.present.join.screenPerMade = +(out.present.join.screenPerS / out.present.join.madeAvg).toFixed(3);
  }
  out.underruns = { host: (e.h.u != null && s0.h.u != null) ? e.h.u - s0.h.u : null, join: (e.j.u != null && s0.j.u != null) ? e.j.u - s0.j.u : null };
  out.modeTl = tl.map((x) => (x.rb ? 'R' : 'D' + x.delay)).join(' ');
  out.mode = { host: e.h.emode, join: e.j.emode, delay: e.h.delay, rollback: e.h.rollback, joinStep: e.j.step };
  out.rb = { host: e.h.rb, join: e.j.rb };
  out.desync = e.h.desync || e.j.desync || null;
  out.hcmp = { host: e.h.hcmp, join: e.j.hcmp };
  out.dbg = { join: e.j.w && e.j.w.dbg, host: e.h.w && e.h.w.dbg };
  out.cg = J.cg ? { frac: J.cg.frac, err: J.cg.err || null, threads: J.cg.tids.length, stat: throttleStat(J) } : null;
  out.timeline = tl;
  out.logs = { host: H.log.slice(-40), join: J.log.slice(-40) };
  out.errs = { host: H.errs.slice(0, 5), join: J.errs.slice(0, 5) };
} catch (err) {
  out.fault = String(err && err.message || err).slice(0, 600);
} finally {
  out.load.push(load1());
  for (const P of [H, J]) { if (!P) continue; try { await P.browser.close(); } catch (e) {} await throttleEnd(P); try { fs.rmSync(P.dir, { recursive: true, force: true }); } catch (e) {} }
  if (broker) await broker.close().catch(() => {});
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  const brief = { ...out }; delete brief.timeline; delete brief.logs;
  console.log(JSON.stringify(brief));
}
