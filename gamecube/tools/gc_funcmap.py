#!/usr/bin/env python3
"""gc_funcmap.py — recover FUNCTION BOUNDARIES for a GameCube DOL, so a guest-PC
census can attribute every sample to a function instead of to a 256B bucket.

WHY THIS EXISTS
---------------
`gamecube/docs/sab-frame-governor/TASKS.md` recorded a PC census in which most
samples resolved to nothing. The cause is NOT bucket granularity and NOT `.rel`
overlays — it is that the only SAB symbol source, `tools/gsne8p_xref.map`, names
441 functions covering 101,884 of the 1,507,392 bytes of SAB's DOL `.text`
(6.8%). A sample landing in the other 93.2% has nothing to resolve against.

Names for that 93.2% do not exist offline (no SAB decomp — see
`gc_recomp_host_layer_is_73pct_platform`: `~/gc_refs/sadx` is Sonic Adventure DX
and contains zero SAB game code). But BOUNDARIES do: they are recoverable from
the DOL itself, and a boundary is what a census actually needs. "8.3% in
fn_800f3710" is a rankable, disassemblable, run-to-run-stable identity;
"8.3% in bucket 0x800f3700" is not.

ALGORITHM (carve-between-call-targets)
--------------------------------------
1. SEEDS  — addresses that are provably function entries:
     * the DOL entry point,
     * every static `bl` target that lands in a text section,
     * every start in the supplied symbol map (`--map`).
2. CARVE  — walk from each start; track the furthest forward branch target seen
   so far; the function ends at the first terminator (`blr` / `bctr` / `rfi` /
   unconditional `b`) at or past that watermark. This is what makes early
   returns and if/else tails not split a function.
3. GAP FILL — if the carve ends before the next seed, the bytes in between are a
   function nothing calls statically (a vtable / callback / jump-table target).
   Skip `nop`/zero padding and carve again. This is the case `PPCAnalyst` misses
   and `tools/gcsdk_scan.py`'s header calls out by name.
4. NAME   — a recovered function whose start is covered by the symbol map takes
   that name; otherwise it is emitted as `fn_<addr>`, which marks it explicitly
   as a recovered boundary and not a claimed identity.

VALIDATION IS BUILT IN — do not trust this tool on SAB/PSO without running it:
    python3 gamecube/tools/gc_funcmap.py --rom 0 --validate
scores the recovery against MP4's byte-identical decomp symbol table
(`tools/gmpe01_full.map`, 7,697 entries), which is ground truth.

Usage:
  python3 gamecube/tools/gc_funcmap.py --rom 1 --out tools/gsne8p_fn.map
  python3 gamecube/tools/gc_funcmap.py --rom 0 --validate
  python3 gamecube/tools/gc_funcmap.py --rom 1 --validate   # self-consistency only
"""
import argparse
import os
import re
import struct
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# rom_idx -> (binary path, name map path, output fn-map path)
# The DOL offset inside an ISO is ALWAYS read from the header word at 0x420
# (CLAUDE.md gate #10: a hardcoded 0x1e700 silently disassembled an empty
# buffer for every PSO run through disasm_hot_pcs.py).
ROMS = {
    0: dict(bin=os.path.expanduser("~/gc_refs/marioparty4/build/GMPE01_01/main.dol"),
            kind="dol", name_map="tools/gmpe01_full.map", out="tools/gmpe01_fn.map",
            game="MP4/GMPE01"),
    1: dict(bin=os.path.join(REPO, "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"),
            kind="iso", name_map="tools/gsne8p_xref.map", out="tools/gsne8p_fn.map",
            game="SAB/GSNE8P"),
    2: dict(bin=os.path.join(REPO, "gamecube/roms/PhantasyStarOnline1And2Plus.bin"),
            kind="iso", name_map="tools/gpoe8p_xref.map", out="tools/gpoe8p_fn.map",
            game="PSO/GPOE8P"),
    3: dict(bin=os.path.join(REPO, "gamecube/roms/240pSuite-1.10b.dol"),
            kind="dol", name_map=None, out="tools/suite240p_fn.map",
            game="240pSuite"),
}

_ROW = re.compile(
    r'^\s*([0-9a-fA-F]{8})\s+([0-9a-fA-F]{4,8})\s+[0-9a-fA-F]{8}\s+[0-9a-fA-F]+\s+(\S+)')

BLR, BCTR, RFI = 0x4E800020, 0x4E800420, 0x4C000064
PAD = (0x60000000, 0x00000000)


# ---------------------------------------------------------------- binary load

def load_rom(path):
    """Read a ROM; concatenate `<path>.part??` when the plain file is absent
    (matches tools/gcsdk_scan.py:load_rom — the big ISOs ship split)."""
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    import glob
    parts = sorted(glob.glob(path + ".part??"))
    if not parts:
        raise FileNotFoundError(path)
    buf = bytearray()
    for p in parts:
        with open(p, 'rb') as f:
            buf += f.read()
    return bytes(buf)


def dol_base(rom, kind):
    """DOL start offset. For an ISO/GCM it is the big-endian word at 0x420."""
    if kind == "dol":
        return 0
    return struct.unpack('>I', rom[0x420:0x424])[0]


def text_sections(rom, base):
    """[(vaddr, size, file_off)] for the 7 TEXT slots that are non-empty."""
    hdr = rom[base:base + 0x100]
    offs = struct.unpack('>18I', hdr[0x00:0x48])
    adrs = struct.unpack('>18I', hdr[0x48:0x90])
    szs = struct.unpack('>18I', hdr[0x90:0xD8])
    out = []
    for i in range(7):
        if szs[i] and adrs[i]:
            out.append((adrs[i], szs[i], base + offs[i]))
    out.sort()
    return out


def entry_point(rom, base):
    return struct.unpack('>I', rom[base + 0xE0:base + 0xE4])[0]


class Text:
    """Word-addressable view of the DOL's text sections."""

    def __init__(self, rom, secs):
        self.secs = secs
        self.words = {}       # vaddr -> u32, only for text
        for (a, sz, off) in secs:
            blob = rom[off:off + sz]
            n = len(blob) // 4
            vals = struct.unpack('>%dI' % n, blob[:n * 4])
            for i, w in enumerate(vals):
                self.words[a + 4 * i] = w
        self.lo = min(a for a, _, _ in secs)
        self.hi = max(a + sz for a, sz, _ in secs)

    def w(self, a):
        return self.words.get(a)

    def has(self, a):
        return a in self.words


# ------------------------------------------------------------------ decoding

def sext(v, bits):
    m = 1 << (bits - 1)
    return (v ^ m) - m


def branch_target(pc, w):
    """(target, is_call, is_unconditional_branch) for b/bc; None target if the
    target is not statically known (bclr/bcctr/absolute)."""
    op = w >> 26
    if op == 18:                                     # b / ba / bl / bla
        li = sext(w & 0x03FFFFFC, 26)
        aa, lk = (w >> 1) & 1, w & 1
        tgt = li if aa else (pc + li) & 0xFFFFFFFF
        return tgt, bool(lk), not lk
    if op == 16:                                     # bc / bca / bcl / bcla
        bd = sext(w & 0x0000FFFC, 16)
        aa, lk = (w >> 1) & 1, w & 1
        tgt = bd if aa else (pc + bd) & 0xFFFFFFFF
        return tgt, bool(lk), False
    return None, False, False


def is_terminator(w):
    """True for instructions after which control does NOT fall through."""
    if w in (BLR, BCTR, RFI):
        return True
    if (w >> 26) == 18 and not (w & 1):              # unconditional b / ba
        return True
    if (w >> 26) == 19:                              # bclr/bcctr family
        xo = (w >> 1) & 0x3FF
        if xo in (16, 528):                          # bclr, bcctr
            bo = (w >> 21) & 0x1F
            lk = w & 1
            return (bo & 0x14) == 0x14 and not lk    # branch-always, no link
    return False


# ------------------------------------------------------------------- carving

def collect_seeds(text, ep, map_starts):
    """Provable function entries: the DOL entry, every static `bl` target inside
    text, and every symbol-map start."""
    seeds = set()
    if text.has(ep):
        seeds.add(ep)
    ncall = 0
    for pc, w in text.words.items():
        if (w >> 26) != 18 or not (w & 1):           # only `bl`/`bla`
            continue
        tgt, is_call, _ = branch_target(pc, w)
        if tgt is not None and text.has(tgt):
            if tgt not in seeds:
                ncall += 1
            seeds.add(tgt)
    nmap = 0
    for a in map_starts:
        if text.has(a) and a not in seeds:
            nmap += 1
        if text.has(a):
            seeds.add(a)
    return seeds, ncall, nmap


def carve(text, start, limit):
    """Walk from `start`; return the exclusive end address of the function.

    Watermark rule: a terminator only ends the function once we are at or past
    the furthest forward branch target seen inside it. That is what stops an
    early `blr` or an if/else tail from splitting one function into several.
    """
    pc = start
    water = start
    while pc < limit and text.has(pc):
        w = text.w(pc)
        tgt, is_call, _ = branch_target(pc, w)
        if tgt is not None and not is_call and start < tgt < limit and tgt > water:
            water = tgt
        if is_terminator(w) and pc >= water:
            return pc + 4
        pc += 4
    return min(limit, pc)


def skip_padding(text, a, limit):
    while a < limit and text.has(a) and text.w(a) in PAD:
        a += 4
    return a


def recover(text, seeds):
    """[(addr, size, kind)] covering every text byte. kind: 'seed' when the
    start was a provable entry, 'gap' when it was recovered by gap fill."""
    ordered = sorted(seeds)
    funcs = []
    for (sa, ssz, _off) in text.secs:
        send = sa + ssz
        pc = sa
        si = 0
        while si < len(ordered) and ordered[si] < sa:
            si += 1
        while pc < send:
            was_seed = si < len(ordered) and ordered[si] == pc
            while si < len(ordered) and ordered[si] <= pc:
                si += 1
            limit = ordered[si] if si < len(ordered) and ordered[si] < send else send
            end = carve(text, pc, limit)
            if end <= pc:
                end = pc + 4
            funcs.append((pc, end - pc, 'seed' if was_seed else 'gap'))
            nxt = skip_padding(text, end, send)
            pc = min(nxt, limit) if limit > end else max(limit, end)
            if pc <= funcs[-1][0]:
                pc = funcs[-1][0] + 4
    funcs.sort()
    return funcs


# --------------------------------------------------------------------- names

def load_map(path):
    out = []
    if not path or not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            m = _ROW.match(line)
            if m and int(m.group(2), 16):
                out.append((int(m.group(1), 16), int(m.group(2), 16), m.group(3)))
    out.sort()
    return out


def name_for(named, addr):
    """Exact-start name, else None. (Deliberately exact: crediting a recovered
    boundary with the name of a symbol it merely overlaps is how the old
    resolver credited a whole 256B bucket to `__check_pad3`.)"""
    return named.get(addr)


# ---------------------------------------------------------------- validation

def validate(text, funcs, truth):
    """Score recovery against a ground-truth symbol table.

    Reports the number the census actually depends on: ATTRIBUTION — for every
    4-byte-aligned address inside a ground-truth function, does the recovered
    table put it in a function with the SAME start address?
    """
    truth = [t for t in truth if text.has(t[0])]
    tstarts = set(a for a, _, _ in truth)
    rstarts = set(a for a, _, _ in funcs)

    exact = len(tstarts & rstarts)
    missed = sorted(tstarts - rstarts)
    extra = sorted(rstarts - tstarts)

    # attribution over every instruction address covered by ground truth
    starts_sorted = sorted(rstarts)
    import bisect
    def owner(pc):
        i = bisect.bisect_right(starts_sorted, pc) - 1
        return starts_sorted[i] if i >= 0 else None

    ok = bad = 0
    bad_by_fn = {}
    for (a, sz, n) in truth:
        for pc in range(a, a + sz, 4):
            if not text.has(pc):
                continue
            if owner(pc) == a:
                ok += 1
            else:
                bad += 1
                bad_by_fn[n] = bad_by_fn.get(n, 0) + 1
    return dict(truth=len(truth), recovered=len(funcs), exact=exact,
                missed=missed, extra=extra, attr_ok=ok, attr_bad=bad,
                bad_by_fn=bad_by_fn)


# -------------------------------------------------------------------- driver

def build(rom_idx, verbose=True, map_seeds=True):
    cfg = ROMS[rom_idx]
    rom = load_rom(cfg["bin"])
    base = dol_base(rom, cfg["kind"])
    secs = text_sections(rom, base)
    text = Text(rom, secs)
    ep = entry_point(rom, base)
    nm = load_map(os.path.join(REPO, cfg["name_map"])) if cfg["name_map"] else []
    seeds, ncall, nmap = collect_seeds(
        text, ep, [a for a, _, _ in nm] if map_seeds else [])
    funcs = recover(text, seeds)
    if verbose:
        tot = sum(sz for _, sz, _ in secs)
        print("# %-12s DOL@0x%x  %d text sections  %d bytes  entry 0x%08x"
              % (cfg["game"], base, len(secs), tot, ep), file=sys.stderr)
        print("#   seeds: %d bl-targets + %d map-only + entry = %d"
              % (ncall, nmap, len(seeds)), file=sys.stderr)
        ngap = sum(1 for _, _, k in funcs if k == 'gap')
        print("#   recovered %d functions (%d from seeds, %d gap-filled), "
              "coverage %d/%d bytes = %.1f%%"
              % (len(funcs), len(funcs) - ngap, ngap,
                 sum(sz for _, sz, _ in funcs), tot,
                 100.0 * sum(sz for _, sz, _ in funcs) / max(1, tot)),
              file=sys.stderr)
    return cfg, text, funcs, nm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rom", type=int, required=True, help="ROM_IDX 0..3")
    ap.add_argument("--out", help="output .map path (default per ROMS[])")
    ap.add_argument("--validate", action="store_true",
                    help="score recovery against --map as ground truth")
    ap.add_argument("--show-missed", type=int, default=0)
    ap.add_argument("--no-map-seeds", action="store_true",
                    help="seed ONLY from `bl` targets + the DOL entry. Required "
                         "for an honest --validate on MP4: feeding the ground "
                         "truth in as seeds and then scoring against it is "
                         "circular, and it is also the arm that matches SAB/PSO, "
                         "where the map supplies a small minority of entries.")
    args = ap.parse_args()

    cfg, text, funcs, nm = build(args.rom, map_seeds=not args.no_map_seeds)
    named = {a: n for a, _, n in nm}

    if args.validate:
        if not nm:
            print("no name map for rom %d — nothing to validate against" % args.rom)
            return 1
        r = validate(text, funcs, nm)
        tot = r["attr_ok"] + r["attr_bad"]
        print("VALIDATE %s against %s (%d ground-truth functions in text)"
              % (cfg["game"], cfg["name_map"], r["truth"]))
        print("  exact-start recall : %d/%d = %.2f%%"
              % (r["exact"], r["truth"], 100.0 * r["exact"] / max(1, r["truth"])))
        print("  recovered functions: %d  (%d starts not in ground truth)"
              % (r["recovered"], len(r["extra"])))
        print("  ATTRIBUTION        : %d/%d instruction addresses land in the "
              "correct function = %.2f%%"
              % (r["attr_ok"], tot, 100.0 * r["attr_ok"] / max(1, tot)))
        if args.show_missed:
            print("  worst mis-attributed functions:")
            for n, c in sorted(r["bad_by_fn"].items(), key=lambda x: -x[1])[:args.show_missed]:
                print("    %6d instrs  %s" % (c, n))
        return 0

    out = args.out or os.path.join(REPO, cfg["out"])
    lines = [".text section layout"]
    nnamed = 0
    for (a, sz, kind) in funcs:
        n = name_for(named, a)
        if n:
            nnamed += 1
        else:
            n = "fn_%08x" % a
        lines.append("  %08x %08x %08x 00000000  %s\t%s"
                     % (a, sz, a, n, "named" if name_for(named, a) else kind))
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("#   named %d/%d recovered functions from %s"
          % (nnamed, len(funcs), cfg["name_map"]), file=sys.stderr)
    print("wrote %s (%d entries)" % (out, len(funcs)), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
