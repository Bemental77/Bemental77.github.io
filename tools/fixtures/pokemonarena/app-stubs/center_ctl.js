// pokemonarena/js/center_ctl.js -- THE TRAINER CENTER's side effects: the only file of the app that navigates, stores, talks to a network or sets a timer. A STUB: replaced, with center_hub.js
// and center_screen.js, by the Trainer Center work. boot.js loads this file the first time the 'center' screen is entered or an effect with `app: 'center'` appears
// (pokemonarena/INAPP.md "The app interface").
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose() }.  This one remembers what it was asked (a dialog's answer arrives here as an effect: { type: 'dialog', id, value,
// app: 'center' }) and marks an answer with the ROM's "success" sound: env.sound is how a ctl plays a sound effect (env.sound.sfx(key)) or says which music the hub plays (env.sound.music(key)).

export function createCtl(env) {
  const log = [];                                   // what the hub asked of this ctl, in order (the tests read it; a real ctl needs none)
  return {
    log,
    enter(path) { log.push('enter:' + path); },
    leave(path) { log.push('leave:' + path); },
    effect(eff) {
      log.push('effect:' + eff.type + (eff.type === 'dialog' ? ':' + eff.id + ':' + eff.value : ''));
      if (eff.type === 'dialog' && env && env.sound) env.sound.sfx('se_success');
    },
    dispose() { log.push('dispose'); },
  };
}
