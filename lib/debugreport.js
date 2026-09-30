/*
 * lib/debugreport.js — "📋 Copy debug": ONE plain-text report a player can paste
 * to the developer after a bad session (a slow room, input lag, audio cutting
 * out, a black screen), from any emulator page, on a desktop or a phone.
 *
 * WHAT IT COSTS — this file must never be the reason a room is slow.
 *   At load it installs ONLY three things, none of which runs per frame:
 *     1. window 'error' (capture) + 'unhandledrejection' listeners, last 50 kept;
 *     2. a bounded console ring (O(1) per console call — the page's own logging
 *        is the cost, this adds one array store to it);
 *     3. a Proxy on the AudioContext constructor, which runs once per context
 *        constructed, so the report can read state/latency of contexts the pages
 *        keep inside closures.
 *   No timer, no requestAnimationFrame, no PerformanceObserver and no polling
 *   exist until the button is pressed. tools/debugreport_test.mjs asserts that.
 *   ?debugreport=0 turns the whole file off (no listeners, no button, no Proxy).
 *   ?dbgconsole=0 / ?dbgaudio=0 skip only the console ring / the Proxy.
 *
 * WHAT A PRESS DOES
 *   Samples requestAnimationFrame for ~1 s (measured display refresh, janks),
 *   every page frame counter across that same second (guest frames/s), buffered
 *   long-animation-frame / slow-event entries, WebRTC getStats() for each room
 *   link (passive — it sends nothing into the room; rttReport() is NOT called,
 *   because it pings every peer), and WebGPU adapter info only when no page
 *   probe already holds it. A device is never requested.
 *
 * COPYING ON A PHONE
 *   Safari drops the user activation across an await, so the copy is started
 *   SYNCHRONOUSLY inside the click with a ClipboardItem whose value is a promise
 *   of the finished text. If that is refused: clipboard.writeText, then a
 *   textarea + execCommand('copy'), then a selectable overlay whose own Copy
 *   button is a fresh gesture with the text already built.
 *
 * PRIVACY
 *   Peer ids (16-hex nonces) are rewritten to seats (P1 host, P2 ...); a peer id
 *   never leaves the device. TURN credentials (?turn=, iceConfig) are redacted.
 *   localStorage is never read. ICE candidate ADDRESSES are never read — only
 *   candidate types and protocols.
 *
 * API: window.DebugReport = { collect() -> string (sync, uses the last press's
 *   measurement if any), collectAsync() -> Promise<string>, copy(btn?) ->
 *   Promise<{ok, how, text}>, inject(), lastText, version }.
 */
(function (global) {
  'use strict';
  var doc = null;
  try { doc = global && global.document; if (global.DebugReport && global.DebugReport.version) return; } catch (e) { return; }
  if (!doc) return;

  function qp(name) {
    try { return new URLSearchParams(String(global.location.search || '')).get(name); } catch (e) { return null; }
  }
  if (qp('debugreport') === '0') return;

  var VERSION = '1';
  var LABEL = '📋 Copy debug';
  var nav = {};
  try { nav = global.navigator || {}; } catch (e) { nav = {}; }
  var WALL0 = Date.now();
  function now() {
    try { return global.performance.now(); } catch (e) { return Date.now() - WALL0; }
  }
  var LOADED_AT = now();

  // ---------------------------------------------------------------------------
  // small, defensive helpers — every accessor in this file goes through one.
  // ---------------------------------------------------------------------------
  function errMsg(e) {
    try { return (e && (e.message || e.reason)) ? String(e.message || e.reason) : String(e); } catch (x) { return '?'; }
  }
  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…(+' + (s.length - n) + ' chars)' : s;
  }
  // Value or 'n/a (why)'. A throwing accessor never takes a section down.
  function tryv(fn, dflt) {
    try {
      var v = fn();
      return (v === undefined) ? (arguments.length > 1 ? dflt : null) : v;
    } catch (e) { return 'n/a (' + clip(errMsg(e), 140) + ')'; }
  }
  function isNA(v) { return v === null || v === undefined || (typeof v === 'string' && v.indexOf('n/a') === 0); }
  function show(x) {
    if (x === null || x === undefined || x === '') return 'n/a';
    if (typeof x === 'boolean') return x ? 'yes' : 'no';
    if (typeof x === 'number') return isFinite(x) ? String(Math.round(x * 1000) / 1000) : String(x);
    if (typeof x === 'string') return x;
    return ser(x, { depth: 3, maxLen: 1200 });
  }
  // A value with its unit, or a bare 'n/a' (never "n/ams").
  function su(x, unit) { var t = show(x); return t === 'n/a' ? t : t + unit; }
  function ms(sec) { return (typeof sec === 'number' && isFinite(sec)) ? (sec * 1000).toFixed(1) + 'ms' : 'n/a'; }
  function fx(x, d) { return (typeof x === 'number' && isFinite(x)) ? x.toFixed(d == null ? 2 : d) : show(x); }
  function $(id) { try { return doc.getElementById(id); } catch (e) { return null; } }
  function textOf(id) {
    var el = $(id);
    if (!el) return 'n/a';
    var t = tryv(function () { return el.textContent; }, '');
    t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    return t || '(empty)';
  }
  function fn(name) { try { return typeof global[name] === 'function' ? global[name] : null; } catch (e) { return null; } }
  function call(name) {
    var f = fn(name);
    if (!f) return null;
    return tryv(function () { return f.call(global); });
  }
  function g(name) { return tryv(function () { return global[name]; }); }

  // A bounded, cycle-safe, never-throwing serializer. Arrays keep their NEWEST
  // items (every history array in these pages is newest-last). Work is capped by
  // maxLen, not by the size of the object — a console.log of a huge buffer costs
  // the same as a small one.
  function ser(v, o) {
    o = o || {};
    var depthMax = o.depth == null ? 4 : o.depth, maxLen = o.maxLen || 4000;
    var maxArr = o.maxArr || 24, maxKeys = o.maxKeys || 60, maxStr = o.maxStr || 400;
    var out = [], len = 0, seen = [], stop = false;
    function put(s) {
      if (stop) return;
      if (len + s.length > maxLen) { out.push(s.slice(0, Math.max(0, maxLen - len)) + '…'); stop = true; return; }
      out.push(s); len += s.length;
    }
    function str(s) { s = String(s); return JSON.stringify(s.length > maxStr ? s.slice(0, maxStr) + '…' : s); }
    function walk(x, d) {
      if (stop) return;
      var t = typeof x;
      if (x === null || t === 'undefined') { put('null'); return; }
      if (t === 'string') { put(str(x)); return; }
      if (t === 'number') { put(isFinite(x) ? String(Math.round(x * 10000) / 10000) : str(String(x))); return; }
      if (t === 'boolean') { put(x ? 'true' : 'false'); return; }
      if (t === 'bigint' || t === 'symbol') { put(str(String(x))); return; }
      if (t === 'function') { put('"[fn]"'); return; }
      var tag = '';
      try { tag = Object.prototype.toString.call(x); } catch (e) { tag = '[object ?]'; }
      if (tag === '[object Error]' || (x && typeof x.stack === 'string' && typeof x.message === 'string')) {
        put(str((x.name || 'Error') + ': ' + x.message)); return;
      }
      if (seen.indexOf(x) >= 0) { put('"[cycle]"'); return; }
      if (d >= depthMax) { put('"[…]"'); return; }
      if (/Array\]$/.test(tag) && tag !== '[object Array]') {
        var tn = tryv(function () { return x.length; }, 0) | 0, head = [];
        for (var i = 0; i < Math.min(tn, 16); i++) head.push(tryv(function () { return x[i]; }));
        put(str(tag.slice(8, -1) + '(' + tn + ')' + (tn ? ' [' + head.join(',') + (tn > 16 ? ',…' : '') + ']' : '')));
        return;
      }
      if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
        put(str(tag.slice(8, -1) + '(' + tryv(function () { return x.byteLength; }) + ')')); return;
      }
      if (x === global) { put('"[window]"'); return; }
      if (typeof x.nodeType === 'number' && typeof x.nodeName === 'string') {
        put(str('<' + String(x.nodeName).toLowerCase() + (x.id ? '#' + x.id : '') + '>')); return;
      }
      if (tag === '[object Date]') { put(str(isNaN(x) ? 'Invalid Date' : x.toISOString())); return; }
      seen.push(x);
      try {
        if (tag === '[object Map]' || tag === '[object Set]') {
          var arr = [];
          try { x.forEach(function (val, key) { arr.push(tag === '[object Map]' ? [key, val] : val); }); } catch (e) {}
          x = arr;
        }
        if (Array.isArray(x)) {
          var n = x.length, from = n > maxArr ? n - maxArr : 0;
          put('[');
          if (from) put('"…' + from + ' earlier"' + (n > from ? ',' : ''));
          for (var j = from; j < n; j++) {
            if (j > from) put(',');
            walk(x[j], d + 1);
            if (stop) break;
          }
          put(']');
        } else {
          var keys = [];
          try { keys = Object.keys(x); } catch (e) { keys = []; }
          put('{');
          var k = 0;
          for (var q = 0; q < keys.length && k < maxKeys; q++) {
            var val;
            try { val = x[keys[q]]; } catch (e) { val = 'n/a (getter threw)'; }
            if (typeof val === 'function' || val === undefined) continue;
            if (k++) put(',');
            put(JSON.stringify(keys[q]) + ':');
            walk(val, d + 1);
            if (stop) break;
          }
          if (keys.length > maxKeys && !stop) put(',"…":"+' + (keys.length - maxKeys) + ' keys"');
          put('}');
        }
      } finally { seen.pop(); }
    }
    try { walk(v, 0); } catch (e) { put('"[unserializable: ' + errMsg(e) + ']"'); }
    return out.join('');
  }

  // ---------------------------------------------------------------------------
  // 1. ERRORS — installed now, the only thing that is. Last 50 kept.
  // ---------------------------------------------------------------------------
  var ERR_MAX = 50, errors = [], errTotal = 0;
  function pushErr(kind, textLine) {
    errTotal++;
    errors.push({ t: now(), kind: kind, text: clip(textLine, 1500) });
    if (errors.length > ERR_MAX) errors.shift();
  }
  function shortUrl(u) {
    try {
      u = String(u || '');
      var o = String(global.location.origin || '');
      return o && u.indexOf(o) === 0 ? u.slice(o.length) : u;
    } catch (e) { return String(u); }
  }
  function stackHead(st, n) {
    return String(st || '').split('\n').slice(0, n).map(function (s) { return s.trim(); }).join(' | ');
  }
  function onError(ev) {
    try {
      var t = ev && ev.target;
      if (t && t !== global && t.tagName) {
        pushErr('resource', 'failed to load <' + String(t.tagName).toLowerCase() + '> ' +
          shortUrl(t.src || t.href || t.currentSrc || ''));
        return;
      }
      var line = String((ev && ev.message) || 'error') + ' @ ' + shortUrl(ev && ev.filename) + ':' +
        (ev && ev.lineno) + ':' + (ev && ev.colno);
      var st = ev && ev.error && ev.error.stack;
      if (st) line += '\n      ' + stackHead(st, 5);
      pushErr('error', line);
    } catch (e) {}
  }
  function onRejection(ev) {
    try {
      var r = ev && ev.reason, line;
      if (r && typeof r === 'object' && (r.message || r.stack)) {
        line = (r.name ? r.name + ': ' : '') + (r.message || '') + (r.stack ? '\n      ' + stackHead(r.stack, 5) : '');
      } else line = typeof r === 'string' ? r : ser(r, { depth: 2, maxLen: 400 });
      pushErr('unhandledrejection', line);
    } catch (e) {}
  }
  try {
    global.addEventListener('error', onError, true);
    global.addEventListener('unhandledrejection', onRejection);
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // 2. CONSOLE RING — several pages (GameCube's recomp/netplay path, GBA, the
  // Genesis and SNES cores, the lobby) log ONLY to the console, so without this
  // their lines exist nowhere a player can reach. Fixed-size ring, one store per
  // call; arguments are rendered with a hard budget, never walked in full.
  // ---------------------------------------------------------------------------
  var CON_MAX = 300, conRing = new Array(CON_MAX), conN = 0;
  function fmtArgs(a) {
    var parts = [], budget = 700, n = Math.min(a.length, 10), i = 0;
    // console.log('%cstyled', 'color:red') — drop the %c markers and their CSS
    if (n && typeof a[0] === 'string' && a[0].indexOf('%c') >= 0) {
      var c = a[0].split('%c').length - 1;
      parts.push(a[0].replace(/%c/g, ''));
      i = 1 + c;
    }
    for (; i < n && budget > 0; i++) {
      var v = a[i], s;
      if (typeof v === 'string') s = v.length > budget ? v.slice(0, budget) + '…' : v;
      else if (v === null || typeof v !== 'object') s = String(v);
      else s = ser(v, { depth: 2, maxLen: Math.max(40, budget), maxArr: 8, maxKeys: 16 });
      budget -= s.length;
      parts.push(s);
    }
    return parts.join(' ');
  }
  function wrapConsole(level) {
    var c = null, orig = null;
    try { c = global.console; orig = c && c[level]; } catch (e) { return; }
    if (!c || typeof orig !== 'function' || orig.__debugreport) return;
    var w = function () {
      try { conRing[conN % CON_MAX] = [now(), level, fmtArgs(arguments)]; conN++; } catch (e) {}
      return orig.apply(c, arguments);
    };
    w.__debugreport = true;
    try { c[level] = w; } catch (e) {}
  }
  if (qp('dbgconsole') !== '0') ['log', 'info', 'warn', 'error', 'debug'].forEach(wrapConsole);
  function consoleEntries() {
    var out = [], n = Math.min(conN, CON_MAX);
    for (var i = conN - n; i < conN; i++) out.push(conRing[i % CON_MAX]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. AUDIOCONTEXT CAPTURE — dreamcast, genesis and snes keep their context in a
  // closure, and their baseLatency/outputLatency/state are exactly what an
  // "audio cuts out" report needs. A Proxy keeps `new`, `instanceof`, `extends`
  // and the prototype identical; only construction is observed.
  // ---------------------------------------------------------------------------
  var audioCtxs = [], audioProxied = false;
  (function () {
    if (qp('dbgaudio') === '0' || typeof Proxy !== 'function' || typeof Reflect === 'undefined') return;
    var seenCtor = [];
    ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
      try {
        var O = global[name];
        if (typeof O !== 'function') return;
        var idx = -1;
        for (var i = 0; i < seenCtor.length; i++) if (seenCtor[i][0] === O) idx = i;
        if (idx >= 0) { global[name] = seenCtor[idx][1]; return; }   // Safari aliases both names
        var P = new Proxy(O, {
          construct: function (target, args, newTarget) {
            var ctx = Reflect.construct(target, args, newTarget);
            try { audioCtxs.push({ ctx: ctx, at: now(), opts: args && args[0] ? ser(args[0], { depth: 1, maxLen: 120 }) : '' });
                  if (audioCtxs.length > 6) audioCtxs.shift(); } catch (e) {}
            return ctx;
          }
        });
        global[name] = P;
        seenCtor.push([O, P]);
        audioProxied = true;
      } catch (e) {}
    });
  })();

  // ---------------------------------------------------------------------------
  // WHICH PAGE, AND WHERE ITS BUTTONS GO. Every spot is inside a toolbar, a
  // status bar or a menu — never over the picture or the touch controls.
  // ---------------------------------------------------------------------------
  function pageId() {
    var p = String(tryv(function () { return global.location.pathname; }, '') || '').toLowerCase();
    if (/(^|\/)n64(\/|\.html|$)/.test(p)) return 'n64';
    var m = p.match(/([a-z0-9_\-]+)\.html?$/);
    if (m) return m[1];
    var parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || 'index';
  }
  var PAGE = pageId();

  var SMALL = 'min-width:0;padding:8px 14px;font-size:13px;background:#1d1d1d;border-color:#333;color:#aaa';
  // `party`: the room panel's action row. On dreamcast/ps1/genesis/snes (and
  // GameCube's netplay-ui) that panel is a FULL-PAGE overlay while a room forms,
  // so it covers the toolbar button at exactly the moment a room that will not
  // start needs a report. Measured: a click on the toolbar button during room
  // setup on genesis.html landed on #netOverlay and did nothing.
  var SPOTS = {
    n64:         { bar: ['#btnDiag', 'after'], menu: ['#mDiag', 'after'], splash: ['#mobileSplashDiag', 'after', 'small'] },
    dreamcast:   { bar: ['#btnDiag', 'after'], menu: ['#mDiag', 'after'], splash: ['#mobileSplashDiag', 'after', 'link'], party: ['#netClose', 'before'] },
    gamecube:    { bar: ['#btnDiag', 'after'], menu: ['#mClose', 'before'], splash: ['#mobileSplashStart', 'after', 'small'], party: ['.np-wrap .np-act', 'append', 'ghost'] },
    ps1:         { bar: ['#btnLog', 'after'], menu: ['#mClose', 'before'], splash: ['#mobileSplashStart', 'after', 'small'], party: ['#netClose', 'before'] },
    genesis:     { bar: ['#controlBar', 'append'], menu: ['#mClose', 'before'], splash: ['#mobileSplashNet', 'after', 'small'], party: ['#netClose', 'before'] },
    // SNES: the status bar, not #controlBar — the bar flex-wraps, and a new row
    // there would take height from the canvas on a narrow window.
    snes:        { bar: ['#statusBar', 'append', 'inline'], menu: ['#mClose', 'before'], splash: ['#mobileSplashNet', 'after', 'small'], party: ['#netClose', 'before'] },
    gba:         { bar: ['#mydiv', 'append', 'bs'], menu: ['#spMenuOverlay .sp-overlay-box hr', 'before', 'bsmenu'] },
    multiplayer: { bar: ['#wrap > p.hint', 'append', 'mp'] },
    _default:    { bar: ['#controlBar', 'append'], menu: ['#mClose', 'before'] }
  };

  // ---------------------------------------------------------------------------
  // THE MEASUREMENT — runs only after a press. ~1 s of rAF, the page's frame
  // counters across the same second, buffered main-thread entries, WebRTC
  // getStats per room link, and WebGPU adapter info if no page probe has it.
  // ---------------------------------------------------------------------------
  var M = null;          // the last press's measurement; collect() reads it

  function pageCounters() {
    var c = [];
    function add(name, get, hz) { c.push({ name: name, get: get, hz: hz }); }
    var M_ = function () { return global.Module; };
    switch (PAGE) {
      case 'n64':
        add('core VI (Module._neil_vi_total)', function () { return M_()._neil_vi_total(); },
          function () { var r = global.__n64Rate; return r && r.viHz; });
        break;
      case 'gamecube':
        add('recomp guest frames (__gcPad.seq)', function () { return global.__gcPad.seq(); }, null);
        add('published frames (__gcPresentStats.publishedTotal)', function () { return global.__gcPresentStats().publishedTotal; }, null);
        break;
      case 'ps1':
        add('gated frames (__ps1Frames, rooms only)', function () { return global.__ps1Frames; }, function () { return 59.94; });
        break;
      case 'genesis':
        add('guest frames (__genFrames)', function () { return global.__genFrames; },
          function () { return M_()._gpx_fps() || 59.922751; });
        break;
      case 'snes':
        add('guest frames (__snesFrames)', function () { return global.__snesFrames; }, function () { return 60.0988; });
        break;
      case 'gba':
        add('emulated frames (myApp.frameCnt; includes fast-forward)', function () { return global.myApp.frameCnt; },
          function () { return 59.7275; });
        break;
      default: break;
    }
    return c;
  }
  function newestSession() {
    var S = tryv(function () { return global.Netplay.sessions; }, null);
    if (!S || typeof S.length !== 'number' || !S.length) return null;
    for (var i = S.length - 1; i >= 0; i--) {
      var s = S[i], st = tryv(function () { return s && s.state; }, null);
      if (s && st !== 'closed' && st !== 'failed' && !isNA(st)) return s;
    }
    return S[S.length - 1] || null;
  }
  function sampleAll(ctrs) {
    var out = [];
    for (var i = 0; i < ctrs.length; i++) {
      var v = tryv(ctrs[i].get, null);
      out.push(typeof v === 'number' && isFinite(v) ? v : null);
    }
    var s = newestSession();
    var lf = tryv(function () { return s && s.ls ? s.ls.frame : null; }, null);
    out.push(typeof lf === 'number' ? lf : null);
    return { t: now(), v: out };
  }

  function observe(type, extra) {
    var entries = [], po = null;
    try {
      var PO = global.PerformanceObserver;
      var sup = (PO && PO.supportedEntryTypes) || [];
      if (PO && sup.indexOf(type) >= 0) {
        po = new PO(function (list) { try { entries.push.apply(entries, list.getEntries()); } catch (e) {} });
        var o = { type: type, buffered: true };
        if (extra) for (var k in extra) o[k] = extra[k];
        po.observe(o);
      }
    } catch (e) { po = null; }
    return {
      ok: !!po, entries: entries,
      stop: function () {
        try { if (po) { if (po.takeRecords) entries.push.apply(entries, po.takeRecords()); po.disconnect(); } } catch (e) {}
      }
    };
  }

  function measureFrames(windowMs) {
    return new Promise(function (resolve) {
      var ctrs = pageCounters();
      var obs = { loaf: observe('long-animation-frame'), event: observe('event', { durationThreshold: 16 }),
                  longtask: observe('longtask') };
      var ts = [], first = null, last = null, done = false, raf = global.requestAnimationFrame;
      var startWall = now();
      function finish(why) {
        if (done) return;
        done = true;
        var endSample = sampleAll(ctrs);
        for (var k in obs) obs[k].stop();
        var d = [];
        for (var i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
        var sorted = d.slice().sort(function (a, b) { return a - b; });
        var med = sorted.length ? sorted[sorted.length >> 1] : null;
        var r = {
          why: why, frames: d.length, spanMs: ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0,
          medianMs: med, hz: med ? 1000 / med : null,
          meanHz: d.length ? 1000 * d.length / (ts[ts.length - 1] - ts[0]) : null,
          minMs: sorted.length ? sorted[0] : null, maxMs: sorted.length ? sorted[sorted.length - 1] : null,
          p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
          janks: med ? d.filter(function (x) { return x > med * 1.5; }).length : null,
          counters: ctrs.map(function (c) { return c.name; }).concat(['room engine frames (Netplay ls.frame)']),
          hz_: ctrs.map(function (c) { return c.hz ? tryv(c.hz, null) : null; }),
          a: first || sampleAll(ctrs), b: endSample,
          loaf: obs.loaf, event: obs.event, longtask: obs.longtask, startedAt: startWall
        };
        resolve(r);
      }
      if (typeof raf !== 'function') { first = sampleAll(ctrs); setTimeout(function () { finish('no requestAnimationFrame'); }, windowMs); return; }
      function tick(t) {
        if (done) return;
        if (first === null) first = sampleAll(ctrs);
        ts.push(typeof t === 'number' ? t : now());
        if (ts.length > 1 && ts[ts.length - 1] - ts[0] >= windowMs) { finish('ok'); return; }
        raf.call(global, tick);
      }
      raf.call(global, tick);
      // A hidden tab never fires rAF — still finish, and say so.
      setTimeout(function () { finish(ts.length < 2 ? 'rAF did not fire (tab hidden or throttled)' : 'timeout'); }, windowMs + 700);
    });
  }

  function pageWebGpu() {
    var gc = tryv(function () { return global.__gcGpu && global.__gcGpu.webgpu; }, null);
    if (gc && typeof gc === 'object') return { source: 'gamecube page probe (__gcGpu.webgpu)', info: gc,
      pageDevice: !!tryv(function () { return global.__gcWgpuDevice; }, null) };
    var cw = tryv(function () { return global.__cap && global.__cap.webgpu; }, null);
    if (cw && typeof cw === 'object') return { source: 'capability probe (__cap.webgpu)', info: cw };
    return null;
  }
  function withTimeout(p, msT, what) {
    return new Promise(function (resolve) {
      var done = false;
      setTimeout(function () { if (!done) { done = true; resolve({ timeout: what + ' did not answer in ' + msT + ' ms' }); } }, msT);
      Promise.resolve(p).then(function (v) { if (!done) { done = true; resolve(v); } },
        function (e) { if (!done) { done = true; resolve({ err: errMsg(e) }); } });
    });
  }
  function webGpuAsync() {
    var pg = pageWebGpu();
    if (pg) return Promise.resolve(pg);
    var gpu = tryv(function () { return nav.gpu; }, null);
    if (!gpu || typeof gpu.requestAdapter !== 'function') return Promise.resolve({ source: 'navigator.gpu', info: 'not exposed by this browser' });
    // An ADAPTER only — a device is never requested (the page may hold one).
    return withTimeout(gpu.requestAdapter().then(function (a) {
      if (!a) return { source: 'navigator.gpu.requestAdapter()', info: 'resolved null — WebGPU present but no adapter (blocklisted GPU, or disabled)' };
      var info = a.info || null;
      var p = info ? Promise.resolve(info) : (typeof a.requestAdapterInfo === 'function' ? a.requestAdapterInfo() : Promise.resolve(null));
      return p.then(function (i) {
        return { source: 'navigator.gpu.requestAdapter()', info: {
          vendor: i && i.vendor, architecture: i && i.architecture, device: i && i.device, description: i && i.description,
          fallback: !!a.isFallbackAdapter, features: tryv(function () { return a.features.size; }),
          maxBufferMB: tryv(function () { return Math.round(a.limits.maxBufferSize / 1048576); }) } };
      });
    }), 900, 'requestAdapter');
  }

  // Passive WebRTC stats for every link of the live room. getStats() reads the
  // browser's own counters; it sends nothing to the peers.
  function linkStatsAsync() {
    var s = newestSession();
    var links = tryv(function () { return s && s._links; }, null);
    if (!links || typeof links.forEach !== 'function') return Promise.resolve([]);
    var jobs = [];
    links.forEach(function (L, key) {
      jobs.push(new Promise(function (resolve) {
        var row = { key: key, conn: tryv(function () { return L.pc && L.pc.connectionState; }),
                    ice: tryv(function () { return L.pc && L.pc.iceConnectionState; }),
                    dc: tryv(function () { return L.dc && L.dc.readyState; }),
                    dcBuffered: tryv(function () { return L.dc && L.dc.bufferedAmount; }),
                    open: tryv(function () { return L.open; }), approved: tryv(function () { return L.approved; }) };
        var pc = L && L.pc;
        if (!pc || typeof pc.getStats !== 'function') { resolve(row); return; }
        withTimeout(pc.getStats(), 800, 'getStats').then(function (rep) {
          try {
            if (!rep || typeof rep.forEach !== 'function') { row.stats = rep && (rep.err || rep.timeout); resolve(row); return; }
            var byId = {}, pairId = null, pairs = [];
            rep.forEach(function (x) {
              byId[x.id] = x;
              if (x.type === 'transport' && x.selectedCandidatePairId) pairId = x.selectedCandidatePairId;
              if (x.type === 'candidate-pair') pairs.push(x);
            });
            var pair = pairId ? byId[pairId] : null;
            if (!pair) for (var i = 0; i < pairs.length; i++) if (pairs[i].nominated && pairs[i].state === 'succeeded') pair = pairs[i];
            if (pair) {
              var lc = byId[pair.localCandidateId] || {}, rc = byId[pair.remoteCandidateId] || {};
              row.path = (lc.candidateType || '?') + '/' + (lc.protocol || '?') + (lc.relayProtocol ? '(relay ' + lc.relayProtocol + ')' : '') +
                         ' ↔ ' + (rc.candidateType || '?') + '/' + (rc.protocol || '?');
              row.rttMs = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 10000) / 10 : null;
              row.avgRttMs = (pair.totalRoundTripTime && pair.responsesReceived) ? Math.round(pair.totalRoundTripTime / pair.responsesReceived * 10000) / 10 : null;
              row.bytesSent = pair.bytesSent; row.bytesReceived = pair.bytesReceived;
              row.outKbps = typeof pair.availableOutgoingBitrate === 'number' ? Math.round(pair.availableOutgoingBitrate / 1000) : null;
            } else row.path = 'no selected candidate pair';
            rep.forEach(function (x) {
              if (x.type === 'data-channel') { row.dcMsgsSent = x.messagesSent; row.dcMsgsRecv = x.messagesReceived; }
            });
          } catch (e) { row.stats = 'n/a (' + errMsg(e) + ')'; }
          resolve(row);
        });
      }));
    });
    return Promise.all(jobs);
  }

  function collectAsync() {
    var t0 = now();
    var jobs = [measureFrames(1000), webGpuAsync(), linkStatsAsync()];
    return Promise.all(jobs.map(function (p) {
      return Promise.resolve(p).then(null, function (e) { return { err: errMsg(e) }; });
    })).then(function (r) {
      M = { frames: r[0], gpu: r[1], links: r[2], tookMs: now() - t0, at: Date.now() };
      return collect();
    });
  }

  // ---------------------------------------------------------------------------
  // PEER ID SCRUBBING + REDACTION
  // ---------------------------------------------------------------------------
  function peerLabels() {
    var map = {};
    var S = tryv(function () { return global.Netplay.sessions; }, null);
    if (!S || typeof S.length !== 'number') return map;
    for (var i = 0; i < S.length; i++) {
      var s = S[i], ls = tryv(function () { return s.ls; }, null);
      var me = tryv(function () { return (ls && ls.peerId) || s._nonce; }, null);
      var roster = tryv(function () { return ls && ls.roster; }, null);
      if (roster && typeof roster.length === 'number') {
        for (var p = 0; p < roster.length; p++) {
          var id = roster[p];
          if (typeof id !== 'string' || map[id]) continue;
          map[id] = 'P' + (p + 1) + (p === 0 ? '(host)' : '') + (id === me ? '(me)' : '');
        }
      }
      if (typeof me === 'string' && !map[me]) map[me] = 'me';
    }
    return map;
  }
  function scrub(text) {
    var map = peerLabels(), anon = {}, n = 0;
    return String(text).replace(/\b[0-9a-f]{16}\b/g, function (m) {
      if (map[m]) return map[m];
      return anon[m] || (anon[m] = 'id#' + (++n));
    });
  }
  var SECRET_KEYS = /^(turn|credential|password|pass|secret|token|key|apikey|auth)$/i;
  function redactUrl(u) {
    try {
      var url = new URL(String(u));
      var changed = false;
      url.searchParams.forEach(function (v, k) { if (SECRET_KEYS.test(k)) changed = true; });
      if (!changed) return String(u);
      var keys = [];
      url.searchParams.forEach(function (v, k) { keys.push(k); });
      keys.forEach(function (k) { if (SECRET_KEYS.test(k)) url.searchParams.set(k, '[redacted]'); });
      return url.toString();
    } catch (e) { return String(u).replace(/([?&](turn|credential|password|token|key)=)[^&#]*/gi, '$1[redacted]'); }
  }

  // ---------------------------------------------------------------------------
  // SECTIONS. Each one is built in its own try: one throwing accessor costs a
  // line, never the report.
  // ---------------------------------------------------------------------------
  function layoutMode() {
    var ms_ = $('mobileShell') || $('spShell');
    if (!ms_) return 'single layout (no touch shell on this page)';
    var d = tryv(function () { return global.getComputedStyle(ms_).display; }, 'n/a');
    return (d && d !== 'none' && !isNA(d)) ? 'MOBILE touch shell (#' + ms_.id + ' shown)' : 'desktop (#' + ms_.id + ' hidden)';
  }
  function scriptList() {
    var out = [];
    try {
      var ss = doc.querySelectorAll('script[src]');
      for (var i = 0; i < ss.length && i < 40; i++) out.push(shortUrl(ss[i].src || ss[i].getAttribute('src')));
    } catch (e) { return 'n/a (' + errMsg(e) + ')'; }
    return out.join('  ');
  }

  function secPage(L) {
    var loc = global.location || {};
    L.push('page: ' + PAGE + '   path: ' + show(tryv(function () { return loc.pathname; })));
    L.push('url: ' + redactUrl(tryv(function () { return loc.href; })));
    L.push('title: ' + show(tryv(function () { return doc.title; })));
    var d = new Date();
    L.push('time: ' + d.toISOString() + '   local: ' + show(tryv(function () { return d.toString(); })));
    L.push('page age: ' + (now() / 1000).toFixed(1) + ' s since navigation · debugreport v' + VERSION +
           ' installed at +' + (LOADED_AT / 1000).toFixed(2) + ' s');
    L.push('layout: ' + layoutMode());
    L.push('status: ' + textOf('status') + '   | mobile status: ' + textOf('mobileStatus'));
    L.push('scripts: ' + scriptList());
  }

  function secDevice(L) {
    L.push('ua: ' + show(tryv(function () { return nav.userAgent; })));
    var uad = tryv(function () { return nav.userAgentData; }, null);
    if (uad && typeof uad === 'object') {
      L.push('uaData: ' + show(tryv(function () {
        return (uad.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(', ') +
          ' | mobile=' + show(uad.mobile) + ' platform=' + show(uad.platform);
      })));
    }
    L.push('platform: ' + show(tryv(function () { return nav.platform; })) +
           '   language: ' + show(tryv(function () { return nav.language; })) +
           '   timezone: ' + show(tryv(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; })));
    L.push('hardwareConcurrency: ' + show(tryv(function () { return nav.hardwareConcurrency; })) +
           '   deviceMemory: ' + show(tryv(function () { return nav.deviceMemory; })) + ' GB' +
           '   jsHeap: ' + show(tryv(function () {
             var m = global.performance.memory;
             return m ? Math.round(m.usedJSHeapSize / 1048576) + '/' + Math.round(m.totalJSHeapSize / 1048576) +
               ' MB used/total, limit ' + Math.round(m.jsHeapSizeLimit / 1048576) + ' MB' : null;
           })));
    L.push('screen: ' + show(tryv(function () {
      var s = global.screen;
      return s.width + 'x' + s.height + ' (avail ' + s.availWidth + 'x' + s.availHeight + ', ' + s.colorDepth + '-bit)';
    })) + '   devicePixelRatio: ' + show(tryv(function () { return global.devicePixelRatio; })) +
      '   orientation: ' + show(tryv(function () { var o = global.screen.orientation; return o ? o.type + ' ' + o.angle + '°' : null; })));
    L.push('window: ' + show(tryv(function () { return global.innerWidth + 'x' + global.innerHeight; })) +
           '   visualViewport: ' + show(tryv(function () {
             var v = global.visualViewport; return v ? Math.round(v.width) + 'x' + Math.round(v.height) + ' scale ' + v.scale : null;
           })));
    L.push('input: maxTouchPoints=' + show(tryv(function () { return nav.maxTouchPoints; })) +
           ' pointer=' + show(tryv(function () {
             var mm = function (q) { return global.matchMedia && global.matchMedia(q).matches; };
             return mm('(pointer: coarse)') ? 'coarse' : mm('(pointer: fine)') ? 'fine' : 'none';
           })));
    L.push('network: ' + show(tryv(function () {
      var c = nav.connection;
      return c ? 'type=' + show(c.type) + ' effectiveType=' + show(c.effectiveType) + ' rtt=' + su(c.rtt, 'ms') + ' downlink=' +
        su(c.downlink, 'Mbps') + ' saveData=' + show(c.saveData) : 'navigator.connection not exposed';
    })) + '   online=' + show(tryv(function () { return nav.onLine; })));
    L.push('crossOriginIsolated: ' + show(tryv(function () { return global.crossOriginIsolated; })) +
           '   SharedArrayBuffer: ' + show(tryv(function () { return typeof SharedArrayBuffer === 'function'; })) +
           '   secureContext: ' + show(tryv(function () { return global.isSecureContext; })) +
           '   serviceWorker controlling: ' + show(tryv(function () { return !!(nav.serviceWorker && nav.serviceWorker.controller); })));
  }

  function secDisplay(L) {
    var f = M && M.frames;
    if (!f) L.push('refresh: not measured (collect() without a press — press the button for the 1 s sample)');
    else if (!f.hz) L.push('refresh: could not measure — ' + f.why);
    else {
      L.push('refresh: measured ' + fx(f.hz, 1) + ' Hz (median frame ' + fx(f.medianMs, 2) + ' ms; mean ' + fx(f.meanHz, 1) +
        ' Hz over ' + Math.round(f.spanMs) + ' ms, ' + f.frames + ' frames)');
      L.push('frame intervals: min ' + fx(f.minMs, 1) + ' / p95 ' + fx(f.p95Ms, 1) + ' / max ' + fx(f.maxMs, 1) +
        ' ms; ' + f.janks + ' of ' + f.frames + ' frames took >1.5x the median (main-thread janks while measuring)');
    }
    L.push('visibility: ' + show(tryv(function () { return doc.visibilityState; })) +
           '   focused: ' + show(tryv(function () { return doc.hasFocus(); })) +
           '   fullscreen: ' + show(tryv(function () {
             var e = doc.fullscreenElement || doc.webkitFullscreenElement;
             return e ? '<' + String(e.tagName).toLowerCase() + (e.id ? '#' + e.id : '') + '>' : 'no';
           })));
  }

  var glCache = null;
  function glProbe() {
    if (glCache) return glCache;
    var r = {}, c = null, gl = null;
    try {
      c = doc.createElement('canvas'); c.width = 1; c.height = 1;
      gl = c.getContext('webgl2'); r.webgl2 = !!gl;
      if (!gl) { gl = c.getContext('webgl') || c.getContext('experimental-webgl'); r.webgl1 = !!gl; }
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        r.vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        r.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        r.masked = !ext;
        r.version = gl.getParameter(gl.VERSION);
        r.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      }
    } catch (e) { r.err = errMsg(e); }
    finally {
      try { var l = gl && gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {}
    }
    glCache = r;
    return r;
  }
  function logText(maxChars) {
    var el = $('log');
    if (!el || String(el.tagName).toUpperCase() !== 'PRE') return null;
    var t = String(tryv(function () { return el.textContent; }, '') || '');
    return maxChars && t.length > maxChars ? t.slice(-maxChars) : t;
  }
  function grepLog(re, n) {
    var t = logText(400000);
    if (!t) return [];
    var L = t.split('\n'), out = [];
    for (var i = L.length - 1; i >= 0 && out.length < n; i--) if (re.test(L[i])) out.unshift(L[i]);
    return out;
  }

  function secGpu(L) {
    var gl = glProbe();
    L.push('WebGL (throwaway 1x1 canvas, context released): webgl2=' + show(gl.webgl2) +
           (gl.webgl2 ? '' : ' webgl1=' + show(gl.webgl1)) + (gl.err ? ' err=' + gl.err : ''));
    L.push('  renderer: ' + show(gl.renderer) + (gl.masked ? ' (MASKED — no WEBGL_debug_renderer_info)' : '') +
           '   vendor: ' + show(gl.vendor) + '   ' + show(gl.version) + '   maxTex=' + show(gl.maxTex));
    var wg = (M && M.gpu) || pageWebGpu();
    if (!wg) L.push('WebGPU: not probed yet (press the button; it asks navigator.gpu for an adapter, never a device)');
    else L.push('WebGPU [' + show(wg.source || '?') + ']: ' + (typeof wg.info === 'string' ? wg.info : ser(wg.info || wg, { depth: 2, maxLen: 900 })) +
                (wg.pageDevice ? '   (page holds a GPUDevice — not re-requested)' : ''));
    switch (PAGE) {
      case 'n64':
        L.push('page GL context (Module.ctx): ' + show(tryv(function () {
          var c = global.Module && global.Module.ctx;
          if (!c || typeof c.getParameter !== 'function') return 'none yet (core not started)';
          return 'drawingBuffer ' + c.drawingBufferWidth + 'x' + c.drawingBufferHeight + ' contextLost=' + show(c.isContextLost());
        })));
        grepLog(/\[gl\]/, 4).forEach(function (l) { L.push('  log: ' + l); });
        break;
      case 'dreamcast':
        grepLog(/\[glinfo\]/, 8).forEach(function (l) { L.push('  worker GL: ' + l); });
        break;
      case 'gamecube':
        L.push('render path (#gpuPath): ' + textOf('gpuPath') + ' — ' + show(tryv(function () { return $('gpuPath').title; })));
        L.push('__gcGpu: ' + ser(g('__gcGpu'), { depth: 3, maxLen: 1500 }));
        break;
      case 'ps1': case 'snes': case 'genesis': case 'gba':
        L.push('render path: Canvas 2D (this page draws no WebGL/WebGPU); canvas ' + show(tryv(function () {
          var c = $('canvas'); return c ? c.width + 'x' + c.height + ' shown at ' + Math.round(c.getBoundingClientRect().width) + 'x' +
            Math.round(c.getBoundingClientRect().height) + ' CSS px' : null;
        })));
        break;
      default: break;
    }
  }

  function secCapability(L) {
    var C = g('Capability');
    if (!C || typeof C !== 'object' && typeof C !== 'function') { L.push('lib/capability.js is not loaded on this page'); return; }
    L.push(String(tryv(function () { return C.text(); }, 'n/a')));
    L.push('gate: ' + show(tryv(function () {
      var spec = C.SPECS && C.SPECS[PAGE];
      if (!spec) return 'no spec for page "' + PAGE + '"';
      var v = C.verdict(spec);
      return v ? v.level + ' — ' + v.short : null;
    })) + '   __cap.gate: ' + ser(tryv(function () { return global.__cap && global.__cap.gate; }), { depth: 2, maxLen: 400 }));
  }

  function counterLines(L) {
    var f = M && M.frames;
    if (!f) { L.push('guest counters: not sampled (press the button — it samples them across the same 1 s)'); return; }
    var dt = (f.b.t - f.a.t) / 1000;
    for (var i = 0; i < f.counters.length; i++) {
      var a = f.a.v[i], b = f.b.v[i];
      if (a === null || b === null || a === undefined || b === undefined) {
        if (i < f.counters.length - 1) L.push('counter ' + f.counters[i] + ': n/a');
        continue;
      }
      var rate = dt > 0 ? (b - a) / dt : null;
      var hz = f.hz_[i];
      L.push('counter ' + f.counters[i] + ': +' + (b - a) + ' in ' + fx(dt, 3) + ' s = ' + fx(rate, 2) + '/s' +
        ((typeof hz === 'number' && hz > 0 && rate !== null) ? ' = ' + fx(rate / hz, 3) + 'x of ' + fx(hz, 4) + ' Hz hardware' : ''));
    }
  }

  function secRate(L) {
    switch (PAGE) {
      case 'n64': {
        var R = g('N64Rate'), r = g('__n64Rate');
        L.push('#fps: ' + textOf('fps'));
        if (r && typeof r === 'object') {
          L.push('headline: ' + show(tryv(function () { return R.format(r); })));
          L.push('120 verdict: ' + show(tryv(function () { return R.gapText(r); })));
          L.push('speed=' + show(r.speed) + ' (from ' + show(r.speedFrom) + ') audioSpeed=' + show(r.audioSpeed) + ' viSpeed=' + show(r.viSpeed) +
                 ' viHz=' + show(r.viHz) + ' gameHz=' + show(r.gameHz) + ' gameFrac=' + show(r.gameFrac));
          L.push('capacity: costMs/frame=' + show(r.costMs) + ' capVi=' + show(r.capVi) + ' hwX=' + show(r.hwX) + ' capFps=' + show(r.capFps) +
                 ' duty=' + show(r.duty) + ' e2eHwX=' + show(r.e2eHwX) + ' shown=' + show(r.shown) + '/s made=' + show(r.made) + '/s lost=' + show(r.lost));
          L.push('flags: starved=' + show(r.starved) + ' ahead=' + show(r.ahead) + ' repaying=' + show(r.repaying) + ' decoupled=' + show(r.decoupled) +
                 ' disagree=' + show(r.disagree) + ' seam=' + show(r.seam) + ' arm=' + show(r.arm) + ' audioGaps=' + show(r.audioGaps));
        } else L.push('__n64Rate: n/a (published once a second only while a game runs)');
        L.push('pace governor: ' + ser(call('__n64Pace'), { depth: 2, maxLen: 700 }));
        if (fn('__jitStats')) L.push('jit: ' + ser(call('__jitStats'), { depth: 2, maxLen: 700 }));
        break;
      }
      case 'dreamcast': {
        L.push('#fpsBar: ' + textOf('fpsBar'));
        var p = call('__dcProbe');
        if (p && typeof p === 'object') {
          L.push('probe: fps=' + show(p.fps) + ' fields=' + show(p.fields) + ' iters=' + show(p.iters) + ' guestX=' + show(p.guestX) +
                 ' booted=' + show(p.booted) + ' live=' + show(p.live) + ' why=' + show(p.why) + ' phase=' + show(p.phase) + ' idleMs=' + show(p.idleMs));
          L.push('headline: ' + show(p.headline));
          L.push('memory: heap=' + ser(p.heap, { depth: 1, maxLen: 200 }) + ' budget=' + show(p.memBudgetMB) + 'MB (' + show(p.memBudgetWhy) + ') deviceMemGiB=' + show(p.deviceMemGiB));
        } else L.push('__dcProbe: ' + show(p));
        grepLog(/\[page\] heartbeat/, 1).forEach(function (l) { L.push('last heartbeat: ' + l); });
        L.push('stall: ' + ser(call('__dcStall'), { depth: 2, maxLen: 600 }));
        break;
      }
      case 'gamecube': {
        var GR = g('GcRate'), gr = g('__gcRate');
        L.push('headline: ' + show(tryv(function () { return GR.format(gr); })));
        L.push('#fps: ' + textOf('fps') + '   #recompFps: ' + textOf('recompFps'));
        L.push('__gcRate: ' + ser(gr, { depth: 2, maxLen: 1500 }));
        L.push('present queue: ' + ser(call('__gcPresentStats'), { depth: 2, maxLen: 800 }));
        L.push('#fps breakdown: ' + clip(show(tryv(function () { return $('fps').title; })), 1500));
        break;
      }
      case 'ps1': {
        L.push('#fps: ' + textOf('fps') + '  (canvas presents/s — not a guest-rate witness)');
        var n = call('__ps1Net');
        if (n && typeof n === 'object') L.push('room service: svcAvgMs=' + show(n.svcAvgMs) + ' svcMaxMs=' + show(n.svcMaxMs) + ' svcCount=' + show(n.svcCount) +
          ' capHits=' + show(n.capHits) + ' gateStalls=' + show(n.gateStalls) + ' frameBudgetMs=' + show(n.frameBudgetMs) + ' hz=' + show(n.hz) +
          ' live=' + show(n.live) + ' workerFrames=' + show(n.workerFrames));
        break;
      }
      case 'genesis': {
        L.push('#fps: ' + textOf('fps'));
        var gn = call('__genNet');
        if (gn && typeof gn === 'object') {
          L.push('mode=' + show(gn.mode) + ' lagMs=' + show(gn.lagMs) + ' live=' + show(gn.live) + ' frames=' + show(gn.frames));
          L.push('rollback page stats: ' + ser(tryv(function () { return gn.rollback && gn.rollback.page; }), { depth: 2, maxLen: 500 }));
        }
        L.push('core hz: ' + show(tryv(function () { return global.Module._gpx_fps(); })));
        break;
      }
      case 'snes':
        L.push('#fps: ' + textOf('fps'));
        break;
      case 'gba': {
        var a = g('myApp');
        L.push('myApp: ' + show(tryv(function () {
          return 'isRunning=' + show(a.isRunning) + ' frameCnt=' + show(a.frameCnt) + ' gameSpeed=' + show(a.gameSpeed) +
            (a.gameSpeed > 1 ? ' (FAST-FORWARD — rate is not 1.000x on purpose, audio muted)' : '') + ' rom=' + show(a.rom_name);
        })));
        break;
      }
      case 'multiplayer':
        L.push('lobby page — no emulator core runs here');
        break;
      default:
        L.push('#fps: ' + textOf('fps'));
    }
    counterLines(L);
  }

  // ---- NETPLAY --------------------------------------------------------------
  function iceSummary(NP) {
    return show(tryv(function () {
      var list = NP.iceConfig();
      var servers = (list && list.iceServers) || list || [];
      if (!servers.length) return 'no ICE servers';
      return servers.map(function (s) {
        var urls = [].concat(s.urls || s.url || []).map(function (u) { return String(u).split('?')[0]; });
        return urls.join(',') + (s.username || s.credential ? ' [credentials redacted]' : '');
      }).join('; ');
    }));
  }
  function seatLabel(p, me, roster) {
    var id = roster && roster[p];
    return 'P' + (p + 1) + (p === 0 ? '(host)' : '') + (id && id === me ? '(me)' : '');
  }
  function sessionLines(L, s, idx, isNewest) {
    var ls = tryv(function () { return s.ls; }, null);
    L.push('-- session[' + idx + ']' + (isNewest ? ' (newest)' : '') + ': state=' + show(tryv(function () { return s.state; })) +
           ' role=' + (tryv(function () { return s.isHost; }) === true ? 'host' : 'guest') +
           ' code=' + show(tryv(function () { return s.code; })) + ' transport=' + show(tryv(function () { return s.transport; })) +
           ' game=' + show(tryv(function () { return s.game; })) + ' portCount=' + show(tryv(function () { return s.portCount; })) +
           ' maxPeers=' + show(tryv(function () { return s.maxPeers; })) + ' lastError=' + show(tryv(function () { return s.lastError; })));
    if (!isNewest) return;
    var ri = tryv(function () { return s.roomInfo(); }, null);
    var me = tryv(function () { return (ls && ls.peerId) || s._nonce; }, null);
    var roster = tryv(function () { return ls && ls.roster; }, null);
    if (ri && typeof ri === 'object') {
      L.push('   room: state=' + show(ri.state) + ' started=' + show(ri.started) + ' links=' + show(ri.links) + ' full=' + show(ri.full) +
             ' mySeat=' + show(tryv(function () {
               var mine = (ri.seats || []).filter(function (x) { return x.local; }).map(function (x) { return 'P' + (x.port + 1); });
               return mine.length ? mine.join(',') : 'not seated';
             })));
      tryv(function () {
        (ri.seats || []).forEach(function (st) {
          L.push('   seat ' + seatLabel(st.port, me, roster) + ': ' + (st.peer == null ? 'empty' :
            (st.local ? 'this console' : 'remote') + ' load=' + su(st.load, '%') + ' ready=' + show(st.ready) +
            ' dropped=' + show(st.dropped)));
        });
      });
      L.push('   relay: ' + (ri.relay ? ser(ri.relay, { depth: 2, maxLen: 600 }) : 'direct (no relay)'));
      if (ri.barrier) L.push('   barrier: ' + ser(ri.barrier, { depth: 2, maxLen: 500 }));
    } else L.push('   roomInfo: ' + show(ri));
    L.push('   admission: ' + ser(tryv(function () { return s.admission(); }), { depth: 2, maxLen: 300 }));
    if (!ls) { L.push('   engine: none yet (lockstep starts when the room forms)'); return; }
    var rep = tryv(function () { return ls.report(); }, null);
    if (rep && typeof rep === 'object') {
      var frameMs = 1000 / 60;
      L.push('   engine: state=' + show(rep.state) + ' frame=' + show(rep.frame) + ' delay=' + show(rep.delay) + 'f (~' +
             fx(rep.delay * frameMs, 0) + ' ms at 60 Hz) rollback=' + (rep.rollback ? 'on' : 'off') + ' ports=' + show(rep.portCount) +
             ' localPorts=' + show(rep.localPorts) + ' alone=' + show(rep.alone) + ' error=' + show(rep.error));
      L.push('   delay history (newest last): ' + ser(rep.delayHistory, { depth: 2, maxLen: 1500 }) +
             (rep.failedDelay ? '   failedDelay=' + show(rep.failedDelay) : ''));
      L.push('   stalls=' + show(rep.stalls) + ' stallMs=' + show(rep.stallMs) + ' maxStallMs=' + show(rep.maxStallMs) + ' frames=' + show(rep.frames) +
             ' minLead=' + show(rep.minLead) + ' meanLead=' + show(rep.meanLead));
      L.push('   stall ms by port: ' + (rep.stallByPort ? ser(rep.stallByPort, { depth: 1, maxLen: 300 }) : show(tryv(function () {
        var o = {}; ls._stallByPeer.forEach(function (msv, pid) { o[pid] = Math.round(msv); }); return o;
      }))));
      L.push('   inputs sent/recv=' + show(rep.inputsSent) + '/' + show(rep.inputsReceived) + ' hashes compared/sent=' + show(rep.hashesCompared) +
             '/' + show(rep.hashesSent) + ' lastAgreedFrame=' + show(rep.lastAgreedFrame) + ' desync=' + show(rep.desync));
      if (rep.msgs) L.push('   msgs: ' + ser(rep.msgs, { depth: 2, maxLen: 700 }));
      L.push('   roster: seq=' + show(rep.rosterSeq) + ' ageMs=' + show(rep.rosterAgeMs) + ' stale=' + show(rep.rosterStale) +
             ' evicted=' + show(rep.rosterEvicted) + ' game=' + show(rep.game) + ' roomGame=' + show(rep.roomGame) +
             ' declaredReady=' + show(rep.declaredReady) + ' readyPeers=' + show(rep.readyPeers));
    } else L.push('   engine report: ' + show(rep));
    var pr = tryv(function () { return ls.paceReport(); }, null);
    if (pr && typeof pr === 'object') {
      var sf = pr.self || { ports: pr.ownPorts, share: pr.own && pr.own.share };
      L.push('   pace self ' + show(sf.ports) + ': stalledShare=' + show(sf.share) + ' lost=' + show(sf.lost) + ' cap=' + su(sf.cap, 'x') +
             ' rtt=' + su(sf.rtt, 'ms') + ' waitOn=' + ser(sf.waitOn, { depth: 1, maxLen: 200 }));
      tryv(function () {
        (pr.peers || []).forEach(function (pp) {
          L.push('   pace peer ' + show(pp.ports) + ' (' + pp.peer + '): stalledShare=' + show(pp.share) + ' lost=' + show(pp.lost) +
                 ' cap=' + su(pp.cap, 'x') + ' rtt=' + su(pp.rtt, 'ms') + ' waitOn=' + ser(pp.waitOn, { depth: 1, maxLen: 200 }) +
                 ' frames=' + show(pp.frames) + ' w=' + su(pp.w, 'ms') + ' ageMs=' + show(pp.ageMs));
        });
      });
      if (pr.failedForMs) L.push('   delay give-back blocked for ' + pr.failedForMs + ' ms (failedDelay ' + show(pr.failedDelay) + ')');
      var LS = tryv(function () { return global.Netplay.Lockstep; }, null);
      var roomRate = roomRateX();
      if (LS && typeof LS.paceVerdict === 'function' && roomRate !== null && roomRate.x > 0) {
        L.push('   pace verdict @ measured room rate ' + fx(roomRate.x, 3) + 'x: ' + show(tryv(function () {
          var v = LS.paceVerdict(pr, roomRate.x); return v ? v.kind + ' — ' + (v.text || '(no text)') : null;
        })));
      }
    }
    if (rep && rep.rollback) L.push('   rollback: ' + ser(tryv(function () { return ls.rollbackReport(); }), { depth: 2, maxLen: 800 }));
    L.push('   selfCap=' + show(tryv(function () { return ls.selfCap; })) + ' rttMs=' + show(tryv(function () { return ls.rttMs; })) +
           ' selfLostMs=' + show(tryv(function () { return ls.selfLostMs; })));
    var links = M && M.links;
    if (!links) L.push('   WebRTC links: not sampled (press the button; getStats is passive)');
    else if (!links.length) L.push('   WebRTC links: none');
    else links.forEach(function (row) {
      L.push('   link ' + row.key + ': pc=' + show(row.conn) + ' ice=' + show(row.ice) + ' dc=' + show(row.dc) + ' dcBuffered=' + su(row.dcBuffered, 'B') +
             ' path=' + show(row.path) + ' rtt=' + su(row.rttMs, 'ms') + ' avgRtt=' + su(row.avgRttMs, 'ms') + ' bytes out/in=' +
             show(row.bytesSent) + '/' + show(row.bytesReceived) + ' dcMsgs out/in=' + show(row.dcMsgsSent) + '/' + show(row.dcMsgsRecv) +
             (row.stats ? ' stats=' + show(row.stats) : ''));
    });
  }
  function roomRateX() {
    var f = M && M.frames;
    if (!f) return null;
    var i = f.counters.length - 1, a = f.a.v[i], b = f.b.v[i];
    if (typeof a !== 'number' || typeof b !== 'number') return null;
    var dt = (f.b.t - f.a.t) / 1000, hz = null;
    for (var k = 0; k < f.hz_.length; k++) if (typeof f.hz_[k] === 'number' && f.hz_[k] > 0) { hz = f.hz_[k]; break; }
    if (!(dt > 0)) return null;
    return { x: (b - a) / dt / (hz || 60), perS: (b - a) / dt, hz: hz || 60, assumed: !hz };
  }
  function rateWords(rr) {
    return fx(rr.perS, 2) + ' frames/s = ' + fx(rr.x, 3) + 'x of ' + fx(rr.hz, 4) + ' Hz' + (rr.assumed ? ' (60 Hz ASSUMED — this page publishes no hardware rate)' : '');
  }
  function secNetplay(L) {
    var NP = g('Netplay');
    if (!NP || typeof NP !== 'object') { L.push('Netplay library: not loaded on this page (no online play here)'); return; }
    L.push('lib: PROTO=' + show(tryv(function () { return NP.PROTO; })) + ' supported=' + show(tryv(function () { return NP.supported(); })) +
           ' signalPlan=' + show(tryv(function () { return NP.signalPlan(); })) + ' brokers=' + show(tryv(function () { return NP.signalBrokers(); })));
    L.push('ICE: ' + iceSummary(NP));
    var S = tryv(function () { return NP.sessions; }, null);
    if (!S || typeof S.length !== 'number') { L.push('sessions: ' + show(S)); return; }
    L.push('sessions: ' + S.length + ' live (newest last)' + (S.length ? '' : ' — solo play, no room on this page'));
    var newest = newestSession();
    for (var i = Math.max(0, S.length - 3); i < S.length; i++) {
      try { sessionLines(L, S[i], i, S[i] === newest); } catch (e) { L.push('-- session[' + i + ']: n/a (' + errMsg(e) + ')'); }
    }
    var rr = roomRateX();
    if (rr !== null) L.push('room engine over the 1 s sample: ' + rateWords(rr));
  }

  // ---- AUDIO ----------------------------------------------------------------
  function secAudio(L) {
    if (!audioCtxs.length) L.push('AudioContexts constructed: none yet' + (audioProxied ? ' (audio starts on Start/first tap)' : ' (capture unavailable in this browser)'));
    audioCtxs.forEach(function (rec, i) {
      var c = rec.ctx;
      L.push('ctx[' + i + '] made at +' + (rec.at / 1000).toFixed(1) + 's ' + (rec.opts ? rec.opts + ' ' : '') + '→ state=' + show(tryv(function () { return c.state; })) +
             ' sampleRate=' + show(tryv(function () { return c.sampleRate; })) + ' baseLatency=' + ms(tryv(function () { return c.baseLatency; })) +
             ' outputLatency=' + ms(tryv(function () { return c.outputLatency; })) + ' currentTime=' + fx(tryv(function () { return c.currentTime; }), 2) + 's');
    });
    L.push('mute button: ' + textOf('btnMute'));
    var AD = g('AudioDiag');
    if (AD && typeof AD.report === 'function') L.push('AudioDiag.report: ' + ser(tryv(function () { return AD.report(); }), { depth: 3, maxLen: 1500 }));
    if (g('__audioDiag')) L.push('__audioDiag: ' + ser(g('__audioDiag'), { depth: 2, maxLen: 1200 }));
    switch (PAGE) {
      case 'n64': {
        var d = g('__audioDbg');
        L.push('worklet (__audioDbg): ' + (d && typeof d === 'object' ? 'backlog=' + show(d.b) + ' entries (~' + fx(d.b / 88200, 3) + ' s) underruns=' +
          show(d.u) + ' silenced=' + show(d.m) + ' resampleRatio=' + show(d.r) : 'absent (worklet not running — ScriptProcessor fallback or not started)'));
        L.push('myApp: skip=' + show(tryv(function () { return global.myApp.rivetsData.audioSkipCount; })) + ' gain=' +
               show(tryv(function () { return global.myApp.gainNode.gain.value; })) + ' ctx=' +
               show(tryv(function () { var c = global.myApp.audioContext; return c.state + ' ' + c.sampleRate + 'Hz base=' + ms(c.baseLatency) + ' out=' + ms(c.outputLatency); })));
        break;
      }
      case 'dreamcast':
        L.push('sink (__dcProbe().audio): ' + ser(tryv(function () { return global.__dcProbe().audio; }), { depth: 2, maxLen: 800 }));
        grepLog(/\[audio\]/, 4).forEach(function (l) { L.push('  log: ' + l); });
        break;
      case 'gamecube':
        L.push('core rate=' + show(g('_gcAudioRate')) + ' sink=' + (fn('_gcAudioPushSamples') ? 'worklet up' : 'NO SINK (samples discarded)') +
               ' gestured=' + show(g('_gcAudioGestured')) + ' jit frames=' + show(g('_audN')) + ' dropped=' + show(g('_audDropped')) +
               ' ctx=' + show(tryv(function () { var c = global._gcAudioCtx(); return c ? c.state + ' ' + c.sampleRate + 'Hz base=' + ms(c.baseLatency) + ' out=' + ms(c.outputLatency) : null; })));
        break;
      case 'ps1':
        L.push('SDL: ' + show(tryv(function () {
          var S = global.Module.SDL, a = S.audio, c = S.audioContext;
          if (!a) return 'Module.SDL.audio is null (SDL audio not open)';
          return 'freq=' + a.freq + ' ch=' + a.channels + ' samples=' + a.samples + ' paused=' + show(a.paused) + ' queued=' +
            (c ? fx(a.nextPlayTime - c.currentTime, 3) + 's' : 'n/a') + ' ctx=' + (c ? c.state + ' ' + c.sampleRate + 'Hz' : 'n/a');
        })));
        break;
      case 'genesis':
        L.push('core ring: queued=' + show(tryv(function () { return global.Module._gpx_audio_avail(); })) + ' of 32768 frames, core rate=' +
               show(tryv(function () { return global.Module._gpx_sample_rate(); })) + ' Hz');
        break;
      case 'snes': {
        var stuck = consoleEntries().filter(function (e) { return e && /soundbuffer stuck/.test(e[2]); }).length;
        L.push('"soundbuffer stuck" ring resets seen in the console: ' + stuck);
        break;
      }
      case 'gba':
        L.push('fifo: ' + show(tryv(function () { var a = global.myApp; return a.audioFifoCnt + ' of 4900 frames, speed=' + a.gameSpeed; })) +
               ' ctx=' + show(tryv(function () { var c = global.myApp.audioContext; return c.state + ' ' + c.sampleRate + 'Hz base=' + ms(c.baseLatency) + ' out=' + ms(c.outputLatency); })));
        break;
      default: break;
    }
  }

  // ---- INPUT + MAIN THREAD --------------------------------------------------
  function secInput(L) {
    L.push('gamepads: ' + show(tryv(function () {
      if (typeof nav.getGamepads !== 'function') return 'Gamepad API not exposed';
      var gp = nav.getGamepads() || [], out = [];
      for (var i = 0; i < gp.length; i++) if (gp[i]) out.push('#' + gp[i].index + ' "' + gp[i].id + '" mapping=' + (gp[i].mapping || 'none') +
        ' buttons=' + gp[i].buttons.length + ' axes=' + gp[i].axes.length + ' connected=' + gp[i].connected);
      return out.length ? out.join(' | ') : 'none seen (a pad appears only after a button press)';
    })));
    var XI = g('XboxInput');
    if (XI && typeof XI.report === 'function') L.push('XboxInput: ' + ser(tryv(function () { return XI.report(); }), { depth: 2, maxLen: 400 }));
    L.push('keyboard focus: ' + show(tryv(function () {
      var a = doc.activeElement; return a ? '<' + String(a.tagName).toLowerCase() + (a.id ? '#' + a.id : '') + '>' : null;
    })));
    if (PAGE === 'genesis') {
      L.push('input latency (__genNet().latency): ' + show(tryv(function () {
        var s = (global.__genNet().latency || []).map(function (x) { return +x.ms; }).filter(function (x) { return isFinite(x); });
        if (!s.length) return 'no samples (taken only while a room runs)';
        s.sort(function (a, b) { return a - b; });
        return s.length + ' samples: p50=' + fx(s[s.length >> 1], 1) + 'ms p95=' + fx(s[Math.floor(s.length * 0.95)], 1) + 'ms max=' + fx(s[s.length - 1], 1) + 'ms';
      })));
    }
  }
  function secMainThread(L) {
    var f = M && M.frames;
    if (!f) { L.push('not measured (press the button)'); return; }
    var lo = f.loaf;
    if (!lo.ok) L.push('long animation frames: not supported by this browser');
    else {
      var e = lo.entries.slice();
      var tot = 0, blk = 0, worst = 0;
      e.forEach(function (x) { tot += x.duration; blk += (x.blockingDuration || 0); if (x.duration > worst) worst = x.duration; });
      L.push('long animation frames (>=50 ms, buffered since load): ' + e.length + ' total ' + Math.round(tot) + ' ms, blocking ' + Math.round(blk) +
             ' ms, worst ' + Math.round(worst) + ' ms');
      e.sort(function (a, b) { return b.duration - a.duration; });
      e.slice(0, 5).forEach(function (x) {
        var top = (x.scripts || []).slice().sort(function (a, b) { return b.duration - a.duration; })[0];
        L.push('  +' + (x.startTime / 1000).toFixed(1) + 's ' + Math.round(x.duration) + 'ms' +
               (top ? ' ← ' + Math.round(top.duration) + 'ms ' + (top.invoker || '?') + ' ' + shortUrl(top.sourceURL || '') +
                 (top.sourceFunctionName ? ' ' + top.sourceFunctionName : '') : ''));
      });
    }
    var ev = f.event;
    if (!ev.ok) L.push('slow input events: Event Timing not supported by this browser');
    else {
      var es = ev.entries.slice().sort(function (a, b) { return b.duration - a.duration; });
      L.push('slow input events (buffered >=104 ms since load, plus >=16 ms during the sample): ' + es.length +
             (es.length ? ', worst ' + Math.round(es[0].duration) + ' ms (' + es[0].name + ', input delay ' +
               Math.round(es[0].processingStart - es[0].startTime) + ' ms)' : ''));
    }
    var lt = f.longtask;
    if (lt.ok) {
      var ltot = 0, lmax = 0;
      lt.entries.forEach(function (x) { ltot += x.duration; if (x.duration > lmax) lmax = x.duration; });
      L.push('long tasks (>=50 ms): ' + lt.entries.length + ', ' + Math.round(ltot) + ' ms total, worst ' + Math.round(lmax) + ' ms');
    }
  }

  // ---- RAW PAGE SEAMS -------------------------------------------------------
  // Read-only seams only. Deliberately NOT called: __dcPortPolls (async,
  // posts to the worker), __dcVmuPlant/__dcVmuPoke (write memory cards),
  // __gcForceDesync, __gcPad.edge/stick (inject input), __probe* (save/load
  // state), __n64LsAttach/__n64LsKick, and Session.rttReport() (pings peers).
  var SEAMS = [
    ['__n64Net', 1], ['__n64Pace', 1], ['__audioDbg', 0],
    ['__dcProbe', 1], ['__dcStall', 1], ['__dcNet', 1], ['__dcNetHud', 1], ['__dcNetRoom', 1],
    ['__gcLockstep', 1], ['__gcNetParty', 1], ['__gcNet', 1], ['__gcRecompRouting', 0], ['__gcNetHandoff', 0],
    ['__ps1Net', 1], ['__genNet', 1], ['__snesNet', 1], ['__gbaNet', 1], ['__mp', 1]
  ];
  function secSeams(L) {
    var any = false;
    SEAMS.forEach(function (s) {
      var v = tryv(function () { return global[s[0]]; }, undefined);
      if (v === undefined || v === null) return;
      any = true;
      if (s[1]) {
        if (typeof v !== 'function') return;
        v = tryv(function () { return global[s[0]](); });
      }
      L.push(s[0] + (s[1] ? '()' : '') + ': ' + ser(v, { depth: 4, maxLen: 6000, maxArr: 20 }));
    });
    if (!any) L.push('none on this page');
  }

  function secErrors(L) {
    L.push(errTotal + ' captured since load' + (errTotal > ERR_MAX ? ' (last ' + ERR_MAX + ' shown)' : ''));
    errors.forEach(function (e) { L.push('+' + (e.t / 1000).toFixed(1) + 's [' + e.kind + '] ' + e.text); });
  }
  function pageLogLines(n) {
    var t = logText(600000);
    if (t !== null) {
      var A = t.split('\n');
      if (A.length && A[A.length - 1] === '') A.pop();
      // How big the page's own log has grown: pages that append to an unbounded
      // <pre> pay for its whole length on every line they log.
      var total = tryv(function () { return $('log').textContent.length; }, null);
      return { src: '#log' + (typeof total === 'number' ? ', which holds ' + total + ' chars' : ''), lines: A.slice(-n) };
    }
    var gl = tryv(function () { return global.__genLogLines; }, null);
    if (gl && typeof gl.length === 'number' && typeof gl.slice === 'function') return { src: '__genLogLines', lines: gl.slice(-n).map(String) };
    return null;
  }

  // ---------------------------------------------------------------------------
  // collect() — synchronous. Uses the last press's measurement when there is
  // one; says "not measured" where there is not.
  // ---------------------------------------------------------------------------
  var SECTIONS = [
    ['PAGE', secPage], ['DEVICE', secDevice], ['DISPLAY', secDisplay], ['GPU', secGpu], ['CAPABILITY', secCapability],
    ['RATE', secRate], ['NETPLAY', secNetplay], ['AUDIO', secAudio], ['INPUT', secInput], ['MAIN THREAD', secMainThread],
    ['PAGE SEAMS', secSeams], ['ERRORS', secErrors]
  ];
  function collect() {
    var out = ['===== BEMENTAL DEBUG REPORT v' + VERSION + ' — paste all of this to the developer ====='];
    if (M) out.push('(measured at press: ' + new Date(M.at).toISOString() + ', sample took ' + Math.round(M.tookMs) + ' ms)');
    SECTIONS.forEach(function (sct) {
      out.push('');
      out.push('## ' + sct[0]);
      var L = [];
      try { sct[1](L); } catch (e) { L.push('n/a (section threw: ' + clip(errMsg(e), 200) + ')'); }
      for (var i = 0; i < L.length; i++) out.push(L[i]);
    });
    var pl = null;
    out.push('');
    try {
      pl = pageLogLines(200);
      out.push('## PAGE LOG' + (pl ? ' (last ' + pl.lines.length + ' lines of ' + pl.src + ')' : ''));
      if (pl) for (var i = 0; i < pl.lines.length; i++) out.push(clip(pl.lines[i], 600));
      else out.push('this page keeps no log of its own — see CONSOLE');
    } catch (e) { out.push('## PAGE LOG'); out.push('n/a (' + errMsg(e) + ')'); }
    out.push('');
    try {
      var seen = {};
      if (pl) pl.lines.forEach(function (l) { seen[l] = 1; });
      var ce = consoleEntries().filter(function (e) {
        if (!e) return false;
        if (!pl) return true;
        var t = e[2], sp = t.indexOf(' ');
        return !(seen[t] || (sp > 0 && seen[t.slice(sp + 1)]));
      });
      var cap = pl ? 120 : 200;
      ce = ce.slice(-cap);
      out.push('## CONSOLE (' + ce.length + ' lines' + (pl ? ' not already in PAGE LOG' : '') + '; ' + conN + ' console calls since load)');
      ce.forEach(function (e) { out.push('+' + (e[0] / 1000).toFixed(1) + 's ' + (e[1] === 'log' ? '' : '[' + e[1] + '] ') + clip(e[2], 600)); });
    } catch (e) { out.push('## CONSOLE'); out.push('n/a (' + errMsg(e) + ')'); }
    out.push('');
    out.push('===== END =====');
    var text = out.join('\n');
    try { text = scrub(text); } catch (e) {}
    if (text.length > 600000) text = text.slice(0, 600000) + '\n…(report truncated at 600000 chars)\n===== END =====';
    return text;
  }

  // ---------------------------------------------------------------------------
  // COPY — see "COPYING ON A PHONE" at the top.
  // ---------------------------------------------------------------------------
  var lastText = null, busy = null;
  function writeTextP(text) {
    try {
      if (nav.clipboard && typeof nav.clipboard.writeText === 'function') return nav.clipboard.writeText(text);
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('no navigator.clipboard (insecure origin or old browser)'));
  }
  function execCopy(text) {
    var ta = null, ok = false;
    try {
      ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;-webkit-user-select:text;user-select:text';
      (doc.body || doc.documentElement).appendChild(ta);
      ta.focus(); ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      ok = !!doc.execCommand('copy');
    } catch (e) { ok = false; }
    try { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); } catch (e) {}
    return ok;
  }
  function host() {
    try {
      var fe = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (fe && fe.appendChild && !/^(CANVAS|VIDEO|IMG)$/.test(String(fe.tagName))) return fe;
    } catch (e) {}
    try { return doc.body || doc.documentElement; } catch (e) { return null; }
  }
  var toastEl = null;
  function toast(msg) {
    try {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = doc.createElement('div');
      toastEl.setAttribute('role', 'status');
      toastEl.textContent = msg;
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);z-index:2147483647;max-width:86vw;' +
        'background:rgba(15,15,15,.92);color:#fff;font:13px/1.35 system-ui,sans-serif;padding:9px 14px;border-radius:8px;' +
        'border:1px solid #555;pointer-events:none;text-align:center';
      host().appendChild(toastEl);
      var el = toastEl;
      setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {} }, 3200);
    } catch (e) {}
  }
  function setLabel(btn, s) { try { if (btn) btn.textContent = s; } catch (e) {} }
  var overlayEl = null;
  function closeOverlay() { try { if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl); } catch (e) {} overlayEl = null; }
  function showOverlay(text, why) {
    closeOverlay();
    try {
      var fe = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (fe && /^(CANVAS|VIDEO|IMG)$/.test(String(fe.tagName)) && doc.exitFullscreen) doc.exitFullscreen();
    } catch (e) {}
    var o = doc.createElement('div');
    o.id = 'debugReportOverlay';
    o.setAttribute('data-debugreport', 'overlay');
    o.style.cssText = 'position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.72);' +
      'display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box;' +
      '-webkit-user-select:text;user-select:text;touch-action:auto;font:14px system-ui,sans-serif;color:#eee';
    var box = doc.createElement('div');
    box.style.cssText = 'background:#1b1b1b;border:1px solid #555;border-radius:10px;padding:12px;width:min(760px,100%);' +
      'max-height:100%;display:flex;flex-direction:column;gap:8px;box-sizing:border-box';
    var h = doc.createElement('div');
    h.textContent = why || 'Debug report';
    h.style.cssText = 'font-weight:600;line-height:1.35';
    var ta = doc.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.setAttribute('data-debugreport', 'text');
    ta.style.cssText = 'width:100%;height:58vh;box-sizing:border-box;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace;' +
      'background:#0e0e0e;color:#ddd;border:1px solid #444;border-radius:6px;padding:6px;-webkit-user-select:text;user-select:text;' +
      '-webkit-touch-callout:default;touch-action:auto;white-space:pre;overflow:auto';
    var row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    function mk(label, act) {
      var b = doc.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.style.cssText = 'min-height:40px;padding:8px 14px;font:14px system-ui,sans-serif;background:#2c2c2c;color:#eee;border:1px solid #555;border-radius:6px;cursor:pointer';
      b.addEventListener('click', function (e) { try { e.stopPropagation(); } catch (x) {} act(b); });
      row.appendChild(b);
      return b;
    }
    mk('Copy', function (b) {
      // A fresh gesture with the text already built: the synchronous paths work here.
      try { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); } catch (e) {}
      var sync = false;
      try { sync = !!doc.execCommand('copy'); } catch (e) {}
      if (sync) { b.textContent = '✓ Copied'; return; }
      writeTextP(text).then(function () { b.textContent = '✓ Copied'; },
        function () { b.textContent = 'Blocked — select the text and copy it'; });
    });
    if (tryv(function () { return typeof nav.share === 'function'; }, false) === true) mk('Share', function (b) {
      try { nav.share({ title: 'Debug report', text: text }).then(null, function () { b.textContent = 'Share cancelled'; }); } catch (e) {}
    });
    mk('Save .txt', function () {
      try {
        var a = doc.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        a.download = 'debug-' + PAGE + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
        (doc.body || doc.documentElement).appendChild(a); a.click();
        setTimeout(function () { try { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); } catch (e) {} }, 1500);
      } catch (e) {}
    });
    mk('Close', closeOverlay);
    o.addEventListener('click', function (e) { if (e.target === o) closeOverlay(); });
    // Keys typed here (Ctrl+C, arrows in the text) must not also play the game.
    ['keydown', 'keyup'].forEach(function (t) { o.addEventListener(t, function (e) { try { e.stopPropagation(); } catch (x) {} }); });
    box.appendChild(h); box.appendChild(ta); box.appendChild(row);
    o.appendChild(box);
    host().appendChild(o);
    overlayEl = o;
    try { ta.focus(); ta.select(); } catch (e) {}
    return o;
  }

  function copy(btn) {
    if (busy) return busy;
    var orig = btn ? btn.textContent : null;
    setLabel(btn, '⏳ Measuring…');
    var textP = collectAsync().then(null, function (e) {
      var t = collect();
      return t + '\n(async sample failed: ' + errMsg(e) + ')';
    });
    // Route 1, started INSIDE the gesture: a ClipboardItem holding a promise.
    var viaItem = null;
    try {
      if (nav.clipboard && typeof nav.clipboard.write === 'function' && typeof global.ClipboardItem === 'function') {
        var item = new global.ClipboardItem({ 'text/plain': textP.then(function (t) { return new Blob([t], { type: 'text/plain' }); }) });
        viaItem = nav.clipboard.write([item]);
      }
    } catch (e) { viaItem = null; }
    function fallback(text) {
      return writeTextP(text).then(function () { return 'clipboard.writeText'; }, function (e) {
        if (execCopy(text)) return 'execCommand';
        showOverlay(text, 'The browser blocked the automatic copy (' + clip(errMsg(e), 80) + '). Press Copy below, or select all the text and copy it.');
        return 'overlay';
      });
    }
    busy = textP.then(function (text) {
      lastText = text;
      var p = viaItem ? viaItem.then(function () { return 'clipboard.write'; }, function () { return fallback(text); }) : fallback(text);
      return p.then(function (how) {
        var lines = text.split('\n').length;
        var ok = how !== 'overlay';
        setLabel(btn, ok ? '✓ Copied' : '⚠ See report');
        if (ok) toast('Debug report copied (' + lines + ' lines) — paste it to the developer.');
        setTimeout(function () { setLabel(btn, orig || LABEL); }, 2600);
        busy = null;
        return { ok: ok, how: how, text: text };
      });
    }).then(null, function (e) {
      busy = null;
      setLabel(btn, orig || LABEL);
      var t = lastText || tryv(collect, 'n/a');
      showOverlay(t, 'Could not copy automatically (' + errMsg(e) + ').');
      return { ok: false, how: 'overlay', text: t };
    });
    return busy;
  }

  // ---------------------------------------------------------------------------
  // BUTTONS
  // ---------------------------------------------------------------------------
  function pick(sel) {
    try {
      var all = doc.querySelectorAll(sel);
      return all && all.length ? all[all.length - 1] : null;
    } catch (e) { return null; }
  }
  function makeBtn(kind, spot) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.textContent = LABEL;
    b.title = 'Copy a debug report (device, speed, room, audio, errors, recent log) to paste to the developer';
    b.setAttribute('data-debugreport', spot);
    b.className = 'debugReportBtn';
    if (kind === 'small') b.style.cssText = SMALL;
    else if (kind === 'link') b.className = 'linkBtn debugReportBtn';
    else if (kind === 'inline') b.style.cssText = 'font:inherit;font-size:12px;padding:1px 8px;background:#222;color:#bbb;border:1px solid #444;border-radius:4px;cursor:pointer';
    else if (kind === 'bs') b.className = 'btn btn-outline-secondary btn-sm debugReportBtn';
    else if (kind === 'bsmenu') b.className = 'btn btn-outline-info debugReportBtn';
    else if (kind === 'ghost') b.className = 'ghost debugReportBtn';
    else if (kind === 'mp') { b.className = 'sec debugReportBtn'; b.style.cssText = 'margin-left:12px;min-height:36px;padding:6px 12px;font-size:13px'; }
    // Keep keyboard focus on the game: a focused button re-fires on Enter/Space,
    // and Enter is Start on several of these pages.
    b.addEventListener('mousedown', function (e) { try { e.preventDefault(); } catch (x) {} });
    b.addEventListener('click', function () {
      try { b.blur(); } catch (x) {}
      copy(b);
    });
    return b;
  }
  function inject() {
    var spots = SPOTS[PAGE] || SPOTS._default, made = 0;
    ['bar', 'menu', 'splash', 'party'].forEach(function (k) {
      try {
        var s = spots[k];
        if (!s) return;
        if (doc.querySelector('[data-debugreport="' + k + '"]')) return;
        var a = pick(s[0]);
        if (!a) return;
        var b = makeBtn(s[2] || 'plain', k);
        if (s[1] === 'after') a.parentNode.insertBefore(b, a.nextSibling);
        else if (s[1] === 'before') a.parentNode.insertBefore(b, a);
        else a.appendChild(b);
        made++;
      } catch (e) {}
    });
    return made;
  }
  try {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', inject);
    else inject();
  } catch (e) {}

  global.DebugReport = {
    version: VERSION,
    page: PAGE,
    collect: collect,
    collectAsync: collectAsync,
    copy: copy,
    inject: inject,
    showOverlay: showOverlay,
    get lastText() { return lastText; },
    get errors() { return errors.slice(); }
  };
})(typeof window !== 'undefined' ? window : this);
