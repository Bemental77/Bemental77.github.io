// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#include "VideoBackends/WGPU/WGPUVertexManager.h"

#include <cstring>

#include <emscripten.h>  // MAIN_THREAD_EM_ASM (one-shot draw logging)

#include "Common/Align.h"
#include "Common/CommonTypes.h"

#include "Core/System.h"

#include "VideoBackends/WGPU/WGPUGfx.h"

#include "VideoCommon/BemStageTimer.h"  // [render-stage split 2026-08-29 TEMP]
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
// [LEVER: upload coalescing 2026-08-29] live instance for the extern "C" hook
// bem_wgpu_flush_pending_uploads(), called from WGPUGfx::SubmitFrame.
static WGPUVertexManager* s_bem_wgpu_vm = nullptr;

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
  // [LEVER: upload coalescing 2026-08-29] ring mirrors, +20 MB of wasm heap
  // against INITIAL_MEMORY=512 MB. Only touched when cell 0x026B3930 is set.
  m_vertex_stage.resize(VERTEX_BUFFER_SIZE);
  m_index_stage.resize(INDEX_BUFFER_SIZE);
  s_bem_wgpu_vm = this;  // [LEVER: upload coalescing] arm the SubmitFrame hook

  MAIN_THREAD_EM_ASM({ postMessage({cmd: 'print', txt:
    '[wgpu] vertex manager init vbuf=' + ($0 ? 'OK' : 'NULL') + ' ibuf=' + ($1 ? 'OK' : 'NULL')
    + ' ubuf=' + ($2 ? 'OK' : 'NULL')}); },
    (int)(m_vertex_buffer != nullptr), (int)(m_index_buffer != nullptr),
    (int)(m_uniform_buffer != nullptr));

  // Seed both constant blocks once so the dirty-gated UploadUniforms can never let the first draw
  // sample an unwritten uniform buffer / stale dynamic offsets. Mirrors VKVertexManager::Initialize
  // (VKVertexManager.cpp:119, "Bind the buffers to all the known spots even if it's not used").
  UploadAllConstants();

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

  // [sab-diag PM31] vertex-content probe (probe field `vtx`): vertex0 dword0 @0x026B3580,
  // (num_vertices<<16)|stride @0x026B3588. Two plain stores — kept unconditional.
  // The 16-dword XOR checksum @0x026B3584 is a per-batch LOOP, so it is gated behind
  // BEMENTAL_WGPU_PROF (CLAUDE.md gate #8: diagnostics must not accumulate). Rebuild with
  // -DBEMENTAL_WGPU_PROF to restore the middle field of `vtx`.
  // [sab-diag PM33] the vertex0 xyz mirror @0x026B35B4/B8/BC was REMOVED: no reader anywhere in
  // the tree (grep 2026-08-28: only a historical mention in gamecube/docs/native-exact-dualcore/
  // TASKS.md:1283), and 0x35B4 duplicated 0x3580 verbatim.
  if (vertex_data_size >= 4)
  {
    const u32* vw = reinterpret_cast<const u32*>(m_vertex_cpu.data());
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3580u)) = vw[0];
#ifdef BEMENTAL_WGPU_PROF
    u32 ck = 0;
    const u32 nw = vertex_data_size >= 64 ? 16u : (u32)(vertex_data_size / 4);
    for (u32 i = 0; i < nw; i++) ck ^= vw[i] + i;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3584u)) = ck;
#endif
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3588u)) =
        (num_vertices << 16) | (vertex_stride & 0xFFFFu);
  }
  // [draw-ablation TEMP 2026-08-29] ARM C: cell 0x026B3B38 nonzero => skip BOTH
  // per-batch wgpuQueueWriteBuffer calls (vertex here, index below). MEASUREMENT
  // ARM ONLY (the GPU then draws whatever bytes the ring last held). It splits the
  // 35.5% that ARM A' removes into UPLOAD vs ENCODE: ARM A (WGPUGfx::DrawIndexed)
  // removes the encode but leaves these writes, so ARM C is the complement.
  // SAB is browser-zeroed => cold boot = NOT ablated.
  const bool _bem_skip_upload =
      *reinterpret_cast<volatile u32*>(BemStage::kAblUploadCell) != 0u;
  if (_bem_skip_upload)
    ++*reinterpret_cast<volatile u32*>(BemStage::kAblUploadHitCell);
  // [LEVER: upload coalescing 2026-08-29] read the arm ONCE per batch so the
  // vertex and index halves can never disagree inside one CommitBuffer.
  const bool _bem_coalesce = *reinterpret_cast<volatile u32*>(BemStage::kCoalesceCell) != 0u;
  if (!_bem_skip_upload && m_vertex_buffer && vertex_data_size > 0)
  {
    if (_bem_coalesce)
    {
      std::memcpy(m_vertex_stage.data() + m_vertex_offset, m_vertex_cpu.data(),
                  static_cast<size_t>(vertex_write_size));
      if (m_vertex_offset < m_pend_v_lo)
        m_pend_v_lo = m_vertex_offset;
      if (m_vertex_offset + vertex_write_size > m_pend_v_hi)
        m_pend_v_hi = m_vertex_offset + vertex_write_size;
      ++*reinterpret_cast<volatile u32*>(BemStage::kCoalesceHitCell);
    }
    else if (queue)
    {
      *reinterpret_cast<volatile u32*>(BemStage::kUploadBytesCell) +=
          static_cast<u32>(vertex_write_size);  // [census 2026-08-29]
      wgpuQueueWriteBuffer(queue, m_vertex_buffer, m_vertex_offset, m_vertex_cpu.data(),
                           static_cast<size_t>(vertex_write_size));
    }
  }
  // [sab-diag PM35] first 4 indices (two u16 pairs) @0x026B35E8/EC + num_indices @0x35F0 —
  // all-zero indices = degenerate triangles = the zero-fragment mechanism the vertex probe
  // couldn't see. Three plain stores, no loop; read by dolphin_render_probe.js:717 (`idx`).
  if (index_data_size >= 8)
  {
    const u32* iw = reinterpret_cast<const u32*>(m_index_cpu.data());
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35E8u)) = iw[0];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35ECu)) = iw[1];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B35F0u)) = num_indices;
  }
  if (!_bem_skip_upload && m_index_buffer && index_data_size > 0)
  {
    if (_bem_coalesce)
    {
      std::memcpy(m_index_stage.data() + m_index_offset, m_index_cpu.data(),
                  static_cast<size_t>(index_write_size));
      if (m_index_offset < m_pend_i_lo)
        m_pend_i_lo = m_index_offset;
      if (m_index_offset + index_write_size > m_pend_i_hi)
        m_pend_i_hi = m_index_offset + index_write_size;
    }
    else if (queue)
    {
      *reinterpret_cast<volatile u32*>(BemStage::kUploadBytesCell) +=
          static_cast<u32>(index_write_size);  // [census 2026-08-29]
      wgpuQueueWriteBuffer(queue, m_index_buffer, m_index_offset, m_index_cpu.data(),
                           static_cast<size_t>(index_write_size));
    }
  }

  m_vertex_offset += vertex_write_size;
  m_index_offset += index_write_size;
}

// [LEVER: upload coalescing 2026-08-29] One writeBuffer per ring per submit.
// Correctness: queue.writeBuffer is ordered ahead of every command buffer
// submitted AFTER it, and the ONLY command buffer that reads these rings is
// m_encoder, submitted at WGPUGfx.cpp:333 immediately below this call. So every
// draw recorded since the last submit sees its own bytes. Ring wrap is safe for
// the same reason it already was: the wrap paths in CommitBuffer /
// UploadAllConstants call SubmitFrame BEFORE zeroing an offset, and SubmitFrame
// calls this first, so a wrap can never strand a pending range or overwrite
// bytes a recorded-but-unsubmitted draw still references.
void WGPUVertexManager::FlushPendingUploads()
{
  WGPUGfx* gfx = WGPUGfx::GetInstance();
  WGPUQueue queue = gfx ? gfx->GetQueue() : nullptr;
  if (queue)
  {
    if (m_pend_v_hi > m_pend_v_lo && m_vertex_buffer)
      wgpuQueueWriteBuffer(queue, m_vertex_buffer, m_pend_v_lo,
                           m_vertex_stage.data() + m_pend_v_lo,
                           static_cast<size_t>(m_pend_v_hi - m_pend_v_lo));
    if (m_pend_i_hi > m_pend_i_lo && m_index_buffer)
      wgpuQueueWriteBuffer(queue, m_index_buffer, m_pend_i_lo,
                           m_index_stage.data() + m_pend_i_lo,
                           static_cast<size_t>(m_pend_i_hi - m_pend_i_lo));
  }
  m_pend_v_lo = ~0ull;
  m_pend_v_hi = 0;
  m_pend_i_lo = ~0ull;
  m_pend_i_hi = 0;
}

// C hook so WGPUGfx does not need the WGPUVertexManager type or the
// g_vertex_manager downcast.
extern "C" void bem_wgpu_flush_pending_uploads()
{
  if (s_bem_wgpu_vm)
    s_bem_wgpu_vm->FlushPendingUploads();
}

void WGPUVertexManager::UploadUniforms()
{
  // Dirty-only upload, matching the Vulkan backend
  // (VKVertexManager.cpp:206 `if (!vertex_shader_manager.dirty || !ReserveConstantStorage()) return;`).
  // Both blocks share ONE 256-aligned rolling allocation here, so upload BOTH whenever EITHER is
  // dirty: conservative, and it can never hand a draw a stale block.
  //
  // Skipping is safe: m_vs_uniform_offset / m_ps_uniform_offset keep pointing at the previous
  // upload's bytes, and the uniform ring only advances inside UploadAllConstants — a skipped batch
  // therefore cannot overwrite them. DrawIndexed re-passes both as dynamic offsets on every draw
  // (WGPUGfx.cpp:2008), and utility draws stream through a SEPARATE buffer (m_util_uniforms,
  // WGPUGfx.cpp:751), so nothing else writes into m_uniform_buffer behind our back.
  //
  // Flag provenance (all verified against the live tree):
  //   VertexShaderManager::Init sets dirty=true (VertexShaderManager.cpp:38); DoState sets it on
  //   read (VertexShaderManager.cpp:490); SetConstants sets it on every mutating branch
  //   (:176,187,201,212,273,285,300,317,334,390,429,441,454); SetVertexFormat mutates via
  //   UpdateValue/UpdateOffset(&dirty,...) (VertexShaderManager.h:42-78).
  //   PixelShaderManager::Init -> Dirty() sets dirty=true (PixelShaderManager.cpp:81); DoState
  //   calls Dirty() on read (:543); every Set*/SetConstants mutation sets it (48 sites).
  //   External writers: VertexManagerBase::CalculateNormals sets vertex_shader_manager.dirty=true
  //   after each cached_tangent/binormal/normal write (VertexManagerBase.cpp:779,784,794).
  // KNOWN HOLE (upstream, shared with Vulkan/D3D12/Metal): VertexManagerBase.cpp:556 writes
  // pixel_shader_manager.constants.time_ms WITHOUT setting dirty. It is gated on
  // g_ActiveConfig.bGraphicMods (VideoConfig.h:277 defaults false, VideoConfig.cpp:194 =
  // GFX_MODS_ENABLE), so it is inert unless graphics mods are turned on — and when they are, the
  // native Vulkan path is stale in exactly the same way.
  auto& system = Core::System::GetInstance();
  if (!system.GetVertexShaderManager().dirty && !system.GetPixelShaderManager().dirty)
    return;

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
  {
    const u32* vw = reinterpret_cast<const u32*>(&vertex_shader_manager.constants);
    // [sab-diag PM30] uniform-content checksums (probe field `uniCk`): ps @0x026B3558,
    // vs @0x026B355C. GATED behind BEMENTAL_WGPU_PROF — these two XOR folds walked
    // (ps_size + vs_size) / 4 words on EVERY batch (~1400 at the block sizes declared in
    // VideoCommon/ConstantManager.h) and were the bulk of the 2.56% self time attributed to
    // UploadUniforms in the PSO render-worker profile (/tmp/worker_2.cpuprofile, ROM_IDX=2).
    // Rebuild with -DBEMENTAL_WGPU_PROF to restore `uniCk`.
#ifdef BEMENTAL_WGPU_PROF
    const u32* pw = reinterpret_cast<const u32*>(&pixel_shader_manager.constants);
    u32 pcs = 0, vcs = 0;
    for (size_t i = 0; i < ps_size / 4; i++) pcs ^= pw[i] + (u32)i;
    for (size_t i = 0; i < vs_size / 4; i++) vcs ^= vw[i] + (u32)i;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3558u)) = pcs;
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B355Cu)) = vcs;
#endif
    // [sab-diag PM32] cproj row0[0] and row0[3] (byte offsets 128, 140): a zeroed projection
    // -> o.pos = 0 for every vertex -> zero fragments. Plus cpnmtx row0[0] (offset 32) + row0
    // XOR — the position matrix applied BEFORE projection. Four loads / four stores, no loop:
    // kept unconditional (read by dolphin_render_probe.js:701-703 as `proj` / `pn`).
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B358Cu)) = vw[128 / 4];
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3590u)) = vw[140 / 4];
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
