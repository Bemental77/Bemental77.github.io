#!/usr/bin/env python3
"""sab_cell_audit.py — find SAB scratch cells CLAIMED by more than one subsystem.

WHY THIS EXISTS. Two collisions were found on 2026-09-01, both on the PSO
wedge path, both introduced by one commit, and BOTH would have shipped on the
next link:

  0x026B3B20  FIFO-brake KILL SWITCH   reused as  stage-timer `enable`
              => arming the render-stage timers DISABLED the wedge brake, and
                 the probe's PROBE_STAGE_SPLIT writes that cell, so every
                 stage-split measurement on such a build ran unbraked.
  0x026B3930  import-unwrap gate       reused as  upload-coalescing lever
              => arming it ARMS THE WEDGE'S CAUSE (the originating commit says
                 verbatim "HARD-WEDGES PSO. 5/7 wedged").

Both of the earlier commits asserted "repo-wide grep shows no other use", and
both were wrong about the other. A grep is not an audit: the cells are written
as bare hex in unrelated subsystems, so the author of each was looking for a
name that did not exist yet.

WHAT COUNTS AS A CLAIM. Not a mention — a BINDING. A file claims a cell when it
binds the address to a name (`constexpr`/`const`/`#define`/`static const`, or a
JS `const NAME = 0x...`). Readers that merely reference someone else's named
constant are legitimate and are NOT flagged; that distinction is the whole
point, because most multi-file cells are ordinary producer->reader pairs.

Two DIFFERENT names bound to one address, in different files, is a collision.
The same name in a header and its mirror is not.

    python3 tools/sab_cell_audit.py            # audit, exit 1 on collision
    python3 tools/sab_cell_audit.py --list     # every claimed cell and its owner

Exit 1 makes this usable as a gate. It is intentionally cheap and static: no
build, no browser, no lock.
"""
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The documented GameCube SAB scratch window. Addresses outside it are guest
# RAM, MMIO or unrelated magic and are none of this tool's business.
LO, HI = 0x02680000, 0x026C0000

SCAN_DIRS = ['gamecube']
SCAN_EXT = ('.c', '.cc', '.cpp', '.h', '.hpp', '.js', '.mjs')
SKIP_PARTS = ('/build-', '/.git/', '/node_modules/', '/dist/', '/build-emcc',
              '/build-host', '/.claude/', '/build-wasm')

# A BINDING, not a mention: NAME = 0x026Bxxxx  (C++ constexpr/const/#define, JS const)
#
# ⚠ The address alternative must match the WHOLE literal. A first version wrote
# `0[xX]0?26[0-9A-Fa-f]{4}`, which captures only 7 of the 8 hex digits of
# 0x026B3BDC — it matched "0x026B3BD", whose value falls below the window, so
# every cell was silently filtered out and the tool reported "0 claimed cells,
# 0 collisions". A green audit that matches NOTHING is a placebo; it was caught
# by feeding it a synthetic collision, which it also missed.
BIND_RE = re.compile(
    r'(?:constexpr|const|#\s*define|static\s+const|let|var)\s+'
    r'(?:[A-Za-z_][\w:<>\s\*&]*?\s+)?'
    r'(?P<name>[A-Za-z_]\w*)\s*(?:=|\s)\s*'
    r'\(?\s*(?P<addr>0[xX][0-9A-Fa-f]{6,8})\s*[uU]?\)?')

def claims():
    out = defaultdict(list)          # addr -> [(name, relpath, lineno)]
    for d in SCAN_DIRS:
        for dirpath, _dirs, files in os.walk(os.path.join(ROOT, d)):
            if any(p in dirpath.replace(os.sep, '/') + '/' for p in SKIP_PARTS):
                continue
            for fn in files:
                if not fn.endswith(SCAN_EXT):
                    continue
                p = os.path.join(dirpath, fn)
                rel = os.path.relpath(p, ROOT)
                try:
                    txt = open(p, 'r', errors='replace').read()
                except OSError:
                    continue
                for m in BIND_RE.finditer(txt):
                    a = int(m.group('addr'), 16)
                    if not (LO <= a < HI):
                        continue
                    ln = txt.count('\n', 0, m.start()) + 1
                    out[a].append((m.group('name'), rel, ln))
    return out

def main():
    show_all = '--list' in sys.argv
    c = claims()
    collisions = []
    for addr, entries in sorted(c.items()):
        names = {n for (n, _f, _l) in entries}
        files = {f for (_n, f, _l) in entries}
        # A collision needs BOTH a different name AND a different file. One name
        # repeated across a header and its mirror is fine; so is a file that
        # binds an alias to a foreign cell deliberately (those alias names are
        # distinct but live in ONE file, e.g. the kForeign_* guard constants).
        if not (len(names) > 1 and len(files) > 1):
            continue
        # A DELIBERATE cross-reference is not a collision. The guard pattern is
        # to bind another subsystem's address under a kForeign_* alias purely so
        # a static_assert can compare against it — that is the fix, not the bug.
        if any(n.startswith('kForeign_') for n in names):
            continue
        # Very short identifiers are locals (`sp`, `cp`) that happen to hold a
        # SAB address, not subsystem claims on a cell.
        if all(len(n) < 3 for n in names):
            continue
        collisions.append((addr, entries))

    if show_all:
        print(f"[sab-audit] {len(c)} claimed cell(s) in {hex(LO)}..{hex(HI)}")
        for addr, entries in sorted(c.items()):
            owners = ', '.join(f"{n} ({f}:{l})" for n, f, l in entries)
            print(f"  0x{addr:08X}  {owners}")
        print()

    if not collisions:
        print(f"[sab-audit] OK — {len(c)} claimed cell(s), 0 collisions")
        return 0

    print(f"[sab-audit] {len(collisions)} COLLISION(S) — one address bound to "
          f"different names in different files:")
    for addr, entries in collisions:
        print(f"\n  0x{addr:08X}")
        for n, f, l in entries:
            print(f"      {n:<28} {f}:{l}")
    print("\n  A cell claimed twice means arming one subsystem silently changes "
          "another.\n  Move the DIAGNOSTIC cell (never the safety/control one) "
          "and add a static_assert.")
    return 1

if __name__ == '__main__':
    sys.exit(main())
