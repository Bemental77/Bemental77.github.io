/* netreport.js — an always-on flight recorder for N64 netplay rooms.
 *
 * WHY: a host lagged unplayably in an online Smash Remix room and nothing survived the page
 * closing. This samples, ONCE A SECOND, numbers the page already computes (window.__n64Net(),
 * window.__n64Rate, window.__n64Pace(), window.__audioDbg) into a bounded ring, keeps a rolling
 * snapshot in localStorage so a closed tab still leaves data, and exports it as JSON.
 *
 * COST: nothing per frame. One 1 Hz timer; the only other hook is a console.log wrapper that does
 * one charCode compare per line and records a handful of '[rollback]'/'[lockstep]'/'[net]' lines.
 * It READS existing getters only. It touches no join/handshake code and no rollback internals.
 *
 * Pure parts (extract / diagnose / Recorder) are exported for tests/netreport_test.mjs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.N64NetReport = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') { try { api.install(window); } catch (e) {} }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var MAX_SAMPLES = 1800;      // 30 min at 1 Hz
  var MAX_EVENTS = 300;
  var MAX_LOGS = 200;
  var MAX_STR = 300;
  var PERSIST_ROWS = 600;      // rows kept in the localStorage snapshot (10 min)
  var PERSIST_BYTES = 1500000; // hard cap on the stored string
  var LS_KEY = 'n64netreport.v1', LS_PREV = 'n64netreport.prev.v1';

  function num(v, d) { if (v == null || v === '') return null; v = +v; return isFinite(v) ? (d == null ? v : +v.toFixed(d)) : null; }
  function str(v) { v = v == null ? '' : String(v); return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v; }
  function get(o, path) { for (var i = 0; i < path.length && o != null; i++) o = o[path[i]]; return o == null ? null : o; }

  // ---- one raw reading -> one compact row (pure; every input may be missing) -------------
  function extract(net, rate, pace, audio, extra) {
    net = net || {}; rate = rate || {}; pace = pace || {}; audio = audio || {}; extra = extra || {};
    var eng = net.engine || {}, rbE = get(net, ['rollback', 'engine']) || get(eng, ['rollback']) || {};
    var rbP = get(net, ['rollback', 'page']) || {};
    var pp = eng.peersPace || {}, peers = (pp.peers || []), self = pp.self || {};
    var rtts = [];
    for (var i = 0; i < peers.length; i++) { var r = num(peers[i] && peers[i].rtt); if (r != null) rtts.push(r); }
    var selfRtt = num(self.rtt);
    var st = net.step || {};
    var mode = net.mode || (eng.mode && eng.mode.mode) || null;
    var modeInfo = eng.mode || {};
    var stInfo = get(net, ['rollback', 'state']) || {};
    var stateMem = {};
    for (var k in stInfo) if (/byte|mb|slot|size/i.test(k) && typeof stInfo[k] === 'number') stateMem[k] = stInfo[k];
    var msgsIn = get(eng, ['msgs', 'in']) || {};
    // CONNECTION PATH per seat (lib/netplay.js Session.linkReport via window.__n64Net().links): kind is 'direct' (same
    // network) | 'stun' (peer-to-peer through a NAT) | 'turn' (every packet through a relay server) | 'broker' (the
    // lossy MQTT signalling relay). Compact on purpose: one entry per link, [seat, kind, rttMs].
    var lnk = null, relayed = 0;
    if (net.links && net.links.length) {
      lnk = [];
      for (var li = 0; li < net.links.length; li++) {
        var lk = net.links[li] || {};
        lnk.push([lk.port == null ? null : lk.port, lk.kind || null, num(lk.rttMs)]);
        if (lk.relayed || lk.kind === 'turn' || lk.kind === 'broker') relayed = 1;
      }
    }
    return {
      f: num(net.frame), role: net.role || null, state: net.state || eng.state || null,
      mode: mode === 'lockstep' ? 'delay' : mode, dl: num(eng.delay), win: num(rbE.window),
      winPeak: num(rbE.windowPeak),
      rtt: rtts.length ? rtts : null, rttMax: rtts.length ? Math.max.apply(null, rtts) : selfRtt, selfRtt: selfRtt,
      rttF: num(rbE.rttFrames, 1),
      jit: num(rbE.lateP99, 1), jitMax: num(rbE.lateMax, 1),                  // how late room inputs arrive (frames)
      lag: num(rbE.lag, 2), lead: num(rbE.lead, 2),
      silentDrops: num(rbE.silentDrops), holeNaks: num(rbE.holeNaks), late: num(rbE.lateArrivals),
      nakIn: num(msgsIn.lsnak), winStalls: num(rbE.windowStalls), advWaits: num(net.advWaits),
      lost: num(self.lost, 3), share: num(self.share, 3),                      // stalled share / lost-time share
      fps: num(rate.shown), made: num(rate.made), speed: num(rate.speed, 3), viHz: num(rate.viHz),
      capFps: num(rate.capFps, 1), costMs: num(rate.costMs, 2), duty: num(rate.duty, 2),
      worst: num(net.costMaxMs), costAvg: num(net.costAvgMs, 2), costOver: num(net.costOver),
      stalls: num(net.stalls), stallMs: num(net.stallMs), maxStallMs: num(eng.maxStallMs), waiting: net.waitingOn && net.waitingOn.length ? net.waitingOn.length : 0,
      aud: num(audio.u), audMissing: num(audio.m), audBacklog: num(audio.b),
      st: num(st.selfStepMs, 2), sp: num(st.selfPresentMs, 2),
      need: num(modeInfo.need, 3), cap: num(net.selfCap, 2),
      rbs: num(rbE.rollbacks != null ? rbE.rollbacks : rbP.rollbacks), resimMs: num(rbP.resimMsTotal), maxResimMs: num(rbP.maxResimMs, 1),
      depthAvg: num(rbE.meanDepth != null ? rbE.meanDepth : rbP.depthAvg, 2), depthMax: num(rbE.maxDepth != null ? rbE.maxDepth : rbP.maxDepth),
      resimFrames: num(rbE.resimFrames), ring: num(rbE.ringFrames), ringAlloc: num(rbP.allocated), ringCap: num(rbP.cap),
      ringMem: Object.keys(stateMem).length ? stateMem : null,
      heapMB: num(extra.heapMB, 1), timerLagMs: num(extra.timerLagMs, 1), frameAgeMs: num(extra.frameAgeMs),
      owedLostMs: num(pace.lostMs), reanchors: num(pace.reanchors != null ? pace.reanchors : net.reanchors),
      desync: eng.desync ? str(JSON.stringify(eng.desync)) : null, error: eng.error ? str(eng.error) : null,
      fault: net.fault ? str(net.fault) : null,
      lnk: lnk, relayed: relayed,
      build: net.buildMismatch && net.buildMismatch.length ? str(net.buildMismatch.join(',')) : null
    };
  }

  // ---- derive events from successive rows + the engine's own histories (pure) ----------------
  function deriveEvents(prev, row, net) {
    var ev = [];
    if (!prev) return ev;
    if (prev.mode !== row.mode && row.mode) ev.push(['mode', 'mode ' + prev.mode + ' -> ' + row.mode + ' (delay ' + row.dl + ', window ' + row.win + ', need ' + row.need + ')']);
    else if (prev.dl !== row.dl && row.dl != null) ev.push(['delay', 'delay ' + prev.dl + ' -> ' + row.dl]);
    if (prev.win != null && row.win != null && prev.win !== row.win) ev.push(['window', 'rollback window ' + prev.win + ' -> ' + row.win]);
    if (row.desync && !prev.desync) ev.push(['desync', row.desync]);
    if (row.error && !prev.error) ev.push(['failure', row.error]);
    if (row.fault && !prev.fault) ev.push(['fault', row.fault]);
    if (prev.state !== row.state && row.state) ev.push(['state', prev.state + ' -> ' + row.state]);
    if (row.lnk) {
      var was = {};
      if (prev.lnk) for (var pi = 0; pi < prev.lnk.length; pi++) was[prev.lnk[pi][0]] = prev.lnk[pi][1];
      for (var ni = 0; ni < row.lnk.length; ni++) {
        var l = row.lnk[ni];
        if (l[1] && was[l[0]] !== l[1]) ev.push(['link', 'seat ' + (l[0] == null ? '?' : l[0] + 1) + ' path ' + (was[l[0]] || 'unknown') + ' -> ' + l[1] + (l[1] === 'turn' || l[1] === 'broker' ? ' (RELAYED)' : '') + (l[2] != null ? ', rtt ' + l[2] + ' ms' : '')]);
      }
    }
    if (row.build && !prev.build) ev.push(['build-mismatch', 'script builds differ from the other end: ' + row.build]);
    if (row.reanchors != null && prev.reanchors != null && row.reanchors > prev.reanchors) ev.push(['reanchor', 'pace re-anchored x' + (row.reanchors - prev.reanchors)]);
    if (row.stallMs != null && prev.stallMs != null && row.stallMs - prev.stallMs >= 250) ev.push(['stall', 'stalled ' + (row.stallMs - prev.stallMs) + ' ms this second']);
    if (row.aud != null && prev.aud != null && row.aud - prev.aud >= 5) ev.push(['audio', row.aud - prev.aud + ' audio underruns this second']);
    return ev;
  }
  // the engine keeps the reason text of every mode switch; surface new ones once
  function modeHistoryEvents(net, seen) {
    var out = [], h = get(net, ['engine', 'mode', 'history']) || [];
    for (var i = 0; i < h.length; i++) {
      var m = h[i], key = (m.frame | 0) + ':' + m.to + ':' + (m.delay | 0);
      if (seen[key]) continue; seen[key] = 1;
      out.push(['mode-switch', 'frame ' + m.frame + ' -> ' + m.to + ' (' + (m.kind || '?') + (m.mine ? ', this device' : '') + ') ' + str(m.why || m.text)]);
    }
    return out;
  }

  // ---- the one-line cause (pure). rows = recent rows, newest last; ev = recent events -------
  function diagnose(rows, events, opts) {
    opts = opts || {};
    var n = opts.seconds || 5;
    if (!rows || rows.length < n) return null;
    var w = rows.slice(-n), last = w[w.length - 1];
    var viHz = last.viHz || 60, target = viHz;
    var low = 0, fpsSum = 0, fpsN = 0;
    for (var i = 0; i < w.length; i++) { if (w[i].fps == null) return null; fpsN++; fpsSum += w[i].fps; if (w[i].fps < 0.9 * target) low++; }
    if (low < n) return null;                                   // not SUSTAINED
    var avg = fpsSum / fpsN, frameMs = 1000 / viHz;
    var flips = 0;
    for (var j = 0; j < (events || []).length; j++) {
      var e = events[j]; if ((e.k === 'mode' || e.k === 'mode-switch') && e.t >= last.t - 60000) flips++;
    }
    function mx(k) { var m = 0; for (var q = 0; q < w.length; q++) if (w[q][k] != null && w[q][k] > m) m = w[q][k]; return m; }
    var step = Math.max(mx('st'), mx('sp'), mx('costMs')), rtt = mx('rttMax'), jit = mx('jit');
    var stallDelta = (last.stallMs || 0) - (w[0].stallMs || 0);
    var head = 'Lag: ' + avg.toFixed(0) + ' of ' + target + ' fps for ' + n + ' s. ';
    if (flips >= 3) return { kind: 'mode-flap', text: head + 'Cause: mode flapping (' + flips + ' rollback/delay switches in 60 s).' };
    var cpu = step / frameMs, netShare = stallDelta / (n * 1000);
    // PRESENTATION STARVATION (2026-10-31): this device advances and MAKES pictures at the game's rate
    // but too few reach the screen, with the link healthy. Measured in the two-process rig (host core
    // worker slowed 3x: step ~10 ms of 16.7, shown 37-44/s of 60, RTT 1 ms) the old rules below read
    // that as "network — RTT 1 ms, stalled 34%": a stall with a 1 ms RTT is this console making the
    // room wait, not the wire. So a low shown/made with a healthy RTT is blamed on the host first.
    var madeSum = 0, madeN = 0;
    for (var m2 = 0; m2 < w.length; m2++) if (w[m2].made != null) { madeSum += w[m2].made; madeN++; }
    var made = madeN ? madeSum / madeN : null;
    // `made` is the game's own counter and runs ABOVE the field rate in a rollback room (re-simulated frames count: 84-123 'made' against 60 in a healthy 30-80 ms room), so the bar is the field rate, never made alone
    var wireOk = rtt < 40 && jit < 6;
    if (wireOk && made != null && made >= 0.9 * target && avg < 0.8 * Math.min(made, target))
      return { kind: 'host-present', text: head + 'Cause: this device — it makes ' + made.toFixed(0) + ' pictures/s but only ' + avg.toFixed(0) + ' reach the screen (RTT ' + Math.round(rtt) + ' ms is fine; a step costs ' + step.toFixed(1) + ' ms of ' + frameMs.toFixed(1) + ' ms): the console\'s render/present thread is starved.' };
    if (cpu >= 0.7 && !(netShare > 0.2 && rtt > step * 4))
      return { kind: 'host-cpu', text: head + 'Cause: host CPU — a step costs ' + step.toFixed(1) + ' ms of a ' + frameMs.toFixed(1) + ' ms frame (' + Math.round(cpu * 100) + '%).' };
    if (wireOk && netShare > 0.2 && cpu >= 0.4)
      return { kind: 'host-cpu', text: head + 'Cause: host CPU — stalled ' + Math.round(netShare * 100) + '% of the time with a healthy link (RTT ' + Math.round(rtt) + ' ms); a step costs ' + step.toFixed(1) + ' ms of a ' + frameMs.toFixed(1) + ' ms frame (' + Math.round(cpu * 100) + '%).' };
    var relayedNow = false, relayKinds = {};
    for (var rw = 0; rw < w.length; rw++) if (w[rw].relayed && w[rw].lnk) { relayedNow = true; for (var rl = 0; rl < w[rw].lnk.length; rl++) if (w[rw].lnk[rl][1] === 'turn' || w[rw].lnk[rl][1] === 'broker') relayKinds[w[rw].lnk[rl][1]] = 1; }
    if (relayedNow && (rtt >= 60 || (netShare > 0.1 && !wireOk) || jit >= 4))
      return { kind: 'relay', text: head + 'Cause: a connection is RELAYED (' + Object.keys(relayKinds).join(' + ') + (relayKinds.broker ? ' - the lossy signalling-broker channel' : ' - through a relay server') + '), not peer-to-peer: RTT ' + Math.round(rtt) + ' ms, stalled ' + Math.round(netShare * 100) + '% of the time, input lateness p99 ' + jit + ' frames.' };
    if (rtt >= 100 || (netShare > 0.2 && !wireOk) || jit >= 6)
      return { kind: 'network', text: head + 'Cause: network — RTT ' + Math.round(rtt) + ' ms, stalled ' + Math.round(netShare * 100) + '% of the time, input lateness p99 ' + jit + ' frames.' };
    return { kind: 'unknown', text: head + 'No single cause stands out (step ' + step.toFixed(1) + ' ms, RTT ' + Math.round(rtt) + ' ms); copy the session report.' };
  }

  // ---- the bounded recorder (pure; no DOM) ------------------------------------------------
  function Recorder(opts) {
    opts = opts || {};
    this.maxSamples = opts.maxSamples || MAX_SAMPLES; this.maxEvents = opts.maxEvents || MAX_EVENTS; this.maxLogs = opts.maxLogs || MAX_LOGS;
    this.t0 = opts.t0 != null ? opts.t0 : 0;
    this.meta = opts.meta || {};
    this.rows = []; this.events = []; this.logs = [];
    this.droppedRows = 0; this.droppedEvents = 0; this.droppedLogs = 0;
    this.seen = {}; this.seenN = 0;
  }
  Recorder.prototype.sample = function (t, row, net) {
    row.t = Math.round(t - this.t0);
    var prev = this.rows.length ? this.rows[this.rows.length - 1] : null;
    var evs = deriveEvents(prev, row, net).concat(net ? modeHistoryEvents(net, this.seen) : []);
    if (++this.seenN > 500) { this.seen = {}; this.seenN = 0; }        // bound the dedupe set
    this.rows.push(row);
    if (this.rows.length > this.maxSamples) { this.rows.splice(0, this.rows.length - this.maxSamples); this.droppedRows++; }
    for (var i = 0; i < evs.length; i++) this.event(t, evs[i][0], evs[i][1]);
    return row;
  };
  Recorder.prototype.event = function (t, kind, text) {
    this.events.push({ t: Math.round(t - this.t0), k: String(kind).slice(0, 24), d: str(text) });
    if (this.events.length > this.maxEvents) { this.events.splice(0, this.events.length - this.maxEvents); this.droppedEvents++; }
  };
  Recorder.prototype.log = function (t, line) {
    this.logs.push({ t: Math.round(t - this.t0), s: str(line) });
    if (this.logs.length > this.maxLogs) { this.logs.splice(0, this.logs.length - this.maxLogs); this.droppedLogs++; }
  };
  Recorder.prototype.summary = function () {
    var r = this.rows, s = { seconds: r.length, fpsMin: null, fpsMean: null, rttMaxMs: null, stepMaxMs: null, rollbacksMax: null, modeSwitches: 0, desyncs: 0, failures: 0, relayedSeconds: 0, linkKinds: {}, buildMismatch: false };
    var sum = 0, n = 0;
    for (var i = 0; i < r.length; i++) {
      var x = r[i];
      if (x.fps != null) { s.fpsMin = s.fpsMin == null ? x.fps : Math.min(s.fpsMin, x.fps); sum += x.fps; n++; }
      if (x.rttMax != null) s.rttMaxMs = Math.max(s.rttMaxMs == null ? 0 : s.rttMaxMs, x.rttMax);
      var st = Math.max(x.st || 0, x.sp || 0); if (st) s.stepMaxMs = Math.max(s.stepMaxMs || 0, st);
      if (x.rbs != null) s.rollbacksMax = Math.max(s.rollbacksMax || 0, x.rbs);
      if (x.relayed) s.relayedSeconds++;
      if (x.build) s.buildMismatch = true;
      if (x.lnk) for (var q = 0; q < x.lnk.length; q++) if (x.lnk[q][1]) s.linkKinds[x.lnk[q][1]] = (s.linkKinds[x.lnk[q][1]] || 0) + 1;
    }
    if (n) s.fpsMean = +(sum / n).toFixed(1);
    for (var j = 0; j < this.events.length; j++) { var k = this.events[j].k; if (k === 'mode' || k === 'mode-switch') s.modeSwitches++; else if (k === 'desync') s.desyncs++; else if (k === 'failure') s.failures++; }
    return s;
  };
  Recorder.prototype.toJSON = function (lastRows) {
    var rows = lastRows ? this.rows.slice(-lastRows) : this.rows;
    return { v: VERSION, kind: 'n64-netreport', meta: this.meta, summary: this.summary(), rows: rows, events: this.events, logs: this.logs,
             dropped: { rows: this.droppedRows, events: this.droppedEvents, logs: this.droppedLogs } };
  };
  // serialise within a byte budget: shed rows first, then logs
  Recorder.prototype.serialize = function (lastRows, maxBytes) {
    var rows = lastRows || this.rows.length, s;
    for (;;) {
      s = JSON.stringify(this.toJSON(rows));
      if (!maxBytes || s.length <= maxBytes || rows <= 30) return s;
      rows = Math.floor(rows / 2);
    }
  };

  // ---- the browser wiring ---------------------------------------------------------------
  function install(win) {
    if (win.__n64NetReportInstalled) return win.__n64NetReportInstalled;
    var doc = win.document, nav = win.navigator || {}, perf = win.performance;
    var qs = ''; try { qs = win.location.search || ''; } catch (e) {}
    function stamps() {
      var o = {};
      try { var sc = doc.scripts; for (var i = 0; i < sc.length; i++) { var m = /\/([A-Za-z0-9_.-]+\.js)\?v=([^&]+)/.exec(sc[i].src || ''); if (m) o[m[1]] = m[2]; } } catch (e) {}
      return o;
    }
    function romName(net) {
      try { var sel = doc.getElementById('romSelect'); if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text; } catch (e) {}
      return get(net, ['engine', 'game']) || get(net, ['fb', 'rom']) || null;
    }
    var rec = new Recorder({ t0: perf ? perf.now() : 0, meta: {} });
    rec.meta = { started: new Date().toISOString(), ua: nav.userAgent || null, cores: nav.hardwareConcurrency || null,
                 deviceMemory: nav.deviceMemory == null ? null : nav.deviceMemory, build: stamps(), url: (function () { try { return win.location.pathname + qs; } catch (e) { return null; } })(),
                 crossOriginIsolated: !!win.crossOriginIsolated, rom: null, role: null };
    // keep the PREVIOUS page-life's snapshot so a closed/crashed tab is recoverable on the next visit
    var previous = null;
    try { var old = win.localStorage.getItem(LS_KEY); if (old) { win.localStorage.setItem(LS_PREV, old); previous = JSON.parse(old); } else { var p = win.localStorage.getItem(LS_PREV); if (p) previous = JSON.parse(p); } } catch (e) {}

    var lastTick = perf.now(), lastPersist = 0, hint = null, hintShownAt = 0, active = false;
    function inRoom() { var r = doc.getElementById('lsRoom'); return !!(r && !r.hidden); }
    function persist(force) {
      var now = Date.now();
      if (!force && now - lastPersist < 15000) return;
      lastPersist = now;
      try { win.localStorage.setItem(LS_KEY, rec.serialize(PERSIST_ROWS, PERSIST_BYTES)); } catch (e) {}
    }
    function tick() {
      var now = perf.now(), lagMs = now - lastTick - 1000; lastTick = now;
      try {
        if (!inRoom() || typeof win.__n64Net !== 'function') { active = false; return; }
        var net = win.__n64Net();
        if (!net || !net.role) return;
        if (!active) { active = true; rec.event(now, 'room', 'recording as ' + net.role); }
        rec.meta.rom = romName(net); rec.meta.role = net.role;
        var extra = { timerLagMs: Math.max(0, lagMs), heapMB: null, frameAgeMs: null };
        try { if (perf.memory) extra.heapMB = perf.memory.usedJSHeapSize / 1048576; } catch (e) {}
        if (net.frameAt != null) { var fa = +net.frameAt; extra.frameAgeMs = fa > 1e11 ? Date.now() - fa : now - fa; }
        var pace = null; try { pace = typeof win.__n64Pace === 'function' ? win.__n64Pace() : null; } catch (e) {}
        var row = extract(net, win.__n64Rate, pace, win.__audioDbg, extra);
        rec.sample(now, row, net);
        persist(false);
        if (net.role === 'host') updateHint(now);
      } catch (e) { /* the recorder must never throw into the page */ }
    }
    function updateHint(now) {
      var d = diagnose(rec.rows, rec.events, { seconds: 5 });
      try {
        if (!d) { if (hint && now - hintShownAt > 8000) { hint.style.display = 'none'; } return; }
        if (!hint) {
          hint = doc.createElement('div');
          hint.id = 'netReportHint';
          hint.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:92vw;z-index:99999;background:rgba(40,12,12,.92);color:#ffd9d9;font:12px/1.4 system-ui,sans-serif;padding:7px 12px;border-radius:8px;border:1px solid #a33;pointer-events:none';
          (doc.body || doc.documentElement).appendChild(hint);
        }
        hint.textContent = d.text + ' (Party panel: "Copy session report")';
        hint.style.display = 'block'; hintShownAt = now;
        if (now - hintLogAt > 30000) { hintLogAt = now; rec.event(now, 'lag-hint', d.text); }
      } catch (e) {}
    }
    var hintLogAt = 0;

    function report() {
      var j = rec.toJSON(); j.previousSession = previous; j.exportedAt = new Date().toISOString(); return j;
    }
    function download(text) {
      try {
        var b = new win.Blob([text], { type: 'application/json' }), a = doc.createElement('a');
        a.href = win.URL.createObjectURL(b); a.download = 'n64-session-report-' + Date.now() + '.json';
        (doc.body || doc.documentElement).appendChild(a); a.click(); a.remove();
        win.setTimeout(function () { try { win.URL.revokeObjectURL(a.href); } catch (e) {} }, 5000);
        return true;
      } catch (e) { return false; }
    }
    function copy() {
      var text = JSON.stringify(report());
      var done = function (how) { try { win.console.info('[netreport] ' + how + ' (' + text.length + ' bytes)'); } catch (e) {} return how; };
      try {
        if (nav.clipboard && nav.clipboard.writeText) return nav.clipboard.writeText(text).then(function () { return done('copied to clipboard'); }, function () { return done(download(text) ? 'downloaded' : 'failed'); });
      } catch (e) {}
      return Promise.resolve(done(download(text) ? 'downloaded' : 'failed'));
    }

    // console.log tap for the engine's own reason strings — one charCode compare per line
    try {
      var orig = win.console.log, budget = 20, budgetAt = 0;
      win.console.log = function (a) {
        try {
          if (typeof a === 'string' && a.charCodeAt(0) === 91 && /^\[(rollback|lockstep|net)\]/.test(a)) {
            var t = perf.now();
            if (t - budgetAt > 1000) { budgetAt = t; budget = 20; }
            if (budget-- > 0) rec.log(t, a); else rec.droppedLogs++;
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    } catch (e) {}
    try { win.addEventListener('error', function (ev) { rec.event(perf.now(), 'js-error', (ev && ev.message) || 'error'); }); } catch (e) {}
    try { win.addEventListener('unhandledrejection', function (ev) { rec.event(perf.now(), 'js-rejection', String(ev && ev.reason)); }); } catch (e) {}
    try { win.addEventListener('pagehide', function () { persist(true); }); } catch (e) {}
    try { doc.addEventListener('visibilitychange', function () { if (doc.hidden) persist(true); }); } catch (e) {}

    function wireButton() {
      var b = doc.getElementById('lsCopyReport');
      if (!b || b.__nr) return;
      b.__nr = 1;
      b.addEventListener('click', function () { var old = b.textContent; copy().then(function (how) { b.textContent = how === 'failed' ? 'Copy failed' : (how === 'copied to clipboard' ? 'Copied' : 'Downloaded'); win.setTimeout(function () { b.textContent = old; }, 2000); }); });
    }
    wireButton();
    win.setInterval(tick, 1000);
    var api = { rec: rec, report: report, copy: copy, download: function () { return download(JSON.stringify(report())); }, persist: function () { persist(true); }, tick: tick, previous: previous };
    win.__n64NetReport = function () { return report(); };
    win.__n64NetReportApi = api;
    if (/[?&]netreport=1\b/.test(qs)) {
      try { win.console.info('[netreport] ?netreport=1: window.__n64NetReport() returns the JSON; __n64NetReportApi.copy() / .download() export it.'); } catch (e) {}
    }
    win.__n64NetReportInstalled = api;
    return api;
  }

  return { VERSION: VERSION, MAX_SAMPLES: MAX_SAMPLES, extract: extract, deriveEvents: deriveEvents, modeHistoryEvents: modeHistoryEvents,
           diagnose: diagnose, Recorder: Recorder, install: install, LS_KEY: LS_KEY };
});
