# bementalCompiler dispatch test harness.
# Builds an emcc executable: test_dispatch.html + .js + .wasm.
# Run by serving the build directory over HTTP and opening test_dispatch.html.

if(NOT EMSCRIPTEN)
    message(STATUS "bementalCompiler tests skipped (requires Emscripten)")
    return()
endif()

add_executable(test_dispatch test_dispatch.cpp)
target_link_libraries(test_dispatch PRIVATE bementalCompiler)
set_target_properties(test_dispatch PROPERTIES SUFFIX ".html")
target_link_options(test_dispatch PRIVATE
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s EXIT_RUNTIME=0"
)

# Gekko emitter smoke test — only built when the PowerPC guest is enabled.
if(BEMENTAL_GUEST_POWERPC)
    add_executable(test_gekko test_gekko.cpp)
    target_link_libraries(test_gekko PRIVATE bementalCompiler bementalCompilerPowerPC)
    target_include_directories(test_gekko PRIVATE
        ${CMAKE_SOURCE_DIR}
    )
    set_target_properties(test_gekko PROPERTIES SUFFIX ".html")
    target_link_options(test_gekko PRIVATE
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s EXIT_RUNTIME=0"
        # Stub all 9 PowerPC host imports — test only triggers addi which
        # doesn't call any of them, but the WASM module declares them all.
        "SHELL:-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE=[]"
    )
endif()
