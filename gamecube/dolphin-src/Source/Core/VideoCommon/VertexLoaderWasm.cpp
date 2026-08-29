// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

// VTXWASM_STANDALONE_TEST lets a host-side harness #include this file to get at
// EmitVertexLoaderModule() alone (see the emitter-test note at the bottom), so
// the shipped byte encoding is the thing that gets validated — not a copy of it.
#ifndef VTXWASM_STANDALONE_TEST
#include "VideoCommon/VertexLoaderWasm.h"
#endif

#if defined(__EMSCRIPTEN__) || defined(VTXWASM_STANDALONE_TEST)

#include <cstdint>
#include <cstring>
#include <vector>

#ifndef VTXWASM_STANDALONE_TEST
#include <emscripten.h>

#include "Common/CommonTypes.h"
#include "Common/Logging/Log.h"

#include "VideoCommon/CPMemory.h"
#include "VideoCommon/NativeVertexFormat.h"
#include "VideoCommon/VertexLoader.h"
#include "VideoCommon/VertexLoaderManager.h"

#include "bementalJIT/block_cache.h"
#endif

#include "bementalJIT/wasm_module_builder.h"

namespace
{
// ---------------------------------------------------------------------------
// Everything the emitter needs, as plain scalars. Addresses are absolute
// wasm-linear-memory addresses of host globals; offsets are byte offsets inside
// one native vertex.
// ---------------------------------------------------------------------------
struct VtxWasmLayout
{
  u32 stride;
  u32 pos_offset;
  u32 normal_offset;
  u32 color_offset;
  u32 tex_offset;
  // &VertexLoaderManager::cached_arraybases[<array>]
  u32 base_pos;
  u32 base_nrm;
  u32 base_col;
  u32 base_tex;
  // &g_main_cp_state.array_strides[<array>]
  u32 stride_pos;
  u32 stride_nrm;
  u32 stride_col;
  u32 stride_tex;
  u32 pos_cache;  // &VertexLoaderManager::position_cache[0][0]
  u32 nrm_cache;  // &VertexLoaderManager::normal_cache[0]
  bool has_color0;
  bool has_tex0;
  bool normal_is_float;  // else ComponentFormat::Byte (s8)
};

// ---------------------------------------------------------------------------
// Local indices of the emitted function.
//   0..2 are the parameters (const u8* src, u8* dst, int count).
// ---------------------------------------------------------------------------
constexpr u32 L_SRC = 0;
constexpr u32 L_DST = 1;
constexpr u32 L_COUNT = 2;
constexpr u32 L_REM = 3;      // VertexLoader::m_remaining
constexpr u32 L_SKIPPED = 4;  // VertexLoader::m_skippedVertices
constexpr u32 L_ADDR = 5;     // resolved array element address
constexpr u32 L_TMP = 6;      // scratch (index, then byte-swap staging)
constexpr u32 L_SKIP = 7;     // VertexLoader::m_vertexSkip
constexpr u32 kNumExtraLocals = 5;  // L_REM..L_SKIP

// Reverse the 4 bytes of the i32 on top of the stack, IN THE INTEGER DOMAIN.
//
// Common::FromBigEndian<float> is Common::swap<4>, a memcpy/bswap32/memcpy round
// trip (Common/Swap.h:161-173, 180-187) — a pure bit reversal, so NaN payloads
// survive verbatim. Doing it as i32 (never f32) keeps that property; a
// reinterpret through f32 could canonicalise a signalling NaN.
//
// wasm has no bswap opcode, so synthesise it:
//   bswap32(x) == (rotl(x,8) & 0x00FF00FF) | (rotl(x,24) & 0xFF00FF00)
// which needs x twice, hence the local.tee.
void EmitBswap32(WasmModuleBuilder& b)
{
  b.op_local_tee(L_TMP);
  b.op_i32_const(8);
  b.op_i32_rotl();
  b.op_i32_const(0x00FF00FF);
  b.op_i32_and();
  b.op_local_get(L_TMP);
  b.op_i32_const(24);
  b.op_i32_rotl();
  b.op_i32_const(static_cast<s32>(0xFF00FF00u));
  b.op_i32_and();
  b.op_i32_or();
}

// DataRead<u16>() (VertexLoaderUtils.h:36-41 -> DataPeek -> FromBigEndian) then
// resolve the array element:
//   cached_arraybases[array] + index * g_main_cp_state.array_strides[array]
// (VertexLoader_Position.cpp:55-59, VertexLoader_Normal.cpp:78-82,
//  VertexLoader_TextCoord.cpp:50-53, VertexLoader_Color.cpp:141-143).
//
// Both globals are re-resolved every draw (VertexLoaderManager::
// UpdateVertexArrayPointers), so their VALUES are loaded at run time; only their
// ADDRESSES are baked in. Leaves the index in L_TMP and the address in L_ADDR,
// and advances L_SRC by 2.
void EmitIndex16Fetch(WasmModuleBuilder& b, u32 base_addr, u32 stride_addr)
{
  // index = (src[0] << 8) | src[1]
  b.op_local_get(L_SRC);
  b.op_i32_load8_u(0);
  b.op_i32_const(8);
  b.op_i32_shl();
  b.op_local_get(L_SRC);
  b.op_i32_load8_u(1);
  b.op_i32_or();
  b.op_local_set(L_TMP);

  // src += sizeof(u16)
  b.op_local_get(L_SRC);
  b.op_i32_const(2);
  b.op_i32_add();
  b.op_local_set(L_SRC);

  // addr = base + index * stride
  b.op_i32_const(static_cast<s32>(base_addr));
  b.op_i32_load(0);
  b.op_local_get(L_TMP);
  b.op_i32_const(static_cast<s32>(stride_addr));
  b.op_i32_load(0);
  b.op_i32_mul();
  b.op_i32_add();
  b.op_local_set(L_ADDR);
}

// dst[dst_off] = bswap32(*(u32*)(addr + src_off))
void EmitSwappedCopy(WasmModuleBuilder& b, u32 src_off, u32 dst_off)
{
  b.op_local_get(L_DST);
  b.op_local_get(L_ADDR);
  b.op_i32_load(src_off, /*align*/ 0);
  EmitBswap32(b);
  b.op_i32_store(dst_off, /*align*/ 0);
}

// ---------------------------------------------------------------------------
// One flat wasm function, structurally identical to VertexLoader::RunVertices
// (VertexLoader.cpp:256-275) with the pipeline stages inlined in the order
// CompileVertexTranslator writes them (position, normal, colors, texcoords,
// SkipVertex — VertexLoader.cpp:102, :126, :150, :188, :245).
//
// Exported as "run" with signature (i32 src, i32 dst, i32 count) -> i32, which
// bemental::compile_raw installs into the calling thread's wasmTable
// (bementalJIT/src/block_cache.cpp:156).
// ---------------------------------------------------------------------------
std::vector<u8> EmitVertexLoaderModule(const VtxWasmLayout& L)
{
  WasmModuleBuilder b;
  b.emitHeader();

  b.emitTypeSection(1);
  {
    const u8 params[] = {WASM_TYPE_I32, WASM_TYPE_I32, WASM_TYPE_I32};
    const u8 results[] = {WASM_TYPE_I32};
    b.emitFuncType(params, 3, results, 1);
  }
  b.endSection();

  // Import only the host heap. compile_raw binds env.memory to `wasmMemory`
  // (bementalJIT/src/block_cache.cpp:126) and passes extra env entries that this
  // module simply does not import.
  b.emitImportSection(1);
  b.emitImportMemory("env", "memory", /*initialPages=*/1u);
  b.endSection();

  {
    const u32 type_indices[] = {0u};
    b.emitFunctionSection(1u, type_indices);
  }

  // No imported functions, so the single defined function is index 0.
  b.emitExportSection("run", 0u);

  b.beginCodeSection(1u);
  b.beginFuncBody();
  {
    const u32 counts[] = {kNumExtraLocals};
    const u8 types[] = {WASM_TYPE_I32};
    b.emitLocals(1u, counts, types);
  }

  // m_skippedVertices = 0                              (VertexLoader.cpp:262)
  b.op_i32_const(0);
  b.op_local_set(L_SKIPPED);
  // m_remaining = count - 1                            (VertexLoader.cpp:264)
  b.op_local_get(L_COUNT);
  b.op_i32_const(1);
  b.op_i32_sub();
  b.op_local_set(L_REM);

  b.op_block();  // br depth 1 == loop exit
  b.op_loop();   // br depth 0 == next iteration

  // for (; m_remaining >= 0; m_remaining--)
  b.op_local_get(L_REM);
  b.op_i32_const(0);
  b.op_i32_lt_s();
  b.op_br_if(1);

  // ---- Position: Pos_ReadIndex<u16, float, 3> (VertexLoader_Position.cpp:49-71)
  EmitIndex16Fetch(b, L.base_pos, L.stride_pos);

  // m_vertexSkip = index == 0xFFFF   (numeric_limits<u16>::max(), :56)
  b.op_local_get(L_TMP);
  b.op_i32_const(0xFFFF);
  b.op_i32_eq();
  b.op_local_set(L_SKIP);

  // PosScale<float> is the identity specialisation, so each component is a pure
  // byte reversal (VertexLoader_Position.cpp:26-30, :64). The element is read
  // even when the vertex is skipped — Pos_ReadIndex does the same (:62-68).
  for (u32 i = 0; i < 3; i++)
    EmitSwappedCopy(b, 4u * i, L.pos_offset + 4u * i);

  // if (m_remaining < 3 && !m_vertexSkip)
  //   position_cache[m_remaining][i] = value            (:65-66)
  // Loop-invariant per vertex, so hoisted out of the component loop. The values
  // are re-read from dst so the cache gets the exact stored bit pattern.
  // position_cache is std::array<std::array<float,4>,3>, so the per-vertex
  // element stride is 16 bytes (VertexLoaderManager.cpp:40, .h:63).
  b.op_local_get(L_REM);
  b.op_i32_const(3);
  b.op_i32_lt_s();
  b.op_local_get(L_SKIP);
  b.op_i32_eqz();
  b.op_i32_and();
  b.op_if();
  {
    b.op_local_get(L_REM);
    b.op_i32_const(16);
    b.op_i32_mul();
    b.op_i32_const(static_cast<s32>(L.pos_cache));
    b.op_i32_add();
    b.op_local_set(L_TMP);
    for (u32 i = 0; i < 3; i++)
    {
      b.op_local_get(L_TMP);
      b.op_local_get(L_DST);
      b.op_i32_load(L.pos_offset + 4u * i, /*align*/ 0);
      b.op_i32_store(4u * i, /*align*/ 2);
    }
  }
  b.op_end();

  // ---- Normal: Normal_ReadIndex<u16, T, 1> -> ReadIndirect<T, 3, 0>
  //      (VertexLoader_Normal.cpp:41-63, :73-89)
  // NOTE: the normal index is NOT tested against 0xFFFF — only the position
  // stage sets m_vertexSkip.
  EmitIndex16Fetch(b, L.base_nrm, L.stride_nrm);

  if (L.normal_is_float)
  {
    // FracAdjust<float> is the identity specialisation (:35-39).
    for (u32 i = 0; i < 3; i++)
      EmitSwappedCopy(b, 4u * i, L.normal_offset + 4u * i);
  }
  else
  {
    // FracAdjust<s8>: val / float(1u << (8 - 1 - 1)) == val / 64.0f (:23-33).
    // s8 -> int promotion -> float conversion -> f32 division.
    // wasm has no i32.extend8_s here; i32.load8_s does the sign extension.
    for (u32 i = 0; i < 3; i++)
    {
      b.op_local_get(L_DST);
      b.op_local_get(L_ADDR);
      b.op_i32_load8_s(i);
      b.op_f32_convert_i32_s();
      b.op_f32_const(64.0f);
      b.op_f32_div();
      b.op_f32_store(L.normal_offset + 4u * i, /*align*/ 0);
    }
  }

  // if (m_remaining == 0) normal_cache[i] = value       (:50-53)
  // Unconditional w.r.t. m_vertexSkip — a skipped vertex still updates it.
  b.op_local_get(L_REM);
  b.op_i32_eqz();
  b.op_if();
  {
    for (u32 i = 0; i < 3; i++)
    {
      b.op_i32_const(static_cast<s32>(L.nrm_cache + 4u * i));
      b.op_local_get(L_DST);
      b.op_i32_load(L.normal_offset + 4u * i, /*align*/ 0);
      b.op_i32_store(0, /*align*/ 2);
    }
  }
  b.op_end();

  // ---- Color0: Color_ReadIndex_32b_8888<u16> (VertexLoader_Color.cpp:138-145)
  // SetCol(loader, Read32(address)); Read32 is a raw memcpy (:70-75) — NO swap.
  if (L.has_color0)
  {
    EmitIndex16Fetch(b, L.base_col, L.stride_col);
    b.op_local_get(L_DST);
    b.op_local_get(L_ADDR);
    b.op_i32_load(0, /*align*/ 0);
    b.op_i32_store(L.color_offset, /*align*/ 0);
  }

  // ---- TexCoord0: TexCoord_ReadIndex<u16, float, 2>
  //      (VertexLoader_TextCoord.cpp:45-60). TCScale<float> is the identity
  //      specialisation (:28-32), so this is another pure byte reversal.
  if (L.has_tex0)
  {
    EmitIndex16Fetch(b, L.base_tex, L.stride_tex);
    for (u32 i = 0; i < 2; i++)
      EmitSwappedCopy(b, 4u * i, L.tex_offset + 4u * i);
  }

  // ---- SkipVertex (VertexLoader.cpp:56-65). The software loader advances the
  // write pointer as it writes and then rewinds one stride; writing at fixed
  // offsets and only advancing on the non-skip path is equivalent.
  b.op_local_get(L_SKIP);
  b.op_if();
  {
    b.op_local_get(L_SKIPPED);
    b.op_i32_const(1);
    b.op_i32_add();
    b.op_local_set(L_SKIPPED);
  }
  b.op_else();
  {
    b.op_local_get(L_DST);
    b.op_i32_const(static_cast<s32>(L.stride));
    b.op_i32_add();
    b.op_local_set(L_DST);
  }
  b.op_end();

  // m_remaining--
  b.op_local_get(L_REM);
  b.op_i32_const(1);
  b.op_i32_sub();
  b.op_local_set(L_REM);
  b.op_br(0);

  b.op_end();  // loop
  b.op_end();  // block

  // return count - m_skippedVertices                    (VertexLoader.cpp:274)
  b.op_local_get(L_COUNT);
  b.op_local_get(L_SKIPPED);
  b.op_i32_sub();

  b.endFuncBody();
  b.endSection();

  return b.getBytes();
}
}  // namespace

#ifndef VTXWASM_STANDALONE_TEST

namespace
{
u32 HostAddr(const void* p)
{
  return static_cast<u32>(reinterpret_cast<std::uintptr_t>(p));
}
}  // namespace

// ---------------------------------------------------------------------------
// Format predicate.
//
// The four formats below are 97.6% of all vertices on the MP4 board, per the
// live [vtxcensus] instrumentation (VertexLoaderManager.cpp:64 bem_vtx_census +
// dolphin-bridge/worker_funcs.js:828); the highest-volume sample observed was
//   loaders=21 verts=443727472
//   desc=1e00/3 vat=41217009/80000000/0  49.3%
//   desc=1e00/3 vat=41216409/80000000/0  36.5%
//   desc=1e00/0 vat=41216409/80000000/0   8.2%
//   desc=7e00/3 vat=41216409/80000000/0   3.6%
// Decoded (CPMemory.h:243-262 for desc, :330-347 for VAT g0):
//   all four : PosMatIdx=0, no TexMatIdx, Position=Index16/Float/XYZ, PosFrac=0,
//              Normal=Index16/N/index3=false, Color1 absent
//   #1       : NormalFormat=Float,      no colors,  TexCoord0=Index16/Float/ST
//   #2       : NormalFormat=Byte (s8),  no colors,  TexCoord0=Index16/Float/ST
//   #3       : NormalFormat=Byte (s8),  no colors,  no texcoords
//   #4       : NormalFormat=Byte (s8),  Color0=Index16/RGBA8888, TexCoord0 as #2
// giving native strides 32/32/24/36 and GC vertex sizes 6/6/4/8.
//
// PosFrac / Tex0Frac are required to be 0 even though PosScale<float>
// (VertexLoader_Position.cpp:26-30) and TCScale<float>
// (VertexLoader_TextCoord.cpp:28-32) are identity specialisations that ignore
// the scale entirely: staying inside the measured envelope is cheaper than
// being wrong. g0.ByteDequant is NOT checked because the software loader never
// reads it (only VertexLoaderX64.cpp:475 / VertexLoaderARM64.cpp:346 do).
// ---------------------------------------------------------------------------
bool VertexLoaderWasm::IsSupported(const TVtxDesc& vtx_desc, const VAT& vtx_attr)
{
  // No position-matrix index and no texture-matrix indices: both add pipeline
  // stages with their own caches (VertexLoader.cpp:84-99, :191-205).
  if (vtx_desc.low.PosMatIdx)
    return false;
  for (u32 i = 0; i < vtx_desc.low.TexMatIdx.Size(); i++)
  {
    if (vtx_desc.low.TexMatIdx[i])
      return false;
  }

  // Position: Index16 / Float / XYZ / no fractional scale.
  if (vtx_desc.low.Position != VertexComponentFormat::Index16)
    return false;
  if (vtx_attr.g0.PosFormat != ComponentFormat::Float)
    return false;
  if (vtx_attr.g0.PosElements != CoordComponentCount::XYZ)
    return false;
  if (vtx_attr.g0.PosFrac != 0)
    return false;

  // Normal: Index16, single normal, Float or Byte(s8).
  if (vtx_desc.low.Normal != VertexComponentFormat::Index16)
    return false;
  if (vtx_attr.g0.NormalElements != NormalComponentCount::N)
    return false;
  if (vtx_attr.g0.NormalIndex3)
    return false;
  if (vtx_attr.g0.NormalFormat != ComponentFormat::Float &&
      vtx_attr.g0.NormalFormat != ComponentFormat::Byte)
  {
    return false;
  }

  // Color0: absent, or Index16 / RGBA8888. Color1 must be absent — if it were
  // present with Color0 absent the software loader inserts a dummy stage to keep
  // m_colIndex in sync (VertexLoader.cpp:155-158).
  if (vtx_desc.low.Color[0] != VertexComponentFormat::NotPresent)
  {
    if (vtx_desc.low.Color[0] != VertexComponentFormat::Index16)
      return false;
    if (vtx_attr.GetColorFormat(0) != ColorFormat::RGBA8888)
      return false;
  }
  if (vtx_desc.low.Color[1] != VertexComponentFormat::NotPresent)
    return false;

  // TexCoord0: absent, or Index16 / Float / ST. TexCoord1..7 must be absent.
  if (vtx_desc.high.TexCoord[0] != VertexComponentFormat::NotPresent)
  {
    if (vtx_desc.high.TexCoord[0] != VertexComponentFormat::Index16)
      return false;
    if (vtx_attr.GetTexFormat(0) != ComponentFormat::Float)
      return false;
    if (vtx_attr.GetTexElements(0) != TexComponentCount::ST)
      return false;
    if (vtx_attr.GetTexFrac(0) != 0)
      return false;
  }
  for (u32 i = 1; i < vtx_desc.high.TexCoord.Size(); i++)
  {
    if (vtx_desc.high.TexCoord[i] != VertexComponentFormat::NotPresent)
      return false;
  }

  return true;
}

VertexLoaderWasm::VertexLoaderWasm(const TVtxDesc& vtx_desc, const VAT& vtx_attr)
    : VertexLoaderBase(vtx_desc, vtx_attr),
      m_software(std::make_unique<VertexLoader>(vtx_desc, vtx_attr))
{
  // Copy the declaration verbatim rather than recomputing it: padding bytes are
  // part of the memcmp identity (NativeVertexFormat.h:65-74).
  std::memcpy(&m_native_vtx_decl, &m_software->m_native_vtx_decl,
              sizeof(PortableVertexDeclaration));

  m_stride = static_cast<u32>(m_native_vtx_decl.stride);
  m_pos_offset = static_cast<u32>(m_native_vtx_decl.position.offset);
  m_normal_offset = static_cast<u32>(m_native_vtx_decl.normals[0].offset);
  m_has_color0 = m_native_vtx_decl.colors[0].enable;
  m_color_offset = static_cast<u32>(m_native_vtx_decl.colors[0].offset);
  m_has_tex0 = m_native_vtx_decl.texcoords[0].enable;
  m_tex_offset = static_cast<u32>(m_native_vtx_decl.texcoords[0].offset);
  m_normal_is_float = (vtx_attr.g0.NormalFormat == ComponentFormat::Float);
}

VertexLoaderWasm::~VertexLoaderWasm() = default;

std::vector<u8> VertexLoaderWasm::EmitModule() const
{
  VtxWasmLayout layout{};
  layout.stride = m_stride;
  layout.pos_offset = m_pos_offset;
  layout.normal_offset = m_normal_offset;
  layout.color_offset = m_color_offset;
  layout.tex_offset = m_tex_offset;
  // Addresses of the host globals the emitted code touches. These are stable for
  // the life of the process; their CONTENTS are read at run time because
  // VertexLoaderManager::UpdateVertexArrayPointers re-resolves them per draw.
  layout.base_pos = HostAddr(&VertexLoaderManager::cached_arraybases[CPArray::Position]);
  layout.base_nrm = HostAddr(&VertexLoaderManager::cached_arraybases[CPArray::Normal]);
  layout.base_col = HostAddr(&VertexLoaderManager::cached_arraybases[CPArray::Color0]);
  layout.base_tex = HostAddr(&VertexLoaderManager::cached_arraybases[CPArray::TexCoord0]);
  layout.stride_pos = HostAddr(&g_main_cp_state.array_strides[CPArray::Position]);
  layout.stride_nrm = HostAddr(&g_main_cp_state.array_strides[CPArray::Normal]);
  layout.stride_col = HostAddr(&g_main_cp_state.array_strides[CPArray::Color0]);
  layout.stride_tex = HostAddr(&g_main_cp_state.array_strides[CPArray::TexCoord0]);
  layout.pos_cache = HostAddr(VertexLoaderManager::position_cache.data());
  layout.nrm_cache = HostAddr(VertexLoaderManager::normal_cache.data());
  layout.has_color0 = m_has_color0;
  layout.has_tex0 = m_has_tex0;
  layout.normal_is_float = m_normal_is_float;
  return EmitVertexLoaderModule(layout);
}

bool VertexLoaderWasm::EnsureCompiled()
{
  const pthread_t self = pthread_self();
  if (m_owner_valid && pthread_equal(m_owner, self))
    return !m_compile_failed && m_fn != nullptr;

  // First use on this thread (or the caller migrated): mint a fresh handle.
  // compile_raw registers into the CALLING thread's wasmTable
  // (bementalJIT/src/block_cache.cpp:149-157) and a wasm32 function pointer is an
  // index into that instance's own table, so a handle does not travel.
  m_owner = self;
  m_owner_valid = true;
  m_fn = nullptr;
  m_handle = -1;
  m_compile_failed = false;

  const std::vector<u8> bytes = EmitModule();
  if (bytes.empty())
  {
    m_compile_failed = true;
    return false;
  }

  // compile_raw's first call on a thread runs a "direct-binding upgrade" that
  // calls Module._dolphin_read8/_write8/... once each with dummy args
  // (bementalJIT/src/block_cache.cpp:365-385). Those are real guest-memory
  // accessors; _dolphin_write8(0, 0) would write guest address 0. Pre-seeding the
  // env container suppresses that path (its guard is
  // `!Module.bemental_imports.env.ppc_write16`, block_cache.cpp:352-355) without
  // changing anything for the PowerPC JIT: the JIT compiles its first blocks at
  // boot, long before the first draw, so on any thread that runs both, the
  // upgrade has already happened and this seeding is a no-op.
  EM_ASM({
    if (typeof Module == 'undefined')
      return;
    if (Module.bemental_imports && Module.bemental_imports.env &&
        Module.bemental_imports.env.ppc_write16)
      return;  // the real bridge bootstrap already ran on this thread
    if (typeof Module._dolphin_write16 != 'function')
      return;  // no bridge exports here; compile_raw would not run the upgrade
    if (!Module.bemental_imports)
      Module.bemental_imports = {env : {}};
    if (!Module.bemental_imports.env)
      Module.bemental_imports.env = {};
    var e = Module.bemental_imports.env;
    e.ppc_read8 = Module._dolphin_read8;
    e.ppc_read16 = Module._dolphin_read16;
    e.ppc_read32 = Module._dolphin_read32;
    e.ppc_write8 = Module._dolphin_write8;
    e.ppc_write16 = Module._dolphin_write16;
    e.ppc_write32 = Module._dolphin_write32;
    e.ppc_check_exc = Module._dolphin_check_exc;
    e.ppc_break_block = Module._dolphin_break_block;
    e.ppc_hle_check = Module._dolphin_hle_check;
    if (Module._dolphin_hle_fire)
      e.ppc_hle_fire = Module._dolphin_hle_fire;
    if (Module._dolphin_msr_updated)
      e.ppc_msr_updated = Module._dolphin_msr_updated;
    if (Module._dolphin_gather_drain)
      e.ppc_gather_drain = Module._dolphin_gather_drain;
  });

  const int handle = bemental::compile_raw(bytes.data(), bytes.size());
  if (handle < 0)
  {
    WARN_LOG_FMT(VIDEO,
                 "VertexLoaderWasm: compile_raw failed ({} bytes); falling back to the "
                 "software loader for stride {}",
                 bytes.size(), m_stride);
    m_compile_failed = true;
    return false;
  }

  m_handle = handle;
  // wasm32 function pointers ARE __indirect_function_table indices, so the
  // toolchain lowers a call through this pointer to call_indirect — no JS hop.
  // Same cast as gamecube/ppc-worker/ppc_worker_main.cpp:1524.
  m_fn = reinterpret_cast<VtxFn>(static_cast<std::uintptr_t>(static_cast<u32>(handle)));

  INFO_LOG_FMT(VIDEO,
               "VertexLoaderWasm: compiled {} bytes -> table index {} (stride {}, gc vertex {}, "
               "normal {}, color0 {}, tex0 {})",
               bytes.size(), handle, m_stride, m_vertex_size, m_normal_is_float ? "float" : "s8",
               m_has_color0, m_has_tex0);
  return true;
}

int VertexLoaderWasm::RunVertices(const u8* src, u8* dst, int count)
{
  // Runtime A/B, re-read every draw so the arm can be flipped mid-scene on ONE
  // binary (see VertexLoaderWasmFlags). One aligned u32 load per RunVertices —
  // not per vertex — so arm A is not measurably taxed by the toggle's presence.
  if (VertexLoaderWasmFlags::ForceSoftware() || !EnsureCompiled())
  {
    const int loaded = m_software->RunVertices(src, dst, count);
    m_numLoadedVertices += count;
    return loaded;
  }

  m_numLoadedVertices += count;  // VertexLoader.cpp:261
  return m_fn(src, dst, count);
}

#endif  // !VTXWASM_STANDALONE_TEST

#endif  // __EMSCRIPTEN__ || VTXWASM_STANDALONE_TEST
