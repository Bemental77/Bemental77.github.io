// test_cr_lean.cpp — BEM_LEVER_CR_LEAN (lever_gate.h bit 19): the eager CR-field
// build as two i32 stores + selects, the cmpi/cmpli immediate as a const operand,
// and the adjacent cmp -> bc fuse that tests the cmp's operands directly.
//
// Every expectation is computed HERE from the documented Dolphin encoding
// (ConditionRegister.h PPCToInternal, cr_encode.h):
//   hi32 = 1 | SO<<27 | LT<<30 | (a<=b)<<31,  lo32 = a - b   (Rc=1: b = 0, lo = a)
// and from the PowerPC branch definition — never from another emitter arm. The
// operand table straddles every signed/unsigned boundary, with XER.SO both clear
// and set, every CR field, and both branch polarities on LT / GT / EQ / SO.
//
// Block shape: { compare crF ; bc BO,4F+bit,+0x40 } — two instructions, so the bc
// is the block terminal and is IMMEDIATELY after the compare (the fuse arm). A
// third shape { compare ; or r9,r9,r9 ; bc } puts an op between them, so the bc
// must read the stored field (the non-fused arm), and { or. rA,rS,rS ; bc } covers
// the Rc=1 builder.
//
// Run: node test_cr_lean.js  (exit 0 = PASS)

#include "bementalJIT/bemental.h"
#include "guests/powerpc-next/ppc_emit.h"
#include "guests/powerpc-next/ppc_offsets.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <emscripten.h>

using namespace bemental;
using namespace bemental::powerpc;

static u32 d_form(u32 opcd, u32 rt, u32 ra, u32 imm) {
    return (opcd << 26) | ((rt & 31u) << 21) | ((ra & 31u) << 16) | (imm & 0xFFFFu);
}
static u32 x31(u32 rt, u32 ra, u32 rb, u32 xo, u32 rc = 0) {
    return (31u << 26) | ((rt & 31u) << 21) | ((ra & 31u) << 16) | ((rb & 31u) << 11) |
           (xo << 1) | rc;
}
static u32 bc_rel(u32 bo, u32 bi, s32 disp) {
    return (16u << 26) | ((bo & 31u) << 21) | ((bi & 31u) << 16) | ((u32)disp & 0xFFFCu);
}

enum Form { CMP, CMPL, CMPI, CMPLI, RC_OR };

struct Ctx {
    u8* raw = nullptr;
    u32 ptr = 0;
    Ctx() { raw = (u8*)std::calloc(1, 0x1400); ptr = (u32)(uintptr_t)raw; }
    ~Ctx() { std::free(raw); }
    u32& w(u32 off) { return *(u32*)(raw + off); }
    u8& b(u32 off) { return *(raw + off); }
};

struct Expect { u32 lo, hi; };
static Expect reference(Form f, u32 a, u32 b, u32 so) {
    bool lt, le;
    u32 lo;
    if (f == RC_OR) { lt = (s32)a < 0; le = (s32)a <= 0; lo = a; }
    else if (f == CMPL || f == CMPLI) { lt = a < b; le = a <= b; lo = a - b; }
    else { lt = (s32)a < (s32)b; le = (s32)a <= (s32)b; lo = a - b; }
    return { lo, 1u | (so << 27) | ((u32)lt << 30) | ((u32)le << 31) };
}
static bool ref_bit(Form f, u32 a, u32 b, u32 so, u32 bit) {
    const Expect e = reference(f, a, b, so);
    switch (bit) {
      case 0: return (e.hi >> 30) & 1u;
      case 1: return !((e.hi >> 31) & 1u);
      case 2: return e.lo == 0u;
      default: return (e.hi >> 27) & 1u;
    }
}

static int g_checks = 0, g_fails = 0;

// One case. Returns true iff CR field, next PC and the untouched fields all match.
static bool run_case(Form f, u32 crf, u32 a, u32 b, u32 so, u32 bit, bool if_true, bool gap,
                     u32 pc) {
    Ctx c;
    c.w(ppc_off::MSR) = 0x2000u;
    c.w(ppc_off::gpr(3)) = a;
    c.w(ppc_off::gpr(4)) = b;
    c.b(ppc_off::XER_SO_OV) = (u8)(so << 1);
    for (u32 i = 0; i < 8; ++i) {          // sentinel in every field
        c.w(ppc_off::cr(i)) = 0x13579BDFu + i;
        c.w(ppc_off::cr(i) + 4u) = 0x2468ACE0u + i;
    }
    u32 insts[3];
    u32 n = 0;
    const u32 field = (f == RC_OR) ? 0u : crf;
    switch (f) {
      case CMP:   insts[n++] = x31(field << 2, 3, 4, 0); break;
      case CMPL:  insts[n++] = x31(field << 2, 3, 4, 32); break;
      case CMPI:  insts[n++] = d_form(11, field << 2, 3, b); break;
      case CMPLI: insts[n++] = d_form(10, field << 2, 3, b); break;
      case RC_OR: insts[n++] = x31(3, 5, 3, 444, 1); break;      // or. r5,r3,r3
    }
    if (gap) insts[n++] = x31(9, 9, 9, 444);                     // or r9,r9,r9
    const u32 bc_pc = pc + 4u * n;
    insts[n++] = bc_rel(if_true ? 12u : 4u, field * 4u + bit, 0x40);
    std::vector<u8> bytes = build_block_next(pc, insts, n, c.ptr, 0, 0, 0);
    BlockCache cache;
    if (bytes.empty() || cache.compile(pc, bytes.data(), bytes.size()) < 0) return false;
    s32 next = -1;
    if (!cache.dispatch(pc, &next)) return false;

    const u32 bb = (f == CMPI) ? (u32)(s32)(s16)(u16)b : (f == CMPLI ? (b & 0xFFFFu) : b);
    const Expect e = reference(f, a, bb, so);
    const bool taken = ref_bit(f, a, bb, so, bit) == if_true;
    const u32 want_pc = taken ? bc_pc + 0x40u : bc_pc + 4u;
    bool ok = c.w(ppc_off::cr(field)) == e.lo && c.w(ppc_off::cr(field) + 4u) == e.hi &&
              (u32)next == want_pc;
    for (u32 i = 0; i < 8; ++i) {
        if (i == field) continue;
        if (c.w(ppc_off::cr(i)) != 0x13579BDFu + i || c.w(ppc_off::cr(i) + 4u) != 0x2468ACE0u + i)
            ok = false;
    }
    if (f == RC_OR && c.w(ppc_off::gpr(5)) != a) ok = false;
    if (!ok && g_fails < 12)
        std::printf("  [diff] form=%d crf=%u a=%08x b=%08x so=%u bit=%u %s gap=%d: cr=%08x:%08x "
                    "(want %08x:%08x) next=%08x (want %08x)\n", (int)f, field, a, bb, so, bit,
                    if_true ? "T" : "F", gap ? 1 : 0, c.w(ppc_off::cr(field) + 4u),
                    c.w(ppc_off::cr(field)), e.hi, e.lo, (u32)next, want_pc);
    return ok;
}

int main() {
    EM_ASM({
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        env.ppc_read8 = env.ppc_read16 = env.ppc_read32 = function(a) { return 0; };
        env.ppc_write8 = env.ppc_write16 = env.ppc_write32 = function(a, v) {};
        env.ppc_interp = function(i, p) { Module.__interp = (Module.__interp | 0) + 1; };
        env.ppc_check_exc = function(p) { return 0; };
        env.ppc_break_block = function(p, x) {};
        env.ppc_hle_check = function(p) { return 0; };
        env.ppc_hle_fire = function(p, i) { return 0; };
        env.ppc_stack_corrupt = function(a, b, c, d) {};
        env.ppc_msr_updated = function(m) {};
        env.ppc_gather_drain = function() {};
        env.ppc_read_tb = function(w) { return 0; };
    });
    g_hle_hook_query = [](uint32_t) -> bool { return false; };

    // Operand pairs (a, b). For CMPI/CMPLI b is taken as the 16-bit immediate.
    const u32 pairs[][2] = {
        {0, 0}, {5, 7}, {7, 5}, {7, 7}, {0x80000000u, 1}, {1, 0x80000000u},
        {0x7FFFFFFFu, 0x80000000u}, {0x80000000u, 0x7FFFFFFFu}, {0xFFFFFFFFu, 0},
        {0, 0xFFFFFFFFu}, {0xFFFFFFFFu, 0xFFFFFFFFu}, {0x00008000u, 0x8000u},
        {0xFFFF8000u, 0x8000u}, {0x00007FFFu, 0xFFFFu}, {0xFFFFFFFFu, 0xFFFFu},
        {0x12345678u, 0x5678u}, {0x80000000u, 0}, {0x7FFFFFFFu, 0},
    };
    const Form forms[] = { CMP, CMPL, CMPI, CMPLI, RC_OR };
    u32 pc = 0x80300000u;
    int per_form_fail[5] = {};
    for (const Form f : forms) {
        for (const auto& p : pairs) {
            for (u32 so = 0; so < 2; ++so) {
                for (u32 bit = 0; bit < 4; ++bit) {
                    for (int pol = 0; pol < 2; ++pol) {
                        for (int gap = 0; gap < 2; ++gap) {
                            const u32 crf = (f == RC_OR) ? 0u : ((pc >> 4) % 8u);
                            ++g_checks;
                            if (!run_case(f, crf, p[0], p[1], so, bit, pol == 1, gap == 1, pc)) {
                                ++g_fails; ++per_form_fail[(int)f];
                            }
                            pc += 0x100u;
                        }
                    }
                }
            }
        }
    }
    const char* names[5] = {"cmp", "cmpl", "cmpi", "cmpli", "or."};
    for (int i = 0; i < 5; ++i)
        std::printf("[%s] %s: %d failing cases\n", per_form_fail[i] ? "FAIL" : "PASS", names[i],
                    per_form_fail[i]);
    std::printf("[%s] TOTAL %d/%d checks\n", g_fails ? "FAIL" : "PASS", g_checks - g_fails, g_checks);
    return g_fails ? 1 : 0;
}
