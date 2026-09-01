#!/usr/bin/env python3
"""Convert a GameCube-WASM port savestate (.gcs.gz) into a standard Dolphin
savestate file that a NATIVE Dolphin built from THIS repo's dolphin-src can load
(`dolphin-emu-nogui -s <out.sav> -e <game.iso>`).

Why this exists
---------------
The port's Save/Export writes the RAW `State::DoState` buffer (no header), gzipped
as `.gcs.gz`. Native Dolphin's loader expects the standard on-disk format:
  StateHeaderLegacy(24) + StateHeaderVersion(8) + version_string + ExtendedBaseHeader(16) + payload
(see gamecube/dolphin-src/Source/Core/Core/State.cpp). This tool wraps the raw
buffer in that header using the *Uncompressed* payload type (compression_type=0),
so no LZ4 dependency is needed. The version cookie is COOKIE_BASE(0xBAADBABE)+STATE_VERSION.

VERIFIED 2026-08-19: a native build of dolphin-src accepts the produced file
(game-id / version / payload all validate and DoState deserializes). NOTE: the
native binary then SIGSEGVs running the restored state because the port's
dual-core layer hardcodes wasm SAB absolute addresses (e.g. ProcessorInterface.cpp
reads 0x0268002C) across ~13 HW/video files that are not gated on __EMSCRIPTEN__.
A native oracle that RUNS the state additionally requires gating those.

Usage:
  python3 gamecube/tools/gcs_to_dolphin_sav.py <in.gcs.gz> <out.sav> [GAME_ID]
    GAME_ID defaults to GMPE01 (Mario Party 4, USA).
"""
import struct, gzip, sys

STATE_VERSION = 177          # gamecube/dolphin-src/Source/Core/Core/State.cpp:98
COOKIE_BASE = 0xBAADBABE     # State.cpp:106
EXTENDED_HEADER_VERSION = 1  # State.cpp:101
COMPRESSION_UNCOMPRESSED = 0 # State.h enum CompressionType


def convert(in_path: str, out_path: str, game_id: str = "GMPE01") -> None:
    raw = gzip.open(in_path, "rb").read() if in_path.endswith(".gz") else open(in_path, "rb").read()
    gid = game_id.encode("ascii")
    if len(gid) != 6:
        raise SystemExit(f"GAME_ID must be 6 chars, got {game_id!r}")
    # StateHeaderLegacy: char game_id[6]; char reserved1[2]; u32 lzo_size=0; char reserved2[4]; double time
    legacy = struct.pack("<6s2sI4sd", gid, b"\x00\x00", 0, b"\x00\x00\x00\x00", 0.0)
    # StateHeaderVersion: u32 version_cookie; u32 version_string_length (0 = empty; loader doesn't require a match)
    version = struct.pack("<II", (COOKIE_BASE + STATE_VERSION) & 0xFFFFFFFF, 0)
    # StateExtendedBaseHeader: u16 header_version; u16 compression_type; u32 payload_offset; u64 uncompressed_size
    ext = struct.pack("<HHIQ", EXTENDED_HEADER_VERSION, COMPRESSION_UNCOMPRESSED, 0, len(raw))
    with open(out_path, "wb") as f:
        f.write(legacy + version + ext + raw)
    print(f"wrote {out_path}: header 48 + payload {len(raw)} = {48 + len(raw)} bytes (game_id={game_id})")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "GMPE01")
