#!/usr/bin/env node
// tools/pokemonarena_sound_page_test.mjs -- the browser half of the SOUND stage (MU3): the mixer, the SOUND panel and the music director on the REAL pages.
//
//   node tools/pokemonarena_sound_page_test.mjs                   # sessions + mutants
//   node tools/pokemonarena_sound_page_test.mjs --no-mutants
//   ARENA_PORT=8104 ARENA_CDP=9355 ARENA_OUT=<dir for screenshots>   (ARENA_BASE=<url> tests an already running server, e.g. an overlay)
//
// NOTHING HERE CAN REACH AN AUDIO DEVICE. Chrome runs with --mute-audio (tools/headless_cdp.mjs) and window.AudioContext is the recording double of
// tools/pokemonarena_sound_lib.mjs, installed before any page script runs. The music engine (music.js) and the song map (music_map.js) are STAND-INS with the
// shared contract's exact signatures (window.__arenaSoundModules, the seam sound_system.js documents); an extra session runs the REAL modules when they exist.
//
// SESSIONS (a fresh throwaway Chrome each)
//   hub      (a) no AudioContext exists before the first activation; the default is sound ON; the controller-only prompt; (b) the first key creates and resumes one
//            and the hub song starts; the panel with MOUSE: slider click, wheel, - / + with hold-to-repeat, mute, test cry, soundtrack switch, close; (f) persistence,
//            migration of arena.sound; (h) a hidden tab; the M key
//   keys     the panel with the KEYBOARD alone (Tab, arrows, Home / End, Enter, Esc)
//   pad      (c)(d) a CONTROLLER alone: the prompt stays (a pad is not an activation), the SOUND row, every control through the d-pad + A + B, no context is created
//   touch    the panel with TOUCH at 390x844 @3x
//   battle   (g) hub -> battle -> result asks for the right music keys in order; menu / hit / animator sounds; the pause menu's SOUND row; ducking
//   editor   the header Sound button, the keyboard and the controller on the Team Builder's panel (the page's own enableDomNav)
//   (j)      the same panel (same controls, same words) on the hub, the battle page and the editor
// MUTANTS (an overlay copy of pokemonarena/ with ONE defect each; the unmutated twin stays quiet): the persistence write removed, mute a no-op, a slider that maps
// off by one percent, the editor without enableDomNav.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ARENA_PORT = process.env.ARENA_PORT || '8104';
process.env.ARENA_CDP = process.env.ARENA_CDP || '9355';
const L = await import('./pokemonarena_hub_lib.mjs');
const { withBrowser, acquireBrowserLock } = await import('./headless_cdp.mjs');
// the machine-wide browser lock is contended by many agents and withBrowser gives up after 15 minutes: take it ourselves with a long patience and a fast poll, then run withBrowser unlocked
const lockedBrowser = async (o, fn) => { const release = await acquireBrowserLock({ timeoutMs: 4 * 3600e3, pollMs: 1000 }); try { return await withBrowser({ ...o, lock: false }, fn); } finally { release(); } };
const { AUDIO_DOUBLE_SRC, STUB_MODULES_SRC } = await import('./pokemonarena_sound_lib.mjs');
const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');

const { root, BASE, sleep, J, errsOf, PAD_DOUBLE, addInit, elementCentre, loadPct } = L;
const ARGS = new Set(process.argv.slice(2));
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-sound-shots');
const PA = process.env.ARENA_PA || path.join(root, 'pokemonarena');       // ARENA_PA: test an overlay copy of the tree (the mutants copy this directory)
const C = L.makeCounter('sound-page');
let cdp = L.CDP0;
const HUB = '__arenaHub', BAT = '__arenaBattle';
const REAL_MODULES = fs.existsSync(path.join(PA, 'js', 'music.js')) && fs.existsSync(path.join(PA, 'js', 'music_map.js'));

/* ------------------------------------------------------------------------------------------------ helpers */
const head = (s) => console.log('\n== ' + s);
const recorder = () => { const r = []; return { r, ok: (cond, name, detail) => { r.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail).slice(0, 300) }); return !!cond; } }; };
const feed = (R) => { for (const x of R.r) C.ok(x.ok, x.name, x.detail); };
// the gain law, restated INDEPENDENTLY of audio_mixer.js: unity at the bus's default slider position (master .7, music .6, fx .8), the square below it, a straight climb to +3 dB at 1.0
const GAIN_DEF = { master: 0.7, music: 0.6, fx: 0.8 };
const gainOf = (v, bus = 'master') => { const d = GAIN_DEF[bus]; const r = v <= d ? (v / d) * (v / d) : 1 + (Math.pow(10, 3 / 20) - 1) * ((v - d) / (1 - d)); return Math.round(r * 1e6) / 1e6; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// the doubles (AudioContext, stand-in music / map modules, synthetic controller) are installed ONCE per browser session (installDoubles); a scenario only navigates
async function installDoubles(page) { await addInit(page, AUDIO_DOUBLE_SRC); await addInit(page, STUB_MODULES_SRC); await addInit(page, PAD_DOUBLE); }
async function open(page, url) { await page.navigate(url); }
// a fresh profile for the next scenario: same origin, empty storage
async function fresh(page, base) { await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}'); }
const hubReady = (page) => page.waitFor(`window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
const batReady = (page) => page.waitFor(`window.${BAT} && ${BAT}.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
const edReady = (page) => page.waitFor(`window.__editor && __editor.ready && __editor.input && window.__arenaSound`, { timeoutMs: 60000 });
const st = (page) => page.eval(`window.__arenaSound.state()`);
const gains = (page) => page.eval(`(() => { const g = window.__snd.gains; return g.length < 3 ? null : { master: g[0].gain.target, music: g[1].gain.target, fx: g[2].gain.target, ids: g.slice(0, 3).map((x) => x.id) }; })()`);
const ctxState = (page) => page.eval(`window.__snd.ctxs[0] ? window.__snd.ctxs[0].state : null`);
const settings = (page) => page.eval(`window.__arenaSound.mixer.settings()`);
const stored = (page) => page.eval(`localStorage.getItem('arena.audio')`);
const rect = (page, sel) => elementCentre(page, sel);
const sndRect = (page, snd) => page.eval(`(() => { const e = document.querySelector('[data-snd="${snd}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const panelOpen = (page) => page.eval(`(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden && d.getClientRects().length > 0; })()`);
const sliderVal = (page, bus) => page.eval(`Number(document.querySelector('[data-snd="slider-${bus}"]').value)`);
const active = (page) => page.eval(`(() => { const a = document.activeElement; return a ? (a.dataset && a.dataset.snd) || a.id || a.tagName : null; })()`);
const sleepFrame = () => sleep(120);

async function key(page, name, hold = 35) {
  const K = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], a: ['Enter', 'Enter', 13], esc: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9], home: ['Home', 'Home', 36], end: ['End', 'End', 35], m: ['m', 'KeyM', 77], p: ['p', 'KeyP', 80], space: [' ', 'Space', 32], b: ['Backspace', 'Backspace', 8], shift: ['Shift', 'ShiftLeft', 16] }[name];
  const text = name === 'a' ? '\r' : name === 'space' ? ' ' : name === 'm' ? 'm' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: K[0], code: K[1], windowsVirtualKeyCode: K[2], ...(text ? { text } : {}) });
  await sleep(hold);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: K[0], code: K[1], windowsVirtualKeyCode: K[2] });
  await sleep(30);
}
const PADIDX = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1, start: 9 };
async function pad(page, name, hold = 80) {
  const idx = PADIDX[name];
  await page.eval(`(() => { if (!window.__w1woke) { window.__w1woke = 1; window.dispatchEvent(new Event('gamepadconnected')); } window.__pad.buttons[${idx}] = 1; })()`); await sleep(hold);
  await page.eval(`window.__pad.buttons[${idx}] = 0`); await sleep(hold);
}
async function clickAt(page, x, y) { await page.click(x, y); await sleep(60); }
async function wheelAt(page, x, y, dy) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); await sleep(120); }

/* ------------------------------------------------------------------------------------------------ scenarios (each returns nothing; checks go to R) */

// (a)(b) before / at the first activation, on the hub; the music starts with the stub engine
async function scnFirstActivation(page, R, base) {
  await open(page, base + '/pokemonarena/');
  await hubReady(page);
  const s0 = await st(page);
  R.ok((await page.eval('window.__snd.ctor')) === 0 && s0.mixer.created === false, '(a) hub: NO AudioContext exists before the first activation', J({ ctor: await page.eval('window.__snd.ctor'), created: s0.mixer.created }));
  R.ok(s0.mixer.settings.muted === false && s0.mixer.settings.master === 0.7 && s0.mixer.settings.music === 0.6 && s0.mixer.settings.fx === 0.8, 'hub: the default policy is sound ON (master 0.7, music 0.6, fx 0.8, not muted)', J(s0.mixer.settings));
  R.ok((await stored(page)) === null && (await page.eval(`localStorage.getItem('arena.sound')`)) === null, 'hub: a default page stores nothing (no arena.audio, no arena.sound)');
  R.ok((await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: on', 'hub: the header button reads "Sound: on" by default');
  const pr = await page.eval(`(() => { const p = document.getElementById('soundPrompt'); return p ? { hidden: p.hidden, text: p.textContent, btn: !!p.querySelector('button'), pe: getComputedStyle(p).pointerEvents } : null; })()`);
  R.ok(pr && pr.hidden === false && /Click, tap or press/.test(pr.text) && /controller/i.test(pr.text) && !pr.btn && pr.pe === 'none', '(c) hub: before the first activation the page shows the "click, tap or press a key" prompt and says a controller button cannot start it; it is text only and ignores the pointer (it can never swallow a press)', J(pr));
  await key(page, 'down');                                   // a key press: an activation
  await page.waitFor(`window.__snd.ctor === 1 && window.__snd.ctxs[0].state === 'running'`, { timeoutMs: 8000 });
  R.ok(true, '(b) hub: the first key press creates exactly one AudioContext and it is running');
  const pr2 = await page.eval(`document.getElementById('soundPrompt').hidden`);
  R.ok(pr2 === true, 'hub: the prompt goes away once the context runs');
  await page.waitFor(`window.__sndMusic && window.__sndMusic.play.length >= 1`, { timeoutMs: 8000 });
  const ml = await page.eval(`({ create: window.__sndMusic.create, play: window.__sndMusic.play })`);
  const g = await gains(page);
  R.ok(ml.create.length === 1 && ml.create[0].soundtrack === 'soulgold' && ml.create[0].romLen === 33554432 && ml.create[0].dest === g.ids[1] && ml.create[0].fx === g.ids[2], 'hub: the music engine is created with the SoulGold ROM, the MUSIC bus and the FX bus', J(ml.create));
  R.ok(ml.play.length === 1 && ml.play[0].index === 10 && ml.play[0].fadeInMs === 400, 'hub: the hub song (key "hub", index 10 in the stand-in map) starts with a 400 ms fade-in', J(ml.play));
  R.ok(near(g.master, 1) && near(g.music, 1) && near(g.fx, 1), 'hub: at the default slider positions (0.7 / 0.6 / 0.8) the three buses sit at gain EXACTLY 1.0 (the real game\'s own level)', J(g));
  const errs = errsOf(page).filter((e) => !/favicon|\[sound\]/.test(e));
  R.ok(errs.length === 0, 'hub: no page or console error through first activation', J(errs));
}

// the panel with the MOUSE (d)(e): sliders, wheel, - / + hold, mute, test cry, close
async function scnMouse(page, R) {
  await page.click(...(Object.values(await rect(page, '#soundBtn')).slice(0, 2))); await sleep(200);
  R.ok(await panelOpen(page), '(d) mouse: clicking the header Sound button opens the SOUND panel');
  R.ok(await page.eval(`${HUB}.dialogOpen() && document.body.dataset.dialog === 'open'`), 'mouse: the hub knows a dialog is open (its canvas input is parked)');
  const lbl = await page.eval(`[...document.querySelectorAll('#soundDialog label')].map((l) => l.textContent)`);
  R.ok(J(lbl) === J(['Master', 'Music', 'Effects and cries']), 'mouse: three sliders: Master, Music, Effects and cries', J(lbl));
  // click the Music slider at 25 % of its width
  const mr = await sndRect(page, 'slider-music');
  const before = await gains(page), sb = await settings(page);
  await clickAt(page, mr.l + mr.w * 0.25, mr.cy);
  const v = await sliderVal(page, 'music'), s1 = await settings(page), g1 = await gains(page);
  R.ok(v % 5 === 0 && Math.abs(v - 25) <= 8 && s1.music === v / 100 && near(g1.music, gainOf(v / 100, 'music')), '(d) mouse: clicking the Music slider at 25% sets music to a multiple of 5 near 25 and moves the MUSIC bus to its square', J({ v, music: s1.music, gain: g1.music }));
  R.ok(s1.master === sb.master && s1.fx === sb.fx && g1.master === before.master && g1.fx === before.fx, 'mouse: the Music slider moved ONLY the music bus (master and fx unchanged)');
  R.ok((await stored(page)) && JSON.parse(await stored(page)).music === v / 100, 'mouse: the new music volume is stored in arena.audio');
  // wheel over the Effects slider: one notch up = +5
  const fr = await sndRect(page, 'slider-fx');
  const f0 = await sliderVal(page, 'fx');
  await wheelAt(page, fr.cx, fr.cy, -100);
  const f1 = await sliderVal(page, 'fx');
  R.ok(f1 === Math.min(100, f0 + 5), 'mouse: one wheel notch over the Effects slider is +5%', J({ f0, f1 }));
  await wheelAt(page, fr.cx, fr.cy, 100); await wheelAt(page, fr.cx, fr.cy, 100);
  R.ok((await sliderVal(page, 'fx')) === f1 - 10, 'mouse: two notches down are -10%');
  // the - button: one click = -5 on Master
  const m0 = await sliderVal(page, 'master');
  const dn = await sndRect(page, 'down-master');
  await clickAt(page, dn.cx, dn.cy);
  R.ok((await sliderVal(page, 'master')) === m0 - 5 && (await settings(page)).master === (m0 - 5) / 100, 'mouse: the - button lowers Master by 5%', J({ m0, now: await sliderVal(page, 'master') }));
  // hold + : repeats (400 ms delay, then every 90 ms)
  const up = await sndRect(page, 'up-music');
  const u0 = await sliderVal(page, 'music');
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: up.cx, y: up.cy, button: 'left', clickCount: 1 });
  await sleep(1000);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: up.cx, y: up.cy, button: 'left', clickCount: 1 });
  const u1 = await sliderVal(page, 'music'); await sleep(400); const u2 = await sliderVal(page, 'music');
  R.ok(u1 >= Math.min(100, u0 + 15) && u1 === u2, 'mouse: holding + repeats (>= 3 steps in one second) and stops on release', J({ u0, u1, u2 }));
  // test cry through the fx bus
  const starts0 = await page.eval('window.__snd.start');
  const tr = await sndRect(page, 'test');
  await clickAt(page, tr.cx, tr.cy);
  const cry = await page.eval(`(() => { const L = window.__snd; const src = L.sources[L.sources.length - 1]; const gn = src && src.out[0]; return { starts: L.start, srcOut: gn ? gn.id : null, gnOut: gn && gn.out[0] ? gn.out[0].id : null, fx: L.gains[2].id }; })()`);
  R.ok(cry.starts === starts0 + 1 && cry.gnOut === cry.fx, '(d) mouse: the TEST button plays a cry and it is routed source -> cry gain -> the FX bus', J(cry));
  // mute (e)
  const mt = await sndRect(page, 'mute');
  const susp0 = await page.eval('window.__snd.suspend');
  await clickAt(page, mt.cx, mt.cy);
  await sleep(300);
  const ms = await settings(page), mg = await gains(page);
  R.ok(ms.muted === true && mg.master === 0 && mg.music > 0, '(e) mouse: MUTE sets muted, ramps the master bus to exactly 0 and leaves the music bus where it was', J({ muted: ms.muted, master: mg.master, music: mg.music }));
  R.ok((await ctxState(page)) === 'suspended' && (await page.eval('window.__snd.suspend')) === susp0 + 1, 'mouse: a muted page suspends its AudioContext (no CPU for silence)');
  R.ok((await page.eval(`window.__sndMusic.pause`)) >= 1, 'mouse: mute pauses the music engine');
  R.ok((await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: off' && JSON.parse(await stored(page)).muted === true, 'mouse: the header button reads "Sound: off" and the mute is stored');
  R.ok((await page.eval(`document.querySelector('[data-snd="mute"]').getAttribute('aria-pressed')`)) === 'true', 'mouse: the Mute button says it is pressed');
  const plays0 = await page.eval('window.__arenaSound.plays');
  await page.eval(`window.__arenaSound.playCry(25, 'normal')`);
  R.ok((await page.eval('window.__arenaSound.plays')) === plays0, 'mouse: while muted a cry is not started');
  await clickAt(page, mt.cx, mt.cy);
  await sleep(300);
  const us = await settings(page), ug = await gains(page);
  R.ok(us.muted === false && (await ctxState(page)) === 'running' && near(ug.master, gainOf(us.master, 'master')), '(e) mouse: UNMUTE resumes the context and restores the master bus to its slider position', J({ muted: us.muted, ctx: await ctxState(page), master: ug.master }));
  R.ok((await page.eval(`window.__sndMusic.resume`)) >= 1, 'mouse: unmute resumes the music engine (no restart: one play so far)');
  R.ok((await page.eval(`window.__sndMusic.play.length`)) === 1, 'mouse: the song was paused and resumed, never restarted');
  // soundtrack
  const stt = await page.eval(`[...document.querySelectorAll('[data-snd^="soundtrack-"][role="radio"]')].map((b) => ({ id: b.dataset.snd, label: b.textContent, checked: b.getAttribute('aria-checked') }))`);
  R.ok(J(stt.map((x) => x.label)) === J(['SoulGold', 'Ultra Violet']) && stt[0].checked === 'true' && stt[1].checked === 'false', 'mouse: the soundtrack choice lists SoulGold (selected) and Ultra Violet', J(stt));
}

// (i) soundtrack switch: lazy fetch with progress, music rebuilt on the new ROM, remembered
async function scnSoundtrack(page, R) {
  const uv = await sndRect(page, 'soundtrack-ultraviolet');
  R.ok((await page.eval('window.__sndUvFetched || 0')) === 0, '(i) the Ultra Violet ROM is NOT fetched until it is chosen');
  await clickAt(page, uv.cx, uv.cy);
  await page.waitFor(`window.__sndUvFetched === 1 && window.__arenaSound.mixer.soundtrack() === 'ultraviolet'`, { timeoutMs: 15000 });
  R.ok(true, '(i) choosing Ultra Violet fetches its ROM once and switches the soundtrack');
  await page.waitFor(`window.__sndMusic.create.length === 2 && window.__sndMusic.play.length === 2`, { timeoutMs: 8000 });
  const ml = await page.eval(`({ create: window.__sndMusic.create, play: window.__sndMusic.play, disposed: window.__sndMusic.dispose })`);
  R.ok(ml.create[1].soundtrack === 'ultraviolet' && ml.create[1].romLen === 16777216 && ml.play[1].index === 110 && ml.disposed === 1, '(i) the old engine is disposed, a new one is built on the Ultra Violet ROM and the hub song of that soundtrack (110) plays', J(ml));
  R.ok(JSON.parse(await stored(page)).soundtrack === 'ultraviolet' && (await page.eval(`document.querySelector('[data-snd="soundtrack-ultraviolet"]').getAttribute('aria-checked')`)) === 'true', '(i) the choice is stored and shown');
}

// persistence across a reload (f) and the migration of arena.sound
async function scnPersistence(page, R, base) {
  const st0 = (await settings(page)).soundtrack;                      // whatever soundtrack the earlier scenarios left (it must survive the reload too)
  await page.eval(`(() => { const m = window.__arenaSound.mixer; m.setVolume('master', 0.55); m.setVolume('music', 0.25); m.setVolume('fx', 0.95); m.setMuted(true); })()`);
  const before = await stored(page);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  const s = await settings(page);
  R.ok(J(s) === J({ v: 1, master: 0.55, music: 0.25, fx: 0.95, muted: true, soundtrack: st0 }) && (await stored(page)) === before, '(f) settings persist across a reload (master, music, fx, mute)', J(s));
  R.ok((await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: off' && (await page.eval('window.__snd.ctor')) === 0, '(f) after the reload a muted page says "Sound: off" and still has no AudioContext');
  R.ok((await page.eval(`document.getElementById('soundPrompt').hidden`)) === true, 'a muted page shows no "press any key" prompt (nothing to start)');
  R.ok((await page.eval(`${HUB}.view().menu.rows.map((r) => r.label).find((l) => /^SOUND/.test(l))`)) === 'SOUND: OFF', 'the hub SOUND row shows OFF while muted');
  // migration of the old key
  await page.eval(`localStorage.removeItem('arena.audio'); localStorage.setItem('arena.sound', '0');`);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  const m0 = await settings(page);
  R.ok(m0.muted === true && JSON.parse(await stored(page)).muted === true && (await page.eval(`localStorage.getItem('arena.sound')`)) === '0', 'migration: the old arena.sound "0" becomes muted and arena.audio is written (the old key is left alone)', J(m0));
  await page.eval(`localStorage.removeItem('arena.audio'); localStorage.setItem('arena.sound', '1');`);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  const m1 = await settings(page);
  R.ok(m1.muted === false && m1.master === 0.7 && JSON.parse(await stored(page)).v === 1, 'migration: the old arena.sound "1" becomes sound on with the default volumes', J(m1));
  await page.eval(`localStorage.removeItem('arena.audio'); localStorage.removeItem('arena.sound'); localStorage.setItem('arena.audio', '{"master":"loud","music":7,"muted":"no"}')`);
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  const m2 = await settings(page);
  R.ok(m2.master === 0.7 && m2.music === 1 && m2.muted === false, 'a hostile arena.audio is repaired field by field and the page still boots', J(m2));
  await page.eval(`localStorage.removeItem('arena.audio')`);
}

// (h) hidden tab, the M key
async function scnHiddenAndM(page, R, base) {
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  await key(page, 'down'); await page.waitFor(`window.__snd.ctxs[0] && window.__snd.ctxs[0].state === 'running' && window.__sndMusic.play.length === 1`, { timeoutMs: 8000 });
  await page.eval(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(300);
  R.ok((await ctxState(page)) === 'suspended' && (await page.eval('window.__sndMusic.pause')) === 1, '(h) a hidden tab suspends the AudioContext and pauses the music');
  await page.eval(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(300);
  R.ok((await ctxState(page)) === 'running' && (await page.eval('window.__sndMusic.resume')) === 1 && (await page.eval('window.__sndMusic.play.length')) === 1, '(h) coming back resumes the context and the same song');
  // M
  await page.eval(`${HUB}.canvas.focus()`);
  await key(page, 'm'); await sleep(250);
  R.ok((await settings(page)).muted === true && (await page.eval(`document.getElementById('soundToast').hidden`)) === false && /muted/i.test(await page.eval(`document.getElementById('soundToast').textContent`)), '(e) the M key mutes (and says so)');
  R.ok((await gains(page)).master === 0, 'M: the master bus is 0');
  await key(page, 'm'); await sleep(250);
  R.ok((await settings(page)).muted === false && (await ctxState(page)) === 'running' && near((await gains(page)).master, gainOf(0.7, 'master')), '(e) M again unmutes and restores the level');
  // M does not fire inside a text field
  await page.eval(`(() => { const i = document.createElement('input'); i.id = 'tmpText'; i.type = 'text'; document.body.appendChild(i); i.focus(); })()`);
  await key(page, 'm'); await sleep(150);
  R.ok((await settings(page)).muted === false, 'M typed into a text field does not mute');
  await page.eval(`document.getElementById('tmpText').remove()`);
  // M with the Controls panel capturing a key to bind
  await page.eval(`${HUB}.canvas.focus()`);
}

async function scnKeyboard(page, R, base) {
  await page.navigate(base + '/pokemonarena/'); await hubReady(page);
  await page.eval(`${HUB}.pause(true); ${HUB}.canvas.focus()`);
  await key(page, 'down');                                  // activation + cursor moves to row 1
  await page.waitFor(`window.__snd.ctor === 1`, { timeoutMs: 8000 });
  // the SOUND row: found by its label (other stages add rows to the hub's main menu)
  const cur = await page.eval(`${HUB}.model.state().cursor.main`);
  const soundRow = await page.eval(`${HUB}.view().menu.rows.findIndex((r) => /^SOUND/.test(r.label))`);
  for (let i = cur; i < soundRow; i++) await key(page, 'down');
  await key(page, 'a'); await sleep(300);
  R.ok(await panelOpen(page), '(d) keyboard: Enter on the hub SOUND row opens the SOUND panel (no longer a bare toggle)');
  R.ok((await active(page)) === 'slider-master', 'keyboard: the Master slider has the focus when the panel opens', await active(page));
  const m0 = await sliderVal(page, 'master');
  await key(page, 'left'); await key(page, 'left');
  R.ok((await sliderVal(page, 'master')) === m0 - 10 && (await settings(page)).master === (m0 - 10) / 100 && near((await gains(page)).master, gainOf((m0 - 10) / 100, 'master')), '(d) keyboard: Left twice lowers Master by 10% and moves the MASTER bus', J({ m0, now: await sliderVal(page, 'master') }));
  await key(page, 'home');
  R.ok((await sliderVal(page, 'master')) === 0 && (await gains(page)).master === 0, 'keyboard: Home puts Master at 0 (bus at 0)');
  await key(page, 'end');
  R.ok((await sliderVal(page, 'master')) === 100 && near((await gains(page)).master, gainOf(1, 'master')), 'keyboard: End puts Master at 100 (the bus at +3 dB = 1.4125: above the default position the gain climbs to +3 dB)');
  await key(page, 'tab'); await key(page, 'tab'); await key(page, 'tab');          // Master: [down-master? no: slider first] -> + -> out? find by landing
  // walk with Tab until the Mute button has the focus (bounded), then Enter
  let hops = 0; while ((await active(page)) !== 'mute' && hops++ < 20) await key(page, 'tab');
  R.ok((await active(page)) === 'mute', 'keyboard: Tab reaches the Mute button', await active(page));
  await key(page, 'a'); await sleep(300);
  R.ok((await settings(page)).muted === true && (await gains(page)).master === 0, '(e) keyboard: Enter on Mute mutes');
  await key(page, 'space'); await sleep(300);
  R.ok((await settings(page)).muted === false, 'keyboard: Space on Mute unmutes');
  // Esc from the Mute button closes in ONE press; and from a slider too
  await key(page, 'esc'); await sleep(300);
  R.ok(!(await panelOpen(page)) && (await page.eval(`!${HUB}.dialogOpen()`)), 'keyboard: Esc closes the panel in one press and the hub gets its input back');
  await page.eval(`document.getElementById('soundBtn').focus()`);
  await key(page, 'a'); await sleep(300);
  R.ok(await panelOpen(page), 'keyboard: Enter on the focused header Sound button opens the panel');
  await key(page, 'esc'); await sleep(300);
  R.ok(!(await panelOpen(page)), 'keyboard: Esc on a SLIDER also closes in one press');
  R.ok((await page.eval(`document.activeElement && document.activeElement.id`)) === 'soundBtn' || (await page.eval(`document.activeElement === ${HUB}.canvas`)), 'keyboard: the focus returns to the page (header button or canvas)');
}

async function scnPad(page, R, base) {
  await open(page, base + '/pokemonarena/', { pad: true });
  await hubReady(page);
  await page.eval(`${HUB}.pause(true); ${HUB}.canvas.focus()`);
  await pad(page, 'down');
  R.ok((await page.eval('window.__snd.ctor')) === 0, '(c) controller: a controller button is NOT an activation: still no AudioContext after a d-pad press');
  // ROUND 4: a controller button is not an activation, but it DISMISSES the hint (a pad-only visitor must not be stuck with it); the press still moved the page
  const pr = await page.eval(`({ hidden: document.getElementById('soundPrompt').hidden, why: window.__arenaSound.state().promptWhy, prompt: window.__arenaSound.state().prompt })`);
  R.ok(pr.hidden === true && pr.prompt === false && pr.why === 'pad', '(c) controller: a controller button hides the "click, tap or press a key" hint (it cannot start the sound, but it must not leave a pad-only visitor staring at it)', J(pr));
  const cur = await page.eval(`${HUB}.model.state().cursor.main`);
  const soundRow = await page.eval(`${HUB}.view().menu.rows.findIndex((r) => /^SOUND/.test(r.label))`);
  for (let i = cur; i < soundRow; i++) await pad(page, 'down');
  await pad(page, 'a'); await sleep(300);
  R.ok(await panelOpen(page), '(d) controller: A on the SOUND row opens the SOUND panel');
  R.ok((await active(page)) === 'slider-master', 'controller: the Master slider has the focus');
  const m0 = await sliderVal(page, 'master');
  await pad(page, 'a'); await pad(page, 'right'); await pad(page, 'right'); await pad(page, 'b');
  R.ok((await sliderVal(page, 'master')) === Math.min(100, m0 + 10) && (await settings(page)).master === Math.min(100, m0 + 10) / 100, '(d) controller: A on a slider starts adjusting, right twice is +10%, B finishes', J({ m0, now: await sliderVal(page, 'master') }));
  R.ok(await panelOpen(page), 'controller: B finished adjusting; the panel is still open');
  await pad(page, 'down'); await pad(page, 'a'); await pad(page, 'left'); await pad(page, 'left'); await pad(page, 'left'); await pad(page, 'b');
  R.ok((await active(page)) === 'slider-music' && (await sliderVal(page, 'music')) === 45 && (await settings(page)).music === 0.45, '(d) controller: down then A, left x3, B puts Music at 45%', J({ active: await active(page), music: await sliderVal(page, 'music') }));
  await pad(page, 'down'); await pad(page, 'a'); await pad(page, 'up'); await pad(page, 'b');
  R.ok((await active(page)) === 'slider-fx' && (await sliderVal(page, 'fx')) === 90, 'controller: up/down while adjusting change by 10% (Effects 80 -> 90)', J({ fx: await sliderVal(page, 'fx') }));
  let hops = 0; while ((await active(page)) !== 'mute' && hops++ < 8) await pad(page, hops < 3 ? 'down' : 'left');
  R.ok((await active(page)) === 'mute', 'controller: the d-pad reaches the Mute button', await active(page));
  await pad(page, 'a'); await sleep(200);
  R.ok((await settings(page)).muted === true, '(e) controller: A on Mute mutes');
  R.ok((await page.eval('window.__snd.ctor')) === 0, 'controller: through the whole panel session no AudioContext was created (a pad cannot start the sound)');
  const sg = await page.eval(`(() => { const s = window.__arenaSound.mixer.settings(); return s; })()`);
  await pad(page, 'a'); await sleep(200);
  R.ok((await settings(page)).muted === false, 'controller: A again unmutes');
  await pad(page, 'b'); await sleep(300);
  R.ok(!(await panelOpen(page)) && (await page.eval(`!${HUB}.dialogOpen()`)), 'controller: B closes the panel and the hub gets its input back');
  // a later key press is an activation: the context is created and the controller-chosen levels are applied
  await key(page, 'down'); await page.waitFor(`window.__snd.ctor === 1 && window.__snd.ctxs[0].state === 'running'`, { timeoutMs: 8000 });
  const g = await gains(page);
  R.ok(near(g.master, gainOf(sg.master, 'master')) && near(g.music, gainOf(0.45, 'music')) && near(g.fx, gainOf(0.9, 'fx')), 'controller: at the first key press the levels the controller chose (master, 0.45, 0.9) are the ones applied', J(g));
}

async function scnTouch(page, R, base) {
  await page.setViewport(390, 844, { mobile: true, dpr: 3 });
  await open(page, base + '/pokemonarena/');
  await hubReady(page);
  R.ok((await page.eval('window.__snd.ctor')) === 0, 'touch: no AudioContext before the first tap');
  const cov = await page.eval(`(() => { const c = document.querySelector('canvas#hub'); const r = c.getBoundingClientRect(); const pts = [[r.left + r.width / 2, r.top + 12], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 20, r.top + r.height - 12]]; return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.id || e.tagName : null; }); })()`);
  R.ok(cov.every((x) => x === 'hub'), 'touch: nothing covers the picture before the first tap, so the first tap reaches the menu (the start-sound prompt must not swallow it)', J(cov));
  const sb = await rect(page, '#soundBtn');
  await page.tap(sb.x, sb.y); await sleep(500);
  R.ok((await page.eval('window.__snd.ctor')) === 1 && await panelOpen(page), '(b) touch: the first tap creates the AudioContext and (on the Sound button) opens the panel');
  await page.waitFor(`window.__snd.ctxs[0].state === 'running'`, { timeoutMs: 8000 });
  const tall = await page.eval(`[...document.querySelectorAll('#soundDialog button, #soundDialog input[type=range]')].filter((e) => e.getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.snd, w: Math.round(r.width), h: Math.round(r.height) }; })`);
  const small = tall.filter((t) => t.h < 44 || t.w < 44);
  R.ok(small.length === 0, 'touch: every control in the panel is at least 44 x 44 css px', J(small));
  const noscroll = await page.eval(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`);
  R.ok(noscroll, 'touch: the panel causes no horizontal page scroll at 390 px');
  const fr = await sndRect(page, 'slider-fx');
  await page.tap(fr.l + fr.w * 0.8, fr.cy); await sleep(200);
  const v = await sliderVal(page, 'fx');
  R.ok(v % 5 === 0 && Math.abs(v - 80) <= 8 && (await settings(page)).fx === v / 100, '(d) touch: tapping the Effects slider at 80% sets it near 80', J({ v }));
  const up = await sndRect(page, 'up-master'); const m0 = await sliderVal(page, 'master');
  await page.tap(up.cx, up.cy); await sleep(150);
  R.ok((await sliderVal(page, 'master')) === Math.min(100, m0 + 5), 'touch: tapping + raises Master by 5%');
  // press and hold + with a finger repeats
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: up.cx, y: up.cy }] });
  await sleep(1000);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  R.ok((await sliderVal(page, 'master')) >= Math.min(100, m0 + 5) + 5 || (await sliderVal(page, 'master')) === 100, 'touch: holding + with a finger repeats', J({ master: await sliderVal(page, 'master') }));
  const mt = await sndRect(page, 'mute');
  await page.tap(mt.cx, mt.cy); await sleep(300);
  R.ok((await settings(page)).muted === true && (await gains(page)).master === 0, '(e) touch: tapping Mute mutes');
  await page.tap(mt.cx, mt.cy); await sleep(300);
  R.ok((await settings(page)).muted === false, 'touch: tapping Mute again unmutes');
  const shotA = path.join(OUT, 'hub_phone_panel.png'); await page.screenshot(shotA);
  // a phone held sideways (844 x 390): the panel is taller than the screen, so a finger that scrolls it will often start ON a slider. The scroll must not move the slider.
  await page.setViewport(844, 390, { mobile: true, dpr: 3 }); await sleep(400);
  const mr = await sndRect(page, 'slider-music'); const v0 = await sliderVal(page, 'music'); const sc0 = await page.eval(`document.getElementById('soundDialog').scrollTop`);
  const fx = mr.l + mr.w * 0.9;      // far from the thumb, so a jump of the thumb to the finger would be visible
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: Math.min(mr.cy, 360) }] });
  for (let d = 20; d <= 160; d += 20) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx, y: Math.min(mr.cy, 360) - d }] }); await sleep(16); }
  await sleep(120);
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(300);
  const v1 = await sliderVal(page, 'music'); const sc1 = await page.eval(`document.getElementById('soundDialog').scrollTop`);
  R.ok(v1 === v0, 'touch: a vertical swipe that starts ON the Music slider (sideways phone, 844x390) does not move the slider (' + v0 + ' -> ' + v1 + '; the panel scrolled from ' + Math.round(sc0) + ' to ' + Math.round(sc1) + ' px)', J({ v0, v1, sc0, sc1 }));
  await page.setViewport(390, 844, { mobile: true, dpr: 3 }); await sleep(300);
  const cl = await sndRect(page, 'close2') || await sndRect(page, 'close');
  await page.tap(cl.cx, cl.cy); await sleep(300);
  R.ok(!(await panelOpen(page)), 'touch: Close closes the panel');
  return { shotA };
}

/* ---- battle ---- */
async function scnBattle(page, R, base) {
  await open(page, base + '/pokemonarena/battle.html?seed=7&format=3v3&cpu=hard&speed=fast');
  await batReady(page);
  R.ok((await page.eval('window.__snd.ctor')) === 0, '(a) battle: no AudioContext before the first activation');
  await page.waitFor(`${BAT}.mode === 'preview'`, { timeoutMs: 30000 });
  await key(page, 'shift');                                   // a key: activation
  await page.waitFor(`window.__snd.ctxs[0] && window.__snd.ctxs[0].state === 'running' && window.__sndMusic && window.__sndMusic.play.length >= 1`, { timeoutMs: 10000 });
  await sleep(200);
  const idx = () => page.eval(`window.__sndMusic.play.map((p) => p.index)`);
  R.ok(J(await idx()) === J([12]), '(g) battle: team preview asks for the "preview" song (12)', J(await idx()));
  // pick three and confirm
  await page.eval(`(() => { const a = window.${BAT}; for (const i of [0, 1, 2]) a.scene.choose.preview(i); })()`);
  await sleep(100);
  await page.eval(`window.${BAT}.press('a')`);                // YES
  await page.waitFor(`${BAT}.mode === 'action'`, { timeoutMs: 60000 }).catch(async () => { for (let n = 0; n < 200 && (await page.eval(`${BAT}.mode`)) !== 'action'; n++) { await page.eval(`window.${BAT}.press('a')`); await sleep(60); } });
  await sleep(300);
  R.ok(J(await idx()) === J([12, 22]), '(g) battle: after the team is chosen the CPU-level song plays (cpu=hard -> key battle_hard -> 22)', J(await idx()));
  // menu sounds through REAL key events
  const e0 = await page.eval('window.__sndMusic.effect.length');
  await page.eval(`${BAT}.canvas.focus()`);
  await key(page, 'right'); await sleep(120);
  const eff = await page.eval('window.__sndMusic.effect');
  R.ok(eff.length === e0 + 1 && eff[e0].index === 200, '(g) battle: moving the cursor in the action menu plays the cursor sound (se_cursor = 200)', J(eff.slice(e0)));
  // pause menu: P opens it, the music is ducked; SOUND row opens the panel
  await key(page, 'p'); await sleep(250);
  const gd = await gains(page);
  R.ok((await page.eval(`${BAT}.mode`)) === 'menu' && near(gd.music, gainOf(0.6, 'music') * 0.5), '(g) battle: the pause menu ducks the music to half (bus = 0.5 x its level)', J({ mode: await page.eval(`${BAT}.mode`), music: gd.music }));
  const rows = await page.eval(`${BAT}.scene.S.menu.rows.slice()`);
  const si = rows.findIndex((r) => r.startsWith('SOUND'));
  R.ok(si >= 0 && /SOUND: ON/.test(rows[si]), 'battle: the pause menu row reads "SOUND: ON" by default', J(rows));
  for (let i = 0; i < si; i++) { await key(page, 'down'); await sleep(60); }
  const e1 = await page.eval('window.__sndMusic.effect.length');
  await key(page, 'a'); await sleep(400);
  R.ok(await panelOpen(page), '(d) battle: A on the pause menu SOUND row opens the same SOUND panel');
  R.ok(await page.eval(`${BAT}.controlsOpen === true`), 'battle: the clock and the scene input are parked while the panel is open');
  R.ok(near((await gains(page)).music, gainOf(0.6, 'music')), 'battle: with the panel open the music is back at full level (so the sliders can be judged)');
  const shotB = path.join(OUT, 'battle_pause_panel.png'); await page.screenshot(shotB);
  await key(page, 'left'); await key(page, 'left');
  await key(page, 'esc'); await sleep(500);
  R.ok(!(await panelOpen(page)) && (await page.eval(`${BAT}.mode`)) === 'menu' && (await page.eval(`${BAT}.scene.S.menu.cursor`)) === si, 'battle: closing the panel returns to the pause menu on the SOUND row', J({ mode: await page.eval(`${BAT}.mode`), cur: await page.eval(`${BAT}.scene.S.menu.cursor`), si }));
  R.ok((await settings(page)).master === 0.6 && (await page.eval(`${BAT}.controlsOpen === false`)), 'battle: the slider change (Left x2 = -10% on Master) is kept; the scene hears input again');
  void e1;
  await key(page, 'esc'); await sleep(300);                                          // leave the pause menu
  R.ok((await page.eval(`${BAT}.mode`)) !== 'menu' && near((await gains(page)).music, gainOf(0.6, 'music')), 'battle: leaving the pause menu restores the music level');
  // hit / faint / send-out / animator sounds through the scene's hooks
  const e2 = await page.eval('window.__sndMusic.effect.length');
  await page.eval(`(() => { const h = window.${BAT}.scene.hooks; h.onHit(1, { eff: 8192, crit: false }); h.onHit(1, { eff: 2048, crit: false }); h.onHit(1, { eff: 4096, crit: false }); h.onFaint(1, 25); })()`);
  const eff2 = (await page.eval('window.__sndMusic.effect')).slice(e2).map((x) => x.index);
  R.ok(J(eff2) === J([204, 205, 203, 206]), '(g) battle: super-effective / not-very-effective / normal hits and a faint play se_hit_super (204), se_hit_weak (205), se_hit_normal (203), se_faint (206)', J(eff2));
  const plays0 = await page.eval('window.__arenaSound.plays');
  await page.eval(`window.${BAT}.scene.hooks.onSendOut(0, 25)`);
  R.ok((await page.eval('window.__arenaSound.plays')) === plays0 + 1, 'battle: a send-out plays the Pokemon\'s ROM cry through the mixer (effects bus)');
  await page.eval(`window.${BAT}.scene.hooks.onSound(217, 0.5)`);
  const last = (await page.eval('window.__sndMusic.effect')).slice(-1)[0];
  R.ok(last.index === 217 && last.pan === 0.5, '(g) battle: the animator\'s onSound(index, pan) reaches music.playEffect unchanged', J(last));
  const e3 = await page.eval('window.__sndMusic.effect.length');
  await page.eval(`window.${BAT}.scene.hooks.onHit(1, { eff: 8192 })`);
  { const eh = (await page.eval('window.__sndMusic.effect')).slice(e3).map((x) => x.index);
    R.ok(J(eh) === J([204]), '(g) battle: the effectiveness sound STILL plays after the animator has delivered sounds of its own (the animator never delivers 12 / 13 / 14: it is the battle script\'s sound, so a hit with animator sounds around it must still make it)', J(eh)); }
  // the REAL scene: play turns (real key-equivalents on the live battle) until a damaging hit has landed; each real hit must have produced its effectiveness sound
  { await page.eval(`(() => { window.__hitRec = 0; const h = window.${BAT}.scene.hooks, oh = h.onHit; h.onHit = (s, i) => { window.__hitRec++; return oh && oh(s, i); }; })()`);
    const eBefore = (await page.eval('window.__sndMusic.effect')).length;
    for (let n = 0; n < 900 && (await page.eval('window.__hitRec')) < 2; n++) {
      const m = await page.eval(`${BAT}.mode`);
      if (m === 'result') break;
      if (m === 'party') { for (let i = 0; i < 6; i++) await page.eval(`(() => { try { ${BAT}.scene.choose.party(${i}); } catch (e) {} })()`); }
      else if (m === 'action') await page.eval(`window.${BAT}.scene.choose.action(0)`);          // FIGHT (the cursor was left on BAG by the menu-sound checks above)
      else if (m === 'moves') await page.eval(`window.${BAT}.scene.choose.move(0)`);
      else await page.eval(`window.${BAT}.press('a')`);
      await sleep(40);
    }
    const hitsSeen = await page.eval('window.__hitRec');
    const eff3 = (await page.eval('window.__sndMusic.effect')).slice(eBefore).map((x) => x.index);
    const effCount = eff3.filter((i) => i === 203 || i === 204 || i === 205).length;
    R.ok(hitsSeen >= 1 && effCount === hitsSeen, '(g) battle: in the REAL scene every damaging hit that landed (' + hitsSeen + ') made its effectiveness sound (' + effCount + ' of 203 / 204 / 205 among ' + eff3.length + ' effects): the empty list the coordinator saw is fixed', J({ hitsSeen, eff3: eff3.slice(0, 30) })); }
  // run the battle to its end: result music = jingle, then the result song
  await page.eval(`window.${BAT}.autoplay(600000, 'normal')`);
  await page.waitFor(`${BAT}.mode === 'result'`, { timeoutMs: 20000 });
  await sleep(500);
  const seq = await idx();
  const w = await page.eval(`${BAT}.ctl.winner`);
  const jingle = w === 0 ? 30 : w === 1 ? 31 : null;
  R.ok(seq.length === 3 && seq[2] === jingle, '(g) battle: the result screen starts the ' + (w === 0 ? 'victory' : 'defeat') + ' jingle (' + jingle + ') first', J(seq));
  await page.eval(`window.__sndMusicEnd(${jingle})`); await sleep(300);
  const seq2 = await idx();
  R.ok(seq2.length === 4 && seq2[3] === (w === 0 ? 40 : 41), '(g) battle: when the jingle ends the result music (' + (w === 0 ? 40 : 41) + ') starts: the whole sequence is preview 12, battle_hard 22, jingle, result', J(seq2));
  await page.eval(`window.__arenaSound.director.state()`);
  return { shotB };
}

/* ---- editor ---- */
async function scnEditor(page, R, base, { padSession = false } = {}) {
  await open(page, base + '/pokemonarena/editor.html', { pad: padSession });
  await edReady(page);
  R.ok((await page.eval('window.__snd.ctor')) === 0, '(a) editor: no AudioContext before the first activation');
  const hasBtn = await page.eval(`!!document.getElementById('soundBtn')`);
  R.ok(hasBtn, 'editor: the header has a Sound button');
  if (!padSession) {
    await page.eval(`document.getElementById('soundBtn').focus()`);
    await key(page, 'a'); await sleep(500);
    R.ok((await page.eval('window.__snd.ctor')) === 1 && await panelOpen(page), '(b)(d) editor: Enter on the header Sound button creates the context and opens the panel');
    await page.waitFor(`window.__sndMusic && window.__sndMusic.play.length >= 1`, { timeoutMs: 10000 });
    R.ok((await page.eval('window.__sndMusic.play[0].index')) === 11, 'editor: the editor song (key "editor", 11) starts');
    R.ok((await active(page)) === 'slider-master', 'editor: the Master slider has the focus when the panel opens', await active(page));
    const m0 = await sliderVal(page, 'master');
    await key(page, 'right'); await key(page, 'right');
    R.ok((await sliderVal(page, 'master')) === Math.min(100, m0 + 10) && (await settings(page)).master === Math.min(100, m0 + 10) / 100, '(d) editor: arrows on the slider change Master (native range, 5% steps)');
    await key(page, 'esc'); await sleep(300);
    R.ok(!(await panelOpen(page)) && (await page.eval(`document.activeElement && document.activeElement.id`)) === 'soundBtn', 'editor: Esc closes the panel in one press and the focus returns to the Sound button');
    const sz = await page.eval(`(() => { const r = document.getElementById('soundBtn').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    R.ok(sz.h >= 44 && sz.w >= 44, 'editor: the header Sound button is at least 44 x 44', J(sz));
  } else {
    await page.eval(`document.getElementById('soundBtn').click()`); await sleep(500);
    R.ok(await panelOpen(page), 'editor: the Sound button opens the panel');
    R.ok((await active(page)) === 'slider-master', 'editor: the Master slider has the focus (controller session)', await active(page));
    const m0 = await sliderVal(page, 'master');
    await pad(page, 'a'); await pad(page, 'left'); await pad(page, 'left'); await pad(page, 'b');
    R.ok((await sliderVal(page, 'master')) === Math.max(0, m0 - 10) && (await settings(page)).master === Math.max(0, m0 - 10) / 100, '(d) editor: a CONTROLLER alone can change the volume (A, left x2, B) through the page\'s own enableDomNav', J({ m0, now: await sliderVal(page, 'master') }));
    await pad(page, 'down'); await pad(page, 'down'); await pad(page, 'down');
    let hops = 0; while ((await active(page)) !== 'mute' && hops++ < 8) await pad(page, hops < 3 ? 'down' : 'left');
    await pad(page, 'a'); await sleep(200);
    R.ok((await settings(page)).muted === true, 'editor: a controller can mute (A on Mute)');
    await pad(page, 'b'); await sleep(300);
    R.ok(!(await panelOpen(page)), 'editor: B closes the panel for a controller');
  }
  R.ok(errsOf(page).filter((e) => !/favicon/.test(e)).length === 0, 'editor: no page or console error', J(errsOf(page)));
}

/* ---- the REAL AudioContext in headless Chrome (muted by --mute-audio) with the REAL music.js: does it really play, and what does it cost? ---- */
async function scnRealAudio(page, R, base) {
  await open(page, base + '/pokemonarena/?nostubs=1&realaudio=1');
  await hubReady(page);
  const real = await page.eval(`typeof window.__snd === 'undefined' && typeof AudioContext === 'function' && /native code/.test(Function.prototype.toString.call(AudioContext))`);
  R.ok(real, 'REAL AudioContext: this page has the browser\'s own AudioContext (no test double installed; Chrome runs with --mute-audio)');
  R.ok((await page.eval('window.__arenaSound.mixer.getAudioState().created')) === false, 'REAL AudioContext: none exists before the first key press');
  await key(page, 'down');
  await page.waitFor(`window.__arenaSound.mixer.getAudioState().ctx === 'running'`, { timeoutMs: 15000 });
  R.ok(true, 'REAL AudioContext: the first key press created it and it is running');
  await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return d.cur || d.error; })()`, { timeoutMs: 120000 });
  const d0 = await page.eval('window.__arenaSound.state().director');
  R.ok(!d0.error && d0.cur && d0.cur.key === 'hub', 'REAL AudioContext: the real music.js started the hub song', J({ error: d0.error, cur: d0.cur && d0.cur.index }));
  // main-thread cost: a requestAnimationFrame gap probe while the engine synthesizes in real time
  await page.eval(`(() => { window.__gaps = []; let last = performance.now(); const f = (t) => { window.__gaps.push(t - last); last = t; if (window.__gaps.length < 2000) requestAnimationFrame(f); }; requestAnimationFrame(f); window.__t0 = { wall: performance.now(), audio: window.__arenaSound.ctx().currentTime }; })()`);
  await sleep(6000);
  const m = await page.eval(`(() => { const s = window.__arenaSound.state(), e = s.director.engineState, g = window.__gaps.slice(5), c = window.__arenaSound.ctx(); return { ctx: c.state, audioAdvanced: c.currentTime - window.__t0.audio, wall: (performance.now() - window.__t0.wall) / 1000, engine: e, maxGap: Math.max.apply(null, g), n: g.length, avgGap: g.reduce((a, b) => a + b, 0) / g.length, sampleRate: c.sampleRate, baseLatency: c.baseLatency }; })()`);
  console.log('   REAL AudioContext numbers: ' + J({ ctx: m.ctx, sampleRate: m.sampleRate, baseLatency: m.baseLatency, audioSeconds: Math.round(m.audioAdvanced * 100) / 100, wallSeconds: Math.round(m.wall * 100) / 100, underruns: m.engine && m.engine.underruns, bufferedMs: m.engine && m.engine.bufferedMs, playing: m.engine && m.engine.playing, rafFrames: m.n, rafAvgMs: Math.round(m.avgGap * 10) / 10, rafMaxGapMs: Math.round(m.maxGap) }));
  R.ok(m.ctx === 'running' && m.audioAdvanced > m.wall * 0.8, 'REAL AudioContext: its clock advanced with the wall clock (' + (Math.round(m.audioAdvanced * 100) / 100) + ' s of audio in ' + (Math.round(m.wall * 100) / 100) + ' s)', J({ audio: m.audioAdvanced, wall: m.wall }));
  R.ok(m.engine && m.engine.playing === true && m.engine.index === d0.cur.index && !m.engine.paused && m.engine.bufferedMs > 0, 'REAL AudioContext: the engine reports it is playing the hub song with audio buffered ahead (' + (m.engine && m.engine.bufferedMs) + ' ms)', J(m.engine));
  R.ok(m.engine && Number.isFinite(m.engine.underruns), 'REAL AudioContext: state().underruns is reported: ' + (m.engine && m.engine.underruns) + ' in ' + Math.round(m.wall) + ' s');
  R.ok(m.maxGap < 1000, 'REAL AudioContext: the page never froze for a second while the engine synthesized (largest animation-frame gap ' + Math.round(m.maxGap) + ' ms, average ' + Math.round(m.avgGap * 10) / 10 + ' ms)', J({ maxGap: m.maxGap, avgGap: m.avgGap }));
  // an effect and a cry through the real graph
  await page.eval(`window.__arenaSound.director.playSfx('se_select')`);
  const e1 = await page.eval('window.__arenaSound.state().director.engineState');
  const cry = await page.eval(`window.__arenaSound.playCry(25, 'normal')`);
  R.ok(e1 && e1.effects >= 1, 'REAL AudioContext: a sound effect (se_select) is accepted by the real engine (effects sounding: ' + (e1 && e1.effects) + ')', J(e1));
  R.ok(cry === true && (await page.eval('window.__arenaSound.plays')) >= 1, 'REAL AudioContext: a ROM cry plays through the effects bus on the real context');
  // mute / unmute on the real context
  await key(page, 'm'); await sleep(400);
  R.ok((await page.eval(`window.__arenaSound.ctx().state`)) === 'suspended' && (await page.eval('window.__arenaSound.state().director.paused')) === true, 'REAL AudioContext: mute suspends the real context and pauses the engine');
  await key(page, 'm'); await sleep(600);
  R.ok((await page.eval(`window.__arenaSound.ctx().state`)) === 'running' && (await page.eval('window.__arenaSound.state().director.paused')) === false && (await page.eval('window.__arenaSound.state().director.cur.index')) === d0.cur.index, 'REAL AudioContext: unmute resumes the same song');
  R.ok(errsOf(page).filter((x) => !/favicon/.test(x)).length === 0, 'REAL AudioContext: no page or console error', J(errsOf(page)));
}

/* ---- the "press any key" prompt: shown on EVERY layout (touch pad or not), placed where it covers nothing, never swallows a tap ---- */
const PROMPT_PAGES = [
  { name: 'hub', url: '/pokemonarena/', ready: `window.__arenaHub && __arenaHub.state === 'ready' && window.__arenaSound` },
  { name: 'battle', url: '/pokemonarena/battle.html?seed=5&format=3v3', ready: `window.__arenaBattle && __arenaBattle.state === 'ready' && window.__arenaSound` },
  { name: 'editor', url: '/pokemonarena/editor.html', ready: `window.__editor && __editor.ready && window.__arenaSound` },
];
// one page at one size, before any activation; `view` = { w, h, mobile }. Returns the measurements (the checks go to R).
async function promptCase(page, base, pg, view, R, label) {
  await page.setViewport(view.w, view.h, view.mobile ? { mobile: true, dpr: 3 } : { mobile: false, dpr: 1 });
  await page.navigate(base + pg.url);
  await page.waitFor(pg.ready, { timeoutMs: 60000 });
  await sleep(900);                                              // the prompt re-places itself every 500 ms while the page lays itself out
  const m = await page.eval(`(() => {
    const p = document.getElementById('soundPrompt'); const cs = p ? getComputedStyle(p) : null; const r = p ? p.getBoundingClientRect() : null;
    const hit = [];
    const els = ['canvas', '#dpad', '#ab', '#keys', '#romStatus', '#note'].map((s) => [s, document.querySelector(s)]).concat(Array.from(document.querySelectorAll('#top > *')).map((e) => ['#top > ' + (e.id || e.tagName.toLowerCase()), e]));
    for (const [s, e] of els) {
      if (!e) continue; let b = e.getBoundingClientRect(); const st = getComputedStyle(e);
      if (e.tagName === 'H1') { const rg = document.createRange(); rg.selectNodeContents(e); const tb = rg.getBoundingClientRect(); if (tb.width > 0 && tb.height > 0) b = tb; }       // a header title stretches across the free space: it occupies its text
      if (!(b.width > 0 && b.height > 0) || st.display === 'none' || st.visibility === 'hidden') continue;
      if (r && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) hit.push(s);
    }
    const canvas = document.querySelector('canvas'); let cov = null;
    if (canvas) { const c = canvas.getBoundingClientRect(); cov = [[c.left + c.width / 2, c.top + 12], [c.left + c.width / 2, c.top + c.height / 2], [c.left + 20, c.bottom - 12]].map(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName) : null; }); }
    const btn = p ? p.querySelector('button') : null;       // there is none: the pill is text only
    return { state: window.__arenaSound.state().prompt, pad: document.body.dataset.pad || null, hover: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches,
      display: cs && cs.display, kind: p ? p.dataset.sndText : null, buttons: p ? p.querySelectorAll('button').length : -1, w: r ? r.width : 0, h: r ? r.height : 0, left: r ? r.left : 0, top: r ? r.top : 0, right: r ? r.right : 0, bottom: r ? r.bottom : 0,
      vw: document.documentElement.clientWidth, vh: innerHeight, hit, overlapAttr: !!(p && p.hasAttribute('data-overlap')), pe: cs && cs.pointerEvents, bpe: btn ? getComputedStyle(btn).pointerEvents : null, cov, canvasId: canvas ? canvas.id : null, text: p ? p.textContent : '',
      inHeader: (() => { const hd = document.getElementById('top'); const hb = hd ? hd.getBoundingClientRect() : null; return !!(hb && r && hb.height > 0 && r.top < hb.bottom && r.bottom > hb.top); })() };
  })()`);
  const tag = 'prompt ' + (label || '') + pg.name + ' ' + view.w + 'x' + view.h + (view.mobile ? ' touch' : '') + ': ';
  if (!/MP/.test(label || '') && (pg.name === 'hub' || pg.name === 'battle') && ((view.w === 1280 && view.h === 800) || (view.w === 390 && view.h === 844))) { try { await page.screenshot(path.join(OUT, 'prompt_' + String(label || 'x').replace(/[^a-z0-9]/gi, '') + '_' + pg.name + '_' + view.w + 'x' + view.h + '.png')); } catch (_e) { /* a screenshot is evidence, not a check */ } }
  R.ok(m.state === true && m.display !== 'none' && m.w > 0 && m.h > 0, tag + 'it is ON SCREEN whenever state().prompt says it is (data-pad=' + m.pad + ', hover:none=' + m.hover + ', pointer:coarse=' + m.coarse + ')', J({ state: m.state, display: m.display, w: m.w, h: m.h, pad: m.pad }));
  R.ok(m.left >= 0 && m.top >= 0 && m.right <= m.vw + 0.5 && m.bottom <= m.vh + 0.5, tag + 'it lies inside the window', J({ l: m.left, t: m.top, r: m.right, b: m.bottom, vw: m.vw, vh: m.vh }));
  const strict = view.w >= 1100 || (view.mobile && view.h >= view.w);           // a wide desktop and an upright phone always have a free spot; a cramped window (a sideways phone, a small desktop window) may not
  const mild = m.hit.every((s) => s === '#romStatus' || s === '#note');       // ... and then the pill (marked data-overlap, ignoring the pointer) may sit over the dim ROM-status / note line, never over the picture, the pad, the footer hint or the header
  const ignores = m.pe === 'none' && m.buttons === 0;
  R.ok(m.hit.length === 0 || (!strict && m.overlapAttr && mild), tag + 'it covers nothing the player needs (the picture, the touch pad, the footer hint, the header)', J({ covers: m.hit, overlapAttr: m.overlapAttr, rect: [m.left, m.top, m.right, m.bottom] }));
  R.ok(!strict || !m.inHeader, tag + 'it does NOT sit in the header band (it used to float between the title and the buttons, where it read as part of the header)', J({ inHeader: m.inHeader, top: m.top, bottom: m.bottom }));
  R.ok(ignores && (!m.cov || m.cov.every((x) => x === m.canvasId)), tag + 'it never swallows a tap or click: the pill ignores the pointer and the picture is what a press on it reaches', J({ pe: m.pe, bpe: m.bpe, cov: m.cov }));
  R.ok(/Click, tap or press/.test(m.text) && !/browser rule/.test(m.text) && /controller button cannot/i.test(m.text), tag + 'it tells a visitor what to do and that a controller button cannot do it (the long AND the short variant say so: which one shows depends on the layout), without the old "(that is a browser rule)" clause' + (m.kind === 'short' ? ' (the short text: the layout is cramped)' : ''));
  // dismissal: a key press starts the sound and the prompt goes
  await key(page, 'down');
  await page.waitFor(`window.__arenaSound.mixer.getAudioState().ctx === 'running' && window.__arenaSound.state().prompt === false`, { timeoutMs: 8000 }).catch(() => {});
  const after = await page.eval(`({ prompt: window.__arenaSound.state().prompt, ctx: window.__arenaSound.mixer.getAudioState().ctx })`);
  R.ok(after.prompt === false && after.ctx === 'running', tag + 'a key press dismisses it (the sound starts)', J(after));
  return m;
}
// dismissal without sound: Escape (not a browser activation) hides it, and so does any controller button; neither creates an AudioContext, and the pad press still reaches the page
async function promptDismissCase(page, R, base, label) {
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  const snap = () => page.eval(`({ prompt: window.__arenaSound.state().prompt, dismissed: window.__arenaSound.state().promptDismissed, why: window.__arenaSound.state().promptWhy, ctor: window.__snd.ctor, created: window.__arenaSound.mixer.getAudioState().created, hub: JSON.stringify(window.__arenaHub.model.state().cursor) })`);
  await page.navigate(base + '/pokemonarena/'); await page.waitFor(PROMPT_PAGES[0].ready, { timeoutMs: 60000 }); await sleep(600);
  const a0 = await snap();
  await key(page, 'esc'); await sleep(250);
  const a1 = await snap();
  R.ok(a0.prompt === true && a1.prompt === false && a1.dismissed === true && a1.why === 'escape' && a1.ctor === 0 && a1.created === false, 'prompt ' + label + 'Esc hides it WITHOUT starting any sound (no AudioContext is created)', J({ a0, a1 }));
  await page.navigate(base + '/pokemonarena/'); await page.waitFor(PROMPT_PAGES[0].ready, { timeoutMs: 60000 }); await sleep(600);
  const b0 = await snap();
  await pad(page, 'down'); await sleep(300);
  const b1 = await snap();
  R.ok(b0.prompt === true && b1.prompt === false && b1.dismissed === true && b1.why === 'pad' && b1.ctor === 0 && b1.created === false, 'prompt ' + label + 'a controller button hides it WITHOUT starting any sound, so a pad-only visitor is never stuck with it', J({ b0, b1 }));
  R.ok(b1.hub !== b0.hub, 'prompt ' + label + 'and that same pad press still moved the hub cursor (the prompt consumes nothing)', J({ before: b0.hub, after: b1.hub }));
}
async function promptSuite(page, R, base, label, sizes = [{ w: 1280, h: 800 }, { w: 800, h: 600 }]) {
  let env = null;
  for (const pg of PROMPT_PAGES) for (const v of sizes) { const m = await promptCase(page, base, pg, v, R, label); env = env || m; }
  // a click dismisses it too (fresh page, no key)
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await page.navigate(base + '/pokemonarena/'); await page.waitFor(PROMPT_PAGES[0].ready, { timeoutMs: 60000 }); await sleep(300);
  const c = await rect(page, '#soundBtn'); await page.click(c.x, c.y); await sleep(300);
  const st2 = await page.eval(`({ prompt: window.__arenaSound.state().prompt, ctx: window.__arenaSound.mixer.getAudioState().ctx })`);
  R.ok(st2.prompt === false && st2.ctx === 'running', 'prompt ' + (label || '') + ': a click dismisses it (the sound starts)', J(st2));
  await promptDismissCase(page, R, base, label || '');
  if (env) console.log('   prompt environment (' + (label || 'default') + '): data-pad=' + env.pad + ', (hover: none)=' + env.hover + ', (pointer: coarse)=' + env.coarse);
  return env;
}

/* ---- (j) the same panel on the three pages ---- */
async function panelSignature(page, openJs) {
  await page.eval(openJs); await sleep(500);
  const sig = await page.eval(`(() => { const d = document.getElementById('soundDialog'); if (!d || d.hidden) return null; return { snd: [...d.querySelectorAll('[data-snd]')].map((e) => e.dataset.snd + ':' + e.tagName), text: [...d.querySelectorAll('h2,h3,label,button,.snd-tip')].map((e) => e.textContent.trim()).filter(Boolean), role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), title: d.querySelector('h2').textContent }; })()`);
  return sig;
}

/* ------------------------------------------------------------------------------------------------ main */
fs.mkdirSync(OUT, { recursive: true });
head('machine load ' + loadPct() + '; screenshots to ' + OUT + (REAL_MODULES ? '; REAL music.js + music_map.js present (a session at the end uses them)' : '; music.js / music_map.js not present: every session uses the stand-ins'));
L.reapLeaks();
const server = await L.startServer();
const shots = {};
// ONE browser (one lock acquisition) for every scenario: the machine-wide lock is contended, and each scenario starts from an empty profile (fresh())
const scenario = async (name, fn) => {
  const R = recorder();
  try { await fn(R); } catch (e) { R.ok(false, 'scenario "' + name + '" threw', String(e && e.stack ? e.stack : e).slice(0, 400)); }
  feed(R); console.log('   ' + name + ': ' + R.r.filter((x) => x.ok).length + '/' + R.r.length);
  return R;
};
try {
  await lockedBrowser({ port: cdp++, width: 1280, height: 800 }, async (page) => {
    await installDoubles(page);
    head('hub: (a)(b)(c) first activation, then the panel with the MOUSE, the soundtrack switch');
    await fresh(page, BASE);
    await scenario('first activation', (R) => scnFirstActivation(page, R, BASE));
    await scenario('mouse panel', async (R) => {
      await scnMouse(page, R);
      shots.hubDesktop = path.join(OUT, 'hub_desktop_panel.png'); await page.screenshot(shots.hubDesktop);
      shots.hubSig = await page.eval(`(() => { const d = document.getElementById('soundDialog'); return { snd: [...d.querySelectorAll('[data-snd]')].map((e) => e.dataset.snd + ':' + e.tagName), text: [...d.querySelectorAll('h2,h3,label,button,.snd-tip')].map((e) => e.textContent.trim()).filter(Boolean), role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), title: d.querySelector('h2').textContent }; })()`);
    });
    await scenario('soundtrack switch', (R) => scnSoundtrack(page, R));
    await key(page, 'esc'); await sleep(300);
    await scenario('persistence + migration', (R) => scnPersistence(page, R, BASE));
    await fresh(page, BASE);
    await scenario('hidden tab + M key', (R) => scnHiddenAndM(page, R, BASE));
    head('hub: the Ultra Violet ROM that cannot be loaded');
    await fresh(page, BASE);
    await scenario('UV cannot be loaded', async (R) => {
      await open(page, BASE + '/pokemonarena/');
      await hubReady(page);
      await page.eval('window.__sndUvFail = true');
      await key(page, 'down'); await page.waitFor(`window.__sndMusic && window.__sndMusic.play.length === 1`, { timeoutMs: 10000 });
      await page.eval(`document.getElementById('soundBtn').click()`); await sleep(300);
      const uv = await sndRect(page, 'soundtrack-ultraviolet'); await clickAt(page, uv.cx, uv.cy);
      await page.waitFor(`/could not be loaded/.test(document.querySelector('[data-snd="soundtrack-status"]').textContent)`, { timeoutMs: 15000 });
      const status = await page.eval(`document.querySelector('[data-snd="soundtrack-status"]').textContent`);
      R.ok(/Ultra Violet could not be loaded/.test(status) && /404/.test(status) && /SoulGold soundtrack keeps playing/.test(status), '(i) a failed Ultra Violet download shows a clear error in the panel', status);
      const s = await settings(page);
      R.ok(s.soundtrack === 'soulgold' && (await page.eval(`document.querySelector('[data-snd="soundtrack-soulgold"]').getAttribute('aria-checked')`)) === 'true', '(i) ...the choice stays SoulGold (not stored as Ultra Violet)');
      R.ok((await page.eval('window.__sndMusic.create.length')) === 1 && (await page.eval('window.__sndMusic.dispose')) === 0 && (await page.eval('window.__sndMusic.play.length')) === 1, '(i) ...and the SoulGold music is untouched (no new engine, nothing disposed)');
      // a STORED Ultra Violet that cannot load falls back to SoulGold for this visit and keeps the stored choice
      await page.eval(`localStorage.setItem('arena.audio', JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: false, soundtrack: 'ultraviolet' }))`);
      await page.navigate(BASE + '/pokemonarena/'); await hubReady(page);
      await page.eval('window.__sndUvFail = true');
      await key(page, 'down'); await page.waitFor(`window.__sndMusic.play.length >= 1`, { timeoutMs: 15000 });
      await page.waitFor(`window.__arenaSound.state().soundtrack === 'soulgold'`, { timeoutMs: 15000 });
      await sleep(400);
      const ml = await page.eval(`({ create: window.__sndMusic.create, play: window.__sndMusic.play, st: window.__arenaSound.state().soundtrack })`);
      R.ok(ml.st === 'soulgold' && ml.create[ml.create.length - 1].soundtrack === 'soulgold' && ml.play[ml.play.length - 1].index === 10 && JSON.parse(await stored(page)).soundtrack === 'ultraviolet', '(i) a remembered Ultra Violet whose ROM cannot be loaded plays SoulGold this visit and keeps the stored choice', J(ml));
    });
    head('keyboard alone');
    await fresh(page, BASE);
    await scenario('keyboard', (R) => scnKeyboard(page, R, BASE));
    head('controller alone');
    await fresh(page, BASE);
    await scenario('controller', (R) => scnPad(page, R, BASE));
    head('battle: music sequence, menu / hit / animator sounds, the pause menu SOUND row');
    await fresh(page, BASE);
    await scenario('battle', async (R) => {
      const r = await scnBattle(page, R, BASE); shots.battle = r.shotB;
      shots.batSig = await panelSignature(page, `window.__arenaSound.openPanel()`);
    });
    head('editor: keyboard, then controller');
    await fresh(page, BASE);
    await scenario('editor keyboard', async (R) => {
      await scnEditor(page, R, BASE);
      shots.edSig = await panelSignature(page, `document.getElementById('soundBtn').click()`);
      shots.editor = path.join(OUT, 'editor_panel.png'); await page.screenshot(shots.editor);
    });
    await fresh(page, BASE);
    await scenario('editor controller', (R) => scnEditor(page, R, BASE, { padSession: true }));
    head('(j) the same panel on the hub, the battle page and the editor');
    await scenario('same panel', async (R) => {
      const h = shots.hubSig, b = shots.batSig, e = shots.edSig;
      R.ok(h && b && e, '(j) all three pages opened the panel');
      R.ok(J(h) === J(b) && J(b) === J(e), '(j) the panel is the SAME on the hub, the battle page and the editor: identical controls (data-snd + tag), identical words, role dialog / aria-modal', J({ h: h && h.snd.length, b: b && b.snd.length, e: e && e.snd.length }));
      R.ok(h && h.role === 'dialog' && h.modal === 'true' && h.title === 'Sound', '(j) it is a modal dialog titled "Sound"');
    });
    if (REAL_MODULES) {
      head('real music.js + music_map.js');
      await fresh(page, BASE);
      await scenario('real modules', async (R) => {
        await open(page, BASE + '/pokemonarena/?nostubs=1');
        await hubReady(page);
        await key(page, 'down');
        await page.waitFor(`window.__arenaSound.state().director.engine || window.__arenaSound.state().director.error`, { timeoutMs: 120000 });
        const d = await page.eval(`window.__arenaSound.state().director`);
        R.ok(!d.error && d.engine && d.cur && d.cur.key === 'hub', 'REAL modules: the hub asks the real music_map for "hub" and the real engine plays it (no error)', J({ error: d.error, cur: d.cur }));
        R.ok(errsOf(page).filter((x) => !/favicon/.test(x)).length === 0, 'REAL modules: no page or console error', J(errsOf(page)));
      });
      await fresh(page, BASE);
      await scenario('real AudioContext', (R) => scnRealAudio(page, R, BASE));
    } else console.log('SKIP (counted): the real music.js / music_map.js are not in the tree; this suite ran only against the stand-ins');
    head('the "press any key" prompt in THIS browser (whatever hover / pointer media it reports)');
    await fresh(page, BASE);
    await scenario('prompt, this browser', (R) => promptSuite(page, R, BASE, 'env1: '));
    head('touch alone (390x844 @3x)');
    await fresh(page, BASE);
    await scenario('touch', async (R) => { const r = await scnTouch(page, R, BASE); shots.hubPhone = r.shotA; });
    await scenario('prompt, phones', async (R) => {
      for (const pg of PROMPT_PAGES) for (const v of [{ w: 390, h: 844, mobile: true }, { w: 844, h: 390, mobile: true }]) await promptCase(page, BASE, pg, v, R, 'phone: ');
    });
    await scenario('prompt negative control 1 (the old rule that hid it on a touch layout)', async (R) => {
      const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-prompt-mut-')); let pp = Number(process.env.ARENA_OVERLAY_PORT || 18105) + 20;
      const run1 = async (mut) => { const d = copyTree(PA, path.join(TMP1, mut ? 'mp1' : 'twin')); if (mut) mutateFile(d, 'js/sound_system.js', mut.from, mut.to); const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE }); try { const RR = recorder(); await promptCase(page, ov.url, PROMPT_PAGES[0], { w: 390, h: 844, mobile: true }, RR, 'MP1: '); return RR.r; } finally { ov.stop(); } };
      const twin = await run1(null);
      R.ok(twin.every((x) => x.ok), 'prompt MP1: the unmutated twin passes every prompt check on a phone layout (' + twin.length + ' checks)', twin.filter((x) => !x.ok).map((x) => x.name).join('; '));
      const mut = await run1({ from: '.arena-sndprompt, .arena-sndprompt * { pointer-events: none; }', to: '.arena-sndprompt, .arena-sndprompt * { pointer-events: none; }\nbody[data-pad="on"] .arena-sndprompt { display: none !important; }' });
      R.ok(mut.some((x) => !x.ok && x.name.startsWith('prompt MP1: hub 390x844 touch: it is ON SCREEN whenever state().prompt says it is')), 'prompt MP1: the OLD rule (hide the prompt when data-pad is on) trips "it is on screen whenever state().prompt says it is"', mut.filter((x) => !x.ok).map((x) => x.name).join(' | ').slice(0, 300));
      try { fs.rmSync(TMP1, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await page.setViewport(1280, 800, { mobile: false, dpr: 1 });       // back to a desktop for the mutants
  if (!ARGS.has('--no-mutants')) {
    head('mutants: an overlay copy with ONE defect; the unmutated twin stays quiet');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sound-mut-'));
    let ovPort = Number(process.env.ARENA_OVERLAY_PORT || 18105);
    const MUT = [
      { id: 'MB1 persistence write removed', rel: 'js/audio_mixer.js', from: "try { st.setItem(AUDIO_KEY, JSON.stringify({ v: 1, master: s.master, music: s.music, fx: s.fx, muted: !!s.muted, soundtrack: s.soundtrack })); return true; } catch (_e) { return false; }", to: 'return true;', scn: 'persist', expect: '(f) settings persist across a reload (master, music, fx, mute)' },
      { id: 'MB2 mute is a no-op', rel: 'js/audio_mixer.js', from: 'const next = !!m;\n    if (S.settings.muted === next) return next;\n    S.settings.muted = next;', to: 'const next = !!m;\n    return next;\n    S.settings.muted = next;', scn: 'mute', expect: '(e) mouse: MUTE sets muted, ramps the master bus to exactly 0 and leaves the music bus where it was' },
      { id: 'MB3 a slider maps one percent off', rel: 'js/sound_panel.js', from: 'const v = fromPercent(e.target.value); mixer.setVolume(bus, v); paintOne(bus);', to: 'const v = fromPercent(Number(e.target.value) + 1); mixer.setVolume(bus, v); paintOne(bus);', scn: 'slider', expect: '(d) mouse: clicking the Music slider at 25% sets music to a multiple of 5 near 25 and moves the MUSIC bus to its square' },
      { id: 'MB4 the editor without enableDomNav', rel: 'js/editor_app.js', from: 'const nav = N.enableDomNav(document.body, { input, onBack: goUp });', to: 'const nav = null;', scn: 'editorpad', expect: '(d) editor: a CONTROLLER alone can change the volume (A, left x2, B) through the page\'s own enableDomNav' },
    ];
    await (async () => {                                   // the same browser session as the scenarios above (one lock acquisition)
      const run = async (kind, baseUrl) => {
        const R = recorder();
        await fresh(page, baseUrl);
        if (kind === 'editorpad') await scnEditor(page, R, baseUrl, { padSession: true });
        else {
          const r = recorder(); await scnFirstActivation(page, r, baseUrl);
          if (kind === 'persist') { const r2 = recorder(); await scnMouse(page, r2); await scnPersistence(page, R, baseUrl); }
          else await scnMouse(page, R);
        }
        return R.r;
      };
      {
        const d = copyTree(PA, path.join(TMP, 'twin')); const ov = await startOverlay({ dir: d, port: ovPort++, upstream: BASE });
        try { for (const kind of ['persist', 'editorpad']) { let res; try { res = await run(kind, ov.url); } catch (e) { C.ok(false, 'mutants: the unmutated TWIN overlay ran the "' + kind + '" scenario', String(e && e.message).slice(0, 200)); continue; } const bad = res.filter((x) => !x.ok); C.ok(bad.length === 0, 'mutants: the unmutated TWIN overlay passes the "' + kind + '" scenario (' + res.length + ' checks)', bad.map((x) => x.name).join('; ')); } } finally { ov.stop(); }
      }
      for (const m of MUT) {
        const d = copyTree(PA, path.join(TMP, m.id.split(' ')[0]));
        try { mutateFile(d, m.rel, m.from, m.to); } catch (e) { C.ok(false, 'mutant ' + m.id + ' could not be applied', e.message); continue; }
        const ov = await startOverlay({ dir: d, port: ovPort++, upstream: BASE });
        try {
          const res = await run(m.scn, ov.url);
          const failed = res.filter((x) => !x.ok).map((x) => x.name);
          C.ok(failed.includes(m.expect), 'mutant ' + m.id + ' trips its named check', 'failed: ' + failed.join(' | ').slice(0, 400));
        } catch (e) { C.ok(true, 'mutant ' + m.id + ' broke the page so badly the scenario threw (counts as caught)', String(e && e.message).slice(0, 200)); } finally { ov.stop(); }
      }
    })();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  });

  await lockedBrowser({ port: cdp++, width: 1280, height: 800, args: ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'] }, async (page) => {
    await installDoubles(page);
    head('the prompt in a HOVER-CAPABLE desktop (mouse + keyboard: (hover: hover), (pointer: fine)), and its negative control');
    await fresh(page, BASE);
    await scenario('prompt, hover desktop', async (R) => {
      const env = await promptSuite(page, R, BASE, 'env2: ');
      R.ok(env && env.hover === false && env.coarse === false && env.pad === 'off', 'prompt env2: this browser really is a hover-capable desktop ((hover: none) false, (pointer: coarse) false, data-pad off)', J(env && { hover: env.hover, coarse: env.coarse, pad: env.pad }));
    });
    await scenario('prompt negative control 2 (no placement: the pill sits over the footer hint)', async (R) => {
      const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-prompt-mut2-')); let pp = Number(process.env.ARENA_OVERLAY_PORT || 18105) + 30;
      const run2 = async (mut) => { const d = copyTree(PA, path.join(TMP2, mut ? 'mp2' : 'twin')); if (mut) mutateFile(d, 'js/sound_system.js', mut.from, mut.to); const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE }); try { const RR = recorder(); await promptCase(page, ov.url, PROMPT_PAGES[0], { w: 1280, h: 800, mobile: false }, RR, 'MP2: '); return RR.r; } finally { ov.stop(); } };
      const twin = await run2(null);
      R.ok(twin.every((x) => x.ok), 'prompt MP2: the unmutated twin passes every prompt check on a hover desktop (' + twin.length + ' checks)', twin.filter((x) => !x.ok).map((x) => x.name).join('; '));
      const mut = await run2({ from: 'if (!p || p.hidden || !win || !doc) return;\n    const vw', to: 'return; if (!p || p.hidden || !win || !doc) return;\n    const vw' });
      R.ok(mut.some((x) => !x.ok && x.name.startsWith('prompt MP2: hub 1280x800: it covers nothing the player needs')), 'prompt MP2: with the placement switched off the pill covers the footer hint and trips "it covers nothing the player needs"', mut.filter((x) => !x.ok).map((x) => x.name).join(' | ').slice(0, 300));
      // MP3: the header's free gap is tried FIRST again (the old order): the pill is back between the title and the buttons
      {
        const run3 = async (mut) => { const d = copyTree(PA, path.join(TMP2, mut ? 'mp3' : 'twin3')); if (mut) mutateFile(d, 'js/sound_system.js', mut.from, mut.to); const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE }); try { const RR = recorder(); await promptCase(page, ov.url, PROMPT_PAGES[0], { w: 1280, h: 800, mobile: false }, RR, 'MP3: '); return RR.r; } finally { ov.stop(); } };
        const mut3 = await run3({ from: 'if (canvasPage) cands.push([(vw - pw) / 2, lowest + G]);', to: 'if (gap && headBox && gap.w - 2 * G >= pw) cands.unshift([gap.x + G + (gap.w - 2 * G - pw) / 2, headBox.top + (headBox.height - ph) / 2]);\n        if (canvasPage) cands.push([(vw - pw) / 2, lowest + G]);' });
        R.ok(mut3.some((x) => !x.ok && x.name.startsWith('prompt MP3: hub 1280x800: it does NOT sit in the header band')), 'prompt MP3: with the header gap tried first again the pill sits in the header band and trips "it does NOT sit in the header band"', J(mut3.filter((x) => !x.ok).map((x) => x.name)));
      }
      // MP4: no dismissal: Esc and a pad button leave the prompt on screen
      {
        const d = copyTree(PA, path.join(TMP2, 'mp4')); mutateFile(d, 'js/sound_system.js', 'function dismissPrompt(why) { if (S.promptDismissed) return false;', 'function dismissPrompt(why) { return false; if (S.promptDismissed) return false;');
        const ov = await startOverlay({ dir: d, port: pp++, upstream: BASE });
        try { const RR = recorder(); await promptDismissCase(page, RR, ov.url, 'MP4: ');
          R.ok(RR.r.some((x) => !x.ok && x.name.startsWith('prompt MP4: Esc hides it')) && RR.r.some((x) => !x.ok && x.name.startsWith('prompt MP4: a controller button hides it')), 'prompt MP4: with dismissal switched off both "Esc hides it" and "a controller button hides it" fail', J(RR.r.filter((x) => !x.ok).map((x) => x.name))); } finally { ov.stop(); }
      }
      try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    });
  });
} finally { L.stopServer(server); L.reapLeaks(); }
console.log('\nscreenshots:\n' + Object.entries(shots).filter(([, v]) => typeof v === 'string').map(([k, v]) => '  ' + k + ': ' + v).join('\n'));
C.finish();
