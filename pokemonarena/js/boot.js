// pokemonarena/js/boot.js -- page controller for /pokemonarena/ (the HUB: the game's front door).
//
// Fetches the SoulGold v1.1.1 ROM the site already serves (progress bar, length + SHA-256 gate), draws the menu from it (hub_screen.js),
// runs the menu's state machine (hub_model.js) and carries out what it asks for: open the quick-battle / saved-team battle page, the team
// builder, the Controls panel, the Sound switch. Input is the shared input layer (input.js): keyboard, mouse, touch and controller all
// arrive as the same twelve actions. No third-party code, no CDN. The old single-screen battle page that used to live here is gone.
//
// THE HUB'S APPS (hub_apps.js: online, center, builder). The model delegates their screens to js/<id>_hub.js and the renderer to js/<id>_screen.js; THIS file carries their effects out without
// knowing any of them: an effect with a string `app` is handed to that app's ctl (js/<id>_ctl.js: createCtl(env) -> { effect, enter?, leave?, dispose? }; hub_app_ctls.js lists them), which is loaded the first time one of the
// app's screens is entered or one of its effects appears. A REAL KEYBOARD TYPES INTO A TEXT ENTRY: while the model says wantsText(), a capture listener turns printable keys, Backspace, Enter,
// Escape, Delete, Home, End and the left / right arrows into model.type(...) and keeps them from the input layer (so Z, X, W, A, S, D, M, P and Enter are letters, not buttons), and a paste
// delivers its text. pokemonarena/INAPP.md "The app interface" is the contract.
// THE BROWSER'S HISTORY IS THE MODEL'S TRAIL (hub_model.js): one entry per screen above the main menu, each recording its trail, so B, the browser's Back button, a reload and a deep link
// agree (syncHistory / popstate / seedHistory below). NOTHING AN APP THROWS STOPS THE PAGE: its model is guarded (hub_apps.js; reportFaults says what happened), its renderer too
// (hub_screen.js), its ctl's failures are said in the picture, and the frame loop asks for the next frame before it does anything else.
//
// Import-safe in Node: nothing touches `document` unless it exists (tools/pokemonarena_page_test.mjs imports computeScale).
//
// Test hook: window.__arenaHub = { state: 'boot' | 'ready' | 'error', kind, error, model, press(), pointer(), type(), dialog, apps, ... } (see makeHook).

import { loadVerifiedRom, romUrl, RomLoadError } from './romfetch.js';
import { loadPack } from './tables.js';
import { createBattleUi } from './battle_ui.js';
import { createHubModel, SCREEN_W, SCREEN_H, PATHS, historySeedPlan, historyPlan, entryTrail } from './hub_model.js';          // (historySeedPlan / historyPlan / entryTrail: how the browser's history is kept equal to the model's trail, for ANY hub path: the Tower's and every app's)
import { createHubScreen } from './hub_screen.js';
import { APP_CTLS } from './hub_app_ctls.js';          // how each hub app's ctl is loaded (a function per app that imports the file when called: nothing is loaded here)
import { readHubData, teamCodeFor, battleHref, pickMascot } from './hub_data.js';
import { openStore } from './store.js';
import * as cries from './cries.js';
import { createControlsDialog } from './controls_dialog.js';
import { describeRomError, showRomError } from './rom_error.js';
import { watchHints } from './hints.js';
import { fitScale, fitPicture, createFullscreen, stackBelow } from './screenfit.js';
import { launchFloorBattle } from './tower_launch.js';          // the one place the Tower names a page (the fight is still its own page; tomorrow this mounts it here)
import { createStartGuard, speakTower } from './tower_hub.js';          // the Tower screens' pure helpers: the one-start-at-a-time guard for START, the screen-reader words

export const GBA_FPS = 59.7275;                 // the hardware frame rate; the menu's idle-animation clock, not a speed-up knob
const STEP_MS = 1000 / GBA_FPS;
export const SETTINGS_KEY = 'arena.hub';
export const SCREEN_TITLES = Object.freeze({ main: 'Pokemon Arena', quick: 'Pokemon Arena - Quick Battle', team: 'Pokemon Arena - My Team', record: 'Pokemon Arena - Record', about: 'Pokemon Arena - About', tower: 'Pokemon Arena - Tower', 'tower-new': 'Pokemon Arena - Tower New Run', 'tower-offer': 'Pokemon Arena - Tower Offer', 'tower-buffs': 'Pokemon Arena - Tower Buffs', 'tower-ach': 'Pokemon Arena - Tower Achievements', 'tower-last': 'Pokemon Arena - Tower Last Run' });

/* ------------------------------------------------------------------------------------------ pure helpers */

// How big the picture is drawn: the whole room it is given, snapped to a whole device-pixel scale only when that costs under 6 % (screenfit.js has the rule and why).
export { fitScale as computeScale };

/** '#quick' -> 'quick'; anything that is not one of the hub's screens -> 'main'. */
export function pathFromHash(hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  return PATHS.includes(h) ? h : 'main';
}

/** The remembered menu settings (a per-viewer convenience): never throws, never trusts the stored value. */
export function readSettings(storage) {
  const out = { quick: {}, selection: {} };
  try {
    const raw = storage && storage.getItem(SETTINGS_KEY);
    if (!raw || raw.length > 2000) return out;
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      if (j.quick && typeof j.quick === 'object') out.quick = { format: j.quick.format, cpu: j.quick.cpu };
      if (j.team && typeof j.team === 'object') out.selection = { profileId: typeof j.team.profileId === 'string' ? j.team.profileId.slice(0, 64) : null, teamId: typeof j.team.teamId === 'string' ? j.team.teamId.slice(0, 64) : null, cpu: j.team.cpu };
    }
  } catch (_e) { /* a corrupt value is ignored */ }
  return out;
}
export function writeSettings(storage, quick, team) {
  try { if (!storage) return false; storage.setItem(SETTINGS_KEY, JSON.stringify({ quick, team })); return true; } catch (_e) { return false; }
}

/* ------------------------------------------------------------------------------------------------ the page */

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

async function main() {
  // THE ROM STARTS COMING NOW, in parallel with the modules below (it used to wait for them: ~35 ms on a repeat visit, 100+ ms on a first one). A copy this browser already verified is read
  // back from its own cache (romcache.js) instead of downloaded; `deferVerify` lets the first frame go up before the SHA-256 re-check, which runs right after it (see start()).
  const early = { got: 0, total: 0, onProgress: null };
  const earlyLoad = loadVerifiedRom({ deferVerify: true, onProgress: (got, total) => { early.got = got; early.total = total; if (early.onProgress) early.onProgress(got, total); } });
  earlyLoad.catch(() => { /* load() awaits it and shows the error screen */ });
  const [inputMod, nav, soundMod] = await Promise.all([import('./input.js').catch(() => ({})), import('./uinav.js').catch(() => ({})), import('./sound_system.js').catch((e) => { console.warn('[sound] sound_system.js did not load; the old switch is used:', e); return {}; })]);
  const { createInput } = inputMod;
  const $ = (id) => document.getElementById(id);
  const canvas = $('hub'), ctx = canvas.getContext('2d', { alpha: false });
  const els = { boot: $('boot'), bar: $('bar'), bootText: $('bootText'), err: $('error'), errTitle: $('errTitle'), errMsg: $('errMsg'), errDetail: $('errDetail'), retry: $('retry'), note: $('note'), status: $('romStatus'), top: $('top'), padA: $('dpad'), padB: $('ab'), sound: $('soundBtn'), controls: $('controlsBtn'), live: $('live'), dialog: $('controlsDialog'), host: $('controlsHost'), close: $('controlsClose'), keys: $('keys') };
  const hook = window.__arenaHub = { state: 'boot', kind: null, error: null, effects: [], store: 'pending' };
  const mbs = (n) => (n / 1048576).toFixed(1);
  const input = typeof createInput === 'function' ? createInput() : null;
  let hist = [], flying = 0;                     // hist: the TRAIL of the history entry the browser stands on (hub_model.js: the screens above the main menu, one entry each); flying: when a step back of ours (history.go) was asked for and has not landed yet (0: none)
  const held = new Set();                        // the actions whose press the hub took and that are still down: what an app's tick(path, held) is told
  let model = null, screen = null, ui = null, pack = null, romBytes = null, store = null, touchPad = false, dialogOpen = false, errNav = null;
  const storage = (() => { try { return window.localStorage; } catch (_e) { return null; } })();
  const session = (() => { try { return window.sessionStorage; } catch (_e) { return null; } })();
  // WHO holds the "a DOM panel is up" state (the hub ignores its own keys and pointer while it is true): the Sound panel, the Controls dialog and the audio bar's music list can be up TOGETHER,
  // so it is a SET of owners, not one boolean: closing one never un-pauses the page behind another that is still open. (The OPEN TO BATTLES questions are not among them any more: they are
  // asked in the picture, by the dialog layer. The presence service is told when a panel opens or closes, because a question must not be drawn under a panel: hub_presence.js panels().)
  const dlgOwners = new Set();
  const setDialog = (who, v) => { if (v) dlgOwners.add(who); else dlgOwners.delete(who); dialogOpen = dlgOwners.size > 0; if (dialogOpen) held.clear(); if (hook.presence) hook.presence.panels(); };          // (a button held as a DOM dialog opens is not held in the picture behind it)

  /* ---- the loading panel's reveal ---- */
  // THE LOADING PANEL ONLY APPEARS IF LOADING TAKES A MOMENT, so a repeat visit (up in ~110 ms) never flashes it. The FIRST reveal, 400 ms after the page started, is not made here: it is a stylesheet
  // keyframe (arena.css: pure CSS, works with no script) and a tiny inline timer in index.html (data-slow on <body>, plus the #live message) that runs before this module graph has loaded. The timer is
  // there because `prefers-reduced-motion: reduce` switches every CSS animation off with !important, which left those visitors an EMPTY page for the whole first download. What is left for this file:
  // a load() after the page's first 400 ms (Try again) shows the panel AT ONCE (the inline timer has long since run, and found the page in the error state); and the #live message is taken back when the
  // panel goes. Until the panel is revealed it is visibility:hidden, i.e. not in the accessibility tree, and a live region that appears already full is not reliably announced; so as it appears the
  // persistent #live region (there all along) says what is going on.
  const REVEAL_MS = 400, REVEAL_SAYS = 'Loading the game file. This can take a moment.';       // the same text is in index.html's inline timer
  function armReveal() {
    if (performance.now() < REVEAL_MS) return;
    document.body.dataset.slow = '1';
    if (els.live && els.live.textContent !== REVEAL_SAYS) els.live.textContent = REVEAL_SAYS;
  }
  function disarmReveal() { if (els.live && els.live.textContent === REVEAL_SAYS) els.live.textContent = ''; }

  /* ---- errors ---- */
  function showError({ title, message, detail, kind, retry, tech }) {
    disarmReveal();
    hook.state = 'error'; hook.kind = kind || 'internal'; hook.error = message;
    canvas.hidden = true;
    showRomError(els, { kind: kind || 'internal', title, message, detail, retry, tech: tech || '' });          // W1 D7: the one shared error experience (rom_error.js)
    document.body.dataset.state = 'error';
    // W1 fix A2: the error screen is operable by a controller too (d-pad to Try again / Back to the site, A to press, B leaves), as on the battle page
    if (input && nav && typeof nav.enableDomNav === 'function') {
      if (!errNav) { try { errNav = nav.enableDomNav(els.err, { input, onBack: () => { location.href = '/'; } }); } catch (_e) { errNav = null; } }
      else { try { errNav.refresh(); } catch (_e) { /* ignore */ } }
      if (errNav) { try { errNav.focusFirst(); } catch (_e) { /* ignore */ } }
    }
    fit();
  }
  const romError = (e) => describeRomError(e);

  /* ---- scaling ---- */
  const coarse = () => !!window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches);
  // The picture takes the room it is given (screenfit.js fitPicture): a phone held upright runs it edge to edge, fullscreen gives it the whole viewport.
  // The old rule here was a whole scale only (floor), which left a 390 px phone a 324 px picture and a 360 px phone a 244 px one.
  function fit() {
    hook.scale = fitPicture({ doc: document, win: window, canvas, top: els.top, padA: els.padA, padB: els.padB, touchPad, hint: document.body.dataset.state === 'ready' ? (touchPad ? 44 : stackBelow(window, [els.status, els.keys])) : 0 });
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  // the Fullscreen switch: the header button, and the floating one that stands in for it while the header is hidden (a phone held sideways, fullscreen)
  const fs = hook.fullscreen = createFullscreen({ doc: document, win: window, buttons: [$('fullBtn'), $('fullExit')], onChange: () => { fit(); }, storage: (() => { try { return window.sessionStorage; } catch (_e) { return null; } })() });
  document.addEventListener('fullscreenchange', () => setTimeout(fit, 120)); document.addEventListener('webkitfullscreenchange', () => setTimeout(fit, 120));       // the viewport settles a moment after the event (iOS reports the old size first)

  /* ---- sound: muted by default; an AudioContext exists only after a user gesture AND with sound switched on ---- */
  // MU3: the mixer, the SOUND panel and the music live in sound_system.js (ON by default, audio starts at the first click / tap / key). The old switch below only runs if that file did not load.
  const soundSys = (() => { try { return typeof soundMod.createSoundSystem === 'function' ? soundMod.createSoundSystem({
    page: 'hub', button: els.sound, input: () => input, enableDomNav: nav.enableDomNav, ownNav: true,
    onPanelOpen: () => { setDialog('sound', true); },
    onPanelClose: () => { setDialog('sound', false); if (model) { model.setSound(soundSys.audible()); dirty = true; } setTimeout(() => { if (!dialogOpen) focusCanvas(); }, 0); },
    onMenuOpen: () => { setDialog('musicmenu', true); },           // the audio bar's music list is a dialog: the menu behind it takes no key or pad press while it is open (no focusCanvas on close: Esc gives the focus to the music button)
    onMenuClose: () => { setDialog('musicmenu', false); },
  }) : null; } catch (e) { console.warn('[sound] the sound system could not start; the old switch is used:', e); return null; } })();
  // what the picture's own screens and the hub's apps ask of the sound: always there and never throwing, whether or not the sound system loaded
  const sound = Object.freeze({
    /** Play one ROM sound effect by its music_map.js key ('se_select', 'se_success', 'se_menu_open' ...). -> true when it was handed to the sound system (it is silent while the sound is muted or not started). */
    sfx(key) { try { return !!(soundSys && typeof soundSys.sfx === 'function' && soundSys.sfx(key)); } catch (_e) { return false; } },
    /** Say which SCREEN the hub is showing, for its music ('hub', 'pokecenter', 'town' ...: a music key of music_map.js). The player's own pick in the audio bar still wins. -> true when it was taken. */
    music(screenKey) { try { if (!soundSys || typeof screenKey !== 'string') return false; soundSys.menuMusic.set(screenKey); return true; } catch (_e) { return false; } },
    /** The sound system itself (sound_system.js: mixer, director, menuMusic, state()), or null when it did not load. */
    system: () => soundSys,
  });
  const snd = { ctx: null, cry: new Map(), plays: 0 };
  function updateSoundButton() { if (soundSys) return; const on = cries.isSoundOn(storage || undefined); els.sound.textContent = 'Sound: ' + (on ? 'on' : 'off'); els.sound.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function ensureAudio() {
    if (soundSys || !cries.isSoundOn()) return null;
    if (!snd.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { snd.ctx = new C(); } catch (_e) { return null; } }
    if (snd.ctx.state === 'suspended') { try { const p = snd.ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_e) { /* ignore */ } }
    return snd.ctx;
  }
  async function playMascotCry() {
    if (soundSys || !cries.isSoundOn() || !pack || !romBytes || !model) return;
    const ac = ensureAudio(); if (!ac) return;
    try { if (ac.state !== 'running' && typeof ac.resume === 'function') await ac.resume(); } catch (_e) { /* ignore */ }
    if (ac.state !== 'running') return;
    const species = model.view().mascot.species;
    try {
      let c = snd.cry.get(species);
      if (c === undefined) { c = cries.cryForSpecies(pack, romBytes, species); snd.cry.set(species, c); }
      if (c && cries.playCry(ac, c, { mode: 'normal', gain: 0.35 })) snd.plays++;
    } catch (_e) { /* a cry that cannot be decoded is simply silent */ }
  }
  function setSound(on) {
    if (soundSys) { soundSys.openPanel(); if (model) model.setSound(soundSys.audible()); dirty = true; return; }       // MU3: the SOUND row opens the panel; its ON / OFF follows the mute switch
    cries.setSoundOn(!!on);
    updateSoundButton();
    if (model) model.setSound(cries.isSoundOn());
    if (on) playMascotCry(); else if (snd.ctx && snd.ctx.state === 'running') { try { snd.ctx.suspend(); } catch (_e) { /* ignore */ } }
    dirty = true;
  }
  els.sound.addEventListener('click', (e) => { if (soundSys) return; setSound(!cries.isSoundOn()); if (e.detail > 0) focusCanvas(); });
  const firstGesture = () => { if (cries.isSoundOn()) ensureAudio(); window.removeEventListener('pointerdown', firstGesture, true); window.removeEventListener('keydown', firstGesture, true); };
  window.addEventListener('pointerdown', firstGesture, true); window.addEventListener('keydown', firstGesture, true);
  updateSoundButton();
  const focusCanvas = () => { try { if (!canvas.hidden) canvas.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } };

  /* ---- the Controls panel: the shared dialog (controls_dialog.js), the same one the battle page and the team editor open ---- */
  const ctlDlg = input ? createControlsDialog({
    input, enableDomNav: nav.enableDomNav, el: els.dialog,
    onOpen: () => { setDialog('controls', true); },
    onClose: () => { setDialog('controls', false); setTimeout(() => { if (!dialogOpen) focusCanvas(); }, 0); },   // the key that closed the dialog must not also act on the menu behind it
  }) : null;
  async function openControls() {
    if (dialogOpen || !ctlDlg) return;
    const ok = await ctlDlg.open();
    if (!ok && model) { model.notify(['The Controls panel could not open.', 'Reload the page and try again.']); dirty = true; }
  }
  function closeControls() { if (ctlDlg) ctlDlg.close(); }
  els.controls.addEventListener('click', (e) => { openControls(); if (e.detail > 0 && !dialogOpen) focusCanvas(); });

  /* ---- navigation ---- */
  const navigate = (url) => { hook.navigated = url; if (typeof window.__arenaNavigate === 'function') window.__arenaNavigate(url); else location.assign(url); };
  const freshSeed = () => { const a = new Uint32Array(1); if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a); else a[0] = (Date.now() ^ 0x5bd1e995) >>> 0; return a[0] >>> 0; };
  const hashFor = (path) => (path === 'main' ? location.pathname + location.search : location.pathname + location.search + '#' + path);

  function saveSettings() { if (model) writeSettings(storage, model.quickSettings(), model.teamSettings()); }

  async function startBattle(eff) {
    saveSettings();
    const seed = freshSeed();
    try {
      if (eff.mode === 'quick') { navigate(battleHref({ mode: 'quick', format: eff.format, cpu: eff.cpu, seed })); return; }
      if (!store) { model.notify(['Your teams are not available right now.', 'Try again in a moment.']); dirty = true; return; }
      const r = await teamCodeFor(store, eff.profileId, eff.teamId);
      if (!r.ok) { model.notify(['That team cannot be started:', String(r.message).slice(0, 40)]); dirty = true; return; }
      try { await store.setActiveId(eff.profileId); } catch (_e) { /* the battle does not need it */ }
      navigate(battleHref({ mode: 'team', code: r.code, format: eff.format, cpu: eff.cpu, seed }));
    } catch (e) { model.notify(['The battle could not be started.', String(e && e.message ? e.message : e).slice(0, 40)]); dirty = true; }
  }

  function run(effects) {
    for (const eff of effects || []) {
      hook.effects.push(eff.type);
      if (hook.effects.length > 4000) hook.effects.splice(0, 2000);          // (a log for the tests: an app that asks for something every frame must not grow it for ever)
      if (typeof eff.app === 'string') { appEffect(eff); continue; }          // an app's effect (a dialog's answer for an app included) goes to that app's ctl, whatever its type
      if (eff.type === 'screen') {
        // the browser's history is made equal to the model's TRAIL: a screen opened adds an entry, a step back steps back through the entries, a replace overwrites one (so B and the browser's
        // Back button agree and the history does not grow). The effect only says THAT the screen changed; where the model now stands (model.trail()) decides what is written, so a list
        // holding a step back and a go is ONE history change
        syncHistory();
        syncTitle();
        syncFamily();          // (before the effects that follow in this list: an app's ctl hears enter(path) first)
      }
      else if (eff.type === 'sfx') sound.sfx(eff.key);          // the screen named its own sound for this input (the default menu sound is then not played: sound_system.js menuSfx); key null = none
      else if (eff.type === 'navigate') { saveSettings(); navigate(eff.url); }
      else if (eff.type === 'sound') setSound(eff.on);
      else if (eff.type === 'controls') openControls();
      else if (eff.type === 'battle') startBattle(eff);
      else if (eff.type === 'record-reset') resetRecord(eff.profileId);
      else if (eff.type === 'tower-new' || eff.type === 'tower-fight' || eff.type === 'tower-pick' || eff.type === 'tower-giveup') towerEffect(eff);
      else if (eff.type === 'dialog' && hook.presence) hook.presence.answer(eff);          // a question that no app asked: OPEN TO BATTLES' own two (hub_presence.js: "<name> wants to battle you", the first-time disclosure)
    }
    if (model) syncFamily();
    dirty = true;
  }
  function syncTitle() { document.title = model.title(model.path()) || SCREEN_TITLES[model.path()] || SCREEN_TITLES.main; }

  /* ---- the browser's history mirrors the model's TRAIL (hub_model.js): one entry per screen above the main menu, each carrying { arenaHub: path, trail } in its state ---- */
  // `hist` is the trail of the entry the browser stands on. It is READ off the entry whenever the browser lands somewhere (popstate, boot) and set here only for an entry this page has just
  // written, so every decision starts from where the browser really is, never from a count. A step back (history.go) lands LATER, as a popstate: until it has (`flying`) nothing else is
  // written -- a pushState issued meanwhile would be made on the entry being left -- and the landing reconciles again (what was still to write, or a move the model made in the meantime).
  const stateFor = (trail) => ({ arenaHub: trail.length ? trail[trail.length - 1] : 'main', trail: trail.slice() });
  const FLY_MS = 2000;                           // a step back that has not landed after this long never will (a sandboxed frame): the next change starts over from `hist`
  function syncHistory() {
    if (!model) return;
    if (flying && performance.now() - flying < FLY_MS) return;
    flying = 0;
    const plan = historyPlan(hist, model.trail());
    try {
      if (plan.back > 0) { flying = performance.now(); history.go(-plan.back); return; }
      for (const w of plan.write) {
        const to = w.trail[w.trail.length - 1];
        if (w.how === 'replace') history.replaceState(stateFor(w.trail), '', hashFor(to)); else history.pushState(stateFor(w.trail), '', hashFor(to));
        hist = w.trail.slice();
      }
    } catch (_e) { flying = 0; /* a sandboxed frame */ }
  }
  window.addEventListener('popstate', (e) => {
    if (!model) return;
    const path = pathFromHash(location.hash), ours = flying !== 0;
    hist = entryTrail(e.state, path); flying = 0;
    if (ours) syncHistory();                     // our own step back has landed: whatever is still to do from here (the entries to write after it, a move the model made meanwhile) is done now
    else run(model.arrive(path, hist));          // the browser's Back / Forward (or a typed address): the model follows the entry, with the trail it recorded
    syncTitle(); syncFamily(); dirty = true;
  });
  // The page was OPENED at a screen other than the menu (the way back from a Tower fight lands on #tower-offer or #tower-last, and a link may name any screen). Its history then holds only that one entry, so B
  // (a step back) would leave the hub for the page that was just left. Give it the entries the screen would have had if it had been walked to from the menu: the menu's own, then each screen on the way.
  // ONLY on a fresh arrival (historySeedPlan): a reload, or a back / forward step onto an entry this page wrote, already stands on its trail (its history.state carries it), so nothing is added and the Forward entry is kept.
  function seedHistory(path) {
    let state = null; try { state = history.state; } catch (_e) { state = null; }
    const plan = historySeedPlan(path, state);
    if (!plan.write) { hist = plan.trail.slice(); return; }          // (the entries the page stands on, either way)
    try {
      history.replaceState(stateFor([]), '', hashFor('main'));
      for (let i = 0; i < plan.trail.length; i++) history.pushState(stateFor(plan.trail.slice(0, i + 1)), '', hashFor(plan.trail[i]));
      hist = plan.trail.slice();
    } catch (_e) { /* a sandboxed frame: the model still walks its trail; only the browser's Back button does not follow */ }
  }

  /* ---- the hub's APPS: <id>_hub.js is the pure model the hub delegates to (hub_apps.js); <id>_ctl.js carries its effects out and is loaded the first time it is needed ---- */
  const ctls = new Map();                        // app id -> { promise, ctl, error, chain }
  let storeIsOpen = null; const storeOpened = new Promise((res) => { storeIsOpen = res; });          // resolves with the profile store (or null when it could not be opened): a ctl that starts before the store has may wait for it
  hook.appEffects = [];
  // a note in the picture (the dialog layer), one at a time per app: an id that is already open or queued is refused, so a failing ctl cannot stack them
  const appNote = (id, a, b) => { if (model) { model.dialog.open({ id: 'app:' + id, pages: [[String(a).slice(0, 34), String(b || '').slice(0, 34)]], choice: null }); dirty = true; } };
  const appName = (id) => String(model.title(model.app(id).paths[0]) || id).replace(/^Pokemon Arena - /, '');
  // what an app's ctl is given (INAPP.md "The app interface"): the page's services, the hub model and the app's own model
  const ctlEnv = (id) => ({
    win: window, doc: document, hook, model, app: model.app(id), store: () => store, whenStore: () => storeOpened, pack, rom: romBytes, ui, navigate, input, storage, session,
    refreshData, redraw: () => { dirty = true; draw(true); }, run, freshSeed, sound,
  });
  function loadCtl(id) {
    let c = ctls.get(id);
    if (c) return c;
    c = { ctl: null, error: null, problem: null, chain: Promise.resolve(), promise: null };
    ctls.set(id, c);
    const load = Object.prototype.hasOwnProperty.call(APP_CTLS, id) ? APP_CTLS[id] : null;
    c.promise = (load ? load() : Promise.reject(new Error('no ctl is listed for ' + id + ' in hub_app_ctls.js'))).then((m) => {
      if (typeof m.createCtl !== 'function') throw new Error(id + '_ctl.js does not export createCtl');
      c.ctl = m.createCtl(ctlEnv(id)) || {};
      return c.ctl;
    }).catch((e) => {
      c.error = String(e && e.message ? e.message : e);
      console.warn('[apps] ' + id + '_ctl.js is not available', e);
      appNote(id, appName(id) + ' could not load.', 'Reload the page and try again.');
      return null;
    });
    return c;
  }
  // one queue per app, so its ctl hears enter(path), its effects and leave(path) in the order the hub produced them, even while the file is still loading. Each call is STARTED in that order and
  // not waited for: a ctl whose effect() returns a promise may get the next effect while it is pending (a ctl that asks a question and waits for the answer would otherwise wait for ever)
  function toCtl(id, what, arg) {
    if (!model.app(id)) return Promise.resolve();
    const c = loadCtl(id);
    const failed = (e) => { const msg = String(e && e.message ? e.message : e); console.warn('[apps] ' + id + ' ' + what + ' failed', e); if (c.problem !== msg) { c.problem = msg; appNote(id, appName(id) + ' hit a problem:', msg); } };          // (the same fault is said once, not once per effect)
    c.chain = c.chain.then(() => c.promise).then((ctl) => {
      if (!ctl) { if (what === 'enter') appNote(id, appName(id) + ' could not load.', 'Reload the page and try again.'); return; }          // (said again each time its screen is opened, never once per effect)
      if (typeof ctl[what] !== 'function') return;
      const r = ctl[what](arg);
      if (r && typeof r.then === 'function') r.then(null, failed);
    }).catch(failed);
    return c.chain;
  }
  function appEffect(eff) { hook.appEffects.push({ app: eff.app, type: eff.type }); if (hook.appEffects.length > 200) hook.appEffects.shift(); return toCtl(eff.app, 'effect', eff); }
  // which app's family of screens is open: its ctl hears enter(path) when the hub's path moves into the family and leave(path) when it moves out (not for a move inside it)
  let family = null, familyPath = null;
  function syncFamily() {
    const p = model.path(), a = model.appOf(p), now = a ? a.id : null;
    if (now === family) { familyPath = p; return; }
    if (family) toCtl(family, 'leave', familyPath);
    family = now; familyPath = p;
    if (now) toCtl(now, 'enter', p);
  }
  function disposeCtls() { for (const c of ctls.values()) { if (c.ctl && typeof c.ctl.dispose === 'function') { try { c.ctl.dispose(); } catch (_e) { /* the page is going */ } } } }

  /* ---- a REAL KEYBOARD types into a text entry (textentry.js): while the open app says wantsText(), its keys are text, not buttons ---- */
  const isTextTarget = typeof inputMod.isTextTarget === 'function' ? inputMod.isTextTarget : () => false;
  const nativeUse = typeof inputMod.nativeUse === 'function' ? inputMod.nativeUse : () => 'none';
  const TEXT_KEYS = Object.freeze({ Backspace: 'backspace', Enter: 'enter', Escape: 'escape', Delete: 'delete', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end' });
  const typingNow = () => !!model && hook.state === 'ready' && !dialogOpen && model.wantsText();          // never while a DOM dialog (Controls, Sound, the music list) is open
  const keyTarget = (e) => { try { const p = typeof e.composedPath === 'function' ? e.composedPath() : null; if (p && p.length) return p[0]; } catch (_e) { /* ignore */ } return e.target; };
  const heldAsText = new Set();                                            // the keys whose press was taken as text (their auto-repeat is text too; the repeat of a key that was a BUTTON press -- the Z that opened the entry -- is not)
  window.addEventListener('keyup', (e) => { heldAsText.delete(e.code || e.key); }, true);
  function typeText(input) { hook.typed = (hook.typed | 0) + 1; run(model.type(input)); }
  // A QUESTION OVER A TEXT ENTRY (a hub dialog opened while the player was typing: "<name> wants to battle you"). The entry is covered, so nothing is typed; but the word being typed must not
  // ANSWER the question either: a printable key (and a dead key) is dropped here, before the input layer can read Z as A or X as B. Enter, Escape, Backspace and the arrows are left to the
  // input layer and drive the dialog as on any other screen (the dialog's own arm delay covers an Enter that was already on its way).
  const coveredNow = () => !!model && hook.state === 'ready' && !dialogOpen && model.textUnder();
  function dropCovered(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    const t = keyTarget(e), key = e.key;
    if (!((typeof key === 'string' && key.length === 1) || key === 'Dead') || isTextTarget(t) || nativeUse(t, key, e.code) !== 'none') return;
    e.preventDefault(); e.stopPropagation(); hook.dropped = (hook.dropped | 0) + 1;
  }
  window.addEventListener('keydown', (e) => {
    if (coveredNow()) { dropCovered(e); return; }
    if (!typingNow() || e.defaultPrevented) return;
    if (e.repeat && !heldAsText.has(e.code || e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;                       // browser shortcuts (Ctrl+V arrives as a paste event, below), AltGr: left alone
    if (e.isComposing || e.keyCode === 229) return;                        // an IME is composing
    const t = keyTarget(e), key = e.key;
    if (isTextTarget(t)) return;                                           // a real text field of the page keeps its own keys
    let input = null;
    if (Object.prototype.hasOwnProperty.call(TEXT_KEYS, key)) input = { key: TEXT_KEYS[key] };
    else if (typeof key === 'string' && key.length === 1) input = { text: key };
    else if (key === 'Dead') { e.preventDefault(); e.stopPropagation(); return; }          // a dead key (an accent waiting for its letter) is not a letter yet and never a button
    else return;                                                           // Tab, the function keys, the up / down arrows (those two still move the key cursor) ...
    if (nativeUse(t, key, e.code) !== 'none') return;                      // Enter or Space on a focused page button presses that button
    e.preventDefault(); e.stopPropagation();                               // ... and nothing else sees the key: not the input layer (no game button), not the M-mutes shortcut
    heldAsText.add(e.code || e.key);
    typeText(input);
  }, true);
  window.addEventListener('paste', (e) => {
    if (!typingNow() || isTextTarget(keyTarget(e))) return;
    let text = ''; try { text = (e.clipboardData || window.clipboardData).getData('text') || ''; } catch (_e) { text = ''; }
    e.preventDefault();
    if (text) typeText({ text });
  }, true);

  /* ---- the team list: read from the browser-local store (profiles are never uploaded) ---- */
  // ST1: RESET RECORD was answered YES: the profile's battle record is emptied in the store (an automatic backup and a history entry are taken there), then the list is read again
  async function resetRecord(profileId) {
    if (!store) { model.notify(['The record cannot be reset right now.', 'Storage is not available.']); dirty = true; return; }
    try {
      await store.resetRecord(profileId); hook.recordReset = (hook.recordReset | 0) + 1;
      if (hook.presence) hook.presence.refresh().catch(() => { /* the listing catches up at its next refresh */ });          // OPEN TO BATTLES lists the online record: the record just emptied must leave the board now, not when the tab is next shown
      await refreshData();
    } catch (e) { model.notify(['The record could not be reset:', String(e && e.message ? e.message : e).slice(0, 40)]); dirty = true; }
  }
  /* ---- the Tower: tower_hub.js asks (an effect), tower_session.js does it against the profile store, tower_launch.js is the only code that names a page ---- */
  let towerMod = null, towerLoading = null;
  function loadTower() {
    if (!towerLoading) towerLoading = import('./tower_session.js').then((m) => { towerMod = m; hook.towerLoaded = true; return m; }).catch((e) => { console.warn('[tower] not available', e); hook.towerError = String(e && e.message ? e.message : e); return null; });
    return towerLoading;
  }
  const towerNote = (a, b) => { if (model) { model.tower.notify([a, b || '']); dirty = true; } };
  const startGuard = createStartGuard();
  async function towerEffect(eff) {
    if (eff.type === 'tower-new' && !startGuard.enter(eff.token)) { hook.towerIgnored = (hook.towerIgnored | 0) + 1; return; }          // a double tap on START is ONE start (not a run that is made and at once given up, nor two profiles)
    hook.towerEffects = (hook.towerEffects || []).concat([eff.type]);
    let started = false;
    try {
      const m = await loadTower();
      if (!m) { towerNote('The Tower could not load.', 'Reload the page and try again.'); return; }
      if (!store) { towerNote('Your profile is not available.', 'Try again in a moment.'); return; }
      if (store.status.notSaved) { towerNote('This browser is not keeping profiles,', 'so a Tower run cannot be saved.'); return; }
      if (eff.type === 'tower-new') started = await towerStart(m, eff);
      else {
        const session = m.createTowerSession({ pack, persist: m.storePersist(store, eff.profileId) });
        if (eff.type === 'tower-fight') {
          const tw = await session.read(), run = tw.current;
          if (!run || run.phase !== 'battle') { towerNote('There is no fight waiting.', ''); await refreshData(); return; }
          saveSettings();
          launchFloorBattle(run, { navigate, profileId: eff.profileId });
        } else if (eff.type === 'tower-pick') {
          const r = await session.pick({ seed: eff.seed, id: eff.id, floor: eff.floor, offer: eff.offer });
          hook.towerLast = r;
          if (r && r.applied) towerNote(eff.id ? 'You took ' + m.buffName(eff.id) + '!' : 'You took nothing.', 'Floor ' + r.next.floor + ' is next.'); else towerNote('That could not be applied:', String(r && r.why || 'unknown').slice(0, 30));
          await refreshData();
        } else if (eff.type === 'tower-giveup') {
          const r = await session.giveUp(eff.seed === null || eff.seed === undefined ? {} : { seed: eff.seed });
          hook.towerLast = r;
          await refreshData();
        }
      }
    } catch (e) { towerNote('The Tower hit a problem:', String(e && e.message ? e.message : e).slice(0, 30)); }
    finally { if (eff.type === 'tower-new') startGuard.done(eff.token, started); }          // a start that did not happen can be asked for again; one that did keeps the page locked (it is leaving for the floor)
  }
  async function towerStart(m, eff) {
    let pid = eff.profileId;
    if (!pid) { const created = await store.createProfile({}); pid = created.id; try { await store.setActiveId(pid); } catch (_e) { /* the Tower does not need it */ } }
    let team = null;
    if (eff.teamId) {
      const l = await store.loadProfile(pid);
      if (!l.ok) { towerNote('That profile could not be read.', ''); return false; }
      try { team = m.teamSnapshot(l.profile, eff.teamId); } catch (_e) { towerNote('That team could not be used.', ''); return false; }
    }
    const session = m.createTowerSession({ pack, persist: m.storePersist(store, pid) });
    // (replace: false -- the NEW RUN row has already asked to give a run up first, and a run that another tab started meanwhile is not silently thrown away by this one)
    const r = await session.startRun({ seed: freshSeed(), format: eff.format, team, replace: false });
    hook.towerLast = r;
    if (!r || !r.applied) { towerNote('The run could not start:', String(r && r.why || 'unknown').slice(0, 30)); await refreshData(); return false; }
    try { await store.setActiveId(pid); } catch (_e) { /* the battle page falls back to the profile in its address */ }
    saveSettings();
    launchFloorBattle(r.run, { navigate, profileId: pid });
    return true;
  }

  async function refreshData() {
    if (!store || !pack || !model) return;
    const d = await readHubData(store, pack, { tzMinutes: new Date().getTimezoneOffset(), towerSummary: towerMod ? towerMod.summarizeTower : undefined });
    run(model.setData(d));
    hook.data = d;
    const unsaved = d.notSaved;
    els.note.hidden = !unsaved; els.note.textContent = unsaved ? 'This browser is not keeping profiles (storage is blocked or in private mode), so teams you build here will be lost when you close the page.' : '';
    dirty = true;
  }
  async function openProfiles() {
    try { store = await openStore(); hook.store = store.status && store.status.notSaved ? 'memory' : 'indexeddb'; try { store.on('external', () => refreshData()); store.on('status', () => refreshData()); } catch (_e) { /* optional */ } }
    catch (e) { store = null; hook.store = 'unavailable'; storeIsOpen(null); run(model.setData({ state: 'unavailable', profiles: [], note: 'Storage could not be opened.' })); dirty = true; return; }
    storeIsOpen(store);
    await refreshData();
  }

  /* ---- drawing ---- */
  const img = new ImageData(SCREEN_W, SCREEN_H);
  let dirty = true, lastSig = '', renders = 0, lastSpoken = '';
  const drawFaults = new Set();                  // the messages of the screens that could not be drawn, each said in the console once (hook.renderError is the last one)
  function sigOf(v) { return JSON.stringify({ ...v, tick: (v.tick >> 5) & 1 }); }
  function draw(force) {
    const v = model.view();
    const sig = sigOf(v);
    if (!force && sig === lastSig) { dirty = false; return; }
    lastSig = sig;
    // (a renderer that throws -- an app's, on a view it did not expect -- must not stop the page's clock. hub_screen.js catches an APP's renderer itself and draws the shell's note in its place
    //  (f.fault says what happened); anything else that throws here leaves the last frame up. Either way the fault is on the hook and in the console, once per message)
    const drawFault = (msg, e) => { hook.renderError = msg; if (!drawFaults.has(msg) && drawFaults.size < 32) { drawFaults.add(msg); console.error('[hub] the screen could not be drawn', e); } };
    let f; try { f = screen.render(v); } catch (e) { drawFault(String(e && e.message ? e.message : e), e); dirty = false; return; }
    if (f.fault) drawFault(f.fault.message, f.fault.app + ' ' + f.fault.where + ': ' + f.fault.message);
    img.data.set(f.rgba); ctx.putImageData(img, 0, 0); renders++; dirty = false;
    speak(v);
  }
  // what the hub's apps threw since the last frame (hub_model.js faults(): each distinct fault once): said in the console, kept on the hook, and said once in the picture
  function reportFaults() {
    for (const ft of model.faults()) {
      hook.appFaults = (hook.appFaults || []).concat([ft]).slice(-20);
      console.error('[apps] ' + ft.app + ' ' + ft.where + '() threw: ' + ft.message);
      try { appNote(ft.app, appName(ft.app) + ' hit a problem:', ft.message); } catch (_e) { /* the note is a courtesy */ }
    }
  }
  // a plain-text mirror of the canvas for screen readers (the canvas itself has only a static label)
  function speak(v) {
    let s = model.speak(v);          // an app's screen, a text entry or a dialog words itself (null: one of the hub's own screens, worded below)
    if (s !== null) { /* said */ }
    else if (v.tower) s = speakTower(v);
    else if (v.record) s = 'Record' + (v.record.trainer ? ' of ' + v.record.trainer.name : '') + ', page ' + (v.record.index + 1) + ' of ' + v.record.count + ': ' + v.record.page.title + '. ' + v.record.page.lines.map((l) => l.cells.map((c) => c.t).filter(Boolean).join(' ')).join('. ') + (v.record.confirm ? ' Choose YES or NO.' : '');
    else if (v.about) s = 'About, page ' + (v.about.page + 1) + ' of ' + v.about.pages + '. ' + v.about.lines.join(' ');
    else if (v.menu) { const r = v.menu.rows[v.menu.cursor]; s = (v.screen === 'main' ? 'Main menu. ' : v.screen === 'quick' ? 'Quick battle. ' : 'Battle with my team. ') + (r ? r.label + (r.value !== undefined ? ' ' + r.value : '') + '. ' : '') + (v.msg || []).join(' '); }
    else s = '';
    if (s !== lastSpoken) { lastSpoken = s; els.live.textContent = s; }
  }

  /* ---- input ---- */
  function wireInput() {
    if (!input) {
      window.addEventListener('keydown', (e) => { if (dialogOpen || e.ctrlKey || e.metaKey || e.altKey) return; const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', z: 'a', x: 'b', Backspace: 'b', Escape: 'b' }[e.key]; if (m) { e.preventDefault(); run(model.press(m)); } });
      return;
    }
    hook.input = input;
    // W1 fix A4: the on-screen pad appears with the first touch on any touch screen (a fine-pointer touch monitor fails the media query at start)
    // (a mouse that starts moving takes it away again.) The pad is laid out AFTER the gesture that asked for it, never under it (re-fitting at pointer-down moved the picture under the finger).
    let padTimer = null;
    const padTo = (on) => { touchPad = on; clearTimeout(padTimer); padTimer = setTimeout(() => { padTimer = null; fit(); }, 450); };
    input.on('source', (e) => { if (e.source === 'touch' && !touchPad) padTo(true); else if (e.source === 'mouse' && touchPad) padTo(false); });
    if (els.keys) watchHints(input, els.keys, { menu: false, pad: () => touchPad });         // the hint line speaks of the device the player last used
    const toLocal = input.mapClientToLogical(canvas, SCREEN_W, SCREEN_H);
    input.registerPointerTarget(canvas, { toLocal, cursor: { actionable: (x, y) => !!model.hit(x, y) } });
    for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);
    // W1 fix A7: a controller had no way off the hub's main menu (the Home link is a plain page control that the pad never reaches there). B at the main menu now asks; a second B
    // within 4 seconds leaves for the site. (A mouse, a keyboard and a touch screen have the Home link / the browser's Back; they are left as they were.)
    let leaveArmed = -1e9;
    input.on('action', (e) => {
      if (!e.pressed) held.delete(e.action);          // (a release always counts, whatever is open: nothing stays held)
      if (!e.pressed || e.native || dialogOpen) return;
      if (!e.repeat) held.add(e.action);              // HELD: the actions whose press the hub took (the same gate as the press itself) until they are released: an app's tick(path, held)
      if (e.action === 'b' && e.source === 'gamepad' && !e.repeat && model.path() === 'main' && !model.dialog.isOpen()) {
        const t = performance.now();
        if (t - leaveArmed < 4000) { leaveArmed = -1e9; saveSettings(); navigate('/'); return; }
        leaveArmed = t; model.notify(['Press B again to leave', 'the Arena for the site.']); dirty = true; return;
      }
      const info = { repeat: !!e.repeat };            // (the synthesized repeat of a held direction: a dialog ignores it, an app is told)
      if (soundSys) { const before = soundSys.sig(model.state()); const fx = model.press(e.action, info); run(fx); soundSys.menuSfx(e.action, before !== soundSys.sig(model.state()), true, fx); return; }
      run(model.press(e.action, info));
    });
    input.on('pointer', (e) => {
      if (dialogOpen) return;
      if (e.kind === 'wheel') { if (e.el === canvas || e.x === null) run(model.pointer({ kind: 'wheel', steps: e.steps })); return; }
      if (e.el !== canvas || !e.inside) return;
      if (e.kind === 'move' || (e.kind === 'down' && e.source === 'touch')) run(model.pointer({ kind: 'move', x: e.x, y: e.y }));          // (a move may ask for something too: its effects are carried out like a click's)
      else if (e.kind === 'click') { const hitRow = !!(soundSys && model.hit(e.x, e.y)); const fx = model.pointer({ kind: 'click', x: e.x, y: e.y }); if (hitRow) soundSys.menuSfx('a', true, true, fx); run(fx); }
    });
  }
  // the buttons held right now, for the open app's tick(path, held): none while a DOM dialog is open
  const heldNow = () => (dialogOpen || !held.size ? null : [...held]);

  /* ---- the clock: a fixed 59.7275 Hz step regardless of the display rate (it only animates the Pokemon) ---- */
  // NOTHING THAT THROWS IN A FRAME MAY STOP THE CLOCK: the next frame is asked for FIRST, the ticks and the drawing are each inside a try, and a fault is said once (hook.loopError, the console).
  // (An app's model cannot throw into this loop at all: hub_apps.js guards every call and reportFaults says what happened. This is for everything else.)
  function loopFault(where, e) { const msg = where + ': ' + String(e && e.message ? e.message : e); if (hook.loopError !== msg) { hook.loopError = msg; console.error('[hub] a frame failed (' + where + ')', e); } }
  function runLoop() {
    let last = performance.now(), acc = 0;
    const loop = (now) => {
      requestAnimationFrame(loop);
      try {
        const dt = Math.min(250, now - last); last = now;
        if (!document.hidden && !hook.paused) { acc += dt; let n = 0; while (acc >= STEP_MS && n < 8) { acc -= STEP_MS; n++; const fx = model.tick(heldNow()); if (fx && fx.length) run(fx); } if (n >= 8) acc = 0; }          // (a tick may ask for something: a dialog that timed out, the open app's tick)
      } catch (e) { loopFault('tick', e); }
      try { draw(false); } catch (e) { loopFault('draw', e); }
      try { reportFaults(); } catch (e) { loopFault('report', e); }
    };
    try { draw(true); } catch (e) { loopFault('draw', e); }
    requestAnimationFrame(loop);
  }

  /* ---- the test hook ---- */
  function fnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); }
  function makeHook() {
    Object.assign(hook, {
      model, ui, pack, canvas,
      press: (a, info) => { run(model.press(a, info)); return model.path(); },
      pointer: (ev) => { run(model.pointer(ev)); return model.path(); },
      type: (input) => { run(model.type(input)); return model.path(); },
      goto: (path, o) => { run(model.goto(path, o)); return model.path(); },          // open a screen as the page does (the history, the title, the app's ctl): what ctx.go(path, o) from a press leads to
      run: (effects) => { run(effects); return model.path(); },                       // carry out a list of effects as the page does (a test hands it what several model calls returned together)
      trail: () => model.trail(),
      history: () => ({ hist: hist.slice(), flying: flying !== 0 }),                  // the trail of the history entry the page believes the browser stands on, and whether a step back of its own is still to land
      held: () => [...held],
      wantsText: () => model.wantsText(),
      view: () => model.view(),
      tick: (n = 1, heldList) => { for (let i = 0; i < n; i++) { const fx = model.tick(heldList === undefined ? heldNow() : heldList); if (fx && fx.length) run(fx); } reportFaults(); draw(true); },
      pause: (v) => { hook.paused = !!v; },
      refresh: () => refreshData(),
      frameHash: () => fnv(screen.render(model.view()).rgba),
      canvasHash: () => fnv(ctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data),
      setMascot: (id) => { model.setMascot(id); dirty = true; draw(true); },
      closeControls, openControls,
      dialogOpen: () => dialogOpen,
      tower: { loaded: () => !!towerMod, effect: (e) => towerEffect(e), state: () => model.tower.state() },
      // the dialog layer and the apps: the model's own handles, plus what the page knows about each app's ctl
      dialog: model.dialog,
      apps: {
        ids: Object.keys(model.apps), state: () => model.state().apps, family: () => family,
        loaded: () => [...ctls].filter(([, c]) => !!c.ctl).map(([id]) => id), errors: () => Object.fromEntries([...ctls].filter(([, c]) => c.error).map(([id, c]) => [id, c.error])),
        ctl: (id) => (ctls.has(id) ? ctls.get(id).ctl : null), load: (id) => loadCtl(id).promise, idle: (id) => (ctls.has(id) ? ctls.get(id).chain : Promise.resolve()), effect: (e) => appEffect(e),
      },
    });
    Object.defineProperty(hook, 'renders', { get: () => renders, configurable: true });
    hook.sound = { on: () => (soundSys ? soundSys.audible() : cries.isSoundOn()) };
    Object.defineProperty(hook.sound, 'plays', { get: () => (soundSys ? soundSys.plays : snd.plays) });
    Object.defineProperty(hook.sound, 'ctx', { get: () => (soundSys ? soundSys.ctx() : snd.ctx) });
  }

  /* ---- load ---- */
  // The loading panel is revealed only if loading takes a moment (armReveal above, and arena.css: 400 ms), so a repeat visit never flashes it; everything below still runs the same either way.
  const load = async (pre) => {
    hook.state = 'boot'; els.err.hidden = true; els.boot.hidden = false; canvas.hidden = true; els.bar.value = 0; els.status.textContent = '';
    document.body.dataset.state = 'boot';
    armReveal();
    els.bootText.textContent = 'Fetching the ROM from this site...';
    try {
      const progress = (got, total) => { els.bar.value = got / total; els.bootText.textContent = 'Loading ROM  ' + mbs(got) + ' / ' + mbs(total) + ' MB'; };
      let loaded;
      if (pre) { if (early.total) progress(early.got, early.total); early.onProgress = progress; try { loaded = await pre; } finally { early.onProgress = null; } }
      else loaded = await loadVerifiedRom({ onProgress: progress, deferVerify: true });
      els.bar.value = 1; els.bootText.textContent = 'Checking the ROM and decoding its art...';
      if (!loaded.cached) await new Promise((r) => setTimeout(r, 0));          // lets the "Checking..." text paint on a first visit; a recalled copy has nothing to wait for
      return loaded;
    } catch (e) { showError(romError(e)); return null; }
  };

  // The SHA-256 of a RECALLED copy did not match (romfetch.js has already dropped the stored copy): reload ONCE through the full path, which downloads and verifies the real ROM and ends at the real error
  // screen when the ROM on the server is the bad one. A second failure in this tab (sessionStorage arena.rom.retry) shows the error instead, so this can never loop. Used by the re-check after the first
  // frame AND by start() when the copy was so damaged that the menu could not be built at all; `hook.rom` does not exist yet in the second case.
  function recalledCopyFailed(e) {
    let tried = false; try { tried = window.sessionStorage.getItem('arena.rom.retry') === '1'; window.sessionStorage.setItem('arena.rom.retry', '1'); } catch (_e) { /* blocked: treated as a first try */ }
    hook.rom = Object.assign(hook.rom || { cached: true, verified: false }, { error: String(e && e.message ? e.message : e).slice(0, 160) });
    if (!tried) window.location.reload(); else showError(romError(e));
  }

  async function start({ bytes, sha256, cached, verify }) {
    try {
      romBytes = bytes;
      pack = loadPack(bytes, { verify: 'header', dexText: false });         // the SHA-256 was checked in loadVerifiedRom
      ui = createBattleUi(bytes);
      screen = createHubScreen(ui);
      const saved = readSettings(storage);
      model = createHubModel({ sound: soundSys ? soundSys.audible() : cries.isSoundOn(), mascot: pickMascot(pack, Math.floor(Date.now() / 86400000)), env: 0, quick: saved.quick, selection: saved.selection, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });          // (the Tower, the apps and the dialog layer wrap their texts by the real font)
    } catch (e) {
      if (!verify) { showError(romError(e)); return; }
      // A RECALLED copy only passed romcache.js's cheap checks (length, headers, cartridge header). One that is damaged INSIDE -- a table the menu decodes -- throws right here, before the re-check below is
      // ever scheduled, and nothing else would drop it: every reload would read the same bytes and fail the same way, on an error screen with no Try again. So hash it now (the same verify() the
      // re-check runs). A mismatch means the stored copy was bad (and is gone): recover through the full path once. A copy that hashes fine is the right ROM, so the failure is not the storage's.
      let bad = null; try { await verify(); } catch (ve) { bad = ve; }
      if (bad) recalledCopyFailed(bad); else showError(romError(e));
      return;
    }
    disarmReveal();
    els.boot.hidden = true; els.err.hidden = true; canvas.hidden = false;
    document.body.dataset.state = 'ready';
    if (errNav) { try { errNav.disable(); } catch (_e) { /* ignore */ } }
    els.status.textContent = 'ROM verified: Pokemon SoulGold v1.1.1 (SHA-256 ' + sha256.slice(0, 8) + '...). Everything on screen is drawn from it; nothing is uploaded.';
    touchPad = coarse();
    const openAt = pathFromHash(location.hash);
    seedHistory(openAt);                             // the history entries the page stands on (`hist`): the ones a fresh arrival is given, or the ones the entry it came back to recorded
    const openFx = model.arrive(openAt, hist);       // the model opens the screen the address names, with that trail (B then walks it); openFx = what the screen's enter(path) asked for
    syncTitle();
    syncFamily();                                    // a page opened AT an app's screen loads that app's ctl now
    fit();
    wireInput();
    hook.state = 'ready'; hook.kind = null; hook.error = null; hook.sha256 = sha256;
    hook.rom = { cached: !!cached, verified: !cached };
    // a ROM that was just downloaded and verified (the usual end of a mismatch-triggered reload) clears the reload guard: the NEXT mismatch gets its one reload too
    if (!cached) { try { window.sessionStorage.removeItem('arena.rom.retry'); } catch (_e) { /* ignore */ } }
    // A RECALLED copy was trusted for the first frame (romcache.js: written by this origin after a full verification, headers and length re-checked); its SHA-256 is re-checked right AFTER that
    // frame has been painted (hashing hands 32 MB to WebCrypto, which copies it on this thread). If it fails the stored copy is already dropped (romfetch.js) and the page reloads ONCE through
    // the full path, which shows the real error screen when the ROM on the server is the bad one.
    if (verify) {
      const recheck = () => verify().then(() => { hook.rom.verified = true; try { window.sessionStorage.removeItem('arena.rom.retry'); } catch (_e) { /* ignore */ } }, recalledCopyFailed);
      hook.rom.recheck = recheck;
      window.requestAnimationFrame(() => window.setTimeout(recheck, 0));
    }
    makeHook();
    if (soundSys) { soundSys.setRom({ bytes, pack }); soundSys.menuMusic.set('hub'); window.__arenaSound = soundSys; soundSys.mixer.on((ev) => { if (ev.type === 'mute') { model.setSound(soundSys.audible()); dirty = true; } }); }       // MU3: the ROM's music (nothing is heard before the first click / tap / key); the SOUND row follows the M key
    focusCanvas();
    runLoop();
    if (openFx.length) run(openFx);
    openProfiles();                                  // the team list fills in when the store answers; the menu is usable at once
    loadTower().then((m) => { if (m) refreshData(); });          // the Tower's code loads behind the menu (the hub itself carries no engine); its rows fill in when it has
    // OPEN TO BATTLES (hub_presence.js: the page's ONE presence service, which mounts presence_boot.js): "<name> wants to battle you" whatever the player is doing, asked IN THE PICTURE by the
    // dialog layer (run() hands its answer back, setDialog() says when a DOM panel covers the picture). Loaded after the menu is up, so it can never delay or break it. THE SWITCH IS A ROW OF THE
    // PICTURE (PLAY ONLINE's OPEN TO BATTLES; that app's ctl reaches the same service through hubPresence(env)): there is no HTML button, so the service is handed none.
    const noSwitch = (e) => { console.warn('[presence] not available', e); };          // (the service then answers 'unavailable': the row says so and cannot be switched)
    import('./hub_presence.js').then((m) => {
      hook.presence = m.hubPresence({ win: window, doc: document, hook, model, pack, ui, navigate, input, storage, session, button: null, focusHome: focusCanvas, panelOpen: () => dialogOpen, redraw: () => { dirty = true; } });
      return hook.presence.ready.then((ok) => { if (!ok) noSwitch('presence_boot.js did not load'); });
    }).catch(noSwitch);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) { startGuard.reset(); refreshData(); } });          // restored from the back / forward cache: not leaving for the floor any more, so START works again
    window.addEventListener('pagehide', saveSettings);
    window.addEventListener('pagehide', (e) => { if (!e.persisted) disposeCtls(); });          // the page is really going (not into the back / forward cache): every loaded ctl lets go of what it holds
  }

  let loaded = await load(earlyLoad);
  els.retry.addEventListener('click', async () => { loaded = await load(); if (loaded) await start(loaded); });
  if (!loaded) return;
  await start(loaded);
}

if (hasDom) {
  main().catch((e) => {
    const err = document.getElementById('error');
    if (err) { err.hidden = false; document.getElementById('errTitle').textContent = 'Something went wrong'; document.getElementById('errMsg').textContent = String(e && e.message ? e.message : e); const b = document.getElementById('boot'); if (b) b.hidden = true; }
    if (window.__arenaHub) { window.__arenaHub.state = 'error'; window.__arenaHub.kind = 'internal'; window.__arenaHub.error = String(e && e.message ? e.message : e); }
    console.error(e);
  });
}
