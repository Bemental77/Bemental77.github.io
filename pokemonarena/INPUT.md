# Pokemon Arena input layer

One input system for every screen of the game. Keyboard, mouse, touch and controller (gamepad) all become the same twelve
**actions**, any of them works on its own, and the player can switch between them in the middle of a session.

| File | What it is |
|---|---|
| `js/input.js` | the layer: keyboard, pointer, touch, gamepad -> actions; bindings; storage; press-to-bind capture |
| `js/uinav.js` | DOM spatial navigation, so a controller or keyboard can drive any ordinary page (hub, editor, settings) |
| `js/input_panel.js` | the **Controls** settings panel (rebinding, layout switch, last-input readout) |
| `input.css` | the focus ring (keyboard and controller only) and the Controls panel styling |
| `dev/input_lab.html` | developer fixture used by `tools/pokemonarena_input_test.mjs`. Not linked from any player page |

Everything is first-party, import-safe in Node (nothing touches `window` at import time) and testable with fakes.

## The twelve actions and their defaults

Keyboard bindings are `KeyboardEvent.code` based (so they follow the physical key, and AZERTY players see the right letter on
screen: `navigator.keyboard.getLayoutMap()` is used for labels when the browser has it).

| action | meaning | keyboard | controller (Standard layout button index) |
|---|---|---|---|
| up | up | Up, W | 12 |
| down | down | Down, S | 13 |
| left | left | Left, A | 14 |
| right | right | Right, D | 15 |
| a | confirm | Z, Enter, Space, Num Enter | 0 (Xbox) / 1 (Nintendo) |
| b | back | X, Backspace, Esc | 1 (Xbox) / 0 (Nintendo) |
| x | info | C | 2 (Xbox) / 3 (Nintendo) |
| y | filter | V | 3 (Xbox) / 2 (Nintendo) |
| l | previous tab / page | Q, Page Up | 4, 6 |
| r | next tab / page | E, Page Down | 5, 7 |
| start | menu | P | 9 |
| select | toggle info | I | 8 |

Mouse: hover moves a canvas cursor, left click = click, **right click on a registered canvas = B** (the context menu is suppressed
there and only there), the wheel steps menus up and down. Touch: on-screen pads (`bindPad`), and a tap on a registered canvas is a
click at that spot. Controller extras: the left stick is the d-pad (8-way resolved to one direction), the right stick's Y axis
scrolls lists (a `wheel` pointer event with no position), triggers are alternates for L and R.

The face buttons follow the console family: an id matching `/nintendo|switch|pro controller|057e|joy-?con/i` gets the Nintendo
layout (confirm = east), everything else, PlayStation and unknown pads included, gets the Xbox layout (confirm = south). The
player can force either in the Controls panel (`bindings.setLayout('xbox' | 'nintendo' | 'auto')`).

## API

```js
import { createInput } from './js/input.js';
const input = createInput({ /* all optional, all injectable for tests */
  target: window, document, now: () => performance.now(), getGamepads: () => navigator.getGamepads(),
  storage: localStorage, storageKey: 'arena.bindings', raf: requestAnimationFrame /* null = no self-poll */, layoutMap: null,
});
```

| member | what it does |
|---|---|
| `on(type, cb)` -> off function | subscribe. Types: `action`, `pointer`, `device`, `source`, `bindings`, `capture`, `raw`. A listener that throws is logged, never fatal |
| `off(type, cb)` | unsubscribe |
| `poll()` | call once per frame from your own `requestAnimationFrame`. Optional: the layer self-polls while a pad is connected, a direction is held, a capture is open or a registered canvas is hovered, and stops when none is |
| `press(action, source?)` / `release(action, source?)` | drive an action from code (on-screen pads, tests). Default source `'touch'`. Each source is its own holder |
| `isDown(action)` | is the action held by ANY holder. A and B never auto-repeat, so "hold A to type faster" is `input.isDown('a')` |
| `held` | array of held action names |
| `lastSource` / `sourceKnown` | `'keyboard' \| 'mouse' \| 'touch' \| 'gamepad'` and whether any real input has happened yet |
| `glyph(action, source?)` | label for the current source: `Z`, `Click`, `A button`, `Cross`, `+` ... follows rebinding and the controller family |
| `pads` | connected controllers: `{ index, id, family, layout, mapping, standard, buttons }` |
| `registerPointerTarget(el, opts)` -> unregister | see below |
| `bindPad(el, action)` -> unbind | see below |
| `beginCapture(device, done, { timeoutMs })` -> cancel | press-to-bind for `'keyboard'` or `'gamepad'`; `cancelCapture()`; `capturing` |
| `mapClientToLogical(el, w, h)` | `(clientX, clientY) -> { x, y, px, py, inside }` |
| `bindings` | `get()`, `defaults(device, layout)`, `set`, `rebind(device, action, slot, value, { onConflict: 'reject' \| 'swap' \| 'move' })`, `remove`, `conflicts`, `setLayout`, `layout()`, `reset('keyboard' \| 'gamepad' \| 'all')`, `reload()`, `status()` |
| `keyLabel(code)` / `buttonLabel(index)` | display names |
| `setEnabled(bool)` | `false` releases everything and ignores input (use while a native modal owns the keyboard) |
| `destroy()` | removes every listener, releases everything |

### Events

```text
action  { type, action, pressed, repeat, source, time, code?, button?, native? }
          code    keyboard: the KeyboardEvent.code            button  pad button index | 'stick' | 'on-screen' | 'right-click'
          repeat  true on the layer's own repeat of a held DIRECTION (400 ms, then every 90 ms) - never from the OS auto-repeat
          native  true when the BROWSER itself activates the focused control with this key (Enter on a button, Space on a checkbox);
                  the layer reports it but does not preventDefault, so a page that also clicks on A must skip native:true
pointer { type, kind: 'move' | 'down' | 'up' | 'click' | 'cancel' | 'leave' | 'wheel', x, y, px, py, inside, cssX, cssY,
          buttons, button, pointerId, pointerType, source: 'mouse' | 'touch', el, steps?, dy? }
          x,y are LOGICAL pixels when the target has toLocal, else css pixels relative to the element. wheel: steps = signed notches
          (positive = down). The right stick sends kind 'wheel' with x = y = null, source 'gamepad'
device  { type, source: 'gamepad', connected, id, index, family, layout, mapping, standard, buttons }
source  { type, source, previous }      fires on every change of input family, and once for the very first input (previous: null)
bindings{ type, what }                  after any rebind / reset / reload
capture { type, state: 'start' | 'done' | 'cancel' | 'timeout' | 'rejected', device, message? }
raw     { type, device, value, label }  every key / pad press even when unbound (the Controls panel's "last input" readout)
```

### Pointer targets (canvas pages)

```js
const off = input.registerPointerTarget(canvas, {
  toLocal: input.mapClientToLogical(canvas, 240, 160),      // omit for css-pixel coordinates
  cursor: { actionable: (x, y, ev) => bool, hideAfterMs: 3000 },   // pointer cursor over actionable regions, hidden after 3 s idle
  contextCancel: true,                                       // right click = B and no context menu (default true)
  wheel: true,                                               // wheel -> 'wheel' pointer events and no page scroll (default true)
});
```

`mapClientToLogical` is exact under whole-pixel CSS scaling, under letterboxing (`object-fit: contain | cover | none | scale-down`)
and with a border or padding on the canvas (a 2 px border otherwise shifts every hit by two logical pixels at 1x). The element gets
`touch-action: none`, `user-select: none` and no tap highlight; `mousedown`, `selectstart` and `dragstart` are cancelled so a click-drag, double click or
triple click on the canvas cannot select page text; and a drag longer than 10 css px is not a click.

### On-screen pads

```html
<button type="button" data-btn="up" aria-label="Up">...</button>   <!-- also down left right a b x y l r start select -->
```
`input.bindPad(button, 'up')`: pointer capture, multi-touch (d-pad plus A at once), no ghost click, no 300 ms delay, no scroll or
zoom while pressing, released on pointercancel / lost capture / blur. Each pad gets class `down` while held. A direction on an
on-screen pad repeats exactly like a key.

## How each page type wires it

All snippets below are executed by `tools/pokemonarena_input_test.mjs` (group `doc`) against a fixture page that has
`<canvas id="battle">`, buttons with `data-btn`, `<main id="app">` and `<div id="settings">`.

### Canvas page (battle)

```js verify
// verify: canvas-page
import { createInput } from './js/input.js';
// stand-ins for what the battle scene supplies:
const view = { screen: 'menu', cursor: 0 };
const log = [];
const hitTest = (v, x, y) => (x >= 120 && y >= 112 ? { kind: 'action', index: x < 180 ? 0 : 1 } : null);
const scene = {
  action(name) { log.push('action:' + name); },
  hover(hit) { view.cursor = hit.index; },
  choose(hit) { view.cursor = hit.index; log.push('choose:' + hit.index); },
};

const canvas = document.getElementById('battle');
const input = createInput();
input.registerPointerTarget(canvas, {
  toLocal: input.mapClientToLogical(canvas, 240, 160),
  cursor: { actionable: (x, y) => hitTest(view, x, y) !== null },
});
for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);

input.on('action', (e) => { if (e.pressed) scene.action(e.action); });          // keyboard, pad and on-screen pads all arrive here
input.on('pointer', (e) => {                                                     // mouse hover / click and touch taps on the canvas
  if (e.el !== canvas || !e.inside) return;
  const hit = hitTest(view, e.x, e.y);
  if (!hit) return;
  if (e.kind === 'move' || (e.kind === 'down' && e.source === 'touch')) scene.hover(hit);   // hover moves the cursor
  else if (e.kind === 'click') scene.choose(hit);                                           // click = cursor + A
});
function frame() { input.poll(); requestAnimationFrame(frame); }              // optional; the layer self-polls without it
requestAnimationFrame(frame);
```

**The 6v6 lead preview uses the existing preview input and nothing new:** the same rows (`'preview'` hits, one per Pokemon), A / a click / a tap on a row picks it and opens the YES / NO (`'overlay'` hits), B / Backspace / a right click / the on-screen B / a tap beside the box answers NO, and the pause menu, FORFEIT and the Controls panel behave as at the 3v3 preview. `tools/pokemonarena_lead_page_test.mjs` drives it by tap, on-screen pad, controller, keys and mouse, each on its own, and `tools/pokemonarena_devices_test.mjs` journey A chooses the lead with each of the four device families.

**The free switch ("Will you switch your Pokemon?") uses the existing battle inputs and nothing new:** its YES / NO is the `'overlay'` hits (YES row, NO row) with the cursor on YES, A / a click / a tap on a row answers it, B / Backspace / a right click / the on-screen B / a tap beside the box is NO; YES opens the party screen with its `'party'` rows and the `'cancel'` button, and B, a right click or a tap on CANCEL comes back to the question. `tools/pokemonarena_switch_page_test.mjs` drives it by tap, on-screen pad, controller, keys and mouse, each on its own, and `tools/pokemonarena_devices_test.mjs` answers it with each of the four device families (`toAction`: YES and the first healthy Pokemon the first time, NO after). The pause menu's BATTLE STYLE row is an ordinary menu row (A flips it).

**Hit-test contract for `battle_ui.js`** (to be added by the battle-scene stage): `hitTest(view, x, y) -> null | { kind, index }` in
logical 240x160 pixels, where `kind` is one of `'action'` (the four-way action menu), `'move'` (the move menu), `'party'`,
`'preview'` or `'result'`, plus (W1) `'overlay'` (a row of an open pause menu / YES-NO box), `'text'` (a message: a tap is A), `'back'` (a tap beside an open
menu or YES-NO box, or on the picture above the move menu: a tap is B, so touch never depends on the on-screen pad) and `'info'` (the PP / TYPE boxes beside the
move menu: a click reads the highlighted move's description, the keyboard's C / the controller's X). ST1 added `'recap'` (the RECAP chip of the result screen, `index` -1: the cursor ring there runs RECAP, then the options), and on the recap screen `'recap-prev'`, `'recap-back'`, `'recap-next'` (its three buttons) and `'recap-page'` (anywhere else above them: a click is A, a right click is B, the wheel turns pages); the hub's RECORD screen has its own `hit()` kinds (`'rec-prev'`, `'rec-back'`, `'rec-next'`, `'rec-trainer-prev'`, `'rec-trainer-next'`, `'rec-reset'`, `'rec-yes'`, `'rec-no'`, `'rec-page'`). The scene maps `pointer move` to the cursor, `pointer click` to cursor + A, and the wheel to up / down;
right click arrives as the ordinary `b` action.

The existing `boot.js` bindings are a subset of the defaults (arrows, Z / Enter / Space = A, X / Backspace / Escape = B, hold A / B
to speed text up), so replacing its own `keydown` code with `input.on('action', ...)` and `input.isDown('a')` loses nothing.

### DOM page (hub, editor, settings)

```js verify
// verify: dom-page
import { createInput } from './js/input.js';
import { enableDomNav } from './js/uinav.js';
const log = [];
const input = createInput();
const nav = enableDomNav(document.getElementById('app'), {
  input,
  onBack: () => log.push('back'),             // B with nothing to close
  onMenu: () => log.push('menu'),             // optional: the Start action
  // scope: () => currentPanelElement,        // optional: confine navigation (a modal dialog always confines it by itself)
});
document.getElementById('start').addEventListener('click', () => log.push('start clicked'));
nav.focusFirst();                             // put the cursor on the first control when a screen opens
```

`enableDomNav(root, { input, onBack, onMenu, onAction, onEdge, scope, selectPicker })` returns `{ candidates(), current(), focusFirst(),
move(dir), editing(), typing(), refresh(), disable() }`. Call `disable()` before leaving a screen or when a canvas takes over.
Mark a control `data-nav-default` (or `autofocus`) to be where `focusFirst()` lands. Mouse and touch keep their native behaviour
completely; nothing is intercepted.

| action | on a DOM page |
|---|---|
| directions | move focus to the nearest focusable control in that direction by geometry (a control that only OVERLAPS the current one along the move, instead of lying wholly beyond it, counts only if it also shares part of the other axis, i.e. the two rectangles overlap: Up / Down never step sideways into a taller or shorter neighbour beside the current control, and Left / Right never step to a control stacked above or below just because its centre lies further that way, e.g. a sticky header's button. A control that lies STRICTLY in that direction is still chosen even when it is in another row or column: the offset on the other axis only raises its score (twice its gap), it does not exclude it, so Left can still land on a control in a different row when nothing nearer lies to the left); when none lies that way, fall back to DOM order (next for down / right, previous for up / left); no wrap, `onEdge(dir)` fires at the ends; scrolls the control into view |
| a | click a button, link, checkbox, radio, summary; a `<select>` opens its picker with `showPicker()` where the browser allows it from a controller press, otherwise enters CYCLE mode (right and down step to the next option, left and up to the previous one, B leaves); range and number inputs enter EDIT mode (left / right step, up / down take a tenth of the range, A or B leaves); a text field enters TYPING mode |
| b | leave edit mode, else leave typing, else close the topmost `[role=dialog]` / `<dialog>` (focus returns to the opener), else `onBack()` |
| l / r | previous / next `[role=tab]` or `[data-tab]` in the current tablist, wrapping; stepped from the focused tab when focus is on one, else from the selected tab |
| start / x / y / select | `onMenu(ev)` for start, `onAction(ev)` for the rest |
| right stick | scrolls the nearest scrollable ancestor of the focused control (or the page) |

Skipped: `[data-nav-skip]`, `[inert]`, `[hidden]`, `disabled` (and inside a disabled fieldset), `aria-hidden="true"`,
`display:none`, `visibility:hidden` and zero-size elements. A modal dialog (`aria-modal="true"`, `data-nav-modal`, or an open
`<dialog>` shown with `showModal()`) confines directions, L / R and Tab to itself. B closes a dialog by CLICKING its `data-nav-close` button (or one labelled Close / Cancel / Dismiss / Back / X); a dialog with none gets a synthetic Escape keydown instead, which, if it reached the input layer, would feed it a key whose keyup never comes and leave B held for good. So a dialog either carries `data-nav-close` (the Controls dialog, the Sound panel, the on-screen keyboard, the Open-to-battles dialogs' Not now and Cancel) or has a button labelled Close / Cancel / Dismiss / Back / X (the Team Builder's sheets: "Close <title>"), or closes on that Escape itself at the DOCUMENT in the capture phase and stops it there, before the input layer (a listener on the window) can see it. The audio bar's music list is the one dialog that does the last: it has no close button, and `audiobar.js` takes the synthetic Escape (`preventDefault` + `stopPropagation`), closes the list and returns the focus to the music button. A new dialog needs one of the three. "The topmost dialog" and "the modal" are the LAST ones in document order, so a dialog shown over another is moved to the end of `<body>` when it opens.

**The audio bar's music list** (`audiobar.js`) is a modal dialog (`role="dialog" aria-modal="true"`) holding a radio group, and it follows the game's key promise "arrows or WASD move". Keyboard: the four arrows AND the keys the player's bindings give the d-pad (W A S D by default; `sys.keyDirection` in `sound_system.js` asks the input layer, so a rebinding is followed: with Up moved from W to U, U moves up and W does nothing) step through the songs and pick each as they go; Home / End jump to the first / last; Tab stays inside; Esc closes it and returns the focus to the music button; every other key (Z, X, Backspace, PageUp / PageDown ...) is kept from the page behind it with `stopPropagation`, and so are the direction keys, which belong to the list while it is open. Controller: on the Team Builder the page-wide layer scopes itself to the open list (`aria-modal`): the d-pad moves the focus, A picks the focused song, B closes the list (the synthetic Escape above). The hub's own input ignores the pad while any dialog is up (its dialog counter, told by `sys.menuDialog`), so on the hub the list gets a layer of its own (`sys.dialogNav` -> `enableDomNav(list)`, disabled again when the list closes) with the same d-pad / A / B and the same return of the focus. A pad cannot OPEN the list on the hub: the header buttons are out of its reach.

**Keyboard inside fields.** The layer never takes a key that a text field, `<select>`, range or radio group needs: arrow keys there
belong to the browser (a number field's spinner, a select's options). Escape lets go of such a field (focus is released, the
position is remembered, the next arrow continues from it). Tab and Shift+Tab are never touched.

**Controller and text fields (limitation).** A controller cannot type: A puts a text field in TYPING mode (a physical keyboard types;
a controller user can leave with B, and the d-pad leaves on its own when the field is empty). Text entry for a controller-only
player is the on-screen keyboard of the screen that needs it, which is not part of this layer.

**Focus ring.** `<html data-input-source="none | keyboard | mouse | touch | gamepad">` is kept current by `enableDomNav`, and
`input.css` draws a 3 px yellow ring (black halo, so it reads on any background) only for `keyboard` and `gamepad`, and a dashed
orange ring on a control in edit mode. A mouse or touch focus never shows a ring. Include `<link rel="stylesheet" href="input.css">`.
Custom properties: `--nav-ring`, `--nav-ring-halo`, `--nav-edit`, `--nav-scroll-top`, `--nav-scroll-bottom`.

### Controls panel (hub settings)

```js verify
// verify: controls-panel
import { createInput } from './js/input.js';
import { enableDomNav } from './js/uinav.js';
import { mountControlsPanel } from './js/input_panel.js';
const input = createInput();
const nav = enableDomNav(document.body, { input });
const panel = mountControlsPanel(document.getElementById('settings'), { input });
// later: panel.refresh(); panel.destroy();
```

The panel shows a live "last input" readout, the connected controllers (with a plain "unsupported layout" notice for a non-standard
pad and the line that browsers hide a controller until a button is pressed), the Auto / Xbox / Nintendo layout switch, and a
table of every action by keyboard keys and controller buttons. Choosing a key or button starts press-to-bind: the next key (or
pad button) is bound; Escape, the Cancel button or 8 seconds of silence stops it, so a controller-only player is never trapped.
A key that is already used gives Swap / Use it here only / Cancel. The three Reset buttons sit directly under the readout (below
the Cancel or conflict buttons while those are showing) and above the long table, so a player who bound themselves into a corner
is only a few presses from the way out. It is plain DOM, so `enableDomNav` drives it with a controller and a mouse or finger just clicks it.

### On-screen pads

```js verify
// verify: pads
import { createInput } from './js/input.js';
const input = createInput();
const held = [];
input.on('action', (e) => { if (!e.repeat) held.push((e.pressed ? '+' : '-') + e.action); });
for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);
```

Show the pad block when the primary pointer is coarse (`matchMedia('(pointer: coarse)')`), as `boot.js` does today.

### Holding and glyphs

```js verify
// verify: hold-and-glyph
import { createInput } from './js/input.js';
const input = createInput();
const speed = () => (input.isDown('a') || input.isDown('b') ? 'fast' : 'normal');   // "hold A or B to speed text up"
const confirmHint = () => 'Press ' + input.glyph('a') + ' to continue';             // Z, Click, A button, Cross ...
input.on('source', () => { document.getElementById('hint') && (document.getElementById('hint').textContent = confirmHint()); });
```

### Rebinding from code

```js verify
// verify: rebind-api
import { createInput } from './js/input.js';
const input = createInput();
const r1 = input.bindings.rebind('keyboard', 'a', 0, 'KeyG');                       // { ok: true }
const r2 = input.bindings.rebind('keyboard', 'b', 0, 'KeyG');                       // { ok: false, reason: 'conflict', conflicts: ['a'] }
const r3 = input.bindings.rebind('keyboard', 'b', 0, 'KeyG', { onConflict: 'swap' });   // the other action gets the old key
input.bindings.reset('keyboard');
```

**A player can not be locked out by rebinding (W1).** `up`, `down`, `left`, `right`, `a` and `b` can never be left with no binding: `rebind()` refuses (`{ ok: false, reason: 'would-empty' }`) a "move" or an unswappable
change that would empty one of them, `remove()` keeps the last binding (`reason: 'last'`), `set()` refuses an empty list for them, and a saved list that is empty is ignored when loaded (the default is used and `status().problems` says so).
As a last resort that cannot be bound away, **Start (9) and Select (8) of a standard controller held together for `TIMING.padEscapeMs` (2 s) reset the controller bindings** (`bindings.reset('gamepad')`); it reads the physical buttons, not the actions.

## Why it behaves like this

* **Keys are never swallowed where they are needed.** A key is ignored on `<input>` (except buttons, checkboxes, radios, ranges),
  `<textarea>`, `<select>` and `contenteditable`, and whenever Ctrl, Meta or Alt is held, during IME composition, and when an inner
  handler already called `preventDefault`. F5, F12, Ctrl+R, Ctrl+L, Tab and Shift+Tab always work. Only keys the layer actually
  used are `preventDefault`-ed, and the matching keyup is too (Firefox clicks a button on Space keyup otherwise).
* **OS auto-repeat is ignored** and replaced by the layer's own repeat from the injected clock, so keyboard, stick and d-pad repeat
  identically: first repeat 400 ms after the press, then every 90 ms. A late poll yields one repeat, not a storm.
* **An action is held while ANY holder holds it** (two keys, d-pad plus stick, a finger plus a key): released when the last lets go.
* **No stuck inputs.** Every held action releases on `blur`, `visibilitychange` (hidden), `pagehide`, gamepad disconnect,
  `setEnabled(false)` and when a capture starts.
* **No `getGamepads()` before the visitor has acted** (consoles prompt on first use). The first key press or click arms scanning,
  `gamepadconnected` arms it too, and scans are rate limited to one per second. Chrome exposes a controller only after one of its
  buttons has been pressed; the Controls panel says so.
* **Stick**: engages at 0.5, stays held down to 0.35 (hysteresis), a diagonal resolves to the dominant axis so it never fires two
  directions, and a held direction hands over to the other axis only when that axis is past 0.5 and larger.
* **Storage** key `arena.bindings`, versioned (`v: 1`) and validated piece by piece: wrong JSON, a wrong version, an oversized
  value, prototype-pollution keys, a binding to Tab / F-keys / modifiers, an out-of-range pad button: each is dropped and the rest of
  the document is kept (`bindings.status()` reports `loaded | repaired | invalid | default | absent | error` and the problems). The
  layer works with storage absent or throwing and says so in the panel.

```json
{ "v": 1, "keyboard": { "a": ["KeyG", "Enter"] }, "gamepad": { "layout": "auto", "buttons": { "a": [10] } } }
```

## Running the tests

```text
node tools/pokemonarena_input_test.mjs                 everything: unit, browser, mutants
node tools/pokemonarena_input_test.mjs --unit          Node only (fake EventTarget, fake gamepads, injected clock, fake storage)
node tools/pokemonarena_input_test.mjs --no-mutants    unit + browser
ARENA_GROUPS=keyboard,mouse,pad,switch,touch,navkbd,navpad,ring,rebind,doc,shots   a subset of the browser groups
ARENA_PORT=8098 ARENA_CDP=9301 ARENA_OUT=<dir for screenshots>
```
The browser half runs one headless Chrome (throwaway profile, bare CDP, `--mute-audio`) through `tools/headless_cdp.mjs`. The mutant
half copies the sources to a temp tree, applies one defect per mutant and requires the NAMED check to fail while the unmutated
twin stays quiet.

## What is synthetic or unverified

* **No physical controller was used.** Gamepad behaviour is tested through a script-controlled `navigator.getGamepads()` and
  synthetic `gamepadconnected` events (the lab labels it `SYNTHETIC`). Real Xbox, PlayStation, Switch Pro, 8BitDo and generic
  hardware, and the browsers' own id strings for them, are unverified; the mapping follows the W3C Standard Gamepad layout.
* Real touch hardware is not used: touch is CDP `Input.dispatchTouchEvent` in a mobile emulation. Safari and Firefox are untested
  (Chrome only).
* `blur` and `visibilitychange` are dispatched by script, not by a real window switch. IME composition is covered by a flag check,
  not by a real IME. Screen readers are untested beyond roles, labels and one polite live region.
* The anti-selection guards on a canvas are defence in depth that Chrome does not need: measured in headless Chrome 156, a drag, double click and
  triple click on an UNPROTECTED canvas never started a text selection in any layout tried, so there is no test that could fail without the guards.
  Whether Safari or Firefox select from a canvas is unverified.
* A native `<select>` picker cannot be observed headlessly, so `showPicker()` use is checked with a stub.
