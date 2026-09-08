// lib/netplay-host.js — THE HOST HALF of online co-op, for the pages that run an
// emulator.
//
// WHY A SHARED FILE AND NOT A COPY PER PAGE.
// dreamcast.html and gamecube.html each grew their own host arm, and the two are
// the same ~180 lines twice: capture a surface, COUNT the frames it really
// produces, open a Netplay.Session under a code handed over by the lobby page,
// and expose the remote pad. Five more pages (ps1, snes, gba, genesis, n64) need
// exactly that again. Six hand-rolled copies would drift and only the most
// recently touched one would be right — which is the same argument
// lib/netplay-ui.js makes for the lobby.
//
// ⚠ THIS DELIBERATELY DOES NOT TOUCH dreamcast.html OR gamecube.html. Their arms
// are shipping and measured; re-pointing them at this file would be a rewrite of
// working code for tidiness, and the risk is all downside. This file is the
// SHAPE they proved, extracted for the pages that do not have one yet.
//
// WHAT IT DOES NOT DO: it never reads a pad, never writes to a core, and never
// decides what player 2's bits mean. Those are per-console and stay in the page,
// where the wire format can be stated next to the code that decodes it. This
// file hands the page ONE int32 (`NetplayHost.remoteMask()`, or null when nobody
// is connected) and takes back the literal bytes the page gave the core
// (`NetplayHost.report(...)`) so a test can assert on those and not on a UI flag.
'use strict';

(function (global) {
  const H = {
    cfg: null,
    session: null,
    role: null,
    code: null,
    game: null,
    how: null,            // which capture arm won, with its measured frame count
    surface: null,
    mirror: null, mirrorCtx: null, mirrorTicks: 0, mirrorErr: null, mirrorAt: 0, mirrorRaf: 0,
    sentP1: null, sentP2: null,
    why: null,            // why hosting did NOT start, when it did not
    armReason: null,      // 'frames' | 'core-up-no-frames'
    coreUpAt: 0,
    connected: false,
  };
  const FPS = 60;
  // A render fault must not also be a co-op fault: player 2's controller does not
  // depend on the picture at all, so a running core is accepted after this long
  // even with nothing drawn — and the capture arm then MEASURES what the stream
  // actually carries rather than hiding an empty picture behind a green light.
  // (gamecube.html:7357 states the same reasoning for the same constant.)
  const NOFRAME_GRACE_MS = 15000;

  const log = (s) => { try { (H.cfg && H.cfg.log ? H.cfg.log : console.log)('[net] ' + s); } catch (e) {} };
  const qs = () => new URLSearchParams(location.search);

  // ---- THE AUDIO TAP --------------------------------------------------------
  // lib/netplay.js's attachMedia needs an AudioNode it can `.connect()` to a
  // MediaStreamDestination. NOT ONE of these five pages has such a node reachable
  // from page scope, and for three different reasons:
  //   * snes.html and genesis.html build a ScriptProcessorNode inside initAudio()
  //     as a function-local `var sp` and never store it anywhere;
  //   * gba's core does the same inside its vendored dist/script.js;
  //   * ps1 is worse than unreachable — stock Emscripten SDL1 builds a THROWAWAY
  //     AudioBufferSourceNode per batch and connects each straight to
  //     ctx.destination, so there is no persistent node to hand over even in
  //     principle.
  // Exposing a node would mean editing three pages plus a vendored dist file, and
  // would still not solve ps1.
  //
  // So the tap is an INTERPOSER instead: while a connect to `ctx.destination` is
  // being made, it is redirected through a unity GainNode that this file owns and
  // which then hops to the real destination. Everything the visitor can hear
  // passes through one node, whatever built it and however transient it is, and
  // gain 1 is transparent — the host keeps hearing the game exactly as before.
  //
  // ⚠ IT IS ARMED ONLY UNDER ?np=. Patching AudioNode.prototype for every visitor
  // to every emulator page would be a behaviour change on five shipping pages in
  // exchange for nothing. Under ?np= the page is a netplay host by definition,
  // and the patch is installed from <head> — BEFORE the emulator's audio graph
  // exists, which is the only moment at which interposing is possible at all.
  function installAudioTap() {
    if (H.tapInstalled || typeof AudioNode === 'undefined') return;
    H.tapInstalled = true;
    const taps = new WeakMap();
    const orig = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest) {
      try {
        const ctx = this.context;
        if (ctx && dest && dest === ctx.destination && typeof ctx.createGain === 'function') {
          let g = taps.get(ctx);
          if (!g) {
            g = ctx.createGain();
            g.gain.value = 1;
            taps.set(ctx, g);
            orig.call(g, ctx.destination);       // the interposer's own hop to the speakers
          }
          if (this !== g) {
            H.tap = g;                            // the node attachMedia will take
            return orig.call(this, g);
          }
        }
      } catch (e) { /* fall through to the untouched behaviour rather than lose audio */ }
      return orig.apply(this, arguments);
    };
  }
  // Installed at parse time, not at arm() time: by the time a session arms, the
  // page has long since built its audio graph and there is nothing left to
  // interpose on.
  try { if ((qs().get('np') || '')) installAudioTap(); } catch (e) {}

  // Identical spelling to dreamcast.html's netTransport and gamecube.html's
  // gcNetTransport, so ONE ?net=local reaches every page in a session.
  function transport() { return qs().get('net') === 'local' ? 'local' : 'peerjs'; }
  function supported() { return !!(global.Netplay && Netplay.supported && Netplay.supported()); }

  // ---- capture ---------------------------------------------------------------
  // requestVideoFrameCallback fires once per frame actually PRESENTED, which is
  // the only signal that separates a working track from a live-but-empty one. A
  // `video:live` track carrying nothing looks identical to a good one from the
  // outside, so this DOES the capture and COUNTS what comes out instead of
  // reading a capability.
  function countFrames(stream, ms) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true;
      try { v.srcObject = stream; } catch (e) { return resolve(0); }
      let n = 0, done = false, iv = null;
      const finish = () => {
        if (done) return; done = true;
        if (iv) clearInterval(iv);
        try { v.pause(); v.srcObject = null; } catch (e) {}
        resolve(n);
      };
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      if (typeof v.requestVideoFrameCallback === 'function') {
        const tick = () => { n++; if (!done) { try { v.requestVideoFrameCallback(tick); } catch (e) {} } };
        try { v.requestVideoFrameCallback(tick); } catch (e) {}
      } else {
        let last = -1;
        iv = setInterval(() => { if (v.currentTime > last) { last = v.currentTime; n++; } }, 50);
      }
      setTimeout(finish, ms);
    });
  }

  // The mirror is painted by the PAGE's own loop (pumpMirror below is called from
  // the page's input/present tick) so it costs nothing when it is not in use.
  function pumpMirror() {
    if (!H.mirrorCtx) return;
    const t = (performance && performance.now) ? performance.now() : Date.now();
    if (t - H.mirrorAt < 15) return;         // cap at ~60 Hz whatever the caller's cadence
    H.mirrorAt = t;
    try {
      const src = H.cfg.canvas();
      H.mirrorCtx.drawImage(src, 0, 0, H.mirror.width, H.mirror.height);
      H.mirrorTicks++;
    } catch (e) { H.mirrorErr = (e && e.message) ? e.message : String(e); }
  }

  // Is there anything on this surface at all? A mirror canvas can be perfectly
  // "live" and carry nothing — see the trap documented in captureSurface below.
  function mirrorIsBlank() {
    try {
      const w = Math.min(64, H.mirror.width), h2 = Math.min(64, H.mirror.height);
      const d = H.mirrorCtx.getImageData(0, 0, w, h2).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return false;
      return true;
    } catch (e) { return false; }     // a tainted/oversized read is not evidence of blankness
  }

  async function captureSurface() {
    const c = H.cfg.canvas();
    if (!c) { H.why = 'no canvas to capture'; return null; }

    // ARM 1 — the canvas itself, PROBED MORE THAN ONCE.
    //
    // ⚠ ONE EARLY PROBE IS NOT AN ANSWER, and taking it as one shipped a black
    // picture. MEASURED on n64 2026-09-08: the arm fired the instant the page's
    // `shown` counter moved, the 900 ms probe caught 1 frame, the code fell back
    // to a mirror for the rest of the session — while the SAME canvas, probed
    // four seconds later, produced 32 frames in 1500 ms. The canvas was fine; the
    // question was asked too early. So a short count is retried before it is
    // believed.
    let best = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const probe = c.captureStream(FPS);
        const n = await countFrames(probe, 900);
        probe.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        best = Math.max(best, n);
        if (n >= 2) {
          log('capture arm: the canvas produced ' + n + ' frames in 900 ms'
              + (attempt ? ' (on attempt ' + (attempt + 1) + ')' : '') + ' — using it directly');
          return { el: c, how: 'canvas (' + n + ' frames/900ms)' };
        }
        log('capture arm: the canvas produced only ' + n + ' frames in 900 ms — retrying');
      } catch (e) {
        log('capture arm: captureStream threw (' + ((e && e.message) ? e.message : e) + ')');
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }

    // ARM 2 — a mirror painted with drawImage.
    //
    // ⚠ A MIRROR OF A WebGL CANVAS IS OFTEN ENTIRELY BLACK, and it looks perfect
    // from the outside: the track reports live, the frame count is high, every
    // pixel is zero. A context created without preserveDrawingBuffer has its
    // drawing buffer cleared once it has been composited, so a drawImage taken
    // from any tick but the one that drew it copies nothing. MEASURED on n64
    // (webgl2, 640x480): mirrorFrames 50, mirrorPaints 88, mirrorNonBlack 0 —
    // a flawless-looking stream of black. So the mirror has to EARN the job by
    // actually having pixels in it; otherwise even a slow direct capture is the
    // better answer, because it at least carries the game.
    const m = document.createElement('canvas');
    m.width = c.width || 640; m.height = c.height || 480;
    H.mirror = m;
    H.mirrorCtx = m.getContext('2d', { alpha: false });
    // Paint it from here as well as from the page's own tick: a page that forgot
    // to call pumpMirror would otherwise ship one frozen frame, which is the same
    // failure in a different costume.
    if (!H.mirrorRaf) {
      const spin = () => { pumpMirror(); H.mirrorRaf = requestAnimationFrame(spin); };
      H.mirrorRaf = requestAnimationFrame(spin);
    }
    pumpMirror();
    await new Promise((r) => setTimeout(r, 120));      // give the rAF pump a few paints
    const probe2 = m.captureStream(FPS);
    const n2 = await countFrames(probe2, 900);
    probe2.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    const blank = mirrorIsBlank();
    log('capture arm: mirror canvas produced ' + n2 + ' frames in 900 ms (' + H.mirrorTicks + ' paints'
        + (H.mirrorErr ? ', drawImage error: ' + H.mirrorErr : '') + ', pixels: ' + (blank ? 'ALL BLACK' : 'present') + ')');
    if (blank || n2 < 2) {
      if (H.mirrorRaf) { cancelAnimationFrame(H.mirrorRaf); H.mirrorRaf = 0; }
      H.mirror = null; H.mirrorCtx = null;
      log('capture arm: the mirror is not usable — falling back to the canvas itself at '
          + best + ' frames/900ms, which at least carries the game');
      return { el: c, how: 'canvas, mirror rejected (' + best + ' frames/900ms; mirror '
                          + (blank ? 'was all black' : 'produced ' + n2) + ')' };
    }
    return { el: m, how: 'mirror (' + n2 + ' frames/900ms)' };
  }

  // ---- the session -----------------------------------------------------------
  // `code` is the one the lobby page ALREADY SHOWED the other player. Minting a
  // fresh one here would silently strand a guest waiting on the old one.
  async function startHost(code, game) {
    if (H.session) return;
    H.role = 'host'; H.code = code; H.game = game;
    const surf = await captureSurface();
    if (!surf) { log(H.why); H.role = null; return; }
    H.surface = surf.el; H.how = surf.how;
    const s = new Netplay.Session({ game, host: true, code, transport: transport() });
    H.session = s;
    s.on('status', (e) => {
      H.connected = (e.state === 'connected');
      log('host ' + e.state + (e.detail ? ' (' + e.detail + ')' : ''));
      if (H.cfg.onStatus) { try { H.cfg.onStatus(e); } catch (_) {} }
    });
    // ⚠ BEFORE start(). Tracks added after the offer is created never appear in
    // it, and the guest connects to a session with no picture. lib/netplay.js
    // says the same thing above attachMedia.
    // The page may name its own node; otherwise the interposer above is it.
    let audio = null;
    try { audio = (H.cfg.audioNode ? H.cfg.audioNode() : null) || H.tap || null; } catch (e) { audio = H.tap || null; }
    const got = s.attachMedia(surf.el, audio);
    if (!got) {
      H.why = 'attachMedia failed: ' + (s.lastError || 'unknown');
      log(H.why + ' — the guest would get no picture');
      H.session = null; H.role = null;
      return;
    }
    H.audioHow = audio ? (audio === H.tap ? 'interposer gain on ' + (audio.context.sampleRate | 0) + ' Hz' : 'page node') : null;
    log('hosting ' + game + ' as ' + code + ' via ' + transport()
        + '; capture = ' + surf.how + '; audio = ' + (H.audioHow || 'NOT AVAILABLE (nothing ever connected to a destination)'));
    await s.start();
  }

  // "Is there a game to stream?" answered by FRAMES, not by a start flag: a start
  // flag is set the instant Start is pressed, long before the core exists, and
  // capturing then would publish a black canvas.
  function hostReady() {
    let up = false;
    try { up = !!H.cfg.coreUp(); } catch (e) { up = false; }
    if (!up) return null;
    if (!H.coreUpAt) H.coreUpAt = performance.now();
    let live = false;
    try { live = !!H.cfg.live(); } catch (e) { live = false; }
    if (live) return 'frames';
    if (performance.now() - H.coreUpAt > NOFRAME_GRACE_MS) return 'core-up-no-frames';
    return null;
  }

  // ---- the public surface ----------------------------------------------------
  const NetplayHost = {
    // Wire up the ?np=<code>&game=<key> handoff. Returns nothing; everything
    // afterwards is read through remoteMask() and the test seam.
    arm(cfg) {
      H.cfg = cfg;
      // The test seam is a FUNCTION returning a fresh report, and every field in
      // it is the result of doing the thing — `sentP2` is the literal bytes the
      // page handed the core, not a session flag.
      if (cfg.seam) {
        global[cfg.seam] = () => ({
          supported: supported(),
          transport: transport(),
          role: H.role,
          state: H.session ? H.session.state : null,
          code: H.session ? H.session.code : null,
          game: H.game,
          capture: H.how,
          mirrorTicks: H.mirrorTicks,
          mirrorErr: H.mirrorErr,
          remotePad: (H.session && H.role === 'host') ? H.session.remotePad() : null,
          sentP1: H.sentP1,
          sentP2: H.sentP2,
          live: (function () { try { return !!cfg.live(); } catch (e) { return false; } })(),
          coreUp: (function () { try { return !!cfg.coreUp(); } catch (e) { return false; } })(),
          armReason: H.armReason,
          audio: H.audioHow || null,
          why: H.why,
          players: cfg.players == null ? null : cfg.players,
        });
      }
      const q = qs();
      const np = (q.get('np') || '').toUpperCase();
      const game = q.get('game') || '';
      if (!np && !game) return;                        // no handoff, nothing runs
      if (!supported()) { log('handoff ignored: this browser has no WebRTC'); return; }

      // The game is named by a STRING KEY, never by an index into a list. A
      // stale index is silent: CLAUDE.md records ROM_IDX=1 documented as PSO and
      // loading Sonic Adventure 2 Battle for months.
      let picked = null;
      if (game) {
        try { picked = cfg.selectGame(game); } catch (e) { picked = null; }
        if (picked) log('handed a session by the lobby: hosting ' + game + ' as ' + np);
        else log('handoff named an unknown game "' + game + '" — using the current selection');
      }
      if (!/^[A-HJ-NP-Z2-9]{5}$/.test(np)) return;

      // NEVER override a Start the capability layer is holding down: that button
      // being disabled is the page saying this device cannot run the emulator,
      // and clicking past it is the exact bug the gate exists to stop.
      try { cfg.pressStart(); } catch (e) { log('pressStart threw: ' + ((e && e.message) || e)); }

      // There is no boot event to hang this off and a ROM load can be long, so it
      // waits for FRAMES rather than assuming a duration.
      const iv = setInterval(() => {
        if (H.session) { clearInterval(iv); return; }
        const why = hostReady();
        if (!why) return;
        clearInterval(iv);
        H.armReason = why;
        if (why === 'core-up-no-frames') {
          log('arming the session with NO FRAME YET — the core is running but nothing has been drawn for '
              + (NOFRAME_GRACE_MS / 1000) + 's. Player 2\'s controller works regardless; the capture arm '
              + 'reports what the picture actually carries.');
        }
        startHost(np, picked || game || 'unknown');
      }, 250);
    },

    // What player 2 is holding right now, or null when nobody is connected. The
    // page decodes the bits — this file never does.
    remoteMask() {
      const s = H.session;
      if (!s || H.role !== 'host' || s.state !== 'connected') return null;
      return s.remotePad() | 0;
    },
    // The literal bytes the page handed the core, kept so a test can assert on
    // THOSE rather than on a UI state. Either argument may be omitted.
    report(p1, p2) {
      if (p1 !== undefined) H.sentP1 = p1;
      if (p2 !== undefined) H.sentP2 = p2;
    },
    // Call from the page's per-frame tick; no-ops unless the mirror arm won.
    pumpMirror,
    hosting() { return H.role === 'host'; },
    connected() { return H.connected; },
    session() { return H.session; },
    transport,
    supported,
    // The lobby lives on a separate, light page (the guest needs no core and no
    // ROM). This is where the page's "Play Online" button should send people.
    lobbyUrl(page, game) {
      const p = new URLSearchParams();
      if (game) p.set('game', game);
      if (transport() === 'local') p.set('net', 'local');
      const s = p.toString();
      return page + (s ? '?' + s : '');
    },
  };
  global.NetplayHost = NetplayHost;
})(typeof window !== 'undefined' ? window : globalThis);
