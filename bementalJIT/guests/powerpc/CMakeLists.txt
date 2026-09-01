# bementalJIT PowerPC (Gekko) emitter.
#
# Consumers add:
#   set(BEMENTAL_GUEST_POWERPC ON)
#   add_subdirectory(<repo-root>/bementalJIT)
#   target_link_libraries(<your-cpu-core> PRIVATE bementalJITPowerPC)
#
# Provides:
#   bemental::powerpc::gekko_lookup(inst_word)    — instruction → emit fn
#   bemental::powerpc::gekko_emit_instr(EmitCtx&) — emit one Gekko instr
#   bemental::powerpc::build_block(...)           — assemble a basic-block module

add_library(bementalJITPowerPC STATIC
    gekko_emit.cpp
)

target_include_directories(bementalJITPowerPC PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(bementalJITPowerPC PUBLIC bementalJIT)
target_compile_features(bementalJITPowerPC PUBLIC cxx_std_17)
