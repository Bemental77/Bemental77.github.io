// gamecube/native/src/det_heap.c — a deterministic heap for game-owned allocations that would
// otherwise come from the shared C heap (MusyX's sound engine, the process fibers, OSAllocFromHeap).
//
// Why: the C heap is shared with Aurora and emdawnwebgpu, whose allocations happen inside browser
// callbacks (GPU map completion, events) at timing-dependent moments, so the ADDRESSES the game gets
// back differ between two runs — and the game stores those pointers in its state. Netplay needs two
// instances given the same inputs to hold the same bytes. This heap lives in the game's own .bss
// (inside the hashed/snapshotted state range) and only game code allocates from it, in game order.
//
// First-fit over an address-ordered free list with boundary tags; blocks are 16-byte aligned.
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>

#ifndef MP4WEB_DET_HEAP_MB
#define MP4WEB_DET_HEAP_MB 112
#endif
#define HEAP_BYTES ((size_t)MP4WEB_DET_HEAP_MB * 1024 * 1024)
#define ALIGN 16u

typedef struct Block { uint32_t size; uint32_t used; struct Block* next; struct Block* prev; } Block; // 16 bytes
_Static_assert(sizeof(Block) == 16, "header must keep 16-byte alignment");

typedef struct Heap {
  unsigned char* arena; size_t bytes;
  Block* free;                 // address-ordered free list
  int init;
  size_t inUse, highWater, fallbacks;
  const char* name;
} Heap;

static _Alignas(4096) unsigned char g_arena[HEAP_BYTES];   // page-aligned: rollback tracks whole pages
// Process fiber stacks get their own arena: their addresses must be deterministic (the game keeps
// them), but the bytes below each live frame are stale scratch, so the state hash skips this range.
// 32 MB: an Asyncify fiber takes >= 128 KB (64 KB C stack minimum + 64 KB unwind buffer), and m411
// runs ~100 processes at once; 8 MB ran out there (the GameCube's own heap held its small stacks)
#define STACK_BYTES ((size_t)32 * 1024 * 1024)
static _Alignas(4096) unsigned char g_stackArena[STACK_BYTES];
static Heap g_heap = {g_arena, HEAP_BYTES, NULL, 0, 0, 0, 0, "det_heap"};
static Heap g_stacks = {g_stackArena, STACK_BYTES, NULL, 0, 0, 0, 0, "det_stacks"};

static void heap_init(Heap* h) {
  h->free = (Block*)h->arena;
  h->free->size = (uint32_t)h->bytes;
  h->free->used = 0;
  h->free->next = h->free->prev = NULL;
  h->init = 1;
}

static int in_arena(const Heap* h, const void* p) { return (const unsigned char*)p >= h->arena && (const unsigned char*)p < h->arena + h->bytes; }

static void* heap_alloc(Heap* h, size_t n) {
  if (!h->init) heap_init(h);
  if (n == 0) n = 1;
  size_t need = (n + sizeof(Block) + ALIGN - 1) & ~(size_t)(ALIGN - 1);
  for (Block* b = h->free; b; b = b->next) {
    if (b->size < need) continue;
    if (b->size - need >= sizeof(Block) + ALIGN) {          // split: keep the tail free
      Block* t = (Block*)((unsigned char*)b + need);
      t->size = b->size - (uint32_t)need; t->used = 0;
      t->next = b->next; t->prev = b->prev;
      if (t->next) t->next->prev = t;
      if (t->prev) t->prev->next = t; else h->free = t;
      b->size = (uint32_t)need;
    } else {                                                 // take whole block
      if (b->next) b->next->prev = b->prev;
      if (b->prev) b->prev->next = b->next; else h->free = b->next;
    }
    b->used = 1; b->next = b->prev = NULL;
    h->inUse += b->size;
    if (h->inUse > h->highWater) h->highWater = h->inUse;
    return b + 1;
  }
  // Exhausted: report it loudly. Returning NULL is what the GameCube allocators do on failure.
  if (!h->fallbacks++) fprintf(stderr, "[%s] out of memory (%zu B requested, %zu in use)\n", h->name, n, h->inUse);
  return NULL;
}

static void heap_free(Heap* h, void* p) {
  if (!p || !in_arena(h, p)) return;
  Block* b = (Block*)p - 1;
  if (!b->used) return;
  b->used = 0;
  h->inUse -= b->size;
  Block* prev = NULL; Block* cur = h->free;               // insert address-ordered, then coalesce
  while (cur && cur < b) { prev = cur; cur = cur->next; }
  b->prev = prev; b->next = cur;
  if (prev) prev->next = b; else h->free = b;
  if (cur) cur->prev = b;
  if (cur && (unsigned char*)b + b->size == (unsigned char*)cur) {
    b->size += cur->size; b->next = cur->next; if (cur->next) cur->next->prev = b;
  }
  if (prev && (unsigned char*)prev + prev->size == (unsigned char*)b) {
    prev->size += b->size; prev->next = b->next; if (b->next) b->next->prev = prev;
  }
}

void* mp4web_det_malloc(size_t n) { return heap_alloc(&g_heap, n); }
void mp4web_det_free(void* p) { if (in_arena(&g_stacks, p)) heap_free(&g_stacks, p); else heap_free(&g_heap, p); }
void* mp4web_stack_alloc(size_t n) { return heap_alloc(&g_stacks, n); }
void mp4web_stack_free(void* p) { heap_free(&g_stacks, p); }
void mp4web_stack_range(uintptr_t* b, uintptr_t* e) { *b = (uintptr_t)g_stackArena; *e = (uintptr_t)(g_stackArena + STACK_BYTES); }

void* mp4web_det_calloc(size_t a, size_t b) {
  void* p = mp4web_det_malloc(a * b);
  if (p) memset(p, 0, a * b);
  return p;
}

void* mp4web_det_realloc(void* p, size_t n) {
  if (!p) return mp4web_det_malloc(n);
  Block* b = (Block*)p - 1;
  size_t have = b->size - sizeof(Block);
  if (n <= have) return p;
  void* q = mp4web_det_malloc(n);
  if (q) { memcpy(q, p, have); mp4web_det_free(p); }
  return q;
}

double mp4web_det_heap_high_water(void) { return (double)g_heap.highWater; }
double mp4web_det_stack_high_water(void) { return (double)g_stacks.highWater; }
double mp4web_det_heap_in_use(void) { return (double)g_heap.inUse; }
double mp4web_det_heap_fallbacks(void) { return (double)(g_heap.fallbacks + g_stacks.fallbacks); }

// Test aid: the det-heap block holding address `a` -> out[0] = its user pointer, out[1] = its size
// (0, 0 when `a` is outside the arena). Walks the boundary tags from the start.
#include <emscripten.h>
EMSCRIPTEN_KEEPALIVE void mp4web_det_owner(uintptr_t a, uint32_t* out) {
  out[0] = out[1] = 0;
  Heap* h = &g_heap;
  if (!h->init || a < (uintptr_t)h->arena || a >= (uintptr_t)(h->arena + h->bytes)) return;
  unsigned char* p = h->arena;
  while (p < h->arena + h->bytes) {
    Block* b = (Block*)p;
    if (!b->size) return;
    if (a < (uintptr_t)(p + b->size)) { out[0] = (uint32_t)(uintptr_t)(b + 1); out[1] = b->size | (b->used ? 0 : 0x80000000u); return; }
    p += b->size;
  }
}
