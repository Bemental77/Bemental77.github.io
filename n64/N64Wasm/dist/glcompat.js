// glcompat.js — THE CORE'S GL CONTEXT: WebGL2 when the device has it, WebGL1 when it does not.
// Shared by the page (main-thread core) and the core worker, like fbasync.js.
//
// WHY. Reported 2026-10-06 from Edge on an Xbox: getContext("webgl2", {depth,stencil}) returned
// null, the capability gate blocked Start, and with ?nogate=1 the core died with
//   "Load failed: Cannot read properties of undefined (reading 'getParameter')"
// — emscripten's GL.createContext had returned 0, SDL went on without a context, and the first
// glGetString read GLctx.getParameter off an undefined GLctx. The core was linked
// MIN_WEBGL_VERSION=2, so it had no other option.
//
// WHAT THE CORE NEEDS IS GLES2. glide2gl/Glitch64 is GLES2-era code: its shaders are
// "#version 100" (glitch64_combiner.c GLSL_VERSION), and everything else it draws with exists in
// WebGL1 (VAOs and 32-bit indices through OES_vertex_array_object / OES_element_index_uint, which
// emscripten enables by default). The link is now -s MIN_WEBGL_VERSION=1 -s MAX_WEBGL_VERSION=2:
// THE .wasm IS BYTE-IDENTICAL (2630440f either way — only the JS glue dispatches at run time), so
// every JIT corpus and every state fingerprint of the WebGL2 path is untouched.
//
// HOW. SDL asks EGL for a GLES3 context; emscripten's EGL calls
//   canvas.getContext("webgl2", EGL.contextAttributes)       (contextAttributes.majorVersion = 2)
// and registers the context with version = contextAttributes.majorVersion, READ AFTER getContext
// returns (libwebgl.js GL.createContext -> registerContext). So this file wraps getContext for
// that one request (the only caller that passes `majorVersion`) and walks a ladder:
//     webgl2 (attrs as asked) -> webgl2 relaxed -> webgl (attrs) -> webgl relaxed -> experimental-webgl
// "relaxed" = no stencil, no antialias, failIfMajorPerformanceCaveat:false, powerPreference default.
// When it lands on WebGL1 it sets attrs.majorVersion = 1, so emscripten runs its WebGL1 paths.
// (The link has GL_WORKAROUND_SAFARI_GETCONTEXT_BUG=0: that workaround wraps getContext itself and
// nulls any context whose class does not match the name asked for; the same check is done here.)
//
// On a WebGL1 context it also maps the few GLES3 enums the core passes to their GLES2 spelling
// (glitchmain.c grLfbCaptureWindow: glTexImage2D(..., GL_RGB8, ...); depth/stencil renderbuffers),
// and gives texStorage2D a texImage2D equivalent. Nothing here touches a WebGL2 context.
//
//   __n64InstallGLCompat(G, search)  installs G.__n64GL and the getContext wrappers of the realm.
// Query switches:
//   ?webgl=1     use WebGL1 even where WebGL2 exists — the arm that runs the fallback on any machine
//   ?webgl=2     WebGL2 only (no fallback) — the old behaviour, a control arm
//   ?gllog=1     on a WebGL1 context, log the first 40 GL errors with the call that raised them
(function (root) {
  root.__n64InstallGLCompat = function (G, search) {
    if (G.__n64GL) return G.__n64GL;
    var Q = new URLSearchParams(search || '');
    var want = Q.get('webgl');
    var st = G.__n64GL = { want: want === '1' || want === '2' ? +want : 0, v: 0, kind: null, rung: null,
                           tries: [], attrs: null, renderer: null, errs: [], decided: null };
    var W2 = G.WebGL2RenderingContext, W1 = G.WebGLRenderingContext;
    var isW2 = function (gl) { return !!(gl && W2 && gl instanceof W2); };
    var isW1 = function (gl) { return !!(gl && W1 && gl instanceof W1); };
    var relaxed = function (a) {
      var o = {}; for (var k in a) o[k] = a[k];
      o.stencil = false; o.antialias = false; o.failIfMajorPerformanceCaveat = false; o.powerPreference = 'default';
      return o;
    };
    // What THIS device can do, measured on a throwaway canvas before the core asks — the page's
    // diagnostics and the worker's boot preflight read it. The core's own request is decided by
    // the ladder below, on its own canvas, with its own attributes.
    st.probe = function () {
      if (st.probed) return st.probed;
      // The surface the core will draw on in THIS realm: a <canvas> on the page (MEASURED: Chrome
      // --disable-webgl2 refuses webgl2 on a <canvas> while an OffscreenCanvas still grants it),
      // an OffscreenCanvas in the worker.
      var mk = function () {
        if (G.document) { var c = G.document.createElement('canvas'); c.width = c.height = 1; return c; }
        if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
        return null;
      };
      var r = { webgl2: false, webgl1: false };
      var one = function (kind) {
        try {
          var c = mk(); if (!c) return false;
          var gl = c.getContext(kind, { failIfMajorPerformanceCaveat: false });
          var ok = kind === 'webgl2' ? isW2(gl) : isW1(gl);
          try { var l = gl && gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {}
          return ok;
        } catch (e) { return false; }
      };
      if (st.want !== 1) r.webgl2 = one('webgl2');
      if (!r.webgl2 || st.want === 1) r.webgl1 = one('webgl');
      r.v = st.want === 1 ? (r.webgl1 ? 1 : 0) : st.want === 2 ? (r.webgl2 ? 2 : 0) : (r.webgl2 ? 2 : r.webgl1 ? 1 : 0);
      st.probed = r;
      return r;
    };
    var wrapProto = function (P) {
      if (!P || P.__n64GLWrapped) return;
      var orig = P.getContext;
      if (typeof orig !== 'function') return;
      P.__n64GLWrapped = true;
      P.getContext = function (kind, attrs) {
        // Only emscripten's context request carries `majorVersion`; everything else (the page's
        // bitmaprenderer, 2D, probes, a rig) goes straight through.
        if (st.v || !attrs || typeof attrs !== 'object' || !('majorVersion' in attrs) || (kind !== 'webgl2' && kind !== 'webgl')) {
          return orig.apply(this, arguments);
        }
        var cv = this, gl = null;
        var tryOne = function (k, a, rung) {
          var g = null, err = null;
          try { g = orig.call(cv, k, a); } catch (e) { err = String((e && e.message) || e).slice(0, 120); g = null; }
          if (g && (k === 'webgl2' ? !isW2(g) : isW2(g))) { err = 'context of the wrong class for "' + k + '"'; g = null; }
          st.tries.push(rung + (g ? ' ok' : ' null') + (err ? ' (' + err + ')' : ''));
          if (g) { st.kind = k; st.rung = rung; }
          return g;
        };
        if (kind === 'webgl2' && st.want !== 1) {
          gl = tryOne('webgl2', attrs, 'webgl2');
          if (!gl) gl = tryOne('webgl2', relaxed(attrs), 'webgl2-relaxed');
          if (gl) st.v = 2;
        }
        if (!gl && st.want !== 2) {
          var a1 = attrs;
          gl = tryOne('webgl', a1, 'webgl');
          if (!gl) gl = tryOne('webgl', relaxed(a1), 'webgl-relaxed');
          if (!gl) gl = tryOne('experimental-webgl', relaxed(a1), 'experimental-webgl');
          if (gl) { st.v = 1; attrs.majorVersion = 1; attrs.minorVersion = 0; installW1(); }
        }
        if (gl) {
          try { st.attrs = gl.getContextAttributes(); } catch (e) {}
          try {
            var dbg = gl.getExtension('WEBGL_debug_renderer_info');
            st.renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
          } catch (e) {}
          st.decided = 'WebGL' + st.v + ' via ' + st.rung;
        } else {
          st.decided = 'NO WebGL context: ' + st.tries.join('; ');
        }
        return gl;
      };
    };
    // ---- GLES3 spellings the core passes, mapped for a WebGL1 context (only ever installed on the
    // WebGL1 prototype, so a WebGL2 context never sees any of it). -------------------------------
    var w1Installed = false;
    var installW1 = function () {
      if (w1Installed || !W1) return;
      w1Installed = true;
      var P = W1.prototype;
      var FMT = { 0x8051: 0x1907 /* RGB8 -> RGB */, 0x8058: 0x1908 /* RGBA8 -> RGBA */,
                  0x8229: 0x1909 /* R8 -> LUMINANCE */ };
      var ti = P.texImage2D;
      P.texImage2D = function (t, l, ifmt) {
        if (FMT[ifmt]) { var a = Array.prototype.slice.call(arguments); a[2] = FMT[ifmt]; return ti.apply(this, a); }
        return ti.apply(this, arguments);
      };
      var RB = { 0x88F0: 0x84F9 /* DEPTH24_STENCIL8 -> DEPTH_STENCIL */, 0x81A6: 0x81A5 /* DEPTH_COMPONENT24 -> 16 */,
                 0x8CAC: 0x81A5 /* DEPTH_COMPONENT32F -> 16 */, 0x8058: 0x8056 /* RGBA8 -> RGBA4 */ };
      var rs = P.renderbufferStorage;
      P.renderbufferStorage = function (t, f, w, h) { return rs.call(this, t, RB[f] || f, w, h); };
      if (typeof P.texStorage2D !== 'function') {
        P.texStorage2D = function (t, levels, ifmt, w, h) {
          var f = FMT[ifmt] || (ifmt === 0x8D62 ? 0x1907 : 0x1908);   // RGB565 -> RGB, else RGBA
          var ty = ifmt === 0x8D62 ? 0x8363 : 0x1401;                  // UNSIGNED_SHORT_5_6_5 / UNSIGNED_BYTE
          for (var i = 0; i < Math.max(1, levels); i++) ti.call(this, t, i, f, Math.max(1, w >> i), Math.max(1, h >> i), 0, f, ty, null);
        };
      }
      // A read-buffer select is a no-op on WebGL1 (one colour attachment): the default is the only one.
      if (typeof P.readBuffer !== 'function') P.readBuffer = function () {};
      // ---- the core's OWN overlay/text shader pair is GLSL ES 3.00 -----------------------------
      // mymain.cpp initShaders() compiles shader_vert.hlsl / shader_frag.hlsl from assets.zip, and
      // both are "#version 300 es" with layout(location = N) attributes. On WebGL1 that fails
      // ("unsupported shader version") and the core then dies in glAttachShader on a null shader —
      // MEASURED under --disable-webgl2 with ?worker=0. glide's own shaders are "#version 100" and
      // never reach this. A 300-es source is rewritten to 100 (in/out -> attribute/varying,
      // texture() -> texture2D(), the fragment output -> gl_FragColor) and its layout locations are
      // bound with bindAttribLocation before the program links, so glVertexAttribPointer(0/1, ...)
      // still feeds the same attributes.
      var ss = P.shaderSource, as = P.attachShader, lp = P.linkProgram;
      P.shaderSource = function (sh, src) {
        // glitchmain.c's native-resolution sampling pass (nf_vs_text / nf_fs_text): gl_VertexID,
        // texelFetch and integer lookup rows. Given its GLES2 equivalent below (NATIVE SAMPLING).
        if (typeof src === 'string' && /^\s*#version\s+300\s+es/.test(src) && /gl_VertexID/.test(src) && !/texelFetch/.test(src)) {
          try { sh.__n64Locs = [[0, 'nfPos']]; sh.__nf = 1; } catch (e) {}
          st.nfShaders = (st.nfShaders | 0) + 1;
          return ss.call(this, sh, NF_VS);
        }
        if (typeof src === 'string' && /^\s*#version\s+300\s+es/.test(src) && /texelFetch\s*\(\s*xs/.test(src)) {
          try { sh.__nf = 2; } catch (e) {}
          st.nfShaders = (st.nfShaders | 0) + 1;
          return ss.call(this, sh, NF_FS);
        }
        if (typeof src === 'string' && /^\s*#version\s+300\s+es/.test(src)) {
          var vert = /\bgl_Position\b/.test(src), locs = [];
          var out = src.replace(/^\s*#version\s+300\s+es[^\n]*\n/, '');
          out = out.replace(/layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(\w+)\s+(\w+)\s*;/g, function (m, l, ty, nm) {
            locs.push([+l, nm]); return 'attribute ' + ty + ' ' + nm + ';';
          });
          if (vert) {
            out = out.replace(/(^|\n)\s*in\s+(\w+\s+\w+\s*;)/g, '$1attribute $2').replace(/(^|\n)\s*out\s+(\w+\s+\w+\s*;)/g, '$1varying $2');
          } else {
            var fragOut = null;
            out = out.replace(/(^|\n)\s*(?:layout\s*\([^)]*\)\s*)?out\s+vec4\s+(\w+)\s*;/, function (m, pre, nm) { fragOut = nm; return pre; });
            out = out.replace(/(^|\n)\s*in\s+(\w+\s+\w+\s*;)/g, '$1varying $2');
            if (fragOut) out = '#define ' + fragOut + ' gl_FragColor\n' + out;
            // highp is optional in a GLES2 fragment shader: a mobile GPU without it must still compile
            out = out.replace(/precision\s+highp\s+float\s*;/, '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif');
          }
          out = out.replace(/\btexture\s*\(/g, 'texture2D(');
          try { sh.__n64Locs = locs; } catch (e) {}
          st.translated = (st.translated | 0) + 1;
          return ss.call(this, sh, out);
        }
        return ss.apply(this, arguments);
      };
      P.attachShader = function (prog, sh) {
        try { if (prog && sh && sh.__nf) prog.__nfParts = (prog.__nfParts | 0) | sh.__nf; } catch (e) {}
        try { if (prog && sh && sh.__n64Locs && sh.__n64Locs.length) (prog.__n64Locs = prog.__n64Locs || []).push.apply(prog.__n64Locs, sh.__n64Locs); } catch (e) {}
        return as.apply(this, arguments);
      };
      P.linkProgram = function (prog) {
        try { if (prog && prog.__n64Locs) for (var i = 0; i < prog.__n64Locs.length; i++) this.bindAttribLocation(prog, prog.__n64Locs[i][0], prog.__n64Locs[i][1]); } catch (e) {}
        return lp.apply(this, arguments);
      };
      // ---- NATIVE SAMPLING ON WEBGL1 ------------------------------------------------------------
      // glitchmain.c nf_sample point-samples the window down to the N64's own size on the GPU and
      // reads back only that; glide's LAZY framebuffer copy (Glide64/lazy_fb.c) is built on it. If
      // the pass fails once (nf_failed) the core falls back to eager full-window copies for good —
      // which MEASURED (n64_worker_probe --mode exact, MK64, M=WebGL1 vs W=WebGL2): identical CPU
      // fingerprints for 900 frames but RDRAM different from frame 60, because the WebGL2 console's
      // unobserved copies were still lazy. Two consoles of one room must hold the same machine, so
      // the pass is made to RUN on WebGL1, with the same inputs and the same output bytes:
      //   * the shaders: the vertex index comes from a 3-vertex buffer bound at the draw (WebGL1
      //     has no gl_VertexID); texelFetch -> texture2D at texel centres (NEAREST, CLAMP: exact);
      //     the R32I lookup rows are uploaded as RGBA8 (low byte R, high byte G) and decoded.
      //   * the GLES3-only state the pass saves and restores around itself — sampler bindings, the
      //     read/draw framebuffer split, the pixel-pack binding, RASTERIZER_DISCARD, BASE/MAX_LEVEL —
      //     is answered or ignored WITHOUT raising a GL error, because the pass checks glGetError
      //     afterwards and a single error marks it failed for good.
      var NF_VS = 'attribute vec2 nfPos;\nvoid main(){gl_Position=vec4(nfPos,0.0,1.0);}\n';
      var NF_FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n'
        + 'uniform sampler2D src; uniform sampler2D xs; uniform sampler2D ys; uniform vec4 nfSz;\n'
        + 'float lut(sampler2D t,float i,float w){vec4 v=texture2D(t,vec2((i+0.5)/w,0.5));return floor(v.r*255.0+0.5)+256.0*floor(v.g*255.0+0.5);}\n'
        + 'void main(){vec2 d=floor(gl_FragCoord.xy);float x=lut(xs,d.x,nfSz.z);float y=lut(ys,d.y,nfSz.w);'
        + 'gl_FragColor=texture2D(src,vec2((x+0.5)/nfSz.x,(y+0.5)/nfSz.y));}\n';
      var lp2 = P.linkProgram;
      P.linkProgram = function (prog) {
        var r = lp2.apply(this, arguments);
        try { if (prog && prog.__nfParts === 3) { prog.__isNf = true; prog.__nfSzLoc = this.getUniformLocation(prog, 'nfSz'); } } catch (e) {}
        return r;
      };
      var up = P.useProgram;
      P.useProgram = function (prog) { this.__curProg = prog || null; return up.apply(this, arguments); };
      var TB2D = 0x8069, ACT = 0x84E0, AB = 0x8892, ABB = 0x8894;
      var texAt = function (gl, unit) {
        var was = gl.getParameter(ACT);
        gl.activeTexture(0x84C0 + unit);
        var t = gl.getParameter(TB2D);
        gl.activeTexture(was);
        return t;
      };
      var da = P.drawArrays;
      P.drawArrays = function (mode, first, count) {
        var pr = this.__curProg;
        if (pr && pr.__isNf) {
          try {
            if (!this.__nfBuf) {
              this.__nfBuf = this.createBuffer();
              var wasB = this.getParameter(ABB);
              this.bindBuffer(AB, this.__nfBuf);
              this.bufferData(AB, new Float32Array([-1, -1, 3, -1, -1, 3]), 0x88E4 /* STATIC_DRAW */);
              this.bindBuffer(AB, wasB);
            }
            var wb = this.getParameter(ABB);
            this.bindBuffer(AB, this.__nfBuf);
            this.enableVertexAttribArray(0);
            this.vertexAttribPointer(0, 2, 0x1406 /* FLOAT */, false, 0, 0);
            this.bindBuffer(AB, wb);
            var s0 = texAt(this, 0), s1 = texAt(this, 1), s2 = texAt(this, 2);
            if (pr.__nfSzLoc) this.uniform4f(pr.__nfSzLoc, (s0 && s0.__w) || 1, (s0 && s0.__h) || 1, (s1 && s1.__w) || 1, (s2 && s2.__w) || 1);
            st.nfPasses = (st.nfPasses | 0) + 1;
          } catch (e) { st.nfErr = String((e && e.message) || e).slice(0, 120); }
        }
        return da.apply(this, arguments);
      };
      // texture sizes (the sampling pass needs them as uniforms) and the R32I lookup rows
      var ti2 = P.texImage2D;
      P.texImage2D = function (t, l, ifmt, w, h, b, fmt, ty, data) {
        if (arguments.length >= 9 && l === 0 && t === 0x0DE1) {
          try { var bt = this.getParameter(TB2D); if (bt) { bt.__w = w; bt.__h = h; } } catch (e) {}
          if (ifmt === 0x8235 /* R32I */ && fmt === 0x8D94 /* RED_INTEGER */) {
            var n = w * h, u = new Uint8Array(n * 4);
            if (data) for (var i = 0; i < n; i++) { var v = data[i] | 0; u[i * 4] = v & 255; u[i * 4 + 1] = (v >> 8) & 255; }
            var ua = this.getParameter(0x0CF5 /* UNPACK_ALIGNMENT */);
            this.pixelStorei(0x0CF5, 1);
            var rr = ti2.call(this, t, l, 0x1908, w, h, 0, 0x1908, 0x1401, u);
            this.pixelStorei(0x0CF5, ua);
            return rr;
          }
        }
        return ti2.apply(this, arguments);
      };
      // GLES3-only state, answered without a GL error
      var gp = P.getParameter;
      P.getParameter = function (p) {
        if (p === 0x8919 /* SAMPLER_BINDING */ || p === 0x88ED /* PIXEL_PACK_BUFFER_BINDING */ || p === 0x88EF /* PIXEL_UNPACK */) return null;
        if (p === 0x8CAA /* READ_FRAMEBUFFER_BINDING */) return gp.call(this, 0x8CA6);
        return gp.apply(this, arguments);
      };
      var ie = P.isEnabled, en = P.enable, dis = P.disable;
      var ES3CAP = { 0x8C89: 1 /* RASTERIZER_DISCARD */, 0x8D69: 1 /* PRIMITIVE_RESTART_FIXED_INDEX */ };
      P.isEnabled = function (c) { return ES3CAP[c] ? false : ie.apply(this, arguments); };
      P.enable = function (c) { if (ES3CAP[c]) return; return en.apply(this, arguments); };
      P.disable = function (c) { if (ES3CAP[c]) return; return dis.apply(this, arguments); };
      if (typeof P.bindSampler !== 'function') P.bindSampler = function () {};
      var bf = P.bindFramebuffer;
      P.bindFramebuffer = function (t, fb) { return bf.call(this, (t === 0x8CA8 || t === 0x8CA9) ? 0x8D40 : t, fb); };
      var bb = P.bindBuffer;
      P.bindBuffer = function (t, b) { if (t === 0x88EB || t === 0x88EC) return; return bb.apply(this, arguments); };
      var tp = P.texParameteri;
      P.texParameteri = function (t, p, v) { if (p === 0x813C || p === 0x813D || p === 0x8072 /* WRAP_R */) return; return tp.apply(this, arguments); };
      if (Q.get('gllog') === '1') {
        var log = G.__n64GLLog || function (s) { try { console.log(s); } catch (e) {} };
        Object.getOwnPropertyNames(P).forEach(function (n) {
          if (n === 'getError' || n === 'constructor') return;
          var d = Object.getOwnPropertyDescriptor(P, n);
          if (!d || typeof d.value !== 'function') return;
          var f = d.value, ge = P.getError;
          P[n] = function () {
            var r = f.apply(this, arguments);
            if (st.errs.length < 40) { var e = ge.call(this); if (e) { st.errs.push(n + ' -> 0x' + e.toString(16)); log('[gl1] ' + n + ' raised 0x' + e.toString(16)); } }
            return r;
          };
        });
      }
    };
    if (G.HTMLCanvasElement) wrapProto(G.HTMLCanvasElement.prototype);
    if (typeof G.OffscreenCanvas === 'function') wrapProto(G.OffscreenCanvas.prototype);
    return st;
  };
  // Every WebGL prototype that exists in this realm — for the hooks (fbasync, frame skip, rollback's
  // GL skip, present) that must see the core's calls whichever context class it got. WebGL2 and
  // WebGL1 are separate interfaces (neither inherits from the other), so wrapping both never wraps
  // one call twice.
  root.__n64GLProtos = function (G) {
    var out = [];
    if (G.WebGL2RenderingContext) out.push(G.WebGL2RenderingContext.prototype);
    if (G.WebGLRenderingContext) out.push(G.WebGLRenderingContext.prototype);
    return out;
  };
})(typeof window !== 'undefined' ? window : self);
