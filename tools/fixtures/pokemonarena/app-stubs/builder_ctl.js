// pokemonarena/js/builder_ctl.js -- THE TEAM BUILDER's side effects: the only file of the app that navigates, stores, talks to a network or sets a timer. A STUB: replaced, with builder_hub.js
// and builder_screen.js, by the Team Builder work. boot.js loads this file the first time the 'builder' screen is entered or an effect with `app: 'builder'` appears
// (pokemonarena/INAPP.md "The app interface").
//
// createCtl(env) -> { effect(eff), enter(path), leave(path), dispose() }.  What this one does: the name typed on the NAME row is kept for this tab (session storage) and put back into the model
// when the screen opens; OPEN TEAM BUILDER leaves for the team builder page (the page it is today).

export const EDITOR_URL = '/pokemonarena/editor.html';
export const NAME_KEY = 'arena.builder.stubname';

export function createCtl(env) {
  const log = [];                                   // what the hub asked of this ctl, in order (the tests read it; a real ctl needs none)
  const read = () => { try { return env.session ? env.session.getItem(NAME_KEY) : null; } catch (_e) { return null; } };
  const write = (v) => { try { if (env.session) env.session.setItem(NAME_KEY, String(v)); } catch (_e) { /* storage is a convenience here */ } };
  return {
    log,
    enter(path) {
      log.push('enter:' + path);
      const kept = read();
      if (typeof kept === 'string' && kept && !env.app.state().name) { env.app.setName(kept); env.redraw(); }
    },
    leave(path) { log.push('leave:' + path); },
    effect(eff) {
      log.push('effect:' + eff.type);
      if (eff.type === 'named') write(eff.value);
      else if (eff.type === 'open-editor') env.navigate(EDITOR_URL);
    },
    dispose() { log.push('dispose'); },
  };
}
