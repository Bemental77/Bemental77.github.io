// pokemonarena/js/trainer_hub.js -- THE TRAINER app in the hub's 240x160 picture: the NEW TRAINER screens, the TRAINER CARD and the one-choice editor. The app's state machine.
// pokemonarena/INAPP.md "The app interface" is the contract with the hub; its section "TRAINER" (and "APP-UI: as built" at its end) is the contract with the other tracks.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness, nothing heavy imported (it is in the hub's first paint). What it knows of the ROM comes in as DATA
// from trainer_ctl.js (setChoices: the looks, the battle figures, the portraits, the species; setSeed: a random number; setMascot: the day's mascot); what it knows of the store comes from
// hub data (ctx.profiles(), read defensively: a profile from before schema 6 has no card) until the ctl hands the full list (setTrainers).
//
// THE PATHS
//   trainer        THE TRAINER CARD of the active trainer (parent 'main'): the card is the menu. NAME / LOOK / PORTRAIT / FIGURE / PARTNER are its parts (A on one opens 'trainer-edit' on it),
//                  the chip row under it: SWITCH (only with several trainers) / NEW TRAINER / BACK. No trainer: the card says so and offers NEW TRAINER. A read-only trainer: A on a part refuses, in words
//   trainer-new    THE NEW TRAINER screens (parent 'trainer'): ONE path, the step is state: WELCOME (the hub's dialog layer: LET'S GO / LATER), NAME, LOOK, FIGURE (front, then back), PORTRAIT,
//                  PARTNER, the CARD ("Is this right?" YES / CHANGE). Every step opens on a default, so A, A, A ... makes a trainer. B = the step before; B on WELCOME = LATER
//   trainer-edit   ONE choice again, opened from the card (which one is state: S.edit). A keeps it (an 'update' effect), B cancels. Opened by its address with no choice: steps back to the card
//
// THE PUBLIC METHOD THE SHELL CALLS (before it opens 'trainer-new' on a first visit):
//   welcome({ kind: 'new' | 'back', name, profileId? })   'new': nobody is here yet (a new trainer is CREATED); 'back': a profile from before schema 6 (`profileId`, else the active one: its
//                                              name, portrait, teams and record are kept: the screens open PRE-FILLED, reading its values live, and UPDATE it). The next enter('trainer-new') uses
//                                              it once. The welcome question is then ARMED (hub_dialog.js DIALOG_ARM_TICKS: the A that was on its way to the main menu does not answer it), and
//                                              its LATER goes HOME (ctx.go('main')). Without it 'trainer-new' greets an 'another' trainer (the card's NEW TRAINER, the Team Builder's NEW TRAINER):
//                                              CREATED, not armed, LATER goes back where it was opened from. -> nothing
//   begin(kind)                                the same for 'another' (what the card's NEW TRAINER does before it goes)
//
// THE CTL'S DOOR (trainer_ctl.js; a Node test plays the ctl)
//   setChoices({ looks: [gfx], fronts: [{ pic, cls }], backs: [index], heads: n, species: [{ id, name }] })      what the pickers pick from (decoded from the ROM by the ctl)
//   setSeed(n)            a random unsigned integer: the default LOOK of a new trainer (center_look.js pickLook)
//   setMascot(species)    the hub's mascot of the day: the default PARTNER
//   setStoredLook(code)   this browser's look (center_look.js loadLook): the default LOOK when there is one
//   setTrainers({ activeId, list: [{ id, name, readOnly, avatar: { kind, id } | null, card, rec: { wins, losses } | null }] } | null)     the store's trainers (null: use hub data)
//   saved(result)         a save finished: { ok: true } | { ok: false, why: 'readonly' | 'notsaved' | 'conflict' | 'invalid' | 'nostore' | 'failed', message? } -> effects (env.run): on ok the
//                         screen goes back (the card, or where NEW TRAINER was opened from); on a failure the words stay in the message box and the screen stays
//   saving()              is a save under way?
//   failed(why)           something outside a save was refused (SWITCH TRAINER): WORDS.failed[why] in the message box until the next input
//
// EFFECTS (app: 'trainer', carried out by trainer_ctl.js)
//   { type: 'opened', path }                                              one of the app's screens was entered (also a move between two of them)
//   { type: 'later', kind }                                               LATER on the welcome: the ctl remembers it for the tab (sessionStorage 'arena.welcome' = 'later')
//   { type: 'save', mode: 'create' | 'update', profileId, name, avatar, card }     the new-trainer screens' YES (card.made = true; avatar { kind: 'preset', id })
//   { type: 'update', profileId, field, patch }                           the editor's A: patch = updateTrainer's ({ name } | { avatar } | { card: { ... } })
//   { type: 'switch', id }                                                SWITCH TRAINER chose another trainer
//   { type: 'data' }                                                      (from onData, once the ctl has handed the store's list) read the trainers again
// A press decides its own sound only for a refusal ({ type: 'sfx', key: 'se_failure' }); everything else is the hub's menu sound.

import { createEntrySlot } from './textentry.js';
import { wrapDialog, DIALOG_ARM_TICKS } from './hub_dialog.js';
import { cardOf } from './trainer_card.js';
import { lookCode, lookId, lookFor, pickLook } from './center_look.js';
import { TG, inR, clamp, rowRect, gridCell, picCells, chipRow, CARD_PARTS, cardRect } from './trainer_geom.js';

export const ID = 'trainer';
export const PATHS = Object.freeze(['trainer', 'trainer-new', 'trainer-edit']);
/** Where B goes from a screen reached the usual way (a pure function of the path). */
export const parentOf = (path) => (path === 'trainer' ? 'main' : 'trainer');
/** The new-trainer steps, in order. */
export const STEPS = Object.freeze(['welcome', 'name', 'look', 'front', 'back', 'portrait', 'partner', 'card']);
/** The steps of each part of the card (what 'trainer-edit' and the card's CHANGE open). */
export const FIELDS = Object.freeze({ name: Object.freeze(['name']), look: Object.freeze(['look']), figure: Object.freeze(['front', 'back']), portrait: Object.freeze(['portrait']), partner: Object.freeze(['partner']) });
/** The ROM-style names offered beside NEW NAME (written by this site, as the games offer a few). */
export const PRESET_NAMES = Object.freeze(['GOLD', 'ETHAN', 'LYRA', 'KRIS']);
export const NAME_MAX = 10, SEARCH_MAX = 12;
/** The battle figure a new trainer starts on when the ROM's list has it: the front picture of the ROM's own player-like PKMN Trainer (a picture index, nothing ROM-derived). Else the first. */
export const FRONT_DEFAULT_PIC = 71;
export const DIALOG_ID = 'trainer:welcome';
export const LATER = Object.freeze({ key: 'arena.welcome', value: 'later' });

const TITLE = 'Pokemon Arena - ';
const TITLES = Object.freeze({ trainer: 'Trainer Card', 'trainer-new': 'New Trainer', 'trainer-edit': 'Change Trainer' });
/** The names of the steps (the strip's title, the screen reader). */
export const STEP_TITLES = Object.freeze({ welcome: 'WELCOME', name: 'YOUR NAME', look: 'YOUR LOOK', front: 'BATTLE FIGURE', back: 'FIGURE FROM BEHIND', portrait: 'PORTRAIT', partner: 'PARTNER', card: 'TRAINER CARD' });
const PART_WORDS = Object.freeze({ name: 'NAME', look: 'LOOK', portrait: 'PORTRAIT', figure: 'BATTLE FIGURE', partner: 'PARTNER' });
const PART_STEP = Object.freeze({ name: 'name', look: 'look', portrait: 'portrait', figure: 'front', partner: 'partner' });
const STEP_PART = Object.freeze({ name: 'name', look: 'look', front: 'figure', back: 'figure', portrait: 'portrait', partner: 'partner' });
/** Every sentence of the app (the ones with a name in them are made by the functions below). Each line fits the message box (the tests measure them at the longest values). */
export const WORDS = Object.freeze({
  welcome: Object.freeze({
    new: Object.freeze(['Hello there! Welcome to the POK{E}MON ARENA!', 'Here, TRAINERS from everywhere battle with the POK{E}MON they raise.', 'First, tell me a little about yourself.']),
    back: Object.freeze(["Let's make your TRAINER CARD. It shows other TRAINERS who you are."]),
    another: Object.freeze(['A new TRAINER? Welcome!', "Let's make a TRAINER CARD for you."]),
  }),
  options: Object.freeze(["LET'S GO", 'LATER']),
  askNow: 'Make your TRAINER CARD now?',
  askKeys: 'A: choose   B: later',
  keys: 'A: this one   B: back',
  editKeys: 'A: keep it   B: cancel',
  newName: 'Type a name of your own.',
  newNameKeys: 'A: the keyboard   B: back',
  look: 'How you look in the TRAINER CENTER.',
  front: 'How OTHERS see you in battle.',
  back: 'How YOU see yourself in battle.',
  portrait: 'Your portrait on the menus.',
  partner: 'Your favourite POK{E}MON.',
  search: 'Find a POK{E}MON by its name.',
  searchKeys: 'A: type   B: back',
  noMatch: 'No POK{E}MON is called that.',
  confirm: Object.freeze(['Is this right?', 'A: YES   B: back']),
  change: Object.freeze(['Change one of these?', 'A: pick one   B: back']),
  wait: Object.freeze(['Opening the TRAINER screens...', '']),
  saving: Object.freeze(['Saving...', '']),
  none: Object.freeze(['You have no TRAINER yet.', 'A: make one   B: back']),
  readOnly: Object.freeze(['This TRAINER is read-only here.', 'It cannot be changed.']),
  newTrainer: Object.freeze(['Make another TRAINER: a new card.', 'A: start   B: back']),
  switchT: Object.freeze(['Play as another of your TRAINERS.', 'A: choose   B: back']),
  switchList: Object.freeze(['Which TRAINER?', 'A: this one   B: back']),
  backRow: Object.freeze(['Back to the main menu.', 'A: back']),
  cardKeys: 'A: change it   B: back',
  failed: Object.freeze({
    readonly: Object.freeze(['This TRAINER is read-only here:', 'nothing was saved.']),
    notsaved: Object.freeze(['This browser is not keeping', 'TRAINERS: nothing was saved.']),
    conflict: Object.freeze(['Changed in another tab meanwhile:', 'nothing was saved. Try again.']),
    invalid: Object.freeze(['That could not be saved:', 'the TRAINER was refused.']),
    nostore: Object.freeze(['Storage could not be opened here:', 'nothing was saved.']),
    failed: Object.freeze(['That could not be saved.', 'Try again.']),
  }),
});

const FRESH = Object.freeze({ repeat: false });
const isInt = (v) => Number.isInteger(v);
const avatarOf = (a) => (a && typeof a === 'object' && (a.kind === 'preset' || a.kind === 'mon') && isInt(a.id) ? { kind: a.kind, id: a.id } : null);

/* ---------------------------------------------------------------------------------------------- moving a cursor */
/** One step of a cursor over `n` things laid out `cols` across, `per` to a page. Lists (cols 1): up / down wrap, left / right turn the page. Grids: left / right wrap, up / down a row. */
export function moveCursor(cur, n, cols, per, action, repeat) {
  if (n <= 0) return 0;
  cur = clamp(cur, 0, n - 1);
  const page = (dir) => { const to = cur + dir * per; return to >= 0 && Math.floor(to / per) < Math.ceil(n / per) ? Math.min(to, n - 1) : cur; };
  if (cols === 1) {
    switch (action) {
      case 'up': return cur > 0 ? cur - 1 : repeat ? 0 : n - 1;
      case 'down': return cur < n - 1 ? cur + 1 : repeat ? n - 1 : 0;
      case 'left': case 'l': return page(-1);
      case 'right': case 'r': return page(1);
      default: return cur;
    }
  }
  switch (action) {
    case 'left': return cur > 0 ? cur - 1 : repeat ? 0 : n - 1;
    case 'right': return cur < n - 1 ? cur + 1 : repeat ? n - 1 : 0;
    case 'up': return cur - cols >= 0 ? cur - cols : cur;
    case 'down': return cur + cols < n ? cur + cols : Math.floor((cur + cols) / cols) * cols < n ? n - 1 : cur;
    case 'l': return page(-1);
    case 'r': return page(1);
    default: return cur;
  }
}

/* ---------------------------------------------------------------------------------------------- the model */
function createTrainerHub(ctx) {
  const S = {
    choices: null, seed: 0, mascot: 25, mascotSet: false, storedLook: null, trainers: null,          // (mascotSet: the ctl said which; until then the welcome shows the hub's own)
    pending: null,            // what welcome() / begin() said, for the next enter('trainer-new')
    wiz: null,                // the new-trainer screens: { kind, mode, profileId, step, draft, cur, ret, auto, asked }
    edit: null,               // the one-choice editor: { field, profileId, i, draft, cur }
    card: { focus: null },    // the card screen's highlighted part / chip
    sw: null,                 // SWITCH TRAINER's list: { cursor, off }
    search: '',               // the partner picker's search word
    flash: null,              // { lines, bad, seq }: a note in the message box until the next input
    saving: null,             // { what: 'wiz' | 'edit' } while the ctl saves
    input: 0,
  };
  const entry = createEntrySlot();
  const PX = ctx.msgPx - 12;

  /* -------------------------------------------------------------------------------------------- what the ROM and the store gave */
  const looks = () => (S.choices ? S.choices.looks : []);
  const fronts = () => (S.choices ? S.choices.fronts : []);
  const backs = () => (S.choices ? S.choices.backs : []);
  const headCount = () => (S.choices ? S.choices.heads : 0);
  const allSpecies = () => (S.choices ? S.choices.species : []);
  const speciesName = (id) => { const s = allSpecies().find((x) => x.id === id); return s ? s.name : ''; };
  const frontLabel = (pic) => { const c = fronts().find((x) => x.pic === pic); return c ? c.cls : ''; };

  function trainerList() {
    if (S.trainers) return S.trainers.list;
    return (ctx.profiles() || []).map((p) => ({ id: p.id, name: String(p.name || ''), readOnly: !!p.readOnly, avatar: avatarOf(p.avatar), card: cardOf(p), rec: p.record ? { battles: p.record.battles | 0 } : null }));
  }
  const activeId = () => (S.trainers ? S.trainers.activeId : ctx.activeId());
  function active() { const L = trainerList(), id = activeId(); return L.find((t) => t.id === id) || L[0] || null; }

  /* -------------------------------------------------------------------------------------------- defaults: every step opens on one */
  const defFront = () => { const F = fronts(); const hit = F.find((c) => c.pic === FRONT_DEFAULT_PIC); return hit ? hit.pic : F.length ? F[0].pic : null; };
  const defBack = () => { const B = backs(); return B.includes(0) ? 0 : B.length ? B[0] : null; };
  const defLook = () => { const L = looks(), id = lookId(S.storedLook); return id !== null && L.includes(id) ? S.storedLook : pickLook(L, S.seed); };
  /** A draft with every unchosen part filled by its default (what the card shows and what YES saves). */
  function resolved(d) {
    return { name: d.name || '', look: d.look || defLook(), front: isInt(d.front) ? d.front : defFront(), back: isInt(d.back) ? d.back : defBack(), head: isInt(d.head) ? d.head : 0, partner: isInt(d.partner) ? d.partner : S.mascot };
  }
  /** A trainer's choices as a draft (the card's parts; the editor starts on them). */
  function draftOf(t) {
    const c = t ? cardOf({ card: t.card }) : cardOf(null), a = t ? avatarOf(t.avatar) : null;
    return { name: t ? t.name : '', look: c.look, front: c.front, back: c.back, head: a && a.kind === 'preset' ? a.id : null, partner: c.partner };
  }
  const EMPTY = Object.freeze({ name: '', look: null, front: null, back: null, head: null, partner: null });
  /** The player's own choices (a draft: null = not chosen here) over a base (the profile's own values, read NOW: the store's full list may arrive after the screens opened). */
  function over(d, base) { const o = {}; for (const k of Object.keys(EMPTY)) o[k] = d[k] !== null && d[k] !== undefined && d[k] !== '' ? d[k] : base[k]; return o; }

  /* -------------------------------------------------------------------------------------------- the message box */
  function note(lines, bad) { S.flash = { lines: [String(lines[0] || ''), String(lines[1] || '')], bad: !!bad, seq: S.input }; }
  const refuse = (lines) => { note(lines, true); return [{ type: 'sfx', key: 'se_failure' }]; };
  /** Two lines: a sentence and a keys line. (Every sentence with a name in it fits one line at the longest name and species: tools/pokemonarena_trainer_test.mjs G2 measures them.) */
  const two = (sentence, keys) => [String(sentence), keys || ''];

  /* -------------------------------------------------------------------------------------------- THE STEPS: one picker each, shared by the new-trainer screens and the editor */
  // A HOST is what a step works for: { draft (the player's choices: written by A), seen() (the draft over the profile's values: what is shown), cur, edit (bool), take() -> effects,
  // back() -> effects }. The step reads seen(), writes draft and host.cur[step] (its cursor), and calls take / back.
  function nameRows(host) {
    const rows = [{ id: 'new', label: 'NEW NAME' }], own = host.seen().name;
    if (own && !PRESET_NAMES.includes(own)) rows.push({ id: 'own', label: own });
    for (const n of PRESET_NAMES) rows.push({ id: 'preset', label: n });
    return rows;
  }
  function partnerRows() {
    const q = S.search.trim().toLowerCase(), all = allSpecies();
    const list = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;
    return [{ id: 'search', label: q ? 'SEARCH: ' + S.search.trim() : 'SEARCH...' }].concat(list.map((s) => ({ id: 'mon', label: s.name, species: s.id })));
  }
  /** The things a step picks from: { kind: 'list' | 'grid' | 'pics', n, cols, per, items }. */
  function pickerOf(step, host) {
    switch (step) {
      case 'name': { const items = nameRows(host); return { kind: 'list', items, n: items.length, cols: 1, per: TG.list.rows }; }
      case 'partner': { const items = partnerRows(); return { kind: 'list', items, n: items.length, cols: 1, per: TG.list.rows }; }
      case 'look': { const items = looks(); return { kind: 'grid', items, n: items.length, cols: TG.grid.cols, per: TG.grid.cols * TG.grid.rows }; }
      case 'front': { const items = fronts().map((c) => c.pic); return { kind: 'pics', items, n: items.length, cols: TG.pics.per, per: TG.pics.per }; }
      case 'back': { const items = backs().slice(); return { kind: 'pics', items, n: items.length, cols: TG.pics.per, per: TG.pics.per }; }
      case 'portrait': { const n = headCount(), items = Array.from({ length: n }, (_, i) => i); return { kind: 'pics', items, n, cols: TG.pics.per, per: TG.pics.per }; }
      default: return null;
    }
  }
  /** Where a step's cursor starts: on what the draft holds, else on the default. */
  function defIndex(step, host, pk) {
    const d = host.seen(), r = resolved(d);
    switch (step) {
      case 'name': { const i = pk.items.findIndex((x) => x.id !== 'new' && x.label === d.name); return i >= 0 ? i : pk.items.findIndex((x) => x.id === 'preset'); }
      case 'partner': { const i = pk.items.findIndex((x) => x.species === r.partner); return i >= 0 ? i : pk.n > 1 ? 1 : 0; }
      case 'look': { const i = pk.items.indexOf(lookFor(r.look, pk.items)); return Math.max(0, i); }
      case 'front': return Math.max(0, pk.items.indexOf(r.front));
      case 'back': return Math.max(0, pk.items.indexOf(r.back));
      case 'portrait': return clamp(r.head, 0, Math.max(0, pk.n - 1));
      default: return 0;
    }
  }
  const curOf = (step, host, pk) => clamp(isInt(host.cur[step]) ? host.cur[step] : defIndex(step, host, pk), 0, Math.max(0, pk.n - 1));
  const ready = (step) => step === 'name' || (S.choices && pickerOf(step, { draft: EMPTY, seen: () => EMPTY, cur: {} }).n > 0) || (step === 'partner' && !!S.choices);

  /** A takes the highlighted thing of a step. -> effects. */
  function takeAt(step, host, i) {
    const pk = pickerOf(step, host), it = pk.items[i];
    host.cur[step] = i;
    switch (step) {
      case 'name':
        if (!it) return [];
        if (it.id === 'new') return openName(host);
        host.draft.name = it.label; return host.take();
      case 'partner':
        if (!it) return [];
        if (it.id === 'search') return openSearch();
        host.draft.partner = it.species; return host.take();
      case 'look': if (it === undefined) return []; host.draft.look = lookCode(it); return host.take();
      case 'front': if (it === undefined) return []; host.draft.front = it; return host.take();
      case 'back': if (it === undefined) return []; host.draft.back = it; return host.take();
      case 'portrait': if (it === undefined) return []; host.draft.head = it; return host.take();
      default: return [];
    }
  }
  function openName(host) {
    const seen = host.seen().name, own = seen && !PRESET_NAMES.includes(seen) ? seen : '';
    entry.open({ id: 'trainer:name', title: 'YOUR NAME?', value: own, max: NAME_MAX, charset: 'name' }, (r) => {
      if (!r.ok) return [];
      host.draft.name = String(r.value).trim().slice(0, NAME_MAX);          // (the entry's OK never accepts a blank field: textentry.js submit)
      host.cur.name = null;
      return host.take();
    });
    return [];
  }
  function openSearch() {
    entry.open({ id: 'trainer:search', title: 'FIND A POK{E}MON', value: S.search, max: SEARCH_MAX, charset: 'search', allowEmpty: true }, (r) => {
      if (!r.ok) return [];
      S.search = String(r.value).trim();
      const host = hostNow();
      if (host) { const pk = pickerOf('partner', host); host.cur.partner = pk.n > 1 ? 1 : 0; }
      return [];
    });
    return [];
  }
  function stepPress(step, host, action, info) {
    if (!ready(step)) return action === 'b' ? host.back() : [];
    const pk = pickerOf(step, host), cur = curOf(step, host, pk);
    if (action === 'a') return takeAt(step, host, cur);
    if (action === 'b') return host.back();
    if (action === 'y' && step === 'partner') return openSearch();
    const to = moveCursor(cur, pk.n, pk.cols, pk.per, action, !!(info && info.repeat));
    host.cur[step] = to;
    return [];
  }
  /** What a pointer at (x, y) is over on a step: { kind: 'row' | 'cell', index } | { kind: 'chip', id } | null. */
  function stepHit(step, host, x, y) {
    if (!ready(step)) return null;
    const pk = pickerOf(step, host), cur = curOf(step, host, pk), first = Math.floor(cur / pk.per) * pk.per, pages = Math.ceil(pk.n / pk.per);
    if (pages > 1) for (const c of [TG.strip.pgup, TG.strip.pgdn]) if (inR(c, x, y)) return { kind: 'chip', id: c.id };
    for (let i = 0; i < pk.per && first + i < pk.n; i++) {
      const r = pk.kind === 'list' ? rowRect(TG.list, i) : pk.kind === 'grid' ? gridCell(i) : picCells()[i].cell;
      if (inR(r, x, y)) return { kind: pk.kind === 'list' ? 'row' : 'cell', index: first + i };
    }
    return null;
  }
  function stepRects(step, host) {
    if (!ready(step)) return [];
    const pk = pickerOf(step, host), cur = curOf(step, host, pk), first = Math.floor(cur / pk.per) * pk.per, out = [];
    for (let i = 0; i < pk.per && first + i < pk.n; i++) {
      const r = pk.kind === 'list' ? rowRect(TG.list, i) : pk.kind === 'grid' ? gridCell(i) : picCells()[i].cell;
      out.push({ x: r.x, y: r.y, w: r.w, h: r.h, kind: pk.kind === 'list' ? 'row' : 'cell', index: first + i });
    }
    if (Math.ceil(pk.n / pk.per) > 1) for (const c of [TG.strip.pgup, TG.strip.pgdn]) out.push({ x: c.x, y: c.y, w: c.w, h: c.h, kind: 'chip', id: c.id });
    return out;
  }
  function stepPointer(step, host, ev) {
    if (!ready(step)) return [];
    const pk = pickerOf(step, host), cur = curOf(step, host, pk);
    if (ev.kind === 'wheel') {
      const k = Math.abs(ev.steps | 0), dir = (ev.steps | 0) > 0 ? 1 : -1;
      let c = cur;
      for (let i = 0; i < k; i++) c = pk.kind === 'list' ? moveCursor(c, pk.n, 1, pk.per, dir > 0 ? 'down' : 'up', true) : moveCursor(c, pk.n, pk.cols, pk.per, dir > 0 ? 'r' : 'l', true);
      host.cur[step] = c; return [];
    }
    const h = ev.x === undefined || ev.x === null ? null : stepHit(step, host, ev.x, ev.y);
    if (!h) return [];
    if (h.kind === 'chip') { if (ev.kind === 'click') host.cur[step] = moveCursor(cur, pk.n, pk.cols, pk.per, h.id === 'pgup' ? (pk.cols === 1 ? 'left' : 'l') : (pk.cols === 1 ? 'right' : 'r'), true); return []; }
    host.cur[step] = h.index;
    return ev.kind === 'click' ? takeAt(step, host, h.index) : [];
  }
  /** The screen of a step: { kind, title, chips, ...what trainer_screen.js draws } and the message box's two lines. */
  function stepView(step, host, tick) {
    if (!ready(step)) return { v: { kind: 'wait', title: STEP_TITLES[step], line: 'LOADING...' }, msg: WORDS.wait.slice() };
    const pk = pickerOf(step, host), cur = curOf(step, host, pk), first = Math.floor(cur / pk.per) * pk.per, pages = Math.ceil(pk.n / pk.per), page = Math.floor(first / pk.per);
    const chips = pages > 1 ? [TG.strip.pgup, TG.strip.pgdn].map((c) => ({ id: c.id, label: c.id === 'pgup' ? '{UP}' : '{DOWN}', x: c.x, y: c.y, w: c.w, h: c.h, off: c.id === 'pgup' ? page === 0 : page >= pages - 1 })) : [];
    const keys = host.edit ? WORDS.editKeys : WORDS.keys, r = resolved(host.seen());
    const title = STEP_TITLES[step] + (pk.kind === 'list' && step === 'name' ? '' : ' ' + (step === 'partner' ? (cur > 0 ? cur + '/' + (pk.n - 1) : '(' + (pk.n - 1) + ')') : (cur + 1) + '/' + pk.n));
    if (pk.kind === 'list') {
      const rows = pk.items.slice(first, first + pk.per).map((it) => ({ label: it.label }));
      const it = pk.items[cur];
      let side, msg;
      if (step === 'name') {
        side = { what: 'front', id: r.front, line: it && it.id !== 'new' ? it.label : r.name };
        msg = it && it.id === 'new' ? [WORDS.newName, WORDS.newNameKeys] : two('Your name: ' + (it ? it.label : '') + '?', keys);
      } else {
        const sp = it && it.id === 'mon' ? it.species : null;
        side = { what: 'mon', id: sp, line: sp ? it.label : '' };
        msg = it && it.id === 'search' ? [pk.n > 1 ? WORDS.search : WORDS.noMatch, WORDS.searchKeys] : [WORDS.partner, keys];
      }
      return { v: { kind: 'list', step, title, chips, rows, cursor: cur - first, up: first > 0, down: first + pk.per < pk.n, side }, msg };
    }
    if (pk.kind === 'grid') {
      return { v: { kind: 'grid', step, title, chips, items: pk.items.slice(first, first + pk.per), cursor: cur - first, walk: [1, 0, 2, 0][((tick | 0) >> 3) & 3] }, msg: [WORDS.look, keys] };
    }
    const what = step === 'portrait' ? 'head' : step;
    const used = step === 'front' ? r.front : step === 'back' ? r.back : r.head;
    const cells = pk.items.slice(first, first + pk.per).map((id, i) => ({ id, label: step === 'front' ? frontLabel(id) : String(id + 1), on: first + i === cur, used: id === used }));
    return { v: { kind: 'pics', step, title, chips, what, cells }, msg: [WORDS[step], keys] };
  }

  /* -------------------------------------------------------------------------------------------- THE NEW TRAINER SCREENS */
  function begin(spec) {
    const kind = spec && (spec.kind === 'new' || spec.kind === 'back') ? spec.kind : 'another';
    S.pending = { kind, name: spec && typeof spec.name === 'string' ? spec.name.slice(0, NAME_MAX) : '', profileId: spec && typeof spec.profileId === 'string' ? spec.profileId : null, auto: kind !== 'another' };
  }
  function startWizard() {
    const p = S.pending || { kind: 'another', name: '', profileId: null, auto: false };
    S.pending = null;
    // the profile a 'back' welcome updates: the one the shell named, else the active one
    const a = (p.profileId && trainerList().find((t) => t.id === p.profileId)) || active();
    const upd = p.kind === 'back' && a && !a.readOnly;
    S.wiz = { kind: p.kind, mode: upd ? 'update' : 'create', profileId: upd ? a.id : null, name0: upd ? p.name || a.name : '', step: 'welcome', draft: { ...EMPTY }, cur: {}, ret: null, auto: !!p.auto, asked: false, ask: 0 };
    S.search = '';
    askWelcome();
  }
  function welcomePages(w) {
    const paras = w.kind === 'back' ? ['Welcome back, ' + (wizSeen().name || 'TRAINER') + '!'].concat(WORDS.welcome.back) : WORDS.welcome[w.kind] || WORDS.welcome.another;
    const pages = [];
    for (const p of paras) for (const pg of wrapDialog(p, ctx.measure, PX)) pages.push(pg);
    return pages.slice(0, 16);
  }
  function askWelcome() {
    const w = S.wiz;
    ctx.dialog.close(DIALOG_ID);
    w.asked = !!ctx.dialog.open({ id: DIALOG_ID, pages: welcomePages(w), choice: { options: WORDS.options.slice(), cursor: 0 }, armTicks: w.auto ? DIALOG_ARM_TICKS : 0 });
    w.auto = false;          // (a welcome asked again after B is the player's own doing: it answers at once)
  }
  function later() {
    const w = S.wiz, kind = w ? w.kind : 'another';
    ctx.dialog.close(DIALOG_ID);
    // a first visit's LATER goes home (the card under the screens was never the player's idea); NEW TRAINER's goes back where it was opened from
    return [{ app: ID, type: 'later', kind }].concat(kind === 'another' ? ctx.back() : ctx.go('main'));
  }
  function letsGo() { ctx.dialog.close(DIALOG_ID); S.wiz.step = 'name'; return []; }
  /** The new-trainer screens' choices as shown: the player's over the profile being updated (its live values), or over nothing for a new trainer. */
  function wizSeen() {
    const w = S.wiz, t = w.mode === 'update' ? trainerList().find((x) => x.id === w.profileId) : null, base = t ? { ...draftOf(t) } : { ...EMPTY };
    if (w.name0) base.name = w.name0;
    return over(w.draft, base);
  }
  const wizHost = () => ({
    draft: S.wiz.draft, seen: wizSeen, cur: S.wiz.cur, edit: false,
    take: () => wizNext(),
    back: () => wizBack(),
  });
  function wizNext() {
    const w = S.wiz, i = STEPS.indexOf(w.step);
    if (w.ret === 'card' && w.step !== 'front') { w.ret = null; w.step = 'card'; return []; }
    w.step = STEPS[Math.min(STEPS.length - 1, i + 1)];
    if (w.step === 'card') w.cardFocus = 'yes';
    return [];
  }
  function wizBack() {
    const w = S.wiz;
    if (w.ret === 'card' && w.step !== 'back') { w.ret = null; w.step = 'card'; return []; }
    w.step = STEPS[Math.max(0, STEPS.indexOf(w.step) - 1)];
    if (w.step === 'welcome') askWelcome();
    return [];
  }
  function wizSave() {
    const w = S.wiz, r = resolved(wizSeen());
    S.saving = { what: 'wiz' };
    return [{ app: ID, type: 'save', mode: w.mode, profileId: w.profileId, name: r.name, avatar: { kind: 'preset', id: r.head }, card: { made: true, look: r.look, front: r.front, back: r.back, partner: r.partner } }];
  }

  /* -------------------------------------------------------------------------------------------- THE CARD (the confirm step and the card screen) */
  /** The card of a draft / trainer as trainer_screen.js draws it. */
  function cardView(d, rec, extra) {
    const r = resolved(d), lk = lookFor(r.look, looks());
    return { name: r.name, rec: rec || '', look: lk === null ? lookId(r.look) : lk, head: isInt(r.head) ? r.head : null, front: r.front, partner: r.partner, partnerName: speciesName(r.partner), figure: frontLabel(r.front), ...(extra || {}) };
  }
  /** The record line of a card: what the trainer list carries, else what hub data gives (its battles). */
  function recText(t) {
    let c = t && t.rec;
    if (!c && t) { const p = (ctx.profiles() || []).find((x) => x && x.id === t.id); c = p && p.record ? { battles: p.record.battles | 0 } : null; }
    if (!c) return '';
    if (isInt(c.wins) && isInt(c.losses)) return 'W' + c.wins + ' L' + c.losses;
    return isInt(c.battles) ? 'BATTLES ' + c.battles : '';
  }
  /** The rows of the card's focus grid: the name; the four pictures; the chips. */
  function cardGrid(chips, parts) { const g = []; if (parts) { g.push(['name'], ['look', 'portrait', 'figure', 'partner']); } g.push(chips.map((c) => c.id)); return g; }
  const centreOf = (id, chips) => { const c = chips.find((x) => x.id === id); const r = c || (CARD_PARTS.includes(id) ? cardRect(id) : null); return r ? r.x + r.w / 2 : 120; };
  /** Move the card's focus (up / down between the rows, to the nearest across; left / right along a row, wrapping). */
  function cardMove(focus, action, chips, parts) {
    const g = cardGrid(chips, parts);
    let ri = g.findIndex((row) => row.includes(focus));
    if (ri < 0) return g[g.length - 1][0];
    const row = g[ri], ci = row.indexOf(focus);
    if (action === 'left') return row[(ci + row.length - 1) % row.length];
    if (action === 'right') return row[(ci + 1) % row.length];
    if (action !== 'up' && action !== 'down') return focus;
    ri = (ri + (action === 'up' ? g.length - 1 : 1)) % g.length;
    const x = centreOf(focus, chips);
    let best = g[ri][0];
    for (const id of g[ri]) if (Math.abs(centreOf(id, chips) - x) < Math.abs(centreOf(best, chips) - x)) best = id;
    return best;
  }
  function cardHit(x, y, chips, parts) {
    for (const c of chips) if (inR(c, x, y)) return { kind: 'chip', id: c.id };
    if (parts) for (const id of CARD_PARTS) if (inR(cardRect(id), x, y)) return { kind: 'part', id };
    return null;
  }
  function cardRects(chips, parts) {
    const out = chips.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, kind: 'chip', id: c.id }));
    if (parts) for (const id of CARD_PARTS) out.push({ ...cardRect(id), kind: 'part', id });
    return out;
  }
  const withRects = (list) => { const rs = chipRow(list.length); return list.map((c, i) => ({ ...c, ...rs[i] })); };

  // the confirm step
  const confirmChips = () => withRects([{ id: 'yes', label: 'YES' }, { id: 'change', label: 'CHANGE' }]);
  function confirmAct(id) {
    const w = S.wiz;
    if (id === 'yes') return wizSave();
    if (id === 'change') { w.cardFocus = 'name'; return []; }
    if (CARD_PARTS.includes(id)) { w.ret = 'card'; w.step = PART_STEP[id]; return []; }
    return [];
  }
  function confirmPress(action) {
    const w = S.wiz, chips = confirmChips();
    if (!w.cardFocus) w.cardFocus = 'yes';
    if (action === 'a') return confirmAct(w.cardFocus);
    if (action === 'b') return wizBack();
    w.cardFocus = cardMove(w.cardFocus, action, chips, true);
    return [];
  }

  // the card screen
  function cardChips() {
    const t = active(), list = [];
    if (t && trainerList().length > 1) list.push({ id: 'switch', label: 'SWITCH' });
    list.push({ id: 'new', label: 'NEW TRAINER' }, { id: 'back', label: 'BACK' });
    return withRects(list);
  }
  function cardFocusNow() { const t = active(), chips = cardChips(), ids = (t ? CARD_PARTS.slice() : []).concat(chips.map((c) => c.id)); return ids.includes(S.card.focus) ? S.card.focus : t ? 'name' : 'new'; }
  function cardAct(id) {
    const t = active();
    if (id === 'back') return ctx.back();
    if (id === 'new') { begin({ kind: 'another' }); return ctx.go('trainer-new'); }
    if (id === 'switch') { const L = trainerList(); if (L.length < 2) return []; S.sw = { cursor: Math.max(0, L.findIndex((x) => x.id === (t && t.id))), off: 0 }; fitSwitch(); return []; }
    if (CARD_PARTS.includes(id)) {
      if (!t) return [];
      if (t.readOnly) return refuse(WORDS.readOnly);
      S.edit = { field: id, profileId: t.id, i: 0, draft: { ...EMPTY }, cur: {} };
      return ctx.go('trainer-edit');
    }
    return [];
  }
  function fitSwitch() { const n = trainerList().length, R = TG.switcher.rows; S.sw.cursor = clamp(S.sw.cursor, 0, Math.max(0, n - 1)); if (S.sw.cursor < S.sw.off) S.sw.off = S.sw.cursor; if (S.sw.cursor >= S.sw.off + R) S.sw.off = S.sw.cursor - R + 1; S.sw.off = clamp(S.sw.off, 0, Math.max(0, n - R)); }
  function switchTake(i) {
    const L = trainerList(), t = L[i]; S.sw = null;
    if (!t) return [];
    const a = active();
    if (a && t.id === a.id) return [];
    S.card.focus = 'name';
    return [{ app: ID, type: 'switch', id: t.id }];
  }
  function switchPress(action, info) {
    const n = trainerList().length;
    if (action === 'a') return switchTake(S.sw.cursor);
    if (action === 'b') { S.sw = null; return []; }
    if (action === 'up' || action === 'down') { S.sw.cursor = moveCursor(S.sw.cursor, n, 1, TG.switcher.rows, action, !!(info && info.repeat)); fitSwitch(); }
    return [];
  }
  const switchRow = (i) => rowRect(TG.switcher, i);
  function switchHit(x, y) { const n = trainerList().length; for (let i = 0; i < TG.switcher.rows && S.sw.off + i < n; i++) if (inR(switchRow(i), x, y)) return { kind: 'trainer', index: S.sw.off + i }; return null; }
  function cardPress(action, info) {
    if (S.sw) return switchPress(action, info);
    const t = active(), chips = cardChips(), focus = cardFocusNow();
    if (action === 'a') return cardAct(focus);
    if (action === 'b') return ctx.back();
    S.card.focus = cardMove(focus, action, chips, !!t);
    return [];
  }

  /* -------------------------------------------------------------------------------------------- THE EDITOR (one choice of the active trainer) */
  const editStep = () => FIELDS[S.edit.field][S.edit.i];
  /** The editor's choice as shown: the player's over the trainer's own values. */
  function editSeen() { const t = trainerList().find((x) => x.id === S.edit.profileId); return over(S.edit.draft, t ? draftOf(t) : { ...EMPTY }); }
  const editHost = () => ({ draft: S.edit.draft, seen: editSeen, cur: S.edit.cur, edit: true, take: () => editNext(), back: () => editBack() });
  function editNext() {
    const e = S.edit, steps = FIELDS[e.field];
    if (e.i < steps.length - 1) { e.i++; return []; }
    const t = trainerList().find((x) => x.id === e.profileId);
    if (!t) return refuse(WORDS.failed.failed);
    if (t.readOnly) return refuse(WORDS.readOnly);
    const r = resolved(editSeen()), before = resolved(draftOf(t));
    let patch;
    switch (e.field) {
      case 'name': patch = { name: r.name }; break;
      case 'look': patch = { card: { look: r.look } }; break;
      case 'figure': patch = { card: { front: r.front, back: r.back } }; break;
      case 'portrait': patch = { avatar: { kind: 'preset', id: r.head } }; break;
      default: patch = { card: { partner: r.partner } };
    }
    // nothing changed when the stored value is the one taken (a card value still null is a change: the default shown is then written down)
    const c = cardOf({ card: t.card });
    const same = e.field === 'name' ? r.name === before.name : e.field === 'look' ? r.look === c.look : e.field === 'figure' ? r.front === c.front && r.back === c.back
      : e.field === 'portrait' ? !!t.avatar && t.avatar.kind === 'preset' && t.avatar.id === r.head : r.partner === c.partner;
    if (same) return ctx.back();          // nothing changed: nothing to save
    S.saving = { what: 'edit' };
    return [{ app: ID, type: 'update', profileId: e.profileId, field: e.field, patch }];
  }
  function editBack() { const e = S.edit; if (e.i > 0) { e.i--; return []; } return ctx.back(); }

  /* -------------------------------------------------------------------------------------------- routing */
  const hostNow = (path = ctx.path()) => (path === 'trainer-new' && S.wiz ? wizHost() : path === 'trainer-edit' && S.edit ? editHost() : null);
  const stepNow = (path) => (path === 'trainer-new' && S.wiz ? S.wiz.step : path === 'trainer-edit' && S.edit ? editStep() : null);
  const isPicker = (step) => !!step && step !== 'welcome' && step !== 'card';
  /** Is the welcome's question the screen's own (the hub's dialog layer refused it, or it was closed by something else)? While another app's dialog is shown, ours waits in its queue. */
  function welcomeAsk() { const w = S.wiz; return !!w && w.step === 'welcome' && (!w.asked || !ctx.dialog.current()); }
  const askRect = (i) => ({ x: TG.ask.x - 4, y: TG.ask.y + i * TG.ask.pitch, w: TG.ask.w + 8, h: TG.ask.pitch });

  function press(path, action, info) {
    S.input++;
    const efx = entry.press(action); if (efx) return efx;
    if (S.flash && S.flash.seq !== S.input) S.flash = null;
    if (S.saving) return [];
    const step = stepNow(path);
    if (path === 'trainer') return cardPress(action, info || FRESH);
    if (path === 'trainer-edit' && !S.edit) return action === 'b' ? ctx.back() : [];
    if (path === 'trainer-new' && !S.wiz) return action === 'b' ? ctx.back() : [];
    if (step === 'welcome') {
      // (the hub's dialog layer asks the question; this is the screen's own way when it could not)
      const w = S.wiz;
      if (action === 'a') return w.ask === 0 ? letsGo() : later();
      if (action === 'b') return later();
      if (action === 'up' || action === 'down') w.ask = w.ask ? 0 : 1;
      return [];
    }
    if (step === 'card') return confirmPress(action);
    return stepPress(step, hostNow(path), action, info || FRESH);
  }
  function hit(path, x, y) {
    if (entry.isOpen()) return entry.hit(x, y);
    if (S.saving) return null;
    if (path === 'trainer') { if (S.sw) return switchHit(x, y); return cardHit(x, y, cardChips(), !!active()); }
    const step = stepNow(path);
    if (step === 'welcome') { if (!welcomeAsk()) return null; for (let i = 0; i < 2; i++) if (inR(askRect(i), x, y)) return { kind: 'ask', index: i }; return null; }
    if (step === 'card') return cardHit(x, y, confirmChips(), true);
    return isPicker(step) ? stepHit(step, hostNow(path), x, y) : null;
  }
  function pointer(path, ev) {
    if (!ev) return [];
    const acts = ev.kind === 'click' || ev.kind === 'wheel';
    if (acts) S.input++;
    const efx = entry.pointer(ev); if (efx) return efx;
    if (S.saving) return [];
    if (acts && S.flash && S.flash.seq !== S.input) S.flash = null;
    const step = stepNow(path);
    if (isPicker(step)) return stepPointer(step, hostNow(path), ev);
    if (ev.kind === 'wheel') { const k = Math.abs(ev.steps | 0); let out = []; for (let i = 0; i < k; i++) out = out.concat(press(path, (ev.steps | 0) > 0 ? 'down' : 'up', { repeat: true })); return out; }
    const h = ev.x === undefined || ev.x === null ? null : hit(path, ev.x, ev.y);
    if (!h) return [];
    if (path === 'trainer') {
      if (h.kind === 'trainer') { S.sw.cursor = h.index; fitSwitch(); return ev.kind === 'click' ? switchTake(h.index) : []; }
      S.card.focus = h.id;
      return ev.kind === 'click' ? cardAct(h.id) : [];
    }
    if (step === 'welcome') { S.wiz.ask = h.index; return ev.kind === 'click' ? (h.index === 0 ? letsGo() : later()) : []; }
    if (step === 'card') { S.wiz.cardFocus = h.id; return ev.kind === 'click' ? confirmAct(h.id) : []; }
    return [];
  }
  function rects(path) {
    if (entry.isOpen()) return entry.rects();
    if (S.saving) return [];
    if (path === 'trainer') { if (S.sw) { const n = trainerList().length, out = []; for (let i = 0; i < TG.switcher.rows && S.sw.off + i < n; i++) out.push({ ...switchRow(i), kind: 'trainer', index: S.sw.off + i }); return out; } return cardRects(cardChips(), !!active()); }
    const step = stepNow(path);
    if (step === 'welcome') return welcomeAsk() ? [0, 1].map((i) => ({ ...askRect(i), kind: 'ask', index: i })) : [];
    if (step === 'card') return cardRects(confirmChips(), true);
    return isPicker(step) ? stepRects(step, hostNow(path)) : [];
  }

  /* -------------------------------------------------------------------------------------------- the view */
  function screenView(path, tick, hubMascot) {
    if (path === 'trainer') {
      const t = active(), chips = cardChips(), focus = cardFocusNow();
      const card = t ? cardView(draftOf(t), recText(t), { readOnly: !!t.readOnly }) : null;
      let msg;
      if (S.sw) msg = WORDS.switchList.slice();
      else if (!t) msg = focus === 'back' ? WORDS.backRow.slice() : WORDS.none.slice();
      else if (focus === 'switch') msg = WORDS.switchT.slice();
      else if (focus === 'new') msg = WORDS.newTrainer.slice();
      else if (focus === 'back') msg = WORDS.backRow.slice();
      else msg = partWords(focus, card, t.readOnly ? WORDS.readOnly[1] : WORDS.cardKeys);
      const L = trainerList(), sw = S.sw ? { rows: L.slice(S.sw.off, S.sw.off + TG.switcher.rows).map((x) => ({ label: x.name || 'TRAINER' })), cursor: S.sw.cursor - S.sw.off, up: S.sw.off > 0, down: S.sw.off + TG.switcher.rows < L.length } : null;
      return { v: { kind: 'card', screen: 'card', card, empty: !t, focus: S.sw ? null : focus, chips: chips.map((c) => ({ ...c, on: !S.sw && c.id === focus })), sw, walk: [1, 0, 2, 0][((tick | 0) >> 3) & 3], title: STEP_TITLES.card }, msg };
    }
    const step = stepNow(path);
    if (!step) return { v: { kind: 'wait', title: TITLES[path].toUpperCase(), line: '' }, msg: ['', ''] };
    if (step === 'welcome') {
      const w = S.wiz, own = welcomeAsk();
      const seen = wizSeen(), species = isInt(seen.partner) ? seen.partner : S.mascotSet || !isInt(hubMascot) ? S.mascot : hubMascot;          // (the hub's mascot of the day until the ctl, which loads after the welcome opens, names it: no change of Pokemon under the player's eyes)
      return { v: { kind: 'welcome', species, ask: own ? { options: WORDS.options.slice(), cursor: w.ask } : null }, msg: own ? [WORDS.askNow, WORDS.askKeys] : ['', ''] };
    }
    if (step === 'card') {
      const w = S.wiz, chips = confirmChips(), focus = w.cardFocus || 'yes';
      const card = cardView(wizSeen(), '', null);
      const msg = focus === 'yes' ? WORDS.confirm.slice() : focus === 'change' ? WORDS.change.slice() : two('Change your ' + PART_WORDS[focus] + '?', 'A: change it   B: back');
      return { v: { kind: 'card', screen: 'confirm', card, empty: false, focus, chips: chips.map((c) => ({ ...c, on: c.id === focus })), sw: null, walk: [1, 0, 2, 0][((tick | 0) >> 3) & 3], title: STEP_TITLES.card }, msg };
    }
    const host = hostNow(path), sv = stepView(step, host, tick);
    if (path === 'trainer-edit') sv.v.title = 'CHANGE: ' + sv.v.title;
    return sv;
  }
  /** The message box's words for a highlighted part of a card. */
  function partWords(id, card, keys) {
    switch (id) {
      case 'name': return two('Your name: ' + card.name + '.', keys);
      case 'look': return [WORDS.look, keys];
      case 'portrait': return [WORDS.portrait, keys];
      case 'figure': return [WORDS.front, keys];
      default: return card.partnerName ? two('Your partner: ' + card.partnerName + '.', keys) : [WORDS.partner, keys];
    }
  }

  function view(path, base) {
    const sv = screenView(path, base && base.tick, base && base.mascot ? base.mascot.species : null);
    const msg = S.saving ? WORDS.saving.slice() : S.flash ? S.flash.lines.slice() : sv.msg;
    return { ...base, screen: path, app: ID, mascot: null, menu: null, msg: [String(msg[0] || ''), String(msg[1] || '')], trainer: { ...sv.v, bad: !!(S.flash && S.flash.bad) && !S.saving }, entry: entry.view() };
  }
  function speak(v) {
    const t = v && v.trainer; if (!t) return '';
    const says = [];
    if (t.kind === 'card') {
      says.push(t.screen === 'confirm' ? 'Your new trainer card.' : 'Trainer card.');
      if (t.empty) says.push('No trainer yet.');
      else if (t.card) says.push('Name ' + t.card.name + '.', t.card.partnerName ? 'Partner ' + t.card.partnerName + '.' : '', t.card.figure ? 'Battle figure ' + t.card.figure + '.' : '');
      if (t.sw) says.push('Trainers: ' + t.sw.rows.map((r, i) => (i === t.sw.cursor ? 'selected ' : '') + r.label).join(', ') + '.');
      else if (t.focus) { const c = (t.chips || []).find((x) => x.id === t.focus); says.push('Selected: ' + (c ? c.label : PART_WORDS[t.focus] || t.focus) + '.'); }
    } else if (t.kind === 'list') {
      const r = t.rows[t.cursor]; says.push(String(t.title).replace(/ \d+\/\d+$/, '') + '.', r ? 'Selected: ' + r.label + '.' : '');
    } else if (t.kind === 'pics') {
      const c = t.cells.find((x) => x.on); says.push(String(t.title).replace(/ \d+\/\d+$/, '') + '.', c ? 'Picture ' + (c.label || c.id + 1) + (c.used ? ', the one in use' : '') + '.' : '');
    } else if (t.kind === 'grid') says.push(String(t.title).replace(/ \d+\/\d+$/, '') + '. Trainer ' + (t.cursor + 1) + ' on this page.');
    else if (t.kind === 'welcome') says.push('Welcome.');
    return says.concat((v.msg || []).filter(Boolean)).filter(Boolean).join(' ').replace(/\{E\}/g, 'E');
  }

  return {
    id: ID, paths: PATHS, parent: parentOf,

    /* ------------------------------------------------------------------------------------------ the hub's calls */
    enter(path) {
      entry.close();
      S.flash = null;
      if (path === 'trainer-new') startWizard();
      else if (path === 'trainer-edit') { if (!S.edit) return ctx.go('trainer'); }
      else if (path === 'trainer') { S.sw = null; if (!S.card.focus) S.card.focus = active() ? 'name' : 'new'; }
      return [{ app: ID, type: 'opened', path }];
    },
    leave(path) {
      entry.close();
      if (path === 'trainer-new') { ctx.dialog.close(DIALOG_ID); S.wiz = null; if (S.saving && S.saving.what === 'wiz') S.saving = null; }
      if (path === 'trainer-edit') { S.edit = null; if (S.saving && S.saving.what === 'edit') S.saving = null; }
      if (path === 'trainer') S.sw = null;
    },
    press, hit: (path, x, y) => hit(path, x, y) || null, pointer, rects,
    tick() { return []; },
    view, speak,
    /** A data refresh (another tab, another app wrote a trainer): a ctl that has handed the store's list (so it is loaded) is asked to read it again. Before that, nothing (the ctl stays unloaded). */
    onData() { return S.trainers ? [{ app: ID, type: 'data' }] : []; },
    onDialog(id, value) {
      if (id !== DIALOG_ID || !S.wiz || S.wiz.step !== 'welcome' || ctx.path() !== 'trainer-new') return [];
      S.input++;
      return value === 0 ? letsGo() : later();
    },
    wantsText: () => entry.isOpen(),
    type: (_path, input) => { S.input++; return entry.type(input) || []; },
    title: (path) => TITLE + (TITLES[path] || 'Trainer'),
    state() {
      const w = S.wiz, e = S.edit;
      return {
        ready: !!S.choices, active: activeId() || null, trainers: trainerList().length,
        wiz: w ? { kind: w.kind, mode: w.mode, step: w.step, draft: wizSeen(), focus: w.step === 'card' ? w.cardFocus || 'yes' : null, cur: w.step !== 'welcome' && w.step !== 'card' && ready(w.step) ? curOf(w.step, wizHost(), pickerOf(w.step, wizHost())) : null } : null,
        edit: e ? { field: e.field, step: editStep(), draft: editSeen(), cur: ready(editStep()) ? curOf(editStep(), editHost(), pickerOf(editStep(), editHost())) : null } : null,
        card: { focus: cardFocusNow(), sw: S.sw ? S.sw.cursor : null }, search: S.search, saving: S.saving ? S.saving.what : null, note: S.flash ? S.flash.lines.join(' ').slice(0, 80) : null,
        entry: entry.isOpen() ? entry.entry().state() : null,
      };
    },

    /* ------------------------------------------------------------------------------------------ the public method (the shell) and the ctl's door */
    welcome(spec) { begin(spec || {}); },
    begin(kind) { begin({ kind }); },
    setChoices(c) {
      if (!c || typeof c !== 'object') { S.choices = null; return; }
      const ints = (a) => (Array.isArray(a) ? a.filter(isInt) : []);
      S.choices = {
        looks: ints(c.looks), backs: ints(c.backs), heads: isInt(c.heads) && c.heads > 0 ? c.heads : 0,
        fronts: Array.isArray(c.fronts) ? c.fronts.filter((f) => f && isInt(f.pic)).map((f) => ({ pic: f.pic, cls: typeof f.cls === 'string' ? f.cls : '' })) : [],
        species: Array.isArray(c.species) ? c.species.filter((s) => s && isInt(s.id) && typeof s.name === 'string' && s.name).map((s) => ({ id: s.id, name: s.name })) : [],
      };
    },
    setSeed(n) { if (Number.isFinite(n)) S.seed = Math.abs(Math.floor(n)) >>> 0; },
    setMascot(id) { if (isInt(id) && id > 0) { S.mascot = id; S.mascotSet = true; } },
    setStoredLook(code) { S.storedLook = typeof code === 'string' && lookId(code) !== null ? code : null; },
    setTrainers(d) {
      if (!d || !Array.isArray(d.list)) { S.trainers = null; return; }
      S.trainers = { activeId: typeof d.activeId === 'string' ? d.activeId : null, list: d.list.filter((t) => t && typeof t.id === 'string').map((t) => ({ id: t.id, name: String(t.name || ''), readOnly: !!t.readOnly, avatar: avatarOf(t.avatar), card: cardOf({ card: t.card }), rec: t.rec && typeof t.rec === 'object' ? { wins: isInt(t.rec.wins) ? t.rec.wins : undefined, losses: isInt(t.rec.losses) ? t.rec.losses : undefined, battles: isInt(t.rec.battles) ? t.rec.battles : undefined } : null })) };
    },
    saved(r) {
      if (!S.saving) return [];
      S.saving = null;
      S.input++;
      if (r && r.ok) { const p = ctx.path(); return p === 'trainer-new' || p === 'trainer-edit' ? ctx.back() : []; }
      const why = r && WORDS.failed[r.why] ? r.why : 'failed';
      note(WORDS.failed[why], true);
      return [];
    },
    saving: () => !!S.saving,
    /** Something the ctl could not do outside a save (SWITCH TRAINER refused): its words in the message box until the next input. why: a key of WORDS.failed. */
    failed(why) { S.input++; note(WORDS.failed[why] || WORDS.failed.failed, true); },
    /** (tests) the draft of the open new-trainer screens / editor, resolved: what YES / A would save. */
    draft: () => (S.wiz ? resolved(wizSeen()) : S.edit ? resolved(editSeen()) : null),
  };
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent: parentOf, create: (ctx) => createTrainerHub(ctx) });
