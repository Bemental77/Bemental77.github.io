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
// EVERY ARM ASSERTS ON A MEASURED VALUE — a control's real bounding box after a
// real drag, localStorage's real contents, and the input flag the CORE reads.
//
// USAGE  npm run web    # required: http://localhost:8080
//        node tools/gba_mobile_controls_test.mjs
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:8080';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const results = [];
const ok = (arm, name, detail) => { results.push({ arm, name, detail, ok: true }); console.log(`  PASS  ${name}  ${detail}`); };
const bad = (arm, name, detail) => { results.push({ arm, name, detail, ok: false }); console.log(`  FAIL  ${name}  ${detail}`); };

async function run(view, label) {
  const arm = 'gba/' + label;
  console.log(`\n== ${arm} ==`);
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = (await browser.pages())[0];
    await page.setUserAgent(view.ua);
    await page.setViewport({ width: view.w, height: view.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 140)));
    await page.goto(ORIGIN + '/gba.html', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => window.myApp && window.myApp.isWasmReady === true, { timeout: 60000 });
    const url = await page.evaluate(() => window.ROMLIST[4].url);      // Kirby
    await page.evaluate(u => { document.getElementById('romselect').value = u; window.myClass.loadRom(); }, url);
    await page.waitForFunction(() => window.myApp.isRunning === true, { timeout: 60000 });
    await new Promise(r => setTimeout(r, 1200));

    const shell = await page.evaluate(() => ({
      mobileMode: window.myApp.mobileMode,
      shellShown: getComputedStyle(document.getElementById('spShell')).display,
    }));
    shell.mobileMode && shell.shellShown !== 'none'
      ? ok(arm, 'mobile-shell-active', `mobileMode=${shell.mobileMode} display=${shell.shellShown}`)
      : bad(arm, 'mobile-shell-active', JSON.stringify(shell));

    // ── 1. the fullscreen entry exists IN THE MOBILE MENU and targets the SHELL
    const fs = await page.evaluate(() => {
      const btn = document.getElementById('spFullBtn');
      if (!btn) return { present: false };
      const inMenu = !!btn.closest('#spMenuOverlay');
      // what would it fullscreen? patch the two candidates and call it.
      let target = null;
      const shellEl = document.getElementById('spShell');
      const canvasEl = document.getElementById('canvas');
      const spy = (el, name) => { el.requestFullscreen = () => { target = name; return Promise.resolve(); }; };
      spy(shellEl, 'spShell'); spy(canvasEl, 'canvas');
      window.spToggleFullscreen();
      return { present: true, inMenu, target, label: btn.textContent.trim() };
    });
    fs.present && fs.inMenu ? ok(arm, 'fullscreen-in-mobile-menu', `label="${fs.label}"`)
                            : bad(arm, 'fullscreen-in-mobile-menu', JSON.stringify(fs));
    fs.target === 'spShell'
      ? ok(arm, 'fullscreen-targets-shell', 'spShell — controls stay visible (canvas would hide them)')
      : bad(arm, 'fullscreen-targets-shell', `targeted ${fs.target}`);

    // ── 2. a browser with NO Element.requestFullscreen must not throw (iPhone)
    const guard = await page.evaluate(() => {
      const el = document.getElementById('spShell');
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
    const before = await page.evaluate(() => document.getElementById('spDpad').getBoundingClientRect().toJSON());
    await page.evaluate(() => window.spEnterEditMode());
    const editing = await page.evaluate(() => ({
      flag: window.spEditMode,
      bar: !!document.getElementById('spEditBar'),
      outlined: document.getElementById('spDpad').classList.contains('sp-draggable'),
    }));
    editing.flag && editing.bar && editing.outlined
      ? ok(arm, 'edit-mode-arms', JSON.stringify(editing))
      : bad(arm, 'edit-mode-arms', JSON.stringify(editing));

    // while editing, touching a control must NOT press it
    await page.evaluate(() => { myApp.rivetsData.inputController.Key_Action_A = false; });
    const abBox = await page.evaluate(() => document.getElementById('mobileA').getBoundingClientRect().toJSON());
    await page.touchscreen.tap(Math.round(abBox.x + abBox.width / 2), Math.round(abBox.y + abBox.height / 2));
    const pressedWhileEditing = await page.evaluate(() => myApp.rivetsData.inputController.Key_Action_A);
    pressedWhileEditing === false
      ? ok(arm, 'edit-mode-suppresses-input', 'tapping A while editing did not press A')
      : bad(arm, 'edit-mode-suppresses-input', `Key_Action_A=${pressedWhileEditing}`);

    const tx = Math.round(view.w * 0.72), ty = Math.round(view.h * 0.42);
    await page.mouse.move(Math.round(before.x + before.width / 2), Math.round(before.y + before.height / 2));
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.getElementById('spDpad').getBoundingClientRect().toJSON());
    const moved = Math.hypot((after.x + after.width / 2) - (before.x + before.width / 2),
                             (after.y + after.height / 2) - (before.y + before.height / 2));
    moved > 20 ? ok(arm, 'control-drags', `d-pad centre moved ${moved.toFixed(0)}px`)
               : bad(arm, 'control-drags', `moved only ${moved.toFixed(0)}px`);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gbawasm_ctrlpos_v1') || 'null'));
    const orient = view.w > view.h ? 'landscape' : 'portrait';
    stored && stored[orient] && stored[orient].spDpad
      ? ok(arm, 'position-persists', `${orient}.spDpad = ${JSON.stringify(stored[orient].spDpad)}`)
      : bad(arm, 'position-persists', JSON.stringify(stored));

    await page.evaluate(() => window.spExitEditMode());
    const exited = await page.evaluate(() => ({ flag: window.spEditMode, bar: !!document.getElementById('spEditBar') }));
    (!exited.flag && !exited.bar) ? ok(arm, 'edit-mode-exits', 'bar removed, flag cleared')
                                  : bad(arm, 'edit-mode-exits', JSON.stringify(exited));

    // input works again after leaving edit mode
    await page.evaluate(() => { myApp.rivetsData.inputController.Key_Action_A = false; });
    const ab2 = await page.evaluate(() => document.getElementById('mobileA').getBoundingClientRect().toJSON());
    await page.touchscreen.touchStart(Math.round(ab2.x + ab2.width / 2), Math.round(ab2.y + ab2.height / 2));
    const pressedAfter = await page.evaluate(() => myApp.rivetsData.inputController.Key_Action_A);
    await page.touchscreen.touchEnd();
    pressedAfter === true ? ok(arm, 'input-restored-after-edit', 'A presses again')
                          : bad(arm, 'input-restored-after-edit', `Key_Action_A=${pressedAfter}`);

    // ── 4. the position SURVIVES A RELOAD
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.myApp && window.myApp.isWasmReady === true, { timeout: 60000 });
    await page.evaluate(u => { document.getElementById('romselect').value = u; window.myClass.loadRom(); }, url);
    await page.waitForFunction(() => window.myApp.isRunning === true, { timeout: 60000 });
    await new Promise(r => setTimeout(r, 1200));
    const reapplied = await page.evaluate(() => {
      const el = document.getElementById('spDpad');
      const r = el.getBoundingClientRect();
      return { left: el.style.left, top: el.style.top, pos: el.style.position, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    Math.abs(reapplied.cx - tx) < 12 && Math.abs(reapplied.cy - ty) < 12
      ? ok(arm, 'position-survives-reload', `restored to ${reapplied.left},${reapplied.top} (${reapplied.pos})`)
      : bad(arm, 'position-survives-reload', JSON.stringify(reapplied) + ` want ~${tx},${ty}`);

    // control is still reachable and still presses after being moved
    await page.evaluate(() => { myApp.rivetsData.inputController.Key_Up = false; });
    const dp = await page.evaluate(() => document.getElementById('spDpadV').getBoundingClientRect().toJSON());
    await page.touchscreen.touchStart(Math.round(dp.x + dp.width / 2), Math.round(dp.y + dp.height * 0.2));
    const upPressed = await page.evaluate(() => myApp.rivetsData.inputController.Key_Up);
    await page.touchscreen.touchEnd();
    upPressed === true ? ok(arm, 'moved-control-still-works', 'd-pad Up presses at its new position')
                       : bad(arm, 'moved-control-still-works', `Key_Up=${upPressed}`);

    // ── 5. reset
    await page.evaluate(() => window.spResetCtrlPositions());
    const afterReset = await page.evaluate(() => ({
      stored: JSON.parse(localStorage.getItem('gbawasm_ctrlpos_v1') || '{}'),
      pos: document.getElementById('spDpad').style.position || '(none)',
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
    await page.evaluate(() => { try { toastr.clear(); } catch (e) {} });
    await new Promise(r => setTimeout(r, 150));
    // fx/fy are fractional: the d-pad is a cross whose two bars legitimately
    // overlap at the dead centre, so Up is sampled near the top of the vertical
    // bar, the way the legacy gate presses it and the way a thumb does.
    const hits = await page.evaluate(() => {
      const spec = [['mobileStart', .5, .5], ['mobileSelect', .5, .5], ['mobileA', .5, .5], ['mobileB', .5, .5],
                    ['mobileL', .5, .5], ['mobileR', .5, .5], ['spDpadV', .5, .15], ['spDpadH', .15, .5],
                    ['spMenuBtn', .5, .5], ['spSpeedSlider', .5, .5]];
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
    const mb = await page.evaluate(() => document.getElementById('spMenuBtn').getBoundingClientRect().toJSON());
    await page.touchscreen.tap(Math.round(mb.x + mb.width / 2), Math.round(mb.y + mb.height / 2));
    await new Promise(r => setTimeout(r, 250));
    const menuOpened = await page.evaluate(() => document.getElementById('spMenuOverlay').classList.contains('open'));
    menuOpened ? ok(arm, 'menu-opens-on-tap', 'Save/Load/Fullscreen/Move Controls are reachable')
               : bad(arm, 'menu-opens-on-tap', 'tapping the menu button opened nothing');
    await page.evaluate(() => window.spCloseMenu());

    errs.length === 0 ? ok(arm, 'no-page-errors', 'none') : bad(arm, 'no-page-errors', errs.join(' | '));
  } finally { await browser.close(); }
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
await run({ w: 390, h: 844, ua: IPHONE }, 'ios-portrait');
await run({ w: 844, h: 390, ua: IPHONE }, 'ios-landscape');
await run({ w: 915, h: 412, ua: ANDROID }, 'android-landscape');
const failed = results.filter(r => !r.ok);
console.log(`\n[gba-mobile] ${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAIL ${f.arm} :: ${f.name} :: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
