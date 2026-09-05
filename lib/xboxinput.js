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
  // ⚠ RE-HOST ON EVERY SHOW, do not append once. A fullscreen element renders its own
  // subtree ON TOP of everything else, so a node parented to <body> is INVISIBLE while
  // #canvasWrap is fullscreen — which on a television is precisely when a visitor is
  // playing and most needs to be told about LB+RB. Measured before this fix:
  // hintInsideFsSubtree=false. Same precedent as gamecube.html:2479-2480.
  function hostFor() {
    return document.fullscreenElement || document.webkitFullscreenElement
        || document.body || document.documentElement;
  }
  function reHost(el) {
    try { var h = hostFor(); if (el && el.parentNode !== h) h.appendChild(el); } catch (e) {}
  }

  var hintEl = null, hintTimer = null;
  function hint(mode) {
    if (!HAS && !onConsole()) return;       // desktop: nothing to say
    try {
      if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.id = 'xboxInputHint';
        hintEl.setAttribute('role', 'status');
        hintEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:10%;'
          + 'z-index:2147483000;background:rgba(0,0,0,.82);color:#fff;border:1px solid #666;'
          + 'border-radius:10px;padding:14px 22px;font:20px/1.35 -apple-system,BlinkMacSystemFont,'
          + '"Segoe UI",sans-serif;text-align:center;pointer-events:none;max-width:80vw;';
        hostFor().appendChild(hintEl);
      }
      hintEl.textContent = (mode === 'game')
        ? 'Stick controls the game — hold LB + RB for the pointer'
        : 'Pointer restored — hold LB + RB to give the stick back to the game';
      reHost(hintEl);   // fullscreen may have changed since last time
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
        // Two different truths, because the capability differs per browser and saying the
        // wrong one is worse than saying nothing.
        p.textContent = HAS
          ? ('Right now the stick moves the pointer. Switch to game controls and the stick '
             + 'plays the game instead. Hold LB + RB at any time to get the pointer back.')
          : ('This browser does not expose gamepad-mode switching, so the stick may keep '
             + 'moving the pointer. Press this to start reading the controller directly. '
             + 'Hold LB + RB at any time to come back here.');
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
        // ---- LIVE PAD READOUT ------------------------------------------------------
        // The owner reports "only the d-pad works" on a real Xbox, which no rig here can
        // reproduce. This makes the page state legible ON THE DEVICE: press a button and
        // see whether it arrives. It distinguishes the three possibilities that look
        // identical from the outside — no pad delivered at all, a pad delivered with only
        // some buttons, or a pad delivered fine while the page maps it wrong.
        var diag = document.createElement('div');
        diag.id = 'xboxInputPadDiag';
        diag.style.cssText = 'margin:18px auto 0;padding:12px 14px;border-radius:8px;'
          + 'background:#0d0f11;border:1px solid #444;color:#9fd3ff;'
          + 'font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:left;'
          + 'white-space:pre-wrap;max-width:100%;overflow-wrap:anywhere;';
        diag.textContent = 'controller: reading…';
        card.appendChild(h); card.appendChild(p); card.appendChild(diag);
        var tick = function () {
          if (!promptEl || promptEl.style.display === 'none') { return; }
          var pads = [];
          try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {}
          var live = null;
          for (var i = 0; i < pads.length; i++) { if (pads[i]) { live = pads[i]; break; } }
          var lines = [];
          lines.push('gamepadInputEmulation: ' + (HAS ? ('yes (' + wanted + ')') : 'NOT SUPPORTED'));
          if (!live) {
            lines.push('controller: none delivered to this page yet');
            lines.push('press any button — some browsers only reveal a pad after input');
          } else {
            var pressed = [];
            for (var b = 0; b < live.buttons.length; b++) {
              if (live.buttons[b] && live.buttons[b].pressed) pressed.push(b);
            }
            var ax = [];
            for (var x = 0; x < live.axes.length; x++) ax.push(live.axes[x].toFixed(2));
            lines.push('controller: ' + String(live.id).slice(0, 42));
            lines.push('mapping: ' + (live.mapping || '(none)') + '   buttons: ' + live.buttons.length);
            lines.push('pressed: ' + (pressed.length ? pressed.join(' ') : '(none)'));
            lines.push('axes: ' + ax.join(' '));
          }
          diag.textContent = lines.join('\n');
          try { requestAnimationFrame(tick); } catch (e) {}
        };
        try { requestAnimationFrame(tick); } catch (e) {}
        card.appendChild(yes); card.appendChild(no);
        promptEl.appendChild(card);
        hostFor().appendChild(promptEl);
      }
      reHost(promptEl);  // the ASK must be visible in fullscreen too, or it is a trap
      promptEl.style.display = 'flex';
      try { promptEl.querySelector('#xboxInputPromptYes').focus(); } catch (e) {}
    } catch (e) { /* never break a page over a prompt */ }
  }

  // What the PAGES call when a game starts. On anything that is not an Xbox this is a
  // no-op, so desktop behaviour is completely unchanged.
  // ⚠ DO NOT GATE THIS ON `HAS`. It used to `if (!HAS) return false`, and that is why the
  // owner saw NO PROMPT AT ALL on a real Xbox: `gamepadInputEmulation` is an EdgeHTML-era
  // extension, and if the Chromium-based Xbox Edge does not expose it, `HAS` is false and
  // the question was never asked. The prompt is worth showing on ANY console regardless —
  // it is also the only place the page can tell the visitor what is and is not working.
  // Reported symptom that this explains: "only the d-pad works" — the d-pad arrives as
  // ARROW KEYS (shell keyboard emulation) and drives KEYMAP, while the stick is consumed as
  // a cursor and the face buttons/triggers never reach the page as gamepad input.
  var CONSOLE_UA_RE = /\bXbox\b|\bPlayStation\b|\bNintendo\b|\bSmartTV\b|\bTizen\b|Web0S|\bAFT[A-Z]/i;
  function onConsole() {
    try { return CONSOLE_UA_RE.test(String(navigator.userAgent || '')); } catch (e) { return false; }
  }
  function offerGameControls(why) {
    if (!HAS && !onConsole()) return false;  // ordinary desktop: nothing to offer
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
    // ⚠ GATE ON `inGame`, NEVER ON `wanted` — this stranded the pad, and my own
    // cursorMode() wiring is what would have made it live rather than latent.
    // The old code re-armed only when `wanted === 'gamepad'`. Sequence that breaks it:
    // start a game, hold LB+RB to get the pointer back (wanted is now 'mouse'), then let
    // the page be backgrounded and brought forward — the guard sees 'mouse', never calls
    // startWatch(), and LB+RB is dead for the rest of the session. The stick cannot be
    // returned to the game at all. `wanted` is the CURRENT mode; `inGame` is whether there
    // is a game to hand the stick back to, and only the latter should decide this.
    // It also no longer forges `wanted = 'gamepad'` after applying 'mouse' — that lie was
    // how the two ideas got conflated in the first place. The pre-hide mode is remembered
    // honestly instead, and restored on return.
    var hiddenMode = null;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (inGame) { hiddenMode = wanted; stopWatch(); apply('mouse', 'page hidden'); }
      } else if (inGame) {
        apply(hiddenMode || 'gamepad', 'page visible again');
        hiddenMode = null;
        startWatch();   // ALWAYS re-arm while a game is running, in EITHER mode
      }
    });
    window.addEventListener('pagehide', function () { release('pagehide'); });
  } catch (e) {}

  // ---- OFFER ON THE FIRST INTERACTION, NOT ON BOOT ---------------------------------
  // Owner, from a real Xbox: "EVEN N64 USED TO HAVE 'use game controls' AFTER CLICKING THE
  // GAME DISPLAY". That is the correct trigger and mine was wrong.
  //
  // Each page called offerGameControls() from its "emulator is now running" site — e.g.
  // dreamcast.html's `booted = true`. If the guest never finishes booting on that device,
  // that line is never reached and the question is never asked. Boot is exactly the thing
  // most likely to be slow or broken on the machine where you most need the controls to
  // work, so gating the controls prompt on it is backwards.
  //
  // This offers on the FIRST real interaction on a console instead: a pointer/click/keydown
  // anywhere, or a gamepad button press. It is one-shot, it does not require the emulator to
  // be running, and it leaves the existing boot-time call in place as a second chance.
  // ⚠ Deliberately NOT at page load: the prompt must follow a user action, both because an
  // unprompted modal on arrival is hostile and because the pointer must still be usable to
  // answer it.
  try {
    if (onConsole()) {
      var fired = false;
      var fire = function (why) {
        if (fired) return;
        fired = true;
        try { offerGameControls(why); } catch (e) {}
      };
      ['pointerdown', 'click', 'keydown'].forEach(function (ev) {
        try { document.addEventListener(ev, function () { fire('first ' + ev); }, { once: true, capture: true }); }
        catch (e) {}
      });
      // A pad press is an interaction too, and on a console it may be the ONLY one that
      // happens — a visitor holding a controller never touches a pointer or a key.
      // ⚠ KEEP POLLING AFTER FIRING — this loop is not only our own trigger.
      // git log -S"use game controls" finds exactly one commit in this repo: the one that
      // added OUR dialog. The "Use game controls" prompt the owner remembers from before is
      // XBOX EDGE'S OWN shell affordance, which Edge offers when a page starts USING the
      // Gamepad API. Pages here only began polling inside their frame loop, which starts
      // after Start — so on a console that never reached a running emulator, nothing ever
      // called getGamepads() and Edge had no reason to offer anything.
      // Calling navigator.getGamepads() every frame from page load is therefore the thing
      // that restores the native affordance, independently of our dialog. Stopping the poll
      // once our own prompt fired would take it away again.
      var padWatch = function () {
        var pads = [];
        try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {}
        for (var i = 0; i < pads.length; i++) {
          var pd = pads[i];
          if (!pd || !pd.buttons) continue;
          for (var bi = 0; bi < pd.buttons.length; bi++) {
            if (pd.buttons[bi] && pd.buttons[bi].pressed) { fire('gamepad button ' + bi); break; }
          }
          for (var ai = 0; ai < pd.axes.length; ai++) {
            if (Math.abs(pd.axes[ai]) > 0.5) { fire('gamepad axis ' + ai); break; }
          }
        }
        // Unconditional reschedule: the poll itself is the signal Edge watches.
        try { requestAnimationFrame(padWatch); } catch (e) {}
      };
      try { requestAnimationFrame(padWatch); } catch (e) {}
    }
  } catch (e) { /* never break a page over the offer */ }

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
