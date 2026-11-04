// tools/pokemonarena_battle_page_test.mjs - headless-Chrome end-to-end test of /pokemonarena/battle.html (the battle scene page).
//
//   node tools/pokemonarena_battle_page_test.mjs                  starts PORT=8094 node tools/devserver.mjs itself, one muted headless Chrome at a time
//   ARENA_PORT=8094 ARENA_CDP=9271 ARENA_OUT=<dir for screenshots> ARENA_SKIP_SHOTS=1
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio, machine-wide lock). Nothing here touches the user's
// browser, and no real audio is ever started: sound is verified by a test double of AudioContext installed before the page runs.
// Screenshots (phone 390x844 @3x, landscape 844x390, desktop 1280x800, plus 320x568 and 568x320) go to ARENA_OUT to be opened and judged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8094);
const CDP0 = Number(process.env.ARENA_CDP || 9271);
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c5557fc3-6bdd-45f1-a13c-2116f656d0fe/scratchpad/S1/page_test';
const ROM_PATH = path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const BASE = `http://localhost:${PORT}/pokemonarena/battle.html`;
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 120) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); } }

/* ---------------------------------------------------------------------------------------------- dev server */
let server = null;
async function startServer() {
  const probe = async () => { try { const r = await fetch(`http://localhost:${PORT}/pokemonarena/battle.html`); return r.ok; } catch (_e) { return false; } };
  if (await probe()) return false;
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250);
  return true;
}
function stopServer() { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } server = null; } }

/* ----------------------------------------------------------------------------------------------- page helpers */
const H = '(window.__arenaBattle)';
const ev = (page, expr) => page.eval(expr);
async function open(page, query, { wait = 'ready', timeoutMs = 90000 } = {}) {
  await page.navigate(BASE + (query || ''));
  await page.waitFor(`${H} && (${H}.state === "${wait}" || ${H}.state === "error")`, { timeoutMs });
  return ev(page, `${H}.state`);
}
const state = (page) => ev(page, `${H}.getState()`);
const mode = (page) => ev(page, `${H}.mode`);
async function untilMode(page, modes, { max = 4000, press = false } = {}) {
  const list = JSON.stringify(Array.isArray(modes) ? modes : [modes]);
  for (let i = 0; i < 40; i++) {
    const r = await ev(page, `(() => { const ms = ${list}; const a = ${H}; for (let k = 0; k < ${Math.floor(max / 40)}; k++) { if (ms.includes(a.mode)) return a.mode; a.scene.tick(); ${press ? "if (a.mode === 'steps') a.press('a');" : ''} } return ms.includes(a.mode) ? a.mode : 'timeout:' + a.mode; })()`);
    if (!String(r).startsWith('timeout')) return r;
  }
  return 'timeout';
}
// map logical 240x160 coordinates to page coordinates of the canvas
async function logicalToPage(page, lx, ly) {
  const r = await ev(page, `(() => { const c = ${H}.canvas, b = c.getBoundingClientRect(), cs = getComputedStyle(c); const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); return { x: b.left + bl, y: b.top + bt, w: b.width - 2 * bl, h: b.height - 2 * bt }; })()`);
  return { x: r.x + (lx / 240) * r.w, y: r.y + (ly / 160) * r.h };
}
async function tapLogical(page, lx, ly, touch) { const p = await logicalToPage(page, lx, ly); if (touch) await page.tap(p.x, p.y); else await page.click(p.x, p.y); return p; }
const KEYS = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], a: ['Enter', 'Enter', 13], b: ['Backspace', 'Backspace', 8], start: ['p', 'KeyP', 80], x: ['c', 'KeyC', 67] };
const key = (page, k) => page.press(KEYS[k][0], KEYS[k][1], KEYS[k][2], 25);

// invariant: when the scene is idle (a menu is up), the displayed Pokemon equal the engine's
async function consistent(page) {
  return ev(page, `(() => { const a = ${H}, st = a.getState(); if (!['action','moves','party','result','preview'].includes(st.mode)) return 'busy'; const s = a.ctl.battle.s; const m = s.sides[0].team[s.sides[0].act], f = s.sides[1].team[s.sides[1].act]; const out = []; if (st.player && !(st.player.hp === m.hp && st.player.max === m.mhp && st.player.name === m.name)) out.push('player ' + JSON.stringify(st.player) + ' vs ' + m.name + ' ' + m.hp + '/' + m.mhp); if (st.foe && !(st.foe.hp === f.hp && st.foe.max === f.mhp && st.foe.name === f.name)) out.push('foe ' + JSON.stringify(st.foe) + ' vs ' + f.name + ' ' + f.hp + '/' + f.mhp); return out.length ? out.join(' | ') : 'ok'; })()`);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot(path.join(OUT, name + '.png')); return name; };

/* ------------------------------------------------------------------------------- an AudioContext test double */
// UPDATED DELIBERATELY (the page now TRIES to start the sound at load): this double emulates the browser's autoplay policy like the shared ones (pokemonarena_hub_lib.mjs, pokemonarena_sound_lib.mjs): a context
// stays suspended until the page has had a real user activation (navigator.userActivation.hasBeenActive) unless ?autoplay=1 says the site may autoplay. The old double resumed at once, which no real browser does.
const AUDIO_DOUBLE = `(() => {
  const log = { ctor: 0, createBuffer: 0, createBufferSource: 0, start: 0, resume: 0, gain: 0, blocked: 0 };
  window.__audioLog = log; window.__autoplayAllowed = /[?&]autoplay=1/.test(location.search);
  class FakeCtx {
    constructor() { log.ctor++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { log.resume++; const a = navigator.userActivation && navigator.userActivation.hasBeenActive; if (!window.__autoplayAllowed && !a) { log.blocked++; return Promise.resolve(); } this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    createBuffer(ch, len, rate) { log.createBuffer++; const d = new Float32Array(len); return { duration: len / rate, getChannelData: () => d }; }
    createBufferSource() { log.createBufferSource++; return { buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() { log.start++; }, stop() {}, onended: null }; }
    createGain() { log.gain++; return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  }
  window.AudioContext = FakeCtx; window.webkitAudioContext = FakeCtx;
})();`;
// a controller whose buttons the test sets: navigator.getGamepads() reads window.__pad
const PAD_DOUBLE = `(() => {
  window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v })) }];
})();`;
async function addInit(page, src) { await page.send('Page.addScriptToEvaluateOnNewDocument', { source: src }); }

/* ===================================================================================================== sessions */

/* ------------------------------------------------------------------------- scenarios found AT RUN TIME with the real engine
   The path checks below (a hit with the HP bar mid-drain, a faint, the forced party screen, a statused Pokemon at a menu) used to name seed 5 / a seed list; when the engine moved (the
   foe's first move became Protect) they failed for a reason that had nothing to do with the page. The predicates are ONE source (the strings below) run in the page and, here in Node,
   against a scene on the real engine with the same keys the test presses; a seed is used only if the predicates hold for it. */
const MID_SRC = `(a, minDelta) => { let start = null; for (let k = 0; k < 20000; k++) { a.scene.tick(); const c = a.scene.S.cur; if (c && c.t === 'drain') { const d = a.scene.S.disp[c.side]; if (!d) { start = null; continue; } if (start === null || start.c !== c) start = { c, hp: d.hp }; if (start.hp - c.to >= minDelta && d.hp > c.to && d.hp <= start.hp - (start.hp - c.to) / 2) { a.tick(0); return { side: c.side, hp: d.hp, from: start.hp, to: c.to, max: d.maxHp }; } } else start = null; } return null; }`;
const FAINT_SRC = `(a) => { for (let k = 0; k < 120000; k++) { a.scene.tick(); if (a.scene.S.mode === 'action') { a.press('a'); a.press('a'); continue; } if (a.mode === 'moves') { a.press('a'); continue; } if (a.mode === 'party') { a.press('a'); continue; } const c = a.scene.S.cur; if (c && (c.t === 'faint' || (c.t === 'sysevent' && c.kind === 'faint')) && c.n > 6) { a.tick(0); if (c.t === 'faint') return { side: c.side, sys: false, drop: a.scene.S.disp[c.side].drop }; return { side: c.side, sys: true, live: !!(c.run && !c.run.done), fxSys: a.scene.view().fxSys === true, drop: 0 }; } if (a.mode === 'result') return null; } return null; }`;
const PARTY_SRC = `(a) => { for (let k = 0; k < 120000; k++) { a.scene.tick(); if (a.mode === 'party') { a.tick(0); return true; } if (a.scene.S.mode === 'action') { a.press('a'); a.press('a'); } else if (a.mode === 'moves') a.press('a'); else if (a.mode === 'result') return false; } return false; }`;
const STATUS_SRC = `(a, seed) => { a.pause(true); for (let k = 0; k < 90000; k++) { a.scene.tick(); const st = a.getState(); if (st.mode === 'action') { if (((st.player && st.player.status) || (st.foe && st.foe.status)) && a.scene.S.req.moves.length >= 2) return { seed: seed, status: st.player && st.player.status, foe: st.foe && st.foe.status }; a.press('a'); a.press('a'); } else if (a.mode === 'moves') a.press('a'); else if (a.mode === 'party') a.press('a'); else if (a.mode === 'result') return null; } return null; }`;
let LIBS = null;
async function nodeBattle(query) {
  if (!LIBS) {
    const imp = (f) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href);
    const [boot, tables, bui, btext, mc, sc] = await Promise.all([imp('battle_boot.js'), imp('tables.js'), imp('battle_ui.js'), imp('battle_text.js'), imp('matchctl.js'), imp('scene.js')]);
    const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));
    const pack = tables.loadPack(rom, { verify: 'header', dexText: false });
    LIBS = { boot, mc, sc, pack, ui: bui.createBattleUi(rom), text: btext.loadBattleText(rom, manifest) };
  }
  const { boot, mc, sc, pack, ui, text } = LIBS;
  const p = boot.parseBattleQuery(query); if (!p.ok) throw new Error('bad query ' + query);
  const r = await boot.resolveBattle(pack, p.params); if (!r.ok) throw new Error('unresolvable ' + query);
  const spec = r.spec;
  const ctl = mc.createMatchController({ pack, ruleset: spec.ruleset, teams: spec.teams, seed: spec.seed, pick: spec.pick, names: spec.names, sides: spec.sides }); ctl.start();
  const scene = sc.createScene({ ui, pack, text, ctl, viewSide: 0, env: spec.seed % 9, textSpeed: p.params.speed, meta: spec.meta, trainer: spec.trainer, playerName: 'You', quitLabel: 'BACK TO HUB' });
  scene.begin(); if (scene.mode === 'steps') scene.tick();                       // as battle_boot does before 'ready'
  return { scene, press: (x) => scene.press(x), get mode() { return scene.mode; }, getState: () => scene.state(), tick() {}, pause() {} };
}
const fnOf = (src) => new Function('return ' + src)();
// seed -> { ok, why }: the same keys the page path presses (three picks and YES, A through the intro, FIGHT, the first move), then the same three predicates
async function pathScenario(seed, minDelta) {
  const a = await nodeBattle('?seed=' + seed + '&format=3v3&cpu=normal');
  for (const k of ['a', 'down', 'a', 'down', 'a', 'a']) { a.press(k); a.scene.tick(); a.scene.tick(); }
  let n = 0; while (a.mode !== 'action' && n++ < 4000) { a.scene.tick(); if (a.mode === 'steps') a.press('a'); }
  if (a.mode !== 'action') return { ok: false, why: 'no action menu' };
  a.press('a'); a.press('a');
  if (!fnOf(MID_SRC)(a, minDelta)) return { ok: false, why: 'no damaging hit with a mid-drain frame in turn 1' };
  if (!fnOf(FAINT_SRC)(a)) return { ok: false, why: 'no faint' };
  if (fnOf(PARTY_SRC)(a) !== true) return { ok: false, why: 'no forced party screen' };
  return { ok: true };
}
async function statusScenario(seed) { const a = await nodeBattle('?seed=' + seed + '&format=6v6&cpu=hard'); return fnOf(STATUS_SRC)(a, seed); }
async function findScenarios({ minDelta = 12, seeds = Array.from({ length: 80 }, (_x, i) => i + 1), statusSeeds = seeds } = {}) {
  const out = { pathSeed: null, statusSeed: null, rejected: [] };
  for (const s of seeds) { const r = await pathScenario(s, minDelta); if (r.ok) { out.pathSeed = s; break; } out.rejected.push(s + ': ' + r.why); }
  for (const s of statusSeeds) { if (await statusScenario(s)) { out.statusSeed = s; break; } }
  return out;
}
const SCEN = await findScenarios();
ok(SCEN.pathSeed !== null, 'scenario: a seed was found whose turn 1 has a damaging hit and which later has a faint and a forced party screen (seed ' + SCEN.pathSeed + '; rejected before it: ' + SCEN.rejected.slice(0, 4).join(' | ') + ')');
ok(SCEN.statusSeed !== null, 'scenario: a 6v6 hard battle with a statused Pokemon at a menu was found (seed ' + SCEN.statusSeed + ')');
{ const neg = await findScenarios({ minDelta: 1e9, seeds: [1, 2, 3], statusSeeds: [] }); ok(neg.pathSeed === null && neg.rejected.length === 3, 'scenario negative control: an impossible hit size finds no seed (the finder can say no)', JSON.stringify(neg).slice(0, 160)); }

const sessions = [];
let cdp = CDP0;
const session = (name, opts, fn) => sessions.push({ name, opts, fn });

// ---- 1. the three viewports (+ two small ones): layout, scale, touch targets, screenshots of the SAME scripted path
async function pathShots(page, tag, { touch }) {
  const shots = [];
  ok(await open(page, '?seed=' + SCEN.pathSeed + '&format=3v3&cpu=normal') === 'ready', tag + ': battle.html reaches ready (seed ' + SCEN.pathSeed + ', found at run time)');
  ok(!page.errors.length, tag + ': no console / page errors after load', page.errors.join(' | ').slice(0, 160));
  const lay = await ev(page, `(() => { const r = ${H}.canvas.getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, k: ${H}.scale && ${H}.scale.k, cw: r.width, ch: r.height, border: parseFloat(getComputedStyle(${H}.canvas).borderLeftWidth), dpr: window.devicePixelRatio, pad: document.body.dataset.pad, layout: document.body.dataset.layout, edge: document.body.dataset.edge }; })()`);
  ok(lay.sw <= lay.iw, tag + ': no horizontal scroll', JSON.stringify(lay));
  // THE PICTURE FILLS ITS ROOM (screenfit.js; the old rule here was a whole scale only, which left a 390 px phone a 324 px picture): 3:2, and k is the device pixels per source pixel it really has
  const inW = lay.cw - 2 * lay.border, inH = lay.ch - 2 * lay.border;
  ok(Math.abs(inW / inH - 1.5) < 0.01 && Math.abs(inW * lay.dpr - 240 * lay.k) < 0.05, tag + ': the picture is 3:2 and k is the device pixels per source pixel it really has (' + inW.toFixed(1) + ' css px @' + lay.dpr + 'x = ' + lay.k.toFixed(3) + 'x)', JSON.stringify(lay));
  if (touch && lay.layout === 'portrait') ok(lay.edge === '1' && lay.border === 0 && Math.abs(lay.cw - lay.iw) < 0.5, tag + ': a phone held upright: the picture runs edge to edge (' + lay.cw.toFixed(1) + ' of ' + lay.iw + ' css px, no frame)', JSON.stringify(lay));
  const small = await ev(page, `[...document.querySelectorAll('#top button, #top a, ${touch ? '#dpad .pbtn, #ab .pbtn' : '.textbtn'}')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.width < 43.5 || r.height < 43.5); }).map((b) => b.id || b.className)`);
  ok(small.length === 0, tag + ': every visible control is at least 44 css px', small.join(','));
  const colors = await ev(page, `(() => { const c = ${H}.canvas, d = c.getContext('2d').getImageData(0, 0, 240, 160).data; const s = new Set(); for (let i = 0; i < d.length; i += 4) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return s.size; })()`);
  ok(colors > 20, tag + ': the canvas is not blank', String(colors));
  shots.push(await shot(page, tag + '_1_preview'));
  // pick the team: keys on desktop, taps on touch
  if (touch) { const G = { x: 4, y: 14, pitch: 24 }; await tapLogical(page, 40, G.y + 0 * G.pitch + 10, true); await tapLogical(page, 40, G.y + 2 * G.pitch + 10, true); await tapLogical(page, 40, G.y + 4 * G.pitch + 10, true); }
  else { await key(page, 'a'); await key(page, 'down'); await key(page, 'a'); await key(page, 'down'); await key(page, 'a'); }
  await sleep(120);
  ok((await state(page)).picks && (await state(page)).picks.length === 3, tag + ': three picks made', JSON.stringify((await state(page)).picks));
  await shot(page, tag + '_1b_confirm');
  if (touch) { const yes = await ev(page, `(() => { const g = ${H}.ui.overlayRects(${H}.view().overlay); return { x: g.rows[0].x + g.rows[0].w / 2, y: g.rows[0].y + g.rows[0].h / 2 }; })()`); await tapLogical(page, yes.x, yes.y, true); } else await key(page, 'a');
  ok(await untilMode(page, 'action', { press: true }) === 'action', tag + ': the action menu opens after the intro');
  ok(await consistent(page) === 'ok', tag + ': displayed HP equals engine HP at the action menu', await consistent(page));
  shots.push(await shot(page, tag + '_2_action'));
  if (touch) await tapLogical(page, 150, 126, true); else await key(page, 'a');
  await sleep(80); ok(await mode(page) === 'moves', tag + ': FIGHT opens the move menu');
  shots.push(await shot(page, tag + '_3_moves'));
  // pause the clock and step exactly to a hit with the HP bar mid-drain
  await ev(page, `${H}.pause(true)`);
  if (touch) await tapLogical(page, 30, 126, true); else await key(page, 'a');
  const mid = await ev(page, `(${MID_SRC})(${H}, 12)`);
  ok(mid !== null, tag + ': a hit with the HP bar mid-drain was reached', JSON.stringify(mid));
  shots.push(await shot(page, tag + '_4_hit_middrain'));
  // the engine's HP is already final; the DISPLAYED hp is between the old value and the new one
  ok(mid && mid.hp > mid.to && mid.hp < mid.from, tag + ': displayed HP is mid-drain (between the old value and the engine value)', JSON.stringify(mid));
  // play on until a faint is on screen
  const faint = await ev(page, `(${FAINT_SRC})(${H})`);
  // animations off: the scene's own sinking sprite (drop > 0); animations on: the ROM's faint run is live and draws the whole screen (view.fxSys)
  ok(faint !== null && (faint.sys ? faint.live && faint.fxSys : faint.drop > 0), tag + ': a faint (sinking sprite, or the live ROM faint run) was reached', JSON.stringify(faint));
  shots.push(await shot(page, tag + '_5_faint'));
  // forced party screen
  const party = await ev(page, `(${PARTY_SRC})(${H})`);
  ok(party === true, tag + ': a forced party screen (after a faint) appeared');
  ev(page, `${H}.getState()`);
  shots.push(await shot(page, tag + '_6_party'));
  await ev(page, `${H}.pause(false)`);
  // finish the battle with the CPU in the human seat, then the result screen
  const r = await ev(page, `${H}.autoplay(400000, 'normal')`);
  ok(r.mode === 'result' && r.winner !== null, tag + ': the battle ends on the result screen', JSON.stringify(r));
  ok(await consistent(page) === 'ok', tag + ': displayed HP equals engine HP on the result screen', await consistent(page));
  shots.push(await shot(page, tag + '_7_result'));
  ok(!page.errors.length, tag + ': still no errors after a full battle', page.errors.join(' | ').slice(0, 160));
  return shots;
}

session('phone', { width: 390, height: 844, mobile: true }, async (page) => {
  await page.setViewport(390, 844, { mobile: true, dpr: 3 });
  await pathShots(page, 'phone390x844', { touch: true });
  // rotation mid-battle
  await open(page, '?seed=5&format=6v6');
  await page.setViewport(844, 390, { mobile: true, dpr: 3 });
  await sleep(300);
  const lay = await ev(page, `({ layout: document.body.dataset.layout, sw: document.documentElement.scrollWidth, iw: innerWidth })`);
  ok(lay.layout === 'landscape' && lay.sw <= lay.iw, 'rotation: the layout flips to landscape without horizontal scroll', JSON.stringify(lay));
  await shot(page, 'phone_rotated_landscape');
  await page.setViewport(390, 844, { mobile: true, dpr: 3 });
  await sleep(200);
  ok((await ev(page, `document.body.dataset.layout`)) === 'portrait', 'rotation: and back to portrait');
  ok(!page.errors.length, 'rotation: no errors', page.errors.join('|').slice(0, 120));
  // 320 x 568
  await page.setViewport(320, 568, { mobile: true, dpr: 2 });
  await open(page, '?seed=5&format=3v3');
  const l2 = await ev(page, `({ sw: document.documentElement.scrollWidth, iw: innerWidth, cw: ${H}.canvas.getBoundingClientRect().width, pads: [...document.querySelectorAll('#dpad .pbtn, #ab .pbtn')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && r.width >= 43.5 && r.height >= 43.5; }) })`);
  ok(l2.sw <= l2.iw && l2.pads, '320x568: nothing overflows and every pad button fits and is >= 44 px', JSON.stringify(l2));
  await shot(page, 'phone320x568_preview');
  await page.setViewport(568, 320, { mobile: true, dpr: 2 });
  await sleep(250);
  const l3 = await ev(page, `({ sw: document.documentElement.scrollWidth, iw: innerWidth, k: ${H}.scale.k, pads: [...document.querySelectorAll('#dpad .pbtn, #ab .pbtn')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5; }) })`);
  ok(l3.sw <= l3.iw && l3.k >= 1, '568x320: no horizontal scroll, canvas scaled', JSON.stringify(l3));
  await shot(page, 'phone568x320_preview');
});

session('landscape', { width: 844, height: 390, mobile: true }, async (page) => {
  await page.setViewport(844, 390, { mobile: true, dpr: 3 });
  await pathShots(page, 'land844x390', { touch: true });
});

session('desktop', { width: 1280, height: 800 }, async (page) => {
  await pathShots(page, 'desk1280x800', { touch: false });
  // a status move in the move menu (a battle where somebody is statused at a menu)
  let found = false;
  for (const seed of SCEN.statusSeed !== null ? [SCEN.statusSeed] : [5, 13, 19, 1, 14, 18]) {
    await open(page, `?seed=${seed}&format=6v6&cpu=hard`);
    const res = await ev(page, `(${STATUS_SRC})(${H}, ${seed})`);
    if (res) { found = true; ok(true, 'status: reached a menu with a statused Pokemon (seed ' + res.seed + ', mine ' + res.status + ', foe ' + res.foe + ')'); await key(page, 'a'); await sleep(60); ok(await mode(page) === 'moves', 'status: the move menu opens on a statused Pokemon'); await ev(page, `${H}.view()`); await shot(page, 'desk_status_moves'); await ev(page, `${H}.pause(false)`); break; }
  }
  ok(found, 'status: a battle with a statused Pokemon at a menu was found');
});

// ---- 2. human play with real keys: forfeit, confirm, determinism, mashing
session('keys', { width: 1280, height: 800 }, async (page) => {
  ok(await open(page, '?seed=3&format=6v6&cpu=normal') === 'ready', 'keys: ready');
  ok(await untilMode(page, 'action', { press: true }) === 'action', 'keys: action menu');
  await key(page, 'down'); await key(page, 'right'); await key(page, 'a');
  ok(await mode(page) === 'confirm', 'keys: RUN opens the forfeit confirm');
  ok(/give up on this battle/.test(await ev(page, `${H}.view().box.text.join(' ')`)), 'keys: the confirm shows the question text in the message box');
  await shot(page, 'keys_forfeit_confirm');
  await key(page, 'b'); ok(await mode(page) === 'action', 'keys: B cancels the confirm');
  await key(page, 'a');                                                         // cursor is on RUN again
  await key(page, 'up'); await key(page, 'a');                                  // YES
  const end = await untilMode(page, 'result', { max: 20000, press: true });
  ok(end === 'result', 'keys: YES forfeits and the result screen appears', end);
  const st = await state(page);
  ok(st.winner === 1, 'keys: a forfeit is a loss (the CPU wins)', JSON.stringify(st.winner));
  const txt = await ev(page, `${H}.scene.S.result.head.join(' ')`);
  ok(/lost to CPU Normal/.test(txt), 'keys: the loss line is the ROM text', txt);
  await shot(page, 'keys_result_loss');
  // result options by keyboard: LEAVE navigates (intercepted)
  await ev(page, `window.__nav = []; window.__arenaNavigate = (u) => window.__nav.push(u);`);
  await page.waitFor(`${H}.scene.state().resultArmed`, { timeoutMs: 20000 });          // W1 fix D1: the result screen takes no choice for its first 90 frames
  await key(page, 'left'); await key(page, 'left'); await key(page, 'a');                // ST1: the cursor ring is RECAP, REMATCH, EDIT TEAM / NEW BATTLE, BACK TO HUB: left from REMATCH is RECAP, left again wraps to the last option
  ok((await ev(page, `window.__nav[0]`)) === '/pokemonarena/', 'keys: LEAVE goes back to the Arena', JSON.stringify(await ev(page, 'window.__nav')));
  await ev(page, `window.__nav = []`);
  await open(page, '?seed=3&format=6v6');
  await ev(page, `${H}.autoplay(400000)`); await ev(page, `window.__arenaNavigate = (u) => { window.__nav = (window.__nav || []).concat(u); }`);
  const early = await ev(page, `(() => { const armed = ${H}.scene.state().resultArmed; ${H}.press('a'); return { armed, navs: (window.__nav || []).length }; })()`);
  ok(early.armed === false && early.navs === 0, 'keys: an A pressed the instant the result screen appears chooses nothing (the D1 guard)', JSON.stringify(early));
  await page.waitFor(`${H}.scene.state().resultArmed`, { timeoutMs: 20000 });          // W1 fix D1: the result screen takes no choice for its first 90 frames
  await key(page, 'a');
  const nav = await ev(page, `window.__nav`);
  ok(Array.isArray(nav) && /seed=\d+/.test(String(nav[0])) && !/seed=3(&|$)/.test(String(nav[0])), 'keys: REMATCH reloads with a fresh seed', JSON.stringify(nav));
  // ---- determinism: same seed + same choices -> identical engine hashes, on two page loads
  const run = async () => {
    await open(page, '?seed=77&format=3v3&cpu=hard');
    return ev(page, `(() => { const a = ${H}; a.pause(true); const rnd = (() => { let s = 12345; return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; }; })(); for (let k = 0; k < 200000; k++) { a.scene.tick(); const m = a.mode; if (m === 'preview') { const p = a.scene.S.preview; if (p.picks.length < p.pick) { a.press('a'); if (a.mode === 'preview') a.press('down'); } } else if (m === 'confirm') a.press('a'); else if (m === 'action') { a.press('a'); } else if (m === 'moves') { const r = a.scene.S.req.moves; let i = rnd(r.length); for (let g = 0; g < 4 && r[i].disabled; g++) i = (i + 1) % r.length; for (let g = 0; g < 6 && a.scene.S.moveCursor !== i; g++) a.press(a.scene.S.moveCursor < i ? 'down' : 'up'); a.press('a'); } else if (m === 'party') a.press('a'); else if (m === 'steps' && k % 53 === 0) a.press('a'); if (m === 'result') break; } return { hash: a.hash(), log: a.logHash(), turn: a.ctl.turn, winner: a.ctl.winner, n: a.events().length }; })()`);
  };
  const d1 = await run(), d2 = await run();
  ok(d1.winner !== null && d1.hash === d2.hash && d1.log === d2.log && d1.n === d2.n, 'determinism: same seed + same human choices -> identical engine hashes on two page loads', JSON.stringify(d1) + ' vs ' + JSON.stringify(d2));
  // ---- mashing: random keys and random on-screen hook presses, no errors, the invariant still holds when idle
  await open(page, '?seed=19&format=3v3');
  const names = Object.keys(KEYS);
  let rs = 99;
  for (let i = 0; i < 260; i++) { rs = (Math.imul(rs, 1103515245) + 12345) >>> 0; const k = names[(rs >>> 8) % names.length]; if ((rs >>> 3) & 1) await key(page, k); else await ev(page, `${H}.press(${JSON.stringify(k)}); ${H}.tick(${(rs >>> 11) % 40})`); }
  await sleep(200);
  ok(!page.errors.length, 'mash: 260 random inputs raise no errors', page.errors.join(' | ').slice(0, 160));
  ok(['preview', 'confirm', 'steps', 'action', 'moves', 'party', 'menu', 'result', 'wait'].includes(await mode(page)), 'mash: the scene is still in a valid mode', await mode(page));
  const cons = await consistent(page); ok(cons === 'ok' || cons === 'busy', 'mash: displayed state still matches the engine', cons);
  // ---- the START menu and sound toggle inside the canvas
  await open(page, '?seed=3&format=6v6');
  await untilMode(page, 'action', { press: true });
  await key(page, 'start'); ok(await mode(page) === 'menu', 'menu: START opens the in-canvas menu');
  ok(/What will/.test(await ev(page, `${H}.view().box.prompt ? ${H}.view().box.prompt.join(' ') : ''`)), 'menu: the action prompt stays visible behind the menu');
  await shot(page, 'keys_start_menu');
  await key(page, 'start'); ok(await mode(page) === 'action', 'menu: START closes it');
});

// ---- 3. touch pads and a controller
session('pads', { width: 390, height: 844, mobile: true }, async (page) => {
  await page.setViewport(390, 844, { mobile: true, dpr: 3 });
  await addInit(page, PAD_DOUBLE);
  ok(await open(page, '?seed=5&format=3v3') === 'ready', 'pads: ready');
  const center = async (id) => ev(page, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  let c = await center('bA'); await page.tap(c.x, c.y); await sleep(100);
  ok((await state(page)).picks.length === 1, 'pads: the on-screen A button picks the first Pokemon');
  c = await center('bDown'); await page.tap(c.x, c.y); await sleep(100);
  ok((await state(page)).partyCursor === null && (await ev(page, `${H}.scene.S.preview.cursor`)) === 1, 'pads: the on-screen d-pad moves the cursor');
  c = await center('bB'); await page.tap(c.x, c.y); await sleep(100);
  ok((await state(page)).picks.length === 0, 'pads: the on-screen B button un-picks');
  // controller: button 0 = A, 13 = down (Xbox layout); a real 'gamepadconnected' arms scanning
  await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
  const padPress = async (idx) => { await ev(page, `window.__pad.buttons[${idx}] = 1`); await sleep(130); await ev(page, `window.__pad.buttons[${idx}] = 0`); await sleep(130); };
  await padPress(0); await padPress(13); await padPress(0);
  const picks = (await state(page)).picks;
  ok(picks.length === 2, 'controller: A / D-pad down / A pick two Pokemon', JSON.stringify(picks));
  await padPress(13); await padPress(0);
  ok((await mode(page)) === 'confirm', 'controller: the third pick opens the confirm');
  await padPress(0);                                                                // YES
  ok(await untilMode(page, 'action', { press: true }) === 'action', 'controller: confirm with A starts the battle');
  await ev(page, `window.__pad.axes[0] = 1`); await sleep(150); await ev(page, `window.__pad.axes[0] = 0`); await sleep(100);
  ok((await state(page)).cursor === 1, 'controller: the stick moves the action menu cursor', String((await state(page)).cursor));
  await padPress(9);                                                                // start
  ok((await mode(page)) === 'menu', 'controller: Start opens the menu');
  await padPress(1);                                                                // B closes
  ok((await mode(page)) === 'action', 'controller: B closes it');
  // taps and mouse on the canvas itself: tap FIGHT, tap the first move
  await tapLogical(page, 150, 126, true); await sleep(80);
  ok((await mode(page)) === 'moves', 'touch: tapping FIGHT on the canvas opens the moves');
  await tapLogical(page, 150, 126, true);                                           // a move cell (R.mv[1]) region: choose
  await sleep(120);
  ok((await mode(page)) === 'steps' || (await mode(page)) === 'moves', 'touch: tapping a move submits it or explains why not');
  ok(!page.errors.length, 'pads: no errors', page.errors.join('|').slice(0, 120));
});

// ---- 4. hostile URLs and ROM faults
session('urls', { width: 1280, height: 800 }, async (page) => {
  const hostile = [
    ['?team=%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D1%3E', 'team'],
    ['?team=%3Cscript%3Ewindow.__xss%3D2%3C%2Fscript%3E', 'team'],
    ['?team=ARENA1.%22%3E%3Csvg%20onload%3Dwindow.__xss%3D3%3E.0000', 'team'],
    ['?foe=%3Cb%3Eboom%3C%2Fb%3E', 'foe'],
    ['?seed=%3Cb%3E', 'seed'], ['?seed=99999999999', 'seed'], ['?seed=-5', 'seed'],
    ['?format=%27%3E%3Cscript%3E', 'format'], ['?cpu=__proto__', 'cpu'], ['?speed=ludicrous', 'speed'],
    ['?team=' + 'A'.repeat(4000), 'team'],
  ];
  const scriptsBefore = await (async () => { await open(page, '?seed=1&format=6v6'); return ev(page, `document.scripts.length`); })();
  for (const [q, param] of hostile) {
    const s = await open(page, q);
    // (the header's own icons are static markup, not content from the address: the Fullscreen buttons' corner brackets, and the audio bar's speaker and note icons from js/audiobar.js)
    const info = await ev(page, `(() => ({ state: ${H}.state, kind: ${H}.kind, param: ${H}.param, xss: typeof window.__xss, imgs: [...document.querySelectorAll('img, svg, iframe')].filter((e) => !e.closest('#fullBtn, #fullExit, #audioBar')).length, scripts: document.scripts.length, errVisible: !document.getElementById('error').hidden, canvasHidden: document.getElementById('battle').hidden, body: document.getElementById('error').innerHTML.includes('<') && /<(img|svg|script|b)\\b/i.test(document.getElementById('error').innerHTML) }))()`);
    ok(s === 'error' && info.kind === 'params' && info.param === param && info.errVisible && info.canvasHidden, 'hostile ' + q.slice(0, 40) + ': refused with an error screen naming ' + param, JSON.stringify(info));
    ok(info.xss === 'undefined' && info.imgs === 0 && info.body === false && info.scripts === scriptsBefore, 'hostile ' + q.slice(0, 40) + ': nothing was executed or injected', JSON.stringify(info));
    const msg = await ev(page, `document.getElementById('errMsg').textContent + document.getElementById('errTitle').textContent + document.getElementById('errDetail').textContent`);
    const val = decodeURIComponent(q.split('=').slice(1).join('=')).slice(0, 20);
    ok(!(val.length > 5 && msg.includes(val)), 'hostile ' + q.slice(0, 40) + ': the value is not echoed', msg.slice(0, 80));
  }
  await shot(page, 'urls_error_screen');
  // an undecodable but well-formed code is refused AFTER the ROM loads
  ok(await open(page, '?team=ARENA1.AAAAAAAA.0000&format=6v6') === 'error', 'urls: a well-formed but undecodable team code is refused with an error screen');
  ok((await ev(page, `${H}.param`)) === 'team', 'urls: ... naming the team parameter');
  // valid contract forms
  for (const q of ['?seed=5', '?seed=5&format=6v6&cpu=easy', '?seed=5&format=3v3&cpu=hard&foe=random']) ok(await open(page, q) === 'ready', 'urls: ' + q + ' starts a battle');
  // a real team code in the URL
  const code = await page.eval(`(async () => { const tc = await import('/pokemonarena/js/teamcode.js'), mc = await import('/pokemonarena/js/matchctl.js'), T = await import('/pokemonarena/js/tables.js'), RM = await import('/pokemonarena/js/rom.js'); return window.__code || null; })()`).catch(() => null);
  void code;
  // ---- ROM faults through request interception
  const rom = fs.readFileSync(ROM_PATH);
  const fault = async (name, kind, respond) => {
    page.handlers.length = 0;
    // (the page now keeps a verified ROM in Cache Storage between visits: js/romcache.js, added by another change. An injected network fault only means something if the ROM has to be DOWNLOADED, so the stored copy is cleared first.)
    await page.eval("caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => true)").catch(() => {});
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*Pokemon*SoulGold*', requestStage: 'Request' }] });
    page.handlers.push((m) => { if (m.method === 'Fetch.requestPaused') respond(m.params); });
    await page.navigate(BASE + '?seed=2&format=6v6');
    await page.waitFor(`${H} && (${H}.state === "error" || ${H}.state === "ready")`, { timeoutMs: 90000 });
    const r = await ev(page, `({ state: ${H}.state, kind: ${H}.kind, title: document.getElementById('errTitle').textContent, retry: !document.getElementById('retry').hidden })`);
    ok(r.state === 'error' && r.kind === kind, name + ': error kind ' + kind, JSON.stringify(r));
    await page.send('Fetch.disable');
    page.handlers.length = 0;
    return r;
  };
  const fulfill = (p, status, body) => page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }], body: body.toString('base64') });
  const rm = await fault('missing ROM', 'missing', (p) => { fulfill(p, 404, Buffer.from('nope')); });
  ok(rm.retry, 'missing ROM: a Try again button is offered');
  await shot(page, 'urls_missing_rom');
  await fault('truncated ROM', 'length', (p) => { fulfill(p, 200, Buffer.from('<html>404</html>')); });
  const bad = Buffer.from(rom); bad[0x200000] ^= 1;
  await fault('wrong ROM (one flipped bit)', 'hash', (p) => { fulfill(p, 200, bad); });
  await shot(page, 'urls_wrong_rom');
  const wrongHdr = Buffer.from(rom); wrongHdr[0xac] = 0x41;
  await fault('wrong game code', 'format', (p) => { fulfill(p, 200, wrongHdr); });
  ok(!page.errors.some((e) => /Uncaught|TypeError/.test(e)), 'ROM faults raise no uncaught exceptions', page.errors.join('|').slice(0, 160));
});

// ---- 5. audio (MU3's policy): sound is ON by default but nothing is heard (or even created) before the first click, tap or key; the header Sound button OPENS the SOUND panel
//         (it does not toggle). Verified by a test double (no real audio device is ever opened). Settings live in localStorage['arena.audio'] (JSON v:1); the old arena.sound is migrated once.
async function soundPolicy(page, base) {
  const r = {};
  await page.navigate(base + '?seed=7&format=6v6');
  await page.waitFor(`${H} && ${H}.state === "ready" && window.__arenaSound`, { timeoutMs: 90000 });
  r.on = await ev(page, `${H}.sound.on()`);
  r.ctor0 = await ev(page, `window.__audioLog.ctor`);
  r.stored0 = await ev(page, `[localStorage.getItem('arena.audio'), localStorage.getItem('arena.sound')]`);
  r.label0 = await ev(page, `document.getElementById('soundBtn').textContent`);
  return r;
}
const SOUND_POLICY_CHECKS = (r) => [
  ['sound is ON by default (the Sound button reads "Sound: on")', r.on === true && r.label0 === 'Sound: on'],
  // (the page tries at load, so one context may exist; the double keeps it suspended without a gesture, so nothing can start. Nothing is stored either way.)
  ['... but nothing is running and nothing is stored before the first click, tap or key (the context tried at load, if any, is suspended)', r.ctor0 <= 1 && r.stored0[0] === null && r.stored0[1] === null],
];
session('audio', { width: 1280, height: 800 }, async (page) => {
  const r0 = await soundPolicy(page, BASE);
  for (const [n, c] of SOUND_POLICY_CHECKS(r0)) ok(c === true, 'audio: ' + n, JSON.stringify(r0));
  const r = await ev(page, `${H}.autoplay(300000)`);
  const log = await ev(page, `window.__audioLog`);
  ok(r.mode === 'result', 'audio: a whole battle plays', JSON.stringify(r));
  ok(log.ctor <= 1 && log.start === 0, 'audio: a whole battle played with no click, tap or key starts no source (the context tried at load stays suspended: the browser would not allow it)', JSON.stringify(log));
  // the header button OPENS the panel (a real click is a user gesture and creates the one AudioContext)
  const sb = await ev(page, `(() => { const r = document.getElementById('soundBtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(sb.x, sb.y); await sleep(400);
  const on = await ev(page, `({ open: (() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden; })(), label: document.getElementById('soundBtn').textContent, popup: document.getElementById('soundBtn').getAttribute('aria-haspopup'), pressed: document.getElementById('soundBtn').hasAttribute('aria-pressed') })`);
  ok(on.open && on.label === 'Sound: on' && on.popup === 'dialog' && on.pressed === false, 'audio: clicking Sound opens the SOUND panel (it does not toggle; the button stays "Sound: on")', JSON.stringify(on));
  ok((await ev(page, `window.__audioLog.ctor`)) === 1, 'audio: exactly one AudioContext, created inside the click');
  const sc = await ev(page, `(() => { const r = document.querySelector('#soundDialog [data-snd="close"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(sc.x, sc.y); await sleep(300);
  ok((await ev(page, `document.getElementById('soundDialog').hidden`)) === true, 'audio: Close closes the SOUND panel');
  // M mutes: stored as arena.audio, the button says off; a reload keeps it muted (and still creates no context before a gesture)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', text: 'm', windowsVirtualKeyCode: 77 }); await sleep(40); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }); await sleep(300);
  const st = JSON.parse((await ev(page, `localStorage.getItem('arena.audio')`)) || 'null');
  ok(st && st.v === 1 && st.muted === true && (await ev(page, `document.getElementById('soundBtn').textContent`)) === 'Sound: off' && (await ev(page, `${H}.sound.on()`)) === false, 'audio: M mutes (arena.audio {v:1, muted:true}, the button reads "Sound: off")', JSON.stringify(st));
  await open(page, '?seed=7&format=6v6');                                          // reload: still muted, no context before a gesture
  ok((await ev(page, `window.__audioLog.ctor`)) === 0 && (await ev(page, `${H}.sound.on()`)) === false, 'audio: after a reload the muted setting is kept and no AudioContext exists before a gesture');
  await key(page, 'a'); await sleep(150);
  ok((await ev(page, `window.__audioLog.ctor`)) === 1, 'audio: the first key press creates the AudioContext (even muted, so a controller can unmute later)');
  await ev(page, `localStorage.removeItem('arena.audio'); localStorage.removeItem('arena.sound')`);
  await open(page, '?seed=7&format=6v6');                                          // back to the default: sound on; a key creates the context and a played battle starts the cries on the double
  await key(page, 'a'); await sleep(150);
  const r2 = await ev(page, `${H}.autoplay(300000)`);
  const log2 = await ev(page, `window.__audioLog`);
  ok(log2.ctor === 1 && log2.createBuffer > 0 && log2.start > 0, 'audio: with sound on the cries are decoded and started on the double (' + log2.start + ' starts)', JSON.stringify(log2));
  void r2;
  ok(!page.errors.length, 'audio: no errors', page.errors.join('|').slice(0, 120));
});
session('audio default negative control', { width: 1280, height: 800 }, async (page) => {
  // a copy of the page whose default is the OLD one (sound off until turned on): the very same policy check must FAIL
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bp-snd-'));
  const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
  mutateFile(d, 'js/audio_mixer.js', "muted: false, soundtrack: 'soulgold' });", "muted: true, soundtrack: 'soulgold' });");
  const ov = await startOverlay({ dir: d, port: PORT + 12, upstream: `http://localhost:${PORT}` });
  try {
    const r = await soundPolicy(page, ov.url + '/pokemonarena/battle.html');
    const failed = SOUND_POLICY_CHECKS(r).filter(([, c]) => c !== true);
    ok(failed.length >= 1 && r.on === false, 'audio negative control: with the old default (sound off) the "sound is ON by default" check FAILS', JSON.stringify(r));
  } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
});

// ---- 6. W1 fix D2: after a MOUSE click on a header button (Menu, Sound, Controls) the keys still drive the game; after TABBING to Menu and pressing Enter they do too.
//         Real key events (Enter carries its character, as a real press does; without it Chrome would not click a focused button) and real mouse events.
const REAL_KEYS = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], a: ['Enter', 'Enter', 13, '\r'], b: ['Backspace', 'Backspace', 8], esc: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9] };
async function realKey(page, name, hold = 30) {
  const k = REAL_KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], code: k[1], windowsVirtualKeyCode: k[2], ...(k[3] ? { text: k[3] } : {}) });
  await sleep(hold);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[1], windowsVirtualKeyCode: k[2] });
  await sleep(40);
}
const centreOf = (page, sel) => ev(page, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const activeId = (page) => ev(page, `(() => { const a = document.activeElement; return a === ${H}.canvas ? 'canvas' : (a && (a.id || a.tagName)) || 'none'; })()`);
const clickSel = async (page, sel) => { const c = await centreOf(page, sel); await page.click(c.x, c.y); await sleep(300); };
async function readyAction(page, base, query = '?seed=7&format=6v6') {
  await page.navigate(base + query);
  await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
  return untilMode(page, 'action', { press: true });
}
async function focusCheck(page, base) {
  const r = {};
  // order 1: the MOUSE first, then the keys
  await readyAction(page, base);
  await clickSel(page, '#menuBtn');
  r.menuOpened = (await mode(page)) === 'menu';
  r.afterMenuClickFocus = await activeId(page);
  await realKey(page, 'down'); await realKey(page, 'a'); await sleep(350);
  r.controlsViaKeys = await ev(page, `${H}.controlsOpen === true`);
  await realKey(page, 'esc'); await sleep(350);
  r.controlsClosed = await ev(page, `${H}.controlsOpen === false`);
  await realKey(page, 'esc'); await sleep(150);                                    // B closes the pause menu that came back
  r.modeAfterMenu = await mode(page);
  await realKey(page, 'a'); await sleep(150);
  r.enterFights = (await mode(page)) === 'moves';
  await realKey(page, 'b'); await sleep(100);
  await clickSel(page, '#soundBtn');
  r.soundPanelOpen = await ev(page, `(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden; })()`);
  await clickSel(page, '#soundDialog [data-snd="close"]');
  r.soundPanelClosed = await ev(page, `(() => { const d = document.getElementById('soundDialog'); return !!d && d.hidden; })()`);
  r.afterSoundFocus = await activeId(page);
  await realKey(page, 'a'); await sleep(150);
  r.enterAfterSound = (await mode(page)) === 'moves';
  await realKey(page, 'b'); await sleep(100);
  await clickSel(page, '#controlsBtn');
  r.hdrControlsOpen = await ev(page, `${H}.controlsOpen === true`);
  await clickSel(page, '#controlsClose');
  r.afterControlsFocus = await activeId(page);
  await realKey(page, 'a'); await sleep(150);
  r.enterAfterControls = (await mode(page)) === 'moves';
  // order 2: KEYS only -- Tab to the Menu button, Enter on it, then the keys drive the menu
  await readyAction(page, base);
  await ev(page, `document.getElementById('soundBtn').focus()`);
  for (let g = 0; g < 8 && (await activeId(page)) !== 'menuBtn'; g++) await realKey(page, 'tab');
  r.tabbedToMenu = (await activeId(page)) === 'menuBtn';
  await realKey(page, 'a'); await sleep(300);
  r.kbMenuOpened = (await mode(page)) === 'menu';
  r.kbFocus = await activeId(page);
  await realKey(page, 'down'); await realKey(page, 'a'); await sleep(350);
  r.kbControls = await ev(page, `${H}.controlsOpen === true`);
  return r;
}
const FOCUS_CHECKS = (r) => [
  ['mouse then keys: a click on Menu opens the pause menu and leaves focus on the canvas', r.menuOpened && r.afterMenuClickFocus === 'canvas'],
  ['mouse then keys: Down + Enter drive the pause menu and open CONTROLS', r.controlsViaKeys],
  ['mouse then keys: Esc closes CONTROLS, Esc closes the menu, and Enter is then the game\'s A (FIGHT)', r.controlsClosed && r.modeAfterMenu === 'action' && r.enterFights],
  ['mouse then keys: after a click on Sound and its panel closing, focus is on the canvas and Enter fights', r.soundPanelOpen && r.soundPanelClosed && r.afterSoundFocus === 'canvas' && r.enterAfterSound],
  ['mouse then keys: after a click on the header Controls button and Close, focus is on the canvas and Enter fights', r.hdrControlsOpen && r.afterControlsFocus === 'canvas' && r.enterAfterControls],
  ['keys only: Tab reaches Menu, Enter opens the pause menu and focus moves to the canvas', r.tabbedToMenu && r.kbMenuOpened && r.kbFocus === 'canvas'],
  ['keys only: Down + Enter then open CONTROLS', r.kbControls],
];
session('focus (D2)', { width: 1280, height: 800 }, async (page) => {
  const r = await focusCheck(page, BASE);
  for (const [name, cond] of FOCUS_CHECKS(r)) ok(cond === true, 'D2 ' + name, JSON.stringify(r));
  ok(!page.errors.length, 'D2: no errors', page.errors.join('|').slice(0, 120));
});
session('focus (D2) negative control', { width: 1280, height: 800 }, async (page) => {
  // the same real-key check against a copy of the page whose Menu handler does NOT give focus back to the canvas (the defect): it must FAIL on exactly the Menu checks
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bp-d2-'));
  const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
  mutateFile(d, 'js/battle_boot.js', "if (!controlsOpen && !document.querySelector('[role=\"dialog\"]:not([hidden])')) { try { canvas.focus({ preventScroll: true }); }", "if (false) { try { canvas.focus({ preventScroll: true }); }");
  const ov = await startOverlay({ dir: d, port: PORT + 10, upstream: `http://localhost:${PORT}` });
  try {
    const r = await focusCheck(page, ov.url + '/pokemonarena/battle.html');
    const failed = FOCUS_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
    ok(failed.some((n) => /mouse then keys: a click on Menu/.test(n)) && failed.some((n) => /Down \+ Enter drive the pause menu and open CONTROLS/.test(n)) && failed.some((n) => /keys only: Tab reaches Menu/.test(n)), 'D2 negative control: with the refocus removed the real-key check FAILS on the Menu checks (' + failed.length + ' of 7 fail)', JSON.stringify(r).slice(0, 300));
  } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
});

// ---- 6b. W1 fix A4 / A5: the move menu shows a visible BACK and a visible INFO (touch never needs the on-screen pad, a mouse can read a move) -- used here by TOUCH on a phone
async function chipsCheck(page, base) {
  const r = {};
  await readyAction(page, base);
  const chip = (id) => ev(page, `(() => { const e = document.getElementById(${JSON.stringify(id)}); const r = e.getBoundingClientRect(); const c = ${H}.canvas.getBoundingClientRect(); return { shown: !document.getElementById('ctxchips').hidden && r.width > 0, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, inside: r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1 }; })()`);
  r.hiddenInAction = !(await chip('chipBack')).shown;
  await ev(page, `${H}.press('a')`); await sleep(250);
  r.mode1 = await mode(page);
  const b = await chip('chipBack'), i = await chip('chipInfo');
  r.back = b; r.info = i;
  await page.tap(b.x, b.y); await sleep(300);
  r.afterBack = await mode(page);
  r.hiddenAfter = !(await chip('chipBack')).shown;
  await ev(page, `${H}.press('a')`); await sleep(250);
  const i2 = await chip('chipInfo');
  await page.tap(i2.x, i2.y); await sleep(250);
  r.afterInfo = await mode(page);
  await ev(page, `${H}.settle(6000)`); await sleep(150);
  r.afterInfoSettled = await mode(page);
  r.hint = await ev(page, `(() => { const k = document.getElementById('keys'); return k ? k.textContent : ''; })()`);
  return r;
}
const CHIPS_CHECKS = (r) => [
  ['no chips in the action menu', r.hiddenInAction === true],
  ['FIGHT opens the move menu and two chips appear on the picture (Back, Info), each at least 44 px and inside the picture', r.mode1 === 'moves' && r.back.shown && r.info.shown && r.back.w >= 44 && r.back.h >= 44 && r.info.w >= 44 && r.info.h >= 44 && r.back.inside && r.info.inside],
  ['a tap on Back goes back to the action menu and the chips go away', r.afterBack === 'action' && r.hiddenAfter === true],
  ['a tap on Info reads the move (a message) and the move menu comes back', r.afterInfo === 'steps' && r.afterInfoSettled === 'moves'],
];
session('move menu chips (A4/A5)', { width: 390, height: 844, mobile: true, dpr: 3 }, async (page) => {
  const r = await chipsCheck(page, BASE);
  for (const [n, c] of CHIPS_CHECKS(r)) ok(c === true, 'chips: ' + n, JSON.stringify(r).slice(0, 400));
});
session('move menu chips negative control (A4/A5)', { width: 390, height: 844, mobile: true, dpr: 3 }, async (page) => {
  // a copy whose Back chip does nothing: the same touch check must FAIL
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bp-chip-'));
  const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
  mutateFile(d, 'js/battle_boot.js', "$('chipBack').addEventListener('click', () => chipPress('b'));", "$('chipBack').addEventListener('click', () => {});");
  const ov = await startOverlay({ dir: d, port: PORT + 13, upstream: `http://localhost:${PORT}` });
  try {
    const r = await chipsCheck(page, ov.url + '/pokemonarena/battle.html');
    ok(CHIPS_CHECKS(r).some(([, c]) => c !== true) && r.afterBack !== 'action', 'chips negative control: with the Back chip dead the same touch check FAILS', JSON.stringify(r).slice(0, 300));
  } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
});

// ---- 7. W1 fix D11: reloading in the middle of a battle RESUMES it (same turn, same state hash, the action menu), silently; a fresh visit and a finished battle do not
const playTo = (page, turns) => ev(page, `(() => { const a = ${H}; let g = 0; while (g++ < 400000 && a.mode !== 'result') { if (a.mode === 'action' && a.ctl.turn >= ${turns}) return 'at'; a.scene.tick(); if (a.mode === 'action' && a.ctl.turn >= ${turns}) return 'at'; if (a.mode === 'action' || a.mode === 'moves' || a.mode === 'party') a.press('a'); else if (a.mode === 'steps' && g % 61 === 0) a.press('a'); } return a.mode; })()`);
const snap = (page) => ev(page, `(() => { const a = ${H}, s = a.getState(); return { mode: a.mode, turn: a.ctl.turn, hash: a.ctl.battle.hash(), player: s.player, foe: s.foe, weather: s.weather }; })()`);
const resumeKeys = (page) => ev(page, `Object.keys(sessionStorage).filter((k) => k.startsWith('arena.resume:')).length`);
async function reload(page) {
  await ev(page, 'window.__marker = 1; true');
  await page.send('Page.reload', {});
  await page.waitFor(`window.__marker === undefined && ${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
}
async function resumeCheck(page, base) {
  const r = {};
  await readyAction(page, base);
  r.first = await ev(page, `${H}.resume`);
  r.played = await playTo(page, 3);
  await sleep(150);                                                                // the record is written once the engine has answered (end of the task)
  r.before = await snap(page);
  r.stored = await resumeKeys(page);
  await reload(page);
  await untilMode(page, ['action', 'moves', 'party', 'result'], { max: 4000 });
  r.nav = await ev(page, `performance.getEntriesByType('navigation')[0].type`);
  r.resume = await ev(page, `${H}.resume`);
  r.after = await snap(page);
  r.sounds = await ev(page, `${H}.soundEvents().length`);
  r.shot = r.after.mode === 'action';
  // a FRESH visit of the same address (arriving from another page, as a link or the address bar does) is a new battle. (Chrome itself treats "enter the address you are already on"
  // as a reload, so a visit from the same address is not the case that is meant here.)
  await page.navigate('about:blank');
  await page.navigate(base + '?seed=7&format=6v6');
  await page.waitFor(`${H} && ${H}.state === "ready"`, { timeoutMs: 90000 });
  r.fresh = await ev(page, `${H}.resume`);
  r.freshTurn = await ev(page, `${H}.ctl.turn`);
  r.freshKeys = await resumeKeys(page);
  // a battle that ENDS leaves no record
  await readyAction(page, base);
  await playTo(page, 2); await sleep(150);
  r.midKeys = await resumeKeys(page);
  await ev(page, `${H}.autoplay(400000)`); await sleep(200);
  r.doneMode = await mode(page);
  r.doneKeys = await resumeKeys(page);
  return r;
}
const RESUME_CHECKS = (r) => [
  ['a first visit does not resume anything', r.first && r.first.restored === false],
  ['a battle under way leaves a record', r.played === 'at' && r.stored === 1],
  ['the page was reloaded (navigation type "reload"), not visited afresh', r.nav === 'reload'],
  ['after the reload the battle is RESUMED (hook.resume.restored with the saved choices)', r.resume && r.resume.restored === true && r.before && r.resume.choices >= Math.max(2, r.before.turn - 1) && r.resume.turn === r.before.turn],      // one human choice per finished turn at least (the old '>= 3' held only while the battle happened to need a forced switch before turn 3; the engine moved)
  ['... on the action menu of the SAME turn with the SAME state hash', r.after && r.before && r.after.mode === 'action' && r.after.turn === r.before.turn && r.after.hash === r.before.hash],
  ['... with the same Pokemon on the field, the same HP and the same weather', r.after && r.before && JSON.stringify([r.after.player, r.after.foe, r.after.weather]) === JSON.stringify([r.before.player, r.before.foe, r.before.weather])],
  ['... and the replayed history made no sound', r.sounds === 0],
  ['a fresh visit of the same address is a new battle (not resumed, the old record dropped)', r.fresh && r.fresh.restored === false && /afresh/.test(r.fresh.reason) && r.freshTurn <= 1 && r.freshKeys === 0],
  ['a finished battle leaves no record', r.midKeys === 1 && r.doneMode === 'result' && r.doneKeys === 0],
];
session('resume (D11)', { width: 1280, height: 800 }, async (page) => {
  const r = await resumeCheck(page, BASE);
  for (const [name, cond] of RESUME_CHECKS(r)) ok(cond === true, 'D11 ' + name, JSON.stringify(r).slice(0, 400));
  ok(!page.errors.length, 'D11: no errors', page.errors.join('|').slice(0, 160));
});
session('resume (D11) negative control', { width: 1280, height: 800 }, async (page) => {
  // a copy of the page that never saves anything: after a reload it starts over, so the same check must FAIL
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bp-d11-'));
  const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
  mutateFile(d, 'js/battle_boot.js', 'resumeStore.attach(ctl);', '');
  const ov = await startOverlay({ dir: d, port: PORT + 11, upstream: `http://localhost:${PORT}` });
  try {
    const r = await resumeCheck(page, ov.url + '/pokemonarena/battle.html');
    const failed = RESUME_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
    ok(failed.some((n) => /RESUMED/.test(n)) && failed.some((n) => /SAME turn/.test(n)), 'D11 negative control: with the save removed the same check FAILS (' + failed.length + ' of ' + RESUME_CHECKS(r).length + ' fail)', JSON.stringify(r).slice(0, 300));
  } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
});

/* ================================================================================================== run */
const t0 = Date.now();
const started = await startServer();
console.log('pokemonarena battle page test; server', started ? 'started' : 'already running', 'on', PORT, '; screenshots ->', OUT);
try {
  for (const s of sessions) {
    if (process.env.ARENA_ONLY && !process.env.ARENA_ONLY.split(',').includes(s.name)) continue;
    console.log('-- session', s.name);
    try {
      await withBrowser({ port: cdp++, ...s.opts }, async (page) => { await addInit(page, AUDIO_DOUBLE); await s.fn(page); });         // every session: no real AudioContext can ever exist
    } catch (e) { ok(false, 'session ' + s.name + ' threw', String(e && e.stack ? e.stack : e).slice(0, 400)); }
  }
} finally { stopServer(); }
console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
