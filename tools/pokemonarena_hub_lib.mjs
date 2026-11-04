// tools/pokemonarena_hub_lib.mjs -- helpers shared by the hub tests (pokemonarena_page_test.mjs, pokemonarena_hub_test.mjs,
// pokemonarena_journey_test.mjs): a pass/fail counter, the Range-capable dev server, the AudioContext and Gamepad test doubles, and the
// small CDP gestures (tap / click / key on a canvas by LOGICAL pixel). TEST-ONLY. Pure ASCII.
//
// Ports: server 8097, CDP 9291-9299 (this stage's allocation); ARENA_PORT / ARENA_CDP / ARENA_BASE override.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
export const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
export const PORT = Number(process.env.ARENA_PORT || 8097);
export const CDP0 = Number(process.env.ARENA_CDP || 9291);
export const BASE = process.env.ARENA_BASE || `http://127.0.0.1:${PORT}`;
export const DEFAULT_OUT = path.join(os.tmpdir(), 'arena-hub-shots');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mod = (n) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', n)).href);
export const J = (x) => JSON.stringify(x);

export function makeCounter(label) {
  const c = { pass: 0, fail: 0, failures: [], label };
  c.ok = (cond, name, detail) => {
    if (cond) { c.pass++; if (process.env.ARENA_VERBOSE) console.log('  ok  ', name); return true; }
    c.fail++; const d = detail === undefined ? '' : String(detail).slice(0, 300);
    c.failures.push(name + (d ? ' :: ' + d : '')); console.log('FAIL', name, d ? ':: ' + d : ''); return false;
  };
  c.finish = () => {
    console.log('\n' + (c.fail ? 'FAILED' : 'OK') + ': ' + c.pass + ' passed, ' + c.fail + ' failed' + (label ? ' (' + label + ')' : ''));
    if (c.fail) { console.log(c.failures.join('\n')); process.exitCode = 1; }
  };
  return c;
}

export function loadPct() {
  try { const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8' }); return (r.stdout || '').trim() + '% cpu'; } catch (_e) { return '?'; }
}

// the Range-capable dev server (npm run web is `node tools/devserver.mjs`); null when ARENA_BASE points at a running one
export async function startServer(probe = '/pokemonarena/') {
  if (process.env.ARENA_BASE) return null;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + probe); if (r.ok) return child; } catch (_e) { /* not up yet */ }
    await sleep(250);
  }
  child.kill(); throw new Error('dev server did not come up on ' + PORT);
}
export function stopServer(child) {
  if (!child) return;
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch (_e) { /* gone */ }
}
export function reapLeaks() { spawnSync(process.execPath, [path.join(root, 'tools', 'browser_leak_guard.js'), 'reap'], { stdio: 'inherit', cwd: root }); }

/* ------------------------------------------------------------------------------- test doubles (installed before any page script runs) */
// An AudioContext that can never reach a device: it counts what the page asks of it. window.__audioLog is the log.
// IT EMULATES THE BROWSER'S AUTOPLAY POLICY (the pages now try to start the sound at load): a context stays 'suspended' until the page has had a user activation (navigator.userActivation.hasBeenActive,
// true after any real CDP input) unless window.__autoplayAllowed is true (?autoplay=1 in the address: the site may autoplay). The old double resumed at once, which no real visitor's browser does.
export const AUDIO_DOUBLE = `(() => {
  const log = { ctor: 0, createBuffer: 0, createBufferSource: 0, start: 0, resume: 0, gain: 0, rates: [] };
  window.__audioLog = log; window.__autoplayAllowed = /[?&]autoplay=1/.test(location.search);
  class FakeCtx {
    constructor() { log.ctor++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { log.resume++; const nav = navigator, active = !!(nav.userActivation && nav.userActivation.hasBeenActive); if (!window.__autoplayAllowed && !active) { log.blocked = (log.blocked || 0) + 1; return Promise.resolve(); } this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    createBuffer(ch, len, rate) { log.createBuffer++; log.rates.push(rate); const d = new Float32Array(len); return { duration: len / rate, getChannelData: () => d }; }
    createBufferSource() { log.createBufferSource++; return { buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() { log.start++; }, stop() {}, onended: null }; }
    createGain() { log.gain++; return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  }
  window.AudioContext = FakeCtx; window.webkitAudioContext = FakeCtx;
})();`;
// A SYNTHETIC controller (no physical pad exists on this machine): navigator.getGamepads() reads window.__pad, which the test sets.
export const PAD_DOUBLE = `(() => {
  window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v })) }];
})();`;
export const addInit = (page, src) => page.send('Page.addScriptToEvaluateOnNewDocument', { source: src });

/* ------------------------------------------------------------------------------- gestures */
export const KEYS = {
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  a: ['Enter', 'Enter', 13], z: ['z', 'KeyZ', 90], b: ['Backspace', 'Backspace', 8], esc: ['Escape', 'Escape', 27], x: ['x', 'KeyX', 88], start: ['p', 'KeyP', 80],
};
export const key = (page, k, hold = 30) => page.press(KEYS[k][0], KEYS[k][1], KEYS[k][2], hold);

/** Page coordinates of a LOGICAL (240x160) point on a canvas, border excluded. */
export async function logicalToPage(page, canvasExpr, lx, ly) {
  const r = await page.eval(`(() => { const c = ${canvasExpr}, b = c.getBoundingClientRect(), cs = getComputedStyle(c); const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth); return { x: b.left + bl, y: b.top + bt, w: b.width - 2 * bl, h: b.height - 2 * bt }; })()`);
  return { x: r.x + (lx / 240) * r.w, y: r.y + (ly / 160) * r.h };
}
export async function tapLogical(page, canvasExpr, lx, ly) { const p = await logicalToPage(page, canvasExpr, lx, ly); await page.tap(p.x, p.y); return p; }
export async function clickLogical(page, canvasExpr, lx, ly) { const p = await logicalToPage(page, canvasExpr, lx, ly); await page.click(p.x, p.y); return p; }
export async function moveMouse(page, x, y) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
export async function rightClick(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}
export async function wheel(page, x, y, deltaY) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }); }
export async function padPress(page, idx, hold = 130) { await page.eval(`window.__pad.buttons[${idx}] = 1`); await sleep(hold); await page.eval(`window.__pad.buttons[${idx}] = 0`); await sleep(hold); }
export async function elementCentre(page, sel) {
  return page.eval(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
}
export async function tapSel(page, sel) { const c = await elementCentre(page, sel); if (!c) throw new Error('no element ' + sel); await page.tap(c.x, c.y); return c; }
export async function clickSel(page, sel) { const c = await elementCentre(page, sel); if (!c) throw new Error('no element ' + sel); await page.click(c.x, c.y); return c; }
export const errsOf = (page) => page.errors.concat(page.console.filter((m) => m.type === 'error').map((m) => 'console.error: ' + m.text));

export function fnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); }
export function readRom() { const b = fs.readFileSync(ROM_PATH); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
