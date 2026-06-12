// Copyright 2019 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <d3d11_4.h>
#include <memory>
#include <vector>

#include "Common/CommonTypes.h"
#include "Common/WindowSystemInfo.h"
#include "VideoBackends/D3D/D3DBase.h"
#include "VideoBackends/D3DCommon/SwapChain.h"
#include "VideoCommon/TextureConfig.h"
#ifdef __LIBRETRO__
#include "VideoBackends/D3D/DXTexture.h"
#endif

namespace DX11
{
class DXTexture;
class DXFramebuffer;

class SwapChain : public D3DCommon::SwapChain
{
public:
  SwapChain(const WindowSystemInfo& wsi, IDXGIFactory* dxgi_factory, ID3D11Device* d3d_device);
  ~SwapChain();

  static std::unique_ptr<SwapChain> Create(const WindowSystemInfo& wsi);

  DXTexture* GetTexture() const { return m_texture.get(); }
  DXFramebuffer* GetFramebuffer() const { return m_framebuffer.get(); }

#ifdef __LIBRETRO__
  void SetTexture(std::unique_ptr<DXTexture> texture)
  {
    m_texture = std::move(texture);
  }
  void SetFramebuffer(std::unique_ptr<DXFramebuffer> buffer)
  {
    m_framebuffer = std::move(buffer);
  }
#endif
protected:
  bool CreateSwapChainBuffers() override;
  void DestroySwapChainBuffers() override;

  // The runtime takes care of renaming the buffers.
  std::unique_ptr<DXTexture> m_texture;
  std::unique_ptr<DXFramebuffer> m_framebuffer;
};

}  // namespace DX11
