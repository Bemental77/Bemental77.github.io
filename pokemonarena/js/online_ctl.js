// pokemonarena/js/online_ctl.js -- PLAY ONLINE's side effects: the only file of the app that navigates, stores, talks to a network or sets a timer. A STUB: replaced, with online_hub.js and
// online_screen.js, by the online work. boot.js loads this file the first time the 'online' screen is entered or an effect with `app: 'online'` appears (pokemonarena/INAPP.md "The app interface").
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose() }.  What this one does: BATTLE ONLINE leaves for the online battle page (the page it is today).

export const ONLINE_BATTLE_URL = '/pokemonarena/battle.html?online=1';

export function createCtl(env) {
  const log = [];                                   // what the hub asked of this ctl, in order (the tests read it; a real ctl needs none)
  return {
    log,
    enter(path) { log.push('enter:' + path); },
    leave(path) { log.push('leave:' + path); },
    effect(eff) {
      log.push('effect:' + eff.type);
      if (eff.type === 'open-battle') env.navigate(ONLINE_BATTLE_URL);
    },
    dispose() { log.push('dispose'); },
  };
}
