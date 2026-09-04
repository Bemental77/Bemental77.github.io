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
| `citye-gpu` (this session) | 16:0x | **22.6** (median, 26 windows) | black |

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

### F5. The restore path does NOT break rendering in general — a matched self-test

The obvious next suspicion was "any savestate restore leaves the renderer in a
bad state". It does not. One run (`/tmp/gcw/selftest.log`, same frozen binary,
`probe_lock`-serialized, load 5.35 → 9.45) does the whole experiment inside
itself:

1. cold-boot SAB, screenshot at t=138 s — **the title screen renders correctly**
   (`/tmp/gcw/self-t138-BEFORE.png`);
2. `PROBE_SAVE_STATE` at t=140 s — the port saves its own state
   (8,976,696 gz bytes);
3. `PROBE_LOAD_STATE` of *that same file* at t=170 s — restore proven (worker
   `ack ok=true`, `RESTORE-OK bytes=92835094`, and the CoreTiming/MEM1
   discontinuity witness);
4. screenshot at t=176 s — **the title screen renders correctly again**
   (`/tmp/gcw/self-t176-AFTER.png`), and at t=230 s the run is drawing a fully
   textured, lit 3D cinematic (`/tmp/gcw/self-t230-AFTER.png`).

So restoring a state captured from a known-good rendering moment reproduces the
good rendering. **The black world is specific to the City Escape state, not to
the restore mechanism.** (The white frame at t=190 in that run is the attract
sequence's own transition, not a defect — t=230 is correct 3D.)

### F6. Nothing is dropped anywhere in the submit path

The same run carries the new `[gpu-boundary]` census. Across **every** window of
the whole 260 s run, before and after the restore:

```
flushReal == fDrawn == DrawIndexed-enter == ENCODED
LOST = 0   cull = 0   zeroIdx = 0   nullPipe = 0   bail = 0
wgpuErr = 0/t0        ablation switches = 0/0/0/0/0
```

Every flush that is not a no-op reaches `DrawIndexed` **and** is encoded into a
render pass. That **kills H1 and H2 below**: neither the sticky null pipeline
(`VertexManagerBase.cpp:1037`/`:1266-1271`) nor the XF/BP texgen-colorchan
mismatch return (`:806-827`) is discarding anything on this build. It also
clears the two uncounted exits inside `DrawIndexed`, since `ENCODED` equals
`enter`.

### F7. …and the same is true ON the black City Escape scene — THE ANSWER

`/tmp/gcw/citye-gpu.log` re-runs the City Escape cell with the `[gpu-boundary]`
census (same frozen binary, restore proven, load 10.57 at the end). The world is
black again — third independent reproduction, `/tmp/gcw/citye-gpu-t60.png`,
score 140 / `00:19:10` / 9 rings / live "B" prompt. Median over 26 steady
windows (`t ≥ 55 s`):

```
speed 0.388x   drawn 22.6/s   ⇒ W5 = 58.2 implied fps  (NTSC 59.94 — corroborates)
prim/frame 2,921        vert/frame 25,527
fReal = fDrawn = dEnter = dEnc = 63,886      (EXACTLY equal, every window)
nullPipe 0   bail 0   cull 0   zeroIdx 0   LOST 0   wgpuErr 0/t0
viewport 640x480   scissor 640x480   vpDegen 0   ablation 0/0/0/0/0
```

**Every draw the guest submits for the black world is encoded into a render
pass, with a correct full-screen viewport and scissor and no WebGPU validation
error.** Nothing is dropped, culled, skipped or rejected anywhere between the
FIFO decoder and the GPU.

So the black world is **not** a lost-draw bug. The draws are issued and
rasterized; they simply produce nothing visible. That places the defect
downstream of submission — in the transform or the shading of those draws
(vertex constants, texture binding/contents, TEV, blend or depth state) — and,
per F5, in something specific to *this restored scene* rather than to restoring
in general.

---

## 4. Working hypotheses on the black world, and their kill criteria

Ranked by fit to F3/F4 as they stood when this topic opened. **F6/F7 have since
killed every hypothesis in this table**; it is kept because the kill criteria
are the useful part.

**Status after F5/F6/F7.** H1 and H2 are dead, H3's general form is refuted, and
the whole submit-path family is eliminated: `dEnc == fReal` exactly. What
remains is scene-specific *shading or transform* state. Two leads were left open:
(a) the City Escape state file may itself be a bad artifact — it was written by
the port on 2026-08-29, it is **not** derived from the native `GSNE8P.s01`
(payload md5s differ: `87a44ff5…` vs `ac48ab65…`, and the sizes differ by
29,424 B), and nothing has ever round-tripped its video chunk;
(b) SAB's TMEM-**preloaded** textures — `GXLoadTexObjPreLoaded` is in the guest
PC census, and preloaded textures are not re-hashed from guest RAM the way
ordinary ones are, so a wrong TMEM image after restore would sample black
without any counter noticing.

> **BOTH LEADS ARE NOW DEAD — see §9.** (a) died on a matched pair: the *same*
> state file renders correctly under the 2026-08-29 binary (F9), so the artifact
> is fine and the black world is a **regression**. (b) died on source: TMEM *is*
> serialized, `VideoState.cpp:58` (F10). The experiment proposed below was
> superseded — a fresh save was not needed, and the *native*-derived state cannot
> be loaded into the port at all (F11).

~~The cheapest next experiment for both: in a run where the world has **recovered**
(F4), `PROBE_SAVE_STATE` a fresh City Escape state and reload it. If the fresh
state renders, the shipped 2026-08-29 artifact is the defect, not the code.~~

| # | hypothesis | why it fits | kill criterion |
|---|---|---|---|
| H1 | ~~**Sticky null pipeline.**~~ **KILLED (F6)** `VertexManagerBase::UpdatePipelineObject` sets `m_current_pipeline_object = nullptr` **and clears `m_pipeline_config_changed`** (`VertexManagerBase.cpp:1266-1271`), so a config that fails once is **never retried**; the draw is then dropped at the **uncounted** `if (m_current_pipeline_object)` at `:1037`. | Sticky for as long as the scene keeps using that GX state, and heals when the game moves to a different state — exactly F4's shape. The flush census bumps `kFluDrawn` at `:1019`, i.e. **before** `:1037`, so this loss is invisible to every counter that existed. | `dEnter` (`0x026B3560`, DrawIndexed entries) ≈ `fDrawn` per frame ⇒ dead. |
| H2 | ~~**XF/BP texgen-or-colorchan mismatch**~~ **KILLED (F6)** → silent `return` at `VertexManagerBase.cpp:806-827`. | Inherently differential: multi-texgen world vs 1-texgen HUD. No SAB counter, only `ERROR_LOG_FMT`. | `fReal - fDrawn - fCull - fZero` ≈ 0 per frame ⇒ dead. |
| H3 | ~~**Stale texture cache across the restore (general form)**~~ **REFUTED (F5)** — `TextureCacheBase::DoState` invalidates after `DoLoadState` **only when the backend is OGL** (`TextureCacheBase.cpp:563-569`, `__LIBRETRO__`-gated); the canonical backend's `CONFIG_NAME` is `"WGPU"` (`VideoBackends/WGPU/VideoBackend.h:20`) vs `"OGL"` (`VideoBackends/OGL/VideoBackend.h:24`), so it does not run on the shipping path. Upstream has no such call at all (`~/gc_refs/dolphin/.../TextureCacheBase.cpp:549-560`). | Restore-triggered, sticky, heals when the scene's textures are replaced. SAB uses TMEM-preloaded textures (`GXLoadTexObjPreLoaded` is in the guest PC census), which are not re-hashed from RAM the way ordinary textures are. | Draws reach the pass (`dEnc` high) **and** the world stays black ⇒ still live; `dEnc` ≈ 0 ⇒ the loss is upstream of the GPU and this is not it. |
| — | ~~Viewport/`pixelcentercorrection` not re-armed on load~~ | `XFStateManager::DoState` re-arms only `m_projection_changed`, not `m_viewport_changed` (`XFStateManager.cpp:46-51`), and that block is the sole writer of `pixelcentercorrection` and sole caller of `SetScissorAndViewport` (`VertexShaderManager.cpp:337-392`). | **KILLED.** `SetViewportChanged()` is called unconditionally on any XF viewport write (`XFStructs.cpp:117-126`) or BP scissor write (`BPStructs.cpp:146-151`), regardless of whether the value changed, so it self-heals within one frame. It remains a real first-frame-after-restore gap, but cannot hold a scene black for 100 s. |
| — | ~~The emscripten device-gates drop the world~~ | — | **KILLED** by measurement: `0x026B336C` and `0x026B3370` both read 0 in all 27 windows. |

---

## 5. The measurement that separates H1/H2/H3 (RUN — see F6/F7)

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

---

## 9. RESOLVED: the state file is exonerated — this is a REGRESSION

### F8. The native oracle renders this scene perfectly

Gate #1's default first action was never run against this scene. It works, and
the route the topic recorded as blocked is only *half* blocked: a **native**
Dolphin state loads natively via `-s`.

```bash
/Applications/Dolphin.app/Contents/MacOS/Dolphin -u /tmp/bw/dol-user \
  -C Dolphin.Core.CPUThread=True -C Dolphin.Core.CPUCore=1 \
  -C Graphics.Settings.DumpXFBTarget=True \
  -e "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso" \
  -s "$HOME/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01"
```

14 s, killed by PID (never `pkill -f Dolphin` — siblings drive Dolphin too).
105 XFB PNGs in `/tmp/bw/dol-user/Dump/Textures/`, 5 distinct (the state rests on
SA2's "Game Data cannot be found" modal, which pauses the world). The last frame,
`/tmp/bw/native-last.png`, is **full 3D City Escape** — buildings, trees, taxi,
road, ocean, HUD, modal. **The scene and its guest data are sound; a correct
emulator renders them.**

### F9. THE MATCHED PAIR — same state file, two committed binaries

The decisive experiment. `gamecube/states/sab-citye-gameplay.gcs.gz` was added by
`0e2dc92b` (2026-08-29), whose message reports City Escape gameplay rendering
("Sonic boarding"). That commit's binaries are still in git, so the A/B needs **no
rebuild**: stage a snapshot whose `gamecube.html` + `dolphin_libretro/` +
`ppc-worker/` come from one commit, and vary only that.

| arm | `dolphin_worker_emcc.wasm` | restore | t=60 | t=100 | world |
|---|---|---|---:|---:|---|
| `0e2dc92b` (2026-08-29) | `69e38d94…` | DISCONTINUITY PRESENT | HUD 140 / 00:17:37 / 008 | HUD 240 / 00:31:29 / 010 | **RENDERS** |
| HEAD `0b6b61e9` (2026-09-04) | `82bc8f8b…` | `ack ok=true`, DISCONTINUITY PRESENT | HUD 140 / 00:19:10 / 009 | HUD 260 / 00:36:24 / 010 | **BLACK** |

`/tmp/bw/old-t{60,100}.png` vs `/tmp/gcw/citye-gpu-t{60,100}.png`.
Near-identical guest progress; opposite pictures. Steady-window medians (t≥45 s)
show the **workload is the same**, so nothing is being submitted less:

```
                 speed  drawn/s  prim/frame  vert/frame  efbCopy/frame
OLD  (renders)   0.3     19.9      2935        24634        7.3
HEAD (black)     0.4     22.5      2598        23080        8.6
```

Both arms are display-list driven (`xfd` dlN 1.5M–2.2M), so §3's "the black scene
uses display lists" is a *gameplay-vs-cinematic* difference, not a defect signal.

**⇒ Lead (a) is DEAD. The committed state file is not the bad artifact.** The
black world is a **regression in `dolphin_worker_emcc` between 2026-08-29 and
2026-09-04** — five wasm-changing commits: `8a4342e5`, `b8314d0a`, `c224b7c2`,
`7a77e12e`, `0b6b61e9`, all perf work. HEAD is *faster* and renders nothing.

### F10. Lead (b) is dead on source: TMEM **is** in the savestate

`VideoState.cpp:58` `p.DoArray(s_tex_mem)` serializes the full 1 MB TMEM, and
`VideoState.cpp:62` `TMEM::DoState(p)` the 8 unit states. The file is a **verbatim**
match to `~/gc_refs/dolphin/.../VideoState.cpp` (empty diff). Preload copies guest
RAM into `s_tex_mem` at `BPStructs.cpp:661/681/683`. Nothing about preloaded
textures is lost across a restore.

### F11. Also killed, each by measurement or source

- **The emitted-wasm vertex loader never runs on SAB.** `vtxCreate=17,
  vtxBuilt=0, vtxUnsup=17` in all five runs — every SAB vertex format is rejected
  by `VertexLoaderWasm::IsSupported`. `?bjit_vtx_software=1` is a **no-op A/B** on
  this title; do not spend a lock slot on it.
- **Every rendering-breaking ablation lever is off.** `abl=0/0/0/0/0` in every
  window (`0x026B3B00/04/08`, `kAblBPCell 0x026B3B34`, `kAblUploadCell 0x026B3B38`).
  `kCoalesceCell 0x026B3BE0` and `kRedundantStateCell 0x026B3BE4` have **no writer**
  anywhere in the tree, and `tools/preflight_all.sh` "SAB cell-collision audit"
  passes, so no sibling instrument is silently arming one.
- **A native Dolphin state cannot be loaded into the port.** `/tmp/gcw/from-s01.gcs.gz`
  (the `GSNE8P.s01` payload, 92,917,279 B) gave `[restore-witness] VERDICT: NO
  DISCONTINUITY — nothing replaced CoreTiming`, then the guest wedged
  (`drawn=0/s`, PC parked at `0x800ebea0`, `speed` still reading 1.000x — the
  idle-credit artifact gate #10 warns about). The port's own DoState is
  92,946,703 B (`[worker] loadState RESTORE-OK bytes=92946703`), 29,424 B more.
  `window.__probeStateSize` exists for exactly this compat check.
  **The screenshot from that run is a stale frame and is not evidence.**

### F12. Which commit — FIVE narrowed to TWO on source (then settled by F13)

Two of the five are **default-inert** and cannot be the cause of a run that
passed only `?bjit_mips=1`:

- **`c224b7c2`** (batch JIT blocks into shared wasm instances) is gated on SAB
  cell `0x026B39A0`, "browser-zeroed 0 = OFF = one module per block =
  byte-identical to the pre-change tree". `?bjit_batch` was never passed.
- **`0b6b61e9`** adds only the `?noleafinline` kill switch; the gate is
  `li_candidate && *AotCell(kLeafInlineOffCell) == 0u`, so with the cell zero the
  path is byte-identical to `7a77e12e`.

A third is inert too. **`7a77e12e`**'s entire emitter diff is the `[mips]` meter
becoming runtime-gated: `jit_branch.cpp` drops its hand-synced
`BEM_MIPS_CENSUS = true` / `BEM_MIPS_EXEC_CELL` duplicate in favour of
`ppc_emit.h`, and both sites change `if (BEM_MIPS_CENSUS)` →
`if (bem_mips_census_on())`. Nothing else. Every run in the pair passed
`?bjit_mips=1`, which arms the meter, and the meter only increments a counter —
so the emitted semantics are the same on both arms.

**Remaining: TWO — `8a4342e5` (leaf-inline splice, default ON) and `b8314d0a`
(4-slot publish ring: `WGPUGfx.cpp` +93, `gamecube.html` +410).** The A/B swapped
page *and* worker together, so `b8314d0a`'s page-side ring is inside the window.
Against it: the publish ring is presentation-side, and the HUD updates live
across screenshots (the timer advances), so a stale-slot present is argued
against — but not excluded.

**`m1` = `8a4342e5` therefore decides it alone**: the OLD arm renders, so `m1`
black ⇒ `8a4342e5`; `m1` renders ⇒ `b8314d0a`.

A code-read argument against `b8314d0a`, offered as reasoning and **not** as a
measurement: its `WGPUGfx.cpp` hunk only moves the present READBACK from one
`m_pixels` buffer to a 4-slot ring (`m_pixels_ring[slot_idx]`, seqlock per slot,
publish index stored last). It changes *where already-rendered pixels are
staged*, not what is drawn into the EFB. And the published slot demonstrably
carries a **live** image — the HUD's timer advances between screenshots — so the
consumer is not reading a stale or half-written slot. For this commit to be the
cause, a fresh readback would have to contain the HUD but not the world, which
this hunk has no mechanism to do. That leaves `8a4342e5` as the favourite **by
elimination only**, which is exactly the standard §7 says not to ship a fix on.

Arms staged (`/tmp/bw/snap-m{1,2}`, matched js/wasm, pinned page) and queued
behind the probe lock. How to run one:

```bash
bash /tmp/bw/bisect.sh /tmp/bw/snap-m1 m1   # 8a4342e5
bash /tmp/bw/bisect.sh /tmp/bw/snap-m2 m2   # b8314d0a
```

### F12a. The leaf-inline signals, and why they are NOT yet proof

Two signals point at `8a4342e5`'s pure-leaf `bl` splice (idle-classifying SAB's
VI-retrace frame governor), neither sufficient on its own:

- `leafInline` census (`cand/spliced/idle/bailed`, cell `0x026B3B60…`):

  | run | census | `lastIdlePc` | world |
  |---|---|---|---|
  | `old` (0e2dc92b) | `0/0/0/0` | `0` | renders |
  | `sab-cold{,-mips}` (HEAD) | `4881/15/15/220` | `80117e0c` | renders |
  | `selftest` (HEAD, restores its own state) | `13365/20/20/662` | `800fe5c8` | **renders** |
  | `citye-gpu`, `sab-ingame{,-mips}`, `repro-ingame` (HEAD) | `…/20/20/…` | `80117e0c` | **black** |

  ⚠ **The idle count does NOT discriminate**: `selftest` classifies the same 20
  and renders. Its `lastIdlePc` is `0x800fe5c8` (the DSP-mailbox family), not the
  governor, so the *sets* differ — but on this evidence the lever firing is
  neither necessary nor sufficient, and the hypothesis is **unproven**.
- `vtx` (`0x026B3580` = `m_vertex_cpu[0]`, i.e. the loader's first output dword =
  position.x): quiet **NaN** (`0x7fc00000`/`0xffc00000`) in 6/6 occurrences across
  the three black gameplay runs, and 0/29 snapshots across three rendering runs
  (`sab-cold`, `sab-cold-mips`, `selftest`) and 0/6 in the OLD arm on this scene.
  One sample per ~20 s, so this is a correlation, not a proof that most geometry
  is NaN.

The clean discriminator needs no rebuild: `0b6b61e9` shipped a kill switch,
**`?noleafinline=1`** (SAB cell `0x026B3B74`, read at emit time in
`JitWasm::TryCompileBlock`), so both arms come off ONE binary. It must be armed
from the query string, and the page that reads it is HEAD's — pin it.

> ⚠ **RIG TRAP, paid for here.** `/tmp/gcw/snap/gamecube.html` is a **symlink into
> the working tree**, so writing a pinned page into a `cp -R` of that snapshot
> writes *through* it and silently replaces the repo's `gamecube.html`. Break the
> symlink (`rm -f "$DEST/gamecube.html"`) before writing. Verify with
> `[ -L "$DEST/gamecube.html" ]` and re-check `git status gamecube.html` after
> staging.

### F13. ROOT CAUSE, PROVEN — `8a4342e5`'s pure-leaf `bl` splice. FIXED.

The kill switch `0b6b61e9` shipped settles it on the **shipping binary**, so no
bisect arm was needed. One binary (`82bc8f8b`, md5 identical before **and** after
every run), one page, the same savestate, `DISCONTINUITY PRESENT` +
`RESTORE-OK bytes=92946703` in all three arms:

| arm | `leafInline` cand/spliced/idle/bail | canvas `nonBlack` | world |
|---|---|---:|---|
| `?noleafinline=1` | `7011/`**`0/0`**`/0` | 307180/307200 = 100.0% | **FULL 3D** |
| default, after this fix | `6989/`**`0/0`**`/0` | 307094/307200 = 100.0% | **FULL 3D** |
| `?noleafinline=0` | `8087/`**`20/20`**`/334`, `lastIdlePc=80117e0c` | 4343/307200 = **1.4%** | **BLACK** (HUD only) |

Shots: `/tmp/bw/leaf-OFF-t60.png`, `/tmp/bw/fix-default-t60.png`,
`/tmp/bw/fix-control-t60.png`. The census is its own arm-difference proof — the
candidate count is bumped on every arm and only `spliced`/`idle` move, so an
all-zero row cannot be confused with "the census never ran".

This also explains F12a's counter-evidence. `selftest` classifies 20 idle blocks
too, but its `lastIdlePc` is `0x800fe5c8` (DSP mailbox), not `0x80117e0c`. **The
count never mattered; which block is spliced does.** Every black run names the
VI-retrace frame governor `0x80117e0c`; the cold-boot run that renders classifies
15 and also names it, so the necessary condition is narrower still — the splice
must be live on that block *while the gameplay scene is running*. Not chased
further: the fix does not depend on it.

**THE FIX (JS-only, no rebuild): `gamecube.html` now writes cell `0x026B3B74`
unconditionally, defaulting to `1` = splice suppressed.** Previously it wrote the
cell only when `?noleafinline` was present, so the shipped default depended on
the SAB region happening to be browser-zeroed. `?noleafinline=0` restores the old
behaviour for A/B work.

⚠ **Do not read a perf win out of that table.** The black arm reports a *higher*
`drawn/s` (21.2 vs 16.7–18.2) precisely because it is not drawing the world, so
the rates are not comparable. `0b6b61e9`'s interleaved pair measured the splice at
−5.0% guest / −8.1% published on a different scene; **this change is justified by
correctness, not by speed**, and the fix may well cost presented fps now that the
world is actually being drawn.

**Follow-up, not done here:** the C++ default in `JitWasm::TryCompileBlock` is
still "cell == 0 ⇒ splice", so any entry point that is *not* `gamecube.html`
(a bespoke harness booting the worker directly) still gets the splice. Making the
C++ side default-off needs a rebuild and should carry its own matched pair.
`gamecube/ppc-worker/ppc_worker_main.cpp` never wired the splice, so it is
unaffected.

**Still open (pre-existing, not caused by the splice):** F4's late "recovery" —
whether the scene that appears after ~120–167 s in the *black* arm is City Escape
rendering correctly or a different scene. With the fix in place the scene renders
from the first frame, so this is now a curiosity rather than a blocker.
