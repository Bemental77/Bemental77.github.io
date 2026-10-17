// gamecube/native/mp4n_room.js — netplay for mp4-native.html: a 2-4 player Mario Party 4 room on
// lib/netplay.js, rollback at zero local input delay.
//
// WHAT A ROOM NEEDS FROM THIS PORT, AND WHERE IT COMES FROM
//   * The same game on every machine: the build is deterministic given the epoch and the
//     per-frame input (two instances: 392/392 state hashes equal over a board + minigame). A room
//     boots every console with ONE fixed epoch (ROOM_EPOCH) and a fresh memory card, so every
//     console reaches its first frame boundary in the same state.
//   * One frame boundary: web_port.cpp's frame_limiter calls Module.mp4FrameHook once per frame
//     at the one place the C stack has the same shape every frame. Its answer can HOLD the game
//     there (waiting on the room), or run the next frame OFF-SCHEDULE (no sleep, not counted
//     against the 60 Hz clock: a re-simulated or hidden catch-up frame).
//   * Rewind: src/rollback.c keeps a copy-on-write undo log of every game-owned page, per frame;
//     mp4web_rb_restore(k) puts the game back at the start of frame k in ~1 ms.
//
// THE FRAME, AT BOUNDARY k (the game is at the start of room frame k)
//   1. close the frame that just ran: rb_boundary(k); the fingerprint of k-1's result if due;
//      engine.endFrame() if it was the room's live frame.
//   2. a rewind in progress: run the next re-simulated frame with its agreed input, muted.
//   3. otherwise ask the room: beginFrame(myPad) -> not ready: HOLD; a rollback: rb_restore(from)
//      and queue the corrected frames, then the live one; else run frame k with the room's image.
// Guest speed: a live frame is paced by frame_limiter at exactly 60 Hz with its debt capped at
// one frame (mp4web_set_max_debt), so nothing sprints; the only frames that run faster than the
// clock are re-simulations (never presented as new time) and the hidden catch-up frames the
// engine grants and caps itself (lib/netplay.js rbCatchUp / _ocAllow).
(function () {
  'use strict';
  var HOOK_REANCHOR = 1, HOOK_HOLD = 2, HOOK_OFF = 4;
  var GAME_ID = 'mp4native';
  var PAD_BYTES = 8;
  var ROOM_EPOCH = 55814400;            // 2001-10-08 00:00 in GC seconds-since-2000: any fixed value works; every console uses this one
  var RB_WINDOW = 8;
  var RING = 64;                         // frames of undo log kept (>= the engine's rbRingFrames; rollback.c MAXR)
  var POOL_PAGES = 8192;                 // 32 MB of page pre-images across those frames

  var Q = new URLSearchParams(location.search);
  // The page reads ?np=<CODE>&game=&join=1&players= and hands them here (mount opts.handoff).
  function parseHandoff(h) {
    var code = String((h && h.np) || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return null;
    var players = Math.max(2, Math.min(4, parseInt(h.players || '4', 10) || 4));   // the host can start sooner (startNow)
    return { code: code, game: h.game || '', join: !!h.join, players: players };
  }

  var R = {
    handoff: null,
    transport: Q.get('net') === 'local' ? 'local' : 'peerjs',
    broken: Q.get('npbreak') || '',     // 'epoch': this console boots on its own clock — the desync detector's control
    session: null, role: null, ui: null, onStart: null, mod: null,
    want: 4,                            // players the host waits for before it starts (?players=; startNow starts with fewer)
    armed: false, running: false, failed: null,
    next: 0,                            // room frame about to run at this boundary
    lastRan: -1, lastLive: -1, liveHidden: false,
    atTotal: -1, tickedAt: -1,
    replay: [], image: null, pushMute: false,
    catchUp: 0, hashAt: Object.create(null), due: [], sent: Object.create(null),   // sent: frame -> fingerprint this console submitted
    stats: { live: 0, resim: 0, hidden: 0, rollbacks: 0, maxDepth: 0, holds: 0, hashesSent: 0, restoreFail: 0, maxRestoreMs: 0, frameTimes: [] },
    log: function () {}
  };

  function engine() { return R.session && R.session.ls ? R.session.ls : null; }
  function m() { return R.mod; }

  // ---- the lobby ----------------------------------------------------------------------------
  function engineOpts(sess) {
    var o = { portCount: 4, padBytes: PAD_BYTES, hashEvery: 60, rollback: Q.get('rb') === '0' ? 0 : RB_WINDOW,
              rbCatchUp: true, rollbackOk: true, rbResume: true, frameHz: 60 };
    try { if (!sess.ls && typeof sess.startLockstep === 'function') sess.startLockstep(o); }
    catch (e) { R.log('room: could not build the engine: ' + ((e && e.message) || e)); }
  }
  function mount(opts) {
    R.log = opts.log || R.log;
    R.onStart = opts.onStart || null;
    R.handoff = parseHandoff(opts.handoff);
    if (R.handoff) R.want = R.handoff.players;
    if (!window.NetplayUI || !window.Netplay || !window.Netplay.supported()) return false;
    var mo = {
      game: GAME_ID, transport: R.transport,
      onSession: function (sess, role) {
        R.session = sess; R.role = role; engineOpts(sess);
        sess.on('lockstep', function (e) { if (e && (e.state === 'failed' || e.state === 'desync')) R.log('room: ' + e.state + (e.detail ? ' — ' + JSON.stringify(e.detail).slice(0, 200) : '')); });
      },
      onReady: function (sess, role) {
        R.session = sess; R.role = role;
        if (R.solo) { R.log('room: this game was started solo, so it cannot be the room\'s frame 0 — reload the page and join with ' + sess.code); return; }
        R.log('room: connected as ' + role + ' (' + sess.code + ') — starting the game; frame 0 waits for every player');
        if (R.onStart) R.onStart();
      }
    };
    if (R.handoff) { mo.code = R.handoff.code; mo.join = R.handoff.join; mo.autoconnect = true; }
    R.ui = NetplayUI.mount(mo);
    if (R.ui && typeof R.ui.setRows === 'function') setInterval(partyRows, 1000);
    return true;
  }

  // The party panel's rows, in lib/netplay-ui.js's vocabulary: this console knows its own state;
  // once the room runs every seated player is playing.
  function partyRows() {
    var ls = engine(); if (!ls || !R.session) return;
    var rows = [];
    for (var p = 0; p < ls.portCount; p++) {
      if (ls.roster[p] == null) { rows.push({ port: p, who: 'open', state: 'open' }); continue; }
      var mine = ls.localPorts && ls.localPorts.indexOf(p) >= 0;
      var st = R.running ? 'playing' : mine ? (R.armed ? 'ready' : 'loading') : 'loaded';
      rows.push({ port: p, who: (p === 0 ? 'host' : 'player') + (mine ? ' (you)' : ''), state: st });
    }
    try { R.ui.setRows(rows); } catch (e) {}
    try {
      if (R.failed) R.ui.say('Stopped: ' + R.failed, true);
      else if (ls.state === 'desync') R.ui.say('The consoles disagreed (desync) — the room stopped', true);
      else if (!R.running && R.role === 'host') R.ui.say(seated(ls) + ' of ' + R.want + ' players in — the game starts when everyone is here');
      else if (!R.running) R.ui.say('Waiting for every player to be ready at frame 0');
    } catch (e) {}
  }

  // What the game boots with inside a room: the shared epoch and a fresh card.
  function bootOpts() {
    if (!R.session && !R.handoff) return null;
    var epoch = R.broken === 'epoch' ? Math.floor(Date.now() / 1000) - 946684800 : ROOM_EPOCH;
    return { epoch: epoch, nosave: true };
  }

  // ---- arming ------------------------------------------------------------------------------
  function seated(ls) { var n = 0; for (var p = 0; p < ls.portCount; p++) if (ls.roster[p] != null) n++; return n; }
  function canArm() {
    var ls = engine();
    if (!ls) return false;
    // The host holds frame 0 until the party it asked for is in: a running room seats nobody.
    if (R.role === 'host' && seated(ls) < R.want) return false;
    return true;
  }
  function arm() {
    var mod = m(), ls = engine();
    var rc = mod._mp4web_rb_enable(0, RING, POOL_PAGES);
    if (rc <= 0) { fail('this build cannot rewind (rb_enable ' + rc + ')'); return false; }
    mod._mp4web_set_max_debt(1000 / 60);
    R.armed = true; R.next = 0; R.lastRan = -1;
    R.hashAt[0] = mod._mp4web_rb_hash();
    R.log('room: armed at frame 0 — ports ' + JSON.stringify(ls.roster) + ', mine ' + JSON.stringify(ls.localPorts) + ', want ' + R.want);
    try { R.session.setReady(true, 'GMPE01:' + (Q.get('build') || 'dist')); } catch (e) { R.log('room: setReady refused: ' + e); }
    return true;
  }
  function fail(why) {
    if (R.failed) return;
    R.failed = why; R.log('room: STOPPED — ' + why);
    var ls = engine(); if (ls && typeof ls.fail === 'function') { try { ls.fail(why); } catch (e) {} }
  }

  // ---- input ----------------------------------------------------------------------------------
  function localPads(ls) {
    var known = (ls.localPorts && ls.localPorts.length) ? ls.localPorts : null;
    if (!known && R.role !== 'host') return {};      // a guest with no seat yet drives nobody's pad
    var ports = known || [0], out = {};
    var mine = window.Mp4Input ? Mp4Input.sampleLocal() : new Uint8Array(PAD_BYTES);
    ports.forEach(function (p, k) { out[p] = k === 0 ? mine : new Uint8Array(PAD_BYTES); });
    return out;
  }
  // The latch (web_port.cpp, right after the hook) asks for 4 ports x 8 i32; in a room every
  // port comes from the agreed image, this console's own included.
  function latch() {
    var out = new Array(32).fill(0), ls = engine(), img = R.image;
    if (!img || !ls) return out;
    for (var p = 0; p < 4; p++) {
      if (ls.roster[p] == null) continue;
      var b = p * PAD_BYTES, o = p * 8;
      out[o] = 1; out[o + 1] = img[b] | (img[b + 1] << 8);
      for (var j = 2; j < 6; j++) out[o + j] = (img[b + j] << 24) >> 24;
      out[o + 6] = img[b + 6]; out[o + 7] = img[b + 7];
    }
    return out;
  }

  // ---- fingerprints ----------------------------------------------------------------------------
  function hashNow(k) {
    var ls = engine(), every = ls && ls.hashEvery > 0 ? ls.hashEvery : 60;
    if (k > 0 && (k - 1) % every === 0) {
      var h = m()._mp4web_rb_hash();
      R.hashAt[k] = (h % 4294967296) >>> 0;
    }
  }
  function flushDue(ls) {
    if (R.replay.length) return;
    var keep = [];
    for (var i = 0; i < R.due.length; i++) {
      var d = R.due[i], h = R.hashAt[d + 1];
      if (h == null) { if (d + 1 > R.next) keep.push(d); continue; }
      try { if (ls.submitHash(d, h)) { R.stats.hashesSent++; R.sent[d] = h; } } catch (e) {}
    }
    R.due = keep;
    if ((R.next & 255) === 0) for (var k in R.hashAt) if (+k < R.next - 1200) delete R.hashAt[k];
  }

  // ---- the frame boundary --------------------------------------------------------------------
  function hook(total) {
    var mod = m();
    if (!mod || R.failed) return R.failed ? HOOK_HOLD : 0;
    if (!R.armed) {
      if (!R.session) return HOOK_HOLD;                   // a room page: nothing runs until the party exists
      if (!canArm()) return HOOK_HOLD;
      if (!arm()) return HOOK_HOLD;
    }
    var ls = engine();
    if (!ls) { fail('the session went away'); return HOOK_HOLD; }

    // 1. close the frame that just ran (once per boundary, not per HOLD retry)
    if (R.atTotal !== total) {
      R.atTotal = total;
      if (R.lastRan >= 0) {
        var k = R.lastRan + 1;
        R.next = k;
        mod._mp4web_rb_boundary(k);
        hashNow(k);
        if (R.lastLive === R.lastRan) {
          R.lastLive = -1;
          ls.endFrame(null);
          if (ls.rollback > 0) { var dq = ls.takeHashDue(); for (var i = 0; i < dq.length; i++) R.due.push(dq[i]); }
          else if (R.hashAt[k] != null && (k - 1) % (ls.hashEvery || 60) === 0) { try { if (ls.submitHash(k - 1, R.hashAt[k])) { R.stats.hashesSent++; R.sent[k - 1] = R.hashAt[k]; } } catch (e) {} }
          R.stats.frameTimes.push(performance.now()); if (R.stats.frameTimes.length > 4000) R.stats.frameTimes.splice(0, 1000);
        }
      }
    }

    // 2. a rewind in progress
    if (R.replay.length) {
      var it = R.replay.shift();
      return runFrame(it.frame, it.image, it.live, it.live ? it.hidden : true);
    }

    // 3. the room's next frame
    if (ls.state !== 'running' && ls.state !== 'stalled') {
      if (ls.state === 'desync' || ls.state === 'failed' || ls.state === 'ended') { R.running = false; R.stopReason = ls.state; }
      R.stats.holds++;
      return HOOK_HOLD;
    }
    if (!R.running) { R.running = true; R.log('room: running — ' + (ls.rollback ? 'rollback, window ' + ls.rollback : 'delay ' + ls.delay)); }
    flushDue(ls);
    if (R.tickedAt !== total) {
      R.tickedAt = total;
      if (typeof ls.rbCatchUp === 'function') { var cu = ls.rbCatchUp() | 0; if (cu > 0) R.catchUp = Math.min(8, R.catchUp + cu); }
    }
    var rejoining = typeof ls.rbRejoining === 'function' && ls.rbRejoining();
    var hidden = rejoining || R.catchUp > 0;
    var r = ls.beginFrame(localPads(ls), hidden ? { hidden: true } : undefined);
    if (ls.rollback && typeof ls.rbRingFrames === 'function' && ls.rbRingFrames() > RING) { fail('the room\'s rollback window (' + ls.rollback + ') outgrew this console\'s ' + RING + '-frame history'); return HOOK_HOLD; }
    if (!r || !r.ready) { R.stats.holds++; R.waiting = r ? (r.waitingOn || []).slice() : null; return HOOK_HOLD; }
    R.waiting = null;
    if (hidden && R.catchUp > 0) R.catchUp--;
    if (r.rollback) {
      var t0 = performance.now();
      var rc = mod._mp4web_rb_restore(r.rollback.from);
      var dt = performance.now() - t0; if (dt > R.stats.maxRestoreMs) R.stats.maxRestoreMs = dt;
      if (rc < 0) { R.stats.restoreFail++; fail('rewind to frame ' + r.rollback.from + ' is out of reach (' + rc + ')'); return HOOK_HOLD; }
      for (var hk in R.hashAt) if (+hk > r.rollback.from) delete R.hashAt[hk];
      R.stats.rollbacks++; if (r.rollback.depth > R.stats.maxDepth) R.stats.maxDepth = r.rollback.depth;
      R.replay = r.rollback.frames.map(function (f) { return { frame: f.frame, image: f.image, live: false }; });
      R.replay.push({ frame: r.frame, image: r.image, live: true, hidden: hidden });
      R.next = r.rollback.from;
      var first = R.replay.shift();
      return runFrame(first.frame, first.image, first.live, first.live ? first.hidden : true);
    }
    return runFrame(r.frame, r.image, true, hidden);
  }
  function runFrame(frame, image, live, quiet) {
    R.image = image;
    R.lastRan = frame;
    if (live) { R.lastLive = frame; R.stats.live++; if (quiet) R.stats.hidden++; }
    else R.stats.resim++;
    R.pushMute = !!quiet;                 // its samples arrive at the next boundary; a repeat or a hidden frame is not heard
    return (quiet || !live) ? HOOK_OFF : 0;
  }

  function attach(mod) {
    R.mod = mod;
    var prev = mod.mp4FrameHook;
    // A game that started before any room existed is solo for good: its state is not the room's
    // frame 0, so it can never join one (reload with the code to join).
    R.solo = !R.session && !R.handoff;
    mod.mp4FrameHook = function (total) {
      var fl = prev ? (prev(total) | 0) : 0;
      if (R.solo) return fl;
      return fl | hook(total);
    };
    if (window.Mp4Input && !R.solo) Mp4Input.override(function () { return latch(); });
  }

  // A report for the page's readout and for a rig.
  function report() {
    var ls = engine(), ft = R.stats.frameTimes, now = performance.now();
    var win5 = 0; for (var i = ft.length - 1; i >= 0 && ft[i] > now - 5000; i--) win5++;
    var eng = null;
    if (ls) {
      eng = { state: ls.state, frame: ls.frame, rollback: ls.rollback, delay: ls.delay, roster: ls.roster, localPorts: ls.localPorts,
              hashesCompared: ls.stats ? ls.stats.hashesCompared : null, hashesSent: ls.stats ? ls.stats.hashesSent : null,
              lastAgreed: ls.lastAgreedFrame, desync: ls.state === 'desync' };
      try { eng.rb = ls.rollback ? ls.rollbackReport() : null; } catch (e) {}
      try { eng.clock = ls.clockStats ? Object.assign({}, ls.clockStats) : null; } catch (e) {}
    }
    return { active: !!(R.session || R.handoff), role: R.role, want: R.want, seated: ls ? seated(ls) : 0, armed: R.armed, running: R.running, failed: R.failed,
             stopReason: R.stopReason || null, next: R.next, waiting: R.waiting || null, broken: R.broken,
             stats: { live: R.stats.live, resim: R.stats.resim, hidden: R.stats.hidden, rollbacks: R.stats.rollbacks, maxDepth: R.stats.maxDepth,
                      holds: R.stats.holds, hashesSent: R.stats.hashesSent, restoreFail: R.stats.restoreFail, maxRestoreMs: R.stats.maxRestoreMs,
                      liveFramesLast5s: win5 },
             engine: eng };
  }
  // Room frames per 5 s window over the run: what "never faster than the hardware" is checked on.
  function windows(ms) {
    ms = ms || 5000;
    var ft = R.stats.frameTimes, out = [];
    if (ft.length < 2) return out;
    for (var t = ft[0]; t + ms <= ft[ft.length - 1]; t += ms) {
      var n = 0; for (var i = 0; i < ft.length; i++) if (ft[i] >= t && ft[i] < t + ms) n++;
      out.push(n / (ms / 1000) / 60);
    }
    return out;
  }

  window.Mp4Room = {
    mount: mount, attach: attach, bootOpts: bootOpts, report: report, windows: windows,
    pushMuted: function () { return R.pushMute; },
    sent: function () { return Object.assign({}, R.sent); },
    // The host starts with whoever is in now (2+), instead of waiting for the count it asked for.
    startNow: function () { var ls = engine(); if (ls && R.role === 'host' && !R.armed && seated(ls) >= 2) { R.want = seated(ls); return true; } return false; },
    active: function () { return !!(R.session || R.handoff); },
    _R: R
  };
})();
