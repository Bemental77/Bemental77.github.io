// Copyright 2026 Bemental
// SPDX-License-Identifier: GPL-2.0-or-later
//
// [render-stage split 2026-08-29 — TEMPORARY DIAGNOSTIC, gate #8: remove before
//  quoting any perf number] Splits _recomp_render_fifo into its real components.
//
// The whole render stage is already known to be 94-97% _recomp_render_fifo
// (worker_funcs.js:924-932 prep/fifo/present timers), and the wasm vertex loader
// is >= 35.4% of it by Amdahl on a measured 1.547x. This header answers what the
// REST is: FIFO opcode decode/walk, BP/XF register writes, texture cache,
// constants, pipeline state, or WGPU submission.
//
// TIMERS ARE RUNTIME-GATED, COUNTERS ARE NOT. Every Scope reads kEnableCell
// first, so with the cell at 0 (SAB is browser-zeroed => cold boot is OFF) the
// binary pays one volatile u32 load per scope and nothing else. The opcode/draw
// COUNTERS are always live (a plain increment) because the matched-pair rig needs
// draws-per-frame to tell the 1300-draw board frame apart from a 1-draw menu
// frame, and it must be able to do that WITHOUT arming the timers.
//
// TIMER COST IS MEASURED, NOT ASSUMED. emscripten_get_now() is a wasm->JS call
// and is NOT free at this call density. kTimerPair times kCalReads back-to-back
// reads once per _recomp_render_fifo, so the per-call cost is known in-situ and
// the raw split can be corrected by (reads x cost) instead of hand-waved. The
// ARBITER is still the ablation matched pair, which has zero timer cost.
//
// Cells, all below the 0x026B3C00 powerpc-next FPR spill window
// (fpr_reg_cache.cpp:335) and above the 0x026B3B1C top of the FIFO-brake block:
//   0x026B3B20  enable (0 = timers off)
//   0x026B3B24  spare
//   0x026B3B28  ablation-hit counter, ARM A  (WGPUGfx::DrawIndexed)
//   0x026B3B2C  ablation-hit counter, ARM B  (VertexManagerBase::Flush)
//   0x026B3B30  ablation-hit counter, ARM A' (VertexManagerBase::RenderDrawCall)
//   0x026B3B40..0x026B3B97  11 x f64 accumulated ms
//   0x026B3B98..0x026B3BDB  17 x u32 call counts

#pragma once

#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace BemStage
{
enum : int
{
  // --- timed regions ---
  kVtxLoad = 0,  // VertexLoaderBase::RunVertices — emitted/software vertex decode
  kTexCache,     // g_texture_cache->Load + GetSamplerState + BindTextures
  kConstants,    // CalculateNormals + VertexShaderManager::SetConstants + CalculateZSlope
  kPipeline,     // UpdatePipelineConfig + UpdatePipelineObject (shader/pipeline lookup)
  kDrawCall,     // RenderDrawCall — uniform upload + CommitBuffer + DrawCurrentBatch
  kFlush,        // whole VertexManagerBase::Flush body (SUPERSET of kTexCache..kDrawCall)
  kFifoTotal,    // whole recomp_render_fifo (SUPERSET of everything)
  kTimerPair,    // calibration: kCalReads back-to-back clock reads, once per frame
  kPeekCache,    // g_framebuffer_manager->RefreshPeekCache() (once per frame)
  kBPReg,        // OnBP -> LoadBPReg  (EFB copies + texture invalidation live here)
  kXFReg,        // OnXF -> LoadXFReg
  kTimedCount,
  // --- counters only (always live) ---
  kNBP = kTimedCount,  // opcode census, so the timed shares can be read per call
  kNXF,
  kNCP,
  kNIdx,
  kNDL,
  kFrames,  // recomp_render_fifo calls — the always-on frame witness
  kCount
};

inline constexpr int kCalReads = 64;  // calibration reads per frame

inline constexpr std::uintptr_t kEnableCell = 0x026B3B20u;
inline constexpr std::uintptr_t kAblAHitCell = 0x026B3B28u;
inline constexpr std::uintptr_t kAblBHitCell = 0x026B3B2Cu;
inline constexpr std::uintptr_t kAblApHitCell = 0x026B3B30u;
// ARM C — skip the two per-batch wgpuQueueWriteBuffer calls in
// WGPUVertexManager::CommitBuffer (vertex + index). Isolates the UPLOAD half of
// the 35.5% that ARM A' removes from the ENCODE half that ARM A removes.
inline constexpr std::uintptr_t kAblUploadCell = 0x026B3B38u;
inline constexpr std::uintptr_t kAblUploadHitCell = 0x026B3B3Cu;
// ARM D — skip LoadBPReg in OpcodeDecoder::OnBP. 5840 BP register writes per
// board frame is the largest opcode class in the stream and it is pure CPU (no
// WebGPU boundary), so timing it was impossible (18k clock reads/frame) but
// ablating it is free.
inline constexpr std::uintptr_t kAblBPCell = 0x026B3B34u;
inline constexpr std::uintptr_t kAblBPHitCell = 0x026B3B24u;
// [LEVER: upload coalescing 2026-08-29] Cell 0x026B3930 nonzero => CommitBuffer
// stages each batch into a ring MIRROR and the whole frame's bytes go up in ONE
// wgpuQueueWriteBuffer per ring at submit time, instead of two per batch. Sized
// by ARM C: 208 writeBuffer calls per board frame cost 3.97 ms = 18.9% of the
// render stage, i.e. ~19 us per call for ~500 bytes — pure call overhead.
// DEFAULT OFF (SAB is browser-zeroed), so it is an A/B arm, not a behaviour change.
inline constexpr std::uintptr_t kCoalesceCell = 0x026B3930u;
inline constexpr std::uintptr_t kCoalesceHitCell = 0x026B3934u;
// [why the coalescing lever nulled] Always-on census: WGPUGfx::SubmitFrame calls
// (0x026B3938) and total bytes handed to wgpuQueueWriteBuffer for the vertex+index
// rings (0x026B393C). If submits/frame is ~= batches/frame, coalescing collapses
// nothing; if it is ~1 and the bytes are unchanged, the cost is per-BYTE not
// per-CALL. One of those two is the reason.
inline constexpr std::uintptr_t kSubmitCountCell = 0x026B3938u;
inline constexpr std::uintptr_t kUploadBytesCell = 0x026B393Cu;
// [LEVER 2: redundant render-pass state elimination 2026-08-29] Cell 0x026B3940
// nonzero => WGPUGfx::DrawIndexed skips a SetPipeline / SetVertexBuffer /
// SetIndexBuffer / SetBindGroup whose arguments are byte-identical to what is
// already bound in THIS render pass. Sized by ARM A: the 5 encoder calls per draw
// cost 3.59 ms = 17.0% of the render stage, and the two buffer binds are
// (buffer, 0, WHOLE_SIZE) on literally every non-fold draw. 0x026B3944 counts
// SKIPPED calls, so only this arm can advance it. DEFAULT OFF.
inline constexpr std::uintptr_t kRedundantStateCell = 0x026B3940u;
inline constexpr std::uintptr_t kRedundantStateHitCell = 0x026B3944u;
inline constexpr std::uintptr_t kMsBase = 0x026B3B40u;  // 11 x f64
inline constexpr std::uintptr_t kNBase = 0x026B3B98u;   // 17 x u32

inline double g_ms[kTimedCount] = {};
inline std::uint32_t g_n[kCount] = {};

inline bool Enabled()
{
  return *reinterpret_cast<volatile std::uint32_t*>(kEnableCell) != 0u;
}

inline double Now()
{
#ifdef __EMSCRIPTEN__
  return emscripten_get_now();
#else
  return 0.0;
#endif
}

// Always-live counter bump — a plain increment, no clock read, no gate.
inline void Bump(int slot)
{
  g_n[slot]++;
}

// RAII so the early-returns inside Flush() cannot leak a region.
class Scope
{
public:
  explicit Scope(int stage) : m_stage(stage), m_on(Enabled())
  {
    if (m_on)
      m_t0 = Now();
  }
  ~Scope()
  {
    if (m_on)
    {
      g_ms[m_stage] += Now() - m_t0;
      g_n[m_stage]++;
    }
  }
  Scope(const Scope&) = delete;
  Scope& operator=(const Scope&) = delete;

private:
  int m_stage;
  bool m_on;
  double m_t0 = 0.0;
};

// One clock read costs (t_last - t_first) / (kCalReads - 1). Called once per
// frame; 64 reads is ~64 us of instrument against a ~15 ms frame, and it kills
// the quantisation noise that a single pair carries (a single pair measured
// 0 us in some frames and 9.5 us in others).
inline void Calibrate()
{
  if (!Enabled())
    return;
  volatile double sink = 0.0;  // keep the calls; Now() must not be folded away
  const double t0 = Now();
  double t = t0;
  for (int i = 1; i < kCalReads; i++)
  {
    t = Now();
    sink = t;
  }
  g_ms[kTimerPair] += (t - t0) / (kCalReads - 1);
  g_n[kTimerPair]++;
}

// Publish the accumulators into the SAB scratch window, once per
// recomp_render_fifo. Unconditional: the counters must be readable with the
// timers off.
inline void Publish()
{
  auto* ms = reinterpret_cast<volatile double*>(kMsBase);
  auto* n = reinterpret_cast<volatile std::uint32_t*>(kNBase);
  for (int i = 0; i < kTimedCount; i++)
    ms[i] = g_ms[i];
  for (int i = 0; i < kCount; i++)
    n[i] = g_n[i];
}
}  // namespace BemStage
