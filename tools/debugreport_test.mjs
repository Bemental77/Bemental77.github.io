#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/debugreport_test.mjs — node test for lib/debugreport.js ("📋 Copy debug").
//
// No browser and no jsdom: the lib runs in a vm context against a small fake DOM
// built here, so this runs anywhere `node` does (CI included).
//
// What a PASS means:
//   1. LOADING COSTS NOTHING PER FRAME: after the script runs and
//      DOMContentLoaded fires, zero setTimeout / setInterval /
//      requestAnimationFrame / PerformanceObserver / MutationObserver have been
//      created. Only the error listeners exist. (Pressing the button may use all
//      of them; that is asserted too, so the counter is known to work.)
//   2. The button lands in the page's toolbar AND its mobile menu (and splash,
//      and the room panel where that panel covers the page), at the spot named
//      for each of the 8 pages — never anywhere else.
//   3. collect() carries every section header.
//   4. It SURVIVES EVERY ACCESSOR THROWING: navigator, screen, the Netplay
//      global, every page seam, document methods, performance.now — the report
//      still comes back with every section and "n/a" in place of the values.
//   5. Errors and unhandled rejections are captured (last 50 kept).
//   6. Peer ids never leave the device (16-hex nonces become P1/P2 seats) and
//      TURN credentials in the URL / ICE config are redacted.
//   7. copy(): the ClipboardItem route is started SYNCHRONOUSLY inside the call
//      (Safari's rule), writeText is the next fallback, and with no clipboard at
//      all the text lands in a selectable overlay.
//   8. AudioContexts constructed after load are captured (the Proxy keeps
//      `new`, instanceof and subclassing intact).
//   9. ?debugreport=0 installs nothing at all.
//
// Run: node tools/debugreport_test.mjs      exit 0 = all pass
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib/debugreport.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + String(extra).slice(0, 600) : '')); }
}

// ---- a very small DOM --------------------------------------------------------
class El {
  constructor(tag, attrs, kids) {
    this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName; this.nodeType = 1;
    this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.style = { cssText: '' }; this._text = ''; this.value = ''; this.id = ''; this.className = '';
    for (const k in (attrs || {})) this.setAttribute(k, attrs[k]);
    for (const c of (kids || [])) this.appendChild(c);
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  get src() { return this.attrs.src || ''; }
  setAttribute(k, v) {
    v = String(v); this.attrs[k] = v;
    if (k === 'id') this.id = v;
    if (k === 'class') this.className = v;
  }
  getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  fire(t, ev) { for (const f of (this.listeners[t] || [])) f(Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, ev || {})); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; }
  get previousSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) - 1] || null; }
  focus() {} blur() {} select() {} setSelectionRange() {}
  click() { this.fire('click'); }
  getContext() { return null; }
  getBoundingClientRect() { return { width: 0, height: 0 }; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && matches(n, sel)) out.push(n); }); return out; }
}
function walk(n, f) { f(n); for (const c of n.children) walk(c, f); }
// Compound selectors: tag, #id, .class, [attr], [attr="v"], joined by ' ' or '>'.
function parseCompound(s) {
  const m = { tag: null, id: null, cls: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let x;
  while ((x = re.exec(s))) {
    if (x[1]) m.tag = x[1].toUpperCase();
    else if (x[2]) m.id = x[2];
    else if (x[3]) m.cls.push(x[3]);
    else if (x[4]) m.attrs.push([x[4], x[5]]);
  }
  return m;
}
function matchOne(n, c) {
  if (c.tag && n.tagName !== c.tag) return false;
  if (c.id && n.id !== c.id) return false;
  for (const k of c.cls) if ((' ' + n.className + ' ').indexOf(' ' + k + ' ') < 0) return false;
  for (const [a, v] of c.attrs) { const got = n.getAttribute(a); if (got === null || (v !== undefined && got !== v)) return false; }
  return true;
}
function matches(n, sel) {
  return sel.split(',').some((one) => {
    const toks = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    // right-to-left
    let i = toks.length - 1;
    if (!matchOne(n, parseCompound(toks[i]))) return false;
    let cur = n;
    i--;
    while (i >= 0) {
      if (toks[i] === '>') {
        i--; cur = cur.parentNode;
        if (!cur || !cur.tagName || !matchOne(cur, parseCompound(toks[i]))) return false;
        i--;
      } else {
        const c = parseCompound(toks[i]);
        cur = cur.parentNode;
        while (cur && cur.tagName && !matchOne(cur, c)) cur = cur.parentNode;
        if (!cur || !cur.tagName) return false;
        i--;
      }
    }
    return true;
  });
}
const h = (tag, attrs, ...kids) => new El(tag, attrs, kids);

// Each page's containers, trimmed to the spots the lib is told to use.
const netOverlay = () => h('div', { id: 'netOverlay' }, h('div', { id: 'netBox' },
  h('div', { class: 'netActions' }, h('button', { id: 'netCopy' })),
  h('div', { class: 'netActions' }, h('button', { id: 'netLeave' }), h('button', { id: 'netClose' }))));
function pageDom(page) {
  const log = h('pre', { id: 'log' }); log.textContent = 'line one\n[gl] WebGL2 = yes  gpu=Fake / FakeGPU\nline three\n';
  const status = h('span', { id: 'status' }); status.textContent = 'Running.';
  const fps = h('span', { id: 'fps' }); fps.textContent = 'guest 60.0/s (1.00x hardware) · presented 60/s';
  const bar = (...k) => h('div', { id: 'controlBar' }, h('button', { id: 'btnStart' }), ...k);
  const menu = (...k) => h('div', { id: 'mobileMenu' }, h('div', { id: 'mobileMenuBox' }, h('button', { id: 'mSave' }), ...k, h('button', { id: 'mClose' })));
  const shell = (...k) => h('div', { id: 'mobileShell' }, h('div', { id: 'mobileStatus' }), ...k);
  switch (page) {
    case 'n64': case 'dreamcast':
      return [h('div', { id: 'desktop' }, bar(h('button', { id: 'btnLog' }), h('button', { id: 'btnDiag' }), h('button', { id: 'btnNet' })),
        h('div', { id: 'statusBar' }, status, fps), log, h('div', { id: 'fpsBar' })),
        shell(h('div', { id: 'mobileSplash' }, h('button', { id: 'mobileSplashStart' }), h('button', { id: 'mobileSplashDiag' }), h('button', { id: 'mobileSplashNet' })),
          menu(h('button', { id: 'mDiag' }), h('button', { id: 'mFull' }))), ...(page === 'dreamcast' ? [netOverlay()] : [])];
    case 'gamecube': case 'ps1':
      return [h('div', { id: 'desktop' }, bar(h('button', { id: 'btnLog' }), h('button', { id: 'btnDiag' }), h('button', { id: 'btnMute' })),
        h('div', { id: 'statusBar' }, status, fps), log),
        shell(h('div', { id: 'mobileSplash' }, h('button', { id: 'mobileSplashStart' }), h('p', { class: 'rotateTip' })), menu()),
        page === 'ps1' ? netOverlay() : h('div', { class: 'np-wrap' }, h('div', { class: 'np-card' }, h('div', { class: 'np-act' }, h('button', { class: 'ghost' }))))];
    case 'genesis': case 'snes':
      return [h('div', { id: 'desktop' }, bar(h('button', { id: 'btnNet' })), h('div', { id: 'statusBar' }, status, fps)),
        shell(h('div', { id: 'mobileSplash' }, h('button', { id: 'mobileSplashStart' }), h('button', { id: 'mobileSplashNet' })), menu()), netOverlay()];
    case 'gba':
      return [h('div', { id: 'maindiv' }, h('div', { id: 'mydiv', class: 'mt-4' })),
        h('div', { id: 'spMenuOverlay' }, h('div', { class: 'sp-overlay-box' }, h('button', { class: 'btn' }), h('hr'), h('button', { class: 'btn' })))];
    case 'multiplayer':
      return [h('div', { id: 'wrap' }, h('p', { class: 'hint' }), h('div', { class: 'card' }, h('p', { class: 'hint' })), h('p', { class: 'hint' }, h('a', { href: '/playground.html' })))];
    default: return [];
  }
}
const PAGE_PATH = { n64: '/n64/index.html', dreamcast: '/dreamcast.html', gamecube: '/gamecube.html', ps1: '/ps1.html',
  genesis: '/genesis.html', snes: '/snes.html', gba: '/gba.html', multiplayer: '/multiplayer.html' };

// ---- a sandbox window that counts every scheduling primitive ---------------
function makeWindow(opts) {
  opts = opts || {};
  const page = opts.page || 'n64';
  const counts = { setTimeout: 0, setInterval: 0, rAF: 0, PerformanceObserver: 0, MutationObserver: 0 };
  let clock = 1000;
  const body = h('body', {}, h('script', { src: 'http://localhost:8080/lib/debugreport.js?v=abc' }), ...pageDom(page));
  const docEl = h('html', {}, body);
  const docListeners = {};
  const doc = {
    readyState: opts.readyState || 'loading',
    body, documentElement: docEl, title: 'Fake ' + page, visibilityState: 'visible', activeElement: body,
    fullscreenElement: null,
    hasFocus: () => true,
    getElementById: (id) => { let r = null; walk(docEl, (n) => { if (!r && n.id === id) r = n; }); return r; },
    querySelector: (s) => docEl.querySelector(s),
    querySelectorAll: (s) => docEl.querySelectorAll(s),
    createElement: (t) => new El(t),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener() {},
    execCommand: opts.execCommand || (() => false),
    _fire: (t) => { for (const f of (docListeners[t] || [])) f({ type: t }); },
  };
  const winListeners = {};
  const conCalls = [];
  const fakeConsole = {
    log: (...a) => conCalls.push(['log', a]), info: (...a) => conCalls.push(['info', a]),
    warn: (...a) => conCalls.push(['warn', a]), error: (...a) => conCalls.push(['error', a]), debug: () => {},
  };
  const w = {
    document: doc,
    location: { pathname: PAGE_PATH[page] || '/' + page + '.html', search: opts.search || '',
      href: 'http://localhost:8080' + (PAGE_PATH[page] || '/' + page + '.html') + (opts.search || ''), origin: 'http://localhost:8080' },
    navigator: opts.navigator || { userAgent: 'FakeUA/1.0', platform: 'FakeOS', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      language: 'en', onLine: true, clipboard: opts.clipboard },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24 },
    devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720, crossOriginIsolated: true, isSecureContext: true,
    console: fakeConsole,
    performance: { now: () => clock },
    URLSearchParams, URL, Blob, Intl,
    getComputedStyle: () => ({ display: page === 'gba' || page === 'multiplayer' ? 'none' : 'none' }),
    matchMedia: () => ({ matches: false }),
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    removeEventListener() {},
    setTimeout: (f, ms) => { counts.setTimeout++; return setTimeout(f, Math.min(ms || 0, 50)); },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => { counts.setInterval++; return setInterval(f, ms); },
    requestAnimationFrame: (cb) => { counts.rAF++; setImmediate(() => { clock += 16.667; cb(clock); }); return counts.rAF; },
    PerformanceObserver: class { constructor() { counts.PerformanceObserver++; } observe() {} disconnect() {} takeRecords() { return []; } },
    MutationObserver: class { constructor() { counts.MutationObserver++; } observe() {} disconnect() {} },
  };
  w.PerformanceObserver.supportedEntryTypes = ['long-animation-frame', 'event', 'longtask'];
  w.window = w;
  if (opts.extra) opts.extra(w);
  const ctx = vm.createContext(w);
  vm.runInContext(SRC, ctx, { filename: 'lib/debugreport.js' });
  if (doc.readyState === 'loading') { doc.readyState = 'interactive'; doc._fire('DOMContentLoaded'); }
  return { w, doc, counts, winListeners, conCalls, tick: (ms) => { clock += ms; } };
}
const SECTIONS = ['## PAGE', '## DEVICE', '## DISPLAY', '## GPU', '## CAPABILITY', '## RATE', '## NETPLAY', '## AUDIO',
  '## INPUT', '## MAIN THREAD', '## PAGE SEAMS', '## ERRORS', '## PAGE LOG', '## CONSOLE', '===== END ====='];
const missing = (text) => SECTIONS.filter((s) => text.indexOf(s) < 0);
const zero = (c) => Object.values(c).every((v) => v === 0);

// ---- 1 + 2: load cost and button placement, every page -------------------
const WHERE = {
  n64: [['bar', 'controlBar', 'btnDiag', 'after'], ['menu', 'mobileMenuBox', 'mDiag', 'after'], ['splash', 'mobileSplash', 'mobileSplashDiag', 'after']],
  dreamcast: [['bar', 'controlBar', 'btnDiag', 'after'], ['menu', 'mobileMenuBox', 'mDiag', 'after'], ['splash', 'mobileSplash', 'mobileSplashDiag', 'after'], ['party', '', 'netClose', 'before']],
  gamecube: [['bar', 'controlBar', 'btnDiag', 'after'], ['menu', 'mobileMenuBox', 'mClose', 'before'], ['splash', 'mobileSplash', 'mobileSplashStart', 'after'], ['party', '', null, 'np-act']],
  ps1: [['bar', 'controlBar', 'btnLog', 'after'], ['menu', 'mobileMenuBox', 'mClose', 'before'], ['splash', 'mobileSplash', 'mobileSplashStart', 'after'], ['party', '', 'netClose', 'before']],
  genesis: [['bar', 'controlBar', null, 'last'], ['menu', 'mobileMenuBox', 'mClose', 'before'], ['splash', 'mobileSplash', 'mobileSplashNet', 'after'], ['party', '', 'netClose', 'before']],
  snes: [['bar', 'statusBar', null, 'last'], ['menu', 'mobileMenuBox', 'mClose', 'before'], ['splash', 'mobileSplash', 'mobileSplashNet', 'after'], ['party', '', 'netClose', 'before']],
  gba: [['bar', 'mydiv', null, 'last'], ['menu', null, null, 'before-hr']],
  multiplayer: [['bar', 'wrap', null, 'footer']],
};
console.log('1. loading installs nothing that runs per frame; 2. button placement');
for (const page of Object.keys(WHERE)) {
  const env = makeWindow({ page });
  ok(zero(env.counts), `${page}: no timer / rAF / observer after load + DOMContentLoaded`, JSON.stringify(env.counts));
  ok((env.winListeners.error || []).length === 1 && (env.winListeners.unhandledrejection || []).length === 1,
    `${page}: exactly the error + unhandledrejection listeners are installed`);
  const btns = env.doc.querySelectorAll('button.debugReportBtn');
  ok(btns.length === WHERE[page].length, `${page}: ${WHERE[page].length} button(s) injected`, 'got ' + btns.length);
  for (const [spot, parentId, anchorId, how] of WHERE[page]) {
    const b = env.doc.querySelector(`[data-debugreport="${spot}"]`);
    let good = !!b;
    if (b && how === 'after') good = b.parentNode.id === parentId && b.previousSibling && b.previousSibling.id === anchorId;
    if (b && how === 'before') good = b.parentNode.id === parentId && b.nextSibling && b.nextSibling.id === anchorId;
    if (b && how === 'last') good = b.parentNode.id === parentId && !b.nextSibling;
    if (b && how === 'before-hr') good = b.nextSibling && b.nextSibling.tagName === 'HR' && b.parentNode.className === 'sp-overlay-box';
    if (b && how === 'np-act') good = b.parentNode.className === 'np-act' && !b.nextSibling && /ghost/.test(b.className);
    if (b && how === 'footer') good = b.parentNode.tagName === 'P' && b.parentNode.parentNode.id === 'wrap' && !b.parentNode.nextSibling;
    ok(good, `${page}: ${spot} button at ${how} ${anchorId || parentId || 'hr'}`, b ? 'parent=' + b.parentNode.id + ' prev=' + (b.previousSibling && b.previousSibling.id) : 'absent');
  }
  // re-running inject() must not duplicate
  env.w.DebugReport.inject();
  ok(env.doc.querySelectorAll('button.debugReportBtn').length === WHERE[page].length, `${page}: inject() is idempotent`);
  ok(zero(env.counts), `${page}: still no timers after inject() + collect()`, JSON.stringify(env.counts));
}

// ---- 3: sections -------------------------------------------------------------
console.log('3. collect() has every section');
{
  const env = makeWindow({ page: 'n64' });
  const t = env.w.DebugReport.collect();
  ok(missing(t).length === 0, 'every section header present', 'missing: ' + missing(t).join(', '));
  ok(/refresh: not measured/.test(t), 'without a press the refresh says "not measured", not a number');
  ok(t.indexOf('[gl] WebGL2 = yes') >= 0 && t.indexOf('line three') >= 0, 'PAGE LOG carries the #log tail');
  ok(zero(env.counts), 'collect() itself schedules nothing', JSON.stringify(env.counts));
}

// ---- 4: every accessor throwing -------------------------------------------------
console.log('4. survives every accessor throwing');
{
  const boom = (what) => () => { throw new Error('boom:' + what); };
  const env = makeWindow({
    page: 'n64', readyState: 'complete',
    extra: (w) => {
      const thrower = new Proxy({}, { get: (t, k) => { throw new Error('nav.' + String(k)); } });
      for (const k of ['navigator', 'screen', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'crossOriginIsolated', 'isSecureContext',
        'Netplay', 'Capability', '__cap', 'AudioDiag', '__audioDiag', 'XboxInput', 'Module', 'myApp', '__n64Rate', 'N64Rate',
        '__audioDbg', 'visualViewport', 'Intl', 'getComputedStyle', 'matchMedia']) {
        Object.defineProperty(w, k, { get: boom(k), configurable: true });
      }
      for (const k of ['__n64Net', '__n64Pace', '__jitStats', '__dcProbe', '__dcNet', '__gcLockstep', '__ps1Net', '__genNet', '__snesNet', '__gbaNet', '__mp']) {
        w[k] = boom(k);
      }
      w.document.getElementById = boom('getElementById');
      w.document.querySelectorAll = boom('querySelectorAll');
      w.document.querySelector = boom('querySelector');
      w.document.createElement = boom('createElement');
      Object.defineProperty(w.document, 'visibilityState', { get: boom('visibilityState') });
      w.document.hasFocus = boom('hasFocus');
      w.performance = { now: boom('now') };
      void thrower;
    },
  });
  let t = null, err = null;
  try { t = env.w.DebugReport.collect(); } catch (e) { err = e; }
  ok(!err && typeof t === 'string', 'collect() returns a string', err && err.stack);
  ok(t && missing(t).length === 0, 'every section header still present', t && missing(t).join(', '));
  ok(t && (t.match(/n\/a/g) || []).length > 20, 'throwing accessors read as n/a', t && (t.match(/n\/a/g) || []).length);
  ok(t && /boom:__n64Net/.test(t), 'a throwing seam is named in the report, not swallowed');
  // a hostile Netplay session object
  const env2 = makeWindow({
    page: 'dreamcast',
    extra: (w) => {
      const s = {};
      for (const k of ['state', 'isHost', 'code', 'transport', 'game', 'portCount', 'maxPeers', 'lastError', '_links', '_nonce']) Object.defineProperty(s, k, { get: boom(k) });
      s.roomInfo = boom('roomInfo'); s.admission = boom('admission');
      s.ls = { report: boom('report'), paceReport: boom('paceReport'), rollbackReport: boom('rb'), get roster() { throw new Error('roster'); } };
      w.Netplay = { sessions: [s], supported: boom('supported'), iceConfig: boom('ice'), signalPlan: boom('plan'), signalBrokers: boom('brokers') };
    },
  });
  let t2 = null, err2 = null;
  try { t2 = env2.w.DebugReport.collect(); } catch (e) { err2 = e; }
  ok(!err2 && t2 && missing(t2).length === 0, 'a session whose every field throws still yields every section', err2 && err2.stack);
  let r3 = null, err3 = null;
  try { r3 = await env2.w.DebugReport.collectAsync(); } catch (e) { err3 = e; }
  ok(!err3 && r3 && missing(r3).length === 0, 'collectAsync() on the hostile session resolves with every section', err3 && err3.stack);
}

// ---- 5: errors ------------------------------------------------------------------
console.log('5. errors and rejections are captured');
{
  const env = makeWindow({ page: 'snes' });
  const [onErr] = env.winListeners.error, [onRej] = env.winListeners.unhandledrejection;
  onErr({ message: 'Uncaught TypeError: x is not a function', filename: 'http://localhost:8080/snes.html', lineno: 12, colno: 7,
    error: { stack: 'TypeError: x\n    at f (snes.html:12:7)' }, target: env.w });
  onRej({ reason: Object.assign(new Error('fetch failed'), { name: 'TypeError' }) });
  onErr({ target: new El('script', { src: 'http://localhost:8080/snes/core.js' }) });
  let t = env.w.DebugReport.collect();
  ok(/\[error\] Uncaught TypeError: x is not a function @ \/snes\.html:12:7/.test(t), 'window error with file:line:col');
  ok(/\[unhandledrejection\] TypeError: fetch failed/.test(t), 'unhandled rejection');
  ok(/\[resource\] failed to load <script> \/snes\/core\.js/.test(t), 'resource load failure');
  for (let i = 0; i < 60; i++) onErr({ message: 'e' + i, filename: '', lineno: 0, colno: 0, target: env.w });
  t = env.w.DebugReport.collect();
  ok(/63 captured since load \(last 50 shown\)/.test(t) && !/\] e9 @/.test(t) && /\] e59 @/.test(t), 'only the last 50 are kept, total still counted');
}

// ---- 6: console ring, peer scrubbing, redaction ----------------------------------
console.log('6. console ring, peer ids, credentials');
{
  const A = 'a1b2c3d4e5f60718', B = '0123456789abcdef', C = 'ffffeeeeddddcccc';
  const env = makeWindow({
    page: 'genesis', search: '?np=ABCDE&turn=turn:relay.example:3478|alice|hunter2&host=1',
    extra: (w) => {
      w.__genLogLines = ['[net] host signalling', '[lockstep] FRAME GATE ENGAGED at frame 0 — delay=3'];
      const ls = {
        peerId: A, roster: [A, B, C, null], frame: 1234, delay: 3, localPorts: [0], selfCap: 4.2, rttMs: 38,
        report: () => ({ state: 'running', frame: 1234, delay: 3, portCount: 4, localPorts: [0], rollback: null, alone: false,
          delayHistory: [{ t: 1, frame: 10, from: 2, to: 3, why: 'stall' }], stalls: 7, stallMs: 420, maxStallMs: 90,
          stallByPort: { 1: 300, 2: 120 }, ports: [{ port: 0, peer: A }, { port: 1, peer: B }], inputsSent: 99, inputsReceived: 98 }),
        paceReport: () => ({ self: { ports: [0], share: 0.01, lost: 0.02, cap: 4.2, rtt: 38, waitOn: { 1: 0.05 } },
          peers: [{ peer: B, ports: [1], share: 0.3, lost: 0.4, cap: 0.93, rtt: 41, waitOn: {}, frames: 55, w: 1000, ageMs: 200 },
                  { peer: C, ports: [2], share: 0.2, lost: 0.1, cap: 1.8, rtt: 77, waitOn: { 1: 0.2 }, frames: 58, w: 1000, ageMs: 300 }] }),
      };
      const s = { state: 'connected', isHost: true, code: 'ABCDE', transport: 'peerjs', game: 'sonic2', portCount: 4, maxPeers: 3, lastError: null,
        ls, _links: new Map(), admission: () => ({ open: true }),
        roomInfo: () => ({ code: 'ABCDE', host: true, me: A, portCount: 4, links: 2, full: false, state: 'running', started: true, relay: null,
          seats: [{ port: 0, peer: A, local: true, load: 100, ready: true, dropped: null }, { port: 1, peer: B, local: false, load: 100, ready: true, dropped: null },
                  { port: 2, peer: C, local: false, load: 100, ready: true, dropped: null }, { port: 3, peer: null, local: false, load: null, ready: false, dropped: null }] }) };
      w.Netplay = { PROTO: 2, sessions: [s], supported: () => true, signalPlan: () => ['ws', 'peerjs'], signalBrokers: () => ['wss://b'],
        iceConfig: () => [{ urls: 'stun:stun.example:19302' }, { urls: 'turn:relay.example:3478', username: 'alice', credential: 'hunter3' }] };
    },
  });
  env.w.console.log('[genesis] core says hi', { a: 1 });
  env.w.console.warn('%cstyled', 'color:red', 'tail');
  env.w.console.log('[lockstep] FRAME GATE ENGAGED at frame 0 — delay=3');   // already in the page log
  ok(env.conCalls.length === 3, 'the original console is still called');
  const t = env.w.DebugReport.collect();
  ok(/\[genesis\] core says hi \{"a":1\}/.test(t), 'console lines land in CONSOLE');
  ok(/\[warn\] styled tail/.test(t), '%c markers and their CSS are dropped');
  ok((t.match(/FRAME GATE ENGAGED/g) || []).length === 1, 'a console line already in PAGE LOG is not repeated');
  ok(t.indexOf(A) < 0 && t.indexOf(B) < 0 && t.indexOf(C) < 0, 'no raw peer id anywhere in the report');
  ok(/seat P1\(host\)\(me\): this console/.test(t) && /seat P2: remote load=100%/.test(t) && /seat P4: empty/.test(t), 'every seat named by port');
  ok(/mySeat=P1/.test(t) && /code=ABCDE/.test(t) && /role=host/.test(t), 'room code, role and my seat');
  ok(/delay=3f/.test(t) && /delay history \(newest last\): \[\{"t":1,"frame":10,"from":2,"to":3,"why":"stall"\}\]/.test(t), 'delay + delay history');
  ok(/stall ms by port: \{"1":300,"2":120\}/.test(t), 'stalls by port');
  ok(/pace peer \[1\] \(P2\): stalledShare=0\.3 lost=0\.4 cap=0\.93x rtt=41ms/.test(t), "each peer's cap and rtt, peer shown as its seat");
  ok(/pace self \[0\]: stalledShare=0\.01 lost=0\.02 cap=4\.2x rtt=38ms/.test(t), 'this console\'s own cap');
  ok(t.indexOf('hunter2') < 0 && t.indexOf('hunter3') < 0 && t.indexOf('alice') < 0, 'TURN credentials redacted (URL and iceConfig)');
  ok(/np=ABCDE/.test(t) && /turn=%5Bredacted%5D|turn=\[redacted\]/.test(t), 'the rest of the URL survives, the secret param is marked redacted');
  ok(/\[credentials redacted\]/.test(t), 'ICE line says credentials were present and redacted');
}

// ---- 7: copy routes ------------------------------------------------------------
console.log('7. copy(): measured, and the clipboard routes');
{
  // (a) writeText route, with a real 1 s (fake-clock) measurement
  let written = null;
  const env = makeWindow({
    page: 'n64', clipboard: { writeText: (s) => { written = s; return Promise.resolve(); } },
    extra: (w) => {
      w.__n64Rate = { viHz: 60, speed: 1, speedFrom: 'audio' };
      w.Module = { _neil_vi_total: () => Math.floor(w.performance.now() / (1000 / 60)) };
    },
  });
  ok(zero(env.counts), 'before the press: nothing scheduled');
  const btn = env.doc.querySelector('[data-debugreport="bar"]');
  const p = env.w.DebugReport.copy(btn);
  ok(btn.textContent.indexOf('Measuring') >= 0, 'the button says it is measuring');
  const r = await p;
  ok(r.ok && r.how === 'clipboard.writeText' && written === r.text, 'writeText route copies the finished report', r.how);
  ok(/refresh: measured 60\.0 Hz/.test(r.text), 'measured display refresh from the rAF sample', (r.text.match(/refresh:.*/) || [])[0]);
  ok(/counter core VI \(Module\._neil_vi_total\): \+\d+ in 1\.0\d\d s = (59|60)\.\d\d\/s = (0\.99\d|1\.0\d\d)x of 60(\.0+)? Hz hardware/.test(r.text),
    'page frame counter sampled across the same second', (r.text.match(/counter core VI.*/) || [])[0]);
  ok(env.counts.rAF > 30 && env.counts.PerformanceObserver === 3, 'the press is what schedules the sample (counter proven live)', JSON.stringify(env.counts));
  ok(missing(r.text).length === 0, 'the copied report has every section');

  // (b) ClipboardItem route must be STARTED synchronously inside copy()
  let calledSync = false, itemText = null;
  const env2 = makeWindow({
    page: 'dreamcast',
    clipboard: { write: (items) => { calledSync = true; return items[0].types['text/plain'].then((b) => b.text()).then((s) => { itemText = s; }); },
                 writeText: () => Promise.reject(new Error('should not be needed')) },
    extra: (w) => { w.ClipboardItem = class { constructor(o) { this.types = o; } }; },
  });
  const p2 = env2.w.DebugReport.copy(null);
  ok(calledSync === true, 'clipboard.write() is called before copy() returns (Safari keeps the gesture)');
  const r2 = await p2;
  ok(r2.ok && r2.how === 'clipboard.write' && itemText === r2.text, 'ClipboardItem route delivers the finished text', r2.how);

  // (c) nothing works: overlay with the text, selectable
  const env3 = makeWindow({ page: 'ps1', clipboard: undefined, execCommand: () => false });
  const r3 = await env3.w.DebugReport.copy(null);
  const ov = env3.doc.getElementById('debugReportOverlay');
  const ta = ov && ov.querySelector('[data-debugreport="text"]');
  ok(r3.how === 'overlay' && !!ov && ta && ta.value === r3.text, 'no clipboard at all → the text is shown in an overlay', r3.how);
  ok(ov && /user-select:text/.test(ov.style.cssText), 'the overlay text is selectable (the touch shells set user-select:none)');
  ok(env3.w.DebugReport.lastText === r3.text, 'DebugReport.lastText holds the last report');

  // (d) execCommand fallback
  let execd = 0;
  const env4 = makeWindow({ page: 'gba', clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) }, execCommand: () => { execd++; return true; } });
  const r4 = await env4.w.DebugReport.copy(null);
  ok(r4.ok && r4.how === 'execCommand' && execd === 1, 'writeText refused → textarea + execCommand', r4.how);
}

// ---- 8: AudioContext capture -----------------------------------------------------
console.log('8. AudioContext capture');
{
  class FakeAC { constructor(o) { this.state = 'running'; this.sampleRate = (o && o.sampleRate) || 48000; this.baseLatency = 0.0106; this.outputLatency = 0.0423; this.currentTime = 12.5; } }
  const env = makeWindow({ page: 'snes', extra: (w) => { w.AudioContext = FakeAC; w.webkitAudioContext = FakeAC; } });
  const AC = env.w.AudioContext;
  ok(AC !== FakeAC && env.w.webkitAudioContext === AC, 'the constructor is wrapped once, both names share it');
  const c = new AC({ sampleRate: 36000, latencyHint: 'playback' });
  ok(c instanceof FakeAC && c.sampleRate === 36000, '`new` and instanceof are unchanged');
  class Sub extends AC { hello() { return 1; } }
  const sc = new Sub();
  ok(sc instanceof Sub && sc.hello() === 1, 'subclassing still works');
  const t = env.w.DebugReport.collect();
  ok(/ctx\[0\].*state=running sampleRate=36000 baseLatency=10\.6ms outputLatency=42\.3ms/.test(t), 'the report carries the context state and latencies');
  ok(zero(env.counts), 'constructing contexts schedules nothing');
}

// ---- 9: kill switch ----------------------------------------------------------------
console.log('9. ?debugreport=0');
{
  const env = makeWindow({ page: 'n64', search: '?debugreport=0' });
  ok(!env.w.DebugReport && !env.winListeners.error && env.doc.querySelectorAll('button.debugReportBtn').length === 0,
    'no API, no listeners, no button');
  env.w.console.log('x');
  ok(env.conCalls.length === 1 && !env.w.console.log.__debugreport, 'console left untouched');
}

console.log(`\n[debugreport] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
