// libco on Emscripten fibers — see shim/game/libco/libco.h.
#include <emscripten/fiber.h>
#include <stdlib.h>
#include "libco/libco.h"
#ifdef __EMSCRIPTEN__
// stacks come from the deterministic stack arena (src/det_heap.c): fixed addresses, excluded from the state hash
void* mp4web_stack_alloc(size_t n);
void mp4web_stack_free(void* p);
#define STACK_ALLOC mp4web_stack_alloc
#define STACK_FREE mp4web_stack_free
#else
#define STACK_ALLOC malloc
#define STACK_FREE free
#endif

#define ASYNC_STACK (64 * 1024)
typedef struct Co { emscripten_fiber_t f; void (*entry)(void); void *cstack, *astack; } Co;
static Co s_main; static int s_init; static Co *s_cur;

static void co_init(void) {
  if (s_init) return;
  s_init = 1;
  s_main.astack = STACK_ALLOC(ASYNC_STACK);
  emscripten_fiber_init_from_current_context(&s_main.f, s_main.astack, ASYNC_STACK);
  s_cur = &s_main;
}
static void co_tramp(void *arg) { Co *c = (Co *)arg; c->entry(); abort(); /* a libco entry must never return */ }
cothread_t co_active(void) { co_init(); return s_cur; }
cothread_t co_create(unsigned int heapsize, void (*entry)(void)) {
  co_init();
  Co *c = (Co *)calloc(1, sizeof(Co));
  if (heapsize < 64 * 1024) heapsize = 64 * 1024;
  c->entry = entry; c->cstack = STACK_ALLOC(heapsize); c->astack = STACK_ALLOC(ASYNC_STACK);
  emscripten_fiber_init(&c->f, co_tramp, c, c->cstack, heapsize, c->astack, ASYNC_STACK);
  return c;
}
cothread_t co_derive(void *memory, unsigned int heapsize, void (*entry)(void)) { (void)memory; return co_create(heapsize, entry); }
void co_delete(cothread_t t) { Co *c = (Co *)t; if (!c || c == &s_main || c == s_cur) return; STACK_FREE(c->cstack); STACK_FREE(c->astack); free(c); }
void co_switch(cothread_t t) { co_init(); Co *from = s_cur, *to = (Co *)t; if (from == to) return; s_cur = to; emscripten_fiber_swap(&from->f, &to->f); }
int co_serializable(void) { return 0; }
