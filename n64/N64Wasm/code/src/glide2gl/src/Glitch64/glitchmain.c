/*
* Glide64 - Glide video plugin for Nintendo 64 emulators.
* Copyright (c) 2002  Dave2001
* Copyright (c) 2003-2009  Sergey 'Gonetz' Lipski
*
* This program is free software; you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation; either version 2 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program; if not, write to the Free Software
* Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
*/

#include <stdint.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include "glide.h"
#include "glitchmain.h"
#include "../Glide64/rdp.h"
#include "../../libretro/libretro_private.h"

#include <gfx/gl_capabilities.h>

extern retro_environment_t environ_cb;

int width, height;
int bgra8888_support;
static int npot_support;
// ZIGGY
static GLuint default_texture;
int glsl_support = 1;
//Gonetz

extern uint16_t *glide64_frameBuffer;
static uint8_t  *buf;

static int isExtensionSupported(const char *extension)
{
   const char *str = (const char*)glGetString(GL_EXTENSIONS);
   if (str && strstr(str, extension))
      return 1;
   return 0;
}

uint32_t grSstWinOpen(void)
{
   bool ret;
   struct retro_variable var = { "parallel-n64-screensize", 0 };

   if (glide64_frameBuffer)
      grSstWinClose(0);

   // ret = environ_cb(RETRO_ENVIRONMENT_GET_VARIABLE, &var);

   // if (ret && var.value)
   // {
   //    if (sscanf(var.value ? var.value : "640x480", "%dx%d", &width, &height) != 2)
   //    {
   //       width = 640;
   //       height = 480;
   //    }
   // }
   // else
   {
      width = 640;
      height =480;
   }

   // ZIGGY
   // allocate static texture names
   // the initial value should be big enough to support the maximal resolution
   glGenTextures(1, &default_texture);
   glide64_frameBuffer = (uint16_t*)malloc(width * height * sizeof(uint16_t));
   buf = (uint8_t*)malloc(width * height * 4 * sizeof(uint8_t));
   glViewport(0, 0, width, height);
   glide_viewport_note(0, 0, width, height);

   packed_pixels_support = 0;
   npot_support          = 0;
   bgra8888_support      = 0;

   // we can assume that non-GLES has GL_EXT_packed_pixels
   // support -it's included since OpenGL 1.2
   if (isExtensionSupported("GL_EXT_packed_pixels") != 0)
      packed_pixels_support = 1;

   if (gl_check_capability(GL_CAPS_FULL_NPOT_SUPPORT))
   {
      printf("GL_ARB_texture_non_power_of_two supported.\n");
      npot_support = 1;
   }

   if (gl_check_capability(GL_CAPS_BGRA8888))
   {
      printf("GL_EXT_texture_format_BGRA8888 supported.\n");
      bgra8888_support = 1;
   }

   init_geometry();
   init_combiner();
   init_textures();

   return 1;
}

int32_t grSstWinClose(uint32_t context)
{
   if (glide64_frameBuffer)
      free(glide64_frameBuffer);

   if (buf)
      free(buf);

   glDeleteTextures(1, &default_texture);

   glide64_frameBuffer = NULL;
   buf         = NULL;

   free_geometry();
   free_combiners();
   free_textures();

   return FXTRUE;
}

// frame buffer

int32_t grLfbLock( int32_t type, int32_t buffer, int32_t writeMode,
          int32_t origin, int32_t pixelPipeline,
          GrLfbInfo_t *info )
{
   info->origin        = origin;
   info->strideInBytes = width * ((writeMode == GR_LFBWRITEMODE_888) ? 4 : 2);
   info->lfbPtr        = glide64_frameBuffer;
   info->writeMode     = writeMode;

   if (writeMode == GR_LFBWRITEMODE_565)
   {
      signed i, j;

      glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, buf);
      for (j=0; j < height; j++)
      {
         for (i=0; i < width; i++)
         {
            glide64_frameBuffer[(height-j-1)*width+i] =
               ((buf[j*width*4+i*4+0] >> 3) << 11) |
               ((buf[j*width*4+i*4+1] >> 2) <<  5) |
               (buf[j*width*4+i*4+2] >> 3);
         }
      }
   }

   return FXTRUE;
}

/* NATIVE-RESOLUTION READBACK (neil). CopyFrameBuffer's scaled branch (read_always
 * titles: MK64, DK64, Banjo, ... rendering at 640x480 for a 320x240 N64 frame)
 * used to read the WHOLE window back (grLfbLock: 640x480 RGBA, then a CPU loop
 * converting all 307,200 pixels to 565) and then point-sample one window pixel
 * per N64 pixel. This does the point sampling ON THE GPU and reads back only
 * the sampled pixels: the caller computes, exactly as before, which window
 * pixel each N64 pixel takes ((int)(x*scale_x + offset_x), same C expression),
 * and the GPU copies exactly those texels (texelFetch: no filtering, no
 * arithmetic on the colour) into a native-size RGBA8 target. The 565 values
 * returned are therefore bit-identical to what the old path produced.
 *
 *   sx[0..nx), sy[0..ny): window pixel per N64 column / row, TOP-origin, as the
 *   old index math used them. Returns NULL (the caller falls back to the old
 *   path) if any sample lies outside the window, or GL refuses anything. */
static int nf_failed_get(void);
int neil_native_fbread = 1;
/* page control (A/B arm, and a kill switch): 1 = native readback, 0 = the old full-window path */
void neil_set_native_fbread(int on) { neil_native_fbread = on ? 1 : 0; }
int neil_native_fbread_failed(void) { return nf_failed_get(); }
static GLuint nf_prog, nf_vao, nf_fbo, nf_src, nf_dst, nf_xs, nf_ys;
static int nf_dst_w, nf_dst_h, nf_src_w, nf_src_h, nf_failed;
static int nf_failed_get(void) { return nf_failed; }
static uint8_t  *nf_rgba;
static uint16_t *nf_565;
static int32_t  *nf_tmp;
static int nf_cap;
/* The lookup rows as last uploaded (xs: nf_lx[0..nf_lnx), ys: nf_ly[0..nf_lny), GL rows). */
static int32_t  *nf_lx, *nf_ly;
static int nf_lnx = -1, nf_lny = -1, nf_lcap;
static int nf_unis;
/* glGetError is a SYNCHRONOUS round trip to the GPU process in WebGL (it waits
 * for everything queued so far): one after this pass's glReadPixels made the
 * core wait for the frame it had just drawn, every frame, which undid the
 * asynchronous hand-over (fbasync.js). The pass issues the identical commands
 * every frame, so it is verified on the first NF_VERIFY passes after anything
 * is (re)specified — a size or a lookup row — and trusted after that. */
#define NF_VERIFY 3
static int nf_verify = NF_VERIFY;

/* THE VIEWPORT, WITHOUT ASKING. glGetIntegerv(GL_VIEWPORT) is not answered from
 * WebGL's client-side state: it is a synchronous round trip to the GPU process,
 * behind everything queued so far (measured on this box: up to 7.6 ms, once per
 * readback). In this build exactly three places set the viewport — grSstWinOpen
 * above, glsm's state bind at the start of every retro_run (glsm.c), and this
 * pass, which puts back what it found — and the first two report it here. So
 * the value to restore is known. The verification passes still query it and
 * compare; a disagreement means something else moves the viewport, and the
 * pass then queries it on every pass for good (nf_vp_untrusted). */
static GLint nf_vp[4];
static int nf_vp_known, nf_vp_untrusted;
void glide_viewport_note(GLint x, GLint y, GLsizei w, GLsizei h)
{
   nf_vp[0] = x; nf_vp[1] = y; nf_vp[2] = w; nf_vp[3] = h;
   nf_vp_known = 1;
}

/* EARLY HAND-OVER of the asynchronous readback (n64/N64Wasm/dist/fbasync.js
 * st.prefetch): called at the start of every display list of a read_always
 * title, before it queues a draw. It reads the copy the next glReadPixels will
 * be handed — bytes fixed when that copy was taken, so neither what reaches
 * RDRAM nor where changes; only the wait moves to where the GPU has had the
 * guest's whole CPU time between the two lists. No-op when fbasync is off. */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
void grFbPrefetch(void)
{
   EM_ASM({
      var g = (typeof globalThis !== 'undefined') ? globalThis : self;
      var f = g.__fbAsync;
      if (f && f.prefetch) f.prefetch();
   });
}
/* fbasync.js hands a read the one-call-offset copy unless told to stand aside */
static void nf_bypass(int on)
{
   EM_ASM({
      var g = (typeof globalThis !== 'undefined') ? globalThis : self;
      var f = g.__fbAsync;
      if (f) f.bypass = !!$0;
   }, on);
}
#else
void grFbPrefetch(void) {}
static void nf_bypass(int on) { (void)on; }
#endif

static GLuint nf_shader(GLenum type, const char *src)
{
   GLint ok = 0;
   GLuint s = glCreateShader(type);
   glShaderSource(s, 1, &src, NULL);
   glCompileShader(s);
   glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
   return ok ? s : 0;
}

/* NF AHEAD (2026-10-03): this program used to be compiled, linked and asked about
 * (compile status, link status, uniform locations) at the first readback, in the middle
 * of a field — 6.5 ms at MK64's field 39 here, mostly waiting for the compile. Now
 * shader_prewarm (glitch64_combiner.c) starts it at boot with nothing asked
 * (nf_warm_start), neil_shader_warm_step asks once its link is complete (nf_warm_poll,
 * COMPLETION_STATUS_KHR), and nf_init only creates the objects. Same sources, same
 * program, same uniform values; a first readback before the answers are in asks then,
 * as before. */
static const char *nf_vs_text = "#version 300 es\n"
      "void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}\n";
static const char *nf_fs_text = "#version 300 es\n"
      "precision highp float; precision highp int; precision highp isampler2D; precision highp sampler2D;\n"
      "uniform sampler2D src; uniform isampler2D xs; uniform isampler2D ys; out vec4 o;\n"
      "void main(){ivec2 d=ivec2(gl_FragCoord.xy);"
      "o=texelFetch(src,ivec2(texelFetch(xs,ivec2(d.x,0),0).r,texelFetch(ys,ivec2(d.y,0),0).r),0);}\n";
static const char *nf_vs_src(void) { return nf_vs_text; }
static const char *nf_fs_src(void) { return nf_fs_text; }
static GLuint nf_pend, nf_pv, nf_pf;
static int nf_started, nf_asked;
static GLint nf_loc[3] = { -1, -1, -1 };
int neil_shader_warm_complete(GLuint prog);
void nf_warm_start(void)
{
   GLuint v, f;
   if (!neil_native_fbread || nf_prog || nf_started)
      return;
   v = glCreateShader(GL_VERTEX_SHADER);   { const char *t = nf_vs_src(); glShaderSource(v, 1, &t, NULL); } glCompileShader(v);
   f = glCreateShader(GL_FRAGMENT_SHADER); { const char *t = nf_fs_src(); glShaderSource(f, 1, &t, NULL); } glCompileShader(f);
   nf_pend = glCreateProgram();
   glAttachShader(nf_pend, v); glAttachShader(nf_pend, f);
   glLinkProgram(nf_pend);
   nf_pv = v; nf_pf = f; nf_started = 1; nf_asked = 0;
}
/* the questions nf_init asked: 1 = the program is usable (nf_prog set) */
static int nf_ask(void)
{
   GLint ok = 0;
   nf_asked = 1;
   glGetShaderiv(nf_pv, GL_COMPILE_STATUS, &ok); if (!ok) return 0;
   glGetShaderiv(nf_pf, GL_COMPILE_STATUS, &ok); if (!ok) return 0;
   glGetProgramiv(nf_pend, GL_LINK_STATUS, &ok); if (!ok) return 0;
   nf_loc[0] = glGetUniformLocation(nf_pend, "src");
   nf_loc[1] = glGetUniformLocation(nf_pend, "xs");
   nf_loc[2] = glGetUniformLocation(nf_pend, "ys");
   nf_prog = nf_pend;
   return 1;
}
int nf_warm_poll(void)
{
   if (!nf_started || nf_asked)
      return 1;
   if (!neil_shader_warm_complete(nf_pend))
      return 0;
   nf_ask();
   return 1;
}

static int nf_init(void)
{
   if (nf_started)
   {
      if (!nf_asked) nf_ask();
      if (!nf_prog) return 0;
      glGenVertexArrays(1, &nf_vao);
      glGenFramebuffers(1, &nf_fbo);
      glGenTextures(1, &nf_src); glGenTextures(1, &nf_dst); glGenTextures(1, &nf_xs); glGenTextures(1, &nf_ys);
      return 1;
   }
   {
   const char *vs = nf_vs_src(), *fs = nf_fs_src();
   GLint ok = 0;
   GLuint v = nf_shader(GL_VERTEX_SHADER, vs), f = nf_shader(GL_FRAGMENT_SHADER, fs);
   if (!v || !f) return 0;
   nf_prog = glCreateProgram();
   glAttachShader(nf_prog, v); glAttachShader(nf_prog, f);
   glLinkProgram(nf_prog);
   glGetProgramiv(nf_prog, GL_LINK_STATUS, &ok);
   if (!ok) return 0;
   glGenVertexArrays(1, &nf_vao);
   glGenFramebuffers(1, &nf_fbo);
   glGenTextures(1, &nf_src); glGenTextures(1, &nf_dst); glGenTextures(1, &nf_xs); glGenTextures(1, &nf_ys);
   return 1;
   }
}

static void nf_params(void)
{
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_BASE_LEVEL, 0);
   glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, 0);
}

/* The sampling pass, split so the lazy copy (Glide64/lazy_fb.c) can run its two
 * halves at different times: nf_ready() checks and sizes, nf_sample() runs the
 * texelFetch pass from ANY window-sized texture holding the frame and reads
 * the native-size result back. grLfbReadSampled (below) is the eager path:
 * window -> nf_src, then nf_sample(nf_src) — the same commands as before. */
static int nf_ready(const int32_t *sx, int nx, const int32_t *sy, int ny, int srcw, int srch)
{
   int i, n;
   if (!neil_native_fbread || nf_failed || nx <= 0 || ny <= 0)
      return 0;
   for (i = 0; i < nx; i++) if (sx[i] < 0 || sx[i] >= srcw) return 0;
   for (i = 0; i < ny; i++) if (sy[i] < 0 || sy[i] >= srch) return 0;
   if (!nf_vao && !nf_init()) { nf_failed = 1; return 0; }   /* NF AHEAD: nf_prog may be set before the objects are */

   n = nx > ny ? nx : ny;
   if (nf_cap < nx * ny || !nf_tmp)
   {
      free(nf_rgba); free(nf_565); free(nf_tmp);
      nf_cap  = nx * ny;
      nf_rgba = (uint8_t*)malloc((size_t)nf_cap * 4);
      nf_565  = (uint16_t*)malloc((size_t)nf_cap * 2);
      nf_tmp  = (int32_t*)malloc((size_t)(nf_cap > n ? nf_cap : n) * 4);
      if (!nf_rgba || !nf_565 || !nf_tmp) { nf_failed = 1; return 0; }
   }
   if (nf_lcap < n || !nf_lx || !nf_ly)
   {
      free(nf_lx); free(nf_ly);
      nf_lx = (int32_t*)malloc((size_t)n * 4);
      nf_ly = (int32_t*)malloc((size_t)n * 4);
      nf_lcap = n; nf_lnx = nf_lny = -1;
      if (!nf_lx || !nf_ly) { nf_failed = 1; return 0; }
   }
   return 1;
}

/* the sampling pass from `src` (srcw x srch, holding the window's pixels as
 * the bound read framebuffer had them) and the read-back; `copy` first copies
 * the window into src (the eager path). bypass: the read must reach GL as is
 * (fbasync.js would otherwise hand over its one-call-offset copy). */
static uint16_t *nf_sample(GLuint src, int srcw, int srch, int copy, int bypass,
      const int32_t *sx, int nx, const int32_t *sy, int ny)
{
   static const GLenum caps[] = { GL_BLEND, GL_DEPTH_TEST, GL_SCISSOR_TEST, GL_CULL_FACE, GL_STENCIL_TEST, GL_DITHER,
                                  GL_POLYGON_OFFSET_FILL, GL_SAMPLE_ALPHA_TO_COVERAGE, GL_SAMPLE_COVERAGE, GL_RASTERIZER_DISCARD };
   GLboolean was[10], mask[4];
   GLint prog, active, tex[4], smp[4], dfb, rfb, vao, vp[4], pack, packAlign;
   int i;

   /* ---- will this pass (re)specify anything? (each sets nf_verify below) ---- */
   /* THE CHECK IS ABOUT THIS PASS ONLY — DECIDED BEFORE IT, NOT HALFWAY THROUGH. Errors raised
    * before the pass are drained first; but that drain looked at nf_verify on entry, and a pass
    * that re-specifies (a size, a lookup row) raises nf_verify only in the middle, so it then
    * verified without having drained — and glide's own GL calls leave errors lying around all the
    * time (glTexParameteri with no texture bound: INVALID_OPERATION, several per field in DK64). The
    * pass was declared failed (nf_failed, for good), the lazy copy turned eager, and the bytes the
    * guest reads back changed hands (lazy_fb.c lfb_to_eager). Whether a pass re-specifies depends
    * on the rows the LAST pass uploaded — host state a rollback does not put back — so a room that
    * rolled back re-uploaded where a straight run did not: MEASURED (n64_state_exact_probe, DK64, a
    * one-frame mispredicted rollback at frames 938-941): the room's materialisations failed at frame
    * 1077 (the straight run's succeeded), lazy copying stopped, and the full state left the straight
    * run's at 1173 — the DK64 rollback-room desync at 1180-1250. Now the re-specification is known
    * before the first command and the drain covers it. */
   for (i = 0; i < ny; i++) nf_tmp[i] = srch - 1 - sy[i];
   {
      int respec = (copy && (nf_src_w != width || nf_src_h != height))
         || nf_lnx != nx || memcmp(nf_lx, sx, (size_t)nx * 4)
         || nf_lny != ny || memcmp(nf_ly, nf_tmp, (size_t)ny * 4)
         || nf_dst_w != nx || nf_dst_h != ny;
      if (nf_verify > 0 || respec)
         while (glGetError() != GL_NO_ERROR) {}   /* not ours: the check below is about THIS pass only */
   }

   /* ---- save ---- */
   glGetIntegerv(GL_CURRENT_PROGRAM, &prog);
   glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
   for (i = 0; i < 4; i++)
   {
      glActiveTexture(GL_TEXTURE0 + i);
      glGetIntegerv(GL_TEXTURE_BINDING_2D, &tex[i]);
      glGetIntegerv(GL_SAMPLER_BINDING, &smp[i]);
   }
   glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &dfb);
   glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &rfb);
   glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
   if (nf_verify > 0 || !nf_vp_known || nf_vp_untrusted)
   {
      glGetIntegerv(GL_VIEWPORT, vp);
      if (nf_vp_known && memcmp(vp, nf_vp, sizeof(vp)))
         nf_vp_untrusted = 1;
      memcpy(nf_vp, vp, sizeof(vp));
      nf_vp_known = 1;
   }
   else
      memcpy(vp, nf_vp, sizeof(vp));
   glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &pack);
   glGetIntegerv(GL_PACK_ALIGNMENT, &packAlign);
   glGetBooleanv(GL_COLOR_WRITEMASK, mask);
   for (i = 0; i < 10; i++) was[i] = glIsEnabled(caps[i]);

   /* ---- the window, as a texture: the SAME pixels grLfbLock's glReadPixels
    * reads (the bound read framebuffer, origin 0,0, width x height) ---- */
   glActiveTexture(GL_TEXTURE0);
   glBindSampler(0, 0);
   glBindTexture(GL_TEXTURE_2D, src);
   if (copy)
   {
      if (nf_src_w != width || nf_src_h != height)
      {
         nf_params();
         /* RGB8: the window has no alpha (alpha:false), and a copy may not add one */
         glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB8, width, height, 0, GL_RGB, GL_UNSIGNED_BYTE, NULL);
         nf_src_w = width; nf_src_h = height;
         nf_verify = NF_VERIFY;
      }
      glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
   }

   /* ---- the sample positions: window column per N64 column, and GL row
    * (bottom-origin) per N64 row (top-origin), as R32I lookup rows ---- */
   /* Uploaded only when they differ from what the textures already hold (they
    * are the same every frame unless the VI/window geometry changes): a
    * texture re-specified while the previous frame's pass may still read it
    * costs a copy or a stall on a tile-based GPU. */
   glActiveTexture(GL_TEXTURE1);
   glBindSampler(1, 0);
   glBindTexture(GL_TEXTURE_2D, nf_xs);
   if (nf_lnx != nx || memcmp(nf_lx, sx, (size_t)nx * 4))
   {
      glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      if (nf_lnx < 0) nf_params();
      glTexImage2D(GL_TEXTURE_2D, 0, GL_R32I, nx, 1, 0, GL_RED_INTEGER, GL_INT, sx);
      memcpy(nf_lx, sx, (size_t)nx * 4); nf_lnx = nx;
      nf_verify = NF_VERIFY;
   }
   glActiveTexture(GL_TEXTURE2);
   glBindSampler(2, 0);
   glBindTexture(GL_TEXTURE_2D, nf_ys);
   if (nf_lny != ny || memcmp(nf_ly, nf_tmp, (size_t)ny * 4))
   {
      glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
      if (nf_lny < 0) nf_params();
      glTexImage2D(GL_TEXTURE_2D, 0, GL_R32I, ny, 1, 0, GL_RED_INTEGER, GL_INT, nf_tmp);
      memcpy(nf_ly, nf_tmp, (size_t)ny * 4); nf_lny = ny;
      nf_verify = NF_VERIFY;
   }

   /* ---- the native-size target ---- */
   glActiveTexture(GL_TEXTURE3);
   glBindTexture(GL_TEXTURE_2D, nf_dst);
   if (nf_dst_w != nx || nf_dst_h != ny)
   {
      nf_params();
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, nx, ny, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
      nf_dst_w = nx; nf_dst_h = ny;
      glBindTexture(GL_TEXTURE_2D, 0);
      glBindFramebuffer(GL_FRAMEBUFFER, nf_fbo);
      glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, nf_dst, 0);
      nf_verify = NF_VERIFY;
   }
   glBindTexture(GL_TEXTURE_2D, 0);
   glBindFramebuffer(GL_FRAMEBUFFER, nf_fbo);

   for (i = 0; i < 10; i++) glDisable(caps[i]);
   glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
   glViewport(0, 0, nx, ny);
   glUseProgram(nf_prog);
   if (!nf_unis)
   {  /* sampler units: program state, set once */
      if (nf_asked)
      {  /* NF AHEAD: the locations were asked for with the program */
         glUniform1i(nf_loc[0], 0);
         glUniform1i(nf_loc[1], 1);
         glUniform1i(nf_loc[2], 2);
      }
      else
      {
      glUniform1i(glGetUniformLocation(nf_prog, "src"), 0);
      glUniform1i(glGetUniformLocation(nf_prog, "xs"), 1);
      glUniform1i(glGetUniformLocation(nf_prog, "ys"), 2);
      }
      nf_unis = 1;
   }
   glBindVertexArray(nf_vao);
   glDrawArrays(GL_TRIANGLES, 0, 3);

   glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
   glPixelStorei(GL_PACK_ALIGNMENT, 4);
   if (bypass) nf_bypass(1);
   glReadPixels(0, 0, nx, ny, GL_RGBA, GL_UNSIGNED_BYTE, nf_rgba);
   if (bypass) nf_bypass(0);

   /* ---- restore ---- */
   glBindVertexArray(vao);
   glUseProgram(prog);
   glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dfb);
   glBindFramebuffer(GL_READ_FRAMEBUFFER, rfb);
   glViewport(vp[0], vp[1], vp[2], vp[3]);
   glColorMask(mask[0], mask[1], mask[2], mask[3]);
   for (i = 0; i < 10; i++) { if (was[i]) glEnable(caps[i]); else glDisable(caps[i]); }
   glBindBuffer(GL_PIXEL_PACK_BUFFER, pack);
   glPixelStorei(GL_PACK_ALIGNMENT, packAlign);
   for (i = 3; i >= 0; i--)
   {
      glActiveTexture(GL_TEXTURE0 + i);
      glBindTexture(GL_TEXTURE_2D, tex[i]);
      glBindSampler(i, smp[i]);
   }
   glActiveTexture(active);

   if (nf_verify > 0)
   {
      if (glGetError() != GL_NO_ERROR) { nf_failed = 1; return NULL; }
      nf_verify--;
   }

   /* the same 565 packing grLfbLock applies (bytes R,G,B of RGBA8) */
   for (i = 0; i < nx * ny; i++)
      nf_565[i] = ((nf_rgba[i*4+0] >> 3) << 11) | ((nf_rgba[i*4+1] >> 2) << 5) | (nf_rgba[i*4+2] >> 3);
   return nf_565;
}

uint16_t *grLfbReadSampled(const int32_t *sx, int nx, const int32_t *sy, int ny)
{
   if (!nf_ready(sx, nx, sy, ny, width, height))
      return NULL;
   return nf_sample(nf_src, width, height, 1, 0, sx, nx, sy, ny);
}

/* ---- the lazy copy's two halves (Glide64/lazy_fb.c) ---- */

/* the samples are usable for a window of this size, and the pass exists */
int grLfbSampleable(const int32_t *sx, int nx, const int32_t *sy, int ny)
{
   return nf_ready(sx, nx, sy, ny, width, height);
}

/* Copy the window (the bound read framebuffer, origin 0,0, width x height —
 * the pixels grLfbReadSampled copies) into `tex`, (re)sizing it to the window.
 * GPU-side only: nothing is read back. *w/*h: the size it now holds. */
int grLfbCaptureWindow(GLuint *tex, int *w, int *h)
{
   GLint active, bound;
   if (!*tex)
   {
      glGenTextures(1, tex);
      if (!*tex) return 0;
      *w = *h = 0;
   }
   glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
   glActiveTexture(GL_TEXTURE0);
   glGetIntegerv(GL_TEXTURE_BINDING_2D, &bound);
   glBindTexture(GL_TEXTURE_2D, *tex);
   if (*w != width || *h != height)
   {
      nf_params();
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB8, width, height, 0, GL_RGB, GL_UNSIGNED_BYTE, NULL);
      *w = width; *h = height;
   }
   glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
   glBindTexture(GL_TEXTURE_2D, bound);
   glActiveTexture(active);
   return 1;
}

/* The deferred half: the sampling pass from a captured window and the read
 * back, exactly as grLfbReadSampled would have run it on that frame. */
uint16_t *grLfbSampleFrom(GLuint tex, int w, int h, const int32_t *sx, int nx, const int32_t *sy, int ny)
{
   if (!nf_ready(sx, nx, sy, ny, w, h))
      return NULL;
   return nf_sample(tex, w, h, 0, 1, sx, nx, sy, ny);
}

void grLfbDeleteCapture(GLuint tex)
{
   if (tex) glDeleteTextures(1, &tex);
}

int32_t grLfbReadRegion( int32_t src_buffer,
      uint32_t src_x, uint32_t src_y,
      uint32_t src_width, uint32_t src_height,
      uint32_t dst_stride, void *dst_data )
{
   unsigned int i,j;

   glReadPixels(src_x, height-src_y-src_height, src_width, src_height, GL_RGBA, GL_UNSIGNED_BYTE, buf);

   for (j=0; j<src_height; j++)
   {
      for (i=0; i<src_width; i++)
      {
         glide64_frameBuffer[j*(dst_stride/2)+i] =
            ((buf[(src_height-j-1)*src_width*4+i*4+0] >> 3) << 11) |
            ((buf[(src_height-j-1)*src_width*4+i*4+1] >> 2) <<  5) |
            (buf[(src_height-j-1)*src_width*4+i*4+2] >> 3);
      }
   }

   return FXTRUE;
}

int32_t
grLfbWriteRegion( int32_t dst_buffer,
      uint32_t dst_x, uint32_t dst_y,
      uint32_t src_format,
      uint32_t src_width, uint32_t src_height,
      int32_t pixelPipeline,
      int32_t src_stride, void *src_data )
{
   unsigned int i,j;
   uint16_t *frameBuffer = (uint16_t*)src_data;

   if(dst_buffer == GR_BUFFER_AUXBUFFER)
   {
      for (j=0; j<src_height; j++)
         for (i=0; i<src_width; i++)
            buf[j*src_width + i] = (uint8_t)
               ((frameBuffer[(src_height-j-1)*(src_stride/2)+i]/(65536.0f*(2.0f/zscale)))+1-zscale/2.0f)
            ;

      glEnable(GL_DEPTH_TEST);
      glDepthFunc(GL_ALWAYS);

      //glDrawBuffer(GL_BACK);
      glClear( GL_DEPTH_BUFFER_BIT );
      glDepthMask(1);
      //glDrawPixels(src_width, src_height, GL_DEPTH_COMPONENT, GL_FLOAT, buf);
   }
   else
   {
      int invert;
      int textureSizes_location;
      static float data[16];
      const unsigned int half_stride = src_stride / 2;

      glActiveTexture(GL_TEXTURE0);

      /* src_format is GR_LFBWRITEMODE_555 */
      for (j=0; j<src_height; j++)
      {
         for (i=0; i<src_width; i++)
         {
            const unsigned int col = frameBuffer[j*half_stride+i];
            buf[j*src_width*4+i*4+0]=((col>>10)&0x1F)<<3;
            buf[j*src_width*4+i*4+1]=((col>>5)&0x1F)<<3;
            buf[j*src_width*4+i*4+2]=((col>>0)&0x1F)<<3;
            buf[j*src_width*4+i*4+3]=0xFF;
         }
      }

      glBindTexture(GL_TEXTURE_2D, default_texture);
      glTexSubImage2D(GL_TEXTURE_2D, 0, 4, src_width, src_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, buf);

      set_copy_shader();

      glDisable(GL_DEPTH_TEST);
      glDisable(GL_BLEND);
      invert = 1;

      data[ 0] = (float)((int)dst_x);                             /* X 0 */
      data[ 1] = (float)(invert*-((int)dst_y));                   /* Y 0 */
      data[ 2] = 0.0f;                                            /* U 0 */
      data[ 3] = 0.0f;                                            /* V 0 */
      data[ 4] = (float)((int)dst_x);                             /* X 1 */
      data[ 5] = (float)(invert*-((int)dst_y + (int)src_height)); /* Y 1 */
      data[ 6] = 0.0f;                                            /* U 1 */
      data[ 7] = (float)src_height;                               /* V 1 */
      data[ 8] = (float)((int)dst_x + (int)src_width);
      data[ 9] = (float)(invert*-((int)dst_y + (int)src_height));
      data[10] = (float)src_width;
      data[11] = (float)src_height;
      data[12] = (float)((int)dst_x);
      data[13] = (float)(invert*-((int)dst_y));
      data[14] = 0.0f;
      data[15] = 0.0f;

      glDisableVertexAttribArray(COLOUR_ATTR);
      glDisableVertexAttribArray(TEXCOORD_1_ATTR);
      glDisableVertexAttribArray(FOG_ATTR);

      glVertexAttribPointer(POSITION_ATTR,2,GL_FLOAT,false,4 * sizeof(float), &data[0]); //Position
      glVertexAttribPointer(TEXCOORD_0_ATTR,2,GL_FLOAT,false,4 * sizeof(float), &data[2]); //Tex

      glEnableVertexAttribArray(COLOUR_ATTR);
      glEnableVertexAttribArray(TEXCOORD_1_ATTR);
      glEnableVertexAttribArray(FOG_ATTR);

      textureSizes_location = glGetUniformLocation(program_object_default,"textureSizes");
      glUniform4f(textureSizes_location,1,1,1,1);

      glDrawArrays(GL_TRIANGLE_STRIP,0,4);

      compile_shader();

      glEnable(GL_DEPTH_TEST);
      glEnable(GL_BLEND);
   }

   return FXTRUE;
}

void grBufferSwap(uint32_t swap_interval)
{
   bool swapmode = settings.swapmode_retro && BUFFERSWAP;
   if (!swapmode)
      retro_return(true);
}

void grClipWindow(uint32_t minx, uint32_t miny, uint32_t maxx, uint32_t maxy)
{
   glScissor(minx, height - maxy, maxx - minx, maxy - miny);
   glEnable(GL_SCISSOR_TEST);
}

void grBufferClear(uint32_t color, uint32_t alpha, uint32_t depth)
{
   glClearColor(((color >> 24) & 0xFF) / 255.0f,
         ((color >> 16) & 0xFF) / 255.0f,
         (color         & 0xFF) / 255.0f,
         alpha / 255.0f);
   glClearDepth(depth / 65535.0f);
   glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

void grColorMask(bool rgb, bool a)
{
   glColorMask(rgb, rgb, rgb, a);
}
