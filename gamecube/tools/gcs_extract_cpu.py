#!/usr/bin/env python3
"""gcs_extract_cpu.py — pull MEM1 and the PowerPC register file out of a port
savestate (.gcs / .gcs.gz = the raw State::DoState buffer, no header) so an
OFFLINE harness can run guest code from a real game moment.

Outputs (in <out_dir>):
  mem1.bin  32 MiB  — Memory::DoState's m_ram (guest physical 0x00000000..),
                      big-endian guest bytes exactly as the emulator holds them.
  ctx.bin   0x1400  — a PowerPCState image laid out per
                      gamecube/bementalJIT/guests/powerpc-next/ppc_offsets.h
                      (the layout the emitted wasm addresses through ctx_ptr).
  info.txt          — offsets found + pc/msr/r1/r2/r13 for the record.

How the two pieces are located (cite, don't guess):
  * MEM1: Memmap.cpp Memory::DoState writes u32 ram_size, u32 l1_size,
    u8 have_fake_vmem, u32 fake_vmem_size, u8 have_exram, u32 exram_size, then
    DoArray(m_ram, ram_size). ram_size = NextPowerOf2(24 MiB) = 0x02000000 and
    l1_size = 0x40000, so the 8-byte LE pattern (0x02000000, 0x00040000) anchors
    it; the RAM begins 18 bytes later. VERIFIED by requiring the DOL's first
    text section (read from the disc header at 0x420, never hardcoded) to sit at
    its load address inside the extracted RAM.
  * Registers: PowerPC.cpp PowerPCManager::DoState writes gpr[32], pc, npc,
    cr.fields[8] (u64), msr, fpscr, Exceptions, downcount, xer_ca, xer_so_ov,
    xer_stringctrl, ps[32] (2 x u64), sr[16], spr[1024]. The stream is byte-
    packed (bools serialize as u8), so this block is NOT 4-aligned in general —
    on sab-citye-gameplay it starts at an odd offset, which is why an aligned
    scan finds nothing. Located by scanning every byte offset after MEM1 for
    pc == npc in MEM1's cached mirror, r1 in the mirror and an MSR with
    IR|DR set and no bits above 0x40000.

Usage: gcs_extract_cpu.py <state.gcs[.gz]> <dol_or_iso_head> <out_dir>
"""
import gzip
import os
import struct
import sys


def be32(b, o):
    return struct.unpack_from('>I', b, o)[0]


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)
    state_path, disc_path, out_dir = sys.argv[1:]
    raw = (gzip.open(state_path, 'rb') if state_path.endswith('.gz') else open(state_path, 'rb')).read()
    disc = open(disc_path, 'rb').read()

    # ---- MEM1 -------------------------------------------------------------
    hdr = raw.find(struct.pack('<II', 0x02000000, 0x40000))
    if hdr < 0:
        sys.exit('no Memory::DoState header (ram_size 0x02000000, l1 0x40000)')
    have_fake, fake_size = raw[hdr + 8], struct.unpack_from('<I', raw, hdr + 9)[0]
    have_exram, exram_size = raw[hdr + 13], struct.unpack_from('<I', raw, hdr + 14)[0]
    ram_off = hdr + 18
    ram = raw[ram_off:ram_off + 0x02000000]
    if len(ram) != 0x02000000:
        sys.exit('truncated MEM1')

    # Verify against the DOL's first text section.
    dol_off = be32(disc, 0x420) if disc[:4] != b'\x00\x00\x01\x00' else 0
    t_rel, t_addr, t_size = be32(disc, dol_off), be32(disc, dol_off + 0x48), be32(disc, dol_off + 0x90)
    probe = disc[dol_off + t_rel:dol_off + t_rel + 256]
    phys = t_addr & 0x01FFFFFF
    if ram[phys:phys + 256] != probe:
        sys.exit('MEM1 check FAILED: DOL text0 @0x%08x not found at its load address' % t_addr)

    # ---- PowerPCState -----------------------------------------------------
    after = ram_off + 0x02000000 + 0x40000 + (fake_size if have_fake else 0) + \
        (exram_size if have_exram else 0)
    found = None
    for o in range(after, len(raw) - 0x1400):
        pc, npc = struct.unpack_from('<II', raw, o + 128)
        if pc != npc or (pc >> 25) != 0x40:
            continue
        r1 = struct.unpack_from('<I', raw, o + 4)[0]
        if (r1 >> 25) != 0x40:
            continue
        msr = struct.unpack_from('<I', raw, o + 200)[0]
        if (msr & 0x30) != 0x30 or msr >= 0x40000:
            continue
        found = o
        break
    if found is None:
        sys.exit('no PowerPCState block found after MEM1')

    o = found
    ctx = bytearray(0x1400)
    # ppc_offsets.h: PC 0x000, NPC 0x004, GPR_BASE 0x014, PS_BASE 0x0A0,
    # CR_BASE 0x2A0, MSR 0x2E0, FPSCR 0x2E4, EXCEPTIONS 0x2EC, DOWNCOUNT 0x2F0,
    # XER_CA 0x2F4, XER_SO_OV 0x2F5, XER_STRINGCTRL 0x2F6, sr 0x300, SPR_BASE 0x340.
    ctx[0x014:0x094] = raw[o:o + 128]                  # gpr[32]
    ctx[0x000:0x004] = raw[o + 128:o + 132]            # pc
    ctx[0x004:0x008] = raw[o + 132:o + 136]            # npc
    ctx[0x2A0:0x2E0] = raw[o + 136:o + 200]            # cr.fields[8]
    ctx[0x2E0:0x2E4] = raw[o + 200:o + 204]            # msr
    ctx[0x2E4:0x2E8] = raw[o + 204:o + 208]            # fpscr
    ctx[0x2EC:0x2F0] = raw[o + 208:o + 212]            # Exceptions
    ctx[0x2F0:0x2F4] = raw[o + 212:o + 216]            # downcount
    ctx[0x2F4] = raw[o + 216]                          # xer_ca
    ctx[0x2F5] = raw[o + 217]                          # xer_so_ov
    ctx[0x2F6:0x2F8] = raw[o + 218:o + 220]            # xer_stringctrl
    ctx[0x0A0:0x2A0] = raw[o + 220:o + 732]            # ps[32]
    ctx[0x300:0x340] = raw[o + 732:o + 796]            # sr[16]
    ctx[0x340:0x1340] = raw[o + 796:o + 796 + 4096]    # spr[1024]

    os.makedirs(out_dir, exist_ok=True)
    open(os.path.join(out_dir, 'mem1.bin'), 'wb').write(ram)
    open(os.path.join(out_dir, 'ctx.bin'), 'wb').write(bytes(ctx))
    g = lambda k: struct.unpack_from('<I', ctx, 0x14 + 4 * k)[0]
    info = ('state=%s\nram_off=%d ppc_off=%d\npc=0x%08x msr=0x%08x r1=0x%08x r2=0x%08x r13=0x%08x '
            'lr=0x%08x ctr=0x%08x exceptions=0x%x\n') % (
        os.path.basename(state_path), ram_off, o,
        struct.unpack_from('<I', ctx, 0)[0], struct.unpack_from('<I', ctx, 0x2E0)[0],
        g(1), g(2), g(13), struct.unpack_from('<I', ctx, 0x340 + 8 * 4)[0],
        struct.unpack_from('<I', ctx, 0x340 + 9 * 4)[0], struct.unpack_from('<I', ctx, 0x2EC)[0])
    open(os.path.join(out_dir, 'info.txt'), 'w').write(info)
    sys.stdout.write(info)


if __name__ == '__main__':
    main()
