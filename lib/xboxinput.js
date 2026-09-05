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
  function gameMode(why) { var ok = apply('gamepad', why || 'emulator running'); startWatch(); return ok; }
  // The stick drives the CURSOR. Call for menus, pause, stop, and before any dialog —
  // anything where the visitor has to be able to point at something.
  function cursorMode(why) { stopWatch(); return apply('mouse', why || 'page needs a pointer'); }

  // ---- escape hatch: LB + RB held together -----------------------------------
  // Needed because in 'gamepad' mode there is no cursor, so none of the page's own
  // buttons (Save / Load / Fullscreen / Controls) can be reached while a game runs.
  // LB+RB (standard-mapping buttons 4 and 5) held for 1.2s toggles the cursor back.
  // Chosen over a Menu double-tap because Menu is START in-game and gets double-tapped
  // legitimately; LB+RB held is not a gesture any of these guest consoles asks for.
  // ⚠ Deliberately NOT btn 8 (View) or btn 10/11 (L3/R3): View is consumed by the Edge
  // shell and is unobservable from the page, and L3/R3 are routed to browser back/forward.
  var HOLD_MS = 1200;
  var rafId = null, holdStart = 0;

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
      if (!holdStart) holdStart = now;
      else if (now - holdStart >= HOLD_MS) { holdStart = 0; cursorMode('LB+RB escape hatch'); return; }
    } else { holdStart = 0; }
    schedule();
  }
  function schedule() {
    if (rafId !== null) return;
    try { rafId = requestAnimationFrame(poll); } catch (e) { rafId = null; }
  }
  function startWatch() { holdStart = 0; schedule(); }
  function stopWatch() {
    holdStart = 0;
    if (rafId !== null) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = null; }
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
    window.addEventListener('pagehide', function () { stopWatch(); apply('mouse', 'pagehide'); });
  } catch (e) {}

  window.XboxInput = {
    supported: HAS,
    gameMode: gameMode,
    cursorMode: cursorMode,
    // Reported for the test rig and the on-page diagnostics. `applied` is null on every
    // non-Xbox browser — that is correct, not a failure.
    report: function () {
      return { supported: HAS, wanted: wanted, applied: applied, lastError: lastError,
               watching: rafId !== null, holdMs: HOLD_MS,
               transitions: transitions.slice() };
    },
  };
})();
