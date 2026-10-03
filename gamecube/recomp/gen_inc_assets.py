#!/usr/bin/env python3
"""gen_inc_assets.py — produce the decomp's GENERATED asset headers (*.inc) from the
game disc itself, so build_wasm.sh no longer needs the decomp's own build products.

WHY THIS EXISTS. build_wasm.sh compiles five units that `#include "<asset>.inc"`
(game/sreset.c, game/hsfman.c, game/font.c, game/fault.c, REL/bootDll/main.c). In the
decomp those headers are NOT source: decomp-toolkit writes them into
build/GMPE01_01/include/ by slicing the retail DOL/RELs at addresses listed in the
decomp's config/GMPE01_01/config.yml. Neither that directory nor the config is in a
src/+include/ checkout of the decomp, so on a box without the decomp's full build the
recomp could not be rebuilt at all (2026-10-01: ~/gc_refs/marioparty4 is not on the
build box; ~/mp4decomp is a sparse src/+include/ checkout).

Every byte here comes from the user's own disc. Addresses come from
tools/gmpe01_full.map (the full GMPE01 symbol map already in this repo); the one REL
asset (nintendoData, bootDll) is located by the decode header it carries.

VERIFIED, not assumed: --verify-wasm <mp4_game.wasm> rebuilds that module's initial
linear memory from its active data segments and requires every generated asset to
occur in it byte-for-byte. Against the shipped gamecube/recomp/mp4_game.wasm
(md5 7040471c…) all 20 occur exactly once.

usage:
  python3 gamecube/recomp/gen_inc_assets.py OUT_DIR [--parts PREFIX | --iso FILE]
                                            [--map tools/gmpe01_full.map]
                                            [--verify-wasm gamecube/recomp/mp4_game.wasm]
"""
import argparse, gzip, os, re, struct, sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# DOL-resident assets, by symbol name (tools/gmpe01_full.map gives address + size).
# ENG build only (VERSION_ENG): sreset.c includes just the _en error screens.
DOL_ASSETS = [
    # src/game/sreset.c — DVD error screens (CPU-copied into the XFB)
    'coveropen_en', 'fatalerror_en', 'loading_en', 'nodisc_en', 'retryerror_en', 'wrongdisc_en',
    # src/game/hsfman.c — reflection / toon / highlight maps (sprite-anim containers -> GX textures)
    'refMapData0', 'refMapData1', 'refMapData2', 'refMapData3', 'refMapData4',
    'toonMapData', 'toonMapData2', 'hiliteData', 'hiliteData2', 'hiliteData3', 'hiliteData4',
    # src/game/font.c (extern'd by printfunc.c) — the I4 debug font texture
    'ank8x8_4b',
    # src/game/fault.c — the 1bpp crash-screen font
    'Ascii8x8_1bpp',
]
# bootDll.rel: nintendoData is the tail of section 5 (.data). It is located by its own
# header — u32 decoded size, u32 decode_type — which NintendoDataDecode reads first
# (src/REL/bootDll/main.c). Measured on GMPE01_01: section 5 is 12573 bytes, the asset
# starts at +0xA0 with size 0x438C0 / type 1 and runs to the end of the section (12413 B).
BOOT_REL = 'dll/bootDll.rel'
NINTENDO = dict(section=5, offset=0xA0, size_hdr=0x438C0, type_hdr=1)


class DiscReader:
    """Forward-only reader over the gzipped split parts (or a plain ISO)."""
    def __init__(self, parts):
        self.parts, self.i, self.pos = parts, 0, 0
        self.f = self._open(parts[0])

    @staticmethod
    def _open(p):
        return gzip.open(p, 'rb') if p.endswith('.gz') else open(p, 'rb')

    def read(self, n):
        out = bytearray()
        while n > 0:
            b = self.f.read(min(n, 1 << 22))
            if not b:
                self.i += 1
                if self.i >= len(self.parts):
                    break
                self.f = self._open(self.parts[self.i])
                continue
            out += b; n -= len(b); self.pos += len(b)
        return bytes(out)

    def seek_fwd(self, off):
        if off < self.pos:
            raise ValueError('backward seek %x < %x' % (off, self.pos))
        while self.pos < off:
            if not self.read(min(off - self.pos, 1 << 22)):
                raise EOFError(off)


def read_files(parts, names):
    """Return {path: bytes} for main.dol and the named FST paths, in one forward pass."""
    hdr = DiscReader(parts).read(0x440)
    gid, ver = hdr[:6].decode(), hdr[7]
    dol_off, fst_off, fst_size = struct.unpack('>III', hdr[0x420:0x42C])
    r = DiscReader(parts); r.seek_fwd(dol_off); dh = r.read(0x100)
    offs = struct.unpack('>18I', dh[0:72]); sizes = struct.unpack('>18I', dh[0x90:0xD8])
    dol_size = max(o + z for o, z in zip(offs, sizes))
    r = DiscReader(parts); r.seek_fwd(fst_off); F = r.read(fst_size)
    n = struct.unpack('>I', F[8:12])[0]; strtab = n * 12
    def nm(o):
        return F[strtab + o:F.index(b'\0', strtab + o)].decode()
    paths = {}
    def walk(i, end, prefix):
        while i < end:
            w0, a, b = struct.unpack('>III', F[i * 12:i * 12 + 12])
            name = nm(w0 & 0xFFFFFF)
            if w0 >> 24:
                walk(i + 1, b, prefix + name + '/'); i = b
            else:
                paths[prefix + name] = (a, b); i += 1
    walk(1, n, '')
    want = [(dol_off, dol_size, 'main.dol')]
    for p in names:
        if p not in paths:
            raise SystemExit('disc has no %s' % p)
        want.append(paths[p] + (p,))
    out, r = {}, DiscReader(parts)
    for a, b, p in sorted(want):
        r.seek_fwd(a); out[p] = r.read(b)
    return gid, ver, out


def dol_reader(dol):
    offs = struct.unpack('>18I', dol[0:72]); addrs = struct.unpack('>18I', dol[72:144])
    sizes = struct.unpack('>18I', dol[144:216])
    def rd(a, n):
        for o, ad, z in zip(offs, addrs, sizes):
            if z and ad <= a and a + n <= ad + z:
                return dol[o + a - ad:o + a - ad + n]
        raise SystemExit('address %08x+%x is not in any DOL section' % (a, n))
    return rd


def load_map(path):
    m = {}
    for line in open(path):
        p = line.split()
        if len(p) == 5 and re.fullmatch(r'[0-9a-f]{8}', p[0]):
            m.setdefault(p[4], (int(p[0], 16), int(p[1], 16)))
    return m


def rel_section(rel, k):
    nsec, secoff = struct.unpack('>II', rel[12:20])
    off, sz = struct.unpack('>II', rel[secoff + 8 * k:secoff + 8 * k + 8])
    return rel[off & ~3:(off & ~3) + sz]


def write_inc(out_dir, name, data):
    # Plain u8 array, non-static (printfunc.c externs ank8x8_4b), 32-byte aligned: several
    # of these are GX textures and the BP register carries the address >> 5.
    lines = []
    for i in range(0, len(data), 16):
        lines.append('    ' + ', '.join('0x%02X' % b for b in data[i:i + 16]) + ',')
    body = ('/* generated by gamecube/recomp/gen_inc_assets.py from the game disc — do not edit */\n'
            'unsigned char %s[%d] __attribute__((aligned(32))) = {\n%s\n};\n'
            % (name, len(data), '\n'.join(lines)))
    with open(os.path.join(out_dir, name + '.inc'), 'w') as f:
        f.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out_dir')
    ap.add_argument('--parts', default=os.path.join(REPO, 'gamecube/roms/MarioParty4.bin.part'))
    ap.add_argument('--iso')
    ap.add_argument('--map', default=os.path.join(REPO, 'tools/gmpe01_full.map'))
    ap.add_argument('--verify-wasm')
    a = ap.parse_args()
    if a.iso:
        parts = [a.iso]
    else:
        parts = [a.parts + s + '.gz' for s in ('aa', 'ab', 'ac', 'ad', 'ae', 'af')]
    gid, ver, files = read_files(parts, [BOOT_REL])
    if (gid, ver) != ('GMPE01', 1):
        raise SystemExit('expected GMPE01 rev 1 (the map is that revision), disc is %s rev %d' % (gid, ver))
    rd = dol_reader(files['main.dol'])
    sym = load_map(a.map)
    assets = []
    for n in DOL_ASSETS:
        addr, size = sym[n]
        assets.append((n, rd(addr, size)))
    sec = rel_section(files[BOOT_REL], NINTENDO['section'])
    nd = sec[NINTENDO['offset']:]
    got = struct.unpack('>II', nd[:8])
    if got != (NINTENDO['size_hdr'], NINTENDO['type_hdr']):
        raise SystemExit('bootDll nintendoData header is %r, expected %r' % (got, (NINTENDO['size_hdr'], NINTENDO['type_hdr'])))
    assets.append(('nintendoData', nd))
    os.makedirs(a.out_dir, exist_ok=True)
    for n, d in assets:
        write_inc(a.out_dir, n, d)
    print('[inc] %s rev %d: wrote %d assets (%d bytes) to %s'
          % (gid, ver, len(assets), sum(len(d) for _, d in assets), a.out_dir))
    if a.verify_wasm:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from wasm_memimage import memimage
        mem = memimage(a.verify_wasm)
        bad = 0
        for n, d in assets:
            p = mem.find(d)
            once = p >= 0 and mem.find(d, p + 1) < 0
            bad += not once
            print('  %-14s %6d B  %s' % (n, len(d), ('in wasm @%d' % p) if once else ('NOT FOUND' if p < 0 else 'AMBIGUOUS')))
        if bad:
            raise SystemExit('[inc] %d assets do not match %s' % (bad, a.verify_wasm))
        print('[inc] all %d assets occur byte-for-byte in %s' % (len(assets), a.verify_wasm))


if __name__ == '__main__':
    main()
