#!/usr/bin/env python3
"""gcsdk_siggen.py — generate reloc-tolerant signatures from GameCube SDK .a libs.

Reads each .a in --sdk-libs (default: /tmp/gcsdk_apr2004/HW2_libraries), extracts
its .o files, walks the ELF symbol table for STT_FUNC entries in executable
sections, computes the per-major-opcode-masked hash that Dolphin's
SignatureDB.cpp:161-219 uses, and emits master_sigs.json.

The hash is reloc-tolerant by construction: per-major-opcode masking discards
the displacement / IMM / SDA-21 fields that ELF relocations patch. So byte-
exact comparison between SDK .o (with placeholder zeros) and game DOL (with
resolved addresses) still hashes identically when the function body is
otherwise unchanged.

Output format (one entry per function):
  { "size": <bytes>, "hash": "0xXXXXXXXX", "name": "ARQInit",
    "source": "ar.a/arq.o" }

Usage:
  python3 tools/gcsdk_siggen.py \
    --sdk-libs /tmp/gcsdk_apr2004/HW2_libraries \
    --out tools/master_sigs.json
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from elftools.elf.elffile import ELFFile
from elftools.elf.sections import SymbolTableSection


# Path to llvm-ar (PowerPC ELF .a). Falls back to system ar.
LLVM_AR = "/Users/caseybement/Bemental77.github.io/emsdk/upstream/bin/llvm-ar"
if not os.path.exists(LLVM_AR):
    LLVM_AR = "ar"


def compute_code_checksum(opcodes):
    """Port of HashSignatureDB::ComputeCodeChecksum (SignatureDB.cpp:161-219).

    opcodes: iterable of u32 instructions in big-endian-as-int form.
    Returns a u32 hash that is invariant under R_PPC_REL24 / SDA21 /
    ADDR16_LO/HA relocations because per-major-opcode masking discards the
    fields they patch.
    """
    s = 0
    for opcode in opcodes:
        opcode &= 0xFFFFFFFF
        op = opcode & 0xFC000000
        op2 = 0
        op3 = 0
        auxop = op >> 26
        if auxop == 4:  # PS instructions
            op2 = opcode & 0x0000003F
            if op2 in (0, 8, 16, 21, 22):
                op3 = opcode & 0x000007C0
        elif auxop in (7, 8, 10, 11, 12, 13, 14, 15):  # addi muli etc
            op2 = opcode & 0x03FF0000
        elif auxop in (19, 31, 63):
            op2 = opcode & 0x000007FF
        elif auxop == 59:  # FP single
            op2 = opcode & 0x0000003F
            if op2 < 16:
                op3 = opcode & 0x000007C0
        elif 32 <= auxop < 56:  # load/store
            op2 = opcode & 0x03FF0000
        # else default: only the top-6-bit major opcode contributes.
        s = ((s << 17) & 0xFFFE0000) | ((s >> 15) & 0x0001FFFF)
        s = (s ^ (op | op2 | op3)) & 0xFFFFFFFF
    return s


def iter_text_func_symbols(elf):
    """Yield (name, st_value, st_size, section_index, section_data) for each
    STT_FUNC symbol with non-zero size in an executable PROGBITS section."""
    sym_table = None
    for section in elf.iter_sections():
        if isinstance(section, SymbolTableSection):
            sym_table = section
            break
    if sym_table is None:
        return
    SHF_EXECINSTR = 0x4
    SHT_PROGBITS = 1
    STT_FUNC = 2
    for sym in sym_table.iter_symbols():
        if sym["st_info"]["type"] != "STT_FUNC":
            continue
        if sym["st_size"] == 0:
            continue
        shndx = sym["st_shndx"]
        # SHN_UNDEF=0, SHN_ABS=0xfff1, SHN_COMMON=0xfff2 — skip
        if isinstance(shndx, str):
            continue
        if shndx == 0 or shndx >= 0xff00:
            continue
        section = elf.get_section(shndx)
        if section is None:
            continue
        if section["sh_type"] != "SHT_PROGBITS":
            continue
        if not (section["sh_flags"] & SHF_EXECINSTR):
            continue
        data = section.data()
        offset = sym["st_value"]  # offset within section for relocatable .o
        size = sym["st_size"]
        if offset + size > len(data):
            continue
        yield (sym.name, offset, size, shndx, data[offset:offset + size])


def extract_archive_members(ar_path, dest_dir):
    """ar x ar_path → dest_dir. Returns list of extracted .o files."""
    # llvm-ar prints "x - foo.o" lines on extract; just enumerate after.
    subprocess.run([LLVM_AR, "x", str(ar_path)], cwd=dest_dir, check=True,
                   capture_output=True)
    # llvm-ar extracts with mode 0400; chmod up so we can read.
    members = sorted(Path(dest_dir).glob("*.o"))
    for m in members:
        m.chmod(0o644)
    return members


def hash_function_bytes(func_bytes):
    """Compute checksum of an aligned-4 byte stream."""
    n = len(func_bytes) // 4
    opcodes = [
        int.from_bytes(func_bytes[i * 4:i * 4 + 4], "big")
        for i in range(n)
    ]
    return compute_code_checksum(opcodes)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sdk-libs", default="/tmp/gcsdk_apr2004/HW2_libraries",
                    help="dir of .a archives")
    ap.add_argument("--out", default="tools/master_sigs.json",
                    help="output JSON path")
    ap.add_argument("--min-size", type=int, default=16,
                    help="skip functions smaller than this many bytes "
                         "(too generic / collision-prone)")
    ap.add_argument("--archives", nargs="*",
                    help="restrict to these .a basenames (e.g. ar.a ai.a). "
                         "Default = all non-D variants.")
    args = ap.parse_args()

    sdk_dir = Path(args.sdk_libs)
    if not sdk_dir.is_dir():
        print(f"ERROR: --sdk-libs {sdk_dir} not a directory", file=sys.stderr)
        return 2

    # Pick non-debug variants by default.
    if args.archives:
        archives = [sdk_dir / a for a in args.archives]
    else:
        archives = sorted(p for p in sdk_dir.glob("*.a")
                          if not p.stem.endswith("D"))

    sigs = []  # list of {size, hash, name, source}
    skipped_small = 0
    skipped_misaligned = 0

    for ar_path in archives:
        if not ar_path.exists():
            print(f"WARN: missing {ar_path}", file=sys.stderr)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            try:
                obj_files = extract_archive_members(ar_path, tmp)
            except subprocess.CalledProcessError as e:
                print(f"WARN: extract {ar_path} failed: {e}", file=sys.stderr)
                continue
            for obj_path in obj_files:
                try:
                    with open(obj_path, "rb") as f:
                        elf = ELFFile(f)
                        for name, off, size, shndx, fbytes in iter_text_func_symbols(elf):
                            if size < args.min_size:
                                skipped_small += 1
                                continue
                            if size % 4 != 0:
                                skipped_misaligned += 1
                                continue
                            h = hash_function_bytes(fbytes)
                            sigs.append({
                                "size": size,
                                "hash": f"0x{h:08x}",
                                "name": name,
                                "source": f"{ar_path.name}/{obj_path.name}",
                            })
                except Exception as e:
                    print(f"WARN: parse {obj_path}: {e}", file=sys.stderr)
                    continue

    # De-dupe identical (size, hash, name) triples — different .o variants
    # of the same fn (debug vs release etc.) often produce same sig.
    seen = set()
    unique = []
    for s in sigs:
        key = (s["size"], s["hash"], s["name"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(s)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({"signatures": unique}, f, indent=2)

    # Distinct (size, hash) pairs = effective lookup keys; collisions across
    # names mean ambiguous matches the scanner will flag.
    distinct_lookup = len(set((s["size"], s["hash"]) for s in unique))
    print(f"wrote {len(unique)} signatures ({distinct_lookup} unique lookup keys) → {out_path}")
    print(f"  archives: {len(archives)}")
    print(f"  skipped: {skipped_small} too-small (< {args.min_size}B), "
          f"{skipped_misaligned} non-4-aligned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
