// Copyright 2026 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

// emdawnwebgpu exposes the C API through this header (see WGPUGfx.h note).
#include <webgpu/webgpu.h>

#include <vector>

#include "Common/CommonTypes.h"

#include "VideoCommon/NativeVertexFormat.h"
#include "VideoCommon/VertexManagerBase.h"

namespace WGPU
{
// Port of Vulkan::VertexFormat (VKVertexFormat.{h,cpp}). Builds a WGPUVertexBufferLayout from a
// PortableVertexDeclaration so the pipeline's vertex inputs match the uber VS @location signature.
// The backing attribute vector must outlive pipeline creation, so it lives here and the layout
// points into it. CreatePipeline reads GetVertexBufferLayout().
class WGPUVertexFormat final : public ::NativeVertexFormat
{
public:
  explicit WGPUVertexFormat(const PortableVertexDeclaration& vtx_decl);

  // The layout's .attributes points into m_attributes (stable for the lifetime of this object).
  const WGPUVertexBufferLayout& GetVertexBufferLayout() const { return m_layout; }

private:
  void MapAttributes();

  std::vector<WGPUVertexAttribute> m_attributes;
  WGPUVertexBufferLayout m_layout = {};
};

class WGPUVertexManager final : public VertexManagerBase
{
public:
  WGPUVertexManager();
  ~WGPUVertexManager() override;

  bool Initialize() override;

protected:
  void ResetBuffer(u32 vertex_stride) override;
  void CommitBuffer(u32 num_vertices, u32 vertex_stride, u32 num_indices, u32* out_base_vertex,
                    u32* out_base_index) override;
  void UploadUniforms() override;
  void DrawCurrentBatch(u32 base_index, u32 num_indices, u32 base_vertex) override;

private:
  // Uploads VS + PS constant blocks at a 256-aligned rolling offset; records each block's offset
  // for the GROUP0 dynamic-offset. Mirrors VKVertexManager::UploadAllConstants.
  void UploadAllConstants();

  // GPU buffers (lazily created in Initialize). Vertex/index are CopyDst-streamed; uniforms hold
  // the VS + PS constant blocks. Sized generously (rings); we roll a CPU-side offset and wrap.
  ::WGPUBuffer m_vertex_buffer = nullptr;
  ::WGPUBuffer m_index_buffer = nullptr;
  ::WGPUBuffer m_uniform_buffer = nullptr;

  // CPU staging arenas. m_cur_buffer_pointer (base class) points into m_vertex_cpu during a batch;
  // CommitBuffer wgpuQueueWriteBuffer's the used bytes. Index data is staged via the base class's
  // index generator writing into m_index_cpu.
  std::vector<u8> m_vertex_cpu;
  std::vector<u16> m_index_cpu;

  // Rolling byte offsets into the GPU buffers (wrap when near capacity).
  u64 m_vertex_offset = 0;
  u64 m_index_offset = 0;
  u64 m_uniform_offset = 0;

  // Last-committed base offsets (so DrawCurrentBatch can bind from 0 with base_vertex/base_index).
  // We bind the WHOLE buffer and use base_vertex/base_index, matching the Vulkan path.

  // Dynamic offsets for the current draw's GROUP0 (set by UploadAllConstants / UploadUniforms).
  u32 m_vs_uniform_offset = 0;
  u32 m_ps_uniform_offset = 0;
};
}  // namespace WGPU
