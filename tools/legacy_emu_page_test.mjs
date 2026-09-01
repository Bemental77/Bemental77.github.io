#!/usr/bin/env node
// Standing gate for the three OLDER emulator pages: ps1.html, gba.html, snes.html.
// They had no headless coverage at all (n64 has tools/n64_page_test.mjs, GC/DC have
// their probes), which is how the failures below shipped and stayed shipped.
//
// EVERY ARM ASSERTS ON A MEASURED VALUE, not on a property being present:
//   * boot        — canvas pixels are actually non-black and multi-coloured
//   * guest rate  — frames the EMULATED machine advanced per wall second, over a
//                   real window, compared to the console's true hardware rate.
//                   Speeding a game up is a BUG here, not a feature: see the
//                   product definition in CLAUDE.md gate #9. PS1 is measured from
//                   the SPU byte rate (stereo s16 @44100 = 176400 B/s at 1.000x),
//                   which is a clock the page cannot fake; GBA and SNES are
//                   measured from the emulator's own frame counter.
//   * input       — the button state is read back from where the CORE reads it
//                   (PS1: KeyStatus at _get_ptr(1)+6/+7; SNES: the mask handed to
//                   _setJoypadInput; GBA: InputController flags), so a control
//                   that looks wired but delivers nothing still fails.
//
// REGRESSIONS THIS PINS (all measured 2026-09-01, all were live):
//   ps1/desktop-keyboard  Emscripten SDL1 binds keydown to
//       Module.keyboardListeningElement, which ps1.html sets to the <canvas>. A
//       <canvas> with no tabindex can never take focus, so no real keypress ever
//       targeted it: every desktop key read [255,255] (nothing pressed). Clicking
//       the canvas did not help — activeElement stayed BODY.
//   ps1/desktop-gamepad   updatePadState() bailed with `if (!isMobile) return`,
//       so the gamepad poller wrote padState and nothing ever copied it into
//       KeyStatus on desktop.
//   gba/android-landscape detectMobile() used `innerWidth < 600 || ua~iphone`, so
//       an Android phone turned sideways (915x412) got mobileMode=false, the SP
//       shell hidden and #mobileA at zero width — no touch controls at all.
//   gba/landscape-reachable  the 50vh/50vh clamshell overflowed in landscape and
//       rendered the B button below the viewport.
//   snes/*                 there was no snes.html at all.
//
// USAGE   npm run web    # required: http://localhost:8080
//         node tools/legacy_emu_page_test.mjs            # every arm
//         node tools/legacy_emu_page_test.mjs ps1 snes   # named pages only
// Serialize against other browser harnesses on a shared box, and read the load
// note it prints — a rate measured above ~load 25 is not interpretable.
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const WINDOW_S = +(process.env.WINDOW_S || 8);
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// Hardware frame rates. These are the denominators for every "x hardware" number.
const HW = { ps1: 176400 /* SPU bytes/s */, gba: 59.7275, snes: 60.0988 };
// A rate this far from 1.000x is called out. Wide enough to survive a loaded box,
// narrow enough that a 2x fast-forward (the failure gate #9 exists for) trips it.
const RATE_LO = 0.90, RATE_HI = 1.10;

const results = [];
const rec = (arm, name, ok, detail) => { results.push({ arm, name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

async function launch(view) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, 'legacy_emu_page_test'); } catch (_e) {}
  const page = await browser.newPage();
  if (view) {
    await page.setViewport({ width: view.w, height: view.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setUserAgent(view.ua);
  }
  const errs = [], fails = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('requestfailed', (r) => fails.push(r.url().slice(-70) + ' :: ' + (r.failure()?.errorText || '?')));
  page.on('response', (r) => { if (r.status() >= 400) fails.push('HTTP' + r.status() + ' ' + r.url().slice(-70)); });
  return { browser, page, errs, fails };
}

// evaluate that survives the coi-serviceworker's first-visit reload
async function ev(page, fn, arg) {
  for (let i = 0; i < 40; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      if (!/main frame too early|Execution context|detached|destroyed/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error('evaluate never settled');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function canvasLive(page) {
  return ev(page, () => {
    const c = document.getElementById('canvas'); if (!c) return null;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nb = 0; const s = new Set();
    for (let i = 0; i < d.length; i += 4 * 31) { if (d[i] | d[i + 1] | d[i + 2]) nb++; s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
    const r = c.getBoundingClientRect();
    return { nonBlack: nb, distinct: s.size, w: Math.round(r.width), h: Math.round(r.height),
             onScreen: r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 };
  });
}
async function tapAt(page, cdp, id) {
  const b = await ev(page, (i) => { const e = document.getElementById(i); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, id);
  if (!b) return false;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
  return true;
}
const untap = (cdp) => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

// ── PS1 ─────────────────────────────────────────────────────────────────────
async function ps1(view, label) {
  const arm = 'ps1/' + label;
  console.log('\n== ' + arm + ' ==');
  const { browser, page, errs, fails } = await launch(view);
  try {
    // ?lazy keeps the probe light. The DEFAULT path writes the whole disc image
    // into worker MEMFS (wasmpsx_worker.js romChunk -> FS.write), which for these
    // 350-750 MB titles is a large resident allocation; that is a separate
    // finding, not something this arm is trying to measure.
    await page.goto(ORIGIN + '/ps1.html?lazy', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let stable = 0;
    for (let i = 0; i < 45 && stable < 2; i++) {
      await sleep(1000);
      const ok = await ev(page, () => window.crossOriginIsolated === true && document.readyState === 'complete').catch(() => false);
      stable = ok ? stable + 1 : 0;
    }
    if (view) {
      const cdp0 = await page.target().createCDPSession();
      await tapAt(page, cdp0, 'mobileSplashStart'); await untap(cdp0);
    } else {
      await ev(page, () => document.getElementById('btnStart').click());
    }
    await page.waitForFunction(() => !!window.pcsx_worker, { timeout: 90000 });
    await ev(page, () => {
      window.__spu = 0;
      window.pcsx_worker.addEventListener('message', (e) => { if (e.data.cmd === 'SoundFeedStreamData') window.__spu += e.data.lBytes; });
    });
    for (let i = 0; i < 90; i++) {
      const s = await ev(page, () => (document.getElementById('status') || {}).textContent);
      if (/Running/.test(s || '')) break;
      await sleep(1000);
    }
    await sleep(8000);

    const a = await ev(page, () => ({ v: window.__spu, t: performance.now() }));
    await sleep(WINDOW_S * 1000);
    const b = await ev(page, () => ({ v: window.__spu, t: performance.now() }));
    const bps = (b.v - a.v) / ((b.t - a.t) / 1000);
    const x = bps / HW.ps1;
    rec(arm, 'guest-rate', x >= RATE_LO && x <= RATE_HI, `${bps.toFixed(0)} SPU B/s = ${x.toFixed(4)}x hardware (1.000x required)`);

    const live = await canvasLive(page);
    rec(arm, 'renders', !!live && live.nonBlack > 0 && live.distinct > 4 && live.onScreen, JSON.stringify(live));

    const pad = () => ev(page, () => { const p = Module._get_ptr(1); return [Module.HEAPU8[p + 6], Module.HEAPU8[p + 7]]; });
    const pressed = (v) => v[0] !== 255 || v[1] !== 255;
    if (view) {
      const cdp = await page.target().createCDPSession();
      for (const id of ['mobileCross', 'mobileStart']) {
        const got = await tapAt(page, cdp, id);
        await sleep(250);
        const held = got ? await pad() : [255, 255];
        await untap(cdp); await sleep(250);
        const rel = await pad();
        rec(arm, 'touch/' + id, got && pressed(held) && !pressed(rel), `held=${JSON.stringify(held)} rel=${JSON.stringify(rel)}`);
      }
    } else {
      await page.keyboard.down('v'); await sleep(400);
      const kh = await pad();
      await page.keyboard.up('v'); await sleep(400);
      const kr = await pad();
      rec(arm, 'keyboard/Start(v)', pressed(kh) && !pressed(kr), `held=${JSON.stringify(kh)} rel=${JSON.stringify(kr)}`);

      const gp = await ev(page, async () => {
        const fake = { id: 'HarnessPad', index: 0, mapping: 'standard', connected: true, timestamp: 1,
          buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), axes: [0, 0, 0, 0] };
        navigator.getGamepads = () => [fake];
        fake.buttons[0].pressed = true; await new Promise((r) => setTimeout(r, 500));
        const p = Module._get_ptr(1);
        const held = [Module.HEAPU8[p + 6], Module.HEAPU8[p + 7]];
        fake.buttons[0].pressed = false; await new Promise((r) => setTimeout(r, 500));
        return { held, rel: [Module.HEAPU8[p + 6], Module.HEAPU8[p + 7]] };
      });
      rec(arm, 'gamepad/Cross(btn0)', pressed(gp.held) && !pressed(gp.rel), `held=${JSON.stringify(gp.held)} rel=${JSON.stringify(gp.rel)}`);
    }
    rec(arm, 'no-page-errors', errs.length === 0, errs.length ? errs.join(' | ') : 'none');
    rec(arm, 'no-failed-requests', fails.length === 0, fails.length ? fails.join(' | ') : 'none');
  } finally { await browser.close(); }
}

// ── GBA ─────────────────────────────────────────────────────────────────────
async function gba(view, label, romIdx = 4) {
  const arm = 'gba/' + label;
  console.log('\n== ' + arm + ' ==');
  const { browser, page, errs, fails } = await launch(view);
  try {
    await page.goto(ORIGIN + '/gba.html', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => window.myApp && window.myApp.isWasmReady, { timeout: 60000 });
    await ev(page, (i) => { document.getElementById('romselect').value = window.ROMLIST[i].url; }, romIdx);
    await ev(page, () => myClass.loadRom());
    await page.waitForFunction(() => window.myApp && window.myApp.isRunning, { timeout: 60000 });
    await sleep(3000);

    const mobileMode = await ev(page, () => myApp.mobileMode);
    if (view) rec(arm, 'touch-shell-active', mobileMode === true && (await ev(page, () => getComputedStyle(document.getElementById('spShell')).display)) === 'flex',
      `mobileMode=${mobileMode} innerWidth=${await ev(page, () => innerWidth)}`);

    const a = await ev(page, () => ({ f: myApp.frameCnt, t: performance.now() }));
    await sleep(WINDOW_S * 1000);
    const b = await ev(page, () => ({ f: myApp.frameCnt, t: performance.now() }));
    const fps = (b.f - a.f) / ((b.t - a.t) / 1000);
    const x = fps / HW.gba;
    rec(arm, 'guest-rate', x >= RATE_LO && x <= RATE_HI, `${fps.toFixed(3)} fps = ${x.toFixed(4)}x hardware (1.000x required)`);
    rec(arm, 'speed-knob-is-1x', (await ev(page, () => myApp.gameSpeed)) === 1, 'the fast-forward slider must default to 1x');

    const live = await canvasLive(page);
    rec(arm, 'renders', !!live && live.nonBlack > 0 && live.distinct > 4 && live.onScreen, JSON.stringify(live));

    if (view) {
      const cdp = await page.target().createCDPSession();
      // mobileL is the arm that caught an overlay eating the shoulder row.
      for (const [id, flag] of [['mobileA', 'Key_Action_A'], ['mobileStart', 'Key_Action_Start'], ['mobileL', 'Key_Action_L']]) {
        const got = await tapAt(page, cdp, id);
        await sleep(200);
        const held = got ? await ev(page, (f) => myApp.rivetsData.inputController[f], flag) : false;
        await untap(cdp); await sleep(200);
        const rel = await ev(page, (f) => myApp.rivetsData.inputController[f], flag);
        rec(arm, 'touch/' + id, got && held === true && rel === false, `reachable=${got} held=${held} rel=${rel}`);
      }
      const dOk = await ev(page, () => {
        const e = document.getElementById('spDpadV'); const r = e.getBoundingClientRect();
        return r.width > 0 && r.bottom <= innerHeight + 1 && r.top >= -1;
      });
      const bOk = await ev(page, () => {
        const e = document.getElementById('mobileB'); const r = e.getBoundingClientRect();
        return r.width > 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
      });
      rec(arm, 'controls-inside-viewport', dOk && bOk, `dpad=${dOk} B=${bOk} (B was rendered off-screen in landscape)`);
    }
    rec(arm, 'no-page-errors', errs.length === 0, errs.length ? errs.join(' | ') : 'none');
    rec(arm, 'no-failed-requests', fails.length === 0, fails.length ? fails.join(' | ') : 'none');
  } finally { await browser.close(); }
}

// ── SNES ────────────────────────────────────────────────────────────────────
async function snes(view, label) {
  const arm = 'snes/' + label;
  console.log('\n== ' + arm + ' ==');
  const { browser, page, errs, fails } = await launch(view);
  try {
    await page.goto(ORIGIN + '/snes.html', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => {
      const d = document.getElementById('btnStart'), m = document.getElementById('mobileSplashStart');
      return (d && !d.disabled) || (m && !m.disabled);
    }, { timeout: 60000 });
    if (view) {
      const cdp0 = await page.target().createCDPSession();
      await tapAt(page, cdp0, 'mobileSplashStart'); await untap(cdp0);
    } else {
      await ev(page, () => document.getElementById('btnStart').click());
    }
    await page.waitForFunction(() => window.__snesFrames > 30, { timeout: 60000 });
    await sleep(2500);
    // observe exactly what the core is told, not what the page thinks it set
    await ev(page, () => {
      const orig = Module._setJoypadInput;
      window.__mask = 0;
      Module._setJoypadInput = function (m) { window.__mask = m; return orig.call(Module, m); };
    });

    const a = await ev(page, () => ({ f: window.__snesFrames, t: performance.now() }));
    await sleep(WINDOW_S * 1000);
    const b = await ev(page, () => ({ f: window.__snesFrames, t: performance.now() }));
    const fps = (b.f - a.f) / ((b.t - a.t) / 1000);
    const x = fps / HW.snes;
    // The upstream demo drives mainLoop() once per rAF, which makes the guest run
    // at the DISPLAY rate — 2.00x on a 120 Hz panel. This arm is what keeps
    // snes.html on its own fixed-timestep clock instead.
    rec(arm, 'guest-rate', x >= RATE_LO && x <= RATE_HI, `${fps.toFixed(3)} fps = ${x.toFixed(4)}x hardware (1.000x required)`);

    const live = await canvasLive(page);
    rec(arm, 'renders', !!live && live.nonBlack > 0 && live.distinct > 4 && live.onScreen, JSON.stringify(live));

    if (view) {
      const cdp = await page.target().createCDPSession();
      for (const [id, bit] of [['mobileA', 7], ['mobileB', 15], ['mobileStart', 12], ['mobileL', 5]]) {
        const got = await tapAt(page, cdp, id);
        await sleep(220);
        const held = got ? await ev(page, () => window.__mask) : 0;
        await untap(cdp); await sleep(220);
        const rel = await ev(page, () => window.__mask);
        rec(arm, 'touch/' + id, got && !!((held >> bit) & 1) && !((rel >> bit) & 1), `held=0x${held.toString(16)} rel=0x${rel.toString(16)} bit=${bit}`);
      }
    } else {
      for (const [key, bit, name] of [['Enter', 12, 'Start'], ['a', 7, 'A'], ['z', 15, 'B'], ['ArrowUp', 11, 'Up']]) {
        await page.keyboard.down(key); await sleep(220);
        const held = await ev(page, () => window.__mask);
        await page.keyboard.up(key); await sleep(220);
        const rel = await ev(page, () => window.__mask);
        rec(arm, 'keyboard/' + name, !!((held >> bit) & 1) && !((rel >> bit) & 1), `held=0x${held.toString(16)} rel=0x${rel.toString(16)}`);
      }
      const st = await ev(page, () => {
        const size = Module._getStateSaveSize();
        const p = Module._saveState(); if (!p) return { ok: false, size };
        const copy = new Uint8Array(new Uint8Array(Module.HEAPU8.buffer, p, size));
        Module._my_free(p);
        const p2 = Module._my_malloc(copy.length); Module.HEAPU8.set(copy, p2);
        const ok = Module._loadState(p2, copy.length); Module._my_free(p2);
        return { ok: !!ok, size };
      });
      rec(arm, 'savestate-roundtrip', st.ok, `${st.size} bytes, loadState=${st.ok}`);
    }
    rec(arm, 'no-page-errors', errs.length === 0, errs.length ? errs.join(' | ') : 'none');
    rec(arm, 'no-failed-requests', fails.length === 0, fails.length ? fails.join(' | ') : 'none');
  } finally { await browser.close(); }
}

// ── run ─────────────────────────────────────────────────────────────────────
const LAND_IOS = { w: 844, h: 390, ua: IPHONE };
const PORT_IOS = { w: 390, h: 844, ua: IPHONE };
const LAND_AND = { w: 915, h: 412, ua: ANDROID };

let load = 'unknown';
try { load = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (_e) {}
console.log('[legacy-emu] ' + load);
console.log('[legacy-emu] a guest-rate number taken above ~load 25 is not interpretable — see CLAUDE.md gate #10\n');

const run = (n) => want.length === 0 || want.includes(n);
if (run('gba')) { await gba(null, 'desktop'); await gba(PORT_IOS, 'ios-portrait'); await gba(LAND_IOS, 'ios-landscape'); await gba(LAND_AND, 'android-landscape'); }
if (run('snes')) { await snes(null, 'desktop'); await snes(LAND_IOS, 'ios-landscape'); }
if (run('ps1')) { await ps1(null, 'desktop'); await ps1(LAND_IOS, 'ios-landscape'); }

const bad = results.filter((r) => !r.ok);
console.log(`\n[legacy-emu] ${results.length - bad.length}/${results.length} passed`);
for (const b of bad) console.log(`  FAIL ${b.arm} :: ${b.name} :: ${b.detail}`);
process.exit(bad.length ? 1 : 0);
