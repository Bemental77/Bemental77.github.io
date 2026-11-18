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

Written by the foundation work (2026-11-17) and corrected after its review. It is exact: every name below is the name in the code, and `tools/pokemonarena_apps_test.mjs` pins it: Node checks in
families (the registry and the delegation, NAVIGATION, AN APP THAT THROWS, the dialog layer, the text entry, the renderers, this document's names), each with source mutants that must trip a
named check, and five browser sessions. If the code and this section ever disagree, the code and its tests are right and this section is a bug.

### The pieces

| File | What it is |
|---|---|
| `js/hub_apps.js` | THE REGISTRY of app models: `APPS` (the descriptors), `checkRegistry`, `checkApp`, `createAppHost` (which also GUARDS every call the hub makes on an app's model). Pure. |
| `js/hub_app_screens.js` | the registry of app renderers: `APP_SCREENS = { id: createScreen }`. Pure. |
| `js/hub_app_ctls.js` | the registry of app ctls: `APP_CTLS = { id: () => import('./<id>_ctl.js') }` (nothing is loaded until the function is called). |
| `js/hub_model.js` | the shell's state machine. Delegates to the open app, owns the TRAIL and the dialog layer, exports `PATHS`, `parentOf`, `arrivalTrail`, `historySeedPlan`, `historyPlan`, `entryTrail`, `ACTIONS`, `HELD_NONE`, `heldOf`. |
| `js/hub_dialog.js` | the dialog layer (pure): `createDialogLayer`, `normalizeDialog`, `optionRects`, `wrapDialog`, `speakDialog`, `DGEOM`, `DIALOG_ARM_TICKS`. |
| `js/textentry.js` | text entry (pure model): `createTextEntry`, `createEntrySlot`, `mapChar`, `filterText`, `keyboardOf`, `keyRect`, `fieldWindow`, `glyphOf`, `speakEntry`, `CHARSETS`, `TEGEOM`. |
| `js/textentry_screen.js` | draws an entry view from the ROM: `createTextEntryScreen(ui, h) -> { draw(f, entryView, tick), layout(entryView) }`. |
| `js/hub_menu.js` | OPTIONAL helper (pure): a cursor over a list of rows with the main menu's own behaviour: `createMenu`, `MENU`, `menuPitchFor`. |
| `js/hub_screen.js` | the shell's renderer: draws the app's view through its renderer, then `view.entry`, then `view.dialog`. |
| `js/boot.js` | the page: loads ctls lazily, routes effects, keeps the browser's history equal to the trail, sends a real keyboard's keys and pastes to `hub.type`, mirrors speech and the title. |

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
  screen), and following it from any path must reach `'main'`. It is where B goes from a screen that was reached the usual way, and it gives a page opened at `#<path>` the history entries
  of the screens on the way (`arrivalTrail('center')` is `['online', 'center']`).

### The app model: what `create(ctx)` returns

Pure: no DOM, no ROM, no clock, no storage, no network, no randomness, no dynamic import (a test greps the stubs for these). `<id>_hub.js` is loaded with the hub's first paint: keep
its imports light; heavy pure code (rules, team codes, the engine) belongs behind the ctl, which pushes results into the model through methods of the app's own.

| Member | When the hub calls it | Returns |
|---|---|---|
| `id`, `paths`, `parent` | read once when the hub is made; they must be the descriptor's (`checkApp`) | |
| `enter(path)` | one of the app's paths became the open screen (from the menu, `ctx.go`, a link, the browser's Back / Forward), also for a move between two paths of the app. A screen opened by its address arrives with whatever state the app has: draw an empty state, or return a move (`ctx.go(...)`) | effects or nothing. They follow the `screen` effect of the move, so **this is how a nested screen tells its ctl it was opened**: `return [{ app: ID, type: 'opened', path }]` |
| `leave(path)` | that path is about to stop being the open screen. Called while it still is (`ctx.path() === path`), also for a move to another path of the same app. **Close a text entry and your own questions here** (`ctx.dialog.close(id)`) | nothing |
| `press(path, action, info)` | a button: `'up' 'down' 'left' 'right' 'a' 'b' 'x' 'y' 'l' 'r' 'start' 'select'`. `info = { repeat }`: `false` for a fresh press, `true` for the synthesized repeat of a HELD direction (400 ms, then every 90 ms; A and B never repeat). Never while a dialog is open | effects |
| `hit(path, x, y)` | what is under the logical point (0..239, 0..159)? The page shows a hand pointer over anything truthy and plays the menu click on it | any truthy object, or `null` |
| `pointer(path, ev)` | `ev = { kind: 'move', x, y }` (a mouse move, or a finger going down), `{ kind: 'click', x, y }`, `{ kind: 'wheel', steps }` (positive = down; no position). Never while a dialog is open | effects (carried out for a move as for a click) |
| `rects(path)` | the rectangles of the things a pointer can take (tests, and `hub.rects()`) | `[{ x, y, w, h, ... }]` |
| `tick(path, held)` | ONCE A FRAME (59.7275 Hz) while this path is open, dialog or not. `held`: the buttons the player is HOLDING, a frozen `{ up, down, left, right, a, b, x, y, l, r, start, select }` of booleans (`HELD_NONE`, all false, while a dialog is open over the screen or a DOM panel is up). Not called while another screen is open, the tab is hidden, or a test paused the clock | effects or nothing |
| `view(path, base)` | whenever the page wants to draw. `base = { screen, env, mascot, tick, sound }`. Must NOT change state (it is called several times a frame) | the view (below) |
| `onData()` | after every data refresh (`hub.setData`), for EVERY app, open or not | effects or nothing |
| `onDialog(id, value)` | OPTIONAL. A dialog opened for this app was answered (before the page sees the answer). It can arrive while another screen is open | effects or nothing |
| `wantsText(path)` | is a text entry open on this screen? While true (and no dialog is open) a real keyboard types | boolean |
| `type(path, input)` | only while `wantsText(path)`: `{ text }` (one key, or a whole paste) or `{ key: 'backspace' \| 'delete' \| 'left' \| 'right' \| 'home' \| 'end' \| 'enter' \| 'escape' }` | effects |
| `speak(view)` | the screen reader's words for a view of this app (the canvas has only a static label). Not asked while a text entry or a dialog covers the view. The page writes them into a polite live region whenever they CHANGE: **leave out anything that changes by itself** (a clock, a position), or it is read out every time | string |
| `title(path)` | the page title of the screen (`'Pokemon Arena - Team Builder'`) | string |
| `state()` | plain JSON, for tests and `hub.state().apps[id]`. **It also decides the default menu sound**: the page compares `hub.state()` before and after every press (so it is called twice per press: keep it small), and a d-pad or B press that changed it is heard (below, "Sound") | plain JSON |

Anything else the model has (`setName`, `setRoster`, ...) is the app's own; its ctl reaches it through `env.app`.

**EFFECTS** are plain objects in a list. `ctx.go` / `ctx.back` return the hub's `screen` effects: return them from the press that caused them. **Any effect with a string `app` is the
app's own** and is handed to that app's ctl unchanged, whatever its `type`: `{ app: 'builder', type: 'save', teamId }`. Give every effect of yours `app: '<id>'`. The one hub effect an app
returns WITHOUT `app` is `{ type: 'sfx', key }` ("Sound"). An effect without `app` and with a type the page does not know is ignored.

**The ctx** (what `create` is given; keep it, call it any time):

| | |
|---|---|
| `profiles()` | the profiles as the store reader built them (`hub_data.js readHubData`): `[{ id, name, readOnly, teams: [{ id, name, size, legal, problems, names, lead, ruleset }], record, tower }]` |
| `activeId()` | the store's active profile id, or null |
| `dataState()` | `'loading'` \| `'ready'` \| `'unavailable'` |
| `go(path, opts?)` | open a hub path -> effects (`[]` when the path is unknown or already open). `opts = { replace: true }` opens it IN PLACE of the open screen. The rule is "Navigation", below |
| `back()` | one step down the trail (where the player came from) -> effects |
| `path()` | the open screen |
| `trail()` | the screens above the main menu that lead to the open one, outermost first (`['online', 'center']`; a copy) |
| `measure(font, s)` | pixels of `s` in a ROM font (`'normal'`, `'narrow'`, `'small'`, `'smallNarrow'`; 6 px a character when the hub was made without a ROM, as in a model-only test). Never throws |
| `msgPx` | the inner width of the message box in pixels (204) |
| `notify(lines)` | a notice over whatever is on the screen: `lines` is an array of lines (two to a page) or one string (word-wrapped). It is a dialog with no choice named `notice:<id>`; a second notify replaces the first -> `true`, or `false` when there is nothing to say (`null`, `[]`, `''`, only blank lines: no empty box is opened) |
| `dialog` | `{ open(spec), close(id), current() }`: the dialog layer with `app` set to this app, so the answer comes to `onDialog` and to the ctl. `close(id)` closes only a dialog that was opened for THIS app |

**The view** is plain JSON (no functions, no `undefined`; `null` is fine). What the shell reads, and so what the keys below mean whoever writes them:

* `screen`, `app`: the hub forces them to the path and the id.
* `env` (from `base`): the terrain picture the shell lays down before your renderer runs. `tick` (from `base`): the hub's clock; the shell blinks the text entry's caret by it. Spread `base` into your view.
* `entry`: a text entry's view or `null` (below). The shell draws it over your picture.
* `dialog`: the HUB's. The hub adds it while a dialog is open and DROPS one your view carries. `fault`: the hub's too (set when your `view()` threw: "An app that throws").
* everything else is yours, for your renderer. Convention used by the stubs: `menu` (what `h.drawMenu` draws), `msg` (two lines for `h.drawMessage`), and one key named after the app.
* The page redraws when `JSON.stringify(view)` changes (the top-level `tick` is compared as `(tick >> 5) & 1`, the mascot's blink). So an app that moves every frame just puts what
  moves in its view; one that does not costs nothing.

### Navigation: the trail

The hub keeps a TRAIL: the screens above the main menu that lead to the open one, outermost first (`hub.trail()`, `ctx.trail()`; `[]` on the main menu). B walks down it. The page keeps the
browser's history EQUAL to it, one entry per screen, so B, the browser's Back button, a reload and a deep link all agree, and the history does not grow. One rule, for the hub's own screens,
the Tower and every app:

| Call | What happens |
|---|---|
| `ctx.go(path)` to a screen that is **on the trail, or `'main'`** | it is STEPPED BACK TO: everything above it is dropped ("saved: back to the team list", "deleted: up two levels", "home"). Effect: `{ type: 'screen', path, back: true, steps: n }` (`back` is left out for `'main'`, `steps` when it is one entry) |
| `ctx.go(path)` to any other screen | it opens ON TOP of the open one: B returns to the screen it was opened FROM, whatever `parent(path)` says (the builder opened from the Center's PC returns to the Center). Effect: `{ type: 'screen', path }`. **From the main menu** the screens that lead to it by `parent()` are put under it (the history its address would have), so a nested screen opened straight from the menu steps back to its parent |
| `ctx.go(path, { replace: true })` | it opens IN PLACE of the open one (a wizard's next step, a redirect): B then goes where B went from the screen replaced. Effect: `{ type: 'screen', path, replace: true }`. On the main menu it is a plain `go` (the menu is never replaced); to a screen on the trail it is a step back |
| `ctx.back()` | one step down the trail. For a screen reached the usual way that is `parent(path)` |

* **Return what they give you, in any combination.** A list holding a step back and a go (`[...ctx.back(), ...ctx.go('builder')]`) is ONE history change: the page compares where the model
  stands at the end with the entry the browser is on (`historyPlan`) and steps back, replaces or pushes accordingly. The screen in between is never shown.
* A screen is on the trail at most once (going to it again steps back to it), so the trail cannot grow without end.
* `hub.goto(path, opts)` is the same rule from outside the model: what a ctl navigates with, `env.run(env.model.goto('center'))`.
* **The other direction**: when the ADDRESS moves (the page boots at `#center`, the browser's Back or Forward lands on an entry) the page calls `hub.arrive(path, trail)`: the model opens
  the screen with the trail that history entry recorded (every entry the page writes carries `{ arenaHub: path, trail }`; one without it gets the `parent()` chain), your `leave` / `enter` run
  as for any move, and what `enter` returns is carried out. So "the browser's Back was pressed under an open text entry" is just `leave(path)`.

### An app that throws

The hub never calls an app's model directly: `hub_apps.js` wraps every method in a guard (the method is looked up when it is called, so a ctl or a test may replace one). A throw costs that
ONE call, never the hub:

* the call answers "nothing": no effects (`press`, `pointer`, `tick`, `type`, `enter`, `onData`, `onDialog`), `null` (`hit`), `[]` (`rects`), `false` (`wantsText`), `''` (`speak`, `title`);
* a `view()` that throws becomes `{ ...base, screen, app, fault: { where, message } }`, for which the shell draws its own note ("This screen hit a problem. B goes back.");
* **the B press that throws still goes back**, so a player is never locked in a screen that broke;
* a closed app that throws in `onData()` does not stop the data refresh for the others;
* each distinct fault (app, method, message) is said ONCE: in the console (`[apps] <id> <method>() threw: ...`), on `__arenaHub.appFaults`, and as a notice in the picture ("<App> hit a
  problem: ..."). `hub.faults()` is the list the page drains.

The same holds for the other two files: a `createScreen` or a `render(f, view)` that throws draws the shell's note in place of the app's picture (`__arenaHub.renderError`, the console once),
a ctl that cannot load or whose `effect` throws or rejects is said in the picture, and nothing that throws inside a frame stops the page's clock (the next frame is asked for first).
A descriptor or a model that does not meet the contract (`checkRegistry`, `checkApp`) is different: that is refused when the hub is made, by name, so that every test sees it.

### The renderer: `createScreen(ui, h) -> { render(f, view) }`

Pure: `view -> pixels`, from the ROM. **`createScreen` is called ONCE, the first time one of the app's views is drawn** (not when the hub is made: the hub's first paint waits for no app).
Decode there what every screen of the app needs; decode the rest when it is first drawn. `<id>_screen.js` itself is in the hub's first-paint module graph (`hub_app_screens.js` imports it):
keep its imports light. `render` is called with a frame `f` on which the shell has already drawn the terrain picture `view.env` (no mascot), and draws the whole screen; the shell then draws
`view.entry` and `view.dialog` over it.

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
* **Any text can be drawn and measured.** `h.text`, `h.width`, `ui.measure`, `ui.fitFont` and `ctx.measure` all pass through `ui.safeText`, which turns what the font cannot draw into `?`: a
  character it lacks, and every `{...}` that is not one of the tokens above (a remote trainer's name may hold `RED{NOPE}`). Only `ui.assets.drawText` called directly can still throw.

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

* **A move between two screens of the app** is not told to the ctl by the page: have the model's `enter(path)` return an effect of yours (`[{ app: ID, type: 'opened', path }]`).
* **A ctl that must run from the page's load** (presence: "<name> wants to battle you" while the player is on the main menu) is started by the model: return an effect of yours from
  `onData()`. Every data refresh calls `onData()` of every app, open or not, the first one right after the page is up (also when storage could not be opened), and the first effect
  with your `app` loads your ctl.
* **Time.** `tick(path, held)` counts FRAMES while your screen is open and the tab is visible (after a stall at most eight are caught up, the rest are dropped), and a dialog's `ticksLeft`
  counts the same way. Anything that needs real time or runs while your screen is closed (a network session, a deadline) is the ctl's: its own timers, and its own `pagehide` / `pageshow`
  listeners (`dispose()` is NOT called when the page goes into the back / forward cache).

**env:**

| | |
|---|---|
| `win`, `doc` | `window`, `document` |
| `hook` | `window.__arenaHub` (put what your browser tests need on it) |
| `model` | the hub model: `model.dialog.open({ ..., app: '<id>' })`, `model.goto(path, opts)`, `model.path()`, `model.trail()`, `model.state()` |
| `app` | this app's model (what `create(ctx)` returned): call its own methods, then `env.redraw()` |
| `store()` | the profile store (`store.js`), or `null` until it has opened; `whenStore()` -> a promise of it (`null` when storage could not be opened) |
| `pack`, `rom`, `ui` | the ROM tables (`tables.js loadPack`), the ROM bytes, the `battle_ui.js` renderer |
| `navigate(url)` | leave for another page (tests stub it: `window.__arenaNavigate`) |
| `input` | the input layer (`input.js`): `isDown(action)`, `on('action', cb)` (press AND release), `lastSource`. For "which buttons are held" use the model's `tick(path, held)` instead: it is gated like the presses (nothing while a DOM panel or a dialog has the buttons), `isDown` is not |
| `storage`, `session` | `localStorage` / `sessionStorage`, or `null` when blocked (wrap every use in try / catch) |
| `refreshData()` | read the store again and give every screen the new data (`hub.setData`, then every app's `onData`) |
| `redraw()` | draw now (after the ctl changed the app's model) |
| `run(effects)` | carry out effects the ctl got from a model call of its own: `env.run(env.model.goto('center'))` |
| `freshSeed()` | a random unsigned 32-bit integer |
| `sound` | the sound, always there and never throwing: `sound.sfx(key)` plays one ROM sound effect (`'se_select'`, `'se_success'`, `'se_menu_open'`...: `SFX_KEYS` of `music_map.js`), `sound.music(screenKey)` says which screen's music the hub plays (`'hub'`, `'pokecenter'`, `'town'`...: a music key of `music_map.js`; the player's own pick in the audio bar still wins; set it back to `'hub'` when you leave), `sound.system()` is `sound_system.js` itself or `null` |

### Effects: who carries what out

`model.press / pointer / type / tick / setData / goto / arrive` return effects; `boot.js run(effects)` walks them in order:

1. `typeof eff.app === 'string'` -> that app's ctl: `ctl.effect(eff)`. (Checked FIRST, so an app may use any `type`, even one the hub also has.)
2. `{ type: 'screen', path, back?, steps?, replace? }` -> the browser history is made equal to `hub.trail()` (a push, a step back, a replace), the title, and the family sync (the ctls'
   `enter` / `leave`).
3. `{ type: 'sfx', key }` -> that sound effect is played (`key: null`: none).
4. the hub's own: `navigate`, `sound`, `controls`, `battle`, `record-reset`, `tower-*`.
5. `{ type: 'dialog', id, value }` with no `app` -> nothing (whoever opened it without an app does not need the page).

### Sound

The page plays the hub's menu sounds for every screen, an app's included: A is the select sound, a d-pad press that CHANGED `hub.state()` (which holds your `state()`) is the cursor
sound, a B that changed it is the back sound, a click on anything `hit()` returns is the select sound. **A press or a click decides its own sound by returning `{ type: 'sfx', key }`** (no
`app`) among its effects: the default is then NOT played, and the keys named are (in order). `key: null` names none, so `[{ type: 'sfx', key: null }]` is a silent press: a walking room
returns it for its steps, or `{ type: 'sfx', key: 'se_...' }` for a door, a bump, a PC. An `sfx` effect from `tick`, `onData` or `enter` is simply played. A ctl plays one with
`env.sound.sfx(key)` and changes the music with `env.sound.music(screenKey)`. Nothing is heard while the sound is muted or not started, and a key the soundtrack in use lacks is silent.

### The dialog layer

One per hub, over ANY screen (`hub.dialog`, `ctx.dialog`, `env.model.dialog`). It is what "<name> wants to battle you" uses.

```js
import { DIALOG_ARM_TICKS } from './hub_dialog.js';
hub.dialog.open({ id: 'online:challenge', app: 'online',               // -> true (shown, or queued) | false (refused)
  pages: [['RED wants to battle you.', '3v3, standard rules.']],        // 1..16 pages of one or two lines (a string = a one-line page)
  choice: { options: ['YES', 'NO'], cursor: 1 },                        // or null: a notice. 1..4 non-empty options; cursor = the one highlighted first
  armTicks: DIALOG_ARM_TICKS,                                           // optional: frames during which it answers NOTHING (36 = 0.6 s). See below
  ticksLeft: 1800 });                                                   // optional: frames until it answers 'timeout' by itself
hub.dialog.close('online:challenge');   // -> true when it was open or queued. Emits NO effect
hub.dialog.current();                   // -> { id, app, page, pages, choice: { options, cursor } | null, ticksLeft, armed } | null
hub.dialog.isOpen();
```

* **While one is open it takes EVERY press and pointer event** (the screen under it hears none and is told no button is held; it is still ticked and drawn). `hub.hit` / `hub.rects` are the
  dialog's.
* A turns the page; the options are shown with the LAST page, where A chooses the highlighted one. **B is the last option (NO), from any page.** The d-pad (and L / R, the wheel) moves the
  highlight and wraps. A click on an option chooses it; a hover highlights it; a click on the text turns the page but **never answers a question**; a click elsewhere does nothing.
  A notice (no choice) closes on A at its end, on B at once, on a tap on its text at its end.
* **`armTicks`: A QUESTION THE PLAYER DID NOT ASK FOR MUST PASS IT** (`DIALOG_ARM_TICKS`). For that many ticks after the dialog becomes the one shown it answers nothing and turns no page:
  not on A, not on B, not on a click or a tap; the highlight can be moved and the timeout still counts. Without it the A that was on its way to the menu underneath accepts the battle.
  The picture shows it: the cursor (and the "more" arrow) appear when the dialog starts to listen. The default is 0: a question the player's own press opened ("DELETE THIS TEAM?")
  answers at once. A dialog whose `ticksLeft` would run out before it is armed is refused.
* **One press, one step.** The repeats of a HELD direction never move a dialog's highlight (and answer nothing), so a direction held since before the question appeared cannot drift it
  from NO onto YES.
* **The answer is an effect: `{ type: 'dialog', id, value, app? }`**, `value` = the option's index, `'timeout'`, or `'closed'` (a notice was read or dismissed). With `app`, that app's
  model hears it first (`onDialog(id, value)`, whose effects follow the answer's), then its ctl (`effect`). It reaches them whatever screen is open.
* **A SECOND `open` WHILE ONE IS OPEN IS QUEUED** (first in, first shown; 8 dialogs in all). `open` REFUSES, returning `false` and changing nothing: a malformed spec, an id that is already
  open or queued, a full queue. `ticksLeft` and `armTicks` count only while the dialog is the one shown, and the hub's clock stops while the tab is hidden: a ctl that needs real time keeps
  its own timer and calls `close(id)`.
* **Dialogs belong to the hub, not to a screen**: one stays open when the player leaves the screen that asked (the browser's Back does not close it), and its answer still arrives. Close
  your own questions in `leave(path)` when they make no sense elsewhere, and let `onDialog` cope with an answer that arrives while your screen is closed. **Ids are global**: prefix yours
  with your app id (`'online:challenge'`); `notice:<id>` and `app:<id>` are the hub's. `ctx.dialog.close(id)` closes only your own; `hub.dialog.close(id)` closes any.
* A line should fit the message box: `ctx.msgPx` pixels in the normal font (`wrapDialog(text, ctx.measure, ctx.msgPx)` makes pages from a long text). Options are drawn in a ROM window
  above the box, as wide as the longest label. Any text is safe to pass (a remote trainer's name): what the font cannot draw is a `?`.
* **A dialog over a text entry.** `hub.wantsText()` is then false (`hub.textUnder()` is true) and nothing is typed. The word being typed must not answer the question either: while a dialog covers an open text entry
  the page DROPS a real keyboard's printable keys (Z is not A, X is not B there); Enter, Escape, Backspace and the arrows answer it as on any screen (use `armTicks` for the Enter that was
  already on its way), and so do the pad, the on-screen buttons and a tap.

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
  alone; a `paste` event delivers its text; the up / down arrows still walk the picture's keys; Tab is never taken, and Enter / Space on a focused page button press that button; a dead
  key (an accent waiting for its letter) is dropped: it is not a letter yet and never a button.
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
hub.goto('builder');                              // -> effects; or walk there with hub.press(...). hub.trail() -> ['builder']
const fx = hub.press('a');                        // scripted presses return the effects; hub.press('down', { repeat: true }) is a held direction's repeat
hub.type({ text: 'Red' }); hub.pointer({ kind: 'click', x: 60, y: 18 });
hub.tick(['left']);                               // one frame with LEFT held (hub.tick() = nothing held)
hub.arrive('builder-team', ['builder', 'builder-team']);   // "the browser landed on this entry": no screen effect, the trail as given
const frame = screen.render(hub.view());          // { width: 240, height: 160, rgba, fault? }: assert on pixels, or L.fnv(frame.rgba) for a golden hash
hub.state().apps.builder                          // your state(); hub.apps.builder is your model
hub.faults()                                      // [] unless something of yours threw: assert it at the end of every scripted run
```

* Your own registry for a test: `HM.createHubModel({ apps: [MY_APP] })` hosts only the descriptors given, and `HS.createHubScreen(ui, { appScreens: { myid: createScreen } })` draws them
  (`tools/pokemonarena_apps_test.mjs fakeApp` is a recording app).
* Your ctl: `createCtl(fakeEnv)` with a fake `navigate`, `session`, `store`, `sound`, and `app: hub.apps.<id>`.
* Golden pictures: keep them in a golden file of your own suite (hashes only, never pixels), as `tools/pokemonarena_hub_test.mjs` does for the shell with `hub.golden.json` (`--update`).
* In a browser (`tools/headless_cdp.mjs`): `window.__arenaHub` has `press(a, info)`, `pointer(ev)`, `type(input)`, `goto(path, opts)`, `run(effects)`, `trail()`, `history()` (`{ hist, flying }`:
  the trail of the history entry the page stands on, and whether a step back is still to land: wait for `flying === false` after a step back), `held()`, `wantsText()`, `view()`,
  `tick(n, held)`, `pause(bool)`, `frameHash()`, `canvasHash()`, `dialog` (the layer), `apps` (`ids`, `state()`, `family()`, `loaded()`, `errors()`, `ctl(id)`, `load(id)`, `idle(id)`,
  `effect(eff)`), `appEffects`, `appFaults`, `renderError`, `loopError`, `typed`, `dropped`.

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
| the same file's browser sessions | `keys`: the rows of PLAY ONLINE, the Center's seconds, the builder's NAME / TEAM CODE entries (the "a real keyboard types" and paste cases run on them), the dialog over the Center, the navigation cases (which walk `online`, `center` and `builder`), the throw / sound / held cases (which replace methods of the Center's model). `touch`, `pad`: the same rows. `broken`: a `builder_ctl.js` with no `createCtl`, a `center_screen.js` that throws, an `online_screen.js` whose `createScreen` throws. `control`: the builder's NAME entry. **What these prove about the shell must be kept**: point them at your screens |
| `tools/pokemonarena_journey_test.mjs`, step 2 | TEAM BUILDER opens `builder`, then the row with id `editor` leaves for `editor.html` |
| `tools/pokemonarena_hub_test.mjs` | nothing a stub shows: only that PLAY ONLINE opens `online` and TEAM BUILDER opens `builder` (address `#builder`, a title that contains "Team Builder") and that B returns |

`hub.golden.json` holds no picture of a stub (the text entry and the dialog are drawn there over the main menu). The ids `online`, `center`, `builder`, and a path of the same name for
each, are what the main menu, the registries and these suites rely on: keep them.

### What the foundation left outside the picture

These are the edits to the SHELL that are still to be made, each by the work named:

* **The online work**: the row under the picture (`#onlineLink` in `index.html`: Play online, Trainer Center, Open) and `presence_boot.js`'s DOM dialogs. In `boot.js` that is the
  `import('./presence_boot.js')` block in `start()` (which mounts it on `#openToggle`), `hook.presence.refresh()` in `resetRecord`, and `document.getElementById('onlineLink')` in `fit()`.
* **The Team Builder work**: `BATTLE WITH MY TEAM` with no team, and the RECORD screen with no profile, still offer a TEAM BUILDER button that leaves for `editor.html` (`hub_model.js
  BUILDER_URL`: the `row.id === 'builder'` line of `activate` and the `pg.action === 'builder'` line of `recordPress`), as does IMPORT SAVE (`IMPORT_URL`). When the builder is in the
  picture these become `go('builder')`, with their checks in `tools/pokemonarena_hub_test.mjs`, `tools/pokemonarena_record_test.mjs` and `tools/pokemonarena_stats_page_test.mjs`.
* Nothing else: holding a button (`tick(path, held)`), a screen's own sounds (`sfx`), stepping back several screens or replacing one (`ctx.go`), a question that must not be answered by
  accident (`armTicks`) and a ctl that runs from page load (`onData`) all need no edit of `hub_model.js`, `hub_screen.js` or `boot.js`.

## Wave 2: the five tracks, who owns which file, and the contracts between them

Wave 1 landed the app host (above), the ROM world decoder (`js/world_rom.js`: maps, the Pokemon Center, overworld sprites, emotes) and the Tower's retries.
Wave 2 fills the picture. Five tracks work at the same time in separate worktrees and are merged afterwards, so each track edits ONLY its own files
(table below) and codes against the contracts in this section. If a contract here is wrong, say so in your report; do not quietly do something else.

### Decisions already made (the owner's two rules applied; do not reopen them)

1. **All choosing happens in the hub.** Team, battle size, trainer name, invite / join / battle anyone are rows of the hub's `online` app. The battle page
   keeps NO setup form and no text entry.
2. **The battle page's PLAYERS ONLINE list is gone.** Open players are met in the Trainer Center (the hub's `center` app). BATTLE ANYONE is the quick match.
3. `#netbar` (online battle) and `#towerBar` stay as the slim DOM status lines they are. Fatal errors and address errors stay the DOM error screen
   (it is the ROM error screen's panel, on the allowed list).
4. A question (a challenge) that arrives while the Controls dialog or the Sound panel is open WAITS until that panel closes. It still auto-declines on time.
5. PASTE A TEAM CODE is not part of online setup any more. Online uses a saved legal team or a random one; codes come in through the Team Builder.
6. A team code is never drawn or typed key by key: COPY puts it on the clipboard, PASTE takes it from there (Ctrl+V, or a PASTE key in the text entry).
7. `center.html` and `editor.html` become redirects into the hub (`/pokemonarena/#center`, `/pokemonarena/#builder`) so old links keep working; their DOM,
   CSS and page scripts are deleted. A redirect holds no UI.
8. In the Trainer Center every person in the room except the nurse (and her Chansey) is a real player. The three other people the ROM places in that map
   are not drawn.
9. A trainer's look is one of the ROM's own overworld trainer sprites (`world.ow.avatars`), in the sprite's own palette. No recolours.

### The tracks

| Track | Branch / worktree | Builds |
|---|---|---|
| SEAM (runs first; ONLINE, CENTER and BATTLE start from its tip) | `inapp-seam` / `wt-inapp-seam` | the START token, the online preferences, dialog injection in `presence_boot.js`, `js/hub_presence.js` (the hub page's ONE presence service, its questions drawn by the hub dialog layer) |
| ONLINE (the hub's `online` app) | `inapp-hubonline` / `wt-inapp-hubonline` | the PLAY ONLINE menu and its screens; removes the HTML row `#onlineLink` |
| CENTER (the hub's `center` app) | `inapp-center` / `wt-inapp-center` | the walkable ROM Pokemon Center; deletes the hand-drawn Trainer Center |
| BATTLE (the battle page) | `inapp-battleonline` / `wt-inapp-battleonline` | the online waiting / invite / confirm screens in the battle canvas; the challenge question in the picture on a CPU battle; deletes the DOM panel |
| BUILDER (the hub's `builder` app) | `inapp-builder` / `wt-inapp-builder` | the Team Builder in the picture; deletes the DOM editor |

### Who may edit what

A file not in your row is not yours. If you truly need a change in another track's file, make the smallest possible hunk, and list it in your report
under `foreignHunks` with the reason, so the merge can be done by hand.

| Files | Owner |
|---|---|
| `js/presence.js`, `js/presence_boot.js`, `js/hub_presence.js`, `js/online_prefs.js`, `tools/pokemonarena_presence_test.mjs` | SEAM (after SEAM has landed: nobody, except one-line hunks reported as foreign) |
| `js/online_hub.js`, `js/online_screen.js`, `js/online_ctl.js`, `index.html`, `arena.css`, `tools/pokemonarena_hub_online_test.mjs` (new), the HUB-page sessions of `tools/pokemonarena_online_page_test.mjs` | ONLINE |
| `js/center_hub.js`, `js/center_screen.js`, `js/center_ctl.js`, `js/center_net.js`, any new `js/center_*.js`, `js/world_rom.js` (fixes only), `center.html`, `tools/pokemonarena_center_test.mjs`, and the deletion of `center.css`, `js/center_boot.js`, `js/center_draw.js`, `js/center_map.js`, `js/avatar.js`, `dev/avatar_sheet.html` | CENTER |
| `js/online.js`, `js/battle_boot.js`, `battle.html`, `battle.css`, any new `js/online_view.js` / `js/online_draw.js` / `js/battle_ask.js`, the BATTLE-page sessions of `tools/pokemonarena_online_page_test.mjs`, `ONLINE.md` | BATTLE |
| `js/builder_hub.js`, `js/builder_screen.js`, `js/builder_ctl.js`, any new `js/builder_*.js`, `editor.html`, the deletion of the DOM editor (`js/editor_app.js`, `js/editor_views.js`, `js/editor_import.js`, `js/osk.js`, `editor.css`), `tools/pokemonarena_builder_*.mjs` (new), `tools/pokemonarena_editor_page_test.mjs`, `tools/pokemonarena_journey_test.mjs` | BUILDER |
| the shell: `js/boot.js`, `js/hub_model.js`, `js/hub_screen.js`, `js/hub_apps.js`, `js/hub_app_screens.js`, `js/hub_app_ctls.js`, `js/hub_dialog.js`, `js/hub_menu.js`, `js/textentry.js`, `js/textentry_screen.js`, `tools/pokemonarena_hub_test.mjs`, `hub.golden.json` | nobody: smallest hunks only, each reported. `hub.golden.json` is regenerated at the merge, so do not fight over it: run `--update` in your worktree and say which keys you changed |
| `README.md`, `INAPP.md` | everybody, ADD-ONLY: your test lines next to the related ones in `README.md`; in `INAPP.md` ONE new section at the very end, `## <TRACK>: as built`. Do not reflow or reorder what is there |
| the pure layers every track reads: `js/netmatch.js`, `js/online_match.js`, `js/openlobby.js`, `js/matchctl.js`, `js/engine*.js`, `lib/netplay.js`, `js/editor_state.js`, `js/editor_data.js`, `js/store.js`, `js/profile.js`, `js/rules.js`, `js/teamcode.js` | nobody edits these (a real bug found in one is reported, with a failing case, and fixed in the smallest hunk) |

### Contract 1: from the hub to the battle page (tokens and addresses)

"An address does not start a game" stays true: the battle page acts by itself only when THIS TAB holds a fresh one-time token written by the hub page the
player pressed on. Tokens live in `sessionStorage`; `js/presence.js` owns them.

| The player pressed, in the hub | Token written first | Then navigate to |
|---|---|---|
| INVITE A FRIEND | START `{ what: 'host' }` | `/pokemonarena/battle.html?online=1` |
| BATTLE ANYONE (after its notice and YES) | START `{ what: 'quick' }` | `/pokemonarena/battle.html?online=1` |
| JOIN A FRIEND (a room code typed or pasted) | MEET `{ room }` (exists: `writeMeetToken`) | `/pokemonarena/battle.html?np=ROOM&join=1&meet=1` |
| OPEN THE ROOM (a room handed over by the site lobby) | START `{ what: 'host', room }` | `/pokemonarena/battle.html?np=ROOM&host=1` |
| YES to "wants to battle you" | ACCEPT (exists, unchanged) | unchanged (`acceptHref`) |
| in the Center: a challenge of mine was accepted / I join a listed game | MEET `{ room }` (exists) | `/pokemonarena/battle.html?np=ROOM&join=1&meet=1` |

START token API (SEAM writes it in `js/presence.js`, beside the meet token, same style and the same tests):
`START_KEY = 'arena.go'`, `START_MAX_AGE_MS = 60000`,
`writeStartToken(storage, { what, room? }, nowMs) -> boolean` (`what` is `'host'` or `'quick'`; `room` only with `'host'`, must match `ROOM_RE`),
`takeStartToken(storage, nowMs, maxAgeMs?) -> { what, room } | null` (one use: whatever is found is removed; null when none, stale, from the future, malformed).
The battle page honours `{ what: 'host' }` only on a plain `?online=1` address, `{ what: 'host', room }` only on `?np=<that room>&host=1`, `{ what: 'quick' }`
only on a plain `?online=1` address.

**The battle page with NO valid token** (BATTLE builds these; ONLINE relies on them):

| Address | The page |
|---|---|
| `?online=1` | `location.replace('/pokemonarena/#online')` (nothing to choose here any more) |
| `?online=1&ask=host` / `&ask=quick` | a one-press question in the picture (`OPEN A ROOM FOR A FRIEND?` / `FIND AN OPPONENT?`, YES / BACK). The hub sends the player here ONLY when it could not write a token (storage blocked) |
| `?np=ROOM&join=1` (a friend's invite link, or the hub's fallback) | `YOU'RE INVITED` in the picture: the room code, the team that will be used, rows `JOIN THE BATTLE` / `CHANGE TEAM` / `BACK` |
| `?np=ROOM&host=1` (the site lobby's hand-off) | `YOUR ROOM` in the picture: rows `OPEN THE ROOM` / `CHANGE TEAM` / `BACK` |

`CHANGE TEAM` navigates to `/pokemonarena/?np=ROOM&join=1#online` (or `&host=1`): the hub's `online` app sees those two parameters in ITS OWN address and
opens its invite screen (team, name, and the button that writes the token and comes back). `BACK` goes to `/pokemonarena/`.
The invite link the waiting screen hands out stays exactly what it is today (`/pokemonarena/battle.html?np=ROOM&join=1`): `canonicalAddress`,
`boardAddress`, `parseOnlineQuery` and the address a friend receives do not change by one character.
Every hop carries the test parameters it arrived with (`net=local`, `opendisc`, `openchal`), as the pages do today.

### Contract 2: the online preferences (which team, what size, what name)

`js/online_prefs.js` (SEAM; pure, storage injected): `ONLINE_TEAM_KEY = 'arena.online.team'`,
`readOnlinePrefs(storage) -> { teamKey, fmt }` (`teamKey` is `'saved:<profileId>:<teamId>'`, `'random'` or `null`; `fmt` is `'3v3'`, `'6v6'` or `null`),
`writeOnlinePrefs(storage, patch) -> boolean`. The trainer name stays where it is (`arena.online.name`, `online.js`).
The hub's `online` app writes them; the battle page reads them where it pre-selects a team today, and falls back to today's default when the preferred
team is gone or not legal. The page an accepted challenge opens uses the preferred team too (falls back to the first saved team, as today).

### Contract 3: the hub page's presence service

`js/hub_presence.js` (SEAM) is the ONE place the hub page talks to the board. Nothing else on the hub page calls `mountPresence`. The exact API is in
SEAM's section at the end of this file once it lands; ONLINE and CENTER code against that, not against a guess. What it must offer:
on / off with the first-time disclosure asked in the picture (never published before YES), the challenge question in the picture, the list of open
players (name, record, look, what they are doing, the room they host if any), challenging one of them, change notifications, and everything the first
Trainer Center's page took from its own mount (`js/center_boot.js` shows what that was).

### Contract 4: looks

A look code on the board (`av`, `openlobby.js`: seven characters `[0-9a-z]`) is `'w'` followed by the ROM graphics id in base 36, left-padded with `0` to
six characters. An id that is not in `world.ow.avatars`, or an old code (first character `0`-`5`, from the hand-drawn Trainer Center), draws the first
avatar. CENTER owns the small module that reads / writes / checks it (replacing `js/avatar.js`).

### Contract 5: leaving a hub app for another one

The Center's PC opens the Team Builder (`go('builder')`), the nurse's choices and the `online` rows open each other. Use the navigation rules of
"The app interface" exactly as written there; B must bring the player back to where they came from.

### Contract 6: coming back from a battle to where the player was

A battle started from the Trainer Center ends back in the Trainer Center. The hub page writes `sessionStorage['arena.back'] = 'center'` (a hub path,
`[a-z][a-z0-9-]*`, nothing else) just before it navigates to the battle page from the Center, including when a challenge is accepted while the Center is
the open screen; SEAM's `js/hub_presence.js` offers the one function that does it, and removes the key when the hub page loads. BATTLE: every "back to
the hub" the battle page performs (the result screen's row, BACK on a confirm or error screen, a cancelled wait) goes to `/pokemonarena/#<that path>`
when the key holds a valid path, and to `/pokemonarena/` otherwise. The key is read, never trusted further than that pattern.

### Working rules that are the same for every track

* Read this whole file first, then the code you are replacing, then write.
* Work only in your own worktree. Never touch `C:/Users/Admin/Dev/Bemental77.github.io` (the owner's checkout) or another track's worktree. Never push. Never `git stash`.
* LF only (`git -c core.autocrlf=false ...`; check `git ls-files --eol` before committing). Commit with a pathspec; read `git ls-files | wc -l` before and after (it may only grow, or shrink by the files you deliberately deleted).
* Nothing derived from the ROM is committed: offsets, strides, hashes and words only.
* Browsers: `tools/headless_cdp.mjs` only (headless, throwaway profile, `--mute-audio`). Never the owner's Chrome. ONE browser suite at a time per track, on your own ports. Before each browser suite read the free memory (PowerShell `Get-CimInstance Win32_OperatingSystem`, `FreePhysicalMemory`); under 2500 MB free, wait 90 seconds and read again.
* Every new guard gets a named check AND a source mutant that the check kills, the way the existing suites do it.
* A hook for tests (`window.__arenaHub`, `window.__arenaBattle`, `window.__arenaOnline`) drives the picture; a test never needs a DOM control that a player does not have.
* Known before you start, not yours: `tools/pokemonarena_fullscreen_test.mjs` fails 28 cases in this environment on the commit before any of this work as well (identical list); `tools/pokemonarena_hub_return_test.mjs` case F1 (back / forward cache) fails now and then when the machine is loaded.
