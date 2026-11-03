// pokemonarena/js/sound_system.js -- the one object a page creates to get sound: the mixer (audio_mixer.js), the music director
// (music_director.js), the SOUND panel (sound_panel.js), the header Sound button, the M key, the "press any key" prompt, the cries, and the
// battle-page helpers (music follows the scene's mode, menu sounds, hit sounds, pause-menu ducking).
//
//   const sys = createSoundSystem({ page: 'hub' | 'battle' | 'editor', button, input: () => input, enableDomNav, ownNav, onPanelOpen, onPanelClose });
//   sys.setRom({ bytes, pack });                 // after the page has decoded the SoulGold ROM: the music engine and the cries need it
//   sys.director.set('hub')                      // which song (a music_map key)         sys.openPanel(done)     sys.audible()
//   sys.playCry(species, 'normal' | 'faint')     // through the effects bus              sys.state()             sys.destroy()
//
// WHAT HAPPENS WHEN (the product definition of the audio, README "Sound"):
//   * Sound is ON by default. Nothing is heard and no AudioContext exists until the visitor's first click, tap or key press. A visitor who has only
//     a controller sees a prompt that says so (a controller button is not a browser user activation).
//   * music.js and music_map.js are imported AFTER the page is up (dynamic import); a missing or failing engine leaves the game playable and silent
//     (state().director.error says why). The second soundtrack (Ultra Violet) is fetched only when it is chosen (or was chosen last time).
//   * test seam: window.__arenaSoundModules = { music: () => Promise<module>, map: () => Promise<module>, uvRom: (onProgress) => Promise<Uint8Array> } replaces
//     the three loaders (tools/pokemonarena_sound_page_test.mjs installs recording stand-ins before the page runs).
//
// Import-safe in Node: nothing touches window/document at import.

import { createMixer } from './audio_mixer.js';
import { createDirector, resolveKey } from './music_director.js';
import { createSoundPanel, SOUNDTRACK_LABELS } from './sound_panel.js';
import { isTextTarget } from './input.js';
import * as cries from './cries.js';

export const UV_FILE = '/gba/gbaWasm/roms/pokemonUltraViolet.gba';
export const UV_FALLBACK_SIZE = 16777216;
export const TEST_CRY_SPECIES = Object.freeze([25, 1, 4, 7, 133]);
export const PROMPT_TEXT = Object.freeze({
  long: 'Click, tap or press a keyboard key to start the sound (a controller button cannot). Esc or a controller button hides this.',
  short: 'Click, tap or press a key for sound (a controller button cannot).',       // for a cramped layout: it still says what a controller visitor needs to know
});
export const CRY_GAIN = 0.35;                         // per-cry level before the effects bus (the pages used 0.35 already)
/**
 * The game's red zone for the low-HP warning. ROM: HandleLowHpMusicChanges @0x08080130 plays SE 90 (se_lowhp) when GetHPBarLevel @0x08086cac returns RED and stops it (m4aSongNumStop)
 * when it does not. GetHPBarLevel: HP == max or max <= 1 -> full; HP > max/2 -> green; HP > max/5 -> yellow; HP > 0 -> RED; else empty (integer division, signed 16 bit). The beep is
 * only the player's own active Pokemon (the opponent's controller never calls it). tools/pokemonarena_sound_oracle_test.mjs runs the ROM's own function against this one.
 */
export function isLowHp(hp, max) {
  const h = Number(hp), m = Number(max);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  return h > 0 && m > 1 && h <= Math.trunc(m / 5);
}
/** Menu effects (hub_model.js) the game answers with its error buzz (SE_FAILURE, 82 menu / party-menu ROM sites): START refused. Battle-screen refusals are NOT here: the real battle UI plays only the select sound (oracle-verified). */
export const ERROR_EFFECTS = Object.freeze(['blocked']);
// Which scene modes (scene.js) are menus, i.e. where a cursor / select / back sound belongs. Text advancing ('steps', 'wait') is silent, as in the game.
export const MENU_MODES = Object.freeze(['action', 'moves', 'party', 'preview', 'menu', 'confirm', 'result', 'recap']);       // ST1: 'recap' = the match recap pages: cursor / select / back sounds like any menu

const STYLE_ID = 'arena-sound-prompt-style';
const PROMPT_CSS = `
.arena-sndprompt { position: fixed; left: 50%; bottom: max(10px, env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 1500; max-width: min(92vw, 520px); box-sizing: border-box;
  background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--accent, #6af); border-radius: 10px; padding: 6px 10px; font: 12.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; box-shadow: 0 4px 18px rgba(0,0,0,.6); }
.arena-sndprompt[hidden] { display: none !important; }
/* The prompt is the only way a controller-only visitor learns what to do, so it is shown on EVERY layout (touch pad or not). It is text only and ignores the pointer completely, so it can
   never swallow a tap or a click (any key, click or tap starts the sound by itself). WHERE it sits is chosen in JS (placePrompt): a spot that covers neither the picture, the touch pad,
   the footer lines nor anything in the header. */
.arena-sndprompt, .arena-sndprompt * { pointer-events: none; }
.arena-sndtoast { position: fixed; right: max(12px, env(safe-area-inset-right)); top: max(56px, env(safe-area-inset-top)); z-index: 1600; background: var(--panel, #1a1a1f); color: var(--fg, #ddd); border: 1px solid var(--line, #3a3a44); border-radius: 8px; padding: 8px 12px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; pointer-events: none; }
.arena-sndtoast[hidden] { display: none !important; }
`;

export function createSoundSystem(opts = {}) {
  const win = opts.window !== undefined ? opts.window : (typeof window !== 'undefined' ? window : null);
  const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
  const page = opts.page || 'page';
  const seam = (win && win.__arenaSoundModules) || {};
  const loadMusicModule = opts.loadMusic || seam.music || (() => import('./music.js'));
  const loadMapModule = opts.loadMap || seam.map || (() => import('./music_map.js'));

  const mixer = opts.mixer || createMixer({ window: win, document: doc, storage: opts.storage, ...(opts.mixerOptions || {}) });
  const S = {
    rom: null, pack: null, romWaiters: [], map: null, mapP: null, cry: new Map(), plays: 0, testPlays: 0, lastTest: -1e9,
    uv: { bytes: null, state: 'idle', message: '', progress: 0, failed: false, p: null },
    animSounds: false, lastMode: null, lastDecisive: null, prompt: null, toast: null, toastTimer: null, destroyed: false, hooked: null,
    menuSfx: [], panelDone: null, frameError: null,
    fallbackAt: new Map(),                                      // song-table index -> when a hook played it (the animator's duplicate of it is dropped)
    promptDismissed: false, promptWhy: null, offPad: null,
    low: { on: false, h: null, plays: 0, stops: 0 },            // the low-HP warning: on = the player's active Pokemon is in the red zone and the beep was started for this stay in it
  };

  /* ---------------------------------------------------------------- the music map + the ROMs the engine reads */
  function loadMap() {
    if (S.map) return Promise.resolve(S.map);
    if (!S.mapP) S.mapP = Promise.resolve().then(() => loadMapModule()).then((m) => { S.map = m; return m; }, (e) => { S.mapP = null; throw e; });
    return S.mapP;
  }
  const songFor = (soundtrack, key) => (S.map && typeof S.map.songFor === 'function' ? S.map.songFor(soundtrack, key) : null);
  // music_map.js owns the fallback chains (resolveSong); without it (the stand-in map in tests) the director's own chains apply
  const resolve = (soundtrack, key) => { if (S.map && typeof S.map.resolveSong === 'function') { const r = S.map.resolveSong(soundtrack, key); return r ? { key: r.key, song: r } : null; } return resolveKey(songFor, soundtrack, key); };

  function setRom({ bytes, pack }) {
    S.rom = bytes; S.pack = pack;
    for (const r of S.romWaiters.splice(0)) r(bytes);
    director.sync();
  }
  const soulgoldRom = () => (S.rom ? Promise.resolve(S.rom) : new Promise((res) => S.romWaiters.push(res)));

  async function fetchUv(onProgress) {
    if (seam.uvRom) return seam.uvRom(onProgress);
    const { fetchRom, romUrl } = await import('./romfetch.js');
    const base = romUrl().replace(/\/gba\/gbaWasm\/roms\/[^/]*$/, '');
    return fetchRom({ url: base + UV_FILE, onProgress: (got, total) => onProgress(got, total) });
  }
  // The Ultra Violet ROM: fetched once, length + SHA-256 checked against music_map's ROM_PROFILES (hashes and sizes only are committed).
  function loadUv() {
    if (S.uv.bytes) return Promise.resolve(S.uv.bytes);
    if (S.uv.p) return S.uv.p;
    S.uv.state = 'loading'; S.uv.progress = 0; S.uv.message = 'Fetching the Ultra Violet ROM...'; S.uv.failed = false; panel.refresh();
    S.uv.p = (async () => {
      try {
        const map = await loadMap().catch(() => null);
        const prof = map && map.ROM_PROFILES && map.ROM_PROFILES.ultraviolet;
        const bytes = await fetchUv((got, total) => { S.uv.progress = total ? got / total : 0; S.uv.message = 'Loading the Ultra Violet ROM  ' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB'; panel.refresh(); });
        const size = prof && prof.size ? prof.size : UV_FALLBACK_SIZE;
        if (!(bytes instanceof Uint8Array) || bytes.length !== size) throw new Error('the file is ' + (bytes ? bytes.length : 0) + ' bytes, not ' + size + ' (the download may be cut short, or the server returned a page instead of the ROM)');
        if (prof && prof.sha256) {
          const { sha256HexFast } = await import('./rom.js');
          const sha = await sha256HexFast(bytes);
          if (sha !== prof.sha256) throw new Error('it is not the Ultra Violet image this page expects (SHA-256 ' + sha.slice(0, 12) + '...)');
        }
        S.uv.bytes = bytes; S.uv.state = 'ready'; S.uv.message = ''; S.uv.progress = 1;
        return bytes;
      } catch (e) {
        S.uv.failed = true; S.uv.state = 'error'; S.uv.message = 'Ultra Violet could not be loaded: ' + String(e && e.message ? e.message : e).slice(0, 160) + '. The SoulGold soundtrack keeps playing.';
        throw e;
      } finally { S.uv.p = null; panel.refresh(); }
    })();
    S.uv.p.catch(() => {});
    return S.uv.p;
  }
  // the soundtrack actually in use: a chosen-but-unloadable Ultra Violet falls back to SoulGold for this visit (the stored choice is not changed)
  const effectiveSoundtrack = () => (mixer.soundtrack() === 'ultraviolet' && S.uv.failed ? 'soulgold' : mixer.soundtrack());
  async function romFor(soundtrack) {
    if (soundtrack === 'ultraviolet') {
      try { return await loadUv(); } catch (e) { setTimeout(() => director.sync(), 0); throw e; }       // sync() re-reads effectiveSoundtrack: SoulGold
    }
    return soulgoldRom();
  }

  const director = createDirector({
    mixer, songFor, resolve, soundtrack: effectiveSoundtrack, romFor,
    loadMusic: async () => { const [m] = await Promise.all([loadMusicModule(), loadMap().catch(() => null)]); return m; },
  });

  /* ---------------------------------------------------------------- the panel + the header button */
  const soundtracks = {
    labels: SOUNDTRACK_LABELS,
    status() {
      if (S.uv.state === 'loading') return { state: 'loading', soundtrack: 'ultraviolet', message: S.uv.message, progress: S.uv.progress };
      if (S.uv.state === 'error' && mixer.soundtrack() !== 'soulgold') return { state: 'error', soundtrack: mixer.soundtrack(), message: S.uv.message };
      if (S.uv.state === 'error') return { state: 'error', soundtrack: 'soulgold', message: S.uv.message };
      const d = director.state();
      if (d.error && d.error.where === 'load') return { state: 'error', soundtrack: mixer.soundtrack(), message: 'The music could not start (' + d.error.message + '). Cries and the rest of the game are not affected.' };
      return { state: 'ready', soundtrack: mixer.soundtrack(), message: '' };
    },
    async choose(name) {
      if (name === mixer.soundtrack() && !(name === 'ultraviolet' && S.uv.failed)) return { ok: true };
      if (name === 'ultraviolet') {
        S.uv.failed = false;
        try { await loadUv(); } catch (e) { return { ok: false, message: S.uv.message }; }
      }
      mixer.setSoundtrack(name);
      panel.refresh();
      return { ok: true };
    },
  };
  const panel = createSoundPanel({
    mixer, document: doc, input: opts.input, enableDomNav: opts.enableDomNav, ownNav: opts.ownNav, soundtracks,
    onTest: (kind) => testCry(kind),
    onOpen: () => { if (typeof opts.onPanelOpen === 'function') opts.onPanelOpen(); },
    // the page's own close hook first (it stops ignoring input), then the caller's done() one tick later: the key that closed the panel must not also act on the screen behind it
    onClose: () => {
      if (typeof opts.onPanelClose === 'function') opts.onPanelClose();
      const d = S.panelDone; S.panelDone = null;
      if (d) setTimeout(() => { try { d(); } catch (_e) { /* a page callback must not break closing */ } }, 0);
    },
  });
  const button = opts.button || null;
  function paintButton() {
    if (!button) return;
    const off = mixer.muted();
    button.textContent = 'Sound: ' + (off ? 'off' : 'on');
    button.setAttribute('aria-haspopup', 'dialog');
    button.removeAttribute('aria-pressed');
    button.title = 'Sound settings: volume, music, effects, soundtrack' + (off ? ' (muted)' : '');
  }
  if (button) button.addEventListener('click', (e) => { panel.open(); void e; });

  /* ---------------------------------------------------------------- the prompt (a controller cannot start sound) and the toast */
  function ensureStyle() { if (!doc || doc.getElementById(STYLE_ID)) return; const st = doc.createElement('style'); st.id = STYLE_ID; st.textContent = PROMPT_CSS; (doc.head || doc.documentElement).appendChild(st); }
  function buildPrompt() {
    if (!doc || S.prompt) return;
    ensureStyle();
    const p = doc.createElement('div'); p.className = 'arena-sndprompt'; p.id = 'soundPrompt'; p.setAttribute('role', 'status'); p.hidden = true; p.dataset.sndPrompt = '1';
    p.dataset.sndText = 'long'; p.textContent = PROMPT_TEXT.long;
    (doc.body || doc.documentElement).appendChild(p);
    S.prompt = p;
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', placePrompt);
  }
  // ---- where the prompt sits: a spot where it covers nothing the player needs ----
  const PROMPT_OBSTACLES = ['canvas', '#dpad', '#ab', '#onlineLink', '#keys', '#romStatus', '#note'];      // the picture, the touch pad (both clusters), the hub's link to the online lobby, the footer lines; the header's own children are added below
  const PROMPT_FOOTERS = ['#keys', '#romStatus', '#note'];                                    // the dim lines under the page: the cheapest things to cover when nothing is free
  function rectOf(el) {
    try { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return null; const cs = win.getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden' ? null : r; } catch (_e) { return null; }
  }
  // a header title is a flex item that STRETCHES across the free space; what it occupies is its text
  function ownRect(el) {
    const r = rectOf(el); if (!r || el.tagName !== 'H1' || !doc.createRange) return r;
    try { const rg = doc.createRange(); rg.selectNodeContents(el); const t = rg.getBoundingClientRect(); return t.width > 0 && t.height > 0 ? t : r; } catch (_e) { return r; }
  }
  const hits = (a, b, pad) => a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
  /**
   * Candidate spots, long text first then the short one, widest first: right under the content (canvas pages), bottom centre / left / right, middle left / right, and only as a
   * last resort the header's free gap (between its title and its buttons: it reads as part of the header). The first spot with no overlap wins; when the page is so full that none exists the least-overlapping one is used (data-overlap): the
   * pill ignores the pointer, so even then it costs the player no press.
   */
  function placePrompt() {
    const p = S.prompt;
    if (!p || p.hidden || !win || !doc) return;
    const vw = doc.documentElement.clientWidth, vh = win.innerHeight, G = 8, PAD = 2;
    const obs = [], wts = []; let canvasPage = false;          // wts: what covering each costs. The picture, the touch pad and the header's controls cost 10; a dim footer line costs 1, so on a page too full for a free spot the pill goes over a footer line, never over a touch button
    for (const sel of PROMPT_OBSTACLES) { const el = doc.querySelector(sel); const r = el ? rectOf(el) : null; if (r) { obs.push(r); wts.push(PROMPT_FOOTERS.includes(sel) ? 1 : 10); if (sel === 'canvas') canvasPage = true; } }
    const head = doc.getElementById('top'); const headBox = head ? rectOf(head) : null; const kids = [];
    if (head) for (const k of Array.from(head.children)) { const r = ownRect(k); if (r) { obs.push(r); wts.push(10); kids.push(r); } }
    const lowest = obs.reduce((m, o) => Math.max(m, o.bottom), 0);
    // the widest free stretch of the header's first row
    let gap = null;
    if (headBox) {
      const row = kids.filter((k) => k.top < headBox.top + 40).sort((a, b) => a.left - b.left); let x = headBox.left;
      for (const k of row.concat([{ left: headBox.right }])) { const w = k.left - x; if (!gap || w > gap.w) gap = { x, w }; x = Math.max(x, k.right || x); }
    }
    p.style.transform = 'none'; p.style.right = 'auto'; p.style.bottom = 'auto';
    let best = null;
    // (text, width) choices from the roomiest to the most cramped; a short text at 146 px reads better than the long one at 146 px, so it is tried first
    const CHOICES = [['long', 520], ['long', 340], ['short', 340], ['long', 230], ['short', 230], ['short', 146], ['long', 146]];
    const search = (withHeader) => {
      for (const [kind, w] of CHOICES) {
        if (p.dataset.sndText !== kind) { p.textContent = PROMPT_TEXT[kind]; p.dataset.sndText = kind; }
        const ww = Math.min(w, vw - 2 * G); if (ww < 140) continue;
        p.style.maxWidth = ww + 'px'; p.style.left = '0px'; p.style.top = '0px';
        const r = p.getBoundingClientRect(), pw = r.width, ph = r.height;
        const cands = [];
        // directly under the picture first when the room under it is free (a phone held upright keeps its controls at the bottom, so the free room is the band between the two),
        // then under everything (a page whose controls sit right under the picture leaves it below them)
        if (canvasPage) { const cv = doc.querySelector('canvas'), cr = cv ? rectOf(cv) : null; if (cr) cands.push([(vw - pw) / 2, cr.bottom + G]); }
        if (canvasPage) cands.push([(vw - pw) / 2, lowest + G]);
        cands.push([(vw - pw) / 2, vh - ph - G], [G, vh - ph - G], [vw - pw - G, vh - ph - G], [G, (vh - ph) / 2], [vw - pw - G, (vh - ph) / 2]);
        if (withHeader && gap && headBox && gap.w - 2 * G >= pw) cands.push([gap.x + G + (gap.w - 2 * G - pw) / 2, headBox.top + (headBox.height - ph) / 2]);       // LAST RESORT: it floats between the title and the buttons, which looks like part of the header
        for (const [cx, cy] of cands) {
          const box = { left: cx, top: cy, right: cx + pw, bottom: cy + ph };
          if (box.left < 0 || box.top < 0 || box.right > vw || box.bottom > vh) continue;
          const ov = obs.reduce((s, o, i) => s + (hits(box, o, PAD) ? wts[i] : 0), 0);
          if (!best || ov < best.ov) best = { x: cx, y: cy, w: ww, ov, kind };
          if (ov === 0) return true;
        }
      }
      return false;
    };
    if (!search(false)) search(true);            // the header's free gap is only looked at when no other spot at ANY text / width is free
    if (!best) { p.style.maxWidth = Math.max(140, Math.min(vw - 2 * G, 520)) + 'px'; p.style.left = G + 'px'; p.style.top = Math.max(G, vh - 80) + 'px'; p.setAttribute('data-overlap', '1'); return; }
    if (p.dataset.sndText !== best.kind) { p.textContent = PROMPT_TEXT[best.kind]; p.dataset.sndText = best.kind; }
    p.style.maxWidth = best.w + 'px'; p.style.left = best.x + 'px'; p.style.top = best.y + 'px';
    if (best.ov) p.setAttribute('data-overlap', '1'); else p.removeAttribute('data-overlap');
  }
  const promptVisible = () => !!(S.prompt && !S.prompt.hidden && rectOf(S.prompt));
  /**
   * Hide the hint without starting any sound. Every device can: a click, a tap or a key press START the sound (which hides it); Escape (not a browser activation) and ANY controller
   * button (not one either) hide it by themselves, so a visitor with only a pad is never stuck looking at it. The input still acts normally: nothing is consumed.
   */
  function dismissPrompt(why) { if (S.promptDismissed) return false; S.promptDismissed = true; S.promptWhy = why || 'dismissed'; paintPrompt(); return true; }
  function onPromptKey(e) { if (e && e.key === 'Escape' && S.prompt && !S.prompt.hidden) dismissPrompt('escape'); }
  function attachPadDismiss() {
    if (S.offPad) return;
    let inp = null; try { inp = typeof opts.input === 'function' ? opts.input() : opts.input; } catch (_e) { inp = null; }
    if (!inp || typeof inp.on !== 'function') return;                    // the page's input layer is not up yet: the 500 ms follower tries again
    try { S.offPad = inp.on('action', (e) => { if (e && e.pressed && e.source === 'gamepad') dismissPrompt('pad'); }); } catch (_e) { S.offPad = null; }
  }
  function paintPrompt() {
    if (!doc) return;
    if (!S.prompt) buildPrompt();
    if (!S.prompt) return;
    const show = mixer.needsActivation() && !opts.noPrompt && !S.promptDismissed;
    S.prompt.hidden = !show;
    if (show) { attachPadDismiss(); placePrompt(); if (!S.promptTimer) S.promptTimer = setInterval(() => { attachPadDismiss(); placePrompt(); }, 500); }       // the page is still laying itself out (the ROM loads, the pad appears): follow it
    else if (S.promptTimer) { clearInterval(S.promptTimer); S.promptTimer = null; }
  }
  function toast(text) {
    if (!doc) return;
    ensureStyle();
    if (!S.toast) { const t = doc.createElement('div'); t.className = 'arena-sndtoast'; t.id = 'soundToast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); t.hidden = true; (doc.body || doc.documentElement).appendChild(t); S.toast = t; }
    S.toast.textContent = text; S.toast.hidden = false;
    if (S.toastTimer) clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => { if (S.toast) S.toast.hidden = true; }, 1600);
  }

  /* ---------------------------------------------------------------- cries (effects bus) */
  function playCry(species, mode) {
    if (S.destroyed || !mixer.canPlay() || !S.pack || !S.rom) return false;
    try {
      let c = S.cry.get(species);
      if (c === undefined) { c = cries.cryForSpecies(S.pack, S.rom, species); S.cry.set(species, c); }
      if (!c) return false;
      const h = cries.playCry(mixer.ctx(), c, { mode: mode || 'normal', gain: CRY_GAIN, destination: mixer.destination('fx') });
      if (h) { S.plays++; return true; }
    } catch (_e) { /* a cry that cannot be decoded is simply silent */ }
    return false;
  }
  function testCry(kind) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - S.lastTest < 220) return false;                    // dragging the Effects slider must not stack cries
    S.lastTest = now;
    if (!S.pack) return false;
    const sp = TEST_CRY_SPECIES.find((id) => S.pack.species && S.pack.species[id] && S.pack.species[id].cryId);
    const ok = sp ? playCry(sp, 'normal') : false;
    if (ok) S.testPlays++;
    void kind;
    return ok;
  }

  /* ---------------------------------------------------------------- events: the mixer changed */
  const offMixer = mixer.on((ev) => {
    if (ev.type === 'mute' || ev.type === 'soundtrack' || ev.type === 'volume') paintButton();
    paintPrompt();
  });

  /* ---------------------------------------------------------------- the M key */
  function onKey(e) {
    if (S.destroyed || e.defaultPrevented || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'KeyM' && e.key !== 'm' && e.key !== 'M') return;
    if (e.isComposing || e.keyCode === 229) return;
    const t = e.target;
    if (t && t !== doc.body && isTextTarget(t)) return;
    const inp = typeof opts.input === 'function' ? opts.input() : opts.input;
    try {
      if (inp && inp.capturing) return;                           // the Controls panel is waiting for a key to bind: that key is not ours
      if (inp && inp.bindings) { const b = inp.bindings.get(); if (Object.values(b.keyboard).some((l) => l.includes('KeyM'))) return; }     // the player bound M to an action: theirs wins
    } catch (_e) { /* the input layer is optional */ }
    mixer.unlock();
    mixer.toggleMuted();
    toast(mixer.muted() ? 'Sound muted (M)' : 'Sound on (M)');
    paintButton();
  }

  /* ---------------------------------------------------------------- battle helpers */
  const HIT_KEY = (eff) => (typeof eff === 'number' && eff > 4096 ? 'se_hit_super' : typeof eff === 'number' && eff < 4096 && eff > 0 ? 'se_hit_weak' : 'se_hit_normal');
  const FALLBACK_DEDUPE_MS = 1500;
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  /**
   * Chain onto the scene's hooks object: the effectiveness sound at the HP drop (onHit), the faint sound, the send-out sound, and the animator's own sound events (onSound).
   * THE EFFECTIVENESS SOUND IS THE BATTLE SCRIPT'S, NOT THE MOVE ANIMATION'S: in the real game a hit starts the move's own sound (animation) and then SE 13 / 14 / 12 at the
   * start of the HP drain, as separate starts (oracle: tools/pokemonarena_sound_oracle_test.mjs). The animator only ever delivers what the animation code plays, so onHit
   * ALWAYS plays it; a faint is the animator's too when a system animation runs, so a faint sound played here is remembered and the same sound the animator then delivers
   * within 1.5 s is dropped (one faint sound, not two). (Before this the first sound the animator delivered switched all three hooks off, and a real battle lost every hit sound.)
   */
  function hookScene(scene) {
    const hooks = scene && scene.hooks;
    if (!hooks || S.hooked === hooks) return false;
    S.hooked = hooks;
    const chain = (name, mine) => { const prev = hooks[name]; hooks[name] = typeof prev === 'function' ? (...a) => { try { mine(...a); } catch (_e) { /* sound never breaks the scene */ } return prev(...a); } : (...a) => { try { mine(...a); } catch (_e) { /* ignore */ } }; };
    const playKey = (key) => { try { const r = songFor(effectiveSoundtrack(), key); if (r && Number.isInteger(r.index)) S.fallbackAt.set(r.index, nowMs()); } catch (_e) { /* no map yet: nothing to remember */ } return director.playSfx(key); };
    chain('onHit', (_side, info) => { playKey(HIT_KEY(info && info.eff)); });
    chain('onFaint', () => { playKey('se_faint'); });
    chain('onSendOut', () => { if (!S.animSounds) director.playSfx('se_ball_open'); });
    chain('onSound', (index, pan) => {
      S.animSounds = true;
      const t = S.fallbackAt.get(index);
      if (t !== undefined) { S.fallbackAt.delete(index); if (nowMs() - t < FALLBACK_DEDUPE_MS) return; }       // the same sound was just played from the hook
      director.playEffectIndex(index, pan);
    });
    return true;
  }
  /**
   * Called every frame by the battle page: the music follows the scene's mode, and the pause menu ducks it. hasPreview = the battle opens on a team preview (3v3): its
   * intro text then waits for the preview song; a battle without one (6v6) starts its battle song with the intro text.
   */
  function battleFrame(scene, cpu, hasPreview) {
    try { battleFrameInner(scene, cpu, hasPreview); } catch (e) { S.frameError = String(e && e.message ? e.message : e); }
    try { lowHpFrame(scene); } catch (e) { S.frameError = String(e && e.message ? e.message : e); }
  }
  /** Stop the low-HP beep (the ROM's m4aSongNumStop(90)). */
  function stopLowHp() {
    const h = S.low.h; S.low.h = null;
    if (S.low.on) { S.low.on = false; S.low.stops++; }
    if (h && typeof h === 'object' && typeof h.stop === 'function') { try { h.stop(); } catch (_e) { /* a stopped effect is already silent */ } }
  }
  /**
   * The low-HP warning, as the game does it (HandleLowHpMusicChanges): the beep starts ONCE when the player's active Pokemon is in the red zone after its HP bar has stopped moving
   * (the oracle: the real game starts SE 90 one frame after the bar's last step, tools/pokemonarena_sound_oracle_test.mjs), is not repeated while it stays there, and stops when it is
   * no longer red (healed, fainted, replaced, battle over). Silent while the sound is off: nothing is queued.
   */
  function lowHpFrame(scene) {
    const st = scene.state();
    const disp = scene.S && Array.isArray(scene.S.disp) ? scene.S.disp : null;
    if (disp && disp.some((d) => d && d.barCurr !== undefined)) return;                       // a bar is still draining / filling: the game decides when it has stopped
    const p = st && st.player;
    const red = !!(p && p.visible !== false && st.mode !== 'result' && isLowHp(p.hp, p.max));
    if (red && !S.low.on) {
      S.low.on = true; S.low.plays++;
      const h = director.playSfx('se_lowhp');
      S.low.h = h || null;
    } else if (!red && S.low.on) stopLowHp();
  }
  function battleFrameInner(scene, cpu, hasPreview) {
    const mode = scene.mode;
    if (mode === S.lastMode) return;
    S.lastMode = mode;
    mixer.duck(mode === 'menu');
    let want = null;
    if (mode === 'preview') want = 'preview';
    else if (mode === 'result') want = 'result';
    else if (mode === 'action' || mode === 'moves' || mode === 'party') want = 'battle';
    else if ((mode === 'steps' || mode === 'wait') && (S.lastDecisive === 'preview' || (S.lastDecisive === null && hasPreview === false))) want = 'battle';
    if (!want || want === S.lastDecisive) return;
    S.lastDecisive = want;
    if (want === 'preview') director.set('preview');
    else if (want === 'battle') director.battle(cpu);
    else if (want === 'result') {
      let w = null; try { w = scene.state().winner; } catch (_e) { w = null; }
      director.result(w === 0 ? 'win' : w === -1 || w === null || w === undefined ? 'draw' : 'lose');
    }
  }
  /**
   * A menu sound for an input that just ran. changed = did the screen's cursor / mode move because of it. effects = the effects the screen's model returned for it (hub_model.js):
   * a refused START ({ type: 'blocked' }) answers with the error buzz (se_error) instead of the select sound, as the game's menus do (SE_FAILURE).
   */
  function menuSfx(action, changed, inMenu, effects) {
    if (!inMenu) return;
    const refused = Array.isArray(effects) && effects.some((e) => e && ERROR_EFFECTS.includes(e.type));
    const key = refused ? 'se_error' : action === 'a' ? 'se_select' : action === 'b' ? (changed ? 'se_back' : null) : (action === 'up' || action === 'down' || action === 'left' || action === 'right') ? (changed ? 'se_cursor' : null) : null;
    if (!key) return;
    S.menuSfx.push(key); if (S.menuSfx.length > 100) S.menuSfx.shift();
    director.playSfx(key);
  }
  const sceneSig = (scene) => { try { const s = scene.state(); const o = scene.S && scene.S.overlay; return JSON.stringify([s.mode, s.cursor, s.moveCursor, s.partyCursor, s.picks, s.resultCursor, s.recapPage, o ? o.cursor : null]); } catch (_e) { return ''; } };
  // (the sound part of these three is wrapped: whatever happens in it, the scene still gets its press / click and the frame still runs)
  function pressWithSfx(scene, action) {
    let m0 = null, s0 = '';
    try { m0 = scene.mode; s0 = sceneSig(scene); } catch (_e) { /* ignore */ }
    const r = scene.press(action);
    try { menuSfx(action, sceneSig(scene) !== s0, MENU_MODES.includes(m0)); } catch (_e) { /* ignore */ }
    return r;
  }
  function clickWithSfx(scene, ev) {
    let m0 = null;
    try { m0 = scene.mode; } catch (_e) { /* ignore */ }
    const r = scene.pointer(ev);
    try { if (ev && ev.kind === 'click') menuSfx('a', true, MENU_MODES.includes(m0)); } catch (_e) { /* ignore */ }
    return r;
  }

  /* ---------------------------------------------------------------- life cycle */
  function openPanel(done) { if (panel.isOpen()) return Promise.resolve(true); S.panelDone = typeof done === 'function' ? done : null; return panel.open(); }
  const detach = mixer.attach();
  if (doc && typeof doc.addEventListener === 'function') { doc.addEventListener('keydown', onKey); doc.addEventListener('keydown', onPromptKey); }
  if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', () => { stopLowHp(); director.stop({ fadeOutMs: 200 }); });
  paintButton();
  if (doc) { const ready = () => { buildPrompt(); paintPrompt(); }; if (doc.body) ready(); else doc.addEventListener('DOMContentLoaded', ready, { once: true }); }
  if (opts.autoLoadMap !== false) loadMap().catch(() => {});

  function destroy() {
    S.destroyed = true; stopLowHp(); offMixer(); detach();
    if (doc) doc.removeEventListener('keydown', onKey);
    director.dispose(); panel.close();
    if (S.promptTimer) { clearInterval(S.promptTimer); S.promptTimer = null; }
    if (S.offPad) { try { S.offPad(); } catch (_e) { /* ignore */ } S.offPad = null; }
    if (doc) doc.removeEventListener('keydown', onPromptKey);
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', placePrompt);
    if (S.prompt && S.prompt.remove) S.prompt.remove();
    mixer.destroy();
  }

  const sys = {
    page, mixer, director, panel,
    setRom, playCry, testCry, openPanel, dismissPrompt, closePanel: () => panel.close(), toast,
    /** Is the sound switched on (not muted)? The hub's SOUND row and the pause menu show this. */
    audible: () => !mixer.muted(),
    setMuted: (m) => { mixer.setMuted(m); paintButton(); },
    hookScene, battleFrame, menuSfx, pressWithSfx, clickWithSfx, sceneSig,
    sig: (x) => { try { return JSON.stringify(x); } catch (_e) { return ''; } },
    get plays() { return S.plays; }, get testPlays() { return S.testPlays; },
    ctx: () => mixer.ctx(),
    state: () => ({
      page, mixer: mixer.getAudioState(), director: director.state(), panelOpen: panel.isOpen(), plays: S.plays, testPlays: S.testPlays,
      prompt: promptVisible(), promptDismissed: !!S.promptDismissed, promptWhy: S.promptWhy || null, frameError: S.frameError, rom: !!S.rom, map: !!S.map, animSounds: S.animSounds, menuSfx: S.menuSfx.slice(), lowHp: { on: S.low.on, plays: S.low.plays, stops: S.low.stops },
      uv: { state: S.uv.state, loaded: !!S.uv.bytes, failed: S.uv.failed, message: S.uv.message }, soundtrack: effectiveSoundtrack(),
    }),
    destroy,
  };
  return sys;
}
