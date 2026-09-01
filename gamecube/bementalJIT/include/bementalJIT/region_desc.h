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

// [AOT v4 reloc 2026-08-13] Offline emit must bake ZERO native static addresses
// (the wild-address class: a native tool's &g_bem_* is ASLR-slid garbage in the
// worker). In reloc mode the emitter emits an OOB sentinel const
// (0xE0000000 | sym<<24 | addend, fixed 5-byte LEB — traps loudly if ever left
// unpatched) and records a reloc; the SEAL, which runs in the worker where
// &g_bem_* is trivially correct, patches the module bytes before instantiate.
enum BemRelocSym : u16 {
    BEM_RSYM_DISP_TAG   = 0,   // &g_bem_disp_tag[0]
    BEM_RSYM_DISP_SLOT  = 1,   // &g_bem_disp_slot[0]
    BEM_RSYM_MRTAG      = 2,   // &g_bem_mrtag[0]
    BEM_RSYM_MRSLOT     = 3,   // &g_bem_mrslot[0]
    BEM_RSYM_GP_DIRTY   = 4,   // &g_bem_gp_dirty
    BEM_RSYM_BLR_CHAIN  = 5,   // &bemental::g_blr_chain
    BEM_RSYM_RTAG       = 6,   // reserved (N-fn path, not in v4 scope)
    BEM_RSYM_RSLOT      = 7,   // reserved
    BEM_RSYM_CR_SHADOW  = 8,   // reserved (BEM_LAZY_CR latent class)
    BEM_RSYM_CR_PENDING = 9,   // reserved
    BEM_RSYM_COUNT      = 10,
    BEM_RSYM_NONE       = 0xFFFF,
};

struct BemAotReloc {
    u16 sym    = BEM_RSYM_NONE;
    u16 rsvd   = 0;
    u32 addend = 0;
    u32 offset = 0;   // module-absolute byte offset of the 5-byte const immediate
};

static inline u32 bem_reloc_sentinel(u16 sym, u32 addend) {
    return 0xE0000000u | ((u32)sym << 24) | (addend & 0x00FFFFFFu);
}

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
// out_relocs: non-null ONLY in offline reloc mode (g_bem_aot_reloc_mode=1) —
// receives the module-absolute reloc table for the BJAOTM v4 asset.
std::vector<u8> build_region_function_next_merged(const RegionBlockDesc* blocks,
                                                  u32 n_blocks,
                                                  u32 gen_idx,
                                                  u32 blr_chain_addr,
                                                  u32 mem_pages = 1,
                                                  std::vector<BemAotReloc>* out_relocs = nullptr);

}  // namespace bemental::powerpc
