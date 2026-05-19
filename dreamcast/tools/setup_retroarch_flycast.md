# Setting up RetroArch + our native flycast core (macOS)

This is the desktop-host wrapper for the libretro build produced by
`dreamcast/tools/build_flycast_libretro.sh`. The point of running our
own libretro core under RetroArch (instead of stock Flycast.app) is that
this `.dylib` runs the IDENTICAL JIT decoder / SHIL / bridge code path
as our WASM build — just hosted on a native libretro frontend instead of
an Emscripten worker. That makes it the closest possible oracle for
A/B'ing decoder / bridge / scheduler behavior between native and WASM.

## 1. Install RetroArch

```
brew install --cask retroarch
```

(or download the macOS `.dmg` from <https://www.retroarch.com/>.)

RetroArch on macOS puts user config under
`~/Library/Application Support/RetroArch/`. The important subdirectories
are:

- `cores/`     — `.dylib` cores live here
- `system/`    — Dreamcast BIOS (`dc_boot.bin`, `dc_flash.bin`) live here
- `content/`   — convenient place to drop ROMs (any path works)
- `logs/`      — RetroArch logs land here when logging is enabled

## 2. Build our native libretro core

```
dreamcast/tools/build_flycast_libretro.sh --enable-log
```

Output:

```
dreamcast/flycast-src/build-libretro-native/libflycast_libretro.dylib
```

The `--enable-log` flag is what lets the `DYNAREC` log channel print at
`LDEBUG`/`LINFO`; without it the only JIT-side surface area is `NOTICE`
and `WARN` messages.

## 3. Install the core into RetroArch

Copy the dylib into RetroArch's cores directory and (optionally) sit it
beside the stock flycast core so you can A/B from the UI:

```
cp dreamcast/flycast-src/build-libretro-native/libflycast_libretro.dylib \
   "$HOME/Library/Application Support/RetroArch/cores/flycast_dev_libretro.dylib"
```

We rename to `flycast_dev_libretro.dylib` on purpose — RetroArch keys
core metadata off the filename. Naming it differently from the stock
`flycast_libretro.dylib` keeps both installable side-by-side.

## 4. Install Dreamcast BIOS

Drop the BIOS files into RetroArch's `system/dc/` directory:

```
$HOME/Library/Application Support/RetroArch/system/dc/dc_boot.bin
$HOME/Library/Application Support/RetroArch/system/dc/dc_flash.bin
```

(Same BIOS the WASM bridge consumes — see `dreamcast/dc_boot.bin` if you
already have a copy in-repo.)

## 5. Point it at PSO

The bringup target is **Phantasy Star Online Ver.2** (US release).
RetroArch accepts `.cue` / `.gdi` / `.chd`. Easiest path:

1. Place `PSOv2.cue` + tracks (or `PSOv2.chd`) anywhere — e.g.
   `~/Library/Application Support/RetroArch/content/dreamcast/`.
2. RetroArch UI: **Load Content → flycast_dev → pick the cue/chd**.
3. Or CLI:
   ```
   "/Applications/RetroArch.app/Contents/MacOS/RetroArch" \
     -L "$HOME/Library/Application Support/RetroArch/cores/flycast_dev_libretro.dylib" \
     "/path/to/PSOv2.cue"
   ```

## 6. Capture logs

RetroArch needs logging turned on explicitly:

- UI: **Settings → Logging → Logging Verbosity = Debug**,
  **Log to File = ON**.
- CLI: add `--verbose --log-file=/tmp/retroarch_flycast.log` to the
  invocation in step 5.

Log paths to inspect:

- `$HOME/Library/Application Support/RetroArch/logs/retroarch.log`
  — frontend lifecycle (core load, content load, environment cbs).
- The path from `--log-file=` if you used it.
- Anything our core prints via `INFO_LOG(DYNAREC, ...)` /
  `DEBUG_LOG(DYNAREC, ...)` lands in the same file (libretro's
  `RETRO_ENVIRONMENT_GET_LOG_INTERFACE` is what flycast wires up to
  forward `GenericLog` to RetroArch's log sink).

## 7. Diff against the WASM build

Once the core boots into PSO under RetroArch, the per-block DYNAREC
events in `retroarch.log` are diffable against the WASM probe log at
`/tmp/dc-probes/<name>.log` (produced by
`dreamcast/build_and_probe.sh --name <name>`). The
`dreamcast/tools/trace_diff_native_vs_wasm.sh` script does this for the
standalone build; the same diff approach works against the
RetroArch-hosted log — just point the script's `--name`/log-extraction
paths at `retroarch.log` instead of the headless-SDL output.

## Troubleshooting

- **"Failed to open libretro core"**: usually a quarantine flag — run
  `xattr -dr com.apple.quarantine "$HOME/Library/Application Support/RetroArch/cores/flycast_dev_libretro.dylib"`.
- **Black screen / no boot**: confirm BIOS in `system/dc/` and that the
  RetroArch frontend reports `[INFO] [Core]: Loaded core: flycast_dev`
  in the log. If the core loads but the SH4 never advances, that's the
  same boot-trajectory problem we'd diagnose in the WASM build —
  diff with `trace_diff_native_vs_wasm.sh`.
- **CMake configure failed for libretro build**: most common cause on a
  fresh mac is missing `cmake` (`brew install cmake`) or `zlib` headers
  (`brew install zlib` and re-run with
  `ZLIB_ROOT=$(brew --prefix zlib)`).
