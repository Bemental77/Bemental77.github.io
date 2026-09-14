// lib/netplay-ui.js — THE PARTY. Players pair up and see each other BEFORE a
// game is loaded, then the page starts the emulator already knowing who is in.
//
// WHY BEFORE. Pairing after boot means one player sits watching a loaded game
// while the other is still typing a code, and on this site a disc load is over a
// gigabyte — a retry after a failed pairing would cost that download twice. The
// party is therefore formed first and the page is handed a live session.
//
// ONE COMPONENT FOR EVERY PAGE. gamecube, dreamcast, n64, ps1, snes, gba and
// genesis all get the same button and the same panel, because six hand-rolled
// lobbies would drift and only the one most recently touched would be correct.
// A page supplies its game id and what to do when the party is ready; nothing
// else about the page is assumed.
//
// ⚠ NO START BUTTON AND NO READY BUTTON. User, 2026-09-13: "There should be a
// button for the online party status, and should start when both are able to
// start, instead of an I'm ready button and dumb conditions to start the damn
// game." The panel used to end in a host-only Start that sent '__start__' and
// fired onReady — a click that could only ever be pressed once the room had
// already formed, i.e. a control whose only input was "yes, do the thing you
// already know to do". It is gone: EVERY console STARTS BY ITSELF the moment
// its own session reports 'connected' — host and guest alike call onReady on
// that event, once. This is safe to do without any condition here because
// lib/netplay.js's barrier never releases with fewer than two distinct seated
// peers (Lockstep._checkBarrier, `alone`), so a page that loads on 'connected'
// can never run a frame alone. The ONE control left is the party button, whose
// label IS the room's status.
//
// ⚠ THE GUEST DOES NOT WAIT FOR '__start__'. It used to: the host sent that
// sync message on 'connected' and the guest started on receipt. But sendSync
// writes to this._dc — the FIRST open DataChannel (lib/netplay.js _bindChannel)
// — so it only ever reached the first joiner. MEASURED 2026-09-13 with three
// gamecube.html pages: the third player sat at "waiting for host and player
// (you)" for 15 s after 'connected', so a 3-4 player room could never start.
// The host still sends it and a guest still honours it, purely as a fallback
// for a console running a cached copy of this file.
//
// ⚠ It renders NOTHING and shows no button when Netplay.supported() is false.
// A control that cannot work is worse than no control — the visitor taps it,
// nothing happens, and they conclude the site is broken.
'use strict';

(function (global) {
  const CSS = `
  .np-btn{position:fixed;right:14px;bottom:14px;z-index:2147482000;padding:12px 16px;min-height:44px;
    border-radius:10px;border:1px solid #3a5;background:#123;color:#8fd;font:600 14px/1 -apple-system,
    BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5);
    max-width:min(80vw,420px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .np-btn[data-live="1"]{border-color:#6c6;background:#152;color:#cfc}
  .np-wrap{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;
    background:rgba(0,0,0,.72);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .np-wrap.open{display:flex}
  .np-card{background:#15171a;color:#e8e8e8;border:1px solid #444;border-radius:14px;padding:22px;
    width:min(440px,92vw);box-shadow:0 12px 48px rgba(0,0,0,.6)}
  .np-card h3{margin:0 0 4px;font-size:19px;color:#fff}
  .np-sub{color:#9aa;margin:0 0 16px;font-size:13px}
  .np-row{display:flex;gap:10px;margin-bottom:10px}
  .np-row button{flex:1;min-height:44px;border-radius:9px;border:1px solid #555;background:#2a2d31;
    color:#eee;font-size:14px;cursor:pointer}
  .np-row button.on{background:#2b7cd3;border-color:#2b7cd3;color:#fff;font-weight:600}
  .np-code{font:700 30px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:5px;text-align:center;
    background:#0e1013;border:1px dashed #4a4;border-radius:10px;padding:14px;color:#9f9;margin:10px 0 6px;user-select:all}
  .np-copy{display:block;margin:0 auto 10px;padding:6px 14px;min-height:32px;border-radius:8px;border:1px solid #555;
    background:#2a2d31;color:#eee;font-size:12px;cursor:pointer}
  .np-in{width:100%;min-height:44px;box-sizing:border-box;font:700 20px/1 ui-monospace,Menlo,monospace;
    letter-spacing:4px;text-align:center;text-transform:uppercase;background:#0e1013;color:#eee;
    border:1px solid #555;border-radius:9px;padding:12px}
  .np-sel{width:100%;min-height:44px;box-sizing:border-box;background:#0e1013;color:#eee;border:1px solid #555;
    border-radius:9px;padding:10px 12px;font-size:15px;margin-bottom:10px}
  .np-card.np-inline{width:min(440px,94vw);margin:0 auto}
  .np-players{margin:14px 0 6px;border-top:1px solid #333;padding-top:12px}
  .np-p{display:flex;align-items:center;gap:9px;padding:5px 0}
  .np-dot{width:9px;height:9px;border-radius:50%;background:#666;flex:none}
  .np-dot.on{background:#5c5;box-shadow:0 0 8px #5c5}
  .np-dot.wait{background:#da3;animation:np-pulse 1s infinite}
  .np-dot.off{background:#c55}
  .np-st{margin-left:auto;color:#9aa;font-size:12px;white-space:nowrap}
  @keyframes np-pulse{50%{opacity:.35}}
  .np-msg{min-height:20px;font-size:13px;color:#9aa;margin-top:6px}
  .np-msg.bad{color:#f88}
  .np-act{display:flex;gap:10px;margin-top:14px}
  .np-act button{flex:1;min-height:44px;border-radius:9px;border:0;background:#2b7cd3;color:#fff;
    font-weight:600;font-size:15px;cursor:pointer}
  .np-act button.ghost{background:#333;color:#ccc}
  .np-act button[disabled]{opacity:.45;cursor:default}`;

  function el(tag, cls, txt) { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }

  // THE VOCABULARY. A player row's state is exactly one of these words, and a
  // page that pushes its own rows (setRows) uses the same ones, so one rig can
  // read every console's party the same way:
  //   open · connecting · loading N% · loaded · ready · playing · disconnected
  const LIT = /^(ready|loaded|playing)$/;
  const dotFor = (st) => (LIT.test(st) ? ' on' : st === 'disconnected' ? ' off' : ' wait');

  // ---- THE DEDICATED-PAGE OPTIONS -------------------------------------------
  // Six options, all optional and all off by default, so the floating-button
  // flow above is exactly what it was (tools/netplay_ui_test.mjs drives that flow
  // through .np-btn / .np-code / .np-in and must keep passing):
  //
  //   container  render the card INLINE into this element instead of behind a
  //              fixed button and a modal. On a page whose ONLY job is the lobby,
  //              a floating button that opens a dialog over an empty page puts a
  //              control in front of the content.
  //   games      [{value,label}] -> a picker. lib/netplay.js REFUSES a pairing
  //              whose game names differ (its _onSignal 'offer' branch), so the
  //              two sides must name the same disc; a lobby that cannot pick one
  //              can only ever pair on a hardcoded title.
  //   onHost     THE HANDOFF, and the reason this file needed extending at all.
  //              Without it the host's emulator is on THIS page and a session
  //              created here survives to be played. With it the emulator is on
  //              ANOTHER page, so creating a session here would be worse than
  //              useless: navigating away tears down the RTCPeerConnection, the
  //              DataChannel and the signalling socket, and a guest that had
  //              paired would be left holding a code that leads nowhere. So the
  //              host side deliberately does NOT connect — it mints the code,
  //              shows it, and hands (code, game) to the page to carry over.
  //              The GUEST side is unchanged and still pairs for real.
  //              ⚠ This mode keeps its Start/Join button and its row wording
  //              exactly as they were: lib/netplay-guest.js and the *_multiplayer
  //              rigs click `#lobbyCard .np-act button` as "Host — load the game"
  //              / "Join", and the auto-start below is for the OTHER mode only —
  //              the mode in which the emulator is on this page.
  //   code       A PRESET ROOM CODE, for the page that was HANDED one. The lobby
  //              (multiplayer.html) mints ONE code and sends every player to the
  //              emulator page with it in the URL; a panel that then minted its
  //              own would show the host a second code nobody else was told.
  //              With it, setMode(true) shows THIS code instead of minting, and
  //              the Join input is prefilled with it so a guest has nothing to
  //              type.
  //   join       Open on the Join side instead of Host. The lobby marks a joiner
  //              with &join=1, and two hosts under one code pair with nobody.
  //   autoconnect Connect the moment the panel is mounted — host: arm the
  //              session under `code`; guest: pair under it — instead of waiting
  //              for the floating button or the input's 'change'. The player
  //              already pressed everything on the lobby page; a second click
  //              here is a control that exists only to be found. It goes through
  //              the same connect() and its CONNECT-ONCE guard, so a later click
  //              cannot open a second session. ⚠ NOT on the onHost HOST side:
  //              that mode deliberately never connects here (see above), and
  //              autoconnect does not override it — the panel opens and stops.
  //
  // And the handle mount() returns carries the page's side of the party:
  //   setRows([{port, who, state}])  the page's per-port picture, in THE
  //              VOCABULARY above, drawn in place of this component's own
  //              (null restores it). Chosen over a polled state() callback
  //              because the page already knows the instant a state changes
  //              and a timer would only add a lag with nothing to fill it.
  //   say(text, bad)  the status line — the page's barrier sentence goes here.
  //   party()    {code, seated, ports, state, rows} — what the button says, as
  //              data, so a rig can assert the room's state without a button.
  const NetplayUI = {
    session: null,
    mount(opts) {
      opts = opts || {};
      const game = opts.game || 'game';
      const onReady = opts.onReady || function () {};
      const container = opts.container || null;
      const games = opts.games || null;
      const onHost = opts.onHost || null;
      // ⚠ onSession EXISTS BECAUSE onReady IS TOO LATE FOR A STREAM.
      // RTCPeerConnection.ontrack can fire BEFORE the DataChannel opens, and
      // 'connected' — which is what triggers onReady — is the channel's open.
      // A page that only subscribes to 'stream' in onReady can therefore miss
      // the one event that carries the picture and sit connected showing black.
      // dreamcast.html avoids this by attaching its handler before start(); this
      // hook is the same guarantee for a page that does not own the constructor.
      const onSession = opts.onSession || null;
      // The hand-off trio (see the block above). The code is normalised the way
      // connect() reads it, so a lower-case code out of a URL pairs with the
      // upper-case one the other side shows.
      const preset = opts.code ? String(opts.code).trim().toUpperCase() : '';
      const joinFirst = !!opts.join;
      const autoconnect = !!opts.autoconnect;
      // Refuse to render rather than present a dead control.
      if (!global.Netplay || !global.Netplay.supported()) return { supported: false };

      const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
      const btn = el('button', 'np-btn', 'Party');
      btn.type = 'button';
      const wrap = el('div', 'np-wrap');
      const card = el('div', 'np-card');
      wrap.appendChild(card);

      card.appendChild(el('h3', null, 'Party'));
      card.appendChild(el('p', 'np-sub', onHost
        ? 'Pair up first — only the host downloads a disc.'
        : 'Pair up first — the game loads and starts by itself once everyone is in.'));

      // The picker sits ABOVE Host/Join because it applies to both sides: the
      // host is choosing what to boot, the guest is naming what it expects.
      let gameSel = null;
      if (games && games.length) {
        gameSel = el('select', 'np-sel');
        games.forEach((g) => {
          const o = document.createElement('option');
          o.value = g.value; o.textContent = g.label || g.value;
          gameSel.appendChild(o);
        });
        gameSel.value = game;
        if (!gameSel.value && games[0]) gameSel.value = games[0].value;
        card.appendChild(gameSel);
      }
      const gameId = () => (gameSel ? gameSel.value : game);

      const modeRow = el('div', 'np-row');
      const bHost = el('button', 'on', 'Host a game');
      const bJoin = el('button', null, 'Join a game');
      modeRow.append(bHost, bJoin); card.appendChild(modeRow);

      const codeBox = el('div', 'np-code', '—');
      // A sibling of .np-code, not a child: rigs read .np-code's textContent as the code.
      const bCopy = el('button', 'np-copy', 'Copy code'); bCopy.type = 'button';
      const input = el('input', 'np-in'); input.placeholder = 'CODE'; input.maxLength = 6; input.style.display = 'none';
      if (preset) input.value = preset;   // a handed-over guest has nothing to type
      card.append(codeBox, bCopy, input);

      // ---- THE ROWS: one per port, who + state ----------------------------
      // ⚠ NEVER A NONCE. `who` is 'host' or 'player' (+ ' (you)'). dreamcast's
      // HUD once printed "P1 dc51b70458829649" — a peer's 16-hex stableNonce —
      // and nobody can act on that; a page pushing rows names peers the same way.
      const players = el('div', 'np-players');
      card.appendChild(players);
      let pageRows = null;                  // rows the page pushed; null = own picture
      // The onHost mode's two rows, worded exactly as they were (see the options block).
      let p2Text = 'Waiting for another player…', p2Dot = 'wait';
      const drawRows = (list) => {
        players.textContent = '';
        list.forEach((r) => {
          const row = el('div', 'np-p');
          row.append(el('span', 'np-dot' + (r.dot != null ? (r.dot ? ' ' + r.dot : '') : dotFor(r.state))),
                     el('span', null, r.who));
          if (r.state) row.appendChild(el('span', 'np-st', r.state));
          players.appendChild(row);
        });
      };

      const msg = el('div', 'np-msg', '');
      card.appendChild(msg);

      const act = el('div', 'np-act');
      const bGo = el('button', null, 'Start'); bGo.disabled = true;      // onHost mode only
      const bLeave = el('button', 'ghost', 'Leave'); bLeave.style.display = 'none';
      const bX = el('button', 'ghost', 'Close');
      // A Start that does nothing must not exist: outside onHost mode the room
      // starts itself, so the row is Leave (while there is a room to leave) + Close.
      if (onHost) act.append(bGo, bX); else act.append(bLeave, bX);
      card.appendChild(act);
      if (container) { card.classList.add('np-inline'); container.appendChild(card); }
      else document.body.append(btn, wrap);

      let isHost = true, session = null;
      let live = false;        // the session reports 'connected'
      let started = false;     // '__start__' has been sent (host) or received (guest)
      let gone = false;        // the peer left ('closed')
      const portsOf = () => (session && session.portCount) || 2;
      // This component's own picture of the room — what it can know without the
      // page: who is seated where and whether the link is up. The page's disc
      // states (loading/loaded/playing) arrive through setRows and replace it.
      // ⚠ FROM THE ROSTER, ONCE THERE IS ONE. The host seats every joiner in
      // order of admission and pushes the roster to all (lib/netplay.js
      // _onPeerUp); a picture that guessed "host at 0, me at 1" drew a THIRD
      // player in the second player's seat and counted 2/4 with three people in.
      const who = (p, local) => (p === 0 ? 'host' : 'player') + (local ? ' (you)' : '');
      const ownRows = () => {
        if (onHost) return [{ who: 'You — ready', dot: 'on' }, { who: p2Text, dot: p2Dot }];
        let seats = null;
        try { seats = session ? session.roomInfo().seats : null; } catch (e) {}
        if (seats && seats.some((s) => s.peer != null))
          return seats.map((s) => ({ port: s.port, who: who(s.port, s.local),
            state: s.peer == null ? 'open'
                 : s.local ? ((isHost || live) ? 'ready' : 'connecting')
                 : (s.dropped != null || gone) ? 'disconnected' : live ? 'ready' : 'connecting' }));
        // No roster yet. No session = no room: every seat is open, nobody is "you".
        // A guest still reaching for its host draws that seat open as well — nobody
        // has been found there, and 'connecting' counted as a second player.
        const you = !session ? 'open' : (isHost || live) ? 'ready' : 'connecting';
        const other = !session ? 'open' : live ? 'ready' : gone ? 'disconnected' : 'open';
        const rows = [];
        for (let p = 0, n = portsOf(); p < n; p++) {
          const local = !!session && (isHost ? p === 0 : p === 1);   // host seats itself at 0, the paired player at 1
          rows.push({ port: p, who: who(p, local), state: local ? you : (p <= 1 ? other : 'open') });
        }
        return rows;
      };
      const partyOf = (rows) => {
        const seated = rows.filter((r) => r.state && r.state !== 'open');
        let state = 'waiting';
        if (rows.some((r) => r.state === 'playing')) state = 'playing';
        else if (rows.some((r) => /^loading/.test(r.state || ''))) state = 'loading';
        // 'loaded' is a disc in with the gate not yet armed — the page's sentence
        // still waits on that seat, so the button does too; only 'ready' starts.
        else if (seated.length >= 2 && seated.every((r) => r.state === 'ready')) state = 'starting';
        return { code: session ? session.code : null, seated: seated.length, ports: rows.length, state, rows };
      };
      const render = () => {
        const rows = pageRows || ownRows();
        drawRows(rows);
        // THE BUTTON'S LABEL IS THE STATUS. No session → 'Party'; with one, the
        // code, the seats and the room's state, live.
        const p = partyOf(rows);
        btn.textContent = session ? 'Party · ' + p.code + ' · ' + p.seated + '/' + p.ports + ' · ' + p.state : 'Party';
        btn.dataset.live = live ? '1' : '';
        bLeave.style.display = (!onHost && session && !started) ? '' : 'none';
      };

      const setMode = (h) => {
        isHost = h;
        bHost.classList.toggle('on', h); bJoin.classList.toggle('on', !h);
        codeBox.style.display = h ? '' : 'none';
        bCopy.style.display = h ? '' : 'none';
        input.style.display = h ? 'none' : '';
        if (h) { codeBox.textContent = preset || Netplay.makeCode(5); }
        if (onHost) {
          // The host is not waiting for anybody HERE: the guest joins the
          // EMULATOR's session, which does not exist until a disc is loaded, and
          // lib/netplay.js's guest retries 'peer-unavailable' indefinitely — so a
          // guest may sit on the code for the whole download. Showing "waiting
          // for another player" on this side would claim a connection this page
          // never makes.
          bGo.textContent = h ? 'Host — load the game' : 'Join';
          bGo.disabled = false;
          p2Text = h
            ? 'Give out the code — Player 2 can join while the game loads'
            : 'Waiting for the host…';
        }
        render();
      };
      const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };

      bHost.onclick = () => setMode(true);
      bJoin.onclick = () => setMode(false);
      btn.onclick = () => { wrap.classList.add('open'); if (!session) setMode(!joinFirst); };
      bX.onclick = () => wrap.classList.remove('open');
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });
      bCopy.onclick = () => {
        const c = codeBox.textContent.trim();
        const fallback = () => say('Select the code and copy it yourself — the clipboard is not available here.');
        try { navigator.clipboard.writeText(c).then(() => say('Copied ' + c + '.'), fallback); } catch (e) { fallback(); }
      };

      const connect = async () => {
        // ⚠ CONNECT ONCE. THE SECOND SESSION ORPHANS THE FIRST, AND THE FIRST IS THE ONE THE
        // HOST PAIRED WITH. Opening the panel schedules connect() on a timer, and the
        // documented Join sequence (click the button, click Join, set the code, fire 'change')
        // calls connect() SYNCHRONOUSLY before that timer fires — so both ran and the second
        // one overwrote `session` with a brand-new Netplay.Session. MEASURED on gamecube.html
        // 2026-09-10: the host reported state "connected" with an open DataChannel to the
        // guest's nonce, while the guest's NetplayUI.session sat in "signalling" with dc=null
        // forever, and every ls* message in both directions went into the orphan. The room
        // looked half-connected and no barrier could ever release. `session` is the only
        // handle the page is given, so a connect that replaces it must not happen at all.
        if (session) return;
        const code = (isHost ? codeBox.textContent : input.value.trim().toUpperCase());
        if (!code || code.length < 4) return say('Enter the code the host gave you.', true);
        say(isHost
          ? (onHost ? 'Waiting for a player to join…'
                    : 'Waiting for another player — share the code ' + code + '. Starts by itself once two are in and loaded.')
          : 'Connecting…');
        session = NetplayUI.session = new Netplay.Session({
          game: gameId(), host: isHost, code,
          // Cross-device is the point; the same-browser transport is for tests.
          transport: opts.transport || 'peerjs',
        });
        render();
        if (onSession) { try { onSession(session, isHost ? 'host' : 'guest'); } catch (e) {} }
        // The own picture follows the roster (a seat taken; the roster landing on
        // a guest) and the loads; a page's pushed rows replace it regardless.
        session.on('room', render);
        session.on('lockstep', render);
        // FALLBACK ONLY (header): a guest starts on its own 'connected' below.
        session.on('sync', (m) => {
          if (m && m.payload === '__start__' && !isHost && !started) {
            started = true;
            wrap.classList.remove('open');
            onReady(session, 'guest');
            render();
          }
        });
        session.on('status', (e) => {
          if (e.state === 'connected') {
            live = true; gone = false;
            if (onHost) {
              p2Dot = 'on'; p2Text = isHost ? 'Player 2 — connected' : 'Host — connected';
              say('Paired. ' + (isHost ? 'Start when ready.' : 'You are Player 2.'));
              bGo.disabled = false;
              // In handoff mode the host's emulator is on another page and never
              // sends '__start__' — by the time a guest can reach it, it is already
              // running — so 'connected' IS the guest's cue to start watching.
              if (!isHost) onReady(session, 'guest');
            } else if (!started) {
              // THE AUTOMATIC START (header), on EVERY console. 'connected' is this
              // side's first open channel: on the host that is the first seated peer
              // — exactly when the old Start became clickable — so the host's load
              // fires on the first peer, never on room open; on a guest it is the
              // channel the host has just seated it on (lib/netplay.js _onPeerUp),
              // and the game is the one this panel was mounted with. onReady fires
              // ONCE per console; a later 'connected' here (a relay upgrade, a
              // replacement or third joiner) only has the host re-send the fallback.
              started = true;
              say('Paired — loading the game on every console.');
              wrap.classList.remove('open');
              if (isHost) session.sendSync('__start__');
              onReady(session, isHost ? 'host' : 'guest');
            } else if (isHost) session.sendSync('__start__');
          } else if (e.state === 'failed') {
            live = false;
            if (onHost) p2Dot = 'wait';
            say(session.lastError || 'Could not pair. Check the code and try again.', true);
          } else if (e.state === 'closed') {
            live = false; gone = true;
            if (onHost) { p2Dot = ''; p2Text = 'The other player left'; }
            say('Disconnected.', true);
          }
          render();
        });
        const ok = await session.start();
        if (!ok) say(session.lastError || 'Could not reach the matchmaking service.', true);
      };

      // Host: opening the panel arms the session so a guest can find it.
      bHost.addEventListener('click', () => {});
      if (!onHost) {
        btn.addEventListener('click', () => { if (!session) setTimeout(connect, 0); });
        input.addEventListener('change', () => { if (!session) connect(); });
      }

      // onHost mode's only button — HOST: nothing is connected here and nothing
      // should be — hand the code and the disc to the page, which carries both to
      // the emulator. GUEST: this is the Join button; pair for real, right here.
      bGo.onclick = () => {
        if (!onHost) return;
        if (isHost) {
          say('Loading the game — keep this code: ' + codeBox.textContent);
          return onHost(codeBox.textContent, gameId());
        }
        if (!session) connect();
      };
      // Leave, before the game has started: close the room and hand the panel
      // back clean. After start there is nothing to un-start — the page's core
      // is gated to THIS room — so the button is not offered (render()).
      bLeave.onclick = () => {
        if (!session || started) return;
        try { session.close(); } catch (e) {}
        session = NetplayUI.session = null; live = false; gone = false; pageRows = null;
        say('');
        wrap.classList.remove('open');
        setMode(!joinFirst);
      };

      setMode(!joinFirst);
      if (autoconnect) {
        // Opened so the player can see the room forming; the onHost HOST side is
        // the one mode that must not connect (see the options block).
        wrap.classList.add('open');
        if (!(onHost && isHost)) connect();
      }
      return {
        supported: true, button: btn, panel: wrap,
        open: () => btn.click(),
        get session() { return session; },
        get started() { return started; },
        // What the hand-off options resolved to, so a rig can read what was applied.
        code: preset || null, join: joinFirst, autoconnect: autoconnect,
        setRows(rows) {
          // ⚠ NO SESSION, NO ROWS. After Leave, gamecube.html's tick kept pushing
          // the closed room's rows; with no room there is nothing to picture.
          pageRows = (session && Array.isArray(rows) && rows.length)
            ? rows.map((r) => ({ port: r.port | 0, who: String(r.who || ''), state: String(r.state || '') }))
            : null;
          render();
        },
        say,
        // party(rows): classify the page's rows WITHOUT drawing them — a read.
        party: (rows) => partyOf((session && Array.isArray(rows) && rows.length) ? rows : (pageRows || ownRows())),
      };
    },
  };
  global.NetplayUI = NetplayUI;
})(typeof window !== 'undefined' ? window : globalThis);
