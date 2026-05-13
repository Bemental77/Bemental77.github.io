#pragma once
//
// cr_encode.h — Dolphin's optimized u64 CR-field encoding helpers.
//
// Each CR[0..7] field is a u64 at PowerPCState +0x2A0+(n*8). Per
// Source/Core/Core/PowerPC/ConditionRegister.h, the encoding is:
//   - SO iff. bit 59 is set
//   - EQ iff. lower 32 bits == 0
//   - GT iff. (s64)cr_val > 0
//   - LT iff. bit 62 is set
//
// Key property: SIGN-EXTENDING a 32-bit signed-compare result to 64 bits
// produces a valid CR encoding for signed-compare semantics. Unsigned
// compares construct the trichotomy {-1, 0, +1} and sign-extend that.
//
// All helpers take WASM locals (not stack values) for stack-discipline
// safety.

#include "bementalJIT/types.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// Set CR[crfd] from a signed-comparison-style i32 in `value_local`.
// Stack-neutral. Used by Rc=1 integer ops (treat result vs 0) and by
// signed compare ops (cmp/cmpi — pass diff_local).
void emit_cr_from_signed_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                               u32 crfd, u32 value_local);

// Set CR[crfd] from an unsigned comparison of two i32 locals.
// Stack-neutral.
void emit_cr_from_unsigned_pair(WasmModuleBuilder& wb, u32 ctx_ptr,
                                u32 crfd, u32 a_local, u32 b_local);

// Convenience: CR0 from local, signed-vs-0 semantic. Equivalent to
// emit_cr_from_signed_local(wb, ctx_ptr, 0, value_local).
void emit_cr0_from_local(WasmModuleBuilder& wb, u32 ctx_ptr,
                         u32 value_local);

}  // namespace bemental::powerpc
