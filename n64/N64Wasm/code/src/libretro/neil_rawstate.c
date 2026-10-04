/* neil_rawstate.c — RAW, EXACT, IN-MEMORY SAVESTATES FOR ROLLBACK AND RUN-AHEAD
 *
 * The shipped savestate path (neil_serialize / neil_unserialize, libretronew.c)
 * serializes with savestates_save_m64p into a 16.8 MB buffer and then gzips it
 * to MEMFS: ~250 ms to save and ~44 ms to load on MK64, which rollback at input
 * delay 0 cannot afford every frame. Nothing here compresses and nothing here
 * touches a file.
 *
 *   int neil_state_size(void)                 bytes a raw state occupies
 *   int neil_state_save_raw(uint8_t* dst)     writes one; returns its size, 0 = failed
 *   int neil_state_load_raw(const uint8_t* s) restores one; 1 = ok, 0 = rejected
 *                                             (wrong ROM / not a raw state /
 *                                             different core build) — on 0 NOTHING
 *                                             in the running machine was modified.
 *
 * LAYOUT
 *   [0, NEIL_M64P_REGION)   exactly the bytes savestates_save_m64p writes — the
 *                           core's own serializer, so nothing it captures can be
 *                           missed — zero-padded. (It is the same byte stream the
 *                           gzip path compresses.)
 *   [NEIL_M64P_REGION, end) the trailer: state the m64p format drops or restores
 *                           only approximately, and that DOES change what the
 *                           machine does next. Each item says why below.
 *
 * WHAT THE TRAILER ADDS, AND WHY EACH ITEM IS THERE
 *   - event queue verbatim + SPECIAL_done + next_interrupt: the m64p loader
 *     re-sorts the queue against the current Count and recomputes next_interrupt.
 *   - skip_jump, last_addr, delay_slot, VI_Count, interrupt_unsafe_state,
 *     g_gs_vi_counter, PIF cic_challenge: interpreter/frame-loop state the format
 *     omits (the loader forces last_addr = PC).
 *   - PI BSD_DOM2 registers: the m64p SAVER writes the DOM1 registers into the
 *     DOM2 slots (savestates.c), so a loaded state has DOM2 == DOM1.
 *   - AI fifo addresses, samples_format_changed, audio_pos: the loader guesses
 *     the fifo addresses ("you might get a small sound pop") and forces a format
 *     change; audio_pos is guest-visible under fixed_audio_pos.
 *   - the audio plugin's derived format (GameFreq & co.), consistent with the
 *     exactly-restored samples_format_changed.
 *   - SP rsp_task_locked / audio_signal.
 *   - cxd4 (the LLE RSP that runs every graphics AND audio task here): scalar and
 *     vector registers, accumulators, flags, divide unit, MFC0 timeout.
 *   - angrylion: the whole RDP state (tiles, TMEM, modes, colours, noise seed,
 *     partially assembled command), the VI's presentation state, and the 4 MiB
 *     hidden RDRAM bit plane (coverage / delta-Z).
 *   - save memory (EEPROM, SRAM, FlashRAM, 4 controller paks): a rollback across
 *     a save-game write must un-write it, or a re-simulated frame reads the future.
 *   NOT captured, on purpose: the audio OUTPUT ring and resampler history (host
 *   output — samples already handed to the speaker cannot be rolled back; the
 *   page decides what to do with re-simulated audio), the 1.4 MiB VI prescale
 *   output buffer (regenerated from RDRAM), host-side counters (neil_vi_total,
 *   the fps meters), and the 64DD disk image.
 *
 * CODE-CACHE INVALIDATION ON LOAD
 *   The m64p loader wipes the entire cached-interpreter code cache
 *   (invalidate_r4300_cached_code(0,0)). With the page JIT on, every block the
 *   game then executes is re-decoded AND re-emitted as a fresh WebAssembly
 *   module — per load, i.e. per rollback. The raw loader instead invalidates
 *   exactly the RDRAM pages that hold compiled code AND whose bytes differ from
 *   the incoming state, which is the same rule the core itself applies when code
 *   memory is written. That shortcut is taken only when the TLB is proven
 *   identical (neil_tlb_gen, same instance, unchanged since the save); otherwise
 *   the full wipe runs exactly as before. It also lets the loader skip copying
 *   the two 4 MiB TLB tables, which it has just proven identical.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include "api/m64p_types.h"
#include "main/main.h"
#include "main/device.h"
#include "main/rom.h"
#include "main/savestates.h"
#include "r4300/r4300.h"
#include "r4300/r4300_core.h"
#include "r4300/recomp.h"
#include "r4300/cached_interp.h"
#include "r4300/interrupt.h"
#include "pi/pi_controller.h"
#include "libretro_memory.h"
#include "../mupen64plus-core/src/main/lfb_hook.h"

/* savestates.c */
extern size_t savestates_m64p_last_len;
extern int savestates_keep_code_cache;
extern int savestates_skip_tlb_luts;
extern size_t neil_m64p_lut_off, neil_m64p_tlbe_off, neil_m64p_tlbe_len;
size_t neil_tlbe_serialize(unsigned char *out);
extern uint32_t tlb_LUT_r[0x100000];
extern uint32_t tlb_LUT_w[0x100000];
/* r4300/tlb.c */
extern uint32_t neil_tlb_gen;
/* r4300/interrupt.c */
extern int VI_Count;
int neil_intq_save(uint32_t* out);
void neil_intq_restore(const uint32_t* in);
int neil_intq_words_max(void);
/* mupen64plus-rsp-cxd4/rsp.c */
int neil_cxd4_state_io(unsigned char* buf, int save);
/* mupen64plus-rsp-hle/src/hle_plugin.c */
int neil_hle_state_io(unsigned char* buf, int save);
/* mupen64plus-video-angrylion/n64video.c */
int neil_al_state_io(unsigned char* buf, int save);
unsigned char* neil_al_hidden_ptr(void);
int neil_al_hidden_size(void);
/* mupen64plus-video-angrylion/n64video/rdp/rdram.c */
extern uint32_t neil_hid_epoch, neil_hid_all_ep, neil_hid_ep[];
/* plugin/audio_libretro/audio_backend_libretro.c */
int neil_audio_state_io(unsigned char* buf, int save);

/* m64p stream: 16788292 fixed bytes + an event-queue tail of at most 132, and
 * the LOADER memcpys a fixed 1024-byte queue window (savestates.c), so the
 * region must hold fixed + 1024. Rounded up to a multiple of 64. The shipped
 * savestate_buffer (16788288 + 1024) is 4 bytes short of that window, which is
 * harmless there only because the overread lands in adjacent static data. */
#define NEIL_M64P_REGION 16789504u
/* offset of the RDRAM image inside the m64p stream (header, then the RDRAM,
 * MI, PI, SP, SI, VI, RI, AI, DPC and DPS registers — savestates.c). Verified
 * against live RDRAM on the first save of each session before it is trusted. */
#define NEIL_M64P_DRAM_OFF 448u
#define NEIL_RAW_MAGIC   0x3153524Eu /* 'NRS1' */
#define NEIL_RAW_VERSION 1u
#define NEIL_INTQ_WORDS  34          /* 2 + 2 * POOL_CAPACITY (16) */
#define NEIL_SAVEMEM_SIZE ((uint32_t)offsetof(save_memory_data, disk))

struct neil_raw_hdr
{
   uint32_t magic, version, total_size, m64p_len;
   uint32_t nonce, tlb_gen, hid_epoch;   /* bookkeeping for the fast save, not machine state */
   uint32_t next_interrupt, skip_jump, last_addr, delay_slot;
   uint32_t vi_count, interrupt_unsafe_state, gs_vi_counter, cic_challenge;
   uint32_t pi_dom2[4];
   uint32_t ai_fifo_addr[2], ai_samples_format_changed, ai_audio_pos;
   uint32_t rsp_task_locked, rsp_audio_signal;
   uint32_t intq[NEIL_INTQ_WORDS];
   uint32_t audio_sz, cxd4_sz, al_sz, hidden_sz, savemem_sz;
   uint32_t hle_sz;
   uint32_t reserved[5];
};

static uint32_t g_nonce;          /* identifies THIS running instance */
static int g_dram_off_ok = -1;    /* -1 unknown, 1 verified, 0 layout mismatch */
static int g_last_load_mode;      /* 0 none, 1 selective, 2 full wipe, 3 selective across a TLB rewrite */
static int g_last_load_pages;     /* pages invalidated by the last selective load */
static int g_tlb_same_by_content; /* loads whose TLB generation differed but whose TLB did not */
static int g_tlb_remapped;        /* loads whose TLB did differ, taken selectively (mode 3) */
static int g_tlb_remapped_pages;  /* virtual pages the last such load invalidated */
static unsigned char g_phys_chg[RDRAM_MAX_SIZE >> 12]; /* pages the last load found changed */

#define ALIGN8(x) (((x) + 7u) & ~7u)

static uint32_t sz_audio(void)   { return (uint32_t)neil_audio_state_io(NULL, 0); }
static uint32_t sz_cxd4(void)    { return (uint32_t)neil_cxd4_state_io(NULL, 0); }
static uint32_t sz_hle(void)     { return (uint32_t)neil_hle_state_io(NULL, 0); }
static uint32_t sz_al(void)      { return (uint32_t)neil_al_state_io(NULL, 0); }
static uint32_t sz_hidden(void)  { return (uint32_t)neil_al_hidden_size(); }

static uint32_t trailer_size(void)
{
   return ALIGN8((uint32_t)sizeof(struct neil_raw_hdr))
        + ALIGN8(sz_audio()) + ALIGN8(sz_cxd4()) + ALIGN8(sz_hle()) + ALIGN8(sz_al())
        + ALIGN8(sz_hidden()) + ALIGN8(NEIL_SAVEMEM_SIZE);
}

static uint32_t instance_nonce(void)
{
   if (!g_nonce)
   {
#ifdef __EMSCRIPTEN__
      double t = emscripten_get_now() * 1000.0;
#else
      double t = (double)clock();
#endif
      g_nonce = ((uint32_t)t ^ (uint32_t)time(NULL) ^ (uint32_t)(uintptr_t)&g_nonce) | 1u;
   }
   return g_nonce;
}

static void zero_gap(unsigned char* base, uint32_t off, uint32_t n)
{
   if (ALIGN8(n) != n) memset(base + off + n, 0, ALIGN8(n) - n);
}

static void zero_trailer_gaps(unsigned char* t, const struct neil_raw_hdr* h)
{
   uint32_t o = 0;
   zero_gap(t, o, (uint32_t)sizeof(*h)); o += ALIGN8((uint32_t)sizeof(*h));
   zero_gap(t, o, h->audio_sz);          o += ALIGN8(h->audio_sz);
   zero_gap(t, o, h->cxd4_sz);           o += ALIGN8(h->cxd4_sz);
   zero_gap(t, o, h->hle_sz);            o += ALIGN8(h->hle_sz);
   zero_gap(t, o, h->al_sz);             o += ALIGN8(h->al_sz);
   zero_gap(t, o, h->hidden_sz);         o += ALIGN8(h->hidden_sz);
   zero_gap(t, o, h->savemem_sz);
}

int neil_state_size(void)
{
   return (int)(NEIL_M64P_REGION + trailer_size());
}

/* how the last load treated the code cache (diagnostics for the page/tests):
 * 1 = selective (only changed code pages), 2 = full wipe, 0 = none yet */
int neil_state_last_load_mode(void) { return g_last_load_mode; }
/* the rig's arm for mode 3 (neil_state_set_remap(0): every TLB-changing load wipes, as before) */
static int neil_remap_off;
void neil_state_set_remap(int on) { neil_remap_off = on ? 0 : 1; }
int neil_state_last_load_pages(void) { return g_last_load_pages; }
int neil_state_m64p_region(void) { return (int)NEIL_M64P_REGION; }
int neil_state_tlb_same_by_content(void) { return g_tlb_same_by_content; }
int neil_state_tlb_remapped(void) { return g_tlb_remapped; }
int neil_state_tlb_remapped_pages(void) { return g_tlb_remapped_pages; }

/* THE TLB GENERATION IS A PROOF OF SAMENESS, NOT OF DIFFERENCE. It is bumped by
 * EVERY write of a TLB entry, the same value rewritten included, so a state
 * saved before such a write fails the generation test though the TLB it holds
 * is byte-identical to the live one — and the loader then wiped the whole code
 * cache. MEASURED (n64_room_mode_probe, SM64 loopback room): the room's first
 * load (a frame-skip repair from frame 357, run at 375) took the full wipe —
 * 30-49.5 ms inside the load and a 112-187 ms re-run that recompiled
 * everything. So when the generations differ, the bytes decide: both 4 MiB
 * lookup tables and the 32 entries (serialized exactly as the saver writes
 * them) compared with the live ones — ~8 MiB of memcmp, paid only on such a
 * load. Equal bytes are the same mapping, so the selective path is exactly as
 * valid as when the generation matched. */
static int tlb_content_same(const unsigned char* src)
{
   unsigned char cur[32 * 64];
   size_t n;
   if (!neil_m64p_lut_off || !neil_m64p_tlbe_off || !neil_m64p_tlbe_len || neil_m64p_tlbe_len > sizeof(cur))
      return 0;
   if (neil_m64p_tlbe_off + neil_m64p_tlbe_len > NEIL_M64P_REGION)
      return 0;
   n = neil_tlbe_serialize(cur);
   if (n != neil_m64p_tlbe_len || memcmp(src + neil_m64p_tlbe_off, cur, n) != 0)
      return 0;
   if (memcmp(src + neil_m64p_lut_off, tlb_LUT_r, sizeof(tlb_LUT_r)) != 0)
      return 0;
   if (memcmp(src + neil_m64p_lut_off + sizeof(tlb_LUT_r), tlb_LUT_w, sizeof(tlb_LUT_w)) != 0)
      return 0;
   return 1;
}

static int save_raw(unsigned char* dst, int fast)
{
   struct neil_raw_hdr h, prev;
   unsigned char* p;
   uint32_t len, hid_changed_since = 0;
   int lut_skip = 0, hid_partial = 0, ok;

   if (!dst)
      return 0;
   if (fast)
   {
      /* Fast only into a buffer THIS instance fully wrote as a raw state and
       * that nobody has modified since: then every byte we skip is provably
       * already right (neil_tlb_gen for the LUTs, per-page write epochs for
       * the hidden plane). Anything else falls back to the full save. */
      memcpy(&prev, dst + NEIL_M64P_REGION, sizeof(prev));
      if (prev.magic == NEIL_RAW_MAGIC && prev.version == NEIL_RAW_VERSION
            && prev.total_size == (uint32_t)neil_state_size()
            && prev.nonce == instance_nonce() && prev.hid_epoch != 0
            && prev.hidden_sz == sz_hidden())
      {
         lut_skip = (prev.tlb_gen == neil_tlb_gen);
         hid_partial = 1;
         hid_changed_since = prev.hid_epoch;
      }
   }
   savestates_skip_tlb_luts = lut_skip;
   ok = savestates_save_m64p(dst, NEIL_M64P_REGION);
   savestates_skip_tlb_luts = 0;
   if (!ok)
      return 0;
   len = (uint32_t)savestates_m64p_last_len;
   if (len + 1024u > NEIL_M64P_REGION)
      return 0; /* cannot happen with a 16-node queue; refuse rather than overrun */
   memset(dst + len, 0, NEIL_M64P_REGION - len);

   if (g_dram_off_ok < 0)
   {
      const unsigned char* d = (const unsigned char*)g_dev.ri.rdram.dram;
      g_dram_off_ok =
         memcmp(dst + NEIL_M64P_DRAM_OFF, d, 4096) == 0 &&
         memcmp(dst + NEIL_M64P_DRAM_OFF + RDRAM_MAX_SIZE - 4096, d + RDRAM_MAX_SIZE - 4096, 4096) == 0;
   }

   memset(&h, 0, sizeof(h));
   h.magic = NEIL_RAW_MAGIC;
   h.version = NEIL_RAW_VERSION;
   h.total_size = (uint32_t)neil_state_size();
   h.m64p_len = len;
   h.nonce = instance_nonce();
   h.tlb_gen = neil_tlb_gen;
   h.hid_epoch = neil_hid_epoch;
   h.next_interrupt = next_interrupt;
   h.skip_jump = skip_jump;
   h.last_addr = last_addr;
   h.delay_slot = g_dev.r4300.delay_slot;
   h.vi_count = (uint32_t)VI_Count;
   h.interrupt_unsafe_state = (uint32_t)interrupt_unsafe_state;
   h.gs_vi_counter = (uint32_t)g_gs_vi_counter;
   h.cic_challenge = g_dev.si.pif.cic_challenge;
   h.pi_dom2[0] = g_dev.pi.regs[PI_BSD_DOM2_LAT_REG];
   h.pi_dom2[1] = g_dev.pi.regs[PI_BSD_DOM2_PWD_REG];
   h.pi_dom2[2] = g_dev.pi.regs[PI_BSD_DOM2_PGS_REG];
   h.pi_dom2[3] = g_dev.pi.regs[PI_BSD_DOM2_RLS_REG];
   h.ai_fifo_addr[0] = g_dev.ai.fifo[0].address;
   h.ai_fifo_addr[1] = g_dev.ai.fifo[1].address;
   h.ai_samples_format_changed = g_dev.ai.samples_format_changed;
   h.ai_audio_pos = g_dev.ai.audio_pos;
   h.rsp_task_locked = g_dev.sp.rsp_task_locked;
   h.rsp_audio_signal = g_dev.sp.audio_signal;
   if (neil_intq_words_max() > NEIL_INTQ_WORDS)
      return 0;
   neil_intq_save(h.intq);
   h.audio_sz = sz_audio();
   h.cxd4_sz = sz_cxd4();
   h.hle_sz = sz_hle();
   h.al_sz = sz_al();
   h.hidden_sz = sz_hidden();
   h.savemem_sz = NEIL_SAVEMEM_SIZE;

   p = dst + NEIL_M64P_REGION;
   /* the ALIGN8 gaps between blobs must be deterministic bytes too, or two
    * saves of one moment would hash differently (found on Conker) */
   zero_trailer_gaps(p, &h);
   memcpy(p, &h, sizeof(h));
   p += ALIGN8((uint32_t)sizeof(h));
   neil_audio_state_io(p, 1);                     p += ALIGN8(h.audio_sz);
   neil_cxd4_state_io(p, 1);                      p += ALIGN8(h.cxd4_sz);
   neil_hle_state_io(p, 1);                       p += ALIGN8(h.hle_sz);
   neil_al_state_io(p, 1);                        p += ALIGN8(h.al_sz);
   if (hid_partial)
   {
      /* only the 4 KiB pages written since this buffer's own save */
      const unsigned char* hid = neil_al_hidden_ptr();
      uint32_t pg, npg = h.hidden_sz >> 12;
      if (neil_hid_all_ep > hid_changed_since)
         memcpy(p, hid, h.hidden_sz);
      else
         for (pg = 0; pg < npg; pg++)
            if (neil_hid_ep[pg] > hid_changed_since)
               memcpy(p + (pg << 12), hid + (pg << 12), 4096);
   }
   else
      memcpy(p, neil_al_hidden_ptr(), h.hidden_sz);
   p += ALIGN8(h.hidden_sz);
   memcpy(p, &saved_memory, h.savemem_sz);        p += ALIGN8(h.savemem_sz);

   /* writes from here on belong to the next epoch */
   neil_hid_epoch++;
   return (int)h.total_size;
}

int neil_state_save_raw(unsigned char* dst) { return save_raw(dst, 0); }

/* Same bytes as neil_state_save_raw, faster when `dst` already holds a raw
 * state that THIS instance wrote and nobody has modified since: it then skips
 * the two 4 MiB TLB tables when the TLB is unchanged (neil_tlb_gen) and copies
 * only the hidden-plane pages the RDP has written since. Intended for a ring of
 * buffers the page reuses. The page must not write into such a buffer (reading
 * it, sending it to a peer, hashing it, are all fine); after writing into one,
 * the next save into it is simply a full save if the header was changed — but
 * a buffer whose header is intact and whose body was altered would be trusted,
 * so the rule is: never write into a ring buffer yourself. */
int neil_state_save_raw_fast(unsigned char* dst) { return save_raw(dst, 1); }

/* Invalidate the compiled code of every RDRAM page that (a) currently holds a
 * valid compiled block in kseg0 or kseg1 and (b) differs from the incoming
 * image. TLB-mapped aliases of those pages are invalidated by the core's own
 * update_invalid_addr() on the next jump into them, exactly as they are after
 * an ordinary store to code — valid only because the caller has proven the TLB
 * mapping unchanged. Pages with no valid block need nothing: they recompile
 * from memory on first entry anyway. */
static int invalidate_changed_code_pages(const unsigned char* img)
{
   const unsigned char* cur = (const unsigned char*)g_dev.ri.rdram.dram;
   uint32_t p, n = 0;
   for (p = 0; p < (RDRAM_MAX_SIZE >> 12); p++)
   {
      if (invalid_code[0x80000 + p] && invalid_code[0xA0000 + p])
         continue;
      if (memcmp(cur + (p << 12), img + (p << 12), 4096) != 0)
      {
         invalid_code[0x80000 + p] = 1;
         invalid_code[0xA0000 + p] = 1;
         g_phys_chg[p] = 1;
         n++;
      }
   }
   return (int)n;
}

/* A LOAD ACROSS A TLB REWRITE NEED NOT WIPE THE CODE CACHE (mode 3). MEASURED (the
 * bench's loopback room, SM64, host worker): a frame-skip repair loaded a state
 * from before the guest rewrote its TLB (frames ~357-360) and the loader wiped
 * everything — memset(invalid_code, 1): a 150 ms tick, 134-168 ms lost, every
 * page of the re-run recompiled. The cache is keyed by VIRTUAL page, and a
 * TLB rewrite only changes what the TLB-mapped virtual pages (below 0x80000000,
 * at or above 0xC0000000) translate to — which is exactly what TLBWrite itself
 * invalidates at run time. So the loader does what a TLB write does, for every
 * mapped page at once: a virtual page whose translation (tlb_LUT_r, live vs the
 * state's) differs is invalidated; one that translates the same is kept unless
 * the physical page behind it changed (the KSEG0/KSEG1 pages are handled by
 * invalidate_changed_code_pages, as on the TLB-unchanged path). Then the LUTs
 * ARE loaded (not skipped). Pages never compiled (invalid already) are skipped. */
static int invalidate_remapped_pages(const unsigned char* src)
{
   const uint32_t* lr = (const uint32_t*)(src + neil_m64p_lut_off);
   uint32_t i, n = 0;
   for (i = 0; i < 0x100000; i++)
   {
      uint32_t a, b;
      if (i == 0x80000) { i = 0xBFFFF; continue; }     /* KSEG0/KSEG1: not translated */
      if (invalid_code[i])
         continue;
      a = tlb_LUT_r[i];
      memcpy(&b, lr + i, 4);
      if (a != b || (a && (a & 0x1FFFFFFF) < RDRAM_MAX_SIZE && g_phys_chg[(a & 0x1FFFFFFF) >> 12]))
      {
         invalid_code[i] = 1;
         n++;
      }
   }
   return (int)n;
}

int neil_state_load_raw(const unsigned char* src)
{
   struct neil_raw_hdr h;
   const unsigned char* p;
   int lut_same, ok;

   if (!src)
      return 0;

   /* ---- validate EVERYTHING before touching the machine ---- */
   memcpy(&h, src + NEIL_M64P_REGION, sizeof(h));
   if (h.magic != NEIL_RAW_MAGIC || h.version != NEIL_RAW_VERSION)
      return 0;
   if (h.total_size != (uint32_t)neil_state_size())
      return 0;
   if (h.audio_sz != sz_audio() || h.cxd4_sz != sz_cxd4() || h.hle_sz != sz_hle() || h.al_sz != sz_al()
         || h.hidden_sz != sz_hidden() || h.savemem_sz != NEIL_SAVEMEM_SIZE)
      return 0;
   if (h.m64p_len + 1024u > NEIL_M64P_REGION)
      return 0;
   if (memcmp(src, "M64+SAVE", 8) != 0)
      return 0;
   if (src[8] != 0x00 || src[9] != 0x01 || src[10] != 0x00 || src[11] != 0x00)
      return 0;
   if (memcmp(src + 12, ROM_SETTINGS.MD5, 32) != 0)
      return 0;
   if (h.intq[0] > 16u)
      return 0;

   /* ---- code cache: selective when the TLB is provably unchanged ---- */
   lut_same = (h.nonce == instance_nonce() && h.tlb_gen == neil_tlb_gen);
   if (!lut_same && h.nonce == instance_nonce() && tlb_content_same(src))
   {
      lut_same = 1;
      g_tlb_same_by_content++;
   }
   memset(g_phys_chg, 0, sizeof(g_phys_chg));
   if (lut_same && g_dram_off_ok == 1)
   {
      g_last_load_pages = invalidate_changed_code_pages(src + NEIL_M64P_DRAM_OFF);
      g_last_load_mode = 1;
      savestates_keep_code_cache = 1;
   }
   else if (!lut_same && h.nonce == instance_nonce() && g_dram_off_ok == 1 && neil_m64p_lut_off
         && neil_m64p_lut_off + 2u * sizeof(tlb_LUT_r) <= NEIL_M64P_REGION && !neil_remap_off)
   {
      g_last_load_pages = invalidate_changed_code_pages(src + NEIL_M64P_DRAM_OFF);
      g_tlb_remapped_pages = invalidate_remapped_pages(src);
      g_last_load_pages += g_tlb_remapped_pages;
      g_tlb_remapped++;
      g_last_load_mode = 3;
      savestates_keep_code_cache = 1;
   }
   else
   {
      g_last_load_pages = -1;
      g_last_load_mode = 2;
      savestates_keep_code_cache = 0;
   }
   savestates_skip_tlb_luts = lut_same;

   /* RDRAM is replaced: glide's queued framebuffer copies belong to the old
    * one. A rollback puts back the snapshot's own queue (fbasync.js restore ->
    * neil_lfb_restore) right after this returns. */
   lfb_drop_all();

   /* jump_to_func() is a no-op while skip_jump is set; the loader's jump to
    * the saved PC must land, and the saved value is restored below. */
   skip_jump = 0;
   ok = savestates_load_m64p(src, NEIL_M64P_REGION);
   savestates_keep_code_cache = 0;
   savestates_skip_tlb_luts = 0;
   if (!ok)
      return 0; /* unreachable: the loader only rejects what was checked above */

   /* ---- the trailer: exact values over the loader's approximations ---- */
   neil_intq_restore(h.intq);
   next_interrupt = h.next_interrupt;
   skip_jump = h.skip_jump;
   last_addr = h.last_addr;
   g_dev.r4300.delay_slot = h.delay_slot;
   VI_Count = (int)h.vi_count;
   interrupt_unsafe_state = (int)h.interrupt_unsafe_state;
   g_gs_vi_counter = (int)h.gs_vi_counter;
   g_dev.si.pif.cic_challenge = (uint8_t)h.cic_challenge;
   g_dev.pi.regs[PI_BSD_DOM2_LAT_REG] = h.pi_dom2[0];
   g_dev.pi.regs[PI_BSD_DOM2_PWD_REG] = h.pi_dom2[1];
   g_dev.pi.regs[PI_BSD_DOM2_PGS_REG] = h.pi_dom2[2];
   g_dev.pi.regs[PI_BSD_DOM2_RLS_REG] = h.pi_dom2[3];
   g_dev.ai.fifo[0].address = h.ai_fifo_addr[0];
   g_dev.ai.fifo[1].address = h.ai_fifo_addr[1];
   g_dev.ai.samples_format_changed = h.ai_samples_format_changed;
   g_dev.ai.audio_pos = h.ai_audio_pos;
   g_dev.sp.rsp_task_locked = h.rsp_task_locked;
   g_dev.sp.audio_signal = h.rsp_audio_signal;

   p = src + NEIL_M64P_REGION + ALIGN8((uint32_t)sizeof(h));
   neil_audio_state_io((unsigned char*)p, 0);     p += ALIGN8(h.audio_sz);
   neil_cxd4_state_io((unsigned char*)p, 0);      p += ALIGN8(h.cxd4_sz);
   neil_hle_state_io((unsigned char*)p, 0);       p += ALIGN8(h.hle_sz);
   neil_al_state_io((unsigned char*)p, 0);        p += ALIGN8(h.al_sz);
   memcpy(neil_al_hidden_ptr(), p, h.hidden_sz);  p += ALIGN8(h.hidden_sz);
   neil_hid_all_ep = neil_hid_epoch; /* the whole plane was just replaced */
   memcpy(&saved_memory, p, h.savemem_sz);        p += ALIGN8(h.savemem_sz);

   return 1;
}
