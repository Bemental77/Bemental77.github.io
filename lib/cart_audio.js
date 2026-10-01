// cart_audio.js — off-main-thread audio sink for the cartridge pages
// (gba.html, snes.html, genesis.html).
//
// WHY. All three pages played audio through a ScriptProcessorNode, whose
// onaudioprocess runs ON THE MAIN THREAD — the same thread that runs the
// emulator, paints the canvas and handles touch. On a phone-class CPU any
// main-thread task longer than the ScriptProcessor's slack (one 2048-frame
// block, 43-57 ms) arrives late and the device plays a gap. Worse, two of the
// three never counted it:
//   * snes.html pulled the core's double-buffer from the audio callback;
//     getSoundBuffer() returns the PREVIOUS block unchanged when the core has
//     not produced a new one (snes/snesWasm/source/exports.c:317-321), so a
//     late or early pull REPEATED 57 ms of audio — no zero-hole, no counter.
//   * genesis.html filled a short read by holding the last sample
//     (`idx = min(got - 1, …)`) — again no zero-hole, no counter.
//
// WHAT THIS DOES. The page PUSHES every sample the guest produced, right after
// the frames that produced them, into an AudioWorklet that plays them from the
// audio rendering thread. The emulator clock is untouched (gate #9): this sink
// never asks for frames, never speeds or slows the guest, and never
// time-stretches. It resamples by ONE FIXED ratio — the guest's true samples
// per guest second (srcRate) over the context's rate — so pitch is exact.
//
// The cushion rides out main-thread jank up to `targetMs`. A real shortfall
// (the guest running below 1.000x, or a stall longer than the cushion) is a
// gap, and it is COUNTED: window.__cartAudio.underruns, and the page's
// window.__audioDiag when AudioDiag is installed.
//
// API
//   CartAudio.create(ctx, { srcRate, targetMs, maxMs, page }) -> sink
//   sink.push(Float32Array interleaved stereo [, frames])   (copied)
//   sink.pushInt16(Int16Array interleaved stereo, frames)   (copied, /32768)
//   sink.pushPlanar(L Float32Array, R Float32Array, frames)
//   sink.clear()          drop the queue (new ROM, loadstate)
//   sink.stats            { underruns, missingFrames, overflowFrames, rxFrames, backlog, mode }
(function () {
  'use strict';
  var WORKLET_URL = '/lib/cart_audio_worklet.js?v=063cf31a';

  function create(ctx, opts) {
    opts = opts || {};
    var srcRate = +opts.srcRate || ctx.sampleRate;
    var targetMs = opts.targetMs || 80;
    var maxMs = opts.maxMs || 400;
    var stats = { underruns: 0, missingFrames: 0, overflowFrames: 0, rxFrames: 0, backlog: 0,
                  mode: 'pending', srcRate: srcRate, ctxRate: ctx.sampleRate, lostBeforeReady: 0 };
    window.__cartAudio = stats;
    var node = null, pending = [], pendingFrames = 0, sp = null;
    var diag = function () { return window.__audioDiag || null; };

    function onStats(s) {
      stats.underruns = s.u; stats.missingFrames = s.m; stats.overflowFrames = s.o; stats.backlog = s.b;
      var d = diag();
      if (d) {
        d.underruns = s.u; d.underrunFrames = s.m; d.droppedFrames = s.o;
        d.framesConsumed = s.c; d.fill = s.b; d.capacity = s.cap; d.resampling = s.step !== 1;
      }
    }

    function send(buf) {
      if (node) { node.port.postMessage({ s: buf }, [buf.buffer]); return; }
      if (sp) { spPush(buf); return; }
      // Worklet still loading: hold up to the cushion, drop (and count) the rest.
      pending.push(buf); pendingFrames += buf.length >> 1;
      var cap = Math.round(srcRate * targetMs / 1000);
      while (pendingFrames > cap && pending.length) { var x = pending.shift(); pendingFrames -= x.length >> 1; stats.lostBeforeReady += x.length >> 1; }
    }

    // ── fallback: ScriptProcessor on the main thread (no AudioWorklet) ──
    var RING = 1 << 16, rL = null, rR = null, w = 0, rpos = 0, buffering = true, played = false;
    function spPush(buf) {
      var n = buf.length >> 1;
      for (var i = 0; i < n; i++) { var k = (w + i) & (RING - 1); rL[k] = buf[2 * i]; rR[k] = buf[2 * i + 1]; }
      w += n;
      var maxF = srcRate * maxMs / 1000;
      if (w - rpos > maxF) { var drop = (w - rpos) - srcRate * targetMs / 1000; rpos += drop; stats.overflowFrames += Math.round(drop); }
    }
    function startSP() {
      rL = new Float32Array(RING); rR = new Float32Array(RING);
      sp = ctx.createScriptProcessor(2048, 0, 2);
      var step = srcRate / ctx.sampleRate, target = srcRate * targetMs / 1000;
      sp.onaudioprocess = function (ev) {
        var oL = ev.outputBuffer.getChannelData(0), oR = ev.outputBuffer.getChannelData(1), n = oL.length, i = 0;
        if (buffering && w - rpos >= target) buffering = false;
        if (!buffering) {
          for (; i < n; i++) {
            if (w - rpos < 2) break;
            var i0 = Math.floor(rpos), f = rpos - i0, a = i0 & (RING - 1), b = (i0 + 1) & (RING - 1);
            oL[i] = rL[a] + (rL[b] - rL[a]) * f; oR[i] = rR[a] + (rR[b] - rR[a]) * f; rpos += step;
          }
          played = true;
          if (i < n) { buffering = true; stats.underruns++; }
        }
        if (i < n && played) stats.missingFrames += n - i;
        for (; i < n; i++) { oL[i] = 0; oR[i] = 0; }
        stats.backlog = Math.max(0, Math.round(w - rpos));
        onStats({ u: stats.underruns, m: stats.missingFrames, o: stats.overflowFrames, b: stats.backlog, c: 0, cap: RING, step: step });
      };
      sp.connect(ctx.destination);
      stats.mode = 'scriptprocessor';
      var q = pending; pending = []; pendingFrames = 0;
      for (var j = 0; j < q.length; j++) spPush(q[j]);
    }

    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      ctx.audioWorklet.addModule(WORKLET_URL).then(function () {
        node = new AudioWorkletNode(ctx, 'cart-audio', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { srcRate: srcRate, targetMs: targetMs, maxMs: maxMs },
        });
        node.port.onmessage = function (e) { onStats(e.data); };
        node.connect(ctx.destination);
        stats.mode = 'worklet';
        var q = pending; pending = []; pendingFrames = 0;
        for (var j = 0; j < q.length; j++) node.port.postMessage({ s: q[j] }, [q[j].buffer]);
      }).catch(function (e) {
        stats.workletError = String((e && e.message) || e);
        startSP();
      });
    } else {
      startSP();
    }

    return {
      stats: stats,
      push: function (interleaved, frames) {
        var n = frames != null ? frames : (interleaved.length >> 1);
        if (n <= 0) return;
        var buf = new Float32Array(n * 2);
        buf.set(interleaved.subarray ? interleaved.subarray(0, n * 2) : interleaved.slice(0, n * 2));
        stats.rxFrames += n;
        var d = diag(); if (d) { d.framesProduced += n; d.batchesFed++; d.lastFeedMs = performance.now(); }
        send(buf);
      },
      // Int16 interleaved stereo straight out of a core's heap (GBA).
      pushInt16: function (i16, frames) {
        var n = frames | 0;
        if (n <= 0) return;
        var buf = new Float32Array(n * 2);
        for (var i = 0; i < n * 2; i++) buf[i] = i16[i] / 32768;
        stats.rxFrames += n;
        var d = diag(); if (d) { d.framesProduced += n; d.batchesFed++; d.lastFeedMs = performance.now(); }
        send(buf);
      },
      pushPlanar: function (L, R, frames) {
        var n = frames | 0;
        if (n <= 0) return;
        var buf = new Float32Array(n * 2);
        for (var i = 0; i < n; i++) { buf[2 * i] = L[i]; buf[2 * i + 1] = R[i]; }
        stats.rxFrames += n;
        var d = diag(); if (d) { d.framesProduced += n; d.batchesFed++; d.lastFeedMs = performance.now(); }
        send(buf);
      },
      clear: function () {
        pending = []; pendingFrames = 0;
        if (node) node.port.postMessage({ cmd: 'clear' });
        if (sp) { rpos = w; buffering = true; }
      },
    };
  }

  window.CartAudio = { create: create };
})();
