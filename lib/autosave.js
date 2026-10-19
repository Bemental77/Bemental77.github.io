// Auto-save for the emulator pages: every 5 minutes of play, single-player only,
// default ON. One shared preference ('bemental.autosave' in localStorage, '0' = off)
// so the choice follows the visitor across consoles.
//
// A page hands this file its OWN save function and its OWN "is a game running and
// alone" predicate; nothing here knows how any core serializes. It writes through the
// same function the Save State button calls, so an auto-save lands in the same slot
// a manual save does (each page keeps exactly one slot per game).
//
// Never saves inside a room: the page's canSave() must return false there. A save is
// harmless to a room's state, but a pause for it (GBA walks the heap, GameCube
// compresses ~20 MB) would stall one console against the others.
//
// Off under automation (navigator.webdriver) unless ?autosave_force=1: the probes and
// harnesses measure timing, and a multi-MB save mid-measurement is a perturbation they
// did not ask for. ?noautosave=1 turns it off for one load without touching the stored
// preference.
(function () {
  'use strict';
  var PREF = 'bemental.autosave';
  var INTERVAL_MS = 5 * 60 * 1000;
  var POLL_MS = 15 * 1000;

  function prefOn() { try { return localStorage.getItem(PREF) !== '0'; } catch (e) { return true; } }
  function setPref(on) { try { localStorage.setItem(PREF, on ? '1' : '0'); } catch (e) {} }

  var q = new URLSearchParams(location.search);
  var suppressed = q.has('noautosave') || (navigator.webdriver && !q.has('autosave_force'));

  var boxes = [];
  function syncBoxes() { var on = prefOn(); boxes.forEach(function (b) { b.checked = on; }); }

  function addBox(anchorSel) {
    var anchor = document.querySelector(anchorSel);
    if (!anchor || !anchor.parentNode) return;
    var label = document.createElement('label');
    label.className = 'autosaveToggle';
    label.title = 'Save the game state automatically every 5 minutes (single player only)';
    label.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin:0 6px;font-size:12px;white-space:nowrap;cursor:pointer;';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', function () { setPref(box.checked); syncBoxes(); });
    label.appendChild(box);
    label.appendChild(document.createTextNode('Auto-save'));
    anchor.parentNode.insertBefore(label, anchor.nextSibling);
    boxes.push(box);
  }

  var started = false;

  // opts: { canSave(): boolean, save(): any|Promise, anchors: [selector...], intervalMs? }
  function init(opts) {
    if (started) return;
    started = true;
    (opts.anchors || ['#btnSave', '#mSave']).forEach(addBox);
    syncBoxes();
    if (suppressed) return;

    var interval = opts.intervalMs || INTERVAL_MS;
    var since = null;   // when the current run of saveable play began (or the last save)
    var busy = false;

    setInterval(function () {
      var ok = false;
      try { ok = prefOn() && !!opts.canSave(); } catch (e) {}
      if (!ok) { since = null; return; }   // the clock only runs while play is saveable
      var now = Date.now();
      if (since === null) { since = now; return; }
      if (busy || now - since < interval) return;
      busy = true;
      since = now;
      Promise.resolve()
        .then(function () { return opts.save(); })
        .catch(function (e) { console.warn('[autosave] failed:', e && e.message || e); })
        .then(function () { busy = false; });
    }, POLL_MS);
  }

  window.Autosave = { init: init, enabled: prefOn, INTERVAL_MS: INTERVAL_MS };
})();
