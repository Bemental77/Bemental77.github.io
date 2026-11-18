# Everything in the app (2026-11-17)

The owner's words, after seeing the first Trainer Center (a separate web page with art drawn by this site and HTML buttons under it):

> you are only allowed you use assets from the game and rom: [the Trainer Center page], everything needs to be within this app: [the hub's
> 240x160 ROM-drawn menu], including the pokemon team maker.

Two rules follow. They bind every piece of work below.

1. **ROM ASSETS ONLY.** Every pixel a player sees comes from the Pokemon SoulGold v1.1.1 ROM, decoded in the browser at runtime: maps,
   tiles, overworld sprites, emote icons, windows, fonts, icons. Nothing drawn by hand in code (the first Trainer Center's `avatar.js`
   sprites and `center_draw.js` room are to be deleted). Words the ROM has no line for are written by this site and set in the ROM font, as
   the hub's menu already is. **Nothing ROM-derived is ever committed**: code, offsets, strides and hashes only (goldens hold hashes, never
   pixels); contact sheets go to a scratch output folder.
2. **EVERYTHING IN THE APP.** "The app" is the 240x160 picture: the hub's canvas (`index.html`, `js/boot.js`) and the battle's canvas
   (`battle.html`). The Trainer Center, the Team Builder, the online menus, the "wants to battle you" question, the invite / join / waiting
   screens: all of it is drawn in that picture from the ROM and driven by the twelve actions of `input.js` (plus pointer taps on the picture).
   No HTML buttons, cards, forms or dialogs for these. The only DOM left is what a browser forces: the page header (Home, Fullscreen, the
   audio bar, Sound, Controls), the on-screen touch pad, the status / hint lines, the screen-reader live region, the Controls and Sound
   panels, the ROM error screen, and an invisible `<input type="file">` where a file must be chosen.

## The shell: hub apps

The hub is a pure state machine (`hub_model.js`: `press / pointer / hit / tick / view`, returns EFFECTS), a pure renderer
(`hub_screen.js`: view -> 240x160 RGBA through `battle_ui.js createBattleUi(rom)`), and the page glue (`boot.js`: carries the effects out).
The Tower already plugs into it as a sub state machine (`tower_hub.js`, `tower_screen.js`, effects handled in `boot.js`). The same shape,
made generic, hosts everything new. One app = three files:

| File | What | Rules |
|---|---|---|
| `js/<app>_hub.js` | the app's state machine | pure: no DOM, no ROM, no clock, no storage, no randomness. Owns a family of hub paths. |
| `js/<app>_screen.js` | view -> pixels | pure: ROM art through `ui` (and `world_rom.js` for the Center). |
| `js/<app>_ctl.js` | side effects | the only file that touches the store, the network, storage, timers, navigation. Loaded lazily by `boot.js`. |

The exact interface (what the hub calls on an app, what an app may ask of the hub, how typed text reaches an app, how a ctl receives its
effects) is written by the foundation work in the section **"The app interface"** at the end of this file. Read that section before
writing an app.

## The apps

| App | Paths | What |
|---|---|---|
| `online` | `online`, ... | PLAY ONLINE: TRAINER CENTER / INVITE A FRIEND / JOIN A FRIEND / BATTLE ANYONE / OPEN TO BATTLES: ON-OFF / BACK. Replaces the HTML row under the picture (`#onlineLink`: Play online, Trainer Center, Open). The disclosure ("what Open shares") and the "<name> wants to battle you" question become ROM message boxes with YES / NO. |
| `center` | `center` | THE TRAINER CENTER: the ROM's own Pokemon Center map, the ROM's overworld trainer sprites, the ROM's emote icons. Walk around; everyone open to battles is there; walk up and battle; the PC opens the Team Builder; the counter offers the friend / anyone battles; the door mat leaves. |
| `builder` | `builder`, ... | THE TEAM BUILDER in the picture: profiles, teams, every Pokemon's species, nickname, level, gender, nature, ability, item, moves, EVs / IVs, validation, team codes, test battle. Built on the existing pure layers (`editor_state.js`, `editor_data.js`, `store.js`, `rules.js`, `teamcode.js`, `editor_art.js`). |

The battle page keeps its own canvas; its online setup / invite / waiting screens move into that canvas too.

## Text entry

Names, nicknames, a search word, a room code and a team code are typed on an in-picture keyboard (ROM font, ROM windows): the d-pad moves,
A types, B deletes, START accepts; a tap on a key types it; **a real keyboard types directly** (letters go to the field, not to the
Z / X / WASD action keys) and Ctrl+V pastes. One shared component, built by the foundation work.

## Working rules for every agent

* Work only in the worktree you are given. Never touch `C:/Users/Admin/Dev/Bemental77.github.io` (the owner's checkout).
* Tests: headless, muted Chrome only, never the owner's browser. At most ONE browser suite of your own at a time; before starting one check
  free memory (PowerShell `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024`) and do Node-only work first if it is under
  1500 MB. Use only the ports you were given (suites take a range above each base).
* Commit with a pathspec (`git commit -m ... -- <paths>`), check `git ls-files | wc -l` did not collapse, never `git stash`, never push.
* Python is not installed. Use Node. Write scripts with the Write tool rather than shell heredocs when they contain backslashes.
* Every claim in your report is either cited (file:line or command output) or hedged.

## The app interface

Written by the foundation work (2026-11-17). It is exact: every name below is the name in the code, and `tools/pokemonarena_apps_test.mjs` pins it (Node checks, each family with source
mutants that must trip a named check, and five browser sessions). If the code and this section ever disagree, the code and its tests are right and this section is a bug.

### The pieces

| File | What it is |
|---|---|
| `js/hub_apps.js` | THE REGISTRY of app models: `APPS` (the descriptors), `checkRegistry`, `checkApp`, `createAppHost`. Pure. |
| `js/hub_app_screens.js` | the registry of app renderers: `APP_SCREENS = { id: createScreen }`. Pure. |
| `js/hub_app_ctls.js` | the registry of app ctls: `APP_CTLS = { id: () => import('./<id>_ctl.js') }` (nothing is loaded until the function is called). |
| `js/hub_model.js` | the shell's state machine. Delegates to the open app, owns the dialog layer, exports `PATHS`, `parentOf`, `arrivalTrail`, `historySeedPlan`. |
| `js/hub_dialog.js` | the dialog layer (pure): `createDialogLayer`, `normalizeDialog`, `optionRects`, `wrapDialog`, `speakDialog`, `DGEOM`. |
| `js/textentry.js` | text entry (pure model): `createTextEntry`, `createEntrySlot`, `mapChar`, `filterText`, `keyboardOf`, `keyRect`, `fieldWindow`, `glyphOf`, `speakEntry`, `CHARSETS`, `TEGEOM`. |
| `js/textentry_screen.js` | draws an entry view from the ROM: `createTextEntryScreen(ui, h) -> { draw(f, entryView, tick), layout(entryView) }`. |
| `js/hub_menu.js` | OPTIONAL helper (pure): a cursor over a list of rows with the main menu's own behaviour: `createMenu`, `MENU`, `menuPitchFor`. |
| `js/hub_screen.js` | the shell's renderer: draws the app's view through its renderer, then `view.entry`, then `view.dialog`. |
| `js/boot.js` | the page: loads ctls lazily, routes effects, sends a real keyboard's keys and pastes to `hub.type`, mirrors speech and the title. |

**An app is three files, with these exact exports:**

```js
// js/<id>_hub.js      the pure state machine
export const APP = Object.freeze({ id, paths, parent, create });      // create(ctx) -> the model (below)
// js/<id>_screen.js   the pure renderer
export function createScreen(ui, h) { return { render(f, view) { ... } }; }
// js/<id>_ctl.js      the side effects
export function createCtl(env) { return { effect(eff) { ... }, enter(path) {}, leave(path) {}, dispose() {} }; }
```

**To register an app** add one line to each registry: its `APP` to `APPS` in `hub_apps.js`, its `createScreen` to `APP_SCREENS` in `hub_app_screens.js`, its loader to `APP_CTLS` in
`hub_app_ctls.js`. Nothing else in the shell names an app. **`online`, `center` and `builder` are already registered** (as stubs): the online, Trainer Center and Team Builder work each
REPLACE their three files and touch nothing else. To make a screen reachable, another screen calls `ctx.go(path)` (the main menu already has PLAY ONLINE -> `online` and TEAM BUILDER ->
`builder`; the online stub's TRAINER CENTER row -> `center`).

**The rules the registry enforces** (a hub model throws on a broken registry, so every test sees it):

* `id`: 2..16 lower-case letters or digits, starting with a letter; unique; not `main`, `quick`, `team`, `record`, `about` or `tower`.
* `paths`: at least one, each IS the id or starts with `<id>-` (`builder`, `builder-team`, `builder-mon`). A path is also the address: `/pokemonarena/#builder-team`. Paths are a FIXED list:
  which team or Pokemon a screen shows is the app's state, not part of the path.
* `parent(path)`: a pure function of the path ALONE (the browser history is seeded from it before any state exists). It returns `'main'` or any other hub path (another app's, a Tower
  screen), and following it from any path must reach `'main'`. B (`ctx.back()`) goes there; a page opened at `#<path>` gets the history entries of the screens on the way
  (`arrivalTrail('center')` is `['online', 'center']`).

### The app model: what `create(ctx)` returns

Pure: no DOM, no ROM, no clock, no storage, no network, no randomness, no dynamic import (a test greps the stubs for these). `<id>_hub.js` is loaded with the hub's first paint: keep
its imports light; heavy pure code (rules, team codes, the engine) belongs behind the ctl, which pushes results into the model through methods of the app's own.

| Member | When the hub calls it | Returns |
|---|---|---|
| `id`, `paths`, `parent` | read once when the hub is made; they must be the descriptor's (`checkApp`) | |
| `enter(path)` | one of the app's paths became the open screen (from the menu, `ctx.go`, a link, the browser's Back / Forward). A screen opened by its address arrives with whatever state the app has: `enter` returns no effects, so a nested screen that makes no sense yet draws an empty state, or asks for a move from its next `tick(path)` | nothing |
| `leave(path)` | that path is about to stop being the open screen. Called while it still is (`ctx.path() === path`), also for a move to another path of the same app. **Close a text entry here.** | nothing |
| `press(path, action)` | a button: `'up' 'down' 'left' 'right' 'a' 'b' 'x' 'y' 'l' 'r' 'start' 'select'` (a held direction repeats: 400 ms, then every 90 ms). Never while a dialog is open | effects |
| `hit(path, x, y)` | what is under the logical point (0..239, 0..159)? The page shows a hand pointer over anything truthy and plays the menu click on it | any truthy object, or `null` |
| `pointer(path, ev)` | `ev = { kind: 'move', x, y }` (a mouse move, or a finger going down), `{ kind: 'click', x, y }`, `{ kind: 'wheel', steps }` (positive = down; no position). Never while a dialog is open | effects |
| `rects(path)` | the rectangles of the things a pointer can take (tests, and `hub.rects()`) | `[{ x, y, w, h, ... }]` |
| `tick(path)` | ONCE A FRAME (59.7275 Hz) while this path is open, dialog or not. Not called while another screen is open, the tab is hidden, or a test paused the clock | effects or nothing |
| `view(path, base)` | whenever the page wants to draw. `base = { screen, env, mascot, tick, sound }`. Must NOT change state (it is called several times a frame) | the view (below) |
| `onData()` | after every data refresh (`hub.setData`), for EVERY app, open or not | effects or nothing |
| `onDialog(id, value)` | OPTIONAL. A dialog opened for this app was answered (before the page sees the answer) | effects or nothing |
| `wantsText(path)` | is a text entry open on this screen? While true (and no dialog is open) a real keyboard types | boolean |
| `type(path, input)` | only while `wantsText(path)`: `{ text }` (one key, or a whole paste) or `{ key: 'backspace' \| 'delete' \| 'left' \| 'right' \| 'home' \| 'end' \| 'enter' \| 'escape' }` | effects |
| `speak(view)` | the screen reader's words for a view of this app (the canvas has only a static label). Not asked while a text entry or a dialog covers the view | string |
| `title(path)` | the page title of the screen (`'Pokemon Arena - Team Builder'`) | string |
| `state()` | tests and `hub.state().apps[id]` | plain JSON |

Anything else the model has (`setName`, `setRoster`, ...) is the app's own; its ctl reaches it through `env.app`.

**EFFECTS** are plain objects in a list. `ctx.go` / `ctx.back` return the hub's `{ type: 'screen', path, back? }` effects: return them from the press that caused them. **Any effect with a
string `app` is the app's own** and is handed to that app's ctl unchanged, whatever its `type`: `{ app: 'builder', type: 'save', teamId }`. Give every effect of yours `app: '<id>'`.
An effect without `app` and with a type the page does not know is ignored.

**The ctx** (what `create` is given; keep it, call it any time):

| | |
|---|---|
| `profiles()` | the profiles as the store reader built them (`hub_data.js readHubData`): `[{ id, name, readOnly, teams: [{ id, name, size, legal, problems, names, lead, ruleset }], record, tower }]` |
| `activeId()` | the store's active profile id, or null |
| `dataState()` | `'loading'` \| `'ready'` \| `'unavailable'` |
| `go(path)` | open any hub path -> effects (`[]` when the path is unknown or already open) |
| `back()` | open `parent(current path)` -> effects (the screen effect carries `back: true` unless it returns to the main menu) |
| `path()` | the open screen |
| `measure(font, s)` | pixels of `s` in a ROM font (`'normal'`, `'narrow'`, `'small'`, `'smallNarrow'`; 6 px a character when the hub was made without a ROM, as in a model-only test) |
| `msgPx` | the inner width of the message box in pixels (204) |
| `notify(lines)` | a notice over whatever is on the screen: `lines` is an array of lines (two to a page) or one string (word-wrapped). It is a dialog with no choice named `notice:<id>`; a second notify replaces the first -> boolean |
| `dialog` | `{ open(spec), close(id), current() }`: the dialog layer with `app` set to this app, so the answer comes to `onDialog` and to the ctl |

**The view** is plain JSON (no functions, no `undefined`; `null` is fine). The hub forces `screen: path` and `app: id` onto it and adds `dialog` while one is open. What the shell reads:

* `env` (from `base`): the terrain picture the shell lays down before your renderer runs.
* `entry`: a text entry's view or `null` (below). The shell draws it over your picture.
* everything else is yours, for your renderer. Convention used by the stubs: `menu` (what `h.drawMenu` draws), `msg` (two lines for `h.drawMessage`), and one key named after the app.
* The page redraws when `JSON.stringify(view)` changes (the top-level `tick` is compared as `(tick >> 5) & 1`, the mascot's blink). So an app that moves every frame just puts what
  moves in its view; one that does not costs nothing.

### The renderer: `createScreen(ui, h) -> { render(f, view) }`

Pure: `view -> pixels`, from the ROM. `render` is called with a frame `f` on which the shell has already drawn the terrain picture `view.env` (no mascot), and draws the whole screen;
the shell then draws `view.entry` and `view.dialog` over it. A renderer that throws does not stop the page (the last frame stays, the fault is in the console and on
`__arenaHub.renderError`), but it is a bug.

* `f`: `width` 240, `height` 160, `rgba` (Uint8Array), `rect(x, y, w, h, [r, g, b])`, `blit(w, h, rgba, x, y)` (alpha 0 = skip), `blitRoles(bitmap, x, y, fg, shadow)`. Coordinates are floored
  to whole pixels.
* `ui` is `battle_ui.js createBattleUi(rom)`: `ui.drawWindow(f, x, y, w, h)` (a ROM window whose INTERIOR is that rectangle; the 6 px ring is outside it), `ui.panel(f, x, y, w, h, 'normal'
  | 'sel' | 'grey', square)` (the ROM party-menu chip), `ui.partyArt().bg` (the party-menu teal), `ui.TEXT` (`dark white shadow red orange`), `ui.COL`, `ui.measure(font, s)`,
  `ui.fitFont(s, px, fonts)`, `ui.safeText(s)`, `ui.sprite(species, 'foe', { shiny, female, frame })`, `ui.ballRGBA(i, frame)`, `ui.env(i)`, `ui.R.msg` (the message window), `ui.rom` (the
  ROM bytes, for art this module does not decode yet: the Center's maps and overworld sprites).
* `h` (the shell's own drawing helpers): `text(f, font, s, x, y, fg?, shadow?)`, `textRight(f, font, s, rightX, y, fg?, shadow?)`, `textCentre(f, font, s, centreX, y, fg?, shadow?)`,
  `width(font, s)`, `fitFont(s, px, fonts?)`, `fitText(font, s, px)` (cut to fit), `wrap(font, s, px, maxLines?)` (word wrap), `drawMenu(f, menu)` (`menu = { rows, cursor, x?, y?, w?,
  up?, down? }`: the ROM window, the rows, the ROM cursor), `drawMessage(f, [line, line])` (the ROM message box at the bottom), `chip(f, { x, y, w, h }, label, selected)`, `SCREEN_W`,
  `SCREEN_H`. Text tokens the ROM font has: `{CURSOR} {UP} {DOWN} {LEFT} {RIGHT} {E} {MALE} {FEMALE} {LV} {PP}`.

### The ctl: `createCtl(env) -> { effect(eff), enter?(path), leave?(path), dispose?() }`

The only file of an app that navigates, stores, talks to a network or sets a timer. `boot.js` loads it (through `APP_CTLS[id]`) the first time one of the app's screens is entered or
one of its effects appears, and makes it once per page load.

| Called | When |
|---|---|
| `enter(path)` | the hub's path moved INTO the app's family of paths (from outside it) |
| `effect(eff)` | every effect with `app: '<id>'`: the app's own, and a dialog's answer `{ type: 'dialog', id, value, app }` |
| `leave(path)` | the hub's path moved OUT of the family (`path` = the app's last open path). Not called for a move between two paths of the app |
| `dispose()` | the page is going away for good (`pagehide`, not into the back / forward cache) |

Calls arrive in the order the hub produced them, one queue per app, even while the file is still loading (`enter` before the effects of that visit). They are STARTED in order and not
waited for: if `effect` returns a promise the next call may arrive while it is pending. A throw or a rejection is said once in the picture ("<App> hit a problem: ...") and in the
console. **If the file cannot load**, the screen still opens (the model is already there) and a note in the picture says "<App> could not load. Reload the page and try again."; it
is said again each time the screen is opened, and effects for the app are dropped.

**env:**

| | |
|---|---|
| `win`, `doc` | `window`, `document` |
| `hook` | `window.__arenaHub` (put what your browser tests need on it) |
| `model` | the hub model: `model.dialog.open({ ..., app: '<id>' })`, `model.goto(path)`, `model.path()`, `model.state()` |
| `app` | this app's model (what `create(ctx)` returned): call its own methods, then `env.redraw()` |
| `store()` | the profile store (`store.js`), or `null` until it has opened; `whenStore()` -> a promise of it (`null` when storage could not be opened) |
| `pack`, `rom`, `ui` | the ROM tables (`tables.js loadPack`), the ROM bytes, the `battle_ui.js` renderer |
| `navigate(url)` | leave for another page (tests stub it: `window.__arenaNavigate`) |
| `input` | the input layer (`input.js`): `isDown(action)`, `on('action', cb)` (press AND release), `lastSource` |
| `storage`, `session` | `localStorage` / `sessionStorage`, or `null` when blocked (wrap every use in try / catch) |
| `refreshData()` | read the store again and give every screen the new data (`hub.setData`, then every app's `onData`) |
| `redraw()` | draw now (after the ctl changed the app's model) |
| `run(effects)` | carry out effects the ctl got from a model call of its own: `env.run(env.model.goto('center'))` |
| `freshSeed()` | a random unsigned 32-bit integer |

### Effects: who carries what out

`model.press / pointer / type / tick / setData / goto` return effects; `boot.js run(effects)` walks them in order:

1. `typeof eff.app === 'string'` -> that app's ctl: `ctl.effect(eff)`. (Checked FIRST, so an app may use any `type`, even one the hub also has.)
2. `{ type: 'screen', path, back? }` -> the browser history (a push, or one step back for `back` / a return to `main`), the title, and the family sync (the ctls' `enter` / `leave`).
3. the hub's own: `navigate`, `sound`, `controls`, `battle`, `record-reset`, `tower-*`.
4. `{ type: 'dialog', id, value }` with no `app` -> nothing (whoever opened it without an app does not need the page).

### The dialog layer

One per hub, over ANY screen (`hub.dialog`, `ctx.dialog`, `env.model.dialog`). It is what "<name> wants to battle you" uses.

```js
hub.dialog.open({ id: 'challenge', app: 'online',                      // -> true (shown, or queued) | false (refused)
  pages: [['RED wants to battle you.', '3v3, standard rules.']],        // 1..16 pages of one or two lines (a string = a one-line page)
  choice: { options: ['YES', 'NO'], cursor: 1 },                        // or null: a notice. 1..4 non-empty options; cursor = the one highlighted first
  ticksLeft: 1800 });                                                   // optional: frames until it answers 'timeout' by itself
hub.dialog.close('challenge');      // -> true when it was open or queued. Emits NO effect
hub.dialog.current();               // -> { id, app, page, pages, choice: { options, cursor } | null, ticksLeft } | null
hub.dialog.isOpen();
```

* **While one is open it takes EVERY press and pointer event** (the screen under it hears none; it is still ticked and drawn). `hub.hit` / `hub.rects` are the dialog's.
* A turns the page; the options are shown with the LAST page, where A chooses the highlighted one. **B is the last option (NO), from any page.** The d-pad (and L / R, the wheel) moves the
  highlight and wraps. A click on an option chooses it; a hover highlights it; a click on the text turns the page but **never answers a question**; a click elsewhere does nothing.
  A notice (no choice) closes on A at its end, on B at once, on a tap on its text at its end.
* **The answer is an effect: `{ type: 'dialog', id, value, app? }`**, `value` = the option's index, `'timeout'`, or `'closed'` (a notice was read or dismissed). With `app`, that app's
  model hears it first (`onDialog(id, value)`, whose effects follow the answer's), then its ctl (`effect`). It reaches them whatever screen is open.
* **A SECOND `open` WHILE ONE IS OPEN IS QUEUED** (first in, first shown; 8 dialogs in all). `open` REFUSES, returning `false` and changing nothing: a malformed spec, an id that is already
  open or queued, a full queue. `ticksLeft` counts only while the dialog is the one shown, and the hub's clock stops while the tab is hidden: a ctl that needs real time keeps its own
  timer and calls `close(id)`.
* A line must fit the message box: `ctx.msgPx` pixels in the normal font (`wrapDialog(text, ctx.measure, ctx.msgPx)` makes pages from a long text). Options are drawn in a ROM window
  above the box, as wide as the longest label.
* While a dialog is open over a text entry, `hub.wantsText()` is false: a real keyboard's Z / X / Enter answer the dialog.

### Text entry

One component for every name, nickname, search word, room code and team code. The model is `textentry.js`; an app holds it in a **slot** and puts the slot's view in `view.entry`:

```js
import { createEntrySlot } from './textentry.js';
const entry = createEntrySlot();                                   // at most one open entry
// open one (from a press): the function gets the RESULT and returns effects
entry.open({ id: 'nick', title: 'NICKNAME?', value: S.nick, max: 10, charset: 'name' },
  (r) => { if (!r.ok) return []; S.nick = r.value.trim(); return [{ app: ID, type: 'renamed', value: S.nick }]; });
// the app's methods: every slot method answers undefined while no entry is open, so the app's own handling follows
press(path, a) { const fx = entry.press(a); if (fx) return fx; /* own keys */ },
pointer(path, ev) { const fx = entry.pointer(ev); if (fx) return fx; /* own pointer */ },
hit(path, x, y) { return entry.isOpen() ? entry.hit(x, y) : /* own hit */ null; },
rects(path) { return entry.isOpen() ? entry.rects() : /* own rects */ []; },
wantsText: () => entry.isOpen(),
type: (path, input) => entry.type(input) || [],
leave() { entry.close(); },
view(path, base) { return { ...base, /* ... */ entry: entry.view() }; },      // null when closed
```

* **Options** (`createTextEntry` / `slot.open`): `id`, `title`, `value` (filtered by the charset, cut to `max`), `max` (1..1024), `charset`, `allowEmpty` (default false), `min` (the
  shortest value OK accepts when `allowEmpty` is not set; default 1), `mask` (one character shown for every character typed; the real text never enters the view).
* **The result**: `{ id, ok: true, value }` (OK; the value is exactly what was typed: trim it yourself) or `{ id, ok: false }` (CANCEL).
* **Charsets**: `'name'` = what `profile.js textIssue` accepts, one character at a time (a test compares all 65,535 code units); `'code'` = A-Z 0-9, a lower-case letter becomes its
  capital; `'teamcode'` = A-Z a-z 0-9 `.` `-` `_`, with `/` typed as `_` and `+` as `-`, white space dropped (a real ARENA1 code pasted with line breaks arrives whole); `'search'` = A-Z
  a-z 0-9, space, hyphen, apostrophe. `mapChar(charset, ch)` / `filterText(charset, s)` are the rules. **The ROM font has no underscore**: a key and the field show `_` as the ROM's
  `/` glyph (`glyphOf`), which no team code contains.
* **Input**: the d-pad walks the keys (rows wrap, a shorter row takes the nearest key), A types the key (or abc / SPACE / DEL / CANCEL / OK), B deletes one character and **B on an
  empty field cancels**, START = OK, SELECT = abc / ABC, L / R move the caret; a tap or click on a key presses it. **A real keyboard types directly** (`type({ text })`), and its
  Backspace, Delete, left / right, Home, End, Enter (OK) and Escape (CANCEL) arrive as `type({ key })`. A real keyboard's Backspace on an empty field does nothing (only the B button
  cancels there). A paste is one `type({ text })` with everything pasted.
* **The page side** (`boot.js`): while `hub.wantsText()` and no DOM dialog (Controls, Sound, the music list) is open, a window-level capture listener takes printable keys and the eight
  named keys, calls `hub.type`, and stops them from reaching the input layer (so Z X W A S D M P and Enter are not buttons, and M does not mute). Ctrl / Meta / Alt combinations are left
  alone; a `paste` event delivers its text; the up / down arrows still walk the picture's keys; Tab is never taken, and Enter / Space on a focused page button press that button.
* **Drawing**: the whole picture (party-menu teal, a ROM window for the title, the `length/max` count and the field, a ROM window for the keys, ROM chips). The field NEVER overflows: a
  value wider than it is shown around the caret (`fieldWindow`), with the ROM's arrows where it goes on; a team code is set in the small font. Geometry: `TEGEOM`; a key is 16 x 14
  logical pixels.

### `hub_menu.js` (optional)

`createMenu({ x, y, w }?)`: `press(action, rows)` / `pointer(ev, rows)` -> `null` | `{ kind: 'move', index }` | `{ kind: 'choose', row, index }` | `{ kind: 'change', row, index, dir }` |
`{ kind: 'refused', row, index }` (a disabled row) | `{ kind: 'back' }`; `hit(x, y, rows)`, `rects(rows)`, `view(rows)` (what `h.drawMenu` draws), `cursor()`, `setCursor(i)`, `select(id,
rows)`. A row is `{ id, kind: 'item' | 'button' | 'choice', label, value?, disabled? }`. Up to eight rows fit above the message box (`menuPitchFor`).

### Testing an app in Node

```js
import * as L from './pokemonarena_hub_lib.mjs';
const HM = await L.mod('hub_model.js'), HS = await L.mod('hub_screen.js'), B = await L.mod('battle_ui.js');
const ui = B.createBattleUi(L.readRom()), screen = HS.createHubScreen(ui);
const hub = HM.createHubModel({ mascot: 25, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });   // the real font; omit the three for a model-only test
hub.setData({ state: 'ready', activeId: 'p1', profiles: [/* readHubData's shape */] });
hub.goto('builder');                              // -> effects; or walk there with hub.press(...)
const fx = hub.press('a');                        // scripted presses return the effects
hub.type({ text: 'Red' }); hub.pointer({ kind: 'click', x: 60, y: 18 }); hub.tick();
const frame = screen.render(hub.view());          // { width: 240, height: 160, rgba }: assert on pixels, or L.fnv(frame.rgba) for a golden hash
hub.state().apps.builder                          // your state(); hub.apps.builder is your model
```

* Your own registry for a test: `HM.createHubModel({ apps: [MY_APP] })` hosts only the descriptors given (`tools/pokemonarena_apps_test.mjs fakeApp` is a recording app).
* Your ctl: `createCtl(fakeEnv)` with a fake `navigate`, `session`, `store`, and `app: hub.apps.<id>`.
* Golden pictures: keep them in a golden file of your own suite (hashes only, never pixels), as `tools/pokemonarena_hub_test.mjs` does for the shell with `hub.golden.json` (`--update`).
* In a browser (`tools/headless_cdp.mjs`): `window.__arenaHub` has `press(a)`, `pointer(ev)`, `type(input)`, `goto(path)`, `wantsText()`, `view()`, `tick(n)`, `pause(bool)`, `frameHash()`,
  `canvasHash()`, `dialog` (the layer), `apps` (`ids`, `state()`, `family()`, `loaded()`, `errors()`, `ctl(id)`, `load(id)`, `idle(id)`, `effect(eff)`), `appEffects`, `typed`.

### The stubs (what is there until an app is written)

| App | Path (parent) | What it does today |
|---|---|---|
| `online` | `online` (main) | TRAINER CENTER -> the `center` screen; BATTLE ONLINE -> `{ app: 'online', type: 'open-battle' }`, which its ctl carries out by leaving for `battle.html?online=1`; BACK |
| `center` | `center` (online) | counts the seconds the player has been there (`tick`), shows the last answer a dialog gave it (`onDialog`); BACK. Its ctl only records what it is asked |
| `builder` | `builder` (main) | NAME -> a `'name'` text entry (max 10), shown on the row, kept for the tab by its ctl (`sessionStorage`); TEAM CODE -> a `'teamcode'` entry (max 1024); OPEN TEAM BUILDER -> its ctl leaves for `editor.html`; BACK |

### When you replace a placeholder

The three stubs are tested as what they are. These are ALL the places in the suites that know what a placeholder shows or does; everything else uses test-only apps (`fakeApp`,
`typerApp` in `tools/pokemonarena_apps_test.mjs`), hand-made views, or the hub's own screens, and holds whatever your app becomes:

| Where | What is tied to a placeholder |
|---|---|
| `tools/pokemonarena_apps_test.mjs`, family X (`checkStubs`) and the mutants with `fam: 'X'` | every row, effect, parent and ctl of the three stubs, and their pictures. Rewrite the part about your app, or move it to a suite of your own |
| the same file's browser sessions | `keys`: the rows of PLAY ONLINE, the Center's seconds, the builder's NAME / TEAM CODE entries (the "a real keyboard types" and paste cases run on them), the dialog over the Center. `touch`, `pad`: the same rows. `broken`: a `builder_ctl.js` with no `createCtl`, a `center_screen.js` that throws. `control`: the builder's NAME entry. **What these prove about the shell must be kept**: point them at your screens |
| `tools/pokemonarena_journey_test.mjs`, step 2 | TEAM BUILDER opens `builder`, then the row with id `editor` leaves for `editor.html` |
| `tools/pokemonarena_hub_test.mjs` | nothing a stub shows: only that PLAY ONLINE opens `online` and TEAM BUILDER opens `builder` (address `#builder`, a title that contains "Team Builder") and that B returns |

`hub.golden.json` holds no picture of a stub (the text entry and the dialog are drawn there over the main menu). The ids `online`, `center`, `builder`, and a path of the same name for
each, are what the main menu, the registries and these suites rely on: keep them.

### What the foundation left outside the picture

* The row under the picture (`#onlineLink`: Play online, Trainer Center, Open) and `presence_boot.js`'s DOM dialogs: the online work removes them.
* `BATTLE WITH MY TEAM` with no team, and the RECORD screen with no profile, still offer a TEAM BUILDER button that leaves for `editor.html` (`hub_model.js BUILDER_URL`), as does
  IMPORT SAVE (`IMPORT_URL`). When the builder is in the picture these become `go('builder')`: two lines in `hub_model.js`, with their checks in `tools/pokemonarena_hub_test.mjs`,
  `tools/pokemonarena_record_test.mjs` and `tools/pokemonarena_stats_page_test.mjs`.
* B from a screen goes to `parent(path)`. A screen opened from somewhere else (the builder from the Center's PC) returns there through the browser history, which the page follows: the
  model shows the parent for one frame first.
