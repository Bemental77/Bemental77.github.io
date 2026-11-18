// tools/pokemonarena_hub_online_test.mjs -- PLAY ONLINE in the hub's picture: pokemonarena/js/online_hub.js (the state machine), online_screen.js (the ROM renderer), online_ctl.js (the side
// effects), and the hunk of hub_model.js that lets an app word its own row of the main menu. pokemonarena/INAPP.md "ONLINE: as built" says what they are.
//
//   node tools/pokemonarena_hub_online_test.mjs                 the Node cases, then the browser sessions (starts ARENA_PORT=8097 node tools/devserver.mjs, one muted headless Chrome at ARENA_CDP)
//   node tools/pokemonarena_hub_online_test.mjs --unit          Node only
//   node tools/pokemonarena_hub_online_test.mjs --unit --mutants   ALSO break the four files one way at a time; every break must fail the case it NAMES (ARENA_HO_MUTANT=<id> runs one)
//   node tools/pokemonarena_hub_online_test.mjs --update        rewrite pokemonarena/online_hub.golden.json (hashes only) after an intended look change
//   node tools/pokemonarena_hub_online_test.mjs --browser [invite anyone open ask blocked address swap devices html]   only the browser sessions (all, or the ones named)
//   node tools/pokemonarena_hub_online_test.mjs --browser --mutants [sessions]   ALSO serve a copy of the game with ONE defect at a time (tools/pokemonarena_overlay.mjs, on ARENA_PORT + 40) and run
//                                                               the session each defect names against it: it must fail the case it names. --only-mutants skips the plain sessions; ARENA_HO_MUTANT=<id> runs one
//   ARENA_OUT=<dir> for the screenshots and, from the Node part, contact sheets of every scene (meant to be opened); ARENA_SKIP_SHOTS=1 to skip them
//
// NODE: nothing is faked below the page. The app runs on a real hub model (hub_model.js, its real dialog layer and text entry), is drawn by the real renderer from the real ROM, and its ctl runs
// against a window double (storage, address, history, navigation recorded). The Trainer Center and the Team Builder are stand-ins (two screens named 'center' and 'builder'): another team builds
// them, and this suite must not depend on what they become. The presence service is a double for the wiring cases and THE REAL ONE (hub_presence.js, presence_boot.js, presence.js and the board
// over Node's BroadcastChannel, the transport net=local uses) for the cases about what is published.
//   M  the menu: its rows, the scroll, the pointer, the trail; the cursor a visit starts on      T  TEAM and SIZE: the battle page's own list and order, the preferences, a team that is gone, no team
//   N  NAME: the battle page's rule, the entry, what is stored; WHICH NAME IS WHERE (the name typed against the trainer's name that OPEN TO BATTLES lists)
//   Q  BATTLE ANYONE: the notice (the name that is listed, by name), NO first, nothing starts before YES, only YES starts
//   H  INVITE A FRIEND: nothing leaves before the picture has said what the battle page connects to; the long notice once per browser, then one page
//   J  JOIN A FRIEND: the code typed, a wrong code, a pasted link; the question after the check (armed); A ROOM CODE IS ONE NUMBERED REQUEST (an answer to an older one is dropped)
//   O  OPEN TO BATTLES: the row (which name, where), the main menu's row, up from the page's load; with the real service: the disclosure, NO not remembered, nothing published before YES,
//      and the name in the row is the name the board hears
//   I  the room in the page's own address: the invite screens (THEY APPEAR BY THEMSELVES: armed, the cursor on TEAM, the button asks), a malformed room, BACK puts it away
//   B  the browser blocks the storage: said in the picture, the fallback addresses, never a bare ?online=1; a token of a start that did not leave
//   W  the words and the pictures: every line in its window (with the widest name), every row in its row, every notice clear of the "more" arrow, every screen opaque and equal to its golden hash
//   S  the shell's hunk: an app words its own row of the main menu       X  what the files are (pure, no DOM) and that the HTML row is gone
// BROWSER (tools/headless_cdp.mjs: headless, muted, a throwaway profile; two tabs of one browser, net=local). The hub is driven through window.__arenaHub and real keys, taps and a synthetic
// controller; the battle page ONLY through its hooks (window.__arenaOnline, window.__arenaBattle) and what the tokens start, never through its DOM ids (that page's panel is being replaced).
//   invite   INVITE A FRIEND in one tab and JOIN A FRIEND by the typed code in the other end in a battle on both screens, with the team chosen and the name typed; neither leaves before
//            the picture has said what the battle page connects to, and the board hears nothing meanwhile
//   anyone   BATTLE ANYONE in both tabs pairs them; nothing is on the board before the notice's YES; the name the notice named is the name the board then hears
//   open     OPEN TO BATTLES asks once, NO is not remembered; stored on = listening from the page's load on every screen; the main menu says so; the row says which name is listed (the
//            trainer's, not the one typed on the NAME row) and the board hears that name
//   ask      "<name> wants to battle you" on the main menu, on a Tower screen and inside a text entry
//   blocked  sessionStorage refuses writes: the picture says so, GO ON opens the fallback address, the battle page starts nothing by itself
//   address  the invite screens from the hub's own address; a malformed room; BACK and a reload
//   swap     the invite screen takes the menu's place BY ITSELF: real keys pressed 0 to 450 ms after the hub became usable start nothing (the review's finding: a link plus one press joined)
//   devices  a touch-only phone and a controller reach every row
//   html     the page has no online control: #onlineLink and its three children are gone, nothing creates them, and the picture has the rows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRom, fnv } from './pokemonarena_hub_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const GOLDEN = path.join(root, 'pokemonarena', 'online_hub.golden.json');
const ARGS = process.argv.slice(2);
const WANT_MUTANTS = ARGS.includes('--mutants'), UPDATE = ARGS.includes('--update'), BROWSER_ONLY = ARGS.includes('--browser'), UNIT_ONLY = ARGS.includes('--unit') || UPDATE || (WANT_MUTANTS && !BROWSER_ONLY);
const ONE = process.env.ARENA_HO_MUTANT || '';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name + (detail !== undefined && detail !== '' ? ' :: ' + String(detail).slice(0, 400) : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail !== undefined ? String(detail).slice(0, 400) : ''); } }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(5); return !!cond(); };
const within = (p, ms = 6000) => Promise.race([p, new Promise((r) => setTimeout(() => r('NEVER SETTLED'), ms))]);
const rom = readRom();
const CHANNEL = 'bemental-arena-open-1';

/* ------------------------------------------------------------------------------------------------ doubles */
const memStorage = (init = {}, o = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { if (o.blocked) throw new Error('storage is blocked'); store[k] = String(v); }, removeItem: (k) => { if (o.blocked) throw new Error('storage is blocked'); delete store[k]; } }; };
/** A window double: storage, an address the history can rewrite, how the page was reached, listeners, the same-browser transport. */
function makeWin(o = {}) {
  const ls = new Map();
  const loc = { origin: 'http://x', pathname: '/pokemonarena/', search: o.search === undefined ? '?net=local' : o.search, hash: o.hash || '', assign() {} };
  Object.defineProperty(loc, 'href', { get: () => loc.origin + loc.pathname + loc.search + loc.hash });
  const win = {
    location: loc, replaced: [],
    history: { state: { arenaHub: 'main', trail: [] }, replaceState(st, _t, url) { const u = new URL(url, loc.origin); loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; win.history.state = st; win.replaced.push(String(url)); } },
    localStorage: o.noLocal ? null : memStorage(o.local, { blocked: !!o.localBlocked }), sessionStorage: o.noSession ? null : memStorage(o.session, { blocked: !!o.sessionBlocked }),
    performance: { now: () => performance.now(), getEntriesByType: (t) => (t === 'navigation' ? [{ type: o.navType || 'navigate' }] : []) },
    crypto: globalThis.crypto, BroadcastChannel: globalThis.BroadcastChannel,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
    console: { warn() {}, error() {}, log() {} },
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener(t, f) { if (ls.has(t)) ls.get(t).delete(f); },
    listeners: (t) => [...(ls.get(t) || [])],
  };
  return win;
}
const makeDoc = () => ({ hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} });
/** A screen that does nothing but exist (the Trainer Center, the Team Builder: built by other teams). B goes back. `extra`: more members (S: a mainRow of its own). */
const fakeApp = (id, extra = {}) => {
  const desc = { id, paths: Object.freeze([id]), parent: () => 'main', create: (c) => ({ id, paths: desc.paths, parent: desc.parent, enter() {}, leave() {}, press: (_p, a) => (a === 'b' ? c.back() : []), hit: () => null, pointer: () => [], rects: () => [], tick() {}, view: (_p, base) => ({ ...base }), onData() {}, wantsText: () => false, type: () => [], speak: () => '', title: () => 'Fake', state: () => ({}), ...extra }) };
  return Object.freeze(desc);
};
/** The presence service as the ctl sees it, for the wiring cases: a status that can be set, a toggle that is counted (s.fail: it rejects), a listing that can be set (s.listing: what trainer() answers while on). */
function fakeSvc(status) {
  const ls = new Set(), s = { status, toggles: 0, fail: false, listing: null };
  const emit = () => { for (const f of [...ls]) f(); };
  const isOn = () => ['on', 'starting', 'offline'].includes(s.status);
  return { s, ready: Promise.resolve(true), status: () => s.status, isOn, onChange(fn) { ls.add(fn); return () => ls.delete(fn); }, listeners: () => ls.size, trainer: () => (isOn() ? s.listing : null),
    toggle() { s.toggles++; if (s.fail) return Promise.reject(new Error('the switch broke')); s.status = s.status === 'off' ? 'on' : 'off'; emit(); return Promise.resolve(s.status === 'on'); }, set(v) { s.status = v; emit(); }, answer: () => false, panels() {}, dispose() {} };
}

/* ------------------------------------------------------------------------------------------------ fixtures */
const team = (id, name, size, lead, names, legal = true) => ({ id, name, size, legal, problems: legal ? 0 : 2, names: names || ['Pikachu', 'Charizard', 'Blastoise', 'Venusaur', 'Lapras', 'Snorlax'].slice(0, size), lead: { species: lead, shiny: false, gender: null }, ruleset: 'arena-gen3-standard' });
const W10 = 'WWWWWWWWWW';
const DATA = Object.freeze({ state: 'ready', activeId: 'p1', profiles: [
  { id: 'p1', name: 'RED', readOnly: false, teams: [team('t1', 'Rain Dance', 6, 6), team('t2', 'WWWWWWWWWWWWWWWW', 6, 9, [W10, W10, W10, W10, W10, W10]), team('t3', 'Duo', 2, 150), team('t4', 'Broken', 6, 3, null, false)], record: null, tower: null },
  { id: 'p2', name: 'Blue', readOnly: false, teams: [team('u1', 'Sun', 4, 3)], record: null, tower: null },
] });
const NO_TEAMS = Object.freeze({ state: 'ready', activeId: null, profiles: [] });
const UNAVAILABLE = Object.freeze({ state: 'unavailable', activeId: null, profiles: [] });          // the browser's storage could not be opened
/** The same data with the widest trainer name there is (ten capitals) on the active profile: every line that names the name that is listed is measured with it. */
const WIDE_TRAINER = Object.freeze({ ...DATA, profiles: [{ ...DATA.profiles[0], name: W10 }, DATA.profiles[1]] });
const K = { t1: 'saved:p1:t1', t2: 'saved:p1:t2', t3: 'saved:p1:t3', u1: 'saved:p2:u1', random: 'random' };
/** The battle page's own team list for this data (js/online.js gatherTeams, written out again here: the saved LEGAL teams, the active trainer's first, a random team, a pasted code). */
function battleList(d) {
  const out = [], ps = d.profiles.slice().sort((a, b) => (a.id === d.activeId ? -1 : 0) - (b.id === d.activeId ? -1 : 0));
  for (const p of ps) for (const t of p.teams) if (t.legal) out.push({ key: 'saved:' + p.id + ':' + t.id, size: t.size, trainer: p.name });
  out.push({ key: 'random', size: 6 }, { key: 'paste', size: 6 });
  return out;
}
const MENU_IDS = ['center', 'anyone', 'invite', 'join', 'team', 'size', 'name', 'open', 'back'];

/* ------------------------------------------------------------------------------------------------ the modules, from the real tree or from a copy with one defect */
let SHARED = null;          // the ROM renderer and the ROM tables: made once, from the real tree (a mutant changes none of the files they are made of)
async function shared() {
  if (SHARED) return SHARED;
  const imp = (f) => import(pathToFileURL(path.join(SRC, f)).href);
  const [HS, B, T, OM, R] = await Promise.all(['hub_screen.js', 'battle_ui.js', 'tables.js', 'online_match.js', 'rom.js'].map(imp));
  const ui = B.createBattleUi(rom), pack = T.loadPack(rom, { verify: 'header', dexText: false });
  SHARED = { HS, ui, pack, fp: OM.engineFingerprint(pack), romSha: R.PINNED.sha256 };
  return SHARED;
}
async function load(dir) {
  const sh = await shared();
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [HM, O, OS, C, HP, P, ON, NM, OL, PR, HD] = await Promise.all(['hub_model.js', 'online_hub.js', 'online_screen.js', 'online_ctl.js', 'hub_presence.js', 'presence.js', 'online.js', 'netmatch.js', 'openlobby.js', 'online_prefs.js', 'hub_dialog.js'].map(imp));
  const screen = sh.HS.createHubScreen(sh.ui, { appScreens: { online: OS.createScreen } });
  return { ...sh, dir, HM, O, OS, C, HP, P, ON, NM, OL, PR, HD, screen, boot: () => imp('presence_boot.js') };
}

/* ------------------------------------------------------------------------------------------------ one hub page */
/**
 * o: { search, hash, local, session, noLocal, noSession, localBlocked, sessionBlocked, navType, data (default DATA; null = none yet), svc: 'fake' (default) | 'real' | 'none' (no ctl at all: the
 *      model alone), status (the fake service's), apps (more stand-in apps) }
 * The effects are carried out the way boot.js run() does: an app's go to its ctl in order (the ctl is made by the first), a screen change tells the ctl of the family entered or left, a dialog
 * answer nobody's app asked for goes to the presence service.
 */
function world(M, o = {}) {
  const win = makeWin(o), doc = makeDoc();
  const hub = M.HM.createHubModel({ mascot: 25, env: 0, measure: M.screen.measure, msgPx: M.screen.msgPx, measureFont: M.screen.measureFont, apps: [M.O.APP, fakeApp('center'), fakeApp('builder')].concat(o.apps || []) });
  const w = { win, doc, hub, app: hub.apps.online, nav: [], fx: [], redraws: 0, errors: [], pending: [], ctl: null, svc: null, clock: Date.now() };
  const mode = o.svc || 'fake';
  if (mode === 'fake') { w.svc = fakeSvc(o.status || 'off'); win.__arenaHubPresence = w.svc; }
  const get = (st, k) => { try { return st ? st.getItem(k) : null; } catch (_e) { return null; } };
  w.env = { win, doc, hook: { dialogOpen: () => false }, model: hub, app: w.app, pack: M.pack, ui: M.ui, rom, input: null, storage: win.localStorage, session: win.sessionStorage, loadBoot: M.boot,
    navigate: (url) => { w.nav.push({ url, start: get(win.sessionStorage, M.P.START_KEY), meet: get(win.sessionStorage, M.P.MEET_KEY), back: get(win.sessionStorage, M.HP.BACK_KEY) }); },
    store: () => null, whenStore: async () => null, refreshData: async () => {}, freshSeed: () => 1, now: () => w.clock, sound: { sfx: () => false, music: () => false, system: () => null },
    redraw: () => { w.redraws++; }, run: (fx) => w.run(fx) };
  let family = null, familyPath = null;
  const toCtl = (what, arg) => {
    if (mode === 'none') return;
    if (!w.ctl) w.ctl = M.C.createCtl(w.env);
    if (mode === 'real' && !w.svc) w.svc = win.__arenaHubPresence || null;
    let r; try { r = w.ctl[what](arg); } catch (e) { w.errors.push(what + ': ' + String(e && e.message ? e.message : e)); return; }
    if (r && typeof r.then === 'function') w.pending.push(r.then(null, (e) => { w.errors.push(what + ': ' + String(e && e.message ? e.message : e)); }));
  };
  const syncFamily = () => { const p = hub.path(), now = p === 'online' ? 'online' : null; if (now === family) { familyPath = p; return; } if (family) toCtl('leave', familyPath); family = now; familyPath = p; if (now) toCtl('enter', p); };
  w.run = (fx) => {
    for (const e of fx || []) {
      if (!e) continue;
      if (typeof e.app === 'string') { w.fx.push(e); if (e.app === 'online') toCtl('effect', e); continue; }
      if (e.type === 'screen') syncFamily();
      else if (e.type === 'dialog' && w.svc) w.svc.answer(e);
    }
    syncFamily();
    return fx || [];
  };
  w.press = (a, info) => w.run(hub.press(a, info));
  w.type = (input) => w.run(hub.type(input));
  w.typeText = (s) => { for (const ch of String(s)) w.type({ text: ch }); };          // a real keyboard: one key at a time (more than one character at once is a PASTE)
  w.click = (x, y) => w.run(hub.pointer({ kind: 'click', x, y }));
  w.move = (x, y) => w.run(hub.pointer({ kind: 'move', x, y }));
  w.wheel = (steps) => w.run(hub.pointer({ kind: 'wheel', steps }));
  w.tick = (n = 1) => { for (let i = 0; i < n; i++) w.run(hub.tick()); };
  w.data = (d) => w.run(hub.setData(d));
  w.goto = (p) => w.run(hub.goto(p));
  w.arrive = (p, trail) => w.run(hub.arrive(p, trail));          // the browser's Back / Forward landed on that screen
  w.idle = async () => { for (let i = 0; i < 20 && w.pending.length; i++) await within(Promise.all(w.pending.splice(0))); await sleep(0); };
  w.st = () => w.app.state();
  w.view = () => hub.view();
  w.q = () => hub.dialog.current();
  w.rowsShown = () => (hub.view().menu || { rows: [] }).rows.map((r) => r.id);
  w.row = (id) => w.app.allRows().find((r) => r.id === id) || null;
  w.msg = () => (hub.view().msg || []).join(' | ');
  w.effects = (type) => w.fx.filter((e) => e.type === type);
  /** Every page of the dialog that is up, from the page it is on: [[line, line], ...]; it ends on the last page (the question), unanswered. (A dialog that is not armed yet turns no page: w.arm() first.) */
  w.pages = () => { const out = []; for (let i = 0; i < 40; i++) { const d = hub.view().dialog; if (!d) break; out.push(d.lines.slice()); if (!d.more) break; w.press('a'); } return out; };
  /** Let the arm delay of whatever appeared by itself pass (a dialog that came late, the invite screen): 40 frames. */
  w.arm = () => w.tick(40);
  /** Answer the question that is up with its FIRST option (YES / GO ON), the long way: the pages are read to the end, the d-pad goes to the first option, A. -> the pages that were read */
  w.yes = () => { const pages = w.pages(); const d = hub.dialog.current(); for (let i = 0; d && d.choice && i < d.choice.cursor; i++) w.press('up'); w.press('a'); return pages; };
  /** Every line of these dialog pages fits its box: a page that is followed by another leaves the room of the "more" arrow. */
  w.fits = (pages, more) => pages.every((p, i) => p.every((ln) => M.screen.measure(ln) <= (i < pages.length - 1 ? M.screen.msgPx - more : M.screen.msgPx)));
  w.end = () => { try { if (w.ctl) w.ctl.dispose(); } catch (_e) { /* ignore */ } try { if (mode === 'real' && win.__arenaHubPresence) win.__arenaHubPresence.dispose(); } catch (_e) { /* ignore */ } };
  if (o.data !== null) w.data(o.data || DATA);
  return w;
}
const tokenOf = (M, raw) => M.P.takeStartToken(memStorage(raw === null ? {} : { [M.P.START_KEY]: raw }), Date.now());
const queryOf = (M, url) => M.ON.parseOnlineQuery(new URL(url, 'http://x').search);
/** What the battle page does with the address a start opened and the token it left: 'host' | 'room' | 'quick' (presence.js startPlan), 'join' (a fresh MEET token for the room of a join address), or null. */
function honoured(M, n) {
  if (!n) return null;
  const q = queryOf(M, n.url);
  if (q && !q.error && q.meet && q.role === 'guest') return M.P.takeMeetToken(memStorage(n.meet === null ? {} : { [M.P.MEET_KEY]: n.meet }), q.room, Date.now()) ? 'join' : null;
  return M.P.startPlan(tokenOf(M, n.start), q);
}

/* ------------------------------------------------------------------------------------------------ the scenes: every screen and state of the app, each a named picture */
function scenes(M) {
  const mk = (o) => { const w = world(M, o); if (w.svc && w.svc.s) w.svc.set((o && o.status) || 'off'); return w; };
  const at = (w, id) => { if (w.hub.path() !== 'online') w.goto('online'); w.app.select(id); return w; };
  const list = [];
  const add = (name, make) => list.push({ name, make });
  for (const id of MENU_IDS) add('menu-' + id, () => at(mk(), id));
  add('team-wide', () => { const w = at(mk(), 'team'); w.press('right'); return w; });
  add('team-duo', () => { const w = at(mk(), 'team'); w.press('right'); w.press('right'); return w; });
  add('size-fixed', () => { const w = at(mk(), 'team'); w.press('right'); w.press('right'); w.app.select('size'); return w; });
  add('team-other-trainer', () => { const w = at(mk(), 'team'); w.press('left'); w.press('left'); return w; });
  add('team-random', () => { const w = at(mk(), 'team'); w.press('left'); return w; });
  add('no-team', () => at(mk({ data: NO_TEAMS }), 'team'));
  add('no-name', () => at(mk({ data: NO_TEAMS }), 'name'));
  add('team-unavailable', () => at(mk({ data: UNAVAILABLE }), 'team'));
  add('loading', () => at(mk({ data: null }), 'team'));
  add('name-typed-wide', () => at(mk({ local: { 'arena.online.name': W10 }, data: WIDE_TRAINER }), 'name'));
  add('anyone-wide', () => at(mk({ local: { 'arena.online.name': W10 } }), 'anyone'));
  add('center-wide', () => at(mk({ data: WIDE_TRAINER }), 'center'));
  add('open-off-wide', () => at(mk({ data: WIDE_TRAINER }), 'open'));
  add('open-on', () => at(mk({ status: 'on' }), 'open'));
  add('open-on-wide', () => at(mk({ status: 'on', data: WIDE_TRAINER }), 'open'));
  add('open-starting', () => at(mk({ status: 'starting' }), 'open'));
  add('open-offline', () => at(mk({ status: 'offline' }), 'open'));
  add('open-unavailable', () => at(mk({ status: 'unavailable' }), 'open'));
  add('entry-name-hint', () => { const w = at(mk(), 'name'); w.press('a'); return w; });
  add('entry-name', () => { const w = at(mk(), 'name'); w.press('a'); w.typeText('Ash'); return w; });
  add('entry-name-refused', () => { const w = at(mk(), 'name'); w.press('a'); w.typeText('Ash,K'); w.type({ key: 'enter' }); return w; });
  add('entry-room', () => { const w = at(mk(), 'join'); w.press('a'); w.typeText('K7Q2P'); return w; });
  add('quick-notice', () => { const w = at(mk(), 'anyone'); w.press('a'); return w; });
  add('quick-question', () => { const w = at(mk(), 'anyone'); w.press('a'); w.pages(); return w; });
  add('friend-notice', () => { const w = at(mk(), 'invite'); w.press('a'); return w; });
  add('friend-question', () => { const w = at(mk(), 'invite'); w.press('a'); w.pages(); return w; });
  add('friend-short', () => { const w = at(mk({ local: { 'arena.online.told': '1' } }), 'invite'); w.press('a'); return w; });
  add('join-question-unarmed', () => { const w = at(mk({ local: { 'arena.online.told': '1' } }), 'join'); w.press('a'); w.typeText('WWWWWWWW'); w.hub.type({ key: 'enter' }); w.app.roomTaken(w.st().req, 'WWWWWWWW'); return w; });
  add('note-refused', () => { const w = at(mk(), 'join'); w.press('a'); w.typeText('AB'); w.hub.type({ key: 'enter' }); w.app.roomRefused(w.st().req, M.C.NOT_A_CODE); w.arm(); return w; });
  add('note-bad-room', () => { const w = mk({ search: '?np=AB!CD&join=1&net=local' }); w.arm(); return w; });
  add('blocked-question', () => { const w = at(mk(), 'invite'); w.app.blocked(); w.arm(); w.pages(); return w; });
  add('invite-guest-unarmed', () => mk({ search: '?np=k7q2p&join=1&net=local' }));
  add('invite-guest', () => { const w = mk({ search: '?np=k7q2p&join=1&net=local' }); w.arm(); return w; });
  add('invite-guest-go', () => { const w = mk({ search: '?np=k7q2p&join=1&net=local' }); w.arm(); w.app.select('go'); return w; });
  add('invite-guest-question', () => { const w = mk({ search: '?np=k7q2p&join=1&net=local', local: { 'arena.online.told': '1' } }); w.arm(); w.app.select('go'); w.press('a'); return w; });
  add('invite-host', () => { const w = mk({ search: '?np=WWWWWWWW&host=1&net=local' }); w.arm(); w.app.select('go'); return w; });
  add('invite-host-size', () => { const w = mk({ search: '?np=WWWWWWWW&host=1&net=local' }); w.arm(); w.app.select('size'); return w; });
  add('main-open', () => { const w = mk({ status: 'on' }); w.hub.press('down'); w.hub.press('down'); return w; });
  add('main-offline', () => { const w = mk({ status: 'offline' }); w.hub.press('down'); w.hub.press('down'); return w; });
  return list;
}

/* ------------------------------------------------------------------------------------------------ the cases */
async function suite(M, tag, only) {
  const T = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const want = (g) => !only || only.includes(g);
  const { O, C, P, HP, PR, NM, OL, ON } = M;
  const worlds = [];
  const mk = (o) => { const w = world(M, o); worlds.push(w); return w; };
  const online = (o) => { const w = mk(o); w.goto('online'); return w; };
  const at = (w, id) => { w.app.select(id); return w; };
  const lastOf = (a) => a[a.length - 1];

  /* ---- M: the menu ---- */
  if (want('M')) {
    const w = online();
    const v = w.view();
    ok(J(w.app.allRows().map((r) => r.id)) === J(MENU_IDS) && J(w.rowsShown()) === J(MENU_IDS.slice(0, 8)) && v.menu.total === 9 && v.menu.down === true && v.menu.up === false && v.menu.cursor === 0 && w.hub.path() === 'online' && J(w.hub.trail()) === J(['online']),
      T('M1 PLAY ONLINE opens the menu: nine rows (TRAINER CENTER, BATTLE ANYONE, INVITE A FRIEND, JOIN A FRIEND, TEAM, SIZE, NAME, OPEN TO BATTLES, BACK), eight shown, the ROM arrow says there is more below'), J([w.rowsShown(), v.menu.total, v.menu.down]));
    for (let i = 0; i < 8; i++) w.press('down');
    const v2 = w.view();
    ok(w.st().row === 'back' && v2.menu.offset === 1 && v2.menu.up === true && v2.menu.down === false && J(w.rowsShown()) === J(MENU_IDS.slice(1)) && v2.menu.cursor === 7, T('M2 the ninth row scrolls into view under the cursor (the list moves by one, the arrow now points up)'), J([w.st().row, v2.menu.offset, w.rowsShown()]));
    w.press('down');
    ok(w.st().row === 'center' && w.view().menu.offset === 0, T('M3 down from the last row wraps to the first (and the list is back at its top)'), J(w.st()));
    w.press('up');
    ok(w.st().row === 'back' && w.view().menu.offset === 1, T('M3 up from the first row wraps to the last'), J(w.st()));
    at(w, 'center'); w.press('a');
    ok(w.hub.path() === 'center' && J(w.hub.trail()) === J(['online', 'center']), T('M4 TRAINER CENTER opens the Trainer Center on top of the menu'), w.hub.path() + ' ' + J(w.hub.trail()));
    w.press('b');
    ok(w.hub.path() === 'online', T('M4 ... and B there comes back to the menu'), w.hub.path());
    w.press('b');
    ok(w.hub.path() === 'main', T('M5 B on the menu goes back to the main menu'), w.hub.path());
    w.goto('online'); at(w, 'back'); w.press('a');
    ok(w.hub.path() === 'main', T('M5 ... and so does the BACK row'), w.hub.path());
    // the pointer
    w.goto('online'); at(w, 'center');
    const rects = w.hub.rects();
    ok(rects.length === 8 && J(rects.map((r) => r.id)) === J(MENU_IDS.slice(0, 8)) && rects.every((r) => r.h === 12 && r.w === O.OGEOM.menu.w + 8), T('M6 rects() are the eight rows shown, 12 px each'), J(rects.map((r) => [r.id, r.y, r.h])));
    w.move(rects[3].x + 30, rects[3].y + 5);
    ok(w.st().row === 'join' && w.hub.path() === 'online' && !w.hub.wantsText(), T('M6 a pointer over a row moves the cursor there and does nothing else'), J(w.st()));
    ok(w.hub.hit(rects[3].x + 30, rects[3].y + 5) && w.hub.hit(200, 60) === null && w.hub.hit(rects[0].x + 30, rects[7].y + 14) === null, T('M6 hit() is truthy on a row and null beside and below the list'), '');
    w.wheel(1);
    ok(w.st().row === 'team', T('M6 the wheel moves the cursor one row'), w.st().row);
    w.wheel(4);
    ok(w.st().row === 'back' && w.view().menu.offset === 1, T('M6 ... and scrolls the list when it reaches the end'), J(w.st()));
    w.click(rects[0].x + 30, rects[0].y + 5);          // the first row SHOWN is now BATTLE ANYONE
    ok(w.q() && w.q().id === O.QUICK_ID, T('M6 a click on a row is the cursor and A (the row under the pointer is the one shown there after the scroll)'), J(w.q()));
    w.press('b');
    // a choice row: the left half of its value is "previous", the rest "next"
    const w2 = online(); at(w2, 'team');
    const tr = w2.hub.rects().find((r) => r.id === 'team'), g = O.OGEOM.menu;
    w2.click(g.x + O.OGEOM.value + 20, tr.y + 5);
    ok(w2.st().team === K.random && lastOf(w2.effects('prefs')).teamKey === K.random, T('M7 a click on the LEFT half of the TEAM value (its left arrow\'s side) goes to the previous team'), w2.st().team);
    w2.click(g.x + g.w - 12, tr.y + 5);
    ok(w2.st().team === K.t1, T('M7 ... and a click on the right half to the next'), w2.st().team);
    w2.click(g.x + 16, tr.y + 5);
    ok(w2.st().team === K.t2, T('M7 ... and a click on the label is A (the next one)'), w2.st().team);
    // plain JSON, and a view that only reads
    const w3 = online(); at(w3, 'name');
    const a = J(w3.view()), stA = J(w3.hub.state());
    for (let i = 0; i < 5; i++) w3.view();
    ok(J(w3.view()) === a && J(w3.hub.state()) === stA && J(JSON.parse(a)) === a && !/undefined/.test(a), T('M8 view() is plain JSON and reading it changes nothing'), '');
    ok(w3.hub.title('online') === 'Pokemon Arena - Play Online', T('M9 the page title of the screen'), w3.hub.title('online'));
    const said = w3.hub.speak(w3.view());
    ok(/^Play online\. NAME RED\. /.test(said) && /OPEN TO BATTLES lists RED/.test(said), T('M9 speak(): where the player is, the row and its value, what it does'), said);
    // every row by the d-pad alone, and by the pointer alone
    const w4 = online(); let byPad = 0, byPointer = 0;
    for (const id of MENU_IDS) { for (let i = 0; i < 9 && w4.st().row !== id; i++) w4.press('down'); if (w4.st().row === id) byPad++; }
    for (const id of MENU_IDS) {
      for (let i = 0; i < 12 && !w4.hub.rects().some((r) => r.id === id); i++) w4.wheel(w4.app.allRows().findIndex((r) => r.id === id) > w4.app.allRows().findIndex((r) => r.id === w4.st().row) ? 1 : -1);
      const r = w4.hub.rects().find((x) => x.id === id);
      if (r) { w4.move(r.x + 20, r.y + 5); if (w4.st().row === id) byPointer++; }
    }
    ok(byPad === 9 && byPointer === 9, T('M10 every row is reached by the d-pad alone and by the pointer alone (the wheel scrolls, a move takes the row)'), J([byPad, byPointer]));
    // ENTERED FROM THE MAIN MENU THE CURSOR IS ON THE FIRST ROW: a double press of A on the main menu's PLAY ONLINE row must not act on whatever row was left under the cursor the last time
    const left = [];
    for (const id of ['open', 'invite', 'anyone', 'back']) {
      const w5 = mk(); w5.press('down'); w5.press('down'); w5.press('a');          // the main menu's third row
      at(w5, id); w5.press('b');
      const t0 = w5.svc.s.toggles;
      w5.press('a'); const row = w5.st().row; w5.press('a'); await w5.idle();
      left.push([id, w5.hub.path() === 'center' ? 'center' : w5.hub.path(), row, w5.svc.s.toggles - t0, w5.nav.length, w5.q() ? w5.q().id : null]);
    }
    ok(left.every((x) => x[1] === 'center' && x[2] === 'center' && x[3] === 0 && x[4] === 0 && x[5] === null), T('M12 ENTERED FROM THE MAIN MENU THE CURSOR STARTS ON THE FIRST ROW, wherever it was left: A pressed twice on the main menu\'s PLAY ONLINE row switches nothing, asks nothing and leaves for nowhere (the second A opens the Trainer Center, a screen of the hub)'), J(left));
    const w6 = online({ data: NO_TEAMS }); at(w6, 'team'); w6.press('a'); const there = w6.hub.path(); w6.press('b');
    const w7 = online({ data: NO_TEAMS }); at(w7, 'team'); w7.press('a'); const there7 = w7.hub.path(); w7.arrive('online', ['online']);
    ok(there === 'builder' && w6.hub.path() === 'online' && w6.st().row === 'team' && there7 === 'builder' && w7.st().row === 'team', T('M13 ... but coming BACK from a screen this menu opened (the Team Builder: B there, or the browser\'s Back) the cursor is on the row it was opened from'), J([there, w6.st().row, there7, w7.st().row]));
    ok(J(w.hub.faults().concat(w2.hub.faults(), w3.hub.faults(), w4.hub.faults())) === '[]' && w.errors.concat(w2.errors, w3.errors, w4.errors).length === 0, T('M11 nothing threw'), J([w.hub.faults(), w.errors]));
  }

  /* ---- T: TEAM and SIZE ---- */
  if (want('T')) {
    const w = online();
    const walk = (ww) => { at(ww, 'team'); const seen = []; for (let i = 0; i < 40; i++) { const k = ww.st().team; if (seen.includes(k)) break; seen.push(k); ww.press('right'); } return seen; };
    const expect = battleList(DATA).filter((c) => c.key !== 'paste').map((c) => c.key);
    ok(J(walk(w)) === J(expect), T('T1 TEAM offers the saved LEGAL teams, the active trainer\'s first, then the other trainers\', then RANDOM TEAM: the battle page\'s own list in its own order (an illegal team is not offered)'), J(walk(w)));
    const wb = online({ data: { ...DATA, activeId: 'p2' } });
    ok(J(walk(wb)) === J(battleList({ ...DATA, activeId: 'p2' }).filter((c) => c.key !== 'paste').map((c) => c.key)) && walk(wb)[0] === K.u1, T('T1 ... with another trainer active, that trainer\'s team comes first'), J(walk(wb)));
    // what is shown is what the battle page will select
    const bad = [];
    for (const d of [DATA, { ...DATA, activeId: 'p2' }, NO_TEAMS]) for (const teamKey of [null, K.t1, K.t2, K.t3, K.u1, K.random, 'saved:p1:gone', 'saved:p1:t4']) for (const fmt of [null, '3v3', '6v6']) {
      const ww = online({ data: d }); ww.app.setPrefs({ teamKey, fmt });
      const page = PR.preselect({ teamKey, fmt }, battleList(d), {});
      if (ww.st().team !== page.teamKey || ww.st().fmt !== page.fmt) bad.push(J([d.activeId, teamKey, fmt, ww.st().team, ww.st().fmt, page]));
    }
    ok(bad.length === 0, T('T2 THE TEAM AND THE SIZE SHOWN ARE THE ONES THE BATTLE PAGE WILL SELECT (online_prefs.js preselect over that page\'s own list), for every preference: a saved team, a random one, one that is gone, one that is not legal any more, none'), bad.slice(0, 3).join(' '));
    // changing it is stored where the battle page reads it
    const w2 = online(); at(w2, 'team'); w2.press('right');
    ok(w2.st().team === K.t2 && PR.readOnlinePrefs(w2.win.localStorage).teamKey === K.t2 && w2.row('team').value === 'WWWWWWWWWWWWWWWW', T('T3 right on TEAM takes the next team and stores it (localStorage arena.online.team, where the battle page pre-selects from)'), J(PR.readOnlinePrefs(w2.win.localStorage)));
    w2.press('left'); w2.press('left');
    ok(w2.st().team === K.random && PR.readOnlinePrefs(w2.win.localStorage).teamKey === 'random', T('T3 left goes back, and wraps from the first to RANDOM TEAM'), w2.st().team);
    w2.press('a');
    ok(w2.st().team === K.t1 && PR.readOnlinePrefs(w2.win.localStorage).teamKey === K.t1, T('T3 A takes the next one too'), w2.st().team);
    // SIZE
    at(w2, 'size');
    ok(w2.row('size').kind === 'choice' && w2.st().fmt === '6v6' && w2.row('size').value === '6 V 6', T('T4 a team of six starts 6 V 6 and can be switched'), J(w2.row('size')));
    w2.press('right');
    ok(w2.st().fmt === '3v3' && PR.readOnlinePrefs(w2.win.localStorage).fmt === '3v3' && w2.row('size').value === '3 V 3', T('T4 right on SIZE switches it and stores it'), J(PR.readOnlinePrefs(w2.win.localStorage)));
    w2.app.setPrefs({ teamKey: K.t3, fmt: '3v3' }); at(w2, 'size');
    const before = w2.fx.length;
    w2.press('right'); w2.press('left'); w2.press('a');
    ok(w2.st().fmt === '6v6' && w2.row('size').disabled === true && w2.row('size').kind === 'value' && w2.fx.length === before && /fewer than 3/.test(w2.msg()), T('T5 a team of fewer than three Pokemon plays 6 V 6 only: 3 V 3 is not offered, the row cannot be changed and says why'), J([w2.row('size'), w2.msg()]));
    // a team deleted in another tab after it was preferred
    const w3 = online({ local: { 'arena.online.team': J({ teamKey: K.u1, fmt: '6v6' }) } });
    ok(w3.st().team === K.u1 && w3.st().name === 'Blue', T('T6 a stored preference is shown when the page comes up (and the name is the trainer who owns that team)'), J(w3.st()));
    w3.data({ ...DATA, profiles: [DATA.profiles[0]] });
    ok(w3.st().team === K.t1 && w3.st().name === 'RED' && w3.row('team').value === 'Rain Dance', T('T6 ... and when that team is deleted in another tab, the next data refresh shows the first saved team: what the battle page falls back to'), J(w3.st()));
    // no saved team
    const w4 = online({ data: NO_TEAMS }); at(w4, 'team');
    ok(w4.row('team').kind === 'value' && w4.row('team').value === 'RANDOM TEAM' && /no saved team/.test(w4.msg()) && /TEAM BUILDER/.test(w4.msg()), T('T7 with no saved team the row says RANDOM TEAM, the box says so and offers the Team Builder'), J([w4.row('team'), w4.msg()]));
    w4.press('right'); w4.press('left');
    ok(w4.fx.filter((e) => e.type === 'prefs').length === 0, T('T7 ... left and right change nothing'), '');
    w4.press('a');
    ok(w4.hub.path() === 'builder' && J(w4.hub.trail()) === J(['online', 'builder']), T('T7 ... and A opens the Team Builder (B there comes back)'), w4.hub.path());
    const onlyBroken = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', readOnly: false, teams: [team('t4', 'Broken', 6, 3, null, false)], record: null, tower: null }] };
    const w4b = online({ data: onlyBroken }); at(w4b, 'team');
    ok(w4b.row('team').value === 'RANDOM TEAM' && w4b.row('team').kind === 'value' && /Your teams cannot battle yet/.test(w4b.msg()) && !/no saved team/.test(w4b.msg()) && w4b.st().name === 'RED', T('T7b with teams but none that is legal the row says RANDOM TEAM and the box says they cannot battle yet (not "no saved team")'), w4b.msg());
    const w4c = online({ data: UNAVAILABLE }); at(w4c, 'team');
    ok(w4c.row('team').value === 'RANDOM TEAM' && /cannot be read/.test(w4c.msg()) && !/no saved team/.test(w4c.msg()), T('T7c when the browser\'s storage could not be opened the box says the saved teams cannot be read (not "you have no saved team")'), w4c.msg());
    // loading
    const w5 = online({ data: null }); at(w5, 'team');
    const n5 = w5.fx.length; w5.press('a'); w5.press('right');
    ok(w5.row('team').value === '...' && w5.row('team').disabled === true && /Looking for your teams/.test(w5.msg()) && w5.fx.length === n5 && w5.hub.path() === 'online', T('T8 while the teams are still being read the row says so and cannot be pressed'), J([w5.row('team'), w5.msg()]));
    // sixteen teams
    const many = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', readOnly: false, teams: Array.from({ length: 16 }, (_, i) => team('m' + i, 'TEAM ' + (i + 1), 6, 1 + i)), record: null, tower: null }] };
    const w6 = online({ data: many });
    const seen6 = walk(w6);
    ok(seen6.length === 17 && seen6[16] === 'random' && w6.st().team === seen6[0], T('T9 sixteen saved teams: every one can be chosen, then RANDOM TEAM, then the first again'), seen6.length);
    // the lead Pokemon beside the list
    const w7 = online(); at(w7, 'team');
    const l1 = w7.view().online.lead; w7.press('right'); const l2 = w7.view().online.lead; w7.press('left'); w7.press('left'); const l3 = w7.view().online.lead;
    ok(l1.species === 6 && l2.species === 9 && l3.species === 25, T('T10 the Pokemon beside the list is the lead of the team chosen (the hub\'s own Pokemon for a random team)'), J([l1, l2, l3]));
    // a preference that cannot be stored is taken back, with the reason
    const w8 = online({ localBlocked: true }); at(w8, 'team'); w8.press('right');
    ok(w8.st().team === K.t1 && /not keeping settings/.test(w8.msg()), T('T11 a team that could not be stored (the browser blocks the storage) is TAKEN BACK in the picture, with the reason: what the menu shows is what the battle page will read'), J([w8.st().team, w8.msg()]));
    w8.press('down');
    ok(!/not keeping settings/.test(w8.msg()), T('T11 ... and the reason goes with the next move'), w8.msg());
    // a name kept in this browser is text, never one of the ROM font's tokens
    const tokens = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: '{UP}', readOnly: false, teams: [team('t1', '{CURSOR}{CURSOR} TEAM', 6, 6, ['{DOWN}', 'Snorlax', '{E}{E}', 'Lapras', 'Eevee', 'Mew']), team('t2', 'Solo', 1, 6, ['{LEFT}'])], record: null, tower: null }] };
    const w9 = online({ data: tokens }); at(w9, 'team');
    const a9 = [w9.row('team').value].concat(w9.view().msg); w9.press('right'); const b9 = [w9.row('team').value].concat(w9.view().msg);
    ok(!/[{}]/.test(a9.concat(b9).join(' ')) && a9[0] === '(CURSOR)(CURSOR) TEAM' && /\(DOWN\), Snorlax, \(E\)\(E\)/.test(a9[1]) && b9[1] === '(LEFT)' && b9[2] === 'A team of (UP).', T('T13 a team, a Pokemon or a trainer whose name holds {CURSOR} (the ROM font\'s own tokens) is drawn as the words it is, never as the glyph: the row and the box hold no brace'), J([a9, b9]));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('T12 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- N: NAME ---- */
  if (want('N')) {
    const w = online(); at(w, 'name');
    ok(w.row('name').value === 'RED' && /Shown in a battle and BATTLE ANYONE/.test(w.msg()) && /OPEN TO BATTLES lists RED\./.test(w.msg()), T('N1 with no name typed, the name is the trainer who owns the team chosen; the box says where it is shown, and which name OPEN TO BATTLES lists'), J([w.row('name'), w.msg()]));
    w.app.setPrefs({ teamKey: K.u1, fmt: null });
    ok(w.row('name').value === 'Blue' && /OPEN TO BATTLES lists RED\./.test(w.msg()), T('N1 ... it follows the team (another trainer\'s team, that trainer\'s name), and the box still says OPEN TO BATTLES lists the ACTIVE trainer, RED'), J([w.row('name'), w.msg()]));
    w.app.setPrefs({ teamKey: 'random', fmt: null });
    ok(w.row('name').value === 'RED', T('N1 ... and with a random team it is the active trainer'), J(w.row('name')));
    const wn = online({ data: NO_TEAMS }); at(wn, 'name');
    ok(wn.row('name').value === '(NONE)' && /Host or Guest/.test(wn.msg()) && /OPEN TO BATTLES lists Player\./.test(wn.msg()) && wn.st().name === '', T('N1 ... and with no trainer at all there is none (the battle page then says Host or Guest, and OPEN TO BATTLES lists "Player")'), J([wn.row('name'), wn.msg()]));
    w.press('a');
    const ev = w.view().entry;
    ok(w.hub.wantsText() && ev && ev.id === 'name' && ev.max === O.NAME_MAX && ev.charset === 'name' && ev.value === '' && ev.title === O.WORDS.nameTitle && ev.note === O.WORDS.nameHint && /Empty/.test(ev.note), T('N2 A on NAME opens the text entry: ten characters, the name keys, and a line that says what an empty name means'), J(ev && [ev.id, ev.max, ev.charset, ev.value, ev.note]));
    w.typeText('Ash Ketchum!!');
    ok(w.view().entry.value === 'Ash Ketchu', T('N2 it takes no more than ten characters'), w.view().entry.value);
    w.type({ key: 'enter' });
    ok(!w.hub.wantsText() && w.st().typed === 'Ash Ketchu' && w.row('name').value === 'Ash Ketchu' && w.win.localStorage.getItem(C.NAME_KEY) === 'Ash Ketchu', T('N2 OK stores the name where the battle page reads it (localStorage arena.online.name) and the row shows it'), J([w.st().typed, w.win.localStorage.store]));
    // WHICH NAME IS WHERE: the name typed is the one a battle and BATTLE ANYONE show; OPEN TO BATTLES and the Trainer Center list the ACTIVE TRAINER's (presence_boot.js readTrainer), and every line says so
    const lines = (id) => { at(w, id); return w.msg(); };
    w.app.setPrefs({ teamKey: K.t1, fmt: null });
    const nameSays = lines('name'), openSays = lines('open'), anySays = lines('anyone'), centerSays = lines('center');
    ok(/OPEN TO BATTLES lists RED\./.test(nameSays) && !/Ash Ketchu/.test(openSays) && /trainer name RED/.test(openSays) && /Lists Ash Ketchu with online record/.test(anySays) && /lists RED and your look/.test(centerSays) && w.st().listed === 'RED',
      T('N11 WHICH NAME IS WHERE: with ASH KETCHU typed and the trainer RED, the NAME row says OPEN TO BATTLES lists RED, the OPEN TO BATTLES row says it lists the trainer name RED (not the typed one), BATTLE ANYONE says it lists Ash Ketchu, the Trainer Center RED'), J([nameSays, openSays, anySays, centerSays]));
    w.app.setPrefs({ teamKey: 'random', fmt: null });
    ok(/Lists Ash Ketchu, no online record/.test(lines('anyone')), T('N11 ... and with a random team BATTLE ANYONE says no online record is listed (a random team has no trainer)'), w.msg());
    at(w, 'name');
    w.app.setPrefs({ teamKey: K.u1, fmt: null });
    ok(w.row('name').value === 'Ash Ketchu', T('N2 ... and a name the player typed stays when the team changes'), J(w.row('name')));
    // a character the online rule drops
    w.press('a'); for (let i = 0; i < 12; i++) w.type({ key: 'backspace' }); w.typeText('Ash,K'); w.type({ key: 'enter' });
    const ev2 = w.view().entry;
    ok(w.hub.wantsText() && ev2 && ev2.value === 'AshK' && ev2.note === O.WORDS.nameNote && w.st().typed === 'Ash Ketchu', T('N3 a name with a character the online rule drops comes back as it would be used, with the reason: nothing is stored yet'), J(ev2 && [ev2.value, ev2.note]));
    w.type({ key: 'enter' });
    ok(w.st().typed === 'AshK' && w.win.localStorage.getItem(C.NAME_KEY) === 'AshK', T('N3 ... and OK then stores the name as it will be used'), J(w.win.localStorage.store));
    // empty: the trainer's own name again
    w.press('a'); for (let i = 0; i < 12; i++) w.type({ key: 'backspace' }); w.type({ key: 'enter' });
    ok(w.st().typed === null && w.row('name').value === 'Blue' && w.win.localStorage.getItem(C.NAME_KEY) === null, T('N4 an empty name forgets the typed one: the trainer\'s name is used again and the stored name is REMOVED (the battle page would otherwise keep using it)'), J([w.st().typed, w.win.localStorage.store]));
    w.press('a'); w.typeText('Zed'); w.type({ key: 'escape' });
    ok(!w.hub.wantsText() && w.st().typed === null && w.win.localStorage.getItem(C.NAME_KEY) === null, T('N5 CANCEL changes nothing'), J(w.st().typed));
    w.press('a'); w.type({ text: 'Misty' });
    ok(w.view().entry && w.view().entry.value === 'Misty' && w.effects('paste').length === 0, T('N12 a PASTE into the NAME entry is typed into it (only a paste into the room code goes to be read as a link)'), J([w.view().entry && w.view().entry.value, w.effects('paste').length]));
    w.type({ key: 'escape' });
    // a name stored on an earlier visit, and one that is not a name
    const w2 = online({ local: { 'arena.online.name': 'Misty' } });
    ok(w2.st().typed === 'Misty' && w2.row('name').value === 'Misty', T('N6 a name typed on an earlier visit is shown when the page comes up'), J(w2.st().typed));
    const w3 = online({ local: { 'arena.online.name': '<b>{RED}</b> and a very long tail' } });
    ok(w3.st().typed === NM.cleanName('<b>{RED}</b> and a very long tail', '') && /^[A-Za-z0-9 .'_!?-]{1,10}$/.test(w3.st().typed), T('N6 a stored value that is not a name is shown as the battle page would use it (its own rule)'), J(w3.st().typed));
    // the rule IS the battle page's
    const pool = ['A', 'b', 'Z', '9', ' ', ' ', '.', "'", '_', '!', '?', '-', ',', '/', '<', '{', '}', 'é', '♂', 'Ａ', '‍', '\t', '\n', '😀', '́', 'x'];
    let seed = 12345, diff = null; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 6000 && !diff; i++) { let s = ''; const n = Math.floor(rnd() * 16); for (let k = 0; k < n; k++) s += pool[Math.floor(rnd() * pool.length)]; if (O.onlineName(s, '') !== NM.cleanName(s, '')) diff = s; }
    ok(diff === null && O.NAME_MAX === NM.NAME_MAX && O.onlineName(null, 'x') === 'x' && O.onlineName(undefined) === '', T('N7 onlineName IS netmatch.js cleanName (6000 strings), and NAME_MAX is the protocol\'s'), J(diff));
    const src = fs.readFileSync(path.join(M.dir, 'online.js'), 'utf8');
    ok(new RegExp("const LS_NAME = '" + C.NAME_KEY.replace(/\./g, '\\.') + "';").test(src) && C.GAME_KEY === ON.GAME_KEY, T('N8 the name is stored under the key the battle page reads (js/online.js LS_NAME), and GAME_KEY is that page\'s'), C.NAME_KEY);
    // a name that could not be stored
    const w4 = online({ localBlocked: true }); at(w4, 'name'); w4.press('a'); w4.typeText('Gary'); w4.type({ key: 'enter' });
    ok(w4.st().typed === null && w4.row('name').value === 'RED' && /not keeping settings/.test(w4.msg()), T('N9 a name that could not be stored is taken back, with the reason'), J([w4.st().typed, w4.msg()]));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('N10 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- Q: BATTLE ANYONE ---- */
  if (want('Q')) {
    const w = online(); at(w, 'anyone');
    const row0 = w.msg(); w.app.setPrefs({ teamKey: 'random', fmt: null }); const row1 = w.msg(); w.app.setPrefs({ teamKey: null, fmt: null });
    ok(/Lists RED with online record\./.test(row0) && /Lists RED, no online record\./.test(row1), T('Q0 the BATTLE ANYONE row says, under the list, WHICH NAME is listed and whether an online record goes with it (a saved team: yes; a random team: none)'), J([row0, row1]));
    w.press('a');
    const q = w.q();
    ok(q && q.id === O.QUICK_ID && q.app === 'online' && q.pages > 2 && q.page === 0 && w.nav.length === 0 && w.win.sessionStorage.getItem(P.START_KEY) === null && w.effects('start').length === 0,
      T('Q1 A on BATTLE ANYONE starts NOTHING: it opens a notice (message pages) of what will be published'), J([q, w.nav]));
    const pages = w.pages(), text = pages.slice(0, -1).map((p) => p.join(' ')).join(' ');
    const hosts = [...new Set(OL.DEFAULT_BROKERS.map((b) => new URL(b.split('|')[0]).hostname))];
    ok(hosts.length >= 3 && hosts.every((h) => text.includes(h)) && text.includes(new URL(OL.MQTT_LIB).hostname) && /see the name RED and your online record/.test(text) && !/trainer name/.test(text) && /IP address/.test(text) && /listed/.test(text) && text.includes(hosts.length + ' public servers'),
      T('Q2 the notice says what other players see (THE NAME THAT WILL BE LISTED, by name, and the online record), names the public servers the battle page dials and the host its script comes from, and that they see the IP address'), text);
    ok(/The team you play and your choices go to the other player/.test(text) && /public relay/.test(text), T('Q2b ... and that the team played goes to the other player, through a public relay when there is no direct path'), text);
    const px = M.screen.msgPx, m = (s) => M.screen.measure(s);
    ok(w.fits(pages, O.MORE_PX) && pages.length <= M.HD.DIALOG_MAX_PAGES && O.MORE_PX === HP.MORE_PX, T('Q3 every line of the notice fits the message box, and a page that is followed by another leaves the room of the "more" arrow'), J(pages.map((p) => p.map(m))));
    const d = w.view().dialog;
    ok(J(lastOf(pages)) === J([O.WORDS.quickAsk, '']) && d.choice && J(d.choice.options) === J(['YES', 'NO']) && d.choice.cursor === O.NO && w.q().armed === true, T('Q4 the last page is the question, FIND AN OPPONENT? YES / NO, and NO is under the cursor'), J(d.choice));
    w.press('a');
    ok(!w.q() && w.nav.length === 0 && w.effects('start').length === 0 && w.win.sessionStorage.getItem(P.START_KEY) === null && w.win.localStorage.getItem(C.TOLD_KEY) === null, T('Q5 A there (NO) starts nothing: no token, no navigation, nothing remembered'), J(w.nav));
    w.press('a'); w.press('b');
    ok(!w.q() && w.nav.length === 0 && w.effects('start').length === 0, T('Q5 B answers NO from the first page'), J(w.nav));
    w.press('a'); w.pages(); w.press('up'); w.press('a');
    const n = w.nav[0];
    ok(w.nav.length === 1 && n.url === '/pokemonarena/battle.html?online=1&net=local' && J(tokenOf(M, n.start)) === J({ what: 'quick', room: null }) && honoured(M, n) === 'quick' && n.back === null,
      T('Q6 YES writes the one-time START token { quick } into this tab and THEN opens the battle page at ?online=1 (with the test seams of the hub\'s address): exactly what that page honours'), J(n));
    ok(w.win.localStorage.getItem(C.TOLD_KEY) === '1' && w.st().seen === true, T('Q7 ... and it is remembered that the player has read the notice'), J(w.win.localStorage.store));
    // the second time: the short notice, the same question
    const w2 = online({ local: { [C.TOLD_KEY]: '1' } }); at(w2, 'anyone'); w2.press('a');
    const p2 = w2.pages();
    ok(p2.length === 2 && /see the name RED and your online record/.test(p2.slice(0, -1).flat().join(' ')) && J(lastOf(p2)) === J([O.WORDS.quickAsk, '']) && w2.view().dialog.choice.cursor === O.NO && w2.nav.length === 0,
      T('Q8 a player who has said YES to it before gets the short notice (what other players see: the name, by name, and the record), and the same question with NO first'), J(p2));
    const w2b = online(); at(w2b, 'anyone'); w2b.press('a');
    ok(w2b.pages().length > 3, T('Q8 ... a player who has not gets the long one'), '');
    const w2c = online({ local: { [C.TOLD_KEY]: '1', [C.NAME_KEY]: 'Zed', 'arena.online.team': J({ teamKey: 'random', fmt: null }) } }); at(w2c, 'anyone'); w2c.press('a');
    const p2c = w2c.pages().flat().join(' ');
    ok(/see the name Zed\./.test(p2c) && /random team lists no online record/.test(p2c) && !/RED/.test(p2c), T('Q8b the notice names the name the NAME row holds (a typed one, not the trainer\'s), and says a random team lists no record'), p2c);
    // before the ctl has said which servers
    const w3 = online({ svc: 'none' }); at(w3, 'anyone'); w3.press('a');
    ok(!w3.q() && /still loading/.test(w3.msg()), T('Q9 before the menu knows which servers it would name, BATTLE ANYONE opens nothing and says it is still loading'), w3.msg());
    // the words
    const many = O.quickWords({ hosts: ['a.x', 'b.x', 'c.x', 'd.x', 'e.x', 'f.x', 'g.x', 'h.x'], cdn: 'cdn.x' }, { name: 'RED', rec: true });
    ok(/8 public servers \(a\.x, b\.x, c\.x, d\.x, e\.x, f\.x and 2 more\)/.test(many) && /from cdn\.x\./.test(many) && /public servers and loads a script from a public CDN/.test(O.quickWords(null)) && /1 public server \(a\.x\)/.test(O.quickWords({ hosts: ['a.x'], cdn: '' })) && /the name Host and/.test(O.quickWords(null)),
      T('Q10 the notice names at most six servers and counts the rest; with none known it says "public servers" (and a player with no name is "Host": the battle page\'s own word)'), many);
    // a list of names too long to read (a ?wsbroker= override): the notice still opens, and says how many servers there are
    const wl = online(); wl.app.setBoard({ hosts: Array.from({ length: 6 }, (_, i) => 'server' + i + '-' + 'x'.repeat(200) + '.example'), cdn: 'cdn.example' }); at(wl, 'anyone'); wl.press('a');
    const pl = wl.q() ? wl.pages() : [], tl = pl.flat().join(' ');
    ok(pl.length > 3 && pl.length <= M.HD.DIALOG_MAX_PAGES && /6 public servers and loads/.test(tl) && !/xxxxxxxx/.test(tl) && /IP address/.test(tl) && wl.fits(pl, O.MORE_PX), T('Q10b server names too long for the sixteen pages a notice may have are left out (their number is said): the notice is never refused for its length'), J([pl.length, wl.msg()]));
    at(wl, 'invite'); wl.press('b'); wl.press('a');
    const pf = wl.q() && wl.q().id === O.FRIEND_ID ? wl.pages() : [];
    ok(pf.length > 2 && pf.length <= M.HD.DIALOG_MAX_PAGES && /6 public servers and loads/.test(pf.flat().join(' ')), T('Q10c ... and so is the notice of INVITE A FRIEND'), J([pf.length, wl.msg()]));
    const b = C.boardOf({ location: { search: '?wsbroker=wss://one.example:443/mqtt|u|p,wss://one.example:8084,wss://two.example' } });
    ok(J(b.hosts) === J(['one.example', 'two.example']) && b.cdn === new URL(OL.MQTT_LIB).hostname, T('Q11 the servers are the ones the battle page will dial (a ?wsbroker= override is followed), each host once'), J(b));
    // the browser's Back under the notice
    const w4 = online(); at(w4, 'anyone'); w4.press('a'); w4.arrive('main', []);
    ok(!w4.q() && w4.hub.path() === 'main' && w4.nav.length === 0, T('Q12 leaving the screen with the notice up (the browser\'s Back) takes the notice with it: it cannot be answered from another screen'), J(w4.q()));
    // ONLY YES STARTS: an answer that is neither (a timeout, a notice closed) is not a YES
    const w5 = online(); at(w5, 'anyone');
    for (const v of ['timeout', 'closed', O.NO, 2, null]) w5.run(w5.app.onDialog(O.QUICK_ID, v));
    at(w5, 'invite'); w5.press('a');
    for (const v of ['timeout', 'closed', O.NO, 2, null]) w5.run(w5.app.onDialog(O.FRIEND_ID, v));
    await w5.idle();
    ok(w5.nav.length === 0 && w5.effects('start').length === 0 && w5.win.sessionStorage.getItem(P.START_KEY) === null, T('Q14 ONLY YES STARTS ANYTHING: an answer that is not YES (a timeout, a notice that was closed, any other value) starts nothing, for BATTLE ANYONE and for a battle with a friend'), J(w5.nav));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('Q13 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- H: INVITE A FRIEND ---- */
  if (want('H')) {
    const w = online({ search: '?net=local&openchal=5000&secret=1', session: { 'arena.back': 'center' } }); at(w, 'invite');
    w.press('a');
    const q = w.q();
    ok(q && q.id === O.FRIEND_ID && q.app === 'online' && q.pages > 2 && q.page === 0 && q.armed === true && w.nav.length === 0 && w.effects('start').length === 0 && w.win.sessionStorage.getItem(P.START_KEY) === null,
      T('H1 A on INVITE A FRIEND starts NOTHING: it opens a notice (message pages) of what a battle with a friend connects to. The battle page dials the public servers by itself as soon as it is opened with the token, and nothing there says so first'), J([q, w.nav]));
    const pages = w.pages(), text = pages.slice(0, -1).map((p) => p.join(' ')).join(' ');
    const hosts = [...new Set(OL.DEFAULT_BROKERS.map((b) => new URL(b.split('|')[0]).hostname))];
    ok(hosts.length >= 3 && hosts.every((h) => text.includes(h)) && text.includes(hosts.length + ' public servers') && text.includes(new URL(OL.MQTT_LIB).hostname) && /IP address/.test(text) && /never listed/.test(text),
      T('H1b the notice names the public servers the battle page dials (the ones BATTLE ANYONE names) and the host its script comes from, says that they see the IP address, and that the room is never listed'), text);
    ok(/The team you play and your choices go to the other player/.test(text) && /public relay/.test(text), T('H1c ... and that the team played goes to the other player, through a public relay when there is no direct path'), text);
    const d = w.view().dialog;
    ok(w.fits(pages, O.MORE_PX) && pages.length <= M.HD.DIALOG_MAX_PAGES && J(lastOf(pages)) === J(['Open a room for a friend?', '']) && J(d.choice.options) === J(['YES', 'NO']) && d.choice.cursor === O.NO,
      T('H1d every line fits its box; the last page is the question, OPEN A ROOM FOR A FRIEND? YES / NO, with NO under the cursor the first time'), J([pages.map((p) => p.map((s) => M.screen.measure(s))), d.choice]));
    w.press('a');
    ok(!w.q() && w.nav.length === 0 && w.effects('start').length === 0 && w.win.sessionStorage.getItem(P.START_KEY) === null && w.win.localStorage.getItem(C.TOLD_KEY) === null, T('H2 A there (NO) starts nothing: no token, no navigation, nothing remembered'), J(w.nav));
    w.press('a'); w.press('b');
    ok(!w.q() && w.nav.length === 0, T('H2 ... and B answers NO from the first page'), J(w.nav));
    w.press('a'); w.yes();
    const n = w.nav[0];
    ok(w.nav.length === 1 && n.url === '/pokemonarena/battle.html?online=1&net=local&openchal=5000' && J(tokenOf(M, n.start)) === J({ what: 'host', room: null }) && honoured(M, n) === 'host',
      T('H3 YES writes the START token { host } and then opens the battle page at ?online=1, which that page honours by opening a private room; the test seams of the hub\'s address ride along and nothing else of it does'), J(n));
    ok(n && n.back === null, T('H3b a battle started from this menu comes back to the main menu (a stale arena.back is cleared before the page leaves)'), J(n && n.back));
    ok(w.win.localStorage.getItem(C.TOLD_KEY) === '1' && w.st().seen === true, T('H3c ... and it is remembered that the player has read the notice'), J(w.win.localStorage.store));
    // told before (by this notice, or by BATTLE ANYONE's): one line with the question, YES under the cursor
    const w2 = online({ local: { [C.TOLD_KEY]: '1' } }); at(w2, 'invite'); w2.press('a');
    const q2 = w2.q(), d2 = w2.view().dialog;
    ok(q2 && q2.id === O.FRIEND_ID && q2.pages === 1 && J(d2.lines) === J(['A private room, over public servers.', 'Open a room for a friend?']) && d2.choice.cursor === O.YES && w2.nav.length === 0 && d2.lines.every((s) => M.screen.measure(s) <= M.screen.msgPx),
      T('H4 a player who has said YES to a long notice before gets ONE page: that the room is private and goes over public servers, and the question, with YES under the cursor (nothing is listed: the question is there to say it, not to be mashed through unread the first time)'), J([q2, d2 && d2.lines]));
    w2.press('a');
    ok(w2.nav.length === 1 && honoured(M, w2.nav[0]) === 'host', T('H4 ... A there (YES) leaves for the battle page'), J(w2.nav));
    const w3 = online({ svc: 'none' }); at(w3, 'invite'); w3.press('a');
    ok(!w3.q() && /still loading/.test(w3.msg()) && w3.effects('start').length === 0, T('H5 before the menu knows which servers it would name, INVITE A FRIEND opens nothing and says it is still loading'), w3.msg());
    const w4 = online(); at(w4, 'invite'); w4.press('a'); w4.arrive('main', []);
    ok(!w4.q() && w4.hub.path() === 'main' && w4.nav.length === 0, T('H6 leaving the screen with the question up (the browser\'s Back) takes it away: it cannot be answered from another screen'), J(w4.q()));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('H7 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- J: JOIN A FRIEND ---- */
  if (want('J')) {
    const w = online(); at(w, 'join');
    w.press('a');
    const ev = w.view().entry;
    ok(w.hub.wantsText() && ev && ev.id === 'room' && ev.max === O.ROOM_MAX && ev.charset === 'code' && w.effects('join-open').length === 1 && w.nav.length === 0, T('J1 A on JOIN A FRIEND opens the text entry for the room code: eight characters, letters and digits'), J(ev && [ev.id, ev.max, ev.charset]));
    w.typeText('k7q2p');
    ok(w.view().entry.value === 'K7Q2P', T('J1 a lower-case letter is typed as its capital'), w.view().entry.value);
    w.type({ key: 'enter' });
    ok(w.st().busy === 'join' && /Checking/.test(w.msg()), T('J2 OK hands the code to be checked (the menu says so and waits)'), J(w.st()));
    await w.idle();
    const qj = w.q();
    ok(qj && qj.id === O.FRIEND_ID && qj.armed === false && w.nav.length === 0 && w.win.sessionStorage.getItem(P.MEET_KEY) === null && w.st().busy === null,
      T('J2 a room code starts NOTHING yet: the picture first says what joining connects to (the question JOIN ROOM <CODE>?), and no token is written'), J([qj, w.nav]));
    for (let i = 0; i < 4; i++) w.press('a');
    w.click(120, 130); w.press('b');
    ok(w.q() && w.q().id === O.FRIEND_ID && w.q().page === 0 && w.nav.length === 0, T('J2b ... it did not come under a press (the code was checked first), so it answers nothing for its first 0.6 s: the Enter that was still on its way neither turns a page nor answers'), J(w.q()));
    w.arm();
    const pj = w.pages(), tj = pj.slice(0, -1).flat().join(' ');
    ok(/You join room K7Q2P\. Nothing is listed\./.test(tj) && /public servers/.test(tj) && /IP address/.test(tj) && /public relay/.test(tj) && J(lastOf(pj)) === J(['Join room K7Q2P?', '']) && w.view().dialog.choice.cursor === O.NO && w.fits(pj, O.MORE_PX),
      T('J2c it names the room, the public servers and the IP address, says the team played goes to the other player, and asks JOIN ROOM K7Q2P? with NO under the cursor the first time'), tj);
    w.press('up'); w.press('a');
    const n = w.nav[0];
    ok(w.nav.length === 1 && n.url === '/pokemonarena/battle.html?np=K7Q2P&join=1&meet=1&net=local' && honoured(M, n) === 'join' && n.start === null && w.st().busy === null,
      T('J2d YES writes the MEET token for that room and then opens ?np=ROOM&join=1&meet=1: the battle page joins by itself'), J(n));
    const wt = online({ local: { [C.TOLD_KEY]: '1' } }); at(wt, 'join'); wt.press('a'); wt.typeText('K7Q2P'); wt.type({ key: 'enter' }); await wt.idle();
    const yesRect = wt.hub.rects()[0];
    wt.press('a'); if (yesRect) wt.click(yesRect.x + 4, yesRect.y + 4);
    const early = [!!wt.q(), wt.nav.length, wt.win.sessionStorage.getItem(P.MEET_KEY)];
    wt.arm();
    const dt = wt.view().dialog;
    ok(dt && J(dt.lines) === J(['Room K7Q2P, over public servers.', 'Join room K7Q2P?']) && dt.choice.cursor === O.YES && wt.q().pages === 1 && !!yesRect && J(early) === J([true, 0, null]),
      T('J2e a player who has read the long notice before gets one page (the room, over public servers, the question) with YES under the cursor: and for its first 0.6 s neither A nor a tap on YES joins'), J([dt && dt.lines, early]));
    wt.press('b');
    ok(!wt.q() && wt.nav.length === 0 && wt.win.sessionStorage.getItem(P.MEET_KEY) === null && wt.hub.path() === 'online', T('J2f NO (B) joins nothing'), J(wt.nav));
    // a wrong code
    const w2 = online(); at(w2, 'join'); w2.press('a'); w2.typeText('K7'); w2.type({ key: 'enter' }); await w2.idle();
    const q2 = w2.q();
    w2.press('a'); w2.press('b');
    ok(q2 && q2.id === O.NOTE_ID && q2.armed === false && w2.q() && w2.q().id === O.NOTE_ID, T('J3b the refusal is a notice that came after the check, not under the press: for its first 0.6 s the Enter that was on its way does not dismiss it unread'), J(q2));
    w2.arm();
    const p2 = w2.pages(), words2 = p2.flat().join(' ');
    ok(w2.nav.length === 0 && w2.win.sessionStorage.getItem(P.MEET_KEY) === null && /That is not a room code\. A code is 4 to 8 letters and numbers, like K7Q2P\./.test(words2) && w2.fits(p2, O.MORE_PX), T('J3 a code that is not one is REFUSED in the battle page\'s own words: no token, no navigation'), words2);
    w2.press('a');
    ok(!w2.q() && w2.hub.wantsText() && w2.view().entry.value === 'K7' && w2.st().busy === null, T('J3 ... and the entry is back with what was typed'), J(w2.view().entry && w2.view().entry.value));
    for (let i = 0; i < 3; i++) w2.type({ key: 'backspace' }); w2.type({ key: 'enter' }); await w2.idle(); w2.arm();
    ok(w2.nav.length === 0 && /Type the room code your friend sent you/.test(w2.q() ? w2.pages().flat().join(' ') : ''), T('J3 an empty code is refused too'), '');
    w2.press('a'); w2.type({ key: 'escape' });
    ok(!w2.hub.wantsText() && w2.hub.path() === 'online' && w2.nav.length === 0, T('J4 CANCEL closes the entry and nothing else'), '');
    // a paste
    const w3 = online(); at(w3, 'join'); w3.press('a');
    w3.type({ text: 'https://caseybement.com/pokemonarena/battle.html?np=abcd12&join=1' }); await w3.idle();
    ok(w3.hub.wantsText() && w3.view().entry.value === 'ABCD12' && lastOf(w3.effects('paste')).text.includes('np=abcd12'), T('J5 a friend\'s whole LINK pasted into the entry is reduced to its room code (the battle page\'s own roomFromInput)'), J(w3.view().entry && w3.view().entry.value));
    w3.type({ text: 'https://caseybement.com/pokemonarena/' }); await w3.idle();
    ok(w3.view().entry.value === 'ABCD12' && w3.view().entry.note === O.WORDS.noRoomInLink, T('J5 a pasted address that names no room leaves the field alone and says so'), J(w3.view().entry && [w3.view().entry.value, w3.view().entry.note]));
    w3.type({ text: ' k7-q2 p ' }); await w3.idle();
    ok(w3.view().entry.value === 'K7Q2P' && w3.view().entry.note === '', T('J5 a pasted code with spaces and dashes is the code'), J(w3.view().entry && w3.view().entry.value));
    w3.type({ text: 'ABCDEFGHIJK' }); await w3.idle();
    ok(w3.view().entry.value === 'ABCDEFGH' && w3.view().entry.note === C.TOO_LONG, T('J6 an eleven-character paste is cut to eight, and the entry SAYS it was longer than a room code'), J(w3.view().entry && [w3.view().entry.value, w3.view().entry.note]));
    w3.type({ key: 'enter' }); await w3.idle(); w3.arm();
    const asked3 = lastOf(w3.pages());
    w3.press('up'); w3.press('a');
    ok(J(asked3) === J(['Join room ABCDEFGH?', '']) && w3.nav.length === 1 && w3.nav[0].url.includes('np=ABCDEFGH&join=1&meet=1'), T('J6 ... OK then asks about, and YES joins, the room the field shows'), J([asked3, w3.nav]));
    const big = 'x'.repeat(5000);
    const w3b = online(); at(w3b, 'join'); w3b.press('a'); w3b.type({ text: big }); await w3b.idle();
    ok(lastOf(w3b.effects('paste')).text.length === O.PASTE_MAX && O.PASTE_MAX <= 4096, T('J17 a paste of any size hands the ctl no more than ' + O.PASTE_MAX + ' characters of it'), lastOf(w3b.effects('paste')).text.length);
    // while a code is being checked
    const w4 = online({ svc: 'none' }); at(w4, 'join'); w4.press('a'); w4.typeText('K7Q2P'); w4.type({ key: 'enter' });
    at(w4, 'invite'); const n4 = w4.hub.press('a');
    ok(w4.st().busy === 'join' && n4.length === 0 && /Checking/.test(w4.msg()), T('J7 while a code is being checked no other row starts anything'), J(n4));
    w4.tick(O.BUSY_TICKS + 1);
    ok(w4.st().busy === null && /took too long/.test(w4.msg()), T('J8 a check that is never answered gives the buttons back after ten seconds, and says so'), J([w4.st().busy, w4.msg()]));
    // ... and a ctl that answers after the menu gave up starts nothing
    const w5 = online(); at(w5, 'join'); w5.press('a'); w5.typeText('K7Q2P');
    const fx5 = w5.hub.type({ key: 'enter' });          // (the effect is held back: the ctl has not heard yet)
    w5.tick(O.BUSY_TICKS + 1);
    w5.run(fx5); await w5.idle();
    ok(w5.nav.length === 0 && w5.win.sessionStorage.getItem(P.MEET_KEY) === null && !w5.q() && w5.st().busy === null, T('J9 a check that comes back after the menu stopped waiting asks nothing and starts nothing behind the player\'s back'), J([w5.nav, w5.q()]));
    // THE ANSWER IS TIED TO THE REQUEST, not to a flag: a second code typed while the first is still being checked must not be answered by the first check
    const held = (ww, code) => { at(ww, 'join'); ww.press('a'); for (let i = 0; i < 8; i++) ww.type({ key: 'backspace' }); ww.typeText(code); return ww.hub.type({ key: 'enter' }); };          // (the effect is returned, not run: the ctl has not heard yet)
    const w7 = online();
    const first7 = held(w7, 'AAAA');
    w7.press('b');
    const left7 = [w7.hub.path(), w7.st().busy];
    w7.goto('online');
    const second7 = held(w7, 'BBBB');
    w7.run(first7); await w7.idle();
    const mid7 = w7.q() ? w7.q().id : null;
    w7.run(second7); await w7.idle(); w7.arm();
    const asked7 = w7.q() ? lastOf(w7.pages()) : null;
    w7.press('up'); w7.press('a');
    ok(J(left7) === J(['main', null]) && mid7 === null && J(asked7) === J(['Join room BBBB?', '']) && w7.nav.length === 1 && /np=BBBB&/.test(w7.nav[0].url) && !/AAAA/.test(J(w7.nav)) && /"BBBB"/.test(w7.nav[0].meet || ''),
      T('J12 A ROOM THE PLAYER ABANDONED IS NEVER OPENED: a code is being checked, the player backs out of PLAY ONLINE, comes back and types ANOTHER code; when the first check comes back it is dropped (it answers an older request), and the question and the MEET token are for the second room'), J([left7, mid7, asked7, w7.nav]));
    const w8 = online();
    const first8 = held(w8, 'CCCC');
    w8.tick(O.BUSY_TICKS + 1);
    const gave8 = [w8.st().busy, w8.msg()];
    const second8 = held(w8, 'DDDD');
    w8.run(first8); await w8.idle();
    const mid8 = w8.q() ? w8.q().id : null;
    w8.run(second8); await w8.idle(); w8.arm();
    const asked8 = w8.q() ? lastOf(w8.pages()) : null;
    w8.press('up'); w8.press('a');
    ok(gave8[0] === null && /took too long/.test(gave8[1]) && mid8 === null && J(asked8) === J(['Join room DDDD?', '']) && w8.nav.length === 1 && /np=DDDD&/.test(w8.nav[0].url) && !/CCCC/.test(J(w8.nav)),
      T('J13 ... nor after the menu gave up waiting ("That took too long") and the player typed another code: the late answer for the first code is dropped, the second room is the one asked about and joined'), J([gave8, mid8, asked8, w8.nav]));
    // the player left the screen while a code was being checked, and did nothing more
    const w9 = online();
    const first9 = held(w9, 'EEEE');
    w9.arrive('main', []);
    w9.run(first9); await w9.idle();
    const away9 = [w9.hub.path(), w9.q() ? w9.q().id : null, w9.nav.length, w9.win.sessionStorage.getItem(P.MEET_KEY)];
    w9.goto('online');
    ok(J(away9) === J(['main', null, 0, null]) && w9.st().busy === null && !/Checking/.test(w9.msg()), T('J14 a check that comes back after the player LEFT the screen asks nothing on the screen they are on and starts nothing; and back on PLAY ONLINE the menu is not still "checking"'), J([away9, w9.st().busy, w9.msg()]));
    const w10 = online();
    const first10 = held(w10, 'K7');
    w10.arrive('main', []);
    w10.run(first10); await w10.idle();
    ok(w10.hub.path() === 'main' && !w10.q() && !w10.hub.wantsText() && w10.view().entry == null, T('J15 ... and a REFUSAL that comes back after the player left opens neither the entry nor a notice on another screen'), J([w10.q(), w10.hub.wantsText()]));
    const w11 = online();
    const first11 = held(w11, 'FFFF');
    w11.ctl.dispose();
    w11.run(first11); await w11.idle();
    ok(!w11.q() && w11.nav.length === 0 && w11.st().busy === 'join', T('J16 a ctl that was disposed (the page is going away) answers nothing when the check comes back'), J([w11.q(), w11.nav]));
    const w12 = online(); at(w12, 'join');
    const stray = [w12.app.roomTaken(w12.st().req, 'GGGG'), w12.app.roomRefused(w12.st().req, 'no'), !!w12.q(), w12.hub.wantsText()];
    ok(J(stray) === J([false, false, false, false]), T('J18 an answer when no code is being checked at all is dropped too (the model hears an answer only while it is waiting for that request)'), J(stray));
    // the screen is left while the entry is open
    const w6 = online(); at(w6, 'join'); w6.press('a'); w6.typeText('AB'); w6.arrive('main', []); w6.goto('online');
    ok(!w6.hub.wantsText() && w6.view().entry === null && w6.st().entry === null, T('J10 leaving the screen (the browser\'s Back) closes the entry: it is not there when the menu is opened again'), J(w6.st()));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('J11 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- O: OPEN TO BATTLES ---- */
  if (want('O')) {
    const mainRow = (w) => w.hub.view().menu.rows.find((r) => r.id === 'online');
    const w = mk({ status: 'on' });
    ok(w.hub.path() === 'main' && w.ctl && w.ctl.state().woke === true && w.effects('data').length === 1 && w.st().open === 'on', T('O1 THE CTL IS UP FROM THE PAGE\'S LOAD: the first data refresh wakes it on the main menu, the online menu never opened, and it has asked the presence service where it stands'), J([w.hub.path(), !!w.ctl, w.st().open]));
    w.hub.press('down'); w.hub.press('down');
    ok(mainRow(w).label === 'PLAY ONLINE: OPEN' && /open to battles/.test(w.msg()), T('O2 THE MAIN MENU SAYS, AT A GLANCE, THAT THE PLAYER IS OPEN: the PLAY ONLINE row reads PLAY ONLINE: OPEN, and its two lines say what that means'), J([mainRow(w), w.msg()]));
    w.svc.set('offline');
    ok(mainRow(w).label === 'PLAY ONLINE: OFFLINE' && /no public/.test(w.msg()), T('O2 ... OFFLINE when it is on but no public server can be reached (nobody can see the listing)'), J([mainRow(w), w.msg()]));
    const redraws = w.redraws;
    w.svc.set('off');
    ok(mainRow(w).label === 'PLAY ONLINE' && /Battle a friend/.test(w.msg()) && w.redraws > redraws, T('O2 ... and plain PLAY ONLINE when it is off: the row follows the service on every change, and the page is told to draw'), J([mainRow(w), w.redraws - redraws]));
    w.svc.set('starting');
    ok(mainRow(w).label === 'PLAY ONLINE', T('O2 ... a start that is still under way is not "open" yet'), J(mainRow(w)));
    w.svc.set('on'); w.goto('quick'); w.svc.set('off'); w.arrive('main', []);
    ok(mainRow(w).label === 'PLAY ONLINE', T('O3 a change that came while another screen was open is there when the main menu is back'), J(mainRow(w)));
    // the row
    const w2 = online(); at(w2, 'open');
    ok(w2.row('open').value === 'OFF' && !w2.row('open').disabled && /Lists trainer name RED and online record on public servers/.test(w2.msg().replace(' | ', ' ')), T('O4 the row says OFF, and WHAT switching it on lists and WHERE: the trainer name, by name (the active trainer\'s: RED), and the online record, on public servers'), J([w2.row('open'), w2.msg()]));
    w2.app.setPrefs({ teamKey: K.u1, fmt: null }); w2.app.setName('Zed');
    ok(w2.row('name').value === 'Zed' && /Lists trainer name RED and/.test(w2.msg()) && !/Zed|Blue/.test(w2.msg()), T('O4b ... whatever the NAME row holds (a name that was typed, another trainer\'s team): OPEN TO BATTLES lists the ACTIVE trainer, and says RED'), J([w2.row('name'), w2.msg()]));
    w2.app.setName(''); w2.app.setPrefs({ teamKey: null, fmt: null });
    const wnone = online({ data: NO_TEAMS }); at(wnone, 'open');
    ok(/Lists trainer name Player and/.test(wnone.msg()), T('O4c with no trainer in this browser the listing would say "Player", and the row says so'), wnone.msg());
    w2.press('a'); await w2.idle();
    ok(w2.svc.s.toggles === 1 && w2.row('open').value === 'ON' && w2.st().open === 'on' && /You are listed as RED: anyone can challenge you/.test(w2.msg().replace(' | ', ' ')), T('O5 A asks the presence service to switch, once, and the row follows what the service then says: listed, and under which name'), J([w2.svc.s.toggles, w2.row('open'), w2.msg()]));
    w2.svc.s.listing = { name: 'Old Name!', rec: null }; w2.svc.set('on');
    ok(/You are listed as Old Name!:/.test(w2.msg()) && w2.st().listed === 'Old Name!', T('O5b WHILE IT IS ON THE ROW SAYS THE NAME THE LISTING CARRIES (what the presence service says it published), not a guess: a listing that still says another name is named as it is'), J([w2.msg(), w2.st().listed]));
    w2.svc.s.listing = null; w2.svc.set('on');
    w2.press('left'); w2.press('right');
    ok(w2.svc.s.toggles === 1, T('O5 left and right do not switch it (one press, one switch)'), w2.svc.s.toggles);
    w2.svc.set('starting');
    ok(w2.row('open').value === 'ON' && /Going open/.test(w2.msg()), T('O6 while it is starting the row says so'), w2.msg());
    w2.svc.set('offline');
    ok(w2.row('open').value === 'ON' && /nobody can see you/.test(w2.msg()), T('O6 on, but no server reachable: said in words'), w2.msg());
    w2.svc.set('unavailable');
    const t0 = w2.svc.s.toggles; w2.press('a'); await w2.idle();
    ok(w2.row('open').value === 'OFF' && w2.row('open').disabled === true && /could not load/.test(w2.msg()) && w2.svc.s.toggles === t0, T('O7 when the presence code could not load the row says so and cannot be pressed'), J([w2.row('open'), w2.msg()]));
    const wf = online(); at(wf, 'open'); wf.svc.s.fail = true; wf.press('a'); await wf.idle();
    const qf = wf.q();
    wf.press('a');
    const stillUp = !!wf.q();
    wf.arm();
    const saidF = wf.q() ? wf.pages().flat().join(' ') : '';
    ok(qf && qf.id === O.NOTE_ID && qf.armed === false && stillUp && saidF.includes(C.OPEN_FAILED) && wf.row('open').value === 'OFF' && wf.errors.length === 0, T('O20 a switch that FAILED says so in the picture (a notice that listens only after its arm delay), and the row still says what the service says'), J([qf, saidF]));
    w2.ctl.dispose();
    ok(w2.svc.listeners() === 0, T('O8 dispose() lets go of the service'), w2.svc.listeners());
    w.end(); w2.end();

    // THE REAL SERVICE: the disclosure in the picture, NO not remembered, nothing published before YES
    const heard = [];
    const spy = new BroadcastChannel(CHANNEL); spy.onmessage = (e) => { heard.push(e.data); };
    const r = online({ svc: 'real', search: '?net=local&opendisc=1' }); at(r, 'open');
    const up = await within(r.win.__arenaHubPresence.ready);
    await until(() => r.st().open === 'off');
    ok(up === true && r.st().open === 'off' && r.row('open').value === 'OFF', T('O9 (the real service) it comes up off'), J([up, r.st().open]));
    r.press('a');
    await until(() => r.q() && r.q().id === HP.DISCLOSURE_ID);
    const dp = r.q() ? r.pages() : [];
    ok(dp.length > 2 && /public servers/.test(dp.flat().join(' ')) && J(lastOf(dp)) === J([HP.DISCLOSURE_ASK, '']) && r.view().dialog.choice.cursor === HP.NO && r.st().open === 'off',
      T('O10 the first A on OPEN TO BATTLES publishes nothing: it asks the disclosure IN THE PICTURE (what is listed, where, who sees it), ending in a question with NO first'), J(dp.slice(0, 2)));
    r.press('b');
    await until(() => !r.q());
    await sleep(400);
    ok(r.st().open === 'off' && r.win.localStorage.getItem(P.OPEN_KEY) !== '1' && r.win.localStorage.getItem('arena.open.seen') !== '1' && heard.length === 0, T('O11 NO: nothing is published (the board hears nothing), nothing is stored'), J([r.st().open, r.win.localStorage.store, heard.length]));
    r.press('a');
    await until(() => r.q() && r.q().id === HP.DISCLOSURE_ID);
    ok(!!r.q() && r.q().id === HP.DISCLOSURE_ID, T('O12 NO IS NOT REMEMBERED: the next A asks again'), J(r.q()));
    r.pages(); r.press('up'); r.press('a');
    await until(() => r.st().open === 'on' && heard.some((m) => m && m.name), 8000);
    ok(r.st().open === 'on' && r.row('open').value === 'ON' && r.win.localStorage.getItem(P.OPEN_KEY) === '1' && heard.some((m) => m && m.name), T('O13 YES: the player is listed (the board hears the listing), the switch is stored, the row says ON'), J([r.st().open, r.win.localStorage.store, heard.length]));
    const beacon = heard.find((m) => m && m.k === 'open' && typeof m.name === 'string') || {};
    ok(typeof beacon.name === 'string' && beacon.name.length > 0 && r.st().listed === beacon.name && r.msg().includes('You are listed as ' + beacon.name + ':'),
      T('O13b WHAT THE ROW SAYS IS LISTED IS WHAT THE BOARD HEARS: the name in the beacon is the name in the row\'s words (here the store cannot be read, so the listing says "Player" although the menu\'s own data names a trainer: the row follows the listing, not its guess)'), J([beacon.name, r.st().listed, r.msg()]));
    r.press('b'); r.press('down'); r.press('down');
    ok(r.hub.path() === 'main' && mainRow(r).label === 'PLAY ONLINE: OPEN', T('O14 ... and the main menu says PLAY ONLINE: OPEN'), J(mainRow(r)));
    r.goto('online'); at(r, 'open'); r.press('a');
    await until(() => r.st().open === 'off');
    ok(r.st().open === 'off' && !r.q() && r.win.localStorage.getItem(P.OPEN_KEY) !== '1', T('O15 A again switches it off at once'), J(r.st().open));
    r.press('a');
    await until(() => r.st().open === 'on', 8000);
    ok(r.st().open === 'on' && !r.q(), T('O16 ASKED ONCE: switching it on again asks nothing'), J([r.st().open, r.q()]));
    r.end();
    await sleep(100);
    // stored on from an earlier visit: listening from the page's load, on the main menu
    const r2 = mk({ svc: 'real', search: '?net=local', local: { [P.OPEN_KEY]: '1', 'arena.open.seen': '1' } });
    await within(r2.win.__arenaHubPresence ? r2.win.__arenaHubPresence.ready : Promise.resolve(false));
    await until(() => r2.st().open === 'on', 8000);
    r2.hub.press('down'); r2.hub.press('down');
    ok(r2.hub.path() === 'main' && r2.st().open === 'on' && mainRow(r2).label === 'PLAY ONLINE: OPEN' && r2.effects('open').length === 0, T('O17 OPEN STORED ON: the service is listening from the page\'s load on the main menu, the online menu never opened, and the main menu says so'), J([r2.st().open, mainRow(r2)]));
    r2.end();
    // a stored "on" nobody was told about is dropped (presence_boot.js), and the row says OFF
    const r3 = mk({ svc: 'real', search: '?net=local&opendisc=1', local: { [P.OPEN_KEY]: '1' } });
    await within(r3.win.__arenaHubPresence ? r3.win.__arenaHubPresence.ready : Promise.resolve(false));
    await sleep(300);
    ok(r3.st().open === 'off' && r3.win.localStorage.getItem(P.OPEN_KEY) !== '1', T('O18 a stored "on" the player was never told about is not honoured: the row says OFF'), J([r3.st().open, r3.win.localStorage.store]));
    r3.end();
    spy.close();
    ok([w, w2, r, r2, r3].every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('O19 nothing threw'), J([w, w2, r, r2, r3].map((x) => x.errors)));
  }

  /* ---- I: the room in the page's own address ---- */
  if (want('I')) {
    const cases = ['', '?net=local', '?np=K7Q2P&join=1', '?np=k7q2p&join=1&net=local', '?np=AXYZ1&host=1', '?np=AXYZ1', '?np=AXYZ1&host=1&join=1', '?np=ab&join=1', '?np=AB!CD&join=1', '?np=TOOLONG123&host=1', '?np=AXYZ1&join=1&game=Pokemon+Arena', '?np=AXYZ1&join=1&game=Tetris', '?np=&join=1', '?join=1', '?online=1'];
    const bad = [];
    for (const s of cases) {
      const mine = C.inviteFromSearch(s), page = ON.parseOnlineQuery(s), np = new URLSearchParams(s).get('np');
      const same = np === null ? mine === null : mine && (mine.error ? !!page.error && mine.error === page.error : !page.error && mine.room === page.room && mine.role === (page.role || 'guest'));
      if (!same) bad.push(s + ' -> ' + J(mine) + ' vs ' + J(page));
    }
    ok(bad.length === 0 && C.inviteFromSearch('?np=k7q2p').role === 'guest' && C.inviteFromSearch('?np=k7q2p&host=1').room === 'K7Q2P', T('I1 the room of the hub\'s own address is read as the battle page reads it (js/online.js parseOnlineQuery): the same room, the same role, the same refusals in the same words'), bad.join(' ; '));
    // a guest's invitation, opened at the main menu
    const w = mk({ search: '?np=k7q2p&join=1&net=local' });
    const v = w.view();
    ok(w.hub.path() === 'online' && w.st().screen === 'invite' && J(v.online.head) === J(["YOU'RE INVITED", 'ROOM K7Q2P']) && J(w.app.allRows().map((r) => r.id)) === J(['team', 'name', 'go', 'back']) && w.st().row === 'team' && w.row('go').label === 'JOIN THE BATTLE' && v.menu.pitch === 14,
      T('I2 the hub page opened with ?np=ROOM&join=1 in its address shows YOU\'RE INVITED / ROOM <CODE>: TEAM (under the cursor: NOT the button that joins), NAME, JOIN THE BATTLE, BACK'), J([w.hub.path(), v.online.head, w.app.allRows().map((r) => r.id), w.st().row]));
    // THE SCREEN TOOK THE MAIN MENU'S PLACE BY ITSELF: the press that was on its way to the main menu must do nothing here
    const goRect = w.hub.rects().find((r) => r.id === 'go'), team0 = w.st().team;
    for (const a of ['a', 'right', 'left']) w.press(a);          // (on TEAM, where the cursor is)
    w.app.select('go');
    for (const a of ['a', 'a', 'a', 'b', 'start', 'a']) w.press(a);
    const keys = [w.st().screen, w.st().row, w.st().armed, v.online.armed, w.nav.length, w.q() ? w.q().id : null, w.win.sessionStorage.getItem(P.MEET_KEY), w.win.sessionStorage.getItem(P.START_KEY), w.st().team === team0, w.win.replaced.length, w.effects('start').length];
    ok(J(keys) === J(['invite', 'go', false, false, 0, null, null, null, true, 0, 0]),
      T('I2b AN INVITE SCREEN THAT APPEARED BY ITSELF ANSWERS NOTHING AT FIRST: with the cursor even put on JOIN THE BATTLE, A (and B, left, right, START) in the frames after the swap start nothing, ask nothing, change nothing and put nothing away: no MEET or START token, no navigation'), J(keys));
    w.app.select('team');
    w.click(goRect.x + 30, goRect.y + 5); w.click(goRect.x + 30, goRect.y + 5);
    const taps = [w.st().row, w.nav.length, w.q() ? w.q().id : null, w.win.sessionStorage.getItem(P.MEET_KEY)];
    ok(J(taps) === J(['go', 0, null, null]), T('I2c ... nor does a tap on the button (the cursor goes there; nothing is pressed)'), J(taps));
    w.press('up'); w.press('up');
    const moved = w.st().row;
    w.tick(O.INVITE_ARM_TICKS - 1);
    w.app.select('go'); w.press('a');
    const justBefore = [w.st().armed, !!w.q()];
    w.tick(1);
    ok(moved === 'team' && J(justBefore) === J([false, false]) && w.st().armed === true && w.view().online.armed === true && O.INVITE_ARM_TICKS === M.HD.DIALOG_ARM_TICKS && O.INVITE_ARM_TICKS >= 30,
      T('I2d up and down move the cursor meanwhile; the screen starts to listen after the arm delay of a question nobody asked for (0.6 s), not a frame sooner'), J([moved, justBefore, w.st().armed]));
    ok(/^YOU'RE INVITED, ROOM K7Q2P\. JOIN THE BATTLE\. Join room K7Q2P/.test(w.hub.speak(w.view())), T('I2 ... speak() says which screen it is'), w.hub.speak(w.view()));
    // the page was ALREADY on PLAY ONLINE when the room in its address was read (the battle page's CHANGE TEAM link opens .../?np=ROOM&join=1#online: the menu is up for a moment, then the invite screen takes its place)
    const wo = mk({ search: '?np=k7q2p&join=1&net=local', hash: '#online', data: null });
    wo.hub.arrive('online', ['online']); wo.app.select('join'); wo.run([]);
    const swapped = [wo.st().screen, wo.st().row, wo.st().armed];
    wo.press('a'); wo.press('a');
    ok(J(swapped) === J(['invite', 'team', false]) && wo.nav.length === 0 && !wo.q() && !wo.hub.wantsText(), T('I2e ... also when the screen takes the place of the PLAY ONLINE MENU (a page opened at #online): the cursor is on TEAM whatever row it was on, and A in the frames after the swap does nothing'), J([swapped, wo.nav, wo.q()]));
    w.press('a');
    const qi = w.q(), pi = w.pages();
    ok(qi && qi.id === O.FRIEND_ID && qi.armed === true && w.nav.length === 0 && /You join room K7Q2P/.test(pi.flat().join(' ')) && /public servers/.test(pi.flat().join(' ')) && J(lastOf(pi)) === J(['Join room K7Q2P?', '']) && w.view().dialog.choice.cursor === O.NO,
      T('I3 JOIN THE BATTLE starts nothing by itself either: it says what joining connects to and asks JOIN ROOM K7Q2P? (NO first, the first time)'), J([qi, pi.length]));
    w.press('up'); w.press('a');
    const n = w.nav[0];
    ok(w.nav.length === 1 && n.url === '/pokemonarena/battle.html?np=K7Q2P&join=1&meet=1&net=local' && honoured(M, n) === 'join', T('I3b YES writes the MEET token and opens ?np=ROOM&join=1&meet=1'), J(n));
    // TEAM and NAME are the same rows
    at(w, 'team'); w.press('right'); at(w, 'name'); w.press('a'); w.typeText('Ivy'); w.type({ key: 'enter' });
    ok(PR.readOnlinePrefs(w.win.localStorage).teamKey === K.t2 && w.win.localStorage.getItem(C.NAME_KEY) === 'Ivy' && w.st().screen === 'invite', T('I4 TEAM and NAME on the invite screen are stored like the menu\'s'), J(w.win.localStorage.store));
    at(w, 'go'); w.arrive('main', []); w.goto('online');
    ok(w.st().screen === 'invite' && w.st().row === 'team', T('I4b THE CURSOR OF THE INVITE SCREEN IS NEVER PUT ON ITS BUTTON BY ITSELF: opened again from the main menu it starts on its first row, TEAM (a second press of the A that opened PLAY ONLINE changes a team at most)'), J(w.st()));
    // the host's room
    const h = mk({ search: '?np=AXYZ1&host=1&net=local' });
    ok(h.hub.path() === 'online' && J(h.view().online.head) === J(['YOUR ROOM', 'ROOM AXYZ1']) && J(h.app.allRows().map((r) => r.id)) === J(['team', 'size', 'name', 'go', 'back']) && h.row('go').label === 'OPEN THE ROOM' && h.view().menu.pitch === 14 && h.st().row === 'team' && h.st().armed === false,
      T('I5 ?np=ROOM&host=1 shows YOUR ROOM / ROOM <CODE>: TEAM, SIZE, NAME, OPEN THE ROOM, BACK (the cursor on TEAM, the screen not listening yet)'), J([h.view().online.head, h.app.allRows().map((r) => r.id)]));
    h.app.select('go'); h.press('a'); h.press('a');
    const early = [h.nav.length, !!h.q(), h.win.sessionStorage.getItem(P.START_KEY)];
    h.arm(); h.press('a');
    const ph = h.q() ? h.pages() : [];
    h.press('up'); h.press('a');
    const hn = h.nav[0];
    ok(J(early) === J([0, false, null]) && /You open room AXYZ1 for your friend\. It is never listed\./.test(ph.flat().join(' ')) && J(lastOf(ph)) === J(['Open room AXYZ1?', '']) && h.nav.length === 1 && hn.url === '/pokemonarena/battle.html?np=AXYZ1&host=1&net=local' && J(tokenOf(M, hn.start)) === J({ what: 'host', room: 'AXYZ1' }) && honoured(M, hn) === 'room',
      T('I6 OPEN THE ROOM: nothing in the frames after the swap; then the notice and OPEN ROOM AXYZ1?; YES writes the START token { host, room } and opens ?np=ROOM&host=1: that page opens that room'), J([early, ph.length, hn]));
    // BACK puts the room away
    const b = mk({ search: '?np=k7q2p&join=1&net=local', hash: '#online' }); b.arm(); at(b, 'back');
    b.press('a');
    ok(b.hub.path() === 'online' && b.st().screen === 'menu' && J(b.app.allRows().map((r) => r.id)) === J(MENU_IDS) && b.st().row === 'center', T('I7 BACK on the invite screen puts the room away and shows the PLAY ONLINE menu'), J(b.st()));
    ok(b.win.replaced.length === 1 && b.win.replaced[0] === '/pokemonarena/?net=local#online' && b.win.sessionStorage.getItem(C.AWAY_KEY) === 'K7Q2P', T('I8 ... the room leaves the page\'s address (the test seams and the screen stay), so a reload does not bring it back'), J([b.win.replaced, b.win.sessionStorage.store]));
    at(b, 'join'); b.press('a');
    ok(b.view().entry && b.view().entry.value === 'K7Q2P', T('I9 ... JOIN A FRIEND then starts with that room code in the field'), J(b.view().entry && b.view().entry.value));
    b.type({ key: 'escape' }); b.press('b');
    ok(b.hub.path() === 'main', T('I9 ... and B from the menu goes to the main menu'), b.hub.path());
    const b2 = mk({ search: '?np=k7q2p&join=1&net=local' }); b2.arm(); b2.press('b');
    ok(b2.hub.path() === 'online' && b2.st().screen === 'menu' && b2.win.sessionStorage.getItem(C.AWAY_KEY) === 'K7Q2P', T('I10 B on the invite screen is BACK'), J(b2.st()));
    // a reload, or the browser's Back onto an older entry that still names the room
    const again = mk({ search: '?np=k7q2p&join=1&net=local', navType: 'reload', session: { [C.AWAY_KEY]: 'K7Q2P' } });
    ok(again.hub.path() === 'main' && again.st().screen === 'menu' && again.st().invite === null, T('I11 a room that was put away STAYS away over a reload of the tab (the address of an older history entry still names it)'), J(again.st()));
    const other = mk({ search: '?np=ZZZZ9&join=1&net=local', navType: 'reload', session: { [C.AWAY_KEY]: 'K7Q2P' } });
    ok(other.st().screen === 'invite' && other.st().invite.room === 'ZZZZ9', T('I11 ... another room is not affected'), J(other.st()));
    const fresh = mk({ search: '?np=k7q2p&join=1&net=local', navType: 'navigate', session: { [C.AWAY_KEY]: 'K7Q2P' } });
    ok(fresh.hub.path() === 'online' && fresh.st().screen === 'invite' && fresh.win.sessionStorage.getItem(C.AWAY_KEY) === null, T('I12 ... and a FRESH arrival with the same room (the battle page\'s CHANGE TEAM row again) is a new invitation'), J(fresh.st()));
    // a malformed room, both roles
    for (const [search, words] of [['?np=AB!CD&join=1&net=local', 'The room code in the address is not a valid room code.'], ['?np=AXYZ1&host=1&join=1&net=local', 'The address asks to both host and join.'], ['?np=AXYZ1&join=1&game=Tetris', 'This address is for a different game.']]) {
      const m = mk({ search });
      const q0 = m.q();
      m.press('a'); m.press('b');
      const held = !!m.q();
      m.arm();
      const pm = m.q() ? m.pages() : [], said = pm.flat().join(' ');
      ok(m.hub.path() === 'online' && m.st().screen === 'menu' && m.st().invite === null && q0 && q0.id === O.NOTE_ID && q0.armed === false && held && said.includes(words) && /PLAY ONLINE menu/.test(said) && m.nav.length === 0,
        T('I13 an address whose room is not one (' + search + ') is refused IN WORDS, in the picture (a notice the press that was on its way cannot dismiss unread), and the plain menu is shown'), J([m.st().screen, q0, said]));
      ok(pm.length > 0 && m.fits(pm, O.MORE_PX), T('I13b ... and no line of it runs into the "more" arrow (' + search + ')'), J(pm.map((p) => p.map((s) => M.screen.measure(s)))));
    }
    // a player who is already somewhere else is not pulled away
    const c = mk({ search: '?np=k7q2p&join=1&net=local', data: null }); c.goto('quick'); c.data(DATA);
    ok(c.hub.path() === 'quick' && c.st().invite && c.st().invite.room === 'K7Q2P', T('I14 a player who has already walked to another screen is not pulled away by the invitation'), c.hub.path());
    c.tick(60); c.arrive('main', []); c.tick(60); c.goto('online');
    c.app.select('go'); c.press('a');
    ok(c.st().screen === 'invite' && c.st().armed === false && !c.q() && c.nav.length === 0, T('I14 ... it is up when they open PLAY ONLINE, and it starts to listen only THEN: the time spent on other screens does not arm it (the A that opened PLAY ONLINE, pressed twice, joins nobody)'), J(c.st()));
    c.arm(); c.press('a');
    ok(c.q() && c.q().id === O.FRIEND_ID, T('I14 ... 0.6 s on, JOIN THE BATTLE asks its question'), J(c.q()));
    // the model's own guard
    const g = online({ svc: 'none' });
    const refused = [{ room: 'AB', role: 'guest' }, { room: 'K7Q2P', role: 'both' }, { room: 'K7 Q2', role: 'host' }, { room: 12345, role: 'guest' }, null].map((x) => g.app.setInvite(x));
    ok(refused.every((x) => x === false) && g.st().screen === 'menu' && g.app.setInvite({ room: 'k7q2p', role: 'host' }) === true && g.st().invite.room === 'K7Q2P', T('I15 the model shows an invite screen only for a room code and a role (and writes the room in capitals)'), J(refused));
    ok(C.withoutInvite('http://x/pokemonarena/?np=K7Q2P&join=1&host=1&meet=1&game=x&net=local&openchal=900#online') === '/pokemonarena/?net=local&openchal=900#online', T('I16 withoutInvite drops the room and its role from an address and keeps the rest'), '');
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('I17 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- B: the browser blocks the storage ---- */
  if (want('B')) {
    for (const [what, o] of [['a sessionStorage that refuses every write', { sessionBlocked: true }], ['no sessionStorage at all', { noSession: true }]]) {
      const w = online(o); at(w, 'invite'); w.press('a'); w.yes();
      const q = w.q();
      ok(w.nav.length === 0 && q && q.id === O.BLOCKED_ID && q.armed === false, T('B1 (' + what + ') INVITE A FRIEND, after its YES, does not leave: the token could not be written, so the picture SAYS SO first'), J([w.nav, q]));
      w.press('a'); w.press('a'); w.press('a'); w.press('a');
      ok(w.nav.length === 0 && w.q() && w.q().page === 0, T('B2 (' + what + ') the question answers nothing for its first 0.6 s (the A that was on its way)'), J(w.q()));
      w.tick(M.HD.DIALOG_ARM_TICKS - 1); w.press('a');
      const before = [w.q() && w.q().armed, w.q() && w.q().page];
      w.tick(1);
      ok(J(before) === J([false, 0]) && w.q().armed === true && M.HD.DIALOG_ARM_TICKS >= 30, T('B2b (' + what + ') ... the whole arm delay of a question nobody asked for (36 frames), not one frame'), J([before, w.q()]));
      const pages = w.pages(), d = w.view().dialog;
      ok(/blocks the storage/.test(pages.flat().join(' ')) && J(lastOf(pages)) === J([O.WORDS.blockedAsk, '']) && J(d.choice.options) === J(['GO ON', 'BACK']) && w.fits(pages, O.MORE_PX),
        T('B3 (' + what + ') it says the browser blocks the storage and that the next screen asks once more, then GO ON / BACK'), J(pages));
      w.press('a');
      ok(w.nav.length === 1 && w.nav[0].url === '/pokemonarena/battle.html?online=1&ask=host&net=local' && w.nav[0].start === null, T('B4 (' + what + ') GO ON opens ?online=1&ask=host, where the battle page asks one question itself: NEVER a bare ?online=1 with no token (that page sends it straight back)'), J(w.nav));
    }
    const w = online({ sessionBlocked: true }); at(w, 'invite'); w.press('a'); w.yes(); w.arm(); w.press('b');
    ok(!w.q() && w.nav.length === 0 && w.ctl.state().pending === null, T('B5 BACK (B) stays in the menu'), J([w.nav, w.ctl.state()]));
    w.run([{ app: 'online', type: 'leave' }]);
    ok(w.nav.length === 0, T('B6 ... and a stray "leave" with nothing waiting goes nowhere'), J(w.nav));
    // every start has its fallback
    const wq = online({ sessionBlocked: true }); at(wq, 'anyone'); wq.press('a'); wq.pages(); wq.press('up'); wq.press('a');
    ok(wq.nav.length === 0 && wq.q() && wq.q().id === O.BLOCKED_ID, T('B7 BATTLE ANYONE: after the notice\'s YES the same is said'), J(wq.q()));
    wq.tick(40); wq.pages(); wq.press('a');
    ok(wq.nav.length === 1 && wq.nav[0].url === '/pokemonarena/battle.html?online=1&ask=quick&net=local', T('B7 ... and GO ON opens ?online=1&ask=quick'), J(wq.nav));
    const wj = online({ sessionBlocked: true }); at(wj, 'join'); wj.press('a'); wj.typeText('K7Q2P'); wj.type({ key: 'enter' }); await wj.idle(); wj.arm(); wj.yes(); wj.arm(); wj.pages(); wj.press('a');
    ok(wj.nav.length === 1 && wj.nav[0].url === '/pokemonarena/battle.html?np=K7Q2P&join=1&net=local' && !/meet=1/.test(wj.nav[0].url), T('B8 JOIN A FRIEND: the plain invite address ?np=ROOM&join=1, with no meet=1 (that page shows YOU\'RE INVITED and asks)'), J(wj.nav));
    const wh = mk({ search: '?np=AXYZ1&host=1&net=local', sessionBlocked: true }); wh.arm(); wh.app.select('go'); wh.press('a'); wh.yes(); wh.arm(); wh.pages(); wh.press('a');
    ok(wh.nav.length === 1 && wh.nav[0].url === '/pokemonarena/battle.html?np=AXYZ1&host=1&net=local' && wh.nav[0].start === null, T('B9 OPEN THE ROOM: the room\'s own address, where that page asks'), J(wh.nav));
    // a start that did not leave the page (the browser cancelled the navigation; the page double here never leaves): its token is taken back by the next thing the player does, once it is stale
    const ws = online(); at(ws, 'invite'); ws.press('a'); ws.yes();
    const had = ws.win.sessionStorage.getItem(P.START_KEY);
    at(ws, 'size'); ws.press('right');
    const soon = ws.win.sessionStorage.getItem(P.START_KEY);
    ws.clock += C.STALE_MS + 1;
    ws.data(DATA); ws.press('down');
    const idle = ws.win.sessionStorage.getItem(P.START_KEY);
    ws.press('up'); ws.press('right');
    ok(!!had && soon === had && idle === had && ws.win.sessionStorage.getItem(P.START_KEY) === null && C.STALE_MS >= 3000, T('B12 A TOKEN OF A START THAT DID NOT LEAVE THE PAGE IS TAKEN BACK: five seconds on, the next row the player presses or value they change removes it (a press in the moment before the page goes does not, nor does a data refresh or moving the cursor), so it cannot start a battle page opened later by hand'), J([!!had, soon === had, idle === had, ws.win.sessionStorage.store]));
    // ... and so does LEAVING the menu (B, another screen), or coming back into it
    const wv = online(); at(wv, 'invite'); wv.press('a'); wv.yes();
    const hadV = wv.win.sessionStorage.getItem(P.START_KEY);
    wv.clock += C.STALE_MS + 1; wv.press('up'); wv.press('down');
    const movedV = wv.win.sessionStorage.getItem(P.START_KEY);
    wv.press('b');
    ok(!!hadV && movedV === hadV && wv.hub.path() === 'main' && wv.win.sessionStorage.getItem(P.START_KEY) === null, T('B15 ... five seconds on, LEAVING PLAY ONLINE (B to the main menu) removes it too'), J([!!hadV, movedV === hadV, wv.win.sessionStorage.store]));
    const we = online(); at(we, 'invite'); we.press('a'); we.yes();
    const hadE = we.win.sessionStorage.getItem(P.START_KEY);
    we.arrive('main', []);
    const atOnce = we.win.sessionStorage.getItem(P.START_KEY);
    we.clock += C.STALE_MS + 1; we.goto('quick'); we.arrive('main', []);
    const elsewhere = we.win.sessionStorage.getItem(P.START_KEY);
    we.goto('online');
    ok(!!hadE && atOnce === hadE && elsewhere === hadE && we.win.sessionStorage.getItem(P.START_KEY) === null, T('B16 ... and a player who left at once (the token still fresh: it stays) and comes BACK INTO PLAY ONLINE later loses it then'), J([!!hadE, atOnce === hadE, elsewhere === hadE, we.win.sessionStorage.store]));
    const wm = online(); at(wm, 'join'); wm.press('a'); wm.typeText('K7Q2P'); wm.type({ key: 'enter' }); await wm.idle(); wm.arm(); wm.yes();
    const hadMeet = wm.win.sessionStorage.getItem(P.MEET_KEY);
    for (const f of wm.win.listeners('pageshow')) f({ persisted: false });
    const afterFresh = wm.win.sessionStorage.getItem(P.MEET_KEY);
    for (const f of wm.win.listeners('pageshow')) f({ persisted: true });
    ok(!!hadMeet && afterFresh === hadMeet && wm.win.sessionStorage.getItem(P.MEET_KEY) === null, T('B13 ... and the token of a page that comes back from the back / forward cache is taken back at once'), J([!!hadMeet, afterFresh === hadMeet, wm.win.sessionStorage.store]));
    const before14 = wm.win.listeners('pageshow').length;
    wm.ctl.dispose();
    ok(before14 === 1 && wm.win.listeners('pageshow').length === 0, T('B14 dispose() takes the page listener away'), J([before14, wm.win.listeners('pageshow').length]));
    // leaving the screen with the question up
    const wl = online({ sessionBlocked: true }); at(wl, 'invite'); wl.press('a'); wl.yes();
    const upL = wl.q() ? wl.q().id : null, heldL = wl.ctl.state().pending;
    wl.arrive('main', []);
    ok(upL === O.BLOCKED_ID && !wl.q() && wl.nav.length === 0, T('B10 leaving the screen takes the question with it'), J(wl.q()));
    wl.run([{ app: 'online', type: 'leave' }]);
    ok(/ask=host/.test(heldL || '') && wl.ctl.state().pending === null && wl.nav.length === 0, T('B17 ... and the address the question was holding is let go with it: nothing is left behind that a later "go on" could open'), J([heldL, wl.ctl.state(), wl.nav]));
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('B11 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- W: the words and the pictures ---- */
  if (want('W')) {
    const px = M.screen.msgPx, m = (s) => M.screen.measure(s);
    const wide = [];
    // (a function of WORDS takes the name that is listed or shown: ten capitals is the widest a name can be, NAME_MAX of the ROM font's widest letter; the three that take a room take the widest room code)
    const W8 = 'WWWWWWWW', ROOMS = ['joinGo', 'hostGo', 'room'];
    let fns = 0;
    for (const [k, v] of Object.entries(O.WORDS)) {
      const variants = typeof v !== 'function' ? [v] : k === 'anyone' ? [v(W10, true), v(W10, false)] : k === 'friendAsk' || k === 'friendShort' ? ['host', 'join', 'room'].map((kind) => [v(kind, W8)]) : [v(ROOMS.includes(k) ? W8 : W10)];
      if (typeof v === 'function') fns++;
      for (const lines of variants) if (Array.isArray(lines) && /^[a-z]/.test(k) && !['answers', 'blockedOptions'].includes(k)) for (const ln of lines) if (m(ln) > px) wide.push(k + ': ' + ln);
    }
    const widest = Math.max(...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .\'_!?-'].map((ch) => m(ch.repeat(O.NAME_MAX))));
    ok(wide.length === 0 && fns >= 12 && widest <= m(W10) && W10.length === O.NAME_MAX, T('W1 every text of the menu fits the message box in the ROM font (' + px + ' px), with the widest name there can be (ten W: no character a name may hold is wider) wherever a name is named, and the widest room code'), wide.join(' ; ') + ' widest ' + widest + ' W10 ' + m(W10));
    const R = M.screen.app('online');
    const list = scenes(M), shots = {}, problems = [], hashes = {};
    for (const sc of list) {
      const w = sc.make(); worlds.push(w);
      const v = w.view(), f = M.screen.render(v);
      if (f.fault) problems.push(sc.name + ': fault ' + J(f.fault));
      let opaque = f.rgba.length === 240 * 160 * 4; for (let i = 3; opaque && i < f.rgba.length; i += 4) if (f.rgba[i] !== 255) opaque = false;
      if (!opaque) problems.push(sc.name + ': not an opaque 240x160 frame');
      for (const x of M.screen.widths(v)) if (x.px > x.max) problems.push(sc.name + ': ' + x.what + ' ' + x.px + ' > ' + x.max);
      if (v.dialog && v.dialog.more) for (const ln of v.dialog.lines) if (m(ln) > px - O.MORE_PX) problems.push(sc.name + ': a dialog line runs into the "more" arrow: ' + ln);
      if (v.app === 'online' && v.menu) {
        const g = { x: v.menu.x, w: v.menu.w }, edge = g.x + g.w - 4;
        v.menu.rows.forEach((row, i) => {
          const L = R.rowLayout(row, g, i === v.menu.cursor);
          const labelEnd = L.label.x + L.label.px;
          if (L.label.x < g.x + O.OGEOM.label || labelEnd > edge - (L.value ? 0 : O.OGEOM.arrow)) problems.push(sc.name + ': the label of ' + row.id + ' leaves its row');
          if (L.value) {
            const lo = L.left !== null ? L.left + 10 : labelEnd + 4, hi = L.right !== null ? L.right - 1 : edge - O.OGEOM.arrow;
            if (L.value.px > L.value.max || L.value.x < lo || L.value.x + L.value.px > hi) problems.push(sc.name + ': the value of ' + row.id + ' (' + L.value.text + ') leaves its room ' + J([L.value.x, L.value.px, lo, hi]));
            if (L.left !== null && L.left < labelEnd + 1) problems.push(sc.name + ': the left arrow of ' + row.id + ' is on its label');
            if (L.right !== null && L.right + 10 > edge) problems.push(sc.name + ': the right arrow of ' + row.id + ' leaves the window');
          }
        });
        if (v.online.screen === 'invite') { const bl = R.bannerLayout(v.online.head); if (bl.left.px + bl.right.px + 8 > bl.max || bl.left.text !== v.online.head[0] || bl.right.text !== v.online.head[1]) problems.push(sc.name + ': the banner does not hold its two texts'); }
        else if (M.ui.measure(M.ui.fitFont(v.online.head[0], O.OGEOM.title.w - 4, ['normal', 'narrow', 'smallNarrow']), v.online.head[0]) > O.OGEOM.title.w - 4) problems.push(sc.name + ': the title does not fit its window');
      }
      hashes[sc.name] = fnv(f.rgba); shots[sc.name] = f;
    }
    ok(problems.length === 0, T('W2 EVERY SCREEN AND STATE (' + list.length + ' scenes) draws an opaque 240x160 frame from the ROM with no fault; every message, dialog and entry line is inside its window; every row\'s label and value are inside the row and off each other, with a sixteen-W team name and a ten-W trainer name'), problems.slice(0, 4).join(' ; '));
    const names = list.map((s) => s.name), distinct = new Set(Object.values(hashes)).size;
    ok(distinct === names.length, T('W3 no two scenes draw the same picture (the cursor, the value, the arrows, the banner are all in it)'), names.filter((n, i) => names.findIndex((x) => hashes[x] === hashes[n]) !== i).join(','));
    // the cursor and the arrows are IN the picture, where the model's hit test expects them
    {
      const g = O.OGEOM.menu;
      const differ = (a, b, x, y, w, h) => { let n = 0; for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const o = (yy * 240 + xx) * 4; if (shots[a].rgba[o] !== shots[b].rgba[o] || shots[a].rgba[o + 1] !== shots[b].rgba[o + 1] || shots[a].rgba[o + 2] !== shots[b].rgba[o + 2]) n++; } return n; };
      const cur0 = differ('menu-center', 'menu-anyone', g.x + 2, g.y, 8, 12), cur1 = differ('menu-center', 'menu-anyone', g.x + 2, g.y + 12, 8, 12), else0 = differ('menu-center', 'menu-anyone', g.x + 12, g.y, g.w - 30, 24);
      ok(cur0 > 4 && cur1 > 4 && else0 === 0, T('W8 the ROM cursor is drawn beside the row it is on, and moving it changes nothing else in the rows'), J([cur0, cur1, else0]));
      const ty = g.y + 4 * 12, left = differ('menu-team', 'menu-size', g.x + O.OGEOM.value, ty, 10, 12), right = differ('menu-team', 'menu-size', g.x + g.w - 4 - O.OGEOM.arrow, ty, 10, 12);
      ok(left > 4 && right > 4, T('W9 the choice under the cursor stands between the ROM\'s left and right arrows, at the places the hit test halves (OGEOM.value .. the row\'s right end)'), J([left, right]));
      const down = differ('menu-center', 'menu-back', g.x + g.w - 9, g.y + 7 * 12, 9, 12), upA = differ('menu-center', 'menu-back', g.x + g.w - 9, g.y, 9, 12);
      ok(down > 4 && upA > 4, T('W10 the ROM arrows say where the list goes on: down on the last row shown, up on the first once it has scrolled'), J([down, upA]));
      // the screen's name steps aside for a question's YES / NO window (it stood half under it): where its left end was, the picture is the terrain again
      const t = O.OGEOM.title, strip = [t.x - 6, t.y - 6, 6, t.h + 12], env = M.ui.env(0).rgba;          // (the left ring of the name's window: left of any YES / NO window, right of the menu's)
      const vsEnv = (a) => { let n = 0; for (let yy = strip[1]; yy < strip[1] + strip[3]; yy++) for (let xx = strip[0]; xx < strip[0] + strip[2]; xx++) { const o = (yy * 240 + xx) * 4; if (shots[a].rgba[o] !== env[o] || shots[a].rgba[o + 1] !== env[o + 1] || shots[a].rgba[o + 2] !== env[o + 2]) n++; } return n; };
      ok(vsEnv('quick-notice') > 20 && vsEnv('quick-question') === 0 && vsEnv('friend-short') === 0 && vsEnv('blocked-question') === 0, T('W12 while a question shows its YES / NO window the screen\'s name is not drawn (the window stood on its right half, cutting it in two); while only the words are up, it is'), J(['quick-notice', 'quick-question', 'friend-short', 'blocked-question'].map(vsEnv)));
      // an invite screen that does not answer yet shows no cursor (as a dialog that is not armed shows none)
      const gi = O.OGEOM.invite;
      const cur = differ('invite-guest', 'invite-guest-unarmed', gi.x + 2, gi.y, 8, 14), arrows = differ('invite-guest', 'invite-guest-unarmed', gi.x + O.OGEOM.value, gi.y, 10, 14);
      const plain = differ('invite-guest-go', 'invite-guest-unarmed', gi.x + 2, gi.y, gi.w - 2, 2 * 14) + differ('invite-guest-go', 'invite-guest-unarmed', gi.x + 12, gi.y + 2 * 14, gi.w - 12, 2 * 14);
      ok(cur > 4 && arrows > 4 && plain === 0, T('W13 an invite screen that has only just appeared (and answers nothing yet) draws NO row as the one under the cursor: no cursor, no arrows on TEAM (they appear when a press starts to count); its rows are the rows of a screen whose cursor is elsewhere'), J([cur, arrows, plain]));
    }
    // every notice this app puts in the picture, page by page: no line runs into the "more" arrow, and none is wider than the box
    {
      const texts = [C.NOT_A_CODE, C.NO_CODE, C.NO_ROOM_HERE, C.OPEN_FAILED, 'The room code in the address is not a valid room code. The PLAY ONLINE menu is shown instead.', 'The address asks to both host and join. The PLAY ONLINE menu is shown instead.', 'This address is for a different game. The PLAY ONLINE menu is shown instead.'];
      const badNotes = [];
      for (const text of texts) {
        const wn2 = online(); const put = wn2.app.say(text); wn2.arm();
        const pg = wn2.q() && wn2.q().id === O.NOTE_ID ? wn2.pages() : [];
        if (!put || !pg.length || !wn2.fits(pg, O.MORE_PX) || pg.flat().join(' ').replace(/\s+/g, ' ').trim() !== text) badNotes.push(text + ' -> ' + J(pg.map((p) => p.map(m))));
      }
      const wn3 = online();
      ok(badNotes.length === 0 && wn3.app.say('') === false && wn3.app.say('   ') === false && !wn3.q(), T('W11 every notice of this app (a code refused, an address that names no room, a switch that failed) is whole, and no line of a page that is followed by another runs into the "more" arrow; nothing to say opens no box'), badNotes.join(' ; '));
    }
    // the main menu's row fits the main menu
    const mainLabel = (s) => M.ui.measure(M.ui.fitFont(s, 124 - 16, ['normal', 'narrow', 'smallNarrow']), s) <= 124 - 16;
    ok(mainLabel(O.WORDS.mainOpen) && mainLabel(O.WORDS.mainOffline) && O.WORDS.mainOpen.length <= 24 && O.WORDS.mainOffline.length <= 24 && [O.WORDS.mainOpenHelp, O.WORDS.mainOfflineHelp].every((h) => h.length === 2 && h.every((ln) => m(ln) <= px)), T('W4 the main menu\'s row (PLAY ONLINE: OPEN / OFFLINE) fits the main menu\'s window, and its two lines the box'), '');
    // the team's Pokemon in the box
    const wn = online(); at(wn, 'team');
    ok(J(wn.view().msg) === J(['Pikachu, Charizard, Blastoise', 'Venusaur, Lapras, Snorlax']), T('W5 the box under TEAM lists the team\'s Pokemon'), J(wn.view().msg));
    const long = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', readOnly: false, teams: [team('t1', 'Wide', 6, 6, ['WWWWWWWWWW', 'WWWWWWWWWW', 'WWWWWWWWWW', 'MMMMMMMMMM', 'MMMMMMMMMM', 'MMMMMMMMMM', 'Seventh']), team('t2', 'One', 1, 6, ['Solo'])], record: null, tower: null }] };
    const wl = online({ data: long }); at(wl, 'team');
    const two = wl.view().msg;
    ok(two.every((ln) => m(ln) <= px) && two[0] === 'WWWWWWWWWW, WWWWWWWWWW, WWWWWWWWWW' && two[1] === 'MMMMMMMMMM, MMMMMMMMMM +2', T('W5 ... names that do not fit two lines are counted ("+2"), never cut or run past the box'), J(two));
    wl.press('right');
    ok(J(wl.view().msg) === J(['Solo', 'A team of RED.']), T('W5 ... and a short team says whose it is'), J(wl.view().msg));
    // the golden hashes
    if (!tag) {
      if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'FNV-1a hashes of the PLAY ONLINE screens (tools/pokemonarena_hub_online_test.mjs --update). Hashes only: no pixel of the ROM is stored.', screens: hashes }, null, 1) + '\n'); console.log('wrote ' + GOLDEN + ' (' + names.length + ' screens)'); }
      let golden = null; try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).screens; } catch (_e) { golden = null; }
      const off = golden ? names.filter((n) => golden[n] !== hashes[n]).concat(Object.keys(golden).filter((n) => !names.includes(n))) : ['(no golden file: run --update)'];
      ok(off.length === 0, T('W6 every scene equals its hash in pokemonarena/online_hub.golden.json'), off.join(','));
      const out = process.env.ARENA_OUT;
      if (out && process.env.ARENA_SKIP_SHOTS !== '1') {
        const PNG = await import('./arena_png.mjs'); fs.mkdirSync(out, { recursive: true });
        for (const n of names) { const s = PNG.scaleRGBA(240, 160, shots[n].rgba, 3); PNG.writePNG(path.join(out, 'node-' + n + '.png'), s.width, s.height, s.rgba); }
        // ... and contact sheets of twelve scenes each, in the order of scenes() (meant to be opened and LOOKED at: a screen that passes its hash but reads badly is not done)
        for (let i = 0; i < names.length; i += 12) { const c = PNG.gridSheet(names.slice(i, i + 12).map((n) => shots[n]), 3, 2); PNG.writePNG(path.join(out, 'sheet-' + String(i / 12 + 1).padStart(2, '0') + '.png'), c.width, c.height, c.rgba); console.log('sheet ' + (i / 12 + 1) + ': ' + names.slice(i, i + 12).join(', ')); }
      }
    }
    ok(worlds.every((x) => J(x.hub.faults()) === '[]' && x.errors.length === 0), T('W7 nothing threw'), J(worlds.map((x) => x.errors).flat()));
  }

  /* ---- S: the shell's hunk (hub_model.js): an app words its own row of the main menu ---- */
  if (want('S')) {
    const rowOf = (hub, id) => hub.view().menu.rows.find((r) => r.id === id);
    const help = (hub, id) => { hub.arrive('main', []); const i = hub.view().menu.rows.findIndex((r) => r.id === id); for (let k = 0; k < 12 && hub.view().menu.cursor !== i; k++) hub.press('down'); return hub.view().msg; };
    const make = (mainRow) => M.HM.createHubModel({ apps: [fakeApp('online', mainRow === undefined ? {} : { mainRow }), fakeApp('center'), fakeApp('builder')] });
    const plain = make(undefined);
    ok(rowOf(plain, 'online').label === 'PLAY ONLINE' && /Battle a friend/.test(help(plain, 'online').join(' ')), T('S1 an app with no mainRow() leaves its row of the main menu as the menu words it'), J(rowOf(plain, 'online')));
    const worded = make(() => ({ label: 'PLAY ONLINE: OPEN', help: ['one', 'two'] }));
    ok(rowOf(worded, 'online').label === 'PLAY ONLINE: OPEN' && J(help(worded, 'online')) === J(['one', 'two']) && rowOf(worded, 'builder').label === 'TEAM BUILDER' && rowOf(worded, 'quick').label === 'QUICK BATTLE', T('S2 mainRow() -> { label, help } words that app\'s row and its two lines, and no other row'), J(rowOf(worded, 'online')));
    const cases = [[() => { throw new Error('boom'); }, 'throws'], [() => ({ label: 'X'.repeat(25), help: ['a'] }), 'a label of 25 characters and one line of help'], [() => ({ label: 7, help: 'no' }), 'a label that is not a string'], [() => 'PLAY', 'a string'], [() => null, 'null']];
    const kept = cases.map(([fn]) => { try { const h = make(fn); return rowOf(h, 'online').label === 'PLAY ONLINE' && /Battle a friend/.test(help(h, 'online').join(' ')) && J(h.faults()) === '[]'; } catch (_e) { return false; } });
    ok(kept.every(Boolean), T('S3 a mainRow() that throws, or answers anything but a short label and two lines, leaves the row alone (and is no fault of the hub)'), J(kept));
    const labelOnly = make(() => ({ label: 'PLAY ONLINE: OPEN' }));
    ok(rowOf(labelOnly, 'online').label === 'PLAY ONLINE: OPEN' && /Battle a friend/.test(help(labelOnly, 'online').join(' ')), T('S4 a label alone keeps the menu\'s own help'), '');
  }

  /* ---- X: what the files are ---- */
  if (want('X')) {
    const read = (f) => fs.readFileSync(path.join(M.dir, f), 'utf8');
    const impure = /\b(document|window|localStorage|sessionStorage|navigator|setTimeout|setInterval|requestAnimationFrame|Date\.now|Math\.random|performance)\b|\bimport\(/;
    const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
    ok(!impure.test(code(read('online_hub.js'))) && !impure.test(code(read('online_screen.js'))), T('X1 the model and the renderer are pure: no DOM, no storage, no clock, no randomness, no dynamic import'), '');
    const imports = (s) => [...s.matchAll(/^import [^;]* from '\.\/([a-z_]+\.js)';/gm)].map((x) => x[1]).sort();
    ok(J(imports(read('online_hub.js'))) === J(['hub_dialog.js', 'hub_menu.js', 'online_prefs.js', 'textentry.js']) && J(imports(read('online_screen.js'))) === J(['online_hub.js']), T('X2 the two files that load with the hub\'s first paint import only light pure modules (never the engine\'s graph)'), J([imports(read('online_hub.js')), imports(read('online_screen.js'))]));
    ok(J(imports(read('online_ctl.js'))) === J(['hub_presence.js', 'online_prefs.js', 'openlobby.js', 'presence.js']) && /import\('\.\/online\.js'\)/.test(read('online_ctl.js')), T('X3 the ctl reaches the presence service and the preferences, and loads the battle page\'s online.js only when a room code is asked for'), J(imports(read('online_ctl.js'))));
    ok(J(O.APP.paths) === J(['online']) && O.APP.id === 'online' && O.APP.parent('online') === 'main', T('X4 the app keeps the id and the path the registries and the shell\'s fixtures rely on'), J(O.APP.paths));
    if (!tag) {
      const page = (f) => fs.readFileSync(path.join(root, 'pokemonarena', f), 'utf8');
      const ids = /onlineLink|playFriend|trainerCenter|openToggle/;
      ok(!ids.test(page('index.html')) && !/battle\.html\?online=1/.test(page('index.html')) && !/center\.html/.test(page('index.html')), T('X5 THE HTML ROW IS GONE: index.html has no #onlineLink, #playFriend, #trainerCenter or #openToggle, and no link to the online battle page or the Trainer Center page'), '');
      ok(!ids.test(page('arena.css')) && !ids.test(page('audiobar.css')) && !ids.test(read('boot.js')) && !ids.test(read('sound_system.js')), T('X6 ... and nothing hangs on it any more: no rule in arena.css or audiobar.css, no line in boot.js or sound_system.js'), '');
      ok(!/createElement\(|getElementById\(|querySelector\(/.test(code(read('online_ctl.js'))), T('X7 the ctl builds and reads no DOM: everything it says, it says in the picture'), '');
    }
  }
  for (const w of worlds) w.end();
}

/* ------------------------------------------------------------------------------------------------ the mutants: one defect each, in a copy of the game; each must fail the case it names */
const MUTANTS = [
  // ---- online_hub.js
  { id: 'rows-reordered', why: 'BATTLE ANYONE comes before TRAINER CENTER', from: "      { id: 'center', kind: 'item', label: 'TRAINER CENTER' },\n      { id: 'anyone', kind: 'item', label: 'BATTLE ANYONE' },\n", to: "      { id: 'anyone', kind: 'item', label: 'BATTLE ANYONE' },\n      { id: 'center', kind: 'item', label: 'TRAINER CENTER' },\n", fails: 'M1' },
  { id: 'no-scroll', why: 'the list does not follow the cursor past its eighth row', from: 'if (cur < off) off = cur; else if (cur >= off + size) off = cur - size + 1;', to: 'if (cur < off) off = cur;', fails: 'M2' },
  { id: 'no-wrap', why: 'down on the last row stays there', from: "case 'down': S.flash = null; S.cursor = (S.cursor + 1) % n; break;", to: "case 'down': S.flash = null; S.cursor = Math.min(n - 1, S.cursor + 1); break;", fails: 'M3' },
  { id: 'hit-ignores-scroll', why: 'a click takes the row that WAS there before the list scrolled', from: 'const index = w.off + Math.floor((y - g.y) / g.pitch), row = rs[index];', to: 'const index = Math.floor((y - g.y) / g.pitch), row = rs[index];', fails: 'M6' },
  { id: 'prev-zone-gone', why: 'a click on the left arrow of a choice goes forward', from: "x >= g.x + OGEOM.value - 4 && x < mid ? 'prev' : 'main'", to: "false ? 'prev' : 'main'", fails: 'M7' },
  { id: 'view-settles', why: 'reading the view moves the state', from: "      const sel = selection(), rs = rowsOf(sel), g = geom(rs.length), w = windowOf(rs.length, S.offset), cur = clamp(S.cursor, 0, rs.length - 1), up = inviteShown();\n", to: "      S.cursor = (S.cursor + 1) % 9; const sel = selection(), rs = rowsOf(sel), g = geom(rs.length), w = windowOf(rs.length, S.offset), cur = clamp(S.cursor, 0, rs.length - 1), up = inviteShown();\n", fails: 'M8' },
  { id: 'illegal-offered', why: 'a team that is not legal is offered (the battle page does not list it)', from: '      if (!t.legal) continue;\n', to: '', fails: 'T1' },
  { id: 'active-not-first', why: 'the teams are listed in the store\'s order, not the active trainer\'s first', from: 'const ps = ctx.profiles().slice().sort((a, b) => (a.id === act ? -1 : 0) - (b.id === act ? -1 : 0));', to: 'const ps = ctx.profiles().slice();', fails: 'T1' },
  { id: 'prefs-ignored', why: 'the team shown is always the first, whatever is preferred', from: 'const list = choices(), pre = preselect(S.prefs, list, {});', to: 'const list = choices(), pre = preselect({ teamKey: null, fmt: null }, list, {});', fails: 'T2' },
  { id: 'team-not-asked', why: 'TEAM changes in the picture and is never handed to be stored', from: "      return [{ app: ID, type: 'prefs', teamKey: next.key }];", to: '      return [];', fails: 'T3' },
  { id: 'small-team-3v3', why: 'a team of two is offered 3 V 3', from: "formats: choice.size >= 3 ? ['3v3', '6v6'] : ['6v6'] };", to: "formats: ['3v3', '6v6'] };", fails: 'T5' },
  { id: 'loading-pressable', why: 'a row that cannot be used is pressed all the same', from: 'if (!row || row.disabled || S.busy) return [];', to: 'if (!row || S.busy) return [];', fails: 'T8' },
  { id: 'lead-always-mascot', why: 'the Pokemon beside the list never follows the team', from: 'const lead = sel.choice.lead || (base && base.mascot) || null;', to: 'const lead = (base && base.mascot) || null;', fails: 'T10' },
  { id: 'name-ignores-team', why: 'the name is always the active trainer\'s, not the owner of the team chosen', from: "const t = onlineName(sel.choice.trainer || '', '') || onlineName(act ? act.name : '', '');", to: "const t = onlineName(act ? act.name : '', '');", fails: 'N1' },
  { id: 'name-any-length', why: 'the name entry takes any length', from: "max: NAME_MAX, charset: 'name', allowEmpty: true }", to: "max: 64, charset: 'name', allowEmpty: true }", fails: 'N2' },
  { id: 'name-as-typed', why: 'a name the online rule would change is stored as typed', from: '      if (clean !== raw) { openName(clean, WORDS.nameNote); return []; }\n', to: '', fails: 'N3' },
  { id: 'empty-name-kept', why: 'an empty name leaves the typed one in place', from: "      if (!raw) { S.typed = null; return [{ app: ID, type: 'name', value: null }]; }", to: '      if (!raw) return [];', fails: 'N4' },
  { id: 'name-rule-drifts', why: 'the hub\'s name rule lets a comma through (the battle page drops it)', from: "t = t.replace(/[^A-Za-z0-9 .'_!?-]/g, '')", to: "t = t.replace(/[^A-Za-z0-9 .,'_!?-]/g, '')", fails: 'N7' },
  { id: 'quick-unasked', why: 'BATTLE ANYONE starts at once, with no notice', from: "case 'anyone': return askQuick();", to: "case 'anyone': return start('quick');", fails: 'Q1' },
  { id: 'quick-yes-first', why: 'YES is under the cursor', from: 'choice: { options: WORDS.answers.slice(), cursor: NO } }', to: 'choice: { options: WORDS.answers.slice(), cursor: YES } }', fails: 'Q4' },
  { id: 'quick-no-starts', why: 'NO starts the match too', from: 'if (id === QUICK_ID) { if (value !== YES) return [];', to: "if (id === QUICK_ID) { if (value !== YES && value !== NO) return [];", fails: 'Q5' },
  { id: 'hosts-uncapped', why: 'a list of any length is named in full', from: 'const hosts = all.slice(0, HOSTS_SHOWN), more = all.length - hosts.length;', to: 'const hosts = all, more = 0;', fails: 'Q10' },
  { id: 'room-any-length', why: 'the room entry takes more than eight characters', from: "max: ROOM_MAX, charset: 'code', allowEmpty: true }", to: "max: 12, charset: 'code', allowEmpty: true }", fails: 'J1' },
  { id: 'paste-is-typed', why: 'a pasted link is typed key by key (its letters become a room code)', from: "if (S.entryId === 'room' && input && typeof input.text === 'string' && input.text.length > 1)", to: 'if (false)', fails: 'J5' },
  { id: 'busy-not-held', why: 'another row starts while a code is being checked', from: 'if (!row || row.disabled || S.busy) return [];', to: 'if (!row || row.disabled) return [];', fails: 'J7' },
  { id: 'never-woken', why: 'the model returns no effect from onData: the ctl is not up until the menu is opened', from: "onData() { settle(); return [{ app: ID, type: 'data' }]; },", to: 'onData() { settle(); return []; },', fails: 'O1' },
  { id: 'main-row-silent', why: 'the main menu never says the player is open', from: "if (S.open === 'on') return { label: WORDS.mainOpen, help: WORDS.mainOpenHelp };", to: '', fails: 'O2' },
  { id: 'main-row-starting', why: 'the main menu says OPEN while the start is still under way', from: "if (S.open === 'on') return { label: WORDS.mainOpen, help: WORDS.mainOpenHelp };", to: "if (S.open === 'on' || S.open === 'starting') return { label: WORDS.mainOpen, help: WORDS.mainOpenHelp };", fails: 'O2' },
  { id: 'open-by-arrows', why: 'left and right switch OPEN TO BATTLES', from: "case 'left': fx = change(rs[S.cursor], -1); break;", to: "case 'left': fx = rs[S.cursor].id === 'open' ? activate(rs[S.cursor]) : change(rs[S.cursor], -1); break;", fails: 'O5' },
  { id: 'unavailable-pressable', why: 'the switch can be pressed when the presence code could not load', from: "...(S.open === 'unavailable' ? { disabled: true } : {}) });", to: '});', fails: 'O7' },
  { id: 'invite-any-room', why: 'the model shows an invite screen for anything', from: "const ok = !!inv && typeof inv.room === 'string' && /^[A-Za-z0-9]{4,8}$/.test(inv.room) && (inv.role === 'guest' || inv.role === 'host');", to: "const ok = !!inv && typeof inv.room === 'string';", fails: 'I15' },
  { id: 'guest-gets-size', why: 'the guest\'s invite screen has a SIZE row (the host decides the size)', from: "return [teamRow(sel)].concat(host ? [sizeRow(sel)] : [],", to: 'return [teamRow(sel)].concat([sizeRow(sel)],', fails: 'I2' },
  { id: 'invite-back-leaves', why: 'BACK on the invite screen leaves PLAY ONLINE with the room still up', from: "    if (inviteShown()) { S.inviteUp = false; S.cursor = 0; S.offset = 0; S.flash = null; return [{ app: ID, type: 'invite-away' }]; }", to: '', fails: 'I7' },
  { id: 'away-not-told', why: 'the ctl is not told the room was put away (it stays in the address)', from: "S.flash = null; return [{ app: ID, type: 'invite-away' }]; }", to: 'S.flash = null; return []; }', fails: 'I8' },
  { id: 'blocked-unarmed', why: 'the storage question can be answered by the A that was on its way', from: 'cursor: GO_ON }, armTicks: DIALOG_ARM_TICKS });', to: 'cursor: GO_ON } });', fails: 'B2' },
  { id: 'blocked-back-goes', why: 'BACK goes on', from: "if (id === BLOCKED_ID) return [{ app: ID, type: value === GO_ON ? 'leave' : 'stay' }];", to: "if (id === BLOCKED_ID) return [{ app: ID, type: 'leave' }];", fails: 'B5' },
  { id: 'names-run-on', why: 'a team\'s Pokemon run past the box', from: "while (i < names.length && fits(s + ', ' + names[i])) s += ', ' + names[i++];", to: "while (i < names.length && i % 4 !== 0) s += ', ' + names[i++];", fails: 'W5' },
  { id: 'center-nowhere', why: 'TRAINER CENTER opens nothing', from: "case 'center': return deeper('center');", to: "case 'center': return [];", fails: 'M4' },
  { id: 'enter-keeps-cursor', why: 'entered from the main menu, the cursor is wherever it was left (a double press of A acts on that row)', from: 'enter() { if (!S.deeper) { S.cursor = 0; S.offset = 0; } S.deeper = false;', to: 'enter() { S.deeper = false;', fails: 'M12' },
  { id: 'deeper-forgotten', why: 'coming back from the Team Builder the cursor is thrown to the first row', from: 'function deeper(path) { const fx = ctx.go(path); if (fx.length) S.deeper = true; return fx; }', to: 'function deeper(path) { const fx = ctx.go(path); return fx; }', fails: 'M13' },
  { id: 'no-team-no-builder', why: 'with no saved team A on TEAM does nothing', from: "case 'team': return row.kind === 'choice' ? change(row, 1) : deeper('builder');", to: "case 'team': return row.kind === 'choice' ? change(row, 1) : [];", fails: 'T7' },
  { id: 'unavailable-unsaid', why: 'a browser whose storage cannot be opened is told it has no saved team', from: "if (ctx.dataState() === 'unavailable') return WORDS.teamUnavailable;", to: '', fails: 'T7c' },
  { id: 'team-name-as-token', why: 'a team name is handed to the ROM font as it is ({CURSOR} draws the cursor glyph)', from: 'label: plain(t.name),', to: 'label: t.name,', fails: 'T13' },
  { id: 'nicknames-as-tokens', why: 'a Pokemon\'s nickname is handed to the ROM font as it is', from: 'names: (t.names || []).map(plain),', to: 'names: t.names || [],', fails: 'T13' },
  { id: 'trainer-as-token', why: 'a trainer\'s name is handed to the ROM font as it is', from: "'A team of ' + plain(c.trainer) + '.'", to: "'A team of ' + c.trainer + '.'", fails: 'T13' },
  { id: 'listed-is-name-row', why: 'the menu says OPEN TO BATTLES lists the NAME row\'s name (it lists the active trainer\'s)', from: "return onlineName(act ? act.name : '', 'Player');", to: "return nameNow(selection()).text || 'Player';", fails: 'N11' },
  { id: 'name-row-claims-all', why: 'the NAME row says other players see this name, and not that OPEN TO BATTLES lists another', from: "name: (who) => ['Shown in a battle and BATTLE ANYONE.', 'OPEN TO BATTLES lists ' + who + '.'],", to: "name: () => ['Other players see this name. A', \"changes it; empty = your trainer's.\"],", fails: 'N11' },
  { id: 'name-hint-gone', why: 'the name entry does not say what an empty name means', from: 'e.setNote(note || WORDS.nameHint);', to: 'if (note) e.setNote(note);', fails: 'N2' },
  { id: 'name-paste-lost', why: 'a paste into the NAME entry is sent away as a room code and lost', from: "if (S.entryId === 'room' && input && typeof input.text === 'string' && input.text.length > 1)", to: "if (input && typeof input.text === 'string' && input.text.length > 1)", fails: 'N12' },
  { id: 'anyone-row-vague', why: 'the BATTLE ANYONE row does not say whether an online record is listed', from: "(rec ? ' with online record.' : ', no online record.')", to: "'.'", fails: 'Q0' },
  { id: 'anyone-names-trainer', why: 'BATTLE ANYONE names the trainer\'s name, not the one the NAME row holds (the one that is listed)', from: "const quickWho = (sel) => ({ name: nameNow(sel).text || 'Host',", to: 'const quickWho = (sel) => ({ name: trainerListed(),', fails: 'Q8b' },
  { id: 'quick-names-nobody', why: 'the notice does not say which servers', from: "'The battle page connects to ' + s.servers + ' and loads a script from '", to: "'The battle page connects to public servers and loads a script from '", fails: 'Q2' },
  { id: 'quick-says-trainer-name', why: 'the notice says "your trainer name" (it is the NAME row\'s name that is listed)', from: "'the name ' + (typeof w.name === 'string' && w.name ? w.name : 'Host')", to: "'your trainer name'", fails: 'Q2' },
  { id: 'quick-team-unsaid', why: 'the notice does not say the team played goes to the other player', from: "until someone joins. ' + TEAM_GOES;", to: "until someone joins. ';", fails: 'Q2b' },
  { id: 'quick-arrow-room', why: 'a page of a notice runs into the "more" arrow', from: 'const pagesFor = (text, ask) => wrapDialog(text, ctx.measure, ctx.msgPx - MORE_PX).concat', to: 'const pagesFor = (text, ask) => wrapDialog(text, ctx.measure, ctx.msgPx).concat', fails: 'Q3' },
  { id: 'quick-always-short', why: 'the first notice is the short one (the servers are never named)', from: 'S.seen ? quickShort(who) : quickWords(S.board, who, named)', to: 'quickShort(who)', fails: 'Q8' },
  { id: 'quick-before-board', why: 'the notice opens before the menu knows which servers it names', from: "    if (!S.board) { S.flash = WORDS.notReady; return []; }\n    const who = quickWho(selection());", to: '    const who = quickWho(selection());', fails: 'Q9' },
  { id: 'notice-too-long', why: 'a list of server names too long for a notice is not shortened: the notice is refused', from: '    if (pages.length > DIALOG_MAX_PAGES) pages = make(false);          // (a ?wsbroker= list', to: '    // (a ?wsbroker= list', fails: 'Q10b' },
  { id: 'friend-too-long', why: '... and so is the notice of a battle with a friend', from: "    if (pages.length > DIALOG_MAX_PAGES) pages = make(false);\n    S.friend = { kind, room: room || null };", to: '    S.friend = { kind, room: room || null };', fails: 'Q10c' },
  { id: 'notice-follows', why: 'the BATTLE ANYONE notice stays up when the screen is left', from: 'ctx.dialog.close(QUICK_ID); ctx.dialog.close(FRIEND_ID); ctx.dialog.close(BLOCKED_ID);', to: 'ctx.dialog.close(FRIEND_ID); ctx.dialog.close(BLOCKED_ID);', fails: 'Q12' },
  { id: 'quick-any-answer', why: 'any answer but NO (a timeout, a notice closed) starts the public match', from: 'if (id === QUICK_ID) { if (value !== YES) return [];', to: 'if (id === QUICK_ID) { if (value === NO) return [];', fails: 'Q14' },
  { id: 'invite-unasked', why: 'INVITE A FRIEND leaves for the battle page at once: nothing says what that page connects to', from: "case 'invite': return askFriend('host', null, false);", to: "case 'invite': return start('host', null);", fails: 'H1' },
  { id: 'friend-always-short', why: 'the first notice of a battle with a friend is the one line (the servers are never named)', from: 'let pages = S.seen ? [[WORDS.friendShort(kind, room), ask]] : make(true);', to: 'let pages = [[WORDS.friendShort(kind, room), ask]];', fails: 'H1' },
  { id: 'friend-servers-unsaid', why: 'the notice of a battle with a friend names neither the servers nor the IP address', from: "return what + ' ' + connects(serversText(board, named)) + ' ' + TEAM_GOES;", to: "return what + ' ' + TEAM_GOES;", fails: 'H1b' },
  { id: 'friend-team-unsaid', why: '... nor says that the team played goes to the other player', from: "connects(serversText(board, named)) + ' ' + TEAM_GOES;", to: 'connects(serversText(board, named));', fails: 'H1c' },
  { id: 'friend-yes-first', why: 'the first notice of a battle with a friend has YES under the cursor (A mashed through it starts)', from: 'cursor: S.seen ? YES : NO }', to: 'cursor: YES }', fails: 'H1d' },
  { id: 'friend-no-starts', why: 'NO starts the battle with a friend too', from: 'if (value !== YES || !f) return [];', to: 'if (!f) return [];', fails: 'H2' },
  { id: 'invite-is-quick', why: 'INVITE A FRIEND asks for a public match', from: "case 'invite': return askFriend('host', null, false);", to: "case 'invite': return askFriend('quick', null, false);", fails: 'H3' },
  { id: 'friend-never-told', why: 'a YES to the long notice is not remembered', from: 'if (value !== YES || !f) return []; S.seen = true; return start(f.kind, f.room); }', to: "if (value !== YES || !f) return []; return [{ app: ID, type: 'start', kind: f.kind, room: f.room }]; }", fails: 'H3c' },
  { id: 'friend-always-long', why: 'a player who was told before gets the whole notice again', from: 'let pages = S.seen ? [[WORDS.friendShort(kind, room), ask]] : make(true);', to: 'let pages = make(true);', fails: 'H4' },
  { id: 'friend-before-board', why: 'the notice opens before the menu knows which servers it names', from: "    if (!S.board) { S.flash = WORDS.notReady; return []; }\n    const ask = WORDS.friendAsk(kind, room);", to: '    const ask = WORDS.friendAsk(kind, room);', fails: 'H5' },
  { id: 'friend-follows', why: 'the question stays up when the screen is left', from: 'ctx.dialog.close(QUICK_ID); ctx.dialog.close(FRIEND_ID); ctx.dialog.close(BLOCKED_ID);', to: 'ctx.dialog.close(QUICK_ID); ctx.dialog.close(BLOCKED_ID);', fails: 'H6' },
  { id: 'join-answer-lost', why: 'a room code that checks out brings no question (nothing can be joined)', from: "askFriend('join', String(room), true);", to: '', fails: 'J2' },
  { id: 'join-question-unarmed', why: 'the question that follows the check answers the Enter that was still on its way', from: '...(late ? { armTicks: DIALOG_ARM_TICKS } : {}) });', to: '});', fails: 'J2b' },
  { id: 'refused-entry-lost', why: 'a refused code does not bring the entry back', from: 'openRoom(S.room); note(words, true);', to: 'note(words, true);', fails: 'J3' },
  { id: 'note-unarmed', why: 'a notice that comes after a check is dismissed by the press that was on its way', from: 'choice: null, armTicks: DIALOG_ARM_TICKS });', to: 'choice: null });', fails: 'J3b' },
  { id: 'busy-for-ever', why: 'a check that is never answered keeps the buttons for ever', from: "      if (S.busy && --S.busyTicks <= 0) { S.busy = null; S.flash = WORDS.slow; }\n", to: '', fails: 'J8' },
  { id: 'answer-when-gave-up', why: 'a check that comes back after the menu gave up is still heard', from: "    roomTaken(req, room) {\n      if (S.busy !== 'join' || req !== S.req) return false;", to: "    roomTaken(req, room) {\n      if (req !== S.req) return false;", fails: 'J9' },
  { id: 'entry-outlives-screen', why: 'the text entry stays open when the screen is left', from: '      entry.close(); S.entryId = null; S.busy = null; S.flash = null; S.friend = null;\n', to: '      S.entryId = null; S.busy = null; S.flash = null; S.friend = null;\n', fails: 'J10' },
  { id: 'stale-answer-taken', why: 'the answer to an OLDER request is taken for the one in hand (the room the player abandoned is opened)', from: "    roomTaken(req, room) {\n      if (S.busy !== 'join' || req !== S.req) return false;", to: "    roomTaken(req, room) {\n      if (S.busy !== 'join') return false;", fails: 'J12' },
  { id: 'request-not-numbered', why: 'every request carries the same number (an old answer cannot be told from a new one)', from: 'S.busyTicks = BUSY_TICKS; S.req++;', to: 'S.busyTicks = BUSY_TICKS;', fails: 'J13' },
  { id: 'leave-keeps-waiting', why: 'leaving the screen does not give the check up: its answer asks on another screen', from: '      entry.close(); S.entryId = null; S.busy = null; S.flash = null; S.friend = null;\n', to: '      entry.close(); S.entryId = null; S.flash = null; S.friend = null;\n', fails: 'J14' },
  { id: 'refusal-when-not-waiting', why: 'a refusal that comes back after the player left opens the entry and a notice on another screen', from: "    roomRefused(req, words) {\n      if (S.busy !== 'join' || req !== S.req) return false;", to: '    roomRefused(req, words) {', fails: 'J15' },
  { id: 'paste-uncapped', why: 'a paste of any size is handed to the ctl', from: 'text: input.text.slice(0, PASTE_MAX)', to: 'text: input.text', fails: 'J17' },
  { id: 'open-off-vague', why: 'the OPEN TO BATTLES row says "your name" (which name?) and not where it is listed', from: "openOff: (who) => ['Lists trainer name ' + who + ' and', 'online record on public servers. A: on.'],", to: "openOff: () => ['Lists your name and online record', 'so anyone can challenge you. A: on.'],", fails: 'O4' },
  { id: 'open-on-names-nobody', why: 'the row does not say under which name the player is listed', from: "openOn: (who) => ['You are listed as ' + who + ': anyone', 'can challenge you here. A: off.'],", to: "openOn: () => ['You are listed: anyone can challenge', 'you while you are here. A: off.'],", fails: 'O5' },
  { id: 'listing-ignored', why: 'the row guesses the name that is listed where the presence service says it', from: '    if (S.listed) return S.listed;\n', to: '', fails: 'O5b' },
  { id: 'invite-on-button', why: 'the invite screen opens with the cursor on the button that joins', from: '      S.arm = ok ? INVITE_ARM_TICKS : 0;\n', to: "      S.arm = ok ? INVITE_ARM_TICKS : 0;\n      if (ok) selectRow('go');\n", fails: 'I2e' },
  { id: 'invite-unarmed', why: 'an invite screen that appeared by itself answers at once (the A that was on its way to the main menu joins)', from: 'S.arm = ok ? INVITE_ARM_TICKS : 0;', to: 'S.arm = 0;', fails: 'I2b' },
  { id: 'invite-keys-heard', why: 'the keys are heard on an invite screen that is not armed yet', from: "    if (unarmed() && action !== 'up' && action !== 'down') return SILENT.slice();", to: '', fails: 'I2b' },
  { id: 'invite-taps-heard', why: 'a tap is heard on an invite screen that is not armed yet', from: '    if (unarmed()) return SILENT.slice();', to: '', fails: 'I2c' },
  { id: 'invite-arm-short', why: 'the invite screen listens after one frame', from: 'S.arm = ok ? INVITE_ARM_TICKS : 0;', to: 'S.arm = ok ? 1 : 0;', fails: 'I2d' },
  { id: 'invite-go-unasked', why: 'JOIN THE BATTLE leaves at once: nothing says what joining connects to', from: "case 'go': return askFriend(S.invite.role === 'host' ? 'room' : 'join', S.invite.room, false);", to: "case 'go': return start(S.invite.role === 'host' ? 'room' : 'join', S.invite.room);", fails: 'I3' },
  { id: 'invite-go-is-host', why: 'JOIN THE BATTLE opens the room as its host', from: "case 'go': return askFriend(S.invite.role === 'host' ? 'room' : 'join', S.invite.room, false);", to: "case 'go': return askFriend('room', S.invite.room, false);", fails: 'I3' },
  { id: 'cursor-jumps', why: 'every visit to the invite screen throws the cursor onto its button', from: 'S.deeper = false; S.flash = null; settle(); },', to: "S.deeper = false; S.flash = null; if (inviteShown()) selectRow('go'); settle(); },", fails: 'I4b' },
  { id: 'note-arrow-room', why: 'a notice of the app runs into the "more" arrow', from: 'pages: wrapDialog(text, ctx.measure, ctx.msgPx - MORE_PX), choice: null', to: 'pages: wrapDialog(text, ctx.measure, ctx.msgPx), choice: null', fails: 'I13b' },
  { id: 'question-follows', why: 'the storage question stays up when the screen is left', from: 'ctx.dialog.close(QUICK_ID); ctx.dialog.close(FRIEND_ID); ctx.dialog.close(BLOCKED_ID);', to: 'ctx.dialog.close(QUICK_ID); ctx.dialog.close(FRIEND_ID);', fails: 'B10' },
  { id: 'blocked-one-frame', why: 'the storage question listens after one frame', from: 'cursor: GO_ON }, armTicks: DIALOG_ARM_TICKS });', to: 'cursor: GO_ON }, armTicks: 1 });', fails: 'B2b' },
  // ---- online_ctl.js
  { id: 'ctl-back-kept', file: 'online_ctl.js', why: 'a stale arena.back survives: the battle comes back to another screen', from: 'function go(url) { pending = null; clearBack(session); sentAt = now(); env.navigate(url); }', to: 'function go(url) { pending = null; sentAt = now(); env.navigate(url); }', fails: 'H3b' },
  { id: 'ctl-any-code', file: 'online_ctl.js', why: 'a code that is not a room code is taken', from: "    if (!ROOM_RE.test(room)) app.roomRefused(req, room ? NOT_A_CODE : NO_CODE);\n    else app.roomTaken(req, room);", to: '    app.roomTaken(req, room);', fails: 'J3' },
  { id: 'ctl-request-unnamed', file: 'online_ctl.js', why: 'the ctl answers without saying which request it answers (it names whichever is in hand)', from: "case 'join': return join(eff.code, eff.req);", to: "case 'join': return join(eff.code, app.state().req);", fails: 'J12' },
  { id: 'ctl-join-disposed', file: 'online_ctl.js', why: 'a ctl that was disposed still answers when the check comes back', from: "    if (disposed) return;\n    const raw = String(code === undefined", to: '    const raw = String(code === undefined', fails: 'J16' },
  { id: 'ctl-no-redraw', file: 'online_ctl.js', why: 'the page is not told to draw when the service changes', from: 'app.setPresence(svc.status(), safe(() => svc.trainer(), null)); redraw(); }', to: 'app.setPresence(svc.status(), safe(() => svc.trainer(), null)); }', fails: 'O2' },
  { id: 'ctl-listing-untold', file: 'online_ctl.js', why: 'the ctl does not tell the model what the listing says', from: 'app.setPresence(svc.status(), safe(() => svc.trainer(), null)); redraw(); }', to: 'app.setPresence(svc.status()); redraw(); }', fails: 'O13b' },
  { id: 'ctl-open-failure-silent', file: 'online_ctl.js', why: 'a switch that failed says nothing in the picture', from: 'app.say(OPEN_FAILED); onPresence(); });', to: 'onPresence(); });', fails: 'O20' },
  { id: 'ctl-leave-keeps-token', file: 'online_ctl.js', why: 'leaving PLAY ONLINE long after a start that did not leave keeps its token', from: 'leave() { pending = null; takeBack(false); },', to: 'leave() { pending = null; },', fails: 'B15' },
  { id: 'ctl-enter-keeps-token', file: 'online_ctl.js', why: 'coming back to PLAY ONLINE long after a start that did not leave keeps its token', from: 'enter() { takeBack(false); wake(); sync(); onPresence(); },', to: 'enter() { wake(); sync(); onPresence(); },', fails: 'B16' },
  { id: 'ctl-leave-keeps-pending', file: 'online_ctl.js', why: 'the address the storage question was holding outlives the question', from: 'leave() { pending = null; takeBack(false); },', to: 'leave() { takeBack(false); },', fails: 'B17' },
  { id: 'ctl-prefs-dropped', file: 'online_ctl.js', why: 'the team chosen is never stored', from: '          if (!writeOnlinePrefs(storage, patch)) { sync(); app.notStored(); redraw(); }\n', to: '', fails: 'T3' },
  { id: 'ctl-prefs-silent', file: 'online_ctl.js', why: 'a team that could not be stored stays on the row (the battle page will use another)', from: '          if (!writeOnlinePrefs(storage, patch)) { sync(); app.notStored(); redraw(); }\n', to: '          writeOnlinePrefs(storage, patch);\n', fails: 'T11' },
  { id: 'ctl-no-sync', file: 'online_ctl.js', why: 'the stored preference is not read when the page comes up', from: 'function sync() { app.setPrefs(readOnlinePrefs(storage)); app.setName(readName()); app.setSeen(told()); }', to: 'function sync() { app.setName(readName()); app.setSeen(told()); }', fails: 'T6' },
  { id: 'ctl-name-not-removed', file: 'online_ctl.js', why: 'an empty name leaves the old one stored (the battle page keeps using it)', from: "      if (v === null) { storage.removeItem(NAME_KEY); return storage.getItem(NAME_KEY) === null; }\n", to: "      if (v === null) return true;\n", fails: 'N4' },
  { id: 'ctl-name-elsewhere', file: 'online_ctl.js', why: 'the name is stored under a key the battle page does not read', from: "export const NAME_KEY = 'arena.online.name';", to: "export const NAME_KEY = 'arena.hub.name';", fails: 'N8' },
  { id: 'ctl-name-silent', file: 'online_ctl.js', why: 'a name that could not be stored stays on the row', from: "case 'name': if (!writeName(eff.value)) { sync(); app.notStored(); redraw(); } return undefined;", to: "case 'name': writeName(eff.value); return undefined;", fails: 'N9' },
  { id: 'ctl-told-on-open', file: 'online_ctl.js', why: 'the notice is marked as read before anybody said YES', from: "    app.setBoard(boardOf(win));\n", to: "    app.setBoard(boardOf(win)); try { storage.setItem(TOLD_KEY, '1'); } catch (_e) { /* ignore */ }\n", fails: 'Q5' },
  { id: 'ctl-told-never', file: 'online_ctl.js', why: 'a YES is never remembered', from: "    if (seen) safe(() => { if (storage) storage.setItem(TOLD_KEY, '1'); });\n", to: '', fails: 'Q7' },
  { id: 'ctl-hosts-doubled', file: 'online_ctl.js', why: 'a server with two ports is named twice', from: 'return { hosts: [...new Set((Array.isArray(list) ? list : []).map(host).filter(Boolean))], cdn: host(MQTT_LIB) };', to: 'return { hosts: (Array.isArray(list) ? list : []).map(host).filter(Boolean), cdn: host(MQTT_LIB) };', fails: 'Q11' },
  { id: 'ctl-cut-silent', file: 'online_ctl.js', why: 'a paste that was cut to eight characters is not said to be', from: "app.roomPasted(typeof code === 'string' && code ? code : null, cut ? TOO_LONG : '');", to: "app.roomPasted(typeof code === 'string' && code ? code : null, '');", fails: 'J6' },
  { id: 'ctl-deaf', file: 'online_ctl.js', why: 'the ctl does not listen to the presence service: the rows show what it said once', from: '      offSvc = svc.onChange(onPresence);\n', to: '      offSvc = () => {};\n', fails: 'O2' },
  { id: 'ctl-open-is-on', file: 'online_ctl.js', why: 'A on the switch always switches ON (it can never be switched off)', from: 'return Promise.resolve(s.toggle()).then(', to: 'return Promise.resolve(s.turnOn ? s.turnOn() : (s.s.toggles++, true)).then(', fails: 'O15', groups: ['O'] },
  { id: 'ctl-holds-service', file: 'online_ctl.js', why: 'dispose() keeps listening', from: 'dispose() { disposed = true; if (offSvc) safe(() => offSvc()); offSvc = null;', to: 'dispose() { disposed = true;', fails: 'O8' },
  { id: 'ctl-role-swapped', file: 'online_ctl.js', why: 'a host address is read as an invitation to join', from: "return { room: np.toUpperCase(), role: host ? 'host' : 'guest' };", to: "return { room: np.toUpperCase(), role: 'guest' };", fails: 'I1' },
  { id: 'ctl-both-roles', file: 'online_ctl.js', why: 'an address that asks to host AND join is taken as a host\'s', from: "  if (host && join) return { error: 'The address asks to both host and join.' };\n", to: '', fails: 'I1' },
  { id: 'ctl-pulls-away', file: 'online_ctl.js', why: 'an invitation pulls the player away from whatever screen they are on', from: "if (app.setInvite(inv) && model.path() === 'main') env.run(model.goto('online'));", to: "if (app.setInvite(inv)) env.run(model.goto('online'));", fails: 'I14' },
  { id: 'ctl-away-forgotten', file: 'online_ctl.js', why: 'a room that was put away comes back with a reload', from: "    if (navType() !== 'navigate' && awayRoom() === inv.room) return;\n", to: '', fails: 'I11' },
  { id: 'ctl-away-for-ever', file: 'online_ctl.js', why: 'a room that was put away once can never be invited to again in this tab', from: "    if (navType() !== 'navigate' && awayRoom() === inv.room) return;\n", to: '    if (awayRoom() === inv.room) return;\n', fails: 'I12' },
  { id: 'ctl-address-kept', file: 'online_ctl.js', why: 'the room stays in the address after BACK', from: "    safe(() => win.history.replaceState(win.history.state, '', withoutInvite(win.location.href)));\n", to: '', fails: 'I8' },
  { id: 'ctl-bad-room-silent', file: 'online_ctl.js', why: 'a malformed room in the address is dropped without a word', from: "    if (inv.error) { app.say(inv.error + ' The PLAY ONLINE menu is shown instead.'); if (model.path() === 'main') env.run(model.goto('online')); return; }", to: '    if (inv.error) return;', fails: 'I13' },
  { id: 'ctl-blocked-goes', file: 'online_ctl.js', why: 'with the storage blocked the page leaves at once, unsaid', from: '    if (st.token) { go(st.url); return; }\n', to: '    if (true) { go(st.url); return; }\n', fails: 'B1' },
  { id: 'ctl-leave-anywhere', file: 'online_ctl.js', why: 'a "leave" with nothing waiting opens the battle page all the same', from: "case 'leave': if (pending) go(pending); return undefined;", to: "case 'leave': go(pending || '/pokemonarena/battle.html?online=1'); return undefined;", fails: 'B6' },
  { id: 'ctl-token-lingers', file: 'online_ctl.js', why: 'the token of a start that did not leave the page stays in the tab', from: "      if (eff.type !== 'data' && eff.type !== 'dialog') takeBack(false);", to: '', fails: 'B12' },
  { id: 'ctl-token-on-refresh', file: 'online_ctl.js', why: 'a data refresh takes the token of a stale start away (a refresh is not something the player did)', from: "      if (eff.type !== 'data' && eff.type !== 'dialog') takeBack(false);", to: "      if (eff.type !== 'dialog') takeBack(false);", fails: 'B12' },
  { id: 'ctl-token-too-soon', file: 'online_ctl.js', why: 'a press in the moment between the start and the page going takes the token away (the battle page would start nothing)', from: 'if (!sentAt || (!sure && now() - sentAt < STALE_MS)) return;', to: 'if (!sentAt) return;', fails: 'B12' },
  { id: 'ctl-restore-keeps-token', file: 'online_ctl.js', why: 'a page restored from the back / forward cache keeps the token it left with', from: 'const onShow = (e) => { if (e && e.persisted) takeBack(true); };', to: 'const onShow = () => {};', fails: 'B13' },
  { id: 'ctl-listener-leaks', file: 'online_ctl.js', why: 'dispose() leaves the page listener behind', from: " safe(() => win.removeEventListener('pageshow', onShow)); },", to: ' },', fails: 'B14' },
  { id: 'none-legal-unsaid', why: 'a player whose teams are all illegal is told they have no saved team', from: "ctx.profiles().some((p) => (p.teams || []).length > 0) ? WORDS.teamNoneLegal : WORDS.teamNone;", to: 'WORDS.teamNone;', fails: 'T7b' },
  { id: 'ctl-stay-keeps', file: 'online_ctl.js', why: 'BACK leaves the fallback address armed', from: "case 'stay': pending = null; return undefined;", to: "case 'stay': return undefined;", fails: 'B5' },
  // ---- online_screen.js
  { id: 'screen-value-uncut', file: 'online_screen.js', why: 'a long team name is drawn as it is, past its arrows', from: 'const font = h.fitFont(String(row.value), max, FONTS), text = h.fitText(font, String(row.value), max), px = h.width(font, text);\n      return { label, value: { font, text, x: x0 + Math.floor((max - px) / 2), px, max }, left, right };', to: "const font = 'normal', text = String(row.value), px = h.width(font, text);\n      return { label, value: { font, text, x: x0 + Math.floor((max - px) / 2), px, max }, left, right };", fails: 'W2' },
  { id: 'screen-no-arrow-room', file: 'online_screen.js', why: 'a value runs under the scroll arrow', from: "return { label, value: { font, text, x: edge - OGEOM.arrow - px, px, max }, left: null, right: null };", to: 'return { label, value: { font, text, x: edge - px, px, max }, left: null, right: null };', fails: 'W2' },
  { id: 'screen-no-choice-arrows', file: 'online_screen.js', why: 'the choice under the cursor has no left arrow', from: "      if (L.left !== null) h.text(f, 'normal', '{LEFT}', L.left, y, TEXT.dark);\n", to: '', fails: 'W9' },
  { id: 'screen-no-scroll-arrow', file: 'online_screen.js', why: 'nothing says the list goes on below', from: "    if (menu.down) h.text(f, 'normal', '{DOWN}', g.x + g.w - 9, g.y + (n - 1) * pitch + 1, TEXT.dark);\n", to: '', fails: 'W10' },
  { id: 'screen-title-moved', file: 'online_screen.js', why: 'the picture changed (the screen\'s name is drawn one pixel lower) and no golden hash noticed', from: 'h.textCentre(f, font, h.fitText(font, name, t.w - 4), t.x + t.w / 2, t.y + 1, TEXT.dark);', to: 'h.textCentre(f, font, h.fitText(font, name, t.w - 4), t.x + t.w / 2, t.y + 2, TEXT.dark);', fails: 'W6', groups: ['W'], real: true },
  { id: 'screen-no-cursor', file: 'online_screen.js', why: 'the cursor is not drawn', from: "      if (on) h.text(f, 'normal', '{CURSOR}', g.x + 2, y, TEXT.dark);\n", to: '', fails: 'W8' },
  { id: 'screen-cursor-unarmed', file: 'online_screen.js', why: 'an invite screen that does not answer yet shows a row under the cursor as if it did', from: 'on = i === menu.cursor && armed,', to: 'on = i === menu.cursor,', fails: 'W13' },
  { id: 'screen-title-under-question', file: 'online_screen.js', why: 'the screen\'s name is drawn half under a question\'s YES / NO window', from: '} else if (!(view.dialog && view.dialog.choice)) {', to: '} else {', fails: 'W12' },
  // ---- hub_model.js (the shell's hunk)
  { id: 'shell-row-fixed', file: 'hub_model.js', why: 'the main menu ignores an app\'s label', from: "(appRow(it.id) || {}).label || it.label }));", to: 'it.label }));', fails: 'S2' },
  { id: 'shell-help-fixed', file: 'hub_model.js', why: 'the main menu ignores an app\'s two lines', from: "return (appRow(row.id) || {}).help || (it ? it.help : ['', '']);", to: "return it ? it.help : ['', ''];", fails: 'S2' },
  { id: 'shell-any-label', file: 'hub_model.js', why: 'a label of any length is drawn in the main menu', from: "typeof r.label === 'string' && r.label && r.label.length <= 24 ? r.label : null", to: "typeof r.label === 'string' && r.label ? r.label : null", fails: 'S3' },
  { id: 'shell-throws', file: 'hub_model.js', why: 'an app whose mainRow() throws takes the main menu down', from: "    } catch (_e) { return null; }\n  }\n  function mainRows() {", to: "    } catch (e) { throw e; }\n  }\n  function mainRows() {", fails: 'S3' },
];

const isGood = (m) => m.killed && m.named;
function say(m) {
  const good = isGood(m);
  console.log((good ? 'killed  ' : m.killed ? (m.threw ? 'CRASHED ' : 'WRONG CASE') : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.threw ? ' (threw: ' + m.threw + ')' : '') + (good ? ' [' + m.fails + ', ' + (m.ms / 1000).toFixed(1) + ' s]' : m.killed ? '  <-- it failed ' + J(m.first) + ', not the case it names (' + m.fails + ')' : '  <-- the suite did not notice'));
}
async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    if (ONE && mu.id !== ONE) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ho-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file || 'online_hub.js');
      const text = fs.readFileSync(target, 'utf8');
      const n = text.split(mu.from).length - 1;
      if (n !== 1) { const row = { id: mu.id, killed: false, why: 'PATTERN FOUND ' + n + 'x (the mutant did not apply once)' }; out.push(row); say(row); continue; }
      fs.writeFileSync(target, text.replace(mu.from, () => mu.to));
      const before = fail, mark = failures.length, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      const onRej = () => { /* a mutant may leave a rejection unhandled */ };
      process.on('unhandledRejection', onRej);
      const started = Date.now();
      // (the golden hashes are the real tree's: a mutant of the renderer that names W6 runs untagged, so that case is judged)
      const work = load(dir).then((M2) => suite(M2, mu.real ? '' : mu.id, mu.groups || [mu.fails.match(/^[A-Z]+/)[0]]));
      let timer = 0;
      try { await Promise.race([work, new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('mutant run timed out')), 90000); })]); } catch (e) { threw = e; }
      clearTimeout(timer);
      await sleep(10);
      process.off('unhandledRejection', onRej);
      const failedNow = failures.slice(mark), prefix = mu.real ? '' : '[' + mu.id + '] ';
      const named = failedNow.some((f) => f.startsWith(prefix + mu.fails + ' '));
      const row = { id: mu.id, ms: Date.now() - started, killed: fail > before || !!threw, named, fails: mu.fails, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 100) : null, first: failedNow.slice(0, 3).map((f) => f.replace(prefix, '').split(' ')[0]) };
      out.push(row); say(row);
      fail = before; failures.length = mark;
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* ================================================================================================ main */
const t0 = Date.now();
let survived = 0, unnamed = 0;
if (!BROWSER_ONLY) {
  await suite(await load(SRC), '', null);
  console.log(`hub online (node): ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (WANT_MUTANTS) {
    const keep = fail, keepFailures = failures.slice();
    const res = await runMutants();
    fail = keep; failures.length = 0; failures.push(...keepFailures);
    for (const m of res) { if (!m.killed) survived++; else if (!isGood(m)) unnamed++; }
    console.log(`mutants: ${res.length - survived - unnamed}/${res.length} killed by the case they name`);
  }
}
if (!UNIT_ONLY) {
  const { runBrowser } = await import('./pokemonarena_hub_online_browser.mjs');
  await runBrowser({ ok, names: ARGS.filter((a) => !a.startsWith('-')), mutants: WANT_MUTANTS, one: ONE, onlyMutants: WANT_MUTANTS && (!!ONE || ARGS.includes('--only-mutants')) });
  console.log(`hub online: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
if (fail || survived || unnamed) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
