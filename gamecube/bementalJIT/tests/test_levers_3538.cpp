// test_levers_3538.cpp — the second batch of 2026-10-08 word-2 levers against
// independent references AND against their own kill arm (lever_gate.h word 2,
// bits 3-6). The test runs with g_bem_lc_base set (as the live build does), so
// the shadow-mask cell, the gather-pipe arms and the kill cells are real; it is
// linked like block_replay (GLOBAL_BASE above the 0x0260_0000.. SAB-cell
// window) so those absolute cells are free memory here.
//
//  [unkrt]  BEM_LEVER2_UNKNOWN_RT_SIMD: two lfd'd FPRs flushed at block exit set
//           or clear their shadow-mask bits exactly as Dolphin's
//           ConvertToDouble(ConvertToSingle(x)) == x per lane (both
//           transcribed here), for every exponent 0..2047 x a mantissa set
//           that covers f32-exact / inexact / NaN payloads with and without the
//           low 29 bits, signed zeros, Inf and denormals; and the kill arm
//           produces the same mask.
//  [crsink] BEM_LEVER2_CR_SINK: blocks of cmp / cmpl / cmpi / cmpli / andi. /
//           rlwinm. producers, adjacent and non-adjacent CR-bit bc readers, an
//           SO reader, mid-block exits (CR-bit bc and bdnz), operand clobbers
//           before an exit (the snapshot path), mtctr between, run over many
//           register / XER.SO inputs: the whole ctx, MEM1 window and next PC
//           must equal the kill arm's, and the CR nibbles / GPRs / PC must
//           equal a small PowerPC reference interpreter's.
//  [fmaro]  BEM_LEVER2_FMA_DOUBLE_RO: fmadd / fmsub / fnmadd / fnmsub on doubles
//           inside the fast-path range must equal std::fma bit for bit (random,
//           heavy-cancellation, subnormal-result, exact-zero and searched
//           "double-rounding" vectors); outside the range the lever arm must
//           equal the kill arm (the unchanged emulation runs).
//  [gp]     BEM_LEVER2_GP_FIRST: const-EA gather-pipe store runs and hoisted
//           psq_st / stfs / stw stores to WPAR: the gather-pipe byte stream,
//           the drain fill level (<= 39 bytes at every drain), the host-import
//           log (CPU owner != 0), GPRs and MEM1 must match the kill arm and the
//           reference byte stream, from every starting pipe fill 0..31.
//
// Run: node test_levers_3538.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "bementalJIT/block_cache.h"
#include "guests/powerpc-next/lever_gate.h"
#include "guests/powerpc-next/ppc_analyst.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

extern "C" {
extern unsigned char g_bem_chain_enabled;
extern uint32_t g_bem_lc_base;
extern int g_bem_gp_dirty;
}

static int g_fails = 0, g_checks = 0;
static void expect(bool c, const char* what) {
    ++g_checks;
    if (!c) { ++g_fails; std::printf("[FAIL] %s\n", what); }
    else    std::printf("[ ok ] %s\n", what);
}

static constexpr u32 MASK_CELL  = 0x026B33E0u;   // fpr_reg_cache.cpp BEM_SINGLE_MASK_CELL
static constexpr u32 OWNER_CELL = 0x026A0000u;   // jit_load_store.cpp GP_CPU_OWNER_CELL
static u32 cell(u32 a) { return *reinterpret_cast<volatile u32*>((uintptr_t)a); }
static void set_cell(u32 a, u32 v) { *reinterpret_cast<volatile u32*>((uintptr_t)a) = v; }
static void set_kill2(u32 v) { set_cell(BEM_LEVER_KILL2_CELL, v); }

static u8* g_ctx;
static u8* g_gp;    // gather-pipe staging buffer (ctx+0xC / +0x10 point here)
static u32 ctx32(u32 off) { u32 v; std::memcpy(&v, g_ctx + off, 4); return v; }
static void set32(u32 off, u32 v) { std::memcpy(g_ctx + off, &v, 4); }
static u64 ctx64(u32 off) { u64 v; std::memcpy(&v, g_ctx + off, 8); return v; }
static void set64(u32 off, u64 v) { std::memcpy(g_ctx + off, &v, 8); }

// ---- encoders ---------------------------------------------------------------
static u32 d_form(u32 opcd, u32 rt, u32 ra, s32 d) {
    return (opcd << 26) | (rt << 21) | (ra << 16) | ((u32)d & 0xFFFFu);
}
static u32 cmpi(u32 crf, u32 ra, s32 v)  { return (11u << 26) | (crf << 23) | (ra << 16) | ((u32)v & 0xFFFFu); }
static u32 cmpli(u32 crf, u32 ra, u32 v) { return (10u << 26) | (crf << 23) | (ra << 16) | (v & 0xFFFFu); }
static u32 cmp(u32 crf, u32 ra, u32 rb)  { return (31u << 26) | (crf << 23) | (ra << 16) | (rb << 11); }
static u32 cmpl(u32 crf, u32 ra, u32 rb) { return (31u << 26) | (crf << 23) | (ra << 16) | (rb << 11) | (32u << 1); }
static u32 bc(u32 bo, u32 bi, s32 bd)    { return (16u << 26) | (bo << 21) | (bi << 16) | ((u32)bd & 0xFFFCu); }
static u32 addi(u32 rd, u32 ra, s32 v)   { return d_form(14, rd, ra, v); }
static u32 or_(u32 ra, u32 rs, u32 rb)   { return (31u << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (444u << 1); }
static u32 andi_(u32 ra, u32 rs, u32 v)  { return (28u << 26) | (rs << 21) | (ra << 16) | (v & 0xFFFFu); }
static u32 rlwinm(u32 ra, u32 rs, u32 sh, u32 mb, u32 me, u32 rc) {
    return (21u << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | rc;
}
static u32 mtctr(u32 rs) { return (31u << 26) | (rs << 21) | (9u << 16) | (467u << 1); }
static u32 psq(u32 opcd, u32 fr, u32 ra, s32 d) { return (opcd << 26) | (fr << 21) | (ra << 16) | ((u32)d & 0xFFFu); }
static u32 fma_op(u32 xo, u32 d, u32 a, u32 c, u32 b) {
    return (63u << 26) | (d << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1);
}
static constexpr u32 BLR = 0x4E800020u;

// ---- host imports -------------------------------------------------------------
// MEM1-less slow path: reads return a pattern, writes are logged. The gather
// drain behaves like GPFifo::UpdateGatherPipe (whole 32-byte chunks out, the
// residue moved to the front) and records the fill it saw.
EM_JS(void, install_imports, (u32 ctx), {
    if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
    const env = Module.bemental_imports.env;
    Module.__ctx = ctx >>> 0;
    const log = (k, a, v) => { Module.__log.push([k, a >>> 0, v >>> 0]); };
    env.ppc_read8 = function(a) { log(0, a, 0); return (a * 7) & 0xFF; };
    env.ppc_read16 = function(a) { log(1, a, 0); return (a * 7) & 0xFFFF; };
    env.ppc_read32 = function(a) { log(2, a, 0); return (a * 7) | 0; };
    env.ppc_write8 = function(a, v) { log(3, a, v & 0xFF); };
    env.ppc_write16 = function(a, v) { log(4, a, v & 0xFFFF); };
    env.ppc_write32 = function(a, v) { log(5, a, v >>> 0); };
    env.ppc_interp = function(i, p) { Module.__interp = (Module.__interp | 0) + 1; };
    env.ppc_check_exc = function(p) { return 0; };
    env.ppc_break_block = function(p, x) {};
    env.ppc_hle_check = function(p) { return 0; };
    env.ppc_hle_fire = function(p, i) { return 0; };
    env.ppc_stack_corrupt = function(a, b, c, d) {};
    env.ppc_msr_updated = function(m) {};
    env.ppc_gather_drain = function() {
        const c = Module.__ctx;
        const ptr = HEAPU32[(c + 12) >>> 2] >>> 0, base = HEAPU32[(c + 16) >>> 2] >>> 0;
        const fill = ptr - base;
        if (fill > Module.__gpmax) Module.__gpmax = fill;
        const whole = fill & ~31;
        for (let i = 0; i < whole; i++) Module.__gpout.push(HEAPU8[base + i]);
        for (let i = whole; i < fill; i++) HEAPU8[base + i - whole] = HEAPU8[base + i];
        HEAPU32[(c + 12) >>> 2] = base + (fill - whole);
    };
});
EM_JS(void, js_reset, (), { Module.__log = []; Module.__interp = 0; Module.__gpout = []; Module.__gpmax = 0; });
EM_JS(int, js_log_len, (), { return Module.__log.length; });
EM_JS(u32, js_log_get, (int i, int f), { return Module.__log[i][f] >>> 0; });
EM_JS(int, js_gp_len, (), { return Module.__gpout.length; });
EM_JS(int, js_gp_get, (int i), { return Module.__gpout[i] | 0; });
EM_JS(int, js_gp_max, (), { return Module.__gpmax | 0; });
EM_JS(int, js_interp, (), { return Module.__interp | 0; });

// A compiled block, dispatched as often as needed.
struct Blk {
    BlockCache* cache; u32 pc;
    bool ok = false;
    Blk(BlockCache& c, u32 p, const u32* insts, u32 n, u32 mem1_base, u32 kill2) : cache(&c), pc(p) {
        set_kill2(kill2);
        std::vector<u8> bytes = build_block_next(pc, insts, n, (u32)(uintptr_t)g_ctx, mem1_base,
                                                 0x01FFFFFFu, 0x02000000u);
        set_kill2(0u);
        ok = !bytes.empty() && cache->compile(pc, bytes.data(), bytes.size()) >= 0;
    }
    s32 run() { s32 next = -1; cache->dispatch(pc, &next); return next; }
    ~Blk() { cache->evict(pc); }
};

static void fresh_ctx() {
    std::memset(g_ctx, 0, 0x1400);
    set32(ppc_off::MSR, 0x2000u);
    set32(0x00Cu, (u32)(uintptr_t)g_gp);
    set32(0x010u, (u32)(uintptr_t)g_gp);
}

// ---- Dolphin Interpreter_FPUtils.h transcriptions -----------------------------
static u32 ConvertToSingle(u64 x) {
    const u32 exp = (u32)((x >> 52) & 0x7FF);
    if (exp > 896 || (x & ~0x8000000000000000ull) == 0)
        return (u32)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
    if (exp >= 874) {
        u32 t = (u32)(0x80000000u | ((x & 0x000FFFFFFFFFFFFFull) >> 21));
        t = t >> (905 - exp);
        t |= (u32)((x >> 32) & 0x80000000u);
        return t;
    }
    return (u32)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
}
static u32 ConvertToSingleFTZ(u64 x) {
    const u32 exp = (u32)((x >> 52) & 0x7FF);
    if (exp > 896 || (x & ~0x8000000000000000ull) == 0)
        return (u32)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
    return (u32)((x >> 32) & 0x80000000u);
}
static u64 ConvertToDouble(u32 value) {
    const u64 x = value;
    u64 exp = (x >> 23) & 0xFF;
    u64 frac = x & 0x007FFFFF;
    if (exp > 0 && exp < 255) {
        const u64 y = !(exp >> 7);
        const u64 z = y << 61 | y << 60 | y << 59;
        return ((x & 0xC0000000) << 32) | z | ((x & 0x3FFFFFFF) << 29);
    } else if (exp == 0 && frac != 0) {
        exp = 1023 - 126;
        do { frac <<= 1; exp -= 1; } while ((frac & 0x00800000) == 0);
        return ((x & 0x80000000) << 32) | (exp << 52) | ((frac & 0x007FFFFF) << 29);
    } else {
        const u64 y = exp >> 7;
        const u64 z = y << 61 | y << 60 | y << 59;
        return ((x & 0xC0000000) << 32) | z | ((x & 0x3FFFFFFF) << 29);
    }
}
static bool rt_ok(u64 x) { return ConvertToDouble(ConvertToSingle(x)) == x; }

static u64 g_rng = 0x9E3779B97F4A7C15ull;
static u64 rnd() { g_rng ^= g_rng << 13; g_rng ^= g_rng >> 7; g_rng ^= g_rng << 17; return g_rng; }

// ============================================================================
// [unkrt]
// ============================================================================
static void test_unkrt(u8* mem, u32 mem1_base) {
    const u32 insts[] = { d_form(50, 1, 3, 0), d_form(50, 2, 3, 8), BLR };
    BlockCache cache;
    Blk on(cache, 0x80600000u, insts, 3, mem1_base, 0u);
    Blk off(cache, 0x80600100u, insts, 3, mem1_base, BEM_LEVER2_UNKNOWN_RT_SIMD);
    expect(on.ok && off.ok, "[unkrt] both arms compiled");
    std::vector<u64> v;
    const u64 mant[] = { 0ull, 1ull, 1ull << 28, 1ull << 29, (1ull << 29) - 1, 0x8000000000000ull,
                         0x8000020000000ull, 0xFFFFFFFFFFFFFull, 0xFFFFFE0000000ull, 0x0000020000000ull,
                         0x4000000000000ull | (1ull << 29), 0x123456789ABCDull };
    for (u64 e = 0; e < 2048; ++e)
        for (u64 m : mant)
            for (u64 s = 0; s < 2; ++s) v.push_back((s << 63) | (e << 52) | m);
    for (int k = 0; k < 20000; ++k) {   // f32-exact random values (round-trip true) + noise
        const u64 x = rnd();
        v.push_back(k & 1 ? (x & ~((1ull << 29) - 1)) : x);
    }
    int bad = 0, bad_kill = 0, cases = 0;
    const u32 r3 = 0x80400000u;
    u8* m = mem + (r3 & 0x01FFFFFFu);
    // Two passes: arbitrary partner lanes, then partners fixed at 1.0 (always
    // round-trip exact) so each mask bit depends on the lfd'd lane alone.
    for (size_t ii = 0; ii < 2 * v.size(); ++ii) {
        const size_t i = ii % v.size();
        const bool solo = ii >= v.size();
        const u64 a0 = v[i], b0 = v[(i * 7 + 3) % v.size()];
        const u64 a1 = solo ? 0x3FF0000000000000ull : v[(i * 13 + 5) % v.size()];
        const u64 b1 = solo ? 0x3FF0000000000000ull : v[(i * 31 + 11) % v.size()];
        for (int arm = 0; arm < 2; ++arm) {
            fresh_ctx();
            set32(ppc_off::gpr(3), r3);
            set64(ppc_off::ps1(1), a1);
            set64(ppc_off::ps1(2), b1);
            for (u32 k = 0; k < 8; ++k) { m[k] = (u8)(a0 >> (56 - 8 * k)); m[8 + k] = (u8)(b0 >> (56 - 8 * k)); }
            const u32 pre = (u32)rnd();
            set_cell(MASK_CELL, pre);
            js_reset();
            (arm ? off : on).run();
            u32 want = pre & ~6u;
            if (rt_ok(a0) && rt_ok(a1)) want |= 2u;
            if (rt_ok(b0) && rt_ok(b1)) want |= 4u;
            const bool ok = cell(MASK_CELL) == want && ctx64(ppc_off::ps0(1)) == a0 &&
                            ctx64(ppc_off::ps0(2)) == b0;
            if (!ok) {
                if ((arm ? bad_kill : bad) == 0)
                    std::printf("  [unkrt%s] f1=%016llx/%016llx f2=%016llx/%016llx mask %08x want %08x\n",
                                arm ? " kill" : "", (unsigned long long)a0, (unsigned long long)a1,
                                (unsigned long long)b0, (unsigned long long)b1, cell(MASK_CELL), want);
                (arm ? bad_kill : bad)++;
            }
        }
        ++cases;
    }
    char what[160];
    std::snprintf(what, sizeof what, "[unkrt] %d lfd pairs: mask bits == CTD(CTS(x)) == x per lane (%d bad)", cases, bad);
    expect(bad == 0, what);
    std::snprintf(what, sizeof what, "[unkrt] kill arm agrees (%d bad)", bad_kill);
    expect(bad_kill == 0, what);
}

// ============================================================================
// [crsink]  reference interpreter over the opcodes the programs use.
// ============================================================================
struct RefCpu {
    u32 gpr[32]; u32 cr[8];   // nibble: 8 LT 4 GT 2 EQ 1 SO
    u32 ctr, lr, so;
    std::vector<std::pair<u32, u32>> stores;   // (EA, value) word stores to MEM1
    u8* mem;
    u32 rd32(u32 ea) { const u8* p = mem + (ea & 0x01FFFFFFu); return (u32)p[0] << 24 | (u32)p[1] << 16 | (u32)p[2] << 8 | p[3]; }
    void wr32(u32 ea, u32 v) { u8* p = mem + (ea & 0x01FFFFFFu); p[0] = (u8)(v >> 24); p[1] = (u8)(v >> 16); p[2] = (u8)(v >> 8); p[3] = (u8)v; }
    void setcr(u32 f, bool lt, bool gt, bool eq) { cr[f] = (lt ? 8u : 0u) | (gt ? 4u : 0u) | (eq ? 2u : 0u) | so; }
    void rc0(u32 v) { setcr(0, (s32)v < 0, (s32)v > 0, v == 0); }
    bool crbit(u32 bi) { return (cr[bi / 4] >> (3 - bi % 4)) & 1u; }
    // returns next PC
    u32 run(u32 pc, const u32* insts, u32 n) {
        for (u32 i = 0; i < n; ++i) {
            const u32 w = insts[i], op = w >> 26, rd = (w >> 21) & 31, ra = (w >> 16) & 31, rb = (w >> 11) & 31;
            const s32 simm = (s16)(w & 0xFFFF); const u32 uimm = w & 0xFFFF;
            const u32 at = pc + 4 * i;
            switch (op) {
            case 11: { const u32 f = rd >> 2; const s32 a = (s32)gpr[ra]; setcr(f, a < simm, a > simm, a == simm); break; }
            case 10: { const u32 f = rd >> 2; const u32 a = gpr[ra]; setcr(f, a < uimm, a > uimm, a == uimm); break; }
            case 14: gpr[rd] = (ra ? gpr[ra] : 0) + (u32)simm; break;
            case 15: gpr[rd] = (ra ? gpr[ra] : 0) + ((u32)simm << 16); break;
            case 28: gpr[ra] = gpr[rd] & uimm; rc0(gpr[ra]); break;
            case 21: {
                const u32 sh = rb, mb = (w >> 6) & 31, me = (w >> 1) & 31;
                const u32 r = (gpr[rd] << sh) | (sh ? gpr[rd] >> (32 - sh) : 0);
                u32 mask = 0; for (u32 b = mb;; b = (b + 1) & 31) { mask |= 0x80000000u >> b; if (b == me) break; }
                gpr[ra] = r & mask; if (w & 1) rc0(gpr[ra]); break; }
            case 32: gpr[rd] = rd32((ra ? gpr[ra] : 0) + (u32)simm); break;
            case 36: { const u32 ea = (ra ? gpr[ra] : 0) + (u32)simm; wr32(ea, gpr[rd]); break; }
            case 16: {
                const u32 bo = rd, bi = ra;
                bool ctr_ok = true, cond_ok = true;
                if (!(bo & 4)) { ctr = ctr - 1; ctr_ok = ((ctr != 0) ^ ((bo >> 1) & 1)); }
                if (!(bo & 16)) cond_ok = crbit(bi) == ((bo >> 3) & 1);
                if (ctr_ok && cond_ok) return at + (u32)(s32)(s16)(w & 0xFFFC);
                break; }
            case 31: {
                const u32 xo = (w >> 1) & 0x3FF;
                if (xo == 0) { const u32 f = rd >> 2; const s32 a = (s32)gpr[ra], b = (s32)gpr[rb]; setcr(f, a < b, a > b, a == b); }
                else if (xo == 32) { const u32 f = rd >> 2; const u32 a = gpr[ra], b = gpr[rb]; setcr(f, a < b, a > b, a == b); }
                else if (xo == 444) { gpr[ra] = gpr[rd] | gpr[rb]; if (w & 1) rc0(gpr[ra]); }
                else if (xo == 467) ctr = gpr[rd];
                break; }
            case 19: return lr & ~3u;
            }
        }
        return pc + 4 * n;
    }
};

static u32 cr_nibble_from_ctx(u32 f) {
    const u32 lo = ctx32(ppc_off::cr(f)), hi = ctx32(ppc_off::cr(f) + 4);
    const u32 lt = (hi >> 30) & 1u, gt = ((hi & 0x80000000u) == 0u && (hi | lo) != 0u) ? 1u : 0u;
    const u32 eq = lo == 0u ? 1u : 0u, so = (hi >> 27) & 1u;
    return lt << 3 | gt << 2 | eq << 1 | so;
}

static void test_crsink(u8* mem, u32 mem1_base) {
    set_cell(MASK_CELL, 0u);
    // Exits land far past the block (forward bc, coalesced mid-block exits).
    const u32 E = 0x400;
    const u32 P1[] = {
        cmpi(0, 3, 10),          //  0 producer cr0 (r3)
        bc(12, 2, E),            //  1 beq  — adjacent fused reader + exit
        addi(4, 4, 1),           //  2
        d_form(36, 4, 10, 0),    //  3 stw r4,0(r10)
        bc(12, 0, E + 8),        //  4 blt  — later reader of pending cr0
        cmpl(1, 3, 5),           //  5 producer cr1 (r3, r5)
        or_(3, 6, 6),            //  6 mr r3,r6 — clobbers cr0's AND cr1's operand
        bc(12, 5, E + 16),       //  7 bgt cr1 — exit after the clobber (snapshot)
        d_form(32, 7, 10, 4),    //  8 lwz r7,4(r10)
        andi_(8, 7, 3),          //  9 andi. — overwrites cr0 (Rc producer)
        bc(12, 2, E + 24),       // 10 beq  — reads the Rc producer
        mtctr(8),                // 11 mtctr r8
        cmpli(1, 8, 2),          // 12 overwrites cr1
        cmp(0, 7, 4),            // 13 overwrites cr0
        bc(18, 0, E + 32),       // 14 bdz — exit (pending cr0 + cr1 stored)
        rlwinm(9, 7, 1, 0, 30, 1), // 15 rlwinm. — overwrites cr0
        bc(4, 1, E + 40),        // 16 ble — reads it
        cmpi(0, 9, -5),          // 17 overwrites cr0
        bc(4, 3, E + 48),        // 18 bns — SO reader: cmp 17 stays eager
        cmpi(1, 4, 7),           // 19 overwrites cr1, eager store followed by...
        cmpi(0, 4, 100),         // 20 ... a cr0 overwrite with no reader
        addi(11, 4, 3),          // 21
        cmpli(0, 11, 9),         // 22 overwrites cr0
        bc(12, 1, E + 56),       // 23 bgt
        cmpi(0, 3, 0),           // 24 final producer: live at the block end
        BLR,
    };
    // P2: no cr0 store before an SO reader — the ctx field still holds the
    // pre-block value (SO = 0), so reading SO from memory would be wrong when
    // XER.SO = 1: the producer must stay eager.
    const u32 P2[] = {
        cmpi(0, 3, 5),           //  0
        bc(12, 3, E),            //  1 bso — SO reader adjacent to its producer
        cmpi(0, 4, 7),           //  2 overwrites cr0
        bc(12, 2, E + 8),        //  3 beq
        cmpi(0, 3, 0),           //  4
        BLR,
    };
    struct Prog { const u32* p; u32 n; };
    const Prog progs[] = { { P1, (u32)(sizeof P1 / sizeof P1[0]) }, { P2, (u32)(sizeof P2 / sizeof P2[0]) } };
    for (const Prog& prog : progs) {
    const u32* const P = prog.p;
    const u32 n1 = prog.n;
    const u32 pc = 0x80610000u;
    const u32 r10 = 0x80500000u;
    u8* m = mem + (r10 & 0x01FFFFFFu);
    const s32 vals[] = { 10, 9, 11, -5, 0, 1, 2, 3, 7, 8, 100, -1, (s32)0x80000000, 0x7FFFFFFF, 6, 5,
                         (s32)0x80000002, (s32)0xFFFFFFF2, (s32)0x80000003, -6 };
    const u32 nv = sizeof vals / sizeof vals[0];
    struct In { u32 r3, r4, r5, r6, word, so, ctr0; };
    std::vector<In> ins;
    for (u32 so = 0; so < 2; ++so)
        for (u32 a = 0; a < nv; ++a)
            for (u32 b = 0; b < nv; ++b)
                for (u32 c = 0; c < 4; ++c)
                    ins.push_back({ (u32)vals[a], (u32)vals[b], (u32)vals[(a + b + c) % nv],
                                    (u32)vals[(a * 3 + c) % nv], (u32)vals[(b * 5 + c) % nv], so,
                                    c == 3 ? 1u : 2u + c });
    auto setup = [&](const In& x) {
        fresh_ctx();
        set32(ppc_off::gpr(3), x.r3); set32(ppc_off::gpr(4), x.r4); set32(ppc_off::gpr(5), x.r5);
        set32(ppc_off::gpr(6), x.r6); set32(ppc_off::gpr(10), r10);
        set32(ppc_off::ctr_off(), x.ctr0); set32(ppc_off::lr_off(), 0x80123450u);
        g_ctx[ppc_off::XER_SO_OV] = (u8)(x.so << 1);
        for (u32 k = 0; k < 16; ++k) m[k] = 0;
        m[4] = (u8)(x.word >> 24); m[5] = (u8)(x.word >> 16); m[6] = (u8)(x.word >> 8); m[7] = (u8)x.word;
    };
    // Both arms at the SAME pc (exits are pc-relative): one pass each.
    std::vector<s32> next[2];
    std::vector<u8> ctxs[2], mems[2];
    BlockCache cache;
    for (int arm = 0; arm < 2; ++arm) {
        Blk blk(cache, pc, P, n1, mem1_base, arm ? BEM_LEVER2_CR_SINK : 0u);
        expect(blk.ok, arm ? "[crsink] kill arm compiled" : "[crsink] lever arm compiled");
        for (const In& x : ins) {
            setup(x);
            js_reset();
            next[arm].push_back(blk.run());
            ctxs[arm].insert(ctxs[arm].end(), g_ctx, g_ctx + 0x1400);
            mems[arm].insert(mems[arm].end(), m, m + 16);
        }
    }
    int bad_diff = 0, bad_ref = 0;
    for (size_t k = 0; k < ins.size(); ++k) {
        const In& x = ins[k];
        const u8* c0 = &ctxs[0][k * 0x1400];
        const u8* c1 = &ctxs[1][k * 0x1400];
        const bool same = next[0][k] == next[1][k] && std::memcmp(c0, c1, 0x1400) == 0 &&
                          std::memcmp(&mems[0][k * 16], &mems[1][k * 16], 16) == 0;
        if (!same) {
            if (!bad_diff) {
                std::printf("  [crsink] r3=%08x r4=%08x r5=%08x r6=%08x w=%08x so=%u ctr=%u next %08x/%08x\n",
                            x.r3, x.r4, x.r5, x.r6, x.word, x.so, x.ctr0, next[0][k], next[1][k]);
                for (u32 o = 0; o < 0x1400; o += 4) {
                    u32 p0, p1; std::memcpy(&p0, c0 + o, 4); std::memcpy(&p1, c1 + o, 4);
                    if (p0 != p1) std::printf("    ctx+%03x lever %08x kill %08x\n", o, p0, p1);
                }
            }
            ++bad_diff;
        }
        // reference interpreter
        setup(x);
        RefCpu ref{};
        ref.mem = mem;
        ref.gpr[3] = x.r3; ref.gpr[4] = x.r4; ref.gpr[5] = x.r5; ref.gpr[6] = x.r6; ref.gpr[10] = r10;
        ref.ctr = x.ctr0; ref.lr = 0x80123450u; ref.so = x.so;
        for (u32 f = 0; f < 8; ++f) ref.cr[f] = 2u;   // a zeroed ctx field decodes as EQ
        const u32 rnext = ref.run(pc, P, n1);
        std::memcpy(g_ctx, c0, 0x1400);
        bool rok = (u32)next[0][k] == rnext;
        for (u32 r = 3; r <= 11; ++r) rok &= ctx32(ppc_off::gpr(r)) == ref.gpr[r];
        for (u32 f = 0; f < 2; ++f) rok &= cr_nibble_from_ctx(f) == ref.cr[f];
        rok &= ctx32(ppc_off::ctr_off()) == ref.ctr;
        rok &= std::memcmp(&mems[0][k * 16], m, 16) == 0;
        if (!rok) {
            if (!bad_ref)
                std::printf("  [crsink ref] r3=%08x r4=%08x r5=%08x r6=%08x w=%08x so=%u ctr=%u next %08x want %08x cr0 %x/%x cr1 %x/%x\n",
                            x.r3, x.r4, x.r5, x.r6, x.word, x.so, x.ctr0, next[0][k], rnext,
                            cr_nibble_from_ctx(0), ref.cr[0], cr_nibble_from_ctx(1), ref.cr[1]);
            ++bad_ref;
        }
    }
    char what[160];
    std::snprintf(what, sizeof what, "[crsink P%d] %zu runs: ctx / MEM1 / next PC == kill arm (%d bad)",
                  P == P1 ? 1 : 2, ins.size(), bad_diff);
    expect(bad_diff == 0, what);
    std::snprintf(what, sizeof what, "[crsink P%d] %zu runs: GPRs / cr0 / cr1 / CTR / PC == reference (%d bad)",
                  P == P1 ? 1 : 2, ins.size(), bad_ref);
    expect(bad_ref == 0, what);
    }
}

// ============================================================================
// [fmaro]
// ============================================================================
static double dbl(u64 b) { double d; std::memcpy(&d, &b, 8); return d; }
static u64 bits(double d) { u64 b; std::memcpy(&b, &d, 8); return b; }
static u64 mk(u64 s, u64 e, u64 m) { return (s << 63) | (e << 52) | (m & 0xFFFFFFFFFFFFFull); }
static bool in_range(u64 a, u64 c, u64 b) {
    auto ex = [](u64 x) { return (x >> 52) & 0x7FF; };
    return ex(a) >= 543 && ex(a) <= 1503 && ex(c) >= 543 && ex(c) <= 1503 && ex(b) >= 63 && ex(b) <= 1983;
}
// The textbook alternative without round-to-odd (RN(th + RN(tl + ul))): the
// search below keeps vectors where it is wrong, so a JIT arm that lost its RO
// step fails on them.
static double naive_fma(double a, double c, double b) {
    const double S = 134217729.0;
    auto split = [&](double x, double& hi, double& lo) { const double t = S * x; hi = t - (t - x); lo = x - hi; };
    double ah, al, ch, cl; split(a, ah, al); split(c, ch, cl);
    const double uh = a * c;
    const double ul = ((ah * ch - uh) + ah * cl + al * ch) + al * cl;
    const double th = b + uh, bb = th - b, tl = (b - (th - bb)) + (uh - bb);
    return th + (tl + ul);
}

static void test_fmaro(u8* mem, u32 mem1_base) {
    set_cell(MASK_CELL, 0u);
    // f4 = fmadd(f1,f3,f2)  f5 = fmsub  f6 = fnmadd  f7 = fnmsub
    const u32 insts[] = { fma_op(29, 4, 1, 3, 2), fma_op(28, 5, 1, 3, 2), fma_op(31, 6, 1, 3, 2),
                          fma_op(30, 7, 1, 3, 2), BLR };
    BlockCache cache;
    Blk on(cache, 0x80620000u, insts, 5, mem1_base, 0u);
    Blk off(cache, 0x80620100u, insts, 5, mem1_base, BEM_LEVER2_FMA_DOUBLE_RO);
    expect(on.ok && off.ok, "[fmaro] both arms compiled");
    struct V { u64 a, c, b; };
    std::vector<V> vs;
    auto rexp = [](u64 lo, u64 hi) { return lo + rnd() % (hi - lo + 1); };
    for (int k = 0; k < 40000; ++k)   // random inside the range
        vs.push_back({ mk(rnd() & 1, rexp(543, 1503), rnd()), mk(rnd() & 1, rexp(543, 1503), rnd()),
                       mk(rnd() & 1, rexp(63, 1983), rnd()) });
    for (int k = 0; k < 40000; ++k) {  // product and addend of similar size, heavy cancellation
        const u64 a = mk(rnd() & 1, rexp(700, 1300), rnd()), c = mk(rnd() & 1, rexp(700, 1300), rnd());
        const double p = dbl(a) * dbl(c);
        u64 b = bits(-p);
        b += (u64)((s64)(rnd() % 9) - 4);
        if (k & 1) b ^= rnd() & 0xFFFFFFull;
        vs.push_back({ a, c, b });
    }
    for (int k = 0; k < 20000; ++k) {  // tiny results: subnormal and near-subnormal outcomes
        const u64 a = mk(rnd() & 1, rexp(543, 560), rnd()), c = mk(rnd() & 1, rexp(543, 560), rnd());
        const double p = dbl(a) * dbl(c);
        u64 b = bits(-p);
        if ((b >> 52 & 0x7FF) < 63) continue;
        b += (u64)((s64)(rnd() % 5) - 2);
        vs.push_back({ a, c, b });
    }
    for (int k = 0; k < 2000; ++k) {   // exact zero: a*c exact, b = -(a*c)
        const u64 a = mk(rnd() & 1, rexp(800, 1200), rnd() & ~0xFFFFFFFull);
        const u64 c = mk(rnd() & 1, rexp(800, 1200), rnd() & ~0xFFFFFFFull);
        vs.push_back({ a, c, bits(-(dbl(a) * dbl(c))) });
    }
    int hard = 0;
    for (int k = 0; k < 2000000 && hard < 3000; ++k) {   // near-midpoint results
        // b = (+-ulp(uh)/2 - ul) nudged by a few ulps: a*c + b lands on or
        // within a few ulp(b) of a midpoint of uh's binade.
        const u64 a = mk(rnd() & 1, rexp(900, 1100), rnd()), c = mk(rnd() & 1, rexp(900, 1100), rnd());
        const double uh = dbl(a) * dbl(c), ul = std::fma(dbl(a), dbl(c), -uh);
        if (ul == 0.0) continue;
        const double half = std::ldexp(1.0, std::ilogb(uh) - 53) * ((rnd() & 1) ? 1.0 : -1.0);
        u64 b = bits(half - ul);
        b += (u64)((s64)(rnd() % 7) - 3);
        if (!in_range(a, c, b)) continue;
        if (bits(naive_fma(dbl(a), dbl(c), dbl(b))) != bits(std::fma(dbl(a), dbl(c), dbl(b)))) {
            vs.push_back({ a, c, b }); ++hard;
        }
    }
    for (int k = 0; k < 1000000 && hard < 6000; ++k) {   // searched double-rounding cases
        const u64 a = mk(rnd() & 1, rexp(900, 1100), rnd()), c = mk(rnd() & 1, rexp(900, 1100), rnd());
        const double p = dbl(a) * dbl(c);
        const int sh = 1 + (int)(rnd() % 60);
        double b = -p + std::ldexp((double)(s64)(rnd() % 2001 - 1000), std::ilogb(p) - sh);
        b = (rnd() & 1) ? b : -b - 2 * p;
        if (!in_range(a, c, bits(b))) continue;
        if (bits(naive_fma(dbl(a), dbl(c), b)) != bits(std::fma(dbl(a), dbl(c), b))) {
            vs.push_back({ a, c, bits(b) }); ++hard;
        }
    }
    // range edges and just outside (the unchanged emulation)
    const u64 ea[] = { 542, 543, 1503, 1504, 1, 0, 2046, 2047, 1023 }, eb[] = { 62, 63, 1983, 1984, 0, 1, 2046, 2047, 1023 };
    for (u64 x : ea) for (u64 y : ea) for (u64 z : eb)
        for (int r = 0; r < 3; ++r)
            vs.push_back({ mk(rnd() & 1, x, rnd()), mk(rnd() & 1, y, rnd()), mk(rnd() & 1, z, rnd()) });
    int bad = 0, bad_kill = 0, cases = 0, inr = 0, old_vs_fma = 0;
    for (const V& v : vs) {
        u64 got[2][4];
        for (int arm = 0; arm < 2; ++arm) {
            fresh_ctx();
            set64(ppc_off::ps0(1), v.a); set64(ppc_off::ps0(3), v.c); set64(ppc_off::ps0(2), v.b);
            js_reset();
            (arm ? off : on).run();
            for (u32 k = 0; k < 4; ++k) got[arm][k] = ctx64(ppc_off::ps0(4 + k));
        }
        ++cases;
        const double a = dbl(v.a), c = dbl(v.c), b = dbl(v.b);
        if (in_range(v.a, v.c, v.b)) {
            ++inr;
            const double r0 = std::fma(a, c, b), r1 = std::fma(a, c, -b);
            const u64 want[4] = { bits(r0), bits(r1), bits(-r0), bits(-r1) };
            bool ok = true, okk = true;
            for (u32 k = 0; k < 4; ++k) { ok &= got[0][k] == want[k]; okk &= got[1][k] == want[k]; }
            if (!ok) {
                if (!bad) std::printf("  [fmaro] a=%016llx c=%016llx b=%016llx: got %016llx want %016llx\n",
                                      (unsigned long long)v.a, (unsigned long long)v.c, (unsigned long long)v.b,
                                      (unsigned long long)got[0][0], (unsigned long long)want[0]);
                ++bad;
            }
            if (!okk) ++old_vs_fma;
        } else {
            // A NaN input's result NaN is whichever NaN the engine's add/mul
            // propagates, which may differ between two compilations of the
            // same (unchanged) code; the lever never admits a NaN input.
            auto isnan64 = [](u64 x) { return (x & 0x7FF0000000000000ull) == 0x7FF0000000000000ull &&
                                              (x & 0x000FFFFFFFFFFFFFull) != 0; };
            const bool nan_in = isnan64(v.a) || isnan64(v.b) || isnan64(v.c);
            bool same = true;
            for (u32 k = 0; k < 4; ++k)
                same &= got[0][k] == got[1][k] || (nan_in && isnan64(got[0][k]) && isnan64(got[1][k]));
            if (!same) {
                if (!bad_kill) std::printf("  [fmaro out] a=%016llx c=%016llx b=%016llx: on %016llx kill %016llx\n",
                                           (unsigned long long)v.a, (unsigned long long)v.c, (unsigned long long)v.b,
                                           (unsigned long long)got[0][0], (unsigned long long)got[1][0]);
                ++bad_kill;
            }
        }
    }
    char what[200];
    std::snprintf(what, sizeof what, "[fmaro] %d in-range vectors (%d searched hard): all four forms == std::fma (%d bad)",
                  inr, hard, bad);
    expect(bad == 0, what);
    std::snprintf(what, sizeof what, "[fmaro] %d out-of-range vectors == kill arm (%d bad)", cases - inr, bad_kill);
    expect(bad_kill == 0, what);
    std::printf("  [fmaro] info: the kill arm (old emulation) differs from std::fma on %d of %d in-range vectors\n",
                old_vs_fma, inr);
    expect(hard >= 100, "[fmaro] the search found >= 100 vectors where RN(th + RN(tl + ul)) != fma");
}

// ============================================================================
// [gp]
// ============================================================================
struct GpResult { std::vector<u8> stream; int gpmax; std::vector<u32> log; u8 ctx[0x1400]; u8 mem[64]; };

static void test_gp(u8* mem, u32 mem1_base) {
    set_cell(MASK_CELL, 0u);
    // G1: const-EA WPAR stores (lis r5,0xCC01; d = -0x8000): a run of 4, a lone
    // store, a run of 2.
    const u32 G1[] = {
        d_form(15, 5, 0, 0xCC01),
        d_form(38, 3, 5, -0x8000), d_form(44, 4, 5, -0x8000), d_form(36, 6, 5, -0x8000),
        d_form(36, 7, 5, -0x8000),
        addi(8, 8, 1),
        d_form(38, 3, 5, -0x8000),
        addi(8, 8, 1),
        d_form(36, 6, 5, -0x8000), d_form(44, 4, 5, -0x8000),
        BLR,
    };
    // G2: dynamic-EA stores through r4 (WPAR, RAM, or other MMIO): psq_st of a
    // Single (psq_l'd) and of a Double (lfd'd) pair, stfs, stw.
    const u32 G2[] = {
        psq(56, 1, 9, 0), d_form(50, 2, 9, 8), d_form(50, 3, 9, 16),
        psq(60, 1, 4, 0), psq(60, 2, 4, 0), d_form(52, 3, 4, 0), d_form(36, 6, 4, 0),
        psq(60, 1, 4, 0),
        BLR,
    };
    BlockCache cache;
    Blk g1on(cache, 0x80630000u, G1, sizeof G1 / 4, mem1_base, 0u);
    Blk g1off(cache, 0x80630100u, G1, sizeof G1 / 4, mem1_base, BEM_LEVER2_GP_FIRST);
    Blk g2on(cache, 0x80630200u, G2, sizeof G2 / 4, mem1_base, 0u);
    Blk g2off(cache, 0x80630300u, G2, sizeof G2 / 4, mem1_base, BEM_LEVER2_GP_FIRST);
    expect(g1on.ok && g1off.ok && g2on.ok && g2off.ok, "[gp] all arms compiled");
    u8 pre[32];
    for (u32 i = 0; i < 32; ++i) pre[i] = (u8)(0xA0 + i);
    const u32 r9 = 0x80520000u;
    u8* m9 = mem + (r9 & 0x01FFFFFFu);
    const u32 r4_ram = 0x80530000u;
    u8* m4 = mem + (r4_ram & 0x01FFFFFFu);
    int bad = 0, bad_ref = 0, bad_fill = 0, cases = 0;
    auto be32 = [](std::vector<u8>& s, u32 v) { for (int k = 3; k >= 0; --k) s.push_back((u8)(v >> (8 * k))); };
    const u32 f32s[] = { 0x3F800000u, 0x00400000u, 0x80000001u, 0xC2F60000u, 0x7F800000u, 0x7FC00001u, 0x00800000u };
    for (u32 owner = 0; owner < 2; ++owner)
    for (u32 fill = 0; fill < 32; ++fill)
    for (u32 vi = 0; vi < 7; ++vi) {
        const u32 r3 = 0x11 + vi, r4v = 0x2233 + vi * 0x101, r6 = 0x44556677u + vi, r7 = 0x8899AABBu ^ vi;
        // ---- G1
        GpResult A, B;
        for (int arm = 0; arm < 2; ++arm) {
            GpResult& R = arm ? B : A;
            fresh_ctx();
            set32(ppc_off::gpr(3), r3); set32(ppc_off::gpr(4), r4v);
            set32(ppc_off::gpr(6), r6); set32(ppc_off::gpr(7), r7);
            for (u32 i = 0; i < fill; ++i) g_gp[i] = pre[i];
            set32(0x00Cu, (u32)(uintptr_t)g_gp + fill);
            set_cell(OWNER_CELL, owner);
            g_bem_gp_dirty = 0;
            js_reset();
            (arm ? g1off : g1on).run();
            const u32 ptr = ctx32(0x00Cu), base = (u32)(uintptr_t)g_gp;
            R.stream.clear();
            for (int i = 0; i < js_gp_len(); ++i) R.stream.push_back((u8)js_gp_get(i));
            for (u32 i = base; i < ptr; ++i) R.stream.push_back(g_gp[i - base]);
            R.gpmax = js_gp_max();
            R.log.clear();
            for (int i = 0; i < js_log_len(); ++i) for (int f = 0; f < 3; ++f) R.log.push_back(js_log_get(i, f));
            std::memcpy(R.ctx, g_ctx, 0x1400);
            set_cell(OWNER_CELL, 0u);
        }
        ++cases;
        std::vector<u8> want(pre, pre + fill);
        if (!owner) {
            want.push_back((u8)r3); want.push_back((u8)(r4v >> 8)); want.push_back((u8)r4v);
            be32(want, r6); be32(want, r7); want.push_back((u8)r3); be32(want, r6);
            want.push_back((u8)(r4v >> 8)); want.push_back((u8)r4v);
        }
        if (A.stream != B.stream || A.log != B.log || std::memcmp(A.ctx + 0x14, B.ctx + 0x14, 0x80) != 0) {
            if (!bad) std::printf("  [gp G1] owner=%u fill=%u v=%u: stream %zu/%zu log %zu/%zu\n", owner, fill, vi,
                                  A.stream.size(), B.stream.size(), A.log.size(), B.log.size());
            ++bad;
        }
        if (A.stream != want) {
            if (!bad_ref) std::printf("  [gp G1 ref] owner=%u fill=%u v=%u: %zu bytes, want %zu\n", owner, fill, vi,
                                      A.stream.size(), want.size());
            ++bad_ref;
        }
        // the run of 4 appends 11 bytes before its one check: <= 31 + 11
        if (A.gpmax > 42) { if (!bad_fill) std::printf("  [gp G1] drain saw %d bytes\n", A.gpmax); ++bad_fill; }
        // ---- G2, three bases
        for (u32 bsel = 0; bsel < 3; ++bsel) {
            const u32 r4 = bsel == 0 ? 0xCC008000u : bsel == 1 ? r4_ram : 0xCC003000u;
            const u32 s0 = f32s[vi], s1 = f32s[(vi + 3) % 7];
            const u64 d2 = ConvertToDouble(f32s[(vi + 1) % 7]) ^ (vi & 1 ? 0x10000000ull : 0ull);
            const u64 d2b = ConvertToDouble(f32s[(vi + 5) % 7]);
            const u64 d3 = 0x400921FB54442D18ull + vi;
            GpResult C, D;
            for (int arm = 0; arm < 2; ++arm) {
                GpResult& R = arm ? D : C;
                fresh_ctx();
                set32(ppc_off::gpr(4), r4); set32(ppc_off::gpr(6), r6); set32(ppc_off::gpr(9), r9);
                set64(ppc_off::ps1(2), d2b);
                for (u32 k = 0; k < 4; ++k) { m9[k] = (u8)(s0 >> (24 - 8 * k)); m9[4 + k] = (u8)(s1 >> (24 - 8 * k)); }
                for (u32 k = 0; k < 8; ++k) { m9[8 + k] = (u8)(d2 >> (56 - 8 * k)); m9[16 + k] = (u8)(d3 >> (56 - 8 * k)); }
                for (u32 k = 0; k < 64; ++k) m4[k] = 0;
                for (u32 i = 0; i < fill; ++i) g_gp[i] = pre[i];
                set32(0x00Cu, (u32)(uintptr_t)g_gp + fill);
                set_cell(OWNER_CELL, owner);
                g_bem_gp_dirty = 0;
                js_reset();
                (arm ? g2off : g2on).run();
                const u32 ptr = ctx32(0x00Cu), base = (u32)(uintptr_t)g_gp;
                R.stream.clear();
                for (int i = 0; i < js_gp_len(); ++i) R.stream.push_back((u8)js_gp_get(i));
                for (u32 i = base; i < ptr; ++i) R.stream.push_back(g_gp[i - base]);
                R.gpmax = js_gp_max();
                R.log.clear();
                for (int i = 0; i < js_log_len(); ++i) for (int f = 0; f < 3; ++f) R.log.push_back(js_log_get(i, f));
                std::memcpy(R.ctx, g_ctx, 0x1400);
                std::memcpy(R.mem, m4, 64);
                set_cell(OWNER_CELL, 0u);
            }
            ++cases;
            if (C.stream != D.stream || C.log != D.log || std::memcmp(C.ctx, D.ctx, 0x1400) != 0 ||
                std::memcmp(C.mem, D.mem, 64) != 0) {
                if (!bad) std::printf("  [gp G2] base=%08x owner=%u fill=%u v=%u: stream %zu/%zu log %zu/%zu\n",
                                      r4, owner, fill, vi, C.stream.size(), D.stream.size(), C.log.size(), D.log.size());
                ++bad;
            }
            if (bsel == 0) {
                std::vector<u8> w2(pre, pre + fill);
                if (!owner) {
                    auto ftz = [](u32 x) { return (x & 0x7F800000u) == 0u ? (x & 0x80000000u) : x; };
                    be32(w2, ftz(s0)); be32(w2, ftz(s1));
                    be32(w2, ConvertToSingleFTZ(d2)); be32(w2, ConvertToSingleFTZ(d2b));
                    be32(w2, ConvertToSingle(d3)); be32(w2, r6);
                    be32(w2, ftz(s0)); be32(w2, ftz(s1));
                }
                if (C.stream != w2) {
                    if (!bad_ref) std::printf("  [gp G2 ref] owner=%u fill=%u v=%u: %zu bytes want %zu\n", owner,
                                              fill, vi, C.stream.size(), w2.size());
                    ++bad_ref;
                }
                if (C.gpmax > 39) { if (!bad_fill) std::printf("  [gp G2] drain saw %d bytes\n", C.gpmax); ++bad_fill; }
            }
        }
    }
    char what[160];
    std::snprintf(what, sizeof what, "[gp] %d runs: stream / import log / ctx / MEM1 == kill arm (%d bad)", cases, bad);
    expect(bad == 0, what);
    std::snprintf(what, sizeof what, "[gp] WPAR runs: byte stream == reference (%d bad)", bad_ref);
    expect(bad_ref == 0, what);
    std::snprintf(what, sizeof what, "[gp] every drain saw <= 31 + (bytes since the last check) pipe bytes (%d bad)", bad_fill);
    expect(bad_fill == 0, what);
}

int main() {
    g_ctx = (u8*)std::calloc(1, 0x1400 + 0x100);
    g_gp = (u8*)std::calloc(1, 1024);
    install_imports((u32)(uintptr_t)g_ctx);
    g_hle_hook_query = [](uint32_t) -> bool { return false; };
    g_bem_chain_enabled = 1u;
    u8* lc = (u8*)std::calloc(1, 0x40000);
    g_bem_lc_base = (u32)(uintptr_t)lc;   // the live configuration: lc-gated arms on
    u8* mem = (u8*)std::malloc(0x02010000u);
    if (!mem || !lc) { std::printf("[FAIL] alloc\n"); return 1; }
    std::memset(mem, 0, 0x02010000u);
    const u32 base = (u32)(uintptr_t)mem;
    for (u32 a = 0x026B3EE0u; a < 0x026B3F00u; a += 4) set_cell(a, 0u);

    test_unkrt(mem, base);
    test_crsink(mem, base);
    test_fmaro(mem, base);
    test_gp(mem, base);

    const bool ok = g_fails == 0;
    std::printf("[%s] TOTAL %d/%d checks\n", ok ? "PASS" : "FAIL", g_checks - g_fails, g_checks);
    return ok ? 0 : 1;
}
