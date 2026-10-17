// gamecube/native/shim/det_alloc.h — force-included into the game's C sources (build.sh): their
// malloc family goes to the deterministic game heap (src/det_heap.c). See that file for why.
#ifndef MP4WEB_DET_ALLOC_H
#define MP4WEB_DET_ALLOC_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void* mp4web_det_malloc(size_t n);
void mp4web_det_free(void* p);
void* mp4web_det_calloc(size_t a, size_t b);
void* mp4web_det_realloc(void* p, size_t n);
#ifdef __cplusplus
}
#endif
#ifndef __cplusplus
#define malloc mp4web_det_malloc
#define free mp4web_det_free
#define calloc mp4web_det_calloc
#define realloc mp4web_det_realloc
#endif
#endif
