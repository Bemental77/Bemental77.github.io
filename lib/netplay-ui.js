// lib/netplay-ui.js — the PRE-PARTY. Players pair up and see each other BEFORE a
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
// ⚠ It renders NOTHING and shows no button when Netplay.supported() is false.
// A control that cannot work is worse than no control — the visitor taps it,
// nothing happens, and they conclude the site is broken.
'use strict';

(function (global) {
  const CSS = `
  .np-btn{position:fixed;right:14px;bottom:14px;z-index:2147482000;padding:12px 16px;min-height:44px;
    border-radius:10px;border:1px solid #3a5;background:#123;color:#8fd;font:600 14px/1 -apple-system,
    BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5)}
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
    background:#0e1013;border:1px dashed #4a4;border-radius:10px;padding:14px;color:#9f9;margin:10px 0;user-select:all}
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
  @keyframes np-pulse{50%{opacity:.35}}
  .np-msg{min-height:20px;font-size:13px;color:#9aa;margin-top:6px}
  .np-msg.bad{color:#f88}
  .np-act{display:flex;gap:10px;margin-top:14px}
  .np-act button{flex:1;min-height:44px;border-radius:9px;border:0;background:#2b7cd3;color:#fff;
    font-weight:600;font-size:15px;cursor:pointer}
  .np-act button.ghost{background:#333;color:#ccc}
  .np-act button[disabled]{opacity:.45;cursor:default}`;

  function el(tag, cls, txt) { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }

  // ---- THE DEDICATED-PAGE OPTIONS -------------------------------------------
  // Three options, all optional and all off by default, so the floating-button
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
      // Refuse to render rather than present a dead control.
      if (!global.Netplay || !global.Netplay.supported()) return { supported: false };

      const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
      const btn = el('button', 'np-btn', '👥 Play Online');
      btn.type = 'button';
      const wrap = el('div', 'np-wrap');
      const card = el('div', 'np-card');
      wrap.appendChild(card);

      card.appendChild(el('h3', null, 'Play Online'));
      card.appendChild(el('p', 'np-sub', onHost
        ? 'Pair up first — only the host downloads a disc.'
        : 'Pair up first — the game loads once everyone is in.'));

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
      const input = el('input', 'np-in'); input.placeholder = 'CODE'; input.maxLength = 6; input.style.display = 'none';
      card.append(codeBox, input);

      const players = el('div', 'np-players');
      const mkP = (label) => { const r = el('div', 'np-p'); const d = el('span', 'np-dot'); const t = el('span', null, label); r.append(d, t); players.appendChild(r); return { row: r, dot: d, txt: t }; };
      const p1 = mkP('You — ready');
      const p2 = mkP('Waiting for another player…');
      p1.dot.classList.add('on');
      p2.dot.classList.add('wait');
      card.appendChild(players);

      const msg = el('div', 'np-msg', '');
      card.appendChild(msg);

      const act = el('div', 'np-act');
      const bGo = el('button', null, 'Start'); bGo.disabled = true;
      const bX = el('button', 'ghost', 'Close');
      act.append(bGo, bX); card.appendChild(act);
      if (container) { card.classList.add('np-inline'); container.appendChild(card); }
      else document.body.append(btn, wrap);

      let isHost = true, session = null;
      const setMode = (h) => {
        isHost = h;
        bHost.classList.toggle('on', h); bJoin.classList.toggle('on', !h);
        codeBox.style.display = h ? '' : 'none';
        input.style.display = h ? 'none' : '';
        if (h) { codeBox.textContent = Netplay.makeCode(5); }
        if (onHost) {
          // The host is not waiting for anybody HERE: the guest joins the
          // EMULATOR's session, which does not exist until a disc is loaded, and
          // lib/netplay.js's guest retries 'peer-unavailable' indefinitely — so a
          // guest may sit on the code for the whole download. Showing "waiting
          // for another player" on this side would claim a connection this page
          // never makes.
          bGo.textContent = h ? 'Host — load the game' : 'Join';
          bGo.disabled = false;
          p2.txt.textContent = h
            ? 'Give out the code — Player 2 can join while the game loads'
            : 'Waiting for the host…';
        }
      };
      const say = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('bad', !!bad); };

      bHost.onclick = () => setMode(true);
      bJoin.onclick = () => setMode(false);
      btn.onclick = () => { wrap.classList.add('open'); if (!session) setMode(true); };
      bX.onclick = () => wrap.classList.remove('open');
      wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.classList.remove('open'); });

      const connect = async () => {
        const code = (isHost ? codeBox.textContent : input.value.trim().toUpperCase());
        if (!code || code.length < 4) return say('Enter the code the host gave you.', true);
        say(isHost ? 'Waiting for a player to join…' : 'Connecting…');
        session = NetplayUI.session = new Netplay.Session({
          game: gameId(), host: isHost, code,
          // Cross-device is the point; the same-browser transport is for tests.
          transport: opts.transport || 'peerjs',
        });
        // The guest is taken along when the host starts; it has no Start of its own.
        if (onSession) { try { onSession(session, isHost ? 'host' : 'guest'); } catch (e) {} }
        session.on('sync', (m) => {
          if (m && m.payload === '__start__' && !isHost) {
            wrap.classList.remove('open');
            onReady(session, 'guest');
          }
        });
        session.on('status', (e) => {
          if (e.state === 'connected') {
            p2.dot.className = 'np-dot on';
            p2.txt.textContent = isHost ? 'Player 2 — connected' : 'Host — connected';
            say('Paired. ' + (isHost ? 'Start when ready.'
                                     : (onHost ? 'You are Player 2.' : 'Waiting for the host to start…')));
            bGo.disabled = onHost ? false : !isHost;   // only the host owns the emulator
            // In handoff mode the host's emulator is on another page and never
            // sends '__start__' — by the time a guest can reach it, it is already
            // running — so 'connected' IS the guest's cue to start watching.
            if (onHost && !isHost) onReady(session, 'guest');
            btn.dataset.live = '1';
            btn.textContent = '👥 Online — paired';
          } else if (e.state === 'failed') {
            p2.dot.className = 'np-dot wait';
            say(session.lastError || 'Could not pair. Check the code and try again.', true);
          } else if (e.state === 'closed') {
            p2.dot.className = 'np-dot';
            p2.txt.textContent = 'The other player left';
            btn.dataset.live = ''; btn.textContent = '👥 Play Online';
            say('Disconnected.', true);
          }
        });
        const started = await session.start();
        if (!started) say(session.lastError || 'Could not reach the matchmaking service.', true);
      };

      // Host: opening the panel arms the session so a guest can find it.
      bHost.addEventListener('click', () => {});
      if (!onHost) {
        btn.addEventListener('click', () => { if (!session) setTimeout(connect, 0); });
        input.addEventListener('change', () => { if (!session) connect(); });
      }

      bGo.onclick = () => {
        if (onHost) {
          // HOST: nothing is connected here and nothing should be — hand the code
          // and the disc to the page, which carries both to the emulator.
          // GUEST: this is the Join button; pair for real, right here.
          if (isHost) {
            say('Loading the game — keep this code: ' + codeBox.textContent);
            return onHost(codeBox.textContent, gameId());
          }
          if (!session) connect();
          return;
        }
        if (!session) return;
        wrap.classList.remove('open');
        // Tell the guest to come along. Only the host has a Start button — the
        // guest has no emulator to start, so a second Start would be a control
        // that does nothing.
        session.sendSync('__start__');
        onReady(session, 'host');
      };

      setMode(true);
      return {
        supported: true, button: btn, panel: wrap,
        open: () => btn.click(),
        get session() { return session; },
      };
    },
  };
  global.NetplayUI = NetplayUI;
})(typeof window !== 'undefined' ? window : globalThis);
