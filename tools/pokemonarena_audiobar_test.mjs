#!/usr/bin/env node
// tools/pokemonarena_audiobar_test.mjs -- the AUDIO BAR (pokemonarena/js/audiobar.js + audiobar.css) and the MENU MUSIC CHANGER (js/menu_music.js) on the REAL pages: the hub, the battle
// page and the team editor.
//
//   node tools/pokemonarena_audiobar_test.mjs                 the cases
//   node tools/pokemonarena_audiobar_test.mjs --mutants       ALSO break the bar / the changer / the layout one way at a time on an overlay copy of the tree; every break must fail a case
//   ARENA_PORT=8177 ARENA_CDP=9363 ARENA_OVERLAY_PORT=8190 ARENA_OUT=<dir for screenshots>      (ARENA_BASE=<url> tests an already running server)
//
// NOTHING HERE CAN REACH AN AUDIO DEVICE. Chrome runs with --mute-audio (tools/headless_cdp.mjs, a throwaway profile) and window.AudioContext is the recording double of
// tools/pokemonarena_sound_lib.mjs, installed before any page script runs; the music engine and the song map are its stand-ins (window.__arenaSoundModules) except in the one
// scenario that reads the REAL music_map.js (?nostubs=1: the list of songs the changer offers, which songs are left out and why).
//
// SCENARIOS (a function each; a fresh profile per scenario)
//   unit       (Node, no browser) the changer pure half: the stored value, the songs offered, what the director is asked for
//   volume     the slider and the mute button drive the page's one mixer: keyboard arrows, the Sound panel follows and leads, mute, dragging up while muted, the M key, a reload keeps it,
//              no AudioContext before the first activation
//   identical  the bar is the same markup, the same size and the same look on the hub, the battle page and the editor, and sits where the header says it should
//   music      the changer: the songs offered (stand-in map), pick / previous / next / Automatic / Off, what the director is asked for, Esc and outside click, remembered across reloads
//              and shared by the editor, a hostile stored value repaired, a soundtrack that lacks the picked song falls back and keeps the pick (and the bar says so), the open list is a MODAL
//              dialog: no key typed in it reaches the page behind it, the hub knows a dialog is open, Tab stays inside
//   keys       WASD in the open list (hub and editor): they pick songs like the arrows, follow the player's bindings (Up moved W -> U), and never reach the page behind it
//   pad        a controller on the hub's open list (opened with the mouse): the d-pad moves, A picks, B closes and gives the focus back to the music button; the hub behind it does not move
//   off        Off means no MUSIC, not no sound: with Off stored, after a reload, the engine still loads and the hub's cursor / select / back sounds play (the engine used to stay unloaded); the team editor
//              plays no effect, so with Off (and Ultra Violet chosen) it loads no engine and fetches no ROM
//   focus      after a pointer use of the bar (mute, slider, closing the list) the focus is back on the page, so the arrows / Enter act on the game; keyboard use keeps its place
//   restore    a page restored from the back/forward cache (pageshow persisted) asks for its song again: the player's pick, Off stays Off, the battle page its battle song
//   scope      the battle page has no changer and its music still follows the battle whatever the menu pick is
//   real       the real music_map.js: no duplicate song, nothing that does not loop, the names are the player-facing table's (no developer prose), on both soundtracks
//   phone      320x568 360x640 390x844 412x915 844x390 568x320 on every page: nothing overflows, every target is 44 px, nothing overlaps, the picture still fills a phone and the touch pad
//              stays on the screen, a tap moves the slider
//   fullscreen a phone held sideways in fullscreen: the header is hidden, the bar floats beside the exit button folded to one speaker button, opens, works, folds, comes home
//   a11y       Tab order, names, states, roles; the controller / keyboard layer can reach the bar
//   prompt     the "start the sound" pill lands where it covers neither the bar nor anything else
//   states     the bar is hidden while a page loads or has failed (the editor hides its Sound button the same way)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ARENA_PORT = process.env.ARENA_PORT || '8177';
process.env.ARENA_CDP = process.env.ARENA_CDP || '9363';
const L = await import('./pokemonarena_hub_lib.mjs');
const { withBrowser } = await import('./headless_cdp.mjs');
const { AUDIO_DOUBLE_SRC, STUB_MODULES_SRC } = await import('./pokemonarena_sound_lib.mjs');
const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
const { root, BASE, sleep, J, addInit } = L;
const MMOD = await L.mod('menu_music.js');
const TN = MMOD.TRACK_NAMES;                                     // the names the changer shows (menu_music.js): written for the player, not taken from music_map.js's developer notes
const WANT_MUTANTS = process.argv.includes('--mutants');
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-audiobar-shots');
const PA = path.join(root, 'pokemonarena');
const C = L.makeCounter('audiobar');
fs.mkdirSync(OUT, { recursive: true });
let cdp = L.CDP0;
const HUB = '__arenaHub', BAT = '__arenaBattle';

const PAGES = {
  hub: { url: '/pokemonarena/', ready: `window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound` },
  battle: { url: '/pokemonarena/battle.html?cpu=easy&seed=1&format=3v3', ready: `window.${BAT} && ${BAT}.state === 'ready' && window.__arenaSound` },
  editor: { url: '/pokemonarena/editor.html', ready: `window.__editor && __editor.ready && __editor.input && window.__arenaSound` },
};
const recorder = () => { const r = []; return { r, ok: (cond, name, detail) => { r.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail).slice(0, 300) }); return !!cond; } }; };
const feed = (R) => { for (const x of R.r) C.ok(x.ok, x.name, x.detail); };
const near = (a, b, e = 0.011) => Math.abs(a - b) < e;
const gainOf = (v) => { const d = 0.7; return v <= d ? (v / d) * (v / d) : 1 + (Math.pow(10, 3 / 20) - 1) * ((v - d) / (1 - d)); };

/* ------------------------------------------------------------------------------------------------ page helpers */
async function openPage(page, base, which, { w = 1280, h = 800, mobile = false, dpr = 1, extra = '' } = {}) {
  await page.setViewport(w, h, { mobile, dpr });
  const u = PAGES[which].url + (extra ? (PAGES[which].url.includes('?') ? '&' : '?') + extra : '');
  // THE DOCUMENT MUST BE THE NEW ONE AND STAY. One run under load died with "Cannot read properties of undefined (reading 'menuMusic')": an eval had run in a document with no sound system yet. Two ways a page can
  // answer `ready` and then not be there: a navigation to the URL that is already open is answered by the OLD document until the new one commits (stamped here, so it can never count), and the hub can replace
  // itself right after reporting ready (boot.js recalledCopyFailed(): ONE reload when a recalled ROM copy fails its deferred SHA-256 re-check). So: wait for ready (sound system with its changer included), let the
  // page settle, ask again from the SAME document (performance.timeOrigin is per document); if it changed, wait again.
  try { await page.eval('window.__oldDoc = true'); } catch (_e) { /* no page yet */ }
  await page.navigate(base + u);
  const ready = `!window.__oldDoc && (${PAGES[which].ready}) && !!window.__arenaSound.menuMusic`;
  for (let i = 0; i < 4; i++) {
    await page.waitFor(ready, { timeoutMs: 90000 });
    const origin = await page.eval('performance.timeOrigin');
    await sleep(250);
    let same = false; try { same = await page.eval(`performance.timeOrigin === ${origin} && (${ready})`); } catch (_e) { same = false; }       // (an eval during a navigation throws: not settled)
    if (same) return;
  }
  throw new Error('openPage ' + which + ': the document never settled (it kept being replaced after reporting ready)');
}
async function fresh(page, base) { await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}'); }
// name -> [key, windowsVirtualKeyCode, code when it is not the key itself]. The letters are the ones the input layer maps by default: Z = A, X = B, W/S = up/down; Backspace = B; PageUp/PageDown = L/R.
const KEYMAP = { left: ['ArrowLeft', 37], right: ['ArrowRight', 39], up: ['ArrowUp', 38], down: ['ArrowDown', 40], esc: ['Escape', 27], tab: ['Tab', 9], m: ['m', 77, 'KeyM'], enter: ['Enter', 13],
  z: ['z', 90, 'KeyZ'], x: ['x', 88, 'KeyX'], w: ['w', 87, 'KeyW'], a: ['a', 65, 'KeyA'], s: ['s', 83, 'KeyS'], d: ['d', 68, 'KeyD'], u: ['u', 85, 'KeyU'], backspace: ['Backspace', 8], pagedown: ['PageDown', 34], pageup: ['PageUp', 33] };
async function key(page, name, hold = 35) {
  const [k, vk, code] = KEYMAP[name];
  const text = k.length === 1 ? k : name === 'enter' ? '\r' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await sleep(hold);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, windowsVirtualKeyCode: vk });
  await sleep(40);
}
const sound = (page) => page.eval(`window.__arenaSound.state()`);
const mixerSettings = (page) => page.eval(`window.__arenaSound.mixer.getAudioState().settings`);
const stored = (page, k) => page.eval(`localStorage.getItem(${J(k)})`);
const focusSel = (page, sel) => page.eval(`document.querySelector(${J(sel)}).focus()`);
const barInfo = (page) => page.eval(`(() => { const q = (s) => document.querySelector(s); const b = q('#audioBar'); if (!b) return null; const m = q('#abMute'), v = q('#abVolume'), mu = q('#abMusic');
  return { pending: b.hasAttribute('data-pending'), role: b.getAttribute('role'), label: b.getAttribute('aria-label'), muted: b.dataset.muted, parent: b.parentNode && (b.parentNode.id || b.parentNode.tagName),
    mute: m ? { pressed: m.getAttribute('aria-pressed'), label: m.getAttribute('aria-label'), title: m.title } : null,
    vol: v ? { value: v.value, min: v.min, max: v.max, step: v.step, label: v.getAttribute('aria-label'), text: v.getAttribute('aria-valuetext') } : null,
    music: mu ? { label: mu.getAttribute('aria-label'), expanded: mu.getAttribute('aria-expanded'), popup: mu.getAttribute('aria-haspopup'), title: mu.title } : null,
    soundBtn: (q('#soundBtn') || {}).textContent }; })()`);
const rectOf = (page, sel) => page.eval(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, vis: cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0 }; })()`);
const clickSel = L.clickSel, tapSel = L.tapSel;
const shot = async (page, name) => { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* a screenshot is evidence for the eye, not a case */ } };
// (the JSON viewer that fresh() opens asks for a favicon; the pages themselves declare none)
const errs = (page) => L.errsOf(page).filter((e) => !/favicon.ico/.test(e));
const hit = (a, b, pad = 0) => a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;

/* ------------------------------------------------------------------------------------------------ scenarios */

async function scnVolume(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub');
  const ctor0 = await page.eval('window.__snd.ctor');
  const b0 = await barInfo(page);
  // (the page tries to start the sound at load, so one context may exist; the double keeps it suspended until a real activation: what must hold is that nothing RUNS before one)
  R.ok(ctor0 <= 1 && (await page.eval('window.__snd.ctxs.every((c) => c.state !== "running")')) && b0 && !b0.pending, 'volume: the bar is on the page and nothing is running before the first activation (the context tried at load is suspended)', J({ ctor0, b0 }));
  R.ok(b0.role === 'group' && b0.label === 'Sound' && b0.vol.value === '50' && b0.vol.text === '50 percent' && b0.vol.label === 'Volume' && b0.vol.min === '0' && b0.vol.max === '100' && b0.vol.step === '5' && b0.mute.pressed === 'false' && b0.muted === 'false', 'volume: the starting volume is 50 percent (half the slider), named and bounded for assistive technology, not muted', J(b0));
  // keyboard on the slider: an arrow is 5 percent, it moves the page's ONE mixer, the stored setting, and (this is a key press) it counts as the first activation
  await focusSel(page, '#abVolume'); await key(page, 'left');
  let s = await mixerSettings(page);
  const b1 = await barInfo(page);
  R.ok(b1.vol.value === '45' && b1.vol.text === '45 percent' && near(s.master, 0.45, 1e-9), 'volume: ArrowLeft on the slider is -5 percent and moves the mixer\'s master volume', J({ v: b1.vol, master: s.master }));
  R.ok(J(JSON.parse(await stored(page, 'arena.audio')).master) === '0.45', 'volume: ... and the stored setting (arena.audio) that the Sound panel reads too', await stored(page, 'arena.audio'));
  const st1 = await sound(page);
  R.ok(st1.mixer.created === true && near((await page.eval('window.__snd.gains[0].gain.target')), gainOf(0.45), 1e-6), 'volume: the key press was the activation (the context now runs) and the master gain is the mixer\'s law for 45 percent', J(await page.eval('window.__snd.gains.slice(0,1).map((g) => g.gain.target)')));
  // the Sound panel follows the bar, and the bar follows the panel
  await page.eval('window.__arenaSound.openPanel()'); await sleep(250);
  const pv = await page.eval(`Number(document.querySelector('[data-snd="slider-master"]').value)`);
  R.ok(pv === 45, 'volume: the Sound panel\'s Master slider shows the bar\'s 45', String(pv));
  await page.eval(`(() => { const r = document.querySelector('[data-snd="slider-master"]'); r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(150);
  R.ok((await barInfo(page)).vol.value === '40', 'volume: moving the panel\'s slider moves the bar', J((await barInfo(page)).vol));
  await page.eval('window.__arenaSound.closePanel()'); await sleep(250);
  // mute with a click
  await clickSel(page, '#abMute'); await sleep(150);
  const b2 = await barInfo(page); s = await mixerSettings(page);
  R.ok(s.muted === true && b2.muted === 'true' && b2.mute.pressed === 'true' && b2.soundBtn === 'Sound: off', 'volume: the mute button mutes the mixer, shows it, and the header\'s Sound button says "Sound: off"', J({ muted: s.muted, bar: b2.muted, btn: b2.soundBtn }));
  R.ok(JSON.parse(await stored(page, 'arena.audio')).muted === true && b2.vol.value === '40', 'volume: muting is stored and the slider keeps its place (mute is not volume 0)', await stored(page, 'arena.audio'));
  // dragging the volume up while muted brings the sound back
  await focusSel(page, '#abVolume'); await key(page, 'right');
  s = await mixerSettings(page);
  R.ok(s.muted === false && near(s.master, 0.45, 1e-9) && (await barInfo(page)).muted === 'false', 'volume: moving the slider up while muted unmutes (and sets the new level)', J(s));
  // the M key follows
  await page.eval('document.activeElement && document.activeElement.blur()'); await key(page, 'm'); await sleep(120);
  R.ok((await mixerSettings(page)).muted === true && (await barInfo(page)).muted === 'true', 'volume: the M key mutes and the bar shows it', J(await barInfo(page)));
  await clickSel(page, '#abMute'); await sleep(120);
  R.ok((await mixerSettings(page)).muted === false && (await barInfo(page)).mute.pressed === 'false', 'volume: the mute button unmutes', '');
  // another tab (a storage event) moves the bar
  await page.eval(`(() => { const o = JSON.parse(localStorage.getItem('arena.audio')); o.master = 0.2; localStorage.setItem('arena.audio', JSON.stringify(o)); window.dispatchEvent(new StorageEvent('storage', { key: 'arena.audio', newValue: JSON.stringify(o) })); })()`); await sleep(150);
  R.ok((await barInfo(page)).vol.value === '20', 'volume: a change made in another tab moves the bar', J((await barInfo(page)).vol));
  // a reload keeps it
  await page.eval(`(() => { const o = JSON.parse(localStorage.getItem('arena.audio')); o.master = 0.55; localStorage.setItem('arena.audio', JSON.stringify(o)); })()`);
  await openPage(page, base, 'hub');
  R.ok((await barInfo(page)).vol.value === '55' && (await page.eval('window.__snd.ctxs.every((c) => c.state !== "running")')), 'volume: after a reload the slider shows the stored level, and still nothing runs before an activation', J((await barInfo(page)).vol));
  R.ok(!(errs(page).length), 'volume: no page errors', J(errs(page)).slice(0, 200));
}

async function scnIdentical(page, R, base) {
  await fresh(page, base);
  const probe = `(() => { const q = (s) => document.querySelector(s); const b = q('#audioBar'), top = q('#top'); const tr = top.getBoundingClientRect(), br = b.getBoundingClientRect();
    const rc = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const cs = (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderTopLeftRadius, c.borderTopWidth, c.borderTopColor, c.fontFamily].join('|'); };
    return { mute: q('#abMute').outerHTML, vol: q('#abVolume').outerHTML, out: q('.ab-val').outerHTML, muteBox: rc(q('#abMute')), volBox: rc(q('#abVolume')), muteCss: cs(q('#abMute')), parent: b.parentNode.id, page: b.dataset.page,
      music: !!q('#abMusic'), musicBox: q('#abMusic') ? rc(q('#abMusic')) : null, centreOff: Math.round((br.top + br.height / 2) - (tr.top + tr.height / 2)), inside: br.left >= tr.left - 1 && br.right <= tr.right + 1 }; })()`;
  for (const vp of [{ w: 1280, h: 800, mobile: false, dpr: 1, name: 'desktop' }, { w: 390, h: 844, mobile: true, dpr: 3, name: 'phone' }]) {
    const got = {};
    for (const p of ['hub', 'battle', 'editor']) { await openPage(page, base, p, vp); got[p] = await page.eval(probe); if (vp.name === 'desktop' || p === 'hub') await shot(page, 'bar_' + p + '_' + vp.name); }
    const t = vp.name + ': ';
    R.ok(got.hub.mute === got.battle.mute && got.hub.mute === got.editor.mute && got.hub.vol === got.battle.vol && got.hub.vol === got.editor.vol && got.hub.out === got.battle.out, 'identical: ' + t + 'the mute button, the slider and the readout are the same markup on the hub, the battle page and the editor', J([got.hub.mute.slice(0, 120)]));
    R.ok(J(got.hub.muteBox) === J(got.battle.muteBox) && J(got.hub.muteBox) === J(got.editor.muteBox) && J(got.hub.muteBox) === '[44,44]', 'identical: ' + t + 'the mute button is 44 x 44 everywhere', J([got.hub.muteBox, got.battle.muteBox, got.editor.muteBox]));
    R.ok(got.hub.muteCss === got.battle.muteCss && got.hub.muteCss === got.editor.muteCss, 'identical: ' + t + 'the same look (colour, background, corner, border, font) on all three pages', J([got.hub.muteCss, got.battle.muteCss, got.editor.muteCss]));
    if (vp.name === 'desktop') {
      R.ok(J(got.hub.volBox) === J(got.battle.volBox) && J(got.hub.volBox) === J(got.editor.volBox) && J(got.hub.volBox) === '[100,44]', 'identical: desktop: the slider is 100 x 44 everywhere', J([got.hub.volBox, got.battle.volBox, got.editor.volBox]));
      R.ok(Math.abs(got.hub.centreOff) <= 3 && Math.abs(got.battle.centreOff) <= 3 && Math.abs(got.editor.centreOff) <= 3 && got.hub.parent === 'top' && got.battle.parent === 'top' && got.editor.parent === 'top', 'identical: desktop: it sits in the header, vertically centred in it, on every page', J([got.hub.centreOff, got.battle.centreOff, got.editor.centreOff]));
    } else {
      R.ok(J(got.hub.volBox) === J(got.editor.volBox) && got.hub.volBox[0] >= 100, 'identical: phone: the hub and the editor give it the same row and the same width', J([got.hub.volBox, got.editor.volBox]));
      R.ok(got.battle.volBox[0] >= 64 && got.battle.volBox[0] <= 110 && got.battle.parent === 'top', 'identical: phone: the battle page keeps it in its header\'s first row with a 64 to 110 px slider', J(got.battle.volBox));
    }
    R.ok(got.hub.music && got.editor.music && !got.battle.music && J(got.hub.musicBox) === J(got.editor.musicBox), 'identical: ' + t + 'the music changer is on the two menu pages (the same button) and not on the battle page', J([got.hub.music, got.editor.music, got.battle.music]));
    R.ok(got.hub.inside && got.battle.inside && got.editor.inside, 'identical: ' + t + 'the bar is inside its header on every page', J([got.hub.inside, got.battle.inside, got.editor.inside]));
  }
}

const SG_KEYS = ['hub', 'editor', 'preview', 'result_win', 'result_lose', 'victory', 'battle_easy', 'battle_normal', 'battle_hard'];     // what the stand-in soulgold map loops, in the changer's order
const dirWant = (page) => page.eval(`(() => { const d = window.__arenaSound.state().director; return d.want ? d.want.key : null; })()`);
const lastPlay = (page) => page.eval(`(() => { const p = window.__sndMusic.play; return p.length ? p[p.length - 1].index : null; })()`);
const mmState = (page) => page.eval(`(() => { const s = window.__arenaSound.menuMusic.state(); return { pick: s.pick, screen: s.screen, effective: s.effective, keys: s.options.map((o) => o.key) }; })()`);
const menuInfo = (page) => page.eval(`(() => { const m = document.getElementById('abMenu'); if (!m) return null; const r = Array.from(m.querySelectorAll('[role="radio"]')); return { hidden: m.hidden, role: m.getAttribute('role'), label: m.getAttribute('aria-label'), n: r.length, checked: r.filter((x) => x.getAttribute('aria-checked') === 'true').map((x) => x.dataset.pick), picks: r.map((x) => x.dataset.pick), now: m.querySelector('.ab-now').textContent, hint: m.querySelector('.ab-hint').textContent }; })()`);

async function scnMusic(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub');
  let m = await mmState(page);
  R.ok(m.pick === 'auto' && m.screen === 'hub' && m.effective === 'hub' && J(m.keys) === J(SG_KEYS), 'music: by default the menus play their own song, and the changer offers the looping background songs of the soundtrack, each once, in order', J(m));
  R.ok((await dirWant(page)) === 'hub', 'music: the hub asks the director for "hub"', J(await dirWant(page)));
  // BEFORE the song table has loaded a stored pick is already NAMED (the bar used to show the raw key "battle_hard" until music_map.js arrived). Built in the page, from the page's own module (so a
  // mutant of that module is the one that runs), with no song table at all.
  { const pre = await page.eval(`(async () => { const M = await import('/pokemonarena/js/menu_music.js'); const store = { getItem(k) { return k === 'arena.menumusic' ? '{"v":1,"pick":"battle_hard"}' : null; }, setItem() {} };
      const mm = M.createMenuMusic({ director: { set() {}, stop() {} }, mixer: null, storage: store, getMap: () => null, soundtrack: () => 'soulgold', window: null }); mm.set('hub'); const s = mm.state(); return { pick: s.pick, name: s.pickName, missing: s.missing, eff: s.effective }; })()`);
    R.ok(pre.pick === 'battle_hard' && pre.name === TN.battle_hard && pre.missing === false && pre.eff === 'battle_hard', 'music: before the song table has loaded a stored pick is named from the table, not shown as its raw key, and is not reported missing', J(pre)); }
  R.ok((await barInfo(page)).music.popup === 'dialog' && (await barInfo(page)).music.expanded === 'false' && (await barInfo(page)).music.label === 'Menu music: Automatic', 'music: the button says what is picked and that it opens a list', J((await barInfo(page)).music));
  await clickSel(page, '#abMusic'); await sleep(250);
  let mi = await menuInfo(page);
  R.ok(mi && !mi.hidden && mi.role === 'dialog' && mi.label === 'Menu music' && mi.n === SG_KEYS.length + 2 && J(mi.checked) === '["auto"]' && mi.picks[0] === 'auto' && mi.picks[mi.n - 1] === 'off' && (await barInfo(page)).music.expanded === 'true', 'music: the button opens the list: Automatic, every song, Off; Automatic is checked', J(mi));
  const mr = await rectOf(page, '#abMenu'), vw = await page.eval('innerWidth'), vh = await page.eval('innerHeight');
  R.ok(mr && mr.l >= 0 && mr.r <= vw && mr.t >= 0 && mr.b <= vh, 'music: the list is on the screen', J(mr));
  await shot(page, 'music_menu_desktop');
  // the first activation just happened (a click): the context exists and the hub song is playing
  R.ok((await sound(page)).mixer.created === true && (await lastPlay(page)) === 10, 'music: the click that opened the list started the sound; the hub song (10) plays', J(await lastPlay(page)));
  // pick a song
  await clickSel(page, '#abMenu [data-pick="battle_easy"]'); await sleep(250);
  m = await mmState(page);
  R.ok(m.pick === 'battle_easy' && m.effective === 'battle_easy' && (await dirWant(page)) === 'battle_easy' && (await lastPlay(page)) === 20, 'music: picking a song asks the director for it and the engine plays that song (20)', J({ m, want: await dirWant(page), play: await lastPlay(page) }));
  R.ok(JSON.stringify(JSON.parse(await stored(page, 'arena.menumusic'))) === '{"v":1,"pick":"battle_easy"}', 'music: the pick is stored, versioned', await stored(page, 'arena.menumusic'));
  R.ok((await barInfo(page)).music.label === 'Menu music: ' + TN.battle_easy && (await menuInfo(page)).now === TN.battle_easy && J((await menuInfo(page)).checked) === '["battle_easy"]', 'music: the button and the list say which song is picked, by its player-facing name', J(await menuInfo(page)));
  // arrows in the list pick (a radio group) and do not leak into the page behind
  const hubCursor0 = await page.eval(`window.${HUB}.view().menu ? window.${HUB}.view().menu.cursor : null`);
  await focusSel(page, '#abMenu [data-pick="battle_easy"]'); await key(page, 'down'); await sleep(200);
  R.ok((await mmState(page)).pick === 'battle_normal' && (await lastPlay(page)) === 21 && (await page.eval('document.activeElement.dataset.pick')) === 'battle_normal', 'music: ArrowDown in the list picks the next song and moves focus to it', J(await mmState(page)));
  R.ok((await page.eval(`window.${HUB}.view().menu ? window.${HUB}.view().menu.cursor : null`)) === hubCursor0, 'music: and the arrow did not move the hub menu behind the list', J([hubCursor0]));
  // THE LIST IS A MODAL DIALOG. Z (A), X / Backspace (B), W / S (up / down) and PageUp / PageDown (L / R) typed in it used to reach the input layer and drive the hub behind it. A listener on the window
  // (bubble phase, where input.js sits) must never see them, the hub must not have moved or navigated, and it must KNOW a dialog is open (a controller press has no key event: boot.js dialog counter).
  await page.eval(`(() => { window.__seen = []; window.addEventListener('keydown', (e) => { window.__seen.push(e.code); }); })()`);
  const hubSig0 = await page.eval(`JSON.stringify(window.${HUB}.model.state())`);
  R.ok((await page.eval(`document.getElementById('abMenu').getAttribute('aria-modal')`)) === 'true' && (await page.eval(`window.${HUB}.dialogOpen()`)) === true, 'music: the open list is a modal dialog (aria-modal) and the hub knows a dialog is open (its own key and pad presses are ignored)', J(await page.eval(`[document.getElementById('abMenu').getAttribute('aria-modal'), window.${HUB}.dialogOpen()]`)));
  await focusSel(page, '#abMenu [data-pick="battle_normal"]');
  for (const k of ['down', 'up', 'right', 'left', 'z', 'x', 'backspace', 'w', 's', 'pagedown', 'pageup']) await key(page, k);
  R.ok(J(await page.eval('window.__seen')) === '[]', 'music: the arrows (they pick songs), Z, X, Backspace, W, S, PageDown and PageUp typed in the list never reach the page behind it (nothing on the window sees them)', J(await page.eval('window.__seen')));
  R.ok((await page.eval(`JSON.stringify(window.${HUB}.model.state())`)) === hubSig0 && !(await page.eval(`!!window.${HUB}.navigated`)), 'music: ... and the hub did not move, open a screen or navigate', hubSig0);
  // Tab stays inside the dialog; a click on its plain text keeps the focus inside it too
  for (let i = 0; i < 14; i++) await key(page, 'tab', 15);
  R.ok(await page.eval(`document.getElementById('abMenu').contains(document.activeElement)`), 'music: Tab cycles inside the open list (it never walks out into the page behind it)', await page.eval('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
  await clickSel(page, '#abMenu .ab-now'); await sleep(100);
  R.ok(await page.eval(`document.getElementById('abMenu').contains(document.activeElement)`), 'music: a click on the list\'s plain text leaves the focus inside the dialog', await page.eval('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
  await focusSel(page, '#abMenu [data-pick="battle_normal"]');
  // Off
  const stops0 = (await page.eval('window.__sndMusic.stop.length'));
  await clickSel(page, '#abMenu [data-pick="off"]'); await sleep(250);
  m = await mmState(page);
  R.ok(m.pick === 'off' && m.effective === null && (await dirWant(page)) === null && (await page.eval('window.__sndMusic.stop.length')) > stops0, 'music: Off silences the menus (the director is told to stop)', J({ m, want: await dirWant(page) }));
  R.ok((await barInfo(page)).music.label === 'Menu music: Off', 'music: and the button says Off', J((await barInfo(page)).music));
  // Automatic comes back to the screen's own
  await clickSel(page, '#abMenu [data-pick="auto"]'); await sleep(250);
  R.ok((await mmState(page)).effective === 'hub' && (await dirWant(page)) === 'hub' && (await lastPlay(page)) === 10, 'music: Automatic puts the hub\'s own song back', J(await mmState(page)));
  // previous / next
  await clickSel(page, '#abMenu .ab-step[data-dir="1"]'); await sleep(150);
  const n1 = (await mmState(page)).pick;
  await clickSel(page, '#abMenu .ab-step[data-dir="1"]'); await sleep(150);
  const n2 = (await mmState(page)).pick;
  await clickSel(page, '#abMenu .ab-step[data-dir="-1"]'); await sleep(150);
  const n3 = (await mmState(page)).pick;
  R.ok(n1 === 'hub' && n2 === 'editor' && n3 === 'hub', 'music: next steps Automatic > hub > editor, previous steps back', J([n1, n2, n3]));
  await clickSel(page, '#abMenu .ab-step[data-dir="-1"]'); await sleep(100);
  await clickSel(page, '#abMenu .ab-step[data-dir="-1"]'); await sleep(100);
  R.ok((await mmState(page)).pick === 'off', 'music: previous from Automatic wraps round to Off', J(await mmState(page)));
  // a menu choice with the sound muted says so
  await clickSel(page, '#abMenu [data-pick="auto"]'); await sleep(100);
  await page.eval('window.__arenaSound.mixer.setMuted(true)'); await sleep(150);
  R.ok(/muted/i.test((await menuInfo(page)).hint), 'music: with the sound muted the list says so (a pick is heard after unmuting)', J(await menuInfo(page)));
  await page.eval('window.__arenaSound.mixer.setMuted(false)'); await sleep(100);
  // Esc closes, focus goes back to the button; an outside press closes
  await key(page, 'esc'); await sleep(150);
  R.ok((await menuInfo(page)).hidden === true && (await page.eval('document.activeElement && document.activeElement.id')) === 'abMusic' && (await barInfo(page)).music.expanded === 'false', 'music: Esc closes the list and gives the focus back to the button', J(await menuInfo(page)));
  R.ok((await page.eval(`window.${HUB}.dialogOpen()`)) === false, 'music: ... and the hub is told the dialog is gone', '');
  { const c1 = await page.eval(`window.${HUB}.model.state().cursor.main`); await key(page, 's'); await sleep(150);
    R.ok((await page.eval(`window.${HUB}.model.state().cursor.main`)) !== c1, 'music: once the list is closed the hub takes its keys again (S = down moves the cursor even with the focus still on the music button)', J([c1, await page.eval(`window.${HUB}.model.state().cursor.main`)])); }
  await clickSel(page, '#abMusic'); await sleep(200);
  await page.click(30, 700); await sleep(200);
  R.ok((await menuInfo(page)).hidden === true, 'music: a press outside the list closes it', '');
  // a choice that is not on offer is refused; the stored pick is untouched
  const refused = await page.eval(`(() => { const r = window.__arenaSound.menuMusic.choose('battle_legendary'); return { r, pick: window.__arenaSound.menuMusic.pick() }; })()`);
  R.ok(refused.r === false && refused.pick === (await mmState(page)).pick, 'music: a song the soundtrack does not offer cannot be picked', J(refused));
  // remembered across a reload, and the editor (a menu page too) plays the same pick
  await clickSel(page, '#abMusic'); await sleep(150); await clickSel(page, '#abMenu [data-pick="battle_hard"]'); await sleep(200);
  await openPage(page, base, 'hub');
  m = await mmState(page);
  R.ok(m.pick === 'battle_hard' && m.effective === 'battle_hard' && (await dirWant(page)) === 'battle_hard', 'music: after a reload the hub asks for the picked song at once', J({ m, want: await dirWant(page) }));
  await openPage(page, base, 'editor');
  m = await mmState(page);
  R.ok(m.pick === 'battle_hard' && m.screen === 'editor' && m.effective === 'battle_hard' && (await dirWant(page)) === 'battle_hard', 'music: the team editor shares the pick', J({ m, want: await dirWant(page) }));
  R.ok((await barInfo(page)).music.label === 'Menu music: ' + TN.battle_hard, 'music: and its button says so', J((await barInfo(page)).music));
  // a soundtrack that lacks the picked song: the screen's own plays, the pick is kept
  await openPage(page, base, 'hub');
  await page.eval(`window.__arenaSound.mixer.setSoundtrack('ultraviolet')`); await sleep(500);
  m = await mmState(page);
  R.ok(m.pick === 'battle_hard' && m.effective === 'hub' && J(m.keys) === J(['hub', 'result_win', 'battle_easy', 'battle_normal']), 'music: on a soundtrack without the picked song the hub\'s own song plays, the pick is kept, and only songs it has are offered', J(m));
  // ... and the bar SAYS so: the screen's own song is what plays, so Automatic is the entry that is checked and the pick is named, not shown as a raw key with nothing checked
  { await clickSel(page, '#abMusic'); await sleep(250);
    const bi = await barInfo(page), mi2 = await menuInfo(page);
    R.ok(bi.music.label === 'Menu music: Automatic (' + TN.battle_hard + ' is not on this soundtrack)' && mi2.now === 'Automatic (' + TN.battle_hard + ' is not on this soundtrack)', 'music: a stored pick the soundtrack lacks is shown by name as "Automatic (... is not on this soundtrack)", never as the raw key', J({ label: bi.music.label, now: mi2.now }));
    R.ok(J(mi2.checked) === '["auto"]' && /not on this soundtrack/.test(mi2.hint) && !/battle_hard/.test(bi.music.label + mi2.now), 'music: ... Automatic is the checked entry and the hint says why', J(mi2));
    await key(page, 'esc'); await sleep(100); }
  await page.eval(`window.__arenaSound.mixer.setSoundtrack('soulgold')`); await sleep(400);
  R.ok((await mmState(page)).effective === 'battle_hard', 'music: back on the first soundtrack the pick plays again', J(await mmState(page)));
  R.ok((await barInfo(page)).music.label === 'Menu music: ' + TN.battle_hard, 'music: ... and the button names it again', J((await barInfo(page)).music));
  // a hostile stored value is repaired
  await page.eval(`localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: '<img src=x onerror=window.__pwned=1>' }))`);
  await openPage(page, base, 'hub');
  R.ok((await mmState(page)).pick === 'auto' && (await stored(page, 'arena.menumusic')) === '{"v":1,"pick":"auto"}' && !(await page.eval('!!window.__pwned')), 'music: a hostile stored pick is repaired to Automatic (and rewritten), and nothing in it runs', await stored(page, 'arena.menumusic'));
  await page.eval(`localStorage.setItem('arena.menumusic', '{not json')`);
  await openPage(page, base, 'hub');
  R.ok((await mmState(page)).pick === 'auto', 'music: a stored value that is not JSON is Automatic', '');
  R.ok(!(errs(page).length), 'music: no page errors', J(errs(page)).slice(0, 200));
}

// WASD IN THE OPEN LIST. "arrows or WASD move" is the game's key promise (INPUT.md default table), so inside the list W A S D pick songs exactly like the arrows -- on the hub AND on the team editor, where the
// d-pad is the page's own layer (uinav.js) -- and, like every key typed in the list, never reach the page behind it. They are the keys the PLAYER'S bindings give the d-pad, not hard-coded letters: with
// Up moved from W to U in the stored bindings, U moves up and W does nothing.
async function scnKeys(page, R, base) {
  await fresh(page, base);
  const seen = async () => page.eval('window.__seen');
  const watch = (p) => page.eval(`(() => { window.__seen = []; window.addEventListener('keydown', (e) => { window.__seen.push(e.code); }); })()`);
  const at = (p) => page.eval(`document.activeElement.dataset.pick + '/' + window.__arenaSound.menuMusic.pick()`);
  for (const p of ['hub', 'editor']) {
    const tag = p + ': ';
    await openPage(page, base, p);
    await clickSel(page, '#abMusic'); await sleep(250);
    await watch(p);
    await focusSel(page, '#abMenu [data-pick="battle_normal"]'); await page.eval(`window.__arenaSound.menuMusic.choose('battle_normal')`);
    const route0 = p === 'editor' ? await page.eval('JSON.stringify(__editor.route())') : await page.eval(`JSON.stringify(window.${HUB}.model.state())`);
    const got = [];
    for (const k of ['s', 'd', 'w', 'a']) { await key(page, k); await sleep(120); got.push(await at(page)); }
    R.ok(J(got) === '["battle_hard/battle_hard","off/off","battle_hard/battle_hard","battle_normal/battle_normal"]', 'keys: ' + tag + 'S and D pick the next song, W and A the previous one, like the arrows (WASD move, as everywhere in the game)', J(got));
    R.ok(J(await seen()) === '[]', 'keys: ' + tag + '... and no WASD key reaches the page behind the list', J(await seen()));
    const route1 = p === 'editor' ? await page.eval('JSON.stringify(__editor.route())') : await page.eval(`JSON.stringify(window.${HUB}.model.state())`);
    R.ok(route0 === route1 && (await menuInfo(page)).hidden === false, 'keys: ' + tag + '... the page behind it did not move and the list is still open', J([route0, route1]));
    await key(page, 'esc'); await sleep(150);
    R.ok((await menuInfo(page)).hidden === true, 'keys: ' + tag + 'Esc still closes it', '');
  }
  // the keys are the player's bindings: Up moved from W to U
  await fresh(page, base);
  await page.eval(`localStorage.setItem('arena.bindings', JSON.stringify({ v: 1, keyboard: { up: ['ArrowUp', 'KeyU'] }, gamepad: { layout: 'auto', buttons: {} } }))`);
  await openPage(page, base, 'hub');
  R.ok(J(await page.eval(`window.__arenaSound.keyDirection ? ['KeyU', 'KeyW', 'KeyS'].map((c) => window.__arenaSound.keyDirection({ code: c })) : null`)) === '["up",null,"down"]', 'keys: with Up rebound from W to U the sound system says U is up, W is nothing, S is still down', J(await page.eval(`['KeyU', 'KeyW', 'KeyS'].map((c) => window.__arenaSound.keyDirection({ code: c }))`)));
  await clickSel(page, '#abMusic'); await sleep(250); await watch('hub');
  await focusSel(page, '#abMenu [data-pick="battle_normal"]'); await page.eval(`window.__arenaSound.menuMusic.choose('battle_normal')`);
  const rb = [];
  for (const k of ['w', 'u', 's']) { await key(page, k); await sleep(120); rb.push(await at(page)); }
  R.ok(J(rb) === '["battle_normal/battle_normal","battle_easy/battle_easy","battle_normal/battle_normal"]', 'keys: with Up moved from W to U, W does nothing in the list, U picks the previous song and S still the next', J(rb));
  R.ok(J(await seen()) === '[]', 'keys: ... and none of those keys reaches the page behind it', J(await seen()));
  R.ok(!(errs(page).length), 'keys: no page errors', J(errs(page)).slice(0, 200));
}

// A CONTROLLER AND THE HUB'S OPEN LIST. The hub ignores the pad while a dialog is up (its dialog counter), and it has no controller route to the music button, so a player who opened the list with the mouse
// and then picked up the pad had no way out but Esc or a click. The list now gets a navigation layer of its own on the hub: the d-pad moves through it, A picks the focused song, B closes it and gives the
// focus back to the music button; the hub behind it is untouched, and takes the pad again once the list is closed. (Xbox standard layout: d-pad down 13, up 12, A 0, B 1.)
async function scnPad(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub');
  await page.eval(L.PAD_DOUBLE);                                              // a connected Xbox pad (the scan finds it once the page has seen a user action)
  const hubSig = () => page.eval(`JSON.stringify(window.${HUB}.model.state())`);
  const act = () => page.eval(`(() => { const a = document.activeElement; return a ? (a.dataset && a.dataset.pick ? 'pick:' + a.dataset.pick : a.id || a.tagName) : null; })()`);
  await clickSel(page, '#abMusic'); await sleep(300);                         // the mouse opens the list: its click is also the user action that arms the pad scan
  R.ok(!(await menuInfo(page)).hidden && (await act()) === 'pick:auto' && (await page.eval(`window.${HUB}.dialogOpen()`)) === true, 'pad: the list is open (mouse), Automatic has the focus, the hub knows a dialog is up', await act());
  const s0 = await hubSig();
  await L.padPress(page, 13); await sleep(200);
  R.ok((await act()) === 'pick:hub', 'pad: the d-pad moves the focus down the list (Automatic > Pokemon Center)', await act());
  R.ok((await mmState(page)).pick === 'auto', 'pad: ... moving does not pick (the pick is still Automatic)', J(await mmState(page)));
  R.ok((await hubSig()) === s0, 'pad: ... and the hub behind the list did not move', '');
  await L.padPress(page, 13); await sleep(150); await L.padPress(page, 12); await sleep(150);
  R.ok((await act()) === 'pick:hub', 'pad: down then up comes back to the same song (one step per press)', await act());
  await L.padPress(page, 0); await sleep(250);
  R.ok((await mmState(page)).pick === 'hub' && JSON.stringify(JSON.parse(await stored(page, 'arena.menumusic'))) === '{"v":1,"pick":"hub"}' && (await dirWant(page)) === 'hub', 'pad: A picks the focused song (and it is stored)', J(await mmState(page)));
  R.ok((await hubSig()) === s0 && !(await menuInfo(page)).hidden, 'pad: ... the hub still did not move and the list is still open', '');
  await L.padPress(page, 1); await sleep(300);
  R.ok((await menuInfo(page)).hidden === true && (await act()) === 'abMusic' && (await barInfo(page)).music.expanded === 'false', 'pad: B closes the list and gives the focus back to the music button', J({ hidden: (await menuInfo(page)).hidden, act: await act() }));
  R.ok((await page.eval(`window.${HUB}.dialogOpen()`)) === false && (await hubSig()) === s0, 'pad: ... the hub is told the dialog is gone, and that B did not also act on the hub (no "press B again to leave")', '');
  // the pad belongs to the hub again, one step per press (the list's own layer is gone)
  const c1 = await page.eval(`window.${HUB}.model.state().cursor.main`);
  await page.eval(`document.activeElement && document.activeElement.blur()`);
  await L.padPress(page, 13); await sleep(200);
  R.ok((await page.eval(`window.${HUB}.model.state().cursor.main`)) === c1 + 1 && (await act()) !== 'pick:hub', 'pad: once the list is closed the hub takes the pad again (Down moves its cursor by exactly one)', J([c1, await page.eval(`window.${HUB}.model.state().cursor.main`)]));
  // opened a second time it gets a fresh layer: no double step
  await clickSel(page, '#abMusic'); await sleep(300);
  const a0 = await act(); await L.padPress(page, 13); await sleep(200);
  R.ok(a0 === 'pick:hub' && (await act()) === 'pick:editor', 'pad: opened a second time the list answers the pad with one step per press', J([a0, await act()]));
  await key(page, 'esc'); await sleep(150);
  R.ok((await menuInfo(page)).hidden === true, 'pad: Esc still closes it', '');
  R.ok(!(errs(page).length), 'pad: no page errors', J(errs(page)).slice(0, 200));
}

async function scnScope(page, R, base) {
  await fresh(page, base);
  await page.navigate(base + '/pokemonarena/manifest.json');
  await page.eval(`localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: 'victory' }))`);
  await openPage(page, base, 'battle');
  await sleep(600);
  const r = await page.eval(`(() => { const d = window.__arenaSound.state().director; return { keys: d.log.filter((x) => x.op === 'want').map((x) => x.key), music: !!document.getElementById('abMusic'), screen: window.__arenaSound.menuMusic.screen(), bar: !!document.getElementById('audioBar') && !document.getElementById('audioBar').hasAttribute('data-pending') }; })()`);
  R.ok(r.bar && !r.music, 'scope: the battle page has the volume bar and no music changer', J(r));
  // (UPDATED: the team preview now plays the CPU level's battle song, the classic start; cpu=easy asks for battle_easy first)
  R.ok(r.screen === null && r.keys[0] === 'battle_easy' && !r.keys.includes('preview') && !r.keys.includes('victory'), 'scope: the battle page still picks its music by the battle (the CPU level\'s battle song from the team preview on) whatever the menu pick is', J(r));
}

async function scnReal(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub', { extra: 'nostubs=1' });
  await page.waitFor(`window.__arenaSound.menuMusic.options().length > 5`, { timeoutMs: 30000 });
  const o = await page.eval(`window.__arenaSound.menuMusic.options()`);
  const map = await L.mod('music_map.js');
  const keys = o.map((x) => x.key);
  R.ok(keys.includes('hub') && keys.includes('editor') && keys.includes('preview') && keys.includes('battle_easy'), 'real: the real song list offers the hub, editor, preview and battle songs', J(keys));
  R.ok(!keys.includes('pokecenter') && !keys.includes('lab') && !keys.includes('result_win'), 'real: a song the ROM shares between two keys is offered once (pokecenter is the hub\'s song, lab the editor\'s, result_win the hall of fame\'s)', J(keys));
  R.ok(!keys.includes('title') && !keys.includes('credits') && !keys.some((k) => /sting|defeat|^se_/.test(k)), 'real: nothing that does not loop is offered (the title song and the credits end; fanfares and sound effects are not music)', J(keys));
  const idx = o.map((x) => x.index);
  R.ok(new Set(idx).size === idx.length, 'real: no two entries are the same song', J(idx));
  const checks = o.map((x) => { const r = map.songFor('soulgold', x.key); return r && r.index === x.index && r.loops === true && r.jingle === false; });
  R.ok(checks.every(Boolean), 'real: every offered song is one music_map.js says loops and is background music', J(o.filter((x, i) => !checks[i]).map((x) => x.key)));
  // THE NAMES ARE FOR THE PLAYER. They used to be music_map.js's `doc` strings, which are developer notes ("loops in the ROM; it is a BGM, not a fanfare", "CPU level easy: wild-battle style theme").
  // The ROM's label still rides along as data (a table entry such as "MUS-POKE-CENTER (loops, calm, 9 tracks)"), but it is not what the list shows.
  const prose = /[()]|;|\bloops?\b|\bROM\b|\bBGM\b|fanfare|\bCPU\b|\bclass(es)?\b|\bMUS\b|\d{3}|\bhack\b|twin of|\bstyle\b/i;
  R.ok(o.every((x) => x.name === TN[x.key] && x.label === map.MAP[x.key].soulgold.label), 'real: every entry is called by its name in the player-facing table, and the ROM\'s label for the song rides along as data', J(o.slice(0, 3)));
  R.ok(o.every((x) => /^[\x20-\x7e]{3,30}$/.test(x.name) && !prose.test(x.name) && x.name !== map.MAP[x.key].doc.trim().replace(/^./, (c) => c.toUpperCase())), 'real: and no name is developer prose (no brackets, "loops", "ROM", "BGM", "fanfare", song numbers; short, plain ASCII) or a copy of the map\'s own `doc` note', J(o.filter((x) => prose.test(x.name)).map((x) => x.name)));
  R.ok(o.find((x) => x.key === 'hub').name === 'Pokemon Center' && o.find((x) => x.key === 'victory').name === 'Victory: trainer battle', 'real: the hub\'s song is called "Pokemon Center", the trainer victory song "Victory: trainer battle"', J([o.find((x) => x.key === 'hub').name, o.find((x) => x.key === 'victory').name]));
  // the same for the other soundtrack, straight from the real map
  const uv = MMOD.trackOptions(map, 'ultraviolet');
  R.ok(uv.length >= 10 && uv.every((x) => x.name === TN[x.key] && !prose.test(x.name)), 'real: Ultra Violet\'s entries use the same names (the kind of song is the same, the song behind it differs)', J(uv.slice(0, 3)));
  // a pick the page keeps for a song the first soundtrack has and the second lacks (the rival theme): its NAME is known before and without the song table
  R.ok(MMOD.nameOf(null, 'battle_rival') === 'Battle: rival' && MMOD.nameOf(null, 'no_such_key') === 'No such key' && Object.keys(TN).every((k) => !prose.test(TN[k])), 'real: nameOf knows the names without the map, and spells out a key it has no name for', MMOD.nameOf(null, 'no_such_key'));
}

const VPS = [
  { w: 320, h: 568, dpr: 2, phone: true }, { w: 360, h: 640, dpr: 2, phone: true }, { w: 390, h: 844, dpr: 3, phone: true }, { w: 412, h: 915, dpr: 3, phone: true },
  { w: 844, h: 390, dpr: 3, phone: false, land: true }, { w: 568, h: 320, dpr: 2, phone: false, land: true },
];
async function scnPhone(page, R, base) {
  await fresh(page, base);
  for (const vp of VPS) {
    for (const p of ['hub', 'battle', 'editor']) {
      const tag = p + ' ' + vp.w + 'x' + vp.h + ': ';
      await openPage(page, base, p, { w: vp.w, h: vp.h, mobile: true, dpr: vp.dpr });
      const g = await page.eval(`(() => { const q = (s) => document.querySelector(s); const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
        const vis = (e) => { const c = getComputedStyle(e), r = e.getBoundingClientRect(); return c.visibility !== 'hidden' && c.display !== 'none' && r.width > 2 && r.height > 2; };
        const top = q('#top'), bar = q('#audioBar');
        const others = Array.from(top.children).filter((e) => e !== bar && vis(e)).map((e) => ({ id: e.id || e.className, ...R(e) }));
        const targets = Array.from(bar.querySelectorAll('button, input')).filter(vis).map((e) => ({ id: e.id || e.className, w: Math.round(R(e).w), h: Math.round(R(e).h) }));
        const cv = q('canvas'), dp = q('#dpad'), ab = q('#ab');
        return { vw: innerWidth, vh: innerHeight, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, top: R(top), bar: R(bar), others, targets, pending: bar.hasAttribute('data-pending'),
          canvas: cv && vis(cv) ? R(cv) : null, dpad: dp && vis(dp) ? R(dp) : null, ab: ab && vis(ab) ? R(ab) : null, pad: document.body.dataset.pad, layout: document.body.dataset.layout }; })()`);
      R.ok(!g.pending && g.over <= 0 && g.bar.l >= -0.5 && g.bar.r <= g.vw + 0.5, 'phone: ' + tag + 'the bar is filled in, nothing overflows sideways, the bar is inside the screen', J({ over: g.over, bar: g.bar, vw: g.vw }));
      R.ok(g.targets.length >= (p === 'battle' ? 2 : 3) && g.targets.every((t) => t.w >= 44 && t.h >= 44), 'phone: ' + tag + 'every control of the bar is at least 44 x 44 css px', J(g.targets));
      R.ok(g.others.every((o) => !(g.bar.l < o.r && g.bar.r > o.l && g.bar.t < o.b - 1 && g.bar.b > o.t + 1)), 'phone: ' + tag + 'the bar overlaps no other control of the header', J({ bar: g.bar, others: g.others.filter((o) => g.bar.l < o.r && g.bar.r > o.l && g.bar.t < o.b - 1 && g.bar.b > o.t + 1) }));
      if (vp.phone && p !== 'battle') R.ok(g.bar.t >= Math.max(...g.others.map((o) => o.b)) - 2, 'phone: ' + tag + 'the bar has a row of its own under the header\'s buttons', J({ bar: g.bar.t, lowest: Math.max(...g.others.map((o) => o.b)) }));
      if (vp.phone && p === 'battle') {
        const home = g.others.find((o) => o.id === 'homeLink'), full = g.others.find((o) => o.id === 'fullBtn');
        R.ok(home && full && g.bar.t < 56 && g.bar.l >= home.r - 1 && g.bar.r <= full.l + 1, 'phone: ' + tag + 'the bar is in the header\'s first row between the way back and Fullscreen', J({ bar: g.bar, home, full }));
      }
      if (vp.land && p !== 'editor') R.ok(g.top.h <= 52 && g.bar.t >= g.top.t - 1 && g.bar.b <= g.top.b + 1, 'phone: ' + tag + 'held sideways the header is still ONE row (' + Math.round(g.top.h) + ' px) with the bar inside it', J({ top: g.top, bar: g.bar }));
      if (vp.phone && p !== 'editor') {
        // (screenfit.js: the picture fills the room, or snaps to a whole device-pixel scale when that costs under 6 percent: 400 px of a 412 px phone)
        R.ok(g.canvas && g.canvas.w >= g.vw * 0.94 - 1 && g.canvas.w <= g.vw + 1 && g.pad === 'on' && g.layout === 'portrait', 'phone: ' + tag + 'the picture still fills the width of the phone', J({ canvas: g.canvas, vw: g.vw, pad: g.pad }));
        R.ok(g.dpad && g.ab && g.dpad.b <= g.vh && g.ab.b <= g.vh && g.dpad.t >= g.canvas.b - 1, 'phone: ' + tag + 'the touch pad is under the picture and ends on the screen', J({ dpad: g.dpad, ab: g.ab, vh: g.vh }));
      }
    }
  }
  // a finger: a tap on the mute button, and a tap on the slider's track sets the volume
  await openPage(page, base, 'hub', { w: 390, h: 844, mobile: true, dpr: 3 });
  await tapSel(page, '#abMute'); await sleep(200);
  R.ok((await mixerSettings(page)).muted === true && (await barInfo(page)).muted === 'true', 'phone: a tap on the mute button mutes', J(await barInfo(page)));
  const sr = await rectOf(page, '#abVolume');
  await page.tap(sr.l + sr.w * 0.25, sr.cy); await sleep(300);
  const s = await mixerSettings(page), v = Number((await barInfo(page)).vol.value);
  R.ok(v >= 15 && v <= 35 && near(s.master, v / 100, 1e-9) && s.muted === false, 'phone: a tap on the slider\'s track a quarter of the way along sets the volume there (and unmutes)', J({ v, master: s.master, muted: s.muted }));
  await shot(page, 'bar_phone_hub_after_tap');
  R.ok(!(errs(page).length), 'phone: no page errors', J(errs(page)).slice(0, 200));
}

async function scnFullscreen(page, R, base) {
  await fresh(page, base);
  for (const p of ['hub', 'battle']) {
    const tag = p + ': ';
    await openPage(page, base, p, { w: 844, h: 390, mobile: true, dpr: 3 });
    // iPhone Safari has no Fullscreen API: the pages then lay themselves out as if they were fullscreen (body[data-full="1"]); that layout is what is tested here
    await page.eval(`(() => { for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) { try { delete Element.prototype[k]; } catch (e) {} try { document.documentElement[k] = undefined; } catch (e) {} } })()`);
    await tapSel(page, '#fullBtn'); await sleep(500);
    const d = await page.eval(`({ full: document.body.dataset.full, layout: document.body.dataset.layout })`);
    const topShown = await rectOf(page, '#top');
    const bar = await page.eval(`(() => { const b = document.getElementById('audioBar'); return { float: b.classList.contains('ab-float'), parent: b.parentNode.tagName, open: b.classList.contains('ab-open') }; })()`);
    R.ok(d.full === '1' && d.layout === 'landscape' && (!topShown || !topShown.vis), tag + 'fullscreen: held sideways the page hides its header', J({ d, topShown }));
    R.ok(bar.float && bar.parent === 'BODY' && !bar.open, tag + 'fullscreen: the bar left the hidden header and floats, folded', J(bar));
    const fold = await rectOf(page, '#abFold'), exit = await rectOf(page, '#fullExit'), vol = await rectOf(page, '#abVolume');
    R.ok(fold && fold.vis && fold.w >= 44 && fold.h >= 44 && exit && !hit(fold, exit, 0) && fold.l >= exit.r && (!vol || !vol.vis), tag + 'fullscreen: one 44 px speaker button beside the exit button (not on it), the slider folded away', J({ fold, exit, vol }));
    await shot(page, 'bar_float_folded_' + p);
    await tapSel(page, '#abFold'); await sleep(300);
    const open = await page.eval(`(() => { const b = document.getElementById('audioBar'); return { open: b.classList.contains('ab-open'), exp: document.getElementById('abFold').getAttribute('aria-expanded') }; })()`);
    const vol2 = await rectOf(page, '#abVolume'), mute2 = await rectOf(page, '#abMute');
    R.ok(open.open && open.exp === 'true' && vol2 && vol2.vis && vol2.w >= 100 && mute2 && mute2.vis && mute2.w >= 44, tag + 'fullscreen: a tap opens it: mute and a 120 px slider', J({ open, vol2, mute2 }));
    await shot(page, 'bar_float_open_' + p);
    await page.tap(vol2.l + vol2.w * 0.2, vol2.cy); await sleep(300);
    const v = Number((await barInfo(page)).vol.value), s = await mixerSettings(page);
    R.ok(v >= 10 && v <= 30 && near(s.master, v / 100, 1e-9), tag + 'fullscreen: the floating slider sets the same mixer', J({ v, master: s.master }));
    await tapSel(page, '#abMute'); await sleep(150);
    R.ok((await mixerSettings(page)).muted === true, tag + 'fullscreen: and its mute button mutes', '');
    await key(page, 'esc'); await sleep(200);
    R.ok(!(await page.eval(`document.getElementById('audioBar').classList.contains('ab-open')`)), tag + 'fullscreen: Esc folds it again', '');
    // leaving fullscreen: the bar goes home, into the header
    await tapSel(page, '#fullExit'); await sleep(600);
    const home = await page.eval(`(() => { const b = document.getElementById('audioBar'); return { full: document.body.dataset.full || null, float: b.classList.contains('ab-float'), parent: b.parentNode.id, topH: document.getElementById('top').getBoundingClientRect().height }; })()`);
    R.ok(home.full !== '1' && !home.float && home.parent === 'top' && home.topH > 20, tag + 'fullscreen: leaving fullscreen puts the bar back in the header', J(home));
    await page.eval(`window.__arenaSound.mixer.setMuted(false)`);
  }
}

async function scnA11y(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub');
  await focusSel(page, '#homeLink');
  const seq = [];
  for (let i = 0; i < 9; i++) { await key(page, 'tab', 20); seq.push(await page.eval('document.activeElement && (document.activeElement.id || document.activeElement.tagName)')); }
  const i = seq.indexOf('abMute');
  R.ok(i >= 0 && seq[i + 1] === 'abVolume' && seq[i + 2] === 'abMusic' && seq.indexOf('soundBtn') > i + 2, 'a11y: Tab reaches mute, then the slider, then the music button, before the Sound button', J(seq));
  await focusSel(page, '#abMute'); await key(page, 'enter'); await sleep(150);
  R.ok((await barInfo(page)).mute.pressed === 'true', 'a11y: Enter on the mute button mutes (aria-pressed follows)', J((await barInfo(page)).mute));
  await key(page, 'enter'); await sleep(100);
  await focusSel(page, '#abMusic'); await key(page, 'down'); await sleep(200);
  const mi = await menuInfo(page);
  R.ok(mi && !mi.hidden && (await barInfo(page)).music.expanded === 'true' && (await page.eval('document.activeElement && document.activeElement.getAttribute("role")')) === 'radio', 'a11y: ArrowDown on the music button opens the list and puts the focus on the checked song', J(mi));
  R.ok(mi.checked.length === 1 && (await page.eval(`!!document.querySelector('#abMenu [role="radiogroup"][aria-label]')`)), 'a11y: the list is a labelled radio group with exactly one checked entry', J(mi.checked));
  R.ok((await page.eval(`(() => { const m = document.getElementById('abMenu'); return [m.getAttribute('role'), m.getAttribute('aria-modal'), m.getAttribute('tabindex')].join('|'); })()`)) === 'dialog|true|-1', 'a11y: the list is a MODAL dialog (role dialog, aria-modal true; tabindex -1 keeps a click on its text inside it), which is what makes the editor\'s controller layer scope to it', '');
  await key(page, 'esc');
  // the controller / keyboard navigation layer the editor runs over the whole page sees the bar
  await openPage(page, base, 'editor');
  const nav = await page.eval(`(() => { const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]'; const out = {}; for (const id of ['abMute', 'abVolume', 'abMusic']) { const e = document.getElementById(id); out[id] = !!e && e.matches(sel) && !e.closest('[hidden], [inert], [data-nav-skip]') && !e.disabled && e.getClientRects().length > 0; } return out; })()`);
  R.ok(nav.abMute && nav.abVolume && nav.abMusic, 'a11y: on the editor (whose enableDomNav covers the whole page) the bar\'s controls are ordinary focusable, visible, un-skipped controls the layer can reach', J(nav));
}

async function scnPrompt(page, R, base) {
  await fresh(page, base);
  for (const vp of [{ w: 390, h: 844, mobile: true, dpr: 3, n: '390x844' }, { w: 1280, h: 800, mobile: false, dpr: 1, n: '1280x800' }]) {
    for (const p of ['hub', 'battle', 'editor']) {
      await openPage(page, base, p, vp); await sleep(700);
      const g = await page.eval(`(() => { const pr = document.getElementById('soundPrompt'), b = document.getElementById('audioBar'); if (!pr || pr.hidden) return { shown: false }; const a = pr.getBoundingClientRect(), r = b.getBoundingClientRect(); return { shown: true, overlap: pr.hasAttribute('data-overlap'), hit: a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top }; })()`);
      R.ok(g.shown && !g.hit, 'prompt: ' + p + ' ' + vp.n + ': the start-the-sound prompt does not cover the bar', J(g));
    }
  }
  // floating bar: the pill must not sit on the speaker button either
  await openPage(page, base, 'hub', { w: 844, h: 390, mobile: true, dpr: 3 });
  await page.eval(`(() => { for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) { try { delete Element.prototype[k]; } catch (e) {} } })()`);
  await page.eval(`document.getElementById('fullBtn').click()`); await sleep(500);      // a synthetic click is no user activation: the sound is still waiting for one, so the prompt is up
  const f = await page.eval(`(() => { const pr = document.getElementById('soundPrompt'), b = document.getElementById('audioBar'); if (!pr || pr.hidden) return { shown: false }; const a = pr.getBoundingClientRect(), r = b.getBoundingClientRect(); return { shown: true, float: b.classList.contains('ab-float'), hit: a.left < r.right + 2 && a.right > r.left - 2 && a.top < r.bottom + 2 && a.bottom > r.top - 2 }; })()`);
  R.ok(f.shown && f.float && !f.hit, 'prompt: hub 844x390 fullscreen: the prompt does not cover the floating speaker button', J(f));
  // the obstacle must be REAL, not just luck: put the floating bar exactly where the pill sits, and the pill has to move off it
  await page.eval(`(() => { const p = document.getElementById('soundPrompt'), b = document.getElementById('audioBar'); const r = p.getBoundingClientRect(); b.style.left = (r.left + 12) + 'px'; b.style.top = (r.top + 12) + 'px'; window.dispatchEvent(new Event('resize')); })()`); await sleep(900);
  const f2 = await page.eval(`(() => { const pr = document.getElementById('soundPrompt'), b = document.getElementById('audioBar'); const a = pr.getBoundingClientRect(), r = b.getBoundingClientRect(); return { shown: !pr.hidden, hit: a.left < r.right + 2 && a.right > r.left - 2 && a.top < r.bottom + 2 && a.bottom > r.top - 2, overlap: pr.hasAttribute('data-overlap') }; })()`);
  R.ok(f2.shown && !f2.hit, 'prompt: hub 844x390 fullscreen: with the floating bar moved onto the spot of the pill, the pill moves off it (the bar is an obstacle)', J(f2));
}

async function scnStates(page, R, base) {
  await fresh(page, base);
  await openPage(page, base, 'hub');
  const vis = () => page.eval(`getComputedStyle(document.getElementById('audioBar')).visibility`);
  R.ok((await vis()) === 'visible', 'states: the bar is visible when the page is ready', await vis());
  const states = [];
  for (const s of ['boot', 'error']) { await page.eval(`document.body.dataset.state = ${J(s)}`); states.push(await vis()); }
  await page.eval(`document.body.dataset.state = 'ready'`);
  R.ok(states.join() === 'hidden,hidden' && (await vis()) === 'visible', 'states: the bar is hidden (not removed: its row stays reserved) while a page is loading or has failed', J(states));
}

// the pure half of the changer (js/menu_music.js), in Node: a fake director, a fake storage, a fake song map
async function scnUnit(_page, R) {
  const M = await L.mod('menu_music.js');
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
  const song = (index, o) => ({ index, loops: true, jingle: false, label: 'L' + index, ...(o || {}) });
  const MAP = { soulgold: { hub: song(1), pokecenter: song(1), editor: song(2), lab: song(2), title: song(3, { loops: false }), preview: song(4), victory_sting: song(5, { loops: false, jingle: true }), battle_easy: song(6), se_cursor: song(7, { loops: false, jingle: true }), credits: song(8, { loops: false }) }, ultraviolet: { hub: song(11), battle_easy: song(16) } };
  const map = { MUSIC_KEYS: Object.keys(MAP.soulgold), songFor: (st, k) => (MAP[st] && MAP[st][k] ? { ...MAP[st][k] } : null), MAP: { hub: { doc: 'hub / main menu' }, editor: { doc: 'team editor' } } };
  // settings
  R.ok(J(M.normalizeMenuMusic(undefined).settings) === '{"v":1,"pick":"auto"}' && M.normalizeMenuMusic({ pick: 'off' }).settings.pick === 'off' && M.normalizeMenuMusic({ pick: 'battle_hard' }).settings.pick === 'battle_hard', 'unit: a pick is auto, off or a key');
  const bad = ['<b>', '', 'Hub', 'a b', 'x'.repeat(40), 7, null, {}, [], '../x'].filter((p) => M.normalizeMenuMusic({ pick: p }).settings.pick !== 'auto');
  R.ok(bad.length === 0 && M.normalizeMenuMusic('x').problems.includes('value') && M.normalizeMenuMusic({ pick: 7 }).problems.includes('pick'), 'unit: anything that is not a key-shaped string is repaired to auto, and says so', J(bad));
  const s1 = store(); s1.setItem('arena.menumusic', '{not json'); const r1 = M.readMenuMusic(s1);
  R.ok(r1.settings.pick === 'auto' && r1.source === 'invalid' && M.readMenuMusic(store()).source === 'default' && M.readMenuMusic(null).source === 'unreadable' && M.readMenuMusic({ getItem() { throw new Error('blocked'); } }).source === 'unreadable', 'unit: a damaged, absent or blocked store is auto and never throws', J(r1));
  // the list of songs
  const o = M.trackOptions(map, 'soulgold');
  R.ok(J(o.map((x) => x.key)) === '["hub","editor","preview","battle_easy"]', 'unit: each looping song once (pokecenter is the hub song, lab is the editor song), nothing that ends (title, credits), no fanfare, no effect', J(o.map((x) => x.key)));
  R.ok(o[0].name === TN.hub && o[1].name === TN.editor && o[2].name === TN.preview && o[3].name === TN.battle_easy && o[0].label === 'L1', 'unit: names come from the player-facing table (menu_music.js TRACK_NAMES), NOT from the map\'s `doc` notes ("hub / main menu", "team editor"); the ROM label rides along as data', J(o.map((x) => x.name)));
  R.ok(M.nameOf(map, 'credits') === 'Credits' && M.nameOf(map, 'a_new_key') === 'A new key' && M.nameOf(null, 'hub') === TN.hub, 'unit: a key the table has no name for is spelled out from the key (and the map is not read for it)');
  R.ok(J(M.trackOptions(map, 'ultraviolet').map((x) => x.key)) === '["hub","battle_easy"]' && M.trackOptions(null, 'soulgold').length === 0 && M.trackOptions({ songFor() { throw new Error('x'); } }, 'soulgold').length === 0, 'unit: a soundtrack offers only what it has; no map, or a map that throws, offers nothing');
  // the changer
  const calls = [];
  const director = { set: (k) => calls.push('set:' + k), stop: () => calls.push('stop') };
  let loaded = null, st = 'soulgold'; const mixer = { listeners: [], on(f) { this.listeners.push(f); return () => {}; }, soundtrack: () => st };
  const store2 = store();
  const mm = M.createMenuMusic({ director, mixer, storage: store2, getMap: () => loaded, soundtrack: () => st, window: null });
  mm.set('hub');
  R.ok(calls.join() === 'set:hub' && mm.state().effective === 'hub', 'unit: by default the screen\'s own song', calls.join());
  R.ok(mm.choose('battle_easy') === false && mm.pick() === 'auto', 'unit: before the song table has loaded, only auto and off can be chosen');
  // a stored pick is NAMED before the song table has loaded (the bar used to show the raw key "battle_hard" until it did), and is not "missing" while nothing is known about the soundtrack
  { const pre = store(); pre.setItem('arena.menumusic', '{"v":1,"pick":"battle_hard"}'); const mp = M.createMenuMusic({ director: { set() {}, stop() {} }, mixer, storage: pre, getMap: () => null, soundtrack: () => 'soulgold', window: null }); mp.set('hub');
    const s0 = mp.state();
    R.ok(s0.pick === 'battle_hard' && s0.pickName === TN.battle_hard && s0.missing === false && s0.effective === 'battle_hard', 'unit: before the song table has loaded a stored pick is named from the table (not shown as its key) and is not reported missing', J({ pick: s0.pick, name: s0.pickName, missing: s0.missing, eff: s0.effective }));
    mp.destroy(); }
  loaded = map; mm.refresh();
  calls.length = 0;
  R.ok(mm.choose('battle_easy') === true && calls.join() === 'set:battle_easy' && store2.m.get('arena.menumusic') === '{"v":1,"pick":"battle_easy"}', 'unit: a pick asks the director for it and is stored, versioned', calls.join() + ' ' + store2.m.get('arena.menumusic'));
  calls.length = 0;
  R.ok(mm.choose('battle_easy') === true && calls.length === 0, 'unit: choosing what is already picked does nothing (no restart)');
  R.ok(mm.choose('nonsense') === false && mm.choose('credits') === false && mm.choose('hub; drop') === false && mm.pick() === 'battle_easy', 'unit: a song that is not on offer cannot be chosen');
  calls.length = 0; mm.choose('off');
  R.ok(calls.join() === 'stop' && mm.state().effective === null, 'unit: off stops the menu music', calls.join());
  calls.length = 0; mm.set('editor');
  R.ok(calls.join() === 'stop', 'unit: a new menu screen while off stays silent', calls.join());
  calls.length = 0; mm.choose('auto');
  R.ok(calls.join() === 'set:editor', 'unit: auto goes back to the screen\'s own song (the editor\'s)', calls.join());
  const seq = []; for (let i = 0; i < 6; i++) seq.push(mm.step(1));
  R.ok(J(seq) === '["hub","editor","preview","battle_easy","off","auto"]' && mm.step(-1) === 'off', 'unit: next walks Automatic, every song, Off and wraps; previous from Automatic is Off', J(seq));
  mm.set('hub'); mm.choose('battle_easy'); calls.length = 0; st = 'ultraviolet'; mm.refresh();
  R.ok(mm.state().effective === 'battle_easy' && mm.pick() === 'battle_easy', 'unit: a soundtrack that has the picked song plays it');
  st = 'soulgold'; mm.choose('preview'); calls.length = 0; st = 'ultraviolet'; mm.refresh();
  R.ok(mm.pick() === 'preview' && mm.state().effective === 'hub' && calls.join() === 'set:hub', 'unit: on a soundtrack without the picked song the screen\'s own song plays and the pick is kept', calls.join() + ' ' + mm.pick());
  { const s1 = mm.state(); st = 'soulgold';
    const s2 = mm.state(); mm.choose('off'); const s3 = mm.state(); mm.choose('auto'); const s4 = mm.state(); st = 'ultraviolet';
    R.ok(s1.missing === true && s1.pickName === TN.preview && s2.missing === false && s3.missing === false && s3.pickName === 'Off' && s4.missing === false && s4.pickName === 'Automatic', 'unit: state().missing is true only for a song pick the soundtrack lacks (never for Automatic or Off), and pickName is the name the bar shows', J([s1.missing, s2.missing, s3.missing, s4.missing])); }
  mm.destroy(); calls.length = 0; mm.choose('off');
  R.ok(calls.length === 0, 'unit: a destroyed changer does nothing');
  let threw = false; try { M.createMenuMusic({}); } catch (_e) { threw = true; }
  R.ok(threw, 'unit: it needs a director');
}

// OFF MEANS NO MUSIC, NOT NO SOUND: with Off stored the engine used to stay unloaded for the whole visit (the director only loaded it for a wanted song), so the hub's cursor / select / back sounds
// were all dropped as 'engine-not-ready'; picking Off in the same visit (engine already loaded) kept them. The same setting must behave the same after a reload.
async function scnOff(page, R, base) {
  await fresh(page, base);
  await page.eval(`localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: 'off' }))`);
  await openPage(page, base, 'hub');
  const m = await mmState(page);
  R.ok(m.pick === 'off' && m.effective === null && (await dirWant(page)) === null, 'off: a stored Off is read back at load: no song is wanted', J(m));
  await key(page, 'tab'); await sleep(150);                                   // the visitor's first key (Tab moves nothing in the hub): the browser lets the sound start
  await page.waitFor(`window.__sndMusic.create.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  const e0 = await page.eval(`({ created: window.__sndMusic.create.length, plays: window.__sndMusic.play.length })`);
  R.ok(e0.created === 1 && e0.plays === 0, 'off: with Off stored the music ENGINE still loads once the sound can play (the menus\' effects need it) and no song is played', J(e0));
  await key(page, 's'); await sleep(250);                                     // S = down: the cursor moves
  const sfx = await page.eval(`window.__arenaSound.state().director.sfx.map((x) => ({ key: x.key, played: x.played, why: x.why || null }))`);
  R.ok(sfx.some((x) => x.key === 'se_cursor' && x.played === true), 'off: a cursor move plays the cursor sound (se_cursor) with Off stored', J(sfx.slice(-3)));
  R.ok((await page.eval(`window.__sndMusic.play.length`)) === 0 && (await dirWant(page)) === null, 'off: ... and still no song', J(await page.eval(`window.__sndMusic.play`)));
  // the hub's other menu sounds ride on the same engine: A (select) on QUICK BATTLE opens its screen, B (back) leaves it
  await key(page, 'w'); await sleep(200); await key(page, 'z'); await sleep(250); await key(page, 'x'); await sleep(250);
  const sfx2 = await page.eval(`window.__arenaSound.state().director.sfx.filter((x) => x.played).map((x) => x.key)`);
  R.ok(sfx2.includes('se_select') && sfx2.includes('se_back'), 'off: select (Z) and back (X) are heard too', J(sfx2));
  // and a reload with Auto after Off plays the hub song again (the pick, not the engine, is what Off changes)
  await page.eval(`localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: 'auto' }))`);
  await openPage(page, base, 'hub');
  await key(page, 'tab'); await sleep(150);
  await page.waitFor(`window.__sndMusic.play.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  R.ok((await lastPlay(page)) === 10 && (await page.eval(`window.__sndMusic.create.length`)) === 1, 'off: Automatic after Off plays the hub song on the one engine', J(await page.eval(`window.__sndMusic.play`)));
  // EFFECTS ARE A PAGE OPTION (sound_system.js `effects`). Only a page that PLAYS effects loads the engine for them: the hub does (above), the team editor does not, so with Off stored it loads nothing -- no
  // engine and, with Ultra Violet chosen, no 16 MB ROM fetch (it used to, when every page was built with effects:true). The stored soundtrack is Ultra Violet here, which is what makes the fetch visible.
  const offUv = `(() => { localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: 'off' })); localStorage.setItem('arena.audio', JSON.stringify({ v: 1, master: 0.5, music: 0.6, fx: 0.8, muted: false, soundtrack: 'ultraviolet' })); })()`;
  const loads = () => page.eval(`({ created: window.__sndMusic.create.length, plays: window.__sndMusic.play.length, uv: window.__sndUvFetched || 0, soundtrack: (window.__sndMusic.create[0] || {}).soundtrack || null, want: window.__arenaSound.state().director.want })`);
  await page.eval(offUv);
  await openPage(page, base, 'editor');
  await key(page, 'tab'); await sleep(1200);                                   // the first key lets the sound start; a negative needs a moment to be a real negative
  const edOff = await loads();
  R.ok(edOff.created === 0 && edOff.plays === 0 && edOff.uv === 0 && edOff.want === null, 'off: the team editor with Off stored (and Ultra Violet chosen) loads NOTHING: no music engine, no Ultra Violet ROM fetch (it plays no effect)', J(edOff));
  // positive control: the same editor with Automatic DOES load the engine (and fetches the ROM), so the rig can see a load there; and the hub with Off + Ultra Violet loads both for its effects
  await page.eval(`localStorage.setItem('arena.menumusic', JSON.stringify({ v: 1, pick: 'auto' }))`);
  await openPage(page, base, 'editor');
  await key(page, 'tab'); await page.waitFor(`window.__sndMusic.create.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  const edAuto = await loads();
  R.ok(edAuto.created === 1 && edAuto.uv === 1 && edAuto.soundtrack === 'ultraviolet' && edAuto.plays === 1, 'off: positive control: the same editor with Automatic loads the engine on Ultra Violet and plays the editor song (the rig can see a load)', J(edAuto));
  await page.eval(offUv);
  await openPage(page, base, 'hub');
  await key(page, 'tab'); await page.waitFor(`window.__sndMusic.create.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  const hubOff = await loads();
  R.ok(hubOff.created === 1 && hubOff.uv === 1 && hubOff.plays === 0 && hubOff.want === null, 'off: the hub with Off stored (and Ultra Violet chosen) still loads the engine for its effects, plays no song', J(hubOff));
  R.ok(!(errs(page).length), 'off: no page errors', J(errs(page)).slice(0, 200));
}

// FOCUS. After a POINTER use of the bar the keyboard belongs to the page again: a slider that keeps the focus keeps the arrow keys (input.js leaves a focused range its arrows), a button that keeps it keeps
// Enter / Space. A keyboard user's own focus is left alone.
async function scnFocus(page, R, base) {
  await fresh(page, base);
  for (const p of ['hub', 'battle', 'editor']) {
    await openPage(page, base, p);
    const tag = p + ': ';
    const act = () => page.eval(`(() => { const a = document.activeElement; return a ? (a.id || a.tagName) : null; })()`);
    const target = p === 'hub' ? 'hub' : p === 'battle' ? 'battle' : 'BODY';       // the page's [data-input-target] canvas; the editor has none, so the control is just blurred
    await clickSel(page, '#abMute'); await sleep(200);
    R.ok((await act()) === target, tag + 'focus: after a mouse click on Mute the focus is back on the page (' + target + '), not on the button', await act());
    const sr = await rectOf(page, '#abVolume');
    await page.click(sr.l + sr.w * 0.3, sr.cy); await sleep(250);
    R.ok((await act()) === target, tag + 'focus: after the slider is clicked / released the focus is back on the page, not on the slider', await act());
    if (p === 'hub') {
      const v0 = (await barInfo(page)).vol.value, c0 = await page.eval(`window.${HUB}.model.state().cursor.main`);
      await key(page, 'down'); await sleep(200);
      R.ok((await barInfo(page)).vol.value === v0 && (await page.eval(`window.${HUB}.model.state().cursor.main`)) !== c0, tag + 'focus: so ArrowDown moves the hub cursor and does NOT change the volume', J({ v0, v: (await barInfo(page)).vol.value }));
    }
    // the music list (hub, editor): a click that closes it also hands the focus back; Esc keeps it on the music button (the keyboard way)
    if (p !== 'battle') {
      await clickSel(page, '#abMusic'); await sleep(200);
      R.ok((await page.eval(`document.getElementById('abMenu').contains(document.activeElement)`)), tag + 'focus: opening the list puts the focus inside it', await act());
      await clickSel(page, '#abMusic'); await sleep(200);
      R.ok((await act()) === target, tag + 'focus: closing the list with a click on the music button hands the focus back to the page', await act());
      await clickSel(page, '#abMusic'); await sleep(150); await key(page, 'esc'); await sleep(150);
      R.ok((await act()) === 'abMusic', tag + 'focus: closing it with Esc leaves the focus on the music button (a keyboard user keeps their place)', await act());
    }
    // a KEYBOARD press on Mute keeps the focus where the keyboard user is
    await focusSel(page, '#abMute'); await key(page, 'enter'); await sleep(150);
    R.ok((await act()) === 'abMute', tag + 'focus: Enter on the focused Mute button keeps the focus on it', await act());
    await page.eval('document.activeElement && document.activeElement.blur()');
    // a keyboard use of the slider keeps it too (the arrows are for the slider)
    await focusSel(page, '#abVolume'); const v1 = (await barInfo(page)).vol.value; await key(page, 'left'); await sleep(150);
    R.ok((await act()) === 'abVolume' && (await barInfo(page)).vol.value !== v1, tag + 'focus: an arrow on the focused slider still changes the volume and keeps the focus there', J([v1, (await barInfo(page)).vol.value, await act()]));
    await page.eval(`window.__arenaSound.mixer.setMuted(false)`);
  }
  R.ok(!(errs(page).length), 'focus: no page errors', J(errs(page)).slice(0, 200));
}

// BACK / FORWARD CACHE. A page the browser keeps in its cache is the same live page when the visitor comes Back to it, but leaving stopped its music (pagehide) and nothing asked for the song again.
// pagehide / pageshow are dispatched by hand here (a headless page with this server's headers is not bfcache-eligible, so the real cache is not exercised: the handlers are).
async function scnRestore(page, R, base) {
  await fresh(page, base);
  const hide = () => page.eval(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`);
  const show = (persisted) => page.eval(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: ${persisted} }))`);
  const nPlay = () => page.eval(`window.__sndMusic.play.length`);
  await openPage(page, base, 'hub');
  await key(page, 's'); await page.waitFor(`window.__sndMusic.play.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  R.ok((await dirWant(page)) === 'hub' && (await lastPlay(page)) === 10, 'restore: the hub song is playing', J({ want: await dirWant(page), play: await lastPlay(page) }));
  await hide(); await sleep(200);
  const p0 = await nPlay();
  R.ok((await dirWant(page)) === null, 'restore: leaving the page stops the music (nothing is wanted)', J(await dirWant(page)));
  await show(false); await sleep(300);
  R.ok((await dirWant(page)) === null && (await nPlay()) === p0, 'restore: a pageshow that is NOT from the cache brings nothing back', J({ want: await dirWant(page), plays: await nPlay(), p0 }));
  await show(true); await sleep(400);
  R.ok((await dirWant(page)) === 'hub' && (await nPlay()) === p0 + 1 && (await lastPlay(page)) === 10, 'restore: a pageshow FROM the cache brings the hub song back', J({ want: await dirWant(page), plays: await nPlay(), p0 }));
  await show(true); await sleep(200);
  R.ok((await nPlay()) === p0 + 1, 'restore: a second pageshow (nothing was hidden since) does not restart it', J(await nPlay()));
  // the player's pick comes back, not the screen's own song
  await clickSel(page, '#abMusic'); await sleep(150); await clickSel(page, '#abMenu [data-pick="battle_hard"]'); await sleep(250); await key(page, 'esc'); await sleep(100);
  await hide(); await sleep(200); await show(true); await sleep(400);
  R.ok((await dirWant(page)) === 'battle_hard' && (await lastPlay(page)) === 22, 'restore: a restored menu page plays the PICKED song (battle_hard, 22), the player\'s pick, not the screen\'s own', J({ want: await dirWant(page), play: await lastPlay(page) }));
  // Off stays Off
  await clickSel(page, '#abMusic'); await sleep(150); await clickSel(page, '#abMenu [data-pick="off"]'); await sleep(250); await key(page, 'esc'); await sleep(100);
  const p1 = await nPlay();
  await hide(); await sleep(150); await show(true); await sleep(300);
  R.ok((await dirWant(page)) === null && (await nPlay()) === p1, 'restore: with Off picked a restored page stays silent', J({ want: await dirWant(page), plays: await nPlay(), p1 }));
  // the battle page asks for the battle song again
  await fresh(page, base);
  await openPage(page, base, 'battle');
  await key(page, 's'); await page.waitFor(`window.__sndMusic.play.length >= 1`, { timeoutMs: 15000 }).catch(() => {});
  const w0 = await dirWant(page), q0 = await nPlay();
  await hide(); await sleep(200); const gone = await dirWant(page);
  await show(true); await sleep(400);
  R.ok(w0 === 'battle_easy' && gone === null && (await dirWant(page)) === 'battle_easy' && (await nPlay()) === q0 + 1, 'restore: the battle page asks for its battle song again (battle_easy) when it is restored', J({ w0, gone, now: await dirWant(page), q0, plays: await nPlay() }));
  R.ok(!(errs(page).length), 'restore: no page errors', J(errs(page)).slice(0, 200));
}

const SCENARIOS = { unit: scnUnit, volume: scnVolume, identical: scnIdentical, music: scnMusic, keys: scnKeys, pad: scnPad, off: scnOff, focus: scnFocus, restore: scnRestore, scope: scnScope, real: scnReal, phone: scnPhone, fullscreen: scnFullscreen, a11y: scnA11y, prompt: scnPrompt, states: scnStates };

async function withPage(fn) {
  const port = cdp; cdp += 4;
  await withBrowser({ port, width: 1280, height: 800, lock: false }, async (page) => {
    await addInit(page, AUDIO_DOUBLE_SRC); await addInit(page, STUB_MODULES_SRC);
    await fn(page);
  });
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each breaks ONE thing in an overlay copy of pokemonarena/. Only the scenarios named run; at least one case must then fail.
const MUTANTS = [
  { id: 'M1 the slider does not drive the mixer', file: 'js/audiobar.js', from: "    mixer.setVolume('master', v);\n    paint();", to: '    paint();', run: ['volume'] },
  { id: 'M2 the mute button does not mute', file: 'js/audiobar.js', from: '    mixer.unlock(); mixer.toggleMuted(); paint();', to: '    mixer.unlock(); paint();', run: ['volume'] },
  { id: 'M3 dragging up while muted does not unmute', file: 'js/audiobar.js', from: 'if (mixer.muted() && v > 0) { mixer.unlock(); mixer.setMuted(false); }', to: 'if (false) { mixer.unlock(); mixer.setMuted(false); }', run: ['volume'] },
  { id: 'M4 the bar does not follow the mixer', file: 'js/audiobar.js', from: "const offMixer = mixer.on((ev) => { if (ev.type === 'volume' || ev.type === 'mute' || ev.type === 'soundtrack') paint(); });", to: 'const offMixer = () => {};', run: ['volume'] },
  { id: 'M5 the slider is not named', file: 'js/audiobar.js', from: "'aria-label': 'Volume', title: 'Volume' }", to: "title: 'Volume' }", run: ['volume', 'a11y'] },
  { id: 'M6 the bar is never hydrated (the placeholder stays pending)', file: 'js/audiobar.js', from: "  el.removeAttribute('data-pending');\n", to: '', run: ['volume'] },
  { id: 'M7 the pick is not stored', file: 'js/menu_music.js', from: '    M.pick = p;\n    writeMenuMusic(storage, { pick: p });', to: '    M.pick = p;', run: ['unit', 'music'] },
  { id: 'M8 Off does not silence the menus', file: 'js/menu_music.js', from: 'if (k === null) director.stop(); else director.set(k);', to: 'director.set(k === null ? M.screen : k);', run: ['unit', 'music'] },
  { id: 'M9 a song the soundtrack lacks leaves the menus silent (no fall back to the screen\'s own)', file: 'js/menu_music.js', from: 'return options().some((o) => o.key === M.pick) ? M.pick : M.screen;', to: 'return M.pick;', run: ['unit', 'music'] },
  { id: 'M10 any pick can be chosen', file: 'js/menu_music.js', from: "if (p !== PICK_AUTO && p !== PICK_OFF && !options().some((o) => o.key === p)) return false;", to: '', run: ['unit', 'music'] },
  { id: 'M11 a hostile stored pick is believed', file: 'js/menu_music.js', from: "(o.pick === PICK_AUTO || o.pick === PICK_OFF || KEY_RE.test(o.pick))", to: "(typeof o.pick === 'string')", run: ['unit', 'music'] },
  { id: 'M12 the battle page gets the changer', file: 'js/audiobar.js', from: "const mm = page === 'battle' ? null : (sys.menuMusic || null);", to: 'const mm = sys.menuMusic || null;', run: ['scope', 'identical'] },
  { id: 'M13 the battle page\'s music follows the menu pick', file: 'js/sound_system.js', from: "if (want === 'preview') director.battle(cpu);", to: "if (want === 'preview') menuMusic.set('preview');", run: ['scope'] },
  { id: 'M14 a song shared by two keys is offered twice', file: 'js/menu_music.js', from: " || seen.has(r.index)) continue;", to: ') continue;', run: ['unit', 'real'] },
  { id: 'M15 songs that do not loop are offered', file: 'js/menu_music.js', from: 'r.loops !== true || r.jingle === true', to: 'false', run: ['unit', 'real'] },
  { id: 'M16 Esc does not close the list', file: 'js/audiobar.js', from: "if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); closeMenu(true); }", to: '', run: ['music'] },
  { id: 'M17 the bar never floats in landscape fullscreen', file: 'js/audiobar.js', from: "const floating = !!b && b.dataset.full === '1' && b.dataset.layout === 'landscape';", to: 'const floating = false;', run: ['fullscreen'] },
  { id: 'M18 the controls are 36 px', file: 'audiobar.css', from: '.ab-btn { width: 44px; height: 44px; min-width: 44px;', to: '.ab-btn { width: 36px; height: 36px; min-width: 36px;', run: ['phone'] },
  { id: 'M19 the phone row rule is gone (the bar squeezes into the header\'s buttons)', file: 'audiobar.css', from: '#top .audiobar, #top .audiobar[data-page="editor"] { order: 9; flex: 1 1 100%; }', to: '#top .audiobar, #top .audiobar[data-page="editor"] { order: 0; flex: 0 0 auto; }', run: ['phone'] },
  { id: 'M20 the hub gives nothing back for its taller header (the pad ends below a 568 px screen)', file: 'audiobar.css', from: '  body[data-pad="on"][data-layout="portrait"] #onlineLink { margin-block: 0; }\n', to: '', run: ['phone'] },
  { id: 'M21 the arrow (or a WASD key) in the list reaches the page behind it', file: 'js/audiobar.js', from: "if (dir === 'down' || dir === 'right') { e.preventDefault(); e.stopPropagation();", to: "if (dir === 'down' || dir === 'right') {", run: ['music', 'keys'] },
  { id: 'M22 the prompt may sit on the floating bar', file: 'js/sound_system.js', from: "'#onlineLink', '#keys', '#romStatus', '#note', '.ab-float']", to: "'#onlineLink', '#keys', '#romStatus', '#note']", run: ['prompt'] },
  { id: 'M23 the bar is not hidden while loading or failed', file: 'audiobar.css', from: 'body[data-state="boot"] .audiobar, body[data-state="error"] .audiobar { visibility: hidden; }', to: '', run: ['states'] },
  { id: 'M24 the editor\'s own slider width wins', file: 'audiobar.css', from: '.audiobar .ab-vol { width: 100px; height: 44px;', to: '.ab-vol { width: 100px; height: 44px;', run: ['identical'] },
  // ---- the audit round: Off keeps the effects, focus goes back to the page, the list is modal, names and the missing pick, the page cache
  { id: 'M25 Off leaves the engine unloaded on every page (the director loads it only for a wanted song)', file: 'js/sound_system.js', from: 'romFor, effects,', to: 'romFor,', run: ['off'] },
  { id: 'M40 the team editor loads the engine (and the Ultra Violet ROM) with Off again: effects is true for every page', file: 'js/sound_system.js', from: "(page === 'hub' || page === 'battle')", to: 'true', run: ['off'] },
  // ---- the last leftovers: WASD in the list, the pad on the hub's list
  { id: 'M41 WASD do nothing in the open list (only the arrows pick songs)', file: 'js/audiobar.js', from: "const dir = ARROW_DIR[e.key] || (typeof sys.keyDirection === 'function' ? sys.keyDirection(e) : null);", to: 'const dir = ARROW_DIR[e.key] || null;', run: ['keys'] },
  { id: 'M42 the direction keys of the list are hard-coded WASD (the bindings of the player are ignored)', file: 'js/sound_system.js', from: "if (inp && inp.bindings && typeof inp.bindings.get === 'function') {", to: 'if (false) {', run: ['keys'] },
  { id: 'M43 the open list of the hub has no controller route (the pad is ignored while it is up)', file: 'js/audiobar.js', from: "try { menuNav = typeof sys.dialogNav === 'function' ? sys.dialogNav(menu, () => closeMenu(true)) : null; } catch (_e) { menuNav = null; }", to: '', run: ['pad'] },
  { id: 'M44 the controller layer of the list outlives the list (a second opening steps twice)', file: 'js/audiobar.js', from: "if (menuNav) { try { menuNav.disable(); } catch (_e) { /* ignore */ } menuNav = null; }", to: '', run: ['pad'] },
  { id: 'M26 the director ignores effects when no song is wanted', file: 'js/music_director.js', from: 'if (!D.want) { stopNow(); if (effects) await ensureMusic(); return; }', to: 'if (!D.want) { stopNow(); return; }', run: ['off'] },
  { id: 'M27 a mouse click on Mute leaves the focus on the button', file: 'js/audiobar.js', from: 'if (e.detail > 0) handBack(); // a pointer click', to: '// a pointer click', run: ['focus'] },
  { id: 'M28 a released slider keeps the focus (and the arrow keys)', file: 'js/audiobar.js', from: "for (const t of ['pointerup', 'pointercancel']) range.addEventListener(t, () => { setTimeout(handBack, 0); });", to: '', run: ['focus'] },
  { id: 'M29 closing the list with a click keeps the focus on the music button', file: 'js/audiobar.js', from: 'if (menuOpen) { closeMenu(true); if (e.detail > 0) handBack(); }', to: 'if (menuOpen) { closeMenu(true); }', run: ['focus'] },
  { id: 'M30 the keys the list does not use reach the page behind it', file: 'js/audiobar.js', from: '    else e.stopPropagation();\n  }', to: '    else { /* mutant: leaks */ }\n  }', run: ['music'] },
  { id: 'M31 the hub is never told the list is open', file: 'js/audiobar.js', from: "if (typeof sys.menuDialog === 'function') sys.menuDialog(true);", to: '', run: ['music'] },
  { id: 'M32 the list is not a modal dialog for the editor\'s controller layer', file: 'js/audiobar.js', from: "'aria-modal': 'true', ", to: '', run: ['a11y'] },
  { id: 'M33 a pick the soundtrack lacks is shown as a bare name (nothing says it is not playing)', file: 'js/audiobar.js', from: "return st.missing ? 'Automatic (' + n + ' is not on this soundtrack)' : n;", to: 'return n;', run: ['music'] },
  { id: 'M34 a pick the soundtrack lacks leaves no entry checked', file: 'js/audiobar.js', from: "const shown = st.missing ? 'auto' : st.pick;", to: 'const shown = st.pick;', run: ['music'] },
  { id: 'M35 the changer shows the map\'s developer notes as names again', file: 'js/menu_music.js', from: 'return Object.prototype.hasOwnProperty.call(TRACK_NAMES, key) ? TRACK_NAMES[key] : humanize(key);', to: 'return humanize(key);', run: ['unit', 'real'] },
  { id: 'M36 a stored pick is shown as its raw key until the song table has loaded', file: 'js/menu_music.js', from: ": nameOf(null, M.pick));", to: ': M.pick);', run: ['unit', 'music'] },
  { id: 'M37 a pick the soundtrack lacks is never reported missing', file: 'js/menu_music.js', from: 'const missing = (opts) => !!getMap() && M.pick', to: 'const missing = (opts) => false && M.pick', run: ['unit', 'music'] },
  { id: 'M38 a restored page stays silent', file: 'js/sound_system.js', from: 'try { director.set(w.key, w.then); } catch (_e) { /* the music is optional */ }', to: '', run: ['restore'] },
  { id: 'M39 a pageshow that is not from the cache restarts the music', file: 'js/sound_system.js', from: 'if (S.destroyed || !e || e.persisted !== true) return;', to: 'if (S.destroyed || !e) return;', run: ['restore'] },
];

/* ------------------------------------------------------------------------------------------------ main */
const server = await L.startServer();
const t0 = Date.now();
try {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = Object.keys(SCENARIOS).filter((n) => !only.length || only.includes(n));
  await withPage(async (page) => {
    for (const n of names) {
      console.log('== ' + n);
      const R = recorder();
      try { await SCENARIOS[n](page, R, BASE); } catch (e) { R.ok(false, 'scenario ' + n + ' crashed', e && e.stack ? e.stack.split('\n').slice(0, process.env.ARENA_STACK ? 14 : 3).join(' | ') : e); }        // ARENA_STACK=1: the whole stack of a crashed scenario
      feed(R);
    }
  });
  console.log('\naudiobar: ' + C.pass + ' passed, ' + C.fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)  screenshots: ' + OUT);

  let survived = 0, killedN = 0;
  if (WANT_MUTANTS) {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bar-mut-'));
    let pp = Number(process.env.ARENA_OVERLAY_PORT || 8190);
    const results = [];
    // the unmutated twin first: it must pass, or a "kill" below proves nothing
    await withPage(async (page) => {
      const dTwin = copyTree(PA, path.join(TMP, 'twin')); const ovT = await startOverlay({ dir: dTwin, port: pp++, upstream: BASE });
      try {
        const RT = recorder();
        for (const n of ['volume', 'music', 'phone']) { try { await SCENARIOS[n](page, RT, ovT.url); } catch (e) { RT.ok(false, 'twin ' + n + ' crashed', e.message); } }
        const bad = RT.r.filter((x) => !x.ok);
        C.ok(bad.length === 0, 'the unmutated overlay twin passes the same scenarios', bad.map((x) => x.name).join(' | ').slice(0, 300));
      } finally { ovT.stop(); }
      const onlyM = process.env.ARENA_MUTANTS ? new Set(process.env.ARENA_MUTANTS.split(',')) : null;     // ARENA_MUTANTS=M41,M42 runs just those
      for (const mu of MUTANTS) {
        if (onlyM && !onlyM.has(mu.id.split(' ')[0])) continue;
        const d = copyTree(PA, path.join(TMP, 'm' + results.length));
        try { mutateFile(d, mu.file, mu.from, mu.to); } catch (e) { C.ok(false, 'mutant ' + mu.id + ' could not be applied', e.message); results.push({ id: mu.id, killed: false, why: 'not applied' }); continue; }
        const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE });
        const RM = recorder();
        try { for (const n of mu.run) { try { await SCENARIOS[n](page, RM, ov.url); } catch (e) { RM.ok(false, 'scenario ' + n + ' crashed on the mutant', e.message); } } } finally { ov.stop(); }
        const failed = RM.r.filter((x) => !x.ok);
        results.push({ id: mu.id, killed: failed.length > 0, by: failed.length ? failed[0].name.slice(0, 90) : null });
        if (process.env.ARENA_MUTANT_ALL) for (const x of failed) console.log('    ' + mu.id.split(' ')[0] + ' fails: ' + x.name.slice(0, 150));       // ARENA_MUTANT_ALL=1: every case a mutant fails, not just the first
      }
    });
    for (const r of results) { console.log((r.killed ? 'killed  ' : 'SURVIVED') + ' ' + r.id + (r.by ? ' -- ' + r.by : '  <-- no case failed')); if (r.killed) killedN++; else survived++; }
    console.log('mutants: ' + killedN + '/' + results.length + ' killed');
    if (survived) C.ok(false, survived + ' mutant(s) survived', results.filter((r) => !r.killed).map((r) => r.id).join('; '));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
} finally { L.stopServer(server); }
C.finish();
