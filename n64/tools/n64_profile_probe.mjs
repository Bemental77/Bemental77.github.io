#!/usr/bin/env node
// n64_profile_probe.mjs — WHERE DOES THE N64 PAGE SPEND ITS MAIN THREAD?
//
// One real core (mobile-emulated by default), CPU-throttled (default 4x — the
// stand-in for the user's Android phone: Mali-G715, Chrome, MK64, "cap 1.27x"),
// run past boot, then measured for --secs. Two instruments, never mixed:
//
//   LONG ANIMATION FRAMES (always): a PerformanceObserver for
//     'long-animation-frame' installed before any page script — the same
//     instrument as the user's phone report ("170 long animation frames, 11.5 s
//     blocking in 54 s; worst: 552 ms TimerHandler:setInterval, 439 ms
//     FrameRequestCallback, 323 ms RTCDataChannel.onmessage"). Reported: the
//     count, total blockingDuration, and the heaviest SCRIPTS by invoker
//     (TimerHandler:setInterval, FrameRequestCallback, …) with their source.
//   CPU PROFILE (unless --noprofile): self time bucketed by what it is — the
//     core wasm (n64wasm.wasm), the JIT's per-block modules, page JS, GC,
//     idle — so a long frame can be split into emulator and not-emulator.
//
// ⚠ A PROFILE IS NOT A SPEED MEASUREMENT (CLAUDE.md #10): the profiler loads
// the thread. Rates and LoAF totals are read from --noprofile runs; a profiled
// run is attribution only, and it says so in its output.
//
// --room lockstep|rollback : the page in a room, the way the phone was: a GHOST
//   peer (a real lib/netplay.js Lockstep in a Web Worker, no emulator, 1.000x
//   governor, --lat ms one-way each way) attached through __n64LsAttach, so the
//   feed, the governor, the party UI and the room's timers are the shipping
//   code. Without --room: solo, the core's own loop.
// The ROM is chosen by LABEL through the page's own picker (not ?game=, which
// before 2026-09-30 matched file names only and silently booted ROMS[0]).
//
// USAGE (npm run web first)
//   bash tools/probe_lock.sh run -- node n64/tools/n64_profile_probe.mjs [--cpu 4] [--desktop] [--secs 20]
//        [--room lockstep|rollback] [--lat 50] [--noprofile] [--url http://localhost:8080] [--query k=v]
import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const CPU = +flag('cpu', '4'), SECS = +flag('secs', '20'), WARM = +flag('warm', '15');
const BASE = flag('url', 'http://localhost:8080'), GAME = flag('game', 'Mario Kart 64'), QUERY = flag('query', '');
const ROOM = flag('room', ''), LAT = +flag('lat', '50');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GHOST_SRC = `
self.window = self;
importScripts('__ORIGIN__/lib/netplay.js');
let ls = null, cfg = null;
const qIn = [], qOut = []; let lastIn = 0, lastOut = 0;
const G = { base: 0, baseFrame: 0, frames: 0, period: 20 };
function enq(q, which, m) { const now = performance.now(); let at = now + cfg.lat;
  if (which === 'in') { at = Math.max(at, lastIn); lastIn = at; } else { at = Math.max(at, lastOut); lastOut = at; } q.push({ at, m }); }
function tick() {
  const now = performance.now();
  while (qIn.length && qIn[0].at <= now) ls.receive(qIn.shift().m);
  while (qOut.length && qOut[0].at <= now) postMessage({ t: 'm', m: qOut.shift().m });
  if (!ls || (ls.state !== 'running' && ls.state !== 'stalled')) return;
  let g = 0;
  while (g++ < 8) {
    if (!G.base) { G.base = now; G.baseFrame = G.frames; }
    const due = G.base + (G.frames - G.baseFrame) * G.period;
    if (now < due) break;
    if (now - due > G.period * 2) { G.base = now; G.baseFrame = G.frames; }
    // a pad that changes now and then, so a rollback room really rolls back
    const b = new Uint8Array(4); b[0] = ((ls.frame >> 4) & 1) ? 16 : 0; b[2] = (((ls.frame / 9) | 0) * 29 % 160 - 80) & 255;
    const r = ls.beginFrame(b);
    if (!r.ready) { if (r.reason === 'advantage') G.base += G.period; else G.base = 0; break; }
    ls.endFrame(null); if (ls.takeHashDue) ls.takeHashDue(); G.frames++;
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.t === 'init') {
    cfg = d.cfg; G.period = 1000 / cfg.viHz;
    ls = new Netplay.Lockstep({ host: false, peerId: 'ghost', portCount: 4, padBytes: 4, delay: cfg.delay, rollback: cfg.rollback,
      hashEvery: 0, stallBudgetMs: 600000, frameHz: cfg.viHz, send: (m) => enq(qOut, 'out', m) });
    ls.selfCap = 99;
    setInterval(tick, 1);
  } else if (d.t === 'm') enq(qIn, 'in', d.m);
  else if (d.t === 'ready') ls.declareReady('probe');
};`;

const browser = await puppeteer.launch({ headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { url: BASE, cpu: CPU, secs: SECS, mobile: !has('desktop'), room: ROOM || 'solo', lat: ROOM ? LAT : null, query: QUERY, profiled: !has('noprofile') };
try {
  const page = await browser.newPage({ type: 'window' });
  page.setDefaultTimeout(240000);
  if (!has('desktop')) await page.emulate({ userAgent: UA, viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } });
  else await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() => {
    window.__loaf = { on: false, n: 0, blocking: 0, dur: 0, worst: [], scripts: {} };
    try {
      new PerformanceObserver((list) => {
        const L = window.__loaf; if (!L.on) return;
        for (const e of list.getEntries()) {
          L.n++; L.blocking += e.blockingDuration || 0; L.dur += e.duration;
          const sc = (e.scripts || []).map((s) => ({ inv: s.invoker, type: s.invokerType, src: (s.sourceURL || '').split('/').pop().split('?')[0],
            fn: s.sourceFunctionName || '', dur: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration || 0) }));
          for (const s of sc) {
            const k = (s.type || '?') + ' ' + (s.inv || '?').slice(0, 60) + ' @' + s.src + (s.fn ? ':' + s.fn : '');
            const x = L.scripts[k] || (L.scripts[k] = { n: 0, ms: 0, max: 0 }); x.n++; x.ms += s.dur; if (s.dur > x.max) x.max = s.dur;
          }
          L.worst.push({ dur: Math.round(e.duration), blocking: Math.round(e.blockingDuration || 0), render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0), scripts: sc.slice(0, 4) });
          L.worst.sort((a, b) => b.dur - a.dur); if (L.worst.length > 12) L.worst.length = 12;
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
      window.__loaf.supported = true;
    } catch (e) { window.__loaf.supported = false; window.__loaf.err = String(e); }
    // AUDIO AT THE OUTPUT, the device matrix's own tap (tools/netplay_device_matrix.mjs):
    // everything connected to a context's destination also feeds a counter
    // worklet. A DROPOUT is an all-zero hole of <= 400 ms between audible audio.
    window.__atap = { q: 0, aud: 0, zero: 0, drop: 0, longS: 0 };
    try {
      const orig = AudioNode.prototype.connect, per = new WeakMap();
      const W = 'class T extends AudioWorkletProcessor{constructor(){super();this.q=0;this.aud=0;this.zero=0;this.cur=0;this.drop=0;this.longS=0;this.seen=false;this.n=0;}'
        + 'process(ins){const i=ins[0];let z=true;if(i&&i.length){for(let c=0;c<i.length&&z;c++){const ch=i[c];for(let k=0;k<ch.length;k++){if(ch[k]!==0){z=false;break;}}}}'
        + 'this.q++;if(z){this.zero++;if(this.seen)this.cur++;}else{this.aud++;this.seen=true;'
        + 'if(this.cur>0){const ms=this.cur*128*1000/sampleRate;if(ms<=400)this.drop++;else this.longS++;}this.cur=0;}'
        + 'if(++this.n>=100){this.n=0;this.port.postMessage({q:this.q,aud:this.aud,zero:this.zero,drop:this.drop,longS:this.longS});}return true;}}'
        + 'registerProcessor("pp-tap",T);';
      const url = URL.createObjectURL(new Blob([W], { type: 'application/javascript' }));
      const setup = (ctx) => {
        let st = per.get(ctx); if (st) return st;
        st = { col: ctx.createGain() }; per.set(ctx, st);
        ctx.audioWorklet.addModule(url).then(() => {
          const node = new AudioWorkletNode(ctx, 'pp-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          const mute = ctx.createGain(); mute.gain.value = 0;
          orig.call(st.col, node); orig.call(node, mute); orig.call(mute, ctx.destination);
          node.port.onmessage = (m) => { window.__atap = m.data; };
        }).catch(() => {});
        return st;
      };
      AudioNode.prototype.connect = function (dest) {
        try {
          const ctx = this.context;
          if (ctx && dest && dest === ctx.destination && ctx.audioWorklet) { const st = setup(ctx); if (this !== st.col) orig.call(this, st.col); }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    } catch (e) {}
  });
  await page.goto(`${BASE}/n64/?rbw=8${QUERY ? '&' + QUERY : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.getElementById('romSelect'), { timeout: 60000 });
  if (ROOM) {
    await page.waitForFunction(() => !!window.__n64LsAttach && !!window.Netplay, { timeout: 60000 });
    await page.evaluate((cfg, src) => {
      const w = new Worker(URL.createObjectURL(new Blob([src.replace('__ORIGIN__', location.origin)], { type: 'text/javascript' })));
      window.__ghost = w;
      const rb = cfg.room === 'rollback' ? 8 : 0;
      const d = rb ? 0 : Netplay.Lockstep.recommendDelay(2 * cfg.lat, 20);
      window.__n64LsAttach({ host: true, peerId: 'page', portCount: 4, padBytes: 4, delay: d, rollback: rb, hashEvery: 0, stallBudgetMs: 600000,
        send: (m) => w.postMessage({ t: 'm', m }), code: 'PROFL' });
      w.onmessage = (e) => { if (e.data.t === 'm') { window.__n64LsEngine.receive(e.data.m); if (e.data.m.t === 'ls' && window.__n64LsKick) window.__n64LsKick(); } };
      w.postMessage({ t: 'init', cfg: { delay: d, rollback: rb, lat: cfg.lat, viHz: 50 } });
      window.__n64LsEngine.seat('page', 1); window.__n64LsEngine.seat('ghost', 1);
    }, { room: ROOM, lat: LAT }, GHOST_SRC);
  }
  await page.evaluate((want) => {
    for (const id of ['romSelect', 'mobileRomSelect']) {
      const sel = document.getElementById(id); if (!sel) continue;
      for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent.trim() === want) { sel.value = sel.options[i].value; sel.dispatchEvent(new Event('change')); }
    }
  }, GAME);
  if (!has('desktop')) {
    const b = await page.evaluate(() => { const r = document.getElementById('mobileSplashStart').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.tap(b.x, b.y);
  } else await page.evaluate(() => document.getElementById('btnStart').click());
  if (ROOM) {
    await page.waitForFunction(() => { const n = window.__n64Net && window.__n64Net(); return n && n.armed && n.coreArmed; }, { timeout: 240000 });
    await page.evaluate(() => { window.__n64LsEngine.declareReady('probe'); window.__ghost.postMessage({ t: 'ready' }); });
    await page.waitForFunction(() => { const n = window.__n64Net(); return n.running && n.frame > 10; }, { timeout: 120000 });
  } else {
    await page.waitForFunction(() => window.__n64Rate && window.__n64Rate.speed > 0.2, { timeout: 240000 });
  }
  out.game = await page.evaluate(() => { const s = document.getElementById('romSelect'); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : null; });
  const cdp = await page.createCDPSession();
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await sleep(WARM * 1000);
  const rd = () => page.evaluate(() => {
    const n = window.__n64Net ? window.__n64Net() : null;
    return { t: performance.now(), vi: window.Module && Module._neil_vi_total ? Module._neil_vi_total() : 0,
      frame: n ? n.frame : null, viHz: n ? n.viHz : null, mode: n ? n.mode : null,
      r: window.__n64Rate ? { speed: window.__n64Rate.speed, hwX: window.__n64Rate.hwX, shown: window.__n64Rate.shown } : null,
      u: window.__audioDbg ? window.__audioDbg.u : null, tap: Object.assign({}, window.__atap),
      rb: n && n.rollback ? n.rollback.page : null, ra: n ? n.runahead : null,
      logChars: (document.getElementById('log') || {}).textContent ? document.getElementById('log').textContent.length : 0 };
  });
  const a = await rd();
  await page.evaluate(() => { window.__loaf.on = true; });
  if (!has('noprofile')) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  await sleep(SECS * 1000);
  let prof = null;
  if (!has('noprofile')) prof = (await cdp.send('Profiler.stop')).profile;
  await page.evaluate(() => { window.__loaf.on = false; });
  const b = await rd();
  const secs = (b.t - a.t) / 1000;
  out.fields = b.vi - a.vi; out.fieldsPerSec = +(out.fields / secs).toFixed(2);
  out.speedVI50 = +(out.fields / secs / 50).toFixed(4);
  if (ROOM) { out.mode = b.mode; out.roomRate = +((b.frame - a.frame) / secs / (b.viHz || 50)).toFixed(4); out.rollback = b.rb; out.runahead = b.ra; }
  out.rateEnd = b.r; out.audioUnderruns = (b.u != null && a.u != null) ? b.u - a.u : null; out.logChars = b.logChars;
  out.audio = { dropouts: b.tap.drop - a.tap.drop, perMin: +((b.tap.drop - a.tap.drop) / secs * 60).toFixed(1), longSilences: b.tap.longS - a.tap.longS,
    quanta: b.tap.q - a.tap.q, audibleShare: (b.tap.q - a.tap.q) ? +((b.tap.aud - a.tap.aud) / (b.tap.q - a.tap.q)).toFixed(3) : null };
  const L = await page.evaluate(() => JSON.parse(JSON.stringify(window.__loaf)));
  out.loaf = { supported: L.supported, count: L.n, perMin: +(L.n / secs * 60).toFixed(1), blockingMs: Math.round(L.blocking), blockingPerMin: Math.round(L.blocking / secs * 60),
    top: Object.entries(L.scripts).sort((x, y) => y[1].ms - x[1].ms).slice(0, 10).map(([k, v]) => `${v.ms}ms n=${v.n} max=${v.max}  ${k}`),
    worst: L.worst.slice(0, 6) };
  if (prof) {
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const dts = prof.timeDeltas; let total = 0;
    for (let i = 0; i < prof.samples.length; i++) { const d = dts[i] || 0; total += d; self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + d); }
    const cats = {}, fns = {};
    for (const [id, us] of self) {
      const n = byId.get(id), cf = n.callFrame, url = cf.url || '', fn = cf.functionName || '(anon)';
      let cat;
      if (fn === '(idle)') cat = 'idle';
      else if (fn === '(garbage collector)') cat = 'gc';
      else if (fn === '(program)') cat = 'program(browser/native)';
      else if (/n64wasm\.wasm/.test(url)) cat = 'core wasm';
      else if (/^wasm-function/.test(fn) || url.startsWith('wasm://')) cat = 'wasm (JIT blocks)';
      else if (/mips_emit/.test(url)) cat = 'JIT emitter JS';
      else if (/n64wasm\.js/.test(url)) cat = 'emscripten glue JS (GL/SDL/audio)';
      else if (/index\.html/.test(url)) cat = 'page JS';
      else if (/netplay/.test(url)) cat = 'netplay.js';
      else cat = 'other JS (' + (url.split('/').pop() || '?') + ')';
      cats[cat] = (cats[cat] || 0) + us;
      const key = cat + ' :: ' + fn + (url ? ' @' + url.split('/').pop().slice(0, 40) + ':' + cf.lineNumber : '');
      fns[key] = (fns[key] || 0) + us;
    }
    const pct = (x) => +(100 * x / total).toFixed(1);
    out.categories = Object.fromEntries(Object.entries(cats).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, pct(v) + '%']));
    out.top = Object.entries(fns).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => pct(v) + '%  ' + k);
    out.msPerSec = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, +((v / 1000) / secs).toFixed(1)]));
    out.NOTE = 'profiled run: attribution only, rates are not results (CLAUDE.md #10)';
  }
} catch (e) { out.error = e.message; }
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close().catch(() => {});
