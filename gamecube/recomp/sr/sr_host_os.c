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
    switch (addr) {
    case SAB_OSDisableInterrupts:  os_disable_interrupts(st);   return 1;
    case SAB_OSEnableInterrupts:   os_enable_interrupts(st);    return 1;
    case SAB_OSRestoreInterrupts:  os_restore_interrupts(st);   return 1;
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
EMSCRIPTEN_KEEPALIVE void     sr_os_mode(int m)          { g_mode = m; }
EMSCRIPTEN_KEEPALIVE int      sr_os_get_mode(void)       { return g_mode; }
EMSCRIPTEN_KEEPALIVE void     sr_os_set_msr(uint32_t m)  { g_msr = m; }
EMSCRIPTEN_KEEPALIVE uint32_t sr_os_get_msr(void)        { return g_msr; }
EMSCRIPTEN_KEEPALIVE void     sr_os_set_timeout(uint32_t ms) { g_park_ms = ms; }
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
