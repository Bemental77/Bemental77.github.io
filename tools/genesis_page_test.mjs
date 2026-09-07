#!/usr/bin/env node
// Standing gate for genesis.html (Genesis-Plus-GX -> genesis/genesisWasm/dist).
// Modelled on tools/legacy_emu_page_test.mjs, which covers ps1/gba/snes; this is
// the same shape for the Mega Drive page, with two extra arms the older pages do
// not have (canvas display aspect, and per-control hit-testing).
//
// EVERY ARM ASSERTS ON A MEASURED VALUE, not on a property being present:
//   * boot        — canvas pixels are actually non-black and multi-coloured, for
//                   BOTH shipped ROMs, sampled from the 2D context after ~8 s.
//   * guest rate  — frames the EMULATED machine advanced per wall second, over a
//                   real window, against the Mega Drive's true NTSC rate. The
//                   denominator is not a folklore "60": Genesis-Plus-GX computes
//                   system_clock / lines_per_frame / MCYCLES_PER_LINE
//                   (libretro/libretro.c:3167) = 53693175 / 262 / 3420 =
//                   59.922751 Hz, and the page reads that same number out of the
//                   core via gpx_fps(). Speeding a game up is a BUG here, not a
//                   feature — CLAUDE.md gate #9.
//   * input       — read back from where the CORE reads it: the page calls
//                   Module._gpx_set_pad(0, mask) once per emulated frame and the
//                   shim stores that mask for input_state_cb, so this hooks
//                   _gpx_set_pad and asserts on the bit. A control that looks
//                   wired but delivers nothing still fails.
//   * aspect      — the canvas's DISPLAYED width/height, not its backing store.
//                   A Mega Drive frame is 320x224 = 1.4286 in memory and 4:3 =
//                   1.3333 on screen; `width:auto` alone resolves from the
//                   BACKING STORE and ships a 7%-too-wide picture. That trap was
//                   found on six pages on 2026-09-05.
//   * hit-test    — document.elementFromPoint at EACH control's own centre must
//                   return that control (or a descendant). The 44px minimum hit
//                   area is applied as a centred ::after, and on gba.html two of
//                   them 6px apart meant the later sibling swallowed the
//                   earlier's centre: the button was visible, correctly sized,
//                   and unpressable.
//
// USAGE   npm run web    # required: http://localhost:8080
//         node tools/genesis_page_test.mjs
//         node tools/genesis_page_test.mjs --rom=1        # one ROM only
// Serialize against other browser harnesses on a shared box, and read the load
// note it prints — a rate measured above ~load 25 is not interpretable
// (CLAUDE.md gate #10).
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const WINDOW_S = +(process.env.WINDOW_S || 8);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

// NTSC Mega Drive: 53693175 / 262 / 3420. See the header note.
const HW_HZ = 59.922751;
const RATE_LO = 0.90, RATE_HI = 1.10;
// 320x224 backing store, 4:3 display. 1% either way covers sub-pixel rounding of
// a ~540px-wide box; a missing aspect-ratio rule reads 1.4286, which is 7% out.
const ASPECT = 4 / 3, ASPECT_TOL = 0.01;

const romArg = process.argv.find((a) => a.startsWith('--rom='));
const ROM_IDXS = romArg ? [Number(romArg.split('=')[1])] : [0, 1];
const ROM_LABELS = ['Sonic the Hedgehog 3', 'X-Men'];

const results = [];
const rec = (arm, name, ok, detail) => { results.push({ arm, name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(view) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, 'genesis_page_test'); } catch (_e) {}
  const page = await browser.newPage();
  if (view) {
    // view.desktop = a plain resized DESKTOP window: no touch, no mobile UA. It
    // exists for the narrow-window canvas-fit arm, which is a LAYOUT case the
    // phone arms cannot reach (they run the mobile shell, a different element).
    await page.setViewport({ width: view.w, height: view.h, isMobile: !view.desktop, hasTouch: !view.desktop, deviceScaleFactor: view.desktop ? 1 : 2 });
    if (view.ua) await page.setUserAgent(view.ua);
  }
  const errs = [], fails = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('requestfailed', (r) => fails.push(r.url().slice(-70) + ' :: ' + (r.failure()?.errorText || '?')));
  page.on('response', (r) => { if (r.status() >= 400) fails.push('HTTP' + r.status() + ' ' + r.url().slice(-70)); });
  return { browser, page, errs, fails };
}

async function canvasLive(page) {
  return page.evaluate(() => {
    const c = document.getElementById('canvas'); if (!c) return null;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nb = 0; const s = new Set();
    for (let i = 0; i < d.length; i += 4 * 31) { if (d[i] | d[i + 1] | d[i + 2]) nb++; s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
    const r = c.getBoundingClientRect();
    return { nonBlack: nb, distinct: s.size, fbW: c.width, fbH: c.height,
             w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(4),
             onScreen: r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 };
  });
}

async function tapAt(page, cdp, id) {
  const b = await page.evaluate((i) => { const e = document.getElementById(i); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, id);
  if (!b) return false;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
  return true;
}
const untap = (cdp) => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

// The page writes the pad mask into the core once per emulated frame. Hooking
// the export is what makes this test assert on what the CORE was told, rather
// than on the page's own idea of its state.
async function hookPad(page) {
  await page.evaluate(() => {
    if (window.__padHooked) return;
    const orig = Module._gpx_set_pad;
    window.__mask = 0;
    Module._gpx_set_pad = function (port, m) { if (port === 0) window.__mask = m; return orig.call(Module, port, m); };
    window.__padHooked = true;
  });
}

// mobile = runs the touch shell. A resized desktop window is `view` but not
// mobile, and must take the desktop start path.
const isPhone = (view) => !!(view && !view.desktop);

async function boot(page, romIdx, view) {
  await page.goto(ORIGIN + '/genesis.html', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction(() => {
    const d = document.getElementById('btnStart'), m = document.getElementById('mobileSplashStart');
    return (d && !d.disabled) || (m && !m.disabled);
  }, { timeout: 60000 });
  if (isPhone(view)) {
    await page.evaluate((i) => { document.getElementById('mobileRomSelect').value = String(i); }, romIdx);
    const cdp0 = await page.target().createCDPSession();
    await tapAt(page, cdp0, 'mobileSplashStart'); await untap(cdp0);
  } else {
    await page.evaluate((i) => {
      document.getElementById('romSelect').value = String(i);
      document.getElementById('btnStart').click();
    }, romIdx);
  }
  await page.waitForFunction(() => window.__genFrames > 30, { timeout: 60000 });
  await sleep(2500);
}

async function arm(view, label, romIdx) {
  const armName = 'genesis/' + label + '/' + ROM_LABELS[romIdx];
  console.log('\n== ' + armName + ' ==');
  const { browser, page, errs, fails } = await launch(view);
  try {
    await boot(page, romIdx, view);
    await hookPad(page);

    // ── guest rate ────────────────────────────────────────────────────────
    const a = await page.evaluate(() => ({ f: window.__genFrames, t: performance.now() }));
    await sleep(WINDOW_S * 1000);
    const b = await page.evaluate(() => ({ f: window.__genFrames, t: performance.now() }));
    const fps = (b.f - a.f) / ((b.t - a.t) / 1000);
    const x = fps / HW_HZ;
    rec(armName, 'guest-rate', x >= RATE_LO && x <= RATE_HI,
        `${fps.toFixed(3)} fps = ${x.toFixed(4)}x hardware (1.000x required; NTSC MD = ${HW_HZ} Hz)`);

    // The core's OWN reported rate is the denominator the page uses, so a
    // region misdetection (PAL = 49.7 Hz) would otherwise read as a clean
    // 1.000x while the game ran a sixth too slow.
    const coreFps = await page.evaluate(() => Module._gpx_fps());
    rec(armName, 'core-reports-ntsc', Math.abs(coreFps - HW_HZ) < 0.01, `gpx_fps()=${coreFps.toFixed(6)}`);

    // ── renders ───────────────────────────────────────────────────────────
    const live = await canvasLive(page);
    rec(armName, 'renders', !!live && live.nonBlack > 0 && live.distinct > 4 && live.onScreen, JSON.stringify(live));

    // ── canvas display aspect ─────────────────────────────────────────────
    rec(armName, 'display-aspect-4:3', !!live && Math.abs(live.ratio - ASPECT) <= ASPECT_TOL,
        `displayed ${live && live.w}x${live && live.h} = ${live && live.ratio} (want ${ASPECT.toFixed(4)}); backing store ${live && live.fbW}x${live && live.fbH} = ${live ? (live.fbW / live.fbH).toFixed(4) : '?'} — width:auto ALONE would give the backing-store number`);

    // ── audio is actually being produced ──────────────────────────────────
    // The ring only fills from retro_run's audio_batch_cb, so a non-zero
    // reading proves the core's sound path ran, not merely that a context
    // exists. Headless Chrome may never drain it, so this asserts production.
    const aud = await page.evaluate(() => Module._gpx_audio_avail());
    rec(armName, 'audio-produced', aud > 0, `${aud} stereo frames queued (44100 Hz)`);

    // ── PORTRAIT IS DELIBERATELY NOT PLAYABLE ─────────────────────────────
    // #rotateHint is a full-screen overlay this page raises while a game is
    // running on a portrait phone (genesis.html checkOrientation), the same
    // pattern snes.html and ps1.html use: the shell mounts its controls on the
    // left and right EDGES, which at 390 CSS px leaves the picture ~110 px wide.
    // So on a portrait arm the controls are unreachable ON PURPOSE, and the
    // honest assertion is that the block is there and explains itself — not that
    // a button under a deliberate overlay can be pressed. The touch and
    // hit-test arms therefore run only when the hint is down. The ASPECT arm
    // still runs: the canvas must already be the right shape behind the hint,
    // because the hint disappears the instant the device is rotated.
    const rot = isPhone(view) ? await page.evaluate(() => {
      const e = document.getElementById('rotateHint');
      const up = e && getComputedStyle(e).display !== 'none';
      const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return { up: !!up, covers: !!(up && e && (mid === e || e.contains(mid))), text: (e && e.textContent || '').trim().slice(0, 60) };
    }) : { up: false, covers: false, text: '' };
    const portrait = isPhone(view) ? view.h > view.w : false;
    if (portrait) {
      rec(armName, 'portrait-blocks-play-with-a-rotate-prompt', rot.up && rot.covers,
          `rotateHint up=${rot.up} covers-centre=${rot.covers} "${rot.text}"`);
    } else if (isPhone(view)) {
      rec(armName, 'landscape-has-no-rotate-overlay', !rot.up, `rotateHint up=${rot.up}`);
    }

    if (isPhone(view) && !rot.up) {
      // ── touch: every control delivers to the core ───────────────────────
      const cdp = await page.target().createCDPSession();
      // BIT positions are libretro RETRO_DEVICE_ID_JOYPAD ids; the MD button each
      // one drives is in genesis.html's BIT table, read off the core's own
      // osd_input_update_internal_bitmasks().
      for (const [id, bit] of [['mobileA', 1], ['mobileB', 0], ['mobileC', 8],
                               ['mobileX', 10], ['mobileY', 9], ['mobileZ', 11],
                               ['mobileStart', 3], ['mobileMode', 2]]) {
        const got = await tapAt(page, cdp, id);
        await sleep(220);
        const held = got ? await page.evaluate(() => window.__mask) : 0;
        await untap(cdp); await sleep(220);
        const rel = await page.evaluate(() => window.__mask);
        rec(armName, 'touch/' + id, got && !!((held >> bit) & 1) && !((rel >> bit) & 1),
            `reachable=${got} held=0x${held.toString(16)} rel=0x${rel.toString(16)} bit=${bit}`);
      }

      // ── hit-test: no control's 44px target swallows another's centre ────
      const hits = await page.evaluate(() => {
        const ids = ['mobileA', 'mobileB', 'mobileC', 'mobileX', 'mobileY', 'mobileZ',
                     'mobileStart', 'mobileMode', 'mobileMenuBtn', 'mobileDpadDisc'];
        return ids.map((id) => {
          const e = document.getElementById(id);
          if (!e) return { id, ok: false, why: 'missing' };
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height) return { id, ok: false, why: 'zero-size' };
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const ok = !!hit && (hit === e || e.contains(hit));
          return { id, ok, why: ok ? '' : 'hit=' + (hit ? (hit.id || hit.className || hit.tagName) : 'null'),
                   box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        });
      });
      const badHits = hits.filter((h) => !h.ok);
      rec(armName, 'controls-hit-test-to-themselves', badHits.length === 0,
          badHits.length ? JSON.stringify(badHits) : `${hits.length}/${hits.length} controls own their own centre`);

      // ── and every control is inside the viewport ────────────────────────
      const inside = await page.evaluate(() => {
        const ids = ['mobileA', 'mobileB', 'mobileC', 'mobileX', 'mobileY', 'mobileZ',
                     'mobileStart', 'mobileMode', 'mobileMenuBtn', 'mobileDpadDisc'];
        return ids.filter((id) => {
          const e = document.getElementById(id); if (!e) return true;
          const r = e.getBoundingClientRect();
          return !(r.width > 0 && r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1);
        });
      });
      rec(armName, 'controls-inside-viewport', inside.length === 0,
          inside.length ? 'off-screen: ' + inside.join(',') : 'all 10 controls fully on screen');
    } else if (!isPhone(view)) {
      // ── keyboard ────────────────────────────────────────────────────────
      for (const [key, bit, name] of [['Enter', 3, 'Start'], ['a', 1, 'A'], ['s', 0, 'B'],
                                      ['d', 8, 'C'], ['q', 10, 'X'], ['ArrowUp', 4, 'Up']]) {
        await page.keyboard.down(key); await sleep(220);
        const held = await page.evaluate(() => window.__mask);
        await page.keyboard.up(key); await sleep(220);
        const rel = await page.evaluate(() => window.__mask);
        rec(armName, 'keyboard/' + name, !!((held >> bit) & 1) && !((rel >> bit) & 1),
            `held=0x${held.toString(16)} rel=0x${rel.toString(16)} bit=${bit}`);
      }

      // ── gamepad ─────────────────────────────────────────────────────────
      const gp = await page.evaluate(async () => {
        const fake = { id: 'HarnessPad', index: 0, mapping: 'standard', connected: true, timestamp: 1,
          buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })), axes: [0, 0, 0, 0] };
        navigator.getGamepads = () => [fake];
        fake.buttons[0].pressed = true; await new Promise((r) => setTimeout(r, 500));
        const held = window.__mask;
        fake.buttons[0].pressed = false; await new Promise((r) => setTimeout(r, 500));
        return { held, rel: window.__mask };
      });
      rec(armName, 'gamepad/B(btn0)', !!((gp.held >> 0) & 1) && !((gp.rel >> 0) & 1),
          `held=0x${gp.held.toString(16)} rel=0x${gp.rel.toString(16)}`);

      // ── save state round-trip, through the core ─────────────────────────
      const st = await page.evaluate(() => {
        const size = Module._gpx_state_size();
        if (!size) return { ok: false, size: 0 };
        const p = Module._gpx_alloc(size);
        const saved = Module._gpx_state_save(p, size);
        const copy = new Uint8Array(new Uint8Array(Module.HEAPU8.buffer, p, size));
        Module._gpx_free(p);
        if (!saved) return { ok: false, size };
        const p2 = Module._gpx_alloc(copy.length);
        Module.HEAPU8.set(copy, p2);
        const ok = Module._gpx_state_load(p2, copy.length);
        Module._gpx_free(p2);
        return { ok: !!ok, size };
      });
      rec(armName, 'savestate-roundtrip', st.ok, `${st.size} bytes, gpx_state_load=${st.ok}`);

      // ── the emulator survives that round-trip ───────────────────────────
      const before = await page.evaluate(() => window.__genFrames);
      await sleep(1500);
      const after = await page.evaluate(() => window.__genFrames);
      rec(armName, 'still-running-after-state-load', after - before > 30, `${after - before} frames in 1.5 s`);
    }

    rec(armName, 'no-page-errors', errs.length === 0, errs.length ? errs.join(' | ') : 'none');
    rec(armName, 'no-failed-requests', fails.length === 0, fails.length ? fails.join(' | ') : 'none');
  } finally { await browser.close(); }
}

// ── run ─────────────────────────────────────────────────────────────────────
const LAND_IOS = { w: 844, h: 390, ua: IPHONE };
const PORT_IOS = { w: 390, h: 844, ua: IPHONE };
const LAND_AND = { w: 915, h: 412, ua: ANDROID };
// A NARROW DESKTOP WINDOW. #canvasWrap is then TALLER than 4:3, which is the
// case the first attempt at the aspect fix got wrong in the opposite direction
// (it measured 1.9217 at 800x600). Nothing else in the suite exercises it.
const NARROW_DESK = { w: 520, h: 900, desktop: true };

let load = 'unknown';
try { load = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (_e) {}
console.log('[genesis] ' + load);
console.log('[genesis] a guest-rate number taken above ~load 25 is not interpretable — see CLAUDE.md gate #10');

for (const idx of ROM_IDXS) {
  await arm(null, 'desktop', idx);
  await arm(LAND_IOS, 'ios-landscape', idx);
}
await arm(NARROW_DESK, 'desktop-narrow', ROM_IDXS[0]);
// The shell layout, not the core, is what changes between these — run them once.
await arm(PORT_IOS, 'ios-portrait', ROM_IDXS[0]);
await arm(LAND_AND, 'android-landscape', ROM_IDXS[0]);

const bad = results.filter((r) => !r.ok);
console.log(`\n[genesis] ${results.length - bad.length}/${results.length} passed`);
for (const b of bad) console.log(`  FAIL ${b.arm} :: ${b.name} :: ${b.detail}`);
process.exit(bad.length ? 1 : 0);
