// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <emscripten.h>  // MAIN_THREAD_EM_ASM (one-shot diagnostics)

#include "VideoBackends/WGPU/WGPUGfx.h"
#include "VideoBackends/WGPU/WGPUTexture.h"
#include "VideoCommon/FramebufferManager.h"
#include "VideoCommon/TextureCacheBase.h"

namespace WGPU
{
class WGPUTextureCache final : public TextureCacheBase
{
protected:
  // [WGPU C1 2026-07-13] EFB->RAM copies stay unimplemented (WGPUStagingTexture readback is a
  // stub); keeping the override EMPTY (instead of the base shader path) means destination RAM
  // keeps its prior contents rather than being overwritten with zeros. Real impl needs the
  // staging-texture readback (audit wf_a86451c3, finding "WGPUStagingTexture readback is a stub").
  void CopyEFB(AbstractStagingTexture* dst, const EFBCopyParams& params, u32 native_width,
               u32 bytes_per_row, u32 num_blocks_y, u32 memory_stride,
               const MathUtil::Rectangle<int>& src_rect, bool scale_by_half, bool linear_filter,
               float y_scale, float gamma, bool clamp_top, bool clamp_bottom,
               const std::array<u32, 3>& filter_coefficients) override
  {
  }

  // [WGPU C1 2026-07-13] Native EFB->texture copy via WGPUGfx::BlitToTexture (hand-written WGSL
  // blit — the base TextureCacheBase implementation renders through utility shaders that this
  // backend's CreateShaderFromSource cannot provide). This is what fills the XFB copy the present
  // path (ShowImage) reads. Approximations, logged one-shot below: dst_format quantization
  // (RGB565/I4/...), is_intensity (Y formula), gamma!=1, and the deflicker filter_coefficients
  // are not applied — the blit is a straight RGBA8 sample (linear/nearest per linear_filter).
  void CopyEFBToCacheEntry(RcTcacheEntry& entry, bool is_depth_copy,
                           const MathUtil::Rectangle<int>& src_rect, bool scale_by_half,
                           bool linear_filter, EFBCopyFormat dst_format, bool is_intensity,
                           float gamma, bool clamp_top, bool clamp_bottom,
                           const std::array<u32, 3>& filter_coefficients) override
  {
    if (!entry || !entry->texture || !g_framebuffer_manager)
      return;

    if (is_depth_copy)
    {
      // Depth32Float can't feed the RGBA8 blit pipeline; needs a depth-encode variant.
      static bool s_depth_logged = false;
      if (!s_depth_logged)
      {
        s_depth_logged = true;
        MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
          '[wgpu] CopyEFBToCacheEntry: depth copy SKIPPED (unimplemented)'}); });
      }
      return;
    }

    AbstractTexture* efb_color = g_framebuffer_manager->GetEFBColorTexture();
    WGPUGfx* gfx = WGPUGfx::GetInstance();
    if (!efb_color || !gfx)
      return;

    static bool s_approx_logged = false;
    if (!s_approx_logged && (is_intensity || gamma != 1.0f))
    {
      s_approx_logged = true;
      MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
        '[wgpu] CopyEFBToCacheEntry: intensity/gamma approximated as straight blit'
        + ' (is_intensity=' + $0 + ' gamma=' + $1 + ')'}); }, (int)is_intensity, (double)gamma);
    }

    gfx->BlitToTexture(static_cast<WGPUTexture*>(efb_color)->GetTexture(), efb_color->GetWidth(),
                       efb_color->GetHeight(), src_rect,
                       static_cast<WGPUTexture*>(entry->texture.get())->GetTexture(),
                       entry->texture->GetWidth(), entry->texture->GetHeight(), linear_filter);
  }
};

}  // namespace WGPU
