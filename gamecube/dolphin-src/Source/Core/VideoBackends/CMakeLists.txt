add_subdirectory(OGL)
add_subdirectory(Null)
add_subdirectory(Software)
# WGPU (emdawnwebgpu) is Emscripten-only; native builds must not compile it
# (native clang++ rejects --use-port=emdawnwebgpu). VideoBackendBase.cpp already
# gates the WGPU registration on __EMSCRIPTEN__.
if(EMSCRIPTEN)
  add_subdirectory(WGPU)
endif()

if(WIN32)
  add_subdirectory(D3DCommon)
  add_subdirectory(D3D)
  add_subdirectory(D3D12)
endif()

if(APPLE AND NOT LIBRETRO)
  add_subdirectory(Metal)
endif()

if(ENABLE_VULKAN)
  add_subdirectory(Vulkan)
endif()
