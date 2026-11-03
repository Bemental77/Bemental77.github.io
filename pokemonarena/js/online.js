// pokemonarena/js/online.js -- the page half of a networked battle: the setup panel (team, name, format, host or join), the lib/netplay.js session, the status bar,
// and the glue that hands the match controller to the battle page. The protocol itself is netmatch.js; the Arena-specific halves (team judging, building the
// controller, the engine fingerprint) are online_match.js. Both are DOM-free and tested in Node (tools/pokemonarena_netmatch_test.mjs); this file is what
// tools/pokemonarena_online_page_test.mjs drives in two real browser pages.
//
// WHAT lib/netplay.js DOES FOR US, AND WHAT IT DOES NOT. It pairs two browsers: a room code, the HOST'S approval of the joiner (a human clicks Allow, with a
// four-character confirmation code to read out), ICE / relay fallback, link health. It does not know what a Pokemon is. Our messages ride on its channel as
// type 'lsarena' (the 'ls' prefix is what its inbound router passes to _onRoomMsg; gba.html does the same with 'lsgbahostbye'), sent with session._send() and
// received by wrapping session._onRoomMsg. Every inbound path - the direct channel and the relay - ends in that router, so the relay carries a battle too.
//
// THE URL CONTRACT (battle.html?...)
//   online=1                    the setup panel with Host / Join choices
//   np=CODE&host=1 | &join=1    the lobby's hand-off (multiplayer.html): the role and room code are preset
//   team=<ARENA1 code>          preselects "the team in the address"            format=6v6|3v3   the host's default format
//   net=local                   BroadcastChannel pairing (two tabs of one browser; the test rigs)       arenaturn=<ms> / arenagrace=<ms>  (net=local only) a short turn limit / link grace; NOT 'turn', which lib/netplay.js reads as a TURN relay
// Test hook: window.__arenaOnline.

import { openStore } from './store.js';
import { readHubData, teamCodeFor } from './hub_data.js';
import { judgeTeamCode, randomTeamCode, buildNetController, engineFingerprint } from './online_match.js';
import { createNetMatch, cleanName, NAME_MAX } from './netmatch.js';
import { PINNED } from './rom.js';

export const GAME_KEY = 'Pokemon Arena';
export const ROOM_RE = /^[A-Za-z0-9]{4,8}$/;
const LS_NAME = 'arena.online.name';

/** -> null (not an online address) | { error } | { role: 'host' | 'guest' | null, room, transport, limits }. Never throws. */
export function parseOnlineQuery(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch (_e) { return null; }
  const np = q.get('np'), online = q.get('online');
  if (np === null && online !== '1') return null;
  let room = null;
  if (np !== null) { if (!ROOM_RE.test(np)) return { error: 'The room code in the address is not a valid room code.' }; room = np.toUpperCase(); }
  const host = q.get('host') === '1', join = q.get('join') === '1';
  if (host && join) return { error: 'The address asks to both host and join.' };
  const game = q.get('game');          // the lobby names the game; anything but ours means the address is for another page
  if (game !== null && game !== GAME_KEY) return { error: 'This address is for a different game.' };
  const transport = q.get('net') === 'local' ? 'local' : 'peerjs';
  const limits = {};
  if (transport === 'local') {                 // test seams: a short clock is only honoured for the same-browser transport
    const t = Number(q.get('arenaturn')); if (Number.isInteger(t) && t >= 200 && t <= 600000) { limits.turnMs = t; limits.previewMs = t; limits.capMs = Math.max(t * 3, 3000); limits.slackMs = Math.min(3000, Math.round(t / 4)); }
    const g = Number(q.get('arenagrace')); if (Number.isInteger(g) && g >= 500 && g <= 600000) limits.graceMs = g;
  }
  return { role: host ? 'host' : join ? 'guest' : null, room, transport, limits };
}

const fmtClock = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

function el(doc, tag, props, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) n.append(c);
  return n;
}

/**
 * cfg: { win, doc, pack, root (the element the panel goes in), bar (where the status bar is inserted before), query (parseOnlineQuery), teamParam (the ?team= code or null),
 *        formatParam, hooks: { mountScene(ctl, info), sceneState() -> { mode, pending }, showFatal({ title, message }), toHub() }, now }
 * -> { begin(), onResult(choice), leaveToHub(), state }
 */
export function createOnline(cfg) {
  const { win, doc, pack, root, query } = cfg;
  const hooks = cfg.hooks;
  // every use of the clock here is a DURATION (a turn's allowance, a link's grace), so it is the monotonic one: a wall-clock step (NTP, a changed timezone) must not time anyone out
  const now = cfg.now || (() => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now()));
  const state = { stage: 'setup', role: query.role, room: query.room, transport: query.transport, nm: null, session: null, mine: null, name: null, fmt: null, error: null, info: null, matches: 0 };
  let panel = null, bar = null, barTimer = 0, preMsgs = [], wired = false, closed = false;
  const Netplay = () => win.Netplay;

  /* ---------------------------------------------------------------------------------------------- the setup panel */
  const ui = {};
  function buildPanel() {
    panel = el(doc, 'section', { id: 'online', 'aria-labelledby': 'olTitle' });
    ui.title = el(doc, 'h2', { id: 'olTitle', text: 'Play a friend' });
    ui.lede = el(doc, 'p', { class: 'dim', text: 'Two players, each on their own device, one battle. Your teams stay in your browser; only your choices travel, straight to your friend.' });
    ui.roleRow = el(doc, 'div', { class: 'row', role: 'group', 'aria-label': 'Host or join' });
    ui.hostBtn = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olHost', 'aria-pressed': 'false', text: 'Host a game', onclick: () => setRole('host') });
    ui.joinBtn = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olJoin', 'aria-pressed': 'false', text: 'Join a game', onclick: () => setRole('guest') });
    ui.roleRow.append(ui.hostBtn, ui.joinBtn);
    ui.roomField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Room code' }));
    ui.room = el(doc, 'input', { id: 'olRoom', type: 'text', maxlength: '8', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'CODE' });
    ui.roomField.append(ui.room);
    ui.teamField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Your team' }));
    ui.team = el(doc, 'select', { id: 'olTeam', onchange: () => { ui.pasteField.hidden = ui.team.value !== 'paste'; refreshFormats(); } });
    ui.teamField.append(ui.team);
    ui.pasteField = el(doc, 'label', { class: 'field', hidden: true }, el(doc, 'span', { text: 'Team code' }));
    ui.paste = el(doc, 'textarea', { id: 'olPaste', rows: '3', spellcheck: 'false', placeholder: 'ARENA1.…' });
    ui.pasteField.append(ui.paste);
    ui.nameField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Your name' }));
    ui.name = el(doc, 'input', { id: 'olName', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'nickname', spellcheck: 'false' });
    ui.nameField.append(ui.name);
    ui.fmtField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Format' }));
    ui.fmt = el(doc, 'select', { id: 'olFmt' }, el(doc, 'option', { value: '3v3', text: '3 v 3 (pick 3 at the team preview)' }), el(doc, 'option', { value: '6v6', text: '6 v 6 (the whole team)' }));
    ui.fmtField.append(ui.fmt);
    ui.go = el(doc, 'button', { type: 'button', class: 'textbtn primary', id: 'olGo', text: 'Host', disabled: true, onclick: () => go() });      // enabled once the team list has loaded (begin)
    ui.cancel = el(doc, 'a', { class: 'textbtn', id: 'olBack', href: '/pokemonarena/', text: 'Back to the Arena' });
    ui.actions = el(doc, 'div', { class: 'row' }, ui.go, ui.cancel);
    ui.codeBox = el(doc, 'div', { id: 'olCode', class: 'code', hidden: true, 'aria-live': 'polite' });
    ui.invite = el(doc, 'div', { class: 'row', hidden: true },
      el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olCopyCode', text: 'Copy code', onclick: () => copy(state.room) }),
      el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olCopyLink', text: 'Copy invite link', onclick: () => copy(inviteLink()) }));
    ui.status = el(doc, 'p', { id: 'olStatus', class: 'status', role: 'status', 'aria-live': 'polite' });
    panel.append(ui.title, ui.lede, ui.roleRow, ui.roomField, ui.teamField, ui.pasteField, ui.nameField, ui.fmtField, ui.actions, ui.codeBox, ui.invite, ui.status);
    root.append(panel);
  }
  const say = (t, bad) => { ui.status.textContent = t || ''; ui.status.classList.toggle('bad', !!bad); };
  const inviteLink = () => win.location.origin + '/pokemonarena/battle.html?np=' + encodeURIComponent(state.room) + '&join=1' + (state.transport === 'local' ? '&net=local' : '');
  async function copy(text) {
    try { await win.navigator.clipboard.writeText(text); say('Copied.'); } catch (_e) { say('Select it and copy it yourself - the clipboard is not available here.'); }
  }
  function setRole(role) {
    if (state.stage !== 'setup') return;
    state.role = role;
    ui.hostBtn.setAttribute('aria-pressed', String(role === 'host')); ui.joinBtn.setAttribute('aria-pressed', String(role === 'guest'));
    ui.roomField.hidden = role !== 'guest'; ui.fmtField.hidden = role !== 'host';
    ui.go.textContent = role === 'host' ? 'Host' : 'Join';
    ui.go.disabled = false;
    if (role === 'guest' && state.room && !ui.room.value) ui.room.value = state.room;
  }
  function refreshFormats() {
    // a team of fewer than three cannot play 3v3
    const opt = ui.team.selectedOptions[0];
    const size = opt && opt.dataset.size ? Number(opt.dataset.size) : 6;
    ui.fmt.querySelector('option[value="3v3"]').disabled = size < 3;
    if (size < 3) ui.fmt.value = '6v6';
  }

  async function gatherTeams() {
    const out = [];
    if (cfg.teamParam) out.push({ key: 'url', label: 'The team in the address', code: cfg.teamParam, size: 6 });
    let name = '';
    try {
      const store = await openStore();
      try {
        const hub = await readHubData(store, pack);
        const profiles = hub.profiles.slice().sort((a, b) => (a.id === hub.activeId ? -1 : 0) - (b.id === hub.activeId ? -1 : 0));
        for (const p of profiles) for (const t of p.teams) if (t.legal) out.push({ key: 'saved:' + p.id + ':' + t.id, label: p.name + ' - ' + t.name + ' (' + t.size + ')', profileId: p.id, teamId: t.id, size: t.size });
        const act = profiles.find((p) => p.id === hub.activeId) || profiles[0];
        if (act) name = act.name;
      } finally { try { await store.close(); } catch (_e) { /* ignore */ } }
    } catch (_e) { /* no profiles in this browser: random and pasted teams still work */ }
    out.push({ key: 'random', label: 'A random team (6 Pokemon)', size: 6 });
    out.push({ key: 'paste', label: 'Paste a team code...', size: 6 });
    return { choices: out, name };
  }

  async function teamCodeOf(choice) {
    if (choice.key === 'url') return { ok: true, code: choice.code };
    if (choice.key === 'random') { const a = new Uint32Array(1); win.crypto.getRandomValues(a); try { return { ok: true, code: await randomTeamCode(pack, a[0]) }; } catch (e) { return { ok: false, message: 'A random team could not be made (' + (e && e.message ? e.message : e) + ').' }; } }
    if (choice.key === 'paste') { const t = ui.paste.value.replace(/\s+/g, ''); return t ? { ok: true, code: t } : { ok: false, message: 'Paste a team code first, or pick a saved team.' }; }
    let store = null;
    try { store = await openStore(); return await teamCodeFor(store, choice.profileId, choice.teamId); }
    catch (e) { return { ok: false, message: 'That team could not be read (' + (e && e.message ? e.message : e) + ').' }; }
    finally { if (store) { try { await store.close(); } catch (_e) { /* ignore */ } } }
  }

  /* ---------------------------------------------------------------------------------------------- connect */
  async function go() {
    if (state.stage !== 'setup' || !state.choices) return;
    if (!state.role) { say('Choose Host or Join first.', true); return; }
    if (!Netplay() || typeof Netplay().supported !== 'function' || !Netplay().supported()) { say('This browser cannot connect two players (it has no WebRTC or BroadcastChannel). Try a current Chrome, Firefox, Safari or Edge.', true); return; }
    const role = state.role;
    let room = state.room;
    if (role === 'guest') { room = ui.room.value.trim().toUpperCase(); if (!ROOM_RE.test(room)) { say('Enter the room code your friend gave you.', true); return; } }
    const name = cleanName(ui.name.value, role === 'host' ? 'Host' : 'Guest');
    try { win.localStorage.setItem(LS_NAME, name); } catch (_e) { /* private mode */ }
    ui.go.disabled = true; say('Checking your team...');
    const choice = { ...(state.choices.find((c) => c.key === ui.team.value) || state.choices[0]) };
    const tc = await teamCodeOf(choice);
    if (!tc.ok) { ui.go.disabled = false; say(tc.message, true); return; }
    const mine = await judgeTeamCode(tc.code, pack);
    if (!mine.ok) { ui.go.disabled = false; say(mine.message, true); return; }
    const fmt = role === 'host' ? ui.fmt.value : null;
    if (fmt === '3v3' && mine.size < 3) { ui.go.disabled = false; say('A 3v3 battle needs at least 3 Pokemon on your team.', true); return; }
    state.mine = mine; state.name = name; state.fmt = fmt;
    if (role === 'host') room = room || Netplay().makeCode(5, 'pokemonarena');
    state.room = room;
    lockSetup(role, room);
    startSession(role, room, tc.code);
  }
  function lockSetup(role, room) {
    state.stage = 'waiting';
    for (const n of [ui.hostBtn, ui.joinBtn, ui.room, ui.team, ui.paste, ui.name, ui.fmt, ui.go]) n.disabled = true;
    // The host's code is shown only once the room is open (openedRoom): a friend who is handed it earlier would knock on a door that is not there yet.
    say(role === 'host' ? 'Opening your room...' : 'Connecting to the room ' + room + '...');
    hooks.stage && hooks.stage('waiting');
  }

  async function startSession(role, room, teamCode) {
    const N = Netplay();
    const session = new N.Session({ game: role === 'host' ? GAME_KEY : null, host: role === 'host', code: room, portCount: 2, transport: state.transport });
    state.session = session;
    // our messages: the router passes every 'ls*' message to _onRoomMsg; a wrapper takes 'lsarena' and leaves the rest to the engine
    const orig = session._onRoomMsg;
    session._onRoomMsg = function (m, L) {
      if (m && m.t === 'lsarena') { if (state.nm) state.nm.receive(m); else if (preMsgs.length < 16) preMsgs.push(m); return true; }
      return orig.apply(this, arguments);
    };
    let everConnected = false;
    session.on('status', (e) => {
      if (closed) return;
      if (e.state === 'connected') {
        if (!everConnected) { everConnected = true; createMatch(role, room, teamCode); }
        else if (state.nm) state.nm.linkChanged(true);
      } else if (e.state === 'failed') {
        if (!everConnected) { state.stage = 'setup'; reopenSetup(); say(connectError(session.lastError || e.detail), true); }
        else if (state.nm) state.nm.linkChanged(false);
      } else if ((e.state === 'closed' || e.state === 'signalling') && everConnected && state.nm) state.nm.linkChanged(false);
    });
    session.on('peer-left', () => { if (state.nm && !closed) state.nm.linkChanged(false); });
    session.on('kicked', (e) => { if (!closed) fatal('You were removed from the room', (e && e.why) || 'The host removed you from the room.'); });
    let ok = false;
    try { ok = await session.start(); } catch (e) { session.lastError = String(e && e.message ? e.message : e); }
    if (!ok && !everConnected) { reopenSetup(); say(connectError(session.lastError), true); return; }
    if (ok && role === 'host' && !everConnected && !closed) openedRoom(room);
  }
  function openedRoom(room) {
    state.stage = 'open'; state.roomOpen = true;
    ui.codeBox.hidden = false; ui.codeBox.textContent = room; ui.invite.hidden = false;
    say('Your room is open. Give your friend the code ' + room + ' or the invite link, then allow them in when they ask.');
    hooks.stage && hooks.stage('open');
  }
  function connectError(why) {
    const w = String(why || '');
    if (/unavailable|peer-unavailable|not reach|broker|server/i.test(w)) return 'Could not reach that room. Check the code, and that your friend has opened it.' + (w ? ' (' + w.slice(0, 80) + ')' : '');
    if (/denied|declined/i.test(w)) return 'The host did not let you in.';
    if (/version/i.test(w)) return 'The other player is on a different version of the site. Reload and try again.';
    return (w ? w.slice(0, 160) : 'Could not connect.') + ' Check the code and try again.';
  }
  function reopenSetup() {
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    state.session = null; state.nm = null; state.stage = 'setup';
    for (const n of [ui.hostBtn, ui.joinBtn, ui.room, ui.team, ui.paste, ui.name, ui.fmt, ui.go]) n.disabled = false;
    ui.codeBox.hidden = true; ui.invite.hidden = true;
    root.querySelector('#online').hidden = false;
  }

  function createMatch(role, room, teamCode) {
    const mineCard = state.mine;
    let theirs = null;        // the judged opponent card, kept for makeController
    const nm = state.nm = createNetMatch({
      role, room, limits: query.limits, now,
      send: (msg) => { try { return !!state.session._send(msg); } catch (_e) { return false; } },
      mine: { rom: PINNED.sha256, fp: cfg.fingerprint, rs: mineCard.rs, name: state.name, team: teamCode, size: mineCard.size, fmt: state.fmt },
      judge: async (card) => { const j = await judgeTeamCode(card.team, pack); theirs = j; return j; },
      makeController: ({ seed, mySide, fmt, names }) => buildNetController({ pack, mySide, seed, fmt, names, mine: mineCard, theirs }),
      on: {
        phase: (p, info) => onPhase(p, info),
        controller: (ctl) => onController(ctl),
        notice: (t, kind) => flash(t, kind),
        end: (res) => onEnd(res),
        progress: () => renderBar(),
      },
    });
    state.stage = 'handshake';
    for (const m of preMsgs.splice(0)) nm.receive(m);
    nm.start();
    startBar();
    say('Connected. Checking the teams...');
    if (!wired) { wired = true; win.addEventListener('pagehide', onPageHide); }
    hooks.stage && hooks.stage('handshake');
  }
  function onPageHide(ev) { if (ev && ev.persisted) return; if (state.nm && !closed) { try { state.nm.leave('closed'); } catch (_e) { /* ignore */ } } }

  /* ---------------------------------------------------------------------------------------------- the match */
  function onController(ctl) {
    state.matches++;
    const nm = state.nm;
    const info = { mySide: nm.mySide, names: nm.names.slice(), myName: nm.myName, oppName: nm.oppName, seed: nm.seed, fmt: nm.fmt, mn: nm.mn, room: state.room, role: nm.role };
    state.info = info;
    state.stage = 'playing';
    panel.hidden = true;
    hooks.mountScene(ctl, info);
    renderBar();
  }
  function onPhase(p, info) {
    if (p === 'failed') fatal(titleFor(info), info && info.message ? info.message : 'The match was stopped.');
    else if (p === 'over') { state.stage = 'over'; renderBar(); }
    else if (p === 'seed' && state.matches > 0) { state.stage = 'handshake'; flash('Starting the rematch...', 'info'); }
    renderBar();
  }
  function titleFor(e) {
    switch (e && e.code) {
      case 'desync': case 'cheat': case 'peer-stopped': case 'illegal': case 'equivocation': return 'The match was stopped';
      case 'version': case 'rom': return 'The two games do not match';
      case 'team': case 'size': case 'rules': case 'format': return 'The teams cannot play each other';
      case 'left': return 'Your friend left';
      case 'timeout': return 'The connection timed out';
      default: return 'The match could not start';
    }
  }
  function onEnd(res) { renderBar(); }
  function fatal(title, message) {
    if (closed) return;
    state.stage = 'failed'; state.error = { title, message };
    stopBar();
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    panel.hidden = true;
    hooks.showFatal({ title, message });
    renderBar();
  }

  /** The result screen's buttons. */
  function onResult(choice) {
    if (choice === 'REMATCH') { if (state.nm) { const ok = state.nm.requestRematch(); if (!ok) flash(state.nm.status().oppGone ? 'Your friend has left.' : 'A rematch was already requested.', 'warn'); } renderBar(); return; }
    leaveToHub();
  }
  function leaveToHub() {
    if (state.nm && !closed) { try { state.nm.leave('left'); } catch (_e) { /* ignore */ } }
    closed = true; stopBar();
    setTimeout(() => { try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ } hooks.toHub(); }, 60);       // let the goodbye leave before the channel closes
  }

  /* ---------------------------------------------------------------------------------------------- the status bar */
  let flashText = '', flashKind = 'info', flashUntil = 0;
  const warned = { r: -1, w30: false, w10: false };
  function flash(text, kind) { flashText = text; flashKind = kind || 'info'; flashUntil = now() + 8000; renderBar(); }
  function startBar() {
    if (bar) return;
    // the message is the live region; the per-second clock is NOT (a screen reader would read it out every second), so it is hidden from them and the thresholds are announced instead (renderBar)
    bar = el(doc, 'div', { id: 'netbar', role: 'group', 'aria-label': 'Online battle status' }, el(doc, 'span', { id: 'nbWho' }), el(doc, 'span', { id: 'nbMsg', role: 'status', 'aria-live': 'polite' }), el(doc, 'span', { id: 'nbClock', 'aria-hidden': 'true' }));
    (cfg.bar && cfg.bar.parentNode ? cfg.bar.parentNode.insertBefore(bar, cfg.bar) : root.after(bar));
    barTimer = win.setInterval(tick, 250);
    renderBar();
  }
  function stopBar() { if (barTimer) { win.clearInterval(barTimer); barTimer = 0; } }
  function tick() {
    const nm = state.nm;
    if (!nm || closed) return;
    try { nm.tick(); } catch (e) { if (win.console) win.console.error(e); }
    // the screen can take a choice: the scene is in a choosing mode with a request open for me. That is when the other side's clock starts.
    const s = hooks.sceneState && hooks.sceneState();
    if (s && s.pending && ['action', 'moves', 'party', 'preview', 'confirm'].includes(s.mode)) nm.screenReady();
    const ms = nm.myClock();
    if (ms !== null && ms <= 0) nm.timeOutSelf();
    renderBar();
  }
  function renderBar() {
    if (!bar) return;
    const nm = state.nm; if (!nm) return;
    const st = nm.status();
    const who = st.opponent ? 'vs ' + st.opponent : '';
    let msg = '', kind = 'info';
    if (flashText && now() < flashUntil) { msg = flashText; kind = flashKind; }
    else if (st.phase === 'failed') { msg = (st.error && st.error.message) || 'The match was stopped.'; kind = 'bad'; }
    else if (st.phase === 'over') {
      const r = st.result;
      const base = !r ? '' : r.draw ? 'A draw.' : r.iWon ? (r.reason === 'result' ? 'You won!' : 'You win - ' + reasonText(r.reason, st.opponent)) : (r.reason === 'result' ? (st.opponent || 'Your friend') + ' won.' : 'You lost - ' + reasonText(r.reason, st.opponent));
      msg = st.oppGone ? base + ' ' + (st.opponent || 'Your friend') + ' has left.' : st.rematch.mine ? base + ' Rematch requested - waiting for ' + st.opponent + '.' : st.rematch.theirs ? base + ' ' + st.opponent + ' wants a rematch.' : base;
    } else if (st.phase !== 'playing') msg = st.phase === 'judging' ? 'Checking the teams...' : 'Connecting to the other player...';
    else if (st.link === 'down') msg = 'Connection lost - waiting for ' + (st.opponent || 'the other player') + ' to come back...', kind = 'warn';
    else if (st.waitingOn.includes(st.mySide)) msg = 'Your move.';
    else if (st.waitingOn.includes(st.mySide ^ 1)) msg = st.oppReady ? 'Waiting for ' + st.opponent + ' to choose...' : st.opponent + ' is still watching the last turn...';
    const clock = st.myClockMs !== null ? fmtClock(st.myClockMs) : '';
    if (warned.r !== st.round) { warned.r = st.round; warned.w30 = warned.w10 = false; }
    if (st.myClockMs !== null) {
      if (st.myClockMs <= 10000 && !warned.w10) { warned.w10 = warned.w30 = true; flash('10 seconds left to choose.', 'warn'); }
      else if (st.myClockMs <= 30000 && !warned.w30) { warned.w30 = true; flash('30 seconds left to choose.', 'warn'); }
    }
    const set = (id, v) => { const n = bar.querySelector(id); if (n.textContent !== v) n.textContent = v; };
    set('#nbWho', who); set('#nbMsg', msg); set('#nbClock', clock);
    bar.dataset.kind = kind; bar.dataset.low = st.myClockMs !== null && st.myClockMs < 15000 ? '1' : '';
    bar.dataset.phase = st.phase;
    state.last = st;
  }
  const reasonText = (why, opp) => ({ forfeit: 'a forfeit.', left: (opp || 'your friend') + ' left.', closed: (opp || 'your friend') + ' left.', timeout: 'out of time.', 'lost-link': 'the connection was lost.' }[why] || 'the match ended early.');

  /* ---------------------------------------------------------------------------------------------- start */
  async function begin() {
    buildPanel();
    const { choices, name } = await gatherTeams();
    state.choices = choices;
    for (const c of choices) ui.team.append(el(doc, 'option', { value: c.key, text: c.label, 'data-size': String(c.size || 6) }));
    let saved = ''; try { saved = win.localStorage.getItem(LS_NAME) || ''; } catch (_e) { /* ignore */ }
    ui.name.value = cleanName(saved || name, query.role === 'guest' ? 'Guest' : 'Host');
    ui.team.value = choices[0].key;
    ui.fmt.value = cfg.formatParam === '6v6' ? '6v6' : cfg.formatParam === '3v3' ? '3v3' : (choices[0].size >= 6 && choices[0].key !== 'random' && choices[0].key !== 'paste' ? '6v6' : '3v3');
    refreshFormats();
    if (query.room) { ui.room.value = query.room; state.room = query.room; }
    setRole(query.role || (query.room ? 'guest' : 'host'));
    if (query.role === null && !query.room) { ui.roleRow.hidden = false; } else ui.roleRow.hidden = true;
    ui.lede.textContent = query.role === 'guest' ? 'You are joining ' + (query.room || 'a room') + '. Pick your team and your name, then join.' : query.role === 'host' ? 'You are hosting. Pick your team and the format; you get a code to give your friend.' : ui.lede.textContent;
    hooks.stage && hooks.stage('setup');
    say('');
  }

  const api = { begin, onResult, leaveToHub, state, nm: () => state.nm, session: () => state.session, flash, renderBar };
  return api;
}
