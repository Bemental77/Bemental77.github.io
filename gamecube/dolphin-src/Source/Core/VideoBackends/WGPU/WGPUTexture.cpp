// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/WGPU/WGPUTexture.h"

#include <algorithm>  // std::max / std::min for mip-extent clamping
#include <emscripten.h>  // MAIN_THREAD_EM_ASM for stub-hit logging

#include "Common/Align.h"  // Common::AlignUp for compressed block-row count

#include "VideoBackends/WGPU/WGPUGfx.h"

namespace WGPU
{
// AbstractTextureFormat -> WGPUTextureFormat. Verbatim mapping from the M2-A blueprint; ported
// structurally from VKTexture::GetVkFormatForHostTextureFormat (VKTexture.cpp:191-244).
WGPUTextureFormat GetWGPUFormatForAbstractFormat(AbstractTextureFormat format)
{
  switch (format)
  {
  case AbstractTextureFormat::RGBA8:
    return WGPUTextureFormat_RGBA8Unorm;
  case AbstractTextureFormat::BGRA8:
    return WGPUTextureFormat_BGRA8Unorm;
  case AbstractTextureFormat::RGB10_A2:
    return WGPUTextureFormat_RGB10A2Unorm;
  case AbstractTextureFormat::RGBA16F:
    return WGPUTextureFormat_RGBA16Float;
  case AbstractTextureFormat::R32F:
    return WGPUTextureFormat_R32Float;
  case AbstractTextureFormat::D16:
    return WGPUTextureFormat_Depth16Unorm;
  case AbstractTextureFormat::D32F:
    return WGPUTextureFormat_Depth32Float;
  case AbstractTextureFormat::D24_S8:
    return WGPUTextureFormat_Depth24PlusStencil8;
  case AbstractTextureFormat::D32F_S8:
    return WGPUTextureFormat_Depth32FloatStencil8;
  case AbstractTextureFormat::R16:
    return WGPUTextureFormat_R16Float;
  case AbstractTextureFormat::DXT1:
    return WGPUTextureFormat_BC1RGBAUnorm;
  case AbstractTextureFormat::DXT3:
    return WGPUTextureFormat_BC2RGBAUnorm;
  case AbstractTextureFormat::DXT5:
    return WGPUTextureFormat_BC3RGBAUnorm;
  case AbstractTextureFormat::BPTC:
    return WGPUTextureFormat_BC7RGBAUnorm;
  case AbstractTextureFormat::Undefined:
  default:
    return WGPUTextureFormat_Undefined;
  }
}

WGPUTexture::WGPUTexture(const TextureConfig& tex_config, WGPUTextureHandle texture,
                         WGPUTextureFormat wgpu_format)
    : AbstractTexture(tex_config), m_texture(texture), m_wgpu_format(wgpu_format)
{
}

WGPUTexture::~WGPUTexture()
{
  // [stale-bind fix 2026-07-03] Clear this texture's view out of WGPUGfx::m_bound_texture_views
  // BEFORE releasing it. Without this, a texture-cache eviction of a bound texture left a freed
  // view handle in the bind slots; the next DrawCurrentBatch built a GPUBindGroupEntry whose JS
  // 'resource' resolved to undefined -> TypeError in wgpuDeviceCreateBindGroup (observed on PSO
  // first draw batch: "Failed to read the 'resource' property from 'GPUBindGroupEntry'").
  if (WGPUGfx* gfx = WGPUGfx::GetInstance())
    gfx->UnbindTexture(this);
  if (m_binding_view)
    wgpuTextureViewRelease(m_binding_view);
  if (m_texture)
    wgpuTextureRelease(m_texture);
}

WGPUTextureViewHandle WGPUTexture::GetBindingView()
{
  if (m_binding_view || !m_texture)
    return m_binding_view;

  // Force a 2DArray view spanning all layers/mips. The uber fragment shader samples
  // texture_2d_array<f32>, so the bound view dimension must be 2DArray (the default view of a
  // layers==1 texture would be plain 2D and fail bind-group validation against the layout).
  WGPUTextureViewDescriptor desc = {};
  desc.format = m_wgpu_format;
  desc.dimension = WGPUTextureViewDimension_2DArray;
  desc.baseMipLevel = 0;
  desc.mipLevelCount = GetLevels();
  desc.baseArrayLayer = 0;
  desc.arrayLayerCount = GetLayers();
  desc.aspect = WGPUTextureAspect_All;
  m_binding_view = wgpuTextureCreateView(m_texture, &desc);
  return m_binding_view;
}

std::unique_ptr<WGPUTexture> WGPUTexture::Create(const TextureConfig& config)
{
  WGPUGfx* gfx = WGPUGfx::GetInstance();
  WGPUDevice device = gfx ? gfx->GetDevice() : nullptr;
  if (!device)
    return nullptr;

  const WGPUTextureFormat wgpu_format = GetWGPUFormatForAbstractFormat(config.format);

  // Usage: always copy-src/dst + texture-binding, + render-attachment for render targets (EFB,
  // XFB, copy targets), + storage-binding for compute images. Mirrors VKTexture::Create usage.
  WGPUTextureUsage usage = WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst |
                           WGPUTextureUsage_TextureBinding;
  if (config.IsRenderTarget())
    usage |= WGPUTextureUsage_RenderAttachment;
  if (config.IsComputeImage())
    usage |= WGPUTextureUsage_StorageBinding;

  WGPUTextureDescriptor desc = {};
  desc.usage = usage;
  desc.dimension = WGPUTextureDimension_2D;
  desc.size = {config.width, config.height, config.layers};
  desc.format = wgpu_format;
  desc.mipLevelCount = config.levels;
  desc.sampleCount = config.samples;

  WGPUTextureHandle texture = wgpuDeviceCreateTexture(device, &desc);
  if (!texture)
    return nullptr;

  return std::make_unique<WGPUTexture>(config, texture, wgpu_format);
}

void WGPUTexture::CopyRectangleFromTexture(const AbstractTexture* src,
                                           const MathUtil::Rectangle<int>& src_rect, u32 src_layer,
                                           u32 src_level, const MathUtil::Rectangle<int>& dst_rect,
                                           u32 dst_layer, u32 dst_level)
{
  // copyTextureToTexture, no shader. Ported from VKTexture::CopyRectangleFromTexture
  // (VKTexture.cpp:278-319) minus the image-layout transitions (WebGPU has no explicit layouts).
  const WGPUTexture* src_texture = static_cast<const WGPUTexture*>(src);
  WGPUGfx* gfx = WGPUGfx::GetInstance();
  if (!gfx || !m_texture || !src_texture || !src_texture->GetTexture())
    return;

  WGPUDevice device = gfx->GetDevice();
  WGPUQueue queue = gfx->GetQueue();
  if (!device || !queue)
    return;

  // A copy cannot run with a render pass open; flush the in-flight frame first.
  gfx->EndRenderPass();
  gfx->SubmitFrame();

  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, nullptr);

  WGPUTexelCopyTextureInfo src_info = {};
  src_info.texture = src_texture->GetTexture();
  src_info.mipLevel = src_level;
  src_info.origin = {static_cast<u32>(src_rect.left), static_cast<u32>(src_rect.top), src_layer};
  src_info.aspect = WGPUTextureAspect_All;

  WGPUTexelCopyTextureInfo dst_info = {};
  dst_info.texture = m_texture;
  dst_info.mipLevel = dst_level;
  dst_info.origin = {static_cast<u32>(dst_rect.left), static_cast<u32>(dst_rect.top), dst_layer};
  dst_info.aspect = WGPUTextureAspect_All;

  WGPUExtent3D copy_size = {static_cast<u32>(src_rect.GetWidth()),
                            static_cast<u32>(src_rect.GetHeight()), 1};
  wgpuCommandEncoderCopyTextureToTexture(enc, &src_info, &dst_info, &copy_size);

  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuQueueSubmit(queue, 1, &cmd);
  wgpuCommandBufferRelease(cmd);
  wgpuCommandEncoderRelease(enc);
}

void WGPUTexture::ResolveFromTexture(const AbstractTexture* src,
                                     const MathUtil::Rectangle<int>& rect, u32 layer, u32 level)
{
  // MSAA disabled in this build; not hit during boot+clear+present.
  static bool logged = false;
  if (!logged)
  {
    logged = true;
    MAIN_THREAD_EM_ASM(
        { postMessage({cmd: 'print', txt: '[wgpu] STUB WGPUTexture::ResolveFromTexture hit'}); });
  }
}

void WGPUTexture::Load(u32 level, u32 width, u32 height, u32 row_length, const u8* buffer,
                       size_t buffer_size, u32 layer)
{
  // CPU->texture upload of a single mip level/layer (used by the texture cache for game
  // textures). Ported from VKTexture::Load (VKTexture.cpp:351-447): there the CPU bytes are
  // staged into a buffer and vkCmdCopyBufferToImage'd; WebGPU collapses that to a single
  // synchronous wgpuQueueWriteTexture (no staging buffer, no fence, no emscripten_sleep).
  WGPUGfx* gfx = WGPUGfx::GetInstance();
  WGPUQueue queue = gfx ? gfx->GetQueue() : nullptr;
  if (!queue || !m_texture || !buffer)
    return;

#ifdef BEMENTAL_WGPU_PROF
  const double t_load0 = emscripten_get_now();  // [WGPU-PROF — gated]
#endif

  // Can't copy data larger than the mip's extents (mirrors VKTexture::Load clamp).
  width = std::max(1u, std::min(width, GetWidth() >> level));
  height = std::max(1u, std::min(height, GetHeight() >> level));

  const AbstractTextureFormat format = m_config.format;
  const u32 block_size = GetBlockSizeForFormat(format);  // 4 for BC/DXT, 1 otherwise

  // bytesPerRow describes the SOURCE (CPU) row pitch. For wgpuQueueWriteTexture this does NOT
  // require 256-alignment (that rule is only for buffer<->texture copies). CalculateStrideForFormat
  // returns the per-row pitch for uncompressed formats and the per-block-row pitch for compressed
  // formats (it divides row_length by 4 internally for BC/DXT). row_length is in texels.
  const u32 bytes_per_row = CalculateStrideForFormat(format, row_length);

  // rowsPerImage counts rows of the SOURCE data: pixel rows for uncompressed, block-rows for
  // compressed (mirrors VKTexture::Load num_rows = AlignUp(height, block_size) / block_size).
  const u32 rows_per_image = Common::AlignUp(height, block_size) / block_size;

  // WebGPU requires the copy extent's width/height to be multiples of the block dimension for
  // compressed formats; round up. For uncompressed (block_size==1) this is a no-op.
  const u32 extent_width = Common::AlignUp(width, block_size);
  const u32 extent_height = Common::AlignUp(height, block_size);

  WGPUTexelCopyTextureInfo dst = {};
  dst.texture = m_texture;
  dst.mipLevel = level;
  dst.origin = {0, 0, layer};
  dst.aspect = WGPUTextureAspect_All;

  WGPUTexelCopyBufferLayout data_layout = {};
  data_layout.offset = 0;
  data_layout.bytesPerRow = bytes_per_row;
  data_layout.rowsPerImage = rows_per_image;

  WGPUExtent3D write_size = {extent_width, extent_height, 1};

  wgpuQueueWriteTexture(queue, &dst, buffer, buffer_size, &data_layout, &write_size);

#ifdef BEMENTAL_WGPU_PROF
  WGPUGfx::s_prof_tex_load_ms += emscripten_get_now() - t_load0;  // [WGPU-PROF — gated]
  WGPUGfx::s_prof_tex_loads++;
#endif

  static bool logged = false;
  if (!logged)
  {
    logged = true;
    MAIN_THREAD_EM_ASM(
        {
          postMessage({
            cmd : 'print',
            txt : '[wgpu] first texture Load: ' + $0 + 'x' + $1 + ' level=' + $2 + ' fmt=' + $3 +
                  ' bytes=' + $4
          });
        },
        static_cast<int>(width), static_cast<int>(height), static_cast<int>(level),
        static_cast<int>(format), static_cast<int>(buffer_size));
  }
}

WGPUStagingTexture::WGPUStagingTexture(StagingTextureType type, const TextureConfig& config)
    : AbstractStagingTexture(type, config)
{
  m_texture_buf.resize(m_texel_size * config.width * config.height);
  m_map_pointer = reinterpret_cast<char*>(m_texture_buf.data());
  m_map_stride = m_texel_size * config.width;
}

WGPUStagingTexture::~WGPUStagingTexture() = default;

void WGPUStagingTexture::CopyFromTexture(const AbstractTexture* src,
                                         const MathUtil::Rectangle<int>& src_rect, u32 src_layer,
                                         u32 src_level, const MathUtil::Rectangle<int>& dst_rect)
{
  m_needs_flush = true;
}

void WGPUStagingTexture::CopyToTexture(const MathUtil::Rectangle<int>& src_rect,
                                       AbstractTexture* dst,
                                       const MathUtil::Rectangle<int>& dst_rect, u32 dst_layer,
                                       u32 dst_level)
{
  m_needs_flush = true;
}

bool WGPUStagingTexture::Map()
{
  return true;
}

void WGPUStagingTexture::Unmap()
{
}

void WGPUStagingTexture::Flush()
{
  m_needs_flush = false;
}

WGPUFramebuffer::WGPUFramebuffer(AbstractTexture* color_attachment,
                                 AbstractTexture* depth_attachment,
                                 std::vector<AbstractTexture*> additional_color_attachments,
                                 AbstractTextureFormat color_format,
                                 AbstractTextureFormat depth_format, u32 width, u32 height,
                                 u32 layers, u32 samples, WGPUTextureViewHandle color_view,
                                 WGPUTextureViewHandle depth_view,
                                 WGPUTextureFormat wgpu_color_format,
                                 WGPUTextureFormat wgpu_depth_format)
    : AbstractFramebuffer(color_attachment, depth_attachment,
                          std::move(additional_color_attachments), color_format, depth_format,
                          width, height, layers, samples),
      m_color_view(color_view), m_depth_view(depth_view), m_wgpu_color_format(wgpu_color_format),
      m_wgpu_depth_format(wgpu_depth_format)
{
}

WGPUFramebuffer::~WGPUFramebuffer()
{
  if (m_color_view)
    wgpuTextureViewRelease(m_color_view);
  if (m_depth_view)
    wgpuTextureViewRelease(m_depth_view);
}

std::unique_ptr<WGPUFramebuffer>
WGPUFramebuffer::Create(WGPUTexture* color_attachment, WGPUTexture* depth_attachment,
                        std::vector<AbstractTexture*> additional_color_attachments)
{
  if (!ValidateConfig(color_attachment, depth_attachment, additional_color_attachments))
    return nullptr;

  const AbstractTextureFormat color_format =
      color_attachment ? color_attachment->GetFormat() : AbstractTextureFormat::Undefined;
  const AbstractTextureFormat depth_format =
      depth_attachment ? depth_attachment->GetFormat() : AbstractTextureFormat::Undefined;
  const WGPUTexture* either_attachment = color_attachment ? color_attachment : depth_attachment;
  const u32 width = either_attachment->GetWidth();
  const u32 height = either_attachment->GetHeight();
  const u32 layers = either_attachment->GetLayers();
  const u32 samples = either_attachment->GetSamples();

  // Create one persistent view per attachment (port of VKFramebuffer::Create attachment views).
  // EFB textures are 2D-array (layers may be 1); a default view over the whole texture is fine
  // for a single-layer clear+present. Released in the destructor.
  WGPUTextureViewHandle color_view = nullptr;
  WGPUTextureFormat wgpu_color_format = WGPUTextureFormat_Undefined;
  if (color_attachment && color_attachment->GetTexture())
  {
    color_view = wgpuTextureCreateView(color_attachment->GetTexture(), nullptr);
    wgpu_color_format = color_attachment->GetWGPUFormat();
  }

  WGPUTextureViewHandle depth_view = nullptr;
  WGPUTextureFormat wgpu_depth_format = WGPUTextureFormat_Undefined;
  if (depth_attachment && depth_attachment->GetTexture())
  {
    depth_view = wgpuTextureCreateView(depth_attachment->GetTexture(), nullptr);
    wgpu_depth_format = depth_attachment->GetWGPUFormat();
  }

  return std::make_unique<WGPUFramebuffer>(
      color_attachment, depth_attachment, std::move(additional_color_attachments), color_format,
      depth_format, width, height, layers, samples, color_view, depth_view, wgpu_color_format,
      wgpu_depth_format);
}

}  // namespace WGPU
