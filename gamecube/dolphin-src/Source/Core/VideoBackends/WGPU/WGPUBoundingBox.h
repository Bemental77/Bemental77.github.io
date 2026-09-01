// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "Common/CommonTypes.h"

#include "VideoCommon/BoundingBox.h"

namespace WGPU
{
class WGPUBoundingBox final : public BoundingBox
{
public:
  bool Initialize() override { return true; }

protected:
  std::vector<BBoxType> Read(u32 index, u32 length) override
  {
    return std::vector<BBoxType>(length);
  }
  void Write(u32 index, std::span<const BBoxType> values) override {}
};

}  // namespace WGPU
