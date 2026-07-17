// Copyright 2021 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/Software/SWBoundingBox.h"

#include <algorithm>
#include <array>
#include <limits>

#include "Common/CommonTypes.h"

#include "VideoBackends/Software/Rasterizer.h"

namespace BBoxManager
{
namespace
{
// Current bounding box coordinates (the canonical/reduced state, read by Read()).
std::array<u16, 4> s_coordinates{};

// Per-raster-worker partials. Update() runs on worker threads and folds into its own row (no
// race); ReducePartials() merges all rows into s_coordinates (min of lefts/tops, max of
// rights/bottoms — commutative + associative, so the result is exact regardless of band order).
// Each row's identity is {left=MAX, right=0, top=MAX, bottom=0} so it is a no-op until written.
constexpr u16 U16_MAX = std::numeric_limits<u16>::max();
struct PartialBox
{
  u16 left = U16_MAX;
  u16 right = 0;
  u16 top = U16_MAX;
  u16 bottom = 0;
};
std::array<PartialBox, Rasterizer::MaxRasterWorkers()> s_partials{};
}  // Anonymous namespace

u16 GetCoordinate(Coordinate coordinate)
{
  return s_coordinates[static_cast<u32>(coordinate)];
}

void SetCoordinate(Coordinate coordinate, u16 value)
{
  s_coordinates[static_cast<u32>(coordinate)] = value;
}

void Update(u16 left, u16 right, u16 top, u16 bottom)
{
  const int wid = Rasterizer::g_raster_worker_id;
  if (wid == 0)
  {
    // FIFO thread (single-band fast path, and band 0 of a split): write the canonical state
    // directly — bit-identical to the pre-pool behavior.
    SetCoordinate(Coordinate::Left, std::min(left, GetCoordinate(Coordinate::Left)));
    SetCoordinate(Coordinate::Right, std::max(right, GetCoordinate(Coordinate::Right)));
    SetCoordinate(Coordinate::Top, std::min(top, GetCoordinate(Coordinate::Top)));
    SetCoordinate(Coordinate::Bottom, std::max(bottom, GetCoordinate(Coordinate::Bottom)));
    return;
  }
  PartialBox& p = s_partials[wid];
  p.left = std::min(left, p.left);
  p.right = std::max(right, p.right);
  p.top = std::min(top, p.top);
  p.bottom = std::max(bottom, p.bottom);
}

void ReducePartials()
{
  const int n = Rasterizer::NumRasterWorkers();
  for (int w = 1; w < n; w++)  // row 0 is the FIFO thread, written directly by Update()
  {
    PartialBox& p = s_partials[w];
    if (p.left == U16_MAX && p.right == 0 && p.top == U16_MAX && p.bottom == 0)
      continue;  // identity — this band hit no pixels
    SetCoordinate(Coordinate::Left, std::min(p.left, GetCoordinate(Coordinate::Left)));
    SetCoordinate(Coordinate::Right, std::max(p.right, GetCoordinate(Coordinate::Right)));
    SetCoordinate(Coordinate::Top, std::min(p.top, GetCoordinate(Coordinate::Top)));
    SetCoordinate(Coordinate::Bottom, std::max(p.bottom, GetCoordinate(Coordinate::Bottom)));
    p = PartialBox{};  // reset to identity for the next triangle
  }
}

}  // namespace BBoxManager

namespace SW
{
std::vector<BBoxType> SWBoundingBox::Read(u32 index, u32 length)
{
  std::vector<BBoxType> values(length);

  for (u32 i = 0; i < length; i++)
  {
    values[i] = BBoxManager::GetCoordinate(static_cast<BBoxManager::Coordinate>(index + i));
  }

  return values;
}

void SWBoundingBox::Write(u32 index, std::span<const BBoxType> values)
{
  for (size_t i = 0; i < values.size(); i++)
  {
    BBoxManager::SetCoordinate(static_cast<BBoxManager::Coordinate>(index + i), values[i]);
  }
}

}  // namespace SW
