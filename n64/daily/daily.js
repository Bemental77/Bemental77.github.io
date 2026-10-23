// SM64 DAILY PARKOUR — a 2-minute checkpoint run, a new one every day (n64/daily/README.md).
//
// Loaded by /n64/?daily (n64/index.html). Owns nothing in the emulator: it
// reads guest RAM through the core's _neil_rdram_ptr export, restores the
// day's start state through the same /savestate.gz + _neil_unserialize path
// the page's Load State uses, and freezes the guest for the countdown with
// _neil_ls_arm (the free-running loop returns early while armed,
// mymain.cpp:951). It never touches pacing: the guest runs at the page's
// 1.000x and the clock is GUEST time (VIs), so a stutter can't cost the
// player time.
//
// Every checkpoint is a node of a route the explorer (n64/tools/
// sm64_daily_explore.mjs) actually reached by playing the game from the same
// start state. The day's checkpoints are an ordered subset of ONE such proof
// chain, so the whole challenge is achievable in at most the chain's time.
(function () {
  'use strict';
  var LIMIT_S = 120;
  var ROUTE = '/n64/daily/routes/castle_grounds.json';
  var STATE = '/n64/daily/states/castle_grounds.gz';
  var EPOCH = '2026-10-23';           // challenge #1
  var STORE = 'sm64daily.v1';
  // SM64 (US) RAM, verified on a live boot (n64/daily/README.md "RAM map").
  var MARIO = 0x8033B170, LEVEL = 0x8032DDF8;
  var R_XZ = 200, R_Y = 260;          // checkpoint capture radius, game units

  // ── seeded day ────────────────────────────────────────────────────────────
  function dateKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayNumber(key) { return Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse(EPOCH + 'T00:00:00Z')) / 86400000) + 1; }
  function hash(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // Pick the day's challenge from the route tree. Exported for the node test.
  function generate(route, key) {
    var rnd = mulberry32(hash('sm64daily:' + key));
    var byId = {}; route.nodes.forEach(function (n) { byId[n.id] = n; });
    var viHz = route.viHz || 60;
    var chainOf = function (n) { var c = []; while (n && n.parent) { c.unshift(n); n = byId[n.parent]; } return c; };
    var dist = function (a, b) { return Math.hypot(a.x - b.x, a.z - b.z); };
    // Bot par must leave a human real slack inside the 2 minutes.
    var bands = [[25, 75], [15, 90], [5, 110]];
    for (var b = 0; b < bands.length; b++) {
      var lo = bands[b][0] * viHz, hi = bands[b][1] * viHz;
      var pool = route.nodes.filter(function (n) { return n.parent && n.t >= lo && n.t <= hi && dist(n, route.start) > 1200; });
      if (!pool.length) continue;
      // Favour high and far targets: that is where the parkour is.
      var w = pool.map(function (n) { return 1 + Math.max(0, n.y - route.start.y) / 400 + dist(n, route.start) / 3000; });
      var sum = w.reduce(function (s, x) { return s + x; }, 0), r = rnd() * sum, target = pool[pool.length - 1];
      for (var i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) { target = pool[i]; break; } }
      var chain = chainOf(target), want = Math.min(5, chain.length), cps = [];
      for (var k = 1; k <= want; k++) {
        var n = chain[Math.max(0, Math.round(k * chain.length / want) - 1)];
        var prev = cps.length ? cps[cps.length - 1] : route.start;
        if (n === target || (dist(n, prev) > 500 && dist(n, target) > 500)) cps.push(n);
      }
      if (cps[cps.length - 1] !== target) cps.push(target);
      return { key: key, number: dayNumber(key), parVi: target.t, viHz: viHz,
               checkpoints: cps.map(function (n) { return { x: n.x, y: n.y, z: n.z, t: n.t }; }) };
    }
    return null;
  }
  window.SM64Daily = { generate: generate, dateKey: dateKey, dayNumber: dayNumber };
  if (typeof document === 'undefined' || !new URLSearchParams(location.search).has('daily')) return;

  // ── RAM ───────────────────────────────────────────────────────────────────
  var M = null, P = 0;
  function f32(a) { return M.HEAPF32[(P + (a & 0x1FFFFFFF)) >>> 2]; }
  function u32(a) { return M.HEAPU32[(P + (a & 0x1FFFFFFF)) >>> 2] >>> 0; }
  function s16(a) { return M.HEAP16[(P + ((a & 0x1FFFFFFF) ^ 2)) >>> 1]; }
  function mario() {
    return { act: u32(MARIO + 0x0C), x: f32(MARIO + 0x3C), y: f32(MARIO + 0x40), z: f32(MARIO + 0x44),
             yaw: s16(MARIO + 0x2E), hp: s16(MARIO + 0xAE), level: s16(LEVEL) };
  }
  function vi() { return M._neil_vi_total() >>> 0; }

  // ── storage ───────────────────────────────────────────────────────────────
  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || { days: {} }; } catch (e) { return { days: {} }; } }
  function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) {} }
  function better(a, b) { return !b || a.cps > b.cps || (a.cps === b.cps && a.vi < b.vi); }
  function streak(s, key) {
    var n = 0, d = new Date(key + 'T12:00:00');
    while (s.days[dateKey(d)] && s.days[dateKey(d)].best && s.days[dateKey(d)].best.done) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    '#sd-hud{position:absolute;inset:0;pointer-events:none;font:600 15px/1.2 system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px #000,0 0 2px #000;z-index:5}',
    '#sd-time{position:absolute;top:10px;left:12px;font:700 26px/1 ui-monospace,Menlo,monospace}',
    '#sd-time.low{color:#ff6b5a}',
    '#sd-cp{position:absolute;top:12px;right:12px;font-size:18px;letter-spacing:2px}',
    '#sd-nav{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.35);padding:6px 12px;border-radius:20px}',
    '#sd-arrow{width:34px;height:34px;transition:transform .08s linear}',
    '#sd-flash{position:absolute;top:40%;left:0;right:0;text-align:center;font:800 40px/1 system-ui,sans-serif;opacity:0;transition:opacity .25s}',
    '#sd-card{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,12,20,.82);pointer-events:auto;z-index:6}',
    '#sd-card .box{max-width:420px;width:calc(100% - 32px);background:#181c28;border:1px solid #2c3346;border-radius:14px;padding:20px 22px;color:#e8ecf4;text-shadow:none;font:400 15px/1.45 system-ui,sans-serif}',
    '#sd-card h2{margin:0 0 4px;font-size:22px}#sd-card .sub{color:#9aa4b8;margin:0 0 14px}',
    '#sd-card .row{display:flex;justify-content:space-between;margin:4px 0}#sd-card .big{font:700 30px/1.2 ui-monospace,Menlo,monospace;margin:8px 0}',
    '#sd-card button{font:600 15px system-ui,sans-serif;padding:10px 16px;border-radius:9px;border:0;cursor:pointer;margin:12px 8px 0 0}',
    '#sd-card .go{background:#e63b2e;color:#fff}#sd-card .alt{background:#2c3346;color:#e8ecf4}',
    '#sd-card pre{background:#0f121a;padding:10px;border-radius:8px;white-space:pre-wrap;font:14px/1.4 ui-monospace,Menlo,monospace}',
  ].join('\n');
  document.head.appendChild(css);

  var host, hud, card;
  function mount() {
    var c = document.getElementById('canvas');
    host = c.parentElement; if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    hud = document.createElement('div'); hud.id = 'sd-hud';
    hud.innerHTML = '<div id="sd-time">2:00.00</div><div id="sd-cp"></div>'
      + '<div id="sd-nav"><svg id="sd-arrow" viewBox="0 0 34 34"><path d="M17 3 L29 29 L17 22 L5 29 Z" fill="#ffd23f" stroke="#000" stroke-width="1.5"/></svg><span id="sd-dist"></span></div>'
      + '<div id="sd-flash"></div>';
    host.appendChild(hud);
    card = document.createElement('div'); card.id = 'sd-card'; host.appendChild(card);
  }
  function $(id) { return document.getElementById(id); }
  function fmt(vis, hz) { var s = Math.max(0, vis) / hz, m = Math.floor(s / 60); s -= m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); }
  function flash(t) { var f = $('sd-flash'); f.textContent = t; f.style.opacity = 1; clearTimeout(flash._t); flash._t = setTimeout(function () { f.style.opacity = 0; }, 900); }
  function showCard(html) { card.innerHTML = '<div class="box">' + html + '</div>'; card.style.display = 'flex'; }
  function hideCard() { card.style.display = 'none'; }

  // ── game ──────────────────────────────────────────────────────────────────
  var today = dateKey(new Date()), ch = null, stateBytes = null, run = null;

  function cpsLine(n) { var s = ''; for (var i = 0; i < ch.checkpoints.length; i++) s += i < n ? '🟨' : '⬛'; return s; }
  function shareText(best) {
    return 'SM64 Daily Parkour #' + ch.number + '\n' + cpsLine(best.cps) + ' '
      + (best.done ? fmt(best.vi, ch.viHz) : best.cps + '/' + ch.checkpoints.length) + '\n' + location.origin + '/sm64daily.html';
  }
  function intro() {
    var s = load(), d = s.days[today];
    showCard('<h2>SM64 Daily Parkour #' + ch.number + '</h2><p class="sub">' + today + ' · Castle Grounds</p>'
      + '<p>Hit all <b>' + ch.checkpoints.length + ' checkpoints</b> in order before the 2:00 clock runs out. Follow the yellow arrow. '
      + 'Every checkpoint was reached by a bot playing the real game from this exact start, so today\'s run is beatable.</p>'
      + '<div class="row"><span>Bot par</span><b>' + fmt(ch.parVi, ch.viHz) + '</b></div>'
      + (d && d.best ? '<div class="row"><span>Your best today</span><b>' + (d.best.done ? fmt(d.best.vi, ch.viHz) : d.best.cps + '/' + ch.checkpoints.length) + '</b></div>' : '')
      + '<div class="row"><span>Streak</span><b>' + streak(s, today) + '</b></div>'
      + '<button class="go" id="sd-go">' + (d ? 'Try again' : 'Start') + '</button>'
      + '<p class="sub" style="margin-top:12px">Stick W/A/S/D · A = M · B = N · Z = Z · restart = Backspace</p>');
    $('sd-go').onclick = begin;
  }
  function begin() {
    hideCard();
    M._neil_ls_arm(0);
    M.FS.writeFile('/savestate.gz', stateBytes);
    if (!M._neil_unserialize()) { showCard('<h2>Could not load the start state</h2><p>Reload the page to try again.</p>'); return; }
    // Freeze the restored frame for the countdown: while armed, only
    // _neil_ls_run_frame advances the guest and nobody calls it.
    M._neil_ls_arm(1); M._neil_ls_run_frame();
    run = { next: 0, startVi: null, over: false };
    var n = 3;
    (function count() {
      if (n > 0) { flash(String(n--)); setTimeout(count, 700); return; }
      flash('GO!'); M._neil_ls_arm(0); run.startVi = vi(); tick();
    })();
  }
  function end(done) {
    run.over = true;
    var elapsed = vi() - run.startVi, res = { cps: run.next, vi: done ? elapsed : LIMIT_S * ch.viHz, done: done };
    var s = load(), d = s.days[today] || (s.days[today] = { attempts: 0 });
    d.attempts++; var newBest = better(res, d.best); if (newBest) d.best = res; save(s);
    showCard('<h2>' + (done ? 'Finished!' : 'Time!') + '</h2>'
      + '<div class="big">' + (done ? fmt(res.vi, ch.viHz) : res.cps + '/' + ch.checkpoints.length) + '</div>'
      + '<div>' + cpsLine(res.cps) + (newBest ? ' · <b>new best</b>' : '') + '</div>'
      + '<div class="row"><span>Best today</span><b>' + (d.best.done ? fmt(d.best.vi, ch.viHz) : d.best.cps + '/' + ch.checkpoints.length) + '</b></div>'
      + '<div class="row"><span>Bot par</span><b>' + fmt(ch.parVi, ch.viHz) + '</b></div>'
      + '<div class="row"><span>Attempts</span><b>' + d.attempts + '</b></div><div class="row"><span>Streak</span><b>' + streak(s, today) + '</b></div>'
      + '<pre id="sd-share">' + shareText(d.best) + '</pre>'
      + '<button class="go" id="sd-again">Try again</button><button class="alt" id="sd-copy">Copy result</button>');
    $('sd-again').onclick = begin;
    $('sd-copy').onclick = function () {
      var t = shareText(d.best);
      (navigator.share && /Mobi/.test(navigator.userAgent) ? navigator.share({ text: t }) : navigator.clipboard.writeText(t))
        .then(function () { $('sd-copy').textContent = 'Copied'; }, function () {});
    };
  }
  function tick() {
    if (!run || run.over) return;
    var m = mario(), elapsed = vi() - run.startVi, left = LIMIT_S * ch.viHz - elapsed;
    var cp = ch.checkpoints[run.next];
    if (Math.hypot(m.x - cp.x, m.z - cp.z) < R_XZ && Math.abs(m.y - cp.y) < R_Y) {
      run.next++;
      if (run.next === ch.checkpoints.length) { $('sd-time').textContent = fmt(elapsed, ch.viHz); return end(true); }
      flash('✓ ' + run.next + '/' + ch.checkpoints.length); cp = ch.checkpoints[run.next];
    }
    if (left <= 0) { $('sd-time').textContent = '0:00.00'; return end(false); }
    // Left the level (a warp, a death exit) or lost all health: the run is void, retry from the top.
    if (m.level !== 16 || m.hp < 0x100) { flash('Oops'); run.over = true; setTimeout(begin, 900); return; }
    $('sd-time').textContent = fmt(left, ch.viHz); $('sd-time').classList.toggle('low', left < 15 * ch.viHz);
    $('sd-cp').textContent = cpsLine(run.next);
    // SM64 yaw: x = sin(yaw), z = cos(yaw), 0x10000 = full turn; +yaw turns Mario LEFT on screen.
    var want = Math.atan2(cp.x - m.x, cp.z - m.z) * 32768 / Math.PI, rel = ((want - m.yaw) % 65536 + 98304) % 65536 - 32768;
    $('sd-arrow').style.transform = 'rotate(' + (-rel * 360 / 65536).toFixed(1) + 'deg)';
    var dy = cp.y - m.y;
    $('sd-dist').textContent = Math.round(Math.hypot(cp.x - m.x, cp.z - m.z)) + (Math.abs(dy) > 150 ? (dy > 0 ? ' ▲' : ' ▼') + Math.round(Math.abs(dy)) : '');
    requestAnimationFrame(tick);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Backspace' && run && !run.over && run.startVi !== null) { e.preventDefault(); run.over = true; begin(); }
  });

  // ── boot ──────────────────────────────────────────────────────────────────
  function start() {
    mount();
    showCard('<h2>SM64 Daily Parkour</h2><p class="sub">Loading today\'s challenge…</p>');
    Promise.all([fetch(ROUTE).then(function (r) { return r.json(); }), fetch(STATE).then(function (r) { return r.arrayBuffer(); })])
      .then(function (a) {
        ch = generate(a[0], today); stateBytes = new Uint8Array(a[1]);
        if (!ch) throw new Error('route has no usable checkpoints');
        window.__sm64daily = ch;
        showCard('<h2>SM64 Daily Parkour #' + ch.number + '</h2><p class="sub">' + today + '</p><p>Starting Super Mario 64…</p>');
        // Boot the core through the page's own Start (it owns audio, pacing and mobile controls).
        var sel = $('romSelect'); if (sel && sel.selectedOptions[0] && !/Mario 64/.test(sel.selectedOptions[0].textContent)) return;
        var running = function () { return window.myApp && myApp.rivetsData && myApp.rivetsData.beforeEmulatorStarted === false && window.Module && Module._neil_rdram_ptr; };
        var wait = setInterval(function () {
          if (!running() || Module._neil_vi_total() < 60) return;
          clearInterval(wait); M = window.Module; P = M._neil_rdram_ptr();
          intro();
        }, 100);
      })
      .catch(function (e) { showCard('<h2>Could not load today\'s challenge</h2><p>' + String(e.message || e) + '</p>'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
