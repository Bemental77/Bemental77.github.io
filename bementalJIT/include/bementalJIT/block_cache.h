#pragma once
#include "types.h"
#include <cstddef>
#include <unordered_map>

namespace bemental {

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
    s32 chain_dispatch(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc);

private:
    std::unordered_map<u64, int> m_map;
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
s32  chain_dispatch_raw(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc);

} // namespace bemental
