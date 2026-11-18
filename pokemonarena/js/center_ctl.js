// pokemonarena/js/center_ctl.js -- THE TRAINER CENTER's side effects: the only file of the app that navigates, stores, talks to a network or sets a timer. A STUB: replaced, with center_hub.js
// and center_screen.js, by the Trainer Center work. boot.js loads this file the first time the 'center' screen is entered or an effect with `app: 'center'` appears
// (pokemonarena/INAPP.md "The app interface").
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose() }.  This one does nothing but remember what it was asked (a dialog's answer arrives here as an effect: { type: 'dialog', id, value, app: 'center' }).

export function createCtl(_env) {
  const log = [];                                   // what the hub asked of this ctl, in order (the tests read it; a real ctl needs none)
  return {
    log,
    enter(path) { log.push('enter:' + path); },
    leave(path) { log.push('leave:' + path); },
    effect(eff) { log.push('effect:' + eff.type + (eff.type === 'dialog' ? ':' + eff.id + ':' + eff.value : '')); },
    dispose() { log.push('dispose'); },
  };
}
