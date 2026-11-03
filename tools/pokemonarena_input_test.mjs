#!/usr/bin/env node
// POKEMONARENA INPUT TEST  (stage I1)
//
// Tests the input layer: pokemonarena/js/input.js (keyboard / mouse / touch / gamepad -> twelve actions), js/uinav.js (DOM spatial navigation),
// js/input_panel.js (Controls panel) and input.css (focus ring), through the developer fixture pokemonarena/dev/input_lab.html.
//
//   (a) UNIT   Node only: fake EventTarget window/document, fake gamepad provider, injected clock, fake storage. Every default binding, repeat
//              timing to the millisecond, OS auto-repeat, the text-target and modifier guards, stick deadzone / hysteresis boundaries, diagonals,
//              layout swap by controller id, hot-plug and disconnect release, blur / visibility release, rebinding and conflicts, hostile and
//              absent storage, glyph by source, destroy removing every listener, pointer mapping, pads, capture, the self-poll loop.
//   (b) BROWSER headless Chrome via tools/headless_cdp.mjs (ONE browser, throwaway profile, bare CDP, --mute-audio) on the lab page:
//              REAL CDP Input.dispatchKeyEvent (incl. autoRepeat), Input.dispatchMouseEvent (move / press / release / wheel / right button) and
//              Input.dispatchTouchEvent (multi-touch). THE GAMEPAD IS SYNTHETIC: a script installed with Page.addScriptToEvaluateOnNewDocument
//              overrides navigator.getGamepads() and dispatches gamepadconnected events. No physical controller exists in this environment, so
//              real Xbox / PlayStation / Switch Pro / 8BitDo / generic hardware is UNVERIFIED. Likewise blur and visibilitychange are dispatched
//              by script, not by a real window switch.
//   (c) MUTANTS  the sources are copied to a temp tree, one defect is applied per mutant (deadzone, hysteresis, repeat timing, e.repeat handling,
//              guards, Nintendo swap, release paths, storage validation, pointer mapping, wheel direction, spatial scoring, focus-ring rule ...),
//              and the suite is re-run against it: the mutant must be KILLED BY ITS NAMED CHECK, while the unmutated twin stays quiet.
//   (d) SHOTS  screenshots at 390x844, 844x390 and 1280x800 into ARENA_OUT, meant to be opened and looked at.
//
// USAGE   node tools/pokemonarena_input_test.mjs                    everything (unit, browser, mutants)
//         node tools/pokemonarena_input_test.mjs --unit             only (a)             --browser  only (b)
//         node tools/pokemonarena_input_test.mjs --no-mutants       (a) + (b)
// ENV     ARENA_PORT (default 8098)  ARENA_CDP (first CDP port, default 9301)  ARENA_OUT  INPUT_SRC_ROOT (a tree holding pokemonarena/)
//         ARENA_GROUPS (browser groups to run, comma separated; default all)
// Exit code is non-zero if any check fails. Pure ASCII.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const SRC = process.env.INPUT_SRC_ROOT ? path.resolve(process.env.INPUT_SRC_ROOT) : repo;
const PORT = Number(process.env.ARENA_PORT || 8098);
const CDP = Number(process.env.ARENA_CDP || 9301);
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c96e71fd-a869-4d47-86d5-aa19395edeed/scratchpad/I1/shots';
const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------------------------------ check framework */
let pass = 0, fail = 0;
const failed = [];
class StopEarly extends Error {}
const STOP_ON = process.env.ARENA_STOP_ON || '';
const verbose = !!process.env.ARENA_VERBOSE;
function ok(cond, name, detail) {
  if (cond) { pass++; if (verbose) console.log('  ok  ', name); }
  else { fail++; failed.push(name); console.log('FAIL', name, detail !== undefined ? ':: ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''); if (STOP_ON && name === STOP_ON) throw new StopEarly(name); }
}
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((q) => [q, x[q]])) : x));
const eq = (a, b, name) => ok(stable(a) === stable(b), name, 'got ' + stable(a) + ' expected ' + stable(b));
const near = (a, b, tol, name) => ok(Math.abs(a - b) <= tol, name, 'got ' + a + ' expected ' + b + ' +-' + tol);
const mod = (f) => import(pathToFileURL(path.join(SRC, 'pokemonarena', 'js', f)).href);

/* ====================================================================================================== (a) UNIT */
async function unitSuite() {
  const M = await mod('input.js');
  const N = await mod('uinav.js');

  /* ---- fakes ---- */
  const fnId = new WeakMap(); let fnSeq = 0;
  const regKey = (type, fn, o) => { if (!fnId.has(fn)) fnId.set(fn, ++fnSeq); return type + '|' + fnId.get(fn) + '|' + (o === true || (o && o.capture) ? 'c' : 'b'); };
  class Target extends EventTarget {
    constructor() { super(); this.reg = new Set(); }
    addEventListener(type, fn, o) { this.reg.add(regKey(type, fn, o)); super.addEventListener(type, fn, o); }
    removeEventListener(type, fn, o) { this.reg.delete(regKey(type, fn, o)); super.removeEventListener(type, fn, o); }
  }
  class Storage_ {
    constructor(init) { this.m = new Map(Object.entries(init || {})); this.failGet = false; this.failSet = false; }
    getItem(k) { if (this.failGet) throw new Error('SecurityError'); return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { if (this.failSet) throw new Error('QuotaExceededError'); this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
  }
  class Pads {
    constructor() { this.list = [null, null, null, null]; this.calls = 0; this.throws = false; }
    get() {
      this.calls++;
      if (this.throws) throw new Error('getGamepads blocked');
      return this.list.map((p) => (p ? { ...p, buttons: p.buttons ? p.buttons.map((b) => (typeof b === 'number' ? b : { ...b })) : null, axes: p.axes ? p.axes.slice() : null } : null));
    }
    add(i, id, o = {}) { const nb = o.nb === undefined ? 17 : o.nb; this.list[i] = { id, index: i, connected: true, mapping: o.mapping === undefined ? 'standard' : o.mapping, buttons: Array.from({ length: nb }, () => ({ pressed: false, value: 0 })), axes: new Array(o.na === undefined ? 4 : o.na).fill(0) }; return this.list[i]; }
    btn(i, j, v = true) { this.list[i].buttons[j] = { pressed: !!v, value: v ? 1 : 0 }; }
    axis(i, j, v) { this.list[i].axes[j] = v; }
    remove(i) { this.list[i] = null; }
  }
  const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', PRO = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', DS4 = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', GENERIC = 'USB Gamepad (Vendor: 1234 Product: abcd)';
  const ev = (type, props) => Object.assign(new Event(type, { cancelable: true, bubbles: true }), props || {});
  const tgt = (tag, props) => Object.assign({ tagName: tag, type: '', isContentEditable: false, hasAttribute: () => false, getAttribute: () => null }, props || {});

  function rig(o = {}) {
    const win = new Target(), doc = new Target(); doc.hidden = false;
    const clock = { t: 1000 }, pads = new Pads();
    const store = o.storage === undefined ? new Storage_() : o.storage;
    const input = M.createInput({ target: win, document: doc, now: () => clock.t, getGamepads: () => pads.get(), storage: store, raf: o.raf === undefined ? null : o.raf, caf: o.caf, layoutMap: o.layoutMap === undefined ? null : o.layoutMap });
    const events = [], pointers = [], devices = [], sources = [];
    input.on('action', (e) => events.push(e)); input.on('pointer', (e) => pointers.push(e)); input.on('device', (e) => devices.push(e)); input.on('source', (e) => sources.push(e));
    const r = { win, doc, clock, pads, store, input, events, pointers, devices, sources,
      key(code, p) { const { target, ...rest } = p || {}; const e = ev('keydown', { code, key: rest.key !== undefined ? rest.key : code, ...rest }); if (target) e.composedPath = () => [target]; win.dispatchEvent(e); return e; },
      up(code, p) { const e = ev('keyup', { code, key: code, ...(p || {}) }); win.dispatchEvent(e); return e; },
      at(t) { clock.t = t; input.poll(); },
      mark() { return events.length; },
      since(m) { return events.slice(m); },
      padEvent(type, index) { const e = ev(type, {}); e.gamepad = { index, id: (pads.list[index] || {}).id || 'gone', connected: type === 'gamepadconnected', mapping: 'standard', buttons: [], axes: [] }; win.dispatchEvent(e); },
    };
    return r;
  }
  const sig = (evs) => evs.map((e) => (e.pressed ? '+' : '-') + e.action + (e.repeat ? 'r' : '')).join(' ');

  /* ---------------------------------------------------------------------------------- defaults (independent oracle) */
  const WANT_KEYS = { up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], a: ['KeyZ', 'Enter', 'Space', 'NumpadEnter'],
    b: ['KeyX', 'Backspace', 'Escape'], x: ['KeyC'], y: ['KeyV'], l: ['KeyQ', 'PageUp'], r: ['KeyE', 'PageDown'], start: ['KeyP'], select: ['KeyI'] };
  const WANT_PAD = { xbox: { up: [12], down: [13], left: [14], right: [15], a: [0], b: [1], x: [2], y: [3], l: [4, 6], r: [5, 7], select: [8], start: [9] },
    nintendo: { up: [12], down: [13], left: [14], right: [15], a: [1], b: [0], x: [3], y: [2], l: [4, 6], r: [5, 7], select: [8], start: [9] } };
  {
    eq(M.ACTIONS.slice(), ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'], 'defaults/twelve-actions');
    let allOk = true; const bad = [];
    for (const a of Object.keys(WANT_KEYS)) for (const code of WANT_KEYS[a]) {
      const r = rig(); r.key(code); const e1 = r.events[0];
      const good = e1 && e1.action === a && e1.pressed && e1.source === 'keyboard' && e1.code === code && !e1.repeat;
      r.up(code); const e2 = r.events[r.events.length - 1];
      if (!(good && e2.action === a && !e2.pressed && r.input.isDown(a) === false)) { allOk = false; bad.push(a + ':' + code); }
    }
    ok(allOk, 'defaults/keyboard-every-binding', bad.join(','));
    const r0 = rig(); r0.key('KeyG'); r0.key('Digit1'); r0.key('F5');
    eq(r0.events.length, 0, 'defaults/unbound-keys-do-nothing');
    eq(r0.input.bindings.get().keyboard, WANT_KEYS, 'defaults/keyboard-table');
    eq(r0.input.bindings.get().gamepad.buttons, WANT_PAD.xbox, 'defaults/gamepad-buttons');
    eq(r0.input.bindings.defaults('gamepad', 'nintendo'), WANT_PAD.nintendo, 'defaults/gamepad-buttons-nintendo');
    // every pad default, driven through a real (fake) pad, for both layouts
    for (const [layout, id] of [['xbox', XBOX], ['nintendo', PRO]]) {
      let good = true; const badp = [];
      for (const a of Object.keys(WANT_PAD[layout])) for (const idx of WANT_PAD[layout][a]) {
        const r = rig(); r.pads.add(0, id); r.padEvent('gamepadconnected', 0); r.at(1000); const m = r.mark();
        r.pads.btn(0, idx); r.at(1016); const d = r.since(m); r.pads.btn(0, idx, false); r.at(1032);
        const up = r.since(m + d.length);
        if (!(d.length === 1 && d[0].action === a && d[0].pressed && d[0].source === 'gamepad' && up.length === 1 && up[0].action === a && !up[0].pressed)) { good = false; badp.push(a + ':' + idx + ' -> ' + sig(d)); }
      }
      ok(good, 'defaults/gamepad-every-binding-' + layout, badp.join(' | '));
    }
  }

  /* ------------------------------------------------------------------------------------------------ repeat timing */
  {
    const repeatTimes = (start, pressFn, releaseFn, until = 1700) => {
      const r = rig(); r.clock.t = start; r.input.poll(); pressFn(r); const times = [];
      for (let t = start; t <= until; t++) { r.at(t); }
      const reps = r.events.filter((e) => e.repeat && e.pressed);
      reps.forEach((e) => times.push(e.time));
      releaseFn(r);
      return { times, r };
    };
    const kb = repeatTimes(1000, (r) => r.key('ArrowDown'), (r) => r.up('ArrowDown'));
    eq(kb.times.slice(0, 4), [1400, 1490, 1580, 1670], 'repeat/keyboard-times-exact');
    ok(kb.times[0] === 1400, 'repeat/first-at-400ms', kb.times);
    ok(kb.times.length >= 2 && kb.times.slice(1).every((t, i) => t - kb.times[i] === 90), 'repeat/interval-90ms', kb.times);
    ok(kb.times[0] - 1000 === 400 && kb.times.length === 4, 'repeat/none-before-delay', kb.times);
    const dp = repeatTimes(1000, (r) => { r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); r.pads.btn(0, 13); }, () => {});
    ok(dp.times[0] - 1000 >= 400 && dp.times[0] - 1000 <= 401 && dp.times.slice(1).every((t, i) => t - dp.times[i] === 90), 'repeat/dpad-identical', dp.times);
    const st = repeatTimes(1000, (r) => { r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); r.pads.axis(0, 1, 0.9); }, () => {});
    ok(st.times[0] - 1000 >= 400 && st.times[0] - 1000 <= 401 && st.times.slice(1).every((t, i) => t - st.times[i] === 90), 'repeat/stick-identical', st.times);
    // a LATE poll yields one repeat, not a storm, and the rhythm stays aligned to press + 400 + k * 90
    const late = rig(); late.key('ArrowUp'); late.at(1100); late.at(2000);
    const lr = late.events.filter((e) => e.repeat);
    ok(lr.length === 1 && lr[0].time === 2000, 'repeat/late-poll-one-repeat', lr.map((e) => e.time));
    late.at(2029); ok(late.events.filter((e) => e.repeat).length === 1, 'repeat/late-poll-rhythm-before', late.events.length);
    late.at(2030); ok(late.events.filter((e) => e.repeat).length === 2, 'repeat/late-poll-rhythm-aligned', late.events.filter((e) => e.repeat).map((e) => e.time));
    // A and B never repeat; isDown exposes the hold
    const ab = rig(); ab.key('KeyZ'); ab.key('KeyX');
    for (let t = 1000; t <= 6000; t += 16) ab.at(t);
    ok(ab.events.filter((e) => e.repeat).length === 0 && ab.input.isDown('a') && ab.input.isDown('b'), 'repeat/a-and-b-never-repeat', sig(ab.events));
    ab.up('KeyZ'); ab.up('KeyX'); ok(!ab.input.isDown('a') && !ab.input.isDown('b'), 'repeat/hold-released');
    // releasing stops the repeat
    const rl = rig(); rl.key('ArrowLeft'); rl.at(1450); rl.up('ArrowLeft'); const before = rl.events.length; rl.at(1600); rl.at(2000);
    ok(rl.events.length === before, 'repeat/release-stops-repeat');
    // two keys for one action do not double the repeat rate
    const dk = rig(); dk.key('ArrowDown'); dk.key('KeyS'); for (let t = 1000; t <= 1480; t++) dk.at(t);
    ok(dk.events.filter((e) => e.repeat).length === 1, 'repeat/two-holders-one-repeat-stream', sig(dk.events));
  }

  /* ----------------------------------------------------------------------------------- e.repeat, release paths */
  {
    const r = rig(); r.key('KeyZ'); r.key('KeyZ', { repeat: true }); r.key('KeyZ', { repeat: true });
    eq(sig(r.events), '+a', 'keyboard/os-autorepeat-ignored');
    const r2 = rig(); r2.key('KeyZ'); r2.win.dispatchEvent(ev('blur')); r2.key('KeyZ', { repeat: true });
    eq(sig(r2.events), '+a -a', 'keyboard/os-autorepeat-after-release-ignored');
    const r3 = rig(); r3.key('KeyZ', { repeat: true }); eq(r3.events.length, 0, 'keyboard/os-autorepeat-first-event-ignored');
    const rb = rig(); rb.key('KeyZ'); rb.key('ArrowUp'); rb.win.dispatchEvent(ev('blur'));
    ok(!rb.input.isDown('a') && !rb.input.isDown('up') && sig(rb.events.slice(2)).split(' ').sort().join(' ') === '-a -up', 'release/blur', sig(rb.events));
    const rv = rig(); rv.key('KeyZ'); rv.doc.hidden = true; rv.doc.dispatchEvent(ev('visibilitychange'));
    ok(!rv.input.isDown('a') && sig(rv.events) === '+a -a', 'release/visibilitychange', sig(rv.events));
    const rv2 = rig(); rv2.key('KeyZ'); rv2.doc.dispatchEvent(ev('visibilitychange')); ok(rv2.input.isDown('a'), 'release/visible-again-keeps-hold');
    const rp = rig(); rp.key('KeyZ'); rp.win.dispatchEvent(ev('pagehide')); ok(!rp.input.isDown('a'), 'release/pagehide');
    const re = rig(); re.key('KeyZ'); re.input.setEnabled(false); ok(!re.input.isDown('a'), 'release/setEnabled-false');
    re.key('KeyX'); ok(re.events.length === 2, 'release/disabled-ignores-keys'); re.input.setEnabled(true); re.key('KeyX'); ok(re.input.isDown('b'), 'release/re-enabled');
    // a keyup with no matching keydown is harmless
    const ru = rig(); ru.up('KeyZ'); ok(ru.events.length === 0, 'keyboard/stray-keyup-harmless');
    // two holders of one action: released only when the LAST lets go
    const rh = rig(); rh.pads.add(0, XBOX); rh.padEvent('gamepadconnected', 0); rh.at(1000);
    rh.key('ArrowUp'); rh.pads.btn(0, 12); rh.at(1016); rh.up('ArrowUp');
    ok(rh.input.isDown('up') && sig(rh.events) === '+up', 'holders/two-holders-release-last', sig(rh.events));
    rh.pads.btn(0, 12, false); rh.at(1032); ok(!rh.input.isDown('up') && sig(rh.events) === '+up -up', 'holders/exactly-one-release', sig(rh.events));
    // press / release API for on-screen pads, with its own token per source
    const ra = rig(); ra.input.press('a'); ra.input.press('a'); ra.input.release('a'); ok(!ra.input.isDown('a') && ra.events.filter((e) => e.pressed).length === 1, 'holders/press-release-api');
    ok(ra.events[0].source === 'touch', 'holders/press-default-source-touch');
    ra.input.press('b', 'mouse'); ra.input.press('b', 'touch'); ra.input.release('b', 'mouse'); ok(ra.input.isDown('b'), 'holders/press-api-sources-are-separate-holders');
  }

  /* ------------------------------------------------------------------------------------------------------- guards */
  {
    const t = (tag, props) => tgt(tag, props);
    const probe = (target, code) => { const r = rig(); const e = r.key(code, { target }); return { n: r.events.length, prevented: e.defaultPrevented, ev: r.events[0] }; };
    for (const [name, target] of [['text-input', t('INPUT', { type: 'text' })], ['search-input', t('INPUT', { type: 'search' })], ['password-input', t('INPUT', { type: 'password' })], ['number-input', t('INPUT', { type: 'number' })], ['input-no-type', t('INPUT', { type: '' })], ['textarea', t('TEXTAREA')], ['select', t('SELECT')]]) {
      let good = true; const bad = [];
      for (const code of ['KeyZ', 'ArrowLeft', 'KeyW', 'Enter', 'Space', 'Backspace', 'Escape']) { const p = probe(target, code); if (p.n !== 0 || p.prevented) { good = false; bad.push(code); } }
      ok(good, 'guard/' + (name === 'text-input' ? 'text-input-not-swallowed' : name + '-not-swallowed'), bad.join(','));
    }
    { let good = true; for (const code of ['KeyZ', 'ArrowLeft', 'Backspace']) { const p = probe(t('DIV', { isContentEditable: true }), code); if (p.n !== 0 || p.prevented) good = false; } ok(good, 'guard/contenteditable-not-swallowed'); }
    // the control: the same keys on a non-text target ARE consumed
    for (const [name, target] of [['div', t('DIV')], ['canvas', t('CANVAS')], ['body', t('BODY')], ['button-nonnative-key', t('BUTTON')]]) {
      const p = probe(target, name === 'button-nonnative-key' ? 'KeyW' : 'KeyZ');
      ok(p.n === 1 && p.prevented, 'guard/control-consumed-on-' + name, p);
    }
    // native activation: Enter / Space on a button, Space on a checkbox are reported (native:true) but NOT prevented
    { const p = probe(t('BUTTON'), 'Enter'); ok(p.n === 1 && !p.prevented && p.ev.native === true, 'guard/enter-on-button-native', p); }
    { const r = rig(); const e = r.key('Space', { key: ' ', target: t('BUTTON') }); ok(r.events[0] && r.events[0].native && !e.defaultPrevented, 'guard/space-on-button-native'); }
    { const r = rig(); const e = r.key('Space', { key: ' ', target: t('INPUT', { type: 'checkbox' }) }); ok(r.events[0] && r.events[0].native && !e.defaultPrevented, 'guard/space-on-checkbox-native'); }
    { const r = rig(); const e = r.key('Enter', { key: 'Enter', target: t('INPUT', { type: 'checkbox' }) }); ok(r.events[0] && !r.events[0].native && e.defaultPrevented, 'guard/enter-on-checkbox-consumed'); }
    { const r = rig(); const e = r.key('Space', { key: ' ', target: t('A', { hasAttribute: (n) => n === 'href' }) }); ok(r.events[0] && !r.events[0].native && e.defaultPrevented, 'guard/space-on-link-consumed'); }
    { const r = rig(); const e = r.key('Enter', { key: 'Enter', target: t('A', { hasAttribute: (n) => n === 'href' }) }); ok(r.events[0] && r.events[0].native && !e.defaultPrevented, 'guard/enter-on-link-native'); }
    // range / radio keep their arrow keys; everything else about them is ours
    for (const type of ['range', 'radio']) {
      const pa = probe(t('INPUT', { type }), 'ArrowRight'); const pz = probe(t('INPUT', { type }), 'KeyZ');
      ok(pa.n === 0 && !pa.prevented && pz.n === 1 && pz.prevented, 'guard/' + type + '-keeps-arrows-only', { pa, pz });
    }
    // modifiers
    for (const [mod_, name] of [['ctrlKey', 'ctrl-held-ignored'], ['metaKey', 'meta-held-ignored'], ['altKey', 'alt-held-ignored']]) {
      const r = rig(); const e = r.key('KeyZ', { [mod_]: true, target: t('CANVAS') }); ok(r.events.length === 0 && !e.defaultPrevented, 'guard/' + name, sig(r.events));
    }
    { const r = rig(); const e = r.key('KeyZ', { ctrlKey: true, altKey: true }); ok(r.events.length === 0 && !e.defaultPrevented, 'guard/altgr-ignored'); }
    { const r = rig(); r.key('KeyZ', { shiftKey: true, target: t('CANVAS') }); ok(r.events.length === 1, 'guard/shift-held-still-acts'); }
    { const r = rig(); r.key('KeyZ', { isComposing: true }); r.key('KeyZ', { keyCode: 229 }); ok(r.events.length === 0, 'guard/ime-composition-ignored'); }
    { const r = rig(); const e = r.key('Tab', { target: t('BODY') }); ok(r.events.length === 0 && !e.defaultPrevented, 'guard/tab-never-touched'); const e2 = r.key('Tab', { shiftKey: true }); ok(!e2.defaultPrevented, 'guard/shift-tab-never-touched'); }
    { const r = rig(); const e = r.key('KeyZ'); r.up('KeyZ'); ok(e.defaultPrevented, 'guard/consumed-key-prevented'); const ku = r.up('KeyZ'); ok(!ku.defaultPrevented, 'guard/keyup-without-keydown-not-prevented'); }
    { const r = rig(); r.key('KeyZ'); const ku = r.up('KeyZ'); ok(ku.defaultPrevented === true, 'guard/keyup-of-a-consumed-key-prevented-too'); }
    { const r = rig(); const pre = ev('keydown', { code: 'KeyZ', key: 'z' }); pre.preventDefault(); r.win.dispatchEvent(pre); ok(r.events.length === 0, 'guard/already-prevented-by-inner-handler-ignored'); }
    // codeOf fallback for virtual keyboards that report no code
    { const r = rig(); r.key('', { key: 'z', code: '' }); r.up('', { key: 'z' }); ok(r.events.length >= 1 && r.events[0].action === 'a', 'keyboard/code-falls-back-to-key'); }
    ok(M.isBindableKey('KeyG') && !M.isBindableKey('Tab') && !M.isBindableKey('ShiftLeft') && !M.isBindableKey('F5') && !M.isBindableKey('MetaLeft') && !M.isBindableKey('') && !M.isBindableKey(12) && !M.isBindableKey('Key G'), 'rebind/reserved-keys-refused');
  }

  /* ---------------------------------------------------------------------------------------- stick, deadzone, diagonals */
  {
    const rs = M.resolveStick;
    ok(rs(null, 0.49, 0) === null, 'stick/enters-at-0.5-below-is-quiet');
    ok(rs(null, 0.5, 0) === 'right', 'stick/enter-boundary-0.5');
    ok(rs(null, 0.51, 0) === 'right' && rs(null, -0.6, 0) === 'left' && rs(null, 0, -0.9) === 'up' && rs(null, 0, 0.9) === 'down', 'stick/four-directions');
    ok(rs('right', 0.4, 0) === 'right' && rs('right', 0.36, 0) === 'right', 'stick/hysteresis-holds-0.4');
    ok(rs('right', 0.35, 0) === 'right', 'stick/exit-boundary-0.35-holds');
    ok(rs('right', 0.34, 0) === null && rs('right', 0.349, 0) === null, 'stick/exit-below-0.35-releases');
    ok(rs(null, 0.4, 0) === null && rs(null, 0.36, 0) === null, 'stick/no-entry-in-hysteresis-band');
    ok(rs('left', -0.4, 0) === 'left' && rs('left', -0.34, 0) === null && rs('up', 0, -0.36) === 'up' && rs('down', 0, 0.3) === null, 'stick/hysteresis-all-directions');
    ok(rs(null, 0.8, 0.7) === 'right' && rs(null, 0.7, 0.8) === 'down' && rs(null, -0.8, -0.7) === 'left' && rs(null, 0.7, -0.8) === 'up', 'stick/diagonal-dominant-axis');
    ok(rs(null, 0.6, 0.6) === 'right', 'stick/diagonal-tie-is-horizontal');
    ok(rs('right', 0.6, 0.55) === 'right' && rs('right', 0.6, 0.6) === 'right', 'stick/diagonal-handover-needs-larger-axis');
    ok(rs('right', 0.4, 0.6) === 'down' && rs('right', 0.4, 0.45) === 'right', 'stick/diagonal-handover-when-other-axis-wins');
    ok(rs(null, NaN, undefined) === null && rs(null, 'x', null) === null, 'stick/garbage-axes-are-quiet');
    // through a real (fake) pad: one direction at a time, never two
    const r = rig(); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000);
    r.pads.axis(0, 0, 0.8); r.pads.axis(0, 1, 0.7); r.at(1016);
    ok(sig(r.events) === '+right', 'stick/diagonal-fires-one-action-only', sig(r.events));
    r.pads.axis(0, 0, 0.4); r.pads.axis(0, 1, 0.9); r.at(1032);
    ok(sig(r.events) === '+right -right +down', 'stick/diagonal-hands-over-cleanly', sig(r.events));
    r.pads.axis(0, 0, 0); r.pads.axis(0, 1, 0); r.at(1048); ok(!r.input.isDown('down') && !r.input.isDown('right'), 'stick/centre-releases');
    // the right stick scrolls (wheel pointer events), Y only
    const rr = rig(); rr.pads.add(0, XBOX); rr.padEvent('gamepadconnected', 0); rr.at(1000);
    rr.pads.axis(0, 3, 0.9); rr.at(1016); rr.at(1100); rr.at(1160); rr.at(1200);
    const wh = rr.pointers.filter((p) => p.kind === 'wheel');
    ok(wh.length >= 2 && wh.every((p) => p.steps === 1 && p.x === null && p.source === 'gamepad'), 'stick/right-stick-scrolls-down', wh.length);
    ok(rr.events.length === 0, 'stick/right-stick-makes-no-action');
    rr.pads.axis(0, 3, -0.9); rr.at(1300); ok(rr.pointers.filter((p) => p.kind === 'wheel').pop().steps === -1, 'stick/right-stick-scrolls-up');
  }

  /* ---------------------------------------------------------------------------------------- layout, hot-plug, pads */
  {
    const face = (id, idx) => { const r = rig(); r.pads.add(0, id); r.padEvent('gamepadconnected', 0); r.at(1000); const m = r.mark(); r.pads.btn(0, idx); r.at(1016); return (r.since(m)[0] || {}).action; };
    ok(face(XBOX, 0) === 'a' && face(XBOX, 1) === 'b' && face(XBOX, 2) === 'x' && face(XBOX, 3) === 'y', 'layout/xbox-confirm-is-south');
    ok(face(PRO, 1) === 'a' && face(PRO, 0) === 'b' && face(PRO, 3) === 'x' && face(PRO, 2) === 'y', 'layout/nintendo-confirm-is-east');
    ok(face('Wireless Gamepad (Vendor: 057e Product: 2009)', 1) === 'a', 'layout/id-057e-only');
    ok(face('Nintendo Switch Joy-Con (L)', 1) === 'a' && face('Some Joycon thing', 1) === 'a' && face('NINTENDO pad', 1) === 'a', 'layout/id-keywords');
    ok(face(DS4, 0) === 'a' && face(DS4, 1) === 'b', 'layout/playstation-follows-xbox');
    ok(face(GENERIC, 0) === 'a' && face('', 0) === 'a', 'layout/unknown-follows-xbox');
    ok(M.padFamily(XBOX) === 'xbox' && M.padFamily(PRO) === 'nintendo' && M.padFamily(DS4) === 'playstation' && M.padFamily(GENERIC) === 'generic' && M.padFamily('8BitDo Pro 2 (Vendor: 2dc8)') === 'generic', 'layout/family-detection');
    { const r = rig(); r.input.bindings.setLayout('nintendo'); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); const m = r.mark(); r.pads.btn(0, 1); r.at(1016); ok(r.since(m)[0].action === 'a', 'layout/forced-nintendo-on-xbox-pad'); }
    { const r = rig(); r.input.bindings.setLayout('xbox'); r.pads.add(0, PRO); r.padEvent('gamepadconnected', 0); r.at(1000); const m = r.mark(); r.pads.btn(0, 0); r.at(1016); ok(r.since(m)[0].action === 'a', 'layout/forced-xbox-on-nintendo-pad'); }
    ok(!rig().input.bindings.setLayout('bogus') && rig().input.bindings.layout() === 'auto', 'layout/bad-value-refused');
    // two pads of different families on the one page: each gets ITS OWN layout under auto
    { const r = rig(); r.pads.add(0, XBOX); r.pads.add(1, PRO); r.padEvent('gamepadconnected', 0); r.padEvent('gamepadconnected', 1); r.at(1000); const m = r.mark();
      r.pads.btn(0, 0); r.pads.btn(1, 0); r.at(1016); eq(r.since(m).map((e) => e.action).sort(), ['a', 'b'], 'layout/two-pads-each-own-layout'); }
    // hot-plug
    { const r = rig(); eq(r.input.pads, [], 'hotplug/starts-empty');
      r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0);
      ok(r.devices.length === 1 && r.devices[0].connected === true && r.devices[0].source === 'gamepad' && r.devices[0].id === XBOX && r.input.pads.length === 1, 'hotplug/event-adds-pad', r.devices);
      ok(r.input.pads[0].family === 'xbox' && r.input.pads[0].standard === true, 'hotplug/pad-snapshot');
      r.padEvent('gamepadconnected', 0); ok(r.devices.length === 1, 'hotplug/duplicate-connect-ignored');
      r.pads.add(1, PRO); r.at(1000); ok(r.input.pads.length === 2 && r.devices.length === 2, 'hotplug/second-pad-found-by-polling');
      r.at(1016); r.pads.btn(0, 0); r.at(1032); ok(r.input.isDown('a'), 'hotplug/any-pad-drives-menus');
      r.pads.remove(0); r.padEvent('gamepaddisconnected', 0);
      ok(!r.input.isDown('a') && r.devices[r.devices.length - 1].connected === false && r.input.pads.length === 1, 'hotplug/disconnect-event-immediate', sig(r.events));
      r.pads.remove(1); r.at(1048); ok(r.input.pads.length === 0 && r.devices[r.devices.length - 1].connected === false, 'hotplug/vanish-detected-by-polling'); }
    { const r = rig(); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); r.pads.btn(0, 13); r.pads.btn(0, 0); r.pads.axis(0, 0, 0.9); r.at(1016);
      ok(r.input.isDown('down') && r.input.isDown('a') && r.input.isDown('right'), 'release/precondition');
      r.pads.remove(0); r.padEvent('gamepaddisconnected', 0);
      ok(!r.input.isDown('down') && !r.input.isDown('a') && !r.input.isDown('right') && r.input.held.length === 0, 'release/pad-disconnect-while-held', sig(r.events)); }
    { const r = rig(); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); r.pads.btn(0, 13); r.at(1016); r.win.dispatchEvent(ev('blur'));
      ok(!r.input.isDown('down'), 'release/blur-releases-pad-hold'); r.at(1032); ok(!r.input.isDown('down'), 'release/blur-held-button-does-not-refire'); r.pads.btn(0, 13, false); r.at(1048); r.pads.btn(0, 13); r.at(1064); ok(r.input.isDown('down'), 'release/after-blur-new-press-works'); }
    // non-standard mapping: never a crash, and a clear flag
    { const r = rig(); r.pads.add(0, GENERIC, { mapping: '', nb: 12, na: 2 }); r.padEvent('gamepadconnected', 0); r.at(1000);
      ok(r.input.pads[0].standard === false && r.devices[0].standard === false, 'pads/non-standard-flagged');
      r.pads.btn(0, 0); r.at(1016); ok(r.input.isDown('a'), 'pads/non-standard-best-effort-buttons');
      r.pads.axis(0, 0, 0.9); r.at(1032); ok(r.input.isDown('right'), 'pads/non-standard-stick-best-effort');
      let threw = false; try { r.pads.add(1, GENERIC, { mapping: '', nb: 0, na: 0 }); r.at(1048); r.pads.list[2] = { id: 'weird', index: 2, connected: true, mapping: '', buttons: null, axes: null }; r.at(1064); r.pads.list[3] = { id: 'weirder', index: 3, connected: true, mapping: 'standard', buttons: [], axes: [] }; r.at(1080); } catch (_e) { threw = true; }
      ok(!threw && r.input.pads.length === 4, 'pads/odd-pads-do-not-crash', r.input.pads.length); }
    { const r = rig(); r.pads.throws = true; r.key('KeyZ'); r.at(1016); r.pads.throws = false; ok(r.input.isDown('a'), 'pads/provider-that-throws-is-survived'); }
    { const r = rig(); r.pads.add(0, XBOX); r.pads.list[0].buttons = r.pads.list[0].buttons.map((b, i) => (i === 6 ? 0.9 : b)); r.padEvent('gamepadconnected', 0); r.at(1000); ok(r.input.isDown('l'), 'pads/numeric-button-values-count'); }
    { const r = rig(); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); r.pads.list[0].buttons[7] = { pressed: false, value: 0.8 }; r.at(1016); ok(r.input.isDown('r'), 'pads/analog-trigger-value-counts'); }
    // no getGamepads() before the visitor has acted (consoles prompt on first use; see lib/xboxinput.js)
    { const r = rig(); for (let t = 1000; t <= 1900; t += 100) r.at(t); ok(r.pads.calls === 0, 'gamepad/no-getgamepads-before-user-action', 'calls ' + r.pads.calls);
      r.key('KeyG'); ok(r.pads.calls === 1, 'gamepad/scan-on-first-user-action', 'calls ' + r.pads.calls);
      r.clock.t = 2000; r.key('KeyG'); r.up('KeyG'); ok(r.pads.calls === 1, 'gamepad/scan-is-rate-limited', 'calls ' + r.pads.calls);
      r.clock.t = 2900; r.key('KeyG'); ok(r.pads.calls === 2, 'gamepad/scan-again-after-a-second', 'calls ' + r.pads.calls); }
    { const r = rig(); r.pads.add(0, XBOX); r.win.dispatchEvent(ev('pointerdown', { pointerType: 'mouse' })); ok(r.input.pads.length === 1, 'gamepad/click-finds-an-already-exposed-pad'); }
  }

  /* ----------------------------------------------------------------------------------------- rebinding / storage */
  {
    const r = rig(); const B = r.input.bindings;
    let res = B.rebind('keyboard', 'a', 0, 'KeyG');
    ok(res.ok && B.get().keyboard.a.join() === 'KeyG,Enter,Space,NumpadEnter', 'rebind/slot-replaced', res);
    r.key('KeyG'); ok(r.input.isDown('a'), 'rebind/new-key-takes-effect'); r.up('KeyG');
    const m = r.mark(); r.key('KeyZ'); ok(r.since(m).length === 0, 'rebind/old-key-released-from-action'); r.up('KeyZ');
    res = B.rebind('keyboard', 'b', 0, 'KeyG');
    ok(!res.ok && res.reason === 'conflict' && res.conflicts.join() === 'a', 'rebind/conflict-detected', res);
    ok(B.get().keyboard.b[0] === 'KeyX' && B.get().keyboard.a[0] === 'KeyG', 'rebind/conflict-reject-changes-nothing');
    ok(B.conflicts('keyboard', 'b', 'KeyG').join() === 'a' && B.conflicts('keyboard', 'b', 'KeyJ').length === 0, 'rebind/conflicts-query');
    res = B.rebind('keyboard', 'b', 0, 'KeyG', { onConflict: 'swap' });
    ok(res.ok && B.get().keyboard.b[0] === 'KeyG' && B.get().keyboard.a[0] === 'KeyX', 'rebind/swap-gives-the-other-action-the-old-key', B.get().keyboard);
    res = B.rebind('keyboard', 'x', 0, 'KeyX', { onConflict: 'move' });
    ok(res.ok && B.get().keyboard.x[0] === 'KeyX' && !B.get().keyboard.a.includes('KeyX'), 'rebind/move-takes-the-key-away', B.get().keyboard);
    ok(!B.rebind('keyboard', 'y', 0, 'Tab').ok && !B.rebind('keyboard', 'y', 0, 'F5').ok && !B.rebind('keyboard', 'y', 0, 'ShiftLeft').ok && !B.rebind('bogus', 'y', 0, 'KeyJ').ok && !B.rebind('keyboard', 'nope', 0, 'KeyJ').ok, 'rebind/invalid-refused');
    ok(B.rebind('keyboard', 'y', 5, 'KeyJ').ok && B.get().keyboard.y.join() === 'KeyV,KeyJ', 'rebind/slot-past-end-appends');
    ok(B.remove('keyboard', 'y', 1).ok && B.get().keyboard.y.join() === 'KeyV', 'rebind/remove-slot');
    { const rf = rig(); for (const c of ['KeyJ', 'KeyK', 'KeyL', 'KeyN', 'KeyM']) rf.input.bindings.rebind('keyboard', 'x', 9, c); const full = rf.input.bindings.rebind('keyboard', 'x', 9, 'KeyB'); ok(!full.ok && full.reason === 'full', 'rebind/list-is-capped', full); }
    // persistence
    const stored = JSON.parse(r.store.getItem('arena.bindings'));
    ok(stored.v === 1 && stored.keyboard && stored.gamepad.layout === 'auto', 'rebind/persisted-versioned-schema', stored);
    const r2 = rig({ storage: r.store });
    eq(r2.input.bindings.get().keyboard, r.input.bindings.get().keyboard, 'rebind/survives-a-new-input-layer');
    ok(r2.input.bindings.status().status === 'loaded' && r2.input.bindings.status().persisted === false, 'rebind/status-loaded');
    // defaults are not written
    const r3 = rig(); ok(r3.store.getItem('arena.bindings') === null, 'rebind/defaults-write-nothing');
    r3.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); ok(r3.store.getItem('arena.bindings') !== null, 'rebind/customised-writes');
    r3.input.bindings.rebind('keyboard', 'a', 0, 'KeyZ'); ok(r3.store.getItem('arena.bindings') === null && !r3.input.bindings.get().customized.keyboard, 'rebind/back-to-default-removes-key', r3.store.getItem('arena.bindings'));
    // reset, per device
    const r4 = rig(); r4.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); r4.input.bindings.rebind('gamepad', 'a', 0, 10); r4.input.bindings.setLayout('nintendo');
    r4.input.bindings.reset('keyboard'); ok(r4.input.bindings.get().keyboard.a[0] === 'KeyZ' && r4.input.bindings.get().gamepad.buttons.a[0] === 10, 'rebind/reset-keyboard-only');
    r4.input.bindings.reset('gamepad'); ok(r4.input.bindings.get().gamepad.buttons.a.join() === '0' && r4.input.bindings.layout() === 'auto' && r4.store.getItem('arena.bindings') === null, 'rebind/reset-gamepad-also-clears-layout');
    r4.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); r4.input.bindings.rebind('gamepad', 'a', 0, 10); r4.input.bindings.reset(); ok(!r4.input.bindings.get().customized.keyboard && !r4.input.bindings.get().customized.gamepad, 'rebind/reset-all');
    // gamepad rebinding takes effect
    const r5 = rig(); const rb5 = r5.input.bindings.rebind('gamepad', 'a', 0, 10); r5.pads.add(0, XBOX); r5.padEvent('gamepadconnected', 0); r5.at(1000); r5.pads.btn(0, 10); r5.at(1016); const aDown = r5.input.isDown('a'); r5.pads.btn(0, 10, false); r5.pads.btn(0, 0); r5.at(1032);
    ok(rb5.ok && aDown && !r5.input.isDown('a'), 'rebind/gamepad-new-button-takes-effect', sig(r5.events));
    { const rc = rig(); const bad = rc.input.bindings.rebind('gamepad', 'a', 0, 7); ok(!bad.ok && bad.conflicts.join() === 'r', 'rebind/gamepad-trigger-conflicts-with-r-by-default', bad); }
    { const rg = rig(); const c = rg.input.bindings.rebind('gamepad', 'a', 0, 1); ok(!c.ok && c.reason === 'conflict' && c.conflicts.join() === 'b', 'rebind/gamepad-conflict-detected', c);
      const sw = rg.input.bindings.rebind('gamepad', 'a', 0, 1, { onConflict: 'swap' }); ok(sw.ok && rg.input.bindings.get().gamepad.buttons.a.join() === '1' && rg.input.bindings.get().gamepad.buttons.b.join() === '0', 'rebind/gamepad-swap'); }
    // W1 fix A1: THE TRAP. Binding Back to A's button and answering the conflict with "use it here only" used to leave A with no button at all, so a controller-only player could no
    // longer press Reset (only A activates it), and the empty list was saved. Now: refused; the last binding of a core action stays; an empty saved list falls back; and Start + Select
    // held for 2 s are an escape that reads the physical buttons and so cannot be bound away.
    { const rm = rig(); const res = rm.input.bindings.rebind('gamepad', 'b', 0, 0, { onConflict: 'move' }); const g = rm.input.bindings.get().gamepad.buttons;
      ok(!res.ok && res.reason === 'would-empty' && res.conflicts.join() === 'a' && g.a.join() === '0' && g.b.join() === '1' && rm.store.getItem('arena.bindings') === null, 'trap/move-that-would-empty-a-core-action-is-refused', res);
      const kb = rm.input.bindings.rebind('keyboard', 'b', 0, 'KeyZ', { onConflict: 'move' }); ok(kb.ok && rm.input.bindings.get().keyboard.a.length > 0, 'trap/a-move-that-leaves-the-other-action-a-binding-still-works', kb); }
    { const rm = rig(); const res = rm.input.bindings.remove('gamepad', 'a', 0); const other = rm.input.bindings.remove('gamepad', 'x', 0);
      ok(!res.ok && res.reason === 'last' && rm.input.bindings.get().gamepad.buttons.a.join() === '0' && other.ok, 'trap/last-binding-of-a-core-action-stays', res); }
    { const st = new Storage_(); st.setItem('arena.bindings', JSON.stringify({ v: 1, keyboard: {}, gamepad: { layout: 'auto', buttons: { a: [], b: [0] } } }));
      const rs = rig({ storage: st }); rs.pads.add(0, XBOX); rs.padEvent('gamepadconnected', 0); rs.at(1000); rs.pads.btn(0, 0); rs.at(1016);
      ok(rs.input.bindings.get().gamepad.buttons.a.join() === '0' && rs.input.isDown('a') && rs.input.bindings.status().problems.some((p) => /gamepad\.buttons\.a/.test(p)), 'trap/an-empty-saved-list-for-a-core-action-falls-back-to-the-default', rs.input.bindings.status()); }
    { const re = rig(); re.input.bindings.rebind('gamepad', 'a', 0, 10); re.input.bindings.rebind('gamepad', 'b', 0, 11);
      re.pads.add(0, XBOX); re.padEvent('gamepadconnected', 0); re.at(1000); re.pads.btn(0, 8); re.pads.btn(0, 9); re.at(1016); re.at(2000);
      const early = re.input.bindings.get().gamepad.buttons.a.join() + '/' + re.input.bindings.get().gamepad.buttons.b.join();
      re.at(3100);
      const g = re.input.bindings.get().gamepad.buttons;
      ok(early === '10/11' && g.a.join() === '0' && g.b.join() === '1' && re.store.getItem('arena.bindings') === null, 'trap/start-plus-select-held-2s-resets-the-controller-bindings', early + ' then ' + JSON.stringify(g));
      const rf = rig(); rf.input.bindings.rebind('gamepad', 'a', 0, 10);
      rf.pads.add(0, XBOX); rf.padEvent('gamepadconnected', 0); rf.at(1000); rf.pads.btn(0, 8); rf.pads.btn(0, 9); rf.at(1016); rf.at(2500); rf.pads.btn(0, 8, false); rf.at(2600); rf.pads.btn(0, 8); rf.at(2700); rf.at(4000);
      ok(rf.input.bindings.get().gamepad.buttons.a.join() === '10', 'trap/the-escape-needs-both-buttons-held-for-the-whole-time', rf.input.bindings.get().gamepad.buttons.a.join()); }
    // layout persisted
    { const rl = rig(); rl.input.bindings.setLayout('nintendo'); const rl2 = rig({ storage: rl.store }); ok(rl2.input.bindings.layout() === 'nintendo', 'rebind/layout-persisted'); }
    // bindings event
    { const rb = rig(); let n = 0; rb.input.on('bindings', () => n++); rb.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); rb.input.bindings.reset(); ok(n === 2, 'rebind/bindings-event'); }
  }
  {
    // hostile storage: nothing may throw, defaults must hold
    const hostile = [['null-json', 'null'], ['string', '"hello"'], ['array', '[1,2,3]'], ['number', '42'], ['not-json', '{{{'], ['empty', ''], ['wrong-version', JSON.stringify({ v: 2, keyboard: { a: ['KeyG'] } })],
      ['no-version', JSON.stringify({ keyboard: { a: ['KeyG'] } })], ['version-string', JSON.stringify({ v: '1' })], ['huge', 'x'.repeat(30000)]];
    for (const [name, text] of hostile) {
      let r, threw = false; try { r = rig({ storage: new Storage_({ 'arena.bindings': text }) }); r.key('KeyZ'); r.up('KeyZ'); } catch (_e) { threw = true; }
      ok(!threw && r.input.bindings.get().keyboard.a[0] === 'KeyZ' && !r.input.bindings.get().customized.keyboard, 'storage/hostile-' + name + '-falls-back', threw ? 'threw' : r.input.bindings.get().keyboard.a);
      if (!threw) ok(['invalid', 'default'].includes(r.input.bindings.status().status), 'storage/hostile-' + name + '-status', r.input.bindings.status());
    }
    ok(rig({ storage: new Storage_({ 'arena.bindings': JSON.stringify({ v: 2, keyboard: {} }) }) }).input.bindings.status().status === 'invalid', 'storage/wrong-version-falls-back');
    // piecewise: bad pieces dropped, good pieces kept
    const mixed = JSON.stringify({ v: 1, keyboard: { a: ['KeyG'], b: 'KeyX', x: ['Tab'], y: [1, 2], l: Array(50).fill('KeyJ'), r: ['<script>'], up: ['ArrowUp'], bogus: ['KeyK'] },
      gamepad: { layout: 'xbox', buttons: { a: [7], b: [-1], x: [1.5], y: ['2'], l: [999], r: 'no' } } }).replace('{"v":1,', '{"v":1,"__proto__":{"polluted":true},').replace('"keyboard":{', '"keyboard":{"__proto__":{"polluted":true},').replace('"buttons":{', '"buttons":{"constructor":[1],"__proto__":[2],');
    ok(Object.prototype.hasOwnProperty.call(JSON.parse(mixed), '__proto__'), 'storage/fixture-really-has-own-proto-keys');
    const rm = rig({ storage: new Storage_({ 'arena.bindings': mixed }) }); const g = rm.input.bindings.get();
    ok(g.keyboard.a.join() === 'KeyG' && g.keyboard.b.join() === 'KeyX,Backspace,Escape' && g.keyboard.x.join() === 'KeyC' && g.keyboard.y.join() === 'KeyV' && g.keyboard.r.join() === 'KeyE,PageDown' && g.keyboard.up.join() === 'ArrowUp', 'storage/hostile-keyboard-entries-rejected', g.keyboard);
    ok(g.keyboard.l.join() === 'KeyQ,PageUp', 'storage/oversized-list-rejected', g.keyboard.l);
    ok(g.gamepad.buttons.a.join() === '7' && g.gamepad.buttons.b.join() === '1' && g.gamepad.buttons.x.join() === '2' && g.gamepad.buttons.l.join() === '4,6' && g.gamepad.layout === 'xbox', 'storage/hostile-gamepad-entries-rejected', g.gamepad.buttons);
    ok(rm.input.bindings.status().status === 'repaired' && rm.input.bindings.status().problems.length >= 8, 'storage/repaired-status-lists-problems', rm.input.bindings.status());
    ok(g.keyboard.bogus === undefined && ({}).polluted === undefined && Object.prototype.polluted === undefined, 'storage/no-prototype-pollution-and-unknown-actions-dropped');
    ok(M.parseStoredBindings('{"v":1,"gamepad":{"layout":"nope"}}').problems.length === 1 && M.parseStoredBindings('{"v":1,"gamepad":{"layout":"nope"}}').layout === 'auto', 'storage/bad-layout-rejected');
    ok(M.parseStoredBindings(null).ok === false && M.parseStoredBindings(undefined).ok === false && M.parseStoredBindings({}).ok === false, 'storage/non-string-input-safe');
    // storage that throws / is absent / full
    const sg = new Storage_(); sg.failGet = true; const rg = rig({ storage: sg }); rg.key('KeyZ'); ok(rg.input.isDown('a') && rg.input.bindings.status().status === 'error', 'storage/get-throws-survived', rg.input.bindings.status());
    const ss = new Storage_(); ss.failSet = true; const rs_ = rig({ storage: ss }); const rr = rs_.input.bindings.rebind('keyboard', 'a', 0, 'KeyG');
    ok(rr.ok && rs_.input.bindings.get().keyboard.a[0] === 'KeyG' && rs_.input.bindings.status().persisted === false, 'storage/set-throws-keeps-memory-state', rs_.input.bindings.status());
    const rn = rig({ storage: null }); const rr2 = rn.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); rn.key('KeyG');
    ok(rr2.ok && rn.input.isDown('a') && rn.input.bindings.status().status === 'absent' && rn.input.bindings.status().hasStorage === false, 'storage/absent-layer-still-works', rn.input.bindings.status());
    // a storage event from another tab reloads
    const rx = rig(); rx.store.setItem('arena.bindings', JSON.stringify({ v: 1, keyboard: { a: ['KeyG'] } })); rx.win.dispatchEvent(ev('storage', { key: 'arena.bindings' }));
    ok(rx.input.bindings.get().keyboard.a[0] === 'KeyG', 'storage/other-tab-change-reloads');
  }

  /* -------------------------------------------------------------------------------------------------- glyph by source */
  {
    const r = rig(); const gl = (a, s) => r.input.glyph(a, s);
    ok(gl('a', 'keyboard') === 'Z' && gl('b', 'keyboard') === 'X' && gl('up', 'keyboard') === 'Up' && gl('start', 'keyboard') === 'P' && gl('l', 'keyboard') === 'Q', 'glyph/by-source');
    ok(gl('a', 'mouse') === 'Click' && gl('b', 'mouse') === 'Right-click' && gl('a', 'touch') === 'A' && gl('b', 'touch') === 'B', 'glyph/mouse-and-touch');
    ok(r.input.lastSource === 'keyboard' && gl('a') === 'Z', 'glyph/defaults-to-last-source');
    r.win.dispatchEvent(ev('pointerdown', { pointerType: 'mouse' })); ok(r.input.lastSource === 'mouse' && gl('a') === 'Click', 'glyph/follows-last-source-mouse');
    r.win.dispatchEvent(ev('pointerdown', { pointerType: 'touch' })); ok(r.input.lastSource === 'touch' && gl('a') === 'A', 'glyph/follows-last-source-touch');
    r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); r.at(1000); ok(gl('a', 'gamepad') === 'A button' && gl('b', 'gamepad') === 'B button' && gl('l', 'gamepad') === 'LB' && gl('start', 'gamepad') === 'Menu', 'glyph/xbox-names');
    const rp = rig(); rp.pads.add(0, PRO); rp.padEvent('gamepadconnected', 0); rp.at(1000); ok(rp.input.glyph('a', 'gamepad') === 'A button' && rp.input.glyph('b', 'gamepad') === 'B button' && rp.input.glyph('x', 'gamepad') === 'X button' && rp.input.glyph('start', 'gamepad') === '+', 'glyph/nintendo-names-follow-the-console');
    const rd = rig(); rd.pads.add(0, DS4); rd.padEvent('gamepadconnected', 0); rd.at(1000); ok(rd.input.glyph('a', 'gamepad') === 'Cross' && rd.input.glyph('b', 'gamepad') === 'Circle' && rd.input.glyph('x', 'gamepad') === 'Square' && rd.input.glyph('y', 'gamepad') === 'Triangle' && rd.input.glyph('l', 'gamepad') === 'L1', 'glyph/playstation-names');
    r.input.bindings.rebind('keyboard', 'a', 0, 'KeyG'); ok(gl('a', 'keyboard') === 'G', 'glyph/follows-rebinding');
    r.input.bindings.rebind('gamepad', 'a', 0, 10); ok(gl('a', 'gamepad') === 'L3', 'glyph/gamepad-follows-rebinding');
    ok(gl('nope', 'keyboard') === '', 'glyph/unknown-action-empty');
    const rz = rig({ layoutMap: new Map([['KeyZ', 'w']]) }); ok(rz.input.glyph('a', 'keyboard') === 'W', 'glyph/layout-map-azerty');
    // lastSource follows real input
    const rs = rig(); ok(rs.input.sourceKnown === false, 'source/unknown-until-first-input'); rs.key('KeyZ'); ok(rs.input.sourceKnown === true && rs.input.lastSource === 'keyboard', 'source/keyboard');
    // lastSource starts as 'keyboard' only as a glyph default: the FIRST real input still has to be announced (uinav draws the focus ring from this event)
    { const r1 = rig(); r1.key('KeyZ'); ok(r1.sources.length === 1 && r1.sources[0].source === 'keyboard' && r1.sources[0].previous === null, 'source/first-keyboard-input-announces-itself', r1.sources);
      r1.up('KeyZ'); r1.key('KeyX'); ok(r1.sources.length === 1, 'source/keyboard-after-keyboard-is-not-a-change', r1.sources.length);
      const r2 = rig(); r2.win.dispatchEvent(ev('pointerdown', { pointerType: 'mouse' })); ok(r2.sources.length === 1 && r2.sources[0].source === 'mouse' && r2.sources[0].previous === null, 'source/first-mouse-input-announces-itself', r2.sources); }
    rs.win.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: 5, clientY: 5 })); ok(rs.input.lastSource === 'mouse', 'source/mouse-move');
    const n0 = rs.sources.length; rs.win.dispatchEvent(ev('pointermove', { pointerType: 'mouse', clientX: 5, clientY: 5 })); ok(rs.sources.length === n0 && rs.input.lastSource === 'mouse', 'source/layout-triggered-move-is-not-input');
    rs.key('Tab'); ok(rs.input.lastSource === 'keyboard', 'source/tab-counts-as-keyboard');
    rs.win.dispatchEvent(ev('pointerdown', { pointerType: 'touch' })); ok(rs.input.lastSource === 'touch', 'source/touch');
    rs.pads.add(0, XBOX); rs.padEvent('gamepadconnected', 0); rs.at(1000); rs.pads.btn(0, 0); rs.at(1016); ok(rs.input.lastSource === 'gamepad', 'source/gamepad-press');
    const last = rs.sources[rs.sources.length - 1]; ok(last.source === 'gamepad' && last.previous === 'touch', 'source/event-names-previous');
    const rs2 = rig(); rs2.pads.add(0, XBOX); rs2.padEvent('gamepadconnected', 0); rs2.at(1000); rs2.pads.btn(0, 16); rs2.at(1016); ok(rs2.input.lastSource === 'gamepad', 'source/unbound-pad-press-still-counts');
    // 'raw' events (the Controls panel's last-input readout)
    const rw = rig(); const raws = []; rw.input.on('raw', (e) => raws.push(e)); rw.key('KeyG'); rw.key('Tab'); rw.key('KeyZ', { target: tgt('INPUT', { type: 'text' }) });
    ok(raws.length === 2 && raws[0].label === 'G' && raws[0].device === 'keyboard', 'raw/keyboard-presses-reported-but-not-typing', raws);
  }

  /* -------------------------------------------------------------------------------------------- destroy / listeners */
  {
    const r = rig(); const el = fakeEl(); r.input.registerPointerTarget(el); const pad = fakeEl('BUTTON'); r.input.bindPad(pad, 'a');
    const total = () => r.win.reg.size + r.doc.reg.size + el.reg.size + pad.reg.size;
    ok(r.win.reg.size >= 8 && r.doc.reg.size >= 1 && el.reg.size >= 8 && pad.reg.size >= 6, 'destroy/listeners-registered', [r.win.reg.size, r.doc.reg.size, el.reg.size, pad.reg.size]);
    r.key('KeyZ'); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0);
    r.input.destroy();
    ok(total() === 0, 'destroy/removes-every-listener', [r.win.reg.size, r.doc.reg.size, el.reg.size, pad.reg.size]);
    const n = r.events.length; r.key('KeyX'); r.win.dispatchEvent(ev('gamepadconnected')); ok(r.events.length === n && !r.input.isDown('a') && r.input.destroyed === true, 'destroy/layer-is-dead-and-released');
    let dthrew = false; try { r.input.destroy(); r.input.destroy(); } catch (_e) { dthrew = true; } ok(!dthrew, 'destroy/idempotent');
    ok(r.input.pads.length === 0, 'destroy/pads-cleared');
    // unregister / unbind remove just their own
    const r2 = rig(); const e2 = fakeEl(); const off = r2.input.registerPointerTarget(e2); const p2 = fakeEl('BUTTON'); const un = r2.input.bindPad(p2, 'b'); off(); un();
    ok(e2.reg.size === 0 && p2.reg.size === 0, 'destroy/unregister-and-unbind-remove-their-own');
    let called = 0; const off1 = r2.input.on('action', () => { called++; }); r2.input.press('a'); r2.input.release('a'); const c1 = called; off1(); r2.input.press('a'); r2.input.release('a'); ok(c1 === 2 && called === 2, 'destroy/on-returns-off', [c1, called]);
  }

  /* ------------------------------------------------------------------------------------------------------ pointer */
  function fakeEl(tag = 'CANVAS', o = {}) {
    const el = new Target();
    const cls = new Set();
    Object.assign(el, { tagName: tag, style: {}, rect: o.rect || { left: 0, top: 0, width: 240, height: 160 }, cs: Object.assign({ borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px', objectFit: 'fill' }, o.cs || {}),
      captured: new Set(), focused: 0, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } });
    el.ownerDocument = { defaultView: { getComputedStyle: () => el.cs } };
    el.getBoundingClientRect = () => ({ left: el.rect.left, top: el.rect.top, width: el.rect.width, height: el.rect.height, right: el.rect.left + el.rect.width, bottom: el.rect.top + el.rect.height });
    el.setPointerCapture = (id) => el.captured.add(id); el.releasePointerCapture = (id) => el.captured.delete(id); el.hasPointerCapture = (id) => el.captured.has(id);
    el.focus = () => { el.focused++; };
    return el;
  }
  const pev = (type, o) => Object.assign(new Event(type, { cancelable: true, bubbles: true }), { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: 0, clientY: 0, isPrimary: true }, o || {});
  {
    // ---- mapClientToLogical
    const mk = (rect, cs) => M.mapClientToLogical(fakeEl('CANVAS', { rect, cs }), 240, 160);
    let f = mk({ left: 10, top: 20, width: 240, height: 160 });
    ok(f(10, 20).px === 0 && f(10, 20).py === 0 && f(10.5, 20.5).px === 0 && f(11, 21).px === 1 && f(249.9, 179.9).px === 239 && f(249.9, 179.9).inside && !f(250, 180).inside && !f(9.9, 20).inside, 'map/identity-1x');
    f = mk({ left: 100, top: 50, width: 720, height: 480 });
    { let good = true; const bad = [];
      for (const p of [0, 1, 2, 119, 120, 238, 239]) for (const q of [0, 1, 79, 80, 159]) {
        const a = f(100 + p * 3, 50 + q * 3), b = f(100 + p * 3 + 2.999, 50 + q * 3 + 2.999), c = f(100 + p * 3 + 1.5, 50 + q * 3 + 1.5);
        if (!(a.px === p && a.py === q && b.px === p && b.py === q && c.px === p && c.py === q && a.inside)) { good = false; bad.push(p + ',' + q); }
      }
      ok(good, 'map/whole-pixel-3x-every-edge', bad.join(' ')); }
    ok(f(100 + 3 * 5 - 0.001, 50).px === 4 && f(100 + 3 * 5, 50).px === 5, 'map/pixel-edge-belongs-to-the-right-pixel');
    f = mk({ left: 100, top: 50, width: 724, height: 484 }, { borderLeftWidth: '2px', borderRightWidth: '2px', borderTopWidth: '2px', borderBottomWidth: '2px' });
    ok(f(102, 52).px === 0 && f(102, 52).py === 0 && f(102 + 3, 52).px === 1 && f(101.9, 52).px === -1 && !f(101.9, 52).inside && f(102 + 719, 52 + 479).px === 239 && !f(102 + 720, 52).inside, 'map/border-offset-subtracted');
    f = mk({ left: 0, top: 0, width: 244, height: 164 }, { paddingLeft: '2px', paddingRight: '2px', paddingTop: '2px', paddingBottom: '2px' });
    ok(f(2, 2).px === 0 && f(3, 2).px === 1, 'map/padding-offset-subtracted');
    // fractional scale: 0.7 css px per logical pixel (a dpr of ~1.43): 3 * 0.7 = 2.0999999999999996 in floating point
    f = mk({ left: 0, top: 0, width: 168, height: 112 });
    ok(f(3 * 0.7, 0).px === 3 && f(7 * 0.7, 0).px === 7 && f(9 * 0.7, 0).px === 9 && f(0.7 * 1, 0).px === 1, 'map/pixel-edge-exact', [f(3 * 0.7, 0).x, f(7 * 0.7, 0).x, f(9 * 0.7, 0).x]);
    // letterboxing: a 300x180 box holding the 240x160 image with object-fit: contain -> scale 1.125, 270x180 image, 15 px bars left and right
    f = mk({ left: 40, top: 30, width: 300, height: 180 }, { objectFit: 'contain' });
    ok(f(40 + 15, 30).px === 0 && f(40 + 15 + 1.125, 30).px === 1 && f(40 + 15 + 270 - 0.01, 30 + 179.9).px === 239 && f(40 + 15 + 270 - 0.01, 30 + 179.9).py === 159 && f(40 + 10, 30 + 50).inside === false && f(40 + 291, 30 + 50).inside === false && f(40 + 150, 30 + 90).inside, 'map/letterbox-contain');
    f = mk({ left: 0, top: 0, width: 240, height: 320 }, { objectFit: 'contain' });
    ok(f(0, 80).py === 0 && f(0, 80 + 159).py === 159 && !f(0, 79).inside && !f(0, 240).inside, 'map/letterbox-vertical-bars');
    f = mk({ left: 0, top: 0, width: 480, height: 160 }, { objectFit: 'cover' });
    ok(f(240, 80).px === 120 && f(0, 0).py === 40 && f(0, 0).px === 0, 'map/cover');
    f = mk({ left: 0, top: 0, width: 480, height: 320 }, { objectFit: 'fill' });
    ok(f(479, 319).px === 239 && f(479, 319).py === 159 && f(240, 160).px === 120, 'map/fill-stretches-each-axis');
    f = mk({ left: 0, top: 0, width: 400, height: 300 }, { objectFit: 'none' });
    ok(f(80, 70).px === 0 && f(80, 70).py === 0 && f(80 + 239.5, 70).px === 239, 'map/none-centred');
    f = mk({ left: 0, top: 0, width: 240, height: 160 }); { const r = f(-5, -5); ok(!r.inside && r.px === -5 && r.x === -5, 'map/outside-reports-inside-false'); }
  }
  {
    // ---- registered pointer target
    const mkR = (rect) => { const r = rig(); const el = fakeEl('CANVAS', { rect }); const hit = []; r.input.registerPointerTarget(el, { toLocal: M.mapClientToLogical(el, 240, 160), cursor: { actionable: (x, y) => { hit.push([x, y]); return x < 100; } } }); return { r, el, hit }; };
    let { r, el } = mkR({ left: 0, top: 0, width: 480, height: 320 });
    el.dispatchEvent(pev('pointermove', { clientX: 20, clientY: 40 }));
    ok(r.pointers.length === 1 && r.pointers[0].kind === 'move' && r.pointers[0].x === 10 && r.pointers[0].y === 20 && r.pointers[0].inside && r.pointers[0].source === 'mouse' && r.pointers[0].el === el, 'pointer/hover-is-move-in-logical-coords', r.pointers[0]);
    el.dispatchEvent(pev('pointerdown', { clientX: 20, clientY: 40, buttons: 1 })); el.dispatchEvent(pev('pointerup', { clientX: 20, clientY: 40 }));
    eq(r.pointers.map((p) => p.kind), ['move', 'down', 'up', 'click'], 'pointer/click-is-down-up-click');
    ok(el.captured.has(1), 'pointer/capture-requested'); ok(el.focused >= 1, 'pointer/click-focuses-the-canvas');
    r.pointers.length = 0; el.dispatchEvent(pev('pointerdown', { clientX: 20, clientY: 40, buttons: 1 })); el.dispatchEvent(pev('pointermove', { clientX: 120, clientY: 40, buttons: 1 })); el.dispatchEvent(pev('pointerup', { clientX: 120, clientY: 40 }));
    ok(!r.pointers.some((p) => p.kind === 'click') && r.pointers.some((p) => p.kind === 'up'), 'pointer/drag-is-not-click', r.pointers.map((p) => p.kind));
    r.pointers.length = 0; el.dispatchEvent(pev('pointerdown', { clientX: 20, clientY: 40, buttons: 1 })); el.dispatchEvent(pev('pointermove', { clientX: 26, clientY: 44, buttons: 1 })); el.dispatchEvent(pev('pointerup', { clientX: 26, clientY: 44 }));
    ok(r.pointers.some((p) => p.kind === 'click'), 'pointer/small-wobble-is-still-a-click');
    // layout-triggered duplicate move is not a move
    r.pointers.length = 0; el.dispatchEvent(pev('pointermove', { clientX: 50, clientY: 50 })); el.dispatchEvent(pev('pointermove', { clientX: 50, clientY: 50 }));
    ok(r.pointers.filter((p) => p.kind === 'move').length === 1, 'pointer/identical-move-ignored');
    el.dispatchEvent(pev('pointerleave', { clientX: 600, clientY: 50 })); ok(r.pointers[r.pointers.length - 1].kind === 'leave' && el.style.cursor === '', 'pointer/leave');
    // pointercancel
    r.pointers.length = 0; el.dispatchEvent(pev('pointerdown', { clientX: 20, clientY: 40, buttons: 1 })); el.dispatchEvent(pev('pointercancel', {})); ok(r.pointers.map((p) => p.kind).join() === 'down,cancel', 'pointer/cancel');
    // right click = B, ONLY on a registered target, with the context menu suppressed
    const m = r.mark(); const rd = pev('pointerdown', { button: 2, buttons: 2, clientX: 20, clientY: 40 }); el.dispatchEvent(rd);
    ok(sig(r.since(m)) === '+b' && r.events[r.events.length - 1].source === 'mouse' && r.input.isDown('b'), 'pointer/right-click-is-b', sig(r.since(m)));
    const cm = pev('contextmenu', { button: 2 }); el.dispatchEvent(cm); ok(cm.defaultPrevented, 'pointer/contextmenu-suppressed');
    el.dispatchEvent(pev('pointerup', { button: 2, buttons: 0 })); ok(sig(r.since(m)) === '+b -b' && !r.input.isDown('b'), 'pointer/right-release-releases-b');
    ok(!r.pointers.some((p) => p.button === 2), 'pointer/right-click-is-not-also-a-pointer-down');
    const el2 = fakeEl('DIV'); const r2 = rig(); const cm2 = pev('contextmenu', {}); el2.dispatchEvent(cm2); ok(!cm2.defaultPrevented && r2.events.length === 0, 'pointer/unregistered-element-untouched');
    const r3 = rig(); const el3 = fakeEl(); r3.input.registerPointerTarget(el3, { contextCancel: false }); const cm3 = pev('contextmenu', {}); el3.dispatchEvent(cm3); el3.dispatchEvent(pev('pointerdown', { button: 2, buttons: 2 })); ok(!cm3.defaultPrevented && r3.events.length === 0, 'pointer/contextCancel-false-leaves-right-click-alone');
    // selection and drag never start
    ok((() => { const e = pev('selectstart'); el.dispatchEvent(e); const d = pev('dragstart'); el.dispatchEvent(d); const md = pev('mousedown'); el.dispatchEvent(md); return e.defaultPrevented && d.defaultPrevented && md.defaultPrevented; })(), 'pointer/no-selection-or-drag-on-canvas');
    ok(el.style.userSelect === 'none' && el.style.touchAction === 'none', 'pointer/styles-set');
    // wheel: down is positive; a notch is one step; trackpad deltas accumulate; direction change resets
    const wh = (dy, mode = 0) => { const e = pev('wheel', { deltaY: dy, deltaMode: mode, clientX: 20, clientY: 40 }); el.dispatchEvent(e); return e; };
    r.pointers.length = 0; const we = wh(100); ok(we.defaultPrevented && r.pointers.length === 1 && r.pointers[0].kind === 'wheel' && r.pointers[0].steps === 1, 'pointer/wheel-down-is-positive', r.pointers[0]);
    r.pointers.length = 0; wh(-100); ok(r.pointers[0].steps === -1, 'pointer/wheel-up-is-negative');
    r.pointers.length = 0; wh(30); wh(30); ok(r.pointers.length === 0, 'pointer/wheel-small-deltas-accumulate-quietly'); wh(45); ok(r.pointers.length === 1 && r.pointers[0].steps === 1, 'pointer/wheel-accumulates-to-a-step');
    r.pointers.length = 0; wh(250); ok(r.pointers[0].steps === 2, 'pointer/wheel-fast-spin-multiple-steps');
    r.pointers.length = 0; wh(3, 1); ok(r.pointers[0] && r.pointers[0].steps === 1, 'pointer/wheel-line-mode');
    // cursor policy: hide after 3000 ms idle, show on move, 'pointer' over actionable regions
    {
      const c = mkR({ left: 0, top: 0, width: 480, height: 320 }); c.r.clock.t = 5000;
      c.el.dispatchEvent(pev('pointermove', { clientX: 20, clientY: 40 })); ok(c.el.style.cursor === 'pointer', 'cursor/pointer-over-actionable', c.el.style.cursor);
      c.el.dispatchEvent(pev('pointermove', { clientX: 400, clientY: 40 })); ok(c.el.style.cursor === 'default', 'cursor/default-elsewhere', c.el.style.cursor);
      c.r.at(7999); ok(c.el.style.cursor !== 'none', 'cursor/not-hidden-at-2999ms');
      c.r.at(8000); ok(c.el.style.cursor === 'none', 'cursor/hides-at-3000ms', c.el.style.cursor);
      c.el.dispatchEvent(pev('pointermove', { clientX: 410, clientY: 50 })); ok(c.el.style.cursor !== 'none', 'cursor/shown-on-move');
      c.r.at(11000); ok(c.el.style.cursor === 'none', 'cursor/hides-again');
      c.el.dispatchEvent(pev('pointerleave', {})); c.r.at(20000); ok(c.el.style.cursor === '', 'cursor/leave-restores-and-stays');
    }
    // touch on a registered canvas = a click at that position, no hover
    {
      const t = mkR({ left: 0, top: 0, width: 480, height: 320 });
      t.el.dispatchEvent(pev('pointermove', { pointerType: 'touch', clientX: 20, clientY: 40 })); ok(t.r.pointers.length === 0, 'touch/no-hover-without-contact');
      t.el.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 20, clientY: 40, buttons: 1 })); t.el.dispatchEvent(pev('pointerup', { pointerType: 'touch', pointerId: 7, clientX: 21, clientY: 41 }));
      ok(t.r.pointers.map((p) => p.kind).join() === 'down,up,click' && t.r.pointers.every((p) => p.source === 'touch') && t.r.input.lastSource === 'touch', 'touch/canvas-tap-is-a-click', t.r.pointers.map((p) => p.kind));
    }
  }
  {
    // ---- bindPad: on-screen buttons
    const r = rig(); const a = fakeEl('BUTTON'), up = fakeEl('BUTTON'); r.input.bindPad(a, 'a'); r.input.bindPad(up, 'up');
    a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 1, buttons: 1 })); up.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 2, buttons: 1 }));
    ok(r.input.isDown('a') && r.input.isDown('up') && a.classList.contains('down') && a.captured.has(1), 'pad/multi-touch-two-buttons-at-once');
    up.dispatchEvent(pev('pointerup', { pointerType: 'touch', pointerId: 2 })); ok(r.input.isDown('a') && !r.input.isDown('up') && !up.classList.contains('down'), 'pad/release-one-keeps-the-other');
    a.dispatchEvent(pev('pointercancel', { pointerType: 'touch', pointerId: 1 })); ok(!r.input.isDown('a') && !a.classList.contains('down'), 'pad/pointercancel-releases');
    a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 3, buttons: 1 })); a.captured.clear(); a.dispatchEvent(pev('pointerleave', { pointerType: 'touch', pointerId: 3 })); ok(!r.input.isDown('a'), 'pad/leave-without-capture-releases');
    a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 4, buttons: 1 })); a.dispatchEvent(pev('pointerleave', { pointerType: 'touch', pointerId: 4 })); ok(r.input.isDown('a'), 'pad/leave-while-captured-keeps-holding'); a.dispatchEvent(pev('lostpointercapture', { pointerType: 'touch', pointerId: 4 })); ok(!r.input.isDown('a'), 'pad/lostpointercapture-releases');
    a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 5, buttons: 1 })); r.win.dispatchEvent(ev('blur')); ok(!r.input.isDown('a') && !a.classList.contains('down'), 'pad/blur-releases-and-clears-the-down-class');
    // two fingers on the SAME button: held until the last lifts
    a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 6, buttons: 1 })); a.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 7, buttons: 1 })); a.dispatchEvent(pev('pointerup', { pointerType: 'touch', pointerId: 6 })); ok(r.input.isDown('a'), 'pad/two-fingers-one-button-held'); a.dispatchEvent(pev('pointerup', { pointerType: 'touch', pointerId: 7 })); ok(!r.input.isDown('a'), 'pad/last-finger-releases');
    // no ghost clicks / contextmenu / scroll
    const ck = pev('click', {}); a.dispatchEvent(ck); ok(ck.defaultPrevented, 'pad/click-swallowed'); const cm = pev('contextmenu', {}); a.dispatchEvent(cm); ok(cm.defaultPrevented, 'pad/contextmenu-swallowed');
    const ts = ev('touchstart', {}); a.dispatchEvent(ts); ok(ts.defaultPrevented && a.style.touchAction === 'none', 'pad/touchstart-prevented-and-touch-action-none');
    // a mouse's right button does not press
    a.dispatchEvent(pev('pointerdown', { pointerType: 'mouse', button: 2, pointerId: 9 })); ok(!r.input.isDown('a'), 'pad/mouse-right-button-ignored');
    a.dispatchEvent(pev('pointerdown', { pointerType: 'mouse', button: 0, pointerId: 10 })); ok(r.input.isDown('a') && r.events[r.events.length - 1].source === 'mouse', 'pad/mouse-left-button-presses-with-source-mouse'); a.dispatchEvent(pev('pointerup', { pointerType: 'mouse', pointerId: 10 }));
    ok((() => { try { r.input.bindPad(a, 'bogus'); return false; } catch (_e) { return true; } })(), 'pad/unknown-action-throws');
    // an on-screen direction repeats exactly like a key
    const rr = rig(); const d = fakeEl('BUTTON'); rr.input.bindPad(d, 'down'); d.dispatchEvent(pev('pointerdown', { pointerType: 'touch', pointerId: 1, buttons: 1 })); for (let t = 1000; t <= 1500; t++) rr.at(t);
    ok(rr.events.filter((e) => e.repeat).map((e) => e.time).join() === '1400,1490', 'pad/on-screen-direction-repeats-like-a-key', rr.events.filter((e) => e.repeat).map((e) => e.time));
  }

  /* ------------------------------------------------------------------------------------------------------- capture */
  {
    const run = (setup) => { const r = rig(); const res = []; setup(r, res); return { r, res }; };
    let { r, res } = run((r, res) => { r.input.beginCapture('keyboard', (x) => res.push(x)); r.key('KeyG'); });
    ok(res.length === 1 && res[0].ok && res[0].value === 'KeyG' && res[0].label === 'G' && r.events.length === 0 && !r.input.capturing, 'capture/keyboard-captures-and-makes-no-action', res);
    ({ r, res } = run((r, res) => { r.input.beginCapture('keyboard', (x) => res.push(x)); const e = r.key('Escape'); res.push(e.defaultPrevented); }));
    ok(res[0].ok === false && res[0].reason === 'cancel' && res[1] === true, 'capture/escape-cancels', res);
    ({ r, res } = run((r, res) => { r.input.beginCapture('keyboard', (x) => res.push(x)); const e = r.key('Tab'); res.push(e.defaultPrevented); }));
    ok(res[0].ok === false && res[0].reason === 'cancel' && res[1] === false, 'capture/tab-passes-through', res);
    { const r1 = rig(); const msgs = []; r1.input.on('capture', (e) => msgs.push(e)); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.key('F5'); r1.key('ShiftLeft'); ok(out.length === 0 && r1.input.capturing && msgs.filter((m) => m.state === 'rejected').length === 2 && /cannot/.test(msgs[msgs.length - 1].message), 'capture/reserved-key-rejected-and-keeps-waiting', msgs); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.key('KeyG', { repeat: true }); ok(out.length === 0 && r1.input.capturing, 'capture/os-autorepeat-not-captured'); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x), { timeoutMs: 2000 }); r1.at(2999); ok(r1.input.capturing, 'capture/not-yet-timed-out'); r1.at(3000); ok(out.length === 1 && out[0].reason === 'timeout' && !r1.input.capturing, 'capture/times-out', out); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.at(8999); ok(r1.input.capturing, 'capture/default-timeout-8s-not-yet'); r1.at(9000); ok(!r1.input.capturing && out[0].reason === 'timeout', 'capture/default-timeout-8s'); }
    { const r1 = rig(); const out = []; const cancel = r1.input.beginCapture('keyboard', (x) => out.push(x)); cancel(); ok(out.length === 1 && out[0].reason === 'cancel', 'capture/cancel-function'); r1.input.beginCapture('gamepad', (x) => out.push(x)); r1.input.cancelCapture(); ok(out.length === 2 && !r1.input.capturing, 'capture/cancelCapture'); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.input.beginCapture('keyboard', (x) => out.push(x)); ok(out.length === 1 && out[0].reason === 'cancel' && r1.input.capturing, 'capture/second-capture-cancels-the-first'); }
    { const r1 = rig(); r1.key('ArrowDown'); r1.input.beginCapture('keyboard', () => {}); ok(!r1.input.isDown('down'), 'capture/starting-releases-held-actions'); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.input.press('a'); ok(!r1.input.isDown('a'), 'capture/suppresses-all-actions-from-every-device'); r1.input.setEnabled(false); ok(out.length === 1 && out[0].reason === 'cancel', 'capture/disable-cancels'); }
    { const r1 = rig(); const out = []; r1.input.beginCapture('keyboard', (x) => out.push(x)); r1.input.destroy(); ok(out.length === 1 && out[0].reason === 'cancel', 'capture/destroy-cancels'); }
    // gamepad capture: the press that STARTED it (button held) must not be captured
    { const r1 = rig(); r1.pads.add(0, XBOX); r1.padEvent('gamepadconnected', 0); r1.at(1000); r1.pads.btn(0, 0); r1.at(1016);
      const out = []; r1.input.beginCapture('gamepad', (x) => out.push(x)); r1.at(1032); r1.at(1048);
      ok(out.length === 0 && r1.input.capturing, 'capture/gamepad-held-start-button-skipped');
      r1.pads.btn(0, 0, false); r1.at(1064); r1.pads.btn(0, 7); r1.at(1080);
      ok(out.length === 1 && out[0].ok && out[0].value === 7 && out[0].device === 'gamepad' && out[0].label === 'RT', 'capture/gamepad-captures-next-press', out);
      ok(!r1.input.isDown('r'), 'capture/gamepad-capture-makes-no-action'); r1.pads.btn(0, 7, false); r1.at(1096); ok(!r1.input.isDown('r'), 'capture/gamepad-release-after-capture-quiet'); }
    { const r1 = rig(); r1.pads.add(0, XBOX); r1.padEvent('gamepadconnected', 0); r1.at(1000); r1.pads.btn(0, 0); r1.at(1016); const out = []; r1.input.beginCapture('gamepad', (x) => out.push(x)); r1.pads.btn(0, 0, false); r1.at(1032); r1.pads.btn(0, 0); r1.at(1048);
      ok(out.length === 1 && out[0].value === 0, 'capture/gamepad-can-capture-the-start-button-after-releasing-it', out); }
    { const r1 = rig(); r1.pads.add(0, XBOX); r1.padEvent('gamepadconnected', 0); r1.at(1000); const out = []; r1.input.beginCapture('gamepad', (x) => out.push(x)); r1.key('Escape'); ok(out.length === 1 && out[0].reason === 'cancel', 'capture/escape-cancels-a-gamepad-capture-too'); }
    { const r1 = rig(); r1.pads.add(0, XBOX); r1.padEvent('gamepadconnected', 0); r1.at(1000); const out = []; r1.input.beginCapture('gamepad', (x) => out.push(x), { timeoutMs: 1000 }); r1.at(2000); ok(out[0] && out[0].reason === 'timeout', 'capture/a-pad-only-player-cannot-be-trapped'); }
    ok((() => { try { rig().input.beginCapture('mouse', () => {}); return false; } catch (_e) { return true; } })(), 'capture/bad-device-throws');
  }

  /* --------------------------------------------------------------------------------------------- the self-poll loop */
  {
    const q = []; const raf = (fn) => { q.push(fn); return q.length; }; const caf = () => { q.length = 0; };
    const frame = (r, ms = 16) => { r.clock.t += ms; const fns = q.splice(0); fns.forEach((f) => f(r.clock.t)); };
    let r = rig({ raf, caf });
    ok(q.length === 0, 'selfpoll/idle-schedules-nothing');
    r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); ok(q.length === 1, 'selfpoll/connected-pad-starts-the-loop');
    r.pads.btn(0, 0); frame(r); ok(r.input.isDown('a'), 'selfpoll/pad-input-without-a-caller-polling', sig(r.events));
    r.pads.btn(0, 0, false); frame(r); ok(!r.input.isDown('a'), 'selfpoll/pad-release');
    r.pads.remove(0); r.padEvent('gamepaddisconnected', 0); frame(r); ok(q.length === 0, 'selfpoll/loop-stops-when-nothing-needs-it', q.length);
    q.length = 0; r = rig({ raf, caf }); r.key('ArrowDown'); ok(q.length === 1, 'selfpoll/held-direction-starts-the-loop');
    let reps = 0; for (let i = 0; i < 40; i++) { frame(r); } reps = r.events.filter((e) => e.repeat).length; ok(reps >= 2 && reps <= 4, 'selfpoll/keyboard-repeat-without-a-caller-polling', reps);
    r.up('ArrowDown'); frame(r); ok(q.length === 0, 'selfpoll/loop-stops-after-release');
    q.length = 0; r = rig({ raf, caf }); r.pads.add(0, XBOX); r.padEvent('gamepadconnected', 0); const c0 = r.pads.calls;
    for (let i = 0; i < 5; i++) { r.input.poll(); frame(r); } ok(r.pads.calls - c0 === 5, 'selfpoll/a-polling-caller-is-not-doubled', r.pads.calls - c0);
    q.length = 0; r = rig({ raf, caf }); r.input.destroy(); frame(r); ok(q.length === 0, 'selfpoll/destroy-stops-it');
  }

  /* --------------------------------------------------------------------------------------------------- uinav (pure) */
  {
    const R = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h });
    const cur = R(100, 100, 60, 30);
    const pick = (cands, dir, c = cur) => { const h = N.chooseNext(c, cands.map((x, i) => ({ rect: x, i })), dir); return h ? h.cand.i : -1; };
    ok(pick([R(400, 140, 60, 30), R(100, 300, 60, 30)], 'down') === 1, 'nav/choose-aligned-beats-nearer-misaligned');
    ok(pick([R(100, 400, 60, 30), R(100, 180, 60, 30), R(100, 300, 60, 30)], 'down') === 1, 'nav/choose-nearest-aligned');
    ok(pick([R(100, 300, 60, 30), R(100, 20, 60, 30), R(300, 100, 60, 30), R(-200, 100, 60, 30)], 'down') === 0 && pick([R(100, 300, 60, 30), R(100, 20, 60, 30), R(300, 100, 60, 30), R(-200, 100, 60, 30)], 'up') === 1, 'nav/choose-direction-filter');
    ok(pick([R(100, 300, 60, 30), R(100, 20, 60, 30), R(300, 100, 60, 30), R(-200, 100, 60, 30)], 'right') === 2 && pick([R(100, 300, 60, 30), R(100, 20, 60, 30), R(300, 100, 60, 30), R(-200, 100, 60, 30)], 'left') === 3, 'nav/choose-left-right');
    ok(pick([R(110, 110, 60, 50), R(100, 400, 60, 30)], 'down') === 1, 'nav/choose-strict-beats-loose');
    ok(pick([R(110, 110, 60, 50)], 'down') === 0 && pick([R(110, 90, 60, 20)], 'down') === -1, 'nav/choose-loose-only-when-centre-is-beyond');
    ok(pick([R(100, 200, 60, 30), R(100, 200, 60, 30)], 'down') === 0, 'nav/choose-tie-goes-to-dom-order');
    ok(pick([R(100, 20, 60, 30)], 'down') === -1 && pick([], 'down') === -1, 'nav/choose-nothing-ahead-is-null');
    ok(pick([R(160, 100, 60, 30), R(160, 300, 60, 30)], 'right') === 0, 'nav/choose-same-row-neighbour');
    // a narrow control directly beneath a WIDE one beats a full-width control two rows down (the lab's #num -> #chk -> #btnDlg, measured there: the old centre-to-centre score picked #btnDlg)
    { const wide = R(172, 1318, 455, 44), narrow = R(176, 1385, 22, 22), farWide = R(172, 1430, 455, 44);
      const h = N.chooseNext(wide, [{ rect: narrow, i: 0 }, { rect: farWide, i: 1 }], 'down'); ok(h && h.cand.i === 0, 'nav/choose-narrow-control-under-a-wide-one', h && h.cand.i);
      const hb = N.chooseNext(narrow, [{ rect: wide, i: 0 }, { rect: farWide, i: 1 }], 'down'); ok(hb && hb.cand.i === 1, 'nav/choose-up-from-the-narrow-one-still-finds-the-wide-one-below', hb && hb.cand.i);
      // a candidate whose centre is OUTSIDE the current's span is penalised, an equally near one under it is not
      const cur2 = R(100, 100, 60, 30), under = R(120, 150, 20, 20), aside = R(400, 150, 60, 20); const h2 = N.chooseNext(cur2, [{ rect: aside, i: 0 }, { rect: under, i: 1 }], 'down'); ok(h2 && h2.cand.i === 1, 'nav/choose-under-beats-aside', h2 && h2.cand.i);
      // two aligned candidates the same distance down: the better-centred one wins
      const left = R(100, 150, 20, 20), mid = R(120, 150, 20, 20); const h3 = N.chooseNext(cur2, [{ rect: left, i: 0 }, { rect: mid, i: 1 }], 'down'); ok(h3 && h3.cand.i === 1, 'nav/choose-better-centred-of-two-aligned', h3 && h3.cand.i); }
    ok(pick([R(100, 135, 60, 30), R(260, 135, 60, 30)], 'down') === 0 && pick([R(300, 135, 60, 30), R(110, 400, 60, 30)], 'down') === 1, 'nav/choose-overlap-before-distance');
    // W1 fix A9: a FULL-WIDTH control directly under a narrow one is the next stop, not the narrow one two rows further down (verifier A: A 93x44, B 960x44 at +20, C 90x44 at +86)
    { const A = R(160, 300, 93, 44), B = R(160, 364, 960, 44), C = R(170, 430, 90, 44);
      const d = N.chooseNext(A, [{ rect: B, i: 'B' }, { rect: C, i: 'C' }], 'down'), u = N.chooseNext(C, [{ rect: A, i: 'A' }, { rect: B, i: 'B' }], 'up');
      ok(d && d.cand.i === 'B' && u && u.cand.i === 'B', 'nav/choose-a-full-width-control-directly-below-a-narrow-one-is-next', (d && d.cand.i) + '/' + (u && u.cand.i));
      // ... but a wide control that only grazes the current one's span is still penalised: the better-aligned one further down wins
      ok(pick([R(150, 140, 400, 20), R(100, 200, 60, 30)], 'down') === 1, 'nav/choose-a-wide-control-that-only-grazes-the-span-is-not-aligned'); }
    // a 3x3 grid: every move from the centre and from a corner
    { const g = []; for (let rr = 0; rr < 3; rr++) for (let c = 0; c < 3; c++) g.push(R(c * 100, rr * 60, 80, 40));
      const from = (i, d) => { const others = g.map((x, k) => ({ rect: x, i: k })).filter((x) => x.i !== i); const h = N.chooseNext(g[i], others, d); return h ? h.cand.i : -1; };
      ok(from(4, 'up') === 1 && from(4, 'down') === 7 && from(4, 'left') === 3 && from(4, 'right') === 5 && from(0, 'right') === 1 && from(0, 'down') === 3 && from(8, 'up') === 5 && from(8, 'left') === 7 && from(0, 'up') === -1 && from(2, 'right') === -1, 'nav/choose-3x3-grid'); }
    ok(N.stepNumber(50, { min: 0, max: 100, step: 1, dir: 1, big: false }) === 51 && N.stepNumber(50, { min: 0, max: 100, step: 1, dir: -1, big: false }) === 49, 'nav/step-small');
    ok(N.stepNumber(50, { min: 0, max: 100, step: 1, dir: 1, big: true }) === 60 && N.stepNumber(50, { min: 0, max: 100, step: 1, dir: -1, big: true }) === 40, 'nav/step-big');
    ok(N.stepNumber(99, { min: 0, max: 100, step: 1, dir: 1, big: true }) === 100 && N.stepNumber(100, { min: 0, max: 100, step: 1, dir: 1, big: false }) === 100, 'nav/step-clamp-max');
    ok(N.stepNumber(3, { min: 0, max: 100, step: 1, dir: -1, big: true }) === 0 && N.stepNumber(0, { min: 0, max: 100, step: 1, dir: -1, big: false }) === 0, 'nav/step-clamp-min');
    ok(N.stepNumber(50.4, { min: 0, max: 100, step: 1, dir: 1, big: false }) === 51 && N.stepNumber(7, { min: 0, max: 100, step: 5, dir: 1, big: false }) === 10, 'nav/step-snaps-to-grid');
    ok(N.stepNumber(0.7, { min: 0, max: 1, step: 0.1, dir: 1, big: false }) === 0.8 && N.stepNumber(0.3, { min: 0, max: 1, step: 0.1, dir: 1, big: false }) === 0.4, 'nav/step-no-float-noise');
    ok(N.stepNumber(5, { min: -Infinity, max: Infinity, step: 1, dir: 1, big: true }) === 15 && N.stepNumber(NaN, { min: 0, max: 99, step: 1, dir: 1, big: false }) === 1, 'nav/step-unbounded-and-empty');
    ok(N.stepNumber(0, { min: 0, max: 252, step: 1, dir: 1, big: true }) === 25 && N.stepNumber(0, { min: 0, max: 4, step: 1, dir: 1, big: true }) === 1, 'nav/step-big-is-a-tenth-of-the-range');
    const c = (tag, props) => N.classify(tgt(tag, props));
    ok(c('SELECT') === 'select' && c('BUTTON') === 'button' && c('A') === 'link' && c('SUMMARY') === 'summary' && c('TEXTAREA') === 'text' && c('DIV') === 'other' && c('INPUT', { type: 'range' }) === 'range' && c('INPUT', { type: 'number' }) === 'number' && c('INPUT', { type: 'checkbox' }) === 'checkbox' && c('INPUT', { type: 'radio' }) === 'radio' && c('INPUT', { type: 'submit' }) === 'button' && c('INPUT', { type: 'search' }) === 'text' && c('INPUT', { type: 'date' }) === 'date' && c('DIV', { isContentEditable: true }) === 'text' && N.classify(null) === 'none', 'nav/classify');
  }

  /* ------------------------------------------------------------------------------------------ INPUT.md default table */
  {
    const md = fs.readFileSync(path.join(SRC, 'pokemonarena', 'INPUT.md'), 'utf8');
    const rows = {}; for (const line of md.split('\n')) { const m = /^\| (up|down|left|right|a|b|x|y|l|r|start|select) \| [^|]* \| ([^|]*) \| ([^|]*) \|$/.exec(line); if (m) rows[m[1]] = { keys: m[2].split(',').map((x) => x.trim()), pad: (m[3].match(/\d+/g) || []).map(Number) }; }
    ok(Object.keys(rows).length === 12, 'doc/default-table-has-all-twelve-actions', Object.keys(rows));
    let good = true; const bad = [];
    for (const a of M.ACTIONS) {
      const r = rows[a]; if (!r) { good = false; bad.push(a); continue; }
      const wantKeys = M.DEFAULT_KEYS[a].map((c) => M.codeLabel(c)).join('|'), wantPad = Array.from(new Set([...M.PAD_LAYOUTS.xbox[a], ...M.PAD_LAYOUTS.nintendo[a]])).sort((x, y) => x - y).join(',');
      if (r.keys.join('|') !== wantKeys || r.pad.slice().sort((x, y) => x - y).join(',') !== wantPad) { good = false; bad.push(a + ' doc=' + r.keys.join('/') + ' ' + r.pad.join(',') + ' code=' + wantKeys + ' ' + wantPad); }
    }
    ok(good, 'doc/default-table-matches-the-code', bad.join(' | '));
  }

  return { pass, fail };
}


/* ====================================================================================================== (b) BROWSER */
const GROUPS = process.env.ARENA_GROUPS ? new Set(process.env.ARENA_GROUPS.split(',')) : null;
const groupOn = (g) => !GROUPS || GROUPS.has(g);
const BASE = `http://localhost:${PORT}`;
const LAB = BASE + '/pokemonarena/dev/input_lab.html';
const J = JSON.stringify;

async function portFree(port) {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(false); }); s.once('error', () => res(true)); });
}
async function startServer() {
  if (!(await portFree(PORT))) throw new Error('port ' + PORT + ' is already in use: refusing to test against somebody else\'s server');
  const env = { ...process.env, PORT: String(PORT) };
  if (SRC !== repo) env.WEB_ROOT = SRC; else delete env.WEB_ROOT;
  const child = spawn(process.execPath, [path.join(repo, 'tools', 'devserver.mjs')], { env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(LAB); if (r.ok) return child; } catch (_e) { /* not up yet */ } await sleep(250); }
  child.kill(); throw new Error('dev server did not start on ' + PORT);
}

// A SYNTHETIC gamepad: a script-controlled navigator.getGamepads() plus gamepadconnected / gamepaddisconnected events. Not a controller.
const SYNTH = `(() => {
  const pads = [null, null, null, null];
  const snap = (p) => p && ({ id: p.id, index: p.index, connected: true, mapping: p.mapping, timestamp: performance.now(), buttons: p.buttons.map((b) => ({ pressed: b.pressed, touched: b.pressed, value: b.pressed ? 1 : 0 })), axes: p.axes.slice() });
  navigator.getGamepads = () => pads.map(snap);
  window.__synth = {
    note: 'SYNTHETIC gamepad: navigator.getGamepads() is overridden by the test; no physical controller exists',
    connect(i, id, o) { o = o || {}; const nb = o.nb === undefined ? 17 : o.nb; pads[i] = { id, index: i, mapping: o.mapping === undefined ? 'standard' : o.mapping, buttons: Array.from({ length: nb }, () => ({ pressed: false })), axes: new Array(o.na === undefined ? 4 : o.na).fill(0) };
      const e = new Event('gamepadconnected'); e.gamepad = snap(pads[i]); window.dispatchEvent(e); },
    disconnect(i) { const p = pads[i]; pads[i] = null; if (!p) return; const e = new Event('gamepaddisconnected'); e.gamepad = Object.assign(snap(p), { connected: false }); window.dispatchEvent(e); },
    down(i, b) { pads[i].buttons[b].pressed = true; }, up(i, b) { pads[i].buttons[b].pressed = false; }, axis(i, a, v) { pads[i].axes[a] = v; },
    reset() { for (const p of pads) if (p) { p.buttons.forEach((b) => { b.pressed = false; }); p.axes.fill(0); } },
  };
})();`;

const XBOX_ID = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', PRO_ID = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', GENERIC_ID = 'USB Gamepad (Vendor: 1234 Product: abcd)';

/* ---- real CDP input ---- */
const VK = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, NumpadEnter: 13, Space: 32, Backspace: 8, Escape: 27, PageUp: 33, PageDown: 34, Tab: 9, Home: 36, End: 35, F5: 116 };
const KEYNAME = { ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', NumpadEnter: 'Enter', Space: ' ', Backspace: 'Backspace', Escape: 'Escape', PageUp: 'PageUp', PageDown: 'PageDown', Tab: 'Tab', Home: 'Home', End: 'End', F5: 'F5' };
const TEXTKEY = { Enter: '\r', NumpadEnter: '\r', Space: ' ' };
function keyInfo(code) {
  if (KEYNAME[code]) return { key: KEYNAME[code], vk: VK[code] };
  let m = /^Key([A-Z])$/.exec(code); if (m) return { key: m[1].toLowerCase(), vk: m[1].charCodeAt(0) };
  m = /^Digit([0-9])$/.exec(code); if (m) return { key: m[1], vk: m[1].charCodeAt(0) };
  throw new Error('no key info for ' + code);
}

async function browserSuite() {
  const { withBrowser } = await import(pathToFileURL(path.join(repo, 'tools', 'headless_cdp.mjs')).href);
  const server = await startServer();
  let consoleErrors = [];
  try {
    await withBrowser({ port: CDP, width: 1280, height: 800 }, async (page) => {
      /* ------------------------------------------------------------------------------------------ helpers */
      const E = (expr) => page.eval(expr);
      const kdown = async (code, o = {}) => { const k = keyInfo(code); const text = o.text !== undefined ? o.text : TEXTKEY[code]; await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k.key, code, windowsVirtualKeyCode: k.vk, text, unmodifiedText: text, autoRepeat: !!o.autoRepeat, modifiers: o.modifiers || 0, location: code === 'NumpadEnter' ? 3 : 0 }); };
      const kup = async (code, o = {}) => { const k = keyInfo(code); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code, windowsVirtualKeyCode: k.vk, modifiers: o.modifiers || 0 }); };
      const tap = async (code, o = {}) => { await kdown(code, o); await sleep(o.hold === undefined ? 40 : o.hold); await kup(code, o); await sleep(o.settle === undefined ? 40 : o.settle); };
      const mouse = (type, x, y, o = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: o.button || 'none', buttons: o.buttons || 0, clickCount: o.clickCount || 0, deltaX: o.dx || 0, deltaY: o.dy || 0, pointerType: o.pointerType || 'mouse' });
      const hover = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(45); };
      const click = async (x, y, button = 'left') => { const b = button === 'left' ? 1 : 2; await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button, buttons: b, clickCount: 1 }); await sleep(25); await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: 1 }); await sleep(55); };
      const wheel = async (x, y, dy) => { await mouse('mouseWheel', x, y, { dy }); await sleep(55); };
      const touch = (type, pts) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id === undefined ? 0 : p.id, radiusX: 2, radiusY: 2, force: 1 })) });
      const padDown = (i, b) => E(`__synth.down(${i},${b})`);
      const padUp = (i, b) => E(`__synth.up(${i},${b})`);
      const padTap = async (i, b, hold = 80) => { await padDown(i, b); await sleep(hold); await padUp(i, b); await sleep(60); };
      const padAxis = (i, a, v) => E(`__synth.axis(${i},${a},${v})`);
      const st = () => E('window.__input.state()');
      const mark = () => E('__input.actions.length');
      const since = (m) => E(`__input.actions.slice(${m})`);
      const sigOf = (list) => list.filter((e) => !e.repeat).map((e) => (e.pressed ? '+' : '-') + e.action).join(' ');
      const center = async (sel) => E(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      // the centre of an element WHERE IT IS NOW (center() scrolls it to the middle first, which moves everything else: two simultaneous touch points must be read without scrolling in between)
      const at = async (sel) => E(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
      // an INDEPENDENT hit mapping (does not use the module): the canvas has a 2 px border, the image is (width - 4) / 240 css px per pixel
      const logical = (id, lx, ly) => E(`(() => { const c = document.getElementById(${J(id)}); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); const s = (r.width - 4) / 240; return { x: r.left + 2 + ${lx} * s, y: r.top + 2 + ${ly} * s, s }; })()`);
      const load = async (query = '') => { await page.navigate(LAB + query); await page.waitFor('window.__input && window.__input.ready'); await sleep(120); await E(`(() => { window.__dp = []; window.__cm = []; window.__ck = 0; window.addEventListener('keydown', (e) => window.__dp.push([e.code, e.defaultPrevented, e.ctrlKey ? 'C' : '', e.altKey ? 'A' : '', e.metaKey ? 'M' : '', e.shiftKey ? 'S' : '', e.repeat ? 'R' : '', e.isComposing ? 'I' : '', e.keyCode])); window.addEventListener('contextmenu', (e) => window.__cm.push(e.defaultPrevented)); document.addEventListener('click', () => { window.__ck++; }); })()`); };
      const active = () => E('document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null');
      const GRIDC = [[146, 120], [202, 120], [146, 140], [202, 140]];
      const gridPt = async (i) => logical('menu', GRIDC[i][0], GRIDC[i][1]);

      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SYNTH });
      // A headless target has no window focus until a real input event reaches it: document.hasFocus() is false and `:focus` does not match, so a
      // pad-only visitor's focus ring would be untestable (measured: outline 'none' with data-input-source=gamepad). A real page that receives pad
      // input is always the focused one (Chrome withholds getGamepads() from unfocused pages), so emulate that state; the keyboard / mouse groups
      // are unaffected because their real input events focus the page anyway.
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

      /* ======================================================================================== group: boot */
      await load('?mode=canvas');
      {
        const s = await st();
        ok(s.mode === 'canvas' && s.sourceKnown === false && s.rootSource === null && s.pads.length === 0 && s.held.length === 0, 'browser/lab-boots-in-canvas-mode', s);
        ok(await E("typeof window.__synth === 'object' && /SYNTHETIC/.test(window.__synth.note)"), 'browser/synthetic-gamepad-is-labelled-as-such');
      }

      /* ===================================================================================== group: keyboard */
      if (groupOn('keyboard')) {
        await load('?mode=canvas');
        const WANT = { up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], a: ['KeyZ', 'Enter', 'Space', 'NumpadEnter'], b: ['KeyX', 'Backspace', 'Escape'], x: ['KeyC'], y: ['KeyV'], l: ['KeyQ', 'PageUp'], r: ['KeyE', 'PageDown'], start: ['KeyP'], select: ['KeyI'] };
        const bad = [];
        for (const a of Object.keys(WANT)) for (const code of WANT[a]) {
          const m = await mark(); await tap(code, { hold: 25, settle: 20 });
          const ev = await since(m);
          const down = ev.find((e) => e.pressed && !e.repeat), up = ev.find((e) => !e.pressed);
          if (!(down && down.action === a && down.source === 'keyboard' && down.code === code && up && up.action === a)) bad.push(a + ':' + code + ' -> ' + sigOf(ev));
          // reset the menu so Enter / Space / A do not keep choosing things we do not look at
        }
        ok(bad.length === 0, 'browser-keyboard/every-default-binding-via-real-key-events', bad.join(' | '));
        const dp = await E('window.__dp');
        ok(dp.filter(([c]) => c !== 'Tab').every(([, p]) => p === true) && dp.length === 23, 'browser-keyboard/consumed-keys-are-prevented-on-a-non-text-target', { n: dp.length, unprevented: dp.filter(([, p]) => !p), codes: dp.map(([c]) => c).join(',') });
        const m0 = await mark(); await tap('KeyG'); await tap('Digit1'); ok((await since(m0)).length === 0, 'browser-keyboard/unbound-keys-do-nothing');
        // OS auto-repeat (a real autoRepeat:true key event) does not drive anything; our own repeat starts at ~400 ms and runs at ~90 ms
        await E('__input.actions.length = 0');
        await kdown('ArrowDown'); const t0 = await E('performance.now()');
        for (let i = 0; i < 10; i++) { await kdown('ArrowDown', { autoRepeat: true }); await sleep(12); }
        const early = await E('__input.actions.filter((e) => e.repeat).length');
        ok(early === 0, 'browser-keyboard/os-autorepeat-does-not-drive-repeat', early);
        await sleep(1150); const tUp = await E('performance.now()'); await kup('ArrowDown'); await sleep(60);
        const ev = await E('__input.actions.slice()');
        const downAt = ev.find((e) => e.pressed && !e.repeat).t, reps = ev.filter((e) => e.repeat).map((e) => e.t);
        const expectN = Math.floor((tUp - downAt - 400) / 90) + 1;
        ok(Math.abs(reps.length - expectN) <= 1, 'browser-keyboard/repeat-count-matches-the-hold-time', { n: reps.length, expectN, holdMs: Math.round(tUp - downAt) });
        ok(reps[0] - downAt >= 385 && reps[0] - downAt <= 480, 'browser-keyboard/repeat-starts-near-400ms', reps[0] - downAt);
        const gaps = reps.slice(1).map((t, i) => t - reps[i]); const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
        ok(avg >= 80 && avg <= 105, 'browser-keyboard/repeat-interval-near-90ms', { avg, gaps });
        ok(ev.filter((e) => !e.pressed).length === 1 && !(await st()).held.length, 'browser-keyboard/hold-released-on-keyup');
        // A and B: held, never repeated
        await E('__input.actions.length = 0'); await kdown('KeyZ'); await sleep(800); const held = (await st()).held; await kup('KeyZ');
        ok(held.includes('a') && (await E('__input.actions.filter((e) => e.repeat).length')) === 0, 'browser-keyboard/a-is-held-and-never-repeats', held);
        // the text-target guard: typing in a text field is not swallowed and makes no action
        await E("document.getElementById('txt').focus()"); await E('__input.actions.length = 0'); await E('window.__dp.length = 0');
        await tap('KeyZ', { text: 'z' }); await tap('KeyX', { text: 'x' });
        ok((await E("document.getElementById('txt').value")) === 'zx' && (await E('__input.actions.length')) === 0, 'browser-keyboard/typing-in-a-text-field-is-not-swallowed', await E("document.getElementById('txt').value"));
        await tap('ArrowLeft'); await tap('Backspace');
        ok((await E("document.getElementById('txt').value")) === 'x' && (await E('__input.actions.length')) === 0 && (await E('window.__dp')).every(([, p]) => p === false), 'browser-keyboard/caret-keys-stay-native-in-a-text-field', { v: await E("document.getElementById('txt').value"), dp: await E('window.__dp') });
        await E("document.getElementById('sel').focus()"); await tap('ArrowDown'); await tap('KeyZ');
        ok((await E('__input.actions.length')) === 0, 'browser-keyboard/select-keeps-its-keys');
        await E('document.activeElement.blur()');
        // modifiers: ctrl / alt / meta held -> not ours (and not prevented); shift still acts. The canvas has focus, so none of this is the text-field guard.
        await E("document.getElementById('menu').focus()"); await E('window.__dp.length = 0');
        for (const [mods, nm] of [[8, 'shift'], [2, 'ctrl'], [1, 'alt'], [4, 'meta']]) {
          await E("document.getElementById('menu').focus()"); const m = await mark(); const before = await E("document.getElementById('txt').value");
          await tap('KeyZ', { modifiers: mods }); await kup('KeyZ');   // (the bare keyUp clears Chrome's own key-down memory: after Meta+Z it believes Z is still down and flags the next press as auto-repeat)
          const ev = await since(m);
          if (nm === 'shift') ok(sigOf(ev) === '+a -a', 'browser-keyboard/shift-held-still-acts', { sig: sigOf(ev), active: await active() });
          else ok(ev.length === 0, 'browser-keyboard/' + nm + '-held-is-ignored', sigOf(ev));
          if (nm === 'ctrl') { const after = await E("document.getElementById('txt').value"); ok(after !== before, 'browser-keyboard/ctrl-z-still-reaches-the-browser-and-undoes-the-typing', { before, after }); }
        }
        { const dp = await E('window.__dp'); ok(dp.filter(([, , c, a, m]) => c || a || m).every(([, p]) => p === false) && dp.filter(([, , c, a, m, sh]) => sh && !c && !a && !m).every(([, p]) => p === true), 'browser-keyboard/modifier-chords-are-not-prevented-but-shift-z-is-consumed', dp); }
        await E('document.activeElement && document.activeElement.blur()');
        { await E('window.__dp.length = 0'); await tap('Tab'); await tap('Tab', { modifiers: 8 }); ok((await E('window.__dp')).every(([, p]) => p === false), 'browser-keyboard/tab-and-shift-tab-are-never-prevented'); }
        // the canvas menu, keyboard alone
        await load('?mode=canvas'); await E('document.activeElement && document.activeElement.blur()');
        await tap('ArrowRight'); let s = await st(); ok(s.menu.cursor === 1 && s.lastSource === 'keyboard', 'browser-keyboard/menu-arrow-right');
        await tap('KeyS'); s = await st(); ok(s.menu.cursor === 3, 'browser-keyboard/menu-wasd-s');
        await tap('KeyA'); await tap('ArrowUp'); s = await st(); ok(s.menu.cursor === 0, 'browser-keyboard/menu-left-up');
        await tap('ArrowDown'); await tap('KeyZ'); s = await st(); ok(s.menu.screen === 'list' && s.menu.cursor === 0, 'browser-keyboard/menu-z-opens-the-list', s.menu);
        await tap('ArrowDown'); await tap('ArrowDown'); await tap('Enter'); s = await st(); ok(s.menu.chosen.join() === 'MON 3', 'browser-keyboard/menu-enter-chooses', s.menu);
        await tap('KeyX'); s = await st(); ok(s.menu.screen === 'grid' && s.menu.cursor === 2, 'browser-keyboard/menu-x-goes-back', s.menu);
        for (let i = 0; i < 6; i++) await tap('ArrowDown', { hold: 15, settle: 10 }); await tap('KeyZ'); await tap('Backspace'); await tap('KeyZ');
      }

      /* ======================================================================================== group: mouse */
      if (groupOn('mouse')) {
        await page.setViewport(1280, 800); await load('?mode=canvas');
        for (const i of [3, 0, 2, 1]) { const p = await gridPt(i); await hover(p.x, p.y); const s = await st(); ok(s.menu.cursor === i && s.lastSource === 'mouse', 'browser-mouse/hover-moves-the-cursor-to-item-' + i, s.menu); }
        { const p = await gridPt(2); await hover(p.x, p.y); const b = await E("(() => { const r = document.getElementById('menu').getBoundingClientRect(); return { x: r.left + 1, y: r.top + 1, ox: r.right + 5, oy: r.top + 20 }; })()"); await hover(b.x, b.y); await hover(b.ox, b.oy); ok((await st()).menu.cursor === 2, 'browser-mouse/border-and-outside-do-not-move-the-cursor'); }
        { const p = await gridPt(2); await click(p.x, p.y); const s = await st(); ok(s.menu.screen === 'list' && s.lastSource === 'mouse', 'browser-mouse/click-activates-the-item-under-it', s.menu); }
        { const p = await logical('menu', 120, 80); await wheel(p.x, p.y, 100); let s = await st(); const down = s.menu.cursor; await wheel(p.x, p.y, -100); s = await st(); ok(down === 1 && s.menu.cursor === 0, 'browser-mouse/wheel-down-moves-down-and-up-moves-up', { down, up: s.menu.cursor }); ok((await E('window.scrollY')) === 0, 'browser-mouse/wheel-over-the-canvas-does-not-scroll-the-page'); }
        { const r3 = await logical('menu', 120, 24 + 22 * 3 + 9); await hover(r3.x, r3.y); let s = await st(); ok(s.menu.cursor === 3, 'browser-mouse/hover-a-list-row', s.menu); await click(r3.x, r3.y); s = await st(); ok(s.menu.chosen.join() === 'MON 4', 'browser-mouse/click-a-list-row', s.menu); }
        // right-click = B on the canvas, with the context menu suppressed there and ONLY there
        { await E('window.__cm.length = 0'); const p = await logical('menu', 120, 80); const m = await mark(); await click(p.x, p.y, 'right'); const ev = await since(m);
          ok(sigOf(ev) === '+b -b' && ev[0].source === 'mouse', 'browser-mouse/right-click-is-b', sigOf(ev)); ok((await E('window.__cm')).length >= 1 && (await E('window.__cm')).every((x) => x === true), 'browser-mouse/context-menu-suppressed-on-the-canvas', await E('window.__cm')); ok((await st()).menu.screen === 'grid', 'browser-mouse/right-click-went-back');
          await E('window.__cm.length = 0'); const h = await center('h1'); const m2 = await mark(); await click(h.x, h.y, 'right'); ok((await E('window.__cm')).every((x) => x === false) && (await since(m2)).length === 0, 'browser-mouse/right-click-elsewhere-is-left-alone', await E('window.__cm')); await mouse('mouseMoved', 5, 5); await sleep(80); }
        // click-drag from a canvas never starts a text selection. A fixed-position fixture (everything in view, every coordinate read ONCE after layout): page text, a
        // PLAIN canvas with no layer on it, and a REGISTERED canvas. Measured controls: a drag from the plain canvas up over the text DOES select it (so the geometry can
        // select, and the registered canvas staying empty means something is stopping it), and so does a plain drag over the text itself.
        { await E(`(() => { const host = document.createElement('div'); host.id = 'dragfx'; host.style.cssText = 'position:fixed;left:20px;top:20px;width:420px;background:#223;z-index:70;padding:8px'; host.innerHTML = '<p id="dragtxt" style="margin:0 0 8px;color:#fff">Some page text that a drag could select.</p><canvas id="dragplain" width="240" height="160" style="display:block;width:240px;height:100px"></canvas><canvas id="dragreg" width="240" height="160" style="display:block;width:240px;height:100px;margin-top:8px"></canvas>'; document.body.appendChild(host); window.__dragOff = __input.input.registerPointerTarget(document.getElementById('dragreg'), {}); })()`);
          const pts = await E(`(() => { const g = (id) => document.getElementById(id).getBoundingClientRect(); const t = g('dragtxt'), a = g('dragplain'), b = g('dragreg'); const hit = (x, y) => (document.elementFromPoint(x, y) || {}).id;
            const r = { tl: t.left + 2, tr: t.left + 190, ty: t.top + t.height / 2, ax: a.left + 40, ay: a.top + 50, bx: b.left + 40, by: b.top + 50 }; r.onText = hit(r.tl, r.ty); r.onPlain = hit(r.ax, r.ay); r.onReg = hit(r.bx, r.by); return r; })()`);
          ok(pts.onText === 'dragtxt' && pts.onPlain === 'dragplain' && pts.onReg === 'dragreg', 'browser-mouse/drag-test-points-are-where-they-should-be', pts);
          const drag = async (x0, y0, x1, y1) => { await E('getSelection().removeAllRanges()'); await mouse('mouseMoved', x0, y0); await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 }); await mouse('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2, { button: 'left', buttons: 1 }); await mouse('mouseMoved', x1, y1, { button: 'left', buttons: 1 }); await mouse('mouseReleased', x1, y1, { button: 'left', clickCount: 1 }); await sleep(60); return E('getSelection().toString()'); };
          const fromReg = await drag(pts.bx, pts.by, pts.tl + 20, pts.ty);
          ok(fromReg === '', 'browser-mouse/no-text-selection-from-a-canvas-drag', fromReg);
          const fromPlain = await drag(pts.ax, pts.ay, pts.tl + 20, pts.ty);
          // MEASURED (probes p11-p13, Chrome 156 headless): an UNPROTECTED canvas never starts a selection from a drag, a double click or a triple click either, in any of six layouts tried.
          // So in Chrome the registered canvas staying empty proves nothing about the layer's selectstart / mousedown / user-select guards: they are defence in depth for engines that DO select
          // from a canvas (Safari, Firefox: UNVERIFIED here) and there is deliberately no mutant for them. This check records the measurement and will flip if Chrome changes.
          ok(fromPlain === '', 'browser-mouse/measurement-chrome-does-not-select-from-an-unprotected-canvas-either', fromPlain);
          const fromText = await drag(pts.tl, pts.ty, pts.tr, pts.ty);
          ok(fromText.length > 0, 'browser-mouse/control-a-drag-over-page-text-does-select', fromText);
          await E("getSelection().removeAllRanges(); window.__dragOff(); document.getElementById('dragfx').remove()"); }
        // the cursor hides after 3 s idle over the canvas and returns on movement
        { const p = await gridPt(1); await hover(p.x, p.y); const c1 = await E("getComputedStyle(document.getElementById('menu')).cursor"); await sleep(2500); const c2 = await E("getComputedStyle(document.getElementById('menu')).cursor"); await sleep(1100); const c3 = await E("getComputedStyle(document.getElementById('menu')).cursor");
          await hover(p.x + 3, p.y + 2); const c4 = await E("getComputedStyle(document.getElementById('menu')).cursor");
          ok(c1 === 'pointer' && c2 === 'pointer' && c3 === 'none' && c4 === 'pointer', 'browser-mouse/cursor-hides-after-3s-and-returns-on-move', [c1, c2, c3, c4]);
          const q = await logical('menu', 20, 20); await hover(q.x, q.y); ok((await E("getComputedStyle(document.getElementById('menu')).cursor")) === 'default', 'browser-mouse/cursor-is-default-over-non-actionable-pixels'); }
        // pointer mapping: exact at several device pixel ratios and viewport widths (whole-pixel scale chosen by the lab like the real page)
        for (const [w, h, dpr] of [[1280, 800, 1], [1000, 700, 1.5], [900, 700, 2], [800, 700, 1.25], [700, 700, 1.75], [600, 700, 3]]) {
          await page.setViewport(w, h, { dpr }); await sleep(250);
          const res = await E(`(() => { const c = document.getElementById('menu'); c.scrollIntoView({ block: 'center' }); const f = __input.input.mapClientToLogical(c, 240, 160); const r = c.getBoundingClientRect(); const s = (r.width - 4) / 240; const bad = [];
            for (const px of [0, 1, 7, 119, 120, 238, 239]) for (const py of [0, 1, 79, 80, 158, 159]) { const cx = r.left + 2 + (px + 0.5) * s, cy = r.top + 2 + (py + 0.5) * s; const m = f(cx, cy); if (m.px !== px || m.py !== py || !m.inside) bad.push(px + ',' + py + '=>' + m.px + ',' + m.py); }
            const edge = f(r.left + 2 + 5 * s, r.top + 2).px, before = f(r.left + 2 + 5 * s - 0.01, r.top + 2).px, outside = f(r.left + 2 + 240 * s + 0.5, r.top + 20).inside;
            return { bad, edge, before, outside, scale: s, dpr: window.devicePixelRatio }; })()`);
          ok(res.bad.length === 0 && res.edge === 5 && res.before === 4 && res.outside === false, 'browser-mouse/mapping-exact-at-dpr-' + dpr + '-width-' + w, res);
          const rr = await logical('menu', GRIDC[2][0], GRIDC[2][1]); await hover(rr.x, rr.y); ok((await st()).menu.cursor === 2 || (await st()).menu.screen === 'list', 'browser-mouse/real-hover-lands-on-the-right-item-at-dpr-' + dpr);
        }
        await page.setViewport(1280, 800); await load('?mode=canvas');
        // the letterboxed canvas (300x180 box, object-fit: contain): real clicks, independent expectation
        { const g = await E("(() => { const c = document.getElementById('lbCanvasDummy') || document.getElementById('lb'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); const s = Math.min(r.width / 240, r.height / 160); return { l: r.left, t: r.top, w: r.width, h: r.height, s, ox: (r.width - 240 * s) / 2, oy: (r.height - 160 * s) / 2 }; })()");
          await click(g.l + g.ox + 10.5 * g.s, g.t + g.oy + 20.5 * g.s); let lb = await E('__input.lb.last');
          ok(lb && lb.px === 10 && lb.py === 20 && lb.inside === true, 'browser-mouse/letterboxed-click-maps-through-the-bars', lb);
          await click(g.l + g.ox + 239.5 * g.s, g.t + g.oy + 159.5 * g.s); lb = await E('__input.lb.last'); ok(lb && lb.px === 239 && lb.py === 159 && lb.inside, 'browser-mouse/letterboxed-far-corner', lb);
          await click(g.l + 3, g.t + g.h / 2); lb = await E('__input.lb.last'); ok(lb && lb.inside === false && lb.x < 0, 'browser-mouse/letterbox-bar-is-outside', lb); }
        // a pen is a pointing device: same family as the mouse
        { const p = await gridPt(0); await mouse('mouseMoved', p.x, p.y, { pointerType: 'pen' }); await sleep(60); ok((await st()).lastSource === 'mouse', 'browser-mouse/pen-counts-as-mouse'); }
        // the DOM surfaces by mouse alone: tabs, the dialog, the Controls panel (the layer must leave native clicking completely alone)
        { await E("document.getElementById('modeDom').click()"); await sleep(80);
          const clickEl = async (sel) => { const c = await center(sel); await click(c.x, c.y); await sleep(80); };
          await clickEl('#tab3'); ok((await E("document.getElementById('tab3').getAttribute('aria-selected')")) === 'true', 'browser-mouse/click-selects-a-tab');
          await clickEl('#btnDlg'); ok((await E('document.getElementById("dlg").hidden')) === false, 'browser-mouse/click-opens-the-dialog');
          await clickEl('#dlgClose'); ok((await E('document.getElementById("dlg").hidden')) === true, 'browser-mouse/click-closes-the-dialog');
          await clickEl('[data-fk="kb-a-0"]'); ok((await E('__input.input.capturing')) === true, 'browser-mouse/click-a-chip-starts-capture');
          await clickEl('[data-ip=cancel]'); ok((await E('__input.input.capturing')) === false && /Cancelled/.test(await E("document.querySelector('[data-ip=status]').textContent")), 'browser-mouse/click-cancel-stops-capture', await E("document.querySelector('[data-ip=status]').textContent")); }
      }

      /* ========================================================================================= group: pad */
      if (groupOn('pad')) {
        await load('?mode=canvas'); await E('document.activeElement && document.activeElement.blur()');
        await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(150);
        let s = await st(); ok(s.pads.length === 1 && s.pads[0].family === 'xbox' && s.pads[0].standard === true, 'browser-pad/connect-event-lists-the-pad', s.pads);
        ok(await E("__input.log.some((l) => /device connected/.test(l))"), 'browser-pad/device-event-logged');
        // each default through the synthetic pad (Xbox layout)
        { const WANT_X = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1, x: 2, y: 3, l: 4, r: 5, select: 8, start: 9 }; const bad = [];
          for (const [a, b] of Object.entries(WANT_X)) { const m = await mark(); await padTap(0, b); const ev = await since(m); if (sigOf(ev) !== '+' + a + ' -' + a || ev[0].source !== 'gamepad') bad.push(a + ':' + b + ' ' + sigOf(ev)); await E('__input.menu.screen = "grid"; __input.menu.cursor = 0'); }
          ok(bad.length === 0, 'browser-pad/every-xbox-default-via-the-synthetic-pad', bad.join(' | '));
          const m = await mark(); await padTap(0, 6); await padTap(0, 7); eq(sigOf(await since(m)), '+l -l +r -r', 'browser-pad/triggers-are-alternate-l-and-r'); }
        // stick thresholds, through real rAF polling
        { let m = await mark(); await padAxis(0, 0, 0.49); await sleep(120); ok((await since(m)).length === 0, 'browser-pad/stick-0.49-is-quiet');
          await padAxis(0, 0, 0.5); await sleep(120); ok(sigOf(await since(m)) === '+right', 'browser-pad/stick-0.5-engages');
          await padAxis(0, 0, 0.4); await sleep(120); await padAxis(0, 0, 0.36); await sleep(120); ok(sigOf(await since(m)) === '+right', 'browser-pad/stick-hysteresis-holds-0.4-and-0.36');
          await padAxis(0, 0, 0.34); await sleep(120); ok(sigOf(await since(m)) === '+right -right', 'browser-pad/stick-0.34-releases');
          m = await mark(); await padAxis(0, 0, 0.8); await padAxis(0, 1, 0.7); await sleep(150); ok(sigOf(await since(m)) === '+right', 'browser-pad/diagonal-is-one-action', sigOf(await since(m)));
          await padAxis(0, 0, 0); await padAxis(0, 1, 0); await sleep(120); ok((await st()).held.length === 0, 'browser-pad/centre-releases'); }
        // stick repeats like a key (first ~400 ms, then ~90 ms)
        { await E('__input.actions.length = 0'); await padAxis(0, 1, 0.9); await sleep(1250); await padAxis(0, 1, 0); await sleep(100); const ev = await E('__input.actions.slice()'); const d0 = ev.find((e) => e.pressed && !e.repeat).t, reps = ev.filter((e) => e.repeat).map((e) => e.t);
          ok(reps.length >= 5 && reps.length <= 10 && reps[0] - d0 >= 385 && reps[0] - d0 <= 480, 'browser-pad/stick-repeats-like-a-key', { n: reps.length, first: reps[0] - d0 }); }
        // right stick scrolls lists (a wheel pointer event with no position)
        { await E('__input.log.length = 0'); await padAxis(0, 3, 0.9); await sleep(350); await padAxis(0, 3, 0); await sleep(80); ok((await E("__input.log.filter((l) => /ptr wheel - steps 1 \\[gamepad\\]/.test(l)).length")) >= 2, 'browser-pad/right-stick-y-scrolls', await E('__input.log.slice(-4)')); }
        // the canvas menu, pad alone
        { await E('__input.menu.screen = "grid"; __input.menu.cursor = 0'); await E('__input.menu.chosen.length = 0'); await padTap(0, 15); await padTap(0, 13); await padTap(0, 14); s = await st(); ok(s.menu.cursor === 2 && s.lastSource === 'gamepad', 'browser-pad/menu-dpad-walk', s.menu);
          await padTap(0, 0); s = await st(); ok(s.menu.screen === 'list', 'browser-pad/menu-a-opens-the-list'); await padTap(0, 13); await padTap(0, 13); await padTap(0, 0); s = await st(); ok(s.menu.chosen.join() === 'MON 3', 'browser-pad/menu-a-chooses', s.menu); await padTap(0, 1); s = await st(); ok(s.menu.screen === 'grid', 'browser-pad/menu-b-goes-back'); }
        // a Nintendo-id pad: confirm is the EAST button (index 1)
        { await E(`__synth.connect(1, ${J(PRO_ID)})`); await sleep(120); const m = await mark(); await padTap(1, 1); await padTap(1, 0); eq(sigOf(await since(m)), '+a -a +b -b', 'browser-pad/nintendo-id-swaps-confirm-and-cancel'); const m2 = await mark(); await padTap(0, 1); eq(sigOf(await since(m2)), '+b -b', 'browser-pad/xbox-pad-unaffected-by-the-second-pad'); s = await st(); ok(s.pads.length === 2, 'browser-pad/two-pads-listed'); await E('__synth.disconnect(1)'); await sleep(120); ok((await st()).pads.length === 1, 'browser-pad/second-pad-disconnect-listed'); }
        // any pad drives menus; disconnect while holding releases (no stuck input)
        { await E('__input.actions.length = 0'); await padDown(0, 13); await padDown(0, 0); await sleep(120); ok((await st()).held.includes('down') && (await st()).held.includes('a'), 'browser-pad/precondition-two-held');
          await E('__synth.disconnect(0)'); await sleep(120); s = await st(); ok(s.held.length === 0 && s.pads.length === 0, 'browser-pad/disconnect-releases-everything-held', s.held); await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(120); ok((await st()).held.length === 0, 'browser-pad/reconnect-does-not-resurrect-a-hold'); await E('__synth.reset()'); await sleep(80); }
        // blur / visibilitychange (dispatched by script, NOT a real window switch)
        { await padDown(0, 13); await sleep(100); ok((await st()).held.includes('down'), 'browser-pad/pre-blur-held'); await E("window.dispatchEvent(new Event('blur'))"); await sleep(60); ok((await st()).held.length === 0, 'browser-pad/blur-releases-synthetic-event'); await padUp(0, 13); await sleep(80);
          await kdown('KeyZ'); await sleep(60); await E("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))"); await sleep(60); ok((await st()).held.length === 0, 'browser-pad/visibilitychange-releases-synthetic-event'); await E("delete document.hidden"); await kup('KeyZ'); await sleep(60); }
        // a controller with a non-standard mapping: flagged, best-effort, no crash; the panel says what to do
        { await E(`__synth.connect(2, ${J(GENERIC_ID)}, { mapping: '', nb: 12, na: 2 })`); await sleep(150); s = await st(); const p2 = s.pads.find((p) => p.index === 2); ok(p2 && p2.standard === false, 'browser-pad/non-standard-mapping-flagged', s.pads);
          ok((await E("document.querySelector('[data-unsupported=\"1\"]') && document.querySelector('[data-unsupported=\"1\"]').textContent")).includes('unsupported layout'), 'browser-pad/panel-explains-an-unsupported-layout');
          const m = await mark(); await padTap(2, 0); ok(sigOf(await since(m)) === '+a -a', 'browser-pad/non-standard-best-effort-buttons'); await E('__synth.disconnect(2)'); await sleep(100); }
        await E('__synth.disconnect(0)'); await sleep(150);
        ok((await E("document.body.textContent")).includes('press any button on it'), 'browser-pad/ui-says-chrome-hides-pads-until-a-button-is-pressed');
      }

      /* ==================================================================================== group: switch */
      if (groupOn('switch')) {
        await load('?mode=canvas'); await E('document.activeElement && document.activeElement.blur()'); await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(120);
        const glyphs = async () => E("({ a: __input.input.glyph('a'), b: __input.input.glyph('b'), src: __input.input.lastSource })");
        let g; await tap('ArrowRight'); let s = await st(); g = await glyphs(); ok(s.menu.cursor === 1 && g.src === 'keyboard' && g.a === 'Z', 'browser-switch/1-keyboard', { s: s.menu, g });
        { const p = await gridPt(3); await hover(p.x, p.y); } s = await st(); g = await glyphs(); ok(s.menu.cursor === 3 && g.src === 'mouse' && g.a === 'Click' && g.b === 'Right-click', 'browser-switch/2-mouse-takes-over', { s: s.menu, g });
        await padTap(0, 14); s = await st(); g = await glyphs(); ok(s.menu.cursor === 2 && g.src === 'gamepad' && g.a === 'A button', 'browser-switch/3-pad-takes-over-from-the-mouse-position', { s: s.menu, g });
        await padTap(0, 12); await padTap(0, 14); s = await st(); ok(s.menu.cursor === 0, 'browser-switch/3b-pad-continues');
        { const p = await gridPt(1); await hover(p.x, p.y); await tap('ArrowDown'); s = await st(); g = await glyphs(); ok(s.menu.cursor === 3 && g.src === 'keyboard' && g.a === 'Z', 'browser-switch/4-keyboard-continues-from-the-hovered-item', { s: s.menu, g }); }
        { const p = await gridPt(0); const m = await mark(); await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y, { button: 'left', buttons: 1, clickCount: 1 }); await mouse('mouseReleased', p.x, p.y, { button: 'left', clickCount: 1 }); await sleep(60); s = await st(); ok(s.menu.chosen.includes('FIGHT') && s.lastSource === 'mouse', 'browser-switch/5-click-after-keyboard-and-pad'); }
        await tap('KeyZ'); s = await st(); ok(s.menu.chosen.filter((c) => c === 'FIGHT').length === 2, 'browser-switch/6-keyboard-confirm-on-the-clicked-item');
        await padDown(0, 13); await tap('ArrowRight'); await sleep(60); s = await st(); ok(s.held.includes('down'), 'browser-switch/7-a-pad-hold-survives-keyboard-input'); await padUp(0, 13); await sleep(60); ok(!(await st()).held.includes('down'), 'browser-switch/8-and-releases-on-its-own');
        // a held key and a held pad button on the SAME action: released only when both let go
        { await kdown('ArrowUp'); await padDown(0, 12); await sleep(100); await kup('ArrowUp'); await sleep(60); ok((await st()).held.includes('up'), 'browser-switch/9-two-devices-one-action-still-held'); await padUp(0, 12); await sleep(80); ok(!(await st()).held.includes('up'), 'browser-switch/10-released-when-the-last-device-lets-go'); }
        await E('__synth.disconnect(0)');
      }

      /* ======================================================================================== group: touch */
      if (groupOn('touch')) {
        await page.setViewport(390, 844, { mobile: true, dpr: 2 }); await load('?mode=canvas');
          ok(await E("getComputedStyle(document.querySelector('#padsBox [data-act=\"a\"]')).touchAction === 'none' && getComputedStyle(document.getElementById('menu')).touchAction === 'none'"), 'browser-touch/touch-action-none-on-pads-and-canvas');
        // multi-touch: d-pad Up and A at the same time
        {
          // both buttons must be on screen at once for a two-finger test: scroll so both are visible
          await E("document.getElementById('padsBox').scrollIntoView({ block: 'center' })"); const U = await at('#padsBox [data-act="up"]'), A = await at('#padsBox [data-act="a"]');
          await touch('touchStart', [{ x: U.x, y: U.y, id: 0 }]); await touch('touchStart', [{ x: U.x, y: U.y, id: 0 }, { x: A.x, y: A.y, id: 1 }]); await sleep(120);
          let s = await st(); ok(s.held.includes('up') && s.held.includes('a') && s.lastSource === 'touch', 'browser-touch/two-fingers-two-actions-at-once', s.held);
          ok(await E("document.querySelector('#padsBox [data-act=\"up\"]').classList.contains('down') && document.querySelector('#padsBox [data-act=\"a\"]').classList.contains('down')"), 'browser-touch/pressed-buttons-show-the-down-state');
          await touch('touchEnd', [{ x: A.x, y: A.y, id: 1 }]); await sleep(100); s = await st(); ok(s.held.includes('up') && !s.held.includes('a'), 'browser-touch/lifting-one-finger-keeps-the-other', s.held);   // CDP touchEnd lists the points that END: finger 1 (A) lifts, finger 0 (Up) stays down
          await touch('touchEnd', []); await sleep(100); ok((await st()).held.length === 0, 'browser-touch/all-lifted-nothing-stuck');
          // pointercancel (the OS takes the touch away)
          await touch('touchStart', [{ x: A.x, y: A.y, id: 0 }]); await sleep(80); ok((await st()).held.includes('a'), 'browser-touch/pre-cancel-held'); await touch('touchCancel', []); await sleep(100); ok((await st()).held.length === 0, 'browser-touch/touchcancel-releases');
          // holding a direction repeats like any other source
          await E('__input.actions.length = 0'); await touch('touchStart', [{ x: U.x, y: U.y, id: 0 }]); await sleep(700); await touch('touchEnd', []); await sleep(80);
          ok((await E('__input.actions.filter((e) => e.repeat && e.action === "up").length')) >= 2, 'browser-touch/held-direction-repeats'); }
        // no scroll and no zoom while a finger is on a pad (drag it a long way), and no ghost click afterwards
        { await E("document.getElementById('padsBox').scrollIntoView({ block: 'center' })"); const A = await center('#padsBox [data-act="a"]'); const sy = await E('window.scrollY');
          await E('window.__ck = 0'); await touch('touchStart', [{ x: A.x, y: A.y, id: 0 }]); for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: A.x, y: A.y - i * 25, id: 0 }]); await sleep(20); } await touch('touchEnd', []); await sleep(450);
          ok((await E('window.scrollY')) === sy, 'browser-touch/no-scroll-while-dragging-on-a-pad', [sy, await E('window.scrollY')]);
          await sleep(900);   // let Chrome forget the drag (it swallows a tap right after one)
          { const A3 = await center('#padsBox [data-act="a"]'); await E('window.__ck = 0; __input.actions.length = 0'); await touch('touchStart', [{ x: A3.x, y: A3.y, id: 0 }]); await sleep(40); await touch('touchEnd', []); await sleep(450);
            const act = await E('__input.actions.map((e) => (e.pressed ? "+" : "-") + e.action).join(" ")');
            ok(act === '+a -a' && (await E('window.__ck')) === 0, 'browser-touch/no-ghost-click-after-a-pad-tap', { actions: act, clicks: await E('window.__ck') }); }
          const B = await center('#btnSave'); const c0 = await E('__input.counts.save'); await E('window.__ck = 0'); await touch('touchStart', [{ x: B.x, y: B.y, id: 0 }]); await touch('touchEnd', []); await sleep(450);
          ok((await E('__input.counts.save')) === c0 + 1 && (await E('window.__ck')) === 1, 'browser-touch/control-an-ordinary-button-still-clicks-exactly-once', { saves: await E('__input.counts.save'), clicks: await E('window.__ck') });
          // pinch with two fingers on a pad does not zoom the page
          const A2 = await center('#padsBox [data-act="a"]'); await touch('touchStart', [{ x: A2.x - 10, y: A2.y, id: 0 }]); await touch('touchStart', [{ x: A2.x - 10, y: A2.y, id: 0 }, { x: A2.x + 10, y: A2.y, id: 1 }]);
          for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: A2.x - 10 - i * 12, y: A2.y, id: 0 }, { x: A2.x + 10 + i * 12, y: A2.y, id: 1 }]); await sleep(20); } await touch('touchEnd', []); await sleep(150);
          ok((await E('window.visualViewport.scale')) === 1, 'browser-touch/no-pinch-zoom-from-a-pad', await E('window.visualViewport.scale')); }
        // touch on the canvas is a click at that position (no hover first)
        { const p = await gridPt(1); await E('__input.menu.chosen.length = 0'); await touch('touchStart', [{ x: p.x, y: p.y, id: 0 }]); await sleep(50); const down = (await st()).menu.cursor; await touch('touchEnd', []); await sleep(120); const s = await st();
          ok(down === 1 && s.menu.chosen.join() === 'BAG' && s.lastSource === 'touch', 'browser-touch/tap-on-the-canvas-selects-and-activates', { down, menu: s.menu });
          const q = await gridPt(0); await touch('touchStart', [{ x: q.x, y: q.y, id: 0 }]); for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: q.x + i * 30, y: q.y, id: 0 }]); await sleep(15); } await touch('touchEnd', []); await sleep(100);
          ok(!(await st()).menu.chosen.includes('FIGHT'), 'browser-touch/a-drag-on-the-canvas-is-not-a-tap'); }
        // the focus ring is never drawn for touch
        { await E("document.getElementById('modeDom').click()"); await sleep(900);   // Chrome swallows a tap that lands within a few hundred ms of the drag above (measured on a bare page with no input layer: 0 clicks at 100 ms, 1 click at 800 ms)
          const B = await center('#btnSave'); await touch('touchStart', [{ x: B.x, y: B.y, id: 0 }]); await touch('touchEnd', []); await sleep(200);
          const r = await E("({ a: document.activeElement.id, o: getComputedStyle(document.activeElement).outlineStyle, src: document.documentElement.getAttribute('data-input-source') })");
          ok(r.a === 'btnSave' && r.src === 'touch' && r.o === 'none', 'ring/hidden-under-touch', r); }
        // the DOM surfaces by touch alone: tabs, the dialog, the Controls panel's rebind capture started and cancelled by taps
        { await sleep(900);
          const tapEl = async (sel) => { const c = await center(sel); await touch('touchStart', [{ x: c.x, y: c.y, id: 0 }]); await sleep(30); await touch('touchEnd', []); await sleep(300); };
          await tapEl('#tab3'); ok((await E("document.getElementById('tab3').getAttribute('aria-selected')")) === 'true', 'browser-touch/tap-selects-a-tab');
          await tapEl('#btnDlg'); ok((await E('document.getElementById("dlg").hidden')) === false, 'browser-touch/tap-opens-the-dialog');
          await tapEl('#dlgClose'); ok((await E('document.getElementById("dlg").hidden')) === true, 'browser-touch/tap-closes-the-dialog');
          await tapEl('[data-fk="kb-a-0"]'); ok((await E('__input.input.capturing')) === true, 'browser-touch/tap-a-chip-starts-capture');
          await tapEl('[data-ip=cancel]'); ok((await E('__input.input.capturing')) === false && /Cancelled/.test(await E("document.querySelector('[data-ip=status]').textContent")), 'browser-touch/tap-cancel-stops-capture', await E("document.querySelector('[data-ip=status]').textContent")); }
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await page.setViewport(1280, 800);
      }

      /* ================================================================================== group: navkbd */
      const ring = () => E("({ id: document.activeElement.id || document.activeElement.tagName, o: getComputedStyle(document.activeElement).outlineStyle, w: getComputedStyle(document.activeElement).outlineWidth, src: document.documentElement.getAttribute('data-input-source') })");
      if (groupOn('navkbd')) {
        await page.setViewport(1280, 800); await load('?mode=dom');
        ok((await E("document.documentElement.getAttribute('data-input-source')")) === 'none', 'ring/no-source-until-the-first-input');
        await tap('ArrowDown'); let r = await ring();
        ok(r.id === 'menu' && r.src === 'keyboard' && r.o === 'solid' && r.w === '3px', 'ring/keyboard-visible', r);
        ok(await E("__input.nav.candidates().length > 8 && !__input.nav.candidates().some((c) => c.closest('[data-nav-skip]'))"), 'nav/skip-attribute-honoured');
        // elements the layer must NEVER land on: disabled, hidden, display:none, visibility:hidden, zero-size, inert, aria-hidden, inside a disabled fieldset, data-nav-skip
        { await E(`(() => { const f = document.createElement('div'); f.id = 'skipfx'; f.innerHTML = '<button id=sk-ok type=button>ok</button><button id=sk-dis type=button disabled>d</button><button id=sk-hid type=button hidden>h</button><button id=sk-vis type=button style="visibility:hidden">v</button><button id=sk-none type=button style="display:none">n</button><button id=sk-zero type=button style="width:0;height:0;padding:0;border:0;overflow:hidden">z</button><div inert><button id=sk-inert type=button>i</button></div><div aria-hidden=true><button id=sk-ah type=button>a</button></div><fieldset disabled><button id=sk-fs type=button>f</button></fieldset><div data-nav-skip><button id=sk-skip type=button>s</button></div>'; document.getElementById('formSec').appendChild(f); })()`);
          const ids = await E("__input.nav.candidates().map((c) => c.id).filter((id) => id.indexOf('sk-') === 0)");
          ok(ids.join() === 'sk-ok', 'nav/skips-inert-disabled-hidden-zero-size-and-aria-hidden', ids);
          await E("document.getElementById('skipfx').remove()"); }
        await tap('ArrowDown'); ok((await active()) === 'btnSave', 'nav/kbd-down-from-the-canvas-reaches-save', await active());
        await tap('ArrowRight'); ok((await active()) === 'btnCancel', 'nav/kbd-right-reaches-cancel', await active());
        await tap('ArrowLeft'); await tap('ArrowDown'); ok((await active()) === 'sel', 'nav/kbd-down-from-save-reaches-the-select', await active());
        // a keyboard on a select: its own arrows change the value (the layer must not take them)
        { const m = await mark(); await tap('ArrowDown'); ok((await E("document.getElementById('sel').value")) === 'two' && (await since(m)).length === 0 && (await active()) === 'sel', 'nav/kbd-arrows-keep-working-natively-on-a-select', await E("document.getElementById('sel').value")); }
        await tap('Escape'); ok((await active()) === 'BODY', 'nav/kbd-escape-leaves-the-select', await active());
        await tap('ArrowRight'); ok((await active()) === 'rng', 'nav/kbd-right-from-the-remembered-select-reaches-the-range', await active());
        // keyboard on a range: arrows are the browser's (the value changes), not ours
        { const v0 = Number(await E("document.getElementById('rng').value")); const m = await mark(); await tap('ArrowRight'); await tap('ArrowRight'); await tap('ArrowRight'); ok(Number(await E("document.getElementById('rng').value")) === v0 + 3 && (await since(m)).length === 0, 'nav/kbd-arrows-keep-working-natively-on-a-range', await E("document.getElementById('rng').value")); }
        await tap('Escape'); ok((await active()) === 'BODY', 'nav/kbd-escape-leaves-the-range', await active());
        await tap('ArrowDown'); ok((await active()) === 'txt', 'nav/kbd-arrow-continues-from-the-remembered-position', await active());
        await tap('KeyZ', { text: 'z' }); await tap('KeyA', { text: 'a' }); ok((await E("document.getElementById('txt').value")) === 'za', 'nav/kbd-typing-in-the-text-field-is-not-swallowed', await E("document.getElementById('txt').value"));
        await tap('Escape'); await tap('ArrowLeft'); ok((await active()) === 'num', 'nav/kbd-escape-then-left-reaches-the-number', await active());
        // a number field is a text-like field: its arrows are the browser's spinner (the layer must not take them) and Escape lets go of it
        { const n0 = Number(await E("document.getElementById('num').value")); const m = await mark(); await tap('ArrowDown'); ok(Number(await E("document.getElementById('num').value")) === n0 - 1 && (await since(m)).length === 0 && (await active()) === 'num', 'nav/kbd-arrows-keep-working-natively-on-a-number-input', await E("document.getElementById('num').value")); }
        await tap('Escape'); ok((await active()) === 'BODY', 'nav/kbd-escape-leaves-the-number-input', await active());
        await tap('ArrowDown'); ok((await active()) === 'chk', 'nav/kbd-down-reaches-the-checkbox', await active());
        { const c0 = await E('__input.counts.chk'); await tap('Space'); ok((await E('document.getElementById("chk").checked')) === true && (await E('__input.counts.chk')) === c0 + 1, 'nav/kbd-space-toggles-a-checkbox-natively-exactly-once', await E('__input.counts.chk'));
          await tap('Enter'); ok((await E('document.getElementById("chk").checked')) === false && (await E('__input.counts.chk')) === c0 + 2, 'nav/kbd-enter-toggles-a-checkbox-through-the-layer-exactly-once', await E('__input.counts.chk'));
          await tap('KeyZ'); ok((await E('document.getElementById("chk").checked')) === true && (await E('__input.counts.chk')) === c0 + 3, 'nav/kbd-z-is-confirm-too'); }
        await tap('ArrowRight'); ok((await active()) === 'tab1', 'nav/kbd-right-from-the-checkbox-reaches-the-first-tab', await active());
        await tap('ArrowRight'); ok((await active()) === 'tab2', 'nav/kbd-right-moves-along-the-tabs', await active());
        await tap('KeyE'); ok((await E("document.getElementById('tab3').getAttribute('aria-selected')")) === 'true' && (await active()) === 'tab3', 'nav/tabs-l-r', await active());
        await tap('KeyQ'); ok((await E("document.getElementById('tab2').getAttribute('aria-selected')")) === 'true' && (await active()) === 'tab2', 'nav/tabs-l-r-q-goes-back', await active());
        await tap('PageDown'); await tap('PageDown'); ok((await E("document.getElementById('tab1').getAttribute('aria-selected')")) === 'true', 'nav/tabs-wrap-around', await E("document.querySelector('[role=tab][aria-selected=true]').id"));
        await tap('ArrowDown'); ok((await active()) === 'btnDlg', 'nav/kbd-down-from-the-tabs-reaches-open-dialog', await active());
        // an ordinary button: Enter / Space / Z activate it exactly once (native where the browser does it, ours otherwise), never twice
        await E("document.getElementById('btnSave').focus()"); { const c0 = await E('__input.counts.save'); await tap('Enter'); ok((await E('__input.counts.save')) === c0 + 1, 'nav/keyboard-enter-activates-once', (await E('__input.counts.save')) - c0); await tap('Space'); ok((await E('__input.counts.save')) === c0 + 2, 'nav/keyboard-space-activates-once'); await tap('KeyZ'); ok((await E('__input.counts.save')) === c0 + 3, 'nav/keyboard-z-activates-once'); }
        // dialog: opens with Enter, traps focus (arrows and Tab), closes with Escape (B), focus returns to the opener
        await E("document.getElementById('btnDlg').focus()"); await tap('Enter'); await sleep(80);
        ok((await E('__input.counts.dlgOpen')) === 1 && (await active()) === 'dlgOk', 'nav/dialog-opens-from-the-keyboard', await active());
        { const where = () => E("document.activeElement.closest('#dlg') ? document.activeElement.id : 'OUTSIDE:' + document.activeElement.id"); const inside = [];
          for (const k of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) { await tap(k); inside.push(await where()); }
          for (let i = 0; i < 4; i++) { await tap('Tab'); inside.push(await where()); } await tap('Tab', { modifiers: 8 }); inside.push(await where());
          ok(inside.every((x) => !x.startsWith('OUTSIDE')) && inside.includes('dlgClose') && inside.includes('dlgOk'), 'nav/dialog-traps-focus', inside); }
        await tap('Escape'); await sleep(100); ok((await E('document.getElementById("dlg").hidden')) === true && (await active()) === 'btnDlg', 'nav/b-closes-dialog', { hidden: await E('document.getElementById("dlg").hidden'), active: await active() });
        // B with nothing to close calls onBack
        await E('document.activeElement.blur()'); { const n = await E("__input.log.filter((l) => l === 'onBack called').length"); await tap('KeyX'); ok((await E("__input.log.filter((l) => l === 'onBack called').length")) === n + 1, 'nav/b-calls-onBack-when-there-is-no-dialog'); }
      }

      /* ================================================================================== group: navpad */
      if (groupOn('navpad')) {
        await page.setViewport(1280, 800); await load('?mode=dom'); await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(150);
        await padTap(0, 13); let r = await ring(); ok(r.id === 'menu' && r.src === 'gamepad' && r.o === 'solid' && r.w === '3px', 'ring/gamepad-visible', r);
        await padTap(0, 13); ok((await active()) === 'btnSave', 'nav/pad-down-reaches-save', await active());
        await padTap(0, 15); ok((await active()) === 'btnCancel', 'nav/pad-right-reaches-cancel', await active());
        { const c0 = await E('__input.counts.cancel'); await padTap(0, 0); ok((await E('__input.counts.cancel')) === c0 + 1, 'nav/pad-a-clicks-a-button-exactly-once', await E('__input.counts.cancel')); }
        await padTap(0, 13); ok((await active()) === 'rng', 'nav/pad-down-reaches-the-range-by-geometry', await active());
        // range EDIT MODE
        { const rv = async () => Number(await E("document.getElementById('rng').value")); const v0 = await rv();
          await padTap(0, 0); ok((await E("document.getElementById('rng').hasAttribute('data-nav-editing')")) === true && (await E('__input.nav.editing() && __input.nav.editing().id')) === 'rng', 'nav/range-edit-mode', await E('__input.nav.editing() && __input.nav.editing().id'));
          await padTap(0, 15); await padTap(0, 15); await padTap(0, 15); ok((await rv()) === v0 + 3 && (await active()) === 'rng', 'nav/range-edit-right-increases', await rv());
          await padTap(0, 12); ok((await rv()) === v0 + 13, 'nav/range-edit-up-is-the-bigger-step', await rv());
          await padTap(0, 13); await padTap(0, 14); ok((await rv()) === v0 + 2 && (await active()) === 'rng', 'nav/range-edit-down-and-left-decrease', await rv());
          ok((await E('__input.counts.rng')) >= 6, 'nav/range-edit-fires-input-events', await E('__input.counts.rng'));
          await padTap(0, 1); ok((await E("document.getElementById('rng').hasAttribute('data-nav-editing')")) === false && (await E('__input.nav.editing()')) === null && (await active()) === 'rng', 'nav/b-leaves-edit-mode');
          await padTap(0, 13); ok((await active()) !== 'rng', 'nav/outside-edit-mode-directions-navigate-again', await active()); }
        // NUMBER edit mode (clamped to its max of 99)
        await E("document.getElementById('num').focus()"); { await padTap(0, 0); for (let i = 0; i < 12; i++) await padTap(0, 12, 50);
          ok((await E("document.getElementById('num').value")) === '99', 'nav/number-edit-clamps-at-max', await E("document.getElementById('num').value")); await padTap(0, 0); ok((await E('__input.nav.editing()')) === null, 'nav/a-also-leaves-edit-mode'); }
        // SELECT: showPicker needs a user gesture a gamepad does not give -> cycle mode. Wait out any transient activation left by earlier real input.
        await E("document.getElementById('sel').focus()"); await page.waitFor('navigator.userActivation && !navigator.userActivation.isActive', { timeoutMs: 8000 }).catch(() => {});
        { const act = await E('navigator.userActivation.isActive'); await padTap(0, 0); const editing = await E('__input.nav.editing() && __input.nav.editing().id'); ok(act === false && editing === 'sel', 'nav/select-cycle-fallback', { activation: act, editing });
          await padTap(0, 15); ok((await E("document.getElementById('sel').value")) === 'two', 'nav/select-cycle-right-selects-the-next-option'); await padTap(0, 13); ok((await E("document.getElementById('sel').value")) === 'three', 'nav/select-cycle-down-also-advances'); await padTap(0, 14); ok((await E("document.getElementById('sel').value")) === 'two', 'nav/select-cycle-left-goes-back');
          ok((await E('__input.counts.sel')) === 3, 'nav/select-cycle-fires-change-events', await E('__input.counts.sel')); await padTap(0, 1); ok((await E('__input.nav.editing()')) === null, 'nav/select-cycle-b-leaves'); }
        // where showPicker exists and works it is used and no cycle mode starts (stubbed: a real picker cannot be observed headlessly); where it is absent, cycle
        { await E("window.__picked = 0; HTMLSelectElement.prototype.__real = HTMLSelectElement.prototype.showPicker; HTMLSelectElement.prototype.showPicker = function () { window.__picked++; };"); await E("document.getElementById('sel').focus()"); await padTap(0, 0);
          ok((await E('window.__picked')) === 1 && (await E('__input.nav.editing()')) === null, 'nav/select-uses-showPicker-where-it-works', { picked: await E('window.__picked') });
          await E("delete HTMLSelectElement.prototype.showPicker"); await E("document.getElementById('sel').focus()"); await padTap(0, 0); ok((await E('__input.nav.editing() && __input.nav.editing().id')) === 'sel' && (await E('typeof HTMLSelectElement.prototype.showPicker')) === 'undefined', 'nav/select-without-showPicker-cycles'); await padTap(0, 1); await E("HTMLSelectElement.prototype.showPicker = HTMLSelectElement.prototype.__real"); }
        // CHECKBOX
        await E("document.getElementById('chk').focus()"); { const c0 = await E('__input.counts.chk'); await padTap(0, 0); ok((await E('document.getElementById("chk").checked')) === true && (await E('__input.counts.chk')) === c0 + 1, 'nav/pad-a-toggles-a-checkbox', await E('__input.counts.chk')); await padTap(0, 0); ok((await E('document.getElementById("chk").checked')) === false, 'nav/pad-a-toggles-it-back'); }
        // TABS with the shoulder buttons
        await E("document.getElementById('tab2').focus()"); await padTap(0, 5); ok((await E("document.getElementById('tab3').getAttribute('aria-selected')")) === 'true', 'nav/tabs-l-r-pad-rb-next', await E("document.querySelector('[role=tab][aria-selected=true]').id")); await padTap(0, 4); await padTap(0, 4); ok((await E("document.getElementById('tab1').getAttribute('aria-selected')")) === 'true', 'nav/tabs-l-r-pad-lb-previous');
        await padTap(0, 6); ok((await E("document.getElementById('tab3').getAttribute('aria-selected')")) === 'true', 'nav/tabs-wrap-via-the-left-trigger');
        // DOM-order fallback: nothing lies to the right of the last tab, so Right falls through to the next control in DOM order
        // (a scoped fixture: fb1 sits top-right, fb2 bottom-left, so NOTHING lies to the right of fb1 or to the left of fb2 by geometry, strict or loose)
        { await E("__input.nav.disable(); const f = document.createElement('div'); f.id = 'fb'; f.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:200px;z-index:60;background:#223'; f.innerHTML = '<button id=fb1 type=button style=\"position:absolute;right:10px;top:10px\">One</button><button id=fb2 type=button style=\"position:absolute;left:10px;top:120px\">Two</button>'; document.body.appendChild(f);");
          await E("import('/pokemonarena/js/uinav.js').then((m) => { window.__fbNav = m.enableDomNav(document.getElementById('fb'), { input: __input.input, scope: document.getElementById('fb') }); return true; })");
          await E("document.getElementById('fb1').focus()"); await padTap(0, 15); const fwd = await active();
          await E("document.getElementById('fb2').focus()"); await padTap(0, 14); const back = await active();
          ok(fwd === 'fb2' && back === 'fb1', 'nav/dom-order-fallback', { right: fwd, left: back });
          await E("window.__fbNav.disable(); document.getElementById('fb').remove(); __input.setMode('dom')"); }
        // TEXT FIELD: landing focuses it; A starts typing; the d-pad leaves only when it is empty; B finishes typing
        await E("document.getElementById('txt').focus()"); await E("document.getElementById('txt').value = ''"); await padTap(0, 0); ok((await E('__input.nav.typing()')) === true, 'nav/a-on-a-text-field-starts-typing');
        await padTap(0, 13); ok((await active()) !== 'txt', 'nav/text-typing-empty-field-lets-the-dpad-leave', await active());
        await E("document.getElementById('txt').focus(); document.getElementById('txt').value = 'hi'; document.getElementById('txt').dispatchEvent(new Event('input', { bubbles: true }))"); await sleep(60);
        await padTap(0, 13); await padTap(0, 15); ok((await active()) === 'txt' && (await E('__input.nav.typing()')) === true, 'nav/text-typing-holds-nonempty', await active());
        await padTap(0, 1); ok((await E('__input.nav.typing()')) === false && (await active()) === 'txt', 'nav/b-ends-typing-and-keeps-focus'); await padTap(0, 13); ok((await active()) !== 'txt', 'nav/then-the-dpad-navigates-away', await active());
        // DIALOG with the pad: opens with A, cannot be left with the d-pad, closes with B and focus returns
        await E("document.getElementById('btnDlg').focus()");
        { const o0 = await E('__input.counts.dlgOpen'); await padTap(0, 0); await sleep(80); ok((await E('__input.counts.dlgOpen')) === o0 + 1 && (await active()) === 'dlgOk', 'nav/pad-opens-the-dialog', await active());
          const seen = []; for (const b of [13, 13, 15, 15, 12, 12, 14, 14, 13, 15, 13, 14]) { await padTap(0, b, 50); seen.push(await E("document.activeElement.closest('#dlg') ? document.activeElement.id : 'OUTSIDE:' + document.activeElement.id")); }
          ok(seen.every((x) => !x.startsWith('OUTSIDE')) && seen.includes('dlgClose') && seen.includes('dlgOk'), 'nav/pad-dialog-traps-focus', seen);
          await padTap(0, 1); await sleep(100); ok((await E('document.getElementById("dlg").hidden')) === true && (await active()) === 'btnDlg', 'nav/pad-b-closes-dialog', { hidden: await E('document.getElementById("dlg").hidden'), active: await active() }); }
        // every form control is reachable with the pad alone: breadth-first, one real pad press per edge
        { const want = ['btnSave', 'btnCancel', 'sel', 'rng', 'num', 'txt', 'chk', 'tab1', 'tab2', 'tab3', 'btnDlg']; const seen = new Set(['btnSave']); const queue = ['btnSave'];
          while (queue.length) { const id = queue.shift(); for (const d of [12, 13, 14, 15]) { await E(`document.getElementById(${J(id)}).focus()`); await padTap(0, d, 40); const a = await active(); if (want.includes(a) && !seen.has(a)) { seen.add(a); queue.push(a); } } }
          ok(want.every((id) => seen.has(id)), 'nav/every-form-control-is-reachable-with-the-pad-alone', Array.from(seen)); }
        await E('__synth.disconnect(0)');
      }

      /* ==================================================================================== group: ring */
      if (groupOn('ring')) {
        await page.setViewport(1280, 800); await load('?mode=dom');
        { const B = await center('#btnSave'); await click(B.x, B.y); await sleep(80); let r = await ring(); ok(r.id === 'btnSave' && r.src === 'mouse' && r.o === 'none', 'ring/hidden-under-mouse', r);
          await tap('Tab'); r = await ring(); ok(r.src === 'keyboard' && r.o === 'solid', 'ring/returns-when-the-keyboard-takes-over', r);
          const c = await center('#btnCancel'); await click(c.x, c.y); await sleep(80); r = await ring(); ok(r.o === 'none' && r.src === 'mouse' && r.id === 'btnCancel', 'ring/hidden-again-after-a-click', r);
          await E("document.getElementById('txt').focus()"); const t = await center('#txt'); await click(t.x, t.y); await sleep(80); r = await ring(); ok(r.id === 'txt' && r.o === 'none', 'ring/hidden-for-a-text-field-focused-by-mouse', r); }
      }

      /* ====================================================================================== group: rebind */
      if (groupOn('rebind')) {
        await E("localStorage.removeItem('arena.bindings')"); await load('?mode=canvas');
        // keyboard rebinding, keyboard only: focus the chip, Enter starts capture, the next key binds
        await E("document.querySelector('[data-fk=\"kb-a-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-a-0\"]').focus()"); await tap('Enter'); await sleep(100);
        ok((await E("__input.input.capturing")) === true && (await E("document.querySelector('[data-ip=status]').textContent")).includes('Press a key'), 'rebind/enter-starts-capture-and-says-so', await E("document.querySelector('[data-ip=status]').textContent"));
        await tap('KeyG'); await sleep(120);
        ok((await E('__input.input.bindings.get().keyboard.a.join()')) === 'KeyG,Enter,Space,NumpadEnter' && (await E('__input.input.capturing')) === false, 'rebind/key-bound', await E('__input.input.bindings.get().keyboard.a.join()'));
        ok((await E("document.querySelector('[data-fk=\"kb-a-0\"]').textContent")) === 'G', 'rebind/panel-shows-the-new-key');
        { await E('__input.actions.length = 0'); await E('document.activeElement.blur()'); await tap('KeyG'); await tap('KeyZ'); ok(sigOf(await E('__input.actions.slice()')) === '+a -a', 'rebind/new-key-works-and-the-old-one-is-gone', sigOf(await E('__input.actions.slice()'))); }
        ok((await E("JSON.parse(localStorage.getItem('arena.bindings')).keyboard.a[0]")) === 'KeyG', 'rebind/persisted-to-localStorage-arena-bindings');
        // a reserved key during capture is refused with a message and capture keeps waiting
        await E("document.querySelector('[data-fk=\"kb-y-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-y-0\"]').click()"); await sleep(80); await tap('F5'); await sleep(60);
        ok((await E('__input.input.capturing')) === true && /cannot be used/.test(await E("document.querySelector('[data-ip=status]').textContent")), 'rebind/reserved-key-refused-with-a-message', await E("document.querySelector('[data-ip=status]').textContent"));
        await tap('Escape'); await sleep(80); ok((await E('__input.input.capturing')) === false && (await E('__input.input.bindings.get().keyboard.y.join()')) === 'KeyV', 'rebind/escape-cancels-and-changes-nothing');
        // conflict: bind B's first key to G (already A) -> a warning with Swap / Use it here / Cancel; Swap trades them
        await E("document.querySelector('[data-fk=\"kb-b-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-b-0\"]').click()"); await sleep(80); await tap('KeyG'); await sleep(120);
        ok((await E("!!document.querySelector('[data-ip=conflict]')")) === true && (await E('__input.input.bindings.get().keyboard.b[0]')) === 'KeyX', 'rebind/conflict-is-reported-and-nothing-changed', await E("document.querySelector('[data-ip=status]').textContent"));
        { const sw = await center('[data-ip=swap]'); await click(sw.x, sw.y); await sleep(120); const k = await E('__input.input.bindings.get().keyboard'); ok(k.b[0] === 'KeyG' && k.a[0] === 'KeyX' && !(await E("!!document.querySelector('[data-ip=conflict]')")), 'rebind/swap-trades-the-two-keys', { a: k.a, b: k.b }); }
        // Reset keyboard: always reachable, restores the defaults and clears storage
        { const rk = await center('[data-ip=reset-keyboard]'); await click(rk.x, rk.y); await sleep(120); ok((await E('__input.input.bindings.get().keyboard.a[0]')) === 'KeyZ' && (await E("localStorage.getItem('arena.bindings')")) === null, 'rebind/reset-keyboard-restores-defaults-and-clears-storage', await E("localStorage.getItem('arena.bindings')")); }
        // persistence across a RELOAD (real localStorage)
        await E("document.querySelector('[data-fk=\"kb-a-1\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-a-1\"]').click()"); await sleep(80); await tap('KeyJ'); await sleep(100);
        ok((await E('__input.input.bindings.get().keyboard.a.join()')) === 'KeyZ,KeyJ,Space,NumpadEnter', 'rebind/second-slot-bound', await E('__input.input.bindings.get().keyboard.a.join()'));
        await load('?mode=canvas'); ok((await E('__input.input.bindings.get().keyboard.a.join()')) === 'KeyZ,KeyJ,Space,NumpadEnter' && (await E('__input.input.bindings.status().status')) === 'loaded', 'rebind/survives-a-reload', await E('__input.input.bindings.status()'));
        { await E('__input.actions.length = 0'); await tap('KeyJ'); ok(sigOf(await E('__input.actions.slice()')) === '+a -a', 'rebind/the-persisted-key-works-after-the-reload'); }
        { const rk = await center('[data-ip=reset-all]'); await click(rk.x, rk.y); await sleep(100); }
        // PAD-ONLY rebinding: reach the chip with the d-pad, A starts capture, the held A is NOT captured, the next button is
        await load('?mode=dom'); await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(150);
        { await E("document.querySelector('[data-fk=\"pad-a-0\"]').scrollIntoView({ block: 'center' })"); await E("document.querySelector('[data-fk=\"reset-pad\"]').focus()");
          const fk = () => E("document.activeElement && document.activeElement.getAttribute('data-fk')");
          let n = 0; for (; n < 60 && !String(await fk()).startsWith('kb-a-'); n++) await padTap(0, 13, 45);          // Down to the action's row (keyboard column) ...
          for (; n < 90 && (await fk()) !== 'pad-a-0'; n++) await padTap(0, 15, 45);                                    // ... then Right across to the controller column
          ok((await E("document.activeElement.getAttribute('data-fk')")) === 'pad-a-0', 'rebind/pad-alone-can-reach-the-controller-chip', { presses: n, at: await E("document.activeElement.getAttribute('data-fk')") });
          await padDown(0, 0); await sleep(100); ok((await E('__input.input.capturing')) === true, 'rebind/pad-a-starts-capture'); await sleep(250); ok((await E('__input.input.capturing')) === true, 'rebind/the-press-that-started-capture-is-not-captured');
          await padUp(0, 0); await sleep(120); ok((await E('__input.input.capturing')) === true, 'rebind/releasing-it-does-not-capture-either');
          await padTap(0, 10); await sleep(150); ok((await E('__input.input.bindings.get().gamepad.buttons.a.join()')) === '10' && !(await E('__input.input.capturing')), 'rebind/pad-button-bound', await E('__input.input.bindings.get().gamepad.buttons.a.join()')); }
        await E('document.activeElement && document.activeElement.blur()'); await load('?mode=canvas'); await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(150);
        { ok((await E('__input.input.bindings.get().gamepad.buttons.a.join()')) === '10', 'rebind/pad-binding-survives-a-reload'); let m = await mark(); await padTap(0, 10); ok(sigOf(await since(m)) === '+a -a', 'rebind/the-persisted-pad-button-works'); m = await mark(); await padTap(0, 0); ok((await since(m)).length === 0, 'rebind/the-old-pad-button-no-longer-confirms'); }
        // layout switch to Nintendo applies to an xbox-id pad, persisted
        { const nb = await center('[data-fk="layout-nintendo"]'); await click(nb.x, nb.y); await sleep(100); await E('__input.input.bindings.reset("gamepad")'); const nb2 = await center('[data-fk="layout-nintendo"]'); await click(nb2.x, nb2.y); await sleep(100); const m = await mark(); await padTap(0, 1); ok(sigOf(await since(m)) === '+a -a' && (await E('JSON.parse(localStorage.getItem("arena.bindings")).gamepad.layout')) === 'nintendo', 'rebind/layout-switch-applies-and-persists'); }
        { const rp = await center('[data-ip=reset-gamepad]'); await click(rp.x, rp.y); await sleep(100); ok((await E('__input.input.bindings.layout()')) === 'auto' && (await E("localStorage.getItem('arena.bindings')")) === null, 'rebind/reset-controller-clears-layout-and-storage'); }
        // a capture nobody answers gives up on its own (a pad-only player is never trapped): the panel's own 8 s timeout, in real time
        { await E("document.querySelector('[data-fk=\"pad-x-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"pad-x-0\"]').click()"); await sleep(120); ok((await E('__input.input.capturing')) === true, 'rebind/capture-started-for-the-timeout-test'); await sleep(8600);
          ok((await E('__input.input.capturing')) === false && /nothing changed/.test(await E("document.querySelector('[data-ip=status]').textContent")), 'rebind/capture-times-out-by-itself-and-says-so', await E("document.querySelector('[data-ip=status]').textContent")); }
        await E('__synth.disconnect(0)');
        // hostile storage in a REAL browser: defaults, no errors; and with storage absent the layer still works
        await E("localStorage.setItem('arena.bindings', '{\"v\":1,\"keyboard\":{\"a\":\"nope\",\"__proto__\":{\"x\":1}},\"gamepad\":{\"layout\":42}}')"); await load('?mode=canvas');
        ok((await E('__input.input.bindings.get().keyboard.a.join()')) === 'KeyZ,Enter,Space,NumpadEnter' && (await E('__input.input.bindings.status().status')) === 'repaired' && (await E('({}).x')) === undefined, 'rebind/hostile-localStorage-repaired-in-a-real-browser', await E('__input.input.bindings.status()'));
        await E("localStorage.setItem('arena.bindings', '{{{not json')"); await load('?mode=canvas'); ok((await E('__input.input.bindings.status().status')) === 'invalid' && (await E('__input.input.bindings.get().keyboard.up[0]')) === 'ArrowUp', 'rebind/garbage-localStorage-falls-back-in-a-real-browser');
        await E("localStorage.removeItem('arena.bindings')"); await load('?mode=canvas&storage=none');
        ok((await E('__input.input.bindings.status().status')) === 'absent' && (await E('__input.input.bindings.status().hasStorage')) === false, 'rebind/storage-absent-reports-so', await E('__input.input.bindings.status()'));
        { const b = await E("__input.input.bindings.rebind('keyboard', 'a', 0, 'KeyG')"); ok(b.ok, 'rebind/storage-absent-rebinding-still-works'); await E('document.activeElement && document.activeElement.blur()'); await E('__input.actions.length = 0'); await tap('KeyG'); ok(sigOf(await E('__input.actions.slice()')) === '+a -a', 'rebind/storage-absent-new-key-fires', sigOf(await E('__input.actions.slice()'))); ok((await E("localStorage.getItem('arena.bindings')")) === null, 'rebind/storage-absent-writes-nothing'); }
      }

      /* ======================================================================================== group: doc */
      // Every ```js verify block in INPUT.md is run in a page with the fixture its text describes, then driven with REAL input.
      if (groupOn('doc')) {
        const md = fs.readFileSync(path.join(SRC, 'pokemonarena', 'INPUT.md'), 'utf8');
        const blocks = []; { const re = /```js verify\n([\s\S]*?)```/g; let m; while ((m = re.exec(md))) { const nm = /\/\/ verify: (\S+)/.exec(m[1]); blocks.push({ name: nm && nm[1], code: m[1] }); } }
        ok(blocks.length === 6 && blocks.every((b) => b.name), 'doc/every-snippet-is-named-and-all-six-are-present', blocks.map((b) => b.name));
        const FIX = '<canvas id="battle" width="240" height="160" style="display:block;width:480px;height:320px"></canvas><div id="padbox">' + ['up', 'down', 'left', 'right', 'a', 'b'].map((b) => '<button type="button" data-btn="' + b + '" style="width:52px;height:52px">' + b + '</button>').join('') + '</div>'
          + '<main id="app"><button id="start" type="button" style="display:block">Start</button><button id="back" type="button" style="display:block">Back</button><input id="name" type="text" style="display:block"></main><div id="settings"></div><p id="hint"></p>';
        const run = async (code) => {
          await page.navigate(BASE + '/pokemonarena/manifest.json'); await sleep(120);        // a same-origin NON-HTML document: a clean page with no layer of ours on it
          await E("localStorage.removeItem('arena.bindings'); document.body.style.margin = '0'; document.body.innerHTML = " + J(FIX));
          const src = code.replace(/'\.\/js\//g, "'" + BASE + "/pokemonarena/js/") + '\n;window.__snip = { input: typeof input === "undefined" ? null : input, nav: typeof nav === "undefined" ? null : nav, panel: typeof panel === "undefined" ? null : panel, log: typeof log === "undefined" ? null : log, held: typeof held === "undefined" ? null : held, view: typeof view === "undefined" ? null : view, r: typeof r1 === "undefined" ? null : [r1, r2, r3], speed: typeof speed === "undefined" ? null : speed, confirmHint: typeof confirmHint === "undefined" ? null : confirmHint };';
          return E("(async () => { try { const u = URL.createObjectURL(new Blob([" + J(src) + "], { type: 'text/javascript' })); await import(u); return { ok: true }; } catch (e) { return { ok: false, err: String((e && e.stack) || e) }; } })()");
        };
        const snip = (name) => blocks.find((b) => b.name === name);
        // negative control: the harness really does report a snippet that throws
        { const bad = await run("import { createInput } from './js/input.js';\nconst input = createInput();\ninput.thisMethodDoesNotExist();"); ok(bad.ok === false && /not a function/.test(bad.err), 'doc/harness-detects-a-broken-snippet', bad); }
        // 1. the canvas page, driven by a real keyboard, real mouse (hover, click, right click, an on-screen pad)
        { const r = await run(snip('canvas-page').code); ok(r.ok, 'doc/canvas-page-runs', r);
          await E("document.activeElement && document.activeElement.blur()"); await tap('ArrowRight');
          const cv = await E("(() => { const r = document.getElementById('battle').getBoundingClientRect(); return { l: r.left, t: r.top }; })()");
          await hover(cv.l + 400, cv.t + 260);                                                  // logical (200, 130): inside the second action
          ok((await E('window.__snip.view.cursor')) === 1, 'doc/canvas-page-hover-moves-the-cursor', await E('window.__snip.view.cursor'));
          await click(cv.l + 260, cv.t + 260); await click(cv.l + 100, cv.t + 100, 'right');
          const pa = await center('[data-btn=a]'); await click(pa.x, pa.y);
          const lg = await E('window.__snip.log');
          ok(lg.includes('action:right') && lg.includes('choose:0') && lg.includes('action:b') && lg.includes('action:a'), 'doc/canvas-page-keyboard-click-right-click-and-pad-all-arrive', lg); }
        // 2. a DOM page: focusFirst, keyboard moves and activates, B calls onBack, Start calls onMenu
        { const r = await run(snip('dom-page').code); ok(r.ok, 'doc/dom-page-runs', r);
          ok((await active()) === 'start', 'doc/dom-page-focusFirst-lands-on-the-first-control', await active());
          await tap('ArrowDown'); ok((await active()) === 'back', 'doc/dom-page-arrow-moves-focus', await active());
          await tap('ArrowUp'); await tap('Enter'); await tap('KeyX'); await tap('KeyP');
          const lg = await E('window.__snip.log'); ok(lg.join() === 'start clicked,back,menu', 'doc/dom-page-enter-clicks-once-b-calls-onBack-and-start-calls-onMenu', lg); }
        // 3. the Controls panel mounted next to the nav, operated by keyboard
        { const r = await run(snip('controls-panel').code); ok(r.ok, 'doc/controls-panel-runs', r);
          ok(await E("!!document.querySelector('#settings [data-ip=panel]') && !!document.querySelector('#settings [data-ip=reset-all]')"), 'doc/controls-panel-is-mounted-with-its-reset-buttons');
          await E("document.querySelector('[data-fk=\"kb-y-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-y-0\"]').focus()"); await tap('Enter'); await sleep(80); await tap('KeyJ'); await sleep(100);
          ok((await E('window.__snip.input.bindings.get().keyboard.y.join()')) === 'KeyJ', 'doc/controls-panel-rebinds-with-the-keyboard', await E('window.__snip.input.bindings.get().keyboard.y.join()')); }
        // 4. the on-screen pads, pressed with a real mouse
        { const r = await run(snip('pads').code); ok(r.ok, 'doc/pads-run', r);
          const pu = await center('[data-btn=up]'); await mouse('mouseMoved', pu.x, pu.y); await mouse('mousePressed', pu.x, pu.y, { button: 'left', buttons: 1, clickCount: 1 }); await sleep(60);
          const down = await E('window.__snip.input.isDown("up") && document.querySelector("[data-btn=up]").classList.contains("down")'); await mouse('mouseReleased', pu.x, pu.y, { button: 'left', clickCount: 1 }); await sleep(60);
          ok(down && !(await E('window.__snip.input.isDown("up")')) && (await E('window.__snip.held.join()')) === '+up,-up', 'doc/pads-press-and-release', await E('window.__snip.held')); }
        // 5. holding and glyphs
        { const r = await run(snip('hold-and-glyph').code); ok(r.ok, 'doc/hold-and-glyph-runs', r);
          ok((await E('window.__snip.speed()')) === 'normal', 'doc/hold-and-glyph-normal-speed-when-nothing-is-held');
          await kdown('KeyZ'); await sleep(60); const fast = await E('window.__snip.speed()'); await kup('KeyZ'); await sleep(60);
          ok(fast === 'fast' && (await E('window.__snip.speed()')) === 'normal' && (await E('window.__snip.confirmHint()')) === 'Press Z to continue', 'doc/hold-and-glyph-holding-A-is-fast-and-the-glyph-is-Z', { fast, hint: await E('window.__snip.confirmHint()') }); }
        // 6. rebinding from code
        { const r = await run(snip('rebind-api').code); ok(r.ok, 'doc/rebind-api-runs', r);
          const rr = await E('window.__snip.r'); ok(rr[0].ok === true && rr[1].ok === false && rr[1].reason === 'conflict' && rr[1].conflicts.join() === 'a' && rr[2].ok === true, 'doc/rebind-api-results-are-what-the-comments-say', rr);
          ok((await E('window.__snip.input.bindings.get().keyboard.a[0]')) === 'KeyZ' && (await E("localStorage.getItem('arena.bindings')")) === null, 'doc/rebind-api-reset-restores-defaults-and-clears-storage'); }
      }

      /* ===================================================================================== group: shots */
      if (groupOn('shots')) {
        fs.mkdirSync(OUT, { recursive: true });
        const SIZES = [['390x844', 390, 844, true], ['844x390', 844, 390, true], ['1280x800', 1280, 800, false], ['320x640', 320, 640, true]];   // 320 wide: the narrowest phone the Controls panel has to fit
        const sh = async (name) => { await sleep(150); await page.screenshot(path.join(OUT, name + '.png')); };
        for (const [label, w, h, mobile] of SIZES) {
          await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await page.setViewport(w, h, { mobile, dpr: 1 }); await E("localStorage.removeItem('arena.bindings')"); await load('?mode=dom');
          const overflow = await E('document.documentElement.scrollWidth - document.documentElement.clientWidth'); ok(overflow <= 0, 'shots/' + label + '/no-horizontal-scroll', overflow);
          await sh(label + '-1-initial');
          await tap('ArrowDown'); await sh(label + '-2-keyboard-ring-on-canvas');
          await E("document.getElementById('btnSave').focus()"); await tap('ArrowDown'); await E("document.getElementById('formSec').scrollIntoView({ block: 'start' })"); await sh(label + '-3-keyboard-ring-in-form');
          await E(`__synth.connect(0, ${J(XBOX_ID)})`); await sleep(120); await E("document.getElementById('sel').focus()"); await padTap(0, 15); await E("document.getElementById('formSec').scrollIntoView({ block: 'start' })"); await padTap(0, 0);
          ok((await E('__input.nav.editing() && __input.nav.editing().id')) === 'rng', 'shots/' + label + '/range-is-in-edit-mode-for-its-screenshot', await active()); await sh(label + '-4-pad-ring-and-range-edit-mode'); await padTap(0, 1);
          const B = await center('#btnSave'); await click(B.x, B.y); await sh(label + '-5-mouse-click-no-ring');
          await E("document.getElementById('tab2').focus()"); await padTap(0, 5); await E("document.getElementById('btnDlg').focus(); document.getElementById('btnDlg').scrollIntoView({ block: 'center' })"); await padTap(0, 0); await sleep(120);
          ok((await E('document.getElementById("dlg").hidden')) === false && (await active()) === 'dlgOk', 'shots/' + label + '/dialog-is-open-for-its-screenshot', await active()); await sh(label + '-6-dialog-open-with-pad-ring'); await padTap(0, 1);
          await E("document.querySelector('[data-fk=\"kb-b-0\"]').scrollIntoView({ block: 'center' }); document.querySelector('[data-fk=\"kb-b-0\"]').click()"); await sleep(100); await tap('KeyZ'); await sleep(150); await E("document.querySelector('[data-ip=panel]').scrollIntoView({ block: 'start' })"); await sh(label + '-7-controls-panel-conflict-warning');
          await E("document.querySelector('[data-ip=cf-cancel]') && document.querySelector('[data-ip=cf-cancel]').click()"); await E("document.querySelector('[data-ip=reset-all]').click()"); await E("document.querySelector('[data-fk=\"kb-up-0\"]').scrollIntoView({ block: 'center' })"); await sh(label + '-8-controls-table');
          await E('__synth.disconnect(0)'); await E("localStorage.removeItem('arena.bindings')");
        }
        ok(fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length >= 32, 'shots/screenshots-written', fs.readdirSync(OUT).length);
      }

      /* ================================================================================== console errors */
      consoleErrors = page.errors.concat(page.console.filter((c) => c.type === 'error' || c.type === 'assert').map((c) => 'console.' + c.type + ': ' + c.text));
      // the doc group runs its snippets on a bare JSON document (no <link rel=icon>), for which Chrome asks the dev server for /favicon.ico: harness noise, not the layer
      consoleErrors = consoleErrors.filter((e) => !/favicon.ico/.test(e));
      ok(consoleErrors.length === 0, 'browser/no-console-or-page-errors', consoleErrors.slice(0, 5));
    });
  } finally { try { server.kill(); } catch (_e) { /* ignore */ } await sleep(300); }
}

/* ======================================================================================================= (c) MUTANTS */
// Each mutant is ONE defect applied to a copy of the sources. kind 'unit' re-runs the Node suite on the copy; kind 'browser' re-runs the
// named browser groups against a dev server serving the copy (and stops at the first failure of the expected check). A mutant counts as KILLED
// only when the check NAMED in `expect` fails; a crash, a syntax error or a different check failing is reported as such, not as a kill.
const MUT_FILES = ['js/input.js', 'js/uinav.js', 'js/input_panel.js', 'input.css', 'dev/input_lab.html', 'INPUT.md'];
const U = (id, file, find, replace, expect) => ({ id, kind: 'unit', edits: [{ file, find, replace }], expect: [].concat(expect) });
const B = (id, groups, edits, expect) => ({ id, kind: 'browser', groups, edits, expect: [].concat(expect) });
const IN = 'js/input.js', NV = 'js/uinav.js';
const MUTANTS = [
  U('stick-enter-0.6', IN, 'stickEnter: 0.5,', 'stickEnter: 0.6,', 'stick/enter-boundary-0.5'),
  U('stick-enter-gt', IN, 'return v >= enter ? dirOf(dom) : null;', 'return v > enter ? dirOf(dom) : null;', 'stick/enter-boundary-0.5'),
  U('nav-wide-below-narrow-penalised', NV, 'const ocOut = aligned ? 0 : Math.max(0, a.os - b.oc, b.oc - a.oe);', 'const ocOut = Math.max(0, a.os - b.oc, b.oc - a.oe);', 'nav/choose-a-full-width-control-directly-below-a-narrow-one-is-next'),
  U('nav-any-overlap-is-aligned', NV, 'const aligned = ow > 0 && ow >= 0.5 * Math.min(a.oe - a.os, b.oe - b.os);', 'const aligned = ow > 0;', 'nav/choose-a-wide-control-that-only-grazes-the-span-is-not-aligned'),
  U('trap-move-may-empty', IN, "for (const [c, cl] of after) if (cl.length === 0 && CORE_ACTIONS.includes(c)) return { ok: false, reason: 'would-empty', conflicts: [c] };", '', 'trap/move-that-would-empty-a-core-action-is-refused'),
  U('trap-last-removable', IN, "if (list.length === 1 && CORE_ACTIONS.includes(action)) return { ok: false, reason: 'last' };", '', 'trap/last-binding-of-a-core-action-stays'),
  U('trap-saved-empty-accepted', IN, " || (list.length === 0 && CORE_ACTIONS.includes(a))) { problems.push('gamepad.buttons.'", ") { problems.push('gamepad.buttons.'", 'trap/an-empty-saved-list-for-a-core-action-falls-back-to-the-default'),
  U('trap-no-escape', IN, "else if (t - info.escAt >= TIMING.padEscapeMs) { info.escAt = Infinity; bindings.reset('gamepad'); }", 'else if (false) { }', 'trap/start-plus-select-held-2s-resets-the-controller-bindings'),
  U('trap-escape-at-once', IN, 't - info.escAt >= TIMING.padEscapeMs', 't - info.escAt >= 0', 'trap/start-plus-select-held-2s-resets-the-controller-bindings'),
  U('trap-escape-one-button', IN, 'if (info.standard && info.prev[8] && info.prev[9]) {', 'if (info.standard && (info.prev[8] || info.prev[9])) {', 'trap/the-escape-needs-both-buttons-held-for-the-whole-time'),
  U('stick-exit-0.45', IN, 'stickExit: 0.35,', 'stickExit: 0.45,', 'stick/hysteresis-holds-0.4'),
  U('stick-exit-lte', IN, 'if (mine * sign >= exit) {', 'if (mine * sign > exit) {', 'stick/exit-boundary-0.35-holds'),
  U('stick-no-hysteresis', IN, 'if (mine * sign >= exit) {', 'if (mine * sign >= enter) {', 'stick/hysteresis-holds-0.4'),
  U('stick-diagonal-minor-axis', IN, "const dom = axx >= ayy ? 'x' : 'y';", "const dom = axx <= ayy ? 'x' : 'y';", 'stick/diagonal-dominant-axis'),
  U('stick-handover-without-dominance', IN, "if (other >= enter && other > own) return dirOf(horiz ? 'y' : 'x');", "if (other >= enter) return dirOf(horiz ? 'y' : 'x');", 'stick/diagonal-handover-needs-larger-axis'),
  U('repeat-delay-300', IN, 'repeatDelayMs: 400,', 'repeatDelayMs: 300,', 'repeat/first-at-400ms'),
  U('repeat-interval-120', IN, 'repeatIntervalMs: 90,', 'repeatIntervalMs: 120,', 'repeat/interval-90ms'),
  U('repeat-for-every-action', IN, 'if (DIRECTIONS.includes(action)) reps.set(', 'if (true) reps.set(', 'repeat/a-and-b-never-repeat'),
  U('e.repeat-not-ignored', IN, "if (e.repeat) { if (mode === 'none' && consumed.has(code)) e.preventDefault(); return; }", 'if (e.repeat && false) { return; }', 'keyboard/os-autorepeat-after-release-ignored'),
  U('guard-text-input-removed', IN, "if (tag === 'INPUT') return !NON_TEXT_INPUT.has(String(t.type || 'text').toLowerCase());", "if (tag === 'INPUT') return false;", 'guard/text-input-not-swallowed'),
  U('guard-contenteditable-removed', IN, 'if (t.isContentEditable === true) return true;', 'if (false) return true;', 'guard/contenteditable-not-swallowed'),
  U('guard-ctrl-removed', IN, 'if (e.ctrlKey || e.metaKey || e.altKey) return;', 'if (e.metaKey || e.altKey) return;', 'guard/ctrl-held-ignored'),
  U('guard-meta-removed', IN, 'if (e.ctrlKey || e.metaKey || e.altKey) return;', 'if (e.ctrlKey || e.altKey) return;', 'guard/meta-held-ignored'),
  U('nintendo-swap-removed', IN, "export function padLayoutFor(id) { return padFamily(id) === 'nintendo' ? 'nintendo' : 'xbox'; }", "export function padLayoutFor(id) { return padFamily(id) === 'nintendo' ? 'xbox' : 'xbox'; }", 'layout/nintendo-confirm-is-east'),
  U('nintendo-id-057e-dropped', IN, 'const NINTENDO_RE = /nintendo|switch|pro controller|057e|joy-?con/i;', 'const NINTENDO_RE = /nintendo|switch|pro controller|joy-?con/i;', 'layout/id-057e-only'),
  U('blur-release-removed', IN, "function onBlur() { releaseAll('blur'); }", 'function onBlur() { }', 'release/blur'),
  U('visibility-release-removed', IN, "function onVisibility() { if (doc && doc.hidden) releaseAll('hidden'); else maybeScan(false); }", 'function onVisibility() { maybeScan(false); }', 'release/visibilitychange'),
  U('disconnect-release-removed', IN, 'for (const a of Array.from(holders.keys())) { const h = holders.get(a); if (!h) continue; for (const tk of Array.from(h.keys())) if (tk.startsWith(pre)) dropHolder(a, tk); }', '', 'release/pad-disconnect-while-held'),
  U('disconnect-event-ignored', IN, 'function onPadDisconnected(e) { const gp = e && e.gamepad; if (gp) removePad(Number.isInteger(gp.index) ? gp.index : 0); }', 'function onPadDisconnected(e) { }', 'hotplug/disconnect-event-immediate'),
  U('holders-not-refcounted', IN, 'if (h.size > 0) return;', '', 'holders/two-holders-release-last'),
  U('storage-keyboard-validation-removed', IN, "if (!Array.isArray(list) || list.length > MAX_LIST || !list.every(isBindableKey) || (list.length === 0 && CORE_ACTIONS.includes(a))) { problems.push('keyboard.' + a + ': rejected'); continue; }", "if (!Array.isArray(list) || (list.length === 0 && CORE_ACTIONS.includes(a))) { problems.push('keyboard.' + a + ': rejected'); continue; }", 'storage/hostile-keyboard-entries-rejected'),
  U('storage-list-cap-removed', IN, 'if (!Array.isArray(list) || list.length > MAX_LIST || !list.every(isBindableKey) ||', 'if (!Array.isArray(list) || !list.every(isBindableKey) ||', 'storage/oversized-list-rejected'),
  U('storage-version-check-removed', IN, "if (doc.v !== SCHEMA_VERSION) return bad('unknown version');", '', 'storage/wrong-version-falls-back'),
  U('glyph-ignores-source', IN, 'const src = source || lastSource;', "const src = 'keyboard';", 'glyph/mouse-and-touch'),
  U('destroy-leaks-keyup-listener', IN, "listen(win, 'keyup', onKeyUp, { capture: true });", "if (win) win.addEventListener('keyup', onKeyUp, { capture: true });", 'destroy/removes-every-listener'),
  U('conflict-detection-off', IN, 'for (const a of ACTIONS) if (a !== action && listOf(device, a).includes(value)) out.push(a);', 'void 0;', 'rebind/conflict-detected'),
  U('reserved-tab-bindable', IN, "const RESERVED_CODES = new Set(['Tab', ", 'const RESERVED_CODES = new Set([', 'rebind/reserved-keys-refused'),
  U('wheel-direction-inverted', IN, 'const steps = Math.trunc(wheelAcc / TIMING.wheelStepPx);', 'const steps = -Math.trunc(wheelAcc / TIMING.wheelStepPx);', 'pointer/wheel-down-is-positive'),
  U('map-ignores-border', IN, 'const bl = cs ? n(cs.borderLeftWidth) + n(cs.paddingLeft) : 0,', 'const bl = 0,', 'map/border-offset-subtracted'),
  U('map-letterbox-offset-dropped', IN, "if (fit === 'contain' || fit === 'scale-down') {", 'if (false) {', 'map/letterbox-contain'),
  U('map-pixel-edge-unrounded', IN, 'const r6 = (v) => Math.round(v * 1e6) / 1e6;', 'const r6 = (v) => v;', 'map/pixel-edge-exact'),
  U('right-click-is-not-b', IN, 'if (wantContext) {', 'if (false) {', 'pointer/right-click-is-b'),
  U('contextmenu-not-suppressed', IN, "['contextmenu', wantContext ? ctx : () => {}]", "['contextmenu', () => {}]", 'pointer/contextmenu-suppressed'),
  U('right-release-ignored', IN, "if (e.pointerType !== 'touch' && e.button === 2) { if (entry.rcB) { const tk = entry.rcB; entry.rcB = false; dropHolder('b', tk); } return; }", "if (e.pointerType !== 'touch' && e.button === 2) { return; }", 'pointer/right-release-releases-b'),
  U('click-slop-huge', IN, 'clickSlopPx: 10,', 'clickSlopPx: 1000,', 'pointer/drag-is-not-click'),
  U('cursor-hides-at-300ms', IN, 'cursorIdleMs: 3000,', 'cursorIdleMs: 300,', ['cursor/not-hidden-at-2999ms', 'cursor/hides-at-3000ms']),
  U('trigger-bindings-swapped', IN, 'l: Object.freeze([4, 6]), r: Object.freeze([5, 7]),', 'l: Object.freeze([4, 7]), r: Object.freeze([5, 6]),', 'defaults/gamepad-buttons'),
  U('start-select-swapped', IN, 'select: Object.freeze([8]), start: Object.freeze([9]),', 'select: Object.freeze([9]), start: Object.freeze([8]),', 'defaults/gamepad-buttons'),
  U('capture-never-times-out', IN, "function tickCapture(t) { if (capture && t >= capture.deadline) finishCapture({ ok: false, reason: 'timeout' }); }", 'function tickCapture(t) {}', 'capture/times-out'),
  U('capture-escape-not-cancel', IN, "if (e.repeat) { e.preventDefault(); return; }\n    if (code === 'Escape') {", "if (e.repeat) { e.preventDefault(); return; }\n    if (false) {", 'capture/escape-cancels'),
  U('capture-swallows-tab', IN, "if (code === 'Tab') { finishCapture({ ok: false, reason: 'cancel' }); return; }", "if (code === 'Tab') { e.preventDefault(); finishCapture({ ok: false, reason: 'cancel' }); return; }", 'capture/tab-passes-through'),
  // the held button that STARTED a capture is protected twice (edge detection via info.prev, and capture.skip): only removing BOTH can let it be captured
  { id: 'capture-takes-the-starting-press', kind: 'unit', edits: [{ file: IN, find: "if (!capture.skip.has('g' + info.index + ':b' + j))", replace: 'if (true)' }, { file: IN, find: 'const was = !!info.prev[j];', replace: 'const was = false;' }], expect: ['capture/gamepad-held-start-button-skipped'] },
  U('pad-pointercancel-ignored', IN, "for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(el, t, end);", "for (const t of ['pointerup', 'lostpointercapture']) listen(el, t, end);", 'pad/pointercancel-releases'),
  U('getgamepads-before-user-action', IN, 'lastScanAt = -1e9, padsArmed = false;', 'lastScanAt = -1e9, padsArmed = true;', 'gamepad/no-getgamepads-before-user-action'),
  U('nav-score-ignores-cross-axis', NV, "score = Math.max(0, gap) + 2 * ogap + 0.5 * ocOut + 0.05 * oc; via = 'strict';", "score = Math.max(0, gap) + 0 * ogap + 0.5 * ocOut + 0.05 * oc; via = 'strict';", 'nav/choose-aligned-beats-nearer-misaligned'),
  U('nav-score-ignores-distance', NV, 'score = Math.max(0, gap) + 2 * ogap + 0.5 * ocOut + 0.05 * oc;', 'score = 0 + 2 * ogap + 0.5 * ocOut + 0.05 * oc;', 'nav/choose-nearest-aligned'),
  U('source-first-input-silent', IN, 'const first = !sourceKnown;', 'const first = false;', 'source/first-keyboard-input-announces-itself'),
  U('nav-score-centre-to-centre', NV, 'const ocOut = aligned ? 0 : Math.max(0, a.os - b.oc, b.oc - a.oe);', 'const ocOut = oc;', 'nav/choose-narrow-control-under-a-wide-one'),
  U('nav-direction-inverted', NV, "const along = dir === 'down' || dir === 'right' ? s : [-s[1], -s[0]];", "const along = dir === 'up' || dir === 'right' ? s : [-s[1], -s[0]];", 'nav/choose-direction-filter'),
  U('nav-loose-beats-strict', NV, 'score = 1000 + (b.ac - a.ac)', 'score = (b.ac - a.ac)', 'nav/choose-strict-beats-loose'),
  U('nav-big-step-is-small', NV, 'const delta = (o.big ? bigStep : step) * o.dir;', 'const delta = step * o.dir;', 'nav/step-big'),
  U('nav-step-not-clamped', NV, 'if (Number.isFinite(o.max)) v = Math.min(o.max, v);', '', 'nav/step-clamp-max'),
  U('nav-step-not-snapped', NV, 'v = base + Math.round((v - base) / step) * step;', '', 'nav/step-snaps-to-grid'),
  // browser-level: the focus ring, DOM navigation, dialogs, tabs, edit modes, ghost clicks
  B('ring-shown-under-mouse', 'ring', [{ file: 'input.css', find: 'html[data-input-source="keyboard"] :focus,\nhtml[data-input-source="gamepad"] :focus {', replace: 'html[data-input-source] :focus {' }, { file: 'input.css', find: 'html[data-input-source="mouse"] :focus,\nhtml[data-input-source="touch"] :focus { outline: none; }', replace: 'html[data-input-source="never"] :focus { outline: none; }' }], 'ring/hidden-under-mouse'),
  B('nav-tabs-step-from-the-selected-tab', 'navkbd', [{ file: NV, find: 'let idx = cur && list.contains(cur) ? tabs.indexOf(cur) : -1;', replace: 'let idx = -1;' }], 'nav/tabs-l-r'),
  B('nav-disabled-not-skipped', 'navkbd', [{ file: NV, find: 'if (el.disabled) return false;', replace: '' }], 'nav/skips-inert-disabled-hidden-zero-size-and-aria-hidden'),
  B('nav-zero-size-not-skipped', 'navkbd', [{ file: NV, find: 'if (!(r.width > 0 && r.height > 0)) return false;', replace: '' }], 'nav/skips-inert-disabled-hidden-zero-size-and-aria-hidden'),
  B('guard-number-input-arrows-taken', 'navkbd', [{ file: IN, find: "'range', 'reset', 'submit', 'hidden']);", replace: "'range', 'reset', 'submit', 'hidden', 'number']);" }], 'nav/kbd-arrows-keep-working-natively-on-a-number-input'),
  B('ring-source-never-updated', 'navkbd', [{ file: NV, find: "function onSource(ev) { doc.documentElement.setAttribute('data-input-source', ev.source); }", replace: 'function onSource(ev) { }' }], 'ring/keyboard-visible'),
  B('nav-skip-attribute-ignored', 'navkbd', [{ file: NV, find: "if (el.closest('[data-nav-skip], [inert], [hidden], fieldset[disabled], [aria-hidden=\"true\"]')) return false;", replace: "if (el.closest('[inert], [hidden], fieldset[disabled], [aria-hidden=\"true\"]')) return false;" }], 'nav/skip-attribute-honoured'),
  B('nav-modal-does-not-trap', 'navkbd', [{ file: NV, find: "x.getAttribute('aria-modal') === 'true' || x.hasAttribute('data-nav-modal')", replace: 'false' }], 'nav/dialog-traps-focus'),
  B('nav-tabs-l-goes-forward', 'navkbd', [{ file: NV, find: "if (act === 'l') { cycleTabs(-1); return; }", replace: "if (act === 'l') { cycleTabs(1); return; }" }], 'nav/tabs-l-r-q-goes-back'),
  B('nav-b-does-not-close-dialog', 'navkbd', [{ file: NV, find: 'function topDialog() { const d = dialogs(); return d.length ? d[d.length - 1] : null; }', replace: 'function topDialog() { return null; }' }], 'nav/b-closes-dialog'),
  B('nav-keyboard-enter-activates-twice', 'navkbd', [{ file: NV, find: "if (act === 'a') { if (ev.native) return; activate(ev); return; }", replace: "if (act === 'a') { activate(ev); return; }" }], 'nav/keyboard-enter-activates-once'),
  B('nav-range-right-decreases', 'navpad', [{ file: NV, find: "return numberStep(el, dir === 'right' || dir === 'up' ? 1 : -1, big);", replace: "return numberStep(el, dir === 'left' || dir === 'up' ? 1 : -1, big);" }], 'nav/range-edit-right-increases'),
  B('nav-range-has-no-edit-mode', 'navpad', [{ file: NV, find: "if (kind === 'range' || kind === 'number') { enterEdit(el, 'number'); return; }", replace: "if (kind === 'range' || kind === 'number') { el.click(); return; }" }], 'nav/range-edit-mode'),
  B('nav-typing-never-holds', 'navpad', [{ file: NV, find: "if (v === '') state.typing = false; else return;", replace: 'state.typing = false;' }], 'nav/text-typing-holds-nonempty'),
  B('nav-no-dom-order-fallback', 'navpad', [{ file: NV, find: 'if (fwd) target = others.find((c) => cur.compareDocumentPosition(c) & 4) || null;', replace: 'if (fwd) target = null;' }], 'nav/dom-order-fallback'),
  B('nav-select-has-no-cycle-fallback', 'navpad', [{ file: NV, find: "enterEdit(el, 'select'); return;", replace: 'return;' }], 'nav/select-cycle-fallback'),
  B('pad-ghost-click-not-prevented', 'touch', [{ file: IN, find: "listen(el, 'click', swallow);\n    listen(el, 'touchstart', touchstart, { passive: false });", replace: '' }], 'browser-touch/no-ghost-click-after-a-pad-tap'),
];

function copyTree(dst) {
  for (const f of MUT_FILES) { const to = path.join(dst, 'pokemonarena', f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(repo, 'pokemonarena', f), to); }
}
function applyEdits(dst, edits) {
  for (const e of edits) {
    const p = path.join(dst, 'pokemonarena', e.file); const s = fs.readFileSync(p, 'utf8'); const n = s.split(e.find).length - 1;
    if (n !== 1) return { applied: false, why: e.file + ': target text occurs ' + n + ' times: ' + e.find.slice(0, 70) };
    fs.writeFileSync(p, s.replace(e.find, () => e.replace));
    if (e.file.endsWith('.js')) { const c = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' }); if (c.status !== 0) return { applied: false, why: 'mutant does not parse: ' + (c.stderr || '').split('\n')[0] }; }
  }
  return { applied: true };
}
function runChild(args, env, timeoutMs) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args, '--json'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const m = /@@RESULT@@(.*)$/m.exec(r.stdout || '');
  let res = null; try { res = m ? JSON.parse(m[1]) : null; } catch (_e) { res = null; }
  return { res, status: r.status, tail: ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-6).join(' | ').slice(0, 400) };
}
function sweepTemp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }

async function mutantSuite() {
  const results = [];
  // the unmutated twin first: same harness, pristine copies, must be quiet
  const twinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-input-twin-'));
  copyTree(twinDir);
  const tu = runChild(['--unit'], { INPUT_SRC_ROOT: twinDir }, 300000);
  ok(tu.res && tu.res.fail === 0 && tu.res.pass > 300, 'mutants/unmutated-twin-is-quiet-unit', tu.res ? tu.res.failed : tu.tail);
  const twinPass = tu.res ? tu.res.pass : 0;
  const bgroups = Array.from(new Set(MUTANTS.filter((m) => m.kind === 'browser').flatMap((m) => m.groups.split(',')))).join(',');
  const tb = runChild(['--browser'], { INPUT_SRC_ROOT: twinDir, ARENA_GROUPS: bgroups }, 900000);
  ok(tb.res && tb.res.fail === 0 && tb.res.pass > 40, 'mutants/unmutated-twin-is-quiet-browser', tb.res ? tb.res.failed : tb.tail);
  sweepTemp(twinDir);
  console.log('  twin: unit ' + twinPass + ' checks, browser (' + bgroups + ') ' + (tb.res ? tb.res.pass : 0) + ' checks, both with 0 failures expected');
  let killed = 0;
  const only = process.env.ARENA_MUTANTS ? new Set(process.env.ARENA_MUTANTS.split(',')) : null;     // ARENA_MUTANTS=id,id : run just those
  for (const m of MUTANTS) {
    if (only && !only.has(m.id)) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-input-mut-'));
    let row;
    try {
      copyTree(dir);
      const ap = applyEdits(dir, m.edits);
      if (!ap.applied) row = { id: m.id, state: 'NOT-APPLIED', why: ap.why };
      else {
        const env = { INPUT_SRC_ROOT: dir };
        if (m.kind === 'browser') { env.ARENA_GROUPS = m.groups; env.ARENA_STOP_ON = m.expect[0]; }
        const c = m.kind === 'unit' ? runChild(['--unit'], env, 300000) : runChild(['--browser'], env, 600000);
        if (!c.res) row = { id: m.id, state: 'HARNESS-CRASH', why: c.tail };
        else {
          const hit = m.expect.find((n) => c.res.failed.includes(n));
          row = hit ? { id: m.id, state: 'KILLED', by: hit, others: c.res.failed.filter((n) => n !== hit).length } : { id: m.id, state: c.res.failed.length ? 'KILLED-BY-OTHER-CHECK' : 'SURVIVED', why: c.res.failed.slice(0, 4).join(', ') };
        }
      }
    } finally { sweepTemp(dir); }
    results.push(row);
    if (row.state === 'KILLED') killed++;
    console.log('  mutant ' + row.id.padEnd(38) + ' ' + row.state + (row.by ? '  by ' + row.by + (row.others ? ' (+' + row.others + ' more)' : '') : '') + (row.why ? '  ' + row.why : ''));
    ok(row.state === 'KILLED', 'mutant/' + m.id + '/killed-by-' + m.expect[0], row.why || row.state);
  }
  console.log('mutants: ' + killed + ' of ' + MUTANTS.length + ' killed by their named check');
  return { killed, total: MUTANTS.length, results };
}

/* ============================================================================================================= main */
function report(label) {
  console.log('\n' + label + ': ' + pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('FAILED: ' + failed.join(', '));
  if (JSON_OUT) console.log('@@RESULT@@' + JSON.stringify({ pass, fail, failed }));
}
async function main() {
  console.log('pokemonarena input test; sources ' + SRC + '; node ' + process.version + '; ' + os.cpus().length + ' cpus; load ' + os.loadavg().map((x) => x.toFixed(2)).join('/'));
  try {
    if (ARGS.has('--unit')) { await unitSuite(); report('unit'); }
    else if (ARGS.has('--browser')) { try { await browserSuite(); } catch (e) { if (!(e instanceof StopEarly)) throw e; } report('browser'); }
    else {
      const u = await unitSuite(); console.log('unit: ' + u.pass + ' passed, ' + u.fail + ' failed');
      const before = { pass, fail };
      if (!ARGS.has('--no-browser')) { await browserSuite(); console.log('browser: ' + (pass - before.pass) + ' passed, ' + (fail - before.fail) + ' failed'); }
      if (!ARGS.has('--no-mutants')) { const b2 = { pass, fail }; const mr = await mutantSuite(); console.log('mutants: ' + (pass - b2.pass) + ' passed, ' + (fail - b2.fail) + ' failed (' + mr.killed + '/' + mr.total + ' killed)'); }
      report('TOTAL');
    }
  } catch (e) { console.log('SUITE CRASHED: ' + (e && e.stack || e)); fail++; failed.push('suite-crashed'); report('crashed'); process.exit(2); }
  process.exit(fail ? 1 : 0);
}
await main();
