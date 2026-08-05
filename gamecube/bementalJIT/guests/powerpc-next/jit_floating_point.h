#pragma once
// jit_floating_point.h — scalar double-precision FP emits for opcode 63.
// V1 covers only the trivial sign/copy ops: fmr/fneg/fabs/fnabs. The
// arithmetic ops (fadd/fsub/fmul/fdiv/fmadd-family) + compare (fcmpu/o)
// + convert (frsp/fctiwx/fctiwzx) + FPSCR ops are still routed to interp.

#include "bementalJIT/types.h"

class WasmModuleBuilder;

namespace bemental {
namespace powerpc {

class RegCache;
class FPRRegCache;
struct CodeOp;

// Scalar f64 ops — only touch ps0(fd) per PowerPC semantics; ps1(fd)
// preserved. Rc=1 routed to interp (CR1 update from FPSCR not modeled).
void emit_fmrx  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
void emit_fnegx (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
void emit_fabsx (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
void emit_fnabsx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
// fcmpu (sub 0) / fcmpo (sub 32) — native scalar FP compare → CR field.
void emit_fcmpu (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
// fsel (A-form sub5 23) — native branchless FP select.
void emit_fsel  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);

// Double-precision scalar arith (ps0 lane only; ps1 untouched).
// sub5 18=fdiv, 20=fsub, 21=fadd, 25=fmul.
// sub5 28=fmsub, 29=fmadd, 30=fnmsub, 31=fnmadd.
// No PEM NaN payload / FPSCR exception bit updates.
void emit_fp_arith_double(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
void emit_fp_fma_double  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);

// op59 single-precision arith — result = ForceSingle(fpscr, <f64 op>),
// Fill BOTH lanes (Interpreter_FloatingPoint.cpp fadds/fmuls/etc use
// ps[FD].Fill). fmuls/fmadds-family Force25Bit frC first. ForceSingle's
// NI flushes are RUNTIME-gated on ctx FPSCR bit 2. Documented divergences
// (same class as the doubles): no FPSCR status/exception bit updates; the
// FMA family is unfused (f64 mul then add — Jit64-without-hardware-FMA
// parity; PPC fuses, divergence only on rounding ties).
// sub5 18=fdivs, 20=fsubs, 21=fadds, 25=fmuls.
// sub5 28=fmsubs, 29=fmadds, 30=fnmsubs, 31=fnmadds.
void emit_fp_arith_single(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);
void emit_fp_fma_single  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);

// op63 sub10=12 frsp — ps[FD].Fill(ForceSingle(fpscr, ps0(fB))).
// Divergence: SNaN + FPSCR.VE!=0 suppression of the write is not modeled
// (VE is 0 in shipped titles); VXSNAN/FPRF not updated.
void emit_frsp(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);

// op63 sub10=15 fctiwz — round-toward-zero f64->s32 box (ps0 only).
// PSO HandleReverb inner-loop hot op (0x803bf1bc). fctiw (sub10=14) stays
// interp (runtime FPSCR.RN dependence).
void emit_fctiwz(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc, const CodeOp& op, u32 ctx_ptr);

}  // namespace powerpc
}  // namespace bemental
