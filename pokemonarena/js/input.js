// pokemonarena/js/input.js -- the ONE input layer for Pokemon Arena: keyboard, mouse, touch and gamepad all become the same
// twelve ACTIONS, on every screen, and the player can switch between devices at any moment.
//
//   ACTIONS: up down left right  a (confirm)  b (cancel/back)  x (info)  y (filter)  l r (tab / page)  start (menu)  select (toggle info)
//
// This module is import-safe in Node: nothing touches window/document/navigator at import time, and every environment
// dependency is injectable (createInput({ target, document, now, getGamepads, storage, raf })). The API, the default binding
// tables and the exact wiring snippets live in pokemonarena/INPUT.md.
//
// Design rules that cost something to learn (see INPUT.md "Why it behaves like this"):
//   * Keyboard is KeyboardEvent.code based; a key is never swallowed on a text-editing target or with ctrl/meta/alt held.
//   * OS auto-repeat (e.repeat) is ignored; directional actions get their OWN repeat (400 ms, then every 90 ms) from the injected
//     clock, so keyboard, stick and d-pad repeat identically. A and B never repeat (isDown() exposes the hold).
//   * An action is held while ANY holder holds it (two keys, d-pad + stick, finger + key): it releases when the last one lets go.
//   * Every held action releases on blur, visibilitychange, pagehide, gamepad disconnect and setEnabled(false): no stuck inputs.
//   * Storage is optional and hostile-input safe: the layer works with storage absent, throwing or full of garbage.
//   * Nothing here calls navigator.getGamepads() before the visitor has acted (consoles prompt on first use, see lib/xboxinput.js).

export const ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']);
export const DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);
export const SOURCES = Object.freeze(['keyboard', 'mouse', 'touch', 'gamepad']);
export const STORAGE_KEY = 'arena.bindings';
export const SCHEMA_VERSION = 1;

export const ACTION_LABELS = Object.freeze({
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', a: 'Confirm', b: 'Back', x: 'Info', y: 'Filter',
  l: 'Previous tab', r: 'Next tab', start: 'Menu', select: 'Toggle info',
});

export const TIMING = Object.freeze({
  repeatDelayMs: 400,        // first synthesized repeat of a held direction
  repeatIntervalMs: 90,      // every one after that
  stickEnter: 0.5,           // a stick direction ENGAGES at |axis| >= this
  stickExit: 0.35,           // ...and RELEASES when |axis| < this (hysteresis: 0.35 .. 0.5 keeps it held)
  cursorIdleMs: 3000,        // canvas cursor hides after this long without a move
  captureTimeoutMs: 8000,    // press-to-bind gives up after this long (a pad-only player must never be trapped)
  wheelStepPx: 100,          // one wheel notch (Chrome: deltaY 100) = one menu step; trackpad deltas accumulate
  clickSlopPx: 10,           // down+up closer than this (CSS px) is a click
  scrollIntervalMs: 140,     // right-stick list scrolling rate
  padScanMs: 1000,           // minimum gap between opportunistic getGamepads() scans (key press / click)
  padEscapeMs: 2000,         // W1 fix A1: Start + Select held together this long put the controller bindings back to the defaults (an escape that cannot be bound away)
});

/* ------------------------------------------------------------------------------------------- default bindings */

// Keyboard (KeyboardEvent.code). Shift-free: nothing needs a modifier.
export const DEFAULT_KEYS = Object.freeze({
  up: Object.freeze(['ArrowUp', 'KeyW']), down: Object.freeze(['ArrowDown', 'KeyS']),
  left: Object.freeze(['ArrowLeft', 'KeyA']), right: Object.freeze(['ArrowRight', 'KeyD']),
  a: Object.freeze(['KeyZ', 'Enter', 'Space', 'NumpadEnter']), b: Object.freeze(['KeyX', 'Backspace', 'Escape']),
  x: Object.freeze(['KeyC']), y: Object.freeze(['KeyV']),
  l: Object.freeze(['KeyQ', 'PageUp']), r: Object.freeze(['KeyE', 'PageDown']),
  start: Object.freeze(['KeyP']), select: Object.freeze(['KeyI']),
});

// Gamepad, W3C Standard layout button indexes. The face buttons depend on the controller family (see padLayoutFor).
const PAD_COMMON = Object.freeze({
  up: Object.freeze([12]), down: Object.freeze([13]), left: Object.freeze([14]), right: Object.freeze([15]),
  l: Object.freeze([4, 6]), r: Object.freeze([5, 7]),        // LB/RB, and the triggers as alternates
  select: Object.freeze([8]), start: Object.freeze([9]),      // back/view, start/menu
});
export const PAD_LAYOUTS = Object.freeze({
  xbox: Object.freeze({ ...PAD_COMMON, a: Object.freeze([0]), b: Object.freeze([1]), x: Object.freeze([2]), y: Object.freeze([3]) }),
  // A Nintendo pad labels the EAST button A and the SOUTH button B, and puts X on the north, Y on the west.
  nintendo: Object.freeze({ ...PAD_COMMON, a: Object.freeze([1]), b: Object.freeze([0]), x: Object.freeze([3]), y: Object.freeze([2]) }),
});

const NINTENDO_RE = /nintendo|switch|pro controller|057e|joy-?con/i;
const PLAYSTATION_RE = /playstation|dualshock|dualsense|054c|sony|ps[3-5] controller/i;
export function padFamily(id) {
  const s = String(id || '');
  if (NINTENDO_RE.test(s)) return 'nintendo';
  if (PLAYSTATION_RE.test(s)) return 'playstation';
  if (/xbox|xinput|microsoft|045e/i.test(s)) return 'xbox';
  return 'generic';
}
// Which default face-button table a controller gets. PlayStation and unknown pads follow the Xbox arrangement (south = confirm).
export function padLayoutFor(id) { return padFamily(id) === 'nintendo' ? 'nintendo' : 'xbox'; }

// Human names for the Standard layout button indexes, per family (used by glyph()).
const PAD_NAMES = Object.freeze({
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Guide'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'PS'],
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '-', '+', 'L stick', 'R stick', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'],
});
export function padButtonName(family, index) {
  const names = PAD_NAMES[family] || PAD_NAMES.xbox;
  const n = names[index];
  if (!n) return 'Button ' + index;
  const face = index <= 3 && family !== 'playstation';
  return face ? n + ' button' : n;
}

/* ------------------------------------------------------------------------------------------------- key helpers */

const KEY_TO_CODE = Object.freeze({
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', ' ': 'Space',
  Backspace: 'Backspace', Escape: 'Escape', PageUp: 'PageUp', PageDown: 'PageDown', Tab: 'Tab', Home: 'Home', End: 'End',
});
// KeyboardEvent.code, falling back to .key for virtual keyboards / old WebViews that report code '' or 'Unidentified'.
export function codeOf(e) {
  const c = e && e.code;
  if (c && c !== 'Unidentified') return String(c);
  const k = e && e.key;
  if (typeof k !== 'string' || !k) return '';
  if (Object.prototype.hasOwnProperty.call(KEY_TO_CODE, k)) return KEY_TO_CODE[k];
  if (k.length === 1) {
    const u = k.toUpperCase();
    if (u >= 'A' && u <= 'Z') return 'Key' + u;
    if (u >= '0' && u <= '9') return 'Digit' + u;
  }
  return '';
}

const RESERVED_CODES = new Set(['Tab', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  'ContextMenu', 'CapsLock', 'NumLock', 'ScrollLock', 'Pause', 'PrintScreen', 'Unidentified', 'Fn', 'FnLock']);
// Codes a player may bind. Tab and the modifiers are refused (Tab / Shift+Tab must keep working, and a modifier alone is not a key press
// the layer would see as a binding), as are F1..F24 (browser and OS shortcuts).
export function isBindableKey(code) {
  if (typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(code)) return false;
  if (RESERVED_CODES.has(code)) return false;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return false;
  return true;
}

const CODE_LABELS = Object.freeze({
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', NumpadEnter: 'Num Enter', Space: 'Space',
  Backspace: 'Backspace', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down', Home: 'Home', End: 'End', Delete: 'Delete', Insert: 'Insert',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
});
export function codeLabel(code, layoutMap) {
  if (layoutMap && typeof layoutMap.get === 'function') { try { const v = layoutMap.get(code); if (typeof v === 'string' && v) return v.length === 1 ? v.toUpperCase() : v; } catch (_e) { /* fall through */ } }
  if (Object.prototype.hasOwnProperty.call(CODE_LABELS, code)) return CODE_LABELS[code];
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code); if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code); if (m) return 'Num ' + m[1];
  return String(code);
}

/* ------------------------------------------------------------------------------------ text-target / native-key guard */

const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit', 'hidden']);
const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const RANGE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

// Is this a place where the player is typing (or choosing from a native control that owns every key)?
export function isTextTarget(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.isContentEditable === true) return true;
  const tag = String(t.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUT.has(String(t.type || 'text').toLowerCase());
  return false;
}

// What does a key do NATIVELY on this target?
//   'skip'   -> the browser needs the key (typing, a select, arrows on a range / radio): the layer must not even see it
//   'native' -> the browser activates the control on it (Enter on a button, Space on a checkbox): the layer reports the action with
//               native:true and does NOT preventDefault, so the click happens exactly once
//   'none'   -> the browser does nothing useful with it: the layer consumes it (preventDefault)
export function nativeUse(t, key, code) {
  if (!t || typeof t !== 'object') return 'none';
  if (isTextTarget(t)) return 'skip';
  const tag = String(t.tagName || '').toUpperCase();
  const enter = key === 'Enter' || code === 'Enter' || code === 'NumpadEnter';
  const space = key === ' ' || code === 'Space';
  if (tag === 'INPUT') {
    const type = String(t.type || 'text').toLowerCase();
    if (type === 'range') return RANGE_KEYS.has(code) ? 'skip' : 'none';
    if (type === 'radio') return ARROW_KEYS.has(code) ? 'skip' : space ? 'native' : 'none';
    if (type === 'checkbox') return space ? 'native' : 'none';
    return enter || space ? 'native' : 'none';     // button, submit, reset, image, file, color
  }
  if (tag === 'BUTTON' || tag === 'SUMMARY') return enter || space ? 'native' : 'none';
  if (tag === 'A' && typeof t.hasAttribute === 'function' && t.hasAttribute('href')) return enter ? 'native' : 'none';   // Space on a link scrolls: consume it
  return 'none';
}

/* ----------------------------------------------------------------------------------------- stick and wheel helpers */

// One stick -> at most ONE of up/down/left/right, with hysteresis. `prev` is the direction currently held (or null).
//   engage when the dominant axis reaches `enter`; stay held while the held axis is >= `exit`; a diagonal resolves to the dominant axis,
//   and a held direction hands over to the other axis only when that axis is past `enter` AND larger.
export function resolveStick(prev, ax, ay, enter = TIMING.stickEnter, exit = TIMING.stickExit) {
  const x = Number(ax) || 0, y = Number(ay) || 0;
  const axx = Math.abs(x), ayy = Math.abs(y);
  const dirOf = (axis) => (axis === 'x' ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'up' : 'down'));
  if (prev) {
    const horiz = prev === 'left' || prev === 'right';
    const mine = horiz ? x : y;
    const sign = prev === 'left' || prev === 'up' ? -1 : 1;
    if (mine * sign >= exit) {
      const other = horiz ? ayy : axx, own = Math.abs(mine);
      if (other >= enter && other > own) return dirOf(horiz ? 'y' : 'x');
      return prev;
    }
  }
  const dom = axx >= ayy ? 'x' : 'y';
  const v = dom === 'x' ? axx : ayy;
  return v >= enter ? dirOf(dom) : null;
}
// One axis -> -1 / 0 / +1 with the same hysteresis (the right stick's scroll).
export function resolveAxis(prev, v, enter = TIMING.stickEnter, exit = TIMING.stickExit) {
  const x = Number(v) || 0;
  if (prev) { if (x * prev >= exit) return prev; }
  if (Math.abs(x) >= enter) return x < 0 ? -1 : 1;
  return 0;
}

/* ------------------------------------------------------------------------------------------- stored bindings (pure) */

const MAX_STORED_CHARS = 20000;
const MAX_LIST = 6;
const MAX_BUTTON_INDEX = 63;
// W1 fix A1: the actions a screen cannot be driven without. None of them may be left with NO binding (a conflict answered with "use it here only", a removed chip, or a
// stored list that is empty would otherwise strand a player who has only that device: with no button for A the controller can no longer press Reset).
const CORE_ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'a', 'b']);
const LAYOUT_CHOICES = Object.freeze(['auto', 'xbox', 'nintendo']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Parse + validate whatever is in storage. NEVER throws. Returns { ok, keyboard, buttons, layout, problems }.
//   ok === false  -> the document as a whole is unusable (bad JSON, wrong shape, wrong version): the caller falls back to defaults
//   ok === true   -> keyboard / buttons hold only the entries that validated; each rejected piece is listed in `problems`
export function parseStoredBindings(text) {
  const bad = (why) => ({ ok: false, keyboard: {}, buttons: {}, layout: 'auto', problems: [why] });
  if (typeof text !== 'string') return bad('not a string');
  if (text.length > MAX_STORED_CHARS) return bad('too large');
  let doc;
  try { doc = JSON.parse(text); } catch (_e) { return bad('not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('not an object');
  if (doc.v !== SCHEMA_VERSION) return bad('unknown version');
  const problems = [], keyboard = {}, buttons = {};
  let layout = 'auto';
  const kb = own(doc, 'keyboard') ? doc.keyboard : undefined;
  if (kb !== undefined) {
    if (!kb || typeof kb !== 'object' || Array.isArray(kb)) problems.push('keyboard: not an object');
    else for (const a of ACTIONS) {                       // iterate OUR names, never the hostile object's keys
      if (!own(kb, a)) continue;
      const list = kb[a];
      if (!Array.isArray(list) || list.length > MAX_LIST || !list.every(isBindableKey) || (list.length === 0 && CORE_ACTIONS.includes(a))) { problems.push('keyboard.' + a + ': rejected'); continue; }
      keyboard[a] = Array.from(new Set(list));
    }
  }
  const gp = own(doc, 'gamepad') ? doc.gamepad : undefined;
  if (gp !== undefined) {
    if (!gp || typeof gp !== 'object' || Array.isArray(gp)) problems.push('gamepad: not an object');
    else {
      if (own(gp, 'layout')) { if (LAYOUT_CHOICES.includes(gp.layout)) layout = gp.layout; else problems.push('gamepad.layout: rejected'); }
      const bt = own(gp, 'buttons') ? gp.buttons : undefined;
      if (bt !== undefined) {
        if (!bt || typeof bt !== 'object' || Array.isArray(bt)) problems.push('gamepad.buttons: not an object');
        else for (const a of ACTIONS) {
          if (!own(bt, a)) continue;
          const list = bt[a];
          if (!Array.isArray(list) || list.length > MAX_LIST || !list.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_BUTTON_INDEX) || (list.length === 0 && CORE_ACTIONS.includes(a))) { problems.push('gamepad.buttons.' + a + ': rejected'); continue; }
          buttons[a] = Array.from(new Set(list));
        }
      }
    }
  }
  return { ok: true, keyboard, buttons, layout, problems };
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------------------------------------------------------------------ pointer -> logical */

// Returns toLocal(clientX, clientY) -> { x, y, px, py, inside } for an element whose drawn image is logicalW x logicalH pixels.
// Exact under whole-pixel CSS scaling and under letterboxing (object-fit: contain / cover / none, centred), and it subtracts the
// element's border and padding (a 2 px canvas border otherwise shifts every hit by 2 logical pixels at 1x).
export function mapClientToLogical(el, logicalW, logicalH) {
  return function toLocal(clientX, clientY) {
    const rect = el.getBoundingClientRect();
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
    const cs = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    const n = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : 0; };
    const bl = cs ? n(cs.borderLeftWidth) + n(cs.paddingLeft) : 0, br = cs ? n(cs.borderRightWidth) + n(cs.paddingRight) : 0;
    const bt = cs ? n(cs.borderTopWidth) + n(cs.paddingTop) : 0, bb = cs ? n(cs.borderBottomWidth) + n(cs.paddingBottom) : 0;
    const cw = rect.width - bl - br, ch = rect.height - bt - bb;
    const fit = (cs && cs.objectFit) || 'fill';
    let sx = cw / logicalW, sy = ch / logicalH, ox = 0, oy = 0;
    if (fit === 'contain' || fit === 'scale-down') {
      let s = Math.min(sx, sy); if (fit === 'scale-down') s = Math.min(s, 1);
      sx = sy = s; ox = (cw - logicalW * s) / 2; oy = (ch - logicalH * s) / 2;
    } else if (fit === 'cover') {
      const s = Math.max(sx, sy); sx = sy = s; ox = (cw - logicalW * s) / 2; oy = (ch - logicalH * s) / 2;
    } else if (fit === 'none') {
      sx = sy = 1; ox = (cw - logicalW) / 2; oy = (ch - logicalH) / 2;
    }
    const r6 = (v) => Math.round(v * 1e6) / 1e6;          // keep a pixel EDGE on the right side of floor()
    const x = r6((clientX - rect.left - bl - ox) / sx), y = r6((clientY - rect.top - bt - oy) / sy);
    return { x, y, px: Math.floor(x), py: Math.floor(y), inside: x >= 0 && y >= 0 && x < logicalW && y < logicalH };
  };
}

/* =================================================================================================== createInput */

export function createInput(opts = {}) {
  const win = opts.target !== undefined ? opts.target : (typeof window !== 'undefined' ? window : null);
  const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
  const now = typeof opts.now === 'function' ? opts.now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const readPadsRaw = typeof opts.getGamepads === 'function' ? opts.getGamepads
    : () => (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []);
  let storage = null;
  if (opts.storage !== undefined) storage = opts.storage;
  else { try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (_e) { storage = null; } }
  const storageKey = opts.storageKey || STORAGE_KEY;
  // The self-poll loop (so a page that never calls poll() still gets repeats and pad input). raf: null turns it off (tests).
  const raf = opts.raf === null ? null : typeof opts.raf === 'function' ? opts.raf
    : (typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(() => fn(now()), 16));
  const caf = opts.raf === null ? null : typeof opts.caf === 'function' ? opts.caf
    : (typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(h) : (h) => clearTimeout(h));
  let layoutMap = opts.layoutMap || null;
  if (!layoutMap && opts.layoutMap !== null && typeof navigator !== 'undefined' && navigator.keyboard && typeof navigator.keyboard.getLayoutMap === 'function') {
    try { navigator.keyboard.getLayoutMap().then((m) => { layoutMap = m; }, () => {}); } catch (_e) { /* best effort */ }
  }

  let destroyed = false, enabled = true;
  let lastSource = 'keyboard', sourceKnown = false;
  let extPollAt = -1e9, lastScanAt = -1e9, padsArmed = false;
  let loopHandle = null;
  const regs = [];                                         // [target, type, fn, options] -> removed by destroy()
  const subs = { action: new Set(), pointer: new Set(), device: new Set(), source: new Set(), bindings: new Set(), capture: new Set(), raw: new Set() };

  function listen(t, type, fn, options) {
    if (!t || typeof t.addEventListener !== 'function') return;
    t.addEventListener(type, fn, options);
    regs.push([t, type, fn, options]);
  }
  function emit(type, ev) {
    let handled = false;
    for (const cb of Array.from(subs[type])) {
      try { if (cb(ev) === true) handled = true; } catch (err) { if (typeof console !== 'undefined') console.error('[input] listener failed:', err); }
    }
    return handled;
  }
  function on(type, cb) {
    if (!subs[type]) throw new Error('unknown event type: ' + type);
    if (typeof cb !== 'function') throw new Error('on(type, cb): cb must be a function');
    subs[type].add(cb);
    return () => subs[type].delete(cb);
  }
  function off(type, cb) { if (subs[type]) subs[type].delete(cb); }

  /* ------------------------------------------------------------------------------------------------- bindings */
  let kbOv = {}, padOv = {}, layoutSel = 'auto', storeStatus = storage ? 'default' : 'absent', storeProblems = [], persisted = false;
  let codeMap = new Map(), padMaps = { xbox: new Map(), nintendo: new Map() };

  const effKb = (a) => (own(kbOv, a) ? kbOv[a] : DEFAULT_KEYS[a]);
  const effPad = (a, layout) => (own(padOv, a) ? padOv[a] : PAD_LAYOUTS[layout][a]);
  function rebuildMaps() {
    codeMap = new Map();
    for (const a of ACTIONS) for (const c of effKb(a)) { const l = codeMap.get(c); if (l) l.push(a); else codeMap.set(c, [a]); }
    for (const layout of ['xbox', 'nintendo']) {
      const m = new Map();
      for (const a of ACTIONS) for (const i of effPad(a, layout)) { const l = m.get(i); if (l) l.push(a); else m.set(i, [a]); }
      padMaps[layout] = m;
    }
  }
  function loadStore() {
    kbOv = {}; padOv = {}; layoutSel = 'auto'; storeProblems = [];
    if (!storage) storeStatus = 'absent';
    else {
      let text = null, readOk = true;
      try { text = storage.getItem(storageKey); } catch (_e) { readOk = false; }
      if (!readOk) { storeStatus = 'error'; storeProblems.push('storage read failed'); }
      else if (text === null || text === undefined) storeStatus = 'default';
      else {
        const r = parseStoredBindings(text);
        storeProblems = r.problems;
        if (!r.ok) storeStatus = 'invalid';
        else { kbOv = r.keyboard; padOv = r.buttons; layoutSel = r.layout; storeStatus = r.problems.length ? 'repaired' : 'loaded'; }
      }
    }
    rebuildMaps();
  }
  function saveStore() {
    persisted = false;
    if (!storage) return;
    try {
      const custom = Object.keys(kbOv).length || Object.keys(padOv).length || layoutSel !== 'auto';
      if (!custom) storage.removeItem(storageKey);
      else storage.setItem(storageKey, JSON.stringify({ v: SCHEMA_VERSION, keyboard: kbOv, gamepad: { layout: layoutSel, buttons: padOv } }));
      persisted = true;
    } catch (_e) { persisted = false; }
  }
  function changed(what) { rebuildMaps(); saveStore(); emit('bindings', { type: 'bindings', what }); }

  let lastPad = null;                                       // the pad that last produced input (glyphs, conflict layout)
  const resolvedLayout = () => (layoutSel !== 'auto' ? layoutSel : lastPad ? padLayoutFor(lastPad.id) : 'xbox');
  const validValue = (device, v) => (device === 'keyboard' ? isBindableKey(v) : Number.isInteger(v) && v >= 0 && v <= MAX_BUTTON_INDEX);
  const listOf = (device, a) => (device === 'keyboard' ? effKb(a) : effPad(a, resolvedLayout())).slice();
  function commit(device, a, list) {
    const uniq = Array.from(new Set(list)).slice(0, MAX_LIST);
    if (device === 'keyboard') { if (sameList(uniq, DEFAULT_KEYS[a])) delete kbOv[a]; else kbOv[a] = uniq; } else padOv[a] = uniq;
  }
  function conflictsFor(device, action, value) {
    const out = [];
    for (const a of ACTIONS) if (a !== action && listOf(device, a).includes(value)) out.push(a);
    return out;
  }
  const bindings = {
    status: () => ({ status: storeStatus, problems: storeProblems.slice(), persisted, hasStorage: !!storage }),
    layout: () => layoutSel,
    resolvedLayout,
    get() {
      const kb = {}, pad = {}, layout = resolvedLayout();
      for (const a of ACTIONS) { kb[a] = effKb(a).slice(); pad[a] = effPad(a, layout).slice(); }
      return { keyboard: kb, gamepad: { layout: layoutSel, resolved: layout, buttons: pad, overrides: JSON.parse(JSON.stringify(padOv)) },
        customized: { keyboard: Object.keys(kbOv).length > 0, gamepad: Object.keys(padOv).length > 0 || layoutSel !== 'auto' } };
    },
    defaults: (device, layout = 'xbox') => { const o = {}; for (const a of ACTIONS) o[a] = (device === 'keyboard' ? DEFAULT_KEYS[a] : PAD_LAYOUTS[layout][a]).slice(); return o; },
    conflicts: (device, action, value) => conflictsFor(device, action, value),
    // Replace one action's whole list (no conflict handling: this is the low-level setter; the panel uses rebind()).
    set(device, action, list) {
      if (!ACTIONS.includes(action) || (device !== 'keyboard' && device !== 'gamepad') || !Array.isArray(list) || list.length > MAX_LIST || !list.every((v) => validValue(device, v)) || (list.length === 0 && CORE_ACTIONS.includes(action))) return { ok: false, reason: 'invalid' };
      commit(device, action, list); changed(device); return { ok: true };
    },
    // Rebind ONE slot (slot = index into the action's list; a slot past the end appends). onConflict: 'reject' (default) | 'swap' | 'move'.
    rebind(device, action, slot, value, o = {}) {
      if (!ACTIONS.includes(action) || (device !== 'keyboard' && device !== 'gamepad') || !validValue(device, value)) return { ok: false, reason: 'invalid' };
      const list = listOf(device, action);
      const prev = Number.isInteger(slot) && slot >= 0 && slot < list.length ? list[slot] : null;
      if (prev === value) return { ok: true, unchanged: true, conflicts: [] };
      if (prev === null && list.length >= MAX_LIST) return { ok: false, reason: 'full' };
      const conflicts = conflictsFor(device, action, value);
      const mode = o.onConflict || 'reject';
      if (conflicts.length && mode === 'reject') return { ok: false, reason: 'conflict', conflicts };
      // W1 fix A1: work out what the other actions would be left with BEFORE changing anything; one that would be left with nothing, and that the UI cannot do without, refuses the whole change
      const after = new Map();
      for (const c of conflicts) {
        let cl = listOf(device, c);
        cl = mode === 'swap' && prev !== null ? cl.map((v) => (v === value ? prev : v)) : cl.filter((v) => v !== value);
        after.set(c, cl);
      }
      for (const [c, cl] of after) if (cl.length === 0 && CORE_ACTIONS.includes(c)) return { ok: false, reason: 'would-empty', conflicts: [c] };
      if (prev !== null) list[slot] = value; else list.push(value);
      commit(device, action, list);
      for (const [c, cl] of after) commit(device, c, cl);
      changed(device);
      return { ok: true, conflicts, mode: conflicts.length ? mode : null };
    },
    remove(device, action, slot) {
      const list = listOf(device, action);
      if (!(slot >= 0 && slot < list.length)) return { ok: false, reason: 'invalid' };
      if (list.length === 1 && CORE_ACTIONS.includes(action)) return { ok: false, reason: 'last' };          // W1 fix A1: the last binding of a core action stays
      list.splice(slot, 1); commit(device, action, list); changed(device); return { ok: true };
    },
    setLayout(l) { if (!LAYOUT_CHOICES.includes(l)) return false; layoutSel = l; changed('layout'); return true; },
    reset(device = 'all') {
      if (device === 'keyboard' || device === 'all') kbOv = {};
      if (device === 'gamepad' || device === 'all') { padOv = {}; layoutSel = 'auto'; }
      changed(device);
    },
    reload() { loadStore(); emit('bindings', { type: 'bindings', what: 'reload' }); },
  };
  loadStore();

  /* ------------------------------------------------------------------------------------- held actions + source */
  const holders = new Map();                                // action -> Map(token -> source)
  const reps = new Map();                                   // direction action -> { next }
  const meta = new Map();                                   // action -> { code?, button?, native? } of the press that engaged it
  let capture = null;

  // lastSource starts as 'keyboard' (a sensible glyph default) but NOTHING has been observed yet, so the FIRST real input must announce
  // itself even when it is a keyboard press: uinav.js draws the focus ring from this event, and without it the very first Arrow-key press
  // on a page moved focus with no ring (data-input-source stayed "none").
  function noteSource(src) {
    const first = !sourceKnown;
    sourceKnown = true;
    if (src === lastSource && !first) return;
    const previous = first ? null : lastSource; lastSource = src;
    emit('source', { type: 'source', source: src, previous });
  }
  const isHeld = (a) => { const h = holders.get(a); return !!h && h.size > 0; };
  function addHolder(action, token, source, m) {
    if (capture || !enabled || destroyed) return;
    let h = holders.get(action);
    if (!h) { h = new Map(); holders.set(action, h); }
    if (h.has(token)) return;
    const was = h.size > 0;
    h.set(token, source);
    noteSource(source);
    if (was) return;
    meta.set(action, m || {});
    if (DIRECTIONS.includes(action)) reps.set(action, { next: now() + TIMING.repeatDelayMs });
    emit('action', Object.assign({ type: 'action', action, pressed: true, repeat: false, source, time: now() }, m || {}));
    kick();
  }
  function dropHolder(action, token) {
    const h = holders.get(action);
    if (!h || !h.delete(token)) return;
    if (h.size > 0) return;
    holders.delete(action); reps.delete(action);
    const m = meta.get(action) || {}; meta.delete(action);
    emit('action', Object.assign({ type: 'action', action, pressed: false, repeat: false, source: lastSource, time: now() }, m.code ? { code: m.code } : {}, m.button !== undefined ? { button: m.button } : {}));
  }
  function dropToken(token) { for (const a of Array.from(holders.keys())) dropHolder(a, token); }
  function releaseAll(reason) {
    for (const a of Array.from(holders.keys())) {
      const h = holders.get(a); if (!h) continue;
      for (const tk of Array.from(h.keys())) dropHolder(a, tk);
    }
    holders.clear(); reps.clear(); meta.clear();
    consumed.clear(); wheelAcc = 0;
    for (const b of padBinders) b.reset();
    for (const e of targets) { e.rcB = false; }
    if (reason && typeof opts.onRelease === 'function') { try { opts.onRelease(reason); } catch (_e) { /* ignore */ } }
  }
  function press(action, o) {
    if (!ACTIONS.includes(action)) return false;
    const source = typeof o === 'string' ? o : (o && o.source) || 'touch';
    const token = (o && typeof o === 'object' && o.token) || 'api:' + source;
    addHolder(action, token, source, o && typeof o === 'object' ? o.meta : undefined);
    return true;
  }
  function release(action, o) {
    const source = typeof o === 'string' ? o : (o && o.source) || 'touch';
    const token = (o && typeof o === 'object' && o.token) || 'api:' + source;
    dropHolder(action, token);
  }
  const isDown = (a) => isHeld(a);

  /* ---------------------------------------------------------------------------------------------- keyboard */
  const consumed = new Set();                               // codes whose keydown we preventDefault-ed (their keyup is too)
  const evTarget = (e) => { try { const p = typeof e.composedPath === 'function' ? e.composedPath() : null; if (p && p.length) return p[0]; } catch (_e) { /* ignore */ } return e.target; };
  const MODIFIER_ONLY = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock']);

  function onKeyDown(e) {
    if (!enabled || destroyed) return;
    const code = codeOf(e);
    if (code && !MODIFIER_ONLY.has(code) && !e.isComposing) { noteSource('keyboard'); maybeScan(true); }
    if (e.defaultPrevented) return;                         // an inner component already handled this key
    if (e.ctrlKey || e.metaKey || e.altKey) return;         // browser shortcuts, AltGr: never ours
    if (e.isComposing || e.keyCode === 229) return;         // IME composition
    if (!code) return;
    if (capture) { if (capture.device === 'keyboard') keyCapture(e, code); else if (code === 'Escape') { e.preventDefault(); finishCapture({ ok: false, reason: 'cancel' }); } return; }
    const acts = codeMap.get(code) || [];
    const mode = nativeUse(evTarget(e), e.key, code);
    if (mode === 'skip') return;
    if (!e.repeat && !MODIFIER_ONLY.has(code)) emit('raw', { type: 'raw', device: 'keyboard', value: code, label: codeLabel(code, layoutMap) });
    if (!acts.length) return;
    if (e.repeat) { if (mode === 'none' && consumed.has(code)) e.preventDefault(); return; }   // OS auto-repeat: ignored (the layer repeats on its own clock)
    const token = 'k:' + code;
    const m = { code, source: 'keyboard' }; if (mode === 'native') m.native = true;
    for (const a of acts) addHolder(a, token, 'keyboard', m);
    if (mode === 'none') { e.preventDefault(); consumed.add(code); }
  }
  function onKeyUp(e) {
    const code = codeOf(e);
    if (consumed.delete(code)) { try { e.preventDefault(); } catch (_e) { /* ignore */ } }   // Firefox clicks a button on Space keyup even if keydown was prevented
    if (code) dropToken('k:' + code);
  }
  function keyCapture(e, code) {
    if (e.repeat) { e.preventDefault(); return; }
    if (code === 'Escape') { e.preventDefault(); finishCapture({ ok: false, reason: 'cancel' }); return; }
    if (code === 'Tab') { finishCapture({ ok: false, reason: 'cancel' }); return; }       // let Tab through: the player is moving on
    e.preventDefault();
    if (!isBindableKey(code)) { emit('capture', { type: 'capture', state: 'rejected', device: 'keyboard', value: code, message: codeLabel(code, layoutMap) + ' cannot be used as a control.' }); return; }
    finishCapture({ ok: true, device: 'keyboard', value: code, label: codeLabel(code, layoutMap) });
  }

  /* ----------------------------------------------------------------------------------------------- gamepads */
  const pads = new Map();                                   // index -> info
  const padBinders = new Set();

  function readPads() { try { const l = readPadsRaw(); return l ? Array.from(l) : []; } catch (_e) { return []; } }
  function armPads() { if (padsArmed) return; padsArmed = true; scanPads(); }
  function maybeScan(fromUser) { if (fromUser) padsArmed = true; if (!padsArmed) return; const t = now(); if (t - lastScanAt >= TIMING.padScanMs) scanPads(); }
  function scanPads() {
    lastScanAt = now();
    const list = readPads();
    for (let i = 0; i < list.length; i++) { const gp = list[i]; if (gp && gp.connected !== false) { const idx = Number.isInteger(gp.index) ? gp.index : i; if (!pads.has(idx)) addPad(gp, idx); } }
    kick();
  }
  function padSnapshot(info) {
    return { index: info.index, id: info.id, family: info.family, layout: layoutSel !== 'auto' ? layoutSel : padLayoutFor(info.id), mapping: info.mapping, standard: info.standard, buttons: info.nButtons };
  }
  function addPad(gp, idx) {
    const info = { index: idx, id: String(gp.id || ''), family: padFamily(gp.id), mapping: gp.mapping || '', standard: gp.mapping === 'standard',
      prev: [], stick: null, scroll: 0, scrollNext: 0, nButtons: (gp.buttons || []).length };
    pads.set(idx, info);
    if (!lastPad) lastPad = info;
    emit('device', Object.assign({ type: 'device', source: 'gamepad', connected: true, id: info.id }, padSnapshot(info)));
    kick();
    return info;
  }
  function removePad(idx) {
    const info = pads.get(idx); if (!info) return;
    pads.delete(idx);
    const pre = 'g' + idx + ':';
    for (const a of Array.from(holders.keys())) { const h = holders.get(a); if (!h) continue; for (const tk of Array.from(h.keys())) if (tk.startsWith(pre)) dropHolder(a, tk); }
    if (lastPad === info) lastPad = pads.size ? pads.values().next().value : null;
    emit('device', { type: 'device', source: 'gamepad', connected: false, id: info.id, index: idx });
  }
  function onPadConnected(e) { if (!enabled) return; armPads(); const gp = e && e.gamepad; if (gp && gp.connected !== false) { const idx = Number.isInteger(gp.index) ? gp.index : 0; if (!pads.has(idx)) addPad(gp, idx); } }
  function onPadDisconnected(e) { const gp = e && e.gamepad; if (gp) removePad(Number.isInteger(gp.index) ? gp.index : 0); }

  const isPressed = (b) => (typeof b === 'number' ? b > 0.5 : !!b && (b.pressed === true || (typeof b.value === 'number' && b.value > 0.5)));
  function pollPads(t) {
    if (!padsArmed) return;
    const list = readPads();
    const present = new Set();
    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      const idx = Number.isInteger(gp.index) ? gp.index : i;
      present.add(idx);
      let info = pads.get(idx);
      if (!info) info = addPad(gp, idx);
      processPad(info, gp, t);
    }
    for (const idx of Array.from(pads.keys())) if (!present.has(idx)) removePad(idx);
  }
  function processPad(info, gp, t) {
    const btns = gp.buttons || [], n = btns.length;
    info.nButtons = n;
    const table = padMaps[layoutSel !== 'auto' ? layoutSel : padLayoutFor(info.id)];
    for (let j = 0; j < Math.max(n, info.prev.length); j++) {
      const down = j < n && isPressed(btns[j]);
      const was = !!info.prev[j];
      if (down && !was) padDown(info, j, table);
      else if (!down && was) padUp(info, j);
      info.prev[j] = down;
    }
    // W1 fix A1: an escape that cannot be bound away. Start (9) and Select (8) of a standard controller, both held for padEscapeMs, put the controller bindings back to the defaults,
    // whatever they were rebound to (it reads the physical buttons, not the actions).
    if (info.standard && info.prev[8] && info.prev[9]) {
      if (info.escAt === undefined || info.escAt === null) info.escAt = t;
      else if (t - info.escAt >= TIMING.padEscapeMs) { info.escAt = Infinity; bindings.reset('gamepad'); }
    } else info.escAt = null;
    const ax = gp.axes || [];
    const dir = resolveStick(info.stick, ax[0], ax[1]);
    if (dir !== info.stick) {
      if (info.stick) dropHolder(info.stick, 'g' + info.index + ':s:' + info.stick);
      info.stick = dir;
      if (dir) { lastPad = info; addHolder(dir, 'g' + info.index + ':s:' + dir, 'gamepad', { button: 'stick', source: 'gamepad' }); }
    }
    if (info.standard && ax.length >= 4) {                  // right stick Y scrolls lists
      const s = resolveAxis(info.scroll, ax[3]);
      if (s !== info.scroll) { info.scroll = s; info.scrollNext = t; }
      if (s !== 0 && !capture && t >= info.scrollNext) {
        info.scrollNext = t + TIMING.scrollIntervalMs;
        lastPad = info; noteSource('gamepad');
        emit('pointer', { type: 'pointer', kind: 'wheel', x: null, y: null, steps: s, dy: s * TIMING.wheelStepPx, buttons: 0, source: 'gamepad' });
      }
    }
  }
  function padDown(info, j, table) {
    lastPad = info;
    if (capture && capture.device === 'gamepad') {
      if (!capture.skip.has('g' + info.index + ':b' + j)) finishCapture({ ok: true, device: 'gamepad', value: j, label: padButtonName(info.family, j), padId: info.id });
      return;
    }
    noteSource('gamepad');
    emit('raw', { type: 'raw', device: 'gamepad', value: j, label: padButtonName(info.family, j), padId: info.id });
    const acts = table.get(j);
    if (!acts) return;
    for (const a of acts) addHolder(a, 'g' + info.index + ':b' + j, 'gamepad', { button: j, source: 'gamepad' });
  }
  function padUp(info, j) {
    const tk = 'g' + info.index + ':b' + j;
    if (capture && capture.skip) capture.skip.delete(tk);
    dropToken(tk);
  }

  /* ------------------------------------------------------------------------------------------------ capture */
  // Press-to-bind. device: 'keyboard' | 'gamepad'. done({ok, device, value, label}) or done({ok:false, reason:'cancel'|'timeout'}).
  // While active, NO action is produced by any device. The pad press that STARTED the capture (still held) is not captured.
  function beginCapture(device, done, o = {}) {
    if (device !== 'keyboard' && device !== 'gamepad') throw new Error('beginCapture: device must be keyboard or gamepad');
    if (capture) finishCapture({ ok: false, reason: 'cancel' });
    releaseAll('capture');
    const skip = new Set();
    for (const info of pads.values()) for (let j = 0; j < info.prev.length; j++) if (info.prev[j]) skip.add('g' + info.index + ':b' + j);
    capture = { device, done, skip, deadline: now() + (o.timeoutMs > 0 ? o.timeoutMs : TIMING.captureTimeoutMs) };
    if (device === 'gamepad') armPads();
    emit('capture', { type: 'capture', state: 'start', device, timeoutMs: capture.deadline - now() });
    kick();
    return () => { if (capture && capture.done === done) finishCapture({ ok: false, reason: 'cancel' }); };
  }
  function finishCapture(result) {
    const c = capture; if (!c) return;
    capture = null;
    emit('capture', { type: 'capture', state: result.ok ? 'done' : result.reason, device: c.device });
    try { if (typeof c.done === 'function') c.done(result); } catch (err) { if (typeof console !== 'undefined') console.error('[input] capture callback failed:', err); }
  }

  /* ----------------------------------------------------------------------------------------- pointer targets */
  const targets = new Set();
  let wheelAcc = 0, wheelAt = -1e9;
  const pointerSource = (e) => (e.pointerType === 'touch' ? 'touch' : 'mouse');

  function registerPointerTarget(el, o = {}) {
    if (!el || typeof el.addEventListener !== 'function') throw new Error('registerPointerTarget needs an element');
    const toLocal = typeof o.toLocal === 'function' ? o.toLocal : null;
    const cur = o.cursor || {};
    const hideAfter = cur.hideAfterMs !== undefined ? cur.hideAfterMs : TIMING.cursorIdleMs;
    const entry = { hideAfter, el, hovering: false, hidden: false, lastMove: 0, rcB: false, downs: new Map(), lastXY: null };
    const wantContext = o.contextCancel !== false;
    const style = el.style;
    if (style) { style.touchAction = 'none'; style.userSelect = 'none'; style.webkitUserSelect = 'none'; style.webkitTouchCallout = 'none'; style.webkitTapHighlightColor = 'transparent'; }

    const css = (e) => { const r = el.getBoundingClientRect(); return { cssX: e.clientX - r.left, cssY: e.clientY - r.top }; };
    function where(e) {
      const c = css(e);
      if (!toLocal) return Object.assign({ x: c.cssX, y: c.cssY, inside: true }, c);
      const m = toLocal(e.clientX, e.clientY, el);
      return Object.assign({ x: m.x, y: m.y, px: m.px, py: m.py, inside: m.inside }, c);
    }
    const mk = (kind, e, extra) => Object.assign({ type: 'pointer', kind, buttons: e.buttons | 0, button: e.button | 0, pointerId: e.pointerId, pointerType: e.pointerType || 'mouse', source: pointerSource(e), el }, where(e), extra || {});
    function showCursor(isActionable) {
      entry.lastMove = now(); entry.hidden = false;
      if (style) style.cursor = isActionable ? 'pointer' : 'default';
    }
    function cursorFor(ev) {
      let act = false;
      if (typeof cur.actionable === 'function') { try { act = !!cur.actionable(ev.x, ev.y, ev); } catch (_e) { act = false; } }
      showCursor(act);
    }

    function down(e) {
      if (!enabled) return;
      const src = pointerSource(e);
      noteSource(src);
      if (e.pointerType !== 'touch' && e.button === 2) {
        if (wantContext) { try { el.setPointerCapture(e.pointerId); } catch (_e) { /* synthetic */ } entry.rcB = 'rc:' + e.pointerId; addHolder('b', entry.rcB, 'mouse', { source: 'mouse', button: 'right-click' }); }
        return;
      }
      if (e.pointerType !== 'touch' && e.button === 1) { e.preventDefault(); return; }          // middle click: no autoscroll
      if (e.button > 0 && e.pointerType === 'mouse') return;
      try { el.setPointerCapture(e.pointerId); } catch (_e) { /* synthetic pointers */ }
      const ev = mk('down', e);
      entry.downs.set(e.pointerId, { cx: ev.cssX, cy: ev.cssY });
      if (src === 'mouse') cursorFor(ev);
      emit('pointer', ev);
    }
    function move(e) {
      if (!enabled) return;
      const last = entry.lastXY;
      const moved = !last || Math.abs(last[0] - e.clientX) >= 1 || Math.abs(last[1] - e.clientY) >= 1;
      entry.lastXY = [e.clientX, e.clientY];
      if (!moved && e.pointerType !== 'touch') return;                                           // Chrome re-fires mousemove after layout: not a move
      const src = pointerSource(e);
      if (src === 'touch' && !entry.downs.has(e.pointerId)) return;
      noteSource(src);
      const ev = mk('move', e);
      if (src === 'mouse') { entry.hovering = true; cursorFor(ev); kick(); }
      emit('pointer', ev);
    }
    function up(e) {
      if (!enabled) return;
      if (e.pointerType !== 'touch' && e.button === 2) { if (entry.rcB) { const tk = entry.rcB; entry.rcB = false; dropHolder('b', tk); } return; }
      const d = entry.downs.get(e.pointerId);
      if (!d) return;
      entry.downs.delete(e.pointerId);
      const ev = mk('up', e);
      emit('pointer', ev);
      if (Math.abs(ev.cssX - d.cx) <= TIMING.clickSlopPx && Math.abs(ev.cssY - d.cy) <= TIMING.clickSlopPx) emit('pointer', Object.assign({}, ev, { kind: 'click' }));
      if (el.focus && (e.pointerType === 'touch' || e.button === 0)) { try { el.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    }
    function cancel(e) {
      if (entry.rcB) { const tk = entry.rcB; entry.rcB = false; dropHolder('b', tk); }
      if (entry.downs.delete(e.pointerId)) emit('pointer', mk('cancel', e));
    }
    function leave(e) {
      if (e.pointerType === 'touch') return;
      entry.hovering = false; entry.lastXY = null;
      if (style) style.cursor = '';
      emit('pointer', mk('leave', e));
    }
    function wheel(e) {
      if (!enabled || o.wheel === false) return;
      e.preventDefault();
      noteSource('mouse');
      const t = now();
      if (t - wheelAt > 250) wheelAcc = 0;
      wheelAt = t;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      const dy = (Number(e.deltaY) || 0) * unit;
      if (wheelAcc && Math.sign(wheelAcc) !== Math.sign(dy)) wheelAcc = 0;
      wheelAcc += dy;
      const steps = Math.trunc(wheelAcc / TIMING.wheelStepPx);
      if (!steps) return;
      wheelAcc -= steps * TIMING.wheelStepPx;
      if (style) showCursor(false);
      emit('pointer', mk('wheel', e, { steps, dy }));
    }
    const ctx = (e) => { e.preventDefault(); };
    const mousedown = (e) => { e.preventDefault(); if (el.focus) { try { el.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } } };
    const noop = (e) => { e.preventDefault(); };
    const handlers = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['pointerleave', leave], ['lostpointercapture', cancel],
      ['contextmenu', wantContext ? ctx : () => {}], ['mousedown', mousedown], ['dragstart', noop], ['selectstart', noop], ['auxclick', noop]];
    for (const [type, fn] of handlers) listen(el, type, fn);
    listen(el, 'wheel', wheel, { passive: false });
    targets.add(entry);
    kick();
    return function unregister() {
      for (const r of regs.slice()) if (r[0] === el) { try { el.removeEventListener(r[1], r[2], r[3]); } catch (_e) { /* ignore */ } regs.splice(regs.indexOf(r), 1); }
      if (entry.rcB) { const tk = entry.rcB; entry.rcB = false; dropToken(tk); }
      targets.delete(entry);
      if (style) style.cursor = '';
    };
  }

  /* ------------------------------------------------------------------------------------------------ on-screen pads */
  let padSeq = 0;
  function bindPad(el, action, o = {}) {
    if (!el || typeof el.addEventListener !== 'function') throw new Error('bindPad needs an element');
    if (!ACTIONS.includes(action)) throw new Error('bindPad: unknown action ' + action);
    const id = ++padSeq, active = new Map();
    const style = el.style;
    if (style) { style.touchAction = 'none'; style.userSelect = 'none'; style.webkitUserSelect = 'none'; style.webkitTouchCallout = 'none'; style.webkitTapHighlightColor = 'transparent'; }
    const mark = () => { if (el.classList) { if (active.size) el.classList.add('down'); else el.classList.remove('down'); } };
    function end(e) {
      const tk = active.get(e.pointerId);
      if (!tk) return;
      active.delete(e.pointerId); dropHolder(action, tk); mark();
    }
    function down(e) {
      if (!enabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_e) { /* synthetic pointers */ }
      const src = pointerSource(e), tk = 'pad' + id + ':' + e.pointerId;
      if (active.has(e.pointerId)) return;
      active.set(e.pointerId, tk);
      addHolder(action, tk, src, { source: src, button: 'on-screen' });
      mark();
    }
    const leave = (e) => { let captured = false; try { captured = !!(el.hasPointerCapture && el.hasPointerCapture(e.pointerId)); } catch (_e) { /* ignore */ } if (!captured) end(e); };
    const swallow = (e) => { e.preventDefault(); if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation(); };
    const touchstart = (e) => { if (e.cancelable) e.preventDefault(); };         // no ghost mouse events / clicks, no 300 ms delay, no scroll or zoom
    listen(el, 'pointerdown', down);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(el, t, end);
    listen(el, 'pointerleave', leave);
    listen(el, 'contextmenu', swallow);
    listen(el, 'click', swallow);
    listen(el, 'touchstart', touchstart, { passive: false });
    const binder = { el, reset() { active.clear(); mark(); } };
    padBinders.add(binder);
    return function unbind() {
      for (const r of regs.slice()) if (r[0] === el) { try { el.removeEventListener(r[1], r[2], r[3]); } catch (_e) { /* ignore */ } regs.splice(regs.indexOf(r), 1); }
      for (const tk of active.values()) dropHolder(action, tk);
      active.clear(); mark(); padBinders.delete(binder);
    };
  }

  /* ----------------------------------------------------------------------------------------- window-level hooks */
  let lastWinXY = null;
  function onWinPointerDown(e) { if (!enabled) return; noteSource(pointerSource(e)); maybeScan(true); }
  function onWinPointerMove(e) {
    if (!enabled || e.pointerType === 'touch') return;
    const last = lastWinXY; lastWinXY = [e.clientX, e.clientY];
    if (last && Math.abs(last[0] - e.clientX) < 2 && Math.abs(last[1] - e.clientY) < 2) return;   // layout-triggered synthetic move
    noteSource('mouse');
  }
  function onBlur() { releaseAll('blur'); }
  function onVisibility() { if (doc && doc.hidden) releaseAll('hidden'); else maybeScan(false); }
  function onPageHide() { releaseAll('pagehide'); }
  function onStorage(e) { if (e && (e.key === storageKey || e.key === null)) bindings.reload(); }

  listen(win, 'keydown', onKeyDown);
  listen(win, 'keyup', onKeyUp, { capture: true });
  listen(win, 'blur', onBlur);
  listen(win, 'pagehide', onPageHide);
  listen(win, 'gamepadconnected', onPadConnected);
  listen(win, 'gamepaddisconnected', onPadDisconnected);
  listen(win, 'pointerdown', onWinPointerDown, { capture: true, passive: true });
  listen(win, 'pointermove', onWinPointerMove, { passive: true });
  listen(win, 'storage', onStorage);
  listen(doc, 'visibilitychange', onVisibility);

  /* ------------------------------------------------------------------------------------------------- the clock */
  function tickRepeats(t) {
    for (const [a, r] of Array.from(reps)) {
      if (!isHeld(a)) { reps.delete(a); continue; }
      if (t >= r.next) {
        const iv = TIMING.repeatIntervalMs;
        r.next += iv * (Math.floor((t - r.next) / iv) + 1);          // one repeat per poll; a late poll skips the ones it missed
        emit('action', Object.assign({ type: 'action', action: a, pressed: true, repeat: true, source: lastSource, time: t }, meta.get(a) || {}));
      }
    }
  }
  function tickCapture(t) { if (capture && t >= capture.deadline) finishCapture({ ok: false, reason: 'timeout' }); }
  function tickCursors(t) {
    for (const e of targets) {
      if (e.hovering && !e.hidden && e.hideAfter > 0 && t - e.lastMove >= e.hideAfter) { e.hidden = true; if (e.el.style) e.el.style.cursor = 'none'; }
    }
  }
  function doPoll() {
    if (destroyed) return;
    const t = now();
    if (enabled) pollPads(t);
    tickRepeats(t); tickCapture(t); tickCursors(t);
  }
  function poll() { extPollAt = now(); doPoll(); }
  function needsTick() {
    if (destroyed || !enabled) return false;
    if (pads.size || capture || reps.size) return true;
    for (const e of targets) if (e.hovering && !e.hidden) return true;
    return false;
  }
  function loop() {
    loopHandle = null;
    if (destroyed) return;
    if (now() - extPollAt > 100) doPoll();                           // a page that polls itself keeps its own cadence
    if (needsTick() && raf) loopHandle = raf(loop);
  }
  function kick() { if (raf && loopHandle === null && !destroyed && needsTick()) loopHandle = raf(loop); }

  /* ---------------------------------------------------------------------------------------------- the public API */
  function setEnabled(v) {
    const on_ = !!v;
    if (on_ === enabled) return;
    enabled = on_;
    if (!enabled) { if (capture) finishCapture({ ok: false, reason: 'cancel' }); releaseAll('disabled'); } else kick();
  }

  function glyph(action, source) {
    const src = source || lastSource;
    if (!ACTIONS.includes(action)) return '';
    if (src === 'keyboard') { const l = effKb(action); return l.length ? codeLabel(l[0], layoutMap) : ''; }
    if (src === 'gamepad') {
      const info = lastPad || (pads.size ? pads.values().next().value : null);
      const layout = layoutSel !== 'auto' ? layoutSel : info ? padLayoutFor(info.id) : 'xbox';
      const l = effPad(action, layout);
      if (!l.length) return '';
      return padButtonName(info ? info.family : 'xbox', l[0]);
    }
    if (src === 'mouse') return { a: 'Click', b: 'Right-click', up: 'Wheel up', down: 'Wheel down' }[action] || '';
    // touch: the on-screen buttons carry the action's own name
    return { a: 'A', b: 'B', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'Menu', select: 'Info', up: 'D-pad', down: 'D-pad', left: 'D-pad', right: 'D-pad' }[action] || '';
  }

  function destroy() {
    if (destroyed) return;
    if (capture) { const c = capture; capture = null; try { if (typeof c.done === 'function') c.done({ ok: false, reason: 'cancel' }); } catch (_e) { /* ignore */ } }
    releaseAll('destroy');
    destroyed = true;
    if (loopHandle !== null && caf) { try { caf(loopHandle); } catch (_e) { /* ignore */ } }
    loopHandle = null;
    for (const [t, type, fn, options] of regs.splice(0)) { try { t.removeEventListener(type, fn, options); } catch (_e) { /* ignore */ } }
    for (const e of targets) { if (e.el.style) e.el.style.cursor = ''; }
    targets.clear(); padBinders.clear(); pads.clear();
    for (const k of Object.keys(subs)) subs[k].clear();
  }

  return {
    on, off, poll, press, release, isDown, glyph, destroy, setEnabled,
    registerPointerTarget, bindPad, beginCapture,
    cancelCapture: () => { if (capture) finishCapture({ ok: false, reason: 'cancel' }); },
    mapClientToLogical,
    bindings,
    keyLabel: (c) => codeLabel(c, layoutMap),
    buttonLabel: (i) => { const info = lastPad || (pads.size ? pads.values().next().value : null); return padButtonName(info ? info.family : 'xbox', i); },
    get lastSource() { return lastSource; },
    get sourceKnown() { return sourceKnown; },
    get enabled() { return enabled; },
    get capturing() { return !!capture; },
    get pads() { return Array.from(pads.values()).map(padSnapshot); },
    get held() { return ACTIONS.filter(isHeld); },
    get destroyed() { return destroyed; },
  };
}
