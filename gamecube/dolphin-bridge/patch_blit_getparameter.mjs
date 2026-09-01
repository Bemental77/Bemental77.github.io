#!/usr/bin/env node
// patch_blit_getparameter.mjs — post-build patch for dolphin_worker_emcc.js.
//
// WHY: CPU profile (PROBE_CPU_PROFILE=1, 2026-06-17, HW/OGL build) showed the
// busy CPU/RENDER worker spending **24.4% in gl.getParameter**, 100% of it under
//   blitOffscreenFramebuffer <- _emscripten_webgl_do_commit_frame <- video_cb
//   <- GLContextLR::Swap() <- OGL::OGLGfx::PresentBackbuffer()
// Emscripten's OFFSCREEN_FRAMEBUFFER blit saves+restores ~11 pieces of GL state
// via gl.getParameter on EVERY present; under proxyContextToMainThread each
// getParameter is a SYNCHRONOUS cross-thread round-trip. Dolphin's OGL backend
// re-establishes its full pipeline state every frame, so the save/restore is
// pure waste for us.
//
// FIX: replace GL.blitOffscreenFramebuffer's body with a minimal blit that does
// NO getParameter (no save/restore) and leaves the offscreen FBO bound for
// Dolphin's next frame. Brace-matched replacement so it survives minification.
import fs from 'node:fs';

const path = process.argv[2];
if (!path) { console.error('usage: patch_blit_getparameter.mjs <emcc.js>'); process.exit(2); }
let src = fs.readFileSync(path, 'utf8');

const MARK = 'blitOffscreenFramebuffer:context=>{';
const start = src.indexOf(MARK);
if (start < 0) { console.log('[patch-blit] marker not found (already patched or emscripten changed) — no-op'); process.exit(0); }

// Brace-match from the opening { of the arrow body. The body contains no string
// or regex literals (pure GL calls + numeric args + a nested function draw(){}),
// so a plain depth counter is correct here.
const bodyOpen = start + MARK.length - 1; // index of '{'
let depth = 0, i = bodyOpen, end = -1;
for (; i < src.length; ++i) {
  const c = src[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { console.error('[patch-blit] FAILED to brace-match body'); process.exit(3); }

// Minimal, getParameter-free blit. Fast path uses gl.blitFramebuffer (WebGL2);
// fallback shader-blit sets state directly (no save) since Dolphin re-binds.
// READ_FRAMEBUFFER=36008 DRAW_FRAMEBUFFER=36009 FRAMEBUFFER=36160
// COLOR_BUFFER_BIT=16384 NEAREST=9728 ARRAY_BUFFER=34962 TEXTURE_2D=3553
// TEXTURE0=33984 BLEND=3042 CULL_FACE=2884 DEPTH_TEST=2929 STENCIL_TEST=2960
// SCISSOR_TEST=3089
const NEWBODY =
  '{var gl=context.GLctx;' +
  'if(gl.blitFramebuffer&&!context.defaultFboForbidBlitFramebuffer){' +
    // SCISSOR_TEST(3089) must be OFF for the present blit: Dolphin's OGL backend
    // leaves GL_SCISSOR_TEST enabled with a narrow per-draw sub-rect (OGLGfx.cpp:363,395),
    // which would CLIP blitFramebuffer to that rect and leave the rest of the 640x528
    // canvas un-written → the cycling-color column at the right edge. Stock emscripten
    // (library_webgl.js:970) and this patch's else-branch both disable it; the fast path
    // had omitted it. No restore needed — Dolphin re-enables scissor every frame.
    'gl.disable(3089);' +
    'gl.bindFramebuffer(36008,context.defaultFbo);gl.bindFramebuffer(36009,null);' +
    'gl.blitFramebuffer(0,0,gl.canvas.width,gl.canvas.height,0,0,gl.canvas.width,gl.canvas.height,16384,9728);' +
    'gl.bindFramebuffer(36160,context.defaultFbo);' +
  '}else{' +
    'gl.bindFramebuffer(36160,null);gl.disable(3089);gl.useProgram(context.blitProgram);' +
    'gl.bindBuffer(34962,context.blitVB);gl.activeTexture(33984);gl.bindTexture(3553,context.defaultColorTarget);' +
    'gl.disable(3042);gl.disable(2884);gl.disable(2929);gl.disable(2960);' +
    'if(context.defaultVao)gl.bindVertexArray(context.defaultVao);' +
    'gl.enableVertexAttribArray(context.blitPosLoc);gl.vertexAttribPointer(context.blitPosLoc,2,5126,false,0,0);' +
    'gl.drawArrays(5,0,4);' +
    'if(context.defaultVao)gl.bindVertexArray(null);' +
    'gl.bindFramebuffer(36160,context.defaultFbo);' +
  '}}';

const before = src.slice(0, bodyOpen);
const after = src.slice(end + 1);
fs.writeFileSync(path, before + NEWBODY + after);
console.log(`[patch-blit] replaced blitOffscreenFramebuffer body (${end - bodyOpen + 1} -> ${NEWBODY.length} bytes); removed all getParameter save/restore round-trips`);
