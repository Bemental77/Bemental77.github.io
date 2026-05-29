#pragma once
//
// jit_integer.h — integer emitters. Port of Dolphin Jit64's
// Jit_Integer.cpp shape, adapted to WASM via RegCache + WasmModuleBuilder.
//
// Each emit_* function consumes (WasmModuleBuilder&, RegCache&, params,
// CodeOp&). Operand decoding uses GekkoOperands helpers; reg-flow uses
// the CodeOp's regsIn/regsOut bitsets populated by PPCAnalyzer.
//
// Coverage: D-form arithmetic (addi/addic/addic./subfic/mulli), D-form
// logical (ori/oris/xori/xoris/andi./andis.), X-form arithmetic + logical
// (add/subf/mullw/and/andc/or/xor/nor/nand/eqv/orc/extsb/extsh/cntlzw/
// slw/srw/sraw/srawi/neg), CA-chain (adde/subfe/addme/subfme/addze/subfze/
// addc/subfc), wide mul (mulhw/mulhwu), divide (divw/divwu),
// rotate/mask (rlwinm/rlwimi/rlwnm), mftb, dcbz. All Rc=1 forms encode CR0
// via cr_encode.h. Mirrors the live gekko_emit.cpp 8 × u64 CR field layout
// at PowerPCState +0x2A0 byte-for-byte for oracle parity.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// D-form arithmetic immediate.
void emit_addi  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_addis (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_addic   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_addic_rc(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfic  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_mulli (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// D-form logical immediate.
void emit_ori   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_oris  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_xori  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);
void emit_xoris (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op);

// X-form arithmetic (op31 sub). All FL_RC_BIT → take ctx_ptr for CR0 update.
void emit_addx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_mullwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// D-form logical-and-immediate with Record (op 28 / 29). Always set CR0.
void emit_andix (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_andisx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// X-form logical (op31 sub) — bool family. All FL_RC_BIT.
void emit_andx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_andcx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_orx   (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_xorx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_norx  (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Sign-extend (op31 sub). FL_RC_BIT.
void emit_extsbx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_extshx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Count leading zeros (op31 sub). FL_RC_BIT.
void emit_cntlzwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Shift logical (op31 sub). FL_RC_BIT.
void emit_slwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_srwx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Arithmetic shift right with CA (op31 sub). XER.CA = sign-bit AND any-low-shifted-out-bit.
void emit_srawx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_srawix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// Negate (op31 sub:104). rt = -ra (two's complement). FL_RC_BIT.
void emit_negx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

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
// All three accept ctx_ptr so the Rc=1 form can write CR0 via cr_encode.
void emit_rlwinmx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_rlwimix(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_rlwnmx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// X-form carry arithmetic — single-operand carry-out (no XER.CA in,
// just OUT). addcx (op31 xo=10/522), subfcx (xo=8/520).
void emit_addcx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_subfcx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// X-form complemented logical — nand (xo=476), eqv (xo=284), orc (xo=412).
void emit_nandx(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_eqvx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_orcx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// X-form wide multiply — high 32 bits of 32x32 product.
//   mulhwx  (xo=75)  signed
//   mulhwux (xo=11)  unsigned
void emit_mulhwx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_mulhwux(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// X-form integer divide — guarded (PPC + Dolphin semantics on overflow/div0).
//   divwx  (xo=491/1003) signed
//   divwux (xo=459/971)  unsigned
void emit_divwx (WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);
void emit_divwux(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// mftb — Time Base read via SPR slot direct load (no CoreTiming call).
// xo=371. Only TBL (268) / TBU (269) are valid; others fall back.
void emit_mftb(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

// dcbz — zero a 32-byte cache line at EA = (ra?gpr[ra]:0) + gpr[rb].
// Op31 xo=1014. EA is 32-byte aligned. Emit as 8 x i32 store via
// WIMPORT_WRITE32 (matches gekko_emit.cpp:3707).
void emit_dcbz(WasmModuleBuilder& wb, RegCache& rc, const CodeOp& op, u32 ctx_ptr);

}  // namespace bemental::powerpc
