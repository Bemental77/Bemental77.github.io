/* psxjit.c — R3000A -> WebAssembly block recompiler (2026-10-12).
 *
 * WHAT IT IS. The interpreter (psxinterpreter.c) fetches, decodes and
 * dispatches every guest instruction through function calls. This turns a hot
 * stretch of guest code (up to J_MAXI instructions inside one 4 KB page, from a
 * start the frame loop reached J_HOT times) into one wasm function with the
 * decode done once: guest registers in wasm locals, loads and stores inlined
 * for RAM / scratchpad through the core's own LUTs, branches inside the stretch
 * as wasm control flow (`loop` + `br_table` over its jump targets). Modules of
 * up to J_QMAX functions are compiled off this thread (WebAssembly.instantiate),
 * started between frames,
 * and their functions put in the core's function table; psxJitFrame() calls
 * them through a pointer. Code is compiled for RAM through kuseg / kseg0 /
 * kseg1 and for the BIOS ROM.
 *
 * EXACTNESS IS THE CONTRACT. A block must leave every byte of guest state as
 * the interpreter would — psxRegs (pc, code, cycle, GPR, hi/lo), RAM, the
 * hardware page, the interpreter's statics (branch2/branchPC, the VSync-wait
 * fast-forward's vw_*) — at every point where anything else can look: the end
 * of a block, and every call out of it. So:
 *   * the interpreter tests for events (psxBranchTest) only after a TAKEN
 *     branch's delay slot, and the frame loop (one_iter) checks DoGPUUpdate
 *     only between instructions. A taken branch's tail is the interpreter's own
 *     code (jitTb: vwEnter, psxBranchTest, vwClose, psxJumpTest), skipped only
 *     where it provably does nothing but set pc/branch2/branchPC: no event due
 *     (the budget jitBudget() computed at the last tail, forgotten at every call
 *     out), no unmasked interrupt pending, vw_valid 0, and vwClose's effect known
 *     (see emitBranch);
 *   * every cycle is counted exactly: BIAS per instruction executed, written to
 *     psxRegs.cycle before anything that can read it (a hardware access: the
 *     root counters, DMA timing);
 *   * a hardware read can run psxRcntUpdate, which can end the frame
 *     (DoGPUUpdate) between two instructions: after every call out of a block
 *     the block stops if DoGPUUpdate is set, exactly where the interpreter's
 *     loop would;
 *   * a taken branch whose delay slot loads goes through doBranch (whose
 *     psxDelayTest reads the branch TARGET at run time), unless the target is a
 *     word this block checks and psxTestLoadDelay says it is unrelated; a delay
 *     slot that is not a plain op goes through doBranch too;
 *   * anything that is not a plain ALU op / load / store / branch (COP0, GTE,
 *     SYSCALL, ...) is run by the interpreter's own function (jitExec);
 *   * the interpreter's quirks are copied, not fixed: r0 is READ (gteMFC2/CFC2
 *     can write it), BLTZAL/BGEZAL link only when taken, ADD and ADDI do not
 *     trap, there is no load delay outside a branch delay slot.
 *
 * CODE CHANGES. Blocks are checked against the RAM they were compiled from.
 * Every writer into a tracked span marks the page in a second table
 * (urdirty.h, UR_JD_OFF) — the C writers through UR_MARK / ur_mark_range, the
 * compiled stores themselves; before a block runs, a marked page has each of
 * its blocks compared word for word with the copy kept at compile time (a
 * changed block is dropped and recompiled later), and the mark is cleared. A
 * store into the block that is running ends it right after the store, and a
 * call that marks its page ends it after the call. A state restore the core
 * does not see (the worker's rollback ring writes memory from JS) is caught at
 * the next frame: the frame serial below and psxRegs.cycle are not what the
 * last frame left, so every RAM page is re-checked.
 *
 * DETERMINISM. Nothing here is guest state. Everything the recompiler keeps is
 * in the write-tracking block (urdirty.c), which the worker never compares,
 * logs, hashes or restores, and the code it makes lives in the function table,
 * outside memory. When code gets compiled (wall time: modules arrive between
 * frames) changes only how fast a frame runs: tools/ps1_core_equiv.mjs runs
 * this core beside the shipped interpreter and their RAM, hardware page and
 * VRAM agree, and two consoles — one interpreting (?jit=0), one compiling with
 * module installs delayed at random (?jitstress=1) — hold the same static data
 * after every frame, save the dfsound wall-clock pair the fingerprint skips.
 * Compiling happens between frames (jit_js_kick -> ps1_jit_flush), never in one.
 *
 * WORKER URL SWITCHES: ?jit=0 off (the interpreter alone; the A/B arm);
 * ?jitstress=1 installs each module 0-250 ms late (a test of the above);
 * ?jitnames=1 names each compiled function after its block's pc (profiles). */
#include <string.h>
#include <stdio.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif
#include "psxcommon.h"
#include "r3000a.h"
#include "psxmem.h"
#include "urdirty.h"

extern int DoGPUUpdate;
void execI(void);
void jitTb(u32 bpc, u32 tar, u32 jr);
void jitDoBr(u32 tar, u32 jr);
void jitExec(void);
u32 jitAddr(int i);
int ps1_jit_done(u32 id, u32 gen, int nf, u32 tablen);
u32 jitLWL(u32 addr, u32 rt);
u32 jitLWR(u32 addr, u32 rt);
void jitSWL(u32 addr, u32 rt);
void jitSWR(u32 addr, u32 rt);

/* the frame serial: static guest-deterministic data (in the snapshot and the
 * fingerprint, the same on every console that ran the same frames). A restore
 * puts back an older value; the recompiler, whose state a restore does not
 * touch, sees that it is not the one it left. */
u32 psxJitSerial = 0;

/* block slots: one per word that code can start at, per address space —
 *   [0, 0x80000)        RAM through kuseg   0x00000000-0x001fffff
 *   [0x80000, 0x100000) RAM through kseg0   0x80000000-0x801fffff
 *   [0x100000,0x180000) RAM through kseg1   0xa0000000-0xa01fffff
 *   [0x180000,0x1a0000) the BIOS ROM        0xbfc00000-0xbfc7ffff
 * (one RAM word seen through two segments is two blocks: the code a block
 * makes holds its own addresses — links, branch targets, psxRegs.pc) */
#define J_SEG    0x80000u
#define J_BIOS   0x180000u
#define J_SLOTS  0x1a0000u
#define J_MAXB   32768u       /* blocks */
#define J_ARENA  (512u << 10) /* words of compiled-from code kept for the checks */
#define J_EMIT   (1u << 20)   /* bytes of one module */
#define J_QMAX   32u          /* blocks per module */
#define J_QCAP   256u         /* blocks queued */
#define J_MAXI   128u         /* instructions per block */
#define J_FLUSH_MODULES 2u   /* modules emitted per ps1_jit_flush call (it re-arms itself) */
#define J_HOT    2u           /* dispatches from the frame loop before compiling */
#define J_PENDING 0xfffeu
#define J_NOBLK   0xffffu
#define J_NH      13u         /* imported core functions */

typedef struct { u32 fn, pc, n, at, s0, nextp; } JBlk;   /* nextp: the next block on its RAM page's list (+1) */
typedef struct { u32 gen, first, cnt, live; } JBat;   /* a module being compiled */
#define J_BMAX 64u

typedef struct {
	u32 init, off, failed;
	u32 tbase, tnext;           /* function-table slots: [tbase, tnext) in use */
	u32 nblk, arena;
	u32 ram, rlut, wlut, hw, bios;   /* the host addresses the code was made for */
	u32 zero;                   /* a JIT page flag that is never set (BIOS blocks: ROM) */
	u32 dlB, dlM;               /* psxBranchTest does nothing while cycle - dlB < dlM (0: unknown) */
	u32 serial, cycle;          /* what the last frame left (restore detection) */
	u32 nq, gen, names;
	JBat bat[J_BMAX];
	u32 q[J_QCAP], qn[J_QCAP], qx[J_QCAP];   /* queued slots, their lengths, extents */
	u32 helpers[16];
	/* stats, read through ps1_jit(): [0] jdirty address, [1] blocks compiled,
	 * [2] modules, [3] page checks, [4] blocks dropped, [5] resets,
	 * [6] restores seen, [7] block runs, [8] interpreted instructions,
	 * [9] the switch (1 on), [10] blocks live, [11] compile ms * 1000,
	 * [12] uncompilable starts, [13] the address of flog */
	u32 st[16];
	u32 flog[2048][4];          /* per frame (serial & 2047): emit us, interpreted, block runs, blocks live */
	u32 phead[512];             /* per RAM page: its first block (+1), list through JBlk.nextp */
	u8 pnob[512];               /* per RAM page: has a NOBLK slot */
	u16 map[J_SLOTS];           /* slot -> block number + 1 / PENDING / NOBLK */
	u8 hot[J_SLOTS];
	JBlk blk[J_MAXB];
	u32 code[J_ARENA];
	u8 emit[J_EMIT];
} JitState;

#define JS_ ((JitState *)(ur_dirty + UR_JIT_OFF))
#define JD_ (ur_dirty + UR_JD_OFF)

_Static_assert(sizeof(JitState) <= UR_JIT_BYTES, "UR_JIT_BYTES too small for JitState");

#ifdef __EMSCRIPTEN__
/* Compile a module OFF this thread and put its functions in the table when it
 * is ready (ps1_jit_done says where, or that it is no longer wanted). Until
 * then the blocks it holds are interpreted: when code becomes compiled is not
 * guest state, so it may depend on wall time. */
EM_JS(int, jit_js_compile, (const unsigned char *buf, int len, int nf, int id, int gen, const unsigned *hp, int nh), {
	try {
		var tab = __indirect_function_table, e = globalThis.__psxjitImports;
		if (!e) {
			/* the core's functions a block calls: the same for every module */
			e = { m: wasmMemory };
			for (var i = 0; i < nh; i++) e['h' + i] = tab.get(HEAPU32[(hp >> 2) + i]);
			globalThis.__psxjitImports = e;
		}
		/* ?jitstress=1 (a test hook): install each module 0-250 ms late, so the
		 * frames at which code becomes compiled vary from run to run */
		var stress = /[?&]jitstress=1(&|$)/.test(String(self.location && self.location.search || ''));
		WebAssembly.instantiate(HEAPU8.slice(buf, buf + len), { e: e }).then(function (r) {
			return stress ? new Promise(function (ok) { setTimeout(function () { ok(r); }, Math.random() * 250); }) : r;
		}).then(function (r) {
			var x = r.instance.exports;
			var slot = _ps1_jit_done(id, gen, nf, tab.length) | 0;
			if (slot < 0) return;
			if (slot + nf > tab.length) tab.grow(slot + nf - tab.length);
			for (var k = 0; k < nf; k++) tab.set(slot + k, x['' + k]);
			/* V8 compiles a wasm function on its first call: make that call now,
			 * between frames, with the argument that returns at once — a few
			 * functions per task, so no single task holds the worker long */
			var k2 = 0;
			(function warm() {
				for (var c = 0; c < 4 && k2 < nf; c++, k2++) { try { x['' + k2](1); } catch (e3) {} }
				if (k2 < nf) setTimeout(warm, 0);
			})();
		}, function (err) {
			try { postMessage({ cmd: 'print', txt: '[psxjit] compile failed: ' + err + '\n' }); } catch (e2) {}
			_ps1_jit_done(id, gen, -1, 0);
		});
		return 0;
	} catch (err) {
		try { postMessage({ cmd: 'print', txt: '[psxjit] compile failed: ' + err + '\n' }); } catch (e2) {}
		return -1;
	}
});
/* ps1_jit_flush() once the worker is idle: after this frame (and whatever
 * other frames this message runs), never inside one */
EM_JS(void, jit_js_kick, (void), {
	if (globalThis.__psxjitKick) return;
	globalThis.__psxjitKick = 1;
	setTimeout(function () { globalThis.__psxjitKick = 0; _ps1_jit_flush(); }, 0);
});
EM_JS(int, jit_js_names, (void), {
	try { return /[?&]jitnames=1(&|$)/.test(String(self.location && self.location.search || '')) ? 1 : 0; } catch (e) { return 0; }
});
EM_JS(int, jit_js_off, (void), {
	try { return /[?&]jit=0(&|$)/.test(String(self.location && self.location.search || '')) ? 1 : 0; } catch (e) { return 0; }
});
EM_JS(double, jit_js_now, (void), { return performance.now(); });
#else
static int jit_js_compile(const unsigned char *buf, int len, int nf, int id, int gen, const unsigned *hp, int nh) { return -1; }
static int jit_js_off(void) { return 1; }
static int jit_js_names(void) { return 0; }
static void jit_js_kick(void) {}
static double jit_js_now(void) { return 0; }
#endif

/* ── wasm bytes ─────────────────────────────────────────────────────────── */
typedef struct { u8 *p; u32 n, cap, err; } B;
static inline void e1(B *b, u32 v) { if (b->n < b->cap) b->p[b->n++] = (u8)v; else b->err = 1; }
static void eU(B *b, u32 v) { do { u32 c = v & 0x7f; v >>= 7; e1(b, v ? c | 0x80 : c); } while (v); }
static void eS(B *b, s32 v) {
	for (;;) {
		u32 c = (u32)v & 0x7f; v >>= 7;
		if ((v == 0 && !(c & 0x40)) || (v == -1 && (c & 0x40))) { e1(b, c); return; }
		e1(b, c | 0x80);
	}
}
static u32 eRes(B *b) { u32 at = b->n; e1(b, 0x80); e1(b, 0x80); e1(b, 0x80); e1(b, 0x80); e1(b, 0x00); return at; }
static void ePatch(B *b, u32 at, u32 v) {
	int i;
	if (b->err) return;
	for (i = 0; i < 4; i++) { b->p[at + i] = (u8)((v & 0x7f) | 0x80); v >>= 7; }
	b->p[at + 4] = (u8)(v & 0x7f);
}
static void eName(B *b, const char *s) { u32 n = (u32)strlen(s); eU(b, n); while (*s) e1(b, (u8)*s++); }

/* opcodes */
enum {
	W_BLOCK = 0x02, W_LOOP = 0x03, W_BR = 0x0c, W_GEU = 0x4f, W_IF = 0x04, W_ELSE = 0x05, W_END = 0x0b, W_RET = 0x0f, W_CALL = 0x10, W_DROP = 0x1a,
	W_LGET = 0x20, W_LSET = 0x21, W_LTEE = 0x22,
	W_LD32 = 0x28, W_LD8S = 0x2c, W_LD8U = 0x2d, W_LD16S = 0x2e, W_LD16U = 0x2f,
	W_ST32 = 0x36, W_ST8 = 0x3a, W_ST16 = 0x3b,
	W_C32 = 0x41, W_C64 = 0x42,
	W_EQZ = 0x45, W_EQ = 0x46, W_NE = 0x47, W_LTS = 0x48, W_LTU = 0x49, W_GTS = 0x4a, W_LES = 0x4c, W_GES = 0x4e,
	W_ADD = 0x6a, W_SUB = 0x6b, W_DIVS = 0x6d, W_DIVU = 0x6e, W_REMS = 0x6f, W_REMU = 0x70,
	W_AND = 0x71, W_OR = 0x72, W_XOR = 0x73, W_SHL = 0x74, W_SHRS = 0x75, W_SHRU = 0x76,
	W_MUL64 = 0x7e, W_SHRU64 = 0x88, W_WRAP = 0xa7, W_EXTS64 = 0xac, W_EXTU64 = 0xad,
	W_EXT8 = 0xc0, W_EXT16 = 0xc1,
	W_VOID = 0x40, W_I32 = 0x7f
};
/* locals */
/* local 0 is the parameter: nonzero = return at once (the warm-up call, see
 * jit_js_compile) */
enum { L_DRY, L_C0, L_T, L_V, L_P, L_H, L_C, L_A, L_B, L_G };
/* imported functions */
enum { H_RD8, H_RD16, H_RD32, H_WR8, H_WR16, H_WR32, H_TB, H_DOBR, H_EXEC, H_LWL, H_LWR, H_SWL, H_SWR };

static void op(B *b, u32 o) { e1(b, o); }
static void cst(B *b, u32 v) { e1(b, W_C32); eS(b, (s32)v); }
static void lget(B *b, u32 l) { e1(b, W_LGET); eU(b, l); }
static void lset(B *b, u32 l) { e1(b, W_LSET); eU(b, l); }
static void ltee(B *b, u32 l) { e1(b, W_LTEE); eU(b, l); }
static void mem(B *b, u32 o, u32 align, u32 off) { e1(b, o); eU(b, align); eU(b, off); }
static void call(B *b, u32 h) { e1(b, W_CALL); eU(b, h); }

#define A_GPR(x) ((u32)(uintptr_t)&psxRegs.GPR.r[(x)])
#define A_PC  ((u32)(uintptr_t)&psxRegs.pc)
#define A_CODE ((u32)(uintptr_t)&psxRegs.code)
#define A_CYC ((u32)(uintptr_t)&psxRegs.cycle)
#define A_GPU ((u32)(uintptr_t)&DoGPUUpdate)
#define A_INT ((u32)(uintptr_t)&psxRegs.interrupt)
#define A_STATUS ((u32)(uintptr_t)&psxRegs.CP0.n.Status)

/* REGISTERS. Every guest register the block touches lives in a wasm local
 * (LR(r)) for the whole function: loaded once on entry, and the ones the block
 * writes stored back to psxRegs.GPR ("flush") before anything that can read
 * them — a call that reads or writes registers (jitTb's vwClose compares them;
 * jitExec: GTE moves, MFC0, ...; doBranch) — and on the way out. The memory
 * helpers (psxMemRead / psxMemWrite / psxHw*) never touch psxRegs.GPR, so they
 * are called with the registers still in locals. A jump inside the block keeps
 * them. The same goes for the interpreter's branch2/branchPC (L_BR2/L_BPC),
 * which only the end of a block or jitTb/doBranch can observe.
 * EXITS. The function body is `block $X { loop { ... } }; flush; return`: an
 * exit sets psxRegs.pc/code/cycle and branches to $X, so the registers are
 * written back in one place. An exit right after a call that already took the
 * registers (jitTb, doBranch, jitExec) returns directly.
 * EVENTS. Whether a taken branch's tail may skip jitTb is decided from locals:
 * L_OK (vw_valid is 0 and no unmasked interrupt is pending) and the event-free
 * budget (L_DB/L_DM, JitState.dlB/dlM). They only change in C: they are read on
 * entry and after jitTb, and every other call out zeroes the budget (so the
 * next taken branch runs jitTb, which finds the new state). */
#define LR(r) (L_G + 1 + (r))
#define L_BR2 (LR(34))
#define L_BPC (LR(35))
#define L_OK  (LR(36))
#define L_DB  (LR(37))
#define L_DM  (LR(38))
#define L_X   (LR(39))
#define NI32  (L_X - 1)

typedef struct {
	u32 pc0, hs, hlen, jd;      /* block start, its host range, its page's JIT flag */
	u32 a_br2, a_brpc, a_vwvalid, a_ilon, a_vwl, a_vwb, a_vwok, a_next, a_nexts;
	/* jumps inside the block: instruction t starts segment seg[t] (or 0xff).
	 * `depth` counts the constructs open at the emission point: $X is at 1,
	 * the loop at 2, the block that ends before segment k at 3 + (S-1-k). */
	u32 n, S, cur, ext, depth;
	u8 seg[J_MAXI + 1];
	u8 use[34], wrt[34];        /* registers the block reads or writes / writes */
	u32 rlut, wlut, hw, urd, jdb, dl;
} Ctx;

static void oIf(B *b, Ctx *c, u32 t) { op(b, W_IF); op(b, t); c->depth++; }
static void oBlock(B *b, Ctx *c) { op(b, W_BLOCK); op(b, W_VOID); c->depth++; }
static void oLoop(B *b, Ctx *c) { op(b, W_LOOP); op(b, W_VOID); c->depth++; }
static void oEnd(B *b, Ctx *c) { op(b, W_END); c->depth--; }
static void brTo(B *b, Ctx *c, u32 abs) { e1(b, W_BR); eU(b, c->depth - abs); }
static void brX(B *b, Ctx *c) { brTo(b, c, 1); }

static void rd(B *b, Ctx *c, u32 r) { lget(b, LR(r)); }
static void wr(B *b, Ctx *c, u32 r) { lset(b, LR(r)); }   /* the value is on the stack */
/* psxRegs.GPR and branch2/branchPC as the interpreter would hold them */
static void flush(B *b, Ctx *c) {
	u32 r;
	for (r = 0; r < 34; r++) if (c->wrt[r]) { cst(b, 0); lget(b, LR(r)); mem(b, W_ST32, 2, A_GPR(r)); }
	cst(b, 0); lget(b, L_BR2); mem(b, W_ST32, 2, c->a_br2);
	cst(b, 0); lget(b, L_BPC); mem(b, W_ST32, 2, c->a_brpc);
}
static void reloadRegs(B *b, Ctx *c) {
	u32 r;
	for (r = 0; r < 34; r++) if (c->use[r]) { cst(b, 0); mem(b, W_LD32, 2, A_GPR(r)); lset(b, LR(r)); }
}
/* L_OK, L_DB, L_DM from memory (see EVENTS) */
static void readEv(B *b, Ctx *c) {
	cst(b, 0); mem(b, W_LD32, 2, c->a_vwvalid); op(b, W_EQZ);
	/* an interrupt is taken only with Status IEc and IM2 (0x401) set */
	cst(b, 0); mem(b, W_LD32, 2, c->hw + 0x1070); cst(b, 0); mem(b, W_LD32, 2, c->hw + 0x1074); op(b, W_AND); cst(b, 0); op(b, W_NE);
	cst(b, 0); mem(b, W_LD32, 2, A_STATUS); cst(b, 0x401); op(b, W_AND); cst(b, 0x401); op(b, W_EQ); op(b, W_AND);
	op(b, W_EQZ); op(b, W_AND); lset(b, L_OK);
	cst(b, 0); mem(b, W_LD32, 2, c->dl); lset(b, L_DB);
	cst(b, 0); mem(b, W_LD32, 2, c->dl + 4); lset(b, L_DM);
}
/* a call into the core: it may schedule or clear an event, so the event-free
 * budget is forgotten, here and in JitState (for the blocks after this one) */
static void callOut(B *b, Ctx *c, u32 h) {
	call(b, h);
	cst(b, 0); cst(b, 0); mem(b, W_ST32, 2, c->dl + 4);
	cst(b, 0); lset(b, L_DM);
}

/* psxRegs.pc/code/cycle as the interpreter holds them after executing n
 * instructions of the block, the last one `code` at pc-4 */
static void jsync(B *b, u32 pc, u32 code, u32 n) {
	cst(b, 0); cst(b, pc); mem(b, W_ST32, 2, A_PC);
	cst(b, 0); cst(b, code); mem(b, W_ST32, 2, A_CODE);
	cst(b, 0); lget(b, L_C0); cst(b, BIAS * n); op(b, W_ADD); mem(b, W_ST32, 2, A_CYC);
}
/* after a memory helper (pc/code/cycle synced): leave if the frame ended or
 * this block's page was written */
static void checkOut(B *b, Ctx *c) {
	cst(b, 0); mem(b, W_LD32, 2, A_GPU);
	cst(b, 0); mem(b, W_LD8U, 0, c->jd); op(b, W_OR);
	oIf(b, c, W_VOID); brX(b, c); oEnd(b, c);
}
static void reloadC0(B *b, u32 n) {
	cst(b, 0); mem(b, W_LD32, 2, A_CYC); cst(b, BIAS * n); op(b, W_SUB); lset(b, L_C0);
}

/* ── classification ─────────────────────────────────────────────────────── */
enum { K_ALU, K_LOAD, K_STORE, K_LWLR, K_SWLR, K_EXEC, K_BR };
static int kindOf(u32 w) {
	u32 o = w >> 26, f = w & 63, rt = (w >> 16) & 31;
	switch (o) {
	case 0x00:
		switch (f) {
		case 0x00: case 0x02: case 0x03: case 0x04: case 0x06: case 0x07:
		case 0x10: case 0x11: case 0x12: case 0x13:
		case 0x18: case 0x19: case 0x1a: case 0x1b:
		case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27:
		case 0x2a: case 0x2b:
			return K_ALU;
		case 0x08: case 0x09: return K_BR;
		default: return K_EXEC;
		}
	case 0x01: return (rt == 0x00 || rt == 0x01 || rt == 0x10 || rt == 0x11) ? K_BR : K_EXEC;
	case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: return K_BR;
	case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f: return K_ALU;
	case 0x20: case 0x21: case 0x23: case 0x24: case 0x25: return K_LOAD;
	case 0x22: case 0x26: return K_LWLR;
	case 0x28: case 0x29: case 0x2b: return K_STORE;
	case 0x2a: case 0x2e: return K_SWLR;
	default: return K_EXEC;
	}
}
static int isUncond(u32 w) {
	u32 o = w >> 26;
	if (o == 0x02 || o == 0x03) return 1;
	if (o == 0x00) return 1;                       /* JR / JALR (kindOf said K_BR) */
	if (o == 0x04 && ((w >> 21) & 31) == ((w >> 16) & 31)) return 1;   /* beq x,x */
	return 0;
}
/* the registers an instruction reads (u) and writes (wt) as the block does it */
static void regsOf(u32 w, u8 *u, u8 *wt) {
	u32 o = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd_ = (w >> 11) & 31, f = w & 63;
	switch (kindOf(w)) {
	case K_ALU:
		if (o == 0) {
			if (f <= 0x07) { u[rt] = 1; u[rs] = 1; if (rd_) u[rd_] = wt[rd_] = 1; }
			else if (f == 0x10 || f == 0x12) { u[f == 0x10 ? 33 : 32] = 1; if (rd_) u[rd_] = wt[rd_] = 1; }
			else if (f == 0x11 || f == 0x13) { u[rs] = 1; u[f == 0x11 ? 33 : 32] = wt[f == 0x11 ? 33 : 32] = 1; }
			else if (f >= 0x18 && f <= 0x1b) { u[rs] = u[rt] = 1; u[32] = u[33] = wt[32] = wt[33] = 1; }
			else { u[rs] = u[rt] = 1; if (rd_) u[rd_] = wt[rd_] = 1; }
		} else { u[rs] = 1; if (rt) u[rt] = wt[rt] = 1; }
		break;
	case K_LOAD: case K_LWLR: u[rs] = u[rt] = 1; if (rt) wt[rt] = 1; break;
	case K_STORE: case K_SWLR: u[rs] = u[rt] = 1; break;
	case K_BR:
		u[rs] = u[rt] = 1;
		if (o == 0x03 || (o == 0x01 && (rt & 0x10))) u[31] = wt[31] = 1;
		if (o == 0x00 && f == 0x09 && rd_) u[rd_] = wt[rd_] = 1;
		break;
	default: break;   /* jitExec: through memory */
	}
}

/* ── one instruction ────────────────────────────────────────────────────── */
static void emitAlu(B *b, Ctx *c, u32 w) {
	u32 o = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd_ = (w >> 11) & 31, sa = (w >> 6) & 31, f = w & 63;
	u32 imm = w & 0xffff, simm = (u32)(s32)(s16)imm;
	if (o == 0) {
		switch (f) {
		case 0x00: case 0x02: case 0x03:
			if (!rd_) return;
			rd(b, c, rt); cst(b, sa); op(b, f == 0 ? W_SHL : f == 2 ? W_SHRU : W_SHRS); wr(b, c, rd_); return;
		case 0x04: case 0x06: case 0x07:
			if (!rd_) return;
			rd(b, c, rt); rd(b, c, rs); op(b, f == 4 ? W_SHL : f == 6 ? W_SHRU : W_SHRS); wr(b, c, rd_); return;
		case 0x10: if (!rd_) return; rd(b, c, 33); wr(b, c, rd_); return;
		case 0x12: if (!rd_) return; rd(b, c, 32); wr(b, c, rd_); return;
		case 0x11: rd(b, c, rs); wr(b, c, 33); return;
		case 0x13: rd(b, c, rs); wr(b, c, 32); return;
		case 0x18: case 0x19:
			rd(b, c, rs); op(b, f == 0x18 ? W_EXTS64 : W_EXTU64);
			rd(b, c, rt); op(b, f == 0x18 ? W_EXTS64 : W_EXTU64);
			op(b, W_MUL64); ltee(b, L_X); op(b, W_WRAP); wr(b, c, 32);
			lget(b, L_X); e1(b, W_C64); eS(b, 32); op(b, W_SHRU64); op(b, W_WRAP); wr(b, c, 33);
			return;
		case 0x1a: case 0x1b:
			rd(b, c, rs); lset(b, L_A); rd(b, c, rt); lset(b, L_B);
			lget(b, L_B); oIf(b, c, W_VOID);
			lget(b, L_A); lget(b, L_B); op(b, f == 0x1a ? W_DIVS : W_DIVU); wr(b, c, 32);
			lget(b, L_A); lget(b, L_B); op(b, f == 0x1a ? W_REMS : W_REMU); wr(b, c, 33);
			oEnd(b, c);
			return;
		default: {
			u32 wo;
			if (!rd_) return;
			switch (f) {
			case 0x20: case 0x21: wo = W_ADD; break;
			case 0x22: case 0x23: wo = W_SUB; break;
			case 0x24: wo = W_AND; break;
			case 0x25: wo = W_OR; break;
			case 0x26: wo = W_XOR; break;
			case 0x27: wo = W_OR; break;
			case 0x2a: wo = W_LTS; break;
			default: wo = W_LTU; break;
			}
			rd(b, c, rs); rd(b, c, rt); op(b, wo);
			if (f == 0x27) { cst(b, 0xffffffffu); op(b, W_XOR); }
			wr(b, c, rd_);
			return;
		}
		}
	}
	if (!rt) return;
	switch (o) {
	case 0x08: case 0x09: rd(b, c, rs); cst(b, simm); op(b, W_ADD); break;
	case 0x0a: rd(b, c, rs); cst(b, simm); op(b, W_LTS); break;
	case 0x0b: rd(b, c, rs); cst(b, simm); op(b, W_LTU); break;
	case 0x0c: rd(b, c, rs); cst(b, imm); op(b, W_AND); break;
	case 0x0d: rd(b, c, rs); cst(b, imm); op(b, W_OR); break;
	case 0x0e: rd(b, c, rs); cst(b, imm); op(b, W_XOR); break;
	default: cst(b, imm << 16); break;   /* LUI */
	}
	wr(b, c, rt);
}

static void addrT(B *b, Ctx *c, u32 w) { rd(b, c, (w >> 21) & 31); cst(b, (u32)(s32)(s16)(w & 0xffff)); op(b, W_ADD); lset(b, L_T); }
/* (t - 0x1f801000) < 0xf000: the hardware registers (psxHw*) */
static void isHw(B *b) { lget(b, L_T); cst(b, 0x1f801000); op(b, W_SUB); cst(b, 0xf000); op(b, W_LTU); }

static void emitLoad(B *b, Ctx *c, u32 w, u32 a, u32 n, int delay) {
	u32 o = w >> 26, rt = (w >> 16) & 31, ld, h, al;
	switch (o) {
	case 0x20: ld = W_LD8S; h = H_RD8; al = 0; break;
	case 0x24: ld = W_LD8U; h = H_RD8; al = 0; break;
	case 0x21: ld = W_LD16S; h = H_RD16; al = 1; break;
	case 0x25: ld = W_LD16U; h = H_RD16; al = 1; break;
	default: ld = W_LD32; h = H_RD32; al = 2; break;
	}
	addrT(b, c, w);
	isHw(b); oIf(b, c, rt ? W_I32 : W_VOID);
	jsync(b, a + 4, w, n);
	lget(b, L_T); callOut(b, c, h);
	switch (o) {
	case 0x20: op(b, W_EXT8); break;
	case 0x24: cst(b, 0xff); op(b, W_AND); break;
	case 0x21: op(b, W_EXT16); break;
	case 0x25: cst(b, 0xffff); op(b, W_AND); break;
	}
	if (rt) ltee(b, LR(rt)); else op(b, W_DROP);
	if (!delay) checkOut(b, c);
	if (rt) {
		op(b, W_ELSE);
		/* RAM, BIOS, and the scratchpad page too: psxMemRLUT[0x1f80] is psxH,
		 * which is what psxMemRead reads below 0x1f801000 */
		lget(b, L_T); cst(b, 16); op(b, W_SHRU); cst(b, 2); op(b, W_SHL); mem(b, W_LD32, 2, c->rlut); ltee(b, L_P);
		oIf(b, c, W_I32);
		lget(b, L_P); lget(b, L_T); cst(b, 0xffff); op(b, W_AND); op(b, W_ADD); mem(b, ld, al, 0);
		op(b, W_ELSE); cst(b, 0); oEnd(b, c);
	}
	oEnd(b, c);
	if (rt) wr(b, c, rt);
}

static void storeCall(B *b, Ctx *c, u32 w, u32 a, u32 n, u32 h, u32 mask, int delay) {
	jsync(b, a + 4, w, n);
	lget(b, L_T); lget(b, L_V); if (mask) { cst(b, mask); op(b, W_AND); }
	callOut(b, c, h);
	if (!delay) checkOut(b, c);
}

static void emitStore(B *b, Ctx *c, u32 w, u32 a, u32 n, int delay) {
	u32 o = w >> 26, st, h, mask, sz, al;
	switch (o) {
	case 0x28: st = W_ST8; h = H_WR8; mask = 0xff; sz = 1; al = 0; break;
	case 0x29: st = W_ST16; h = H_WR16; mask = 0xffff; sz = 2; al = 1; break;
	default: st = W_ST32; h = H_WR32; mask = 0; sz = 4; al = 2; break;
	}
	addrT(b, c, w);
	rd(b, c, (w >> 16) & 31); lset(b, L_V);
	isHw(b); oIf(b, c, W_VOID);
	storeCall(b, c, w, a, n, h, mask, delay);
	op(b, W_ELSE);
	/* RAM, and the scratchpad page too: psxMemWLUT[0x1f80] is psxH, which is
	 * what psxMemWrite writes below 0x1f801000 (unmarked there: psxH is not a
	 * tracked span, so a mark of its page changes nothing) */
	lget(b, L_T); cst(b, 16); op(b, W_SHRU); cst(b, 2); op(b, W_SHL); mem(b, W_LD32, 2, c->wlut); ltee(b, L_P);
	oIf(b, c, W_VOID);
	lget(b, L_P); lget(b, L_T); cst(b, 0xffff); op(b, W_AND); op(b, W_ADD); ltee(b, L_H);
	lget(b, L_V); mem(b, st, al, 0);
	/* UR_MARK, both tables; the JIT table also gets the last byte's page */
	lget(b, L_H); cst(b, 12); op(b, W_SHRU); cst(b, 1); mem(b, W_ST8, 0, c->urd);
	lget(b, L_H); cst(b, 12); op(b, W_SHRU); cst(b, 1); mem(b, W_ST8, 0, c->jdb);
	if (sz > 1) { lget(b, L_H); cst(b, sz - 1); op(b, W_ADD); cst(b, 12); op(b, W_SHRU); cst(b, 1); mem(b, W_ST8, 0, c->jdb); }
	if (!delay) {
		/* into this block's own code: stop right after the store */
		lget(b, L_H); cst(b, c->hs - (sz - 1)); op(b, W_SUB); cst(b, c->hlen + (sz - 1)); op(b, W_LTU);
		oIf(b, c, W_VOID); jsync(b, a + 4, w, n); brX(b, c); oEnd(b, c);
	}
	op(b, W_ELSE);
	storeCall(b, c, w, a, n, h, mask, delay);
	oEnd(b, c);
	oEnd(b, c);
}

static void emitLwlr(B *b, Ctx *c, u32 w, u32 a, u32 n) {
	u32 rt = (w >> 16) & 31;
	jsync(b, a + 4, w, n);
	rd(b, c, (w >> 21) & 31); cst(b, (u32)(s32)(s16)(w & 0xffff)); op(b, W_ADD);
	rd(b, c, rt);
	callOut(b, c, (w >> 26) == 0x22 ? H_LWL : H_LWR);
	if (rt) wr(b, c, rt); else op(b, W_DROP);
	checkOut(b, c);
}
static void emitSwlr(B *b, Ctx *c, u32 w, u32 a, u32 n, int delay) {
	jsync(b, a + 4, w, n);
	rd(b, c, (w >> 21) & 31); cst(b, (u32)(s32)(s16)(w & 0xffff)); op(b, W_ADD);
	rd(b, c, (w >> 16) & 31);
	callOut(b, c, (w >> 26) == 0x2a ? H_SWL : H_SWR);
	if (!delay) checkOut(b, c);
}
static void emitExec(B *b, Ctx *c, u32 w, u32 a, u32 n) {
	flush(b, c);
	jsync(b, a + 4, w, n);
	callOut(b, c, H_EXEC);
	reloadRegs(b, c);   /* it may write any register (GTE moves, MFC0) */
	reloadC0(b, n);
	cst(b, 0); mem(b, W_LD32, 2, A_PC); cst(b, a + 4); op(b, W_NE);
	cst(b, 0); mem(b, W_LD32, 2, A_GPU); op(b, W_OR);
	cst(b, 0); mem(b, W_LD8U, 0, c->jd); op(b, W_OR);
	oIf(b, c, W_VOID); op(b, W_RET); oEnd(b, c);
}

/* continue at instruction t of this block (a segment start) with the cycle
 * count in L_V */
static void emitJump(B *b, Ctx *c, u32 t) {
	u32 m = c->seg[t];
	lget(b, L_V); cst(b, BIAS * t); op(b, W_SUB); lset(b, L_C0);
	if (m > c->cur) brTo(b, c, 3 + (c->S - 1 - m));
	else { cst(b, m); lset(b, L_G); brTo(b, c, 2); }
}

/* the delay slot of a taken branch, done by the block: plain ops only */
static int delayNative(u32 dw) { int k = kindOf(dw); return k == K_ALU || k == K_STORE || k == K_SWLR; }
int psxTestLoadDelay(int reg, u32 tmp);

static void emitBranch(B *b, Ctx *c, u32 w, u32 a, u32 k, u32 dw) {
	u32 o = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd_ = (w >> 11) & 31;
	u32 tar = 0, dyn = 0, jr = 0, cond = 1, link = 0, t, ld, sb = 0;
	switch (o) {
	case 0x00:
		rd(b, c, rs); lset(b, L_C); dyn = 1;   /* not L_A/L_B: a DIV in the delay slot uses those */
		if ((w & 63) == 0x08) jr = 1;
		else if (rd_) { cst(b, a + 8); wr(b, c, rd_); }
		cond = 0;
		break;
	case 0x01:
		rd(b, c, rs); cst(b, 0); op(b, (rt & 1) ? W_GES : W_LTS);
		link = (rt & 0x10) != 0;
		tar = a + 4 + ((u32)(s32)(s16)(w & 0xffff) << 2);
		break;
	case 0x02: case 0x03:
		tar = ((a + 4) & 0xf0000000u) | ((w & 0x03ffffff) << 2);
		if (o == 0x03) { cst(b, a + 8); wr(b, c, 31); }
		cond = 0;
		break;
	default:
		tar = a + 4 + ((u32)(s32)(s16)(w & 0xffff) << 2);
		if (o == 0x04 && rs == rt) { cond = 0; break; }
		rd(b, c, rs);
		if (o == 0x04 || o == 0x05) { rd(b, c, rt); op(b, o == 0x04 ? W_EQ : W_NE); }
		else { cst(b, 0); op(b, o == 0x06 ? W_LES : W_GTS); }
		break;
	}
	if (cond) oIf(b, c, W_VOID);
	if (link) { cst(b, a + 8); wr(b, c, 31); }
	/* a load in the delay slot of a branch whose target word is one of this
	 * block's checked words: psxDelayTest's verdict is known now; 0 = the load
	 * just runs (and the tail skips vwClose) */
	ld = !dyn && kindOf(dw) == K_LOAD && tar >= c->pc0 && tar < c->pc0 + 4 * c->ext &&
	     psxTestLoadDelay((dw >> 16) & 31, *(u32 *)(uintptr_t)(c->hs + (tar - c->pc0))) == 0;
	/* a short backward branch (vwClose's business): sb = 2 when its target is
	 * one of this block's checked words and fails vwMatch's first test (not
	 * `lw rC,off(rS)` with rC != 0, rS) — then vwClose's whole effect is
	 * vw_L/vw_B = tar/bpc (vw_valid, vw_ok 0) */
	if (!dyn && !ld && tar < a && a - tar <= 0x100) {
		sb = 1;
		if (tar >= c->pc0 && tar < c->pc0 + 4 * c->ext) {
			u32 w0 = *(u32 *)(uintptr_t)(c->hs + (tar - c->pc0)), rC = (w0 >> 16) & 31, rS = (w0 >> 21) & 31;
			if ((w0 >> 26) != 0x23 || rC == 0 || rC == rS) sb = 2;
		}
	}
	if (ld || delayNative(dw)) {
		u32 dn = k + 2, da = a + 4;
		switch (kindOf(dw)) {
		case K_LOAD: emitLoad(b, c, dw, da, dn, 1); break;
		case K_ALU: emitAlu(b, c, dw); break;
		case K_STORE: emitStore(b, c, dw, da, dn, 1); break;
		default: emitSwlr(b, c, dw, da, dn, 1); break;
		}
		lget(b, L_C0); cst(b, BIAS * dn); op(b, W_ADD); lset(b, L_V);
		/* jitTb, unless it would do nothing but set pc/branch2/branchPC:
		 * vwEnter is a no-op while vw_valid is 0; psxBranchTest while nothing
		 * is due (the budget) and no unmasked interrupt is pending; vwClose for
		 * any branch but a short backward one, and for that one too while
		 * il_on is 0 or it is the (L,B) pair already found not to be the VSync
		 * wait; psxJumpTest while Config.PsxOut is off */
		lget(b, L_OK);
		lget(b, L_V); lget(b, L_DB); op(b, W_SUB); lget(b, L_DM); op(b, W_LTU); op(b, W_AND);
		op(b, W_EQZ);
		if (dyn) {
			/* short backward (1 <= bpc - tar <= 0x100): the full tail */
			cst(b, a); lget(b, L_C); op(b, W_SUB); cst(b, 1); op(b, W_SUB); cst(b, 0x100); op(b, W_LTU); op(b, W_OR);
		} else if (sb == 2) {
			cst(b, 0); mem(b, W_LD32, 2, c->a_vwok); op(b, W_OR);
		} else if (sb == 1) {
			/* il_on != 0 && ((vw_L, vw_B) != (tar, bpc) || vw_ok): both sides
			 * made 0/1 before the AND (a bitwise AND of two nonzero words can be 0) */
			cst(b, 0); mem(b, W_LD32, 2, c->a_ilon); cst(b, 0); op(b, W_NE);
			cst(b, 0); mem(b, W_LD32, 2, c->a_vwl); cst(b, tar); op(b, W_XOR);
			cst(b, 0); mem(b, W_LD32, 2, c->a_vwb); cst(b, a); op(b, W_XOR); op(b, W_OR);
			cst(b, 0); mem(b, W_LD32, 2, c->a_vwok); op(b, W_OR); cst(b, 0); op(b, W_NE);
			op(b, W_AND); op(b, W_OR);
		}
		if (jr && Config.PsxOut) { cst(b, 1); op(b, W_OR); }
		/* a target inside this block: jump there instead of returning */
		t = (!dyn && tar >= c->pc0 && tar < c->pc0 + 4 * c->n) ? (tar - c->pc0) / 4 : J_MAXI;
		oIf(b, c, W_VOID);
		flush(b, c);
		cst(b, 0); cst(b, dw); mem(b, W_ST32, 2, A_CODE);
		cst(b, 0); lget(b, L_V); mem(b, W_ST32, 2, A_CYC);
		cst(b, a); if (dyn) lget(b, L_C); else cst(b, tar); cst(b, jr | (ld ? 2 : 0)); call(b, H_TB);
		if (t < J_MAXI) {
			/* the tail ran in full: go on in the block only if it left pc at the
			 * target, did not end the frame and did not write this block's page
			 * (the VSync-wait fast-forward stores; an exception moves pc) */
			cst(b, 0); mem(b, W_LD32, 2, A_PC); cst(b, tar); op(b, W_NE);
			cst(b, 0); mem(b, W_LD32, 2, A_GPU); op(b, W_OR);
			cst(b, 0); mem(b, W_LD8U, 0, c->jd); op(b, W_OR);
			oIf(b, c, W_VOID); op(b, W_RET); oEnd(b, c);
			cst(b, 1); lset(b, L_BR2); cst(b, tar); lset(b, L_BPC);
			readEv(b, c);
			cst(b, 0); mem(b, W_LD32, 2, A_CYC); lset(b, L_V);
			emitJump(b, c, t);
		} else op(b, W_RET);
		oEnd(b, c);
		if (sb == 2) {
			cst(b, 0); mem(b, W_LD32, 2, c->a_ilon); oIf(b, c, W_VOID);
			cst(b, 0); cst(b, tar); mem(b, W_ST32, 2, c->a_vwl);
			cst(b, 0); cst(b, a); mem(b, W_ST32, 2, c->a_vwb);
			oEnd(b, c);
		}
		cst(b, 1); lset(b, L_BR2);
		if (dyn) lget(b, L_C); else cst(b, tar);
		lset(b, L_BPC);
		if (t < J_MAXI) {
			/* nothing fired and nothing changed this block's code (a store into
			 * it, or a call that marked its page, would have left the block) */
			emitJump(b, c, t);
		} else {
			cst(b, 0); lget(b, L_BPC); mem(b, W_ST32, 2, A_PC);
			cst(b, 0); cst(b, dw); mem(b, W_ST32, 2, A_CODE);
			cst(b, 0); lget(b, L_V); mem(b, W_ST32, 2, A_CYC);
			brX(b, c);
		}
	} else {
		flush(b, c);
		jsync(b, a + 4, w, k + 1);
		if (dyn) lget(b, L_C); else cst(b, tar);
		cst(b, jr); call(b, H_DOBR);
		cst(b, 0); cst(b, 0); mem(b, W_ST32, 2, c->dl + 4);
		op(b, W_RET);
	}
	if (cond) oEnd(b, c);
}

/* ── blocks ─────────────────────────────────────────────────────────────── */
/* the slot of a pc (J_SLOTS if code there is not compiled) */
static inline u32 slotOf(u32 pc) {
	if (pc - 0x80000000u < 0x200000u) return J_SEG + (pc & 0x1fffff) / 4;
	if (pc < 0x200000u) return pc / 4;
	if (pc - 0xa0000000u < 0x200000u) return 2 * J_SEG + (pc & 0x1fffff) / 4;
	if (pc - 0xbfc00000u < 0x80000u) return J_BIOS + (pc & 0x7ffff) / 4;
	return J_SLOTS;
}
static inline u32 slotPc(u32 s) {
	if (s >= J_BIOS) return 0xbfc00000u + (s - J_BIOS) * 4;
	return (s / J_SEG == 0 ? 0u : s / J_SEG == 1 ? 0x80000000u : 0xa0000000u) + (s % J_SEG) * 4;
}
/* the host address of a slot's word */
static inline u32 slotHost(JitState *j, u32 s) { return s >= J_BIOS ? j->bios + (s - J_BIOS) * 4 : j->ram + (s % J_SEG) * 4; }
static inline u32 codew(JitState *j, u32 s0, u32 pc0, u32 a) { return *(u32 *)(uintptr_t)(slotHost(j, s0) + (a - pc0)); }

/* how far a block from slot s0 goes: n instructions emitted in a line, `term`
 * if the last is an unconditional jump (its delay slot then follows), and the
 * words it reads (ext). A block stays inside one 4 KB page of guest code. */
static u32 scan(JitState *j, u32 s0, u32 *term, u32 *ext) {
	u32 pc = slotPc(s0), i = 0, x = 0, page = pc >> 12, fwd = 0;
	*term = 0;
	for (;;) {
		u32 a = pc + 4 * i, w;
		if (i >= J_MAXI || (a >> 12) != page) break;
		w = codew(j, s0, pc, a);
		if (kindOf(w) == K_BR) {
			u32 o = w >> 26, tar = 0;
			if (((a + 4) >> 12) != page || kindOf(codew(j, s0, pc, a + 4)) == K_BR) break;
			i++;
			if (i + 1 > x) x = i + 1;
			if (o != 0) {
				tar = (o == 2 || o == 3) ? ((a + 4) & 0xf0000000u) | ((w & 0x03ffffff) << 2) : a + 4 + ((u32)(s32)(s16)(w & 0xffff) << 2);
				if (tar > a && (tar >> 12) == page && tar > fwd) fwd = tar;
				/* a load in the delay slot: psxDelayTest reads the target's
				 * first word; keep it in the checked words when it is ahead */
				if (kindOf(codew(j, s0, pc, a + 4)) == K_LOAD && tar > pc && (tar >> 12) == page && (tar - pc) / 4 + 1 > x)
					x = (tar - pc) / 4 + 1;
			}
			*term = isUncond(w);
			/* past an unconditional jump, go on only to code a branch of this
			 * block jumps to */
			if (*term && fwd < a + 4) break;
			continue;
		}
		*term = 0;
		i++;
	}
	if (i > x) x = i;
	*ext = x;
	return i;
}

static void emitBody(B *b, JitState *j, u32 s0, u32 n, u32 term, u32 ext) {
	Ctx c;
	u32 k, r, at = eRes(b), start = b->n, pc = slotPc(s0);
	c.pc0 = pc;
	c.hs = slotHost(j, s0);
	c.hlen = ext * 4;
	c.ext = ext;
	c.jd = s0 >= J_BIOS ? (u32)(uintptr_t)&j->zero : (u32)(uintptr_t)JD_ + (c.hs >> 12);
	c.rlut = j->rlut; c.wlut = j->wlut; c.hw = j->hw; c.dl = (u32)(uintptr_t)&j->dlB;
	c.urd = (u32)(uintptr_t)ur_dirty; c.jdb = (u32)(uintptr_t)JD_;
	c.a_br2 = jitAddr(0); c.a_brpc = jitAddr(1); c.a_vwvalid = jitAddr(2); c.a_ilon = jitAddr(3);
	c.a_vwl = jitAddr(4); c.a_vwb = jitAddr(5); c.a_vwok = jitAddr(6);
	c.a_next = (u32)(uintptr_t)&psxNextCounter; c.a_nexts = (u32)(uintptr_t)&psxNextsCounter;
	c.depth = 0;
	/* the jump targets inside the block, and the registers it uses */
	c.n = n;
	memset(c.seg, 0xff, sizeof(c.seg));
	memset(c.use, 0, sizeof(c.use)); memset(c.wrt, 0, sizeof(c.wrt));
	c.seg[0] = 0;
	for (k = 0; k < n; k++) {
		u32 a = pc + 4 * k, w = codew(j, s0, pc, a), o = w >> 26, tar;
		regsOf(w, c.use, c.wrt);
		if (kindOf(w) != K_BR) continue;
		regsOf(codew(j, s0, pc, a + 4), c.use, c.wrt);   /* its delay slot, done in the taken path */
		if (o == 0) continue;
		tar = (o == 2 || o == 3) ? ((a + 4) & 0xf0000000u) | ((w & 0x03ffffff) << 2) : a + 4 + ((u32)(s32)(s16)(w & 0xffff) << 2);
		if (tar >= pc && tar < pc + 4 * n) c.seg[(tar - pc) / 4] = 0;
	}
	for (k = 0, c.S = 0; k < n; k++) if (c.seg[k] != 0xff) c.seg[k] = (u8)c.S++;
	/* locals: NI32 x i32, 1 x i64 */
	e1(b, 2); eU(b, NI32); e1(b, W_I32); e1(b, 1); e1(b, 0x7e);
	lget(b, L_DRY); op(b, W_IF); op(b, W_VOID); op(b, W_RET); op(b, W_END);
	cst(b, 0); mem(b, W_LD32, 2, A_CYC); lset(b, L_C0);
	cst(b, 0); mem(b, W_LD32, 2, c.a_br2); lset(b, L_BR2);
	cst(b, 0); mem(b, W_LD32, 2, c.a_brpc); lset(b, L_BPC);
	for (r = 0; r < 34; r++) if (c.use[r]) { cst(b, 0); mem(b, W_LD32, 2, A_GPR(r)); lset(b, LR(r)); }
	readEv(b, &c);
	oBlock(b, &c);   /* $X */
	oLoop(b, &c);
	for (k = 0; k < c.S; k++) oBlock(b, &c);
	lget(b, L_G); e1(b, 0x0e); eU(b, c.S);
	for (k = 0; k < c.S; k++) eU(b, k);
	eU(b, c.S - 1);
	oEnd(b, &c);
	c.cur = 0;
	for (k = 0; k < n; k++) {
		u32 a = pc + 4 * k, w = codew(j, s0, pc, a);
		if (k && c.seg[k] != 0xff) { oEnd(b, &c); c.cur = c.seg[k]; }
		switch (kindOf(w)) {
		case K_ALU: emitAlu(b, &c, w); break;
		case K_LOAD: emitLoad(b, &c, w, a, k + 1, 0); break;
		case K_STORE: emitStore(b, &c, w, a, k + 1, 0); break;
		case K_LWLR: emitLwlr(b, &c, w, a, k + 1); break;
		case K_SWLR: emitSwlr(b, &c, w, a, k + 1, 0); break;
		case K_EXEC: emitExec(b, &c, w, a, k + 1); break;
		default: emitBranch(b, &c, w, a, k, codew(j, s0, pc, a + 4)); break;
		}
	}
	if (!term) jsync(b, pc + 4 * n, codew(j, s0, pc, pc + 4 * (n - 1)), n);
	oEnd(b, &c);   /* loop */
	oEnd(b, &c);   /* $X */
	flush(b, &c);
	op(b, W_END);
	ePatch(b, at, b->n - start);
}

static void jitWipe(JitState *j) {
	memset(j->map, 0, sizeof(j->map));
	memset(j->hot, 0, sizeof(j->hot));
	j->nblk = 0; j->arena = 0; j->nq = 0;
	memset(j->phead, 0, sizeof(j->phead)); memset(j->pnob, 0, sizeof(j->pnob));
	j->tnext = j->tbase;
	j->gen++;
	memset(j->bat, 0, sizeof(j->bat));
	j->st[5]++;
}

/* compile every queued block into one module */
/* one module: functions for the m slots q[] whose scan gave qn[] (n | term << 31,
 * 0 = none) and qx[] (extents), nf of them nonzero */
static void emitModule(B *b, JitState *j, const u32 *q, const u32 *qn, const u32 *qx, u32 m, u32 nf) {
	u32 i, at, sec;
	static const char hdr[8] = { 0, 'a', 's', 'm', 1, 0, 0, 0 };
	for (i = 0; i < 8; i++) e1(b, (u8)hdr[i]);
	/* types: 0 ()->(), 1 (i32)->i32, 2 (i32,i32)->(), 3 (i32,i32,i32)->(), 4 (i32,i32)->i32, 5 (i32)->() */
	e1(b, 1); at = eRes(b); sec = b->n;
	e1(b, 6);
	e1(b, 0x60); e1(b, 0); e1(b, 0);
	e1(b, 0x60); e1(b, 1); e1(b, W_I32); e1(b, 1); e1(b, W_I32);
	e1(b, 0x60); e1(b, 2); e1(b, W_I32); e1(b, W_I32); e1(b, 0);
	e1(b, 0x60); e1(b, 3); e1(b, W_I32); e1(b, W_I32); e1(b, W_I32); e1(b, 0);
	e1(b, 0x60); e1(b, 2); e1(b, W_I32); e1(b, W_I32); e1(b, 1); e1(b, W_I32);
	e1(b, 0x60); e1(b, 1); e1(b, W_I32); e1(b, 0);
	ePatch(b, at, b->n - sec);
	/* imports: memory, then the core's functions */
	e1(b, 2); at = eRes(b); sec = b->n;
	eU(b, 1 + J_NH);
	eName(b, "e"); eName(b, "m"); e1(b, 2); e1(b, 0); e1(b, 0);
	{
		static const u8 ty[J_NH] = { 1, 1, 1, 2, 2, 2, 3, 2, 0, 4, 4, 2, 2 };
		char nm[8];
		for (i = 0; i < J_NH; i++) { snprintf(nm, sizeof(nm), "h%u", i); eName(b, "e"); eName(b, nm); e1(b, 0); e1(b, ty[i]); }
	}
	ePatch(b, at, b->n - sec);
	e1(b, 3); at = eRes(b); sec = b->n;
	eU(b, nf); for (i = 0; i < nf; i++) e1(b, 5);
	ePatch(b, at, b->n - sec);
	e1(b, 7); at = eRes(b); sec = b->n;
	eU(b, nf);
	for (i = 0; i < nf; i++) { char nm[12]; snprintf(nm, sizeof(nm), "%u", i); eName(b, nm); e1(b, 0); eU(b, J_NH + i); }
	ePatch(b, at, b->n - sec);
	e1(b, 10); at = eRes(b); sec = b->n;
	eU(b, nf);
	for (i = 0; i < m; i++) {
		u32 n = qn[i] & 0x7fffffffu;
		if (n) emitBody(b, j, q[i], n, qn[i] >> 31, qx[i]);
	}
	ePatch(b, at, b->n - sec);
	if (j->names) {
		/* ?jitnames=1: a "name" section, so a profile names each block by its pc */
		u32 k = 0;
		e1(b, 0); at = eRes(b); sec = b->n;
		eName(b, "name");
		e1(b, 1); { u32 at2 = eRes(b), sec2 = b->n;
		eU(b, nf);
		for (i = 0; i < m; i++) if (qn[i] & 0x7fffffffu) { char nm[16]; snprintf(nm, sizeof(nm), "b%08x", slotPc(q[i])); eU(b, J_NH + k); eName(b, nm); k++; }
		ePatch(b, at2, b->n - sec2); }
		ePatch(b, at, b->n - sec);
	}
}

static void jitFlush(JitState *j) {
	B b;
	u32 i, nf = 0, at, sec;
	double t0;
	u32 m;
	if (!j->nq) return;
	t0 = jit_js_now();
	if (j->nblk + J_QMAX > J_MAXB || j->arena + J_QMAX * (J_MAXI + 1) > J_ARENA) {
		u32 q[J_QCAP], nq = j->nq;
		memcpy(q, j->q, sizeof(q));
		jitWipe(j);
		for (i = 0; i < nq; i++) { j->q[i] = q[i]; j->map[q[i]] = J_PENDING; }
		j->nq = nq;
	}
	m = j->nq < J_QMAX ? j->nq : J_QMAX;   /* one module: the oldest J_QMAX */
	for (i = 0; i < m; i++) {
		u32 term, ext, n = scan(j, j->q[i], &term, &ext);
		j->qn[i] = n ? n | (term << 31) : 0;
		j->qx[i] = ext;
		if (n) nf++;
	}
	b.p = j->emit; b.n = 0; b.cap = J_EMIT; b.err = 0;
	if (nf) emitModule(&b, j, j->q, j->qn, j->qx, m, nf);
	{
		u32 id = J_BMAX, first = j->nblk;
		if (nf && !b.err) for (id = 0; id < J_BMAX && j->bat[id].live; id++) ;
		for (i = 0; i < m; i++) {
			u32 s0 = j->q[i], n = j->qn[i] & 0x7fffffffu, x = j->qx[i], k;
			if (n && id < J_BMAX) {
				/* the words it was made from, kept now: the module is made from them */
				JBlk *bk = &j->blk[j->nblk++];
				bk->fn = 0; bk->pc = slotPc(s0); bk->n = x; bk->at = j->arena; bk->s0 = s0;
				memcpy(&j->code[j->arena], (void *)(uintptr_t)slotHost(j, s0), x * 4);
				j->arena += x;
				continue;   /* stays PENDING (and its words held back) until installed */
			}
			j->map[s0] = n ? 0 : J_NOBLK; j->hot[s0] = 0;
			if (!n && s0 < J_BIOS) j->pnob[(s0 % J_SEG) >> 10] = 1;
			if (!n) j->st[12]++;
			for (k = 1; k < x; k++) if (j->map[s0 + k] == J_PENDING) { j->map[s0 + k] = 0; j->hot[s0 + k] = 0; }
		}
		if (id < J_BMAX) {
			JBat *bt = &j->bat[id];
			bt->gen = j->gen; bt->first = first; bt->cnt = nf; bt->live = 1;
			if (jit_js_compile(j->emit, (int)b.n, (int)nf, (int)id, (int)j->gen, j->helpers, J_NH) < 0) {
				j->failed = 1;
				ps1_jit_done(id, j->gen, -1, 0);
			}
		}
	}
	/* the rest wait for the next module */
	j->nq -= m;
	memmove(j->q, j->q + m, j->nq * sizeof(u32));
	memmove(j->qx, j->qx + m, j->nq * sizeof(u32));
	j->st[10] = j->nblk;
	j->st[11] += (u32)((jit_js_now() - t0) * 1000.0);
}

/* a module is ready (nf functions; tablen = the table's length now) or failed
 * (nf < 0): returns the table slot its functions go to, or -1 to drop them */
int ps1_jit_done(u32 id, u32 gen, int nf, u32 tablen) {
	JitState *j = JS_;
	JBat *bt;
	u32 i, slot;
	if (id >= J_BMAX) return -1;
	bt = &j->bat[id];
	if (!bt->live || bt->gen != gen || gen != j->gen) return -1;   /* wiped since */
	bt->live = 0;
	if (nf < 0) j->failed = 1;
	if (!j->tbase) j->tnext = j->tbase = tablen;
	slot = j->tnext;
	for (i = 0; i < bt->cnt; i++) {
		JBlk *bk = &j->blk[bt->first + i];
		u32 k;
		if (nf >= 0) {
			bk->fn = slot + i;
			if (j->map[bk->s0] == J_PENDING) {
				j->map[bk->s0] = (u16)(bt->first + i + 1);
				if (bk->s0 < J_BIOS) { u32 pg = (bk->s0 % J_SEG) >> 10; bk->nextp = j->phead[pg]; j->phead[pg] = bt->first + i + 1; }
			}
			/* its page may have been written (and its flag cleared) since the
			 * words were kept: check it before the block first runs */
			if (bk->s0 < J_BIOS) JD_[(j->ram >> 12) + ((bk->s0 % J_SEG) >> 10)] = 1;
			j->st[1]++;
		} else if (j->map[bk->s0] == J_PENDING) { j->map[bk->s0] = 0; j->hot[bk->s0] = 0; }
		for (k = 1; k < bk->n; k++) if (j->map[bk->s0 + k] == J_PENDING) { j->map[bk->s0 + k] = 0; j->hot[bk->s0 + k] = 0; }
	}
	if (nf < 0) return -1;
	j->tnext = slot + bt->cnt;
	j->st[2]++;
	return (int)slot;
}

static void jitEnqueue(JitState *j, u32 s0) {
	u32 term, ext, k;
	scan(j, s0, &term, &ext);
	j->map[s0] = J_PENDING;
	j->q[j->nq] = s0; j->qn[j->nq] = 0; j->qx[j->nq] = ext;
	j->nq++;
	/* hold the words it covers back from counting until it is compiled */
	for (k = 1; k < ext; k++) if (j->map[s0 + k] == 0) j->map[s0 + k] = J_PENDING;
}

/* RAM page gp has its JIT flag set: drop every block (in any of the three
 * segments) whose words changed */
static void jitCheckPage(JitState *j, u32 gp) {
	const u32 *ram = (const u32 *)(uintptr_t)j->ram;
	u32 d, *link = &j->phead[gp];
	JD_[(j->ram >> 12) + gp] = 0;
	j->st[3]++;
	while ((d = *link) != 0) {
		JBlk *bk = &j->blk[d - 1];
		u32 w = bk->s0 % J_SEG;
		if (j->map[bk->s0] != d) { *link = bk->nextp; continue; }   /* no longer the slot's block */
		if (memcmp(&j->code[bk->at], &ram[w], bk->n * 4)) {
			j->map[bk->s0] = 0; j->hot[bk->s0] = 0; j->st[4]++;
			*link = bk->nextp;
			continue;
		}
		link = &bk->nextp;
	}
	if (j->pnob[gp]) {
		/* slots found uncompilable are tried again */
		u32 seg;
		j->pnob[gp] = 0;
		for (seg = 0; seg < 3; seg++) {
			u32 w = gp << 10, e = w + 1024;
			for (; w < e; w++) if (j->map[seg * J_SEG + w] == J_NOBLK) { j->map[seg * J_SEG + w] = 0; j->hot[seg * J_SEG + w] = 0; }
		}
	}
}

void psxJitReset(void) {
	JitState *j = JS_;
	if (!j->init) {
		j->init = 1;
		j->helpers[H_RD8] = (u32)(uintptr_t)&psxMemRead8;
		j->helpers[H_RD16] = (u32)(uintptr_t)&psxMemRead16;
		j->helpers[H_RD32] = (u32)(uintptr_t)&psxMemRead32;
		j->helpers[H_WR8] = (u32)(uintptr_t)&psxMemWrite8;
		j->helpers[H_WR16] = (u32)(uintptr_t)&psxMemWrite16;
		j->helpers[H_WR32] = (u32)(uintptr_t)&psxMemWrite32;
		j->helpers[H_TB] = (u32)(uintptr_t)&jitTb;
		j->helpers[H_DOBR] = (u32)(uintptr_t)&jitDoBr;
		j->helpers[H_EXEC] = (u32)(uintptr_t)&jitExec;
		j->helpers[H_LWL] = (u32)(uintptr_t)&jitLWL;
		j->helpers[H_LWR] = (u32)(uintptr_t)&jitLWR;
		j->helpers[H_SWL] = (u32)(uintptr_t)&jitSWL;
		j->helpers[H_SWR] = (u32)(uintptr_t)&jitSWR;
		if (jit_js_off()) j->off = 1;
		j->names = jit_js_names();
	}
	jitWipe(j);
	j->ram = (u32)(uintptr_t)psxM;
	j->rlut = (u32)(uintptr_t)psxMemRLUT;
	j->wlut = (u32)(uintptr_t)psxMemWLUT;
	j->hw = (u32)(uintptr_t)psxH;
	j->bios = (u32)(uintptr_t)psxR;
	j->zero = 0;
	memset(JD_ + (j->ram >> 12), 1, 0x200);
}

/* the standard memory map, RAM on 4 KB pages */
static int jitUsable(JitState *j) {
	u32 i;
	if (j->off || j->failed || Config.HLE || !psxM || !psxR || ((uintptr_t)psxM & 0xfff)) return 0;
	if (j->ram != (u32)(uintptr_t)psxM || j->rlut != (u32)(uintptr_t)psxMemRLUT || j->wlut != (u32)(uintptr_t)psxMemWLUT ||
	    j->hw != (u32)(uintptr_t)psxH || j->bios != (u32)(uintptr_t)psxR) psxJitReset();
	for (i = 0; i < 0x20; i++) {
		u8 *r = (u8 *)psxM + (i << 16);
		if (psxMemRLUT[i] != r || psxMemRLUT[0x8000 + i] != r || psxMemRLUT[0xa000 + i] != r) return 0;
	}
	for (i = 0; i < 8; i++) if (psxMemRLUT[0xbfc0 + i] != (u8 *)psxR + (i << 16)) return 0;
	if (psxMemRLUT[0x1f80] != (u8 *)psxH || psxMemWLUT[0x1f80] != (u8 *)psxH) return 0;
	return 1;
}

/* one frame: one_iter's `while (!DoGPUUpdate) execI();`, blocks where it can */
void psxJitFrame(void) {
	JitState *j = JS_;
#ifndef PS1_PCHIST
	if (j->init && jitUsable(j)) {
		u8 *jd = JD_ + (j->ram >> 12);
		if (j->serial != psxJitSerial || j->cycle != psxRegs.cycle) {
			/* the machine was put back (a rollback restore): re-check every page */
			memset(jd, 1, 0x200);
			j->st[6]++;
		}
		u32 i0 = j->st[8], r0 = j->st[7], f0 = j->st[11];
		j->dlM = 0;
		j->st[9] = 1;
		while (!DoGPUUpdate) {
			u32 s = slotOf(psxRegs.pc);
			if (s < J_SLOTS) {
				u32 d;
				if (s < J_BIOS && jd[(s % J_SEG) >> 10]) jitCheckPage(j, (s % J_SEG) >> 10);
				d = j->map[s];
				if (d - 1u < J_MAXB) {
					j->st[7]++;
					((void (*)(u32))(uintptr_t)j->blk[d - 1].fn)(0);
					continue;
				}
				if (d == 0 || d == J_PENDING) {
					u32 h = j->hot[s];
					if (h < 255) j->hot[s] = (u8)++h;
					if (d == 0 && h >= J_HOT && j->nq < J_QCAP) jitEnqueue(j, s);
				}
			}
			/* no block here: interpret up to the next transfer of control (or the
			 * end of the frame — one_iter checks DoGPUUpdate between any two
			 * instructions), then look again */
			j->dlM = 0;
			for (;;) {
				u32 p = psxRegs.pc;
				j->st[8]++;
				execI();
				if (DoGPUUpdate || psxRegs.pc != p + 4) break;
			}
		}
		/* what became hot is compiled after the frame, between frames (a
		 * frame never waits for the recompiler) */
		if (j->nq) jit_js_kick();
		{ u32 *L = j->flog[psxJitSerial & 2047]; L[0] = j->st[11] - f0; L[1] = j->st[8] - i0; L[2] = j->st[7] - r0; L[3] = j->nblk; }
		psxJitSerial++;
		j->serial = psxJitSerial;
		j->cycle = psxRegs.cycle;
		return;
	}
#endif
	j->st[9] = 0;
	while (!DoGPUUpdate) execI();
	psxJitSerial++;
	j->serial = psxJitSerial;
	j->cycle = psxRegs.cycle;
}

/* between frames (jit_js_kick): emit up to J_FLUSH_MODULES modules of queued
 * blocks and start compiling them; called again while some remain */
void ps1_jit_flush(void) {
	JitState *j = JS_;
	u32 k;
	if (!j->init || j->off || j->failed) return;
	for (k = 0; k < J_FLUSH_MODULES && j->nq; k++) jitFlush(j);
	if (j->nq) jit_js_kick();
}

/* ps1_jit(-1) reads, 0/1 sets the switch (a switch-on re-checks every page);
 * returns the stats words (layout at JitState.st) */
u32 *ps1_jit(int on) {
	JitState *j = JS_;
	j->st[0] = (u32)(uintptr_t)JD_;
	j->st[13] = (u32)(uintptr_t)j->flog;
	if (on >= 0) {
		j->off = on ? 0 : 1;
		if (on && j->ram) memset(JD_ + (j->ram >> 12), 1, 0x200);
	}
	j->st[9] = !j->off;
	return j->st;
}

/* jitTb, after the branch test: nothing is due for `budget` cycles from `base` */
void psxJitNote(u32 base, u32 budget) { JitState *j = JS_; j->dlB = base; j->dlM = budget; }
