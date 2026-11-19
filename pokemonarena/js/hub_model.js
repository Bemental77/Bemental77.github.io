// pokemonarena/js/hub_model.js -- the HUB's state machine: which menu is open, where the cursor is, what each press does.
//
// Pure ES module (browser + Node 24): no DOM, no ROM, no timers, no randomness, no storage, no clock. A scripted run of presses and
// ticks therefore gives identical views, which tools/pokemonarena_hub_test.mjs relies on. hub_screen.js turns a view into pixels from the
// ROM; boot.js owns everything with a side effect (navigation, sound, storage, the controls dialog) and carries out the EFFECTS this
// module returns.
//
//   const hub = createHubModel({ sound: false, mascot: 25 });
//   hub.press('down');                 // -> []                      (effects to carry out)
//   hub.press('a');                    // -> [{ type: 'screen', path: 'quick' }]  (a screen change; the page mirrors it into the address bar)
//   hub.view()                         // -> a plain JSON description hub_screen.js draws
//
// SCREENS   main    QUICK BATTLE / BATTLE WITH MY TEAM / PLAY ONLINE / TOWER / TEAM BUILDER / RECORD / IMPORT SAVE / CONTROLS / SOUND / ABOUT   (more rows than fit scroll: MAIN_VISIBLE at a time)
//           tower*  the Pokemon Tower's screens (tower_hub.js owns them; this module only hands every tower path to it): tower, tower-new, tower-offer, tower-buffs, tower-ach, tower-last
//           APPS    every other family of screens is an APP (hub_apps.js lists them: online, center, builder). This module hands an app EVERY press / hit / pointer / rects / tick / view while one
//                   of its paths is open, calls enter(path) / leave(path) as its screens open and close, and onData() after every data refresh. pokemonarena/INAPP.md has the contract
//           quick   FORMAT, CPU, START, BACK            (random teams against the CPU)
//           team    [PROFILE], TEAM, FORMAT, CPU, START, BACK   (one of the player's saved teams against a random CPU team)
//           record  the trainer's battle record, in pages (record_model.js); left / right turn the page, up / down switch trainer (several profiles) or turn it (one),
//                   A turns it, on the last page RESET RECORD asks YES / NO; B goes back
//           about   pages of text (what the Arena is, what comes from the ROM, playing online, where your data is kept)
// INPUT     one vocabulary for every device: the twelve actions of input.js (up down left right a b x y l r start select) and, for
//           canvas pointers, hit(x, y) / pointer({ kind: 'move' | 'click' | 'wheel' }). Mouse, touch, keyboard and controller therefore
//           reach exactly the same states.
// DIALOGS   hub.dialog.open({ id, pages, choice, ticksLeft?, app? }) / close(id) / current(): a message box with an optional list of options OVER ANY SCREEN (hub_dialog.js). While one is open it
//           takes every press and pointer event; its answer is the effect { type: 'dialog', id, value, app? }, and the model of the app that asked hears it first (app.onDialog(id, value))
// TEXT      while the open app says wantsText(path) (it has a text entry open: textentry.js), hub.type({ text } | { key }) hands it a real keyboard's keys and pastes
// THE TRAIL the screens above the main menu that lead to the open one, outermost first (hub.trail(): ['online', 'center']; [] on the main menu). B walks down it, and the page keeps the browser's
//           history equal to it, one entry per screen, so B, the browser's Back button and a reload agree. ONE RULE for the hub's screens, the Tower and every app (go / back, below in the code):
//           a screen that is already on the trail (or the main menu) is STEPPED BACK TO; any other opens ON TOP of the open one (B returns to the screen it was opened from) or, with
//           { replace: true }, IN ITS PLACE; from the main menu the screens that lead to it by parent() are put under it. hub.arrive(path, trail) is the other direction: the ADDRESS moved
//           (the page booted at #path, the browser's Back / Forward landed there) and the model follows without asking for a history change
// FAULTS    an app's model that throws does not stop the hub (hub_apps.js guards every call): the call answers nothing, a throw in view() shows the shell's note, B still leaves, and
//           hub.faults() hands the page what happened (once per distinct fault) to say in the console and in the picture
// EFFECTS   { type: 'screen', path, back?, steps?, replace? }   the screen changed: the page makes the browser history equal to hub.trail(). back: true = a step back to a screen that is not
//                                           the main menu; steps: n = it went back over n > 1 entries; replace: true = it took the open screen's place
//           { type: 'sfx', key }            play this ROM sound effect (a music_map.js key: 'se_success') INSTEAD of the default menu sound of the press or click that returned it; key null = none
//           { type: 'navigate', url }       leave for another page (the team builder; IMPORT SAVE opens its save-import screen)
//           { type: 'sound', on }           the SOUND row was toggled (persist it, play a cry)
//           { type: 'controls' }            open the Controls panel (a DOM dialog)
//           { type: 'battle', mode: 'quick' | 'team', format, cpu, profileId?, teamId? }   START was chosen
//           { type: 'blocked', reason }     START refused (a message is also shown in the text box)
//           { type: 'record-reset', profileId }   RESET RECORD was answered YES (the page empties that profile's record in the store and reloads the list)
//           { type: 'tower-new' | 'tower-fight' | 'tower-pick' | 'tower-giveup', ... }   the Tower's (tower_hub.js lists them)
//           { type: 'dialog', id, value, app? }   a dialog was answered (value: the option's index | 'timeout' | 'closed')
//           { app: '<id>', type, ... }      ANY effect with a string `app` belongs to that app: the page hands it to the app's ctl (js/<id>_ctl.js), whatever its type

import { buildRecordNotice, buildResetConfirm } from './record_model.js';
import { createTowerHub, TOWER_PATHS, isTowerPath, towerParent } from './tower_hub.js';
import { APPS, pathsOf, appOfPath, checkRegistry, createAppHost } from './hub_apps.js';
import { createDialogLayer, wrapDialog, speakDialog } from './hub_dialog.js';
import { speakEntry } from './textentry.js';
import { cardOf } from './trainer_card.js';

export const SCREEN_W = 240, SCREEN_H = 160;
export const FORMATS = Object.freeze(['3v3', '6v6']);
export const CPU_LEVELS = Object.freeze(['easy', 'normal', 'hard']);
export const BUILDER_URL = '/pokemonarena/editor.html';
export const IMPORT_URL = '/pokemonarena/editor.html#/import';
const HUB_PATHS = Object.freeze(['main', 'quick', 'team', 'record', 'about', ...TOWER_PATHS]);          // the screens this module and the Tower own
export const PATHS = Object.freeze([...HUB_PATHS, ...pathsOf(APPS)]);                                    // ... and every app's (the address hash may name any of them)
export const MAIN_VISIBLE = 8;                   // the main menu shows this many rows; with more it scrolls (a row added later needs no change here)

// geometry shared with the renderer and with hit testing (logical 240x160 pixels)
export const GEOM = Object.freeze({
  menu: Object.freeze({ x: 12, y: 10, w: 124, pitch: 16, pitchTight: 14, pitchEight: 12 }),
  title: Object.freeze({ x: 148, y: 84, w: 84, h: 16 }),
  titleNamed: Object.freeze({ x: 148, y: 78, w: 84, h: 28, name: 14 }),          // ... with the active trainer's name under the title (small font, name = its line's offset): the same right edge, grown upwards to just under the mascot
  mascot: Object.freeze({ cx: 186, cy: 38 }),
  about: Object.freeze({ x: 12, y: 12, w: 216, h: 92, pitch: 13 }),
  // ST1: the RECORD screen: a title line (the trainer on the left, the page's name and number on the right), one ROM window for the page (PAGE_W x PAGE_H of recap_model.js) and three buttons under it
  record: Object.freeze({ title: Object.freeze({ x: 8, y: -2 }), trainer: Object.freeze({ x: 4, y: 0, w: 108, h: 16 }), win: Object.freeze({ x: 10, y: 20, w: 220, h: 106 }),
    chips: Object.freeze([Object.freeze({ id: 'prev', x: 10, y: 140, w: 64, h: 16 }), Object.freeze({ id: 'back', x: 88, y: 140, w: 64, h: 16 }), Object.freeze({ id: 'next', x: 166, y: 140, w: 64, h: 16 })]) }),
});

/** Where B goes from `path`: null from the main menu, the Tower's own parent for a Tower screen, the app's parent(path) for an app screen, the main menu from everything else. */
export function parentOf(path, apps = APPS) {
  if (path === 'main') return null;
  if (isTowerPath(path)) return towerParent(path) || 'main';
  const a = appOfPath(path, apps);
  return a ? a.parent(path) || 'main' : 'main';
}
/** The screens to walk through to reach `path` from the main menu, outermost first ('tower-offer' -> ['tower', 'tower-offer'], an app's nested screen likewise; the main menu -> []). The page seeds the
 *  browser's history with these, so a screen the page was OPENED at has the same Back stack as one walked to from the menu. (tower_hub.js arrivalTrail is the same rule for the Tower's paths alone.) */
export function arrivalTrail(path, apps = APPS) {
  const out = [];
  for (let p = path, n = 0; p && p !== 'main' && n < 16; p = parentOf(p, apps), n++) out.unshift(p);
  return out;
}
const trailOk = (t, path, paths) => t.length <= 64 && t.every((p, i) => typeof p === 'string' && p !== 'main' && paths.includes(p) && t.indexOf(p) === i) && (path === 'main' ? t.length === 0 : t[t.length - 1] === path);
const pathsFor = (apps) => (apps === APPS ? PATHS : [...HUB_PATHS, ...pathsOf(apps)]);
/**
 * The trail a history entry stands for. The page writes { arenaHub: path, trail: [...] } into every entry it makes; that trail is used when it is a list of known screens, none twice, that ends
 * at `path`. Anything else (an entry written before trails were kept, a hand-typed address, a state somebody else wrote) gets the screens that lead to `path` by parent() (arrivalTrail).
 */
export function entryTrail(state, path, apps = APPS) {
  const t = state && typeof state === 'object' && Array.isArray(state.trail) ? state.trail : null;
  return t && trailOk(t, path, pathsFor(apps)) ? t.slice() : arrivalTrail(path, apps);
}
/**
 * What the hub page must do about its browser history when it has just booted on `path`: tower_hub.js historySeedPlan's rule, with the trail of ANY hub path (an app's included). -> { trail, write }
 * trail = the entries the page stands on when it is done: the ones a fresh arrival is given (write: true), or the ones the entry it came back to already recorded (entryTrail).
 */
export function historySeedPlan(path, state, apps = APPS) {
  const marked = !!state && typeof state === 'object' && typeof state.arenaHub === 'string';
  const trail = marked ? entryTrail(state, path, apps) : arrivalTrail(path, apps);
  return { trail, write: trail.length > 0 && !marked };
}
/**
 * How the page gets its browser history from the entry it stands on (whose trail is `have`) to the one the model is on (`want` = hub.trail()). -> { back, write }
 *   back   > 0: step that many entries back first (history.go(-back)) and ask again when the browser has landed (write is then empty)
 *   write  the entries to write now, in order: { how: 'replace' | 'push', trail } (the entry's path is the last of its trail)
 * The two trails share their first entries; what `have` holds beyond them is stepped back over, what `want` holds beyond them is written. One entry to drop AND something to write is ONE
 * synchronous operation (the entry is replaced): that is what ctx.go(path, { replace: true }) and a list holding back() + go(path) come to, so the browser never shows the screen in between.
 */
export function historyPlan(have, want) {
  let c = 0; while (c < have.length && c < want.length && have[c] === want[c]) c++;
  const drop = have.length - c, add = want.length - c;
  if (drop > 1 || (drop === 1 && add === 0)) return { back: drop, write: [] };
  const write = [];
  for (let i = 0; i < add; i++) write.push({ how: i === 0 && drop === 1 ? 'replace' : 'push', trail: want.slice(0, c + i + 1) });
  return { back: 0, write };
}

/** The twelve actions (input.js) and "none of them held": what an app's tick(path, held) is given when the hub has no held state for it. */
export const ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']);
export const HELD_NONE = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a, false])));
/** Anything -> a frozen { up, down, ... } of twelve booleans: a list of the actions held (['left', 'a']), or an object with a truthy value for each one held. */
export function heldOf(x) {
  if (!x || typeof x !== 'object') return HELD_NONE;
  const on = Array.isArray(x) ? (a) => x.includes(a) : (a) => !!x[a];
  if (!ACTIONS.some(on)) return HELD_NONE;
  return Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a, on(a)])));
}

/** The ACTIVE trainer of a list of profiles (the store's active id; with none set, the only profile there is): what the title screen's partner and name, and the first-visit opening, are about. */
export function activeOf(profiles, activeId) {
  const ps = Array.isArray(profiles) ? profiles : [];
  return ps.find((p) => p && p.id === activeId) || (ps.length === 1 ? ps[0] : null);
}
export const WELCOME_KEY = 'arena.welcome';          // localStorage 'off' = the test rigs' switch (tools/headless_cdp.mjs seeds it); sessionStorage 'later' = LATER was said in this tab
/**
 * THE FIRST-VISIT OPENING (INAPP.md TRAINER, decision 1): does this page greet the player with the NEW TRAINER screens? Pure; boot.js asks it ONCE, after the first data refresh, and reads the
 * storage values it is given. -> null (not asked) | { kind: 'new' } (no profile in this browser) | { kind: 'back', name, profileId } (the active profile's card is not made: one from before
 * schema 6, offered the screens pre-filled).
 *   data      the store reader's result (hub_data.js readHubData): { state, profiles: [{ id, name, readOnly, card? }], activeId, notSaved }
 *   o         { openedAt: the path the page was OPENED at, path: the open path now, later: sessionStorage[WELCOME_KEY], off: localStorage[WELCOME_KEY], stored: the store opened and keeps profiles }
 * A page opened at any other address (an invite #online, #center, #builder ...) is not interrupted; storage that is not kept never greets (nothing could be saved).
 */
export function welcomePlan(data, o = {}) {
  if (!data || data.state !== 'ready' || data.notSaved || !o.stored) return null;
  if (o.openedAt !== 'main' || o.path !== 'main') return null;
  if (o.off === 'off' || o.later === 'later') return null;
  const ps = Array.isArray(data.profiles) ? data.profiles : [];
  if (!ps.length) return { kind: 'new' };
  const p = activeOf(ps, data.activeId);
  if (!p || p.readOnly || cardOf(p).made) return null;
  return { kind: 'back', name: String(p.name || ''), profileId: String(p.id) };
}

/** Row spacing of a menu of n rows: seven rows do not fit above the text box at the normal 16 px, so they sit 14 px apart; the eight rows of the main menu (RECORD joined it) sit 12 px apart. */
export function menuPitch(n) { return n > 7 ? GEOM.menu.pitchEight : n > 6 ? GEOM.menu.pitchTight : GEOM.menu.pitch; }

const MAIN_ITEMS = Object.freeze([
  { id: 'quick', label: 'QUICK BATTLE', help: ['Random teams against the CPU.', 'Pick 3v3 or 6v6 and the CPU level.'] },
  { id: 'team', label: 'BATTLE WITH MY TEAM', help: ['Fight with a team you built.', 'Make one in the TEAM BUILDER first.'] },
  { id: 'online', label: 'PLAY ONLINE', help: ['Battle a friend, or anyone who', 'is open to battles.'] },
  { id: 'tower', label: 'TOWER', help: ['Climb 30 floors of trainers.', 'Win a buff after every floor.'] },
  { id: 'builder', label: 'TEAM BUILDER', help: ['Make a profile and build teams:', 'natures, EVs, IVs, items, moves.'] },
  // TRAINER CARD (the 'trainer' app, INAPP.md TRAINER): right after TEAM BUILDER, so the five rows above it (and QUICK BATTLE under the cursor at the start) keep their places, it is in the eight
  // rows shown without scrolling, and it stands beside the other row that is about the player's trainer
  { id: 'trainer', label: 'TRAINER CARD', help: ['Your trainer: name, look, battle', 'figure, portrait and partner.'] },
  { id: 'record', label: 'RECORD', help: ['Wins, streaks, best hits, favourites', 'and your last battles, by trainer.'] },
  { id: 'import', label: 'IMPORT SAVE', help: ['Bring Pokemon from your own', 'SoulGold save file. It stays here.'] },
  { id: 'controls', label: 'CONTROLS', help: ['Mouse, keyboard, controller and', 'touch all work. Change the keys here.'] },
  { id: 'sound', label: 'SOUND', help: ['Volume, music, effects, soundtrack.', 'The M key mutes on any page.'] },
  { id: 'about', label: 'ABOUT', help: ['How the Arena works, and where your', 'profile and teams are kept.'] },
]);
export const MAIN_LABELS = Object.freeze(MAIN_ITEMS.map((i) => i.label));

// The ABOUT pages: plain statements, written to be true of this build (README.md carries the long version).
export const ABOUT_PAGES = Object.freeze([
  ['POK{E}MON ARENA', 'A Gen 3 style battle game. Fight a CPU with', 'random teams, or with teams you build.', 'It all runs in this browser. Nothing you', 'make is uploaded anywhere.'],
  ['FROM THE ROM', 'Every picture, font, window, menu and cry', 'is read from the Pokemon SoulGold v1.1.1', 'ROM this site already serves, in your', 'browser. Battle messages use the ROM text;', 'a few menu words are written by this site.'],
  ['PLAY ONLINE', 'Invite a friend with a link or a room code,', 'or battle anyone who is looking. Switch', 'OPEN TO BATTLES on to be listed with your', 'trainer name and record, so anyone can', 'challenge you while the Arena is open.'],
  ['YOUR DATA', 'Your profile, teams and battle record stay', 'in this browser only. Use Export in the', 'TEAM BUILDER to keep a copy; clearing the', 'site data in your browser erases them.'],
]);

// what each CPU level does (ai.js header): easy = a random legal move; normal = best expected damage plus some tactics; hard = normal plus a
// one-turn lookahead over its own options and the foe's likely replies
const CPU_HELP = Object.freeze({ easy: 'EASY: the CPU picks random moves.', normal: 'NORMAL: best damage, some tactics.', hard: 'HARD: it also looks one turn ahead.' });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FRESH = Object.freeze({ repeat: false }), REPEAT = Object.freeze({ repeat: true });          // what an app's press(path, action, info) is told about the press
const cycle = (list, cur, dir) => list[(list.indexOf(cur) + dir + list.length) % list.length];
const hasOwn = Object.prototype.hasOwnProperty;

/** The formats a team of this size may play (a 3v3 battle needs three Pokemon; battle.html refuses fewer). */
export function allowedFormats(size) { return size >= 3 ? ['3v3', '6v6'] : ['6v6']; }
/** The format a team of this size starts on. */
export function defaultFormat(size) { return size >= 4 ? '6v6' : size === 3 ? '3v3' : '6v6'; }

/**
 * opts: { sound: bool, mascot: species id, env: terrain id, quick: { format, cpu }, selection: { profileId, teamId, cpu },
 *         hasSpecies: (id) -> whether the ROM can draw this species (the active trainer's PARTNER stands on the title screen only then; default: any whole number above 0),
 *         pickMascot: (view-model) -> species id (default keeps the opts.mascot),
 *         measure: (s) -> pixels in the message font, msgPx: the message window's inner width (the Tower wraps its texts by them),
 *         measureFont: (font, s) -> pixels in any ROM font (what an app's ctx.measure and the dialog layer use; default 6 px a character),
 *         apps: a list of app descriptors to host INSTEAD of hub_apps.js APPS (tests give fakes; PATHS above is the default registry's) }
 */
export function createHubModel(opts = {}) {
  const S = {
    path: 'main', trail: [], cursor: { main: 0, quick: 0, team: 0 }, from: 'main',          // trail: the screens above the main menu that lead to `path` (its last entry), outermost first
    sound: !!opts.sound, mascot: Number.isInteger(opts.mascot) ? opts.mascot : 25, env: Number.isInteger(opts.env) ? opts.env : 0,
    quick: { format: opts.quick && FORMATS.includes(opts.quick.format) ? opts.quick.format : '3v3', cpu: opts.quick && CPU_LEVELS.includes(opts.quick.cpu) ? opts.quick.cpu : 'normal' },
    team: { profileId: opts.selection && opts.selection.profileId || null, teamId: opts.selection && opts.selection.teamId || null, format: null, formatTouched: false, cpu: opts.selection && CPU_LEVELS.includes(opts.selection.cpu) ? opts.selection.cpu : 'normal' },
    data: { state: 'loading', profiles: [], note: '', activeId: null },       // state: loading | ready | unavailable
    about: { page: 0 }, flash: null, tick: 0, resultsOf: null,
    record: { page: 0, profileId: null, focus: 'page', confirm: null, hover: null },
    offset: { main: 0 }, link: false,
  };

  /* ------------------------------------------------------------------------------------------ team data */
  const profiles = () => S.data.profiles;
  const curProfile = () => { const ps = profiles(); return ps.find((p) => p.id === S.team.profileId) || ps[0] || null; };
  const curTeam = () => { const p = curProfile(); if (!p) return null; return p.teams.find((t) => t.id === S.team.teamId) || p.teams[0] || null; };
  // a profile's record pages as the store reader built them (hub_data.js): plain JSON, kept as given when it has the right shape
  function recordOf(p) {
    const r = p && p.record;
    if (!r || !Array.isArray(r.pages) || !r.pages.length || r.pages.length > 64) return null;
    return { battles: r.battles | 0, resettable: !!r.resettable, pages: JSON.parse(JSON.stringify(r.pages)) };
  }
  function normaliseTeamSel() {
    const p = curProfile(); S.team.profileId = p ? p.id : null;
    const t = curTeam(); S.team.teamId = t ? t.id : null;
    const ok = t ? allowedFormats(t.size) : FORMATS;
    if (!S.team.formatTouched || !ok.includes(S.team.format)) { S.team.format = t ? defaultFormat(t.size) : '3v3'; S.team.formatTouched = false; }
  }

  /* ------------------------------------------------------------------------------------------ the rows of each screen */
  // AN APP MAY WORD ITS OWN ROW OF THE MAIN MENU: its model's optional mainRow() -> { label?, help? } | null (PLAY ONLINE says there, at a glance, whether the player is open to battles).
  // It is taken no further than a short label and two lines of help, and a model without one, or one that throws, leaves the row as the menu words it.
  function appRow(id) {
    try {
      const a = apps.raw(id), r = a && typeof a.mainRow === 'function' ? a.mainRow() : null;
      if (!r || typeof r !== 'object') return null;
      return { label: typeof r.label === 'string' && r.label && r.label.length <= 24 ? r.label : null, help: Array.isArray(r.help) && r.help.length === 2 && r.help.every((l) => typeof l === 'string') ? [r.help[0], r.help[1]] : null };
    } catch (_e) { return null; }
  }
  function mainRows() {
    return MAIN_ITEMS.map((it) => ({ id: it.id, kind: 'item', label: it.label === 'SOUND' ? 'SOUND: ' + (S.sound ? 'ON' : 'OFF') : (appRow(it.id) || {}).label || it.label }));
  }
  function quickRows() {
    return [
      { id: 'format', kind: 'choice', label: 'FORMAT', value: S.quick.format, values: FORMATS },
      { id: 'cpu', kind: 'choice', label: 'CPU', value: S.quick.cpu.toUpperCase(), values: CPU_LEVELS },
      { id: 'start', kind: 'button', label: 'START' },
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  function teamRows() {
    const rows = [];
    const ps = profiles(), t = curTeam(), p = curProfile();
    if (!t) { rows.push({ id: 'builder', kind: 'button', label: 'TEAM BUILDER' }, { id: 'back', kind: 'button', label: 'BACK' }); return rows; }
    if (ps.length > 1) rows.push({ id: 'profile', kind: 'choice', label: 'TRAINER', value: p.name, values: ps.map((x) => x.id) });
    rows.push({ id: 'teamsel', kind: 'choice', label: 'TEAM', value: t.name, values: p.teams.map((x) => x.id), count: p.teams.length });
    rows.push({ id: 'format', kind: 'choice', label: 'FORMAT', value: S.team.format, values: allowedFormats(t.size) });
    rows.push({ id: 'cpu', kind: 'choice', label: 'CPU', value: S.team.cpu.toUpperCase(), values: CPU_LEVELS });
    rows.push({ id: 'start', kind: 'button', label: 'START', disabled: !t.legal });
    rows.push({ id: 'back', kind: 'button', label: 'BACK' });
    return rows;
  }
  function rowsOf(path) { return path === 'main' ? mainRows() : path === 'quick' ? quickRows() : path === 'team' ? teamRows() : isTowerPath(path) ? tower.menuRows(path) : []; }
  const rows = () => rowsOf(S.path);
  function clampCursor() { const n = rows().length; if (n && S.path in S.cursor) S.cursor[S.path] = clamp(S.cursor[S.path], 0, n - 1); }
  // a menu longer than the room scrolls (the main menu): the rows shown are a window of MAIN_VISIBLE, moved just far enough to keep the cursor in it
  function mainWindow() {
    const n = mainRows().length, cur = clamp(S.cursor.main, 0, Math.max(0, n - 1));
    let off = clamp(S.offset.main, 0, Math.max(0, n - MAIN_VISIBLE));
    if (cur < off) off = cur; else if (cur >= off + MAIN_VISIBLE) off = cur - MAIN_VISIBLE + 1;
    S.offset.main = off;
    return { off, n, size: Math.min(n, MAIN_VISIBLE) };
  }
  /* ------------------------------------------------------------------------------------------ the dialog layer and the apps */
  // (a measure never throws here: a text the font's own measure chokes on is taken at 6 px a character, so an app's ctx.measure and the dialog layer cannot be stopped by a string)
  const measureRaw = typeof opts.measureFont === 'function' ? (font, s) => opts.measureFont(font, String(s)) : (font, s) => (font === 'normal' && typeof opts.measure === 'function' ? opts.measure(String(s)) : String(s).length * 6);
  const measureFont = (font, s) => { try { const px = measureRaw(font, s); if (Number.isFinite(px)) return px; } catch (_e) { /* fall through */ } return String(s).length * 6; };
  const msgPx = Number.isFinite(opts.msgPx) && opts.msgPx > 40 ? opts.msgPx : 204;
  const dialog = createDialogLayer({ measure: measureFont });
  const appList = Array.isArray(opts.apps) ? opts.apps : APPS;
  { const bad = checkRegistry(appList, HUB_PATHS, (p) => parentOf(p, [])); if (bad.length) throw new Error('the hub app registry is broken: ' + bad.join('; ')); }
  const paths = appList === APPS ? PATHS : Object.freeze([...HUB_PATHS, ...pathsOf(appList)]);
  const fxOf = (r) => (Array.isArray(r) ? r : []);
  const lineOf = (l) => (l === undefined || l === null ? '' : String(l));
  const pagesOf = (lines) => { const out = []; for (let i = 0; i < lines.length; i += 2) out.push([lineOf(lines[i]), lineOf(lines[i + 1])]); return out; };
  // AN APP THAT THROWS (hub_apps.js calls this for every method of an app's model that threw; what it returns stands in for the call): the fault is kept for the page (faults(), each distinct
  // one once), the call answers "nothing", a view that could not be made becomes one the renderer draws the shell's note for, and the B press that threw still goes back.
  const faultList = [], faultSeen = new Set();
  function onFault(id, where, err, args) {
    const message = String(err && err.message ? err.message : err).slice(0, 200), key = id + '\n' + where + '\n' + message;
    if (!faultSeen.has(key) && faultSeen.size < 64) { faultSeen.add(key); faultList.push({ app: id, where, message }); }
    switch (where) {
      case 'view': return { ...(args[1] && typeof args[1] === 'object' ? args[1] : {}), fault: { where, message } };
      case 'press': return args[1] === 'b' && S.path === args[0] ? back() : [];
      case 'hit': return null;
      case 'wantsText': return false;
      case 'speak': case 'title': return '';
      case 'state': return { fault: message };
      default: return [];          // enter, leave, pointer, rects, tick, onData, onDialog, type
    }
  }
  // what an app's factory is given: the data the store reader built, the screen changes, the font, a notice, and its own door to the dialog layer (the answers come back to its onDialog)
  const apps = createAppHost(appList, (desc) => ({
    profiles: () => S.data.profiles, activeId: () => S.data.activeId, dataState: () => S.data.state,
    go: (path, o) => go(path, o), back: () => back(), path: () => S.path, trail: () => S.trail.slice(),
    measure: measureFont, msgPx,
    notify(lines) {
      const pages = Array.isArray(lines) ? (lines.some((l) => lineOf(l).trim()) ? pagesOf(lines) : null) : typeof lines === 'string' && lines.trim() ? wrapDialog(lines, measureFont, msgPx) : null;
      if (!pages) return false;          // nothing to say (null, [], '', only blanks): no empty box is opened
      const id = 'notice:' + desc.id; dialog.close(id); return dialog.open({ id, pages, choice: null });
    },
    dialog: Object.freeze({ open: (spec) => dialog.open({ ...spec, app: desc.id }), close: (id) => dialog.closeOwn(id, desc.id), current: () => dialog.current() }),
  }), onFault);
  // a dialog's answer: the model of the app that asked hears it first (its effects follow the answer's), then the page hands the answer to that app's ctl
  function dialogFx(fx) {
    let out = [];
    for (const e of fx) {
      out.push(e);
      const a = e.type === 'dialog' && e.app ? apps.byId(e.app) : null;
      if (a && typeof a.onDialog === 'function') out = out.concat(fxOf(a.onDialog(e.id, e.value)));
    }
    return out;
  }

  // THE TOWER (tower_hub.js): every path that starts with "tower" is its own state machine; it gets the profiles the store reader built and asks this module for screen changes
  const tower = createTowerHub({ profiles: () => S.data.profiles, activeId: () => S.data.activeId, dataState: () => S.data.state, go: (path) => go(path), back: () => back(), path: () => S.path, arrivedByLink: () => S.link, measure: opts.measure, msgPx: opts.msgPx });

  /* ------------------------------------------------------------------------------------------ text box help */
  function helpFor(row) {
    if (S.flash) return S.flash;
    if (S.path === 'main') {
      if (row.id === 'sound') return S.sound ? ['A opens the SOUND panel: volume,', 'music, effects and soundtrack.'] : ['Sound is muted. The SOUND panel', 'unmutes it and sets the volume.'];
      const it = MAIN_ITEMS.find((x) => x.id === row.id); return (appRow(row.id) || {}).help || (it ? it.help : ['', '']);
    }
    if (S.path === 'quick') {
      if (row.id === 'format') return S.quick.format === '3v3' ? ['3v3: pick 3 of 6 at a team preview.', 'A or the arrows change it.'] : ['6v6: all six Pokemon fight.', 'A or the arrows change it.'];
      if (row.id === 'cpu') return [CPU_HELP[S.quick.cpu], 'A or the arrows change it.'];
      if (row.id === 'start') return ['Both teams are random and legal.', 'A starts the battle.'];
      return ['Back to the main menu.', ''];
    }
    if (S.path === 'team') {
      if (S.data.state === 'loading') return ['Looking for your teams...', ''];
      const t = curTeam(), p = curProfile();
      if (!t) return S.data.state === 'unavailable' ? ['Your teams could not be read here.', S.data.note || 'Storage may be blocked.'] : [p ? 'This trainer has no team yet.' : 'You have no team yet.', 'Build one in the TEAM BUILDER.'];
      if (row.id === 'teamsel' || row.id === 'profile') return [t.names.slice(0, 3).join(', ') || '(empty)', t.names.length > 3 ? t.names.slice(3).join(', ') : (t.legal ? 'Legal and ready to fight.' : 'Not ready: ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + '.')];
      if (row.id === 'format') return [S.team.format === '3v3' ? '3v3: pick 3 of your ' + t.size + ' at a preview.' : '6v6: all ' + t.size + ' of your Pokemon fight.', t.size < 3 ? 'A team under 3 plays 6v6 only.' : 'A or the arrows change it.'];
      if (row.id === 'cpu') return [CPU_HELP[S.team.cpu], 'The CPU brings a random legal team.'];
      if (row.id === 'start') return t.legal ? ['Fight with ' + t.name + '.', 'A starts the battle.'] : ['Fix ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + ' in the TEAM BUILDER', 'first, then come back.'];
      return ['Back to the main menu.', ''];
    }
    return ['', ''];
  }

  /* ------------------------------------------------------------------------------------------ view */
  // THE ACTIVE TRAINER'S PARTNER (card.partner) stands where the day's mascot would, when the ROM has that species
  const hasSpecies = typeof opts.hasSpecies === 'function' ? opts.hasSpecies : (id) => Number.isInteger(id) && id > 0;
  const activeProfile = () => activeOf(S.data.profiles, S.data.activeId);
  function partnerNow() {
    const p = activeProfile(), id = p && p.card ? p.card.partner : null;
    if (!Number.isInteger(id)) return null;
    try { return hasSpecies(id) ? id : null; } catch (_e) { return null; }
  }
  function mascotNow() {
    if (S.path === 'team') { const t = curTeam(); if (t && t.lead) return { species: t.lead.species, shiny: !!t.lead.shiny, gender: t.lead.gender || null }; }
    const partner = partnerNow();
    if (partner) return { species: partner, shiny: false, gender: null };
    return { species: S.mascot, shiny: false, gender: null };
  }
  /* ------------------------------------------------------------------------------------------ the RECORD screen (ST1) */
  // the trainer shown: the one chosen here, else the active profile of the store, else the one last used for a team battle, else the first
  const curRecordProfile = () => { const ps = profiles(); return ps.find((p) => p.id === S.record.profileId) || ps.find((p) => p.id === S.data.activeId) || ps.find((p) => p.id === S.team.profileId) || ps[0] || null; };
  function recordPages() {
    if (S.data.state === 'loading') return buildRecordNotice('loading');
    if (S.data.state === 'unavailable') return buildRecordNotice('unavailable');
    const p = curRecordProfile();
    if (!p) return buildRecordNotice('none');
    return p.record && p.record.pages.length ? p.record.pages : buildRecordNotice('unavailable');
  }
  const recordPageNow = (pages) => pages[clamp(S.record.page, 0, pages.length - 1)];
  const recordButtonRect = (pg) => (pg && pg.button ? { x: GEOM.record.win.x + pg.button.x, y: GEOM.record.win.y + pg.button.y, w: pg.button.w, h: pg.button.h } : null);
  function recordTurn(d) { const pages = recordPages(); S.record.page = clamp(S.record.page + d, 0, pages.length - 1); }
  function recordTrainer(d) {
    const ps = profiles(); if (ps.length < 2) return;
    const cur = curRecordProfile();
    S.record.profileId = ps[(ps.findIndex((p) => p.id === cur.id) + d + ps.length) % ps.length].id; S.record.page = 0; S.record.confirm = null;
  }
  function recordOpenConfirm() { const p = curRecordProfile(), pg = recordPageNow(recordPages()); if (!p || !pg || !pg.button || !pg.button.enabled) return; S.record.confirm = { cursor: 1, profileId: p.id, name: p.name }; }
  function recordView() {
    const p = curRecordProfile(), c = S.record.confirm;
    const pages = c ? [buildResetConfirm(c.name)] : recordPages();
    const index = c ? 0 : clamp(S.record.page, 0, pages.length - 1), pg = pages[index], br = !c ? recordButtonRect(pg) : null;
    return { screen: 'record', env: S.env, mascot: mascotNow(), tick: S.tick, sound: S.sound, title: false, about: null, menu: null, msg: null,
      record: { page: pg, index, count: pages.length, trainer: p ? { name: p.name, index: profiles().indexOf(p), count: profiles().length } : null, focus: S.record.focus, confirm: c ? { cursor: c.cursor } : null,
        hover: S.record.hover, canPrev: !c && index > 0, canNext: !c && index < pages.length - 1, button: br ? { label: pg.button.label, enabled: pg.button.enabled, x: br.x, y: br.y, w: br.w, h: br.h } : null, notice: pg.id === 'notice' } };
  }
  function recordPress(a) {
    const c = S.record.confirm;
    if (c) {
      if (a === 'left' || a === 'right' || a === 'up' || a === 'down') c.cursor ^= 1;
      else if (a === 'a') { S.record.confirm = null; if (c.cursor === 0) { S.record.page = 0; return [{ type: 'record-reset', profileId: c.profileId }]; } }
      else if (a === 'b') S.record.confirm = null;
      return [];
    }
    const pages = recordPages(), pg = recordPageNow(pages), multi = profiles().length > 1;
    if (a === 'b') return back();
    if (a === 'up' || a === 'down') { if (multi) S.record.focus = a === 'up' ? 'trainer' : 'page'; else recordTurn(a === 'up' ? -1 : 1); return []; }
    if (a === 'left' || a === 'l' || a === 'right' || a === 'r') { const d = a === 'left' || a === 'l' ? -1 : 1; if (S.record.focus === 'trainer' && multi) recordTrainer(d); else recordTurn(d); return []; }
    if (a === 'a') {
      if (pg.action === 'builder') return [{ type: 'navigate', url: BUILDER_URL }];
      if (S.record.focus === 'trainer' && multi) { recordTrainer(1); return []; }
      if (pg.button) { recordOpenConfirm(); return []; }
      if (S.record.page < pages.length - 1) { recordTurn(1); return []; }
      return back();
    }
    return [];
  }
  function recordHit(x, y) {
    const G = GEOM.record, inR = (r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    if (S.record.confirm) { if (inR({ x: G.chips[0].x - 2, y: G.chips[0].y - 4, w: G.chips[0].w + 4, h: G.chips[0].h + 8 })) return { kind: 'rec-yes' }; return { kind: 'rec-no' }; }
    if (profiles().length > 1 && inR(G.trainer)) return { kind: x < G.trainer.x + G.trainer.w / 2 ? 'rec-trainer-prev' : 'rec-trainer-next' };
    for (const c of G.chips) if (inR({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 })) return { kind: 'rec-' + c.id };
    const b = recordButtonRect(recordPageNow(recordPages()));
    if (b && inR({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 })) return { kind: 'rec-reset' };
    return inR({ x: 0, y: 14, w: 240, h: 124 }) ? { kind: 'rec-page' } : null;
  }
  function recordPointer(ev) {
    if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); for (let i = 0; i < n; i++) { if (S.record.confirm) recordPress((ev.steps || 0) > 0 ? 'down' : 'up'); else recordTurn((ev.steps || 0) > 0 ? 1 : -1); } return []; }
    const h = ev.x === undefined || ev.x === null ? null : recordHit(ev.x, ev.y);
    if (!h) { if (ev.kind === 'move') S.record.hover = null; return []; }
    if (ev.kind === 'move' || ev.kind === 'down') { S.record.hover = h.kind.slice(4); if (S.record.confirm && (h.kind === 'rec-yes' || h.kind === 'rec-no')) S.record.confirm.cursor = h.kind === 'rec-yes' ? 0 : 1; if (h.kind.startsWith('rec-trainer')) S.record.focus = 'trainer'; else if (h.kind !== 'rec-page') S.record.focus = 'page'; return []; }
    if (ev.kind !== 'click') return [];
    S.record.hover = h.kind.slice(4);
    switch (h.kind) {
      case 'rec-yes': if (S.record.confirm) S.record.confirm.cursor = 0; return recordPress('a');
      case 'rec-no': if (S.record.confirm) S.record.confirm.cursor = 1; return recordPress('a');
      case 'rec-prev': recordTurn(-1); return [];
      case 'rec-next': recordTurn(1); return [];
      case 'rec-back': return back();
      case 'rec-trainer-prev': S.record.focus = 'trainer'; recordTrainer(-1); return [];
      case 'rec-trainer-next': S.record.focus = 'trainer'; recordTrainer(1); return [];
      case 'rec-reset': recordOpenConfirm(); return [];
      case 'rec-page': { S.record.focus = 'page'; return recordPress('a'); }
      default: return [];
    }
  }

  // (a dialog rides on whatever the screen's view is: the key exists only while one is open, so an ordinary view is exactly what it was. `dialog` is the hub's key: one an app's view carries is dropped)
  function view() { const v = screenView(), d = dialog.view(); if (d) v.dialog = d; else if ('dialog' in v) delete v.dialog; return v; }
  function screenView() {
    clampCursor();
    const base = { screen: S.path, env: S.env, mascot: mascotNow(), tick: S.tick, sound: S.sound };
    if (S.path === 'record') return recordView();
    if (isTowerPath(S.path)) return tower.view(S.path, base);
    { const a = apps.of(S.path); if (a) return { ...a.view(S.path, base), screen: S.path, app: a.id }; }
    if (S.path === 'about') {
      const pg = ABOUT_PAGES[S.about.page];
      return { ...base, title: false, about: { page: S.about.page, pages: ABOUT_PAGES.length, lines: pg.slice(), last: S.about.page === ABOUT_PAGES.length - 1 }, menu: null, msg: null };
    }
    const rs = rows();
    const cur = S.cursor[S.path];
    const row = rs[cur];
    if (S.path === 'main') {
      const w = mainWindow();
      const who = activeProfile();          // the active trainer's name, small on the title side (null: no trainer yet)
      return { ...base, title: true, trainer: who ? who.name : null, menu: { rows: rs.slice(w.off, w.off + w.size).map(({ values, ...r }) => r), cursor: cur - w.off, offset: w.off, total: w.n, up: w.off > 0, down: w.off + w.size < w.n }, about: null, msg: row ? helpFor(row) : ['', ''] };
    }
    return { ...base, title: true, menu: { rows: rs.map(({ values, ...r }) => r), cursor: cur }, about: null, msg: row ? helpFor(row) : ['', ''] };
  }

  /* ------------------------------------------------------------------------------------------ transitions */
  // THE TRAIL (S.trail): the screens above the main menu that lead to the open one, outermost first. S.path is its last entry, and it is empty on the main menu. The page keeps the browser's
  // history equal to it (historyPlan), so what B does here is what the browser's Back button does there. Every move goes through open(): go / back from a press, arrive from the address.
  //   go(path)                      a screen already on the trail, or the main menu, is STEPPED BACK TO (everything above it is dropped: "saved, back to the list", "deleted, up two levels",
  //                                 "home"). Any other screen opens ON TOP of the open one, so B returns to the screen it was opened from (the builder opened from the Center's PC returns to
  //                                 the Center, not to the main menu its parent is). From the MAIN MENU the screens that lead to it by parent() are put under it, as its address would
  //   go(path, { replace: true })   ... opens IN PLACE of the open one: B then goes where B went from the screen replaced (a wizard's next step, a redirect). On the main menu it is a plain go
  //   back()                        one step down the trail. For a screen reached the usual way that is parent(path)
  // Each returns the 'screen' effect of the move, then whatever the screen's enter(path) asked for.
  function open(path, trail) {
    { const was = apps.of(S.path); if (was) was.leave(S.path); }          // (the app is told while its screen is still the open one)
    S.from = S.path; S.path = path; S.flash = null;
    S.trail = trail;
    if (isTowerPath(path)) tower.enter(path);
    let enterFx = [];
    { const now = apps.of(path); if (now) enterFx = fxOf(now.enter(path)); }
    if (path === 'about') S.about.page = 0;
    if (path === 'team') normaliseTeamSel();
    if (path === 'record') { const rp = curRecordProfile(); S.record.profileId = rp ? rp.id : null; S.record.page = 0; S.record.focus = 'page'; S.record.confirm = null; S.record.hover = null; }
    clampCursor();
    return [{ type: 'screen', path }].concat(enterFx);
  }
  // n entries down the trail (n >= 1). A step back to a screen that is not the main menu says so (back: true), and how far when it is more than one entry (steps: n)
  function stepBack(n) {
    const trail = S.trail.slice(0, Math.max(0, S.trail.length - n)), up = trail.length ? trail[trail.length - 1] : 'main';
    const fx = open(up, trail).map((e) => (e.type === 'screen' && up !== 'main' ? { ...e, back: true } : e));
    return n > 1 ? fx.map((e, i) => (i === 0 ? { ...e, steps: n } : e)) : fx;
  }
  function go(path, o) {
    if (!paths.includes(path) || path === S.path) return [];
    const at = path === 'main' ? -1 : S.trail.lastIndexOf(path);
    if (path === 'main' || at >= 0) return stepBack(S.trail.length - 1 - at);          // it is on the way here: step back to it
    const replace = !!(o && o.replace) && S.trail.length > 0;
    const trail = replace ? S.trail.slice(0, -1).concat([path]) : S.trail.length ? S.trail.concat([path]) : arrivalTrail(path, appList);
    const fx = open(path, trail);
    return replace ? fx.map((e, i) => (i === 0 ? { ...e, replace: true } : e)) : fx;
  }
  function back() {
    if (S.path === 'main') return [];
    return stepBack(1);
  }

  function change(row, dir) {
    if (S.flash) S.flash = null;
    if (row.kind !== 'choice') return [];
    if (S.path === 'quick') {
      if (row.id === 'format') S.quick.format = cycle(FORMATS, S.quick.format, dir);
      else if (row.id === 'cpu') S.quick.cpu = cycle(CPU_LEVELS, S.quick.cpu, dir);
      return [];
    }
    if (S.path === 'team') {
      const p = curProfile(), t = curTeam();
      if (row.id === 'profile') { const ids = profiles().map((x) => x.id); S.team.profileId = cycle(ids, p.id, dir); S.team.teamId = null; S.team.formatTouched = false; normaliseTeamSel(); }
      else if (row.id === 'teamsel') { const ids = p.teams.map((x) => x.id); S.team.teamId = cycle(ids, t.id, dir); S.team.formatTouched = false; normaliseTeamSel(); }
      else if (row.id === 'format') { S.team.format = cycle(allowedFormats(t.size), S.team.format, dir); S.team.formatTouched = true; }
      else if (row.id === 'cpu') S.team.cpu = cycle(CPU_LEVELS, S.team.cpu, dir);
    }
    return [];
  }

  function activate(row) {
    S.flash = null;
    if (S.path === 'main') {
      switch (row.id) {
        case 'quick': return go('quick');
        case 'team': return go('team');
        case 'online': return go('online');
        case 'tower': return go('tower');
        case 'record': return go('record');
        case 'builder': return go('builder');
        case 'trainer': return go('trainer');          // ([] while no app owns the path)
        case 'import': return [{ type: 'navigate', url: IMPORT_URL }];
        case 'controls': return [{ type: 'controls' }];
        case 'sound': S.sound = !S.sound; return [{ type: 'sound', on: S.sound }];
        case 'about': return go('about');
        default: return [];
      }
    }
    if (row.kind === 'choice') return change(row, 1);
    if (row.id === 'back') return back();
    if (row.id === 'builder') return [{ type: 'navigate', url: BUILDER_URL }];
    if (row.id === 'start') {
      if (S.path === 'quick') return [{ type: 'battle', mode: 'quick', format: S.quick.format, cpu: S.quick.cpu }];
      const t = curTeam(), p = curProfile();
      if (!t || !p) return [];
      if (!t.legal) { S.flash = ['Fix ' + t.problems + ' problem' + (t.problems === 1 ? '' : 's') + ' in the TEAM BUILDER', 'first, then come back.']; return [{ type: 'blocked', reason: 'team-illegal' }]; }
      return [{ type: 'battle', mode: 'team', format: S.team.format, cpu: S.team.cpu, profileId: p.id, teamId: t.id }];
    }
    return [];
  }

  /* ------------------------------------------------------------------------------------------ public API */
  const api = {
    view,
    path: () => S.path,
    state: () => JSON.parse(JSON.stringify({ path: S.path, trail: S.trail, cursor: S.cursor, quick: S.quick, team: S.team, sound: S.sound, about: S.about, record: { page: S.record.page, focus: S.record.focus, confirm: S.record.confirm ? S.record.confirm.cursor : null }, data: { state: S.data.state, profiles: S.data.profiles.length }, tower: tower.state(), apps: apps.state(), dialog: dialog.state() })),
    /** The rows of the open menu (on an app's screen: the rows of the menu its view carries, [] when it has none). */
    rows: () => { const a = apps.of(S.path); if (a) { const mn = a.view(S.path, { screen: S.path, env: S.env, mascot: null, tick: S.tick, sound: S.sound }).menu; return mn && Array.isArray(mn.rows) ? mn.rows.map((r) => ({ ...r })) : []; } return rows().map(({ values, ...r }) => r); },
    /** The Tower's screens (tower_hub.js): a handle for the page and the tests. */
    tower,
    /** THE APPS (hub_apps.js): { id: the app's model } for the page and the tests; app(id) -> one of them or null; appOf(path) -> the one that owns the path or null. (The app's OWN model, with its own methods: the hub itself calls an app only through the guard of hub_apps.js.) */
    apps: Object.freeze(apps.handles()),
    app: (id) => apps.raw(id),
    appOf: (path) => apps.rawOf(path),
    /** What apps threw since this was last asked: [{ app, where, message }], each distinct fault once. The page says them in the console and in the picture. */
    faults: () => faultList.splice(0),
    /** The screens above the main menu that lead to the open one, outermost first ([] on the main menu): what B walks down and what the page keeps the browser's history equal to. */
    trail: () => S.trail.slice(),
    /** Every path this model knows (the hub's, the Tower's, every hosted app's). */
    paths,
    /** THE DIALOG LAYER (hub_dialog.js): open(spec) -> bool (shown, or queued behind the open one; false = refused), close(id) -> bool, current() -> the dialog shown or null, isOpen(). */
    dialog: Object.freeze({ open: (spec) => dialog.open(spec), close: (id) => dialog.close(id), current: () => dialog.current(), isOpen: () => dialog.isOpen() }),
    /**
     * One frame (59.7275 a second). -> effects: a dialog that timed out, and whatever the open app's tick(path, held) asks for (an app is ticked only while one of its screens is open).
     * held: the actions the player is holding down (a list of them, or { up: true, ... }); the app gets a frozen { up, down, left, right, a, b, x, y, l, r, start, select } of booleans,
     * all false while a dialog is open over it (the dialog has the buttons) or when the caller gave none.
     */
    tick(held) {
      S.tick = (S.tick + 1) >>> 0;
      let fx = dialogFx(dialog.tick());
      const a = apps.of(S.path);
      if (a) fx = fx.concat(fxOf(a.tick(S.path, dialog.isOpen() ? HELD_NONE : heldOf(held))));
      return fx;
    },
    /** Is the open screen taking typed text (an app with a text entry open, and no dialog over it)? The page then sends a real keyboard's keys to type() instead of treating them as buttons. */
    wantsText() { if (dialog.isOpen()) return false; const a = apps.of(S.path); return !!(a && a.wantsText(S.path)); },
    /** Is a dialog open OVER a text entry? The page then keeps a real keyboard's letters from acting as buttons (the word being typed must not answer the question): Enter, Escape, Backspace and the arrows still do. */
    textUnder() { if (!dialog.isOpen()) return false; const a = apps.of(S.path); return !!(a && a.wantsText(S.path)); },
    /** Typed text for the open app: { text } (a key, or a paste) or { key: 'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' | 'enter' | 'escape' }. -> effects ([] when nothing is taking text). */
    type(input) { if (dialog.isOpen()) return []; const a = apps.of(S.path); return a && a.wantsText(S.path) ? fxOf(a.type(S.path, input)) : []; },
    /** The screen reader's words for a view that an app, a text entry or a dialog owns; null for the hub's own screens (the page words those). */
    speak(v) {
      if (!v) return null;
      if (v.dialog) return speakDialog(v.dialog);
      if (v.entry) return speakEntry(v.entry);
      if (v.fault) return 'This screen hit a problem. B goes back.';
      const a = typeof v.app === 'string' ? apps.byId(v.app) : null;
      return a ? String(a.speak(v) || '') : null;
    },
    /** The page title of an app's screen (null for the hub's own: the page has those). */
    title(path) { const a = apps.of(path); return a ? String(a.title(path) || '') || null : null; },
    setTick(n) { S.tick = n >>> 0; },
    setSound(on) { S.sound = !!on; },
    setMascot(id) { if (Number.isInteger(id)) S.mascot = id; },
    setEnv(id) { if (Number.isInteger(id)) S.env = id; },
    /** Show a message in the text box until the next move of the cursor (e.g. a team code that could not be made). */
    notify(lines) { S.flash = Array.isArray(lines) ? lines.slice(0, 2).map(String) : [String(lines), '']; },
    quickSettings: () => ({ ...S.quick }),
    /** The RECORD screen's selection (the trainer shown, the page, whether RESET RECORD is asking). */
    recordState: () => ({ profileId: curRecordProfile() ? curRecordProfile().id : null, page: S.record.page, focus: S.record.focus, confirming: !!S.record.confirm, pages: recordPages().length }),
    teamSettings: () => ({ profileId: S.team.profileId, teamId: S.team.teamId, cpu: S.team.cpu }),
    /** Team data from the store: { state: 'ready' | 'unavailable', note?, profiles: [{ id, name, teams: [{ id, name, size, legal, problems, names[], lead }] }], activeId } */
    setData(d) {
      S.data = { state: d && d.state === 'unavailable' ? 'unavailable' : 'ready', profiles: d && Array.isArray(d.profiles) ? d.profiles.map((p) => ({ id: String(p.id), name: String(p.name), teams: (p.teams || []).map((t) => ({ id: String(t.id), name: String(t.name), size: t.size | 0, legal: !!t.legal, problems: t.problems | 0, names: (t.names || []).map(String), lead: t.lead || null, ruleset: typeof t.ruleset === 'string' ? t.ruleset : '' })), record: recordOf(p), readOnly: !!p.readOnly, card: cardOf(p), avatar: p.avatar && typeof p.avatar === 'object' ? { kind: String(p.avatar.kind), id: p.avatar.id | 0 } : null, tower: p.tower && typeof p.tower === 'object' ? JSON.parse(JSON.stringify(p.tower)) : null })) : [], note: d && d.note || '', activeId: d && typeof d.activeId === 'string' ? d.activeId : null };
      if (d && d.activeId && !S.team.profileId && S.data.profiles.some((p) => p.id === d.activeId)) S.team.profileId = d.activeId;
      if (S.path === 'team' || S.team.profileId || S.team.teamId) normaliseTeamSel();
      if (S.path === 'record') { const rp = curRecordProfile(); S.record.profileId = rp ? rp.id : null; S.record.page = clamp(S.record.page, 0, recordPages().length - 1); S.record.confirm = null; }
      clampCursor();
      const towerFx = tower.onData();         // the Tower's screens follow the data (a ball taken closes the offer): the effects are screen changes the page mirrors into history
      return towerFx.concat(apps.onData());   // ... and so does every app (open or not: an app keeps its own copy of what it needs)
    },
    /** Open `path` as an app's ctx.go(path, o) does (THE TRAIL, above) -> effects for the page to run. What a ctl navigates with: env.run(env.model.goto('center')). o: { replace: true }. */
    goto(path, o) { if (!paths.includes(path) || path === S.path) return []; if (isTowerPath(path) && S.path === 'main') S.link = true; return go(path, o); },          // (a Tower screen reached from the menu this way may open the pending offer by itself)
    /**
     * THE ADDRESS NOW NAMES `path`: the page booted there, or the browser's Back / Forward landed there. The model opens it WITHOUT asking for a history change (there is no 'screen' effect
     * for the move itself), with the trail that history entry stands for (entryTrail; default: the screens that lead to `path` by parent()). -> what the screen's enter(path) asked for.
     * An unknown path is the main menu.
     */
    arrive(path, trail) {
      const to = paths.includes(path) ? path : 'main';
      const tr = Array.isArray(trail) && trailOk(trail, to, paths) ? trail.slice() : arrivalTrail(to, appList);
      if (to === S.path) { S.trail = tr; return []; }
      if (isTowerPath(to) && S.path === 'main') S.link = true;
      return open(to, tr).slice(1);
    },
    back,
    /** A button. info: { repeat: true } for the synthesized repeat of a held direction (a dialog ignores those; an app is handed { repeat } as its third argument). */
    press(action, info) {
      if (dialog.isOpen()) return dialogFx(dialog.press(action, info));          // an open dialog takes every press, whatever is under it
      if (S.path === 'record') return recordPress(action);
      if (isTowerPath(S.path)) return tower.press(S.path, action);
      { const a = apps.of(S.path); if (a) return fxOf(a.press(S.path, action, info && info.repeat ? REPEAT : FRESH)); }
      if (S.path === 'about') {
        const last = ABOUT_PAGES.length - 1;
        if (action === 'a' || action === 'down' || action === 'right' || action === 'r') { if (S.about.page < last) { S.about.page++; return []; } return action === 'a' ? back() : []; }
        if (action === 'up' || action === 'left' || action === 'l') { if (S.about.page > 0) S.about.page--; return []; }
        if (action === 'b') return back();
        return [];
      }
      const rs = rows();
      if (!rs.length) return action === 'b' ? back() : [];
      const cur = S.cursor[S.path];
      switch (action) {
        case 'up': S.flash = null; S.cursor[S.path] = (cur + rs.length - 1) % rs.length; return [];
        case 'down': S.flash = null; S.cursor[S.path] = (cur + 1) % rs.length; return [];
        case 'left': return change(rs[cur], -1);
        case 'right': return change(rs[cur], 1);
        case 'a': return activate(rs[cur]);
        case 'b': return back();
        default: return [];
      }
    },
    /** Which thing is under the logical point? { kind: 'row', index, zone } | { kind: 'page' } | null. zone 'prev' = the left arrow of a choice row. */
    hit(x, y) {
      if (dialog.isOpen()) return dialog.hit(x, y);
      if (S.path === 'record') return recordHit(x, y);
      if (isTowerPath(S.path)) return tower.hit(S.path, x, y);
      { const a = apps.of(S.path); if (a) return a.hit(S.path, x, y) || null; }
      if (S.path === 'about') { const g = GEOM.about; return x >= g.x - 6 && y >= g.y - 6 && x < g.x + g.w + 6 && y < g.y + g.h + 6 ? { kind: 'page' } : null; }
      const rs = rows(), win = S.path === 'main' ? mainWindow() : null, m = GEOM.menu, shown = win ? win.size : rs.length, pitch = menuPitch(shown);
      if (x < m.x - 6 || x >= m.x + m.w + 6 || y < m.y || y >= m.y + shown * pitch) return null;
      const index = (win ? win.off : 0) + Math.floor((y - m.y) / pitch);
      const row = rs[index];
      const zone = row && row.kind === 'choice' && x < m.x + m.w * 0.45 + 6 && x > m.x + 38 ? 'prev' : 'main';
      return { kind: 'row', index, zone };
    },
    pointer(ev) {
      if (!ev) return [];
      if (dialog.isOpen()) return dialogFx(dialog.pointer(ev));           // ... and every pointer event
      if (S.path === 'record') return recordPointer(ev);
      if (isTowerPath(S.path)) return tower.pointer(S.path, ev);
      { const a = apps.of(S.path); if (a) return fxOf(a.pointer(S.path, ev)); }
      if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); const act = (ev.steps || 0) > 0 ? 'down' : 'up'; let out = []; for (let i = 0; i < n; i++) out = out.concat(api.press(act)); return out; }
      const h = ev.x === undefined || ev.x === null ? null : api.hit(ev.x, ev.y);
      if (!h) return [];
      if (h.kind === 'page') return ev.kind === 'click' ? api.press('a') : [];
      if (ev.kind === 'move' || ev.kind === 'down') { if (S.cursor[S.path] !== h.index) S.flash = null; S.cursor[S.path] = h.index; return []; }
      if (ev.kind === 'click') {
        if (S.cursor[S.path] !== h.index) S.flash = null;
        S.cursor[S.path] = h.index;
        const row = rows()[h.index];
        if (row && row.kind === 'choice' && h.zone === 'prev') return change(row, -1);
        return api.press('a');
      }
      return [];
    },
    /** Rectangles the renderer and the tests use (logical pixels). */
    rects() {
      if (dialog.isOpen()) return dialog.rects();
      if (isTowerPath(S.path)) return tower.rects(S.path);
      { const a = apps.of(S.path); if (a) return a.rects(S.path) || []; }
      const all = rows(), win = S.path === 'main' ? mainWindow() : null, shown = win ? win.size : all.length, m = GEOM.menu, p = menuPitch(shown), from = win ? win.off : 0;
      return all.slice(from, from + shown).map((_, i) => ({ x: m.x - 4, y: m.y + i * p, w: m.w + 8, h: p }));
    },
  };
  return api;
}
