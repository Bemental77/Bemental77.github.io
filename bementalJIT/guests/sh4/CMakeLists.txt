# bementalJIT SH4 (Dreamcast) emitter — minimal seam.
#
# Consumers add:
#   set(BEMENTAL_GUEST_SH4 ON)
#   add_subdirectory(<repo-root>/bementalJIT)
#   target_link_libraries(<your-cpu-core> PRIVATE bementalJITSh4)
#
# Provides:
#   bemental::sh4::emitShilOp(...)    — per-op SHIL → WASM (seam only)
#   bemental::sh4::emitBlockExit(...) — block-end PC write
#   bemental::sh4::build_block(...)   — assemble a basic-block module

if(NOT DEFINED BEMENTAL_SH4_FLYCAST_SRC)
    set(BEMENTAL_SH4_FLYCAST_SRC "${CMAKE_SOURCE_DIR}/../dreamcast/flycast-src"
        CACHE PATH "Path to the Flycast source tree (provides hw/sh4/dyna headers)")
endif()

if(NOT EXISTS "${BEMENTAL_SH4_FLYCAST_SRC}/core/hw/sh4/dyna/shil.h")
    message(WARNING
        "bementalJITSh4: Flycast SH4 dyna headers not found at "
        "${BEMENTAL_SH4_FLYCAST_SRC}/core/hw/sh4/dyna/. Set "
        "-DBEMENTAL_SH4_FLYCAST_SRC=<path> or this target will fail to compile.")
endif()

add_library(bementalJITSh4 STATIC
    wasm_emit.cpp
)

target_include_directories(bementalJITSh4 PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${BEMENTAL_SH4_FLYCAST_SRC}/core
)

target_link_libraries(bementalJITSh4 PUBLIC bementalJIT)
target_compile_features(bementalJITSh4 PUBLIC cxx_std_17)
