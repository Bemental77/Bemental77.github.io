// Keep the screen awake while an emulator page is open. Phones otherwise sleep
// during the long ROM/disc part downloads (hundreds of MB before first frame)
// and during gamepad-only play (no touches = no activity timer resets).
// Screen Wake Lock API (Chrome/Android; iOS Safari 16.4+). The lock is
// auto-released whenever the tab is hidden, so re-acquire on return; Safari
// wants a user gesture for the first request, so also retry on gestures.
(function () {
  if (!('wakeLock' in navigator)) return;
  var lock = null;
  function acquire() {
    if (lock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      lock = l;
      l.addEventListener('release', function () { lock = null; });
    }).catch(function () { /* denied (battery saver etc.) — retried on next gesture/return */ });
  }
  document.addEventListener('visibilitychange', acquire);
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, acquire, { passive: true });
  });
  acquire();
})();
