// pokemonarena/js/center_hub.js -- THE TRAINER CENTER in the hub's picture: the app's state machine (pokemonarena/INAPP.md "The app interface" is the contract every line here follows).
//
// A walkable Pokemon Center. THE ROOM IS THE ROM'S: which cells can be walked, where the door mat, the counter, the nurse, the PC, the wall map and the signs are come from the ROM's own map
// at run time (center_room.js roomFromWorld), handed to this model by its ctl (setRoom). Nothing of the map is written here; until a room is handed in the screen is empty and B goes back.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no network, no randomness. Everything that is not pure is center_ctl.js, which drives this model through the methods
// under "FOR THE CTL" and hears its effects ({ app: 'center', type }).
//
// SCREEN    center   (parent: 'online', where it is opened from). One path; what is on it is the MODE:
//   wait    the screen is open but the player has not walked in: Open to battles is starting, or the first-time disclosure is being asked (hub_presence.js). Nothing is published. B goes back
//   room    walking. GBA walking: one cell at a time on the 16 px grid, 16 frames a cell, the ROM's three-picture walk; a held direction keeps walking (tick(path, held)); a direction pressed
//           while standing turns at once and walks if it is still held 8 frames later; walls and the counter stop you (the ROM's collision). A is whatever you face; B / START open the menu;
//           a tap on a floor cell walks there by the shortest way, a tap on a trainer or a thing walks up to it and does what A does. People do not block people
//   menu    LOOK / EMOTE / TEAM / WHO'S HERE / EXIT (B or START closes it)
//   look    the picker over the ROM's trainer sprites (room.looks), sixteen to a page, the highlighted one walking in place
//   emote   the picker over the ROM's emote icons
//   who     WHO'S HERE: everyone who is open, in the room or not; A on a row is what A is in front of them
// WHAT A DOES in front of: another player -> "<NAME>   W-L online" and ASK TO BATTLE / CANCEL (JOIN THEIR BATTLE when they host a listed game; a plain line when they cannot be battled);
//   the nurse (across the counter) -> a welcome and the way to PLAY ONLINE; the PC -> the Team Builder (B there comes back here, to where you stood); the wall map -> WHO'S HERE;
//   a sign -> what the Center shares about you. Standing on the door mat and stepping down leaves.
// THE QUESTIONS are the hub's dialog layer (ROM message box and window): ids 'center:talk', 'center:asking', 'center:note', 'center:nurse', 'center:sign'.
//
// EFFECTS for the ctl: { app: 'center', type: 'moved' } (I stepped or turned: tell the room) | 'look' { code } | 'emote' { e } | 'ask' { id, name } | 'join' { id, room } | 'cancel-ask' |
//   'sound' { what: 'bump' | 'door' | 'pc' }. A press in the room names its own sound ({ type: 'sfx', key: null }: a step is silent; the menu opens with the ROM's window sound).

import { createMenu } from './hub_menu.js';
import { wrapDialog, DIALOG_ARM_TICKS } from './hub_dialog.js';
import { createGrid, ahead, VEC, CELL, STATUS_EMOTE } from './center_room.js';
import { lookFor, lookCode, lookId } from './center_look.js';

const ID = 'center';
const PATHS = Object.freeze(['center']);
const parent = () => 'online';

/** Frames (the hub's clock, 59.7275 Hz): a cell, the turn before a walk, between two bump sounds, an emote over a head; and how far (px) a trainer may lag before they are simply put where they are. */
export const WALK = Object.freeze({ step: 16, turn: 8, bump: 32, emote: 120, snap: 40 });
/** The walk cycle within one cell: the first half shows a walk picture (alternating the ROM's two), the second half the standing one. */
export const stepOf = (t, foot) => (t < WALK.step / 2 ? foot : 0);
/** The room's rectangles besides the map itself (logical pixels). A window's numbers are its INTERIOR (the ROM ring is outside it). */
export const CGEOM = Object.freeze({
  menu: Object.freeze({ x: 150, y: 10, w: 78 }),
  hint: Object.freeze({ x: 190, y: 145, w: 50, h: 15 }),                                             // what B does, in the black strip under the room; a tap on it opens the menu
  look: Object.freeze({ x: 8, y: 8, w: 224, h: 96, top: 16, cols: 8, rows: 2, cw: 28, ch: 40 }),     // a title row, then 8 x 2 sprites of 16 x 32
  emote: Object.freeze({ x: 24, y: 32, w: 192, h: 64, top: 16, cols: 8, rows: 2, cw: 24, ch: 24 }),  // a title row, then 8 x 2 icons of 16 x 16
  who: Object.freeze({ x: 12, y: 8, w: 216, h: 96, top: 16, rows: 5, pitch: 16 }),                   // a title row, then five trainers
});
export const DLG = Object.freeze({ talk: 'center:talk', asking: 'center:asking', note: 'center:note', nurse: 'center:nurse', sign: 'center:sign' });
export const MENU_ROWS = Object.freeze([['look', 'LOOK'], ['emote', 'EMOTE'], ['team', 'TEAM'], ['who', "WHO'S HERE"], ['exit', 'EXIT']].map(([id, label]) => Object.freeze({ id, kind: 'item', label })));
/** Every sentence of the room that this site wrote (the ROM has no line for them); each is set in the ROM font and measured against its window by the tests. */
export const WORDS = Object.freeze({
  also: 'In the Trainer Center your look and where you stand are listed too.',
  shares: 'While you are in the Trainer Center you are open to battles. Your trainer name, your look, where you stand and your online record are on public servers. Leaving takes it all down.',
  nurse: 'Welcome to the TRAINER CENTER! Everyone here is open to battles. Walk up to a trainer and press A.',
  nurseAsk: 'To battle a friend, or anyone who is looking, use PLAY ONLINE. Go there now?',
  getting: 'is still getting ready to battle.',
  version: 'is on another version of the Arena. Reloading the page on both sides fixes it.',
  here: 'is here in the TRAINER CENTER.',
  menu: "is open from the Arena's menu.",
  cancelled: 'Challenge cancelled.',
  off: 'OPEN TO BATTLES was switched off, so you left the TRAINER CENTER.',
  noStart: 'OPEN TO BATTLES could not start, so the TRAINER CENTER is closed for now.',
  hint: 'B: MENU', starting: 'GETTING READY...', connecting: 'CONNECTING...', offline: 'OFFLINE', noRoom: 'LOADING...',
  lookMsg: Object.freeze(['Choose how you look.', 'A: this one   B: back']), emoteMsg: Object.freeze(['Choose an emote.', 'A: show it   B: back']), whoMsg: 'A: battle   B: back', whoNone: 'Nobody else is here yet.',
});
export const ANSWER_WORDS = Object.freeze({
  declined: (n) => n + ' said not now.',
  busy: (n) => n + ' is answering another challenge. Try again in a moment.',
  timeout: (n) => n + ' did not answer.',
  unsupported: () => 'This browser cannot send a private challenge. Use PLAY ONLINE with a room code.',
  gone: (n) => n + ' is not open to battles any more.',
  off: () => 'You are not open to battles yet. Try again in a moment.',
  storage: () => 'The battle could not be opened: this browser blocks the storage it needs.',
});
export const DOING = Object.freeze({ here: 'HERE', arriving: 'ARRIVING', menu: 'IN THE MENU', looking: 'LOOKING', waiting: 'WAITING', other: 'OTHER VERSION' });
const DIR_KEYS = Object.freeze(['up', 'down', 'left', 'right']);
const SILENT = Object.freeze({ type: 'sfx', key: null });
const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const recOf = (rec) => (Array.isArray(rec) && rec.length === 2 && rec.every((n) => Number.isInteger(n) && n >= 0) ? [rec[0], rec[1]] : null);
const recText = (rec) => (rec ? rec[0] + '-' + rec[1] : '');
const fmtText = (f) => (f === '6v6' ? '6 v 6' : '3 v 3');
// a stable number from a board id: a player who lists no look is still the same trainer every time
const hashOf = (s) => { let h = 0x811c9dc5; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; return h; };

export function createCenterHub(ctx) {
  const menu = createMenu(CGEOM.menu);
  const me = { x: 0, y: 0, d: 'up', mv: null, turn: 0, bump: 0, foot: 1, look: null, name: 'Player', rec: null, emote: null, placed: false };
  const S = {
    room: null, grid: null, phase: 'closed', mode: 'room', net: 'off', why: '',
    walk: null,               // a tapped walk: { steps, face, after }
    lastDir: null,            // the direction pressed last (of several held, it is the one that counts)
    people: [], disp: new Map(), spotOf: new Map(),
    talk: null, asking: null, keep: false,
    lookCur: 0, emoCur: 0, whoCur: 0, whoFrom: 'menu', tick: 0,
  };
  const looks = () => (S.room ? S.room.looks : []);
  const eff = (type, o) => ({ app: ID, type, ...(o || {}) });
  const px = ctx.msgPx - 14;                                           // (a page that is followed by another leaves room for the "more" arrow)
  const pagesOf = (text) => wrapDialog(text, ctx.measure, px);
  const closeAll = () => { for (const id of [DLG.talk, DLG.asking, DLG.nurse, DLG.sign, DLG.note]) ctx.dialog.close(id); };
  const note = (text) => { ctx.dialog.close(DLG.note); ctx.dialog.open({ id: DLG.note, pages: pagesOf(text), choice: null }); };
  const inRoom = () => S.phase === 'in' && !!S.grid;

  /* ---------------------------------------------------------------- who is in the room */
  // the sprite a code draws: the ROM sprite it names; the first avatar for an old code, junk or an id the ROM's list lacks (INAPP.md "Contract 4"); for a player who lists NO look, one picked by their id
  const gfxOf = (code, id) => { const L = looks(); return (code === null || code === undefined) && L.length ? L[hashOf(id) % L.length] : lookFor(code, L); };
  /**
   * The people the room shows, from the room's walkers (center_net.js list()) and the board's open players (hub_presence.js players()). A walker's `b` names their listing (each listing is
   * claimed by the FIRST walker who names it: a copycat cannot take over somebody else's); the players nobody walks as stand at the spots, in the order they were first seen, and keep their spot;
   * those beyond the last spot are in the list only.
   */
  function compose(walkers, players) {
    const out = [], linked = new Set(), named = new Set(), byId = new Map();
    for (const p of players) if (p && typeof p.id === 'string') byId.set(p.id, p);
    for (const w of walkers) {
      if (!w || typeof w.s !== 'string') continue;
      if (w.b) named.add(w.b);
      const g = w.b && !linked.has(w.b) ? byId.get(w.b) || null : null;
      if (g) linked.add(g.id);
      out.push({ id: 'w:' + w.s, kind: 'walker', name: String(w.name).slice(0, 12), rec: recOf(w.rec) || (g ? recOf(g.rec) : null), gfx: gfxOf(w.av, w.s), x: w.x, y: w.y, d: w.d, listing: g, doing: !g ? 'arriving' : g.compatible ? 'here' : 'other', emote: w.emote && Number.isInteger(w.emote.e) ? w.emote.e : null });
    }
    const rest = [...byId.values()].filter((p) => !linked.has(p.id) && !named.has(p.id));
    const still = new Set(rest.map((p) => p.id));
    for (const id of [...S.spotOf.keys()]) if (!still.has(id)) S.spotOf.delete(id);
    const spots = S.room ? S.room.spots : [], used = new Set(S.spotOf.values());
    for (const p of rest) {
      if (!S.spotOf.has(p.id)) { const free = spots.findIndex((_s, i) => !used.has(i)); if (free >= 0) { S.spotOf.set(p.id, free); used.add(free); } }
      const sp = S.spotOf.has(p.id) ? spots[S.spotOf.get(p.id)] : null;
      const doing = !p.compatible ? 'other' : p.doing === 'looking' || p.doing === 'waiting' ? p.doing : 'menu';
      out.push({ id: 'g:' + p.id, kind: sp ? 'spot' : 'list', name: String(p.name).slice(0, 12), rec: recOf(p.rec), gfx: gfxOf(p.look, p.id), x: sp ? sp.x : -1, y: sp ? sp.y : -1, d: sp ? sp.d : 'down', listing: p, doing, emote: sp ? STATUS_EMOTE[doing] : null });
    }
    return out;
  }
  const inPicture = (p) => p.kind !== 'list';
  const personAt = (x, y) => S.people.filter((p) => inPicture(p) && p.x === x && p.y === y).pop() || null;
  const dispOf = (p) => (p.kind === 'walker' && S.disp.get(p.id)) || { px: p.x * CELL, py: p.y * CELL, anim: 0, foot: 1 };

  /* ---------------------------------------------------------------- talking */
  function talk(p) {
    const fx = [];
    const dx = p.x - me.x, dy = p.y - me.y;
    if (inPicture(p) && Math.abs(dx) + Math.abs(dy) === 1) { const want = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down'; if (want !== me.d) { me.d = want; fx.push(eff('moved')); } }
    const who = p.name + (p.rec ? '   ' + recText(p.rec) + ' online' : '');
    const g = p.listing;
    ctx.dialog.close(DLG.talk);
    if (!g) { ctx.dialog.open({ id: DLG.talk, pages: [[who, WORDS.getting]], choice: null }); S.talk = null; return fx; }
    if (!g.compatible) { ctx.dialog.open({ id: DLG.talk, pages: [[who, ''], ...pagesOf(p.name + ' ' + WORDS.version)], choice: null }); S.talk = null; return fx; }
    const join = g.doing === 'looking' || g.doing === 'waiting';
    const where = join ? 'is waiting for an opponent (' + fmtText(g.fmt) + ').' : p.kind === 'walker' ? WORDS.here : WORDS.menu;
    S.talk = { id: g.id, name: p.name, join, room: join ? g.room : null };
    ctx.dialog.open({ id: DLG.talk, pages: [[who, where]], choice: { options: [join ? 'JOIN THEIR BATTLE' : 'ASK TO BATTLE', 'CANCEL'], cursor: 0 } });
    return fx;
  }
  function use(kind) {
    if (kind === 'nurse') { ctx.dialog.close(DLG.nurse); ctx.dialog.open({ id: DLG.nurse, pages: [...pagesOf(WORDS.nurse), ...pagesOf(WORDS.nurseAsk)], choice: { options: ['PLAY ONLINE', 'STAY HERE'], cursor: 1 } }); return []; }
    if (kind === 'pc') { S.keep = true; return [SILENT, eff('sound', { what: 'pc' }), ...ctx.go('builder')]; }
    if (kind === 'map') { openWho('room'); return []; }
    if (kind === 'sign') { ctx.dialog.close(DLG.sign); ctx.dialog.open({ id: DLG.sign, pages: pagesOf(S.why || WORDS.shares), choice: null }); return []; }
    return [];
  }
  /** A: whatever is in front of me (a trainer on my own cell counts: people do not block people). */
  function act() {
    if (me.mv) return [SILENT];
    const f = ahead(me.x, me.y, me.d);
    const p = personAt(f.x, f.y) || personAt(me.x, me.y);
    if (p) return talk(p);
    const kind = S.grid.facing(me.x, me.y, me.d);
    return kind ? use(kind) : [SILENT];
  }

  /* ---------------------------------------------------------------- walking */
  const exit = () => [SILENT, eff('sound', { what: 'door' }), ...ctx.back()];
  function step(dir, fx) {
    const turned = me.d !== dir;
    me.d = dir;
    if (S.grid.isDoor(me.x, me.y) && S.room.door.d === dir) { S.walk = null; fx.push(...exit()); return; }          // off the mat, the way the mat points: out
    const n = ahead(me.x, me.y, dir);
    if (S.grid.walkable(n.x, n.y)) { me.x = n.x; me.y = n.y; me.mv = { d: dir, t: 0 }; me.foot = me.foot === 1 ? 2 : 1; me.bump = 0; fx.push(eff('moved')); return; }          // (one message a step: the cell and the facing together)
    S.walk = null;
    if (turned) fx.push(eff('moved'));
    if (me.bump <= 0) { me.bump = WALK.bump; fx.push(eff('sound', { what: 'bump' })); }
  }
  function walkTo(to, after, opts) {
    const r = S.grid.findPath({ x: me.x, y: me.y }, to, opts);
    if (!r) return false;
    S.walk = { steps: r.steps.slice(), face: r.face || (after && after.face) || null, after: after || null };
    return true;
  }
  function arrive(fx) {
    const w = S.walk; S.walk = null;
    if (!w) return;
    if (w.face && w.face !== me.d) { me.d = w.face; fx.push(eff('moved')); }
    const a = w.after;
    if (!a) return;
    if (a.kind === 'person') { const p = S.people.find((q) => q.id === a.id); if (p && inPicture(p) && Math.abs(p.x - me.x) + Math.abs(p.y - me.y) <= 1) fx.push(...talk(p)); }
    else if (a.kind === 'thing') { if (S.grid.facing(me.x, me.y, me.d) === a.thing) fx.push(...use(a.thing)); }
    else if (a.kind === 'exit') { if (S.grid.isDoor(me.x, me.y)) step(S.room.door.d, fx); }
  }
  function approach(p) {
    const d = Math.abs(p.x - me.x) + Math.abs(p.y - me.y);
    if (!me.mv && d <= 1) return talk(p);
    walkTo({ x: p.x, y: p.y }, { kind: 'person', id: p.id }, { adjacent: true });
    return [SILENT];
  }
  const heldDir = (held) => (S.lastDir && held[S.lastDir] ? S.lastDir : DIR_KEYS.find((d) => held[d]) || null);

  /* ---------------------------------------------------------------- the menu, the pickers, the list */
  const lookIndex = () => { const i = looks().indexOf(lookFor(me.look, looks())); return i < 0 ? 0 : i; };
  const perPage = (G) => G.cols * G.rows;
  const lookPages = () => Math.max(1, Math.ceil(looks().length / perPage(CGEOM.look)));
  const cellRect = (G, i) => ({ x: G.x + (i % G.cols) * G.cw, y: G.y + G.top + Math.floor(i / G.cols) * G.ch, w: G.cw, h: G.ch });
  const LOOK_PREV = Object.freeze({ x: CGEOM.look.x + CGEOM.look.w - 76, y: CGEOM.look.y, w: 20, h: 16 }), LOOK_NEXT = Object.freeze({ x: CGEOM.look.x + CGEOM.look.w - 20, y: CGEOM.look.y, w: 20, h: 16 });
  function openMenu() { S.mode = 'menu'; S.walk = null; menu.setCursor(0); return [{ type: 'sfx', key: 'se_menu_open' }]; }
  function openWho(from) { S.mode = 'who'; S.whoFrom = from; S.whoCur = 0; S.walk = null; }
  const rank = (p) => (p.kind === 'walker' ? 0 : p.kind === 'spot' ? 1 : 2);
  const whoRows = () => S.people.slice().sort((a, b) => rank(a) - rank(b));
  const whoTop = (n) => Math.max(0, Math.min(Math.min(S.whoCur, Math.max(0, n - 1)) - 2, n - CGEOM.who.rows));
  /** Move a cursor over a grid of `n` things, `G.cols` to a row, a page at a time when it runs off one (L / R turn the page). */
  function gridMove(cur, n, G, action) {
    if (n < 1) return 0;
    const pp = perPage(G), page = Math.floor(cur / pp), at = cur % pp, row = Math.floor(at / G.cols), pages = Math.ceil(n / pp);
    if (action === 'left') return (cur + n - 1) % n;
    if (action === 'right') return (cur + 1) % n;
    if (action === 'up' || action === 'down') { const t = page * pp + (at % G.cols) + ((row + (action === 'up' ? G.rows - 1 : 1)) % G.rows) * G.cols; return t < n ? t : cur; }
    if (action === 'l') return Math.min(n - 1, ((page + pages - 1) % pages) * pp + at);
    if (action === 'r') return Math.min(n - 1, ((page + 1) % pages) * pp + at);
    return cur;
  }
  function chooseLook(i) { const L = looks(); if (!L.length) return []; const code = lookCode(L[Math.max(0, Math.min(L.length - 1, i))]); me.look = code; S.mode = 'room'; return [eff('look', { code })]; }
  function chooseEmote(e) { S.mode = 'room'; return [eff('emote', { e })]; }
  function menuAct(r) {
    if (!r) return [];
    if (r.kind === 'back') { S.mode = 'room'; return []; }
    if (r.kind !== 'choose') return [];
    const id = r.row.id;
    if (id === 'look') { S.mode = 'look'; S.lookCur = lookIndex(); return []; }
    if (id === 'emote') { S.mode = 'emote'; return []; }
    if (id === 'team') { S.keep = true; S.mode = 'room'; return ctx.go('builder'); }
    if (id === 'who') { openWho('menu'); return []; }
    if (id === 'exit') { S.mode = 'room'; return [eff('sound', { what: 'door' }), ...ctx.back()]; }
    return [];
  }

  /* ---------------------------------------------------------------- what the pointer can take */
  function roomTarget(x, y) {
    if (inR(CGEOM.hint, x, y)) return { kind: 'menu' };
    const hit = S.people.filter(inPicture).map((p) => ({ p, v: dispOf(p) })).filter(({ v }) => x >= v.px && x < v.px + CELL && y >= v.py - CELL && y < v.py + CELL).sort((a, b) => b.v.py - a.v.py)[0];
    if (hit) return { kind: 'person', id: hit.p.id };
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    const t = S.grid.thingAt(cx, cy);
    if (t) return { kind: 'thing', thing: t.kind, use: t.use };
    if (S.grid.isDoor(cx, cy)) return { kind: 'exit', x: cx, y: cy };
    return S.grid.walkable(cx, cy) ? { kind: 'cell', x: cx, y: cy } : null;
  }
  function pickerHit(G, n, cur, x, y) {
    const pp = perPage(G), base = Math.floor(cur / pp) * pp;
    for (let i = 0; i < pp && base + i < n; i++) if (inR(cellRect(G, i), x, y)) return { kind: 'cell', index: base + i };
    return null;
  }
  function hitOf(x, y) {
    if (!inRoom()) return null;
    if (S.mode === 'room') return roomTarget(x, y);
    if (S.mode === 'menu') return menu.hit(x, y, MENU_ROWS);
    if (S.mode === 'look') return inR(LOOK_PREV, x, y) ? { kind: 'page', dir: -1 } : inR(LOOK_NEXT, x, y) ? { kind: 'page', dir: 1 } : pickerHit(CGEOM.look, looks().length, S.lookCur, x, y);
    if (S.mode === 'emote') return pickerHit(CGEOM.emote, S.room.emotes, S.emoCur, x, y);
    if (S.mode === 'who') { const G = CGEOM.who, rows = whoRows(), top = whoTop(rows.length); const i = Math.floor((y - G.y - G.top) / G.pitch); return x >= G.x && x < G.x + G.w && i >= 0 && i < G.rows && top + i < rows.length ? { kind: 'row', index: top + i } : null; }
    return null;
  }

  return {
    id: ID, paths: PATHS, parent,
    enter() { S.phase = 'wait'; S.mode = 'room'; S.walk = null; S.talk = null; S.asking = null; me.mv = null; me.turn = 0; me.bump = 0; me.emote = null; S.people = []; S.disp.clear(); S.spotOf.clear(); return []; },
    leave() { closeAll(); S.phase = 'closed'; S.mode = 'room'; S.walk = null; S.talk = null; S.asking = null; me.mv = null; me.emote = null; },
    press(_path, action, info) {
      const repeat = !!(info && info.repeat);
      if (!inRoom()) return action === 'b' && !repeat ? ctx.back() : [];
      if (S.mode === 'room') {
        if (VEC[action]) {
          if (repeat) return [SILENT];
          S.lastDir = action; S.walk = null;
          if (!me.mv && me.d !== action) { me.d = action; me.turn = WALK.turn; return [SILENT, eff('moved')]; }          // a direction pressed while standing TURNS at once; held on, the tick walks
          return [SILENT];
        }
        if (repeat) return [SILENT];
        if (action === 'a') return act();
        if (action === 'b' || action === 'start') return openMenu();
        if (action === 'x') { S.mode = 'emote'; S.walk = null; return [{ type: 'sfx', key: 'se_menu_open' }]; }
        if (action === 'y') { S.mode = 'look'; S.walk = null; S.lookCur = lookIndex(); return [{ type: 'sfx', key: 'se_menu_open' }]; }
        return [SILENT];
      }
      if (S.mode === 'menu') return action === 'start' ? menuAct({ kind: 'back' }) : menuAct(menu.press(action, MENU_ROWS));
      if (S.mode === 'look') {
        if (action === 'a') return chooseLook(S.lookCur);
        if (action === 'b') { S.mode = 'menu'; return []; }
        S.lookCur = gridMove(S.lookCur, looks().length, CGEOM.look, action); return [];
      }
      if (S.mode === 'emote') {
        if (action === 'a') return chooseEmote(S.emoCur);
        if (action === 'b') { S.mode = 'menu'; return []; }
        S.emoCur = gridMove(S.emoCur, S.room.emotes, CGEOM.emote, action); return [];
      }
      if (S.mode === 'who') {
        const rows = whoRows(), n = rows.length;
        if (action === 'b') { S.mode = S.whoFrom === 'room' ? 'room' : 'menu'; return []; }
        if (action === 'a') return n ? talk(rows[Math.min(S.whoCur, n - 1)]) : [];
        if (n && (action === 'up' || action === 'down')) S.whoCur = (Math.min(S.whoCur, n - 1) + (action === 'up' ? n - 1 : 1)) % n;
        return [];
      }
      return [];
    },
    hit: (_path, x, y) => hitOf(x, y),
    pointer(_path, ev) {
      if (!ev || !inRoom()) return [];
      if (S.mode === 'menu') { if (ev.kind === 'click' && !menu.hit(ev.x, ev.y, MENU_ROWS)) return menuAct({ kind: 'back' }); return menuAct(menu.pointer(ev, MENU_ROWS)); }
      if (ev.kind === 'wheel') {
        const s = ev.steps || 0;
        if (S.mode === 'look' && s) S.lookCur = gridMove(S.lookCur, looks().length, CGEOM.look, s > 0 ? 'r' : 'l');
        if (S.mode === 'who') { const n = whoRows().length; if (n) S.whoCur = Math.max(0, Math.min(n - 1, S.whoCur + (s > 0 ? 1 : -1))); }
        return [];
      }
      const h = ev.x === undefined || ev.x === null ? null : hitOf(ev.x, ev.y);
      if (S.mode === 'room') {
        if (ev.kind !== 'click' || !h) return [];
        if (h.kind === 'menu') return openMenu();
        if (h.kind === 'person') { const p = S.people.find((q) => q.id === h.id); return p ? approach(p) : [SILENT]; }
        if (h.kind === 'thing') {
          if (!me.mv && me.x === h.use.x && me.y === h.use.y) { const fx = []; if (me.d !== 'up') { me.d = 'up'; fx.push(eff('moved')); } return fx.concat(use(h.thing)); }
          walkTo(h.use, { kind: 'thing', thing: h.thing, face: 'up' });
          return [SILENT];
        }
        if (h.kind === 'exit') { if (!me.mv && S.grid.isDoor(me.x, me.y)) { const fx = []; step(S.room.door.d, fx); return fx; } walkTo({ x: h.x, y: h.y }, { kind: 'exit' }); return [SILENT]; }
        walkTo({ x: h.x, y: h.y }, null);
        return [SILENT];
      }
      if (S.mode === 'look') {
        if (!h) return [];
        if (h.kind === 'page') { if (ev.kind === 'click') S.lookCur = gridMove(S.lookCur, looks().length, CGEOM.look, h.dir > 0 ? 'r' : 'l'); return []; }
        S.lookCur = h.index;
        return ev.kind === 'click' ? chooseLook(h.index) : [];
      }
      if (S.mode === 'emote') { if (!h) return []; S.emoCur = h.index; return ev.kind === 'click' ? chooseEmote(h.index) : []; }
      if (S.mode === 'who') { if (!h) return []; S.whoCur = h.index; return ev.kind === 'click' ? talk(whoRows()[h.index]) : []; }
      return [];
    },
    rects() {
      if (!inRoom()) return [];
      if (S.mode === 'menu') return menu.rects(MENU_ROWS);
      if (S.mode === 'look') { const n = looks().length, pp = perPage(CGEOM.look), base = Math.floor(S.lookCur / pp) * pp, out = []; for (let i = 0; i < pp && base + i < n; i++) out.push({ ...cellRect(CGEOM.look, i), kind: 'look', index: base + i }); return out.concat([{ ...LOOK_PREV, kind: 'page', dir: -1 }, { ...LOOK_NEXT, kind: 'page', dir: 1 }]); }
      if (S.mode === 'emote') { const out = []; for (let i = 0; i < S.room.emotes; i++) out.push({ ...cellRect(CGEOM.emote, i), kind: 'emote', index: i }); return out; }
      if (S.mode === 'who') { const G = CGEOM.who, rows = whoRows(), top = whoTop(rows.length); return rows.slice(top, top + G.rows).map((p, i) => ({ x: G.x, y: G.y + G.top + i * G.pitch, w: G.w, h: G.pitch, kind: 'row', index: top + i, id: p.id })); }
      const out = S.people.filter(inPicture).map((p) => { const v = dispOf(p); return { x: v.px, y: v.py - CELL, w: CELL, h: 2 * CELL, kind: 'person', id: p.id }; });
      const cell = (c, kind) => ({ x: c.x * CELL, y: c.y * CELL, w: CELL, h: CELL, kind });
      for (const t of S.room.pc) out.push(cell(t, 'pc'));
      for (const t of S.room.map) out.push(cell(t, 'map'));
      for (const t of S.room.signs) out.push(cell(t, 'sign'));
      if (S.room.nurse) out.push(cell(S.room.nurse, 'nurse'));
      out.push(cell(S.room.door, 'exit'), { ...CGEOM.hint, kind: 'menu' });
      return out;
    },
    tick(_path, held) {
      S.tick++;
      if (!inRoom()) return [];
      const fx = [];
      if (me.emote && ++me.emote.t >= WALK.emote) me.emote = null;
      // the others glide to where they say they are, a pixel a frame (the speed they walk at); one who is far behind is simply put there
      for (const p of S.people) {
        if (p.kind !== 'walker') continue;
        const v = S.disp.get(p.id); if (!v) continue;
        const tx = p.x * CELL, ty = p.y * CELL, ex = tx - v.px, ey = ty - v.py;
        if (!ex && !ey) { v.anim = 0; continue; }
        if (Math.abs(ex) + Math.abs(ey) > WALK.snap) { v.px = tx; v.py = ty; v.anim = 0; continue; }
        if (ex) v.px += Math.sign(ex); else v.py += Math.sign(ey);
        if (v.anim % WALK.step === 0) v.foot = v.foot === 1 ? 2 : 1;
        v.anim++;
      }
      let flowing = false;
      if (me.mv && ++me.mv.t >= WALK.step) { me.mv = null; flowing = true; }
      if (me.mv) return fx;
      if (me.bump > 0) me.bump--;
      const manual = S.mode === 'room' ? heldDir(held) : null;
      if (manual) {
        S.walk = null;
        if (me.d !== manual && !flowing) { me.d = manual; me.turn = WALK.turn; fx.push(eff('moved')); return fx; }          // standing: turn first. At the end of a step the new direction is walked at once
        if (me.turn > 0) { me.turn--; return fx; }
        step(manual, fx);
        return fx;
      }
      me.turn = 0;
      if (S.walk) { if (S.walk.steps.length) step(S.walk.steps.shift(), fx); else arrive(fx); }
      return fx;
    },
    onData: () => [],
    onDialog(id, value) {
      if (id === DLG.talk) {
        const t = S.talk; S.talk = null;
        if (value !== 0 || !t) return [];
        if (t.join) return [eff('join', { id: t.id, room: t.room })];
        S.asking = { id: t.id, name: t.name };
        ctx.dialog.close(DLG.asking);
        // (the A that chose ASK TO BATTLE is not the A that cancels: the question listens after the arm delay)
        ctx.dialog.open({ id: DLG.asking, pages: [['Asked ' + t.name + ' to battle.', 'Waiting for an answer...']], choice: { options: ['CANCEL'], cursor: 0 }, armTicks: DIALOG_ARM_TICKS });
        return [eff('ask', { id: t.id, name: t.name })];
      }
      if (id === DLG.asking) { if (!S.asking) return []; S.asking = null; note(WORDS.cancelled); return [eff('cancel-ask')]; }
      if (id === DLG.nurse) return value === 0 ? ctx.go('online') : [];
      return [];
    },
    wantsText: () => false,
    type: () => [],
    view(path, base) {
      const c = { phase: S.phase, mode: S.mode, ready: !!S.room, people: [], hint: !S.room ? WORDS.noRoom : S.phase !== 'in' ? WORDS.starting : S.net === 'connecting' ? WORDS.connecting : S.net === 'down' ? WORDS.offline : WORDS.hint, menu: null, look: null, emote: null, who: null };
      if (inRoom()) {
        const list = S.people.filter(inPicture).map((p) => { const v = dispOf(p); return { id: p.id, kind: p.kind, gfx: p.gfx, px: v.px, py: v.py, d: p.d, step: v.anim ? stepOf((v.anim - 1) % WALK.step, v.foot) : 0, name: p.name, emote: p.emote === null ? null : { e: p.emote, f: p.kind === 'walker' ? (S.tick >> 4) & 1 : 0 } }; });
        const v = VEC[me.mv ? me.mv.d : me.d], back = me.mv ? WALK.step - me.mv.t : 0;
        list.push({ id: 'me', kind: 'me', gfx: lookFor(me.look, looks()), px: me.x * CELL - v[0] * back, py: me.y * CELL - v[1] * back, d: me.d, step: me.mv ? stepOf(me.mv.t, me.foot) : me.bump > WALK.bump - WALK.step / 2 ? me.foot : 0, name: me.name, emote: me.emote ? { e: me.emote.e, f: (S.tick >> 4) & 1 } : null });
        // top to bottom (the lower a trainer stands, the later they are drawn); on one row I am drawn last, so I am never hidden behind somebody on my own cell
        list.sort((a, b) => a.py - b.py || (a.kind === 'me' ? 1 : b.kind === 'me' ? -1 : 0) || a.px - b.px);
        c.people = list;
        if (S.mode === 'menu') c.menu = menu.view(MENU_ROWS);
        if (S.mode === 'look') { const L = looks(), pp = perPage(CGEOM.look), page = Math.floor(S.lookCur / pp); c.look = { page, pages: lookPages(), cursor: S.lookCur - page * pp, items: L.slice(page * pp, page * pp + pp), step: [1, 0, 2, 0][(S.tick >> 3) & 3] }; }
        if (S.mode === 'emote') c.emote = { cursor: S.emoCur, count: S.room.emotes, f: (S.tick >> 4) & 1 };
        if (S.mode === 'who') { const rows = whoRows(), n = rows.length, top = whoTop(n), cur = n ? Math.min(S.whoCur, n - 1) : 0; c.who = { total: n, top, cursor: cur - top, rows: rows.slice(top, top + CGEOM.who.rows).map((p) => ({ name: p.name, rec: recText(p.rec), doing: DOING[p.doing] || '' })), up: top > 0, down: top + CGEOM.who.rows < n }; }
      }
      return { ...base, screen: path, app: ID, mascot: null, center: c };
    },
    // (no position and no step in the words: the page reads them out whenever they CHANGE)
    speak(v) {
      const c = v && v.center; if (!c) return 'Trainer Center.';
      if (c.phase !== 'in' || !c.ready) return 'Trainer Center. Getting ready. B goes back.';
      if (c.look) return 'Your look. Trainer ' + (c.look.page * perPage(CGEOM.look) + c.look.cursor + 1) + ' of ' + looks().length + '. A chooses, B goes back, L and R turn the page.';
      if (c.emote) return 'Emote ' + (c.emote.cursor + 1) + ' of ' + c.emote.count + '. A shows it, B goes back.';
      if (c.menu) return 'Trainer Center menu: ' + c.menu.rows.map((r, i) => (i === c.menu.cursor ? 'selected ' : '') + r.label).join(', ') + '. B closes it.';
      if (c.who) return "Who's here: " + (c.who.total ? c.who.rows.map((r, i) => (i === c.who.cursor ? 'selected ' : '') + r.name + (r.rec ? ' ' + r.rec : '') + ', ' + r.doing.toLowerCase()).join('; ') + '. A battles, B goes back.' : WORDS.whoNone + ' B goes back.');
      const others = S.people.map((p) => p.name);
      const f = ahead(me.x, me.y, me.d), p = personAt(f.x, f.y), kind = p ? null : S.grid.facing(me.x, me.y, me.d);
      const front = p ? ' In front of you: ' + p.name + '.' : kind ? ' In front of you: ' + ({ nurse: 'the nurse', pc: 'the PC, which opens the Team Builder', map: "the wall map, which lists who's here", sign: 'a sign' })[kind] + '.' : '';
      return 'Trainer Center. ' + (others.length ? others.length + (others.length === 1 ? ' other trainer is here: ' : ' other trainers are here: ') + others.join(', ') + '.' : WORDS.whoNone) + front + ' The arrows walk, A talks, B opens the menu.';
    },
    title: () => 'Pokemon Arena - Trainer Center',
    state: () => ({ phase: S.phase, mode: S.mode, x: me.x, y: me.y, d: me.d, moving: !!me.mv, walking: S.walk ? S.walk.steps.length + 1 : 0, look: me.look, emote: me.emote ? me.emote.e : null, people: S.people.length, cursor: S.mode === 'menu' ? menu.cursor() : S.mode === 'look' ? S.lookCur : S.mode === 'emote' ? S.emoCur : S.mode === 'who' ? S.whoCur : null, asking: S.asking ? S.asking.id : null, net: S.net }),

    /* ================================================================ FOR THE CTL (center_ctl.js) and the tests ================================================================ */
    /** The ROM's room (center_room.js roomFromWorld). Until it is handed in there is nothing to walk on. */
    setRoom(room) { S.room = room || null; S.grid = room ? createGrid(room) : null; me.placed = false; },
    room: () => S.room,
    /** Who I am: { name, rec, look } (each optional; look: a look code). */
    setMe(o) { if (!o) return; if (typeof o.name === 'string' && o.name) me.name = o.name.slice(0, 12); if ('rec' in o) me.rec = recOf(o.rec); if ('look' in o && (o.look === null || lookId(o.look) !== null)) me.look = o.look; },
    /** What the signs say (the disclosure's words and what the Center adds), from the ctl. */
    setShares(text) { S.why = typeof text === 'string' ? text : ''; },
    /**
     * WALK IN (the player is open to battles and has been told what that publishes): n picks the spawn cell (any unsigned integer: the ctl's random number). A player who left through the PC
     * or TEAM comes back to where they stood. -> false when there is no room or the screen is not open.
     */
    walkIn(n) {
      if (!S.grid || S.phase === 'closed') return false;
      const sp = S.room.spawns;
      if (!(S.keep && me.placed && S.grid.walkable(me.x, me.y))) { const s = sp.length ? sp[(Number.isFinite(n) ? Math.abs(Math.floor(n)) : 0) % sp.length] : { x: S.room.door.x, y: S.room.door.y, d: 'up' }; me.x = s.x; me.y = s.y; me.d = s.d; }
      S.keep = false; me.placed = true; me.mv = null; me.turn = 0; me.bump = 0; S.walk = null; S.phase = 'in'; S.mode = 'room';
      return true;
    },
    /** Am I walking in the room? */
    isIn: () => inRoom(),
    /** What the room is told about me: { name, rec, look, x, y, d }. */
    me: () => ({ name: me.name, rec: me.rec, look: me.look, x: me.x, y: me.y, d: me.d }),
    /** The people: walkers = center_net.js list(), players = hub_presence.js players() (names already safe text). */
    setRoster(o) {
      const r = o || {};
      S.people = compose(Array.isArray(r.walkers) ? r.walkers : [], Array.isArray(r.players) ? r.players : []);
      const seen = new Set();
      for (const p of S.people) { if (p.kind !== 'walker') continue; seen.add(p.id); if (!S.disp.has(p.id)) S.disp.set(p.id, { px: p.x * CELL, py: p.y * CELL, anim: 0, foot: 1 }); }
      for (const id of [...S.disp.keys()]) if (!seen.has(id)) S.disp.delete(id);
    },
    people: () => S.people.map((p) => ({ id: p.id, kind: p.kind, name: p.name, rec: p.rec, gfx: p.gfx, x: p.x, y: p.y, d: p.d, doing: p.doing, emote: p.emote, room: p.listing ? p.listing.room : null })),
    /** The room's connection: 'off' | 'connecting' | 'up' | 'down'. */
    setNet(s) { S.net = ['off', 'connecting', 'up', 'down'].includes(s) ? s : 'off'; },
    /** My own emote went out: show it over my head. */
    myEmote(e) { if (Number.isInteger(e) && S.room && e >= 0 && e < S.room.emotes) me.emote = { e, t: 0 }; },
    /** The player I asked said yes: the battle is opening. */
    askAccepted() { const a = S.asking; S.asking = null; ctx.dialog.close(DLG.asking); note((a ? a.name : 'They') + ' accepted! Opening the battle...'); },
    /** The challenge ended without a battle: why = 'declined' | 'busy' | 'timeout' | 'unsupported' | 'gone' | 'off' | 'storage'. */
    askFailed(why) { const a = S.asking; S.asking = null; ctx.dialog.close(DLG.asking); note((ANSWER_WORDS[why] || ANSWER_WORDS.timeout)(a ? a.name : 'They')); },
    /** A plain line over the room. */
    say(text) { note(text); },
    /** OUT, with a line saying why ('off': Open to battles went off elsewhere; 'noStart': it could not start). -> the effects that leave the screen. */
    kick(why) { if (S.phase === 'closed') return []; ctx.notify(pagesOf(WORDS[why] || WORDS.off).flat()); return ctx.back(); },
    /** Out without a word (the player said NO to the disclosure). */
    out() { return S.phase === 'closed' ? [] : ctx.back(); },
  };
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent, create: createCenterHub });
