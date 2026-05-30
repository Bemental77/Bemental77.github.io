#pragma once
//
// cr_encode.h — Dolphin's optimized u64 CR-field encoding helpers.
//
// Each CR[0..7] field is a u64 at PowerPCState +0x2A0+(n*8). Per
// Source/Core/Core/PowerPC/ConditionRegister.h:48-77, the encoding is:
//
//   * Bit 32 (= bit 0 of the high u32) is the always-set marker that
//     PPCToInternal writes (cr_val = 0x100000000 | ...). It makes
//     (cr_val & 0xFFFFFFFF) == 0 the canonical EQ check while keeping
//     cr_val non-zero for non-EQ.
//   * LT  ⇔ bit 62 set  (= bit 30 of the high u32)
//   * SO  ⇔ bit 59 set  (= bit 27 of the high u32)
//   * EQ  ⇔ low 32 bits == 0
//   * GT  ⇔ (s64)cr_val > 0  (i.e. bit 63 cleared AND cr_val != 0)
//
// IMPORTANT: directly sign-extending a signed-compare result to 64 bits
// PRODUCES THE WRONG ENCODING when the result is negative — the
// sign-extension fills the high 32 bits with 1s INCLUDING bit 59, which
// spuriously sets SO regardless of the real XER.SO. The legacy emitter
// at guests/powerpc/gekko_emit.h:540-589 documents this exact failure
// mode (caught by the DolphinPPCTests differential oracle on ADD. with
// negative result). All helpers below construct the high u32 explicitly
// bit-by-bit and join it with the i32 result as the low u32 — never via
// i64_extend_i32_s on a signed value.
//
// All helpers take WASM locals (not stack values) for stack-discipline
// safety. Stack-neutral.

#include "bementalJIT/types.h"

class WasmModuleBuilder;

namespace bemental::powerpc {

// Set CR[crfd] from a single i32 result vs zero. Used by Rc=1 integer
// ops (treat result vs 0 for LT/GT/EQ; SO is copied from XER.SO).
//
// Encoding produced (per ConditionRegister.h:48-57):
//   high32 = 1 | (XER.SO & 1)<<27 | (value>>31 u)<<30 | (value<=0 s)<<31
//   low32  = value
void emit_cr_from_signed_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                               u32 crfd, u32 value_local);

// Set CR[crfd] from a SIGNED comparison of two i32 locals. Used by
// cmp / cmpi. Constructs LT/GT/EQ from direct i32_lt_s / i32_le_s
// comparisons — does NOT compute (a - b) first, because that subtraction
// overflows on operands straddling the s32 boundary (e.g. cmpi
// ra=0x80000000, simm=1 → diff=0x7FFFFFFF reports GT when the correct
// PPC result is LT). Dolphin's Helper_IntCompare similarly compares
// operands directly, not their difference.
//
// Encoding produced:
//   high32 = 1 | (XER.SO & 1)<<27 | (a<b s)<<30 | (a<=b s)<<31
//   low32  = a - b   (zero iff a == b)
void emit_cr_from_signed_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                              u32 crfd, u32 a_local, u32 b_local);

// Set CR[crfd] from an UNSIGNED comparison of two i32 locals. Used by
// cmpl / cmpli.
//
// Encoding produced:
//   high32 = 1 | (XER.SO & 1)<<27 | (a<b u)<<30 | (a<=b u)<<31
//   low32  = a - b   (zero iff a == b)
void emit_cr_from_unsigned_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 crfd, u32 a_local, u32 b_local);

// Convenience: CR0 from local, signed-vs-0 semantic. Equivalent to
// emit_cr_from_signed_local(wb, ctx_ptr, 0, value_local).
void emit_cr0_from_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                         u32 value_local);

}  // namespace bemental::powerpc
