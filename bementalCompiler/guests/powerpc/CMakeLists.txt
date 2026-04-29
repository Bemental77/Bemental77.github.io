# bementalCompiler PowerPC (Gekko) emitter.
#
# Consumers add:
#   set(BEMENTAL_GUEST_POWERPC ON)
#   add_subdirectory(<repo-root>/bementalCompiler)
#   target_link_libraries(<your-cpu-core> PRIVATE bementalCompilerPowerPC)
#
# Provides:
#   bemental::powerpc::gekko_lookup(inst_word)    — instruction → emit fn
#   bemental::powerpc::gekko_emit_instr(EmitCtx&) — emit one Gekko instr
#   bemental::powerpc::build_block(...)           — assemble a basic-block module

add_library(bementalCompilerPowerPC STATIC
    gekko_emit.cpp
)

target_include_directories(bementalCompilerPowerPC PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(bementalCompilerPowerPC PUBLIC bementalCompiler)
target_compile_features(bementalCompilerPowerPC PUBLIC cxx_std_17)
