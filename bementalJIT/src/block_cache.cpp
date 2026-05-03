#include "bementalJIT/block_cache.h"

#include <climits>
#include <cstdint>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace bemental {

// Forward declaration for the guest emitter's merged-module builder.
// Defined in guests/powerpc/gekko_emit.cpp; declared here (rather than
// including gekko_emit.h) to keep block_cache.cpp guest-agnostic at the
// type level. When a second guest emitter (SH4) needs region modules,
// this becomes a function pointer registered at startup.
namespace powerpc {
    std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                        std::size_t concatenated_size,
                                        u32 n_funcs,
                                        u32 mem_pages);
}

int compile_raw(const u8* bytes, std::size_t size) {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const view = new Uint8Array(Module.HEAPU8.buffer, $0, $1);
        const copy = new Uint8Array(view); // detach: HEAPU8 may grow
        try {
            const mod = new WebAssembly.Module(copy);

            // Resolve the host's WebAssembly.Memory so guest blocks can share
            // the heap. The runtime-local `wasmMemory` global is always
            // available; `Module.wasmMemory` is only set if the user opts
            // into exporting it via -sEXPORTED_RUNTIME_METHODS, and probing
            // it triggers an abort() in default builds.
            const memObj = (typeof wasmMemory !== 'undefined') ? wasmMemory : null;
            // Flycast-style lazy-thunk-resolve: on the very first compile,
            // call each Module._fn once with safe dummy args. The first
            // call replaces the JS arrow thunk with the raw WebAssembly.
            // Function reference, so subsequent direct binding (env.* =
            // Module._fn) gives the WASM block a WASM→WASM cross-module
            // call instead of WASM→JS→WASM. By compile time, runtime is
            // fully initialised and the dummy calls are safe.
            if (Module.bemental_imports_need_upgrade) {
                try {
                    Module._dolphin_read8(0);
                    Module._dolphin_read16(0);
                    Module._dolphin_read32(0);
                    Module._dolphin_write8(0, 0);
                    Module._dolphin_write16(0, 0);
                    Module._dolphin_write32(0, 0);
                    Module._dolphin_check_exc(0);
                    Module._dolphin_break_block(0);
                    Module._dolphin_hle_check(0);
                    // Skip dolphin_interp(0,0) — it calls SingleStepInner
                    // which is not safe to invoke at random.
                    if (Module.bemental_imports && Module.bemental_imports.env) {
                        const e = Module.bemental_imports.env;
                        e.ppc_read8       = Module._dolphin_read8;
                        e.ppc_read16      = Module._dolphin_read16;
                        e.ppc_read32      = Module._dolphin_read32;
                        e.ppc_write8      = Module._dolphin_write8;
                        e.ppc_write16     = Module._dolphin_write16;
                        e.ppc_write32     = Module._dolphin_write32;
                        e.ppc_check_exc   = Module._dolphin_check_exc;
                        e.ppc_break_block = Module._dolphin_break_block;
                        e.ppc_hle_check   = Module._dolphin_hle_check;
                        // Keep ppc_interp as the JS wrapper (don't bypass).
                    }
                    const isWasm = (typeof WebAssembly.Function !== 'undefined')
                        ? Module._dolphin_read32 instanceof WebAssembly.Function
                        : true;
                    console.error('[bemental] direct-binding upgrade complete (raw WASM funcs: ' + isWasm + ')');
                } catch (e) {
                    console.error('[bemental] direct-binding upgrade failed:', e && e.message);
                }
                Module.bemental_imports_need_upgrade = false;
            }
            // Start with { env: { memory: ..., ...user-provided } }
            // Consumers can populate Module.bemental_imports.env with host
            // functions (e.g. ppc_read8) before calling compile.
            const env = {};
            if (memObj) env.memory = memObj;
            if (Module.bemental_imports && Module.bemental_imports.env) {
                Object.assign(env, Module.bemental_imports.env);
            }
            const importObj = { env: env };

            const inst = new WebAssembly.Instance(mod, importObj);

            // Andy Wingo's JIT-in-WASM pattern: register the block's
            // exported run() function in the host's shared
            // __indirect_function_table (`wasmTable`) at a sequential
            // index. The C dispatcher then casts that index to a function
            // pointer and calls it — Emscripten compiles the call to
            // `call_indirect` inside the host WASM module, so dispatch
            // stays entirely in WASM (no JS round-trip per block).
            //
            // Use `wasmTable.set(idx, raw_wasm_func)` directly (Flycast
            // pattern, line 1622) instead of Module.addFunction, which
            // wraps the function in an extra JS thunk.
            if (!Module._bemental_table_base) {
                Module._bemental_table_base = wasmTable.length;
                Module._bemental_next_idx   = wasmTable.length;
                wasmTable.grow(8192);  // bulk pre-allocate
            }
            let idx = Module._bemental_next_idx;
            if (idx >= wasmTable.length) wasmTable.grow(4096);
            wasmTable.set(idx, inst.exports.run);
            Module._bemental_next_idx = idx + 1;

            // Keep the JS-side cache so we can release / debug.
            if (!Module.bemental_cache) Module.bemental_cache = {};
            Module.bemental_cache[idx] = inst;

            // Throttle visibility — log every 256th compile.
            if ((Module._bemental_compile_n |0) % 256 === 0) {
                console.log('[bemental] compile #' + (Module._bemental_compile_n|0)
                            + ' table_idx=' + idx
                            + ' table_size=' + wasmTable.length);
            }
            Module._bemental_compile_n = ((Module._bemental_compile_n|0) + 1) | 0;
            return idx;
        } catch (e) {
            if (typeof console !== 'undefined') {
                console.error('[bemental] compile_raw failed:', e, e && e.message, e && e.stack);
                const head = copy.subarray(0, Math.min(32, copy.length));
                const hex = Array.from(head).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(' ');
                console.error('[bemental] size=' + copy.length + ' first 32 bytes:', hex);
            }
            return -1;
        }
    }, bytes, (int)size);
#else
    (void)bytes; (void)size;
    return -1;
#endif
}

// Block run() signature: () -> i32. As a C function pointer:
typedef u32 (*BemBlockFn)(void);

s32 dispatch_raw(int handle) {
#ifdef __EMSCRIPTEN__
    if (handle <= 0) return 0;
    // Cast the table index to a function pointer. Emscripten compiles
    // the indirect call below to `call_indirect`, which reads the
    // wasmTable entry — the raw WASM function we placed there in
    // compile_raw — and calls it directly. No JS round-trip.
    BemBlockFn fn = reinterpret_cast<BemBlockFn>(static_cast<std::uintptr_t>(handle));
    return static_cast<s32>(fn());
#else
    (void)handle;
    return 0;
#endif
}

void release_raw(int handle) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        // Clear the wasmTable slot — subsequent call_indirect on this
        // index will trap (which dispatch_raw catches via WASM trap →
        // JitWasm falls back to interpreter). We don't shrink the table
        // (Emscripten doesn't support shrinking).
        try { wasmTable.set($0, null); } catch (e) {}
        if (Module.bemental_cache && Module.bemental_cache[$0]) {
            Module.bemental_cache[$0] = null;
        }
        if (Module.bemental_pc_to_handle) {
            for (const [k, v] of Module.bemental_pc_to_handle) {
                if (v === $0) {
                    Module.bemental_pc_to_handle.delete(k);
                    break;
                }
            }
        }
    }, handle);
#else
    (void)handle;
#endif
}

void register_pc_handle(u64 pc, int handle) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (!Module.bemental_pc_to_handle) Module.bemental_pc_to_handle = new Map();
        Module.bemental_pc_to_handle.set($0 >>> 0, $1 | 0);
    }, static_cast<u32>(pc), handle);
#else
    (void)pc; (void)handle;
#endif
}

void unregister_pc(u64 pc) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (Module.bemental_pc_to_handle) {
            Module.bemental_pc_to_handle.delete($0 >>> 0);
        }
    }, static_cast<u32>(pc));
#else
    (void)pc;
#endif
}

// JS-side chain dispatch. Loops inside one EM_ASM call dispatching cached
// blocks via `Module.bemental_pc_to_handle.get(pc)`. Each block's return
// value becomes the next lookup key. Bails on cache miss, max_iters, or
// trap. Returns chain count; writes final pc + trap pc via pointer args.
s32 chain_dispatch_raw(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc) {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const map = Module.bemental_pc_to_handle;
        const cache = Module.bemental_cache;
        let pc = $0 >>> 0;
        const max = $1 >>> 0;
        const finalPcPtr = $2;
        const trapPcPtr = $3;
        if (!map || !cache) {
            HEAP32[finalPcPtr >>> 2] = pc | 0;
            HEAP32[trapPcPtr >>> 2] = 0;
            return 0;
        }
        let count = 0;
        while (count < max) {
            const handle = map.get(pc);
            if (handle === undefined) break;
            const inst = cache[handle];
            if (!inst || !inst.exports || typeof inst.exports.run !== 'function') break;
            try {
                pc = inst.exports.run() >>> 0;
            } catch (e) {
                if (Module.bemental_traps === undefined) Module.bemental_traps = 0;
                Module.bemental_traps++;
                if (Module.bemental_traps <= 16) {
                    console.error('[bemental] chain trap #' + Module.bemental_traps
                        + ' iter=' + count + ' handle=' + handle
                        + ' msg=' + (e && e.message ? e.message : String(e)));
                }
                // pc is unchanged when run() throws (assignment doesn't fire),
                // so it still holds the start_pc of the trapped block.
                HEAP32[finalPcPtr >>> 2] = pc | 0;
                HEAP32[trapPcPtr >>> 2] = pc | 0;
                return count;
            }
            count++;
        }
        HEAP32[finalPcPtr >>> 2] = pc | 0;
        HEAP32[trapPcPtr >>> 2] = 0;
        return count;
    }, initial_pc, max_iters, final_pc, trap_pc);
#else
    (void)initial_pc; (void)max_iters;
    if (final_pc) *final_pc = initial_pc;
    if (trap_pc) *trap_pc = 0;
    return 0;
#endif
}

int BlockCache::compile(u64 key, const u8* bytes, std::size_t size) {
    // Bound the cache to prevent OOM when the guest emits a flood of unique
    // blocks (e.g. JIT'ing garbage virtual addresses with MMU off — each one
    // compiles a fresh module). Wipe everything past the cap; hot blocks
    // recompile lazily on the next dispatch.
    //
    // Each entry pins a WebAssembly.Instance plus its compiled code object, so
    // 4096 was already pushing the tab. 1024 gives much earlier pressure
    // relief; hot inner loops still fit and recompile cheaply on miss.
    static constexpr std::size_t MAX_CACHE_BLOCKS = 16384;
    if (m_map.size() >= MAX_CACHE_BLOCKS) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.log('[bemental] cache evicted at cap (', $0, ')');
        }, (int)m_map.size());
#endif
        clear();
    }
    int handle = compile_raw(bytes, size);
    if (handle < 0) return -1;

    auto it = m_map.find(key);
    if (it != m_map.end()) {
        release_raw(it->second);
        it->second = handle;
    } else {
        m_map.emplace(key, handle);
    }
    register_pc_handle(key, handle);
    return handle;
}

int BlockCache::lookup(u64 key) const {
    auto it = m_map.find(key);
    return it == m_map.end() ? -1 : it->second;
}

bool BlockCache::dispatch(u64 key) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return false;
    (void)dispatch_raw(it->second);
    return true;
}

bool BlockCache::dispatch(u64 key, s32* out) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return false;
    s32 r = dispatch_raw(it->second);
    if (r == INT32_MIN) {
        // WASM trap — evict the block so we recompile fresh next time (in
        // case the trap was caused by stale-state / re-entry, not a real
        // bug). Return false; JitWasm::Run() falls back to SingleStepInner
        // for one instruction, which advances pc past the trapping op.
#ifdef __EMSCRIPTEN__
        EM_ASM({
            if (Module.bemental_block_traps === undefined) Module.bemental_block_traps = 0;
            Module.bemental_block_traps++;
            if (Module.bemental_block_traps <= 16) {
                console.error('[bemental] block trap key=0x'
                    + ($0>>>0).toString(16) + ' handle=' + $1
                    + ' (#' + Module.bemental_block_traps + ')');
            }
        }, static_cast<u32>(key), it->second);
#endif
        release_raw(it->second);
        m_map.erase(it);
        return false;
    }

    if (out) *out = r;
    return true;
}

void BlockCache::evict(u64 key) {
    auto it = m_map.find(key);
    if (it == m_map.end()) return;
    release_raw(it->second);
    m_map.erase(it);
}

void BlockCache::clear() {
    for (const auto& kv : m_map) release_raw(kv.second);
    m_map.clear();
#ifdef __EMSCRIPTEN__
    EM_ASM({ if (Module.bemental_pc_to_handle) Module.bemental_pc_to_handle.clear(); });
#endif
}

void BlockCache::invalidate_overlap(u32 addr, u32 max_block_bytes) {
    // Iterate all cached blocks; remove any whose [start_pc, start_pc +
    // max_block_bytes) range contains addr. We don't track per-block sizes,
    // so use max_block_bytes (default 256B = 64 instructions) as the upper
    // bound on block length. Over-eviction is correctness-safe: blocks just
    // recompile on next dispatch.
    for (auto it = m_map.begin(); it != m_map.end(); ) {
        const u32 start_pc = static_cast<u32>(it->first);
        if (addr >= start_pc && addr < start_pc + max_block_bytes) {
            release_raw(it->second);
            it = m_map.erase(it);
        } else {
            ++it;
        }
    }
}

s32 BlockCache::chain_dispatch(u32 initial_pc, u32 max_iters, u32* final_pc, u32* trap_pc) {
    u32 fpc = initial_pc;
    u32 tpc = 0;
    s32 count = chain_dispatch_raw(initial_pc, max_iters, &fpc, &tpc);
    if (tpc != 0u) {
        // Evict the trapped block from the C++ map. release_raw inside
        // chain_dispatch_raw does not run for the trapped block (the chain
        // exits with the trapped handle still in cache), so do it here.
        auto it = m_map.find(tpc);
        if (it != m_map.end()) {
            release_raw(it->second);
            m_map.erase(it);
        }
    }
    if (final_pc) *final_pc = fpc;
    if (trap_pc) *trap_pc = tpc;
    return count;
}

// ---------------------------------------------------------------------------
// Multi-module region API (Phase 2). See block_cache.h for the design notes
// (internal table per module, V8 inlining invariant, partition source).
// ---------------------------------------------------------------------------

Region classify(u32 pc) {
    // MAIN_LOW upper bound covers both PSO (main DOL ends ~0x80046800)
    // and SAB (main DOL ends ~0x801de1e0). Single 0x80200000 bound serves
    // both games — see multi_module_partition_2026_05_03.md.
    if (pc >= 0x80000000u && pc < 0x80200000u)         return REGION_MAIN_LOW;
    if (pc >= 0x817e0000u && pc < 0x81800000u)         return REGION_HIGH_LOADER;
    // Phase 5 will populate REL_n via lookup_rel_for_pc.
    return REGION_JIT_RUNTIME;
}

// Monotonic millisecond clock. Uses emscripten_get_now() under emcc (returns
// double ms with sub-ms resolution) and a fallback otherwise so the host
// build still compiles without -DBUILD_FOR_BROWSER.
static double now_ms() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    return 0.0;
#endif
}

void BlockCache::region_accumulate(Region r, u32 pc,
                                   const u8* body_bytes, std::size_t body_size) {
    if (r >= REGION_COUNT) return;
    if (body_bytes == nullptr || body_size == 0) return;
    RegionState& rs = m_regions[r];

    // Dedup: if this pc is already accumulated, skip. The first emission
    // is canonical for the region's current generation. (Phase 7 might
    // re-emit dirty bodies at re-link time to upgrade unresolved branches
    // — that path would clear the region first.)
    if (rs.pc_to_idx.find(pc) != rs.pc_to_idx.end()) return;

    // Append the body verbatim. body_bytes is in code-section function-entry
    // format (5-byte LEB128 size prefix + locals + ops + 0x0B end), as
    // produced by WasmModuleBuilder. The merged-module emitter concats
    // these directly into its code section.
    const u32 local_idx = rs.n_funcs;
    rs.fn_bodies_concat.insert(rs.fn_bodies_concat.end(),
                               body_bytes, body_bytes + body_size);
    rs.pc_keys.push_back(pc);
    rs.pc_to_idx.emplace(pc, local_idx);
    rs.n_funcs           += 1u;
    rs.blocks_since_link += 1u;
    rs.last_accum_ms      = now_ms();

#ifdef __EMSCRIPTEN__
    // Diagnostic uses [worker] prefix so the probe puts it in the
    // worker bucket (displayed in full); generic [bemental] strings land
    // in the "other" bucket which is truncated to last 15 lines.
    if (local_idx == 0u) {
        EM_ASM({
            console.error('[worker] [bemental] region ' + $0 + ' first accumulate pc=0x'
                + ($1>>>0).toString(16) + ' body_size=' + $2);
        }, (int)r, pc, (int)body_size);
    }
    if ((rs.n_funcs & 63u) == 0u) {
        EM_ASM({
            console.error('[worker] [bemental] region ' + $0 + ' n_funcs=' + $1
                + ' blocks_since_link=' + $2);
        }, (int)r, (int)rs.n_funcs, (int)rs.blocks_since_link);
    }
#endif
}

bool BlockCache::region_has_pc(Region r, u32 pc) const {
    if (r >= REGION_COUNT) return false;
    return m_regions[r].pc_to_idx.find(pc) != m_regions[r].pc_to_idx.end();
}

bool BlockCache::region_lookup_local_idx(Region r, u32 target_pc, u32* out_idx) const {
    if (r >= REGION_COUNT) return false;
    const auto& m = m_regions[r].pc_to_idx;
    auto it = m.find(target_pc);
    if (it == m.end()) return false;
    if (out_idx) *out_idx = it->second;
    return true;
}

bool BlockCache::region_should_relink(Region r) const {
    if (r >= REGION_COUNT) return false;
    const RegionState& rs = m_regions[r];

    // Trigger 1: enough new blocks accumulated to make a re-link worthwhile.
    // Bumped from 64 → 256 after measuring 9 re-links per 60 s probe at 64
    // — each re-link is a fresh V8 compile of a 100-400 KB merged module.
    // The compile cost dominated dispatch time during warmup. 256 cuts
    // re-link frequency 4× without leaving large gaps between merges.
    if (rs.blocks_since_link >= 256u) return true;

    // Trigger 2: steady-state catch — the region has at least one block
    // pending and hasn't accumulated a new one in >2 s. Without this, a
    // region that JITs a handful of blocks then quiesces would never get
    // its merged module built.
    if (rs.blocks_since_link >= 1u) {
        const double age = now_ms() - rs.last_accum_ms;
        if (age > 2000.0) return true;
    }

    return false;
}

void BlockCache::region_relink(Region r, u32 mem_pages) {
    if (r >= REGION_COUNT) return;
    RegionState& rs = m_regions[r];
    if (rs.n_funcs == 0u) return;

    // Build the merged-module bytes via the guest emitter.
    std::vector<u8> bytes = powerpc::build_region_module(
        rs.fn_bodies_concat.data(),
        rs.fn_bodies_concat.size(),
        rs.n_funcs,
        mem_pages);
    if (bytes.empty()) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.error('[bemental] region', $0,
                ' relink: build_region_module returned empty bytes');
        }, (int)r);
#endif
        return;
    }

#ifdef __EMSCRIPTEN__
    // Instantiate, populate JS-side per-region pc->local_fn_idx Map, and
    // swap module_handle. Keep the previous instance alive in
    // Module.bemental_regions_old until we've successfully bound the new
    // one — guards against an instantiate failure leaving the region with
    // no live module.
    const int new_handle = EM_ASM_INT({
        const r          = $0 | 0;
        const bytesPtr   = $1;
        const bytesLen   = $2 >>> 0;
        const pcKeysPtr  = $3;
        const nFuncs     = $4 >>> 0;
        const generation = $5 | 0;
        try {
            const view = new Uint8Array(Module.HEAPU8.buffer, bytesPtr, bytesLen);
            const copy = new Uint8Array(view);
            const mod  = new WebAssembly.Module(copy);

            const memObj = (typeof wasmMemory !== 'undefined') ? wasmMemory : null;
            const env = {};
            if (memObj) env.memory = memObj;
            if (Module.bemental_imports && Module.bemental_imports.env) {
                Object.assign(env, Module.bemental_imports.env);
            }
            const inst = new WebAssembly.Instance(mod, { env: env });

            // Build pc -> local_fn_idx Map from the parallel pc_keys array.
            const pcMap = new Map();
            for (let i = 0; i < nFuncs; i++) {
                const pc = HEAPU32[(pcKeysPtr >>> 2) + i] >>> 0;
                pcMap.set(pc, i);
            }

            // Pre-resolve each fn_<i> export into a JS array indexed by
            // local fn idx — avoids a string lookup per dispatch.
            const fns = new Array(nFuncs);
            for (let i = 0; i < nFuncs; i++) {
                fns[i] = inst.exports['fn_' + i];
            }

            if (!Module.bemental_regions) Module.bemental_regions = {};
            const prev = Module.bemental_regions[r];
            const region = {};
            region.instance   = inst;
            region.fns        = fns;
            region.pcMap      = pcMap;
            region.nFuncs     = nFuncs;
            region.generation = generation;
            Module.bemental_regions[r] = region;
            if (prev) prev.instance = null;
            console.log('[worker] [bemental] region ' + r + ' relinked gen=' + generation
                + ' n_funcs=' + nFuncs + ' bytes=' + bytesLen);
            return r;
        } catch (e) {
            console.error('[bemental] region ' + r + ' relink failed: '
                + (e && e.message ? e.message : String(e)));
            return -1;
        }
    },
    (int)r,
    bytes.data(), (int)bytes.size(),
    rs.pc_keys.data(), (int)rs.n_funcs,
    rs.generation + 1);

    if (new_handle < 0) return;
    rs.module_handle      = new_handle;
    rs.generation        += 1;
    rs.blocks_since_link  = 0u;
#else
    (void)mem_pages;
#endif
}

bool BlockCache::region_dispatch(u32 pc, s32* out) {
    const Region r = classify(pc);
    if (r >= REGION_COUNT) return false;
    if (m_regions[r].module_handle < 0) return false;
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const r        = $0 | 0;
        const pc       = $1 >>> 0;
        const outPtr   = $2;
        const region   = Module.bemental_regions && Module.bemental_regions[r];
        if (!region) return 0;
        const idx = region.pcMap.get(pc);
        if (idx === undefined) return 0;
        try {
            const next = region.fns[idx]() >>> 0;
            HEAP32[outPtr >>> 2] = next | 0;
            return 1;
        } catch (e) {
            if (Module.bemental_region_traps === undefined) Module.bemental_region_traps = 0;
            Module.bemental_region_traps++;
            if (Module.bemental_region_traps <= 16) {
                console.error('[bemental] region', r, 'dispatch trap pc=0x'
                    + pc.toString(16) + ' idx=' + idx
                    + ' msg=' + (e && e.message ? e.message : String(e)));
            }
            return 0;
        }
    }, (int)r, (int)pc, out) != 0;
#else
    (void)pc; (void)out;
    return false;
#endif
}

void BlockCache::region_drop(Region r) {
    if (r >= REGION_COUNT) return;
    RegionState& rs = m_regions[r];
#ifdef __EMSCRIPTEN__
    if (rs.module_handle >= 0) {
        EM_ASM({
            const r = $0 | 0;
            if (Module.bemental_regions && Module.bemental_regions[r]) {
                Module.bemental_regions[r] = null;
                delete Module.bemental_regions[r];
            }
        }, (int)r);
    }
#endif
    rs.fn_bodies_concat.clear();
    rs.pc_keys.clear();
    rs.n_funcs           = 0u;
    rs.blocks_since_link = 0u;
    rs.last_accum_ms     = 0.0;
    rs.module_handle     = -1;
    rs.generation        = 0;
}

std::size_t BlockCache::region_n_funcs(Region r) const {
    if (r >= REGION_COUNT) return 0u;
    return m_regions[r].n_funcs;
}

int BlockCache::region_generation(Region r) const {
    if (r >= REGION_COUNT) return 0;
    return m_regions[r].generation;
}

} // namespace bemental
