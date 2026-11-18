// pokemonarena/js/hub_presence.js -- THE HUB PAGE'S PRESENCE SERVICE: the ONE place the hub page (index.html) talks to the open-games board (pokemonarena/INAPP.md "Contract 3").
//
//   import { hubPresence } from './hub_presence.js';
//   const svc = hubPresence(env);          // env: what a hub app's ctl is given (INAPP.md "The ctl"), or what boot.js passes. ONE service per page: the first caller makes it, everybody gets the same one
//
// WHY ONE. OPEN TO BATTLES is one switch of the browser, one board connection, one listing and one question at a time. The page (boot.js), the online menu and the Trainer Center all need it, and
// two mounts of presence_boot.js on one page take each other down. So nothing else on the hub page calls mountPresence: they all ask this service.
//
// EVERYTHING IT ASKS IS ASKED IN THE PICTURE, through the hub's dialog layer (hub_dialog.js): ROM message box, ROM window, YES / NO. There is no DOM dialog on the hub page any more.
//   "<NAME> (W-L online) wants to battle you."  + what YES does, YES / NO                  (id 'presence:challenge')
//   the first-time disclosure: what switching on publishes, as message pages, ending YES / NO   (id 'presence:disclosure')
// What the DOM dialogs guaranteed, and where each guarantee lives now (every one has a named check and a source mutant in tools/pokemonarena_hub_presence_test.mjs or the page test):
//   * NO IS THE DEFAULT, and NO IS THE LAST OPTION, so B answers NO from any page (hub_dialog.js: B is the last option).
//   * YES is inert for 600 ms after the question appears (armTicks: DIALOG_ARM_TICKS): the A that was on its way to the menu underneath accepts nothing.
//   * A held direction that only DRIFTED cannot arm A: the dialog layer ignores the repeats of a held direction, so the highlight is still on NO.
//   * One question at a time; a second asker is told busy; a question nobody answers is a NO after 25 s; the asker's cancel closes it: presence.js (unchanged), which calls hide() here.
//   * A hostile name is plain text: it is reduced to the letters a trainer name may have (netmatch.js cleanName) before it reaches the picture, and the dialog layer draws what the ROM font
//     cannot as "?".
//   * YES writes the accept token, THEN navigates; no token = the asker is told busy and the player stays (presence.js accept()).
//   * The disclosure's NO is not remembered, and nothing is published before YES. A stored "on" nobody was told about is dropped (presence_boot.js).
//   * WHILE THE CONTROLS DIALOG OR THE SOUND PANEL (DOM) IS OPEN THE QUESTION WAITS, and appears when the panel closes (it would be drawn under the panel, where it cannot be read or answered).
//     It still counts as a NO on time: the 25 s clock is presence.js's, not the picture's. boot.js says when a panel opens or closes (panels()).
//
// Also here, because they are the hub's half of a hand-off and both the online menu and the Trainer Center need them:
//   * battleStart(kind, room, ...)   INAPP.md "Contract 1": the token a hub press writes and the address it then opens (pure; goBattle() does it and navigates)
//   * writeBack / readBack / clearBack   INAPP.md "Contract 6": sessionStorage 'arena.back', where a battle comes back to. The service clears it when the hub page loads.
//
// The pure parts (the words, the roster, the addresses, the back key) are exported and run in Node; the service itself runs in Node too, on a real hub model with the real presence_boot.js.

import { DIALOG_ARM_TICKS, wrapDialog } from './hub_dialog.js';
import { writeStartToken, writeMeetToken, isOpen } from './presence.js';
import { ROOM_RE } from './openlobby.js';
import { cleanName } from './netmatch.js';

export const CHALLENGE_ID = 'presence:challenge';
export const DISCLOSURE_ID = 'presence:disclosure';
export const NOTE_ID = 'presence:note';
/** The two answers, in the order they are drawn. NO IS LAST: the dialog layer's B answers the last option. */
export const ANSWERS = Object.freeze(['YES', 'NO']);
export const YES = 0, NO = 1;
export const BACK_KEY = 'arena.back';                  // sessionStorage: the hub screen a battle comes back to (INAPP.md "Contract 6")
export const BATTLE_PAGE = '/pokemonarena/battle.html';
/** The test seams of the page's own address that every hop to the battle page carries (only honoured there with net=local). */
export const PASS_PARAMS = Object.freeze(['net', 'anim', 'arenaturn', 'arenagrace', 'openquick', 'openchal', 'openjoin', 'openhold', 'opendisc']);
const SLOT = '__arenaHubPresence';
const BACK_RE = /^[a-z][a-z0-9-]{0,31}$/;

/* ------------------------------------------------------------------------------------------------ pure: the words */

const recText = (rec) => (Array.isArray(rec) && rec.length === 2 && rec.every((n) => Number.isInteger(n) && n >= 0 && n <= 999999) ? ' (' + rec[0] + '-' + rec[1] + ' online)' : '');
const sixPx = (_font, s) => String(s).length * 6;

/**
 * The pages of "<NAME> wants to battle you": who (the name as a trainer name may be written, and their online record when they have one), then what YES does.
 * info: { name, rec: [wins, losses] | null, fmtText: '3 v 3' }; measure(font, s) -> pixels; px: the width of a message line.
 */
export function challengePages(info, measure = sixPx, px = 204) {
  const i = info || {};
  const who = cleanName(i.name, 'Player') + recText(i.rec);
  const fmt = typeof i.fmtText === 'string' && /^[1-6] v [1-6]$/.test(i.fmtText) ? i.fmtText + ' ' : '';
  return [[who, 'wants to battle you.'], ...wrapDialog('YES opens a ' + fmt + 'battle with them and leaves this screen.', measure, px)];
}

/** What switching OPEN TO BATTLES on publishes, and when it stops: said before anything is published. */
export const DISCLOSURE_WORDS = 'Open to battles lists your trainer name and your online record (wins and losses) on public servers. Anyone using Play online can see them and challenge you. '
  + 'Nothing else is shared: no team, no profile. Closing the page or switching it off takes the listing down. It works while this menu or a battle against the computer is open.';
export const DISCLOSURE_ASK = 'Go open to battles?';
/** The room the "more" arrow takes at the right end of a page's second line (hub_screen.js draws it 12 px from the edge): a page that is followed by another is wrapped this much narrower. */
export const MORE_PX = 14;
/** The disclosure as message pages; the LAST page is the question (the options are drawn with it). also: one more sentence a host adds (the Trainer Center: what walking in lists). */
export function disclosurePages(measure = sixPx, px = 204, also = '') {
  const more = typeof also === 'string' && also.trim() ? ' ' + also.trim().slice(0, 200) : '';          // (a host's sentence cannot push the question off the end: the dialog layer takes 16 pages)
  return [...wrapDialog(DISCLOSURE_WORDS + more, measure, px - MORE_PX), [DISCLOSURE_ASK, '']];
}

/* ------------------------------------------------------------------------------------------------ pure: who is open */

/**
 * The board's list (openlobby.js lobbies.list()) as the players a hub screen meets, longest waiting first:
 *   { id (their board id), name, rec: [wins, losses] | null, look (the 7-character look code they list, or null), doing: 'menu' (open from the hub or a CPU battle: ASK them) | 'looking' (they pressed
 *     BATTLE ANYONE and wait in a room: JOIN it) | 'waiting' (any other listed room), room (the room to join, null for 'menu'), fmt, compatible (same game file and engine build), entry (the board's
 *     own record: what challenge() takes) }
 */
export function playersOf(list) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    if (!g || typeof g.s !== 'string' || typeof g.name !== 'string') continue;
    const rec = Array.isArray(g.rec) && g.rec.length === 2 && g.rec.every((n) => Number.isInteger(n) && n >= 0) ? [g.rec[0], g.rec[1]] : null;
    out.push({ id: g.s, name: g.name, rec, look: typeof g.av === 'string' && g.av ? g.av : null, doing: g.h ? 'menu' : g.q ? 'looking' : 'waiting', room: g.h ? null : g.room, fmt: g.fmt, compatible: !!g.compatible, entry: g });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ pure: the way to the battle page and back */

/** '' or '&net=local&openchal=5000': the test seams of `search` (the hub page's own address) that a hop to the battle page carries. */
export function passThrough(search) {
  let q; try { q = new URLSearchParams(search || ''); } catch (_e) { return ''; }
  const p = new URLSearchParams();
  for (const k of PASS_PARAMS) if (q.get(k) !== null) p.set(k, q.get(k));
  const s = p.toString();
  return s ? '&' + s : '';
}

/**
 * THE HUB'S HALF OF "FROM THE HUB TO THE BATTLE PAGE" (INAPP.md "Contract 1"): write the one-time token for what the player pressed into THIS tab, and say which address to open.
 *   kind 'host'    INVITE A FRIEND        START { what: 'host' }         battle.html?online=1                  (the token could not be written: ?online=1&ask=host, where the page asks once)
 *   kind 'quick'   BATTLE ANYONE          START { what: 'quick' }        battle.html?online=1                  (no token: ?online=1&ask=quick)
 *   kind 'room'    OPEN THE ROOM          START { what: 'host', room }   battle.html?np=ROOM&host=1            (no token: the same address, where the page asks)
 *   kind 'join'    JOIN A FRIEND / a game or an accepted challenge of the Trainer Center
 *                                         MEET { room }                  battle.html?np=ROOM&join=1&meet=1     (no token: ?np=ROOM&join=1, the ordinary invite page)
 * o: { session (the tab's sessionStorage, or null), now (wall-clock ms), search (the hub page's own address: its test seams ride along) }
 * -> { url, token: was the token written } | null (not a kind, or `room` is not a room code: nothing is written)
 */
export function battleStart(kind, room, o = {}) {
  const session = o.session || null, now = Number.isFinite(o.now) ? o.now : Date.now(), pass = passThrough(o.search);
  if (kind === 'host' || kind === 'quick') {
    const token = writeStartToken(session, { what: kind }, now);
    return { url: BATTLE_PAGE + '?online=1' + (token ? '' : '&ask=' + kind) + pass, token };
  }
  if (kind !== 'room' && kind !== 'join') return null;
  if (typeof room !== 'string' || !ROOM_RE.test(room)) return null;
  const code = room.toUpperCase();
  if (kind === 'room') return { url: BATTLE_PAGE + '?np=' + code + '&host=1' + pass, token: writeStartToken(session, { what: 'host', room: code }, now) };
  const token = writeMeetToken(session, code, now);
  return { url: BATTLE_PAGE + '?np=' + code + '&join=1' + (token ? '&meet=1' : '') + pass, token };
}

/** Remember the hub screen a battle comes back to (a hub path: [a-z][a-z0-9-]*, not the main menu). Anything else FORGETS it. -> true when it is stored. */
export function writeBack(session, path) {
  try {
    if (!session) return false;
    if (typeof path === 'string' && BACK_RE.test(path) && path !== 'main') { session.setItem(BACK_KEY, path); return session.getItem(BACK_KEY) === path; }
    session.removeItem(BACK_KEY);
    return false;
  } catch (_e) { return false; }
}
/** The hub screen to come back to, or null (none, or a value that is not a hub path: the key is never trusted further than that pattern). The BATTLE page reads it; it does not remove it. */
export function readBack(session) {
  try { const v = session ? session.getItem(BACK_KEY) : null; return typeof v === 'string' && BACK_RE.test(v) && v !== 'main' ? v : null; } catch (_e) { return null; }
}
export function clearBack(session) { try { if (session) session.removeItem(BACK_KEY); return true; } catch (_e) { return false; } }
/** Where a battle that is left for from this hub screen comes back to: the Trainer Center's own screens ('center', 'center-...'); from anywhere else, the main menu (null). */
export function backPathFor(path) { return typeof path === 'string' && (path === 'center' || path.startsWith('center-')) && BACK_RE.test(path) ? path : null; }

/* ------------------------------------------------------------------------------------------------ the service */

/** The page's ONE service: made by the first caller, the same object for everybody after. env: what a hub app's ctl is given (or boot.js's own: see createHubPresence). */
export function hubPresence(env) {
  const win = env && env.win;
  if (!win) throw new Error('hubPresence(env): env.win is missing');
  if (!win[SLOT]) win[SLOT] = createHubPresence(env);
  // the page's hook names the service from the moment it exists, whoever made it: boot.js hands it the answers of its questions and the news of a DOM panel through window.__arenaHub.presence
  if (env.hook && env.hook.presence !== win[SLOT]) env.hook.presence = win[SLOT];
  return win[SLOT];
}

/**
 * env: { win, doc, model (the hub model: its dialog layer and its open path), pack, navigate(url), hook (window.__arenaHub: its dialogOpen() says whether a DOM panel is up, its canvas takes the focus),
 *        ui (battle_ui.js: the ROM font, to wrap the words), session (sessionStorage or null; default win.sessionStorage), redraw() }
 *   and, for boot.js and tests: button (the HTML Open switch, default #openToggle while the page still has one), focusHome(), panelOpen() -> boolean, measure(font, s), msgPx,
 *        loadBoot() -> Promise<presence_boot.js> (default: the dynamic import)
 * -> the service (the API is documented in pokemonarena/INAPP.md "SEAM: as built")
 */
export function createHubPresence(env) {
  const win = env.win, doc = env.doc || null, model = env.model, hook = env.hook || {};
  const safe = (f, d) => { try { return f(); } catch (_e) { return d; } };
  const session = 'session' in env ? env.session : safe(() => win.sessionStorage, null);
  const measure0 = typeof env.measure === 'function' ? env.measure : env.ui && typeof env.ui.measure === 'function' ? (font, s) => env.ui.measure(font, s) : sixPx;
  const measure = (font, s) => { const v = safe(() => measure0(font, s), NaN); return Number.isFinite(v) ? v : sixPx(font, s); };
  const px = Number.isFinite(env.msgPx) ? env.msgPx : env.ui && env.ui.R && env.ui.R.msg ? env.ui.R.msg.w - 4 : 204;
  const panelOpen = () => !!safe(() => (typeof env.panelOpen === 'function' ? env.panelOpen() : typeof hook.dialogOpen === 'function' && hook.dialogOpen()), false);
  const redraw = () => { if (typeof env.redraw === 'function') safe(() => env.redraw()); };
  const focusHome = typeof env.focusHome === 'function' ? env.focusHome : () => { const c = hook.canvas; if (c && !c.hidden) safe(() => c.focus({ preventScroll: true })); };
  const button = 'button' in env ? env.button : doc && typeof doc.getElementById === 'function' ? doc.getElementById('openToggle') : null;
  const loadBoot = typeof env.loadBoot === 'function' ? env.loadBoot : () => import('./presence_boot.js');

  let mount = null, failed = false, disposed = false, offMount = null, wantRoster = false;
  const listeners = new Set();
  const emit = () => { for (const f of [...listeners]) safe(() => f()); };
  // THE QUESTIONS IN HAND, one of each kind at most: { id, pages, arm, shown (it is in the picture), waited (a DOM panel held it back), ... }. In hand is not yet in the picture: place() puts it there.
  const asks = { challenge: null, disclosure: null };

  /* ---- a question goes into the picture, unless a DOM panel covers the picture: then it waits (panels() calls this again when the panel closes) ---- */
  function place(kind) {
    const a = asks[kind];
    if (!a || a.shown || disposed) return;
    if (panelOpen()) { a.waited = true; emit(); return; }
    // a question that waited behind a panel appears as a surprise, like a challenge: it listens only after the arm delay (the key that closed the panel answers nothing)
    const took = model.dialog.open({ id: a.id, pages: a.pages, choice: { options: ANSWERS.slice(), cursor: NO }, armTicks: a.arm || a.waited ? DIALOG_ARM_TICKS : 0 });
    if (!took) { refuse(kind); return; }
    a.shown = true;
    redraw(); emit();
  }
  /** Out of the picture, still in hand (a DOM panel opened over it). */
  function lift(kind) { const a = asks[kind]; if (a && a.shown) { model.dialog.close(a.id); a.shown = false; redraw(); } }
  /** Gone: out of the picture and out of hand. Whoever waits for the disclosure's answer hears "no". */
  function drop(kind) {
    const a = asks[kind];
    if (!a) return;
    lift(kind); asks[kind] = null;
    if (a.settle) for (const f of a.settle.splice(0)) safe(() => f(false));
    emit();
  }
  /** The dialog layer would not take the question (its queue is full): a challenge is answered NO, a disclosure is simply not asked. */
  function refuse(kind) { if (kind === 'challenge') { asks.challenge = null; if (mount) safe(() => mount.decline()); emit(); } else drop(kind); }

  /* ---- what presence_boot.js is handed in place of its DOM dialogs (mountPresence opts.dialogs) ---- */
  const challenge = {
    show(info) {
      lift('challenge');                                                           // (presence.js shows one at a time; if it ever shows another over it, the picture holds the newer one only)
      asks.challenge = { id: CHALLENGE_ID, pages: challengePages(info, measure, px), arm: true, shown: false, waited: false, r: info && info.r, s: info && info.s };
      place('challenge');
      return true;
    },
    hide() { drop('challenge'); },
    isOpen: () => !!asks.challenge,
    destroy() { drop('challenge'); },
  };
  function askDisclosure(onYes, settle, also) {
    const a = asks.disclosure;
    if (a) { if (settle) a.settle.push(settle); return true; }                     // already being asked: the same question, one more listener for its answer
    asks.disclosure = { id: DISCLOSURE_ID, pages: disclosurePages(measure, px, also), arm: false, shown: false, waited: false, onYes, settle: settle ? [settle] : [] };
    place('disclosure');
    return true;
  }
  const disclosure = {
    show(onYes) { return askDisclosure(onYes, null, ''); },
    hide() { drop('disclosure'); },
    isOpen: () => !!asks.disclosure,
    destroy() { drop('disclosure'); },
  };

  /* ---- leaving for the battle page: the screen to come back to is written first (INAPP.md "Contract 6") ---- */
  function leave(url, back) {
    if (back) writeBack(session, back); else clearBack(session);
    env.navigate(url);
  }
  const note = (a, b) => { safe(() => { model.dialog.close(NOTE_ID); model.dialog.open({ id: NOTE_ID, pages: [[a, b || '']], choice: null }); }); redraw(); };

  /* ---- the answers (boot.js hands every dialog answer that has no `app` to answer()) ---- */
  function answer(eff) {
    if (!eff || eff.type !== 'dialog') return false;
    const kind = eff.id === CHALLENGE_ID ? 'challenge' : eff.id === DISCLOSURE_ID ? 'disclosure' : null;
    const a = kind ? asks[kind] : null;
    if (!a || !a.shown) return false;
    asks[kind] = null;                                                             // (the dialog layer has already taken it out of the picture)
    const yes = eff.value === YES;
    if (kind === 'challenge') {
      const p = mount ? mount.pending() : null;
      const mine = !!p && p.r === a.r && p.s === a.s;                              // the question answered is the challenge that is still waiting (not one that was withdrawn in the same instant)
      if (!mine) { /* nothing to answer any more */ }
      else if (!yes) mount.decline();
      else if (!mount.accept()) note('The battle could not be opened:', 'this browser blocks the storage it needs.');          // (the asker was told busy; with the token written, accept() has already navigated)
    } else {
      const done = (v) => { for (const f of a.settle.splice(0)) safe(() => f(!!v)); };
      if (!yes) done(false);                                                       // NO: nothing is published and nothing is remembered; the next switch-on asks again
      else Promise.resolve(safe(() => a.onYes(), false)).then(done, () => done(false));
    }
    emit();
    return true;
  }

  /** boot.js: a DOM panel (the Controls dialog, the Sound panel, the music list) opened or closed. A question in the picture comes out while one is open, and goes (back) in when the last has closed. */
  function panels() {
    const up = panelOpen();
    for (const kind of ['challenge', 'disclosure']) {
      const a = asks[kind];
      if (!a) continue;
      if (up) { if (a.shown) { lift(kind); a.waited = true; emit(); } }
      else place(kind);
    }
  }

  /* ---- the mount ---- */
  function onMount() {
    const l = mount ? mount.lobbies : null;
    if (l) { if (wantRoster && !l.isWatching()) l.startWatching(); else if (!wantRoster && l.isWatching()) l.stopWatching(); }
    emit();
  }
  const ready = Promise.resolve().then(loadBoot).then((m) => {
    if (disposed) return false;
    mount = m.mountPresence({
      win, doc, pack: env.pack, input: env.input, button, focusHome,
      navigate: (url) => leave(url, backPathFor(model.path())),                    // an accepted challenge: a battle accepted in the Trainer Center comes back to the Trainer Center
      dialogs: { challenge, disclosure },
    });
    offMount = mount.onChange(onMount);
    onMount();
    return true;
  }).catch((e) => { failed = true; if (win.console) win.console.warn('[presence] not available', e); emit(); return false; });

  const isOn = () => !!mount && mount.isOn();
  const status = () => (failed ? 'unavailable' : !mount ? 'loading' : mount.status());

  /**
   * Switch OPEN TO BATTLES on. The first time, the disclosure is asked in the picture first: nothing is published before YES, and NO is not remembered.
   * o: { persist = true (false: on for this page only, the stored switch is left as it was: the Trainer Center), also: one more sentence for the disclosure }
   * -> Promise<boolean>: is it on (false: the player said NO, it could not start, or the service is not available)
   */
  function turnOn(o = {}) {
    const persist = o.persist !== false;
    return ready.then((ok) => {
      if (!ok || !mount || disposed) return false;
      if (mount.isOn() || !mount.needsDisclosure()) return mount.setOn(true, { persist });
      return new Promise((res) => { askDisclosure(() => mount.confirmDisclosure({ persist }), res, o.also); });
    });
  }
  /** Switch it off (the listing comes down at once). o: { persist = true }. -> Promise<boolean>: is it off */
  function turnOff(o = {}) {
    const persist = o.persist !== false;
    return ready.then((ok) => (!ok || !mount || disposed ? true : mount.setOn(false, { persist }).then((v) => !v)));
  }

  const svc = {
    /** Promise<boolean>: presence_boot.js is loaded and mounted (false: it could not load; the service then answers 'unavailable' and does nothing). */
    ready,
    /** 'loading' | 'unavailable' | 'off' | 'starting' | 'on' | 'offline' (on, but no public server can be reached: nobody can see the listing). */
    status, isOn, turnOn, turnOff,
    /** What the browser's STORED switch says (localStorage 'arena.open'), whatever this page is doing: a screen that switched on for this page only (turnOn({ persist: false })) switches off again when it
     *  leaves if this is false, and leaves the listing alone if it is true. */
    stored: () => isOpen(safe(() => win.localStorage, null)),
    /** What the Open switch does when it is pressed. -> Promise<boolean>: is it on afterwards */
    toggle() { return ready.then(() => (isOn() ? turnOff().then((off) => !off) : turnOn())); },
    /** Call fn() whenever something a screen may draw has changed: the switch, the board connection, the list of players, a question put or answered. -> unsubscribe */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Keep the list of open players current (the board is then asked who is open, and listings age off it). Off by default: a page that is only open does not need the list. */
    watchPlayers(v) { wantRoster = !!v; onMount(); return wantRoster; },
    /** The open players, longest waiting first (playersOf); [] while the switch is not on. This page's own listing is never among them. */
    players: () => (mount && mount.lobbies ? playersOf(mount.lobbies.list()) : []),
    /** This page's own id on the board (what a Trainer Center walker gives as `b`), or null while the switch is not on. It changes when the switch goes off and on. */
    boardId: () => (mount && mount.lobbies ? mount.lobbies.sid : null),
    /** What this page's listing says: { name, rec: [wins, losses] | null }, or null while the switch is not on. */
    trainer: () => (mount ? mount.trainer() : null),
    /** Can this browser ask anyone? (false: no WebCrypto, so no private way to be told a room.) */
    canChallenge: () => !!mount && mount.canChallenge(),
    /**
     * ASK AN OPEN PLAYER TO BATTLE: player = one of players() with doing 'menu'. handlers: { state(name), accepted(room), failed(why: 'declined' | 'busy' | 'timeout' | 'unsupported') }.
     * -> { r, ready, cancel(), done() } (presence.js createChallenge), or null while the switch is not on. On accepted(room): goBattle('join', room).
     */
    challenge(player, handlers) { const g = player && player.entry ? player.entry : player; return mount && g ? mount.challenge(g, handlers || {}) : null; },
    /** Read the trainer's name and record again (a rename, another profile, a record that was reset) and list again if they changed. -> Promise<boolean>: did the listing change */
    refresh() { return ready.then((ok) => (ok && mount && !disposed ? mount.refresh() : false)); },
    /** Say the listing again as it is NOW (the look changed). */
    relist() { const p = mount ? mount.presence : null; if (p) safe(() => p.refresh()); return !!p; },
    /**
     * LEAVE THE HUB FOR THE BATTLE PAGE (INAPP.md "Contract 1" and "Contract 6"): the one-time token is written, the hub screen to come back to is remembered, then the page navigates.
     * kind / room: battleStart. o: { back }: the hub path the battle comes back to (default: the open screen when it is the Trainer Center's, else the main menu); null = the main menu.
     * -> false (and nothing happens) for a kind that is not one or a room that is not a room code
     */
    goBattle(kind, room, o = {}) {
      const st = battleStart(kind, room, { session, now: Date.now(), search: safe(() => win.location.search, '') });
      if (!st) return false;
      leave(st.url, 'back' in o ? o.back : backPathFor(model.path()));
      return true;
    },
    /** boot.js: a dialog answer with no `app`; a DOM panel opened or closed. */
    answer, panels,
    /** For tests and the hook: { status, on, challenge: null | 'shown' | 'waiting', disclosure: null | 'shown' | 'waiting', players, back }. */
    state: () => ({ status: status(), on: isOn(), challenge: asks.challenge ? (asks.challenge.shown ? 'shown' : 'waiting') : null, disclosure: asks.disclosure ? (asks.disclosure.shown ? 'shown' : 'waiting') : null, players: svc.players().length, back: readBack(session) }),
    /** The presence_boot.js mount itself (window.__arenaPresence), or null before it is ready. */
    get mount() { return mount; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (offMount) safe(() => offMount());
      drop('challenge'); drop('disclosure');
      if (mount) safe(() => mount.dispose());
      mount = null; listeners.clear();
      safe(() => win.removeEventListener('pageshow', onShow));
      if (win[SLOT] === svc) safe(() => { delete win[SLOT]; });
    },
  };
  // THE HUB PAGE IS UP: whatever battle the player came back from, they are back (INAPP.md "Contract 6"). Also when the page is restored from the back / forward cache.
  const onShow = (e) => { if (e && e.persisted) clearBack(session); };
  clearBack(session);
  safe(() => win.addEventListener('pageshow', onShow));
  return svc;
}
