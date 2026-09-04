// sr_host_os.c — host implementation of SAB's guest-OS context-switch boundary.
//
// Read sr_host_os.h first; it states the problem and why the cut is at SelectThread.
//
// FIDELITY RULE FOLLOWED THROUGHOUT: every routine here is a register-for-register
// transcription of the SHIPPED bytes (quoted inline), not of the DOLSDK C.  That is
// what makes the differential in verify_ctxsw.mjs meaningful: the translated
// function and this one are supposed to leave IDENTICAL GekkoState and IDENTICAL
// MEM1 on every path that returns, and any divergence is a bug in here.
#include <stdint.h>
#include <string.h>
#include <pthread.h>
#include <errno.h>
#include <time.h>
#include <emscripten.h>
#include "gekko_rt.h"
#include "sr_host_os.h"

int sr_dispatch(uint32_t addr, GekkoState *st);
GekkoState *sr_state(void);
extern int (*sr_host_hook)(GekkoState *, uint32_t);

// ------------------------------------------------------------------ state
static int      g_mode = SR_OS_OFF;
static uint32_t g_msr  = 0x00009032u;   // EE|FP|ME|IR|DR — the enabled-interrupt MSR
static uint32_t g_park_ms = 4000;       // watchdog: a hand-off that never comes back

#define SR_MAX_THREADS 16
typedef struct {
    int             used, bound, started, pending_start, exited;
    uint32_t        guest_thread;
    int             handoff_from;
    int             token;
    pthread_t       tid;
    pthread_cond_t  cv;
} SrHT;
static SrHT g_ht[SR_MAX_THREADS];
static int  g_nht = 0;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static _Thread_local int g_self = -1;

// ------------------------------------------------------------------ trace
#define SR_TRACE_CAP 4096
static uint32_t g_trace[SR_TRACE_CAP * 3];
static uint32_t g_trace_n = 0;
static void tr(uint32_t ev, uint32_t a, uint32_t b) {
    pthread_mutex_lock(&g_lock);
    if (g_trace_n < SR_TRACE_CAP) {
        g_trace[g_trace_n * 3 + 0] = ev;
        g_trace[g_trace_n * 3 + 1] = a;
        g_trace[g_trace_n * 3 + 2] = b;
        g_trace_n++;
    }
    pthread_mutex_unlock(&g_lock);
}
static void fault(uint32_t code, uint32_t detail) {
    if (!g_fault) g_fault = code | (detail & 0x0000FFFFu);
}

// ------------------------------------------------------------- the snapshot
// The switch is the one path that cannot be compared by "run it and diff the exit
// state", because on the real machine SelectThread never returns from it.  So both
// builds freeze the machine at the SAME instant -- the moment OSLoadContext has
// finished loading the next thread's registers and is about to rfi -- and the
// harness diffs THOSE.  TRACE takes it from the TRANSLATED SelectThread; HLE takes
// it from host_select_thread.  A byte-identical pair is the evidence that the
// transcription in this file is the shipped function.
static GekkoState g_snap;
static uint32_t   g_snap_hash, g_snap_valid;
static void snapshot(GekkoState *st) {
    g_snap = *st;
    uint32_t h = 2166136261u;                       // FNV-1a over MEM1
    for (uint32_t i = 0; i < g_ram_size; i++) { h ^= g_ram[i]; h *= 16777619u; }
    g_snap_hash = h; g_snap_valid = 1;
}

// --------------------------------------------------------- park / hand-off
static void ht_post(int slot) {
    pthread_mutex_lock(&g_lock);
    g_ht[slot].token = 1;
    pthread_cond_signal(&g_ht[slot].cv);
    pthread_mutex_unlock(&g_lock);
}
// -> 0 woken, -1 watchdog.  A timeout means the hand-off graph deadlocked; it is
// reported as a fault rather than hanging the harness, because a hung Node run
// carries no information at all.
static int ht_park(int slot) {
    struct timespec ts;
    int rc = 0;
    clock_gettime(CLOCK_REALTIME, &ts);
    ts.tv_sec  += (time_t)(g_park_ms / 1000u);
    ts.tv_nsec += (long)((g_park_ms % 1000u) * 1000000u);
    if (ts.tv_nsec >= 1000000000L) { ts.tv_nsec -= 1000000000L; ts.tv_sec++; }
    pthread_mutex_lock(&g_lock);
    while (!g_ht[slot].token) {
        rc = pthread_cond_timedwait(&g_ht[slot].cv, &g_lock, &ts);
        if (rc == ETIMEDOUT) { pthread_mutex_unlock(&g_lock); return -1; }
    }
    g_ht[slot].token = 0;
    pthread_mutex_unlock(&g_lock);
    return 0;
}

// One host thread per guest thread.  Bound lazily, on the first switch INTO a
// guest thread; slot 0 is whoever called sr_os_init (the harness / the emulator's
// own worker), which is the guest thread that is already running.
static int slot_for(uint32_t guest_thread) {
    for (int i = 0; i < g_nht; i++)
        if (g_ht[i].bound && g_ht[i].guest_thread == guest_thread) return i;
    for (int i = 0; i < g_nht; i++)
        if (g_ht[i].used && !g_ht[i].bound) {
            g_ht[i].bound = 1; g_ht[i].guest_thread = guest_thread; return i;
        }
    return -1;
}

static void *ht_main(void *p) {
    int idx = (int)(intptr_t)p;
    g_self = idx;
    for (;;) {
        if (ht_park(idx) != 0) return 0;          // watchdog / shutdown
        if (!g_ht[idx].used) return 0;
        if (g_ht[idx].pending_start) {
            GekkoState *st = sr_state();
            g_ht[idx].pending_start = 0;
            tr(SR_EV_THREAD_ENTRY, (uint32_t)idx, st->pc);
            if (!sr_dispatch(st->pc, st)) fault(SR_F_NOT_DISPATCH, st->pc);
            // The guest entry RETURNED.  On hardware a thread function returns into
            // OSExitThread, which switches away and never comes back; if we get here
            // the guest never did that, so nothing will ever re-post the thread that
            // handed control to us.  Report it and give that thread the CPU back
            // rather than deadlocking.
            tr(SR_EV_THREAD_EXIT, (uint32_t)idx, g_ht[idx].guest_thread);
            g_ht[idx].exited = 1;
            fault(SR_F_FELL_OFF, g_ht[idx].guest_thread);
            if (g_ht[idx].handoff_from >= 0) ht_post(g_ht[idx].handoff_from);
        }
    }
}

// ------------------------------------------------------- guest struct access
static uint32_t sda(GekkoState *st, int32_t off) { return st->gpr[13] + (uint32_t)off; }
static uint32_t cntlzw(uint32_t v) { int n = 0; while (n < 32 && !(v & 0x80000000u)) { v <<= 1; n++; } return (uint32_t)n; }

// ----------------------------------------------- the two context primitives
// These are internal helpers under SR_OS_HLE (SelectThread calls them directly),
// and the guest-callable bodies under SR_OS_TRACE.

// OSSaveContext, 0x800e563c, 128 B — DOLSDK OSContext.c:240-275.  Shipped bytes:
//   bda30034 stmw r13,0x34(r3) | 7c11e2a6 mfspr r0,GQR1 | 900301a8 stw r0,0x1a8(r3)
//   ... 7c000026 mfcr | 90030080 | 7c0802a6 mflr | 90030084 | 90030198 (srr0=lr)
//   7c0000a6 mfmsr | 9003019c | 7c0902a6 mfctr | 90030088 | 7c0102a6 mfxer | 9003008c
//   90230004 stw r1 | 90430008 stw r2 | 38000001 li r0,1 | 9003000c stw r0,gpr[3]
//   38600000 li r3,0 | 4e800020 blr
static void ctx_save(GekkoState *st, uint32_t ctx) {
    for (int r = 13; r < 32; r++) gk_w32(ctx + OSCTX_GPR(r), st->gpr[r]);
    for (int q = 1; q < 8; q++)   gk_w32(ctx + OSCTX_GQR(q), st->gqr[q]);
    gk_w32(ctx + OSCTX_CR,   st->cr);
    gk_w32(ctx + OSCTX_LR,   st->lr);
    gk_w32(ctx + OSCTX_SRR0, st->lr);          // srr0 = the return address of the bl
    gk_w32(ctx + OSCTX_SRR1, g_msr);
    gk_w32(ctx + OSCTX_CTR,  st->ctr);
    gk_w32(ctx + OSCTX_XER,  st->xer);
    gk_w32(ctx + OSCTX_GPR(1), st->gpr[1]);
    gk_w32(ctx + OSCTX_GPR(2), st->gpr[2]);
    gk_w32(ctx + OSCTX_GPR(3), 1u);            // the value the RESUMED path returns
    st->gpr[0] = 1u;                           // li r0,1 is still live on return
    st->gpr[3] = 0u;                           // the value the SAVING path returns
}

// OSLoadContext, 0x800e56bc, 216 B — DOLSDK OSContext.c:281-350.  This is the
// register half only; the control transfer (rfi) is the caller's business.
// Shipped bytes carry the RAS fixup verbatim:
//   3c80800e lis r4,0x800e | 80c30198 lwz r6,srr0 | 38a478ac addi r5,r4,0x78ac
//   7c062840 cmplw r6,r5 | 41800018 blt _notInRAS | 380478bc addi r0,r4,0x78bc
//   7c060040 cmplw r6,r0 | 41810008 bgt _notInRAS | 90a30198 stw r5,srr0
// i.e. an srr0 anywhere inside OSDisableInterrupts is rewound to its first
// instruction — the Restartable Atomic Sequence.  0x800e78ac / 0x800e78bc are
// exactly this build's __RAS_OSDisableInterrupts_begin / _end.
static void ctx_load(GekkoState *st, uint32_t ctx) {
    uint32_t srr0 = gk_r32(ctx + OSCTX_SRR0);
    if (srr0 >= 0x800e78acu && srr0 <= 0x800e78bcu) {
        srr0 = 0x800e78acu;
        gk_w32(ctx + OSCTX_SRR0, srr0);
    }
    st->gpr[0] = gk_r32(ctx + OSCTX_GPR(0));
    st->gpr[1] = gk_r32(ctx + OSCTX_GPR(1));
    st->gpr[2] = gk_r32(ctx + OSCTX_GPR(2));
    uint32_t state = gk_r16(ctx + OSCTX_STATE);
    if (state & OSCTX_STATE_EXC) {
        gk_w16(ctx + OSCTX_STATE, (uint16_t)(state & ~OSCTX_STATE_EXC));
        for (int r = 5; r < 32; r++)  st->gpr[r] = gk_r32(ctx + OSCTX_GPR(r));
    } else {
        for (int r = 13; r < 32; r++) st->gpr[r] = gk_r32(ctx + OSCTX_GPR(r));
    }
    for (int q = 1; q < 8; q++) st->gqr[q] = gk_r32(ctx + OSCTX_GQR(q));
    st->cr  = gk_r32(ctx + OSCTX_CR);
    st->lr  = gk_r32(ctx + OSCTX_LR);
    st->ctr = gk_r32(ctx + OSCTX_CTR);
    st->xer = gk_r32(ctx + OSCTX_XER);
    g_msr   = (g_msr & gk_mask(17, 15)) & gk_mask(31, 29);   // clear EE, then RI
    st->gpr[4] = gk_r32(ctx + OSCTX_GPR(4));
    st->gpr[3] = gk_r32(ctx + OSCTX_GPR(3));
    st->pc     = srr0;
    g_msr      = gk_r32(ctx + OSCTX_SRR1);                   // rfi: MSR <- SRR1
}

// ---------------------------------------------------- the small OS primitives
// OSGetCurrentContext, 0x800e5630: 3c608000 / 806300d4 / 4e800020
static void os_get_current_context(GekkoState *st) {
    st->gpr[3] = gk_r32(SAB_OS_CURRENT_CONTEXT);
    tr(SR_EV_GET_CTX, st->gpr[3], 0);
}
// OSSetCurrentContext, 0x800e55d4, 92 B — DOLSDK OSContext.c:200-233.
static void os_set_current_context(GekkoState *st) {
    uint32_t ctx = st->gpr[3];
    st->gpr[4] = 0x80000000u;
    gk_w32(SAB_OS_CURRENT_CONTEXT, ctx);
    st->gpr[5] = gk_rotl32(ctx, 0) & gk_mask(2, 31);
    gk_w32(SAB_OS_CURRENT_PHYS_CTX, st->gpr[5]);
    st->gpr[5] = gk_r32(SAB_OS_FPU_CONTEXT);
    gk_cmp_signed(st, 0, (int32_t)st->gpr[5], (int32_t)ctx);
    if (gk_cr_bit(st, 2)) {                                  // fpuContext == context
        st->gpr[6] = gk_r32(ctx + OSCTX_SRR1) | 0x2000u;     // MSR_FP
        gk_w32(ctx + OSCTX_SRR1, st->gpr[6]);
        st->gpr[6] = g_msr | 0x2u;
        g_msr = st->gpr[6];
    } else {
        st->gpr[6] = gk_rotl32(gk_r32(ctx + OSCTX_SRR1), 0) & gk_mask(19, 17);
        gk_w32(ctx + OSCTX_SRR1, st->gpr[6]);
        st->gpr[6] = (gk_rotl32(g_msr, 0) & gk_mask(19, 17)) | 0x2u;
        g_msr = st->gpr[6];
    }
    tr(SR_EV_SET_CTX, ctx, g_msr);
}
// OSClearContext, 0x800e579c, 36 B — DOLSDK OSContext.c:390.
static void os_clear_context(GekkoState *st) {
    uint32_t ctx = st->gpr[3];
    st->gpr[5] = 0;
    gk_w16(ctx + OSCTX_MODE, 0);
    st->gpr[4] = 0x80000000u;
    gk_w16(ctx + OSCTX_STATE, 0);
    st->gpr[0] = gk_r32(SAB_OS_FPU_CONTEXT);
    gk_cmp_unsigned(st, 0, ctx, st->gpr[0]);
    if (gk_cr_bit(st, 2)) gk_w32(SAB_OS_FPU_CONTEXT, 0);
    tr(SR_EV_CLEAR_CTX, ctx, 0);
}
// OSDisableInterrupts, 0x800e78ac — DOLSDK OSInterrupt.c:81-91, byte-exact.
static void os_disable_interrupts(GekkoState *st) {
    st->gpr[3] = g_msr;
    st->gpr[4] = st->gpr[3] & gk_mask(17, 15);
    g_msr = st->gpr[4];
    st->gpr[3] = gk_rotl32(st->gpr[3], 17) & gk_mask(31, 31);
    tr(SR_EV_DISABLE_IRQ, st->gpr[3], g_msr);
}
// OSEnableInterrupts, 0x800e78c0 — OSInterrupt.c:93-102.
static void os_enable_interrupts(GekkoState *st) {
    st->gpr[3] = g_msr;
    st->gpr[4] = st->gpr[3] | 0x8000u;
    g_msr = st->gpr[4];
    st->gpr[3] = gk_rotl32(st->gpr[3], 17) & gk_mask(31, 31);
    tr(SR_EV_ENABLE_IRQ, st->gpr[3], g_msr);
}
// OSRestoreInterrupts, 0x800e78d4 — OSInterrupt.c:105-121.
static void os_restore_interrupts(GekkoState *st) {
    gk_cmp_signed(st, 0, (int32_t)st->gpr[3], 0);
    st->gpr[4] = g_msr;
    st->gpr[5] = gk_cr_bit(st, 2) ? (st->gpr[4] & gk_mask(17, 15))
                                  : (st->gpr[4] | 0x8000u);
    g_msr = st->gpr[5];
    st->gpr[4] = gk_rotl32(st->gpr[4], 17) & gk_mask(31, 31);
    tr(SR_EV_RESTORE_IRQ, st->gpr[3], g_msr);
}
// __TRK_get_MSR / __TRK_set_MSR — two instructions each, quoted in sr_host_os.h.
// `mfmsr r3; blr` and `mtmsr r3; blr`.  Nothing else in either body.
static void trk_get_msr(GekkoState *st) {
    st->gpr[3] = g_msr;
    tr(SR_EV_GET_MSR, g_msr, 0);
}
static void trk_set_msr(GekkoState *st) {
    g_msr = st->gpr[3];
    tr(SR_EV_SET_MSR, g_msr, 0);
}

// ============================================================================
//                      THE GUEST TIMEBASE AND DECREMENTER
//
// Read sr_host_os.h's "THE GUEST TIMEBASE" block first: it states the invariant,
// cites the Dolphin expressions this reproduces, and enumerates what is NOT
// modelled.  The short version, because it is the one thing in this file that can
// be broken by a one-line "fix": THE HOST CLOCK IS NOT AN INPUT HERE.  There is no
// emscripten_get_now, no clock_gettime, no time().  Guest time advances only when
// guest work is credited, so the guest's time:work ratio is exactly the hardware's
// at any host speed -- which is what CLAUDE.md gate #9 requires, and what a wall
// clock destroys in BOTH directions (slow host => guest deadlines fire early; fast
// host => guest time runs slow relative to guest work).
// ============================================================================
static int      g_clock_on         = 1;             // independent of g_mode: the
                                                    // clock's own control arm
static uint64_t g_tb_origin        = 0;             // ticks at g_gk_cycles == 0
// THE RETIRED-CYCLE COUNTER IS NOT DEFINED HERE ANY MORE.  It is `g_gk_cycles` in
// sr_driver.c, declared by gekko_rt.h, and the EMITTED GUEST CODE feeds it directly
// through gk_retire() (sr.py --retire) -- which is the whole point: a static
// recompiler's guest clock has to be driven from inside the translated bodies, the
// way Dolphin's is driven from inside its JIT blocks (Jit64/Jit.cpp:1003), not from
// a host event.  This file remains the ONLY INTERPRETER of that counter: sr_tb_read
// and sr_dec_read are the only expressions that turn cycles into time, so there is
// still exactly one clock even though there are now two writers of the counter
// (gk_retire from the guest, sr_tb_credit_cycles from a host-side driver such as
// sr_tb_retrace).
static uint32_t g_dec_start_value  = 0xFFFFFFFFu;   // SystemTimers.cpp:192-193
static uint64_t g_dec_start_cycles = 0;
static int      g_dec_armed        = 0;             // MSB clear at write => due
static uint64_t g_dec_due_cycles   = 0;
static uint32_t g_dec_exceptions   = 0;             // COUNTED, never DELIVERED
static uint32_t g_tb_calls         = 0;             // clock boundary crossings
static uint32_t g_tb_dry_reads     = 0;             // reads since the last credit
static uint32_t g_tb_stalls        = 0;

// Dolphin SystemTimers.cpp:213-218, transcribed:
//   FakeTBStartValue + (CoreTiming::GetTicks() - FakeTBStartTicks) / TIMER_RATIO
// The division is done on the RUNNING TOTAL, never per credit, so the sub-tick
// remainder is carried rather than truncated away 12 times a tick.
uint64_t sr_tb_read(void) { return g_tb_origin + g_gk_cycles / GK_TIMER_RATIO; }

// SystemTimers.cpp:199-204, transcribed: the same tick source counting DOWN from
// the value the guest last wrote.
uint32_t sr_dec_read(void) {
    return g_dec_start_value
         - (uint32_t)((g_gk_cycles - g_dec_start_cycles) / GK_TIMER_RATIO);
}

// SystemTimers.cpp:181-196 DecrementerSet.  A write with the MSB CLEAR arms an
// exception `v * TIMER_RATIO` cycles out; with it set, nothing is scheduled.
void sr_dec_write(uint32_t v) {
    g_dec_start_value  = v;
    g_dec_start_cycles = g_gk_cycles;
    g_dec_armed        = (v & 0x80000000u) == 0;
    g_dec_due_cycles   = g_gk_cycles + (uint64_t)v * GK_TIMER_RATIO;
}

// SystemTimers.cpp:139-143 DecrementerCallback -- MINUS the delivery.  Dolphin sets
// DEC = 0xFFFFFFFF and raises EXCEPTION_DECREMENTER; this runtime has no interrupt
// delivery at all (README §6 / CONTEXT_SWITCH.md §7.1), so the exception is COUNTED
// and the register is rolled over.  An alarm handler armed this way never runs, and
// sr_tb_dec_exceptions() is how you find out that is what happened.
static void dec_check(void) {
    if (!g_dec_armed || g_gk_cycles < g_dec_due_cycles) return;
    g_dec_armed        = 0;
    g_dec_exceptions++;
    g_dec_start_value  = 0xFFFFFFFFu;
    g_dec_start_cycles = g_dec_due_cycles;
    tr(SR_EV_DEC_EXC, (uint32_t)sr_tb_read(), g_dec_exceptions);
}

void sr_tb_credit_cycles(uint64_t cycles) {
    g_gk_cycles += cycles;
    g_tb_dry_reads = 0;
    dec_check();
}
void sr_tb_retrace(void) { sr_tb_credit_cycles(GK_CYCLES_PER_FIELD); }

void sr_tb_seed(uint64_t tb) { g_tb_origin = tb - g_gk_cycles / GK_TIMER_RATIO; }

// A read with no credit since the last SR_TB_STALL_MAX reads means the guest is
// spinning on a clock nothing is driving.  Fault LOUDLY rather than spin for ever
// -- and note that the alternative failure a wall clock offers here is not "no
// hang", it is "a hang you cannot see because the numbers look plausible".
//
// ⚠ THE TEST IS THE COUNTER, NOT THE CALL.  It used to be "reads since the last
// sr_tb_credit_cycles() call", which was right while the only driver was a host-side
// one -- and became WRONG the moment gk_retire() started feeding g_gk_cycles from
// inside the emitted bodies, because that path does not call this file at all.  A
// --retire build would have raised SR_F_TB_STALL on a guest whose clock was
// advancing perfectly.  Comparing the COUNTER catches every writer by construction,
// so the fault now means exactly one thing: the guest read the timebase
// SR_TB_STALL_MAX times and NOT ONE GUEST CYCLE RETIRED in between -- i.e. no driver
// is attached (a build without --retire and without a host-side retrace hook).
static uint64_t g_tb_last_cycles = 0;
static void tb_read_guard(uint32_t addr) {
    if (g_gk_cycles != g_tb_last_cycles) {     // the guest did work; not a stall
        g_tb_last_cycles = g_gk_cycles;
        g_tb_dry_reads = 0;
        return;
    }
    if (++g_tb_dry_reads >= SR_TB_STALL_MAX) {
        g_tb_dry_reads = 0;
        g_tb_stalls++;
        fault(SR_F_TB_STALL, addr & 0xFFFFu);
    }
}

// ---- the three shipped bodies, register for register -----------------------
// 0x800ecb48 OSGetTime: mftbu r3 / mftb r4 / mftbu r5 / cmpw r3,r5 / bne -16 / blr.
// r5 AND CR0 ARE ARCHITECTURALLY VISIBLE OUTPUTS of this function and the fixture
// differential scores both, so a host implementation that only set r3:r4 would fail
// against its own translation.  The loop can only EXIT with r3 == r5, so CR0 is the
// EQ result of comparing a snapshot with itself.
static void os_get_time(GekkoState *st) {
    tb_read_guard(SAB_OSGetTime);
    uint64_t t = sr_tb_read();
    st->gpr[3] = (uint32_t)(t >> 32);
    st->gpr[4] = (uint32_t)t;
    st->gpr[5] = st->gpr[3];
    gk_cmp_signed(st, 0, (int32_t)st->gpr[3], (int32_t)st->gpr[5]);
    tr(SR_EV_GET_TIME, st->gpr[3], st->gpr[4]);
    g_tb_calls++;
}
// 0x800ecb60 OSGetTick: mftb r3 / blr.  Nothing else in the body.
static void os_get_tick(GekkoState *st) {
    tb_read_guard(SAB_OSGetTick);
    st->gpr[3] = (uint32_t)sr_tb_read();
    tr(SR_EV_GET_TICK, st->gpr[3], 0);
    g_tb_calls++;
}
// 0x800e34bc PPCMtdec: mtspr 22,r3 / blr.  No GPR and no CR is written.
static void ppc_mtdec(GekkoState *st) {
    sr_dec_write(st->gpr[3]);
    tr(SR_EV_SET_DEC, st->gpr[3], (uint32_t)sr_tb_read());
    g_tb_calls++;
}

// ============================================================================
// SelectThread, 0x800ebd68, 512 B — the host boundary.
//
// A register-for-register transcription of the shipped function (labels named
// after the guest PC, so it reads next to /tmp/sr_ctxsw/sr_gen.c line for line).
// The ONLY two deviations are the two calls this whole exercise is about:
//   `bl OSSaveContext` at 0x800ebe68  -> ctx_save(), which returns 0 (never twice)
//   `bl OSLoadContext` at 0x800ebf48  -> hand the CPU to the next guest thread's
//                                        host thread and PARK.  When we are handed
//                                        it back, we resume at 0x800ebe6c with
//                                        gpr[3] = 1 — which is exactly where the
//                                        hardware's rfi lands, because srr0 is the
//                                        return address of that bl and gpr[3] was
//                                        stamped 1 by OSSaveContext.
// ============================================================================
static void host_select_thread(GekkoState *st) {
    uint32_t saved_ctx = 0;      // the guest thread whose continuation WE are, or 0

    st->gpr[0] = st->lr;
    st->gpr[4] = 0x802c0000u;
    gk_w32(st->gpr[1] + 4, st->gpr[0]);
    { uint32_t e = st->gpr[1] - 24u; gk_w32(e, st->gpr[1]); st->gpr[1] = e; }
    gk_w32(st->gpr[1] + 20, st->gpr[31]);
    st->gpr[31] = st->gpr[4] - 21576u;                       /* &RunQueue[0] */
    gk_w32(st->gpr[1] + 16, st->gpr[30]);
    st->gpr[30] = st->gpr[3];                                /* yield */

    tr(SR_EV_SELECT_ENTER, st->gpr[30], gk_r32(SAB_G_CURRENT_THREAD));

    st->gpr[0] = gk_r32(sda(st, SAB_SDA_RESCHEDULE));
    gk_cmp_signed(st, 0, (int32_t)st->gpr[0], 0);
    if (gk_cr_bit(st, 1) != 0) { st->gpr[3] = 0; goto L_epi; }   /* Reschedule > 0 */

    os_get_current_context(st);                              /* 0x800ebd9c */
    st->gpr[4] = 0x80000000u;
    st->gpr[6] = gk_r32(st->gpr[4] + 228);                   /* __gCurrentThread */
    gk_cmp_unsigned(st, 0, st->gpr[3], st->gpr[6]);
    st->gpr[3] = st->gpr[6];
    if (gk_cr_bit(st, 2) == 0) { st->gpr[3] = 0; goto L_epi; }

    gk_cmp_unsigned(st, 0, st->gpr[6], 0u);
    if (gk_cr_bit(st, 2) != 0) goto L_800ebe7c;              /* no current thread */

    st->gpr[0] = gk_r16(st->gpr[6] + OSTH_STATE);
    gk_cmp_unsigned(st, 0, st->gpr[0], 2u);
    if (gk_cr_bit(st, 2) == 0) goto L_800ebe5c;              /* state != RUNNING */

    gk_cmp_signed(st, 0, (int32_t)st->gpr[30], 0);
    if (gk_cr_bit(st, 2) == 0) goto L_800ebdf4;              /* yield != 0 */
    st->gpr[4] = gk_r32(sda(st, SAB_SDA_RUNQUEUEBITS));
    st->gpr[0] = gk_r32(st->gpr[6] + OSTH_PRIORITY);
    st->gpr[4] = cntlzw(st->gpr[4]);
    gk_cmp_signed(st, 0, (int32_t)st->gpr[0], (int32_t)st->gpr[4]);
    if (gk_cr_bit(st, 1) != 0) goto L_800ebdf4;
    st->gpr[3] = 0; goto L_epi;                              /* nothing better to run */

L_800ebdf4:                                                  /* state=READY, SetRun */
    st->gpr[0] = 1u;
    gk_w16(st->gpr[6] + OSTH_STATE, (uint16_t)st->gpr[0]);
    st->gpr[0] = gk_r32(st->gpr[6] + OSTH_PRIORITY);
    st->gpr[0] = gk_rotl32(st->gpr[0], 3) & gk_mask(0, 28);
    st->gpr[0] = st->gpr[31] + st->gpr[0];
    gk_w32(st->gpr[6] + OSTH_QUEUE, st->gpr[0]);
    st->gpr[5] = gk_r32(st->gpr[6] + OSTH_QUEUE);
    st->gpr[4] = gk_r32(st->gpr[5] + 4);                     /* queue->tail */
    gk_cmp_unsigned(st, 0, st->gpr[4], 0u);
    if (gk_cr_bit(st, 2) != 0) gk_w32(st->gpr[5] + 0, st->gpr[6]);
    else                       gk_w32(st->gpr[4] + OSTH_LINK_NEXT, st->gpr[6]);
    gk_w32(st->gpr[6] + OSTH_LINK_PREV, st->gpr[4]);
    st->gpr[0] = 0u;
    st->gpr[4] = 1u;
    gk_w32(st->gpr[6] + OSTH_LINK_NEXT, st->gpr[0]);
    st->gpr[5] = gk_r32(st->gpr[6] + OSTH_QUEUE);
    gk_w32(st->gpr[5] + 4, st->gpr[6]);
    st->gpr[0] = gk_r32(st->gpr[6] + OSTH_PRIORITY);
    st->gpr[5] = gk_r32(sda(st, SAB_SDA_RUNQUEUEBITS));
    st->gpr[0] = 31u - st->gpr[0];
    { uint32_t sh = st->gpr[0] & 63; st->gpr[0] = (sh > 31) ? 0u : (st->gpr[4] << sh); }
    st->gpr[0] = st->gpr[5] | st->gpr[0];
    gk_w32(sda(st, SAB_SDA_RUNQUEUEBITS), st->gpr[0]);
    gk_w32(sda(st, SAB_SDA_RUNQUEUEHINT), st->gpr[4]);

L_800ebe5c:
    st->gpr[0] = gk_r16(st->gpr[6] + OSCTX_STATE);
    st->gpr[0] = gk_rotl32(st->gpr[0], 0) & gk_mask(30, 30);
    gk_rc(st, st->gpr[0]);
    if (gk_cr_bit(st, 2) == 0) goto L_800ebe7c;              /* context is an EXC frame */

    // ---- 0x800ebe68  bl OSSaveContext ------------------------------------
    st->lr = 0x800ebe6cu;
    saved_ctx = st->gpr[6];
    ctx_save(st, saved_ctx);
    tr(SR_EV_SELECT_SAVE, saved_ctx, gk_r32(saved_ctx + OSCTX_SRR0));
L_800ebe6c:                                                  /* == srr0 */
    gk_cmp_unsigned(st, 0, st->gpr[3], 0u);
    if (gk_cr_bit(st, 2) == 0) { st->gpr[3] = 0; goto L_epi; }   /* the RESUMED path */

L_800ebe7c:
    st->gpr[0] = gk_r32(sda(st, SAB_SDA_RUNQUEUEBITS));
    st->gpr[4] = 0u;
    st->gpr[3] = 0x80000000u;
    gk_cmp_unsigned(st, 0, st->gpr[0], 0u);
    gk_w32(st->gpr[3] + 228, st->gpr[4]);                    /* __gCurrentThread = 0 */
    if (gk_cr_bit(st, 2) == 0) goto L_800ebec4;
    // The idle path.  On hardware the spin at 0x800ebea0 is broken by an external
    // interrupt whose handler calls OSWakeupThread.  There is no interrupt delivery
    // in this runtime (docs/static-recomp-sab/README.md §8.3 item 1), so the spin
    // could never terminate: refuse it by name instead of hanging.
    st->gpr[3] = st->gpr[31] + 1824u;
    os_set_current_context(st);
    fault(SR_F_IDLE_NO_IRQ, 0);
    st->gpr[3] = 0; goto L_epi;

L_800ebec4:
    st->gpr[3] = 0u;
    gk_w32(sda(st, SAB_SDA_RUNQUEUEHINT), st->gpr[3]);
    st->gpr[0] = gk_r32(sda(st, SAB_SDA_RUNQUEUEBITS));
    st->gpr[7] = cntlzw(st->gpr[0]);
    st->gpr[0] = gk_rotl32(st->gpr[7], 3) & gk_mask(0, 28);
    st->gpr[4] = st->gpr[31] + st->gpr[0];                   /* &RunQueue[prio] */
    st->gpr[5] = gk_r32(st->gpr[4] + 0);                     /* nextThread */
    st->gpr[6] = gk_r32(st->gpr[5] + OSTH_LINK_NEXT);
    st->gpr[31] = st->gpr[5];
    gk_cmp_unsigned(st, 0, st->gpr[6], 0u);
    if (gk_cr_bit(st, 2) != 0) gk_w32(st->gpr[4] + 4, st->gpr[3]);
    else                       gk_w32(st->gpr[6] + OSTH_LINK_PREV, st->gpr[3]);
    gk_w32(st->gpr[4] + 0, st->gpr[6]);
    st->gpr[0] = gk_r32(st->gpr[4] + 0);
    gk_cmp_unsigned(st, 0, st->gpr[0], 0u);
    if (gk_cr_bit(st, 2) != 0) {
        st->gpr[0] = 31u - st->gpr[7];
        st->gpr[4] = gk_r32(sda(st, SAB_SDA_RUNQUEUEBITS));
        st->gpr[3] = 1u;
        { uint32_t sh = st->gpr[0] & 63; st->gpr[0] = (sh > 31) ? 0u : (st->gpr[3] << sh); }
        st->gpr[0] = st->gpr[4] & ~st->gpr[0];
        gk_w32(sda(st, SAB_SDA_RUNQUEUEBITS), st->gpr[0]);
    }
    st->gpr[0] = 0u;
    gk_w32(st->gpr[31] + OSTH_QUEUE, st->gpr[0]);
    st->gpr[0] = 2u;
    st->gpr[4] = 0x80000000u;
    gk_w16(st->gpr[31] + OSTH_STATE, (uint16_t)st->gpr[0]);
    st->gpr[3] = st->gpr[31];
    gk_w32(st->gpr[4] + 228, st->gpr[31]);                   /* __gCurrentThread = next */
    st->lr = 0x800ebf44u;
    os_set_current_context(st);
    st->gpr[3] = st->gpr[31];
    st->lr = 0x800ebf4cu;

    // ---- 0x800ebf48  bl OSLoadContext — THE SWITCH -----------------------
    {
        const uint32_t next = st->gpr[31];
        const int self = g_self;
        int to;

        // Re-selected ourselves: hardware still does OSLoadContext + rfi, and srr0
        // is still 0x800ebe6c with gpr[3] == 1, so it still returns NULL.
        if (next == saved_ctx) { ctx_load(st, next); goto L_800ebe6c; }

        to = slot_for(next);
        if (to < 0) { fault(SR_F_NO_HOST_THREAD, next & 0xFFFFu); st->gpr[3] = 0; goto L_epi; }

        ctx_load(st, next);                          /* next's registers become live */
        snapshot(st);                                /* == the rfi instant */
        g_ht[to].handoff_from = self;
        if (!g_ht[to].started) {
            g_ht[to].started = 1;
            g_ht[to].pending_start = 1;
            tr(SR_EV_START_THREAD, next, st->pc);
        }
        tr(SR_EV_HANDOFF, saved_ctx, next);
        ht_post(to);

        // No continuation was saved (thread is MORIBUND / an EXC frame): hardware
        // simply abandons this stack.  A wasm host thread cannot unwind its own
        // guest frames without an exception, so it parks here for good.  Documented
        // in CONTEXT_SWITCH.md §7 as the one leak in this design.
        if (!saved_ctx) { ht_park(self); fault(SR_F_NO_CONT, next & 0xFFFFu); st->gpr[3] = 0; goto L_epi; }

        if (ht_park(self) != 0) {                    /* ---- parked ---- */
            fault(SR_F_PARK_TIMEOUT, saved_ctx & 0xFFFFu);
            st->gpr[3] = 0; goto L_epi;
        }
        if (g_fault) { st->gpr[3] = 0; goto L_epi; }
        // ---- resumed.  The hardware got here by rfi to srr0 == 0x800ebe6c with
        // gpr[3] == 1.  Reproduce exactly that: restore our own registers out of
        // our own OSContext and re-enter at L_800ebe6c.
        ctx_load(st, saved_ctx);
        tr(SR_EV_RESUMED, saved_ctx, (uint32_t)self);
        goto L_800ebe6c;
    }

L_epi:
    st->gpr[0]  = gk_r32(st->gpr[1] + 28);
    st->gpr[31] = gk_r32(st->gpr[1] + 20);
    st->gpr[30] = gk_r32(st->gpr[1] + 16);
    st->lr      = st->gpr[0];
    st->gpr[1]  = st->gpr[1] + 24u;
    tr(SR_EV_SELECT_RETURN, st->gpr[3], gk_r32(SAB_G_CURRENT_THREAD));
}

// ============================================================================
int sr_host_call(GekkoState *st, uint32_t addr) {
    if (g_mode == SR_OS_OFF) return 0;
    // THE MSR FAMILY.  Answered in every mode that is not OFF, because it is the
    // whole of SR_OS_IRQ and a strict subset of what HLE/TRACE already needed.
    switch (addr) {
    case SAB_OSDisableInterrupts:  os_disable_interrupts(st);   return 1;
    case SAB_OSEnableInterrupts:   os_enable_interrupts(st);    return 1;
    case SAB_OSRestoreInterrupts:  os_restore_interrupts(st);   return 1;
    case SAB_TRK_get_MSR_A:
    case SAB_TRK_get_MSR_B:        trk_get_msr(st);             return 1;
    case SAB_TRK_set_MSR_A:
    case SAB_TRK_set_MSR_B:        trk_set_msr(st);             return 1;
    }
    // THE CLOCK.  Answered in every non-OFF mode for the same reason the MSR family
    // is -- it adds no threading and no mode of its own -- but behind its OWN switch,
    // so `sr_tb_enable(0)` is a control arm for THIS boundary alone, on one binary,
    // without also disabling the MSR boundary the way sr_os_mode(0) does.
    if (g_clock_on) {
        switch (addr) {
        case SAB_OSGetTime:        os_get_time(st);             return 1;
        case SAB_OSGetTick:        os_get_tick(st);             return 1;
        case SAB_PPCMtdec:         ppc_mtdec(st);               return 1;
        }
    }
    // Everything below is CONTEXT, not interrupts.  SR_OS_IRQ deliberately does not
    // answer for it: an unimplemented boundary must stay an explicit fault rather
    // than become a silently-wrong body.  (CONTEXT_SWITCH.md §7.)
    if (g_mode == SR_OS_IRQ) return 0;
    switch (addr) {
    case SAB_OSSetCurrentContext:  os_set_current_context(st);  return 1;
    case SAB_OSGetCurrentContext:  os_get_current_context(st);  return 1;
    case SAB_OSClearContext:       os_clear_context(st);        return 1;

    case SAB_OSSaveContext:
        if (g_mode == SR_OS_TRACE) {
            ctx_save(st, st->gpr[3]);
            tr(SR_EV_SAVECTX, st->gpr[3], gk_r32(st->gpr[3] + OSCTX_SRR0));
            return 1;
        }
        fault(SR_F_SAVECTX_HLE, 0);                 // unreachable under HLE
        return 1;

    case SAB_OSLoadContext:
        if (g_mode == SR_OS_TRACE) {
            // The oracle stop: perform the register half, record the rfi target and
            // RETURN.  The translated tail then runs `mr r3,r31` + the epilogue, so
            // the harness must compare state at the trace point, not at the return.
            ctx_load(st, st->gpr[3]);
            snapshot(st);                            /* == the rfi instant */
            tr(SR_EV_LOADCTX, st->gpr[3], st->pc);
            return 1;
        }
        fault(SR_F_LOADCTX_EXC, addr & 0xFFFFu);    // exception-return path: unbuilt
        return 1;

    case SAB_SelectThread:
        if (g_mode == SR_OS_HLE) { host_select_thread(st); return 1; }
        return 0;                                   // TRACE: let the translation run
    }
    return 0;
}

// ------------------------------------------------------------------ exports
EMSCRIPTEN_KEEPALIVE int sr_os_init(int nthreads) {
    if (g_nht) return g_nht;
    if (nthreads < 2) nthreads = 2;
    if (nthreads > SR_MAX_THREADS) nthreads = SR_MAX_THREADS;
    for (int i = 0; i < nthreads; i++) {
        pthread_cond_init(&g_ht[i].cv, 0);
        g_ht[i].used = 1; g_ht[i].handoff_from = -1;
    }
    g_nht = nthreads;
    g_self = 0;                                    // slot 0 = the calling thread
    // Every host thread is created HERE, before anything can block.  Creating one
    // later, from a thread that is already parked, would need the main thread to
    // spawn the Worker while the main thread is itself blocked.
    for (int i = 1; i < nthreads; i++)
        if (pthread_create(&g_ht[i].tid, 0, ht_main, (void *)(intptr_t)i) != 0) {
            g_ht[i].used = 0; g_nht = i; break;
        }
    sr_host_hook = sr_host_call;
    return g_nht;
}
// SR_OS_IRQ's init.  It creates NO host thread and calls nothing from <pthread.h>,
// so a build that wants only the MSR boundary needs neither -pthread nor a thread
// pool — the pool exists for SelectThread, and SelectThread is not in this mode.
EMSCRIPTEN_KEEPALIVE int sr_os_init_irq(void) {
    sr_host_hook = sr_host_call;
    g_mode = SR_OS_IRQ;
    return 1;
}
EMSCRIPTEN_KEEPALIVE void     sr_os_mode(int m)          { g_mode = m; }
EMSCRIPTEN_KEEPALIVE int      sr_os_get_mode(void)       { return g_mode; }
EMSCRIPTEN_KEEPALIVE void     sr_os_set_msr(uint32_t m)  { g_msr = m; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_os_get_msr(void)        { return g_msr; }
EMSCRIPTEN_KEEPALIVE void     sr_os_set_timeout(uint32_t ms) { g_park_ms = ms; }

// ---- clock exports.  Split into u32 halves because these builds are not linked
// -sWASM_BIGINT, so a u64 across the JS boundary would be silently truncated.
EMSCRIPTEN_KEEPALIVE void     sr_tb_enable(int on)       { g_clock_on = on ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int      sr_tb_is_enabled(void)     { return g_clock_on; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_hi(void)             { return (uint32_t)(sr_tb_read() >> 32); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_lo(void)             { return (uint32_t)sr_tb_read(); }
EMSCRIPTEN_KEEPALIVE void     sr_tb_seed_parts(uint32_t hi, uint32_t lo) {
    sr_tb_seed(((uint64_t)hi << 32) | lo);
}
// ⚠ THESE TWO CARRY NO EMSCRIPTEN_KEEPALIVE, AND THAT IS THE MECHANISM, NOT AN
// OVERSIGHT.  They ADD guest time from OUTSIDE the guest.  A worker that called
// either on a host timer would be a wall clock wearing this facility's name — the
// exact CLAUDE.md gate #9 bug the whole design exists to prevent.  KEEPALIVE would
// put them in EVERY build's export table whether or not the link asked for them, so
// they are exported only where an -sEXPORTED_FUNCTIONS list names them: the
// verification builds (build_fixture.sh:79), which use them to seed a known amount of
// work and check the arithmetic.  build_image.sh deliberately does NOT list them, so
// the browser worker cannot reach them at all and the image's only drive is
// gk_retire() inside the emitted guest bodies.  Verified after linking with
// `grep -o -a -F sr_tb_field sab_image.wasm | wc -l` == 0.
void     sr_tb_credit(uint32_t hi, uint32_t lo) {
    sr_tb_credit_cycles(((uint64_t)hi << 32) | lo);
}
void     sr_tb_field(void)          { sr_tb_retrace(); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_dec_get(void)           { return sr_dec_read(); }
EMSCRIPTEN_KEEPALIVE void     sr_dec_set(uint32_t v)     { sr_dec_write(v); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_calls(void)          { return g_tb_calls; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_stalls(void)         { return g_tb_stalls; }
// Decrementer exceptions that WOULD have been delivered and were not -- the honest
// readout of the hole named in sr_host_os.h.  Nonzero here means a guest alarm
// handler did not run; it does not mean anything went wrong in this facility.
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_dec_exceptions(void) { return g_dec_exceptions; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_cycles_hi(void)      { return (uint32_t)(g_gk_cycles >> 32); }
EMSCRIPTEN_KEEPALIVE uint32_t sr_tb_cycles_lo(void)      { return (uint32_t)g_gk_cycles; }
// Per-fixture reset: counters and the DEC arm, so one replay cannot inherit the
// previous one's state.  It does NOT clear the seeded origin; the harness seeds
// that from the capture immediately afterwards.
EMSCRIPTEN_KEEPALIVE void     sr_tb_reset(void) {
    g_gk_cycles = 0; g_dec_start_value = 0xFFFFFFFFu; g_dec_start_cycles = 0;
    g_dec_armed = 0; g_dec_due_cycles = 0; g_dec_exceptions = 0;
    g_tb_calls = 0; g_tb_dry_reads = 0; g_tb_stalls = 0; g_tb_last_cycles = 0;
}
EMSCRIPTEN_KEEPALIVE uint32_t *sr_os_trace(void)         { return g_trace; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_os_trace_n(void)       { return g_trace_n; }
EMSCRIPTEN_KEEPALIVE void      sr_os_trace_reset(void)   { g_trace_n = 0; }
// Which host slot is running which guest thread — the witness that the switch was
// real and not a same-stack call.
EMSCRIPTEN_KEEPALIVE uint32_t  sr_os_slot_thread(int i)  { return (i >= 0 && i < g_nht) ? g_ht[i].guest_thread : 0; }
EMSCRIPTEN_KEEPALIVE int       sr_os_slot_started(int i) { return (i >= 0 && i < g_nht) ? g_ht[i].started : 0; }
// The host thread id each slot actually ran on.  Two guest threads reporting two
// different ids is the proof that the switch crossed a real thread boundary and was
// not a nested call on one stack.
EMSCRIPTEN_KEEPALIVE uint32_t  sr_os_slot_tid(int i) {
    if (i < 0 || i >= g_nht) return 0;
    return (i == 0) ? (uint32_t)(uintptr_t)pthread_self() : (uint32_t)(uintptr_t)g_ht[i].tid;
}
EMSCRIPTEN_KEEPALIVE int       sr_os_nthreads(void)      { return g_nht; }
EMSCRIPTEN_KEEPALIVE GekkoState *sr_os_snapshot(void)    { return &g_snap; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_os_snapshot_hash(void) { return g_snap_hash; }
EMSCRIPTEN_KEEPALIVE uint32_t  sr_os_snapshot_valid(void){ return g_snap_valid; }
EMSCRIPTEN_KEEPALIVE void      sr_os_snapshot_reset(void){ g_snap_valid = 0; g_snap_hash = 0; }
// Bind slot 0 to the guest thread that is already running when the harness starts.
EMSCRIPTEN_KEEPALIVE void      sr_os_bind_self(uint32_t guest_thread) {
    g_ht[0].bound = 1; g_ht[0].guest_thread = guest_thread; g_ht[0].started = 1;
}
