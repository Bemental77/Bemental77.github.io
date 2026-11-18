// pokemonarena/js/battle_ask.js -- THE QUESTIONS OF A BATTLE AGAINST THE CPU, IN THE PICTURE (pokemonarena/INAPP.md "BATTLE: as built", stage 2).
//
// OPEN TO BATTLES reaches a player in a battle against the computer too: "<NAME> wants to battle you" and the first-time disclosure are asked over the battle, drawn from the ROM (the
// ROM message box, the ROM window, the ROM cursor) by the hub's own dialog layer and renderer. There is no DOM dialog and no header button on the battle page any more: the switch is a row of the
// pause menu (OPEN TO BATTLES: ON / OFF, scene.js opts.open), and the questions are the picture's.
//
// It is the hub's presence service (hub_presence.js createHubPresence), run on this page with a dialog layer of its own in place of the hub model's: every guarantee of the hub's questions holds
// here because it is the same code (NO is the default and the last option, so B is NO; YES listens only after DIALOG_ARM_TICKS; the repeats of a held direction never move the highlight; one
// question at a time and a second asker is told busy; a question nobody answers is a NO after 25 s; a question that arrives while the Controls dialog or the Sound panel is open WAITS until it
// closes, and listens 0.6 s after it appears; YES writes the accept token, then leaves). What this file adds is the page's half: the layer, the clock that arms it, the buttons and the pointer it
// takes ahead of the battle, and the pixels over the battle's frame. battle_boot.js pauses the battle while a question is in the picture (setPaused('presence:ask')).
//
//   const ask = createBattleAsk({ win, doc, pack, navigate, measure, msgPx, panelOpen, changed });
//   ask.press(action, { repeat })  ask.pointer({ kind, x, y, steps })  ask.tick()   // -> true when the question took it (it takes everything while it is in the picture)
//   ask.view()  ask.speak()  ask.isOpen()  ask.hit(x, y)  ask.rects()  ask.label()  ask.toggle(done)  ask.panels()  ask.state()  ask.svc  ask.layer
//   const paint = createAskPainter(ui, createHubScreen);  paint(battleRgba, ask.view()) -> rgba (the battle's frame with the question over it)
//
// NOT MOUNTED IN A TOWER FIGHT (battle_boot.js returns before it): accepting would leave the page mid-fight, which the Tower counts as a loss. A challenge reaches a Tower climber in the hub, between floors.

import { createDialogLayer, speakDialog } from './hub_dialog.js';
import { createHubPresence } from './hub_presence.js';

/** The path the presence service sees as "the open screen" (it is not a hub path: a battle accepted from here does not come back to it). */
export const ASK_PATH = 'battle';
/** The pause menu's row. */
export const OPEN_ROW = 'OPEN TO BATTLES';
export const openRowLabel = (on) => OPEN_ROW + ': ' + (on ? 'ON' : 'OFF');

/**
 * env: { win, doc, pack, navigate(url) (where YES leaves for), measure(font, s) -> px (the ROM font), msgPx (a message line's width), panelOpen() -> boolean (the Controls dialog or the Sound panel
 *        is up: a question waits), changed() (something the picture shows changed: draw again, pause or un-pause), loadBoot() -> Promise<presence_boot.js> (tests; default the dynamic import) }
 */
export function createBattleAsk(env) {
  const safe = (f, d) => { try { return f(); } catch (_e) { return d; } };
  const changed = () => { if (typeof env.changed === 'function') safe(() => env.changed()); };
  const layer = createDialogLayer({ measure: env.measure });
  // the presence service talks to "the hub model": here that is this layer and a path that is not the Trainer Center's (so YES writes no arena.back), and NO session storage of its own (it would
  // clear arena.back: on the battle page that key is the hub's, read only: INAPP.md "Contract 6"). presence_boot.js keeps its own storage for the accept token.
  const model = { dialog: layer, path: () => ASK_PATH };
  const svc = createHubPresence({
    win: env.win, doc: env.doc || null, model, pack: env.pack, navigate: env.navigate, hook: {}, session: null, button: null,
    measure: env.measure, msgPx: env.msgPx, panelOpen: env.panelOpen, redraw: changed, focusHome: () => {},
    ...(typeof env.loadBoot === 'function' ? { loadBoot: env.loadBoot } : {}),
  });
  svc.onChange(changed);
  /** The layer's answers go to the service (YES / NO / a notice read), then the page draws again. */
  function run(effects) { for (const e of effects || []) if (e && e.type === 'dialog') safe(() => svc.answer(e)); changed(); }
  const isOpen = () => layer.isOpen();

  return {
    svc, layer, isOpen,
    /** A button while a question is in the picture: -> true (it took the press: nothing else hears it). info: { repeat } (the synthesized repeat of a held direction moves nothing). */
    press(action, info) { if (!isOpen()) return false; run(layer.press(action, info || { repeat: false })); return true; },
    /** The pointer: { kind: 'move' | 'click', x, y } (logical 240x160) or { kind: 'wheel', steps }. -> true when a question is in the picture. */
    pointer(ev) { if (!isOpen()) return false; run(layer.pointer(ev)); return true; },
    /** One frame of the GBA clock (59.7275 Hz) while the tab is visible: the arm delay counts. */
    tick() { if (isOpen()) { const fx = layer.tick(); if (fx.length) run(fx); } },
    hit: (x, y) => layer.hit(x, y),
    rects: () => layer.rects(),
    /** What the renderer draws (hub_dialog.js view), or null. */
    view: () => layer.view(),
    /** The screen reader's words for the question in the picture ('' when there is none). */
    speak: () => speakDialog(layer.view()),
    /** The pause menu's row while the switch can be used: 'OPEN TO BATTLES: ON' / 'OPEN TO BATTLES: OFF', or null (presence_boot.js is still loading, or could not load: no row). */
    label() { const st = svc.status(); return st === 'loading' || st === 'unavailable' ? null : openRowLabel(svc.isOn()); },
    /**
     * The row was chosen: switch it. The first switch-on asks the disclosure IN THE PICTURE first (nothing is published before YES). done() is called once, as soon as the switch shows its new
     * state (at once, or when the question has been answered), so the pause menu can come back with the row's new label.
     */
    toggle(done) {
      let called = false, off = null;
      const fire = () => { if (called) return; called = true; if (off) off(); if (typeof done === 'function') safe(() => done()); };
      const before = svc.isOn();
      off = svc.onChange(() => { if (svc.isOn() !== before) fire(); });          // (the switch flipped: at once, or after the disclosure's YES)
      Promise.resolve(svc.toggle()).then(fire, fire);                            // (it is over: the disclosure's NO, a start that failed)
      return true;
    },
    /** A DOM panel (Controls, Sound) opened or closed: a question comes out of the picture while one is up, and goes (back) in, listening 0.6 s later, when the last has closed. */
    panels: () => svc.panels(),
    /** For tests and the hook: the service's state, the layer's, and the question shown. */
    state: () => ({ ...svc.state(), dialog: layer.state(), current: layer.current() }),
    dispose() { safe(() => svc.dispose()); },
  };
}

/**
 * The question over the battle's frame, drawn by the hub's shell renderer (hub_screen.js: the ROM message box, the ROM window and the cursor; what the font cannot draw is a "?").
 * createHubScreen: hub_screen.js's (passed in, so this file stays light for the page's first paint). -> paint(rgba of the battle frame, dialog view) -> rgba of the frame with the question over it.
 */
export function createAskPainter(ui, createHubScreen) {
  let under = null;
  const screen = createHubScreen(ui, { appScreens: { [ASK_PATH]: () => ({ render(f) { if (under) f.rgba.set(under); } }) } });
  return (rgba, dialog) => {
    if (!dialog) return rgba;
    under = rgba;
    try { return screen.render({ app: ASK_PATH, screen: ASK_PATH, env: 0, tick: 0, dialog }).rgba; } finally { under = null; }
  };
}
