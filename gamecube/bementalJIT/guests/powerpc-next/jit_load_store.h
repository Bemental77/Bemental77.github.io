#pragma once
//
// jit_load_store.h — Phase 3 integer load/store emitters. Replaces the
// path (a)/(b)/(c) soup in the live tree's emit_load_d/emit_store_d with
// a single guard-branch shape per scope-doc §4 Phase 3.
//
// Guard branch (per scope-doc §3.1):
//   ;; EA in a wasm local
//   (EA & 0x1F000000) == 0
//   AND
//   (EA & 0x01FFFFFF) < ram_size
//   if (guard):
//     fast path — direct i32.load/store with offset = mem1_base + (EA & mem1_mask)
//   else:
//     slow path — call WIMPORT_READ*/WRITE*  (MMIO routed by host handler)
//
// The path-(b) MMIO leak bug class (described in emit_path_b_correctness_bug.md)
// is structurally unreachable because the slow path is taken unconditionally
// on any out-of-MEM1 EA — including MMIO addresses like 0xCC005000 — without
// a "trust the DFA" bypass.

#include "bementalJIT/types.h"
#include "code_op.h"
#include "cr_shadow.h"        // [PM57] CmpFuse (adjacent cmp->branch fusion record)
#include "fpr_reg_cache.h"
#include "reg_cache.h"

class WasmModuleBuilder;

namespace bemental::powerpc {


// Per-block load/store parameters. Carry-by-value into each emit call.
// [PM55 EA-CSE 2026-08-04] Per-block last-D-form-EA cache. LOCAL_TMP_EA is
// overwritten by EVERY memory op's own emit_ea, so a computed EA is reusable
// only until the NEXT memory op — i.e. by the immediately-following mem op
// with an identical (ra, simm) provided the base register `ra` was not
// written in between. The emitter reuses when {valid && ra && simm} match;
// the dispatch loop clears `valid` after any op whose regsOut includes `ra`
// (and any op that itself recomputes EA overwrites the record). ra==0 is the
// const-EA form (base never changes) — cached on simm alone.
struct EaCache {
    s32  ra    = -1;     // -1 = empty
    s32  simm  = 0;
    bool valid = false;
};

struct LoadStoreParams {
    u32 ctx_ptr   = 0;   // PowerPCState address in host linear memory
    u32 mem1_base = 0;   // host pointer to MEM1 (0 disables fastmem entirely)
    u32 mem1_mask = 0;   // typically 0x01FFFFFF (32 MB minus 1)
    u32 ram_size  = 0;   // typically 0x02000000
    // [lc-window PM23] host pointer to the 256KB locked-L1 backing store
    // (Memory::GetL1Cache(); 0 disables the LC slow-arm shortcut). Guest
    // [0xE0000000, 0xE0040000) maps to lc_base + (EA & 0x3FFFF), guest-BE
    // like RAM — mirrors MMU.cpp's locked-L1 memcpy special case. THP's
    // IDCT pixel workspace lives here: 222.7M host calls per 120s probe
    // before this arm existed.
    u32 lc_base   = 0;
    // [PM55 EA-CSE] per-block last-EA cache (nullptr = disabled). Points at a
    // stack EaCache owned by emit_block_body_into; region + per-block paths
    // both supply one.
    EaCache* ea_cache = nullptr;
    // [PM57 cmp-fuse] per-block adjacent cmp->branch fusion record (nullptr =
    // disabled). Points at a stack CmpFuse owned by emit_block_body_into. A
    // deferring cmp sets it; the immediately-following conditional branch reads
    // it to emit a direct operand compare. Inert when BEM_LAZY_CR is false.
    CmpFuse* cmp_fuse = nullptr;
};

// WASM import indices. Match the existing live-tree contract in
// bementalJIT/guests/powerpc/gekko_emit.h (preserved across the rebuild).
enum class LoadWidth  : u8 { U8, U16, S16, U32 };
enum class StoreWidth : u8 { U8, U16, U32 };

// D-form load: EA = (RA==0 ? 0 : gpr[RA]) + SIMM. RT receives the loaded
// value. Update mode writes EA back to RA when update=true.
void emit_load_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// D-form store: EA = (RA==0 ? 0 : gpr[RA]) + SIMM. RS provides the stored
// value. Update mode writes EA back to RA when update=true.
void emit_store_d(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

// X-form load: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_load_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op,
                 LoadWidth width, bool update);

// X-form store: EA = (RA==0 ? 0 : gpr[RA]) + gpr[RB].
void emit_store_x(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                  LoadStoreParams params, const CodeOp& op,
                  StoreWidth width, bool update);

// ----- FP X-form (indexed) — single-precision load / store + stfiwx.
// All three route through the host WIMPORT slow path (no fastmem). The
// FPR is stored as f64 at PowerPCState +ps0(rs) per Dolphin's paired-single
// layout. lfsx promotes the f32 in memory to f64; stfsx demotes the f64 in
// the FPR back to f32. stfiwx writes the low 32 bits of the f64 slot
// (matches Dolphin's little-endian host storage of the f64).
//
// Op31 xo: 535 lfsx, 663 stfsx, 983 stfiwx. Per gekko_emit.cpp:2847-2878
// these were the top-3 of remaining op31 interp fallbacks (= 85% of total
// op31 fallbacks in a 500K-dispatch window).
void emit_lfsx  (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);
void emit_stfsx (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);
void emit_stfiwx(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op);

// ----- FP D-form (immediate offset) double load / store.
// lfd (opc 50), lfdu (opc 51), stfd (opc 54), stfdu (opc 55). Slowmem-only.
void emit_lfd (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);
void emit_stfd(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);

// ----- D-form load/store-multiple (opc 46/47). Per Jit64 Jit_LoadStore.cpp.
void emit_lmw (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op);
void emit_stmw(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op);

// ----- FP D-form (immediate offset) single load/store (opc 48 lfs,
// 49 lfsu, 52 stfs, 53 stfsu). Store uses PEM ConvertToSingle (bit-exact
// port of Interpreter_FPUtils.h:541-562, native as of 2026-06-11).
// psq_l/psq_lu (opcd 56/57) and psq_st/psq_stu (opcd 60/61) — native
// paired-single quantized load/store, D-forms. Bit-exact reference:
// Interpreter_LoadStorePaired.cpp. GQR type/scale are RUNTIME loads from
// spr[912+I] (no Jit64-style constant-GQR speculation — mtspr-to-GQR is an
// interp fallback that mutates spr[] mid-block; see jit_system_registers.cpp
// spr_is_direct). HID2.PSE/LSQE gates are NOT emitted (Jit64 parity — Jit64
// emits none of these; the interpreter raises Program when violated; games
// enable these bits in __LCEnable before any psq executes). DSI follows the
// lfs/stfs precedent (no gate — queued with the update-form RA audit item).
void emit_psq_l (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op, bool update);
void emit_psq_st(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
                 LoadStoreParams params, const CodeOp& op, bool update);

void emit_lfs (WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);
void emit_stfs(WasmModuleBuilder& wb, RegCache& rc, FPRRegCache& frc,
               LoadStoreParams params, const CodeOp& op, bool update);

// Shared widen helper: push ConvertToDouble(f32 bits in LOCAL_PSQ_T0=98)
// as i64 — NaN-payload-exact (promote + exp==255 splice). Used by the psq
// loads here and by jit_floating_point.cpp's ForceSingle result widening.
void emit_psq_convert_to_double(WasmModuleBuilder& wb);

}  // namespace bemental::powerpc
