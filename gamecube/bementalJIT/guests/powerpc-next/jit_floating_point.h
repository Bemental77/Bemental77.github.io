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
struct CodeOp;

// Scalar f64 ops — only touch ps0(fd) per PowerPC semantics; ps1(fd)
// preserved. Rc=1 routed to interp (CR1 update from FPSCR not modeled).
void emit_fmrx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_fnegx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_fabsx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_fnabsx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Double-precision scalar arith (ps0 lane only; ps1 untouched).
// sub5 18=fdiv, 20=fsub, 21=fadd, 25=fmul.
// sub5 28=fmsub, 29=fmadd, 30=fnmsub, 31=fnmadd.
// No PEM NaN payload / FPSCR exception bit updates.
void emit_fp_arith_double(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_fp_fma_double  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

}  // namespace powerpc
}  // namespace bemental
