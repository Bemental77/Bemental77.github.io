// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "VideoCommon/VideoBackendBase.h"

namespace WGPU
{
class VideoBackend final : public VideoBackendBase
{
public:
  bool Initialize(const WindowSystemInfo& wsi) override;
  void Shutdown() override;

  std::string GetConfigName() const override { return CONFIG_NAME; }
  std::string GetDisplayName() const override;
  void InitBackendInfo(const WindowSystemInfo& wsi) override;

  static constexpr const char* CONFIG_NAME = "WGPU";
};
}  // namespace WGPU
