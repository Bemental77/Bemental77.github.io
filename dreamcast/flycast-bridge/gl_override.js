// dreamcast/flycast-bridge/gl_override.js — emcc --js-library override of
// emscripten's _glGetString (wired in by the `--js-library $BRIDGE/gl_override.js`
// line of flycast_worker_link.sh).
//
// Why this file exists at all: Flycast decides GLES-vs-desktop and the whole
// shader dialect from the GL_VERSION string
// (GLGraphicsContext::findGLVersion in core/wsi/gl_context.cpp does
// `_isGLES = !strncmp(version, "OpenGL ES", 9)`), and WebGL2's native
// "WebGL 2.0 (OpenGL ES 3.0 Chromium)" does not match. So GL_VERSION and
// GL_SHADING_LANGUAGE_VERSION are forced to GLES3-shaped strings here.
//
// (Line numbers are deliberately omitted for core/rend/gles/*.cpp below —
// that file is under active edit by another owner. Anchors are by symbol and
// by the literal code text, which survive.)
//
// ---------------------------------------------------------------------------
// GL_EXTENSIONS (0x1F03) — was returning the empty string on EVERY platform.
//
// The previous implementation fell through to `ctx.getParameter(0x1F03)`.
// 0x1F03 is NOT a valid WebGL getParameter pname (WebGL exposes extensions
// only via getSupportedExtensions()), so that call returned null and `|| ''`
// coerced it to the empty string. Consequence: inside
// core/rend/gles/gles.cpp :: findGLVersion(), every one of these probes was
// hard-wired false regardless of the device —
//   strstr(extensions, "GL_OES_packed_depth_stencil")       -> false
//   strstr(extensions, "GL_OES_depth24")                    -> false
//   strstr(extensions, "GL_EXT_texture_border_clamp")       -> false
//   strstr(extensions, "GL_EXT_texture_filter_anisotropic") -> false
//                            (so gl.max_anisotropy stayed pinned at 1.0)
// It was benign only because the `gl.gl_major >= 3` branches happen to win on
// desktop. It means the renderer's entire extension-capability model is blind,
// which is exactly the model that would let it adapt on a phone.
//
// Now built from ctx.getSupportedExtensions().
//
// FORMAT — verified against both the consumer and emscripten's own version:
//   * Space-separated single string, NUL-terminated. Consumers use
//     strstr(extensions, "GL_...").
//   * Emitted in BOTH bare and "GL_"-prefixed form. WebGL reports names
//     WITHOUT the GL_ prefix ("EXT_texture_filter_anisotropic"); the C probes
//     all search WITH it. This is exactly what emscripten itself does under
//     GL_EXTENSIONS_IN_PREFIXED_FORMAT — see $webglGetExtensions in
//     emsdk/upstream/emscripten/src/lib/libwebgl.js
//     (`exts.concat(exts.map((e) => "GL_" + e))`).
//   * MUST NOT be NULL. In findGLVersion()'s `if (gl.is_gles)` branch the very
//     first use is strstr(extensions, "GL_OES_packed_depth_stencil") with NO
//     null guard, and is_gles IS true in this build (gl_context.cpp matches the
//     "OpenGL ES 3.0 WebGL 2.0" we return above). Returning 0 here would be an
//     immediate null deref. The later desktop-GL block in the same function
//     *does* handle null by falling back to glGetStringi — that path is
//     unreachable for us, so it is not a safety net.
//
// POINTER LIFETIME — the reason for GL.stringCache:
//   The C side keeps `const char *extensions` and calls strstr on it; nothing
//   ever frees it. So each string is malloc'd exactly ONCE per pname, cached
//   in GL.stringCache, and intentionally never freed for the life of the
//   module. That is emscripten's own contract for this function — its comment
//   above glGetString in emsdk/upstream/emscripten/src/lib/libwebgl.js reads
//   "The allocated strings are cached and never freed" (+ glGetString__noleakcheck).
//   Getting this wrong in the other direction (allocating per call, or freeing)
//   turns a diagnostic gap into a use-after-free, so: allocate once, cache,
//   never free.
//
// BYTE LENGTH: the old code sized the buffer with `str.length + 1`, i.e. JS
//   UTF-16 code units, not UTF-8 bytes. That was survivable while every string
//   was short ASCII; the extension string is now long, and GL_VENDOR /
//   GL_RENDERER come straight from a device driver and are not guaranteed
//   ASCII. Use $stringToNewUTF8, which sizes with lengthBytesUTF8() and
//   mallocs to match (emsdk/upstream/emscripten/src/lib/libstrings.js).
//
// HAND-OFF / KNOWN BEHAVIOR DELTA (owner of core/rend/gles/ should confirm):
//   Making this string real flips exactly ONE capability probe on a typical
//   device. GL_EXT_texture_filter_anisotropic IS a WebGL2 extension name, so
//   findGLVersion()'s
//     `else if (strstr(extensions, "GL_EXT_texture_filter_anisotropic") != nullptr)`
//   now takes, and the following glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY)
//   makes gl.max_anisotropy >1 (commonly 16) instead of the 1.0 it has been
//   pinned at. That makes the `if (gl.max_anisotropy > 1.f)` block in
//   core/rend/gles/gldraw.cpp live for the first time.
//   config::AnisotropicFiltering is 0 in this build — the bridge answers
//   RETRO_ENVIRONMENT_GET_VARIABLE with a bare `return false`
//   (dreamcast/flycast-bridge/EmscriptenWorker.cpp, environment_cb), nothing in
//   shell/libretro/libretro.cpp assigns it, and Option<int>'s unspecified
//   default is T() — so the `config::AnisotropicFiltering > 1` test fails and
//   it takes the `else`: glTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAX_ANISOTROPY, 1.f).
//   That is semantically a no-op, but it IS one extra GL call per textured-poly
//   setup, and webgl2-compat.js's texParameterf guard puts a
//   getParameter(TEXTURE_BINDING_2D) in front of it. NOT MEASURED — this change
//   was made under a no-build/no-probe constraint, so treat the cost as unknown
//   rather than negligible.
//   GL_OES_packed_depth_stencil, GL_OES_depth24 and GL_EXT_texture_border_clamp
//   are NOT WebGL2 extension names, so those three probes stay false and
//   nothing there changes.
// ---------------------------------------------------------------------------

mergeInto(LibraryManager.library, {
  // Same contract as emscripten's own: strings are cached for the life of the
  // module and never freed.
  glGetString__noleakcheck: true,
  glGetString__deps: ['malloc', '$stringToNewUTF8'],
  glGetString: function(name) {
    if (typeof GL === 'undefined') GL = {};
    if (typeof GL.stringCache === 'undefined') GL.stringCache = {};
    if (typeof GL.stringCache[name] === 'number') return GL.stringCache[name];

    var ctx = (typeof GL.currentContext === 'object' && GL.currentContext) ? GL.currentContext.GLctx : null;
    var str = null;

    if (name === 0x1F02) {            // GL_VERSION
      str = 'OpenGL ES 3.0 WebGL 2.0';
    } else if (name === 0x8B8C) {     // GL_SHADING_LANGUAGE_VERSION
      str = 'OpenGL ES GLSL ES 3.00';
    } else if (name === 0x1F03) {     // GL_EXTENSIONS
      var exts = [];
      try { exts = (ctx && ctx.getSupportedExtensions()) || []; } catch (e) { exts = []; }
      // Bare + "GL_"-prefixed, space separated. See FORMAT above.
      str = exts.concat(exts.map(function (e) { return 'GL_' + e; })).join(' ');
      // One line, once — this is the capability inventory a device screenshot
      // needs, and it is what every strstr() probe in gles.cpp will actually
      // see. Routed through the postMessage path installed by webgl2-compat.js
      // (--pre-js, evaluated before any library function runs); a bare
      // console.log from the worker never reaches the page's #log.
      try {
        var log = (typeof globalThis !== 'undefined' && globalThis.__flycastBridgeLog);
        var msg = '[glext] GL_EXTENSIONS built from getSupportedExtensions(): ' +
                  exts.length + ' extensions, ' + str.length + ' chars' +
                  (exts.length === 0 ? '  *** EMPTY — no GL context, or the device reports none ***' : '') +
                  '  |  ' + exts.join(' ');
        if (typeof log === 'function') log(msg);
        else if (typeof console !== 'undefined' && console.log) console.log(msg);
      } catch (e) {}
    } else {
      // GL_VENDOR (0x1F00) / GL_RENDERER (0x1F01) are valid WebGL getParameter
      // pnames and are left exactly as they were — deliberately NOT swapped for
      // the WEBGL_debug_renderer_info unmasked strings. findGLVersion() derives
      // `gl.mali = !stricmp(vendor, "arm")` from GL_VENDOR, and
      // core/rend/gl4/gldraw.cpp switches the depth-stencil format on that flag
      // (`gl.mali ? GL_DEPTH24_STENCIL8 : GL_DEPTH32F_STENCIL8`), so unmasking
      // here would silently change rendering on real Mali hardware — a
      // behavior change smuggled in as a diagnostic. The unmasked GPU name is
      // reported as pure diagnostics instead, on the '[glinfo] gpu ...' line
      // emitted by webgl2-compat.js.
      str = ctx ? (ctx.getParameter(name) || '') : '';
    }

    // Never NULL: findGLVersion() strstr()s the result with no null guard.
    if (str === null || str === undefined) str = '';
    var buf = stringToNewUTF8(str);
    GL.stringCache[name] = buf;
    return buf;
  }
});
