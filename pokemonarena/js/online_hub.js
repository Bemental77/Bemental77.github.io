// pokemonarena/js/online_hub.js -- PLAY ONLINE in the hub: the app's state machine. A STUB: a real, tiny, working app that the online work REPLACES (this file, online_screen.js and
// online_ctl.js; nothing else needs to change). pokemonarena/INAPP.md "The app interface" is the contract every line here follows.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. It returns EFFECTS; the ones that carry `app: 'online'` are carried out by online_ctl.js.
//
// SCREEN    online   TRAINER CENTER (the Center app's screen) / BATTLE ONLINE (the online battle page, as it is today) / BACK
// EFFECTS   { app: 'online', type: 'open-battle' }   BATTLE ONLINE was chosen: online_ctl.js leaves for the online battle page
//           { type: 'screen', path }                 (the hub's) from ctx.go / ctx.back

import { createMenu } from './hub_menu.js';

const ID = 'online';
const PATHS = Object.freeze(['online']);
const parent = () => 'main';
export const OGEOM = Object.freeze({ panel: Object.freeze({ x: 148, y: 12, w: 80, h: 80 }) });          // the window that names the screen (the Tower's status window stands in the same place)

const HELP = Object.freeze({
  center: ['Walk around with everyone', 'who is open to battles.'],
  battle: ['Battle a friend with a room code,', 'or find someone open to battle.'],
  back: ['Back to the main menu.', ''],
});

export function createOnlineHub(ctx) {
  const menu = createMenu();
  const rows = () => [
    { id: 'center', kind: 'item', label: 'TRAINER CENTER' },
    { id: 'battle', kind: 'item', label: 'BATTLE ONLINE' },
    { id: 'back', kind: 'button', label: 'BACK' },
  ];
  function act(r) {
    if (!r) return [];
    if (r.kind === 'back') return ctx.back();
    if (r.kind !== 'choose') return [];
    if (r.row.id === 'center') return ctx.go('center');
    if (r.row.id === 'battle') return [{ app: ID, type: 'open-battle' }];
    return ctx.back();
  }
  return {
    id: ID, paths: PATHS, parent,
    enter() { menu.setCursor(0); },
    leave() {},
    press: (_path, action) => act(menu.press(action, rows())),
    hit: (_path, x, y) => menu.hit(x, y, rows()),
    pointer: (_path, ev) => act(menu.pointer(ev, rows())),
    rects: () => menu.rects(rows()),
    tick() {},
    onData: () => [],
    wantsText: () => false,
    type: () => [],
    view(path, base) {
      const rs = rows(), m = menu.view(rs), row = rs[m.cursor];
      return { ...base, screen: path, app: ID, mascot: null, menu: m, msg: HELP[row.id].slice(), online: { title: 'PLAY ONLINE', lines: ['FRIENDS', 'ANYONE OPEN', 'THE CENTER'] } };
    },
    speak(v) { const r = v.menu.rows[v.menu.cursor]; return 'Play online. ' + (r ? r.label + '. ' : '') + (v.msg || []).join(' '); },
    title: () => 'Pokemon Arena - Play Online',
    state: () => ({ cursor: menu.cursor() }),
  };
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent, create: createOnlineHub });
