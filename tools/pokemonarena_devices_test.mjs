#!/usr/bin/env node
// tools/pokemonarena_devices_test.mjs -- THE SAME PLAYER JOURNEYS, ONE INPUT DEVICE AT A TIME  (stage W1)
//
//   node tools/pokemonarena_devices_test.mjs                       # keyboard, mouse, gamepad, touch: every journey, then the switching battle, then the mutants
//   ARENA_FAMILIES=keyboard,touch  ARENA_JOURNEYS=A,B,C,D,S,V  ARENA_SKIP_MUTANTS=1
//   ARENA_PORT=8101 ARENA_CDP=9331 ARENA_OUT=<dir for screenshots>
//
// The user's rule: every screen must be fully usable with a MOUSE, a KEYBOARD, a CONTROLLER and TOUCH, each on its own. So each family gets its own fresh
// headless Chrome (throwaway profile, muted, AudioContext a test double) and plays the same journeys with ONLY its own real events through CDP:
//   keyboard   Input.dispatchKeyEvent only (Tab / Shift+Tab / Enter / Space / arrows / typed text). No pointer event reaches the page.
//   mouse      Input.dispatchMouseEvent only (move, click, right-click, wheel). No key, no touch.
//   gamepad    a SYNTHETIC navigator.getGamepads() (no physical controller exists here). No key, no pointer, no touch.
//   touch      Input.dispatchTouchEvent / synthesizeScrollGesture in a 390x844 @3x mobile viewport, text through Input.insertText (the soft keyboard).
// A page-side counter (sessionStorage.__evc) records every keydown / mouse pointer / touch pointer; each family asserts that the OTHER families' counters are 0,
// so "keyboard only" is a measurement, not a claim.
//
// JOURNEYS (every step asserts engine / DOM / store state, never just "no error")
//   A  Quick Battle 6v6 from the hub: FORMAT, START, FIGHT + move, a voluntary switch (POKeMON), the pause menu -> CONTROLS -> back, RUN -> NO -> RUN -> YES
//      (the forfeit confirm), the result screen, BACK TO HUB
//   B  the team editor: a profile, a three-Pokemon team (species, nature, ability, item, four moves, EVs, an IV preset), saved, RELOADED, compared, then a
//      3v3 battle with it: team preview, turns, the pause menu FORFEIT -> NO -> FORFEIT -> YES, result
//   C  IMPORT SAVE: the hub's IMPORT SAVE row, a generated SoulGold save, the list (legal / needs fixing), the import, and a battle with an imported Pokemon
//   D  the Controls panel: open it from the hub, change something, see it take effect (keyboard / gamepad: a rebinding; mouse / touch: the layout switch,
//      a cancelled capture and Reset: rebinding needs the very key or button being bound)
//   S  ONE battle across all four devices: keyboard picks the team, the mouse fights, the controller opens Controls and back, touch forfeits
//   V  the SOUND panel (MU3): the hub's SOUND row, the Music slider, Mute twice, the Test cry, the soundtrack choice, close, persistence across a reload, the header
//      Sound button; plus (journey A's pause menu tour) the battle pause menu's SOUND row. A controller alone must end with NO AudioContext at all.
// WHAT IS SYNTHETIC OR APPROXIMATED (also in the final report): the controller; the native file chooser and native <select> popups cannot be driven in headless
// Chrome (a file is handed to the file input with DOM.setFileInputFiles after the device has activated it; mouse / touch set a <select> by script after
// focusing it); a mouse has no keyboard here, so mouse journeys type nothing (profile TRAINER, team default name, species found by scrolling the list).
//
// MUTANTS (browser): remove a bindPad call, break the canvas hit test by one pixel, drop the editor's navigation layer, re-add a demo string. Each must fail
// its NAMED check while the unmutated twin stays quiet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const { root, ROM_PATH, BASE, sleep, mod, J, errsOf, AUDIO_DOUBLE, PAD_DOUBLE, addInit, logicalToPage, moveMouse, rightClick, wheel } = L;
const ARGS = new Set(process.argv.slice(2));
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-devices-shots');
const FAMILIES = (process.env.ARENA_FAMILIES || 'keyboard,mouse,gamepad,touch').split(',').filter((x) => ['keyboard', 'mouse', 'gamepad', 'touch'].includes(x));   // ARENA_FAMILIES=none ARENA_JOURNEYS=none runs only the mutants
const JOURNEYS = (process.env.ARENA_JOURNEYS || 'A,B,C,D,S,V').split(',').filter(Boolean);
const C = L.makeCounter('devices');
const ok = C.ok;
const BASE_URL = process.env.ARENA_TEST_BASE || BASE;      // the mutant runs point this at an overlay server

const TB = await mod('tables.js');
const RU = await mod('rules.js');
const TC = await mod('teamcode.js');
const ST = await mod('stats.js');
const rom = L.readRom();
const pack = TB.loadPack(rom, { verify: 'header', dexText: false });
const canon = ST.canonicalJSON;
const HUB = '__arenaHub', BAT = '__arenaBattle';

/* ================================================================================================ counters + doubles */
const EVC = `(() => {
  const g = () => { try { return JSON.parse(sessionStorage.getItem('__evc') || '{}'); } catch (e) { return {}; } };
  const bump = (k) => { try { const c = g(); c[k] = (c[k] || 0) + 1; sessionStorage.setItem('__evc', JSON.stringify(c)); } catch (e) {} };
  addEventListener('keydown', () => bump('key'), true);
  addEventListener('pointerdown', (e) => bump(e.pointerType === 'touch' ? 'touch' : e.pointerType === 'mouse' ? 'mouse' : 'pen'), true);
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') bump('mousemove'); }, true);
  addEventListener('wheel', () => bump('wheel'), true);
  window.__evc = g;
})();`;
const evc = (page) => page.eval(`(() => { try { return JSON.parse(sessionStorage.getItem('__evc') || '{}'); } catch (e) { return {}; } })()`);

/* ================================================================================================ the four devices */
const KEY = { up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], a: ['Enter', 'Enter', 13], b: ['Backspace', 'Backspace', 8], start: ['p', 'KeyP', 80], x: ['c', 'KeyC', 67], l: ['q', 'KeyQ', 81], r: ['e', 'KeyE', 69], esc: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9], space: [' ', 'Space', 32] };
const PADIDX = { up: 12, down: 13, left: 14, right: 15, a: 0, b: 1, x: 2, y: 3, l: 4, r: 5, start: 9, select: 8 };
const CELL_DIR = (cur, to) => ((cur & 1) !== (to & 1) ? (to & 1 ? 'right' : 'left') : (cur >> 1) !== (to >> 1) ? (to >> 1 ? 'down' : 'up') : null);
const LIST_DIR = (cur, to) => (to > cur ? 'down' : 'up');
const ROW_DIR = (cur, to) => (to > cur ? 'right' : 'left');

class Dev {
  constructor(family, page, vp) { this.family = family; this.page = page; this.vp = vp; this.touch = family === 'touch'; this.shots = 0; this.log = []; }
  get cursorBased() { return this.family === 'keyboard' || this.family === 'gamepad'; }
  tag(s) { return this.family + ': ' + s; }
  async shot(label) { const f = path.join(OUT, `dev_${this.family}_${String(++this.shots).padStart(2, '0')}_${label}.png`); await this.page.screenshot(f); return f; }

  /* ---------------------------------------------------------------- raw events */
  // Enter and Space carry their character (text), as a real key press does: without it Chrome does not click a focused button
  async key(name, hold = 35) {
    const k = KEY[name]; const text = name === 'a' ? '\r' : name === 'space' ? ' ' : undefined;
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k[0], code: k[1], windowsVirtualKeyCode: k[2], ...(text ? { text } : {}) });
    await sleep(hold);
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k[0], code: k[1], windowsVirtualKeyCode: k[2] });
    await sleep(25);
  }
  async typeKeys(text) { for (const ch of text) { const up = ch.toUpperCase(); const code = /[a-z]/i.test(ch) ? 'Key' + up : /[0-9]/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : 'Unidentified'; await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }); await sleep(8); } }
  get A() { return this.aIdx === undefined ? PADIDX.a : this.aIdx; }          // the confirm button (journey D rebinds it)
  async pad(idx, hold = 75) {
    await this.page.eval(`(() => { if (!window.__w1woke) { window.__w1woke = 1; window.dispatchEvent(new Event('gamepadconnected')); } window.__pad.buttons[${idx}] = 1; })()`); await sleep(hold);
    await this.page.eval(`window.__pad.buttons[${idx}] = 0`); await sleep(hold);
  }
  async tapAt(x, y) { await this.page.tap(x, y); await sleep(40); }
  async clickAt(x, y) { await this.page.click(x, y); await sleep(40); }

  /* ---------------------------------------------------------------- canvas pages: one vocabulary */
  // an ACTION (up down left right a b start x): keyboard keys, pad buttons, or the on-screen pad (touch). A mouse has no such thing: it uses choose() / advance() / back().
  async act(action) {
    if (this.family === 'keyboard') return this.key(action);
    if (this.family === 'gamepad') return this.pad(action === 'a' ? this.A : PADIDX[action]);
    if (this.family === 'touch') { const c = await L.elementCentre(this.page, `[data-btn="${action}"]`); if (!c) throw new Error('no on-screen button ' + action); await this.tapAt(c.x, c.y); return; }
    throw new Error('a mouse has no ' + action + ' action');
  }
  async canvasPoint(canvasExpr, lx, ly) { return logicalToPage(this.page, canvasExpr, lx, ly); }
  async pointAt(canvasExpr, lx, ly, { hover = true } = {}) {
    const p = await this.canvasPoint(canvasExpr, lx, ly);
    if (this.family === 'mouse') { if (hover) { await moveMouse(this.page, p.x, p.y); await sleep(60); } await this.clickAt(p.x, p.y); }
    else if (this.family === 'touch') await this.tapAt(p.x, p.y);
    else throw new Error('pointAt is for pointer devices');
  }
  // continue text on a battle / hub canvas
  async advance(canvasExpr = BAT + '.canvas') {
    if (this.cursorBased) return this.act('a');
    if (this.family === 'touch') return this.pointAt(canvasExpr, 120, 60);          // a tap anywhere on the text = A (scene hit kind 'text')
    return this.pointAt(canvasExpr, 120, 60, { hover: false });
  }
  async back(canvasExpr = BAT + '.canvas') {
    if (this.family === 'mouse') { const p = await this.canvasPoint(canvasExpr, 120, 80); await rightClick(this.page, p.x, p.y); await sleep(60); return; }
    return this.act('b');
  }
  async openPauseMenu() {
    if (this.family === 'mouse') { const c = await L.elementCentre(this.page, '#menuBtn'); await this.clickAt(c.x, c.y); return; }
    return this.act('start');
  }
  async menuState() { return this.page.eval(`(() => { const a = window.${BAT}, S = a.scene.S; return { mode: a.mode, turn: a.ctl.turn, winner: a.ctl.winner, hash: a.ctl.battle.hash(), cur: { action: S.cursor, move: S.moveCursor, party: S.party ? S.party.cursor : -1, preview: S.preview ? S.preview.cursor : -1, overlay: S.menu ? S.menu.cursor : S.confirm ? S.confirm.cursor : -1, result: S.result ? S.result.cursor : -1 }, picks: S.preview ? S.preview.picks.slice() : null, pick: S.preview ? S.preview.pick : 0, nm: S.req && S.req.moves ? S.req.moves.length : 0, nparty: S.party ? S.party.mons.length : 0, npreview: S.preview ? S.preview.mine.length : 0, menuRows: S.menu ? S.menu.rows.slice() : null, confirm: S.confirm ? S.confirm.kind : null, nopt: S.result ? S.result.options.length : 0, optLabels: S.result ? S.result.options.slice() : null, controlsOpen: !!a.controlsOpen, src: a.input ? a.input.lastSource : null, held: a.input ? a.input.held.length : -1 }; })()`); }
  async rectOf(kind, i) {
    return this.page.eval(`(() => { const a = window.${BAT}, S = a.scene.S, ui = a.ui; const c = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, r }); const kind = ${J(kind)}, i = ${i};
      if (kind === 'action') return c(ui.actionCells()[i]);
      if (kind === 'move') return c(ui.moveCells()[i]);
      if (kind === 'party') return c(ui.rowRects(ui.GEOM.party, S.party.mons.length)[i]);
      if (kind === 'preview') return c(ui.rowRects(ui.GEOM.preview.mine, S.preview.mine.length)[i]);
      if (kind === 'overlay') return c(ui.overlayRects(S.overlay).rows[i]);
      if (kind === 'result') return c(ui.resultRects(S.result).options[i]);
      return null; })()`);
  }
  // choose item `i` of a canvas menu: a cursor device walks the cursor there and presses A; a pointer device hovers and clicks / taps it
  async choose(kind, i) {
    if (kind === 'result') await this.page.waitFor(`${BAT}.scene.state().resultArmed`, { timeoutMs: 20000 });         // the result screen takes no choice until it has been readable (D1)
    if (!this.cursorBased) { const r = await this.rectOf(kind, i); await this.pointAt(BAT + '.canvas', r.x, r.y); return; }
    for (let g = 0; g < 24; g++) {
      const s = await this.menuState();
      const cur = kind === 'action' ? s.cur.action : kind === 'move' ? s.cur.move : kind === 'party' ? s.cur.party : kind === 'preview' ? s.cur.preview : kind === 'overlay' ? s.cur.overlay : s.cur.result;
      if (cur === i) break;
      const d = kind === 'action' || kind === 'move' ? CELL_DIR(cur, i) : kind === 'result' ? ROW_DIR(cur, i) : LIST_DIR(cur, i);
      if (!d) break;
      await this.act(d);
    }
    await this.act('a');
  }
  // press A / tap / click through text until the scene wants a decision (mode in `want`)
  async untilMode(want, { max = 900, advanceEvery = 1 } = {}) {
    const wants = Array.isArray(want) ? want : [want];
    for (let n = 0; n < max; n++) {
      const s = await this.menuState();
      if (wants.includes(s.mode)) return s;
      if (s.mode === 'steps' || s.mode === 'wait') await this.advance();
      else if (s.mode === 'result') return s;
      // a race in this rig, not in the page: the text can end by itself at the very moment our A for it lands, so that A arrives on the action menu and opens FIGHT
      // (the engine log shows the choice before it was accepted ok; the scene is simply on the move list, which nobody here asked for). B puts it back, as a player would.
      else if (s.mode === 'moves' && !wants.includes('moves')) { this.strayFight = (this.strayFight || 0) + 1; await this.back(); }
      else await sleep(60);
      void advanceEvery;
    }
    const why = await this.page.eval(`(() => { const a = window.${BAT}, S = a.scene.S; return { resume: S.resume || null, moves: S.req && S.req.moves ? S.req.moves.map((m) => [m.id, m.pp, m.disabled ? m.reason : 0]) : null, sub: (window.__sub || []).slice(-3) }; })()`).catch(() => null);
    throw new Error(this.tag('never reached ' + J(wants) + '; why ' + J(why) + '; last ' + J(await this.menuState())));
  }

  /* ---------------------------------------------------------------- hub rows */
  async hubState() { return this.page.eval(`(() => { const h = window.${HUB}, m = h.model, st = m.state(); const v = m.view(); return { path: m.path(), cursor: st.cursor[m.path()], rows: v.menu ? v.menu.rows.map((r) => ({ id: r.id, label: r.label, value: r.value, disabled: !!r.disabled })) : null, allRows: m.rows().map((r) => r.id), offset: v.menu && v.menu.offset ? v.menu.offset : 0, rects: m.rects(), src: h.input ? h.input.lastSource : null, dialog: h.dialogOpen() }; })()`); }
  async hubChoose(id, { activate = true } = {}) {
    const s0 = await this.hubState();
    // the main menu scrolls (nine rows, eight shown): the cursor is an index into ALL the rows, the rectangles are those of the rows SHOWN
    const idx = s0.allRows.indexOf(id);
    if (idx < 0) throw new Error('no hub row ' + id + ' in ' + J(s0.allRows));
    if (!this.cursorBased) { const r = s0.rects[idx - s0.offset]; if (!r) throw new Error('hub row ' + id + ' is scrolled out of view; a pointer cannot reach it'); await this.pointAt(HUB + '.canvas', r.x + r.w / 2 - 20, r.y + r.h / 2, { hover: true }); return; }
    for (let g = 0; g < 14; g++) {
      const s = await this.hubState();
      if (s.cursor === idx) break;
      await this.act(s.cursor < idx ? 'down' : 'up');
    }
    if (activate) await this.act('a');
  }
  // cycle a choice row (FORMAT / CPU) one step forward
  async hubStepRight(id) {
    const s0 = await this.hubState();
    const idx = s0.rows.findIndex((r) => r.id === id);
    if (this.cursorBased) { await this.hubChoose(id, { activate: false }); await this.act('right'); return; }
    const r = s0.rects[idx]; await this.pointAt(HUB + '.canvas', r.x + r.w - 10, r.y + r.h / 2, { hover: true });
  }

  /* ---------------------------------------------------------------- DOM pages */
  async focusInfo(sel) { return this.page.eval(`(() => { const t = document.querySelector(${J(sel)}); const a = document.activeElement; if (!t) return { gone: true }; const tr = t.getBoundingClientRect(); const ar = a && a !== document.body ? a.getBoundingClientRect() : null; const modal = [...document.querySelectorAll('[role=dialog][aria-modal="true"]')].filter((m) => m.getClientRects().length && !m.hidden).pop(); const tab = [...(modal || document).querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length && !e.closest('[hidden],[inert]') && getComputedStyle(e).visibility !== 'hidden'); return { done: a === t || t.contains(a), tx: tr.left + tr.width / 2, ty: tr.top + tr.height / 2, ax: ar ? ar.left + ar.width / 2 : null, ay: ar ? ar.top + ar.height / 2 : null, ti: tab.indexOf(t), ai: tab.indexOf(a), n: tab.length, id: a ? (a.dataset && a.dataset.fk) || a.id || a.tagName + ':' + (a.textContent || '').slice(0, 12) : null, vis: tr.width > 0 && tr.height > 0 }; })()`); }
  // KEYBOARD: Tab / Shift+Tab to the element (real focus order)
  async tabTo(sel) {
    for (let round = 0; round < 8; round++) {
      const f = await this.focusInfo(sel);
      if (f.gone) throw new Error('tabTo: no element ' + sel);
      if (f.done) return true;
      if (f.ti < 0) throw new Error('tabTo: ' + sel + ' is not in the tab order');
      const from = f.ai < 0 ? -1 : f.ai;
      let fwd = (f.ti - from + f.n) % f.n; let back = f.n - fwd;
      if (from < 0) { fwd = f.ti + 1; back = f.n - fwd + 1; }
      const useBack = back < fwd;
      const k = Math.max(1, Math.min(useBack ? back : fwd, 40));
      if (useBack) await this.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, windowsVirtualKeyCode: 16 });
      for (let i = 0; i < k; i++) { await this.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', modifiers: useBack ? 8 : 0, windowsVirtualKeyCode: 9 }); await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: useBack ? 8 : 0, windowsVirtualKeyCode: 9 }); await sleep(12); }
      if (useBack) await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    }
    return (await this.focusInfo(sel)).done;
  }
  // GAMEPAD: a player who knows the screen finds a SEQUENCE of d-pad presses that gets there. The layer's own choice of "which control lies that way" (uinav.js
  // chooseNext, the same candidates and the same DOM-order fallback) is replayed page-side to plan the shortest path to the element; the presses are then REAL
  // pad presses and the plan is re-made if focus is not where it should be. No path = the element is unreachable by the d-pad = a defect (it throws).
  async padTo(sel, { rounds = 6 } = {}) {
    for (let round = 0; round < rounds; round++) {
      const f = await this.focusInfo(sel);
      if (f.gone) throw new Error('padTo: no element ' + sel);
      if (f.done) return true;
      const plan = await this.page.eval(PLAN_JS(sel));
      if (plan.unreachable) throw new Error('UNREACHABLE by the d-pad: ' + sel + ' (' + plan.n + ' focusable controls in scope)');
      for (const d of plan.dirs) await this.pad(PADIDX[d], 55);
      await sleep(40);
    }
    return (await this.focusInfo(sel)).done;
  }
  // POINTER devices: scroll (wheel / touch swipe) until the element sits in the middle band of its scroll area AND the point to be pressed really lands on it
  // (a sticky header or a sticky dialog bar covers the first rows of whatever scrolls under it)
  async scrollInto(sel) {
    let stuck = 0, lastTop = null;
    for (let n = 0; n < 70; n++) {
      const r = await this.page.eval(`(() => { const t = document.querySelector(${J(sel)}); if (!t) return { gone: true }; const b = t.getBoundingClientRect(); let p = t.parentElement, sc = null; while (p && p !== document.documentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) { sc = p; break; } p = p.parentElement; } const sr = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth }; const top = Math.max(sr.top, 0), bot = Math.min(sr.bottom, innerHeight); const cx = b.left + b.width / 2, cy = b.top + b.height / 2; const hit = document.elementFromPoint(cx, cy); const hitOk = !!hit && (hit === t || t.contains(hit) || hit.contains(t)); return { top: b.top, cy, h: b.height, w: b.width, vtop: top, vbot: bot, sx: (Math.max(sr.left, 0) + Math.min(sr.right, innerWidth)) / 2, sy: (top + bot) / 2, hitOk, inView: cy > top && cy < bot }; })()`);
      if (r.gone) throw new Error('scrollInto: no element ' + sel);
      const band = (r.vbot - r.vtop) * 0.3;
      const inBand = r.cy >= r.vtop + band && r.cy <= r.vbot - band;
      if (r.w > 0 && r.inView && r.hitOk && (inBand || stuck >= 2)) return true;
      if (lastTop !== null && Math.abs(lastTop - r.top) < 1) stuck++; else stuck = 0;
      lastTop = r.top;
      if (stuck >= 4) return r.hitOk;                                   // the end of the scroll area: nothing more to do
      const dy = Math.max(-600, Math.min(600, r.cy - r.sy));
      if (Math.abs(dy) < 2) { stuck++; }
      if (this.family === 'mouse') { await moveMouse(this.page, r.sx, r.sy); await wheel(this.page, r.sx, r.sy, dy || 20); }
      else await this.swipe(r.sx, r.sy, dy || 20);
      await sleep(this.touch ? 280 : 120);
    }
    return false;
  }
  // the element's centre once it has STOPPED moving (a touch scroll leaves the page gliding for a moment; a tap on a moving target misses)
  // a finger swipe made of real touch events (Input.synthesizeScrollGesture does nothing in this headless Chrome): the finger moves UP by `dy` css px, so the page moves up and the content below comes into view; it rests a moment before lifting so there is no fling
  async swipe(x, y, dy) {
    const sgn = dy > 0 ? 1 : -1, total = Math.min(Math.abs(dy), 560);
    const y0 = y + sgn * total / 2;
    await this.page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let d = 30; d < total; d += 30) { await this.page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - sgn * d }] }); await sleep(16); }
    await this.page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - sgn * total }] });
    await sleep(160);
    await this.page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async center(sel) {
    let c = null;
    for (let i = 0; i < 12; i++) {
      const n = await L.elementCentre(this.page, sel); if (!n) throw new Error('no element ' + sel);
      if (c && Math.abs(c.x - n.x) < 0.5 && Math.abs(c.y - n.y) < 0.5) return n;
      c = n; await sleep(this.touch ? 160 : 60);
    }
    return c;
  }
  // focus WITHOUT activating (so a text field can then be typed into)
  async focusOn(sel) {
    if (this.family === 'keyboard') return this.tabTo(sel);
    if (this.family === 'gamepad') return this.padTo(sel);
    await this.scrollInto(sel);
    if (await this.page.eval(`document.querySelector(${J(sel)}).tagName === 'SELECT'`)) return true;        // the native popup cannot be driven in headless Chrome: no click, the value is set by script
    const c = await this.center(sel);
    if (this.family === 'mouse') await this.clickAt(c.x, c.y); else await this.tapAt(c.x, c.y);
    return true;
  }
  // activate a button / link / checkbox / radio / summary / file input
  async press(sel) {
    if (this.family === 'keyboard') {
      await this.tabTo(sel);
      const kind = await this.page.eval(`(() => { const e = document.querySelector(${J(sel)}); return e.tagName === 'INPUT' && /checkbox|radio/.test(e.type) ? 'space' : 'enter'; })()`);
      return this.key(kind === 'space' ? 'space' : 'a');
    }
    if (this.family === 'gamepad') { await this.padTo(sel); return this.pad(this.A); }
    await this.scrollInto(sel);
    const c = await this.center(sel);
    if (this.family === 'mouse') await this.clickAt(c.x, c.y); else await this.tapAt(c.x, c.y);
  }
  // type text into a field (select-all first): keyboard types keys; touch uses the soft keyboard; the controller uses the ON-SCREEN KEYBOARD; a mouse cannot
  async typeInto(sel, text) {
    if (this.family === 'mouse') throw new Error('a mouse cannot type');
    await this.focusOn(sel);
    if (this.family === 'keyboard') { await this.page.eval(`document.querySelector(${J(sel)}).select && document.querySelector(${J(sel)}).select()`); await this.typeKeys(text); }
    else if (this.family === 'touch') { await this.page.eval(`document.querySelector(${J(sel)}).select && document.querySelector(${J(sel)}).select()`); await this.page.send('Input.insertText', { text }); }
    else {
      await this.pad(this.A);                                         // A on a text field opens the on-screen keyboard
      await this.page.waitFor(`document.body.dataset.osk === 'open'`, { timeoutMs: 4000 });
      if (await this.page.eval(`!!document.querySelector(${J(sel)}).value`)) { await this.padTo('[data-role="clear"]'); await this.pad(this.A); }          // the keyboard opens on the field's text: Clear it first
      const shiftOn = () => this.page.eval(`document.querySelector('[data-role="shift"]').getAttribute('aria-pressed') === 'true'`);
      for (const ch of text) {
        const k = ch.toLowerCase();
        if (ch === ' ') { await this.padTo('[data-role="space"]'); await this.pad(this.A); continue; }
        const isUp = ch !== k;
        if (isUp !== (await shiftOn()) && /[a-z]/.test(k)) { await this.padTo('[data-role="shift"]'); await this.pad(this.A); }       // the keyboard starts with Shift on for an empty field
        await this.padTo(`[data-key="${CSS_ESC(k)}"]`); await this.pad(this.A);
      }
      await this.padTo('[data-role="ok"]'); await this.pad(this.A);
      await this.page.waitFor(`document.body.dataset.osk !== 'open'`, { timeoutMs: 4000 });
    }
    await sleep(120);
  }
  // choose an <option> of a native select: keyboard = arrow keys on the focused select; gamepad = cycle mode (A, then left / right, B); mouse / touch = focus it, then set it by script (a headless Chrome cannot open the native popup)
  async selectValue(sel, value) {
    const info = () => this.page.eval(`(() => { const s = document.querySelector(${J(sel)}); return { idx: s.selectedIndex, want: [...s.options].findIndex((o) => o.value === ${J(String(value))}), n: s.options.length }; })()`);
    await this.focusOn(sel);
    let i = await info();
    if (i.want < 0) throw new Error('no option ' + value + ' in ' + sel);
    if (this.family === 'keyboard') { for (let g = 0; g < 40 && (await info()).idx !== i.want; g++) await this.key((await info()).idx < i.want ? 'down' : 'up'); }
    // (the editor rebuilds the tab after every change, which ends the layer's cycle mode on the old element: one A + one arrow per step)
    else if (this.family === 'gamepad') { for (let g = 0; g < 40 && (await info()).idx !== i.want; g++) { await this.pad(this.A); await this.pad((await info()).idx < i.want ? PADIDX.right : PADIDX.left, 55); await sleep(60); } }
    else await this.page.eval(`(() => { const s = document.querySelector(${J(sel)}); s.value = ${J(String(value))}; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    i = await info();
    return i.idx === i.want;
  }
  // a number field: keyboard / touch type it, the controller uses EDIT mode (A, up = a big step), the mouse uses the + button
  async setNumber(sel, plusSel, target) {
    if (this.family === 'mouse') { for (let k = 0; k < 6; k++) await this.press(plusSel); return; }
    if (this.family === 'gamepad') { await this.padTo(sel); await this.pad(this.A); for (let k = 0; k < 4; k++) await this.pad(PADIDX.up, 55); await this.pad(PADIDX.b); return; }
    await this.typeInto(sel, String(target));
    if (this.family === 'keyboard') await this.key('tab'); else await this.page.eval(`document.querySelector(${J(sel)}).blur()`);
  }
  async reload() { await this.page.eval('window.__marker = 1; location.reload(); true'); await sleep(400); await this.page.waitFor('window.__marker === undefined && document.readyState === "complete"', { timeoutMs: 60000 }); }
}
// page-side path planner for padTo (see there): breadth-first search over the layer's own "nearest control in that direction" relation
const PLAN_JS = (sel) => `(async () => {
  const { chooseNext, NAV_SELECTOR } = await import('/pokemonarena/js/uinav.js');
  const t = document.querySelector(${J(sel)}); if (!t) return { gone: true };
  const COMPOSITE = new Set(['option', 'radio', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'gridcell', 'switch', 'checkbox']);
  const modal = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')].filter((d) => d.getClientRects().length && !d.hidden && (d.getAttribute('aria-modal') === 'true' || d.hasAttribute('data-nav-modal'))).pop();
  const scope = modal || document.body;
  const usable = (el) => { if (el.disabled) return false; if (el.closest('[data-nav-skip], [inert], [hidden], fieldset[disabled], [aria-hidden="true"]')) return false; const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const isCand = (el) => el.matches(NAV_SELECTOR) && (el.tabIndex >= 0 || el.hasAttribute('data-nav') || (el.hasAttribute('tabindex') && COMPOSITE.has(String(el.getAttribute('role') || '').toLowerCase())));
  const cands = [...scope.querySelectorAll(NAV_SELECTOR)].filter((e) => isCand(e) && usable(e));
  const rects = new Map(cands.map((e) => [e, e.getBoundingClientRect()]));
  const next = (c, dir) => {
    const others = cands.filter((o) => o !== c && !c.contains(o) && !o.contains(c));
    const hit = chooseNext(rects.get(c), others.map((el) => ({ el, rect: rects.get(el) })), dir);
    if (hit) return hit.cand.el;
    if (dir === 'down' || dir === 'right') return others.find((o) => c.compareDocumentPosition(o) & 4) || null;
    for (let i = others.length - 1; i >= 0; i--) if (c.compareDocumentPosition(others[i]) & 2) return others[i];
    return null;
  };
  const goal = (e) => e === t || t.contains(e) || e.contains(t);
  const a = document.activeElement;
  let start, pre = [];
  if (a && a !== document.body && scope.contains(a) && cands.includes(a)) start = a;
  else { start = cands.find((c) => c.hasAttribute('data-nav-default') || c.hasAttribute('autofocus')) || cands[0]; pre = ['down']; }   // the first press only puts focus on the default control
  if (!start) return { unreachable: true, n: 0 };
  const prev = new Map([[start, null]]); const q = [start]; let found = goal(start) ? start : null;
  for (let i = 0; i < q.length && !found; i++) {
    for (const d of ['down', 'up', 'right', 'left']) {
      const n = next(q[i], d);
      if (n && !prev.has(n)) { prev.set(n, [q[i], d]); if (goal(n)) { found = n; break; } q.push(n); }
    }
  }
  if (!found) return { unreachable: true, n: cands.length };
  const dirs = []; for (let c = found; prev.get(c); c = prev.get(c)[0]) dirs.unshift(prev.get(c)[1]);
  return { dirs: pre.concat(dirs), n: cands.length };
})()`;
const CSS_ESC = (k) => (/^[a-z0-9]$/.test(k) ? k : k.replace(/(["'\\])/g, '\\$1'));

/* ================================================================================================ small helpers */
const waitFor = (page, expr, ms = 90000) => page.waitFor(expr, { timeoutMs: ms });
const editorReady = (page) => waitFor(page, 'window.__editor && (__editor.ready || __editor.error)');
const monKey = (m) => canon({ species: m.species, nature: m.nature, abilitySlot: m.abilitySlot, heldItem: m.heldItem, moves: m.moves.map((x) => (typeof x === 'number' ? x : x.id)), ev: m.ev, iv: m.iv, level: m.level, nickname: m.nickname || '' });
const profileMons = (profile, ti = 0) => profile.teams[ti].monIds.map((id) => profile.box.find((m) => m.id === id));
const speciesId = (n) => pack.species.findIndex((s) => s && s.legal && s.name === n);
const EXPECT_DEVICE = { keyboard: { key: '>0', mouse: 0, touch: 0 }, mouse: { key: 0, mouse: '>0', touch: 0 }, gamepad: { key: 0, mouse: 0, touch: 0 }, touch: { key: 0, mouse: 0, touch: '>0' } };

async function newSession(family, port, fn) {
  const vp = family === 'touch' ? { width: 390, height: 844, dpr: 3, mobile: true } : { width: 1280, height: 800, dpr: 1, mobile: false };
  await withBrowser({ port, width: vp.width, height: vp.height, mobile: vp.mobile }, async (page) => {
    await page.setViewport(vp.width, vp.height, { mobile: vp.mobile, dpr: vp.dpr });
    await addInit(page, AUDIO_DOUBLE); await addInit(page, EVC);
    if (family === 'gamepad') { await addInit(page, PAD_DOUBLE); }
    await fn(page, new Dev(family, page, vp), vp);
  });
}
async function gamepadWake(page, dev) { if (dev.family === 'gamepad') { await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` }); } }

// no player-visible wording that says "unfinished": text, title, labels (the canvas pages mirror their menu into a live region)
async function noDemoWords(dev, what) {
  const hits = await dev.page.eval(`(() => { const t = document.body.innerText + ' ' + document.title + ' ' + [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].map((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a) || '').join(' ')).join(' ') + ' ' + (document.getElementById('live') ? document.getElementById('live').textContent : ''); return t.match(/demo|lorem|todo|placeholder|coming soon|\\[object|undefined|NaN/ig) || []; })()`);
  ok(hits.length === 0, dev.tag('no player-visible demo wording on ' + what), J(hits));
}
// the hit areas of the canvas menus include their FIRST and LAST pixel: hovering there moves the cursor to that cell (a mouse; the first and last pixel are where a one-pixel error shows)
async function edgeCheck(dev, kind, n, cursorKey) {
  let bad = [];
  for (let i = 0; i < n; i++) {
    const r = (await dev.rectOf(kind, i)).r;
    for (const [px, py] of [[r.x + 0.5, r.y + 0.5], [r.x + r.w - 0.5, r.y + r.h - 0.5]]) {
      const p = await dev.canvasPoint(BAT + '.canvas', px, py);
      await moveMouse(dev.page, p.x - 40, p.y - 40); await sleep(20);   // leave the cell first, so the hover is a real move
      await moveMouse(dev.page, p.x, p.y); await sleep(50);
      const s = await dev.menuState();
      if (s.cur[cursorKey] !== i) bad.push(i + '@' + px + ',' + py + ' -> ' + s.cur[cursorKey]);
    }
  }
  ok(bad.length === 0, dev.tag('the first and last pixel of each ' + kind + ' cell select that cell (hit areas have no off-by-one)'), bad.join(' ; '));
}

/* ================================================================================================ the battle routines shared by the journeys */
// run the text until the scene wants an ACTION (or the battle is over). On the way it answers what a player is asked, with THIS device: a forced switch (a Pokemon fainted) takes the first healthy
// teammate; a preview the journey did not choose itself (a 6v6 lead preview, a 3v3 team preview) takes the first Pokemon and says YES; and "Will you switch your Pokemon?" (the free switch, asked when the
// CPU's Pokemon has fainted) is answered YES + the first healthy Pokemon the first time (dev.freeSwitched records which one, so a journey can check it came in) and NO every time after.
async function toAction(dev) {
  const firstHealthy = () => dev.page.eval(`(() => { const m = ${BAT}.scene.S.party.mons; return m.findIndex((x) => !x.fainted && !x.active); })()`);
  for (let g = 0; g < 24; g++) {
    const s = await dev.untilMode(['action', 'party', 'result', 'preview', 'confirm']);
    if (s.mode === 'action' || s.mode === 'result') return s;
    if (s.mode === 'preview') { for (let k = 0; k < (s.pick || 1); k++) await dev.choose('preview', k); continue; }
    if (s.mode === 'confirm') {
      if (s.confirm === 'free') {
        if (!dev.freeAsked) {
          dev.freeAsked = 1;
          await dev.choose('overlay', 0);                                                          // YES
          const j = await firstHealthy();
          const slot = await dev.page.eval(`${BAT}.scene.S.party.mons[${j < 0 ? 0 : j}].slot`);
          await dev.choose('party', j < 0 ? 0 : j);
          dev.freeSwitched = { slot, front: await dev.page.eval(`(() => { const sd = ${BAT}.ctl.battle.s.sides[0]; return sd.team[sd.act].slot; })()`) };
        } else await dev.choose('overlay', 1);                                                     // NO
      } else await dev.choose('overlay', 0);                                                       // "Send out this team / this one first?": YES
      continue;
    }
    const i = await firstHealthy();
    await dev.choose('party', i < 0 ? 0 : i);
  }
  throw new Error(dev.tag('could not get past the forced switches and questions'));
}
// FIGHT with move `m`, through the text, until the next decision; asserts the engine moved on
async function fightTurn(dev, tag, m = 0) {
  const s0 = await toAction(dev);
  if (s0.mode === 'result') return s0;
  await dev.choose('action', 0);
  const s1 = await dev.untilMode(['moves']);
  ok(s1.mode === 'moves', dev.tag(tag + ': FIGHT opens the move menu'), J(s1));
  // the m-th move that can be used (a move with no PP left, or one a Taunt forbids, only flashes a line)
  await dev.page.eval(`(() => { const c = ${BAT}.ctl; if (!c.__sub) { c.__sub = 1; window.__sub = []; const o = c.submit; c.submit = (s, ch) => { const r = o.call(c, s, ch); window.__sub.push([ch, r && r.ok, r && r.code]); return r; }; } })()`);   // diagnostics only: what the engine answered to each choice
  const usable = await dev.page.eval(`(() => ${BAT}.scene.S.req.moves.map((mv, i) => [mv, i]).filter(([mv]) => !mv.disabled).map(([, i]) => i))()`);
  await dev.choose('move', usable.length ? usable[m % usable.length] : 0);
  const s2 = await toAction(dev);
  ok(s2.turn > s0.turn || s2.mode === 'result', dev.tag(tag + ': the move was used (turn ' + s0.turn + ' -> ' + s2.turn + ', engine hash changed ' + (s2.hash !== s0.hash) + ')'), J({ a: s0.turn, b: s2.turn, mode: s2.mode }));
  return s2;
}
async function forfeitByRun(dev, tag) {
  let s = await toAction(dev);
  await dev.choose('action', 3);                                                       // RUN
  s = await dev.menuState();
  ok(s.mode === 'confirm' && s.confirm === 'forfeit' && s.cur.overlay === 1, dev.tag(tag + ': RUN asks YES / NO first, and the cursor starts on NO'), J(s));
  await dev.choose('overlay', 1);                                                      // NO
  s = await toAction(dev);
  ok(s.mode === 'action' && s.winner === null, dev.tag(tag + ': NO goes back to the action menu and the battle goes on'), J(s));
  await dev.choose('action', 3);
  await dev.choose('overlay', 0);                                                      // YES
  s = await dev.untilMode(['result']);
  ok(s.mode === 'result' && s.winner === 1, dev.tag(tag + ': YES forfeits: the result screen, the CPU wins'), J(s));
  return s;
}
// the pause menu: open, assert the rows, CONTROLS -> dialog -> close -> the menu is back, RESUME
async function pauseMenuTour(dev, tag) {
  await dev.openPauseMenu();
  let s = await dev.menuState();
  ok(s.mode === 'menu' && J(s.menuRows.slice(0, 2)) === J(['RESUME', 'CONTROLS']) && s.menuRows[s.menuRows.length - 1] === 'BACK TO HUB', dev.tag(tag + ': the pause menu lists RESUME / CONTROLS ... BACK TO HUB'), J(s.menuRows));
  await dev.choose('overlay', 1);                                                      // CONTROLS
  await dev.page.waitFor(`${BAT}.controlsOpen === true && document.getElementById('controlsDialog') && !document.getElementById('controlsDialog').hidden`, { timeoutMs: 8000 });
  ok(true, dev.tag(tag + ': CONTROLS opens the Controls dialog (the battle clock stops)'));
  await dev.shot('battle_controls');
  // close it with the device's own way back
  if (dev.family === 'keyboard') await dev.key('esc'); else if (dev.family === 'gamepad') await dev.pad(PADIDX.b); else { const c = await dev.center('#controlsClose'); if (dev.family === 'mouse') await dev.clickAt(c.x, c.y); else await dev.tapAt(c.x, c.y); }
  await dev.page.waitFor(`${BAT}.controlsOpen === false`, { timeoutMs: 8000 });
  await sleep(150);
  s = await dev.menuState();
  ok(s.mode === 'menu' && s.cur.overlay === 1, dev.tag(tag + ': closing the dialog returns to the pause menu on CONTROLS (the closing key did not act on the battle)'), J(s));
  // MU3: the SOUND row opens the volume panel (it used to be a bare on / off toggle); closing it returns to the pause menu on SOUND
  ok(s.menuRows[2].startsWith('SOUND'), dev.tag(tag + ': the third pause-menu row is SOUND'), J(s.menuRows));
  await dev.choose('overlay', 2);                                                      // SOUND
  await dev.page.waitFor(`${BAT}.controlsOpen === true && document.getElementById('soundDialog') && !document.getElementById('soundDialog').hidden`, { timeoutMs: 8000 });
  ok(true, dev.tag(tag + ': SOUND opens the volume panel (the battle clock stops)'));
  await dev.shot('battle_sound');
  if (dev.family === 'keyboard') await dev.key('esc'); else if (dev.family === 'gamepad') await dev.pad(PADIDX.b); else { const c = await dev.center('[data-snd="close"]'); if (dev.family === 'mouse') await dev.clickAt(c.x, c.y); else await dev.tapAt(c.x, c.y); }
  await dev.page.waitFor(`${BAT}.controlsOpen === false`, { timeoutMs: 8000 });
  await sleep(150);
  s = await dev.menuState();
  ok(s.mode === 'menu' && s.cur.overlay === 2, dev.tag(tag + ': closing the volume panel returns to the pause menu on SOUND (the closing key did not act on the battle)'), J(s));
  await dev.choose('overlay', 0);                                                      // RESUME
  s = await dev.menuState();
  ok(s.mode !== 'menu', dev.tag(tag + ': RESUME closes the pause menu'), J(s));
}

// D1: mashing the device's confirm on the fresh result screen must not leave it (it used to start REMATCH within 4 frames); only a press after the screen has been readable does
async function mashResult(dev, tag) {
  const s0 = await dev.menuState();
  const armed0 = await dev.page.eval(`${BAT}.scene.state().resultArmed`);
  const loc0 = await dev.page.eval('location.pathname + location.search');
  for (let i = 0; i < 4; i++) {
    if (dev.cursorBased) await dev.act('a'); else { const r = await dev.rectOf('result', 0); await dev.pointAt(BAT + '.canvas', r.x, r.y, { hover: false }); }
    await sleep(60);
  }
  const s1 = await dev.menuState();
  const loc1 = await dev.page.eval('location.pathname + location.search');
  ok(s0.mode === 'result' && armed0 === false && s1.mode === 'result' && loc1 === loc0, dev.tag(tag + ': mashing the confirm input on the fresh result screen does not leave it (it stays on the result screen and the address did not change)'), J({ s0: s0.mode, armed0, s1: s1.mode, loc0, loc1 }));
}

/* ================================================================================================ journey A: Quick Battle 6v6 */
async function journeyA(dev, page) {
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
  await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await gamepadWake(page, dev);
  await noDemoWords(dev, 'the hub');
  let h = await dev.hubState();
  ok(h.allRows.join() === 'quick,team,tower,record,builder,import,controls,sound,about' && h.rows.length === 8, dev.tag('A: the hub has nine rows (IMPORT SAVE, RECORD and TOWER among them), eight shown at a time'), J(h.allRows));
  await dev.shot('hub');
  await dev.hubChoose('quick');
  h = await dev.hubState();
  ok(h.path === 'quick', dev.tag('A: QUICK BATTLE opens the quick-battle screen'), h.path);
  await dev.hubStepRight('format');
  h = await dev.hubState();
  ok(h.rows.find((r) => r.id === 'format').value === '6v6', dev.tag('A: FORMAT steps to 6v6'), J(h.rows[0]));
  await dev.shot('hub_quick');
  await dev.hubChoose('start');
  await waitFor(page, `window.${BAT} && ${BAT}.state !== 'boot'`);
  ok((await page.eval(`${BAT}.state`)) === 'ready' && (await page.eval(`${BAT}.params.format`)) === '6v6' && (await page.eval(`${BAT}.params.quick`)) === true, dev.tag('A: START opens battle.html as a 6v6 Quick Battle'), await page.eval(`${BAT}.state + ' ' + ${BAT}.error`));
  await sleep(200);
  await noDemoWords(dev, 'the battle page');
  // Since the 6v6 LEAD preview a 6v6 battle opens by asking which Pokemon goes out first. This device chooses the 4th (the question, then YES); the battle must send exactly that one out first.
  let lead = await dev.untilMode(['preview']);
  ok(lead.mode === 'preview' && lead.npreview === 6 && lead.pick === 1, dev.tag('A: the 6v6 battle opens on the lead preview: six Pokemon, one to choose'), J({ n: lead.npreview, pick: lead.pick }));
  await dev.shot('battle_lead_preview');
  await dev.choose('preview', 3);
  lead = await dev.menuState();
  ok(lead.mode === 'confirm' && J(lead.picks) === '[3]', dev.tag('A: choosing the 4th Pokemon asks "Send out this one first?" (YES / NO)'), J({ mode: lead.mode, picks: lead.picks }));
  await dev.shot('battle_lead_question');
  await dev.choose('overlay', 0);                                                          // YES
  await dev.untilMode(['action']);
  const front = await page.eval(`(() => { const sd = ${BAT}.ctl.battle.s.sides[0]; return { orig: sd.team[sd.act].orig, order: sd.team.map((m) => m.orig) }; })()`);
  ok(front.orig === 3 && J(front.order) === '[3,0,1,2,4,5]', dev.tag('A: the 4th Pokemon is sent out first and the rest follow in team order'), J(front));
  if (dev.family === 'mouse') { await dev.untilMode(['action']); await edgeCheck(dev, 'action', 4, 'action'); }
  // two turns of FIGHT / move
  await fightTurn(dev, 'A turn 1');
  await dev.shot('battle_after_turn1');
  let s = await toAction(dev);
  await fightTurn(dev, 'A turn 2', 1);
  // a voluntary switch: POKeMON -> a healthy teammate
  s = await toAction(dev);
  const before = await page.eval(`${BAT}.ctl.view(0).you.active`);
  await dev.choose('action', 2);
  s = await dev.menuState();
  ok(s.mode === 'party' && s.nparty === 6, dev.tag('A: POKeMON opens the party screen with six Pokemon'), J(s));
  await dev.shot('battle_party');
  const target = await page.eval(`(() => { const t = ${BAT}.ctl.view(0).you.team; const i = t.findIndex((m) => m.hp > 0 && m.slot !== ${BAT}.ctl.view(0).you.active); return i; })()`);
  await dev.choose('party', target);
  s = await dev.untilMode(['action', 'party', 'result']);
  const after = await page.eval(`${BAT}.ctl.view(0).you.active`);
  const why = after !== before ? null : await page.eval(`(() => { const S = ${BAT}.scene.S; return { trapped: !!(S.party && S.party.req && S.party.req.trapped), text: (S.lastBox && S.lastBox.text || []).join(' ') }; })()`);       // (a Pokemon held by the foe's Shadow Tag / Arena Trap / Magnet Pull cannot leave: the screen says so and stays)
  ok(after !== before, dev.tag('A: the switch happened: the active Pokemon changed (slot ' + before + ' -> ' + after + ')'), J({ before, after, mode: s.mode, why }));
  s = await toAction(dev);
  await pauseMenuTour(dev, 'A');
  const fin = await forfeitByRun(dev, 'A');
  // (only when the CPU's Pokemon fainted in this journey's turns: toAction answers the question with this device, and it must have brought the chosen Pokemon in)
  if (dev.freeSwitched) ok(dev.freeSwitched.front === dev.freeSwitched.slot, dev.tag('A: "Will you switch your Pokemon?" was asked, this device said YES and picked a Pokemon: that one came in'), J(dev.freeSwitched));
  await dev.shot('battle_result');
  await mashResult(dev, 'A');
  ok(fin.nopt === 3 && J(fin.optLabels) === J(['REMATCH', 'NEW BATTLE', 'BACK TO HUB']), dev.tag('A: the result screen offers REMATCH / NEW BATTLE / BACK TO HUB'), J(fin.optLabels));
  await dev.choose('result', 2);
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`, 60000);
  ok((await page.eval('location.pathname')) === '/pokemonarena/', dev.tag('A: BACK TO HUB lands on the hub'), await page.eval('location.pathname'));
}

/* ================================================================================================ journey D: the Controls panel */
async function journeyD(dev, page) {
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
  await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await gamepadWake(page, dev);
  await page.eval(`localStorage.removeItem('arena.bindings')`);
  await dev.hubChoose('controls');
  await waitFor(page, `${HUB}.dialogOpen()`, 10000);
  ok(await page.eval(`!!document.querySelector('#controlsDialog .ip') && document.getElementById('controlsDialog').getAttribute('aria-modal') === 'true'`), dev.tag('D: CONTROLS opens the Controls panel as a modal dialog'));
  await dev.shot('controls_open');
  const bindings = () => page.eval(`(() => { const b = ${HUB}.input.bindings.get(); return { kbA: b.keyboard.a.slice(), padA: b.gamepad.buttons.a.slice(), layout: ${HUB}.input.bindings.layout() }; })()`);
  if (dev.family === 'keyboard') {
    await dev.press('[data-chip="keyboard"][data-action="a"][data-slot="0"]');
    await page.waitFor(`${HUB}.input.capturing`, { timeoutMs: 4000 });
    ok(/Press a key/.test(await page.eval(`document.querySelector('[data-ip="status"]').textContent`)), dev.tag('D: choosing a key chip starts press-to-bind (status: ' + await page.eval(`document.querySelector('[data-ip="status"]').textContent`) + ')'));
    await dev.typeKeys('g');
    await sleep(200);
    const b = await bindings();
    ok(b.kbA[0] === 'KeyG' && /now G/.test(await page.eval(`document.querySelector('[data-ip="status"]').textContent`)), dev.tag('D: the next key (G) is bound to Confirm'), J(b));
  } else if (dev.family === 'gamepad') {
    await dev.press('[data-chip="gamepad"][data-action="a"][data-slot="0"]');
    await page.waitFor(`${HUB}.input.capturing`, { timeoutMs: 4000 });
    await dev.pad(10);                                              // L3: unbound by default
    await sleep(200);
    const b = await bindings();
    if (b.padA[0] === 10) dev.aIdx = 10;                            // from here on A is the stick press
    ok(b.padA[0] === 10, dev.tag('D: the next controller button (stick press) is bound to Confirm'), J(b));
  } else {
    await dev.press('[data-fk="layout-nintendo"]');
    await sleep(150);
    ok((await bindings()).layout === 'nintendo' && (await page.eval(`document.querySelector('[data-fk="layout-nintendo"]').getAttribute('aria-checked')`)) === 'true', dev.tag('D: the Nintendo layout switch is pressed and the layer says so'), J(await bindings()));
    await dev.press('[data-chip="keyboard"][data-action="a"][data-slot="0"]');
    await page.waitFor(`${HUB}.input.capturing`, { timeoutMs: 4000 });
    ok(true, dev.tag('D: choosing a chip starts press-to-bind'));
    await dev.press('[data-ip="cancel"]');
    await sleep(150);
    ok(!(await page.eval(`${HUB}.input.capturing`)) && /Cancelled/.test(await page.eval(`document.querySelector('[data-ip="status"]').textContent`)), dev.tag('D: Cancel ends the capture, so nobody is trapped waiting for a key this device cannot press'), await page.eval(`document.querySelector('[data-ip="status"]').textContent`));
  }
  await dev.shot('controls_changed');
  // close with the device's own way
  if (dev.family === 'keyboard') await dev.key('esc'); else if (dev.family === 'gamepad') await dev.pad(PADIDX.b); else await dev.press('#controlsClose');
  await page.waitFor(`!${HUB}.dialogOpen()`, { timeoutMs: 8000 });
  ok(true, dev.tag('D: the dialog closes with this device\'s own way back'));
  // the change takes effect on the hub: the new key / button now confirms
  if (dev.family === 'keyboard') {
    const p0 = await dev.hubState();
    await page.eval(`${HUB}.canvas.focus()`);
    await dev.hubChoose('quick', { activate: false });
    await dev.typeKeys('g'); await sleep(150);
    ok((await dev.hubState()).path === 'quick' && p0.path === 'main', dev.tag('D: the rebound key G now confirms on the hub (QUICK BATTLE opened)'), J((await dev.hubState()).path));
    await page.eval(`${HUB}.model.goto('main')`);
    await dev.press('#controlsBtn'); await waitFor(page, `${HUB}.dialogOpen()`, 8000);
    await dev.press('[data-ip="reset-keyboard"]'); await sleep(150);
    ok((await bindings()).kbA.includes('KeyZ') && !(await bindings()).kbA.includes('KeyG'), dev.tag('D: Reset keyboard puts Z back and removes G'), J(await bindings()));
    await dev.key('esc');
  } else if (dev.family === 'gamepad') {
    await page.eval(`${HUB}.canvas.focus()`);
    await dev.hubChoose('quick', { activate: false });
    await dev.act('a'); await sleep(150);
    ok((await dev.hubState()).path === 'quick', dev.tag('D: the rebound stick press now confirms on the hub (QUICK BATTLE opened)'), J((await dev.hubState()).path));
    await page.eval(`${HUB}.model.goto('main')`);
    await dev.hubChoose('controls', { activate: false }); await dev.act('a'); await waitFor(page, `${HUB}.dialogOpen()`, 8000);
    await dev.press('[data-ip="reset-gamepad"]'); await sleep(150);
    if ((await bindings()).padA[0] === 0) dev.aIdx = 0;
    ok((await bindings()).padA[0] === 0, dev.tag('D: Reset controller puts the A button back'), J(await bindings()));
    // W1 fix A1: a controller-only player cannot strand themselves. (1) Binding Back to A's button and answering "use it here only" is refused, A keeps its button;
    // (2) with A moved to the stick press, holding Start + Select for 2 s (an escape that reads the physical buttons) puts the controller back to the defaults.
    const padBind = () => page.eval(`(() => { const g = ${HUB}.input.bindings.get().gamepad.buttons; return { a: g.a.slice(), b: g.b.slice() }; })()`);
    await dev.press('[data-chip="gamepad"][data-action="b"][data-slot="0"]');
    await page.waitFor(`${HUB}.input.capturing`, { timeoutMs: 4000 });
    await dev.pad(0);                                               // the A button
    await page.waitFor(`!!document.querySelector('[data-ip="move"]')`, { timeoutMs: 4000 });
    await dev.press('[data-ip="move"]');
    await sleep(200);
    const trap = await padBind();
    ok(trap.a.join() === '0' && trap.b.join() === '1' && /Nothing changed/.test(await page.eval(`document.querySelector('[data-ip="status"]').textContent`)), dev.tag('D: A1: "use it here only" on the A button is refused (A keeps button 0, Back keeps button 1) and the panel says why'), J(trap));
    await dev.press('[data-chip="gamepad"][data-action="a"][data-slot="0"]');
    await page.waitFor(`${HUB}.input.capturing`, { timeoutMs: 4000 });
    await dev.pad(10); await sleep(200);
    dev.aIdx = 10;
    ok((await padBind()).a.join() === '10', dev.tag('D: A1: (setup) Confirm is now the stick press'), J(await padBind()));
    await page.eval(`window.__pad.buttons[8] = 1; window.__pad.buttons[9] = 1`);
    await sleep(2500);
    await page.eval(`window.__pad.buttons[8] = 0; window.__pad.buttons[9] = 0`);
    await sleep(300);
    const esc = await padBind();
    if (esc.a[0] === 0) dev.aIdx = 0;
    ok(esc.a.join() === '0' && esc.b.join() === '1' && (await page.eval(`localStorage.getItem('arena.bindings')`)) === null, dev.tag('D: A1: Start + Select held for 2 s put the controller back to the defaults (A on button 0, saved bindings cleared)'), J(esc));
    await dev.pad(PADIDX.b);
  } else {
    await dev.press('#controlsBtn'); await waitFor(page, `${HUB}.dialogOpen()`, 8000);
    ok((await bindings()).layout === 'nintendo', dev.tag('D: the layout choice survived closing and reopening the dialog'), J(await bindings()));
    await dev.press('[data-ip="reset-all"]'); await sleep(150);
    ok((await bindings()).layout === 'auto', dev.tag('D: Reset all puts the layout back to Automatic'), J(await bindings()));
    await dev.press('#controlsClose');
  }
  await page.waitFor(`!${HUB}.dialogOpen()`, { timeoutMs: 8000 });
}

/* ================================================================================================ journey V: the SOUND panel (MU3), one device at a time */
// The hub's SOUND row opens the panel (the controller has no other way to the header button); every control of the panel is used with ONLY this device:
// the Music slider, Mute, the Test cry, the soundtrack choice (reached; the Ultra Violet ROM is not fetched here, tools/pokemonarena_sound_page_test.mjs does that),
// close. The mixer's own state (window.__arenaSound) is the evidence; the AudioContext is the hub_lib double. A controller can never start the sound (no browser
// user activation), so the gamepad family must end with NO AudioContext at all.
async function journeyV(dev, page) {
  // pointer devices press what they see: the panel fits the screen, and the harness's scroll-into-view swipe (a finger dragged across the sliders) would itself move a slider
  const vpress = async (sel) => { if (dev.family === 'mouse' || dev.family === 'touch') { const c = await dev.center(sel); if (dev.family === 'mouse') await dev.clickAt(c.x, c.y); else await dev.tapAt(c.x, c.y); } else await dev.press(sel); };
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`);
  await page.eval(`localStorage.removeItem('arena.audio'); localStorage.removeItem('arena.sound'); ${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`);
  await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await gamepadWake(page, dev);
  const snd = () => page.eval(`window.__arenaSound.mixer.settings()`);
  const stored = () => page.eval(`localStorage.getItem('arena.audio')`);
  const panelUp = () => page.eval(`(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden && ${HUB}.dialogOpen(); })()`);
  ok((await snd()).muted === false && (await snd()).music === 0.6, dev.tag('V: the default is sound ON, music 0.6'), J(await snd()));
  await dev.hubChoose('sound');
  await waitFor(page, `(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden; })()`, 10000);
  ok(await panelUp(), dev.tag('V: the SOUND row opens the SOUND panel (a modal dialog) with this device'));
  ok((await page.eval(`${HUB}.view().menu.rows.find((r) => r.id === 'sound').label`)) === 'SOUND: ON', dev.tag('V: the SOUND row still reads ON'));
  await dev.shot('sound_open');
  // the Music slider
  const sel = '[data-snd="slider-music"]';
  const val = () => page.eval(`Number(document.querySelector(${J(sel)}).value)`);
  if (dev.family === 'keyboard') {
    await dev.tabTo(sel); await dev.key('right'); await dev.key('right');
    ok((await val()) === 70 && (await snd()).music === 0.7, dev.tag('V: Tab to the Music slider, Right twice: 70%, stored in the mixer'), J({ v: await val(), s: await snd() }));
  } else if (dev.family === 'gamepad') {
    await dev.padTo(sel); await dev.pad(dev.A); await dev.pad(PADIDX.right); await dev.pad(PADIDX.right); await dev.pad(PADIDX.b);
    ok((await val()) === 70 && (await snd()).music === 0.7, dev.tag('V: d-pad to the Music slider, A, Right twice, B: 70%, stored in the mixer'), J({ v: await val(), s: await snd() }));
  } else {
    const r = await page.eval(`(() => { const e = document.querySelector(${J(sel)}); const b = e.getBoundingClientRect(); return { l: b.left, w: b.width, cy: b.top + b.height / 2 }; })()`);
    if (dev.family === 'mouse') await dev.clickAt(r.l + r.w * 0.4, r.cy); else await dev.tapAt(r.l + r.w * 0.4, r.cy);
    const v = await val();
    ok(v % 5 === 0 && v >= 30 && v <= 50 && (await snd()).music === v / 100, dev.tag('V: a ' + (dev.family === 'mouse' ? 'click' : 'tap') + ' at 40% of the Music slider sets a multiple of 5 near 40, stored in the mixer'), J({ v, s: await snd() }));
  }
  const music = (await snd()).music;
  // Mute, twice
  await vpress('[data-snd="mute"]'); await sleep(250);
  ok((await snd()).muted === true && (await page.eval(`document.querySelector('[data-snd="mute"]').getAttribute('aria-pressed')`)) === 'true', dev.tag('V: Mute mutes (the button says it is pressed)'), J(await snd()));
  await vpress('[data-snd="mute"]'); await sleep(250);
  ok((await snd()).muted === false && (await snd()).music === music, dev.tag('V: Mute again unmutes and the sliders kept their places'), J(await snd()));
  // the Test cry
  const before = await page.eval(`window.__arenaSound.testPlays`);
  await vpress('[data-snd="test"]'); await sleep(250);
  const after = await page.eval(`window.__arenaSound.testPlays`);
  // UPDATED DELIBERATELY: the page now TRIES to start the sound at load (mixer earlyStart), so a context may exist before any gesture; the double (pokemonarena_hub_lib.mjs AUDIO_DOUBLE) emulates the browser's
  // autoplay policy and keeps it suspended until a real user activation, which a controller is not (these runs have no real input). What must hold is that nothing STARTED: no source, no running context.
  if (dev.family === 'gamepad') ok(after === before && (await page.eval('window.__audioLog.ctor')) <= 1 && (await page.eval('window.__audioLog.start')) === 0, dev.tag('V: the Test button is reachable; with the context still suspended (a controller cannot start one) it plays nothing and breaks nothing'), J({ before, after }));
  else ok(after === before + 1 && (await page.eval('window.__audioLog.start')) >= 1, dev.tag('V: the Test button plays a cry through the mixer'), J({ before, after }));
  // the soundtrack choice: SoulGold (already selected) is pressed; Ultra Violet is only REACHED (keyboard / controller), pointers can see it
  await vpress('[data-snd="soundtrack-soulgold"]'); await sleep(150);
  ok((await snd()).soundtrack === 'soulgold', dev.tag('V: choosing SoulGold keeps SoulGold'));
  if (dev.cursorBased) {
    await dev.focusOn('[data-snd="soundtrack-ultraviolet"]');
    ok((await page.eval(`document.activeElement && document.activeElement.dataset.snd`)) === 'soundtrack-ultraviolet', dev.tag('V: the Ultra Violet choice can be reached with this device'));
  } else ok(await page.eval(`!!document.querySelector('[data-snd="soundtrack-ultraviolet"]') && document.querySelector('[data-snd="soundtrack-ultraviolet"]').getBoundingClientRect().height >= 44`), dev.tag('V: the Ultra Violet choice is on screen and at least 44 px tall'));
  await dev.shot('sound_changed');
  // close with the device's own way back
  if (dev.family === 'keyboard') await dev.key('esc'); else if (dev.family === 'gamepad') await dev.pad(PADIDX.b); else await vpress('[data-snd="close"]');
  await page.waitFor(`!${HUB}.dialogOpen()`, { timeoutMs: 8000 });
  ok(!(await panelUp()), dev.tag('V: the panel closes with this device\'s own way back and the hub has its input again'));
  // persistence
  ok(!!(await stored()) && JSON.parse(await stored()).music === music, dev.tag('V: the Music level is stored in arena.audio'), await stored());
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`);
  ok((await snd()).music === music && (await snd()).muted === false, dev.tag('V: after a reload the level is the one this device set'), J(await snd()));
  // the header button (a controller has no way to it on the canvas page: it uses the SOUND row above)
  if (dev.family !== 'gamepad') {
    await vpress('#soundBtn'); await waitFor(page, `(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden; })()`, 8000);
    ok(true, dev.tag('V: the header Sound button opens the same panel'));
    if (dev.family === 'keyboard') await dev.key('esc'); else await vpress('[data-snd="close"]');
    await page.waitFor(`!${HUB}.dialogOpen()`, { timeoutMs: 8000 });
  }
  const lg = await page.eval('window.__audioLog || {}');
  if (dev.family === 'gamepad') ok((lg.ctor || 0) <= 1 && (lg.start || 0) === 0, dev.tag('V: a controller alone started NO audio (the one context tried at load stayed suspended: a pad button is not a user activation)'), J(lg));
  else ok((lg.ctor || 0) === 1, dev.tag('V: this device\'s first key / click / tap created exactly one AudioContext'), J(lg));
}

/* ================================================================================================ journey B: build a team, save, reload, battle */
const PLAN = [
  { name: 'Pikachu', nature: 3, preset: 'zeroAtk' },
  { name: 'Charizard', nature: 10, preset: null },
  { name: 'Snorlax', nature: 23, preset: null },
].map((m) => ({ ...m, id: speciesId(m.name) }));

async function pickSpecies(dev, page, m) {
  await dev.press('[data-act="add-mon"]');
  await waitFor(page, '!!document.querySelector("[data-fk=sp-q]")', 20000);
  if (dev.family === 'mouse') {
    // no keyboard: scroll the list until the row exists, then click it
    for (let g = 0; g < 160; g++) {
      const have = await page.eval(`!!document.querySelector('.vrow[data-species="${m.id}"]')`);
      if (have && (await dev.scrollInto(`.vrow[data-species="${m.id}"]`))) break;
      const c = await dev.center('.vlist'); await moveMouse(page, c.x, c.y); await wheel(page, c.x, c.y, 300); await sleep(80);
    }
    await dev.press(`.vrow[data-species="${m.id}"]`);
  } else {
    await dev.typeInto('[data-fk="sp-q"]', m.name.toLowerCase());
    await waitFor(page, `!!document.querySelector('.vrow[data-species="${m.id}"]')`, 20000);
    await dev.press(`.vrow[data-species="${m.id}"]`);
  }
  await waitFor(page, '__editor.route().name === "mon"', 20000);
}
async function goTab(dev, page, tab) {
  await dev.press(`[data-tab="${tab}"]`);
  await waitFor(page, `__editor.route().tab === ${J(tab)}`, 8000);
}

async function resetStore(page) {
  await page.navigate(BASE_URL + '/pokemonarena/battle.html?team=none');       // the battle page's own refusal screen: same origin, never opens IndexedDB, so the database can be deleted while nothing holds it
  await page.eval(`new Promise((res) => { const r = indexedDB.deleteDatabase('pokemonarena'); r.onsuccess = r.onerror = r.onblocked = () => res(true); }).then(() => { try { localStorage.removeItem('arena.hub'); } catch (e) {} return true; })`);
}

async function journeyB(dev, page, ctx) {
  await resetStore(page);
  await page.navigate(BASE_URL + '/pokemonarena/editor.html');
  await editorReady(page);
  await gamepadWake(page, dev);
  if (dev.family === 'gamepad') {
    await page.waitFor('window.__editor && !!__editor.input', { timeoutMs: 15000 });
    ok(await dev.padTo('[data-fk="new-name"]', { rounds: 2 }), dev.tag('B: the d-pad moves focus to a control of the editor (the editor\'s navigation layer is on)'));
    await page.waitFor('!!__editor.osk', { timeoutMs: 15000 });
  }
  await noDemoWords(dev, 'the team editor');
  // ---- profile
  const wantName = dev.family === 'mouse' ? 'TRAINER' : 'ASH';
  if (dev.family !== 'mouse') await dev.typeInto('[data-fk="new-name"]', 'ASH');
  await dev.shot('editor_profile');
  await dev.press('[data-act="create"]');
  await waitFor(page, '__editor.state() && __editor.route().name === "teams"', 20000);
  ok((await page.eval('__editor.state().profile.trainerName')) === wantName, dev.tag('B: the profile was created' + (dev.family === 'mouse' ? ' with the default name (a mouse types nothing)' : ' with the typed name ' + wantName)), await page.eval('__editor.state().profile.trainerName'));
  // ---- team
  await dev.press('[data-act="new-team"]');
  await waitFor(page, '__editor.route().name === "team"', 20000);
  const teamId = await page.eval('__editor.route().teamId');
  if (dev.family !== 'mouse') {
    await dev.typeInto('[data-fk="team-name"]', 'KS');
    await page.eval('document.activeElement && document.activeElement.blur()'); await sleep(150);
  }
  const wantTeam = dev.family === 'mouse' ? await page.eval('__editor.state().profile.teams[0].name') : 'KS';
  ok((await page.eval('__editor.state().profile.teams[0].name')) === wantTeam, dev.tag('B: the team name is ' + wantTeam), await page.eval('__editor.state().profile.teams[0].name'));
  for (const m of PLAN) {
    await pickSpecies(dev, page, m);
    const monId = await page.eval('__editor.route().monId');
    const mon = () => page.eval(`JSON.parse(JSON.stringify(__editor.state().profile.box.find((x) => x.id === ${J(monId)})))`);
    ok((await mon()).species === m.id, dev.tag('B: ' + m.name + ' was added (species ' + m.id + ')'));
    // nature (a native select)
    ok(await dev.selectValue('[data-fk="nature"]', m.nature), dev.tag('B: ' + m.name + ': the nature select takes value ' + m.nature));
    await waitFor(page, `__editor.state().profile.box.find((x) => x.id === ${J(monId)}).nature === ${m.nature}`, 8000);
    // ability: an allowed slot that is not the current one
    const slot = await page.eval(`(() => { const cur = __editor.state().profile.box.find((x) => x.id === ${J(monId)}).abilitySlot; const b = [...document.querySelectorAll('[data-slot]')].find((e) => e.getAttribute('aria-disabled') !== 'true' && Number(e.dataset.slot) !== cur); return b ? Number(b.dataset.slot) : -1; })()`);
    if (slot >= 0) { await dev.press(`[data-slot="${slot}"]`); await waitFor(page, `__editor.state().profile.box.find((x) => x.id === ${J(monId)}).abilitySlot === ${slot}`, 8000); ok(true, dev.tag('B: ' + m.name + ': ability slot ' + slot + ' chosen')); }
    // held item
    await dev.press('[data-act="pick-item"]');
    await waitFor(page, '!!document.querySelector("[data-fk=it-q]")', 20000);
    const itemSel = '.pick[data-item]:not([data-item="0"]):not([aria-disabled="true"])';
    await waitFor(page, `!!document.querySelector('${itemSel}')`, 8000);
    const itemId = await page.eval(`Number(document.querySelector('${itemSel}').dataset.item)`);
    await dev.press(`.pick[data-item="${itemId}"]`);
    await waitFor(page, `__editor.state().profile.box.find((x) => x.id === ${J(monId)}).heldItem === ${itemId}`, 8000);
    ok(true, dev.tag('B: ' + m.name + ': a held item (' + itemId + ') chosen from the picker'));
    // moves 2..4
    await goTab(dev, page, 'moves');
    for (let k = 1; k <= 3; k++) {
      await dev.press(`[data-act="pick-move"][data-slot="${k}"]`);
      await waitFor(page, '!!document.querySelector(".mvrow")', 20000);
      const mv = await page.eval(`(() => { const known = new Set(__editor.state().profile.box.find((x) => x.id === ${J(monId)}).moves.map((q) => q.id)); const r = [...document.querySelectorAll('.mvrow')].find((e) => e.getAttribute('aria-disabled') !== 'true' && !known.has(Number(e.dataset.move))); return r ? Number(r.dataset.move) : -1; })()`);
      if (mv < 0) throw new Error('no available move row');
      await dev.press(`.mvrow[data-move="${mv}"]`);
      await waitFor(page, `__editor.state().profile.box.find((x) => x.id === ${J(monId)}).moves.length === ${k + 1}`, 8000);
    }
    ok((await mon()).moves.length === 4, dev.tag('B: ' + m.name + ': four moves'));
    // EVs and the IV preset
    await goTab(dev, page, 'stats');
    await waitFor(page, '!!document.querySelector("[data-fk=ev-atk]")', 15000);
    await dev.setNumber('[data-fk="ev-atk"]', '[data-fk="ev-inc-atk"]', 252);
    await sleep(250);
    ok((await mon()).ev.atk > 0, dev.tag('B: ' + m.name + ': an Attack EV value was set (' + (await mon()).ev.atk + ')'), J((await mon()).ev));
    if (m.preset) { await dev.press(`[data-preset="${m.preset}"]`); await waitFor(page, `__editor.state().profile.box.find((x) => x.id === ${J(monId)}).iv.atk === 0`, 8000); ok(true, dev.tag('B: ' + m.name + ': the IV preset "' + m.preset + '" took (Attack IV 0)')); }
    if (m === PLAN[0]) await dev.shot('editor_stats');
    // back to the team
    await page.eval(`location.hash = '#/team/${teamId}'`); await sleep(250);
  }
  const built = await page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
  ok(built.teams[0].monIds.length === 3 && profileMons(built).every((m, i) => m.species === PLAN[i].id && m.nature === PLAN[i].nature && m.moves.length === 4 && m.heldItem > 0 && m.ev.atk > 0), dev.tag('B: the team has the three Pokemon with their natures, items, four moves and EVs'), J(profileMons(built).map((m) => [m.species, m.nature, m.heldItem, m.moves.length, m.ev.atk])));
  await waitFor(page, `document.getElementById('saveText').textContent === 'Saved' && __editor.saveState === 'saved'`, 20000);
  await dev.shot('editor_team');
  // ---- reload
  await dev.reload();
  await editorReady(page);
  const after = await page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
  ok(after.trainerName === built.trainerName && after.teams[0].name === built.teams[0].name && canon(profileMons(after).map(monKey)) === canon(profileMons(built).map(monKey)), dev.tag('B: RELOAD: the profile, the team and every Pokemon come back identical from IndexedDB'));
  ctx.built = after; ctx.teamId = after.teams[0].id;
  // ---- Test battle (a link to battle.html) 3v3
  await waitFor(page, `document.querySelector('[data-team-code]') && document.querySelector('[data-team-code]').dataset.teamCode === '1'`, 15000);
  await dev.press('[data-act="test-battle"]');
  await waitFor(page, `window.${BAT} && ${BAT}.state === 'ready'`, 60000);
  const par = await page.eval(`({ team: ${BAT}.params.team, format: ${BAT}.params.format, quick: ${BAT}.params.quick, opts: ${BAT}.resultOptions })`);
  const dec = await TC.decodeTeamCode(par.team, {});
  ok(dec.ok && dec.team.mons.length === 3 && canon(dec.team.mons.map((m) => m.species)) === canon(PLAN.map((p) => p.id)) && par.format === '3v3' && par.quick === false, dev.tag('B: Test battle opens a 3v3 battle with exactly the built team'), J({ ok: dec.ok, format: par.format }));
  await page.eval(`${BAT}.pause(false)`);
  // team preview: pick the three, confirm with YES
  let s = await dev.untilMode(['preview']);
  ok(s.mode === 'preview' && s.npreview === 3 && s.pick === 3, dev.tag('B: the team preview offers three Pokemon and asks for three'), J({ n: s.npreview, pick: s.pick }));
  // (g) the S1 verifier's bug: FORFEIT from the pause menu at the preview must ask YES / NO
  await dev.openPauseMenu();
  s = await dev.menuState();
  ok(s.mode === 'menu' && s.menuRows.includes('FORFEIT'), dev.tag('B: the pause menu at the team preview offers FORFEIT'), J(s.menuRows));
  await dev.choose('overlay', s.menuRows.indexOf('FORFEIT'));
  s = await dev.menuState();
  ok(s.mode === 'confirm' && s.confirm === 'forfeit' && s.winner === null, dev.tag('B: FORFEIT at the team preview asks YES / NO first (it used to forfeit at once)'), J(s));
  await dev.shot('battle_preview_forfeit_confirm');
  await dev.choose('overlay', 1);                                                          // NO
  s = await dev.menuState();
  ok(s.mode === 'preview' && s.winner === null, dev.tag('B: NO returns to the team preview, the battle goes on'), J(s));
  for (let i = 0; i < 3; i++) await dev.choose('preview', i);
  s = await dev.menuState();
  ok(s.mode === 'confirm' && s.picks.length === 3, dev.tag('B: three picks open the "Send out this team?" confirm'), J(s));
  await dev.choose('overlay', 0);                                                          // YES
  await dev.untilMode(['action']);
  await fightTurn(dev, 'B turn 1');
  await fightTurn(dev, 'B turn 2', 1);
  await dev.openPauseMenu();
  s = await dev.menuState();
  await dev.choose('overlay', s.menuRows.indexOf('FORFEIT'));
  s = await dev.menuState();
  ok(s.mode === 'confirm' && s.confirm === 'forfeit', dev.tag('B: the pause menu FORFEIT asks YES / NO in battle too'), J(s));
  await dev.choose('overlay', 0);
  s = await dev.untilMode(['result']);
  ok(s.mode === 'result' && s.winner === 1 && s.optLabels[1] === 'EDIT TEAM', dev.tag('B: YES forfeits; the result screen offers EDIT TEAM'), J(s.optLabels));
  await dev.shot('battle_team_result');
  await dev.choose('result', 1);                                                           // EDIT TEAM
  await editorReady(page);
  await sleep(400);
  ok((await page.eval('__editor.route().name')) === 'team' && (await page.eval('__editor.route().teamId')) === ctx.teamId, dev.tag('B: EDIT TEAM opens the team builder on THE team that fought'), await page.eval('location.hash'));
}

/* ================================================================================================ journey C: import a save */
async function journeyC(dev, page, ctx) {
  await resetStore(page);
  await page.navigate(BASE_URL + '/pokemonarena/');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
  await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await gamepadWake(page, dev);
  await dev.hubChoose('import');
  await editorReady(page);
  ok((await page.eval('location.pathname + location.hash')) === '/pokemonarena/editor.html#/import' && (await page.eval('__editor.route().name')) === 'import', dev.tag('C: the hub\'s IMPORT SAVE row opens the editor on the import screen'), await page.eval('location.pathname + location.hash'));
  ok((await page.eval('document.title')) === 'Pokemon Arena - Import Save', dev.tag('C: the title is "Pokemon Arena - Import Save"'), await page.eval('document.title'));
  await dev.shot('import_idle');
  // the device activates the file input (its own way); the native chooser cannot be driven headlessly, so the file is handed over after that
  await dev.press('[data-save-file]');
  const doc = await page.send('DOM.getDocument', { depth: 1 });
  const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-save-file]' });
  if (dev.family === 'mouse') {
    // the mouse can also DROP the file on the page: try a real drag event with the file; fall back to the input when this Chrome refuses
    let dropped = false;
    try {
      const c = await dev.center('[data-dropzone]');
      await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: c.x, y: c.y, data: { items: [], files: [ctx.savePath], dragOperationsMask: 1 } });
      await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: c.x, y: c.y, data: { items: [], files: [ctx.savePath], dragOperationsMask: 1 } });
      await sleep(150);
      ok((await page.eval('document.body.dataset.dragging')) === '1', dev.tag('C: dragging a file over the page shows the "Drop your save file" cue'));
      await page.send('Input.dispatchDragEvent', { type: 'drop', x: c.x, y: c.y, data: { items: [], files: [ctx.savePath], dragOperationsMask: 1 } });
      dropped = await page.waitFor(`document.querySelector('[data-import-summary]')`, { timeoutMs: 8000 }).then(() => true, () => false);
    } catch (e) { dropped = false; console.log('  (mouse: a real drag-and-drop could not be sent in this Chrome: ' + String(e.message).slice(0, 100) + ')'); }
    ok(dropped || true, dev.tag('C: drag-and-drop of the save onto the page ' + (dropped ? 'was read' : 'could not be synthesised here; the file input path follows')));
    if (!dropped) await page.send('DOM.setFileInputFiles', { files: [ctx.savePath], nodeId: node.nodeId });
  } else await page.send('DOM.setFileInputFiles', { files: [ctx.savePath], nodeId: node.nodeId });
  await waitFor(page, `document.querySelector('[data-import-summary]')`, 30000);
  const rows = await page.eval(`[...document.querySelectorAll('.imp-row')].map((r) => ({ id: r.dataset.mon, status: r.dataset.status, species: Number(r.dataset.species), text: r.innerText.replace(/\\s+/g, ' ') }))`);
  ok(rows.length === 4 && rows.map((r) => r.species).join() === [speciesId('Sprigatito'), speciesId('Pikachu'), speciesId('Charizard'), speciesId('Snorlax')].join(), dev.tag('C: the list shows the four party Pokemon (Sprigatito, Pikachu, Charizard, Snorlax) with their ROM icons and levels'), J(rows.map((r) => r.text)));
  ok(rows.every((r) => r.status === 'legal' && /Lv \d+/.test(r.text) && /nature/.test(r.text)), dev.tag('C: each row shows level, nature and the status "Legal"'), J(rows.map((r) => r.status)));
  ok(await page.eval(`document.querySelectorAll('.imp-row canvas').length === 4`), dev.tag('C: every row carries a ROM-drawn icon'));
  await dev.shot('import_preview');
  // open the first box (its three Pokemon: two legal, one needs fixing) and read the statuses
  await dev.press('[data-group="box-0"]');
  await waitFor(page, `document.querySelectorAll('[data-group="box-0"] .imp-row').length === 3`, 8000);
  const boxRows = await page.eval(`[...document.querySelectorAll('[data-group="box-0"] .imp-row')].map((r) => ({ status: r.dataset.status, text: r.innerText.replace(/\\s+/g, ' ') }))`);
  // W1 fix D6: a fixing row says WHY in words; the rules' reason code (`moves.illegal`) is a developer's, and is only the row's hover text
  // W1 fix D6 (round 3): the Magikarp row (Hyper Beam, a move it cannot learn) says WHY in words, naming the move; no rules code and no machine word in parentheses is printed ("(not-learnable)" was).
  // (How many OTHER rows need fixing depends on the engine's coverage -- Gengar needed fixing while the engine could not run its set, and is legal now -- so that count is not pinned.)
  const fixRows = boxRows.filter((r) => r.status === 'fix');
  ok(fixRows.length >= 1 && boxRows.some((r) => r.status === 'legal') && fixRows.some((r) => /Magikarp/.test(r.text) && /Hyper Beam cannot be used/.test(r.text)) && fixRows.every((r) => r.text.length > 24 && !/\b[a-z]{2,}\.[a-z][a-z-]{2,}\b/i.test(r.text) && !/\([a-z]+(?:[-.][a-z]+)+\)/.test(r.text)), dev.tag('C: the box shows legal and "Needs fixing" rows; the Magikarp row names Hyper Beam in plain words (no rules code, no machine word in parentheses, on the screen)'), J(boxRows.map((r) => r.text).slice(0, 3)).slice(0, 400));
  await dev.shot('import_box');
  // Import (the party's four, pre-ticked)
  ok((await page.eval(`document.querySelector('[data-act="import-go"]').disabled`)) === false && /Import 4 Pokemon/.test(await page.eval(`document.querySelector('[data-act="import-go"]').textContent`)), dev.tag('C: the Import button says "Import 4 Pokemon" (the legal party, ticked for you)'));
  await dev.press('[data-act="import-go"]');
  await waitFor(page, `__editor.state() && __editor.route().name === 'team'`, 20000);
  const prof = await page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
  ok(prof.trainerName === 'Nova' && prof.teams.length === 1 && prof.teams[0].monIds.length === 4 && profileMons(prof).every((m) => m.origin === 'save-import') && !prof.box.some((m) => /^sv/.test(m.id)), dev.tag('C: Import made a profile "Nova" (the save\'s trainer) with a team of the four imported Pokemon (origin save-import, fresh ids)'), J({ n: prof.trainerName, teams: prof.teams.length }));
  await dev.shot('import_team');
  // the saved copy is what was imported, and survives a reload
  await waitFor(page, `document.getElementById('saveText').textContent === 'Saved'`, 15000);
  // hub -> BATTLE WITH MY TEAM -> START
  await dev.press('#backLink');
  await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
  await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
  await gamepadWake(page, dev);
  await waitFor(page, `${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 1`, 15000);
  await dev.hubChoose('team');
  let h = await dev.hubState();
  ok(h.path === 'team' && h.rows.find((r) => r.id === 'format').value === '6v6', dev.tag('C: BATTLE WITH MY TEAM lists the imported team on 6v6 (four Pokemon)'), J(h.rows));
  await dev.hubChoose('start');
  await waitFor(page, `window.${BAT} && ${BAT}.state === 'ready'`, 60000);
  const par = await page.eval(`({ team: ${BAT}.params.team, format: ${BAT}.params.format })`);
  const dec = await TC.decodeTeamCode(par.team, {});
  ok(dec.ok && dec.team.mons.length === 4 && dec.team.mons[0].species === speciesId('Sprigatito') && dec.team.mons[1].species === speciesId('Pikachu'), dev.tag('C: the battle address carries the imported team (Sprigatito, Pikachu, Charizard, Snorlax)'), J(dec.ok && dec.team.mons.map((m) => m.species)));
  await page.eval(`${BAT}.pause(false)`);
  const lead = await page.eval(`${BAT}.ctl.view(0).you.team[${BAT}.ctl.view(0).you.active].sp`);       // before any turn: a Lv 5 lead may faint in the first one
  await fightTurn(dev, 'C turn 1');
  ok(lead === speciesId('Sprigatito'), dev.tag('C: the imported Sprigatito (the save\'s own starter) led the battle'), String(lead));
  const fin = await forfeitByRun(dev, 'C');
  await dev.shot('import_battle_result');
  void fin;
}

/* ================================================================================================ journey S: one battle, four devices */
async function journeyS(page, tag, vpTouch) {
  void vpTouch;
  const D = { keyboard: new Dev('keyboard', page, {}), mouse: new Dev('mouse', page, {}), gamepad: new Dev('gamepad', page, {}), touch: new Dev('touch', page, {}) };
  await page.navigate(BASE_URL + '/pokemonarena/battle.html?seed=91&format=3v3');
  await waitFor(page, `window.${BAT} && ${BAT}.state === 'ready'`);
  await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
  const src = async () => page.eval(`${BAT}.input.lastSource`);
  const hint = async () => page.eval(`document.getElementById('keys').dataset.hintSource`);
  const noStuck = async (label) => { const s = await D.keyboard.menuState(); ok(s.held === 0, tag + 'S: no input is stuck after ' + label + ' (held actions: ' + s.held + ')'); };
  // phase 1: KEYBOARD picks the team at the preview
  let s = await D.keyboard.untilMode(['preview']);
  await D.keyboard.choose('preview', 0); await D.keyboard.choose('preview', 1); await D.keyboard.choose('preview', 2);
  s = await D.keyboard.menuState();
  ok(s.mode === 'confirm' && s.picks.length === 3, tag + 'S 1/keyboard: three picks and the "Send out this team?" confirm', J(s));
  await D.keyboard.choose('overlay', 0);
  ok((await src()) === 'keyboard' && (await hint()) === 'keyboard', tag + 'S 1/keyboard: the last input is the keyboard and the hint line speaks of it', (await src()) + ' ' + (await hint()));
  await noStuck('the keyboard phase');
  // phase 2: the MOUSE fights (clicks FIGHT, clicks a move)
  s = await D.mouse.untilMode(['action']);
  const t0 = s.turn;
  await D.mouse.choose('action', 0);
  s = await D.mouse.menuState();
  ok(s.mode === 'moves', tag + 'S 2/mouse: one click on FIGHT opens the move menu (no double activation)', J(s));
  ok((await src()) === 'mouse' && (await hint()) === 'mouse', tag + 'S 2/mouse: the last input is the mouse and the hint line follows it', (await src()) + ' ' + (await hint()));
  await D.mouse.choose('move', 0);
  s = await D.mouse.untilMode(['action']);
  ok(s.turn > t0, tag + 'S 2/mouse: the move was used (turn ' + t0 + ' -> ' + s.turn + ')');
  await noStuck('the mouse phase');
  // phase 3: the CONTROLLER opens the pause menu, CONTROLS, B, B, then FIGHT
  await D.gamepad.act('start');
  s = await D.gamepad.menuState();
  ok(s.mode === 'menu' && (await src()) === 'gamepad' && (await hint()) === 'gamepad', tag + 'S 3/controller: Start opens the pause menu and the input is now the controller', J(s.mode) + ' ' + (await src()));
  await D.gamepad.choose('overlay', 1);
  await page.waitFor(`${BAT}.controlsOpen === true`, { timeoutMs: 8000 });
  await D.gamepad.pad(PADIDX.b);
  await page.waitFor(`${BAT}.controlsOpen === false`, { timeoutMs: 8000 });
  await sleep(150);
  s = await D.gamepad.menuState();
  ok(s.mode === 'menu', tag + 'S 3/controller: B closed the Controls dialog and the pause menu is back', J(s));
  await D.gamepad.pad(PADIDX.b);
  s = await D.gamepad.menuState();
  ok(s.mode === 'action', tag + 'S 3/controller: B closed the pause menu: the action menu again', J(s));
  const t1 = s.turn;
  await D.gamepad.choose('action', 0); await D.gamepad.choose('move', 0);
  s = await D.gamepad.untilMode(['action']);
  ok(s.turn > t1, tag + 'S 3/controller: FIGHT with the pad used a move (turn ' + t1 + ' -> ' + s.turn + ')');
  await noStuck('the controller phase');
  // phase 4: TOUCH finishes: RUN -> YES by taps
  await D.touch.choose('action', 3);
  s = await D.touch.menuState();
  ok(s.mode === 'confirm' && (await src()) === 'touch' && (await hint()) === 'touch', tag + 'S 4/touch: a tap on RUN asks YES / NO and the input is now touch', J(s) + ' ' + (await src()));
  await D.touch.choose('overlay', 0);
  s = await D.touch.untilMode(['result']);
  ok(s.mode === 'result' && s.winner === 1, tag + 'S 4/touch: YES by tap forfeits: the result screen, the CPU wins', J(s));
  await noStuck('the touch phase');
  return s;
}

/* ================================================================================================ the runner */
async function runFamily(family, port, ctx) {
  console.log('--- ' + family + ' only ' + L.loadPct());
  const results = {};
  await newSession(family, port, async (page, dev) => {
    for (const j of JOURNEYS.filter((x) => x !== 'S')) {
      const t0 = Date.now();
      try { await ({ A: journeyA, B: journeyB, C: journeyC, D: journeyD, V: journeyV })[j](dev, page, ctx); }
      catch (e) {
        ok(false, dev.tag('journey ' + j + ' threw'), String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
        try { await Promise.race([dev.shot('FAILED_journey_' + j), sleep(8000).then(() => { throw new Error('screenshot timed out'); })]); console.log('  active element then: ' + J(await page.eval(`(() => { const a = document.activeElement; return a ? { tag: a.tagName, id: a.id, fk: a.dataset && a.dataset.fk, text: (a.textContent || '').slice(0, 30) } : null; })()`))); } catch (_e) { /* the page is gone */ }
      }
      console.log('  ' + family + ' journey ' + j + ' ' + Math.round((Date.now() - t0) / 1000) + ' s; ' + L.loadPct() + (dev.strayFight ? '; ' + dev.strayFight + ' stray FIGHT press(es) put back with B (the text ended by itself as the A for it landed)' : ''));
    }
    // the counters: ONLY this family's events reached the page
    const c = await evc(page);
    const ex = EXPECT_DEVICE[family];
    const good = (k) => (ex[k] === '>0' ? (c[k] || 0) > 0 : (c[k] || 0) === ex[k]);
    ok(good('key') && good('mouse') && good('touch'), dev.tag('the page saw ONLY this device: keydown ' + (c.key || 0) + ', mouse pointer ' + (c.mouse || 0) + ', touch pointer ' + (c.touch || 0) + ' (the last page load; wheel ' + (c.wheel || 0) + ')'), J(c));
    const errs = errsOf(page);
    ok(errs.length === 0, dev.tag('no console or page error in the whole run'), errs.slice(0, 3).join(' | '));
    const lg = await page.eval('window.__audioLog || {}').catch(() => ({}));
    // MU3: sound is ON by default now (the first key / click / tap creates the one AudioContext), so "stayed off" became: a controller alone never starts audio, and no page ever makes more than one context
    if (family === 'gamepad') ok(!lg || (lg.ctor || 0) <= 1 && (lg.start || 0) === 0, dev.tag('sound: a controller alone never starts audio (a pad button is not a user activation): at most the one context tried at load, still suspended, and nothing started'), J(lg));
    else ok(!lg || (lg.ctor || 0) <= 1, dev.tag('sound: at most one AudioContext per page (the first key / click / tap created it)'), J(lg));
    results.counters = c;
  });
  return results;
}

let server = null;
let savePath = null;
const CHILD = process.env.ARENA_CHILD === '1';
try {
  console.log('pokemonarena devices test; ROM ' + ROM_PATH + ' ' + rom.length + ' B; node ' + process.version + '; families ' + FAMILIES.join(',') + ' journeys ' + JOURNEYS.join(',') + (process.env.ARENA_TEST_BASE ? '; base ' + process.env.ARENA_TEST_BASE : ''));
  const W = await import(new URL('./pokemonarena_w1_save.mjs', import.meta.url).href);
  const sv = await W.makeArenaSave({ rom, pack });
  savePath = sv.file;
  console.log('generated save ' + savePath + ' (' + sv.bytes.length + ' B, party ' + sv.party.map((p) => p.name).join('/') + ', box ' + sv.boxed.map((p) => p.name).join('/') + ')');
  console.log('before the browser: ' + L.loadPct() + '; reaping leaked browsers');
  if (!CHILD) L.reapLeaks();
  if (!process.env.ARENA_TEST_BASE) server = await L.startServer();
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = { savePath };
  let port = Number(process.env.ARENA_CDP || 9331);
  for (const fam of FAMILIES) await runFamily(fam, port++, ctx);
  if (JOURNEYS.includes('S')) {
    await withBrowser({ port: port++, width: 1280, height: 800 }, async (page) => {
      await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
      await addInit(page, AUDIO_DOUBLE); await addInit(page, PAD_DOUBLE); await addInit(page, EVC);
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });   // touch events on a desktop-sized window
      try { await journeyS(page, 'switch: '); } catch (e) { ok(false, 'switch: the journey threw', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
      const errs = errsOf(page); ok(errs.length === 0, 'switch: no console or page error', errs.slice(0, 3).join(' | '));
    });
  }

  /* ------------------------------------------------------------------------------------------ mutants */
  if (!CHILD && process.env.ARENA_SKIP_MUTANTS !== '1' && !ARGS.has('--no-mutants')) {
    const { spawn } = await import('node:child_process');
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-devices-'));
    process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ } });
    const PA = path.join(root, 'pokemonarena');
    const MUT = [
      { id: 'D1 remove a bindPad call (the battle page\'s on-screen pad does nothing)', rel: 'js/battle_boot.js', from: "for (const b of document.querySelectorAll('[data-btn]')) input.bindPad(b, b.dataset.btn);", to: '', fam: 'touch', j: 'A', expect: 'the pause menu lists RESUME' },
      { id: 'D2 break the canvas hit test by one pixel', rel: 'js/scene.js', from: 'const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;', to: 'const inRect = (r, x, y) => x >= r.x + 1 && y >= r.y && x < r.x + r.w && y < r.y + r.h;', fam: 'mouse', j: 'A', expect: 'the first and last pixel of each action cell' },
      { id: 'D3 drop the navigation layer on the editor page', rel: 'js/editor_app.js', from: "const nav = N.enableDomNav(document.body, { input, onBack: goUp });", to: "const nav = { disable() {}, candidates: () => [] };", fam: 'gamepad', j: 'B', expect: 'the d-pad moves focus to a control of the editor' },
      { id: 'D4 re-add a demo word to the hub page', rel: 'index.html', from: '<a class="home" id="homeLink" href="/">&lsaquo; Home</a>', to: '<a class="home" id="homeLink" href="/">&lsaquo; Home (demo)</a>', fam: 'keyboard', j: 'A', expect: 'no player-visible demo wording on the hub' },
      // W1 round 3: the on-screen pad used to be re-laid out AT pointer-down when the device changed, which moved the picture under the finger: the first tap after a mouse -> touch switch missed
      { id: 'D5 re-lay out the pad at pointer-down (the picture moves under the finger)', rel: 'js/battle_boot.js', from: 'const padTo = (on) => { touchPad = on; clearTimeout(padTimer); padTimer = setTimeout(() => { padTimer = null; fit(); }, 450); };', to: 'const padTo = (on) => { touchPad = on; fit(); };', fam: 'touch', j: 'S', expect: 'S 4/touch: a tap on RUN asks YES / NO' },
    ];
    let ovPort = Number(process.env.ARENA_PORT || 8101) + 10;
    let cdp = Number(process.env.ARENA_CDP || 9331) + 10;
    // A CHILD process (never spawnSync: the overlay server lives in THIS process, and a blocked event loop would leave the child's page waiting for it forever)
    const runChild = async (dir, fam, j, label) => {
      const ov = await startOverlay({ dir, port: ovPort++, upstream: BASE });
      try {
        const env = { ...process.env, ARENA_CHILD: '1', ARENA_TEST_BASE: ov.url, ARENA_FAMILIES: fam, ARENA_JOURNEYS: j, ARENA_SKIP_MUTANTS: '1', ARENA_CDP: String(cdp++), ARENA_OUT: path.join(OUT, 'mutants') };
        const r = await new Promise((resolve) => {
          const c = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
          const timer = setTimeout(() => { try { c.kill(); } catch (_e) { /* gone */ } }, 2400000);        // generous: the child queues for the machine-wide browser lock behind other agents' runs
          c.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout: out }); });
        });
        const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));
        console.log('  ' + label + ': child exit ' + r.status + ', ' + fails.length + ' failing check(s)');
        return { fails, status: r.status, tail: (r.stdout || '').slice(-400) };
      } finally { ov.stop(); }
    };
    // the unmutated twin first: the same overlay machinery with NO defect must stay quiet (a quiet twin is what makes a tripped mutant mean something)
    const twin = copyTree(PA, path.join(TMP, 'twin'));
    const t = await runChild(twin, 'keyboard', 'A', 'unmutated twin');
    ok(t.fails.length === 0 && t.status === 0, 'mutants: the unmutated twin (an untouched copy served through the overlay) stays quiet', t.fails.slice(0, 3).join(' | ') + ' ' + t.tail.slice(-120));
    for (const m of MUT) {
      const d = copyTree(PA, path.join(TMP, m.id.split(' ')[0]));
      mutateFile(d, m.rel, m.from, m.to);
      const r = await runChild(d, m.fam, m.j, m.id);
      ok(r.fails.some((x) => x.includes(m.expect)), 'mutant "' + m.id + '" fails its named check "' + m.expect + '"', r.fails.slice(0, 3).join(' | '));
    }
  }
} finally {
  L.stopServer(server);
  if (!CHILD) L.reapLeaks();
}
void RU;
C.finish();
