// gamecube/recomp/shims/src/gc_fiber_coro.c
// ---------------------------------------------------------------------------
// Stackful-coroutine implementation of the Hu cooperative scheduler's context
// switch primitives (gcsetjmp / gclongjmp), replacing src/game/jmp.c whose mwcc
// PPC `asm{}` bodies do not compile under clang — leaving gcsetjmp/gclongjmp as
// no-op host imports so gclongjmp never transfers control, and the scheduler
// (src/game/process.c) spins forever emitting 0 draws.
//
// WHY FIBERS (not plain setjmp/longjmp):
//   HuPrcCreate FABRICATES a brand-new context (process.c:81-83): gcsetjmp
//   snapshots the creator, then `jump.lr = func` / `jump.sp = base_sp` are stored so
//   a later gclongjmp "returns" into func on a FRESH stack. Starting a never-entered
//   function on a new stack is a stack SWITCH — impossible with plain setjmp/longjmp;
//   it is the definition of a stackful coroutine (Emscripten Asyncify fiber).
//
// KEY INVARIANT of the Hu scheduler (verified over all 4 gclongjmp sites,
// process.c:133,184,203,280): gclongjmp NEVER returns to its own caller — control
// always leaves via the jump and the matching resume point is a gcsetjmp elsewhere.
// The `break` after the scheduler's gclongjmp(&process->jump,1) (process.c:281) is
// dead in the original PPC. So a gclongjmp's C return value is used in exactly ONE
// place, and only after a build_wasm.sh bake makes it explicit (see below).
//
// THE MODEL:
//   gcsetjmp(&jb):  bind jb -> the currently running fiber; return 0 (the SAVE).
//                   Does NOT swap. process.c never needs gcsetjmp itself to yield a
//                   nonzero value on the same-frame resume: sites 132/202 wrap it as
//                   `if(!gcsetjmp(&jb)) gclongjmp(...)`, where the RESUME re-enters
//                   after the gclongjmp swap (below), falling out of the if — the
//                   gcsetjmp expression is not re-evaluated. Site 233 (scheduler)
//                   reads the value into `ret`, but its resume is delivered through
//                   the scheduler's own gclongjmp return (baked, see __gc note).
//   gclongjmp(&jb,status):  set g_pending_status=status; swap to jb's fiber.
//                   - jb FRESH (fabricated): enters the trampoline -> func on a new
//                     stack (the HuPrcCreate case).
//                   - jb SUSPENDED: resumes it exactly where its own gclongjmp swap
//                     suspended it; that gclongjmp then returns g_pending_status.
//
//   The single place a gclongjmp return is consumed is the scheduler dispatch
//   (process.c:280). build_wasm.sh bakes `gclongjmp(&process->jump, 1);` into
//   `ret = gclongjmp(&process->jump, 1);` so the status a process passes via its
//   gclongjmp(&processjmpbuf,status) (process.c:184 =2 terminate, :203 =1 sleep)
//   lands in `ret` and drives switch(ret) case 1/2 — reproducing the PPC double
//   return of `ret = gcsetjmp(&processjmpbuf)` EXACTLY.
//
//   HuPrcCreate writes jump.lr/jump.sp with RAW field stores (process.c:82-83), not
//   an init call, so gcsetjmp alone cannot observe `func`. build_wasm.sh bakes those
//   two lines + the preceding gcsetjmp into a single call:
//       __gc_fiber_fabricate(&process->jump, func, /*stack_size*/ stack_size);
// ---------------------------------------------------------------------------
#include <emscripten/fiber.h>
// NOTE: the recomp include path ($BUILD/include) ships decomp STUB <stdint.h> /
// <stdlib.h> that SHADOW emscripten's real ones (stdint stub lacks the fixed-width
// int32_t/uint32_t typedefs; stdlib stub lacks malloc/calloc). fiber.h's own
// `#include <stdint.h>` only needs size_t (from <stddef.h>, not shadowed), so it
// still compiles. But THIS file must NOT use the fixed-width types or rely on the
// stubbed <stdlib.h> for malloc — do it with plain 32-bit ints (wasm32: int/unsigned
// = 32-bit) and self-declared allocators. This is exactly the bug that left
// gc_fiber_coro.c as a silent compile-fail, so gcsetjmp/gclongjmp fell back to no-op
// host imports and the scheduler spun.
#include <stddef.h>                        // size_t (not shadowed)
extern void *malloc(size_t);
extern void *calloc(size_t, size_t);

#define GC_FIBER_ASYNCIFY_STACK  32768     // Asyncify (spill) stack per context
#define GC_FIBER_MAX             2048       // MP4 lives well under this

typedef struct gc_ctx {
    emscripten_fiber_t fiber;
    void (*entry)(void);        // process body (NULL for the root/scheduler ctx)
    void  *c_stack;             // owned wasm shadow stack (NULL for root)
    void  *asyncify_stack;      // owned Asyncify stack
    int    is_root;
} gc_ctx;

// jmp_buf* -> gc_ctx binding: a buffer names "the fiber whose gcsetjmp last saved
// into it" (or, for a fabricated process, the fresh fiber that will run func).
typedef struct gc_bind { void *key; gc_ctx *ctx; } gc_bind;
static gc_bind g_bind[GC_FIBER_MAX];
static int     g_bind_n = 0;

static gc_ctx *bind_lookup(void *key) {
    for (int i = 0; i < g_bind_n; i++)
        if (g_bind[i].key == key) return g_bind[i].ctx;
    return NULL;
}
static void bind_set(void *key, gc_ctx *c) {
    for (int i = 0; i < g_bind_n; i++)
        if (g_bind[i].key == key) { g_bind[i].ctx = c; return; }
    if (g_bind_n < GC_FIBER_MAX) { g_bind[g_bind_n].key = key;
                                   g_bind[g_bind_n].ctx = c; g_bind_n++; }
}

static gc_ctx  g_root;                 // the initial context (main -> HuPrcCall)
static int     g_root_inited = 0;
static gc_ctx *g_current = NULL;       // fiber running right now
static int g_pending_status = 0;   // status a resumed gclongjmp returns

// Deferred reap: a fiber that terminates (status 2 / body fell off the end) cannot
// free the stack it is standing on; park it here and free it on the next swap,
// when execution is provably off that stack.
extern void free(void *);
static gc_ctx *g_dead = NULL;
static void reap_dead(void) {
    if (g_dead && g_dead != g_current) {
        if (g_dead->c_stack) free(g_dead->c_stack);
        if (g_dead->asyncify_stack) free(g_dead->asyncify_stack);
        free(g_dead);
        g_dead = NULL;
    }
}

// --- Instrumentation (exported so the harness can PROVE process bodies ran) ------
// These are hard evidence the fiber scheduler is live: fabricate = #processes created,
// enter = #times a fresh process body actually STARTED on its own fiber stack,
// swap = total context switches. A no-op scheduler leaves enter == 0.
static int g_stat_fabricate = 0;
static int g_stat_enter = 0;
static int g_stat_swap = 0;
int __gc_fiber_stat_fabricate(void) { return g_stat_fabricate; }
int __gc_fiber_stat_enter(void)     { return g_stat_enter; }
int __gc_fiber_stat_swap(void)      { return g_stat_swap; }

static void ensure_root(void) {
    if (g_root_inited) return;
    g_root_inited = 1;
    g_root.is_root = 1;
    g_root.asyncify_stack = malloc(GC_FIBER_ASYNCIFY_STACK);
    // Bind the running wasm stack as a fiber we can swap away from and back to.
    emscripten_fiber_init_from_current_context(
        &g_root.fiber, g_root.asyncify_stack, GC_FIBER_ASYNCIFY_STACK);
    g_current = &g_root;
}

// Emscripten fiber entry is void(*)(void*); Hu process bodies are void(*)(void).
static void gc_fiber_trampoline(void *arg) {
    gc_ctx *c = (gc_ctx *)arg;
    g_stat_enter++;             // a fresh process body is about to START on its fiber
    c->entry();                 // Hu bodies are infinite while(1)+HuPrcVSleep loops
    // If a body ever falls off the end (most end via HuPrcEnd -> gclongjmp(&pjb,2),
    // which swaps away and never returns here), behave like terminate: hand status
    // 2 to the scheduler so HuPrcCall frees the heap (process.c:236). We swap to
    // root; the scheduler's baked `ret = gclongjmp(...)` then sees 2.
    g_pending_status = 2;
    gc_ctx *from = c;
    g_current = &g_root;
    g_dead = from;              // reaped on the next swap (we are still on its stack)
    emscripten_fiber_swap(&from->fiber, &g_root.fiber);
    __builtin_trap();           // never resumed
}

// ---- HuPrcCreate fabrication hook (replaces process.c:81-83 via perl bake) ----
// Registers a fresh, not-yet-entered fiber whose entry is `func`, on its own wasm
// shadow stack. The game's base_sp (process.c:80) is a GUEST-PPC sp with no meaning
// for the wasm shadow stack, so it is ignored; we size the c-stack from the game's
// requested stack (with a floor) since the compiled body's frame sizes are not 1:1
// with PPC frames.
void __gc_fiber_fabricate(void *jmpbuf, void (*func)(void), unsigned game_stack_size) {
    ensure_root();
    g_stat_fabricate++;
    gc_ctx *c = (gc_ctx *)calloc(1, sizeof(gc_ctx));
    c->entry = func;
    size_t cstk = game_stack_size < 65536u ? 65536u : (size_t)game_stack_size;
    c->c_stack        = malloc(cstk);
    c->asyncify_stack = malloc(GC_FIBER_ASYNCIFY_STACK);
    emscripten_fiber_init(&c->fiber, gc_fiber_trampoline, c,
                          c->c_stack, cstk,
                          c->asyncify_stack, GC_FIBER_ASYNCIFY_STACK);
    bind_set(jmpbuf, c);        // scheduler's gclongjmp(&process->jump,1) starts func
}

// ---- HuPrcKill retargeting (replaces process.c:277's raw `jump.lr = HuPrcEnd`) --
// The mwcc jump-buffer model kills a process by REWRITING its saved resume PC to
// HuPrcEnd, so the next dispatch "resumes" into the cleanup path. The fiber model
// binds by buffer ADDRESS, so a raw field write is invisible: the killed process
// resumed its BODY instead — a ZOMBIE ticking once per HuPrcCall forever (found as
// TWO live HuWinProc fibers after the modesel overlay switch: every window/choice
// processed twice per frame, so a one-frame UP pulse moved the dialog cursor up
// and then wrap-around back down). Rebind the buffer to a fresh fiber that enters
// `func` (HuPrcEnd needs only processcur, which the scheduler sets before the
// dispatch); the suspended body fiber is never resumable again, so free its stacks.
extern void free(void *);
void __gc_fiber_retarget(void *jmpbuf, void (*func)(void)) {
    ensure_root();
    gc_ctx *old = bind_lookup(jmpbuf);
    if (old && old != &g_root && old != g_current) {
        if (old->c_stack) free(old->c_stack);
        if (old->asyncify_stack) free(old->asyncify_stack);
        free(old);
    }
    gc_ctx *c = (gc_ctx *)calloc(1, sizeof(gc_ctx));
    c->entry = func;
    c->c_stack        = malloc(65536u);
    c->asyncify_stack = malloc(GC_FIBER_ASYNCIFY_STACK);
    emscripten_fiber_init(&c->fiber, gc_fiber_trampoline, c,
                          c->c_stack, 65536u,
                          c->asyncify_stack, GC_FIBER_ASYNCIFY_STACK);
    bind_set(jmpbuf, c);
}

// ---- gcsetjmp: SAVE only (bind buffer -> current fiber, return 0) ----------
int gcsetjmp(void *jmpbuf) {
    ensure_root();
    bind_set(jmpbuf, g_current);
    return 0;
}

// ---- gclongjmp: swap to the fiber bound to jmpbuf --------------------------
// Declared s32 in jmp.h (import type (i32,i32)->i32). On the transfer path it does
// not return to its caller; it returns g_pending_status ONLY when THIS fiber is
// itself later resumed (the value that resume passed) — consumed solely by the
// baked `ret = gclongjmp(&process->jump,1)` in the scheduler.
int gclongjmp(void *jmpbuf, int status) {
    ensure_root();
    gc_ctx *target = bind_lookup(jmpbuf);
    if (!target) __builtin_trap();  // no context bound for this buffer — bug

    gc_ctx *from = g_current;
    if (target == from) return status;  // longjmp to self: immediate return

    g_pending_status = status;
    if (status == 2 && !from->is_root) g_dead = from;  // terminating: reap after the swap
    g_current = target;
    g_stat_swap++;
    emscripten_fiber_swap(&from->fiber, &target->fiber);
    reap_dead();
    // Resumed later by a gclongjmp targeting `from`; deliver that resume's status.
    return g_pending_status;
}
