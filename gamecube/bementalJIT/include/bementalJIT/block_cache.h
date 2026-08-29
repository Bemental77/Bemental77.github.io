#pragma once
#include "types.h"
#include "region_desc.h"   // [AOT v4 reloc] BemAotReloc for aot_seal_merged
#include <array>
#include <cstddef>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace bemental {

// ---------------------------------------------------------------------------
// Multi-module region partitioning (Phase 2 of the multi-module refactor).
//
// The runtime carries one merged WASM module per region. Each module
// declares an INTERNAL funcref table populated with the region's block
// functions and exports each one as `fn_<idx>`. Branches inside a body
// that target same-region PCs are emitted as `call_indirect (table 0,
// type 0)` — V8's speculative inlining requires the call_indirect target
// to live in the same instance's table, so the table MUST NOT be imported.
//
// Region boundaries derive from observed PSO/SAB DOL load addresses
// captured 2026-05-03 (memory: multi_module_partition_2026_05_03.md):
//   MAIN_LOW       PCs <  0x80050000
//   HIGH_LOADER    PCs in 0x817e0000..0x81800000 (apploader-resident)
//   REL_0..REL_5   per-REL slots populated by the OSLink hook (Phase 5)
//   JIT_RUNTIME    catch-all (SMC, surprise PCs)
// ---------------------------------------------------------------------------
enum Region : u8 {
    REGION_MAIN_LOW    = 0,
    REGION_HIGH_LOADER = 1,
    REGION_REL_0       = 2,
    REGION_REL_1       = 3,
    REGION_REL_2       = 4,
    REGION_REL_3       = 5,
    REGION_REL_4       = 6,
    REGION_REL_5       = 7,
    REGION_JIT_RUNTIME = 8,
    REGION_COUNT       = 9,
};

// Classify a guest PC into a region. Phase 5 wires lookup_rel_for_pc to
// route per-REL PCs into REGION_REL_n; until then those land in
// REGION_JIT_RUNTIME.
Region classify(u32 pc);

// Per-region accumulator. Owns the concatenated body bytes for the next
// re-link. `fn_bodies_concat` stores each body in code-section
// function-entry format (5-byte LEB128 size prefix + locals + ops +
// 0x0B end) — exactly what WasmModuleBuilder produces between
// beginFuncBody() and endFuncBody().
// Source inputs needed to re-emit a single block at region_relink time
// with a different (typically more complete) lookup_fn. region_accumulate
// stores these alongside the body bytes; region_relink optionally re-emits
// every block before building the merged module so back-edge / forward
// cross-block branches can resolve to local fn indices and emit
// return_call_indirect (V8-inline-able intra-instance tail call) instead
// of the slow set_pc + return path.
struct BlockEmitInputs {
    u32                             start_pc      = 0;
    u32                             ctx_ptr_const = 0;
    u32                             mem1_base     = 0;
    u32                             mem1_mask     = 0;
    u32                             ram_size      = 0;
    // Option D: when true, emit path replaces every WIMPORT_* op_call
    // with an inline stub (drop args + i32.const 0 for returning imports,
    // drop args only for void). Used by ppc-worker perf-measurement so
    // dispatched blocks have ZERO env.ppc_* dependencies. Stored here
    // so region_relink's re-emit path preserves the choice.
    bool                            emit_perf_stub = false;
    // Item 5: when true, the block's prologue HLE check uses the
    // wasm-native SAB-resident hash-table lookup instead of the
    // env.ppc_hle_check import (or perf-stub drop+const-0). Stored so
    // re-emit at region_relink preserves the choice.
    bool                            emit_hle_check_native = false;
    // HLE pre-gate result: when false, the block has no registered
    // HLE hook matching start_pc (TryReplaceFunction + GetHookByAddress
    // both miss). Skipping the prologue check saves one JS round-trip
    // per dispatch on the ~95% unpatched PCs. Stored so region_relink's
    // re-emit path preserves the pre-gate decision (default true keeps
    // legacy callers conservative — they pay the round-trip).
    bool                            emit_hle_check = true;
    u32                             block_cycles = 0;  // analyzer numCycles (R2 downcount charge)
    std::vector<u32>                insts;          // raw guest opcodes
    std::vector<u32>                instr_pcs;      // parallel PC array
};

struct RegionState {
    std::vector<u8>                 fn_bodies_concat;
    u32                             n_funcs           = 0;
    std::vector<u32>                pc_keys;            // pc[i] -> local fn idx i
    std::unordered_map<u32, u32>    pc_to_idx;          // O(1) reverse lookup
    std::vector<BlockEmitInputs>    block_records;      // for re-emit at relink
    u32                             blocks_since_link = 0;
    double                          last_accum_ms     = 0.0;
    int                             module_handle     = -1;
    int                             generation        = 0;
    // Module-discard timing (V8 tier-up grace). Set in region_relink;
    // region_should_relink uses it to defer relink while the fresh module
    // is still inside V8's TurboFan tier-up window. Per V8 docs, tier-up
    // for tiny single-fn modules is ~300µs background work; for merged
    // modules with N≈hundreds of fns the bg compile-thread can take
    // multiple hundred ms. Without this gate every threshold-trigger
    // discards the fresh module before V8 ever upgrades it, capping
    // throughput at Liftoff-baseline.
    double                          last_relink_ms    = 0.0;
    u32                             dispatches_since_relink = 0;
};

// Runtime dispatcher for many compiled WASM modules.
// Keyed on guest-PC (or any hashable u64). Each module exports a single
// nullary function named "run" which is invoked on dispatch.
class BlockCache {
public:
    BlockCache() = default;
    ~BlockCache() { clear(); }

    BlockCache(const BlockCache&) = delete;
    BlockCache& operator=(const BlockCache&) = delete;

    // Compile WASM bytes, instantiate, and cache under `key`.
    // If `key` already maps to an instance, the old one is released first.
    // Returns JS-side handle (>= 0) on success, or -1 on failure.
    int compile(u64 key, const u8* bytes, std::size_t size);

    // Returns cached handle for `key`, or -1 if not present.
    int lookup(u64 key) const;

    // Invoke the "run" export of the cached block. Returns false if not cached.
    bool dispatch(u64 key);

    // Like dispatch(), but also captures the i32 returned by run().
    // *out is left untouched if the block is not cached.
    bool dispatch(u64 key, s32* out);

    // Drop a single entry.
    void evict(u64 key);

    // Drop everything. Detaches all JS-side instances.
    void clear();

    // [cache-cap 2026-08-29] Partial overflow eviction: drop the cache to 75% of
    // `cap` by removing never-promoted blocks first (PCs absent from
    // m_sealed_pcs / the AOT slot map), via the same per-PC evict() teardown the
    // SMC path uses. The alternative to clear()ing all 16384 entries — and the
    // merged region, every sealed generation and the AOT seal with them — the
    // instant the cap is touched. Selected at runtime by SAB cell 0x026B396C
    // bit 0; see the census block at the top of block_cache.cpp.
    void evict_cold(std::size_t cap);

    // SMC (self-modifying code) invalidation. Removes any cached block whose
    // [start_pc, start_pc + max_block_bytes) range covers `addr`. Called from
    // host write trampolines when a guest write targets memory that may be
    // cached as code. Conservative: uses a max block size as upper bound so
    // we don't need to track per-block sizes. May over-evict.
    void invalidate_overlap(u32 addr, u32 max_block_bytes = 256u);

    std::size_t size() const { return m_map.size(); }

    // Block chaining. Starting from `initial_pc`, dispatches the cached
    // block, takes its returned next-pc, dispatches the next cached block,
    // and continues entirely inside JS until: (a) the next pc has no cached
    // entry, (b) `max_iters` blocks have been dispatched, or (c) one of
    // the dispatched blocks WASM-traps. Out-params:
    //   *final_pc  = pc the caller should re-look-up (cache miss target,
    //                or the pc that trapped, or pc after max_iters)
    //   *trap_pc   = pc whose block trapped (caller must evict + fall back
    //                to interpreter for one instruction); 0 if no trap
    // Returns the count of blocks dispatched (use for downcount accounting).
    s32 chain_dispatch(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc,
                       const u32* exceptions_addr, const s32* downcount_addr);

    // ---- Phase 2 multi-module region API (additive — not yet wired into
    // the dispatcher path; Phase 4 routes dolphin_interp through it). ----

    // Append a freshly emitted body to its region's accumulator. body_bytes
    // is a single function-entry as produced by WasmModuleBuilder
    // (beginFuncBody → ... → endFuncBody): 5-byte LEB128 size prefix +
    // locals decl + ops + 0x0B end.
    //
    // When `inputs` is non-null, the BlockCache stores a copy of the
    // emit inputs so region_relink can re-emit this block with the now-
    // complete pc_to_idx map (delivers lever #2 — branches that targeted
    // unknown PCs at first emit get rewritten to local-fn-idx
    // return_call_indirect on relink). When `inputs` is null, the body is
    // baked permanently and relink can only rebuild from concat bytes.
    void region_accumulate(Region r, u32 pc,
                           const u8* body_bytes, std::size_t body_size,
                           const BlockEmitInputs* inputs = nullptr);

    // Threshold check. True when:
    //   ≥64 blocks accumulated since last re-link, OR
    //   ≥1 block accumulated AND >2000 ms since the last accumulate
    //   (steady-state catch — otherwise a region that JITs a handful of
    //    blocks then quiesces would sit in interp forever).
    bool region_should_relink(Region r) const;

    // Build the merged module via the guest emitter, instantiate it, and
    // populate the JS-side per-region pc → local_fn_idx Map. Drops the
    // previous region module (if any) after the new one is live.
    void region_relink(Region r, u32 mem_pages);

    // Look up `pc`'s region module + local fn idx, call the export, and
    // capture its i32 return (next-pc) into *out. Returns true on hit;
    // false → caller falls through to the legacy per-block / interp path.
    bool region_dispatch(u32 pc, s32* out);

    // [AOT A3.1] Register a PRE-BUILT merged module (offline aot_merge.cpp) as an
    // IMMUTABLE region gen at a reserved gen_idx (0xa07). Copies region_seal's
    // registration recipe (instantiate + wasmTable + bemental_gens/pc2gen + global
    // dispatch cache) + m_sealed_pcs, but uses a SEPARATE budget (m_aot_gen_count)
    // so it consumes no runtime gen slot. Returns true on success. Caller
    // (JitWasm) FNV-authenticates each block's live guest code before calling.
    // Idempotent-ish: sets m_aot_sealed; clear() resets it so Run() re-seals after
    // a savestate load (which wipes all gens). SMC eviction is handled by the
    // existing evict()/unseal_pc_js per-PC path (no baked edges in merged gens).
    // [AOT v4 reloc] relocs: sentinel sites to patch with THIS worker's real
    // &g_bem_* before instantiate (the wild-address fix — offline tools cannot
    // bake native addresses). Patching runs on a local copy; shipped bytes stay
    // pristine so the post-clear() re-seal re-patches fresh.
    bool aot_seal_merged(const u8* bytes, std::size_t len, const u32* pc_keys, u32 n, u32 gen_idx,
                         const powerpc::BemAotReloc* relocs = nullptr, u32 n_relocs = 0u);
    bool aot_is_sealed() const { return m_aot_sealed; }
    bool is_sealed_pc(u32 pc) const { return m_sealed_pcs.count(pc) != 0; }  // [AOT A3.1] SMC test observe

    // ---- Hot-only merge (2026-06-17) ----
    // stash_block: at compile time, remember a block's emit inputs (cheap; no
    // body emitted). promote_hot: once a block has been dispatched enough times
    // (counted in chain_dispatch_raw), re-emit its body and accumulate it into
    // the single hot merged region (REGION_REL_0, repurposed) so only the
    // actually-hot loop is merged — not all ~8900 mostly-cold blocks.
    // (The hot region is REGION_REL_0, an otherwise-unused Phase-5 REL slot.)
    void stash_block(u32 pc, const BlockEmitInputs& in);
    void promote_hot(u32 pc);

    // For REL unload (Phase 5). Drops the module and clears accumulator.
    void region_drop(Region r);

    // True if `pc` is already accumulated for its region (caller can skip
    // re-emission). Cheap O(1) hash lookup.
    bool region_has_pc(Region r, u32 pc) const;

    // Resolve `target_pc` to a same-region local fn idx. Used as the
    // backing for emit_block_body's LocalIdxLookupFn. Returns true on
    // hit; *out_idx receives the local fn idx (index into the region's
    // internal table, equivalently into pc_keys).
    bool region_lookup_local_idx(Region r, u32 target_pc, u32* out_idx) const;

    // Diagnostics.
    std::size_t region_n_funcs(Region r) const;
    int         region_generation(Region r) const;

private:
    // [sealed-multi-gen 2026-06-21] Seal the pending REGION_REL_0 batch into a
    // fresh IMMUTABLE generation module and append it (never rebuilt -> V8 tiers
    // it up once and keeps it). Replaces the grow-and-relink path for the hot
    // region, which cold-relinked the whole growing module every generation
    // (measured net-negative: 650 blocks halved ticks). region_relink routes
    // REGION_REL_0 here; non-REL_0 regions keep the legacy relink body.
    void region_seal(u32 mem_pages);
    // [PM54c fix 2c] release the pending batch (every early seal exit must
    // call this instead of stranding the batch).
    void region_reset_pending(RegionState& rs);

    std::unordered_map<u64, int>          m_map;
    std::array<RegionState, REGION_COUNT> m_regions{};
    // Hot-only merge: per-pc emit inputs stashed at compile, consumed by
    // promote_hot when a block goes hot. Bodies are re-emitted on promotion
    // (not stored) to keep this bounded by unique-block count.
    std::unordered_map<u32, BlockEmitInputs> m_pending_emit;
    // [sealed-multi-gen] Dedup: every PC ever sealed into ANY generation. Gates
    // promote_hot so a sealed PC is not re-promoted into the next pending batch
    // (pc_to_idx resets each seal). m_sealed_gen_count = live generation count
    // (also the next gen's index, and the MAX_GENS cap counter).
    std::unordered_set<u32> m_sealed_pcs;
    u32  m_sealed_gen_count = 0u;
    bool m_region_has_sealed = false;
    // [AOT A3.1] AOT gens are counted SEPARATELY so they never consume the 24-gen
    // runtime budget; region_dispatch's cold gate sums both. m_aot_sealed drives
    // re-seal after clear() (savestate load wipes all gens).
    u32  m_aot_gen_count = 0u;
    bool m_aot_sealed = false;
    // [PM54f SMC fix 2026-08-07] fused-successor pc -> predecessor pcs that
    // spliced it in via run-fusion. Eviction of a fused successor MUST also evict
    // these predecessors: the predecessor's compiled body embeds the successor's
    // (now stale) instructions, but JitWasm's m_block_guest_end[pred] covers only
    // the predecessor's own contiguous range, so InvalidateICacheRange(succ) never
    // selects the predecessor and it would keep running the stale spliced bytes.
    std::unordered_map<u32, std::vector<u32>> m_fused_succ_to_pred;
};

// ---- Lower-level free helpers ----
// Public so test harnesses and one-shot dispatch paths can use them
// without managing a BlockCache instance.

int  compile_raw(const u8* bytes, std::size_t size);
// Invokes the "run" export and returns its i32 result (0 if no instance
// or no run export). Side-effecting blocks can ignore the return.
s32  dispatch_raw(int handle);
void release_raw(int handle);

// Update / remove the JS-side `pc -> handle` map used by chain dispatch.
void register_pc_handle(u64 pc, int handle);
void unregister_pc(u64 pc);

// Free-helper variant of BlockCache::chain_dispatch.
// 2026-06-12: chains cached blocks inside ONE EM_ASM loop (no host
// round-trip per block). Requires blocks that self-account downcount
// (build_block_next prologue emits downcount -= numCycles). Bails on:
// cache miss, max_iters, trap, *exceptions_addr != 0, or
// *(s32*)downcount_addr <= 0 — the caller services CoreTiming /
// CheckExceptions exactly as it would between single dispatches.
s32  chain_dispatch_raw(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc,
                        const u32* exceptions_addr, const s32* downcount_addr);

} // namespace bemental
