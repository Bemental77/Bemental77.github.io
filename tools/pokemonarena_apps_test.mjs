// tools/pokemonarena_apps_test.mjs -- the HUB's APP HOST: the registry and the delegation (hub_apps.js, hub_model.js), the dialog layer (hub_dialog.js), the text entry (textentry.js,
// textentry_screen.js), the menu helper (hub_menu.js), the three stub apps (online / center / builder: _hub.js, _screen.js, _ctl.js) and the page glue that carries it all out (boot.js).
// pokemonarena/INAPP.md "The app interface" is the contract these cases pin.
//
//   node tools/pokemonarena_apps_test.mjs               Node units and their source MUTANTS, then the browser sessions (starts PORT=8097 node tools/devserver.mjs)
//   node tools/pokemonarena_apps_test.mjs --unit        Node only (units + mutants)
//   node tools/pokemonarena_apps_test.mjs --no-mutants  skip the mutants (a quick look)
//   node tools/pokemonarena_apps_test.mjs keys touch    only the named browser sessions (keys touch pad broken control)
//   ARENA_PORT=8097 ARENA_CDP=9291 ARENA_OUT=<dir> ARENA_ROM=<gba> ARENA_BASE=<running server>
//
// NODE UNITS (each family is a function of the module tree it is given, so the same checks run on a temp copy with ONE defect: every mutant must trip a NAMED check)
//   A  the registry and the delegation: an app receives exactly its own paths' press / hit / pointer / rects / tick / view / enter / leave / type; the hub's own screens and the Tower are
//      untouched by it; parents, the trail the browser history is seeded with, the ctx an app is given, and every rule the registry enforces
//   D  the dialog layer: pages, the choice, B = the last option, the timeout, over an app, a second open (queued), every refusal, pointer and wheel, the geometry
//   E  the text entry model: every charset (and that 'name' IS profile.js textIssue's rule, one character at a time), the length cap, the caret, shift, the d-pad's wrap, the pointer,
//      type / paste, Backspace on an empty field, the slot an app embeds one through
//   S  the renderers, from the ROM: every entry view is an opaque 240x160 frame, every key label is inside its cell, the field never overflows, a 1024-character team code is usable,
//      the dialog and the entry are drawn over whatever is open, an odd-width chip has clean colours
//   M  hub_menu.js      X  the three stubs and their ctls (against a fake page)
//   I  the interface as it is WRITTEN DOWN: pokemonarena/INAPP.md "The app interface" names every method of the app contract, every key of the ctx an app is given, every key of the env
//      a ctl is given and every drawing helper a renderer is given, and the code has exactly those (later teams read that section, not this suite)
// BROWSER (tools/headless_cdp.mjs: one headless, muted Chrome at a time, throwaway profile, bare CDP; the AudioContext and the Gamepad are TEST DOUBLES)
//   keys     desktop, keyboard and mouse: the new main-menu rows reach the stub apps and Back / B / the browser's Back return; a deep link; the canvas equals Node's render;
//            A REAL KEYBOARD types into a text entry without acting as game buttons (Z X W A S D M P Enter Backspace), the caret keys, Escape, a paste of 1024 characters, the Controls
//            dialog keeps the keys to itself; the dialog layer over an app screen answers by key and by click, and times out
//   touch    a phone: taps on rows, on the picture's keys and chips, on a dialog's option; the on-screen pad
//   pad      the synthetic controller alone: rows, the key cursor, A types, START = OK, SELECT = abc, B deletes and then cancels
//   broken   a copy of the game whose builder_ctl.js exports no createCtl: the screen still opens, a note in the picture says it could not load, and the hub goes on working
//   control  a copy of the game whose keyboard capture is switched off: the "typing does not press buttons" check FAILS there (so it can fail)
// WHAT IS TIED TO THE THREE PLACEHOLDER APPS (online / center / builder: the only apps there are today): family X, and the rows the browser sessions press. Families A D E M I S use this
// suite's own apps (fakeApp, typerApp) and hand-made views, so they hold whatever a product app becomes. When an app replaces its placeholder, its part of X and the browser cases that
// press its rows are that app's to rewrite; what those cases proved about the SHELL (a real keyboard types, the paste, a dialog over an app screen, a ctl that cannot load) must be kept by
// pointing them at the new screens. pokemonarena/INAPP.md "When you replace a placeholder" lists every such place in every suite.
// Screenshots go to ARENA_OUT and are meant to be opened. Nothing ROM-derived is written anywhere else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const { root, J, sleep, key, errsOf, tapLogical, clickLogical, logicalToPage, moveMouse, rightClick, padPress, tapSel, clickSel, AUDIO_DOUBLE, PAD_DOUBLE, addInit, BASE, CDP0, loadPct } = L;
const SRC = path.join(root, 'pokemonarena', 'js');
const ARGS = process.argv.slice(2);
const UNIT_ONLY = ARGS.includes('--unit') || process.env.ARENA_SKIP_BROWSER === '1';
const WANT_MUTANTS = !ARGS.includes('--no-mutants');
const GROUPS = ARGS.filter((a) => !a.startsWith('--'));
const wants = (g) => !GROUPS.length || GROUPS.includes(g);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-apps-shots');
const C = L.makeCounter('apps');
const ok = C.ok;
const rom = L.readRom();
console.log('pokemonarena apps test; ROM', L.ROM_PATH, rom.length, 'B; node', process.version);

/* ================================================================================================ the module tree under test */

const FILES = { HM: 'hub_model.js', HA: 'hub_apps.js', AS: 'hub_app_screens.js', AC: 'hub_app_ctls.js', HD: 'hub_dialog.js', TE: 'textentry.js', TS: 'textentry_screen.js', MN: 'hub_menu.js', HS: 'hub_screen.js', BU: 'battle_ui.js',
  ON: 'online_hub.js', CE: 'center_hub.js', BL: 'builder_hub.js', ONC: 'online_ctl.js', CEC: 'center_ctl.js', BLC: 'builder_ctl.js' };
async function loadStack(dir) {
  const K = { dir };
  await Promise.all(Object.entries(FILES).map(async ([k, f]) => { K[k] = await import(pathToFileURL(path.join(dir, f)).href); }));
  let made = null;
  // the ROM renderer of THIS tree (made once, only for the families that draw)
  K.draw = () => { if (!made) { const ui = K.BU.createBattleUi(rom); made = { ui, screen: K.HS.createHubScreen(ui) }; } return made; };
  K.model = (o) => { const d = K.draw(); return K.HM.createHubModel({ mascot: 25, env: 0, measure: d.screen.measure, msgPx: d.screen.msgPx, measureFont: d.screen.measureFont, ...(o || {}) }); };
  return K;
}
// the real profile rules and team codes (never mutated): what the 'name' and 'teamcode' charsets are measured against
const P = await L.mod('profile.js'), TC = await L.mod('teamcode.js'), T = await L.mod('tables.js'), ST = await L.mod('store.js'), RU = await L.mod('rules.js'), HDATA = await L.mod('hub_data.js');
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
async function realTeamCode() {
  const store = await ST.openStore({ adapter: ST.createMemoryAdapter({ name: 'appstest-1', durable: true }), channel: false });
  const mk = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name), rec = RU.blankRec(sid, pack, RU.DEFAULT_RULESET_ID), ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M', nickname: 'Mr. Mime-2' }); };
  const created = await store.createProfile({ trainerName: 'RED' });
  const mons = ['Pikachu', 'Charizard', 'Snorlax', 'Blastoise', 'Gengar', 'Eevee'].map(mk);
  const saved = await store.saveProfile({ ...created, box: mons, teams: [P.createTeam({ name: 'Kanto Squad', monIds: mons.map((m) => m.id) })] }, { reason: 'seed' });
  const r = await HDATA.teamCodeFor(store, saved.id, saved.teams[0].id);
  if (!r.ok) throw new Error('no team code: ' + r.message);
  return r.code;
}
const REAL_CODE = await realTeamCode();
const LONG_CODE = 'ARENA1.' + 'eJxjYGBgYWBg_M-AwMDIwMDwn4GBgQEAFQYCAQ'.repeat(30).slice(0, 1012) + '.1a2b';          // 1024 characters of the team code alphabet (not a decodable code: a length)

const tester = () => { const f = []; const t = (name, cond, detail) => { let good = false, why = ''; try { good = typeof cond === 'function' ? !!cond() : !!cond; } catch (err) { why = ' [threw: ' + (err && err.message) + ']'; } if (!good) f.push(name + (why || (detail ? ' [' + (typeof detail === 'function' ? (() => { try { return detail(); } catch (_e) { return 'detail threw'; } })() : detail) + ']' : ''))); }; return { f, t }; };
const eff = (list, type) => list.filter((e) => e.type === type);
const press = (m, ...as) => { let out = []; for (const a of as) out = out.concat(m.press(a)); return out; };
const toRow = (m, id) => { for (let i = 0; i < 24 && m.rows()[m.state().cursor.main].id !== id; i++) m.press('down'); return m.rows()[m.state().cursor.main].id === id; };
const plainBad = (v) => { const seen = []; (function walk(x, p) { if (x === undefined || typeof x === 'function') seen.push(p); else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], p + '.' + k); })(v, 'view'); return seen; };
const FAKE_DATA = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', teams: [{ id: 't1', name: 'Kanto Squad', size: 3, legal: true, problems: 0, names: ['A', 'B', 'C'], lead: { species: 25 } }] }] };

/** A recording app: every call the hub makes is written to `log`; what it answers is set through `set`. */
function fakeApp(id, paths, parents = {}) {
  const log = [], st = { wants: false, tickFx: undefined, dataFx: undefined, n: 0, beat: 0 };
  let ctx = null;
  const desc = {
    id, paths: Object.freeze(paths.slice()), parent: (p) => parents[p] || 'main',
    create(c) {
      ctx = c;
      return {
        id, paths: desc.paths, parent: desc.parent,
        enter(p) { log.push('enter:' + p); }, leave(p) { log.push('leave:' + p + '@' + c.path()); },
        press(p, a) { log.push('press:' + p + ':' + a); if (a === 'b') return c.back(); if (a === 'start') return [{ app: id, type: 'ping', n: ++st.n }]; if (a === 'r') return c.go(paths[paths.length - 1]); return []; },
        hit(p, x, y) { log.push('hit:' + p); return x < 100 ? { kind: 'thing', x, y } : null; },
        pointer(p, ev) { log.push('pointer:' + p + ':' + ev.kind); return ev.kind === 'click' ? [{ app: id, type: 'clicked', x: ev.x }] : []; },
        rects(p) { log.push('rects:' + p); return [{ x: 1, y: 2, w: 3, h: 4 }]; },
        tick(p) { log.push('tick:' + p); st.beat++; return st.tickFx; },
        view(p, base) { return { ...base, screen: 'WRONG', app: 'WRONG', fake: { beat: st.beat } }; },
        onData() { log.push('data'); return st.dataFx; },
        onDialog(i, v) { log.push('dialog:' + i + ':' + v); return [{ app: id, type: 'answered', value: v }]; },
        wantsText() { return st.wants; },
        type(p, input) { log.push('type:' + p + ':' + J(input)); return [{ app: id, type: 'typed' }]; },
        speak() { return 'Fake ' + id + ' speaks.'; }, title(p) { return 'Fake ' + p; }, state() { return { n: st.n, beat: st.beat }; },
      };
    },
  };
  return { desc, log, st, ctx: () => ctx };
}

/** An app of this suite's own whose one screen is a text entry (opened as the screen opens): what the shell's layers are tested on, so that those tests do not lean on a product app. */
function typerApp(TE) {
  const id = 'typer', paths = Object.freeze(['typer']), parent = () => 'main';
  return {
    id, paths, parent,
    create(ctx) {
      const slot = TE.createEntrySlot(); let got = null;
      return {
        id, paths, parent,
        enter() { slot.open({ id: 'n', title: 'TYPE?', value: '', max: 10, charset: 'name' }, (r) => { got = r; return [{ app: id, type: 'typed', ok: r.ok }]; }); },
        leave() { slot.close(); },
        press: (_p, a) => slot.press(a) || (a === 'b' ? ctx.back() : []),
        hit: (_p, x, y) => (slot.isOpen() ? slot.hit(x, y) : null),
        pointer: (_p, ev) => slot.pointer(ev) || [],
        rects: () => slot.rects(), tick() {}, onData: () => [],
        view: (_p, base) => ({ ...base, entry: slot.view() }),
        wantsText: () => slot.isOpen(), type: (_p, input) => slot.type(input) || [],
        speak: () => 'Typer.', title: () => 'Typer', state: () => ({ got }),
      };
    },
  };
}

/* ================================================================================================ A. the registry and the delegation */
function checkHost(K) {
  const { f, t } = tester(), { HM, HA } = K;
  const mkFakes = () => { const A = fakeApp('alpha', ['alpha', 'alpha-two'], { 'alpha-two': 'alpha' }), B = fakeApp('beta', ['beta'], { beta: 'alpha-two' }); return { A, B, m: HM.createHubModel({ mascot: 25, apps: [A.desc, B.desc], measureFont: (font, s) => (font === 'small' ? 5 : 6) * s.length }) }; };
  // ---- the default registry
  t('registry: the hub hosts online, center and builder, and their paths are hub paths the address may name', () => J(HA.APPS.map((a) => a.id)) === J(['online', 'center', 'builder']) && ['online', 'center', 'builder'].every((p) => HM.PATHS.includes(p) && HA.APP_PATHS.includes(p)) && HA.APP_PATHS.every((p) => HM.PATHS.includes(p)) && J(HA.APP_PATHS) === J(HA.pathsOf(HA.APPS)) && HA.appOfPath('online').id === 'online' && HA.appOfPath('main') === null, () => J(HM.PATHS));
  t('registry: the three lists (models, renderers, ctls) name the same apps', () => J(Object.keys(K.AS.APP_SCREENS).sort()) === J(HA.APPS.map((a) => a.id).sort()) && J(Object.keys(K.AC.APP_CTLS).sort()) === J(HA.APPS.map((a) => a.id).sort()) && Object.values(K.AS.APP_SCREENS).every((x) => typeof x === 'function') && Object.values(K.AC.APP_CTLS).every((x) => typeof x === 'function'));
  t('registry: the default registry passes its own rules', () => HA.checkRegistry(HA.APPS, ['main', 'quick', 'team', 'record', 'about', 'tower', 'tower-new'], () => 'main').length === 0, () => J(HA.checkRegistry(HA.APPS, ['main'], () => 'main')));
  t('registry: every app model the default hub makes has every method of the contract', () => { const m = HM.createHubModel({ mascot: 25 }); return HA.APPS.every((d) => HA.checkApp(d, m.apps[d.id]).length === 0) && HA.APP_METHODS.length === 15; });
  // ---- delegation: an app gets exactly its own paths' input
  let { A, B, m } = mkFakes();
  t('host: a model given its own apps knows their paths and not the default ones', () => m.paths.includes('alpha-two') && m.paths.includes('beta') && !m.paths.includes('online') && m.goto('online').length === 0);
  let e = m.goto('alpha');
  t('enter: opening an app path calls that app\'s enter(path) once, and no other app\'s', () => e.length === 1 && e[0].type === 'screen' && e[0].path === 'alpha' && J(A.log) === J(['enter:alpha']) && B.log.length === 0, () => J(A.log) + J(B.log));
  const mainCursor = m.state().cursor.main; A.log.length = 0;
  e = press(m, 'up', 'down', 'a', 'x');
  t('press reaches the app: every press goes to the open app with its path, and the hub\'s own cursor does not move', () => e.length === 0 && J(A.log) === J(['press:alpha:up', 'press:alpha:down', 'press:alpha:a', 'press:alpha:x']) && B.log.length === 0 && m.state().cursor.main === mainCursor && m.path() === 'alpha', () => J(A.log));
  e = m.press('start');
  t('effects: what the app returns is returned unchanged (an effect with `app` is the page\'s to route)', () => J(e) === J([{ app: 'alpha', type: 'ping', n: 1 }]), () => J(e));
  A.log.length = 0;
  const h1 = m.hit(10, 20), h2 = m.hit(200, 20), r1 = m.rects(), p1 = m.pointer({ kind: 'move', x: 5, y: 6 }), p2 = m.pointer({ kind: 'click', x: 5, y: 6 });
  t('hit / rects / pointer reach the app with its path (a miss is null, never undefined)', () => h1 && h1.kind === 'thing' && h2 === null && J(r1) === J([{ x: 1, y: 2, w: 3, h: 4 }]) && p1.length === 0 && J(p2) === J([{ app: 'alpha', type: 'clicked', x: 5 }]) && J(A.log) === J(['hit:alpha', 'hit:alpha', 'rects:alpha', 'pointer:alpha:move', 'pointer:alpha:click']), () => J(A.log) + J(h2));
  // ---- the view
  let v = m.view();
  t('the view carries screen and app: whatever the app wrote there, screen is the path and app is the id; the base fields ride along', () => v.screen === 'alpha' && v.app === 'alpha' && v.fake && v.env === 0 && v.tick === 0 && v.sound === false && 'mascot' in v && v.menu === undefined && v.dialog === undefined, () => J(v));
  t('the view is plain JSON', () => plainBad(v).length === 0 && J(JSON.parse(J(v))) === J(v), () => plainBad(v).join());
  // ---- tick
  A.log.length = 0; A.st.tickFx = [{ app: 'alpha', type: 'beat' }];
  const before = J(m.view()); e = m.tick();
  t('tick reaches the open app: one tick(path) a frame, its effects come back from hub.tick(), and its view may change every frame', () => J(e) === J([{ app: 'alpha', type: 'beat' }]) && J(A.log) === J(['tick:alpha']) && B.log.length === 0 && J(m.view()) !== before && m.view().fake.beat === 1, () => J(e) + J(A.log));
  A.st.tickFx = undefined; e = m.tick();
  t('tick: an app that returns nothing gives [] (hub.tick() always returns a list)', () => Array.isArray(e) && e.length === 0);
  // ---- back, nested screens, another app
  A.log.length = 0; e = m.press('r');
  t('nested: ctx.go(path) opens another screen of the app: leave(old) while the old screen is still open, then enter(new)', () => m.path() === 'alpha-two' && e.length === 1 && e[0].path === 'alpha-two' && J(A.log) === J(['press:alpha:r', 'leave:alpha@alpha', 'enter:alpha-two']), () => J(A.log));
  A.log.length = 0; e = m.press('b');
  t('nested: B goes to parent(path), and a step back to a screen that is not the main menu says so (back: true)', () => m.path() === 'alpha' && e.length === 1 && e[0].type === 'screen' && e[0].path === 'alpha' && e[0].back === true && J(A.log) === J(['press:alpha-two:b', 'leave:alpha-two@alpha-two', 'enter:alpha']), () => J(e) + J(A.log));
  A.log.length = 0; e = m.press('b');
  t('leave: B from the app\'s first screen is the main menu (no back flag: the page already treats main as a step back), and leave(path) is called', () => m.path() === 'main' && e.length === 1 && e[0].path === 'main' && e[0].back === undefined && J(A.log) === J(['press:alpha:b', 'leave:alpha@alpha']), () => J(e) + J(A.log));
  A.log.length = 0; B.log.length = 0; m.goto('alpha-two'); e = m.goto('beta');
  t('another app: moving from one app\'s screen to another\'s is leave for the first and enter for the second', () => m.path() === 'beta' && J(A.log) === J(['enter:alpha-two', 'leave:alpha-two@alpha-two']) && J(B.log) === J(['enter:beta']), () => J(A.log) + J(B.log));
  e = m.press('b');
  t('another app: B from it goes to its parent, a screen of the OTHER app', () => m.path() === 'alpha-two' && e[0].back === true, () => J(e));
  // ---- the hub's own screens and the Tower are untouched
  m.goto('main'); A.log.length = 0; B.log.length = 0;
  e = m.press('a'); const q = m.path(); press(m, 'right', 'down', 'b'); m.goto('tower'); press(m, 'down', 'up'); m.pointer({ kind: 'move', x: 60, y: 20 }); m.hit(60, 20); m.rects(); m.tick(); m.goto('about'); m.press('a'); m.goto('record'); m.press('right'); m.goto('main');
  t('the old screens are untouched: with a hub screen or a Tower screen open no app hears a press, a pointer, a hit, a tick or a view', () => q === 'quick' && A.log.length === 0 && B.log.length === 0, () => J(A.log) + J(B.log));
  t('goto: an unknown path is ignored and calls nothing', () => m.goto('alpha-three').length === 0 && m.goto('gamma').length === 0 && m.path() === 'main' && A.log.length === 0);
  // ---- data
  A.st.dataFx = [{ app: 'alpha', type: 'fresh' }]; e = m.setData(FAKE_DATA);
  t('onData: after every data refresh EVERY app\'s onData() is called once (open or not) and its effects are returned', () => J(A.log) === J(['data']) && J(B.log) === J(['data']) && J(e) === J([{ app: 'alpha', type: 'fresh' }]), () => J(e) + J(A.log));
  t('ctx: profiles(), activeId() and dataState() are the data the hub was given', () => A.ctx().dataState() === 'ready' && A.ctx().activeId() === 'p1' && A.ctx().profiles().length === 1 && A.ctx().profiles()[0].teams[0].name === 'Kanto Squad');
  t('ctx: path() is the open screen, measure(font, s) is the hub\'s font measure and msgPx its message width', () => A.ctx().path() === 'main' && A.ctx().measure('normal', 'abcd') === 24 && A.ctx().measure('small', 'abcd') === 20 && A.ctx().msgPx === 204);
  // ---- typed text
  m.goto('alpha'); A.log.length = 0;
  t('type is refused when the app does not want text: wantsText() is false, type() returns [] and the app hears nothing', () => m.wantsText() === false && m.type({ text: 'x' }).length === 0 && A.log.length === 0, () => J(A.log));
  A.st.wants = true; e = m.type({ text: 'x' });
  t('type: while the open app wants text, hub.type(input) hands it the input with the path', () => m.wantsText() === true && J(e) === J([{ app: 'alpha', type: 'typed' }]) && J(A.log) === J(['type:alpha:{"text":"x"}']), () => J(A.log));
  m.goto('main');
  t('type: an app that wants text is not asked while another screen is open', () => m.wantsText() === false && m.type({ key: 'enter' }).length === 0);
  // ---- handles, state, speech, titles
  t('handles: hub.apps[id], hub.app(id) and hub.appOf(path) are the app\'s model', () => m.apps.alpha === m.app('alpha') && m.appOf('alpha-two') === m.apps.alpha && m.appOf('main') === null && m.app('nobody') === null && Object.isFrozen(m.apps));
  t('state(): the hub\'s state carries every app\'s state() and the dialog layer\'s, as plain JSON', () => { const s = m.state(); return J(s.apps.alpha) === J(m.apps.alpha.state()) && 'beta' in s.apps && s.dialog.open === null && J(JSON.parse(J(s))) === J(s); });
  m.goto('alpha');
  t('speak / title: an app\'s view is worded by the app and its screen titled by it; the hub\'s own are not (null)', () => m.speak(m.view()) === 'Fake alpha speaks.' && m.title('alpha-two') === 'Fake alpha-two' && (m.goto('main'), m.speak(m.view()) === null && m.title('main') === null && m.title('tower') === null));
  // ---- parents and the history trail
  t('trail: the screens to walk through to an app screen follow parent(), across apps too', () => J(HM.arrivalTrail('alpha-two', [A.desc, B.desc])) === J(['alpha', 'alpha-two']) && J(HM.arrivalTrail('beta', [A.desc, B.desc])) === J(['alpha', 'alpha-two', 'beta']) && J(HM.arrivalTrail('main', [A.desc])) === J([]));
  t('trail: the hub\'s own screens and the Tower\'s are as before (the Tower by its own parents, everything else from the menu), and every registered app path ends at the main menu', () => J(HM.arrivalTrail('tower-offer')) === J(['tower', 'tower-offer']) && J(HM.arrivalTrail('quick')) === J(['quick']) && HM.parentOf('main') === null && HM.parentOf('tower-new') === 'tower' && HM.parentOf('about') === 'main' && HA.APP_PATHS.every((p) => { const tr = HM.arrivalTrail(p); return tr.length >= 1 && tr[tr.length - 1] === p && HM.parentOf(tr[0]) === 'main'; }));
  t('trail: a fresh arrival at an app screen is seeded (write), a reload onto an entry the page wrote is not', () => { const list = [A.desc, B.desc], a = HM.historySeedPlan('beta', null, list), b = HM.historySeedPlan('beta', { arenaHub: 'beta' }, list), c = HM.historySeedPlan('main', null, list); return J(a) === J({ trail: ['alpha', 'alpha-two', 'beta'], write: true }) && b.write === false && b.trail.length === 3 && c.write === false && c.trail.length === 0; });
  // ---- the rules of the registry
  const R = (list) => HA.checkRegistry(list, ['main', 'quick', 'team', 'record', 'about', 'tower', 'tower-new'], () => 'main');
  const D = (o) => ({ id: 'alpha', paths: ['alpha'], parent: () => 'main', create: () => ({}), ...o });
  t('rules: a good descriptor passes', () => R([D({})]).length === 0, () => J(R([D({})])));
  t('rules: an id must be 2..16 lower-case letters or digits', () => R([D({ id: 'Alpha', paths: ['Alpha'] })]).length > 0 && R([D({ id: 'a', paths: ['a'] })]).length > 0 && R([D({ id: 'al-pha', paths: ['al-pha'] })]).length > 0 && R([D({ id: 5 })]).length > 0);
  t('rules: an id used twice is refused', () => R([D({}), D({})]).some((x) => /used twice/.test(x)));
  t('rules: an app may not take the name of a hub screen or of the Tower', () => ['main', 'quick', 'team', 'record', 'about', 'tower'].every((id) => R([D({ id, paths: [id] })]).some((x) => /hub screen/.test(x))));
  t('rules: a path not under its id is refused (it must be the id or "<id>-...")', () => R([D({ paths: ['alpha', 'other'] })]).some((x) => /is not "alpha"/.test(x)) && R([D({ paths: ['alphabet'] })]).length > 0 && R([D({ paths: ['alpha', 'alpha-Two'] })]).length > 0 && R([D({ paths: [] })]).some((x) => /no path/.test(x)));
  t('rules: a path claimed twice is refused', () => R([D({ paths: ['alpha', 'alpha-x', 'alpha-x'] })]).some((x) => /claimed twice/.test(x)));
  t('rules: a parent that is not another hub path is refused', () => R([D({ parent: () => 'nowhere' })]).some((x) => /not another hub path/.test(x)) && R([D({ parent: () => 'alpha' })]).some((x) => /not another hub path/.test(x)) && R([D({ parent: () => undefined })]).length > 0);
  t('rules: parents that never reach the main menu are refused (a loop)', () => R([D({ paths: ['alpha', 'alpha-two'], parent: (p) => (p === 'alpha' ? 'alpha-two' : 'alpha') })]).some((x) => /never reach/.test(x)));
  t('rules: a parent may be a hub screen or a Tower screen', () => R([D({ parent: () => 'tower-new' })]).length === 0 && R([D({ parent: () => 'quick' })]).length === 0);
  t('rules: a descriptor without create or parent is refused', () => R([D({ create: null })]).some((x) => /create/.test(x)) && R([D({ parent: null })]).some((x) => /parent/.test(x)));
  const throws = (fn, re) => { try { fn(); return false; } catch (err) { return re.test(String(err && err.message)); } };
  t('rules: a hub model refuses a broken registry, naming what is wrong', () => throws(() => HM.createHubModel({ apps: [D({ paths: ['alpha', 'zzz'] })] }), /registry is broken.*zzz/) && throws(() => HM.createHubModel({ apps: [D({ id: 'tower', paths: ['tower'] })] }), /hub screen/));
  const good = fakeApp('alpha', ['alpha']);
  t('missing method: a model without one of the contract\'s methods is refused by name', () => HA.APP_METHODS.every((meth) => throws(() => HM.createHubModel({ apps: [{ ...good.desc, create: (c) => { const a = good.desc.create(c); delete a[meth]; return a; } }] }), new RegExp('malformed.*' + meth + '\\(\\) is missing'))));
  t('missing method: a model whose id or paths are not the registry\'s is refused', () => throws(() => HM.createHubModel({ apps: [{ ...good.desc, create: (c) => ({ ...good.desc.create(c), id: 'other' }) }] }), /malformed.*its id/) && throws(() => HM.createHubModel({ apps: [{ ...good.desc, create: (c) => ({ ...good.desc.create(c), paths: ['alpha', 'alpha-x'] }) }] }), /its paths/) && throws(() => HM.createHubModel({ apps: [{ ...good.desc, create: () => null }] }), /did not return an object/));
  t('onDialog is optional, but must be a function when present', () => HM.createHubModel({ apps: [{ ...good.desc, create: (c) => { const a = good.desc.create(c); delete a.onDialog; return a; } }] }).path() === 'main' && throws(() => HM.createHubModel({ apps: [{ ...good.desc, create: (c) => ({ ...good.desc.create(c), onDialog: 5 }) }] }), /onDialog/));
  return f;
}

/* ================================================================================================ D. the dialog layer */
function checkDialog(K) {
  const { f, t } = tester(), { HM, HD } = K;
  const mk = () => HM.createHubModel({ mascot: 25 });
  const YN = (o) => ({ id: 'q', pages: [['RED wants to battle you.', '3v3, standard rules.']], choice: { options: ['YES', 'NO'], cursor: 1 }, ...(o || {}) });
  // ---- open, the view, the choice
  let m = mk(), e;
  t('open: a dialog over the main menu is in the view (lines, options, the cursor) and only while it is open', () => m.view().dialog === undefined && m.dialog.open(YN()) === true && m.dialog.isOpen() && m.view().dialog.id === 'q' && J(m.view().dialog.lines) === J(['RED wants to battle you.', '3v3, standard rules.']) && J(m.view().dialog.choice.options) === J(['YES', 'NO']) && m.view().dialog.choice.cursor === 1 && m.view().screen === 'main' && !!m.view().menu, () => J(m.view().dialog));
  t('open: current() is the dialog shown, as plain JSON', () => { const c = m.dialog.current(); return c.id === 'q' && c.page === 0 && c.pages === 1 && c.choice.cursor === 1 && c.ticksLeft === null && c.app === null; });
  const c0 = m.state().cursor.main; press(m, 'down');
  t('it takes every press: down moves the dialog\'s cursor (it wraps), never the menu\'s under it', () => m.state().cursor.main === c0 && m.view().dialog.choice.cursor === 0 && (press(m, 'down'), m.view().dialog.choice.cursor === 1) && (press(m, 'up'), m.view().dialog.choice.cursor === 0) && (press(m, 'up'), m.view().dialog.choice.cursor === 1), () => J(m.view().dialog.choice));
  press(m, 'up'); e = m.press('a');
  t('choice: A answers with the index of the highlighted option, as an effect, and the dialog is gone', () => J(e) === J([{ type: 'dialog', id: 'q', value: 0 }]) && !m.dialog.isOpen() && m.view().dialog === undefined && m.dialog.current() === null, () => J(e));
  t('choice: with the dialog gone the menu under it is live again', () => (press(m, 'down'), m.state().cursor.main === c0 + 1));
  m = mk(); m.dialog.open(YN({ choice: { options: ['YES', 'MAYBE', 'NO'], cursor: 0 } })); e = m.press('b');
  t('B answers the last option (NO), whatever is highlighted', () => J(e) === J([{ type: 'dialog', id: 'q', value: 2 }]) && !m.dialog.isOpen(), () => J(e));
  // ---- pages
  m = mk(); m.dialog.open({ id: 'p', pages: [['one', 'two'], 'three', ['five', 'six']], choice: { options: ['YES', 'NO'], cursor: 0 } });
  t('pages: the options are shown with the LAST page only; the first page says there is more', () => m.view().dialog.pages === 3 && m.view().dialog.more === true && m.view().dialog.choice === null && m.rects().length === 0, () => J(m.view().dialog));
  e = press(m, 'down', 'a');
  t('pages: A turns the page (a string is a one-line page); the d-pad does nothing before the last page', () => e.length === 0 && m.view().dialog.page === 1 && J(m.view().dialog.lines) === J(['three', '']) && m.view().dialog.choice === null, () => J(m.view().dialog));
  e = m.press('a');
  t('pages: on the last page the options appear, and A then answers', () => e.length === 0 && m.view().dialog.page === 2 && m.view().dialog.more === false && m.view().dialog.choice.cursor === 0 && J(m.press('a')) === J([{ type: 'dialog', id: 'p', value: 0 }]), () => J(m.view().dialog));
  m = mk(); m.dialog.open({ id: 'p', pages: [['one', ''], ['two', '']], choice: { options: ['YES', 'NO'], cursor: 0 } }); e = m.press('b');
  t('pages: B answers the last option from the FIRST page too', () => J(e) === J([{ type: 'dialog', id: 'p', value: 1 }]), () => J(e));
  // ---- a notice
  m = mk(); m.dialog.open({ id: 'n', pages: [['a', 'b'], ['c', 'd']], choice: null }); e = m.press('a');
  t('notice: with no choice A reads on and, at the end, closes it with value "closed"', () => e.length === 0 && J(m.press('a')) === J([{ type: 'dialog', id: 'n', value: 'closed' }]) && !m.dialog.isOpen());
  m.dialog.open({ id: 'n', pages: [['a', 'b'], ['c', 'd']] });
  t('notice: B closes it at once ("closed")', () => J(m.press('b')) === J([{ type: 'dialog', id: 'n', value: 'closed' }]));
  // ---- the timeout
  m = mk(); m.dialog.open(YN({ ticksLeft: 3 }));
  t('timeout: a dialog with ticksLeft answers "timeout" by itself after that many ticks, not one earlier', () => m.tick().length === 0 && m.tick().length === 0 && m.dialog.isOpen() && J(m.tick()) === J([{ type: 'dialog', id: 'q', value: 'timeout' }]) && !m.dialog.isOpen() && m.tick().length === 0);
  m = mk(); m.dialog.open(YN()); for (let i = 0; i < 5000; i++) m.tick();
  t('timeout: a dialog without ticksLeft never times out', () => m.dialog.isOpen());
  // ---- a second open is QUEUED
  m = mk(); const first = m.dialog.open(YN()), second = m.dialog.open(YN({ id: 'q2', pages: [['second', '']], ticksLeft: 2 }));
  t('queued: a second open while one is open is taken (true) and waits: the first stays the one shown', () => first === true && second === true && m.view().dialog.id === 'q' && m.view().dialog.queued === 1 && J(m.state().dialog.queued) === J(['q2']), () => J(m.state().dialog));
  m.tick(); m.tick(); m.tick();
  t('queued: a queued dialog does not age (its ticksLeft counts only while it is shown)', () => m.dialog.isOpen() && m.view().dialog.id === 'q' && m.state().dialog.queued.length === 1);
  e = m.press('b');
  t('queued: answering the first shows the second', () => J(e) === J([{ type: 'dialog', id: 'q', value: 1 }]) && m.view().dialog.id === 'q2' && m.view().dialog.queued === 0 && (m.tick(), J(m.tick()) === J([{ type: 'dialog', id: 'q2', value: 'timeout' }])), () => J(m.view().dialog));
  m = mk(); m.dialog.open(YN());
  t('refused: an id that is already open or queued is refused (false) and changes nothing', () => m.dialog.open(YN()) === false && m.dialog.open(YN({ id: 'w' })) === true && m.dialog.open(YN({ id: 'w' })) === false && m.state().dialog.queued.length === 1);
  m = mk(); const taken = []; for (let i = 0; i < 10; i++) taken.push(m.dialog.open(YN({ id: 'd' + i })));
  t('refused: the queue holds ' + HD.DIALOG_QUEUE_MAX + ' dialogs in all; one more is refused', () => HD.DIALOG_QUEUE_MAX === 8 && J(taken) === J([true, true, true, true, true, true, true, true, false, false]));
  m = mk();
  const badSpecs = [null, 5, {}, { id: '', pages: [['a']] }, { id: 'x' }, { id: 'x', pages: [] }, { id: 'x', pages: [['a', 'b', 'c']] }, { id: 'x', pages: [[1]] }, { id: 'x', pages: Array(17).fill(['a']) }, { id: 'x', pages: [['a']], choice: { options: [] } },
    { id: 'x', pages: [['a']], choice: { options: ['1', '2', '3', '4', '5'] } }, { id: 'x', pages: [['a']], choice: { options: ['YES', ''] } }, { id: 'x', pages: [['a']], choice: 'YES' }, { id: 'x', pages: [['a']], ticksLeft: 0 }, { id: 'x', pages: [['a']], ticksLeft: 1.5 },
    { id: 'x', pages: [['a']], app: 7 }, { id: 'y'.repeat(65), pages: [['a']] }];
  t('refused: a malformed dialog is refused and never throws (no id, no pages, three lines, seventeen pages, no / five / empty options, a bad ticksLeft, a bad app)', () => badSpecs.every((s) => m.dialog.open(s) === false) && !m.dialog.isOpen(), () => J(badSpecs.map((s) => m.dialog.open(s))));
  t('accepted: one to four options, one to sixteen pages, a cursor out of range is clamped', () => { const d = HD.normalizeDialog({ id: 'x', pages: Array(16).fill('p'), choice: { options: ['1', '2', '3', '4'], cursor: 9 } }); return d && d.choice.cursor === 3 && d.pages.length === 16 && HD.normalizeDialog({ id: 'x', pages: [['a']], choice: { options: ['OK'] } }).choice.cursor === 0; });
  // ---- close
  m = mk(); m.dialog.open(YN()); m.dialog.open(YN({ id: 'q2' })); m.dialog.open(YN({ id: 'q3' }));
  t('close(id): removes a queued dialog or the one shown (the next is then shown), returns whether there was one, and emits nothing', () => m.dialog.close('q2') === true && J(m.state().dialog.queued) === J(['q3']) && m.dialog.close('q') === true && m.view().dialog.id === 'q3' && m.dialog.close('nope') === false && m.dialog.close('q3') === true && !m.dialog.isOpen());
  // ---- the pointer
  m = mk(); m.dialog.open(YN()); const rc = m.rects();
  t('pointer: the options have rectangles (hub.rects() while a dialog is open), on the screen and above the message box', () => rc.length === 2 && rc.every((r) => r.x >= 6 && r.x + r.w <= 234 && r.y >= 6 && r.y + r.h <= 106) && rc[1].y === rc[0].y + 16, () => J(rc));
  const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  t('pointer: hub.hit() is the dialog\'s while it is open (an option, the message box, or nothing: never the row under it)', () => m.hit(mid(rc[0]).x, mid(rc[0]).y).kind === 'option' && m.hit(mid(rc[0]).x, mid(rc[0]).y).index === 0 && m.hit(mid(rc[1]).x, mid(rc[1]).y).index === 1 && m.hit(100, 130).kind === 'msg' && m.hit(60, 14) === null, () => J(m.hit(60, 14)));
  e = m.pointer({ kind: 'move', ...mid(rc[0]) });
  t('pointer: a hover on an option highlights it and answers nothing', () => e.length === 0 && m.view().dialog.choice.cursor === 0 && m.dialog.isOpen());
  e = m.pointer({ kind: 'click', x: 60, y: 14 });
  t('pointer: a click beside the dialog does nothing (not the row under it either)', () => e.length === 0 && m.dialog.isOpen() && m.path() === 'main');
  e = m.pointer({ kind: 'click', x: 100, y: 130 });
  t('pointer: a tap on the text never answers a question', () => e.length === 0 && m.dialog.isOpen(), () => J(e));
  e = m.pointer({ kind: 'click', ...mid(rc[1]) });
  t('pointer: a click on an option answers with that option', () => J(e) === J([{ type: 'dialog', id: 'q', value: 1 }]) && !m.dialog.isOpen(), () => J(e));
  m = mk(); m.dialog.open({ id: 'n', pages: [['a', ''], ['b', '']] }); e = m.pointer({ kind: 'click', x: 100, y: 130 });
  t('pointer: a tap on the text turns the page, and closes a notice at its end', () => e.length === 0 && m.view().dialog.page === 1 && J(m.pointer({ kind: 'click', x: 100, y: 130 })) === J([{ type: 'dialog', id: 'n', value: 'closed' }]));
  m = mk(); m.dialog.open(YN({ choice: { options: ['A', 'B', 'C'], cursor: 0 } })); m.pointer({ kind: 'wheel', steps: 2 });
  t('pointer: the wheel moves the highlight', () => m.view().dialog.choice.cursor === 2 && (m.pointer({ kind: 'wheel', steps: -1 }), m.view().dialog.choice.cursor === 1));
  // ---- geometry for every size
  const m6 = (font, s) => String(s).length * 6;
  const geomBad = [];
  for (const opts of [['OK'], ['YES', 'NO'], ['A', 'B', 'C'], ['3v3', '6v6', 'ANY FORMAT', 'CANCEL'], ['W'.repeat(60)], ['A LONG OPTION TO READ', 'NO']]) { const r = HD.optionRects(opts, m6); if (r.x - 6 < 0 || r.x + r.w + 6 > 240 || r.y - 6 < 0 || r.y + r.h + 6 > 112 || r.rows.length !== opts.length || r.w < 36) geomBad.push(J(opts).slice(0, 30) + ' -> ' + J({ x: r.x, y: r.y, w: r.w, h: r.h })); }
  t('geometry: the options window (with its ring) is on the screen and above the message box for one to four options and for labels of any length', () => geomBad.length === 0, () => geomBad.join(' | '));
  // ---- over an app
  const A = fakeApp('alpha', ['alpha']); m = HM.createHubModel({ mascot: 25, apps: [A.desc] }); m.goto('alpha'); A.log.length = 0;
  m.dialog.open(YN({ app: 'alpha' }));
  press(m, 'up', 'x', 'start'); m.pointer({ kind: 'click', x: 10, y: 10 }); m.pointer({ kind: 'move', x: 10, y: 10 }); m.hit(10, 10); m.rects();
  t('over an app: while a dialog is open the app under it hears no press, pointer, hit or rects', () => A.log.length === 0 && m.view().app === 'alpha' && m.view().dialog.id === 'q' && !!m.view().fake, () => J(A.log));
  t('over an app: the app is still ticked (the room under a question keeps moving)', () => (m.tick(), J(A.log) === J(['tick:alpha'])));
  A.log.length = 0; e = m.press('a');
  t('over an app: the answer carries `app`, the app\'s MODEL hears it first (onDialog) and its effects follow the answer\'s', () => J(e) === J([{ type: 'dialog', id: 'q', value: 0, app: 'alpha' }, { app: 'alpha', type: 'answered', value: 0 }]) && J(A.log) === J(['dialog:q:0']), () => J(e) + J(A.log));
  m.goto('main'); A.log.length = 0; A.ctx().dialog.open({ id: 'mine', pages: [['x', '']], choice: { options: ['YES', 'NO'], cursor: 0 }, ticksLeft: 1 }); e = m.tick();
  t('ctx.dialog: a dialog an app opens through its ctx is its own (app set), wherever the player is; a timeout reaches onDialog too', () => J(e) === J([{ type: 'dialog', id: 'mine', value: 'timeout', app: 'alpha' }, { app: 'alpha', type: 'answered', value: 'timeout' }]) && J(A.log) === J(['dialog:mine:timeout']), () => J(e));
  m.dialog.open(YN({ app: 'nobody' })); e = m.press('a');
  t('over an app: an answer for an app that does not exist is just the answer', () => J(e) === J([{ type: 'dialog', id: 'q', value: 1, app: 'nobody' }]));
  t('ctx.notify: an app\'s notice is a one-choice-less dialog named "notice:<id>"; a second notify replaces the first; a string is wrapped into pages', () => A.ctx().notify(['Saved.', 'B goes back.']) === true && m.view().dialog.id === 'notice:alpha' && m.view().dialog.choice === null && J(m.view().dialog.lines) === J(['Saved.', 'B goes back.']) && A.ctx().notify('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen') === true && m.state().dialog.queued.length === 0 && m.view().dialog.pages >= 2 && J(m.press('b')) === J([{ type: 'dialog', id: 'notice:alpha', value: 'closed' }]));
  // ---- text under a dialog
  A.st.wants = true; m.goto('alpha'); m.dialog.open(YN());
  t('text: while a dialog is open over a text entry the hub does not want text (a real keyboard\'s Z is A for the dialog) and type() goes nowhere', () => { A.log.length = 0; return m.wantsText() === false && m.type({ text: 'z' }).length === 0 && A.log.length === 0 && (m.press('b'), m.wantsText() === true); });
  // ---- words
  const pages = HD.wrapDialog('The Trainer Center could not load because the connection was lost. Reload the page and try again in a moment, please.', m6, 204);
  t('wrapDialog: a long text becomes pages of two lines, no line wider than the box, every word kept in order', () => pages.length >= 2 && pages.every((p) => p.length === 2 && p.every((ln) => m6('normal', ln) <= 204)) && pages.flat().filter(Boolean).join(' ') === 'The Trainer Center could not load because the connection was lost. Reload the page and try again in a moment, please.' && J(HD.wrapDialog('', m6, 204)) === J([['', '']]) && J(HD.wrapDialog('a\nb', m6, 204)) === J([['a', 'b']]), () => J(pages));
  m = mk(); m.dialog.open(YN());
  t('speak: a dialog is worded for a screen reader (the text, the options, which one is selected), in place of the screen under it', () => /RED wants to battle you\. 3v3, standard rules\./.test(m.speak(m.view())) && /YES, selected NO/.test(m.speak(m.view())) && HD.speakDialog(null) === '', () => m.speak(m.view()));
  return f;
}

/* ================================================================================================ E. the text entry model */
function checkEntry(K) {
  const { f, t } = tester(), { TE } = K;
  const mk = (o) => TE.createTextEntry({ id: 'e', title: 'TITLE?', value: '', max: 10, charset: 'name', ...(o || {}) });
  const keyAt = (e, row, col) => e.rects().find((r) => r.row === row && r.col === col);
  const goKey = (e, id) => { const r = e.rects().find((x) => x.id === id); if (!r) return false; e.pointer({ kind: 'move', x: r.x + 1, y: r.y + 1 }); return true; };
  // ---- the charsets
  t('charsets: the four the apps need', () => J(TE.CHARSETS) === J(['name', 'code', 'teamcode', 'search']) && TE.ENTRY_MAX === 1024);
  let nameDiff = [];
  for (let c = 0; c < 0x10000; c++) { const ch = String.fromCharCode(c); if (c === 0x2019) continue; const mine = TE.mapChar('name', ch) === ch, theirs = P.textIssue(ch, 1) === null; if (mine !== theirs) { nameDiff.push(c.toString(16)); if (nameDiff.length > 8) break; } }
  t('name: one character is accepted exactly when profile.js textIssue accepts it (all 65,535 code units but the one alias)', () => nameDiff.length === 0, () => nameDiff.join(' '));
  t('name: the curly apostrophe a phone types becomes the plain one; a brace, a control character, a tab and an emoji are refused', () => TE.mapChar('name', '\u2019') === "'" && P.textIssue("'", 1) === null && [...'{}\n\t\u0007'].every((ch) => TE.mapChar('name', ch) === null) && TE.mapChar('name', '\ud83d\ude00') === null && TE.filterText('name', 'a\ud83d\ude00b').text === 'ab');
  t('name: a typed name passes profile.js as a whole (letters, digits, space, the symbols on the keys)', () => { const s = "Mr. Mime-2 & Co!?,/+:;()\u00e9\u2642\u2640"; return TE.filterText('name', s).text === s && TE.filterText('name', s).dropped === 0 && P.textIssue(s, 40) === null; });
  t('code keeps upper case only: room codes are letters and digits, a lower-case letter is typed as its capital, everything else is refused', () => TE.filterText('code', 'k7q2p').text === 'K7Q2P' && TE.filterText('code', 'K7-Q2 P!').text === 'K7Q2P' && TE.filterText('code', 'K7-Q2 P!').dropped === 3 && TE.mapChar('code', '_') === null && TE.mapChar('code', '\u00e9') === null);
  t('teamcode: the ARENA1 alphabet (A-Z a-z 0-9 . - _); "/" is typed as "_" and "+" as "-"; white space in a paste is dropped; nothing else gets in', () => TE.filterText('teamcode', 'ARENA1.aZ09_-.1a2b').text === 'ARENA1.aZ09_-.1a2b' && TE.mapChar('teamcode', '/') === '_' && TE.mapChar('teamcode', '+') === '-' && TE.filterText('teamcode', ' ARENA1.ab\n cd\t.00ff \r\n').text === 'ARENA1.abcd.00ff' && [...'=!?,:;&()\u00e9 '].every((ch) => TE.mapChar('teamcode', ch) === null));
  t('teamcode: the underscore survives (a real code keeps every character)', () => TE.mapChar('teamcode', '_') === '_' && TE.filterText('teamcode', REAL_CODE).text === REAL_CODE && TE.filterText('teamcode', REAL_CODE).dropped === 0 && /^ARENA1\.[A-Za-z0-9_-]+\.[0-9a-f]{4}$/.test(REAL_CODE), () => REAL_CODE.slice(0, 40));
  t('search takes letters, digits, space, hyphen and apostrophe, and nothing else', () => TE.filterText('search', "Mr. Mime-2 Farfetch'd!").text === "Mr Mime-2 Farfetch'd" && TE.mapChar('search', '\u2019') === "'" && [...'.,!?/_+:;()&\u00e9'].every((ch) => TE.mapChar('search', ch) === null));
  t('an unknown charset is a programming error (RangeError), as is a max outside 1..1024', () => { const th = (fn) => { try { fn(); return false; } catch (err) { return err instanceof RangeError; } }; return th(() => mk({ charset: 'emoji' })) && th(() => mk({ max: 0 })) && th(() => mk({ max: 1025 })) && th(() => mk({ max: 2.5 })) && th(() => mk({ max: undefined })) && mk({ max: 1024 }).max === 1024 && TE.mapChar('emoji', 'a') === null; });
  // ---- the keys of every charset
  const kbBad = [];
  for (const cs of TE.CHARSETS) {
    const kb = TE.keyboardOf(cs);
    for (const page of kb.pages) {
      const rows = kb.rows(page), flat = rows.flat();
      if (rows.some((r) => r.length < 1 || r.length > TE.ENTRY_COLS)) kbBad.push(cs + '/' + page + ': a row is too long');
      if (new Set(flat).size !== flat.length) kbBad.push(cs + '/' + page + ': a key is there twice');
      for (const ch of flat) if (TE.mapChar(cs, ch) !== ch) kbBad.push(cs + '/' + page + ': the key ' + ch + ' is not typed as itself');
      if (cs === 'name') for (const ch of flat) if (P.textIssue(ch, 1) !== null) kbBad.push('name key ' + ch + ' fails textIssue');
    }
  }
  t('keys: every key of every page of every charset types itself, no row has more than 13 keys, no key is there twice, and every name key passes profile.js', () => kbBad.length === 0, () => kbBad.slice(0, 4).join('; '));
  const pagesOf = (cs) => TE.keyboardOf(cs).pages, fnOf = (cs, p) => TE.keyboardOf(cs).fn(p).map((k) => k.id), all = (cs) => new Set(pagesOf(cs).flatMap((p) => TE.keyboardOf(cs).rows(p).flat()));
  t('keys: name, teamcode and search have two pages (abc / ABC); code has one and no shift key; only name and search have SPACE; every charset has DEL, CANCEL and OK', () => J(pagesOf('name')) === J(['upper', 'lower']) && pagesOf('teamcode').length === 2 && pagesOf('search').length === 2 && J(pagesOf('code')) === J(['upper']) && J(fnOf('name', 'upper')) === J(['shift', 'space', 'del', 'cancel', 'ok']) && J(fnOf('code', 'upper')) === J(['del', 'cancel', 'ok']) && J(fnOf('teamcode', 'upper')) === J(['shift', 'del', 'cancel', 'ok']) && J(fnOf('search', 'lower')) === J(['shift', 'space', 'del', 'cancel', 'ok']));
  t('keys: the shift key is labelled with the page it goes to', () => TE.keyboardOf('name').fn('upper')[0].label === 'abc' && TE.keyboardOf('name').fn('lower')[0].label === 'ABC');
  t('keys: the picture\'s keys cover each alphabet: every letter and digit for all four, . - _ for a team code, space - \' for a search', () => { const an = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'], lo = [...'abcdefghijklmnopqrstuvwxyz']; return TE.CHARSETS.every((cs) => an.every((ch) => all(cs).has(ch))) && ['name', 'teamcode', 'search'].every((cs) => lo.every((ch) => all(cs).has(ch))) && !lo.some((ch) => all('code').has(ch)) && [...'._-'].every((ch) => all('teamcode').has(ch)) && [..."-'"].every((ch) => all('search').has(ch)) && [..."-'.!?"].every((ch) => all('name').has(ch)); });
  t('the underscore key: the ROM font has no "_", so glyphOf draws it as "/" (which the team code alphabet does not have); every other character is itself', () => TE.glyphOf('_') === '/' && TE.glyphOf('a') === 'a' && TE.glyphOf('-') === '-' && TE.mapChar('teamcode', '/') === '_');
  // ---- the value, the cap, the caret
  let e = mk({ value: 'Sparky' });
  t('start: the value is shown, the caret is at its end, the cursor on the first key, nothing is finished', () => e.value() === 'Sparky' && e.state().caret === 6 && e.state().row === 0 && e.state().col === 0 && e.done() === null && e.view().length === 6 && e.view().max === 10);
  t('start: a starting value is filtered by the charset and cut to max', () => mk({ value: 'A{B}C\nDEFGHIJKLMNOP' }).value() === 'ABCDEFGHIJ' && mk({ charset: 'code', value: 'ab-12' }).value() === 'AB12' && mk({ value: 5 }).value() === '');
  e.type({ text: 'abcdefgh' });
  t('the length cap: typing past max keeps what fits and says so', () => e.value() === 'Sparkyabcd' && e.value().length === 10 && /as long as it can be/.test(e.view().note) && (e.type({ text: 'z' }), e.value() === 'Sparkyabcd'), () => e.value());
  e = mk({ value: 'abcd' }); e.type({ key: 'left' }); e.type({ key: 'left' }); e.type({ text: 'XY' });
  t('caret: text is inserted at the caret, which then stands after it', () => e.value() === 'abXYcd' && e.state().caret === 4, () => e.value() + ' ' + e.state().caret);
  e.type({ key: 'home' }); const c1 = e.state().caret; e.type({ key: 'left' }); const c2 = e.state().caret; e.type({ key: 'end' }); const c3 = e.state().caret; e.type({ key: 'right' });
  t('caret: home / end / left / right move it and stop at the ends', () => c1 === 0 && c2 === 0 && c3 === 6 && e.state().caret === 6);
  e.type({ key: 'left' }); e.type({ key: 'backspace' });
  t('caret: Backspace deletes the character before the caret', () => e.value() === 'abXYd' && e.state().caret === 4, () => e.value());
  e.type({ key: 'home' }); e.type({ key: 'delete' });
  t('caret: Delete deletes the character at the caret', () => e.value() === 'bXYd' && e.state().caret === 0 && (e.type({ key: 'end' }), e.type({ key: 'delete' }), e.value() === 'bXYd'));
  e.press('l'); e.press('l'); const cl = e.state().caret; e.press('r');
  t('caret: the L and R buttons move it too', () => cl === 2 && e.state().caret === 3);
  // ---- typing with the picture's keys
  e = mk();
  t('A types the key under the cursor', () => e.press('a') === null && e.value() === 'A' && (e.press('right'), e.press('a'), e.value() === 'AB'));
  t('d-pad: left from the first key wraps to the last of the row, right from the last wraps to the first', () => { const x = mk(); x.press('left'); const a = x.state().col; x.press('right'); return a === 12 && x.state().col === 0; });
  t('d-pad: up from the top row wraps to the chips, down from the chips wraps to the top row', () => { const x = mk(); x.press('up'); const a = x.state().row; x.press('down'); return a === 4 && x.state().row === 0 && (x.press('down'), x.press('down'), x.press('down'), x.press('down'), x.state().row === 4); });
  t('d-pad: moving to a shorter row takes the nearest key (the last letter column over the digits of a room code lands on 9; over the chips on OK)', () => { const x = mk({ charset: 'code' }); x.press('left'); x.press('down'); x.press('down'); const a = [x.state().row, x.state().col, x.rects().find((r) => r.row === 2 && r.col === x.state().col).id]; x.press('down'); const b = x.rects().find((r) => r.row === 3 && r.col === x.state().col).id; return J(a) === J([2, 9, '9']) && b === 'ok'; });
  t('d-pad: moving to a longer row takes the nearest key too (up from the DEL chip of a name lands on the key above it, the seventh of its row)', () => { const x = mk(); goKey(x, 'del'); x.press('up'); return x.state().row === 3 && x.state().col === 6; });
  e = mk(); goKey(e, 'shift'); e.press('a');
  t('shift: A on abc shows the lower-case page (the key now says ABC), and typing gives lower case', () => e.view().page === 'lower' && e.view().fn[0].label === 'ABC' && e.view().rows[0][0] === 'a' && (goKey(e, 'q'), e.press('a'), e.value() === 'q'));
  e.press('select');
  t('SELECT switches the page too', () => e.view().page === 'upper' && (e.press('select'), e.view().page === 'lower'));
  t('shift: a charset with one page has no shift, and SELECT does nothing there', () => { const x = mk({ charset: 'code' }); x.press('select'); return x.view().page === 'upper' && !x.view().fn.some((k) => k.id === 'shift'); });
  e = mk({ value: 'ab' }); goKey(e, 'space'); e.press('a'); goKey(e, 'del'); const sp = e.value(); e.press('a');
  t('chips: SPACE types a space and DEL deletes', () => sp === 'ab ' && e.value() === 'ab');
  // ---- B, START, OK, CANCEL
  e = mk({ value: 'ab' });
  t('B deletes one character at a time and does not finish while there is text', () => e.press('b') === null && e.value() === 'a' && e.press('b') === null && e.value() === '');
  t('B on an empty field cancels: the result is { id, ok: false }', () => J(e.press('b')) === J({ id: 'e', ok: false }) && J(e.done()) === J({ id: 'e', ok: false }));
  e = mk({ value: 'abc' }); e.type({ key: 'home' });
  t('B with the caret at the start deletes the character after it (B always removes one while there is any)', () => e.press('b') === null && e.value() === 'bc');
  e = mk({ value: 'Red' });
  t('START is OK: the result is { id, ok: true, value }', () => J(e.press('start')) === J({ id: 'e', ok: true, value: 'Red' }) && e.done().ok === true);
  t('after it finished an entry takes no more input and keeps answering its result', () => J(e.press('a')) === J({ id: 'e', ok: true, value: 'Red' }) && J(e.type({ text: 'x' })) === J({ id: 'e', ok: true, value: 'Red' }) && J(e.pointer({ kind: 'click', x: 20, y: 60 })) === J({ id: 'e', ok: true, value: 'Red' }) && e.value() === 'Red');
  e = mk();
  t('OK needs something typed: on an empty (or all-spaces) field it stays open and says so', () => e.press('start') === null && /Type something first/.test(e.view().note) && (e.type({ text: '   ' }), e.type({ key: 'enter' }) === null) && e.done() === null);
  t('OK: allowEmpty accepts the empty field', () => J(mk({ allowEmpty: true }).press('start')) === J({ id: 'e', ok: true, value: '' }));
  e = mk({ charset: 'code', max: 8, min: 4, value: 'K7' });
  t('OK: min is the shortest value it accepts', () => e.press('start') === null && /at least 4/.test(e.view().note) && (e.type({ text: 'q2' }), J(e.press('start')) === J({ id: 'e', ok: true, value: 'K7Q2' })));
  e = mk({ value: 'x' }); goKey(e, 'cancel');
  t('chips: CANCEL cancels whatever is typed; OK accepts it', () => J(e.press('a')) === J({ id: 'e', ok: false }) && (() => { const x = mk({ value: 'x' }); goKey(x, 'ok'); return J(x.press('a')) === J({ id: 'e', ok: true, value: 'x' }); })());
  // ---- a real keyboard, a paste
  e = mk({ max: 16 });
  t('type: a real keyboard\'s key is inserted as it is (the charset decides the case, not the page shown)', () => e.type({ text: 'r' }) === null && e.type({ text: 'E' }) === null && e.value() === 'rE');
  t('type: a refused character is dropped and said', () => e.type({ text: '{' }) === null && e.value() === 'rE' && /cannot be used/.test(e.view().note) && (e.type({ text: 'd' }), e.view().note === ''));
  t('a real keyboard\'s Backspace on an empty field does nothing (only the B button cancels there)', () => { const x = mk(); return x.type({ key: 'backspace' }) === null && x.done() === null && x.value() === '' && x.type({ key: 'delete' }) === null && x.done() === null; });
  t('type: Enter is OK and Escape is CANCEL; an unknown key or a malformed input is ignored', () => { const x = mk({ value: 'ab' }), y = mk({ value: 'ab' }), z = mk(); return J(x.type({ key: 'enter' })) === J({ id: 'e', ok: true, value: 'ab' }) && J(y.type({ key: 'escape' })) === J({ id: 'e', ok: false }) && z.type({ key: 'f5' }) === null && z.type(null) === null && z.type({}) === null && z.type('abc') === null && z.value() === ''; });
  e = mk({ charset: 'teamcode', max: 1024, allowEmpty: true }); e.type({ text: '  ' + REAL_CODE.slice(0, 20) + '\n' + REAL_CODE.slice(20) + ' \r\n' });
  t('paste: a real team code pasted with line breaks and spaces arrives whole, and decodes', () => e.value() === REAL_CODE && J(e.type({ key: 'enter' })) === J({ id: 'e', ok: true, value: REAL_CODE }), () => e.value().slice(0, 40));
  e = mk({ charset: 'teamcode', max: 1024 }); e.type({ text: LONG_CODE + 'EXTRA' });
  t('paste: 1024 characters fit a team code field exactly and one more does not', () => LONG_CODE.length === 1024 && e.value() === LONG_CODE && e.state().caret === 1024 && /as long as it can be/.test(e.view().note));
  // ---- the pointer
  e = mk();
  const rects = e.rects(), over = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) over.push(a.id + '/' + b.id); }
  t('no two key rectangles overlap, every one is on the screen, and there are 52 keys and 5 chips for a name', () => over.length === 0 && rects.length === 57 && rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 240 && r.y + r.h <= 160 && r.w >= 12 && r.h >= 12), () => over.slice(0, 3).join() + ' ' + rects.length);
  t('hit: the middle and the corners of every key are that key', () => rects.every((r) => [[r.x + r.w / 2, r.y + r.h / 2], [r.x, r.y], [r.x + r.w - 1, r.y + r.h - 1]].every(([x, y]) => { const h = e.hit(x, y); return h && h.kind === 'key' && h.row === r.row && h.col === r.col; })));
  t('hit: the title, the field and the gap between the rows of chips and keys are misses', () => e.hit(100, 10) === null && e.hit(100, 30) === null && e.hit(2, 60) === null && e.hit(120, 117) === null && e.hit(120, 150) === null);
  const kq = rects.find((r) => r.id === 'Q');
  t('pointer: a hover or a touch-down on a key moves the cursor to it and types nothing', () => e.pointer({ kind: 'move', x: kq.x + 3, y: kq.y + 3 }) === null && e.state().row === kq.row && e.state().col === kq.col && e.value() === '' && e.pointer({ kind: 'down', x: kq.x + 3, y: kq.y + 3 }) === null && e.value() === '');
  t('a click presses the key under it', () => e.pointer({ kind: 'click', x: kq.x + 3, y: kq.y + 3 }) === null && e.value() === 'Q' && (() => { const ok2 = rects.find((r) => r.id === 'ok'); return J(e.pointer({ kind: 'click', x: ok2.x + 5, y: ok2.y + 5 })) === J({ id: 'e', ok: true, value: 'Q' }); })());
  e = mk();
  t('pointer: a click beside the keys and the wheel do nothing', () => e.pointer({ kind: 'click', x: 2, y: 2 }) === null && e.pointer({ kind: 'wheel', steps: 3 }) === null && e.pointer(null) === null && e.value() === '' && e.state().row === 0);
  // ---- the mask, the view
  e = mk({ mask: '-', value: 'secret' });
  t('the mask hides the value: the view shows the mask character for every character typed, never the text; value() has the text', () => e.view().value === '------' && e.view().masked === true && !J(e.view()).includes('secret') && e.value() === 'secret' && e.view().length === 6);
  e = mk({ value: 'ab' });
  t('the view is plain JSON with everything the renderer draws (title, value, caret, the key rows, the chips, the cursor, a hint)', () => { const v = e.view(); return plainBad(v).length === 0 && J(JSON.parse(J(v))) === J(v) && v.title === 'TITLE?' && v.value === 'ab' && v.caret === 2 && v.rows.length === 4 && v.rows[0].length === 13 && v.fn.length === 5 && J(v.cursor) === J({ row: 0, col: 0 }) && /B: delete/.test(v.hint) && /SELECT: abc/.test(v.hint) && v.charset === 'name' && v.id === 'e'; });
  t('speak: an entry is worded for a screen reader (the title, what is typed, the key the cursor is on); a masked one never says its text', () => /TITLE\? Text entry: "ab", 2 of 10\. Key: A\./.test(TE.speakEntry(e.view())) && !/secret/.test(TE.speakEntry(mk({ mask: '-', value: 'secret' }).view())) && /6 characters/.test(TE.speakEntry(mk({ mask: '-', value: 'secret' }).view())) && TE.speakEntry(null) === '');
  // ---- the slot
  const slot = TE.createEntrySlot(); let got = null;
  t('a closed slot passes every input on (undefined) and has no view', () => slot.isOpen() === false && slot.press('a') === undefined && slot.pointer({ kind: 'click', x: 20, y: 60 }) === undefined && slot.type({ text: 'x' }) === undefined && slot.hit(20, 60) === undefined && slot.view() === null && slot.rects().length === 0 && slot.entry() === null);
  slot.open({ id: 'n', title: 'T', value: '', max: 5, charset: 'name' }, (r) => { got = r; return r.ok ? [{ app: 'x', type: 'named', value: r.value }] : []; });
  t('slot: an open slot takes every input ([] while the entry stays open) and has the entry\'s view', () => slot.isOpen() && J(slot.press('a')) === '[]' && J(slot.type({ text: 'b' })) === '[]' && J(slot.pointer({ kind: 'move', x: 20, y: 60 })) === '[]' && slot.view().value === 'Ab' && slot.hit(1, 1) === null && slot.rects().length === 57);
  const fx = slot.type({ key: 'enter' });
  t('slot: when the entry finishes the slot hands the result to the function it was opened with, returns that function\'s effects, and is empty again', () => J(fx) === J([{ app: 'x', type: 'named', value: 'Ab' }]) && J(got) === J({ id: 'n', ok: true, value: 'Ab' }) && !slot.isOpen() && slot.press('a') === undefined);
  slot.open({ id: 'n', title: 'T', value: '', max: 5, charset: 'name' }, () => undefined);
  t('slot: a cancel reaches the function too, a function that returns nothing gives [], and close() drops an entry without a result', () => J(slot.press('b')) === '[]' && !slot.isOpen() && (slot.open({ id: 'n', title: 'T', max: 5, charset: 'name' }), slot.close(), !slot.isOpen() && slot.view() === null));
  // ---- the field window
  const fwBad = [];
  let seed = 12345; const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const n = rnd(300), widths = Array.from({ length: n }, () => 3 + rnd(6)), caret = rnd(n + 1), px = 40 + rnd(200), w = TE.fieldWindow(widths, caret, px);
    const sum = (a, b) => widths.slice(a, b).reduce((x, y) => x + y, 0), total = sum(0, n);
    if (w.start < 0 || w.end > n || w.start > caret || w.end < caret) fwBad.push('the caret left the window ' + J([n, caret, w]));
    else if (sum(w.start, w.end) > px) fwBad.push('wider than the field ' + J([n, caret, px, w]));
    else if (w.caretX !== sum(w.start, caret)) fwBad.push('caretX ' + J(w));
    else if (total <= px && (w.start !== 0 || w.end !== n)) fwBad.push('a value that fits is cut ' + J(w));
    else if (total > px && w.start > 0 && w.end < n && sum(w.start - 1, w.end) <= px && sum(w.start, w.end + 1) <= px) fwBad.push('room left on both sides ' + J([n, caret, px, w]));
    else if (total > px && caret < n && w.end === caret && widths[caret] <= px - sum(w.start, caret) + widths[w.start]) { /* the next character did not fit beside the ones before the caret: allowed only when nothing before it could be given up, which the fill above already used */ }
  }
  t('fieldWindow: for 400 random values the window holds the caret, is never wider than the field, shows a value that fits whole, and wastes no room', () => fwBad.length === 0, () => fwBad.slice(0, 2).join(' | '));
  t('fieldWindow: a long value shows up to three characters after the caret (the player sees what the caret is in front of)', () => { const w = Array(100).fill(6), a = TE.fieldWindow(w, 50, 60), b = TE.fieldWindow(w, 100, 60), c = TE.fieldWindow(w, 0, 60); return a.end === 53 && a.start === 43 && b.end === 100 && b.start === 90 && c.start === 0 && c.end === 10 && c.caretX === 0 && b.caretX === 60; });
  return f;
}

/* ================================================================================================ M. hub_menu.js */
function checkMenu(K) {
  const { f, t } = tester(), { MN, HM } = K;
  const rows = () => [{ id: 'go', kind: 'item', label: 'GO' }, { id: 'fmt', kind: 'choice', label: 'FORMAT', value: '3v3' }, { id: 'off', kind: 'item', label: 'OFF', disabled: true }, { id: 'back', kind: 'button', label: 'BACK' }];
  let m = MN.createMenu();
  t('pitch: the row spacing is the hub\'s own rule for every row count', () => Array.from({ length: 12 }, (_, i) => i + 1).every((n) => MN.menuPitchFor(n) === HM.menuPitch(n)) && J(MN.MENU) === J({ x: HM.GEOM.menu.x, y: HM.GEOM.menu.y, w: HM.GEOM.menu.w }));
  t('up from the first row wraps to the last, down from the last to the first', () => { const a = m.press('up', rows()); const b = m.press('down', rows()); return a.kind === 'move' && a.index === 3 && b.index === 0 && m.cursor() === 0; });
  t('A on an item or a button row chooses it', () => { const r = m.press('a', rows()); return r.kind === 'choose' && r.row.id === 'go' && r.index === 0; });
  m.press('down', rows());
  t('left / right on a choice row change it (-1 / +1), and A on it is +1; on another row they do nothing', () => { const l = m.press('left', rows()), r = m.press('right', rows()), a = m.press('a', rows()); m.press('up', rows()); const n = m.press('left', rows()); m.press('down', rows()); return l.kind === 'change' && l.dir === -1 && r.dir === 1 && a.kind === 'change' && a.dir === 1 && a.row.id === 'fmt' && n === null; });
  m.press('down', rows());
  t('A on a disabled row is refused, not chosen', () => { const r = m.press('a', rows()); return r.kind === 'refused' && r.row.id === 'off'; });
  t('B is back; an unknown action is nothing', () => m.press('b', rows()).kind === 'back' && m.press('x', rows()) === null && m.press('banana', rows()) === null);
  const rc = m.rects(rows());
  t('hit: four rows 16 px apart in the hub\'s menu window; the middle and the edges of each are that row; beside and below are misses', () => rc.length === 4 && rc.every((r, i) => r.y === 10 + i * 16 && r.h === 16 && [r.y, r.y + 8, r.y + 15].every((y) => { const h = m.hit(60, y, rows()); return h && h.index === i; })) && m.hit(2, 20, rows()) === null && m.hit(60, 10 + 64, rows()) === null && m.hit(60, 9, rows()) === null && m.hit(60, 20, []) === null);
  t('pointer: a hover moves the cursor; a click is cursor + A; a click on the left half of a choice row is -1; a click on a disabled row is refused; a miss is nothing', () => { const h = m.pointer({ kind: 'move', x: 60, y: 14 }, rows()), c = m.pointer({ kind: 'click', x: 100, y: 14 }, rows()), l = m.pointer({ kind: 'click', x: 60, y: 30 }, rows()), r = m.pointer({ kind: 'click', x: 120, y: 30 }, rows()), d = m.pointer({ kind: 'click', x: 60, y: 46 }, rows()), n = m.pointer({ kind: 'click', x: 2, y: 2 }, rows()); return h.kind === 'move' && h.index === 0 && c.kind === 'choose' && c.row.id === 'go' && l.kind === 'change' && l.dir === -1 && r.dir === 1 && d.kind === 'refused' && n === null && m.pointer(null, rows()) === null; });
  t('pointer: the wheel steps the cursor', () => { m.setCursor(0); m.pointer({ kind: 'wheel', steps: 2 }, rows()); const a = m.cursor(); m.pointer({ kind: 'wheel', steps: -1 }, rows()); return a === 2 && m.cursor() === 1; });
  t('view: what h.drawMenu draws (the rows as copies, the cursor clamped to the rows there are, the window\'s place)', () => { m.setCursor(9); const v = m.view(rows()); const own = MN.createMenu({ x: 20, y: 30, w: 200 }).view(rows()); return v.cursor === 3 && v.rows.length === 4 && v.rows[1].value === '3v3' && v.x === 12 && v.y === 10 && v.w === 124 && own.x === 20 && own.y === 30 && own.w === 200 && plainBad(v).length === 0 && m.view([]).cursor === 0; });
  t('select(id): puts the cursor on a row by its id', () => m.select('fmt', rows()) === true && m.cursor() === 1 && m.select('nope', rows()) === false && m.cursor() === 1);
  return f;
}

/* ================================================================================================ X. the stubs and their ctls */
async function checkStubs(K) {
  const { f, t } = tester(), { HM } = K;
  const mk = () => { const m = HM.createHubModel({ mascot: 25 }); m.setData(FAKE_DATA); return m; };
  // ---- PLAY ONLINE
  let m = mk(); toRow(m, 'online'); let e = m.press('a');
  t('online: the screen has TRAINER CENTER / BATTLE ONLINE / BACK and a message for the row', () => m.path() === 'online' && J(m.view().menu.rows.map((r) => r.label)) === J(['TRAINER CENTER', 'BATTLE ONLINE', 'BACK']) && m.view().msg.length === 2 && m.view().online.title === 'PLAY ONLINE' && m.view().mascot === null, () => J(m.view()));
  e = press(m, 'down', 'a');
  t('online: BATTLE ONLINE asks its ctl to open the battle page (one effect with app: online)', () => J(e) === J([{ app: 'online', type: 'open-battle' }]) && m.path() === 'online', () => J(e));
  e = press(m, 'up', 'a');
  t('online: TRAINER CENTER opens the Center screen', () => m.path() === 'center' && e.length === 1 && e[0].path === 'center' && m.view().app === 'center', () => J(e));
  // ---- THE CENTER
  const s0 = m.view().center.seconds; for (let i = 0; i < 125; i++) m.tick();
  t('center: it counts the seconds the player has been there (tick(path) once a frame), so its view changes while nothing is pressed', () => s0 === 0 && m.view().center.seconds === 2 && m.state().apps.center.ticks === 125, () => J(m.view().center));
  m.dialog.open({ id: 'chal', app: 'center', pages: [['RED wants to battle you.', '']], choice: { options: ['YES', 'NO'], cursor: 1 } }); e = press(m, 'up', 'a');
  t('center: a dialog opened for it is answered into its model (onDialog) and its picture says so', () => J(e) === J([{ type: 'dialog', id: 'chal', value: 0, app: 'center' }]) && J(m.state().apps.center.answer) === J({ id: 'chal', value: 0 }) && m.view().center.lines.includes('ANSWER: 0') && m.path() === 'center', () => J(e));
  e = m.press('b');
  t('center: B goes back to PLAY ONLINE (its parent), as a step back', () => m.path() === 'online' && e[0].back === true, () => J(e));
  m.press('a'); for (let i = 0; i < 70; i++) m.tick(); m.press('b'); m.press('a');
  t('center: entering it again starts the count again', () => m.path() === 'center' && m.view().center.seconds === 0);
  m.press('b'); e = m.press('b');
  t('online: B goes back to the main menu with the cursor on PLAY ONLINE', () => m.path() === 'main' && m.rows()[m.state().cursor.main].id === 'online');
  // ---- THE TEAM BUILDER
  m = mk(); toRow(m, 'builder'); m.press('a');
  t('builder: the screen has NAME / TEAM CODE / OPEN TEAM BUILDER / BACK; no entry is open', () => J(m.view().menu.rows.map((r) => r.id)) === J(['name', 'code', 'editor', 'back']) && m.view().menu.rows[0].label === 'NAME: -' && m.view().entry === null && m.wantsText() === false, () => J(m.view().menu.rows));
  e = m.press('a');
  t('builder: A on NAME opens a text entry for a name of up to 10 characters, and the hub then wants text', () => e.length === 0 && m.wantsText() === true && m.view().entry.id === 'name' && m.view().entry.charset === 'name' && m.view().entry.max === 10 && m.view().entry.title === 'YOUR NAME?' && m.path() === 'builder', () => J(m.view().entry));
  e = m.type({ text: 'Red' });
  t('builder: typed text goes into the entry', () => e.length === 0 && m.view().entry.value === 'Red' && m.state().apps.builder.entry.value === 'Red');
  press(m, 'right'); e = m.press('a');
  t('builder: while the entry is open the d-pad and A drive the picture\'s keys, not the rows under it', () => m.view().entry.value === 'RedB' && m.view().menu.cursor === 0 && m.path() === 'builder');
  e = m.type({ key: 'enter' });
  t('builder: OK closes the entry, the row shows what was typed, and the ctl is told ({ app: builder, type: named, value })', () => J(e) === J([{ app: 'builder', type: 'named', value: 'RedB' }]) && m.wantsText() === false && m.view().entry === null && m.view().menu.rows[0].label === 'NAME: RedB' && m.view().builder.lines[0] === 'HELLO, RedB', () => J(e) + J(m.view().menu.rows[0]));
  m.press('a'); m.type({ text: 'x' }); e = m.type({ key: 'escape' });
  t('builder: Escape cancels the entry: nothing changes and nothing is told', () => e.length === 0 && m.view().entry === null && m.view().menu.rows[0].label === 'NAME: RedB');
  m.press('a'); for (let i = 0; i < 4; i++) m.press('b'); e = m.press('b');
  t('builder: B deletes, and B on the emptied field cancels the entry without leaving the screen', () => e.length === 0 && m.path() === 'builder' && m.view().entry === null && m.view().menu.rows[0].label === 'NAME: RedB', () => J(m.state().apps.builder));
  press(m, 'down'); m.press('a'); e = m.type({ text: LONG_CODE });
  t('builder: TEAM CODE takes a 1024-character paste', () => m.view().entry.charset === 'teamcode' && m.view().entry.length === 1024 && m.view().entry.max === 1024, () => String(m.view().entry.length));
  e = m.press('start');
  t('builder: START accepts it; the row counts it', () => J(e) === J([{ app: 'builder', type: 'coded', length: 1024 }]) && m.view().menu.rows[1].label === 'TEAM CODE: 1024' && m.state().apps.builder.code === LONG_CODE);
  press(m, 'down'); e = m.press('a');
  t('builder: OPEN TEAM BUILDER asks its ctl to open the team builder page', () => J(e) === J([{ app: 'builder', type: 'open-editor' }]));
  press(m, 'up', 'up'); m.press('a'); m.type({ text: 'zz' }); e = m.goto('main');
  t('builder: a screen that closes takes its entry with it (the browser\'s Back button under an open entry)', () => m.path() === 'main' && m.wantsText() === false && (m.goto('builder'), m.view().entry === null && m.view().menu.rows[0].label === 'NAME: RedB'));
  m = mk(); toRow(m, 'builder'); m.press('a'); m.pointer({ kind: 'click', x: 60, y: 10 + 8 });
  const kr = m.rects().find((r) => r.id === 'K'); e = m.pointer({ kind: 'click', x: kr.x + 4, y: kr.y + 4 });
  t('builder: a click on NAME opens the entry, and then hub.rects() / hub.hit() are the keys\' and a click on a key types it', () => m.view().entry.value === 'K' && m.rects().length === 57 && m.hit(kr.x + 4, kr.y + 4).kind === 'key' && m.hit(2, 2) === null);
  // ---- every stub view is worded, titled, plain
  const views = []; m = mk(); toRow(m, 'online'); m.press('a'); views.push(m.view()); m.press('a'); views.push(m.view()); m = mk(); toRow(m, 'builder'); m.press('a'); views.push(m.view()); m.press('a'); views.push(m.view());
  t('stubs: every view is plain JSON, is worded for a screen reader and has a page title', () => views.every((v) => plainBad(v).length === 0 && J(JSON.parse(J(v))) === J(v) && m.speak(v).length > 10) && ['online', 'center', 'builder'].every((p) => /^Pokemon Arena - /.test(m.title(p))) && /Text entry/.test(m.speak(views[3])) && /Play online/.test(m.speak(views[0])) && /Trainer Center/.test(m.speak(views[1])) && /Team Builder/.test(m.speak(views[2])));
  // ---- where each placeholder sits, and its picture
  t('stubs: the Center is reached through PLAY ONLINE, the other two from the main menu (the history a page opened at their address is given)', () => J(HM.arrivalTrail('center')) === J(['online', 'center']) && J(HM.arrivalTrail('online')) === J(['online']) && J(HM.arrivalTrail('builder')) === J(['builder']) && HM.parentOf('center') === 'online');
  {
    const { screen } = K.draw(), hashOf = (v) => L.fnv(screen.render(v).rgba);
    const full = (v) => { const fr = screen.render(v); if (fr.width !== 240 || fr.height !== 160 || fr.rgba.length !== 240 * 160 * 4) return false; for (let i = 3; i < fr.rgba.length; i += 4) if (fr.rgba[i] !== 255) return false; return true; };
    const pics = []; let mm = mk(); toRow(mm, 'online'); mm.press('a'); pics.push(['online', mm.view()]); mm.press('down'); pics.push(['online row 2', mm.view()]); mm.press('up'); mm.press('a'); pics.push(['center', mm.view()]);
    mm = mk(); toRow(mm, 'builder'); mm.press('a'); pics.push(['builder', mm.view()]); mm.press('down'); pics.push(['builder row 2', mm.view()]);
    t('stubs: every placeholder screen is a full opaque frame, each a different picture, with every message line inside the box', () => pics.every(([, v]) => full(v)) && new Set(pics.map(([, v]) => hashOf(v))).size === pics.length && pics.every(([, v]) => screen.widths(v).every((w) => w.px <= w.max)), () => pics.map(([l, v]) => l + ' ' + hashOf(v)).join());
  }
  // ---- the ctls, against a fake page
  const nav = [], sess = new Map(), redraws = { n: 0 };
  const env = (app) => ({ navigate: (u) => nav.push(u), session: { getItem: (k) => (sess.has(k) ? sess.get(k) : null), setItem: (k, v) => sess.set(k, String(v)) }, app, redraw: () => { redraws.n++; } });
  m = mk();
  const oc = K.ONC.createCtl(env(m.apps.online)), cc = K.CEC.createCtl(env(m.apps.center)), bc = K.BLC.createCtl(env(m.apps.builder));
  oc.enter('online'); oc.effect({ app: 'online', type: 'open-battle' }); oc.effect({ app: 'online', type: 'something-else' }); oc.leave('online');
  t('online ctl: open-battle leaves for the online battle page; anything else navigates nowhere; it remembers what it was asked, in order', () => J(nav) === J(['/pokemonarena/battle.html?online=1']) && J(oc.log) === J(['enter:online', 'effect:open-battle', 'effect:something-else', 'leave:online']), () => J(nav) + J(oc.log));
  nav.length = 0; bc.effect({ app: 'builder', type: 'named', value: 'Blue' }); bc.effect({ app: 'builder', type: 'open-editor' });
  t('builder ctl: a name is kept for this tab (session storage) and open-editor leaves for the team builder page', () => sess.get(K.BLC.NAME_KEY) === 'Blue' && J(nav) === J(['/pokemonarena/editor.html']), () => J([...sess]) + J(nav));
  bc.enter('builder');
  t('builder ctl: entering the screen puts the kept name back into the model and asks for a redraw; a name the model already has is left alone', () => m.state().apps.builder.name === 'Blue' && redraws.n === 1 && (sess.set(K.BLC.NAME_KEY, 'Green'), bc.enter('builder'), m.state().apps.builder.name === 'Blue' && redraws.n === 1));
  t('builder ctl: storage that throws or is missing is survived', () => { const c2 = K.BLC.createCtl({ navigate: () => {}, session: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }, app: m.apps.builder, redraw: () => {} }); c2.enter('builder'); c2.effect({ type: 'named', value: 'x' }); const c3 = K.BLC.createCtl({ navigate: () => {}, session: null, app: m.apps.builder, redraw: () => {} }); c3.enter('builder'); c3.effect({ type: 'named', value: 'x' }); return true; });
  cc.effect({ type: 'dialog', id: 'chal', value: 1, app: 'center' }); cc.dispose();
  t('center ctl: a dialog\'s answer arrives as an effect; dispose is heard', () => J(cc.log) === J(['effect:dialog:chal:1', 'dispose']));
  // ---- purity: the model and renderer files touch nothing outside themselves
  const strip = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const dirty = [];
  for (const file of ['hub_apps.js', 'hub_app_screens.js', 'hub_dialog.js', 'hub_menu.js', 'textentry.js', 'textentry_screen.js', 'online_hub.js', 'online_screen.js', 'center_hub.js', 'center_screen.js', 'builder_hub.js', 'builder_screen.js']) {
    const hitWord = strip(fs.readFileSync(path.join(K.dir, file), 'utf8')).match(/\b(localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|location\.|history\.|fetch\(|XMLHttpRequest|Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|requestAnimationFrame|import\s*\()/);
    if (hitWord) dirty.push(file + ': ' + hitWord[1]);
  }
  t('purity: the registry, the dialog layer, the menu, the text entry and every stub\'s model and renderer touch no DOM, storage, network, clock, timer or randomness, and import nothing lazily', () => dirty.length === 0, () => dirty.join('; '));
  const ctlText = strip(fs.readFileSync(path.join(K.dir, 'hub_app_ctls.js'), 'utf8'));
  t('ctls are lazy: hub_app_ctls.js only names the files inside functions (no static import), one per app', () => !/^\s*import\s/m.test(ctlText) && (ctlText.match(/\(\) => import\('\.\/[a-z]+_ctl\.js'\)/g) || []).length === 3);
  return f;
}

/* ================================================================================================ S. the renderers (from the ROM) */
function checkScreens(K) {
  const { f, t } = tester(), { TE, HM } = K, { ui, screen } = K.draw();
  const hash = (v, s = screen) => L.fnv(s.render(v).rgba);
  const opaque = (fr) => { if (fr.width !== 240 || fr.height !== 160 || fr.rgba.length !== 240 * 160 * 4) return false; for (let i = 3; i < fr.rgba.length; i += 4) if (fr.rgba[i] !== 255) return false; return true; };
  const base = { screen: 'main', env: 0, mascot: null, tick: 0, sound: false, title: false, about: null, menu: null, msg: ['', ''] };
  const withEntry = (e, tick = 0) => ({ ...base, tick, entry: e.view() });
  const mkE = (o) => TE.createTextEntry({ id: 'e', title: 'TITLE?', value: '', max: 16, charset: 'name', ...(o || {}) });
  // ---- every entry view is a full frame
  const views = [];
  for (const cs of TE.CHARSETS) {
    const e = mkE({ charset: cs, max: cs === 'teamcode' ? 1024 : 16 });
    views.push([cs + ' empty', withEntry(e)]);
    e.type({ text: cs === 'teamcode' ? LONG_CODE.slice(0, 300) : 'Ab1' }); views.push([cs + ' typed', withEntry(e)]);
    e.press('select'); views.push([cs + ' shifted', withEntry(e)]);
    for (let r = 0; r < 5; r++) { e.press('down'); e.press('right'); views.push([cs + ' cursor ' + r, withEntry(e)]); }
    e.type({ key: 'home' }); views.push([cs + ' caret home', withEntry(e)]);
  }
  views.push(['masked', withEntry(mkE({ mask: '-', value: 'secret' }))], ['full', withEntry(mkE({ value: 'WWWWWWWWWWWWWWWW' }))], ['long title', withEntry(mkE({ title: 'A TITLE THAT IS MUCH LONGER THAN THE WINDOW IS WIDE' }))]);
  const notOpaque = views.filter(([, v]) => !opaque(screen.render(v))).map(([l]) => l);
  t('opaque: all ' + views.length + ' entry views (four charsets, both pages, every row, long and short values) draw a full opaque 240x160 frame', () => views.length >= 39 && notOpaque.length === 0, () => notOpaque.join());
  // ---- the keys
  const keyBad = [];
  for (const [label, v] of views) {
    const Lr = screen.entry.layout(v.entry);
    for (const k of Lr.keys) { if (k.gx < k.x || k.gx + k.gw > k.x + k.w) keyBad.push(label + ': key ' + k.label + ' ' + k.gx + '+' + k.gw + ' outside ' + k.x + '+' + k.w); if (k.label === '?' && v.entry.rows[k.row][k.col] !== '?') keyBad.push(label + ': the font cannot draw ' + v.entry.rows[k.row][k.col]); if (k.gw < 3) keyBad.push(label + ': key ' + k.label + ' has no width'); }
    for (const c of Lr.chips) if (c.px > c.w - 4) keyBad.push(label + ': chip ' + c.label + ' ' + c.px + ' > ' + (c.w - 4));
    if (Lr.title.px > Lr.title.max || Lr.note.px > Lr.note.max) keyBad.push(label + ': title or note too wide');
    if (Lr.win.y + Lr.win.h + 6 > TE.TEGEOM.fn.y || Lr.keys.some((k) => k.y < Lr.win.y || k.y + k.h > Lr.win.y + Lr.win.h + 6)) keyBad.push(label + ': the keys leave their window or meet the chips');
  }
  t('every key label inside its cell: every key of every view is drawn within its own cell by a glyph the ROM font has, every chip label fits its chip, the title and the note fit their lines', () => keyBad.length === 0, () => keyBad.slice(0, 3).join('; '));
  t('the underscore key is drawn as the ROM\'s "/" (the font has no "_"), on the key and in the field', () => { const e = mkE({ charset: 'teamcode', max: 20, value: 'a_b' }), Lr = screen.entry.layout(e.view()); return Lr.keys.find((k) => e.view().rows[k.row][k.col] === '_').label === '/' && Lr.field.text === 'a/b' && ui.safeText('_') === '?'; });
  // ---- the field never overflows
  const fieldBad = []; let seed = 99; const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const alpha = { name: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'.!?,/&+:;()", code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', teamcode: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-', search: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'" };
  for (const cs of TE.CHARSETS) for (let k = 0; k < 60; k++) {
    const n = rnd(cs === 'teamcode' ? 1025 : 200), s = Array.from({ length: n }, () => alpha[cs][rnd(alpha[cs].length)]).join(''), e = mkE({ charset: cs, max: 1024, value: s, allowEmpty: true });
    for (let j = rnd(n + 1); j > 0; j--) e.type({ key: 'left' });
    const Lr = screen.entry.layout(e.view()), caret = e.state().caret;
    if (Lr.field.px > Lr.field.max) fieldBad.push(cs + ' ' + n + ': ' + Lr.field.px + ' > ' + Lr.field.max);
    if (Lr.field.start > caret || Lr.field.end < caret || Lr.field.caretX > Lr.field.px) fieldBad.push(cs + ' ' + n + ': the caret is outside the part shown');
    if (!opaque(screen.render(withEntry(e)))) fieldBad.push(cs + ' ' + n + ': not opaque');
  }
  t('the field never overflows: for 240 random values of every charset (up to 1024 characters, the caret anywhere) what is drawn fits the field and holds the caret', () => fieldBad.length === 0, () => fieldBad.slice(0, 3).join('; '));
  // ---- a 1024-character team code is usable
  {
    const e = mkE({ charset: 'teamcode', max: 1024, value: LONG_CODE }), glyphs = [...LONG_CODE].map((ch) => TE.glyphOf(ch));
    const at = () => screen.entry.layout(e.view()).field;
    const end = at(), seen = new Set(), bad = [];
    for (let i = end.start; i < end.end; i++) seen.add(i);
    for (let c = 1024; c > 0; c--) { e.type({ key: 'left' }); const w = at(); if (w.px > w.max) bad.push('too wide at ' + (c - 1)); if (w.text !== glyphs.slice(w.start, w.end).join('')) bad.push('wrong text at ' + (c - 1)); if (w.end - w.start < 30) bad.push('fewer than 30 characters shown at ' + (c - 1)); for (let i = w.start; i < w.end; i++) seen.add(i); }
    const home = at();
    t('a 1024-character team code is usable: at the end the field shows its tail (and that there is more to the left); at the start its head (and more to the right)', () => end.end === 1024 && end.clippedLeft && !end.clippedRight && end.text.endsWith('.1a2b') && home.start === 0 && home.clippedRight && !home.clippedLeft && home.text.startsWith('ARENA1.'), () => J([end.start, end.end, home.start, home.end]));
    t('a 1024-character team code is usable: walking the caret from the end to the start, the field always fits, always shows the code\'s own characters (30 or more of them), and every one of the 1024 is shown at some point', () => bad.length === 0 && seen.size === 1024, () => bad.slice(0, 3).join('; ') + ' seen ' + seen.size);
    e.type({ key: 'end' }); for (let i = 0; i < 500; i++) e.type({ key: 'left' }); e.type({ key: 'delete' }); e.type({ text: 'Q' });
    t('a 1024-character team code is usable: a character in the middle can be reached, deleted and typed again', () => e.value().length === 1024 && e.value()[524] === 'Q' && e.value().slice(0, 524) === LONG_CODE.slice(0, 524) && e.value().slice(525) === LONG_CODE.slice(525), () => e.value().slice(520, 530));
    t('a team code is set in the ROM\'s small font (more of it shows); a name in the normal one', () => screen.entry.layout(e.view()).field.font === 'small' && screen.entry.layout(mkE({ value: 'Red' }).view()).field.font === 'normal');
  }
  // ---- the picture follows the model
  const e1 = mkE({ value: 'Red' });
  const h0 = hash(withEntry(e1));
  t('an entry changes the picture: the same screen with and without an entry are different pictures', () => h0 !== hash(base) && hash(withEntry(e1)) === h0);
  t('the picture follows the cursor, the page, the value, the caret and the note', () => { const a = mkE({ value: 'Red' }); a.press('right'); const b = mkE({ value: 'Red' }); b.press('select'); const c = mkE({ value: 'Rex' }); const d = mkE({ value: 'Red' }); d.type({ key: 'left' }); const n = mkE({ value: 'Red' }); n.setNote('That name is taken.'); return new Set([h0, hash(withEntry(a)), hash(withEntry(b)), hash(withEntry(c)), hash(withEntry(d)), hash(withEntry(n))]).size === 6; });
  t('the chip under the cursor is drawn selected (the ROM\'s selected colours): moving along the chips changes the picture each time', () => { const x = mkE({ value: 'Red' }); x.press('up'); const hs = [hash(withEntry(x))]; for (let i = 0; i < 4; i++) { x.press('right'); hs.push(hash(withEntry(x))); } return new Set(hs).size === 5; });
  t('the count of characters is drawn (length/max), and a full field shows it in the ROM\'s red', () => { const a = mkE({ max: 16, value: 'Red' }), b = mkE({ max: 17, value: 'Red' }), full = mkE({ max: 3, value: 'Red' }), fr = screen.render(withEntry(full)); let red = 0; for (let i = 0; i < fr.rgba.length; i += 4) if (fr.rgba[i] === ui.TEXT.red[0] && fr.rgba[i + 1] === ui.TEXT.red[1] && fr.rgba[i + 2] === ui.TEXT.red[2] && i / 4 < 20 * 240 && (i / 4) % 240 > 150) red++; return hash(withEntry(a)) !== hash(withEntry(b)) && red > 10 && screen.entry.layout(a.view()).count.text === '3/16'; });
  t('the caret blinks with the hub\'s clock: shown for 32 ticks, hidden for 32', () => hash(withEntry(e1, 0)) === hash(withEntry(e1, 31)) && hash(withEntry(e1, 32)) !== h0 && hash(withEntry(e1, 64)) === h0);
  t('a masked entry draws the mask, not the text (two different secrets of one length are one picture)', () => hash(withEntry(mkE({ mask: '-', value: 'abcdef' }))) === hash(withEntry(mkE({ mask: '-', value: 'uvwxyz' }))) && hash(withEntry(mkE({ mask: '-', value: 'abcdef' }))) !== hash(withEntry(mkE({ value: 'abcdef' }))));
  const zap = (off, len) => { const z = rom.slice(); z.fill(0, off, off + len); return hash(withEntry(e1), K.HS.createHubScreen(K.BU.createBattleUi(z))); };
  t('provenance: zeroing the ROM\'s normal-font glyphs, or its text colours, changes the entry\'s picture; a byte-identical ROM gives the identical one', () => zap(0x60df24, 0x2000) !== h0 && zap(0x6cd02c, 32) !== h0 && hash(withEntry(e1), K.HS.createHubScreen(K.BU.createBattleUi(rom.slice()))) === h0);
  // ---- the dialog
  const m = K.model(); m.setData(FAKE_DATA);
  const plain = hash(m.view());
  m.dialog.open({ id: 'q', pages: [['RED wants to battle you.', '3v3, standard rules.']], choice: { options: ['YES', 'NO'], cursor: 1 } });
  const dv = m.view(), dh = hash(dv);
  t('a dialog changes the picture and is a full opaque frame; its cursor and its page change it again', () => dh !== plain && opaque(screen.render(dv)) && (m.press('up'), hash(m.view()) !== dh));
  t('a dialog\'s lines and options fit the message box and the options window (measured with the ROM font)', () => screen.widths(dv).filter((w) => /dialog/.test(w.what)).length === 4 && screen.widths(dv).every((w) => w.px <= w.max), () => J(screen.widths(dv)));
  const four = K.model(); four.dialog.open({ id: 'f', pages: [['Which one?', '']], choice: { options: ['3v3', '6v6', 'ANY FORMAT', 'CANCEL'], cursor: 2 } });
  t('four options with a long label still fit their window and the screen', () => { const c = four.view().dialog.choice; return c.x - 6 >= 0 && c.y - 6 >= 0 && c.y + c.h + 6 <= 112 && screen.widths(four.view()).every((w) => w.px <= w.max) && opaque(screen.render(four.view())); }, () => J(four.view().dialog.choice));
  // (an app of this suite's own whose one screen is a text entry: the shell's layers are tested on it, not on a product app)
  const b = K.model({ apps: [typerApp(TE)] }); b.goto('typer'); b.type({ text: 'Red' });
  const entryOnly = hash(b.view()); b.dialog.open({ id: 'q', pages: [['Keep this name?', '']], choice: { options: ['YES', 'NO'], cursor: 0 } });
  t('a dialog over an entry shows: the dialog is drawn last, over the text entry that is over the app', () => hash(b.view()) !== entryOnly && b.view().app === 'typer' && b.view().entry.value === 'Red' && !!b.view().dialog && (() => { const fr = screen.render(b.view()), c = b.view().dialog.choice, o = ((c.y + 2) * 240 + c.x + c.w - 2) * 4; return fr.rgba[o] === 255 && fr.rgba[o + 1] === 255 && fr.rgba[o + 2] === 255; })());
  // ---- the menu's place, the fallback, the measures
  t('a menu that carries its own place is drawn there (h.drawMenu follows menu.x / y / w)', () => { const rows = [{ id: 'a', kind: 'item', label: 'FIRST' }, { id: 'b', kind: 'choice', label: 'FORMAT', value: '3v3' }, { id: 'c', kind: 'button', label: 'BACK' }], v = { ...base, menu: K.MN.createMenu().view(rows) }, moved = { ...base, menu: K.MN.createMenu({ x: 40, y: 30, w: 150 }).view(rows) }; return hash(v) !== hash(base) && hash(moved) !== hash(v) && opaque(screen.render(moved)); });
  t('apps: a view of an app with no renderer listed draws a note instead of throwing', () => opaque(screen.render({ ...base, app: 'nobody', screen: 'nobody' })) && hash({ ...base, app: 'nobody', screen: 'nobody' }) !== hash(base));
  t('apps: the model\'s and the screen\'s measures agree (ctx.measure is the ROM font)', () => { const A = fakeApp('alpha', ['alpha']); K.model({ apps: [A.desc] }); return A.ctx().measure('normal', 'TRAINER CENTER') === ui.measure('normal', 'TRAINER CENTER') && A.ctx().measure('small', 'abc') === ui.measure('small', 'abc') && screen.measureFont('normal', 'W') === screen.measure('W') && A.ctx().msgPx === screen.msgPx; });
  // ---- half pixels
  {
    const fr = screen.frame(), r = { x: 10, y: 10, w: 41, h: 16 };
    screen.helpers.chip(fr, r, 'DEL', false);
    const ref = screen.frame(); ui.panel(ref, r.x, r.y, r.w, r.h, 'normal', true);
    const allowed = new Set([ui.TEXT.dark.join(), ui.TEXT.shadow.join()]);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const o = (y * 240 + x) * 4; allowed.add([ref.rgba[o], ref.rgba[o + 1], ref.rgba[o + 2]].join()); }
    const strange = new Set(); let ink = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const o = (y * 240 + x) * 4, k = [fr.rgba[o], fr.rgba[o + 1], fr.rgba[o + 2]].join(); if (!allowed.has(k)) strange.add(k); if (k === ui.TEXT.dark.join()) ink++; }
    t('an odd-width chip has clean colours: a label centred on a half pixel is drawn in the text\'s own two colours on the chip\'s (no channel smeared into its neighbour)', () => strange.size === 0 && ink > 20, () => [...strange].slice(0, 4).join(' | ') + ' ink ' + ink);
  }
  return f;
}

/* ================================================================================================ I. the interface as it is written down */
function checkInterface(K) {
  const { f, t } = tester(), { HM, HA } = K;
  const md = fs.readFileSync(K.dir === SRC ? path.join(root, 'pokemonarena', 'INAPP.md') : path.join(K.dir, 'INAPP.md'), 'utf8');          // (a mutant tree carries a copy of the document)
  const at = md.indexOf('## The app interface'), doc = at < 0 ? '' : md.slice(at);
  const named = (name) => doc.includes('`' + name + '`') || doc.includes('`' + name + '(');
  t('the document has the section "The app interface", and it is the last one', () => at > 0 && !/\n## /.test(doc.slice(4)));
  const A = fakeApp('alpha', ['alpha']); let ctxKeys = [], dlgKeys = [];
  try { HM.createHubModel({ mascot: 25, apps: [A.desc] }); ctxKeys = Object.keys(A.ctx()); dlgKeys = Object.keys(A.ctx().dialog); } catch (_e) { /* a contract this suite's fake app does not meet: the checks below say so */ }
  t('every method of the app contract is in the document (and the optional onDialog), and this suite\'s fake app meets the contract', () => HA.APP_METHODS.every(named) && named('onDialog') && ctxKeys.length > 0, () => HA.APP_METHODS.filter((m) => !named(m)).join() + ' ctx ' + ctxKeys.length);
  const CTX = ['profiles', 'activeId', 'dataState', 'go', 'back', 'path', 'measure', 'msgPx', 'notify', 'dialog'];
  t('the ctx an app is given has exactly the documented keys', () => J(ctxKeys) === J(CTX) && CTX.every(named) && J(dlgKeys) === J(['open', 'close', 'current']), () => J(ctxKeys));
  const boot = fs.readFileSync(path.join(K.dir, 'boot.js'), 'utf8'), envAt = boot.indexOf('const ctlEnv = (id) => ({'), envText = envAt < 0 ? '' : boot.slice(envAt, boot.indexOf('});', envAt));
  const ENV = ['win', 'doc', 'hook', 'model', 'app', 'store', 'whenStore', 'pack', 'rom', 'ui', 'navigate', 'input', 'storage', 'session', 'refreshData', 'redraw', 'run', 'freshSeed'];
  // (the keys of the object literal: split at the commas that are not inside a bracket, and take what stands before the colon)
  const envKeys = (() => { const body = envText.slice(envText.indexOf('({') + 2), parts = []; let depth = 0, cur = ''; for (const ch of body) { if ('({['.includes(ch)) depth++; else if (')}]'.includes(ch)) depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; } if (cur.trim()) parts.push(cur); return parts.map((p) => p.trim().split(':')[0].trim()).filter(Boolean); })();
  t('the env a ctl is given (boot.js ctlEnv) has exactly the documented keys', () => J(envKeys) === J(ENV) && ENV.every(named), () => J(envKeys));
  t('the page hands a ctl its calls in order and loads it through hub_app_ctls.js (boot.js names no app)', () => /APP_CTLS\[id\]/.test(boot) && /toCtl\(family, 'leave', familyPath\)/.test(boot) && /toCtl\(now, 'enter', p\)/.test(boot) && !/online_ctl|center_ctl|builder_ctl|online_hub|center_hub|builder_hub/.test(boot));
  const H = ['text', 'textRight', 'textCentre', 'width', 'fitFont', 'fitText', 'wrap', 'drawMenu', 'drawMessage', 'chip', 'SCREEN_W', 'SCREEN_H'];
  t('the helpers a renderer is given have exactly the documented names', () => J(Object.keys(K.draw().screen.helpers)) === J(H) && H.every(named), () => J(Object.keys(K.draw().screen.helpers)));
  t('the hub model exposes what the document says the page and the tests use', () => { const m = HM.createHubModel({ mascot: 25 }); return ['apps', 'app', 'appOf', 'dialog', 'tick', 'wantsText', 'type', 'speak', 'title', 'goto', 'press', 'pointer', 'hit', 'rects', 'view', 'state', 'setData', 'paths'].every((k) => k in m) && J(Object.keys(m.dialog)) === J(['open', 'close', 'current', 'isOpen']) && ['PATHS', 'parentOf', 'arrivalTrail', 'historySeedPlan'].every((k) => k in HM); });
  t('the document names the registries, the three exports of an app and every charset', () => ['hub_apps.js', 'hub_app_screens.js', 'hub_app_ctls.js', 'export const APP', 'export function createScreen(ui, h)', 'export function createCtl(env)', "'name'", "'code'", "'teamcode'", "'search'", 'createEntrySlot', 'A SECOND `open` WHILE ONE IS OPEN IS QUEUED'].every((x) => doc.includes(x)));
  return f;
}

/* ================================================================================================ the mutants */
const MUTANTS = [
  // ---- A: the registry and the delegation
  { fam: 'A', file: 'hub_model.js', name: 'a press is not handed to the open app', find: "      { const a = apps.of(S.path); if (a) return fxOf(a.press(S.path, action)); }\n", replace: '', expect: 'press reaches the app' },
  { fam: 'A', file: 'hub_model.js', name: 'a tick never reaches the app', find: "      if (a) fx = fx.concat(fxOf(a.tick(S.path)));", replace: '', expect: 'tick reaches the open app' },
  { fam: 'A', file: 'hub_model.js', name: 'every app is ticked whatever screen is open', find: "      const a = apps.of(S.path);\n      if (a) fx = fx.concat(fxOf(a.tick(S.path)));", replace: "      for (const a of Object.values(apps.handles())) fx = fx.concat(fxOf(a.tick(S.path)));", expect: 'the old screens are untouched' },
  { fam: 'A', file: 'hub_model.js', name: 'leave is never called', find: "    { const was = apps.of(S.path); if (was) was.leave(S.path); }          // (the app is told while its screen is still the open one)\n", replace: '', expect: 'leave: B from the app\'s first screen' },
  { fam: 'A', file: 'hub_model.js', name: 'leave is called after the screen changed', find: "    { const was = apps.of(S.path); if (was) was.leave(S.path); }          // (the app is told while its screen is still the open one)\n    S.from = S.path; S.path = path; S.flash = null;", replace: "    const wasPath = S.path, was = apps.of(S.path);\n    S.from = S.path; S.path = path; S.flash = null;\n    if (was) was.leave(wasPath);", expect: 'leave(old) while the old screen is still open' },
  { fam: 'A', file: 'hub_model.js', name: 'enter is never called', find: "    { const now = apps.of(path); if (now) now.enter(path); }\n", replace: '', expect: 'enter: opening an app path calls that app\'s enter(path) once' },
  { fam: 'A', file: 'hub_model.js', name: 'the view keeps what the app wrote for screen and app', find: "{ const a = apps.of(S.path); if (a) return { ...a.view(S.path, base), screen: S.path, app: a.id }; }", replace: "{ const a = apps.of(S.path); if (a) return a.view(S.path, base); }", expect: 'the view carries screen and app' },
  { fam: 'A', file: 'hub_model.js', name: 'B from a nested app screen goes to the main menu', find: "  return a ? a.parent(path) || 'main' : 'main';", replace: "  return 'main';", expect: 'nested: B goes to parent(path)' },
  { fam: 'A', file: 'hub_model.js', name: 'the data refresh reaches no app', find: "      return towerFx.concat(apps.onData());", replace: "      return towerFx;", expect: 'onData: after every data refresh' },
  { fam: 'A', file: 'hub_model.js', name: 'typed text reaches an app that did not ask for it', find: "return a && a.wantsText(S.path) ? fxOf(a.type(S.path, input)) : [];", replace: "return a ? fxOf(a.type(S.path, input)) : [];", expect: 'type is refused when the app does not want text' },
  { fam: 'A', file: 'hub_model.js', name: 'the hit test is not handed to the app', find: "      { const a = apps.of(S.path); if (a) return a.hit(S.path, x, y) || null; }\n", replace: '', expect: 'hit / rects / pointer reach the app' },
  { fam: 'A', file: 'hub_model.js', name: 'the app paths are not hub paths', find: "export const PATHS = Object.freeze([...HUB_PATHS, ...pathsOf(APPS)]);", replace: "export const PATHS = Object.freeze([...HUB_PATHS]);", expect: 'their paths are hub paths the address may name' },
  { fam: 'A', file: 'hub_model.js', name: 'the hub does not check its registry', find: "if (bad.length) throw new Error('the hub app registry is broken: ' + bad.join('; ')); }", replace: "}", expect: 'a hub model refuses a broken registry' },
  { fam: 'A', file: 'hub_apps.js', name: 'two apps may claim one path', find: "else if (seen.has(p)) bad.push(", replace: "else if (false) bad.push(", expect: 'a path claimed twice is refused' },
  { fam: 'A', file: 'hub_apps.js', name: 'a path outside the app\'s family is accepted', find: "|| !(p === a.id || p.startsWith(a.id + '-'))) bad.push(", replace: ") bad.push(", expect: 'a path not under its id is refused' },
  { fam: 'A', file: 'hub_apps.js', name: 'a parent loop is accepted', find: "if (q !== null && q !== 'main') bad.push(", replace: "if (false) bad.push(", expect: 'parents that never reach the main menu are refused' },
  { fam: 'A', file: 'hub_apps.js', name: 'an app may take a hub screen\'s name', find: "if (hubPaths.some((p) => p === a.id || p.startsWith(a.id + '-'))) bad.push(", replace: "if (false) bad.push(", expect: 'an app may not take the name of a hub screen' },
  { fam: 'A', file: 'hub_apps.js', name: 'a model with a method missing is accepted', find: "  for (const m of APP_METHODS) if (typeof app[m] !== 'function') bad.push(m + '() is missing');\n", replace: '', expect: 'a model without one of the contract\'s methods is refused by name' },
  { fam: 'A', file: 'hub_app_ctls.js', name: 'an app has no ctl listed', find: "  center: () => import('./center_ctl.js'),\n", replace: '', expect: 'the three lists (models, renderers, ctls) name the same apps' },
  // ---- D: the dialog layer
  { fam: 'D', file: 'hub_dialog.js', name: 'B answers the first option', find: "if (action === 'b') return answer(d.choice ? d.choice.options.length - 1 : 'closed');", replace: "if (action === 'b') return answer(d.choice ? 0 : 'closed');", expect: 'B answers the last option (NO)' },
  { fam: 'D', file: 'hub_dialog.js', name: 'A answers before the last page', find: "      if (!lastPage(d)) { d.page++; return []; }\n      return answer(d.choice ? d.choice.cursor : 'closed');", replace: "      return answer(d.choice ? d.choice.cursor : 'closed');", expect: 'pages: A turns the page' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the options are shown on every page', find: "const last = lastPage(d), r = d.choice && last ? rectsOf(d) : null;", replace: "const last = lastPage(d), r = d.choice ? rectsOf(d) : null;", expect: 'the options are shown with the LAST page only' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the timeout never fires', find: "return d.ticksLeft <= 0 ? answer('timeout') : [];", replace: "return [];", expect: 'timeout: a dialog with ticksLeft answers "timeout"' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the timeout fires one tick early', find: "return d.ticksLeft <= 0 ? answer('timeout') : [];", replace: "return d.ticksLeft <= 1 ? answer('timeout') : [];", expect: 'not one earlier' },
  { fam: 'D', file: 'hub_dialog.js', name: 'a second open replaces the first', find: "      Q.push(d); return true;", replace: "      Q.length = 0; Q.push(d); return true;", expect: 'queued: a second open while one is open is taken (true) and waits' },
  { fam: 'D', file: 'hub_dialog.js', name: 'a second open is shown before the first', find: "      Q.push(d); return true;", replace: "      Q.unshift(d); return true;", expect: 'the first stays the one shown' },
  { fam: 'D', file: 'hub_dialog.js', name: 'an id may be open twice', find: " || Q.some((x) => x.id === d.id)) return false;", replace: ") return false;", expect: 'an id that is already open or queued is refused' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the queue has no limit', find: "if (!d || Q.length >= DIALOG_QUEUE_MAX || ", replace: "if (!d || ", expect: 'one more is refused' },
  { fam: 'D', file: 'hub_dialog.js', name: 'a tap on the text answers the question', find: "return d.choice ? [] : answer('closed');                    // ... and closes a notice, but never answers a question", replace: "return answer(d.choice ? d.choice.cursor : 'closed');", expect: 'a tap on the text never answers a question' },
  { fam: 'D', file: 'hub_dialog.js', name: 'a hover answers', find: "return ev.kind === 'click' ? answer(h.index) : [];", replace: "return answer(h.index);", expect: 'a hover on an option highlights it and answers nothing' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the answer forgets which app asked', find: "    if (d.app) e.app = d.app;\n", replace: '', expect: 'the answer carries `app`' },
  { fam: 'D', file: 'hub_dialog.js', name: 'five options are accepted', find: "c.options.length > DIALOG_MAX_OPTIONS || ", replace: '', expect: 'a malformed dialog is refused' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the cursor does not wrap', find: "d.choice.cursor = (d.choice.cursor + dir + n) % n; return [];", replace: "d.choice.cursor = Math.max(0, Math.min(n - 1, d.choice.cursor + dir)); return [];", expect: 'it takes every press: down moves the dialog\'s cursor (it wraps)' },
  { fam: 'D', file: 'hub_dialog.js', name: 'the options window runs into the message box', find: "opt: Object.freeze({ right: 226, bottom: 100,", replace: "opt: Object.freeze({ right: 226, bottom: 124,", expect: 'on the screen and above the message box' },
  { fam: 'D', file: 'hub_dialog.js', name: 'close(id) only closes the dialog shown', find: "close(id) { const i = Q.findIndex((x) => x.id === id); if (i < 0) return false;", replace: "close(id) { const i = Q.length && Q[0].id === id ? 0 : -1; if (i < 0) return false;", expect: 'close(id): removes a queued dialog' },
  { fam: 'D', file: 'hub_model.js', name: 'an open dialog does not take the presses', find: "      if (dialog.isOpen()) return dialogFx(dialog.press(action));          // an open dialog takes every press, whatever is under it\n", replace: '', expect: 'it takes every press' },
  { fam: 'D', file: 'hub_model.js', name: 'an open dialog does not take the pointer', find: "      if (dialog.isOpen()) return dialogFx(dialog.pointer(ev));           // ... and every pointer event\n", replace: '', expect: 'a hover on an option highlights it and answers nothing' },
  { fam: 'D', file: 'hub_model.js', name: 'the app\'s model does not hear the answer', find: "      if (a && typeof a.onDialog === 'function') out = out.concat(fxOf(a.onDialog(e.id, e.value)));\n", replace: '', expect: 'the app\'s MODEL hears it first' },
  { fam: 'D', file: 'hub_model.js', name: 'a timeout is not reported', find: "      let fx = dialogFx(dialog.tick());", replace: "      dialog.tick(); let fx = [];", expect: 'timeout: a dialog with ticksLeft answers "timeout"' },
  { fam: 'D', file: 'hub_model.js', name: 'typed text goes under a dialog', find: "    wantsText() { if (dialog.isOpen()) return false; const a", replace: "    wantsText() { const a", expect: 'while a dialog is open over a text entry the hub does not want text' },
  { fam: 'D', file: 'hub_model.js', name: 'a dialog an app opens is nobody\'s', find: "open: (spec) => dialog.open({ ...spec, app: desc.id }), close: (id) => dialog.close(id), current: () => dialog.current() }),\n  }));", replace: "open: (spec) => dialog.open({ ...spec }), close: (id) => dialog.close(id), current: () => dialog.current() }),\n  }));", expect: 'ctx.dialog: a dialog an app opens through its ctx is its own' },
  { fam: 'D', file: 'hub_model.js', name: 'the dialog is always in the view', find: "function view() { const v = screenView(), d = dialog.view(); if (d) v.dialog = d; return v; }", replace: "function view() { const v = screenView(), d = dialog.view(); v.dialog = d; return v; }", expect: 'only while it is open' },
  // ---- E: the text entry model
  { fam: 'E', file: 'textentry.js', name: 'a room code keeps lower case', find: "case 'code': return /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase() : null;", replace: "case 'code': return /^[A-Za-z0-9]$/.test(ch) ? ch : null;", expect: 'code keeps upper case only' },
  { fam: 'E', file: 'textentry.js', name: 'the length cap is ignored', find: "ins = f.text.slice(0, Math.max(0, room));", replace: "ins = f.text;", expect: 'the length cap' },
  { fam: 'E', file: 'textentry.js', name: 'B on an empty field does not cancel', find: "      case 'b': if (S.value.length === 0) return finish(false); return S.caret > 0 ? backspace() : del();", replace: "      case 'b': return S.caret > 0 ? backspace() : del();", expect: 'B on an empty field cancels' },
  { fam: 'E', file: 'textentry.js', name: 'a real Backspace on an empty field cancels', find: "      case 'backspace': return backspace();", replace: "      case 'backspace': if (S.value.length === 0) return finish(false); return backspace();", expect: 'a real keyboard\'s Backspace on an empty field does nothing' },
  { fam: 'E', file: 'textentry.js', name: 'left does not wrap', find: "      case 'left': S.col = (S.col + rowLen(S.row) - 1) % rowLen(S.row); return null;", replace: "      case 'left': S.col = Math.max(0, S.col - 1); return null;", expect: 'd-pad: left from the first key wraps' },
  { fam: 'E', file: 'textentry.js', name: 'up does not wrap to the chips', find: "      case 'up': { const r = (S.row + rows - 1) % rows;", replace: "      case 'up': { const r = Math.max(0, S.row - 1);", expect: 'd-pad: up from the top row wraps to the chips' },
  { fam: 'E', file: 'textentry.js', name: 'a shorter row keeps the column number', find: "    return best;\n  }", replace: "    return Math.min(fromCol, rowLen(toRow) - 1);\n  }", expect: 'moving to a longer row takes the nearest key too' },
  { fam: 'E', file: 'textentry.js', name: 'text is added at the end, not at the caret', find: "    S.value = S.value.slice(0, S.caret) + ins + S.value.slice(S.caret); S.caret += ins.length;", replace: "    S.value = S.value + ins; S.caret += ins.length;", expect: 'caret: text is inserted at the caret' },
  { fam: 'E', file: 'textentry.js', name: 'SELECT does not switch the page', find: "      case 'select': return shift();", replace: "      case 'select': return null;", expect: 'SELECT switches the page too' },
  { fam: 'E', file: 'textentry.js', name: 'OK accepts an empty field', find: "    if (n < min) { S.note", replace: "    if (false) { S.note", expect: 'OK needs something typed' },
  { fam: 'E', file: 'textentry.js', name: 'a team code loses its underscores', find: "return /^[A-Za-z0-9._-]$/.test(ch) ? ch : null;", replace: "return /^[A-Za-z0-9.-]$/.test(ch) ? ch : null;", expect: 'teamcode: the underscore survives' },
  { fam: 'E', file: 'textentry.js', name: 'a search takes any punctuation', find: "return /^[A-Za-z0-9 '-]$/.test(ch) ? ch : null;", replace: "return /^[ -~]$/.test(ch) ? ch : null;", expect: 'search takes letters, digits, space, hyphen and apostrophe, and nothing else' },
  { fam: 'E', file: 'textentry.js', name: 'a name takes any character', find: "case 'name': if (ch === '\\u2019') return \"'\"; return romChar(ch) ? ch : null;", replace: "case 'name': if (ch === '\\u2019') return \"'\"; return ch;", expect: 'name: one character is accepted exactly when profile.js textIssue accepts it' },
  { fam: 'E', file: 'textentry.js', name: 'a click does not press the key', find: "    return ev.kind === 'click' ? activate() : null;", replace: "    return null;", expect: 'a click presses the key under it' },
  { fam: 'E', file: 'textentry.js', name: 'the keys are drawn a row low (they run into the chips)', find: "  if (row < rows) return { x: k.x + col * k.cell, y: k.y + row * k.pitch, w: k.cell, h: k.pitch };", replace: "  if (row < rows) return { x: k.x + col * k.cell, y: k.y + (row + 1) * k.pitch, w: k.cell, h: k.pitch };", expect: 'no two key rectangles overlap' },
  { fam: 'E', file: 'textentry.js', name: 'the mask leaks the value', find: "value: mask ? mask.repeat(S.value.length) : S.value, masked: !!mask,", replace: "value: S.value, masked: !!mask,", expect: 'the mask hides the value' },
  { fam: 'E', file: 'textentry.js', name: 'the field window may be wider than the field', find: "  while (start > 0 && used + widths[start - 1] <= px) { start--; used += widths[start]; }", replace: "  while (start > 0 && used <= px) { start--; used += widths[start]; }", expect: 'fieldWindow: for 400 random values' },
  { fam: 'E', file: 'textentry.js', name: 'the field window shows nothing after the caret', find: "  while (end < n && end < c + 3 && used + widths[end] <= px) { used += widths[end]; end++; }", replace: '', expect: 'a long value shows up to three characters after the caret' },
  { fam: 'E', file: 'textentry.js', name: 'a closed slot swallows the press', find: "    press: (a) => (cur ? settle(cur.press(a)) : undefined),", replace: "    press: (a) => (cur ? settle(cur.press(a)) : []),", expect: 'a closed slot passes every input on' },
  { fam: 'E', file: 'textentry.js', name: 'the slot keeps a finished entry', find: "    const fn = onDone; cur = null; onDone = null;", replace: "    const fn = onDone; onDone = null;", expect: 'is empty again' },
  { fam: 'E', file: 'textentry.js', name: 'a finished entry goes on taking input', find: "  function type(input) {\n    if (S.result) return S.result;", replace: "  function type(input) {", expect: 'after it finished an entry takes no more input' },
  { fam: 'E', file: 'textentry.js', name: 'the shift key says the page it is on', find: "label: page === 'lower' ? 'ABC' : 'abc' });", replace: "label: page === 'lower' ? 'abc' : 'ABC' });", expect: 'the shift key is labelled with the page it goes to' },
  // ---- M: the menu helper
  { fam: 'M', file: 'hub_menu.js', name: 'the menu does not wrap', find: "      case 'up': if (!n) return null; cursor = (cursor + n - 1) % n; return { kind: 'move', index: cursor };", replace: "      case 'up': if (!n) return null; cursor = Math.max(0, cursor - 1); return { kind: 'move', index: cursor };", expect: 'up from the first row wraps to the last' },
  { fam: 'M', file: 'hub_menu.js', name: 'a disabled row can be chosen', find: "    if (row.disabled) return { kind: 'refused', row, index: cursor };\n", replace: '', expect: 'A on a disabled row is refused' },
  { fam: 'M', file: 'hub_menu.js', name: 'the menu has its own row spacing', find: "export const menuPitchFor = (n) => (n > 7 ? 12 : n > 6 ? 14 : 16);", replace: "export const menuPitchFor = (n) => (n > 6 ? 12 : 16);", expect: 'the row spacing is the hub\'s own rule' },
  { fam: 'M', file: 'hub_menu.js', name: 'a click only moves the cursor', find: "    return activate(rows, h.zone === 'prev' ? -1 : 1);", replace: "    return { kind: 'move', index: cursor };", expect: 'a click is cursor + A' },
  // ---- X: the stubs and their ctls
  { fam: 'X', file: 'center_hub.js', name: 'the Center goes back to the main menu', find: "const parent = () => 'online';", replace: "const parent = () => 'main';", expect: 'center: B goes back to PLAY ONLINE' },
  { fam: 'X', file: 'center_hub.js', name: 'the Center does not tick', find: "    tick() { S.ticks++; },", replace: "    tick() {},", expect: 'center: it counts the seconds' },
  { fam: 'X', file: 'builder_hub.js', name: 'the builder never says it wants text', find: "    wantsText: () => entry.isOpen(),", replace: "    wantsText: () => false,", expect: 'A on NAME opens a text entry' },
  { fam: 'X', file: 'builder_hub.js', name: 'the builder\'s rows take the keys of an open entry', find: "    press(_path, action) { const fx = entry.press(action); return fx || act(menu.press(action, rows())); },", replace: "    press(_path, action) { entry.press(action); return act(menu.press(action, rows())); },", expect: 'the d-pad and A drive the picture\'s keys, not the rows under it' },
  { fam: 'X', file: 'builder_hub.js', name: 'an entry outlives its screen', find: "    leave() { entry.close(); },", replace: "    leave() {},", expect: 'a screen that closes takes its entry with it' },
  { fam: 'X', file: 'builder_hub.js', name: 'the name is not told to the ctl', find: "S.name = res.value.trim(); return [{ app: ID, type: 'named', value: S.name }]; });", replace: "S.name = res.value.trim(); return []; });", expect: 'the ctl is told' },
  { fam: 'X', file: 'online_ctl.js', name: 'BATTLE ONLINE goes nowhere', find: "      if (eff.type === 'open-battle') env.navigate(ONLINE_BATTLE_URL);\n", replace: '', expect: 'online ctl: open-battle leaves for the online battle page' },
  { fam: 'X', file: 'builder_ctl.js', name: 'the kept name is never put back', find: "      if (typeof kept === 'string' && kept && !env.app.state().name) { env.app.setName(kept); env.redraw(); }\n", replace: '', expect: 'builder ctl: entering the screen puts the kept name back' },
  { fam: 'X', file: 'online_hub.js', name: 'a stub model reads the clock', find: "    enter() { menu.setCursor(0); },\n    leave() {},\n    press: (_path, action) => act(menu.press(action, rows())),", replace: "    enter() { menu.setCursor(0); void Date.now(); },\n    leave() {},\n    press: (_path, action) => act(menu.press(action, rows())),", expect: 'purity' },
  // ---- I: the interface as it is written down
  { fam: 'I', file: 'hub_model.js', name: 'the ctx loses a documented key', find: "    measure: measureFont, msgPx,\n", replace: "    measure: measureFont,\n", expect: 'the ctx an app is given has exactly the documented keys' },
  { fam: 'I', file: 'boot.js', name: 'the env loses a documented key', find: "refreshData, redraw: () => { dirty = true; draw(true); }, run, freshSeed,", replace: "refreshData, redraw: () => { dirty = true; draw(true); }, run,", expect: 'the env a ctl is given (boot.js ctlEnv) has exactly the documented keys' },
  { fam: 'I', file: 'hub_screen.js', name: 'a renderer is given a helper the document does not name', find: "drawMenu, drawMessage, chip, SCREEN_W, SCREEN_H });", replace: "drawMenu, drawMessage, chip, pickFont, SCREEN_W, SCREEN_H });", expect: 'the helpers a renderer is given have exactly the documented names' },
  { fam: 'I', file: 'hub_apps.js', name: 'the contract gains a method the document does not name', find: "'speak', 'title', 'state']);", replace: "'speak', 'title', 'state', 'resize']);", expect: 'every method of the app contract is in the document' },
  // ---- S: the renderers
  { fam: 'S', file: 'textentry_screen.js', name: 'the field is not windowed (a long value runs out of its window)', find: "    const shown = units.slice(fw.start, fw.end).join('');", replace: "    const shown = units.join('');", expect: 'the field never overflows' },
  { fam: 'S', file: 'textentry_screen.js', name: 'a key label is drawn outside its cell', find: "gx: q.x + G.keys.glyph + Math.max(0,", replace: "gx: q.x + G.keys.cell + Math.max(0,", expect: 'every key label inside its cell' },
  { fam: 'S', file: 'textentry_screen.js', name: 'the underscore is drawn as a question mark', find: "  const glyph = (ch) => ui.safeText(glyphOf(ch));", replace: "  const glyph = (ch) => ui.safeText(ch);", expect: 'the underscore key is drawn as the ROM\'s "/"' },
  { fam: 'S', file: 'textentry_screen.js', name: 'the caret never hides', find: "    if ((((tick | 0) >> 5) & 1) === 0) text(f, 'small', '{UP}',", replace: "    if (true) text(f, 'small', '{UP}',", expect: 'the caret blinks with the hub\'s clock' },
  { fam: 'S', file: 'textentry_screen.js', name: 'the chip under the cursor looks like the others', find: "ui.panel(f, c.x, c.y, c.w, c.h, c.selected ? 'sel' : 'normal', true);", replace: "ui.panel(f, c.x, c.y, c.w, c.h, 'normal', true);", expect: 'the chip under the cursor is drawn selected' },
  { fam: 'S', file: 'textentry_screen.js', name: 'the count of characters is not drawn', find: "    textRight(f, 'normal', L.count.text, G.head.x + G.head.w - 2, G.title.y, ev.length >= ev.max ? TEXT.red : TEXT.dark);\n", replace: '', expect: 'the count of characters is drawn' },
  { fam: 'S', file: 'textentry_screen.js', name: 'a team code is set in the normal font', find: "  const fieldFont = (ev) => (ev.charset === 'teamcode' ? 'small' : 'normal');", replace: "  const fieldFont = () => 'normal';", expect: 'a team code is set in the ROM\'s small font' },
  { fam: 'S', file: 'hub_screen.js', name: 'the text entry is not drawn', find: "      if (view.entry) entry.draw(f, view.entry, view.tick | 0);          // a text entry covers the screen that opened it ...\n", replace: '', expect: 'an entry changes the picture' },
  { fam: 'S', file: 'hub_screen.js', name: 'the dialog is not drawn', find: "      if (view.dialog) drawDialog(f, view.dialog);                       // ... and a dialog sits over everything\n", replace: '', expect: 'a dialog changes the picture' },
  { fam: 'S', file: 'hub_screen.js', name: 'the dialog is drawn under the text entry', find: "      if (view.entry) entry.draw(f, view.entry, view.tick | 0);          // a text entry covers the screen that opened it ...\n      if (view.dialog) drawDialog(f, view.dialog);                       // ... and a dialog sits over everything\n", replace: "      if (view.dialog) drawDialog(f, view.dialog);\n      if (view.entry) entry.draw(f, view.entry, view.tick | 0);\n", expect: 'a dialog over an entry shows' },
  { fam: 'S', file: 'hub_screen.js', name: 'half a pixel smears the colours', find: "  blitRoles(bm, dx, dy, fg, shadow) {\n    dx = Math.floor(dx); dy = Math.floor(dy);\n", replace: "  blitRoles(bm, dx, dy, fg, shadow) {\n", expect: 'an odd-width chip has clean colours' },
  { fam: 'S', file: 'hub_screen.js', name: 'a menu\'s own place is ignored', find: "const g = { x: Number.isFinite(menu.x) ? menu.x : GEOM.menu.x, y: Number.isFinite(menu.y) ? menu.y : GEOM.menu.y, w: Number.isFinite(menu.w) ? menu.w : GEOM.menu.w }, n", replace: "const g = GEOM.menu, n", expect: 'a menu that carries its own place is drawn there' },
  { fam: 'X', file: 'hub_screen.js', name: 'an app\'s screen is not drawn by its renderer', find: "        if (a) a.render(f, view);\n", replace: "        if (a) drawMessage(f, ['', '']);\n", expect: 'every placeholder screen is a full opaque frame, each a different picture' },
];
const FAMILIES = { A: checkHost, D: checkDialog, E: checkEntry, M: checkMenu, X: checkStubs, I: checkInterface, S: checkScreens };
const FAMILY_NAMES = { A: 'the registry and the delegation', D: 'the dialog layer', E: 'the text entry model', M: 'the menu helper', X: 'the stubs and their ctls', I: 'the interface as it is written down', S: 'the renderers' };

const tmpDirs = [];
async function mutantStack(mu) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-apps-mut-')); tmpDirs.push(dir);
  for (const file of fs.readdirSync(SRC)) { const p = path.join(SRC, file); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, file)); }
  const target = path.join(dir, mu.file), text = fs.readFileSync(target, 'utf8'), n = text.split(mu.find).length - 1;
  if (n !== 1) throw new Error('the text to replace occurs ' + n + ' times (must be 1)');
  fs.writeFileSync(target, text.replace(mu.find, () => mu.replace));
  fs.copyFileSync(path.join(root, 'pokemonarena', 'INAPP.md'), path.join(dir, 'INAPP.md'));          // (the document the I family reads)
  return loadStack(dir);
}

let REAL = null;
try {
  REAL = await loadStack(SRC);
  for (const [fam, check] of Object.entries(FAMILIES)) {
    let real; try { real = await check(REAL); } catch (err) { real = ['the checks threw: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err)]; }
    ok(real.length === 0, fam + '. ' + FAMILY_NAMES[fam] + ': every check passes', real.slice(0, 6).join(' ;; '));
    if (process.env.ARENA_VERBOSE) for (const x of real) console.log('   failed: ' + x.slice(0, 600));
    let twin; try { twin = await check(REAL); } catch (err) { twin = ['threw: ' + (err && err.message)]; }
    ok(twin.length === 0, fam + '. unmutated twin stays quiet', twin.slice(0, 2).join(' ;; '));
  }
  if (WANT_MUTANTS) {
    for (const mu of MUTANTS) {
      let r; try { const Km = await mutantStack(mu); r = await FAMILIES[mu.fam](Km); } catch (err) { r = ['threw: ' + (err && err.message)]; }
      ok(r.length > 0 && r.some((x) => x.includes(mu.expect)), mu.fam + '. mutant "' + mu.name + '" (' + mu.file + ') trips the named check "' + mu.expect + '"', r.length ? r.slice(0, 3).map((x) => x.slice(0, 160)).join(' || ') : 'NOT CAUGHT');
    }
  }
} finally { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ } } }

if (UNIT_ONLY) { C.finish(); process.exit(process.exitCode || 0); }

/* ================================================================================================ browser sessions */

const HUB = '__arenaHub';
const HM = REAL.HM, nodeScreen = REAL.draw().screen;
const where = (page) => page.eval(`${HUB}.model.path()`);
const navs = (page) => page.eval('window.__nav.slice()');
const hash = (page) => page.eval('location.hash');
const mcur = (page) => page.eval(`${HUB}.view().menu ? ${HUB}.view().menu.cursor : -1`);
const entryOf = (page) => page.eval(`${HUB}.model.state().apps.builder.entry`);
const builderOf = (page) => page.eval(`${HUB}.model.state().apps.builder`);
const live = (page) => page.eval(`document.getElementById('live').textContent`);
const shot = async (page, name) => { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* a screenshot is evidence, not the test */ } };
const rowY = (i, n = 6) => HM.GEOM.menu.y + i * HM.menuPitch(n) + (HM.menuPitch(n) >> 1);
const mainY = (i) => rowY(i, 8);
// a FRESH page every time (through about:blank): an address that differs only by its #hash would otherwise be a same-document step, not a boot
async function boot(page, q = '', base = BASE) {
  await page.navigate('about:blank');
  await page.navigate(base + '/pokemonarena/' + q);
  await page.waitFor(`window.${HUB} && ${HUB}.state !== 'boot'`, { timeoutMs: 90000 });
  const st = await page.eval(`({ state: ${HUB}.state, error: ${HUB}.error })`);
  if (st.state === 'ready') { await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`); await page.eval(`window.__nav = []; window.__arenaNavigate = (u) => { window.__nav.push(u); }`); }
  return st.state;
}
const waitOk = async (page, expr, ms = 8000) => { try { await page.waitFor(expr, { timeoutMs: ms, pollMs: 60 }); return true; } catch (_e) { return false; } };
// one real key press (keydown + keyup through the browser's own input pipeline); mods: 1 alt, 2 ctrl, 4 meta, 8 shift
async function hitKey(page, k, code, vk, mods = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(25);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await sleep(25);
}
const letter = (page, ch) => hitKey(page, ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), ch !== ch.toLowerCase() ? 8 : 0);
const NAMED = { enter: ['Enter', 'Enter', 13], esc: ['Escape', 'Escape', 27], back: ['Backspace', 'Backspace', 8], del: ['Delete', 'Delete', 46], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], home: ['Home', 'Home', 36], end: ['End', 'End', 35], space: [' ', 'Space', 32] };
const named = (page, n, mods = 0) => hitKey(page, NAMED[n][0], NAMED[n][1], NAMED[n][2], mods);
// a paste, as the browser delivers one: a ClipboardEvent on the focused element (the machine's clipboard is never read or written)
const paste = (page, text) => page.eval(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${J(text)}); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); (document.activeElement || document.body).dispatchEvent(ev); return ev.defaultPrevented; })()`);
// the logical centre of a key of the open text entry (by its id: the character, or the chip's id), or of an option of the open dialog
const keyPoint = (page, id) => page.eval(`(() => { const r = ${HUB}.model.rects().find((x) => x.id === ${J(id)}); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; })()`);
const optPoint = (page, i) => page.eval(`(() => { const r = ${HUB}.model.rects()[${i}]; return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; })()`);
// the page's canvas against what Node draws for the page's own view (the pixels the Node suites judged are the pixels a player sees)
async function sameAsNode(page) {
  await sleep(120);
  const r = await page.eval(`({ view: ${HUB}.view(), canvas: ${HUB}.canvasHash(), frame: ${HUB}.frameHash() })`);
  return { ok: r.canvas === r.frame && L.fnv(nodeScreen.render(r.view).rgba) === r.canvas, canvas: r.canvas, frame: r.frame, node: L.fnv(nodeScreen.render(r.view).rgba) };
}
const YESNO = (o) => J({ id: 'chal', app: 'center', pages: [['RED wants to battle you.', '3v3, standard rules.']], choice: { options: ['YES', 'NO'], cursor: 1 }, ...(o || {}) });

async function runSession(name, opts, fn) {
  console.log('--- ' + name + ' (' + opts.width + 'x' + opts.height + (opts.mobile ? ' mobile' : '') + ') ' + loadPct());
  try {
    await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
      await page.setViewport(opts.width, opts.height, { mobile: !!opts.mobile, dpr: opts.dpr || 1 });
      await addInit(page, AUDIO_DOUBLE);
      if (opts.pad) await addInit(page, PAD_DOUBLE);
      await fn(page);
    });
  } catch (e) { ok(false, name + ': session threw', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}

// what "a real keyboard types and presses no button" means, as one function, so the control session can show that it fails when the keyboard capture is off
async function typingFacts(page) {
  await page.eval(`${HUB}.model.goto('main'); ${HUB}.model.goto('builder')`); await sleep(80);
  await key(page, 'a'); await sleep(200);                                                      // Enter on NAME
  const r = { opened: await page.eval(`${HUB}.wantsText()`) };
  await page.eval(`window.__nav.length = 0`);
  for (const ch of 'zxwasdmp') await letter(page, ch);
  await sleep(120);
  r.entry = await entryOf(page); r.path = await where(page); r.sound = await page.eval(`${HUB}.sound.on()`); r.navs = (await navs(page)).length; r.wants = await page.eval(`${HUB}.wantsText()`);
  return r;
}
const TYPING_CHECKS = (r) => [
  ['Enter on NAME opens the text entry', r.opened === true],
  ['Z X W A S D M P are typed as letters: the field reads "zxwasdmp"', !!r.entry && r.entry.value === 'zxwasdmp'],
  ['none of them was a button: the entry is still open (X is not B), the key cursor has not moved (W A S D are not the d-pad), nothing was typed by A (Z is not A)', r.wants === true && !!r.entry && r.entry.row === 0 && r.entry.col === 0 && r.entry.value.length === 8],
  ['the screen has not changed and nothing navigated (P is not START, X did not go back)', r.path === 'builder' && r.navs === 0],
  ['M did not mute the sound', r.sound === true],
];

let server = null;
try {
  console.log('before the browser: ' + loadPct() + '; reaping leaked browsers');
  L.reapLeaks();
  server = await L.startServer();
  console.log('dev server up on ' + BASE + ' (node tools/devserver.mjs, Range-capable)');
  fs.mkdirSync(OUT, { recursive: true });
  let cdp = CDP0;

  /* ---------------------------------------------------------------------------------------- desktop: keyboard and mouse */
  if (wants('keys')) await runSession('desktop, keyboard and mouse', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'keys: ';
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    ok(J(await page.eval(`${HUB}.apps.ids`)) === J(['online', 'center', 'builder']) && J(await page.eval(`${HUB}.apps.loaded()`)) === '[]' && (await page.eval(`${HUB}.apps.family()`)) === null, tag + 'the hub hosts three apps and has loaded NO ctl before one is needed', J(await page.eval(`${HUB}.apps.loaded()`)));
    ok(J(await page.eval(`${HUB}.model.rows().map((r) => r.id)`)) === J(['quick', 'team', 'online', 'tower', 'builder', 'record', 'import', 'controls', 'sound', 'about']), tag + 'the main menu: QUICK BATTLE, BATTLE WITH MY TEAM, PLAY ONLINE, TOWER, TEAM BUILDER, RECORD, IMPORT SAVE, CONTROLS, SOUND, ABOUT', J(await page.eval(`${HUB}.model.rows().map((r) => r.label)`)));
    ok((await page.eval(`!!document.getElementById('onlineLink') && !!document.getElementById('playFriend') && !!document.getElementById('openToggle')`)) === true, tag + 'the row under the picture is left as it was (the online work removes it)');
    // ---- PLAY ONLINE by keyboard
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(150);
    ok((await where(page)) === 'online' && (await hash(page)) === '#online' && (await page.eval('document.title')) === 'Pokemon Arena - Play Online' && (await page.eval('history.state && history.state.arenaHub')) === 'online', tag + 'down, down, Enter opens PLAY ONLINE: #online, its own history entry, the title follows', (await where(page)) + ' ' + (await hash(page)) + ' ' + (await page.eval('document.title')));
    ok(await waitOk(page, `${HUB}.apps.loaded().includes('online') && ${HUB}.apps.ctl('online').log.join() === 'enter:online'`), tag + 'entering the screen loads the app\'s ctl (online_ctl.js) and tells it enter(online)', J(await page.eval(`${HUB}.apps.loaded()`)));
    ok(J(await page.eval(`${HUB}.apps.loaded()`)) === J(['online']) && (await page.eval(`${HUB}.apps.family()`)) === 'online', tag + 'only that app\'s ctl is loaded');
    ok(/Play online\. TRAINER CENTER\./.test(await live(page)), tag + 'the screen reader hears the app\'s own words', await live(page));
    let same = await sameAsNode(page);
    ok(same.ok, tag + 'the canvas is, pixel for pixel, what Node draws for the page\'s view of PLAY ONLINE', J(same));
    await shot(page, 'apps_keys_1_online');
    await key(page, 'a'); await sleep(150);
    ok((await where(page)) === 'center' && (await hash(page)) === '#center' && (await page.eval('document.title')) === 'Pokemon Arena - Trainer Center', tag + 'Enter on TRAINER CENTER opens the Center screen (#center)', await where(page));
    ok(await waitOk(page, `${HUB}.apps.loaded().includes('center') && ${HUB}.apps.ctl('center').log.join() === 'enter:center' && ${HUB}.apps.ctl('online').log.join() === 'enter:online,leave:online'`), tag + 'the page moved from one app\'s family to another\'s: online_ctl hears leave(online), center_ctl is loaded and hears enter(center)', J(await page.eval(`[${HUB}.apps.ctl('online') && ${HUB}.apps.ctl('online').log, ${HUB}.apps.ctl('center') && ${HUB}.apps.ctl('center').log]`)));
    same = await sameAsNode(page);
    ok(same.ok, tag + 'the canvas equals Node\'s render of the Center view', J(same));
    // ---- the Center is real-time: the model is ticked and the page redraws when its view changes, with nothing pressed
    const r0 = await page.eval(`({ renders: ${HUB}.renders, secs: ${HUB}.view().center.seconds })`);
    await page.eval(`${HUB}.pause(false)`); await sleep(2300); await page.eval(`${HUB}.pause(true)`);
    const r1 = await page.eval(`({ renders: ${HUB}.renders, secs: ${HUB}.view().center.seconds, ticks: ${HUB}.model.state().apps.center.ticks })`);
    ok(r1.secs >= r0.secs + 1 && r1.ticks >= 60 && r1.renders > r0.renders, tag + 'real time: with nothing pressed the page\'s clock ticks the open app (' + r1.ticks + ' ticks) and the picture is redrawn when its view changes (' + (r1.renders - r0.renders) + ' redraws, ' + r1.secs + ' s on the screen)', J([r0, r1]));
    ok((await sameAsNode(page)).ok, tag + 'and what is on the canvas is the app\'s current view');
    await shot(page, 'apps_keys_2_center');
    // ---- back, by key and by the browser
    await key(page, 'b'); await sleep(250);
    ok((await where(page)) === 'online' && (await hash(page)) === '#online', tag + 'Backspace on the Center goes back to PLAY ONLINE (its parent)', (await where(page)) + ' ' + (await hash(page)));
    ok(await waitOk(page, `${HUB}.apps.ctl('center').log.join() === 'enter:center,leave:center' && ${HUB}.apps.ctl('online').log.join() === 'enter:online,leave:online,enter:online'`), tag + 'the ctls hear it: center leave, online enter', J(await page.eval(`[${HUB}.apps.ctl('online').log, ${HUB}.apps.ctl('center').log]`)));
    await key(page, 'esc'); await sleep(250);
    ok((await where(page)) === 'main' && (await hash(page)) === '' && (await mcur(page)) === 2, tag + 'Escape goes back to the main menu, with the cursor on PLAY ONLINE');
    const L0 = await page.eval('history.length');
    for (let i = 0; i < 3; i++) { await key(page, 'a'); await sleep(120); await key(page, 'a'); await sleep(120); await key(page, 'b'); await sleep(250); await key(page, 'b'); await sleep(250); }
    const L1 = await page.eval('history.length');
    ok((await where(page)) === 'main' && L1 - L0 <= 2, tag + 'three trips main, PLAY ONLINE, Center and back by B add at most two history entries in all, not twelve (' + L0 + ' -> ' + L1 + ')', L0 + ' -> ' + L1);
    await key(page, 'a'); await sleep(120); await key(page, 'a'); await sleep(150);
    await page.eval('history.back()'); await sleep(300);
    ok((await where(page)) === 'online', tag + 'the browser\'s Back button on the Center is PLAY ONLINE', await where(page));
    await page.eval('history.forward()'); await sleep(300);
    ok((await where(page)) === 'center' && (await page.eval(`${HUB}.apps.family()`)) === 'center', tag + 'and Forward is the Center again');
    await page.eval('history.back()'); await sleep(300); await page.eval('history.back()'); await sleep(300);
    ok((await where(page)) === 'main' && (await page.eval(`${HUB}.apps.family()`)) === null, tag + 'Back, Back is the main menu (no app\'s family is open)');
    // ---- a deep link to a nested app screen has the history it would have had if walked to
    ok((await boot(page, '#center')) === 'ready' && (await where(page)) === 'center', tag + 'a #center address opens the Center');
    await page.eval('window.__m = 5');
    ok(await waitOk(page, `${HUB}.apps.ctl('center') && ${HUB}.apps.ctl('center').log.join() === 'enter:center'`), tag + 'and loads its ctl');
    await key(page, 'b'); await sleep(300);
    ok((await where(page)) === 'online' && (await hash(page)) === '#online', tag + 'B from a Center opened by address is PLAY ONLINE (the history was seeded with the screens on the way)', (await where(page)) + ' ' + (await hash(page)));
    await key(page, 'b'); await sleep(300);
    ok((await where(page)) === 'main' && (await page.eval(`window.__m === 5 && location.pathname.endsWith('/pokemonarena/')`)) === true, tag + 'B again is the main menu, in the same page: B never leaves the hub');
    ok((await boot(page, '#builder-nowhere')) === 'ready' && (await where(page)) === 'main', tag + 'an address that names no screen of any app opens the main menu');
    // ---- B from a screen opened from somewhere that is not its parent (the builder from the Center, as the Center's PC will): the browser history brings the player back there
    ok((await boot(page, '#center')) === 'ready' && (await page.eval(`${HUB}.goto('builder')`)) === 'builder' && (await hash(page)) === '#builder', tag + 'from the Center, the builder is opened (a history entry of its own)');
    ok(await waitOk(page, `${HUB}.apps.ctl('center') && ${HUB}.apps.ctl('center').log.join() === 'enter:center,leave:center' && ${HUB}.apps.ctl('builder') && ${HUB}.apps.ctl('builder').log[0] === 'enter:builder'`), tag + 'the Center\'s ctl hears leave, the builder\'s enter');
    await key(page, 'b'); await sleep(350);
    ok((await where(page)) === 'center' && (await hash(page)) === '#center', tag + 'B on the builder returns to the Center it was opened from, not to the main menu its parent is', (await where(page)) + ' ' + (await hash(page)));
    await key(page, 'b'); await sleep(300); await key(page, 'b'); await sleep(300);
    ok((await where(page)) === 'main' && (await hash(page)) === '', tag + 'and B, B from there is PLAY ONLINE and then the main menu, as before');
    // ---- the mouse
    await boot(page);
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(2)); await sleep(150);
    ok((await where(page)) === 'online', tag + 'a click on PLAY ONLINE opens it');
    const pm = await logicalToPage(page, `${HUB}.canvas`, 60, rowY(1, 3));
    await moveMouse(page, pm.x, pm.y); await sleep(120);
    ok((await mcur(page)) === 1 && (await where(page)) === 'online' && (await page.eval(`getComputedStyle(${HUB}.canvas).cursor`)) === 'pointer', tag + 'hovering BATTLE ONLINE moves the app\'s cursor, activates nothing, and the pointer is a hand over a row');
    await clickLogical(page, `${HUB}.canvas`, 60, rowY(1, 3));
    ok(await waitOk(page, 'window.__nav.length === 1') && (await navs(page))[0] === '/pokemonarena/battle.html?online=1', tag + 'a click on BATTLE ONLINE leaves for the online battle page (the app\'s effect, carried out by its ctl)', J(await navs(page)));
    await clickLogical(page, `${HUB}.canvas`, 60, rowY(2, 3)); await sleep(200);
    ok((await where(page)) === 'main', tag + 'a click on BACK returns to the main menu');
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(2)); await sleep(150);
    const pr = await logicalToPage(page, `${HUB}.canvas`, 200, 60);
    await rightClick(page, pr.x, pr.y); await sleep(200);
    ok((await where(page)) === 'main', tag + 'a RIGHT click on an app\'s screen is B');
    // ---- TEAM BUILDER and the text entry: A REAL KEYBOARD TYPES
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(4)); await sleep(150);
    ok((await where(page)) === 'builder' && (await hash(page)) === '#builder' && (await navs(page)).length === 1, tag + 'a click on TEAM BUILDER opens the builder screen in the picture (nothing navigated)');
    const tf = await typingFacts(page);
    for (const [n, c] of TYPING_CHECKS(tf)) ok(c === true, tag + 'typing: ' + n, J(tf));
    ok((await page.eval(`${HUB}.typed`)) === 8, tag + 'typing: eight keys went to the model as text', String(await page.eval(`${HUB}.typed`)));
    same = await sameAsNode(page);
    ok(same.ok, tag + 'the canvas equals Node\'s render of the text entry (the keys, the field, the caret)', J(same));
    await shot(page, 'apps_keys_3_entry');
    await named(page, 'back'); await sleep(60);
    ok((await entryOf(page)).value === 'zxwasdm' && (await page.eval(`${HUB}.wantsText()`)) === true, tag + 'Backspace deletes one character and is not B (the entry stays open)', J(await entryOf(page)));
    await named(page, 'left'); await named(page, 'left'); await letter(page, 'Q'); await sleep(60);
    ok((await entryOf(page)).value === 'zxwasQdm' && (await entryOf(page)).caret === 6 && (await entryOf(page)).col === 0, tag + 'the left arrow moves the caret (not the key cursor) and Shift+Q types a capital there', J(await entryOf(page)));
    await named(page, 'home'); await named(page, 'del'); await named(page, 'end'); await sleep(60);
    ok((await entryOf(page)).value === 'xwasQdm' && (await entryOf(page)).caret === 7, tag + 'Home, Delete, End: the first character is gone and the caret is at the end', J(await entryOf(page)));
    await named(page, 'space'); await sleep(60);
    ok((await entryOf(page)).value === 'xwasQdm ', tag + 'Space types a space (it is not A: no key of the picture was typed)', J((await entryOf(page)).value));
    await named(page, 'back'); await named(page, 'down'); await sleep(80);
    ok((await entryOf(page)).value === 'xwasQdm' && (await entryOf(page)).row === 1, tag + 'the down arrow still walks the picture\'s keys', J(await entryOf(page)));
    await hitKey(page, 'a', 'KeyA', 65, 2); await hitKey(page, 'v', 'KeyV', 86, 2); await hitKey(page, 'r', 'KeyR', 82, 1); await sleep(60);
    ok((await entryOf(page)).value === 'xwasQdm' && (await page.eval(`${HUB}.wantsText()`)) === true, tag + 'Ctrl+A, Ctrl+V and Alt+R as plain key presses type nothing (browser shortcuts are left alone; a paste arrives as its own event)');
    await named(page, 'enter'); await sleep(350);
    ok((await page.eval(`${HUB}.wantsText()`)) === false && (await page.eval(`${HUB}.view().menu.rows[0].label`)) === 'NAME: xwasQdm' && (await where(page)) === 'builder', tag + 'Enter is OK: the entry closes, the row shows the name, and that Enter did not also press A on the row behind it (the entry did not open again)', J(await builderOf(page)));
    ok(await waitOk(page, `sessionStorage.getItem('arena.builder.stubname') === 'xwasQdm' && ${HUB}.apps.ctl('builder').log.includes('effect:named')`), tag + 'the result reached the app\'s ctl as an effect (it kept the name for this tab)', J(await page.eval(`${HUB}.apps.ctl('builder') && ${HUB}.apps.ctl('builder').log`)));
    await key(page, 'a'); await sleep(200); await letter(page, 'y'); await named(page, 'esc'); await sleep(300);
    ok((await page.eval(`${HUB}.wantsText()`)) === false && (await page.eval(`${HUB}.view().menu.rows[0].label`)) === 'NAME: xwasQdm' && (await where(page)) === 'builder', tag + 'Escape cancels the entry (the name is unchanged) and is not B for the screen behind it (still the builder)', (await where(page)) + ' ' + J(await builderOf(page)));
    // ---- a paste of 1024 characters
    await key(page, 'down'); await key(page, 'a'); await sleep(200);
    ok((await entryOf(page)) && (await entryOf(page)).charset === 'teamcode', tag + 'Enter on TEAM CODE opens a team code entry');
    const prevented = await paste(page, '  ' + LONG_CODE.slice(0, 500) + '\n' + LONG_CODE.slice(500) + ' \r\n');
    await sleep(150);
    ok(prevented === true && (await entryOf(page)).value === LONG_CODE && (await entryOf(page)).caret === 1024, tag + 'paste: 1024 characters pasted with line breaks and spaces arrive whole (the page took the paste event)', String((await entryOf(page)).value.length));
    same = await sameAsNode(page);
    ok(same.ok && (await page.eval(`${HUB}.view().entry.length`)) === 1024, tag + 'the canvas equals Node\'s render of the full team code field', J(same));
    await shot(page, 'apps_keys_4_teamcode');
    await paste(page, 'MORE'); await sleep(80);
    ok((await entryOf(page)).value === LONG_CODE && /as long as it can be/.test(await page.eval(`${HUB}.view().entry.note`)), tag + 'paste: a paste into a full field changes nothing and says why');
    await named(page, 'enter'); await sleep(300);
    ok((await page.eval(`${HUB}.view().menu.rows[1].label`)) === 'TEAM CODE: 1024' && (await page.eval(`${HUB}.wantsText()`)) === false, tag + 'Enter accepts it: the row counts 1024 characters');
    ok((await paste(page, 'zzz')) === false && (await builderOf(page)).name === 'xwasQdm', tag + 'paste: with no entry open a paste is not taken at all');
    // ---- the picture's keys by mouse
    await key(page, 'up'); await key(page, 'a'); await sleep(200);
    let kp = await keyPoint(page, 'K');
    const kpp = await logicalToPage(page, `${HUB}.canvas`, kp.x, kp.y);
    await moveMouse(page, kpp.x, kpp.y); await sleep(100);
    ok((await entryOf(page)).row === 0 && (await entryOf(page)).col === 10 && (await entryOf(page)).value === 'xwasQdm', tag + 'hovering a key of the picture puts the key cursor on it and types nothing', J(await entryOf(page)));
    await clickLogical(page, `${HUB}.canvas`, kp.x, kp.y); await sleep(100);
    ok((await entryOf(page)).value === 'xwasQdmK', tag + 'a click on the key types it', (await entryOf(page)).value);
    kp = await keyPoint(page, 'del'); await clickLogical(page, `${HUB}.canvas`, kp.x, kp.y); await sleep(100);
    ok((await entryOf(page)).value === 'xwasQdm', tag + 'a click on DEL deletes');
    // ---- a DOM dialog (Controls) keeps the keyboard to itself
    await clickSel(page, '#controlsBtn'); await page.waitFor(`${HUB}.dialogOpen()`, { timeoutMs: 8000 });
    const typed0 = await page.eval(`${HUB}.typed`);
    await letter(page, 'q'); await paste(page, 'zz'); await sleep(100);
    ok((await entryOf(page)).value === 'xwasQdm' && (await page.eval(`${HUB}.typed`)) === typed0, tag + 'while the Controls dialog is open nothing is typed into the entry behind it (not a key, not a paste)', J(await entryOf(page)));
    await named(page, 'esc'); await sleep(300);
    ok(!(await page.eval(`${HUB}.dialogOpen()`)) && (await page.eval(`${HUB}.wantsText()`)) === true && (await entryOf(page)).value === 'xwasQdm', tag + 'Escape closes the Controls dialog and not the entry behind it');
    kp = await keyPoint(page, 'cancel'); await clickLogical(page, `${HUB}.canvas`, kp.x, kp.y); await sleep(150);
    ok((await page.eval(`${HUB}.wantsText()`)) === false && (await where(page)) === 'builder', tag + 'a click on CANCEL closes the entry');
    // ---- the name survives a reload through the ctl
    ok((await boot(page, '#builder')) === 'ready' && await waitOk(page, `${HUB}.view().menu && ${HUB}.view().menu.rows[0].label === 'NAME: xwasQdm'`), tag + 'after a reload on #builder the ctl puts the kept name back into the model and the picture shows it', J(await page.eval(`${HUB}.view().menu && ${HUB}.view().menu.rows[0]`)));
    // ---- THE DIALOG LAYER over an app screen
    ok((await boot(page, '#center')) === 'ready' && (await where(page)) === 'center', tag + 'dialog: the Center is open');
    ok((await page.eval(`${HUB}.dialog.open(${YESNO()})`)) === true, tag + 'dialog: a "wants to battle you" question opens over it');
    same = await sameAsNode(page);
    ok(same.ok && (await page.eval(`${HUB}.view().dialog.id`)) === 'chal' && (await page.eval(`${HUB}.view().app`)) === 'center', tag + 'dialog: it is drawn over the Center (the canvas equals Node\'s render of the view with the dialog)', J(same));
    ok(/RED wants to battle you\. 3v3, standard rules\. Choose: YES, selected NO\./.test(await live(page)), tag + 'dialog: the screen reader hears the question and the options', await live(page));
    await shot(page, 'apps_keys_5_dialog');
    await key(page, 'up'); await sleep(80);
    ok((await page.eval(`${HUB}.view().dialog.choice.cursor`)) === 0 && (await where(page)) === 'center', tag + 'dialog: the up arrow moves its cursor to YES');
    await key(page, 'a'); await sleep(150);
    ok(J(await page.eval(`${HUB}.apps.state().center.answer`)) === J({ id: 'chal', value: 0 }) && (await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await where(page)) === 'center', tag + 'dialog by key: Enter answers YES (0); the app\'s model has the answer; the BACK row under the dialog was not pressed', J(await page.eval(`${HUB}.apps.state().center`)));
    ok(await waitOk(page, `${HUB}.apps.ctl('center').log.includes('effect:dialog:chal:0')`), tag + 'dialog by key: the answer reached the app\'s ctl as an effect', J(await page.eval(`${HUB}.apps.ctl('center').log`)));
    ok((await page.eval(`${HUB}.view().center.lines.includes('ANSWER: 0')`)) === true && (await sameAsNode(page)).ok, tag + 'dialog: the picture is the Center again, showing the answer');
    await page.eval(`${HUB}.dialog.open(${YESNO({ id: 'chal2' })})`); await sleep(80);
    const back = await page.eval(`${HUB}.model.apps.center.rects('center')[0]`);
    await clickLogical(page, `${HUB}.canvas`, back.x + 30, back.y + 6); await sleep(150);
    ok((await where(page)) === 'center' && (await page.eval(`${HUB}.dialog.isOpen()`)) === true, tag + 'dialog by click: a click on the BACK row under the dialog does nothing');
    await clickLogical(page, `${HUB}.canvas`, 100, 135); await sleep(120);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === true, tag + 'dialog by click: a click on the question\'s text does not answer it');
    let op = await optPoint(page, 0);
    const opp = await logicalToPage(page, `${HUB}.canvas`, op.x, op.y);
    await moveMouse(page, opp.x, opp.y); await sleep(100);
    ok((await page.eval(`${HUB}.view().dialog.choice.cursor`)) === 0 && (await page.eval(`getComputedStyle(${HUB}.canvas).cursor`)) === 'pointer', tag + 'dialog by click: hovering YES highlights it (the pointer is a hand)');
    await clickLogical(page, `${HUB}.canvas`, op.x, op.y); await sleep(150);
    ok(J(await page.eval(`${HUB}.apps.state().center.answer`)) === J({ id: 'chal2', value: 0 }) && (await page.eval(`${HUB}.dialog.isOpen()`)) === false, tag + 'dialog by click: a click on YES answers YES', J(await page.eval(`${HUB}.apps.state().center.answer`)));
    await page.eval(`${HUB}.dialog.open(${YESNO({ id: 'chal3', choice: { options: ['YES', 'NO'], cursor: 0 } })})`); await sleep(60);
    await key(page, 'b'); await sleep(200);
    ok(J(await page.eval(`${HUB}.apps.state().center.answer`)) === J({ id: 'chal3', value: 1 }) && (await where(page)) === 'center', tag + 'dialog by key: Backspace (B) answers NO, the last option, and does not also go back');
    await page.eval(`${HUB}.dialog.open(${YESNO({ id: 'chal4', ticksLeft: 5 })})`); await page.eval(`${HUB}.tick(4)`);
    const open4 = await page.eval(`${HUB}.dialog.isOpen()`); await page.eval(`${HUB}.tick(1)`);
    ok(open4 === true && J(await page.eval(`${HUB}.apps.state().center.answer`)) === J({ id: 'chal4', value: 'timeout' }) && (await page.eval(`${HUB}.dialog.isOpen()`)) === false, tag + 'dialog: one with ticksLeft answers "timeout" by itself (after 5 ticks, not 4)', J(await page.eval(`${HUB}.apps.state().center.answer`)));
    const two = await page.eval(`[${HUB}.dialog.open(${YESNO({ id: 'first' })}), ${HUB}.dialog.open(${YESNO({ id: 'second' })}), ${HUB}.dialog.open(${YESNO({ id: 'first' })})]`);
    await key(page, 'a'); await sleep(120);
    ok(J(two) === J([true, true, false]) && (await page.eval(`${HUB}.view().dialog.id`)) === 'second', tag + 'dialog: a second question waits behind the first (queued) and is shown when the first is answered; the same id twice is refused', J(two));
    await key(page, 'a'); await sleep(120);
    // ---- a dialog over a text entry: the keyboard answers the dialog
    await boot(page, '#builder'); await key(page, 'a'); await sleep(200); await letter(page, 'r'); await sleep(60);
    const v0 = (await entryOf(page)).value;
    await page.eval(`${HUB}.dialog.open(${YESNO({ app: 'builder', id: 'keep', choice: { options: ['YES', 'NO'], cursor: 0 } })})`); await sleep(80);
    await letter(page, 'z'); await sleep(200);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await entryOf(page)).value === v0 && (await page.eval(`${HUB}.wantsText()`)) === true && (await page.eval(`${HUB}.effects.includes('dialog')`)) === true, tag + 'dialog over a text entry: Z is A for the dialog (it answers), not a letter for the field under it; the entry is still there', J(await entryOf(page)));
    ok(J(await page.eval(`${HUB}.apps.errors()`)) === '{}' && (await page.eval(`${HUB}.renderError === undefined`)) === true, tag + 'no ctl failed to load and no screen failed to draw');
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- a phone: touch only */
  if (wants('touch')) await runSession('phone, touch only', { width: 390, height: 844, mobile: true, dpr: 3, port: cdp++ }, async (page) => {
    const tag = 'touch: ';
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(2)); await sleep(200);
    ok((await where(page)) === 'online' && (await hash(page)) === '#online', tag + 'a tap on PLAY ONLINE opens it');
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(0, 3)); await sleep(200);
    ok((await where(page)) === 'center', tag + 'a tap on TRAINER CENTER opens the Center');
    await shot(page, 'apps_touch_1_center');
    await tapSel(page, '#bB'); await sleep(250);
    ok((await where(page)) === 'online', tag + 'the on-screen B button goes back to PLAY ONLINE');
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(2, 3)); await sleep(250);
    ok((await where(page)) === 'main', tag + 'a tap on BACK goes back to the main menu');
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(4)); await sleep(200);
    ok((await where(page)) === 'builder', tag + 'a tap on TEAM BUILDER opens the builder screen');
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(0, 4)); await sleep(200);
    ok((await page.eval(`${HUB}.wantsText()`)) === true && (await page.eval(`${HUB}.view().entry.id`)) === 'name', tag + 'a tap on NAME opens the text entry');
    const tapKey = async (id) => { const p = await keyPoint(page, id); await tapLogical(page, `${HUB}.canvas`, p.x, p.y); await sleep(120); };
    await tapKey('A'); await tapKey('B');
    ok((await entryOf(page)).value === 'AB', tag + 'taps on the picture\'s keys type them', (await entryOf(page)).value);
    await tapKey('shift'); await tapKey('c');
    ok((await entryOf(page)).value === 'ABc' && (await entryOf(page)).page === 'lower', tag + 'a tap on abc shows the lower-case keys, and a tap on c types it', J(await entryOf(page)));
    await tapKey('space'); await tapKey('del'); await tapKey('del');
    ok((await entryOf(page)).value === 'AB', tag + 'SPACE types a space, DEL deletes (twice: the space and the c)', J((await entryOf(page)).value));
    await shot(page, 'apps_touch_2_entry');
    await tapSel(page, '#bUp'); await sleep(120); await tapSel(page, '#bA'); await sleep(120);          // (up from the DEL chip is the key above it)
    ok((await entryOf(page)).value.length === 3 && (await entryOf(page)).value.slice(0, 2) === 'AB', tag + 'the on-screen pad walks the keys and its A button types the one under the cursor', J(await entryOf(page)));
    await tapSel(page, '#bB'); await sleep(120);
    ok((await entryOf(page)).value === 'AB' && (await page.eval(`${HUB}.wantsText()`)) === true, tag + 'the on-screen B button deletes one character (the entry stays open while there is text)');
    await tapKey('ok'); await sleep(200);
    ok((await page.eval(`${HUB}.wantsText()`)) === false && (await page.eval(`${HUB}.view().menu.rows[0].label`)) === 'NAME: AB', tag + 'a tap on OK accepts the name');
    const btn = await page.eval(`(() => { const r = ${HUB}.canvas.getBoundingClientRect(); return { w: r.width, cell: 16 * r.width / 240, sw: document.documentElement.scrollWidth, iw: innerWidth }; })()`);
    ok(btn.sw <= btn.iw && btn.cell >= 20, tag + 'on a 390 px phone the picture has no sideways scroll and a key of the picture is ' + btn.cell.toFixed(1) + ' px wide', J(btn));
    // ---- a dialog by tap
    await page.eval(`${HUB}.dialog.open(${YESNO({ app: 'builder', id: 'tapq' })})`); await sleep(120);
    await tapLogical(page, `${HUB}.canvas`, 100, 135); await sleep(150);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === true, tag + 'dialog: a tap on the question\'s text does not answer it');
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(3, 4)); await sleep(150);
    ok((await where(page)) === 'builder' && (await page.eval(`${HUB}.dialog.isOpen()`)) === true, tag + 'dialog: a tap on the BACK row under it does nothing');
    await shot(page, 'apps_touch_3_dialog');
    const op = await optPoint(page, 0); await page.eval(`window.__fxn = ${HUB}.effects.length`);
    await tapLogical(page, `${HUB}.canvas`, op.x, op.y); await sleep(200);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await page.eval(`${HUB}.effects.slice(window.__fxn).includes('dialog')`)) === true && (await where(page)) === 'builder', tag + 'dialog by tap: a tap on YES answers the question');
    ok(await waitOk(page, `${HUB}.apps.ctl('builder') && ${HUB}.apps.ctl('builder').log.includes('effect:dialog')`), tag + 'dialog by tap: the answer reached the ctl of the app that asked', J(await page.eval(`${HUB}.apps.ctl('builder') && ${HUB}.apps.ctl('builder').log`)));
    await page.eval(`${HUB}.dialog.open({ id: 'note', pages: [['A notice.', 'Tap to read on.'], ['The end.', '']], choice: null })`); await sleep(100);
    await tapLogical(page, `${HUB}.canvas`, 100, 135); await sleep(150); const pg = await page.eval(`${HUB}.view().dialog && ${HUB}.view().dialog.page`);
    await tapLogical(page, `${HUB}.canvas`, 100, 135); await sleep(150);
    ok(pg === 1 && (await page.eval(`${HUB}.dialog.isOpen()`)) === false, tag + 'dialog by tap: a notice is read on by taps on its text and closes at the end');
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- the synthetic controller alone */
  if (wants('pad')) await runSession('synthetic controller only', { width: 1280, height: 800, port: cdp++, pad: true }, async (page) => {
    const tag = 'pad: ';
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await padPress(page, 13); await padPress(page, 13);
    ok((await mcur(page)) === 2, tag + 'D-pad down, down is on PLAY ONLINE (SYNTHETIC controller)', String(await mcur(page)));
    await padPress(page, 0);
    ok((await where(page)) === 'online', tag + 'A opens PLAY ONLINE');
    await padPress(page, 0);
    ok((await where(page)) === 'center', tag + 'A on TRAINER CENTER opens the Center');
    await padPress(page, 1);
    ok((await where(page)) === 'online', tag + 'B goes back to PLAY ONLINE');
    await padPress(page, 1);
    ok((await where(page)) === 'main' && !(await page.eval(`JSON.stringify(${HUB}.view()).includes('Press B again')`)), tag + 'B again is the main menu (and that B did not ask to leave the Arena)');
    await padPress(page, 13); await padPress(page, 13); await padPress(page, 0);
    ok((await where(page)) === 'builder', tag + 'two more downs and A open TEAM BUILDER');
    await padPress(page, 0);
    ok((await page.eval(`${HUB}.wantsText()`)) === true, tag + 'A on NAME opens the text entry');
    await padPress(page, 15); await padPress(page, 0);
    ok((await entryOf(page)).value === 'B' && (await entryOf(page)).col === 1, tag + 'D-pad right moves the key cursor and A types the key (B)', J(await entryOf(page)));
    await padPress(page, 8); await padPress(page, 0);
    ok((await entryOf(page)).value === 'Bb' && (await entryOf(page)).page === 'lower', tag + 'SELECT shows the lower-case keys and A types b', J(await entryOf(page)));
    await padPress(page, 12);
    ok((await entryOf(page)).row === 4, tag + 'D-pad up from the top row wraps to the chips');
    await padPress(page, 13); await padPress(page, 1);
    ok((await entryOf(page)).value === 'B' && (await page.eval(`${HUB}.wantsText()`)) === true, tag + 'B deletes one character', J(await entryOf(page)));
    await padPress(page, 9); await sleep(150);
    ok((await page.eval(`${HUB}.wantsText()`)) === false && (await page.eval(`${HUB}.view().menu.rows[0].label`)) === 'NAME: B' && (await where(page)) === 'builder', tag + 'START is OK: the entry closes and the row shows the name');
    await padPress(page, 0); await padPress(page, 1);
    const emptied = await entryOf(page); await padPress(page, 1); await sleep(100);
    ok(emptied && emptied.value === '' && (await page.eval(`${HUB}.wantsText()`)) === false && (await where(page)) === 'builder' && (await page.eval(`${HUB}.view().menu.rows[0].label`)) === 'NAME: B', tag + 'B on the emptied field cancels the entry (the name is kept) and does not leave the screen', J(emptied));
    // ---- a dialog by controller, and B on the main menu under a dialog
    await page.eval(`${HUB}.dialog.open(${YESNO({ app: 'builder', id: 'padq' })})`); await sleep(80);
    await padPress(page, 12); await padPress(page, 0);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && await waitOk(page, `${HUB}.apps.ctl('builder') && ${HUB}.apps.ctl('builder').log.includes('effect:dialog')`), tag + 'dialog by controller: D-pad up and A answer YES');
    await padPress(page, 1);
    ok((await where(page)) === 'main', tag + 'B leaves the builder screen');
    await page.eval(`${HUB}.dialog.open(${YESNO({ id: 'onmain' })})`); await sleep(80); await page.eval(`window.__fxn = ${HUB}.effects.length`);
    await padPress(page, 1);
    ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await page.eval(`${HUB}.effects.slice(window.__fxn).join()`)) === 'dialog' && !(await page.eval(`JSON.stringify(${HUB}.view()).includes('Press B again')`)), tag + 'B on the main menu under a dialog answers the dialog (NO); it is not the "press B again to leave" press');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- a ctl that cannot load */
  if (wants('broken')) await runSession('a ctl that cannot load', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'broken: ';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-apps-broken-'));
    const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
    mutateFile(d, 'js/builder_ctl.js', 'export function createCtl(env) {', 'export function createCtlX(env) {');
    mutateFile(d, 'js/center_screen.js', '      const c = view.center; if (!c) return;', "      throw new Error('boom');");          // ... and whose Center renderer throws
    const ov = await startOverlay({ dir: d, port: L.PORT + 12, upstream: BASE });
    try {
      ok((await boot(page, '', ov.url)) === 'ready', tag + 'the hub boots (a copy of the game whose builder_ctl.js exports no createCtl)');
      ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false, tag + 'nothing is said while the builder is not needed (its ctl was not asked for)');
      for (let i = 0; i < 4; i++) await key(page, 'down');
      await key(page, 'a');
      ok(await waitOk(page, `${HUB}.view().dialog && ${HUB}.view().dialog.id === 'app:builder'`) && (await where(page)) === 'builder', tag + 'TEAM BUILDER still opens, and a note appears in the picture');
      ok(J(await page.eval(`${HUB}.view().dialog.lines`)) === J(['Team Builder could not load.', 'Reload the page and try again.']) && /createCtl/.test((await page.eval(`${HUB}.apps.errors()`)).builder || ''), tag + 'the note says which app could not load and what to do; the page knows why', J(await page.eval(`[${HUB}.view().dialog.lines, ${HUB}.apps.errors()]`)));
      ok((await sameAsNode(page)).ok, tag + 'the note is on the canvas');
      await shot(page, 'apps_broken_1_note');
      await key(page, 'a'); await sleep(200);
      ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await where(page)) === 'builder', tag + 'A closes the note; the screen is still there');
      await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(400);
      ok((await page.eval(`${HUB}.dialog.isOpen()`)) === false && (await navs(page)).length === 0, tag + 'an effect for the app that could not load is dropped, and the note is not said again for every effect');
      await key(page, 'b'); await sleep(250);
      await key(page, 'up'); await key(page, 'up'); await key(page, 'up'); await key(page, 'up'); await key(page, 'a'); await sleep(150);
      ok((await where(page)) === 'quick', tag + 'the rest of the hub goes on working (B, then QUICK BATTLE)');
      await key(page, 'b'); await sleep(200); for (let i = 0; i < 4; i++) await key(page, 'down'); await key(page, 'a');
      ok(await waitOk(page, `${HUB}.view().dialog && ${HUB}.view().dialog.id === 'app:builder'`), tag + 'opening the screen again says it again (once per visit)');
      ok(errsOf(page).length === 0, tag + 'a ctl that cannot load is a warning in the console and a note in the picture, not an error', errsOf(page).slice(0, 2).join(' | '));
      // ---- a renderer that throws does not stop the page
      await key(page, 'a'); await sleep(150); await key(page, 'b'); await sleep(250);
      await page.eval(`${HUB}.pause(false)`);
      ok((await page.eval(`${HUB}.goto('center')`)) === 'center' && await waitOk(page, `${HUB}.renderError === 'boom'`), tag + 'a renderer that throws: the fault is on the hook (the Center of this copy cannot be drawn)', String(await page.eval(`${HUB}.renderError`)));
      await sleep(600);
      const t0 = await page.eval(`${HUB}.model.state().apps.center.ticks`); await sleep(400);
      ok((await page.eval(`${HUB}.model.state().apps.center.ticks`)) > t0, tag + 'a renderer that throws: the clock of the page goes on ticking the app');
      const rn = await page.eval(`${HUB}.renders`);
      await key(page, 'b'); await sleep(350);
      ok((await where(page)) === 'main' && (await page.eval(`${HUB}.renders`)) > rn && (await page.eval(`${HUB}.canvasHash() === ${HUB}.frameHash()`)) === true, tag + 'a renderer that throws: B still works (back to the menu the Center was opened from) and the next screen is drawn');
      const errs = errsOf(page);
      ok(errs.length === 1 && /could not be drawn/.test(errs[0]), tag + 'a renderer that throws: it is said in the console ONCE, not once a frame', errs.length + ': ' + errs.slice(0, 2).join(' | '));
    } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  });

  /* ---------------------------------------------------------------------------------------- negative control: the keyboard capture switched off */
  if (wants('control')) await runSession('typing negative control', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'control: ';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-apps-ctl-'));
    const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
    mutateFile(d, 'js/boot.js', "    if (!typingNow() || e.defaultPrevented) return;\n    if (e.repeat && !heldAsText.has(e.code || e.key)) return;", "    return;");
    const ov = await startOverlay({ dir: d, port: L.PORT + 13, upstream: BASE });
    try {
      ok((await boot(page, '', ov.url)) === 'ready', tag + 'the hub boots (a copy of the game whose keyboard capture is switched off)');
      const r = await typingFacts(page);
      const failed = TYPING_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(r.opened === true && failed.length >= 2 && !(r.entry && r.entry.value === 'zxwasdmp'), tag + 'without the capture the typing checks FAIL (' + failed.length + ' of them: the keys act as buttons again), so those checks can fail', J(r));
    } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  });
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
