#!/usr/bin/env python3
"""dtk_extract_map.py — extract NAMED symbols from a `dtk dol split` output and
merge into one of our .map files.

Why both: dtk's bundled signature DB is hand-curated and skewed to OS / init /
exception primitives (~133 names on SAB). gcsdk_siggen.py produces a per-major-
opcode hash DB from .a archives and skews to application code (audio, CARD,
etc., ~122 names on SAB). They overlap on only ~6 names, so merging gives ~250
named symbols.

The HLE-conflict filter in gcsdk_scan.py is reused here — names listed in
Dolphin's HLE.cpp os_patches[] are dropped from the merged output to avoid
LoadMap overriding totaldb.dsy with a wrong (hash-collision) address.

Input: a `dtk dol split` output dir (must contain asm/*.s files with
       `# .text:0xOFF | 0xVADDR | size: 0xN` headers and `.fn NAME, scope`
       declarations).
Input: an existing .map (gsne8p.map style) to merge into.
Output: combined .map written to --out.
"""
import argparse
import re
import sys
from pathlib import Path


_HEADER_RE = re.compile(
    r'^# \.[a-zA-Z]+:0x[0-9A-Fa-f]+\s*\|\s*0x([0-9A-Fa-f]+)\s*\|\s*size:\s*0x([0-9A-Fa-f]+)\s*$'
)
_FN_RE = re.compile(r'^\.fn\s+([A-Za-z_][A-Za-z0-9_]*),')


def parse_dtk_asm(asm_dir):
    """Walk dtk asm/*.s files. Return list of (vaddr, size, name).
    Skips placeholder names: fn_*, lbl_*, .L_*."""
    out = []
    for asm_path in sorted(Path(asm_dir).glob('*.s')):
        last_addr = None
        last_size = None
        with open(asm_path) as f:
            for line in f:
                m = _HEADER_RE.match(line)
                if m:
                    last_addr = int(m.group(1), 16)
                    last_size = int(m.group(2), 16)
                    continue
                m = _FN_RE.match(line)
                if m and last_addr is not None:
                    name = m.group(1)
                    if name.startswith('fn_') or name.startswith('lbl_'):
                        last_addr = None
                        continue
                    out.append((last_addr, last_size, name))
                    last_addr = None
    return out


def parse_existing_map(path):
    """Return list of (addr, size, name, source) from an existing .map. Skips
    the 4-line header."""
    out = []
    if not Path(path).exists():
        return out
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if len(parts) >= 5:
            try:
                addr = int(parts[0], 16)
                size = int(parts[1], 16)
                name = parts[4]
                source = ' '.join(parts[5:]) if len(parts) > 5 else 'unknown'
                out.append((addr, size, name, source))
            except ValueError:
                pass
    return out


def load_hle_blocklist(hle_cpp_path):
    """Same as gcsdk_scan.py — read HLE.cpp os_patches[] names."""
    p = Path(hle_cpp_path)
    if not p.exists():
        return set()
    return set(re.findall(r'\{"([A-Za-z_][A-Za-z0-9_]+)"', p.read_text()))


def write_map(out_path, entries, hle_blocklist):
    """entries: dict addr → (size, name, source). Drop HLE-conflicting."""
    lines = ['.text section layout',
             '  Starting        Virtual  File',
             '  address  Size   address  offset',
             '  ---------------------------------']
    n_drop = 0
    for addr in sorted(entries):
        size, name, source = entries[addr]
        if name in hle_blocklist:
            n_drop += 1
            continue
        lines.append(f'  {addr:08x} {size:08x} {addr:08x} 00000000  {name}\t{source}')
    Path(out_path).write_text('\n'.join(lines) + '\n')
    print(f'wrote {len(lines)-4} entries → {out_path} '
          f'(dropped {n_drop} HLE-conflicting)', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asm-dir', required=True,
                    help='dtk dol split output asm/ dir')
    ap.add_argument('--existing-map', required=True,
                    help='existing .map to merge with')
    ap.add_argument('--out', required=True, help='merged .map output')
    ap.add_argument('--hle-cpp',
                    default='gamecube/dolphin-src/Source/Core/Core/HLE/HLE.cpp')
    args = ap.parse_args()

    asm_path = Path(args.asm_dir)
    if not asm_path.is_dir():
        print(f'ERROR: --asm-dir {args.asm_dir} is not a directory. '
              f'Run `dtk dol split` on the game DOL first to produce asm/*.s files.',
              file=sys.stderr)
        return 1
    if not any(asm_path.glob('*.s')):
        print(f'WARN: --asm-dir {args.asm_dir} contains no .s files. '
              f'Expected output of `dtk dol split --asm <dir>`.',
              file=sys.stderr)

    dtk_entries = parse_dtk_asm(args.asm_dir)
    print(f'dtk: {len(dtk_entries)} named entries from {args.asm_dir}',
          file=sys.stderr)

    existing = parse_existing_map(args.existing_map)
    print(f'existing map: {len(existing)} entries from {args.existing_map}',
          file=sys.stderr)

    hle_blocklist = load_hle_blocklist(args.hle_cpp)
    print(f'HLE blocklist: {len(hle_blocklist)} names from {args.hle_cpp}',
          file=sys.stderr)

    # Merge: existing first, then dtk overrides on collision (dtk likely
    # higher-quality for OS internals).
    merged = {}
    for addr, size, name, source in existing:
        merged[addr] = (size, name, source)
    n_dtk_new = 0
    n_dtk_override = 0
    for addr, size, name in dtk_entries:
        if addr in merged:
            n_dtk_override += 1
        else:
            n_dtk_new += 1
        merged[addr] = (size, name, 'dtk')
    print(f'dtk: {n_dtk_new} new, {n_dtk_override} override', file=sys.stderr)

    write_map(args.out, merged, hle_blocklist)


if __name__ == '__main__':
    sys.exit(main())
