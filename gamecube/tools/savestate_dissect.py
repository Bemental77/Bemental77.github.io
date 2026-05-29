#!/usr/bin/env python3
"""
savestate_dissect.py — parses a Dolphin GameCube savestate file and dumps the
top-level chunks the format defines.

Cited from gamecube/dolphin-src/Source/Core/Core/State.cpp:

    State.cpp:98   constexpr u32 STATE_VERSION = 177;
    State.cpp:106  constexpr u32 COOKIE_BASE = 0xBAADBABE;
    State.cpp:124  static constexpr bool s_use_compression = true;
    State.cpp:328  CompressBufferToFile -> LZ4_compress_default per <=LZ4_MAX_INPUT_SIZE chunk
    State.cpp:639  DecompressLZ4 -> reads s32 compressed_data_len, then that many bytes,
                   per <=LZ4_MAX_INPUT_SIZE input chunk of the original buffer.
    State.cpp:139  DoState(System&, PointerWrap&) — master walker (top-level order):
                       u8 is_wii            (bool stable=u8)
                       u32 state_mem1_size
                       u32 state_mem2_size
                       Movie::DoState              + DoMarker("Movie")
                       g_video_backend->DoState    + DoMarker("video_backend")
                       CoreTiming::DoState         + DoMarker("CoreTiming")
                       HW::DoState                 + DoMarker("HW")
                       PowerPC::DoState            + DoMarker("PowerPC")
                       (Wiimote skipped on GC)     + DoMarker("Wiimote")
                       Gecko::DoState              + DoMarker("Gecko")

    HW.cpp:97 HW::DoState (subsystem order, each followed by its DoMarker):
                       Memory, MemoryInterface, VideoInterface, SerialInterface,
                       ProcessorInterface, DSP, DVDInterface, GPFifo,
                       ExpansionInterface, AudioInterface, HSP
                       (then "WIIHW" marker)

    Memmap.cpp:502 Memory::DoState writes:
                       u32 state_ram_size, u32 state_l1_cache_size,
                       u8 state_have_fake_vmem, u32 state_fake_vmem_size,
                       u8 state_have_exram, u32 state_exram_size,
                       u8[state_ram_size]       (MEM1)
                       u8[state_l1_cache_size]  (L1 cache)
                       DoMarker("Memory RAM")
                       u8[state_fake_vmem_size] (if present)
                       DoMarker("Memory FakeVMEM")
                       u8[state_exram_size]     (if present, Wii only)
                       DoMarker("Memory EXRAM")

    Memmap.h:35 MEM1_SIZE_RETAIL = 0x01800000 (24 MiB) — but the savestate
        actually stores m_ram_size, which is NextPowerOf2(GetRamSizeReal())
        = 0x02000000 (32 MiB) per Memmap.cpp:101. DoState() calls
        DoArray(m_ram, current_ram_size) at :540 where current_ram_size is
        GetRamSize() (rounded), not GetRamSizeReal() (raw 24 MiB). So MEM1
        block in the savestate is 32 MiB, with the upper 8 MiB being the
        allocator's overflow region (typically zero on retail).

    PowerPC.cpp:110 PowerPCManager::DoState order:
                       gpr[32]                  128 B
                       pc, npc                  8 B
                       cr.fields[8]u64          64 B (ConditionRegister.h:45)
                       msr, fpscr               8 B
                       Exceptions               4 B
                       downcount (int)          4 B
                       xer_ca (u8), xer_so_ov (u8), xer_stringctrl (u16)  4 B
                       ps[32] (PairedSingle{u64,u64})       512 B
                       sr[16]                   64 B
                       spr[1024]                4096 B
                       tlb[2][64] of TLBEntry(9 u32 = 36 B) 4608 B
                       pagetable_base, pagetable_mask       8 B
                       pagetable_update_pending (u8)        1 B
                       reserve (u8), reserve_address (u32)  5 B
                       iCache.DoState, dCache.DoState (large)
                       MMU::DoState, JitInterface::DoState

    ChunkFile.h:303 DoMarker writes u32 cookie = arbitraryNumber (default 0x42).
    ChunkFile.h:277 bool serializes as u8.

Markers do NOT include the marker name in the stream — only a u32 cookie 0x42 is
written. So chunk boundaries are recoverable only by walking the format from the
start; markers act as sanity checks.

Output: /tmp/savestate-dump/
"""

from __future__ import annotations

import os
import struct
import sys
from pathlib import Path

import lz4.block

SAVESTATE_PATH = os.path.expanduser(
    "~/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01"
)
OUT_DIR = Path("/tmp/savestate-dump")

# State.cpp:98, :101, :104, :106
STATE_VERSION = 177
EXTENDED_HEADER_VERSION = 1
COMPRESSED_DATA_OFFSET = 0
COOKIE_BASE = 0xBAADBABE

# Memmap.h:35-37
MEM1_SIZE_RETAIL = 0x01800000
MEM2_SIZE_RETAIL = 0x04000000

# PowerPC.h:51-53
TLB_SIZE = 128
TLB_WAYS = 2
NUM_TLBS = 2

# State.cpp:337  LZ4_MAX_INPUT_SIZE — the value LZ4 ships with (LZ4_MAX_INPUT_SIZE
# is defined as 0x7E000000 = 2113929216 in lz4.h). The Dolphin loop in
# CompressBufferToFile compresses <= this many bytes of input per block, so each
# decoded block is also <= this many bytes.
LZ4_MAX_INPUT_SIZE = 0x7E000000


class Cursor:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.off = 0
        self.length = len(buf)

    def read(self, n: int) -> bytes:
        if self.off + n > self.length:
            raise EOFError(f"read({n}) at off={self.off} past end={self.length}")
        b = self.buf[self.off:self.off + n]
        self.off += n
        return b

    def peek(self, n: int) -> bytes:
        return self.buf[self.off:self.off + n]

    def u8(self) -> int:
        return self.read(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.read(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.read(4))[0]

    def s32(self) -> int:
        return struct.unpack("<i", self.read(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.read(8))[0]

    def f64(self) -> float:
        return struct.unpack("<d", self.read(8))[0]

    def skip(self, n: int):
        if self.off + n > self.length:
            raise EOFError(f"skip({n}) at off={self.off} past end={self.length}")
        self.off += n


def parse_file_header(f) -> dict:
    # State.cpp:557 ReadStateHeaderFromFile
    raw_legacy = f.read(24)
    game_id = raw_legacy[0:6].decode("ascii", errors="replace")
    lzo_size = struct.unpack("<I", raw_legacy[8:12])[0]
    save_time = struct.unpack("<d", raw_legacy[16:24])[0]
    assert lzo_size == 0, (
        f"Legacy LZO state (lzo_size={lzo_size}) unsupported by this script"
    )

    raw_ver = f.read(8)
    cookie, ver_str_len = struct.unpack("<II", raw_ver)
    state_version = cookie - COOKIE_BASE
    ver_str = f.read(ver_str_len).decode("utf-8", errors="replace")

    raw_ext = f.read(16)
    hv, ct, pay_off, usize = struct.unpack("<HHIQ", raw_ext)
    return {
        "game_id": game_id,
        "save_time": save_time,
        "version_cookie": cookie,
        "state_version": state_version,
        "version_str": ver_str,
        "header_version": hv,
        "compression_type": ct,  # 0=Uncompressed, 1=LZ4
        "payload_offset": pay_off,
        "uncompressed_size": usize,
        "payload_file_offset": f.tell() + pay_off,
    }


def decompress_lz4_stream(f, uncompressed_size: int) -> bytes:
    # State.cpp:639 DecompressLZ4: repeated [s32 len][len bytes] blocks until
    # the cumulative decompressed size matches the header's uncompressed_size.
    out = bytearray()
    block_idx = 0
    while len(out) < uncompressed_size:
        raw_len = f.read(4)
        if len(raw_len) < 4:
            raise RuntimeError(
                f"unexpected EOF reading block-len at decoded={len(out)}/{uncompressed_size}"
            )
        comp_len = struct.unpack("<i", raw_len)[0]
        if comp_len <= 0:
            raise RuntimeError(f"bad compressed block length {comp_len}")
        comp = f.read(comp_len)
        if len(comp) != comp_len:
            raise RuntimeError(
                f"short read on compressed block: got {len(comp)}/{comp_len}"
            )
        max_dec = min(LZ4_MAX_INPUT_SIZE, uncompressed_size - len(out))
        # lz4.block.decompress on raw LZ4-block data; need uncompressed size.
        dec = lz4.block.decompress(comp, uncompressed_size=max_dec)
        out.extend(dec)
        block_idx += 1
    if len(out) != uncompressed_size:
        raise RuntimeError(
            f"size mismatch: decoded {len(out)} != header {uncompressed_size}"
        )
    return bytes(out)


def expect_marker(c: Cursor, name: str, log) -> None:
    # ChunkFile.h:303 DoMarker(name, arbitraryNumber=0x42)
    off_before = c.off
    val = c.u32()
    expected = 0x42
    ok = "OK" if val == expected else "BAD"
    log(f"  marker {name!r:24s} @ off=0x{off_before:08x} cookie=0x{val:08x} [{ok}]")
    if val != expected:
        raise RuntimeError(
            f"marker mismatch for {name!r}: got 0x{val:08x} expected 0x{expected:08x}"
        )


def parse_powerpc_state(c: Cursor, out_dir: Path, log) -> dict:
    start = c.off
    # gpr[32] (PowerPC.cpp:124)
    gpr = list(struct.unpack("<32I", c.read(32 * 4)))
    pc = c.u32()       # :125
    npc = c.u32()      # :126
    cr_fields = list(struct.unpack("<8Q", c.read(8 * 8)))  # :127
    msr = c.u32()      # :128
    fpscr = c.u32()    # :129
    exceptions = c.u32()                                    # :130
    downcount = struct.unpack("<i", c.read(4))[0]           # :131 int
    xer_ca = c.u8()                                         # :132
    xer_so_ov = c.u8()                                      # :133
    xer_stringctrl = c.u16()                                # :134
    ps_bytes = c.read(32 * 16)                              # :135 ps[32] = 32 * (u64+u64)
    sr = list(struct.unpack("<16I", c.read(16 * 4)))        # :136
    spr = list(struct.unpack("<1024I", c.read(1024 * 4)))   # :137
    tlb_bytes = c.read(NUM_TLBS * (TLB_SIZE // TLB_WAYS) * 9 * 4)  # :138 tlb[2][64] of 9 u32
    pagetable_base = c.u32()                                # :139
    pagetable_mask = c.u32()                                # :140
    pagetable_update_pending = c.u8()                       # :141 bool→u8
    reserve = c.u8()                                        # :143 bool→u8
    reserve_address = c.u32()                               # :144
    ppc_state_end = c.off

    # Write the raw PPC state slab for downstream tools.
    (out_dir / "powerpc_state.bin").write_bytes(c.buf[start:ppc_state_end])

    # Write decoded summary.
    lines = []
    lines.append(f"PC      = 0x{pc:08x}")
    lines.append(f"NPC     = 0x{npc:08x}")
    lines.append(f"MSR     = 0x{msr:08x}")
    lines.append(f"FPSCR   = 0x{fpscr:08x}")
    lines.append(f"Exceptions = 0x{exceptions:08x}")
    lines.append(f"downcount  = {downcount} (0x{downcount & 0xffffffff:08x})")
    lines.append(
        f"XER     = ca={xer_ca} so_ov=0x{xer_so_ov:02x} stringctrl=0x{xer_stringctrl:04x}"
    )
    lines.append("CR fields[0..7] (u64 each):")
    for i, v in enumerate(cr_fields):
        lines.append(f"  cr.field[{i}] = 0x{v:016x}")
    lines.append("GPRs:")
    for i in range(0, 32, 4):
        chunk = " ".join(f"r{j:02d}=0x{gpr[j]:08x}" for j in range(i, i + 4))
        lines.append("  " + chunk)
    lines.append("SR (segment registers) [0..15]:")
    for i in range(0, 16, 4):
        chunk = " ".join(f"sr{j:02d}=0x{sr[j]:08x}" for j in range(i, i + 4))
        lines.append("  " + chunk)
    lines.append(f"pagetable_base = 0x{pagetable_base:08x}")
    lines.append(f"pagetable_mask = 0x{pagetable_mask:08x}")
    lines.append(f"pagetable_update_pending = {pagetable_update_pending}")
    lines.append(f"reserve = {reserve}, reserve_address = 0x{reserve_address:08x}")

    # Some notable SPRs (Gekko)
    notable = {
        1: "XER",
        8: "LR",
        9: "CTR",
        18: "DSISR",
        19: "DAR",
        22: "DEC",
        25: "SDR1",
        26: "SRR0",
        27: "SRR1",
        268: "TBL",
        269: "TBU",
        272: "SPRG0",
        273: "SPRG1",
        274: "SPRG2",
        275: "SPRG3",
        287: "PVR",
        528: "IBAT0U", 529: "IBAT0L",
        530: "IBAT1U", 531: "IBAT1L",
        532: "IBAT2U", 533: "IBAT2L",
        534: "IBAT3U", 535: "IBAT3L",
        536: "DBAT0U", 537: "DBAT0L",
        538: "DBAT1U", 539: "DBAT1L",
        540: "DBAT2U", 541: "DBAT2L",
        542: "DBAT3U", 543: "DBAT3L",
        912: "GQR0", 913: "GQR1", 914: "GQR2", 915: "GQR3",
        916: "GQR4", 917: "GQR5", 918: "GQR6", 919: "GQR7",
        920: "HID2", 936: "HID0", 1008: "HID0_alt", 1009: "HID1",
        1017: "L2CR", 1019: "ICTC",
    }
    lines.append("Notable SPRs:")
    for idx in sorted(notable.keys()):
        if idx < len(spr) and spr[idx] != 0:
            lines.append(f"  spr[{idx:4d}] {notable[idx]:8s} = 0x{spr[idx]:08x}")

    summary_path = out_dir / "powerpc_state.txt"
    summary_path.write_text("\n".join(lines) + "\n")
    log(f"  wrote {summary_path} ({summary_path.stat().st_size} B)")
    log(f"  wrote {out_dir/'powerpc_state.bin'} (PPC state slab = {ppc_state_end-start} B)")

    # Also drop ps and tlb as raw blobs.
    (out_dir / "powerpc_ps.bin").write_bytes(ps_bytes)
    (out_dir / "powerpc_tlb.bin").write_bytes(tlb_bytes)
    (out_dir / "powerpc_spr.bin").write_bytes(struct.pack("<1024I", *spr))

    return {
        "pc": pc, "npc": npc, "msr": msr, "fpscr": fpscr,
        "exceptions": exceptions, "downcount": downcount,
        "gpr": gpr, "cr_fields": cr_fields, "spr": spr,
        "ppc_state_bytes": ppc_state_end - start,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(SAVESTATE_PATH, "rb") as f:
        hdr = parse_file_header(f)
        log = lambda *a: print(*a, flush=True)
        log("=== File header ===")
        for k, v in hdr.items():
            log(f"  {k}: {v!r}")

        assert hdr["state_version"] == STATE_VERSION, (
            f"state version {hdr['state_version']} != built-in {STATE_VERSION}; "
            f"format may differ. Aborting."
        )
        assert hdr["header_version"] == EXTENDED_HEADER_VERSION
        if hdr["compression_type"] == 1:
            log("=== Decompressing LZ4 stream ===")
            data = decompress_lz4_stream(f, hdr["uncompressed_size"])
        elif hdr["compression_type"] == 0:
            data = f.read(hdr["uncompressed_size"])
        else:
            raise RuntimeError(f"unknown compression_type {hdr['compression_type']}")

    (OUT_DIR / "decompressed.bin").write_bytes(data)
    log(f"wrote {OUT_DIR/'decompressed.bin'} ({len(data)} bytes)")

    c = Cursor(data)
    log("\n=== Top-level DoState walker (State.cpp:139) ===")
    is_wii = c.u8()
    state_mem1 = c.u32()
    state_mem2 = c.u32()
    log(f"  is_wii            = {is_wii}")
    log(f"  state_mem1_size   = 0x{state_mem1:08x}  ({state_mem1 // 0x100000} MiB)")
    log(f"  state_mem2_size   = 0x{state_mem2:08x}  ({state_mem2 // 0x100000} MiB)")
    assert state_mem1 == MEM1_SIZE_RETAIL, (
        f"state_mem1_size {state_mem1:#x} != MEM1_SIZE_RETAIL {MEM1_SIZE_RETAIL:#x} "
        f"(Memmap.h:35); aborting"
    )

    # Movie::DoState — variable-length; can't decode without porting Movie.cpp.
    # We use markers as anchors. The marker is just u32 0x42, so we have to
    # *walk* Movie's structure to find its end. Since Movie isn't critical for
    # this dissector, we scan forward from here for the first 0x42-cookie u32
    # that matches at a 4-byte boundary AND whose preceding bytes have a
    # plausible Movie-DoState tail. That heuristic is fragile, so we instead
    # bail out of structural walking after PowerPC and content-extract the
    # things we CAN do without knowing every variable-length size.
    movie_start = c.off

    # Strategy: find Memory::DoState header by its 18-byte signature:
    #   state_ram_size       = u32  GetRamSize() = NextPowerOf2(GetRamSizeReal())
    #                                            = 0x02000000 for retail (24 MiB rounded to 32)
    #   state_l1_cache_size  = u32  0x00040000 (256 KiB)
    #   state_have_fake_vmem = u8   1 for GC w/o MMU
    #   state_fake_vmem_size = u32  0x02000000 (32 MiB)
    #   state_have_exram     = u8   0 for GC
    #   state_exram_size     = u32  0
    # MEM1_SIZE_RETAIL (Memmap.h:35) is 0x01800000 — that's GetRamSizeReal(),
    # NOT what's serialized; serialization uses the power-of-2 rounded size.
    log("\n=== Anchored search for Memory::DoState header ===")
    GC_RAM_ROUNDED = 0x02000000  # NextPowerOf2(MEM1_SIZE_RETAIL)
    GC_L1 = 0x00040000
    GC_FV = 0x02000000  # Memmap.cpp:103 m_fakevmem_size = 0x02000000
    # GC w/ MMU off (fake_vmem present, no exram)
    needle_a = (struct.pack("<II", GC_RAM_ROUNDED, GC_L1)
                + b"\x01" + struct.pack("<I", GC_FV)
                + b"\x00" + struct.pack("<I", 0))
    # GC w/ MMU on  (no fake_vmem, no exram)
    needle_b = (struct.pack("<II", GC_RAM_ROUNDED, GC_L1)
                + b"\x00" + struct.pack("<I", 0)
                + b"\x00" + struct.pack("<I", 0))
    pos = data.find(needle_a)
    if pos < 0:
        pos = data.find(needle_b)
    if pos < 0:
        log("  could not find Memory::DoState header; aborting structural walk")
        return
    log(f"  Memory::DoState header at off=0x{pos:08x}")
    c.off = pos
    mem_state_ram_size = c.u32()
    mem_state_l1_size = c.u32()
    have_fake_vmem = c.u8()
    fake_vmem_size = c.u32()
    have_exram = c.u8()
    exram_size = c.u32()
    log(f"  state_ram_size       = 0x{mem_state_ram_size:08x}")
    log(f"  state_l1_cache_size  = 0x{mem_state_l1_size:08x}")
    log(f"  have_fake_vmem       = {have_fake_vmem}  size=0x{fake_vmem_size:08x}")
    log(f"  have_exram           = {have_exram}      size=0x{exram_size:08x}")

    mem1 = c.read(mem_state_ram_size)
    l1 = c.read(mem_state_l1_size)
    (OUT_DIR / "mem1.bin").write_bytes(mem1)
    (OUT_DIR / "l1_cache.bin").write_bytes(l1)
    log(f"  wrote {OUT_DIR/'mem1.bin'} ({len(mem1)} B)")
    log(f"  wrote {OUT_DIR/'l1_cache.bin'} ({len(l1)} B)")
    expect_marker(c, "Memory RAM", log)
    if have_fake_vmem and fake_vmem_size:
        fv = c.read(fake_vmem_size)
        (OUT_DIR / "fake_vmem.bin").write_bytes(fv)
        log(f"  wrote {OUT_DIR/'fake_vmem.bin'} ({len(fv)} B)")
    expect_marker(c, "Memory FakeVMEM", log)
    if have_exram and exram_size:
        ex = c.read(exram_size)
        (OUT_DIR / "exram.bin").write_bytes(ex)
    expect_marker(c, "Memory EXRAM", log)
    expect_marker(c, "Memory", log)  # the outer HW.cpp:100 marker

    # After Memory comes MemoryInterface, VideoInterface, SerialInterface,
    # ProcessorInterface, DSP, DVDInterface, GPFifo, ExpansionInterface,
    # AudioInterface, HSP — each variable-length. We cannot reliably decode
    # them without porting their DoState methods, AND we cannot reliably walk
    # them by scanning for the marker cookie 0x42 because that 32-bit pattern
    # collides with legitimate state values (every "B"-ASCII u32, every small
    # int 66, etc.) inside the chunks. So we record the byte range of the
    # entire "HW-subsystems + Wiimote skip" region as one opaque slab, and
    # locate the PowerPC chunk by content-anchoring on the PPC state signature.
    hw_subsystems_start = c.off

    # Content anchor: the PowerPC state begins with gpr[32] (128 bytes) then
    # pc (u32) then npc (u32). Both PC and NPC must be valid GC code/data
    # addresses, and they are almost always within the standard 0x8000_0000..
    # 0x8180_0000 BAT-mapped MEM1 range during normal execution. Scan forward
    # for 4-byte-aligned (PC,NPC) pair where both are in that range AND
    # |PC-NPC| is small (typically 0 or 4 — NPC is the next instruction).
    log("\n=== Locating PowerPC chunk by content anchor (PC/NPC pair) ===")
    scan_from = c.off
    ppc_start = -1
    i = scan_from
    while i + 128 + 8 <= len(data):
        pc_cand = struct.unpack_from("<I", data, i + 128)[0]
        npc_cand = struct.unpack_from("<I", data, i + 132)[0]
        if (0x80000000 <= pc_cand < 0x81800000 and
                0x80000000 <= npc_cand < 0x81800000 and
                abs((pc_cand & 0xFFFFFFFF) - (npc_cand & 0xFFFFFFFF)) <= 16):
            # Additional sanity: r1 (gpr[1], stack pointer) should also be a
            # valid GC pointer (0x80000000..0x81800000) at this point in normal
            # SAB execution.
            r1 = struct.unpack_from("<I", data, i + 4)[0]
            if 0x80000000 <= r1 < 0x81800000:
                ppc_start = i
                break
        i += 4
    if ppc_start < 0:
        log("  could not locate PowerPC chunk by content anchor")
        log(f"  scan started at 0x{scan_from:08x}, buf size 0x{len(data):08x}")
        # still dump everything we have
        opaque = data[hw_subsystems_start:]
        (OUT_DIR / "hw_subsystems_and_tail.bin").write_bytes(opaque)
        return

    # Capture the entire "HW subsystems opaque" region between Memory and PPC.
    hw_subsystems_end = ppc_start
    opaque = data[hw_subsystems_start:hw_subsystems_end]
    (OUT_DIR / "hw_subsystems_opaque.bin").write_bytes(opaque)
    log(
        f"  HW subsystems opaque region [0x{hw_subsystems_start:08x}..0x{hw_subsystems_end:08x}) "
        f"= {hw_subsystems_end - hw_subsystems_start} B  -> hw_subsystems_opaque.bin"
    )
    log("  (MemoryInterface/VideoInterface/SerialInterface/ProcessorInterface/DSP/"
        "DVDInterface/GPFifo/ExpansionInterface/AudioInterface/HSP all packed here)")

    c.off = ppc_start
    log(f"\n=== PowerPC::DoState (PowerPC.cpp:110) — anchored at 0x{ppc_start:08x} ===")
    ppc = parse_powerpc_state(c, OUT_DIR, log)
    log(f"  PPC state slab off=[0x{ppc_start:08x}..0x{c.off:08x})")
    log(f"  PC=0x{ppc['pc']:08x}  NPC=0x{ppc['npc']:08x}  MSR=0x{ppc['msr']:08x}")
    log(f"  remaining after PPC-state slab: {c.length - c.off} B")
    log("  (iCache, dCache, MMU, JitInterface state follows but is not decoded)")

    # Honest enumeration: what we did NOT extract
    print("\n=== Not-extracted chunks (honest enumeration) ===")
    not_extracted = [
        ("is_wii/MEM1/MEM2 preamble", "extracted ok"),
        ("Movie chunk", "skipped — variable-length, would require porting Core/Movie.cpp DoState"),
        ("video_backend chunk", "skipped — virtual VideoBackendBase::DoState dispatch into Vulkan/OGL/SW backends"),
        ("CoreTiming chunk", "skipped — variable-length event queue serialization"),
        ("Memory::DoState (MEM1, L1)", "extracted ok"),
    ]
    for name, status in not_extracted:
        print(f"  {name}: {status}")
    print("  HW subsystems (MemoryInterface..HSP) + WIIHW marker:")
    print("    extracted as ONE opaque blob (hw_subsystems_opaque.bin) — individual")
    print("    decoding requires porting each subsystem DoState (e.g. VideoInterface.cpp,")
    print("    SI.cpp, DSP_HLE/DSP_LLE.cpp, EXI.cpp, etc.).")
    print("  PowerPC::DoState: PPC state slab decoded; iCache/dCache/MMU/JitInterface tails NOT decoded")
    print("  Wiimote: not present (GC)")
    print("  Gecko::DoState: NOT walked (would need Core/GeckoCode.cpp DoState)")

    # Summary
    print("\n=== Output ===")
    for p in sorted(OUT_DIR.iterdir()):
        sz = p.stat().st_size
        print(f"  {sz:>12d}  {p}")


if __name__ == "__main__":
    main()
