// pokemonarena/js/center_hub.js -- THE TRAINER CENTER in the hub: the app's state machine. A STUB: a real, tiny, working app that the Trainer Center work REPLACES (this file,
// center_screen.js and center_ctl.js; nothing else needs to change). pokemonarena/INAPP.md "The app interface" is the contract every line here follows.
// (center_boot.js, center_draw.js, center_map.js, center_net.js, avatar.js and center.html are the FIRST Trainer Center, a separate page: not this app, and not used by it.)
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness.
//
// SCREEN    center   a window that counts the seconds the player has been here (an app's tick(path) runs once a frame while its screen is open, so a room can move), the last answer a dialog
//                    gave this app (onDialog), and BACK. Its parent is PLAY ONLINE ('online'): that is where it is opened from.

import { createMenu } from './hub_menu.js';

const ID = 'center';
const PATHS = Object.freeze(['center']);
const parent = () => 'online';
export const CGEOM = Object.freeze({ panel: Object.freeze({ x: 148, y: 12, w: 80, h: 80 }) });
export const TICKS_PER_SECOND = 60;                 // (the hub's clock is 59.7275 Hz: near enough for a count on a placeholder)

export function createCenterHub(ctx) {
  const menu = createMenu();
  const S = { ticks: 0, answer: null };
  const rows = () => [{ id: 'back', kind: 'button', label: 'BACK' }];
  const act = (r) => (r && (r.kind === 'back' || r.kind === 'choose') ? ctx.back() : []);
  return {
    id: ID, paths: PATHS, parent,
    enter() { S.ticks = 0; menu.setCursor(0); },
    leave() {},
    press: (_path, action) => act(menu.press(action, rows())),
    hit: (_path, x, y) => menu.hit(x, y, rows()),
    pointer: (_path, ev) => act(menu.pointer(ev, rows())),
    rects: () => menu.rects(rows()),
    tick() { S.ticks++; },
    onData: () => [],
    /** A dialog opened for this app (ctx.dialog.open, or hub.dialog.open({ app: 'center', ... }) from the ctl) was answered. */
    onDialog(id, value) { S.answer = { id: String(id), value }; return []; },
    wantsText: () => false,
    type: () => [],
    view(path, base) {
      const secs = Math.floor(S.ticks / TICKS_PER_SECOND), a = S.answer;
      return { ...base, screen: path, app: ID, mascot: null, menu: menu.view(rows()), msg: ['The Trainer Center is moving', 'into this picture.'],
        center: { title: 'THE CENTER', seconds: secs, lines: ['HERE FOR ' + secs + ' s', a ? 'ANSWER: ' + String(a.value).toUpperCase() : ''] } };
    },
    speak(v) { return 'Trainer Center. ' + (v.msg || []).join(' ') + ' You have been here ' + v.center.seconds + ' seconds. Back.'; },
    title: () => 'Pokemon Arena - Trainer Center',
    state: () => ({ ticks: S.ticks, answer: S.answer ? { ...S.answer } : null }),
  };
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent, create: createCenterHub });
