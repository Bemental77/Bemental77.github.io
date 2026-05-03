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
)

target_include_directories(bementalJIT PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_features(bementalJIT PUBLIC cxx_std_17)

# ---- Per-guest emitters (gated; each provides its own subdirectory) --------

option(BEMENTAL_GUEST_POWERPC "Build the Gekko (PowerPC 750CL) emitter" ON)
if(BEMENTAL_GUEST_POWERPC)
    add_subdirectory(guests/powerpc)
endif()

# ---- Tests -----------------------------------------------------------------

option(BEMENTAL_BUILD_TESTS "Build bementalJIT test harnesses" OFF)
if(BEMENTAL_BUILD_TESTS)
    add_subdirectory(tests)
endif()
