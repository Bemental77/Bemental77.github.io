// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

// AID / AUDIO_DMA controls pushing audio out to the SRC and then the speakers.
// The audio DMA pushes audio through a small FIFO 32 bytes at a time, as
// needed.

// The SRC behind the fifo eats stereo 16-bit data at a sample rate of 32khz,
// that is, 4 bytes at 32 khz, which is 32 bytes at 4 khz. We thereforce
// schedule an event that runs at 4khz, that eats audio from the fifo. Thus, we
// have homebrew audio.

// The AID interrupt is set when the fifo STARTS a transfer. It latches address
// and count into internal registers and starts copying. This means that the
// interrupt handler can simply set the registers to where the next buffer is,
// and start filling it. When the DMA is complete, it will automatically
// relatch and fire a new interrupt.

// Then there's the DSP... what likely happens is that the
// fifo-latched-interrupt handler kicks off the DSP, requesting it to fill up
// the just used buffer through the AXList (or whatever it might be called in
// Nintendo games).

#include "Core/HW/DSP.h"

#include <memory>

#include "AudioCommon/AudioCommon.h"

#include "Common/ChunkFile.h"
#include "Common/CommonTypes.h"
#include "Common/MemoryUtil.h"

#include "Core/CoreTiming.h"
#include "Core/DSPEmulator.h"
#include "Core/HW/HSP/HSP.h"
#include "Core/HW/MMIO.h"
#include "Core/HW/Memmap.h"
#include "Core/HW/ProcessorInterface.h"
#include "Core/PowerPC/PowerPC.h"
#include "Core/System.h"

namespace DSP
{
// register offsets
enum
{
  DSP_MAIL_TO_DSP_HI = 0x5000,
  DSP_MAIL_TO_DSP_LO = 0x5002,
  DSP_MAIL_FROM_DSP_HI = 0x5004,
  DSP_MAIL_FROM_DSP_LO = 0x5006,
  DSP_CONTROL = 0x500A,
  DSP_INTERRUPT_CONTROL = 0x5010,
  AR_INFO = 0x5012,  // These names are a good guess at best
  AR_MODE = 0x5016,  //
  AR_REFRESH = 0x501a,
  AR_DMA_MMADDR_H = 0x5020,
  AR_DMA_MMADDR_L = 0x5022,
  AR_DMA_ARADDR_H = 0x5024,
  AR_DMA_ARADDR_L = 0x5026,
  AR_DMA_CNT_H = 0x5028,
  AR_DMA_CNT_L = 0x502A,
  AUDIO_DMA_START_HI = 0x5030,
  AUDIO_DMA_START_LO = 0x5032,
  AUDIO_DMA_BLOCKS_LENGTH = 0x5034,  // Ever used?
  AUDIO_DMA_CONTROL_LEN = 0x5036,
  AUDIO_DMA_BLOCKS_LEFT = 0x503A,
};

DSPManager::DSPManager(Core::System& system) : m_system(system)
{
}

DSPManager::~DSPManager() = default;

// time given to LLE DSP on every read of the high bits in a mailbox
constexpr int DSP_MAIL_SLICE = 72;

void DSPManager::DoState(PointerWrap& p)
{
  if (!m_aram.wii_mode)
    p.DoArray(m_aram.ptr, m_aram.size);
  p.Do(m_dsp_control);
  p.Do(m_audio_dma);
  p.Do(m_aram_dma);
  p.Do(m_aram_info);
  p.Do(m_aram_mode);
  p.Do(m_aram_refresh);
  p.Do(m_dsp_slice);

  m_dsp_emulator->DoState(p);
}

void DSPManager::GlobalCompleteARAM(Core::System& system, u64 userdata, s64 cyclesLate)
{
  system.GetDSP().CompleteARAM(userdata, cyclesLate);
}

void DSPManager::CompleteARAM(u64 userdata, s64 cyclesLate)
{
  m_dsp_control.DMAState = 0;
  // [aram-diag 2026-07-16, UNGATED 2026-07-22] ARAM-DMA completion count @0x026B2700 — was
  // owner-gated (dead cell in the no-takeover topology; verify publish sites before trusting 0s).
  {
    volatile u32* c = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2700u));
    *c = *c + 1u;
    // [aram-diag ring 2026-07-22 TEMP] control Hex at THIS completion @0x026B3008; completions
    // arriving with the ARAM enable (0x40) CLEAR @0x026B3004 — the masked-completion census.
    *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3008u)) = m_dsp_control.Hex;
    if ((m_dsp_control.Hex & 0x40u) == 0u)
    {
      volatile u32* m = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3004u));
      *m = *m + 1u;
    }
    // [aram-diag guest-state 2026-07-22 TEMP] MP4 guest ARQ state at each completion (symbols.txt):
    // __AR_Callback @0x801D4550 -> 0x026B3220 (null => __ARHandler silently skips the chain);
    // __ARQRequestQueueLo @0x801D4578 -> 0x026B3224; __ARQRequestQueueHi @0x801D4570 -> 0x026B3228.
    {
      auto& memory = m_system.GetMemory();
      const u8* p = memory.GetPointerForRange(0x001D4550u, 0x30u);
      if (p)
      {
        u32 cb, qlo, qhi;
        std::memcpy(&cb, p, 4);
        std::memcpy(&qhi, p + 0x20, 4);
        std::memcpy(&qlo, p + 0x28, 4);
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3220u)) = Common::swap32(cb);
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3224u)) = Common::swap32(qlo);
        *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3228u)) = Common::swap32(qhi);
      }
    }
  }
  GenerateDSPInterrupt(INT_ARAM, 0);
}

DSPEmulator* DSPManager::GetDSPEmulator()
{
  return m_dsp_emulator.get();
}

void DSPManager::Init(bool hle)
{
  Reinit(hle);
  auto& core_timing = m_system.GetCoreTiming();
  m_event_type_generate_dsp_interrupt =
      core_timing.RegisterEvent("DSPint", GlobalGenerateDSPInterrupt);
  m_event_type_complete_aram = core_timing.RegisterEvent("ARAMint", GlobalCompleteARAM);
}

void DSPManager::Reinit(bool hle)
{
  m_dsp_emulator = CreateDSPEmulator(m_system, hle);
  m_is_lle = m_dsp_emulator->IsLLE();

  if (m_system.IsWii())
  {
    auto& memory = m_system.GetMemory();
    m_aram.wii_mode = true;
    m_aram.size = memory.GetExRamSizeReal();
    m_aram.mask = memory.GetExRamMask();
    m_aram.ptr = memory.GetEXRAM();
  }
  else
  {
    // On the GameCube, ARAM is accessible only through this interface.
    m_aram.wii_mode = false;
    m_aram.size = ARAM_SIZE;
    m_aram.mask = ARAM_MASK;
    m_aram.ptr = static_cast<u8*>(Common::AllocateMemoryPages(m_aram.size));
  }

  m_audio_dma = {};
  m_aram_dma = {};

  m_dsp_control.Hex = 0;
  m_dsp_control.DSPHalt = 1;

  m_aram_info.Hex = 0;
  m_aram_mode = 1;       // ARAM Controller has init'd
  m_aram_refresh = 156;  // 156MHz
}

void DSPManager::Shutdown()
{
  if (!m_aram.wii_mode)
  {
    Common::FreeMemoryPages(m_aram.ptr, m_aram.size);
    m_aram.ptr = nullptr;
  }

  m_dsp_emulator->Shutdown();
  m_dsp_emulator.reset();
}

void DSPManager::RegisterMMIO(MMIO::Mapping* mmio, u32 base)
{
  static constexpr u16 WMASK_NONE = 0x0000;
  static constexpr u16 WMASK_AR_INFO = 0x007f;
  static constexpr u16 WMASK_AR_REFRESH = 0x07ff;
  static constexpr u16 WMASK_AR_HI_RESTRICT = 0x03ff;
  static constexpr u16 WMASK_AR_CNT_DIR_BIT = 0x8000;
  static constexpr u16 WMASK_AUDIO_HI_RESTRICT_GCN = 0x03ff;
  static constexpr u16 WMASK_AUDIO_HI_RESTRICT_WII = 0x1fff;
  static constexpr u16 WMASK_LO_ALIGN_32BIT = 0xffe0;

  // Declare all the boilerplate direct MMIOs.
  struct
  {
    u32 addr;
    u16* ptr;
    u16 wmask;
  } directly_mapped_vars[] = {
      // This register is read-only
      {AR_MODE, &m_aram_mode, WMASK_NONE},

      // For these registers, only some bits can be set
      {AR_INFO, &m_aram_info.Hex, WMASK_AR_INFO},
      {AR_REFRESH, &m_aram_refresh, WMASK_AR_REFRESH},

      // For AR_DMA_*_H registers, only bits 0x03ff can be set
      // For AR_DMA_*_L registers, only bits 0xffe0 can be set
      {AR_DMA_MMADDR_H, MMIO::Utils::HighPart(&m_aram_dma.MMAddr), WMASK_AR_HI_RESTRICT},
      {AR_DMA_MMADDR_L, MMIO::Utils::LowPart(&m_aram_dma.MMAddr), WMASK_LO_ALIGN_32BIT},
      {AR_DMA_ARADDR_H, MMIO::Utils::HighPart(&m_aram_dma.ARAddr), WMASK_AR_HI_RESTRICT},
      {AR_DMA_ARADDR_L, MMIO::Utils::LowPart(&m_aram_dma.ARAddr), WMASK_LO_ALIGN_32BIT},
      // For this register, the topmost (dir) bit can also be set
      {AR_DMA_CNT_H, MMIO::Utils::HighPart(&m_aram_dma.Cnt.Hex),
       WMASK_AR_HI_RESTRICT | WMASK_AR_CNT_DIR_BIT},
      // AR_DMA_CNT_L triggers DMA

      // For AUDIO_DMA_START_HI, only bits 0x03ff can be set on GCN and 0x1fff on Wii
      // For AUDIO_DMA_START_LO, only bits 0xffe0 can be set
      // AUDIO_DMA_START_HI requires a complex write handler
      {AUDIO_DMA_START_LO, MMIO::Utils::LowPart(&m_audio_dma.SourceAddress), WMASK_LO_ALIGN_32BIT},
  };
  for (auto& mapped_var : directly_mapped_vars)
  {
    mmio->Register(base | mapped_var.addr, MMIO::DirectRead<u16>(mapped_var.ptr),
                   mapped_var.wmask != WMASK_NONE ?
                       MMIO::DirectWrite<u16>(mapped_var.ptr, mapped_var.wmask) :
                       MMIO::InvalidWrite<u16>());
  }

  // DSP mail MMIOs call DSP emulator functions to get results or write data.
  mmio->Register(base | DSP_MAIL_TO_DSP_HI, MMIO::ComplexRead<u16>([](Core::System& system, u32) {
                   auto& dsp = system.GetDSP();
                   if (dsp.m_dsp_slice > DSP_MAIL_SLICE && dsp.m_is_lle)
                   {
                     dsp.m_dsp_emulator->DSP_Update(DSP_MAIL_SLICE);
                     dsp.m_dsp_slice -= DSP_MAIL_SLICE;
                   }
                   return dsp.m_dsp_emulator->DSP_ReadMailBoxHigh(true);
                 }),
                 MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
                   auto& dsp = system.GetDSP();
                   dsp.m_dsp_emulator->DSP_WriteMailBoxHigh(true, val);
                 }));
  mmio->Register(base | DSP_MAIL_TO_DSP_LO, MMIO::ComplexRead<u16>([](Core::System& system, u32) {
                   auto& dsp = system.GetDSP();
                   return dsp.m_dsp_emulator->DSP_ReadMailBoxLow(true);
                 }),
                 MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
                   auto& dsp = system.GetDSP();
                   dsp.m_dsp_emulator->DSP_WriteMailBoxLow(true, val);
                 }));
  mmio->Register(base | DSP_MAIL_FROM_DSP_HI, MMIO::ComplexRead<u16>([](Core::System& system, u32) {
                   auto& dsp = system.GetDSP();
                   if (dsp.m_dsp_slice > DSP_MAIL_SLICE && dsp.m_is_lle)
                   {
                     dsp.m_dsp_emulator->DSP_Update(DSP_MAIL_SLICE);
                     dsp.m_dsp_slice -= DSP_MAIL_SLICE;
                   }
                   return dsp.m_dsp_emulator->DSP_ReadMailBoxHigh(false);
                 }),
                 MMIO::InvalidWrite<u16>());
  mmio->Register(base | DSP_MAIL_FROM_DSP_LO, MMIO::ComplexRead<u16>([](Core::System& system, u32) {
                   auto& dsp = system.GetDSP();
                   // [aram-diag 2026-07-22 TEMP] mail POPS @0x026B1BB0 (reading LO consumes the
                   // mail) — vs dspCauseSet: pending-mail-never-popped shows as sets>>pops.
                   {
                     volatile u32* c =
                         reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1BB0u));
                     *c = *c + 1u;
                   }
                   return dsp.m_dsp_emulator->DSP_ReadMailBoxLow(false);
                 }),
                 MMIO::InvalidWrite<u16>());

  mmio->Register(
      base | DSP_CONTROL, MMIO::ComplexRead<u16>([](Core::System& system, u32) {
        auto& dsp = system.GetDSP();
        const u16 rv = (dsp.m_dsp_control.Hex & ~DSP_CONTROL_MASK) |
               (dsp.m_dsp_emulator->DSP_ReadControlRegister() & DSP_CONTROL_MASK);
        // [aram-diag3 2026-07-17] does the guest SEE the ARAM bit when it reads DSP_CONTROL post-
        // takeover? total reads @0x026B27CC, reads-with-ARAM(0x20)-set @0x026B27C8. If the guest reads
        // DSP_CR often but ARAM is rarely set (2C8 << 2CC), the ARAM completion is cleared before the
        // guest's ISR reads it (coherency/timing) -> __ARHandler never dispatched -> pend never drains.
        // [UNGATED 2026-07-22] total reads @0x026B27CC, reads-with-ARAM-set @0x026B27C8.
        {
          volatile u32* t = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B27CCu));
          *t = *t + 1u;
          if ((rv & 0x20u) != 0u) {
            volatile u32* a = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B27C8u));
            *a = *a + 1u;
          }
        }
        return rv;
      }),
      MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
        auto& dsp = system.GetDSP();

        // [aram-diag ring 2026-07-22 TEMP, rev2 ARAM-FILTERED] ring only ARAM-relevant writes:
        // ARAM status acks (val&0x20) and enable transitions (pre 0x40 != val 0x40) — the
        // steady AID/DSP ack churn rotated the interesting init-era writes out of rev1's
        // window. {val, guest pc, pre-write control Hex} @0x026B3010, head @0x026B3000.
        if ((val & 0x20u) != 0u || ((dsp.m_dsp_control.Hex ^ val) & 0x40u) != 0u)
        {
          volatile u32* const head =
              reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B3000u));
          const u32 h = *head;
          const uintptr_t e = 0x026B3010u + (h & 31u) * 16u;
          *reinterpret_cast<volatile u32*>(e) = val;
          *reinterpret_cast<volatile u32*>(e + 4u) = system.GetPPCState().pc;
          *reinterpret_cast<volatile u32*>(e + 8u) = dsp.m_dsp_control.Hex;
          *reinterpret_cast<volatile u32*>(e + 12u) = h;
          *head = h + 1u;
        }

        UDSPControl tmpControl;
        tmpControl.Hex = (val & ~DSP_CONTROL_MASK) |
                         (dsp.m_dsp_emulator->DSP_WriteControlRegister(val) & DSP_CONTROL_MASK);

        // Not really sure if this is correct, but it works...
        // Kind of a hack because DSP_CONTROL_MASK should make this bit
        // only viewable to DSP emulator
        if (val & 1 /*DSPReset*/)
        {
          dsp.m_audio_dma.AudioDMAControl.Hex = 0;
        }

        // Update DSP related flags
        dsp.m_dsp_control.DSPReset = tmpControl.DSPReset;
        dsp.m_dsp_control.DSPAssertInt = tmpControl.DSPAssertInt;
        dsp.m_dsp_control.DSPHalt = tmpControl.DSPHalt;
        dsp.m_dsp_control.DSPInitCode = tmpControl.DSPInitCode;
        dsp.m_dsp_control.DSPInit = tmpControl.DSPInit;

        // Interrupt (mask)
        dsp.m_dsp_control.AID_mask = tmpControl.AID_mask;
        dsp.m_dsp_control.ARAM_mask = tmpControl.ARAM_mask;
        dsp.m_dsp_control.DSP_mask = tmpControl.DSP_mask;

        // [aram-diag 2026-07-16, UNGATED 2026-07-22] any DSP_CONTROL write @0x026B2714; an
        // ARAM-ack write (clears INT_ARAM) @0x026B2718.
        {
          volatile u32* w = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2714u));
          *w = *w + 1u;
          if (tmpControl.ARAM) {
            volatile u32* a = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2718u));
            *a = *a + 1u;
          }
        }

        // Interrupt
        if (tmpControl.AID)
          dsp.m_dsp_control.AID = 0;
        if (tmpControl.ARAM)
          dsp.m_dsp_control.ARAM = 0;
        if (tmpControl.DSP)
          dsp.m_dsp_control.DSP = 0;

        // unknown
        dsp.m_dsp_control.pad = tmpControl.pad;
        if (dsp.m_dsp_control.pad != 0)
        {
          PanicAlertFmt(
              "DSPInterface (w) DSP state (CC00500A) gets a value with junk in the padding {:08x}",
              val);
        }

        dsp.UpdateInterrupts();
      }));

  // ARAM MMIO controlling the DMA start.
  mmio->Register(base | AR_DMA_CNT_L,
                 MMIO::DirectRead<u16>(MMIO::Utils::LowPart(&m_aram_dma.Cnt.Hex)),
                 MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
                   auto& dsp = system.GetDSP();
                   dsp.m_aram_dma.Cnt.Hex =
                       (dsp.m_aram_dma.Cnt.Hex & 0xFFFF0000) | (val & WMASK_LO_ALIGN_32BIT);
                   dsp.Do_ARAM_DMA();
                 }));

  mmio->Register(base | AUDIO_DMA_START_HI,
                 MMIO::DirectRead<u16>(MMIO::Utils::HighPart(&m_audio_dma.SourceAddress)),
                 MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
                   auto& dsp = system.GetDSP();
                   *MMIO::Utils::HighPart(&dsp.m_audio_dma.SourceAddress) =
                       val &
                       (system.IsWii() ? WMASK_AUDIO_HI_RESTRICT_WII : WMASK_AUDIO_HI_RESTRICT_GCN);
                 }));

  // Audio DMA MMIO controlling the DMA start.
  mmio->Register(
      base | AUDIO_DMA_CONTROL_LEN, MMIO::DirectRead<u16>(&m_audio_dma.AudioDMAControl.Hex),
      MMIO::ComplexWrite<u16>([](Core::System& system, u32, u16 val) {
        auto& dsp = system.GetDSP();
        bool already_enabled = dsp.m_audio_dma.AudioDMAControl.Enable;
        dsp.m_audio_dma.AudioDMAControl.Hex = val;

        // Only load new values if we're not already doing a DMA transfer,
        // otherwise just let the new values be autoloaded in when the
        // current transfer ends.
        if (!already_enabled && dsp.m_audio_dma.AudioDMAControl.Enable)
        {
          dsp.m_audio_dma.current_source_address = dsp.m_audio_dma.SourceAddress;
          dsp.m_audio_dma.remaining_blocks_count = dsp.m_audio_dma.AudioDMAControl.NumBlocks;

          INFO_LOG_FMT(AUDIO_INTERFACE, "Audio DMA configured: {} blocks from {:#010x}",
                       dsp.m_audio_dma.AudioDMAControl.NumBlocks, dsp.m_audio_dma.SourceAddress);

          // TODO: need hardware tests for the timing of this interrupt.
          // Sky Crawlers crashes at boot if this is scheduled less than 87 cycles in the future.
          // Other Namco games crash too, see issue 9509. For now we will just push it to 200 cycles
          system.GetCoreTiming().ScheduleEvent(200, dsp.m_event_type_generate_dsp_interrupt,
                                               INT_AID);
        }
      }));

  // Audio DMA blocks remaining is invalid to write to, and requires logic on
  // the read side.
  mmio->Register(base | AUDIO_DMA_BLOCKS_LEFT,
                 MMIO::ComplexRead<u16>([](Core::System& system, u32) {
                   // remaining_blocks_count is zero-based.  DreamMix World Fighters will hang if it
                   // never reaches zero.
                   auto& dsp = system.GetDSP();
                   return (dsp.m_audio_dma.remaining_blocks_count > 0 ?
                               dsp.m_audio_dma.remaining_blocks_count - 1 :
                               0);
                 }),
                 MMIO::InvalidWrite<u16>());

  // 32 bit reads/writes are a combination of two 16 bit accesses.
  for (u32 i = 0; i < 0x1000; i += 4)
  {
    mmio->Register(base | i, MMIO::ReadToSmaller<u32>(mmio, base | i, base | (i + 2)),
                   MMIO::WriteToSmaller<u32>(mmio, base | i, base | (i + 2)));
  }
}

// UpdateInterrupts
void DSPManager::UpdateInterrupts()
{
  // For each interrupt bit in DSP_CONTROL, the interrupt enablemask is the bit directly
  // to the left of it. By doing:
  // (DSP_CONTROL>>1) & DSP_CONTROL & MASK_OF_ALL_INTERRUPT_BITS
  // We can check if any of the interrupts are enabled and active, all at once.
  bool ints_set =
      (((m_dsp_control.Hex >> 1) & m_dsp_control.Hex & (INT_DSP | INT_ARAM | INT_AID)) != 0);

  // [dsp-cr-fastpath 2026-07-17] keep the guest-visible DSP_CONTROL (0xCC00500A) mirror fresh in SAB
  // @0x026B27D4 so the worker's ISR reads it DIRECTLY (no mailbox round-trip). Same value the
  // ComplexRead returns: (Hex & ~MASK) | (DSP_emu ctrl & MASK). UpdateInterrupts runs after every
  // GenerateDSPInterrupt (sets ARAM/AID/DSP) and after the DSP_CONTROL ack write, so the interrupt
  // bits the ISR checks are always current. Throughput fix for the ARAM ARQ-chain (oracle diagnosis).
  {
    const u16 cr = static_cast<u16>((m_dsp_control.Hex & ~DSP_CONTROL_MASK) |
                   (m_dsp_emulator->DSP_ReadControlRegister() & DSP_CONTROL_MASK));
    __atomic_store_n(reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B27D4u)),
                     static_cast<u32>(cr), __ATOMIC_RELEASE);
  }

  // [aram-diag 2026-07-16, UNGATED 2026-07-22] INT_ARAM active-bit @0x026B2704; passed enable
  // check into ints_set @0x026B2708; sub-interrupt classifier (enable&active) INT_DSP@0x026B271C
  // INT_ARAM@0x026B2720 INT_AID@0x026B2724 — the storm raiser is whichever climbs.
  {
    if ((m_dsp_control.Hex & INT_ARAM) != 0) {
      volatile u32* a = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2704u));
      *a = *a + 1u;
    }
    if (ints_set) {
      volatile u32* s = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2708u));
      *s = *s + 1u;
    }
    // [aram-diag2] which DSP sub-interrupt is enabled+active (keeps INT_CAUSE_DSP pending)?
    // enable bit is directly left of the active bit: (Hex>>1) & Hex & <bit>. INT_DSP@0x026B271C,
    // INT_ARAM@0x026B2720, INT_AID@0x026B2724 -> the storm source is whichever climbs with dspToExt.
    const u32 en = (m_dsp_control.Hex >> 1) & m_dsp_control.Hex;
    if (en & INT_DSP)  { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B271Cu)); *p = *p + 1u; }
    if (en & INT_ARAM) { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2720u)); *p = *p + 1u; }
    if (en & INT_AID)  { volatile u32* p = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2724u)); *p = *p + 1u; }
  }

  // [guest-queue diag STRIPPED 2026-07-22 — 0x801d45f4 turned out to be FinishQueue (PM9);
  // the per-UpdateInterrupts guest-memory reads were hot-path cost.]
  m_system.GetProcessorInterface().SetInterrupt(ProcessorInterface::INT_CAUSE_DSP, ints_set);
}

void DSPManager::GlobalGenerateDSPInterrupt(Core::System& system, u64 DSPIntType, s64 cyclesLate)
{
  {
    // Rate-limited: every 16th call. AID events fire continuously while
    // audio DMA is enabled — we want to see if they're firing at all.
    static u32 s_ei_trace_aid_count = 0;
    if ((s_ei_trace_aid_count++ & 0xF) == 0)
    {
      NOTICE_LOG_FMT(AUDIO_INTERFACE,
                     "[ei-trace] AID event fired n={} DSPIntType={:#x}",
                     s_ei_trace_aid_count, DSPIntType);
    }
  }
  system.GetDSP().GenerateDSPInterrupt(DSPIntType, cyclesLate);
}

void DSPManager::GenerateDSPInterrupt(u64 DSPIntType, s64 cyclesLate)
{
  // [ax-dspint] TRUE raise-site census (the [ei-trace] diag below at
  // GlobalGenerateDSPInterrupt only sees the CoreTiming event path).
  // The INT_* enumeration members have values that reflect their bit positions in
  // DSP_CONTROL - we mask by (INT_DSP | INT_ARAM | INT_AID) just to ensure people
  // don't call this with bogus values.
  m_dsp_control.Hex |= (DSPIntType & (INT_DSP | INT_ARAM | INT_AID));
  UpdateInterrupts();
}

// CALLED FROM DSP EMULATOR, POSSIBLY THREADED
void DSPManager::GenerateDSPInterruptFromDSPEmu(DSPInterruptType type, int cycles_into_future)
{
  auto& core_timing = m_system.GetCoreTiming();
  core_timing.ScheduleEvent(cycles_into_future, m_event_type_generate_dsp_interrupt, type,
                            CoreTiming::FromThread::ANY);
}

// called whenever SystemTimers thinks the DSP deserves a few more cycles
void DSPManager::UpdateDSPSlice(int cycles)
{
  if (m_is_lle)
  {
    // use up the rest of the slice(if any)
    m_dsp_emulator->DSP_Update(m_dsp_slice);
    m_dsp_slice %= 6;
    // note the new budget
    m_dsp_slice += cycles;
  }
  else
  {
    m_dsp_emulator->DSP_Update(cycles);
  }
}

// This happens at 4 khz, since 32 bytes at 4khz = 4 bytes at 32 khz (16bit stereo pcm)
void DSPManager::UpdateAudioDMA()
{
  static short zero_samples[8 * 2] = {0};
  if (m_audio_dma.AudioDMAControl.Enable)
  {
    auto& memory = m_system.GetMemory();
    void* address = memory.GetPointerForRange(m_audio_dma.current_source_address, 32);
    AudioCommon::SendAIBuffer(m_system, static_cast<short*>(address), 8);

    if (m_audio_dma.remaining_blocks_count != 0)
    {
      m_audio_dma.remaining_blocks_count--;
      m_audio_dma.current_source_address += 32;
    }

    if (m_audio_dma.remaining_blocks_count == 0)
    {
      m_audio_dma.current_source_address = m_audio_dma.SourceAddress;
      m_audio_dma.remaining_blocks_count = m_audio_dma.AudioDMAControl.NumBlocks;

      // [aid-selfack 2026-07-16 — ACK-ROUTING correct-mechanism fix] Post-takeover (cpu_owner==1)
      // the AID audio-DMA interrupt fires from this 4kHz CoreTiming callback (dolphin device thread),
      // DECOUPLED from how fast the cross-thread WASM guest ISR can ack it (every DSP-reg access is a
      // mailbox round-trip). AID is the LOWEST-priority DSP sub-interrupt (dolsdk OSInterrupt.c
      // InterruptPrioTable: DSP_ARAM=idx6 group precedes DSP_AI=idx8) and AID + ARAM + DSP all share
      // the SINGLE PI cause bit INT_CAUSE_DSP. The audio buffer is already delivered to the host mixer
      // by AudioCommon::SendAIBuffer above (line 483) — INDEPENDENT of the guest ISR — and dolphin
      // auto-reloads remaining_blocks_count/current_source_address itself (lines 493-494), so the DMA
      // keeps cycling with no guest help. The guest's AID handler (__AIDHandler, ai.c: writes
      // __DSPRegs[5]=0xCC00500A with the AID bit) is pure buffer-index bookkeeping (salCallback ->
      // AIInitDMA) that game progress never waits on — aramSyncTransferQueue (0x801116e0) spin-waits
      // on ARAM, not AID. Because the throttled guest can't ack AID at 4kHz, an unacked AID keeps
      // INT_CAUSE_DSP asserted forever, drowning the guest in a DSP interrupt storm so globalCounter
      // never advances. FIX: self-ack AID on the dolphin side post-takeover — generate it (a fast
      // guest may still catch it) then immediately clear the AID active bit so it NEVER accumulates
      // into INT_CAUSE_DSP. That leaves INT_CAUSE_DSP driven ONLY by ARAM/DSP (the interrupts the
      // guest genuinely services), so ARAM completions deliver, aramQueueLo.valid drains, the spin
      // exits, and the main loop resumes. Native has no MMIO round-trip cost so it never backs up;
      // single-core boot (cpu_owner!=1) is UNAFFECTED (guest AID handler runs normally there).
      const bool takeover =
          *reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026A0000u)) == 1u;
      if (takeover)
      {
        // [aid-restore 2026-07-21] GENERATE the AID interrupt post-takeover again — native
        // semantics, NO self-ack (the guest acks). The 2026-07-17 suppression's rationale
        // ("the guest's AID handler is bookkeeping game progress never waits on") is FALSIFIED
        // by the MP4 decomp: THPSimple.c:35 registers THPAudioMixCallback via
        // AIRegisterDMACallback — the ENTIRE intro-movie A/V pacing runs off AID. Suppressing
        // it froze the movie mid-play (video holds last frame, THP ring fills, dvdCmdN dead at
        // 116) and killed game audio. The empty-vector storm the suppression fixed was caused
        // by (a) the AID SELF-ACK clearing the cause before the ISR read it (we no longer
        // self-ack) and (b) the PI-cause mirror being published AFTER the EXT raise (fixed
        // 2026-07-21, ProcessorInterface [mirror-before-raise]); the ISR is also ~100x cheaper
        // now (round-trip fastpaths). If the storm ever returns, its face is pcring@0x500 with
        // gc stalled at audio-init (~156) — re-triage there, do not re-suppress blindly.
        GenerateDSPInterrupt(DSP::INT_AID, 0);
        volatile u32* k = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2798u));
        *k = *k + 1u;
      }
      else if (false)
      {
        // [aid-recompute-only 2026-07-17 — RETIRED by aid-restore above, kept for the record]
        // Post-takeover: do NOT generate the AID interrupt (skip
        // its cause-SET), but DO keep the periodic 4kHz UpdateInterrupts() recompute.
        //
        // Two failure modes bound this. (a) Baseline (GenerateDSPInterrupt(INT_AID) + self-ack):
        // the generate's first UpdateInterrupts SETs INT_CAUSE_DSP for AID alone -> SetInterrupt
        // (DSP,true) -> UpdateException raises EXTERNAL_INT (RELEASE). The cross-thread CPU worker
        // (~100x slower to service than native's in-thread delivery) catches that EXT SET edge,
        // vectors 0x500, but the immediate AID self-ack has already cleared the PI-cause mirror by
        // the time its ISR reads it -> __OSDispatchInterrupt early-returns. Measured enAID=753 such
        // EMPTY vectors -> ~47% of guest cycles burned in the 0x500 storm, starving the data-load
        // thread (HuDataSelHeapReadNum -> HuDecodeData) so GlobalCounter crawls and stays at 33.
        // (b) Skipping AID *and* the recompute (tried 2026-07-17): removes the only 4kHz
        // UpdateInterrupts, so a pending ARAM/DSP cause is never re-freshed and INT_CAUSE_DSP
        // STICKS asserted (0x500:248359, dspToExt:34389) — strictly worse.
        //
        // This is the middle path: no AID cause-set (kills the 753 empty EXTs) but keep the
        // recompute (SetInterrupt(DSP, ints_set) from ARAM/DSP sub-bits only) so a genuinely
        // pending ARAM completion stays asserted until the guest acks it and a cleared one clears.
        // Audio still flows (SendAIBuffer above delivers the buffer; DMA self-reloads); the guest's
        // AID handler is bookkeeping game progress never waits on. Single-core boot (else) unchanged.
        UpdateInterrupts();
        volatile u32* k = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B2798u));
        *k = *k + 1u;
      }
      else
      {
        GenerateDSPInterrupt(DSP::INT_AID, 0);
      }
    }
  }
  else
  {
    AudioCommon::SendAIBuffer(m_system, &zero_samples[0], 8);
  }
}

void DSPManager::Do_ARAM_DMA()
{
  auto& core_timing = m_system.GetCoreTiming();
  auto& memory = m_system.GetMemory();

  // [aram-diag 2026-07-22 TEMP] ARAM-DMA REQUEST count @0x026B1BD0 (pair with completion
  // @0x026B2700): requests>completions = the CompleteARAM CoreTiming event never fires;
  // both zero = the guest's DMA-kick MMIO never reaches here.
  {
    volatile u32* c = reinterpret_cast<volatile u32*>(static_cast<uintptr_t>(0x026B1BD0u));
    *c = *c + 1u;
  }

  m_dsp_control.DMAState = 1;

  // [C5 2026-07-12 oracle-audit] Restored the oracle (real-hw, upstream DSP.cpp:484) ARAM-DMA
  // completion timing: (count/32)*246 ticks. The removed #ifdef __EMSCRIPTEN__ block replaced
  // this with ticksToTransfer/16 + 20000, altering guest-visible INT_ARAM interrupt cadence and
  // diverging from the interpreter spec. That override was an ANTI-STORM HACK: 64-tick instant
  // completion once caused an interrupt storm on the worker path (deliv-ring: EXT alternating
  // OSRestoreInterrupts/aramSyncTransferQueue forever; cause=0x10144 — a new DSP completion always
  // pending before the guest's rfi lands). The in-tree note (2026-07-12) recorded that reverting to
  // real-hw timing did NOT change the ~45% audio-subsystem instruction share, so the ARAM DMA rate
  // is NOT the audio-overwork driver. MUST BE BOOT-TESTED (a central boot test follows); if this
  // re-wedges the boot into the interrupt storm, it will be reverted. Not attempting to fix the
  // storm here.
  // ARAM DMA transfer rate has been measured on real hw
  int ticksToTransfer = (m_aram_dma.Cnt.count / 32) * 246;
  core_timing.ScheduleEvent(ticksToTransfer, m_event_type_complete_aram);

  // Real hardware DMAs in 32byte chunks, but we can get by with 8byte chunks
  if (m_aram_dma.Cnt.dir)
  {
    // ARAM -> MRAM
    DEBUG_LOG_FMT(DSPINTERFACE, "DMA {:08x} bytes from ARAM {:08x} to MRAM {:08x} PC: {:08x}",
                  m_aram_dma.Cnt.count, m_aram_dma.ARAddr, m_aram_dma.MMAddr,
                  m_system.GetPPCState().pc);

    // Outgoing data from ARAM is mirrored every 64MB (verified on real HW)
    m_aram_dma.ARAddr &= 0x3ffffff;
    m_aram_dma.MMAddr &= 0x3ffffff;

    if (m_aram_dma.ARAddr < m_aram.size)
    {
      while (m_aram_dma.Cnt.count)
      {
        // These are logically separated in code to show that a memory map has been set up
        // See below in the write section for more information
        if ((m_aram_info.Hex & 0xf) == 3)
        {
          memory.Write_U64_Swap(*(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask],
                                m_aram_dma.MMAddr);
        }
        else if ((m_aram_info.Hex & 0xf) == 4)
        {
          memory.Write_U64_Swap(*(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask],
                                m_aram_dma.MMAddr);
        }
        else
        {
          memory.Write_U64_Swap(*(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask],
                                m_aram_dma.MMAddr);
        }

        m_aram_dma.MMAddr += 8;
        m_aram_dma.ARAddr += 8;
        m_aram_dma.Cnt.count -= 8;
      }
    }
    else if (!m_aram.wii_mode)
    {
      while (m_aram_dma.Cnt.count)
      {
        memory.Write_U64(m_system.GetHSP().Read(m_aram_dma.ARAddr), m_aram_dma.MMAddr);
        m_aram_dma.MMAddr += 8;
        m_aram_dma.ARAddr += 8;
        m_aram_dma.Cnt.count -= 8;
      }
    }
  }
  else
  {
    // MRAM -> ARAM
    DEBUG_LOG_FMT(DSPINTERFACE, "DMA {:08x} bytes from MRAM {:08x} to ARAM {:08x} PC: {:08x}",
                  m_aram_dma.Cnt.count, m_aram_dma.MMAddr, m_aram_dma.ARAddr,
                  m_system.GetPPCState().pc);

    // Incoming data into ARAM is mirrored every 64MB (verified on real HW)
    m_aram_dma.ARAddr &= 0x3ffffff;
    m_aram_dma.MMAddr &= 0x3ffffff;

    if (m_aram_dma.ARAddr < m_aram.size)
    {
      while (m_aram_dma.Cnt.count)
      {
        if ((m_aram_info.Hex & 0xf) == 3)
        {
          *(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask] =
              Common::swap64(memory.Read_U64(m_aram_dma.MMAddr));
        }
        else if ((m_aram_info.Hex & 0xf) == 4)
        {
          if (m_aram_dma.ARAddr < 0x400000)
          {
            *(u64*)&m_aram.ptr[(m_aram_dma.ARAddr + 0x400000) & m_aram.mask] =
                Common::swap64(memory.Read_U64(m_aram_dma.MMAddr));
          }
          *(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask] =
              Common::swap64(memory.Read_U64(m_aram_dma.MMAddr));
        }
        else
        {
          *(u64*)&m_aram.ptr[m_aram_dma.ARAddr & m_aram.mask] =
              Common::swap64(memory.Read_U64(m_aram_dma.MMAddr));
        }

        m_aram_dma.MMAddr += 8;
        m_aram_dma.ARAddr += 8;
        m_aram_dma.Cnt.count -= 8;
      }
    }
    else if (!m_aram.wii_mode)
    {
      while (m_aram_dma.Cnt.count)
      {
        m_system.GetHSP().Write(m_aram_dma.ARAddr, memory.Read_U64(m_aram_dma.MMAddr));

        m_aram_dma.MMAddr += 8;
        m_aram_dma.ARAddr += 8;
        m_aram_dma.Cnt.count -= 8;
      }
    }
  }
}

// (shuffle2) I still don't believe that this hack is actually needed... :(
// Maybe the Wii Sports ucode is processed incorrectly?
// (LM) It just means that DSP reads via '0xffdd' on Wii can end up in EXRAM or main RAM
u8 DSPManager::ReadARAM(u32 address) const
{
  if (m_aram.wii_mode)
  {
    if (address & 0x10000000)
    {
      return m_aram.ptr[address & m_aram.mask];
    }
    else
    {
      auto& memory = m_system.GetMemory();
      return memory.Read_U8(address & memory.GetRamMask());
    }
  }
  else
  {
    return m_aram.ptr[address & m_aram.mask];
  }
}

void DSPManager::WriteARAM(u8 value, u32 address)
{
  // TODO: verify this on Wii
  m_aram.ptr[address & m_aram.mask] = value;
}

u8* DSPManager::GetARAMPtr() const
{
  return m_aram.ptr;
}

u32 DSPManager::GetARAMSize() const
{
  return m_aram.size;
}

}  // end of namespace DSP
