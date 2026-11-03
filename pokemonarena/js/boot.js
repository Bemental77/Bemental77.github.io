// pokemonarena/js/boot.js -- page controller for /pokemonarena/ (the HUB: the game's front door).
//
// Fetches the SoulGold v1.1.1 ROM the site already serves (progress bar, length + SHA-256 gate), draws the menu from it (hub_screen.js),
// runs the menu's state machine (hub_model.js) and carries out what it asks for: open the quick-battle / saved-team battle page, the team
// builder, the Controls panel, the Sound switch. Input is the shared input layer (input.js): keyboard, mouse, touch and controller all
// arrive as the same twelve actions. No third-party code, no CDN. The old single-screen battle page that used to live here is gone.
//
// Import-safe in Node: nothing touches `document` unless it exists (tools/pokemonarena_page_test.mjs imports computeScale).
//
// Test hook: window.__arenaHub = { state: 'boot' | 'ready' | 'error', kind, error, model, press(), pointer(), ... } (see makeHook).

import { loadVerifiedRom, romUrl, RomLoadError } from './romfetch.js';
import { loadPack } from './tables.js';
import { createBattleUi } from './battle_ui.js';
import { createHubModel, SCREEN_W, SCREEN_H, PATHS } from './hub_model.js';
import { createHubScreen } from './hub_screen.js';
import { readHubData, teamCodeFor, battleHref, pickMascot } from './hub_data.js';
import { openStore } from './store.js';
import * as cries from './cries.js';
import { createControlsDialog } from './controls_dialog.js';
import { describeRomError, showRomError } from './rom_error.js';
import { watchHints } from './hints.js';

export const GBA_FPS = 59.7275;                 // the hardware frame rate; the menu's idle-animation clock, not a speed-up knob
const STEP_MS = 1000 / GBA_FPS;
export const SETTINGS_KEY = 'arena.hub';
export const SCREEN_TITLES = Object.freeze({ main: 'Pokemon Arena', quick: 'Pokemon Arena - Quick Battle', team: 'Pokemon Arena - My Team', record: 'Pokemon Arena - Record', about: 'Pokemon Arena - About' });

/* ------------------------------------------------------------------------------------------ pure helpers */

// Integer upscale chosen in DEVICE pixels: the source pixel is k whole device pixels wide, so a phone at devicePixelRatio 3 gets a crisp 4x
// (320 css px) instead of a blurry 1.49x. Always at least 1.
export function computeScale({ availW, availH, dpr = 1 }) {
  const d = dpr > 0 ? dpr : 1;
  const k = Math.max(1, Math.floor(Math.min((availW * d) / SCREEN_W, (availH * d) / SCREEN_H) + 1e-9));
  return { k, cssW: (SCREEN_W * k) / d, cssH: (SCREEN_H * k) / d };
}

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
  const [{ createInput }, nav, soundMod] = await Promise.all([import('./input.js').catch(() => ({})), import('./uinav.js').catch(() => ({})), import('./sound_system.js').catch((e) => { console.warn('[sound] sound_system.js did not load; the old switch is used:', e); return {}; })]);
  const $ = (id) => document.getElementById(id);
  const canvas = $('hub'), ctx = canvas.getContext('2d', { alpha: false });
  const els = { boot: $('boot'), bar: $('bar'), bootText: $('bootText'), err: $('error'), errTitle: $('errTitle'), errMsg: $('errMsg'), errDetail: $('errDetail'), retry: $('retry'), note: $('note'), status: $('romStatus'), top: $('top'), padA: $('dpad'), padB: $('ab'), sound: $('soundBtn'), controls: $('controlsBtn'), live: $('live'), dialog: $('controlsDialog'), host: $('controlsHost'), close: $('controlsClose'), keys: $('keys') };
  const hook = window.__arenaHub = { state: 'boot', kind: null, error: null, effects: [], store: 'pending' };
  const mbs = (n) => (n / 1048576).toFixed(1);
  const input = typeof createInput === 'function' ? createInput() : null;
  let pushed = 0;                                // history entries this page load added for hub screens
  let model = null, screen = null, ui = null, pack = null, romBytes = null, store = null, touchPad = false, dialogOpen = false, errNav = null;
  const storage = (() => { try { return window.localStorage; } catch (_e) { return null; } })();

  /* ---- errors ---- */
  function showError({ title, message, detail, kind, retry, tech }) {
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
  function fit() {
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, dpr = window.devicePixelRatio || 1;
    const landscape = vw > vh && vh < 560;
    document.body.dataset.layout = landscape ? 'landscape' : 'portrait';
    document.body.dataset.pad = touchPad ? 'on' : 'off';
    const top = els.top.offsetHeight + 16;
    const padH = touchPad && !landscape ? Math.max(els.padA.offsetHeight, els.padB.offsetHeight) + 10 : 0;
    const padW = touchPad && landscape ? els.padA.offsetWidth + els.padB.offsetWidth + 24 : 0;
    const hint = document.body.dataset.state === 'ready' ? (touchPad ? 44 : 84) : 0;
    // WIDTH: the page's side gutters are 16 px each (32), and the canvas carries a 2 px border on each side (4, content-box). A whole-device-pixel scale k needs
    // 240 * k / dpr css px: at DPR 2, 3x is 360 px, which with its border (364) needs a 396 px wide viewport; a 390 px phone has 358 px between its gutters, so it
    // gets 2x (240 px) and stays there unless the gutters shrink (they must not) or the picture is smoothed at a fractional scale (it must not be). The old
    // extra 4 px of slack here cost 3x on phones 396 to 399 px wide.
    const availW = Math.max(SCREEN_W / dpr, vw - 32 - padW - (touchPad && landscape ? 8 : 4));
    const availH = Math.max(SCREEN_H / dpr, vh - top - padH - hint - 12);
    const s = computeScale({ availW, availH, dpr });
    canvas.style.width = s.cssW + 'px'; canvas.style.height = s.cssH + 'px';
    hook.scale = s;
  }
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  /* ---- sound: muted by default; an AudioContext exists only after a user gesture AND with sound switched on ---- */
  // MU3: the mixer, the SOUND panel and the music live in sound_system.js (ON by default, audio starts at the first click / tap / key). The old switch below only runs if that file did not load.
  const soundSys = (() => { try { return typeof soundMod.createSoundSystem === 'function' ? soundMod.createSoundSystem({
    page: 'hub', button: els.sound, input: () => input, enableDomNav: nav.enableDomNav, ownNav: true,
    onPanelOpen: () => { dialogOpen = true; },
    onPanelClose: () => { dialogOpen = false; if (model) { model.setSound(soundSys.audible()); dirty = true; } setTimeout(() => { focusCanvas(); }, 0); },
  }) : null; } catch (e) { console.warn('[sound] the sound system could not start; the old switch is used:', e); return null; } })();
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
    onOpen: () => { dialogOpen = true; },
    onClose: () => { dialogOpen = false; setTimeout(() => { focusCanvas(); }, 0); },   // the key that closed the dialog must not also act on the menu behind it
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
      if (eff.type === 'screen') {
        // going into a screen adds a history entry; coming back to the menu steps BACK through that entry (so B and the browser's Back button agree and the history does not grow)
        try {
          if (eff.path === 'main' && pushed > 0) { pushed--; history.back(); }
          else { history.pushState({ arenaHub: eff.path }, '', hashFor(eff.path)); if (eff.path !== 'main') pushed++; }
        } catch (_e) { /* a sandboxed frame */ }
        syncTitle();
      }
      else if (eff.type === 'navigate') { saveSettings(); navigate(eff.url); }
      else if (eff.type === 'sound') setSound(eff.on);
      else if (eff.type === 'controls') openControls();
      else if (eff.type === 'battle') startBattle(eff);
      else if (eff.type === 'record-reset') resetRecord(eff.profileId);
    }
    dirty = true;
  }
  function syncTitle() { document.title = SCREEN_TITLES[model.path()] || SCREEN_TITLES.main; }
  window.addEventListener('popstate', () => { if (!model) return; pushed = pathFromHash(location.hash) === 'main' ? 0 : 1; model.goto(pathFromHash(location.hash)); syncTitle(); dirty = true; });

  /* ---- the team list: read from the browser-local store (profiles are never uploaded) ---- */
  // ST1: RESET RECORD was answered YES: the profile's battle record is emptied in the store (an automatic backup and a history entry are taken there), then the list is read again
  async function resetRecord(profileId) {
    if (!store) { model.notify(['The record cannot be reset right now.', 'Storage is not available.']); dirty = true; return; }
    try { await store.resetRecord(profileId); hook.recordReset = (hook.recordReset | 0) + 1; await refreshData(); }
    catch (e) { model.notify(['The record could not be reset:', String(e && e.message ? e.message : e).slice(0, 40)]); dirty = true; }
  }
  async function refreshData() {
    if (!store || !pack || !model) return;
    const d = await readHubData(store, pack, { tzMinutes: new Date().getTimezoneOffset() });
    model.setData(d);
    hook.data = d;
    const unsaved = d.notSaved;
    els.note.hidden = !unsaved; els.note.textContent = unsaved ? 'This browser is not keeping profiles (storage is blocked or in private mode), so teams you build here will be lost when you close the page.' : '';
    dirty = true;
  }
  async function openProfiles() {
    try { store = await openStore(); hook.store = store.status && store.status.notSaved ? 'memory' : 'indexeddb'; try { store.on('external', () => refreshData()); store.on('status', () => refreshData()); } catch (_e) { /* optional */ } }
    catch (e) { store = null; hook.store = 'unavailable'; model.setData({ state: 'unavailable', profiles: [], note: 'Storage could not be opened.' }); dirty = true; return; }
    await refreshData();
  }

  /* ---- drawing ---- */
  const img = new ImageData(SCREEN_W, SCREEN_H);
  let dirty = true, lastSig = '', renders = 0, lastSpoken = '';
  function sigOf(v) { return JSON.stringify({ ...v, tick: (v.tick >> 5) & 1 }); }
  function draw(force) {
    const v = model.view();
    const sig = sigOf(v);
    if (!force && sig === lastSig) { dirty = false; return; }
    lastSig = sig;
    const f = screen.render(v);
    img.data.set(f.rgba); ctx.putImageData(img, 0, 0); renders++; dirty = false;
    speak(v);
  }
  // a plain-text mirror of the canvas for screen readers (the canvas itself has only a static label)
  function speak(v) {
    let s;
    if (v.record) s = 'Record' + (v.record.trainer ? ' of ' + v.record.trainer.name : '') + ', page ' + (v.record.index + 1) + ' of ' + v.record.count + ': ' + v.record.page.title + '. ' + v.record.page.lines.map((l) => l.cells.map((c) => c.t).filter(Boolean).join(' ')).join('. ') + (v.record.confirm ? ' Choose YES or NO.' : '');
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
      if (!e.pressed || e.native || dialogOpen) return;
      if (e.action === 'b' && e.source === 'gamepad' && !e.repeat && model.path() === 'main') {
        const t = performance.now();
        if (t - leaveArmed < 4000) { leaveArmed = -1e9; saveSettings(); navigate('/'); return; }
        leaveArmed = t; model.notify(['Press B again to leave', 'the Arena for the site.']); dirty = true; return;
      }
      if (soundSys) { const before = soundSys.sig(model.state()); const fx = model.press(e.action); run(fx); soundSys.menuSfx(e.action, before !== soundSys.sig(model.state()), true, fx); return; }
      run(model.press(e.action));
    });
    input.on('pointer', (e) => {
      if (dialogOpen) return;
      if (e.kind === 'wheel') { if (e.el === canvas || e.x === null) run(model.pointer({ kind: 'wheel', steps: e.steps })); return; }
      if (e.el !== canvas || !e.inside) return;
      if (e.kind === 'move' || (e.kind === 'down' && e.source === 'touch')) { model.pointer({ kind: 'move', x: e.x, y: e.y }); dirty = true; }
      else if (e.kind === 'click') { const hitRow = !!(soundSys && model.hit(e.x, e.y)); const fx = model.pointer({ kind: 'click', x: e.x, y: e.y }); if (hitRow) soundSys.menuSfx('a', true, true, fx); run(fx); }
    });
  }

  /* ---- the clock: a fixed 59.7275 Hz step regardless of the display rate (it only animates the Pokemon) ---- */
  function runLoop() {
    let last = performance.now(), acc = 0;
    const loop = (now) => {
      const dt = Math.min(250, now - last); last = now;
      if (!document.hidden && !hook.paused) { acc += dt; let n = 0; while (acc >= STEP_MS && n < 8) { model.tick(); acc -= STEP_MS; n++; } if (n >= 8) acc = 0; }
      draw(false);
      requestAnimationFrame(loop);
    };
    draw(true);
    requestAnimationFrame(loop);
  }

  /* ---- the test hook ---- */
  function fnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); }
  function makeHook() {
    Object.assign(hook, {
      model, ui, pack, canvas,
      press: (a) => { run(model.press(a)); return model.path(); },
      pointer: (ev) => { run(model.pointer(ev)); return model.path(); },
      view: () => model.view(),
      tick: (n = 1) => { for (let i = 0; i < n; i++) model.tick(); draw(true); },
      pause: (v) => { hook.paused = !!v; },
      refresh: () => refreshData(),
      frameHash: () => fnv(screen.render(model.view()).rgba),
      canvasHash: () => fnv(ctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data),
      setMascot: (id) => { model.setMascot(id); dirty = true; draw(true); },
      closeControls, openControls,
      dialogOpen: () => dialogOpen,
    });
    Object.defineProperty(hook, 'renders', { get: () => renders, configurable: true });
    hook.sound = { on: () => (soundSys ? soundSys.audible() : cries.isSoundOn()) };
    Object.defineProperty(hook.sound, 'plays', { get: () => (soundSys ? soundSys.plays : snd.plays) });
    Object.defineProperty(hook.sound, 'ctx', { get: () => (soundSys ? soundSys.ctx() : snd.ctx) });
  }

  /* ---- load ---- */
  const load = async () => {
    hook.state = 'boot'; els.err.hidden = true; els.boot.hidden = false; canvas.hidden = true; els.bar.value = 0; els.status.textContent = '';
    document.body.dataset.state = 'boot';
    els.bootText.textContent = 'Fetching the ROM from this site...';
    try {
      const loaded = await loadVerifiedRom({ onProgress: (got, total) => { els.bar.value = got / total; els.bootText.textContent = 'Loading ROM  ' + mbs(got) + ' / ' + mbs(total) + ' MB'; } });
      els.bar.value = 1; els.bootText.textContent = 'Checking the ROM and decoding its art...';
      await new Promise((r) => setTimeout(r, 0));
      return loaded;
    } catch (e) { showError(romError(e)); return null; }
  };

  async function start({ bytes, sha256 }) {
    try {
      romBytes = bytes;
      pack = loadPack(bytes, { verify: 'header', dexText: false });         // the SHA-256 was checked in loadVerifiedRom
      ui = createBattleUi(bytes);
      screen = createHubScreen(ui);
      const saved = readSettings(storage);
      model = createHubModel({ sound: soundSys ? soundSys.audible() : cries.isSoundOn(), mascot: pickMascot(pack, Math.floor(Date.now() / 86400000)), env: 0, quick: saved.quick, selection: saved.selection });
    } catch (e) { showError(romError(e)); return; }
    els.boot.hidden = true; els.err.hidden = true; canvas.hidden = false;
    document.body.dataset.state = 'ready';
    if (errNav) { try { errNav.disable(); } catch (_e) { /* ignore */ } }
    els.status.textContent = 'ROM verified: Pokemon SoulGold v1.1.1 (SHA-256 ' + sha256.slice(0, 8) + '...). Everything on screen is drawn from it; nothing is uploaded.';
    touchPad = coarse();
    model.goto(pathFromHash(location.hash));
    syncTitle();
    fit();
    wireInput();
    hook.state = 'ready'; hook.kind = null; hook.error = null; hook.sha256 = sha256;
    makeHook();
    if (soundSys) { soundSys.setRom({ bytes, pack }); soundSys.director.set('hub'); window.__arenaSound = soundSys; soundSys.mixer.on((ev) => { if (ev.type === 'mute') { model.setSound(soundSys.audible()); dirty = true; } }); }       // MU3: the ROM's music (nothing is heard before the first click / tap / key); the SOUND row follows the M key
    focusCanvas();
    runLoop();
    openProfiles();                                  // the team list fills in when the store answers; the menu is usable at once
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshData(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) refreshData(); });
    window.addEventListener('pagehide', saveSettings);
  }

  let loaded = await load();
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
