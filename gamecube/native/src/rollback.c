// gamecube/native/src/rollback.c — savestates for rollback netplay that cost nothing to take.
//
// THE STATE. Everything the game owns lives in two contiguous ranges the link brackets with
// markers: the game's (and overlays') .data, ~140 KB, and its .bss, which holds every heap the game
// allocates from (src/det_heap.c: HuMem heaps, MusyX, DVD blocks, MEM1, ARAM) and the process
// fiber stacks. Aurora, WebGPU, SDL and this file sit outside both, so rolling back never touches a
// GPU object.
//
// HOW A SAVE IS FREE. A write barrier merged into the wasm after the link (wb/barrier.wat, applied
// by wb/instrument.sh) sees every store. The first store into a .bss page during a frame calls
// mp4web_cow(), which copies the page's PRE-IMAGE into that frame's undo log. A frame boundary only
// closes one log and opens the next; .data, being small, is copied whole at each boundary. Restoring
// the state at the start of frame k replays the logs of frames cur-1 .. k backwards (each puts its
// pre-images back), then .data's copy for k. Cost is proportional to pages actually written.
//
// THE FINGERPRINT is the same bytes: a per-page hash table updated lazily for pages written since it
// was last computed, combined with a hash of .data — so hashing the whole state is cheap too.
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <xxhash.h>

#define PAGE_SHIFT 12u
#define PAGE (1u << PAGE_SHIFT)

extern char mp4web_game_data_b[], mp4web_game_data_e[], mp4web_game_bss_b[], mp4web_game_bss_e[];
// Defined by the merged barrier module; the JS library stub (src/rollback_lib.js) stands in when the
// wasm was not instrumented, and then rollback refuses to enable.
extern void mp4web_barrier_init(uint32_t base, uint32_t pages, uint32_t table);
extern int mp4web_barrier_present(void);

static uint32_t g_base, g_pages;           // tracked .bss, page-aligned inward
static uint8_t* g_table;                   // 1 = page already logged in the open frame
static uint8_t* g_pool;                    // page images, a ring of g_cap slots
static uint32_t* g_ent;                    // page index of each logged image, same ring
static uint32_t g_cap;
static uint64_t g_head;                    // images ever logged (ring cursor)
static uint64_t g_overwritten;             // images lost to ring wrap (logs older than this are gone)

#define MAXR 64
typedef struct { int64_t frame; uint64_t start, count; } FrameLog;
static FrameLog g_log[MAXR];               // by frame % g_ring
static uint8_t* g_dcopy;                   // g_ring copies of .data, by frame % g_ring
static uint32_t g_dsize, g_ring;
static int64_t g_cur = -1;                 // the frame whose log is open (state = start of it + writes so far)
static int g_on;
static int g_overflow;

static uint64_t* g_ph;                     // per-page hash
static uint8_t* g_stale;                   // page hash out of date
static uint64_t g_hacc;                    // XOR of mix(page, g_ph[page]) over all pages
static uint32_t* g_staleList; static uint32_t g_staleN;
static double g_stats[8];                  // [boundaries, logged pages, max pages/frame, restores, restored pages, last restore ms, last boundary ms, overflow]

extern void mp4web_stack_range(uintptr_t* b, uintptr_t* e);   // det_heap.c
static uint32_t g_skipB, g_skipE;          // fiber-stack pages: logged and restored, not hashed
                                           // (below each live frame they hold stale scratch)
static inline uint64_t mixp(uint32_t p, uint64_t h) { return (h ^ (0x9E3779B97F4A7C15ull * (p + 1))) * 0xBF58476D1CE4E5B9ull; }

static void mark_stale(uint32_t p) {
  if (p >= g_skipB && p < g_skipE) return;
  if (!g_stale[p]) { g_stale[p] = 1; g_staleList[g_staleN++] = p; }
}

// The barrier calls this the first time a page is written in the open frame.
EMSCRIPTEN_KEEPALIVE void mp4web_cow(uint32_t p) {
  if (!g_on || p >= g_pages || g_table[p]) return;
  g_table[p] = 1;
  const uint32_t slot = (uint32_t)(g_head % g_cap);
  memcpy(g_pool + (size_t)slot * PAGE, (const void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), PAGE);
  g_ent[slot] = p;
  ++g_head;
  if (g_head > g_cap) g_overwritten = g_head - g_cap;
  mark_stale(p);
}

// JS is about to write [a, a+n) directly (the disc reader): log those pages first.
EMSCRIPTEN_KEEPALIVE void mp4web_rb_mark(uint32_t a, uint32_t n) {
  if (!g_on || !n) return;
  for (uint32_t x = a & ~(PAGE - 1); x < a + n; x += PAGE) {
    const uint32_t rel = x - g_base;
    if (rel < (g_pages << PAGE_SHIFT)) mp4web_cow(rel >> PAGE_SHIFT);
  }
}

// ring = frames of history kept (rollback window + slack); poolPages = page images kept in all.
EMSCRIPTEN_KEEPALIVE int mp4web_rb_enable(int32_t frame, uint32_t ring, uint32_t poolPages) {
  if (!mp4web_barrier_present()) return -1;               // this wasm was not instrumented
  if (ring < 2 || ring > MAXR || poolPages < 64) return -2;
  const uint32_t b = ((uint32_t)(uintptr_t)mp4web_game_bss_b + PAGE - 1) & ~(PAGE - 1);
  const uint32_t e = (uint32_t)(uintptr_t)mp4web_game_bss_e & ~(PAGE - 1);
  g_base = b; g_pages = (e - b) >> PAGE_SHIFT;
  g_dsize = (uint32_t)(mp4web_game_data_e - mp4web_game_data_b);
  // the unaligned bss head/tail (< 2 pages) ride along with .data's copy
  g_ring = ring; g_cap = poolPages;
  free(g_table); free(g_pool); free(g_ent); free(g_dcopy); free(g_ph); free(g_stale); free(g_staleList);
  g_table = calloc(g_pages, 1);
  g_pool = malloc((size_t)g_cap * PAGE);
  g_ent = malloc(sizeof(uint32_t) * g_cap);
  g_dcopy = malloc((size_t)g_ring * (g_dsize + 2 * PAGE));
  g_ph = malloc(sizeof(uint64_t) * g_pages);
  g_stale = calloc(g_pages, 1);
  g_staleList = malloc(sizeof(uint32_t) * g_pages);
  if (!g_table || !g_pool || !g_ent || !g_dcopy || !g_ph || !g_stale || !g_staleList) return -3;
  g_hacc = 0; g_staleN = 0;
  { uintptr_t sb, se; mp4web_stack_range(&sb, &se);
    g_skipB = (uint32_t)((sb - g_base) >> PAGE_SHIFT); g_skipE = (uint32_t)((se - g_base + PAGE - 1) >> PAGE_SHIFT); }
  for (uint32_t p = 0; p < g_pages; ++p) {
    if (p >= g_skipB && p < g_skipE) { g_ph[p] = 0; continue; }
    g_ph[p] = XXH3_64bits((const void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), PAGE);
    g_hacc ^= mixp(p, g_ph[p]);
  }
  for (uint32_t i = 0; i < MAXR; ++i) g_log[i].frame = -1;
  g_head = 0; g_overwritten = 0; g_overflow = 0;
  memset(g_stats, 0, sizeof g_stats);
  g_cur = frame;
  g_log[frame % g_ring] = (FrameLog){frame, 0, 0};
  g_on = 1;
  mp4web_barrier_init(g_base, g_pages, (uint32_t)(uintptr_t)g_table);
  return (int)g_pages;
}

EMSCRIPTEN_KEEPALIVE void mp4web_rb_disable(void) {
  mp4web_barrier_init(0, 0, 0);
  g_on = 0;
}

static void copy_small(uint8_t* dst) {           // .data + the unaligned bss ends -> dst
  memcpy(dst, mp4web_game_data_b, g_dsize);
  const uint32_t hb = g_base - (uint32_t)(uintptr_t)mp4web_game_bss_b;
  const uint32_t te = (uint32_t)(uintptr_t)mp4web_game_bss_e - (g_base + (g_pages << PAGE_SHIFT));
  memcpy(dst + g_dsize, mp4web_game_bss_b, hb);
  memcpy(dst + g_dsize + PAGE, (const void*)(uintptr_t)(g_base + (g_pages << PAGE_SHIFT)), te);
}
static void restore_small(const uint8_t* src) {
  memcpy(mp4web_game_data_b, src, g_dsize);
  const uint32_t hb = g_base - (uint32_t)(uintptr_t)mp4web_game_bss_b;
  const uint32_t te = (uint32_t)(uintptr_t)mp4web_game_bss_e - (g_base + (g_pages << PAGE_SHIFT));
  memcpy(mp4web_game_bss_b, src + g_dsize, hb);
  memcpy((void*)(uintptr_t)(g_base + (g_pages << PAGE_SHIFT)), src + g_dsize + PAGE, te);
}

// The boundary before frame `frame` runs (frame == g_cur + 1 normally): close the open log, save
// .data for the new frame, open its log.
EMSCRIPTEN_KEEPALIVE void mp4web_rb_boundary(int32_t frame) {
  if (!g_on) return;
  const double t0 = emscripten_get_now();
  FrameLog* L = &g_log[g_cur % g_ring];
  L->count = g_head - L->start;
  for (uint64_t i = L->start; i < g_head; ++i) g_table[g_ent[i % g_cap]] = 0;
  g_stats[1] += (double)L->count;
  if ((double)L->count > g_stats[2]) g_stats[2] = (double)L->count;
  g_cur = frame;
  g_log[frame % g_ring] = (FrameLog){frame, g_head, 0};
  copy_small(g_dcopy + (size_t)(frame % g_ring) * (g_dsize + 2 * PAGE));
  g_stats[0] += 1;
  g_stats[6] = emscripten_get_now() - t0;
  g_stats[7] = (double)g_overflow;
}

// Oldest frame whose start can still be restored.
EMSCRIPTEN_KEEPALIVE double mp4web_rb_oldest(void) {
  if (!g_on) return -1;
  int64_t f = g_cur;
  while (f - 1 >= 0 && g_cur - (f - 1) < (int64_t)g_ring) {
    const FrameLog* L = &g_log[(f - 1) % g_ring];
    if (L->frame != f - 1 || L->start < g_overwritten) break;
    --f;
  }
  return (double)f;
}

// Put the game back to the start of frame k (k <= g_cur). Returns 0, or <0 if k is out of reach.
EMSCRIPTEN_KEEPALIVE int mp4web_rb_restore(int32_t k) {
  if (!g_on) return -1;
  if (k > g_cur) return -2;
  if ((double)k < mp4web_rb_oldest()) return -3;
  const double t0 = emscripten_get_now();
  mp4web_barrier_init(g_base, 0, (uint32_t)(uintptr_t)g_table);   // our own copies must not be logged
  // the open frame's writes first (its log is still open), then each closed frame back to k
  uint64_t restored = 0;
  for (int64_t j = g_cur; j >= k; --j) {
    FrameLog* L = &g_log[j % g_ring];
    const uint64_t end = (j == g_cur) ? g_head : L->start + L->count;
    for (uint64_t i = end; i-- > L->start;) {
      const uint32_t slot = (uint32_t)(i % g_cap), p = g_ent[slot];
      memcpy((void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), g_pool + (size_t)slot * PAGE, PAGE);
      g_table[p] = 0;
      mark_stale(p);
      ++restored;
    }
  }
  restore_small(g_dcopy + (size_t)(k % g_ring) * (g_dsize + 2 * PAGE));
  g_head = g_log[k % g_ring].start;              // logs >= k are gone; their slots get reused
  g_cur = k;
  g_log[k % g_ring] = (FrameLog){k, g_head, 0};
  mp4web_barrier_init(g_base, g_pages, (uint32_t)(uintptr_t)g_table);
  g_stats[3] += 1; g_stats[4] += (double)restored;
  g_stats[5] = emscripten_get_now() - t0;
  return 0;
}

// Fingerprint of the CURRENT state (the start of frame g_cur plus whatever it has written so far —
// call it at a boundary).
EMSCRIPTEN_KEEPALIVE double mp4web_rb_hash(void) {
  if (!g_on) return -1;
  for (uint32_t i = 0; i < g_staleN; ++i) {
    const uint32_t p = g_staleList[i];
    const uint64_t h = XXH3_64bits((const void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), PAGE);
    g_hacc ^= mixp(p, g_ph[p]) ^ mixp(p, h);
    g_ph[p] = h;
    g_stale[p] = 0;
  }
  g_staleN = 0;
  static uint8_t* tmp; static uint32_t tmpn;
  const uint32_t need = g_dsize + 2 * PAGE;
  if (tmpn < need) { free(tmp); tmp = calloc(need, 1); tmpn = need; }
  copy_small(tmp);
  const uint64_t h = g_hacc ^ XXH3_64bits(tmp, need);
  return (double)(h >> 11);
}

EMSCRIPTEN_KEEPALIVE double* mp4web_rb_stats(void) { return g_stats; }
EMSCRIPTEN_KEEPALIVE int mp4web_rb_on(void) { return g_on; }

// Test aid: pages whose bytes changed without passing the barrier since their hash was last taken
// (a write the undo log never saw). Fills up to `max` page addresses into out; returns the count.
EMSCRIPTEN_KEEPALIVE int mp4web_rb_audit(uint32_t* out, int max) {
  if (!g_on) return -1;
  int n = 0;
  for (uint32_t p = 0; p < g_pages; ++p) {
    if (g_stale[p] || (p >= g_skipB && p < g_skipE)) continue;
    const uint64_t h = XXH3_64bits((const void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), PAGE);
    if (h != g_ph[p]) { if (n < max) out[n] = g_base + (p << PAGE_SHIFT); ++n; }
  }
  return n;
}
// Test aid: the same fingerprint computed from scratch (every page), to check the incremental one.
EMSCRIPTEN_KEEPALIVE double mp4web_rb_hash_full(void) {
  if (!g_on) return -1;
  uint64_t acc = 0;
  for (uint32_t p = 0; p < g_pages; ++p) {
    if (p >= g_skipB && p < g_skipE) continue;
    acc ^= mixp(p, XXH3_64bits((const void*)(uintptr_t)(g_base + (p << PAGE_SHIFT)), PAGE));
  }
  static uint8_t* tmp; static uint32_t tmpn;
  const uint32_t need = g_dsize + 2 * PAGE;
  if (tmpn < need) { free(tmp); tmp = calloc(need, 1); tmpn = need; }
  copy_small(tmp);
  return (double)((acc ^ XXH3_64bits(tmp, need)) >> 11);
}
// Test aid: the per-page hashes (current after mp4web_rb_hash) and the tracked base, to diff two states.
EMSCRIPTEN_KEEPALIVE uint32_t mp4web_rb_pages(void) { return g_pages; }
EMSCRIPTEN_KEEPALIVE uint32_t mp4web_rb_base(void) { return g_base; }
EMSCRIPTEN_KEEPALIVE uint64_t* mp4web_rb_page_hashes(void) { return g_ph; }
EMSCRIPTEN_KEEPALIVE double mp4web_rb_small_hash(int part) {
  const uint32_t hb = g_base - (uint32_t)(uintptr_t)mp4web_game_bss_b;
  const uint32_t te = (uint32_t)(uintptr_t)mp4web_game_bss_e - (g_base + (g_pages << PAGE_SHIFT));
  if (part == 0) return (double)(XXH3_64bits(mp4web_game_data_b, g_dsize) >> 11);
  if (part == 1) return (double)(XXH3_64bits(mp4web_game_bss_b, hb) >> 11);
  return (double)(XXH3_64bits((const void*)(uintptr_t)(g_base + (g_pages << PAGE_SHIFT)), te) >> 11);
}
