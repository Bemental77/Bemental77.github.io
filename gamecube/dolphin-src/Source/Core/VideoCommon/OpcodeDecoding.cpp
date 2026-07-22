// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

// DL facts:
//  Ikaruga uses (nearly) NO display lists!
//  Zelda WW uses TONS of display lists
//  Zelda TP uses almost 100% display lists except menus (we like this!)
//  Super Mario Galaxy has nearly all geometry and more than half of the state in DLs (great!)

// Note that it IS NOT GENERALLY POSSIBLE to precompile display lists! You can compile them as they
// are while interpreting them, and hope that the vertex format doesn't change, though, if you do
// it right when they are called. The reason is that the vertex format affects the sizes of the
// vertices.

#include "VideoCommon/OpcodeDecoding.h"

#include "Common/Assert.h"
#include "Common/Logging/Log.h"
#include "Core/Core.h"  // [dc device-gate 2026-07-22] WGPUDeviceLiveOnThisThread
#include "Core/FifoPlayer/FifoRecorder.h"
#include "Core/HW/Memmap.h"
#include "Core/System.h"
#include "VideoCommon/BPMemory.h"
#include "VideoCommon/CPMemory.h"
#include "VideoCommon/CommandProcessor.h"
#include "VideoCommon/DataReader.h"
#include "VideoCommon/Fifo.h"
#include "VideoCommon/Statistics.h"
#include "VideoCommon/VertexLoaderBase.h"
#include "VideoCommon/VertexLoaderManager.h"
#include "VideoCommon/XFMemory.h"
#include "VideoCommon/XFStateManager.h"

namespace OpcodeDecoder
{
bool g_record_fifo_data = false;

template <bool is_preprocess>
class RunCallback final : public Callback
{
public:
  OPCODE_CALLBACK(void OnXF(u16 address, u8 count, const u8* data))
  {
    m_cycles += 18 + 6 * count;

    if constexpr (!is_preprocess)
    {
      LoadXFReg(address, count, data);

      INCSTAT(g_stats.this_frame.num_xf_loads);
    }
  }
  OPCODE_CALLBACK(void OnCP(u8 command, u32 value))
  {
    m_cycles += 12;
    const u8 sub_command = command & CP_COMMAND_MASK;
    if constexpr (!is_preprocess)
    {
      if (sub_command == MATINDEX_A)
      {
        VertexLoaderManager::g_needs_cp_xf_consistency_check = true;
        auto& system = Core::System::GetInstance();
        system.GetXFStateManager().SetTexMatrixChangedA(value);
      }
      else if (sub_command == MATINDEX_B)
      {
        VertexLoaderManager::g_needs_cp_xf_consistency_check = true;
        auto& system = Core::System::GetInstance();
        system.GetXFStateManager().SetTexMatrixChangedB(value);
      }
      else if (sub_command == VCD_LO || sub_command == VCD_HI)
      {
        VertexLoaderManager::g_main_vat_dirty = BitSet8::AllTrue(CP_NUM_VAT_REG);
        VertexLoaderManager::g_bases_dirty = true;
        VertexLoaderManager::g_needs_cp_xf_consistency_check = true;
      }
      else if (sub_command == CP_VAT_REG_A || sub_command == CP_VAT_REG_B ||
               sub_command == CP_VAT_REG_C)
      {
        VertexLoaderManager::g_main_vat_dirty[command & CP_VAT_MASK] = true;
        VertexLoaderManager::g_needs_cp_xf_consistency_check = true;
      }
      else if (sub_command == ARRAY_BASE)
      {
        VertexLoaderManager::g_bases_dirty = true;
      }

      INCSTAT(g_stats.this_frame.num_cp_loads);
    }
    else if constexpr (is_preprocess)
    {
      if (sub_command == VCD_LO || sub_command == VCD_HI)
      {
        VertexLoaderManager::g_preprocess_vat_dirty = BitSet8::AllTrue(CP_NUM_VAT_REG);
      }
      else if (sub_command == CP_VAT_REG_A || sub_command == CP_VAT_REG_B ||
               sub_command == CP_VAT_REG_C)
      {
        VertexLoaderManager::g_preprocess_vat_dirty[command & CP_VAT_MASK] = true;
      }
    }
    GetCPState().LoadCPReg(command, value);
  }
  OPCODE_CALLBACK(void OnBP(u8 command, u32 value))
  {
    m_cycles += 12;

    if constexpr (is_preprocess)
    {
      LoadBPRegPreprocess(command, value, m_cycles);
    }
    else
    {
      LoadBPReg(command, value, m_cycles);
      INCSTAT(g_stats.this_frame.num_bp_loads);
    }
  }
  OPCODE_CALLBACK(void OnIndexedLoad(CPArray array, u32 index, u16 address, u8 size))
  {
    m_cycles += 6;

    if constexpr (is_preprocess)
      PreprocessIndexedXF(array, index, address, size);
    else
      LoadIndexedXF(array, index, address, size);
  }
  OPCODE_CALLBACK(void OnPrimitiveCommand(OpcodeDecoder::Primitive primitive, u8 vat,
                                          u32 vertex_size, u16 num_vertices, const u8* vertex_data))
  {
    // [domino3-real] dump the first 24 post-takeover draws' (vertex_size, num_vertices) so the
    // exact dolphin decode walk can be replayed against the known-deterministic ring byte-stream
    // to find where sizing diverges from the SETDRAWDONE. Gated cpu_owner (inert on shipping).
    if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
    {
      volatile u32* dc = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1B90u));
      const u32 idx = *dc;
      if (idx < 24u)
      {
        volatile u32* slot = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1AC8u + idx * 8u));
        slot[0] = vertex_size; slot[1] = num_vertices;
      }
      *dc = idx + 1u;
    }
    // [copy-gap diag 2026-07-21 TEMP] ungated draw census (dual AND single-exec):
    // draws @0x026B289C, total verts @0x026B28A0.
    {
      volatile u32* const dn = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B289Cu));
      *dn = *dn + 1u;
      volatile u32* const dv = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28A0u));
      *dv = *dv + num_vertices;
    }
    // [garbage-draw trap 2026-07-21 TEMP] first draw with absurd num_vertices: capture the
    // 64 stream bytes around vertex_data (host ptr into fifo/RAM) @0x026B28C0, flag @0x026B28B8.
    if (num_vertices > 2000u)
    {
      volatile u32* const flag = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28B8u));
      if (*flag == 0u)
      {
        *flag = 1u;
        const u8* const dump_base = vertex_data - 16;
        for (int k = 0; k < 16; k++)
        {
          u32 w;
          std::memcpy(&w, dump_base + k * 4, 4);
          reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28C0u))[k] = w;
        }
      }
    }
    // load vertices
    const u32 size = vertex_size * num_vertices;

#ifdef __EMSCRIPTEN__
    // [dc device-gate 2026-07-22 — the drain-#79 RunFifo freeze] The frozen chunk decodes to
    // the FIRST DRAW (0x80 quads, VAT setup preceding); RunVertices reaches the WGPU vertex-
    // manager buffer paths on the gpu_thread, where no per-thread WebGPU device exists, and
    // never returns. Stream advance is computed by detail::RunCommand independently of
    // RunVertices, so skipping vertex processing here is size-safe. Interim gate, same class
    // as the Flush/EFB-copy gates; lifts with the device migration. Gate-hit flag @0x026B3370.
    if (!Core::WGPUDeviceLiveOnThisThread())
    {
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3370u)) = 1u;
      m_cycles += num_vertices * 4 * 3 + 6;
      return;
    }
#endif
    const u32 bytes =
        VertexLoaderManager::RunVertices<is_preprocess>(vat, primitive, num_vertices, vertex_data);

    ASSERT(bytes == size);

    // 4 GPU ticks per vertex, 3 CPU ticks per GPU tick
    m_cycles += num_vertices * 4 * 3 + 6;
  }
  // This can't be inlined since it calls Run, which makes it recursive
  // m_in_display_list prevents it from actually recursing infinitely, but there's no real benefit
  // to inlining Run for the display list directly.
  OPCODE_CALLBACK_NOINLINE(void OnDisplayList(u32 address, u32 size))
  {
    // [copy-gap diag 2026-07-21 TEMP] CALL_DL census: count @0x026B28A4, last addr/size @28A8/28AC.
    {
      volatile u32* const dl = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28A4u));
      *dl = *dl + 1u;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28A8u)) = address;
      *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B28ACu)) = size;
    }
    m_cycles += 6;

    if (m_in_display_list)
    {
      WARN_LOG_FMT(VIDEO, "recursive display list detected");
    }
    else
    {
      m_in_display_list = true;

      auto& system = Core::System::GetInstance();

      if constexpr (is_preprocess)
      {
        auto& memory = system.GetMemory();
        const u8* const start_address = memory.GetPointerForRange(address, size);

        system.GetFifo().PushFifoAuxBuffer(start_address, size);

        if (start_address != nullptr)
        {
          Run(start_address, size, *this);
        }
      }
      else
      {
        const u8* start_address;

        auto& fifo = system.GetFifo();
        if (fifo.UseDeterministicGPUThread())
        {
          start_address = static_cast<u8*>(fifo.PopFifoAuxBuffer(size));
        }
        else
        {
          auto& memory = system.GetMemory();
          start_address = memory.GetPointerForRange(address, size);
        }

        // Avoid the crash if memory.GetPointerForRange failed ..
        if (start_address != nullptr)
        {
          // temporarily swap dl and non-dl (small "hack" for the stats)
          g_stats.SwapDL();

          Run(start_address, size, *this);
          INCSTAT(g_stats.this_frame.num_dlists_called);

          // un-swap
          g_stats.SwapDL();
        }
      }

      m_in_display_list = false;
    }
  }
  OPCODE_CALLBACK(void OnNop(u32 count))
  {
    m_cycles += 6 * count;  // Hm, this means that we scan over nop streams pretty slowly...
  }
  OPCODE_CALLBACK(void OnUnknown(u8 opcode, const u8* data))
  {
    if (static_cast<Opcode>(opcode) == Opcode::GX_CMD_UNKNOWN_METRICS)
    {
      // 'Zelda Four Swords' calls it and checks the metrics registers after that
      m_cycles += 6;
      DEBUG_LOG_FMT(VIDEO, "GX 0x44");
    }
    else if (static_cast<Opcode>(opcode) == Opcode::GX_CMD_INVL_VC)
    {
      // Invalidate Vertex Cache
      m_cycles += 6;
      DEBUG_LOG_FMT(VIDEO, "Invalidate (vertex cache?)");
    }
    else
    {
      auto& system = Core::System::GetInstance();
      system.GetCommandProcessor().HandleUnknownOpcode(opcode, data, is_preprocess);
      m_cycles += 1;
    }
  }

  OPCODE_CALLBACK(void OnCommand(const u8* data, u32 size))
  {
    ASSERT(size >= 1);
    if constexpr (!is_preprocess)
    {
      // [domino3-real] record dolphin's actual decoded opcode SEQUENCE (first 256) + sizes so we can
      // diff vs the known-deterministic worker stream and find the exact desync opcode. Gated cpu_owner.
      if (*reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u)
      {
        volatile u32* cc = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1BF0u));
        const u32 i = *cc;
        if (i < 256u) {
          *reinterpret_cast<volatile u8*>(static_cast<uintptr_t>(0x026B1C00u + i)) = data[0];
          *reinterpret_cast<volatile u8*>(static_cast<uintptr_t>(0x026B1E00u + i)) = static_cast<u8>(size > 255 ? 255 : size);
        }
        *cc = i + 1u;
      }
      // Display lists get added directly into the FIFO stream since this same callback is used to
      // process them.
      if (g_record_fifo_data && static_cast<Opcode>(data[0]) != Opcode::GX_CMD_CALL_DL)
      {
        Core::System::GetInstance().GetFifoRecorder().WriteGPCommand(data, size);
      }
    }
  }

  OPCODE_CALLBACK(CPState& GetCPState())
  {
    if constexpr (is_preprocess)
      return g_preprocess_cp_state;
    else
      return g_main_cp_state;
  }

  OPCODE_CALLBACK(u32 GetVertexSize(u8 vat))
  {
    VertexLoaderBase* loader = VertexLoaderManager::RefreshLoader<is_preprocess>(vat);
    return loader->m_vertex_size;
  }

  u32 m_cycles = 0;
  bool m_in_display_list = false;
};

template <bool is_preprocess>
u8* RunFifo(DataReader src, u32* cycles)
{
  using CallbackT = RunCallback<is_preprocess>;
  auto callback = CallbackT{};
  u32 size = Run(src.GetPointer(), static_cast<u32>(src.size()), callback);

  if (cycles != nullptr)
    *cycles = callback.m_cycles;

  src.Skip(size);
  return src.GetPointer();
}

template u8* RunFifo<true>(DataReader src, u32* cycles);
template u8* RunFifo<false>(DataReader src, u32* cycles);

}  // namespace OpcodeDecoder
