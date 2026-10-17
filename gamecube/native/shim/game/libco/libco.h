// libco's API (higan-emu/libco), implemented on Emscripten fibers (src/libco_fiber.c): the game's
// process scheduler (src/game/process.c) is cooperative coroutines, and wasm has no stack switching
// of its own, so each coroutine is an emscripten_fiber_t (Asyncify).
#ifndef LIBCO_H
#define LIBCO_H
#ifdef __cplusplus
extern "C" {
#endif
typedef void* cothread_t;
cothread_t co_active(void);
cothread_t co_derive(void* memory, unsigned int heapsize, void (*coentry)(void));
cothread_t co_create(unsigned int heapsize, void (*coentry)(void));
void co_delete(cothread_t cothread);
void co_switch(cothread_t cothread);
int co_serializable(void);
#ifdef __cplusplus
}
#endif
#endif
