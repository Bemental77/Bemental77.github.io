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
 *             Without it a burst is still NAMED: the worker times every core
 *             field (two clock reads) and sends each one over a field period
 *             with what was inside it (core_worker.js WHY A FIELD WAS SLOW: JIT
 *             compile, new code on the interpreter / scene load, a frame-skip
 *             repair, a rollback re-simulation, or none of those); the window's
 *             worst one names the burst, with its field number and own ms.
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
 *             gamecube on the RECOMP engine (Mario Party 4): the counter is the
 *             guest clock itself — PAD_ACK, one per guest frame — and SPEED is
 *             Δframes / Δwall / 60 (not __gcRate.speed); `w4` beside it is MP4's
 *             own GlobalCounter rate, a guest-executed cross-check.
 *   `budgetMs` = 1000 / guest frame rate. `over` counts frames whose COST
 *   exceeded budgetMs; for interval / window-resolved samples (which carry
 *   scheduling jitter) the line is 1.5 x budgetMs — a missed frame slot.
 *
 * ── SPEED (1.000 = hardware) ───────────────────────────────────────────────
 *   n64  SOLO: the guest's own field clock — Δ(VI fields the guest lived through, the
 *        worker's viTotal: a frame-skip re-run's fields are not counted) / Δwall / the
 *        cartridge's field rate, both ends read from the worker's stat stream on its
 *        own clock. ROOM: engine frames / Δwall / field rate (a rollback's re-simulated
 *        fields are not guest time). The audio witness is reported beside it
 *        (`audioSpeed`), never averaged into it: MEASURED 2026-10-04 (SM64 and MK64
 *        solo, 1 s windows) it read 0.889-0.927x on windows where the field clock read
 *        1.000x (the game's own audio output changing with the scene), and 1.21-1.36x on
 *        windows with a frame-skip re-run (its fields' audio moved the ring pointer);
 *        a 30 s mean of those is a property of the title's soundtrack, not of the speed.
 *        ps1  audio ring frames / 44100.
 *   snes guest frames / 60.0988.   gba  frames / 59.7275 (fast-forward off).
 *   gamecube __gcRate.speed.   dreamcast __dcProbe().aicaX (AICA frames / 44101.43),
 *        one sample per heartbeat, window opened after the seed restore.
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
 *    room:null|{...same, mode,delay,resims,players[,desync,hashes]}, bursts[{ms,cause,t}], pass}
 *   pass = solo (and room when present) has over==0 and |speed-1|<=0.005, and a
 *   room whose engine reports a fingerprint desync fails (desync/hashes are present
 *   where the room runs lib/netplay.js Lockstep through genericNet).
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
             delay: rep.delay, resims: rep.rollback ? rep.rollback.resimFrames : 0, players: players,
             // The engine's own fingerprint compare: a room that ran fast but forked is not a pass.
             desync: !!rep.desync, hashes: rep.hashesCompared == null ? null : rep.hashesCompared };
  }

  var A = {};
  // ---- n64 ------------------------------------------------------------------
  A.n64 = (function () {
    var last = null, lastDbgOver = null, dbgMaxSeen = {}, viHz = 60, roomLast = null;
    // THE GUEST FIELD CLOCK (see SPEED in the header): the newest stat's (vi, at) pair,
    // and the window's first one
    var viAt = null;
    // THE CAUSE OF A SLOW WINDOW without ?costdbg=1: the worker times every core field and sends
    // the ones over a field period with what happened inside them (core_worker.js WHY A FIELD
    // WAS SLOW: JIT compile, new code on the interpreter / a scene load, a frame-skip repair, a
    // rollback re-simulation, or none of those). The window's worst one names the burst; a window
    // whose mean is over budget with no single field over a period says so.
    function slowCause(slow, mean, dn) {
      if (!slow || !slow.length) return 'several heavy fields (' + dn + ' at ' + mean.toFixed(1) + ' ms mean, none alone over a period)';
      var w = slow[0];
      for (var i = 1; i < slow.length; i++) if (slow[i].ms > w.ms) w = slow[i];
      return (w.why || 'core') + ' [field ' + w.f + ', ' + w.ms + ' ms]';
    }
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
      if (d.vi != null && d.at > 0) viAt = { vi: d.vi >>> 0, at: d.at };
      if (W && !W.tEnd) { fmap.push([d.frame, now()]); if (fmap.length > 4000) fmap.splice(0, 1000); }
      if (W && !W.tEnd && last) {
        var dn = (d.costN - last.costN) >>> 0, dms = d.costMs - last.costMs;
        if (dn > 0 && dn < 1000 && dms >= 0) {
          var mean = dms / dn;
          W._statCost = true;
          if (d.dbg) { for (var i = 0; i < dn; i++) W.costs.push(mean); }
          else addCost(mean, dn, slowCause(d.slow, mean, dn));
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
      onWindow: function (w) { w.f0 = this.frames() || 0; lastDbgOver = last && last.dbg ? last.dbg.over : null; w._vi0 = this.viClock(); },
      // (vi, t ms): the worker's stat (its own clock), or the main-thread core read now
      viClock: function () {
        if (tryv(function () { return global.__n64Worker.state().on; }, false)) return viAt ? { vi: viAt.vi, t: viAt.at } : null;
        var v = tryv(function () { return global.Module._neil_vi_total() >>> 0; }, null);
        return v == null ? null : { vi: v, t: performance.timeOrigin + now() };
      },
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
          // the audio witness, reported beside the speed (extra.audioSpeed), never as it
          if (r.audioSpeed != null && r.audioSpeed > 0.01 && !r.seam) w.speeds.push(r.audioSpeed);
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
      // SOLO: the guest field clock over the window. ROOM: null, so the caller's engine-frame
      // rate (frames() = the engine's frame, Δ / Δwall / hz) is the speed.
      speed: function (w) {
        if (PHASE === 'room') return null;
        var a = w._vi0, b = this.viClock();
        if (!a || !b || !(b.t - a.t > 1000)) return null;
        return ((b.vi - a.vi) >>> 0) / ((b.t - a.t) / 1000) / this.hz();
      },
      extra: function (w) {
        var s = 0; for (var i = 0; i < w.speeds.length; i++) s += w.speeds[i];
        return { speedFrom: PHASE === 'room' ? 'engine frames' : 'guest field clock (viTotal)',
                 audioSpeed: w.speeds.length >= 3 ? +(s / w.speeds.length).toFixed(4) : null };
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
  var GC_MIN_POLL_MS = 125;   // half the 250 ms poll: see A FRAGMENT IS NOT A WINDOW in poll()
  A.gamecube = {
    label: function () { return selLabel(); },
    start: function (want) { selectRom('romSelect', findIdx('romSelect', want)); return pressStart(); },
    startReady: genericStartReady,
    kind: 'window',
    // ⚠ THE RECOMP ENGINE (Mario Party 4 routes there with no query parameter) HAS ITS OWN GUEST
    // CLOCK, AND THIS ADAPTER USED TO READ EVERYTHING BUT IT. Measured on live caseybement.com
    // 2026-10-03: solo speed null (it waited on __gcRate.speed, which the page publishes only once
    // its own cumulative span passes 1 s and only as a mean since boot), and the room "1 frame in
    // a 250 ms window" (frames came from the JIT renderer's seqlock, which the recomp never moves,
    // whenever it had published anything at all during the boot).
    // Now, on the recomp engine:
    //   frames = PAD_ACK (__gcLockstep().guestFrames): bumped once per guest frame by the worker
    //            after it latched that frame's input — one credit, one VIWaitForRetrace, 1/60 s of
    //            emulated time (recomp_worker.js: OSGetTime = viRetrace * 675000 at 40.5 MHz).
    //            Solo and room alike, and a ROLLBACK re-simulation does not bump it (a re-run
    //            frame is not new guest time), so it is the guest clock in every mode.
    //   speed  = Δframes / Δwall / 60 over the window — the guest clock against the wall clock.
    //   w4     = MP4's OWN GlobalCounter (main.c:115, read by C symbol in the worker's pad
    //            witness): a guest-EXECUTED clock, independent of the worker's bookkeeping
    //            (CLAUDE.md gate 10, W4). Reported beside speed so a disagreement is visible.
    // The JIT path keeps the renderer's published-frame seqlock and __gcRate.speed.
    hz: function () { var r = global.__gcRate; return A.gamecube._recomp() ? 60 : ((r && (r.nativeHz || r.guestHz)) || 60); },
    _recomp: function () { return !!tryv(function () { return global.__gcRecompState.engaged() && typeof global.__gcLockstep === 'function'; }, false); },
    _gc: function () { return tryv(function () { var w = global.__gcPad.witness(); return w ? w.globalCounter : null; }, null); },
    // ⚠ THE CLOCK WAS PICKED BEFORE THE ENGINE THAT OWNS IT HAD ENGAGED. Live caseybement.com
    // 2026-10-04 (prod 1e49538, headless SwiftShader WITH WebGPU): solo "speed 0.9998x, 12
    // frames in 20 s, frame cost 230 ms" while the room read 1202 frames at 1.0018x. MP4 boots
    // on the JIT first; gamecube.html hands it to the recomp 2 s after the renderer's first
    // frame (the armTimer at the bottom of the page), and the bench's 2 s warm-up raced that
    // hand-off. The window opened while __gcRecompState.engaged() was still false, so it took
    // the 'pub' clock: the WGPU renderer's published-frame seqlock (11-12 frames per 20 s on
    // SwiftShader WebGPU, reproduced locally) and __gcRate.speed. A second shape of the same
    // race opened the window AFTER engaged() but BEFORE the recomp guest had run a frame
    // (it starts ~5 s after bootSent): 0.876x / 0.960x over windows whose guest ran at 1.000x.
    // Now:
    //   _want()    the source the PAGE WILL USE — read from its routing decision
    //              (__gcRecompRouting.engage), not from whichever engine happens to be up.
    //              Undecided (no ROM chosen yet) means no source, so the bench waits.
    //   running()  on a recomp title: engaged AND the guest clock advancing at >= 0.9x for a
    //              full second (the guest's boot burst/stall is not in any window).
    //   _cur()     the source the page is on NOW; poll() compares it to the window's and
    //              flags `srcChanged`, and measure() restarts or refuses such a window.
    _src: null,
    _want: function () {
      var r = global.__gcRecompRouting;
      if (A.gamecube._recomp()) return 'recomp';
      if (!r || r.engage == null) return null;
      return r.engage === true ? 'recomp' : 'pub';
    },
    _cur: function () { return A.gamecube._recomp() ? 'recomp' : 'pub'; },
    _framesOf: function (src) {
      if (src === 'recomp') return A.gamecube._recomp() ? tryv(function () { return global.__gcLockstep().guestFrames; }, null) : null;
      if (src === 'pub') return tryv(function () { return global.__gcPresentStats().publishedTotal; }, null);
      return null;
    },
    frames: function () { return A.gamecube._framesOf(A.gamecube._src || A.gamecube._want()); },
    _rs: null,   // running() samples on the recomp clock: [{t, f}]
    running: function () {
      var src = A.gamecube._want();
      if (src == null) return false;
      var f = A.gamecube._framesOf(src);
      if (src !== 'recomp') { A.gamecube._rs = null; return f != null && f > 0; }
      if (f == null || !(f > 0)) { A.gamecube._rs = null; return false; }
      var t = now(), rs = A.gamecube._rs || (A.gamecube._rs = []);
      rs.push({ t: t, f: f });
      while (rs.length > 2 && t - rs[1].t >= 1000) rs.shift();
      var a = rs[0], dt = (t - a.t) / 1000;
      return dt >= 1 && (f - a.f) / dt >= 0.9 * 60;
    },
    beforeWindow: function () { A.gamecube._src = null; A.gamecube._rs = null; },
    // The source is chosen ONCE per window, so a window never mixes two clocks.
    onWindow: function (w) {
      A.gamecube._src = A.gamecube._want() || A.gamecube._cur();
      w._t0 = now(); w._gc0 = A.gamecube._gc();
    },
    // A window whose clock source moved under it measured two things; measure() restarts it.
    srcChanged: function (w) { return !!w._srcChanged; },
    presented: null,
    poll: function (w) {
      if (A.gamecube._src && A.gamecube._cur() !== A.gamecube._src && !w._srcChanged) {
        w._srcChanged = A.gamecube._src + ' -> ' + A.gamecube._cur();
      }
      var f = this.frames(), t = now();
      // A FRAGMENT IS NOT A WINDOW (2026-10-05). Frames land in whole units, so the shorter the
      // interval the coarser its ms/frame: 1 frame in 28.9 ms reads "28.9 ms/frame" and is over
      // budget although the guest is exactly on time. The timer polls every 250 ms, but measure()
      // takes one last poll whenever its own wait returns — at an arbitrary phase — and a late
      // timer tick is followed by an early one. MEASURED (prod mirror, MP4 bench room): a run
      // whose 20 s window held no stall at all read "room 1 over, 28.9 ms" from the closing poll
      // 10 ms after the window's end. An interval under GC_MIN_POLL_MS is carried into the next
      // one instead of being scored; the closing fragment is simply not scored.
      if (f != null && w._lf != null) {
        if (t - w._lt >= GC_MIN_POLL_MS) {
          var df = f - w._lf; if (df > 0) addCost((t - w._lt) / df, df, 'slow window');
          w._lf = f; w._lt = t;
        }
      } else { w._lf = f; w._lt = t; }
      if (w._f0 == null && f != null) { w._f0 = f; w._tf0 = t; }
      if (f != null) { w._f1 = f; w._tf1 = t; }
      var g = A.gamecube._gc(); if (g != null) { w._gc1 = g; w._tg1 = t; }
      var r = global.__gcRate;
      if (r && t - (w._ls || 0) >= 1000) {
        w._ls = t;
        // pictures/s: what reached the canvas where the page counts it, else what the renderer acked
        var pics = (r.shown > 0) ? r.shown : (r.ackedPerS != null ? r.ackedPerS : r.published);
        if (pics != null) w.fpsSamples.push(pics);
        if (A.gamecube._src !== 'recomp' && r.speed != null) w.speeds.push(r.speed);
      }
    },
    speed: function (w) {
      if (A.gamecube._src === 'recomp') {
        var dt = (w._tf1 - w._tf0) / 1000;
        return (dt > 1 && w._f1 >= w._f0) ? (w._f1 - w._f0) / dt / 60 : null;
      }
      if (!w.speeds.length) return null; var s = 0; w.speeds.forEach(function (x) { s += x; }); return s / w.speeds.length;
    },
    extra: function (w) {
      var o = { clock: A.gamecube._src === 'recomp' ? 'recomp guest frames (PAD_ACK)' : 'jit published frames + __gcRate.speed' };
      var dt = (w._tg1 - w._t0) / 1000;
      if (w._gc0 != null && w._gc1 != null && dt > 1) o.w4 = +((((w._gc1 - w._gc0) >>> 0)) / dt / 60).toFixed(4);
      return o;
    },
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
    // ⚠ ONE SAMPLE PER HEARTBEAT, FROM THE AICA WITNESS, AFTER THE SEED RESTORE.
    // The live "guest 3.5719x" (2026-10-03) was this adapter, not the guest:
    //  * running() went true at `booted`, BEFORE the page's fresh-boot seed
    //    restore, so the 2 s warm-up did not cover it and the window opened on
    //    the heartbeat whose Δsh4_sched_now64 contained the deserialize jump
    //    (guestX=80.543x locally while AICA read 0.4x);
    //  * poll() re-read whatever heartbeat came last every >=1 s, so one stale
    //    window could be sampled twice and a fresh one skipped;
    //  * frames/cost are synthesized from the rate (1000 / (x * 59.94) for
    //    x * 59.94 frames), so the jump also forged ~4800 0.21 ms "frames".
    // Now: wait until the page reports no restore pending and two heartbeats
    // since the last one (the first spans the jump), take each heartbeat once
    // by its sequence number, and read speed from aicaX — AICA production /
    // 44101.43 (CLAUDE.md gate 10's Dreamcast witness). Older pages without
    // those fields fall back to the previous behaviour.
    poll: function (w) {
      var p = tryv(function () { return global.__dcProbe(); }, null);
      if (!p || !p.booted) return;
      var t = now();
      var fresh = p.hb != null ? (p.hb !== w._hb) : (t - (w._ls || 0) >= 1000);
      if (!fresh) return;
      w._hb = p.hb; w._ls = t;
      var x = p.aicaX > 0 ? p.aicaX : p.guestX;
      if (!(x > 0)) return;
      var n = Math.round(x * 59.94);
      w.speeds.push(x); w.fpsSamples.push(p.fps); w._df = (w._df || 0) + n;
      if (p.fps > 0 && n > 0) addCost(1000 / (x * 59.94), n, p.clkJump ? 'slow second (clock jump window)' : 'slow second');
    },
    running: function () {
      var p = tryv(function () { return global.__dcProbe(); }, null);
      if (!(p && p.booted && p.guestX > 0)) return false;
      if (p.restoring === true) return false;
      if (p.hbSinceRestore != null && p.hbSinceRestore < 2) return false;
      return true;
    },
    speed: function (w) { if (!w.speeds.length) return null; var s = 0; w.speeds.forEach(function (x) { s += x; }); return s / w.speeds.length; },
    rooms: true,
    roomGame: function () { var s = $('romSelect'); return s ? s.value : null; },
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
    // ⚠ NOT CLEARED HERE: a page may reload itself before the room starts (gamecube.html
    // re-enters once on the WebGL2 fallback, ?hwauto=1, when it finds no WebGPU) and clearing
    // the name on the first load lost the solo result — the room then reported solo:null.
    // Only the room phase reads it, and finish() clears it.
    if (wn.indexOf('bench:') === 0 && PHASE === 'room') carried = JSON.parse(wn.slice(6));
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
  // An adapter whose clock SOURCE can change under a window (gamecube: the JIT hands MP4 to
  // the recomp engine) exposes srcChanged(w). Such a window measured two different clocks:
  // it is abandoned as soon as the change is seen and measured again from the top, and a
  // window that still saw a change after MAX_RESTARTS is refused, never reported.
  var MAX_RESTARTS = 3;
  async function measure(label) {
    var restarts = [];
    for (;;) {
      var r = await measureOnce(label, restarts.length);
      if (r && r.srcChanged) {
        restarts.push(r.srcChanged);
        log(label + ': clock source changed during the window (' + r.srcChanged + ') — ' +
            (restarts.length > MAX_RESTARTS ? 'refusing it' : 'measuring again'));
        if (restarts.length > MAX_RESTARTS) return { error: 'the clock source changed during every window (' + restarts.join('; ') + ')' };
        continue;
      }
      if (r && restarts.length) { r._extra = r._extra || {}; r._extra.restarts = restarts; }
      return r;
    }
  }
  async function measureOnce(label, attempt) {
    if (AD.beforeWindow) AD.beforeWindow();
    status(label + ': waiting for the game to run…');
    var ok = await waitFor(function () { return isRunning(); }, 240000, 250);
    if (!ok) return { error: 'the game never started producing frames (4 min)' };
    var f0 = frames();
    if (PAGE !== 'dreamcast') {
      // Running means the counter is MOVING, not merely non-zero.
      await waitFor(function () { var f = frames(); return f != null && f > f0; }, 60000, 100);
    }
    status(label + ': warming up ' + WARM + ' s…' + (attempt ? ' (window ' + (attempt + 1) + ')' : ''));
    await sleep(WARM * 1000);
    W = newWindow(typeof AD.kind === 'function' ? AD.kind() : AD.kind, 1000 / AD.hz());
    if (AD.onWindow) AD.onWindow(W);
    W.frames0 = frames(); W.pres0 = AD.presented ? AD.presented() : null;
    var changed = function () { return !!(AD.srcChanged && tryv(function () { return AD.srcChanged(W); }, false)); };
    var timer = setInterval(function () {
      // A game can change video mode mid-run (Monster Rancher 2 goes 59.94 -> 50 Hz
      // ~5 s after power-on), so the budget follows the guest's current rate.
      try { var hzNow = AD.hz(); if (hzNow > 0) W.budget = 1000 / hzNow; } catch (e) {}
      try { AD.poll(W); } catch (e) {}
      var el = (now() - W.t0) / 1000;
      if (ui) ui.status.textContent = label + ': measuring ' + Math.min(SEC, el).toFixed(0) + ' / ' + SEC + ' s';
    }, 250);
    await waitFor(changed, SEC * 1000, 250);
    try { AD.poll(W); } catch (e) {}
    clearInterval(timer);
    if (changed()) { var why = String(W._srcChanged || 'source changed'); W = null; return { srcChanged: why }; }
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
      _bursts: w.bursts,
      _extra: AD.extra ? tryv(function () { return AD.extra(w); }, null) : null
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
    if (r._extra) for (var e in r._extra) if (!(e in o)) o[e] = r._extra[e];
    return o;
  }

  // ---- results ----------------------------------------------------------------
  async function finish(title, solo, room, roomErr, bursts) {
    try { if (String(global.name || '').indexOf('bench:') === 0) global.name = ''; } catch (e) {}
    var res = {
      v: VERSION, page: PAGE, title: title, ts: Date.now(),
      device: await device(),
      cap: capReport(),
      solo: strip(solo),
      room: strip(room),
      bursts: bursts,
      pass: passOf(solo) && (room ? passOf(room) && room.desync !== true : !roomErr)
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
      if (r.mode) L.push('  room: ' + r.mode + ' delay ' + r.delay + ' resims ' + r.resims + ' players ' + r.players +
                         (r.desync != null ? ' · ' + (r.desync ? 'DESYNC  ✗' : 'in sync') + ' (' + r.hashes + ' hashes compared)' : ''));
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
    // The hand-off's `game` is whatever key the page's own picker uses (dreamcast: GAMES key
    // `pso2`, not the label); `title` stays the label for the report.
    var key = AD.roomGame ? tryv(function () { return AD.roomGame(); }, null) : null;
    var p = benchParams({ benchphase: 'room', np: code, host: '1', net: 'local', game: key || title });
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
    fr.src = global.location.pathname + '?' + benchParams({ benchphase: 'guest', np: code, join: '1', net: 'local', game: Q.get('game') || title }).toString();
    fr.title = 'bench loopback player 2';
    fr.setAttribute('style', 'position:fixed;right:8px;bottom:8px;width:200px;height:150px;z-index:2147483645;border:1px solid #555;background:#000');
    doc.body.appendChild(fr);
    // ⚠ "RUNNING" IS THE ADAPTER'S OWN TEST WHEN IT HAS ONE. dreamcast's frames() is a
    // count synthesized INSIDE a measurement window (W._df) and reads null until one opens,
    // so `frames() != null` here never held and every Dreamcast room reported "never started
    // running (3 min)" while its lockstep engine was running (live prod 7085da4, 2026-10-05).
    var ok = await waitFor(function () {
      var n = AD.net && AD.net();
      return n && n.running && (AD.running ? isRunning() : frames() != null);
    }, 180000, 300);
    var room = null, err = null;
    if (!ok) err = 'the loopback room never started running (3 min)';
    else {
      room = await measure('room');
      if (room.error) { err = room.error; room = null; }
      else {
        var n = AD.net() || {};
        room.mode = n.mode || null; room.delay = n.delay == null ? null : n.delay;
        room.resims = n.resims == null ? 0 : n.resims; room.players = n.players || 2;
        if (n.desync != null) { room.desync = n.desync; room.hashes = n.hashes; }
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
