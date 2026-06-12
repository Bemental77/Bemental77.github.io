// Copyright 2008 Dolphin Emulator Project
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

namespace Core
{
class CPUThreadGuard;
}

namespace HLE_Misc
{
void UnimplementedFunction(const Core::CPUThreadGuard& guard);
void HBReload(const Core::CPUThreadGuard& guard);
void GeckoCodeHandlerICacheFlush(const Core::CPUThreadGuard& guard);
void GeckoReturnTrampoline(const Core::CPUThreadGuard& guard);

// SDK-helper HLE replacements native Dolphin installs for SAB:
//   - PPCMfhid2 inlined 2-instr helper (mfspr r3, HID2; blr). The
//     compiler inlines it at multiple PCs; SAB's symbol DB matches the
//     name at 0x800e34a4 / 0x800e34ac / 0x800e34e0 even though the
//     CodeWarrior names there are PPCMfhid0 / PPCMfl2cr / PPCMfhid2
//     (all 3 share the same instruction pattern → same handler).
//   - strncpy: dst, src, n → host strncpy; replaces the SDK's loop.
void HLE_PPCMfhid2(const Core::CPUThreadGuard& guard);
void HLE_Strncpy(const Core::CPUThreadGuard& guard);
// HLE_TraceDispatcher — Start-hook for the interrupt-mask-decoder at
// 0x800e7e9c (cntlzw r3 switch). Logs r3 (caller's pending-interrupt
// bitmap) + r4 (sub-status) on entry. Used to identify which cntlzw
// value triggers the SAB-on-WASM dispatcher spin (pass-5 diagnosis).
void HLE_TraceDispatcher(const Core::CPUThreadGuard& guard);
}  // namespace HLE_Misc
