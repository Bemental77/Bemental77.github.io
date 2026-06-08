#pragma once
// jit_paired.h — opcode-4 paired-singles trivial ops (ps_mr / ps_neg /
// ps_abs / ps_nabs / ps_merge00/01/10/11 / ps_sel). Pure bit/copy/select
// over the 16-byte PairedSingle slot — no memory access, no FPSCR, no
// MSR.FP gate (same omission as existing FP emits — to be addressed
// later as a class).

#include "bementalJIT/types.h"

class WasmModuleBuilder;

namespace bemental {
namespace powerpc {

class RegCache;
struct CodeOp;

void emit_ps_mr      (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_neg     (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_abs     (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_nabs    (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_merge00 (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_merge01 (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_merge10 (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_merge11 (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_sel     (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Arithmetic paired-singles ops. All produce per-lane f64 results rounded to
// single-precision via demote_f64+promote_f32 (matches Jit64 non-accurate-NaN
// fast path). NaN payload semantics differ from PEM; FPSCR exception bits
// not updated. ps_mul Force25Bit on C input skipped to match existing emit.
void emit_ps_binary(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_fma   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_sum   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_muls  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_ps_madds (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

}  // namespace powerpc
}  // namespace bemental
