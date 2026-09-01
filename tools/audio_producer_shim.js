/*
 * audio_producer_shim.js — page-realm producer-side counters.
 *
 * Injected at document-start alongside tools/audio_tap.js. The tap measures what
 * the OUTPUT rendered; this measures what the emulator PRODUCED. The pair is the
 * whole diagnosis:
 *
 *   produced/s  ==  consumed/s   -> rate-matched
 *   produced/s  <   consumed/s   -> starvation (gaps/crackle), and the deficit
 *                                   ratio names the missing fraction exactly
 *   produced/s  >   consumed/s   -> the buffer overflows and the producer drops
 *
 * Consumed/s comes from the tap (frames / wall seconds), which is device-driven
 * and therefore the ground truth for what the speaker ate.
 *
 * IMPORTANT (gate #9): everything here is COUNTING. Nothing in this file may
 * alter a rate, a buffer size, or a scheduling decision. It is a measurement
 * instrument and must stay one.
 *
 * Publishes window.__audioProd = { hooks: [...], <name>: {frames, calls, ...} }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__audioProd) return;

  var P = { hooks: [], t0: (performance && performance.now) ? performance.now() : Date.now() };
  window.__audioProd = P;

  function bucket(name) {
    if (!P[name]) P[name] = { frames: 0, bytes: 0, calls: 0, firstT: null, lastT: null };
    return P[name];
  }
  function mark(b, frames, bytes) {
    var t = performance.now();
    if (b.firstT === null) b.firstT = t;
    b.lastT = t;
    b.calls++;
    if (frames) b.frames += frames;
    if (bytes) b.bytes += bytes;
  }

  // ---- GBA: wasm calls window.writeAudio(ptr, frames) --------------------
  // The property does not exist until the core boots, so watch for the define.
  (function () {
    var real = undefined;
    try {
      Object.defineProperty(window, 'writeAudio', {
        configurable: true,
        get: function () {
          if (!real) return undefined;
          return function (ptr, frames) {
            mark(bucket('gba_writeAudio'), frames | 0, 0);
            return real.apply(this, arguments);
          };
        },
        set: function (v) { real = v; if (P.hooks.indexOf('gba_writeAudio') < 0) P.hooks.push('gba_writeAudio'); }
      });
    } catch (e) { /* non-fatal */ }
  })();

  // ---- GameCube: page-side ring producer ---------------------------------
  (function () {
    var real = undefined;
    try {
      Object.defineProperty(window, '_gcAudioPushSamples', {
        configurable: true,
        get: function () {
          if (!real) return undefined;
          return function (byteBuf, byteLen) {
            // GC pushes int16 stereo: frames = bytes / 4
            mark(bucket('gc_pushSamples'), (byteLen | 0) >> 2, byteLen | 0);
            return real.apply(this, arguments);
          };
        },
        set: function (v) { real = v; if (P.hooks.indexOf('gc_pushSamples') < 0) P.hooks.push('gc_pushSamples'); }
      });
    } catch (e) { /* non-fatal */ }
  })();

  // ---- Any worker that posts audio to the page ---------------------------
  // PS1 posts {cmd:'SoundFeedStreamData', lBytes}. GC posts {cmd:'audio', len}.
  // Listeners are additive, so attaching our own cannot disturb the page's.
  (function () {
    if (typeof Worker !== 'function') return;
    var Orig = Worker;
    function Wrapped(url, opts) {
      var w = new Orig(url, opts);
      try {
        w.addEventListener('message', function (e) {
          var d = e && e.data;
          if (!d || typeof d !== 'object') return;
          if (d.cmd === 'SoundFeedStreamData') {
            mark(bucket('ps1_soundFeed'), (d.lBytes | 0) >> 2, d.lBytes | 0);
          } else if (d.cmd === 'audio') {
            mark(bucket('worker_audio'), (d.len | 0) >> 2, d.len | 0);
          } else if (d.cmd === 'audioRate') {
            P.workerAudioRate = d.rate;
          } else if (d.cmd === 'sabLayout') {
            P.sabLayout = { audioOffset: d.audioOffset, audioFrames: d.audioFrames };
          }
        });
        if (P.hooks.indexOf('worker_messages') < 0) P.hooks.push('worker_messages');
      } catch (e) { /* never break the page */ }
      return w;
    }
    Wrapped.prototype = Orig.prototype;
    try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
    try { window.Worker = Wrapped; } catch (e) {}
  })();

  // ---- AudioWorkletNode ports: capture worklet stats messages ------------
  // DC and N64 worklets already post {cmd:'stats', ...} / {b,u,m,r} once per
  // second. Mirroring them costs nothing and gives buffer occupancy over time
  // straight from the consumer side.
  (function () {
    if (typeof AudioWorkletNode !== 'function') return;
    var Orig = AudioWorkletNode;
    function Wrapped(ctx, name, opts) {
      var n = new Orig(ctx, name, opts);
      try {
        if (name !== 'bem-tap') {
          bucket('worklet_' + name);
          P['workletStats_' + name] = [];
          n.port.addEventListener('message', function (e) {
            var arr = P['workletStats_' + name];
            if (arr.length < 300) arr.push({ t: performance.now(), d: e.data });
          });
          n.port.start && n.port.start();
          if (P.hooks.indexOf('worklet_' + name) < 0) P.hooks.push('worklet_' + name);
        }
      } catch (e) { /* non-fatal */ }
      return n;
    }
    Wrapped.prototype = Orig.prototype;
    try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) {}
    try { window.AudioWorkletNode = Wrapped; } catch (e) {}
  })();

  P.summary = function () {
    var out = { hooks: P.hooks.slice(), t0: P.t0 };
    Object.keys(P).forEach(function (k) {
      var v = P[k];
      if (!v || typeof v !== 'object' || typeof v.calls !== 'number') return;
      var span = (v.lastT != null && v.firstT != null) ? (v.lastT - v.firstT) / 1000 : 0;
      out[k] = {
        calls: v.calls, frames: v.frames, bytes: v.bytes,
        spanSec: +span.toFixed(3),
        framesPerSec: span > 0.5 ? +(v.frames / span).toFixed(2) : null,
        callsPerSec: span > 0.5 ? +(v.calls / span).toFixed(2) : null
      };
    });
    if (P.workerAudioRate) out.workerAudioRate = P.workerAudioRate;
    if (P.sabLayout) out.sabLayout = P.sabLayout;
    Object.keys(P).forEach(function (k) {
      if (k.indexOf('workletStats_') === 0 && P[k].length) {
        out[k] = { n: P[k].length, first: P[k][0], last: P[k][P[k].length - 1] };
      }
    });
    return out;
  };
})();
