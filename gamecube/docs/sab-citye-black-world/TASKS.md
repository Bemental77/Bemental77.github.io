# SAB City Escape — the black world behind a live HUD

Opened 2026-09-04 to close the open item left by
`gamecube/docs/guest-rate-witness/TASKS.md` §9:

> **Explain the SAB City Escape shortfall.** 0.465x clock and 118.9 MHz
> executed, but only 2.6 drawn/s and a black world behind a live HUD. This rig
> can say the three things disagree; it cannot say which is at fault.

Every number below is either a citation to a file:line, a grep against a probe
artifact produced in this session, or is explicitly hedged.

---

## 1. Goal

The `sab-ingame` / `sab-ingame-mips` cells of the guest-rate truth table
(`704083fd`) report three things that look mutually inconsistent: a guest clock
that says the CPU is working (0.4653x), a `drawn/s` that says almost nothing
reaches the screen (2.6/s → an implied native 5.91 fps on a 60 Hz title), and a
screenshot showing a correct HUD over a black world. Decide which signal is
misleading, or show that all three are correct and describe one failure.

---

## 2. What was run

All runs used the **same frozen binary** — `dolphin_worker_emcc.wasm` md5
`82bc8f8b6e1c6ac8db27ec0a5d49dadb`, hash-checked before and after and identical
every time — served from the `PROBE_ROOT=/tmp/gcw/snap` snapshot, the same
binary the truth table used (committed at `0b6b61e9`). Same savestate
(`gamecube/states/sab-citye-gameplay.gcs.gz`), same `ROM_IDX=1`, same
`PROBE_QUERY=bjit_mips=1`, `probe_lock`-serialized.

| run | when | steady `drawn/s` | world |
|---|---|---:|---|
| `sab-ingame` (reference) | 11:2x campaign | 2.6 | black |
| `sab-ingame-mips` (reference) | 11:2x campaign | 2.6 | black |
| `repro-ingame` (this session) | 15:2x | **23** (median, 27 windows) | black, then renders |

`/tmp/gcw/repro-ingame.log`, `/tmp/gcw/repro-ingame.rows.json`,
`/tmp/gcw/repro-t{42,70,140}.png`.

---

## 3. Findings

### F1. The guest clock is CORRECT, and SAB now has an independent witness

The truth table's W1/W2/W3 all descend from CoreTiming's `global_timer`, so
their agreement is not independent confirmation (the topic doc says so itself).
SAB had no W4 because `tools/gsne8p.map` has no `retraceCount`.

**SAB's own on-screen mission timer is a guest-executed witness**, and it is
readable from the screenshots the rig already takes. Its third field reads `80`
in `/tmp/gcw/repro-t140.png`, which is impossible for a 0–59 frame counter, so
the format is `MM:SS:CC` (centiseconds).

| span | in-game clock | wall | ⇒ guest | CoreTiming W1/W3 over the same span | agreement |
|---|---|---:|---:|---:|---:|
| t=42→70 | 12.44 → 24.37 s | 28 s | **0.426x** | 0.418x (6 windows) | **2.0%** |
| t=70→140 | 24.37 → 49.80 s | 70 s | 0.363x | 0.399x (14 windows) | 8.9% |

The second span straddles the t=142–167 transition described in F4, which is
why it is looser. The first span is clean and agrees to 2.0%.

**So `0.4653x` is not the misleading signal.** A counter that only advances when
the guest executes its own code agrees with it.

> **Follow-up available for the rig:** `VIGetRetraceCount` is a named symbol in
> `tools/gsne8p_xref.map:176` at `0x800f3710`, and it disassembles to exactly
> two instructions (`ROM_IDX=1 python3 gamecube/tools/gc_disasm.py 0x800f3710`):
> `lwz r3, -0x7500(r13)` / `blr`. SAB's `_SDA_BASE_` is `0x803B52C0` (from
> `lis r13,0x803b` / `ori r13,r13,0x52c0` at `0x80003264` in the DOL), so
> **SAB's `retraceCount` lives at `0x803ADDC0`**. Corroboration: the port's own
> thread dump in `/tmp/gcw/sab-ingame-mips.log` shows an OS thread queue at
> `0x803ADDC8`, 8 bytes later — which is how dolsdk's `vi.c` lays out
> `retraceCount` immediately before `retraceQueue`. Wiring that cell into
> `guest_rate_witness.mjs` would give SAB a real W4.

### F2. `drawn/s` is the misleading signal — but the counter is not lying

`drawn/s` is Δ PE `SetFinish`, and `sddDecodeNG` (the SETDRAWDONE **decode**
counter) equals `peFrames` exactly in every cell — 846/846 on
`sab-ingame-mips`, 3267/3267 on `sab-cold-mips`. The decoder really did see
that many finish tokens. Nothing is dropping them.

What is unstable is **how much geometry the guest packs between two finish
tokens**, and it varies several-fold run to run on an identical rig:

| run | `drawN` (prims decoded, whole run) | `drawVerts` | `peFrames` |
|---|---:|---:|---:|
| `sab-ingame` | 9,174,452 | 72,160,317 | 1,864 |
| `sab-ingame-mips` | 9,899,427 | 74,651,227 | 846 |
| `repro-ingame` | 9,072,411 | 78,316,253 | **4,166** |

**Total decoded geometry is within ±5% across the three runs while the finished
frame count differs by ~5x.** The runs are the same length and the same shape
(≈30 s boot, then the restored scene), so the guest is producing about the same
amount of work per unit time in all three and emitting `GXSetDrawDone` far less
often in the reference runs.

Accounting for the boot phase (`repro-ingame` rendered at 60/s from t≈20;
`sab-ingame-mips` was still at 0 drawn/s at t=26.8 and first reached 44.2/s at
t=31.8) puts the restored-scene figure at roughly 3,800 prims per finished frame
in `repro-ingame` against roughly 27,000 in `sab-ingame-mips`. Those two numbers
are estimates built on a phase split, not direct measurements — the per-window
census did not exist when the reference runs were taken. The directly measured
figure, per window, exists only for `repro-ingame`: **median 2,498 prims /
22,585 verts / 617 CALL_DL / 6.8 EFB copies per finished frame** over 27 steady
windows.

**Conclusion:** the truth table's `sab-ingame*` row captured one trajectory of a
cell that is not single-valued. `W5_corroborates = false` on that row is a real
observation about that run, not a stable property of the scene — on a re-run the
same cell gives `drawn 23/s ÷ 0.416x = 55.3 implied fps`, which is the NTSC rate
the same rig accepts everywhere else. **A guest-rate number from this cell must
not be published without its own `drawn/s` and a screenshot.**

### F3. The black world is the real, reproducible defect — and it is INDEPENDENT of the frame rate

The world is black in all three runs: at 2.6 drawn/s **and** at 23–28 drawn/s.
So it is not a symptom of the frame-rate collapse, and the two must be treated
as separate defects.

What is established about it:

- **Geometry is submitted every frame.** Median 2,498 prims / 22,585 verts /
  617 `CALL_DL` per finished frame (27 windows). The menu before the restore, by
  contrast, decodes `prim=1 vert=4` per frame (`repro-ingame.log` t=22.9s) — so
  the post-restore figure is the world, not the HUD.
- **Neither emscripten device-gate fires.** `0x026B336C` (the whole EFB-copy
  trigger skipped, `BPStructs.cpp:275-279`) and `0x026B3370` (`RunVertices`
  skipped while the draw is still counted, `OpcodeDecoding.cpp:203-208`) read
  **0 in all 27 windows**. This matters because the prim/vert census at
  `OpcodeDecoding.cpp:171-174` is bumped 33 lines *upstream* of that gate and so
  would otherwise be consistent with zero vertices ever being loaded.
- **The renderer is not broken.** The same binary cold-boots the same disc into
  a fully textured, lit, depth-correct 3D cinematic
  (`/tmp/gcw/sab-cold-mips.png`).
- **The restore is proven** on every run — worker `ack ok=true`, a CoreTiming
  step 643.5x the median, and 234/512 MEM1 fingerprint words changed in one
  200 ms tick (`/tmp/gcw/repro-ingame.log` `[restore-witness] VERDICT`).
- **The guest is not stuck.** The guest PC samples during the black phase land
  in `PSMTXRotTrig` / `PSMTXConcat` / `PSMTXInverse` / `PSMTXMultVec` and
  `GXLoadTexObjPreLoaded` / `GXSetVtxDesc` / `GXSetChanCtrl`
  (`python3 gamecube/tools/gc_symbols.py 1 <pc>…`) — matrix math and GX
  submission, i.e. the guest is actively building the scene.

So all three signals in the original report are internally consistent with one
another; the picture is the one that is wrong, and it is wrong for its own
reason.

### F4. The black world CLEARS later in the run

In `repro-ingame` the world is black in the shots at t=42, t=70 and t=140, and
by the end of the run the canvas is fully rendered — `nonBlack 307195/307200`
with saturated sky blue `(0,56,140)` among the samples. The change coincides
with a burst of EFB copies (5 → 18–26 per frame at t=142–162) and a step change
in the per-frame census (prim 3,834 → 1,830, efbCopy 26.1 → 5.0 at t=167.9),
and at t=187.9 the guest PC is `0x81226ee8`, outside the DOL's `.text`
(which ends at `0x80173140`) — i.e. in a loaded module rather than the main
image. That is consistent with the game leaving the restored scene. **I did not
establish whether the recovered scene is City Escape rendering correctly or a
different scene**, and the distinction matters for the mechanism.

> ⚠ **The end-of-run `canvas:` line is not by itself evidence of anything.**
> `sab-cold-mips` reports `nonBlack: 0` at end of run on a run whose t=138
> screenshot is a full 3D cinematic. Use it only in the positive direction (a
> fully coloured canvas cannot happen by accident), and prefer screenshots.

---

## 4. Working hypotheses on the black world, and their kill criteria

Ranked by fit to F3/F4. **None of these is confirmed.** The measurement that
separates them is described in §5.

| # | hypothesis | why it fits | kill criterion |
|---|---|---|---|
| H1 | **Sticky null pipeline.** `VertexManagerBase::UpdatePipelineObject` sets `m_current_pipeline_object = nullptr` **and clears `m_pipeline_config_changed`** (`VertexManagerBase.cpp:1266-1271`), so a config that fails once is **never retried**; the draw is then dropped at the **uncounted** `if (m_current_pipeline_object)` at `:1037`. | Sticky for as long as the scene keeps using that GX state, and heals when the game moves to a different state — exactly F4's shape. The flush census bumps `kFluDrawn` at `:1019`, i.e. **before** `:1037`, so this loss is invisible to every counter that existed. | `dEnter` (`0x026B3560`, DrawIndexed entries) ≈ `fDrawn` per frame ⇒ dead. |
| H2 | **XF/BP texgen-or-colorchan mismatch** → silent `return` at `VertexManagerBase.cpp:806-827`. | Inherently differential: multi-texgen world vs 1-texgen HUD. No SAB counter, only `ERROR_LOG_FMT`. | `fReal - fDrawn - fCull - fZero` ≈ 0 per frame ⇒ dead. |
| H3 | **Stale texture cache across the restore.** `TextureCacheBase::DoState` invalidates after `DoLoadState` **only when the backend is OGL** (`TextureCacheBase.cpp:563-569`, `__LIBRETRO__`-gated); the canonical backend's `CONFIG_NAME` is `"WGPU"` (`VideoBackends/WGPU/VideoBackend.h:20`) vs `"OGL"` (`VideoBackends/OGL/VideoBackend.h:24`), so it does not run on the shipping path. Upstream has no such call at all (`~/gc_refs/dolphin/.../TextureCacheBase.cpp:549-560`). | Restore-triggered, sticky, heals when the scene's textures are replaced. SAB uses TMEM-preloaded textures (`GXLoadTexObjPreLoaded` is in the guest PC census), which are not re-hashed from RAM the way ordinary textures are. | Draws reach the pass (`dEnc` high) **and** the world stays black ⇒ still live; `dEnc` ≈ 0 ⇒ the loss is upstream of the GPU and this is not it. |
| — | ~~Viewport/`pixelcentercorrection` not re-armed on load~~ | `XFStateManager::DoState` re-arms only `m_projection_changed`, not `m_viewport_changed` (`XFStateManager.cpp:46-51`), and that block is the sole writer of `pixelcentercorrection` and sole caller of `SetScissorAndViewport` (`VertexShaderManager.cpp:337-392`). | **KILLED.** `SetViewportChanged()` is called unconditionally on any XF viewport write (`XFStructs.cpp:117-126`) or BP scissor write (`BPStructs.cpp:146-151`), regardless of whether the value changed, so it self-heals within one frame. It remains a real first-frame-after-restore gap, but cannot hold a scene black for 100 s. |
| — | ~~The emscripten device-gates drop the world~~ | — | **KILLED** by measurement: `0x026B336C` and `0x026B3370` both read 0 in all 27 windows. |

---

## 5. The measurement that separates H1/H2/H3 (no rebuild needed)

Every cell below already has a live writer in the shipping binary — the flush
census is on unless `0x026B3A00` is set (`VertexManagerBase.cpp:126-146`) — so
this needs only the probe-side reader, which is now committed:

```
fReal  0x026B3A0C   flushes that were not a no-op
fDrawn 0x026B3A10   ...of those, the ones that reached the draw
fCull  0x026B3A14 / fZero 0x026B3A18   the two COUNTED drop reasons
dEnter 0x026B3560   WGPUGfx::DrawIndexed entries          (WGPUGfx.cpp:1984)
dNullP 0x026B3564 / dBail 0x026B3568   its counted bails  (:2015, :2020)
dEnc   0x026B356C   draws actually ENCODED into a pass    (:2197)
wErrN  0x026B3530   uncaptured WebGPU validation errors   (:47)
vp/sc  0x026B3548 / 0x026B354C          the viewport/scissor actually applied
```

Read them per window with `PROBE_SCENE_RATE`; the probe now prints one
`[gpu-boundary]` line per window with all of the above expressed **per finished
frame**, plus `LOST = fReal - fDrawn - fCull - fZero`, which is precisely the
count of draws lost to the two gates that have no counter of their own.

The four-way split:

- `dEnc` ≈ thousands/frame → geometry **is** reaching the GPU; the loss is in
  transform/raster/shading (H3, or culling, or depth), not in submission.
- `fDrawn` high but `dEnter` low → dropped at `VertexManagerBase.cpp:1037` ⇒ H1.
- `LOST` high → dropped at `:806-827` ⇒ H2.
- `dEnter` high but `dEnc` low → lost inside `DrawIndexed`, at one of its two
  **uncounted** exits (`WGPUGfx.cpp:2030-2031` `!m_pass`, and `:2099`
  `if (grp0 && grp1)`).

---

## 6. Files touched

| File | Change | Status |
|---|---|---|
| `gamecube/tools/dolphin_render_probe.js` | per-window decode census (`prim/vert/dl/efbCopy` per finished frame), the two device-gate flags, and the `[gpu-boundary]` line walking flush → DrawIndexed → encoded, plus viewport/scissor/WebGPU-error/ablation cells. Probe-side only; no rebuild. | done |
| `gamecube/docs/sab-citye-black-world/TASKS.md` | this file | done |
| `gamecube/docs/guest-rate-witness/TASKS.md` | §9 open item updated to point here | pending |
| `gamecube/dolphin-src/.../TextureCacheBase.cpp` | H3's fix, **if** H3 survives §5 | not attempted |

---

## 7. What this deliberately does NOT do

- **It does not fix anything.** The cause is narrowed to three candidates with a
  stated discriminator; shipping a fix before running §5 would be guessing.
- **It does not chase the frame-rate bimodality.** F2 establishes that the cell
  is not single-valued and that the guest-rate number survives it. Why one
  trajectory packs ~7x more geometry per finish token is a separate question.
- **It does not get a native-Dolphin picture of this scene.** `screencapture`
  has no Screen Recording permission on this box, the `.app` has no ffmpeg for
  `DumpFrames`, and `-C Graphics.Settings.DumpXFBTarget=True` does dump frames
  (401 of them, `/tmp/gcw/dolphin-user3/Dump/Textures/xfb1_*.png`) but the
  savestate never loaded — the dumps are the boot logos. A `.sav` rebuilt with
  the full 61-byte header (`Dolphin 2603a`, cookie `0xBAADBABE+177`, both
  verified against the real `GSNE8P.s01`) produced **no** frames at all, which
  is the signature of Dolphin blocking on a modal alert. Note the CLI system
  token is **`Graphics`**, not `GFX` (`Common/Config/Config.cpp:162`) — the
  first two attempts were silently ignored for that reason alone.

---

## 8. References

- `gamecube/docs/guest-rate-witness/TASKS.md` §4, §9 — the open item, and the
  idle-skip caveat that must accompany any rate number.
- `gamecube/dolphin-src/Source/Core/VideoCommon/OpcodeDecoding.cpp:171-174`
  (census), `:203-208` (the RunVertices device-gate).
- `.../VideoCommon/BPStructs.cpp:275-279` (EFB-copy device-gate), `:290` (copy
  census, bumped *after* the gate).
- `.../VideoCommon/VertexManagerBase.cpp:126-146` (flush census cell map),
  `:806-827` (XF/BP mismatch return), `:1019` (`RecordDrawn`), `:1037` (null
  pipeline), `:1266-1271` (the sticky clear).
- `.../VideoBackends/WGPU/WGPUGfx.cpp:1984/2015/2020/2197` (GPU-boundary
  counters), `:2030-2031` and `:2099` (the two uncounted exits).
- `.../VideoCommon/TextureCacheBase.cpp:552-572` (the OGL-only post-load
  `Invalidate`), against `~/gc_refs/dolphin/.../TextureCacheBase.cpp:549-560`.
- `.../VideoCommon/XFStateManager.cpp:46-51`, `XFStructs.cpp:117-126`,
  `BPStructs.cpp:146-151`, `VertexShaderManager.cpp:337-392` (the killed
  viewport hypothesis).
- Artifacts: `/tmp/gcw/repro-ingame.{log,rows.json}`,
  `/tmp/gcw/repro-t{42,70,140}.png`, `/tmp/gcw/sab-cold-mips.png`,
  `/tmp/gcw/sab-ingame{,-mips}.log`.
