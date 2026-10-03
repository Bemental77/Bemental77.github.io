/* lazy_fb.c — THE FRAMEBUFFER COPY OF A read_always TITLE, MADE WHEN SEEN.
 *
 * WHY. Glide copies every frame of a read_always title (Mario Kart 64, Pokémon
 * Snap, Donkey Kong 64, Castlevania) from the GPU into RDRAM at the end of its
 * display list (CopyFrameBuffer, glide64_rdp.c), because the game MAY read it.
 * That read-back is a GPU->CPU round trip every frame: on this box (SwiftShader)
 * the core spent 60% of an MK64 race frame waiting in it, and taking it out
 * cut the frame from 25-26 to 18-19 ms at 4x CPU throttle. MK64 reads its
 * framebuffers only for the Luigi Raceway / Wario Stadium screens
 * (render_courses.c copy_framebuffer, and once at the start of a multiplayer
 * race, race_logic.c func_802A7940/func_802A7728) — so almost every copy was
 * written into RDRAM and never looked at.
 *
 * WHAT. At the end of the display list the frame is CAPTURED on the GPU (one
 * glCopyTexSubImage2D of the window into a texture: nothing is read back) and
 * the copy is QUEUED: the RDRAM range it covers, the parameters of the write
 * loop, the capture it reads. Nothing is written. The copy is MATERIALISED —
 * the sampling pass run on its capture, read back, packed and written by the
 * very loop CopyFrameBuffer runs — the moment anything can observe those bytes:
 *   - the guest CPU loads or stores into them (the 64 KB pages a queued copy
 *     covers get handlers that call lfb_touch: m64p_memory.c; the JIT's native
 *     memory ops take their slow arm there, since they compare the table entry);
 *   - an SP, PI, SI or AI DMA, or an audio list DMA, covers them (LFB_TOUCH:
 *     rsp_core.c, pi_controller.c, si_controller.c, ai_controller.c, alist.c);
 *   - glide itself loads a texture or TLUT from them (glide64_gDP.c,
 *     glide64_rdp.c), or writes or reads the colour image through one of its
 *     rarer paths (which materialise everything first);
 *   - a savestate is written to a file, or the console is reset (everything).
 * A copy that a later copy overwrites completely before anything looked is
 * dropped — the eager copy's bytes would have been overwritten unread too.
 *
 * EXACTNESS. Every byte the guest (or any device) can observe is the byte the
 * eager copy put there: the capture holds the very pixels the eager pass would
 * have sampled (the window, at the same point of the command stream), the
 * sampling pass and the write loop are the same code with the same inputs, and
 * the write happens before the first observation. The one-call offset of the
 * asynchronous readback (n64/N64Wasm/dist/fbasync.js: the copy written at the
 * end of display list N is the frame of list N-1, when one exists) is kept
 * here, in the same cases, so the RDRAM bytes are those the shipped core wrote.
 * What differs is only RDRAM that nothing has observed yet. Rollback: a raw
 * savestate holds RDRAM as it is (unobserved copies not written); fbasync.js
 * st.snapshot/restore/release (called by room_core.js on every snapshot) carry
 * the queue and the previous capture with it (neil_lfb_snapshot/_restore/
 * _release), so a re-simulation starts from exactly the same machine.
 *
 * WHEN IT APPLIES. A read_always title with the asynchronous readback on (the
 * default; fbasync.js decides it), the native-resolution readback in use, and
 * no frame-buffer emulation (glide's smart_read / fb_get_info titles — Banjo,
 * Ridge Racer — keep the eager copy: their other frame-buffer paths read and
 * write RDRAM in many more places). ?fblazy=0 is the A/B arm and kill switch.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "Gfx_1.3.h"
#include "../../../Graphics/image_convert.h"
#include "../Glitch64/glide.h"
#include "rdp.h"
#include "lazy_fb.h"
#include "../../../mupen64plus-core/src/main/lfb_hook.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#define LFB_RDRAM   0x800000u
#define LFB_MAXREG  16

typedef struct
{
   GLuint   tex;
   int      w, h;             /* the window size it holds */
   int      nx, ny;           /* the samples it was taken for */
   int32_t *sx, *sy;
   int      cap_xy;           /* allocated length of sx / sy */
   int      refs;
} lfb_cap_t;

typedef struct
{
   uint32_t lo, hi;           /* RDRAM byte range the write loop can touch */
   uint32_t addr;             /* colour image address */
   int      width;            /* colour image width (the loop's stride) */
   int      x0, y0, x1, y1;   /* x_start, y_start, x_end, y_end */
   int      bpp32, read_alpha;
   int      cap;
} lfb_reg_t;

typedef struct
{
   int       used;
   int       prev;
   int       n;
   lfb_reg_t r[LFB_MAXREG];
} lfb_snap_t;

int      lfb_active;
uint32_t lfb_lo, lfb_hi;

static lfb_cap_t  *caps;
static int         ncaps;
static lfb_reg_t   regs[LFB_MAXREG];
static int         nregs;
static int         prev_cap = -1;
static lfb_snap_t *snaps;
static int         nsnaps;
static int         lfb_busy;   /* materialising: its own GL and RDRAM work must not recurse */

/* counters (neil_lfb_stats) */
static uint32_t st_queued, st_materialised, st_superseded, st_dropped, st_failed, st_eager;

/* ---- captures -------------------------------------------------------------- */

static int cap_new(void)
{
   int i;
   for (i = 0; i < ncaps; i++)
      if (caps[i].refs == 0) { caps[i].refs = 1; return i; }
   {
      lfb_cap_t *n = (lfb_cap_t*)realloc(caps, sizeof(*caps) * (ncaps + 4));
      if (!n) return -1;
      caps = n;
      memset(caps + ncaps, 0, sizeof(*caps) * 4);
      ncaps += 4;
   }
   caps[i].refs = 1;
   return i;
}

static void cap_ref(int c)   { if (c >= 0) caps[c].refs++; }
static void cap_unref(int c)
{
   if (c < 0 || caps[c].refs <= 0) return;
   if (--caps[c].refs == 0)
   {
      /* keep a few textures for reuse; a long rollback window can pin many */
      int i, idle = 0;
      for (i = 0; i < ncaps; i++) if (caps[i].refs == 0 && caps[i].tex) idle++;
      if (idle > 6) { grLfbDeleteCapture(caps[c].tex); caps[c].tex = 0; caps[c].w = caps[c].h = 0; }
   }
}

/* ---- the queue ------------------------------------------------------------- */

static void bounds_update(void)
{
   int i;
   lfb_active = nregs > 0;
   lfb_lo = 0xFFFFFFFFu; lfb_hi = 0;
   for (i = 0; i < nregs; i++)
   {
      if (regs[i].lo < lfb_lo) lfb_lo = regs[i].lo;
      if (regs[i].hi > lfb_hi) lfb_hi = regs[i].hi;
   }
   if (!nregs) lfb_lo = lfb_hi = 0;
}

static void pages(const lfb_reg_t *r, int delta)
{
   unsigned p;
   for (p = r->lo >> 16; p <= ((r->hi - 1) >> 16) && p < 128; p++)
      lfb_page_ref(p, delta);
}

/* remove queue entry i (its capture reference is the caller's to handle) */
static void reg_remove(int i)
{
   lfb_reg_t r = regs[i];
   memmove(&regs[i], &regs[i + 1], sizeof(regs[0]) * (nregs - i - 1));
   nregs--;
   pages(&r, -1);
   bounds_update();
}

static void reg_write(const lfb_reg_t *r, const uint16_t *samp)
{
   int x, y;
   const int stride = r->x1;            /* NF_SRC(x, y) = samp[x + y * x_end] */
   if (!r->bpp32)
   {
      uint16_t *ptr_dst = (uint16_t*)(gfx_info.RDRAM + r->addr);
      for (y = r->y0; y < r->y1; y++)
         for (x = r->x0; x < r->x1; x++)
         {
            uint16_t c = samp[x + y * stride];
            c = (c&0xFFC0) | ((c&0x001F) << 1) | 1;
            if (r->read_alpha && c == 1)
               c = 0;
            ptr_dst[(x + y * r->width)^1] = c;
         }
   }
   else
   {
      uint32_t *ptr_dst = (uint32_t*)(gfx_info.RDRAM + r->addr);
      for (y = r->y0; y < r->y1; y++)
         for (x = r->x0; x < r->x1; x++)
         {
            uint16_t c = samp[x + y * stride];
            c = (c&0xFFC0) | ((c&0x001F) << 1) | 1;
            if (r->read_alpha && c == 1)
               c = 0;
            ptr_dst[x + y * r->width] = RGBA16toRGBA32(c);
         }
   }
}

/* write queue entry i into RDRAM and retire it */
static void materialise(int i)
{
   lfb_reg_t r = regs[i];
   lfb_cap_t *c = &caps[r.cap];
   const uint16_t *samp;
   reg_remove(i);
   lfb_busy++;
   samp = grLfbSampleFrom(c->tex, c->w, c->h, c->sx, c->nx, c->sy, c->ny);
   if (samp) { reg_write(&r, samp); st_materialised++; }
   else st_failed++;                     /* GL refused the pass: those bytes stay as they were */
   lfb_busy--;
   cap_unref(r.cap);
}

void lfb_touch(uint32_t off, uint32_t len)
{
   int i;
   uint32_t end = off + len;
   if (lfb_busy) return;
   for (i = 0; i < nregs; )
   {
      if (regs[i].lo < end && off < regs[i].hi) { materialise(i); i = 0; continue; }
      i++;
   }
}

void lfb_materialize_all(void)
{
   if (lfb_busy) return;
   while (nregs > 0)
      materialise(0);
}

static void prev_drop(void)
{
   cap_unref(prev_cap);
   prev_cap = -1;
}

void lfb_drop_all(void)
{
   while (nregs > 0)
   {
      int c = regs[nregs - 1].cap;
      reg_remove(nregs - 1);
      cap_unref(c);
      st_dropped++;
   }
   prev_drop();
}

/* Leaving the lazy path for an eager copy. Everything queued is written first.
 * And fbasync.js's own pending copy is from before the lazy stretch (the lazy
 * copies never went through it), so it is dropped: the eager read then hands
 * over the frame it reads now — what it does on its first call — instead of
 * a frame many lists old. */
static void lfb_to_eager(void)
{
   int was = prev_cap >= 0 || nregs > 0;
   lfb_materialize_all();
   prev_drop();
#ifdef __EMSCRIPTEN__
   if (was)
      EM_ASM({
         var g = (typeof globalThis !== 'undefined') ? globalThis : self;
         var f = g.__fbAsync;
         if (f && f.invalidate) f.invalidate('lazy copy -> eager');
      });
#else
   (void)was;
#endif
}

/* ---- is the lazy copy in use for this title, now? ---------------------------- */

static int lfb_wanted(void)
{
   int on = 0;
#ifdef __EMSCRIPTEN__
   on = EM_ASM_INT({
      var g = (typeof globalThis !== 'undefined') ? globalThis : self;
      var f = g.__fbAsync;
      return (f && f.on && f.lazy !== false) ? 1 : 0;
   });
#endif
   return on && neil_native_fbread && !fb_emulation_enabled && !(settings.frame_buffer & fb_get_info);
}

/* Queue the copy CopyFrameBuffer's scaled branch is about to make (returns 1),
 * or return 0 and leave it to the eager path. sx/sy: the window pixel of every
 * N64 column / row, as computed there. */
int lfb_queue(const int32_t *sx, int nx, const int32_t *sy, int ny,
      uint32_t addr, int width, int x0, int y0, int bpp32, int read_alpha)
{
   lfb_reg_t r;
   int cur, src, i;
   uint32_t first, last, bpp;

   if (!lfb_wanted() || nx <= 0 || ny <= 0 || x0 < 0 || y0 < 0 || x0 >= nx || y0 >= ny || width <= 0)
      goto eager;
   if (!grLfbSampleable(sx, nx, sy, ny))
      goto eager;

   bpp   = bpp32 ? 4u : 2u;
   first = (uint32_t)(y0 * width + x0);
   last  = (uint32_t)((ny - 1) * width + (nx - 1));
   /* a 16-bit pixel x lands at (x ^ 1): the pair it belongs to bounds it exactly
    * (an over-wide range would make neighbouring framebuffers overlap) */
   r.lo  = addr + (bpp32 ? 4u * first : 2u * (first & ~1u));
   r.hi  = addr + (bpp32 ? 4u * (last + 1) : 2u * ((last | 1u) + 1));
   if (addr >= LFB_RDRAM || r.hi > LFB_RDRAM || r.lo >= r.hi)
      goto eager;

   cur = cap_new();
   if (cur < 0)
      goto eager;
   if (!grLfbCaptureWindow(&caps[cur].tex, &caps[cur].w, &caps[cur].h))
   {
      caps[cur].refs = 0;
      goto eager;
   }
   if (caps[cur].cap_xy < (nx > ny ? nx : ny))
   {
      int n = nx > ny ? nx : ny;
      int32_t *a = (int32_t*)realloc(caps[cur].sx, sizeof(int32_t) * n);
      int32_t *b = a ? (int32_t*)realloc(caps[cur].sy, sizeof(int32_t) * n) : NULL;
      if (a) caps[cur].sx = a;
      if (b) caps[cur].sy = b;
      if (!a || !b) { caps[cur].refs = 0; goto eager; }
      caps[cur].cap_xy = n;
   }
   memcpy(caps[cur].sx, sx, sizeof(int32_t) * nx);
   memcpy(caps[cur].sy, sy, sizeof(int32_t) * ny);
   caps[cur].nx = nx; caps[cur].ny = ny;

   /* fbasync's one-call offset: the copy handed to THIS list is the previous
    * list's, when there is one taken for the same rectangle */
   if (prev_cap >= 0 && (caps[prev_cap].nx != nx || caps[prev_cap].ny != ny))
      prev_drop();
   src = prev_cap >= 0 ? prev_cap : cur;

   r.addr = addr; r.width = width;
   r.x0 = x0; r.y0 = y0; r.x1 = nx; r.y1 = ny;
   r.bpp32 = bpp32 ? 1 : 0; r.read_alpha = read_alpha ? 1 : 0;
   r.cap = src;

   /* what is already queued over these bytes */
   for (i = 0; i < nregs; )
   {
      lfb_reg_t *o = &regs[i];
      if (!(o->lo < r.hi && r.lo < o->hi)) { i++; continue; }
      if (o->addr == r.addr && o->width == r.width && o->x0 == r.x0 && o->y0 == r.y0
            && o->x1 == r.x1 && o->y1 == r.y1 && o->bpp32 == r.bpp32)
      {
         /* every byte it would write, this one writes again before anyone looked */
         int c = o->cap;
         reg_remove(i);
         cap_unref(c);
         st_superseded++;
         continue;
      }
      materialise(i);                    /* a partial overlap: its bytes first, as before */
      i = 0;
   }
   if (nregs >= LFB_MAXREG)
      materialise(0);

   cap_ref(src);
   regs[nregs++] = r;
   pages(&r, +1);
   bounds_update();
   st_queued++;

   if (prev_cap >= 0) cap_unref(prev_cap);   /* the queue holds it now if it needs it */
   prev_cap = cur;                           /* cur's own reference */
   return 1;

eager:
   /* the eager path from here: RDRAM must hold what the eager core held */
   lfb_to_eager();
   st_eager++;
   return 0;
}

int lfb_ref_call;

void lfb_eager(void)
{
   lfb_to_eager();
}

/* ---- rollback: the queue travels with a raw savestate ------------------------ */

int neil_lfb_snapshot(void)
{
   int h, i;
   if (prev_cap < 0 && nregs == 0)
      return -1;
   for (h = 0; h < nsnaps; h++)
      if (!snaps[h].used) break;
   if (h == nsnaps)
   {
      lfb_snap_t *n = (lfb_snap_t*)realloc(snaps, sizeof(*snaps) * (nsnaps + 8));
      if (!n) return -2;
      snaps = n;
      memset(snaps + nsnaps, 0, sizeof(*snaps) * 8);
      nsnaps += 8;
   }
   snaps[h].used = 1;
   snaps[h].prev = prev_cap; cap_ref(prev_cap);
   snaps[h].n = nregs;
   for (i = 0; i < nregs; i++) { snaps[h].r[i] = regs[i]; cap_ref(regs[i].cap); }
   return h;
}

/* -1: the snapshot held nothing (see above); the caller has just loaded RDRAM */
void neil_lfb_restore(int h)
{
   int i;
   lfb_drop_all();
   if (h < 0 || h >= nsnaps || !snaps[h].used)
      return;
   prev_cap = snaps[h].prev; cap_ref(prev_cap);
   for (i = 0; i < snaps[h].n; i++)
   {
      regs[i] = snaps[h].r[i];
      cap_ref(regs[i].cap);
      pages(&regs[i], +1);
   }
   nregs = snaps[h].n;
   bounds_update();
}

void neil_lfb_release(int h)
{
   int i;
   if (h < 0 || h >= nsnaps || !snaps[h].used)
      return;
   cap_unref(snaps[h].prev);
   for (i = 0; i < snaps[h].n; i++) cap_unref(snaps[h].r[i].cap);
   snaps[h].used = 0;
}

/* ---- the rig's and the page's view ---------------------------------------- */

void neil_lfb_flush(void) { lfb_materialize_all(); }

/* out[0..7]: queued, materialised, superseded, dropped, failed, eager, pending
 * now, captures alive */
void neil_lfb_stats(uint32_t *out)
{
   int i, alive = 0;
   for (i = 0; i < ncaps; i++) if (caps[i].refs > 0) alive++;
   out[0] = st_queued; out[1] = st_materialised; out[2] = st_superseded; out[3] = st_dropped;
   out[4] = st_failed; out[5] = st_eager; out[6] = (uint32_t)nregs; out[7] = (uint32_t)alive;
}

/* the RDRAM ranges not yet written, as [lo, hi) pairs; returns how many */
int neil_lfb_pending(uint32_t *out, int max)
{
   int i;
   for (i = 0; i < nregs && i < max; i++) { out[2 * i] = regs[i].lo; out[2 * i + 1] = regs[i].hi; }
   return nregs;
}
