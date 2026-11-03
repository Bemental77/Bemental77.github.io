# Source offer for `gba/mgba/dist/mgba_core.wasm`

`mgba_core.wasm` and `mgba_core.js` in `dist/` are an **Executable Form** of [mGBA](https://mgba.io/) (Mozilla Public License 2.0, full text in
[`LICENSE-MPL-2.0`](LICENSE-MPL-2.0)), compiled to WebAssembly from the source below. MPL-2.0 section 3.2(a) asks that recipients be told how
to obtain that source; this file is that notice, and it is served next to the binary.

## The source

| | |
|---|---|
| Repository | https://github.com/Spuds0588/mgba-splitscreen (contains a modified copy of https://github.com/mgba-emu/mgba) |
| Pinned commit | `f1d5975d77285f77affbfe64b7050ebd5c4b6a77` ("Phones as controllers: ?pad=1 invites join with input-only semantics") |
| Fetch | `git init && git remote add origin https://github.com/Spuds0588/mgba-splitscreen.git && git fetch --depth 1 origin f1d5975d77285f77affbfe64b7050ebd5c4b6a77 && git checkout --detach FETCH_HEAD` |
| Bridge compiled into the module | `gba/mgba/bridge/` in the site repository (`bemental_gba.c` = the `bgb_*` multi-core API, `legacy_mgs.c` = the fork's `mgs_*` ABI on top of it). It is derived from the fork's `mgba-splitscreen/web/mgba_splitscreen_web.c` and from `src/platform/libretro-splitscreen/instances.c` (the stepping loop), both at the pinned commit, and is distributed under the same terms (MPL-2.0); each bridge file carries the MPL-2.0 Source Code Form notice in its header. |

The build never uses a prebuilt third-party binary: the wasm is compiled from this source by `gba/mgba/build.sh`, which clones the
repository to `~/mgba-src`, refuses to continue unless `HEAD` equals the pinned commit, applies the patches below, and writes a
`dist/mgba_core.buildinfo.json` recording the commit, the patch digest, the toolchain versions and the md5 of both output files.

## Modifications made by this site

Patches live in `gba/mgba/patches/` in the site repository, https://github.com/Bemental77/Bemental77.github.io, and are applied unchanged by `build.sh`:

| Patch | What it changes |
|---|---|
| `0001-cmake-honor-use-pthreads-off.patch` | `CMakeLists.txt`: `set(USE_PTHREADS ON)` under `elseif(UNIX)` becomes conditional on the option not being defined, so `-DUSE_PTHREADS=OFF` is honored (the unconditional `set()` overrode the command line, and the fork's "single-threaded" build still compiled with `-pthread`). |
| `0002-lockstep-no-fs-assist-link-witnesses.patch` | `src/gba/sio/lockstep.c` and `include/mgba/internal/gba/sio/lockstep.h`: removes the fork's Four Swords link-handshake assist and deadlock kick entirely (the title-gated code that pokes a game's private RAM; about 700 lines), its three public setters and its coordinator fields; demotes the periodic `SIO diag` log from WARN to DEBUG; adds monotonic link witness counters to the coordinator (`witnessTransfers`, `witnessMultiOk`, `witnessMultiNoData`, `witnessRecovers`, `witnessMultiLast[4]`). The ack barrier, no-sleep-after-ack and `GBASIOLockstepCoordinatorRecover` hunks are kept as they are. |
| `0003-gba-remove-irq-trace-add-sio-irq-witness.patch` | `src/gba/gba.c`, `include/mgba/internal/gba/gba.h`: removes the fork's TEMP per-IRQ/halt trace (it took the link mutex and did a table lookup on every HALT and IRQ trigger of a linked core, and indexed 4-entry static arrays with a device id); adds `witnessSioIrqs`, a count of serial IRQs raised. |
| `0004-gpio-rtc-pinned-utc-offset.patch` | `src/gba/cart/gpio.c`: two globals (`bementalRtcPinned`, `bementalRtcUtcOffsetSec`); when pinned, the cartridge RTC reads the calendar of `time + offset` as UTC instead of calling `localtime_r` (the host time zone). The default is stock behaviour. |

Nothing else in the fork's source tree is modified. The remaining differences from the fork's own `web/build.sh` are build options, all in `build.sh`
(single-thread link flags, `-DSKIP_GIT=ON`, explicit OFF for every optional dependency, path-prefix maps, the extracted layout defines).

## Other code inside the binary

- mGBA itself: MPL-2.0 (as above). The fork's repository contains a single license file, the MPL-2.0 text at its root; `mgba_splitscreen_web.c` carries no per-file notice, so it is treated as covered by it (not independently verified with the fork's author).
- `src/third-party/inih/ini.c` (Ben Hoyt, New BSD license): the only third-party source file compiled into `libmgba.a` in this configuration (read from the build log; zlib, libpng, lzma, sqlite3 and discord-rpc are present in the tree but switched off).
- The Emscripten runtime and C library (musl, dlmalloc) are linked in by the Emscripten 6.0.2 toolchain under their own permissive licenses.

This is a statement of what the build does, not legal advice.
