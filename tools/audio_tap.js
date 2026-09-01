/*
 * audio_tap.js — page-realm AudioContext tap.
 *
 * Injected at document-start (puppeteer evaluateOnNewDocument, or a <script> tag)
 * BEFORE any emulator code runs. It shadows `ctx.destination` on every AudioContext
 * with a pass-through chain so that every sample the page actually renders is
 * measured. Nothing here reads a counter the page maintains — every field is
 * derived from real PCM that reached the output node.
 *
 * Publishes window.__audioTap = {
 *   ready:   bool  — at least one context tapped
 *   contexts: [ per-context report ]
 *   summary(): rolled-up report across contexts
 * }
 *
 * Per-context report fields (all measured):
 *   sampleRate, state, stateLog[]  — {t, state} transitions (autoplay suspends)
 *   frames                          — frames that passed through the tap
 *   silentFrames                    — frames where every channel was exactly 0
 *   longestSilenceFrames            — longest contiguous all-zero run
 *   gaps[]                          — {startFrame, frames} zero runs >= gapMinFrames
 *                                     that occurred AFTER first audible sample
 *   peak, rmsMean                   — amplitude
 *   clipFrames                      — |x| >= 1.0
 *   discontinuities                 — count of |x[n]-x[n-1]| > clickThreshold
 *   maxStep                         — largest |x[n]-x[n-1]| seen
 *   firstAudibleFrame / firstAudibleTime
 *   ctxTimeAtLastBlock, wallAtLastBlock — for audio-clock-vs-wall drift
 *
 * NOTE ON INTERPRETATION (important, learned the hard way on this repo):
 *   a zero run is only a "gap" if it happens after audio has started AND the
 *   emulator was supposed to be producing. Menus, pauses and genuinely silent
 *   scenes produce legitimate zero runs. The harness cross-checks against the
 *   page's own production counters before calling a zero run an underrun.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.__audioTap && window.__audioTap.__installed) return;

  var CFG = {
    clickThreshold: 0.30, // |x[n]-x[n-1]| in one sample-period => audible click
    gapMinFrames: 256,    // ~5.3ms @48k; shorter zero runs are not audible gaps
    reportEveryBlocks: 32 // worklet -> main post cadence (~85ms @48k)
  };

  var TAP = {
    __installed: true,
    ready: false,
    installedAt: (performance && performance.now) ? performance.now() : Date.now(),
    contexts: [],
    errors: [],
    cfg: CFG
  };
  window.__audioTap = TAP;

  // ---------------------------------------------------------------- worklet src
  // Runs on the audio render thread. Pure pass-through: input -> output.
  var WORKLET_SRC = [
    'class BemTap extends AudioWorkletProcessor {',
    '  constructor(opts) {',
    '    super();',
    '    const o = (opts && opts.processorOptions) || {};',
    '    this.clickTh = o.clickThreshold || 0.3;',
    '    this.reportEvery = o.reportEveryBlocks || 32;',
    '    this.blocks = 0; this.frames = 0; this.silentFrames = 0;',
    '    this.curSilent = 0; this.longestSilent = 0;',
    '    this.peak = 0; this.sumSq = 0; this.clip = 0;',
    '    this.disc = 0; this.maxStep = 0;',
    '    this.prev = 0; this.havePrev = false;',
    '    this.firstAudible = -1;',
    '    this.gaps = []; this.gapStart = -1;',
    '    this.dead = false;',
    '    this.port.onmessage = (e) => { if (e.data === "flush") this.post(); };',
    '  }',
    '  post() {',
    '    this.port.postMessage({',
    '      blocks: this.blocks, frames: this.frames, silentFrames: this.silentFrames,',
    '      longestSilenceFrames: Math.max(this.longestSilent, this.curSilent),',
    '      curSilentFrames: this.curSilent,',
    '      peak: this.peak, sumSq: this.sumSq, clipFrames: this.clip,',
    '      discontinuities: this.disc, maxStep: this.maxStep,',
    '      firstAudibleFrame: this.firstAudible,',
    '      gaps: this.gaps.slice(-64),',
    '      ctxTime: currentTime, ctxFrame: currentFrame',
    '    });',
    '  }',
    '  process(inputs, outputs) {',
    '    const inp = inputs[0]; const out = outputs[0];',
    '    const nCh = inp ? inp.length : 0;',
    '    const n = (nCh > 0 && inp[0]) ? inp[0].length : 128;',
    '    // pass-through first, so measurement can never alter what is heard',
    '    if (out) {',
    '      for (let c = 0; c < out.length; c++) {',
    '        const src = (nCh > 0) ? inp[Math.min(c, nCh - 1)] : null;',
    '        if (src) out[c].set(src); else out[c].fill(0);',
    '      }',
    '    }',
    '    if (nCh === 0) {',
    '      // no connected source at all: the graph is producing nothing.',
    '      this.frames += n; this.silentFrames += n; this.curSilent += n;',
    '      this.blocks++;',
    '      if (this.blocks % this.reportEvery === 0) this.post();',
    '      return true;',
    '    }',
    '    const ch0 = inp[0];',
    '    for (let i = 0; i < n; i++) {',
    '      let mono = 0, nz = false;',
    '      for (let c = 0; c < nCh; c++) {',
    '        const v = inp[c][i];',
    '        if (v !== 0) nz = true;',
    '        const a = v < 0 ? -v : v;',
    '        if (a > this.peak) this.peak = a;',
    '        if (a >= 1.0) this.clip++;',
    '        mono += v;',
    '      }',
    '      mono /= nCh;',
    '      this.sumSq += mono * mono;',
    '      if (this.havePrev) {',
    '        const d = Math.abs(mono - this.prev);',
    '        if (d > this.maxStep) this.maxStep = d;',
    '        if (d > this.clickTh) this.disc++;',
    '      }',
    '      this.prev = mono; this.havePrev = true;',
    '      if (nz) {',
    '        if (this.firstAudible < 0) this.firstAudible = this.frames + i;',
    '        if (this.curSilent > 0) {',
    '          if (this.curSilent > this.longestSilent) this.longestSilent = this.curSilent;',
    '          if (this.gapStart >= 0) {',
    '            this.gaps.push({ startFrame: this.gapStart, frames: this.curSilent });',
    '            if (this.gaps.length > 512) this.gaps.shift();',
    '          }',
    '          this.curSilent = 0; this.gapStart = -1;',
    '        }',
    '      } else {',
    '        this.silentFrames++;',
    '        if (this.curSilent === 0 && this.firstAudible >= 0) this.gapStart = this.frames + i;',
    '        this.curSilent++;',
    '      }',
    '    }',
    '    this.frames += n;',
    '    this.blocks++;',
    '    if (this.blocks % this.reportEvery === 0) this.post();',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("bem-tap", BemTap);'
  ].join('\n');

  function nowMs() { return (performance && performance.now) ? performance.now() : Date.now(); }

  function makeReport(ctx) {
    return {
      id: TAP.contexts.length,
      sampleRate: ctx.sampleRate,
      state: ctx.state,
      stateLog: [{ t: nowMs(), state: ctx.state }],
      tapMode: 'pending',
      baseLatency: (typeof ctx.baseLatency === 'number') ? ctx.baseLatency : null,
      outputLatency: null,
      frames: 0, silentFrames: 0, longestSilenceFrames: 0, curSilentFrames: 0,
      gaps: [], peak: 0, rmsMean: 0, clipFrames: 0,
      discontinuities: 0, maxStep: 0,
      firstAudibleFrame: -1, firstAudibleTime: null,
      blocks: 0,
      ctxTimeAtLastBlock: 0, wallAtLastBlock: 0,
      ctxTimeAtFirstBlock: null, wallAtFirstBlock: null,
      resumeCalls: 0, suspendCalls: 0, closeCalls: 0,
      createdAt: nowMs(),
      // how many distinct nodes were connected to what the page thinks is the
      // destination — 0 means the page never wired an output at all.
      destConnects: 0
    };
  }

  function installOn(ctx) {
    var rep;
    try {
      rep = makeReport(ctx);
      TAP.contexts.push(rep);

      // Shim destination: a GainNode standing in for ctx.destination. It is
      // wired straight to the real destination immediately, so audio is never
      // interrupted even if the worklet never loads.
      var realDest = Object.getPrototypeOf(ctx).__lookupGetter__
        ? Object.getPrototypeOf(ctx).__lookupGetter__('destination').call(ctx)
        : ctx.destination;
      var shim = ctx.createGain();
      shim.gain.value = 1;
      shim.connect(realDest);

      var origConnect = shim.connect.bind(shim);
      // count how many things connect INTO the shim (i.e. into "destination")
      var AN = (typeof AudioNode !== 'undefined') ? AudioNode.prototype : null;
      if (AN && !AN.__bemPatched) {
        var oc = AN.connect;
        AN.connect = function (dest) {
          try {
            for (var i = 0; i < TAP.contexts.length; i++) {
              if (TAP.contexts[i].__shim === dest) TAP.contexts[i].destConnects++;
            }
          } catch (e) { /* never break the graph */ }
          return oc.apply(this, arguments);
        };
        AN.__bemPatched = true;
      }
      rep.__shim = shim;

      Object.defineProperty(ctx, 'destination', {
        get: function () { return shim; },
        configurable: true
      });

      // state transitions (autoplay-policy suspends, and whether the page recovers)
      ctx.addEventListener('statechange', function () {
        rep.state = ctx.state;
        rep.stateLog.push({ t: nowMs(), state: ctx.state });
        if (rep.stateLog.length > 200) rep.stateLog.shift();
      });

      // count explicit resume/suspend so we can tell "page recovered" from
      // "user gesture happened to unstick it"
      ['resume', 'suspend', 'close'].forEach(function (m) {
        if (typeof ctx[m] !== 'function') return;
        var orig = ctx[m].bind(ctx);
        ctx[m] = function () {
          rep[m + 'Calls']++;
          return orig.apply(null, arguments);
        };
      });

      // Insert the measuring worklet between shim and real destination.
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        ctx.audioWorklet.addModule(url).then(function () {
          try {
            var node = new AudioWorkletNode(ctx, 'bem-tap', {
              numberOfInputs: 1, numberOfOutputs: 1,
              outputChannelCount: [2],
              processorOptions: {
                clickThreshold: CFG.clickThreshold,
                reportEveryBlocks: CFG.reportEveryBlocks
              }
            });
            node.port.onmessage = function (e) {
              var d = e.data;
              if (rep.wallAtFirstBlock === null) {
                rep.wallAtFirstBlock = nowMs();
                rep.ctxTimeAtFirstBlock = d.ctxTime;
              }
              rep.blocks = d.blocks;
              rep.frames = d.frames;
              rep.silentFrames = d.silentFrames;
              rep.longestSilenceFrames = d.longestSilenceFrames;
              rep.curSilentFrames = d.curSilentFrames;
              rep.peak = d.peak;
              rep.clipFrames = d.clipFrames;
              rep.discontinuities = d.discontinuities;
              rep.maxStep = d.maxStep;
              rep.firstAudibleFrame = d.firstAudibleFrame;
              rep.gaps = d.gaps;
              rep.rmsMean = d.frames > 0 ? Math.sqrt(d.sumSq / d.frames) : 0;
              rep.ctxTimeAtLastBlock = d.ctxTime;
              rep.wallAtLastBlock = nowMs();
              if (rep.firstAudibleTime === null && d.firstAudibleFrame >= 0) {
                rep.firstAudibleTime = nowMs();
              }
              rep.outputLatency = (typeof ctx.outputLatency === 'number') ? ctx.outputLatency : null;
            };
            shim.disconnect(realDest);
            shim.connect(node);
            node.connect(realDest);
            rep.tapMode = 'worklet';
            TAP.ready = true;
          } catch (err) {
            rep.tapMode = 'worklet-node-failed:' + err.message;
            TAP.errors.push(String(err));
          }
          try { URL.revokeObjectURL(url); } catch (e) {}
        }).catch(function (err) {
          rep.tapMode = 'addModule-failed:' + err.message;
          TAP.errors.push(String(err));
        });
      } else {
        rep.tapMode = 'no-audioworklet';
      }
    } catch (err) {
      TAP.errors.push('installOn: ' + String(err));
      if (rep) rep.tapMode = 'install-failed:' + err.message;
    }
    return ctx;
  }

  function wrap(Orig) {
    if (!Orig) return Orig;
    function Wrapped() {
      var ctx = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      installOn(ctx);
      return ctx;
    }
    Wrapped.prototype = Orig.prototype;
    Object.setPrototypeOf(Wrapped, Orig);
    return Wrapped;
  }

  try {
    if (window.AudioContext) window.AudioContext = wrap(window.AudioContext);
    if (window.webkitAudioContext) window.webkitAudioContext = wrap(window.webkitAudioContext);
  } catch (e) {
    TAP.errors.push('wrap: ' + String(e));
  }

  TAP.summary = function () {
    var out = {
      installedAt: TAP.installedAt,
      ready: TAP.ready,
      errors: TAP.errors.slice(),
      nContexts: TAP.contexts.length,
      contexts: TAP.contexts.map(function (r) {
        var wallSpan = (r.wallAtLastBlock && r.wallAtFirstBlock)
          ? (r.wallAtLastBlock - r.wallAtFirstBlock) / 1000 : 0;
        var ctxSpan = (r.ctxTimeAtLastBlock && r.ctxTimeAtFirstBlock !== null)
          ? (r.ctxTimeAtLastBlock - r.ctxTimeAtFirstBlock) : 0;
        var audible = r.frames - r.silentFrames;
        return {
          id: r.id, sampleRate: r.sampleRate, state: r.state, tapMode: r.tapMode,
          baseLatency: r.baseLatency, outputLatency: r.outputLatency,
          destConnects: r.destConnects,
          blocks: r.blocks, frames: r.frames,
          audibleFrames: audible,
          audibleSeconds: audible / (r.sampleRate || 48000),
          silentFrames: r.silentFrames,
          silentPct: r.frames ? (100 * r.silentFrames / r.frames) : null,
          longestSilenceMs: r.sampleRate ? (1000 * r.longestSilenceFrames / r.sampleRate) : null,
          gapsOverMin: r.gaps.filter(function (g) { return g.frames >= CFG.gapMinFrames; }).length,
          gapsSample: r.gaps.slice(-8),
          peak: r.peak, rmsMean: r.rmsMean, clipFrames: r.clipFrames,
          discontinuities: r.discontinuities, maxStep: r.maxStep,
          firstAudibleFrame: r.firstAudibleFrame,
          // audio-clock vs wall-clock: 1.0 == the device consumed exactly as
          // many seconds of audio as wall seconds elapsed.
          ctxWallRatio: wallSpan > 0.5 ? (ctxSpan / wallSpan) : null,
          wallSpanSec: wallSpan,
          stateLog: r.stateLog.slice(-20),
          resumeCalls: r.resumeCalls, suspendCalls: r.suspendCalls, closeCalls: r.closeCalls
        };
      })
    };
    return out;
  };
})();
