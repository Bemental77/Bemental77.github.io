# The Dreamcast core CANNOT BE RELINKED — the committed source does not build a working binary

## The finding

Rebuilding + relinking the Flycast core from the CURRENT committed source produces
a worker that dies at boot, immediately after the disc loads:

```
[flycast-worker] load_disc: retro_load_game returned true
[pageerror] CppException
[page] emulator worker error: Uncaught [object ErrorEvent] @ .../flycast_worker_emcc.js:1144
```

The SHIPPED worker is fine and boots PSO at guest=1.000x with a full picture. It
is fine because it PREDATES the core changes now in the tree:

```
dreamcast/flycast_libretro/flycast_worker_emcc.wasm   built Aug 29
dreamcast/flycast-src/build-wasm/libflycast_libretro.a  built Sep 4 from COMMITTED source
```

## It is NOT the change that exposed it

Found while arming Maple port 1 for online co-op. Controlled A/B, one variable,
same build flow, same probe:

| arm | boots? |
|---|---|
| with `retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD)` | NO — CppException |
| identical build, that ONE line commented out | **NO — same CppException** |

So the port-1 line is exonerated and the relink itself is the fault. Anything that
requires a core rebuild is blocked behind this, which is a much bigger problem
than the feature that ran into it.

## A second, separate breakage found on the way — FIXED

The link failed outright before any of the above:

```
wasm-ld: error: symbol exported via --export not found: flycast_set_fog
wasm-ld: error: symbol exported via --export not found: flycast_set_modvol
```

`flycast_worker_link.sh:81-82` exports both, `flycast_worker.js:1069,1079` calls
both behind `?nofog=1` / `?nomodvol=1`, and both are present in the shipped wasm —
but NO SOURCE FILE IN THE TREE DEFINED THEM. They were lost at some point and the
loss was invisible because nobody relinked. Re-implemented in
`EmscriptenWorker.cpp` against the options they were written for
(`core/cfg/option.h:441` ModifierVolumes, `:455` Fog) rather than deleted from the
export list, which would have quietly dropped a render-bisect tool shipped code
still calls. After this the link SUCCEEDS — it is the resulting binary that fails.

## State of the tree

`EmscriptenWorker.cpp` carries the port-1 line and the restored exports. ⚠ THE
SHIPPED WASM DOES NOT CONTAIN THEM — it is the working Aug 29 binary, deliberately
restored from git after the A/B, because shipping a core that dies at boot is far
worse than shipping one without player 2. Source and binary therefore disagree,
which is exactly the stale-build trap CLAUDE.md warns about; it is recorded here
rather than left to be rediscovered.

## What online co-op is missing because of this

Everything except the emulator's second controller works and is tested: pairing,
the host streaming its canvas + audio, the guest's pad reaching the worker
(measured: port 1 = 0x81 lx=+32766 in the byte array handed to the core), and the
save handoff. But `input_state_cb` is only called for a port that has a Maple
device, and per the comment at `EmscriptenWorker.cpp:1258` every port stays
MDT_None unless something plugs one in. So the guest's bytes arrive and nothing
polls them.

## THERE IS NO NO-RELINK WORKAROUND — all three candidate paths checked and closed

Worth stating because it is the obvious thing to try next and all of it is a dead
end. Arming Maple port 1 REQUIRES a working relink; nothing at runtime can do it.

| candidate | why it is closed |
|---|---|
| libretro core options | `EmscriptenWorker.cpp:394-395` answers `RETRO_ENVIRONMENT_GET_VARIABLE` with a bare `return false`, so every option falls back to its default |
| a config file in MEMFS | there is no `loadAll` / `cfgOpen` / `LoadSettings` call in `shell/libretro/libretro.cpp`, so no cfg is read; `Option::load()` (`core/cfg/option.h:119`) is never reached |
| writing the pad buffer harder | irrelevant — `input_state_cb` is only CALLED for a port that has a Maple device, and `option.cpp:200-203` leaves `device2` at `MDT_None` |

That leaves `config::MapleMainDevices[1].override(...)` / `retro_set_controller_port_device(1, ...)` in C++, which is compiled in. Hence the relink.

## Next

1. Bisect the core commits between the Aug 29 wasm and the current tree to find
   what broke the build. `git log --oneline -- dreamcast/flycast-src` is the range.
2. The exception is thrown after `retro_load_game` succeeds, so the crash is in
   early run/render setup rather than disc handling. A DIAG link (`FLYCAST_DIAG=1`)
   would name it — the RELEASE flavor swallows the C++ exception into a bare
   `CppException`.
3. Only after the core builds again does the port-1 line become testable.
