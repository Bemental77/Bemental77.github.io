// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/WGPU/WGPUGfx.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <emscripten.h>  // emscripten_sleep (ASYNCIFY pump) + MAIN_THREAD_EM_ASM

#include "Core/Core.h"  // Core::MarkWGPUDeviceThread — TLS device-owner marker (dual-core hybrid)

#include "VideoBackends/WGPU/WGPUTexture.h"
#include "VideoBackends/WGPU/WGPUUberShaders.h"
#include "VideoBackends/WGPU/WGPUVertexManager.h"  // WGPUVertexFormat (vertex buffer layout)

#include "VideoCommon/AbstractPipeline.h"
#include "VideoCommon/AbstractShader.h"
#include "VideoCommon/ConstantManager.h"  // PixelShaderConstants / VertexShaderConstants sizes
#include "VideoCommon/FramebufferManager.h"
#include "VideoCommon/NativeVertexFormat.h"
#include "VideoCommon/RenderState.h"
#include "VideoCommon/VertexShaderGen.h"  // ShaderAttrib (vertex @location indices)
#include "VideoCommon/VideoConfig.h"

namespace WGPU
{
// Surface WebGPU device/validation errors to the page console with a [wgpu] prefix so they're
// visible under the page's [wgpu] filter (otherwise they land unprefixed among unrelated errors,
// and a validation error silently leaves async ops like buffer mapAsync hanging forever).
static void OnUncapturedError(WGPUDevice const*, WGPUErrorType type, WGPUStringView message,
                              void*, void*)
{
  MAIN_THREAD_EM_ASM({
    var msg = $2 ? UTF8ToString($1, $2) : '(no message)';
    postMessage({cmd: 'print', txt: '[wgpu] DEVICE ERROR type=' + $0 + ': ' + msg});
  }, (int)type, (int)(intptr_t)message.data, (int)message.length);
}

// Device loss is a SEPARATE callback from uncaptured-error; a lost device silently stalls all GPU
// work (e.g. a buffer mapAsync that never resolves) without firing the error callback.
static void OnDeviceLost(WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message,
                         void*, void*)
{
  MAIN_THREAD_EM_ASM({
    var msg = $2 ? UTF8ToString($1, $2) : '(no message)';
    postMessage({cmd: 'print', txt: '[wgpu] DEVICE LOST reason=' + $0 + ': ' + msg});
  }, (int)reason, (int)(intptr_t)message.data, (int)message.length);
}

// [WGPU-PROF — TEMP] per-frame draw counters: DrawIndexed accumulates, ShowImage reads + resets.
static int s_frame_draws = 0;
static double s_frame_draw_ms = 0.0;
double WGPUGfx::s_prof_tex_load_ms = 0.0;  // [WGPU-PROF — TEMP] texture-upload time accumulator
int WGPUGfx::s_prof_tex_loads = 0;
// [WGPU-PROF — TEMP] CoreTiming.Advance() time (the FIFO/VideoCommon + scheduled events bucket).
// JitWasm.cpp accumulates per Advance() call; ShowImage reads + resets each frame. Cross-TU global
// (videowgpu + core both linked into dolphin_libretro). JIT-dispatch ms = frame - advance - present.
double g_prof_advance_ms = 0.0;

// Init functions
WGPUGfx::WGPUGfx(const WindowSystemInfo& wsi)
{
  m_instance = wgpuCreateInstance(nullptr);

  // Create the WebGPU device ON THIS THREAD (the proxied pthread where the backend runs).
  // emscripten_webgpu_get_device() can't be used: it returns a JS device created on
  // worker-main, and WebGPU objects do not cross pthreads (emscripten #19645). So request
  // adapter+device here. wgpuInstanceWaitAny's *timed* wait needs the instance's
  // timedWaitAnyEnable feature (we didn't set it, so it returns TimedOut immediately) — so
  // instead pump the event loop: emscripten_sleep (ASYNCIFY unwinds → the JS request promise
  // resolves) + wgpuInstanceProcessEvents (fires the AllowProcessEvents callback).
  auto pump = [&](bool* done) {
    for (int i = 0; !*done && i < 5000; i++)
    {
      emscripten_sleep(1);
      wgpuInstanceProcessEvents(m_instance);
    }
  };

  WGPUAdapter adapter = nullptr;
  bool adapter_done = false;
  struct AdapterUD { WGPUAdapter* out; bool* done; } aud{&adapter, &adapter_done};
  {
    WGPURequestAdapterCallbackInfo cb = {};
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = [](WGPURequestAdapterStatus status, WGPUAdapter a, WGPUStringView,
                     void* ud, void*) {
      auto* u = static_cast<AdapterUD*>(ud);
      if (status == WGPURequestAdapterStatus_Success)
        *u->out = a;
      *u->done = true;
    };
    cb.userdata1 = &aud;
    wgpuInstanceRequestAdapter(m_instance, nullptr, cb);
    pump(&adapter_done);
  }
  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt: '[wgpu] adapter=' + ($0 ? 'OK' : 'NULL')}); },
                     (int)(adapter != nullptr));

  WGPUDevice device = nullptr;
  bool device_done = false;
  struct DeviceUD { WGPUDevice* out; bool* done; } dud{&device, &device_done};
  if (adapter)
  {
    WGPURequestDeviceCallbackInfo cb = {};
    cb.mode = WGPUCallbackMode_AllowProcessEvents;
    cb.callback = [](WGPURequestDeviceStatus status, WGPUDevice d, WGPUStringView,
                     void* ud, void*) {
      auto* u = static_cast<DeviceUD*>(ud);
      if (status == WGPURequestDeviceStatus_Success)
        *u->out = d;
      *u->done = true;
    };
    cb.userdata1 = &dud;
    WGPUDeviceDescriptor dev_desc = {};
    dev_desc.uncapturedErrorCallbackInfo.callback = OnUncapturedError;
    dev_desc.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowSpontaneous;
    dev_desc.deviceLostCallbackInfo.callback = OnDeviceLost;

    // The uber pixel shader begins with `enable dual_source_blending;` (GC dst-alpha blend modes).
    // Dawn gates that WGSL extension behind the dual-source-blending DEVICE feature; without it the
    // fragment module fails to compile and every pipeline's fragment stage is invalid. Request it
    // if the adapter exposes it.
    WGPUFeatureName required_features[1];
    size_t required_count = 0;
    const bool has_dsb = wgpuAdapterHasFeature(adapter, WGPUFeatureName_DualSourceBlending);
    if (has_dsb)
      required_features[required_count++] = WGPUFeatureName_DualSourceBlending;
    dev_desc.requiredFeatureCount = required_count;
    dev_desc.requiredFeatures = required_count ? required_features : nullptr;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] dual-source-blending: ' + ($0 ? 'requested' : 'NOT supported by adapter')}); },
      (int)has_dsb);

    wgpuAdapterRequestDevice(adapter, &dev_desc, cb);
    pump(&device_done);
  }

  m_device = device;
  m_queue = device ? wgpuDeviceGetQueue(m_device) : nullptr;
  // [dual-core hybrid 2026-07-21] WebGPU objects don't cross pthreads (emscripten #19645). Mark
  // THIS thread as the live-device owner so the FIFO-decode path (which runs on the separate
  // gpu_thread that does NOT own the device) skips device calls while still decoding the FIFO to
  // raise PE_FINISH. See Core::WGPUDeviceLiveOnThisThread().
  if (m_device)
    Core::MarkWGPUDeviceThread();
  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt: '[wgpu] device=' + ($0 ? 'OK' : 'NULL')
                       + ' queue=' + ($1 ? 'OK' : 'NULL')}); },
                     (int)(m_device != nullptr), (int)(m_queue != nullptr));

  // WindowSystemInfo carries no pixel dimensions; default present size to 640x480. ShowImage
  // matches the source (XFB/EFB) texture's real size when it reads back.
  m_width = 640;
  m_height = 480;

  // [WGPU present — CORRECTED 2026-07-13, was a FALSE premise] The old comment here claimed
  // "the page <canvas> can't reach this proxied-main pthread" and used that to justify a
  // GPU->CPU readback present. That is WRONG (verified against the emdawnwebgpu port source,
  // ~/emsdk-upstream .../library_webgpu.js): the port fully supports a DIRECT canvas surface
  // present — wgpuInstanceCreateSurface("#canvas") -> canvas.getContext('webgpu') ->
  // wgpuSurfaceConfigure(device,Fifo) -> render into wgpuSurfaceGetCurrentTexture (no readback,
  // no proxying — zero __proxy annotations). The page canvas CAN be routed to this proxied
  // pthread via the transferredCanvasNames / OFFSCREENCANVASES_TO_PTHREAD faux-canvas transfer
  // at pthread spawn. So the readback below is a SELF-IMPOSED M1 shortcut, not a platform limit.
  // NOT converted to direct present yet: it removes page-thread putImageData + a ~1.2MB/frame
  // postMessage (real quality/latency win) but does NOT raise fps — the frame rate is bounded by
  // the WORKER's jit+advance (~159ms/frame on the user's machine), and the readback is async
  // (present=0ms), off the worker's critical path. See memory
  // gc_wgpu_readback_present_is_avoidable_direct_canvas_2026_07_13 for the full direct-present
  // recipe. The readback buffer is sized lazily in ReadbackAndPresent.

  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
                       '[wgpu] M2-A backend init (device=' + ($0 ? 'OK' : 'NULL') + ')'}); },
                     (int)(m_device != nullptr));

  UpdateActiveConfig();
}

WGPUGfx::~WGPUGfx()
{
  EndRenderPass();
  if (m_encoder)
  {
    wgpuCommandEncoderRelease(m_encoder);
    m_encoder = nullptr;
  }
  if (m_readback_buffer)
    wgpuBufferRelease(m_readback_buffer);
  if (m_cached_grp0)  // [WGPU C3] cache-owned bind groups
    wgpuBindGroupRelease(m_cached_grp0);
  if (m_cached_grp1)
    wgpuBindGroupRelease(m_cached_grp1);
  // [WGPU C4 2026-07-14] m_bound_samplers are non-owning refs into m_sampler_cache — release the
  // CACHE (each sampler once), not m_bound_samplers (which would double-release shared handles).
  for (auto& kv : m_sampler_cache)
  {
    if (kv.second)
      wgpuSamplerRelease(kv.second);
  }
  if (m_dummy_sampler)
    wgpuSamplerRelease(m_dummy_sampler);
  if (m_dummy_texture_view)
    wgpuTextureViewRelease(m_dummy_texture_view);
  if (m_dummy_texture)
    wgpuTextureRelease(m_dummy_texture);
  if (m_uber_pipeline_layout)
    wgpuPipelineLayoutRelease(m_uber_pipeline_layout);
  if (m_uber_bgl_uniforms)
    wgpuBindGroupLayoutRelease(m_uber_bgl_uniforms);
  if (m_uber_bgl_textures)
    wgpuBindGroupLayoutRelease(m_uber_bgl_textures);
  UpdateActiveConfig();
}

bool WGPUGfx::IsHeadless() const
{
  return false;
}

bool WGPUGfx::SupportsUtilityDrawing() const
{
  return false;
}

SurfaceInfo WGPUGfx::GetSurfaceInfo() const
{
  return {m_width, m_height, 1.0f, AbstractTextureFormat::RGBA8};
}

// ---------------------------------------------------------------------------------------------
// Render-pass ownership (the M2-A crux).
// ---------------------------------------------------------------------------------------------

void WGPUGfx::EnsureEncoder()
{
  if (!m_encoder && m_device)
    m_encoder = wgpuDeviceCreateCommandEncoder(m_device, nullptr);
}

void WGPUGfx::BeginRenderPassIfNeeded()
{
  if (m_pass || !m_device || !m_bound_fb)
    return;
  EnsureEncoder();
  if (!m_encoder)
    return;

  WGPUTextureView color_view = m_bound_fb->GetColorView();
  if (!color_view)
    return;

  // Preserve existing contents (loadOp=Load). A draw or present that needs the pass open begins
  // it here; SetAndClearFramebuffer takes the explicit-clear path instead.
  WGPURenderPassColorAttachment att = {};
  att.view = color_view;
  att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
  att.loadOp = WGPULoadOp_Load;
  att.storeOp = WGPUStoreOp_Store;

  WGPURenderPassDescriptor rp = {};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &att;

  // Depth attachment is read-only / preserved if present (no real depth ops in Chunk A).
  WGPURenderPassDepthStencilAttachment depth_att = {};
  if (m_bound_fb->GetDepthView())
  {
    depth_att.view = m_bound_fb->GetDepthView();
    depth_att.depthLoadOp = WGPULoadOp_Load;
    depth_att.depthStoreOp = WGPUStoreOp_Store;
    rp.depthStencilAttachment = &depth_att;
  }

  m_pass = wgpuCommandEncoderBeginRenderPass(m_encoder, &rp);
  ApplyViewportAndScissor();
}

void WGPUGfx::EndRenderPass()
{
  if (m_pass)
  {
    wgpuRenderPassEncoderEnd(m_pass);
    wgpuRenderPassEncoderRelease(m_pass);
    m_pass = nullptr;
  }
}

void WGPUGfx::SubmitFrame()
{
  EndRenderPass();
  if (m_encoder)
  {
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(m_encoder, nullptr);
    if (m_queue && cmd)
      wgpuQueueSubmit(m_queue, 1, &cmd);
    if (cmd)
      wgpuCommandBufferRelease(cmd);
    wgpuCommandEncoderRelease(m_encoder);
    m_encoder = nullptr;
  }
}

void WGPUGfx::SetFramebuffer(AbstractFramebuffer* framebuffer)
{
  AbstractGfx::SetFramebuffer(framebuffer);  // keep m_current_framebuffer in sync
  EndRenderPass();                           // a different fb means a different pass
  m_bound_fb = static_cast<WGPUFramebuffer*>(framebuffer);
  // Lazily begin the pass (loadOp=Load) when a draw/present next needs it.
}

void WGPUGfx::SetAndDiscardFramebuffer(AbstractFramebuffer* framebuffer)
{
  AbstractGfx::SetAndDiscardFramebuffer(framebuffer);
  EndRenderPass();
  m_bound_fb = static_cast<WGPUFramebuffer*>(framebuffer);
}

void WGPUGfx::SetAndClearFramebuffer(AbstractFramebuffer* framebuffer,
                                     const ClearColor& color_value, float depth_value)
{
  AbstractGfx::SetAndClearFramebuffer(framebuffer, color_value, depth_value);
  EndRenderPass();
  m_bound_fb = static_cast<WGPUFramebuffer*>(framebuffer);

  WGPUFramebuffer* fb = m_bound_fb;
  if (!fb || !fb->GetColorView() || !m_device)
    return;
  EnsureEncoder();
  if (!m_encoder)
    return;

  // Clear the EFB to the game's actual requested color via loadOp=Clear into the real EFB
  // WGPUTexture. (B1: the magenta proof hack is removed; with draws still stubbed the canvas will
  // go near-black, which is EXPECTED — B1 is validated by the absence of device/WGSL errors.)
  WGPURenderPassColorAttachment att = {};
  att.view = fb->GetColorView();
  att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
  att.loadOp = WGPULoadOp_Clear;
  att.storeOp = WGPUStoreOp_Store;
  att.clearValue = {color_value[0], color_value[1], color_value[2], color_value[3]};

  WGPURenderPassDescriptor rp = {};
  rp.colorAttachmentCount = 1;
  rp.colorAttachments = &att;

  WGPURenderPassDepthStencilAttachment depth_att = {};
  if (fb->GetDepthView())
  {
    depth_att.view = fb->GetDepthView();
    depth_att.depthLoadOp = WGPULoadOp_Clear;
    depth_att.depthStoreOp = WGPUStoreOp_Store;
    depth_att.depthClearValue = depth_value;
    rp.depthStencilAttachment = &depth_att;
  }

  // Begin (and immediately leave open) the clear pass. Stub draws record nothing; the present
  // path / next copy will End it. Beginning with loadOp=Clear is what actually writes magenta.
  m_pass = wgpuCommandEncoderBeginRenderPass(m_encoder, &rp);
  ApplyViewportAndScissor();

  static bool s_clear_logged = false;
  if (!s_clear_logged)
  {
    s_clear_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
                         '[wgpu] EFB SetAndClearFramebuffer ' + $0 + 'x' + $1}); },
                       (int)fb->GetWidth(), (int)fb->GetHeight());
  }
}

// ---------------------------------------------------------------------------------------------
// [WGPU C1 2026-07-13] Viewport/scissor + native utility draws (clear + blit).
//
// Root-cause context (2026-07-13 audit, wf_a86451c3): CreateShaderFromSource always substitutes
// the embedded uber WGSL pair, so every VideoCommon utility draw (EFB clear quad, EFB->XFB copy
// shader) silently either no-oped (Draw(u32,u32) never overridden) or would run with the WRONG
// shader. Consequences: the EFB was never cleared (ghosting), XFB copies stayed empty, and
// ShowImage presented the live mid-composite EFB (desaturation + offset ghosts). The fix is
// NATIVE implementations of the three critical consumers (ClearRegion here, EFB->XFB blit here +
// WGPUTextureCache, XFB present in ShowImage) with dedicated hand-written WGSL — deliberately NOT
// routed through the uber-only shader cache.
// ---------------------------------------------------------------------------------------------

namespace
{
// Fullscreen-triangle VS + blit/clear FS. Bindings: 0 = params uniform, 1 = src texture (blit
// only), 2 = sampler (blit only). Pipeline layouts differ (clear omits 1/2 — WGSL allows a layout
// that omits bindings an entry point never statically uses).
constexpr const char UTIL_WGSL[] = R"(
struct UtilParams {
  uv_off_scale : vec4<f32>,
  clear_color : vec4<f32>,
  clear_depth : vec4<f32>,
};
@group(0) @binding(0) var<uniform> uparams : UtilParams;
@group(0) @binding(1) var utex : texture_2d<f32>;
@group(0) @binding(2) var usamp : sampler;

struct UtilVSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex fn util_vs(@builtin(vertex_index) vid : u32) -> UtilVSOut {
  var o : UtilVSOut;
  let base = vec2<f32>(f32((vid << 1u) & 2u), f32(vid & 2u));
  o.pos = vec4<f32>(base * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  o.uv = uparams.uv_off_scale.xy + base * uparams.uv_off_scale.zw;
  return o;
}

@fragment fn util_fs_blit(in : UtilVSOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(utex, usamp, in.uv, 0.0);
}

struct UtilClearOut {
  @builtin(frag_depth) depth : f32,
  @location(0) color : vec4<f32>,
};
@fragment fn util_fs_clear(in : UtilVSOut) -> UtilClearOut {
  var o : UtilClearOut;
  o.color = uparams.clear_color;
  o.depth = uparams.clear_depth.x;
  return o;
}

@fragment fn util_fs_clear_nodepth(in : UtilVSOut) -> @location(0) vec4<f32> {
  return uparams.clear_color;
}
)";

constexpr u32 UTIL_UNIFORM_SLOT = 256;                      // min uniform alignment
constexpr u32 UTIL_UNIFORM_RING = 256 * UTIL_UNIFORM_SLOT;  // 64KB, 256 slots
struct UtilParamsCPU
{
  float uv_off_scale[4];
  float clear_color[4];
  float clear_depth[4];
};
}  // namespace

void WGPUGfx::SetViewport(float x, float y, float width, float height, float near_depth,
                          float far_depth)
{
  m_viewport[0] = x;
  m_viewport[1] = y;
  m_viewport[2] = width;
  m_viewport[3] = height;
  m_viewport[4] = near_depth;
  m_viewport[5] = far_depth;
  if (m_pass)
    ApplyViewportAndScissor();
}

void WGPUGfx::SetScissorRect(const MathUtil::Rectangle<int>& rc)
{
  m_scissor = rc;
  m_scissor_valid = true;
  if (m_pass)
    ApplyViewportAndScissor();
}

void WGPUGfx::ApplyViewportAndScissor()
{
  if (!m_pass || !m_bound_fb)
    return;
  const float fb_w = static_cast<float>(m_bound_fb->GetWidth());
  const float fb_h = static_cast<float>(m_bound_fb->GetHeight());

  // Clamp to attachment bounds (WebGPU validation requires the viewport inside the target and
  // depths within [0,1]).
  float x = std::max(0.0f, m_viewport[0]);
  float y = std::max(0.0f, m_viewport[1]);
  float w = std::min(m_viewport[2], fb_w - x);
  float h = std::min(m_viewport[3], fb_h - y);
  float zn = std::min(std::max(m_viewport[4], 0.0f), 1.0f);
  float zf = std::min(std::max(m_viewport[5], 0.0f), 1.0f);
  if (w > 0.0f && h > 0.0f)
    wgpuRenderPassEncoderSetViewport(m_pass, x, y, w, h, zn, zf);

  int sx = 0, sy = 0, sw = static_cast<int>(fb_w), sh = static_cast<int>(fb_h);
  if (m_scissor_valid)
  {
    sx = std::max(0, m_scissor.left);
    sy = std::max(0, m_scissor.top);
    sw = std::min(m_scissor.right, static_cast<int>(fb_w)) - sx;
    sh = std::min(m_scissor.bottom, static_cast<int>(fb_h)) - sy;
  }
  if (sw > 0 && sh > 0)
    wgpuRenderPassEncoderSetScissorRect(m_pass, static_cast<u32>(sx), static_cast<u32>(sy),
                                        static_cast<u32>(sw), static_cast<u32>(sh));
}

bool WGPUGfx::EnsureUtilPipelines()
{
  if (m_util_module)
    return true;
  if (m_util_tried || !m_device)
    return false;
  m_util_tried = true;

  WGPUShaderSourceWGSL wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderSourceWGSL;
  wgsl.code = {UTIL_WGSL, WGPU_STRLEN};
  WGPUShaderModuleDescriptor smd = {};
  smd.nextInChain = &wgsl.chain;
  m_util_module = wgpuDeviceCreateShaderModule(m_device, &smd);
  if (!m_util_module)
    return false;

  // Blit BGL: uniform + texture + sampler.
  {
    WGPUBindGroupLayoutEntry entries[3] = {};
    entries[0].binding = 0;
    entries[0].visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entries[0].buffer.type = WGPUBufferBindingType_Uniform;
    entries[0].buffer.minBindingSize = sizeof(UtilParamsCPU);
    entries[1].binding = 1;
    entries[1].visibility = WGPUShaderStage_Fragment;
    entries[1].texture.sampleType = WGPUTextureSampleType_Float;
    entries[1].texture.viewDimension = WGPUTextureViewDimension_2D;
    entries[2].binding = 2;
    entries[2].visibility = WGPUShaderStage_Fragment;
    entries[2].sampler.type = WGPUSamplerBindingType_Filtering;
    WGPUBindGroupLayoutDescriptor bgld = {};
    bgld.entryCount = 3;
    bgld.entries = entries;
    m_util_blit_bgl = wgpuDeviceCreateBindGroupLayout(m_device, &bgld);
    WGPUPipelineLayoutDescriptor pld = {};
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &m_util_blit_bgl;
    m_util_blit_layout = wgpuDeviceCreatePipelineLayout(m_device, &pld);
  }
  // Clear BGL: uniform only.
  {
    WGPUBindGroupLayoutEntry entry = {};
    entry.binding = 0;
    entry.visibility = WGPUShaderStage_Vertex | WGPUShaderStage_Fragment;
    entry.buffer.type = WGPUBufferBindingType_Uniform;
    entry.buffer.minBindingSize = sizeof(UtilParamsCPU);
    WGPUBindGroupLayoutDescriptor bgld = {};
    bgld.entryCount = 1;
    bgld.entries = &entry;
    m_util_clear_bgl = wgpuDeviceCreateBindGroupLayout(m_device, &bgld);
    WGPUPipelineLayoutDescriptor pld = {};
    pld.bindGroupLayoutCount = 1;
    pld.bindGroupLayouts = &m_util_clear_bgl;
    m_util_clear_layout = wgpuDeviceCreatePipelineLayout(m_device, &pld);
  }
  // Blit pipeline: RGBA8 color target, no depth, no blending.
  {
    WGPUVertexState vertex = {};
    vertex.module = m_util_module;
    vertex.entryPoint = {"util_vs", WGPU_STRLEN};
    WGPUColorTargetState target = {};
    target.format = WGPUTextureFormat_RGBA8Unorm;
    target.writeMask = WGPUColorWriteMask_All;
    WGPUFragmentState fragment = {};
    fragment.module = m_util_module;
    fragment.entryPoint = {"util_fs_blit", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPURenderPipelineDescriptor pd = {};
    pd.layout = m_util_blit_layout;
    pd.vertex = vertex;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.multisample.count = 1;
    pd.multisample.mask = 0xFFFFFFFF;
    pd.fragment = &fragment;
    m_util_blit_pipeline = wgpuDeviceCreateRenderPipeline(m_device, &pd);
  }
  // Samplers + uniform ring.
  {
    WGPUSamplerDescriptor sd = {};
    sd.addressModeU = WGPUAddressMode_ClampToEdge;
    sd.addressModeV = WGPUAddressMode_ClampToEdge;
    sd.addressModeW = WGPUAddressMode_ClampToEdge;
    sd.magFilter = WGPUFilterMode_Nearest;
    sd.minFilter = WGPUFilterMode_Nearest;
    sd.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    sd.maxAnisotropy = 1;
    m_util_sampler_nearest = wgpuDeviceCreateSampler(m_device, &sd);
    sd.magFilter = WGPUFilterMode_Linear;
    sd.minFilter = WGPUFilterMode_Linear;
    m_util_sampler_linear = wgpuDeviceCreateSampler(m_device, &sd);

    WGPUBufferDescriptor bd = {};
    bd.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
    bd.size = UTIL_UNIFORM_RING;
    m_util_uniforms = wgpuDeviceCreateBuffer(m_device, &bd);
  }

  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
    '[wgpu] util pipelines (blit+clear): module=' + ($0 ? 'OK' : 'NULL')
    + ' blit=' + ($1 ? 'OK' : 'NULL')}); },
    (int)(m_util_module != nullptr), (int)(m_util_blit_pipeline != nullptr));

  return m_util_module && m_util_blit_pipeline && m_util_uniforms;
}

u32 WGPUGfx::AllocUtilUniformSlot(const void* data, u32 size)
{
  if (!m_util_uniforms || !m_queue || size > UTIL_UNIFORM_SLOT)
    return UINT32_MAX;
  if (m_util_uniform_offset + UTIL_UNIFORM_SLOT > UTIL_UNIFORM_RING)
  {
    // Queue writes execute before the deferred encoder's submit; flush recorded work so the
    // wrapped slot's new bytes can't clobber an earlier draw's params in this submission.
    EndRenderPass();
    SubmitFrame();
    m_util_uniform_offset = 0;
  }
  const u32 offset = m_util_uniform_offset;
  wgpuQueueWriteBuffer(m_queue, m_util_uniforms, offset, data, size);
  m_util_uniform_offset += UTIL_UNIFORM_SLOT;
  return offset;
}

void WGPUGfx::ClearRegion(const MathUtil::Rectangle<int>& target_rc, bool colorEnable,
                          bool alphaEnable, bool zEnable, u32 color, u32 z)
{
  if (!m_device || !m_bound_fb || !EnsureUtilPipelines())
    return;

  // Pipeline variant: color write mask + depth write + whether the bound fb has depth at all
  // (frag_depth requires a depth attachment in the pass).
  const bool has_depth = m_bound_fb->GetDepthView() != nullptr;
  u32 mask = 0;
  if (colorEnable)
    mask |= WGPUColorWriteMask_Red | WGPUColorWriteMask_Green | WGPUColorWriteMask_Blue;
  if (alphaEnable)
    mask |= WGPUColorWriteMask_Alpha;
  const u32 key = (mask & 0xF) | (has_depth ? 16u : 0u) | ((has_depth && zEnable) ? 32u : 0u);
  if (key >= 64)
    return;

  if (!m_util_clear_pipelines[key])
  {
    WGPUVertexState vertex = {};
    vertex.module = m_util_module;
    vertex.entryPoint = {"util_vs", WGPU_STRLEN};
    WGPUColorTargetState target = {};
    target.format = WGPUTextureFormat_RGBA8Unorm;
    target.writeMask = static_cast<WGPUColorWriteMask>(mask);
    WGPUFragmentState fragment = {};
    fragment.module = m_util_module;
    fragment.entryPoint = has_depth ? WGPUStringView{"util_fs_clear", WGPU_STRLEN} :
                                      WGPUStringView{"util_fs_clear_nodepth", WGPU_STRLEN};
    fragment.targetCount = 1;
    fragment.targets = &target;
    WGPUDepthStencilState depth = {};
    depth.format = WGPUTextureFormat_Depth32Float;
    depth.depthWriteEnabled = zEnable ? WGPUOptionalBool_True : WGPUOptionalBool_False;
    depth.depthCompare = WGPUCompareFunction_Always;
    depth.stencilFront = {WGPUCompareFunction_Always, WGPUStencilOperation_Keep,
                          WGPUStencilOperation_Keep, WGPUStencilOperation_Keep};
    depth.stencilBack = {WGPUCompareFunction_Always, WGPUStencilOperation_Keep,
                         WGPUStencilOperation_Keep, WGPUStencilOperation_Keep};
    WGPURenderPipelineDescriptor pd = {};
    pd.layout = m_util_clear_layout;
    pd.vertex = vertex;
    pd.primitive.topology = WGPUPrimitiveTopology_TriangleList;
    pd.multisample.count = 1;
    pd.multisample.mask = 0xFFFFFFFF;
    if (has_depth)
      pd.depthStencil = &depth;
    pd.fragment = &fragment;
    m_util_clear_pipelines[key] = wgpuDeviceCreateRenderPipeline(m_device, &pd);
  }
  if (!m_util_clear_pipelines[key])
    return;

  // ARGB color / 24-bit z, matching OGLGfx::ClearRegion's conversions.
  UtilParamsCPU params = {};
  params.clear_color[0] = static_cast<float>((color >> 16) & 0xFF) / 255.0f;
  params.clear_color[1] = static_cast<float>((color >> 8) & 0xFF) / 255.0f;
  params.clear_color[2] = static_cast<float>((color >> 0) & 0xFF) / 255.0f;
  params.clear_color[3] = static_cast<float>((color >> 24) & 0xFF) / 255.0f;
  params.clear_depth[0] = static_cast<float>(z & 0xFFFFFF) / 16777216.0f;
  // Reverse-Z: bSupportsReversedDepthRange=false, so the stored depth convention is 1-z
  // (mirrors AbstractGfx::ClearRegion's uniforms.clear_depth flip at AbstractGfx.cpp:83-84).
  params.clear_depth[0] = 1.0f - params.clear_depth[0];
  const u32 uoff = AllocUtilUniformSlot(&params, sizeof(params));
  if (uoff == UINT32_MAX)
    return;

  BeginRenderPassIfNeeded();
  if (!m_pass)
    return;

  WGPUBindGroupEntry entry = {};
  entry.binding = 0;
  entry.buffer = m_util_uniforms;
  entry.offset = uoff;
  entry.size = sizeof(UtilParamsCPU);
  WGPUBindGroupDescriptor bgd = {};
  bgd.layout = m_util_clear_bgl;
  bgd.entryCount = 1;
  bgd.entries = &entry;
  WGPUBindGroup grp = wgpuDeviceCreateBindGroup(m_device, &bgd);
  if (!grp)
    return;

  // Scissor the clear to target_rc (the fullscreen triangle covers everything else).
  const int sx = std::max(0, target_rc.left);
  const int sy = std::max(0, target_rc.top);
  const int sw = std::min<int>(target_rc.right, m_bound_fb->GetWidth()) - sx;
  const int sh = std::min<int>(target_rc.bottom, m_bound_fb->GetHeight()) - sy;
  if (sw > 0 && sh > 0)
  {
    wgpuRenderPassEncoderSetViewport(m_pass, 0.0f, 0.0f,
                                     static_cast<float>(m_bound_fb->GetWidth()),
                                     static_cast<float>(m_bound_fb->GetHeight()), 0.0f, 1.0f);
    wgpuRenderPassEncoderSetScissorRect(m_pass, static_cast<u32>(sx), static_cast<u32>(sy),
                                        static_cast<u32>(sw), static_cast<u32>(sh));
    wgpuRenderPassEncoderSetPipeline(m_pass, m_util_clear_pipelines[key]);
    wgpuRenderPassEncoderSetBindGroup(m_pass, 0, grp, 0, nullptr);
    wgpuRenderPassEncoderDraw(m_pass, 3, 1, 0, 0);
  }
  wgpuBindGroupRelease(grp);

  // Restore the game's cached viewport/scissor for subsequent draws.
  ApplyViewportAndScissor();

  static bool s_clearregion_logged = false;
  if (!s_clearregion_logged)
  {
    s_clearregion_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] ClearRegion ACTIVE rc=' + $0 + 'x' + $1 + ' c=' + $2 + ' a=' + $3 + ' z=' + $4}); },
      sw, sh, (int)colorEnable, (int)alphaEnable, (int)zEnable);
  }
}

bool WGPUGfx::BlitToTexture(::WGPUTexture src_texture, u32 src_width, u32 src_height,
                            const MathUtil::Rectangle<int>& src_rect, ::WGPUTexture dst_texture,
                            u32 dst_w, u32 dst_h, bool linear_filter)
{
  if (!m_device || !src_texture || !dst_texture || !EnsureUtilPipelines() ||
      !m_util_blit_pipeline || src_width == 0 || src_height == 0 || dst_w == 0 || dst_h == 0)
    return false;

  UtilParamsCPU params = {};
  params.uv_off_scale[0] = static_cast<float>(src_rect.left) / static_cast<float>(src_width);
  params.uv_off_scale[1] = static_cast<float>(src_rect.top) / static_cast<float>(src_height);
  params.uv_off_scale[2] = static_cast<float>(src_rect.GetWidth()) / static_cast<float>(src_width);
  params.uv_off_scale[3] =
      static_cast<float>(src_rect.GetHeight()) / static_cast<float>(src_height);
  const u32 uoff = AllocUtilUniformSlot(&params, sizeof(params));
  if (uoff == UINT32_MAX)
    return false;

  // The blit records its own pass into the shared deferred encoder: end the open EFB pass first
  // (same-encoder ordering keeps draws-before-copy semantics); the next game draw reopens it.
  EndRenderPass();
  EnsureEncoder();
  if (!m_encoder)
    return false;

  WGPUTextureViewDescriptor src_vd = {};
  src_vd.dimension = WGPUTextureViewDimension_2D;
  src_vd.baseMipLevel = 0;
  src_vd.mipLevelCount = 1;
  src_vd.baseArrayLayer = 0;
  src_vd.arrayLayerCount = 1;
  src_vd.aspect = WGPUTextureAspect_All;
  WGPUTextureView src_view = wgpuTextureCreateView(src_texture, &src_vd);
  WGPUTextureView dst_view = wgpuTextureCreateView(dst_texture, &src_vd);
  if (!src_view || !dst_view)
  {
    if (src_view)
      wgpuTextureViewRelease(src_view);
    if (dst_view)
      wgpuTextureViewRelease(dst_view);
    return false;
  }

  WGPUBindGroupEntry entries[3] = {};
  entries[0].binding = 0;
  entries[0].buffer = m_util_uniforms;
  entries[0].offset = uoff;
  entries[0].size = sizeof(UtilParamsCPU);
  entries[1].binding = 1;
  entries[1].textureView = src_view;
  entries[2].binding = 2;
  entries[2].sampler = linear_filter ? m_util_sampler_linear : m_util_sampler_nearest;
  WGPUBindGroupDescriptor bgd = {};
  bgd.layout = m_util_blit_bgl;
  bgd.entryCount = 3;
  bgd.entries = entries;
  WGPUBindGroup grp = wgpuDeviceCreateBindGroup(m_device, &bgd);

  bool ok = false;
  if (grp)
  {
    WGPURenderPassColorAttachment att = {};
    att.view = dst_view;
    att.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    att.loadOp = WGPULoadOp_Clear;
    att.storeOp = WGPUStoreOp_Store;
    WGPURenderPassDescriptor rp = {};
    rp.colorAttachmentCount = 1;
    rp.colorAttachments = &att;
    WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(m_encoder, &rp);
    if (pass)
    {
      wgpuRenderPassEncoderSetViewport(pass, 0.0f, 0.0f, static_cast<float>(dst_w),
                                       static_cast<float>(dst_h), 0.0f, 1.0f);
      wgpuRenderPassEncoderSetPipeline(pass, m_util_blit_pipeline);
      wgpuRenderPassEncoderSetBindGroup(pass, 0, grp, 0, nullptr);
      wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
      wgpuRenderPassEncoderEnd(pass);
      wgpuRenderPassEncoderRelease(pass);
      ok = true;
    }
    wgpuBindGroupRelease(grp);
  }
  wgpuTextureViewRelease(src_view);
  wgpuTextureViewRelease(dst_view);

  static bool s_blit_logged = false;
  if (!s_blit_logged && ok)
  {
    s_blit_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] EFB->texture blit ACTIVE ' + $0 + 'x' + $1 + ' -> ' + $2 + 'x' + $3}); },
      (int)src_rect.GetWidth(), (int)src_rect.GetHeight(), (int)dst_w, (int)dst_h);
  }
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Readback present (NON-BLOCKING). A blocking emscripten_sleep pump inside ShowImage stalls: the
// emulator frame loop already yields via ASYNCIFY, so a nested sleep-pump corrupts the unwind
// after the first iteration (M1 only ever needed 1 iteration, so it never hit this). Map the
// readback buffer with a SPONTANEOUS callback that de-pads + posts when it fires; return now.
// ---------------------------------------------------------------------------------------------

namespace
{
struct ReadbackCtx
{
  WGPUGfx* gfx;
  ::WGPUBuffer buffer;
  u32 width;
  u32 height;
  u32 padded_bytes_per_row;
  size_t buf_size;
};
}  // namespace

void WGPUGfx::ReadbackAndPresent(::WGPUTexture src_texture, u32 origin_x, u32 origin_y, u32 width,
                                 u32 height)
{
  if (!m_device || !m_queue || !src_texture || width == 0 || height == 0)
    return;
  if (m_readback_in_flight >= 3)  // [pipeline] cap depth; each readback owns a fresh buffer
    return;

  // Flush any pending render-pass/encoder work (e.g. the EFB clear) before the copy.
  EndRenderPass();
  SubmitFrame();

  // WebGPU requires copyTextureToBuffer's bytesPerRow to be a multiple of 256.
  const u32 padded_bytes_per_row = ((width * 4 + 255) / 256) * 256;
  const size_t buf_size = (size_t)padded_bytes_per_row * height;

  // [pipeline] Multiple readbacks in flight (cap 3), each owning its own buffer.
  // [staging ring STEP 4 2026-07-09] buffers come from a persistent pool instead of the
  // old per-frame wgpuDeviceCreateBuffer/Release pair (the last allocation churn on the
  // present path; the map callback returns buffers to the pool, unmapped => reusable).
  // Pool flushes when the padded size changes (resolution change).
  if (m_readback_pool_buf_size != buf_size)
  {
    for (::WGPUBuffer b : m_readback_pool)
      wgpuBufferRelease(b);
    m_readback_pool.clear();
    m_readback_pool_buf_size = buf_size;
  }
  ::WGPUBuffer rb_buffer = nullptr;
  if (!m_readback_pool.empty())
  {
    rb_buffer = m_readback_pool.back();
    m_readback_pool.pop_back();
  }
  else
  {
    WGPUBufferDescriptor buf_desc = {};
    buf_desc.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    buf_desc.size = (uint64_t)buf_size;
    buf_desc.mappedAtCreation = false;
    rb_buffer = wgpuDeviceCreateBuffer(m_device, &buf_desc);
  }
  if (!rb_buffer)
    return;

  m_width = width;
  m_height = height;

  // Copy the source texture (layer 0, mip 0) into the mappable readback buffer.
  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(m_device, nullptr);

  WGPUTexelCopyTextureInfo src = {};
  src.texture = src_texture;
  src.mipLevel = 0;
  src.origin = {origin_x, origin_y, 0};
  src.aspect = WGPUTextureAspect_All;

  WGPUTexelCopyBufferInfo dst = {};
  dst.buffer = rb_buffer;
  dst.layout.offset = 0;
  dst.layout.bytesPerRow = padded_bytes_per_row;
  dst.layout.rowsPerImage = height;

  WGPUExtent3D copy_size = {width, height, 1};
  wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &copy_size);

  WGPUCommandBuffer copy_cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuQueueSubmit(m_queue, 1, &copy_cmd);
  wgpuCommandBufferRelease(copy_cmd);
  wgpuCommandEncoderRelease(enc);

  // Non-blocking map. The spontaneous callback fires when the GPU copy completes and the event
  // loop next runs (the emulator frame loop yields, so this needs no blocking pump).
  m_readback_in_flight++;
  auto* ctx =
      new ReadbackCtx{this, rb_buffer, width, height, padded_bytes_per_row, buf_size};

  WGPUBufferMapCallbackInfo cb = {};
  // [WGPU C2 2026-07-13] AllowSpontaneous (was AllowProcessEvents): with the per-tick pump the
  // callback waited for the NEXT ShowImage call, serializing presents to far below the ShowImage
  // rate (menu measured 12ms/frame emulated but only 15.4 presents/s — most presents dropped at
  // the in-flight cap). Spontaneous fires as soon as the JS promise resolves and the runtime
  // yields (same mode the deviceLost callback already uses).
  cb.mode = WGPUCallbackMode_AllowSpontaneous;
  cb.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* ud, void*) {
    auto* c = static_cast<ReadbackCtx*>(ud);
    WGPUGfx* gfx = c->gfx;
    static bool s_cb_logged = false;
    if (!s_cb_logged)
    {
      s_cb_logged = true;
      MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
        '[wgpu] readback map callback FIRED status=' + $0}); }, (int)status);
    }
    if (status == WGPUMapAsyncStatus_Success)
    {
      const uint8_t* mapped =
          static_cast<const uint8_t*>(wgpuBufferGetConstMappedRange(c->buffer, 0, c->buf_size));
      if (mapped)
      {
        gfx->m_pixels.assign((size_t)c->width * 4 * c->height, 0);
        const size_t row_bytes = (size_t)c->width * 4;
        for (u32 y = 0; y < c->height; y++)
          std::memcpy(&gfx->m_pixels[(size_t)y * row_bytes],
                      mapped + (size_t)y * c->padded_bytes_per_row, row_bytes);
        // (unmap moved below — unconditional on Success, so a null mapped-range edge can't
        // leave a mapped buffer in the staging pool)

        // Mirror EmscriptenWorker.cpp video_cb's render message: {cmd:'render', x,y,w,h,pixels,pitch}.
        const size_t total = (size_t)c->width * 4 * c->height;
        MAIN_THREAD_EM_ASM({
          var s = $0;
          var view = HEAPU8.subarray(s, s + $3);
          var copy = new Uint8Array(view);
          postMessage({cmd: 'render', x: 0, y: 0, w: $1, h: $2, pixels: copy, pitch: $4},
                      [copy.buffer]);
        }, gfx->m_pixels.data(), (int)c->width, (int)c->height, (int)total, (int)(c->width * 4));
      }
    }
    if (status == WGPUMapAsyncStatus_Success)
      wgpuBufferUnmap(c->buffer);  // idempotent-safe here: mapAsync succeeded => unmap valid
    gfx->m_readback_in_flight--;
    // [staging ring STEP 4 2026-07-09] return the (unmapped) buffer to the pool for reuse;
    // release only on a size-class change (resolution switch) or a full pool.
    if (c->buf_size == gfx->m_readback_pool_buf_size && gfx->m_readback_pool.size() < 3)
      gfx->m_readback_pool.push_back(c->buffer);
    else
      wgpuBufferRelease(c->buffer);
    delete c;
  };
  cb.userdata1 = ctx;
  wgpuBufferMapAsync(rb_buffer, WGPUMapMode_Read, 0, buf_size, cb);
}

bool WGPUGfx::BindBackbuffer(const ClearColor& clear_color)
{
  // [CORRECTED 2026-07-13] "No reachable WebGPU surface" was a FALSE premise (see init notes) —
  // a direct surface present IS available; the readback is a shortcut. The real present happens in
  // ShowImage (reads back the EFB color texture). Nothing to bind here.
  (void)clear_color;
  return true;
}

void WGPUGfx::PresentBackbuffer()
{
  // Present is driven by ShowImage (SupportsUtilityDrawing()==false). No surface to present to.
}

void WGPUGfx::ShowImage(const AbstractTexture* source_texture,
                        const MathUtil::Rectangle<int>& source_rc)
{
  // [WGPU M2-A] Continuous present. SupportsUtilityDrawing()==false routes every frame's Present()
  // into ShowImage (Present.cpp:905) with the XFB copy + rect.
  // [WGPU C1 2026-07-13] Present the XFB SNAPSHOT the game actually presented (source_texture,
  // cropped to source_rc), now that EFB->XFB copies carry real content (native blit in
  // WGPUTextureCache::CopyEFBToCacheEntry). The old code discarded both args and read back the
  // LIVE EFB mid-composite — that was the desaturation/offset-ghost/flood corruption (audit
  // wf_a86451c3). EFB readback remains only as the null-source fallback.

  // Drive the previous frame's pending readback map callback (non-blocking, no emscripten_sleep).
  if (m_instance)
    wgpuInstanceProcessEvents(m_instance);

  ::WGPUTexture present_src = nullptr;  // C handle (not WGPU::WGPUTexture)
  u32 ox = 0, oy = 0;
  u32 w = m_width, h = m_height;
  if (source_texture)
  {
    present_src = static_cast<const WGPUTexture*>(source_texture)->GetTexture();
    const int rc_left = std::max(0, source_rc.left);
    const int rc_top = std::max(0, source_rc.top);
    const int rc_w = std::min<int>(source_rc.right, source_texture->GetWidth()) - rc_left;
    const int rc_h = std::min<int>(source_rc.bottom, source_texture->GetHeight()) - rc_top;
    if (rc_w <= 0 || rc_h <= 0)
      present_src = nullptr;
    else
    {
      ox = static_cast<u32>(rc_left);
      oy = static_cast<u32>(rc_top);
      w = static_cast<u32>(rc_w);
      h = static_cast<u32>(rc_h);
    }
  }
  if (!present_src && g_framebuffer_manager)
  {
    AbstractTexture* efb_color = g_framebuffer_manager->GetEFBColorTexture();
    if (efb_color)
    {
      present_src = static_cast<WGPUTexture*>(efb_color)->GetTexture();
      ox = 0;
      oy = 0;
      w = efb_color->GetWidth();
      h = efb_color->GetHeight();
    }
  }

  static bool s_show_logged = false;
  if (!s_show_logged)
  {
    s_show_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] ShowImage present loop ACTIVE src=' + ($0 ? 'XFB' : 'EFB-fallback')
      + ' rect=' + $1 + 'x' + $2}); }, (int)(source_texture != nullptr), (int)w, (int)h);
  }

  if (present_src)
    ReadbackAndPresent(present_src, ox, oy, w, h);

  // [WGPU-PROF — gated 2026-07-14] The whole avg/60 frame-breakdown block (+ its get_now calls) is
  // behind BEMENTAL_WGPU_PROF: the CPU profile measured get_now at 5.4% of the JIT thread (per-draw
  // + per-CoreTiming.Advance, ~1000/frame). Rebuild with -DBEMENTAL_WGPU_PROF to restore the
  // [wgpu-prof] frame/advance/jit readout. (present time was ~0.5%, dropped from the readout.)
#ifdef BEMENTAL_WGPU_PROF
  {
    const double t_present1 = emscripten_get_now();
    static double s_last = 0, s_acc_period = 0, s_acc_draw_ms = 0, s_acc_load_ms = 0, s_acc_advance = 0;
    static int s_n = 0, s_acc_draws = 0, s_acc_loads = 0;
    const double now = t_present1;
    if (s_last > 0)
    {
      s_acc_period += now - s_last;
      s_acc_draws += s_frame_draws;
      s_acc_draw_ms += s_frame_draw_ms;
      s_acc_load_ms += s_prof_tex_load_ms;
      s_acc_loads += s_prof_tex_loads;
      s_acc_advance += g_prof_advance_ms;
      if (++s_n >= 60)
      {
        MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
          '[wgpu-prof] avg/60: frame=' + $0 + 'ms advance=' + $5 + 'ms jit=' + ($0 - $5)
          + 'ms draws=' + $1 + ' drawRec=' + $2 + 'ms texLoad=' + $3 + 'ms loads=' + $4}); },
          (int)(s_acc_period / 60), (int)(s_acc_draws / 60), (int)(s_acc_draw_ms / 60),
          (int)(s_acc_load_ms / 60), (int)(s_acc_loads / 60), (int)(s_acc_advance / 60));
        s_n = 0; s_acc_period = 0; s_acc_draws = 0; s_acc_draw_ms = 0;
        s_acc_load_ms = 0; s_acc_loads = 0; s_acc_advance = 0;
      }
    }
    s_last = now;
    s_frame_draws = 0;
    s_frame_draw_ms = 0.0;
    s_prof_tex_load_ms = 0.0;
    s_prof_tex_loads = 0;
    g_prof_advance_ms = 0.0;
  }
#endif
}

std::unique_ptr<AbstractTexture> WGPUGfx::CreateTexture(const TextureConfig& config,
                                                        [[maybe_unused]] std::string_view name)
{
  return WGPUTexture::Create(config);
}

std::unique_ptr<AbstractStagingTexture> WGPUGfx::CreateStagingTexture(StagingTextureType type,
                                                                      const TextureConfig& config)
{
  return std::make_unique<WGPUStagingTexture>(type, config);
}

// ---------------------------------------------------------------------------------------------
// Shaders. emdawnwebgpu accepts ONLY WGSL. B1 does NOT translate GLSL->WGSL at runtime: instead
// each stage returns the pre-translated naga ubershader WGSL embedded in WGPUUberShaders.h
// (Vertex -> UBER_VERTEX_WGSL, Pixel -> UBER_FRAGMENT_WGSL, Geometry -> nullptr; geometry shaders
// are reported unsupported so Dolphin never asks). GetBinary() returns the WGSL bytes so Dolphin's
// shader cache round-trips, and CreateShaderFromBinary memcpy's them straight back (no re-xlate).
// ---------------------------------------------------------------------------------------------
class WGPUShader final : public AbstractShader
{
public:
  WGPUShader(ShaderStage stage, WGPUShaderModule module, std::string wgsl)
      : AbstractShader(stage), m_module(module), m_wgsl(std::move(wgsl))
  {
  }
  ~WGPUShader() override
  {
    if (m_module)
      wgpuShaderModuleRelease(m_module);
  }

  WGPUShaderModule GetShaderModule() const { return m_module; }

  BinaryData GetBinary() const override
  {
    return BinaryData(m_wgsl.begin(), m_wgsl.end());
  }

private:
  WGPUShaderModule m_module = nullptr;
  std::string m_wgsl;
};

namespace
{
// Build a real WGPUShaderModule from WGSL and one-shot check compilation-info for errors.
WGPUShaderModule CreateWGSLModule(WGPUDevice device, ShaderStage stage, const std::string& wgsl)
{
  WGPUShaderSourceWGSL src = {};
  src.chain.sType = WGPUSType_ShaderSourceWGSL;
  src.code = {wgsl.data(), wgsl.size()};  // explicit length (not NUL-terminated reliance)

  WGPUShaderModuleDescriptor desc = {};
  desc.nextInChain = &src.chain;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(device, &desc);

  static int s_created_logged = 0;
  if (s_created_logged < 2)  // one-shot per stage (Vertex + Pixel)
  {
    s_created_logged++;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] shader created stage=' + $0 + ' wgsl_bytes=' + $1 + ' module=' + ($2 ? 'OK' : 'NULL')});
    }, (int)stage, (int)wgsl.size(), (int)(mod != nullptr));
  }

  // NOTE: do NOT request compilation-info with a blocking emscripten_sleep pump here.
  // CompileSharedPipelines() runs INSIDE load_iso's ASYNCIFY rewind (see the boot stack), so a
  // nested emscripten_sleep corrupts the unwind — the corruption surfaces as an invalid free in
  // ~WGPUShader ("memory access out of bounds"). The embedded WGSL is pre-validated offline (the
  // device's uncaptured-error callback still surfaces any real compile error asynchronously), so
  // no runtime compilation-info pump is needed. wgpuDeviceCreateShaderModule alone is synchronous.
  return mod;
}
}  // namespace

std::unique_ptr<AbstractShader>
WGPUGfx::CreateShaderFromSource(ShaderStage stage, [[maybe_unused]] std::string_view source,
                                [[maybe_unused]] VideoCommon::ShaderIncluder* shader_includer,
                                [[maybe_unused]] std::string_view name)
{
  // Map stage -> pre-translated uber WGSL. Geometry is unsupported (bSupportsGeometryShaders=false),
  // so Dolphin should never request it; guard anyway.
  std::string wgsl;
  if (stage == ShaderStage::Vertex)
    wgsl.assign(UBER_VERTEX_WGSL, sizeof(UBER_VERTEX_WGSL) - 1);
  else if (stage == ShaderStage::Pixel)
    wgsl.assign(UBER_FRAGMENT_WGSL, sizeof(UBER_FRAGMENT_WGSL) - 1);
  else
    return nullptr;  // Geometry/Compute not provided in B1

  if (!m_device)
    return std::make_unique<WGPUShader>(stage, nullptr, std::move(wgsl));

  WGPUShaderModule mod = CreateWGSLModule(m_device, stage, wgsl);
  return std::make_unique<WGPUShader>(stage, mod, std::move(wgsl));
}

std::unique_ptr<AbstractShader>
WGPUGfx::CreateShaderFromBinary(ShaderStage stage, const void* data, size_t length,
                                [[maybe_unused]] std::string_view name)
{
  // The cache stores the WGSL bytes GetBinary() returned; memcpy them back and recreate the module
  // (no re-translation). If the cache is empty/short fall back to the embedded uber WGSL.
  std::string wgsl;
  if (data && length > 0)
    wgsl.assign(static_cast<const char*>(data), length);
  else if (stage == ShaderStage::Vertex)
    wgsl.assign(UBER_VERTEX_WGSL, sizeof(UBER_VERTEX_WGSL) - 1);
  else if (stage == ShaderStage::Pixel)
    wgsl.assign(UBER_FRAGMENT_WGSL, sizeof(UBER_FRAGMENT_WGSL) - 1);
  else
    return nullptr;

  if (!m_device)
    return std::make_unique<WGPUShader>(stage, nullptr, std::move(wgsl));

  WGPUShaderModule mod = CreateWGSLModule(m_device, stage, wgsl);
  return std::make_unique<WGPUShader>(stage, mod, std::move(wgsl));
}

// ---------------------------------------------------------------------------------------------
// Shared uber bind-group-layouts + pipeline-layout (the cross-cutting WebGPU contract). WebGPU has
// NO push constants and RIGID layouts — the @group/@binding decorations in the uber WGSL dictate
// everything. We build EXPLICIT layouts that match the WGSL (see WGPUUberShaders.h header comment):
//   group 0: binding 0 = PSBlock uniform (Fragment), binding 1 = VSBlock uniform (Vertex)
//            both buffer.type=Uniform, hasDynamicOffset=true (Dolphin uses dynamic UBO offsets)
//   group 1: binding 0..7  = texture_2d_array<f32> (Fragment), sampleType=Float, viewDim=2DArray
//            binding 8..15 = sampler               (Fragment), type=Filtering
// NOTE: with dynamic-sampler-indexing OFF the uber WGSL declares 8 SEPARATE scalar texture +
// 8 separate scalar sampler bindings (NO binding_array / no sized_binding_array language feature),
// so the layout is 16 plain entries -- no bindingArraySize, no device feature required.
// ---------------------------------------------------------------------------------------------
WGPUPipelineLayout WGPUGfx::GetUberPipelineLayout()
{
  if (m_uber_pipeline_layout)
    return m_uber_pipeline_layout;
  if (m_uber_layout_tried || !m_device)
    return m_uber_pipeline_layout;  // already failed once; don't re-spam device errors
  m_uber_layout_tried = true;

  // --- Group 0: uniform blocks (VS @binding(1), PS @binding(0)) ---
  std::array<WGPUBindGroupLayoutEntry, 2> g0 = {};
  g0[0].binding = 0;  // PSBlock
  g0[0].visibility = WGPUShaderStage_Fragment;
  g0[0].buffer.type = WGPUBufferBindingType_Uniform;
  g0[0].buffer.hasDynamicOffset = true;
  g0[1].binding = 1;  // VSBlock
  g0[1].visibility = WGPUShaderStage_Vertex;
  g0[1].buffer.type = WGPUBufferBindingType_Uniform;
  g0[1].buffer.hasDynamicOffset = true;

  WGPUBindGroupLayoutDescriptor g0_desc = {};
  g0_desc.entryCount = g0.size();
  g0_desc.entries = g0.data();
  m_uber_bgl_uniforms = wgpuDeviceCreateBindGroupLayout(m_device, &g0_desc);

  // --- Group 1: 8 separate scalar textures (binding 0..7) + 8 separate scalar samplers
  //     (binding 8..15), all Fragment. Matches the uber WGSL's samp_tex0..7 / samp_smp0..7
  //     (dynamic-sampler-indexing OFF => no binding_array). ---
  std::array<WGPUBindGroupLayoutEntry, 16> g1 = {};
  for (uint32_t i = 0; i < 8; i++)
  {
    g1[i].binding = i;  // samp_texN : texture_2d_array<f32>
    g1[i].visibility = WGPUShaderStage_Fragment;
    g1[i].texture.sampleType = WGPUTextureSampleType_Float;
    g1[i].texture.viewDimension = WGPUTextureViewDimension_2DArray;
    g1[i].texture.multisampled = false;
  }
  for (uint32_t i = 0; i < 8; i++)
  {
    g1[8 + i].binding = 8 + i;  // samp_smpN : sampler
    g1[8 + i].visibility = WGPUShaderStage_Fragment;
    g1[8 + i].sampler.type = WGPUSamplerBindingType_Filtering;
  }

  WGPUBindGroupLayoutDescriptor g1_desc = {};
  g1_desc.entryCount = g1.size();
  g1_desc.entries = g1.data();
  m_uber_bgl_textures = wgpuDeviceCreateBindGroupLayout(m_device, &g1_desc);

  std::array<WGPUBindGroupLayout, 2> bgls = {m_uber_bgl_uniforms, m_uber_bgl_textures};
  WGPUPipelineLayoutDescriptor pl_desc = {};
  pl_desc.bindGroupLayoutCount = bgls.size();
  pl_desc.bindGroupLayouts = bgls.data();
  m_uber_pipeline_layout = wgpuDeviceCreatePipelineLayout(m_device, &pl_desc);

  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
    '[wgpu] uber pipeline-layout built (16 scalar tex/samp, NO binding_array): bgl0(uniforms)='
    + ($0 ? 'OK' : 'NULL') + ' bgl1(tex/samp)=' + ($1 ? 'OK' : 'NULL') + ' layout='
    + ($2 ? 'OK' : 'NULL')}); },
    (int)(m_uber_bgl_uniforms != nullptr), (int)(m_uber_bgl_textures != nullptr),
    (int)(m_uber_pipeline_layout != nullptr));

  return m_uber_pipeline_layout;
}

// ---------------------------------------------------------------------------------------------
// Pipelines. Port of VKPipeline::Create. Builds a real WGPURenderPipeline from
// AbstractPipelineConfig (RenderState.h). Color target = EFB color (RGBA8Unorm); depth =
// Depth32Float. The vertex buffer layout covers ALL uber-VS @location inputs (WebGPU requires every
// shader-consumed location be present in the layout; B2 wires the real vertex buffer/draws).
// ---------------------------------------------------------------------------------------------
namespace
{
WGPUCompareFunction MapCompare(CompareMode m, bool inverted)
{
  switch (m)
  {
  case CompareMode::Never:   return WGPUCompareFunction_Never;
  case CompareMode::Less:    return inverted ? WGPUCompareFunction_Greater : WGPUCompareFunction_Less;
  case CompareMode::Equal:   return WGPUCompareFunction_Equal;
  case CompareMode::LEqual:
    return inverted ? WGPUCompareFunction_GreaterEqual : WGPUCompareFunction_LessEqual;
  case CompareMode::Greater: return inverted ? WGPUCompareFunction_Less : WGPUCompareFunction_Greater;
  case CompareMode::NEqual:  return WGPUCompareFunction_NotEqual;
  case CompareMode::GEqual:
    return inverted ? WGPUCompareFunction_LessEqual : WGPUCompareFunction_GreaterEqual;
  case CompareMode::Always:  return WGPUCompareFunction_Always;
  default:                   return WGPUCompareFunction_Always;
  }
}

// [WGPU C1 2026-07-13] use_dual_src: the uber pixel shader ALWAYS emits @blend_src(0)/(1) dual
// outputs (ocol0/ocol1, GC dst-alpha), so when the blend state selects SrcAlpha/InvSrcAlpha it
// means ocol1's alpha (Src1Alpha) — mirroring VKPipeline.cpp. Without this every dst-alpha
// blended draw used ocol0's alpha (wrong constant).
WGPUBlendFactor MapSrcFactor(SrcBlendFactor f, bool use_dual_src)
{
  switch (f)
  {
  case SrcBlendFactor::Zero:        return WGPUBlendFactor_Zero;
  case SrcBlendFactor::One:         return WGPUBlendFactor_One;
  case SrcBlendFactor::DstClr:      return WGPUBlendFactor_Dst;
  case SrcBlendFactor::InvDstClr:   return WGPUBlendFactor_OneMinusDst;
  case SrcBlendFactor::SrcAlpha:
    return use_dual_src ? WGPUBlendFactor_Src1Alpha : WGPUBlendFactor_SrcAlpha;
  case SrcBlendFactor::InvSrcAlpha:
    return use_dual_src ? WGPUBlendFactor_OneMinusSrc1Alpha : WGPUBlendFactor_OneMinusSrcAlpha;
  case SrcBlendFactor::DstAlpha:    return WGPUBlendFactor_DstAlpha;
  case SrcBlendFactor::InvDstAlpha: return WGPUBlendFactor_OneMinusDstAlpha;
  default:                          return WGPUBlendFactor_One;
  }
}

WGPUBlendFactor MapDstFactor(DstBlendFactor f, bool use_dual_src)
{
  switch (f)
  {
  case DstBlendFactor::Zero:        return WGPUBlendFactor_Zero;
  case DstBlendFactor::One:         return WGPUBlendFactor_One;
  case DstBlendFactor::SrcClr:      return WGPUBlendFactor_Src;
  case DstBlendFactor::InvSrcClr:   return WGPUBlendFactor_OneMinusSrc;
  case DstBlendFactor::SrcAlpha:
    return use_dual_src ? WGPUBlendFactor_Src1Alpha : WGPUBlendFactor_SrcAlpha;
  case DstBlendFactor::InvSrcAlpha:
    return use_dual_src ? WGPUBlendFactor_OneMinusSrc1Alpha : WGPUBlendFactor_OneMinusSrcAlpha;
  case DstBlendFactor::DstAlpha:    return WGPUBlendFactor_DstAlpha;
  case DstBlendFactor::InvDstAlpha: return WGPUBlendFactor_OneMinusDstAlpha;
  default:                          return WGPUBlendFactor_Zero;
  }
}
}  // namespace

class WGPUPipeline final : public AbstractPipeline
{
public:
  WGPUPipeline(const AbstractPipelineConfig& config, WGPURenderPipeline pipeline)
      : AbstractPipeline(config), m_pipeline(pipeline)
  {
  }
  ~WGPUPipeline() override
  {
    if (m_pipeline)
      wgpuRenderPipelineRelease(m_pipeline);
  }
  WGPURenderPipeline GetPipeline() const { return m_pipeline; }

private:
  WGPURenderPipeline m_pipeline = nullptr;
};

// ---------------------------------------------------------------------------------------------
// Draw path (B2). WGPUGfx owns the bound pipeline + per-slot texture/sampler state + the render
// pass, so DrawIndexed records the draw here. The vertex manager (WGPUVertexManager) owns the
// vertex/index/uniform buffers and passes them + the dynamic uniform offsets in. (Defined after
// WGPUPipeline so SetPipeline can read its WGPURenderPipeline handle.)
// ---------------------------------------------------------------------------------------------

void WGPUGfx::SetPipeline(const AbstractPipeline* pipeline)
{
  // Mirror VKGfx::SetPipeline storing the current pipeline (VertexManagerBase also tracks the
  // AbstractPipeline*, but DrawIndexed needs the raw WGPURenderPipeline handle).
  m_current_pipeline =
      pipeline ? static_cast<const WGPUPipeline*>(pipeline)->GetPipeline() : nullptr;
}

void WGPUGfx::SetTexture(u32 index, const AbstractTexture* texture)
{
  if (index >= 8)
    return;
  WGPUTextureView prev = m_bound_texture_views[index];
  if (texture)
  {
    // GetBindingView() lazily builds a 2DArray view (the uber fragment layout's view dimension).
    auto* tex = const_cast<WGPUTexture*>(static_cast<const WGPUTexture*>(texture));
    m_bound_texture_views[index] = tex->GetBindingView();
  }
  else
  {
    m_bound_texture_views[index] = nullptr;  // DrawIndexed substitutes the dummy view
  }
  if (m_bound_texture_views[index] != prev)
    m_grp1_dirty = true;  // [WGPU C3] slot changed -> next draw rebuilds GROUP1
}

namespace
{
WGPUAddressMode MapWrap(WrapMode m)
{
  switch (static_cast<u32>(m))
  {
  case 0:  return WGPUAddressMode_ClampToEdge;   // Clamp
  case 1:  return WGPUAddressMode_Repeat;         // Repeat
  case 2:  return WGPUAddressMode_MirrorRepeat;   // Mirror
  default: return WGPUAddressMode_ClampToEdge;     // invalid (== clamp on HW)
  }
}
WGPUFilterMode MapFilter(FilterMode m)
{
  return static_cast<u32>(m) == 1 ? WGPUFilterMode_Linear : WGPUFilterMode_Nearest;  // 1=Linear
}
WGPUMipmapFilterMode MapMipFilter(FilterMode m)
{
  return static_cast<u32>(m) == 1 ? WGPUMipmapFilterMode_Linear : WGPUMipmapFilterMode_Nearest;
}
}  // namespace

void WGPUGfx::SetSamplerState(u32 index, const SamplerState& state)
{
  if (index >= 8 || !m_device)
    return;

  // [WGPU C4 2026-07-14] Cache by SamplerState::Hex() — the same (filter,wrap,lod) combo recurs
  // across nearly every draw, so wgpuDeviceCreateSampler-per-call was 1.5% of the JIT thread.
  const uint64_t key = state.Hex();
  WGPUSampler samp;
  auto it = m_sampler_cache.find(key);
  if (it != m_sampler_cache.end())
  {
    samp = it->second;
  }
  else
  {
    // Port of ObjectCache::GetSampler (SamplerState -> sampler). NO mipLodBias field on
    // WGPUSamplerDescriptor (dropped); compare left Undefined (non-comparison sampler).
    WGPUSamplerDescriptor desc = {};
    desc.addressModeU = MapWrap(state.tm0.wrap_u.Value());
    desc.addressModeV = MapWrap(state.tm0.wrap_v.Value());
    desc.addressModeW = WGPUAddressMode_ClampToEdge;
    desc.magFilter = MapFilter(state.tm0.mag_filter.Value());
    desc.minFilter = MapFilter(state.tm0.min_filter.Value());
    desc.mipmapFilter = MapMipFilter(state.tm0.mipmap_filter.Value());
    desc.lodMinClamp = state.tm1.min_lod / 16.0f;
    desc.lodMaxClamp = state.tm1.max_lod / 16.0f;
    desc.compare = WGPUCompareFunction_Undefined;
    desc.maxAnisotropy = 1;
    samp = wgpuDeviceCreateSampler(m_device, &desc);
    m_sampler_cache[key] = samp;
  }

  if (m_bound_samplers[index] != samp)
  {
    m_bound_samplers[index] = samp;  // non-owning ref; cache owns it
    m_grp1_dirty = true;             // [WGPU C3] slot changed -> next draw rebuilds GROUP1
  }
}

void WGPUGfx::UnbindTexture(const AbstractTexture* texture)
{
  if (!texture)
    return;
  auto* tex = const_cast<WGPUTexture*>(static_cast<const WGPUTexture*>(texture));
  WGPUTextureView view = tex->GetBindingView();
  for (u32 i = 0; i < 8; i++)
  {
    if (m_bound_texture_views[i] == view)
    {
      m_bound_texture_views[i] = nullptr;
      m_grp1_dirty = true;  // [WGPU C3] a cached GROUP1 referencing this view is now stale
    }
  }
}

void WGPUGfx::EnsureDummyResources()
{
  if (m_dummy_texture_view && m_dummy_sampler)
    return;
  if (!m_device)
    return;

  if (!m_dummy_texture)
  {
    // 1x1x1 float texture; bound (as a 2DArray view) into any GROUP1 texture slot the draw didn't
    // fill. RGBA8Unorm matches WGPUTextureSampleType_Float in the layout.
    WGPUTextureDescriptor td = {};
    td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    td.dimension = WGPUTextureDimension_2D;
    td.size = {1, 1, 1};
    td.format = WGPUTextureFormat_RGBA8Unorm;
    td.mipLevelCount = 1;
    td.sampleCount = 1;
    m_dummy_texture = wgpuDeviceCreateTexture(m_device, &td);
  }
  if (m_dummy_texture && !m_dummy_texture_view)
  {
    WGPUTextureViewDescriptor vd = {};
    vd.format = WGPUTextureFormat_RGBA8Unorm;
    vd.dimension = WGPUTextureViewDimension_2DArray;
    vd.baseMipLevel = 0;
    vd.mipLevelCount = 1;
    vd.baseArrayLayer = 0;
    vd.arrayLayerCount = 1;
    vd.aspect = WGPUTextureAspect_All;
    m_dummy_texture_view = wgpuTextureCreateView(m_dummy_texture, &vd);
  }
  if (!m_dummy_sampler)
  {
    WGPUSamplerDescriptor sd = {};
    sd.addressModeU = WGPUAddressMode_ClampToEdge;
    sd.addressModeV = WGPUAddressMode_ClampToEdge;
    sd.addressModeW = WGPUAddressMode_ClampToEdge;
    sd.magFilter = WGPUFilterMode_Nearest;
    sd.minFilter = WGPUFilterMode_Nearest;
    sd.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    sd.lodMinClamp = 0.0f;
    sd.lodMaxClamp = 0.0f;
    sd.compare = WGPUCompareFunction_Undefined;
    sd.maxAnisotropy = 1;
    m_dummy_sampler = wgpuDeviceCreateSampler(m_device, &sd);
  }
}

void WGPUGfx::DrawIndexed(WGPUBuffer vertex_buffer, WGPUBuffer index_buffer,
                          WGPUBuffer uniform_buffer, u32 vs_uniform_offset, u32 ps_uniform_offset,
                          u32 num_indices, u32 base_index, u32 base_vertex)
{
  if (!m_device || !m_current_pipeline || !vertex_buffer || !index_buffer || !uniform_buffer ||
      num_indices == 0)
  {
    return;
  }
#ifdef BEMENTAL_WGPU_PROF
  const double t_draw0 = emscripten_get_now();  // [WGPU-PROF — gated; per-draw get_now, ~247/frame]
#endif

  // Ensure a render pass is open on the bound framebuffer (the EFB). loadOp=Load preserves the
  // earlier SetAndClearFramebuffer clear.
  BeginRenderPassIfNeeded();
  if (!m_pass)
    return;

  EnsureDummyResources();

  // --- GROUP0: VS + PS uniform blocks, bound as the WHOLE buffer with per-draw dynamic offsets.
  // [WGPU C3 2026-07-13] CACHED: identical every draw (same buffer, layout, block sizes; the
  // dynamic offset is passed to SetBindGroup below, not baked in). Rebuild only if the uniform
  // buffer handle changes (never in steady state). ---
  if (!m_cached_grp0 || m_cached_grp0_buffer != uniform_buffer)
  {
    if (m_cached_grp0)
      wgpuBindGroupRelease(m_cached_grp0);
    WGPUBindGroupEntry g0_entries[2] = {};
    g0_entries[0].binding = 0;  // PSBlock
    g0_entries[0].buffer = uniform_buffer;
    g0_entries[0].offset = 0;  // base; the dynamic offset selects the block
    g0_entries[0].size = sizeof(PixelShaderConstants);
    g0_entries[1].binding = 1;  // VSBlock
    g0_entries[1].buffer = uniform_buffer;
    g0_entries[1].offset = 0;
    g0_entries[1].size = sizeof(VertexShaderConstants);
    WGPUBindGroupDescriptor g0_desc = {};
    g0_desc.layout = m_uber_bgl_uniforms;
    g0_desc.entryCount = 2;
    g0_desc.entries = g0_entries;
    m_cached_grp0 = wgpuDeviceCreateBindGroup(m_device, &g0_desc);
    m_cached_grp0_buffer = uniform_buffer;
  }
  WGPUBindGroup grp0 = m_cached_grp0;

  // --- GROUP1: 8 textures (binding 0..7) + 8 samplers (binding 8..15). EVERY entry must be
  // present; fill unbound slots with the dummy view/sampler.
  // [WGPU C3 2026-07-13] CACHED: rebuilt only when a texture/sampler slot changed (m_grp1_dirty,
  // set by SetTexture/SetSamplerState/UnbindTexture). ---
  if (m_grp1_dirty || !m_cached_grp1)
  {
    if (m_cached_grp1)
      wgpuBindGroupRelease(m_cached_grp1);
    WGPUBindGroupEntry g1_entries[16] = {};
    for (u32 i = 0; i < 8; i++)
    {
      g1_entries[i].binding = i;
      g1_entries[i].textureView =
          m_bound_texture_views[i] ? m_bound_texture_views[i] : m_dummy_texture_view;
    }
    for (u32 i = 0; i < 8; i++)
    {
      g1_entries[8 + i].binding = 8 + i;
      g1_entries[8 + i].sampler = m_bound_samplers[i] ? m_bound_samplers[i] : m_dummy_sampler;
    }
    WGPUBindGroupDescriptor g1_desc = {};
    g1_desc.layout = m_uber_bgl_textures;
    g1_desc.entryCount = 16;
    g1_desc.entries = g1_entries;
    m_cached_grp1 = wgpuDeviceCreateBindGroup(m_device, &g1_desc);
    m_grp1_dirty = false;
  }
  WGPUBindGroup grp1 = m_cached_grp1;

  if (!m_draw_logged)
  {
    m_draw_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] draw bind groups built grp0=' + ($0 ? 'OK' : 'NULL') + ' grp1=' + ($1 ? 'OK' : 'NULL')
      + ' (cached)'});
    }, (int)(grp0 != nullptr), (int)(grp1 != nullptr));
  }

  if (grp0 && grp1)
  {
    wgpuRenderPassEncoderSetPipeline(m_pass, m_current_pipeline);
    wgpuRenderPassEncoderSetVertexBuffer(m_pass, 0, vertex_buffer, 0, WGPU_WHOLE_SIZE);
    wgpuRenderPassEncoderSetIndexBuffer(m_pass, index_buffer, WGPUIndexFormat_Uint16, 0,
                                        WGPU_WHOLE_SIZE);
    // Dynamic offsets ordered by ascending binding: [PS@0, VS@1].
    const uint32_t dyn_offsets[2] = {ps_uniform_offset, vs_uniform_offset};
    wgpuRenderPassEncoderSetBindGroup(m_pass, 0, grp0, 2, dyn_offsets);
    wgpuRenderPassEncoderSetBindGroup(m_pass, 1, grp1, 0, nullptr);
    wgpuRenderPassEncoderDrawIndexed(m_pass, num_indices, 1, base_index,
                                     static_cast<int32_t>(base_vertex), 0);
  }

  // [WGPU C3] grp0/grp1 are cache-owned now — NOT released per-draw (the encoder takes its own
  // ref at SetBindGroup; the cache holds the persistent ref, freed on invalidation / dtor).

#ifdef BEMENTAL_WGPU_PROF
  s_frame_draws++;
  s_frame_draw_ms += emscripten_get_now() - t_draw0;
#endif
}

std::unique_ptr<AbstractPipeline> WGPUGfx::CreatePipeline(const AbstractPipelineConfig& config,
                                                          [[maybe_unused]] const void* cache_data,
                                                          [[maybe_unused]] size_t cache_data_length)
{
  if (!m_device)
    return std::make_unique<WGPUPipeline>(config, nullptr);

  const auto* vs = static_cast<const WGPUShader*>(config.vertex_shader);
  const auto* ps = static_cast<const WGPUShader*>(config.pixel_shader);
  if (!vs || !ps || !vs->GetShaderModule() || !ps->GetShaderModule())
  {
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] CreatePipeline: missing shader module (vs=' + $0 + ' ps=' + $1 + ')'}); },
      (int)(vs && vs->GetShaderModule()), (int)(ps && ps->GetShaderModule()));
    return std::make_unique<WGPUPipeline>(config, nullptr);
  }

  WGPUPipelineLayout layout = GetUberPipelineLayout();

  // --- Vertex buffer layout (B2). Use the real WGPUNativeVertexFormat layout built from the
  // PortableVertexDeclaration (WGPUVertexManager.cpp), so the pipeline's vertex inputs match the
  // exact set/types/offsets the vertex loader streamed AND the uber VS @location signature. WebGPU
  // requires every shader-consumed location be present in the layout; the uber VS guards its inputs
  // with `if (has_attrib)` so a layout that omits an unused attribute is valid (Vulkan does the
  // same — it only declares enabled attributes). ---
  const auto* vtx_format = static_cast<const WGPUVertexFormat*>(config.vertex_format);
  WGPUVertexState vertex = {};
  vertex.module = vs->GetShaderModule();
  vertex.entryPoint = {"main", 4};
  // GetVertexBufferLayout() returns a layout whose .attributes points into the format's owned
  // vector (stable beyond this synchronous create call). Take a copy of the small struct; the
  // pipeline descriptor reads it only during wgpuDeviceCreateRenderPipeline below.
  WGPUVertexBufferLayout vbl = {};
  if (vtx_format)
  {
    vbl = vtx_format->GetVertexBufferLayout();
  }
  else
  {
    // Utility/blit pipelines have no GX vertex format, but B1 pairs every vertex shader with the
    // uber VS (which declares 15 inputs). WebGPU requires every shader @location be present in the
    // vertex state, so give these a 15-attribute placeholder layout (locations 0-6, 8-15; never
    // drawn — these pipelines are bypassed). Base types match the uber VS: posmtx@1 = vec4<u32>
    // (uint), all others vec*<f32>.
    static WGPUVertexAttribute s_ph_attrs[15];
    static const WGPUVertexBufferLayout s_ph_layout = [] {
      const int locs[15] = {0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15};
      for (int i = 0; i < 15; i++)
      {
        s_ph_attrs[i] = {};
        s_ph_attrs[i].shaderLocation = static_cast<u32>(locs[i]);
        s_ph_attrs[i].offset = 0;
        s_ph_attrs[i].format =
            (locs[i] == 1) ? WGPUVertexFormat_Uint8x4 : WGPUVertexFormat_Unorm8x4;
      }
      WGPUVertexBufferLayout l = {};
      l.stepMode = WGPUVertexStepMode_Vertex;
      l.arrayStride = 16;
      l.attributeCount = 15;
      l.attributes = s_ph_attrs;
      return l;
    }();
    vbl = s_ph_layout;
  }
  vertex.bufferCount = 1;
  vertex.buffers = &vbl;

  // --- Primitive (topology / cull / front-face). GameCube front faces are CW. ---
  static constexpr std::array<WGPUPrimitiveTopology, 4> kTopo = {
      WGPUPrimitiveTopology_PointList, WGPUPrimitiveTopology_LineList,
      WGPUPrimitiveTopology_TriangleList, WGPUPrimitiveTopology_TriangleStrip};
  WGPUPrimitiveState primitive = {};
  primitive.topology = kTopo[(u32)config.rasterization_state.primitive.Value()];
  primitive.frontFace = WGPUFrontFace_CW;
  switch (config.rasterization_state.cull_mode.Value())
  {
  case CullMode::None: primitive.cullMode = WGPUCullMode_None; break;
  case CullMode::Back: primitive.cullMode = WGPUCullMode_Back; break;
  case CullMode::Front: primitive.cullMode = WGPUCullMode_Front; break;
  default: primitive.cullMode = WGPUCullMode_None; break;  // All -> handled in shader; no native
  }
  if (primitive.topology == WGPUPrimitiveTopology_TriangleStrip ||
      primitive.topology == WGPUPrimitiveTopology_LineStrip)
    primitive.stripIndexFormat = WGPUIndexFormat_Uint16;

  // --- Depth/stencil (Depth32Float). depthWriteEnabled is WGPUOptionalBool; test-disable is
  // emulated as depthCompare=Always (WebGPU has no separate depth-test-enable). ---
  WGPUDepthStencilState depth = {};
  depth.format = WGPUTextureFormat_Depth32Float;
  depth.depthWriteEnabled =
      config.depth_state.update_enable ? WGPUOptionalBool_True : WGPUOptionalBool_False;
  // [WGPU C1 2026-07-13] bSupportsReversedDepthRange=false (WebGPU forbids reversed viewport
  // depth) -> VideoCommon uses the reverse-Z 1-z remap, so Less/Greater swap here — mirrors
  // D3DState.cpp:500 "Less/greater are swapped due to inverted depth".
  const bool inverted_depth = true;
  depth.depthCompare = config.depth_state.test_enable
                           ? MapCompare(config.depth_state.func.Value(), inverted_depth)
                           : WGPUCompareFunction_Always;
  // No stencil aspect in Depth32Float; WebGPU wants the disabled-stencil canonical form
  // (compare=Always, all ops=Keep) on both faces, not the zero/Undefined default.
  depth.stencilFront = {WGPUCompareFunction_Always, WGPUStencilOperation_Keep,
                        WGPUStencilOperation_Keep, WGPUStencilOperation_Keep};
  depth.stencilBack = {WGPUCompareFunction_Always, WGPUStencilOperation_Keep,
                       WGPUStencilOperation_Keep, WGPUStencilOperation_Keep};

  // --- Blend / color target (RGBA8Unorm EFB color). ---
  WGPUBlendState blend = {};
  blend.color.operation =
      config.blending_state.subtract ? WGPUBlendOperation_ReverseSubtract : WGPUBlendOperation_Add;
  const bool use_dual_src = config.blending_state.use_dual_src;
  blend.color.srcFactor = MapSrcFactor(config.blending_state.src_factor.Value(), use_dual_src);
  blend.color.dstFactor = MapDstFactor(config.blending_state.dst_factor.Value(), use_dual_src);
  blend.alpha.operation = config.blending_state.subtract_alpha ? WGPUBlendOperation_ReverseSubtract
                                                               : WGPUBlendOperation_Add;
  // Alpha component uses the dual-src factor tables too — mirrors VKPipeline.cpp:162-164.
  blend.alpha.srcFactor =
      MapSrcFactor(config.blending_state.src_factor_alpha.Value(), use_dual_src);
  blend.alpha.dstFactor =
      MapDstFactor(config.blending_state.dst_factor_alpha.Value(), use_dual_src);

  WGPUColorWriteMask write_mask = WGPUColorWriteMask_None;
  if (config.blending_state.color_update)
    write_mask |= WGPUColorWriteMask_Red | WGPUColorWriteMask_Green | WGPUColorWriteMask_Blue;
  if (config.blending_state.alpha_update)
    write_mask |= WGPUColorWriteMask_Alpha;

  WGPUColorTargetState color_target = {};
  color_target.format = WGPUTextureFormat_RGBA8Unorm;
  color_target.blend = config.blending_state.blend_enable ? &blend : nullptr;
  color_target.writeMask = write_mask;

  WGPUFragmentState fragment = {};
  fragment.module = ps->GetShaderModule();
  fragment.entryPoint = {"main", 4};
  fragment.targetCount = 1;
  fragment.targets = &color_target;

  // --- Assemble. ---
  WGPURenderPipelineDescriptor pd = {};
  pd.layout = layout;  // explicit uber layout (NOT auto) so it matches the multi-group uber WGSL
  pd.vertex = vertex;
  pd.primitive = primitive;
  pd.depthStencil = &depth;
  pd.multisample.count = config.framebuffer_state.samples ? config.framebuffer_state.samples : 1;
  pd.multisample.mask = 0xFFFFFFFF;
  pd.fragment = &fragment;

  WGPURenderPipeline pipeline = wgpuDeviceCreateRenderPipeline(m_device, &pd);

  static int s_pipeline_logged = 0;
  if (s_pipeline_logged < 4)  // one-shot-ish (first few pipelines)
  {
    s_pipeline_logged++;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] pipeline created topo=' + $0 + ' layout=' + ($1 ? 'OK' : 'NULL')
      + ' pipeline=' + ($2 ? 'OK' : 'NULL')}); },
      (int)primitive.topology, (int)(layout != nullptr), (int)(pipeline != nullptr));
  }

  return std::make_unique<WGPUPipeline>(config, pipeline);
}

std::unique_ptr<AbstractFramebuffer>
WGPUGfx::CreateFramebuffer(AbstractTexture* color_attachment, AbstractTexture* depth_attachment,
                           std::vector<AbstractTexture*> additional_color_attachments)
{
  return WGPUFramebuffer::Create(static_cast<WGPUTexture*>(color_attachment),
                                 static_cast<WGPUTexture*>(depth_attachment),
                                 std::move(additional_color_attachments));
}

std::unique_ptr<NativeVertexFormat>
WGPUGfx::CreateNativeVertexFormat(const PortableVertexDeclaration& vtx_decl)
{
  return std::make_unique<WGPUVertexFormat>(vtx_decl);
}

void WGPUEFBInterface::ReinterpretPixelData(EFBReinterpretType convtype)
{
}

void WGPUEFBInterface::PokeColor(u16 x, u16 y, u32 color)
{
}

void WGPUEFBInterface::PokeDepth(u16 x, u16 y, u32 depth)
{
}

u32 WGPUEFBInterface::PeekColorInternal(u16 x, u16 y)
{
  return 0;
}

u32 WGPUEFBInterface::PeekDepthInternal(u16 x, u16 y)
{
  return 0;
}

}  // namespace WGPU
