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
            "SHELL:-s INITIAL_MEMORY=33554432"
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
