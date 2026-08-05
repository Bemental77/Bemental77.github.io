// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <cstring>       // memcpy (depth float readback decode)
#include <emscripten.h>  // MAIN_THREAD_EM_ASM (one-shot diagnostics)

#include "Core/Core.h"  // [dc device-gate 2026-07-22] WGPUDeviceLiveOnThisThread
#include "VideoBackends/WGPU/WGPUGfx.h"
#include "VideoBackends/WGPU/WGPUTexture.h"
#include "VideoCommon/FramebufferManager.h"
#include "VideoCommon/TextureCacheBase.h"
#include "VideoCommon/VideoConfig.h"  // [R1 PM38 TEMP] g_ActiveConfig flag publish

namespace WGPU
{
class WGPUTextureCache final : public TextureCacheBase
{
protected:
  // [render-gaps R1 PM38 2026-07-24] EFB->RAM copies IMPLEMENTED (was: empty override —
  // and NOT harmless: TextureCacheBase.cpp:2396 WriteEFBCopyToRAM memcpys the staging
  // buffer into guest RAM regardless, so games re-decoding EFB copies from RAM read
  // ZEROS — the block-garbage texture class). Correctness-first design, no new WGSL:
  //   1. copyTextureToBuffer the EFB src_rect (color RGBA8, or depth Depth32Float)
  //      into a MapRead buffer (fresh encoder; FlushPendingWork() first so the copy
  //      observes all rendering issued so far).
  //   2. Non-blocking MapAsync (AllowSpontaneous — same pattern as ReadbackAndPresent;
  //      a blocking pump here would hit the documented ASYNCIFY nested-sleep hazard).
  //   3. The callback CPU-encodes the pixels into the staging texture's map buffer in
  //      the GX tiled layout (bytes_per_row x num_blocks_y) WriteEFBCopyToRAM expects.
  // The flush of pending copies happens at frame end (TextureCacheBase FlushEFBCopies),
  // which normally lands AFTER the spontaneous callback; if a callback is late, that
  // one copy writes the staging buffer's previous contents (stale > zeros).
  // KNOWN APPROXIMATIONS (hedge — refine vs the native oracle later): nearest-sample
  // rescale (covers scale_by_half + y_scale without a box filter), gamma/copy-filter/
  // clamp ignored, intensity uses BT.601 studio Y on color channels only, depth-format
  // channel mapping (Z16/Z8M/Z8L) follows the TextureDecoder.h channel comments.
  struct EfbRamCtx
  {
    ::WGPUBuffer buffer;
    size_t buf_size;
    u32 padded_bpr;
    u32 src_w, src_h;      // readback grid (EFB texels)
    bool is_depth;
    bool intensity;
    EFBCopyFormat fmt;
    u32 bytes_per_row, num_blocks_y;
    u32 enc_w, enc_h;      // encode grid (post scale_by_half/y_scale)
    char* dst;             // staging map pointer (kept alive by pending_efb_copy)
    u32 dst_stride;
    // [wgpu xfb-band 2026-07-31] flush handshake (see WGPUTexture.h). LAST member so
    // the positional aggregate init below stays valid (value-initialized).
    WGPUEfbEncodePending pending;
  };

  static u8 BT601Y(u32 r, u32 g, u32 b)
  {
    const u32 y = 16u + ((66u * r + 129u * g + 25u * b + 128u) >> 8);
    return static_cast<u8>(y > 255u ? 255u : y);
  }

  static void EncodeEfbToRam(const EfbRamCtx* c, const u8* mapped)
  {
    // Sample the readback grid with nearest resample onto the encode grid.
    auto px = [&](u32 dx, u32 dy, u8 out[4]) {
      u32 sx = c->enc_w ? (dx * c->src_w) / c->enc_w : 0;
      u32 sy = c->enc_h ? (dy * c->src_h) / c->enc_h : 0;
      if (sx >= c->src_w) sx = c->src_w - 1;
      if (sy >= c->src_h) sy = c->src_h - 1;
      const u8* p = mapped + (size_t)sy * c->padded_bpr + (size_t)sx * 4;
      if (!c->is_depth)
      {
        out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; out[3] = p[3];
        if (c->intensity)
        {
          const u8 y = BT601Y(p[0], p[1], p[2]);
          out[0] = out[1] = out[2] = y;
        }
      }
      else
      {
        float d;
        std::memcpy(&d, p, 4);
        float z = 1.0f - d;  // undo the backend's reversed-Z convention
        if (z < 0.0f) z = 0.0f;
        if (z > 1.0f) z = 1.0f;
        const u32 z24 = static_cast<u32>(z * 16777215.0f);
        out[0] = static_cast<u8>(z24 >> 16);   // Z hi  (R / Z8H)
        out[1] = static_cast<u8>(z24 >> 8);    // Z mid (G / Z8M)
        out[2] = static_cast<u8>(z24);         // Z lo  (B / Z8L)
        out[3] = 0xFF;
      }
    };

    if (c->fmt == EFBCopyFormat::XFB)
    {
      // XFB is LINEAR YUYV: each row = bytes_per_row bytes = bytes_per_row/2 pixels.
      const u32 w = c->bytes_per_row / 2;
      for (u32 y = 0; y < c->num_blocks_y; y++)
      {
        u8* row = reinterpret_cast<u8*>(c->dst) + (size_t)y * c->dst_stride;
        for (u32 x = 0; x < w; x += 2)
        {
          u8 p0[4], p1[4];
          px(x, y, p0);
          px(x + 1 < w ? x + 1 : x, y, p1);
          const u8 y0 = BT601Y(p0[0], p0[1], p0[2]);
          const u8 y1 = BT601Y(p1[0], p1[1], p1[2]);
          const s32 ar = (p0[0] + p1[0]) / 2, ag = (p0[1] + p1[1]) / 2, ab = (p0[2] + p1[2]) / 2;
          s32 u = 128 + ((-38 * ar - 74 * ag + 112 * ab + 128) >> 8);
          s32 v = 128 + ((112 * ar - 94 * ag - 18 * ab + 128) >> 8);
          if (u < 0) u = 0; if (u > 255) u = 255;
          if (v < 0) v = 0; if (v > 255) v = 255;
          row[x * 2 + 0] = y0;
          row[x * 2 + 1] = static_cast<u8>(u);
          row[x * 2 + 2] = y1;
          row[x * 2 + 3] = static_cast<u8>(v);
        }
      }
      return;
    }

    u32 tw = 4, th = 4, tb = 32;  // tile width/height/bytes
    switch (c->fmt)
    {
    case EFBCopyFormat::R4:      tw = 8; th = 8; break;
    case EFBCopyFormat::R8_0x1:
    case EFBCopyFormat::R8:
    case EFBCopyFormat::A8:
    case EFBCopyFormat::G8:
    case EFBCopyFormat::B8:
    case EFBCopyFormat::RA4:     tw = 8; th = 4; break;
    case EFBCopyFormat::RGBA8:   tb = 64; break;
    default: break;              // RA8/RGB565/RGB5A3/RG8/GB8: 4x4x32
    }
    const u32 tiles_x = c->bytes_per_row / tb;
    for (u32 by = 0; by < c->num_blocks_y; by++)
    {
      u8* row = reinterpret_cast<u8*>(c->dst) + (size_t)by * c->dst_stride;
      for (u32 tx = 0; tx < tiles_x; tx++)
      {
        u8* tile = row + (size_t)tx * tb;
        for (u32 ty = 0; ty < th; ty++)
        {
          for (u32 x = 0; x < tw; x++)
          {
            u8 p[4];
            px(tx * tw + x, by * th + ty, p);
            switch (c->fmt)
            {
            case EFBCopyFormat::R4:
            {
              u8& b = tile[ty * 4 + (x >> 1)];
              const u8 n = p[0] >> 4;
              b = (x & 1) ? static_cast<u8>((b & 0xF0) | n) : static_cast<u8>(n << 4);
              break;
            }
            case EFBCopyFormat::R8_0x1:
            case EFBCopyFormat::R8: tile[ty * 8 + x] = p[0]; break;
            case EFBCopyFormat::A8: tile[ty * 8 + x] = p[3]; break;
            case EFBCopyFormat::G8: tile[ty * 8 + x] = p[1]; break;
            case EFBCopyFormat::B8: tile[ty * 8 + x] = p[2]; break;
            case EFBCopyFormat::RA4:
              tile[ty * 8 + x] = static_cast<u8>((p[3] & 0xF0) | (p[0] >> 4));
              break;
            case EFBCopyFormat::RA8:
              tile[(ty * 4 + x) * 2 + 0] = p[3];
              tile[(ty * 4 + x) * 2 + 1] = p[0];
              break;
            case EFBCopyFormat::RGB565:
            {
              const u16 v = static_cast<u16>(((p[0] >> 3) << 11) | ((p[1] >> 2) << 5) | (p[2] >> 3));
              tile[(ty * 4 + x) * 2 + 0] = static_cast<u8>(v >> 8);
              tile[(ty * 4 + x) * 2 + 1] = static_cast<u8>(v);
              break;
            }
            case EFBCopyFormat::RGB5A3:
            {
              u16 v;
              if (p[3] >= 0xE0)
                v = static_cast<u16>(0x8000 | ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3));
              else
                v = static_cast<u16>(((p[3] >> 5) << 12) | ((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) |
                                     (p[2] >> 4));
              tile[(ty * 4 + x) * 2 + 0] = static_cast<u8>(v >> 8);
              tile[(ty * 4 + x) * 2 + 1] = static_cast<u8>(v);
              break;
            }
            case EFBCopyFormat::RGBA8:
              tile[(ty * 4 + x) * 2 + 0] = p[3];       // AR half
              tile[(ty * 4 + x) * 2 + 1] = p[0];
              tile[32 + (ty * 4 + x) * 2 + 0] = p[1];  // GB half
              tile[32 + (ty * 4 + x) * 2 + 1] = p[2];
              break;
            case EFBCopyFormat::RG8:
              tile[(ty * 4 + x) * 2 + 0] = p[0];
              tile[(ty * 4 + x) * 2 + 1] = p[1];
              break;
            case EFBCopyFormat::GB8:
              tile[(ty * 4 + x) * 2 + 0] = p[1];
              tile[(ty * 4 + x) * 2 + 1] = p[2];
              break;
            default: break;
            }
          }
        }
      }
    }
  }

  void CopyEFB(AbstractStagingTexture* dst, const EFBCopyParams& params, u32 native_width,
               u32 bytes_per_row, u32 num_blocks_y, u32 memory_stride,
               const MathUtil::Rectangle<int>& src_rect, bool scale_by_half, bool linear_filter,
               float y_scale, float gamma, bool clamp_top, bool clamp_bottom,
               const std::array<u32, 3>& filter_coefficients) override
  {
    // [render-gaps R1 PM38] entries @0x026B384C, started readbacks @0x3850,
    // encode callbacks fired @0x3854.
    ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B384Cu));
    if (!Core::WGPUDeviceLiveOnThisThread() || !g_framebuffer_manager || !dst)
      return;
    WGPUGfx* gfx = WGPUGfx::GetInstance();
    if (!gfx || !gfx->GetDevice() || !gfx->GetQueue())
      return;
    AbstractTexture* src_tex = params.depth ? g_framebuffer_manager->GetEFBDepthTexture() :
                                              g_framebuffer_manager->GetEFBColorTexture();
    if (!src_tex)
      return;

    const u32 sw = static_cast<u32>(src_rect.GetWidth());
    const u32 sh = static_cast<u32>(src_rect.GetHeight());
    if (sw == 0 || sh == 0 || bytes_per_row == 0 || num_blocks_y == 0)
      return;

    gfx->FlushPendingWork();

    const u32 padded_bpr = ((sw * 4 + 255) / 256) * 256;
    const size_t buf_size = (size_t)padded_bpr * sh;
    WGPUBufferDescriptor bd = {};
    bd.usage = WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst;
    bd.size = buf_size;
    ::WGPUBuffer buffer = wgpuDeviceCreateBuffer(gfx->GetDevice(), &bd);
    if (!buffer)
      return;

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(gfx->GetDevice(), nullptr);
    WGPUTexelCopyTextureInfo tsrc = {};
    tsrc.texture = static_cast<WGPUTexture*>(src_tex)->GetTexture();
    tsrc.mipLevel = 0;
    tsrc.origin = {static_cast<u32>(src_rect.left), static_cast<u32>(src_rect.top), 0};
    tsrc.aspect = params.depth ? WGPUTextureAspect_DepthOnly : WGPUTextureAspect_All;
    WGPUTexelCopyBufferInfo tdst = {};
    tdst.buffer = buffer;
    tdst.layout.offset = 0;
    tdst.layout.bytesPerRow = padded_bpr;
    tdst.layout.rowsPerImage = sh;
    WGPUExtent3D ext = {sw, sh, 1};
    wgpuCommandEncoderCopyTextureToBuffer(enc, &tsrc, &tdst, &ext);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuQueueSubmit(gfx->GetQueue(), 1, &cmd);
    wgpuCommandBufferRelease(cmd);
    wgpuCommandEncoderRelease(enc);

    dst->Map();
    u32 tile_h = 4;
    if (params.copy_format == EFBCopyFormat::R4) tile_h = 8;
    else if (params.copy_format == EFBCopyFormat::XFB) tile_h = 1;
    auto* ctx = new EfbRamCtx{buffer, buf_size, padded_bpr, sw, sh, params.depth,
                              params.copy_format != EFBCopyFormat::XFB && !params.depth &&
                                  IsIntensityFormat(params),
                              params.copy_format, bytes_per_row, num_blocks_y,
                              native_width, num_blocks_y * tile_h,
                              dst->GetMappedPointer(), static_cast<u32>(dst->GetMappedStride())};
    ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3850u));

    // [wgpu xfb-band 2026-07-31] register the pending encode on the staging so the
    // frame-end flush (WGPUStagingTexture::ReadTexels) can DEFER the guest-RAM write to
    // the callback instead of copying stale/zero bytes (the movie green-band race).
    // A prior still-pending encode on a REUSED staging is orphaned (its callback must
    // not scribble the map we now own; if its flush deferred, it still writes its own
    // recorded guest destination).
    {
      auto* wst = static_cast<WGPUStagingTexture*>(dst);
      if (WGPUEfbEncodePending* old = wst->m_pending_encode)
        old->orphaned = true;
      wst->m_pending_encode = &ctx->pending;
      ctx->pending.owner = wst;
    }

    WGPUBufferMapCallbackInfo cb = {};
    cb.mode = WGPUCallbackMode_AllowSpontaneous;
    cb.callback = [](WGPUMapAsyncStatus status, WGPUStringView, void* ud, void*) {
      auto* c = static_cast<EfbRamCtx*>(ud);
      if (status == WGPUMapAsyncStatus_Success)
      {
        const u8* mapped =
            static_cast<const u8*>(wgpuBufferGetConstMappedRange(c->buffer, 0, c->buf_size));
        if (mapped)
        {
          if (c->pending.deferred)
          {
            // Flush ran first: encode STRAIGHT into guest RAM at the recorded
            // destination (never the staging map — it may already belong to a newer
            // copy). Whole-frame write; VI's next fetch sees a complete frame.
            c->dst = static_cast<char*>(c->pending.def_dst);
            c->dst_stride = c->pending.def_stride;
            EncodeEfbToRam(c, mapped);
            ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3854u));
          }
          else if (!c->pending.orphaned)
          {
            EncodeEfbToRam(c, mapped);
            c->pending.encode_done = true;
            // Unregister before delete: a later ReadTexels must take the plain
            // base-copy path (map bytes are valid now), not deref freed ctx.
            if (c->pending.owner && c->pending.owner->m_pending_encode == &c->pending)
              c->pending.owner->m_pending_encode = nullptr;
            ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3854u));
          }
          // orphaned && !deferred: staging reused and no flush destination recorded
          // for this copy — nothing safe to write; drop it.
        }
        wgpuBufferUnmap(c->buffer);
      }
      wgpuBufferRelease(c->buffer);
      delete c;
    };
    cb.userdata1 = ctx;
    wgpuBufferMapAsync(buffer, WGPUMapMode_Read, 0, buf_size, cb);
  }

  // Whether the EFB copy wants intensity (Y) rather than raw color channels. The
  // EFBCopyParams struct carries yuv (XFB) but not the intensity bit directly in this
  // tree revision — I haven't verified a separate intensity field exists; derive from
  // yuv for non-XFB (intensity copies set yuv in BPStructs). Hedge: if wrong, colors
  // in I-format copies stay RGB (still visible content, not garbage).
  static bool IsIntensityFormat(const EFBCopyParams& params) { return params.yuv; }

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
    // [dc device-gate 2026-07-22 — the drain-#59 freeze] The gpu_thread decode reaches this on
    // the boot scene's first EFB copy; BlitToTexture then issues wgpu* calls on a thread with
    // NO WebGPU device (emdawnwebgpu objects are per-thread) and the thread never returns —
    // seq-diag: last drain stamp #59, then 34 producer bursts with zero further GPU stamps, no
    // trap event. Same interim gate as VertexManager Flush (Fifo.cpp [dual-core hybrid]);
    // lifts when the device moves to this thread.
    // [present-diag TEMP PM28] plain SAB counters (EM_ASM prints do NOT relay
    // from this thread): entries @0x026B351C, device-gate skips @0x026B3520,
    // depth skips @0x026B3524, blits executed @0x026B3528.
    ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B351Cu));
    // [render-gaps R1 PM38 TEMP] live config flags @0x026B3858:
    // 0x10 | (bSkipEFBCopyToRam<<1) | bSkipXFBCopyToRam.
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3858u)) =
        0x10u | (g_ActiveConfig.bSkipEFBCopyToRam ? 2u : 0u) |
        (g_ActiveConfig.bSkipXFBCopyToRam ? 1u : 0u);
    if (!Core::WGPUDeviceLiveOnThisThread())
    {
      ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3520u));
      static bool s_gate_logged = false;
      if (!s_gate_logged)
      {
        s_gate_logged = true;
        MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
          '[wgpu] CopyEFBToCacheEntry SKIPPED on non-device thread (interim gate)'}); });
      }
      return;
    }
    if (!entry || !entry->texture || !g_framebuffer_manager)
      return;

    if (is_depth_copy)
    {
      ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3524u));
      // [render-gaps R2 PM38 2026-07-24] was: SKIPPED (lazy-zero black textures for
      // every depth-copy consumer — shadows/DOF). Now: dedicated depth-blit pipeline
      // (textureLoad from the Depth32Float EFB view, reversed-Z undone, depth
      // replicated to RGB — intensity-style Z copy; per-ZFormat byte-encode later).
      AbstractTexture* efb_depth = g_framebuffer_manager->GetEFBDepthTexture();
      WGPUGfx* dgfx = WGPUGfx::GetInstance();
      if (!efb_depth || !dgfx)
        return;
      dgfx->BlitDepthToTexture(static_cast<WGPUTexture*>(efb_depth)->GetTexture(),
                               efb_depth->GetWidth(), efb_depth->GetHeight(), src_rect,
                               static_cast<WGPUTexture*>(entry->texture.get())->GetTexture(),
                               entry->texture->GetWidth(), entry->texture->GetHeight());
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

    ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3528u));
    // [sab-diag PM30 TEMP] blit-source EFB texture identity @0x026B357C.
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B357Cu)) =
        static_cast<u32>(reinterpret_cast<uintptr_t>(
            static_cast<WGPUTexture*>(efb_color)->GetTexture()));
    gfx->BlitToTexture(static_cast<WGPUTexture*>(efb_color)->GetTexture(), efb_color->GetWidth(),
                       efb_color->GetHeight(), src_rect,
                       static_cast<WGPUTexture*>(entry->texture.get())->GetTexture(),
                       entry->texture->GetWidth(), entry->texture->GetHeight(), linear_filter);
  }
};

}  // namespace WGPU
