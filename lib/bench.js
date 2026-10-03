/*
 * lib/bench.js — REAL-DEVICE BENCHMARK, enabled ONLY by ?bench=1.
 *
 * THE RULE IT VERIFIES: exactly 1.000x guest speed, zero slowdown, on any
 * device. One URL per emulator page; open it on a phone or a computer and the
 * page runs a fixed title for 30 s solo, then (where the page has rooms) 30 s in
 * a LOOPBACK 2-player room, and prints PASS/FAIL plus a "Copy results" button.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────────
 *   Without ?bench=1: the file parses, reads location.search once and returns.
 *   No listener, no timer, no wrapper, no global — nothing on any page changes.
 *   With ?bench=1 it observes, it does not drive the measured path:
 *     * a Worker subclass that ADDS one 'message' listener to each worker the
 *       page creates (n64 stats, ps1 frames) — the page's own handler is untouched;
 *     * on main-thread cores (snes, gba) the per-frame export is wrapped with two
 *       performance.now() calls;
 *     * one 250 ms poll of counters the page already publishes.
 *   It never forces a page's measurement arm on. ?costdbg=1 on n64 (which wraps
 *   every GL call in the core worker) is OPT-IN: add it to the URL to get the
 *   per-burst cause labels; without it the bench takes the core's own
 *   retro_run timer, which costs nothing extra.
 *   The WebGL/WebGPU renderer probe runs AFTER both measurement windows.
 *
 * ── WHAT "ms" MEANS, PER PAGE (the source is fixed per page, never mixed) ───
 *   n64       core cost per field: the core's own retro_run timer
 *             (_neil_frame_cost_ms / _n), delivered with the worker's stat
 *             messages every ~50 ms. Without ?costdbg=1 the resolution is the
 *             stat window (~3 fields): one slow field among fast ones can hide
 *             in the window mean, so `over` is a LOWER BOUND. With ?costdbg=1,
 *             `over` and `max` are the worker's exact per-field counts and the
 *             bursts carry the bucket that dominated (jit/shader/prog/read/...).
 *   snes, gba main-thread time inside the core's one-frame export, per frame. Exact.
 *   ps1       SOLO: window-resolved wall ms per guest frame, from the audio
 *             ring's producer counter per 250 ms poll (the worker posts a picture
 *             only when the game flips one, so picture intervals are not frames).
 *             ROOM: exact — the worker's own run time for every gated frame
 *             (netFrame runMs; under rollback `ms` incl. re-simulation).
 *   n64 ROOM  the room driver steps the core and the field-timer stream stops,
 *             so the room window is engine-frame intervals per poll.
 *   gamecube, dreamcast  window-resolved: mean frame interval per poll from the
 *             page's own published counters. Coarse.
 *   `budgetMs` = 1000 / guest frame rate. `over` counts frames whose COST
 *   exceeded budgetMs; for interval / window-resolved samples (which carry
 *   scheduling jitter) the line is 1.5 x budgetMs — a missed frame slot.
 *
 * ── SPEED (1.000 = hardware) ───────────────────────────────────────────────
 *   n64  audio witness (88200 int16/s = 1.000x) averaged over the window,
 *        VI interrupts when the game is silent.   ps1  audio ring frames / 44100.
 *   snes guest frames / 60.0988.   gba  frames / 59.7275 (fast-forward off).
 *   gamecube __gcRate.speed.   dreamcast __dcProbe().guestX.
 *
 * ── ROOMS (loopback) ───────────────────────────────────────────────────────
 *   No in-page loopback mode existed, so the bench uses the pages' own lobby
 *   hand-off (?np=CODE&host=1 / &join=1) over the same-browser 'local'
 *   transport (?net=local, BroadcastChannel). After the solo window the page
 *   reloads as the HOST with the solo result carried in window.name, and opens
 *   a small visible iframe of the same page as the JOINER. The host bench
 *   admits that one joiner programmatically (the role a person pressing Allow
 *   plays). ⚠ Both consoles run on THIS device, so the room window measures
 *   two cores sharing one CPU — a harder test than a real two-device room.
 *
 * ── RESULTS ────────────────────────────────────────────────────────────────
 *   Shape (fixed — a collector page reads it):
 *   {v,page,title,ts,device{ua,renderer,model,cores,mem,screen},cap,
 *    solo{ms{mean,p50,p95,p99,max},budgetMs,over,frames,speed,fps},
 *    room:null|{...same, mode,delay,resims,players}, bursts[{ms,cause,t}], pass}
 *   pass = solo (and room when present) has over==0 and |speed-1|<=0.005.
 *   A room that was attempted and never ran gives room:null AND pass:false.
 *
 *   SINK: set BENCH_SINK_DEFAULT below, or window.BENCH_SINK, or ?sink=<url>.
 *
 * URL knobs (all optional): benchsec=30 (window length), benchwarm=2 (seconds
 * skipped after the first frame), benchgame=<index|label>, benchroom=0 (solo
 * only), benchauto=1 (never show the tap-to-start prompt).
 */
(function (global) {
  'use strict';
  var Q;
  try { Q = new URLSearchParams(global.location.search); } catch (e) { return; }
  if (Q.get('bench') !== '1') return;

  // ═══ THE ONE CONSTANT TO FILL IN when the collector endpoint exists. ═══
  var BENCH_SINK_DEFAULT = '';

  var VERSION = 1;
  var PHASE = Q.get('benchphase') || 'solo';          // solo | room | guest
  var SEC = Math.max(3, +(Q.get('benchsec') || 30));
  var WARM = Math.max(0, +(Q.get('benchwarm') || 2));
  var ROOMS_ON = Q.get('benchroom') !== '0';
  var doc = global.document;
  var now = function () { return performance.now(); };
  var T0 = now();

  function pageId() {
    var p = String(global.location.pathname || '').toLowerCase();
    if (/(^|\/)n64(\/|\.html|$)/.test(p)) return 'n64';
    var m = p.match(/([a-z0-9_\-]+)\.html?$/);
    return m ? m[1] : 'unknown';
  }
  var PAGE = pageId();
  function $(id) { return doc.getElementById(id); }
  function tryv(f, d) { try { var v = f(); return v === undefined ? d : v; } catch (e) { return d; } }
  function log(s) { try { console.log('[bench] ' + s); } catch (e) {} }

  // ---------------------------------------------------------------------------
  // THE MEASUREMENT WINDOW — one per phase.
  // ---------------------------------------------------------------------------
  var W = null;   // { kind, budget, costs[], over, bursts[], t0, ... }
  function newWindow(kind, budget) {
    return { kind: kind, budget: budget, costs: [], over: 0, overExact: null, maxExact: null,
             bursts: [], t0: now(), tEnd: 0, speeds: [], fpsSamples: [], frames0: null, frames1: null,
             pres0: null, pres1: null, sp0: null, sp1: null };
  }
  function addBurst(ms, cause, tAbs) {
    if (!W) return;
    var b = { ms: +ms.toFixed(1), cause: cause || 'unknown', t: Math.round((tAbs == null ? now() : tAbs) - BENCH_T0()) };
    W.bursts.push(b);
    W.bursts.sort(function (a, c) { return c.ms - a.ms; });
    if (W.bursts.length > 12) W.bursts.length = 12;
  }
  // One per-frame sample. `n` repeats a window mean over the frames it covers.
  function addCost(ms, n, cause) {
    if (!W || W.tEnd || !(ms >= 0) || !isFinite(ms)) return;
    n = n || 1;
    var lim = W.kind === 'cost' ? W.budget : W.budget * 1.5;
    for (var i = 0; i < n; i++) W.costs.push(ms);
    if (ms > lim) { W.over += n; addBurst(ms, cause); }
  }
  function stats(a) {
    if (!a.length) return { mean: null, p50: null, p95: null, p99: null, max: null };
    var s = a.slice().sort(function (x, y) { return x - y; }), sum = 0;
    for (var i = 0; i < s.length; i++) sum += s[i];
    var q = function (p) { return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
    return { mean: +(sum / s.length).toFixed(2), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +s[s.length - 1].toFixed(2) };
  }
  var benchStart = null;
  function BENCH_T0() { return benchStart == null ? T0 : benchStart; }

  // ---------------------------------------------------------------------------
  // OBSERVATION HOOKS installed at load (bench mode only).
  // ---------------------------------------------------------------------------
  var workerTaps = [];
  (function tapWorkers() {
    var Orig = global.Worker;
    if (typeof Orig !== 'function') return;
    try {
      var BW = function (url, opts) {
        var w = new Orig(url, opts);
        try { w.addEventListener('message', function (e) { for (var i = 0; i < workerTaps.length; i++) { try { workerTaps[i](e.data, w); } catch (x) {} } }); } catch (x) {}
        return w;
      };
      BW.prototype = Orig.prototype;
      global.Worker = BW;
    } catch (e) {}
  })();

  // Wrap a Module export: two now() calls per frame. Re-checked every second,
  // because emscripten can re-assign an export after the runtime initialises
  // (a wrapper installed on the early stub would then time nothing).
  function wrapExport(name, onCost) {
    var said = false;
    (function attempt() {
      var M = global.Module;
      if (M && typeof M[name] === 'function' && !M[name].__bench) {
        var f = M[name];
        var w = function () { var t0 = now(); try { return f.apply(this, arguments); } finally { onCost(now() - t0); } };
        w.__bench = true; M[name] = w;
        if (!said) { said = true; log('timing ' + name + ' per frame'); }
      }
      setTimeout(attempt, M && M[name] && M[name].__bench ? 1000 : 250);
    })();
  }

  // ---------------------------------------------------------------------------
  // PER-PAGE ADAPTERS — every reading is a counter the page already publishes.
  // ---------------------------------------------------------------------------
  function selectRom(selId, idx) {
    var s = $(selId); if (!s) return;
    if (idx >= 0 && idx < s.options.length) { s.selectedIndex = idx; s.dispatchEvent(new Event('change')); }
  }
  function findIdx(selId, want) {
    var s = $(selId); if (!s) return -1;
    if (want == null || want === '') return 0;
    if (/^\d+$/.test(want)) return +want < s.options.length ? +want : 0;
    for (var i = 0; i < s.options.length; i++) {
      var o = s.options[i];
      if (o.value === want || o.textContent.trim() === want) return i;
    }
    return 0;
  }
  function visible(el) { return !!(el && el.offsetParent !== null && getComputedStyle(el).display !== 'none'); }
  function held(el) { return !el || el.disabled || el.getAttribute('aria-disabled') === 'true'; }
  // The page's own Start: the mobile splash's when that splash is what is on
  // screen, else the desktop button. Ready == there is a control to press NOW.
  function startable() {
    var sp = $('mobileSplash'), ms = $('mobileSplashStart'), b = $('btnStart');
    if (sp && visible(sp) && ms && !held(ms)) return { el: ms, splash: sp };
    if (b && visible(b) && !held(b)) return { el: b };
    return null;
  }
  function pressStart() {
    var s = startable(); if (!s) return false;
    var mSel = $('mobileRomSelect'), dSel = $('romSelect');
    if (mSel && dSel) { mSel.value = dSel.value; }
    if (s.splash) {
      try { s.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch (e) {}
      setTimeout(function () { if (visible(s.splash)) s.el.click(); }, 400);
      return true;
    }
    s.el.click(); return true;
  }
  function genericStartReady() { return !!(($('romSelect') && $('romSelect').options.length) && startable()); }
  function selLabel() { var s = $('romSelect'); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent.trim() : null; }

  // Newest live Netplay session's engine report, for pages without their own seam.
  function genericNet() {
    var S = tryv(function () { return global.Netplay.sessions; }, null);
    if (!S || !S.length) return null;
    var s = S[S.length - 1], ls = tryv(function () { return s.ls; }, null);
    var rep = ls && typeof ls.report === 'function' ? tryv(function () { return ls.report(); }, null) : null;
    if (!rep) return null;
    var players = 0; tryv(function () { (ls.roster || []).forEach(function (x) { if (x != null) players++; }); });
    return { running: rep.state === 'running' || rep.state === 'stalled', frame: rep.frame,
             mode: rep.rollback ? 'rollback' : (rep.delay > 0 ? 'delay' : 'lockstep'),
             delay: rep.delay, resims: rep.rollback ? rep.rollback.resimFrames : 0, players: players };
  }

  var A = {};
  // ---- n64 ------------------------------------------------------------------
  A.n64 = (function () {
    var last = null, lastDbgOver = null, dbgMaxSeen = {}, viHz = 60, roomLast = null;
    function cause(rec) {
      var best = 'core', bv = -1;
      for (var k in rec) { if (k === 'f' || k === 'ms' || k === 'at') continue; if (rec[k] > bv) { bv = rec[k]; best = k; } }
      return best;
    }
    // (frame, page time) pairs from the stat stream, so a burst the worker
    // reports by FIELD NUMBER can be placed on the page's clock.
    var fmap = [];
    function timeOfFrame(f) {
      for (var i = fmap.length - 1; i >= 0; i--) if (fmap[i][0] <= f) return fmap[i][1];
      return fmap.length ? fmap[0][1] : now();
    }
    workerTaps.push(function (d) {
      if (!d || d.t !== 'stat') return;
      if (W && !W.tEnd) { fmap.push([d.frame, now()]); if (fmap.length > 4000) fmap.splice(0, 1000); }
      if (W && !W.tEnd && last) {
        var dn = (d.costN - last.costN) >>> 0, dms = d.costMs - last.costMs;
        if (dn > 0 && dn < 1000 && dms >= 0) {
          var mean = dms / dn;
          W._statCost = true;
          if (d.dbg) { for (var i = 0; i < dn; i++) W.costs.push(mean); }
          else addCost(mean, dn);
        }
        if (d.dbg) {
          // Exact per-field counts from the worker's own wrapper (?costdbg=1).
          if (lastDbgOver == null) lastDbgOver = d.dbg.over;
          W.overExact = d.dbg.over - lastDbgOver;
          (d.dbg.max || []).forEach(function (rec) {
            var key = rec.f + ':' + rec.ms;
            if (dbgMaxSeen[key] || rec.f < W.f0) return;
            dbgMaxSeen[key] = 1;
            if (W.maxExact == null || rec.ms > W.maxExact) W.maxExact = rec.ms;
            addBurst(rec.ms, cause(rec), timeOfFrame(rec.f));
          });
        }
      }
      last = d;
    });
    return {
      label: function () { return selLabel(); },
      start: function (want) {
        selectRom('romSelect', findIdx('romSelect', want));
        return pressStart();
      },
      startReady: genericStartReady,
      kind: 'cost',
      hz: function () { var r = global.__n64Rate; if (r && r.viHz) viHz = r.viHz; return viHz; },
      frames: function () {
        if (PHASE === 'room') { var n = this.net(); return n && n.frame != null ? n.frame : null; }
        var st = tryv(function () { return global.__n64Worker.state().stat; }, null);
        if (st && st.frame != null) return st.frame;
        return tryv(function () { return global.Module._neil_vi_total() >>> 0; }, null);
      },
      presented: function () { if (PHASE === 'room') return null; var st = tryv(function () { return global.__n64Worker.state().stat; }, null); return st ? st.shown : null; },
      onWindow: function (w) { w.f0 = this.frames() || 0; lastDbgOver = last && last.dbg ? last.dbg.over : null; },
      poll: function (w) {
        // Main-thread core (?worker=0): read the same accumulators directly.
        var M = global.Module;
        if (!tryv(function () { return global.__n64Worker.state().on; }, false) && M && M._neil_frame_cost_n) {
          var d = { costMs: M._neil_frame_cost_ms(), costN: M._neil_frame_cost_n() >>> 0 };
          if (last) { var dn = (d.costN - last.costN) >>> 0; if (dn > 0) addCost((d.costMs - last.costMs) / dn, dn); }
          last = d;
        }
        var r = global.__n64Rate;
        if (r && r !== w._lastRate) {
          w._lastRate = r;
          var sp = (r.audioSpeed != null && r.audioSpeed > 0.01) ? r.audioSpeed : r.viSpeed;
          if (sp != null && !r.seam) w.speeds.push(sp);
          if (r.shown != null) w.fpsSamples.push(r.shown);
        }
        // In a room the core is stepped by the room driver: frames come from the
        // engine, and the worker's stat stream (field timer) may stop.
        // Only when the field timer is silent: the samples are then frame
        // INTERVALS (window-resolved), judged against 1.5 x budget.
        if (PHASE === 'room' && !w._statCost) {
          var n = this.net();
          if (n && n.frame != null) {
            w.kind = 'interval';
            if (roomLast) { var df = n.frame - roomLast.f, dt = now() - roomLast.t; if (df > 0) addCost(dt / df, df, 'slow room window'); }
            roomLast = { f: n.frame, t: now() };
          }
        }
      },
      speed: function (w) {
        if (w.speeds.length >= 3) { var s = 0; for (var i = 0; i < w.speeds.length; i++) s += w.speeds[i]; return s / w.speeds.length; }
        return null;
      },
      rooms: true,
      net: function () {
        var n = tryv(function () { return global.__n64Net(); }, null);
        var g = genericNet();
        if (!n && !g) return null;
        var o = g || {};
        if (n) {
          var nm = n.mode || n.netMode; if (nm) o.mode = nm === 'rollback' ? 'rollback' : ((n.delay != null ? n.delay : o.delay) > 0 ? 'delay' : 'lockstep');
          if (n.delay != null) o.delay = n.delay;
          if (n.frame != null) o.frame = n.frame;
          var rb = n.rollback && (n.rollback.engine || n.rollback);
          if (rb && rb.resimFrames != null) o.resims = rb.resimFrames;
          if (n.party && n.party.state) o.running = n.party.state === 'playing';
          if (n.party && n.party.rows) o.players = n.party.rows.filter(function (x) { return x && x.state && x.state !== 'open'; }).length || o.players;
        }
        return o;
      }
    };
  })();

  // ---- ps1 ------------------------------------------------------------------
  // Solo: the core worker posts a picture only when the game flips one, so
  // picture intervals are NOT guest frames (a static menu would read as late
  // frames). The guest clock here is the audio ring: produced frames / 44100
  // per 250 ms poll, turned into frames at the disc's rate — window-resolved.
  // Room: the worker reports every gated frame's own run time (netFrame
  // runMs, or ms incl. re-simulation under rollback) — exact per frame.
  A.ps1 = (function () {
    var pics = 0, lastAud = null;
    workerTaps.push(function (d) {
      if (!d) return;
      if (d.cmd === 'render' || d.cmd === 'renderTick') { pics++; return; }
      if (d.cmd === 'netFrame' && PHASE === 'room' && W && !W.tEnd && !d.err) {
        if (d.ms != null) addCost(d.ms, 1, d.resim > 0 ? 'rollback re-simulation (' + d.resim + ' frames)' : 'room frame');
        else if (d.ran > 0 && d.runMs != null) addCost(d.runMs / d.ran, d.ran, 'room frame');
      }
    });
    function hz() { var n = tryv(function () { return global.__ps1Net(); }, null); return (n && n.hz) || 59.94; }
    return {
      label: function () { return selLabel(); },
      start: function (want) { selectRom('romSelect', findIdx('romSelect', want)); return pressStart(); },
      startReady: genericStartReady,
      kind: function () { return PHASE === 'room' ? 'cost' : 'window'; },
      hz: hz,
      frames: function () {
        if (PHASE === 'room') { var n = tryv(function () { return global.__ps1Net(); }, null); return n ? n.workerFrames : null; }
        var a = tryv(function () { return global.__ps1AudioSink(); }, null);
        return a && a.on && a.produced > 0 ? Math.floor(a.produced / 44100 * hz()) : (pics || null);
      },
      presented: null,   // fps from the page's own #fps line (pictures/s), solo and room alike
      onWindow: function () { lastAud = null; },
      poll: function (w) {
        var ft = tryv(function () { return $('fps').textContent; }, '');
        var fm = /FPS: ([\d.]+)/.exec(ft || '');
        if (fm && ft !== w._lastFpsText) { w._lastFpsText = ft; w.fpsSamples.push(+fm[1]); }
        var a = tryv(function () { return global.__ps1AudioSink(); }, null);
        if (!(a && a.on && a.produced != null)) return;
        var t = now();
        if (w.sp0 == null) w.sp0 = { p: a.produced, t: t };
        w.sp1 = { p: a.produced, t: t };
        if (PHASE !== 'room' && lastAud) {
          var dt = t - lastAud.t, gf = ((a.produced - lastAud.p) >>> 0) / 44100 * hz();
          if (gf >= 1) addCost(dt / gf, Math.round(gf), 'slow window');
          else if (dt > w.budget * 1.5) addCost(dt, 1, 'stall (no audio produced)');
        }
        lastAud = { p: a.produced, t: t };
      },
      speed: function (w) {
        if (w.sp0 && w.sp1 && w.sp1.t - w.sp0.t > 1000) return ((w.sp1.p - w.sp0.p) >>> 0) / ((w.sp1.t - w.sp0.t) / 1000) / 44100;
        return null;   // falls back to frames / hz
      },
      rooms: true,
      net: function () {
        var n = tryv(function () { return global.__ps1Net(); }, null);
        if (!n) return genericNet();
        var rb = n.rollback && n.rollback.engine;
        return { running: !!n.running, frame: n.workerFrames,
                 mode: n.netMode === 'rollback' ? 'rollback' : (n.delay > 0 ? 'delay' : 'lockstep'),
                 delay: n.delay, resims: rb ? rb.resimFrames : (n.rollback && n.rollback.page ? n.rollback.page.resimFrames : 0),
                 players: n.party ? n.party.seated : null };
      }
    };
  })();

  // ---- snes / gba: main-thread cores, exact per-frame cost ------------------
  A.snes = {
    label: function () { return selLabel(); },
    start: function (want) { selectRom('romSelect', findIdx('romSelect', want)); return pressStart(); },
    startReady: genericStartReady,
    kind: 'cost',
    install: function () { wrapExport('_mainLoop', function (ms) { addCost(ms, 1, 'core frame'); }); },
    hz: function () { return 60.0988; },
    frames: function () { return global.__snesFrames | 0; },
    presented: null,
    poll: function (w) {
      var t = tryv(function () { return $('fps').textContent; }, '');
      var m = /presented ([\d.]+)\/s/.exec(t || '');
      if (m && t !== w._lastFpsText) { w._lastFpsText = t; w.fpsSamples.push(+m[1]); }
    },
    rooms: true,
    net: function () {
      var n = tryv(function () { return global.__snesNet(); }, null), g = genericNet();
      if (g && n && n.netMode) g.mode = n.netMode === 'rollback' ? 'rollback' : g.mode;
      return g;
    }
  };
  A.gba = {
    label: function () { var s = $('romselect'); return s && s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent.trim() : tryv(function () { return global.myApp.rom_name; }, null); },
    start: function (want) {
      selectRom('romselect', findIdx('romselect', want));
      var b = $('btnPlayGame'), m = $('spLoadBtn');
      if (b && visible(b) && !held(b)) { b.click(); return true; }
      if (m && visible(m) && !held(m)) { m.click(); return true; }
      if (global.myClass && global.myClass.loadRom) { global.myClass.loadRom(); return true; }
      return false;
    },
    startReady: function () { return !!(global.myApp && global.myApp.isWasmReady && $('romselect') && $('romselect').options.length); },
    kind: 'cost',
    install: function () {
      wrapExport('_emuRunFrame', function (ms) { if (!global.myApp || global.myApp.gameSpeed <= 1) addCost(ms, 1, 'core frame'); });
      // Presents: one putImageData per tick that ran a frame (script.js), counted
      // on the page's own 2D context instance.
      (function hookDraw() {
        var c = tryv(function () { return global.myApp.drawContext; }, null);
        if (c && !c.__bench) {
          var put = c.putImageData; c.__bench = true;
          c.putImageData = function () { A.gba._pres++; return put.apply(this, arguments); };
          return;
        }
        setTimeout(hookDraw, 500);
      })();
    },
    _pres: 0,
    hz: function () { return 59.7275; },
    frames: function () { return tryv(function () { return global.myApp.frameCnt; }, null); },
    presented: function () { return A.gba._pres; },
    poll: function () {},
    rooms: false
  };

  // ---- gamecube / dreamcast: window-resolved from published counters ---------
  A.gamecube = {
    label: function () { return selLabel(); },
    start: function (want) { selectRom('romSelect', findIdx('romSelect', want)); return pressStart(); },
    startReady: genericStartReady,
    kind: 'window',
    hz: function () { var r = global.__gcRate; return (r && (r.nativeHz || r.guestHz)) || 60; },
    // JIT path: the renderer's published-frame seqlock. RECOMP path (MP4 routes
    // there with no query parameter, gamecube.html): that seqlock stays at 0 and
    // the guest's own frame counter is __gcPad.seq(). Whichever is moving.
    // The source is chosen ONCE per window (onWindow), so a window never mixes them.
    _src: null,
    frames: function () {
      var pub = tryv(function () { return global.__gcPresentStats().publishedTotal; }, null);
      var rc = tryv(function () { return global.__gcPad.seq(); }, null);
      if (A.gamecube._src === 'pub') return pub;
      if (A.gamecube._src === 'rc') return rc;
      if (rc != null && !(pub > 0)) return rc;
      return pub != null ? pub : rc;
    },
    onWindow: function () {
      var pub = tryv(function () { return global.__gcPresentStats().publishedTotal; }, null);
      A.gamecube._src = pub > 0 ? 'pub' : 'rc';
    },
    presented: null,
    poll: function (w) {
      var f = this.frames(), t = now();
      if (f != null && w._lf != null) { var df = f - w._lf; if (df > 0) addCost((t - w._lt) / df, df, 'slow window'); }
      w._lf = f; w._lt = t;
      var r = global.__gcRate;
      if (r && r.speed != null && t - (w._ls || 0) >= 1000) { w._ls = t; w.speeds.push(r.speed); w.fpsSamples.push(r.shown); }
    },
    speed: function (w) { if (!w.speeds.length) return null; var s = 0; w.speeds.forEach(function (x) { s += x; }); return s / w.speeds.length; },
    rooms: true,
    net: genericNet
  };
  A.dreamcast = {
    label: function () { return selLabel(); },
    start: function (want) { selectRom('romSelect', findIdx('romSelect', want)); return pressStart(); },
    startReady: genericStartReady,
    kind: 'window',
    hz: function () { return 59.94; },
    frames: function () { return W ? W._df : null; },
    presented: null,
    poll: function (w) {
      var p = tryv(function () { return global.__dcProbe(); }, null);
      if (!p || !p.booted) return;
      var t = now();
      if (t - (w._ls || 0) >= 1000) {
        w._ls = t;
        if (p.guestX > 0) { w.speeds.push(p.guestX); w.fpsSamples.push(p.fps); w._df = (w._df || 0) + Math.round(p.guestX * 59.94); if (p.fps > 0) addCost(1000 / (p.guestX * 59.94), Math.round(p.guestX * 59.94), 'slow second'); }
      }
    },
    running: function () { var p = tryv(function () { return global.__dcProbe(); }, null); return !!(p && p.booted && p.guestX > 0); },
    speed: function (w) { if (!w.speeds.length) return null; var s = 0; w.speeds.forEach(function (x) { s += x; }); return s / w.speeds.length; },
    rooms: true,
    net: genericNet
  };

  var AD = A[PAGE];
  if (!AD) { log('no adapter for page "' + PAGE + '" — bench inactive'); return; }
  if (AD.install) AD.install();
  if (PHASE === 'guest') { guestMain(); return; }

  // ---------------------------------------------------------------------------
  // UI — one small fixed panel. Built on DOMContentLoaded.
  // ---------------------------------------------------------------------------
  var ui = null;
  function buildUi() {
    if (ui) return ui;
    var box = doc.createElement('div');
    box.id = 'benchPanel';
    box.setAttribute('style', 'position:fixed;left:8px;top:8px;z-index:2147483646;max-width:min(92vw,420px);' +
      'background:rgba(12,12,14,.92);color:#eee;font:13px/1.4 system-ui,sans-serif;border:1px solid #444;' +
      'border-radius:8px;padding:10px 12px;box-shadow:0 4px 18px rgba(0,0,0,.5)');
    box.innerHTML = '<div style="font-weight:600;margin-bottom:4px">Benchmark</div>' +
      '<div id="benchVerdict" style="font-size:22px;font-weight:700;display:none"></div>' +
      '<div id="benchStatus">starting…</div>' +
      '<pre id="benchSummary" style="white-space:pre-wrap;margin:6px 0 0;font:12px/1.35 ui-monospace,monospace;display:none"></pre>' +
      '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button id="benchGo" type="button" style="display:none;padding:8px 14px;font-size:15px">Tap to start benchmark</button>' +
      '<button id="benchCopy" type="button" style="display:none;padding:8px 14px">Copy results</button></div>' +
      '<textarea id="benchText" readonly style="display:none;width:100%;height:120px;margin-top:6px;font:11px ui-monospace,monospace"></textarea>';
    doc.body.appendChild(box);
    ui = { box: box, status: $('benchStatus'), verdict: $('benchVerdict'), summary: $('benchSummary'), go: $('benchGo'), copy: $('benchCopy'), text: $('benchText') };
    return ui;
  }
  function status(s) { if (ui) ui.status.textContent = s; log(s); }

  // ---------------------------------------------------------------------------
  // THE RUN
  // ---------------------------------------------------------------------------
  var carried = null;   // the solo result, carried across the reload into the room
  try {
    var wn = String(global.name || '');
    if (wn.indexOf('bench:') === 0) { carried = JSON.parse(wn.slice(6)); global.name = ''; }
  } catch (e) { carried = null; }

  function waitFor(cond, timeoutMs, everyMs) {
    return new Promise(function (res) {
      var t0 = now();
      (function poll() {
        var v = false; try { v = cond(); } catch (e) {}
        if (v) return res(true);
        if (now() - t0 > timeoutMs) return res(false);
        setTimeout(poll, everyMs || 250);
      })();
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function audioAllowed() {
    try { if (navigator.userActivation && navigator.userActivation.hasBeenActive) return true; } catch (e) {}
    try { if (navigator.getAutoplayPolicy && navigator.getAutoplayPolicy('audiocontext') === 'allowed') return true; } catch (e) {}
    return Q.get('benchauto') === '1';
  }
  function frames() { var f = tryv(function () { return AD.frames(); }, null); return f == null ? null : +f; }
  function isRunning() {
    if (AD.running) return AD.running();
    var f = frames(); return f != null && f > 0;
  }

  // One measurement window of SEC seconds, after the guest is producing frames.
  async function measure(label) {
    status(label + ': waiting for the game to run…');
    var ok = await waitFor(function () { return isRunning(); }, 240000, 250);
    if (!ok) return { error: 'the game never started producing frames (4 min)' };
    var f0 = frames();
    if (PAGE !== 'dreamcast') {
      // Running means the counter is MOVING, not merely non-zero.
      await waitFor(function () { var f = frames(); return f != null && f > f0; }, 60000, 100);
    }
    status(label + ': warming up ' + WARM + ' s…');
    await sleep(WARM * 1000);
    W = newWindow(typeof AD.kind === 'function' ? AD.kind() : AD.kind, 1000 / AD.hz());
    if (AD.onWindow) AD.onWindow(W);
    W.frames0 = frames(); W.pres0 = AD.presented ? AD.presented() : null;
    var timer = setInterval(function () {
      try { AD.poll(W); } catch (e) {}
      var el = (now() - W.t0) / 1000;
      if (ui) ui.status.textContent = label + ': measuring ' + Math.min(SEC, el).toFixed(0) + ' / ' + SEC + ' s';
    }, 250);
    await sleep(SEC * 1000);
    try { AD.poll(W); } catch (e) {}
    clearInterval(timer);
    W.tEnd = now();
    W.frames1 = frames(); W.pres1 = AD.presented ? AD.presented() : null;
    var w = W; W = null;
    var secs = (w.tEnd - w.t0) / 1000, hz = AD.hz();
    var df = (w.frames1 != null && w.frames0 != null) ? w.frames1 - w.frames0 : null;
    var speed = AD.speed ? AD.speed(w) : null;
    if (speed == null && df != null && PAGE !== 'gamecube' && PAGE !== 'dreamcast') speed = df / secs / hz;
    var fps = null;
    if (w.pres0 != null && w.pres1 != null) fps = (w.pres1 - w.pres0) / secs;
    else if (w.fpsSamples.length) { var s = 0; w.fpsSamples.forEach(function (x) { s += +x || 0; }); fps = s / w.fpsSamples.length; }
    var st = stats(w.costs);
    if (w.maxExact != null && (st.max == null || w.maxExact > st.max)) st.max = w.maxExact;
    return {
      ms: st, budgetMs: +w.budget.toFixed(3),
      over: w.overExact != null ? w.overExact : w.over,
      frames: df != null ? df : w.costs.length,
      speed: speed == null ? null : +speed.toFixed(4),
      fps: fps == null ? null : +fps.toFixed(1),
      _bursts: w.bursts
    };
  }

  // No frames or no cost samples is NOT a pass: it is a window that measured nothing.
  function passOf(r) { return !!(r && !r.error && r.frames > 0 && r.ms && r.ms.mean != null && r.over === 0 && r.speed != null && Math.abs(r.speed - 1) <= 0.005); }

  // ---- device ---------------------------------------------------------------
  async function device() {
    var nav = navigator, d = {
      ua: nav.userAgent, renderer: null, model: null,
      cores: nav.hardwareConcurrency || null, mem: nav.deviceMemory || null,
      screen: tryv(function () { return screen.width + 'x' + screen.height + '@' + (global.devicePixelRatio || 1); }, null)
    };
    try {
      if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
        var h = await Promise.race([nav.userAgentData.getHighEntropyValues(['model', 'platformVersion']), sleep(1500).then(function () { return null; })]);
        if (h) d.model = [h.model, h.platform, h.platformVersion].filter(Boolean).join(' ') || null;
      }
    } catch (e) {}
    // Probes run AFTER measurement, so a fresh context costs the run nothing.
    try {
      var c = doc.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        d.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      }
    } catch (e) {}
    if (PAGE === 'gamecube' || !d.renderer) {
      try {
        if (nav.gpu) {
          var a = await Promise.race([nav.gpu.requestAdapter(), sleep(2000).then(function () { return null; })]);
          if (a) {
            var i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
            var s = i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') : '';
            if (s) d.renderer = (PAGE === 'gamecube' ? 'WebGPU: ' + s + (d.renderer ? ' | WebGL: ' + d.renderer : '') : d.renderer || ('WebGPU: ' + s));
          }
        }
      } catch (e) {}
    }
    return d;
  }
  function capReport() {
    try { var c = global.__cap; return c ? JSON.parse(JSON.stringify(c)) : null; } catch (e) { return null; }
  }

  function strip(r) {
    if (!r || r.error) return null;
    var o = {}; for (var k in r) if (k[0] !== '_') o[k] = r[k];
    return o;
  }

  // ---- results ----------------------------------------------------------------
  async function finish(title, solo, room, roomErr, bursts) {
    var res = {
      v: VERSION, page: PAGE, title: title, ts: Date.now(),
      device: await device(),
      cap: capReport(),
      solo: strip(solo),
      room: strip(room),
      bursts: bursts,
      pass: passOf(solo) && (room ? passOf(room) : !roomErr)
    };
    var json = JSON.stringify(res);
    global.__benchResult = res;
    buildUi();
    ui.verdict.style.display = '';
    ui.verdict.textContent = res.pass ? 'PASS' : 'FAIL';
    ui.verdict.style.color = res.pass ? '#4ade80' : '#f87171';
    var L = [];
    function line(name, r, err) {
      if (err) { L.push(name + ': not measured — ' + err); return; }
      if (!r) return;
      L.push(name + ': speed ' + (r.speed == null ? 'n/a' : r.speed.toFixed(3) + 'x') + (r.speed != null && Math.abs(r.speed - 1) > 0.005 ? '  ✗' : '') +
             ' · fps ' + (r.fps == null ? 'n/a' : r.fps) + ' · ' + r.frames + ' frames');
      L.push('  ms mean ' + r.ms.mean + ' p95 ' + r.ms.p95 + ' p99 ' + r.ms.p99 + ' max ' + r.ms.max + ' (budget ' + r.budgetMs + ')');
      L.push('  over budget: ' + r.over + (r.over ? '  ✗' : ''));
      if (r.mode) L.push('  room: ' + r.mode + ' delay ' + r.delay + ' resims ' + r.resims + ' players ' + r.players);
    }
    L.push(PAGE + ' · ' + (title || '?'));
    line('solo', solo, solo && solo.error);
    if (room || roomErr) line('room', room, roomErr);
    if (bursts.length) L.push('worst: ' + bursts.slice(0, 4).map(function (b) { return b.ms + 'ms ' + b.cause; }).join(', '));
    ui.summary.style.display = ''; ui.summary.textContent = L.join('\n');
    ui.status.textContent = 'done';
    ui.text.value = json;
    ui.copy.style.display = '';
    ui.copy.onclick = function () { copy(json); };
    sink(json);
    log('RESULT ' + json);
    return res;
  }
  function copy(text) {
    var done = function (ok) { ui.copy.textContent = ok ? 'Copied ✓' : 'Select the text below and copy'; if (!ok) { ui.text.style.display = ''; ui.text.focus(); ui.text.select(); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
        return;
      }
    } catch (e) {}
    done(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      ui.text.style.display = ''; ui.text.value = text; ui.text.focus(); ui.text.select();
      ui.text.setSelectionRange(0, text.length);
      return doc.execCommand('copy');
    } catch (e) { return false; }
  }
  function sink(json) {
    var url = null;
    try { url = global.BENCH_SINK || Q.get('sink') || BENCH_SINK_DEFAULT || null; } catch (e) {}
    if (!url) return;
    try {
      // text/plain keeps this a "simple" request: no CORS preflight, and no-cors
      // means an endpoint without CORS headers still receives it.
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, body: json,
                   headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }).catch(function () {});
      log('posted to sink');
    } catch (e) {}
  }

  // ---- rooms -------------------------------------------------------------------
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function mintCode() { var s = ''; for (var i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
  function benchParams(extra) {
    var p = new URLSearchParams();
    ['bench', 'benchsec', 'benchwarm', 'benchgame', 'benchauto', 'sink', 'costdbg'].forEach(function (k) { if (Q.has(k)) p.set(k, Q.get(k)); });
    for (var k in extra) p.set(k, extra[k]);
    return p;
  }
  function goRoom(title, solo) {
    var code = mintCode();
    try { global.name = 'bench:' + JSON.stringify({ title: title, solo: solo, code: code }); } catch (e) {}
    var p = benchParams({ benchphase: 'room', np: code, host: '1', net: 'local', game: title });
    global.location.href = global.location.pathname + '?' + p.toString();
  }
  // Admit the loopback joiner: the role a person pressing Allow plays. Only in
  // the bench room phase, only over the same-browser transport.
  function autoAdmit() {
    var iv = setInterval(function () {
      var S = tryv(function () { return global.Netplay.sessions; }, null) || [];
      for (var i = 0; i < S.length; i++) {
        var s = S[i];
        try {
          if (s && s.isHost && s._pending && s._pending.proven && typeof s.approve === 'function') { s.approve(s._pending.nonce); log('admitted the loopback joiner'); }
        } catch (e) {}
      }
    }, 300);
    return function () { clearInterval(iv); };
  }
  async function roomMain() {
    var title = carried ? carried.title : (Q.get('game') || null);
    var code = Q.get('np');
    buildUi();
    status('room: opening loopback room ' + code + '…');
    var stopAdmit = autoAdmit();
    // Open the joiner once this page's host session is listening.
    await waitFor(function () { var S = tryv(function () { return global.Netplay.sessions; }, null) || []; return S.some(function (s) { return s && s.isHost; }); }, 30000, 200);
    var fr = doc.createElement('iframe');
    fr.src = global.location.pathname + '?' + benchParams({ benchphase: 'guest', np: code, join: '1', net: 'local', game: title }).toString();
    fr.title = 'bench loopback player 2';
    fr.setAttribute('style', 'position:fixed;right:8px;bottom:8px;width:200px;height:150px;z-index:2147483645;border:1px solid #555;background:#000');
    doc.body.appendChild(fr);
    var ok = await waitFor(function () { var n = AD.net && AD.net(); return n && n.running && frames() != null; }, 180000, 300);
    var room = null, err = null;
    if (!ok) err = 'the loopback room never started running (3 min)';
    else {
      room = await measure('room');
      if (room.error) { err = room.error; room = null; }
      else {
        var n = AD.net() || {};
        room.mode = n.mode || null; room.delay = n.delay == null ? null : n.delay;
        room.resims = n.resims == null ? 0 : n.resims; room.players = n.players || 2;
      }
    }
    stopAdmit();
    try { fr.remove(); } catch (e) {}
    var solo = carried ? carried.solo : null;
    var bursts = ((solo && solo._bursts) || []).map(function (b) { return { ms: b.ms, cause: 'solo: ' + b.cause, t: b.t }; })
      .concat(((room && room._bursts) || []).map(function (b) { return { ms: b.ms, cause: 'room: ' + b.cause, t: b.t }; }))
      .sort(function (a, b) { return b.ms - a.ms; }).slice(0, 16);
    await finish(title, solo, room, err, bursts);
  }

  // The joiner in the iframe: no panel, no measurement. Its page auto-boots on
  // the hand-off; a page that waits for its own Start gets it pressed.
  function guestMain() {
    var go = function () {
      setTimeout(function tick() {
        var n = tryv(function () { return AD.net && AD.net(); }, null);
        if (n && n.running) return;
        var S = tryv(function () { return global.Netplay.sessions; }, null) || [];
        var connected = S.some(function (s) { return s && s.state === 'connected'; });
        if (connected && !(frames() > 0) && AD.startReady && AD.startReady() && !guestMain.pressed) { guestMain.pressed = true; pressStart(); }
        setTimeout(tick, 1000);
      }, 8000);
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go); else go();
  }

  async function soloMain() {
    buildUi();
    status('waiting for the page to be ready…');
    var ready = await waitFor(function () { return AD.startReady(); }, 120000, 200);
    if (!ready) { await finish(null, { error: 'the page never offered a Start (capability gate or load failure)' }, null, null, []); return; }
    var want = Q.get('benchgame');
    var tries = 0;
    var start = function () {
      if (!AD.start(want)) {
        if (++tries < 120) { status('waiting for Start to be pressable…'); setTimeout(start, 500); }
        else finish(null, { error: 'could not press Start' }, null, null, []);
        return;
      }
      benchStart = now();
      run();
    };
    if (audioAllowed()) start();
    else {
      // Audio needs one gesture on phones; the tap presses the page's own Start
      // inside it, so the speed witness (audio) is live from the first frame.
      status('one tap is needed so the game can play sound');
      ui.go.style.display = '';
      ui.go.onclick = function () { ui.go.style.display = 'none'; start(); };
    }
  }
  async function run() {
    var title = AD.label();
    var solo = await measure('solo');
    var hasRooms = ROOMS_ON && AD.rooms && !!(global.Netplay && global.Netplay.supported && global.Netplay.supported());
    if (hasRooms && !solo.error) { status('solo done — reloading into a loopback room'); goRoom(title, solo); return; }
    var bursts = (solo._bursts || []).map(function (b) { return { ms: b.ms, cause: b.cause, t: b.t }; });
    await finish(title, solo, null, null, bursts);
  }

  function main() {
    if (PHASE === 'room') roomMain(); else soloMain();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', main); else main();
  global.__bench = { version: VERSION, page: PAGE, phase: PHASE, result: function () { return global.__benchResult || null; } };
})(typeof window !== 'undefined' ? window : this);
