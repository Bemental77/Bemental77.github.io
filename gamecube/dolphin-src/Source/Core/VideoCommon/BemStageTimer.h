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
// (fpr_reg_cache.cpp:335). NOTE: the FIFO-brake block does NOT end at
// 0x026B3B1C — 425039fd also owns 0x026B3B20 as the brake KILL SWITCH. That
// off-by-one-cell reading is what put `enable` on top of the kill switch; see
// the kEnableCell definition below.
//   0x026B3BDC  enable (0 = timers off)   [was 0x026B3B20 — collided; fixed]
//   0x026B3B24  ablation-hit counter, ARM D (kAblBPHitCell — NOT spare)
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

// [CELL COLLISION FIX 2026-09-01] This was 0x026B3B20 — which is the FIFO
// backpressure brake's KILL SWITCH (CommandProcessor.cpp BemFifoBackpressure,
// landed 4h41m EARLIER in 425039fd, "nonzero = brake DISABLED"). The comment
// above reads the brake block as ending at 0x026B3B1C, its last COUNTER, and
// missed that 425039fd also claimed 0x026B3B20. The semantics compose in the
// worst possible way: nonzero means "timers ON" here and "brake OFF" there, so
// ARMING THE STAGE TIMERS SILENTLY DISABLED THE PSO FIFO WEDGE BRAKE — including
// via the probe's PROBE_STAGE_SPLIT, which writes this cell
// (dolphin_render_probe.js). Moved to the first free cell above the u32 counts
// (0x026B3B98 + 17*4 = 0x026B3BDC), still inside the documented
// 0x026B3900..0x026B3BFC window and below the 0x026B3C00 FPR spill.
// CommandProcessor.cpp static_asserts these two differ, so this cannot recur.
inline constexpr std::uintptr_t kEnableCell = 0x026B3BDCu;
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
// [CELL COLLISION FIX 2026-09-01 — the second one in this header] This was
// 0x026B3930, which bementalJIT/src/block_cache.cpp already owned as
// `bem_unwrap_on`, the IMPORT-UNWRAP GATE (e14f728, 19.5h earlier). That gate is
// DEFAULT OFF for a specific reason: e14f728 measured the unwrap HARD-WEDGING PSO
// 5/7 ("treatment wedges after FOUR presses") and gated it off until the race is
// found. So arming this coalescing A/B ALSO armed the known PSO wedge cause — and
// re-arming the unwrap for measurement silently turned coalescing on, voiding that
// A/B in both directions. Both commits' comments claim "repo-wide grep shows no
// other use"; both were wrong about the other. Moved to the free tail.
inline constexpr std::uintptr_t kCoalesceCell = 0x026B3BE0u;
inline constexpr std::uintptr_t kCoalesceHitCell = 0x026B3934u;  // uncontested; left in place

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
// [CELL COLLISION FIX 2026-09-01 — the third and fourth in this header] These
// were 0x026B3940 / 0x026B3944, which bementalJIT/src/block_cache.cpp already
// owned as BEM_CC_EVICT_N / BEM_CC_MAP_SIZE inside its CONTIGUOUS, explicitly
// free-verified census block 0x026B3940..0x026B397C. THIS PAIR WAS THE WORST OF
// THE FOUR, because unlike the others it needed nobody to arm it:
//   0x026B3940  block_cache.cpp:1278 does bem_cc_add(BEM_CC_EVICT_N, 1) every
//               time the cap-eviction policy fires, and WGPUGfx.cpp:2118 reads
//               that same cell as `_bem_rs != 0` — the LEVER 2 gate. So ONE block
//               cache eviction silently ARMED a DEFAULT-OFF renderer behaviour
//               change that makes DrawIndexed skip SetPipeline/SetVertexBuffer/
//               SetIndexBuffer/SetBindGroup. Self-arming during normal operation.
//   0x026B3944  mutual clobber, diagnostics only: block_cache.cpp:1308,:1586 do
//               bem_cc_set(mapSize) while WGPUGfx.cpp:348 does ++hitCounter, so
//               both numbers are garbage whenever the other side runs.
// These two were the ONLY BemStage cells intruding into that block — every other
// cell here is <= 0x026B393C or in the 0x026B3B.. region — so BemStage overreached
// by exactly two cells. Moved to the free tail; the boundary is now asserted below.
inline constexpr std::uintptr_t kRedundantStateCell = 0x026B3BE4u;
inline constexpr std::uintptr_t kRedundantStateHitCell = 0x026B3BE8u;
inline constexpr std::uintptr_t kMsBase = 0x026B3B40u;  // 11 x f64
inline constexpr std::uintptr_t kNBase = 0x026B3B98u;   // 17 x u32

// ---- externally-owned regions this header must never reuse ------------------
// Four collisions in this one header (0x026B3B20, 0x026B3930, 0x026B3940,
// 0x026B3944) all had the same shape: a cell was picked after a "repo-wide grep
// shows no other use" that was simply wrong. A comment cannot enforce that, so
// this is a compile-time guard, and it guards RANGES rather than single
// addresses — single-address asserts would not have caught the 3940/3944 pair
// creeping into the middle of a 16-cell block.
inline constexpr std::uintptr_t kForeign_FifoBrakeKill = 0x026B3B20u;  // CommandProcessor.cpp
inline constexpr std::uintptr_t kForeign_ImportUnwrap  = 0x026B3930u;  // block_cache.cpp:532
// block_cache.cpp:51-66 census, contiguous and documented as its own block.
inline constexpr std::uintptr_t kForeign_BlockCacheLo  = 0x026B3940u;
inline constexpr std::uintptr_t kForeign_BlockCacheHi  = 0x026B397Cu;

inline constexpr bool CellIsForeign(std::uintptr_t a)
{
  return a == kForeign_FifoBrakeKill || a == kForeign_ImportUnwrap ||
         (a >= kForeign_BlockCacheLo && a <= kForeign_BlockCacheHi);
}
// Every gate/counter cell this header owns, checked against every foreign region.
static_assert(!CellIsForeign(kEnableCell), "kEnableCell collides with a foreign cell");
static_assert(!CellIsForeign(kCoalesceCell), "kCoalesceCell collides with a foreign cell");
static_assert(!CellIsForeign(kCoalesceHitCell), "kCoalesceHitCell collides with a foreign cell");
static_assert(!CellIsForeign(kSubmitCountCell), "kSubmitCountCell collides with a foreign cell");
static_assert(!CellIsForeign(kUploadBytesCell), "kUploadBytesCell collides with a foreign cell");
static_assert(!CellIsForeign(kRedundantStateCell), "kRedundantStateCell collides with a foreign cell");
static_assert(!CellIsForeign(kRedundantStateHitCell), "kRedundantStateHitCell collides with a foreign cell");
static_assert(!CellIsForeign(kAblAHitCell) && !CellIsForeign(kAblBHitCell) &&
              !CellIsForeign(kAblApHitCell) && !CellIsForeign(kAblUploadCell) &&
              !CellIsForeign(kAblUploadHitCell) && !CellIsForeign(kAblBPCell) &&
              !CellIsForeign(kAblBPHitCell),
              "an ablation cell collides with a foreign cell");
// The two block bases, checked across their full extent (11 f64 / 17 u32).
static_assert(!CellIsForeign(kMsBase) && !CellIsForeign(kMsBase + 11u * 8u - 1u),
              "kMsBase block overlaps a foreign cell");
static_assert(!CellIsForeign(kNBase) && !CellIsForeign(kNBase + 17u * 4u - 1u),
              "kNBase block overlaps a foreign cell");

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
