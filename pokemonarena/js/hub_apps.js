// pokemonarena/js/hub_apps.js -- the HUB's APP REGISTRY: which apps the hub hosts, and the small host that hub_model.js delegates through.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. An APP is a family of hub screens that is NOT written in hub_model.js: three files of its own,
//
//   js/<id>_hub.js      export const APP = { id, paths, parent(path), create(ctx) }     the pure state machine (listed below)
//   js/<id>_screen.js   export function createScreen(ui, h) -> { render(f, view) }      the pure renderer (listed in hub_app_screens.js)
//   js/<id>_ctl.js      export function createCtl(env) -> { effect(eff), enter?, leave?, dispose? }   the side effects (boot.js loads it by this name the first time it is needed)
//
// and hub_model.js hands the app EVERY press / hit / pointer / rects / tick / view / enter / leave while one of its paths is the open screen, exactly as it does for the Tower.
// pokemonarena/INAPP.md ("The app interface") is the contract; this file is where an app is REGISTERED: import its APP and add it to APPS. Nothing else in the shell names an app.
//
// THE RULES checkRegistry ENFORCES (a broken registry throws when the hub model is made, so every test sees it):
//   * id: two to sixteen lower-case letters or digits, starting with a letter; unique; not a hub screen's name
//   * paths: at least one; every path IS the id or starts with "<id>-" (so two apps can never claim one path, and none can claim a hub or Tower path); unique
//   * parent(path): a pure function of the path alone (the browser history is seeded from it before any state exists). It names 'main' or any OTHER hub path, and following it from any of the
//     app's paths reaches 'main' (no loop)
// AND WHAT checkApp ENFORCES of the object create(ctx) returns: its id and paths are the descriptor's, and every method of APP_METHODS is a function.

import { APP as ONLINE } from './online_hub.js';
import { APP as CENTER } from './center_hub.js';
import { APP as BUILDER } from './builder_hub.js';

/** The apps the hub hosts, in no particular order (the main menu decides what leads where). */
export const APPS = Object.freeze([ONLINE, CENTER, BUILDER]);

/** Every method the hub calls on an app's model (onDialog is optional and so not listed). */
export const APP_METHODS = Object.freeze(['parent', 'enter', 'leave', 'press', 'hit', 'pointer', 'rects', 'tick', 'view', 'onData', 'wantsText', 'type', 'speak', 'title', 'state']);

const ID_RE = /^[a-z][a-z0-9]{1,15}$/;
const PATH_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Every path of these apps, in registry order. */
export const pathsOf = (list) => list.flatMap((a) => a.paths);
export const APP_PATHS = Object.freeze(pathsOf(APPS));
/** The descriptor of the app that owns `path`, or null. */
export function appOfPath(path, list = APPS) { for (const a of list) if (a.paths.includes(path)) return a; return null; }

/**
 * What is wrong with a list of app descriptors, as sentences ([] = nothing). `hubPaths` = the paths the hub and the Tower own (an app may name them as a parent, never claim them);
 * `parentOf(path)` = where B goes from one of THOSE (so a chain that leaves the app can still be followed to the main menu).
 */
export function checkRegistry(list, hubPaths = ['main'], parentOf = () => 'main') {
  const bad = [], ids = new Set(), seen = new Set(hubPaths);
  if (!Array.isArray(list)) return ['the registry is not a list'];
  for (const a of list) {
    const who = 'app ' + JSON.stringify(a && a.id);
    if (!a || typeof a !== 'object') { bad.push('an entry is not an app descriptor'); continue; }
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) { bad.push(who + ': the id must be 2..16 lower-case letters or digits'); continue; }
    if (ids.has(a.id)) bad.push(who + ': the id is used twice');
    ids.add(a.id);
    if (hubPaths.some((p) => p === a.id || p.startsWith(a.id + '-'))) bad.push(who + ': the id is the name of a hub screen');
    if (typeof a.create !== 'function') bad.push(who + ': create(ctx) is missing');
    if (typeof a.parent !== 'function') bad.push(who + ': parent(path) is missing');
    if (!Array.isArray(a.paths) || !a.paths.length) { bad.push(who + ': it has no path'); continue; }
    for (const p of a.paths) {
      if (typeof p !== 'string' || !PATH_RE.test(p) || !(p === a.id || p.startsWith(a.id + '-'))) bad.push(who + ': the path ' + JSON.stringify(p) + ' is not "' + a.id + '" or "' + a.id + '-..."');
      else if (seen.has(p)) bad.push(who + ': the path ' + JSON.stringify(p) + ' is claimed twice');
      seen.add(p);
    }
  }
  if (bad.length) return bad;
  // every path leads back to the main menu
  const up = (p) => { const a = appOfPath(p, list); return a ? a.parent(p) : parentOf(p); };
  for (const a of list) for (const p of a.paths) {
    let q = p, n = 0;
    for (; q !== 'main' && n < 16; n++) {
      const next = up(q);
      if (typeof next !== 'string' || !seen.has(next) || next === q) { bad.push('app ' + JSON.stringify(a.id) + ': parent(' + JSON.stringify(q) + ') is ' + JSON.stringify(next) + ', which is not another hub path'); q = null; break; }
      q = next;
    }
    if (q !== null && q !== 'main') bad.push('app ' + JSON.stringify(a.id) + ': the parents of ' + JSON.stringify(p) + ' never reach the main menu');
  }
  return bad;
}

/** What is wrong with the model `app` that `desc.create(ctx)` returned ([] = nothing). */
export function checkApp(desc, app) {
  const bad = [];
  if (!app || typeof app !== 'object') return ['create(ctx) did not return an object'];
  if (app.id !== desc.id) bad.push('its id is ' + JSON.stringify(app.id) + ', the registry says ' + JSON.stringify(desc.id));
  if (!Array.isArray(app.paths) || app.paths.length !== desc.paths.length || app.paths.some((p, i) => p !== desc.paths[i])) bad.push('its paths are not the registry\'s');
  for (const m of APP_METHODS) if (typeof app[m] !== 'function') bad.push(m + '() is missing');
  if (app.onDialog !== undefined && typeof app.onDialog !== 'function') bad.push('onDialog is not a function');
  return bad;
}

/**
 * Make every app of `list` and answer the hub model's questions about them. makeCtx(desc) -> the ctx that app's factory gets. Throws an Error that names the app when one is malformed.
 *   of(path)   the model of the app that owns the path, or null          byId(id)   the model of that app, or null
 *   handles()  { id: model, ... }                                       ids        the ids, in registry order
 *   onData()   every app's onData(), concatenated                       state()    { id: app.state(), ... }
 */
export function createAppHost(list, makeCtx) {
  const models = new Map();
  for (const desc of list) {
    const app = desc.create(makeCtx(desc));
    const bad = checkApp(desc, app);
    if (bad.length) throw new Error('hub app "' + desc.id + '" is malformed: ' + bad.join('; '));
    models.set(desc.id, app);
  }
  const fx = (r) => (Array.isArray(r) ? r : []);
  return {
    ids: list.map((a) => a.id),
    of(path) { const d = appOfPath(path, list); return d ? models.get(d.id) : null; },
    byId: (id) => models.get(id) || null,
    handles: () => Object.fromEntries(models),
    onData() { let out = []; for (const a of models.values()) out = out.concat(fx(a.onData())); return out; },
    state() { const o = {}; for (const [id, a] of models) o[id] = a.state(); return o; },
  };
}
