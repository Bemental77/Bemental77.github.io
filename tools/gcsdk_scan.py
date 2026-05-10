#!/usr/bin/env python3
"""gcsdk_scan.py — sweep a GameCube DOL for SDK signature matches.

Loads master_sigs.json (from gcsdk_siggen.py) and walks every 4-byte-aligned
position in each text section of the input DOL/ISO, checking each candidate
size against the signature DB via Dolphin's per-major-opcode-masked hash.

Why every-position sweep instead of relying on Dolphin's PPCAnalyst:
PPCAnalyst finds function entries by walking static `bl` targets and BLR
boundaries. Many SDK fns (ARQInit, AXInit, OS scheduler internals) have
ZERO static bl callers — they're invoked via runtime-installed callbacks.
PPCAnalyst can't see them; it coalesces them into wrong-boundary giant
"functions" (per the d5_sdk_matcher_design notes). We bypass that by
sweeping ourselves.

Output: a CodeWarrior-format .map file Dolphin's PPCSymbolDB::LoadMapOnBoot
parses. Place it at User/Maps/<game_id>.map.

Usage:
  python3 tools/gcsdk_scan.py \
    --sigs tools/master_sigs.json \
    --iso 'gamecube/roms/Sonic Adventure 2 - Battle (USA).iso' \
    --out tools/gnse8p.map
"""
import argparse
import json
import sys
from pathlib import Path


# --- Hash (matches gcsdk_siggen.py / SignatureDB.cpp:161-219) ---

def mask_instruction(opcode):
    """Return the masked u32 value Dolphin's checksum mixes for one instr."""
    op = opcode & 0xFC000000
    op2 = 0
    op3 = 0
    auxop = op >> 26
    if auxop == 4:
        op2 = opcode & 0x0000003F
        if op2 in (0, 8, 16, 21, 22):
            op3 = opcode & 0x000007C0
    elif auxop in (7, 8, 10, 11, 12, 13, 14, 15):
        op2 = opcode & 0x03FF0000
    elif auxop in (19, 31, 63):
        op2 = opcode & 0x000007FF
    elif auxop == 59:
        op2 = opcode & 0x0000003F
        if op2 < 16:
            op3 = opcode & 0x000007C0
    elif 32 <= auxop < 56:
        op2 = opcode & 0x03FF0000
    return op | op2 | op3


def rotl_state(s):
    """The cumulative-state rotate Dolphin uses."""
    return (((s << 17) & 0xFFFE0000) | ((s >> 15) & 0x0001FFFF)) & 0xFFFFFFFF


# --- DOL parser ---

def parse_dol(rom_bytes, dol_off):
    """Parse a 0x100-byte DOL header. Returns list of
    (kind, addr, size, file_off) where kind is 'T' or 'D'."""
    sections = []
    hdr = rom_bytes[dol_off:dol_off + 0x100]
    for i in range(7):  # 7 text sections
        off = int.from_bytes(hdr[i * 4:i * 4 + 4], "big")
        addr = int.from_bytes(hdr[0x48 + i * 4:0x48 + i * 4 + 4], "big")
        size = int.from_bytes(hdr[0x90 + i * 4:0x90 + i * 4 + 4], "big")
        if size:
            sections.append(("T", addr, size, dol_off + off))
    for i in range(11):  # 11 data sections
        off = int.from_bytes(hdr[0x1c + i * 4:0x1c + i * 4 + 4], "big")
        addr = int.from_bytes(hdr[0x64 + i * 4:0x64 + i * 4 + 4], "big")
        size = int.from_bytes(hdr[0xac + i * 4:0xac + i * 4 + 4], "big")
        if size:
            sections.append(("D", addr, size, dol_off + off))
    return sections


def find_dol_in_iso(iso_bytes):
    """For .iso (GCM): DOL offset is at file[0x420]. Returns (dol_off, dol_total_size)."""
    dol_off = int.from_bytes(iso_bytes[0x420:0x424], "big")
    return dol_off


def load_rom(rom_path):
    """Read a ROM. If the path looks like split parts (.partaa..), concatenate.
    Otherwise read the file directly."""
    p = Path(rom_path)
    if p.exists():
        return p.read_bytes()
    # Maybe it's a split base path; try .partaa onwards.
    parts = sorted(p.parent.glob(p.name + ".part??"))
    if parts:
        out = bytearray()
        for part in parts:
            out.extend(part.read_bytes())
        return bytes(out)
    raise FileNotFoundError(rom_path)


# --- Scanner ---

def scan_section(section_bytes, section_addr, sigs_by_size, sig_table,
                 max_size, all_sizes_sorted):
    """Sweep section_bytes at every 4-byte position. For each, walk forward
    instruction-by-instruction, and at every cumulative_size that matches a
    known sig size, look up (size, state) in sig_table.

    Returns list of (addr, name, size, source) hits."""
    hits = []
    n = len(section_bytes)
    # Pre-compute masked instruction values for the whole section once.
    masked = [
        mask_instruction(int.from_bytes(section_bytes[i:i + 4], "big"))
        for i in range(0, n - (n % 4), 4)
    ]
    nm = len(masked)
    # Walk every starting position.
    for start in range(nm):
        state = 0
        for k in range(min(max_size // 4, nm - start)):
            state = rotl_state(state) ^ masked[start + k]
            sz = (k + 1) * 4
            # Quick check: is this size known?
            if sz in sigs_by_size:
                hit = sig_table.get((sz, state))
                if hit:
                    hits.append((section_addr + start * 4, hit[0], sz, hit[1]))
                    # Don't break — overlapping fns of different sizes can both
                    # hit. Caller dedupes.
    return hits


def write_map(out_path, hits, game_id="UNKNOWN"):
    """Emit a CodeWarrior-style .map file Dolphin parses.

    Format: 4-column with optional alignment + entry/object suffix.
      AAAAAAAA SSSSSSSS VVVVVVVV NNNNNNNN  name  obj_name

    Where AAAAAAAA = file_offset (we use 0), SSSSSSSS = size,
    VVVVVVVV = virtual address, NNNNNNNN = also virtual address (matches
    Dolphin's parse_entry_of expectation).
    """
    lines = [".text section layout"]
    lines.append("  Starting        Virtual  File")
    lines.append("  address  Size   address  offset")
    lines.append("  ---------------------------------")
    # Sort + dedupe by addr.
    by_addr = {}
    for addr, name, size, source in hits:
        if addr in by_addr:
            existing = by_addr[addr]
            # Prefer larger sig (more specific).
            if size <= existing[1]:
                continue
        by_addr[addr] = (name, size, source)
    for addr in sorted(by_addr):
        name, size, source = by_addr[addr]
        lines.append(f"  {addr:08x} {size:08x} {addr:08x} 00000000  {name}\t{source}")
    Path(out_path).write_text("\n".join(lines) + "\n")
    return len(by_addr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sigs", default="tools/master_sigs.json",
                    help="signature DB JSON (from gcsdk_siggen.py)")
    ap.add_argument("--iso", required=True, help="game ISO/GCM (or split base)")
    ap.add_argument("--out", required=True, help="output .map path")
    ap.add_argument("--game-id", default="UNKNOWN",
                    help="6-char game ID (informational)")
    args = ap.parse_args()

    sig_data = json.loads(Path(args.sigs).read_text())
    sigs = sig_data["signatures"]
    # Build (size, hash_int) → (name, source) lookup. On collision, keep first
    # but warn.
    sig_table = {}
    sigs_by_size = set()
    collisions = 0
    for s in sigs:
        size = s["size"]
        h = int(s["hash"], 16)
        key = (size, h)
        if key in sig_table:
            collisions += 1
            continue
        sig_table[key] = (s["name"], s["source"])
        sigs_by_size.add(size)
    max_size = max(sigs_by_size)
    all_sizes_sorted = sorted(sigs_by_size)
    print(f"loaded {len(sig_table)} unique-key sigs ({collisions} collisions); "
          f"{len(sigs_by_size)} distinct sizes; max size {max_size}B",
          file=sys.stderr)

    rom = load_rom(args.iso)
    print(f"loaded ROM {len(rom)} bytes", file=sys.stderr)
    dol_off = find_dol_in_iso(rom)
    print(f"DOL at file offset 0x{dol_off:x}", file=sys.stderr)
    sections = parse_dol(rom, dol_off)
    text_sections = [s for s in sections if s[0] == "T"]
    print(f"{len(text_sections)} text sections:", file=sys.stderr)
    for kind, addr, size, off in text_sections:
        print(f"  T addr=0x{addr:08x} size=0x{size:x} (= {size} bytes)",
              file=sys.stderr)

    all_hits = []
    for kind, addr, size, off in text_sections:
        section_bytes = rom[off:off + size]
        print(f"  scanning T 0x{addr:08x}+{size}…", file=sys.stderr)
        hits = scan_section(section_bytes, addr, sigs_by_size, sig_table,
                            max_size, all_sizes_sorted)
        print(f"    {len(hits)} raw hits", file=sys.stderr)
        all_hits.extend(hits)

    n = write_map(args.out, all_hits, args.game_id)
    print(f"wrote {n} unique-addr entries → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
