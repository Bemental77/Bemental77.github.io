# bementalJIT — guest-agnostic WASM JIT builder.
#
# Consumers do:
#   add_subdirectory(<repo-root>/bementalJIT)
#   target_link_libraries(<your-core> PRIVATE bementalJIT)
#
# Per-guest emitters (guests/powerpc/, guests/mips/, etc.) are separate
# targets so a build only pulls in what it needs.

cmake_minimum_required(VERSION 3.13)
project(bementalJIT CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- Core library ----------------------------------------------------------

add_library(bementalJIT STATIC
    src/block_cache.cpp
    src/perf_runtime.cpp
)

target_include_directories(bementalJIT PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(bementalJIT PUBLIC cxx_std_17)

# perf_runtime.cpp uses <atomic>, which under Emscripten requires the
# 'atomics' wasm feature. The link target uses -pthread (shared memory);
# the static library must compile with -pthread too so wasm-ld doesn't
# reject objects that lack the atomics feature flag.
if(EMSCRIPTEN)
    target_compile_options(bementalJIT PUBLIC "-pthread")
    target_link_options(bementalJIT PUBLIC "-pthread")
endif()

# ---- Per-guest emitters (gated; each provides its own subdirectory) --------

option(BEMENTAL_GUEST_POWERPC "Build the Gekko (PowerPC 750CL) emitter" ON)
if(BEMENTAL_GUEST_POWERPC)
    add_subdirectory(guests/powerpc)
endif()

option(BEMENTAL_GUEST_SH4 "Build the SH4 emitter for Dreamcast" OFF)
if(BEMENTAL_GUEST_SH4)
    add_subdirectory(guests/sh4)
endif()

# Phase 1 parallel rebuild target — IR substrate (CodeOp/CodeBlock/PPCAnalyzer)
# that the existing emitter will progressively consume. Additive; safe to
# build alongside guests/powerpc/ until cut-over per scope-doc §7.
option(BEMENTAL_GUEST_POWERPC_NEXT "Build the Jit64-modeled PowerPC rebuild (parallel to powerpc/)" ON)
if(BEMENTAL_GUEST_POWERPC_NEXT)
    add_subdirectory(guests/powerpc-next)
endif()

# Phase 7 cut-over flag. When ON, block_cache.cpp and JitWasm.cpp route the
# region-build / per-block-body entry points through the powerpc-next
# wrappers (currently forward to the live implementations until proper
# JIT64-modeled ports land). Defined PUBLIC on bementalJIT so every
# consumer translation unit (block_cache.cpp inside bementalJIT,
# ppc_emit.cpp inside bementalJITPowerPCNext, and JitWasm.cpp inside
# dolphin's core) sees the same value.
option(BEMENTALJIT_USE_REBUILD "Route region/block builders through guests/powerpc-next/ wrappers" OFF)
if(BEMENTALJIT_USE_REBUILD)
    target_compile_definitions(bementalJIT PUBLIC BEMENTALJIT_USE_REBUILD=1)
    if(BEMENTAL_GUEST_POWERPC_NEXT)
        target_compile_definitions(bementalJITPowerPCNext PUBLIC BEMENTALJIT_USE_REBUILD=1)
    endif()
endif()

# ---- Tests -----------------------------------------------------------------

option(BEMENTAL_BUILD_TESTS "Build bementalJIT test harnesses" OFF)
if(BEMENTAL_BUILD_TESTS)
    add_subdirectory(tests)
endif()
