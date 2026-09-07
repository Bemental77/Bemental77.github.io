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

  const NetplayUI = {
    session: null,
    mount(opts) {
      opts = opts || {};
      const game = opts.game || 'game';
      const onReady = opts.onReady || function () {};
      // Refuse to render rather than present a dead control.
      if (!global.Netplay || !global.Netplay.supported()) return { supported: false };

      const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
      const btn = el('button', 'np-btn', '👥 Play Online');
      btn.type = 'button';
      const wrap = el('div', 'np-wrap');
      const card = el('div', 'np-card');
      wrap.appendChild(card);

      card.appendChild(el('h3', null, 'Play Online'));
      card.appendChild(el('p', 'np-sub', 'Pair up first — the game loads once everyone is in.'));

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
      document.body.append(btn, wrap);

      let isHost = true, session = null;
      const setMode = (h) => {
        isHost = h;
        bHost.classList.toggle('on', h); bJoin.classList.toggle('on', !h);
        codeBox.style.display = h ? '' : 'none';
        input.style.display = h ? 'none' : '';
        if (h) { codeBox.textContent = Netplay.makeCode(5); }
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
          game, host: isHost, code,
          // Cross-device is the point; the same-browser transport is for tests.
          transport: opts.transport || 'peerjs',
        });
        // The guest is taken along when the host starts; it has no Start of its own.
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
            say('Paired. ' + (isHost ? 'Start when ready.' : 'Waiting for the host to start…'));
            bGo.disabled = !isHost;   // only the host owns the emulator
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
      btn.addEventListener('click', () => { if (!session) setTimeout(connect, 0); });
      input.addEventListener('change', () => { if (!session) connect(); });

      bGo.onclick = () => {
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
