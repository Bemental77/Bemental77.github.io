# WGPU frame capture on a software GPU (scratch harness)

Headless Chromium here only has SwiftShader WebGPU. SwiftShader compiles the ubershader lazily per
draw state (~10-17 s per state, measured with a single fullscreen ubershader draw), so the normal
present path backs up for many minutes and the readback map callbacks look like they never fire.
With draws gated off, the same page publishes ~60 readbacks/s, so the GPU queue is the bottleneck.

- `gcgate.js`: injected into the worker shim of an overlay tree (`/tmp/gc-root`, first line of
  `gamecube/dolphin_libretro/dolphin_worker.js`: `try { importScripts('/gcgate.js'); } catch (e) {}`).
  It turns every render-pass draw into a no-op unless the harness opens the gate for a chosen
  `recompFrame` (`m.gate = true`). Copies, clears and queue writes still run. When the gate closes it dumps
  every color attachment used in the window, plus the EFB depth snapshotted right before each
  EFB->XFB copy, and prints a per-draw pipeline/viewport trace. `CFG` knobs: `depthAlways`,
  `cullNone`, `blendOff`, `writeAll`, `noDiscard` (JS-level A/B, no rebuild), and `udump`
  (per-draw TEV/texgen/konst/tex-matrix decode from the uniform ring, plus the bound texture
  sizes), `dumpTex:'WxH'` / `dumpTag:'<tex-size prefix>'` (dump bound textures, e.g. a model's
  reflection map). It also answers `{cmd:'gcgateRam', addrs}` with guest-RAM bytes read through
  the worker's `Module._dolphin_get_ram_addr()`; `gcsnap.mjs`'s `ram:<name>` plan step uses it.
- `gcsnap.mjs`: boots MP4 (recomp path) in the overlay, drives keys, and runs `GATE_AT`/`GATE_K`
  plus a `settle` step that saves the dumps as PNGs to `/tmp/gcsnap`.
- `snaprun.sh`: lock + md5 guard around one run. `msab.sh`: mode-select capture with a CFG.

Software-renderer reference, same harness: `QUERY='?wgpu=0&hwRender=0'` (2D canvas snap).
Scratch only; nothing here ships.
