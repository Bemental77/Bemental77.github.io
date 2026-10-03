// snes/snes_rollback.js — THE CONSOLE HALF OF ROLLBACK NETPLAY FOR snes.html.
//
// The engine half (predict a remote pad, rewind when a late input contradicts
// the guess) is lib/netplay.js _beginFrameRb. This file is the part that owns
// the core: a ring of savestates, the canonical step, re-simulation, and the
// page's half of a capacity-gated room (opts.rbResume). It is a separate file
// for ONE reason — tools/snes_rollback_probe.mjs runs THIS code against a
// never-guessing reference in Node, so what is proven is what ships.
//
// THE CANONICAL STEP. Every frame of a rollback room, first-time or
// re-simulated, runs as
//     loadState(slot[k]) -> set every port's pad -> _mainLoop() -> saveStateInto(slot[k+1])
// on EVERY console (genesis.html rbStep is the same shape). So the frame is a
// function of (blob, pads) alone, and a console that rolled back and one that
// did not have, by construction, made the same calls.
// ⚠ THAT ONLY HOLDS BECAUSE THE LOAD WAS MADE FAITHFUL (snes/snesWasm/source/
// exports.c loadState). MEASURED in Node on the shipped core, SimCity, before
// that change: load-then-save moved 545 bytes (CPU.WhichEvent/NextEvent, every
// sound channel's needs_decode/envxx) and the DSP noise generator — which lives
// outside the blob but writes into it — was reset to 1 by every load; a run
// that loaded before each frame left a straight run on frame 1. After it: a
// load-before-every-frame run equals a straight run byte-for-byte at 1, 10,
// 200 and 2000 frames. (The only bytes a load still moves are in the SA-1
// block, which a non-SA-1 cart never reads — and every console loads at every
// rollback frame, so they move identically everywhere.)
//
// COST (Node, same wasm, SimCity): load 0.04 ms, save 0.04 ms, run 0.75 ms.
// The savestate is 529,144 bytes; a slot is allocated once (saveStateInto),
// never per frame — the old _saveState() calloc'd a fresh 529 KB every call.
//
// ⚠ GATE 9. A re-simulation re-runs frames the guest already lived through on
// a guess; nothing is presented and no accumulator credit is spent on it.
// Exactly one NEW frame runs per credit, as in lockstep.
//
// ⚠ AUDIO. The ring's write position is page plumbing that no savestate holds,
// so re-simulated (and hidden catch-up) frames would push a repeat of audio
// already queued. audioWpos()/audioRewind() (exports.c) drop exactly their
// samples; the page polls the ring only after a presented frame.
(function (root) {
  'use strict';

  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
  var REMEASURE_MS = 3000;   // a delay stretch re-times one save+load this often (see onDelayFrame)

  function create(M, opts) {
    opts = opts || {};
    var log = opts.log || function () {};
    var RB = {
      slots: null, slotFrame: null, n: 0, size: 0,
      armed: false, stale: false, scratch: 0,
      // counters a rig reads (snes.html __snesNet().rollback.page / capGate)
      rollbacks: 0, resimFrames: 0, maxDepth: 0, hidden: 0, hashes: 0, missingSlot: 0, rearms: 0,
      stepMs: 0, ioMs: 0, runMs: 0, resimMs: 0, maxTickMs: 0, lastTickMs: 0,
      delaySteps: 0, remeasures: 0, remeasureAt: 0, fault: null,
      // ⚠ TEST-ONLY negative control (tools/snes_rollback_probe.mjs --broken):
      // a rollback that skips its re-simulation. It MUST fail the probe.
      broken: !!opts.broken,
    };

    function ringFor(ls) {
      return (typeof ls.rbRingFrames === 'function') ? (ls.rbRingFrames() | 0) : ((ls.rollback | 0) + 4);
    }
    function alloc() {
      var p = M._my_malloc(RB.size);   // calloc: zeroed, so a slot's bytes are defined everywhere
      if (!p) RB.fault = 'out of memory for the rollback ring (' + RB.n + ' x ' + RB.size + ' bytes)';
      return p;
    }
    function slot(k) {
      var i = k % RB.n;
      return RB.slotFrame[i] === k ? RB.slots[i] : 0;
    }
    function setPads(image, pb, ports) {
      for (var p = 0; p < ports; p++) M._setJoypadInputPort(p, (image[p * pb] | (image[p * pb + 1] << 8)) & 0xffff);
    }
    function hashAt(ptr) {
      var words = RB.size >>> 2, h = 0x811c9dc5;
      var u32 = new Uint32Array(M.HEAPU8.buffer, ptr, words);   // memory can grow: view taken fresh
      for (var i = 0; i < words; i++) { h ^= u32[i]; h = Math.imul(h, 16777619) >>> 0; }
      var u8 = new Uint8Array(M.HEAPU8.buffer, ptr, RB.size);
      for (var b = words << 2; b < RB.size; b++) { h ^= u8[b]; h = Math.imul(h, 16777619) >>> 0; }
      return h >>> 0;
    }

    // Allocate the ring (first time) and keep the live machine as the start of
    // frame `frame`. Used for the first rollback frame a console ever runs and
    // for the first one after a stretch of input delay (rbResume).
    function arm(ls, frame) {
      if (!RB.slots) {
        RB.size = M._getStateSaveSize() >>> 0;
        RB.n = Math.max(4, ringFor(ls));
        RB.slots = []; RB.slotFrame = [];
        for (var i = 0; i < RB.n; i++) { var p = alloc(); if (!p) return false; RB.slots.push(p); RB.slotFrame.push(-1); }
      } else {
        for (var j = 0; j < RB.n; j++) RB.slotFrame[j] = -1;
      }
      var s = frame % RB.n;
      if (!M._saveStateInto(RB.slots[s], RB.size)) { RB.fault = 'saveStateInto refused (no game running?)'; return false; }
      RB.slotFrame[s] = frame;
      RB.armed = true; RB.stale = false;
      return true;
    }
    // Grow the ring to `want` slots. A slot is indexed k % n, so every held frame
    // moves to k % want — pointers only, no copying (genesis.html rbGrow).
    function grow(want) {
      var nn = want | 0;
      if (!RB.slots || nn <= RB.n) return true;
      var slots = new Array(nn), frames = new Array(nn), spare = [];
      for (var j = 0; j < nn; j++) { slots[j] = 0; frames[j] = -1; }
      for (var i = 0; i < RB.n; i++) {
        var k = RB.slotFrame[i];
        if (k >= 0 && !slots[k % nn]) { slots[k % nn] = RB.slots[i]; frames[k % nn] = k; }
        else spare.push(RB.slots[i]);
      }
      for (var q = 0; q < nn; q++) {
        if (slots[q]) continue;
        var ptr = spare.length ? spare.pop() : alloc();
        if (!ptr) return false;
        slots[q] = ptr;
      }
      log('[rollback] ring ' + RB.n + ' -> ' + nn + ' savestates (the room\'s window grew)');
      RB.slots = slots; RB.slotFrame = frames; RB.n = nn;
      return true;
    }
    // THE CANONICAL STEP (see the header).
    function step(k, image, pb, ports) {
      var src = slot(k);
      if (!src) return false;
      var t0 = now();
      if (!M._loadState(src, RB.size)) { RB.fault = 'loadState refused frame ' + k; return false; }
      var t1 = now();
      setPads(image, pb, ports);
      M._mainLoop();          // looked up at call time: lib/bench.js wraps it to time it
      var t2 = now();
      var j = (k + 1) % RB.n;
      RB.slotFrame[j] = -1;
      if (!M._saveStateInto(RB.slots[j], RB.size)) { RB.fault = 'saveStateInto refused'; return false; }
      RB.slotFrame[j] = k + 1;
      var t3 = now();
      // What one step costs THIS console, published to the room (ls.selfStepMs):
      // the host sizes the window by the slowest console's and the capacity gate
      // judges rollback affordable from it; rbCatchUp spends at most half a
      // frame of it per tick.
      var io = (t1 - t0) + (t3 - t2), run = t2 - t1;
      RB.ioMs = RB.ioMs ? RB.ioMs + (io - RB.ioMs) / 32 : io;
      RB.runMs = RB.runMs ? RB.runMs + (run - RB.runMs) / 32 : run;
      RB.stepMs = RB.stepMs ? RB.stepMs + ((t3 - t0) - RB.stepMs) / 32 : (t3 - t0);
      return true;
    }
    function fail(ls, why) {
      RB.fault = why;
      log('[rollback] ⚠ ' + why);
      try { ls.fail(why); } catch (e) {}
      return false;
    }

    // ONE FRAME OF A ROLLBACK ROOM. `r` is what ls.beginFrame returned (ready).
    // Runs any re-simulation the plan names, then r.frame; closes the frame with
    // the engine and submits fingerprints of CONFIRMED frames only. Returns
    // false (with RB.fault and ls.fail) when the ring cannot serve the plan.
    function runFrame(ls, r, hidden) {
      var t0 = now();
      var pb = ls.padBytes | 0, ports = ls.portCount | 0;
      if (!RB.armed || RB.stale) {
        // The first rollback frame this console runs — at the start of the room,
        // or after a stretch of input delay (the capacity gate, lib/netplay.js
        // _capDecide, with opts.rbResume). Either way the live machine IS the
        // start of r.frame: every frame before it has run, and the engine names
        // no correction reaching back across the switch (every input before it
        // was held: _rbResumeAt). A plan that does reach back is a fault, said.
        var re = RB.armed;
        if (r.rollback) return fail(ls, 'a correction reached back across the switch to rollback (frame ' + r.rollback.from + ' < ' + r.frame + ')');
        if (!arm(ls, r.frame)) return fail(ls, 'rollback could not ' + (re ? 're-arm' : 'start') + ': ' + RB.fault);
        if (opts.frameHz) ls.frameHz = opts.frameHz;   // the room clock's frame period (lib/netplay.js _frameMs)
        if (re) { RB.rearms++; log('[rollback] zero-lag mode again: savestate ring re-armed at frame ' + r.frame); }
      }
      if (RB.n < ringFor(ls) && !grow(ringFor(ls))) return fail(ls, 'rollback could not grow its ring: ' + RB.fault);
      var w0 = (hidden || r.rollback) ? M._audioWpos() : -1;
      if (r.rollback && !RB.broken) {
        // RE-SIMULATE, NOT PRESENTED; its audio is dropped below.
        var ta = now();
        for (var i = 0; i < r.rollback.frames.length; i++) {
          var fr = r.rollback.frames[i];
          if (!step(fr.frame, fr.image, pb, ports)) { RB.missingSlot++; return fail(ls, 'rollback to frame ' + r.rollback.from + ' found no savestate for frame ' + fr.frame); }
        }
        RB.resimMs += now() - ta;
      }
      if (r.rollback) {
        RB.rollbacks++; RB.resimFrames += r.rollback.frames.length;
        if (r.rollback.frames.length > RB.maxDepth) RB.maxDepth = r.rollback.frames.length;
        if (!hidden) M._audioRewind(w0);   // the re-simulated frames' samples go; this frame's are kept
      }
      // (--broken: the re-simulation was skipped, so the step below loads the
      // slot the MISPREDICTED run saved for r.frame and carries on from it.)
      var ok = step(r.frame, r.image, pb, ports);
      if (hidden) { M._audioRewind(w0); RB.hidden++; }
      if (RB.stepMs) ls.selfStepMs = +RB.stepMs.toFixed(2);
      if (!ok) { RB.missingSlot++; return fail(ls, 'no savestate for frame ' + r.frame + (RB.fault ? ' (' + RB.fault + ')' : '')); }
      ls.endFrame(null);
      // FINGERPRINTS OF CONFIRMED FRAMES ONLY: the state after k is slot k+1.
      var due = ls.takeHashDue();
      for (var d = 0; d < due.length; d++) {
        var after = slot(due[d] + 1);
        if (!after) { RB.missingSlot++; continue; }
        ls.submitHash(due[d], hashAt(after));
        RB.hashes++;
      }
      var dt = now() - t0;
      RB.lastTickMs = dt; if (dt > RB.maxTickMs) RB.maxTickMs = dt;
      return true;
    }

    // A DELAY frame of a capacity-gated room (or of a plain lockstep room — the
    // estimate is harmless there). `runMs`: what its _mainLoop() cost. No
    // savestate is taken, so the ring goes stale (the next rollback frame
    // re-arms it), and the rollback step this frame stands for is its run plus
    // the save+load share last measured — re-timed on a scratch slot every
    // REMEASURE_MS so the estimate follows the device, not the period that
    // ended in the switch. Published as ls.selfStepMs so the host can see when
    // this console has the headroom for zero lag again (opts.rbResume).
    function onDelayFrame(ls, runMs) {
      if (RB.armed) RB.stale = true;
      var t = now();
      if (!RB.ioMs || t - RB.remeasureAt >= REMEASURE_MS) {
        // Re-time a SAVE on a scratch slot and count the load as one more:
        // they cost the same (two memcpy passes over the same 529 KB; measured
        // 0.04 ms each). No load is made here — a load is only ever made on the
        // schedule every console shares (the canonical step), never on a local
        // timer.
        RB.remeasureAt = t;
        var size = M._getStateSaveSize() >>> 0;
        if (!RB.scratch) RB.scratch = M._my_malloc(size);
        if (RB.scratch) {
          var a = now();
          if (M._saveStateInto(RB.scratch, size)) {
            var io = 2 * (now() - a);
            RB.remeasures++;
            RB.ioMs = RB.ioMs ? RB.ioMs + (io - RB.ioMs) / 4 : io;
          }
        }
      }
      var per = runMs + (RB.ioMs > 0 ? RB.ioMs : runMs * 0.12);
      RB.delaySteps++;
      RB.stepMs = RB.stepMs ? RB.stepMs + (per - RB.stepMs) / 32 : per;
      if (ls) ls.selfStepMs = +RB.stepMs.toFixed(2);
    }

    function free() {
      try {
        if (RB.slots) RB.slots.forEach(function (p) { if (p) M._my_free(p); });
        if (RB.scratch) M._my_free(RB.scratch);
      } catch (e) {}
      RB.slots = null; RB.slotFrame = null; RB.n = 0; RB.scratch = 0;
      RB.armed = false; RB.stale = false;
    }

    function report() {
      return {
        armed: RB.armed, stale: RB.stale, ring: RB.n, ringBytes: RB.n * RB.size,
        rollbacks: RB.rollbacks, resimFrames: RB.resimFrames, maxDepth: RB.maxDepth, hidden: RB.hidden,
        hashes: RB.hashes, missingSlot: RB.missingSlot, rearms: RB.rearms,
        stepMs: +RB.stepMs.toFixed(3), ioMs: +RB.ioMs.toFixed(3), runMs: +RB.runMs.toFixed(3),
        resimMs: +RB.resimMs.toFixed(1), maxTickMs: +RB.maxTickMs.toFixed(2), lastTickMs: +RB.lastTickMs.toFixed(2),
        delaySteps: RB.delaySteps, remeasures: RB.remeasures, fault: RB.fault, broken: RB.broken,
      };
    }

    return { RB: RB, arm: arm, grow: grow, step: step, runFrame: runFrame, onDelayFrame: onDelayFrame,
             hashAt: hashAt, slot: slot, free: free, report: report };
  }

  var api = { create: create };
  root.SnesRollback = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
