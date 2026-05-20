// wasm_emit.cpp — SHIL → WASM emitter (native).
//
// Phase-2 native emit ported from wasm_emit.h.reference. Covers integer ALU,
// shifts, comparisons, carry/rotate (adc/sbc/negc/rocl/rocr/shld/shad),
// 32x32→64 multiply (mul_u64/mul_s64), dynamic jumps/conds, area-3 fastmem
// readm/writem, FPU scalar arith + compare + convert, fmac, fsrra, fipr,
// ftrv, frswap, setpeq, mov64, pref, sync_sr/sync_fpscr, and shop_ifb.
//
// Division (div32u/div32s/div32p2/div1) intentionally falls through to the
// IFB fallback path because it's rare and the carry/dual-output logic is
// complex; ship native correctness first, optimize divides later.

#include "wasm_emit.h"
#include "hw/sh4/sh4_mem.h"
// rdv_readMemImmediate / rdv_writeMemImmediate — the same constant-folded
// address resolver rec_x64.cpp uses for its GenReadMemImmediate /
// GenWriteMemImmediate fastpath (rec_x64.cpp:848, :971). Returns isRam=true
// + a host pointer when the EA lands in mem_b/vram/aica_ram; under emcc a
// host pointer is a wasm linear-memory offset so we can bake it as an
// i32.const and emit a direct i32.load/store. Returns isRam=false when the
// EA resolves to MMIO — in that case we still skip the runtime area check
// since the physical address is now a known constant.
#include "hw/sh4/dyna/ngen.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace bemental::sh4 {

// VRAM linear-memory base. Bridge sets this at first SH4 dispatch (see
// dreamcast/flycast-bridge/rec_wasm.cpp). 0 = "not yet initialized,
// fall back to sh4_write32/read32 imports for area-4/5".
u32 g_vram_lin_base = 0;

// ---------------------------------------------------------------------------
// Env-var gates (module-scope, read once at first emit). Both default OFF —
// flipping requires FLYCAST_SELF_LOOP=1 / FLYCAST_LAZY_REGCACHE=1 in the host
// process environment before the worker spawns its bementalJIT instance.
//
//   FLYCAST_SELF_LOOP:    F3 — wrap self-branching short blocks in a wasm
//                         `loop $L; ...; br_if $L; end` rather than emitting a
//                         per-iteration return-to-dispatcher. Caps trampoline
//                         + dispatcher round-trips for tight wait loops (e.g.
//                         the 295K-iter spin observed at 0x8c008374).
//
//   FLYCAST_LAZY_REGCACHE: F9 — defer RegCache local population until first
//                          use, instead of eagerly reloading every assigned
//                          register in the block prologue. Avoids loads for
//                          registers a block scans-but-doesn't-execute (e.g.
//                          when the IFB fallback path is taken).
//
//   KNOWN LIMITATION (F9): lazy-load is emitted at the first BUILD-TIME use,
//   which may sit inside an `op_if`/`op_else` arm (see shop_shld / shop_shad
//   at lines 763..831). If the runtime path takes the OTHER arm first, the
//   target local is zero-initialized (wasm spec) rather than holding the
//   memory-backed register value. Mirrors the PowerPC `b11_coherence_bug`
//   class — proper fix is an if_depth counter à la bementalJIT/guests/
//   powerpc-next/reg_cache.cpp (m_if_depth gates B11 caching to depth 0).
//   Until that lands, F9 is best held behind FLYCAST_LAZY_REGCACHE=1 for
//   A/B perf evaluation; do not flip the default until coherence is fixed.
// ---------------------------------------------------------------------------
static bool s_self_loop_enabled = []{
    // TEMP: default ON for verification. getenv() doesn't reach the wasm
    // pthread worker, so env-var gating is non-functional. Revert to env-read
    // once gates are rewired via URL params or Module.preRun.
    const char* e = std::getenv("FLYCAST_SELF_LOOP");
    if (e) return e[0] != '0';
    return true;
}();

static bool s_lazy_regcache_enabled = []{
    const char* e = std::getenv("FLYCAST_LAZY_REGCACHE");
    return e && e[0] != '0';
}();

// Per-block interrupt-pend prologue check. Mirrors redream's x64 backend
// (x64_backend.cc:651-653): test ctx->interrupt_pend, on non-zero dispatch
// UpdateINTC via the SHIL_FB sentinel and exit the block. Without this we
// only catch pending interrupts at timeslice boundaries (every 448 cycles
// in rec_wasm.cpp:1407-1414), which under our reduced JIT throughput lets
// PSO IRL4-wait loops poll forever. Default ON; env-var doesn't reach the
// pthread worker so flipping requires rebuild.
static bool s_intc_pend_check = []{
    const char* e = std::getenv("FLYCAST_INTC_PROLOGUE");
    if (e) return e[0] != '0';
    return true;
}();

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

static inline void emitLoadParam(WasmModuleBuilder& b, const shil_param& p) {
    if (p.is_imm()) {
        b.op_i32_const((s32)p._imm);
    } else if (p.is_r32i() || p.is_r32f()) {
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(p.reg_offset());
    }
}

static inline void emitLoadParamF32(WasmModuleBuilder& b, const shil_param& p) {
    if (p.is_imm()) {
        float val;
        u32 bits = p._imm;
        std::memcpy(&val, &bits, 4);
        b.op_f32_const(val);
    } else {
        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(p.reg_offset());
    }
}

static inline void emitStoreRdF32(WasmModuleBuilder& b, const shil_param& rd) {
    b.op_f32_store(rd.reg_offset());
}

// Cache-aware load: push the register's value onto the stack.
// F9 lazy mode: if the cache local hasn't been loaded yet, emit a one-shot
// `local.get ctx; i32.load <off>; local.set <local>` before the local.get.
// const_cast is necessary because the prior signature is `const RegCache&`
// for nearly every call site; flipping the whole API to non-const would
// touch dozens of lines for a single bookkeeping bit. The mutation is
// confined to `loaded`/dirty flags — the cache structure itself is stable.
static inline void emitLoadParamCached(WasmModuleBuilder& b, const shil_param& p,
                                       const RegCache& cache) {
    if (p.is_imm()) {
        b.op_i32_const((s32)p._imm);
        return;
    }
    if (p.is_r32i()) {
        s32 local = cache.getLocal(p.reg_offset());
        if (local >= 0) {
            if (s_lazy_regcache_enabled && !cache.isLoaded(p.reg_offset())) {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(p.reg_offset());
                b.op_local_set((u32)local);
                const_cast<RegCache&>(cache).markLoaded(p.reg_offset());
            }
            b.op_local_get((u32)local);
            return;
        }
    }
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.reg_offset());
}

// emitPreStore: push ctx_ptr ONLY if rd is not cached (paired with emitPostStore).
static inline void emitPreStore(WasmModuleBuilder& b, const shil_param& rd,
                                const RegCache& cache) {
    if (rd.is_r32i() && cache.getLocal(rd.reg_offset()) >= 0) return;
    b.op_local_get(LOCAL_CTX);
}

// emitPostStore: local.set if cached (and mark dirty), else i32.store with offset.
// F9 lazy mode: a local.set fully overwrites the local, so the local is now
// the canonical value — mark loaded so subsequent reads skip the lazy fetch.
static inline void emitPostStore(WasmModuleBuilder& b, const shil_param& rd,
                                 RegCache& cache) {
    if (rd.is_r32i()) {
        s32 local = cache.getLocal(rd.reg_offset());
        if (local >= 0) {
            b.op_local_set((u32)local);
            cache.markDirty(rd.reg_offset());
            if (s_lazy_regcache_enabled) cache.markLoaded(rd.reg_offset());
            return;
        }
    }
    b.op_i32_store(rd.reg_offset());
}

static inline void emitPreStoreOffset(WasmModuleBuilder& b, u32 offset,
                                      const RegCache& cache) {
    if (cache.getLocal(offset) >= 0) return;
    b.op_local_get(LOCAL_CTX);
}

static inline void emitPostStoreOffset(WasmModuleBuilder& b, u32 offset,
                                       RegCache& cache) {
    s32 local = cache.getLocal(offset);
    if (local >= 0) {
        b.op_local_set((u32)local);
        cache.markDirty(offset);
        if (s_lazy_regcache_enabled) cache.markLoaded(offset);
    } else {
        b.op_i32_store(offset);
    }
}

// F9 reload point: in eager mode this is reloadAll (emit a fetch per assigned
// register); in lazy mode this is invalidateAll (next use will fetch on demand).
// Applies at the block prologue and after every IFB/SHIL_FB fallback call.
static inline void reloadOrInvalidate(WasmModuleBuilder& b, RegCache& cache) {
    if (s_lazy_regcache_enabled) cache.invalidateAll();
    else                         cache.reloadAll(b);
}

// F9 helper for exit-path readers (jdyn / sr.T). emitBlockExit takes
// `const RegCache&`, so we const_cast to mutate the loaded flag. Same
// rationale as emitLoadParamCached's const_cast — only bookkeeping bits
// flip, never the entry map's structure.
static inline void emitCachedLocalGet(WasmModuleBuilder& b,
                                      const RegCache& cache,
                                      u32 ctxOffset, u32 wasmLocal) {
    if (s_lazy_regcache_enabled && !cache.isLoaded(ctxOffset)) {
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctxOffset);
        b.op_local_set(wasmLocal);
        const_cast<RegCache&>(cache).markLoaded(ctxOffset);
    }
    b.op_local_get(wasmLocal);
}

// ---------------------------------------------------------------------------
// Immediate-address fastpath helpers — port of rec_x64.cpp's
// GenReadMemImmediate / GenWriteMemImmediate (rec_x64.cpp:848-1053).
//
// When the effective address is computable at emit time we can:
//   - For RAM: emit a direct i32.load[8s|16s] / i32.store[8|16] against the
//     resolved host pointer (under emcc this IS a linear-mem offset). No
//     runtime area check, no slow-path import call.
//   - For MMIO: emit a direct WIMPORT_READn / WIMPORT_WRITEn call with the
//     physical address baked as an i32.const. Skips the runtime
//     (masked >> 26) == 3 area discriminator and the redundant
//     LOCAL_TMP shuffle.
//
// Both helpers return true if they emitted the operation natively; false
// means the caller should fall through to the existing area-3 runtime
// fastpath (which is what rec_x64 does too — see rec_x64.cpp:217 and :255).
// We extend rec_x64's rs1-only test to also accept op.rs3.is_imm() so
// reg-imm pre-folded addresses (which the SH4 SHIL pass leaves as rs1=imm,
// rs3=imm separately on some patterns) still hit the fastpath.
// ---------------------------------------------------------------------------
static bool emitImmediateAddress(u32& out_addr, const shil_opcode& op) {
    if (!op.rs1.is_imm()) return false;
    u32 addr = op.rs1._imm;
    if (!op.rs3.is_null()) {
        if (!op.rs3.is_imm()) return false;
        addr += op.rs3._imm;
    }
    out_addr = addr;
    return true;
}

// PORTED FROM rec_x64.cpp:848-969 (GenReadMemImmediate).
// Emits the read-side immediate fastpath. The pre-amble (`emitPreStore` for
// the destination) is the caller's responsibility because rd is loaded once
// per call site — same shape as rec_x64 deferring host_reg_to_shil_param to
// after the value is computed.
static bool tryEmitReadmImmediate(WasmModuleBuilder& b, const shil_opcode& op,
                                  RuntimeBlockInfo* block, RegCache& cache) {
    u32 addr;
    if (!emitImmediateAddress(addr, op)) return false;

    void* ptr = nullptr;
    bool isRam = false;
    u32 physAddr = 0;
    // PORTED FROM rec_x64.cpp:855.
    if (!rdv_readMemImmediate(addr, op.size, ptr, isRam, physAddr, block))
        return false;

    // 64-bit pair read — PORTED FROM rec_x64.cpp:899-938.
    if (op.size == 8) {
        if (isRam && ptr != nullptr) {
            // Two 32-bit loads from contiguous host RAM. Cast `ptr` to u32:
            // emcc represents a host pointer as a wasm linear-memory offset.
            const u32 base = (u32)(uintptr_t)ptr;
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)base);
            b.op_i32_load(0);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)base);
            b.op_i32_load(4);
            b.op_i32_store(op.rd.reg_offset() + 4);
        } else {
            // MMIO 64-bit: two import calls. PORTED FROM rec_x64.cpp:918-937.
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)physAddr);
            b.op_call(WIMPORT_READ32);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)(physAddr + 4));
            b.op_call(WIMPORT_READ32);
            b.op_i32_store(op.rd.reg_offset() + 4);
        }
        return true;
    }

    // 1/2/4-byte path. Push the destination ctx_ptr (or skip if rd is
    // cached in a local) then emit the value computation, then PostStore.
    emitPreStore(b, op.rd, cache);

    if (isRam && ptr != nullptr) {
        // RAM: bake the host pointer as the linear-mem base for a direct
        // i32.load[Ns|Nu]. Signed extension matches rec_x64's movsx
        // (rec_x64.cpp:869, :880) — readConst handlers return sign-extended
        // bytes/halfs.
        const u32 base = (u32)(uintptr_t)ptr;
        b.op_i32_const((s32)base);
        switch (op.size) {
        case 1: b.op_i32_load8_s(0); break;
        case 2: b.op_i32_load16_s(0); break;
        default: b.op_i32_load(0); break;
        }
    } else {
        // MMIO: emit a direct call to the appropriate import with the
        // resolved physical address as the argument. PORTED FROM
        // rec_x64.cpp:941-964.
        b.op_i32_const((s32)physAddr);
        switch (op.size) {
        case 1: b.op_call(WIMPORT_READ8);  break;
        case 2: b.op_call(WIMPORT_READ16); break;
        default: b.op_call(WIMPORT_READ32); break;
        }
    }

    emitPostStore(b, op.rd, cache);
    return true;
}

// PORTED FROM rec_x64.cpp:971-1053 (GenWriteMemImmediate).
static bool tryEmitWriteMemImmediate(WasmModuleBuilder& b, const shil_opcode& op,
                                     RuntimeBlockInfo* block, RegCache& cache) {
    u32 addr;
    if (!emitImmediateAddress(addr, op)) return false;

    void* ptr = nullptr;
    bool isRam = false;
    u32 physAddr = 0;
    // PORTED FROM rec_x64.cpp:978.
    if (!rdv_writeMemImmediate(addr, op.size, ptr, isRam, physAddr, block))
        return false;

    // 64-bit pair write — PORTED FROM rec_x64.cpp:1027-1035.
    if (op.size == 8) {
        if (isRam && ptr != nullptr) {
            const u32 base = (u32)(uintptr_t)ptr;
            b.op_i32_const((s32)base);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_i32_store(0);

            b.op_i32_const((s32)base);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_i32_store(4);
        } else {
            // MMIO 64-bit: two write32 import calls.
            b.op_i32_const((s32)physAddr);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_call(WIMPORT_WRITE32);

            b.op_i32_const((s32)(physAddr + 4));
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_call(WIMPORT_WRITE32);
        }
        return true;
    }

    if (isRam && ptr != nullptr) {
        // PORTED FROM rec_x64.cpp:986-1024: store the data via a direct
        // i32.store[N] at the resolved host base.
        const u32 base = (u32)(uintptr_t)ptr;
        b.op_i32_const((s32)base);
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_i32_store8(0); break;
        case 2: b.op_i32_store16(0); break;
        default: b.op_i32_store(0); break;
        }
    } else {
        // PORTED FROM rec_x64.cpp:1046-1049: MMIO write through the import.
        b.op_i32_const((s32)physAddr);
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_call(WIMPORT_WRITE8);  break;
        case 2: b.op_call(WIMPORT_WRITE16); break;
        default: b.op_call(WIMPORT_WRITE32); break;
        }
    }

    return true;
}

// ---------------------------------------------------------------------------
// Per-op emit. Returns true if natively handled, false to fall back to IFB.
// ---------------------------------------------------------------------------
bool emitShilOp(WasmModuleBuilder& b, const shil_opcode& op,
                RuntimeBlockInfo* block, u32 opIndex, RegCache& cache) {
    switch (op.op) {

    // ---- Integer ALU ----
    // PORTED FROM xbyak_base.h:133-141 (shil_param_to_host_reg ==> mov rd,rs1)
    case shop_mov32:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:169-171 (genBinaryOp(op, add))
    case shop_add:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_add();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:172-174 (genBinaryOp(op, sub))
    // x86 genBinaryOp has a "neg+add" trick when rd==rs2 (xbyak_base.h:46-53);
    // unneeded here — wasm has no register aliasing, we emit a fresh
    // expression tree (load rs1; load rs2; i32.sub; store rd).
    case shop_sub:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_sub();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:160-162 (genBinaryOp(op, and_))
    case shop_and:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_and();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:163-165 (genBinaryOp(op, or_))
    case shop_or:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:166-168 (genBinaryOp(op, xor_))
    case shop_xor:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_xor();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:154-158 (mov rd,rs1; not_ rd)
    // Wasm has no `not` op; bitwise NOT is implemented as xor with all-ones.
    case shop_not:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(-1);
        b.op_i32_xor();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:149-153 (mov rd,rs1; neg rd)
    // Wasm has no `neg` op; two's-complement negate is 0 - x.
    case shop_neg:
        emitPreStore(b, op.rd, cache);
        b.op_i32_const(0);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_sub();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:176-185 (SHIFT_OP(shl))
    // SH4 SHIL only emits imm rs2 here (variable shifts are shop_shld/shad).
    // x86 emit dies on non-imm rs2; the wasm path also accepts reg-sourced
    // rs2 (harmless — wasm i32.shl masks shift count to low 5 bits, matching
    // x86 `shl r32, cl`).
    case shop_shl:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shl();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:186-188 (SHIFT_OP(shr))
    case shop_shr:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shr_u();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:189-191 (SHIFT_OP(sar))
    case shop_sar:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:192-194 (SHIFT_OP(ror))
    case shop_ror:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_rotr();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_ext_s8:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(24);
        b.op_i32_shl();
        b.op_i32_const(24);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_ext_s16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_u16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(0xFFFF);
        b.op_i32_and();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0xFFFF);
        b.op_i32_and();
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_s16:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_const(16);
        b.op_i32_shr_s();
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_mul_i32:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_mul();
        emitPostStore(b, op.rd, cache);
        return true;

    // PORTED FROM xbyak_base.h:143-147 (mov rd,rs1; ror rd.cvt16(), 8)
    // SWAP.B swaps the two low bytes [byte0 <-> byte1], leaving the high
    // 16 bits unchanged. x86 does this with a 16-bit ror-by-8 on the low
    // half. Wasm has no 16-bit-wide rotate, so we reconstruct manually:
    //   rd = ((rs1 >> 8) & 0xFF) | ((rs1 & 0xFF) << 8) | (rs1 & 0xFFFF0000)
    // Caches rs1 in LOCAL_TMP so we don't re-emit emitLoadParamCached three
    // times (in lazy-regcache mode that could trigger the F9 coherence bug).
    case shop_swaplb:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_local_tee(LOCAL_TMP);
        b.op_i32_const(8);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_const(8);
        b.op_i32_shl();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const((s32)0xFFFF0000u);
        b.op_i32_and();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_xtrct:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(16);
        b.op_i32_shr_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(16);
        b.op_i32_shl();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;

    // ---- Comparisons ----
    case shop_test:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_and();
        b.op_i32_eqz();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_seteq:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_eq();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setge:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_ge_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setgt:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_gt_s();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setae:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_ge_u();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setab:
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_gt_u();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_setpeq: {
        // PORTED FROM rec-x64/xbyak_base.h:355
        // setpeq: rd = 1 if any byte of (rs1 XOR rs2) is zero, else 0.
        // x64 short-circuits with `je end` after each byte-test; wasm has no
        // labelled gotos to jump out mid-expression, so we OR four byte-zero
        // results together (each i32 is 1 if that byte matched, 0 otherwise).
        // emitLoadParamCached for rs2 handles both reg and imm cases — xbyak
        // base branches on op.rs2.is_r32i() but the SHIL semantics are the
        // same regardless.
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_xor();
        b.op_local_tee(LOCAL_TMP);
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(8);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(16);
        b.op_i32_shr_u();
        b.op_i32_const(0xFF);
        b.op_i32_and();
        b.op_i32_eqz();
        b.op_i32_or();
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(24);
        b.op_i32_shr_u();
        b.op_i32_eqz();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- Dynamic jump / conditional ----
    // PORTED FROM xbyak_base.h:106-131 (shop_jcond / shop_jdyn shared block)
    // x86 writes the resolved jump target into mapRegister(op.rd) (a host
    // GPR) and lets rec_x64.cpp's epilogue read it. We can't preserve host
    // register state across the dispatcher boundary, so we spill the target
    // into ctx_off::JDYN (a context field) — the dispatcher reads it as the
    // next-PC. Per task constraint #4: do NOT emit a native wasm branch
    // here; the block-boundary semantics require the dispatcher.
    //
    // x86 handles rs1.is_imm() (line 113-121) by `mov rd, imm` (+ optional
    // add of rs2 imm). emitLoadParamCached already collapses that case into
    // an i32.const, and the rs2 add below mirrors xbyak_base.h:127-128.
    case shop_jdyn:
        emitPreStoreOffset(b, ctx_off::JDYN, cache);
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs2.is_null()) {
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_add();
        }
        emitPostStoreOffset(b, ctx_off::JDYN, cache);
        return true;

    // PORTED FROM xbyak_base.h:106-131. shop_jcond shares the case body with
    // shop_jdyn — both fold an optional rs2 (immediate offset) into rs1. The
    // prior wasm port assumed rs2 was always null for jcond; xbyak_base makes
    // no such assumption, so we now match it identically.
    case shop_jcond:
        emitPreStoreOffset(b, ctx_off::JDYN, cache);
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs2.is_null()) {
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_add();
        }
        emitPostStoreOffset(b, ctx_off::JDYN, cache);
        return true;

    // ---- Memory: 1/2/4-byte readm with area-3 fastpath ----
    case shop_readm: {
        // PORTED FROM rec_x64.cpp:216-251.
        // Immediate-address fastpath FIRST (rec_x64.cpp:217 — `if
        // (!GenReadMemImmediate(op, block))`). When the EA is constant at
        // emit time the resolver returns a host pointer (RAM) or a known
        // physical address (MMIO) and we skip the runtime area dispatch.
        if (tryEmitReadmImmediate(b, op, block, cache))
            return true;

        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        b.op_local_set(LOCAL_TMP);

        if (op.size == 8) {
            // 64-bit read (float pair): two 32-bit reads via import.
            b.op_local_get(LOCAL_TMP);
            b.op_call(WIMPORT_READ32);
            b.op_local_set(LOCAL_TMP2);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_store(op.rd.reg_offset());

            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(4);
            b.op_i32_add();
            b.op_call(WIMPORT_READ32);
            b.op_local_set(LOCAL_TMP2);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_store(op.rd.reg_offset() + 4);
            return true;
        }

        emitPreStore(b, op.rd, cache);

        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x1FFFFFFF);
        b.op_i32_and();
        b.op_local_tee(LOCAL_TMP);

        b.op_i32_const(26);
        b.op_i32_shr_u();
        b.op_i32_const(3);
        b.op_i32_eq();

        b.op_if(WASM_TYPE_I32);
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x00FFFFFF);
        b.op_i32_and();
        b.op_i32_add();
        switch (op.size) {
        case 1: b.op_i32_load8_s(0); break;
        case 2: b.op_i32_load16_s(0); break;
        default: b.op_i32_load(0); break;
        }
        b.op_else();
        // Slow path: recompute the ORIGINAL virtual address (rs1 + rs3).
        // The fast-path branch masked LOCAL_TMP to 0x1FFFFFFF, which would
        // collapse SH4 P4-region addresses (0xFF800000+, BSC/INTC/TMU MMIO)
        // down to P0 mirrors that hit unmapped space in Flycast's memmap.
        // Bug discovered 2026-05-14: BIOS at 0x800000A2 reads RFCR
        // (0xFF800028), got back 0 instead of 0x11, polled loop never exited.
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        switch (op.size) {
        case 1: b.op_call(WIMPORT_READ8);  break;
        case 2: b.op_call(WIMPORT_READ16); break;
        default: b.op_call(WIMPORT_READ32); break;
        }
        b.op_end();

        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- Memory: 1/2/4-byte writem with area-3 fastpath ----
    case shop_writem: {
        // PORTED FROM rec_x64.cpp:253-286.
        // Immediate-address fastpath FIRST (rec_x64.cpp:255 — `if
        // (!GenWriteMemImmediate(op, block))`). For an immediate EA that
        // resolves into VRAM the resolver returns `isram=true` with
        // ptr=&vram[offset] — under emcc that pointer IS the linear-mem
        // offset, so this naturally subsumes the area-4/5 g_vram_lin_base
        // path below for the immediate case while keeping the runtime
        // VRAM fastpath for register-based addresses.
        if (tryEmitWriteMemImmediate(b, op, block, cache))
            return true;

        if (op.size == 8) {
            emitLoadParamCached(b, op.rs1, cache);
            if (!op.rs3.is_null()) {
                emitLoadParamCached(b, op.rs3, cache);
                b.op_i32_add();
            }
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset());
            b.op_call(WIMPORT_WRITE32);

            emitLoadParamCached(b, op.rs1, cache);
            if (!op.rs3.is_null()) {
                emitLoadParamCached(b, op.rs3, cache);
                b.op_i32_add();
            }
            b.op_i32_const(4);
            b.op_i32_add();
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(op.rs2.reg_offset() + 4);
            b.op_call(WIMPORT_WRITE32);
            return true;
        }

        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        b.op_local_set(LOCAL_TMP);

        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x1FFFFFFF);
        b.op_i32_and();
        b.op_local_tee(LOCAL_TMP);

        b.op_i32_const(26);
        b.op_i32_shr_u();
        b.op_i32_const(3);
        b.op_i32_eq();

        b.op_if();
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(0x00FFFFFF);
        b.op_i32_and();
        b.op_i32_add();
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_i32_store8(0); break;
        case 2: b.op_i32_store16(0); break;
        default: b.op_i32_store(0); break;
        }
        b.op_else();
        // Area-4/5 (VRAM) fastpath. Bake the linear-mem base + 0x7FFFFF
        // (8 MiB) mask as constants. g_vram_lin_base is set by the bridge
        // at first SH4 dispatch; emitting 0 here means the bake is stale
        // and the runtime branch will still write the correct location
        // since `i32.const 0 + vram_offset` is a valid linear-mem address.
        // Cited blocker: 0x8c02ab4c PSO VRAM-fill loop hammered sh4_write32
        // 0x200000× per pass via the slow path; this collapses each word
        // write to a single i32.store. Emitter falls back to slow path if
        // vram base is uninitialized OR address is outside areas 3/4/5.
        if (g_vram_lin_base != 0) {
            // (masked >> 26) == 4  OR  (masked >> 26) == 5
            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(26);
            b.op_i32_shr_u();
            b.op_local_tee(LOCAL_TMP2);
            b.op_i32_const(4);
            b.op_i32_eq();
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_const(5);
            b.op_i32_eq();
            b.op_i32_or();
            b.op_if();
            // dst = g_vram_lin_base + (masked & 0x7FFFFF)
            b.op_i32_const((s32)g_vram_lin_base);
            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(0x7FFFFF);
            b.op_i32_and();
            b.op_i32_add();
            emitLoadParamCached(b, op.rs2, cache);
            switch (op.size) {
            case 1: b.op_i32_store8(0); break;
            case 2: b.op_i32_store16(0); break;
            default: b.op_i32_store(0); break;
            }
            b.op_else();
        }
        // Slow path: recompute the ORIGINAL virtual address. Same masking
        // bug as shop_readm above — must NOT use LOCAL_TMP (masked) here.
        emitLoadParamCached(b, op.rs1, cache);
        if (!op.rs3.is_null()) {
            emitLoadParamCached(b, op.rs3, cache);
            b.op_i32_add();
        }
        emitLoadParamCached(b, op.rs2, cache);
        switch (op.size) {
        case 1: b.op_call(WIMPORT_WRITE8);  break;
        case 2: b.op_call(WIMPORT_WRITE16); break;
        default: b.op_call(WIMPORT_WRITE32); break;
        }
        if (g_vram_lin_base != 0) b.op_end();   // close inner area-4/5 if
        b.op_end();                              // close outer area-3 if
        return true;
    }

    // ---- Single-op interpreter fallback ----
    case shop_ifb: {
        // PORTED FROM rec_x64.cpp:161-182
        // x64:  if (op.rs1._imm) sh4ctx.pc = op.rs2._imm; call OpDesc[op.rs3]->oph
        // wasm: same pc-write, then WIMPORT_IFB(opcode, pc) which routes to
        //       sh4_interp_ifb (EmscriptenWorker.cpp:983) on the host side.
        //
        // Unlike x64 (which has the host function pointer baked in at compile
        // time), wasm must round-trip through an import. To amortize the cost,
        // we inline native fast-paths below for DIV0U/DIV0S — flycast's
        // decoder emits these as shop_ifb but the semantics are simple enough
        // to expand inline.
        cache.flushAll(b);
        if (op.rs1._imm) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)op.rs2._imm);
            b.op_i32_store(ctx_off::PC);
        }
        // Inline fast paths for opcodes flycast's decoder emits as shop_ifb
        // but whose semantics are simple enough to emit natively in wasm,
        // bypassing the sh4_interp_ifb import call. Per
        // /tmp/dc-probes/ifb-pc-trace.log, DIV0U (0x0019) and DIV0S (0x2nm7)
        // fire 130-160/sec post-VRAM-fill, each shop_ifb costing the
        // full import-call round-trip. Native rec-x64 doesn't pay this
        // since the explicit-shil path produces native x86 directly.
        const u32 opc16 = (u32)op.rs3._imm & 0xFFFFu;
        // SH4 GPR offsets in Sh4Context: r[0]@0xC0=192, r[N]@192+4N.
        const u32 RBASE = 192;
        if (opc16 == 0x0019u) {
            // DIV0U: SR.Q=0, SR.M=0, SR.T=0
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::SR_STATUS);
            b.op_i32_const((s32)~((1u << 8) | (1u << 9)));
            b.op_i32_and();
            b.op_i32_store(ctx_off::SR_STATUS);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const(0);
            b.op_i32_store(ctx_off::SR_T);
            reloadOrInvalidate(b, cache);
            return true;
        }
        if ((opc16 & 0xF00Fu) == 0x2007u) {
            // DIV0S Rm,Rn (opcode 0x2nm7):
            //   Q = Rn[31]; M = Rm[31]; T = M^Q
            //   SR.Q -> bit 8 of SR_STATUS, SR.M -> bit 9
            const u32 n = (opc16 >> 8) & 0xFu;
            const u32 m = (opc16 >> 4) & 0xFu;
            const u32 rN_off = RBASE + n * 4;
            const u32 rM_off = RBASE + m * 4;
            // Q = Rn>>31; M = Rm>>31; T = Q^M
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(rN_off);
            b.op_i32_const(31); b.op_i32_shr_u();
            b.op_local_tee(LOCAL_TMP);              // TMP=Q (low bit)
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(rM_off);
            b.op_i32_const(31); b.op_i32_shr_u();
            b.op_local_tee(LOCAL_TMP2);             // TMP2=M
            b.op_i32_xor();                          // (Q^M) on stack
            b.op_local_set(LOCAL_TMP3);             // TMP3=T
            // SR_STATUS = (old & ~(Q|M)) | (Q<<8) | (M<<9)
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::SR_STATUS);
            b.op_i32_const((s32)~((1u << 8) | (1u << 9)));
            b.op_i32_and();
            b.op_local_get(LOCAL_TMP);
            b.op_i32_const(8); b.op_i32_shl();
            b.op_i32_or();
            b.op_local_get(LOCAL_TMP2);
            b.op_i32_const(9); b.op_i32_shl();
            b.op_i32_or();
            b.op_i32_store(ctx_off::SR_STATUS);
            // SR_T = T
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP3);
            b.op_i32_store(ctx_off::SR_T);
            reloadOrInvalidate(b, cache);
            return true;
        }
        // Default: PC convention etc., fall through to sh4_interp_ifb import.
        // Sh4cntx.pc == current_opcode_pc + 2 (sh4_interpreter.cpp ReadNexOp
        // advances pc to addr+2 BEFORE calling OpPtr; PC-relative loads and
        // branches expect this). decoder.cpp:70 sets op.rs2._imm = rpc + 2.
        b.op_i32_const((s32)op.rs3._imm);
        b.op_i32_const((s32)op.rs2._imm);
        b.op_call(WIMPORT_IFB);
        reloadOrInvalidate(b, cache);
        return true;
    }

    // ---- FPU scalar ----
    case shop_fadd:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_add();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fsub:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_sub();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fmul:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_mul();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fdiv:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_div();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fabs:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        b.op_f32_abs();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fneg:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        b.op_f32_neg();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fsqrt:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        b.op_f32_sqrt();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fseteq:
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_eq();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_fsetgt:
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        b.op_f32_gt();
        emitPostStore(b, op.rd, cache);
        return true;

    case shop_cvt_i2f_n:
    case shop_cvt_i2f_z:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_f32_convert_i32_s();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_cvt_f2i_t:
        // NaN → 0x80000000 per SH4 spec (wasm i32.trunc_sat_f32_s returns 0).
        emitPreStore(b, op.rd, cache);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs1);
        b.op_f32_eq();
        b.op_if(WASM_TYPE_I32);
        emitLoadParamF32(b, op.rs1);
        b.op_i32_trunc_sat_f32_s();
        b.op_else();
        b.op_i32_const((s32)0x80000000);
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;

    // ---- FPU vector / fused (f64 accumulation to match reference) ----
    case shop_fmac:
        b.op_local_get(LOCAL_CTX);
        emitLoadParamF32(b, op.rs1);
        emitLoadParamF32(b, op.rs2);
        emitLoadParamF32(b, op.rs3);
        b.op_f32_mul();
        b.op_f32_add();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fsrra:
        b.op_local_get(LOCAL_CTX);
        b.op_f32_const(1.0f);
        emitLoadParamF32(b, op.rs1);
        b.op_f32_sqrt();
        b.op_f32_div();
        emitStoreRdF32(b, op.rd);
        return true;

    case shop_fipr: {
        u32 off1 = op.rs1.reg_offset();
        u32 off2 = op.rs2.reg_offset();
        b.op_local_get(LOCAL_CTX);
        for (int i = 0; i < 4; ++i) {
            b.op_local_get(LOCAL_CTX);
            b.op_f32_load(off1 + i * 4);
            b.op_f64_promote_f32();
            b.op_local_get(LOCAL_CTX);
            b.op_f32_load(off2 + i * 4);
            b.op_f64_promote_f32();
            b.op_f64_mul();
            if (i > 0) b.op_f64_add();
        }
        b.op_f32_demote_f64();
        emitStoreRdF32(b, op.rd);
        return true;
    }

    case shop_ftrv: {
        u32 voff = op.rs1.reg_offset();
        u32 moff = op.rs2.reg_offset();

        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(voff);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP2);

        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(voff + 4);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP3);

        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(voff + 8);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP4);

        b.op_local_get(LOCAL_CTX);
        b.op_f32_load(voff + 12);
        b.op_i32_reinterpret_f32();
        b.op_local_set(LOCAL_TMP5);

        const u32 tmps[4] = { LOCAL_TMP2, LOCAL_TMP3, LOCAL_TMP4, LOCAL_TMP5 };
        for (int col = 0; col < 4; ++col) {
            b.op_local_get(LOCAL_CTX);
            for (int row = 0; row < 4; ++row) {
                b.op_local_get(tmps[row]);
                b.op_f32_reinterpret_i32();
                b.op_f64_promote_f32();
                b.op_local_get(LOCAL_CTX);
                b.op_f32_load(moff + (row * 4 + col) * 4);
                b.op_f64_promote_f32();
                b.op_f64_mul();
                if (row > 0) b.op_f64_add();
            }
            b.op_f32_demote_f64();
            b.op_f32_store(voff + col * 4);
        }
        return true;
    }

    case shop_frswap: {
        u32 off1 = op.rs1.reg_offset();
        u32 off2 = op.rd.reg_offset();
        for (int i = 0; i < 16; ++i) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(off1 + i * 4);
            b.op_local_set(LOCAL_TMP);

            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(off2 + i * 4);
            b.op_i32_store(off1 + i * 4);

            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_TMP);
            b.op_i32_store(off2 + i * 4);
        }
        return true;
    }

    // ---- Variable shifts ----
    case shop_shld: {
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0);
        b.op_i32_ge_s();
        b.op_if(WASM_TYPE_I32);
            emitLoadParamCached(b, op.rs1, cache);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_shl();
        b.op_else();
            b.op_i32_const(0);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_sub();
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
                b.op_i32_const(0);
            b.op_else();
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(0);
                emitLoadParamCached(b, op.rs2, cache);
                b.op_i32_sub();
                b.op_i32_const(0x1F);
                b.op_i32_and();
                b.op_i32_shr_u();
            b.op_end();
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    case shop_shad: {
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(0);
        b.op_i32_ge_s();
        b.op_if(WASM_TYPE_I32);
            emitLoadParamCached(b, op.rs1, cache);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_shl();
        b.op_else();
            b.op_i32_const(0);
            emitLoadParamCached(b, op.rs2, cache);
            b.op_i32_sub();
            b.op_i32_const(0x1F);
            b.op_i32_and();
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(31);
                b.op_i32_shr_s();
            b.op_else();
                emitLoadParamCached(b, op.rs1, cache);
                b.op_i32_const(0);
                emitLoadParamCached(b, op.rs2, cache);
                b.op_i32_sub();
                b.op_i32_const(0x1F);
                b.op_i32_and();
                b.op_i32_shr_s();
            b.op_end();
        b.op_end();
        emitPostStore(b, op.rd, cache);
        return true;
    }

    // ---- 64-bit copy (float register pairs) ----
    case shop_mov64:
        // PORTED FROM rec_x64.cpp:184-214
        // x64 with ALLOC_F64=false: rax = qword[rs1]; qword[rd] = rax.
        // x64 with ALLOC_F64=true:  movss between xmm halves with overlap shuffle.
        //
        // wasm has no 8-byte i64 store register-allocated to ctx fields and the
        // ALLOC_F64 fast-path would require x4 xmm-equivalent allocation that
        // we don't have, so we emit two 32-bit loads + stores. The flycast verify
        // asserts both ops are r64f — this matches `op.rs1.is_reg() && op.rd.is_reg()`.
        // Returns false (fall to IFB) only if either operand isn't a reg, which
        // shouldn't happen in practice but keeps us safe under unexpected IR.
        if (op.rs1.is_reg() && op.rd.is_reg()) {
            u32 srcOff = op.rs1.reg_offset();
            u32 dstOff = op.rd.reg_offset();
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(srcOff);
            b.op_i32_store(dstOff);
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(srcOff + 4);
            b.op_i32_store(dstOff + 4);
            return true;
        }
        return false;

    // ---- Dual-output (rd + rd2) using i64 scratch ----
    case shop_adc: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_add();
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_add();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_sbc: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        emitLoadParamCached(b, op.rs3, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        b.op_i32_const(1);
        b.op_i32_and();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_negc: {
        // PORTED FROM rec_x64.cpp:303-329
        // x64 trick: rd = -zext64(rs1); rd -= zext64(rs2); rd2 = rd >> 63.
        // The high bit of the 64-bit result is the borrow out (T) — if
        // (rs1 != 0) || (rs2 != 0), the subtraction underflows past zero and
        // bit 63 is set.
        //
        // wasm mirror: build the i64 result on stack via two i64_sub ops from
        // i64.const(0), then logical shift right by 63 to extract the borrow.
        // Equivalent to (and previously implemented as) "(high32 & 1)" — bit
        // 32 and bit 63 are equal here because rs1/rs2 are zext'd to 64 bits,
        // so the upper 32 bits are either all-zero (no borrow) or all-one
        // (borrow). Switching to shr_u(63) matches the rec_x64 emit literally
        // and emits one fewer wasm op per call site (no i32_const(1)+and).
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        b.op_i64_const(0);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_sub();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(63);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_rocl: {
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(31);
        b.op_i32_shr_u();
        b.op_local_set(LOCAL_TMP);

        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_shl();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(LOCAL_TMP);
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_rocr: {
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_and();
        b.op_local_set(LOCAL_TMP);

        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(1);
        b.op_i32_shr_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i32_const(31);
        b.op_i32_shl();
        b.op_i32_or();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(LOCAL_TMP);
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_mul_u64: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_u();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_u();
        b.op_i64_mul();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    case shop_mul_s64: {
        u32 t64 = cache.tmp64Local();
        emitPreStore(b, op.rd, cache);
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i64_extend_i32_s();
        emitLoadParamCached(b, op.rs2, cache);
        b.op_i64_extend_i32_s();
        b.op_i64_mul();
        b.op_local_tee(t64);
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd, cache);

        emitPreStore(b, op.rd2, cache);
        b.op_local_get(t64);
        b.op_i64_const(32);
        b.op_i64_shr_u();
        b.op_i32_wrap_i64();
        emitPostStore(b, op.rd2, cache);
        return true;
    }

    // ---- System ops that need flush+reload around a fallback call ----
    case shop_sync_sr:
    case shop_sync_fpscr:
        // PORTED FROM rec_x64.cpp:295-301
        // x64 directly emits GenCall(UpdateSR) or GenCall(Sh4Context::UpdateFPSCR).
        // wasm has no direct function-pointer call — instead route through
        // WIMPORT_SHIL_FB which looks up block->oplist[opIndex] on the host side
        // and dispatches to UpdateSR / Sh4Context::UpdateFPSCR. See
        // EmscriptenWorker.cpp:1095 (sh4_interp_shil_fb). This is one extra
        // host-side switch vs. rec_x64's direct call, but semantically identical.
        //
        // OPTIMIZATION OPPORTUNITY: a dedicated pair of imports
        // WIMPORT_SYNC_SR / WIMPORT_SYNC_FPSCR (no block_vaddr lookup, just
        // direct call) would shave the bm_GetBlock + oplist[op_idx] dispatch
        // per fire. See "Notes on missing imports" in the audit deliverable.
        cache.flushAll(b);
        b.op_i32_const((s32)block->vaddr);
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        reloadOrInvalidate(b, cache);
        return true;

    // ---- Prefetch: inline the no-op path, only call shil_fb for SQ region ----
    case shop_pref: {
        // PORTED FROM rec_x64.cpp:344-390
        // x64: tests (rs1 >> 26) == 0x38 (store-queue region 0xE0000000-),
        //      and only calls do_sqw_mmu_no_ex / sh4ctx.doSqWrite when matched;
        //      no-op otherwise. We do the same: emit a guard `if`, and only on
        //      match call out through WIMPORT_SHIL_FB which routes to
        //      sh4_interp_shil_fb's default-arm UpdateSR/UpdateFPSCR pair
        //      (which is wrong for pref but flycast's per-op handler will look
        //      up the original opcode from oplist[op_idx] and route correctly).
        //
        // NB: The handler IS pref-aware on the host side because
        // sh4_interp_shil_fb's switch only matches shop_sync_sr/_fpscr — pref
        // falls into the default-arm "call both" pair. That's a host-side bug
        // (defensive fallback) we should fix by extending the host switch.
        emitLoadParamCached(b, op.rs1, cache);
        b.op_i32_const(26);
        b.op_i32_shr_u();
        b.op_i32_const(0x38);
        b.op_i32_eq();
        b.op_if();
        for (auto& kv : cache.entries) {
            if (!kv.second.dirty) continue;
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(kv.second.wasmLocal);
            b.op_i32_store(kv.first);
        }
        b.op_i32_const((s32)block->vaddr);
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        if (s_lazy_regcache_enabled) {
            // No emit — invalidation is bookkeeping only; first post-call use
            // re-fetches. But the reload was previously inside an `if` arm, so
            // doing nothing here keeps the arm body well-formed and balanced.
            cache.invalidateAll();
        } else {
            for (auto& kv : cache.entries) {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(kv.first);
                b.op_local_set(kv.second.wasmLocal);
            }
        }
        b.op_end();
        return true;
    }

    // Canonical-only SHIL ops have no 1:1 SH4 opcode at op.guest_offs — they're
    // decoder lowerings (div32u/s/p2) or pure SHIL synthetics (fsca/illegal/
    // debug_*). The generic fallback below reads ReadMem16(guest_offs) and runs
    // the SH4 interpreter on whatever opcode happens to sit there, which is
    // semantically wrong for these ops. Route through WIMPORT_SHIL_FB instead,
    // which dispatches via shil_chf[op.op](&op) on the host side
    // (sh4_interp_shil_fb in EmscriptenWorker.cpp).
    case shop_div32u:
    case shop_div32s:
    case shop_div32p2:
    case shop_fsca:
    case shop_illegal:
    case shop_debug_1:
    case shop_debug_3:
        cache.flushAll(b);
        b.op_i32_const((s32)block->vaddr);
        b.op_i32_const((s32)opIndex);
        b.op_call(WIMPORT_SHIL_FB);
        reloadOrInvalidate(b, cache);
        return true;

    // shop_div1 corresponds 1:1 to SH4's div1 opcode — IFB fallback below
    // correctly invokes the SH4 interpreter on that exact instruction.
    case shop_div1:
    default:
        return false;
    }
}

// ---------------------------------------------------------------------------
// Block exit — writes ctx.pc per the block's BlockEndType class.
// ---------------------------------------------------------------------------
// Helper: returns the function index of a sibling block if linkable, else -1.
// Sibling-link is valid when (a) the vaddr→idx map is present, (b) the target
// vaddr is in the map, (c) target != this block's own vaddr (no self-link —
// trivial infinite tail-call chains add no value vs the C++ dispatcher's loop
// and confuse profilers).
static s32 sibling_func_idx(u32 target_vaddr, u32 self_vaddr,
                            const std::unordered_map<u32, u32>* vaddr_to_idx) {
    if (vaddr_to_idx == nullptr) return -1;
    if (target_vaddr == self_vaddr) return -1;
    auto it = vaddr_to_idx->find(target_vaddr);
    if (it == vaddr_to_idx->end()) return -1;
    return (s32)(WIMPORT_COUNT + it->second);
}

void emitBlockExit(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                   const RegCache& cache,
                   const std::unordered_map<u32, u32>* vaddr_to_idx) {
    u32 bcls = BET_GET_CLS(block->BlockType);
    const u32 self_vaddr = block != nullptr ? block->vaddr : 0u;

    // Intra-link helper: emit `local.get ctx; local.get ram; return_call idx`.
    // return_call is the wasm tail-call opcode — replaces the current stack
    // frame, so unbounded chains of linked blocks run in O(1) stack.
    auto emit_tail_to = [&](u32 func_idx) {
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_RAM);
        b.op_return_call(func_idx);
    };

    // Whether emitBlockExit's caller still needs to push the PC for the
    // function's return value. Tail-call paths handle their own return,
    // so the caller's trailing `local.get LOCAL_CTX; i32.load PC` becomes
    // unreachable (still valid wasm) and we set this to false. Currently
    // the caller in emitBlockFuncBody always pushes — that's fine for the
    // non-linked paths; the linked paths emit return_call which terminates
    // the function, making any subsequent ops unreachable.

    switch (bcls) {
    case BET_CLS_Static: {
        u32 target = (block->BlockType == BET_StaticIntr)
                        ? block->NextBlock
                        : block->BranchBlock;
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const((s32)target);
        b.op_i32_store(ctx_off::PC);

        // Intra-link for plain StaticJump (skip StaticIntr — UpdateINTC tail
        // call below must run first; skip StaticCall — semantics expect the
        // dispatcher to honor BSR's pr-save by going through the trampoline).
        if (block != nullptr && block->BlockType == BET_StaticJump) {
            s32 fidx = sibling_func_idx(target, self_vaddr, vaddr_to_idx);
            if (fidx >= 0) {
                emit_tail_to((u32)fidx);
                return;  // tail-call replaces frame; below is unreachable
            }
        }
        break;
    }

    case BET_CLS_Dynamic: {
        b.op_local_get(LOCAL_CTX);
        s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
        if (jdynLocal >= 0) {
            emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
        } else {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::JDYN);
        }
        b.op_i32_store(ctx_off::PC);
        break;
    }

    case BET_CLS_COND: {
        u32 cond = (block->BlockType == BET_Cond_1) ? 1 : 0;
        b.op_local_get(LOCAL_CTX);

        if (block->has_jcond) {
            s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
            if (jdynLocal >= 0) {
                emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::JDYN);
            }
        } else {
            s32 srTLocal = cache.getLocal(ctx_off::SR_T);
            if (srTLocal >= 0) {
                emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
            } else {
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::SR_T);
            }
        }

        if (cond == 1) {
            b.op_if(WASM_TYPE_I32);
        } else {
            b.op_i32_eqz();
            b.op_if(WASM_TYPE_I32);
        }
        b.op_i32_const((s32)block->BranchBlock);
        b.op_else();
        b.op_i32_const((s32)block->NextBlock);
        b.op_end();

        b.op_i32_store(ctx_off::PC);

        // Intra-link for BET_Cond: BOTH arms must be in the active set for
        // unconditional tail-call replacement. Otherwise, fall through to
        // the C++ dispatcher (which can chain to the right block on the
        // next iteration). Doing partial-link (only one arm tail-calls,
        // the other returns) would complicate the wasm control flow since
        // we'd need to undo the i32_store and re-branch.
        if (block != nullptr) {
            s32 br_idx   = sibling_func_idx(block->BranchBlock, self_vaddr, vaddr_to_idx);
            s32 next_idx = sibling_func_idx(block->NextBlock,   self_vaddr, vaddr_to_idx);
            if (br_idx >= 0 && next_idx >= 0) {
                // Re-derive the condition (SR_T or jdyn) into an if/else.
                if (block->has_jcond) {
                    s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                    if (jdynLocal >= 0) {
                        emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                    } else {
                        b.op_local_get(LOCAL_CTX);
                        b.op_i32_load(ctx_off::JDYN);
                    }
                } else {
                    s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                    if (srTLocal >= 0) {
                        emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                    } else {
                        b.op_local_get(LOCAL_CTX);
                        b.op_i32_load(ctx_off::SR_T);
                    }
                }
                if (cond == 1) {
                    b.op_if(0x40);   // void blocktype
                } else {
                    b.op_i32_eqz();
                    b.op_if(0x40);   // void blocktype
                }
                // taken arm — branch target
                emit_tail_to((u32)br_idx);
                b.op_else();
                // not-taken arm — next block
                emit_tail_to((u32)next_idx);
                b.op_end();
                // Both arms tail-called; control never returns to the
                // caller's trailing PC-load. That code is unreachable.
                return;
            }
        }
        break;
    }
    }

    // Tail-call UpdateINTC for blocks that end with an SR-affecting op
    // (LDC SR -> BET_StaticIntr, RTE -> BET_DynamicIntr). After the SR
    // change, decoded_srimask may have just reopened — UpdateINTC checks
    // Sh4cntx.interrupt_pend and dispatches Do_Interrupt() if any IRQ is
    // newly deliverable. Native rec-x64 does the equivalent via
    // GenCall(UpdateINTC) at rec_x64.cpp:517-531. Without this, BIOS's
    // first BL-clearing LDC clears BL in ctx but no IRQ is ever delivered,
    // so the IRQ-driven init sequence wedges. Sentinel block_vaddr=0xFF..F
    // routes the SHIL_FB import to UpdateINTC via sh4_interp_shil_fb.
    if (block != nullptr &&
        (block->BlockType == BET_StaticIntr ||
         block->BlockType == BET_DynamicIntr)) {
        b.op_i32_const((s32)0xFFFFFFFFu);   // sentinel
        b.op_i32_const(0);
        b.op_call(WIMPORT_SHIL_FB);
    }
}

// ---------------------------------------------------------------------------
// Memset byte-loop pattern detector + fast-path emitter.
//
// Targets the BSS-clear / buffer-init style loop seen on PSO boot at
// 0x8c0133f4 (see dreamcast_sh4_memset_loop_2026_05_17.md). Pattern:
//
//   mov.b R_val,@R_dst     ; shop_writem size=1
//   add #1,R_dst           ; shop_add rs2.imm=1, rd==rs1==R_dst
//   mov.l @R_endp,R_end    ; shop_readm size=4
//   cmp/hs R_end,R_dst     ; shop_setae rs1=R_dst (post-inc), rs2=R_end
//   bf <self>              ; BET_Cond_0, BranchBlock == vaddr
//
// When matched, instead of dispatching the 5-op block once per byte stored
// (the F3 self-loop gate at line 1379 rejects this shape — it only accepts
// shop_sub#1 or shop_seteq bodies), emit a single wasm `memory.fill` that
// covers [R_dst, R_end) in one operation. Falls back to the normal block
// emit if any runtime check fails (endpoints not in area-3 RAM, or
// R_end < R_dst).
// ---------------------------------------------------------------------------
struct MemsetPattern {
    bool detected      = false;
    u32  dst_off       = 0;    // ctx offset of R_dst (e.g. R5)
    u32  val_off       = 0;    // ctx offset of R_val (e.g. R4)
    u32  endp_off      = 0;    // ctx offset of R_endp (e.g. R6 — address holding end)
    u32  end_off       = 0;    // ctx offset of R_end (e.g. R2 — value loaded from @R_endp)
};

static MemsetPattern detectMemsetByteLoop(RuntimeBlockInfo* block) {
    MemsetPattern p;
    if (block == nullptr) return p;
    if (BET_GET_CLS(block->BlockType) != BET_CLS_COND) return p;
    if (block->BlockType != BET_Cond_0) return p;     // bf only
    if (block->BranchBlock != block->vaddr) return p; // taken arm == self
    if (block->oplist.size() != 4) return p;

    const shil_opcode& w = block->oplist[0];
    const shil_opcode& a = block->oplist[1];
    const shil_opcode& r = block->oplist[2];
    const shil_opcode& s = block->oplist[3];

    // writem size=1, address rs1, value rs2, no rs3 displacement.
    if (w.op != shop_writem || w.size != 1) return p;
    if (!w.rs1.is_r32i() || !w.rs2.is_r32i()) return p;
    if (!w.rs3.is_null()) return p;

    // add: rd = rs1 + 1; rd must alias rs1 (in-place ++), and equal writem's
    // address operand (we're incrementing the dest pointer).
    if (a.op != shop_add) return p;
    if (!a.rd.is_r32i() || !a.rs1.is_r32i() || !a.rs2.is_imm()) return p;
    if (a.rs2._imm != 1) return p;
    if (a.rd.reg_offset() != a.rs1.reg_offset()) return p;
    if (a.rd.reg_offset() != w.rs1.reg_offset()) return p;

    // readm size=4, address rs1, dest rd. No rs3 displacement.
    if (r.op != shop_readm || r.size != 4) return p;
    if (!r.rs1.is_r32i() || !r.rd.is_r32i()) return p;
    if (!r.rs3.is_null()) return p;

    // setae: rs1 = incremented dest, rs2 = loaded end. (cmp/hs Rm,Rn maps
    // to T = (Rn >= Rm) unsigned; flycast's SHIL canonicalizes so
    // rs1 holds the LHS of the >= comparison.)
    if (s.op != shop_setae) return p;
    if (!s.rs1.is_r32i() || !s.rs2.is_r32i()) return p;
    if (s.rs1.reg_offset() != a.rd.reg_offset()) return p;
    if (s.rs2.reg_offset() != r.rd.reg_offset()) return p;

    p.detected = true;
    p.dst_off  = w.rs1.reg_offset();
    p.val_off  = w.rs2.reg_offset();
    p.endp_off = r.rs1.reg_offset();
    p.end_off  = r.rd.reg_offset();
    return p;
}

// Emits the memset fast-path probe. Stack must be empty on entry.
// If the runtime checks (both endpoints in area-3 RAM AND end >= start AND
// dest_masked+len fits within MEM1) all pass, the fast path executes
// memory.fill, updates ctx (R_dst=R_end, T=1, PC=NextBlock, CYCLE_COUNTER
// debited proportionally), and `return`s. Otherwise control falls through
// with an empty stack to the regular block emit (the slow byte-loop).
//
// Uses direct ctx i32.load/i32.store (no cache locals) so it can run
// before reloadOrInvalidate, and so a fall-through leaves cache state
// untouched for the regular emit path.
static void emitMemsetFastPath(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                               const MemsetPattern& p)
{
    // Not named RAM_SIZE because flycast's types.h has a
    // `#define RAM_SIZE settings.platform.ram_size` that would substitute in
    // here and break the constexpr declaration.
    constexpr u32 MEM1_BYTES    = 0x01000000;   // MEM1 = 16 MiB
    constexpr u32 SH4_AREA_MASK = 0x1FFFFFFF;
    constexpr u32 SH4_LO24_MASK = 0x00FFFFFF;

    // dst_addr -> LOCAL_TMP
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.dst_off);
    b.op_local_set(LOCAL_TMP);

    // end_ptr_addr -> LOCAL_TMP2
    b.op_local_get(LOCAL_CTX);
    b.op_i32_load(p.endp_off);
    b.op_local_set(LOCAL_TMP2);

    // Read end value from @end_ptr_addr with area-3 fastpath, mirroring
    // the shop_readm fastpath at line 511-547. Result -> LOCAL_TMP3.
    b.op_local_get(LOCAL_TMP2);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_local_tee(LOCAL_TMP3);
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();
    b.op_if(WASM_TYPE_I32);
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
        b.op_i32_add();
        b.op_i32_load(0);
    b.op_else();
        b.op_local_get(LOCAL_TMP2);
        b.op_call(WIMPORT_READ32);
    b.op_end();
    b.op_local_set(LOCAL_TMP3);              // end_val (R2)

    // Combined fast-path condition:
    //   (dst_addr in area-3) && (end_val in area-3)
    //   && (end_val >= dst_addr) && (dst_masked + length <= MEM1_BYTES)
    // Computed as four bools AND'd; V8 still gets to short-circuit through
    // the outer `if` branch (only one fill site per memset).

    // dst_area3
    b.op_local_get(LOCAL_TMP);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();

    // end_val area-3
    b.op_local_get(LOCAL_TMP3);
    b.op_i32_const(SH4_AREA_MASK); b.op_i32_and();
    b.op_i32_const(26); b.op_i32_shr_u();
    b.op_i32_const(3); b.op_i32_eq();
    b.op_i32_and();

    // end_val >= dst (unsigned)
    b.op_local_get(LOCAL_TMP3);
    b.op_local_get(LOCAL_TMP);
    b.op_i32_ge_u();
    b.op_i32_and();

    // (dst_masked + (end_val - dst)) <= MEM1_BYTES — guards mirror-region
    // fills from overrunning MEM1's 16 MiB region in linear memory.
    // = (dst & LO24) + (end_val - dst) <= MEM1_BYTES
    b.op_local_get(LOCAL_TMP);
    b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
    b.op_local_get(LOCAL_TMP3);
    b.op_local_get(LOCAL_TMP);
    b.op_i32_sub();
    b.op_i32_add();
    b.op_i32_const((s32)MEM1_BYTES);
    b.op_i32_le_u();
    b.op_i32_and();

    b.op_if();
        // memory.fill(LOCAL_RAM + (dst & 0xFFFFFF), R_val, end - dst)
        b.op_local_get(LOCAL_RAM);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_const(SH4_LO24_MASK); b.op_i32_and();
        b.op_i32_add();

        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(p.val_off);

        b.op_local_get(LOCAL_TMP3);
        b.op_local_get(LOCAL_TMP);
        b.op_i32_sub();
        b.op_local_tee(LOCAL_TMP4);        // length, kept for cycle drain

        b.op_memory_fill();

        // R_dst = end_val
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_store(p.dst_off);

        // R_end already holds end_val on natural exit (mov.l @R_endp,R_end).
        // Store it explicitly so downstream code sees the same SHIL effect.
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_TMP3);
        b.op_i32_store(p.end_off);

        // SR.T = 1 (cmp/hs of equal endpoints sets T)
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const(1);
        b.op_i32_store(ctx_off::SR_T);

        // PC = NextBlock (bf-not-taken arm, i.e. exit the loop)
        b.op_local_get(LOCAL_CTX);
        b.op_i32_const((s32)block->NextBlock);
        b.op_i32_store(ctx_off::PC);

        // Cycle drain: 5 cycles per skipped iteration (loop body is 5
        // instructions on real SH4: mov.b, add, mov.l, cmp/hs, bf-d).
        b.op_local_get(LOCAL_CTX);
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::CYCLE_COUNTER);
        b.op_local_get(LOCAL_TMP4);
        b.op_i32_const(5);
        b.op_i32_mul();
        b.op_i32_sub();
        b.op_i32_store(ctx_off::CYCLE_COUNTER);

        // return ctx.pc
        b.op_local_get(LOCAL_CTX);
        b.op_i32_load(ctx_off::PC);
        b.op_return();
    b.op_end();
    // Fall-through: stack empty, normal block emit continues.
}

// ---------------------------------------------------------------------------
// Internal: emit one block's function body INTO an existing builder.
//
// Called by build_block between b.beginCodeSection(1) and the matching
// endSection(); caller is responsible for opening/closing the code section.
//
// Layout assumes the function signature is (i32 ctx_ptr, i32 ram_base) -> i32
// — same as the standalone build_block emits.
//
// Pre-scan allocates one i32 cache local per referenced register, plus a
// single i64 scratch for dual-output 64-bit ops.
//   Layout (after the 2 i32 params at indices 0,1):
//     indices 2..(2+i32Count-1)  : i32 locals (TMP..TMP5 + cache slots)
//     index   2+i32Count         : the i64 scratch
//
// BUG FIXED 2026-05-15: i32Count must be computed BEFORE setting
// _tmp64LocalIdx (otherwise local.tee(t64) writes i64 into an i32 slot, V8
// rejects entire module). See the original build_block comment for details.
// ---------------------------------------------------------------------------
static void emitBlockFuncBody(WasmModuleBuilder& b, RuntimeBlockInfo* block,
                              const std::unordered_map<u32, u32>* vaddr_to_idx = nullptr)
{
    b.beginFuncBody();

    RegCache cache;
    if (block != nullptr) cache.scanBlock(block);
    const u32 i32Count = LOCAL_FIXED_I32_COUNT + cache.localCount();
    cache._tmp64LocalIdx = 2 + i32Count;
    {
        const u32 counts[] = { i32Count, 1 };
        const u8  types[]  = { WASM_TYPE_I32, WASM_TYPE_I64 };
        b.emitLocals(2, counts, types);
    }

    if (block != nullptr) {
        // F3 self-loop detection.
        //   - block is BET_CLS_COND (Cond_0 / Cond_1)
        //   - the taken arm targets this block's own vaddr
        //   - block is short (heuristic 20-op cap; 0x8c008374-class spinners
        //     are typically 2-5 ops)
        //   - body contains a register decrement (`shop_sub` rs2 imm 1) or a
        //     direct seteq that produces the loop's exit predicate
        // When all four hold we emit `loop $L; body; cond; br_if 0; end;`
        // and write PC = NextBlock unconditionally on fall-through, bypassing
        // the regular BET_CLS_COND branch in emitBlockExit. The loop body
        // does the cycle-drain itself, so each iteration debits the block's
        // guest_cycles into CYCLE_COUNTER just as the dispatcher would.
        const u32 bcls = BET_GET_CLS(block->BlockType);
        bool self_loop = false;
        if (s_self_loop_enabled
            && bcls == BET_CLS_COND
            && block->BranchBlock == block->vaddr
            && block->oplist.size() < 20)
        {
            for (size_t i = 0; i < block->oplist.size(); ++i) {
                const shil_opcode& op = block->oplist[i];
                if (op.op == shop_sub && op.rs2.is_imm() && op.rs2._imm == 1) {
                    self_loop = true;
                    break;
                }
                if (op.op == shop_seteq) {
                    self_loop = true;
                    break;
                }
            }
        }

        // Memset byte-loop fast path. Detected BEFORE reloadOrInvalidate so
        // a successful early-return skips the cache prologue entirely. On
        // fall-through (runtime endpoint/length checks failed) cache state
        // is untouched — the regular emit path that follows runs unchanged.
        const MemsetPattern mp = detectMemsetByteLoop(block);
        if (mp.detected) {
            emitMemsetFastPath(b, block, mp);
        }

        // Lazy mode: prologue is a no-op; first use lazy-loads from memory.
        // Eager mode: emit reloadAll up-front (current default).
        // Both flavors run BEFORE the loop header so cached locals persist
        // across iterations rather than being re-fetched every time.
        reloadOrInvalidate(b, cache);

        // Per-block interrupt-pend check (Fix A — redream-style). If a peripheral
        // raise (asic_RaiseInterrupt) has set ctx->interrupt_pend AND the SR.IMASK
        // mask allows it, dispatch UpdateINTC via the SHIL_FB sentinel route
        // (block_vaddr=0xFFFFFFFF triggers UpdateINTC at EmscriptenWorker.cpp:1095)
        // and return ctx->pc — the dispatcher re-enters at the new PC after Flycast's
        // Do_Interrupt has rewritten it for the exception vector.
        if (s_intc_pend_check && block != nullptr) {
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::INTERRUPT_PEND);
            b.op_if();
                b.op_i32_const((s32)0xFFFFFFFFu);
                b.op_i32_const(0);
                b.op_call(WIMPORT_SHIL_FB);
                b.op_local_get(LOCAL_CTX);
                b.op_i32_load(ctx_off::PC);
                b.op_return();
            b.op_end();
        }

        if (self_loop) {
            b.op_loop();   // 0x40 / void blocktype — loop body produces no value
        }

        // Per-block cycle drain. block->guest_cycles is populated by Flycast's
        // decoder (sum of cpu_cycles for each guest op + base block cost) and
        // is what rec-x64/rec-arm decrement per-block. The mainloop's coarse
        // flat 32-cycle subtract is removed; this is the only cycle accounting.
        if (block->guest_cycles > 0) {
            b.op_local_get(LOCAL_CTX);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::CYCLE_COUNTER);
            b.op_i32_const((s32)block->guest_cycles);
            b.op_i32_sub();
            b.op_i32_store(ctx_off::CYCLE_COUNTER);
        }

        for (size_t i = 0; i < block->oplist.size(); ++i) {
            const shil_opcode& op = block->oplist[i];
            if (emitShilOp(b, op, block, (u32)i, cache)) continue;

            // Fallback: shop_ifb of this guest opcode (e.g. division).
            cache.flushAll(b);
            const u32 op_addr = block->vaddr + op.guest_offs;
            const u32 pc      = op_addr + 2;
            const u32 opc = (u32)ReadMem16(op_addr);
            b.op_i32_const((s32)opc);
            b.op_i32_const((s32)pc);
            b.op_call(WIMPORT_IFB);
            reloadOrInvalidate(b, cache);
        }

        if (self_loop) {
            // Re-derive the taken-arm predicate, br_if 0 if the loop should
            // continue. Mirrors the cond-deriving block in emitBlockExit's
            // BET_CLS_COND branch — we don't call emitBlockExit because (a)
            // it writes the i32 PC value on stack vs. our void blocktype,
            // and (b) we need the inverse fall-through to PC = NextBlock.
            const u32 cond_taken = (block->BlockType == BET_Cond_1) ? 1 : 0;
            if (block->has_jcond) {
                s32 jdynLocal = cache.getLocal(ctx_off::JDYN);
                if (jdynLocal >= 0) {
                    emitCachedLocalGet(b, cache, ctx_off::JDYN, (u32)jdynLocal);
                } else {
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(ctx_off::JDYN);
                }
            } else {
                s32 srTLocal = cache.getLocal(ctx_off::SR_T);
                if (srTLocal >= 0) {
                    emitCachedLocalGet(b, cache, ctx_off::SR_T, (u32)srTLocal);
                } else {
                    b.op_local_get(LOCAL_CTX);
                    b.op_i32_load(ctx_off::SR_T);
                }
            }
            if (cond_taken == 0) b.op_i32_eqz();   // br_if when (!cond) for Cond_0
            b.op_br_if(0);                          // depth 0 = top of `loop`
            b.op_end();                             // close `loop`

            // Fell out of loop = not-taken arm fired this iteration. Write
            // PC = NextBlock (the cond-fail target). flushAll first so any
            // dirty cache locals reach memory before exit.
            cache.flushAll(b);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_const((s32)block->NextBlock);
            b.op_i32_store(ctx_off::PC);
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::PC);
        } else {
            cache.flushAll(b);
            emitBlockExit(b, block, cache, vaddr_to_idx);
            // Trailing PC-load for non-linked paths. Unreachable (but valid) when
            // emitBlockExit emitted a return_call tail-call.
            b.op_local_get(LOCAL_CTX);
            b.op_i32_load(ctx_off::PC);
        }
    } else {
        b.op_i32_const(0);
    }

    b.endFuncBody();
}

// ---------------------------------------------------------------------------
// Module-envelope helpers. All emitted modules share the same type+import
// layout, so the WIMPORT_* indices (matched up against rec_wasm's
// flycast_build_imports) are stable.
// ---------------------------------------------------------------------------
static void emitTypeImportSection(WasmModuleBuilder& b)
{
    b.emitTypeSection(3);
    {
        const u8 i32t[]  = { WASM_TYPE_I32 };
        const u8 i32x2[] = { WASM_TYPE_I32, WASM_TYPE_I32 };
        b.emitFuncType(i32x2, 2, i32t,  1);   // (i32,i32)->i32  run, read*
        b.emitFuncType(i32t,  1, i32t,  1);   // (i32)->i32      read*
        b.emitFuncType(i32x2, 2, nullptr, 0); // (i32,i32)->()   write*, ifb, shil_fb
    }
    b.endSection();

    b.emitImportSection(1 + WIMPORT_COUNT);
    b.emitImportMemory("env", "memory", 1);
    b.emitImportFunc("env", "sh4_read8",   1);
    b.emitImportFunc("env", "sh4_read16",  1);
    b.emitImportFunc("env", "sh4_read32",  1);
    b.emitImportFunc("env", "sh4_write8",  2);
    b.emitImportFunc("env", "sh4_write16", 2);
    b.emitImportFunc("env", "sh4_write32", 2);
    b.emitImportFunc("env", "sh4_ifb",     2);
    b.emitImportFunc("env", "sh4_shil_fb", 2);
    b.endSection();
}

// ---------------------------------------------------------------------------
// Whole-block module build (legacy / single-block path).
// ---------------------------------------------------------------------------
std::vector<u8> build_block(RuntimeBlockInfo* block) {
    WasmModuleBuilder b;
    b.emitHeader();
    emitTypeImportSection(b);

    {
        const u32 idx[] = { 0 };
        b.emitFunctionSection(1, idx);
    }
    b.emitExportSection("run", WIMPORT_COUNT);

    // Data count section is mandatory whenever the code section uses
    // bulk-memory ops (memory.fill, memory.copy, data.drop). Emit it
    // unconditionally with count=0 since the module has no data segments —
    // cheap (3 bytes) and unlocks memory.fill in the memset fast path.
    b.emitDataCountSection(0);

    b.beginCodeSection(1);
    emitBlockFuncBody(b, block);
    b.endSection();
    return b.getBytes();
}

// ---------------------------------------------------------------------------
// F1 — Sharded multi-block module build. One module hosts N block functions,
// each exported as run_0..run_<N-1>. F2 intra-shard linking wires up: the
// vaddr→local-func-idx map below feeds emitBlockFuncBody, and the existing
// sibling_func_idx returns valid `return_call` targets for any branch target
// whose vaddr lives in the same shard. Cross-shard branches still fall
// through to the C++ dispatcher unchanged.
//
// Layout mirrors build_block's single-fn module otherwise: identical type +
// import sections (so WIMPORT_* indices stay stable), all N local funcs use
// the same type-0 signature ((i32,i32)->i32). Export section uses the
// multi-export API (beginExportSection / emitExport / endSection).
// ---------------------------------------------------------------------------
std::vector<u8> build_blocks(const std::vector<RuntimeBlockInfo*>& blocks) {
    WasmModuleBuilder b;
    b.emitHeader();
    emitTypeImportSection(b);

    const u32 n = (u32)blocks.size();

    // Build vaddr→local-func-idx map up-front so every block's emitBlockExit
    // can link to ALL sibling blocks regardless of emit order (forward and
    // backward refs both resolve).
    std::unordered_map<u32, u32> vaddr_to_idx;
    vaddr_to_idx.reserve(n);
    for (u32 i = 0; i < n; ++i) {
        if (blocks[i] != nullptr) {
            vaddr_to_idx[blocks[i]->vaddr] = i;
        }
    }

    // Function section: N entries, all using type 0 ((i32,i32)->i32).
    {
        std::vector<u32> typeIdx(n, 0u);
        b.emitFunctionSection(n, n > 0 ? typeIdx.data() : nullptr);
    }

    // Export section: N entries, "run_<i>" → WIMPORT_COUNT + i.
    // Buffer names; emitExport stores the const char* through emitName which
    // copies, but we keep the std::strings alive across the loop anyway for
    // safety.
    {
        std::vector<std::string> names(n);
        for (u32 i = 0; i < n; ++i) {
            names[i] = "run_" + std::to_string(i);
        }
        b.beginExportSection(n);
        for (u32 i = 0; i < n; ++i) {
            b.emitExport(names[i].c_str(), WASM_EXPORT_FUNC,
                         WIMPORT_COUNT + i);
        }
        b.endSection();
    }

    // Data count = 0; required by bulk-memory spec for memory.fill use.
    b.emitDataCountSection(0);

    // Code section: N function bodies. emitBlockFuncBody owns its own
    // beginFuncBody/endFuncBody pair so we just sequence them.
    b.beginCodeSection(n);
    for (u32 i = 0; i < n; ++i) {
        emitBlockFuncBody(b, blocks[i], &vaddr_to_idx);
    }
    b.endSection();
    return b.getBytes();
}

} // namespace bemental::sh4
