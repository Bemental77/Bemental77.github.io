// tools/device_matrix.mjs — the standing device-portability gate for the three
// emulator pages (gamecube.html, dreamcast.html, n64/index.html).
//
//   npm run web                       # serve on :8080 first (CLAUDE.md gate #2)
//   node tools/device_matrix.mjs
//   node tools/device_matrix.mjs --arm=no-webgpu --page=gamecube
//   node tools/device_matrix.mjs --json > /tmp/matrix.json
//
// ============================================================================
// TWO HARNESS BUGS THIS RIG IS BUILT TO DESIGN OUT
// ============================================================================
// Both already produced worthless results on this project, and both produced
// results that LOOKED CLEAN, which is what makes them expensive.
//
// BUG 1 — CAPABILITY CHECKS THAT TEST PRESENCE, NOT FUNCTION.
//   Reading `!!navigator.gpu` returned gpu=true under a flag that disables
//   WebGPU. Measured on this machine 2026-09-01, Chrome 140, on gamecube.html:
//
//       flag                                    navigator.gpu   requestAdapter()
//       (none)                                  true            adapter
//       --disable-gpu                           TRUE            null
//       --disable-features=WebGPUService,Dawn   TRUE            null
//       --disable-features=WebGPU               true            adapter   (NO-OP!)
//       --disable-blink-features=WebGPU         true            adapter   (NO-OP!)
//
//   Two lessons in one table. The property is truthy on a machine with no
//   adapter, AND two of the four "disable WebGPU" spellings do nothing at all —
//   so an arm can be a placebo while its name says otherwise. This rig therefore
//   (a) reads only the FUNCTIONAL fields of window.__cap (lib/capability.js,
//   which does requestAdapter->requestDevice->getContext->configure), and
//   (b) requires every arm to PROVE it changed something (see BUG 3).
//
// BUG 2 — CROSS-ORIGIN ISOLATION IS ORIGIN-SCOPED AND PERSISTS.
//   coi-serviceworker.js installs COOP/COEP for the whole origin. Visiting
//   gamecube.html first therefore silently isolates every page visited after it
//   in the same browser profile — including n64/, whose entire design point is
//   that it needs no isolation. A prior matrix run returned TWELVE IDENTICAL
//   ROWS because of this. Every arm here gets its own fresh `userDataDir`, which
//   is deleted afterwards, and the rig proves the isolation works rather than
//   assuming it (see `rigSelfTest` — it deliberately reproduces the leak in one
//   profile and requires a fresh profile not to show it).
//
// BUG 3 — THE FALSE NULL. This project has produced three "clean" results that
//   measured nothing: an A/B where a loader cache made both arms run identical
//   code, a campaign comparing two identical configs because the path under test
//   was dead code, and a spread blamed on machine load that was a concurrent
//   writer on the rig's own output file. All three looked like passes.
//   So: EVERY ARM CARRIES AN ARM-DIFFERENCE PROOF — a named value that must
//   demonstrably differ from the baseline arm. If the proof does not hold, the
//   arm is VOID and prints NO VERDICT. A void arm is not a pass and not a
//   failure; it is a statement that the rig did not manage to create the
//   condition it claims to test, which is the only honest thing to say.
//
// ============================================================================
// WHAT THIS RIG CANNOT DO — stated, not papered over
// ============================================================================
// Chrome device emulation gets viewport, touch and user-agent right, but it RUNS
// CHROME'S ENGINE. It is not iOS Safari. The user's original failure was on a
// real iPhone, and iOS Safari differs from Chrome in exactly the areas that
// matter here: WebKit's WebGL/WebGPU implementation, its far tighter limits on
// large and shared WebAssembly.Memory (emscripten#19144, cited at
// dreamcast.html:1315), and its own service-worker and COEP behaviour. Any row
// tagged `enginesDiffer: true` is a Chrome result wearing an iPhone's clothes.
// It can prove a LAYOUT or INPUT bug and it can prove a page's own gating logic;
// it CANNOT clear the page on real iOS. That needs hardware.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.MATRIX_BASE || 'http://localhost:8080';
const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ONLY_ARM = argOf('arm', null);
const ONLY_PAGE = argOf('page', null);
const JSON_ONLY = argv.includes('--json');

// The three pages, with the capability spec each one actually needs. The specs
// are the same shape lib/capability.js consumes and lib/capability.test.js
// asserts, so a page and the rig cannot drift apart on what "required" means.
const PAGES = [
  { id: 'gamecube', url: '/gamecube.html',
    spec: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgpu: 'required' } },
  // ⚠ `webgl2Worker`, NOT `webgl2`. dreamcast.html transfers its canvas to the
  // emulator worker and renders WebGL2 only from there, so main-thread WebGL2 is
  // not its requirement — and requiring it was a MEASURED false negative (under
  // --disable-3d-apis a <canvas> refuses a context while a worker gets a full
  // one, and the shipped page disabled Start while its worker rendered).
  { id: 'dreamcast', url: '/dreamcast.html',
    spec: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgl2Worker: 'required' } },
  // THE PORTABILITY REFERENCE. N64Wasm is single-threaded: no SAB, no COI, no
  // WebGPU, no worker. If an arm breaks this page, the arm broke something
  // universal — which makes it the control for every other row.
  { id: 'n64', url: '/n64/', spec: { wasm: 'required', webgl2: 'required' } },
  // ps1 and snes are here for the CONSOLE arm specifically.  Both carried the same
  // `xbox`-in-isMobile defect as the three above, and neither was covered by any
  // console-aware harness: tools/legacy_emu_page_test.mjs does cover them, but it
  // asserts boot / guest-rate / input across desktop+iPhone+Android only — it has no
  // console UA arm and no layout or back-trap assertion.
  // Adding them was CHEAP and required no new machinery: both already load
  // lib/capability.js (ps1.html:4, snes.html:4) and already call
  // Capability.autoGate(Capability.SPECS.ps1|snes) (ps1.html:788, snes.html:620), and
  // those specs already existed at lib/capability.js:982-984.  The console probe's
  // PAIRS already contains ['canvas','canvasWrap'], which is exactly their markup
  // (ps1.html:144, snes.html:140), and visAny(['wrap','desktop']) matches their
  // desktop containers (ps1.html:132, snes.html:127).
  // ⚠ CLAUDE.md states only gamecube/dreamcast/n64 load capability.js.  That is STALE —
  // verified against the live files on 2026-09-05.
  { id: 'ps1',  url: '/ps1.html',  spec: { wasm: 'required' } },
  { id: 'snes', url: '/snes.html', spec: { wasm: 'required' } },
  // gba is the ODD ONE OUT and is here to keep it honest: it has NO isMobile branch at
  // all (so no UA token to correct), its canvas carries an INLINE width that only
  // !important can beat, and it displays at 240x160 = 3:2 — the one page in this repo
  // whose console rule must not reuse the 4:3 the other five share.
  { id: 'gba',  url: '/gba.html',  spec: { wasm: 'required' } },
];

// ---------------------------------------------------------------------------
// The arms. `proof` is the arm-difference contract: given the BASELINE report
// and this arm's report, it must return {ok:true} or the arm is void.
// ---------------------------------------------------------------------------
const ARMS = [
  {
    id: 'desktop',
    what: 'Full desktop Chrome, nothing disabled. The reference every other arm is a delta from.',
    args: [],
    baseline: true,
    // The baseline proves itself by being healthy: if the reference machine
    // cannot do the things, no delta below means anything.
    proof: (_b, a) => {
      const w = a.cap?.webgpu, g = a.cap?.webgl2;
      return { ok: !!(w?.adapter && g?.ok),
               detail: `baseline must be healthy: webgpu.adapter=${w?.adapter} webgl2.ok=${g?.ok}` };
    },
  },
  {
    id: 'console',
    what: 'A living-room console browser (Xbox Series X|S Edge): gamepad only, NO touchscreen, '
        + '1920x1080 at ten feet. Reported by the owner as "the controls for dreamcast are broken". '
        + 'The page used to classify this UA as MOBILE and serve it a finger shell.',
    args: [],
    // setUserAgent does NOT set Client Hints — navigator.userAgentData keeps the
    // host values. Harmless today because dreamcast.html:797 reads the userAgent
    // STRING, but a future UA-CH check would silently un-arm this cell.
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    // hasTouch:false is deliberate, not incidental: it makes the touch-target
    // assertions below skip correctly for a touchless device, and dcInput's pad
    // assertion becomes this arm's control check instead.
    // ⚠ No arm overrides deviceMemory, so this cell gets the HOST's value. With
    // CONSOLE_UA true that makes MEM_BUDGET min(mem*0.45, 450) = 450 MB and arms
    // budgetForces/lazydisc — irrelevant while this arm boots nothing, a confound
    // the moment it does.
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
    // TWO-LEVEL PROOF, because judge() calls arm.proof PER PAGE and only
    // dreamcast has a #dc-canvas — a canvas-only proof VOIDs the gamecube and
    // n64 cells, which is what the first version of this arm did.
    //   proof        : universal, holds on every page — the viewport took and the
    //                  device is still touchless. Deliberately NOT
    //                  __dcProbe().consoleUA, which is the page echoing back the
    //                  UA we just set and therefore proves only that the UA took.
    //   invariantFor : the page-specific, and much stronger, dreamcast assertion.
    proof: (b, a) => {
      const vw = b.cap?.env?.vw !== a.cap?.env?.vw && a.cap?.env?.vw === 1920;
      const touchless = a.cap?.env?.touch === false;
      return { ok: !!(vw && touchless),
               detail: `viewport ${b.cap?.env?.vw}->${a.cap?.env?.vw} (must reach 1920), `
                     + `touch ${a.cap?.env?.touch} (a console has none)` };
    },
    invariantFor: {
      // n64 reads pads NATIVELY in the core (n64/index.html:2624 — emscripten HTML5
      // gamepad API + config.txt), so there is no page-side pad seam to assert here;
      // the canvas is the whole of n64's console fix.  Its canvas is 640x480 = exactly
      // 4:3.
      // ⚠ CORRECTION.  This comment used to say gamecube's is "640x528 = 1.2121 and must
      // NOT reuse this number".  That conflated two different quantities: 640x528 is
      // gamecube's BACKING STORE (gamecube.html:188), while its DISPLAY aspect is 4:3 —
      // gamecube.html:58-59's own :fullscreen rules letterbox at 4/3.  Asserting 1.2121
      // would have pinned a ~10% vertical stretch into this gate as "correct".  All three
      // pages assert 4:3 here; they differ in backing store, not in display aspect.
      n64: (a) => {
        const c = a.dcConsole || {};
        const ok = c.consoleClass === true && c.fillsWrapH === true
                && Math.abs((c.ratio || 0) - 1.3333) < 0.02
                && c.wrapShown === true && c.shellShown === false;
        return { ok,
                 detail: `console-ua=${c.consoleClass} canvas ${c.canvasW}x${c.canvasH} `
                       + `fillsWrapH=${c.fillsWrapH} ratio=${c.ratio} wrap=${c.wrapShown} `
                       + `shell=${c.shellShown} (n64 is 640x480, exactly 4:3)` };
      },
      // gamecube got the SAME two-part console fix (token + .console-ua) plus a THIRD
      // part the other pages already had: a back-nav trap.  It had zero guards of any
      // kind, so L3 on an Xbox pad unloaded a running emulator.  Hence backTrap is part
      // of gamecube's pass criterion and not merely reported.
      gamecube: (a) => {
        const c = a.dcConsole || {}, b = a.backTrap || {};
        const ok = c.consoleClass === true && c.fillsWrapH === true
                && Math.abs((c.ratio || 0) - 1.3333) < 0.02
                && c.wrapShown === true && c.shellShown === false
                && c.canvasParent === 'canvasWrap'
                && b.keySwallowed === true && b.sentinel === true;
        return { ok,
                 detail: `console-ua=${c.consoleClass} canvas ${c.canvasW}x${c.canvasH} `
                       + `fillsWrapH=${c.fillsWrapH} ratio=${c.ratio} desktop=${c.wrapShown} `
                       + `shell=${c.shellShown} parent=${c.canvasParent} `
                       + `backTrap{swallowed=${b.keySwallowed} sentinel=${b.sentinel}} `
                       + `(4:3 display aspect, NOT the 640x528=1.2121 backing store)` };
      },
      // ps1 already had the back-nav trap (:702-712) — it is the page the others were
      // ported FROM — so its console defect was the isMobile token plus a canvas pinned
      // at 640x480 (:24).  Its `clip-path: inset(0 0 5.14% 0)` overscan crop is NOT
      // asserted here: getBoundingClientRect reports the LAYOUT box and ignores
      // clip-path, so `ratio` measures the element (4:3) and could not see the crop
      // either way.  The crop is left declared once, at :24.
      // gba asserts the RULE, not the box: #canvasDiv is display:none until start
      // (gba.html:523), so there is nothing to measure pre-boot and `boxless` will be
      // true.  cssAspect === '3 / 2' proves the .console-ua rule matched — and proves it
      // did NOT get the 4:3 the other five use, which is the specific mistake available
      // here.  backTrap is the load-bearing half: gba had no guard of any kind.
      gba: (a) => {
        const c = a.dcConsole || {}, b = a.backTrap || {};
        const aspectOk = String(c.cssAspect || '').replace(/\s/g, '') === '3/2';
        const ok = c.consoleClass === true && aspectOk
                && b.keySwallowed === true && b.sentinel === true;
        return { ok,
                 detail: `console-ua=${c.consoleClass} cssAspect=${c.cssAspect} (must be 3 / 2, `
                       + `NOT the 4:3 the other five use) boxless=${c.boxless} `
                       + `backTrap{swallowed=${b.keySwallowed} sentinel=${b.sentinel}} `
                       + `(gba: 240x160, canvasDiv is display:none until start)` };
      },
      ps1: (a) => {
        const c = a.dcConsole || {}, b = a.backTrap || {};
        const ok = c.consoleClass === true && c.fillsWrapH === true
                && Math.abs((c.ratio || 0) - 1.3333) < 0.02
                && c.wrapShown === true && c.shellShown === false
                && c.canvasParent === 'canvasWrap'
                && b.keySwallowed === true && b.sentinel === true;
        return { ok,
                 detail: `console-ua=${c.consoleClass} canvas ${c.canvasW}x${c.canvasH} `
                       + `fillsWrapH=${c.fillsWrapH} ratio=${c.ratio} desktop=${c.wrapShown} `
                       + `shell=${c.shellShown} backTrap{swallowed=${b.keySwallowed} `
                       + `sentinel=${b.sentinel}} (ratio is the layout box; clip-path is invisible to it)` };
      },
      // snes is the ONLY page that needed no .console-ua rule: snes.html:31 already
      // ships `height:100%; width:auto; aspect-ratio:4/3`, the very pattern the other
      // four were corrected TO.  It DID need the back-nav trap — it had none at all
      // (grep -c BrowserBack snes.html = 0 before this change), so backTrap is the
      // load-bearing half of this judge.
      snes: (a) => {
        const c = a.dcConsole || {}, b = a.backTrap || {};
        const ok = c.consoleClass === true && c.fillsWrapH === true
                && Math.abs((c.ratio || 0) - 1.3333) < 0.02
                && c.wrapShown === true && c.shellShown === false
                && b.keySwallowed === true && b.sentinel === true;
        return { ok,
                 detail: `console-ua=${c.consoleClass} canvas ${c.canvasW}x${c.canvasH} `
                       + `fillsWrapH=${c.fillsWrapH} ratio=${c.ratio} desktop=${c.wrapShown} `
                       + `shell=${c.shellShown} backTrap{swallowed=${b.keySwallowed} `
                       + `sentinel=${b.sentinel}} (no .console-ua rule by design — :31 already scales)` };
      },
      // ⚠ dreamcast is THE REPORTED PAGE ("the controls for dreamcast on the xbox chrome
      // browser are broken"), and this judge used to assert layout ONLY — not the back-nav
      // trap, and not the pad map, even though dcInput measures both and gamecube/ps1/snes
      // all gate on backTrap.  The page whose bug started this campaign had the weakest
      // criterion of the five.  It now asserts all three:
      //   layout   — desktop shell + a canvas that fills it at 4:3
      //   backTrap — L3/BrowserBack swallowed AND the history sentinel present
      //   padMap   — one face, one system and one d-pad button survive packPad(), which is
      //              the mapping the report actually named.  Measured, not assumed.
      dreamcast: (a) => {
        const c = a.dcConsole || {}, b = a.backTrap || {}, m = (a.dcInput && a.dcInput.padMap) || {};
        const padOk = m.btn0_B === true && m.btn9_START === true && m.btn12_UP === true;
        const ok = c.consoleClass === true && c.fillsWrapH === true
                && Math.abs((c.ratio || 0) - 1.333) < 0.02
                && c.wrapShown === true && c.shellShown === false
                && c.canvasParent === 'canvasWrap'
                && b.keySwallowed === true && b.sentinel === true
                && padOk;
        return { ok,
                 detail: `console-ua=${c.consoleClass} canvas ${c.canvasW}x${c.canvasH} `
                       + `fillsWrapH=${c.fillsWrapH} ratio=${c.ratio} wrap=${c.wrapShown} `
                       + `shell=${c.shellShown} parent=${c.canvasParent} `
                       + `backTrap{swallowed=${b.keySwallowed} sentinel=${b.sentinel}} `
                       + `pad{B=${m.btn0_B} START=${m.btn9_START} UP=${m.btn12_UP}} `
                       + `(desktop shell, canvas fills it at 4:3, L3 trapped, pad reaches packPad)` };
      },
    },
  },
  {
    id: 'no-webgpu',
    what: 'WebGPU removed, GPU otherwise intact — the realistic "my browser has no WebGPU" device '
        + '(Firefox, older Safari, enterprise policy). This is the arm for the GameCube black screen.',
    // MEASURED: this is the only spelling tested that removes the adapter while
    // leaving WebGL2 on the real GPU. --disable-features=WebGPU is a no-op.
    args: ['--disable-features=WebGPUService,Dawn'],
    proof: (b, a) => {
      const changed = b.cap?.webgpu?.adapter === true && a.cap?.webgpu?.adapter === false;
      const glKept = a.cap?.webgl2?.ok === true;
      return { ok: changed && glKept,
               detail: `webgpu.adapter ${b.cap?.webgpu?.adapter}->${a.cap?.webgpu?.adapter} `
                     + `(must flip true->false); webgl2.ok=${a.cap?.webgl2?.ok} (must stay true, or this is `
                     + `the no-gpu arm wearing the wrong name)` };
    },
  },
  {
    id: 'no-gpu',
    what: 'No GPU at all: neither WebGPU nor WebGL2. The floor case — software everything.',
    args: ['--disable-gpu'],
    proof: (b, a) => {
      const wg = b.cap?.webgpu?.adapter === true && a.cap?.webgpu?.adapter === false;
      const gl = b.cap?.webgl2?.ok === true && a.cap?.webgl2?.ok === false;
      return { ok: wg && gl,
               detail: `webgpu.adapter ${b.cap?.webgpu?.adapter}->${a.cap?.webgpu?.adapter}, `
                     + `webgl2.ok ${b.cap?.webgl2?.ok}->${a.cap?.webgl2?.ok} (BOTH must flip true->false)` };
    },
  },
  {
    id: 'no-coi',
    what: 'Cross-origin isolation blocked: the coi-serviceworker request is aborted, so COOP/COEP never '
        + 'install and SharedArrayBuffer never appears. Models a proxy that strips headers, a browser '
        + 'with service workers off, or the very first visit before the reload.',
    args: [],
    // Aborting the request is a truer model than deleting the tag: the page's
    // own code still runs its "am I isolated?" path exactly as shipped.
    hook: async (page) => {
      await page.setRequestInterception(true);
      page.on('request', (r) => {
        if (/coi-serviceworker\.js/.test(r.url())) r.abort().catch(() => {});
        else r.continue().catch(() => {});
      });
    },
    proof: (b, a) => {
      const coi = b.cap?.sab?.crossOriginIsolated === true && a.cap?.sab?.crossOriginIsolated === false;
      return { ok: coi,
               detail: `sab.crossOriginIsolated ${b.cap?.sab?.crossOriginIsolated}->`
                     + `${a.cap?.sab?.crossOriginIsolated} (must flip true->false). `
                     + `SAB constructor now: ${a.cap?.sab?.ctor}` };
    },
    // n64/ never loads coi-serviceworker at all, so on that page this arm cannot
    // flip anything — and correctly so. It is skipped there rather than voided,
    // because "no change" IS the invariant being asserted for n64.
    invariantFor: { n64: (a) => ({
      ok: a.cap?.sab?.crossOriginIsolated === false,
      detail: 'n64/ must be un-isolated with or without the service worker; it requires neither' }) },
  },
  {
    id: 'mobile-ios',
    what: 'iPhone viewport + touch + iOS user agent. Proves layout, touch targets and the page\'s own '
        + 'mobile branch. Runs CHROME\'S ENGINE — see the header: this cannot clear real iOS Safari.',
    args: [],
    enginesDiffer: true,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    proof: (b, a) => {
      const touch = b.cap?.env?.touch === false && a.cap?.env?.touch === true;
      const ua = a.cap?.env?.iosUA === true && b.cap?.env?.iosUA === false;
      const vw = a.cap?.env?.vw !== b.cap?.env?.vw;
      return { ok: touch && ua && vw,
               detail: `touch ${b.cap?.env?.touch}->${a.cap?.env?.touch}, iosUA ${b.cap?.env?.iosUA}->`
                     + `${a.cap?.env?.iosUA}, viewport ${b.cap?.env?.vw}->${a.cap?.env?.vw} `
                     + `(all three must differ, or device emulation did not take)` };
    },
  },
  {
    // ── THE CELL THAT WAS MISSING, AND THE BUG IT WAS MISSING ────────────────
    // Every arm that BLOCKS a page (no-webgpu, no-gpu, no-coi) ran at a DESKTOP
    // viewport, where `isMobile` is false and #mobileSplash is never shown; and
    // the one arm at phone size (mobile-ios) blocks nothing on this machine. So
    // no cell in the 21 ever put a GATED page in front of a TOUCH device, and
    // the gate's mobile behaviour went unmeasured for its whole existence.
    //
    // What lived in that hole: a `disabled` <button> still receives `pointerdown`
    // in Chrome (measured — click and mousedown are suppressed, pointerdown and
    // touchstart are not), and both mobile splash Start handlers are bound to
    // pointerdown and call their starter directly. One tap on the greyed-out
    // "Cannot run here" button started the emulator on gamecube.html and
    // n64/index.html and hid the splash carrying the explanation. The matrix
    // scored those same pages BLOCKED-HONESTLY, because judge() read `.disabled`
    // and nothing ever tapped anything.
    id: 'mobile-no-gpu',
    what: 'A PHONE with no GPU path: iPhone viewport + touch + iOS UA, and --disable-gpu. The only arm '
        + 'that puts a BLOCKED page in front of a TOUCH device, which is where the gate is weakest.',
    args: ['--disable-gpu'],
    enginesDiffer: true,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    // Compound proof: BOTH halves must take, or this is one of the other two
    // arms wearing this one's name and the cell proves nothing about phones.
    proof: (b, a) => {
      const touch = b.cap?.env?.touch === false && a.cap?.env?.touch === true;
      const ua = b.cap?.env?.iosUA === false && a.cap?.env?.iosUA === true;
      const gl = b.cap?.webgl2?.ok === true && a.cap?.webgl2?.ok === false;
      return { ok: touch && ua && gl,
               detail: `touch ${b.cap?.env?.touch}->${a.cap?.env?.touch}, iosUA ${b.cap?.env?.iosUA}->`
                     + `${a.cap?.env?.iosUA}, webgl2.ok ${b.cap?.webgl2?.ok}->${a.cap?.webgl2?.ok} `
                     + `(the device emulation AND the GPU removal must BOTH take)` };
    },
  },
  {
    // ── THE ARM ADDED FOR A REAL VISITOR ON A GAMES CONSOLE ──────────────────
    // Reported 2026-09-04: dreamcast.html on the Xbox console's Edge browser
    // said WebGL2 was unavailable and then the page died. The gap it exposed was
    // structural, not cosmetic: dreamcast.html renders WebGL2 ONLY from its
    // worker, on a canvas handed over with transferControlToOffscreen(), and
    // NOTHING in the 21-cell matrix ever removed that path. Every GPU arm here
    // removes the GPU from the whole browser, so main-thread and worker GL fall
    // together and the two are never told apart.
    //
    // This arm removes ONLY the page's ability to hand a canvas to a worker,
    // with the GPU fully intact. It is the iOS-16 shape the page already
    // documents (Safari 16.4 shipped OffscreenCanvas with a 2D context only) and
    // the plausible console shape, and it is a genuine condition rather than a
    // faked measurement: the page really cannot call transferControlToOffscreen,
    // exactly as on a browser that never had it.
    //
    // ⚠ WHAT THIS ARM STILL CANNOT REACH, stated rather than implied: the case
    // where the page CAN transfer a canvas and a WORKER is refused a WebGL2
    // context while the main thread keeps one. No Chrome flag produces that
    // split — measured 2026-09-04, --disable-gpu and --use-gl=swiftshader take
    // both surfaces down together, and --disable-3d-apis takes down the
    // main-thread <canvas> while LEAVING worker GL working (the opposite split).
    // Faking it by patching the probe's own worker would test the rig, not the
    // platform. That cell needs the hardware.
    id: 'no-offscreen-gl',
    what: 'The GPU is intact but the page cannot hand a canvas to a worker: OffscreenCanvas and '
        + 'canvas.transferControlToOffscreen are removed. Main-thread WebGL2 keeps working. This is the '
        + 'ONLY arm that separates "this device has WebGL2" from "this device can render from a worker", '
        + 'which is the requirement dreamcast.html actually has.',
    args: [],
    hook: async (page) => {
      // In the DOCUMENT realm, before any page script runs. A browser without
      // these is indistinguishable from this, which is the point — nothing here
      // patches a probe or a result, only the platform surface the page reads.
      await page.evaluateOnNewDocument(() => {
        try { delete window.OffscreenCanvas; } catch (e) { window.OffscreenCanvas = undefined; }
        try { delete HTMLCanvasElement.prototype.transferControlToOffscreen; } catch (e) {}
      });
    },
    proof: (b, a) => {
      const bo = b.cap?.webgl2?.offscreen, ao = a.cap?.webgl2?.offscreen;
      const removed = bo?.supported === true && ao?.supported === false;
      const xfer = bo?.transferSupported === true && ao?.transferSupported === false;
      // ...and the GPU must be UNTOUCHED, or this is the no-gpu arm under a
      // different name and it proves nothing about the worker path.
      const glKept = b.cap?.webgl2?.ok === true && a.cap?.webgl2?.ok === true;
      return { ok: removed && xfer && glKept,
               detail: `webgl2.offscreen.supported ${bo?.supported}->${ao?.supported}, `
                     + `transferSupported ${bo?.transferSupported}->${ao?.transferSupported} `
                     + `(both must flip true->false); webgl2.ok ${b.cap?.webgl2?.ok}->${a.cap?.webgl2?.ok} `
                     + `(must stay TRUE, or the GPU went down too and this arm is no-gpu in disguise)` };
    },
    // n64/ renders on the MAIN thread and never touches OffscreenCanvas, so
    // removing it must change nothing there. That is the invariant, not a void.
    invariantFor: { n64: (a) => ({
      ok: a.cap?.webgl2?.ok === true,
      detail: 'n64/ renders on the main thread and must be unaffected by OffscreenCanvas being absent; '
            + `webgl2.ok=${a.cap?.webgl2?.ok}` }) },
  },
  {
    id: 'low-memory',
    what: 'A constrained V8 heap. Also runs the 512 MB WebAssembly.Memory probe, which is the '
        + 'allocation the N64 core actually asks for at start.',
    args: ['--js-flags=--max-old-space-size=192'],
    probeHeap: true,
    proof: (b, a) => {
      const bl = b.cap?.env?.jsHeapLimitMB, al = a.cap?.env?.jsHeapLimitMB;
      return { ok: typeof bl === 'number' && typeof al === 'number' && bl !== al,
               detail: `env.jsHeapLimitMB ${bl}->${al} (must differ, or --js-flags did not take)` };
    },
  },
  {
    id: 'slow-net',
    what: 'Throttled network. The Dreamcast disc and the split ROM parts are fetched at runtime, so '
        + 'this is the arm where a page must not look broken while it is merely slow.',
    args: [],
    netThrottle: { offline: false, downloadThroughput: 50 * 1024, uploadThroughput: 20 * 1024, latency: 400 },
    proof: (b, a) => {
      // The rig times a same-origin fetch from INSIDE the page, so it goes
      // through the throttled network stack. A ratio, not an absolute, because
      // absolutes on a loaded machine are noise (CLAUDE.md gate #10).
      const bm = b.fetchMs, am = a.fetchMs;
      const ratio = (typeof bm === 'number' && bm > 0 && typeof am === 'number') ? am / bm : null;
      return { ok: ratio !== null && ratio >= 3,
               detail: `in-page fetch of /lib/capability.js: ${bm?.toFixed?.(1)}ms -> ${am?.toFixed?.(1)}ms `
                     + `(ratio ${ratio === null ? '?' : ratio.toFixed(1)}x, must be >= 3x)` };
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One (arm, page) cell.
// ---------------------------------------------------------------------------
async function runCell(arm, pg) {
  // FRESH PROFILE PER CELL. Not per arm — per cell. Cross-origin isolation is
  // installed by whichever page ran first, so even two pages inside one arm
  // would contaminate each other. This directory is removed in the finally.
  //
  // A failure to create it must degrade THIS CELL, not kill the run: a full disk
  // once took down a 21-cell sweep at cell 13 and the 12 completed rows went
  // with it. An ERROR row is recoverable information; a dead process is not.
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-${arm.id}-${pg.id}-`));
  } catch (e) {
    return { arm: arm.id, page: pg.id, consoleErrors: [], pageErrors: [], failedRequests: [],
             error: `could not create a browser profile: ${String(e).slice(0, 160)}`
                  + (String(e).includes('ENOSPC') ? ' — the disk is full; free space and re-run' : '') };
  }
  const out = { arm: arm.id, page: pg.id, profile: dir, consoleErrors: [], pageErrors: [], failedRequests: [] };
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new', executablePath: CHROME, userDataDir: dir,
      // page.setDefaultTimeout below covers waitFor*/navigation but NOT page.evaluate;
      // an evaluate is bounded only by CDP protocolTimeout, whose default is 180 s.  A
      // dozen of those in the cell path is a quarter-hour of apparent silence.  120 s is
      // still far above any legitimate evaluate here and turns a wedge into an error.
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...(arm.args || [])],
    });
    // [leak-guard] a SIGKILLed parent ORPHANS this browser (uncatchable in-process);
    // `node tools/browser_leak_guard.js reap` kills it once this process is gone.
    try { (await import('./browser_leak_guard.js')).default.guard(browser, import.meta.url); } catch (_e) {}
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 180)); });
    page.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 180)));
    page.on('response', (r) => { if (r.status() >= 400) out.failedRequests.push(`${r.url().slice(-70)} HTTP${r.status()}`); });

    if (arm.viewport) await page.setViewport(arm.viewport);
    if (arm.ua) await page.setUserAgent(arm.ua);
    if (arm.hook) await arm.hook(page);

    // ---- NETWORK THROTTLING MUST REACH THE SERVICE WORKER TOO ---------------
    // Page-scoped CDP throttling does NOT cover a service worker: the worker is
    // a separate CDP target, and coi-serviceworker.js re-issues EVERY request
    // through its own `fetch()` (coi-serviceworker.js:2, the `respondWith`
    // handler). Measured on the first full run of this rig:
    //
    //     page          in-page fetch, desktop -> slow-net
    //     n64/          1.9 ms  ->  407.6 ms      (214x — no service worker)
    //     gamecube.html 2.4 ms  ->    2.8 ms      (1.2x — SW bypassed it)
    //     dreamcast.html 2.9 ms ->    3.1 ms      (1.1x — SW bypassed it)
    //
    // The navigation itself WAS throttled (navMs 166 -> 9414), which is what
    // makes this so easy to miss: the arm looks like it took. The rig only
    // caught it because the arm-difference proof measured the thing the arm
    // claims to change instead of trusting the flag. Every target gets the
    // conditions, and any that appear later (the SW registers asynchronously)
    // get them when they appear.
    const throttled = new Set();
    const applyThrottle = async () => {
      if (!arm.netThrottle) return;
      for (const t of browser.targets()) {
        const type = t.type();
        if (!['page', 'service_worker', 'worker', 'shared_worker'].includes(type)) continue;
        const key = t.url() + '|' + type;
        if (throttled.has(key)) continue;
        try {
          const s = await t.createCDPSession();
          await s.send('Network.enable');
          await s.send('Network.emulateNetworkConditions', arm.netThrottle);
          throttled.add(key);
        } catch (e) { /* not every target accepts the Network domain */ }
      }
    };
    await applyThrottle();

    // PROBE ON THE REAL PAGE. An earlier matrix probed about:blank and got
    // navigator.gpu=false in BOTH arms, proving nothing: about:blank has no
    // origin, no service worker, and no page-side probe to read.
    const t0 = Date.now();
    await page.goto(BASE + pg.url, { waitUntil: 'domcontentloaded' });
    out.navMs = Date.now() - t0;

    // ABSORB THE coi-serviceworker RELOAD BEFORE PROBING ANYTHING.
    // coi-serviceworker.js ends with `doReload: () => window.location.reload()` and
    // fires it whenever crossOriginIsolated is false and the SW activates.  This rig
    // uses a FRESH userDataDir per cell (deliberately — isolation is origin-scoped and
    // persists), so that reload is GUARANTEED on first load of every page that ships the
    // worker: gamecube, dreamcast, ps1, snes, gba.  Only n64 is exempt (it loads no
    // coi-serviceworker, by design — it is single-threaded and needs no SAB).
    // Racing it produced intermittent, page-specific `Execution context was destroyed,
    // most likely because of a navigation` errors — 2 of 50 cells in one full run, both
    // gamecube, on arms as unrelated as `console` and `mobile-ios`, and NOT reproducible
    // on demand.  That reads like a page bug and is not one; it is the rig probing across
    // a navigation the site is documented to perform.
    // The catch is the POINT, not defensive padding: a destroyed context IS the reload we
    // are waiting for, so it means "keep waiting", not "fail".  Bounded at ~6s; a page
    // that never isolates simply proceeds and its own assertions speak.
    out.coiSettle = await (async () => {
      for (let i = 0; i < 30; i++) {
        try {
          const r = await page.evaluate(() => ({
            coi: !!self.crossOriginIsolated,
            ctl: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
          }));
          if (r.coi || r.ctl) return { settled: true, ms: i * 200, coi: r.coi, ctl: r.ctl };
          if (i >= 4) return { settled: false, ms: i * 200, coi: false, ctl: false, note: 'no SW on this page' };
        } catch (_e) { /* context destroyed == the reload; keep waiting */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { settled: false, ms: 6000, timedOut: true };
    })();

    // window.__cap is published by lib/capability.js once its async probes
    // resolve. Waiting for the PROMISE, not polling for a truthy value, is what
    // keeps a half-filled report from being read as a finished one.
    const waitCap = () => page.waitForFunction('window.__cap && window.__cap.ver === 1', { timeout: 45000 })
      .then(() => true).catch(() => false);
    out.capReady = await waitCap();
    out.cap = await page.evaluate(() => (window.__cap ? JSON.parse(JSON.stringify(window.__cap)) : null));

    // ---- THE FIRST-VISIT RELOAD, settled rather than raced ------------------
    // coi-serviceworker.js does not merely register a worker; it RELOADS THE
    // PAGE ITSELF (`s.active && !navigator.serviceWorker.controller` ->
    // `doReload()`, coi-serviceworker.js:2). On a first visit to a fresh profile
    // — which is every cell in this rig — the document is therefore live but not
    // yet isolated for a moment, and then the context is destroyed underneath
    // whatever was reading it.
    //
    // Reading __cap inside that window reported `coi,sab` MISSING ON THE FULL
    // DESKTOP BASELINE: the rig manufacturing the exact failure it exists to
    // detect. A false positive of that shape is worse than no rig at all,
    // because it looks like a finding.
    //
    // So: wait for the page to SETTLE. Every evaluate is fault-tolerant, because
    // "Execution context was destroyed" is the expected midpoint here, not an
    // error. If the self-reload does not come, one explicit reload is issued —
    // which is exactly the "reload once" a real visitor is told to do. Whether a
    // reload was needed is RECORDED, because "no SharedArrayBuffer until you
    // reload" is a portability fact, not something to hide.
    //
    // This cannot mask a genuine failure: the no-coi arm aborts the worker
    // request, so nothing here can make it isolated, and it settles false.
    const peek = () => page.evaluate(() => ({
      cap: !!(window.__cap && window.__cap.ver === 1),
      coi: !!self.crossOriginIsolated,
      swReg: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    })).catch(() => null);
    out.coiNeededReload = false;
    out.coiSettled = false;
    // Only pages that actually REQUIRE isolation wait for it. n64/ never loads
    // coi-serviceworker (that is the whole point of the portability reference),
    // so its crossOriginIsolated is permanently and correctly false — an earlier
    // cut ran the full settle loop there anyway, burning ~12 s per cell and
    // then reporting `coiNeededReload: true` about a page that needs no coi at
    // all. A field that is wrong on the reference page poisons the reference.
    if (pg.spec.coi === 'required'
        && out.cap && out.cap.sab && out.cap.sab.crossOriginIsolated === false) {
      for (let i = 0; i < 24; i++) {                 // up to ~12 s of self-reload
        const s = await peek();
        if (s && s.cap && s.coi) { out.coiSettled = true; break; }
        if (i === 12 && !out.coiNeededReload) {      // it never came — do it ourselves
          out.coiNeededReload = true;
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await sleep(500);
      }
      out.capReady = await waitCap();
      out.cap = await page.evaluate(() => (window.__cap ? JSON.parse(JSON.stringify(window.__cap)) : null))
        .catch(() => out.cap);
    } else if (out.cap) {
      out.coiSettled = true;                          // isolated on the first load, or does not need it
    }

    // The service worker registers asynchronously, so on a first visit it did
    // not exist when the conditions were first applied. Re-apply now that the
    // page has settled and it does.
    await applyThrottle();

    if (arm.probeHeap && out.cap) {
      out.heap512 = await page.evaluate(() => window.Capability.probeHeap(512)).catch(() => 'probe threw');
    }

    // In-page fetch timing: the arm-difference proof for slow-net, and a cheap
    // sanity number everywhere else.
    out.fetchMs = await page.evaluate(async () => {
      const t = performance.now();
      try { await fetch('/lib/capability.js?cb=' + Math.random(), { cache: 'no-store' }); }
      catch (e) { return null; }
      return performance.now() - t;
    }).catch(() => null);

    // ---- the page's own gating: is Start honest about this device? ----------
    out.start = await page.evaluate(() => {
      const pick = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const cs = getComputedStyle(e);
        const vis = cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().height > 0;
        return { present: true, visible: vis, disabled: !!e.disabled,
                 blockedBy: e.getAttribute('data-cap-blocked'), text: (e.textContent || '').trim().slice(0, 90) };
      };
      return { desktop: pick('btnStart'), mobile: pick('mobileSplashStart') };
    }).catch(() => null);

    // ---- DID THE PAGE BOOT ANYWAY, WITH NOBODY TOUCHING ANYTHING? -----------
    // `start.disabled` and the tap test below both ask about the BUTTON. Neither
    // asks the question that matters on dreamcast.html, where the emulator's
    // whole startup — worker spawn, canvas hand-over, a 2048 MB shared-memory
    // reservation — runs at PAGE LOAD, before any control can be pressed. A
    // greyed-out Start sat in front of a running boot and every cell in this
    // matrix scored it BLOCKED-HONESTLY.
    //
    // window.__dcProbe().boot is the page's own witness: `started` flips only
    // where createSharedMemory() is actually called, `gatedBy` names the
    // blockers where the boot was deliberately not begun. Pages that publish no
    // such witness report null and are judged as before.
    out.boot = await page.evaluate(() => {
      try {
        if (typeof window.__dcProbe !== 'function') return null;
        const p = window.__dcProbe();
        return { started: !!(p.boot && p.boot.started), gatedBy: (p.boot && p.boot.gatedBy) || null,
                 heapMaxMB: (p.heap && p.heap.max) | 0 };
      } catch (e) { return { error: String(e).slice(0, 120) }; }
    }).catch(() => null);

    // ---- DREAMCAST INPUT, IN EVERY ARM --------------------------------------
    // These four facts are UA-INDEPENDENT, so they belong here and not in the
    // console arm: a mapping or trap regression on DESKTOP must not slip through
    // because the assertion was scoped to a console. Pages that publish no
    // __dcPad witness report null and are judged as before, exactly like
    // out.boot above. Costs no emulator boot — packPad() is pure.
    // ---- THE BACK-NAV TRAP, ON EVERY PAGE (not just dreamcast) --------------
    // Lives OUTSIDE dcInput because dcInput gates on window.__dcPad, which only
    // dreamcast has — so gamecube's brand-new trap would have gone unmeasured and
    // the cell would have passed on an untested guard.  Each page pushes its own
    // sentinel key (dreamcast `dc`, gamecube `gc`), so accept any of them rather
    // than hardcoding one page's spelling.
    // ⚠ Proves the PAGE swallows the event and keeps a history entry.  It does NOT
    // prove Edge routes L3 to BrowserBack — that is shell behaviour, hardware-only.
    out.backTrap = await page.evaluate(() => {
      try {
        const ev = new KeyboardEvent('keydown', { key: 'BrowserBack', bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        const st = history.state || {};
        return { keySwallowed: ev.defaultPrevented,
                 sentinel: !!(st.dc || st.gc || st.n64 || st.ps1 || st.snes || st.gba || st.emu),
                 sentinelKeys: Object.keys(st).join(',') };
      } catch (e) { return { error: String(e).slice(0, 120) }; }
    }).catch(() => null);

    out.dcInput = await page.evaluate(() => {
      try {
        if (typeof window.__dcPad !== 'function') return null;
        const r = {};

        // FIX 1, BOTH HALVES. dreamcast.html's Xbox trap is two mechanisms and a
        // keydown assertion only covers one: the capture-phase listener swallows
        // the synthetic BrowserBack, AND a history sentinel is pushed and
        // re-pushed on popstate. Without the `sentinel` cell the re-push could be
        // deleted and every row here would still pass.
        // ⚠ This proves the PAGE's trap. It does NOT prove Edge actually routes
        // L3 to BrowserBack — that is shell behaviour and is hardware-only.
        const ev = new KeyboardEvent('keydown', { key: 'BrowserBack', bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        r.backTrap = { keySwallowed: ev.defaultPrevented,
                       sentinel: !!(history.state && history.state.dc) };

        // FIX 3. Three button classes for the price of one: face, system, d-pad.
        // RB ids from dreamcast.html: B=0 START=3 UP=4 -> byte = id>>3, bit = id&7.
        // ⚠ RESTORED AFTERWARDS (gate #8: diagnostics must not accumulate) — this
        // overrides a page-realm global and other assertions share this page.
        const orig = navigator.getGamepads;
        try {
          const fake = { id: 'MatrixPad', index: 0, mapping: 'standard', connected: true, timestamp: 1,
            buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
            axes: [0, 0, 0, 0] };
          navigator.getGamepads = () => [fake];
          const press = (i) => { fake.buttons.forEach((b) => (b.pressed = false));
                                 fake.buttons[i].pressed = true; return window.__dcPad(); };
          r.padMap = { btn0_B: !!(press(0)[0] & 0x01),
                       btn9_START: !!(press(9)[0] & 0x08),
                       btn12_UP: !!(press(12)[0] & 0x10) };
        } finally { navigator.getGamepads = orig; }

        // FIX 5. A console visitor has no keyboard; the controls panel must
        // document the pad. Static markup, so every arm can assert it.
        const t = document.querySelector('#controlsOverlay table');
        const head = t ? [...t.querySelectorAll('tr')][0] : null;
        r.controlsGamepadCol = !!(head && /gamepad/i.test(head.textContent || ''));
        return r;
      } catch (e) { return { error: String(e).slice(0, 120) }; }
    }).catch(() => null);

    // ---- DREAMCAST ON A CONSOLE: THE SHELL AND CANVAS DELTAS ----------------
    // These DO vary with the arm and are the console arm's arm-difference proof.
    // __dcProbe().consoleUA is deliberately NOT the proof: it is the page echoing
    // back the UA string the harness just set, so it shows the UA took, not that
    // anything changed. The canvas dimensions and the shell flip are real deltas.
    //
    // ⚠ height-equality holds only while the viewport is WIDER than 4:3. The
    // stylesheet carries a `@media (max-aspect-ratio: 4/3)` branch that flips to
    // width:100%/height:auto, where equal heights would fail legitimately. The
    // console arm pins 1920x1080 (aspect 1.78) so the wide branch applies; the
    // 4:3 ratio cell is the viewport-independent half and catches a stretch.
    out.dcConsole = await page.evaluate(() => {
      try {
        // Each page names its canvas and wrapper differently, and the EXPECTED RATIO
        // differs too — gba is 240x160 = 3:2 while the other five display at 4:3.
        // (gamecube's 640x528 = 1.2121 is its BACKING STORE, not its display aspect;
        // gamecube.html:58-59 letterboxes at 4/3 and is the authority.  Asserting
        // 1.2121 would pin a ~10% vertical stretch as "correct".)
        // The ratio is asserted per page in invariantFor, not here; this only reports.
        const PAIRS = [['dc-canvas', 'canvasWrap'], ['canvas', 'canvasDiv'], ['canvas', 'canvasWrap']];
        let c = null, w = null;
        for (const [ci, wi] of PAIRS) {
          const cc = document.getElementById(ci), ww = document.getElementById(wi);
          if (cc && ww) { c = cc; w = ww; break; }
        }
        if (!c || !w) return null;
        const cr = c.getBoundingClientRect(), wr = w.getBoundingClientRect();
        // COMPUTED aspect-ratio, not just the measured box.  gba's #canvasDiv ships
        // `display:none` until the emulator starts, so its canvas has NO box to measure
        // before boot and every dimension above reads 0.  getComputedStyle still resolves
        // on a display:none element, so this proves the .console-ua RULE MATCHED — which
        // is the thing under test — without booting a game or mutating the page.
        const cssAspect = (() => { try { return getComputedStyle(c).aspectRatio; } catch (e) { return null; } })();
        const boxless = !(cr.width > 0 && cr.height > 0);
        // The DESKTOP CONTAINER id differs per page — dreamcast/gamecube call it
        // `wrap`, n64 calls it `desktop` (n64/index.html:2689 hides $('desktop')).
        // Asserting dreamcast's id everywhere reports null and VOIDs a page that is
        // actually correct, which is what the first version of this did.
        const vis = (id) => { const e = document.getElementById(id);
                              return e ? getComputedStyle(e).display !== 'none' : null; };
        const visAny = (ids) => { for (const id of ids) { const v = vis(id); if (v !== null) return v; }
                                  return null; };
        return {
          canvasW: Math.round(cr.width), canvasH: Math.round(cr.height),
          wrapH: Math.round(wr.height),
          fillsWrapH: Math.abs(cr.height - wr.height) <= 1,
          ratio: cr.height ? +(cr.width / cr.height).toFixed(3) : null,
          consoleClass: document.documentElement.classList.contains('console-ua'),
          cssAspect, boxless,
          // gba names them differently again: #maindiv is its desktop shell and #spShell
          // its phone shell (gba.html:468 / :534).  visAny takes the first id that EXISTS,
          // so adding them here is additive and cannot change the other five pages.
          wrapShown: visAny(['wrap', 'desktop', 'maindiv']),
          shellShown: visAny(['mobileShell', 'spShell']),
          canvasParent: c.parentElement ? c.parentElement.id : null,
        };
      } catch (e) { return { error: String(e).slice(0, 120) }; }
    }).catch(() => null);

    // ---- THE ON-SCREEN CONTROLS, AT PHONE SIZE ------------------------------
    // All three shells share one class vocabulary (.faceBtn / .shoulderBtn /
    // .dpadDisc / .sysBtn / .menuBtn), so one selector asks every page the same
    // question — the same reason window.__cap has one shape. The controls are
    // laid out behind the splash rather than absent, so they are measurable
    // before Start and this costs no emulator boot.
    //
    // Two of these are unambiguous breakage and one is a judgement call, and
    // they are kept apart on purpose: a control OFF THE SCREEN or a page that
    // scrolls sideways is unreachable, full stop. A control smaller than the
    // 44x44 CSS-px comfortable minimum is a quality warning, and folding a
    // warning into the pass/fail gate is how a gate stops being believed.
    out.touchTargets = null;
    if (arm.viewport && arm.viewport.hasTouch) {
      out.touchTargets = await page.evaluate(() => {
        const SEL = '.faceBtn, .shoulderBtn, .dpadDisc, .sysBtn, .menuBtn, #mobileSplashStart, #mobileSplashDiag';
        const MIN = 44;
        const vw = window.innerWidth, vh = window.innerHeight;
        const all = [...document.querySelectorAll(SEL)].map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.id || String(e.className), w: Math.round(r.width), h: Math.round(r.height),
                   l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
        });
        const laidOut = all.filter((x) => x.w > 0 && x.h > 0);
        return {
          viewport: vw + 'x' + vh,
          count: laidOut.length,
          smallerThan44: laidOut.filter((x) => x.w < MIN || x.h < MIN).map((x) => `${x.id} ${x.w}x${x.h}`),
          offscreen: laidOut.filter((x) => x.r <= 0 || x.b <= 0 || x.l >= vw || x.t >= vh).map((x) => x.id),
          horizontalScroll: document.documentElement.scrollWidth > vw + 1,
          scrollWidth: document.documentElement.scrollWidth,
        };
      }).catch(() => null);
    }

    // SPEC-DRIFT CROSS-CHECK. The rig keeps its own copy of each page's
    // requirement spec (it needs one before a browser exists), and the module
    // ships the authoritative one. Two copies of a config that are ASSUMED equal
    // is precisely how this project once ran a whole campaign comparing two
    // identical arms. So the rig compares them on every cell and fails loudly.
    out.specMatchesPage = await page.evaluate((id, mine) => {
      const theirs = window.Capability && window.Capability.SPECS && window.Capability.SPECS[id];
      if (!theirs) return 'page publishes no spec for ' + id;
      const a = JSON.stringify(Object.keys(mine).sort().map((k) => [k, mine[k]]));
      const b = JSON.stringify(Object.keys(theirs).sort().map((k) => [k, theirs[k]]));
      return a === b ? true : `rig=${a} page=${b}`;
    }, pg.id, pg.spec).catch((e) => 'evaluate failed: ' + String(e).slice(0, 80));

    // The page's own honest verdict, computed by the SHARED module against the
    // page's OWN spec. This is the line a visitor would read.
    out.verdict = await page.evaluate((spec) => {
      if (!window.Capability) return null;
      const v = window.Capability.verdict(spec);
      return { level: v.level, short: v.short,
               blockers: window.Capability.blockers(spec).map((b) => b.id) };
    }, pg.spec).catch(() => null);

    // Does the page still have a working diagnostic route on this device? The
    // report is the ONLY artefact a visitor on a broken device can send.
    out.report = await page.evaluate(() => {
      if (!window.Capability) return null;
      const t = window.Capability.text();
      return { len: t.length, hasHeader: t.indexOf('--- CAPABILITY') === 0,
               // The decisive line must be near the TOP. A rolling tail evicts
               // whatever prints earliest, and the capability line prints once.
               capLineIdx: t.indexOf('[cap] WebGPU'), noUndefined: t.indexOf('undefined') < 0 };
    }).catch(() => null);

    // ---- DOES THE GATE SURVIVE BEING TAPPED? --------------------------------
    // Reading `.disabled` is not the property that matters; NOT STARTING is. The
    // two are not the same thing, and the gap between them was a shipped bug:
    // Chrome does not dispatch `click`/`mousedown` on a disabled form control
    // but DOES dispatch `pointerdown`/`touchstart`, and both mobile splash Start
    // handlers are bound to `pointerdown`. So this presses the button for real —
    // a touch tap where the arm has touch, a mouse click otherwise — and asks
    // the page what happened, instead of asking an attribute what it thinks.
    //
    // Only on cells that are BLOCKED: on a healthy page a tap would (correctly)
    // start an emulator and pull a large ROM, which is not this rig's business.
    out.tap = null;
    if (out.verdict && out.verdict.blockers && out.verdict.blockers.length > 0) {
      out.tap = await (async () => {
        const t = { blockers: out.verdict.blockers };
        // Prefer the mobile splash Start: it is the one a phone visitor sees,
        // and the one whose handler goes through pointerdown.
        const target = await page.evaluate(() => {
          const pick = (id) => {
            const e = document.getElementById(id);
            if (!e) return null;
            const r = e.getBoundingClientRect();
            const cs = getComputedStyle(e);
            if (cs.display === 'none' || cs.visibility === 'hidden' || r.height <= 0) return null;
            return { id, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
          };
          return pick('mobileSplashStart') || pick('btnStart');
        }).catch(() => null);
        if (!target) { t.skipped = 'no visible Start control to press'; return t; }
        t.target = target.id;
        // THE VISITOR-FACING WITNESS, uniform across all three pages: every one
        // of them hides #mobileSplash as the first act of starting, and that
        // splash is where the explanation lives. Plus the page-specific witness
        // where one exists.
        const snap = () => page.evaluate(() => {
          const sp = document.getElementById('mobileSplash');
          const ban = document.getElementById('capBanner');
          return {
            splash: sp ? getComputedStyle(sp).display : null,
            banner: ban ? getComputedStyle(ban).display !== 'none' : false,
            gcStarted: !!window.__gcStartedAtMs,
            // Any worker the page spawned to run a core is a start it should not
            // have made. Cheap, page-agnostic, and observable from here.
            status: ((document.getElementById('mobileStatus') || document.getElementById('status') || {})
                      .textContent || '').slice(0, 120),
          };
        }).catch(() => null);
        t.before = await snap();
        if (arm.viewport && arm.viewport.hasTouch) await page.touchscreen.tap(target.x, target.y).catch((e) => { t.tapErr = String(e).slice(0, 90); });
        else await page.mouse.click(target.x, target.y).catch((e) => { t.tapErr = String(e).slice(0, 90); });
        await sleep(2500);
        t.after = await snap();
        // "It started" = the splash that held the explanation is gone, or a
        // page-specific start witness fired.
        t.splashHidden = !!(t.before && t.after && t.before.splash === 'flex' && t.after.splash === 'none');
        t.startWitness = !!(t.after && t.after.gcStarted && !(t.before && t.before.gcStarted));
        t.started = t.splashHidden || t.startWitness;
        // A blocked page must still be EXPLAINING itself after the tap. Losing
        // the splash is only harmful because it takes the explanation with it,
        // so the banner surviving is the thing that decides how bad it is.
        t.stillExplains = !!(t.after && (t.after.banner || t.after.splash === 'flex'
                             || /cannot|missing|not support|unavailable|would not/i.test(t.after.status || '')));
        return t;
      })();
    }

    await page.close();
  } catch (e) {
    out.error = String(e).slice(0, 300);
  } finally {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RIG SELF-TEST. The rig's own load-bearing assumption is that a fresh
// userDataDir per cell prevents cross-origin isolation from leaking between
// cells. That assumption is what produced twelve identical rows when it was
// merely believed, so it is measured here: the leak is deliberately REPRODUCED
// in one profile, and a fresh profile is required not to show it.
//
// If `leakReproduced` is false, the rig cannot prove its own isolation works,
// and every no-coi row below is untrustworthy. It is reported either way.
// ---------------------------------------------------------------------------
async function rigSelfTest() {
  const t = {};
  const coiOf = async (page, url) => {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__cap && window.__cap.ver === 1', { timeout: 45000 }).catch(() => {});
    return page.evaluate(() => !!self.crossOriginIsolated);
  };
  // (a) FRESH profile, n64/ only. n64/index.html loads no coi-serviceworker, so
  //     this must be false. This is the reference.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-self-a-'));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('./browser_leak_guard.js')).default.guard(b, import.meta.url); } catch (_e) {}

    const p = await b.newPage();
    t.freshN64Coi = await coiOf(p, '/n64/');
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  // (b) SAME profile: gamecube.html first (which installs COOP/COEP for the
  //     whole origin), THEN n64/. If isolation leaks across pages — and it does
  //     — n64/ now reports true despite loading no service worker of its own.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-self-b-'));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // [leak-guard] a SIGKILLed parent ORPHANS this browser (uncatchable in-process);
    // `node tools/browser_leak_guard.js reap` kills it once this process is gone.
    try { (await import('./browser_leak_guard.js')).default.guard(b, import.meta.url); } catch (_e) {}
    const p = await b.newPage();
    t.gcCoi = await coiOf(p, '/gamecube.html');
    await sleep(600);
    t.n64AfterGcCoi = await coiOf(p, '/n64/');
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  t.leakReproduced = (t.freshN64Coi === false && t.n64AfterGcCoi === true);
  t.isolationHolds = (t.freshN64Coi === false);
  t.note = t.leakReproduced
    ? 'CONFIRMED: visiting gamecube.html isolates the origin for n64/ in the same profile. '
    + 'A shared-profile matrix would report identical rows. Per-cell fresh profiles are load-bearing.'
    : t.isolationHolds
      ? 'Isolation did not leak in this run, so the fresh-profile guarantee could not be demonstrated '
      + 'by contrast. Rows are still per-cell isolated, but this run does not PROVE the guarantee matters.'
      : 'A FRESH profile already reported n64/ as cross-origin-isolated. Profile isolation is NOT working '
      + 'and every row in this run is suspect.';
  return t;
}

// ---------------------------------------------------------------------------
// The root n64.html redirect. It is a meta-refresh plus a location.replace, and
// a meta-refresh is fragile, so both routes are tested separately AND the
// no-JavaScript case is tested on its own — that is the one the script cannot
// cover for.
// ---------------------------------------------------------------------------
async function redirectTest() {
  const t = { };
  const run = async (label, opts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-rd-${label}-`));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // [leak-guard] a SIGKILLed parent ORPHANS this browser (uncatchable in-process);
    // `node tools/browser_leak_guard.js reap` kills it once this process is gone.
    try { (await import('./browser_leak_guard.js')).default.guard(b, import.meta.url); } catch (_e) {}
    const p = await b.newPage();
    if (opts.noJs) await p.setJavaScriptEnabled(false);
    if (opts.slow) {
      const cdp = await p.target().createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions',
        { offline: false, downloadThroughput: 30 * 1024, uploadThroughput: 20 * 1024, latency: 800 });
    }
    const r = { };
    try {
      const resp = await p.goto(BASE + (opts.path || '/n64.html'), { waitUntil: 'domcontentloaded' });
      r.status = resp && resp.status();
      // The meta-refresh fires after load, so give it a beat; without JS this is
      // the ONLY mechanism, which is exactly why it gets its own arm.
      await sleep(opts.slow ? 4000 : 1500);
      r.landedOn = p.url();
      r.arrived = /\/n64\/(\?|$)/.test(p.url());
      // Arrived is not enough: the page it landed on must be the working one.
      r.pageWorks = opts.noJs ? null : await p.evaluate(() => !!document.getElementById('btnStart')).catch(() => false);
      // A visitor whose redirect does NOT fire must still be given a link. This
      // has to be read from n64.html's OWN SOURCE, not from the live DOM: by the
      // time the DOM is readable the redirect has usually already replaced the
      // document, so a DOM query reports "no link" on a page that has one. The
      // first cut did exactly that and printed link=false on all four rows.
      r.hasVisibleLink = /<a[^>]+href="\/n64\/"/.test(await (await fetch(BASE + '/n64.html')).text());
      // The query string must survive: /n64.html?game=x is a real inbound shape.
      if (opts.path && opts.path.indexOf('?') >= 0) r.queryKept = p.url().indexOf('game=mariokart.z64') >= 0;
    } catch (e) { r.error = String(e).slice(0, 200); }
    await b.close(); fs.rmSync(dir, { recursive: true, force: true });
    return r;
  };
  t.js = await run('js', {});
  t.noJs = await run('nojs', { noJs: true });
  t.slow = await run('slow', { slow: true });
  t.query = await run('query', { path: '/n64.html?game=mariokart.z64' });
  // With JS: location.replace does it. Without JS: the meta-refresh must, and if
  // it somehow does not, the visitor must at minimum see a working link — that
  // is the floor, and it is asserted separately so a meta-refresh regression
  // cannot hide behind the anchor.
  t.ok = !!(t.js.arrived && t.js.pageWorks && t.slow.arrived
            && (t.noJs.arrived || t.noJs.hasVisibleLink) && t.query.arrived && t.query.queryKept !== false);
  t.metaRefreshWorksWithoutJs = t.noJs.arrived === true;
  return t;
}

// ---------------------------------------------------------------------------
// lib/capability.test.js, run in each page under ?captest=1.
//
// The matrix already fails on SPEC drift. This closes the other half: the specs
// can agree perfectly while the code that turns a report into a verdict is
// broken, and the suite is the only thing that exercises the guards against
// synthetic broken devices this rig cannot manufacture. Gating on `.done` and
// not on the object's existence is deliberate — the suite is asynchronous, and a
// rig that polled for `window.__capTest` once latched a 1-assertion result and
// called it clean.
// ---------------------------------------------------------------------------
async function captestRun(pageList) {
  const out = { pages: {}, ok: true };
  // ⚠ `pageList`, NOT the module-level PAGES const.  This loop and noJsTest's used to
  // read PAGES directly, so `--page=snes` still booted EVERY page here — twice, once per
  // phase — before the first console.log (:1274 area) could print anything.  With 3 pages
  // that was merely wasteful; adding ps1 and snes made it 5, and a single-page run looked
  // like a HANG: zero output for 16m35s, killed by hand, its Chrome orphaned.  It was
  // never an unbounded wait — each evaluate is bounded by CDP protocolTimeout (180 s
  // default) and ~12 of them per wedged page is exactly that duration.
  for (const pg of (pageList || PAGES)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-ct-${pg.id}-`));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try { (await import('./browser_leak_guard.js')).default.guard(b, import.meta.url); } catch (_e) {}
    const p = await b.newPage();
    const r = { };
    try {
      await p.goto(`${BASE}${pg.url}${pg.url.includes('?') ? '&' : '?'}captest=1`, { waitUntil: 'domcontentloaded' });
      r.done = await p.waitForFunction('window.__capTest && window.__capTest.done === true', { timeout: 90000 })
        .then(() => true).catch(() => false);
      Object.assign(r, await p.evaluate(() => (window.__capTest ? {
        pass: window.__capTest.pass, fail: window.__capTest.fail, expect: window.__capTest.expect,
        failures: window.__capTest.lines.filter((l) => l.indexOf('CAPTEST FAIL') === 0).slice(0, 12),
      } : { }))
        .catch(() => ({ })));
    } catch (e) { r.error = String(e).slice(0, 200); }
    await b.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true });
    // `expect` is a FLOOR, not an equality: a suite that silently stopped running
    // most of itself reports 0 failures too.
    r.ok = r.done === true && r.fail === 0 && typeof r.pass === 'number' && r.pass >= (r.expect || 100);
    out.pages[pg.id] = r;
    if (!r.ok) out.ok = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// JAVASCRIPT OFF. The floor case, and the only one no amount of runtime gating
// can reach: with scripting disabled the capability layer never runs, so
// whatever the raw markup says IS the whole experience. Measured 2026-09-01:
// none of the three pages had a <noscript>, so the visitor got the full shell —
// an enabled-looking Start button that does nothing when pressed, which is the
// same dead button the runtime gate exists to prevent.
// ---------------------------------------------------------------------------
async function noJsTest(pageList) {
  const out = { pages: {}, ok: true };
  for (const pg of (pageList || PAGES)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dmx-nojs-${pg.id}-`));
    const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir,
      protocolTimeout: 120000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try { (await import('./browser_leak_guard.js')).default.guard(b, import.meta.url); } catch (_e) {}
    const p = await b.newPage();
    await p.setJavaScriptEnabled(false);
    const r = { };
    try {
      await p.goto(BASE + pg.url, { waitUntil: 'domcontentloaded' });
      // ⚠ page.evaluate() CANNOT BE USED HERE. `setJavaScriptEnabled(false)` is
      // `Emulation.setScriptExecutionDisabled`, which disables script execution
      // for the frame — including the Runtime.evaluate that page.evaluate() is
      // built on. (redirectTest above sidesteps the same problem by skipping its
      // `pageWorks` evaluate on the noJs arm and reading the source over HTTP
      // instead.) Reading the SOURCE would only prove the markup is present,
      // which is a presence check — and this file exists because presence checks
      // lie. So the measurement goes through the CDP DOM/CSS domains, which do
      // not run page script: the browser's own computed style for the element it
      // actually laid out, with scripting genuinely off.
      const cdp = await p.target().createCDPSession();
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const styleOf = async (nodeId) => {
        const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
        const m = {};
        for (const kv of computedStyle) m[kv.name] = kv.value;
        return m;
      };
      const findOne = async (sel) => {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
        return nodeId || null;
      };
      // Rendered, per the browser: a box with real height and no display:none /
      // visibility:hidden anywhere in the chain (getBoxModel throws when the
      // element is not rendered at all, which is exactly the signal wanted).
      const rendered = async (nodeId) => {
        if (!nodeId) return false;
        const cs = await styleOf(nodeId);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        try {
          const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
          return !!(model && model.height > 0);
        } catch (e) { return false; }
      };
      const msgId = await findOne('#nojs');
      r.explains = await rendered(msgId);
      if (msgId) {
        const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId: msgId });
        r.says = outerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
      } else { r.says = null; }
      r.startShown = [];
      for (const sel of ['#btnStart', '#mobileSplashStart']) {
        if (await rendered(await findOne(sel))) r.startShown.push(sel.slice(1));
      }
      await cdp.detach().catch(() => {});
    } catch (e) { r.error = String(e).slice(0, 200); }
    await b.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true });
    r.ok = r.explains === true && Array.isArray(r.startShown) && r.startShown.length === 0;
    out.pages[pg.id] = r;
    if (!r.ok) out.ok = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdicts. A cell only gets one if its arm's proof held.
// ---------------------------------------------------------------------------
function judge(arm, pg, cell, baselineCell) {
  const v = { arm: arm.id, page: pg.id };
  if (cell.error) { v.verdict = 'ERROR'; v.why = cell.error; return v; }
  if (!cell.capReady) { v.verdict = 'ERROR'; v.why = 'window.__cap never resolved — lib/capability.js did not run'; return v; }
  if (cell.specMatchesPage !== true) {
    v.verdict = 'ERROR';
    v.why = 'SPEC DRIFT — the rig and the page disagree about what this page requires: ' + cell.specMatchesPage;
    return v;
  }

  // THE ARM-DIFFERENCE PROOF. No proof, no verdict.
  const inv = arm.invariantFor && arm.invariantFor[pg.id];
  const proof = inv ? inv(cell) : arm.proof(baselineCell || cell, cell);
  v.proof = proof.detail;
  v.proofHeld = proof.ok;
  if (!proof.ok) {
    v.verdict = null;
    v.void = 'ARM DID NOT TAKE — no verdict is reported for this cell. ' + proof.detail;
    return v;
  }

  const bl = cell.verdict ? cell.verdict.blockers : [];
  v.blockers = bl;
  const s = cell.start || {};
  const startShown = [s.desktop, s.mobile].filter((x) => x && x.visible);
  // THE PROPERTY THAT MATTERS: a page must never present an ENABLED Start when
  // the shared module says a required capability is missing. If it does, the
  // visitor clicks it and gets a black screen with no explanation — which is
  // exactly the reported bug.
  const enabledAndBlocked = bl.length > 0 && startShown.some((x) => !x.disabled);
  v.startEnabled = startShown.map((x) => !x.disabled);
  // ...AND THE SAME PROPERTY MEASURED BY PRESSING IT, which is not the same
  // question. `.disabled` was true on gamecube.html and n64/index.html in the
  // cells below and the emulator started anyway, because their splash handlers
  // listen on `pointerdown` and Chrome does not suppress that on a disabled
  // control. An attribute is a claim; the tap is the evidence.
  v.tapStartedAnyway = !!(cell.tap && cell.tap.started);
  v.tapStillExplains = cell.tap ? cell.tap.stillExplains : null;
  v.tapTarget = cell.tap ? (cell.tap.target || cell.tap.skipped) : null;
  // ...AND THE THIRD WAY A GATE CAN BE DISHONEST, which is the one a real
  // visitor hit: nobody pressed anything and the page booted at load anyway.
  // A page that reserves a 2 GB heap and starts its emulator core on a device
  // its own capability layer has already judged unable to render is not gated,
  // however grey the button is. Only asserted where the page publishes the
  // witness (window.__dcProbe().boot); elsewhere it is null and changes nothing.
  v.bootedWhileBlocked = !!(bl.length > 0 && cell.boot && cell.boot.started === true);
  v.bootWitness = cell.boot ? (cell.boot.started ? 'BOOTED'
                              : ('not started' + (cell.boot.gatedBy ? ' (gated by ' + cell.boot.gatedBy.join(',') + ')' : '')))
                            : null;
  v.honestGate = !enabledAndBlocked && !v.tapStartedAnyway && !v.bootedWhileBlocked;
  v.reportUsable = !!(cell.report && cell.report.hasHeader && cell.report.noUndefined && cell.report.len > 200);
  v.enginesDiffer = !!arm.enginesDiffer;
  // Unreachable controls fail the cell; small ones are reported, not gated.
  if (cell.touchTargets) {
    v.touch = { count: cell.touchTargets.count, small: cell.touchTargets.smallerThan44,
                offscreen: cell.touchTargets.offscreen, hScroll: cell.touchTargets.horizontalScroll };
    v.touchReachable = cell.touchTargets.offscreen.length === 0 && !cell.touchTargets.horizontalScroll;
  }

  if (bl.length === 0) v.verdict = 'RUNS';
  else if (v.honestGate) v.verdict = 'BLOCKED-HONESTLY';
  else v.verdict = 'FAILS-SILENTLY';
  v.why = bl.length === 0 ? 'all required capabilities present'
        : (cell.verdict && cell.verdict.short) || ('missing: ' + bl.join(','));
  if (v.tapStartedAnyway) {
    v.why = `Start reads disabled but PRESSING IT started the emulator anyway (target=${v.tapTarget}); `
          + (v.tapStillExplains ? 'the explanation is at least still on screen. ' : 'and the explanation is GONE. ')
          + v.why;
  }
  if (v.bootedWhileBlocked) {
    v.why = `NOBODY PRESSED ANYTHING AND THE PAGE BOOTED ANYWAY at load `
          + `(heap reserved: ${cell.boot.heapMaxMB} MB). Gating the Start button does not gate a boot `
          + `that begins before the button exists. ` + v.why;
  }
  return v;
}

// ---------------------------------------------------------------------------
async function main() {
  const arms = ARMS.filter((a) => !ONLY_ARM || a.id === ONLY_ARM || a.baseline);
  const pages = PAGES.filter((p) => !ONLY_PAGE || p.id === ONLY_PAGE);
  const result = { base: BASE, startedAt: new Date().toISOString(), load: os.loadavg().map((n) => +n.toFixed(2)),
                   cells: [], verdicts: [], rig: null, redirect: null, captest: null, nojs: null };

  result.rig = await rigSelfTest();
  result.redirect = await redirectTest();
  result.captest = await captestRun(pages);
  result.nojs = await noJsTest(pages);

  // Cells run SERIALLY. Concurrent Chrome instances contend for CPU, and this
  // project has measured matched-pair noise at +-25% under load (CLAUDE.md gate
  // #10). Nothing here is a timing measurement except fetchMs, but fetchMs is
  // the slow-net arm's entire proof, so it must not be raced.
  const baselineByPage = {};
  for (const arm of arms) {
    for (const pg of pages) {
      const cell = await runCell(arm, pg);
      result.cells.push(cell);
      if (arm.baseline) baselineByPage[pg.id] = cell;
      result.verdicts.push(judge(arm, pg, cell, baselineByPage[pg.id]));
    }
  }

  result.load = { at_start: result.load, at_end: os.loadavg().map((n) => +n.toFixed(2)) };
  const v = result.verdicts;
  result.summary = {
    cells: v.length,
    runs: v.filter((x) => x.verdict === 'RUNS').length,
    blockedHonestly: v.filter((x) => x.verdict === 'BLOCKED-HONESTLY').length,
    failsSilently: v.filter((x) => x.verdict === 'FAILS-SILENTLY').length,
    voided: v.filter((x) => x.verdict === null).length,
    errors: v.filter((x) => x.verdict === 'ERROR').length,
  };
  // THE GATE. A silent failure is the bug this whole exercise is about. A voided
  // arm is not a pass either: it means the rig did not create the condition.
  result.summary.tapStartedAnyway = v.filter((x) => x.tapStartedAnyway).length;
  result.summary.bootedWhileBlocked = v.filter((x) => x.bootedWhileBlocked).length;
  result.summary.controlsUnreachable = v.filter((x) => x.touchReachable === false).length;
  result.ok = result.summary.controlsUnreachable === 0
           && result.summary.failsSilently === 0 && result.summary.errors === 0
           && result.summary.voided === 0 && result.redirect.ok === true
           && result.rig.isolationHolds === true
           && result.captest.ok === true && result.nojs.ok === true;

  if (JSON_ONLY) { console.log(JSON.stringify(result, null, 1)); return; }

  // ---- human-readable ----
  const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n).slice(0, n);
  console.log(`\nDEVICE MATRIX  base=${BASE}  load ${result.load.at_start[0]} -> ${result.load.at_end[0]}`);
  console.log('\n--- RIG SELF-TEST (does the fresh-profile guarantee actually hold?) ---');
  console.log(`  fresh profile, n64/ alone      crossOriginIsolated = ${result.rig.freshN64Coi}`);
  console.log(`  same profile, after gamecube   crossOriginIsolated = ${result.rig.n64AfterGcCoi}`);
  console.log(`  leak reproduced = ${result.rig.leakReproduced}   isolation holds = ${result.rig.isolationHolds}`);
  console.log(`  ${result.rig.note}`);

  console.log('\n--- ROOT n64.html REDIRECT ---');
  for (const k of ['js', 'noJs', 'slow', 'query']) {
    const r = result.redirect[k];
    console.log(`  ${pad(k, 6)} HTTP${r.status}  arrived=${pad(r.arrived, 5)} landed=${pad(r.landedOn, 40)}`
      + ` pageWorks=${pad(r.pageWorks, 5)} link=${r.hasVisibleLink}`);
  }
  console.log(`  meta-refresh works with JS disabled = ${result.redirect.metaRefreshWorksWithoutJs}`);
  console.log(`  redirect ok = ${result.redirect.ok}`);

  console.log('\n--- ?captest=1  (lib/capability.test.js, in the page) ---');
  for (const [id, r] of Object.entries(result.captest.pages)) {
    console.log(`  ${pad(id, 10)} ${r.ok ? 'PASS' : 'FAIL'}  pass=${r.pass} fail=${r.fail} `
      + `(floor ${r.expect}) done=${r.done}${r.error ? '  ' + r.error : ''}`);
    (r.failures || []).forEach((l) => console.log(`      ${l}`));
  }

  console.log('\n--- JAVASCRIPT DISABLED (the floor no runtime gate can reach) ---');
  for (const [id, r] of Object.entries(result.nojs.pages)) {
    console.log(`  ${pad(id, 10)} ${r.ok ? 'PASS' : 'FAIL'}  explains=${r.explains} `
      + `startControlsShown=[${(r.startShown || []).join(',')}]${r.error ? '  ' + r.error : ''}`);
    if (r.says) console.log(`      "${r.says}"`);
  }

  console.log('\n--- MATRIX ---');
  console.log(`  ${pad('arm', 16)} ${pad('page', 10)} ${pad('verdict', 18)} ${pad('start', 14)} ${pad('tap', 24)} ${pad('boot', 26)} blockers`);
  for (const x of result.verdicts) {
    const st = x.verdict === null ? '' : (x.startEnabled || []).map((e) => (e ? 'enabled' : 'DISABLED')).join(',');
    // The tap column is the one that would have caught the shipped bug: an
    // attribute says DISABLED, the press says otherwise.
    const tap = x.verdict === null ? ''
      : x.tapTarget === null || x.tapTarget === undefined ? '-'
      : x.tapStartedAnyway ? `STARTED via ${x.tapTarget}`
      : `inert (${x.tapTarget})`;
    const boot = x.verdict === null ? '' : (x.bootWitness === null ? '-' : x.bootWitness);
    console.log(`  ${pad(x.arm, 16)} ${pad(x.page, 10)} ${pad(x.verdict === null ? 'VOID (no verdict)' : x.verdict, 18)}`
      + ` ${pad(st, 14)} ${pad(tap, 24)} ${pad(boot, 26)} ${(x.blockers || []).join(',')}`);
    if (x.verdict === null) console.log(`      ${x.void}`);
    else if (x.verdict === 'FAILS-SILENTLY') console.log(`      !! ${x.why}`);
  }

  console.log('\n--- ARM-DIFFERENCE PROOFS (an arm without one measured nothing) ---');
  for (const x of result.verdicts) {
    if (x.page !== pages[0].id) continue;   // one line per arm
    console.log(`  ${pad(x.arm, 16)} ${x.proofHeld ? 'HELD' : 'DID NOT HOLD'} — ${x.proof}`);
  }

  const tt = result.verdicts.filter((x) => x.touch);
  if (tt.length) {
    console.log('\n--- ON-SCREEN CONTROLS AT PHONE SIZE (measured, not assumed) ---');
    for (const x of tt) {
      console.log(`  ${pad(x.arm, 14)} ${pad(x.page, 10)} ${x.touch.count} controls · reachable=${x.touchReachable}`
        + ` · offscreen=[${x.touch.offscreen.join(',')}] · horizontalScroll=${x.touch.hScroll}`);
      if (x.touch.small.length) console.log(`      under 44x44 CSS px (advisory): ${x.touch.small.join(' · ')}`);
    }
  }

  const ed = result.verdicts.filter((x) => x.enginesDiffer);
  if (ed.length) {
    console.log('\n--- LIMIT: these rows ran CHROME\'S ENGINE behind an iOS user agent ---');
    console.log(`  ${[...new Set(ed.map((x) => x.arm))].join(', ')}: viewport/touch/UA are real, WebKit is not.`);
    console.log('  These rows CANNOT clear the pages on real iOS Safari. That needs hardware.');
  }

  console.log(`\nSUMMARY ${JSON.stringify(result.summary)}`);
  console.log(`OK = ${result.ok}\n`);
  const outPath = process.env.MATRIX_OUT || '/tmp/device-matrix.json';
  fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
  console.log(`full JSON -> ${outPath}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
