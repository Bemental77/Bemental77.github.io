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

### The stubs (what is there until an app is written, and what the shell's suite keeps as fixtures)

| App | Path (parent) | What it does today |
|---|---|---|
| `online` | `online` (main) | TRAINER CENTER -> the `center` screen; BATTLE ONLINE -> `{ app: 'online', type: 'open-battle' }`, which its ctl carries out by leaving for `battle.html?online=1`; BACK |
| `center` | `center` (online) | counts the seconds the player has been there (`tick`), shows the last answer a dialog gave it (`onDialog`); BACK. Its ctl only records what it is asked |
| `builder` | `builder` (main) | NAME -> a `'name'` text entry (max 10), shown on the row, kept for the tab by its ctl (`sessionStorage`); TEAM CODE -> a `'teamcode'` entry (max 1024); OPEN TEAM BUILDER -> its ctl leaves for `editor.html`; BACK |

### When you replace a placeholder

**The shell's suite does not change when you do.** The three stubs live on as FIXTURES of `tools/pokemonarena_apps_test.mjs` (`tools/fixtures/pokemonarena/app-stubs/`, nine files): the
suite lays them over the game's own `online_*`, `center_*` and `builder_*` files in every tree it loads in Node or serves to a browser, so its family X and its browser sessions go on
testing the SHELL with them whatever your app becomes (it passes with the game's nine files replaced by files that throw). **Do not edit that suite or those fixtures for your app**: write
your app's checks in a suite of your own. What your files must keep, because the registries and the fixture overlay rely on it: the nine file names, and the ids `online`, `center`,
`builder` with a path of the same name each. A file of yours beyond the three (`center_net.js`, `builder_views.js`) is yours alone; the stubs do not import it.

These are the places in the OTHER suites that know what a placeholder shows or does:

| Where | What is tied to a placeholder |
|---|---|
| `tools/pokemonarena_journey_test.mjs`, step 2 | TEAM BUILDER opens `builder`, then the row with id `editor` leaves for `editor.html` |
| `tools/pokemonarena_hub_test.mjs` | nothing a stub shows: only that PLAY ONLINE opens `online` and TEAM BUILDER opens `builder` (address `#builder`, a title that contains "Team Builder") and that B returns |

`hub.golden.json` holds no picture of a stub (the text entry and the dialog are drawn there over the main menu).

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
| `tools/pokemonarena_apps_test.mjs`, `tools/fixtures/pokemonarena/app-stubs/` | nobody. The shell's suite runs on its own fixture apps ("When you replace a placeholder"); it must stay green untouched. If it goes red, the cause is a change to the shell, not your app |
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
* Browsers: `tools/headless_cdp.mjs` only (headless, throwaway profile, `--mute-audio`). Never the owner's Chrome. ONE browser suite at a time per track, on your own ports. Before each browser suite read the free memory (PowerShell `Get-CimInstance Win32_OperatingSystem`, `FreePhysicalMemory`); under 3500 MB free, wait 90 seconds and read again (four tracks share this machine and a browser suite takes about 1.3 GB: five at once ran it out of memory and were killed).
* Every new guard gets a named check AND a source mutant that the check kills, the way the existing suites do it.
* A hook for tests (`window.__arenaHub`, `window.__arenaBattle`, `window.__arenaOnline`) drives the picture; a test never needs a DOM control that a player does not have.
* Known before you start, not yours: `tools/pokemonarena_fullscreen_test.mjs` fails 28 cases in this environment on the commit before any of this work as well (identical list); `tools/pokemonarena_hub_return_test.mjs` case F1 (back / forward cache) fails now and then when the machine is loaded.

## SEAM: as built

What ONLINE, CENTER and BATTLE start from (2026-11-18). Every name below is the name in the code. Nothing in the protocol moved: `js/netmatch.js`, `js/online_match.js`, `js/openlobby.js`,
`js/matchctl.js`, `js/engine*.js` and `lib/netplay.js` are byte for byte what they were, and so are `PROTO`, `MSG`, `BEACON_V` / `TOPIC`, `SEAL_INFO`, `ACCEPT_KEY`, `MEET_KEY`, `resumeKey`, `GAME_KEY`.

### What exists

| File | What | Tests |
|---|---|---|
| `js/presence.js` (+53 lines) | THE START TOKEN, beside the meet token: `START_KEY`, `START_MAX_AGE_MS`, `writeStartToken`, `takeStartToken`, `startPlan` | `tools/pokemonarena_presence_test.mjs` group P |
| `js/online_prefs.js` (new, pure) | THE ONLINE PREFERENCES: `ONLINE_TEAM_KEY`, `ONLINE_FMTS`, `RANDOM_TEAM`, `readOnlinePrefs`, `writeOnlinePrefs`, `savedTeamKey`, `parseTeamKey`, `preselect` | `tools/pokemonarena_online_prefs_test.mjs` |
| `js/online.js` (hunks) | takes the START token and honours it, pre-selects the preferences, exports `roomFromInput` | page test group `tokens` |
| `js/presence_boot.js` (hunks) | `mountPresence(opts)` takes `opts.dialogs`, and its returned object can be driven and read without a DOM button | `tools/pokemonarena_hub_presence_test.mjs` group H |
| `js/hub_presence.js` (new) | THE HUB PAGE'S PRESENCE SERVICE, and the hub's half of Contract 1 and Contract 6 | `tools/pokemonarena_hub_presence_test.mjs`; page test groups `presence`, `presenceui` |
| `js/boot.js` (three hunks) | mounts presence through the service; hands it the answers of its questions; tells it when a DOM panel opens or closes | page test group `presenceui` (mutants M01, M04, M06, M07) |

### The START token (Contract 1) : `js/presence.js`

```js
START_KEY = 'arena.go'                    // sessionStorage, this tab only
START_MAX_AGE_MS = 60000
writeStartToken(storage, { what, room? }, nowMs) -> boolean      // what: 'host' | 'quick'. room: only with 'host', must match ROOM_RE (stored in capitals). nowMs: WALL clock (Date.now())
takeStartToken(storage, nowMs, maxAgeMs?) -> { what, room } | null   // one use: whatever is found is removed. null: none, stale (> 60 s), from the future (> 5 s ahead), malformed, or a storage that will not remove it
startPlan(token, query) -> 'host' | 'room' | 'quick' | null      // what a token starts ON AN ADDRESS (query = online.js parseOnlineQuery(...)); null = nothing
```

The stored value is `{"what":"host","room":null,"at":1763...}`. `startPlan`: `{ host }` -> `'host'` only on the plain `?online=1` address (no room, no role, no `auto=`); `{ host, room }` -> `'room'` only on
`?np=<that room>&host=1`; `{ quick }` -> `'quick'` only on the plain address. `js/online.js createOnline` takes the token ONCE, right after the accept and the meet token, whatever the address
(`startTok = startPlan(takeStartToken(ss, Date.now()), cfg.query)`), and honours it at the end of `setupForm()`, where the meet token is honoured: `'host'` -> `startAs('host')` (what `#olGo` does on the
plain page), `'room'` -> `go()` (what `#olGo` does on a room's page), `'quick'` -> `quick()`. A reload into a battle (`resumeFlow`) drops it. With no token the page is exactly the page it was.
**BATTLE:** these three calls are the whole seam; keep the token taken once per page load, and keep `startTok` out of any path a reload or a stored record can reach.

### The online preferences (Contract 2) : `js/online_prefs.js`

```js
ONLINE_TEAM_KEY = 'arena.online.team'     // localStorage: '{"teamKey":"saved:<profileId>:<teamId>","fmt":"6v6"}'
readOnlinePrefs(storage) -> { teamKey, fmt }          // teamKey: 'saved:<profileId>:<teamId>' | 'random' | null;  fmt: '3v3' | '6v6' | null. Never throws; junk reads as null, field by field
writeOnlinePrefs(storage, patch) -> boolean           // patch: { teamKey?, fmt? }. A key left out is kept, null forgets it, a value that is not one is REFUSED and nothing is written
savedTeamKey(profileId, teamId) -> 'saved:..:..' | null      parseTeamKey(key) -> { kind: 'saved', profileId, teamId } | { kind: 'random' } | null
preselect(prefs, choices, { formatParam }) -> { teamKey, fmt }   // what the battle page selects; choices = its own team list [{ key, size }], first = its old default
```

`js/online.js setupForm` calls `preselect(readOnlinePrefs(win.localStorage), choices, { formatParam: cfg.formatParam })` where it used to select `choices[0]`: the preferred team when the page still
lists it (it lists a saved team only while it exists and is legal, so "gone or not legal" is "not on the list" -> the first choice, as before); the address's `format=`, else the preferred size, else
the old default for the team selected; a team of fewer than three is never 3v3; an address that brings its own team (`?team=`) keeps it. The page an accepted challenge opens (`autoStart`) plays with
what is selected there, so it follows the preference with the same fallback (its size stays 3v3: the Accept address says `format=3v3`). The trainer NAME is not here: it is still `arena.online.name`.
`roomFromInput(raw)` is exported from `js/online.js` (pure; module level): a code in any case with spaces and dashes dropped, at most 8 characters, or the `np=` of a pasted invite link, or `null` for an
address that names no room. `ROOM_RE.test(...)` then says whether it is a room code.

### Dialog injection : `js/presence_boot.js mountPresence(opts)`

`opts.dialogs = { challenge?, disclosure? }`. Whichever is left out is the DOM dialog of that file, built as before (the battle page injects nothing and is untouched).

```js
challenge:  { show({ name, rec, s, r, fmtText }), hide(), isOpen(), destroy() }   // show: ask; the host answers with mount.accept() or mount.decline(). hide: it is over (answered, cancelled, timed out)
disclosure: { show(onYes), hide(), isOpen(), destroy() }                           // show: say what is published and ask; YES = call onYes() (it remembers and switches on); NO = do nothing
```

The returned object (also `window.__arenaPresence`), new members in bold: `setOn(on, { persist })`, `isOn()`, `refresh()`, `dispose()`, `presence`, `lobbies`, **`status()`** (`'off' | 'starting' | 'on' |
'offline'`), **`toggle()`** (what the button does: the first switch-on asks), **`needsDisclosure()`**, **`confirmDisclosure({ persist })`**, **`onChange(fn) -> off`** (the switch, a start that finished,
the board connection, the board's list), **`accept()`**, **`decline()`**, **`pending()`**, **`challenge(target, handlers)`** (presence.js `createChallenge` on this page's board connection, under the
listing's trainer name and record, with the `openchal` seam), **`canChallenge()`**, **`trainer()`**, **`timing`**. `opts.onDialog` is called for the DOM dialogs only: an injected dialog pauses its own page.
**BATTLE:** the CPU battle's question in the picture is `mountPresence({ ..., dialogs: { challenge, disclosure } })` with two objects of that shape; `hub_presence.js` is a worked example.
**CENTER:** `presence_boot.js` still imports `loadAvatar` from `js/avatar.js` for the listing's `av`; when `avatar.js` goes, that import and the `av:` of `identity` are yours to change (one line each).

### The hub page's presence service (Contract 3) : `js/hub_presence.js`

```js
import { hubPresence } from './hub_presence.js';
const svc = hubPresence(env);      // env = your ctl's env. ONE service per hub page: the first caller makes it (boot.js does, right after the menu is up), everybody gets the same object
```

**Nothing else on the hub page calls `mountPresence`.** The service is the only one; a second mount would dispose it.

| Member | What |
|---|---|
| `ready` | `Promise<boolean>`: presence_boot.js is loaded and mounted. `false`: it could not load; `status()` is then `'unavailable'` and nothing switches on (nothing throws) |
| `status()` | `'loading' \| 'unavailable' \| 'off' \| 'starting' \| 'on' \| 'offline'` (`offline`: on, but no public server can be reached, so nobody can see the listing) |
| `isOn()` | boolean |
| `stored()` | what the BROWSER's stored switch says (`localStorage 'arena.open'`), whatever this page is doing |
| `turnOn({ persist = true, also })` | `Promise<boolean>` (is it on). The first time, THE DISCLOSURE IS ASKED IN THE PICTURE first: nothing is published before YES, NO is not remembered and resolves `false`. `persist: false`: on for this page only (the stored switch is left alone: the Trainer Center). `also`: ONE more sentence for the disclosure (at most 200 characters), e.g. what walking into the Center lists |
| `turnOff({ persist = true })` | `Promise<boolean>` (is it off). The listing comes down at once |
| `toggle()` | what the Open switch does. `Promise<boolean>` (is it on afterwards) |
| `onChange(fn) -> off` | `fn()` whenever something a screen may draw has changed: the switch, the board connection, the players, a question put or answered. Read the state through the getters |
| `watchPlayers(bool)` | keep the list of open players current (the board is asked who is open, and listings age off it). Off by default; re-applied by itself when the board connection is rebuilt |
| `players()` | `[{ id, name, rec: [wins, losses] \| null, look, doing: 'menu' \| 'looking' \| 'waiting', room, fmt, compatible, entry }]`, longest waiting first; `[]` while off. `doing 'menu'` = open from the hub or a CPU battle (`room` is null: ASK them); `'looking'` / `'waiting'` = they wait in a listed room (`room`: JOIN it). `look` is the 7-character code they list (`av`), or null. `compatible: false` = another game file or engine build (cannot be battled). This page's own listing is never among them |
| `boardId()` | this page's id on the board (a Center walker's `b`), or null while off. It changes when the switch goes off and on |
| `trainer()` | `{ name, rec }` of this page's listing, or null while off |
| `canChallenge()` | false: no WebCrypto, so nobody can be asked (say so) |
| `challenge(player, { state(name), accepted(room), failed(why) })` | ask a player of `players()` with `doing: 'menu'`. `-> { r, ready, cancel(), done() }` or null while off. `why`: `'declined' \| 'busy' \| 'timeout' \| 'unsupported'`. On `accepted(room)`: `svc.goBattle('join', room)` |
| `refresh()` | `Promise<boolean>`: read the trainer again (a rename, a record that was reset) and list again if it changed (boot.js calls it after RESET RECORD) |
| `relist()` | say the listing again as it is now (the look changed) |
| `goBattle(kind, room?, { back })` | LEAVE THE HUB FOR THE BATTLE PAGE (below). `false` and nothing happens for a kind that is not one or a room that is not a room code |
| `state()` | `{ status, on, challenge: null \| 'shown' \| 'waiting', disclosure: null \| 'shown' \| 'waiting', players, back }` (tests; `window.__arenaHub.presence.state()`) |
| `mount` | the presence_boot.js mount itself, or null before `ready` |
| `answer(effect)`, `panels()` | boot.js only: a dialog answer that has no `app`; a DOM panel opened or closed |
| `dispose()` | closes its questions, disposes the mount; the next `hubPresence(env)` makes a new one |

**The two questions** are the hub's dialog layer (ids `presence:challenge`, `presence:disclosure`, no `app`; a note `presence:note`). They sit over ANY hub screen, yours included, and take every press
while they are up; your screen is told no button is held. You do not open, close or answer them.

* `<NAME> (W-L online)` / `wants to battle you.`, then `YES opens a 3 v 3 battle with them and leaves this screen.` with **YES / NO**.
* the disclosure: five pages of two lines (what is listed, where, who sees it, that nothing else is shared, how it stops), then `Go open to battles?` with **YES / NO**.

What the DOM dialogs guaranteed, and where each guarantee is now (Node = `tools/pokemonarena_hub_presence_test.mjs`, page = `tools/pokemonarena_online_page_test.mjs`):

| Guarantee | Where it lives | Node check / mutant | Page check / mutant |
|---|---|---|---|
| NO is the default | `cursor: NO` | E2 / `yes-default`, `labels-swapped` | A4, UK1-UK4, UD1 |
| B answers NO | NO is the LAST option (`ANSWERS`, `YES = 0`, `NO = 1`); the layer's B is the last option | E6 / `b-accepts`, `layer-b-first-option` | UK1-UK4 (pad B, X, Backspace, Escape), UD2 / M01 |
| YES is inert for 600 ms | `armTicks: DIALOG_ARM_TICKS` (36 frames) | E3, E4, E5 / `never-armed`, `challenge-not-armed`, `layer-unarmed-answers` | PB1, UA1, UA2 (measured in real time), UT2 / M03 |
| a held direction that only drifted does not arm A | the layer ignores a held direction's repeats, and boot.js tells it which presses are repeats | E8, E12 / `layer-repeats-move` | UA3, UA5, UA6 / M04, M22 |
| one question at a time, a second asker is told busy | presence.js (unchanged) | E10 | C1 |
| the 25 s automatic NO | presence.js's own clock calls `hide()` | E17, F8 / `hide-leaves-question` | D1 |
| a cancel from the asker closes it | `hide()` | E18 | C2, C4 |
| hostile names are safe text | `cleanName` (netmatch.js) before the picture; the layer draws what the font cannot as `?` | A4, A6 / `name-as-given`, `size-as-given`, `font-draws-anything` | G1, G1b |
| Accept writes the token, then navigates; no token = busy | presence.js `accept()`; the service says why in the picture | E13, E14, E21, E22 / `yes-declines`, `no-note` | PB2, PB11, UA4, UT4 |
| the disclosure's NO is not remembered; nothing is published before YES | `askDisclosure` / presence_boot.js `toggle`, `confirmDisclosure` | D6, D8, D9, D15, H2 / `publishes-before-yes`, `turn-on-unasked`, `no-is-yes`, `boot-toggle-unasked`, `boot-yes-not-remembered` | UD1-UD6 / M14 |
| a stored "on" nobody was told about is dropped | presence_boot.js (unchanged line) | D18 / `boot-untold-on-honoured` | UD7 / M15 |
| while the Controls dialog or the Sound panel is open the question WAITS, and appears when it closes | `place()` / `panels()`; boot.js `setDialog` calls `panels()` | F1-F10 / `shown-under-panel`, `never-flushed`, `stays-under-panel`, `waited-not-armed` | US1-US9, UA5, UA6 / M05, M06, M07 |

Two more things a question does that the DOM dialog did not: a question that waited behind a panel, or that a panel opened over, appears (again) from its first page and listens only after the arm delay;
and a question the dialog layer cannot take (its queue of 8 is full) is answered NO at once.

### From the hub to the battle page and back (Contract 1 and Contract 6) : `js/hub_presence.js`

```js
svc.goBattle('host')                 // INVITE A FRIEND:  START { what: 'host' }         then /pokemonarena/battle.html?online=1
svc.goBattle('quick')                // BATTLE ANYONE:    START { what: 'quick' }        then ?online=1
svc.goBattle('room', ROOM)           // OPEN THE ROOM:    START { what: 'host', room }   then ?np=ROOM&host=1
svc.goBattle('join', ROOM)           // JOIN A FRIEND, and the Center's "accepted" / "join their game":  MEET { room }  then ?np=ROOM&join=1&meet=1
```

It writes the token, writes or clears `arena.back`, then calls the page's `navigate`. When the token cannot be written (storage blocked) the address says so, as Contract 1 asks: `?online=1&ask=host`,
`?online=1&ask=quick`, the plain `?np=ROOM&host=1`, the plain `?np=ROOM&join=1` (no `meet=1`). Every address carries the test seams of the hub page's own address and nothing else of it
(`PASS_PARAMS`: `net anim arenaturn arenagrace openquick openchal openjoin openhold opendisc`). The pure half is exported: `battleStart(kind, room, { session, now, search }) -> { url, token } | null`,
`passThrough(search)`.

**Coming back.** `{ back }` is the hub path the battle comes back to; left out, it is the open screen when that is the Trainer Center's (`center`, `center-...`: `backPathFor(path)`), else the main menu;
`{ back: null }` is the main menu. An accepted challenge (YES in the picture) does the same by itself: accepted while a Center screen is open, the battle comes back to it. The key is cleared when the
service is made (the hub page is up) and when the page is restored from the back / forward cache.

```js
BACK_KEY = 'arena.back'              // sessionStorage: a hub path, /^[a-z][a-z0-9-]{0,31}$/, never 'main'
writeBack(session, path) -> boolean  // anything that is not such a path FORGETS the key
readBack(session) -> path | null     // BATTLE: this is the read ("never trusted further than that pattern"). It does not remove the key
clearBack(session)
```

### What `js/boot.js` does now (three hunks, all in the shell)

1. `start()`: `import('./hub_presence.js')` -> `hook.presence = hubPresence({ win, doc, hook, model, pack, ui, navigate, input, storage, session, button: #openToggle, focusHome, panelOpen, redraw })`.
   `window.__arenaHub.presence` is the SERVICE (it was the mount; `window.__arenaPresence` is still the mount). If presence_boot.js cannot load, `#openToggle` is hidden, as before.
2. `run(effects)`: a `{ type: 'dialog' }` effect with no `app` goes to `hook.presence.answer(eff)`. (This amends item 5 of "Effects: who carries what out": the presence service hears those.)
3. `setDialog(who, v)`: after the set of DOM panels changed, `hook.presence.panels()`. The owners `presence:challenge` / `presence:disclosure` are gone from that set: the questions are not DOM.

The HTML row `#onlineLink` is untouched: `#openToggle` works through the service (a click asks the disclosure in the picture). **ONLINE:** when the row goes, nothing here needs to change: the service
looks `#openToggle` up when it is made and takes `null`; drop `button: $('openToggle')` and the `noSwitch` helper from the hunk in `start()` if you like.

### Storage keys

| Store | Key | Value | Writer / reader |
|---|---|---|---|
| sessionStorage | `arena.go` (new) | `{ what, room, at }`, one use, 60 s | hub (`goBattle`) / battle page (`online.js`) |
| localStorage | `arena.online.team` (new) | `{ teamKey, fmt }` | the hub's `online` app / battle page (`online.js setupForm`) |
| sessionStorage | `arena.back` (new) | a hub path | hub (`goBattle`, an accepted challenge) / battle page (`readBack`); cleared when the hub page loads |
| unchanged | `arena.accept`, `arena.meet`, `arena.open`, `arena.open.seen`, `arena.online.name`, `arena.avatar`, `arena.online:<ROOM>:<role>` | | |

### What was deleted, and what was not

Deleted: nothing from the tree. On the HUB page the DOM dialogs `#challenge` and `#openInfo` are no longer built (and `boot.js` no longer passes `enableDomNav` / `onDialog` to presence). `presence_boot.js`
keeps `mountDialog`, `mountChallengeDialog`, their style sheet and the drift guard, because a battle against the CPU still asks in the DOM: BATTLE deletes them with that page's dialog. `center_boot.js` still
mounts presence by itself on `center.html` (CENTER deletes that page).

### Known limits (measured or read, not fixed here)

* On a 390 px phone a YES / NO row is 59 x 26 css px (measured, page test UT1: 16 logical px at 1.625x): smaller than the 44 px the DOM buttons had. The on-screen B button (NO) is 64 px, and a tap on
  the question's text never answers.
* The hub's clock stops while the tab is hidden, so a question that arrives in a hidden tab starts to listen 0.6 s after the tab is shown; it still becomes a NO after 25 s (presence.js's own clock).
  Measured in real Chrome (page test UA2): 580 ms from the frame the question is first drawn to the frame it listens.
* The disclosure is six pages (the DOM dialog was one glance). B is NO from any of them.
* The question has no sound of its own, and the live region reads it only when the hub next draws (it does not draw while the tab is hidden).
* `roomFromInput` lives in `js/online.js`, whose imports are the battle page's (the profile store, `hub_data.js`, the engine through `online_match.js`, `netmatch.js`). A hub ctl that needs it should
  `import('./online.js')` when JOIN A FRIEND is opened, not at the top of its file.

### Tests (2026-11-18, this tree)

The counts are what each command prints as "passed" when it is run alone; the page test's include its own case-id check (ID1), so `tokens` is 29 checks, `presence` 48 and `presenceui` 103.

```bash
node tools/pokemonarena_presence_test.mjs --mutants        # 140 passed, 67 mutants: + group P (the START token and startPlan) and O12-O15 (roomFromInput)
node tools/pokemonarena_online_prefs_test.mjs --mutants    # 35 passed, 21 mutants: the online preferences
node tools/pokemonarena_hub_presence_test.mjs --mutants    # 117 passed, 63 mutants (about 20 minutes with them; ARENA_HP_MUTANT=<id> runs one): the service on a real hub model, the real renderer,
                                                           # presence_boot.js, presence.js and the board over Node's BroadcastChannel. A mutant counts only when the case it NAMES fails
node tools/pokemonarena_online_page_test.mjs tokens --mutants       # 30 passed + 6 mutants, real Chrome: the three starts with and without their token; the preferences; an accepted challenge plays the preferred team
node tools/pokemonarena_online_page_test.mjs presence               # 49 passed: the hub sessions read and drive the PICTURE (window.__arenaHub); the CPU-battle session (PF) still reads the DOM
node tools/pokemonarena_online_page_test.mjs presenceui --mutants   # 104 passed + 36 mutants (the count ONLINE.md states is unchanged): M01, M03-M07 and M22 are re-homed onto the code above
```

In the page test the hub sessions that read `#challenge` / `#openInfo` now read the picture: `presence` A, PB, C, D, G (PF, the battle against the CPU, is as it was) and `presenceui` keys, accept, drift, stack,
refresh (UR3), disclosure, touch. `stack` and `drift` changed meaning with the decision that a question WAITS behind a DOM panel: they used to prove the DOM dialog was on top of the panel. UR4 / UR5 mount
presence_boot.js by hand with no dialogs handed in, so the DOM dialogs keep their two mutants (M12, M19); UK6 (M02) calls `mountDialog` itself. Moved deliberately: mutant `X13` of `onlineux` now breaks
`ui.team.value = pre.teamKey;` (the line it broke was replaced by the preferences). ONLINE.md (BATTLE's file) still says the presence suite breaks things "50 ways": it is 67 now.

## CENTER: as built

The Trainer Center is the hub app `center` (2026-11-18): the ROM's own Pokemon Center in the 240x160 picture, the players as the ROM's overworld trainer sprites, the ROM's emote icons over their heads,
every word in the ROM's windows and fonts, every name on the ROM's party-menu chip. The page with the hand-drawn room and avatars is deleted. Every name below is the name in the code. Nothing in the
protocol moved: `js/netmatch.js`, `js/online_match.js`, `js/openlobby.js`, `js/matchctl.js`, `js/engine*.js` and `lib/netplay.js` are untouched, and so are `PROTO`, `MSG`, `BEACON_V` / `TOPIC`, `SEAL_INFO`,
`ACCEPT_KEY`, `MEET_KEY`, `resumeKey`, `GAME_KEY`.

This section is the state AFTER the review of the first build (its three blocking findings and the cheap minor ones are fixed here; what was left, and why, is under "Known limits").

### What exists

| File | What |
|---|---|
| `js/center_hub.js` | the app's pure model (`APP`, `createCenterHub`, `WALK`, `NOTE_TICKS`, `CGEOM`, `DLG`, `MENU_ROWS`, `WORDS`, `ANSWER_WORDS`, `DOING`, `stepOf`). One path, `center`, parent `online` |
| `js/center_screen.js` | the pure renderer (`createScreen(ui, h)`, `TAG`, `BUBBLE_UP`, `layoutTags`): the map's lower layers, the nurse and her Pokemon and every trainer top to bottom, the map's top layer, the bubbles, the names (last: a name always reads), the mode's window |
| `js/center_ctl.js` | the side effects (`createCtl(env)`, `CENTER_SEEN_KEY`, `ROOM_SOUNDS`, `ROOM_SOUNDTRACK`, `BEAT_MS`): the room read from the ROM, who is asked before walking in, the presence service, the room's network, a challenge, somebody asking this player, the sounds |
| `js/center_room.js` | THE ROOM as plain data (pure, no import): `roomFromWorld(world, { GFX, MB })`, `createGrid(room)`, `SPOTS`, `SPAWNS`, `STATUS_EMOTE`, `ahead`, `VEC`, `DIRS`, `OPPOSITE`, `CELL`, `ROOM_W`, `ROOM_H`, `TRAINER_ELEVATION`, `roomNpcs` |
| `js/center_world.js` | `centerWorld(romBytes) -> { world, room }`: `world_rom.js loadWorld` and `roomFromWorld`, once per ROM image, shared by the renderer and the ctl |
| `js/center_look.js` | THE LOOK CODE (Contract 4; replaces `js/avatar.js`) |
| `js/center_net.js` | the room's messages and roster, VERSION 2, the room handed in as rules |
| `center.html` | a redirect to `/pokemonarena/#center` that carries the test seams (`net anim arenaturn arenagrace openquick openchal openjoin openhold opendisc ctrname ctrav`) and nothing else of the address. No UI |
| `center.golden.json` | hashes (FNV-1a) of nine pictures rendered from the ROM. Hashes only |
| `tools/pokemonarena_center_test.mjs` | the suite (below) |

`js/world_rom.js` was not changed. The three registries (`hub_apps.js`, `hub_app_screens.js`, `hub_app_ctls.js`) were not changed: they already named `center`.

### What a player gets

* **The room**: the ROM's map 2.0 with a fixed camera, 15 x 10 cells. `room.rows` is the ROM's collision at a trainer's elevation (`map.canEnter(x, y, 3)`), minus the two cells behind the counter nobody can reach.
* **Walking** (`WALK`): one cell at a time, 16 frames a cell at a pixel a frame, the ROM's walk pictures 1 / 0 / 2 / 0 (a walk picture for the first half of a cell, the other foot on the next cell). A direction
  pressed while standing turns at once and walks if it is still held 8 frames later; a new direction while walking is taken at the end of the cell. Held buttons come from `tick(path, held)`; of several held,
  the one pressed last. Walls, the counter, the table and the plants stop a trainer exactly where the ROM's collision does. A tap or click on a floor cell walks there by the shortest way
  (`grid.findPath`: never across the door mat unless the mat is where it goes). People do not block people.
* **Who is in it**: every player with the Center open walks as their look. Players who are open elsewhere stand at `SPOTS` (ten cells; no two near each other, none under a plant) with a ROM icon saying what
  they are doing (`STATUS_EMOTE`: `...` in the Arena's menu or a battle against the computer, `!!` looking for anyone, `!` hosting a listed game, the cross for another version). Players beyond the tenth
  are in WHO'S HERE only.
* **Names**: at each trainer's feet, in the ROM's small narrow font ON THE ROM'S PARTY-MENU CHIP (`ui.panel`: the plain chip for the others, the selected chip for the player; nothing in the room is a
  rectangle this site filled). **No name lies on another** (`layoutTags`): the plates of one row stand side by side, each still under its own trainer (at least `TAG.hold` = 6 of its pixels across lie under
  the trainer's cell), so two trainers side by side, or on one cell, read as two names; where a row is too crowded for that, the trainers farthest from the player go without a plate (the player's own is
  never left out; the names are in WHO'S HERE and in the question A opens). A plate never lies on the line that says what B does.
* **A** (facing it, or a tap on it): another player -> `<NAME>   W-L online` and where they are, then WHAT ASKING DOES ("If they accept, a 3 v 3 battle opens on both screens." / "You join their 3 v 3 battle at
  once.") with **ASK TO BATTLE / CANCEL** (**JOIN THEIR BATTLE / CANCEL** when they host a listed game; a plain line when their listing has not arrived or they are on another version); the nurse, from the
  cell across the counter, facing up -> a welcome and **PLAY ONLINE / STAY HERE** (`ctx.go('online')`); the PC, from the cell below it -> `ctx.go('builder')`; the wall map -> WHO'S HERE; a sign -> what the
  Center shares. WHAT IS FACED COMES FIRST: a trainer standing on the player's own cell is talked to only when nothing is faced (they cannot take the PC away by standing in front of it). Standing on the
  door mat and stepping down leaves (`ctx.back()`); a tap on the mat walks onto it and out.
* **The menu** (B, START, a tap on `B: MENU` in the bottom right corner; B or START closes it): **LOOK** (the 138 ROM trainer sprites, sixteen to a page, the highlighted one walking in place; L / R, the
  arrows in the title row or the wheel turn the page), **EMOTE** (the sixteen ROM icons), **TEAM** (`ctx.go('builder')`), **WHO'S HERE** (name, record, what they are doing; A on a row is A in front of that
  player, which is how a player who is not in the picture is battled), **EXIT**. X is the emotes and Y the looks.
* **Asking**: "Asked <NAME> to battle. Waiting for an answer..." with CANCEL (which listens after 0.6 s: the A that asked is not the A that cancels); then "<NAME> accepted! Opening the battle...",
  "<NAME> said not now.", "<NAME> is answering another challenge. Try again in a moment.", "<NAME> did not answer.", "Challenge cancelled.", "Your challenge to <NAME> was withdrawn.", or why this browser
  cannot ask (`ANSWER_WORDS`). **CANCEL, leaving the Center and a page that goes away WITHDRAW the challenge** (`presence.js` `can`): the question closes on the other screen, and no YES can open a battle
  with somebody who is gone. A notice that only reports something goes by itself after `NOTE_TICKS` (six seconds a page); "accepted! Opening the battle..." stays.

### Who is asked before walking in (nothing is published before YES)

Walking in switches Open to battles on, for this page only (`svc.turnOn({ persist: false })`), and lists two things the hub's switch does not: THE LOOK and THE CELL. So "the player has been told" is kept
per thing told: `localStorage['arena.open.seen']` (presence_boot.js: what Open to battles lists) and **`localStorage['arena.center.seen']`** (`CENTER_SEEN_KEY`, center_ctl.js: what the Center lists).

| The browser | What is asked, in the picture, before anything is switched on |
|---|---|
| was never told what Open to battles lists (`mount.needsDisclosure()`) | the service's disclosure, with one more sentence (`WORDS.also`: "The Trainer Center is the one exception: there your look and where you stand are listed too."). YES sets both keys |
| was told that, never what the Center lists (`arena.center.seen` not set), switch OFF or ON | **THE CENTER'S OWN QUESTION** (`app.askIn()`, dialog `center:enter`): `WORDS.shares` a page a thought, how it ends (`WORDS.sharesEnd`; `WORDS.sharesStay` for a player whose stored switch is on: their listing stays when they leave), then **"Walk in?" YES / NO**, NO highlighted, B = NO, armed after 0.6 s. YES sets `arena.center.seen` |
| said YES to the Center once | nothing: they walk in |
| cannot remember (storage blocked) | the question, at every visit |

NO leaves the Center (`ctx.back()`), without a word: nothing was switched on, nothing was published, nothing is remembered. The same-browser test transport (`?net=local`) publishes nothing anywhere and asks
nothing unless the address says `opendisc=1` (presence_boot.js's own seam). **Decision made here, to revisit if wanted:** the question is asked ONCE per browser (like the hub's disclosure); the first
Trainer Center asked a player whose switch was off in every new tab. One line changes it (`told()` in center_ctl.js).

### Somebody asks this player (the service's question and the Center's own dialogs)

"<NAME> wants to battle you" is the presence service's question, in the hub's dialog layer, which shows ONE dialog at a time, first in first shown, and the question is a NO by itself after 25 s. So nothing
of the Center's may stand in front of it. The ctl listens to the service from the moment the Center is the open screen (`onAsked`, also before the player has walked in):

* the Center's own dialogs MAKE WAY at once (`app.makeWay()`): a notice, a sign, the nurse, the question about a trainer are closed (they are over; the player can open them again); the Center's own question
  is put away and asked again from its first page when the challenge is gone (`app.resume()`);
* **one question at a time**: a player who is waiting for an answer to a challenge of their own has that challenge withdrawn (`app.askWithdrawn(true)`: the player they asked stops seeing it, and after the
  question a line says "Your challenge to <NAME> was withdrawn.");
* **two players who ask EACH OTHER at once**: both pages see the same two board ids, so both know which gives way. The page with the SMALLER board id withdraws its challenge and sees the other's question;
  the other keeps waiting (the question it was sent closes when the withdrawal arrives). One battle: never two rooms, never two automatic NOs;
* **a challenge of this player's that was ACCEPTED is not withdrawn** (the player who said YES has left for the battle page and is opening the room): whoever asks now is told no at once
  (`svc.mount.decline()`), and "accepted! Opening the battle..." stays on the screen.

### What the Center calls of the other tracks, and what they can rely on

* **SEAM** (`hubPresence(env)`): `ready`, `isOn()`, `mount.needsDisclosure()`, `mount.pending()` (who asks: `{ s, r }`), `mount.decline()`, `state().challenge`, `turnOn({ persist: false, also: WORDS.also })`,
  `turnOff({ persist: false })`, `stored()`, `status()`, `onChange(fn)`, `watchPlayers(bool)`, `players()`, `boardId()`, `trainer()`, `canChallenge()`, `challenge(player, { state, accepted, failed })`,
  `relist()`, `goBattle('join', room)` (the default `back`: the Center). "<name> wants to battle you" and the first-time disclosure are the service's questions; the Center asks only its own
  (`center:enter`), through `ctx.dialog`.
* **ONLINE**: the Center is opened with `ctx.go('center')`; `parent('center')` is `'online'`, so B, NO to either question, the door mat and EXIT all come back to PLAY ONLINE when it was opened from there.
  The nurse's PLAY ONLINE is `ctx.go('online')`. The HTML link `#trainerCenter` in `index.html` still points at `center.html`, which forwards to `#center`: remove it with the row.
* **BUILDER**: the PC and TEAM are `ctx.go('builder')` (the builder opens on top of the Center). B on the builder's first screen must be `ctx.back()`: the Center then walks the player in again WHERE THEY STOOD.
  That cell is kept only for the way back: a player who goes on from the builder to anywhere the Center is not on the way back from (Home) walks in at the door the next time (the ctl looks at
  `env.model.trail()` every `BEAT_MS` while the player is away; the shell has no event for it). While the builder is open the player is not in the room and, unless the stored switch is on, not open.
* **BATTLE**: a battle that started in the Center has `sessionStorage['arena.back'] === 'center'` on both sides (the asker through `goBattle`, the one who accepted through the service). Coming back to
  `/pokemonarena/#center` (with the test seams) walks the player in again. `tools/pokemonarena_center_test.mjs` CB7 reads the battle page through `window.__arenaOnline.state.stage`, `.state.role` and
  `.nm().status().phase`, and its page mutant BM2 breaks the meet token's line in `js/online.js` (`else if (meetTok && state.role === 'guest' && state.room) { meetTok = false; startAs('guest'); }`): when
  those move, CB7a / CB7c / CB7d and BM2 move with them.

### The look (Contract 4) : `js/center_look.js`

```js
LOOK_KEY = 'arena.avatar'                  // localStorage, the key the first Trainer Center used
LOOK_RE = /^w[0-9a-z]{6}$/    OLD_LOOK_RE = /^[0-5][0-9a-z]{6}$/    LOOK_ID_MAX
lookCode(id) -> 'w00002h' | null           // 'w' + the ROM graphics id in base 36, six digits
lookId(code) -> id | null                  // null: not a look code (an old code, junk). Says nothing about whether the ROM has such a sprite
isLook(code, avatars) -> boolean           // a look code whose id is one of world.ow.avatars
lookFor(code, avatars) -> id | null        // WHAT IS DRAWN: that id, else the FIRST avatar (an old code, junk, nothing, an id the list lacks)
loadLook(storage) -> code | null           // an old code under the key reads as none      saveLook(storage, code) -> boolean      pickLook(avatars, n) -> code | null
```

`js/presence_boot.js` lists `av: loadLook(storage)` (it listed `loadAvatar(storage)`): a browser that still holds a code of the first Trainer Center lists NO look until the player has opened the Center once,
where one of the ROM's is picked and kept. A player who lists no look is drawn as one of the ROM's trainers picked by their board id (the same one every time, the same on every screen).

### The room's network : `js/center_net.js`, VERSION 2

`CENTER_TOPIC = 'bemental/arena/center/2'`, `CENTER_CHANNEL = 'bemental-arena-center-2'`, `VERSION = 2`: a page of the first Trainer Center and this one never hear each other. The messages are what they
were (`ask`, `here`, `mv`, `emo`, `bye`); so are `TIMING` (an emote now shows 2000 ms) and `createRoster`.

```js
roomRules({ walkable(x, y), look(code), emotes }) -> rules     // from the ROM at run time; a rule that throws or does not answer `true` refuses
NO_ROOM                                                         // refuses every position, look and emote
checkCenterMsg(m, rules = NO_ROOM)                              // a position that is not a walkable cell, a look that is not one, an emote >= rules.emotes, a name that is not cleanName(name): refused
createCenter({ bus, me, rules, now, timers, random, timing })   // + isIn(); the name goes out through cleanName
```

* **What a trainer publishes** is only the fields the room defines: `t, v, s, k`, and in a `here` `name, av, x, y, d` plus `b` (the board id) and `rec` when there are any. Nothing else the page knows (no
  team, no room) can ride along: `hereMsg` names each field, and N7a2 / K1g pin it.
* **Two caps, in this order** (the order changed after the review): one sender is heard at most `perSenderMax` (14) times a second, by the id the message claims, and what it sends beyond that is dropped
  BEFORE the room's own count; then the whole room is cut off above `totalMax` (260) messages a second. So one page that floods is cut off by itself and the others are still heard (it used to deafen the
  room); a flood under many sender ids still does, for the rest of that second.
* **What a stranger can still do** (the header of the file used to say otherwise): a sender id is only a claim, so anybody who has heard a trainer's id can send a step in their name, and the room shows
  that trainer on the forged cell until their own next `here` or step (at most 3 s). A forged cell is still a cell of the room, and talking to a trainer always goes through the board.

`EMOTES` and `EMOTE_NAMES` are gone (an emote is the number of a ROM icon), and the module imports neither a map nor a look table.

### The model's own methods (what the ctl drives) and effects

`setRoom(room)`, `room()`, `setMe({ name, rec, look })`, `setShares(list | string)` (what the signs and the Center's own question say: a page a thought), `askIn() -> boolean` (the Center's own question),
`walkIn(n) -> boolean`, `isIn()`, `me() -> { name, rec, look, x, y, d }`, `setRoster({ walkers, players })`, `people()`, `setNet('off' | 'connecting' | 'up' | 'down')`, `myEmote(e)`, `askAccepted()`,
`askFailed(why)`, `askWithdrawn(say) -> name | null`, `makeWay()`, `resume()`, `keepsPlace()`, `forgetPlace()`, `say(text)`, `kick('off' | 'noStart') -> effects`, `out() -> effects`.
Effects `{ app: 'center', type }`: `moved`, `look { code }`, `emote { e }`, `ask { id, name }`, `join { id, room }`, `cancel-ask`, `sound { what: 'bump' | 'door' | 'pc' }`; the ctl also hears the answer of
the Center's own question (`{ type: 'dialog', id: 'center:enter', value, app: 'center' }`, YES = 0).
Dialog ids: `center:enter`, `center:talk`, `center:asking`, `center:note`, `center:nurse`, `center:sign` (closed in `leave`); the line that says why the player was walked out is `ctx.notify` and stays.
`state()` gained `entering` (the Center's own question is waiting for its answer).
Test hook: `window.__arenaHub.center = { state(), people(), me(), sid(), wire }` (`state()`: `inside, mine, leaving, seam, net, sid, board, asking, entering, told, roomError`); the model's state is
`window.__arenaHub.apps.state().center`.
Test seams, honoured only with `?net=local`: `ctrname=<name>` (the name in the room) and `ctrav=<look code>`, so two tabs of one browser profile can be two trainers; `opendisc=1` makes that transport ask
first, as the public one does.

### Storage, topics, addresses

| Where | Key | Value |
|---|---|---|
| localStorage | `arena.avatar` | a look code, `w` + six base-36 digits (was: seven base-36 digits of the hand-drawn avatar; such a value reads as none) |
| localStorage | `arena.center.seen` (new) | `'1'` once the player has said YES to a question that said what the Center lists |
| sessionStorage | `arena.center.in` | no longer written or read (the page that used it is gone) |
| MQTT / BroadcastChannel | `bemental/arena/center/2` / `bemental-arena-center-2` | the room |
| address | `/pokemonarena/#center` | the Center; `/pokemonarena/center.html` forwards to it |

Nothing else is stored. `arena.open` is never written by the Center (it is on for the page only); `arena.open.seen` is written by presence_boot.js when the service's disclosure is answered YES;
`arena.meet` and `arena.back` are written by the seam's `goBattle`.

### Sound

* **Music**: the ctl calls `env.sound.music('pokecenter')` when the Center opens and `env.sound.music('hub')` when it closes. In the SoulGold soundtrack both keys are the same ROM song (song 400,
  `MUS-POKE-CENTER`, `js/music_map.js`), so THE MENU MUSIC STAYS, and it is the ROM's Pokemon Center theme. The map's own header names song 835 (`world.center.music`), which `music_map.js` does not map
  (`MUSIC_MAP.md`: "835 ... loop ... unmapped"); the music door a hub app has takes a `music_map.js` key only, so playing 835 needs a new key there (and in `MUSIC_MAP.md` and its test). Not done.
* **Effects**: a step is silent (every press in the room returns `{ type: 'sfx', key: null }`); the menu opens with `se_menu_open` (the ROM's `SE-WIN-OPEN`); the pickers and questions keep the hub's
  default cursor / select / back sounds. The wall bump, the door and the PC are three ROM effects the music map has no key for (`SE-WALL-HIT` 7, `SE-EXIT` 9, `SE-PC-ON` 4 in the SoulGold song table,
  `ROOM_SOUNDS`): the ctl plays them through `env.sound.system().director.playEffectIndex` while the SoulGold soundtrack is in use, and plays `se_back` (door) / `se_select` (PC) / nothing (bump) with
  another soundtrack, whose table has other numbers. The bump is heard once every 32 frames while a direction is held against a wall.

### What was deleted

`center.css`, `js/center_boot.js`, `js/center_draw.js`, `js/center_map.js`, `js/avatar.js`, `dev/avatar_sheet.html`, and the page in `center.html` (its canvas, buttons, dialog and status line).
Still naming them, in files that are not CENTER's: a comment in `js/openlobby.js` (line 51: "avatar.js parseAvatar") and one in `js/presence.js` (line 66: "center_boot.js"); the stub fixture
`tools/fixtures/pokemonarena/app-stubs/center_hub.js` (its header).

### Known limits

* **Names, up and down**: a plate laps over the trainer in the next row when two trainers stand in one column (the plates are drawn last, so the NAME always reads; a bubble can lose its top rows to the
  name of the trainer above). Side by side they no longer lie on each other. In a crowded row some trainers have no plate (see "Names").
* **A sprite on a sprite**: a trainer standing on the player's own cell is hidden behind the player's sprite (both names are written under the cell, which is how one knows).
* **The question before walking in is asked once per browser**, not once per tab as the first Trainer Center did for a player whose switch was off ("Who is asked before walking in").
* **One question at a time costs a challenge**: a player who is asked while waiting for an answer loses their own challenge (a line says so). A stranger who keeps asking can keep doing that; the service's
  own limits apply (six questions a minute, 20 s of quiet for a sender who was told no).
* **A player who is asked and then leaves or closes the page** leaves the asker waiting the whole answer time (27 s; CANCEL works meanwhile). Not shortened on purpose: the listing also goes when they say
  YES, and their `ok` can be lost on a public broker while the room (`acc`) still arrives, so "the listing is gone" must not end a challenge that was accepted.
* **An emote chosen within 900 ms of the last one** is not sent and not shown (the bubble shows only what the room was told).
* **The door mat**: a trainer standing on it takes a tap aimed at the mat (they are talked to; the d-pad and EXIT still leave), and stepping off it leaves without a question.
* **Touch sizes** (measured by the review on a 390 px phone): a floor cell and a WHO'S HERE row are 26 css px, a look-page arrow 33 x 26. Everything is reachable with the d-pad, A and B alone.
* The picture's clock stops in a hidden tab: a walker in a hidden tab stands still for the others (they stay in the room: the heartbeat, the board id and the roster run on timers) and cannot be seen
  walking until the tab is shown. A question that arrives there is in the dialog layer at once (the Center's dialogs make way on the service's event, not on a frame).
* Leaving for the Team Builder leaves the room (the others see the player go and come back) and, for a player whose stored switch is off, takes the listing down for that time.
* `ROOM_SOUNDS` are SoulGold song-table indexes: correct only for that soundtrack, which is why another soundtrack gets the mapped keys.
* The roster is pushed to the model every 500 ms and on every room or board event; an emote on another trainer ends up to 500 ms late.
* The hub's first paint loads `world_rom.js`, `center_hub.js` and `center_room.js` through `center_screen.js` (this file's app table allows it for the Center). Not measured.

### Tests (2026-11-18, this tree)

```bash
node tools/pokemonarena_center_test.mjs node             # the Node checks (275): L (looks), R (the room from the ROM), G (the grid), M1-M14 (the model; M14: the Center's own question, making way, notices,
                                                         # the guards the review's mutants walked through), S (the renderer, the hashes, the name plates), N (the room's messages, what a here carries,
                                                         # the two caps), T (the MEET token), K1-K10 (the ctl on two and three pages over Node's BroadcastChannel; K7 the Center's own question,
                                                         # K8 somebody asks over the Center's dialogs and two who ask each other, K9 CANCEL and leaving withdraw, K10 the public transport on a double
                                                         # of the MQTT library)
node tools/pokemonarena_center_test.mjs node --mutants   # ... and 114 defects, one at a time, each in a process of its own; each must fail the case it names (CENTER_MUT=<id> runs one; a ctl mutant
                                                         # runs only the block of the case it names)
node tools/pokemonarena_center_test.mjs                  # the Node checks, then real Chrome (54 cases): CB0 the redirect; CB1 the disclosure, NO, YES; CB2 two tabs; CB3 real keys and a click; CB4 a look
                                                         # and an emote; CB5 a hub player at a spot; CB6 a challenge declined; CB7 one accepted: a battle on both screens, the MEET token; CB8 the door mat;
                                                         # CB9 the PC and back; CB10 Open switched off elsewhere; CB11 a background tab; CB12 a phone (touch only) and a controller; CB13 the Center's own
                                                         # question (asked, NO, YES, remembered); CB14 "wants to battle you" over a sign and over an answer left on the screen
node tools/pokemonarena_center_test.mjs --mutants page-mutants   # seven defects in the page, served over the real files; each must fail its session
node tools/pokemonarena_center_test.mjs --update         # rewrite center.golden.json from what the ROM gives now (then LOOK at the pictures)
```

Ports: `ARENA_PORT` / `ARENA_CDP` (or `CENTER_PORT` / `CENTER_CDP`; defaults 8241 / 9441; the sessions use CDP+0..+4, the page mutants port+20.. and CDP+10..+50). Pictures: `CENTER_OUT`.

What the review found and where each fix is pinned: (1) a player whose switch was off and who had once answered the hub's disclosure was listed with no question, and never told about the look and the
cell: K7a-K7k, CB13a-CB13f, mutants NC20-NC26, NC40, NC41, BM6; (2) a challenge that arrived while a dialog of the Center was open was never shown, and two players who asked each other were both told
"said not now": K8a-K8g, M14h-M14k, M14t, CB14a-CB14d, mutants NC27-NC31, NC39, NC42, NM22-NM25, BM7; (3) three guards had no check: what a walker publishes (N7a2, K1g; NN18, NC38), CANCEL withdrawing a
challenge (K9a; NC32), leaving withdrawing it (K9b, K9c; NC33).

## BUILDER: as built

The Team Builder is built in three stages in the same worktree. This section says what EXISTS; each stage adds to it.

### Stage 1 (2026-11-18): the structure, trainers, teams, the team, rules, the check, the Pokemon's BUILD tab, the two pickers

**The paths** (all the builder app's; `parent` in brackets): `builder` TRAINERS (main), `builder-teams` TEAMS (builder), `builder-team` the six slots (builder-teams), `builder-rules`,
`builder-check`, `builder-mon` the Pokemon, `builder-species` the species picker (all builder-team), `builder-item` the held-item picker (builder-mon). Which team / Pokemon / tab a screen
shows is the model's FOCUS (`{ teamId, monId, tab }`), never part of a path; the tabs of the Pokemon screen are state too (L / R do not grow the history).

**The files** (`js/`):

| File | What it owns |
|---|---|
| `builder_hub.js` | THE ROUTER: `APP` (and `makeApp(families)`, `FAMILIES`, `collectFamilies`), the editor state, the focus, the one text entry, the one pop-up menu, YES / NO through the hub's dialog layer, the message box (help, a note, its pages), the autosave tag, the methods the ctl calls. Its header has the screen interface and the shared context `X` |
| `builder_home.js`, `builder_team.js`, `builder_mon.js`, `builder_pick.js` | the screen FAMILIES: trainers + teams; team + rules + check; the Pokemon screen with its tabs (BUILD; MOVES and STATS are placeholders that say so) and `numberMenu`; the species and item pickers |
| `builder_parts.js`, `builder_geom.js` | the model-side FURNITURE (`createList`: a scrolling, paging, wrapping, tappable list of any length; `createPopupSlot`; `pagesOf`; `chapterStep`; `sentence`) and every rectangle (shared with the renderer, so a tap lands on what is drawn) |
| `builder_kit.js` | the heavy pure layers bound to the decoded pack (`editor_state.js` reduce, `editor_data.js`, `rules.js`, `charset.js displayText`), made by the ctl and handed to the model as DATA: `app.attach(kit)`. NOT in the hub's first paint; the model files import nothing heavy |
| `builder_ctl.js` | the store sequence of the old `editor_app.js`: load on entry, a 250 ms debounce, `seq` / `savedSeq`, `saved` and `rebase`, `withStoredRecord`, the conflict question, read-only, flush on leave / pagehide / hidden; `env.refreshData()` after every save; the trainer list's store actions; the tab's focus (sessionStorage `arena.builder.at`) and the picker's sort (localStorage `arena.editor.speciesSort`, the DOM editor's key) |
| `builder_screen.js` | the renderer's FURNITURE `K` (one text function every text goes through, the strip, chips, the list window, the pop-up, the message box and its "more" arrow, ROM art by id) and `PAINTER_SETS` |
| `builder_screen_home.js`, `_team.js`, `_mon.js`, `_pick.js` | the painters, one module per family |

**How a later stage adds a screen** (`tools/pokemonarena_builder_test.mjs`, check "A. a later stage adds a screen...", does exactly this):

1. Write a family: `export const FAMILY = { id, screens: { 'builder-code': { parent: 'builder-team', title: 'Team Builder: Code', need: 'team', create(X) } }, ext: { ... } }`. `need` is
   `'none' | 'profile' | 'team' | 'mon'`: a screen opened without it (its address, a reload, a team deleted under it) is left for the nearest one that can be shown. `create(X)` returns
   `{ view(), press(action, info), pointer(ev), hit(x, y), rects(), state() }` and optionally `enter()`, `leave()`, `tick(held)`, `ready()`, `onEditor()`. `view()` returns
   `{ kind, title, help: text | [line, line], say, ... }` (`pagesFirst: true`: A turns the pages of a long help before it acts; `noTag: true`: no autosave tag; `menu: { rows, cursor }` feeds `hub.rows()`).
2. Add it to `FAMILIES` in `builder_hub.js` (an import and one word).
3. Write its painters `(K) => ({ kind: (f, b, view) => { ... } })` and add the set to `PAINTER_SETS` in `builder_screen.js`. A tab of the Pokemon screen registers its painter as `'tab:<layout>'`.
4. To put rows on the EXISTING screens, fill a registration point in `ext` (each entry `{ id, label, help, run(X, target) -> effects, when?(X, target), off?(X, target), stay? }`: stage 2, below;
   nothing is drawn for a point nobody fills): `'trainers.rows'` (IMPORT PROFILE, IMPORT SAVE, DATA), `'trainers.menu'` (PORTRAIT, UNDO, REDO; EXPORT, IDENTITY KEY), `'teams.rows'` (IMPORT A CODE,
   UNDO, REDO), `'teams.menu'`, `'team.chips'` (CODE, TEST: they stand between CHECK and MENU and share the chip row), `'team.menu'` (UNDO, REDO), `'mon.tabs'` (`{ id, label, create(X) }`: MOVES and
   STATS; a tab registered under an id that is already there REPLACES that tab).
5. Everything a screen needs is on `X`: `kit()`, `ed()`, `profile()`, `team()`, `mon()`, `at()` / `setAt(patch)`, `dispatch(action)` (THE ONLY WAY A PROFILE CHANGES: the reducer's error / notice goes to
   the message box and one `{ app: 'builder', type: 'edited' }` goes to the ctl), `memo(key, make)` (kept until the profile changes), `teamCheck(teamId)`, `flash(text)`, `ask(spec, answer)`,
   `entry`, `popup`, `go` / `back`, `eff(type, more)`, `ext(slot)`, `screen(path)`, `prefs()` / `setPref`, `measure`, `speciesName`, `monName`, `rules(id)`.
6. Something the store, a file or the clipboard must do is an EFFECT for the ctl (`X.eff('...')`): add its case to `builder_ctl.js effect()`; more pure layers go into `builder_kit.js`.

**Input, the same on every builder screen.** The d-pad moves; A acts; B goes back. Left / right change a choice row at once, jump a chapter in a picker, and open the row's menu on the
trainer and team lists. START or X: the menu (the two lists, the team); in a picker START is FIND and Y or X the filter panel; L / R: a page (lists) or the next tab (the Pokemon); SELECT: the next page of a
long message. EVERY ONE of those has a chip or a row in the picture (the hub's touch pad has only the d-pad, A and B): the MENU chip, the FILTER chip and its FIND row, the two page chips, the
tab chips, a tap on the message box. A note (what the reducer answered) is read to its end before A acts again; a help text never blocks A, except on the check screen, where reading the
reason is the point.

**The test hook** (browser): `window.__arenaHub.builder = { flush(), idle(), state(), kit() }`; the model is `__arenaHub.model.apps.builder` (`editor()`, `focus()`, `phase()`, `screens`),
its state `__arenaHub.model.state().apps.builder` (`phase`, `profile`, `seq`, `at`, `tag`, `note`, `popup`, `entry`, `screens`).

**Decisions a later stage should know** (each has a check):

* THE ENTER RULE of FIND takes a species only when its WHOLE name was typed or one Pokemon is left (`speciesEnterChoice(..., 'name')`). The DOM editor also took the first row under the
  Pokedex order; there the list was on screen while the word was typed, here the keyboard covers it. The first row is under the cursor instead, one A away.
* REMOVE (a Pokemon) asks YES / NO. The DOM editor did not ask because Undo was beside it. Stage 2 brought UNDO (it takes a removal back) and KEPT the question: in the picture UNDO is two
  presses away in the MENU, not beside the row, and REMOVE stands right under COPY.
* The conflict question has a third answer, LATER (it is where B lands: neither of the two real answers may be given by a stray B). It is armed, and asked again at the next edit.
* An empty team's check says "Add a Pokemon to check it" and lists nothing (the rules module's "wrong number of Pokemon" is not shown as a problem of a team nobody has filled yet).
* Another FORM of a species shares its name and number: its row in the picker says FORM where the number would be, and the side window shows which form it is.
* The reducer's words are shown as a sentence (a capital first, a full stop last), otherwise unchanged.

**Not there yet** (stage 3: profile export / import, import from a save, the data screen, the identity key, deep links into a team, the hub rows and battle-page links that still point at
`editor.html`, the DOM editor's deletion, the editor page test and the journey ported to the picture). Until stage 3 `editor.html` is still the page it was, and
`tools/pokemonarena_journey_test.mjs` reaches it by its address.

### Stage 2 (2026-11-18): the MOVES tab and the move picker, the STATS tab, the portrait, the team code, the test battle, undo / redo

**Four more paths** (twelve in all): `builder-move` the move picker (parent `builder-mon`), `builder-portrait` the trainer's portrait (`builder`), `builder-code` the team code
(`builder-teams`), `builder-test` the test battle (`builder-team`). MOVES and STATS are TABS of `builder-mon` (state, not paths); the placeholders are gone.

| File (`js/`) | What it owns |
|---|---|
| `builder_moves.js` + `builder_screen_moves.js` | the MOVES tab (four slots: the ROM type badge, the name, the ROM category icon; the numbers of the highlighted move under them; the move menu CHANGE / UP / DOWN / REMOVE) and `builder-move`: the learnable moves, usable ones first, each with its source tags (Lv 12 TM24); a foot line with the numbers, badge and icon; the filter panel TYPE, CATEGORY, POWER, SOURCE, SORT, USABLE, UNLEARNABLE, FIND, CLEAR, DONE; a row that cannot be taken is grey and A says why (the rules module's reason, the level it needs, "already knows this move") |
| `builder_stats.js` + `builder_screen_stats.js` | the STATS tab: EDIT (EVS / POINTS / IVS: what left / right change; POINTS or IVS only under rules that store points) with the budget beside it; six stat rows (name, the nature's arrow, the battle stat, a bar of the ROM's HP-bar tiles, EVs or points, IV); HIDDEN POWER (badge, power, the list of sixteen types); QUICK ACTIONS (RESET, SNAP, ALL 31, 0 ATK, 0 SPE, 0 ATK+SPE, ALL 0) |
| `builder_portrait.js` | `builder-portrait`: three of the ROM's 52 heads at a time, never shrunk; in the ACTIVE trainer's menu |
| `builder_io.js` + `builder_screen_io.js` | `builder-code` (COPY CODE, PASTE A CODE, ENTER A CODE; the preview; ADD AS A NEW TEAM) and `builder-test` (FORMAT, CPU, FOE, START); the team's CODE and TEST chips, the teams list's IMPORT A CODE |
| `builder_undo.js` | UNDO and REDO as rows: `undoRows(X)`, `undoHelp`, `undoAct`, `isUndoRow` for a list screen; registered entries for the menus |

**What changed in the stage-1 files** (a later stage should know):

* **An extension entry** is `{ id, label, help: text | [a, b] | (X, target) => ..., run(X, target), when?(X, target), off?(X, target) -> a reason while the row has nothing to do (it is grey and A says the
  reason), stay?: true (a pop-up row that keeps the menu open) }`. `builder_parts.js extRows / extHelp / extRun` show, word and run them; `X.ext(slot, target)` takes the trainer or the team a menu was opened on.
* **A pop-up menu scrolls** (`builder_parts.js createPopupSlot`): at most seven lines with its title; `view()` has the rows SHOWN, `cursor` among them, `offset`, `total`, `up`, `down`, `lane`; L / R page it.
  The team menu (seven rows), the move filter (ten), the Hidden Power types (sixteen) and the quick actions (seven) rely on it.
* **`numberMenu(X, spec)`** (`builder_mon.js`) takes `get()`, `jumps: [40]` (a `+40` and a `-40` row that keep the menu open), `name`, `what`.
* **The message box**: a note now stands over an open pop-up's help too (the answer to a row that keeps its menu open), and goes with the next input.
* **`X`** gained `emit(effect)` (ask the ctl from a screen's `enter()`), `settle()` (leave a screen that lost what it shows), `ext(slot, target)`. **The model's door** gained `tell(path, msg)` (the ctl
  answers a screen: the screen's own `tell(msg)`), `undo()` / `redo()`; `setPrefs` takes every preference (`speciesSort`, `statsView`); `state()` has `undo` / `redo` (the stack's depths).
* **The kit** gained `LINKS` (editor_links.js), `HP_TYPES`, `encodeTeam(profile, teamId)` and `decodeCode(text)` (both async, never rejecting).
* **The ctl** gained the effects `code-length`, `code-copy`, `code-paste`, `code-decode`, `test-start`, the `statsView` preference (`arena.editor.statsView`, the DOM editor's key), and a `keydown`
  listener for Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. `env.clipboard` (tests) stands in for `navigator.clipboard`.
* The trainer menu, the teams list, RULES, CHECK and the three tabs have UNDO and REDO; after CONVERT TO RULES the check's cursor is on UNDO.

**Input added.** On a stat: left / right one step (4 EVs, 1 point, 1 IV; a run on one number is ONE undo step), A the numbers pop-up; a tap on a number's halves steps it, a tap on the other number makes
it the one edited. START or X on STATS: the quick actions (also a row). In the move picker everything the species picker has (pages, chapters, FILTER, FIND). Ctrl+Z / Ctrl+Y on a keyboard, from any
builder screen, never under a text entry, a question or a DOM panel.

**Decisions of stage 2** (each has a check):

* THE TEAM CODE IS NEVER DRAWN and never reaches the model: the ctl makes it, tells the screen only its length, and writes it to the clipboard. PASTE A CODE reads the clipboard on that press (the way
  for a touch-only player); ENTER A CODE is the text entry, where Ctrl+V pastes. A browser that refuses to copy has no second way out of the picture (the DOM editor selected a textarea for a hand copy:
  there is no such thing here); the picture says so. The clipboard is asked IN THE CALL THAT CARRIES THE PRESS: PASTE A CODE reads at once, and COPY CODE writes at once whenever the code is already
  made (the screen asks for it when it opens, to say its length; a team edited since is encoded again first). Some browsers allow the clipboard only from inside the key press or the tap.
* teamcode.js's reasons are shown in its own words without the angle brackets the ROM font lacks (`ARENA1.<payload>.<check>` reads `ARENA1.payload.check`).
* The EVs / points view is the DOM editor's preference (same storage key). IVS is a third value of the same row, kept only while that Pokemon is open.
* The stat bars are scaled as the DOM editor scaled them (a base stat of 150 fills the bar), in the ROM's own green / yellow / red.
* A stat row has no column captions (the budget takes the first row's right side): the message box names both numbers of the highlighted row ("EV 252, IV 31").
* A row of the move picker shows as many of the move's sources as fit 56 px (usually one or two); the screen reader's words have them all.
* UNDO / REDO rows are always there, grey with nothing to do. In the trainer list they are in the menu of the ACTIVE trainer only (the stack is that profile's).
* The test battle does not write `arena.back` (Contract 6 names the Center; `js/hub_presence.js` is not in this branch): the battle's "back to the hub" goes where it goes today.

**Two faults a random walk found, fixed in stage 2** (the walk is now a check of the Node suite: 6000 inputs through the builder and, after each one, no fault, a plain view, a frame, spoken
words, every text in its room; each fix also has its own named check and mutants):

* The species picker's strip named the type AND the word looked for, which a long type name with a long word overflowed (it was cut). It names both only while they fit the room left of the
  chips (`builder_pick.js TITLE_PX`); otherwise the word stays, and the type is in the FILTER panel and in the screen reader's words (which now name the type and the word).
* UNDO on the CHECK screen of a team that was just made took the team away and then looked for the screen's rows: the press threw, so the hub dropped its effects (the save, the move to the
  teams list). The screen is left first.

**Not there yet** (stage 3): as listed above. Nothing of stage 2 points at `editor.html`.

## ONLINE: as built

The hub's `online` app (2026-11-18; revised the same day after its review: "After the review", below, says what changed and why): PLAY ONLINE is rows of the picture, and the HTML row that
stood under it (`#onlineLink`: Play online, Trainer Center, Open) is gone. Every name below is the name in the code. Nothing in the protocol moved (`js/netmatch.js`, `js/online_match.js`,
`js/openlobby.js`, `js/matchctl.js`, `js/engine*.js`, `lib/netplay.js`, and `js/online.js`, `js/presence.js`, `js/presence_boot.js`, `js/hub_presence.js`, `js/online_prefs.js` are untouched by this track).

### What exists

| File | What |
|---|---|
| `js/online_hub.js` | the state machine (pure). `APP = { id: 'online', paths: ['online'], parent: () => 'main', create }`. Exports the geometry (`OGEOM`), the words (`WORDS`: a function there takes the name that is listed, or the room), `onlineName` (netmatch.js `cleanName`'s rule, kept here so the hub's first paint does not load the engine; a test compares them), `quickWords(board, who, named?)`, `quickShort(who)`, `friendWords(kind, room, board, named?)`, the dialog ids `QUICK_ID` `FRIEND_ID` `BLOCKED_ID` `NOTE_ID`, `ONLINE_VISIBLE`, `NAME_MAX`, `ROOM_MAX`, `BUSY_TICKS`, `INVITE_ARM_TICKS`, `PASTE_MAX`, `HOSTS_SHOWN`, `MORE_PX` |
| `js/online_screen.js` | the renderer (pure): `createScreen(ui, h) -> { render(f, view), rowLayout(row, g, on), bannerLayout(head) }`. The two layouts are what the tests measure every row with |
| `js/online_ctl.js` | the side effects: `createCtl(env) -> { effect, enter, leave, dispose, state }`. Pure helpers: `inviteFromSearch(search)`, `boardOf(win)`, `withoutInvite(href)`. Keys: `NAME_KEY`, `TOLD_KEY`, `AWAY_KEY` |
| `js/hub_model.js` (one hunk, the shell) | `appRow(id)`: an app's model may word its own row of the main menu, `mainRow() -> { label?, help? } \| null` (below) |
| `pokemonarena/online_hub.golden.json` | FNV hashes of 48 scenes (hashes only) |
| `tools/pokemonarena_hub_online_test.mjs`, `tools/pokemonarena_hub_online_browser.mjs` | the suite: Node cases with source mutants, and the browser sessions with theirs (the second file is imported by the first: it is this track's too) |

### The screens

ONE hub path, `online` (`/pokemonarena/#online`); which of its two screens is up is the app's state (`hub.state().apps.online.screen`: `'menu'` \| `'invite'`).

| Row (id) | What A does |
|---|---|
| TRAINER CENTER (`center`) | `ctx.go('center')` |
| BATTLE ANYONE (`anyone`) | a notice in message pages (dialog `online:quick`): what other players see (THE NAME THAT WILL BE LISTED, by name, and whether an online record goes with it), the public servers the battle page dials (`openlobby.js brokersFor`, each host once, at most six named) and the host its script comes from, that they see the IP address, that a game is listed when nobody is waiting, that the team played goes to the other player; then `Find an opponent?` YES / NO with NO under the cursor. Only YES starts: START token `{ what: 'quick' }`, then `battle.html?online=1`. A browser that has said YES to a long notice before (`localStorage arena.online.told`) gets the short one (the name and the record) and the same question, NO first |
| INVITE A FRIEND (`invite`) | a notice (dialog `online:friend`): that the room is never listed, the same servers, script host and IP address, that the team played goes to the other player; then `Open a room for a friend?` YES / NO, NO under the cursor. Only YES starts: START token `{ what: 'host' }`, then `battle.html?online=1`. Told before: ONE page (`A private room, over public servers.` / the question) with YES under the cursor |
| JOIN A FRIEND (`join`) | the text entry (charset `code`, 8 characters). A PASTE (more than one character at once, at most `PASTE_MAX` of it) goes to the ctl, which reduces a friend's whole link to its code with the battle page's own `roomFromInput` (`js/online.js`, imported when the entry is opened); a paste that was cut to eight characters says so under the keys. OK: the code goes to the ctl as request number `req` and is checked against `ROOM_RE`; a code that is not one is refused in the battle page's words (a notice) and the entry comes back with what was typed. A room code: the same notice as INVITE A FRIEND (`You join room <CODE>. Nothing is listed. ...`) and `Join room <CODE>?`; it listens only 0.6 s after it appears (it does not come under a press). YES: MEET token, `battle.html?np=ROOM&join=1&meet=1` |
| TEAM (`team`) | a choice over the saved LEGAL teams, the active trainer's first, then RANDOM TEAM: the battle page's own list in its own order. Which one is shown is `online_prefs.js preselect()`, so it is the one that page will select. With no saved team the row says RANDOM TEAM and A opens the Team Builder (`ctx.go('builder')`); the box says why there is none (no team yet, none that is legal, or storage that cannot be read) |
| SIZE (`size`) | 3 V 3 / 6 V 6; a team of fewer than three is 6 V 6 only (the row is disabled and says why). On the guest's invite screen there is no SIZE row (the host decides) |
| NAME (`name`) | the text entry (charset `name`, 10 characters; it opens saying `Empty: your trainer's name is used.`). What is typed goes through `onlineName`; a name that rule would change comes back as it would be used, with the reason, to be accepted. Empty = the typed name is forgotten (the key is removed) and the trainer's own is used: the owner of the team chosen, else the active trainer, else none (`(NONE)`: the battle page says Host or Guest) |
| OPEN TO BATTLES (`open`) | `hubPresence(env).toggle()`. ON / OFF follows `svc.status()` on every change; `unavailable` disables the row. The first ON asks the service's disclosure in the picture |
| BACK (`back`), and B | the main menu |

**The cursor.** Entered from the main menu the screen starts on its first row, wherever the cursor was left (a second press of the A that opened PLAY ONLINE opens the Trainer Center: it cannot
switch OPEN TO BATTLES or leave the page). Coming back from a screen this menu opened (the Trainer Center, the Team Builder: B there, the browser's Back) it is on the row that opened it. A track
that opens the menu on a row of its choice calls `hub.apps.online.select(rowId)` after its `go('online')`.

**Which name is where** (what the review found unsaid). There are two names, and every line that speaks of a listing names the one it lists:

| | What it is | Who sees it |
|---|---|---|
| the NAME row | the name typed (`arena.online.name`), else the trainer who owns the team chosen, else the active trainer, else none | the opponent in any battle, and the board when BATTLE ANYONE lists a game (`js/online.js listGame`: `state.name`; "Host" when there is none) |
| the trainer name | the ACTIVE profile's `trainerName`, "Player" when there is none (`presence_boot.js readTrainer`, `identity`) | the board while OPEN TO BATTLES is on, the Trainer Center, a challenge sent from there |

OPEN TO BATTLES off reads `Lists trainer name <NAME> and / online record on public servers. A: on.`; on, `You are listed as <NAME>: anyone / can challenge you here. A: off.`, where `<NAME>` is what
the presence service says its listing carries (`svc.trainer()`, handed to the model with every status: `setPresence(status, listing)`) and, while it is off, what it will carry. The NAME row reads
`Shown in a battle and BATTLE ANYONE. / OPEN TO BATTLES lists <NAME>.`; BATTLE ANYONE, `Lists <the NAME row's name> with online record.` (`, no online record.` for a random team); TRAINER
CENTER, `Walking in lists <NAME> and your look.` The widest name there can be (ten W) fits every one of them (suite case W1).

**Nothing leaves for the battle page before the player has been told** what that page connects to. The battle page dials the public servers by itself the moment it is opened with a token (the
plain `?online=1` page also asks the board who is open), and nothing on it says so first: so it is said HERE. Every `start` effect is the YES of a question of this app (`online:quick`,
`online:friend`); there is no row that leaves in one press. The long notice is read once per browser (`arena.online.told`, set by the YES of either long notice: both name the servers, the script
host and the IP address, and say where the team goes). A list of server names too long for the sixteen pages a dialog may have (a `?wsbroker=` override) is replaced by their number.

**The invite screens.** When the hub page's own address names a room (`?np=ROOM&join=1` or `&host=1`: the battle page's CHANGE TEAM row, an old bookmark, a link somebody sent), the ctl reads it
with `inviteFromSearch` (the same room, role and refusals as `js/online.js parseOnlineQuery`; a room with no role is an invitation to join) and the model shows `YOU'RE INVITED / ROOM <CODE>` (TEAM,
NAME, JOIN THE BATTLE, BACK) or `YOUR ROOM / ROOM <CODE>` (TEAM, SIZE, NAME, OPEN THE ROOM, BACK). A page that booted on the main menu is taken to `#online`; a player who has already walked
elsewhere is not pulled away. **The screen appears by itself, so it is treated as a question nobody asked for:** for its first `INVITE_ARM_TICKS` (36 frames, 0.6 s, counted only while it is the
screen shown) it answers nothing but the d-pad's up and down (not A, not B, not left or right, not a tap), it is drawn with no row under the cursor, and its cursor starts on TEAM, never on the
button. JOIN THE BATTLE / OPEN THE ROOM then ask like INVITE A FRIEND (`Join room <CODE>?` / `Open room <CODE>?`); YES = MEET token + `?np=ROOM&join=1&meet=1`, or START `{ what: 'host', room }` +
`?np=ROOM&host=1`. A room that is not one (or both roles, or another game) is refused in words in the picture (a notice, dialog `online:note`) and the plain menu is shown. BACK (or B) puts the
room away: the menu is shown, the room leaves the address of the history entry the page stands on (`history.replaceState`, the test seams and `#online` stay) and is remembered in `sessionStorage
arena.online.away`, so a reload, or the browser's Back onto an older entry that still names it, does not bring it back; a FRESH arrival with the same room is a new invitation.

**A room code is one request** (`req`, a number the model gives every OK of the room entry and the ctl hands back with its answer: `roomTaken(req, room)` / `roomRefused(req, words)`). The model
hears an answer only while it is waiting (`busy`) for THAT request: after the player left the screen, after the menu gave up (ten seconds), or after another code was typed, an answer is dropped.
(The first build guarded with the flag alone; a second code typed while the first was still being checked raised it again and the first check then opened the first room.)

**Notices** (`app.say(words)`, a refused code): dialog `online:note`, wrapped with the room of the "more" arrow, and armed (0.6 s) because none of them comes under the press: the A that was on
its way does not dismiss words nobody has read. A notice about a refused code goes when the screen is left; the others stay.

**When the token cannot be written** (the browser blocks `sessionStorage`): the page does not leave. The picture says so (dialog `online:blocked`, armed like a challenge: it answers nothing for 0.6 s)
and asks GO ON / BACK. GO ON opens the fallback address of Contract 1 (`?online=1&ask=host`, `&ask=quick`, the plain `?np=ROOM&join=1` / `&host=1`); BACK stays. It never opens a bare `?online=1`.
Leaving the screen with the question up lets go of the address it was holding.

**A token of a start that did not leave the page is taken back.** One-time means the one page load that follows the press. A page that comes back from the back / forward cache removes the START /
MEET token at once. Otherwise, if the page is still here `STALE_MS` (5 s) after it left for the battle page (the browser cancelled the navigation), the next thing that reaches the ctl removes it:
a row pressed, a value changed, PLAY ONLINE left (B, another screen) or entered again. A data refresh, or a press in the moment before the page goes, does not; neither does moving the cursor
alone (no effect reaches the ctl): the token's own age (60 s, `presence.js`) is then the limit.

**A preference that cannot be stored** (TEAM, SIZE, NAME with `localStorage` blocked) is taken back in the picture at once, with the reason: what the menu shows is what the battle page will read.

### What other tracks can call or rely on

* **The addresses.** `/pokemonarena/#online` is the menu. `/pokemonarena/?np=ROOM&join=1#online` and `...&host=1#online` are the invite screens (BATTLE's CHANGE TEAM row; the hash may be left out).
  `ctx.go('online')` from any hub app opens the menu on top of it, on its first row; B comes back.
* **The main menu's row.** `hub_model.js` asks each app whose id is a row of the main menu: `model.mainRow() -> { label?: string (at most 24 characters), help?: [line, line] } | null`. Optional; a
  model without it, one that throws, or an answer of another shape leaves the row as the menu words it. PLAY ONLINE reads `PLAY ONLINE: OPEN` while the player is open to battles and
  `PLAY ONLINE: OFFLINE` while that is on but no public server can be reached; plain `PLAY ONLINE` otherwise. `center` / `builder` may use it the same way (the builder's row is `builder`).
* **The app's own methods** (`hub.apps.online`, a ctl's `env.model.apps.online`): `setPrefs({ teamKey, fmt })`, `setName(v)`, `setPresence(status, listing)` (`listing`: `svc.trainer()`, `{ name }`
  or null), `setBoard({ hosts, cdn })`, `setSeen(bool)`, `setInvite({ room, role: 'guest' | 'host' } | null) -> shown` (armed, the cursor on TEAM), `say(words) -> put` (an armed notice),
  `roomTaken(req, room) -> taken`, `roomRefused(req, words) -> taken`, `roomPasted(code | null, note?)`, `blocked() -> asked`, `notStored()`, `select(rowId)`, `allRows()`, `mainRow()`.
  `state()`: `{ screen, row, cursor, offset, team, fmt, name, typed, open, listed, invite, armed, busy, req, entry, seen, flash }` (`listed`: the name OPEN TO BATTLES lists; `armed`: false while an
  invite screen does not answer yet).
* **Effects** (all `app: 'online'`): `data` (from `onData()`: it is what wakes the ctl at the page's load), `start { kind: 'quick' | 'host' | 'room' | 'join', room, seen: true }` (always the YES of
  a question), `join-open`, `join { code, req }`, `paste { text }`, `prefs { teamKey? | fmt? }`, `name { value | null }`, `open`, `invite-away`, `leave`, `stay`. A press that does nothing on an
  unarmed invite screen returns the hub's silent press, `{ type: 'sfx', key: null }`.
* **Dialog ids** (the hub's dialog layer; all opened with `app: 'online'`): `online:quick`, `online:friend`, `online:blocked`, `online:note`. The presence service's own are `presence:challenge`,
  `presence:disclosure`, `presence:note`.
* **A battle started from this menu comes back to the main menu**: the ctl clears `arena.back` before it navigates (Contract 6). The Center writes its own through `svc.goBattle`. NOTE for CENTER
  and BATTLE: `svc.goBattle(...)` leaves at once, with nothing said. A track that starts a battle through it says what the battle page connects to itself (the Center's walking-in disclosure covers
  the listing; `online_hub.js friendWords(kind, room, board)` and `online_ctl.js boardOf(win)` are the words and the server list this menu uses, both importable).

### Storage keys

| Store | Key | Value | Writer / reader |
|---|---|---|---|
| localStorage | `arena.online.team` | `{ teamKey, fmt }` (SEAM's) | TEAM / SIZE through `online_prefs.js` / the battle page |
| localStorage | `arena.online.name` | the name the player typed; removed when the entry is accepted empty | NAME / the battle page (`js/online.js LS_NAME`) |
| localStorage | `arena.online.told` (new) | `'1'` once YES was answered to a long notice (BATTLE ANYONE's, or a battle with a friend's): the short ones are shown from then on | the ctl |
| sessionStorage | `arena.online.away` (new) | the room of the address that this tab's player put away with BACK | the ctl |
| sessionStorage | `arena.go`, `arena.meet`, `arena.back` | SEAM's, through `hub_presence.js battleStart` / `clearBack` | the ctl / the battle page |

### What was deleted, and the hunks outside this track's files

Deleted: the `<p id="onlineLink">` line of `index.html` (`#playFriend`, `#trainerCenter`, `#openToggle`); its rules in `arena.css` (the portrait `order`, the flex row, the pressed colour, the three
`#openToggle` visibility rules, the boot-time `visibility: hidden`) and the `margin-block` rule in `audiobar.css`; `'#onlineLink'` in `sound_system.js PROMPT_OBSTACLES` and the prompt's two
candidate spots beside the row; in `boot.js` the row's element in `fit()`'s `stackBelow`, and `button: $('openToggle')` / the `[hidden]` line of `noSwitch` (the service is handed `button: null`).
The 44 px a phone reserves under the picture is NOT the row's: it predates it (`boot.js fit()`, in the first commit) and stays. `hub_presence.js` still looks `#openToggle` up when no `button` is
passed; it finds none.

What each test that drove the row became:

| Old (where) | Now |
|---|---|
| H1 `the hub links to online play` (page test, `hub`) | H1: the main menu has PLAY ONLINE and `index.html` has none of the four ids. Browser: BH1-BH4, BI1 |
| A1, A2 the switch says Open: off / on (page test, `presence`) | A1, A2 read the OPEN TO BATTLES row (`toggleState`) |
| every `#openToggle.click()` (12 places: A, PB, C, D, E, G, UX, UO3) | `hubSwitch(page)`: PLAY ONLINE, the cursor on OPEN TO BATTLES, A, back to the screen the session was on |
| H320 / H390 the switch shares the link's row on a phone | removed (no row). BV1, BV2: a 390 px phone taps every row |
| UD1-UD6 a click on the switch asks the disclosure | the same cases, through `hubSwitch`. Browser: BO1-BO8; Node: O9-O16 |
| UM1, UM2 the focus of the HTML switch after a mouse click / under the keyboard; mutant M16 | meaningless (no button on the hub). UM1 is now "the picture follows the presence service whoever switched it"; M16 breaks `svc.onChange(onPresence)` in `online_ctl.js` |
| UW1, UW2, UN1, UN1b the switch's tooltip, live region, constant accessible name, the offline tooltip; mutants M20, M23 | the row: its two lines say what the tooltip said, `Lists trainer name <NAME> and online record on public servers` (UW1: the TRAINER name, by name, the record, public servers; M23 puts the vague "Lists your name and online record" back); the live region still says so and the row says `You are listed as <NAME>`, the name the listing carries (UW2, M24 unchanged); ONE label whatever the state, the value carries it, also for a screen reader (UN1, M20 on the row's label); offline is said in the row (UN1b) |
| UH1, UH1b the switch is invisible before the module has mounted; UH2 it is gone when the module cannot load; mutants M17, M18 | UH1: the row says OFF and nothing is listed; UH1b: a press made then is NOT lost (M18 on `hub_presence.js toggle`); UH2: the row says it could not load and cannot be pressed (M17 on the row's `disabled`) |
| UR4 / UR5 mount the DOM dialogs by hand on `#openToggle` | the same, on a button the test makes |
| OXT4 the static title of the switch in `index.html`; mutant X22 | OXT4 reads the row's words in the served `js/online_hub.js` (trainer name, online record, public servers); X22 drops the record from them |
| audiobar M20 (the hub gives back the row's margins on a 568 px phone) | removed with the rule. `phone` passes without it: the row took the room |
| audiobar M22 (the prompt's obstacle list) | the `from` string follows the list |
| hub-return W14 and its mutant (the lone link during boot) | W14: no frame shows an online row under the header during boot. Its mutant now puts an HTML row of online links back into `index.html` (the CSS rule it removed is gone) |
| hub-return W11 (a key pressed while loading runs no effect) | the same, not counting the app's own `data` effect (a data refresh returns it, no key does) |
| autoplay: clicks `#playFriend` | the experiment puts a plain link of its own on the page |
| center test CB (`#openToggle.click()` on the hub) | `window.__arenaHub.presence.toggle()` (CENTER's file: one line) |
| page test M14 (no disclosure on the first switch-on, in `presence_boot.js toggle()`) | the hub no longer calls that function (it was the HTML button's): M14 breaks `hub_presence.js turnOn`, which decides it for the row |

The counts the tests read from the docs are unchanged: `presenceui` 36 and `onlineux` 22 (`ONLINE.md`, `README.md`), hub-return 19 module + 23 page = 42 (`README.md`): each mutant that stood on the HTML
row was re-homed, none dropped. The one exception is the audiobar suite's M20: that suite now breaks things 43 ways, and `README.md` still says 44 (no test reads that number; the line is not this
track's to rewrite).

### Known limits (measured or read, not fixed here)

* A row of the menu is 12 logical px: 20 css px on a 390 px phone (BV2), the main menu's own spacing. The on-screen pad walks the rows, and its A presses the one under the cursor.
* The ninth row (BACK) is below the eight shown: a touch-only player reaches it with the on-screen pad (or presses the on-screen B, which does the same).
* The first BATTLE ANYONE notice is seven pages with the five default servers. B is NO from any of them.
* A page opened at `#online` with a room in its address shows the plain menu for the moment it takes the ctl to load, then the invite screen.
* The hub cannot know that `sessionStorage` is blocked before it tries: the storage question appears after the press, not before.
* The battle page's fallback questions (`?online=1&ask=host` / `ask=quick`) and its CHANGE TEAM row are BATTLE's and were not in this tree: here the page with `ask=` is the plain panel (it starts nothing).
* `README.md` lines 4, 40 and 113 still describe the row under the picture and the Trainer Center page (add-only rule): they are stale until the merge rewrites them.

### Tests (2026-11-18, this tree)

```bash
node tools/pokemonarena_hub_online_test.mjs --unit            # 187 passed (about two seconds): the model, the renderer, the ctl and the shell's hunk in Node, on a real hub model and the real ROM
node tools/pokemonarena_hub_online_test.mjs --unit --mutants  # + 94 source mutants (online_hub.js, online_ctl.js, online_screen.js, hub_model.js), each killed by the case it names
node tools/pokemonarena_hub_online_test.mjs --browser         # 54 passed, real Chrome, eight sessions (html open address blocked invite anyone ask devices; name some to run a subset)
node tools/pokemonarena_hub_online_test.mjs --update          # rewrites pokemonarena/online_hub.golden.json (hashes only)
```

The browser part has no mutants of its own: every guard it relies on is one of the Node mutants, or one of the page test's (`presenceui --mutants`: M16, M17, M18, M20, M23; `onlineux --mutants`: X22).

## BATTLE: as built

Stage 1 of 2 (2026-11-18): **the battle page's online screens are in the picture**. `battle.html?online=1...` has no HTML panel any more (`<section id="online">`: the cards, inputs, selects, buttons, the
players list, the progress card): the battle canvas shows ROM-drawn screens for the few things the page still has to say before a battle, and everything a player CHOOSES is the hub's (`online` app).
Stage 2 (2026-11-18, after the review): **a battle against the CPU asks "wants to battle you" and the disclosure IN THE PICTURE** (`js/battle_ask.js`), and its switch is a row of the pause menu; the header's `#openBtn` and its styles are deleted. See "Stage 2, and the fixes of the review" at the end of this section.
Nothing in the protocol moved: `js/netmatch.js`, `js/online_match.js`, `js/openlobby.js`, `js/matchctl.js`, `js/engine*.js`, `lib/netplay.js`, `js/presence.js`, `js/presence_boot.js`, `js/hub_presence.js`
and `js/online_prefs.js` are byte for byte what SEAM left; `PROTO`, `MSG`, `BEACON_V` / `TOPIC`, `SEAL_INFO`, `ACCEPT_KEY`, `MEET_KEY`, `START_KEY`, `resumeKey`, `GAME_KEY` keep their values;
`canonicalAddress`, `boardAddress`, `parseOnlineQuery` and `roomFromInput` are in `js/online.js` with the source strings the mutants of `pokemonarena_presence_test.mjs` and `pokemonarena_center_test.mjs` replace.

### What exists

| File | What | Tests |
|---|---|---|
| `js/online_view.js` (new, pure, no imports) | WHAT THE PAGE SHOWS: `onlineView(snapshot)` (the view), `stepsNow`, `layoutOf` / `rowRects` / `OGEOM` (where everything stands in 240x160), `sentencesOf` / `sentenceLayout` / `wrapWords` / `SENTENCE` (the sentence, in the normal ROM font when it fits, else the small one, else cut with "..."), `createOnlinePanel()` (the cursor over the rows), `speakOnline(view, cursor)`, `WORDS`, `UNDER_WAY`, `SLOW_JOIN_MS`, `fmtClock`, `fmtWords` | `tools/pokemonarena_online_view_test.mjs` |
| `js/online_draw.js` (new, pure) | THE PIXELS, from the ROM: `createScreen(ui, h) -> { render(f, view), fits(onlineView) }`, the shape of a hub app's renderer; `SCREEN_ID` | the same suite (D, F, golden hashes in `online_screens.golden.json`) |
| `js/online.js` (rewritten presentation half) | no DOM but the status line of a battle (`#netbar`). `createOnline(cfg)` returns `view()`, `act(id)` and the named actions; `parseOnlineQuery` reads `ask=host \| quick`; `ONLINE_SHARES` (exported words) | page test, every battle-page group; `pokemonarena_online_view_test.mjs` X1-X4 |
| `js/battle_boot.js` (hunks) | the canvas is up, fitted and listening before the first scene (`showOnline`), the loop draws the online screen while there is no scene, the buttons and the pointer go to it until a scene takes over; `hubUrl()` (Contract 6) | page test groups `easyjoin`, `screens`, `layout`, `openlayout` |
| `battle.css` | the panel's 116 lines are gone; `body[data-state="online"] #menuBtn { visibility: hidden; }` (the pause menu's button before there is a battle) | `screens` SC8c; view test X2 |
| `online_screens.golden.json` (new) | 20 frame hashes (FNV-1a of 240x160 RGBA). Hashes only | view test D8 (`--update`) |
| `js/battle_ask.js` (new, stage 2) | THE CPU BATTLE'S QUESTIONS: `createBattleAsk(env)`, `createAskPainter(ui, createHubScreen)`, `ASK_PATH`, `OPEN_ROW`, `openRowLabel(on)` | `tools/pokemonarena_battle_ask_test.mjs` (new); page test `presence` PF, `presenceui` cross / battlerow / hidden |
| `js/scene.js` (FOREIGN, 4 lines) | the pause menu's row: `opts.open = { label(), toggle(done) }` | page test UO1, UO2 (mutants M29-M31) |

### The battle page with NO valid token (Contract 1, as built)

| Address | The picture (`view().kind`) | Rows (`view().rows[].id`) |
|---|---|---|
| `?online=1` | none: `hooks.toMenu()` = `location.replace('/pokemonarena/' + <test seams> + '#online')`. Nothing is opened or dialled first | |
| `?online=1&ask=host` | `ask-host`: INVITE A FRIEND / OPEN A ROOM FOR A FRIEND? | YES `host`, BACK `back` |
| `?online=1&ask=quick` | `ask-quick`: BATTLE ANYONE / FIND AN OPPONENT?, with what YES goes through (public servers) and what other players will see. **Nothing is dialled before YES** (no broker, no CDN script) | YES `quick`, BACK `back` |
| `?np=ROOM&join=1` | `invited`: YOU'RE INVITED TO A BATTLE, ROOM, AS <name>, TEAM | JOIN THE BATTLE `go`, CHANGE TEAM `team`, BACK `back` |
| `?np=ROOM&host=1` | `room`: YOUR ROOM <ROOM>, ROOM, AS <name>, TEAM, the battle size | OPEN THE ROOM `go`, CHANGE TEAM `team`, BACK `back` |
| `?online=1&auto=host&for=..&rq=..`, no accept token | `ignored`: the words say it was ignored. No board is dialled | BACK `back` |

With the hub's token the page starts by itself exactly as SEAM built it (`startPlan`): START `{ host }` / `{ quick }` on the plain address, START `{ host, room }` on the room's host address, MEET on
`&meet=1`, ACCEPT on `auto=host`. **While a token is starting something** (the teams are read, the team is checked) the picture is the waiting screen with no rows, `view().kind === 'starting'`
(who the player will be in it, *Getting ready...*, the sentence): the question the same address would ask WITHOUT the token is never shown on the way. **A question the page falls back to after a token** (a room that could not open, a search that found nothing): the plain address shows `ask-host` or `ask-quick`
for what the token started, and the address gets `ask=<that>` so a reload is the same question.
`CHANGE TEAM` = `hooks.toTeam(room, role)` = `/pokemonarena/?np=ROOM&join=1<test seams>#online` (or `&host=1`): **ONLINE reads `np` and `join` / `host` in the hub's own address.**
The team used is the preference (`js/online_prefs.js preselect`) with the old fallback; the invite link the waiting screen hands out is unchanged (`/pokemonarena/battle.html?np=ROOM&join=1`).

### The API other code calls

```js
const online = createOnline({ win, doc, pack, bar, query, teamParam, formatParam, fingerprint, hooks });     // window.__arenaOnline
online.view()                 // online_view.js onlineView(snapshot): { screen: 'confirm' | 'wait' | 'hidden', kind ('invited' | 'room' | 'ask-host' | 'ask-quick' | 'ignored' | 'starting' | null), stage, role, heading, lede, ask, info, who, title, steps, at, status: { text, bad },
                              //   hint, elapsed, code, codeLabel, friendRoom, link, canShare, copied, cancel: { shown, label }, team, name, fmt, fmtShown, ready, canGo, canQuick, rows: [{ id, label, disabled? }], bar }
online.act(id)                // a row was pressed: 'go' | 'host' | 'quick' | 'cancel' | 'copy-link' | 'copy-code' | 'share' | 'team' | 'back'. Call it INSIDE the key / pointer handler
online.setForm({ teamKey, name, typed, fmt, room })      // the form model (what the hub stores as preferences; the tests' way in). -> a copy of the form
online.startAs(role) / go() / quick() / cancel() / copyLink() / copyCode() / share() / changeTeam() / back()
online.board()                // the games this page can play, as the list showed them: [{ room, who, fmt, rec, h }] ([] until something dialled the board)
online.watchBoard()           // dial the board and keep its list: what quick() does first. No row calls it; the page test's challengers and watchers do -> boolean
online.pick(room) / joinListed(room) / challengeResident(room)      // what a press on a list row meant (no row of the picture calls them)
// unchanged: begin(), onResult(choice), leaveToHub(), state, nm(), session(), flash, flashNow(), renderBar, lobbies()
// hooks: mountScene(ctl, info), sceneState(), showFatal({ title, message }), stage(s), changed(), toHub(), toMenu(), toTeam(room, role)

window.__arenaBattle.onlineScreen   // the picture, for tests: up(), press(action), pointer({ kind, x, y }), rects(), cursor(), armed(), frameHash(), canvasHash(), fits(), spoken(), draw()
window.__arenaBattle.ask            // a CPU battle's questions (stage 2): get() (the battle_ask object), state(), view(), rects(), spoken(), press(action, { repeat }), pointer(ev), tick(n), frameHash() (the battle + the question), canvasHash()
window.__arenaBattle.hubUrl()       // '/pokemonarena/#<arena.back>' or '/pokemonarena/'
```

`createOnlinePanel({ now, armMs })` (online_view.js): `press(action, view)` / `pointer(ev, view)` -> `null | { kind: 'move', index } | { kind: 'act', id } | { kind: 'refused', id }`; `hit(x, y, view)`, `rects(view)`,
`cursor(view)`, `armed(view)`. **A screen that took the place of another answers no A and no click for `armMs`** (the page passes `PANEL_ARM_MS` = 600 and `performance.now`; without them it answers at once). **B on a confirm screen is its BACK row; B on a waiting screen never closes anything** (it puts the cursor on the way out). A cursor the player moved keeps its row (by id) when a row appears; one nobody moved starts on the first row (COPY LINK when the room opens, not the way out).
`createScreen(ui, h)` is drawn through the hub's shell renderer: `createHubScreen(ui, { appScreens: { online: createScreen } }).render({ app: 'online', screen: 'online', env, tick, online: view, cursor })`.
**Stage 2** can draw a question over a battle the same way: that render call takes `dialog` (a hub_dialog.js view) and draws it over anything.

### Coming back (Contract 6)

`battle_boot.js hubUrl()` = `HUB_PAGE_URL + '#' + readBack(sessionStorage)` when `arena.back` holds a hub path (`hub_presence.js readBack`: the one pattern, never `main`), else `HUB_PAGE_URL`. It is where
EVERY way back goes: the result screen's BACK TO HUB, the pause menu's quit, BACK (and B) on a confirm screen, a wait the hub's token started that the player gives up, the error screen's button and its
B, the header's "Arena" link (CPU battles too; a Tower fight goes back to the Tower as before). The key is read, never removed, never written here.
**A cancelled wait:** started by a token of the hub (no press on this page) -> the hub (`hubUrl()`); started from one of this page's questions -> back to that question, no page load; a wait that
FAILED -> always this page's question, with the reason.

### What was deleted, and what was kept without a screen

Deleted: `buildPanel` and everything only it used (`ui`, `card`, the form nodes, `formControls`, `renderView`, `renderElapsed`, `renderSteps`, `renderOpenList`, `buildRow` / `fillRow` / `syncRows` and the
list's focus-heir logic, the open-games note, the privacy foot on the page), `PASTE A TEAM CODE` (the `paste` choice and its words), the join-by-typed-code box, the panel's CSS. `battle.html` held
no node of the panel (it was built in script): only its comment on `#live` changed.
Kept, with no row in the picture: the board connection (`ensureLobbies`, dialled by BATTLE ANYONE, an accepted challenge and a challenge sent from this page: **a private room's page no longer opens the
open-games board**; what `lib/netplay.js` dials to pair two browsers is as it was), defecting to a listed game, `joinListed` / `challengeResident` / `pick` (the hub's tests and the page test's challenger drive them through the hook), `board()`.
`boardPrivacyText` and `ONLINE_SHARES` are exported words with nowhere on this page to stand: **ONLINE: show them in the hub's menu** (what going online shares; what BATTLE ANYONE dials).

### Sentences re-worded (they could not fit their window in a ROM font that reads well)

The small ROM font's `m` and `w` read as `n` and `H`, so the layout sets sentences in the NORMAL font (about 35 characters a line) and these were shortened to fit:

| Was | Is |
|---|---|
| "You're hosting · room X" / "You're joining · room X" (the ROM font has no middle dot) | "You're hosting, room X" / "You're joining, room X" |
| "Waiting for your friend. The battle starts by itself as soon as they open your link (or type the code X) and press Join." | "Waiting for your friend. The battle starts by itself when they join." (the code is drawn large over it) |
| "Nobody was waiting, so your game is open: anyone can join it. The next player who presses Find an opponent, or picks you under Players online, joins you." | "Nobody was waiting, so your game is open: anyone who picks BATTLE ANYONE can join it." |
| "Your room is open, but the list of open games is not connected yet, so nobody can see your game yet. A friend can use the code X." (and "... cannot be reached ...") | "Your game is open, but the list of open games is not connected yet: nobody can see it yet." / "... cannot be reached: nobody can find it." |
| "Taking a while? ... If they closed it, ask them for a new link." | the last sentence dropped; the hint takes the place of "Connecting to the room X..." |
| "Your browser would not let the page copy. The link is selected above: copy it yourself." | "Copy was refused. Tell your friend the room code X on this screen." |
| "The player who tried to join could not connect. " + the friend sentence | "That player could not connect. Still waiting for your friend." |
| "Waiting for the player who challenged you to connect. (A friend can also use the code X.)" | "Waiting for the player who challenged you to connect." |
| "Your room is open, but the player who challenged you could not be told which room it is (their one-time key was not usable, or this browser has no WebCrypto). A friend can still use the code X." | "The player who challenged you could not be told your room. A friend can still use the code X." |
| "This browser cannot connect two players (it has no WebRTC or BroadcastChannel). Try a current ..." | "This browser cannot connect two players. Try a current Chrome, Firefox, Safari or Edge." |
| the NO_SEAL sentence (220 characters) | "This browser cannot challenge a player in private (it has no WebCrypto), so challenging is not available here." |
| "That game was just taken by someone else. Pick another one, or press Find an opponent." / "... not open any more. Pick another one, ..." | "... Try again to find another." |
| "The list of players online could not be reached, so there is nobody to find. Invite a friend instead, or try again." | "... so there is nobody to find. Try again later." |
| "That address tried to open a game ... so it was ignored. Host a game, or pick one below." | "... so it was ignored." |
| "... Start a new battle below." (a resume given up) | "... You can start a new battle here." |
| "Room X. Check your team, then press Join the battle." / "Pick your team and the battle size, then open the room. ..." | "Check your team, then press JOIN THE BATTLE." / "Check your team and the battle size, then press OPEN THE ROOM. Your friend joins with the code X." |
| "Get an invite link, or type the code your friend sent and press Join." / "Type the room code your friend sent you, then press Join." / "Paste a team code first, or pick a saved team." | gone with what they spoke of (the last guard says "This page has no room code to join. Open your friend's link again.") |

Every other sentence of the old tables is word for word. `tools/pokemonarena_online_view_test.mjs` F1-F6 holds each one against its window with the widest name and room code.

### Storage

No new key. Read: `sessionStorage` `arena.go`, `arena.meet`, `arena.accept` (taken once, as before), `arena.back` (read only), `arena.online:<ROOM>:<role>`; `localStorage` `arena.online.team`,
`arena.online.name` (written when the player gave a name: `setForm({ typed: true })`).

### Known limits (measured or read, not fixed here)

* A row of the picture is 12 logical px high: 19.5 css px on a 390 px phone (the picture is 1.625x there). The on-screen A / B / d-pad (44 css px or more) drive the same rows. Page test V2, Y2, SC10f.
* A controller's button is not a user gesture in every browser, so COPY or SHARE pressed on a pad may be refused; the page then says so and points at the code on the screen. Not tested with a real pad.
* The online screens have no music; the menu sounds are the hub's (`sound_system.js menuSfx`).
* The DOM error screen (address errors, a stopped match) is what it was; so is `#netbar`.
* `ONLINE.md`'s Trainer Center section still describes the first Trainer Center (a note at its top says so): CENTER's section here is the truth for the new one.

### Tests (this tree)

The counts are what each command prints as "passed". The battle-page sessions of the page test read and drive the picture; its hub sessions (ONLINE's) were not rewritten.

```bash
node tools/pokemonarena_online_view_test.mjs --mutants                    # 63 passed, 37 mutants: the screens in Node with the real ROM renderer (see its header)
node tools/pokemonarena_online_page_test.mjs                              # 528 passed, 20 groups (profile hub lobby match leaving rejoin resume timeout easyjoin screens refusals teams lead layout open openlayout presence presenceui onlineux tokens)
node tools/pokemonarena_online_page_test.mjs screens --mutants            # 75 passed with them: 53 cases and 22 mutants (new group: SC1-SC13, sessions bare ask copy back input battle; ARENA_SC=<session,...> picks some)
node tools/pokemonarena_online_page_test.mjs onlineux tokens --mutants    # 18 + 6 mutants (was 22 + 6: X06-X08 went with the list, X20 with the page's foot; X04, X05, X10-X13, X21, T04-T06 re-homed)
node tools/pokemonarena_online_page_test.mjs open --mutants               # 10 mutants, unchanged strings
node tools/pokemonarena_presence_test.mjs --mutants                       # 140 passed, 67 mutants (its 12 online.js mutants still apply)
node tools/pokemonarena_openlobby_test.mjs --mutants                      # 144 passed, 56 mutants
node tools/pokemonarena_netmatch_test.mjs --mutants                       # 333 passed, 39 mutants
```

Where the old presentation checks went (old id -> new check, or why it is gone) is the table at the end of `ONLINE.md` ("What the picture replaced, check by check").
Not this track's and not edited: `tools/pokemonarena_center_test.mjs` CB11 reads `#olGo` on the battle page (the first Trainer Center's browser cases; CENTER rewrites them): with the panel gone it
times out. The equivalent facts are page test SC7d (a MEET-token join, and its CANCEL going back to the Center) and EZ10 (the same address without the token is YOU'RE INVITED, one press).
One line of `tools/pokemonarena_hub_return_test.mjs` changed (F1 opens `?online=1&ask=host`: the bare address leaves for the hub by itself now).

### Stage 2, and the fixes of the review (2026-11-18)

**The CPU battle's questions are in the picture** (`js/battle_ask.js`). It runs the hub's presence service (`hub_presence.js createHubPresence`) on the battle page with a dialog layer of its own
(`hub_dialog.js createDialogLayer`) in place of the hub model's, and draws that layer's view over the battle's frame with the hub's renderer (`createAskPainter`: `hub_screen.js` with one app whose
render puts the battle's pixels down). So every guarantee of the hub's questions is the same code here: NO first and last (B is NO from any page), `DIALOG_ARM_TICKS`, the repeats of a held direction
ignored, one question at a time, the 25 s automatic NO, YES writes the accept token then leaves, a question that arrives under the Controls dialog or the Sound panel WAITS and listens 0.6 s after it
appears (INAPP.md decision 4). The service is made with `session: null` (it would clear `arena.back`, which is the hub's key and read only here) and `model.path() === 'battle'` (a battle accepted
from a CPU battle writes no back path). `battle_boot.js`: the question takes every button and the pointer ahead of the battle (`askUp()`), the battle is paused while it is in the picture
(`setPaused('presence:ask')`), its arm clock runs at the GBA rate while the tab is visible, `setPaused` tells it when Controls / Sound open or close, the live region reads it, the header's Menu
button does nothing under it. **Never in a Tower fight** (the guard returns before `battle_ask.js` is loaded, and the Tower's scene gets no `open`). **The switch is the pause menu's row**
`OPEN TO BATTLES: ON / OFF` (before FORFEIT, `scene.js opts.open`, a 4-line FOREIGN hunk): there is no row until the module is up and none if it cannot load; choosing it closes the menu, switches
(the first time after the disclosure in the picture) and brings the menu back on the row. **Deleted:** `#openBtn` (battle.html) and every battle.css rule that only it needed (the icon mask, the glow, the
phone squeezes it needed). **Not deleted:** `presence_boot.js`'s DOM dialogs (`mountDialog`, `mountChallengeDialog`, their CSS): SEAM's file, still used on this branch by `center_boot.js`
(`center.html`, CENTER deletes it) and by the page test's UR4 / UR5 / UK6 (mutants M02, M12, M19), which mount it by hand. Nothing on the battle page builds them any more.
Known limit: the question's words are the hub's (`challengePages`: "YES opens a 3 v 3 battle with them and leaves this screen.").

**Fixed from the review:**

| Finding | Fix | Check (mutant) |
|---|---|---|
| Stage 2 not built (DOM dialogs, header button) | above | battle_ask_test K1-K9 (10 mutants); page PF1-PF3, UB1-UB5, UO1-UO9, UL1, UH3, UH4 (M08, M28-M40) |
| `?online=1&ask=quick` dialled five brokers and a CDN script before YES | `boardWatched()` is gone: nothing is dialled until YES (`quick()`), an accepted challenge's room or a challenge sent from here; the question says YES goes through public servers | SC2a (S23), SC2f on the REAL transport: no WebSocket, no cross-site script or file; V12 (quick-no-servers) |
| `lib/netplay.js` drew `#npWaiting` / `#npRelay` | `new N.Session({ ..., ui: false })` | SC11d (S27) |
| a double A cancelled what the first started | `createOnlinePanel({ now, armMs: PANEL_ARM_MS })`: a screen that replaced another answers no A and no click for 0.6 s | view P12, P13 (3 mutants); page SC14 (S26) |
| a `{ host }` token on `?ask=quick` opened a private room | a token for the other question starts nothing (it is still taken) | TK7 (T07) |
| the starting screen: an empty message window | it says what is starting ("Your room opens in a moment.") | W15 |
| the slow-join hint's closing quote drawn as an opening one | it quotes nothing ("... still says WAITING FOR YOUR FRIEND.") | W16 |
| "AS Host" mixed case | AS is a LABEL of the line (`info[].rightLabel`), drawn in the labels' grey | V11 |
| window rings that touch next to a teal sliver | the rows beside the code are as tall as the code window, and their rings meet (`OGEOM.rows`: `x2: 124`, `wNarrow: 108`) | D3 (sample point moved), D8 (goldens updated: 11 frames) |
| "Copy was refused" stayed for the rest of the wait | said for 6 s, then the sentence comes back | SC3e (S24) |
| the header link: click only, a Tower fight followed a leftover `arena.back` | `homeTo()` sets the href once the address is read (and again on click / auxclick / pointerdown / focus / contextmenu); a Tower fight's is the plain hub | SC5d (S25) |

**Left as they are:** a reload of a BATTLE ANYONE game that listed itself comes back as YOUR ROOM (the canonical address is `?np=ROOM&host=1`, which the resume of a reloaded match needs; nothing
starts without a press, so the only cost is the wording); `input.js addPad()` starting a pad with `prev = []` (input.js is not this track's; read only, not measured); mutant R16 of the review (a
hidden view has no rows: equivalent); COPY / SHARE from a real controller (not testable headless).

**Tests after stage 2** (this tree; what each command printed as "passed" on the last run):

```bash
node tools/pokemonarena_battle_ask_test.mjs --mutants                     # 14 passed, 10 mutants
node tools/pokemonarena_online_view_test.mjs --mutants                    # 69 passed, 44 mutants
node tools/pokemonarena_online_page_test.mjs                              # 529 passed, 0 failed (1092 s), on 9ed36aaf
node tools/pokemonarena_online_page_test.mjs screens --mutants            # 85 passed: 58 cases and 27/27 mutants killed
node tools/pokemonarena_online_page_test.mjs presenceui --mutants         # 39 mutants (ONLINE.md states it). Run with ARENA_UI=cross,battlerow,hidden: all 17 of those sessions' mutants killed (the hub sessions' 22 were not re-run)
node tools/pokemonarena_online_page_test.mjs tokens --mutants             # 39 passed, 7/7 mutants killed
# also green on 9ed36aaf: pokemonarena_apps_test 363, tower_page_test 186, battle_page_test 176, hub_return_test 92 (+32 units), tower_test 304, scene_test 41, presence_test 140, hub_presence_test 117, netmatch 333, openlobby 144, online_prefs 35
```

FOREIGN hunks of this fix: `js/scene.js` (the row, 4 lines), `tools/pokemonarena_tower_test.mjs` Q34 and `tools/pokemonarena_tower_page_test.mjs` (one line each: they named `#openBtn`).

### The opening's A (2026-11-18)

**Reported by three test runs, never deterministic:** a CPU battle stood still on "CPU Easy would like to battle!" (step `sysintro`, mode `steps`) and no button moved it; a rerun passed. It was a real
defect of the game, not of the drivers: a player who presses or holds A (or B) while the opening's first message is typed hits it.

**The cause** (measured on the real run, `battle_sys.js` SystemRun, trainer intro id 1): the ROM prints the first message ("... would like to battle!{FB}", the only `{FB}` of the opening) for about
38 frames and IGNORES an A that arrives meanwhile; only then does it wait at the `{FB}` for a NEW press. An A 36..72 frames into the run (the message comes at frame 35) was lost, one at 74 or later taken.
The scene typed its own copy of the message and sent the ROM ONE A (3 frames) when that copy had been read: `MSG_HOLD` (36) frames after typing it, which is after the ROM's wait has begun. A held A or
B types the copy faster and cuts the hold to 6 frames, so the A landed at frame ~70, inside the print, and was lost; nothing pressed A again, and the run sat at its `{FB}` until `SYS_MAX` (3000 frames,
~50 s) cut it, while the player's buttons reach the scene and never the run.

**The fix** (`js/scene.js` `introRetryA`, `js/battle_sys.js` `SystemRun.textActive`): the A of a `{FB}` message is offered again, `A_GAP` (4) frames after each release, while the ROM's text printer is
still up (`textActive`: gTextPrinters' head is set) and no newer message has come. The first offer is unchanged, so an opening whose first A is taken plays the same frames as before (the anim-scene
goldens are unchanged); a run without `textActive` is never pressed again. `animInfo().aRetry` counts the extra offers.

**Checks** (`tools/pokemonarena_anim_scene_test.mjs`): core `system: the opening A: a player holding A through the opening does not stall it ...` and `... without a held button the first A is taken and
never offered again` (the stub intro prints for 38 steps as the ROM does: `printFrames`), killing the mutants `SYSTEM/opening A: the A for the first message of the opening is offered once only` and
`SYSTEM/opening A: the A is offered again for every message ...`; on the real ROM, `4. opening A (ROM): an A 5 frames into the first message is ignored ..., one 60 frames in is taken` and
`4. opening A (ROM): A held through the opening reaches the action menu ...`.

**Reproduction** (scratch probe, battle.html alone, desktop 1280x800, keys: the team picked, then A every ~70 ms until the action menu, 40 s limit): before the fix 6 of 20 battles (seeds 1000-1019)
stood on the first message with the scene's A released (`hold` 6 or 8 = the held-button path, `keyLeft` 0, the run not ready); after it 0 of 40 (seeds 1000-1039, the six that stalled included).
In Node with the real ROM, A held through the opening: before, every seed ran to the 3000-frame cut; after, the action menu in 431-507 ticks (untouched: 457-527).

**Not explained:** one phone run of `pokemonarena_journey_test.mjs` after the fix still stopped with "battle bot made no progress for 600 inputs in mode steps"; two more full runs (105 passed each) and four
phone-only runs, and ten whole phone battles of the scratch probe (worst wait of the bot 253 inputs), did not repeat it. The bot now prints the scene's state when it gives up, so the next one says where.

```bash
node tools/pokemonarena_anim_scene_test.mjs     # 133 passed, 72/72 mutants killed (two new: SYSTEM/opening A)
```

## TRAINER: the new-trainer screens, the trainer card, N / M (contract, 2026-11-18)

The owner: "when a person navigates to the page, they are greeted with the pokemon arena app and asked to create a profile - we need an entire profile creation suite, avatar, battle
figure, nick name, everything - everything needs to be seamless and within the pokemon arena app. controls can be updated for keyboard with n/m for ergonomics." Both rules at the top of
this file hold: ROM art only, everything inside the 240x160 picture.

### Decisions already made (do not reopen)

1. **A first visit is greeted in the picture.** When the hub page is up, its data is `ready`, the open screen is `main`, and either the browser holds NO profile or the ACTIVE profile's card
   is not `made`, the hub opens the NEW TRAINER screens (`trainer-new`) by itself. A profile from before schema 6 is offered the same screens PRE-FILLED ("welcome back"), keeping its name,
   portrait, teams and record. The player may say LATER: remembered for the tab (`sessionStorage['arena.welcome'] = 'later'`), asked again on the next visit. Storage that is unavailable or
   not kept (`notSaved`) never opens it (nothing could be saved). A page opened at any other address (an invite link `#online`, `#center`, `#builder` ...) is not interrupted.
2. **The test rigs' switch:** `localStorage['arena.welcome'] === 'off'` stops the automatic opening (nothing else changes; the TRAINER CARD row and every screen still work). `tools/headless_cdp.mjs`
   seeds it for `/pokemonarena/` pages unless `withBrowser({ welcome: true })`, so the suites written before this feature keep starting on the main menu. A player never sets it.
3. **What a trainer chooses:** NAME (`profile.trainerName`, the in-picture keyboard, `charset: 'name'`, max 10; the ROM-style preset names are offered beside NEW NAME), LOOK (the Trainer Center's
   walking sprite: `card.look`, a `center_look.js` code over `world.ow.avatars`), BATTLE FIGURE (`card.front`: a ROM trainer front picture from `trainer_figures.js frontChoices`, what OTHER
   players see in an online battle and on the card; `card.back`: a ROM trainer back picture from `backChoices`, what the player sees from behind in their own battles), PORTRAIT
   (`profile.avatar`, the ROM's 52 trainer heads, as the Team Builder's PORTRAIT), PARTNER (`card.partner`: a favourite Pokemon species; the hub's title screen shows it instead of the day's
   mascot). Every step opens on a sensible default, so A, A, A ... makes a trainer; the last step shows the TRAINER CARD and asks to confirm.
4. **One way to make a trainer.** The Team Builder's NEW TRAINER opens the same screens (`go('trainer-new')`) and comes back to the builder. The main menu gets a TRAINER CARD row (`trainer`):
   the card of the active trainer, and from it every choice again (each opens its own step alone and comes back), SWITCH TRAINER (several profiles), NEW TRAINER.
5. **The look is the trainer's.** `card.look` is the source of truth for the active trainer; `localStorage['arena.avatar']` (`center_look.js LOOK_KEY`) stays as the copy the Trainer Center
   reads, and both are written together (the new-trainer screens, the card, and the Center's own LOOK).
6. **Keyboard: M = A, N = B** (the site's GBA page has the same layout: `gba/gbaWasm/dist/input_controller.js` Mapping_Action_A 'm', Mapping_Action_B 'n'; B on the left of A as on the
   console). They come FIRST in `input.js DEFAULT_KEYS` so every on-screen hint names them (`glyph`); Z / X, Enter / Space and Backspace / Escape stay as alternates. The M key is no longer
   the mute shortcut.

### The data: profile schema 6 (`js/trainer_card.js`, written with this section)

```js
profile.card = { made: false, look: null, front: null, back: null, partner: null }    // trainer_card.js header: the meaning and the shape of each key
import { emptyCard, cardIssues, repairCard, checkCardPatch, cardOf, isMade, CARD_KEYS } from './trainer_card.js';
```
`MIGRATIONS[5]` adds `emptyCard()` to every profile (pure, idempotent); `checkProfile` adds `cardIssues` under the code `profile.card`; normalize repairs with `repairCard` and keeps unknown
card keys in `card._unknown`; export / import / merge carry it. `cardOf(profile)` is how every reader reads it (an older document reads as the empty card).

### The figures: `js/trainer_figures.js` (written with this section)

`frontChoices(rom) -> [{ pic, trainerId, cls }]` (81 in this ROM), `trainerForFront(rom, pic) -> id | 0`, `backChoices(rom) -> [0, 1]`, `FRONT_EXCLUDE`, `FIGURE_DEFAULT`. Draw a front with
`speciesgfx.js trainerFront(rom, pic)`, a back with `trainerBack(rom, i)` (first frame), a head with `trainerHead(rom, i)`.

### The tracks

| Track | Branch / worktree | Ports (server / CDP base) | Builds |
|---|---|---|---|
| SCHEMA | `prof-schema` / `C:/Users/Admin/Dev/wt-prof-schema` | 8141 / 9341 | profile schema 6 + its save API for the app (`js/trainer_store.js`) + every test that pinned schema 5 |
| APP | `prof-app` / `C:/Users/Admin/Dev/wt-prof-app` | 8181 / 9381 | the hub app `trainer` (the new-trainer screens + the card), the first-visit opening, the menu row, the partner mascot, the builder's NEW TRAINER, the Center's LOOK writing the card, the `headless_cdp.mjs` seed |
| KEYS | `prof-keys` / `C:/Users/Admin/Dev/wt-prof-keys` | 8221 / 9421 | M = A, N = B, the mute shortcut moved, every hint / doc / test that names the old keys |
| BATTLE | `prof-battle` / `C:/Users/Admin/Dev/wt-prof-battle` | 8261 / 9461 | the battle page shows the trainer: their name in the battle's text, their back figure, and an online opponent's front figure; `backChoices` beyond [0, 1] if the ROM's code really draws them |

### Who may edit what (anything not in your row: smallest hunk, listed in your report as `foreignHunks`)

| Files | Owner |
|---|---|
| `js/profile.js`, `js/store.js`, `js/hub_data.js` (add `card` + `avatar` to each profile summary), `js/editor_state.js` (a `card` action for the builder's reducer), new `js/trainer_store.js`, `js/trainer_card.js` (bug fixes only), `tools/fixtures/pokemonarena/*` (new v6 fixtures; old ones stay), every test that pins schema 5, new `tools/pokemonarena_trainer_card_test.mjs` | SCHEMA |
| new `js/trainer_hub.js`, `js/trainer_screen.js`, `js/trainer_ctl.js`, any new `js/trainer_*.js` except the two above; one line each in `js/hub_apps.js`, `js/hub_app_screens.js`, `js/hub_app_ctls.js`; `js/hub_model.js` (the row, the mascot), `js/hub_screen.js`, `js/boot.js` (the smallest hunks), `js/builder_home.js` / `js/builder_hub.js` (NEW TRAINER), `js/center_ctl.js` / `js/center_hub.js` (LOOK writes the card), `trainer_figures.js` `FRONT_EXCLUDE` only, `tools/headless_cdp.mjs` (the seed), `hub.golden.json`, new `tools/pokemonarena_trainer_test.mjs` + `tools/pokemonarena_trainer_page_test.mjs`, the hub / journey / builder tests where a row moved | APP |
| `js/input.js`, `js/sound_system.js` (the mute key), `js/controls_dialog.js`, `js/input_panel.js`, `js/hints.js`, every hint text that names a key, `INPUT.md`, `tools/pokemonarena_input*.mjs` and every test that pins a default key | KEYS |
| `js/battle_boot.js`, `js/scene.js` / `js/anim_sys.js` (the player's back figure, a foe trainer id handed in), `js/online.js` / `js/online_match.js` (the figure in the hello), `js/netmatch.js` (ONLY an optional `fig` in the hello, old peers unaffected), `trainer_figures.js` `backChoices` only, the battle-page tests | BATTLE |
| `README.md`, `INAPP.md` | everybody, ADD-ONLY: one section `### <TRACK>: as built` at the end of this section |

Every working rule of "Working rules that are the same for every track" above holds (LF, pathspec commits, `git ls-files | wc -l`, nothing ROM-derived committed, headless muted Chrome
through `tools/headless_cdp.mjs` only, ONE browser suite of yours at a time and only above 3500 MB free, a named check and a source mutant for every new guard, never push, never `git stash`).

### APP-UI: as built

The hub app `trainer` (`js/trainer_hub.js` model, `js/trainer_screen.js` renderer, `js/trainer_ctl.js` ctl, `js/trainer_geom.js` the shared geometry), registered with one line in each of
`hub_apps.js`, `hub_app_screens.js`, `hub_app_ctls.js`. `trainer_figures.js FRONT_EXCLUDE = [67, 78, 137, 138, 139]` (from a contact sheet of every front choice: 67 Twins and 78 Young
Couple are two people; 137, 138 'Spirit' and 139 lie beyond `speciesgfx.js TRAINER_FRONT_COUNT` (134), so `trainerFront` throws on them).

**Paths.** `trainer` (parent `main`): THE TRAINER CARD of the active trainer; the card IS the menu: its parts NAME / LOOK / PORTRAIT / FIGURE / PARTNER are highlighted by the d-pad (up / down
between the name, the pictures and the chips, to the nearest across; left / right along a row, wrapping) or a hover, and A / a tap opens `trainer-edit` on that part; the chip row under it is
SWITCH (only with two trainers or more: a ROM window listing them) / NEW TRAINER / BACK. No trainer: "NO TRAINER YET", NEW TRAINER / BACK. A read-only trainer: A on a part is refused in
words. `trainer-new` (parent `trainer`): the new-trainer screens, the step is state. `trainer-edit` (parent `trainer`): one part again; opened by its address with nothing in hand it steps back
to the card.

**The steps** (every one opens on a default, so A, A, A ... makes a trainer; B = the step before):
WELCOME (the hub's dialog layer over the terrain with the default partner standing: LET'S GO / LATER; B = LATER; the screen asks itself when the dialog layer refused the question) ->
NAME (NEW NAME = the shared text entry, charset `name`, max 10; then the presets GOLD / ETHAN / LYRA / KRIS; a typed or pre-schema-6 name is a row of its own; the side window shows the
battle figure) -> LOOK (`world.ow.avatars`, 8 x 2 a page, the highlighted one walks in place; default: this browser's stored look, else `pickLook(avatars, seed)`) -> BATTLE FIGURE (the
front pictures of `frontChoices`, three a page, the class on a chip; default picture 71, the ROM's player-like PKMN Trainer, else the first) -> FIGURE FROM BEHIND (`backChoices`, read every
time) -> PORTRAIT (the 52 heads; default 0) -> PARTNER (a list of the pack's legal species with the front sprite beside it; row 0 is SEARCH (also Y): a text entry, charset `search`,
max 12, matching anywhere in the name; default: the day's mascot) -> THE CARD ("Is this right?" YES / CHANGE; CHANGE moves the highlight onto the card's parts: A on one opens that step
and its A comes back to the card; the figure goes through its two pictures). Pickers: left / right one thing (a held repeat stops at the ends), up / down a row (lists: wrap), L / R a page
(lists: also left / right), the wheel, the two page chips in the title strip, taps (a hover highlights, a click takes).

**The model's public methods** (beyond the hub's): `welcome({ kind: 'new' | 'back', name, profileId? })` (the shell, before `goto('trainer-new')`: 'new' CREATES, 'back' UPDATES the named
(else active) profile, pre-filled with its values read LIVE, so a store list that arrives after the screens opened is used; the question is armed with `DIALOG_ARM_TICKS`; LATER goes to
`main`), `begin(kind)` (the card's NEW TRAINER: 'another', not armed, LATER goes back); the ctl's door: `setChoices`, `setSeed`, `setMascot`, `setStoredLook`, `setTrainers`,
`saved(result)` (-> effects: back on ok; on a failure `WORDS.failed[why]` stays in the message box and the screen stays; why = readonly | notsaved | conflict | invalid | nostore | failed),
`saving()`, `failed(why)`, `draft()` (tests). `onData()` returns `{ app: 'trainer', type: 'data' }` only once the ctl has handed a list (an unloaded ctl stays unloaded).

**Effects** (`app: 'trainer'`): `opened { path }`, `later { kind }`, `save { mode: 'create' | 'update', profileId, name, avatar: { kind: 'preset', id }, card: { made: true, look, front,
back, partner } }`, `update { profileId, field, patch }` (patch: `{ name }`, `{ avatar }` or `{ card: {...} }`; an edit that changes nothing is no effect, just back), `switch { id }`,
`data`. A refusal plays `se_failure` (`{ type: 'sfx' }`); the ctl plays `se_success` after a save.

**The ctl.** `trainer_store.js` only: `createTrainer` / `updateTrainer` / `setActiveTrainer` / `listTrainers`; its codes map to the model's words (`trainer_ctl.js WHY`). After a write:
the look to `localStorage['arena.avatar']` (`center_look.js saveLook`; for an edit only when it is the active trainer's), `env.refreshData()`, the success sound, then `saved()`.
Storage keys: `sessionStorage['arena.welcome'] = 'later'` (LATER), `localStorage['arena.avatar']` (the look). The choices: `choicesOf(rom, pack)` (looks, fronts with their class
spelt for the ROM font: `{PK}{MN}` -> PKMN, the sex signs as tokens; backs; 52 heads; legal species); the mascot: `hub_data.js pickMascot(pack, today)`.

**Known limits.** `tools/pokemonarena_apps_test.mjs` pins EXACTLY three apps (lines 163, 639, 1142): with `trainer` registered it fails those 5 checks (164 passed, 5 failed, `--unit`), and
this track may not edit it. The record line on the card is hub data's `BATTLES n` (`listTrainers` carries no stats). The welcome's words and the presets are this site's, set in the ROM font.

**Tests (2026-11-18, this tree).** `node tools/pokemonarena_trainer_test.mjs --mutants`: 44 Node checks passed, 28 / 28 source mutants killed (families R W A B K N P C E F G Z: the registry,
the welcome, A-through into a memory store through the real ctl and `trainer_store.js`, B on every step, every picker's keys / taps / wheel / paging, the name entry, the search, the card
step, the card screen and editor, every refusal in words, 32 screens against `pokemonarena/trainer.golden.json` (hashes only) with every text measured in its room at the longest values
(ten of the widest character the `name` charset accepts, the longest species and class), a random walk of 3000 inputs). `TRAINER_SHOTS=<dir>` writes those screens as PNG to look at.
Browser: not run by this track (the page test is APP-SHELL's).

### APP-SHELL: as built

The shell's half of the TRAINER (decisions 1, 2, 4, 5 and the menu row). Every piece is in a file the APP row gives the shell; nothing of the trainer app's own files was edited.

**The main menu** (`hub_model.js`). A TRAINER CARD row (`id: 'trainer'`, opens the path `trainer`; help "Your trainer: name, look, battle / figure, portrait and partner.") stands RIGHT AFTER
TEAM BUILDER: the five rows above it, and QUICK BATTLE under the cursor at the start, keep their places (the tests and the hands that walk to them by position), it is among the eight rows shown
without scrolling, and it sits beside the other row about the player's trainer. The menu has eleven rows now; RECORD is the seventh, CONTROLS the ninth, ABOUT the eleventh.
**The title side.** The ACTIVE trainer (`activeOf(profiles, activeId)`: the store's active id, else the only profile there is) is the title screen's: its `card.partner` stands where the day's
mascot stood (on every screen the mascot stood on: the main menu, QUICK BATTLE, ABOUT; MY TEAM still shows the team's lead) when the ROM can draw it (`createHubModel({ hasSpecies })`; boot.js
passes the pack's legal species), and its name is drawn under POKeMON ARENA in a small ROM font (`view.trainer` on the main menu's view; `GEOM.titleNamed`: the title window grows upwards
to x 148 y 78 w 84 h 28, just under the mascot; a ten-letter name fits, measured). `setData` now keeps each profile's `card` (`cardOf`) and `avatar`, so `ctx.profiles()` hands the apps
the card; `hub.active()` is a copy of the active trainer `{ id, name, readOnly, card, avatar }` for the ctls (the Center's look).

**The first-visit opening** (decision 1). `hub_model.js welcomePlan(data, { openedAt, path, later, off, stored })` is the rule, pure: `null`, `{ kind: 'new' }` (no profile) or `{ kind: 'back',
name, profileId }` (the active profile's card is not made). It asks: the data `ready`, not `notSaved`, the store open; the page OPENED at the main menu and still on it; sessionStorage
`arena.welcome` not `later`; localStorage `arena.welcome` not `off`; a read-only active profile is not greeted. `boot.js greet(d)` asks it ONCE per page load, at the first data refresh,
calls `hub.apps.trainer.welcome({ kind, name, profileId })` and runs `hub.goto('trainer-new')` (trail `['trainer', 'trainer-new']`). `window.__arenaHub.welcome = { plan, opened }` is the
test hook. `WELCOME_KEY = 'arena.welcome'` (hub_model.js).

**The test rigs' switch** (decision 2). `tools/headless_cdp.mjs` exports `WELCOME_KEY` and `WELCOME_SEED` (a script: on a `/pokemonarena/` page, while the key is unset, localStorage
`arena.welcome = 'off'`; never throws) and every `Page` installs it before each document (`Page.addScriptToEvaluateOnNewDocument` in `init()`) unless `withBrowser({ welcome: true })`;
a second tab (`openTab`) inherits the choice; `headless_cdp_multi.mjs` pages are seeded (they are made through the same `Page`). Arena browser suites that launch Chrome some other way: only
`tools/pokemonarena_idb_smoke_test.mjs` (its restart launcher), and it opens `pokemonarena/dev/idb_smoke.html`, never the hub, so it needs no seed (grep of `tools/pokemonarena_*.mjs` and
`tools/*arena*` for `spawn(CHROME` / `--remote-debugging-port` / puppeteer).

**One way to make a trainer** (decision 4). The Team Builder's NEW TRAINER (`builder_home.js`) is `X.go('trainer-new')`; its own name entry, the `profile-create` effect and the ctl's
`createProfile` are gone. When the hub's data then shows a trainer the builder's list does not know, or a different active one, while a builder screen is open, `builder_hub.js onData()` asks
for `{ app: 'builder', type: 'sync' }` and `builder_ctl.js syncActive()` reads the list again and opens the store's active trainer (no refresh of its own: no loop). Coming back from the
screens (B, or YES) re-enters the builder, whose `enter` loads the store's active trainer anyway: the player finds the trainer made, ACTIVE, on the list.

**The look is the trainer's** (decision 5, `center_ctl.js`). `myLook()`: the active trainer's `card.look` when the ROM has that sprite (copied to `arena.avatar`), else `arena.avatar`, else
one picked and kept in the browser only (a look nobody chose is not written on a card). The Center's LOOK (`{ app: 'center', type: 'look' }`) writes `arena.avatar` AND the active trainer's
`card.look` (`trainer_store.js updateTrainer(store, id, { card: { look } })`), then `env.refreshData()`; `__arenaHub.center.state().lookWrite` says how the last card write went.

**The ripple** (deliberate): `pokemonarena_hub_test.mjs` (eleven rows; CONTROLS / SOUND / ABOUT one further down in the browser sessions; new checks and 14 mutants for the row, the partner,
the name, `welcomePlan`, `active()`), `pokemonarena_record_test.mjs` and `pokemonarena_stats_page_test.mjs` (RECORD is the seventh row), `pokemonarena_journey_test.mjs` and
`pokemonarena_devices_test.mjs` (the row lists), `pokemonarena_builder_test.mjs` (NEW TRAINER opens trainer-new; a sync check and three mutants; the RENAME entry stands in for the old one; a
not-kept store is seeded directly; the old name-entry picture dropped), `pokemonarena_builder_page_test.mjs` (its three sessions make their trainers through the NEW TRAINER screens: keys,
taps, a controller). `hub.golden.json` (`--update`): `main-0`, `main-sound`, `main-scrolled`, `main-online-row`, `dialog-yesno-main`, `dialog-notice-more` changed (the TRAINER CARD row,
and the fixture's active trainer RED is now named under the title), `main-trainer-partner`, `main-no-trainer`, `main-trainer-row` are new. `builder.golden.json`: `new trainer entry`
removed. `pokemonarena_apps_test.mjs` and its fixtures are untouched.

**Known limits.** `pokemonarena_apps_test.mjs --unit` pins exactly three apps (APP-UI's note above): red with `trainer` registered, by the registration, not by the shell. Because the shell
now hands the apps the card, `trainer.golden.json`'s `edit-figure` and `edit-back` (the editor opens on the trainer's own figure) change on a tree with this branch: APP-UI's
`pokemonarena_trainer_test.mjs --update` after the merge. The greeting is decided once, at the first data refresh: a player who moves off the main menu before the store answers is not greeted
on that visit.
