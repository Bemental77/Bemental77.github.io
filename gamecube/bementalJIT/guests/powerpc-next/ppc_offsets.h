#pragma once
//
// PowerPCState struct offsets — bit-compatible with Dolphin's
// PowerPC::PowerPCState layout. Used by every per-op emitter to address
// fields inside the emulated CPU state struct (which lives at
// SAB[0x02400000] in shared memory per 2e.6).
//
// This header replaces the live tree's `ppc_off::` namespace in
// gekko_emit.h; numeric values match byte-for-byte.

#include "bementalJIT/types.h"

namespace bemental::powerpc::ppc_off {

constexpr u32 PC          = 0x000;
constexpr u32 NPC         = 0x004;
constexpr u32 GPR_BASE    = 0x014;
constexpr u32 PS_BASE     = 0x0A0;
constexpr u32 CR_BASE     = 0x2A0;  // CR[0..7], each u64
constexpr u32 MSR         = 0x2E0;
constexpr u32 FPSCR       = 0x2E4;
constexpr u32 XER_CA          = 0x2F4;  // u8
constexpr u32 XER_SO_OV       = 0x2F5;  // u8 — format: (SO << 1) | OV
constexpr u32 XER_STRINGCTRL  = 0x2F6;  // u16 — BYTE_COUNT | (BYTE_CMP << 8)
constexpr u32 SPR_BASE        = 0x340;

constexpr u32 gpr(u32 n)  { return GPR_BASE + (n * 4u); }
constexpr u32 cr(u32 n)   { return CR_BASE + (n * 8u); }
constexpr u32 spr(u32 n)  { return SPR_BASE + (n * 4u); }
// PairedSingle = 16 bytes (ps0 + ps1, each f64). Per gekko_emit.h:117-120.
constexpr u32 ps0(u32 n)  { return PS_BASE + (n * 16u) + 0u; }
constexpr u32 ps1(u32 n)  { return PS_BASE + (n * 16u) + 8u; }

// Common SPR indices (PowerPC architecture).
constexpr u32 SPR_XER     = 1;
constexpr u32 SPR_LR      = 8;
constexpr u32 SPR_CTR     = 9;
constexpr u32 SPR_DSISR   = 18;
constexpr u32 SPR_DAR     = 19;
constexpr u32 SPR_DEC     = 22;
constexpr u32 SPR_SDR     = 25;
constexpr u32 SPR_SRR0    = 26;
constexpr u32 SPR_SRR1    = 27;
constexpr u32 SPR_SPRG0   = 272;
constexpr u32 SPR_SPRG1   = 273;
constexpr u32 SPR_SPRG2   = 274;
constexpr u32 SPR_SPRG3   = 275;
constexpr u32 SPR_TBL_R   = 268;   // read-only TBL
constexpr u32 SPR_TBU_R   = 269;
constexpr u32 SPR_TBL_W   = 284;   // write-only TBL
constexpr u32 SPR_TBU_W   = 285;
constexpr u32 SPR_PVR     = 287;
constexpr u32 SPR_HID0    = 1008;
constexpr u32 SPR_HID2    = 920;
constexpr u32 SPR_MMCR0   = 952;   // perf-monitor control 0
constexpr u32 SPR_MMCR1   = 956;   // perf-monitor control 1

constexpr u32 lr_off()    { return spr(SPR_LR); }
constexpr u32 ctr_off()   { return spr(SPR_CTR); }
constexpr u32 srr0_off()  { return spr(SPR_SRR0); }
constexpr u32 srr1_off()  { return spr(SPR_SRR1); }

}  // namespace bemental::powerpc::ppc_off
