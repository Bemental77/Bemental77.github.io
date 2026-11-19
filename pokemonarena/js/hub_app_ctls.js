// pokemonarena/js/hub_app_ctls.js -- the CTLS of the hub's apps: how boot.js loads the side-effect half of each app (js/<id>_ctl.js: createCtl(env) -> { effect, enter?, leave?, dispose? }).
//
// Each entry is a function that imports the file WHEN CALLED: boot.js calls it the first time one of the app's screens is entered or one of its effects appears, so the hub's first paint loads no
// ctl at all. The file names are spelled out (not built from the id) so that every tool that follows imports -- the deploy check in tools/pokemonarena_page_test.mjs, a bundler -- can see them.
// The models are listed in hub_apps.js and the renderers in hub_app_screens.js; a test pins that the three lists name the same apps. To register an app's ctl: add its line.

/** { app id: () => Promise<module with createCtl> } */
export const APP_CTLS = Object.freeze({
  online: () => import('./online_ctl.js'),
  center: () => import('./center_ctl.js'),
  builder: () => import('./builder_ctl.js'),
  trainer: () => import('./trainer_ctl.js'),
});
