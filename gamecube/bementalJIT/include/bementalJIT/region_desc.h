#pragma once
//
// region_desc.h — [region-merged 2026-07-15] shared descriptor for the REAL
// merged powerpc-next region builder. Lives in its own header so BOTH
// block_cache.cpp (the seal call site) and guests/powerpc-next/ppc_emit.cpp
// (the implementation) can see the type without the BlockInputs ODR tangle
// (BlockInputs is defined in gekko_emit.h AND redefined in block_cache.cpp;
// ppc_emit.h only forward-declares it — the documented collision that forced
// the old passthrough).

#include <vector>

#include "bementalJIT/types.h"

namespace bemental::powerpc {

struct RegionBlockDesc {
    u32        start_pc  = 0;
    const u32* insts     = nullptr;
    u32        count     = 0;
    u32        ctx_ptr   = 0;
    u32        mem1_base = 0;
    u32        mem1_mask = 0;
    u32        ram_size  = 0;
};

// Merged single-function region, powerpc-next codegen. Module: 13 imports +
// memory; func 13 = $region (8-group locals, (N+1)-deep block nest,
// br_table(entry_sel), N spliced emit_block_body_into bodies, default arm
// returns ctx.PC); funcs 14..14+N-1 = fn_k entry wrappers (exported ()->i32,
// registrable in the GLOBAL dispatch table: reset blr-chain budget + zero lap
// counter + set entry_sel + return_call $region). Globals: 0=entry_sel,
// 1=laps. Exports: "region", "entry_sel", "fn_<k>" (N-fn-parity names so the
// seal JS registration handles both shapes identically).
// Intra-region edges re-dispatch in-function (entry_sel=k; return_call) via
// the RUNTIME rtag/rslot probe with GEN-PACKED slots ((gen_idx<<16)|k): own-gen
// hits stay warm; other-gen hits fall through to the host chain and enter the
// owning gen through its global-table wrapper (measured-free tail-chain).
// A per-invocation lap counter (zeroed by wrappers) forces downcount=0 and a
// host exit at REGION_LAP_MAX warm edges with no pending exception — the
// in-region idle-poll escape (adversarial-verify wf_0ce30bf7 correction).
// blr_chain_addr: host address of bemental::g_blr_chain (C++-linkage symbol
// at bemental:: scope in block_cache.cpp — passed by value to avoid namespace
// surgery in the emitter TU).
std::vector<u8> build_region_function_next_merged(const RegionBlockDesc* blocks,
                                                  u32 n_blocks,
                                                  u32 gen_idx,
                                                  u32 blr_chain_addr,
                                                  u32 mem_pages = 1);

}  // namespace bemental::powerpc
