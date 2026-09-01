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
// every probe is individually wrapped and the whole module is inside one try.
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
  function probeWebGL2() {
    var o = { ok: false, webgl1: false, fboComplete: null, stencil: null, depth: null,
              vendor: '?', renderer: '?', masked: true, maxTex: '?', maxRB: '?', glError: null, err: null };
    var gl = null;
    try {
      var c = document.createElement('canvas'); c.width = c.height = 1;
      gl = c.getContext('webgl2', { alpha: false, depth: true, stencil: true, antialias: false });
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
  function probeSabWorker() {
    var s = { ctor: (typeof SharedArrayBuffer === 'function'), constructed: false, postable: null,
              crossOriginIsolated: !!self.crossOriginIsolated, err: null };
    var w = { ctor: (typeof Worker === 'function'), spawned: false, err: null };
    var sab = null;
    if (s.ctor) {
      try { sab = new SharedArrayBuffer(1024); s.constructed = (sab.byteLength === 1024); }
      catch (e) { s.err = 'new SharedArrayBuffer(1024) threw: ' + errStr(e); }
    } else {
      s.err = 'SharedArrayBuffer is not defined. In Chrome this is what a NON-cross-origin-isolated '
            + 'document looks like — the constructor is removed, not just restricted.';
    }
    if (!w.ctor) { w.err = 'Worker is not defined'; return Promise.resolve({ sab: s, worker: w }); }
    return new Promise(function (resolve) {
      var worker = null, done = false, url = null;
      function finish() {
        if (done) return; done = true;
        safe(function () { worker && worker.terminate(); });
        safe(function () { url && URL.revokeObjectURL(url); });
        resolve({ sab: s, worker: w });
      }
      try {
        url = URL.createObjectURL(new Blob(
          ['self.onmessage=function(e){self.postMessage(e.data&&e.data.byteLength||0);};self.postMessage(-1);'],
          { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onerror = function (e) { w.err = 'worker error: ' + (e && e.message ? e.message : 'unknown'); finish(); };
        worker.onmessage = function (ev) {
          if (ev.data === -1) {
            w.spawned = true;                       // it booted and spoke first
            if (!s.constructed) { finish(); return; }
            try { worker.postMessage(sab); }        // the real structured-clone gate
            catch (e) { s.postable = false; s.err = 'postMessage(SharedArrayBuffer) threw: ' + errStr(e); finish(); }
            return;
          }
          s.postable = (ev.data === 1024);          // the worker SAW the bytes
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
      why: function () { return 'crossOriginIsolated is false — the COOP/COEP headers did not take effect'; },
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
  // ---------------------------------------------------------------------------
  function gate(el, spec, opts) {
    opts = opts || {};
    var v = verdict(spec), b = blockers(spec);
    var g = { blocked: b.length > 0, level: v.level, short: v.short, why: v.why,
              ids: b.map(function (x) { return x.id; }), overridden: !!opts.allowAnyway, applied: false };
    if (report) report.gate = g;
    if (el && g.blocked && !opts.allowAnyway) {
      try {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('data-cap-blocked', g.ids.join(','));
        if (opts.label !== false) el.textContent = opts.label || ('Cannot run here — ' + v.short);
        el.title = v.why;
        g.applied = true;
      } catch (e) { /* a broken gate must never break the page it is gating */ }
    }
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

  function run(pageId) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var r = { ver: VER, page: pageId, ms: 0, webgpu: null, webgl2: null, sab: null,
              worker: null, wasm: null, env: null, gate: null };
    r.webgl2 = safe(probeWebGL2, { ok: false, err: 'probe threw' });
    r.wasm = safe(probeWasm, { supported: false, err: 'probe threw' });
    r.env = safe(probeEnv, {});
    return Promise.all([
      probeWebGPU().catch(function (e) { return { present: !!navigator.gpu, adapter: false, err: 'probe threw: ' + errStr(e) }; }),
      probeSabWorker().catch(function (e) { return { sab: { err: 'probe threw: ' + errStr(e) }, worker: { err: 'probe threw' } }; })
    ]).then(function (res) {
      r.webgpu = res[0];
      r.sab = res[1].sab; r.worker = res[1].worker;
      r.ms = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
      report = r; window.__cap = r;
      readyResolve(r);
      try {
        window.dispatchEvent(new CustomEvent('capability', { detail: r }));
      } catch (e) { /* older engines: the promise is the contract, the event is a convenience */ }
      return r;
    });
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
      gamecube:  { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgpu: 'required' },
      dreamcast: { wasm: 'required', worker: 'required', coi: 'required', sab: 'required', webgl2: 'required' },
      // THE PORTABILITY REFERENCE: single-threaded, no SAB, no COI, no WebGPU.
      // lib/capability.test.js asserts this spec stays that way.
      n64:       { wasm: 'required', webgl2: 'required' }
    },
    // Exposed for the self-test only: lets the suite feed a synthetic report
    // through the SAME blockers()/verdict()/gate() code the page uses.
    _setReport: function (r) { report = r; window.__cap = r; return r; }
  };

  // Page id from the path, so one file serves all three without configuration.
  var p = location.pathname;
  var pageId = /gamecube/.test(p) ? 'gamecube' : /dreamcast/.test(p) ? 'dreamcast'
             : /\/n64/.test(p) ? 'n64' : (p.replace(/^.*\//, '') || 'index');
  run(pageId);

  // ?captest=1 — the module's own suite. Loaded lazily and only on request, so
  // it costs a shipped visitor nothing. See lib/capability.test.js.
  if (/[?&]captest=1/.test(location.search)) {
    var s = document.createElement('script');
    s.src = (location.pathname.indexOf('/n64/') === 0 ? '/lib/' : '/lib/') + 'capability.test.js';
    document.head.appendChild(s);
  }
})();
