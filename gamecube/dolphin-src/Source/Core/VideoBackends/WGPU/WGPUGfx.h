// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

// emdawnwebgpu exposes emscripten_webgpu_get_device() directly in webgpu.h (line ~2235);
// the legacy <emscripten/html5_webgpu.h> is incompatible (it references the removed WGPUSwapChain).
#include <webgpu/webgpu.h>

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "Common/CommonTypes.h"
#include "Common/WindowSystemInfo.h"

#include "VideoCommon/AbstractGfx.h"
#include "VideoCommon/EFBInterface.h"

namespace WGPU
{
class WGPUFramebuffer;

class WGPUGfx final : public AbstractGfx
{
public:
  explicit WGPUGfx(const WindowSystemInfo& wsi);
  ~WGPUGfx() override;

  // Mirror the Vulkan backend's accessor so WGPUTexture/WGPUFramebuffer Create paths can reach
  // the device/queue (the only WGPUGfx instance is the live g_gfx).
  static WGPUGfx* GetInstance() { return static_cast<WGPUGfx*>(g_gfx.get()); }
  WGPUDevice GetDevice() const { return m_device; }
  WGPUQueue GetQueue() const { return m_queue; }

  // [WGPU-PROF — TEMP] texture-upload accumulation: WGPUTexture::Load adds, ShowImage reads+resets.
  static double s_prof_tex_load_ms;
  static int s_prof_tex_loads;

  bool IsHeadless() const override;
  bool SupportsUtilityDrawing() const override;

  std::unique_ptr<AbstractTexture> CreateTexture(const TextureConfig& config,
                                                 std::string_view name) override;
  std::unique_ptr<AbstractStagingTexture>
  CreateStagingTexture(StagingTextureType type, const TextureConfig& config) override;
  std::unique_ptr<AbstractFramebuffer>
  CreateFramebuffer(AbstractTexture* color_attachment, AbstractTexture* depth_attachment,
                    std::vector<AbstractTexture*> additional_color_attachments) override;

  std::unique_ptr<AbstractShader>
  CreateShaderFromSource(ShaderStage stage, std::string_view source,
                         VideoCommon::ShaderIncluder* shader_includer,
                         std::string_view name) override;
  std::unique_ptr<AbstractShader> CreateShaderFromBinary(ShaderStage stage, const void* data,
                                                         size_t length,
                                                         std::string_view name) override;
  std::unique_ptr<NativeVertexFormat>
  CreateNativeVertexFormat(const PortableVertexDeclaration& vtx_decl) override;
  std::unique_ptr<AbstractPipeline> CreatePipeline(const AbstractPipelineConfig& config,
                                                   const void* cache_data = nullptr,
                                                   size_t cache_data_length = 0) override;

  SurfaceInfo GetSurfaceInfo() const override;

  // Render-pass ownership (the M2-A crux). WebGPU couples a render-pass encoder to a specific
  // framebuffer's attachments, so WGPUGfx owns a per-frame command encoder + the currently-open
  // render pass + the currently-bound framebuffer. A copy (copyTextureToBuffer/Texture) cannot run
  // with a pass open, so EndRenderPass()/SubmitFrame() are the seams the present path drives.
  void SetFramebuffer(AbstractFramebuffer* framebuffer) override;
  void SetAndDiscardFramebuffer(AbstractFramebuffer* framebuffer) override;
  void SetAndClearFramebuffer(AbstractFramebuffer* framebuffer, const ClearColor& color_value = {},
                              float depth_value = 0.0f) override;

  // Ends the open render pass (if any) and submits the current command encoder. Public so the
  // present/copy paths can flush GPU work before a texture-to-buffer readback.
  void EndRenderPass();
  void SubmitFrame();

  // --- Draw state (B2). The vertex manager owns the vertex/index/uniform buffers; WGPUGfx owns the
  // bound pipeline + per-slot texture/sampler state + the render pass, so the actual draw recording
  // (bind-group assembly + DrawIndexed) lives here. ---
  void SetPipeline(const AbstractPipeline* pipeline) override;
  void SetTexture(u32 index, const AbstractTexture* texture) override;
  void SetSamplerState(u32 index, const SamplerState& state) override;
  void UnbindTexture(const AbstractTexture* texture) override;

  // [WGPU C1 2026-07-13] Viewport/scissor. WebGPU pass state resets on every BeginRenderPass, so
  // cache the values here and (re)apply them whenever a pass is (re)opened. Without these
  // overrides every draw rasterized with the full-EFB default viewport and no scissor.
  void SetViewport(float x, float y, float width, float height, float near_depth,
                   float far_depth) override;
  void SetScissorRect(const MathUtil::Rectangle<int>& rc) override;

  // [WGPU C1 2026-07-13] Native EFB clear. The AbstractGfx fallback draws a clear quad through
  // utility shaders that CreateShaderFromSource cannot provide (it always substitutes the uber
  // pair), so VideoCommon's copy-clear was a silent no-op — the EFB was NEVER cleared. Implemented
  // as an in-pass fullscreen-triangle draw with a dedicated hand-written WGSL clear pipeline
  // (scissored to target_rc, color-write-mask per channel, frag_depth for z).
  void ClearRegion(const MathUtil::Rectangle<int>& target_rc, bool colorEnable, bool alphaEnable,
                   bool zEnable, u32 color, u32 z) override;

  // [WGPU C1 2026-07-13] Internal texture blit (samples src into dst via a dedicated hand-written
  // WGSL pipeline — again NOT via the uber-only shader cache). Drives EFB->XFB/vram copies
  // (WGPUTextureCache::CopyEFBToCacheEntry). Records into the shared deferred encoder: ends the
  // open EFB pass, records the blit pass, next draw reopens the EFB pass with loadOp=Load.
  // src_rect is in src texel coordinates; dst is written at (0,0) dst_w x dst_h (mip/layer 0).
  bool BlitToTexture(::WGPUTexture src_texture, u32 src_width, u32 src_height,
                     const MathUtil::Rectangle<int>& src_rect, ::WGPUTexture dst_texture,
                     u32 dst_w, u32 dst_h, bool linear_filter);

  // Records one indexed draw into the (lazily-begun) render pass on the bound framebuffer. Builds
  // GROUP0 (VS+PS uniform dynamic offsets) and GROUP1 (8 textures + 8 samplers, dummy for unbound)
  // bind groups per-draw. No-op (cleanly) if any required handle is missing.
  void DrawIndexed(WGPUBuffer vertex_buffer, WGPUBuffer index_buffer, WGPUBuffer uniform_buffer,
                   u32 vs_uniform_offset, u32 ps_uniform_offset, u32 num_indices, u32 base_index,
                   u32 base_vertex);

  // Shared bind-group-layouts + pipeline-layout (ObjectCache-style). Every GX ubershader pipeline
  // uses the SAME @group/@binding scheme baked into the uber WGSL, so build these once. Returns
  // nullptr if device creation / layout creation failed (CreatePipeline then bails).
  WGPUPipelineLayout GetUberPipelineLayout();

  // Single non-blocking event-loop tick on the instance (drives AllowProcessEvents callbacks).
  // Used at shader-create time to harvest compilation-info; NOT a per-frame path.
  void PumpInstanceOnce()
  {
    if (m_instance)
      wgpuInstanceProcessEvents(m_instance);
  }

  // Real WebGPU clear + present (Milestone 1).
  bool BindBackbuffer(const ClearColor& clear_color = {}) override;
  void PresentBackbuffer() override;

  // SW-style per-frame present fallback. With SupportsUtilityDrawing()==false,
  // Present.cpp:918 calls ShowImage() every frame INSTEAD of BindBackbuffer/
  // PresentBackbuffer. At M2-A this reads back the REAL EFB color texture (the page
  // shows the forced MAGENTA EFB clear) instead of the M1 cornflower offscreen target.
  void ShowImage(const AbstractTexture* source_texture,
                 const MathUtil::Rectangle<int>& source_rc) override;

private:
  // Lazily begins a render pass on the currently-bound framebuffer (loadOp=Load) if none is open.
  void BeginRenderPassIfNeeded();
  // Ensures m_encoder exists for the current frame.
  void EnsureEncoder();
  // Reads back a WxH region of the given WGPU texture handle (color, RGBA8/BGRA8) starting at
  // (origin_x, origin_y) and postMessages it to the page. Reuses the proven M1
  // copyTextureToBuffer + mapAsync(pump) + post machinery.
  // ::WGPUTexture is the C handle (WGPU::WGPUTexture is our wrapper class — they shadow here).
  void ReadbackAndPresent(::WGPUTexture src_texture, u32 origin_x, u32 origin_y, u32 width,
                          u32 height);

  // [WGPU C1 2026-07-13] Applies the cached viewport + scissor to the open pass (called from
  // BeginRenderPassIfNeeded and from the Set* overrides when a pass is already open).
  void ApplyViewportAndScissor();
  // Lazily builds the internal utility WGSL module + layouts (blit + clear). Returns false when
  // the device is unavailable or creation failed.
  bool EnsureUtilPipelines();
  // 256-aligned slot in the small internal uniform ring for blit/clear params; flushes the
  // deferred encoder on wrap (queue writes execute before the deferred submit, so a same-frame
  // wrap would clobber an earlier slot's bytes otherwise). Returns UINT32_MAX on failure.
  u32 AllocUtilUniformSlot(const void* data, u32 size);

  // Lazily creates the 1x1 dummy texture_2d_array<f32> view + a default sampler used to fill any
  // GROUP1 slot the draw didn't bind (WebGPU requires EVERY layout entry to be present).
  void EnsureDummyResources();

  WGPUDevice m_device = nullptr;
  WGPUQueue m_queue = nullptr;
  WGPUInstance m_instance = nullptr;

  // Per-frame command recording + render-pass ownership.
  WGPUCommandEncoder m_encoder = nullptr;
  WGPURenderPassEncoder m_pass = nullptr;
  WGPUFramebuffer* m_bound_fb = nullptr;

  // Shared uber bind-group-layouts + pipeline-layout (lazily built; see GetUberPipelineLayout).
  WGPUBindGroupLayout m_uber_bgl_uniforms = nullptr;  // group 0 (VS/PS uniform blocks)
  WGPUBindGroupLayout m_uber_bgl_textures = nullptr;  // group 1 (texture/sampler binding_arrays)
  WGPUPipelineLayout m_uber_pipeline_layout = nullptr;
  bool m_uber_layout_tried = false;  // build attempted (avoid retry-spamming device errors)

  // --- Draw state (B2). ---
  // Currently-bound pipeline (mirror of VKGfx::SetPipeline storing m_current_pipeline). The handle
  // is the WGPURenderPipeline owned by the WGPUPipeline AbstractPipeline.
  WGPURenderPipeline m_current_pipeline = nullptr;
  // Per-slot bound texture VIEW + sampler (slots 0..7). Filled by SetTexture/SetSamplerState; read
  // by DrawIndexed (dummy fallback for null slots). The texture views are owned by WGPUTexture
  // wrappers (lazily created there); the samplers are owned here and recreated on state change.
  WGPUTextureView m_bound_texture_views[8] = {};
  // [WGPU C4 2026-07-14] m_bound_samplers are NON-owning refs into m_sampler_cache (below); the
  // cache owns each WGPUSampler and releases them in the dtor. SetSamplerState used to
  // wgpuDeviceCreateSampler EVERY call (CPU profile: createSampler 1.5% of the JIT thread) —
  // now it caches by SamplerState::Hex() (deterministic, few distinct states).
  WGPUSampler m_bound_samplers[8] = {};
  std::unordered_map<uint64_t, WGPUSampler> m_sampler_cache;
  // Dummy fallbacks for unbound GROUP1 slots (1x1 2DArray texture + default sampler).
  ::WGPUTexture m_dummy_texture = nullptr;
  WGPUTextureView m_dummy_texture_view = nullptr;
  WGPUSampler m_dummy_sampler = nullptr;
  bool m_draw_logged = false;  // one-shot "draw bind groups built" log

  // [WGPU C3 2026-07-13] Bind-group cache. DrawIndexed built BOTH bind groups fresh every draw
  // (~2 wgpuDeviceCreateBindGroup/draw, ~500/frame at 247 draws). GROUP0 (uniform blocks) is
  // identical every draw — same buffer, same layout, same block sizes; the per-draw dynamic
  // offset is passed to SetBindGroup, NOT baked into the group — so it is built once. GROUP1
  // (8 tex + 8 samp) changes only when SetTexture/SetSamplerState/UnbindTexture mutate a slot,
  // tracked by m_grp1_dirty. Cached groups hold one ref each (released on invalidation / dtor);
  // the encoder takes its own transient ref at SetBindGroup, so cross-draw/pass reuse is valid.
  WGPUBindGroup m_cached_grp0 = nullptr;
  WGPUBuffer m_cached_grp0_buffer = nullptr;  // rebuild grp0 if the uniform buffer handle changes
  WGPUBindGroup m_cached_grp1 = nullptr;
  bool m_grp1_dirty = true;

  // [WGPU C1 2026-07-13] Cached viewport/scissor (WebGPU pass state resets per pass).
  float m_viewport[6] = {0.0f, 0.0f, 640.0f, 528.0f, 0.0f, 1.0f};  // x y w h near far
  MathUtil::Rectangle<int> m_scissor{0, 0, 640, 528};
  bool m_scissor_valid = false;  // false until the first SetScissorRect (apply full-fb then)

  // [WGPU C1 2026-07-13] Internal utility pipelines (hand-written WGSL; independent of the uber
  // shader cache). One module carries the fullscreen-triangle VS + blit FS + clear FS.
  WGPUShaderModule m_util_module = nullptr;
  WGPUBindGroupLayout m_util_blit_bgl = nullptr;    // texture + sampler + params uniform
  WGPUPipelineLayout m_util_blit_layout = nullptr;
  WGPURenderPipeline m_util_blit_pipeline = nullptr;         // RGBA8 target, no depth
  WGPUBindGroupLayout m_util_clear_bgl = nullptr;   // params uniform only
  WGPUPipelineLayout m_util_clear_layout = nullptr;
  // Clear pipeline variants keyed by write_mask(0..15) | has_depth<<4 | depth_write<<5.
  WGPURenderPipeline m_util_clear_pipelines[64] = {};
  WGPUSampler m_util_sampler_nearest = nullptr;
  WGPUSampler m_util_sampler_linear = nullptr;
  bool m_util_tried = false;
  // Small uniform ring for blit/clear params (256-aligned slots).
  WGPUBuffer m_util_uniforms = nullptr;
  u32 m_util_uniform_offset = 0;

  // Readback machinery (sized lazily for the texture being presented).
  WGPUBuffer m_readback_buffer = nullptr;
  size_t m_readback_capacity = 0;
  int m_readback_in_flight = 0;  // [pipeline] readbacks in flight (cap 3)
  // [staging ring STEP 4 2026-07-09] persistent readback-buffer pool (<=3, matches the
  // in-flight cap) — replaces per-frame wgpuDeviceCreateBuffer/Release churn. Buffers return
  // to the pool from the map callback (unmapped => reusable); pool flushes on size change.
  std::vector<WGPUBuffer> m_readback_pool;
  size_t m_readback_pool_buf_size = 0;
  std::vector<uint8_t> m_pixels;  // de-padded RGBA8, width*4 * height
  u32 m_width = 640;
  u32 m_height = 480;
};

class WGPUEFBInterface final : public EFBInterfaceBase
{
  void ReinterpretPixelData(EFBReinterpretType convtype) override;

  void PokeColor(u16 x, u16 y, u32 color) override;
  void PokeDepth(u16 x, u16 y, u32 depth) override;

  u32 PeekColorInternal(u16 x, u16 y) override;
  u32 PeekDepthInternal(u16 x, u16 y) override;
};

}  // namespace WGPU
