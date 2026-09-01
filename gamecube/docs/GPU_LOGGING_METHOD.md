# GPU_LOGGING_METHOD — two-sided native-vs-WebGPU GPU diffing (order 18a)

Permanent method for diffing the WebGPU port's GPU output against native Dolphin, **per-draw and per-texture**,
without a debugger and (on the port side) without rebuilds. Use this whenever a WGPU render diverges from native.

The governing principle: **diff STATE at matching DRAWS, not pixels at matching wall-clock.** The port savestate
and the native dff can be at different animation frames; comparing per-draw register/uniform/texture state is
frame-independent, so an anim-frame mismatch never confounds the diff.

---

## Port side — Chrome DevTools console on `gamecube.html` (NO rebuilds)

Serve with `npm run web` → `http://localhost:8080/gamecube.html`; open DevTools console. Everything below is
pasted into the console (or injected via puppeteer `page.evaluate` in `gamecube/tools/dolphin_render_probe.js`).

1. **Free error stream first.** Hook `device.onuncapturederror` (or `device.addEventListener('uncapturederror', …)`)
   before anything else — surfaces every WebGPU validation error the wasm swallows.
2. **Monkey-patch the device/queue/encoder prototypes** from the console:
   - `GPUDevice.prototype.createRenderPipeline` → log every blend/depth/color-target descriptor.
   - `GPURenderPassEncoder.prototype.setPipeline` / `setBindGroup` / `draw`(`Indexed`) → the per-draw call sequence.
   - `GPUQueue.prototype.writeBuffer` → the uniforms on the wire (VS/PS constants: matrices + TEV konst/registers).
3. **THE DECISIVE READBACK:** `copyTextureToBuffer` a suspect texture into a `MAP_READ|COPY_DST` buffer, then
   `mapAsync` + `getMappedRange` and dump the actual RGBA bytes from the console. This reads what is truly resident
   in a GPU texture (EFB copies, decoded game textures) — the ground truth for "washed or correct".
4. **Escalations:** relaunch Chrome with `--enable-dawn-features=dump_shaders` for every pipeline's generated WGSL;
   or use the **WebGPU Inspector** extension for full frame captures (all resources/commands).
5. **Alongside:** the proven SAB reads for guest RAM/registers — `A = new Uint32Array(window.sharedMemory.buffer)`,
   MEM1 base at `A[0x02500020>>2]`, guest phys `X` → SAB byte offset `m1+X` (big-endian). Reserved scratch cells
   `0x026Bxxxx`. (Device-thread `EM_ASM` 'print' does NOT relay — telemetry must go through SAB cells.)

Note: identifying WHICH GPU texture object is a given guest cache entry from JS is the one gap — hook `createTexture`
and match by dimensions/usage/draw-context, or tag the handle from C++ into a SAB cell.

## Native side — Dolphin (headless dff replay is the unlock)

`dolphin-emu-nogui` **auto-plays + loops a .dff** headless (no manual Play, no GDB conflict). Combine with dumps:

1. **GFX.ini / -C flags:** `DumpTextures` (decoded game textures → `Dump/Textures/<GameID>/`), `DumpEFBTarget`
   (every EFB→RAM copy as PNG → `Dump/Textures/efb_*`), `DumpXFBTarget` (final frame), `DumpFramesAsImages`
   (composited frames → `Dump/Frames/`). Full scriptable golden dumps of everything. Recipe:
   ```
   ~/gc_refs/dolphin-upstream/build-oracle/Binaries/dolphin-emu-nogui -p macos -v OGL -u /tmp/gc-golden-ogl \
     -C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=1 \
     -C Movie.DumpFrames=True -C Movie.DumpFramesSilent=True -C Graphics.Settings.DumpFramesAsImages=True \
     -C Graphics.Settings.DumpXFBTarget=True -C Graphics.Settings.DumpEFBTarget=True -C Graphics.Settings.DumpTextures=True \
     -e gamecube/roms/<scene>.dff
   # let loop ~6s → pkill -9 -f dolphin-emu-nogui
   ```
2. **Log window** with Video/CP categories at **Debug** level for the command/register trace.
3. **FifoPlayer → Analyze tab** (GUI): per-draw BP/CP/XF register state for EVERY draw in the recording, no
   debugger needed — **the per-draw golden**. (Headless equivalent = the scratchpad `dff_*` FIFO decoders, which
   already extract per-draw texmap/texgen/TEV/blend/UV/matrix from a .dff.)
4. **Frame Advance** for frame-exact captures; Xcode Metal frame capture only if ever needed.

---

## Applying it to the MP4 card wash (worked example / current front)

Evidence: the portrait texture (`0x9674e0`, CI8) decodes IDENTICALLY on both sides; only the card **frame** washes
white. The frame is the **EFB-copy texture `0x792cc0`**. So the first diff is that texture's content:

- **native** `DumpEFBTarget` PNG of `0x792cc0`  **vs**  **port** console/`copyTextureToBuffer` readback of the same
  cache entry (`cache_entry->addr == 0x792cc0`).
- **Washed in the port** ⇒ the EFB-COPY WRITE path is wrong. Diff it vs upstream for the classic trio:
  **gamma double-apply, RGB565 expansion, clear-color leak.** (WGPU EFB→texture path: `WGPUTextureCache.h`,
  `WGPUGfx` BlitToTexture / the EFB-copy encoder.)
- **Correct in the port** ⇒ the wash is at SAMPLE time. Then the **TEV konst/register** comparison (native Analyze
  tab / dff decode  vs  the port's `writeBuffer` PS-constants log) names the divergent constant.

Parallel lane (do not merge): the **geometry-collapse / fan-spread** defect (the A3 fixture from order 17d) is a
SEPARATE defect from the wash until proven otherwise; both now have named, tool-backed paths to closure.
