/* neil_rddirty.h — WHICH 4 KiB PAGES OF RDRAM WERE WRITTEN SINCE THE LAST RAW SAVE (2026-10-16)
 *
 * WHY. The frame skip (n64/N64Wasm/dist/core_worker.js) and the rollback ring take a raw
 * savestate (src/libretro/neil_rawstate.c) per field they may have to undo, and each one
 * copied all 8 MiB of RDRAM. MEASURED (the toaster arm: n64_wall_account --duty 6.2, SM64
 * solo): a snapshot cost 8.8-9.5 ms, 13-17 a second; savestates_save_m64p was 7.9% of the
 * core worker. A field writes a small part of RDRAM, so the fast save (into a ring buffer
 * this instance wrote before) copies only the pages written since that buffer's own save,
 * the way it already did for angrylion's hidden plane (neil_hid_ep). The PS1 core did the
 * same (ps1 7c6f905, urdirty.[ch]) and its save went 6x cheaper.
 *
 * HOW. EVERY path that writes RDRAM marks the pages it writes: the interpreter's
 * write_rdram_dram, the JIT's native stores (n64/bementalJIT/mips_emit.js rdMarkBytes),
 * the SP / SI / PI DMA engines, the RSP (HLE audio lists, cxd4's DMA), the RDP plugins
 * (glide's frame-buffer copies and fills, angrylion's pixel writes), cheats, the RDRAM size
 * hack — and power-on and every state load mark everything. A missed writer would be a
 * snapshot that silently restores a stale page, so ?rdtrack=check (neil_state_set_rdtrack(1))
 * compares every page the fast save skipped against live RDRAM, repairs it and counts it
 * (neil_state_rdtrack_stat(1)): the rig's gate is 0 there.
 *
 * WHERE THE MARKS LIVE — AND WHY NOT IN A NEW STATIC. A new static moves the core's static
 * data, and the JIT's shipped span corpora (dist/jit/) are keyed by those host addresses
 * (bd3d7a9: a 2 KiB static rejected every corpus). So the 2048 mark bytes live in an unused
 * stretch of a table that already exists: invalid_code[] (cached_interp.c, 1 byte per 4 KiB
 * VIRTUAL page) at indices 0x80800-0x80FFF — the KSEG0 view of physical 8-16 MiB, where the
 * N64 has nothing (m64p_memory.c maps 0x8080-0x83EF to the `nothing` handlers, which never
 * reach CHECK_MEMORY), so no guest code can ever be compiled or invalidated there. The JIT
 * finds the bytes from the invalid_code address it already has (no new param). Everything
 * that rewrites invalid_code wholesale writes 1s (memset / init_blocks), which here reads
 * "dirty" — conservative, never a miss. 1 = written since the last fold, 0 = clean.
 * Physical offsets are taken & 0xFFFFFF and the page & 0x7FF, so an offset past 8 MiB marks
 * some page instead of none. */
#ifndef NEIL_RDDIRTY_H
#define NEIL_RDDIRTY_H

#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#define NEIL_RD_PAGES 2048u

#ifndef NEIL_RD_INLINE
/* EVERY FILE BUT neil_rawstate.c CALLS OUT. Under -flto a global's place in the static data
 * depends on which objects reference it: with the marks inline in the plugins (they reference
 * invalid_code), invalid_code moved from after g_rdram to after angrylion's rdram_hidden, every
 * static between moved 1 MiB, and every shipped JIT corpus was rejected ("param pcGlobal") —
 * measured on the first build of this change (wasm-ld -Map). Only objects that referenced
 * invalid_code before this change may reference it now; the call is inlined at link time anyway. */
void neil_rd_mark_x(uint32_t off, uint32_t len);
#define neil_rd_mark(off, len) neil_rd_mark_x((uint32_t)(off), (uint32_t)(len))
#define NEIL_RD_MARK1(off) neil_rd_mark_x((uint32_t)(off), 1u)
#define neil_rd_mark_all() neil_rd_mark_x(0u, 0x800000u)
#else
extern char invalid_code[0x100000];
#define NEIL_RD_DIRTY ((unsigned char*)invalid_code + 0x80800u)

/* bytes [off, off+len) of RDRAM (a physical offset) were, or are about to be, written */
static inline void neil_rd_mark(uint32_t off, uint32_t len)
{
   uint32_t p, e;
   if (!len)
      return;
   if (len >= 0x800000u)
   {
      memset(NEIL_RD_DIRTY, 1, NEIL_RD_PAGES);
      return;
   }
   off &= 0xFFFFFFu;
   p = off >> 12;
   e = (off + len - 1u) >> 12;
   for (; p <= e; p++)
      NEIL_RD_DIRTY[p & 0x7FFu] = 1;
}

/* one word / byte / halfword: a single page */
#define NEIL_RD_MARK1(off) (NEIL_RD_DIRTY[((uint32_t)(off) >> 12) & 0x7FFu] = 1)

/* [p, p+len) where p points into RDRAM whose first byte is `rdram` */
#define NEIL_RD_MARK_PTR(rdram, p, len) \
   neil_rd_mark((uint32_t)((const unsigned char*)(p) - (const unsigned char*)(rdram)), (uint32_t)(len))

static inline void neil_rd_mark_all(void)
{
   memset(NEIL_RD_DIRTY, 1, NEIL_RD_PAGES);
}
#endif /* NEIL_RD_INLINE */

#ifdef __cplusplus
}
#endif

#endif
