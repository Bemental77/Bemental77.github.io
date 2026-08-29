// gekko_rt.h — Gekko (PowerPC 750CL) semantics runtime for the STATIC RECOMPILER.
//
// This is the fixed, game-independent half of `sr.py`'s output: the translator emits
// straight-line C that calls these helpers, one call per guest instruction semantic.
//
// EVERY numeric helper here is a behaviour-for-behaviour port of Dolphin's REFERENCE
// INTERPRETER, cited to file:line in ~/gc_refs/dolphin (pristine clone e22551e):
//   Force25Bit                 Interpreter/Interpreter_FPUtils.h:90
//   ForceSingle                Interpreter/Interpreter_FPUtils.h:52
//   NI_mul                     Interpreter/Interpreter_FPUtils.h:143
//   NI_madd_msub<sub,single>   Interpreter/Interpreter_FPUtils.h:285  (the 2Sum tie-fix)
//   psq_l  / Helper_Dequantize Interpreter/Interpreter_LoadStorePaired.cpp:218
//   psq_st / Helper_Quantize   Interpreter/Interpreter_LoadStorePaired.cpp:144
//   lfd / stfd                 Interpreter/Interpreter_LoadStore.cpp:63,363
//   ConvertToDouble            Common/FloatUtils.h  (single->double bit expansion)
//
// Deliberately NOT modelled (they are host-layer / not reached by leaf math code):
//   FPSCR exception bits, FPRF, CR1 (Rc=1 on FP), alignment/DSI exceptions,
//   the NI (non-IEEE) FPSCR mode.  Guarded: sr.py refuses to translate any
//   instruction with Rc=1 in the FP forms, and GQR modes other than FLOAT abort.
#ifndef GEKKO_RT_H
#define GEKKO_RT_H

#include <stdint.h>
#include <string.h>
#include <math.h>

// ---------------------------------------------------------------- guest state
typedef struct {
    uint32_t gpr[32];
    uint64_t ps0[32];      // FPR PS0 slot, raw IEEE-754 binary64 bits (as Dolphin stores it)
    uint64_t ps1[32];      // FPR PS1 slot
    uint32_t cr;           // 8 x 4-bit fields, CR0 in the HIGH nibble (PowerPC order)
    uint32_t xer;
    uint32_t lr;
    uint32_t ctr;
    uint32_t fpscr;
    uint32_t gqr[8];
    uint32_t pc;
} GekkoState;

// Guest RAM window. MEM1 is 24 MB at 0x80000000 (mirrored 0xC0000000); the
// recompiled code only ever sees physical offsets, so mask to 26 bits and index a
// flat host buffer. `g_ram_size` bounds every access (a fault sets g_fault).
extern uint8_t *g_ram;
extern uint32_t g_ram_size;
extern uint32_t g_fault;      // 0 = clean; else the guest address that faulted

static inline uint32_t gk_phys(uint32_t ea) { return ea & 0x03FFFFFFu; }

static inline int gk_ok(uint32_t p, uint32_t n) {
    if (p + n > g_ram_size) { if (!g_fault) g_fault = p | 0x80000000u; return 0; }
    return 1;
}

// ------------------------------------------------------- big-endian guest memory
static inline uint8_t  gk_r8 (uint32_t ea){ uint32_t p=gk_phys(ea); if(!gk_ok(p,1)) return 0; return g_ram[p]; }
static inline uint16_t gk_r16(uint32_t ea){ uint32_t p=gk_phys(ea); if(!gk_ok(p,2)) return 0;
    return (uint16_t)((g_ram[p]<<8)|g_ram[p+1]); }
static inline uint32_t gk_r32(uint32_t ea){ uint32_t p=gk_phys(ea); if(!gk_ok(p,4)) return 0;
    return ((uint32_t)g_ram[p]<<24)|((uint32_t)g_ram[p+1]<<16)|((uint32_t)g_ram[p+2]<<8)|g_ram[p+3]; }
static inline uint64_t gk_r64(uint32_t ea){ return ((uint64_t)gk_r32(ea)<<32) | gk_r32(ea+4); }

static inline void gk_w8 (uint32_t ea,uint8_t v){ uint32_t p=gk_phys(ea); if(!gk_ok(p,1))return; g_ram[p]=v; }
static inline void gk_w16(uint32_t ea,uint16_t v){ uint32_t p=gk_phys(ea); if(!gk_ok(p,2))return;
    g_ram[p]=(uint8_t)(v>>8); g_ram[p+1]=(uint8_t)v; }
static inline void gk_w32(uint32_t ea,uint32_t v){ uint32_t p=gk_phys(ea); if(!gk_ok(p,4))return;
    g_ram[p]=(uint8_t)(v>>24); g_ram[p+1]=(uint8_t)(v>>16); g_ram[p+2]=(uint8_t)(v>>8); g_ram[p+3]=(uint8_t)v; }
static inline void gk_w64(uint32_t ea,uint64_t v){ gk_w32(ea,(uint32_t)(v>>32)); gk_w32(ea+4,(uint32_t)v); }

// ------------------------------------------------------------------ bit casts
static inline double   gk_bd(uint64_t b){ double d; memcpy(&d,&b,8); return d; }
static inline uint64_t gk_db(double d){ uint64_t b; memcpy(&b,&d,8); return b; }
static inline float    gk_bf(uint32_t b){ float f; memcpy(&f,&b,4); return f; }
static inline uint32_t gk_fb(float f){ uint32_t b; memcpy(&b,&f,4); return b; }

#define GK_DOUBLE_SIGN 0x8000000000000000ULL
#define GK_DOUBLE_EXP  0x7FF0000000000000ULL
#define GK_DOUBLE_FRAC 0x000FFFFFFFFFFFFFULL
#define GK_DOUBLE_FRAC_WIDTH 52

// Common/FloatUtils.h ConvertToDouble — the single->double expansion the hardware does
// on lfs/psq_l(FLOAT). For normals it is the plain widening; denormal singles get the
// exponent fixup, which the plain (double)f32 cast also produces, so a cast is exact.
static inline uint64_t gk_cvt_to_double(uint32_t w){ return gk_db((double)gk_bf(w)); }

// Interpreter_FPUtils.h:90  Force25Bit — Gekko rounds frC's mantissa to 25 bits.
static inline double gk_force25(double d){
    uint64_t integral = gk_db(d);
    uint64_t exponent = integral & GK_DOUBLE_EXP;
    uint64_t fraction = integral & GK_DOUBLE_FRAC;
    if (exponent == 0 && fraction != 0) {
        int64_t keep_mask = (int64_t)0xFFFFFFFFF8000000LL;
        uint64_t round = 0x8000000ULL;
        int lz = 0; uint64_t t = fraction;
        while (!(t & 0x8000000000000000ULL)) { t <<= 1; lz++; }
        uint32_t shift = (uint32_t)(lz - (63 - GK_DOUBLE_FRAC_WIDTH));
        keep_mask >>= shift;
        round >>= shift;
        integral = (integral & (uint64_t)keep_mask) + (integral & round);
    } else {
        integral = (integral & 0xFFFFFFFFF8000000ULL) + (integral & 0x8000000ULL);
    }
    return gk_bd(integral);
}

// Interpreter_FPUtils.h:52  ForceSingle — FPSCR.NI is 0 in every shipping game
// configuration we translate (sr.py asserts nothing sets it), so this is the plain
// round-to-nearest double->single narrowing.
static inline float gk_force_single(double v){ return (float)v; }

// Interpreter_FPUtils.h:143  NI_mul (non-NaN path; NaN payload propagation preserved).
static inline double gk_ni_mul(double a, double b){
    double r = a * b;
    if (isnan(r)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return r;
}
static inline double gk_ni_add(double a, double b){
    double r = a + b;
    if (isnan(r)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return r;
}
static inline double gk_ni_sub(double a, double b){ return gk_ni_add(a, -b); }

// Interpreter_FPUtils.h:285  NI_madd_msub<sub, single=true> — a*c+b with frC forced to a
// 25-bit mantissa, computed as one 64-bit FMA, plus the 2Sum tie-break correction that
// makes the later narrowing to single round exactly once (the Mario-Strikers case).
static inline double gk_ni_madd_single(double a, double c, double b, int sub){
    const double c_round = gk_force25(c);
    const double b_sign  = sub ? -b : b;
    double value = fma(a, c_round, b_sign);
    const uint64_t rb = gk_db(value);
    const uint64_t D_MASK  = 0x000000001FFFFFFFULL;
    const uint64_t EVEN_TIE= 0x0000000010000000ULL;
    if ((rb & D_MASK) == EVEN_TIE) {
        const double a_prime = b_sign - value;
        const double b_prime = value + a_prime;
        const double delta_a = fma(a, c_round, a_prime);
        const double delta_b = b_sign - b_prime;
        const double error   = delta_a + delta_b;
        if (error != 0.0) {
            if ((error > 0.0) == (value > 0.0)) value = gk_bd(rb + 1);
            else                                value = gk_bd(rb - 1);
        }
    }
    if (isnan(value)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        if (isnan(c)) return gk_bd(gk_db(c) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return value;
}
// double-precision FMA form (fmadd/fmsub): plain std::fma, no frC rounding, no tie fix.
static inline double gk_ni_madd_double(double a, double c, double b, int sub){
    double v = fma(a, c, sub ? -b : b);
    if (isnan(v)) {
        if (isnan(a)) return gk_bd(gk_db(a) | 0x0008000000000000ULL);
        if (isnan(b)) return gk_bd(gk_db(b) | 0x0008000000000000ULL);
        if (isnan(c)) return gk_bd(gk_db(c) | 0x0008000000000000ULL);
        return (double)NAN;
    }
    return v;
}

// nmadd / nmsub / ps_nmadd / ps_nmsub negate the ROUNDED result, and DO NOT negate a
// NaN — Interpreter_Paired.cpp:314,338 and Interpreter_FloatingPoint.cpp:677,723
// (`std::isnan(tmp) ? tmp : -tmp`). Negating before rounding, or negating the NaN, flips
// the QNaN sign: caught by the PSMTXInverse differential (want 7fc00000, got ffc00000).
static inline float  gk_negns_f(float v){ return (v != v) ? v : -v; }
static inline double gk_negns_d(double v){ return (v != v) ? v : -v; }

// SetBoth(float, float) — Interpreter stores both slots widened back to binary64.
static inline void gk_set_both(GekkoState *st, int d, float p0, float p1){
    st->ps0[d] = gk_db((double)p0);
    st->ps1[d] = gk_db((double)p1);
}

// ------------------------------------------------------ paired quantized ld/st
// Interpreter_LoadStorePaired.cpp:218 Helper_Dequantize / :144 Helper_Quantize.
// Only QUANTIZE_FLOAT (gqr type 0) is emitted inline; sr.py marks a function
// UNTRANSLATABLE if it cannot prove the GQR index is float-mode, and the runtime
// still checks at execution time so a wrong assumption faults instead of lying.
static inline void gk_psq_l(GekkoState *st, int d, uint32_t ea, int w, int i){
    const uint32_t gqr = st->gqr[i];
    const uint32_t ld_type = (gqr >> 16) & 7;
    if (ld_type != 0) { g_fault = 0xDEAD0001u; return; }   // non-float mode: refuse
    if (w) {
        st->ps0[d] = gk_cvt_to_double(gk_r32(ea));
        st->ps1[d] = gk_db(1.0);
    } else {
        uint64_t pair = gk_r64(ea);
        st->ps0[d] = gk_cvt_to_double((uint32_t)(pair >> 32));
        st->ps1[d] = gk_cvt_to_double((uint32_t)pair);
    }
}

// Common/FloatUtils.h ConvertToSingleFTZ: double -> single bit pattern, flushing
// out-of-single-range exponents to zero rather than to denormal/infinity.
static inline uint32_t gk_cvt_to_single_ftz(uint64_t x){
    const uint32_t exp = (uint32_t)((x >> 52) & 0x7FF);
    if (exp > 896 || (x & ~GK_DOUBLE_SIGN) == 0)
        return (uint32_t)(((x >> 32) & 0xC0000000u) | ((x >> 29) & 0x3FFFFFFFu));
    return (uint32_t)((x >> 32) & 0x80000000u);
}

static inline void gk_psq_st(GekkoState *st, int s, uint32_t ea, int w, int i){
    const uint32_t gqr = st->gqr[i];
    const uint32_t st_type = (gqr >> 0) & 7;
    if (st_type != 0) { g_fault = 0xDEAD0002u; return; }
    const uint32_t c0 = gk_cvt_to_single_ftz(st->ps0[s]);
    if (w) { gk_w32(ea, c0); }
    else   { gk_w32(ea, c0); gk_w32(ea + 4, gk_cvt_to_single_ftz(st->ps1[s])); }
}

// ------------------------------- fres / frsqrte (Gekko's table approximations)
// Common/FloatUtils.cpp:75 frsqrte_expected / :141 fres_expected, :86 / :152 algorithms.
typedef struct { int32_t base, dec; } GkBaseDec;
static const GkBaseDec gk_frsqrte_tab[32] = {
  {0x1a7e800,-0x568},{0x17cb800,-0x4f3},{0x1552800,-0x48d},{0x130c000,-0x435},
  {0x10f2000,-0x3e7},{0x0eff000,-0x3a2},{0x0d2e000,-0x365},{0x0b7c000,-0x32e},
  {0x09e5000,-0x2fc},{0x0867000,-0x2d0},{0x06ff000,-0x2a8},{0x05ab800,-0x283},
  {0x046a000,-0x261},{0x0339800,-0x243},{0x0218800,-0x226},{0x0105800,-0x20b},
  {0x3ffa000,-0x7a4},{0x3c29000,-0x700},{0x38aa000,-0x670},{0x3572000,-0x5f2},
  {0x3279000,-0x584},{0x2fb7000,-0x524},{0x2d26000,-0x4cc},{0x2ac0000,-0x47e},
  {0x2881000,-0x43a},{0x2665000,-0x3fa},{0x2468000,-0x3c2},{0x2287000,-0x38e},
  {0x20c1000,-0x35e},{0x1f12000,-0x332},{0x1d79000,-0x30a},{0x1bf4000,-0x2e6},
};
static const GkBaseDec gk_fres_tab[32] = {
  {0x7ff800,0x3e1},{0x783800,0x3a7},{0x70ea00,0x371},{0x6a0800,0x340},{0x638800,0x313},
  {0x5d6200,0x2ea},{0x579000,0x2c4},{0x520800,0x2a0},{0x4cc800,0x27f},{0x47ca00,0x261},
  {0x430800,0x245},{0x3e8000,0x22a},{0x3a2c00,0x212},{0x360800,0x1fb},{0x321400,0x1e5},
  {0x2e4a00,0x1d1},{0x2aa800,0x1be},{0x272c00,0x1ac},{0x23d600,0x19b},{0x209e00,0x18b},
  {0x1d8800,0x17c},{0x1a9000,0x16e},{0x17ae00,0x15b},{0x14f800,0x15b},{0x124400,0x143},
  {0x0fbe00,0x143},{0x0d3800,0x12d},{0x0ade00,0x12d},{0x088400,0x11a},{0x065000,0x11a},
  {0x041c00,0x108},{0x020c00,0x106},
};

static inline double gk_frsqrte(double val){
    int64_t integral = (int64_t)gk_db(val);
    int64_t mantissa = integral & ((1LL << 52) - 1);
    const int64_t sign = integral & (int64_t)(1ULL << 63);
    int64_t exponent = integral & (0x7FFLL << 52);
    if (mantissa == 0 && exponent == 0) return sign ? -INFINITY : INFINITY;
    if (exponent == (0x7FFLL << 52)) {
        if (mantissa == 0) return sign ? (double)NAN : 0.0;
        return gk_bd(gk_db(val) | 0x0008000000000000ULL);
    }
    if (sign) return (double)NAN;
    if (!exponent) {
        do { exponent -= 1LL << 52; mantissa <<= 1; } while (!(mantissa & (1LL << 52)));
        mantissa &= (1LL << 52) - 1;
        exponent += 1LL << 52;
    }
    const int64_t exponent_lsb = exponent & (1LL << 52);
    exponent = ((0x3FFLL << 52) - ((exponent - (0x3FELL << 52)) / 2)) & (0x7FFLL << 52);
    integral = sign | exponent;
    const int i = (int)((exponent_lsb | mantissa) >> 37);
    const GkBaseDec e = gk_frsqrte_tab[i / 2048];
    integral |= (int64_t)(e.base + e.dec * (i % 2048)) << 26;
    return gk_bd((uint64_t)integral);
}

static inline double gk_fres(double val){
    int64_t integral = (int64_t)gk_db(val);
    const int64_t mantissa = integral & ((1LL << 52) - 1);
    const int64_t sign = integral & (int64_t)(1ULL << 63);
    int64_t exponent = integral & (0x7FFLL << 52);
    if (mantissa == 0 && exponent == 0) return copysign(INFINITY, val);
    if (exponent == (0x7FFLL << 52)) {
        if (mantissa == 0) return copysign(0.0, val);
        return gk_bd(gk_db(val) | 0x0008000000000000ULL);
    }
    if (exponent < (895LL << 52)) return copysign(3.4028234663852886e38, val);
    if (exponent >= (1149LL << 52)) return copysign(0.0, val);
    exponent = (0x7FDLL << 52) - exponent;
    const int i = (int)(mantissa >> 37);
    const GkBaseDec e = gk_fres_tab[i / 1024];
    integral = sign | exponent;
    integral |= (int64_t)(e.base - (e.dec * (i % 1024) + 1) / 2) << 29;
    return gk_bd((uint64_t)integral);
}

// dcbz: zeroes the 32-byte cache block containing EA (Gekko line size = 32).
static inline void gk_dcbz(uint32_t ea){
    uint32_t p = gk_phys(ea) & ~31u;
    if (!gk_ok(p, 32)) return;
    for (int i = 0; i < 32; i++) g_ram[p + i] = 0;
}

// ------------------------------------------------------------- CR / XER helpers
static inline void gk_set_cr(GekkoState *st, int f, uint32_t v){
    const int sh = (7 - f) * 4;
    st->cr = (st->cr & ~(0xFu << sh)) | ((v & 0xFu) << sh);
}
static inline void gk_cmp_signed(GekkoState *st, int f, int32_t a, int32_t b){
    uint32_t v = (a < b) ? 8u : (a > b) ? 4u : 2u;
    v |= (st->xer >> 31) & 1u;   // SO
    gk_set_cr(st, f, v);
}
static inline void gk_cmp_unsigned(GekkoState *st, int f, uint32_t a, uint32_t b){
    uint32_t v = (a < b) ? 8u : (a > b) ? 4u : 2u;
    v |= (st->xer >> 31) & 1u;
    gk_set_cr(st, f, v);
}
static inline void gk_rc(GekkoState *st, uint32_t r){
    gk_cmp_signed(st, 0, (int32_t)r, 0);
}
static inline int gk_cr_bit(GekkoState *st, int b){ return (st->cr >> (31 - b)) & 1; }

static inline uint32_t gk_rotl32(uint32_t x, int n){ n &= 31; return n ? ((x << n) | (x >> (32 - n))) : x; }
static inline uint32_t gk_mask(int mb, int me){
    uint32_t m = 0xFFFFFFFFu >> mb;
    m ^= (me >= 31) ? 0u : (0xFFFFFFFFu >> (me + 1));
    return (me < mb) ? ~m : m;
}

#endif // GEKKO_RT_H
