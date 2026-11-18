// pokemonarena/js/builder_hub.js -- THE TEAM BUILDER in the hub: the app's state machine. A STUB: a real, tiny, working app that the Team Builder work REPLACES (this file, builder_screen.js
// and builder_ctl.js; nothing else needs to change). pokemonarena/INAPP.md "The app interface" is the contract every line here follows.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. It returns EFFECTS; the ones that carry `app: 'builder'` are carried out by builder_ctl.js.
//
// SCREEN    builder   NAME (opens a TEXT ENTRY, charset 'name', and shows what was typed) / TEAM CODE (a text entry for an ARENA1 code, up to 1024 characters: type it, or paste it) /
//                     OPEN TEAM BUILDER (the team builder page, as it is today) / BACK
// EFFECTS   { app: 'builder', type: 'named', value }        a name was entered (builder_ctl.js keeps it for this tab)
//           { app: 'builder', type: 'coded', length }       a team code was entered
//           { app: 'builder', type: 'open-editor' }         OPEN TEAM BUILDER was chosen: builder_ctl.js leaves for the team builder page
//           { type: 'screen', path }                        (the hub's) from ctx.back

import { createMenu } from './hub_menu.js';
import { createEntrySlot } from './textentry.js';

const ID = 'builder';
const PATHS = Object.freeze(['builder']);
const parent = () => 'main';
export const BGEOM = Object.freeze({ panel: Object.freeze({ x: 148, y: 12, w: 80, h: 80 }) });
export const NAME_MAX = 10, CODE_MAX = 1024;

const HELP = Object.freeze({
  name: ['Type a name: the picture has', 'its own keyboard. A real one works.'],
  code: ['Type or paste a team code', '(it starts with ARENA1).'],
  editor: ['Open the team builder: profiles,', 'teams, natures, EVs, items, moves.'],
  back: ['Back to the main menu.', ''],
});

export function createBuilderHub(ctx) {
  const menu = createMenu();
  const entry = createEntrySlot();
  const S = { name: '', code: '' };
  const rows = () => [
    { id: 'name', kind: 'item', label: 'NAME: ' + (S.name || '-') },
    { id: 'code', kind: 'item', label: 'TEAM CODE: ' + S.code.length },
    { id: 'editor', kind: 'item', label: 'OPEN TEAM BUILDER' },
    { id: 'back', kind: 'button', label: 'BACK' },
  ];
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return ctx.back();
    if (r.kind !== 'choose') return [];
    switch (r.row.id) {
      case 'name': entry.open({ id: 'name', title: 'YOUR NAME?', value: S.name, max: NAME_MAX, charset: 'name' }, (res) => { if (!res.ok) return []; S.name = res.value.trim(); return [{ app: ID, type: 'named', value: S.name }]; }); return [];
      case 'code': entry.open({ id: 'code', title: 'TEAM CODE?', value: S.code, max: CODE_MAX, charset: 'teamcode', allowEmpty: true }, (res) => { if (!res.ok) return []; S.code = res.value; return [{ app: ID, type: 'coded', length: S.code.length }]; }); return [];
      case 'editor': return [{ app: ID, type: 'open-editor' }];
      default: return ctx.back();
    }
  }
  return {
    id: ID, paths: PATHS, parent,
    enter() { menu.setCursor(0); },
    leave() { entry.close(); },                                         // a screen that closes takes its text entry with it (the browser's Back button can close it under the player)
    press(_path, action) { const fx = entry.press(action); return fx || act(menu.press(action, rows())); },
    hit(_path, x, y) { return entry.isOpen() ? entry.hit(x, y) : menu.hit(x, y, rows()); },
    pointer(_path, ev) { const fx = entry.pointer(ev); return fx || act(menu.pointer(ev, rows())); },
    rects: () => (entry.isOpen() ? entry.rects() : menu.rects(rows())),
    tick() {},
    onData: () => [],
    wantsText: () => entry.isOpen(),
    type: (_path, input) => entry.type(input) || [],
    view(path, base) {
      const rs = rows(), m = menu.view(rs), row = rs[m.cursor];
      return { ...base, screen: path, app: ID, mascot: null, menu: m, msg: HELP[row.id].slice(), builder: { title: 'TEAM BUILDER', lines: [S.name ? 'HELLO, ' + S.name : 'NO NAME YET', S.code ? 'CODE: ' + S.code.length + ' CHARS' : 'NO CODE YET'] }, entry: entry.view() };
    },
    speak(v) { const r = v.menu.rows[v.menu.cursor]; return 'Team Builder. ' + (r ? r.label + '. ' : '') + (v.msg || []).join(' '); },
    title: () => 'Pokemon Arena - Team Builder',
    state: () => ({ cursor: menu.cursor(), name: S.name, code: S.code, entry: entry.isOpen() ? entry.entry().state() : null }),
    /** (the ctl's) Put back the name this tab entered before. */
    setName(name) { S.name = typeof name === 'string' ? name.slice(0, NAME_MAX) : ''; },
  };
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent, create: createBuilderHub });
