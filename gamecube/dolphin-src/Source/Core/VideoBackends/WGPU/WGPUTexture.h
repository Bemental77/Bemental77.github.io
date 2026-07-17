// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

// emdawnwebgpu exposes the C API through this header (see WGPUGfx.h note).
#include <webgpu/webgpu.h>

#include <memory>
#include <vector>

#include "Common/CommonTypes.h"

#include "VideoCommon/AbstractFramebuffer.h"
#include "VideoCommon/AbstractStagingTexture.h"
#include "VideoCommon/AbstractTexture.h"

namespace WGPU
{
// The WebGPU C handle types live in the global namespace (::WGPUTexture etc). Our class is named
// WGPU::WGPUTexture, which would shadow the handle inside this namespace, so alias the handles.
using WGPUTextureHandle = ::WGPUTexture;
using WGPUTextureViewHandle = ::WGPUTextureView;

// AbstractTextureFormat -> WGPUTextureFormat (verbatim from the M2-A blueprint).
WGPUTextureFormat GetWGPUFormatForAbstractFormat(AbstractTextureFormat format);

class WGPUTexture final : public AbstractTexture
{
public:
  WGPUTexture(const TextureConfig& config, WGPUTextureHandle texture,
              WGPUTextureFormat wgpu_format);
  ~WGPUTexture() override;

  // Owns a real WGPUTexture. Returns nullptr on failure (e.g. no device).
  static std::unique_ptr<WGPUTexture> Create(const TextureConfig& config);

  WGPUTextureHandle GetTexture() const { return m_texture; }
  WGPUTextureFormat GetWGPUFormat() const { return m_wgpu_format; }

  // Lazily-created 2DArray binding view (the uber fragment layout declares texture_2d_array<f32>,
  // so the bound view dimension MUST be 2DArray even when layers==1). Used by WGPUGfx::SetTexture.
  WGPUTextureViewHandle GetBindingView();

  void CopyRectangleFromTexture(const AbstractTexture* src,
                                const MathUtil::Rectangle<int>& src_rect, u32 src_layer,
                                u32 src_level, const MathUtil::Rectangle<int>& dst_rect,
                                u32 dst_layer, u32 dst_level) override;
  void ResolveFromTexture(const AbstractTexture* src, const MathUtil::Rectangle<int>& rect,
                          u32 layer, u32 level) override;
  void Load(u32 level, u32 width, u32 height, u32 row_length, const u8* buffer, size_t buffer_size,
            u32 layer) override;

private:
  WGPUTextureHandle m_texture = nullptr;
  WGPUTextureFormat m_wgpu_format = WGPUTextureFormat_Undefined;
  WGPUTextureViewHandle m_binding_view = nullptr;  // lazy 2DArray view (released in dtor)
};

class WGPUStagingTexture final : public AbstractStagingTexture
{
public:
  explicit WGPUStagingTexture(StagingTextureType type, const TextureConfig& config);
  ~WGPUStagingTexture() override;

  void CopyFromTexture(const AbstractTexture* src, const MathUtil::Rectangle<int>& src_rect,
                       u32 src_layer, u32 src_level,
                       const MathUtil::Rectangle<int>& dst_rect) override;
  void CopyToTexture(const MathUtil::Rectangle<int>& src_rect, AbstractTexture* dst,
                     const MathUtil::Rectangle<int>& dst_rect, u32 dst_layer,
                     u32 dst_level) override;

  bool Map() override;
  void Unmap() override;
  void Flush() override;

private:
  std::vector<u8> m_texture_buf;
};

class WGPUFramebuffer final : public AbstractFramebuffer
{
public:
  WGPUFramebuffer(AbstractTexture* color_attachment, AbstractTexture* depth_attachment,
                  std::vector<AbstractTexture*> additional_color_attachments,
                  AbstractTextureFormat color_format, AbstractTextureFormat depth_format, u32 width,
                  u32 height, u32 layers, u32 samples, WGPUTextureViewHandle color_view,
                  WGPUTextureViewHandle depth_view, WGPUTextureFormat wgpu_color_format,
                  WGPUTextureFormat wgpu_depth_format);
  ~WGPUFramebuffer() override;

  static std::unique_ptr<WGPUFramebuffer>
  Create(WGPUTexture* color_attachment, WGPUTexture* depth_attachment,
         std::vector<AbstractTexture*> additional_color_attachments);

  // Views and formats are needed by WGPUGfx render-pass begin and by pipelines (Chunk B).
  WGPUTextureViewHandle GetColorView() const { return m_color_view; }
  WGPUTextureViewHandle GetDepthView() const { return m_depth_view; }
  WGPUTextureFormat GetWGPUColorFormat() const { return m_wgpu_color_format; }
  WGPUTextureFormat GetWGPUDepthFormat() const { return m_wgpu_depth_format; }

private:
  WGPUTextureViewHandle m_color_view = nullptr;
  WGPUTextureViewHandle m_depth_view = nullptr;
  WGPUTextureFormat m_wgpu_color_format = WGPUTextureFormat_Undefined;
  WGPUTextureFormat m_wgpu_depth_format = WGPUTextureFormat_Undefined;
};

}  // namespace WGPU
