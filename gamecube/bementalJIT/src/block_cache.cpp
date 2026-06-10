#include "bementalJIT/block_cache.h"

#include <climits>
#include <cstdint>
#include <cstdlib>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace bemental {

// Forward declaration for the guest emitter's merged-module builder.
// Defined in guests/powerpc/gekko_emit.cpp; declared here (rather than
// including gekko_emit.h) to keep block_cache.cpp guest-agnostic at the
// type level.
namespace powerpc {
    std::vector<u8> build_region_module(const u8* concatenated_bodies,
                                        std::size_t concatenated_size,
                                        u32 n_funcs,
                                        u32 mem_pages);

    // Forward-declared LocalIdxLookupFn must match the typedef in
    // guests/powerpc/gekko_emit.h. Kept here as a bare typedef so we don't
    // pull the whole guest header into block_cache.cpp.
    using LocalIdxLookupFn = bool(*)(const void* user, u32 target_pc, u32* out_local_idx);

    std::vector<u8> emit_block_body(u32 start_pc, const u32* insts, u32 count,
                                    u32 ctx_ptr_const,
                                    u32 mem1_base, u32 mem1_mask,
                                    u32 ram_size,
                                    const u32* instr_pcs,
                                    LocalIdxLookupFn lookup_fn,
                                    const void* lookup_user,
                                    bool emit_hle_check = true,
                                    bool emit_perf_stub = false,
                                    bool emit_hle_check_native = false);

    // Lever #2 — single-function merged-region build. See gekko_emit.h.
    struct BlockInputs {
        u32 start_pc;
        const u32* insts;
        u32 count;
        u32 ctx_ptr_const;
        u32 mem1_base;
        u32 mem1_mask;
        u32 ram_size;
        const u32* instr_pcs;
        bool emit_hle_check;
        bool emit_perf_stub = false;
        // Item 5 — match the BlockInputs in gekko_emit.h so the layout
        // is identical when this translation unit hands a BlockInputs
        // array to build_region_function.
        bool emit_hle_check_native = false;
    };
    std::vector<u8> build_region_function(const BlockInputs* blocks,
                                          u32 n_blocks,
                                          LocalIdxLookupFn lookup_fn,
                                          const void* lookup_user,
                                          u32 mem_pages = 1);

#ifdef BEMENTALJIT_USE_REBUILD
    // Interim _next entry points provided by guests/powerpc-next/ppc_emit.cpp.
    // Currently wrappers around the unsuffixed versions above; will become
    // distinct JIT64-modeled implementations as the rebuild lands. Declared
    // here so block_cache.cpp stays guest-agnostic at the include level (no
    // ppc_emit.h include — same pattern as the live forward decls above).
    // LocalIdxLookupFn and BlockInputs are reused unchanged: both libraries
    // share the bemental::powerpc namespace, so the types are identical
    // entities on either side of the link.
    std::vector<u8> emit_block_body_next(u32 start_pc, const u32* insts, u32 count,
                                         u32 ctx_ptr_const,
                                         u32 mem1_base, u32 mem1_mask,
                                         u32 ram_size,
                                         const u32* instr_pcs,
                                         LocalIdxLookupFn lookup_fn,
                                         const void* lookup_user,
                                         bool emit_hle_check = true,
                                         bool emit_perf_stub = false,
                                         bool emit_hle_check_native = false);

    std::vector<u8> build_region_module_next(const u8* concatenated_bodies,
                                             std::size_t concatenated_size,
                                             u32 n_funcs,
                                             u32 mem_pages);

    std::vector<u8> build_region_function_next(const BlockInputs* blocks,
                                               u32 n_blocks,
                                               LocalIdxLookupFn lookup_fn,
                                               const void* lookup_user,
                                               u32 mem_pages = 1);
#endif
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
            // Bootstrap: if bemental_imports isn't set up yet, do it now.
            // Under PROXY_TO_PTHREAD, JitWasm::Init's EM_ASM runs on
            // the worker-main wasm instance — pthread's Module never sees
            // those bindings. compile_raw runs on the pthread, so we
            // populate pthread's Module.bemental_imports here. Idempotent.
            if (!Module.bemental_imports_need_upgrade
                && (!Module.bemental_imports || !Module.bemental_imports.env
                    || !Module.bemental_imports.env.ppc_write16)) {
                if (typeof Module._dolphin_write16 === 'function') {
                    Module.bemental_imports_need_upgrade = true;
                    console.error('[bemental] bootstrap: pthread-side bemental_imports init');
                }
            }
            if (Module.bemental_imports_need_upgrade) {
                try {
                    Module._dolphin_read8(0);
                    Module._dolphin_read16(0);
                    Module._dolphin_read32(0);
                    Module._dolphin_write8(0, 0);
                    Module._dolphin_write16(0, 0);
                    Module._dolphin_write32(0, 0);
                    Module._dolphin_check_exc(0);
                    Module._dolphin_break_block(0, 0);
                    Module._dolphin_hle_check(0);
                    // Skip dolphin_interp(0,0) — it calls SingleStepInner
                    // which is not safe to invoke at random.
                    // Skip dolphin_hle_fire(0, 0) — it would actually
                    // execute an HLE handler at hook_index=0 which is the
                    // sentinel "unimplemented" PanicAlert.

                    // Lazy-init the imports container on the pthread side.
                    // The dolphin-bridge worker never publishes
                    // Module.bemental_imports up-front, so without this
                    // init the binding block below silently skips and
                    // every Instance() throws "ppc_read8 requires a
                    // callable" (2026-05-30 probe_fix.js with
                    // dolphin_jit_wimports.cpp present: upgrade fired,
                    // bindings never written, 100% compile-fail).
                    if (!Module.bemental_imports)
                        Module.bemental_imports = { env: {} };
                    if (!Module.bemental_imports.env)
                        Module.bemental_imports.env = {};
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
                        // Item 5: direct-bind hle_fire for dolphin's own
                        // path (called when emit_hle_check_native is
                        // unused — module still declares the import).
                        if (Module._dolphin_hle_fire)
                            e.ppc_hle_fire = Module._dolphin_hle_fire;
                        // Researcher B's stack-corrupt diagnostic. Direct-bind
                        // if the export exists; without this, the env object
                        // built on the pthread-side bootstrap drops the import
                        // and wasm instantiation throws silently (caught at
                        // try/catch below) → ALL JIT BLOCKS fall back to interp.
                        // This is the root-cause class for any "I added a new
                        // WIMPORT and nothing fires" failure.
                        if (Module._dolphin_stack_corrupt)
                            e.ppc_stack_corrupt = Module._dolphin_stack_corrupt;
                        // Direct-bind ppc_interp now that dolphin_interp is
                        // exported by dolphin-bridge/dolphin_jit_wimports.cpp
                        // (2026-05-30). The previous "JS wrapper" comment
                        // referred to an older bridge where interp went
                        // through a thunk; the native C function takes
                        // (u32 unused, u32 pc) → void which matches the
                        // emitter's type-2 import signature.
                        if (Module._dolphin_interp)
                            e.ppc_interp = Module._dolphin_interp;
                        // ppc_msr_updated (WIMPORT idx 11) — added to fix the
                        // SAB DBException wedge. emit_mtmsr calls this after
                        // the MSR store so feature_flags/membase get
                        // recomputed (Jit64 parity via EmitUpdateMembase).
                        if (Module._dolphin_msr_updated)
                            e.ppc_msr_updated = Module._dolphin_msr_updated;
                        // ppc_gather_drain (WIMPORT idx 12) — block epilogue
                        // calls this to drain the GPU gather-pipe so CP-IRQ
                        // / PE_TOKEN / PE_FINISH fences fire (Jit64 parity
                        // via Cleanup + GPFifo::UpdateGatherPipe). Without
                        // this binding the emitted import resolves to
                        // undefined and EVERY block compile throws LinkError.
                        if (Module._dolphin_gather_drain)
                            e.ppc_gather_drain = Module._dolphin_gather_drain;
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
    // We must call into JIT'd WASM with a JS-side try/catch because WASM
    // traps (e.g. unguarded i32.div_s/0, table OOB on a stale call_indirect
    // index) propagate as JS RuntimeError. A direct `fn()` from C++ would
    // unwind the entire pthread without recovery — caller's "trap recovery"
    // protocol expecting INT32_MIN never fires because nothing returns it.
    // The JS shim catches the trap, logs it once, and returns the sentinel.
    return EM_ASM_INT({
        // Pre-dispatch trace: every 100K calls log the handle ABOUT to be
        // dispatched. If a wasm block infinite-loops (no trap, no return),
        // the LAST log line identifies the hung handle. Pair with m_map to
        // recover the hung pc.
        if (Module.bemental_dispatch_n === undefined) Module.bemental_dispatch_n = 0;
        Module.bemental_dispatch_n++;
        // [wtraj] per-block trajectory ring (LIVE path — this is the hot
        // dispatcher, 11.5M hits). Records the executing block PC; flushes
        // chunked [wtraj] lines every 100k; bounded to 8M (covers native's
        // 5.99M plus margin). Diffed vs native Jit64 [traj] by
        // gamecube/tools/trace_diff_gc.py.
        if (Module.bemental_wtraj === undefined) { Module.bemental_wtraj = []; Module.bemental_wtraj_total = 0; }
        if (Module.bemental_wtraj_total < 8000000) {
            const __pc = Module.bemental_handle_to_pc ? (Module.bemental_handle_to_pc[$0] >>> 0) : 0;
            Module.bemental_wtraj.push(__pc);
            Module.bemental_wtraj_total++;
            if (Module.bemental_wtraj.length >= 100000) {
                let __l = '[wtraj]';
                for (let __i = 0; __i < Module.bemental_wtraj.length; __i++) {
                    __l += ' ' + (Module.bemental_wtraj[__i] >>> 0).toString(16);
                    if ((__i % 20000) === 19999) { console.error(__l); __l = '[wtraj]'; }
                }
                if (__l.length > 7) console.error(__l);
                Module.bemental_wtraj = [];
            }
        }
        if ((Module.bemental_dispatch_n % 10000) === 0) {
            // Reverse-lookup pc from handle for diagnostic clarity.
            let foundPc = 0;
            if (Module.bemental_pc_to_handle) {
                for (const [pc, h] of Module.bemental_pc_to_handle) {
                    if (h === $0) { foundPc = pc; break; }
                }
            }
            console.error('[bemental] pre-dispatch n=' + Module.bemental_dispatch_n
                + ' handle=' + $0 + ' pc=0x' + foundPc.toString(16));
        }
        // [mp4-wedge-diag] 2026-06-10: count dispatches by PC range. Quoted
        // keys avoid the C preprocessor treating bare 'name:' as a statement
        // label inside the EM_ASM_INT body.
        {
            const __dpc = Module.bemental_handle_to_pc ? (Module.bemental_handle_to_pc[$0] >>> 0) : 0;
            if (!Module.bemental_diag_disp) {
                Module.bemental_diag_disp = {};
                Module.bemental_diag_disp['mn'] = 0;
                Module.bemental_diag_disp['hp'] = 0;
                Module.bemental_diag_disp['ow'] = 0;
                Module.bemental_diag_disp['or'] = 0;
                // [mp4-wedge-diag] 2026-06-10 IRQ-chain extension. Symbols
                // resolved from gc_refs/marioparty4/config/GMPE01_01/symbols.txt:
                //   evec  = OSExceptionVector        0x800B4BB8 size 0x9C
                //                                    (template only — runtime
                //                                    executes COPY at 0x500;
                //                                    expect evec=0)
                //   dispi = __OSDispatchInterrupt    0x800B7714 size 0x344
                //   exti  = ExternalInterruptHandler 0x800B7A58 size 0x50
                //   sel   = SelectThread             0x800BA1B8 size 0x200 (wedge fn)
                //   dsph  = __DSPHandler             0x800C7558 size 0x424
                //                                    (registered for id 7 =
                //                                    __OS_INTERRUPT_DSP_DSP
                //                                    by dsp.c:46/dolsdk dsp.c:69)
                //   aish  = __AISHandler             0x800C5F70 size 0x7C
                //                                    (AI streaming sub-handler)
                //   aidh  = __AIDHandler             0x800C5FEC size 0x90
                //                                    (AI DMA sub-handler)
                //   musy  = MusyX data-plane         0x80113000..0x80114000
                //                                    (reverb/mixing — NOT IRQ;
                //                                    formerly mislabeled dspc)
                // Disambiguation:
                //   dsph=0  → __DSPHandler never reached; dispatcher table
                //             lookup misses (id 7 entry stale/null).
                //   dsph>0 but DSP cause CLR≈0 → handler runs but MMIO ACK
                //             write doesn't drain — Dolphin PI MMIO emul or
                //             our store-side bug.
                Module.bemental_diag_disp['evec']  = 0;
                Module.bemental_diag_disp['dispi'] = 0;
                Module.bemental_diag_disp['exti']  = 0;
                Module.bemental_diag_disp['sel']   = 0;
                Module.bemental_diag_disp['dsph']  = 0;
                Module.bemental_diag_disp['aish']  = 0;
                Module.bemental_diag_disp['aidh']  = 0;
                Module.bemental_diag_disp['musy']  = 0;
                // Inside __OSDispatchInterrupt (asm from
                // gc_refs/marioparty4/build/GMPE01_01/asm/dolphin/os/OSInterrupt.s):
                //   0x800B7758 .L_800B7758 spurious-IRQ branch (calls
                //              OSLoadContext when intsr==0 or (intsr&intmr)==0)
                //   0x800B7760 .L_800B7760 normal cause-decode entry
                // If spur >> norm → __PIRegs[0] read returns stale 0 → MMIO
                // read coherence bug. If norm >> spur but dsph still rare →
                // failure is in cause-mask/handler-table walk.
                Module.bemental_diag_disp['spur']  = 0;
                Module.bemental_diag_disp['norm']  = 0;
                // Per OSInterrupt.s analysis of __OSDispatchInterrupt:
                //   0x800B79A0 .L_800B79A0 mask gate passed — entering
                //              InterruptPrioTable walk
                //   0x800B7A0C .L_800B7A0C handler call site (blrl to
                //              registered handler via mtlr r12)
                // Derived: mask-rejected = norm - prio; handler-NULL =
                // prio - hcall; hcall should ≈ DSP CLR count if __DSPHandler
                // is the only one being called.
                Module.bemental_diag_disp['prio']  = 0;
                Module.bemental_diag_disp['pthit'] = 0;
                Module.bemental_diag_disp['hcall'] = 0;
                // Other registered IRQ handlers (resolved from MP4 syms):
                //   vih = __VIRetraceHandler   0x800C0B6C size 0x228 (60Hz native)
                //   sih = SIInterruptHandler   0x800D9040 size 0x344 (controller poll)
                // If vih >> dsph, VI handler is starving DSP via prio walk —
                // and VI is over-firing in the wasm vs the native 60Hz rate
                // (693K raises in ~104s emulated = 6672/sec vs native 60/sec).
                Module.bemental_diag_disp['vih']   = 0;
                Module.bemental_diag_disp['sih']   = 0;
            }
            if (__dpc >= 0x800057C0 && __dpc < 0x800059EC) Module.bemental_diag_disp['mn']++;
            else if (__dpc >= 0x8000D01C && __dpc < 0x8000D1A0) Module.bemental_diag_disp['hp']++;
            else if (__dpc >= 0x8002EC68 && __dpc < 0x8002EDD8) Module.bemental_diag_disp['ow']++;
            else if (__dpc === 0x800E5BF0) Module.bemental_diag_disp['or']++;
            else if (__dpc >= 0x800B4BB8 && __dpc < 0x800B4C54) Module.bemental_diag_disp['evec']++;
            else if (__dpc >= 0x800B7714 && __dpc < 0x800B7A58) Module.bemental_diag_disp['dispi']++;
            else if (__dpc >= 0x800B7A58 && __dpc < 0x800B7AA8) Module.bemental_diag_disp['exti']++;
            else if (__dpc >= 0x800BA1B8 && __dpc < 0x800BA3B8) Module.bemental_diag_disp['sel']++;
            else if (__dpc >= 0x800C7558 && __dpc < 0x800C797C) Module.bemental_diag_disp['dsph']++;
            else if (__dpc >= 0x800C5F70 && __dpc < 0x800C5FEC) Module.bemental_diag_disp['aish']++;
            else if (__dpc >= 0x800C5FEC && __dpc < 0x800C607C) Module.bemental_diag_disp['aidh']++;
            else if (__dpc >= 0x80113000 && __dpc < 0x80114000) Module.bemental_diag_disp['musy']++;
            else if (__dpc >= 0x800C0B6C && __dpc < 0x800C0D94) Module.bemental_diag_disp['vih']++;
            else if (__dpc >= 0x800D9040 && __dpc < 0x800D9384) Module.bemental_diag_disp['sih']++;
            if (__dpc === 0x800B7758) Module.bemental_diag_disp['spur']++;
            if (__dpc === 0x800B7760) Module.bemental_diag_disp['norm']++;
            if (__dpc === 0x800B79A0) Module.bemental_diag_disp['prio']++;
            if (__dpc === 0x800B79D8) Module.bemental_diag_disp['pthit']++;
            if (__dpc === 0x800B7A10) Module.bemental_diag_disp['hcall']++;
            if ((Module.bemental_dispatch_n % 100000) === 0) {
                console.error('[mp4-wedge-diag] disp-counts'
                    + ' main=' + Module.bemental_diag_disp['mn']
                    + ' huprc=' + Module.bemental_diag_disp['hp']
                    + ' omwatch=' + Module.bemental_diag_disp['ow']
                    + ' osreport=' + Module.bemental_diag_disp['or']
                    + ' evec=' + Module.bemental_diag_disp['evec']
                    + ' dispi=' + Module.bemental_diag_disp['dispi']
                    + ' exti=' + Module.bemental_diag_disp['exti']
                    + ' sel=' + Module.bemental_diag_disp['sel']
                    + ' dsph=' + Module.bemental_diag_disp['dsph']
                    + ' aish=' + Module.bemental_diag_disp['aish']
                    + ' aidh=' + Module.bemental_diag_disp['aidh']
                    + ' musy=' + Module.bemental_diag_disp['musy']
                    + ' spur=' + Module.bemental_diag_disp['spur']
                    + ' norm=' + Module.bemental_diag_disp['norm']
                    + ' prio=' + Module.bemental_diag_disp['prio']
                    + ' pthit=' + Module.bemental_diag_disp['pthit']
                    + ' hcall=' + Module.bemental_diag_disp['hcall']
                    + ' vih=' + Module.bemental_diag_disp['vih']
                    + ' sih=' + Module.bemental_diag_disp['sih']
                    + ' total=' + Module.bemental_dispatch_n);
            }
        }
        try {
            const f = wasmTable.get($0);
            if (!f) return -2147483648;  // freed slot
            return f() | 0;
        } catch (e) {
            if (Module.bemental_block_traps === undefined) Module.bemental_block_traps = 0;
            Module.bemental_block_traps++;
            if (Module.bemental_block_traps <= 16) {
                // Resolve guest PC from handle for fault localization. The
                // handle_to_pc map is populated by register_pc_handle at
                // compile time, so the PC here is the block START PC the
                // wasm "run" was dispatched for — same PC JitWasm.cpp:191
                // evicts on the INT32_MIN sentinel.
                const __pc = Module.bemental_handle_to_pc ? (Module.bemental_handle_to_pc[$0] >>> 0) : 0;
                const __msg = (e && e.message ? e.message : String(e));
                console.error('[bemental] BLOCK TRAP pc=0x' + __pc.toString(16)
                    + ' handle=' + $0
                    + ' #' + Module.bemental_block_traps
                    + ' msg="' + __msg + '"');
            }
            return -2147483648;  // INT32_MIN sentinel
        }
    }, handle);
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
        // [wtraj] trajectory: inverse handle->pc so dispatch_raw can record the
        // executing block PC (native-granularity diff vs Jit64 [traj]).
        if (!Module.bemental_handle_to_pc) Module.bemental_handle_to_pc = {};
        Module.bemental_handle_to_pc[$1 | 0] = $0 >>> 0;

        // [mp4-wedge-diag] 2026-06-10: log block-compile + register events for
        // PCs we are investigating in the omWatchOverlayProc wedge diagnosis.
        // - 0x8002EC68..0x8002EDD8: omWatchOverlayProc body (objmain.c:67-107)
        //   — first dispatch = protothread entered; later PCs = protothread
        //   made forward progress through its body (post-HuPrcSleep resume).
        // - 0x8000D01C..0x8000D1A0: HuPrcCall body (process.c:228) — proves
        //   main loop actually reaches the protothread dispatcher.
        // - 0x800057C0..0x800059EC: main body — proves main loop is iterating.
        // - 0x800E5BF0: OSReport entry — counts how many OSReports compile.
        // - 0x8000DCxx..0x8000DDxx area not currently tagged but we already
        //   see HuSpr* PCs in samples so that range is exercised.
        var __pc = $0 >>> 0;
        var inRange = function(lo, hi) { return __pc >= lo && __pc < hi; };
        // [mp4-wedge-diag] 2026-06-10 extension: track exception-vector
        // dispatch to test the IRQ-unserviced wedge hypothesis. After
        // CheckExternalExceptions (PowerPC.cpp:589), PC is set to 0x500
        // and MSR.IR is cleared, so the dispatcher should compile a block
        // at PC=0x500. The cached alias at 0x80000500 is the IR=1 path.
        // Vector range 0x100..0x1700 per dolsdk OSExceptionLocations
        // (OS.c:196). The MP4-specific handler chain (per
        // gc_refs/marioparty4/config/GMPE01_01/symbols.txt — NOT the
        // generic 0x80003000 area, that earlier guess was wrong for MP4):
        //   0x800B4BB8 OSExceptionVector       (size 0x9C)
        //   0x800B7714 __OSDispatchInterrupt   (size 0x344)
        //   0x800B7A58 ExternalInterruptHandler (size 0x50)
        //   0x800BA1B8 SelectThread            (size 0x200, wedge fn)
        //   0x800C7558 __DSPHandler            (size 0x424, DSP IRQ id 7)
        //   0x800C5F70 __AISHandler            (size 0x7C,  AI streaming)
        //   0x800C5FEC __AIDHandler            (size 0x90,  AI DMA)
        //   0x80113000..0x80114000 MusyX data-plane (mixing/reverb, NOT IRQ).
        if (inRange(0x8002EC68, 0x8002EDD8) ||
            inRange(0x8000D01C, 0x8000D1A0) ||
            inRange(0x800057C0, 0x800059EC) ||
            (__pc === 0x800E5BF0) ||
            inRange(0x100, 0x1800) ||
            inRange(0x80000100, 0x80001800) ||
            inRange(0x800B4BB8, 0x800B4C54) ||
            inRange(0x800B7714, 0x800B7A58) ||
            inRange(0x800B7A58, 0x800B7AA8) ||
            inRange(0x800BA1B8, 0x800BA3B8) ||
            inRange(0x800C7558, 0x800C797C) ||
            inRange(0x800C5F70, 0x800C5FEC) ||
            inRange(0x800C5FEC, 0x800C607C) ||
            inRange(0x80113000, 0x80114000)) {
            if (!Module.bemental_diag_compile_seen) Module.bemental_diag_compile_seen = {};
            if (!Module.bemental_diag_compile_seen[__pc]) {
                Module.bemental_diag_compile_seen[__pc] = 1;
                console.log("[mp4-wedge-diag] block-compiled pc=0x" + __pc.toString(16) +
                            " handle=" + ($1 | 0));
            } else {
                Module.bemental_diag_compile_seen[__pc]++;
            }
        }
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
            // [wtraj] per-block trajectory ring (chained-dispatch path). pc here
            // is the executing block PC. Shares the ring with dispatch_raw.
            // Bounded to 8M (covers native's 5.99M plus margin).
            if (Module.bemental_wtraj === undefined) { Module.bemental_wtraj = []; Module.bemental_wtraj_total = 0; }
            if (Module.bemental_wtraj_total < 8000000) {
                Module.bemental_wtraj.push(pc >>> 0);
                Module.bemental_wtraj_total++;
                if (Module.bemental_wtraj.length >= 100000) {
                    let __l = '[wtraj]';
                    for (let __i = 0; __i < Module.bemental_wtraj.length; __i++) {
                        __l += ' ' + (Module.bemental_wtraj[__i] >>> 0).toString(16);
                        if ((__i % 20000) === 19999) { console.error(__l); __l = '[wtraj]'; }
                    }
                    if (__l.length > 7) console.error(__l);
                    Module.bemental_wtraj = [];
                }
            }
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
                                   const u8* body_bytes, std::size_t body_size,
                                   const BlockEmitInputs* inputs) {
    if (r >= REGION_COUNT) return;
    if (body_bytes == nullptr || body_size == 0) return;
    RegionState& rs = m_regions[r];

    // Dedup: if this pc is already accumulated, skip. The first emission
    // is canonical for the region's current generation. region_relink
    // re-emits each block with the up-to-date pc_to_idx map so first-emit
    // unresolved branches get rewritten on relink without us having to
    // re-accumulate.
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
    // Save emit inputs for re-emit at relink. Only if the caller provided
    // them — legacy callers without re-emit support pass null.
    if (inputs != nullptr) {
        rs.block_records.push_back(*inputs);
    } else {
        rs.block_records.emplace_back();  // placeholder; relink falls back to concat
    }
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

    // Trigger 1: blocks accumulated. Threshold scales with how many blocks
    // are already in the region — small regions relink quickly so early
    // boot exploration moves PCs into the live module fast; large stable
    // regions relink less often to amortize V8 compile cost.
    //
    //   < 256 blocks total:    relink every 32 new   (boot warmup phase)
    //   < 1024 blocks total:   relink every 128 new  (active exploration)
    //   >= 1024 blocks total:  relink every 256 new  (steady state)
    //
    // Diagnose probe (2026-05-06) showed boot exploration adds new PCs
    // faster than the prior fixed 256 threshold relinks them — region
    // module perpetually 24% behind, dispatch falls to slow per-block
    // (cross-instance call_indirect deopt) path. Tiered threshold lets
    // boot stabilize the region quickly, then settles for steady state.
    u32 threshold;
    if (rs.n_funcs < 256u)        threshold = 32u;
    else if (rs.n_funcs < 1024u)  threshold = 128u;
    else                          threshold = 256u;
    const bool block_trigger = (rs.blocks_since_link >= threshold);

    // [determinism] JITWASM_DETERMINISTIC=1 makes relink timing reproducible:
    // relink fires purely on block/dispatch COUNTS, never on wall-clock. This
    // removes the run-to-run variance in WHEN relink fires (and thus which
    // region module layout is live), which is the structural source of the
    // shifting wedge PC. Acceptance: two runs of one build → identical traces.
    static const bool s_deterministic = (std::getenv("JITWASM_DETERMINISTIC") != nullptr);

    // Trigger 2: steady-state catch — the region has at least one block
    // pending and hasn't accumulated a new one in >2 s. Without this, a
    // region that JITs a handful of blocks then quiesces would never get
    // its merged module built. TIME-based → suppressed in deterministic mode
    // (block_trigger alone governs; a deterministic dispatch-budget probe
    // doesn't strand blocks the way an open-ended run would).
    bool quiesce_trigger = false;
    if (!s_deterministic && rs.blocks_since_link >= 1u) {
        const double age = now_ms() - rs.last_accum_ms;
        if (age > 2000.0) quiesce_trigger = true;
    }

    if (!block_trigger && !quiesce_trigger) return false;

    // ---- Module-discard timing (V8 tier-up grace) ----
    // Once a region is past initial warmup (≥256 blocks → module is large
    // enough that TurboFan tier-up actually has inlining work to do), defer
    // relink while the just-installed module is still in V8's background
    // tier-up window. Without this, every threshold-trigger discards the
    // freshly-instantiated module before V8 ever upgrades it from Liftoff
    // → TurboFan, capping sustained throughput at baseline.
    //
    // We can't read V8 internals to know "tier-up done", so use two
    // proxies that bound the bg window from below:
    //   - elapsed-since-relink (>= grace ms)
    //   - dispatches-into-this-module (>= min dispatches; ensures V8
    //     actually collected feedback for the new instance — type
    //     feedback is per-instance and starts empty).
    //
    // Defaults derived from V8 research + lever_3_tierup_blocked_2026_05_05
    // (~300µs/fn bg compile; merged modules with ~480 fns → ~145 ms).
    // Defaults are conservative so steady-state behavior favors keeping a
    // tier-up'd module alive. Overridable via env for measurement.
    //
    // Disabled while still in warmup (n_funcs < 256) — boot needs fast
    // catch-up to surface PCs into the module before they pile up on the
    // slow per-block dispatch path.
    if (rs.n_funcs >= 256u && rs.last_relink_ms > 0.0) {
        static const double s_grace_ms =
            (std::getenv("BJIT_TIERUP_GRACE_MS") != nullptr)
                ? std::atof(std::getenv("BJIT_TIERUP_GRACE_MS"))
                : 250.0;
        static const u32 s_min_dispatches =
            (std::getenv("BJIT_TIERUP_MIN_DISPATCHES") != nullptr)
                ? static_cast<u32>(std::atoi(std::getenv("BJIT_TIERUP_MIN_DISPATCHES")))
                : 5000u;
        const double since_relink = now_ms() - rs.last_relink_ms;
        // Quiesce trigger ignores the grace gate: if the region has been
        // idle >2 s, V8 has definitely had its bg window — let the relink
        // proceed so pending blocks aren't stranded.
        // [determinism] in deterministic mode the wall-clock `since_relink`
        // term is dropped — the grace gate becomes purely dispatch-count
        // based, so relink timing no longer depends on real time.
        const bool grace_blocks = s_deterministic
            ? (rs.dispatches_since_relink < s_min_dispatches)
            : (since_relink < s_grace_ms && rs.dispatches_since_relink < s_min_dispatches);
        if (!quiesce_trigger && grace_blocks) {
            return false;
        }
    }

    return true;
}

// LocalIdxLookupFn closure that reads from a region's pc_to_idx map.
// Used during region_relink's re-emit pass so emit_block_body can resolve
// any pc that has been accumulated to its local fn idx, and emit
// return_call_indirect to the merged module's internal table.
namespace {
    struct RegionLookupCtx {
        const RegionState* rs;
    };
    bool region_lookup_for_emit(const void* user, u32 target_pc, u32* out_idx) {
        const auto* ctx = static_cast<const RegionLookupCtx*>(user);
        if (!ctx || !ctx->rs) return false;
        auto it = ctx->rs->pc_to_idx.find(target_pc);
        if (it == ctx->rs->pc_to_idx.end()) return false;
        if (out_idx) *out_idx = it->second;
        return true;
    }
}

void BlockCache::region_relink(Region r, u32 mem_pages) {
    if (r >= REGION_COUNT) return;
    RegionState& rs = m_regions[r];
    if (rs.n_funcs == 0u) return;

    // ---- Re-emit pass (lever #2 — block-link patching) ----
    // The bodies in fn_bodies_concat were emitted at first-accumulate time
    // when sibling blocks weren't yet known, so any cross-block branch
    // baked the slow set-pc + return path. Re-emit each body now with the
    // up-to-date pc_to_idx map: branches whose targets are in the map
    // become return_call_indirect (intra-instance, V8-inline-able).
    //
    // Phase B4: default-ON (was default-OFF gated by JITWASM_REEMIT_AT_RELINK).
    // The 2026-05-06 measurement that motivated the gate observed 1500+
    // blocks per region; in current SAB boot we plateau at ~480/region per
    // probe (gen=9), well under the O(N^2) collapse threshold. Disable
    // explicitly via JITWASM_REEMIT_AT_RELINK_OFF=1 if a regression turns up
    // (e.g. game with much wider regions).
    //
    // Re-emit lets cross-block branches whose targets are NEWLY accumulated
    // since first emit become return_call_indirect (intra-instance, V8-
    // inline-able) instead of staying baked as set_pc + return.
    //
    // TODO: per-block "needs re-emit" tracking — only re-emit blocks with
    // unresolved branches whose targets are now in pc_to_idx. Reduces O(N^2)
    // to O(touched edges).
    static const bool s_reemit_enabled =
        (std::getenv("JITWASM_REEMIT_AT_RELINK_OFF") == nullptr);
    bool have_records = s_reemit_enabled && (rs.block_records.size() == rs.n_funcs);
    for (const auto& rec : rs.block_records) {
        if (rec.insts.empty()) { have_records = false; break; }
    }
    if (have_records) {
        rs.fn_bodies_concat.clear();
        RegionLookupCtx ctx{ &rs };
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
#ifdef BEMENTALJIT_USE_REBUILD
            std::vector<u8> body = powerpc::emit_block_body_next(
#else
            std::vector<u8> body = powerpc::emit_block_body(
#endif
                rec.start_pc,
                rec.insts.data(),
                static_cast<u32>(rec.insts.size()),
                rec.ctx_ptr_const,
                rec.mem1_base, rec.mem1_mask, rec.ram_size,
                rec.instr_pcs.data(),
                &region_lookup_for_emit, &ctx,
                /*emit_hle_check=*/rec.emit_hle_check,
                /*emit_perf_stub=*/rec.emit_perf_stub,
                /*emit_hle_check_native=*/rec.emit_hle_check_native);
            rs.fn_bodies_concat.insert(rs.fn_bodies_concat.end(),
                                       body.begin(), body.end());
        }
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.error('[worker] [bemental] region ' + $0
                + ' re-emitted ' + $1 + ' bodies for relink (lever #2)');
        }, (int)r, (int)rs.n_funcs);
#endif
    }

    // Lever #2 alt path — single-function merged region. Toggled by
    // BJIT_LEVER2_MERGED=1 (process env) OR Module.lever2_merged=1 (JS-side
    // flag, useful for puppeteer probe before pthread spawns). Requires
    // per-block records (same condition as re-emit at relink). Output is a
    // module exporting ONE function `region` and ONE mutable global
    // `entry_sel`; dispatcher writes entry_sel = local_idx then calls
    // region() to execute.
    // Lever #2 — single-function merged region with depth-tracked
    // br-to-loop. Default ON: SAB+PSO boot parity confirmed and ~43%
    // reduction in region-dispatch host round-trips on SAB at disp=100k.
    // Override via BJIT_LEVER2_MERGED_OFF=1 to fall back to N-fn shape.
#ifdef __EMSCRIPTEN__
    static const bool s_merged_enabled = (std::getenv("BJIT_LEVER2_MERGED_OFF") == nullptr);
#else
    static const bool s_merged_enabled = (std::getenv("BJIT_LEVER2_MERGED_OFF") == nullptr);
#endif
    bool use_merged_fn = s_merged_enabled
                      && (rs.block_records.size() == rs.n_funcs);
    if (use_merged_fn) {
        for (const auto& rec : rs.block_records) {
            if (rec.insts.empty()) { use_merged_fn = false; break; }
        }
    }

    std::vector<u8> bytes;
    if (use_merged_fn) {
        std::vector<powerpc::BlockInputs> bins(rs.n_funcs);
        for (u32 i = 0; i < rs.n_funcs; ++i) {
            const BlockEmitInputs& rec = rs.block_records[i];
            bins[i].start_pc       = rec.start_pc;
            bins[i].insts          = rec.insts.data();
            bins[i].count          = (u32)rec.insts.size();
            bins[i].ctx_ptr_const  = rec.ctx_ptr_const;
            bins[i].mem1_base      = rec.mem1_base;
            bins[i].mem1_mask      = rec.mem1_mask;
            bins[i].ram_size       = rec.ram_size;
            bins[i].instr_pcs      = rec.instr_pcs.data();
            bins[i].emit_hle_check = rec.emit_hle_check;
            bins[i].emit_perf_stub = rec.emit_perf_stub;
            bins[i].emit_hle_check_native = rec.emit_hle_check_native;
        }
        RegionLookupCtx ctx{ &rs };
#ifdef __EMSCRIPTEN__
        // [slotmap] builder-agnostic dump of the authoritative slot→start_pc
        // map (br_table arm i lands on bins[i]) plus what the emit-time lookup
        // maps the wedge fn's key successors to. If lookup says 0x800e3958=slot
        // K but bins[K].start_pc != 0x800e3958, that mismatch is the self-loop.
        {
            bool has_wedge = false;
            for (u32 i = 0; i < rs.n_funcs; ++i)
                if (bins[i].start_pc == 0x800e362cu) { has_wedge = true; break; }
            static int s_slotmap_logged = 0;
            if (has_wedge && s_slotmap_logged < 2) {
                s_slotmap_logged++;
                EM_ASM({ console.error('[slotmap] n_funcs=' + ($0|0)); }, rs.n_funcs);
                for (u32 i = 0; i < rs.n_funcs; ++i)
                    EM_ASM({ console.error('[slotmap] slot=' + ($0|0)
                        + ' pc=0x' + ($1>>>0).toString(16)); }, i, bins[i].start_pc);
                u32 i3958 = 0xffffffffu, i362c = 0xffffffffu, i3654 = 0xffffffffu;
                const bool r3958 = region_lookup_for_emit(&ctx, 0x800e3958u, &i3958);
                const bool r362c = region_lookup_for_emit(&ctx, 0x800e362cu, &i362c);
                const bool r3654 = region_lookup_for_emit(&ctx, 0x800e3654u, &i3654);
                EM_ASM({ console.error('[slotmap] lookup 3958 res=' + ($0|0) + ' idx=' + ($1|0)
                    + ' | 362c res=' + ($2|0) + ' idx=' + ($3|0)
                    + ' | 3654 res=' + ($4|0) + ' idx=' + ($5|0)); },
                    r3958, (int)i3958, r362c, (int)i362c, r3654, (int)i3654);
            }
        }
#endif
#ifdef BEMENTALJIT_USE_REBUILD
        bytes = powerpc::build_region_function_next(
            bins.data(), rs.n_funcs,
            &region_lookup_for_emit, &ctx,
            mem_pages);
#else
        bytes = powerpc::build_region_function(
            bins.data(), rs.n_funcs,
            &region_lookup_for_emit, &ctx,
            mem_pages);
#endif
    } else {
#ifdef BEMENTALJIT_USE_REBUILD
        bytes = powerpc::build_region_module_next(
            rs.fn_bodies_concat.data(),
            rs.fn_bodies_concat.size(),
            rs.n_funcs,
            mem_pages);
#else
        bytes = powerpc::build_region_module(
            rs.fn_bodies_concat.data(),
            rs.fn_bodies_concat.size(),
            rs.n_funcs,
            mem_pages);
#endif
    }
    if (bytes.empty()) {
#ifdef __EMSCRIPTEN__
        EM_ASM({
            console.error('[bemental] region', $0,
                ' relink: build_region returned empty bytes');
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
        const mergedFn   = $6 | 0;     // 1 = single-fn merged region, 0 = N fn_<i> path
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
            // DIAG: print env keys to see if ppc_stack_corrupt is wired
            {
                const keys = Object.keys(env).join(',');
                const has_sc = ('ppc_stack_corrupt' in env) ? 1 : 0;
                const has_dsc = (typeof Module._dolphin_stack_corrupt === 'function') ? 1 : 0;
                console.error('[region-env-diag] keys=[' + keys + '] has_sc=' + has_sc + ' has_dsc=' + has_dsc);
            }
            const inst = new WebAssembly.Instance(mod, { env: env });

            // Build pc -> local_fn_idx Map from the parallel pc_keys array.
            const pcMap = new Map();
            for (let i = 0; i < nFuncs; i++) {
                const pc = HEAPU32[(pcKeysPtr >>> 2) + i] >>> 0;
                pcMap.set(pc, i);
            }

            // Lever #2 merged shape exports `region` + `entry_sel`. Otherwise
            // pre-resolve each fn_<i> export into a JS array indexed by
            // local fn idx — avoids a string lookup per dispatch.
            const region = {};
            region.merged = !!mergedFn;
            if (region.merged) {
                region.regionFn  = inst.exports['region'];
                region.entrySel  = inst.exports['entry_sel'];
                if (!region.regionFn || !region.entrySel) {
                    console.error('[bemental] region ' + r
                        + ' merged shape missing exports — region:'
                        + (typeof region.regionFn) + ' entry_sel:'
                        + (typeof region.entrySel));
                    return -1;
                }
            } else {
                const fns = new Array(nFuncs);
                for (let i = 0; i < nFuncs; i++) {
                    fns[i] = inst.exports['fn_' + i];
                }
                region.fns = fns;
            }

            if (!Module.bemental_regions) Module.bemental_regions = {};
            const prev = Module.bemental_regions[r];
            region.instance   = inst;
            region.pcMap      = pcMap;
            region.nFuncs     = nFuncs;
            region.generation = generation;
            Module.bemental_regions[r] = region;
            if (prev) prev.instance = null;
            console.log('[worker] [bemental] region ' + r + ' relinked gen=' + generation
                + ' n_funcs=' + nFuncs + ' bytes=' + bytesLen
                + (region.merged ? ' shape=merged' : ' shape=Nfn'));
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
    rs.generation + 1,
    use_merged_fn ? 1 : 0);

    if (new_handle < 0) return;
    rs.module_handle             = new_handle;
    rs.generation               += 1;
    rs.blocks_since_link         = 0u;
    rs.last_relink_ms            = now_ms();
    rs.dispatches_since_relink   = 0u;
#else
    (void)mem_pages;
#endif
}

bool BlockCache::region_dispatch(u32 pc, s32* out) {
    const Region r = classify(pc);
    if (r >= REGION_COUNT) return false;
    if (m_regions[r].module_handle < 0) return false;
    // Tier-up grace counter — V8 type feedback is per-instance and starts
    // empty. region_should_relink consults this to know whether the
    // current module has had enough traffic for TurboFan to have material
    // worth preserving. Bump on every call into region_dispatch regardless
    // of hit/miss; on miss the caller falls through to compile path, the
    // feedback investment in the current module is unchanged.
    m_regions[r].dispatches_since_relink += 1u;
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        const r        = $0 | 0;
        const pc       = $1 >>> 0;
        const outPtr   = $2;
        const region   = Module.bemental_regions && Module.bemental_regions[r];
        if (!region) return 0;
        const idx = region.pcMap.get(pc);
        if (idx === undefined) return 0;
        // Pre-dispatch trace: every 100K calls log the pc ABOUT to be
        // dispatched. If a wasm region function infinite-loops, the LAST
        // log line identifies the hung pc.
        if (Module.bemental_region_dispatch_n === undefined) Module.bemental_region_dispatch_n = 0;
        Module.bemental_region_dispatch_n++;
        if ((Module.bemental_region_dispatch_n % 10000) === 0) {
            console.error('[bemental] pre-region-dispatch n=' + Module.bemental_region_dispatch_n
                + ' r=' + r + ' pc=0x' + pc.toString(16) + ' idx=' + idx);
        }
        try {
            let next;
            if (region.merged) {
                region.entrySel.value = idx | 0;
                next = region.regionFn() >>> 0;
            } else {
                next = region.fns[idx]() >>> 0;
            }
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
    rs.n_funcs                 = 0u;
    rs.blocks_since_link       = 0u;
    rs.last_accum_ms           = 0.0;
    rs.module_handle           = -1;
    rs.generation              = 0;
    rs.last_relink_ms          = 0.0;
    rs.dispatches_since_relink = 0u;
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
