// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "Common/CommonTypes.h"

struct OutputVertexData;

namespace Rasterizer
{
// Tile-parallel raster pool. Index 0 is the calling/FIFO thread; 1..N-1 are worker pthreads.
// Must be <= the MAX_RASTER_WORKERS cap in Rasterizer.cpp (and PTHREAD_POOL_SIZE in the link).
constexpr int MaxRasterWorkers() { return 4; }

// Per-thread raster worker id, used by the per-pixel statistics / perf-query / bounding-box sinks
// (which run on worker threads) to accumulate into a disjoint per-worker partial that the FIFO
// thread reduces at the end-of-triangle barrier. Defaults to 0 (the FIFO thread and any
// non-raster thread). Set once per worker thread when the pool spawns.
extern thread_local int g_raster_worker_id;

// Number of bands/contexts currently in use for a triangle (1..MaxRasterWorkers()). Read by the
// reduction paths so they only fold the live worker slots. Stable after InitWorkerPool().
int NumRasterWorkers();

// Spawn / join the persistent raster worker pool. Called from VideoSoftware::Initialize /
// ::Shutdown. Spawn is idempotent; shutdown joins all workers.
void InitWorkerPool();
void ShutdownWorkerPool();

void Init();
void ScissorChanged();

void UpdateZSlope(const OutputVertexData* v0, const OutputVertexData* v1,
                  const OutputVertexData* v2, s32 x_off, s32 y_off);
void DrawTriangleFrontFace(const OutputVertexData* v0, const OutputVertexData* v1,
                           const OutputVertexData* v2);

void SetTevKonstColors();

struct RasterBlockPixel
{
  float InvW;
  float Uv[8][2];
};

struct RasterBlock
{
  RasterBlockPixel Pixel[2][2];
  s32 IndirectLod[4];
  bool IndirectLinear[4];
  s32 TextureLod[16];
  bool TextureLinear[16];
};
}  // namespace Rasterizer
