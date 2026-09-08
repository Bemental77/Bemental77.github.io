// lib/netplay-guest.js — PLAYER 2'S WHOLE MACHINE, minus the buttons.
//
// WHY THIS FILE EXISTS.
// dreamcast_multiplayer.html and gamecube_multiplayer.html are the same page
// twice: a lobby, a <video>, an input pump, a touch pad and a test seam, with
// about thirty lines of console-specific button layout in the middle. Five more
// consoles need that page again (ps1, snes, gba, genesis, n64). Written out five
// more times the copies drift and only the most recently touched one is
// correct — the identical argument lib/netplay-ui.js makes for the lobby.
//
// ⚠ IT DOES NOT TOUCH THE TWO PAGES THAT ALREADY SHIP. Their copies are measured
// and working; re-pointing them here would be a rewrite of proven code for
// tidiness, and the risk is all downside. This file is the shape they proved,
// extracted for the pages that do not have one yet.
//
// THE SPLIT. This file owns everything that is the same on every console: the
// shell markup and CSS, the lobby (lib/netplay-ui.js in `container` mode, with
// the HOST handed off to the emulator page rather than connecting here),
// receiving the stream and making it audible, the input pump, leaving, and the
// test seam. The PAGE owns what differs: its pad markup, its keymap and its
// packMask(). The mask is the WIRE FORMAT the host decodes, so it stays in the
// page next to a comment stating the layout — hiding it in here is how two sides
// silently drift apart.
//
// WHY THE GUEST IS A SEPARATE PAGE AT ALL. In this model exactly ONE browser
// runs an emulator. The host boots the ROM, captures its canvas and audio and
// streams both; the guest sends controller state back. So the guest needs NO
// core, NO ROM and NO WebAssembly — a <video> and a pad. The per-console test
// asserts that negative as hard as the positive: zero requests for the ROM.
'use strict';

(function (global) {
  const $ = (id) => document.getElementById(id);

  // The shell's CSS. Positions for the console's OWN buttons live in the page,
  // because a GameCube face cluster and a Genesis six-button row are not the
  // same shape and pretending otherwise produces a layout that fits neither.
  const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #e8e8e8;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overscroll-behavior: none; }
  a { color: #7cc; }
  #lobby { min-height: 100%; display: flex; flex-direction: column; align-items: center;
           justify-content: center; gap: 18px; padding: 24px 14px 40px; }
  #lobby h1 { margin: 0; font-size: 22px; font-weight: 700; }
  #lobby .lede { margin: 0; max-width: 470px; text-align: center; color: #9aa; font-size: 13.5px; }
  #lobbyCard { width: 100%; }
  #back { color: #789; font-size: 13px; text-decoration: none; }
  #play { position: fixed; inset: 0; display: none; background: #000; }
  #play.on { display: block; }
  /* ⚠ THE STREAM'S INTRINSIC RATIO IS NOT THE PICTURE'S RATIO. A console's
     backing store is often not its display aspect — SNES is 256x224 (8:7) and
     Genesis 320x224 (10:7), both shown as 4:3 — so object-fit:contain on the raw
     video would letterbox at the WRONG ratio and stretch every circle. The stage
     is pinned to the console's true display aspect and object-fit:fill inside it
     performs the correction, exactly as gamecube_multiplayer.html does for its
     own 640x528 source. */
  #stage { position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%; }
  #mpVideo { width: 100%; height: 100%; object-fit: fill; background: #000; display: block; }
  #hud { position: absolute; top: 0; left: 0; right: 0; display: flex; gap: 8px;
         align-items: center; padding: 8px 10px; z-index: 30;
         background: linear-gradient(180deg, rgba(0,0,0,.65), rgba(0,0,0,0));
         font-size: 12.5px; padding-top: max(8px, env(safe-area-inset-top)); }
  #hudMsg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cde; }
  #hud button { min-height: 34px; padding: 6px 11px; border-radius: 8px; border: 1px solid #556;
                background: rgba(20,24,30,.85); color: #dde; font-size: 12.5px; cursor: pointer; }
  #hud button.warn { border-color: #a55; color: #fbb; }
  #pad { position: absolute; inset: 0; z-index: 20; display: none;
         touch-action: none; -webkit-user-select: none; user-select: none; }
  #pad.on { display: block; }
  #disc { position: absolute; left: max(14px, env(safe-area-inset-left)); bottom: max(18px, env(safe-area-inset-bottom));
          width: 148px; height: 148px; border-radius: 50%; border: 2px solid rgba(255,255,255,.22);
          background: rgba(255,255,255,.07); }
  #nub { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px 0 0 -27px;
         border-radius: 50%; background: rgba(255,255,255,.30); pointer-events: none; }
  #face { position: absolute; right: max(14px, env(safe-area-inset-right)); bottom: max(18px, env(safe-area-inset-bottom));
          width: 178px; height: 178px; }
  .tb { position: absolute; border-radius: 50%; border: 2px solid rgba(255,255,255,.24);
        background: rgba(255,255,255,.10); color: #fff; font: 700 17px/1 sans-serif;
        display: flex; align-items: center; justify-content: center; }
  .tb.down { background: rgba(120,200,255,.55); }
  .tb.sq { border-radius: 12px; font-size: 13px; }
  #unsupported { max-width: 520px; margin: 12vh auto; padding: 0 20px; }
  #unsupported h1 { font-size: 20px; }
  .np-shared { max-width: 470px; margin: 0 auto; padding: 10px 12px; border-radius: 10px;
               border: 1px solid #653; background: rgba(90,70,30,.28); color: #ecb; font-size: 12.5px; }`;

  // ---- generic touch helpers -------------------------------------------------
  // Pointer events cover mouse, touch and pen; the touch pair is the fallback for
  // browsers without PointerEvent, and 'mouse' is what makes the pad clickable on
  // a desktop AND in a headless test.
  function holdButton(elm, down, up) {
    if (!elm) return;
    const d = (e) => { e.preventDefault(); down(); elm.classList.add('down'); };
    const u = (e) => { e.preventDefault(); up(); elm.classList.remove('down'); };
    elm.addEventListener('pointerdown', d); elm.addEventListener('pointerup', u);
    elm.addEventListener('pointercancel', u); elm.addEventListener('pointerleave', u);
    elm.addEventListener('touchstart', d, { passive: false });
    elm.addEventListener('touchend', u, { passive: false });
    elm.addEventListener('mousedown', d); elm.addEventListener('mouseup', u);
  }

  // An analog disc that reports a DIRECTION, not a quadrant — the threshold is
  // what makes diagonals reachable, and a console whose host wants only d-pad
  // bits can still quantise it on the way out.
  function wireDisc(disc, nub, onMove) {
    if (!disc) return;
    let id = null;
    const setFrom = (cx, cy) => {
      const r = disc.getBoundingClientRect(), rad = r.width / 2;
      let dx = (cx - (r.left + rad)) / rad, dy = (cy - (r.top + rad)) / rad;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; }
      onMove(dx, dy);
      if (nub) nub.style.transform = 'translate(' + (dx * rad * 0.55) + 'px,' + (dy * rad * 0.55) + 'px)';
    };
    const clear = () => { onMove(0, 0); if (nub) nub.style.transform = ''; id = null; };
    disc.addEventListener('pointerdown', (e) => {
      e.preventDefault(); id = e.pointerId;
      try { disc.setPointerCapture(id); } catch (_) {}
      setFrom(e.clientX, e.clientY);
    });
    disc.addEventListener('pointermove', (e) => { if (id === e.pointerId) setFrom(e.clientX, e.clientY); });
    ['pointerup', 'pointercancel'].forEach((t) => disc.addEventListener(t, (e) => { if (id === e.pointerId) clear(); }));
    disc.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.touches[0]; if (t) setFrom(t.clientX, t.clientY); }, { passive: false });
    disc.addEventListener('touchmove', (e) => { e.preventDefault(); const t = e.touches[0]; if (t) setFrom(t.clientX, t.clientY); }, { passive: false });
    disc.addEventListener('touchend', (e) => { e.preventDefault(); clear(); }, { passive: false });
  }

  // ⚠ THE LOBBY HAS A TEXT FIELD AND THE CODE ALPHABET OVERLAPS EVERY KEYMAP.
  // A window-level preventDefault would make the Join field silently refuse most
  // of what is typed into it — a/d/e/j/k/m/n/q/s/w are all buttons on one console
  // or another AND all legal code characters. The check has to be on this side
  // because lib/netplay-ui.js owns that input element.
  const typing = (e) => {
    const t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                   t.tagName === 'TEXTAREA' || t.isContentEditable);
  };

  // ---- the page --------------------------------------------------------------
  // cfg:
  //   seam        window function the test rig reads (e.g. '__snesmp')
  //   title/lede  lobby heading and one-line explanation
  //   games       [{value,label}] — MUST match the emulator page's list. The
  //               per-console test compares them and fails on drift, because
  //               lib/netplay.js REFUSES a pairing whose game names differ.
  //   defaultGame which one the picker opens on
  //   hostPage    where the HOST is sent, carrying ?np=<code>&game=<key>
  //   aspect      the console's true DISPLAY aspect, e.g. '4 / 3'
  //   padHtml     the console's own on-screen controls
  //   wirePad()   called once the shell is in the DOM; wires those controls
  //   mapped      Set of key names this console's keymap claims (for preventDefault)
  //   packMask()  PURE: the int32 handed to sendPad. The page's wire format.
  //   sharedNote  optional: shown in the lobby when this console's core cannot
  //               give the guest a SEPARATE controller. Saying so is the point —
  //               a page that implies two players when the core has one pad is
  //               the failure this whole exercise is meant to avoid.
  function mount(cfg) {
    const QS = new URLSearchParams(location.search);
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const shell = document.createElement('div');
    shell.innerHTML =
      '<div id="unsupported" hidden><h1>This browser cannot play online</h1>' +
        '<p id="unsupportedWhy" class="lede"></p>' +
        '<p><a href="' + cfg.hostPage + '">Play on your own instead →</a></p></div>' +
      '<div id="lobby" hidden><h1>' + cfg.title + '</h1>' +
        '<p class="lede">' + cfg.lede + '</p>' +
        (cfg.sharedNote ? '<p class="np-shared">' + cfg.sharedNote + '</p>' : '') +
        '<div id="lobbyCard"></div>' +
        '<a id="back" href="' + cfg.hostPage + '">← single player</a></div>' +
      '<div id="play"><div id="stage"><video id="mpVideo" playsinline autoplay></video></div>' +
        '<div id="hud"><span id="hudMsg">Connecting…</span>' +
          '<button type="button" id="btnSound" hidden>🔇 Sound on</button>' +
          '<button type="button" id="btnPad">🎮 Controls</button>' +
          '<button type="button" id="btnLeave" class="warn">Leave</button></div>' +
        '<div id="pad">' + (cfg.padHtml || '') + '</div></div>';
    while (shell.firstChild) document.body.appendChild(shell.firstChild);
    $('stage').style.aspectRatio = cfg.aspect || '4 / 3';

    // NEVER RENDER WHAT CANNOT WORK. A control the visitor can press that does
    // nothing reads as "the site is broken", which is worse than an explanation.
    if (!global.Netplay || !Netplay.supported()) {
      const missing = (typeof RTCPeerConnection !== 'function') ? 'WebRTC (RTCPeerConnection)'
                    : (typeof BroadcastChannel !== 'function') ? 'BroadcastChannel'
                    : 'the netplay library';
      $('unsupportedWhy').textContent =
        'Online play needs ' + missing + ', which this browser does not provide. '
        + 'Single player does not need it and still works.';
      $('unsupported').hidden = false;
      global[cfg.seam] = () => ({ supported: false, missing });
      return { supported: false };
    }
    $('lobby').hidden = false;
    if (cfg.wirePad) cfg.wirePad({ holdButton, wireDisc, $ });

    // Release is NEVER filtered: a key that went down while the field was focused
    // must still come up, or it stays held on the host's pad forever — a stuck
    // button on somebody else's machine.
    addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (cfg.mapped && cfg.mapped.has(String(e.key || '').toLowerCase())) e.preventDefault();
      if (cfg.onKeyDown) cfg.onKeyDown(e);
    });
    addEventListener('keyup', (e) => { if (cfg.onKeyUp) cfg.onKeyUp(e); });
    addEventListener('blur', () => { if (cfg.onBlur) cfg.onBlur(); });

    // BroadcastChannel pairs two tabs in ONE browser with no third party, which
    // is what the headless tests use; PeerJS's public broker is what pairs two
    // DEVICES. Same spelling as every emulator page's own transport check, so a
    // single ?net=local reaches both halves of a session.
    const transport = QS.get('net') === 'local' ? 'local' : 'peerjs';
    const DEFAULT_GAME = cfg.games.some((g) => g.value === QS.get('game'))
      ? QS.get('game') : cfg.defaultGame;

    const NET = { session: null, role: null, state: null, code: null, game: null,
                  mask: 0, sends: 0, tracks: null, leaving: false, saved: null };
    const say = (t) => { const h = $('hudMsg'); if (h) h.textContent = t; };
    const showPlay = (on) => {
      $('play').classList.toggle('on', !!on);
      $('lobby').hidden = !!on;
    };

    // ---- the received picture and sound --------------------------------------
    async function attachStream(ms) {
      const v = $('mpVideo');
      NET.tracks = ms.getTracks().map((t) => t.kind + ':' + t.readyState);
      // ⚠ ontrack FIRES ONCE PER TRACK and the host publishes video AND audio, so
      // this arrives twice for one MediaStream. dreamcast.html MEASURED what
      // re-assigning srcObject then does: it aborts the first play() and leaves
      // the element at readyState 0 with videoWidth 0 — a connected session
      // showing nothing. Attach once.
      if (v.srcObject === ms) return;
      v.srcObject = ms;
      showPlay(true);
      startPump();
      // ⚠ CLEAR THE STICKY MUTE FIRST. The catch below sets v.muted = true on an
      // autoplay refusal and nothing used to reset it, so ONE refusal muted every
      // LATER session — invisibly, because a muted element's play() always
      // resolves, so the catch never ran again to re-offer the sound. Found and
      // fixed in dreamcast.html; carried here deliberately.
      v.muted = false;
      $('btnSound').hidden = true;
      try { await v.play(); }
      catch (e) {
        // Autoplay policy can refuse an AUDIBLE element even after a click.
        // Losing the picture to keep the sound is the wrong trade — play muted
        // and offer the sound back explicitly.
        v.muted = true;
        try { await v.play(); } catch (_) {}
        $('btnSound').hidden = false;
        say('Connected — sound is off until you turn it on.');
      }
    }
    const unmute = () => {
      const v = $('mpVideo');
      if (!v.srcObject) return;
      v.muted = false; v.play().catch(() => {});
      $('btnSound').hidden = true;
    };
    $('btnSound').addEventListener('click', unmute);
    $('mpVideo').addEventListener('click', () => { if ($('mpVideo').muted) unmute(); });

    // ---- the input pump ------------------------------------------------------
    // ⚠ rAF DOES NOT FIRE IN A TAB THAT IS NOT BEING PRESENTED, and it is not a
    // matter of degree. dreamcast.html measured the consequence on the other side
    // of this same wire: with the other tab in front, not one input message
    // reached the emulator for a full second. A guest whose screen is about to
    // sleep would silently stop being a player, so a timer stands in whenever rAF
    // has been quiet and no-ops the rest of the time. In a truly backgrounded
    // browser the timer is itself clamped to about 1 Hz — a degraded remote
    // player, not a dead one.
    let pumpOn = false, lastRaf = 0;
    const now = () => (performance && performance.now ? performance.now() : Date.now());
    function step() {
      if (!NET.session || NET.role !== 'guest') return;
      const m = cfg.packMask() | 0;
      NET.mask = m; NET.sends++;
      NET.session.sendPad(m);
    }
    function startPump() {
      if (pumpOn) return;
      pumpOn = true; lastRaf = now();
      const loop = () => { lastRaf = now(); step(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      setInterval(() => { if (now() - lastRaf > 100) step(); }, 16);
    }

    function onStatus(e) {
      NET.state = e.state;
      if (e.state === 'signalling') say('Looking for the host…');
      else if (e.state === 'connected') { say(cfg.connectedMsg || 'Connected — you are Player 2.'); showPlay(true); startPump(); }
      else if (e.state === 'closed') {
        say(NET.leaving ? 'Left the session.' : 'The host left.');
        setTimeout(() => showPlay(false), 1200);
      } else if (e.state === 'failed') say('Could not connect' + (e.detail ? ': ' + e.detail : '.'));
    }

    $('btnLeave').addEventListener('click', () => {
      NET.leaving = true;
      try { NET.session && NET.session.close(); } catch (_) {}
      NET.session = null; NET.role = null;
      try { $('mpVideo').srcObject = null; } catch (_) {}
      showPlay(false);
      location.reload();       // back to a clean lobby; there is nothing to preserve
    });

    // ---- the lobby -----------------------------------------------------------
    const ui = NetplayUI.mount({
      game: DEFAULT_GAME,
      games: cfg.games,
      transport,
      container: $('lobbyCard'),
      // HOST: hand the party to the only page that has an emulator. The code was
      // already shown to the other player, so it must travel verbatim — and no
      // session is opened here, because navigating away would tear down the
      // RTCPeerConnection and leave a paired guest on a dead code.
      onHost(code, game) {
        const q = new URLSearchParams({ np: code, game });
        if (transport === 'local') q.set('net', 'local');
        location.href = cfg.hostPage + '?' + q.toString();
      },
      // Called the moment the session is constructed, BEFORE start(). The stream
      // handler HAS to be here: ontrack can beat the DataChannel's open, and
      // 'connected' (which is what fires onReady) IS that open — subscribing in
      // onReady can miss the only event that carries the picture.
      onSession(session, role) {
        NET.session = session; NET.role = role; NET.code = session.code; NET.game = session.game;
        session.on('stream', attachStream);
        session.on('status', onStatus);
        // Every player comes away with their own copy of the session's save; only
        // the host's browser ever holds the card that was played on.
        // lib/netplay.js namespaces these keys :mp so a co-op save can never
        // silently overwrite a single-player one.
        session.on('save', async (m) => {
          if (!m || !m.ok) { NET.saved = { ok: false, error: m && m.error }; return; }
          try {
            await Netplay.SaveStore.put(Netplay.Session.saveKey(session.game, 'state'), m.bytes, m.meta);
            NET.saved = { ok: true, bytes: m.bytes.length };
            say('Saved your copy of this session (' + m.bytes.length + ' bytes).');
          } catch (e) { NET.saved = { ok: false, error: e.message }; }
        });
      },
      onReady(session, role) {
        NET.session = session; NET.role = role; NET.code = session.code; NET.game = session.game;
        showPlay(true); startPump();
        say(cfg.connectedMsg || 'Connected — you are Player 2.');
        // If the track arrived before this fired, the stream is already on the
        // session; ask for it rather than waiting for an event that is now past.
        const ms = session.remoteStream && session.remoteStream();
        if (ms) attachStream(ms);
      },
    });
    if (!ui.supported) {
      $('lobby').hidden = true;
      $('unsupportedWhy').textContent = 'The lobby could not start on this browser.';
      $('unsupported').hidden = false;
    }

    // ---- on-screen pad visibility -------------------------------------------
    // Shown by default wherever fingers are the only input. On a desktop the
    // keyboard is already mapped, so the pad starts out of the way of the picture
    // and is one button away.
    const touchDevice = ('ontouchstart' in global) || (navigator.maxTouchPoints || 0) > 0;
    let padOn = QS.has('pad') ? QS.get('pad') !== '0' : touchDevice;
    const applyPad = () => {
      $('pad').classList.toggle('on', padOn);
      $('btnPad').textContent = padOn ? '🎮 Hide' : '🎮 Controls';
    };
    $('btnPad').addEventListener('click', () => { padOn = !padOn; applyPad(); });
    applyPad();

    // ---- the test seam -------------------------------------------------------
    // Everything here is the RESULT of doing the thing: `mask` is what was last
    // handed to sendPad, `tracks` is what actually arrived, and videoW/H stay 0
    // until a frame has really been decoded.
    global[cfg.seam] = () => {
      const v = $('mpVideo');
      return {
        supported: true,
        transport,
        games: cfg.games.map((g) => g.value),
        role: NET.role,
        state: NET.session ? NET.session.state : NET.state,
        code: NET.session ? NET.session.code : null,
        game: NET.session ? NET.session.game : null,
        mask: NET.mask, sends: NET.sends,
        tracks: NET.tracks, saved: NET.saved,
        padShown: $('pad').classList.contains('on'),
        playing: $('play').classList.contains('on'),
        videoW: v.videoWidth, videoH: v.videoHeight,
        muted: v.muted, paused: v.paused, readyState: v.readyState,
        // Stated out loud so a rig — and a reader — can tell a REAL second
        // controller from a shared one without reading the page's prose.
        players: cfg.players || 'p2',
      };
    };
    // packMask is PURE, so the WIRE FORMAT can be asserted with no session at all.
    global[cfg.seam + 'Mask'] = () => cfg.packMask() | 0;
    return { supported: true, showPlay, say, session: () => NET.session };
  }

  global.NetplayGuest = { mount, holdButton, wireDisc };
})(typeof window !== 'undefined' ? window : globalThis);
