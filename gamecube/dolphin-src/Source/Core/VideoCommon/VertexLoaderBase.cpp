// Copyright 2014 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoCommon/VertexLoaderBase.h"

#include <array>
#include <bit>
#include <cstring>
#include <memory>
#include <vector>

#include <fmt/ranges.h>

#include "Common/Assert.h"
#include "Common/CommonTypes.h"
#include "Common/MsgHandler.h"

#include "VideoCommon/VertexLoader.h"
#include "VideoCommon/VertexLoaderManager.h"
#include "VideoCommon/VertexLoader_Color.h"
#include "VideoCommon/VertexLoader_Normal.h"
#include "VideoCommon/VertexLoader_Position.h"
#include "VideoCommon/VertexLoader_TextCoord.h"
#include "VideoCommon/VideoConfig.h"

#ifdef _M_X86_64
#include "VideoCommon/VertexLoaderX64.h"
#elif defined(_M_ARM_64)
#include "VideoCommon/VertexLoaderARM64.h"
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

#include "VideoCommon/VertexLoaderWasm.h"
#endif

// [vtx-wasm 2026-08-28] Probe-readable outcome of the VertexLoaderType::Compare
// gate below. ASSERT_MSG routes through PanicYesNoFmtAssert (Common/Assert.h:11-23),
// which in a non-interactive build can LOG and return true rather than Crash() —
// so a mismatch would otherwise be invisible to a headless probe. These counters
// are bumped next to every assertion; they are the actual pass/fail signal.
//
// Read them either as exports (Module._bem_vtx_mismatch_count()) or straight out
// of the SAB scratch cells they mirror (VertexLoaderWasm.h kMismatch*Cell).
// PASS == compare_runs > 0 && mismatch_count == 0. A zero run count means the
// gate never ran (Compare was not enabled), which is NOT a pass.
extern "C" {
u32 g_bem_vtx_compare_runs = 0;
u32 g_bem_vtx_mismatches = 0;
u32 g_bem_vtx_mismatch_kinds = 0;
}

enum : u32
{
  VTX_MISMATCH_COUNT = 1u << 0,
  VTX_MISMATCH_DATA = 1u << 1,
  VTX_MISMATCH_POSMTX_CACHE = 1u << 2,
  VTX_MISMATCH_POSITION_CACHE = 1u << 3,
  VTX_MISMATCH_NORMAL_CACHE = 1u << 4,
  VTX_MISMATCH_TANGENT_CACHE = 1u << 5,
  VTX_MISMATCH_BINORMAL_CACHE = 1u << 6,
};

static void RecordVertexLoaderMismatch(u32 kind)
{
  g_bem_vtx_mismatches++;
  g_bem_vtx_mismatch_kinds |= kind;
#ifdef __EMSCRIPTEN__
  VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kMismatchCountCell,
                                   g_bem_vtx_mismatches);
  VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kMismatchKindsCell,
                                   g_bem_vtx_mismatch_kinds);
#endif
}

#ifdef __EMSCRIPTEN__
extern "C" {
EMSCRIPTEN_KEEPALIVE u32 bem_vtx_mismatch_count()
{
  return g_bem_vtx_mismatches;
}
EMSCRIPTEN_KEEPALIVE u32 bem_vtx_mismatch_kinds()
{
  return g_bem_vtx_mismatch_kinds;
}
EMSCRIPTEN_KEEPALIVE u32 bem_vtx_compare_runs()
{
  return g_bem_vtx_compare_runs;
}
// Convenience setters for the two SAB toggles, so a probe that has the Module
// but not `sharedMemory` can still drive the A/B. Equivalent to writing the
// cells directly; see VertexLoaderWasm.h.
EMSCRIPTEN_KEEPALIVE void bem_vtx_set_force_software(u32 on)
{
  VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kForceSoftwareCell, on);
}
EMSCRIPTEN_KEEPALIVE void bem_vtx_set_compare(u32 on)
{
  VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kForceCompareCell, on);
}
}
#endif

// a hacky implementation to compare two vertex loaders
class VertexLoaderTester : public VertexLoaderBase
{
public:
  VertexLoaderTester(std::unique_ptr<VertexLoaderBase> a_, std::unique_ptr<VertexLoaderBase> b_,
                     const TVtxDesc& vtx_desc, const VAT& vtx_attr)
      : VertexLoaderBase(vtx_desc, vtx_attr), a(std::move(a_)), b(std::move(b_))
  {
    ASSERT(a && b);
    if (a->m_vertex_size == b->m_vertex_size && a->m_native_components == b->m_native_components &&
        a->m_native_vtx_decl.stride == b->m_native_vtx_decl.stride)
    {
      // These are generated from the VAT and vertex desc, so they should match.
      // m_native_vtx_decl.stride isn't set yet, though.
      ASSERT(m_vertex_size == a->m_vertex_size && m_native_components == a->m_native_components);

      memcpy(&m_native_vtx_decl, &a->m_native_vtx_decl, sizeof(PortableVertexDeclaration));
    }
    else
    {
      PanicAlertFmt("Can't compare vertex loaders that expect different vertex formats!\n"
                    "a: m_vertex_size {}, m_native_components {:#010x}, stride {}\n"
                    "b: m_vertex_size {}, m_native_components {:#010x}, stride {}",
                    a->m_vertex_size, a->m_native_components, a->m_native_vtx_decl.stride,
                    b->m_vertex_size, b->m_native_components, b->m_native_vtx_decl.stride);
    }
  }
  int RunVertices(const u8* src, u8* dst, int count) override
  {
    buffer_a.resize(count * a->m_native_vtx_decl.stride + 4);
    buffer_b.resize(count * b->m_native_vtx_decl.stride + 4);

    const std::array<u32, 3> old_position_matrix_index_cache =
        VertexLoaderManager::position_matrix_index_cache;
    const std::array<std::array<float, 4>, 3> old_position_cache =
        VertexLoaderManager::position_cache;
    const std::array<float, 4> old_normal_cache = VertexLoaderManager::normal_cache;
    const std::array<float, 4> old_tangent_cache = VertexLoaderManager::tangent_cache;
    const std::array<float, 4> old_binormal_cache = VertexLoaderManager::binormal_cache;

    const int count_a = a->RunVertices(src, buffer_a.data(), count);

    const std::array<u32, 3> a_position_matrix_index_cache =
        VertexLoaderManager::position_matrix_index_cache;
    const std::array<std::array<float, 4>, 3> a_position_cache =
        VertexLoaderManager::position_cache;
    const std::array<float, 4> a_normal_cache = VertexLoaderManager::normal_cache;
    const std::array<float, 4> a_tangent_cache = VertexLoaderManager::tangent_cache;
    const std::array<float, 4> a_binormal_cache = VertexLoaderManager::binormal_cache;

    // Reset state before running b
    VertexLoaderManager::position_matrix_index_cache = old_position_matrix_index_cache;
    VertexLoaderManager::position_cache = old_position_cache;
    VertexLoaderManager::normal_cache = old_normal_cache;
    VertexLoaderManager::tangent_cache = old_tangent_cache;
    VertexLoaderManager::binormal_cache = old_binormal_cache;

    const int count_b = b->RunVertices(src, buffer_b.data(), count);

    const std::array<u32, 3> b_position_matrix_index_cache =
        VertexLoaderManager::position_matrix_index_cache;
    const std::array<std::array<float, 4>, 3> b_position_cache =
        VertexLoaderManager::position_cache;
    const std::array<float, 4> b_normal_cache = VertexLoaderManager::normal_cache;
    const std::array<float, 4> b_tangent_cache = VertexLoaderManager::tangent_cache;
    const std::array<float, 4> b_binormal_cache = VertexLoaderManager::binormal_cache;

    // [vtx-wasm 2026-08-28] Every check below feeds RecordVertexLoaderMismatch as
    // well as ASSERT_MSG: ASSERT_MSG may only log in this build (Common/Assert.h:11-23
    // -> PanicYesNoFmtAssert), and a wrong vertex stream shows up as garbled
    // geometry rather than a crash, so the probe needs a hard counter.
    g_bem_vtx_compare_runs++;
#ifdef __EMSCRIPTEN__
    VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kCompareRunsCell,
                                     g_bem_vtx_compare_runs);
#endif

    if (count_a != count_b)
      RecordVertexLoaderMismatch(VTX_MISMATCH_COUNT);
    ASSERT_MSG(VIDEO, count_a == count_b,
               "The two vertex loaders have loaded a different amount of vertices (a: {}, b: {}).",
               count_a, count_b);

    const bool data_matches = memcmp(buffer_a.data(), buffer_b.data(),
                                     std::min(count_a, count_b) * m_native_vtx_decl.stride) == 0;
    if (!data_matches)
      RecordVertexLoaderMismatch(VTX_MISMATCH_DATA);
    ASSERT_MSG(VIDEO, data_matches,
               "The two vertex loaders have loaded different data.  Configuration:"
               "\nVertex desc:\n{}\n\nVertex attr:\n{}",
               m_VtxDesc, m_VtxAttr);

    if (a_position_matrix_index_cache != b_position_matrix_index_cache)
      RecordVertexLoaderMismatch(VTX_MISMATCH_POSMTX_CACHE);
    ASSERT_MSG(VIDEO, a_position_matrix_index_cache == b_position_matrix_index_cache,
               "Expected matching position matrix caches after loading (a: {}; b: {})",
               fmt::join(a_position_matrix_index_cache, ", "),
               fmt::join(b_position_matrix_index_cache, ", "));

    // Some games (e.g. Donkey Kong Country Returns) have a few draws that contain NaN.
    // Since NaN != NaN, we need to compare the bits instead.
    const auto bit_equal = [](float val_a, float val_b) {
      return std::bit_cast<u32>(val_a) == std::bit_cast<u32>(val_b);
    };

    // The last element is allowed to be garbage for SIMD overwrites.
    // For XY, the last 2 are garbage.
    const bool positions_match = [&] {
      const size_t max_component = m_VtxAttr.g0.PosElements == CoordComponentCount::XYZ ? 3 : 2;
      for (size_t vertex = 0; vertex < 3; vertex++)
      {
        if (!std::equal(a_position_cache[vertex].begin(),
                        a_position_cache[vertex].begin() + max_component,
                        b_position_cache[vertex].begin(), bit_equal))
        {
          return false;
        }
      }
      return true;
    }();

    if (!positions_match)
      RecordVertexLoaderMismatch(VTX_MISMATCH_POSITION_CACHE);
    ASSERT_MSG(VIDEO, positions_match,
               "Expected matching position caches after loading (a: {} / {} / {}; b: {} / {} / {})",
               fmt::join(a_position_cache[0], ", "), fmt::join(a_position_cache[1], ", "),
               fmt::join(a_position_cache[2], ", "), fmt::join(b_position_cache[0], ", "),
               fmt::join(b_position_cache[1], ", "), fmt::join(b_position_cache[2], ", "));

    // The last element is allowed to be garbage for SIMD overwrites
    const bool normals_match = std::equal(a_normal_cache.begin(), a_normal_cache.begin() + 3,
                                          b_normal_cache.begin(), b_normal_cache.begin() + 3,
                                          bit_equal);
    if (!normals_match)
      RecordVertexLoaderMismatch(VTX_MISMATCH_NORMAL_CACHE);
    ASSERT_MSG(VIDEO, normals_match, "Expected matching normal caches after loading (a: {}; b: {})",
               fmt::join(a_normal_cache, ", "), fmt::join(b_normal_cache, ", "));

    const bool tangents_match = std::equal(a_tangent_cache.begin(), a_tangent_cache.begin() + 3,
                                           b_tangent_cache.begin(), b_tangent_cache.begin() + 3,
                                           bit_equal);
    if (!tangents_match)
      RecordVertexLoaderMismatch(VTX_MISMATCH_TANGENT_CACHE);
    ASSERT_MSG(VIDEO, tangents_match,
               "Expected matching tangent caches after loading (a: {}; b: {})",
               fmt::join(a_tangent_cache, ", "), fmt::join(b_tangent_cache, ", "));

    const bool binormals_match = std::equal(a_binormal_cache.begin(), a_binormal_cache.begin() + 3,
                                            b_binormal_cache.begin(), b_binormal_cache.begin() + 3,
                                            bit_equal);
    if (!binormals_match)
      RecordVertexLoaderMismatch(VTX_MISMATCH_BINORMAL_CACHE);
    ASSERT_MSG(VIDEO, binormals_match,
               "Expected matching binormal caches after loading (a: {}; b: {})",
               fmt::join(a_binormal_cache, ", "), fmt::join(b_binormal_cache, ", "));

    memcpy(dst, buffer_a.data(), count_a * m_native_vtx_decl.stride);
    m_numLoadedVertices += count;
    return count_a;
  }

private:
  std::unique_ptr<VertexLoaderBase> a;
  std::unique_ptr<VertexLoaderBase> b;

  std::vector<u8> buffer_a;
  std::vector<u8> buffer_b;
};

u32 VertexLoaderBase::GetVertexSize(const TVtxDesc& vtx_desc, const VAT& vtx_attr)
{
  u32 size = 0;

  // Each enabled TexMatIdx adds one byte, as does PosMatIdx
  size += std::popcount(vtx_desc.low.Hex & 0x1FF);

  const u32 pos_size = VertexLoader_Position::GetSize(vtx_desc.low.Position, vtx_attr.g0.PosFormat,
                                                      vtx_attr.g0.PosElements);
  size += pos_size;
  const u32 norm_size =
      VertexLoader_Normal::GetSize(vtx_desc.low.Normal, vtx_attr.g0.NormalFormat,
                                   vtx_attr.g0.NormalElements, vtx_attr.g0.NormalIndex3);
  size += norm_size;
  for (u32 i = 0; i < vtx_desc.low.Color.Size(); i++)
  {
    const u32 color_size =
        VertexLoader_Color::GetSize(vtx_desc.low.Color[i], vtx_attr.GetColorFormat(i));
    size += color_size;
  }
  for (u32 i = 0; i < vtx_desc.high.TexCoord.Size(); i++)
  {
    const u32 tc_size = VertexLoader_TextCoord::GetSize(
        vtx_desc.high.TexCoord[i], vtx_attr.GetTexFormat(i), vtx_attr.GetTexElements(i));
    size += tc_size;
  }

  return size;
}

u32 VertexLoaderBase::GetVertexComponents(const TVtxDesc& vtx_desc, const VAT& vtx_attr)
{
  u32 components = 0;
  if (vtx_desc.low.PosMatIdx)
    components |= VB_HAS_POSMTXIDX;
  for (u32 i = 0; i < vtx_desc.low.TexMatIdx.Size(); i++)
  {
    if (vtx_desc.low.TexMatIdx[i])
      components |= VB_HAS_TEXMTXIDX0 << i;
  }
  // Vertices always have positions; thus there is no VB_HAS_POS as it would always be set
  if (vtx_desc.low.Normal != VertexComponentFormat::NotPresent)
  {
    components |= VB_HAS_NORMAL;
    if (vtx_attr.g0.NormalElements == NormalComponentCount::NTB)
      components |= VB_HAS_TANGENT | VB_HAS_BINORMAL;
  }
  for (u32 i = 0; i < vtx_desc.low.Color.Size(); i++)
  {
    if (vtx_desc.low.Color[i] != VertexComponentFormat::NotPresent)
      components |= VB_HAS_COL0 << i;
  }
  for (u32 i = 0; i < vtx_desc.high.TexCoord.Size(); i++)
  {
    if (vtx_desc.high.TexCoord[i] != VertexComponentFormat::NotPresent)
      components |= VB_HAS_UV0 << i;
  }
  return components;
}

std::unique_ptr<VertexLoaderBase> VertexLoaderBase::CreateVertexLoader(const TVtxDesc& vtx_desc,
                                                                       const VAT& vtx_attr)
{
  VertexLoaderType loader_type = g_ActiveConfig.vertex_loader_type;

#ifdef __EMSCRIPTEN__
  // [selection trace 2026-08-29] Publish what this function actually sees.
  VertexLoaderWasmFlags::WriteCell(VertexLoaderWasmFlags::kLoaderTypeCell,
                                   static_cast<u32>(loader_type) + 1u);
  VertexLoaderWasmFlags::BumpCell(VertexLoaderWasmFlags::kCreateCallsCell);
#endif

#ifdef __EMSCRIPTEN__
  // [vtx-wasm 2026-08-28] Runtime A/B on ONE binary — no rebuild between arms.
  // SAB scratch cell 0x026B3900 nonzero == arm B (stock software loader);
  // 0x026B3904 nonzero == run the Compare gate. See VertexLoaderWasm.h.
  // Loaders are cached in VertexLoaderManager's map, so the Compare cell must be
  // set before the first draw; the force-software cell is ALSO re-read per
  // RunVertices (VertexLoaderWasm::RunVertices) so it can be flipped mid-scene.
  if (VertexLoaderWasmFlags::ForceSoftware())
    return std::make_unique<VertexLoader>(vtx_desc, vtx_attr);
  if (VertexLoaderWasmFlags::ForceCompare() && loader_type != VertexLoaderType::Software)
    loader_type = VertexLoaderType::Compare;
#endif

  if (loader_type == VertexLoaderType::Software)
  {
    return std::make_unique<VertexLoader>(vtx_desc, vtx_attr);
  }

  std::unique_ptr<VertexLoaderBase> native_loader = nullptr;

#if defined(_M_X86_64)
  native_loader = std::make_unique<VertexLoaderX64>(vtx_desc, vtx_attr);
#elif defined(_M_ARM_64)
  native_loader = std::make_unique<VertexLoaderARM64>(vtx_desc, vtx_attr);
#elif defined(__EMSCRIPTEN__)
  // Only the formats VertexLoaderWasm can reproduce bit-exactly get the JIT
  // loader; everything else leaves native_loader null and drops into the
  // software fallback right below, exactly as before.
  if (VertexLoaderWasm::IsSupported(vtx_desc, vtx_attr))
  {
    VertexLoaderWasmFlags::BumpCell(VertexLoaderWasmFlags::kWasmBuiltCell);
    native_loader = std::make_unique<VertexLoaderWasm>(vtx_desc, vtx_attr);
  }
  else
  {
    VertexLoaderWasmFlags::BumpCell(VertexLoaderWasmFlags::kUnsupportedCell);
  }
#endif

  // Use the software loader as a fallback
  // (VertexLoaderX64 and VertexLoaderARM64 are always usable, so on those
  // targets this never triggers; under Emscripten it is the live path for every
  // vertex format VertexLoaderWasm::IsSupported rejects)
  if (!native_loader)
  {
    return std::make_unique<VertexLoader>(vtx_desc, vtx_attr);
  }

  if (loader_type == VertexLoaderType::Compare)
  {
    return std::make_unique<VertexLoaderTester>(
        std::make_unique<VertexLoader>(vtx_desc, vtx_attr),  // the software one
        std::move(native_loader),                            // the new one to compare
        vtx_desc, vtx_attr);
  }

  return native_loader;
}
