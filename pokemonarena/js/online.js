// pokemonarena/js/online.js -- the page half of a networked battle: what a press on the battle page starts (a private room, a join, a search for anyone), the lib/netplay.js session, the open-games
// board, the status line of a battle, and the glue that hands the match controller to the battle page. The protocol itself is netmatch.js; the Arena-specific halves (team judging, building the
// controller, the engine fingerprint) are online_match.js. Both are DOM-free and tested in Node (tools/pokemonarena_netmatch_test.mjs); this file is what
// tools/pokemonarena_online_page_test.mjs drives in two real browser pages.
//
// NOTHING HERE DRAWS (INAPP.md "Wave 2"). Everything a player CHOOSES (the team, the battle size, the name, invite / join / battle anyone) is chosen in the hub's online menu, which hands over with a
// one-time token (presence.js: START, MEET, ACCEPT) and the online preferences (online_prefs.js). What this page still says before a battle is STATE: view() is one pure function of a snapshot of it
// (online_view.js: which screen, who the player is in it, the heading, the steps, the sentence, the room code, the rows that can be pressed), js/online_draw.js draws that view in the battle canvas
// from the ROM, and js/battle_boot.js routes the buttons and the pointer to act(id). The one piece of DOM this file makes is the slim status line of a battle (#netbar).
//
// WHAT lib/netplay.js DOES FOR US, AND WHAT IT DOES NOT. It pairs two browsers: a room code, the host's admission of the joiner, ICE / relay fallback, link health. It does not know what a Pokemon is.
// Our messages ride on its channel as type 'lsarena' (the 'ls' prefix is what its inbound router passes to _onRoomMsg; gba.html does the same with 'lsgbahostbye'), sent with session._send() and
// received by wrapping session._onRoomMsg. Every inbound path - the direct channel and the relay - ends in that router, so the relay carries a battle too.
//
// THE URL CONTRACT (battle.html?...)        AN ADDRESS DOES NOT START A GAME: only a one-time token of this tab does (INAPP.md "Contract 1"). Without one the page ASKS (a confirm screen).
//   online=1                    with the hub's START token: INVITE A FRIEND (a private room is opened) or BATTLE ANYONE (a search). Without it: back to the hub's online menu (location.replace)
//   online=1&ask=host | quick   the hub could not leave a token (storage blocked): the page asks once, OPEN A ROOM FOR A FRIEND? / FIND AN OPPONENT?
//   np=CODE&host=1 | &join=1    the lobby's hand-off (multiplayer.html) and a friend's invite link: YOUR ROOM / YOU'RE INVITED, one press. With the hub's token (START { room }, or MEET with &meet=1): no press
//   team=<ARENA1 code>          adds "the team in the address" to the teams the page can play            format=6v6|3v3   the host's default format
//   auto=host&for=<sender id>&rq=<request id>&format=..   an ACCEPTED CHALLENGE (presence.js): the owner was in the hub or a CPU battle, pressed YES (which left a ONE-TIME TOKEN in this tab's
//                               sessionStorage) and lands here; with that token the page plays the preferred team, opens a room, tells the challenger the room SEALED to the challenger's one-time key
//                               (`acc`: the room is never on the public board in the clear), and lets the first player in without a prompt. WITHOUT the token (a link from anywhere) auto/for/rq are ignored
//                               and the page says so. Once the room is open the address becomes np=ROOM&host=1 and the token is gone, so a reload resumes like any host. For net=local also openchal=<ms>.
//   (a board page that joined a listed game has its address rewritten to np=ROOM&join=1 so a reload finds the room; when that join ends without a match the plain online=1 address is put back: boardAddress)
//   net=local test seams for the open games: openquick / openjoin / openchal (above) and openhold=<ms>, how long a seat is held for an admitted player who knocks again before looking whether they got a link.
//   net=local                   BroadcastChannel pairing (two tabs of one browser; the test rigs)       arenaturn=<ms> / arenagrace=<ms>  (net=local only) a short turn limit / link grace; NOT 'turn', which lib/netplay.js reads as a TURN relay
// THE OPEN-GAMES BOARD (js/openlobby.js) is still dialled here, by what needs it: BATTLE ANYONE (join the game that has waited longest, or list one and wait; defect to a rival's), an accepted
// challenge (the sealed "come in"), and a challenge sent from this page (challengeResident: reachable through the hook only; players challenge each other in the hub's Trainer Center).
// THE PLAYERS ONLINE LIST IS GONE (INAPP.md "Wave 2", decision 2): board() is what it showed, as data, for the tests.
// Test hook: window.__arenaOnline.

import { openStore } from './store.js';
import { readHubData, teamCodeFor } from './hub_data.js';
import { judgeTeamCode, randomTeamCode, buildNetController, engineFingerprint } from './online_match.js';
import { createNetMatch, cleanName, NAME_MAX, PROTO } from './netmatch.js';
import { PINNED } from './rom.js';
import { isId } from './profile.js';
import { navigationType } from './battle_resume.js';
import { createOpenLobbies, createLocalBus, createMqttBus, ROOM_RE, MQTT_LIB } from './openlobby.js';
import { createChallenge, createAcceptor, takeAcceptToken, takeMeetToken, takeStartToken, startPlan, admission, canSeal, ACCEPT_MAX_AGE_MS, TIMING as PRESENCE_TIMING } from './presence.js';
import { readOnlinePrefs, preselect } from './online_prefs.js';
import { onlineView, UNDER_WAY, fmtClock } from './online_view.js';

export const GAME_KEY = 'Pokemon Arena';
export { ROOM_RE };
const LS_NAME = 'arena.online.name';
const resumeKey = (room, role) => 'arena.online:' + room + ':' + role;       // sessionStorage: per tab, gone when the tab closes, never sent anywhere
const RESUME_MAX_AGE_MS = 4 * 3600 * 1000;
// WHAT ONLINE PLAY SAYS ABOUT ITSELF (the hub's online menu shows it before a player leaves for this page; ONLINE.md "What is public"). Both are true of the code as it is (ONLINE.md, "What is public"): a battle needs BOTH teams in BOTH browsers (the engines are lockstep), so the team you play does go to
// the other player (directly, or over lib/netplay.js's relay when there is no direct path); and the board is a topic on the third-party brokers lib/netplay.js pairs through, read with mqtt.js from a CDN.
export const ONLINE_SHARES = 'Two players, each on their own device, one battle. Your teams stay in your browser until a battle starts; then the team you play and your choices go to the other player, directly when your browsers can reach each other and through a public relay when they cannot.';
/** What BATTLE ANYONE dials, in words, built from what the page REALLY dials: the brokers Netplay.signalBrokers() returns (a deployment or a ?wsbroker= address can change the list) and the script openlobby.js loads. -> a sentence or two. */
export function boardPrivacyText(brokers, scriptUrl) {
  const host = (u) => { try { return new URL(String(u).split('|')[0]).hostname; } catch (_e) { return ''; } };
  const names = [...new Set((Array.isArray(brokers) ? brokers : []).map(host).filter(Boolean))];
  return 'The list comes from public servers. While this page is open it connects to ' + (names.length ? names.length + ' third-party MQTT brokers (' + names.join(', ') + ')' : 'third-party MQTT brokers') + ' and loads a script from ' + (host(scriptUrl) || 'a public CDN')
    + '; they can see your IP address, and your browser asks "who is open?" under a random id. '
    + 'If you open a game (Find an opponent when nobody is waiting) or challenge someone, your trainer name and your online record (wins and losses, if you have one) go on those servers for anyone to read. A private game with a code is never listed.';
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
  // ask=host | quick: the hub could not leave its one-time token (storage blocked), so the page ASKS before it starts that (INAPP.md "Contract 1"); read only on the plain address (no room, no role)
  const ask = np === null && !host && !join && !auto && (q.get('ask') === 'host' || q.get('ask') === 'quick') ? q.get('ask') : null;
  return { role: auto || host ? 'host' : join ? 'guest' : null, room: auto ? null : room, transport, limits, auto, ask, meet: q.get('meet') === '1' && join && room !== null };
}

/**
 * The address a RELOAD of this page must come back to: the room and the role (so the resume record is found), and NOTHING that starts a game. An accepted-challenge page arrives as
 * ?online=1&auto=host&for=..&rq=..; once its room is open all of that is dropped (auto, for, rq, ck as well as online / host / join), so a reload, Back or a restored tab is an ordinary host
 * (np=ROOM&host=1) and cannot open a second room or re-run the hand-off.
 */
export function canonicalAddress(href, role, room) {
  const u = new URL(href);
  for (const k of ['online', 'host', 'join', 'auto', 'for', 'rq', 'ck', 'meet']) u.searchParams.delete(k);
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
  for (const k of ['np', 'host', 'join', 'rq', 'for', 'ck', 'auto', 'meet']) u.searchParams.delete(k);
  u.searchParams.set('online', '1');
  return u.pathname + u.search + u.hash;
}

/**
 * What a room-code box was given: a code (any case, spaces and dashes dropped, at most 8 characters) or a whole invite link pasted in (its np= is taken). -> the code to show, or null to leave the
 * text alone (an address that names no room). Pure: the battle page's code box and the hub's JOIN A FRIEND entry normalise with this one function; ROOM_RE then says whether it is a room code.
 */
export function roomFromInput(raw) {
  const s = String(raw || '').trim();
  const m = /[?&]np=([A-Za-z0-9]{4,8})(?:&|#|$)/.exec(s);
  if (m) return m[1].toUpperCase();
  if (/^https?:|\//i.test(s)) return null;
  return s.replace(/[\s-]+/g, '').toUpperCase().slice(0, 8);
}

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
 * cfg: { win, doc, pack, bar (the element the battle's status line is inserted before), query (parseOnlineQuery), teamParam (the ?team= code or null), formatParam, fingerprint, now,
 *        hooks: { mountScene(ctl, info), sceneState() -> { mode, pending }, showFatal({ title, message }), stage(s), changed() (something view() shows has changed),
 *                 toHub() (leave for the hub: the screen the player came from), toMenu() (leave for the hub's online menu, in this page's place), toTeam(room, role) (CHANGE TEAM) } }
 * -> { begin(), onResult(choice), leaveToHub(), state, view() (online_view.js), act(id) (a row of the screen was pressed), and the named actions act() calls and the tests drive:
 *      setForm(patch), startAs(role), go(), quick(), cancel(), copyLink(), copyCode(), share(), changeTeam(), back(), joinListed(room), challengeResident(room), pick(room), board() }
 */
export function createOnline(cfg) {
  const { win, doc, pack } = cfg;
  const hooks = cfg.hooks;
  // AN ADDRESS DOES NOT START A GAME. An accepted challenge (query.auto) is hosted only if this tab holds the one-time token presence.js wrote when the owner pressed Accept; it is taken (and gone) here, once.
  // Any other way of arriving at ?online=1&auto=host&for=..&rq=.. (a link from anywhere, an old history entry, a reload before the room opened) says so in one line and starts nothing.
  let query = cfg.query, acceptTok = null, autoNotice = '';
  if (query.auto) {
    let ss = null; try { ss = win.sessionStorage; } catch (_e) { ss = null; }
    acceptTok = takeAcceptToken(ss, query.auto, Date.now(), ACCEPT_MAX_AGE_MS);        // wall clock: the token was written by the PREVIOUS page, and a monotonic clock does not span a page load
    if (!acceptTok) { query = { ...query, role: null, room: null, auto: null }; autoNotice = 'That address tried to open a game for you without you pressing Accept, so it was ignored.'; }
  }
  // THE TRAINER CENTER'S HAND-OFF: a join it was let into (an accepted challenge, a listed game) presses Join by itself, but only against the one-time token the Center left in THIS tab (presence.js takeMeetToken)
  let meetTok = false;
  if (query.meet) { let ss = null; try { ss = win.sessionStorage; } catch (_e) { ss = null; } meetTok = takeMeetToken(ss, query.room, Date.now()); }
  // THE HUB'S HAND-OFF (INAPP.md "Contract 1"): INVITE A FRIEND, BATTLE ANYONE and OPEN THE ROOM are pressed in the hub's picture, which leaves a one-time START token in THIS tab and opens this page.
  // It is taken (and gone) here, once, whatever the address; startPlan says what it starts ON THIS ADDRESS ('host' | 'room' | 'quick'), or null: no token, a stale one, one for another room or for
  // another kind of address. The same address from anywhere else starts nothing and is the page it always was. (cfg.query: the address as it was read, before an unbacked auto= was struck out above.)
  let startTok = null;
  { let ss = null; try { ss = win.sessionStorage; } catch (_e) { ss = null; } startTok = startPlan(takeStartToken(ss, Date.now()), cfg.query); }
  // ... and the address's own question wins: a token for the OTHER question (INVITE A FRIEND's on ?ask=quick, BATTLE ANYONE's on ?ask=host) starts nothing. It was taken all the same (one use).
  if (startTok && cfg.query.ask && startTok !== cfg.query.ask) startTok = null;
  // every use of the clock here is a DURATION (a turn's allowance, a link's grace), so it is the monotonic one: a wall-clock step (NTP, a changed timezone) must not time anyone out
  const now = cfg.now || (() => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now()));
  const state = { stage: 'setup', role: query.role, room: query.room, transport: query.transport, nm: null, session: null, mine: null, name: null, fmt: null, error: null, info: null, matches: 0, open: false, quick: false, listed: null, openWanted: false, admitted: false, admittedId: null, defecting: false, invite: null, profileId: null, rec: null };
  // THE FORM IS A MODEL, NOT NODES (INAPP.md "Wave 2"): what the player chose (in the hub's online menu, through the preferences; a test through setForm). The logic below reads this and nothing on the page.
  //   teamKey: the key of one of state.choices | name | nameTouched: the name is one the player gave (a stored one), not one filled in from a team's owner | fmt: '3v3' | '6v6' | room: the code to join
  const form = state.form = { teamKey: null, name: '', nameTouched: false, fmt: '3v3', room: '' };
  // WHAT A BOARD PAGE ASKS (the plain address: no room, no role): 'host' (OPEN A ROOM FOR A FRIEND?) or 'quick' (FIND AN OPPONENT?). It is what the address says (ask=), or what the hub's START token started:
  // a room that is closed again, or a search that found nothing, comes back to that question. null on every other page.
  state.ask = cfg.query.ask || (startTok === 'quick' ? 'quick' : startTok === 'host' ? 'host' : null);
  // viaToken: what is under way was started by a token of the hub, with no press on this page. A way out the player takes then (CLOSE THE ROOM, STOP LOOKING, CANCEL) goes back to the hub, where they pressed;
  // a failure stays here, with the reason and the question (the player must be able to read why).
  let viaToken = false;
  // starting: a token of the hub (START, MEET, ACCEPT) is about to start something on this page with no press here. Until it has (the teams are read, the team is checked) the screen says what
  // is starting, never the question the same address would ask WITHOUT the token: a player who pressed INVITE A FRIEND in the hub must not be shown OPEN A ROOM FOR A FRIEND? on the way.
  // A refusal ends it (the page is then at its question, with the reason), and so does anything the player starts from that question.
  state.starting = !!(acceptTok || meetTok || startTok);
  // WHAT THE SCREEN SAYS, as state (view() reads it, and whatever presents the page reads view()): the one sentence, the way out of what is under way, whether the room's code may be shown, what can be pressed
  state.status = { text: '', bad: false }; state.cancel = { shown: false, label: 'Cancel' }; state.codeShown = false; state.goOff = true; state.quickOff = true; state.locked = false; state.copied = null; state.canShare = false; state.bar = null;
  const setCancel = (shown, label) => { state.cancel = { shown: !!shown, label: label || state.cancel.label }; };
  // THE STAGE IS A PROPERTY: when it last changed is what the elapsed time counts from ("Waiting for your friend... 0:42"), whoever changed it
  let stageNow = 'setup', stageAt = 0;
  Object.defineProperty(state, 'stage', { enumerable: true, get: () => stageNow, set: (s) => { if (s !== stageNow) { stageNow = s; stageAt = UNDER_WAY.includes(s) ? now() : 0; } } });
  // quickCtx: what Find a battle was launched with, to open the same game again if a game it left its own for turns out not to be there. openText / openLead: what the host of an open game was last told.
  let bar = null, barTimer = 0, preMsgs = [], wired = false, closed = false, reconnecting = false, lobbies = null, joinTimer = 0, relisting = false, asking = null, acceptor = null, quickCtx = null, openText = '', openLead = '';
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
    try { ss.setItem(resumeKey(state.room, state.role), JSON.stringify({ ...snap, myTeam: state.myTeamCode, oppTeam: state.oppTeamCode, myName: state.name, profileId: state.profileId || null, admittedId: state.role === "host" ? state.admittedId || null : null, at: Date.now() })); } catch (_e) { /* storage full or blocked: this match simply cannot be resumed */ }
  }
  // the address a reload must come back to: the room and the role, so that the record above can be found (a host who started from ?online=1 had neither)
  function canonicalizeUrl(role, room) {
    try { win.history.replaceState(null, '', canonicalAddress(win.location.href, role, room)); }
    catch (_e) { /* the address stays as it was; a reload just starts a new setup */ }
  }

  /* ---------------------------------------------------------------------------------------------- what the page says (state; online_view.js makes the view of it, online_draw.js draws it) */
  /** The one sentence on the screen (a refusal when `bad`). It is state: view().status. */
  const say = (t, bad) => { state.status = { text: t || '', bad: !!bad }; if (bad) state.starting = false; paint(); };
  const inviteLink = () => win.location.origin + '/pokemonarena/battle.html?np=' + encodeURIComponent(state.room) + '&join=1' + (state.transport === 'local' ? '&net=local' : '');
  /** Copy, and say so WHERE THE PRESS WAS for two seconds (view().copied: 'link' | 'code'): the sentence says what is happening, and a "Copied." there used to replace "Waiting for your friend...".
   *  clipboard.writeText is called in the same task as the press that asked for it (nothing is awaited before it): a browser may refuse a copy that no user gesture stands behind. */
  let copiedTimer = 0, refusedTimer = 0;
  /** How long the refusal is said (ms) before the sentence that says what is happening comes back (it used to stay, in red, for the rest of the wait). */
  const REFUSED_MS = 6000;
  const COPY_REFUSED = (room) => 'Copy was refused. Tell your friend the room code ' + room + ' on this screen.';
  async function copy(text, what) {
    let ok = false;
    try { await win.navigator.clipboard.writeText(text); ok = true; } catch (_e) { ok = false; }
    // REFUSED (no clipboard here, or a press the browser does not count as a user gesture: a controller's): say so, and point at what always works. The room code is on the screen.
    if (!ok) {
      const prev = { ...state.status }, said = COPY_REFUSED(state.room);
      say(said, true);
      win.clearTimeout(refusedTimer);
      refusedTimer = win.setTimeout(() => { if (state.status.text === said) { state.status = prev; paint(); } }, REFUSED_MS);          // (unless something else has been said since)
      return false;
    }
    state.copied = what; paint();
    win.clearTimeout(copiedTimer);
    copiedTimer = win.setTimeout(() => { state.copied = null; paint(); }, 2000);
    return true;
  }
  const copyLink = () => copy(inviteLink(), 'link');
  const copyCode = () => copy(state.room, 'code');
  async function share() {
    try { await win.navigator.share({ title: 'Pokemon Arena battle', text: 'Battle me in Pokemon Arena! Room ' + state.room, url: inviteLink() }); }
    catch (e) { if (!e || e.name !== 'AbortError') copyLink(); }
  }
  // the plain Play online page: no role and no room in the address
  const boardPage = () => query.role === null && !query.room;
  function startAs(role) {
    if (state.stage !== 'setup' || busy) return;
    if (role === 'guest') { const v = roomFromInput(form.room); if (v !== null) form.room = v; }
    setRole(role);
    go();
  }
  function setRole(role) {
    if (state.stage !== 'setup') return;
    state.role = role;
    state.goOff = false;
    if (role === 'guest' && state.room && !form.room) form.room = state.room;
    paint();
  }
  const choiceNow = () => (state.choices ? state.choices.find((c) => c.key === form.teamKey) || state.choices[0] : null);
  function refreshFormats() {
    // a team of fewer than three cannot play 3v3
    const c = choiceNow(), size = c && c.size ? c.size : 6;
    if (size < 3) form.fmt = '6v6';
  }

  // THE NAME IS THE TRAINER'S: picking a saved team fills in the name of the profile that owns it, unless the player has typed a name of their own on this page
  function nameFollowsTeam() {
    if (form.nameTouched || !state.choices) return;
    const c = state.choices.find((x) => x.key === form.teamKey);
    if (c && c.trainer) form.name = cleanName(c.trainer, form.name || 'Player');
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
    } catch (_e) { /* no profiles in this browser: a random team (and one in the address) still works */ }
    out.push({ key: 'random', label: 'A random team (6 Pokemon)', size: 6 });
    return { choices: out, name };
  }

  async function teamCodeOf(choice) {
    if (choice.key === 'url') return { ok: true, code: choice.code };
    if (choice.key === 'random') { const a = new Uint32Array(1); win.crypto.getRandomValues(a); try { return { ok: true, code: await randomTeamCode(pack, a[0]) }; } catch (e) { return { ok: false, message: 'A random team could not be made (' + (e && e.message ? e.message : e) + ').' }; } }
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
  const UNSUPPORTED = 'This browser cannot connect two players. Try a current Chrome, Firefox, Safari or Edge.';
  const NO_SEAL = 'This browser cannot challenge a player in private (it has no WebCrypto), so challenging is not available here.';
  /** The part every way in shares (Host, Join, a game from the list, Find a battle): the name, and the team read and judged. -> { mine, tc, name, release } | null (the reason is on the screen) */
  async function prepare(role) {
    const name = cleanName(form.name, role === 'host' ? 'Host' : role === 'guest' ? 'Guest' : 'Player');
    // only a name the player TYPED is remembered for the next visit. The field also fills itself in from the team's owner (nameFollowsTeam) and from the profile (setupForm); remembering THAT made the next
    // visit start with the last team's owner under a different team's name.
    if (form.nameTouched) { try { win.localStorage.setItem(LS_NAME, name); } catch (_e) { /* private mode */ } }
    state.goOff = true; state.quickOff = true; say('Checking your team...');
    const release = () => { state.goOff = false; state.quickOff = false; paint(); };
    const choice = { ...(state.choices.find((c) => c.key === form.teamKey) || state.choices[0]) };
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
    if (!state.role) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    const role = state.role;
    // a host on the plain Play online page always gets a FRESH room (state.room may still hold the code of a join or a room that was just cancelled); the lobby's hand-off names its room in the address
    let room = role === 'host' && boardPage() ? null : state.room;
    if (role === 'guest') { room = (roomFromInput(form.room) || '').trim().toUpperCase(); if (!ROOM_RE.test(room)) { say(room ? 'That is not a room code. A code is 4 to 8 letters and numbers, like K7Q2P.' : 'This page has no room code to join. Open your friend\'s link again.', true); return; } }
    const p = await prepare(role);
    if (!p) return;
    const fmt = role === 'host' ? form.fmt : null;
    if (fmt === '3v3' && p.mine.size < 3) { p.release(); say('A 3v3 battle needs at least 3 Pokemon on your team.', true); return; }
    launch({ role, room, p, fmt, open: false, quick: false, listed: null });
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
    state.locked = true;
    // The host's code is shown only once the room is open (openedRoom): a friend who is handed it earlier would knock on a door that is not there yet.
    // Anything under way can be cancelled until the other player is connected: a join (the board is public, so a listed game may be made up: it used to hold the joiner for the whole watchdog with only
    // the page's Back link as a way out), and a host's room that nobody has come to.
    state.cancel = { shown: true, label: role === 'host' ? (state.quick ? 'Stop looking' : 'Close the room') : 'Cancel' };
    say(role === 'host' ? 'Opening your room...' : state.listed ? 'Joining ' + state.listed.name + '... It gives up after ' + Math.round(joinGiveUpMs() / 1000) + ' seconds if nobody answers; Cancel stops it sooner.' : 'Connecting to the room ' + room + '...');
    setStage('waiting');
  }
  const joinGiveUpMs = () => (query.limits && query.limits.joinMs) || 40000;

  /* ---------------------------------------------------------------------------------------------- open games (the board is js/openlobby.js)
   * A host who switched "Open to anyone" on, or who pressed Find a battle and found nobody, LISTS the game: a small beacon on the public brokers lib/netplay.js already pairs
   * through (a BroadcastChannel for net=local). Everyone who is looking (BATTLE ANYONE, the hub's Trainer Center) sees it and can join with one press. The pairing underneath is unchanged: the joiner still needs the
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
  // NOTHING IS DIALLED BEFORE YES. The board is a topic on third-party public brokers, read with a script from a CDN: dialling it shows them this browser's IP address. A question screen (FIND AN OPPONENT?)
  // that anyone may link to has told the player nothing yet, so the board is dialled by what needs it and nothing else: YES (quick), an accepted challenge's open room, a challenge sent from here.
  // watchBoard() is the same first step quick() takes, for a caller that only wants the list (the page test's challengers; no row of the picture calls it).
  function watchBoard() { if (closed || !supportedHere()) return false; ensureLobbies(); lobbies.startWatching(); return true; }
  /* ---------------------------------------------------------------------------------------------- the view: ONE pure function of a snapshot of the state (online_view.js) */
  function snapshot() {
    const c = choiceNow();
    return { stage: state.stage, role: state.role, room: state.room, codeShown: state.codeShown, open: state.open, quick: state.quick, invite: !!state.invite, admitted: state.admitted, defecting: state.defecting, listedName: state.listed ? state.listed.name : null,
      played: state.matches > 0, starting: state.starting, status: state.status, since: stageAt && UNDER_WAY.includes(state.stage) ? Math.max(0, now() - stageAt) : null, board: boardPage(), ask: state.ask, ignored: !!autoNotice, ready: !!state.choices, canGo: !state.goOff && !state.locked, canQuick: !state.quickOff && !state.locked,
      cancel: state.cancel, link: state.room ? inviteLink() : '', canShare: state.canShare, copied: state.copied, team: c ? { key: c.key, label: c.label, size: c.size || 6 } : null, name: form.name, fmt: form.fmt, bar: state.bar };
  }
  /** What the page shows now, as plain data (online_view.js says what each field is). Changes nothing. */
  const view = () => onlineView(snapshot());
  /** Something the screen shows has changed: the page draws view() again. (The elapsed time changes by itself; the page's own loop draws that.) */
  function paint() { if (hooks.changed) { try { hooks.changed(); } catch (_e) { /* a page that cannot draw must not stop a match */ } } }
  function setStage(s) { paint(); if (hooks.stage) hooks.stage(s); }
  function onBoardChange() { maybeDefect(); refreshOpenNote(); paint(); }
  const joinListed = exclusive(async function joinListed(g) {
    if (state.stage !== 'setup' || !state.choices) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    const p = await prepare('guest');
    if (!p) return;
    const why = whyNot(g, p.mine);
    if (why) { p.release(); say(why, true); return; }
    form.room = g.room;
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
    state.stage = 'asking'; state.locked = true; state.cancel = { shown: true, label: 'Cancel' }; setStage('asking');
    say('Asked ' + g.name + ' to battle. Waiting for an answer...');
    const lim = query.limits || {};
    const timing = lim.chalMs ? { ...PRESENCE_TIMING, answerMs: lim.chalMs, connectMs: lim.chalMs * 2 } : PRESENCE_TIMING;
    asking = createChallenge({
      // (p.rec: this challenge is made BEFORE launch() runs, so state.rec is still the previous attempt's, or null on a fresh page)
      lobbies, target: g, name: p.name, rec: p.rec || null, now, timing, crypto: win.crypto,
      on: {
        state: () => say(g.name + ' accepted. Connecting...'),
        accepted: (room) => { asking = null; setCancel(false); form.room = room; launch({ role: 'guest', room, p, fmt: null, open: false, quick: false, listed: g }); },
        failed: (code) => {
          asking = null; setCancel(false);
          const text = code === 'declined' ? g.name + ' is not available for a battle right now.' : code === 'busy' ? g.name + ' is answering another challenge. Try again in a moment.' : code === 'unsupported' ? NO_SEAL : g.name + ' did not answer.';
          if (lobbies && code !== 'unsupported') lobbies.mute(g.room, 8000);
          reopenSetup(); say(text, true);
        },
      },
    });
  });
  /** Cancel: a challenge that has not been answered, or a join that has not connected (a listed game that never answers, a code nobody opened). Neither can be taken back any other way than leaving the page. */
  function cancelAsk() {
    const tok = viaToken;
    let out = false;
    if (asking) { const a = asking; asking = null; a.cancel(); reopenSetup(); say('Cancelled.'); out = true; }
    else if (state.stage === 'waiting' && state.role === 'guest' && !state.nm && state.session && !closed) { reopenSetup(); say('Cancelled.'); out = true; }
    // a host whose room nobody has come to yet (opening, or open and waiting; a Find-a-battle game too): the room is closed and comes off the list
    else if ((state.stage === 'waiting' || state.stage === 'open') && state.role === 'host' && !state.nm && !closed) { const q = state.quick; quickCtx = null; reopenSetup(); say(q ? 'Stopped looking for an opponent.' : 'Room closed.'); out = true; }
    else if (state.stage === 'searching' && !closed) { reopenSetup(); say('Stopped looking for an opponent.'); out = true; }          // (quick() sees the stage change and stops)
    // THE HUB STARTED THIS (its token; no press on this page): the way out leads back to where the player pressed, not to a question they never saw
    if (out && tok) backToHub();
  }
  /** Leave for the hub (INAPP.md "Contract 6": the screen the player came from, when the hub named one). Nothing is under way any more, or what is under way is given up. */
  function backToHub() {
    if (closed) return;
    clearRecord(); closed = true; stopTick(); closeLobbies(); win.clearTimeout(joinTimer);
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    hooks.toHub();
  }
  /** BACK on a confirm screen. */
  function back() { if (state.stage === 'setup') backToHub(); }
  /** CHANGE TEAM on a confirm screen whose address names a room: the hub's online menu opens its invite screen for that room (team, name, size) and comes back with its token. */
  function changeTeam() { if (state.stage === 'setup' && !closed && state.room && (state.role === 'host' || state.role === 'guest') && hooks.toTeam) hooks.toTeam(state.room, state.role); }
  /** The page was opened by Accept (presence.js): host a game for the player who challenged, with the preferred team (the first saved one, or a random one, when there is none) under the profile's name. */
  const autoStart = exclusive(async function autoStart(profileName) {
    if (!acceptTok || !query.auto) return;            // (only reached with the token; see the top of createOnline)
    setRole('host');
    // the PROFILE speaks for the player here: they were challenged as that trainer (the name on the board), not as whatever was last typed into this browser's name box
    if (profileName) { form.name = cleanName(profileName, 'Host'); form.nameTouched = false; }          // (and that name is the profile's, not one the player typed: prepare() must not remember it as theirs)
    say('Opening a game for the player who challenged you...');
    const p = await prepare('host');
    if (!p) return;                         // the reason is on the screen; pressing Host by hand still works (as a private game)
    const fmt = form.fmt === '3v3' && p.mine.size < 3 ? '6v6' : form.fmt;
    launch({ role: 'host', room: null, p, fmt, open: false, quick: false, listed: null, invite: { for: query.auto.for, rq: query.auto.rq, ck: acceptTok.ck } });
  });
  /** Find a battle: join the game that has waited longest, or, if nobody is waiting, open one and wait. */
  const quick = exclusive(async function quick() {
    if (state.stage !== 'setup' || !state.choices || !boardPage()) return;
    if (!supportedHere()) { say(UNSUPPORTED, true); return; }
    ensureLobbies(); lobbies.startWatching();          // (the board is dialled by what needs it: a page that asked OPEN A ROOM FOR A FRIEND? has not dialled it)
    const p = await prepare('either');
    if (!p) return;
    state.stage = 'searching'; state.locked = true; state.cancel = { shown: true, label: 'Cancel' };
    setStage('searching');
    say('Looking for a player who is waiting...');
    const lim = query.limits || {}, t0 = now();
    // a board that is still connecting has told us nothing yet: wait for it, then give the answers to our ask a moment to arrive
    while (lobbies && lobbies.status() === 'connecting' && now() - t0 < 9000 && !closed) await sleep(120);
    const usable = (g) => g.compatible && !g.h && !whyNot(g, p.mine);          // a resident game has no room to join: it is challenged from the list, not found here
    const pick = () => (lobbies ? lobbies.list().find(usable) || null : null);
    if (lobbies) lobbies.refresh();
    const t1 = now(); let g = pick();
    while (!g && lobbies && now() - t1 < (lim.quickMs !== undefined ? lim.quickMs : 2500) && !closed) { await sleep(100); g = pick(); }
    if (closed || state.stage !== 'searching') return;
    state.stage = 'setup'; paint();
    if (g) { form.room = g.room; launch({ role: 'guest', room: g.room, p, fmt: null, open: false, quick: false, listed: g }); return; }
    if (!lobbies || lobbies.status() === 'down') { reopenSetup(); say('The list of players online could not be reached, so there is nobody to find. Try again later.', true); return; }
    const fmt = form.fmt === '3v3' && p.mine.size < 3 ? '6v6' : form.fmt;
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
    state.codeShown = false;
    state.cancel = { shown: true, label: 'Cancel' };          // a join can be cancelled (cancelAsk)
    state.stage = 'waiting';
    canonicalizeUrl('guest', g.room);
    say('Found a game: joining ' + g.name + '...');
    setStage('waiting');
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
      ? 'That game was just taken by someone else. Try again to find another.'
      : 'That game is not open any more' + (why && why !== 'no answer' ? ' (' + String(why).slice(0, 60) + ')' : '') + '. Try again to find another.';
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
    paint();
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
    stopTick(); if (bar) { bar.remove(); bar = null; }
    state.bar = null; state.codeShown = false;          // (the code of the room that is gone is not shown while the new one is being opened)
    // the words of the match that just ended ("Connection lost. Waiting for the other player...", said when the link dropped under it) are kept for 8 s by flash(); a NEW opponent who connects inside
    // those 8 s would be shown them on a healthy handshake
    flashText = ''; flashUntil = 0;
    state.stage = 'waiting'; state.roomOpen = false;
    const room = Netplay().makeCode(5, 'pokemonarena');
    state.room = room;
    canonicalizeUrl('host', room);
    say(String(why || 'The player did not get as far as a battle.') + ' Opening your game again...');
    setStage('waiting');
    startSession('host', room, state.myTeamCode);
  }

  async function startSession(role, room, teamCode) {
    const N = Netplay();
    // ui: false: lib/netplay.js draws NOTHING on this page (its 'waiting for the host' card and its relay chip are DOM in the system font, outside the picture: INAPP.md 'everything in the app'). Its Allow
    // prompt was never drawn here either (the join-request handler below is registered for every host). What the player needs to know is in the picture (online_view.js) and on #netbar.
    const session = new N.Session({ game: role === 'host' ? GAME_KEY : null, host: role === 'host', code: room, portCount: 2, transport: state.transport, ui: false });
    state.session = session;
    // EVERY ROOM LETS THE FIRST PLAYER IN BY ITSELF. The room code (or the invite link) is what lets somebody in; there is no Allow prompt to answer (the library's own dialog is never shown: this handler
    // is registered for every host). An open (listed) game is the same, for whoever finds it on the board. The player who was let in is remembered by the id they knocked with (req.id, stable across their
    // reloads): a host Session that was REBUILT mid-match (scheduleReconnect), or a host page that was reloaded (the id is kept in the resume record), lets that player back in, and a third player is told
    // the game is taken (presence.js admission()). The moment somebody is let in a listed game comes off the board: nobody else can have the seat.
    if (role === 'host') session.on('join-request', (req) => {
      let verdict = admission({ open: true, invite: state.invite, nm: state.nm, closed, admitted: state.admitted, admittedId: state.admittedId }, req.id);
      // a page reloaded into a match whose record does not name the player who was in (a record from the build before this one): the first to knock is let back in, as the old Allow prompt was answered
      if (verdict === 'deny' && state.nm && !state.admittedId && !state.admitted && !closed) verdict = 'approve';
      if (verdict === 'deny') { req.deny('this game already has a player'); return; }
      if (verdict === 'approve') noteAdmitted(req.id);
      req.approve();
    });
    // THE LIBRARY ADMITS WITHOUT ASKING US in two cases the handler above never sees: a player it already let in (its _known set) who knocks again is re-admitted silently, and then it is the library, not this
    // page, that knows who is in. So the record follows the library's own events: 'room' (a link now exists although nobody asked this page: the seat is taken, the game comes off the board) and
    // 'peer-joined' (this nonce is the player who is in, whichever road it came by: it is what a REBUILT Session must let back in, see admission()).
    if (role === 'host') {
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
        setCancel(false);                  // connected: there is a handshake now, not a wait for somebody who may not be there
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
    state.codeShown = true;
    if (state.open && lobbies) {
      try {
        listGame(room);
        const n = openNote(room); openText = n.text; say(n.text, n.bad);
      } catch (e) { say('Your room is open, but it could not be listed (' + (e && e.message ? e.message : e) + '). A friend can still use the code ' + room + '.', true); }
    } else if (state.invite && lobbies) {
      // tell the challenger the room SEALED to the one-time key they sent (the token carried it here); if it cannot be sealed the room is still open for a friend who is given the code
      if (acceptor) acceptor.stop();
      acceptor = createAcceptor({ lobbies, to: state.invite.for, r: state.invite.rq, room, ck: state.invite.ck, crypto: win.crypto,
        onFail: () => { if (!closed && state.stage === 'open') say('The player who challenged you could not be told your room. A friend can still use the code ' + room + '.', true); } });
      say('Waiting for the player who challenged you to connect.');
    } else say(friendWaitText(room));
    state.canShare = !!(win.navigator && typeof win.navigator.share === 'function');
    setStage('open');
    maybeDefect();
  }
  // (the room code is drawn LARGE over this sentence, with COPY LINK and COPY CODE beside it: the sentence does not spell it again)
  const friendWaitText = (_room) => 'Waiting for your friend. The battle starts by itself when they join.';
  function listGame(room) {
    lobbies.host({ room, name: state.name, fmt: state.fmt, rom: PINNED.sha256, fp: cfg.fingerprint, rs: state.mine.rs, q: state.quick, rec: state.rec || null });
  }
  /** What the host of an OPEN game is told, true to what the board can do right now (a board that lost every broker cannot show the game to anybody). */
  function openNote(room) {
    const st = lobbies ? lobbies.status() : 'down';
    if (st === 'up') return { bad: false, text: openLead + (state.quick ? 'Nobody was waiting, so your game is open: anyone who picks BATTLE ANYONE can join it.' : 'Your game is open: anyone can join it. A friend can also use the code ' + room + '.') };
    if (st === 'connecting') return { bad: false, text: openLead + 'Your game is open, but the list of open games is not connected yet: nobody can see it yet.' };
    return { bad: true, text: openLead + 'Your game is open, but the list of open games cannot be reached: nobody can find it.' };
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
    } else if (!state.invite) say('That player could not connect. Still waiting for your friend.');
    paint();
  }
  /** Somebody is in (the join-request handler let them in, or the library re-admitted them by itself): the seat is taken and the game comes off the board; a host of an open game is told, because "your game is open" is not true now. */
  function noteAdmitted(id) {
    const first = !state.admitted;
    state.admitted = true;
    if (id) state.admittedId = id;
    if (lobbies) lobbies.unhost();
    if (first && !state.nm && state.stage === 'open') {
      openText = '';
      paint();
      say(state.open ? 'A player is joining your game. It is off the list of open games while they connect.' : state.invite ? 'The player who challenged you is connecting...' : 'Someone is joining with your code. Connecting...');
    }
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
    if (/already has a player|full/i.test(w)) return 'That room already has two players. Ask your friend for a new code, or create a room of your own.';
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
    // ... and it says what this page ASKS (ask=host | quick), also when the hub's token started it on the bare address: a reload is then the same question, not a page with nothing to ask
    if (boardPage() && state.ask) { try { const u = new URL(win.location.href); if (u.searchParams.get('ask') !== state.ask) { u.searchParams.set('ask', state.ask); win.history.replaceState(null, '', u.pathname + u.search + u.hash); } } catch (_e) { /* the address stays as it was */ } }
    setCancel(false); state.locked = false; state.goOff = false; state.quickOff = false; state.codeShown = false;
    win.clearTimeout(copiedTimer); state.copied = null;          // (a COPIED that was said for the room that is gone is not said for the next one)
    viaToken = false; state.starting = false;          // (the page is at a question again: whatever is started from it now was started HERE)
    paint();
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
    startBar(); startTick();
    if (!wired) { wired = true; win.addEventListener('pagehide', onPageHide); }
    if (resume) {                      // a reloaded page: the battle is rebuilt from the record (this fires 'controller' with the replayed match, or 'failed')
      state.stage = 'resuming'; setStage('resuming');
      nm.resume(resume.rec);
      return;
    }
    state.stage = 'handshake';
    for (const m of preMsgs.splice(0)) nm.receive(m);
    nm.start();
    say('Connected. Checking the teams...');
    setStage('handshake');
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
    paint();
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
    clearRecord(); stopTick(); closeLobbies(); win.clearTimeout(joinTimer);
    try { if (state.session) state.session.close(); } catch (_e) { /* ignore */ }
    paint();
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
    clearRecord(); closed = true; stopTick(); closeLobbies(); win.clearTimeout(joinTimer);
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
    if (cfg.bar && cfg.bar.parentNode) cfg.bar.parentNode.insertBefore(bar, cfg.bar); else doc.body.append(bar);
    renderBar();
  }
  // THE 250 ms TICK IS THE PROTOCOL'S, NOT THE BAR'S: it runs the match's clocks (nm.tick), tells the other side when this screen can take a choice (screenReady) and times this player out (timeOutSelf).
  // It is started when a match is made and stopped when the match is given up, whatever is or is not drawn: the bar is only one of the things that are painted after it.
  function startTick() { if (!barTimer) barTimer = win.setInterval(tick, 250); }
  function stopTick() { if (barTimer) { win.clearInterval(barTimer); barTimer = 0; } }
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
  /** What the status line says now: worked out from the match (state.bar, view().bar), then painted if the line is on the page. */
  function renderBar() {
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
    state.bar = { who, msg, clock, kind, low: st.myClockMs !== null && st.myClockMs < 15000, phase: st.phase };
    state.last = st;
    paintBar();
  }
  function paintBar() {
    const b = state.bar;
    if (!bar || !b) return;
    const set = (id, v) => { const n = bar.querySelector(id); if (n.textContent !== v) n.textContent = v; };
    set('#nbWho', b.who); set('#nbMsg', b.msg); set('#nbClock', b.clock);
    bar.dataset.kind = b.kind; bar.dataset.low = b.low ? '1' : '';
    bar.dataset.phase = b.phase;
  }
  const reasonText = (why, opp) => ({ forfeit: 'a forfeit.', left: (opp || 'your friend') + ' left.', closed: (opp || 'your friend') + ' left.', timeout: 'out of time.', 'lost-link': 'the connection was lost.' }[why] || 'the match ended early.');

  /* ---------------------------------------------------------------------------------------------- start */
  async function begin() {
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
    // THE PLAIN ADDRESS WITH NOTHING TO START AND NOTHING TO ASK (no token of the hub, no ask=, no challenge named): there is nothing to choose on this page any more. The hub's online menu takes its place.
    if (boardPage() && !state.ask && !autoNotice) { closed = true; state.stage = 'left'; paint(); if (hooks.toMenu) hooks.toMenu(); return; }
    await setupForm();
  }

  /** -> true when the battle is being resumed (the scene is mounted by the match's 'controller' event), false when the page should show the setup form after all. */
  async function resumeFlow(rec) {
    startTok = null; state.starting = false;          // (a start token is for the page load the hub's press led to, never for a battle that is picked up again: a resume that is given up shows the setup form and starts nothing)
    state.stage = 'resuming'; state.role = rec.role; state.room = rec.room; state.name = rec.myName; state.fmt = rec.fmt;
    state.myTeamCode = rec.myTeam; state.oppTeamCode = rec.oppTeam;
    state.profileId = isId(rec.profileId) ? rec.profileId : null;
    // the player this host had let in: a reloaded host lets them (and only them) back in without a prompt (startSession). A record from the build before has none: the first to knock is let in.
    if (rec.role === "host" && typeof rec.admittedId === "string" && rec.admittedId.length > 0 && rec.admittedId.length <= 128) { state.admittedId = rec.admittedId; state.admitted = true; }          // the profile this battle is written to when it ends (a record from an older build, or a damaged one, has none: the career then finds the team's owner itself)
    say('Picking your battle up again...');
    setStage('resuming');
    const giveUp = async (why) => { clearRecord(); state.stage = 'setup'; state.nm = null; await setupForm(); say(why + ' You can start a new battle here.', true); return false; };
    if (!Netplay() || typeof Netplay().supported !== 'function' || !Netplay().supported()) return giveUp('This browser cannot connect two players any more.');
    const [mine, theirs] = await Promise.all([judgeTeamCode(rec.myTeam, pack), judgeTeamCode(rec.oppTeam, pack)]);
    if (!mine.ok || !theirs.ok) return giveUp('Your battle could not be picked up again: a team no longer checks out.');
    state.mine = mine;
    createMatch(rec.role, rec.room, rec.myTeam, { rec, theirs });
    if (state.stage === 'failed') return true;          // nm.resume refused the record: fatal() has said so and cleared it
    startSession(rec.role, rec.room, rec.myTeam);
    return true;
  }

  /** The page is at its question (or starts what a token of the hub asked for): the teams it can play are read, the form is filled from the preferences. Nothing is dialled here: the board waits for YES. */
  async function setupForm() {
    const { choices, name } = await gatherTeams();
    state.choices = choices;
    let saved = ''; try { saved = win.localStorage.getItem(LS_NAME) || ''; } catch (_e) { /* ignore */ }
    // a remembered name is one the player GAVE (prepare() keeps no other): it is theirs, and stays when the team changes. With none, the name is the trainer who owns the team that is pre-selected
    // (the first saved team is the active profile's, but not when that profile has no legal team, or the address brings a team of its own).
    form.nameTouched = !!saved;
    form.name = cleanName(saved || name, query.role === 'guest' ? 'Guest' : 'Host');
    // THE ONLINE PREFERENCES (online_prefs.js, written by the hub's online menu): the preferred team when it is still on the list (a saved team is listed only while it exists and is legal), else the
    // first choice as before; the address's format, else the preferred size, else the default for the team selected. An accepted challenge (autoStart, below) plays with what is selected here.
    let prefs = null; try { prefs = readOnlinePrefs(win.localStorage); } catch (_e) { prefs = null; }
    const pre = preselect(prefs, choices, { formatParam: cfg.formatParam });
    form.teamKey = pre.teamKey;
    nameFollowsTeam();
    form.fmt = pre.fmt;
    refreshFormats();
    if (query.room) { form.room = query.room; state.room = query.room; }
    setRole(query.role || (query.room ? 'guest' : 'host'));
    state.quickOff = false;
    setStage('setup');
    say('');
    // (the Trainer Center's hand-off is honoured two lines down, in a line a test of the Center pins word for word: a join it starts is the hub's too)
    if (!query.auto && !autoNotice && meetTok && state.role === 'guest' && state.room) viaToken = true;
    if (query.auto) { viaToken = true; autoStart(name); } else if (autoNotice) say(autoNotice);
    else if (meetTok && state.role === 'guest' && state.room) { meetTok = false; startAs('guest'); }
    else if (startTok) { const what = startTok; startTok = null; viaToken = true; if (what === 'quick') quick(); else if (what === 'room') go(); else startAs('host'); }
  }

  // THE NAMED ACTIONS (what a press on the page means), view() (what the page shows) and the form (setForm): whatever presents the page calls these, and so does tools/pokemonarena_online_page_test.mjs.
  /** A row of the screen was pressed (the ids are the view's rows: online_view.js). CALLED INSIDE THE KEY OR POINTER HANDLER, and nothing is awaited before the browser's own call: a copy or a share
   *  that no user gesture stands behind may be refused. -> true when the id is one. */
  function act(id) {
    switch (id) {
      // (a press on THIS page: whatever it starts was started here, so its way out comes back to this page's question, not to the hub)
      case 'go': viaToken = false; state.starting = false; void go(); return true;
      case 'host': viaToken = false; state.starting = false; void startAs('host'); return true;
      case 'quick': viaToken = false; state.starting = false; void quick(); return true;
      case 'cancel': cancelAsk(); return true;
      case 'copy-link': void copyLink(); return true;
      case 'copy-code': void copyCode(); return true;
      case 'share': void share(); return true;
      case 'team': changeTeam(); return true;
      case 'back': back(); return true;
      default: return false;
    }
  }
  const gameOf = (x) => (x && typeof x === 'object' ? x : lobbies ? lobbies.list().find((g) => g.room === x) || null : null);
  /** The form, set from outside (what the hub's online menu stores as preferences; a test sets it here because its two players are two tabs of one browser, which share one localStorage). -> the form.
   *  patch: { teamKey (one of the page's team choices), name, typed (the name is one the player gave: it is remembered), fmt, room }. A team is set first, so a name given with it is kept. */
  function setForm(patch) {
    const p = patch || {};
    if (typeof p.teamKey === 'string' && state.choices && state.choices.some((c) => c.key === p.teamKey)) { form.teamKey = p.teamKey; refreshFormats(); nameFollowsTeam(); }
    if (typeof p.name === 'string') { form.name = p.name; if (p.typed) form.nameTouched = true; }
    if (p.fmt === '3v3' || p.fmt === '6v6') form.fmt = p.fmt;
    if (typeof p.room === 'string') form.room = p.room;
    paint();
    return { ...form };
  }
  /** The open games this page can play (the board's list without the ones on another build), as plain data: [{ room, who, fmt, rec, h }]. [] when the page is not on the board. */
  const board = () => (lobbies ? lobbies.list().filter((g) => g.compatible).map((g) => ({ room: g.room, who: g.name, fmt: g.fmt, rec: g.rec || null, h: !!g.h })) : []);
  // (flashNow: the one-line notice the bar would show this instant, '' when there is none; the page test reads it)
  const api = { begin, onResult, leaveToHub, state, nm: () => state.nm, session: () => state.session, flash, flashNow: () => (flashText && now() < flashUntil ? flashText : ''), renderBar, lobbies: () => lobbies, board, watchBoard,
    view, act, setForm, startAs, go, quick, cancel: cancelAsk, copyLink, copyCode, share, changeTeam, back,
    joinListed: (x) => { const g = gameOf(x); return g ? joinListed(g) : undefined; }, challengeResident: (x) => { const g = gameOf(x); return g ? challengeResident(g) : undefined; },
    /** A game of the board, by its room: join it, or ask its owner when it is a resident (a player who is open from the hub). */
    pick: (x) => { const g = gameOf(x); return !g ? undefined : g.h ? challengeResident(g) : joinListed(g); } };
  return api;
}
