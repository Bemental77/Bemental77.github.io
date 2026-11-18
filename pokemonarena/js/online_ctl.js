// pokemonarena/js/online_ctl.js -- PLAY ONLINE's side effects: the only file of the app that stores, navigates or talks to the presence service. boot.js loads it the first time the 'online' screen
// is entered or an effect with `app: 'online'` appears; online_hub.js returns one from its first onData(), so this file is up from the page's load, whatever screen is open
// (pokemonarena/INAPP.md "The app interface": a ctl that must run from the page's load).
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose(), state() }
//
// WHAT IT DOES
//   * OPEN TO BATTLES. It tells the model the status of the hub page's ONE presence service (hub_presence.js) every time that changes, on every screen, and the NAME ITS LISTING CARRIES (the
//     active trainer's: the menu says which name is listed): the PLAY ONLINE row of the main menu then says whether the player is open, and "<name> wants to battle you" is the service's own
//     question, over whatever is on the screen. The switch itself is svc.toggle(): the first ON asks the disclosure in the picture, and nothing is published before its YES.
//   * FROM THE HUB TO THE BATTLE PAGE (INAPP.md "Contract 1"). "An address does not start a game": the one-time token is written into THIS tab first (hub_presence.js battleStart), then the page
//     leaves. INVITE A FRIEND -> START { host }, ?online=1 ... BATTLE ANYONE -> START { quick }, ?online=1 ... JOIN -> MEET { room }, ?np=ROOM&join=1&meet=1 ... OPEN THE ROOM -> START { host, room },
//     ?np=ROOM&host=1. Every one of them is the YES of a question the model asked first (what that page connects to and what it shows of the player): this file only carries the answer out.
//     WHEN THE TOKEN CANNOT BE WRITTEN (the browser blocks the storage) the model says so in the picture and asks GO ON / BACK; GO ON opens the fallback address, where the battle
//     page asks one question itself (?online=1&ask=host, &ask=quick, the plain ?np=ROOM&join=1 / &host=1). It never opens a bare ?online=1 without a token.
//     A TOKEN OF A START THAT DID NOT LEAVE THE PAGE IS TAKEN BACK (a navigation the browser cancelled, a page that comes back from the back / forward cache): the restore removes it at once;
//     otherwise the next thing that reaches this file STALE_MS after the start does (a row pressed, a value changed, PLAY ONLINE left or entered), so it cannot start a battle page the player
//     opens later by hand. Moving the cursor alone reaches nothing here: the token's own age (60 s, presence.js) is then the limit.
//   * THE PREFERENCES (INAPP.md "Contract 2"): TEAM and SIZE through online_prefs.js, the NAME where the battle page reads it (localStorage 'arena.online.name': only a name the player typed).
//     A value that could not be stored is taken back in the picture at once, with the reason: what the menu shows is what the battle page will read.
//   * THE ROOM IN THE PAGE'S OWN ADDRESS (?np=ROOM&join=1 | &host=1: the battle page's CHANGE TEAM row, an old bookmark): the model shows its invite screen; a room that is not one, or both
//     roles, is refused in words and the plain menu is shown. BACK puts the room away: it leaves the address, and a reload of this tab does not bring it back.
//   * THE ROOM CODE A PLAYER TYPES OR PASTES is reduced by the battle page's own function (js/online.js roomFromInput; that file is the battle page's, so it is imported when JOIN A FRIEND is
//     opened, not with this one) and checked against ROOM_RE. The answer goes back to the model WITH THE NUMBER OF THE REQUEST it answers (the join effect's req): the model drops one that is
//     not the request it is waiting on (the player left, the menu gave up, another code was typed since), so a check that comes back late opens nothing.
//
// The pure parts (inviteFromSearch, boardOf, withoutInvite) are exported and run in Node; so does the ctl, on a real hub model with a fake page (tools/pokemonarena_hub_online_test.mjs).

import { hubPresence, battleStart, clearBack } from './hub_presence.js';
import { readOnlinePrefs, writeOnlinePrefs } from './online_prefs.js';
import { ROOM_RE, MQTT_LIB, brokersFor } from './openlobby.js';
import { START_KEY, MEET_KEY } from './presence.js';

export const NAME_KEY = 'arena.online.name';           // localStorage: the name the player typed (js/online.js LS_NAME: the battle page reads it; a test compares the two)
export const TOLD_KEY = 'arena.online.told';           // localStorage: '1' once the player has said YES to the long BATTLE ANYONE notice (the short one is shown from then on)
export const AWAY_KEY = 'arena.online.away';           // sessionStorage: the room of the address that this tab's player put away with BACK
export const GAME_KEY = 'Pokemon Arena';               // js/online.js GAME_KEY: the site lobby names the game in the address (a test compares the two)
export const INVITE_PARAMS = Object.freeze(['np', 'join', 'host', 'meet', 'game']);
/** The words for a room code that is not one: the battle page's own (js/online.js go()). */
export const NOT_A_CODE = 'That is not a room code. A code is 4 to 8 letters and numbers, like K7Q2P.';
export const NO_CODE = 'Type the room code your friend sent you.';
export const NO_ROOM_HERE = 'That room could not be opened from here.';
export const OPEN_FAILED = 'Open to battles could not be switched. Try again.';
export const TOO_LONG = 'Longer than a room code: check it.';
export const STALE_MS = 5000;                           // a start whose page is still here this long after it left for the battle page did not happen: its token is taken back by the next thing that reaches this file (takeBack)

/**
 * The room the HUB page's own address names. -> null (none) | { error } (the battle page's own words: js/online.js parseOnlineQuery, which a test compares this with) | { room, role: 'guest' | 'host' }.
 * A room with no role is an invitation to join, as on the battle page. Never throws.
 */
export function inviteFromSearch(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch (_e) { return null; }
  const np = q.get('np');
  if (np === null) return null;
  if (!ROOM_RE.test(np)) return { error: 'The room code in the address is not a valid room code.' };
  const host = q.get('host') === '1', join = q.get('join') === '1';
  if (host && join) return { error: 'The address asks to both host and join.' };
  const game = q.get('game');
  if (game !== null && game !== GAME_KEY) return { error: 'This address is for a different game.' };
  return { room: np.toUpperCase(), role: host ? 'host' : 'guest' };
}

/** What the BATTLE ANYONE notice names: the public servers the battle page dials (openlobby.js brokersFor: the library's own list, a ?wsbroker= override) and the host its script comes from. */
export function boardOf(win) {
  const host = (u) => { try { return new URL(String(u).split('|')[0]).hostname; } catch (_e) { return ''; } };
  let list = []; try { list = brokersFor(win); } catch (_e) { list = []; }
  return { hosts: [...new Set((Array.isArray(list) ? list : []).map(host).filter(Boolean))], cdn: host(MQTT_LIB) };
}

/** `href` without the room it names (np, join, host, meet, game): the address of the hub page once the invitation has been put away. Everything else (net=local, the #screen) is kept. */
export function withoutInvite(href) {
  const u = new URL(href);
  for (const k of INVITE_PARAMS) u.searchParams.delete(k);
  return u.pathname + u.search + u.hash;
}

export function createCtl(env) {
  const win = env.win, app = env.app, model = env.model;
  const safe = (f, d) => { try { return f(); } catch (_e) { return d; } };
  const storage = env.storage || null, session = env.session || null;
  const redraw = () => safe(() => env.redraw());
  const now = typeof env.now === 'function' ? env.now : () => Date.now();          // (wall clock: a token crosses a page load)
  let svc = null, offSvc = null, woke = false, disposed = false;
  let pending = null;                              // the fallback address a start is waiting to open, while the picture asks GO ON / BACK (the storage is blocked)
  let sentAt = 0;                                  // when this ctl left for the battle page with a token in the tab (0: it has not). A page that is still here long after did not leave
  let tools = null;                                // Promise<js/online.js | null>: roomFromInput

  /* ---- what the browser has stored ---- */
  const readName = () => safe(() => (storage ? storage.getItem(NAME_KEY) || '' : ''), '');
  function writeName(v) {
    return safe(() => {
      if (!storage) return false;
      if (v === null) { storage.removeItem(NAME_KEY); return storage.getItem(NAME_KEY) === null; }
      storage.setItem(NAME_KEY, v); return storage.getItem(NAME_KEY) === v;
    }, false);
  }
  const told = () => safe(() => !!storage && storage.getItem(TOLD_KEY) === '1', false);
  /** The model is told what the browser holds NOW (another tab may have changed it; a write that failed is taken back). */
  function sync() { app.setPrefs(readOnlinePrefs(storage)); app.setName(readName()); app.setSeen(told()); }

  /* ---- OPEN TO BATTLES: the hub page's one presence service ---- */
  function onPresence() { if (disposed || !svc) return; app.setPresence(svc.status(), safe(() => svc.trainer(), null)); redraw(); }          // (trainer(): what the listing says while it is up, else null)
  function presence() {
    if (!svc) {
      svc = hubPresence(env);
      offSvc = svc.onChange(onPresence);
      Promise.resolve(svc.ready).then(onPresence, onPresence);
    }
    return svc;
  }
  function toggleOpen() {
    const s = presence();
    return Promise.resolve(s.toggle()).then(onPresence, (e) => { if (win.console) win.console.warn('[online] open to battles', e); app.say(OPEN_FAILED); onPresence(); });
  }

  /* ---- the room in the page's own address ---- */
  const navType = () => safe(() => { const e = win.performance.getEntriesByType('navigation')[0]; return e && typeof e.type === 'string' ? e.type : 'navigate'; }, 'navigate');
  const awayRoom = () => safe(() => (session ? session.getItem(AWAY_KEY) : null), null);
  function readInvite() {
    const inv = inviteFromSearch(safe(() => win.location.search, ''));
    if (!inv) return;
    if (inv.error) { app.say(inv.error + ' The PLAY ONLINE menu is shown instead.'); if (model.path() === 'main') env.run(model.goto('online')); return; }
    // a room this tab's player put away stays away over a reload or the browser's Back (the address of an older history entry still names it); a fresh arrival with it is a new invitation
    if (navType() !== 'navigate' && awayRoom() === inv.room) return;
    safe(() => { if (session) session.removeItem(AWAY_KEY); });
    if (app.setInvite(inv) && model.path() === 'main') env.run(model.goto('online'));          // (a player who has already walked somewhere else is not pulled away: the invite is up when they open PLAY ONLINE)
  }
  function inviteAway() {
    const inv = inviteFromSearch(safe(() => win.location.search, ''));
    if (!inv || inv.error) return;
    safe(() => { if (session) session.setItem(AWAY_KEY, inv.room); });
    safe(() => win.history.replaceState(win.history.state, '', withoutInvite(win.location.href)));
  }

  /* ---- up: from the first effect (the model's onData, right after the page is up) or the first visit to the screen ---- */
  function wake() {
    if (woke) return;
    woke = true;
    app.setBoard(boardOf(win));
    presence(); onPresence();
    readInvite();
  }

  /* ---- leaving for the battle page ---- */
  function go(url) { pending = null; clearBack(session); sentAt = now(); env.navigate(url); }          // (a battle that was started from this menu comes back to the main menu: INAPP.md "Contract 6")
  /** The page is still here after a start: the token that start left in the tab is stale, and is removed (one-time means the one page load that follows the press). sure: the page WAS left and came back. */
  function takeBack(sure) {
    if (!sentAt || (!sure && now() - sentAt < STALE_MS)) return;          // (a press in the moment between the start and the page going is not "still here")
    sentAt = 0;
    safe(() => { if (session) { session.removeItem(START_KEY); session.removeItem(MEET_KEY); } });
  }
  const onShow = (e) => { if (e && e.persisted) takeBack(true); };
  safe(() => win.addEventListener('pageshow', onShow));
  function start(kind, room, seen) {
    if (seen) safe(() => { if (storage) storage.setItem(TOLD_KEY, '1'); });
    const st = battleStart(kind, room, { session, now: now(), search: safe(() => win.location.search, '') });
    if (!st) { app.say(NO_ROOM_HERE); redraw(); return; }
    if (st.token) { go(st.url); return; }
    // THE TOKEN COULD NOT BE WRITTEN: the battle page will not start by itself. Say so in the picture; GO ON opens the address where that page asks once more (st.url is that address already)
    pending = st.url;
    if (!app.blocked()) go(st.url);
    redraw();
  }

  /* ---- the room code: typed (join) or pasted (paste) ---- */
  function loadTools() {
    if (!tools) tools = import('./online.js').then((m) => (typeof m.roomFromInput === 'function' ? m : null), (e) => { if (win.console) win.console.warn('[online] online.js did not load', e); tools = null; return null; });
    return tools;
  }
  async function join(code, req) {
    const t = await loadTools();
    if (disposed) return;
    const raw = String(code === undefined || code === null ? '' : code);
    const room = String((t ? t.roomFromInput(raw) : raw.replace(/[\s-]+/g, '').toUpperCase().slice(0, 8)) || '');
    // (the MODEL decides whether this answer still counts: it answers request `req`, and only the request the menu is waiting on is heard. Nothing starts here: a room code brings the question
    //  that says what joining connects to, and its YES comes back as a `start`)
    if (!ROOM_RE.test(room)) app.roomRefused(req, room ? NOT_A_CODE : NO_CODE);
    else app.roomTaken(req, room);
    redraw();
  }
  async function paste(text) {
    const t = await loadTools();
    if (disposed) return;
    const raw = String(text || ''), code = t ? t.roomFromInput(raw) : null;
    // (a pasted word longer than a room code is cut to eight characters by that function: the field then holds something the friend did not send, so the entry says so)
    const cut = typeof code === 'string' && !!code && !/[?&]np=/.test(raw) && raw.trim().replace(/[\s-]+/g, '').length > code.length;
    app.roomPasted(typeof code === 'string' && code ? code : null, cut ? TOO_LONG : '');
    redraw();
  }

  return {
    enter() { takeBack(false); wake(); sync(); onPresence(); },
    // (the model closes its own entry and questions: online_hub.js leave. The storage question went with them, so the address it was holding is let go; and a start that never left is stale)
    leave() { pending = null; takeBack(false); },
    effect(eff) {
      if (eff.type !== 'data' && eff.type !== 'dialog') takeBack(false);          // (anything the player does here; a data refresh or a dialog's own answer is not one)
      switch (eff.type) {
        case 'data': wake(); sync(); redraw(); return undefined;
        case 'prefs': {
          const patch = {};
          if ('teamKey' in eff) patch.teamKey = eff.teamKey;
          if ('fmt' in eff) patch.fmt = eff.fmt;
          if (!writeOnlinePrefs(storage, patch)) { sync(); app.notStored(); redraw(); }
          return undefined;
        }
        case 'name': if (!writeName(eff.value)) { sync(); app.notStored(); redraw(); } return undefined;
        case 'open': wake(); return toggleOpen();
        case 'start': return start(eff.kind, eff.room, !!eff.seen);
        case 'join-open': loadTools(); return undefined;
        case 'join': return join(eff.code, eff.req);
        case 'paste': return paste(eff.text);
        case 'invite-away': inviteAway(); return undefined;
        case 'leave': if (pending) go(pending); return undefined;
        case 'stay': pending = null; return undefined;
        default: return undefined;          // (a dialog's answer: the model has already turned it into one of the above)
      }
    },
    dispose() { disposed = true; if (offSvc) safe(() => offSvc()); offSvc = null; safe(() => win.removeEventListener('pageshow', onShow)); },
    /** For tests: { woke, pending, away }. */
    state: () => ({ woke, pending, away: awayRoom() }),
  };
}
