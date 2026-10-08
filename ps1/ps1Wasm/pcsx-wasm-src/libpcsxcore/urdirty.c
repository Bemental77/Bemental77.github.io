/* urdirty.c — see urdirty.h (WRITE TRACKING FOR THE ROLLBACK RING). */
#include <stdlib.h>
#include <string.h>
#include "urdirty.h"

#define UR_INFO_WORDS (4 + 3 * UR_MAX_SPANS)
#define UR_BLOCK (UR_PAGES + 4096)

unsigned char *ur_dirty;
static uint32_t *ur_inf;
static uint32_t ur_gen0;
volatile uint32_t *ur_genp = &ur_gen0;
static uint32_t ur_scratch0[UR_SCRATCH_WORDS];
uint32_t *ur_scratch = ur_scratch0;

/* Before main: every writer may mark from the first instruction on. Page
 * aligned and a whole number of pages, so it shares no page with anything a
 * save compares. */
__attribute__((constructor)) static void ur_alloc(void) {
	void *b = NULL;
	if (posix_memalign(&b, 4096, UR_BLOCK) != 0 || !b) abort();
	memset(b, 0, UR_BLOCK);
	ur_dirty = (unsigned char *)b;
	ur_inf = (uint32_t *)(ur_dirty + UR_PAGES);
	ur_inf[0] = (uint32_t)(uintptr_t)ur_dirty;
	ur_inf[1] = UR_MAX_SPANS;
	ur_inf[2] = UR_BLOCK;
	ur_genp = &ur_inf[3];
	ur_scratch = &ur_inf[UR_INFO_WORDS];
}

void ur_mark_range(const void *p, size_t n) {
	uintptr_t a, e;
	if (!n) return;
	a = (uintptr_t)p >> UR_PAGE_SHIFT;
	e = ((uintptr_t)p + n - 1) >> UR_PAGE_SHIFT;
	if (e >= UR_PAGES) e = UR_PAGES - 1;
	for (; a <= e; a++) ur_dirty[a] = 1;
}

void ur_track(int id, const void *p, size_t n) {
	if (id < 0 || id >= UR_MAX_SPANS) return;
	ur_inf[4 + 3 * id] = (uint32_t)(uintptr_t)p;
	ur_inf[5 + 3 * id] = (uint32_t)((uintptr_t)p + n);
	ur_inf[6 + 3 * id] = p && n ? 1 : 0;
	ur_mark_range(p, n);
}

void ur_track_off(int id) {
	if (id < 0 || id >= UR_MAX_SPANS) return;
	ur_inf[6 + 3 * id] = 0;
}

void ur_mark_span(int id) {
	if (id < 0 || id >= UR_MAX_SPANS || !ur_inf[6 + 3 * id]) return;
	ur_mark_range((void *)(uintptr_t)ur_inf[4 + 3 * id], ur_inf[5 + 3 * id] - ur_inf[4 + 3 * id]);
}

void ur_mark_all(void) {
	int i;
	for (i = 0; i < UR_MAX_SPANS; i++) ur_mark_span(i);
}

/* exported: the info block (layout in urdirty.h) */
uint32_t *ur_info(void) { return ur_inf; }
