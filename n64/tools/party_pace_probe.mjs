#!/usr/bin/env node
// party_pace_probe.mjs — A TWO-TAB N64 ROOM WITH A PHONE-SHAPED HOST, MEASURED.
//
// Reproduces the live report of 2026-09-30 (room EWLE9, Mario Kart 64): an
// Android-phone HOST whose game area stayed black while its status read
// "Running.", and a desktop JOINER that rendered the race at 0.36x with
// "audio SLOW". It answers, per arm:
//   * does the host's canvas actually show pixels (composited screenshot of the
//     canvas rect, plus its computed geometry and visibility)?
//   * what guest rate does the ROOM deliver (frames the gated core ran per
//     second / the ROM's VI rate, on both consoles)?
//   * how often does each console stall, and on whom is it waiting?
//   * the host's input-delay history — every raise and every give-back.
//
// ARMS (one per invocation, --arm):
//   base   : no throttling.
//   cpu4   : the HOST tab CPU-throttled 4x (CDP Emulation.setCPUThrottlingRate),
//            standing in for a phone.
//   net    : every RTCDataChannel send (the inputs) and BroadcastChannel post
//            (the signalling) delayed by --netms (default 60 ms, +/- --jitter
//            ms), ordered, in BOTH windows: a one-way link latency. CDP network
//            emulation reaches neither, so it is injected before page scripts.
//   solo / solo2 : CONTROL — one (or two side-by-side) cores with no room.
//            Measured here: two MK64 cores under SwiftShader deliver 0.687x and
//            0.396x SOLO, so any two-core room on this box is CPU-bound and a
//            local room rate below 1.000x is not by itself a netplay finding.
//
// The only page-side instrumentation is a wrap of Netplay.Lockstep's _emit
// that RECORDS 'delay' events (and counts stall/resume); it changes nothing.
//
// USAGE (npm run web first; CLAUDE.md gate #2):
//   bash tools/probe_lock.sh run -- node n64/tools/party_pace_probe.mjs --arm base --secs 60
// Output: one JSON summary line on stdout, timeline to --json PATH.
import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const ARM = flag('arm', 'base');
const SECS = +flag('secs', '60');
const NETMS = +flag('netms', '60');
const JITTER = +flag('jitter', '20');
const CPU = +flag('cpu', '4');
const BASE = flag('url', 'http://localhost:8080');
const GAME = flag('game', 'Mario Kart 64');
const JSON_OUT = flag('json', '');
const SHOT = flag('shot', '');
const LOSE_GL = argv.includes('--lose-gl');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
                 + 'Chrome/140.0.0.0 Mobile Safari/537.36';

const log = [];
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
         '--disable-renderer-backgrounding', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist'],
});
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}

// Runs before any page script: optional link delay + the delay-event recorder.
function preloadSrc(netms, jitter) {
  return `(() => {
    window.__pp = { delays: [], stalls: 0, resumes: 0, rx: [], begins: [], t0: performance.now() };
    if (${netms} > 0) {
      // The game's inputs travel on an RTCDataChannel (the BroadcastChannel only
      // signals), so the delay goes on DataChannel.send. Ordered, like the
      // channel itself: a jittered message never overtakes an earlier one.
      // ⚠ ONE QUEUE PER CHANNEL, DRAINED IN ORDER — not one setTimeout per
      // message. Timers are whole milliseconds, so two messages due in the
      // same millisecond with per-message timers can fire in the WRONG order;
      // that reordered an 'ls' ahead of 'lsgo' in this rig, begin() then
      // cleared it, and the room deadlocked on a hole no real (ordered)
      // DataChannel can produce.
      const dsend = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (m) {
        const self = this, now = performance.now();
        const q = self.__ppQ || (self.__ppQ = []);
        const last = q.length ? q[q.length - 1].at : (self.__ppLast || 0);
        const at = Math.max(last, now + Math.max(0, ${netms} + (Math.random() * 2 - 1) * ${jitter}));
        self.__ppLast = at;
        q.push({ at, m });
        const drain = () => {
          self.__ppT = 0;
          const t = performance.now();
          while (q.length && q[0].at <= t) { const x = q.shift(); try { if (self.readyState === 'open') dsend.call(self, x.m); } catch (e) {} }
          if (q.length) self.__ppT = setTimeout(drain, Math.max(0, q[0].at - t));
        };
        if (!self.__ppT) self.__ppT = setTimeout(drain, Math.max(0, q[0].at - now));
      };
      const post = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (m) {
        const self = this, d = Math.max(0, ${netms} + (Math.random() * 2 - 1) * ${jitter});
        setTimeout(() => { try { post.call(self, m); } catch (e) {} }, d);
      };
    }
    const hook = () => {
      const L = window.Netplay && window.Netplay.Lockstep;
      if (!L || L.prototype.__ppWrapped) return !!L;
      const emit = L.prototype._emit;
      L.prototype._emit = function (ev, a) {
        try {
          if (ev === 'delay') window.__pp.delays.push({ t: Math.round(performance.now() - window.__pp.t0), frame: this.frame, from: a.from, to: a.to, at: a.at, reason: a.reason });
          else if (ev === 'stall') window.__pp.stalls++;
          else if (ev === 'resume') window.__pp.resumes++;
        } catch (e) {}
        return emit.call(this, ev, a);
      };
      // Count the start messages and every begin(): a SECOND begin() on a
      // console that is already playing resets it to frame 0.
      const recv = L.prototype.receive;
      L.prototype.receive = function (m) {
        try { if (m && (m.t === 'lsgo' || m.t === 'lsready')) window.__pp.rx.push({ t: m.t, state: this.state, frame: this.frame, at: Math.round(performance.now() - window.__pp.t0) }); } catch (e) {}
        return recv.call(this, m);
      };
      const begin = L.prototype.begin;
      L.prototype.begin = function () {
        window.__ppLs = this;
        try { window.__pp.begins.push({ state: this.state, frame: this.frame, at: Math.round(performance.now() - window.__pp.t0) }); } catch (e) {}
        return begin.call(this);
      };
      L.prototype.__ppWrapped = true;
      return true;
    };
    const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 20);
  })();`;
}

async function open(tag, url, mobile) {
  // A WINDOW EACH, not a tab each: only the front tab of a window renders and
  // takes input, and a phone's page and a desktop's page are both in front.
  const page = await browser.newPage({ type: 'window' });
  page.setDefaultTimeout(120000);
  if (mobile) {
    await page.emulate({
      userAgent: ANDROID_UA,
      viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    });
  } else {
    await page.setViewport({ width: 1280, height: 900 });
  }
  page.on('console', (m) => { const t = m.text(); if (/lockstep|\[net\]|desync|error|delay/i.test(t)) log.push('[' + tag + '] ' + t); });
  page.on('pageerror', (e) => log.push('[' + tag + '] PAGEERROR ' + e.message));
  await page.evaluateOnNewDocument(preloadSrc(ARM === 'net' ? NETMS : 0, ARM === 'net' ? JITTER : 0));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

const sample = (page) => page.evaluate(() => {
  const n = window.__n64Net ? window.__n64Net() : null;
  const c = document.getElementById('canvas');
  let canvas = null;
  if (c) {
    const cs = getComputedStyle(c), r = c.getBoundingClientRect();
    let anc = [], e = c;
    while (e && e !== document.body) { const s = getComputedStyle(e); anc.push(e.id || e.tagName, s.display, s.visibility, s.opacity); e = e.parentElement; }
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    canvas = { w: c.width, h: c.height, css: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
               display: cs.display, visibility: cs.visibility, parent: c.parentElement && c.parentElement.id,
               topAtCenter: top ? (top.id || top.tagName) : null, chain: anc.join(' ') };
  }
  const E = window.__ppLs; let eng = null;
  if (E) {
    const have = {};
    for (const [f, m] of E.inputs) for (const p of m.keys()) have[p] = Math.max(have[p] == null ? -1 : have[p], f);
    const holes = [];
    for (const p of E.occupiedPorts()) for (let f = E.frame; f < E.frame + 3; f++) if (E._inputFor(f, p) === undefined) holes.push(p + '@' + f);
    eng = { frame: E.frame, delay: E.delay, queuedTo: E._queuedTo, scheduledTo: E._scheduledTo, pending: E._pendingDelay,
            maxInput: have, holes, sent: E.stats.sent, recv: E.stats.received, state: E.state };
  }
  const st = document.getElementById('mobileStatus'), s2 = document.getElementById('status');
  const fps = document.getElementById('fps');
  const r = window.__n64Rate || null;
  return {
    t: performance.now(), net: n && { state: n.state, running: n.running, frame: n.frame, stalls: n.stalls, stallMs: n.stallMs,
      stalling: n.stalling, waitingOn: n.waitingOn, reanchors: n.reanchors, fault: n.fault, viHz: n.viHz,
      delay: n.engine && n.engine.delay, estate: n.engine && n.engine.state, efr: n.engine && n.engine.frame,
      minLead: n.engine && n.engine.minLead, meanLead: n.engine && n.engine.meanLead, desync: n.engine && n.engine.desync,
      pace: n.pace || null, gl: n.gl || null, delayHistory: n.engine && n.engine.delayHistory },
    rate: r && { speed: r.speed, from: r.speedFrom, starved: r.starved, shown: r.shown, made: r.made, lost: r.lost, e2e: r.e2eHwX },
    status: (st && st.textContent) || (s2 && s2.textContent) || '', fpsText: fps ? fps.textContent : null,
    canvas, eng, pp: window.__pp ? { delays: window.__pp.delays.slice(), stalls: window.__pp.stalls, resumes: window.__pp.resumes, rx: window.__pp.rx.slice(0, 20), begins: window.__pp.begins.slice(0, 20) } : null,
  };
});

async function canvasPixels(page) {
  const box = await page.evaluate(() => { const c = document.getElementById('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  if (!(box.width > 2 && box.height > 2)) return { box, nonBlack: 0, total: 0, note: 'canvas has no area' };
  const buf = await page.screenshot({ clip: box, type: 'png', encoding: 'base64' });
  // Decode on the page side (no PNG lib here): draw into a 2D canvas and count.
  const res = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let nb = 0, distinct = new Set();
    for (let i = 0; i < d.length; i += 4 * 7) { if (d[i] + d[i + 1] + d[i + 2] > 30) nb++; if (distinct.size < 500) distinct.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
    return { nonBlack: nb, total: Math.floor(d.length / 28), distinct: distinct.size, w: cv.width, h: cv.height };
  }, buf);
  return { box, ...res, png: buf };
}

const out = { arm: ARM, code: CODE, secs: SECS, netms: ARM === 'net' ? NETMS : 0, jitter: ARM === 'net' ? JITTER : 0, cpu: ARM === 'cpu4' ? CPU : 1 };
let host, join;
if (ARM === 'solo' || ARM === 'solo2') {
  // CONTROL: the same ROM with no room, on a desktop tab (and, for solo2, a
  // second one beside it) — what this box's cores deliver without lockstep.
  try {
    const pages = [await open('solo', `${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart`, false)];
    if (ARM === 'solo2') pages.push(await open('solo-b', `${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart`, true));
    await new Promise((r) => setTimeout(r, 15000));
    const sp = pages.map(() => []);
    for (let i = 0; i < SECS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      for (let k = 0; k < pages.length; k++) sp[k].push(await pages[k].evaluate(() => window.__n64Rate ? +(window.__n64Rate.speed || 0).toFixed(3) : null));
    }
    out.solo = sp.map((a) => ({ mean: +(a.reduce((x, y) => x + (y || 0), 0) / a.length).toFixed(3), samples: a }));
    out.fpsText = await pages[0].evaluate(() => document.getElementById('fps').textContent);
  } catch (e) { out.error = e.message; }
  console.log(JSON.stringify(out));
  await browser.close().catch(() => {});
  process.exit(0);
}
try {
  const g = encodeURIComponent(GAME);
  host = await open('host', `${BASE}/n64/?np=${CODE}&game=${g}&net=local`, true);
  if (ARM === 'cpu4') {
    const cdp = await host.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  }
  await new Promise((r) => setTimeout(r, 1500));
  join = await open('join', `${BASE}/n64/?np=${CODE}&game=${g}&net=local&join=1`, false);
  // The host admits the joiner the way the person would: a tap on Allow, after
  // asking what is actually on top there (a covered button is a finding).
  let admitted = false, admitWhy = null;
  const tryAdmit = async () => {
    const r = await host.evaluate(() => {
      const el = document.querySelector('#npApproveAllow'); if (!el) return null;
      const b = el.getBoundingClientRect(); if (!b.width) return { covered: 'no box' };
      const x = b.left + b.width / 2, y = b.top + b.height / 2, t = document.elementFromPoint(x, y);
      return (t === el || el.contains(t)) ? { x, y } : { covered: t ? (t.id || t.tagName) : 'nothing' };
    });
    if (!r) return;
    if (r.covered) { if (admitWhy !== r.covered) log.push('[rig] Allow covered by ' + r.covered); admitWhy = r.covered; return; }
    // Input is only delivered to the foreground tab (a tap on a background tab
    // never acks, and the call hangs) — the phone's page is in front anyway.
    await host.bringToFront();
    await host.touchscreen.tap(r.x, r.y);
    admitted = true; log.push('[rig] host tapped Allow at ' + Math.round(r.x) + ',' + Math.round(r.y));
  };

  // Wait for both gates to engage.
  const t0 = Date.now();
  let a, b;
  while (Date.now() - t0 < 180000) {
    a = await sample(host); b = await sample(join);
    if (!admitted) { try { await tryAdmit(); } catch (e) { log.push('[rig] admit error ' + e.message); } }
    if (a.net && b.net && a.net.running && b.net.running && a.net.frame > 5 && b.net.frame > 5) break;
    if (b.net && b.net.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  out.startMs = Date.now() - t0; out.admitted = admitted; out.admitWhy = admitWhy;
  out.startedHost = !!(a.net && a.net.running); out.startedJoin = !!(b.net && b.net.running);
  if (!out.startedHost || !out.startedJoin) { out.error = 'room never started'; out.hostAtFail = a; out.joinAtFail = b; throw new Error('room never started'); }

  // Measure.
  const tl = [];
  const s0h = a, s0j = b; const w0 = Date.now();
  let lastH = a, lastJ = b;
  while (Date.now() - w0 < SECS * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await sample(host), j = await sample(join);
    const dt = (h.t - lastH.t) / 1000;
    tl.push({ s: Math.round((Date.now() - w0) / 1000),
      hostFps: +((h.net.frame - lastH.net.frame) / dt).toFixed(1), joinFps: +((j.net.frame - lastJ.net.frame) / ((j.t - lastJ.t) / 1000)).toFixed(1),
      delay: h.net.delay, hostStalls: h.net.stalls, joinStalls: j.net.stalls, hostWait: h.net.waitingOn, joinWait: j.net.waitingOn,
      hostSpeed: h.rate && h.rate.speed, joinSpeed: j.rate && j.rate.speed, joinStarved: j.rate && j.rate.starved,
      hostPace: h.net.pace && h.net.pace.text, joinPace: j.net.pace && j.net.pace.text,
      hostStatus: h.status.slice(0, 120), joinFps_text: (j.fpsText || '').slice(0, 160) });
    lastH = h; lastJ = j;
  }
  const secs = (lastH.t - s0h.t) / 1000, viHz = lastH.net.viHz || 60;
  out.viHz = viHz;
  out.hostRate = +((lastH.net.frame - s0h.net.frame) / secs / viHz).toFixed(4);
  out.joinRate = +((lastJ.net.frame - s0j.net.frame) / ((lastJ.t - s0j.t) / 1000) / viHz).toFixed(4);
  out.hostStallsInWindow = lastH.net.stalls - s0h.net.stalls; out.joinStallsInWindow = lastJ.net.stalls - s0j.net.stalls;
  out.hostStallMsInWindow = lastH.net.stallMs - s0h.net.stallMs; out.joinStallMsInWindow = lastJ.net.stallMs - s0j.net.stallMs;
  out.delayNow = lastH.net.delay; out.delayHistory = (lastH.pp && lastH.pp.delays) || [];
  out.joinDelayEvents = (lastJ.pp && lastJ.pp.delays) || [];
  out.minLead = lastH.net.minLead; out.meanLead = lastH.net.meanLead;
  out.desync = lastH.net.desync || lastJ.net.desync || null;
  out.speedSamples = { host: tl.map((x) => x.hostSpeed), join: tl.map((x) => x.joinSpeed), joinStarved: tl.filter((x) => x.joinStarved).length };
  out.hostCanvas = lastH.canvas; out.hostStatus = lastH.status; out.joinFpsText = lastJ.fpsText;
  out.joinStatus = lastJ.status; out.hostGl = lastH.net.gl; out.joinGl = lastJ.net.gl;
  out.hostPace = lastH.net.pace; out.joinPace = lastJ.net.pace; out.joinE2e = lastJ.rate && lastJ.rate.e2e;
  out.engineDelayHistory = lastH.net.delayHistory;
  out.engHost = lastH.eng; out.engJoin = lastJ.eng;
  out.startMsgs = { host: { rx: lastH.pp && lastH.pp.rx, begins: lastH.pp && lastH.pp.begins }, join: { rx: lastJ.pp && lastJ.pp.rx, begins: lastJ.pp && lastJ.pp.begins } };
  if (LOSE_GL) {
    // Take the host's WebGL context away the way a phone's browser can, and
    // read what the page then tells its player.
    await host.evaluate(() => { const g = document.getElementById('canvas').getContext('webgl2');
      const x = g && g.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await sample(host);
    out.glLoss = { gl: after.net.gl, status: after.status };
  }
  const px = await canvasPixels(host);
  out.hostPixels = { nonBlack: px.nonBlack, total: px.total, distinct: px.distinct, box: px.box };
  if (SHOT && px.png) writeFileSync(SHOT, Buffer.from(px.png, 'base64'));
  const pj = await canvasPixels(join);
  out.joinPixels = { nonBlack: pj.nonBlack, total: pj.total, distinct: pj.distinct };
  out.timeline = tl;
} catch (e) {
  out.error = out.error || e.message;
} finally {
  out.log = log.slice(-80);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  const brief = { ...out }; delete brief.timeline; delete brief.log;
  console.log(JSON.stringify(brief));
  await browser.close().catch(() => {});
}
