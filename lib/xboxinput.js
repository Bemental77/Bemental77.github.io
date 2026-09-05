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
  // `inGame` is what makes resume() safe: a page can hand the pointer back for a dialog
  // without having to know, at the point where it closes that dialog, whether a game is
  // actually running. Without it every caller would need its own copy of that state and
  // the ones that got it wrong would silently strand the stick in the wrong mode.
  var inGame = false;
  // The stick drives the GAME. Call when the emulator actually starts running.
  function gameMode(why) { inGame = true; var ok = apply('gamepad', why || 'emulator running'); startWatch(); hint('game'); return ok; }
  // The stick drives the CURSOR. Call for menus, pause, and before any dialog — anything
  // where the visitor has to be able to point at something.
  // ⚠ It deliberately LEAVES THE WATCH RUNNING. Killing it here is what made the escape
  // hatch one-way; the visitor must always be able to hand the stick back to the game.
  function cursorMode(why) { return apply('mouse', why || 'page needs a pointer'); }
  // Close of a dialog/overlay: give the stick back ONLY if there is a game to give it to.
  // A no-op before Start, which is what keeps the cursor alive on the menu screen.
  function resume(why) {
    if (!inGame) return false;
    var ok = apply('gamepad', why || 'dialog closed'); startWatch(); hint('game'); return ok;
  }
  // The emulator has actually STOPPED (or the page is going away). Only here is it right to
  // tear the watch down, because there is no game left to give the stick back to.
  function release(why) { inGame = false; stopWatch(); return apply('mouse', why || 'emulator stopped'); }

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

  // ---- ASK, don't just take the stick -----------------------------------------
  // Owner's requirement, verbatim: "it should ask 'use game controls' and then I would be
  // able to use the joystick and not the cursor on the xbox edge browser."
  //
  // This is also the safer order. The prompt is shown while the page is STILL in 'mouse'
  // mode, so the pointer that the visitor has been using to drive the page is exactly what
  // clicks the button. If we flipped to 'gamepad' first and then asked, the question would
  // be unanswerable — the pointer needed to answer it would already be gone.
  // The button is focused on show, so A on the pad activates it without any pointing at all.
  var promptEl = null;
  function hidePrompt() { try { if (promptEl) promptEl.style.display = 'none'; } catch (e) {} }
  function showPrompt(why) {
    try {
      if (!promptEl) {
        promptEl = document.createElement('div');
        promptEl.id = 'xboxInputPrompt';
        // Centred and inset, never edge-anchored: a TV can crop roughly the outer 5%.
        promptEl.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;'
          + 'align-items:center;justify-content:center;background:rgba(0,0,0,.72);'
          + 'font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
        var card = document.createElement('div');
        card.style.cssText = 'background:#15171a;color:#eee;border:1px solid #555;border-radius:14px;'
          + 'padding:30px 34px;max-width:min(720px,80vw);text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.6);';
        var h = document.createElement('div');
        h.textContent = 'Use game controls?';
        h.style.cssText = 'font-size:30px;font-weight:600;margin:0 0 12px;color:#fff;';
        var p = document.createElement('div');
        p.textContent = 'Right now the stick moves the pointer. Switch to game controls and '
          + 'the stick plays the game instead. Hold LB + RB at any time to get the pointer back.';
        p.style.cssText = 'font-size:20px;margin:0 0 22px;color:#cfd3d8;';
        var yes = document.createElement('button');
        yes.id = 'xboxInputPromptYes';
        yes.textContent = 'Use game controls';
        yes.style.cssText = 'font-size:22px;padding:14px 26px;margin:0 8px;border-radius:9px;'
          + 'border:1px solid #2a6b4a;background:#2a6b4a;color:#fff;cursor:pointer;min-width:230px;';
        var no = document.createElement('button');
        no.id = 'xboxInputPromptNo';
        no.textContent = 'Keep pointer';
        no.style.cssText = 'font-size:22px;padding:14px 26px;margin:0 8px;border-radius:9px;'
          + 'border:1px solid #555;background:#2c2c2c;color:#eee;cursor:pointer;min-width:180px;';
        yes.addEventListener('click', function () { hidePrompt(); gameMode('accepted "use game controls"'); });
        no.addEventListener('click', function () { hidePrompt(); cursorMode('declined — keeping pointer'); });
        card.appendChild(h); card.appendChild(p); card.appendChild(yes); card.appendChild(no);
        promptEl.appendChild(card);
        (document.body || document.documentElement).appendChild(promptEl);
      }
      promptEl.style.display = 'flex';
      try { promptEl.querySelector('#xboxInputPromptYes').focus(); } catch (e) {}
    } catch (e) { /* never break a page over a prompt */ }
  }

  // What the PAGES call when a game starts. On anything that is not an Xbox this is a
  // no-op, so desktop behaviour is completely unchanged.
  function offerGameControls(why) {
    if (!HAS) return false;
    if (wanted === 'gamepad') return true;   // already playing; nothing to ask
    showPrompt(why);
    return false;
  }

  // ---- a visible focus ring, for the six pages that had NONE -------------------
  // `grep -c focus-visible` was 0 on gamecube, dreamcast, ps1, snes, gba and n64, and
  // gba.html's first enabled button computes `outline: none 0px`.  On a desktop that is a
  // cosmetic nit; with a d-pad it is the difference between navigating the page and
  // guessing, because the highlight IS the cursor.  Scoped to .console-ua so it changes
  // nothing for mouse users, and injected here because this is the one place all six pages
  // already share — there is no common stylesheet.
  // ⚠ :focus-visible only, never :focus — a ring on every mouse click would be noise.
  try {
    var st = document.createElement('style');
    st.id = 'xboxInputStyle';
    st.textContent =
      '.console-ua button:focus-visible, .console-ua select:focus-visible,'
      + '.console-ua a:focus-visible, .console-ua [tabindex]:focus-visible {'
      + ' outline: 3px solid #7ab7ff; outline-offset: 2px; border-radius: 4px; }';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) { /* styling is never worth breaking a page over */ }

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
    // What pages call when a game starts: ASKS first (see showPrompt) rather than taking
    // the stick silently. gameMode() remains the direct switch the prompt's button calls.
    offerGameControls: offerGameControls,
    gameMode: gameMode,
    cursorMode: cursorMode,
    resume: resume,
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
