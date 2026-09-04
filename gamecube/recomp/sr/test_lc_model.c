// test_lc_model.c — direct check of gekko_rt.h's REGION MODEL: the Gekko locked L1
// cache as ordinary memory, WPAR as a write-only sink.  Native C, no emscripten and
// no browser, so it runs in under a second and can gate every change to gk_tail().
//
//   cc -DSR_VERIFY               -I gamecube/recomp/sr gamecube/recomp/sr/test_lc_model.c -o /tmp/t && /tmp/t
//   cc -DSR_VERIFY -DSR_NO_LC_MODEL -I gamecube/recomp/sr gamecube/recomp/sr/test_lc_model.c -o /tmp/tc && /tmp/tc
//
// The second build is the FALSIFICATION CONTROL ARM: it drops the locked-cache arm,
// so every locked-cache assertion inverts to the aliasing behaviour that existed
// before the model.  Both must pass -- the control arm passing on the *inverted*
// expectations is what proves the model is what changes the outcome, rather than the
// assertions being vacuous.  Same discipline as commit 0ae62db3's bctr control arm.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gekko_rt.h"

uint8_t *g_ram = 0;
uint32_t g_ram_size = 0;
uint32_t g_fault = 0;
uint8_t *g_staged = 0;
uint32_t g_unstaged = 0;
uint32_t *g_wlog = 0;
uint32_t g_wlog_n = 0, g_wlog_cap = 0;

#define MEM1 0x01800000u
static int fails = 0;
#define CHECK(cond, ...) do { if (!(cond)) { printf("  FAIL: "); printf(__VA_ARGS__); \
    printf("\n"); fails++; } else { printf("  ok  : "); printf(__VA_ARGS__); printf("\n"); } } while (0)

static void reset(void) {
    memset(g_ram, 0xa5, MEM1 + GK_TAIL_SIZE);
    memset(g_staged, 0, MEM1 + GK_TAIL_SIZE);
    g_wlog_n = 0; g_unstaged = 0; g_fault = 0;
}

int main(void) {
    g_ram = malloc(MEM1 + GK_TAIL_SIZE);
    g_staged = malloc(MEM1 + GK_TAIL_SIZE);
    g_wlog_cap = 1 << 16;
    g_wlog = calloc(g_wlog_cap * 2, 4);
    g_ram_size = MEM1;

    printf("GK_L1_SIZE=%#x GK_WPAR_SIZE=%#x GK_TAIL_SIZE=%#x  GK_L1_MODELLED=%d\n",
           GK_L1_SIZE, GK_WPAR_SIZE, GK_TAIL_SIZE, GK_L1_MODELLED);

    // ---- 1. mapping ---------------------------------------------------------
    uint32_t p = 0xdeadbeef;
    int hit = gk_tail(0xE0000030u, 4, &p);
#if GK_L1_MODELLED
    CHECK(hit && p == MEM1 + 0x30, "0xE0000030 -> tail offset %#x (expected %#x)", p, MEM1 + 0x30);
#else
    CHECK(!hit, "control arm: 0xE0000030 is NOT in gk_tail (falls through to gk_phys)");
#endif
    hit = gk_tail(0xCC008000u, 4, &p);
    CHECK(hit && p == MEM1 + GK_L1_SIZE, "0xCC008000 -> tail offset %#x (expected %#x)",
          p, MEM1 + GK_L1_SIZE);
    hit = gk_tail(0x80001234u, 4, &p);
    CHECK(!hit, "MEM1 address is not in the tail");
    hit = gk_tail(0xE0040000u, 4, &p);
    CHECK(!hit, "0xE0040000 is PAST the 256 KB window (MMU.cpp:247-248 bound)");

    // ---- 2. a locked-cache store is REAL, LOGGED memory ----------------------
    reset();
    gk_w32(0xE0000030u, 0x11223344u);
    CHECK(g_fault == 0, "locked-cache store does not fault (g_fault=%#x)", g_fault);
#if GK_L1_MODELLED
    CHECK(g_ram[MEM1 + 0x30] == 0x11 && g_ram[MEM1 + 0x33] == 0x44,
          "locked-cache store landed in the tail, big-endian");
    CHECK(g_ram[0x30] == 0xa5, "MEM1 offset 0x30 is UNTOUCHED (no aliasing)");
    CHECK(g_wlog_n == 4, "locked-cache store logged %u change events (expected 4)", g_wlog_n);
    CHECK(g_wlog[0] == MEM1 + 0x30, "first event address %#x (expected tail %#x)",
          g_wlog[0], MEM1 + 0x30);
#else
    CHECK(g_ram[0x30] == 0x11, "control arm: the store ALIASED onto MEM1 offset 0x30");
    CHECK(g_wlog[0] == 0x30, "control arm: the event address is MEM1 %#x, not the tail",
          g_wlog[0]);
#endif

    // ---- 3. a WPAR store is a SINK: not logged, but marked staged ------------
    reset();
    gk_w32(0xCC008000u, 0x55667788u);
    CHECK(g_fault == 0, "WPAR store does not fault");
    CHECK(g_wlog_n == 0, "WPAR store logged %u events (expected 0 — MMIO, uncomparable)",
          g_wlog_n);
    CHECK(g_ram[0x8000] == 0xa5, "MEM1 offset 0x8000 is UNTOUCHED (the 0x812188c0 bug)");
    CHECK(g_staged[MEM1 + GK_L1_SIZE] == 1, "WPAR store marked its own bytes staged");
    CHECK(gk_r32(0xCC008000u) == 0x55667788u && g_unstaged == 0,
          "reading back what this invocation wrote to WPAR is legal");

    // ---- 4. an UNSTAGED locked-cache read FAULTS (the completeness check) ----
    reset();
    (void)gk_r32(0xE0000060u);
#if GK_L1_MODELLED
    CHECK(g_unstaged == ((MEM1 + 0x60) | 0x80000000u),
          "unstaged locked-cache read recorded at %#x (expected %#x)",
          g_unstaged, (MEM1 + 0x60) | 0x80000000u);
#else
    CHECK(g_unstaged == (0x60u | 0x80000000u),
          "control arm: the read aliased to MEM1 %#x", g_unstaged & 0x7fffffff);
#endif

    // ---- 5. a STAGED locked-cache read returns the staged bytes -------------
    reset();
    {
        uint32_t off =
#if GK_L1_MODELLED
            MEM1 + 0x60;
#else
            0x60;
#endif
        g_ram[off] = 0xde; g_ram[off+1] = 0xad; g_ram[off+2] = 0xbe; g_ram[off+3] = 0xef;
        for (int i = 0; i < 4; i++) g_staged[off + i] = 1;
        CHECK(gk_r32(0xE0000060u) == 0xdeadbeefu && g_unstaged == 0,
              "staged locked-cache read returns the captured value");
    }

    // ---- 6. dcbz on a locked-cache line does not zero guest low memory ------
    reset();
    for (int i = 0; i < 32; i++) { g_ram[MEM1 + i] = 0x77; g_ram[i] = 0x77; }
    gk_dcbz(0xE0000000u);
#if GK_L1_MODELLED
    CHECK(g_ram[MEM1] == 0 && g_ram[0] == 0x77,
          "dcbz zeroed the locked-cache line, not MEM1 offset 0");
#else
    CHECK(g_ram[0] == 0, "control arm: dcbz zeroed MEM1 offset 0 instead");
#endif

    printf(fails ? "\n%d CHECK(S) FAILED\n" : "\nall checks passed\n", fails);
    return fails ? 1 : 0;
}
