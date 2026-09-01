#!/usr/bin/env python3
"""Convert a native Dolphin .s01 savestate into a WASM-loadable raw DoState blob.

The native .s01 file = StateHeaderLegacy(24) + StateHeaderVersion(8) +
version_string(N) + StateExtendedBaseHeader(16) + [u32 compressed_len][LZ4 block]...
(Core/State.cpp WriteHeadersToFile + CompressBufferToFile). The libretro WASM build's
retro_serialize/unserialize (DolphinLibretro/Main.cpp) operate on the RAW DoState
buffer with no header and no compression. Both are STATE_VERSION 177, so the DoState
payload is byte-compatible — strip the header and LZ4-decompress to recover the exact
buffer retro_unserialize wants.

Output is gzip-compressed to match gamecube.html's IndexedDB format / the probe's
PROBE_LOAD_STATE hook (which gunzips before posting {cmd:'loadState'}).

Usage: python3 s01_to_raw_state.py <in.s01> <out.gcs.gz>
"""
import sys, struct, gzip
import lz4.block

COOKIE_BASE = 0xBAADBABE
LZ4_MAX_INPUT_SIZE = 0x7E000000

def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: s01_to_raw_state.py <in.s01> <out.gcs.gz>\n"); sys.exit(2)
    data = open(sys.argv[1], 'rb').read()

    # StateHeaderLegacy (24) — verify lzo_size==0 (new-format, not legacy LZO)
    lzo_size = struct.unpack_from('<I', data, 8)[0]
    if lzo_size != 0:
        sys.stderr.write(f"legacy LZO state (lzo_size={lzo_size}) — unsupported\n"); sys.exit(1)
    # StateHeaderVersion (8) @24
    version_cookie, vsl = struct.unpack_from('<II', data, 24)
    version = version_cookie - COOKIE_BASE
    ver_str = data[32:32+vsl].decode('latin-1', 'replace')
    print(f"[conv] state_version={version}  writer='{ver_str}'  vsl={vsl}")
    # StateExtendedBaseHeader (16) right after the version string
    off = 24 + 8 + vsl
    hdr_ver, comp_type = struct.unpack_from('<HH', data, off)
    payload_offset, uncompressed_size = struct.unpack_from('<IQ', data, off + 4)
    off += 16
    print(f"[conv] ext_header_ver={hdr_ver} compression={comp_type} (1=LZ4) "
          f"uncompressed_size={uncompressed_size} header_len={off}")
    if comp_type != 1:
        sys.stderr.write(f"compression_type={comp_type} not LZ4 — unsupported\n"); sys.exit(1)

    # Payload: one or more [u32 compressed_len][LZ4 block] chunks. Each chunk
    # decompresses to min(LZ4_MAX_INPUT_SIZE, remaining) bytes.
    out = bytearray()
    while len(out) < uncompressed_size:
        (clen,) = struct.unpack_from('<i', data, off); off += 4
        block = data[off:off + clen]; off += clen
        want = min(LZ4_MAX_INPUT_SIZE, uncompressed_size - len(out))
        dec = lz4.block.decompress(block, uncompressed_size=want)
        out += dec
        print(f"[conv] chunk: clen={clen} -> {len(dec)} bytes ({len(out)}/{uncompressed_size})")

    if len(out) != uncompressed_size:
        sys.stderr.write(f"size mismatch: got {len(out)} want {uncompressed_size}\n"); sys.exit(1)
    print(f"[conv] raw DoState = {len(out)} bytes; trailing file bytes = {len(data) - off}")

    with gzip.open(sys.argv[2], 'wb', compresslevel=6) as g:
        g.write(out)
    import os
    print(f"[conv] wrote {sys.argv[2]} ({os.path.getsize(sys.argv[2])} bytes gzipped)")

if __name__ == '__main__':
    main()
