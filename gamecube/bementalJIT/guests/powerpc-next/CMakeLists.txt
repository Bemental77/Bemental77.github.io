# bementalJIT/guests/powerpc-next — Jit64-modeled PowerPC rebuild (parallel
# to guests/powerpc/). Phase 1 ships the IR substrate (CodeOp, CodeBlock,
# PPCAnalyzer skeleton, opcode tables) without touching the live emit path.
#
# Build target name: bementalJITPowerPCNext. Existing bementalJITPowerPC
# stays untouched; the live build links the old target. New target is
# additive; future phases cut over per scope-doc §7.

add_library(bementalJITPowerPCNext STATIC
    ppc_analyst.cpp
    ppc_tables.cpp
    reg_cache.cpp
    jit_load_store.cpp
    jit_integer.cpp
    jit_branch.cpp
    jit_system_registers.cpp
    cr_encode.cpp
    jit_compare.cpp
    hle_prologue.cpp
    ppc_emit.cpp
)

target_include_directories(bementalJITPowerPCNext PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(bementalJITPowerPCNext PUBLIC bementalJIT)
target_compile_features(bementalJITPowerPCNext PUBLIC cxx_std_20)
# C++20 for std::countr_zero / std::popcount used by common/bit_set.h.

if(EMSCRIPTEN)
    target_compile_options(bementalJITPowerPCNext PUBLIC "-pthread")
    target_link_options(bementalJITPowerPCNext PUBLIC "-pthread")
endif()

