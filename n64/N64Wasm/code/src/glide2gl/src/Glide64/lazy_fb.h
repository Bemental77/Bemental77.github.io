/* lazy_fb.h — glide's lazy framebuffer copy (lazy_fb.c has the design). */
#ifndef GLIDE64_LAZY_FB_H
#define GLIDE64_LAZY_FB_H

#include <stdint.h>
#include "../../../mupen64plus-core/src/main/lfb_hook.h"

/* CopyFrameBuffer's scaled branch, at the end of a read_always display list:
 * 1 = the copy is queued (nothing to write now), 0 = make it eagerly. */
int  lfb_queue(const int32_t *sx, int nx, const int32_t *sy, int ny,
      uint32_t addr, int width, int x0, int y0, int bpp32, int read_alpha);
/* any other path that is about to write or read a colour image eagerly */
void lfb_eager(void);
/* set around the end-of-display-list CopyFrameBuffer of a read_always title */
extern int lfb_ref_call;

#endif
