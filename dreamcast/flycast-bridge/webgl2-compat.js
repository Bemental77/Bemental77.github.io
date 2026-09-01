/**
 * WebGL2 Compatibility Patches for Flycast WASM (worker-side).
 *
 * Injected into the emcc factory via --pre-js. Patches BOTH
 * HTMLCanvasElement.prototype.getContext (page-side, if a non-transferred
 * canvas slips through) and OffscreenCanvas.prototype.getContext (our actual
 * worker-side path under -sOFFSCREENCANVAS_SUPPORT=1).
 *
 * Three Flycast/glsm-vs-WebGL2 incompatibilities fixed:
 *   1. GL_VERSION / GL_SHADING_LANGUAGE_VERSION strings
 *   2. GL_INVALID_ENUM suppression around FBO setup
 *   3. texParameteri/f no-op when the target has no texture bound
 *
 * Also filters two noisy console.warn streams.
 *
 * DEVICE DIAGNOSTICS (added because a phone session produced no evidence at
 * all): this file now owns the only always-on GL error signal in the build.
 * See the __flycastBridgeLog and getError blocks below.
 */

// Leading semicolon: emscripten 6.x's shell emits its last statement before
// the --pre-js insertion point WITHOUT a trailing semicolon
// (`... globalThis.name == "em-pthread"`), so an IIFE here would parse as a
// call expression on that string ("em-pthread" is not a function). The
// semicolon terminates the shell's statement no matter what it emits.
;(function () {
  // -------------------------------------------------------------------------
  // __flycastBridgeLog — the ONE way worker-side JS in this bridge reaches the
  // user's screen. Exported on globalThis so gl_override.js (--js-library,
  // merged into the same factory scope) can use it without duplicating the
  // realm logic.
  //
  // Route, each hop read: postMessage({cmd:'print'})
  //   -> dreamcast.html's worker onmessage `case 'print': pageLog(d.txt)`
  //   -> the page's #log element.
  // A bare console.log does NOT reach the page — it only lands in DevTools,
  // and on a phone nobody has DevTools. console.log is still emitted as a
  // second channel for a desktop human and for flycast_probe.js.
  //
  // Guarded on globalThis.name !== 'em-pthread' for the same reason the
  // MARKER block in flycast_worker_link.sh and the werrLog helper in
  // flycast_libretro/flycast_worker.js are: pthread children load this same
  // factory, and a child's postMessage goes to the emcc parent pthread
  // protocol, which swallows unknown commands. From a child we fall back to
  // console.error, which flycast_worker.js records as reaching the probe from
  // BOTH realms.
  //
  // There is no -sPROXY_TO_PTHREAD in flycast_worker_link.sh (only -pthread
  // and -sPTHREAD_POOL_SIZE=8), so the emscripten "main runtime thread" IS
  // this shim worker, and the WebGL2 context plus every call made through it
  // lives there (EmscriptenWorker.cpp :: emscripten_create_gl_context, whose
  // own log says "WebGL2 ctx created on main-runtime thread"). So the
  // postMessage arm is the one that actually runs for GL callbacks.
  // -------------------------------------------------------------------------
  var isPthread = (typeof globalThis !== 'undefined' && globalThis.name === 'em-pthread');
  function bridgeLog(txt) {
    try { if (typeof console !== 'undefined' && console.log) console.log(txt); } catch (_) {}
    try {
      if (!isPthread && typeof postMessage === 'function') postMessage({ cmd: 'print', txt: txt });
      else if (typeof console !== 'undefined' && console.error) console.error(txt);
    } catch (_) {}
  }
  if (typeof globalThis !== 'undefined') globalThis.__flycastBridgeLog = bridgeLog;

  if (typeof console !== 'undefined' && console.warn) {
    var origWarn = console.warn;
    console.warn = function () {
      if (arguments.length > 0 && typeof arguments[0] === 'string') {
        var msg = arguments[0];
        if (msg.indexOf('__syscall_mprotect') !== -1) return;
        if (msg.indexOf('is not a valid value') !== -1) return;
      }
      return origWarn.apply(console, arguments);
    };
  }

  // -------------------------------------------------------------------------
  // Flood caps. Every number here is small on purpose.
  //
  // Unbounded per-event logging is a PROVEN failure mode in this project, not
  // a hypothetical: the per-memory-access [gdrom] trace emitted 51,867 of
  // 53,319 console lines in one 60-second run and throttled the very poll loop
  // it was observing, so the guest never left the disc bootstrap and the run
  // read as a boot wedge (recorded in the DIAG-flavor banner in
  // flycast_worker_link.sh). A GL error inside a
  // draw path repeats on every draw call — exactly the same shape. So: log the
  // first few in full, then only on a power-of-two ladder, then stop entirely
  // with one closing line.
  // -------------------------------------------------------------------------
  var GLERR_VERBOSE_FIRST = 3;    // first N of each class get a full report
  var GLERR_MAX_LINES     = 12;   // hard ceiling per class, ladder included
  var GLERR_MAX_DRAIN     = 64;   // bound the 0x500 drain loop (was unbounded)

  // Milliseconds since this file was evaluated, stamped on every error line.
  // Without it a screenshot cannot tell an init-time error (the GL-version /
  // vendor probes in GLGraphicsContext::findGLVersion (core/wsi/gl_context.cpp)
  // and findGLVersion (core/rend/gles/gles.cpp) legitimately generate and drain errors on
  // every platform, desktop included) from a steady-state one — and only the
  // steady-state ones are the mobile signal. (Symbol anchors, not line
  // numbers: core/rend/gles/ is under active edit by another owner.)
  // Anchors: GLGraphicsContext::findGLVersion() in core/wsi/gl_context.cpp
  // (`glGetIntegerv(GL_MAJOR_VERSION)` then `if (glGetError() == GL_INVALID_ENUM)`),
  // and findGLVersion() in core/rend/gles/gles.cpp
  // (`while (glGetError() != GL_NO_ERROR) ;` right after the vendor NOTICE_LOG).
  var _now = (typeof performance !== 'undefined' && performance.now)
      ? function () { return performance.now(); } : function () { return Date.now(); };
  var _t0 = _now();
  function since() { return ' t=+' + Math.round(_now() - _t0) + 'ms'; }

  // extraFn is a thunk, not a string: it is only invoked for the first
  // GLERR_VERBOSE_FIRST occurrences that actually get logged, so building an
  // Error stack costs nothing on the silenced path.
  function makeErrReporter(tag) {
    var count = 0, lines = 0, nextLadder = 4, done = false;
    return function (extraFn) {
      count++;
      if (done) return count;
      var verbose = count <= GLERR_VERBOSE_FIRST;
      var ladder  = count >= nextLadder;
      if (!verbose && !ladder) return count;
      if (ladder) nextLadder *= 2;
      if (lines >= GLERR_MAX_LINES) {
        done = true;
        bridgeLog('[glcompat] ' + tag + ': log cap reached at ' + count +
                  ' — further occurrences are counted but SILENCED');
        return count;
      }
      lines++;
      var extra = '';
      if (verbose && typeof extraFn === 'function') {
        try { extra = ' ' + extraFn(); } catch (_) {}
      } else if (typeof extraFn === 'string' && extraFn) {
        extra = ' ' + extraFn;
      }
      bridgeLog('[glcompat] ' + tag + ' #' + count + since() + extra);
      return count;
    };
  }

  function patchCtx(ctx) {
    if (!ctx || ctx.__flycastPatched) return ctx;
    ctx.__flycastPatched = true;

    var origGetParam = ctx.getParameter.bind(ctx);
    ctx.getParameter = function (pname) {
      if (pname === 0x1F02 || pname === ctx.VERSION) return 'OpenGL ES 3.0 WebGL 2.0';
      if (pname === 0x8B8C || pname === ctx.SHADING_LANGUAGE_VERSION) return 'OpenGL ES GLSL ES 3.00';
      return origGetParam(pname);
    };

    // -----------------------------------------------------------------------
    // getError: keep swallowing GL_INVALID_ENUM, but COUNT and REPORT it.
    //
    // Why the swallow must stay: GLGraphicsContext::findGLVersion() in
    // core/wsi/gl_context.cpp calls glGetIntegerv(GL_MAJOR_VERSION) and treats
    // a following GL_INVALID_ENUM as "this context is GLES2", forcing
    // majorVersion=2. That downgrades the entire renderer — the `else` arm of
    // findGLVersion()'s `if (gl.gl_major >= 3)` in core/rend/gles/gles.cpp
    // selects the GLES2 shader subset, u16 indices and GL_ALPHA as the
    // single-channel format. Letting 0x500 through here would regress every
    // platform, so it stays.
    //
    // Why it must be REPORTED: 0x500 is PRECISELY the error a mobile driver
    // raises for a format / filter / enum that the desktop driver accepts, and
    // this drain is the reason no such error has ever been visible from a
    // device. Nothing downstream can see it either — glCheck() in
    // core/rend/gles/gles.h reads glGetError(), so it can never observe a
    // 0x500 that we consumed first. This counter is the only place 0x500
    // exists in the entire system.
    //
    // Always on, and effectively free: glGetError is not called per-frame in
    // this build (the drains in GLGraphicsContext::findGLVersion and in
    // gles.cpp's findGLVersion are init-time; glCheck() is compiled out by
    // default), so this is a branch and an increment on an init-time path.
    // -----------------------------------------------------------------------
    var reportInvalidEnum = makeErrReporter('swallowed GL_INVALID_ENUM (0x0500)');
    var reportRealError   = makeErrReporter('GL error reached the core');
    var origGetError = ctx.getError.bind(ctx);
    ctx.getError = function () {
      var err = origGetError();
      var drained = 0;
      while (err === 0x500) {
        // A stack for the first few only: under emcc the frames name the wasm
        // function that made the offending call, which is the whole point.
        // new Error().stack is not cheap — the thunk is invoked only when the
        // reporter has decided this occurrence is one of the verbose ones.
        reportInvalidEnum(function () {
          return 'stack=' + String(new Error().stack || '').split('\n').slice(1, 8).join(' | ');
        });
        if (++drained >= GLERR_MAX_DRAIN) {
          // Previously unbounded. A driver that keeps reporting 0x500 would
          // hang the worker here with no message at all.
          bridgeLog('[glcompat] getError: ' + GLERR_MAX_DRAIN +
                    ' consecutive GL_INVALID_ENUM — giving up the drain, returning 0x500 to the core');
          return 0x500;
        }
        err = origGetError();
      }
      // Everything that is NOT 0x500 does reach the C side, but the C side
      // discards it unless the build has -DFLYCAST_GL_CHECKS (gles.h). Report
      // it here so a stock production build on a phone still says something.
      if (err !== 0) {
        var name = ({ 0x501: 'GL_INVALID_VALUE', 0x502: 'GL_INVALID_OPERATION',
                      0x505: 'GL_OUT_OF_MEMORY', 0x506: 'GL_INVALID_FRAMEBUFFER_OPERATION',
                      0x507: 'GL_CONTEXT_LOST', 0x9242: 'GL_CONTEXT_LOST_WEBGL' })[err] || 'GL_<unknown>';
        reportRealError(name + ' (0x' + err.toString(16) + ')');
      }
      return err;
    };

    var texBindings = {};
    texBindings[ctx.TEXTURE_2D]       = ctx.TEXTURE_BINDING_2D;
    texBindings[ctx.TEXTURE_CUBE_MAP] = ctx.TEXTURE_BINDING_CUBE_MAP;
    texBindings[ctx.TEXTURE_3D]       = ctx.TEXTURE_BINDING_3D;
    texBindings[ctx.TEXTURE_2D_ARRAY] = ctx.TEXTURE_BINDING_2D_ARRAY;

    var origTexParameteri = ctx.texParameteri.bind(ctx);
    ctx.texParameteri = function (target, pname, param) {
      var b = texBindings[target];
      if (b && !origGetParam(b)) return;
      return origTexParameteri(target, pname, param);
    };
    var origTexParameterf = ctx.texParameterf.bind(ctx);
    ctx.texParameterf = function (target, pname, param) {
      var b = texBindings[target];
      if (b && !origGetParam(b)) return;
      return origTexParameterf(target, pname, param);
    };

    reportContext(ctx, origGetParam);
    return ctx;
  }

  // -------------------------------------------------------------------------
  // One-shot device report, emitted once per context at creation.
  //
  // This is the single highest-value thing a phone can send back: it names the
  // actual GPU (WebGL masks the vendor as "WebKit"/"Mozilla" unless
  // WEBGL_debug_renderer_info is asked for), states which context attributes
  // the driver actually GRANTED (a phone can silently refuse stencil, which
  // breaks modifier volumes), and lists the limits the renderer sizes itself
  // against. Bounded output — a fixed number of lines, no per-frame component.
  //
  // NOTE: this only READS. It deliberately does not feed the unmasked vendor
  // back into glGetString(GL_VENDOR), because findGLVersion() in
  // core/rend/gles/gles.cpp derives `gl.mali = !stricmp(vendor, "arm")` from it
  // and core/rend/gl4/gldraw.cpp switches the depth-stencil format on that flag
  // (`gl.mali ? GL_DEPTH24_STENCIL8 : GL_DEPTH32F_STENCIL8`). Turning a
  // diagnostic into a behavior change is exactly what we are trying not to do.
  // -------------------------------------------------------------------------
  function reportContext(ctx, getParam) {
    try {
      var vendor = String(getParam(0x1F00));      // GL_VENDOR (masked)
      var rend   = String(getParam(0x1F01));      // GL_RENDERER (masked)
      var uv = '?', ur = '?';
      try {
        var dbg = ctx.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          uv = String(getParam(dbg.UNMASKED_VENDOR_WEBGL));
          ur = String(getParam(dbg.UNMASKED_RENDERER_WEBGL));
        }
      } catch (_) {}
      bridgeLog('[glinfo] gpu masked="' + vendor + '" / "' + rend +
                '" unmasked="' + uv + '" / "' + ur + '"');

      var a = {};
      try { a = ctx.getContextAttributes() || {}; } catch (_) {}
      bridgeLog('[glinfo] granted attrs depth=' + a.depth + ' stencil=' + a.stencil +
                ' alpha=' + a.alpha + ' antialias=' + a.antialias +
                ' preserveDrawingBuffer=' + a.preserveDrawingBuffer +
                ' powerPreference=' + a.powerPreference +
                ' failIfMajorPerformanceCaveat=' + a.failIfMajorPerformanceCaveat);

      bridgeLog('[glinfo] limits maxTex=' + getParam(0x0D33) +          // MAX_TEXTURE_SIZE
                ' maxRB=' + getParam(0x84E8) +                          // MAX_RENDERBUFFER_SIZE
                ' maxVaryingVec=' + getParam(0x8DFC) +                  // MAX_VARYING_VECTORS
                ' maxVertUniformVec=' + getParam(0x8DFB) +              // MAX_VERTEX_UNIFORM_VECTORS
                ' maxFragUniformVec=' + getParam(0x8DFD) +              // MAX_FRAGMENT_UNIFORM_VECTORS
                ' maxTexUnits=' + getParam(0x8872) +                    // MAX_TEXTURE_IMAGE_UNITS
                ' maxSamples=' + getParam(0x8D57) +                     // MAX_SAMPLES
                ' maxDrawBuf=' + getParam(0x8824));                     // MAX_DRAW_BUFFERS

      bridgeLog('[glinfo] drawingBuffer=' + ctx.drawingBufferWidth + 'x' + ctx.drawingBufferHeight);

      var exts = [];
      try { exts = ctx.getSupportedExtensions() || []; } catch (_) {}
      // The full list matters on mobile — a missing EXT_color_buffer_float or
      // a missing compressed-texture family is a concrete, fixable cause.
      bridgeLog('[glinfo] ' + exts.length + ' extensions: ' + exts.join(' '));

      // Context loss is the classic mobile failure (GPU process OOM / app
      // backgrounded). Without this the page just goes black and says nothing.
      // OffscreenCanvas fires contextlost/contextrestored; the HTMLCanvas path
      // uses the webgl-prefixed names. Register both, ignore what does not exist.
      try {
        var target = ctx.canvas;
        if (target && typeof target.addEventListener === 'function') {
          ['webglcontextlost', 'contextlost'].forEach(function (n) {
            target.addEventListener(n, function () {
              bridgeLog('[glinfo] *** WEBGL CONTEXT LOST (' + n + ') *** — the GPU process dropped ' +
                        'this context. Everything after this line is meaningless; the canvas will stay black.');
            }, false);
          });
          ['webglcontextrestored', 'contextrestored'].forEach(function (n) {
            target.addEventListener(n, function () {
              bridgeLog('[glinfo] webgl context restored (' + n + ') — Flycast does NOT rebuild its ' +
                        'GL objects on restore, so the renderer is still dead.');
            }, false);
          });
        }
      } catch (_) {}
    } catch (e) {
      bridgeLog('[glinfo] context report failed: ' + (e && e.message ? e.message : e));
    }
    bridgeLog('[flycast-wasm] patched WebGL2 context');
  }

  function wrapPrototype(proto) {
    if (!proto || !proto.getContext) return;
    var orig = proto.getContext;
    proto.getContext = function (type, attrs) {
      var ctx = orig.call(this, type, attrs);
      if (type === 'webgl2' || type === 'experimental-webgl2') {
        if (!ctx) {
          // A phone that refuses the attribute set (or has no WebGL2 at all)
          // used to produce exactly nothing here.
          bridgeLog('[glinfo] *** getContext("' + type + '") returned NULL *** — no WebGL2 context ' +
                    'on this device/browser for attrs=' + (function () {
                      try { return JSON.stringify(attrs); } catch (_) { return '?'; }
                    })() + '. Nothing downstream can run.');
        } else {
          patchCtx(ctx);
        }
      }
      return ctx;
    };
  }

  if (typeof HTMLCanvasElement !== 'undefined') wrapPrototype(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas    !== 'undefined') wrapPrototype(OffscreenCanvas.prototype);
})();
