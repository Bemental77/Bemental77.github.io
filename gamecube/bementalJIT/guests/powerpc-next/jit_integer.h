#pragma once
//
// jit_integer.h — Phase 4 integer emitters. Port of Dolphin Jit64's
// Jit_Integer.cpp shape, adapted to WASM via RegCache + WasmModuleBuilder.
//
// Each emit_* function consumes (WasmModuleBuilder&, RegCache&, params,
// CodeOp&). Operand decoding uses GekkoOperands helpers; reg-flow uses
// the CodeOp's regsIn/regsOut bitsets populated by PPCAnalyzer.
//
// Phase 4 part 1 scope (this header): non-Rc arithmetic + logical ops.
// Deferred to Phase 4.5: Rc-bit (CR0 update) handling, CA-chain ops
// (adde/subfe), shifts with CA (srawx/srawix), compare ops. CR field
// updates need the Dolphin u64 CR-encoding (8 × u64 packed bits per
// field at PowerPCState +0x2A0); shipping that requires matching the
// live tree's emit_set_cr0 logic byte-for-byte to keep oracle parity.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// D-form arithmetic immediate.
void emit_addi  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_addis (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_addic (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfic(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_mulli (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// D-form logical immediate.
void emit_ori   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_oris  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_xori  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_xoris (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// X-form arithmetic (op31 sub).
void emit_addx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_subfx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_mullwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// X-form logical (op31 sub) — bool family.
void emit_andx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_orx   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_xorx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_norx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// Sign-extend (op31 sub).
void emit_extsbx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_extshx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// Count leading zeros (op31 sub).
void emit_cntlzwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// Shift logical (op31 sub).
void emit_slwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_srwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// Arithmetic shift right with CA (op31 sub). XER.CA = sign-bit AND any-low-shifted-out-bit.
void emit_srawx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_srawix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Negate (op31 sub:104). rt = -ra (two's complement).
void emit_negx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// CA-chain ops (op31 subs). All read XER_CA, produce new XER_CA.
//   adde rt, ra, rb       (sub: 138)
//   subfe rt, ra, rb      (sub: 136)
//   addme rt, ra          (sub: 234)
//   subfme rt, ra         (sub: 232)
//   addze rt, ra          (sub: 202)
//   subfze rt, ra         (sub: 200)
void emit_addex (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_addmex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfmex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_addzex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfzex(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Rotate / mask (op 20/21/23). High-frequency bit-field extraction.
void emit_rlwinmx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_rlwimix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_rlwnmx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

}  // namespace bemental::powerpc
