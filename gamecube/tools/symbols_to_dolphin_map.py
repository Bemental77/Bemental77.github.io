#!/usr/bin/env python3
"""symbols_to_dolphin_map.py — convert a decomp-toolkit symbols.txt into a
Dolphin-format symbol map (the `.text section layout` format Dolphin's
SymbolDB loads from ~/Library/Application Support/Dolphin/Maps/<GameID>.map,
same shape as dolphin_captures/sab.map).

Closes the "no Dolphin auto-map exists for GMPE01" gap
(gamecube/docs/REFERENCE_ASSETS.md): with GMPE01.map installed, native
Dolphin symbolizes MP4 PCs in logs/GDB, and repo-root dolphin_profile.py
works for gameid GMPE01 unmodified (it reads Maps/{gameid}.map).

Usage:
  python3 gamecube/tools/symbols_to_dolphin_map.py \
      ~/gc_refs/marioparty4/config/GMPE01_01/symbols.txt \
      "$HOME/Library/Application Support/Dolphin/Maps/GMPE01.map"

symbols.txt line shape:  Name = .section:0xADDR; // type:function size:0xSZ ...
Dolphin map line shape:  ADDR SIZE ADDR 0 Name   (size 6-hex, under a
".text section layout" / ".data section layout" header)
"""
import re
import sys

LINE_RE = re.compile(
    r"^(?P<name>\S+)\s*=\s*(?P<section>\.[A-Za-z0-9_.]+):0x(?P<addr>[0-9A-Fa-f]{8});"
    r"(?:\s*//\s*(?P<attrs>.*))?$")
SIZE_RE = re.compile(r"size:0x([0-9A-Fa-f]+)")
TYPE_RE = re.compile(r"type:(\w+)")

# Sections whose symbols execute (go under .text layout; everything else .data)
TEXT_SECTIONS = {".init", ".text"}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]

    text_rows, data_rows = [], []
    skipped = 0
    with open(src, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = LINE_RE.match(line)
            if not m:
                skipped += 1
                continue
            name, section = m.group("name"), m.group("section")
            addr = int(m.group("addr"), 16)
            attrs = m.group("attrs") or ""
            sm = SIZE_RE.search(attrs)
            size = int(sm.group(1), 16) if sm else 4
            tm = TYPE_RE.search(attrs)
            is_func = (tm.group(1) == "function") if tm else (section in TEXT_SECTIONS)
            row = f"{addr:08x} {size:06x} {addr:08x} 0 {name}"
            (text_rows if (is_func or section in TEXT_SECTIONS) else data_rows).append((addr, row))

    text_rows.sort()
    data_rows.sort()
    with open(dst, "w", encoding="utf-8") as out:
        out.write(".text section layout\n")
        for _, row in text_rows:
            out.write(row + "\n")
        if data_rows:
            out.write("\n.data section layout\n")
            for _, row in data_rows:
                out.write(row + "\n")

    print(f"wrote {dst}: {len(text_rows)} text + {len(data_rows)} data symbols "
          f"({skipped} unparsed lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
