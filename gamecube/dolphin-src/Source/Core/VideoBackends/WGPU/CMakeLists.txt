add_library(videowgpu
  WGPUBoundingBox.h
  WGPUGfx.cpp
  WGPUGfx.h
  WGPUMain.cpp
  WGPUPerfQuery.h
  WGPUTexture.cpp
  WGPUTexture.h
  WGPUTextureCache.h
  WGPUUberShaders.h
  WGPUVertexManager.cpp
  WGPUVertexManager.h
  VideoBackend.h
)

target_link_libraries(videowgpu
PUBLIC
  common
  videocommon
)

# The WGPU sources include <webgpu/webgpu.h>, which only resolves under the
# emdawnwebgpu port. Compile this target with the port enabled.
target_compile_options(videowgpu PRIVATE "SHELL:--use-port=emdawnwebgpu")

if(MSVC)
  # Add precompiled header
  target_link_libraries(videowgpu PRIVATE use_pch)
endif()
