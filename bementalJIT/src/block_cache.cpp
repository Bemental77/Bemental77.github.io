#include "bementalJIT/block_cache.h"

#include <climits>
#include <cstdint>

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

} // namespace bemental
