# SAB cold-boot wedge at pc 0x80bc63xx: late EFB-to-RAM writes clobber a DVD staging buffer

Opened and closed 2026-10-01. The numbers below come from probe artifacts on this box
(Linux, 4 cores, SwiftShader WebGPU, load 11-30 from sibling agents). Every claim cites the
run that produced it.

## Goal

A phone report on prod (Android Chrome 154, SAB, JIT path) showed the guest rate dropping
over 30 s. On this box, a SAB cold boot often collapsed to **0.003-0.008x** between about 55
and 115 s in, with `drawn=0` and xpc parked in `0x80bc6304..0x80bc64b4`. The question was
why, and whether the cause is ours.

## What the wedge is (measured)

- **The module is eventD.rel, REL id 80.** The probe's `PROBE_MODLIST` walker read
  `__OSModuleInfoList` (0x800030C8) and found `mod id=80 @0x80bc0fa0`, sections
  `1:0x80bc1088x+0x11f00 … 6(bss):0x80beb560+0x23dc`. The id-to-name mapping comes from the
  disc's FST plus each REL header: `80 eventD.rel` at ISO 0x33400c80.
- **The loop is eventD's init, walking a table whose base it loads from `*(0x80beca1c)`**
  (bss+0x14bc). It calls 0x80bc6204 per element. The restored pthread log shows the reads:
  `Invalid read from 0x12e98713, PC = 0x80bc6404`, at about 140k invalid reads/s (the MMU
  popup counter went 3.4M to 4.5M in 8 s).
- **Pointer value, read with `PROBE_WATCHWORD` (a sampled 2 ms poll):**
  `0x81367aa8` in every good run, and **`0x1156b23f` in every wedged run**. The garbage value
  is the same in every wedged run.
- **Where the pointer comes from.** eventD 0x80bc5e3c-0x80bc5eb0 does three things. It calls
  DOL 0x8001a088, which loads a compressed file into **0x80fffe60** and decompresses it to
  0x8125fe60. It calls 0x8001a16c, which loads a second file. Then it stores
  `*(bss+0x14bc) = **(sec5+0x288)`, i.e. the first word of the decompressed file. In good
  runs that word goes `GVMH` → `HMVG` → `0x81367aa8`.

## Root cause (measured)

`WGPUStagingTexture::ReadTexels` (WGPUTexture.cpp) defers an EFB→RAM copy whose GPU readback
has not resolved. The `mapAsync` callback (WGPUTextureCache.h `CopyEFB`) then writes guest
RAM **whenever the readback lands**, which can be after the PE finish/token has already told
the guest the frame is done.

A census of those late writes (cells 0x026B3E00..) shows **every recorded late write targets
guest 0x80fffe60, 0x8000 bytes**: 16 of 16 ring entries, in every run. That address is the
same staging buffer SAB uses for compressed DVD files. Readback latency on this box:
**mean ≈44 s, max 119-147 s** (`latSumMs/latMaxMs`, control runs). SwiftShader compiles
pipelines lazily, so a copy issued during the title screen lands while eventD's file is in
that buffer. The file then decompresses to garbage.

## The fix

**Hold the PE token/finish interrupt until outstanding late writes land, for up to 100 ms.**
`PixelEngine::RaiseEvent` holds while `g_efb_ram_outstanding > 0`. The readback callback
decrements the counter and calls `ReleaseHeldTokenFinish`. On a GPU whose readback beats
100 ms this is exact: the guest never sees "done" before the bytes are in RAM, which is what
real hardware guarantees.

If the readback is slower, `PollHeldTokenFinish` (called every GPU slice, Fifo.cpp) gives up
at 100 ms, releases the interrupt and bumps the generation. A straggler from an older
generation is written only if its destination still holds what it held at deferral (FNV-1a
fingerprint). If the guest has rewritten that RAM, the straggler is dropped. A stale copy
never overwrites newer guest data.

Run-time arms in cell 0x026B3E08, so the control and the fix come off one binary:

| value | behaviour |
|---|---|
| 0 (default) | hold up to 100 ms, then the fingerprint guard |
| `0xEFB06A2D` | no hold, fingerprint guard only |
| `0xEFB0A11F` | the old unordered late write (control) |
| `0xEFB0D0D0` | drop every late write |

Census in the probe's `lateEfb` field: late writes / dropped / last 16 destinations /
latency sum, max / `peHold` / `peGiveUp`.

## Evidence (interleaved, same binary, full rendering, cold boot, 170-200 s)

| run | binary | arm | eventD pointer | end state |
|---|---|---|---|---|
| lc1 | guard build `17ab7198` | control | `0x1156b23f` | **wedged**, 0.003-0.005x at 0x80bc63xx |
| lg1 | guard build `17ab7198` | guard | `0x81367aa8` (47 stale dropped) | 3D, running |
| xc1 | hold-1s build `07b38646` | control | `0x1156b23f` | **wedged** |
| xc2 | hold-1s build `07b38646` | control | `0x81367aa8` | ran (the race is probabilistic) |
| yh1 | hybrid build `f10ec264` | default | `0x81367aa8` (34 stale dropped) | 3D, running |
| yc1 | hybrid build `f10ec264` | control | `0x1156b23f` | **wedged** |
| yh2 | hybrid build `f10ec264` | default | `0x81367aa8` (42 stale dropped) | ran |
| yc2 | hybrid build `f10ec264` | control | `0x81367aa8` | ran |
| yh3 | hybrid build `f10ec264` | default | `0x81367aa8` (34 stale dropped) | ran |
| yc3 | hybrid build `f10ec264` | control | `0x1156b23f` | **wedged** |
| final | shipped `c104601c` (live tree, canonical link) | default | `0x81367aa8` (6 dropped) | ran; 0 page errors; MP4 recomp 0 page errors |

**Totals over runs that reached eventD: control 4/6 wedged; fix 0/8.** The pointer witness
is exact in every row (`0x1156b23f` = wedge, `0x81367aa8` = correct).

The guard-only build also gave 3/3 correct pointers (h1-h3, 20/107/68 stale writes dropped).
Runs at load 22-30 that never reached eventD within the window are excluded. They decide
nothing either way: lc2-lc4, lg2-lg4, xh1, xh2.

**The pure 1 s hold was too slow on this box.** peHold=260 with peGiveUp=92 held frames to
about 1 drawn/s, because readbacks here take seconds. The hybrid gives up at 100 ms. On this
box it behaves as the guard (peHold=555 = peGiveUp=555). On a GPU that reads back within
100 ms it is exact. **I have not measured it on a hardware GPU.**

## What this does NOT establish

- Whether the user's phone hits the same wedge. Its 0.245x end-of-window rate is not the
  0.005x signature. Phone readback latency is unmeasured.
- The frame-rate cost of the 100 ms hold on a hardware GPU.
- Whether 0x80fffe60 is the only overlap. The ring only keeps the last 16 destinations.

## Traps hit on the way

- `PROBE_POKE=…@0` fails silently with `no sharedMemory`. In every early run the
  draw-ablation poke never applied. Poke at ≥3000 ms.
- With `stateMs=30000` the 1.46 GB ISO write can finish after the hand-off on a loaded box.
  The late restore then lands mid-boot and wedges the run. The witness rig now takes
  `WITNESS_STATE_MS`.
- `guest_rate_witness.mjs` used `md5 -q`, which is macOS-only. On Linux the hash guard
  printed `missing` before and after every cell. Fixed, with an md5sum fallback.
