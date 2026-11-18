// tools/pokemonarena_hub_presence_test.mjs -- THE HUB PAGE'S PRESENCE SERVICE (pokemonarena/js/hub_presence.js) and the dialog injection of presence_boot.js, in Node: no browser.
//
//   node tools/pokemonarena_hub_presence_test.mjs             the cases
//   node tools/pokemonarena_hub_presence_test.mjs --mutants   ALSO break hub_presence.js (and the lines of presence_boot.js, hub_dialog.js and battle_ui.js its guarantees rest on) one way at a time;
//                                                              every break must fail a named case. ARENA_HP_MUTANT=<id> runs one.
//
// NOTHING IS FAKED BELOW THE PAGE: the service runs on a real hub model (hub_model.js, with its real dialog layer), the real renderer and ROM font (battle_ui.js, hub_screen.js), the real
// presence_boot.js mount (its DOM dialogs replaced by the service's, which is the point), the real presence.js and the real board (openlobby.js) over the same-browser transport: Node's own
// BroadcastChannel, the transport net=local uses in a browser. "Another browser" is a second board instance on that channel; two hub pages are two services with a window double each.
// What is doubled: window (storage, location, listeners), document (nothing is in it), the profile store (Node has no IndexedDB: the trainer reads as "Player"), and navigation (recorded).
//
// The cases:
//   A  the words: who wants to battle and what YES does; a hostile name; the disclosure's pages; every line fits the ROM message box
//   B  the roster (playersOf)
//   C  the way to the battle page and back: battleStart agrees with what the battle page honours (presence.js startPlan on online.js parseOnlineQuery: INAPP.md "Contract 1"), the test seams ride
//      along, and the back key (INAPP.md "Contract 6")
//   D  the disclosure in the picture: nothing published before YES, NO not remembered, asked once, a stored "on" nobody was told about dropped, on for this page only
//   E  the challenge in the picture: NO is the default, B answers NO, YES inert for 600 ms, a held direction cannot drift onto YES, one at a time, the automatic NO, the asker's cancel, YES writes
//      the token and then navigates, no token = busy
//   F  DOM panels: the question waits while one is open, and appears when it closes
//   G  the service: one per page, the players, asking one of them, leaving for a battle, dispose, a module that cannot load
//   H  presence_boot.js with injected dialogs, driven without a DOM button
// The page half (real Chrome, real keys, the real Controls dialog) is tools/pokemonarena_online_page_test.mjs, groups `presence` and `presenceui`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRom } from './pokemonarena_hub_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const WANT_MUTANTS = process.argv.includes('--mutants');
const ONE = process.env.ARENA_HP_MUTANT || '';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail ? String(detail).slice(0, 400) : ''); } }
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (a run that was given up on -- a mutant that hung its suite -- stops at its next wait: `gaveUp` holds the tags of such runs)
const gaveUp = new Set();
const cleanups = new Map();          // tag -> the function that takes that run's pages and boards down
let running = '';
const settle = async (cond, ms = 2000) => { const mine = running, t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) { if (gaveUp.has(mine)) throw new Error('given up'); await sleep(5); } return !!cond(); };
// a promise of the service that a defect keeps from ever settling must fail a case, not hang the run
const within = (p, ms = 4000) => Promise.race([p, new Promise((r) => setTimeout(() => r('NEVER SETTLED'), ms))]);
const NOQ = Object.freeze({ id: null, app: null, page: -1, pages: 0, armed: null, ticksLeft: null, choice: Object.freeze({ options: Object.freeze([]), cursor: -1 }) });
const PK_FAKE = 'A'.repeat(43) + '.' + 'B'.repeat(43);          // the SHAPE of a one-time key (the board checks shapes; the maths is tools/pokemonarena_presence_test.mjs group L)
const CHANNEL = 'bemental-arena-open-1';
const rom = readRom();
let hexSeq = 0;
const hex16 = () => (0xc0de0000 + ++hexSeq).toString(16).padStart(16, '0');

const memStorage = (init = {}) => { const store = { ...init }; return { store, getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; };
/** A window double: storage, an address, listeners that can be fired, the same-browser transport. */
function makeWin(search, { local = {}, session = {}, noSession = false } = {}) {
  const ls = new Map();
  const win = {
    location: { search, origin: 'http://x', assign() {} },
    localStorage: memStorage(local), sessionStorage: noSession ? null : memStorage(session),
    performance: { now: () => performance.now() }, crypto: globalThis.crypto, BroadcastChannel: globalThis.BroadcastChannel,
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
    console: { warn() {}, error() {}, log() {} },
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener(t, f) { if (ls.has(t)) ls.get(t).delete(f); },
    fire(t, e = {}) { for (const f of [...(ls.get(t) || [])]) f(e); },
    listening: (t) => (ls.get(t) || new Set()).size,
  };
  return win;
}
const makeDoc = () => ({ hidden: false, getElementById: () => null, addEventListener() {}, removeEventListener() {} });
/** A hub app that does nothing: the service asks the hub model which screen is open (INAPP.md "Contract 6"), so the model needs screens named 'center' and 'builder'. */
const fakeApp = (id, paths) => {
  const desc = { id, paths: Object.freeze(paths.slice()), parent: () => 'main', create: (c) => ({ id, paths: desc.paths, parent: desc.parent, enter() {}, leave() {}, press: (_p, a) => (a === 'b' ? c.back() : []), hit: () => null, pointer: () => [], rects: () => [], tick() {}, view: (_p, base) => ({ ...base }), onData() {}, wantsText: () => false, type: () => [], speak: () => '', title: () => 'Fake', state: () => ({}) }) };
  return Object.freeze(desc);
};

/** The game's modules, from `dir` (the real tree, or a copy with one defect). */
async function load(dir) {
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [HM, HS, HD, B, HP, P, OL, O, T, OM, R] = await Promise.all(['hub_model.js', 'hub_screen.js', 'hub_dialog.js', 'battle_ui.js', 'hub_presence.js', 'presence.js', 'openlobby.js', 'online.js', 'tables.js', 'online_match.js', 'rom.js'].map(imp));
  const ui = B.createBattleUi(rom), screen = HS.createHubScreen(ui), pack = T.loadPack(rom, { verify: 'header', dexText: false });
  return { HM, HS, HD, B, HP, P, OL, O, ui, screen, pack, fp: OM.engineFingerprint(pack), romSha: R.PINNED.sha256, boot: () => imp('presence_boot.js') };
}

async function suite(M, tag) {
  running = tag;
  const { HP, P, O, HD } = M;
  const T = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const worlds = [];
  /** One hub page: a window double, a real hub model, the service. `press` / `tick` carry the model's effects out the way boot.js run() does (a dialog answer with no app goes to the service). */
  function world(search = '?net=local', o = {}) {
    const win = makeWin(search, o), doc = makeDoc();
    const hub = M.HM.createHubModel({ mascot: 25, env: 0, measure: M.screen.measure, msgPx: M.screen.msgPx, measureFont: M.screen.measureFont, apps: [fakeApp('center', ['center', 'center-pc']), fakeApp('builder', ['builder'])] });
    hub.setData({ state: 'ready', activeId: null, profiles: [] });
    const w = { win, hub, nav: [], panel: false, changes: 0 };
    w.env = { win, doc, model: hub, pack: M.pack, ui: M.ui, hook: { dialogOpen: () => w.panel }, button: null, loadBoot: o.loadBoot || M.boot,
      navigate: (url) => { const ss = win.sessionStorage; w.nav.push({ url, back: HP.readBack(ss), accept: ss ? ss.getItem(P.ACCEPT_KEY) : null, start: ss ? ss.getItem(P.START_KEY) : null, meet: ss ? ss.getItem(P.MEET_KEY) : null }); } };
    w.svc = HP.hubPresence(w.env);
    w.svc.onChange(() => { w.changes++; });
    w.run = (fx) => { for (const e of fx || []) if (e && e.type === 'dialog' && typeof e.app !== 'string') w.svc.answer(e); return fx; };
    w.press = (a, info) => w.run(hub.press(a, info));
    w.tick = (n = 1) => { for (let i = 0; i < n; i++) w.run(hub.tick()); };
    w.click = (x, y) => w.run(hub.pointer({ kind: 'click', x, y }));
    w.cur = () => hub.dialog.current();
    w.q = () => hub.dialog.current() || NOQ;          // (the same, for reading a field: a question that is not there reads as NOQ, it does not throw)
    w.dv = () => hub.view().dialog || null;
    w.text = () => { const v = w.dv(); return v ? v.lines.filter(Boolean).join(' ') : null; };
    w.setPanel = (v) => { w.panel = !!v; w.svc.panels(); };
    w.sid = () => w.svc.boardId();
    w.end = () => { try { w.svc.dispose(); } catch (_e) { /* ignore */ } };
    worlds.push(w);
    return w;
  }
  /** "Another browser" on the board: asks an owner for a battle and hears the answers. Each has its own sender id (somebody told no is answered no quietly for 20 s). */
  const askers = [];
  function asker(name = 'Zed') {
    const lob = M.OL.createOpenLobbies({ bus: M.OL.createLocalBus({ BroadcastChannel: globalThis.BroadcastChannel }), now: () => performance.now(), mine: { rom: M.romSha, fp: M.fp } });
    const a = { lob, heard: [], sid: lob.sid, name };
    lob.onSignal((m) => a.heard.push(m));
    a.ask = (to, extra = {}) => { const r = hex16(); lob.signal('chal', { to, r, name, pk: PK_FAKE, ...extra }); return r; };
    a.cancel = (to, r) => lob.signal('can', { to, r });
    a.told = (r, k) => a.heard.filter((m) => m.r === r && (!k || m.k === k));
    a.close = () => { try { lob.close(); } catch (_e) { /* ignore */ } };
    askers.push(a);
    return a;
  }
  /** Everything said on the board, as any other browser hears it. */
  const spyCh = new globalThis.BroadcastChannel(CHANNEL), wire = [];
  spyCh.onmessage = (e) => wire.push(e.data);
  const listed = () => wire.filter((m) => m && m.k === 'open');
  const endAll = async () => { for (const w of worlds.splice(0)) w.end(); for (const a of askers.splice(0)) a.close(); await sleep(15); };
  cleanups.set(tag, async () => { await endAll(); try { spyCh.close(); } catch (_e) { /* ignore */ } });
  const shown = (w, id) => { const c = w.cur(); return !!c && c.id === id; };
  /** The question is in the picture and listens. */
  const armed = async (w, id) => { if (!(await settle(() => shown(w, id)))) return false; w.tick(HD.DIALOG_ARM_TICKS); return w.q().armed === true; };
  const lastPage = (w) => { const c = w.q(); for (let i = c.page; i < c.pages - 1; i++) w.press('a'); return w.q(); };

  // a block of the suite that throws records a failure of its own (and the blocks after it still run); its pages and boards are taken down either way
  let blockNo = 0;
  const block = async (fn) => { const k = ++blockNo; try { await fn(); } catch (e) { if (/given up/.test(String(e && e.message))) throw e; ok(false, T('X' + k + ' block ' + k + ' of the suite threw'), String(e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e)); } finally { await endAll(); } };
  try {
    /* ============================================================ A. the words */
    await block(async () => {
      const m = M.screen.measureFont, px = M.screen.msgPx;
      const hub = M.HM.createHubModel({ mascot: 25, env: 0, measure: M.screen.measure, msgPx: M.screen.msgPx, measureFont: M.screen.measureFont });
      hub.setData({ state: 'ready', activeId: null, profiles: [] });
      const drawn = (pages) => {          // every page of a question, drawn by the real renderer: no fault, and every line within its window
        hub.dialog.open({ id: 't', pages, choice: { options: HP.ANSWERS.slice(), cursor: HP.NO } });
        const out = { fault: null, wide: [], pages: [] };
        try {
          for (let p = 0; p < pages.length; p++) {
            const v = hub.view(), f = M.screen.render(v);
            if (f.fault) out.fault = f.fault;
            for (const x of M.screen.widths(v)) if ((x.what === 'dialog' || x.what === 'dialog option') && x.px > x.max) out.wide.push(x);
            out.pages.push(v.dialog);
            hub.press('a');
          }
        } catch (e) { out.fault = 'threw: ' + String(e && e.message ? e.message : e); }
        hub.dialog.close('t');
        return out;
      };
      const plain = HP.challengePages({ name: 'Chad', rec: null, fmtText: '3 v 3' }, m, px);
      ok(plain.length === 2 && J(plain[0]) === J(['Chad', 'wants to battle you.']) && /^YES opens a 3 v 3 battle with them and leaves this screen\.$/.test(plain[1].join(' ')), T('A1 the question says who wants to battle, then what YES does (a 3 v 3 battle with them, and this screen is left)'), J(plain));
      const rec = HP.challengePages({ name: 'REDREDREDR', rec: [128, 37], fmtText: '3 v 3' }, m, px);
      ok(rec[0][0] === 'REDREDREDR (128-37 online)' && rec[0][1] === 'wants to battle you.', T('A2 a challenger with an online record is shown with it: NAME (W-L online)'), J(rec[0]));
      const noRec = [[1], [1, 2, 3], ['1', '2'], [-1, 2], [1.5, 2], 'x', 7].map((r) => HP.challengePages({ name: 'N', rec: r }, m, px)[0][0]);
      ok(noRec.every((s) => s === 'N'), T('A3 a record that is not [wins, losses] is not shown'), J(noRec));
      const hostile = HP.challengePages({ name: '{CURSOR}{NOPE}}{<img src=x onerror=1>', rec: null, fmtText: '<b>' }, m, px);
      const all = hostile.flat().join(' ');
      ok(/^[A-Za-z0-9 .'_!?-]{1,10}$/.test(hostile[0][0]) && !/[{}<>=]/.test(all) && !/<b>/.test(all), T('A4 a HOSTILE NAME is plain text: a name full of braces and markup reaches the picture as the letters a trainer name may have, and no ROM token ({CURSOR}) with it'), J(hostile));
      ok(HP.challengePages({ name: '', rec: null }, m, px)[0][0] === 'Player' && HP.challengePages(null, m, px)[0][0] === 'Player' && HP.challengePages({ name: { toString() { return '{UP}'; } } }, m, px)[0][0] === 'UP', T('A4b no name, or a name that is not a string, is still a name'), '');
      const dWide = drawn(HP.challengePages({ name: 'WWWWWWWWWW', rec: [999999, 999999], fmtText: '3 v 3' }, m, px));
      ok(!dWide.fault && dWide.wide.length === 0, T('A5 the widest name with the largest record still fits the message box (the renderer narrows the font)'), J(dWide.wide));
      // the dialog layer itself: a line of raw braces and characters the ROM font lacks is drawn, never thrown on (what the font cannot draw is a "?")
      const raw = drawn([['{NOPE}{{}} {CURSOR} ' + String.fromCharCode(0xe9, 0x4e2d, 0x6587) + ' <tag>', '}}}{{{ {UNKNOWN_TOKEN_THAT_IS_LONG}']]);
      ok(!raw.fault && raw.pages.length === 1, T('A6 the dialog layer draws ANY text: braces, a token that is not one, characters the ROM font lacks (no fault)'), J(raw.fault));
      const disc = HP.disclosurePages(m, px), words = disc.slice(0, -1).flat().join(' ');
      ok(/trainer name/.test(words) && /online record \(wins and losses\)/.test(words) && /public servers/.test(words) && /Play online/.test(words) && /challenge you/.test(words) && /no team, no profile/.test(words) && /switching it off/.test(words) && /battle against the computer/.test(words),
        T('A7 the disclosure says what is published (trainer name, online record), where (public servers), who sees it, that nothing else is shared, and how it stops'), words);
      ok(J(disc[disc.length - 1]) === J([HP.DISCLOSURE_ASK, '']) && /\?$/.test(HP.DISCLOSURE_ASK) && disc.length >= 3 && disc.length <= 16, T('A8 its LAST page is the question alone (the options are drawn with it), and it is within the dialog layer\'s 16 pages'), J([disc.length, disc[disc.length - 1]]));
      const dDisc = drawn(disc);
      const tight = disc.slice(0, -1).flat().filter((ln) => m('normal', ln) > px - HP.MORE_PX);
      ok(!dDisc.fault && dDisc.wide.length === 0 && tight.length === 0, T('A9 every page of it fits, and every page that is followed by another leaves the "more" arrow its room'), J([dDisc.wide, tight]));
      const also = HP.disclosurePages(m, px, '  In the Trainer Center your look and where you stand are listed too. '), alsoWords = also.slice(0, -1).flat().join(' ');
      ok(/battle against the computer is open\. In the Trainer Center your look and where you stand are listed too\.$/.test(alsoWords) && J(also[also.length - 1]) === J([HP.DISCLOSURE_ASK, '']) && HP.disclosurePages(m, px, 'x'.repeat(5000)).length <= 16 && HP.disclosurePages(m, px, 7).length === disc.length,
        T('A10 a host can add ONE sentence (the Trainer Center: what walking in lists): it follows the standard words, the question stays last, and it cannot push the question past the 16 pages'), alsoWords.slice(-120));
      ok(J(HP.ANSWERS) === J(['YES', 'NO']) && HP.YES === 0 && HP.NO === 1 && HP.ANSWERS[HP.NO] === 'NO' && HP.NO === HP.ANSWERS.length - 1, T('A11 the answers are YES then NO: NO is the LAST option (the one B answers)'), J([HP.ANSWERS, HP.YES, HP.NO]));
    });

    /* ============================================================ B. the roster */
    await block(async () => {
      const list = [
        { s: 'a'.repeat(16), room: 'HABCD', name: 'RED', fmt: '3v3', q: 0, h: 1, rec: [3, 1], av: 'w0000a1', compatible: true, first: 1 },
        { s: 'b'.repeat(16), room: 'AK7Q2', name: 'BLUE', fmt: '6v6', q: 1, h: 0, rec: null, av: null, compatible: true, first: 2 },
        { s: 'c'.repeat(16), room: 'AZZZ9', name: 'OLD', fmt: '3v3', q: 0, h: 0, rec: [1], compatible: false, first: 3 },
        null, { room: 'X' }, { s: 7, name: 'x' }, { s: 'd'.repeat(16) },
      ];
      const pl = HP.playersOf(list);
      ok(pl.length === 3 && J(pl.map((p) => [p.id, p.name, p.doing, p.room, p.fmt, p.compatible])) === J([['a'.repeat(16), 'RED', 'menu', null, '3v3', true], ['b'.repeat(16), 'BLUE', 'looking', 'AK7Q2', '6v6', true], ['c'.repeat(16), 'OLD', 'waiting', 'AZZZ9', '3v3', false]]),
        T('B1 the board\'s list becomes the players a screen meets, in the board\'s order: who, what they are doing (menu / looking / waiting), the room to join, the size, whether they run the same game'), J(pl.map((p) => [p.name, p.doing, p.room])));
      ok(pl[0].room === null && pl[0].entry === list[0] && pl[1].entry === list[1], T('B2 a player who is open from the menu has NO room to join (their label is never offered as one); each carries the board\'s own record for challenge()'), J(pl[0].room));
      ok(J(pl[0].rec) === J([3, 1]) && pl[0].look === 'w0000a1' && pl[1].rec === null && pl[1].look === null && pl[2].rec === null, T('B3 the record and the look are passed on when they are there, and null when they are not (or are not what they should be)'), J(pl.map((p) => [p.rec, p.look])));
      ok(J(HP.playersOf(null)) === '[]' && J(HP.playersOf('x')) === '[]' && J(HP.playersOf([])) === '[]', T('B4 no list: no players'), '');
    });

    /* ============================================================ C. to the battle page, and back */
    await block(async () => {
      const NOW = 1700000000000, SEARCH = '?net=local&openchal=5000&anim=0&team=ARENA1.x&np=ZZZZ9&auto=host#top';
      const go = (kind, room, ss = memStorage(), search = '') => ({ ss, st: HP.battleStart(kind, room, { session: ss, now: NOW, search }) });
      const q = (st) => O.parseOnlineQuery(st.url.slice(st.url.indexOf('?')));
      const plan = (x) => P.startPlan(P.takeStartToken(x.ss, NOW + 500), q(x.st));
      const host = go('host'), quick = go('quick'), room = go('room', 'k7q2p');
      ok(host.st.url === '/pokemonarena/battle.html?online=1' && host.st.token === true && plan(host) === 'host', T('C1 INVITE A FRIEND: a START token and the plain ?online=1 address, which the battle page reads as "open a friend\'s room"'), J(host.st));
      ok(quick.st.url === '/pokemonarena/battle.html?online=1' && quick.st.token === true && plan(quick) === 'quick', T('C2 BATTLE ANYONE: the same address with a token that says "find an opponent"'), J(quick.st));
      ok(room.st.url === '/pokemonarena/battle.html?np=K7Q2P&host=1' && room.st.token === true && plan(room) === 'room', T('C3 OPEN THE ROOM: ?np=ROOM&host=1 with a token for THAT room, which the battle page reads as "open this room"'), J(room.st));
      const join = go('join', 'k7q2p'), jq = q(join.st);
      ok(join.st.url === '/pokemonarena/battle.html?np=K7Q2P&join=1&meet=1' && join.st.token === true && jq.meet === true && jq.role === 'guest' && jq.room === 'K7Q2P' && P.takeMeetToken(join.ss, jq.room, NOW + 500) === true, T('C4 JOIN A FRIEND (and the Trainer Center): ?np=ROOM&join=1&meet=1 with the MEET token for that room'), J(join.st));
      ok([host, quick, room, join].every((x) => Object.keys(x.ss.store).length === 0), T('C5 each token was used up by the page that took it'), '');
      const again = [host, quick, room].map((x) => P.startPlan(P.takeStartToken(x.ss, NOW + 900), q(x.st)));
      ok(again.every((p) => p === null), T('C6 the same addresses again, with no token left, start nothing'), J(again));
      const nh = HP.battleStart('host', null, { session: null, now: NOW }), nq = HP.battleStart('quick', null, { session: null, now: NOW }), nr = HP.battleStart('room', 'K7Q2P', { session: null, now: NOW }), nj = HP.battleStart('join', 'K7Q2P', { session: null, now: NOW });
      ok(nh.url === '/pokemonarena/battle.html?online=1&ask=host' && nq.url === '/pokemonarena/battle.html?online=1&ask=quick' && nr.url === '/pokemonarena/battle.html?np=K7Q2P&host=1' && nj.url === '/pokemonarena/battle.html?np=K7Q2P&join=1' && [nh, nq, nr, nj].every((x) => x.token === false),
        T('C7 when the token cannot be written (storage blocked) the address says so: ?online=1&ask=host / &ask=quick where the page asks once, the plain room address, the plain invite (no meet=1)'), J([nh, nq, nr, nj].map((x) => x.url)));
      const stuck = memStorage(); stuck.setItem = () => { throw new Error('blocked'); };
      ok(HP.battleStart('host', null, { session: stuck, now: NOW }).url.endsWith('&ask=host') && HP.battleStart('join', 'K7Q2P', { session: stuck, now: NOW }).url.endsWith('&join=1'), T('C7b ... and a storage that throws is a storage that is blocked'), '');
      const bad = memStorage();
      ok([['room', 'no'], ['room', 'has space'], ['room', null], ['join', ''], ['join', 'toolongcode'], ['join', 7], ['fly', 'K7Q2P'], [undefined, 'K7Q2P']].every(([k, r]) => HP.battleStart(k, r, { session: bad, now: NOW }) === null) && Object.keys(bad.store).length === 0,
        T('C8 a kind that is not one, or a room that is not a room code, gives no address and writes NOTHING'), J(bad.store));
      const pass = HP.passThrough(SEARCH);
      ok(pass === '&net=local&anim=0&openchal=5000' && HP.passThrough('') === '' && HP.passThrough('?team=x&np=AAAA1') === '' && HP.passThrough(null) === '', T('C9 the test seams of the hub page\'s address ride along (net, anim, openchal ...), and NOTHING else does: no team, no room, nothing that starts a game'), pass);
      const seamed = go('host', null, memStorage(), SEARCH), sq = q(seamed.st);
      ok(seamed.st.url === '/pokemonarena/battle.html?online=1&net=local&anim=0&openchal=5000' && sq.role === null && sq.room === null && sq.auto === null && plan(seamed) === 'host', T('C10 so a hop from a hub page with test seams and stray parameters is still the plain address plus the seams'), seamed.st.url);
      ok(J(HP.PASS_PARAMS) === J(['net', 'anim', 'arenaturn', 'arenagrace', 'openquick', 'openchal', 'openjoin', 'openhold', 'opendisc']), T('C11 the seams that ride along are the ones the battle page reads'), J(HP.PASS_PARAMS));
      // the back key
      const ss = memStorage();
      ok(HP.BACK_KEY === 'arena.back' && HP.writeBack(ss, 'center') === true && ss.store['arena.back'] === 'center' && HP.readBack(ss) === 'center', T('C12 the screen to come back to is kept under arena.back (a hub path)'), J(ss.store));
      const refused = ['main', 'Center', 'center!', '-center', '9lives', 'a b', '', '#center', '/pokemonarena/', 'javascript:alert(1)', 'x'.repeat(33), null, undefined, 7, {}];
      ok(refused.every((p) => { HP.writeBack(ss, 'center'); return HP.writeBack(ss, p) === false && !('arena.back' in ss.store); }), T('C13 anything that is not a hub path (the main menu included) is not stored, and FORGETS what was (' + refused.length + ' values)'), J(ss.store));
      ok(refused.filter((p) => typeof p === 'string').every((p) => { ss.store['arena.back'] = p; return HP.readBack(ss) === null; }) && HP.readBack(null) === null && HP.readBack(memStorage()) === null, T('C14 a stored value that is not a hub path is never believed (the key is read, not trusted)'), '');
      ok(HP.writeBack(ss, 'center-pc') && HP.readBack(ss) === 'center-pc' && HP.clearBack(ss) === true && !('arena.back' in ss.store) && HP.writeBack(null, 'center') === false, T('C15 a nested screen of an app is a hub path too; clearBack forgets; no storage stores nothing'), J(ss.store));
      ok(HP.backPathFor('center') === 'center' && HP.backPathFor('center-pc') === 'center-pc' && ['main', 'online', 'builder', 'builder-team', 'centered', 'tower-offer', '', null, 7].every((p) => HP.backPathFor(p) === null), T('C16 a battle left for from the Trainer Center\'s screens comes back to them; from anywhere else, to the main menu'), '');
    });

    /* ============================================================ D. the disclosure, in the picture */
    await block(async () => {
      const w = world('?net=local&opendisc=1', { session: { 'arena.back': 'center' } });
      ok(w.svc.status() === 'loading' && w.svc.isOn() === false, T('D1 a service that has just been made is loading, and off'), w.svc.status());
      ok(!('arena.back' in w.win.sessionStorage.store), T('D2 THE HUB PAGE IS UP: the screen-to-come-back-to key is cleared (whatever battle it was for, the player is back)'), J(w.win.sessionStorage.store));
      const hook2 = {};
      ok(HP.hubPresence(w.env) === w.svc && HP.hubPresence({ win: w.win }) === w.svc && w.env.hook.presence === w.svc && HP.hubPresence({ win: w.win, hook: hook2 }) === w.svc && hook2.presence === w.svc, T('D3 ONE service per page: a second caller gets the same one, and the hook of the page names it from the moment it exists (that is where boot.js sends the answers)'), '');
      const ready = await within(w.svc.ready);
      ok(ready === true && w.svc.status() === 'off' && w.win.__arenaPresence === w.svc.mount && w.cur() === null, T('D4 once presence_boot.js is mounted the service is off, and nothing is asked'), J(w.svc.state()));
      wire.length = 0;
      let answer = 'pending';
      w.svc.turnOn().then((v) => { answer = v; });
      await settle(() => shown(w, HP.DISCLOSURE_ID));
      const c = w.q();
      ok(c.id === HP.DISCLOSURE_ID && c.page === 0 && c.pages >= 3 && c.choice.options[c.choice.cursor] === 'NO' && J(c.choice.options) === J(['YES', 'NO']) && c.armed === true, T('D5 the first switch-on ASKS, in the picture: message pages, YES / NO with NO highlighted, and it listens at once (the player asked for it)'), J(c));
      await sleep(60);
      const unlisted = (x) => x.svc.mount.lobbies === null && x.svc.mount.presence === null;          // (no board connection exists at all: nothing CAN have been published)
      ok(w.svc.isOn() === false && w.win.localStorage.store['arena.open'] === undefined && unlisted(w) && answer === 'pending' && w.svc.state().disclosure === 'shown', T('D6 NOTHING IS PUBLISHED BEFORE YES: the switch is off, nothing is stored, and there is no board connection to publish on'), J([w.svc.state(), unlisted(w)]));
      const seenText = [];
      for (let i = 0; i < c.pages; i++) { seenText.push(w.text()); if (i < c.pages - 1) w.press('a'); }
      ok(/trainer name/.test(seenText.join(' ')) && /online record/.test(seenText.join(' ')) && /public servers/.test(seenText.join(' ')) && seenText[seenText.length - 1] === HP.DISCLOSURE_ASK && !!(w.dv() || {}).choice, T('D7 A turns its pages (trainer name, online record, public servers ...) and the last page is the question with the options'), seenText.join(' | ').slice(0, 200));
      w.press('b');
      await settle(() => answer !== 'pending');
      await sleep(40);
      ok(answer === false && w.cur() === null && w.svc.isOn() === false && w.win.localStorage.store['arena.open.seen'] === undefined && w.win.localStorage.store['arena.open'] === undefined && unlisted(w), T('D8 B is NO: the switch stays off, NOTHING IS REMEMBERED, nothing is published'), J([answer, w.win.localStorage.store]));
      let second = 'pending';
      w.svc.turnOn().then((v) => { second = v; });
      await settle(() => shown(w, HP.DISCLOSURE_ID));
      ok(shown(w, HP.DISCLOSURE_ID) && w.q().page === 0, T('D9 so the next switch-on asks again, from its first page'), J(w.cur()));
      // A through every page with NO highlighted answers NO (a player who only presses A publishes nothing)
      for (let i = 0; i < 20 && w.cur(); i++) w.press('a');
      await settle(() => second !== 'pending');
      ok(second === false && w.svc.isOn() === false && w.win.localStorage.store['arena.open.seen'] === undefined, T('D10 a player who only presses A reaches NO (the default), not YES'), J([second, w.win.localStorage.store]));
      let third = 'pending', also = 'pending';
      w.svc.turnOn().then((v) => { third = v; });
      await settle(() => shown(w, HP.DISCLOSURE_ID));
      w.svc.turnOn().then((v) => { also = v; });          // asked for again while the question is up: the same question, both hear its answer
      await sleep(20);
      ok(w.hub.state().dialog.queued.length === 0, T('D11 asking again while the question is up does not ask twice'), J(w.hub.state().dialog));
      lastPage(w); w.press('up'); w.press('a');
      await settle(() => third !== 'pending' && also !== 'pending');
      ok(third === true && also === true && w.svc.isOn() === true && w.svc.status() === 'on' && w.win.localStorage.store['arena.open.seen'] === '1' && w.win.localStorage.store['arena.open'] === '1' && w.svc.stored() === true && w.cur() === null, T('D12 YES switches it on, and remembers both the switch and that the player was told'), J([third, also, w.svc.state(), w.win.localStorage.store]));
      ok(await settle(() => listed().some((m2) => m2.s === w.sid() && m2.h === 1 && m2.name === 'Player')), T('D13 ... and now the listing is on the board'), J(listed().slice(0, 2)));
      ok((await within(w.svc.turnOff())) === true && w.svc.isOn() === false && w.win.localStorage.store['arena.open'] === undefined && w.svc.status() === 'off', T('D14 off takes it down and forgets the switch'), J(w.svc.state()));
      const fourth = await within(w.svc.turnOn());
      ok(fourth === true && w.cur() === null && w.svc.isOn() === true, T('D15 switching on again does NOT ask a second time (the player was told once)'), J(w.svc.state()));
      ok((await within(w.svc.toggle())) === false && w.svc.isOn() === false && (await within(w.svc.toggle())) === true && w.svc.isOn() === true, T('D16 toggle() is the switch: off, then on'), J(w.svc.state()));
      await endAll();
      // on for this page only (the Trainer Center): told, switched on, and the stored switch left as it was
      const c1 = world('?net=local&opendisc=1');
      await within(c1.svc.ready);
      let here = 'pending';
      c1.svc.turnOn({ persist: false, also: 'In the Trainer Center your look and where you stand are listed too.' }).then((v) => { here = v; });
      await settle(() => shown(c1, HP.DISCLOSURE_ID));
      const pages = []; { const cc = c1.q(); for (let i = 0; i < cc.pages; i++) { pages.push(c1.text()); if (i < cc.pages - 1) c1.press('a'); } }
      c1.press('up'); c1.press('a');
      await settle(() => here !== 'pending');
      ok(here === true && c1.svc.isOn() === true && c1.svc.stored() === false && c1.win.localStorage.store['arena.open'] === undefined && c1.win.localStorage.store['arena.open.seen'] === '1' && /where you stand are listed too\./.test(pages.join(' ')), T('D17 turnOn({ persist: false, also }): the disclosure carries the host\'s sentence, YES switches on FOR THIS PAGE (the stored switch is untouched) and the telling is remembered'), J([here, c1.win.localStorage.store]));
      await endAll();
      // a stored "on" that nobody was ever told about
      const s1 = world('?net=local&opendisc=1', { local: { 'arena.open': '1' } });
      await within(s1.svc.ready); await sleep(80);
      ok(s1.svc.isOn() === false && s1.win.localStorage.store['arena.open'] === undefined && s1.cur() === null && s1.svc.mount.lobbies === null && s1.svc.mount.presence === null, T('D18 a stored "on" the player was never told about is DROPPED: off, the switch forgotten, nothing listed, nothing asked'), J([s1.svc.state(), s1.win.localStorage.store]));
      await endAll();
      const s2 = world('?net=local&opendisc=1', { local: { 'arena.open': '1', 'arena.open.seen': '1' } });
      await within(s2.svc.ready);
      ok(await settle(() => s2.svc.status() === 'on') && s2.cur() === null, T('D19 a stored "on" of a player who WAS told is honoured at load, without asking (the negative control)'), J(s2.svc.state()));
      await endAll();
    });

    /* ============================================================ E. the challenge, in the picture */
    await block(async () => {
      const w = world('?net=local&openchal=20000');
      await within(w.svc.ready);
      ok((await within(w.svc.turnOn())) === true && w.cur() === null, T('E0 (the rig) the same-browser transport asks nothing and switches on'), J(w.svc.state()));
      const a1 = asker('Chad');
      const r1 = a1.ask(w.sid(), { rec: [3, 1] });
      await settle(() => shown(w, HP.CHALLENGE_ID));
      const c = w.q(), v = w.dv() || {};
      ok(c.id === HP.CHALLENGE_ID && c.app === null && w.text() === 'Chad (3-1 online) wants to battle you.' && c.pages === 2, T('E1 a challenge is asked IN THE PICTURE: "<NAME> (W-L online) wants to battle you."'), J([c, w.text()]));
      ok(c.choice.options[c.choice.cursor] === 'NO' && c.choice.cursor === c.choice.options.length - 1 && J(c.choice.options) === J(['YES', 'NO']), T('E2 NO IS THE DEFAULT: the highlight starts on NO, the last option'), J(c.choice));
      ok(c.armed === false && v.armed === false, T('E3 it does not listen yet (the picture shows no cursor until it does)'), J(c));
      // inside the first 600 ms: A, B, a tap on the text, a tap where YES will be: nothing
      w.press('a'); w.press('b'); w.click(100, 130); w.click(205, 75);
      w.tick(HD.DIALOG_ARM_TICKS - 1);
      w.press('a'); w.press('b');
      await sleep(30);
      ok(shown(w, HP.CHALLENGE_ID) && w.q().page === 0 && w.q().armed === false && a1.told(r1).length === 0 && w.nav.length === 0 && HD.DIALOG_ARM_TICKS === 36, T('E4 YES IS INERT FOR 600 ms (36 frames): A, B and taps in the first moments answer nothing and turn no page'), J([w.cur(), a1.told(r1)]));
      w.tick(1);
      ok(w.q().armed === true, T('E5 ... and after that it listens'), J(w.cur()));
      w.press('b');
      ok(await settle(() => a1.told(r1, 'dec').some((m2) => m2.why === 'declined')) && w.cur() === null && w.nav.length === 0 && w.svc.state().challenge === null, T('E6 B ANSWERS NO, from the first page: the question closes, the asker is told "declined", nobody goes anywhere'), J(a1.told(r1)));
      // a held direction: its repeats never move the highlight, so A after them is still NO
      const a2 = asker('Dee');
      const r2 = a2.ask(w.sid());
      ok(await armed(w, HP.CHALLENGE_ID), T('E7 (the rig) the next challenge is up and listening'), J(w.cur()));
      w.press('a');
      for (let i = 0; i < 7; i++) w.press('up', { repeat: true });          // (an ODD number of steps: were they taken, the highlight would end on YES)
      for (const d of ['left', 'right', 'down', 'l', 'r']) { w.press(d, { repeat: true }); w.press(d, { repeat: true }); }
      const drift = w.q();
      w.press('a');
      ok(drift.page === 1 && drift.choice.options[drift.choice.cursor] === 'NO' && await settle(() => a2.told(r2, 'dec').length > 0) && w.nav.length === 0, T('E8 A HELD DIRECTION CANNOT DRIFT ONTO YES: its repeats do not move the highlight, and A after them answers NO'), J([drift.choice, a2.told(r2), w.nav]));
      // one question at a time; a tap on the text never answers; a fresh press and A accept
      const a3 = asker('Eve'), a4 = asker('Fay');
      const r3 = a3.ask(w.sid());
      ok(await armed(w, HP.CHALLENGE_ID), T('E9 (the rig) a third challenge is up'), '');
      const r4 = a4.ask(w.sid());
      ok(await settle(() => a4.told(r4, 'dec').some((m2) => m2.why === 'busy')) && w.text() === 'Eve wants to battle you.' && w.hub.state().dialog.queued.length === 0, T('E10 ONE QUESTION AT A TIME: a second asker is told busy, and the picture still shows the first'), J([a4.told(r4), w.text()]));
      w.click(100, 130);
      const p2 = w.q();
      w.click(100, 130); w.click(100, 130);
      await sleep(30);
      ok(p2.page === 1 && shown(w, HP.CHALLENGE_ID) && a3.told(r3).length === 0, T('E11 a tap on the text turns the page and NEVER answers'), J([p2, a3.told(r3)]));
      w.press('up');
      ok(w.q().choice.options[w.q().choice.cursor] === 'YES', T('E12 a FRESH press does move the highlight (the guard above is not simply "never")'), J(w.q().choice));
      w.press('a');
      ok(w.nav.length === 1 && await settle(() => a3.told(r3, 'ok').length > 0), T('E13 YES accepts: the asker is told ok and the page leaves, once'), J([w.nav, a3.told(r3)]));
      const n = w.nav[0] || {}, tok = n.accept ? JSON.parse(n.accept) : null, u = n.url ? new URL(n.url, 'http://x') : null;
      ok(!!tok && tok.for === a3.sid && tok.rq === r3 && tok.ck === PK_FAKE && Number.isFinite(tok.at), T('E14 THE TOKEN IS WRITTEN FIRST: when the page navigates, this tab already holds the accept token for that challenger and that request'), J(tok));
      ok(!!u && u.pathname === '/pokemonarena/battle.html' && u.searchParams.get('online') === '1' && u.searchParams.get('auto') === 'host' && u.searchParams.get('for') === a3.sid && u.searchParams.get('rq') === r3 && u.searchParams.get('format') === '3v3' && u.searchParams.get('net') === 'local' && u.searchParams.get('openchal') === '20000',
        T('E15 ... and it goes to the accepted-challenge address (auto=host, for, rq, 3v3) with the test seams it arrived with'), n.url);
      ok(n.back === null && w.cur() === null, T('E16 accepted on the main menu: no screen to come back to is left behind'), J(n));
      await endAll();
    });
    await block(async () => {
      // nobody answers; the asker cancels; the asker is gone
      const w = world('?net=local&openchal=400');
      await within(w.svc.ready); await within(w.svc.turnOn());
      const a1 = asker('Slow');
      const t0 = Date.now(), r1 = a1.ask(w.sid());
      await settle(() => shown(w, HP.CHALLENGE_ID));
      const up = shown(w, HP.CHALLENGE_ID);
      const gone = await settle(() => w.cur() === null, 3000), took = Date.now() - t0;
      ok(up && gone && took >= 350 && took < 2500 && await settle(() => a1.told(r1, 'dec').length > 0) && w.svc.state().challenge === null, T('E17 THE AUTOMATIC NO: a question nobody answers leaves the picture by itself on time (here 400 ms; 25 s for real) and the asker is told no'), J([up, gone, took, a1.told(r1)]));
      await endAll();
      const w2 = world('?net=local&openchal=20000');
      await within(w2.svc.ready); await within(w2.svc.turnOn());
      const a2 = asker('Shy');
      const r2 = a2.ask(w2.sid());
      await settle(() => shown(w2, HP.CHALLENGE_ID));
      a2.cancel(w2.sid(), r2);
      ok(await settle(() => w2.cur() === null) && w2.svc.state().challenge === null, T('E18 THE ASKER\'S CANCEL closes the question'), J(w2.svc.state()));
      const a3 = asker('Next');
      a3.ask(w2.sid());
      ok(await settle(() => shown(w2, HP.CHALLENGE_ID)) && w2.text() === 'Next wants to battle you.', T('E19 ... and the next challenger can ask'), w2.text());
      // switching off with a question up takes it down
      await within(w2.svc.turnOff());
      ok(w2.cur() === null && w2.svc.state().challenge === null, T('E20 switching off closes a question that is up'), J(w2.svc.state()));
      await endAll();
    });
    await block(async () => {
      // no token = busy, and the player stays
      const w = world('?net=local&openchal=20000', { noSession: true });
      await within(w.svc.ready); await within(w.svc.turnOn());
      const a1 = asker('Tok');
      const r1 = a1.ask(w.sid());
      await armed(w, HP.CHALLENGE_ID);
      w.press('a'); w.press('up'); w.press('a');
      ok(await settle(() => a1.told(r1, 'dec').some((m2) => m2.why === 'busy')) && w.nav.length === 0 && a1.told(r1, 'ok').length === 0, T('E21 NO TOKEN = BUSY: in a browser that blocks the tab\'s storage YES cannot be honoured, so the asker is told busy and the player goes nowhere'), J([a1.told(r1), w.nav]));
      ok(!!w.cur() && w.q().id === HP.NOTE_ID && /could not be opened/.test(w.text()), T('E22 ... and the picture says why'), J([w.cur(), w.text()]));
      await endAll();
      // the dialog layer is full: the question cannot be asked, so it is answered NO at once (the asker does not wait for a question nobody can see)
      const w2 = world('?net=local&openchal=20000');
      await within(w2.svc.ready); await within(w2.svc.turnOn());
      for (let i = 0; i < HD.DIALOG_QUEUE_MAX; i++) w2.hub.dialog.open({ id: 'fill:' + i, pages: [['x', '']], choice: null });
      const a2 = asker('Full');
      const r2 = a2.ask(w2.sid());
      ok(await settle(() => a2.told(r2, 'dec').length > 0, 2500) && w2.svc.state().challenge === null, T('E23 a question the dialog layer cannot take (its queue is full) is answered NO at once'), J(a2.told(r2)));
      await endAll();
      // accepted in the Trainer Center: the battle comes back to the Trainer Center
      const w3 = world('?net=local&openchal=20000', { session: {} });
      await within(w3.svc.ready); await within(w3.svc.turnOn());
      w3.hub.goto('center-pc');
      const a3 = asker('Ctr');
      a3.ask(w3.sid());
      await armed(w3, HP.CHALLENGE_ID);
      w3.press('a'); w3.press('up'); w3.press('a');
      ok(w3.nav.length === 1 && w3.nav[0].back === 'center-pc' && !!w3.nav[0].accept, T('E24 A CHALLENGE ACCEPTED IN THE TRAINER CENTER comes back to it: arena.back holds the open Center screen when the page navigates'), J(w3.nav));
      await endAll();
      const w4 = world('?net=local&openchal=20000');
      await within(w4.svc.ready); await within(w4.svc.turnOn());
      w4.hub.goto('builder');
      w4.win.sessionStorage.setItem('arena.back', 'center');          // (stale: left by something else)
      const a4 = asker('Bld');
      a4.ask(w4.sid());
      await armed(w4, HP.CHALLENGE_ID);
      w4.press('a'); w4.press('up'); w4.press('a');
      ok(w4.nav.length === 1 && w4.nav[0].back === null && !('arena.back' in w4.win.sessionStorage.store), T('E25 ... accepted anywhere else, it comes back to the main menu, and a stale key is cleared rather than left'), J(w4.nav));
      await endAll();
    });

    /* ============================================================ F. DOM panels */
    await block(async () => {
      const w = world('?net=local&openchal=20000');
      await within(w.svc.ready); await within(w.svc.turnOn());
      w.setPanel(true);
      const a1 = asker('Wait');
      const r1 = a1.ask(w.sid());
      ok(await settle(() => w.svc.state().challenge === 'waiting') && w.cur() === null && w.dv() === null, T('F1 WHILE A DOM PANEL IS OPEN THE QUESTION WAITS: it is in hand, and NOT in the picture (it would be under the panel)'), J([w.svc.state(), w.cur()]));
      w.tick(120);
      await sleep(30);
      ok(w.cur() === null && a1.told(r1).length === 0, T('F2 ... and nothing is answered meanwhile'), J(a1.told(r1)));
      w.setPanel(false);
      ok(shown(w, HP.CHALLENGE_ID) && w.svc.state().challenge === 'shown' && w.text() === 'Wait wants to battle you.' && w.q().armed === false, T('F3 WHEN THE PANEL CLOSES IT APPEARS, and listens only after the arm delay (the key that closed the panel answers nothing)'), J([w.svc.state(), w.cur()]));
      w.press('b'); w.tick(HD.DIALOG_ARM_TICKS);
      ok(shown(w, HP.CHALLENGE_ID) && w.q().armed === true && a1.told(r1).length === 0, T('F4 (a press before it listens changed nothing)'), J(w.cur()));
      // a panel opens over a question that is up: it comes out of the picture, and goes back in, re-armed, when the panel closes
      w.setPanel(true);
      ok(w.cur() === null && w.svc.state().challenge === 'waiting', T('F5 a panel that opens OVER a question takes it out of the picture (still in hand)'), J(w.svc.state()));
      w.setPanel(true); w.svc.panels();
      w.setPanel(false);
      ok(shown(w, HP.CHALLENGE_ID) && w.q().armed === false && w.q().page === 0 && w.hub.state().dialog.queued.length === 0, T('F6 ... and it is back, once, from its first page, when the panel closes'), J(w.cur()));
      w.tick(HD.DIALOG_ARM_TICKS); w.press('b');
      ok(await settle(() => a1.told(r1, 'dec').length > 0) && w.cur() === null, T('F7 and then it is answered as usual'), J(a1.told(r1)));
      await endAll();
      // it still counts as a NO on time while it waits
      const w2 = world('?net=local&openchal=400');
      await within(w2.svc.ready); await within(w2.svc.turnOn());
      w2.setPanel(true);
      const a2 = asker('Late');
      const r2 = a2.ask(w2.sid());
      await settle(() => w2.svc.state().challenge === 'waiting');
      ok(await settle(() => a2.told(r2, 'dec').length > 0, 3000) && w2.svc.state().challenge === null, T('F8 A QUESTION THAT WAITS STILL TIMES OUT ON TIME: the asker is told no'), J([a2.told(r2), w2.svc.state()]));
      w2.setPanel(false);
      ok(w2.cur() === null, T('F9 ... and nothing appears when the panel closes afterwards'), J(w2.cur()));
      await endAll();
      // the disclosure waits too
      const w3 = world('?net=local&opendisc=1');
      await within(w3.svc.ready);
      w3.setPanel(true);
      w3.svc.turnOn();
      await settle(() => w3.svc.state().disclosure === 'waiting');
      const held = w3.cur();
      w3.setPanel(false);
      ok(held === null && shown(w3, HP.DISCLOSURE_ID) && w3.q().armed === false, T('F10 the disclosure waits behind a panel as well, and listens after the arm delay when it appears'), J([held, w3.cur()]));
      await endAll();
    });

    /* ============================================================ G. the service */
    await block(async () => {
      const a = world('?net=local&openchal=20000'), b = world('?net=local&openchal=20000');
      await within(a.svc.ready); await within(b.svc.ready);
      ok(J(a.svc.players()) === '[]' && a.svc.boardId() === null && a.svc.trainer() === null && a.svc.challenge({ entry: {} }, {}) === null && a.svc.relist() === false, T('G1 while the switch is off there are no players, no board id, no trainer, and nobody can be asked'), '');
      await within(b.svc.turnOn()); await within(a.svc.turnOn());          // (B was listed BEFORE this page was on the board: it is not heard of until somebody asks, or until its next beacon, 4 s away)
      await sleep(80);
      const unseen = a.svc.players().length;
      a.svc.watchPlayers(true);
      const before = a.changes;          // (counted from AFTER the call: what must be heard is the BOARD saying that a player appeared)
      ok(unseen === 0 && await settle(() => a.svc.players().length === 1, 2000) && a.changes > before, T('G2 with watchPlayers(true) the board is ASKED who is open: a player who was listed before this page came on appears at once, and onChange says so'), J([unseen, a.svc.players().map((p) => p.name)]));
      const pb = a.svc.players()[0] || {};
      ok(pb.id === b.sid() && pb.name === 'Player' && pb.doing === 'menu' && pb.room === null && pb.compatible === true && pb.fmt === '3v3' && !a.svc.players().some((p) => p.id === a.sid()), T('G3 they are listed as open from the menu, running the same game; this page\'s own listing is never among them'), J(pb));
      ok(/^[0-9a-f]{16}$/.test(a.sid()) && J(a.svc.trainer()) === J({ name: 'Player', rec: null }) && a.svc.canChallenge() === true && a.svc.state().players === 1, T('G4 the page knows its own board id and what its listing says'), J([a.sid(), a.svc.trainer()]));
      // A asks B, B says NO; a third page (C) asks A, A says YES
      const ev = [];
      const h = a.svc.challenge(pb, { state: (s) => ev.push('state:' + s), accepted: (r) => ev.push('accepted:' + r), failed: (why) => ev.push('failed:' + why) });
      ok(!!h && typeof h.cancel === 'function' && (await within(h.ready)) === true && await armed(b, HP.CHALLENGE_ID) && b.text() === 'Player wants to battle you.', T('G5 challenge(player) asks them: the question appears in THEIR picture, under this page\'s trainer name'), b.text());
      b.press('b');
      ok(await settle(() => ev.includes('failed:declined')) && h.done() === true, T('G6 their NO comes back as failed("declined")'), J(ev));
      const c3 = world('?net=local&openchal=20000');
      await within(c3.svc.ready); await within(c3.svc.turnOn()); c3.svc.watchPlayers(true);
      await settle(() => c3.svc.players().some((p) => p.id === a.sid()), 3000);          // (A has answered no ask yet, so it answers this one at once; B has just answered A's and would keep C waiting for its next beacon)
      const ev3 = [];
      c3.svc.challenge(c3.svc.players().find((p) => p.id === a.sid()), { state: (s) => ev3.push('state:' + s), accepted: (r) => ev3.push('accepted:' + r), failed: (why) => ev3.push('failed:' + why) });
      await armed(a, HP.CHALLENGE_ID);
      a.press('a'); a.press('up'); a.press('a');
      ok(await settle(() => ev3.includes('state:accepted')) && a.nav.length === 1 && /auto=host/.test(a.nav[0].url), T('G7 a YES comes back as state("accepted") (the room follows from their battle page), and the one who said it leaves for it'), J([ev3, a.nav]));
      // the board connection is rebuilt when the switch goes off and on: the list is watched again, and the id is new
      const sid1 = a.sid();
      await within(a.svc.turnOff());
      ok(J(a.svc.players()) === '[]' && a.svc.boardId() === null, T('G8 off: no players, no board id'), '');
      await within(a.svc.turnOn());
      ok(a.sid() !== sid1 && a.svc.mount.lobbies.isWatching() === true && await settle(() => a.svc.players().some((p) => p.id === c3.sid()), 3000), T('G9 on again: a new board id, and the list is watched again without being asked twice'), J([sid1, a.sid(), a.svc.players().length]));
      a.svc.watchPlayers(false);
      ok(a.svc.mount.lobbies.isWatching() === false, T('G10 watchPlayers(false) lets the list go'), '');
      ok(typeof a.svc.refresh().then === 'function' && (await within(a.svc.refresh())) === false && a.svc.relist() === true, T('G11 refresh() is a promise (nothing changed: false); relist() says the listing again'), '');
      await endAll();
    });
    await block(async () => {
      // leaving for a battle (INAPP.md "Contract 1" and "Contract 6")
      const w = world('?net=local&anim=0&openchal=5000', { session: {} });
      await within(w.svc.ready);
      const NOWISH = Date.now();
      ok(w.svc.goBattle('host') === true && w.nav.length === 1 && w.nav[0].url === '/pokemonarena/battle.html?online=1&net=local&anim=0&openchal=5000' && J(P.takeStartToken(w.win.sessionStorage, NOWISH + 50)) === J({ what: 'host', room: null }) && w.nav[0].back === null,
        T('G12 goBattle("host"): the START token is in this tab when the page navigates to the plain address (with the seams); from the main menu nothing is left to come back to'), J(w.nav));
      w.hub.goto('center');
      w.svc.goBattle('join', 'k7q2p');
      ok(w.nav[1].url === '/pokemonarena/battle.html?np=K7Q2P&join=1&meet=1&net=local&anim=0&openchal=5000' && !!w.nav[1].meet && w.nav[1].back === 'center', T('G13 goBattle("join", room) from the Trainer Center: the MEET token, and the battle comes back to the Center'), J(w.nav[1]));
      w.svc.goBattle('quick', null, { back: null });
      ok(w.nav[2].back === null && J(JSON.parse(w.nav[2].start).what) === '"quick"', T('G14 { back: null } says "come back to the main menu", whatever screen is open'), J(w.nav[2]));
      w.hub.goto('builder');
      w.svc.goBattle('room', 'K7Q2P', { back: 'center' });
      ok(w.nav[3].url.startsWith('/pokemonarena/battle.html?np=K7Q2P&host=1') && w.nav[3].back === 'center', T('G15 { back: path } names the screen to come back to'), J(w.nav[3]));
      const n0 = w.nav.length; w.win.sessionStorage.removeItem('arena.go');
      ok(w.svc.goBattle('room', 'nope!') === false && w.svc.goBattle('fly') === false && w.nav.length === n0 && w.win.sessionStorage.getItem('arena.go') === null, T('G16 a kind that is not one, or a room that is not a room code: false, no token, no navigation'), J(w.win.sessionStorage.store));
      w.win.sessionStorage.setItem('arena.back', 'center');
      w.win.fire('pageshow', { persisted: false });
      const kept = w.win.sessionStorage.getItem('arena.back');
      w.win.fire('pageshow', { persisted: true });
      ok(kept === 'center' && w.win.sessionStorage.getItem('arena.back') === null, T('G17 a hub page restored from the back / forward cache is "the hub page is up" too: the key is cleared then (and not on an ordinary pageshow, which follows the load that already cleared it)'), J([kept, w.win.sessionStorage.store]));
      // dispose
      const svc = w.svc, mount = svc.mount;
      await within(w.svc.turnOn());
      const a1 = asker('Bye');
      a1.ask(w.sid());
      await settle(() => shown(w, HP.CHALLENGE_ID));
      svc.dispose();
      ok(w.cur() === null && w.win.__arenaPresence === undefined && svc.mount === null && svc.isOn() === false && w.win.listening('pageshow') === 0 && mount.isOn() === false, T('G18 dispose closes a question that is up, disposes the mount and lets go of the page'), J([w.cur(), w.win.listening('pageshow')]));
      const again = HP.hubPresence(w.env);
      ok(again !== svc && (await within(again.ready)) === true, T('G19 and the next caller gets a NEW service'), '');
      again.dispose();
      await endAll();
      // presence_boot.js cannot load
      const dead = world('?net=local', { loadBoot: () => Promise.reject(new Error('404')) });
      let r = 'rejected'; try { r = await within(dead.svc.ready); } catch (_e) { r = 'rejected'; }
      ok(r === false && dead.svc.status() === 'unavailable' && (await within(dead.svc.turnOn())) === false && (await within(dead.svc.toggle())) === false && (await within(dead.svc.turnOff())) === true && (await within(dead.svc.refresh())) === false && J(dead.svc.players()) === '[]' && dead.svc.goBattle('host') === true,
        T('G20 when presence_boot.js cannot load, ready is false and the service says "unavailable": nothing switches on, nothing throws (and leaving for a battle still works)'), dead.svc.status());
      await endAll();
    });

    /* ============================================================ H. presence_boot.js with injected dialogs, and no DOM button */
    await block(async () => {
      const PB = await M.boot();
      const win = makeWin('?net=local&opendisc=1&openchal=20000'), doc = makeDoc();
      const log = [];
      let yes = null;
      const dialogs = {
        challenge: { show: (info) => { log.push('chal.show:' + info.name + ':' + J(info.rec) + ':' + info.fmtText); return true; }, hide: () => { log.push('chal.hide'); }, isOpen: () => false, destroy: () => { log.push('chal.destroy'); } },
        disclosure: { show: (onYes) => { yes = onYes; log.push('disc.show'); return true; }, hide: () => {}, isOpen: () => !!yes, destroy: () => { log.push('disc.destroy'); } },
      };
      const paused = [];
      const nav = [];
      const p = PB.mountPresence({ win, doc, pack: M.pack, navigate: (u) => nav.push(u), button: null, dialogs, onDialog: { open: (wh) => paused.push('open:' + wh), close: (wh) => paused.push('close:' + wh) } });
      let changes = 0; const off = p.onChange(() => { changes++; });
      ok(p.status() === 'off' && p.needsDisclosure() === true && p.isOn() === false && win.__arenaPresence === p, T('H1 mounted with injected dialogs and no button: off, and the first switch-on must ask'), p.status());
      let t = 'threw'; try { t = await within(p.toggle()); } catch (e) { t = 'threw: ' + String(e && e.message ? e.message : e); }
      await sleep(40);
      ok(t === false && J(log) === J(['disc.show']) && typeof yes === 'function' && p.isOn() === false && p.lobbies === null && p.presence === null && win.localStorage.store['arena.open'] === undefined, T('H2 toggle() puts the question to the INJECTED disclosure and publishes nothing'), J(log));
      const turned = typeof yes === 'function' ? await within(yes()) : 'no question was put';
      ok(turned === true && p.isOn() === true && p.status() === 'on' && win.localStorage.store['arena.open.seen'] === '1' && win.localStorage.store['arena.open'] === '1' && p.needsDisclosure() === false && changes >= 2, T('H3 its YES (the function it was handed) remembers the telling, switches on, and onChange heard it'), J([turned, p.status(), changes]));
      const a1 = asker('Inj');
      const r1 = a1.ask(p.lobbies.sid, { rec: [9, 2] });
      ok(await settle(() => log.includes('chal.show:Inj:[9,2]:3 v 3')) && J(p.pending() && [p.pending().r, p.pending().name]) === J([r1, 'Inj']), T('H4 a challenge is shown by the INJECTED dialog, with the name, the record and the size'), J(log));
      ok(p.decline() === true && await settle(() => a1.told(r1, 'dec').length > 0) && log.includes('chal.hide') && p.pending() === null && p.decline() === false && p.accept() === false, T('H5 decline() answers it (and with nothing waiting, accept() and decline() do nothing)'), J(log));
      ok(paused.length === 0, T('H6 an injected dialog pauses its own page: onDialog is not called for it'), J(paused));
      const a2 = asker('Acc');
      const r2 = a2.ask(p.lobbies.sid);
      await settle(() => !!p.pending());
      ok(p.accept() === true && nav.length === 1 && /rq=/.test(nav[0]) && JSON.parse(win.sessionStorage.store['arena.accept']).rq === r2, T('H7 accept() writes the token and navigates'), J(nav));
      off(); const c0 = changes;
      await within(p.setOn(false));
      ok(changes === c0 && p.status() === 'off', T('H8 an onChange listener that was removed hears nothing more'), '');
      p.dispose();
      ok(log.includes('chal.destroy') && log.includes('disc.destroy') && win.__arenaPresence === undefined, T('H9 dispose() destroys the injected dialogs too'), J(log));
      await endAll();
    });
  } finally {
    await endAll();
    try { spyCh.close(); } catch (_e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each breaks ONE guarantee in a copy of the game's js/ (file: hub_presence.js unless it says otherwise) and the suite must then fail the case it names.
const MUTANTS = [
  { id: 'b-accepts', why: 'YES and NO change places in the code: B (the last option) accepts', from: 'export const YES = 0, NO = 1;', to: 'export const YES = 1, NO = 0;', fails: 'E2' },
  { id: 'labels-swapped', why: 'the answers are drawn NO then YES, so the highlighted default reads YES', from: "export const ANSWERS = Object.freeze(['YES', 'NO']);", to: "export const ANSWERS = Object.freeze(['NO', 'YES']);", fails: 'A11' },
  { id: 'yes-default', why: 'the highlight starts on YES', from: 'choice: { options: ANSWERS.slice(), cursor: NO }, armTicks', to: 'choice: { options: ANSWERS.slice(), cursor: YES }, armTicks', fails: 'E2' },
  { id: 'never-armed', why: 'no question has an arm delay: the A on its way to the menu accepts', from: 'armTicks: a.arm || a.waited ? DIALOG_ARM_TICKS : 0 });', to: 'armTicks: 0 });', fails: 'E3' },
  { id: 'challenge-not-armed', why: 'a challenge listens at once', from: "pages: challengePages(info, measure, px), arm: true,", to: "pages: challengePages(info, measure, px), arm: false,", fails: 'E3' },
  { id: 'waited-not-armed', why: 'a question that waited behind a panel listens the moment the panel closes', from: 'armTicks: a.arm || a.waited ? DIALOG_ARM_TICKS : 0 });', to: 'armTicks: a.arm ? DIALOG_ARM_TICKS : 0 });', fails: 'F10' },
  { id: 'shown-under-panel', why: 'a question is drawn under an open DOM panel', from: '    if (panelOpen()) { a.waited = true; emit(); return; }\n', to: '', fails: 'F1' },
  { id: 'never-flushed', why: 'a question that waited never appears when the panel closes', from: '      else place(kind);\n', to: '', fails: 'F3' },
  { id: 'stays-under-panel', why: 'a question that is up stays in the picture when a panel opens over it', from: '      if (up) { if (a.shown) { lift(kind); a.waited = true; emit(); } }\n      else place(kind);', to: '      if (!up) place(kind);', fails: 'F5' },
  { id: 'hide-leaves-question', why: 'a question that is over (cancelled, timed out) stays in the picture', from: "    hide() { drop('challenge'); },", to: '    hide() { },', fails: 'E17' },
  { id: 'name-as-given', why: 'the challenger\'s name is drawn as it was given', from: "const who = cleanName(i.name, 'Player') + recText(i.rec);", to: "const who = String(i.name) + recText(i.rec);", fails: 'A4' },
  { id: 'size-as-given', why: 'the size text is drawn as it was given', from: "typeof i.fmtText === 'string' && /^[1-6] v [1-6]$/.test(i.fmtText) ? i.fmtText + ' ' : '';", to: "typeof i.fmtText === 'string' ? i.fmtText + ' ' : '';", fails: 'A4' },
  { id: 'any-record', why: 'a record of any shape is drawn', from: 'const recText = (rec) => (Array.isArray(rec) && rec.length === 2 && rec.every((n) => Number.isInteger(n) && n >= 0 && n <= 999999) ?', to: 'const recText = (rec) => (Array.isArray(rec) ?', fails: 'A3' },
  { id: 'no-silent', why: 'NO does not tell the asker', from: '      else if (!yes) mount.decline();\n', to: '      else if (!yes) { /* nothing */ }\n', fails: 'E6' },
  { id: 'yes-declines', why: 'YES does not accept', from: "      else if (!mount.accept()) note(", to: "      else if (!mount.decline()) note(", fails: 'E13' },
  { id: 'no-note', why: 'a YES that cannot be honoured says nothing to the player', from: "      else if (!mount.accept()) note('The battle could not be opened:', 'this browser blocks the storage it needs.');", to: '      else mount.accept();', fails: 'E22' },
  { id: 'full-layer-silent', why: 'a challenge the dialog layer cannot take is left to time out', from: "    if (!took) { refuse(kind); return; }", to: '    if (!took) return;', fails: 'E23' },
  { id: 'accept-no-back', why: 'a challenge accepted in the Trainer Center does not come back to it', from: 'navigate: (url) => leave(url, backPathFor(model.path())),', to: 'navigate: (url) => leave(url, null),', fails: 'E24' },
  { id: 'stale-back-kept', why: 'leaving from the main menu keeps a stale screen-to-come-back-to', from: '    if (back) writeBack(session, back); else clearBack(session);', to: '    if (back) writeBack(session, back);', fails: 'E25' },
  { id: 'back-any-screen', why: 'every hub screen counts as the Trainer Center', from: "return typeof path === 'string' && (path === 'center' || path.startsWith('center-')) && BACK_RE.test(path) ? path : null; }", to: "return typeof path === 'string' && BACK_RE.test(path) ? path : null; }", fails: 'C16' },
  { id: 'back-not-cleared-at-load', why: 'the hub page loads and keeps the key', from: "  clearBack(session);\n  safe(() => win.addEventListener('pageshow', onShow));", to: "  safe(() => win.addEventListener('pageshow', onShow));", fails: 'D2' },
  { id: 'back-not-cleared-on-restore', why: 'a hub page restored from the back / forward cache keeps the key', from: 'const onShow = (e) => { if (e && e.persisted) clearBack(session); };', to: 'const onShow = () => { };', fails: 'G17' },
  { id: 'back-unchecked-write', why: 'anything is stored as the screen to come back to', from: "if (typeof path === 'string' && BACK_RE.test(path) && path !== 'main') { session.setItem(BACK_KEY, path);", to: "if (typeof path === 'string') { session.setItem(BACK_KEY, path);", fails: 'C13' },
  { id: 'back-unchecked-read', why: 'whatever the key holds is believed', from: "return typeof v === 'string' && BACK_RE.test(v) && v !== 'main' ? v : null; } catch", to: "return typeof v === 'string' ? v : null; } catch", fails: 'C14' },
  { id: 'publishes-before-yes', why: 'asking the disclosure already switches on', from: "    place('disclosure');\n    return true;\n  }", to: "    place('disclosure'); safe(() => onYes());\n    return true;\n  }", fails: 'D6' },
  { id: 'turn-on-unasked', why: 'turnOn() does not ask first', from: 'if (mount.isOn() || !mount.needsDisclosure()) return mount.setOn(true, { persist });', to: 'if (true) return mount.setOn(true, { persist });', fails: 'D5' },
  { id: 'no-is-yes', why: 'the disclosure\'s NO switches on anyway', from: "      if (!yes) done(false);                                                       // NO: nothing is published and nothing is remembered; the next switch-on asks again\n      else Promise", to: '      Promise', fails: 'D8' },
  { id: 'persist-ignored', why: '"for this page only" stores the switch', from: 'askDisclosure(() => mount.confirmDisclosure({ persist }), res, o.also);', to: 'askDisclosure(() => mount.confirmDisclosure(), res, o.also);', fails: 'D17' },
  { id: 'also-dropped', why: 'the host\'s sentence is not in the disclosure', from: "asks.disclosure = { id: DISCLOSURE_ID, pages: disclosurePages(measure, px, also),", to: "asks.disclosure = { id: DISCLOSURE_ID, pages: disclosurePages(measure, px, ''),", fails: 'D17' },
  { id: 'asked-twice', why: 'a second turnOn while the question is up asks again', from: "    if (a) { if (settle) a.settle.push(settle); return true; }                     // already being asked: the same question, one more listener for its answer\n", to: "    if (a) { model.dialog.open({ id: DISCLOSURE_ID + ':again', pages: a.pages, choice: { options: ANSWERS.slice(), cursor: NO } }); if (settle) a.settle.push(settle); return true; }\n", fails: 'D11' },
  { id: 'stored-is-on', why: 'stored() says what this page is doing, not what the stored switch of the browser says (the Trainer Center would leave a page-only listing up, or take a stored one down)', from: "stored: () => isOpen(safe(() => win.localStorage, null)),", to: 'stored: () => isOn(),', fails: 'D17' },
  { id: 'hook-not-told', why: 'a service made by an app before boot.js asked for it is not on the hook of the page: its answers go nowhere', from: "  if (env.hook && env.hook.presence !== win[SLOT]) env.hook.presence = win[SLOT];\n", to: '', fails: 'D3' },
  { id: 'two-services', why: 'every caller makes its own service (two mounts take each other down)', from: 'if (!win[SLOT]) win[SLOT] = createHubPresence(env);', to: 'win[SLOT] = createHubPresence(env);', fails: 'D3' },
  { id: 'arrow-room', why: 'a page that is followed by another runs into the "more" arrow', from: 'wrapDialog(DISCLOSURE_WORDS + more, measure, px - MORE_PX)', to: 'wrapDialog(DISCLOSURE_WORDS + more, measure, px)', fails: 'A9' },
  { id: 'no-question-page', why: 'the disclosure ends on a page of text, with no question', from: ", [DISCLOSURE_ASK, '']];", to: '];', fails: 'A8' },
  { id: 'also-unbounded', why: 'a host\'s sentence of any length is taken (the question is pushed past the 16 pages)', from: "also.trim().slice(0, 200)", to: 'also.trim()', fails: 'A10' },
  { id: 'label-as-room', why: 'a player who is open from the menu is offered as a room to join', from: 'room: g.h ? null : g.room,', to: 'room: g.room,', fails: 'B2' },
  { id: 'doing-wrong', why: 'a player who waits in a room is shown as open from the menu', from: "doing: g.h ? 'menu' : g.q ? 'looking' : 'waiting'", to: "doing: g.q ? 'looking' : 'menu'", fails: 'B1' },
  { id: 'roster-never-asked', why: 'watchPlayers(true) does not ask the board who is open', from: 'if (wantRoster && !l.isWatching()) l.startWatching(); else', to: 'if (false) l.startWatching(); else', fails: 'G2' },
  { id: 'roster-not-rewatched', why: 'the list is not watched again after the switch went off and on (a new board connection)', from: '    offMount = mount.onChange(onMount);\n', to: '    offMount = mount.onChange(emit);\n', fails: 'G9' },
  { id: 'start-no-ask', why: 'a blocked storage sends the player to the plain address, which asks nothing', from: "(token ? '' : '&ask=' + kind)", to: "''", fails: 'C7' },
  { id: 'start-meet-always', why: 'meet=1 is in the address although no token was written', from: "(token ? '&meet=1' : '')", to: "'&meet=1'", fails: 'C7' },
  { id: 'start-quick-is-host', why: 'BATTLE ANYONE writes the token of INVITE A FRIEND', from: 'const token = writeStartToken(session, { what: kind }, now);', to: "const token = writeStartToken(session, { what: 'host' }, now);", fails: 'C2' },
  { id: 'start-room-unnamed', why: 'OPEN THE ROOM writes a token that names no room', from: "writeStartToken(session, { what: 'host', room: code }, now) };", to: "writeStartToken(session, { what: 'host' }, now) };", fails: 'C3' },
  { id: 'start-any-room', why: 'a room that is not a room code gets an address', from: "  if (typeof room !== 'string' || !ROOM_RE.test(room)) return null;\n", to: "  if (typeof room !== 'string') return null;\n", fails: 'C8' },
  { id: 'pass-everything', why: 'every parameter of the hub page\'s address rides along', from: 'for (const k of PASS_PARAMS) if (q.get(k) !== null) p.set(k, q.get(k));', to: 'for (const [k, v] of q) p.set(k, v);', fails: 'C9' },
  { id: 'pass-nothing', why: 'the test seams are dropped on the way', from: 'for (const k of PASS_PARAMS) if (q.get(k) !== null) p.set(k, q.get(k));', to: '', fails: 'C9' },
  { id: 'go-keeps-screen', why: 'goBattle ignores { back } and always names the open screen', from: "leave(st.url, 'back' in o ? o.back : backPathFor(model.path()));", to: 'leave(st.url, backPathFor(model.path()));', fails: 'G14' },
  { id: 'dispose-keeps-mount', why: 'dispose leaves the mount (and its listing) alive', from: '      if (mount) safe(() => mount.dispose());\n', to: '', fails: 'G18' },
  { id: 'load-failure-throws', why: 'a presence_boot.js that cannot load is an unhandled rejection, and the service says "loading" for ever', from: "  }).catch((e) => { failed = true; if (win.console) win.console.warn('[presence] not available', e); emit(); return false; });", to: '  });', fails: 'G20' },
  // ---- presence_boot.js: the injection, and what the disclosure rests on
  { id: 'boot-ignores-injection', why: 'the injected challenge dialog is ignored (the DOM one is built)', file: 'presence_boot.js', from: 'const dialog = given.challenge || mountChallengeDialog({', to: 'const dialog = mountChallengeDialog({', fails: 'E1' },
  { id: 'boot-ignores-disclosure', why: 'the injected disclosure is ignored (the DOM one is built)', file: 'presence_boot.js', from: 'const disclosure = given.disclosure || (() => {', to: 'const disclosure = (() => {', fails: 'H2' },
  { id: 'boot-toggle-unasked', why: 'toggle() switches on without asking', file: 'presence_boot.js', from: 'if (!on && disclosureWanted()) { disclosure.show(confirmDisclosure); return Promise.resolve(false); }', to: '', fails: 'H2' },
  { id: 'boot-yes-not-remembered', why: 'YES is not remembered: every switch-on asks again', file: 'presence_boot.js', from: 'const confirmDisclosure = (o) => { markSeen(); return setOn(true, o); };', to: 'const confirmDisclosure = (o) => setOn(true, o);', fails: 'D15' },
  { id: 'boot-untold-on-honoured', why: 'a stored "on" nobody was told about is honoured', file: 'presence_boot.js', from: 'if (disclosureWanted()) setOpen(storage, false); else setOn(true, { persist: false });', to: 'setOn(true, { persist: false });', fails: 'D18' },
  { id: 'boot-start-silent', why: 'a host is not told when a start has finished ("starting" for ever in its picture)', file: 'presence_boot.js', from: "      notify();                                                       // (the start is over: 'starting' has become 'on')\n", to: '', fails: 'H3' },
  { id: 'boot-paint-silent', why: 'a host is not told when the switch or the board changes', file: 'presence_boot.js', from: '  function paint() {\n    notify();\n', to: '  function paint() {\n', fails: 'G2' },
  { id: 'boot-challenge-anonymous', why: 'a challenge goes out without the trainer name of the listing', file: 'presence_boot.js', from: 'return createChallenge({ lobbies, target, name: me.name, rec: me.rec || null,', to: "return createChallenge({ lobbies, target, name: 'Somebody', rec: me.rec || null,", fails: 'G5' },
  // ---- the dialog layer and the font: what "B answers NO", "a held direction cannot drift" and "any text is safe" rest on
  { id: 'layer-repeats-move', why: 'the repeats of a held direction move a dialog\'s highlight', file: 'hub_dialog.js', from: '    if (info && info.repeat) return [];\n', to: '', fails: 'E8' },
  { id: 'layer-b-first-option', why: 'B answers the FIRST option', file: 'hub_dialog.js', from: "if (action === 'b') return answer(d.choice ? d.choice.options.length - 1 : 'closed');", to: "if (action === 'b') return answer(d.choice ? 0 : 'closed');", fails: 'E6' },
  { id: 'layer-unarmed-answers', why: 'a dialog answers before it is armed', file: 'hub_dialog.js', from: "    if ((action === 'a' || action === 'b') && !armed(d)) return [];\n", to: '', fails: 'E4' },
  { id: 'layer-text-tap-answers', why: 'a tap on the text of a question answers it', file: 'hub_dialog.js', from: "    return d.choice ? [] : answer('closed');                    // ... and closes a notice, but never answers a question", to: "    return answer(d.choice ? d.choice.cursor : 'closed');", fails: 'E11' },
  { id: 'font-draws-anything', why: 'a character the ROM font lacks is handed to it as it is', file: 'battle_ui.js', from: "    out += ok ? ch : '?';", to: '    out += ch;', fails: 'A6' },
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hp-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file || 'hub_presence.js');
      const text = fs.readFileSync(target, 'utf8');
      const n = text.split(mu.from).length - 1;
      if (n !== 1) { const row = { id: mu.id, killed: false, why: 'PATTERN FOUND ' + n + 'x (the mutant did not apply once)' }; out.push(row); say(row); continue; }
      fs.writeFileSync(target, text.replace(mu.from, () => mu.to));
      const before = fail, mark = failures.length, saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      const onRej = () => { /* a mutant may leave a rejection unhandled: that is one of the things a case notices */ };
      process.on('unhandledRejection', onRej);
      const started = Date.now();
      const work = load(dir).then((M2) => suite(M2, mu.id));
      let timer = 0;
      try { await Promise.race([work, new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('mutant run timed out')), 60000); })]); } catch (e) { threw = e; }
      clearTimeout(timer);
      // a run that hung is told to stop at its next wait, is given a moment to, and its pages and boards are taken down whatever it does: nothing of it may be listed while the next mutant runs
      if (threw && /timed out/.test(String(threw.message))) { gaveUp.add(mu.id); await Promise.race([work.catch(() => {}), sleep(3000)]); const c = cleanups.get(mu.id); if (c) await c().catch(() => {}); }
      cleanups.delete(mu.id);
      await sleep(20);
      process.off('unhandledRejection', onRej);
      const failedNow = failures.slice(mark);
      const named = failedNow.some((f) => f.startsWith('[' + mu.id + '] ' + mu.fails + ' '));
      const row = { id: mu.id, ms: Date.now() - started, killed: fail > before || !!threw, named, fails: mu.fails, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 80) : null, first: failedNow.slice(0, 3).map((f) => f.replace('[' + mu.id + '] ', '').split(' ')[0]) };
      out.push(row); say(row);
      fail = before; failures.length = mark;
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

const t0 = Date.now();
await suite(await load(SRC), '');
console.log(`hub presence: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let survived = 0, unnamed = 0;
if (WANT_MUTANTS) {
  const keep = fail, keepFailures = failures.slice();
  const res = await runMutants();
  fail = keep; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { if (!m.killed) survived++; else if (!isGood(m)) unnamed++; }
  console.log(`mutants: ${res.length - survived - unnamed}/${res.length} killed by the case they name`);
}
if (fail || survived || unnamed) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
