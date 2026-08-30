// test_simd_bswap.cpp — bit-exactness gate for the [simd-bswap 2026-08-29]
// SIMD byte-swap on the adjacent-word-pair memory ops (jit_load_store.cpp).
//
// WHY THIS FILE EXISTS: the change replaces two 11-op emit_bswap_i32 calls (and,
// on psq_st, the two-lane scalar ConvertToSingleFTZ ladder) with one
// i8x16.shuffle over a v128. Byte order is precisely what it touches, so a
// wrong shuffle mask is SILENT corruption of guest geometry — it would not
// crash, it would just draw wrong. The existing psq coverage in
// test_gekko_next.cpp cannot catch it: those tests leave mem1_base/mem1_mask at
// the dispatch_block defaults (0/0), so their psq_l/psq_st take the SLOW import
// arm (test_psq_l_float_pair asserts n_reads == 2, i.e. two ppc_read32 calls).
// The rewritten code is in the FASTMEM arms only. These tests pass a real host
// buffer as mem1_base — the test_lwz_fast_path pattern — so the fastmem guard
// passes and the SIMD path is what actually executes.
//
// Every assertion is on raw bytes / raw FPR lane bits, compared against the
// big-endian image the scalar form produced.

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

using namespace bemental;
using namespace bemental::powerpc;

static void report(const char* line, bool pass) {
    std::printf("%s %s\n", pass ? "[PASS]" : "[FAIL]", line);
#ifdef __EMSCRIPTEN__
    EM_ASM({
        const msg = UTF8ToString($0); const pass = $1;
        if (typeof document === 'undefined') return;
        let pre = document.getElementById('bemental-out');
        if (!pre) { pre = document.createElement('pre');
            pre.id = 'bemental-out';
            pre.style.cssText = 'font: 14px ui-monospace, Menlo, monospace; padding: 16px;';
            document.body.appendChild(pre); }
        pre.textContent += (pass ? '[PASS] ' : '[FAIL] ') + msg + '\n';
    }, line, pass ? 1 : 0);
#endif
}

// ---- encoders ----
// psq_l  frD, d(rA), W, I  — opcd 56 (verified vs 0xE0230008 = psq_l f1,8(r3))
static u32 enc_psq_l(u32 d_, u32 a, u32 w, u32 i, s32 disp) {
    return (56u << 26) | ((d_ & 0x1F) << 21) | ((a & 0x1F) << 16)
         | ((w & 1u) << 15) | ((i & 7u) << 12) | ((u32)disp & 0xFFFu);
}
// psq_st frS, d(rA), W, I  — opcd 60 (verified vs 0xF0440010 = psq_st f2,16(r4))
static u32 enc_psq_st(u32 s, u32 a, u32 w, u32 i, s32 disp) {
    return (60u << 26) | ((s & 0x1F) << 21) | ((a & 0x1F) << 16)
         | ((w & 1u) << 15) | ((i & 7u) << 12) | ((u32)disp & 0xFFFu);
}
static u32 enc_lfd (u32 d_, u32 a, s32 disp) {
    return (50u << 26) | ((d_ & 0x1F) << 21) | ((a & 0x1F) << 16) | ((u32)disp & 0xFFFFu);
}
static u32 enc_stfd(u32 s, u32 a, s32 disp) {
    return (54u << 26) | ((s & 0x1F) << 21) | ((a & 0x1F) << 16) | ((u32)disp & 0xFFFFu);
}

struct TestEnv {
    void* ctx_raw = nullptr;
    u32 ctx_ptr = 0;
    BlockCache cache;
    bool init() {
        ctx_raw = std::calloc(1, 0x1400);
        if (!ctx_raw) return false;
        ctx_ptr = (u32)(uintptr_t)ctx_raw;
        // MSR.FP = 1 and HID2.PSE|LSQE, same as test_gekko_next's psq_env_common.
        *(u32*)((u8*)ctx_raw + ppc_off::MSR) = 0x2000u;
        *(u32*)((u8*)ctx_raw + ppc_off::spr(920)) = 0xA0000000u;
        return true;
    }
    ~TestEnv() { if (ctx_raw) std::free(ctx_raw); }
    u32& gpr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::gpr(i)); }
    u32& spr(u32 i) { return *(u32*)((u8*)ctx_raw + ppc_off::spr(i)); }
    u64& ps0(u32 i) { return *(u64*)((u8*)ctx_raw + ppc_off::ps0(i)); }
    u64& ps1(u32 i) { return *(u64*)((u8*)ctx_raw + ppc_off::ps1(i)); }
    bool dispatch(u32 pc, const u32* insts, u32 n, s32* next,
                  u32 mem1_base, u32 mem1_mask, u32 ram_size) {
        std::vector<u8> bytes = build_block_next(pc, insts, n, ctx_ptr,
                                                 mem1_base, mem1_mask, ram_size);
        int h = cache.compile(pc, bytes.data(), bytes.size());
        if (h < 0) return false;
        s32 np = -1;
        if (!cache.dispatch(pc, &np)) return false;
        if (next) *next = np;
        return true;
    }
};

// [arm-proof gate] Number of import (SLOW-arm) calls since the last reset. The
// rewritten code is in the FASTMEM arms ONLY, so a test that silently took the
// slow arm would "pass" while proving nothing. Every test below asserts this is
// zero — the counter only the WRONG arm can advance.
static u32 slow_hits_reset() {
#ifdef __EMSCRIPTEN__
    const u32 n = (u32)EM_ASM_INT({ const n = Module._slow_hits | 0; Module._slow_hits = 0; return n; });
    return n;
#else
    return 0;
#endif
}

// Backing store shared by the tests. mem1_mask keeps the fastmem guard's
// extra range check live (mask != ram_size-1), exactly as test_lwz_fast_path.
static const u32 MEM_MASK = 0x017FFFFFu;
static const u32 GUEST_BASE = 0x80000000u;   // & MEM_MASK == 0

// ---------------------------------------------------------------------------
// 1. psq_l FLOAT pair, W=0, GQR0=0 — the FASTMEM arm (emit_psq_l_float_pair_simd).
//    Guest memory holds 1.0f then 2.0f big-endian; ps0/ps1 must be the widened
//    doubles. A byte-reversed shuffle mask would give garbage exponents.
// ---------------------------------------------------------------------------
static bool test_psq_l_float_pair_fastmem() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    // 1.0f = 0x3F800000, 2.0f = 0x40000000, stored BIG-endian (guest order)
    buf[0]=0x3F; buf[1]=0x80; buf[2]=0x00; buf[3]=0x00;
    buf[4]=0x40; buf[5]=0x00; buf[6]=0x00; buf[7]=0x00;
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_psq_l(1, 1, 0, 0, 0) };
    s32 next = -1;
    if (!env.dispatch(0x80003000, insts, 1, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u64 a = env.ps0(1), b = env.ps1(1);
    const u32 slow = slow_hits_reset();
    std::printf("[diag psq_l-fast] ps0=0x%016llx (exp 3ff0..) ps1=0x%016llx (exp 4000..) slow=%u\n",
                (unsigned long long)a, (unsigned long long)b, slow);
    return a == 0x3FF0000000000000ull && b == 0x4000000000000000ull
        && next == (s32)0x80003004 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 2. psq_l -> psq_st round trip, both FLOAT/W=0/fastmem. The psq_l leaves f1 in
//    SINGLE repr, so the psq_st takes the rewritten rs_single arm (vector FTZ +
//    BSWAP32X2 shuffle + v128.store64_lane). The 8 stored bytes must be
//    byte-identical to the 8 source bytes. A wrong mask (e.g. a 64-bit reversal
//    where a 32-bit-pair reversal was meant) swaps the two words and this fails.
// ---------------------------------------------------------------------------
static bool test_psq_st_float_pair_fastmem_roundtrip() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    // deliberately asymmetric bytes so ANY permutation error is visible
    const u8 src[8] = { 0x3F, 0x81, 0x23, 0x45, 0xC1, 0x67, 0x89, 0xAB };
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_psq_l (1, 1, 0, 0, 0),
                          enc_psq_st(1, 1, 0, 0, 16) };
    s32 next = -1;
    if (!env.dispatch(0x80004000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u32 slow = slow_hits_reset();
    std::printf("[diag psq_st-fast] src=%02x %02x %02x %02x %02x %02x %02x %02x  "
                "dst=%02x %02x %02x %02x %02x %02x %02x %02x\n",
                src[0],src[1],src[2],src[3],src[4],src[5],src[6],src[7],
                buf[16],buf[17],buf[18],buf[19],buf[20],buf[21],buf[22],buf[23]);
    return std::memcmp(buf + 16, src, 8) == 0 && next == (s32)0x80004008 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 3. Same round trip with a DENORMAL in each lane — the vector FTZ (emit_ftz_v128)
//    must flush to a SIGNED ZERO, exactly like the scalar emit_ftz_f32_bits
//    ladder it replaces. Lane 0 = +denormal (0x00200010), lane 1 = -denormal
//    (0x80200010): expected stored words 0x00000000 and 0x80000000.
//    (test_gekko_next's psq_st_float_ftz_denormal covers this only for W=1,
//    which still uses the scalar ladder.)
// ---------------------------------------------------------------------------
static bool test_psq_st_float_pair_ftz_denormals() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    // BE image of 0x00200010 (+denormal) then 0x80200010 (-denormal)
    buf[0]=0x00; buf[1]=0x20; buf[2]=0x00; buf[3]=0x10;
    buf[4]=0x80; buf[5]=0x20; buf[6]=0x00; buf[7]=0x10;
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_psq_l (1, 1, 0, 0, 0),
                          enc_psq_st(1, 1, 0, 0, 16) };
    s32 next = -1;
    if (!env.dispatch(0x80005000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u8 want[8] = { 0x00,0x00,0x00,0x00, 0x80,0x00,0x00,0x00 };
    const u32 slow = slow_hits_reset();
    std::printf("[diag psq_st-ftz-pair] dst=%02x %02x %02x %02x %02x %02x %02x %02x "
                "(want 00 00 00 00 80 00 00 00)\n",
                buf[16],buf[17],buf[18],buf[19],buf[20],buf[21],buf[22],buf[23]);
    return std::memcmp(buf + 16, want, 8) == 0 && next == (s32)0x80005008 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 4. Normal values must NOT be disturbed by the vector FTZ: a normal f32 with a
//    zero-ish mantissa and a full-mantissa normal both survive unchanged.
// ---------------------------------------------------------------------------
static bool test_psq_st_float_pair_normals_untouched() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    const u8 src[8] = { 0x00, 0x80, 0x00, 0x00,    // smallest NORMAL (exp==1, mant 0)
                        0xFF, 0x7F, 0xFF, 0xFF };  // -largest finite
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_psq_l (1, 1, 0, 0, 0),
                          enc_psq_st(1, 1, 0, 0, 16) };
    s32 next = -1;
    if (!env.dispatch(0x80006000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u32 slow = slow_hits_reset();
    std::printf("[diag psq_st-normals] dst=%02x %02x %02x %02x %02x %02x %02x %02x\n",
                buf[16],buf[17],buf[18],buf[19],buf[20],buf[21],buf[22],buf[23]);
    return std::memcmp(buf + 16, src, 8) == 0 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 5. lfd fastmem — the 8 guest bytes must land in the ps0 lane as the
//    big-endian-interpreted f64 bit pattern (emit_fastmem_lfd_body's
//    v128.load64_zero + BSWAP64 shuffle + i64x2.extract_lane).
// ---------------------------------------------------------------------------
static bool test_lfd_fastmem() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    const u8 src[8] = { 0x40, 0x09, 0x21, 0xFB, 0x54, 0x44, 0x2D, 0x18 };  // pi
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_lfd(2, 1, 0) };
    s32 next = -1;
    if (!env.dispatch(0x80007000, insts, 1, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u64 got = env.ps0(2);
    const u32 slow = slow_hits_reset();
    std::printf("[diag lfd-fast] ps0=0x%016llx (want 0x400921fb54442d18)\n",
                (unsigned long long)got);
    return got == 0x400921FB54442D18ull && next == (s32)0x80007004 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 6. lfd -> stfd round trip, both fastmem — 8 bytes must come back identical.
//    Catches an operand-order slip in the v128.store64_lane rewrite (the
//    address is now left on the stack instead of parked in LOCAL_TMP_FPVAL).
// ---------------------------------------------------------------------------
static bool test_stfd_fastmem_roundtrip() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128] = {0};
    const u8 src[8] = { 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF };
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_lfd (2, 1, 0),
                          enc_stfd(2, 1, 32) };
    s32 next = -1;
    if (!env.dispatch(0x80008000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    const u32 slow = slow_hits_reset();
    std::printf("[diag stfd-fast] dst=%02x %02x %02x %02x %02x %02x %02x %02x "
                "(want 01 23 45 67 89 ab cd ef)\n",
                buf[32],buf[33],buf[34],buf[35],buf[36],buf[37],buf[38],buf[39]);
    return std::memcmp(buf + 32, src, 8) == 0 && next == (s32)0x80008008 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 7. stfd must not clobber its neighbours: bytes before and after the 8-byte
//    window stay untouched (a store64_lane writing 16 bytes would show here).
// ---------------------------------------------------------------------------
static bool test_stfd_fastmem_no_overrun() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128];
    std::memset(buf, 0x5A, sizeof(buf));
    const u8 src[8] = { 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF };
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_lfd (2, 1, 0),
                          enc_stfd(2, 1, 32) };
    s32 next = -1;
    if (!env.dispatch(0x80009000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    bool clean = true;
    for (u32 i = 40; i < 56; ++i) if (buf[i] != 0x5A) clean = false;
    for (u32 i = 24; i < 32; ++i) if (buf[i] != 0x5A) clean = false;
    const u32 slow = slow_hits_reset();
    std::printf("[diag stfd-overrun] after=%02x %02x %02x %02x before=%02x %02x clean=%d slow=%u\n",
                buf[40],buf[41],buf[42],buf[43],buf[30],buf[31], clean ? 1 : 0, slow);
    return clean && std::memcmp(buf + 32, src, 8) == 0 && slow == 0u;
}

// ---------------------------------------------------------------------------
// 8. psq_st must not overrun either — same 16-vs-8 byte check on the store side
//    where the v128.store64_lane replaced two i32.store.
// ---------------------------------------------------------------------------
static bool test_psq_st_fastmem_no_overrun() {
    TestEnv env; if (!env.init()) return false;
    alignas(16) u8 buf[128];
    std::memset(buf, 0x5A, sizeof(buf));
    const u8 src[8] = { 0x3F, 0x81, 0x23, 0x45, 0xC1, 0x67, 0x89, 0xAB };
    std::memcpy(buf, src, 8);
    env.gpr(1) = GUEST_BASE;
    const u32 insts[] = { enc_psq_l (1, 1, 0, 0, 0),
                          enc_psq_st(1, 1, 0, 0, 16) };
    s32 next = -1;
    if (!env.dispatch(0x8000A000, insts, 2, &next,
                      (u32)(uintptr_t)&buf[0], MEM_MASK, sizeof(buf))) return false;
    bool clean = true;
    for (u32 i = 24; i < 40; ++i) if (buf[i] != 0x5A) clean = false;
    for (u32 i = 8;  i < 16; ++i) if (buf[i] != 0x5A) clean = false;
    const u32 slow = slow_hits_reset();
    std::printf("[diag psq_st-overrun] after=%02x %02x %02x %02x clean=%d slow=%u\n",
                buf[24],buf[25],buf[26],buf[27], clean ? 1 : 0, slow);
    return clean && std::memcmp(buf + 16, src, 8) == 0 && slow == 0u;
}

// ---------------------------------------------------------------------------
// [emitted-op audit] Dump the raw module bytes for MICRO-BLOCKS containing
// exactly the ops this change touches, so the emitted-op count can be measured
// (wasm-objdump -d | count instruction lines) rather than hand-counted. Sizing
// in OPS not BYTES is mandatory here: the emitters bake host addresses as LEB
// i32.const, so byte totals shift with the ctx_ptr the allocator happens to
// hand out (CLAUDE.md gate #10).
static void dump_block(const char* tag, TestEnv& env, const u32* insts, u32 n,
                       u32 mem1_base, u32 mem1_mask, u32 ram_size) {
    std::vector<u8> bytes = build_block_next(0x80020000u, insts, n, env.ctx_ptr,
                                             mem1_base, mem1_mask, ram_size);
    std::printf("[wasmdump %s] %zu bytes\n", tag, bytes.size());
    for (size_t off = 0; off < bytes.size(); off += 16) {
        std::printf("[wasmdump %s] %04zx:", tag, off);
        for (size_t i = off; i < off + 16 && i < bytes.size(); ++i)
            std::printf(" %02x", bytes[i]);
        std::printf("\n");
    }
}

// Off by default (it prints ~2000 hex lines): set BEM_EMIT_AUDIT=1 to enable.
// Gate #8 — diagnostics must not accumulate in the default run.
static void emit_audit_dumps() {
    if (!std::getenv("BEM_EMIT_AUDIT")) return;
    TestEnv env; if (!env.init()) return;
    alignas(16) u8 buf[128] = {0};
    env.gpr(1) = GUEST_BASE;
    const u32 base = (u32)(uintptr_t)&buf[0];
    const u32 a_psq_l [] = { enc_psq_l (1, 1, 0, 0, 0) };
    const u32 a_psq_st[] = { enc_psq_l (1, 1, 0, 0, 0), enc_psq_st(1, 1, 0, 0, 16) };
    const u32 a_lfd   [] = { enc_lfd (2, 1, 0) };
    const u32 a_stfd  [] = { enc_lfd (2, 1, 0), enc_stfd(2, 1, 32) };
    dump_block("MICRO_psq_l",  env, a_psq_l,  1, base, MEM_MASK, sizeof(buf));
    dump_block("MICRO_psq_st", env, a_psq_st, 2, base, MEM_MASK, sizeof(buf));
    dump_block("MICRO_lfd",    env, a_lfd,    1, base, MEM_MASK, sizeof(buf));
    dump_block("MICRO_stfd",   env, a_stfd,   2, base, MEM_MASK, sizeof(buf));
}

// ---------------------------------------------------------------------------
struct TestCase { const char* name; bool (*fn)(); };
static const TestCase kCases[] = {
    {"psq_l_float_pair_fastmem",            &test_psq_l_float_pair_fastmem},
    {"psq_st_float_pair_fastmem_roundtrip", &test_psq_st_float_pair_fastmem_roundtrip},
    {"psq_st_float_pair_ftz_denormals",     &test_psq_st_float_pair_ftz_denormals},
    {"psq_st_float_pair_normals_untouched", &test_psq_st_float_pair_normals_untouched},
    {"lfd_fastmem",                         &test_lfd_fastmem},
    {"stfd_fastmem_roundtrip",              &test_stfd_fastmem_roundtrip},
    {"stfd_fastmem_no_overrun",             &test_stfd_fastmem_no_overrun},
    {"psq_st_fastmem_no_overrun",           &test_psq_st_fastmem_no_overrun},
};

int main() {
    // [rs_single gate] With g_hle_hook_query == nullptr the emitter treats EVERY
    // op as possibly-HLE-hooked and emits rc.Flush + frc.Flush in front of it
    // (ppc_emit.cpp:1360-1367). frc.Flush PROMOTES a Single-repr FPR back to
    // Double, so psq_st would see IsSingle(rs) == false and take the scalar arm
    // — the psq_st SIMD arm this file exists to test would never run, and the
    // round-trip would pass while proving nothing. test_gekko_next.cpp:2713-2714
    // installs the same false-returning query for exactly this reason. Verified:
    // without it the emitted MICRO_psq_st block contains no v128.store64_lane.
    const auto saved_hle_query = bemental::powerpc::g_hle_hook_query;
    bemental::powerpc::g_hle_hook_query = [](u32) -> bool { return false; };
#ifdef __EMSCRIPTEN__
    // Every emitted block declares the full env import set, so all of them must
    // be callable for WebAssembly.Instance() to link — even the ones the fastmem
    // arms never call. (Same bootstrap as test_pi_mask_path.cpp:108-136.) These
    // tests assert on the FASTMEM arms, so a read/write reaching a stub here
    // would itself be a failure signal: the stubs return 0 / drop.
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        Module._slow_hits = 0;
        env.ppc_read8       = function(a)    { Module._slow_hits++; return 0; };
        env.ppc_read16      = function(a)    { Module._slow_hits++; return 0; };
        env.ppc_read32      = function(a)    { Module._slow_hits++; return 0; };
        env.ppc_write8      = function(a, v) { Module._slow_hits++; };
        env.ppc_write16     = function(a, v) { Module._slow_hits++; };
        env.ppc_write32     = function(a, v) { Module._slow_hits++; };
        env.ppc_interp      = function(inst, pc) {};
        env.ppc_check_exc   = function(pc) { return 0; };
        env.ppc_break_block = function(pc, _) {};
        env.ppc_hle_check   = function(pc) { return 0; };
        env.ppc_hle_fire    = function(pc, idx) { return 0; };
        env.ppc_msr_updated = function(a, b) {};
        env.ppc_gather_drain = function(a, b) {};
        env.ppc_stack_corrupt = function(a, b, c, d) {};
        env.ppc_read_tb     = function(w)  { return 0; };
    });
#endif
    int pass = 0, fail = 0;
    for (const auto& c : kCases) {
        const bool ok = c.fn();
        report(c.name, ok);
        if (ok) ++pass; else ++fail;
    }
    emit_audit_dumps();
    bemental::powerpc::g_hle_hook_query = saved_hle_query;
    char buf[128];
    std::snprintf(buf, sizeof(buf), "TOTAL: %d passed, %d failed", pass, fail);
    report(buf, fail == 0);
    return fail == 0 ? 0 : 1;
}
