// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/WGPU/WGPUVertexManager.h"

#include <cstring>

#include <emscripten.h>  // MAIN_THREAD_EM_ASM (one-shot draw logging)

#include "Common/Align.h"
#include "Common/CommonTypes.h"

#include "Core/System.h"

#include "VideoBackends/WGPU/WGPUGfx.h"

#include "VideoCommon/CPMemory.h"   // [xf-diag PM36 TEMP] g_main_cp_state.matrix_index_a
#include "VideoCommon/IndexGenerator.h"
#include "VideoCommon/PixelShaderManager.h"
#include "VideoCommon/VertexShaderGen.h"  // ShaderAttrib (vertex @location indices)
#include "VideoCommon/XFMemory.h"   // [xf-diag PM36 TEMP] xfmem.posMatrices scan
#include "VideoCommon/VertexShaderManager.h"

namespace WGPU
{
// ---------------------------------------------------------------------------------------------
// WGPUVertexFormat (port of Vulkan::VertexFormat). PortableVertexDeclaration -> WGPUVertexAttribute
// list, with shaderLocation = the ShaderAttrib enum value (matches the uber VS @location inputs).
// ---------------------------------------------------------------------------------------------
namespace
{
// ComponentFormat (UByte/Byte/UShort/Short/Float) x components(1..4) x integer -> WGPUVertexFormat.
// WebGPU has NO 3-component 8/16-bit vertex formats; promote components==3 (non-Float32) to x4.
// Return type is fully-qualified ::WGPUVertexFormat (the C enum); inside namespace WGPU the
// unqualified name resolves to our WGPU::WGPUVertexFormat CLASS (shadowing).
::WGPUVertexFormat VarToWGPUVertexFormat(ComponentFormat t, u32 components, bool integer)
{
  // Promote unsupported 3-component packed formats to 4-component (the extra lane is ignored by the
  // shader; the vertex loader pads the stride). Float32x3 IS supported, so only promote non-float.
  if (components == 3 && t != ComponentFormat::Float)
    components = 4;
  if (components == 0)
    components = 1;
  if (components > 4)
    components = 4;

  // [components-1] indexes the x1/x2/x3/x4 variant.
  switch (t)
  {
  case ComponentFormat::UByte:  // unsigned byte
    if (integer)
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Uint8, WGPUVertexFormat_Uint8x2,
                                            WGPUVertexFormat_Uint8x4, WGPUVertexFormat_Uint8x4};
      return k[components - 1];
    }
    else
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Unorm8, WGPUVertexFormat_Unorm8x2,
                                            WGPUVertexFormat_Unorm8x4, WGPUVertexFormat_Unorm8x4};
      return k[components - 1];
    }
  case ComponentFormat::Byte:  // signed byte
    if (integer)
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Sint8, WGPUVertexFormat_Sint8x2,
                                            WGPUVertexFormat_Sint8x4, WGPUVertexFormat_Sint8x4};
      return k[components - 1];
    }
    else
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Snorm8, WGPUVertexFormat_Snorm8x2,
                                            WGPUVertexFormat_Snorm8x4, WGPUVertexFormat_Snorm8x4};
      return k[components - 1];
    }
  case ComponentFormat::UShort:  // unsigned short
    if (integer)
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Uint16, WGPUVertexFormat_Uint16x2,
                                            WGPUVertexFormat_Uint16x4, WGPUVertexFormat_Uint16x4};
      return k[components - 1];
    }
    else
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Unorm16, WGPUVertexFormat_Unorm16x2,
                                            WGPUVertexFormat_Unorm16x4, WGPUVertexFormat_Unorm16x4};
      return k[components - 1];
    }
  case ComponentFormat::Short:  // signed short
    if (integer)
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Sint16, WGPUVertexFormat_Sint16x2,
                                            WGPUVertexFormat_Sint16x4, WGPUVertexFormat_Sint16x4};
      return k[components - 1];
    }
    else
    {
      static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Snorm16, WGPUVertexFormat_Snorm16x2,
                                            WGPUVertexFormat_Snorm16x4, WGPUVertexFormat_Snorm16x4};
      return k[components - 1];
    }
  case ComponentFormat::Float:
  default:
  {
    static const ::WGPUVertexFormat k[4] = {WGPUVertexFormat_Float32, WGPUVertexFormat_Float32x2,
                                          WGPUVertexFormat_Float32x3, WGPUVertexFormat_Float32x4};
    return k[components - 1];
  }
  }
}
}  // namespace

WGPUVertexFormat::WGPUVertexFormat(const PortableVertexDeclaration& vtx_decl)
    : NativeVertexFormat(vtx_decl)
{
  MapAttributes();

  m_layout = {};
  m_layout.stepMode = WGPUVertexStepMode_Vertex;
  m_layout.arrayStride = m_decl.stride;
  m_layout.attributeCount = m_attributes.size();
  m_layout.attributes = m_attributes.data();  // stable: m_attributes outlives the layout
}

void WGPUVertexFormat::MapAttributes()
{
  m_attributes.clear();

  // The uber VS declares ALL these inputs (locations 0-6, 8-15; see dolphin_vk.vert.wgsl main()).
  // WebGPU REQUIRES every shader @location to be present in the vertex layout (Vulkan tolerates
  // missing ones — that mismatch is why "attribute slot 15 not present" fired). So emit an
  // attribute for EVERY consumed location: the real one if enabled, else a 4-byte placeholder at
  // offset 0 (overlaps position; never read — the ubershader guards actual use by uniforms). Match
  // the shader input's base type: posmtx is vec4<u32> (uint); every other input is vec*<f32>.
  const auto add = [&](ShaderAttrib loc, const AttributeFormat& af) {
    WGPUVertexAttribute a = {};
    if (af.enable)
    {
      a.format = VarToWGPUVertexFormat(af.type, static_cast<u32>(af.components), af.integer);
      a.offset = static_cast<u64>(af.offset);
    }
    else
    {
      a.format = (loc == ShaderAttrib::PositionMatrix) ? WGPUVertexFormat_Uint8x4
                                                       : WGPUVertexFormat_Unorm8x4;
      a.offset = 0;
    }
    a.shaderLocation = static_cast<u32>(loc);
    m_attributes.push_back(a);
  };

  add(ShaderAttrib::Position, m_decl.position);
  for (u32 i = 0; i < 3; i++)
    add(ShaderAttrib::Normal + static_cast<int>(i), m_decl.normals[i]);
  for (u32 i = 0; i < 2; i++)
    add(ShaderAttrib::Color0 + static_cast<int>(i), m_decl.colors[i]);
  for (u32 i = 0; i < 8; i++)
    add(ShaderAttrib::TexCoord0 + static_cast<int>(i), m_decl.texcoords[i]);
  add(ShaderAttrib::PositionMatrix, m_decl.posmtx);
}

// ---------------------------------------------------------------------------------------------
// WGPUVertexManager (port of Vulkan::VertexManager). Streams vertices/indices into GPU buffers and
// records the draw via WGPUGfx (which owns the render pass + pipeline/texture/sampler state).
// ---------------------------------------------------------------------------------------------
namespace
{
// Sizes (a few MB each, generously). These wrap with a rolling offset; no fences (WebGPU's
// queueWriteBuffer serializes into the queue, so a wrap reuses bytes the GPU already consumed for
// earlier-submitted frames — acceptable for B2's correctness-first milestone).
constexpr u64 VERTEX_BUFFER_SIZE = 16 * 1024 * 1024;
constexpr u64 INDEX_BUFFER_SIZE = 4 * 1024 * 1024;
constexpr u64 UNIFORM_BUFFER_SIZE = 8 * 1024 * 1024;
constexpr u64 UNIFORM_ALIGN = 256;  // WebGPU dynamic-offset / UBO offset alignment
}  // namespace

WGPUVertexManager::WGPUVertexManager() = default;

WGPUVertexManager::~WGPUVertexManager()
{
  if (m_vertex_buffer)
    wgpuBufferRelease(m_vertex_buffer);
  if (m_index_buffer)
    wgpuBufferRelease(m_index_buffer);
  if (m_uniform_buffer)
    wgpuBufferRelease(m_uniform_buffer);
}

bool WGPUVertexManager::Initialize()
{
  if (!VertexManagerBase::Initialize())
    return false;

  WGPUDevice device = WGPUGfx::GetInstance() ? WGPUGfx::GetInstance()->GetDevice() : nullptr;
  if (!device)
    return true;  // headless / no device: behave like a stub (draws no-op via DrawCurrentBatch)

  WGPUBufferDescriptor vdesc = {};
  vdesc.usage = WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst;
  vdesc.size = VERTEX_BUFFER_SIZE;
  m_vertex_buffer = wgpuDeviceCreateBuffer(device, &vdesc);

  WGPUBufferDescriptor idesc = {};
  idesc.usage = WGPUBufferUsage_Index | WGPUBufferUsage_CopyDst;
  idesc.size = INDEX_BUFFER_SIZE;
  m_index_buffer = wgpuDeviceCreateBuffer(device, &idesc);

  WGPUBufferDescriptor udesc = {};
  udesc.usage = WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst;
  udesc.size = UNIFORM_BUFFER_SIZE;
  m_uniform_buffer = wgpuDeviceCreateBuffer(device, &udesc);

  // CPU staging arenas (the base class points m_cur_buffer_pointer at m_vertex_cpu in ResetBuffer).
  m_vertex_cpu.resize(VERTEX_BUFFER_SIZE);
  m_index_cpu.resize(INDEX_BUFFER_SIZE / sizeof(u16));

  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
    '[wgpu] vertex manager init vbuf=' + ($0 ? 'OK' : 'NULL') + ' ibuf=' + ($1 ? 'OK' : 'NULL')
    + ' ubuf=' + ($2 ? 'OK' : 'NULL')}); },
    (int)(m_vertex_buffer != nullptr), (int)(m_index_buffer != nullptr),
    (int)(m_uniform_buffer != nullptr));

  return true;
}

void WGPUVertexManager::ResetBuffer(u32 vertex_stride)
{
  // Point the base class at our CPU vertex arena; the index generator writes into m_index_cpu.
  m_base_buffer_pointer = m_vertex_cpu.data();
  m_end_buffer_pointer = m_vertex_cpu.data() + m_vertex_cpu.size();
  m_cur_buffer_pointer = m_vertex_cpu.data();
  m_index_generator.Start(m_index_cpu.data());
}

// [basevertex-fold EXPERIMENT PM34 - evaluate] if emdawnwebgpu mis-marshals
// baseVertex/firstIndex on drawIndexed, the GPU fetches garbage vertices while
// the CPU arena holds real data — fits every observation (and the util draws,
// which use neither, land). Fold both into the buffer-binding byte offsets.
static u32 s_last_vtx_byte = 0;
static u32 s_last_idx_byte = 0;

void WGPUVertexManager::CommitBuffer(u32 num_vertices, u32 vertex_stride, u32 num_indices,
                                     u32* out_base_vertex, u32* out_base_index)
{
  const u64 vertex_data_size = static_cast<u64>(num_vertices) * vertex_stride;
  const u64 index_data_size = static_cast<u64>(num_indices) * sizeof(u16);
  // WebGPU's wgpuQueueWriteBuffer requires BOTH the destination offset AND the byte count to be
  // multiples of 4. Pad the write sizes up (the CPU arenas have spare bytes; the draw only reads
  // the real num_vertices/num_indices, so the padding is never sampled).
  const u64 vertex_write_size = Common::AlignUp(vertex_data_size, 4);
  const u64 index_write_size = Common::AlignUp(index_data_size, 4);

  WGPUGfx* gfx = WGPUGfx::GetInstance();
  WGPUQueue queue = gfx ? gfx->GetQueue() : nullptr;

  // The vertex offset must be a multiple of vertex_stride (so out_base_vertex is an integer) AND a
  // multiple of 4 (writeBuffer offset) -> align to lcm(vertex_stride, 4).
  if (vertex_stride > 0)
  {
    u32 a = vertex_stride, b = 4u;  // gcd
    while (b) { const u32 t = b; b = a % b; a = t; }
    const u32 valign = (vertex_stride / a) * 4u;  // lcm(vertex_stride, 4)
    m_vertex_offset = Common::AlignUp(m_vertex_offset, valign);
    if (m_vertex_offset + vertex_write_size > VERTEX_BUFFER_SIZE)
    {
      // [WGPU C1 2026-07-13] A wrap reuses bytes that draws already recorded in the STILL-OPEN
      // deferred encoder reference (queue writes execute before the deferred submit). Flush the
      // recorded work first so those draws execute against the old bytes; the next draw reopens
      // the pass with loadOp=Load.
      if (gfx)
      {
        gfx->EndRenderPass();
        gfx->SubmitFrame();
      }
      m_vertex_offset = 0;
    }
  }
  // The index offset must be a multiple of 4 (writeBuffer); 4 is also a multiple of 2, so
  // out_base_index = offset / 2 stays an integer.
  m_index_offset = Common::AlignUp(m_index_offset, 4);
  if (m_index_offset + index_write_size > INDEX_BUFFER_SIZE)
  {
    if (gfx)  // same wrap hazard as the vertex ring above
    {
      gfx->EndRenderPass();
      gfx->SubmitFrame();
    }
    m_index_offset = 0;
  }

  *out_base_vertex = vertex_stride > 0 ? static_cast<u32>(m_vertex_offset / vertex_stride) : 0;
  *out_base_index = static_cast<u32>(m_index_offset / sizeof(u16));
  // [basevertex-fold EXPERIMENT PM34] stash byte offsets for the fold test.
  s_last_vtx_byte = static_cast<u32>(m_vertex_offset);
  s_last_idx_byte = static_cast<u32>(m_index_offset);

  // [sab-diag PM31 TEMP] vertex-content probe: vertex0 dword0 @0x026B3580,
  // XOR of first 16 dwords @0x026B3584, (num_vertices<<16)|stride @0x026B3588.
  if (vertex_data_size >= 4)
  {
    const u32* vw = reinterpret_cast<const u32*>(m_vertex_cpu.data());
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3580u)) = vw[0];
    u32 ck = 0;
    const u32 nw = vertex_data_size >= 64 ? 16u : (u32)(vertex_data_size / 4);
    for (u32 i = 0; i < nw; i++) ck ^= vw[i] + i;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3584u)) = ck;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3588u)) =
        (num_vertices << 16) | (vertex_stride & 0xFFFFu);
    // [sab-diag PM33 TEMP] vertex0 raw position xyz (pos is at offset 0 of the
    // vertex per the decl) @0x026B35B4/B8/BC.
    if (vertex_data_size >= 12)
    {
      const float* vf = reinterpret_cast<const float*>(m_vertex_cpu.data());
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35B4u)) = vw[0];
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35B8u)) = vw[1];
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35BCu)) = vw[2];
      (void)vf;
    }
  }
  if (queue && m_vertex_buffer && vertex_data_size > 0)
    wgpuQueueWriteBuffer(queue, m_vertex_buffer, m_vertex_offset, m_vertex_cpu.data(),
                         static_cast<size_t>(vertex_write_size));
  // [sab-diag PM35 TEMP] first 4 indices (two u16 pairs) @0x026B35E8/EC +
  // num_indices @0x35F0 — all-zero indices = degenerate triangles = the
  // zero-fragment mechanism the vertex probe couldn't see.
  if (index_data_size >= 8)
  {
    const u32* iw = reinterpret_cast<const u32*>(m_index_cpu.data());
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35E8u)) = iw[0];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35ECu)) = iw[1];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35F0u)) = num_indices;
  }
  if (queue && m_index_buffer && index_data_size > 0)
    wgpuQueueWriteBuffer(queue, m_index_buffer, m_index_offset, m_index_cpu.data(),
                         static_cast<size_t>(index_write_size));

  m_vertex_offset += vertex_write_size;
  m_index_offset += index_write_size;
}

void WGPUVertexManager::UploadUniforms()
{
  // B2: always re-upload both VS + PS constant blocks (simple, correctness-first). A dirty-only
  // fast path can come later; for now feed fresh constants every batch.
  UploadAllConstants();
}

void WGPUVertexManager::UploadAllConstants()
{
  WGPUGfx* gfx = WGPUGfx::GetInstance();
  WGPUQueue queue = gfx ? gfx->GetQueue() : nullptr;
  if (!queue || !m_uniform_buffer)
    return;

  auto& system = Core::System::GetInstance();
  auto& vertex_shader_manager = system.GetVertexShaderManager();
  auto& pixel_shader_manager = system.GetPixelShaderManager();

  // Lay PS then VS at 256-aligned rolling offsets. Each block's offset becomes its GROUP0
  // dynamic-offset. Wrap when the combined size won't fit.
  const u64 ps_size = sizeof(PixelShaderConstants);
  const u64 vs_size = sizeof(VertexShaderConstants);

  m_uniform_offset = Common::AlignUp(m_uniform_offset, UNIFORM_ALIGN);
  const u64 ps_off = m_uniform_offset;
  const u64 vs_off = Common::AlignUp(ps_off + ps_size, UNIFORM_ALIGN);
  const u64 end = Common::AlignUp(vs_off + vs_size, UNIFORM_ALIGN);
  if (end > UNIFORM_BUFFER_SIZE)
  {
    // [WGPU C1 2026-07-13] Same wrap hazard as CommitBuffer: flush the deferred encoder before
    // reusing offset-0 bytes an earlier recorded draw still references.
    gfx->EndRenderPass();
    gfx->SubmitFrame();
    m_uniform_offset = 0;
    return UploadAllConstants();  // restart from offset 0 (fits: blocks are small)
  }

  wgpuQueueWriteBuffer(queue, m_uniform_buffer, ps_off, &pixel_shader_manager.constants,
                       static_cast<size_t>(ps_size));
  wgpuQueueWriteBuffer(queue, m_uniform_buffer, vs_off, &vertex_shader_manager.constants,
                       static_cast<size_t>(vs_size));
  // [sab-diag PM30 TEMP] uniform-content checksums: XOR-fold the blocks so the
  // probe can tell zeros from real TEV/XF state. ps @0x026B3558, vs @0x026B355C.
  {
    const u32* pw = reinterpret_cast<const u32*>(&pixel_shader_manager.constants);
    const u32* vw = reinterpret_cast<const u32*>(&vertex_shader_manager.constants);
    u32 pcs = 0, vcs = 0;
    for (size_t i = 0; i < ps_size / 4; i++) pcs ^= pw[i] + (u32)i;
    for (size_t i = 0; i < vs_size / 4; i++) vcs ^= vw[i] + (u32)i;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3558u)) = pcs;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B355Cu)) = vcs;
    // [sab-diag PM32 TEMP] cproj row0[0] and row0[3] (byte offsets 128, 140):
    // a zeroed projection -> o.pos = 0 for every vertex -> zero fragments.
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B358Cu)) = vw[128 / 4];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3590u)) = vw[140 / 4];
    // [sab-diag PM32 TEMP] cpnmtx row0[0] (offset 32) + row0 XOR — the position
    // matrix applied BEFORE projection; zeros here collapse every vertex.
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3594u)) = vw[32 / 4];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3598u)) =
        vw[8] ^ vw[9] ^ vw[10] ^ vw[11];
  }

  m_ps_uniform_offset = static_cast<u32>(ps_off);
  m_vs_uniform_offset = static_cast<u32>(vs_off);
  m_uniform_offset = end;

  pixel_shader_manager.dirty = false;
  vertex_shader_manager.dirty = false;
}

void WGPUVertexManager::DrawCurrentBatch(u32 base_index, u32 num_indices, u32 base_vertex)
{
  // [present-diag TEMP PM28] real GPU draw submissions @0x026B352C.
  ++*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B352Cu));
  static bool s_first_logged = false;
  if (!s_first_logged)
  {
    s_first_logged = true;
    MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
      '[wgpu] first DrawCurrentBatch: verts=base_vertex=' + $0 + ' indices=' + $1}); },
      (int)base_vertex, (int)num_indices);
  }

  WGPUGfx* gfx = WGPUGfx::GetInstance();
  if (!gfx)
    return;

#define BEM_BASEVERTEX_FOLD 0
#if BEM_BASEVERTEX_FOLD
  // byte offsets ride the base_index/base_vertex params; DrawIndexed's fold
  // branch binds the buffers AT those offsets and draws with bases = 0.
  gfx->DrawIndexed(m_vertex_buffer, m_index_buffer, m_uniform_buffer, m_vs_uniform_offset,
                   m_ps_uniform_offset, num_indices, s_last_idx_byte | 0x80000000u,
                   s_last_vtx_byte);
#else
  gfx->DrawIndexed(m_vertex_buffer, m_index_buffer, m_uniform_buffer, m_vs_uniform_offset,
                   m_ps_uniform_offset, num_indices, base_index, base_vertex);
#endif
}

}  // namespace WGPU
