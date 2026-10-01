#!/usr/bin/env node
// party_ghost_probe.mjs — ONE REAL N64 CORE IN A ROOM WITH A PERFECT PEER.
//
// WHY. A two-core room cannot be measured at 1.000x on this 4-core box (two
// MK64 cores manage 0.687x/0.396x SOLO side by side), yet the live report
// (room 49K4T) is a desktop host with a 4.28x cap whose room ran at 0.93x.
// The question is whether THE PAGE'S OWN PIPELINE — the 1.000x governor, the
// feed loop, rAF/timer cadence (PAL 50 Hz fields on 60 Hz rAF), the per-frame
// lockstep handshake — loses time when nothing else is slow. So the other
// console is a GHOST: a real Netplay.Lockstep engine in a Web Worker (its own
// thread, 1 ms timers), with no emulator, fed by the same 1.000x governor as
// the page (lsDueNow: re-anchor on a stall, at most 2 periods of debt), wired
// to the page's engine through an ORDERED link with configurable one-way
// latency, jitter and loss (a lost packet is retransmitted after an RTO and
// holds up everything behind it, as SCTP on a reliable ordered channel does).
//
// The page's own engine is attached through window.__n64LsAttach — the same
// seam n64/tools/lockstep_probe.mjs's attach arm uses — so the feed, the pad
// packing, the governor and the party UI are the shipping code.
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/party_ghost_probe.mjs \
//        --role host|guest --mobile --lat 50 --jitter 20 --loss 0 --secs 45
// Prints one JSON line: room rate, stalls, reanchors, delay history, audio
// underruns, the page's pace sentence.
import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const ROLE = flag('role', 'host');
const MOBILE = has('mobile');
const LAT = +flag('lat', '20'), JIT = +flag('jitter', '5'), LOSS = +flag('loss', '0');
const RTO = +flag('rto', '250');
const SECS = +flag('secs', '45');
const CPU = +flag('cpu', '1');
const DELAY = flag('delay', null);
const BASE = flag('url', 'http://localhost:8080');
const GAME = flag('game', 'Mario Kart 64');
const QUERY = flag('query', '');
const JSON_OUT = flag('json', '');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
                 + 'Chrome/140.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The ghost, as a worker. Latency is applied INSIDE the worker in both
// directions, so the page thread never waits on it.
const GHOST_SRC = `
self.window = self;
importScripts('__ORIGIN__/lib/netplay.js');
let ls = null, cfg = null, t0 = performance.now();
const qIn = [], qOut = [];   // [{at, m}] ordered
let lastIn = 0, lastOut = 0;
const lat = () => Math.max(0, cfg.lat + (Math.random() * 2 - 1) * cfg.jitter)
                  + (Math.random() * 100 < cfg.loss ? cfg.rto : 0);
function enqueue(q, which, m) {
  const now = performance.now();
  let at = now + lat();
  if (which === 'in') { at = Math.max(at, lastIn); lastIn = at; } else { at = Math.max(at, lastOut); lastOut = at; }
  q.push({ at, m });
}
const G = { baseWall: 0, baseFrame: 0, frames: 0, stalls: 0, reanchors: 0, period: 20 };
function due() {
  const now = performance.now();
  if (!G.baseWall) { G.baseWall = now; G.baseFrame = G.frames; return true; }
  const d = G.baseWall + (G.frames - G.baseFrame) * G.period;
  if (now < d) return false;
  if (now - d > G.period * 2) { G.baseWall = now; G.baseFrame = G.frames; G.reanchors++; }
  return true;
}
function tick() {
  const now = performance.now();
  while (qIn.length && qIn[0].at <= now) { const x = qIn.shift(); ls.receive(x.m); }
  while (qOut.length && qOut[0].at <= now) { const x = qOut.shift(); postMessage({ t: 'm', m: x.m }); }
  if (ls && (ls.state === 'running' || ls.state === 'stalled')) {
    let g = 0;
    while (due() && g++ < 8) {
      const r = ls.beginFrame({});
      if (!r.ready) { G.baseWall = 0; break; }
      ls.endFrame(null); G.frames++;
    }
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.t === 'init') {
    cfg = d.cfg; G.period = 1000 / (cfg.viHz || 50);
    ls = new Netplay.Lockstep({ host: cfg.host, peerId: 'ghost', portCount: 4, padBytes: 4, delay: cfg.delay,
      hashEvery: 0, stallBudgetMs: 600000, frameHz: cfg.viHz || 50, send: (m) => enqueue(qOut, 'out', m) });
    ls.selfCap = 99;
    if (cfg.host) { ls.seat('ghost', 1); ls.seat(cfg.pageId, 1); }
    setInterval(tick, 1);
    postMessage({ t: 'ok' });
  } else if (d.t === 'm') enqueue(qIn, 'in', d.m);
  else if (d.t === 'ready') ls.declareReady('n64');
  else if (d.t === 'stat') postMessage({ t: 'stat', s: { frames: G.frames, reanchors: G.reanchors, state: ls.state, frame: ls.frame,
    delay: ls.delay, stalls: ls.stats.stalls, stallMs: Math.round(ls.stats.stallMs), rep: ls.paceReport ? ls.paceReport() : null } });
};`;

const browser = await puppeteer.launch({
  headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 240000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { role: ROLE, mobile: MOBILE, lat: LAT, jitter: JIT, loss: LOSS, cpu: CPU, secs: SECS, query: QUERY };
const log = [];
try {
  const page = await browser.newPage({ type: 'window' });
  page.setDefaultTimeout(180000);
  if (MOBILE) await page.emulate({ userAgent: ANDROID_UA, viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } });
  else await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m) => { const t = m.text(); if (/lockstep|\[net\]|\[gl\]|\[audio\]|error/i.test(t)) log.push(t.slice(0, 300)); });
  page.on('pageerror', (e) => log.push('PAGEERROR ' + e.message));
  // Count every WebGL readback the page makes (the core's glReadPixels lands
  // here), by size — a synchronous GPU round trip each.
  await page.evaluateOnNewDocument(() => {
    window.__rp = { n: 0, px: 0, ms: 0, bySize: {} };
    const P = WebGL2RenderingContext.prototype, rp = P.readPixels;
    P.readPixels = function (x, y, w, h) {
      const t0 = performance.now(); const r = rp.apply(this, arguments);
      const R = window.__rp; R.n++; R.px += w * h; R.ms += performance.now() - t0;
      const k = w + 'x' + h; R.bySize[k] = (R.bySize[k] || 0) + 1; return r;
    };
  });
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}${QUERY ? '&' + QUERY : ''}${has('solo') ? '&autostart' : ''}`, { waitUntil: 'domcontentloaded' });
  if (has('solo')) {
    // CONTROL: the same page, no room — the core's own loop.
    await page.waitForFunction(() => window.__n64Rate && window.__n64Rate.speed > 0.2, { timeout: 180000 });
    const r0 = await page.evaluate(() => JSON.parse(JSON.stringify(window.__rp)));
    await sleep(SECS * 1000);
    const r1 = await page.evaluate(() => JSON.parse(JSON.stringify(window.__rp)));
    out.readPixels = { calls: r1.n - r0.n, ms: Math.round(r1.ms - r0.ms), perSec: +((r1.n - r0.n) / SECS).toFixed(1), bySize: r1.bySize };
    out.speed = await page.evaluate(() => window.__n64Rate && window.__n64Rate.speed);
    throw new Error('solo control done');
  }
  if (CPU > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
  await page.waitForFunction(() => !!window.__n64LsAttach && !!window.Netplay, { timeout: 60000 });
  const delay = DELAY != null ? +DELAY : null;
  await page.evaluate((cfg, src) => {
    const w = new Worker(URL.createObjectURL(new Blob([src.replace('__ORIGIN__', location.origin)], { type: 'text/javascript' })));
    window.__ghost = w; window.__ghostStat = null;
    const isHost = cfg.role === 'host';
    const d = cfg.delay != null ? cfg.delay : Netplay.Lockstep.recommendDelay(2 * (cfg.lat + cfg.jitter), 20);
    window.__n64LsAttach({ host: isHost, peerId: 'page', portCount: 4, padBytes: 4, delay: d, hashEvery: 0,
      stallBudgetMs: 600000, send: (m) => w.postMessage({ t: 'm', m }), code: 'GHOST' });
    // THE PRODUCT KICKS THE FEED WHEN AN INPUT LANDS (watchLockstep); the seam
    // does not, so do it here the same way.
    w.onmessage = (e) => {
      if (e.data.t === 'm') { window.__n64LsEngine.receive(e.data.m); if (e.data.m.t === 'ls' && window.__n64LsKick) window.__n64LsKick(); }
      else if (e.data.t === 'stat') window.__ghostStat = e.data.s;
    };
    w.postMessage({ t: 'init', cfg: { host: !isHost, delay: d, lat: cfg.lat, jitter: cfg.jitter, loss: cfg.loss, rto: cfg.rto, viHz: 50, pageId: 'page' } });
    if (isHost) { window.__n64LsEngine.seat('page', 1); window.__n64LsEngine.seat('ghost', 1); }
    window.__ghostDelay = d;
  }, { role: ROLE, lat: LAT, jitter: JIT, loss: LOSS, rto: RTO, delay }, GHOST_SRC);
  // Boot the core: pick the ROM and press Start (mobile: the splash Start).
  await page.evaluate((want) => {
    for (const id of ['romSelect', 'mobileRomSelect']) {
      const sel = document.getElementById(id); if (!sel) continue;
      for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent.trim() === want) { sel.value = sel.options[i].value; sel.dispatchEvent(new Event('change')); }
    }
  }, GAME);
  if (MOBILE) {
    const b = await page.evaluate(() => { const r = document.getElementById('mobileSplashStart').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.tap(b.x, b.y);
  } else await page.evaluate(() => document.getElementById('btnStart').click());
  await page.waitForFunction(() => { const n = window.__n64Net && window.__n64Net(); return n && n.armed && n.coreArmed; }, { timeout: 240000 });
  // Declare: the page's engine, then the ghost.
  await page.evaluate(() => { window.__n64LsEngine.declareReady('n64'); window.__ghost.postMessage({ t: 'ready' }); });
  await page.waitForFunction(() => { const n = window.__n64Net(); return n.running && n.frame > 10; }, { timeout: 60000 });
  await sleep(3000);   // settle past the start-up stalls
  const snap = () => page.evaluate(() => {
    window.__ghost.postMessage({ t: 'stat' });
    const n = window.__n64Net(), r = window.__n64Rate || {}, a = window.__audioDbg || {}, rpx = window.__rp || {};
    return { t: performance.now(), frame: n.frame, stalls: n.stalls, stallMs: n.stallMs, reanchors: n.reanchors,
             rpN: rpx.n, rpMs: rpx.ms, rpBy: rpx.bySize,
             selfCap: n.selfCap, lostMs: n.lostMs, costOver: n.costOver, costMaxMs: n.costMaxMs, costAvgMs: n.costAvgMs,
             delay: n.engine && n.engine.delay, viHz: n.viHz, pace: n.pace, speed: r.speed, starved: r.starved,
             shown: r.shown, made: r.made, cap: r.hwX, u: a.u, m: a.m, b: a.b, ratio: a.r,
             status: (document.getElementById('status') || {}).textContent, ghost: window.__ghostStat,
             lsx: window.__n64LsExtra ? window.__n64LsExtra() : null, dh: n.engine && n.engine.delayHistory };
  });
  const a = await snap();
  if (has('profile')) {
    // Where the main thread goes, for attribution only (a profiled run is not
    // a speed measurement): categories as in n64/tools/n64_profile_probe.mjs.
    const cdp = await page.createCDPSession();
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
    await sleep(10000);
    const prof = (await cdp.send('Profiler.stop')).profile;
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const cats = {}, fns = {}; let total = 0;
    for (let i = 0; i < prof.samples.length; i++) {
      const d = prof.timeDeltas[i] || 0; total += d;
      const n = byId.get(prof.samples[i]), cf = n.callFrame, url = cf.url || '', fn = cf.functionName || '(anon)';
      const cat = fn === '(idle)' ? 'idle' : fn === '(garbage collector)' ? 'gc' : fn === '(program)' ? 'program'
        : /n64wasm\.wasm/.test(url) ? 'core wasm' : url.startsWith('wasm://') || /^wasm-function/.test(fn) ? 'other wasm (JIT blocks)'
        : /n64wasm\.js/.test(url) ? 'emscripten glue JS' : /index\.html/.test(url) ? 'page JS' : /netplay/.test(url) ? 'netplay.js'
        : 'other JS ' + url.split('/').pop().slice(0, 30);
      cats[cat] = (cats[cat] || 0) + d;
      const k = cat + ' :: ' + fn; fns[k] = (fns[k] || 0) + d;
    }
    // Who calls the heaviest leaf functions (two frames up the stack).
    const parent = new Map(); for (const n of prof.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
    const callers = {};
    for (let i = 0; i < prof.samples.length; i++) {
      const n = byId.get(prof.samples[i]); const fn = n.callFrame.functionName;
      if (fn !== 'readPixels' && fn !== 'bufferSubData') continue;
      const p1 = byId.get(parent.get(n.id)), p2 = p1 && byId.get(parent.get(p1.id));
      const k = fn + ' <- ' + (p1 ? p1.callFrame.functionName + '@' + (p1.callFrame.url || '').split('/').pop().slice(0, 30) + ':' + p1.callFrame.lineNumber : '?')
              + ' <- ' + (p2 ? p2.callFrame.functionName + '@' + (p2.callFrame.url || '').split('/').pop().slice(0, 30) + ':' + p2.callFrame.lineNumber : '?');
      callers[k] = (callers[k] || 0) + (prof.timeDeltas[i] || 0);
    }
    out.callers = Object.entries(callers).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => (100 * v / total).toFixed(1) + '% ' + k);
    out.profile = Object.fromEntries(Object.entries(cats).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, +(100 * v / total).toFixed(1)]));
    out.profileTop = Object.entries(fns).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => (100 * v / total).toFixed(1) + '% ' + k);
  }
  const tl = [];
  let prev = a;
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    const s = await snap();
    tl.push({ s: i + 1, rate: +((s.frame - prev.frame) / ((s.t - prev.t) / 1000) / (s.viHz || 50)).toFixed(3),
              stalls: s.stalls - prev.stalls, stallMs: s.stallMs - prev.stallMs, reanchors: s.reanchors - prev.reanchors,
              lostMs: (s.lostMs || 0) - (prev.lostMs || 0),
              delay: s.delay, u: (s.u || 0) - (prev.u || 0), b: s.b, ratio: s.ratio, speed: s.speed });
    prev = s;
  }
  const z = prev;
  const secs = (z.t - a.t) / 1000;
  Object.assign(out, {
    ghostDelayAtStart: await page.evaluate(() => window.__ghostDelay),
    roomRate: +((z.frame - a.frame) / secs / (z.viHz || 50)).toFixed(4),
    stalls: z.stalls - a.stalls, stallMs: z.stallMs - a.stallMs, reanchors: z.reanchors - a.reanchors,
    readPixels: { calls: (z.rpN || 0) - (a.rpN || 0), ms: Math.round((z.rpMs || 0) - (a.rpMs || 0)), bySize: z.rpBy },
    lostMs: (z.lostMs || 0) - (a.lostMs || 0), costOver: (z.costOver || 0) - (a.costOver || 0), costMaxMs: z.costMaxMs,
    selfCap: z.selfCap, costAvgMs: z.costAvgMs,
    audioUnderruns: (z.u || 0) - (a.u || 0), audioMissingEntries: (z.m || 0) - (a.m || 0),
    delayEnd: z.delay, delayHistory: z.dh, cap: z.cap, pace: z.pace, status: z.status, ghost: z.ghost, lsx: z.lsx,
    secsBelow99: tl.filter((x) => x.rate < 0.99).length,
  });
  out.timeline = tl;
} catch (e) { out.error = e.message; }
out.log = log.slice(-40);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
const brief = { ...out }; delete brief.timeline; delete brief.log; if (brief.ghost) delete brief.ghost.rep;
console.log(JSON.stringify(brief));
await browser.close().catch(() => {});
