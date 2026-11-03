// tools/pokemonarena_fullscreen_test.mjs - the Arena fills the screen, and has a Fullscreen button (hub and battle page).
//
//   node tools/pokemonarena_fullscreen_test.mjs               Node units for the switch, then real Chrome on both pages at eight viewports
//   node tools/pokemonarena_fullscreen_test.mjs --units       the Node units only (and their mutants)
//   node tools/pokemonarena_fullscreen_test.mjs --mutants     ... and break screenfit.js / the stylesheets / the pages 18 + 10 ways: each must fail a named check
//   ARENA_PORT=8098 ARENA_CDP=9284 ARENA_OVERLAY_PORT=8118 ARENA_OUT=<dir for screenshots>
//   ARENA_ORIGIN=https://caseybement.com      run the browser part against a DEPLOYED site (no local server, no mutants)
//
// WHY THIS EXISTS. The picture used to be drawn at a whole number of device pixels per source pixel and no more (a floor), so a 390 px phone at 3x density was given a
// 324 px picture, a 360 px phone at 2x one of 244 px, with the bottom half of the screen empty; and there was no Fullscreen button, which every other game page here has
// (gba.html, n64, snes, ps1). What is pinned here: the picture runs edge to edge on a phone held upright, never gets smaller than the old rule gave it, fills the height in
// fullscreen on a phone held sideways, the Fullscreen switch works with the real API, without it (iPhone Safari has none), after a page load (a rematch is one) and when the
// browser itself leaves fullscreen (Esc), and nothing the player needs (touch buttons, the sound prompt, the exit button) is covered or pushed off screen.
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio). Nothing here touches the user's browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PORT = Number(process.env.ARENA_PORT || 8098), CDP0 = Number(process.env.ARENA_CDP || 9284), OVL = Number(process.env.ARENA_OVERLAY_PORT || 8118);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-fullscreen-test');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const UNITS_ONLY = args.includes('--units'), MUTANTS = args.includes('--mutants');
const ORIGIN = (process.env.ARENA_ORIGIN || '').replace(/\/$/, '');

let pass = 0, fail = 0;
const failures = [];
let sink = null;                                   // while a mutant runs, checks are collected here instead of counted
function ok(cond, name, detail) {
  if (sink) { if (!cond) sink.push(name); return; }
  if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); }
  else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 220) : '')); console.log('FAIL', name, detail ? ':: ' + String(detail).slice(0, 220) : ''); }
}
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

/* =============================================================================================== 1. the switch, in Node (a fake document) */
const SRC = path.join(root, 'pokemonarena', 'js', 'screenfit.js');
const tick = () => new Promise((r) => setTimeout(r, 5));
function bag() { const l = {}; return { addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] || []).filter((x) => x !== f); }, fire(t, e) { for (const f of [...(l[t] || [])]) f(e || {}); }, count: (t) => (l[t] || []).length }; }
function makeEnv({ api = 'std', store = 'ok', stored = false, requestThrows = false, requestRejects = false } = {}) {
  const log = { req: 0, exit: 0 };
  const doc = Object.assign(bag(), { body: { dataset: {} }, fullscreenElement: null, webkitFullscreenElement: null });
  const el = Object.assign(bag(), {});
  if (api === 'std') {
    el.requestFullscreen = () => { log.req++; if (requestThrows) throw new TypeError('not a function'); if (requestRejects) return Promise.reject(new Error('denied')); doc.fullscreenElement = el; return Promise.resolve(); };
    doc.exitFullscreen = () => { log.exit++; doc.fullscreenElement = null; return Promise.resolve(); };
  } else if (api === 'webkit') {
    el.webkitRequestFullscreen = () => { log.req++; doc.webkitFullscreenElement = el; };
    doc.webkitExitFullscreen = () => { log.exit++; doc.webkitFullscreenElement = null; };
  }
  doc.documentElement = el;
  const mem = {};
  const storage = store === 'none' ? null : {
    getItem: (k) => { if (store === 'throws') throw new Error('private mode'); return k in mem ? mem[k] : null; },
    setItem: (k, v) => { if (store === 'throws') throw new Error('private mode'); mem[k] = String(v); },
    removeItem: (k) => { if (store === 'throws') throw new Error('private mode'); delete mem[k]; },
  };
  if (stored && store === 'ok') mem['arena.fullscreen'] = '1';
  const mkBtn = () => Object.assign(bag(), { attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; }, contains(x) { return x === this; } });
  return { doc, win: bag(), el, storage, mem, log, btnA: mkBtn(), btnB: mkBtn() };
}
async function checkSwitch(mod) {
  const f = []; const t = (n, c) => { if (!c) f.push(n); };
  const make = (o) => { const e = makeEnv(o); const changes = []; const sw = mod.createFullscreen({ doc: e.doc, win: e.win, buttons: [e.btnA, e.btnB, null], onChange: (on) => changes.push(on), storage: e.storage }); return { e, sw, changes }; };
  { const { e, sw, changes } = make();
    t('U1 starts off: data-full 0, aria-pressed false, labelled Fullscreen, onChange(false) once', e.doc.body.dataset.full === '0' && e.btnA.attrs['aria-pressed'] === 'false' && e.btnA.attrs['aria-label'] === 'Fullscreen' && changes.length === 1 && changes[0] === false && sw.on() === false);
    e.btnA.fire('click');
    t('U2 a click enters: data-full 1, one request, both buttons pressed and labelled "Exit fullscreen", onChange(true), remembered', e.doc.body.dataset.full === '1' && e.log.req === 1 && e.btnA.attrs['aria-pressed'] === 'true' && e.btnB.attrs['aria-label'] === 'Exit fullscreen' && changes[changes.length - 1] === true && e.mem['arena.fullscreen'] === '1' && sw.on());
    e.doc.fire('fullscreenchange');
    t('U2b the browser reporting it changes nothing', e.doc.body.dataset.full === '1' && sw.on() && e.btnA.attrs['aria-pressed'] === 'true');
    e.btnB.fire('click');
    t('U2c the other button leaves: data-full 0, one exit, forgotten, onChange(false)', e.doc.body.dataset.full === '0' && e.log.exit === 1 && !('arena.fullscreen' in e.mem) && changes[changes.length - 1] === false && !sw.on() && e.btnA.attrs['aria-pressed'] === 'false');
    e.doc.fire('fullscreenchange');
    t('U2d the browser reporting the exit changes nothing either', e.doc.body.dataset.full === '0' && !sw.on()); }
  { const { e, sw } = make({ api: 'none' }); let threw = null; try { e.btnA.fire('click'); } catch (x) { threw = x; }
    t('U3 with no Fullscreen API a click still enters the full layout (no throw, no request, supported() false)', !threw && e.doc.body.dataset.full === '1' && e.log.req === 0 && sw.supported() === false && sw.on());
    e.btnA.fire('click'); t('U3b ... and leaves it', e.doc.body.dataset.full === '0' && !sw.on()); }
  { const { e } = make({ requestThrows: true }); let threw = null; try { e.btnA.fire('click'); } catch (x) { threw = x; }
    t('U4 a request that throws (iPhone Safari) leaves the full layout on and raises nothing', !threw && e.doc.body.dataset.full === '1'); }
  { const before = unhandled; const { e } = make({ requestRejects: true }); e.btnA.fire('click'); await tick(); await tick();
    t('U4b a refused request (a rejected promise) leaves the full layout on and raises nothing', e.doc.body.dataset.full === '1' && unhandled === before); }
  { const { e, sw, changes } = make(); e.btnA.fire('click'); e.doc.fire('fullscreenchange');
    e.doc.fullscreenElement = null; e.doc.fire('fullscreenchange');
    t('U5 Esc (the browser leaves fullscreen by itself): the page follows - data-full 0, forgotten, onChange(false)', e.doc.body.dataset.full === '0' && !('arena.fullscreen' in e.mem) && !sw.on() && changes[changes.length - 1] === false && e.btnA.attrs['aria-pressed'] === 'false');
    e.btnA.fire('click'); t('U5b ... and the next press enters again', sw.on() && e.log.req === 2); }
  { const { e, sw } = make(); e.btnA.fire('click'); e.doc.fire('fullscreenchange'); e.win.fire('pagehide'); e.doc.fullscreenElement = null; e.doc.fire('fullscreenchange');
    t('U6 the browser leaving fullscreen while the page unloads does not forget it (a rematch is a page load)', e.mem['arena.fullscreen'] === '1' && sw.on() && e.doc.body.dataset.full === '1'); }
  { const { e, sw } = make({ stored: true });
    t('U7 restored from storage: data-full 1 at once, no request yet (it needs a gesture), listening for one', e.doc.body.dataset.full === '1' && e.log.req === 0 && sw.on() && e.win.count('pointerup') === 1 && e.win.count('keydown') === 1 && e.btnA.attrs['aria-pressed'] === 'true');
    e.win.fire('pointerup', { target: {} });
    t('U7b the first gesture asks for real fullscreen, once, and stops listening', e.log.req === 1 && e.win.count('pointerup') === 0 && e.win.count('keydown') === 0);
    e.win.fire('pointerup', { target: {} }); t('U7c ... a second gesture asks for nothing', e.log.req === 1); }
  { const { e, sw } = make({ stored: true });
    e.win.fire('keydown', { target: {} });
    t('U7d a key press is a gesture too', e.log.req === 1); }
  { const { e, sw } = make({ stored: true });
    e.win.fire('pointerup', { target: e.btnA });
    t('U8 a tap on the switch itself is not the "first gesture" (it is about to leave)', e.log.req === 0 && e.win.count('pointerup') === 1);
    e.btnA.fire('click');
    t('U8b ... so pressing it leaves, with no request, no listener left and nothing remembered', e.log.req === 0 && !sw.on() && e.win.count('pointerup') === 0 && !('arena.fullscreen' in e.mem)); }
  { const { e } = make({ stored: true, api: 'none' }); t('U9 restored with no API: the layout is on, and nothing waits for a gesture', e.doc.body.dataset.full === '1' && e.win.count('pointerup') === 0); }
  { const { e, sw } = make({ store: 'throws' }); let threw = null; try { e.btnA.fire('click'); e.btnA.fire('click'); } catch (x) { threw = x; }
    t('U10 storage that throws (private mode) does not break the switch', !threw && !sw.on() && e.log.req === 1 && e.log.exit === 1); }
  { const { e, sw } = make({ store: 'none' }); e.btnA.fire('click'); t('U10b no storage at all: still works', sw.on() && e.doc.body.dataset.full === '1'); }
  { const { e, sw } = make({ api: 'webkit' }); e.btnA.fire('click');
    t('U11 a webkit-prefixed API is used', e.log.req === 1 && sw.supported());
    e.doc.fire('webkitfullscreenchange'); e.btnA.fire('click'); t('U11b ... and left with the prefixed exit', e.log.exit === 1 && !sw.on()); }
  { const { e, sw } = make({ stored: true }); sw.dispose();
    t('U12 dispose removes every listener', e.doc.count('fullscreenchange') === 0 && e.doc.count('webkitfullscreenchange') === 0 && e.win.count('pagehide') === 0 && e.win.count('pageshow') === 0 && e.win.count('pointerup') === 0 && e.win.count('keydown') === 0 && e.btnA.count('click') === 0 && e.btnB.count('click') === 0); }
  return f;
}
const SWITCH_MUTANTS = [
  ['enter() never asks the browser', "paint(); if (!real()) request(); }", 'paint(); }'],
  ['the layout flag is never set', "doc.body.dataset.full = wanted ? '1' : '0';", "doc.body.dataset.full = '0';"],
  ['leave() never asks the browser to exit', 'disarm(); if (real()) exit(); paint(); }', 'disarm(); paint(); }'],
  ['leave() does not forget', 'enteredReal = false; remember(false); disarm();', 'enteredReal = false; disarm();'],
  ['Esc is ignored (the page stays "full" after the browser left)', 'else if (enteredReal && !unloading) {', 'else if (false) {'],
  ['the unloading guard is gone (a rematch forgets fullscreen)', 'else if (enteredReal && !unloading) {', 'else if (enteredReal) {'],
  ['entering by the browser is never noticed', 'if (real()) enteredReal = true;', ''],
  ['a tap on the switch counts as the first gesture', 'if (e && e.target && list.some((b) => b.contains && b.contains(e.target))) return;', ''],
  ['nothing is restored from storage', 'if (was) { wanted = true; paint(); arm(); } else paint();', 'paint();'],
  ['a throwing request is not caught', 'catch (_e) { return false; }', 'catch (_e) { throw _e; }'],
  ['a refused request is not handled', "r.catch(() => { /* refused: the full layout stays */ })", 'r.then(() => {})'],
  ['supported() always says yes', 'supported: () => !!reqFn(),', 'supported: () => true,'],
  ['it waits for a gesture even with no API', 'if (!reqFn() || armed) return;', 'if (armed) return;'],
  ['dispose leaves the click handlers', "b.removeEventListener('click', toggle)", 'void 0'],
  ['aria-pressed is never updated', "b.setAttribute('aria-pressed', wanted ? 'true' : 'false'); ", ''],
  ['the webkit-prefixed API is ignored', 'el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen', 'el.requestFullscreen'],
  ['pagehide is not watched', "win.addEventListener('pagehide', onHide); ", ''],
  ['onChange is never called', "if (typeof onChange === 'function') onChange(wanted);", ''],
];
async function importFile(file) { return import(pathToFileURL(file).href + '?v=' + Date.now() + Math.random().toString(36).slice(2)); }
async function groupUnits() {
  const real = await importFile(SRC);
  const f = await checkSwitch(real);
  ok(f.length === 0, 'U. createFullscreen passes every unit check', f.slice(0, 4).join('; '));
  ok((await checkSwitch(real)).length === 0, 'U. unmutated twin stays quiet');
  ok(real.SNAP === 0.94 && real.FULL_KEY === 'arena.fullscreen' && typeof real.fitPicture === 'function', 'U. screenfit.js exports what the pages import');
  if (!MUTANTS) return;
  const src = fs.readFileSync(SRC, 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fs-mut-'));
  for (const [name, from, to] of SWITCH_MUTANTS) {
    const n = src.split(from).length - 1;
    if (n !== 1) { ok(false, 'M. mutant "' + name + '" is applicable', 'target found ' + n + 'x'); continue; }
    const file = path.join(tmp, 'm.mjs'); fs.writeFileSync(file, src.replace(from, to));
    const r = await checkSwitch(await importFile(file));
    ok(r.length > 0, 'M. mutant "' + name + '" is caught', r.length ? r[0] : 'NOT CAUGHT');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

/* =============================================================================================== 2. real Chrome, both pages, eight viewports */
let server = null;
async function startServer(port) {
  const probe = async () => { try { return (await fetch(`http://localhost:${port}/pokemonarena/battle.html`)).ok; } catch (_e) { return false; } };
  if (await probe()) return null;
  const s = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !(await probe()); i++) await sleep(250);
  return s;
}
const PAGES = {
  hub: { path: '/pokemonarena/', hook: 'window.__arenaHub', canvas: 'hub', floorDesk: 720, floorLand844: 400 },
  battle: { path: '/pokemonarena/battle.html?seed=5&format=3v3', hook: 'window.__arenaBattle', canvas: 'battle', floorDesk: 800, floorLand844: 460 },
};
const VPS = [
  { n: 'phone390x844', w: 390, h: 844, dpr: 3, mobile: true, deep: true, roomy: true },
  { n: 'phone412x915', w: 412, h: 915, dpr: 2.625, mobile: true, roomy: true },
  { n: 'phone360x640', w: 360, h: 640, dpr: 2, mobile: true },
  { n: 'phone320x568', w: 320, h: 568, dpr: 2, mobile: true },
  { n: 'land844x390', w: 844, h: 390, dpr: 3, mobile: true, deep: true, roomy: true },
  { n: 'land568x320', w: 568, h: 320, dpr: 2, mobile: true },
  { n: 'desk1280x800', w: 1280, h: 800, dpr: 1, mobile: false, deep: true },
  { n: 'desk1920x1080', w: 1920, h: 1080, dpr: 1, mobile: false },
];
const snapJs = (spec) => `(() => { const b = document.body, c = document.getElementById('${spec.canvas}'), r = c.getBoundingClientRect();
  const q = (sel) => { const e = document.querySelector(sel); if (!e) return null; const x = e.getBoundingClientRect(), cs = getComputedStyle(e); return { l: x.left, t: x.top, r: x.right, b: x.bottom, w: x.width, h: x.height, shown: x.width > 0 && x.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden', pressed: e.getAttribute('aria-pressed'), label: e.getAttribute('aria-label') }; };
  return { full: b.dataset.full, edge: b.dataset.edge, layout: b.dataset.layout, pad: b.dataset.pad, fsEl: document.fullscreenElement ? document.fullscreenElement.tagName : null, ss: (() => { try { return sessionStorage.getItem('arena.fullscreen'); } catch (_e) { return 'x'; } })(),
    vw: document.documentElement.clientWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, cw: r.width, ch: r.height, cl: r.left, ct: r.top, cr: r.right, cb: r.bottom, border: parseFloat(getComputedStyle(c).borderLeftWidth), k: ${spec.hook}.scale && ${spec.hook}.scale.k,
    wrap: q('#screenWrap'), top: q('#top'), fullBtn: q('#fullBtn'), fullExit: q('#fullExit'), prompt: q('.arena-sndprompt'), promptHidden: (() => { const p = document.querySelector('.arena-sndprompt'); return !p || p.hidden; })(), promptCrammed: (() => { const p = document.querySelector('.arena-sndprompt'); return !!p && p.hasAttribute('data-overlap'); })(),
    pads: [...document.querySelectorAll('#dpad .pbtn, #ab .pbtn')].map((e) => { const x = e.getBoundingClientRect(); return { id: e.id, l: x.left, t: x.top, r: x.right, b: x.bottom, w: x.width, h: x.height }; }) }; })()`;
const hit = (a, b, pad = 0) => a && b && a.l < b.r - pad && a.r > b.l + pad && a.t < b.b - pad && a.b > b.t + pad;
const asBox = (s) => ({ l: s.cl, t: s.ct, r: s.cr, b: s.cb });
async function open(page, base, spec) {
  await page.navigate(base + spec.path);
  await page.waitFor(`${spec.hook} && (${spec.hook}.state === "ready" || ${spec.hook}.state === "error")`, { timeoutMs: 90000 });
  const st = await page.eval(`${spec.hook}.state`);
  await sleep(450);
  return st;
}
async function press(page, vp, id) {
  const r = await page.eval(`(() => { const x = document.getElementById('${id}').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; })()`);
  if (vp.mobile) await page.tap(r.x, r.y); else await page.click(r.x, r.y);
}
const safePoint = (page) => page.eval(`(() => { for (let y = innerHeight - 6; y > 4; y -= 17) for (let x = 6; x < innerWidth - 4; x += 19) { const e = document.elementFromPoint(x, y); if (e && (e.tagName === 'BODY' || e.tagName === 'HTML' || e.tagName === 'MAIN')) return { x, y }; } return { x: 2, y: 2 }; })()`);
const kill = (page) => page.eval(`(() => { for (const n of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) Object.defineProperty(document.documentElement, n, { value: undefined, configurable: true }); return true; })()`);

// ONE viewport of ONE page. `base` is the server (the real one, or a mutated overlay); `deepChecks` adds the reload / no-API / Esc cases.
async function runViewport(page, base, name, spec, vp, { deepChecks = true, shots = false } = {}) {
  const tag = name + ' ' + vp.n + ': ';
  await page.setViewport(vp.w, vp.h, { mobile: vp.mobile, dpr: vp.dpr });
  const st = await open(page, base, spec);
  ok(st === 'ready', tag + 'the page reaches ready', st);
  if (st !== 'ready') return;
  const portraitPad = vp.mobile && vp.w < vp.h, landPad = vp.mobile && vp.w > vp.h;
  await sleep(700);                                                         // the sound prompt is placed on a 500 ms timer; any tap or key starts the sound and removes it, so it is looked at BEFORE the first one
  const S0 = await page.eval(snapJs(spec));
  const inner = (S) => S.cw - 2 * S.border;                                  // the picture without its frame (a desktop has a 2 px one; a touch screen and fullscreen have none)
  // ---- the sound prompt covers nothing the player needs
  // A page too full to have a free spot says so (data-overlap) and the pill then goes over its cheapest line; on a roomy screen there is always a free spot. Either way it never covers the picture (and it ignores the pointer).
  if (vp.mobile && !S0.promptHidden && S0.prompt) {
    const onPad = S0.pads.filter((p) => p.w > 0).some((p) => hit(p, S0.prompt, 0.5));
    ok(!hit(S0.prompt, asBox(S0), 0.5) && S0.prompt.l >= -0.5 && S0.prompt.r <= S0.vw + 0.5, tag + 'the "start the sound" prompt never covers the picture and lies inside the screen', JSON.stringify([S0.prompt, asBox(S0)]));
    if (vp.roomy) ok(!onPad && !S0.promptCrammed, tag + 'there is room, so the prompt covers nothing: not the picture, not a touch button', JSON.stringify([S0.prompt, S0.promptCrammed]));
    else ok(!onPad || S0.promptCrammed, tag + 'a crammed page reports it (data-overlap) when the prompt has to cover a touch button', JSON.stringify([S0.prompt, S0.promptCrammed]));
  }
  if (vp.n === 'phone390x844') ok(!S0.promptHidden && !!S0.prompt, tag + 'the "start the sound" prompt is showing (so the check above is not vacuous)', String(S0.promptHidden));
  if (shots) await page.screenshot(path.join(OUT, `${name}_${vp.n}_0_normal.png`));
  // ---- it fills the screen
  ok(S0.sw <= S0.vw, tag + 'no horizontal scroll', `${S0.sw} > ${S0.vw}`);
  ok(Math.abs(S0.cw / S0.ch - 1.5) < 0.01, tag + 'the picture is 3:2', `${S0.cw}x${S0.ch}`);
  if (portraitPad) ok(S0.edge === '1' && S0.border === 0 && Math.abs(S0.cw - S0.vw) < 0.5 && S0.cl === 0, tag + 'held upright the picture runs edge to edge (' + S0.cw.toFixed(1) + ' of ' + S0.vw + ' css px, no frame)', JSON.stringify([S0.edge, S0.border, S0.cl]));
  if (portraitPad) ok(S0.wrap && Math.abs(S0.wrap.l) < 0.5 && Math.abs(S0.wrap.w - S0.vw) < 0.5, tag + 'the screen box itself spans the viewport (its margins reach over the page gutters), so the loading / error panels inside it are sized from the real width', JSON.stringify(S0.wrap));
  if (vp.n === 'land844x390') ok(S0.cw >= spec.floorLand844, tag + 'held sideways the picture is not smaller than the old whole-scale rule gave it (' + S0.cw.toFixed(0) + ' >= ' + spec.floorLand844 + ')', String(S0.cw));
  if (vp.n === 'desk1280x800') ok(S0.cw >= spec.floorDesk, tag + 'on a desktop it is not smaller than the old whole-scale rule gave it (' + S0.cw.toFixed(0) + ' >= ' + spec.floorDesk + ')', String(S0.cw));
  const pads0 = S0.pads.filter((p) => p.w > 0);
  ok(S0.pad === (vp.mobile ? 'on' : 'off'), tag + 'touch pad ' + (vp.mobile ? 'shown' : 'hidden'), S0.pad);
  if (vp.mobile) {
    ok(pads0.length >= 6 && pads0.every((p) => p.l >= -0.5 && p.r <= S0.vw + 0.5 && p.t >= -0.5 && p.b <= S0.vh + 0.5 && p.w >= 43.5 && p.h >= 43.5), tag + 'every touch button is on screen and >= 44 px', JSON.stringify(pads0.filter((p) => p.l < -0.5 || p.r > S0.vw + 0.5 || p.b > S0.vh + 0.5 || p.w < 43.5)));
    ok(!pads0.some((p) => hit(p, asBox(S0), 0.5)), tag + 'no touch button covers the picture', '');
  }
  // ---- the Fullscreen button
  const fb = S0.fullBtn;
  ok(fb && fb.shown && fb.w >= 43.5 && fb.h >= 43.5 && fb.l >= -0.5 && fb.r <= S0.vw + 0.5 && fb.t >= -0.5 && fb.b <= S0.vh + 0.5 && fb.label === 'Fullscreen' && fb.pressed === 'false', tag + 'the Fullscreen button is in the header, on screen, >= 44 px, labelled and not pressed', JSON.stringify(fb));
  ok(S0.full === '0' && S0.fsEl === null && S0.ss === null && S0.fullExit && !S0.fullExit.shown, tag + 'it starts out of fullscreen (flag 0, no fullscreen element, nothing remembered, no floating exit button)', JSON.stringify([S0.full, S0.fsEl, S0.ss, S0.fullExit && S0.fullExit.shown]));
  await press(page, vp, 'fullBtn'); await sleep(800);
  const S1 = await page.eval(snapJs(spec));
  if (shots) await page.screenshot(path.join(OUT, `${name}_${vp.n}_1_fullscreen.png`));
  ok(S1.full === '1' && S1.fsEl === 'HTML' && S1.ss === '1', tag + 'tapping it enters fullscreen: the page flag, the browser\'s own fullscreen element (the whole document, so the pads and dialogs paint), remembered for the next page', JSON.stringify([S1.full, S1.fsEl, S1.ss]));
  ok(S1.sw <= S1.vw, tag + 'fullscreen: no horizontal scroll', `${S1.sw} > ${S1.vw}`);
  ok(inner(S1) >= inner(S0) - 0.5, tag + 'fullscreen: the picture is not smaller (' + inner(S1).toFixed(1) + ' >= ' + inner(S0).toFixed(1) + ')', '');
  const pads1 = S1.pads.filter((p) => p.w > 0);
  if (vp.mobile) ok(pads1.length >= 6 && pads1.every((p) => p.l >= -0.5 && p.r <= S1.vw + 0.5 && p.t >= -0.5 && p.b <= S1.vh + 0.5 && p.w >= 43.5 && p.h >= 43.5) && !pads1.some((p) => hit(p, asBox(S1), 0.5)), tag + 'fullscreen: every touch button is still on screen, >= 44 px, and covers nothing', JSON.stringify(pads1.filter((p) => p.l < -0.5 || p.r > S1.vw + 0.5 || p.b > S1.vh + 0.5 || p.w < 43.5)));
  let leaveId = 'fullBtn';
  if (landPad) {
    leaveId = 'fullExit';
    ok(S1.top && !S1.top.shown, tag + 'fullscreen held sideways: the header is gone', JSON.stringify(S1.top));
    ok(S1.ch >= S0.ch * 1.05, tag + 'fullscreen held sideways: the picture is at least 5 % taller (' + S1.ch.toFixed(0) + ' vs ' + S0.ch.toFixed(0) + ')', '');
    const fe = S1.fullExit;
    ok(fe && fe.shown && fe.w >= 43.5 && fe.h >= 43.5 && fe.l >= -0.5 && fe.t >= -0.5 && fe.r <= S1.vw + 0.5 && fe.b <= S1.vh + 0.5 && fe.pressed === 'true' && fe.label === 'Exit fullscreen', tag + 'fullscreen held sideways: the floating Exit button is on screen, >= 44 px, labelled', JSON.stringify(fe));
    ok(fe && !hit(fe, asBox(S1), 0.5) && !pads1.some((p) => hit(p, fe, 0.5)), tag + 'fullscreen held sideways: the Exit button covers neither the picture nor a touch button', JSON.stringify(fe));
  } else {
    ok(S1.top && S1.top.shown && S1.fullBtn && S1.fullBtn.shown && S1.fullBtn.pressed === 'true' && S1.fullBtn.label === 'Exit fullscreen', tag + 'fullscreen: the header stays and its button now reads "Exit fullscreen"', JSON.stringify([S1.top && S1.top.shown, S1.fullBtn]));
    ok(S1.fullExit && !S1.fullExit.shown, tag + 'fullscreen: the floating Exit button is not needed and stays hidden', '');
  }
  if (portraitPad) ok(S1.edge === '1' && Math.abs(S1.cw - S1.vw) < 0.5, tag + 'fullscreen upright: still edge to edge', JSON.stringify([S1.edge, S1.cw, S1.vw]));
  // ---- leaving
  await press(page, vp, leaveId); await sleep(800);
  const S2 = await page.eval(snapJs(spec));
  ok(S2.full === '0' && S2.fsEl === null && S2.ss === null && Math.abs(inner(S2) - inner(S0)) < 0.5 && S2.top.shown && S2.fullBtn.pressed === 'false', tag + 'the ' + (leaveId === 'fullExit' ? 'floating Exit' : 'header') + ' button leaves: flag 0, no fullscreen element, forgotten, the picture and header are back as they were', JSON.stringify([S2.full, S2.fsEl, S2.ss, inner(S2), inner(S0)]));
  ok(S2.fullExit && !S2.fullExit.shown, tag + 'leaving hides the floating Exit button', '');
  if (!deepChecks || !vp.deep) { ok(!page.errors.length, tag + 'no console or page errors', page.errors.join(' | ').slice(0, 200)); return; }
  // ---- the browser leaves fullscreen by itself (Esc / the system gesture)
  await press(page, vp, 'fullBtn'); await sleep(700);
  ok((await page.eval(snapJs(spec))).fsEl === 'HTML', tag + 'entered again', '');
  await page.eval('document.exitFullscreen()'); await sleep(700);
  const S3 = await page.eval(snapJs(spec));
  ok(S3.full === '0' && S3.fsEl === null && S3.ss === null && Math.abs(inner(S3) - inner(S0)) < 0.5, tag + 'when the browser itself leaves fullscreen (Esc) the page follows and forgets', JSON.stringify([S3.full, S3.fsEl, S3.ss, inner(S3), inner(S0)]));
  // ---- a page load in fullscreen (a rematch is one): the layout comes straight back, the next gesture asks the browser again
  await press(page, vp, 'fullBtn'); await sleep(700);
  const st2 = await open(page, base, spec);
  const S4 = await page.eval(snapJs(spec));
  ok(st2 === 'ready' && S4.full === '1' && S4.fsEl === null && S4.ss === '1', tag + 'a page load while fullscreen comes back in the full layout (no browser fullscreen yet: that needs a gesture)', JSON.stringify([st2, S4.full, S4.fsEl, S4.ss]));
  if (landPad) ok(S4.top && !S4.top.shown && S4.fullExit && S4.fullExit.shown, tag + '... with the header hidden and the floating Exit button showing', JSON.stringify([S4.top, S4.fullExit]));
  { const sp = await safePoint(page); if (vp.mobile) await page.tap(sp.x, sp.y); else await page.click(sp.x, sp.y); await sleep(800); }       // a tap on empty page (a tap on the picture would choose a menu row and leave the page)
  const S5 = await page.eval(snapJs(spec));
  ok(S5.full === '1' && S5.fsEl === 'HTML', tag + '... and the first tap puts the browser back into fullscreen', JSON.stringify([S5.full, S5.fsEl]));
  await press(page, vp, leaveId); await sleep(700);
  const st3 = await open(page, base, spec);
  const S6 = await page.eval(snapJs(spec));
  ok(st3 === 'ready' && S6.full === '0' && S6.fsEl === null && S6.ss === null && S6.top.shown, tag + 'having left, the next page load is a normal one', JSON.stringify([S6.full, S6.fsEl, S6.ss]));
  // ---- no Fullscreen API at all (iPhone Safari): the full layout is what there is, and it still fills the screen
  await kill(page);
  const apiOff = await page.eval(`${spec.hook}.fullscreen.supported()`);
  await press(page, vp, 'fullBtn'); await sleep(600);
  const S7 = await page.eval(snapJs(spec));
  ok(apiOff === false && S7.full === '1' && S7.fsEl === null, tag + 'with no Fullscreen API the button still switches to the full layout (no browser fullscreen, no error)', JSON.stringify([apiOff, S7.full, S7.fsEl]));
  if (landPad) ok(S7.top && !S7.top.shown && S7.ch >= S0.ch * 1.05 && S7.fullExit && S7.fullExit.shown, tag + '... and held sideways that layout is the bigger picture with the Exit button', JSON.stringify([S7.ch, S0.ch, S7.fullExit && S7.fullExit.shown]));
  await press(page, vp, landPad ? 'fullExit' : 'fullBtn'); await sleep(500);
  const S8 = await page.eval(snapJs(spec));
  ok(S8.full === '0' && Math.abs(inner(S8) - inner(S0)) < 0.5, tag + '... and the same button leaves it', JSON.stringify([S8.full, inner(S8), inner(S0)]));
  ok(!page.errors.length, tag + 'no console or page errors in any of it', page.errors.join(' | ').slice(0, 200));
}

async function groupBrowser(base, which, { vps = VPS, deepChecks = true, shots = SHOTS } = {}) {
  for (const [name, spec] of Object.entries(PAGES)) {
    if (which && which !== name) continue;
    for (const vp of vps) {
      try { await withBrowser({ port: CDP0, width: vp.w, height: vp.h, mobile: vp.mobile }, async (page) => { await runViewport(page, base, name, spec, vp, { deepChecks, shots }); }); }
      catch (e) { ok(false, name + ' ' + vp.n + ': the session ran to its end', e && e.message ? e.message : String(e)); }
    }
  }
}
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';

/* =============================================================================================== 3. mutants of the page code and the stylesheets */
const PAGE_MUTANTS = [
  { id: 'the old rule: a whole scale only', file: 'js/screenfit.js', from: 'if (whole / exact >= SNAP) return', to: 'if (true) return', only: 'battle', vps: ['phone390x844'] },
  { id: 'edge-to-edge CSS removed (the picture keeps its gutters)', file: 'battle.css', from: 'body[data-edge="1"] #screenWrap { margin-inline: calc(var(--gutter) * -1); width: calc(100% + var(--gutter) * 2); max-width: none; }', to: '', only: 'battle', vps: ['phone390x844'] },
  { id: 'the frame stays on a phone', file: 'battle.css', from: 'body[data-pad="on"] canvas#battle, body[data-edge="1"] canvas#battle, body[data-full="1"] canvas#battle { border-width: 0; border-radius: 0; }', to: '', only: 'battle', vps: ['phone390x844'] },
  { id: 'the header stays when fullscreen is held sideways', file: 'battle.css', from: 'body[data-full="1"][data-layout="landscape"] #top { display: none; }', to: '', only: 'battle', vps: ['land844x390'] },
  { id: 'the floating Exit button never shows', file: 'battle.css', from: 'body[data-full="1"][data-layout="landscape"] #fullExit { display: inline-flex; }', to: '', only: 'battle', vps: ['land844x390'] },
  { id: 'the floating Exit button is not wired', file: 'js/battle_boot.js', from: "buttons: [$('fullBtn'), $('fullExit')]", to: "buttons: [$('fullBtn')]", only: 'battle', vps: ['land844x390'] },
  { id: 'the picture ignores the room the touch pads take (it overlaps them held sideways)', file: 'js/screenfit.js', from: '(padA ? padA.offsetWidth : 0) + (padB ? padB.offsetWidth : 0) + 2 * grid + 4', to: '0', only: 'battle', vps: ['land568x320'] },
  { id: 'the sound prompt is not placed under the picture', file: 'js/sound_system.js', from: 'if (cr) cands.push([(vw - pw) / 2, cr.bottom + G]);', to: '', only: 'hub', vps: ['phone390x844'] },
  { id: 'the hub: edge-to-edge CSS removed', file: 'arena.css', from: 'body[data-edge="1"] #screenWrap { margin-inline: calc(var(--gutter) * -1); width: calc(100% + var(--gutter) * 2); max-width: none; }', to: '', only: 'hub', vps: ['phone390x844'] },
  { id: 'the hub: the button is not wired', file: 'js/boot.js', from: "buttons: [$('fullBtn'), $('fullExit')]", to: 'buttons: []', only: 'hub', vps: ['phone390x844'] },
];
async function groupMutants() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fs-pages-'));
  const upstream = `http://127.0.0.1:${PORT}`;
  for (const m of PAGE_MUTANTS) {
    const dir = path.join(tmp, 'm'); fs.rmSync(dir, { recursive: true, force: true });
    copyTree(path.join(root, 'pokemonarena'), dir);
    try { mutateFile(dir, m.file, m.from, m.to); } catch (e) { ok(false, 'M. mutant "' + m.id + '" is applicable', e.message); continue; }
    const ov = await startOverlay({ dir, port: OVL, upstream });
    const fails = [];
    const prev = sink; sink = fails;
    try { await groupBrowser(ov.url, m.only, { vps: VPS.filter((v) => m.vps.includes(v.n)), deepChecks: false, shots: false }); } catch (e) { fails.push('crashed: ' + e.message); } finally { sink = prev; ov.stop(); }
    ok(fails.length > 0, 'M. mutant "' + m.id + '" is caught', fails.length ? fails[0] : 'NOT CAUGHT');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

/* =============================================================================================== main */
const t0 = Date.now();
try {
  await groupUnits();
  if (!UNITS_ONLY) {
    if (!ORIGIN) server = await startServer(PORT);
    const only = args.filter((a) => !a.startsWith('-'));
    await groupBrowser(ORIGIN || `http://localhost:${PORT}`, only[0] || null);
    if (MUTANTS && !ORIGIN) await groupMutants();
  }
} catch (e) { fail++; failures.push('crashed :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
finally { if (server) { try { server.kill(); } catch (_e) { /* ignore */ } } }
console.log(`\nfullscreen: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)  screenshots: ${OUT}`);
if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
