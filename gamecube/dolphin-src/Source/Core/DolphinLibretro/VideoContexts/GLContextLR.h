#pragma once

#include <libretro.h>
#include "Common/GL/GLContext.h"

/* retroGL interface*/
class GLContextLR : public GLContext
{
public:
  GLContextLR();
  ~GLContextLR() override;
  
  bool IsHeadless() const override { return false; }
  void Swap() override;
  void* GetFuncAddress(const std::string& name) override;
  bool Initialize(const WindowSystemInfo& wsi, bool stereo, bool core) override;
  bool IsInitialized() const { return m_initialized; }
  void Shutdown();

private:
  bool m_initialized = false;
};
