# WebGL2 fallback for devices with NO WebGPU (the Xbox case)

Why this exists: the owner runs `gamecube.html` in Edge on an Xbox Series X. Xbox Edge
exposes **no WebGPU**, so the page shows *"This device is missing WebGPU"* and holds Start
down. This folder tracks getting a picture on that device.

## Settled — do not re-derive

**1. Both fallback backends render this game correctly in NATIVE Dolphin.**
Oracle run 2026-09-05, per `gamecube/docs/ORACLES.md`'s mandatory first action, with
`-C Dolphin.Movie.DumpFrames=True` so the evidence is pixels:

| `GFXBackend` | frames (~10s, Mario Party 4) | picture |
|---|---|---|
| `OGL` | 389 | full 3D scene — characters, castle, terrain |
| `Software Renderer` | 126 | correct Hudson logo, just slow |

⇒ A black screen in our build is **our bug**, not an inherent limit, and not the visitor's
device. The old page text ("expect a flat green frame … This is a GPU/browser problem on
this machine") was measured on the PSO savestate and does not generalise; it was being read
as "the fallback cannot work". It can.

**2. The GL command ring used to be written ON TOP of the ppc-worker. Fixed.**
`build_ppc_worker.sh:77` puts the ppc-worker's static data + dlmalloc heap at
`GLOBAL_BASE = 0x08000000`; the 16 MB ring was written at exactly `0x08000000` in the
**shared** heap. It destroyed that worker's `EM_ASM` signature strings, so its next `EM_ASM`
read a stray byte as a type char:
`Aborted(Assertion failed: Invalid character 54("6") in readEmAsmArgs!)`.
dolphin_worker was immune (`GLOBAL_BASE = 0x10000000`), which is why ONLY the ppc-worker
died and why it read like a JIT bug. Ring moved to `0x03000000`, ctrl to `0x04100000`
(the gap between sab_layout.h's reservations, up to `0x026A0000`, and the ppc-worker).
Matched pair, same binary: `?hwRender=1` aborts **3 → 0**.
⚠ The tell predicted in `worker_funcs.js` ("[fix1] gl-error / wrong render") NEVER appeared —
`glErrors` was 0 on every run. Do not wait for that symptom.

**3. The ring transport WORKS. The producer stops producing.**
Measured with temporary counters on both sides (since removed):

```
producer  t=1s   emits=1039  wireWords=9725
producer  t=43s  emits=1053  wireWords=9786   HEAD=9786 TAIL=9786  viewByteOff=0x3000000
consumer  (end)              HEAD=9786 TAIL=9786  viewByteOff=0x3000000  ringCap=4194304
```

Both sides agree on offset, capacity and head/tail; `TAIL` advanced 0 → 9786, so the ring
**was drained**. `[mainprof] drained=0/0` is a per-sample-window figure and reads zero only
because all traffic happened during init — it is NOT evidence of a broken drain, and it
misled us for a while.

⇒ The real symptom: **~1039 GL commands in the first second, then 14 more in 43 seconds.**
The OGL backend initialises and then stops drawing while the guest keeps executing (guest
frame counter passed 2800 in the same run).

## Narrowed further: the backend INITIALISES fine and then never draws — because no
## vertices are ever loaded

Per-opcode histogram taken at the single `emit()` site in `gl-record.js` (temporary, since
removed — no rebuild needed, that file is `importScripts`'d at runtime). Identical at t=2s
and t=45s apart from two `bindVertexArray`:

```
createQuery:512  bindAttribLocation:180  bindVertexArray:27->29  useProgram:24
attachShader:24  activeTexture:19  bindTexture:19  createShader:19
```

So the OGL backend **does** initialise — it creates 19 shaders, attaches 24, binds attribute
locations, allocates 512 queries — and then issues **zero `drawElements` / `drawArrays`, ever.**
It is not stuck in init and it is not erroring; it simply never draws.

The chain, with the measurement for each link:

| link | evidence | verdict |
|---|---|---|
| guest executes | audio 0.75–1.0x, guest frames > 2800 | OK |
| CP/FIFO fed, opcodes decoded | `decoderDraws` (`OpcodeDecoding.cpp:169-171`, backend-agnostic) 194 → 1,006,100 | OK |
| **vertices loaded** | `[vtxcensus-jit] loaders=0 verts=0`; the non-jit `[vtxcensus]` line **never appears** (it reports `loaders=3 verts=256→2788` on the WGPU arm) | **BROKEN** |
| vertex manager flushes | no draw opcodes in the ring, ever | dead downstream of the above |
| GL overlay installed | `GLctxIsRecorder=true` at t=1s AND t=45s, `nMakes=1` | OK |
| ring transport | HEAD=TAIL=9786 on both sides, same offset/capacity | OK |

⇒ **A million decoded draws produce no loaded vertices.** That is the single remaining gap,
and it sits in `VertexLoaderManager` / the `OpcodeDecoding` → vertex-loader hand-off on the
OGL path, not in GL, not in the bridge, not in the ring.

⚠ Two hypotheses that were TESTED AND KILLED, so they are not retried:
- *"ContextReset undoes the recording overlay."* No — the overlay marker is still true 45s
  after ContextReset, and `emits` kept rising past it. (Also killable from the counters
  alone: had the overlay been swapped out, `emits` would have frozen at 1039.)
- *"The ring/consumer is broken."* No — see the transport row above.

⚠ A counter that looked like the root cause and is VOID: `gpuSubmits` @ `0x026B352C` reads 0
on the OGL arm, which reads as "draws decoded but never submitted". That address is written
**only** by `VideoBackends/WGPU/WGPUVertexManager.cpp:543-544` — it is WGPU-only
instrumentation and does not exist on the OGL path. `decoderDraws` @ `0x026B289C` IS
backend-agnostic and is the one to quote. (Same class as CLAUDE.md gate #10's `[mips]`
lesson: confirm what a value MEANS before building a theory on it.)

## Native reference for the same stage

Native OGL on the same ISO logs **352 shader lines** and repeatedly links real programs
(`VideoBackends/OGL/ProgramShaderCache.cpp:451 "Program linked with warnings"`). Our OGL arm
logs **zero** shader/pipeline activity after init. Both facts are consistent with the table
above: ours builds its initial programs and then never reaches the per-draw path at all.

## The open question

**Why does the OGL path load no vertices when the decoder is decoding a million draws?**

⚠ `Video.cpp:140-146` is worth reading first and is a candidate, not a conclusion: the WGPU
branch does `Config::SetBase(MAIN_GFX_BACKEND, "WGPU")` **and** forces
`ShaderCompilationMode::SynchronousUberShaders`; the GL branch calls `SetHWRender` and
returns having set **neither**. `GFXBackend = OGL` does reach Dolphin.ini (confirmed in the
worker log), so the backend selection itself is probably fine — but the shader-mode
asymmetry is unexamined, and an unready-pipeline state is one way a backend decodes without
drawing.

Next instrument, per the auditor and requiring the canonical 3-step rebuild: mirror
`WGPUVertexManager.cpp:543-544`'s counter into `OGL/OGLVertexManager.cpp` at its draw
submission (a distinct SAB address), and read it beside `decoderDraws` from one run.

**Older framing, superseded by the table above:**

The one ordering fact worth chasing first:

```
[fix1] recording GLctx OVERLAY on handle=294264816 ring@0x3000000 ... ctrl=true
[worker] SET_HW_RENDER captured (ctx_type=4, ver=3.0)
[worker] video_cb data=-1 w=640 h=528 pitch=0 n=1     <- FIRST and ONLY, n=1
[worker] video backend ContextReset done               <- AFTER the only present
```

`ContextReset` lands *after* the single `video_cb`. Two hypotheses, not yet separated:

1. `ContextReset` / `SET_HW_RENDER` re-resolves `GLctx` and silently undoes the overlay
   installed three lines earlier — `worker_funcs.js:79-81` sets `cur.GLctx = recGL`, and any
   later `makeContextCurrent` / context re-init on that thread restores the real 1x1
   throwaway context (`[mtgl] dolphin_worker throwaway canvas created (never presented)`).
   Fix would live in `worker_funcs.js` (re-assert the overlay after ContextReset) — no
   backend rebuild.
2. The backend genuinely stops drawing for an unrelated reason.

To separate them: re-assert / re-read `GL.currentContext.GLctx` immediately AFTER
`ContextReset` and check whether it is still the recording proxy.

## Also open, and independent of rendering

- **Nothing auto-selects this path.** `gamecube.html:2564` derives `__gcSoftwareRender`, and
  a no-WebGPU device still takes the *software* branch — an Xbox visitor never reaches
  `?hwRender=1` without typing a query parameter. Even once it renders, that has to change.
- `gcRenderVerdict` (`:2325-2347`) never consults `hwRender`, so Start stays down regardless.
  Do not lift that until a frame is proven; starting a black screen is worse than blocking.
- `_firstFrame` cannot fire on this path by construction — it is set only by the WGPU
  sab-present path (`:6225`) and the legacy `postMessage 'render'` handler (`:6535`, dead
  since PM28). So `gcPresentHealthNow`, the present watchdog and `__gcGpu.present` all
  misreport here.

## How to reproduce

```bash
npm run web
# Start is disabled without WebGPU, so a probe must force it before clicking, or it
# measures a page that never ran — that mistake produced SET_HW_RENDER=0 on BOTH arms.
node tools/browser_leak_guard.js reap && uptime
```
Chrome flags: `--disable-features=WebGPUService,Dawn` (proven to null `requestAdapter()`;
`--disable-features=WebGPU` and `--disable-blink-features=WebGPU` are no-ops).
Pixels: sample a **composited screenshot**, not main-thread `drawImage` — on this path the
canvas is transferred to the worker, so a main-thread read of the placeholder is not
evidence. That artifact produced a false "0% non-black" reading.
