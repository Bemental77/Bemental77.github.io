// Copyright 2009 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/Software/Rasterizer.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <pthread.h>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/threading.h>
#endif

#include "Common/Assert.h"
#include "Common/CommonTypes.h"

#include "VideoBackends/Software/NativeVertexFormat.h"
#include "VideoBackends/Software/SWBoundingBox.h"
#include "VideoBackends/Software/SWEfbInterface.h"
#include "VideoBackends/Software/Tev.h"
#include "VideoCommon/BPFunctions.h"
#include "VideoCommon/BPMemory.h"
#include "VideoCommon/PerfQueryBase.h"
#include "VideoCommon/Statistics.h"
#include "VideoCommon/VideoCommon.h"
#include "VideoCommon/XFMemory.h"

namespace Rasterizer
{
static constexpr int BLOCK_SIZE = 2;

// Tile-parallel (strategy B) worker pool: each triangle's scanline rows are split into
// MAX_RASTER_WORKERS BLOCK_SIZE-aligned bands. Index 0 = the calling/FIFO thread (runs band 0 in
// place); indices 1..T-1 are persistent worker pthreads. Capped at 4 to stay inside
// PTHREAD_POOL_SIZE (see dolphin_worker_link.sh).
static constexpr int MAX_RASTER_WORKERS = 4;

struct SlopeContext
{
  SlopeContext(const OutputVertexData* v0, const OutputVertexData* v1, const OutputVertexData* v2,
               s32 x0_, s32 y0_, s32 x_off, s32 y_off)
      : x0(x0_), y0(y0_)
  {
    // adjust a little less than 0.5
    const float adjust = 0.495f;

    xOff = ((float)x0_ - (v0->screenPosition.x - x_off)) + adjust;
    yOff = ((float)y0_ - (v0->screenPosition.y - y_off)) + adjust;

    dx10 = v1->screenPosition.x - v0->screenPosition.x;
    dx20 = v2->screenPosition.x - v0->screenPosition.x;
    dy10 = v1->screenPosition.y - v0->screenPosition.y;
    dy20 = v2->screenPosition.y - v0->screenPosition.y;
  }
  s32 x0;
  s32 y0;
  float xOff;
  float yOff;
  float dx10;
  float dx20;
  float dy10;
  float dy20;
};

struct Slope
{
  Slope() = default;
  Slope(float f0_, float f1, float f2, const SlopeContext& ctx) : f0(f0_)
  {
    float delta_20 = f2 - f0_;
    float delta_10 = f1 - f0_;

    //        x2 - x0    y1 - y0    x1 - x0    y2 - y0
    float a = delta_20 * ctx.dy10 - delta_10 * ctx.dy20;
    float b = ctx.dx20 * delta_10 - ctx.dx10 * delta_20;
    float c = ctx.dx20 * ctx.dy10 - ctx.dx10 * ctx.dy20;

    dfdx = a / c;
    dfdy = b / c;

    x0 = ctx.x0;
    y0 = ctx.y0;
    xOff = ctx.xOff;
    yOff = ctx.yOff;
  }

  // These default values are used in the unlikely case that zfreeze is enabled when drawing the
  // first primitive.
  // TODO: This is just a guess!
  float dfdx = 0.0f;
  float dfdy = 0.0f;
  float f0 = 1.0f;

  // Both an s32 value and a float value are used to minimize rounding error
  // TODO: is this really needed?
  s32 x0 = 0;
  s32 y0 = 0;
  float xOff = 0.0f;
  float yOff = 0.0f;

  float GetValue(s32 x, s32 y) const
  {
    float dx = xOff + (float)(x - x0);
    float dy = yOff + (float)(y - y0);
    return f0 + (dfdx * dx) + (dfdy * dy);
  }
};

static Slope ZSlope;
struct RasterContext
{
  Slope WSlope;
  Slope ColorSlopes[2][4];
  Slope TexSlopes[8][3];
  Tev tev;
  RasterBlock rasterBlock;
};
// One context per band. [0] is the calling/FIFO thread's; [1..T-1] are the worker threads'. Each
// owns its own Tev (a Tev CANNOT be shared or memcpy'd — its m_*InputLUT/m_KonstLUT hold const
// refs into that same object's members, so each must be default-constructed in place and rebound).
static RasterContext g_ctx_pool[MAX_RASTER_WORKERS];

// Alias for the FIFO-thread / band-0 context used by the single-threaded entry paths.
static RasterContext& g_ctx = g_ctx_pool[0];

thread_local int g_raster_worker_id = 0;

static std::vector<BPFunctions::ScissorRect> scissors;

// ---------------------------------------------------------------------------------------------
// Tile-parallel worker pool (strategy B). Persistent pthreads parked on a per-worker condvar.
// The FIFO thread fills each worker's job and broadcasts; workers run RasterizeBand on their own
// RasterContext over a disjoint, BLOCK_SIZE-aligned y-band, then signal completion. Real
// pthread mutex/condvar (NOT emscripten_sleep — that deadlocks under ASYNCIFY).
// ---------------------------------------------------------------------------------------------
struct BandJob
{
  // Per-band variable inputs.
  s32 y_begin = 0;
  s32 y_end = 0;
  // Per-primitive invariants (shared by value across all bands of one triangle).
  s32 minx = 0, maxx = 0, miny = 0, maxy = 0, block_minx = 0;
  s32 C1 = 0, C2 = 0, C3 = 0;
  s32 DX12 = 0, DX23 = 0, DX31 = 0;
  s32 DY12 = 0, DY23 = 0, DY31 = 0;
  s32 FDX12 = 0, FDX23 = 0, FDX31 = 0;
  s32 FDY12 = 0, FDY23 = 0, FDY31 = 0;
};

static void RasterizeBand(RasterContext& ctx, s32 y_begin, s32 y_end, s32 minx, s32 maxx, s32 miny,
                          s32 maxy, s32 block_minx, s32 C1, s32 C2, s32 C3, s32 DX12, s32 DX23,
                          s32 DX31, s32 DY12, s32 DY23, s32 DY31, s32 FDX12, s32 FDX23, s32 FDX31,
                          s32 FDY12, s32 FDY23, s32 FDY31);

struct RasterWorker
{
  pthread_t thread{};
  pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
  pthread_cond_t go_cv = PTHREAD_COND_INITIALIZER;
  pthread_cond_t done_cv = PTHREAD_COND_INITIALIZER;
  int wid = 0;
  bool has_job = false;   // a job is pending for this worker
  bool job_done = true;   // the pending job has completed
  bool quit = false;      // shutdown requested
  BandJob job{};
};

static RasterWorker s_workers[MAX_RASTER_WORKERS];  // [0] unused (calling thread runs band 0)
static int s_num_workers = 1;                        // total bands incl. band 0; 1 == no threads
static bool s_pool_started = false;

static void RunJob(const BandJob& j, RasterContext& ctx)
{
  RasterizeBand(ctx, j.y_begin, j.y_end, j.minx, j.maxx, j.miny, j.maxy, j.block_minx, j.C1, j.C2,
                j.C3, j.DX12, j.DX23, j.DX31, j.DY12, j.DY23, j.DY31, j.FDX12, j.FDX23, j.FDX31,
                j.FDY12, j.FDY23, j.FDY31);
}

static void* RasterWorkerMain(void* arg)
{
  RasterWorker* w = static_cast<RasterWorker*>(arg);
  g_raster_worker_id = w->wid;  // per-thread id for the stats/perf/bbox partial routing
  pthread_mutex_lock(&w->mtx);
  for (;;)
  {
    while (!w->has_job && !w->quit)
      pthread_cond_wait(&w->go_cv, &w->mtx);
    if (w->quit)
      break;
    // Snapshot the job, release the lock while rasterizing (the FIFO thread is barriered out).
    BandJob job = w->job;
    w->has_job = false;
    pthread_mutex_unlock(&w->mtx);

    RunJob(job, g_ctx_pool[w->wid]);

    pthread_mutex_lock(&w->mtx);
    w->job_done = true;
    pthread_cond_signal(&w->done_cv);
  }
  pthread_mutex_unlock(&w->mtx);
  return nullptr;
}

int NumRasterWorkers()
{
  return s_num_workers;
}

void InitWorkerPool()
{
  if (s_pool_started)
    return;

  int cores = 1;
#ifdef __EMSCRIPTEN__
  cores = (int)emscripten_num_logical_cores();
#endif
  s_num_workers = std::clamp(cores - 1, 1, MAX_RASTER_WORKERS);

  for (int i = 1; i < s_num_workers; i++)
  {
    RasterWorker& w = s_workers[i];
    w.wid = i;
    w.has_job = false;
    w.job_done = true;
    w.quit = false;
    pthread_create(&w.thread, nullptr, &RasterWorkerMain, &w);
  }
  s_pool_started = true;
}

void ShutdownWorkerPool()
{
  if (!s_pool_started)
    return;
  for (int i = 1; i < s_num_workers; i++)
  {
    RasterWorker& w = s_workers[i];
    pthread_mutex_lock(&w.mtx);
    w.quit = true;
    pthread_cond_signal(&w.go_cv);
    pthread_mutex_unlock(&w.mtx);
    pthread_join(w.thread, nullptr);
  }
  s_num_workers = 1;
  s_pool_started = false;
}

void Init()
{
  // The other slopes are set each for each primitive drawn, but zfreeze means that the z slope
  // needs to be set to an (untested) default value.
  ZSlope = Slope();
}

void ScissorChanged()
{
  auto scissor_result = BPFunctions::ComputeScissorRects(bpmem.scissorTL, bpmem.scissorBR,
                                                         bpmem.scissorOffset, xfmem.viewport);
  scissors = std::move(scissor_result.rectangles);
}

// Returns approximation of log2(f) in s28.4
// results are close enough to use for LOD
static s32 FixedLog2(float f)
{
  u32 x;
  std::memcpy(&x, &f, sizeof(u32));

  s32 logInt = ((x & 0x7F800000) >> 19) - 2032;  // integer part
  s32 logFract = (x & 0x007fffff) >> 19;         // approximate fractional part

  return logInt + logFract;
}

static inline int iround(float x)
{
  int t = (int)x;
  if ((x - t) >= 0.5)
    return t + 1;

  return t;
}

void SetTevKonstColors()
{
  // Every worker's Tev needs its own konst colors — a Tev cannot be shared, and the per-band
  // SetupStages() konst refs read each ctx's own KonstantColors. Set ALL contexts, not just [0].
  for (auto& ctx : g_ctx_pool)
    ctx.tev.SetKonstColors();
}

static void Draw(RasterContext& ctx, s32 x, s32 y, s32 xi, s32 yi)
{
  // g_stats is non-atomic and diagnostic-only; under MT only count on the FIFO thread (band 0) to
  // avoid torn increments. The lost worker-band pixels are accepted (sanctioned in the design).
  if (g_raster_worker_id == 0)
    INCSTAT(g_stats.this_frame.rasterized_pixels);

  s32 z = (s32)std::clamp<float>(ZSlope.GetValue(x, y), 0.0f, 16777215.0f);

  if (bpmem.GetEmulatedZ() == EmulatedZ::Early)
  {
    // TODO: Test if perf regs are incremented even if test is disabled
    EfbInterface::IncPerfCounterQuadCount(PQ_ZCOMP_INPUT_ZCOMPLOC);
    if (bpmem.zmode.test_enable)
    {
      // early z
      if (!EfbInterface::ZCompare(x, y, z))
        return;
    }
    EfbInterface::IncPerfCounterQuadCount(PQ_ZCOMP_OUTPUT_ZCOMPLOC);
  }

  RasterBlockPixel& pixel = ctx.rasterBlock.Pixel[xi][yi];

  ctx.tev.Position[0] = x;
  ctx.tev.Position[1] = y;
  ctx.tev.Position[2] = z;

  //  colors
  for (unsigned int i = 0; i < bpmem.genMode.numcolchans; i++)
  {
    for (int comp = 0; comp < 4; comp++)
    {
      const float color = ctx.ColorSlopes[i][comp].GetValue(x, y);
      ctx.tev.Color[i][comp] = (u8)std::clamp<float>(color, 0.0f, 255.0f);
    }
  }

  // tex coords
  for (unsigned int i = 0; i < bpmem.genMode.numtexgens; i++)
  {
    // multiply by 128 because TEV stores UVs as s17.7
    ctx.tev.Uv[i].s = (s32)(pixel.Uv[i][0] * 128);
    ctx.tev.Uv[i].t = (s32)(pixel.Uv[i][1] * 128);
  }

  for (unsigned int i = 0; i < bpmem.genMode.numindstages; i++)
  {
    ctx.tev.IndirectLod[i] = ctx.rasterBlock.IndirectLod[i];
    ctx.tev.IndirectLinear[i] = ctx.rasterBlock.IndirectLinear[i];
  }

  for (unsigned int i = 0; i <= bpmem.genMode.numtevstages; i++)
  {
    ctx.tev.TextureLod[i] = ctx.rasterBlock.TextureLod[i];
    ctx.tev.TextureLinear[i] = ctx.rasterBlock.TextureLinear[i];
  }

  ctx.tev.Draw();
}

static inline void CalculateLOD(RasterContext& ctx, s32* lodp, bool* linear, u32 texmap,
                                u32 texcoord)
{
  auto texUnit = bpmem.tex.GetUnit(texmap);

  // LOD calculation requires data from the texture mode for bias, etc.
  // it does not seem to use the actual texture size
  const TexMode0& tm0 = texUnit.texMode0;
  const TexMode1& tm1 = texUnit.texMode1;

  float sDelta, tDelta;

  float* uv00 = ctx.rasterBlock.Pixel[0][0].Uv[texcoord];
  float* uv10 = ctx.rasterBlock.Pixel[1][0].Uv[texcoord];
  float* uv01 = ctx.rasterBlock.Pixel[0][1].Uv[texcoord];

  float dudx = fabsf(uv00[0] - uv10[0]);
  float dvdx = fabsf(uv00[1] - uv10[1]);
  float dudy = fabsf(uv00[0] - uv01[0]);
  float dvdy = fabsf(uv00[1] - uv01[1]);

  if (tm0.diag_lod == LODType::Diagonal)
  {
    sDelta = dudx + dudy;
    tDelta = dvdx + dvdy;
  }
  else
  {
    sDelta = std::max(dudx, dudy);
    tDelta = std::max(dvdx, dvdy);
  }

  // get LOD in s28.4
  s32 lod = FixedLog2(std::max(sDelta, tDelta));

  // bias is s2.5
  int bias = tm0.lod_bias;
  bias >>= 1;
  lod += bias;

  *linear = ((lod > 0 && tm0.min_filter == FilterMode::Linear) ||
             (lod <= 0 && tm0.mag_filter == FilterMode::Linear));

  // NOTE: The order of comparisons for this clamp check matters.
  if (lod > static_cast<s32>(tm1.max_lod))
    lod = static_cast<s32>(tm1.max_lod);
  else if (lod < static_cast<s32>(tm1.min_lod))
    lod = static_cast<s32>(tm1.min_lod);

  *lodp = lod;
}

static void BuildBlock(RasterContext& ctx, s32 blockX, s32 blockY)
{
  for (s32 yi = 0; yi < BLOCK_SIZE; yi++)
  {
    for (s32 xi = 0; xi < BLOCK_SIZE; xi++)
    {
      RasterBlockPixel& pixel = ctx.rasterBlock.Pixel[xi][yi];

      s32 x = xi + blockX;
      s32 y = yi + blockY;

      float invW = 1.0f / ctx.WSlope.GetValue(x, y);
      pixel.InvW = invW;

      // tex coords
      for (unsigned int i = 0; i < bpmem.genMode.numtexgens; i++)
      {
        float projection = invW;
        float q = ctx.TexSlopes[i][2].GetValue(x, y) * invW;
        if (q != 0.0f)
          projection = invW / q;

        pixel.Uv[i][0] = ctx.TexSlopes[i][0].GetValue(x, y) * projection;
        pixel.Uv[i][1] = ctx.TexSlopes[i][1].GetValue(x, y) * projection;
      }
    }
  }

  for (unsigned int i = 0; i < bpmem.genMode.numindstages; i++)
  {
    u32 texmap = bpmem.tevindref.getTexMap(i);
    u32 texcoord = bpmem.tevindref.getTexCoord(i);

    CalculateLOD(ctx, &ctx.rasterBlock.IndirectLod[i], &ctx.rasterBlock.IndirectLinear[i], texmap,
                 texcoord);
  }

  for (unsigned int i = 0; i <= bpmem.genMode.numtevstages; i++)
  {
    int stageOdd = i & 1;
    const TwoTevStageOrders& order = bpmem.tevorders[i >> 1];
    if (order.getEnable(stageOdd))
    {
      u32 texmap = order.getTexMap(stageOdd);
      u32 texcoord = order.getTexCoord(stageOdd);

      CalculateLOD(ctx, &ctx.rasterBlock.TextureLod[i], &ctx.rasterBlock.TextureLinear[i], texmap,
                   texcoord);
    }
  }
}

void UpdateZSlope(const OutputVertexData* v0, const OutputVertexData* v1,
                  const OutputVertexData* v2, s32 x_off, s32 y_off)
{
  if (!bpmem.genMode.zfreeze)
  {
    const s32 X1 = iround(16.0f * (v0->screenPosition.x - x_off)) - 9;
    const s32 Y1 = iround(16.0f * (v0->screenPosition.y - y_off)) - 9;
    const SlopeContext ctx(v0, v1, v2, (X1 + 0xF) >> 4, (Y1 + 0xF) >> 4, x_off, y_off);
    ZSlope = Slope(v0->screenPosition.z, v1->screenPosition.z, v2->screenPosition.z, ctx);
  }
}

// Rasterizes a horizontal band of 2x2 blocks for a single primitive, covering scanline rows in
// [y_begin, y_end). y_begin must already be aligned down to a BLOCK_SIZE multiple and stepped by
// BLOCK_SIZE, matching the original full-triangle block loop. All edge/half-edge constants and the
// (scissor-clamped) bounding box are per-primitive invariants passed by value from
// DrawTriangleFrontFace; the per-pixel slopes/tev/rasterBlock state lives in ctx, and ZSlope/bpmem
// are globals. STEP 4 will invoke this once per worker thread with disjoint [y_begin, y_end) ranges.
static void RasterizeBand(RasterContext& ctx, s32 y_begin, s32 y_end, s32 minx, s32 maxx, s32 miny,
                          s32 maxy, s32 block_minx, s32 C1, s32 C2, s32 C3, s32 DX12, s32 DX23,
                          s32 DX31, s32 DY12, s32 DY23, s32 DY31, s32 FDX12, s32 FDX23, s32 FDX31,
                          s32 FDY12, s32 FDY23, s32 FDY31)
{
  // Loop through blocks
  for (s32 y = y_begin; y < y_end; y += BLOCK_SIZE)
  {
    for (s32 x = block_minx; x < maxx; x += BLOCK_SIZE)
    {
      s32 x1_ = (x + BLOCK_SIZE - 1);
      s32 y1_ = (y + BLOCK_SIZE - 1);

      // Corners of block
      s32 x0 = x << 4;
      s32 x1 = x1_ << 4;
      s32 y0 = y << 4;
      s32 y1 = y1_ << 4;

      // Evaluate half-space functions
      bool a00 = C1 + DX12 * y0 - DY12 * x0 > 0;
      bool a10 = C1 + DX12 * y0 - DY12 * x1 > 0;
      bool a01 = C1 + DX12 * y1 - DY12 * x0 > 0;
      bool a11 = C1 + DX12 * y1 - DY12 * x1 > 0;
      int a = (a00 << 0) | (a10 << 1) | (a01 << 2) | (a11 << 3);

      bool b00 = C2 + DX23 * y0 - DY23 * x0 > 0;
      bool b10 = C2 + DX23 * y0 - DY23 * x1 > 0;
      bool b01 = C2 + DX23 * y1 - DY23 * x0 > 0;
      bool b11 = C2 + DX23 * y1 - DY23 * x1 > 0;
      int b = (b00 << 0) | (b10 << 1) | (b01 << 2) | (b11 << 3);

      bool c00 = C3 + DX31 * y0 - DY31 * x0 > 0;
      bool c10 = C3 + DX31 * y0 - DY31 * x1 > 0;
      bool c01 = C3 + DX31 * y1 - DY31 * x0 > 0;
      bool c11 = C3 + DX31 * y1 - DY31 * x1 > 0;
      int c = (c00 << 0) | (c10 << 1) | (c01 << 2) | (c11 << 3);

      // Skip block when outside an edge
      if (a == 0x0 || b == 0x0 || c == 0x0)
        continue;

      BuildBlock(ctx, x, y);

      // Accept whole block when totally covered
      // We still need to check min/max x/y because of the scissor
      if (a == 0xF && b == 0xF && c == 0xF && x >= minx && x1_ < maxx && y >= miny && y1_ < maxy)
      {
        for (s32 iy = 0; iy < BLOCK_SIZE; iy++)
        {
          for (s32 ix = 0; ix < BLOCK_SIZE; ix++)
          {
            Draw(ctx, x + ix, y + iy, ix, iy);
          }
        }
      }
      else  // Partially covered block
      {
        s32 CY1 = C1 + DX12 * y0 - DY12 * x0;
        s32 CY2 = C2 + DX23 * y0 - DY23 * x0;
        s32 CY3 = C3 + DX31 * y0 - DY31 * x0;

        for (s32 iy = 0; iy < BLOCK_SIZE; iy++)
        {
          s32 CX1 = CY1;
          s32 CX2 = CY2;
          s32 CX3 = CY3;

          for (s32 ix = 0; ix < BLOCK_SIZE; ix++)
          {
            if (CX1 > 0 && CX2 > 0 && CX3 > 0)
            {
              // This check enforces the scissor rectangle, since it might not be aligned with the
              // blocks
              if (x + ix >= minx && x + ix < maxx && y + iy >= miny && y + iy < maxy)
                Draw(ctx, x + ix, y + iy, ix, iy);
            }

            CX1 -= FDY12;
            CX2 -= FDY23;
            CX3 -= FDY31;
          }

          CY1 += FDX12;
          CY2 += FDX23;
          CY3 += FDX31;
        }
      }
    }
  }
}

static void DrawTriangleFrontFace(RasterContext& ctx, const OutputVertexData* v0,
                                  const OutputVertexData* v1, const OutputVertexData* v2,
                                  const BPFunctions::ScissorRect& scissor)
{
  // The zslope should be updated now, even if the triangle is rejected by the scissor test, as
  // zfreeze depends on it
  UpdateZSlope(v0, v1, v2, scissor.x_off, scissor.y_off);

  // adapted from http://devmaster.net/posts/6145/advanced-rasterization

  // 28.4 fixed-point coordinates. rounded to nearest and adjusted to match hardware output
  // could also take floor and adjust -8
  const s32 Y1 = iround(16.0f * (v0->screenPosition.y - scissor.y_off)) - 9;
  const s32 Y2 = iround(16.0f * (v1->screenPosition.y - scissor.y_off)) - 9;
  const s32 Y3 = iround(16.0f * (v2->screenPosition.y - scissor.y_off)) - 9;

  const s32 X1 = iround(16.0f * (v0->screenPosition.x - scissor.x_off)) - 9;
  const s32 X2 = iround(16.0f * (v1->screenPosition.x - scissor.x_off)) - 9;
  const s32 X3 = iround(16.0f * (v2->screenPosition.x - scissor.x_off)) - 9;

  // Deltas
  const s32 DX12 = X1 - X2;
  const s32 DX23 = X2 - X3;
  const s32 DX31 = X3 - X1;

  const s32 DY12 = Y1 - Y2;
  const s32 DY23 = Y2 - Y3;
  const s32 DY31 = Y3 - Y1;

  // Fixed-point deltas
  const s32 FDX12 = DX12 * 16;
  const s32 FDX23 = DX23 * 16;
  const s32 FDX31 = DX31 * 16;

  const s32 FDY12 = DY12 * 16;
  const s32 FDY23 = DY23 * 16;
  const s32 FDY31 = DY31 * 16;

  // Bounding rectangle
  s32 minx = (std::min(std::min(X1, X2), X3) + 0xF) >> 4;
  s32 maxx = (std::max(std::max(X1, X2), X3) + 0xF) >> 4;
  s32 miny = (std::min(std::min(Y1, Y2), Y3) + 0xF) >> 4;
  s32 maxy = (std::max(std::max(Y1, Y2), Y3) + 0xF) >> 4;

  // scissor
  ASSERT(scissor.rect.left >= 0);
  ASSERT(scissor.rect.right <= static_cast<int>(EFB_WIDTH));
  ASSERT(scissor.rect.top >= 0);
  ASSERT(scissor.rect.bottom <= static_cast<int>(EFB_HEIGHT));

  minx = std::max(minx, scissor.rect.left);
  maxx = std::min(maxx, scissor.rect.right);
  miny = std::max(miny, scissor.rect.top);
  maxy = std::min(maxy, scissor.rect.bottom);

  if (minx >= maxx || miny >= maxy)
    return;

  // Set up the remaining slopes
  const SlopeContext slope_ctx(v0, v1, v2, (X1 + 0xF) >> 4, (Y1 + 0xF) >> 4, scissor.x_off,
                               scissor.y_off);

  float w[3] = {1.0f / v0->projectedPosition.w, 1.0f / v1->projectedPosition.w,
                1.0f / v2->projectedPosition.w};
  ctx.WSlope = Slope(w[0], w[1], w[2], slope_ctx);

  for (unsigned int i = 0; i < bpmem.genMode.numcolchans; i++)
  {
    for (int comp = 0; comp < 4; comp++)
      ctx.ColorSlopes[i][comp] =
          Slope(v0->color[i][comp], v1->color[i][comp], v2->color[i][comp], slope_ctx);
  }

  for (unsigned int i = 0; i < bpmem.genMode.numtexgens; i++)
  {
    ctx.TexSlopes[i][0] = Slope(v0->texCoords[i].x * w[0], v1->texCoords[i].x * w[1],
                                v2->texCoords[i].x * w[2], slope_ctx);
    ctx.TexSlopes[i][1] = Slope(v0->texCoords[i].y * w[0], v1->texCoords[i].y * w[1],
                                v2->texCoords[i].y * w[2], slope_ctx);
    ctx.TexSlopes[i][2] = Slope(v0->texCoords[i].z * w[0], v1->texCoords[i].z * w[1],
                                v2->texCoords[i].z * w[2], slope_ctx);
  }

  // Hoist per-primitive-invariant TEV stage state out of the per-pixel tev.Draw() hot loop.
  // bpmem cannot change between here and the pixel loop below (it only changes via FIFO BP-writes
  // between draw calls, never during rasterization of a primitive), so this is computed exactly
  // once per primitive and read by every tev.Draw() pixel.
  ctx.tev.SetupStages();

  // Half-edge constants
  s32 C1 = DY12 * X1 - DX12 * Y1;
  s32 C2 = DY23 * X2 - DX23 * Y2;
  s32 C3 = DY31 * X3 - DX31 * Y3;

  // Correct for fill convention
  if (DY12 < 0 || (DY12 == 0 && DX12 > 0))
    C1++;
  if (DY23 < 0 || (DY23 == 0 && DX23 > 0))
    C2++;
  if (DY31 < 0 || (DY31 == 0 && DX31 > 0))
    C3++;

  // Start in corner of 2x2 block
  s32 block_minx = minx & ~(BLOCK_SIZE - 1);
  s32 block_miny = miny & ~(BLOCK_SIZE - 1);

  const s32 y_start = block_miny & ~(BLOCK_SIZE - 1);

  const s32 total_rows = maxy - y_start;
  const s32 block_rows = (total_rows + BLOCK_SIZE - 1) / BLOCK_SIZE;

  // Choose how many bands to actually use. Splitting a triangle costs a per-band slope copy +
  // SetupStages() + a condvar signal + a barrier wait; on the intro's many SMALL triangles that
  // fixed cost dominates if each band gets only a row or two. So only hand a band to a worker when
  // it would own at least MIN_BLOCK_ROWS_PER_BAND 2x2 block-rows, and never more bands than the
  // pool provides. A triangle too short to fill 2 bands runs entirely on the calling thread
  // (bit-identical to the pre-pool path) — no thread hop, no barrier.
  static constexpr s32 MIN_BLOCK_ROWS_PER_BAND = 12;  // 24 scanlines / band before it's worth it
  int T = std::min<int>(s_num_workers, std::max<s32>(1, block_rows / MIN_BLOCK_ROWS_PER_BAND));
  if (T <= 1)
  {
    RasterizeBand(ctx, y_start, maxy, minx, maxx, miny, maxy, block_minx, C1, C2, C3, DX12, DX23,
                  DX31, DY12, DY23, DY31, FDX12, FDX23, FDX31, FDY12, FDY23, FDY31);
    return;
  }

  // Split [y_start, maxy) into T contiguous BLOCK_SIZE-aligned bands. Misaligned bands would make
  // two workers touch the same 2x2 block -> double-blend + EFB data race, so every band start is
  // floored to a BLOCK_SIZE multiple. Distribute the block-rows as evenly as possible across bands.
  const s32 base = block_rows / T;
  const s32 extra = block_rows % T;

  // Per-band setup: each worker's context needs its OWN slopes + its OWN SetupStages() result.
  // A Tev cannot be shared or memcpy'd, but Slope is a copyable POD; copy the resolved slopes from
  // g_ctx_pool[0] into each worker ctx, then run SetupStages() against that ctx's own Tev (cheap,
  // reads shared read-only bpmem, writes that ctx's own m_StageCache). Konst colors were already
  // set on every ctx by SetTevKonstColors().
  for (int b = 1; b < T; b++)
  {
    RasterContext& wctx = g_ctx_pool[b];
    wctx.WSlope = ctx.WSlope;
    std::memcpy(wctx.ColorSlopes, ctx.ColorSlopes, sizeof(ctx.ColorSlopes));
    std::memcpy(wctx.TexSlopes, ctx.TexSlopes, sizeof(ctx.TexSlopes));
    wctx.tev.SetupStages();
  }

  // Compute the band boundaries, dispatch bands 1..T-1 to the workers, run band 0 in-place.
  s32 band_y = y_start;
  for (int b = 0; b < T; b++)
  {
    const s32 rows_b = (base + (b < extra ? 1 : 0)) * BLOCK_SIZE;
    s32 y_begin = band_y;
    s32 y_end = std::min(band_y + rows_b, maxy);
    band_y = y_end;

    if (b == 0)
      continue;  // band 0 runs last, in place, so the FIFO thread overlaps with the workers

    RasterWorker& wkr = s_workers[b];
    pthread_mutex_lock(&wkr.mtx);
    BandJob& j = wkr.job;
    j.y_begin = y_begin;
    j.y_end = y_end;
    j.minx = minx;
    j.maxx = maxx;
    j.miny = miny;
    j.maxy = maxy;
    j.block_minx = block_minx;
    j.C1 = C1;
    j.C2 = C2;
    j.C3 = C3;
    j.DX12 = DX12;
    j.DX23 = DX23;
    j.DX31 = DX31;
    j.DY12 = DY12;
    j.DY23 = DY23;
    j.DY31 = DY31;
    j.FDX12 = FDX12;
    j.FDX23 = FDX23;
    j.FDX31 = FDX31;
    j.FDY12 = FDY12;
    j.FDY23 = FDY23;
    j.FDY31 = FDY31;
    wkr.has_job = true;
    wkr.job_done = false;
    pthread_cond_signal(&wkr.go_cv);
    pthread_mutex_unlock(&wkr.mtx);
  }

  // Band 0 on the calling thread (overlaps the workers' bands).
  {
    const s32 rows_0 = (base + (0 < extra ? 1 : 0)) * BLOCK_SIZE;
    const s32 y0_end = std::min(y_start + rows_0, maxy);
    RasterizeBand(g_ctx_pool[0], y_start, y0_end, minx, maxx, miny, maxy, block_minx, C1, C2, C3,
                  DX12, DX23, DX31, DY12, DY23, DY31, FDX12, FDX23, FDX31, FDY12, FDY23, FDY31);
  }

  // Barrier: wait for every dispatched worker band to finish before this triangle returns (so the
  // next primitive / BP command sees a fully-rasterized EFB). Real condvar wait, no busy-yield.
  for (int b = 1; b < T; b++)
  {
    RasterWorker& wkr = s_workers[b];
    pthread_mutex_lock(&wkr.mtx);
    while (!wkr.job_done)
      pthread_cond_wait(&wkr.done_cv, &wkr.mtx);
    pthread_mutex_unlock(&wkr.mtx);
  }

  // Reduce the per-worker non-atomic partials (perf-query counters + bounding box) into the
  // canonical slots now that all bands are complete. g_stats is diagnostic-only and dropped on
  // worker threads (see the INCSTAT sites).
  EfbInterface::ReducePerfPartials();
  BBoxManager::ReducePartials();
}

void DrawTriangleFrontFace(const OutputVertexData* v0, const OutputVertexData* v1,
                           const OutputVertexData* v2)
{
  INCSTAT(g_stats.this_frame.num_triangles_drawn);

  for (const auto& scissor : scissors)
    DrawTriangleFrontFace(g_ctx, v0, v1, v2, scissor);
}
}  // namespace Rasterizer
