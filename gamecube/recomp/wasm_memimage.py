#!/usr/bin/env python3
"""wasm_memimage.py — the initial linear memory of a wasm module, rebuilt from its ACTIVE
data segments (i32.const offsets). Binaryen's memory packing splits segments at zero runs,
so a static array is NOT contiguous in the .wasm file even though it is contiguous in
memory; search this image, never the raw file bytes.

usage: python3 wasm_memimage.py MODULE.wasm   (prints segment count and image size)
"""
import sys


def _leb(b, i, signed=False):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            break
    if signed and r & (1 << (s - 1)):
        r -= 1 << s
    return r, i


def segments(path):
    w = open(path, 'rb').read()
    i, segs = 8, []
    while i < len(w):
        sid = w[i]; i += 1
        size, i = _leb(w, i); end = i + size
        if sid == 11:  # data section
            n, j = _leb(w, i)
            for _ in range(n):
                flag, j = _leb(w, j)
                off = None
                if flag in (0, 2):
                    if flag == 2:
                        _, j = _leb(w, j)
                    if w[j] != 0x41:
                        raise ValueError('non-i32.const data offset')
                    off, j = _leb(w, j + 1, True)
                    if w[j] != 0x0B:
                        raise ValueError('unterminated offset expr')
                    j += 1
                ln, j = _leb(w, j)
                segs.append((off, w[j:j + ln])); j += ln
        i = end
    return segs


def memimage(path):
    segs = [(o, d) for o, d in segments(path) if o is not None]
    top = max(o + len(d) for o, d in segs)
    m = bytearray(top)
    for o, d in segs:
        m[o:o + len(d)] = d
    return bytes(m)


if __name__ == '__main__':
    s = segments(sys.argv[1])
    print('%d segments (%d active), image %d bytes'
          % (len(s), sum(o is not None for o, _ in s), len(memimage(sys.argv[1]))))
