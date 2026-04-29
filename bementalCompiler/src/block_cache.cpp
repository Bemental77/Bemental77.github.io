#include "bementalCompiler/block_cache.h"

#include <climits>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace bemental {

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

            if (!Module.bemental_cache) Module.bemental_cache = [];
            // Throttle visibility — log every 256th compile so we can see
            // cache pressure without flooding the console.
            if ((Module._bemental_compile_n |0) % 256 === 0) {
                let live = 0;
                for (let i = 0; i < Module.bemental_cache.length; i++)
                    if (Module.bemental_cache[i] !== null) live++;
                console.log('[bemental] compile #' + (Module._bemental_compile_n|0)
                            + ' live=' + live + ' slots=' + Module.bemental_cache.length);
            }
            Module._bemental_compile_n = ((Module._bemental_compile_n|0) + 1) | 0;
            for (let i = 0; i < Module.bemental_cache.length; i++) {
                if (Module.bemental_cache[i] === null) {
                    Module.bemental_cache[i] = inst;
                    return i;
                }
            }
            Module.bemental_cache.push(inst);
            return Module.bemental_cache.length - 1;
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

s32 dispatch_raw(int handle) {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const inst = Module.bemental_cache && Module.bemental_cache[$0];
        if (inst && inst.exports && typeof inst.exports.run === 'function') {
            try {
                return inst.exports.run() | 0;
            } catch (e) {
                // WASM RuntimeError (divide by zero, integer overflow, OOB,
                // unreachable, etc.) — log first 16 occurrences with the
                // handle and message so we can correlate to a block start_pc,
                // then return the sentinel -2147483648 (INT32_MIN) so the
                // dispatcher recovers by falling back to the interpreter.
                if (Module.bemental_traps === undefined) Module.bemental_traps = 0;
                Module.bemental_traps++;
                if (Module.bemental_traps <= 16) {
                    console.error('[bemental] WASM trap #' + Module.bemental_traps
                        + ' handle=' + $0
                        + ' msg=' + (e && e.message ? e.message : String(e)));
                }
                return -2147483648;
            }
        }
        return 0;
    }, handle);
#else
    (void)handle;
    return 0;
#endif
}

void release_raw(int handle) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        if (Module.bemental_cache && Module.bemental_cache[$0]) {
            Module.bemental_cache[$0] = null;
        }
        // Also remove any pc -> handle mapping pointing at this handle.
        // Eviction is rare (cache cap or trap recovery) so the linear scan
        // is fine.
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

} // namespace bemental
