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
//   auto=host&for=<sender id>&rq=<request id>&format=..   an ACCEPTED CHALLENGE (presence.js): the owner was in the hub or a CPU battle, pressed Accept (which left a ONE-TIME TOKEN in this tab's
//                               sessionStorage) and lands here; with that token the page picks the first saved team, opens a room, tells the challenger the room SEALED to the challenger's one-time key
//                               (`acc`: the room is never on the public board in the clear), and lets the first player in without a prompt. WITHOUT the token (a link from anywhere) auto/for/rq are ignored: the
//                               ordinary online panel shows, with a notice. Once the room is open the address becomes np=ROOM&host=1 and the token is gone, so a reload resumes like any host. For net=local also openchal=<ms>.
//   (a board page that joined a listed game has its address rewritten to np=ROOM&join=1 so a reload finds the room; when that join ends without a match the plain online=1 address is put back: boardAddress)
//   net=local test seams for the open games: openquick / openjoin / openchal (above) and openhold=<ms>, how long a seat is held for an admitted player who knocks again before looking whether they got a link.
//   (online=1, no np) the panel also shows OPEN GAMES (js/openlobby.js): players who are waiting, each with a Join button, a Find a battle button that joins the first one or opens one,
//                               and an "Open to anyone" switch for a host. An open game lets the first player who asks in WITHOUT the host pressing Allow: that is what open means.
//   net=local                   BroadcastChannel pairing (two tabs of one browser; the test rigs)       arenaturn=<ms> / arenagrace=<ms>  (net=local only) a short turn limit / link grace; NOT 'turn', which lib/netplay.js reads as a TURN relay
// Test hook: window.__arenaOnline.

import { openStore } from './store.js';
import { readHubData, teamCodeFor } from './hub_data.js';
import { judgeTeamCode, randomTeamCode, buildNetController, engineFingerprint } from './online_match.js';
import { createNetMatch, cleanName, NAME_MAX, PROTO } from './netmatch.js';
import { PINNED } from './rom.js';
import { isId } from './profile.js';
import { navigationType } from './battle_resume.js';
import { createOpenLobbies, createLocalBus, createMqttBus, ROOM_RE, MQTT_LIB } from './openlobby.js';
import { createChallenge, createAcceptor, takeAcceptToken, admission, canSeal, ACCEPT_MAX_AGE_MS, TIMING as PRESENCE_TIMING } from './presence.js';

export const GAME_KEY = 'Pokemon Arena';
export { ROOM_RE };
const LS_NAME = 'arena.online.name';
const resumeKey = (room, role) => 'arena.online:' + room + ':' + role;       // sessionStorage: per tab, gone when the tab closes, never sent anywhere
const RESUME_MAX_AGE_MS = 4 * 3600 * 1000;
// WHAT THE PAGE SAYS ABOUT ITSELF. Both are true of the code as it is (ONLINE.md, "What is public"): a battle needs BOTH teams in BOTH browsers (the engines are lockstep), so the team you play does go to
// the other player (directly, or over lib/netplay.js's relay when there is no direct path); and the board is a topic on the third-party brokers lib/netplay.js pairs through, read with mqtt.js from a CDN.
const LEDE = 'Two players, each on their own device, one battle. Your teams stay in your browser until a battle starts; then the team you play and your choices go to the other player, directly when your browsers can reach each other and through a public relay when they cannot.';
/** The Open games section's disclosure, built from what the page REALLY dials: the brokers Netplay.signalBrokers() returns (a deployment or a ?wsbroker= address can change the list) and the script openlobby.js loads. -> a sentence or two. */
export function boardPrivacyText(brokers, scriptUrl) {
  const host = (u) => { try { return new URL(String(u).split('|')[0]).hostname; } catch (_e) { return ''; } };
  const names = [...new Set((Array.isArray(brokers) ? brokers : []).map(host).filter(Boolean))];
  return 'The list comes from public servers. While this page is open it connects to ' + (names.length ? names.length + ' third-party MQTT brokers (' + names.join(', ') + ')' : 'third-party MQTT brokers') + ' and loads a script from ' + (host(scriptUrl) || 'a public CDN')
    + '; they can see your IP address, and your browser asks "who is open?" under a random id. '
    + 'If you open a game (Open to anyone, or Find a battle when nobody is waiting) or challenge someone, your trainer name and your online record (wins and losses, if you have one) go on those servers for anyone to read. A private game with a code is never listed.';
}

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
  let auto = null;
  if (q.get('auto') === 'host' && np === null) {          // an address that names a room (np=) is an ordinary host/join address: auto is never read from it (a reload of an accepted-challenge page is one)
    const f = q.get('for'), r = q.get('rq');
    if (!/^[0-9a-f]{16}$/.test(f || '') || !/^[0-9a-f]{16}$/.test(r || '')) return { error: 'The address starts a game for a challenger it does not name.' };
    auto = { for: f, rq: r };
  }
  const limits = {};
  if (transport === 'local') {                 // test seams: a short clock is only honoured for the same-browser transport
    const t = Number(q.get('arenaturn')); if (Number.isInteger(t) && t >= 200 && t <= 600000) { limits.turnMs = t; limits.previewMs = t; limits.capMs = Math.max(t * 3, 3000); limits.slackMs = Math.min(3000, Math.round(t / 4)); }
    const g = Number(q.get('arenagrace')); if (Number.isInteger(g) && g >= 500 && g <= 600000) limits.graceMs = g;
    const qm = Number(q.get('openquick')); if (q.get('openquick') !== null && Number.isInteger(qm) && qm >= 0 && qm <= 60000) limits.quickMs = qm;       // how long Find a battle looks before it opens a game of its own
    const cm = Number(q.get('openchal')); if (Number.isInteger(cm) && cm >= 300 && cm <= 120000) limits.chalMs = cm;                                                                    // how long a challenge may go unanswered
    const jm = Number(q.get('openjoin')); if (Number.isInteger(jm) && jm >= 500 && jm <= 120000) limits.joinMs = jm;                                          // how long a listed game may stay silent before the joiner gives up on it
    const hm = Number(q.get('openhold')); if (Number.isInteger(hm) && hm >= 300 && hm <= 120000) limits.holdMs = hm;                                          // how long an admitted player who knocks again may take to be let back in before the seat is given up on
  }
  return { role: auto || host ? 'host' : join ? 'guest' : null, room: auto ? null : room, transport, limits, auto };
}

/**
 * The address a RELOAD of this page must come back to: the room and the role (so the resume record is found), and NOTHING that starts a game. An accepted-challenge page arrives as
 * ?online=1&auto=host&for=..&rq=..; once its room is open all of that is dropped (auto, for, rq, ck as well as online / host / join), so a reload, Back or a restored tab is an ordinary host
 * (np=ROOM&host=1) and cannot open a second room or re-run the hand-off.
 */
export function canonicalAddress(href, role, room) {
  const u = new URL(href);
  for (const k of ['online', 'host', 'join', 'auto', 'for', 'rq', 'ck']) u.searchParams.delete(k);
  u.searchParams.set('np', room); u.searchParams.set(role === 'host' ? 'host' : 'join', '1');
  return u.pathname + u.search + u.hash;
}

/**
 * The address of the plain Play online page (the board), for a page that was opened as one and then joined a listed game: launch() rewrites the address to ?np=ROOM&join=1 so that a reload finds the
 * room, but when that join ends WITHOUT a match (Cancel, a game that never answered, one that was taken) the page is back at the board, and a reload of ?np=<that room>&join=1 would open the
 * join-by-code form with the dead room pre-filled and the board hidden. Everything that named a room, a role or a challenge is dropped and `online=1` is back; the rest (net, anim, team, format, #hash) is kept.
 */
export function boardAddress(href) {
  const u = new URL(href);
  for (const k of ['np', 'host', 'join', 'rq', 'for', 'ck', 'auto']) u.searchParams.delete(k);
  u.searchParams.set('online', '1');
  return u.pathname + u.search + u.hash;
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
  const { win, doc, pack, root } = cfg;
  const hooks = cfg.hooks;
  // AN ADDRESS DOES NOT START A GAME. An accepted challenge (query.auto) is hosted only if this tab holds the one-time token presence.js wrote when the owner pressed Accept; it is taken (and gone) here, once.
  // Any other way of arriving at ?online=1&auto=host&for=..&rq=.. (a link from anywhere, an old history entry, a reload before the room opened) is the ordinary online panel with a one-line notice.
  let query = cfg.query, acceptTok = null, autoNotice = '';
  if (query.auto) {
    let ss = null; try { ss = win.sessionStorage; } catch (_e) { ss = null; }
    acceptTok = takeAcceptToken(ss, query.auto, Date.now(), ACCEPT_MAX_AGE_MS);        // wall clock: the token was written by the PREVIOUS page, and a monotonic clock does not span a page load
    if (!acceptTok) { query = { ...query, role: null, room: null, auto: null }; autoNotice = 'That address tried to open a game for you without you pressing Accept, so it was ignored. Host a game, or pick one below.'; }
  }
  // every use of the clock here is a DURATION (a turn's allowance, a link's grace), so it is the monotonic one: a wall-clock step (NTP, a changed timezone) must not time anyone out
  const now = cfg.now || (() => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now()));
  const state = { stage: 'setup', role: query.role, room: query.room, transport: query.transport, nm: null, session: null, mine: null, name: null, fmt: null, error: null, info: null, matches: 0, open: false, quick: false, listed: null, openWanted: false, admitted: false, admittedId: null, defecting: false, invite: null, profileId: null, rec: null };
  // quickCtx: what Find a battle was launched with, to open the same game again if a game it left its own for turns out not to be there. openText / openLead: what the host of an open game was last told.
  let panel = null, bar = null, barTimer = 0, preMsgs = [], wired = false, closed = false, reconnecting = false, lobbies = null, joinTimer = 0, relisting = false, asking = null, acceptor = null, quickCtx = null, openText = '', openLead = '';
  const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));
  const Netplay = () => win.Netplay;
  // ONE WAY IN AT A TIME. Host, Join, a game from the list, Challenge, Find a battle and the accepted-challenge start all read the team (IndexedDB, the judge) BEFORE they open anything, and each
  // checked "the page is still at the setup form" only BEFORE that wait. A second press in the wait (a double tap, a held Enter, Join while Find a battle is looking) passed the same check and
  // started a second Session on top of the first, which was then leaked. `busy` is set synchronously on the first press and released when the function ends by any road (a return, a refusal, a throw).
  let busy = false;
  const exclusive = (fn) => async function (...args) {
    if (busy) return undefined;
    busy = true;
    try { return await fn.apply(this, args); } finally { busy = false; }
  };

  /* ---------------------------------------------------------------------------------------------- a record to come back to
   * A RELOAD (or a restored tab) must not lose the battle. After every change the match's snapshot (netmatch.js: the seed, every choice taken, the round, the committed choice, the
   * messages sent) is kept in sessionStorage with both team codes. A page that is RELOADED (not opened afresh) rebuilds the battle from it, replays it silently, and re-syncs with the
   * other player through the same room code; the host admits the same player again without a prompt (lib/netplay.js remembers the seat), a returning host is asked once. */
  const sstore = () => { try { return win.sessionStorage; } catch (_e) { return null; } };
  function readRecord() {
    const ss = sstore();
    if (!ss || !query.room || !query.role) return null;
    let rec = null;
    try { rec = JSON.parse(ss.getItem(resumeKey(query.room, query.role)) || 'null'); } catch (_e) { return null; }
    const ok = rec && typeof rec === 'object' && rec.v === PROTO && rec.room === query.room && rec.role === query.role && typeof rec.myTeam === 'string' && typeof rec.oppTeam === 'string'
      && rec.myTeam.length <= 1100 && rec.oppTeam.length <= 1100 && typeof rec.myName === 'string' && Number.isFinite(rec.at) && Date.now() - rec.at <= RESUME_MAX_AGE_MS && rec.at <= Date.now() + 60000;
    return ok ? rec : null;
  }
  function clearRecord() { try { const ss = sstore(); if (ss && state.room && state.role) ss.removeItem(resumeKey(state.room, state.role)); } catch (_e) { /* ignore */ } }
  function persist() {
    const nm = state.nm, ss = sstore();
    if (!nm || !ss || closed || !state.myTeamCode || !state.oppTeamCode) return;
    const snap = nm.snapshot();
    if (!snap) return;
    // profileId: the profile whose team this player chose, so the battle lands in THAT career after a reload (battle_boot's recordCareer would otherwise search for the team code, active profile first,
    // and could pick a clone of it in another profile, or fall back to the active one)
    try { ss.setItem(resumeKey(state.room, state.role), JSON.stringify({ ...snap, myTeam: state.myTeamCode, oppTeam: state.oppTeamCode, myName: state.name, profileId: state.profileId || null, at: Date.now() })); } catch (_e) { /* storage full or blocked: this match simply cannot be resumed */ }
  }
  // the address a reload must come back to: the room and the role, so that the record above can be found (a host who started from ?online=1 had neither)
  function canonicalizeUrl(role, room) {
    try { win.history.replaceState(null, '', canonicalAddress(win.location.href, role, room)); }
    catch (_e) { /* the address stays as it was; a reload just starts a new setup */ }
  }

  /* ---------------------------------------------------------------------------------------------- the setup panel */
  const ui = {};
  function buildPanel() {
    panel = el(doc, 'section', { id: 'online', 'aria-labelledby': 'olTitle' });
    ui.title = el(doc, 'h2', { id: 'olTitle', text: 'Play a friend' });
    ui.lede = el(doc, 'p', { class: 'dim', text: LEDE });
    ui.roleRow = el(doc, 'div', { class: 'row', role: 'group', 'aria-label': 'Host or join' });
    ui.hostBtn = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olHost', 'aria-pressed': 'false', text: 'Host a game', onclick: () => setRole('host') });
    ui.joinBtn = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olJoin', 'aria-pressed': 'false', text: 'Join a game', onclick: () => setRole('guest') });
    ui.roleRow.append(ui.hostBtn, ui.joinBtn);
    ui.roomField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Room code' }));
    ui.room = el(doc, 'input', { id: 'olRoom', type: 'text', maxlength: '8', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'CODE' });
    ui.roomField.append(ui.room);
    ui.teamField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Your team' }));
    ui.team = el(doc, 'select', { id: 'olTeam', onchange: () => { ui.pasteField.hidden = ui.team.value !== 'paste'; refreshFormats(); nameFollowsTeam(); } });
    ui.teamField.append(ui.team);
    ui.pasteField = el(doc, 'label', { class: 'field', hidden: true }, el(doc, 'span', { text: 'Team code' }));
    ui.paste = el(doc, 'textarea', { id: 'olPaste', rows: '3', spellcheck: 'false', placeholder: 'ARENA1.…' });
    ui.pasteField.append(ui.paste);
    ui.nameField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Your name' }));
    ui.name = el(doc, 'input', { id: 'olName', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'nickname', spellcheck: 'false', oninput: () => { nameTouched = true; } });
    ui.nameField.append(ui.name);
    ui.fmtField = el(doc, 'label', { class: 'field' }, el(doc, 'span', { text: 'Format' }));
    ui.fmt = el(doc, 'select', { id: 'olFmt' }, el(doc, 'option', { value: '3v3', text: '3 v 3 (pick 3 at the team preview)' }), el(doc, 'option', { value: '6v6', text: '6 v 6 (the whole team; you choose who leads)' }));
    ui.fmtField.append(ui.fmt);
    ui.pub = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olPublic', 'aria-pressed': 'false', text: 'Open to anyone: off', onclick: () => setOpenWanted(!state.openWanted) });
    ui.pubNote = el(doc, 'p', { class: 'dim small', id: 'olPublicNote' });
    ui.pubBox = el(doc, 'div', { id: 'olPublicBox', hidden: true }, el(doc, 'div', { class: 'row' }, ui.pub), ui.pubNote);
    ui.quick = el(doc, 'button', { type: 'button', class: 'textbtn primary', id: 'olQuick', text: 'Find a battle', disabled: true, onclick: () => quick() });
    ui.openNote = el(doc, 'p', { class: 'dim', id: 'olOpenNote', role: 'status', 'aria-live': 'polite' });
    ui.openList = el(doc, 'ul', { id: 'olOpenList', class: 'openlist' });
    // what this part of the page does to the visitor, in words, where they will read it (a tooltip is not disclosure): it is on screen whenever the board is
    ui.openPrivacy = el(doc, 'p', { class: 'dim small', id: 'olOpenPrivacy', text: boardPrivacyText((() => { try { const N = Netplay(); return N && typeof N.signalBrokers === 'function' ? N.signalBrokers() : []; } catch (_e) { return []; } })(), MQTT_LIB) });
    ui.openBox = el(doc, 'section', { id: 'olOpen', 'aria-labelledby': 'olOpenTitle', hidden: true }, el(doc, 'h3', { id: 'olOpenTitle', text: 'Open games' }), ui.openPrivacy, ui.openNote, ui.openList, el(doc, 'div', { class: 'row' }, ui.quick));
    ui.go = el(doc, 'button', { type: 'button', class: 'textbtn primary', id: 'olGo', text: 'Host', disabled: true, onclick: () => go() });      // enabled once the team list has loaded (begin)
    ui.cancel = el(doc, 'a', { class: 'textbtn', id: 'olBack', href: '/pokemonarena/', text: 'Back to the Arena' });
    ui.cancelAsk = el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olCancelAsk', text: 'Cancel', hidden: true, onclick: () => cancelAsk() });
    ui.actions = el(doc, 'div', { class: 'row' }, ui.go, ui.cancelAsk, ui.cancel);
    ui.codeBox = el(doc, 'div', { id: 'olCode', class: 'code', hidden: true, 'aria-live': 'polite' });
    ui.invite = el(doc, 'div', { class: 'row', hidden: true },
      el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olCopyCode', text: 'Copy code', onclick: () => copy(state.room) }),
      el(doc, 'button', { type: 'button', class: 'textbtn', id: 'olCopyLink', text: 'Copy invite link', onclick: () => copy(inviteLink()) }));
    ui.status = el(doc, 'p', { id: 'olStatus', class: 'status', role: 'status', 'aria-live': 'polite' });
    panel.append(ui.title, ui.lede, ui.teamField, ui.pasteField, ui.nameField, ui.openBox, ui.roleRow, ui.roomField, ui.fmtField, ui.pubBox, ui.actions, ui.codeBox, ui.invite, ui.status);
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
    syncSetupUi();
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

  // THE NAME IS THE TRAINER'S: picking a saved team fills in the name of the profile that owns it, unless the player has typed a name of their own on this page
  let nameTouched = false;
  function nameFollowsTeam() {
    if (nameTouched || !state.choices) return;
    const c = state.choices.find((x) => x.key === ui.team.value);
    if (c && c.trainer) ui.name.value = cleanName(c.trainer, ui.name.value || 'Player');
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
        for (const p of profiles) for (const t of p.teams) if (t.legal) out.push({ key: 'saved:' + p.id + ':' + t.id, label: p.name + ' - ' + t.name + ' (' + t.size + ')', profileId: p.id, teamId: t.id, size: t.size, trainer: p.name });
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
    // a SAVED team is the only choice that needs the store, and the only one that has a profile to take a record from: one open serves both
    let store = null;
    try {
      store = await openStore();
      const r = await teamCodeFor(store, choice.profileId, choice.teamId);
      return r.ok ? { ...r, rec: await onlineRecOf(store, choice.profileId) } : r;
    }
    catch (e) { return { ok: false, message: 'That team could not be read (' + (e && e.message ? e.message : e) + ').' }; }
    finally { if (store) { try { await store.close(); } catch (_e) { /* ignore */ } } }
  }

  /* ---------------------------------------------------------------------------------------------- connect */
  const supportedHere = () => !!(Netplay() && typeof Netplay().supported === 'function' && Netplay().supported());
  const UNSUPPORTED = 'This browser cannot connect two players (it has no WebRTC or BroadcastChannel). Try a current Chrome, Firefox, Safari or Edge.';
  const NO_SEAL = 'This browser cannot challenge a player in private (it has no WebCrypto, which keeps the room code off the public list), so challenging is not available here. Join an open game instead, or host one and give your friend the code.';
  /** The part every way in shares (Host, Join, a game from the list, Find a battle): the name, and the team read and judged. -> { mine, tc, name, release } | null (the reason is on the screen) */
  async function prepare(role) {
    const name = cleanName(ui.name.value, role === 'host' ? 'Host' : role === 'guest' ? 'Guest' : 'Player');
    // only a name the player TYPED is remembered for the next visit. The field also fills itself in from the team's owner (nameFollowsTeam) and from the profile (setupForm); remembering THAT made the next
    // visit start with the last team's owner under a different team's name.
    if (nameTouched) { try { win.localStorage.setItem(LS_NAME, name); } catch (_e) { /* private mode */ } }
    ui.go.disabled = true; ui.quick.disabled = true; say('Checking your team...');
    const release = () => { ui.go.disabled = false; ui.quick.disabled = false; };
    const choice = { ...(state.choices.find((c) => c.key === ui.team.value) || state.choices[0]) };
    const tc = await teamCodeOf(choice);
    if (!tc.ok) { release(); say(tc.message, true); return null; }
    const mine = await judgeTeamCode(tc.code, pack);
    if (!mine.ok) { release(); say(mine.message, true); return null; }
    // THE PROFILE: the one that owns the chosen SAVED team. A random, pasted or address team has no owner here (the career write finds the profile itself, the active one by default), so it carries no
    // record: nothing of any profile is published beside a name for a team that is not one's own, and the store is not opened for it at all
    return { mine, tc, name, release, profileId: choice.profileId || null, rec: tc.rec || null };
  }
  /** The online record [wins, losses] of the profile that owns the saved team the player chose (read from the store teamCodeOf has open), or null when there is none or no online battle yet. */
  async function onlineRecOf(store, profileId) {
    try {
      const loaded = await store.loadProfile(profileId).catch(() => null);
      const o = loaded && loaded.ok && loaded.profile.stats && loaded.profile.stats.byCpu ? loaded.profile.stats.byCpu.online : null;
      if (!o || !Number.isInteger(o.w) || !Number.isInteger(o.l) || !Number.isInteger(o.f)) return null;
      const w = Math.min(999999, o.w), l = Math.min(999999, o.l + o.f);
      return w + l > 0 ? [w, l] : null;
    } catch (_e) { return null; }
  }
  /** Why MY team cannot play this listed game, in words (null = it can). Checked BEFORE connecting: the handshake would refuse it by name, but only after a connection. */
  function whyNot(g, mine) {
    if (g.rs !== mine.rs) return 'That game is played under different rules than your team. Pick a team that matches, or another game.';
    if (g.fmt === '3v3' && mine.size < 3) return 'That game is 3 v 3 and your team has fewer than 3 Pokemon.';
    return null;
  }
  const go = exclusive(async function go() {
    if (state.stage !== 'setup' || !state.choices) return;
    if (!state.role) { say('Choose Host or Join first.', true); return; }
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    const role = state.role;
    let room = state.room;
    if (role === 'guest') { room = ui.room.value.trim().toUpperCase(); if (!ROOM_RE.test(room)) { say('Enter the room code your friend gave you.', true); return; } }
    const p = await prepare(role);
    if (!p) return;
    const fmt = role === 'host' ? ui.fmt.value : null;
    if (fmt === '3v3' && p.mine.size < 3) { p.release(); say('A 3v3 battle needs at least 3 Pokemon on your team.', true); return; }
    launch({ role, room, p, fmt, open: role === 'host' && state.openWanted, quick: false, listed: null });
  });
  /** Everything is decided: open the session. open = this host's game is listed; quick = it was opened by Find a battle; listed = the board entry a guest is joining. */
  function launch({ role, room, p, fmt, open, quick, listed, invite }) {
    state.role = role; state.mine = p.mine; state.name = p.name; state.fmt = fmt; state.myTeamCode = p.tc.code; state.profileId = p.profileId || null; state.rec = p.rec || null;
    state.open = !!open; state.quick = !!quick; state.listed = listed || null; state.admitted = false; state.admittedId = null; state.defecting = false; state.invite = invite || null; openText = ''; openLead = '';
    if (role === 'host') room = room || Netplay().makeCode(5, 'pokemonarena');
    state.room = room;
    // the board stays connected only for a game that is LISTED (it must keep announcing itself) or a join that came FROM it (a failure mutes that game); a private game, or a join by code, has no business on it
    if (state.open || state.invite) ensureLobbies(); else if (!state.listed) closeLobbies();
    canonicalizeUrl(role, room);
    lockSetup(role, room);
    startSession(role, room, p.tc.code);
    if (listed) armJoinWatchdog();
  }
  function lockSetup(role, room) {
    state.stage = 'waiting';
    for (const n of [ui.hostBtn, ui.joinBtn, ui.room, ui.team, ui.paste, ui.name, ui.fmt, ui.go, ui.quick, ui.pub]) n.disabled = true;
    ui.openBox.hidden = true; ui.pubBox.hidden = true;
    // The host's code is shown only once the room is open (openedRoom): a friend who is handed it earlier would knock on a door that is not there yet.
    // a join can be cancelled while it waits for the host (the board is public, so a listed game may be made up: it used to hold the joiner for the whole watchdog with only the page's Back link as a way out)
    ui.cancelAsk.hidden = role !== 'guest'; ui.cancelAsk.disabled = false;
    say(role === 'host' ? 'Opening your room...' : state.listed ? 'Joining ' + state.listed.name + '... It gives up after ' + Math.round(joinGiveUpMs() / 1000) + ' seconds if nobody answers; Cancel stops it sooner.' : 'Connecting to the room ' + room + '...');
    hooks.stage && hooks.stage('waiting');
  }
  const joinGiveUpMs = () => (query.limits && query.limits.joinMs) || 40000;

  /* ---------------------------------------------------------------------------------------------- open games (the board is js/openlobby.js)
   * A host who switched "Open to anyone" on, or who pressed Find a battle and found nobody, LISTS the game: a small beacon on the public brokers lib/netplay.js already pairs
   * through (a BroadcastChannel for net=local). Everyone with the panel open sees it and can join with one press. The pairing underneath is unchanged: the joiner still needs the
   * room code (the board hands it over) and the host's admission is still the lib's; an OPEN game answers it for the host, once, for the first player who asks. */
  function ensureLobbies() {
    if (lobbies) return lobbies;
    const N = Netplay();
    const bus = state.transport === 'local' ? createLocalBus(win) : createMqttBus(win, { brokers: N && typeof N.signalBrokers === 'function' ? N.signalBrokers() : [] });
    lobbies = createOpenLobbies({ bus, now, mine: { rom: PINNED.sha256, fp: cfg.fingerprint } });
    lobbies.watch(onBoardChange);
    return lobbies;
  }
  function closeLobbies() { if (acceptor) { acceptor.stop(); acceptor = null; } if (lobbies) { const l = lobbies; lobbies = null; try { l.close(); } catch (_e) { /* ignore */ } } }
  function setOpenWanted(v) { state.openWanted = !!v; syncSetupUi(); }
  /** Which parts of the setup form show, for the stage and the role. */
  function syncSetupUi() {
    const setup = state.stage === 'setup', ok = supportedHere();
    ui.openBox.hidden = !(setup && ok && query.role === null && !query.room);
    ui.pubBox.hidden = !(setup && ok && state.role === 'host');
    ui.pub.setAttribute('aria-pressed', String(state.openWanted));
    ui.pub.textContent = 'Open to anyone: ' + (state.openWanted ? 'on' : 'off');
    // what the switch publishes is said HERE, beside it, in full: the trainer name AND the online record (wins and losses, when the chosen team is a saved one that has played online), on public servers
    ui.pubNote.textContent = state.openWanted
      ? 'On: your game is listed under Open games on public servers, with your trainer name and your online record (wins and losses, if you have one), readable by anyone; and the first player who asks to join is let in without you pressing Allow. Closing this page takes it off the list.'
      : 'Off: only a friend you give the room code to can join, and you press Allow; nothing is listed. On: your trainer name and online record are listed on public servers and anyone can join from the list of open games.';
  }
  function onBoardChange() { renderOpenList(); maybeDefect(); refreshOpenNote(); }
  function renderOpenList() {
    if (!lobbies || !ui.openList || state.stage !== 'setup') return;
    const all = lobbies.list();
    const shown = all.filter((g) => g.compatible), hidden = all.length - shown.length;
    syncRows(shown);
    const st = lobbies.status();
    ui.openBox.dataset.board = st; ui.openBox.dataset.count = String(shown.length);
    // games on another build are hidden (the handshake would refuse them by name) and COUNTED, whether or not there are games to show beside them
    const hiddenNote = hidden ? ' (' + hidden + ' open on a different version of the Arena, hidden.)' : '';
    const note = st === 'down' ? 'The list of open games could not be reached. You can still host a game and give a friend the code.'
      : shown.length ? (shown.length === 1 ? '1 game is' : shown.length + ' games are') + ' waiting for an opponent.' + hiddenNote
      : (st === 'connecting' ? 'Looking for open games...' : 'Nobody is waiting right now. Press Find a battle to open a game and wait for someone, or host one yourself.') + hiddenNote;
    if (ui.openNote.textContent !== note) ui.openNote.textContent = note;          // (a live region: the same words again would be read out again at every beacon)
  }
  // THE LIST IS UPDATED IN PLACE, by room: a row that is still on the board keeps its <li> and its button, so a keyboard / switch / gamepad user who is on a Join button keeps their place when some
  // other game appears, changes or expires (the list used to be rebuilt from nothing at every beacon, which dropped the focus to the page body). Only a row that LEAVES takes its focus with it.
  const rowGame = new WeakMap();          // <li> -> the board entry it shows NOW (its button reads this at the press, never the entry it was built from)
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const fmtLabel = (g) => (g.fmt === '3v3' ? '3 v 3' : '6 v 6');
  function buildRow(g) {
    const li = el(doc, 'li', { 'data-room': g.room }, el(doc, 'span', { class: 'who' }), el(doc, 'span', { class: 'fmt' }),
      el(doc, 'button', { type: 'button', class: 'textbtn', onclick: () => { const cur = rowGame.get(li); if (cur) (cur.h ? challengeResident(cur) : joinListed(cur)); } }));
    return li;
  }
  function fillRow(li, g) {
    rowGame.set(li, g);
    setText(li.querySelector('.who'), g.name);
    setText(li.querySelector('.fmt'), fmtLabel(g));
    let rec = li.querySelector('.rec');
    if (g.rec) {
      if (!rec) { rec = el(doc, 'span', { class: 'rec' }); li.insertBefore(rec, li.querySelector('.fmt')); }
      setText(rec, g.rec[0] + '-' + g.rec[1]); rec.setAttribute('title', g.rec[0] + ' online wins, ' + g.rec[1] + ' losses');
    } else if (rec) rec.remove();
    const btn = li.querySelector('button'), label = (g.h ? 'Challenge ' : 'Join ') + g.name + ' (' + fmtLabel(g) + ')';
    setText(btn, g.h ? 'Challenge' : 'Join');
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
  }
  function syncRows(shown) {
    const list = ui.openList, have = new Map(), want = new Set(shown.map((g) => g.room));
    for (const li of list.children) have.set(li.dataset.room, li);
    const active = doc.activeElement;
    let heir = null;                         // where the focus goes if the row it was on is leaving: the row that took its place, else the one before it, else Find a battle
    for (const [room, li] of have) {
      if (want.has(room)) continue;
      if (active && li.contains(active)) { let n = li.nextElementSibling; while (n && !want.has(n.dataset.room)) n = n.nextElementSibling; if (!n) { n = li.previousElementSibling; while (n && !want.has(n.dataset.room)) n = n.previousElementSibling; } heir = n || ui.quick; }
      li.remove(); have.delete(room);
    }
    let at = list.firstElementChild;           // the row that belongs at this position; a row already there is left alone (moving a node would drop its focus too)
    for (const g of shown) {
      let li = have.get(g.room);
      if (!li) li = buildRow(g);
      fillRow(li, g);
      if (li === at) at = at.nextElementSibling; else list.insertBefore(li, at);
    }
    if (heir) { const t = heir === ui.quick ? heir : heir.querySelector('button'); if (t && !t.disabled) t.focus(); }
  }
  const joinListed = exclusive(async function joinListed(g) {
    if (state.stage !== 'setup' || !state.choices) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    const p = await prepare('guest');
    if (!p) return;
    const why = whyNot(g, p.mine);
    if (why) { p.release(); say(why, true); return; }
    ui.room.value = g.room;
    launch({ role: 'guest', room: g.room, p, fmt: null, open: false, quick: false, listed: g });
  });
  /** A RESIDENT game (h:1) belongs to a player who is somewhere else in the Arena and has not opened a room: ask them. Their dialog says who is asking; if they accept, their battle page opens a room
   *  and tells us which (presence.js has the messages), and from there it is an ordinary join. */
  const challengeResident = exclusive(async function challengeResident(g) {
    if (state.stage !== 'setup' || !state.choices || !lobbies) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    if (!canSeal(win.crypto)) { say(NO_SEAL, true); return; }           // the room is told to us sealed to a one-time key: without WebCrypto there is no private way, and no clear one
    const p = await prepare('guest');
    if (!p) return;
    const why = whyNot(g, p.mine);
    if (why) { p.release(); say(why, true); return; }
    state.stage = 'asking'; hooks.stage && hooks.stage('asking');
    for (const n of [ui.hostBtn, ui.joinBtn, ui.room, ui.team, ui.paste, ui.name, ui.fmt, ui.go, ui.quick, ui.pub]) n.disabled = true;
    ui.cancelAsk.hidden = false; ui.cancelAsk.disabled = false; ui.pubBox.hidden = true;
    say('Asked ' + g.name + ' to battle. Waiting for an answer...');
    const lim = query.limits || {};
    const timing = lim.chalMs ? { ...PRESENCE_TIMING, answerMs: lim.chalMs, connectMs: lim.chalMs * 2 } : PRESENCE_TIMING;
    asking = createChallenge({
      // (p.rec: this challenge is made BEFORE launch() runs, so state.rec is still the previous attempt's, or null on a fresh page)
      lobbies, target: g, name: p.name, rec: p.rec || null, now, timing, crypto: win.crypto,
      on: {
        state: () => say(g.name + ' accepted. Connecting...'),
        accepted: (room) => { asking = null; ui.cancelAsk.hidden = true; ui.room.value = room; launch({ role: 'guest', room, p, fmt: null, open: false, quick: false, listed: g }); },
        failed: (code) => {
          asking = null; ui.cancelAsk.hidden = true;
          const text = code === 'declined' ? g.name + ' is not available for a battle right now.' : code === 'busy' ? g.name + ' is answering another challenge. Try again in a moment.' : code === 'unsupported' ? NO_SEAL : g.name + ' did not answer.';
          if (lobbies && code !== 'unsupported') lobbies.mute(g.room, 8000);
          reopenSetup(); say(text, true);
        },
      },
    });
  });
  /** Cancel: a challenge that has not been answered, or a join that has not connected (a listed game that never answers, a code nobody opened). Neither can be taken back any other way than leaving the page. */
  function cancelAsk() {
    if (asking) { const a = asking; asking = null; a.cancel(); ui.cancelAsk.hidden = true; reopenSetup(); say('Cancelled.'); return; }
    if (state.stage === 'waiting' && state.role === 'guest' && !state.nm && state.session && !closed) { reopenSetup(); say('Cancelled.'); }
  }
  /** The page was opened by Accept (presence.js): host a game for the player who challenged, with the first saved team (or a random one) and the name the panel would have offered. */
  const autoStart = exclusive(async function autoStart(profileName) {
    if (!acceptTok || !query.auto) return;            // (only reached with the token; see the top of createOnline)
    setRole('host');
    // the PROFILE speaks for the player here: they were challenged as that trainer (the name on the board), not as whatever was last typed into this browser's name box
    if (profileName) { ui.name.value = cleanName(profileName, 'Host'); nameTouched = false; }          // (and that name is the profile's, not one the player typed: prepare() must not remember it as theirs)
    ui.lede.textContent = 'Opening a game for the player who challenged you...';
    const p = await prepare('host');
    if (!p) return;                         // the reason is on the screen; pressing Host by hand still works (as a private game)
    const fmt = ui.fmt.value === '3v3' && p.mine.size < 3 ? '6v6' : ui.fmt.value;
    launch({ role: 'host', room: null, p, fmt, open: false, quick: false, listed: null, invite: { for: query.auto.for, rq: query.auto.rq, ck: acceptTok.ck } });
  });
  /** Find a battle: join the game that has waited longest, or, if nobody is waiting, open one and wait. */
  const quick = exclusive(async function quick() {
    if (state.stage !== 'setup' || !state.choices || !lobbies) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    const p = await prepare('either');
    if (!p) return;
    state.stage = 'searching'; hooks.stage && hooks.stage('searching');
    say('Looking for an open game...');
    const lim = query.limits || {}, t0 = now();
    // a board that is still connecting has told us nothing yet: wait for it, then give the answers to our ask a moment to arrive
    while (lobbies && lobbies.status() === 'connecting' && now() - t0 < 9000 && !closed) await sleep(120);
    const usable = (g) => g.compatible && !g.h && !whyNot(g, p.mine);          // a resident game has no room to join: it is challenged from the list, not found here
    const pick = () => (lobbies ? lobbies.list().find(usable) || null : null);
    if (lobbies) lobbies.refresh();
    const t1 = now(); let g = pick();
    while (!g && lobbies && now() - t1 < (lim.quickMs !== undefined ? lim.quickMs : 2500) && !closed) { await sleep(100); g = pick(); }
    if (closed || state.stage !== 'searching') return;
    state.stage = 'setup';
    if (g) { ui.room.value = g.room; launch({ role: 'guest', room: g.room, p, fmt: null, open: false, quick: false, listed: g }); return; }
    if (!lobbies || lobbies.status() === 'down') { p.release(); say('The list of open games could not be reached, so there is nobody to find. Host a game and give a friend the code, or try again.', true); return; }
    const fmt = ui.fmt.value === '3v3' && p.mine.size < 3 ? '6v6' : ui.fmt.value;
    quickCtx = { p, fmt };
    launch({ role: 'host', room: null, p, fmt, open: true, quick: true, listed: null });
  });
  /** Two players pressed Find a battle together and both opened a game: the one with the LARGER room code joins the other, so exactly one stays. */
  function maybeDefect() {
    if (!lobbies || closed || !state.open || !state.quick || state.stage !== 'open' || state.nm || state.admitted || !state.mine) return;
    const g = lobbies.rival((x) => !whyNot(x, state.mine));
    if (g) defectTo(g);
  }
  function defectTo(g) {
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    if (lobbies) lobbies.unhost();
    state.session = null; state.open = false; state.quick = false; state.roomOpen = false;
    state.role = 'guest'; state.listed = g; state.fmt = null; state.room = g.room; state.defecting = true;       // defecting: if this join fails the player's OWN game comes back (failJoin)
    ui.codeBox.hidden = true; ui.invite.hidden = true;
    ui.cancelAsk.hidden = false; ui.cancelAsk.disabled = false;          // a join can be cancelled (cancelAsk)
    state.stage = 'waiting';
    canonicalizeUrl('guest', g.room);
    say('Found a game: joining ' + g.name + '...');
    hooks.stage && hooks.stage('waiting');
    startSession('guest', g.room, state.myTeamCode);
    armJoinWatchdog();
  }
  /** A listed game that never answers (a made-up beacon, a host whose page froze) must not hold the joiner forever. */
  function armJoinWatchdog() {
    win.clearTimeout(joinTimer);
    const ms = joinGiveUpMs();
    joinTimer = win.setTimeout(() => {
      joinTimer = 0;
      if (closed || state.stage !== 'waiting' || state.nm || !state.listed) return;
      failJoin('no answer');
    }, ms);
  }
  /** The words for a join that failed. A game from the list is also left off the board for a while (much longer when the joiner had left its own game for it: see DEFECT_MUTE_MS). */
  const DEFECT_MUTE_MS = 120000;
  function failedJoinText(why) {
    const g = state.listed;
    if (!g) return connectError(why);
    state.listed = null;
    if (lobbies) {
      lobbies.mute(g.room, state.defecting ? DEFECT_MUTE_MS : undefined);
      // The failure memory must not depend on the room code: a forger that publishes a fresh code is a new room to mute() each time. After a failed DEFECTION no rival at all moves this player for the same period.
      if (state.defecting) lobbies.muteRivals(DEFECT_MUTE_MS);
    }
    return /full|already|busy|taken/i.test(String(why || ''))
      ? 'That game was just taken by someone else. Pick another one, or press Find a battle.'
      : 'That game is not open any more' + (why && why !== 'no answer' ? ' (' + String(why).slice(0, 60) + ')' : '') + '. Pick another one, or press Find a battle.';
  }
  /** A join that did not work. A player who LEFT their own Find-a-battle game to join a rival (maybeDefect) gets that game back, listed again, with the rival left off the board: the rival may have been
   *  a ghost (the board is public and anyone can publish a beacon), or taken by somebody else a moment earlier, and the player asked to be found, not to be sent to a setup form. Anyone else goes
   *  back to the setup form with the words. */
  function failJoin(why) {
    const text = failedJoinText(why);
    if (state.defecting && rehostQuick()) return;
    reopenSetup(); say(text, true);
  }
  function rehostQuick() {
    const c = quickCtx;
    if (!c || closed || !lobbies) return false;
    win.clearTimeout(joinTimer); joinTimer = 0;
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    state.session = null; state.nm = null; state.defecting = false; state.listed = null; state.stage = 'setup'; relisting = false;
    launch({ role: 'host', room: null, p: c.p, fmt: c.fmt, open: true, quick: true, listed: null });
    openLead = 'The game you tried to join was not there. ';
    return true;
  }
  const PRE_BATTLE = ['hello', 'judging', 'seed', 'start'];
  // lib/netplay.js _linkGone(): the reasons it gives when the player at the other end is knocking AGAIN (a reloaded page, the same identity) and the old link is torn down to make room for the new one
  const REKNOCK = ['peer-reloaded', 'peer-rejoining'];
  const REKNOCK_HOLD_MS = 10000;          // how long a seat is held for a player who knocked again, before looking whether the library has given them a link
  let heldTimer = 0;
  /** An open game whose opponent never got as far as a battle goes back on the board: nobody has lost anything, and the host is still waiting for someone. */
  const relistable = () => !closed && state.open && state.role === 'host' && state.matches === 0 && !!state.nm;
  function relist(why) {
    if (!relistable() || relisting) return;
    relisting = true;
    clearRecord();
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    state.session = null; state.nm = null; preMsgs = []; state.admitted = false; state.admittedId = null;
    stopBar(); if (bar) { bar.remove(); bar = null; }
    // the words of the match that just ended ("Connection lost. Waiting for the other player...", said when the link dropped under it) are kept for 8 s by flash(); a NEW opponent who connects inside
    // those 8 s would be shown them on a healthy handshake
    flashText = ''; flashUntil = 0;
    state.stage = 'waiting'; state.roomOpen = false;
    const room = Netplay().makeCode(5, 'pokemonarena');
    state.room = room;
    canonicalizeUrl('host', room);
    say(String(why || 'The player did not get as far as a battle.') + ' Opening your game again...');
    hooks.stage && hooks.stage('waiting');
    startSession('host', room, state.myTeamCode);
  }

  async function startSession(role, room, teamCode) {
    const N = Netplay();
    const session = new N.Session({ game: role === 'host' ? GAME_KEY : null, host: role === 'host', code: room, portCount: 2, transport: state.transport });
    state.session = session;
    // an OPEN game answers the admission itself, for the first player who asks (the lib's own dialog stays for a private room: this handler is registered only here). The player who was let in is
    // remembered by the id they knocked with (req.id, stable across their reloads): a host Session that was REBUILT mid-match (scheduleReconnect) has forgotten who it let in, and the returning
    // player must not be told the game is taken; a third player still is (presence.js admission()). The moment somebody is let in the game comes off the board: nobody else can have the seat.
    if (role === 'host' && (state.open || state.invite)) session.on('join-request', (req) => {
      const verdict = admission({ open: state.open, invite: state.invite, nm: state.nm, closed, admitted: state.admitted, admittedId: state.admittedId }, req.id);
      if (verdict === 'deny') { req.deny('this game already has a player'); return; }
      if (verdict === 'approve') noteAdmitted(req.id);
      req.approve();
    });
    // THE LIBRARY ADMITS WITHOUT ASKING US in two cases the handler above never sees: a player it already let in (its _known set) who knocks again is re-admitted silently, and then it is the library, not this
    // page, that knows who is in. So the record follows the library's own events: 'room' (a link now exists although nobody asked this page: the seat is taken, the game comes off the board) and
    // 'peer-joined' (this nonce is the player who is in, whichever road it came by: it is what a REBUILT Session must let back in, see admission()).
    if (role === 'host' && (state.open || state.invite)) {
      session.on('room', (info) => { if (!closed && session === state.session && !state.nm && !state.admitted && info && info.links > 0) noteAdmitted(null); });
      session.on('peer-joined', (e) => { if (!closed && session === state.session && e && typeof e.peer === 'string' && e.peer) { state.admitted = true; state.admittedId = e.peer; } });
    }
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
        everConnected = true; state.defecting = false;
        win.clearTimeout(joinTimer); joinTimer = 0;
        ui.cancelAsk.hidden = true;                  // connected: there is a handshake now, not a wait for somebody who may not be there
        if (role === 'host' && lobbies) lobbies.unhost();            // somebody is in: the game comes off the board (it already did when they were let in; this covers a player the lib re-admitted by itself)
        if (acceptor) { acceptor.stop(); acceptor = null; }           // ... and the challenger has found us: no more "come in"
        if (state.nm) state.nm.linkChanged(true);          // a reconnection, or a page that was reloaded into a match
        else createMatch(role, room, teamCode);
      } else if (e.state === 'failed') {
        if (state.nm) { state.nm.linkChanged(false); scheduleReconnect(role, room, teamCode); }
        else if (!everConnected && session === state.session) failJoin(session.lastError || e.detail);       // (a session that was already replaced says nothing about the page now)
      } else if ((e.state === 'closed' || e.state === 'signalling') && everConnected && state.nm) state.nm.linkChanged(false);
    });
    session.on('peer-left', (e) => {
      if (closed) return;
      if (!state.nm) { if (role === 'host' && session === state.session) releaseAdmission(e); return; }       // a player who was let in but whose link died before it ever came up
      if (relistable() && PRE_BATTLE.includes(state.nm.phase)) { win.setTimeout(() => relist('The other player left before the battle began.'), 0); return; }
      state.nm.linkChanged(false);
    });
    session.on('kicked', (e) => { if (!closed) fatal('You were removed from the room', (e && e.why) || 'The host removed you from the room.'); });
    let ok = false;
    try { ok = await session.start(); } catch (e) { session.lastError = String(e && e.message ? e.message : e); }
    if (!ok && state.nm) { state.nm.linkChanged(false); scheduleReconnect(role, room, teamCode); return; }
    if (!ok && !everConnected) { if (session === state.session) failJoin(session.lastError); return; }       // (not for a session that was already given up on: failJoin may have opened a NEW game since)
    if (ok && role === 'host' && !everConnected && !closed && !state.nm) openedRoom(room);
  }
  // a session that failed while a match exists is replaced by a fresh one under the same code (the match's own clock decides when to give up)
  function scheduleReconnect(role, room, teamCode) {
    if (reconnecting || closed || !state.nm || state.nm.phase !== 'playing') return;
    reconnecting = true;
    win.setTimeout(() => {
      reconnecting = false;
      if (closed || !state.nm || state.nm.phase !== 'playing') return;
      try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
      startSession(role, room, teamCode);
    }, 2500);
  }
  function openedRoom(room) {
    relisting = false;
    state.stage = 'open'; state.roomOpen = true;
    ui.codeBox.hidden = false; ui.codeBox.textContent = room; ui.invite.hidden = false;
    if (state.open && lobbies) {
      try {
        listGame(room);
        const n = openNote(room); openText = n.text; say(n.text, n.bad);
      } catch (e) { say('Your room is open, but it could not be listed (' + (e && e.message ? e.message : e) + '). A friend can still use the code ' + room + '.', true); }
    } else if (state.invite && lobbies) {
      // tell the challenger the room SEALED to the one-time key they sent (the token carried it here); if it cannot be sealed the room is still open for a friend who is given the code
      if (acceptor) acceptor.stop();
      acceptor = createAcceptor({ lobbies, to: state.invite.for, r: state.invite.rq, room, ck: state.invite.ck, crypto: win.crypto,
        onFail: () => { if (!closed && state.stage === 'open') say('Your room is open, but the player who challenged you could not be told which room it is (their one-time key was not usable, or this browser has no WebCrypto). A friend can still use the code ' + room + '.', true); } });
      say('Waiting for the player who challenged you to connect. (A friend can also use the code ' + room + '.)');
    } else say('Your room is open. Give your friend the code ' + room + ' or the invite link, then allow them in when they ask.');
    hooks.stage && hooks.stage('open');
    maybeDefect();
  }
  function listGame(room) {
    lobbies.host({ room, name: state.name, fmt: state.fmt, rom: PINNED.sha256, fp: cfg.fingerprint, rs: state.mine.rs, q: state.quick, rec: state.rec || null });
  }
  /** What the host of an OPEN game is told, true to what the board can do right now (a board that lost every broker cannot show the game to anybody). */
  function openNote(room) {
    const st = lobbies ? lobbies.status() : 'down';
    if (st === 'up') return { bad: false, text: openLead + (state.quick ? 'Nobody was waiting, so your game is open. The next player to press Find a battle, or to pick you under Open games, joins you.' : 'Your game is open: anyone can join it from Open games. A friend can also use the code ' + room + ' or the invite link.') };
    if (st === 'connecting') return { bad: false, text: openLead + 'Your room is open, but the list of open games is not connected yet, so nobody can see your game yet. A friend can use the code ' + room + '.' };
    return { bad: true, text: openLead + 'Your room is open, but the list of open games cannot be reached, so nobody can find your game. A friend can still use the code ' + room + '.' };
  }
  /** The board's connection changed under a game that is waiting on it: say what is true now. */
  function refreshOpenNote() {
    if (!lobbies || !state.open || state.stage !== 'open' || state.nm || state.admitted || !lobbies.hosting()) return;
    const n = openNote(state.room);
    if (n.text !== openText) { openText = n.text; say(n.text, n.bad); }
  }
  /** A player was let in (and the game came off the board) but their link died before it was ever up: the seat is free again, so the game is wanted again. */
  function releaseAdmission(e) {
    if (!state.admitted || state.nm || closed || !state.roomOpen) return;
    // The library says WHY a link went. 'peer-reloaded' / 'peer-rejoining' are the player on the other end knocking AGAIN (a new page under the same identity): it tears the dead link down and then re-admits them
    // by itself, with no join-request. Relisting now would put the game back on the board for the whole connect window, so the seat is held; holdAdmission looks again if they never get as far as a link.
    if (e && REKNOCK.includes(e.why)) { holdAdmission(state.session); return; }
    win.clearTimeout(heldTimer); heldTimer = 0;
    state.admitted = false; state.admittedId = null;
    if (state.open && lobbies) {
      try { listGame(state.room); const n = openNote(state.room); openText = n.text; say(n.text, n.bad); }          // listed again, and the words are the open game's again (not "a player is joining")
      catch (_e) { /* the next beacon tries again */ }
    }
  }
  /** Somebody is in (the join-request handler let them in, or the library re-admitted them by itself): the seat is taken and the game comes off the board; a host of an open game is told, because "your game is open" is not true now. */
  function noteAdmitted(id) {
    if (!(state.open || state.invite)) return;
    const first = !state.admitted;
    state.admitted = true;
    if (id) state.admittedId = id;
    if (lobbies) lobbies.unhost();
    if (first && state.open && !state.nm) { openText = ''; say('A player is joining your game. It is off the list of open games while they connect.'); }
  }
  /** An admitted player knocked again and the library has torn the old link down: give the seat up only if no link has appeared for them after a while (their page may be gone). While the library holds a link its
   *  own connect budget decides, and ends in a peer-left that releases the seat. */
  function holdAdmission(session) {
    win.clearTimeout(heldTimer);
    heldTimer = win.setTimeout(() => {
      heldTimer = 0;
      if (closed || state.nm || !state.admitted || !session || session !== state.session) return;
      let links = 0; try { links = session.roomInfo().links | 0; } catch (_e) { links = 0; }
      if (links > 0) holdAdmission(session); else releaseAdmission();
    }, (query.limits && query.limits.holdMs) || REKNOCK_HOLD_MS);
  }
  function connectError(why) {
    const w = String(why || '');
    if (/unavailable|peer-unavailable|not reach|broker|server/i.test(w)) return 'Could not reach that room. Check the code, and that your friend has opened it.' + (w ? ' (' + w.slice(0, 80) + ')' : '');
    if (/denied|declined/i.test(w)) return 'The host did not let you in.';
    if (/version/i.test(w)) return 'The other player is on a different version of the site. Reload and try again.';
    return (w ? w.slice(0, 160) : 'Could not connect.') + ' Check the code and try again.';
  }
  function reopenSetup() {
    win.clearTimeout(joinTimer); joinTimer = 0;
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    if (lobbies) lobbies.unhost();
    if (acceptor) { acceptor.stop(); acceptor = null; }
    if (asking) { const a = asking; asking = null; a.cancel(); }
    state.session = null; state.nm = null; state.stage = 'setup'; state.open = false; state.quick = false; state.listed = null; state.admitted = false; state.admittedId = null; state.defecting = false; state.invite = null; relisting = false;
    state.profileId = null; state.rec = null;          // (the next launch() sets both from the team it is given: nothing of the attempt that just ended may be read as the next one's)
    // A page that was opened as the BOARD (?online=1) and then joined a listed game had its address rewritten to ?np=ROOM&join=1 by launch() (so a reload finds the room). The join has ended without a match (Cancel, a game that
    // never answered, one that was taken) and the page is the board again: a reload of that address would open the join-by-code form with the dead room filled in and no board, so the plain address comes back.
    if (query.role === null && !query.room) { try { win.history.replaceState(null, '', boardAddress(win.location.href)); } catch (_e) { /* the address stays as it was */ } }
    ui.cancelAsk.hidden = true;
    for (const n of [ui.hostBtn, ui.joinBtn, ui.room, ui.team, ui.paste, ui.name, ui.fmt, ui.go, ui.quick, ui.pub]) n.disabled = false;
    ui.codeBox.hidden = true; ui.invite.hidden = true;
    root.querySelector('#online').hidden = false;
    syncSetupUi();
    if (!ui.openBox.hidden) { ensureLobbies(); lobbies.startWatching(); renderOpenList(); }
  }

  function createMatch(role, room, teamCode, resume) {
    const mineCard = state.mine;
    let theirs = resume ? resume.theirs : null;        // the judged opponent card, kept for makeController
    const nm = state.nm = createNetMatch({
      role, room, limits: query.limits, now,
      send: (msg) => { try { return !!state.session._send(msg); } catch (_e) { return false; } },
      mine: { rom: PINNED.sha256, fp: cfg.fingerprint, rs: mineCard.rs, name: state.name, team: teamCode, size: mineCard.size, fmt: state.fmt },
      judge: async (card) => { const j = await judgeTeamCode(card.team, pack); theirs = j; if (j && j.ok) state.oppTeamCode = j.code; return j; },
      makeController: ({ seed, mySide, fmt, names }) => buildNetController({ pack, mySide, seed, fmt, names, mine: mineCard, theirs }),
      on: {
        phase: (p, info) => onPhase(p, info),
        controller: (ctl) => onController(ctl),
        notice: (t, kind) => flash(t, kind),
        end: (res) => onEnd(res),
        progress: () => { renderBar(); persist(); },
      },
    });
    startBar();
    if (!wired) { wired = true; win.addEventListener('pagehide', onPageHide); }
    if (resume) {                      // a reloaded page: the battle is rebuilt from the record (this fires 'controller' with the replayed match, or 'failed')
      state.stage = 'resuming'; hooks.stage && hooks.stage('resuming');
      nm.resume(resume.rec);
      return;
    }
    state.stage = 'handshake';
    for (const m of preMsgs.splice(0)) nm.receive(m);
    nm.start();
    say('Connected. Checking the teams...');
    hooks.stage && hooks.stage('handshake');
  }
  // A page that is closing does NOT forfeit: it may be a RELOAD, and the record kept above brings the battle back. The other player sees the link drop and waits (60 s); if this
  // page never returns they win. Leaving ON PURPOSE (a forfeit, BACK TO HUB) still ends it at once.
  function onPageHide() { persist(); }

  /* ---------------------------------------------------------------------------------------------- the match */
  function onController(ctl) {
    state.matches++;
    closeLobbies();
    const nm = state.nm;
    const info = { mySide: nm.mySide, names: nm.names.slice(), myName: nm.myName, oppName: nm.oppName, seed: nm.seed, fmt: nm.fmt, mn: nm.mn, room: state.room, role: nm.role, resumed: !!nm.resumed };
    state.info = info;
    state.stage = 'playing';
    panel.hidden = true;
    hooks.mountScene(ctl, info);
    renderBar();
    persist();
  }
  function onPhase(p, info) {
    if (p === 'failed') {
      if (relistable()) { const why = info && info.message ? info.message : 'The match could not start.'; win.setTimeout(() => relist(why), 0); return; }
      fatal(titleFor(info), info && info.message ? info.message : 'The match was stopped.');
    }
    else if (p === 'over') { state.stage = 'over'; clearRecord(); renderBar(); }
    else if (p === 'closed') clearRecord();
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
    clearRecord(); stopBar(); closeLobbies(); win.clearTimeout(joinTimer);
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
    clearRecord(); closed = true; stopBar(); closeLobbies(); win.clearTimeout(joinTimer);
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
    else if (st.waitingOn.includes(st.mySide)) msg = st.kind === 'preview' ? 'Choose your Pokemon.' : 'Your move.';          // the team preview and the 6v6 lead round are not a move
    else if (st.waitingOn.includes(st.mySide ^ 1)) msg = st.oppReady || st.kind === 'preview' ? 'Waiting for ' + st.opponent + ' to choose...' : st.opponent + ' is still watching the last turn...';
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
    // closing the page takes an open game off the board at once (best effort: the board drops it a few seconds later anyway)
    // ... and a challenge that is still waiting for an answer is withdrawn, so the owner's dialog does not stay up for a player who has gone (it would also be accepted for nobody)
    win.addEventListener('pagehide', () => {
      if (asking) { try { asking.cancel(); } catch (_e) { /* ignore */ } }
      if (lobbies) { try { lobbies.unhost(); } catch (_e) { /* ignore */ } }
    });
    // a RELOAD of a battle that was under way picks it up again; opening the same address afresh (typing it, following a link) never does
    const rec = readRecord();
    if (rec) {
      const nt = navigationType();
      // (a resume that is given up has already built the setup form itself, with the reason on the screen: running setupForm() again would add every team to the list a second time and wipe the reason)
      if (nt === 'reload' || nt === 'back_forward') { await resumeFlow(rec); return; }
      else { state.room = rec.room; state.role = rec.role; clearRecord(); }
    }
    await setupForm();
  }

  /** -> true when the battle is being resumed (the scene is mounted by the match's 'controller' event), false when the page should show the setup form after all. */
  async function resumeFlow(rec) {
    state.stage = 'resuming'; state.role = rec.role; state.room = rec.room; state.name = rec.myName; state.fmt = rec.fmt;
    state.myTeamCode = rec.myTeam; state.oppTeamCode = rec.oppTeam;
    state.profileId = isId(rec.profileId) ? rec.profileId : null;          // the profile this battle is written to when it ends (a record from an older build, or a damaged one, has none: the career then finds the team's owner itself)
    ui.lede.textContent = 'Picking your battle up again...';
    say('Picking your battle up again...');
    hooks.stage && hooks.stage('resuming');
    const giveUp = async (why) => { clearRecord(); state.stage = 'setup'; state.nm = null; await setupForm(); say(why + ' Start a new battle below.', true); return false; };
    if (!Netplay() || typeof Netplay().supported !== 'function' || !Netplay().supported()) return giveUp('This browser cannot connect two players any more.');
    const [mine, theirs] = await Promise.all([judgeTeamCode(rec.myTeam, pack), judgeTeamCode(rec.oppTeam, pack)]);
    if (!mine.ok || !theirs.ok) return giveUp('Your battle could not be picked up again: a team no longer checks out.');
    state.mine = mine;
    createMatch(rec.role, rec.room, rec.myTeam, { rec, theirs });
    if (state.stage === 'failed') return true;          // nm.resume refused the record: fatal() has said so and cleared it
    startSession(rec.role, rec.room, rec.myTeam);
    return true;
  }

  async function setupForm() {
    const { choices, name } = await gatherTeams();
    state.choices = choices;
    for (const c of choices) ui.team.append(el(doc, 'option', { value: c.key, text: c.label, 'data-size': String(c.size || 6) }));
    let saved = ''; try { saved = win.localStorage.getItem(LS_NAME) || ''; } catch (_e) { /* ignore */ }
    // a remembered name is one the player TYPED (prepare() keeps no other): it is theirs, and stays when the team changes. With none, the name is the trainer who owns the team that is pre-selected
    // (the first saved team is the active profile's, but not when that profile has no legal team, or the address brings a team of its own).
    nameTouched = !!saved;
    ui.name.value = cleanName(saved || name, query.role === 'guest' ? 'Guest' : 'Host');
    ui.team.value = choices[0].key;
    nameFollowsTeam();
    ui.fmt.value = cfg.formatParam === '6v6' ? '6v6' : cfg.formatParam === '3v3' ? '3v3' : (choices[0].size >= 6 && choices[0].key !== 'random' && choices[0].key !== 'paste' ? '6v6' : '3v3');
    refreshFormats();
    if (query.room) { ui.room.value = query.room; state.room = query.room; }
    setRole(query.role || (query.room ? 'guest' : 'host'));
    if (query.role === null && !query.room) { ui.roleRow.hidden = false; } else ui.roleRow.hidden = true;
    ui.lede.textContent = query.role === 'guest' ? 'You are joining ' + (query.room || 'a room') + '. Pick your team and your name, then join.' : query.role === 'host' ? 'You are hosting. Pick your team and the format; you get a code to give your friend.' : ui.lede.textContent;
    hooks.stage && hooks.stage('setup');
    say('');
    syncSetupUi();
    if (!ui.openBox.hidden) { ensureLobbies(); lobbies.startWatching(); renderOpenList(); ui.quick.disabled = false; }
    if (query.auto) autoStart(name); else if (autoNotice) say(autoNotice);
  }

  // (flashNow: the one-line notice the bar would show this instant, '' when there is none; the page test reads it)
  const api = { begin, onResult, leaveToHub, state, nm: () => state.nm, session: () => state.session, flash, flashNow: () => (flashText && now() < flashUntil ? flashText : ''), renderBar, lobbies: () => lobbies, quick, joinListed, challengeResident };
  return api;
}
