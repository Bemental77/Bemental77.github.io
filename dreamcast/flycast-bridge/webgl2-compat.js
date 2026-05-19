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
 */

(function () {
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

  function patchCtx(ctx) {
    if (!ctx || ctx.__flycastPatched) return ctx;
    ctx.__flycastPatched = true;

    var origGetParam = ctx.getParameter.bind(ctx);
    ctx.getParameter = function (pname) {
      if (pname === 0x1F02 || pname === ctx.VERSION) return 'OpenGL ES 3.0 WebGL 2.0';
      if (pname === 0x8B8C || pname === ctx.SHADING_LANGUAGE_VERSION) return 'OpenGL ES GLSL ES 3.00';
      return origGetParam(pname);
    };

    var origGetError = ctx.getError.bind(ctx);
    ctx.getError = function () {
      var err = origGetError();
      while (err === 0x500) err = origGetError();
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

    if (typeof console !== 'undefined' && console.log) {
      console.log('[flycast-wasm] patched WebGL2 context');
    }
    return ctx;
  }

  function wrapPrototype(proto) {
    if (!proto || !proto.getContext) return;
    var orig = proto.getContext;
    proto.getContext = function (type, attrs) {
      var ctx = orig.call(this, type, attrs);
      if (type === 'webgl2' || type === 'experimental-webgl2') patchCtx(ctx);
      return ctx;
    };
  }

  if (typeof HTMLCanvasElement !== 'undefined') wrapPrototype(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas    !== 'undefined') wrapPrototype(OffscreenCanvas.prototype);
})();
