// lib/xboxinput.js — stop the Xbox stick from driving Edge's CURSOR instead of the game.
//
// THE BUG THIS EXISTS FOR
// On Xbox, Edge ships a virtual mouse: the LEFT STICK moves an on-screen cursor and A
// clicks it. That is how you operate an ordinary web page with a controller, and it is
// on by DEFAULT. For an emulator it is a defect — you push the stick to move the
// character and the cursor slides across the screen instead. Reported as "as soon as I
// touch the joystick on Dreamcast on Xbox Edge, the cursor is used again."
//
// Nothing in the button-mapping layer can fix this. The stick never reaches the page as
// gamepad axes while the shell is consuming it as pointer input; it is resolved one level
// up, by telling the shell to stop emulating.
//
//   navigator.gamepadInputEmulation = 'mouse'     // DEFAULT: stick -> cursor, A -> click
//                                   = 'keyboard'  // d-pad -> arrow keys
//                                   = 'gamepad'   // NO emulation; input only via the
//                                                 // Gamepad API — which is what an
//                                                 // emulator wants
//
// ⚠ IT CANNOT SIMPLY BE SET AT PAGE LOAD. 'gamepad' removes the cursor outright, so a
// visitor who lands on the page with it already set has no way to click Start, pick a
// ROM, or reach any button — the page becomes unoperable with the only input device the
// machine has. So the mode MUST follow run state:
//     not running / menus / paused / backgrounded -> 'mouse'   (you can click things)
//     emulator running                            -> 'gamepad' (the stick plays the game)
// and there must be an escape hatch to get the cursor back WITHOUT quitting.
//
// ⚠ WHAT IS AND IS NOT PROVEN. `gamepadInputEmulation` is an Xbox/Edge extension; it does
// not exist in desktop Chrome, so on every machine this repo is developed and tested on,
// `supported` is false and every call here is a no-op. The test rig can therefore prove
// that THIS PAGE ASKS FOR THE RIGHT MODE AT THE RIGHT TIME (by installing a spy property
// before load) but CANNOT prove the Xbox shell honours it. That last step is hardware.
// Do not let a green test row be read as "the cursor problem is fixed on Xbox".
(function () {
  'use strict';

  var HAS = false;
  try { HAS = ('gamepadInputEmulation' in navigator); } catch (e) { HAS = false; }

  var wanted = 'mouse';    // what the page last ASKED for
  var applied = null;      // what actually got written (null if unsupported/threw)
  var lastError = null;
  var transitions = [];    // ordered log, so a test can assert ORDER, not just end state

  function apply(mode, why) {
    wanted = mode;
    transitions.push({ mode: mode, why: why || '', t: Math.round((self.performance || Date).now ? (self.performance ? performance.now() : Date.now()) : Date.now()) });
    if (transitions.length > 40) transitions.shift();
    if (!HAS) return false;
    try {
      navigator.gamepadInputEmulation = mode;
      applied = mode;
      return true;
    } catch (e) {
      lastError = String(e).slice(0, 120);
      return false;
    }
  }

  // ---- the two states -------------------------------------------------------
  // The stick drives the GAME. Call when the emulator actually starts running.
  function gameMode(why) { var ok = apply('gamepad', why || 'emulator running'); startWatch(); hint('game'); return ok; }
  // The stick drives the CURSOR. Call for menus, pause, and before any dialog — anything
  // where the visitor has to be able to point at something.
  // ⚠ It deliberately LEAVES THE WATCH RUNNING. Killing it here is what made the escape
  // hatch one-way; the visitor must always be able to hand the stick back to the game.
  function cursorMode(why) { return apply('mouse', why || 'page needs a pointer'); }
  // The emulator has actually STOPPED (or the page is going away). Only here is it right to
  // tear the watch down, because there is no game left to give the stick back to.
  function release(why) { stopWatch(); return apply('mouse', why || 'emulator stopped'); }

  // ---- escape hatch: LB + RB held together -----------------------------------
  // Needed because in 'gamepad' mode there is no cursor, so none of the page's own
  // buttons (Save / Load / Fullscreen / Controls) can be reached while a game runs.
  // LB+RB (standard-mapping buttons 4 and 5) held for 1.2s toggles the cursor back.
  // Chosen over a Menu double-tap because Menu is START in-game and gets double-tapped
  // legitimately; LB+RB held is not a gesture any of these guest consoles asks for.
  // ⚠ Deliberately NOT btn 8 (View) or btn 10/11 (L3/R3): View is consumed by the Edge
  // shell and is unobservable from the page, and L3/R3 are routed to browser back/forward.
  var HOLD_MS = 1200;
  var rafId = null, holdStart = 0, armed = false, latched = false;

  // ⚠ THIS WAS ONE-WAY AND IT WAS A REAL BUG (found by audit, 2026-09-05, before it ever
  // shipped to a console). cursorMode() used to call stopWatch(), which cancels the poll —
  // so the FIRST LB+RB press killed the very loop that watches for LB+RB. The stick then
  // drove the cursor for the rest of the session and the game could never get it back
  // without a page reload. The watch must therefore OUTLIVE a mode change: once armed it
  // keeps running until the emulator actually stops or the page goes away.
  function poll() {
    rafId = null;
    var pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { pads = []; }
    var down = false;
    for (var i = 0; i < pads.length; i++) {
      var p = pads[i];
      if (!p || !p.buttons || p.buttons.length < 6) continue;
      if (p.buttons[4] && p.buttons[4].pressed && p.buttons[5] && p.buttons[5].pressed) { down = true; break; }
    }
    var now = Date.now();
    if (down) {
      if (!holdStart) { holdStart = now; }
      else if (!latched && now - holdStart >= HOLD_MS) {
        // latched stops one long hold from flapping the mode every frame; it clears on release.
        latched = true;
        if (wanted === 'gamepad') { apply('mouse', 'LB+RB -> pointer'); hint('pointer'); }
        else { apply('gamepad', 'LB+RB -> game'); hint('game'); }
      }
    } else { holdStart = 0; latched = false; }
    schedule();
  }
  function schedule() {
    if (rafId !== null || !armed) return;
    try { rafId = requestAnimationFrame(poll); } catch (e) { rafId = null; }
  }
  function startWatch() { armed = true; holdStart = 0; latched = false; schedule(); }
  function stopWatch() {
    armed = false; holdStart = 0; latched = false;
    if (rafId !== null) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = null; }
  }

  // ---- tell the visitor the gesture exists ------------------------------------
  // An escape hatch nobody can discover is not an escape hatch. There is no keyboard on a
  // couch and no menu reachable without a pointer, so the page has to say it out loud.
  // ⚠ Placed at 8%/10% insets, NOT against the edge: a TV can overscan and crop roughly the
  // outer 5%, which would eat a corner-anchored hint entirely.
  var hintEl = null, hintTimer = null;
  function hint(mode) {
    if (!HAS) return;                       // only meaningful where the shell emulates input
    try {
      if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.id = 'xboxInputHint';
        hintEl.setAttribute('role', 'status');
        hintEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:10%;'
          + 'z-index:2147483000;background:rgba(0,0,0,.82);color:#fff;border:1px solid #666;'
          + 'border-radius:10px;padding:14px 22px;font:20px/1.35 -apple-system,BlinkMacSystemFont,'
          + '"Segoe UI",sans-serif;text-align:center;pointer-events:none;max-width:80vw;';
        (document.body || document.documentElement).appendChild(hintEl);
      }
      hintEl.textContent = (mode === 'game')
        ? 'Stick controls the game — hold LB + RB for the pointer'
        : 'Pointer restored — hold LB + RB to give the stick back to the game';
      hintEl.style.display = 'block';
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(function () { try { hintEl.style.display = 'none'; } catch (e) {} }, 6000);
    } catch (e) { /* a hint is never worth breaking a page over */ }
  }

  // ---- never strand a visitor without a cursor --------------------------------
  // If the page is backgrounded or unloaded while in 'gamepad' mode, the shell can be
  // left with no pointer on a page the visitor is no longer looking at. Restore on the
  // way out, and re-arm on the way back in only if a game was actually running.
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (wanted === 'gamepad') { stopWatch(); apply('mouse', 'page hidden'); wanted = 'gamepad'; } }
      else if (wanted === 'gamepad') { apply('gamepad', 'page visible again'); startWatch(); }
    });
    window.addEventListener('pagehide', function () { release('pagehide'); });
  } catch (e) {}

  window.XboxInput = {
    supported: HAS,
    gameMode: gameMode,
    cursorMode: cursorMode,
    release: release,
    // Exposed so a page's own Stop/Pause/dialog paths can hand the pointer back without
    // reaching into internals. AUDIT NOTE: at the time this shipped, six pages called
    // gameMode and NONE called cursorMode, so every toolbar button became unreachable the
    // moment a game started — the LB+RB toggle and the on-screen hint are what make that
    // survivable, and they are why both are load-bearing rather than nice-to-have.
    toggle: function (why) { return (wanted === 'gamepad') ? cursorMode(why) : gameMode(why); },
    // Reported for the test rig and the on-page diagnostics. `applied` is null on every
    // non-Xbox browser — that is correct, not a failure.
    report: function () {
      return { supported: HAS, wanted: wanted, applied: applied, lastError: lastError,
               watching: rafId !== null, armed: armed, holdMs: HOLD_MS,
               transitions: transitions.slice() };
    },
  };
})();
