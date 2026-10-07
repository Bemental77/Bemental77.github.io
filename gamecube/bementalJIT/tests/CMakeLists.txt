# bementalJIT dispatch test harness.
# Builds an emcc executable: test_dispatch.html + .js + .wasm.
# Run by serving the build directory over HTTP and opening test_dispatch.html.

if(NOT EMSCRIPTEN)
    message(STATUS "bementalJIT tests skipped (requires Emscripten)")
    return()
endif()

add_executable(test_dispatch test_dispatch.cpp)
target_link_libraries(test_dispatch PRIVATE bementalJIT)
set_target_properties(test_dispatch PROPERTIES SUFFIX ".html")
target_link_options(test_dispatch PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    # block_cache.cpp::compile_raw pre-grows wasmTable by 8192 slots, so the
    # dispatch path requires table growth (same as test_gekko et al.).
    "SHELL:-s ALLOW_TABLE_GROWTH=1"
    "SHELL:-s EXIT_RUNTIME=0"
)

# Gekko emitter smoke test — only built when the PowerPC guest is enabled.
if(BEMENTAL_GUEST_POWERPC)
    add_executable(test_gekko test_gekko.cpp)
    target_link_libraries(test_gekko PRIVATE bementalJIT bementalJITPowerPC)
    target_include_directories(test_gekko PRIVATE
        ${CMAKE_SOURCE_DIR}
    )
    set_target_properties(test_gekko PROPERTIES SUFFIX ".html")
    target_link_options(test_gekko PRIVATE
        "SHELL:-s EXIT_RUNTIME=1"
        # Block-emitter's env.memory import declares shared+max to match
        # the dolphin_libretro -pthread target. The test runtime must
        # also export a shared memory; otherwise WebAssembly.Instance
        # fails with "mismatch in shared state of memory".
        "SHELL:-pthread"
        "SHELL:-s PTHREAD_POOL_SIZE=0"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=67108864"
        # block_cache.cpp::compile_raw pre-grows wasmTable by 8192 slots.
        "SHELL:-s ALLOW_TABLE_GROWTH=1"
        # Stub all PowerPC host imports — most corpus tests don't call
        # them, but the WASM module declares them all.
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
    )
    target_compile_options(test_gekko PRIVATE "-pthread")

    # T1 microkernel performance harness — measures bementalJIT throughput
    # against the >=1.0x native PowerPC acceptance bar. Five kernels (T1a..e)
    # cover integer, memory, FP, recursive-branch, and hash workloads.
    add_executable(test_perf_t1 test_perf_t1.cpp)
    target_link_libraries(test_perf_t1 PRIVATE bementalJIT bementalJITPowerPC)
    target_include_directories(test_perf_t1 PRIVATE
        ${CMAKE_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    set_target_properties(test_perf_t1 PROPERTIES SUFFIX ".html")
    target_link_options(test_perf_t1 PRIVATE
        "SHELL:-s EXIT_RUNTIME=1"
        "SHELL:-pthread"
        "SHELL:-s PTHREAD_POOL_SIZE=0"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=67108864"
        "SHELL:-s ALLOW_TABLE_GROWTH=1"
        # [2026-08-12] the run_perf_t1 harness reads Module.HEAPU8; without this the
        # page aborts on load ("HEAPU8 not exported") — same fix as test_gekko_next/test_diff.
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
    )
    target_compile_options(test_perf_t1 PRIVATE "-pthread")

    # Differential test: replays DolphinPPCTests' pre-recorded oracle
    # (1823 X-form integer cases) through bementalJIT and diffs results.
    add_executable(test_diff test_diff.cpp)
    target_link_libraries(test_diff PRIVATE bementalJIT bementalJITPowerPC)
    target_include_directories(test_diff PRIVATE
        ${CMAKE_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    set_target_properties(test_diff PROPERTIES SUFFIX ".html")
    target_link_options(test_diff PRIVATE
        "SHELL:-s EXIT_RUNTIME=1"
        "SHELL:-pthread"
        "SHELL:-s PTHREAD_POOL_SIZE=0"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=67108864"
        "SHELL:-s ALLOW_TABLE_GROWTH=1"
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        # [2026-07-20] match test_diff_next — the harness reads Module.HEAPU8; without this the
        # page aborts on load ("HEAPU8 not exported").
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
    )
    target_compile_options(test_diff PRIVATE "-pthread")

    # Differential test against the LIVE powerpc-next emitter
    # (build_block_next — the production path per JitWasm.cpp). Same
    # oracle corpus as test_diff; fallback-routed ops are counted
    # separately instead of failing. Links BOTH guest libs: ppc_emit.cpp's
    # region passthroughs reference live guests/powerpc symbols.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_diff_next test_diff_next.cpp)
        target_link_libraries(test_diff_next PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_diff_next PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_diff_next PROPERTIES SUFFIX ".html")
        target_link_options(test_diff_next PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            # 64MB (not 32): BlockCache::compile reads the cache-cap SAB cells
            # (block_cache.cpp bem_cc_get(BEM_CC_CAP) = 0x026B3xxx, ~40.5MB)
            # unconditionally since 2026-08-29, so a 32MB heap traps on the
            # FIRST compile ("memory access out of bounds" in bem_cc_get) and
            # the suite never reaches a single case. Same reason test_gekko_next
            # is 64MB.
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
            # newer emsdk no longer exports HEAP views by default; the harness reads them.
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
        )
        target_compile_options(test_diff_next PRIVATE "-pthread")
    endif()

    # Branch/load-store/ALU corpus against the LIVE powerpc-next emitter
    # (port of test_gekko to build_block_next).
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_gekko_next test_gekko_next.cpp)
        target_link_libraries(test_gekko_next PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_gekko_next PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_gekko_next PROPERTIES SUFFIX ".html")
        target_link_options(test_gekko_next PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            # newer emsdk no longer exports HEAP views by default; the harness reads them
            # (was missing here vs test_diff_next -> "HEAPU8 not exported" abort on load).
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            # 64MB (not 32): powerpc-next's bl/blr emit LR-shadow-ring diag
            # writes at absolute SAB addresses 0x026B05xx (jit_branch.cpp:63-68,
            # ~40.5MB) — must be in-bounds or every LK-branch block traps.
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_gekko_next PRIVATE "-pthread")
    endif()

    # [exact-fma 2026-10-04] Randomized + constructed-tie differential of the
    # single-precision fma family (fmadds/fmsubs/fnmadds/fnmsubs, ps_madd,
    # ps_nmsub, ps_madds0/1) against a std::fma transcription of
    # NI_madd_msub<single>. Runs under plain node: `node test_fma_exact.js`.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_fma_exact test_fma_exact.cpp)
        target_link_libraries(test_fma_exact PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_fma_exact PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_fma_exact PROPERTIES SUFFIX ".html")
        target_link_options(test_fma_exact PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_fma_exact PRIVATE "-pthread")
    endif()

    # [mem-slowarm 2026-10-04] Host-observed ctx.PC / gpr[] at the slow-arm
    # memory imports under BEM_LEVER_MEM_SLOWARM. `node test_mem_slowarm.js`.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_mem_slowarm test_mem_slowarm.cpp)
        target_link_libraries(test_mem_slowarm PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_mem_slowarm PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_mem_slowarm PROPERTIES SUFFIX ".html")
        target_link_options(test_mem_slowarm PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_mem_slowarm PRIVATE "-pthread")
    endif()

    # [superblock 2026-10-07] BEM_LEVER_FOLLOW superblocks vs the plain block
    # chain at every slice end. `node test_superblock.js`.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_superblock test_superblock.cpp)
        target_link_libraries(test_superblock PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_superblock PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_superblock PROPERTIES SUFFIX ".html")
        target_link_options(test_superblock PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_superblock PRIVATE "-pthread")
    endif()

    # [pc-sync 2026-10-04] Inline interp fallbacks store ctx.PC so the
    # dolphin_interp pc guard runs them. `node test_interp_pcsync.js`.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_interp_pcsync test_interp_pcsync.cpp)
        target_link_libraries(test_interp_pcsync PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_interp_pcsync PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_interp_pcsync PROPERTIES SUFFIX ".html")
        target_link_options(test_interp_pcsync PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_interp_pcsync PRIVATE "-pthread")
    endif()

    # [fp-single-arms 2026-10-04] Single-resident FP arms (scalar single arith,
    # ps_muls, SIMD promote) vs the Double arms. `node test_fp_single_arms.js`.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_fp_single_arms test_fp_single_arms.cpp)
        target_link_libraries(test_fp_single_arms PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_fp_single_arms PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_fp_single_arms PROPERTIES SUFFIX ".html")
        target_link_options(test_fp_single_arms PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_fp_single_arms PRIVATE "-pthread")
    endif()

    # [simd-bswap 2026-08-29] Bit-exactness gate for the SIMD byte-swap on the
    # adjacent-word-pair memory ops (psq_l/psq_st FLOAT pair, lfd, stfd). Uses a
    # real host buffer as mem1_base so the FASTMEM arms — the only arms the
    # change touches — actually execute.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_simd_bswap test_simd_bswap.cpp)
        target_link_libraries(test_simd_bswap PRIVATE
            bementalJIT bementalJITPowerPCNext bementalJITPowerPC)
        target_include_directories(test_simd_bswap PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_simd_bswap PROPERTIES SUFFIX ".html")
        target_link_options(test_simd_bswap PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-s EXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP8','HEAP16','HEAPU16','HEAP32','HEAPU32','HEAPF32','HEAPF64']"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=67108864"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_simd_bswap PRIVATE "-pthread")
    endif()

    # Repro for SAB PI-mask write miscompilation (sab_pi_mask_clobbered).
    # Replays the exact 46-instruction byte sequence at 0x800e7bbc..0x800e7c70
    # and asserts r5 == 0x77FF at the stw to PI_INTERRUPT_MASK.
    add_executable(test_pi_mask_path test_pi_mask_path.cpp)
    target_link_libraries(test_pi_mask_path PRIVATE bementalJIT bementalJITPowerPC)
    target_include_directories(test_pi_mask_path PRIVATE
        ${CMAKE_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    set_target_properties(test_pi_mask_path PROPERTIES SUFFIX ".html")
    target_link_options(test_pi_mask_path PRIVATE
        "SHELL:-s EXIT_RUNTIME=1"
        "SHELL:-pthread"
        "SHELL:-s PTHREAD_POOL_SIZE=0"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=67108864"
        "SHELL:-s ALLOW_TABLE_GROWTH=1"
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
    )
    target_compile_options(test_pi_mask_path PRIVATE "-pthread")

    # Phase 1 PPCAnalyzer acceptance — three canned blocks (basic reg-flow,
    # idle-loop detection, SDA-relative loadstore) exercise the new IR
    # substrate in guests/powerpc-next/.
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        add_executable(test_analyst test_analyst.cpp)
        target_link_libraries(test_analyst PRIVATE bementalJIT bementalJITPowerPCNext)
        target_include_directories(test_analyst PRIVATE
            ${CMAKE_SOURCE_DIR}
            ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_target_properties(test_analyst PROPERTIES SUFFIX ".html")
        target_link_options(test_analyst PRIVATE
            "SHELL:-s EXIT_RUNTIME=1"
            "SHELL:-pthread"
            "SHELL:-s PTHREAD_POOL_SIZE=0"
            "SHELL:-s INITIAL_MEMORY=33554432"
            "SHELL:-s ALLOW_MEMORY_GROWTH=1"
            "SHELL:-s MAXIMUM_MEMORY=67108864"
            "SHELL:-s ALLOW_TABLE_GROWTH=1"
            "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
        )
        target_compile_options(test_analyst PRIVATE "-pthread")
    endif()

    # Validates that bementalJIT correctly emits the SAB strcat byte
    # sequence at 0x8010df88..0x8010dfb0 (lbzu/cmpli/bne loops). If this
    # fails, the HLEStrcat patch is masking a JIT-level bug — without HLE
    # replacement the game would corrupt memory on every strcat call.
    add_executable(test_str_hle_pattern test_str_hle_pattern.cpp)
    target_link_libraries(test_str_hle_pattern PRIVATE bementalJIT bementalJITPowerPC)
    target_include_directories(test_str_hle_pattern PRIVATE
        ${CMAKE_SOURCE_DIR}
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    set_target_properties(test_str_hle_pattern PROPERTIES SUFFIX ".html")
    target_link_options(test_str_hle_pattern PRIVATE
        "SHELL:-s EXIT_RUNTIME=1"
        "SHELL:-pthread"
        "SHELL:-s PTHREAD_POOL_SIZE=0"
        "SHELL:-s INITIAL_MEMORY=33554432"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=67108864"
        "SHELL:-s ALLOW_TABLE_GROWTH=1"
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
    )
    target_compile_options(test_str_hle_pattern PRIVATE "-pthread")
endif()
