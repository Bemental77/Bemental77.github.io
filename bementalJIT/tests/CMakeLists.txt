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
    )
    target_compile_options(test_diff PRIVATE "-pthread")
endif()
