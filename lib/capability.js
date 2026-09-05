// lib/capability.js — the shared, honest capability layer for the emulator pages.
//
// WHAT THIS IS FOR
// ----------------
// gamecube.html, dreamcast.html and n64/index.html each grew their own excellent
// page-side probe, and each learned the same two lessons the hard way:
//
//   1. THE DECISIVE LINE PRINTS ONCE, EARLIEST, AND A ROLLING TAIL EVICTS IT.
//      dreamcast.html pins `[glinfo]` for exactly this reason (dreamcast.html:407);
//      gamecube.html pins `__gcGpu` for exactly this reason (gamecube.html:1392);
//      n64/index.html prints its `[gl]` line above the tail for exactly this
//      reason (n64/index.html:1680). Three independent rediscoveries of one rule.
//   2. THE PROBE MUST RUN BEFORE ANYTHING CAN FAIL, not on the Start click, or
//      every failure earlier than Start produces a report with no facts in it.
//
// What none of them had is a UNIFORM MACHINE-READABLE CONTRACT. Each page
// answered "what does this device have?" in its own shape, so no single test rig
// could ask all three the same question. That is what `window.__cap` is: one
// report shape, published by all three pages, which tools/device_matrix.mjs
// reads without knowing which page it is on.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: TEST FUNCTION, NOT PRESENCE.
// ---------------------------------------------------------------------
// Measured on this machine 2026-09-01, Chrome 140, gamecube.html:
//
//     flag                                    navigator.gpu   requestAdapter()
//     (none)                                  true            adapter
//     --disable-gpu                           TRUE            null
//     --disable-features=WebGPUService,Dawn   TRUE            null
//
// `!!navigator.gpu` is `true` on a machine with no WebGPU adapter whatsoever.
// A capability check that reads the property is not a capability check; it is a
// spelling check. Every field below is the RESULT OF DOING THE THING:
// requestAdapter+requestDevice+configure for WebGPU, a constructed and
// worker-posted SharedArrayBuffer for SAB, a completed colour+depth framebuffer
// for WebGL2, a constructed shared WebAssembly.Memory for threads.
//
// PUBLIC API
//   Capability.ready            Promise<report> — resolves once, when probes finish
//   Capability.get()            report | null   — synchronous, after ready
//   Capability.blockers(spec)   [{id,what,why,fix}] — hard blockers for a page's needs
//   Capability.verdict(spec)    {level,short,why} — one line, plain language
//   Capability.text(extra)      string          — the shareable report
//   Capability.share(text,btn)  system share sheet, clipboard fallback
//   Capability.gate(el,spec,o)  disable a Start control and SAY WHY
//   window.__cap                the report (the test-rig contract)
//
// Loading this file must never be able to break the page it is diagnosing, so
// every probe is individually wrapped, run() cannot escape without publishing a
// report, and the whole probe launch is inside one try.
//
// (This comment used to claim "the whole module is inside one try". It was not —
// there is no outer try, and the claim had been sitting above a bare
// `run(pageId)` call. Corrected rather than deleted, because the reason it was
// wrong is the interesting part: `window.Capability` is assigned BEFORE run()
// is called, so a throw in run() leaves the API present and `ready` pending
// FOREVER — which every page reads as "still probing" and none of them read as
// "broken". The fix is the idempotent publish() in run(), not an outer try that
// would have swallowed the throw and left ready pending anyway.)
(function () {
  'use strict';
  if (window.Capability) return;                 // idempotent: two pages may include it

  var VER = 1;
  function safe(fn, d) { try { var v = fn(); return (v === undefined || v === null) ? d : v; } catch (e) { return d; } }
  function errStr(e) { return (e && e.message) ? String(e.message) : String(e); }

  // ---------------------------------------------------------------------------
  // WebGPU — the full chain, because each link fails independently.
  //
  // Chrome's "Failed to create WebGPU Context Provider" is a CONTEXT failure that
  // happens with a live adapter AND a live device, so a probe that stops at
  // requestDevice() reports success on a machine that cannot present a frame.
  // gamecube.html:1409 records all three steps separately for that reason; this
  // adds the fourth, configure(), which is the step that actually throws in the
  // failing case.
  //
  // The device is DESTROYED again. This probe runs on every load of a page that
  // may also acquire its own device (gamecube.html:1428 holds one in
  // __gcWgpuDevice); leaving a second live device attached to the adapter for the
  // whole session is a cost the diagnosis does not need to impose.
  // ---------------------------------------------------------------------------
  function probeWebGPU() {
    var o = { present: !!navigator.gpu, adapter: false, device: false, canvasCtx: false,
              configured: false, vendor: '?', architecture: '?', device_: '?', format: '?', err: null };
    if (!o.present) { o.err = 'navigator.gpu is undefined — this browser exposes no WebGPU at all'; return Promise.resolve(o); }
    return Promise.resolve().then(function () {
      return navigator.gpu.requestAdapter();
    }).then(function (ad) {
      if (!ad) {
        // THE CASE THE PRESENCE CHECK MISSES. navigator.gpu is still an object here.
        o.err = 'navigator.gpu.requestAdapter() resolved null — no adapter. GPU blocklisted for this '
              + 'driver, WebGPU off by flag or enterprise policy, or a software/headless profile that refuses one.';
        return null;
      }
      o.adapter = true;
      var info = safe(function () { return ad.info; }, null);
      if (info) {
        o.vendor = String(info.vendor || '?'); o.architecture = String(info.architecture || '?');
        o.device_ = String(info.device || '?');
      }
      return ad.requestDevice();
    }).then(function (dev) {
      if (!dev) return null;
      o.device = true;
      o.format = safe(function () { return navigator.gpu.getPreferredCanvasFormat(); }, '?');
      var c = document.createElement('canvas'); c.width = c.height = 1;
      var ctx = safe(function () { return c.getContext('webgpu'); }, null);
      o.canvasCtx = !!ctx;
      if (!ctx) {
        o.err = 'canvas.getContext("webgpu") returned null — device is live but there is no presentable context';
      } else {
        // The step that actually throws behind "Failed to create WebGPU Context Provider".
        try { ctx.configure({ device: dev, format: o.format, alphaMode: 'opaque' }); o.configured = true; }
        catch (e) { o.err = 'context.configure() threw: ' + errStr(e); }
      }
      safe(function () { dev.destroy(); });
      return null;
    }).catch(function (e) {
      o.err = 'threw: ' + errStr(e);
      return null;
    }).then(function () { return o; });
  }

  // ---------------------------------------------------------------------------
  // WebGL2 — context, identity, AND a completed colour+depth framebuffer.
  //
  // A driver can advertise WebGL2 and still refuse to complete an FBO; both the
  // N64 core (glide2gl) and Flycast render through exactly that, so "has WebGL2"
  // without "completes an FBO" is not an answer. n64/index.html:1569 measures it
  // rather than assuming, and that is the behaviour generalised here.
  // Context is explicitly lost again — the emulator gets the one that counts.
  // ---------------------------------------------------------------------------
  // The attribute set the Dreamcast renderer actually asks for. Kept in one
  // place because the OffscreenCanvas probes below must ask for the SAME thing —
  // a device that grants a plain context and refuses this one is a device the
  // emulator cannot use, and a probe with softer attrs would report a pass.
  var GL_ATTRS = { alpha: false, depth: true, stencil: true, antialias: false };

  // ---------------------------------------------------------------------------
  // WEBGL2 ON AN OffscreenCanvas — a SEPARATE capability from WebGL2 on a
  // <canvas>, and the one dreamcast.html actually needs.
  //
  // dreamcast.html:2106 calls transferControlToOffscreen() and the emulator's
  // worker creates its own WebGL2 context on the transferred canvas
  // (dreamcast.html:1444: "This page renders WebGL2 from the worker"). After the
  // transfer the page can never take a main-thread context on that canvas at
  // all, so "does a <canvas> give me WebGL2 on the main thread" is not the
  // question for that page — it only looked like it.
  //
  // THE TWO ARE MEASURABLY DIFFERENT. Measured on this machine 2026-09-04,
  // Chrome, four arms, each cell the result of DOING it:
  //
  //     arm                <canvas>   new OffscreenCanvas   transferred   in a WORKER
  //     (none)             true       true                  true          true
  //     --disable-gpu      false      false                 false         false
  //     --disable-3d-apis  FALSE      TRUE                  TRUE          TRUE
  //     --use-gl=swiftshader false    false                 false         false
  //
  // Row three is the false negative that shipped: under --disable-3d-apis the
  // page probe returned null, `webgl2` was `required` in the dreamcast spec, and
  // Start was disabled reading "Cannot run here — This device is missing
  // WebGL2." IN THE SAME RUN in which the emulator's worker got a full WebGL2
  // context with depth and stencil granted and printed drawingBuffer=640x480.
  // Exactly the shape of the `coi` bug documented below: a true capability
  // measured on the wrong surface.
  //
  // Both spellings are recorded rather than one, because if they ever disagree
  // on a real device THAT is the finding; on all four arms above they agreed.
  function probeOffscreenGL2() {
    var o = { supported: (typeof OffscreenCanvas === 'function'),
              transferSupported: !!(window.HTMLCanvasElement
                && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'),
              newOk: null, xferOk: null, ok: false, err: null };
    if (!o.supported) { o.err = 'OffscreenCanvas is not defined'; return o; }
    var lose = function (gl) {
      try { var l = gl && gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {}
    };
    try {
      var g1 = new OffscreenCanvas(1, 1).getContext('webgl2', GL_ATTRS);
      o.newOk = !!g1; lose(g1);
    } catch (e) { o.newOk = false; o.err = 'new OffscreenCanvas(1,1).getContext("webgl2") threw: ' + errStr(e); }
    // Second opinion, taken ONLY when the first spelling refused. A GL context is
    // a scarce resource on a phone (iOS keeps a small pool) and this probe runs
    // on every page load, so it does not spend one to confirm a yes — it spends
    // one to avoid turning a single no into a dead page.
    if (o.newOk !== true && o.transferSupported) {
      try {
        var c = document.createElement('canvas'); c.width = c.height = 1;
        var g2 = c.transferControlToOffscreen().getContext('webgl2', GL_ATTRS);
        o.xferOk = !!g2; lose(g2);
      } catch (e) { o.xferOk = false; o.err = (o.err ? o.err + '; ' : '')
                                            + 'transferControlToOffscreen().getContext("webgl2") threw: ' + errStr(e); }
    }
    o.ok = (o.newOk === true) || (o.xferOk === true);
    if (!o.ok && !o.err) o.err = 'getContext("webgl2", {depth,stencil}) on an OffscreenCanvas returned null';
    return o;
  }

  function probeWebGL2() {
    var o = { ok: false, webgl1: false, fboComplete: null, stencil: null, depth: null,
              vendor: '?', renderer: '?', masked: true, maxTex: '?', maxRB: '?', glError: null, err: null,
              // Measured separately and NEVER folded into `ok` — see probeOffscreenGL2.
              offscreen: safe(probeOffscreenGL2, { supported: false, newOk: null, xferOk: null, ok: false,
                                                   err: 'the OffscreenCanvas WebGL2 probe threw' }),
              // Filled in later by the worker round-trip in run(); null until then.
              workerOffscreen: null };
    var gl = null;
    try {
      var c = document.createElement('canvas'); c.width = c.height = 1;
      gl = c.getContext('webgl2', GL_ATTRS);
      if (!gl) {
        o.err = 'getContext("webgl2", {depth,stencil}) returned null';
        o.plainWebgl2 = !!safe(function () { return c.getContext('webgl2'); }, null);
        o.webgl1 = !!safe(function () { return c.getContext('webgl'); }, null);
        return o;
      }
      o.ok = true;
      var a = safe(function () { return gl.getContextAttributes(); }, {}) || {};
      o.stencil = !!a.stencil; o.depth = !!a.depth;
      var dbg = safe(function () { return gl.getExtension('WEBGL_debug_renderer_info'); }, null);
      o.masked = !dbg;
      o.vendor = String(dbg ? safe(function () { return gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL); }, '?')
                            : safe(function () { return gl.getParameter(gl.VENDOR); }, '?'));
      o.renderer = String(dbg ? safe(function () { return gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); }, '?')
                              : safe(function () { return gl.getParameter(gl.RENDERER); }, '?'));
      o.maxTex = safe(function () { return gl.getParameter(gl.MAX_TEXTURE_SIZE); }, '?');
      o.maxRB = safe(function () { return gl.getParameter(gl.MAX_RENDERBUFFER_SIZE); }, '?');
      var fb = gl.createFramebuffer(), tx = gl.createTexture(), rb = gl.createRenderbuffer();
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 64, 64);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      o.fboComplete = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
      o.glError = safe(function () { return gl.getError(); }, null);
    } catch (e) { o.err = 'threw: ' + errStr(e); }
    finally { safe(function () { var l = gl && gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); }); }
    return o;
  }

  // ---------------------------------------------------------------------------
  // SharedArrayBuffer + Worker, together, because the thing that matters is not
  // "does the constructor exist" but "can a SAB actually reach a worker".
  //
  // Measured on this machine 2026-09-01 with the coi-serviceworker request
  // aborted: crossOriginIsolated false -> SharedArrayBuffer is not even DEFINED
  // in Chrome. Other engines keep the constructor and reject the postMessage
  // instead, which is the failure that looks like an emulator bug rather than a
  // missing header. One worker settles both, and doubles as the functional test
  // that this device can spawn a worker at all.
  // ---------------------------------------------------------------------------
  //
  // IT ALSO ASKS THE WORKER FOR A WEBGL2 CONTEXT, because that is the only
  // DIRECT measurement of what dreamcast.html needs — a WebGL2 context created
  // inside a worker on an OffscreenCanvas. The main-thread spellings in
  // probeOffscreenGL2 agreed with this one on all four arms measured, but they
  // are a proxy and this is the thing itself, so when this one answers it wins.
  // It rides along on the worker that already had to be spawned; no second
  // worker, no second timeout.
  function probeSabWorker() {
    var s = { ctor: (typeof SharedArrayBuffer === 'function'), constructed: false, postable: null,
              crossOriginIsolated: !!self.crossOriginIsolated, err: null };
    var w = { ctor: (typeof Worker === 'function'), spawned: false, err: null };
    var gl = { tested: false, ok: null, err: 'the worker probe did not run' };
    var sab = null;
    if (s.ctor) {
      try { sab = new SharedArrayBuffer(1024); s.constructed = (sab.byteLength === 1024); }
      catch (e) { s.err = 'new SharedArrayBuffer(1024) threw: ' + errStr(e); }
    } else {
      s.err = 'SharedArrayBuffer is not defined. In Chrome this is what a NON-cross-origin-isolated '
            + 'document looks like — the constructor is removed, not just restricted.';
    }
    if (!w.ctor) { w.err = 'Worker is not defined'; return Promise.resolve({ sab: s, worker: w, gl: gl }); }
    return new Promise(function (resolve) {
      var worker = null, done = false, url = null;
      function finish() {
        if (done) return; done = true;
        safe(function () { worker && worker.terminate(); });
        safe(function () { url && URL.revokeObjectURL(url); });
        resolve({ sab: s, worker: w, gl: gl });
      }
      // The worker's first act is to answer the WebGL2 question and announce
      // itself in the SAME message, so a worker that spawns but cannot take a GL
      // context still reports both facts. `-1` remains the "I am alive" sentinel
      // the SAB round-trip keys on; the GL verdict rides in a second field.
      var SRC =
        'function g(){var A={alpha:false,depth:true,stencil:true,antialias:false};'
        + 'if(typeof OffscreenCanvas!=="function")return{ok:false,err:"OffscreenCanvas is not defined in this worker"};'
        + 'try{var c=new OffscreenCanvas(1,1),x=c.getContext("webgl2",A);'
        + 'if(!x)return{ok:false,err:"getContext(\\"webgl2\\",{depth,stencil}) returned null inside a worker"};'
        + 'var a=x.getContextAttributes?x.getContextAttributes():{};'
        + 'try{var l=x.getExtension("WEBGL_lose_context");if(l)l.loseContext();}catch(e){}'
        + 'return{ok:true,stencil:!!a.stencil,depth:!!a.depth,err:null};}'
        + 'catch(e){return{ok:false,err:"threw inside the worker: "+(e&&e.message?e.message:String(e))};}}'
        + 'self.onmessage=function(e){self.postMessage(e.data&&e.data.byteLength||0);};'
        + 'self.postMessage({hello:-1,gl:g()});';
      try {
        url = URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onerror = function (e) { w.err = 'worker error: ' + (e && e.message ? e.message : 'unknown'); finish(); };
        worker.onmessage = function (ev) {
          var d = ev.data;
          if (d && typeof d === 'object' && d.hello === -1) {
            w.spawned = true;                       // it booted and spoke first
            if (d.gl) { gl = { tested: true, ok: !!d.gl.ok, stencil: d.gl.stencil, depth: d.gl.depth, err: d.gl.err }; }
            if (!s.constructed) { finish(); return; }
            try { worker.postMessage(sab); }        // the real structured-clone gate
            catch (e) { s.postable = false; s.err = 'postMessage(SharedArrayBuffer) threw: ' + errStr(e); finish(); }
            return;
          }
          s.postable = (d === 1024);                // the worker SAW the bytes
          finish();
        };
      } catch (e) { w.err = 'new Worker(blob:) threw: ' + errStr(e); finish(); }
      setTimeout(function () { if (!done) { w.err = w.err || 'worker did not respond within 3000 ms'; finish(); } }, 3000);
    });
  }

  // WebAssembly, including the two features the threaded cores actually require.
  function probeWasm() {
    var o = { supported: (typeof WebAssembly === 'object'), threads: false, memory64: false, err: null };
    if (!o.supported) { o.err = 'WebAssembly is not available'; return o; }
    // A SHARED memory is what a pthreads build imports; constructing one is the test.
    try { new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); o.threads = true; }
    catch (e) { o.err = 'shared WebAssembly.Memory refused: ' + errStr(e); }
    return o;
  }

  // ---------------------------------------------------------------------------
  // Memory headroom. Deliberately LAZY and OFF by default: allocating half a
  // gigabyte on every page view can itself be the thing that makes the real
  // allocation fail on a tight device — "the probe is the bug" (the same trap
  // n64/index.html:1585 calls out). Callers ask for it explicitly, and the rig
  // asks for it only in the reduced-memory arm.
  // ---------------------------------------------------------------------------
  var heapProbe = null;
  function probeHeap(mb) {
    mb = mb || 512;
    if (heapProbe) return heapProbe;
    var pages = Math.round(mb * 1024 * 1024 / 65536);
    try {
      var m = new WebAssembly.Memory({ initial: pages, maximum: pages });
      heapProbe = m ? ('granted ' + mb + ' MB') : ('REFUSED ' + mb + ' MB');
      m = null;
    } catch (e) { heapProbe = 'REFUSED ' + mb + ' MB: ' + errStr(e).slice(0, 120); }
    return heapProbe;
  }

  function probeEnv() {
    var n = navigator;
    return {
      ua: String(n.userAgent || ''),
      // iOS Safari is the case the device-emulation rig CANNOT actually reproduce
      // (it runs Chrome's engine behind an iOS user-agent string), so the report
      // records the claim and the touch evidence separately and never conflates them.
      iosUA: /iPhone|iPad|iPod/.test(String(n.userAgent || '')),
      touch: (('ontouchstart' in window) || (n.maxTouchPoints | 0) > 0),
      maxTouchPoints: n.maxTouchPoints | 0,
      vw: window.innerWidth, vh: window.innerHeight,
      sw: safe(function () { return screen.width; }, null), sh: safe(function () { return screen.height; }, null),
      dpr: window.devicePixelRatio || 1,
      cores: n.hardwareConcurrency || null,
      deviceMemoryGB: (n.deviceMemory === undefined ? null : n.deviceMemory),
      jsHeapLimitMB: safe(function () { return performance.memory.jsHeapSizeLimit >>> 20; }, null),
      lang: safe(function () { return n.language; }, null),
      // Network Information API — present in Chrome, absent in Safari; recorded
      // as null rather than guessed when the browser does not expose it.
      netType: safe(function () { return n.connection.effectiveType; }, null),
      netDownlink: safe(function () { return n.connection.downlink; }, null),
      saveData: safe(function () { return !!n.connection.saveData; }, null),
      audioWorklet: (typeof AudioWorklet === 'function'),
      indexedDB: (typeof indexedDB !== 'undefined'),
      wakeLock: !!(navigator.wakeLock),
      secureContext: !!self.isSecureContext
    };
  }

  // ---------------------------------------------------------------------------
  // Requirement specs. A page declares what it NEEDS; the module turns the
  // measured report into blockers. This is what makes "never present an enabled
  // Start behind a broken path" mechanical rather than a promise.
  //
  // Each entry: has(report) -> bool, plus the plain-language what/why/fix a
  // visitor can act on. `fix` is written for the VISITOR, not for a developer.
  // ---------------------------------------------------------------------------
  var REQ = {
    webgpu: {
      what: 'WebGPU',
      has: function (r) { return !!(r.webgpu && r.webgpu.adapter && r.webgpu.device); },
      why: function (r) { return (r.webgpu && r.webgpu.err) || 'no WebGPU adapter on this device'; },
      fix: 'Use Chrome or Edge 113+ on a desktop with a supported GPU. On Linux and in some managed '
         + 'browsers WebGPU is off by default — check chrome://gpu. Safari needs 17.4+ or the feature flag.'
    },
    webgl2: {
      what: 'WebGL2',
      has: function (r) { return !!(r.webgl2 && r.webgl2.ok); },
      why: function (r) { return (r.webgl2 && r.webgl2.err) || 'no WebGL2 context on this device'; },
      fix: 'Enable hardware acceleration in your browser settings, or update your graphics driver. '
         + 'Check chrome://gpu for a blocklisted driver.'
    },
    // ── THE REQUIREMENT dreamcast.html ACTUALLY HAS ──────────────────────────
    // Not "WebGL2", which is what its spec used to say: WebGL2 CREATED INSIDE A
    // WORKER, ON AN OffscreenCanvas. dreamcast.html:2106 hands the canvas away
    // with transferControlToOffscreen() and the emulator's worker takes the only
    // context there will ever be, so the main-thread `webgl2` probe is measuring
    // a surface that page never uses.
    //
    // FUNCTIONAL EVIDENCE WINS, in the order of how direct it is — the same rule
    // the `coi` blocker below was rewritten to obey after it disabled Start on a
    // browser where the emulator rendered perfectly. The worker round-trip is
    // the thing itself and is believed outright when it ran; the main-thread
    // OffscreenCanvas spellings are the fallback for when it could not.
    webgl2Worker: {
      what: 'WebGL2 inside a Web Worker (OffscreenCanvas)',
      has: function (r) {
        var g = r && r.webgl2; if (!g) return false;
        var off = g.offscreen || {};
        // BOTH HALVES, IN ORDER. The PAGE must be able to hand its canvas over
        // at all (dreamcast.html:2154 calls transferControlToOffscreen and has
        // no other route), and only then does the worker's answer matter. A
        // worker that could take a context is no help on a browser where the
        // page can never give it one — Safari 16.4 shipped exactly that,
        // OffscreenCanvas with a 2D context only.
        if (off.supported === false || off.transferSupported === false) return false;
        var wo = g.workerOffscreen;
        if (wo && wo.tested === true && typeof wo.ok === 'boolean') return wo.ok;
        return !!off.ok;
      },
      why: function (r) {
        var g = (r && r.webgl2) || {}, wo = g.workerOffscreen, off = g.offscreen || {};
        if (off.supported === false) {
          return 'this browser has no OffscreenCanvas, so a worker cannot be given a canvas to draw into';
        }
        if (off.transferSupported === false) {
          return 'this browser has OffscreenCanvas but not canvas.transferControlToOffscreen, so the page '
               + 'cannot hand its canvas to the worker that would draw into it';
        }
        if (wo && wo.tested === true && wo.ok === false) {
          return 'a Web Worker on this device could not get a WebGL2 context on an OffscreenCanvas'
               + (wo.err ? ' — ' + wo.err : '');
        }
        return 'WebGL2 on an OffscreenCanvas was refused' + (off.err ? ' — ' + off.err : '');
      },
      fix: 'The emulator draws from a background thread, which needs OffscreenCanvas plus WebGL2 inside '
         + 'a worker. Turn hardware acceleration back on in your browser settings, or use a newer browser: '
         + 'Chrome/Edge 69+, Firefox 105+, Safari 17+ (iOS 17+). On a TV, console or set-top browser this '
         + 'is often simply not available, and there is no setting that adds it.'
    },
    webgl2fbo: {
      what: 'a completed WebGL2 framebuffer',
      has: function (r) { return !!(r.webgl2 && r.webgl2.ok && r.webgl2.fboComplete); },
      why: function () { return 'WebGL2 is present but a colour+depth framebuffer does not complete — the emulator renders through exactly that'; },
      fix: 'Update your graphics driver. This is a driver limitation, not a browser setting.'
    },
    coi: {
      what: 'cross-origin isolation',
      // ⚠ THIS BLOCKER BROKE ITS OWN FILE'S RULE, and it gated the product.
      // It read `r.sab.crossOriginIsolated` — a REPORTED FLAG — while the `sab`
      // blocker directly below does the honest functional test (construct it,
      // post it to a worker). OBSERVED: the banner said "missing cross-origin
      // isolation" and Start was disabled IN THE SAME RUN where the emulator
      // booted and rendered. `coi` is `required` in both the gamecube and
      // dreamcast specs, so a false negative here disables Start on two pages.
      //
      // Cross-origin isolation is not the product; it is a MEANS to SharedArray-
      // Buffer. If SAB demonstrably constructs AND survives a postMessage, the
      // requirement is satisfied no matter what the flag reports — so the flag is
      // now only a fallback for when the functional probe could not run at all.
      // This is the third time today a presence check produced a false verdict:
      // a device matrix read `!!navigator.gpu` and returned twelve identical
      // rows under a flag that disables WebGPU, and `!!navigator.gpu` reads true
      // in BOTH WebGPU arms of the GameCube page, so only requestAdapter() +
      // requestDevice() can separate them.
      has: function (r) {
        if (!r.sab) return false;
        // Functional evidence wins, in either direction.
        if (r.sab.constructed && r.sab.postable !== false) return true;
        return !!r.sab.crossOriginIsolated;
      },
      // `has` now clears on functional evidence, so reaching this message means
      // BOTH the flag is false AND shared memory genuinely did not work. Saying
      // only "crossOriginIsolated is false" would repeat the presence-check
      // mistake in prose: it would name the flag as the finding when the finding
      // is that the thing the flag exists to enable is unavailable.
      why: function (r) {
        var s = r && r.sab;
        return 'crossOriginIsolated is false AND shared memory did not work'
             + (s && s.err ? ' — ' + s.err : ' — the COOP/COEP headers did not take effect');
      },
      fix: 'Reload the page once (the service worker installs the headers on first visit). If you are in '
         + 'a private window with service workers blocked, or behind a proxy that strips headers, this '
         + 'page cannot get the shared memory it needs.'
    },
    sab: {
      what: 'SharedArrayBuffer',
      has: function (r) { return !!(r.sab && r.sab.constructed && r.sab.postable !== false); },
      why: function (r) { return (r.sab && r.sab.err) || 'SharedArrayBuffer could not be created or sent to a worker'; },
      fix: 'This needs cross-origin isolation, which needs a reload on first visit. Private/incognito '
         + 'windows that block service workers cannot get it.'
    },
    worker: {
      what: 'Web Workers',
      has: function (r) { return !!(r.worker && r.worker.spawned); },
      why: function (r) { return (r.worker && r.worker.err) || 'a Web Worker could not be started'; },
      fix: 'Workers are blocked — usually by an extension or a strict content-blocker. Try again with '
         + 'extensions disabled.'
    },
    wasm: {
      what: 'WebAssembly',
      has: function (r) { return !!(r.wasm && r.wasm.supported); },
      why: function (r) { return (r.wasm && r.wasm.err) || 'WebAssembly is unavailable'; },
      fix: 'WebAssembly is disabled in this browser. It is required — there is no fallback.'
    },
    wasmThreads: {
      what: 'WebAssembly threads',
      has: function (r) { return !!(r.wasm && r.wasm.threads); },
      why: function (r) { return (r.wasm && r.wasm.err) || 'a shared WebAssembly.Memory was refused'; },
      fix: 'Threads need cross-origin isolation. Reload once; if it still fails, your browser is too old.'
    }
  };

  var report = null;
  var readyResolve, ready = new Promise(function (res) { readyResolve = res; });

  function blockers(spec) {
    var r = report; if (!r) return [];
    var out = [];
    Object.keys(spec || {}).forEach(function (id) {
      if (spec[id] !== 'required') return;
      var d = REQ[id]; if (!d) return;
      if (!d.has(r)) out.push({ id: id, what: d.what, why: d.why(r), fix: d.fix });
    });
    return out;
  }
  function degraded(spec) {
    var r = report; if (!r) return [];
    var out = [];
    Object.keys(spec || {}).forEach(function (id) {
      if (spec[id] !== 'degraded') return;
      var d = REQ[id]; if (!d) return;
      if (!d.has(r)) out.push({ id: id, what: d.what, why: d.why(r), fix: d.fix });
    });
    return out;
  }
  function verdict(spec) {
    if (!report) return { level: 'wait', short: 'checking this device…', why: 'capability probes have not resolved yet' };
    var b = blockers(spec);
    if (b.length) return {
      level: 'bad',
      short: 'This device is missing ' + b.map(function (x) { return x.what; }).join(' and ') + '.',
      why: b.map(function (x) { return x.what + ': ' + x.why + '\nWhat you can do: ' + x.fix; }).join('\n\n')
    };
    var d = degraded(spec);
    if (d.length) return {
      level: 'warn',
      short: 'Running without ' + d.map(function (x) { return x.what; }).join(' and ') + ' — expect reduced quality.',
      why: d.map(function (x) { return x.what + ': ' + x.why + '\nWhat you can do: ' + x.fix; }).join('\n\n')
    };
    return { level: 'ok', short: 'This device has everything this page needs.', why: '' };
  }

  function yn(v) { return v === true ? 'yes' : v === false ? 'NO' : String(v); }
  function text(extra) {
    var r = report;
    if (!r) return '[cap] probes have not resolved yet';
    var w = r.webgpu || {}, g = r.webgl2 || {}, s = r.sab || {}, k = r.worker || {}, m = r.wasm || {}, e = r.env || {};
    var L = [];
    L.push('--- CAPABILITY (measured by doing it, not by reading a property) ---');
    L.push('[cap] page=' + r.page + ' ver=' + r.ver + ' at +' + (r.ms | 0) + 'ms');
    L.push('[cap] WebGPU present=' + yn(w.present) + ' adapter=' + yn(w.adapter) + ' device=' + yn(w.device)
         + ' canvasCtx=' + yn(w.canvasCtx) + ' configured=' + yn(w.configured)
         + (w.vendor && w.vendor !== '?' ? ' gpu=' + w.vendor + '/' + w.architecture : '')
         + (w.err ? '\n[cap] WebGPU why: ' + w.err : ''));
    L.push('[cap] WebGL2 ok=' + yn(g.ok) + ' fboComplete=' + yn(g.fboComplete) + ' stencil=' + yn(g.stencil)
         + ' maxTex=' + g.maxTex + '\n[cap] WebGL2 gpu=' + g.vendor + ' / ' + g.renderer + (g.masked ? ' (masked)' : '')
         + (g.err ? '\n[cap] WebGL2 why: ' + g.err : ''));
    // The dreamcast page's REAL requirement, on its own line: WebGL2 taken on an
    // OffscreenCanvas, measured on three surfaces. A report that showed only the
    // main-thread number sent two readers to the wrong conclusion already.
    var go = g.offscreen || {}, gw = g.workerOffscreen || {};
    L.push('[cap] WebGL2-in-worker offscreenCanvas=' + yn(go.supported)
         + ' newOffscreen=' + yn(go.newOk) + ' transferred=' + yn(go.xferOk)
         + ' inWorker=' + (gw.tested ? yn(gw.ok) : 'not tested')
         + (go.err ? '\n[cap] WebGL2-in-worker why: ' + go.err : '')
         + (gw.tested && gw.err ? '\n[cap] WebGL2-in-worker (worker) why: ' + gw.err : ''));
    L.push('[cap] crossOriginIsolated=' + yn(s.crossOriginIsolated) + ' SAB ctor=' + yn(s.ctor)
         + ' constructed=' + yn(s.constructed) + ' postableToWorker=' + yn(s.postable)
         + (s.err ? '\n[cap] SAB why: ' + s.err : ''));
    L.push('[cap] Worker spawned=' + yn(k.spawned) + (k.err ? ' why=' + k.err : '')
         + '  WASM=' + yn(m.supported) + ' threads=' + yn(m.threads) + (m.err ? ' why=' + m.err : ''));
    if (heapProbe) L.push('[cap] heap probe: ' + heapProbe);
    L.push('[cap] window=' + e.vw + 'x' + e.vh + ' screen=' + e.sw + 'x' + e.sh + ' dpr=' + e.dpr
         + ' touch=' + yn(e.touch) + '/' + e.maxTouchPoints + ' cores=' + e.cores
         + ' deviceMemory=' + (e.deviceMemoryGB === null ? '?' : e.deviceMemoryGB + 'GB')
         + ' jsHeapLimit=' + (e.jsHeapLimitMB === null ? '?' : e.jsHeapLimitMB + 'MB'));
    L.push('[cap] net=' + (e.netType || '?') + ' downlink=' + (e.netDownlink === null ? '?' : e.netDownlink + 'Mbps')
         + ' saveData=' + yn(e.saveData) + ' secureContext=' + yn(e.secureContext)
         + ' AudioWorklet=' + yn(e.audioWorklet));
    L.push('[cap] ' + e.ua);
    if (extra) { L.push(''); L.push(String(extra)); }
    return L.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Getting a report OFF the device and into a message. Lifted from
  // dreamcast.html:890 — the system share sheet is the only route that works on
  // a phone, with clipboard as the fallback and "screenshot it" as the honest
  // last resort. A cancelled share lands in .catch, so it falls back rather than
  // silently doing nothing.
  // ---------------------------------------------------------------------------
  function flash(btn, msg) {
    if (!btn) return;
    var o = btn.textContent; btn.textContent = msg;
    setTimeout(function () { btn.textContent = o; }, 1600);
  }
  function toClipboard(btn, t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { flash(btn, '✓ Copied'); },
        function () { flash(btn, 'No clipboard — screenshot it'); });
    } else flash(btn, 'No clipboard — screenshot it');
  }
  function share(t, btn, title) {
    t = t || text();
    if (navigator.share) {
      navigator.share({ title: title || 'Emulator diagnostic', text: t })
        .then(function () { flash(btn, '✓ Shared'); })
        .catch(function () { toClipboard(btn, t); });
    } else toClipboard(btn, t);
  }

  // ---------------------------------------------------------------------------
  // gate(el, spec) — the mechanical form of "never present an enabled Start
  // behind a broken path". Disables the control, explains in the control itself,
  // and records the decision on the report so a test rig can assert it.
  //
  // `opts.allowAnyway` keeps an explicit escape hatch: a visitor who wants to see
  // it fail is entitled to, and a developer arm needs one. It is opt-in and it is
  // recorded, so a page can never quietly re-enable itself.
  //
  // TWO-LAYER OWNERSHIP OF THE START BUTTON. gamecube.html has its own
  // render-path guard on the same control (gamecube.html:1667). Disabling is
  // idempotent but ENABLING is not, so the two layers agreed on a protocol:
  //
  //   `aria-disabled="true"` means THIS layer is holding the button down.
  //   gamecube.html:1674 reads it and refuses to re-enable a button we hold.
  //
  // That makes this function the sole WRITER of `aria-disabled` and
  // `data-cap-blocked` on these controls, which in turn obliges it to CLEAR them
  // when it is no longer blocking — otherwise a stale `aria-disabled` from an
  // earlier call would pin the button down forever and the other layer, doing
  // exactly as agreed, would never re-enable it. Only marks this layer set are
  // cleared; `data-cap-blocked` is the proof of authorship.
  // ---------------------------------------------------------------------------
  function gate(el, spec, opts) {
    opts = opts || {};
    var v = verdict(spec), b = blockers(spec);
    var g = { blocked: b.length > 0, level: v.level, short: v.short, why: v.why,
              ids: b.map(function (x) { return x.id; }), overridden: !!opts.allowAnyway, applied: false };
    if (report) report.gate = g;
    if (!el) return g;
    try {
      if (g.blocked && !opts.allowAnyway) {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('data-cap-blocked', g.ids.join(','));
        if (opts.label !== false) el.textContent = opts.label || ('Cannot run here — ' + v.short);
        el.title = v.why;
        // IT MUST ALSO LOOK DEAD. The `disabled` property alone is not enough:
        // both mobile splash buttons are styled with an inviting green
        // (`#mobileSplash button#mobileSplashStart { background:#2a6b4a }` —
        // gamecube.html:95, dreamcast.html:156, n64/index.html:117), and a
        // screenshot of the gated page showed a bright green call-to-action
        // reading "Cannot run here". A control that still looks actionable is
        // still being PRESENTED to the visitor, which is the thing this is
        // supposed to stop. Inline styles so page CSS does not win; the originals
        // are stashed so a release can put them back.
        if (!el.__capStyle) {
          el.__capStyle = { background: el.style.background, borderColor: el.style.borderColor,
                            opacity: el.style.opacity, cursor: el.style.cursor, color: el.style.color,
                            pointerEvents: el.style.pointerEvents };
        }
        el.style.background = '#2a2a2a';
        el.style.borderColor = '#555';
        el.style.color = '#999';
        el.style.opacity = '0.75';
        el.style.cursor = 'not-allowed';
        // ⚠ `disabled` IS NOT ENOUGH ON A TOUCHSCREEN, AND THAT SHIPPED.
        // MEASURED 2026-09-01, Chrome 140, one real touch tap on a <button> with
        // `disabled = true` (exactly what the line above sets):
        //
        //     event         enabled control   disabled   disabled + pointer-events:none
        //     pointerdown          2              2                    0
        //     touchstart           1              1                    0
        //     click                2              0                    0
        //     mousedown            2              0                    0
        //
        // Chrome suppresses `click` and `mousedown` on a disabled form control
        // and DOES NOT suppress `pointerdown` or `touchstart`. Both mobile
        // splash Start handlers are bound to `pointerdown` — gamecube.html:6745
        // and n64/index.html:2628 both `preventDefault()` and then call
        // `startEmulator()` DIRECTLY, never consulting `disabled`.
        //
        // So the fix this whole module exists for was defeated by the phone it
        // was written for. MEASURED on the shipped pages under --disable-gpu at
        // an iPhone viewport, tapping the greyed-out button reading
        // "Cannot run here — This device is missing WebGPU.":
        //
        //   gamecube.html  splash flex->none, __gcStartedAtMs set, ppc-worker
        //                  spawned, disc prefetch started. Black canvas, and the
        //                  splash that carried the explanation is now GONE.
        //   n64/index.html splash flex->none, status became
        //                  "Load failed: Cannot read properties of undefined
        //                  (reading 'getParameter')" — the honest message
        //                  replaced by a raw TypeError.
        //   dreamcast.html inert (its handler goes through btnStart.click(), and
        //                  `click` IS suppressed) — it survived by accident.
        //
        // `pointer-events:none` is the only lever that stops all four event
        // types, so the lockout is INTERACTION-level, not just form-level. It is
        // stashed and restored with the rest of the look above.
        el.style.pointerEvents = 'none';
        g.applied = true;
      } else if (el.getAttribute('data-cap-blocked') !== null) {
        // We had been holding it and no longer are. Release OUR marks only, and
        // leave `disabled` for the other layer to decide — it may have its own
        // reason, and clearing that would be this layer overreaching in the
        // opposite direction.
        el.removeAttribute('aria-disabled');
        el.removeAttribute('data-cap-blocked');
        if (el.__capStyle) {                            // put the page's own look back
          el.style.background = el.__capStyle.background;
          el.style.borderColor = el.__capStyle.borderColor;
          el.style.color = el.__capStyle.color;
          el.style.opacity = el.__capStyle.opacity;
          el.style.cursor = el.__capStyle.cursor;
          // Releasing this one is load-bearing in the same way `aria-disabled`
          // is: a stale `pointer-events:none` would make a RECOVERED control
          // untappable forever, which is the same dead button in the other
          // direction. The suite asserts both halves.
          el.style.pointerEvents = el.__capStyle.pointerEvents;
          el.__capStyle = null;
        }
        g.released = true;
      }
    } catch (e) { /* a broken gate must never break the page it is gating */ }
    return g;
  }

  // ---------------------------------------------------------------------------
  // autoGate(spec, opts) — the whole honest-failure convergence in one call.
  //
  // The three pages had three different answers to "this device cannot run me":
  // gamecube.html printed an accurate `render: SOFTWARE — NO WebGPU ⚠` badge and
  // then LEFT START ENABLED, so the visitor clicked it and got a black screen
  // (measured: canvas 0,0,0, one distinct colour). dreamcast.html had the best
  // panel but reached it only through a button. n64/index.html had the best
  // pre-Start baseline report. This unifies the outcome:
  //
  //   1. probes ran BEFORE anything could fail            (the module load does this)
  //   2. say plainly WHAT is missing and WHAT TO DO       (the banner)
  //   3. never present an ENABLED Start behind a broken path (the gate)
  //   4. one shareable report                             (the banner's button)
  //
  // ?nogate=1 forces the page to run anyway. Developers need it, the sibling
  // work on the software-render path needs it, and a visitor is entitled to
  // watch it fail. It is recorded on the report, so a page can never quietly
  // re-enable itself: gate.overridden survives into the shared diagnostic.
  //
  // Everything here is defensive. A capability layer that breaks the page it is
  // diagnosing has made the problem worse.
  var BANNER_ID = 'capBanner';
  function banner(v, spec) {
    if (document.getElementById(BANNER_ID)) return document.getElementById(BANNER_ID);
    var d = document.createElement('div');
    d.id = BANNER_ID;
    d.setAttribute('role', 'alert');
    d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;box-sizing:border-box;'
      + 'padding:10px 12px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
      + 'background:' + (v.level === 'bad' ? '#3b1418' : '#3a3212') + ';'
      + 'color:' + (v.level === 'bad' ? '#ffd7d7' : '#f2e2a8') + ';'
      + 'border-bottom:1px solid ' + (v.level === 'bad' ? '#7a2630' : '#6b5a1c') + ';'
      + 'max-height:52vh;overflow:auto;-webkit-overflow-scrolling:touch;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:700;margin:0 0 4px;';
    h.textContent = v.short;
    var p = document.createElement('div');
    p.style.cssText = 'white-space:pre-wrap;opacity:.92;';
    p.textContent = v.why;
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:9px;';
    function mk(label) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.style.cssText = 'min-height:40px;min-width:104px;padding:9px 12px;border-radius:6px;cursor:pointer;'
        + 'border:1px solid #666;background:#222;color:#eee;font-size:13px;';
      row.appendChild(b); return b;
    }
    // The report is the ONLY artefact a visitor on a dead device can send back.
    // Share sheet first (the only thing that works on a phone), clipboard after.
    mk('Share report').addEventListener('click', function (e) { share(text(), e.currentTarget); });
    mk('Copy report').addEventListener('click', function (e) { toClipboard(e.currentTarget, text()); });
    if (v.level === 'bad') {
      var t = mk('Try anyway');
      t.title = 'Runs the emulator despite the missing capability. Expect it to fail.';
      t.addEventListener('click', function () {
        var u = new URL(location.href); u.searchParams.set('nogate', '1'); location.href = u.toString();
      });
    }
    d.appendChild(h); d.appendChild(p); d.appendChild(row);
    (document.body || document.documentElement).appendChild(d);
    return d;
  }
  function autoGate(spec, opts) {
    opts = opts || {};
    var override = /[?&]nogate=1/.test(location.search) || !!opts.allowAnyway;
    var v = verdict(spec);
    var g = { blocked: false, level: v.level, overridden: override };
    try {
      // BOTH Start controls. The desktop button and the mobile splash button are
      // separate elements on all three pages (#btnStart / #mobileSplashStart),
      // and gating only one of them leaves the phone — the device the original
      // report came from — with an enabled button behind a broken path.
      var ids = opts.startIds || ['btnStart', 'mobileSplashStart'];
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) g = gate(el, spec, { allowAnyway: override, label: opts.label });
      });
      if (!document.getElementById(ids[0]) && !document.getElementById(ids[1])) gate(null, spec, { allowAnyway: override });
      if (v.level === 'bad' || v.level === 'warn') banner(v, spec);
    } catch (e) { /* never take the page down */ }
    return report ? report.gate : g;
  }

  // ---------------------------------------------------------------------------
  // A PROBE THAT NEVER SETTLES IS A GATE THAT NEVER RUNS.
  //
  // All three pages wire their gate as `Capability.ready.then(… autoGate …)`
  // (gamecube.html:38, dreamcast.html:28, n64/index.html:28). If this promise
  // never resolves, autoGate never runs, and the page keeps an ENABLED Start in
  // front of whatever is broken — the exact failure this module exists to
  // prevent, reached by a different road. There is no visible error either: the
  // page just sits there looking fine.
  //
  // probeSabWorker already bounds itself (the 3000 ms worker timeout above). The
  // WebGPU chain does NOT: requestAdapter() and requestDevice() are driver calls
  // with no timeout of their own, and a hung or blocklisted driver is precisely
  // the device this layer is for. So the whole run is bounded, and an unfinished
  // probe is published as a NAMED timeout rather than silently missing — a
  // report that says "the probe did not settle" is actionable; one that never
  // arrives is not.
  var PROBE_BUDGET_MS = 8000;
  function withTimeout(p, ms, onFail) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(onFail(null)); } }, ms);
      function settle(v) { if (done) return; done = true; try { clearTimeout(t); } catch (e) {} resolve(v); }
      try { p.then(function (v) { settle(v); }, function (e) { settle(onFail(e)); }); }
      catch (e) { settle(onFail(e)); }
    });
  }
  function timedOut(e, what) {
    return e ? ('probe threw: ' + errStr(e))
             : (what + ' did not settle within ' + PROBE_BUDGET_MS + ' ms — treated as unavailable');
  }

  function run(pageId) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var r = { ver: VER, page: pageId, ms: 0, webgpu: null, webgl2: null, sab: null,
              worker: null, wasm: null, env: null, gate: null, timedOut: false };
    r.webgl2 = safe(probeWebGL2, { ok: false, fboComplete: null, err: 'probe threw' });
    r.wasm = safe(probeWasm, { supported: false, threads: false, err: 'probe threw' });
    r.env = safe(probeEnv, {});
    // publish() is idempotent and is the ONLY writer of `report`/`window.__cap`
    // in this path, so however run() ends — probes finished, probes timed out,
    // or something threw outright — exactly one report is published and `ready`
    // resolves exactly once.
    var published = false;
    function publish() {
      if (published) return r;
      published = true;
      r.ms = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
      report = r; window.__cap = r;
      try { readyResolve(r); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('capability', { detail: r })); }
      catch (e) { /* older engines: the promise is the contract, the event is a convenience */ }
      return r;
    }
    try {
      return Promise.all([
        withTimeout(probeWebGPU(), PROBE_BUDGET_MS, function (e) {
          if (!e) r.timedOut = true;
          return { present: !!navigator.gpu, adapter: false, device: false, canvasCtx: false,
                   configured: false, vendor: '?', architecture: '?', device_: '?', format: '?',
                   err: timedOut(e, 'the WebGPU probe (requestAdapter/requestDevice)') };
        }),
        withTimeout(probeSabWorker(), PROBE_BUDGET_MS, function (e) {
          if (!e) r.timedOut = true;
          return { sab: { ctor: (typeof SharedArrayBuffer === 'function'), constructed: false, postable: null,
                          crossOriginIsolated: !!self.crossOriginIsolated,
                          err: timedOut(e, 'the SharedArrayBuffer/worker probe') },
                   worker: { ctor: (typeof Worker === 'function'), spawned: false,
                             err: timedOut(e, 'the worker probe') },
                   // tested:false is load-bearing — REQ.webgl2Worker falls back to
                   // the main-thread OffscreenCanvas spellings rather than reading
                   // a timeout as a refusal.
                   gl: { tested: false, ok: null, err: timedOut(e, 'the in-worker WebGL2 probe') } };
        })
      ]).then(function (res) {
        r.webgpu = res[0];
        r.sab = res[1].sab; r.worker = res[1].worker;
        // The DIRECT measurement of the dreamcast requirement, folded onto the
        // webgl2 section so the whole GL picture is one object for the rig.
        if (r.webgl2) r.webgl2.workerOffscreen = res[1].gl || null;
        return publish();
      }, function () { return publish(); });
    } catch (e) {
      // Nothing above may take the page down, and a page with no report at all
      // is a page with no gate. Publish what was measured synchronously.
      r.webgpu = { present: !!navigator.gpu, adapter: false, device: false, canvasCtx: false,
                   configured: false, vendor: '?', architecture: '?', device_: '?', format: '?',
                   err: 'probe threw: ' + errStr(e) };
      r.sab = { ctor: (typeof SharedArrayBuffer === 'function'), constructed: false, postable: null,
                crossOriginIsolated: !!self.crossOriginIsolated, err: 'probe threw: ' + errStr(e) };
      r.worker = { ctor: (typeof Worker === 'function'), spawned: false, err: 'probe threw: ' + errStr(e) };
      return Promise.resolve(publish());
    }
  }

  window.Capability = {
    VER: VER, REQ: REQ, ready: ready,
    get: function () { return report; },
    blockers: blockers, degraded: degraded, verdict: verdict,
    text: text, share: share, gate: gate, autoGate: autoGate,
    probeHeap: probeHeap,
    // The per-page requirement specs, kept HERE rather than in each page, so the
    // rig, the suite and the pages cannot drift apart on what "required" means.
    SPECS: {
      // ⚠ webgpu STAYS 'required', and the reason is measured, not assumed.
      // Tried 'degraded' on 2026-09-05 after a real Xbox reported "This device is missing
      // WebGPU" and refused to start.  It made things WORSE.  The capability layer is not
      // what stops this page: gamecube.html:2397 disables Start on its OWN policy, because
      // without WebGPU Dolphin force-selects its CPU Software Renderer (Video.cpp:147) and
      // the page logs `[gpu] Start DISABLED: render: SOFTWARE — NO WebGPU`.  Demoting the
      // spec therefore did not enable anything — it only replaced the honest button text
      // "Cannot run here — This device is missing WebGPU." with a dead button still reading
      // "Start", which is precisely the dead-Start anti-pattern this layer exists to stop.
      // Making GameCube run on a WebGPU-less device is a RENDER-BACKEND job (a WebGL2/OGL
      // Dolphin build), not a gate edit.  Do not re-demote this without that build.
      gamecube:  { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgpu: 'required' },
      // ⚠ `webgl2Worker`, NOT `webgl2`. This page transfers its canvas to the
      // emulator worker (dreamcast.html:2106) and never takes a main-thread
      // context, so main-thread WebGL2 is not its requirement — and requiring it
      // produced a MEASURED false negative: under --disable-3d-apis the page
      // probe returned null and Start was disabled reading "Cannot run here",
      // in the same run in which the worker got a full WebGL2 context with
      // stencil granted and rendered. See REQ.webgl2Worker for the four-arm
      // table. n64/ keeps plain `webgl2` because it renders on the MAIN thread.
      dreamcast: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgl2Worker: 'required' },
      // THE PORTABILITY REFERENCE: single-threaded, no SAB, no COI, no WebGPU.
      // lib/capability.test.js asserts this spec stays that way.
      n64:       { wasm: 'required', webgl2: 'required' },

      // [ps1/gba/snes 2026-09-01] These three shipped with NO GATE AT ALL — a
      // visitor whose browser could not run them got a broken page and no
      // explanation, which is the exact class already fixed on the other three.
      //
      // Each spec is deliberately MINIMAL, from what the page actually does:
      //  * ps1  — loads /coi-serviceworker.js and creates a Worker, but its SAB
      //    use is a FAST PATH, not a requirement: ps1.html:246 reads
      //    `if (typeof SharedArrayBuffer !== 'function') return false;` and
      //    carries on, and wasmpsx_worker.js contains ZERO SAB references. So
      //    coi/sab are NOT required — gating on them would block a browser that
      //    runs the page perfectly, which is a bug this layer has shipped once
      //    already (see the `coi` blocker note above).
      //  * gba  — deliberately loads no coi-serviceworker, no SAB, no Worker.
      //  * snes — single-threaded, no SAB (snes.html:9 records why).
      // All three render through a 2D canvas context, per the vendored cores,
      // so none of them requires WebGL2 or WebGPU.
      // ⚠ ps1 deliberately does NOT require `worker`, even though it creates
      // one. The worker probe spawns from a BLOB URL (see probeSabWorker: it
      // builds an object URL and does `new Worker(url)`), while ps1.html's own
      // worker is a SAME-ORIGIN script. An environment that blocks blob:
      // workers while permitting same-origin ones — a strict CSP, some
      // content-blockers — would report spawned:false and gate a page that
      // runs perfectly. That is precisely the failure this layer already
      // shipped once with `coi`, so the requirement is left off until there is
      // evidence a real visitor is blocked by a worker failure. A worker that
      // genuinely fails still surfaces as a broken page; it just is not
      // something this gate claims to predict.
      ps1:       { wasm: 'required' },
      gba:       { wasm: 'required' },
      snes:      { wasm: 'required' }
    },
    // Exposed for the self-test only: lets the suite feed a synthetic report
    // through the SAME blockers()/verdict()/gate() code the page uses.
    _setReport: function (r) { report = r; window.__cap = r; return r; }
  };

  // Page id from the path, so one file serves all three without configuration.
  var p = location.pathname;
  var pageId = /gamecube/.test(p) ? 'gamecube' : /dreamcast/.test(p) ? 'dreamcast'
             : /\/n64/.test(p) ? 'n64'
             : /ps1/.test(p) ? 'ps1' : /gba/.test(p) ? 'gba' : /snes/.test(p) ? 'snes'
             : (p.replace(/^.*\//, '') || 'index');
  run(pageId);

  // ?captest=1 — the module's own suite. Loaded lazily and only on request, so
  // it costs a shipped visitor nothing. See lib/capability.test.js.
  if (/[?&]captest=1/.test(location.search)) {
    var s = document.createElement('script');
    // A LITERAL, ABSOLUTE URL on purpose. tools/verify_deploy_assets.mjs only
    // asserts on absolute literal URLs it can see statically — a concatenated
    // one is reported UNCHECKED, which is how two runtime assets stayed 404 on
    // the live site while being present in git. Written this way, the deploy
    // gate can prove the suite ships too. (An earlier cut concatenated it via a
    // ternary whose two branches were identical, which bought nothing and hid
    // the URL from the gate.)
    s.src = '/lib/capability.test.js';
    document.head.appendChild(s);
  }
})();
