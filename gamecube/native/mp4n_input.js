// gamecube/native/mp4n_input.js — the controller for mp4-native.html: keyboard, gamepads, touch.
// The game asks for input once per frame (Module.mp4InputLatch, called from web_port.cpp at the
// frame boundary); this samples every source AT THAT MOMENT and writes 4 ports x 8 i32:
//   [connected, buttons (GC PAD_* bits), stickX, stickY, substickX, substickY, trigL, trigR]
// Port 0 = keyboard + touch + the first gamepad; ports 1-3 = further gamepads.
// Mp4Input.override(fn) replaces the source entirely (netplay / replay feed recorded frames);
// Mp4Input.sampleLocal() is this screen's player as a room's 8-byte pad image.
(function () {
  'use strict';
  var B = { LEFT: 0x1, RIGHT: 0x2, DOWN: 0x4, UP: 0x8, Z: 0x10, R: 0x20, L: 0x40, A: 0x100, B: 0x200, X: 0x400, Y: 0x800, START: 0x1000 };
  // keyboard: buttons by KeyboardEvent.code
  var KEY_BTN = {
    Enter: B.START, Space: B.A, KeyX: B.A, KeyZ: B.B, Backspace: B.B, KeyC: B.X, KeyV: B.Y,
    KeyQ: B.L, KeyE: B.R, ShiftLeft: B.Z, ShiftRight: B.Z,
    KeyT: B.UP, KeyG: B.DOWN, KeyF: B.LEFT, KeyH: B.RIGHT
  };
  var KEY_STICK = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
  var KEY_CSTICK = { KeyI: [0, 1], KeyK: [0, -1], KeyJ: [-1, 0], KeyL: [1, 0] };
  var down = Object.create(null);
  function isGameKey(c) { return c in KEY_BTN || c in KEY_STICK || c in KEY_CSTICK; }
  window.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (isGameKey(e.code)) { down[e.code] = true; e.preventDefault(); }
  }, true);
  window.addEventListener('keyup', function (e) { if (isGameKey(e.code)) { down[e.code] = false; e.preventDefault(); } }, true);
  window.addEventListener('blur', function () { down = Object.create(null); });

  // touch: filled by the overlay (attachTouch)
  var touch = { buttons: 0, x: 0, y: 0 };

  function clamp127(v) { return Math.max(-127, Math.min(127, Math.round(v))); }
  function dz(v) { return Math.abs(v) < 0.15 ? 0 : v; }

  function samplePort0Keyboard(rec) {
    var btn = 0, sx = 0, sy = 0, cx = 0, cy = 0, k;
    for (k in KEY_BTN) if (down[k]) btn |= KEY_BTN[k];
    for (k in KEY_STICK) if (down[k]) { sx += KEY_STICK[k][0]; sy += KEY_STICK[k][1]; }
    for (k in KEY_CSTICK) if (down[k]) { cx += KEY_CSTICK[k][0]; cy += KEY_CSTICK[k][1]; }
    rec.btn |= btn | touch.buttons;
    rec.sx += sx * 127 + touch.x * 127; rec.sy += sy * 127 + touch.y * 127;
    rec.cx += cx * 127; rec.cy += cy * 127;
    if (btn & B.L) rec.tl = 255;
    if (btn & B.R) rec.tr = 255;
  }
  function samplePad(gp, rec) {
    var b = gp.buttons, a = gp.axes, p = function (i) { return b[i] && (b[i].pressed || b[i].value > 0.5); };
    if (gp.mapping === 'standard') {
      if (p(0)) rec.btn |= B.A; if (p(2)) rec.btn |= B.B; if (p(1)) rec.btn |= B.X; if (p(3)) rec.btn |= B.Y;
      if (p(5)) rec.btn |= B.Z; if (p(9)) rec.btn |= B.START;
      if (p(12)) rec.btn |= B.UP; if (p(13)) rec.btn |= B.DOWN; if (p(14)) rec.btn |= B.LEFT; if (p(15)) rec.btn |= B.RIGHT;
      var tl = b[6] ? b[6].value : 0, tr = b[7] ? b[7].value : 0;
      if (p(4)) tl = 1;
      rec.tl = Math.max(rec.tl, Math.round(tl * 255)); rec.tr = Math.max(rec.tr, Math.round(tr * 255));
      if (tl > 0.85) rec.btn |= B.L; if (tr > 0.85) rec.btn |= B.R;
    } else {
      // unknown layout: first four buttons + start-ish
      if (p(0)) rec.btn |= B.A; if (p(1)) rec.btn |= B.B; if (p(2)) rec.btn |= B.X; if (p(3)) rec.btn |= B.Y; if (p(9)) rec.btn |= B.START;
    }
    rec.sx += dz(a[0] || 0) * 127; rec.sy -= dz(a[1] || 0) * 127;   // GC: up is +
    rec.cx += dz(a[2] || 0) * 127; rec.cy -= dz(a[3] || 0) * 127;
  }

  // navigator.getGamepads() every frame was ~2% of the renderer's busy time on the toaster rig with no
  // pad attached. Browsers expose a pad only after it has sent input, which fires 'gamepadconnected';
  // until then (and after the last one leaves) poll at most once a second, as a fallback for pads a
  // browser surfaces without the event.
  var padsLive = false, padPollAt = 0;
  window.addEventListener('gamepadconnected', function () { padsLive = true; });
  window.addEventListener('gamepaddisconnected', function () { padPollAt = 0; padsLive = false; });
  function connectedPads() {
    if (!navigator.getGamepads) return [];
    if (!padsLive) {
      var now = performance.now();
      if (now < padPollAt) return [];
      padPollAt = now + 1000;
    }
    var pads = Array.prototype.slice.call(navigator.getGamepads() || []).filter(function (g) { return g && g.connected; });
    if (pads.length) padsLive = true;
    return pads;
  }

  var overrideFn = null, lastLatched = null;
  function latch(frame, ptr, heap32) {
    var out = new Array(32).fill(0);
    if (overrideFn) {
      var o = overrideFn(frame) || out;
      for (var j = 0; j < 32; j++) out[j] = o[j] | 0;
    } else {
      var pads = connectedPads();
      for (var port = 0; port < 4; port++) {
        var rec = { btn: 0, sx: 0, sy: 0, cx: 0, cy: 0, tl: 0, tr: 0 }, connected = port === 0;
        if (port === 0) samplePort0Keyboard(rec);
        var gp = pads[port];
        if (gp) { samplePad(gp, rec); connected = true; }
        if (!connected) continue;
        var o2 = port * 8;
        out[o2] = 1; out[o2 + 1] = rec.btn & 0xFFFF;
        out[o2 + 2] = clamp127(rec.sx); out[o2 + 3] = clamp127(rec.sy); out[o2 + 4] = clamp127(rec.cx); out[o2 + 5] = clamp127(rec.cy);
        out[o2 + 6] = Math.min(255, rec.tl | 0); out[o2 + 7] = Math.min(255, rec.tr | 0);
      }
    }
    lastLatched = out;
    if (heap32) heap32.set(out, ptr >> 2);
    return out;
  }

  // a cheap touch overlay: a stick on the left half, A / B / Start on the right
  function attachTouch(stage) {
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
    var css = document.createElement('style');
    css.textContent = '.mp4t{position:absolute;inset:0;pointer-events:none}.mp4t button{pointer-events:auto;position:absolute;border-radius:50%;' +
      'border:2px solid rgba(255,255,255,.55);background:rgba(0,0,0,.28);color:#fff;font:700 15px system-ui;touch-action:none;padding:0}' +
      '.mp4t .stick{pointer-events:auto;position:absolute;left:0;top:0;bottom:0;width:45%;touch-action:none}';
    document.head.appendChild(css);
    var o = document.createElement('div'); o.className = 'mp4t';
    var stick = document.createElement('div'); stick.className = 'stick'; o.appendChild(stick);
    function btn(label, bit, right, bottom, size) {
      var e = document.createElement('button'); e.textContent = label; e.setAttribute('aria-label', label);
      e.style.cssText = 'right:' + right + ';bottom:' + bottom + ';width:' + size + 'px;height:' + size + 'px';
      var on = function (ev) { ev.preventDefault(); touch.buttons |= bit; }, off = function (ev) { ev.preventDefault(); touch.buttons &= ~bit; };
      e.addEventListener('touchstart', on, { passive: false }); e.addEventListener('touchend', off); e.addEventListener('touchcancel', off);
      o.appendChild(e);
    }
    btn('A', B.A, '8%', '18%', 64); btn('B', B.B, '24%', '8%', 48); btn('Start', B.START, '6%', '3%', 52);
    var origin = null;
    stick.addEventListener('touchstart', function (e) { e.preventDefault(); var t = e.changedTouches[0]; origin = [t.clientX, t.clientY]; }, { passive: false });
    stick.addEventListener('touchmove', function (e) {
      e.preventDefault(); if (!origin) return; var t = e.changedTouches[0], r = 50;
      touch.x = Math.max(-1, Math.min(1, (t.clientX - origin[0]) / r)); touch.y = Math.max(-1, Math.min(1, -(t.clientY - origin[1]) / r));
    }, { passive: false });
    var end = function () { origin = null; touch.x = touch.y = 0; };
    stick.addEventListener('touchend', end); stick.addEventListener('touchcancel', end);
    stage.appendChild(o);
  }

  // This console's own player as the 8-byte pad image a netplay room exchanges:
  //   [buttons lo, buttons hi, stickX, stickY, substickX, substickY, trigL, trigR] (sticks as int8)
  // Keyboard + touch + the first connected gamepad — the one person at this screen.
  var scriptFn = null;   // Mp4Input.script(fn): fn(frame) -> extra GC buttons for this console's pad (room tests drive a route)
  function sampleLocal(frame) {
    var rec = { btn: 0, sx: 0, sy: 0, cx: 0, cy: 0, tl: 0, tr: 0 };
    samplePort0Keyboard(rec);
    if (scriptFn && frame != null) rec.btn |= scriptFn(frame) | 0;
    var pads = connectedPads();
    if (pads[0]) samplePad(pads[0], rec);
    var b = new Uint8Array(8);
    b[0] = rec.btn & 0xFF; b[1] = (rec.btn >> 8) & 0xFF;
    b[2] = clamp127(rec.sx) & 0xFF; b[3] = clamp127(rec.sy) & 0xFF; b[4] = clamp127(rec.cx) & 0xFF; b[5] = clamp127(rec.cy) & 0xFF;
    b[6] = Math.min(255, rec.tl | 0); b[7] = Math.min(255, rec.tr | 0);
    return b;
  }

  window.Mp4Input = {
    BUTTONS: B,
    sampleLocal: sampleLocal,
    latch: latch,
    attachTouch: attachTouch,
    override: function (fn) { overrideFn = fn; },
    script: function (fn) { scriptFn = fn; },
    last: function () { return lastLatched; }
  };
})();
