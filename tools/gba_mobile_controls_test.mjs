#!/usr/bin/env node
// Gate for the GBA mobile shell's FULLSCREEN entry and MOVABLE TOUCH CONTROLS.
//
// WHY IT EXISTS: reported by the owner — "not seeing gba fullscreen mode on
// mobile, we should be able to adjust the position of the controls on the mobile
// screen also." Both were true of the shipped page:
//   * the only fullscreen control lived in #topPanel (gba.html:538), which
//     _setupMobileMode hides, so a phone had no way to reach it; and
//   * myApp.fullscreen() (script.js:753-754) targets #canvas, whose subtree
//     excludes every touch control — succeeding would have hidden the controls.
//   * control positions were fixed CSS with no stored state of any kind.
//
// It also pins three CONTROL-OVERLAP bugs found while building the above and
// confirmed present at HEAD (ios-landscape 844x390, elementFromPoint at each
// control's own centre):
//     mobileStart   -> mobileSelect     Start could not be pressed
//     spSpeedSlider -> mobileSelect     the speed slider could not be grabbed
//     spMenuBtn     -> .sp-shoulders    and tapping it opened NOTHING
//                                       (menuOpens=false), so Save State, Load
//                                       State and New Rom were all unreachable
//                                       on a phone held sideways.
// Causes, in order: .sp-sys-btn is 15px tall and the shared 44px touch-target
// ::after (gba.html:500-503) is CENTRED, so Select's invisible target covered
// Start's centre and won on document order; and .sp-menu-row sat at top:-26px
// inside .sp-inner, which is inset:30px with overflow:hidden, so it was clipped
// out of existence entirely.
//
// 2026-11-01 (stage GP, gba.html on the site's page standard): SELECTORS ONLY changed here — #spShell -> #mobileShell, #spDpad ->
// #mobileDpadDisc (stored layouts keyed `spDpad` are still read), #spMenuBtn -> #mobileMenuBtn, #spMenuOverlay -> #mobileMenu,
// #spFullBtn -> #mFull, #romselect -> #romSelect / #mobileRomSelect, the toastr.clear() -> hiding #toast. The speed control left the
// controls surface (it was #spSpeedSlider) for the touch menu (#mSpeed), so its hit-test entry became two new arms:
// 'speed-control-in-menu' and 'speed-control-steps'. Nothing else moved.
//
// EVERY ARM ASSERTS ON A MEASURED VALUE — a control's real bounding box after a
// real drag, localStorage's real contents, and the input flag the CORE reads.
//
// 2026-11-01 (stage G3, solo play moved to mGBA): PORTED FROM puppeteer TO tools/headless_cdp.mjs. What changed and why:
//   * puppeteer launched a macOS Chrome path and offered no --mute-audio; the rule for this repo is headless Chrome over bare CDP
//     through the shared helper (throwaway profile, one browser at a time machine-wide, --mute-audio so a test browser never
//     reaches the user's headphones). The touch, mouse and viewport gestures below are the SAME gestures as before, sent as raw
//     CDP Input.* events through the small adapters at the top of this file.
//   * ROMLIST[4] was Kirby when this was written; the list has grown (index 4 is Super Bust-A-Move now), so the ROM is chosen by
//     title (ROM_TITLE, default 'Kirby'). No arm asserts anything about the core, so the 44vba -> mGBA switch changes no verdict.
//   * networkidle2 waits became "load event + the page's own isWasmReady flag".
// Every ARM below is unchanged: same measurement, same threshold.
//
// NEGATIVE CONTROL: MUTANT=cover drops a transparent fixed element over the centre of #mobileA once the game runs (an overlap bug of the
// class this gate exists for). The run MUST then exit 1 - 'no-control-is-overlapped' and 'input-restored-after-edit' fail - and the
// unmutated twin must PASS.
//
// USAGE  PORT=8092 node tools/devserver.mjs     # required for the default origin (PORT defaults to 8080 here)
//        node tools/gba_mobile_controls_test.mjs
//        ORIGIN=https://caseybement.com node tools/gba_mobile_controls_test.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
const CDP_PORT = Number(process.env.CDP_PORT || 9255);
const ROM_TITLE = process.env.ROM_TITLE || 'Kirby';
const MUTANT = process.env.MUTANT || '';
// ORIGIN override so the same arms can be run against the DEPLOYED page, not
// just localhost — a gate that can only see the dev server cannot tell you
// whether what shipped works.
const ORIGIN = process.env.ORIGIN || ('http://localhost:' + (process.env.PORT || 8080));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const results = [];
const ok = (arm, name, detail) => { results.push({ arm, name, detail, ok: true }); console.log(`  PASS  ${name}  ${detail}`); };
const bad = (arm, name, detail) => { results.push({ arm, name, detail, ok: false }); console.log(`  FAIL  ${name}  ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thin puppeteer-shaped adapters over the CDP helper. A function passed to evalIn is serialised and run IN the page, so it must not
// close over test variables: hand them in through `arg`.
const evalIn = (page, fn, arg) => page.eval('(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')');
const waitFn = (page, fn, timeoutMs = 60000) => page.waitFor('(' + fn.toString() + ')()', { timeoutMs });
const touch = {
  start: (page, x, y) => page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
  end: (page) => page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
  async tap(page, x, y) { await touch.start(page, x, y); await touch.end(page); },
};
const mouse = {
  x: 0, y: 0, held: false,
  async move(page, x, y, steps = 1) {
    const x0 = mouse.x, y0 = mouse.y;
    for (let i = 1; i <= steps; i++) {
      mouse.x = x0 + (x - x0) * i / steps; mouse.y = y0 + (y - y0) * i / steps;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y, button: mouse.held ? 'left' : 'none', buttons: mouse.held ? 1 : 0 });
    }
  },
  async down(page) { mouse.held = true; await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button: 'left', buttons: 1, clickCount: 1 }); },
  async up(page) { mouse.held = false; await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', buttons: 0, clickCount: 1 }); },
};

async function boot(page, label) {
  await page.navigate(ORIGIN + '/gba.html');
  await waitFn(page, () => window.myApp && window.myApp.isWasmReady === true);
  const url = await evalIn(page, (t) => { const r = window.ROMLIST.find((x) => x.title.includes(t)); return r ? r.url : null; }, ROM_TITLE);
  if (!url) throw new Error('no ROMLIST entry matches ROM_TITLE=' + ROM_TITLE);
  await evalIn(page, (u) => { document.getElementById(window.myApp.mobileMode ? 'mobileRomSelect' : 'romSelect').value = u; window.myClass.loadRom(); return true; }, url);
  await waitFn(page, () => window.myApp.isRunning === true);
  await sleep(1200);
  return url;
}

async function run(view, label) {
  const arm = 'gba/' + label;
  console.log(`\n== ${arm} ==`);
  await withBrowser({ port: CDP_PORT, width: view.w, height: view.h, mobile: true }, async (page) => {
    await page.send('Emulation.setUserAgentOverride', { userAgent: view.ua });
    await page.setViewport(view.w, view.h, { mobile: true, dpr: 2 });
    mouse.x = 0; mouse.y = 0; mouse.held = false;
    await boot(page, label);
    // The page is RELOADED mid-run (arm 4), which would wipe an injected element, so the mutant is (re)applied after every boot.
    const applyMutant = async () => {
      if (MUTANT !== 'cover') return;
      await evalIn(page, () => { const a = document.getElementById('mobileA').getBoundingClientRect(); const d = document.createElement('div'); d.id = 'mutantCover'; d.style.cssText = 'position:fixed;z-index:99999;background:transparent;left:' + (a.x + a.width / 2 - 20) + 'px;top:' + (a.y + a.height / 2 - 20) + 'px;width:40px;height:40px'; document.body.appendChild(d); return true; });
      console.log('  [MUTANT cover] a 40x40 element now sits over the centre of #mobileA');
    };
    await applyMutant();

    const shell = await evalIn(page, () => ({
      mobileMode: window.myApp.mobileMode,
      shellShown: getComputedStyle(document.getElementById('mobileShell')).display,
    }));
    shell.mobileMode && shell.shellShown !== 'none'
      ? ok(arm, 'mobile-shell-active', `mobileMode=${shell.mobileMode} display=${shell.shellShown}`)
      : bad(arm, 'mobile-shell-active', JSON.stringify(shell));

    // ── 1. the fullscreen entry exists IN THE MOBILE MENU and targets the SHELL
    const fs = await evalIn(page, () => {
      const btn = document.getElementById('mFull');
      if (!btn) return { present: false };
      const inMenu = !!btn.closest('#mobileMenu');
      // what would it fullscreen? patch the two candidates and call it.
      let target = null;
      const shellEl = document.getElementById('mobileShell');
      const canvasEl = document.getElementById('canvas');
      const spy = (el, name) => { el.requestFullscreen = () => { target = name; return Promise.resolve(); }; };
      spy(shellEl, 'mobileShell'); spy(canvasEl, 'canvas');
      window.spToggleFullscreen();
      return { present: true, inMenu, target, label: btn.textContent.trim() };
    });
    fs.present && fs.inMenu ? ok(arm, 'fullscreen-in-mobile-menu', `label="${fs.label}"`)
                            : bad(arm, 'fullscreen-in-mobile-menu', JSON.stringify(fs));
    fs.target === 'mobileShell'
      ? ok(arm, 'fullscreen-targets-shell', 'mobileShell — controls stay visible (canvas would hide them)')
      : bad(arm, 'fullscreen-targets-shell', `targeted ${fs.target}`);

    // ── 2. a browser with NO Element.requestFullscreen must not throw (iPhone)
    const guard = await evalIn(page, () => {
      const el = document.getElementById('mobileShell');
      const saved = [el.requestFullscreen, el.webkitRequestFullscreen, el.webkitRequestFullScreen];
      el.requestFullscreen = el.webkitRequestFullscreen = el.webkitRequestFullScreen = undefined;
      let threw = null;
      try { window.spToggleFullscreen(); } catch (e) { threw = String(e); }
      [el.requestFullscreen, el.webkitRequestFullscreen, el.webkitRequestFullScreen] = saved;
      return threw;
    });
    guard === null ? ok(arm, 'no-fullscreen-api-does-not-throw', 'iPhone Safari path is handled')
                   : bad(arm, 'no-fullscreen-api-does-not-throw', guard);

    // ── 3. DRAG a control and assert its box actually moved
    const before = await evalIn(page, () => document.getElementById('mobileDpadDisc').getBoundingClientRect().toJSON());
    await evalIn(page, () => window.spEnterEditMode());
    const editing = await evalIn(page, () => ({
      flag: window.spEditMode,
      bar: !!document.getElementById('spEditBar'),
      outlined: document.getElementById('mobileDpadDisc').classList.contains('sp-draggable'),
    }));
    editing.flag && editing.bar && editing.outlined
      ? ok(arm, 'edit-mode-arms', JSON.stringify(editing))
      : bad(arm, 'edit-mode-arms', JSON.stringify(editing));

    // while editing, touching a control must NOT press it
    await evalIn(page, () => { myApp.rivetsData.inputController.Key_Action_A = false; });
    const abBox = await evalIn(page, () => document.getElementById('mobileA').getBoundingClientRect().toJSON());
    await touch.tap(page, Math.round(abBox.x + abBox.width / 2), Math.round(abBox.y + abBox.height / 2));
    const pressedWhileEditing = await evalIn(page, () => myApp.rivetsData.inputController.Key_Action_A);
    pressedWhileEditing === false
      ? ok(arm, 'edit-mode-suppresses-input', 'tapping A while editing did not press A')
      : bad(arm, 'edit-mode-suppresses-input', `Key_Action_A=${pressedWhileEditing}`);

    const tx = Math.round(view.w * 0.72), ty = Math.round(view.h * 0.42);
    await mouse.move(page, Math.round(before.x + before.width / 2), Math.round(before.y + before.height / 2));
    await mouse.down(page);
    await mouse.move(page, tx, ty, 12);
    await mouse.up(page);
    const after = await evalIn(page, () => document.getElementById('mobileDpadDisc').getBoundingClientRect().toJSON());
    const moved = Math.hypot((after.x + after.width / 2) - (before.x + before.width / 2),
                             (after.y + after.height / 2) - (before.y + before.height / 2));
    moved > 20 ? ok(arm, 'control-drags', `d-pad centre moved ${moved.toFixed(0)}px`)
               : bad(arm, 'control-drags', `moved only ${moved.toFixed(0)}px`);

    const stored = await evalIn(page, () => JSON.parse(localStorage.getItem('gbawasm_ctrlpos_v1') || 'null'));
    const orient = view.w > view.h ? 'landscape' : 'portrait';
    stored && stored[orient] && stored[orient].mobileDpadDisc
      ? ok(arm, 'position-persists', `${orient}.mobileDpadDisc = ${JSON.stringify(stored[orient].mobileDpadDisc)}`)
      : bad(arm, 'position-persists', JSON.stringify(stored));

    await evalIn(page, () => window.spExitEditMode());
    const exited = await evalIn(page, () => ({ flag: window.spEditMode, bar: !!document.getElementById('spEditBar') }));
    (!exited.flag && !exited.bar) ? ok(arm, 'edit-mode-exits', 'bar removed, flag cleared')
                                  : bad(arm, 'edit-mode-exits', JSON.stringify(exited));

    // input works again after leaving edit mode
    await evalIn(page, () => { myApp.rivetsData.inputController.Key_Action_A = false; });
    const ab2 = await evalIn(page, () => document.getElementById('mobileA').getBoundingClientRect().toJSON());
    await touch.start(page, Math.round(ab2.x + ab2.width / 2), Math.round(ab2.y + ab2.height / 2));
    const pressedAfter = await evalIn(page, () => myApp.rivetsData.inputController.Key_Action_A);
    await touch.end(page);
    pressedAfter === true ? ok(arm, 'input-restored-after-edit', 'A presses again')
                          : bad(arm, 'input-restored-after-edit', `Key_Action_A=${pressedAfter}`);

    // ── 4. the position SURVIVES A RELOAD
    const url = await boot(page, label);
    await applyMutant();
    const reapplied = await evalIn(page, () => {
      const el = document.getElementById('mobileDpadDisc');
      const r = el.getBoundingClientRect();
      return { left: el.style.left, top: el.style.top, pos: el.style.position, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    Math.abs(reapplied.cx - tx) < 12 && Math.abs(reapplied.cy - ty) < 12
      ? ok(arm, 'position-survives-reload', `restored to ${reapplied.left},${reapplied.top} (${reapplied.pos})`)
      : bad(arm, 'position-survives-reload', JSON.stringify(reapplied) + ` want ~${tx},${ty}`);

    // control is still reachable and still presses after being moved
    await evalIn(page, () => { myApp.rivetsData.inputController.Key_Up = false; });
    const dp = await evalIn(page, () => document.getElementById('spDpadV').getBoundingClientRect().toJSON());
    await touch.start(page, Math.round(dp.x + dp.width / 2), Math.round(dp.y + dp.height * 0.2));
    const upPressed = await evalIn(page, () => myApp.rivetsData.inputController.Key_Up);
    await touch.end(page);
    upPressed === true ? ok(arm, 'moved-control-still-works', 'd-pad Up presses at its new position')
                       : bad(arm, 'moved-control-still-works', `Key_Up=${upPressed}`);

    // ── 5. reset
    await evalIn(page, () => window.spResetCtrlPositions());
    const afterReset = await evalIn(page, () => ({
      stored: JSON.parse(localStorage.getItem('gbawasm_ctrlpos_v1') || '{}'),
      pos: document.getElementById('mobileDpadDisc').style.position || '(none)',
    }));
    const o = view.w > view.h ? 'landscape' : 'portrait';
    (!afterReset.stored[o] && afterReset.pos === '(none)')
      ? ok(arm, 'reset-restores-default', 'stored entry cleared and inline position removed')
      : bad(arm, 'reset-restores-default', JSON.stringify(afterReset));

    // ── 6. EVERY control must receive a tap at the point a thumb actually lands.
    // Dismiss any notification first: the reset step above raises one, and a gate
    // must measure the PAGE rather than its own side-effect. (That the toast covered
    // #mobileR at all is a real defect and is fixed in the landscape CSS — this only
    // stops the harness from re-reporting its own toast as that bug.)
    await evalIn(page, () => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; });
    await sleep(150);
    // fx/fy are fractional: the d-pad is a cross whose two bars legitimately
    // overlap at the dead centre, so Up is sampled near the top of the vertical
    // bar, the way the legacy gate presses it and the way a thumb does.
    const hits = await evalIn(page, () => {
      const spec = [['mobileStart', .5, .5], ['mobileSelect', .5, .5], ['mobileA', .5, .5], ['mobileB', .5, .5],
                    ['mobileL', .5, .5], ['mobileR', .5, .5], ['spDpadV', .5, .15], ['spDpadH', .15, .5],
                    ['mobileMenuBtn', .5, .5]];
      return spec.map(([id, fx, fy]) => {
        const el = document.getElementById(id);
        if (!el) return { id, self: false, got: 'MISSING' };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.x + r.width * fx), Math.round(r.y + r.height * fy));
        return { id, self: !!(hit && (hit === el || el.contains(hit) || hit.contains(el))), got: hit ? (hit.id || hit.className) : null };
      });
    });
    const stolen = hits.filter(h => !h.self);
    stolen.length === 0
      ? ok(arm, 'no-control-is-overlapped', `${hits.length} controls, each hit-tests to itself`)
      : bad(arm, 'no-control-is-overlapped', stolen.map(h => `${h.id} -> ${h.got}`).join(', '));

    // the menu button must not merely be hit-testable — it must OPEN the menu
    const mb = await evalIn(page, () => document.getElementById('mobileMenuBtn').getBoundingClientRect().toJSON());
    await touch.tap(page, Math.round(mb.x + mb.width / 2), Math.round(mb.y + mb.height / 2));
    await sleep(250);
    const menuOpened = await evalIn(page, () => document.getElementById('mobileMenu').classList.contains('open'));
    menuOpened ? ok(arm, 'menu-opens-on-tap', 'Save/Load/Fullscreen/Move Controls are reachable')
               : bad(arm, 'menu-opens-on-tap', 'tapping the menu button opened nothing');
    // stage GP: the speed control moved OFF the controls surface (it was #spSpeedSlider, between Select and the menu button, and its
    // hit area overlapped Select's) INTO the touch menu, where the other pages keep their solo extras. It must be reachable there
    // and must still move only the solo guest.
    const speed = await evalIn(page, () => {
      const b = document.getElementById('mSpeed');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      return { present: true, inMenu: !!b.closest('#mobileMenu'), self: hit === b, disabled: b.disabled, oldSliderGone: !document.getElementById('spSpeedSlider'),
               cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    });
    speed.present && speed.inMenu && speed.self && !speed.disabled && speed.oldSliderGone
      ? ok(arm, 'speed-control-in-menu', 'Speed lives in #mobileMenu, is hit-testable there, and the old slider is gone from the controls')
      : bad(arm, 'speed-control-in-menu', JSON.stringify(speed));
    if (speed.present) {
      await touch.tap(page, speed.cx, speed.cy);
      await sleep(150);
      const sp2 = await evalIn(page, () => { const g = window.myApp.gameSpeed, t = document.getElementById('mSpeed').textContent; window.myApp.setGameSpeed(1); return { g, t, back: window.myApp.gameSpeed }; });
      sp2.g === 2 && sp2.back === 1 && /2x/.test(sp2.t) ? ok(arm, 'speed-control-steps', `tap -> ${sp2.t}`) : bad(arm, 'speed-control-steps', JSON.stringify(sp2));
    }
    await evalIn(page, () => window.spCloseMenu());

    const errs = page.errors.map((e) => String(e).slice(0, 140));
    errs.length === 0 ? ok(arm, 'no-page-errors', 'none') : bad(arm, 'no-page-errors', errs.join(' | '));
  });
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
await run({ w: 390, h: 844, ua: IPHONE }, 'ios-portrait');
await run({ w: 844, h: 390, ua: IPHONE }, 'ios-landscape');
await run({ w: 915, h: 412, ua: ANDROID }, 'android-landscape');
const failed = results.filter(r => !r.ok);
console.log(`\n[gba-mobile] ${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAIL ${f.arm} :: ${f.name} :: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
