// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

// WGPU (WebGPU) Backend Documentation
//
// Milestone 1: a structural copy of the Null backend (stub Create* factories,
// stub EFB/texture/vertex/perf-query) whose only real work is presenting a
// SOLID CLEARED COLOR FRAME via emdawnwebgpu (WGPUGfx::BindBackbuffer /
// PresentBackbuffer).

#include "VideoBackends/WGPU/VideoBackend.h"

#include "Common/Common.h"

#include "VideoBackends/WGPU/WGPUBoundingBox.h"
#include "VideoBackends/WGPU/WGPUGfx.h"
#include "VideoBackends/WGPU/WGPUPerfQuery.h"
#include "VideoBackends/WGPU/WGPUTextureCache.h"
#include "VideoBackends/WGPU/WGPUVertexManager.h"

#include "VideoCommon/VideoCommon.h"
#include "VideoCommon/VideoConfig.h"

namespace WGPU
{
void VideoBackend::InitBackendInfo(const WindowSystemInfo& wsi)
{
  g_backend_info.api_type = APIType::Nothing;
  g_backend_info.MaxTextureSize = 16384;
  g_backend_info.bSupportsExclusiveFullscreen = true;
  g_backend_info.bSupportsDualSourceBlend = true;
  g_backend_info.bSupportsPrimitiveRestart = true;
  // [WGPU B1] WebGPU/WGSL has no geometry-shader stage and the pre-translated uber WGSL provides
  // only @vertex/@fragment entry points. Report geometry shaders UNSUPPORTED so Dolphin never asks
  // CreateShaderFromSource(Geometry) (which returns nullptr) and never builds a geometry stage.
  g_backend_info.bSupportsGeometryShaders = false;
  g_backend_info.bSupportsComputeShaders = false;
  g_backend_info.bSupports3DVision = false;
  g_backend_info.bSupportsEarlyZ = true;
  g_backend_info.bSupportsBindingLayout = true;
  g_backend_info.bSupportsBBox = true;
  // [WGPU B1] GS instancing depends on geometry shaders (unsupported); turn off.
  g_backend_info.bSupportsGSInstancing = false;
  g_backend_info.bSupportsPostProcessing = false;
  g_backend_info.bSupportsPaletteConversion = true;
  g_backend_info.bSupportsClipControl = true;
  g_backend_info.bSupportsSSAA = true;
  g_backend_info.bSupportsDepthClamp = true;
  // [WGPU C1 2026-07-13] WebGPU validation REJECTS reversed viewport depth ranges
  // ("minDepth was greater than maxDepth", measured live) — every affected pass invalidated its
  // whole command buffer. false = VideoCommon's reverse-Z path (1-z remap, D3D-style); the
  // pipeline depth compare funcs invert to match (WGPUGfx.cpp CreatePipeline inverted_depth).
  g_backend_info.bSupportsReversedDepthRange = false;
  g_backend_info.bSupportsMultithreading = false;
  g_backend_info.bSupportsGPUTextureDecoding = false;
  g_backend_info.bSupportsST3CTextures = false;
  g_backend_info.bSupportsBPTCTextures = false;
  g_backend_info.bSupportsFramebufferFetch = false;
  g_backend_info.bSupportsBackgroundCompiling = false;
  g_backend_info.bSupportsLogicOp = false;
  g_backend_info.bSupportsLargePoints = false;
  g_backend_info.bSupportsDepthReadback = false;
  g_backend_info.bSupportsPartialDepthCopies = false;
  g_backend_info.bSupportsShaderBinaries = false;
  g_backend_info.bSupportsPipelineCacheData = false;
  g_backend_info.bSupportsCoarseDerivatives = false;
  g_backend_info.bSupportsTextureQueryLevels = false;
  g_backend_info.bSupportsLodBiasInSampler = false;
  // [WGPU] The embedded uber WGSL was generated with backend_dynamic_sampler_indexing=false
  // (8 separate scalar texture/sampler bindings, NO binding_array / sized_binding_array, which
  // Dawn gates as a browser language feature). Report dynamic sampler indexing UNSUPPORTED so
  // runtime Dolphin's shader-gen path matches the regenerated WGSL exactly.
  g_backend_info.bSupportsDynamicSamplerIndexing = false;
  g_backend_info.bSupportsSettingObjectNames = false;
  g_backend_info.bSupportsPartialMultisampleResolve = true;
  g_backend_info.bSupportsDynamicVertexLoader = false;
  // [WGPU C1 2026-07-13] EFB->texture copies are implemented natively (WGPUTextureCache::
  // CopyEFBToCacheEntry -> WGPUGfx::BlitToTexture). Without this the TextureCacheBase gate
  // (TextureCacheBase.cpp:2204 bSupportsCopyToVram, default false) forced every XFB/EFB copy
  // onto the (stubbed) RAM path, so the XFB texture the present path samples stayed empty.
  g_backend_info.bSupportsCopyToVram = true;

  // aamodes: We only support 1 sample, so no MSAA
  g_backend_info.Adapters.clear();
  g_backend_info.AAModes = {1};
}

bool VideoBackend::Initialize(const WindowSystemInfo& wsi)
{
  return InitializeShared(std::make_unique<WGPUGfx>(wsi), std::make_unique<WGPUVertexManager>(),
                          std::make_unique<WGPUPerfQuery>(), std::make_unique<WGPUBoundingBox>(),
                          std::make_unique<WGPUEFBInterface>(), std::make_unique<WGPUTextureCache>());
}

void VideoBackend::Shutdown()
{
  ShutdownShared();
}

std::string VideoBackend::GetDisplayName() const
{
  // i18n: WebGPU is referring to the WGPU video backend.
  return _trans("WebGPU");
}
}  // namespace WGPU
