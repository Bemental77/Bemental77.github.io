/* lfb_hook.h — the RDRAM observers' side of glide's LAZY FRAMEBUFFER COPY
 * (src/glide2gl/src/Glide64/lazy_fb.c, where the whole design is described).
 *
 * A read_always title's frame is copied into RDRAM only when something can
 * see it. Until then the copy is PENDING: its GPU capture exists, its bytes
 * are not in RDRAM. Every path that can read or write RDRAM outside the guest
 * CPU's memory tables (DMA engines, HLE tasks) calls LFB_TOUCH(offset, length)
 * first; the CPU's own loads and stores reach lfb_touch through the handlers
 * installed on the 64 KB pages a pending copy covers (m64p_memory.c). A touch
 * that meets a pending copy writes that copy into RDRAM, exactly as the eager
 * copy would have written it, before the access proceeds. */
#ifndef M64P_LFB_HOOK_H
#define M64P_LFB_HOOK_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

extern int      lfb_active;       /* some copy is pending */
extern uint32_t lfb_lo, lfb_hi;   /* RDRAM offsets bounding every pending copy */

void lfb_touch(uint32_t off, uint32_t len);   /* make [off, off+len) current */
void lfb_materialize_all(void);
void lfb_drop_all(void);                      /* RDRAM is being replaced: forget the copies */

/* the CPU's memory tables (m64p_memory.c) */
void lfb_page_ref(unsigned page, int delta);  /* 64 KB page of RDRAM: protect while > 0 */
void lfb_pages_forget(void);                  /* the tables were rebuilt: nothing is installed */

#define LFB_TOUCH(a, n) do { \
      if (lfb_active) { \
         uint32_t lfb_a_ = (uint32_t)(a) & 0x7FFFFFu, lfb_n_ = (uint32_t)(n); \
         if (lfb_a_ < lfb_hi && lfb_a_ + lfb_n_ > lfb_lo) lfb_touch(lfb_a_, lfb_n_); \
      } } while (0)

/* the same, as an expression (the HLE's dram_* accessors) */
static inline int lfb_touch_e(uint32_t a, uint32_t n)
{
   if (lfb_active)
   {
      a &= 0x7FFFFFu;
      if (a < lfb_hi && a + n > lfb_lo) lfb_touch(a, n);
   }
   return 0;
}

#ifdef __cplusplus
}
#endif

#endif
