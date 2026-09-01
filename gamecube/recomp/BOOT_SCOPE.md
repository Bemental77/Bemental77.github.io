# BOOT_SCOPE.md — minimal OS/HW host layer to reach the first `VIWaitForRetrace()`

Scope: get Mario Party 4's `main()` (native-port wasm, `~/gc_refs/marioparty4` compiled by
`gamecube/recomp/build_wasm.sh`) from the current boot trap to the **first
`VIWaitForRetrace()`** in `main()` (`src/game/main.c:75`) — the seam where the first GP‑FIFO
frame has been emitted. This is a scoping document; it does not implement the layer.

All file:line citations are to `~/gc_refs/marioparty4/…` unless noted. Runtime observations
are from the `node gamecube/recomp/recomp_run.mjs` harness against
`/tmp/gc_recomp_build/mp4_game.wasm` built this session.

---

## 0. Correction to the task premise (verified this session — READ FIRST)

The task brief states OSInit/DVDInit/VIInit/PADInit "are all real functions in the wasm, NOT
host imports" and that the trap is *inside* `OSInit`/`__OSThreadInit`. **The build disagrees.**

Per the fresh build (`bash gamecube/recomp/build_wasm.sh`: "123 built, 26 failed") and the
import dump of `mp4_game.wasm`:

- **26 SDK units FAIL to compile** and are therefore **host imports** (undefined symbols the
  linker leaves as imports; the harness stubs them). The failures are all mechanical:
  - `*: expected '(' after 'asm'` — units with GCC/PPC `asm{}` bodies (`OSCache.c`,
    `OSTime.c`, `PPCArch.c`, `OSMemory.c`, `ai.c`, `__ppc_eabi_init.c`, `db.c`).
  - `*: expected ';' after top level declarator` — units using the Metrowerks
    absolute-address extern syntax `vu16 x : (OS_BASE_CACHED | 0x30E6);`
    (`OS.c`, `OSThread.c`, `OSContext.c`, `OSResetSW.c`, `OSReboot.c`, `OSReset.c`,
    `OSError.c`, `OSLink.c`, `EXIBios.c`, `Pad.c`).
  - `*: expected identifier or '('` — `OSInterrupt.c`, `OSSync.c`, `OSAlarm.c`.
  - `use of undeclared identifier 'VI_DISP_INT_0' / 'DI_STATUS' / 'VI_DTV_STAT'` —
    `vi.c`, `dvd.c`, `OSFont.c` (an `hw_regs.h` include-guard/enum issue under `-std=gnu89`).
  - Full list: `/tmp/gc_recomp_build/fails.txt`.
- Confirmed by import dump: **`OSInit`, `DVDInit`, `VIInit`, `PADInit`, `VIConfigure`,
  `VIWaitForRetrace`, `VIFlush`, `VISetNextFrameBuffer`, `OSGetConsoleType`,
  `VIGetDTVStatus`, `OSSetCurrentContext`, `OSClearContext`, `OSDisableInterrupts`,
  `OSCreateThread`, `OSSleepThread`, `OSWakeupThread`, `__OSSetInterruptHandler`,
  `PADReset`, `DVDReset`, … are IMPORTS** (host-stubbed).
- Confirmed **defined-internal (compiled IN)**: `main`, `HuSysInit`, `InitMem`,
  `InitRenderMode`, `InitGX`, `InitVI`, `OSAlloc`, `OSInitAlloc`, `OSCreateHeap`,
  `OSSetCurrentHeap`, `OSGetArenaLo/Hi`, `OSSetArenaLo/Hi`, `OSRoundUp32B`, `GXInit`,
  `GXAdjustForOverscan`, `GXSetViewport/Scissor/…`, `GXCopyDisp`, `OSGetProgressiveMode`,
  `__OSThreadInit` (**it compiles** — OSThread.c fails only at the file's *address-extern*
  declarations at the top, but... see note), and the whole GX geometry/transform layer.

  NOTE: because `OSThread.c` and `OSContext.c` FAIL to compile as units, `__OSThreadInit`
  is in practice an **import** too (its object never built). So the task's "traps inside
  `__OSThreadInit`" cannot be what happens today — `OSInit` never runs at all.

**Consequence for scoping:** we do **not** stage memory to make `OSInit`/`__OSThreadInit`
*succeed*; those are **SHIM** targets (host functions) regardless. What we stage memory for
is the set of functions that ARE compiled in and read OS globals/arena — chiefly `InitMem`,
`GXInit`, and the OS heap allocator, plus whatever the game's own code reads from low memory.

---

## 1. Current trap (verified) and its immediate cause

`node recomp_run.mjs` → `=== main() result: TRAP/throw: memory access out of bounds`,
with `OSReport calls: 0 | VIWaitForRetrace hits: 0`.

Zero `OSReport` calls proves `OSInit` (the import stub) is a no-op — its ~8 `OSReport` lines
(`OS.c:295-340`) never fire. So control flows: `main()` → `HuSysInit` (`init.c:44`) →
`OSInit()` **[no-op stub]** → `DVDInit/VIInit/PADInit` **[no-op stubs]** →
`OSGetProgressiveMode()`/`VIGetDTVStatus()` (progressive check, `init.c:52`) →
`InitRenderMode(mode)` (compiled-in) → `InitMem()` (compiled-in) → **TRAP**.

**Root cause (code-read):** With `OSInit` stubbed, the arena globals keep their C static
initializers: `__OSArenaLo = (void*)-1` (`OSArena.c:7`) and `__OSArenaHi` = `0`
(`OSArena.c:6`, zero-init). `InitMem` (`init.c:131`) then does:

```
void *arena_lo = OSGetArenaLo();               // = (void*)0xFFFFFFFF
DemoFrameBuffer1 = (void*)OSRoundUp32B((u32)arena_lo);   // (0xFFFFFFFF+0x1F)&~0x1F = 0x00000000  (wraps)
DemoFrameBuffer2 = OSRoundUp32B(fb1 + fb_size);          // ~0x96000
DemoCurrentBuffer = DemoFrameBuffer2;
arena_lo = OSRoundUp32B(fb2 + fb_size);                  // OSSetArenaLo(...)
OSGetConsoleType()==OS_CONSOLE_DEVHW1 && …               // import stub returns 0 → else-branch
  arena_lo = OSInitAlloc(OSGetArenaLo(), OSGetArenaHi(), 1);   // arenaHi still 0 → range (lo>hi) invalid
  OSSetCurrentHeap(OSCreateHeap(arena_lo, arena_hi));    // heap over [lo, 0) → OOB / broken heap
```

The out-of-bounds store lands either in the wrapped `DemoFrameBuffer` region or inside
`OSInitAlloc`/`OSCreateHeap` walking a `[arena_lo, arena_hi=0)` range. Either way the fix is
the same: **arenaLo / arenaHi must be staged to sane in-bounds values before `InitMem`
runs** (§3), i.e. the job `OSInit` would have done via `OSSetArenaLo/Hi`.

(One runtime data point + a code-read; not yet single-stepped to the faulting instruction.
If a byte-exact fault address is wanted, export `OSGetArenaLo`/`InitMem` via
`-Wl,--export=` and call them from the harness to bisect — cheap follow-up, not required to
act on §3.)

---

## 2. Ordered call chain: `main()` → first `VIWaitForRetrace()`

`main()` `main.c:40`. First real work is `HuSysInit(&GXNtsc480IntDf)` (`main.c:53`).
`HuSysInit` body is `init.c:44-80`. Table below is in execution order; "kind" = compiled-IN
(runs in wasm) vs IMPORT (host stub). "HW/globals" flags what it touches.

| # | Call | Site | Kind | Touches | Classification |
|---|------|------|------|---------|----------------|
| 1 | `OSInit()` | init.c:47 | IMPORT | would read `0x80000000` BootInfo, `__PIRegs[11]`, set arena, init threads/interrupts/EXI/SI/SRAM/audio | **SHIM** (§2a) |
| 2 | `DVDInit()` | init.c:48 | IMPORT | DI MMIO writes; installs DI int handler | **SHIM (no-op ok)** (§2b) |
| 3 | `VIInit()` | init.c:49 | IMPORT | VI MMIO; installs retrace int handler #24; inits `retraceQueue` | **SHIM (state-init)** (§2c) |
| 4 | `PADInit()` | init.c:50 | IMPORT | SI async; installs reset fn | **SHIM (no-op ok)** (§2b) |
| 5 | `OSGetProgressiveMode()` | init.c:52 | compiled-IN | reads a low-mem global | LET-RUN (returns 0 ⇒ non-progressive; fine) |
| 5b| `VIGetDTVStatus()` | init.c:52 | IMPORT | reads `__VIRegs[VI_DTV_STAT]` | SHIM → return 0 |
| 6 | `InitRenderMode(mode)` | init.c:58 | compiled-IN | none (mode!=NULL ⇒ just `RenderMode=mode`) | LET-RUN |
| 7 | **`InitMem()`** | init.c:59 | compiled-IN | `OSGetArenaLo/Hi`, `OSInitAlloc`, `OSCreateHeap`, framebuffer memset | **LET-RUN once arena staged (§3)** — *current trap* |
| 8 | `VIConfigure(RenderMode)` | init.c:60 | IMPORT | VI regs (shadow) | SHIM (no-op ok for frame-0) |
| 9 | `VIConfigurePan(0,0,640,480)` | init.c:62 | IMPORT | VI regs | SHIM (no-op ok) |
| 10| `OSAlloc(0x100000)` | init.c:64 | compiled-IN | heap alloc (needs §3 heap) | LET-RUN once heap valid |
| 11| **`GXInit(fifo, 0x100000)`** | init.c:65 | compiled-IN | CP/PE/PI reg writes, WGP init, installs CP int handler (via `__OSSetInterruptHandler` import) | **LET-RUN** (§2d) |
| 12| `InitGX()` | init.c:66 | compiled-IN | GX reg + FIFO writes, `GXCopyDisp` | **LET-RUN** — emits FIFO, no blocking (§2d) |
| 13| `InitVI()` | init.c:67 | compiled-IN | `VISetNextFrameBuffer`, `VIFlush`, **`VIWaitForRetrace`** ×1–2 | contains a `VIWaitForRetrace` — see §4 |
| 14| `HuFaultInitXfbDirectDraw` / `HuFaultSetXfbAddress` / `HuDvdErrDispInit` | init.c:68-71 | compiled-IN | writes to framebuffers | LET-RUN |
| 15| `frand()` | init.c:72 | compiled-IN | none | LET-RUN |
| 16| `HuMemInitAll()` | init.c:73 | compiled-IN | game heap over arena | LET-RUN once §3 |
| 17| `HuAudInit()` / `HuARInit()` | init.c:74-75 | compiled-IN (calls into AI/AR/DSP imports) | audio/ARAM setup | LET-RUN (import leaves are no-ops) |
| 18| `OSInitFastCast()` | init.c:78 | IMPORT | HID2 SPR | SHIM → no-op |
| 19| `HuCardInit()` | init.c:79 | compiled-IN → CARD imports | memcard | LET-RUN (card is host-boundary) |
| — | return to `main()` | | | | |
| 20| `HuPrcInit()` | main.c:57 | compiled-IN | process system init | LET-RUN |
| 21| `HuPadInit()` | main.c:58 | compiled-IN → PAD imports | input | LET-RUN |
| 22| `GWInit()`,`pfInit()`,`HuSprInit()`,`Hu3DInit()`,`HuDataInit()`,`HuPerf*()`,`WipeInit()` | main.c:59-68 | compiled-IN | game state | LET-RUN |
| 23| `omMasterInit(0,_ovltbl,OVL_COUNT,OVL_BOOT)` | main.c:74 | compiled-IN | object-manager + process setup only; overlay `DVDRead` is deferred to a process run *after* main.c:75 (§4 R5) | LET-RUN |
| 24| **`VIWaitForRetrace()`** | main.c:75 | IMPORT | the target seam | **SHIM = frame pump (§4)** |

**Note:** `InitVI()` (step 13) *also* calls `VIWaitForRetrace()` (`init.c:174,177`) — so the
FIRST `VIWaitForRetrace` reached is inside `InitVI`, well before `main.c:75`. Both are the
same import; the host `VIWaitForRetrace` shim must satisfy both. The GP‑FIFO for a frame is
emitted by `InitGX`/`GXCopyDisp` (step 12) which runs *before* the first
`VIWaitForRetrace` — so the harness's "stop at first `VIWaitForRetrace`, dump FIFO" seam
already brackets a real frame. Reaching `main.c:75` additionally requires steps 16–23 not to
trap.

### 2a. `OSInit` — SHIM (host function)

`OSInit` (`OS.c:200`) is an import. A full re-implementation is unnecessary to reach a frame.
Minimum the host `OSInit` shim must do so the *compiled-in* consumers downstream are happy:

1. **Set arenas** — `OSSetArenaLo(lo)`, `OSSetArenaHi(hi)` with a real in-bounds span (§3).
   (These are compiled-in; the shim can call the exported versions, or the harness writes
   `__OSArenaLo/__OSArenaHi` directly — see §3 for addresses/values.)
2. **Init the thread system** so `VIWaitForRetrace`'s `OSSleepThread` and the retrace
   handler's `OSWakeupThread` have a current thread + run queue. Since `OSThread.c` is an
   import, the *thread primitives themselves are host functions* — the shim owns the thread
   model (§4). No guest `__OSThreadInit` needs to run.
3. Everything else `OSInit` does (exception vectors, SRAM, EXI/SI, audio DMA, memory
   protection, `DVDInquiryAsync`) is **not required** for frame‑0 and is a no-op in the shim.

`OSGetConsoleType()` (import) must **return `OS_CONSOLE_RETAIL1` = `0x10000001`** (or any
value whose low nibble ≠ DEVHW1) so `InitMem` (`init.c:153`) takes the simple `else` heap
branch and does **not** call `LoadMemInfo()` (which would `DVDOpen("/meminfo.bin")` and
recurse into DVD). Returning 0 also works (0 ⇒ ARTHUR ⇒ else branch), and the harness stub
already returns 0.

### 2b. `DVDInit` / `PADInit` — SHIM, no-op is sufficient for frame‑0

Both are imports. Per subagent analysis of the SDK sources (informational — these do not run):
- `DVDInit` (`dvd.c:80`) on the normal bootrom path is all MMIO writes + async queuing, **no
  spin-wait** (the only infinite spin, `fstload.c:51` `while(DVDGetDriveStatus()!=0)`, is on
  the **JTAG-only** `__fstLoad` path, not taken). So a **no-op stub is safe**.
- `PADInit` (`Pad.c:314`) is entirely setup + async SI kickoff, **no blocking spin** on a
  stuck-at-0 status bit. No-op stub is safe.
- Caveat: any later `PADRead`/`DVDRead` the game issues expects data; for frame‑0 the input
  read returns "no buttons" (zeros) and any overlay `DVDRead` must be handled (§4/§23).

### 2c. `VIInit` — SHIM (state-init, not no-op)

`VIInit` (`vi.c:336`) is an import. A pure no-op is **not** sufficient because compiled-in
code and the frame pump depend on VI module state:
- `retraceQueue` (`vi.c:18`) must be an initialized `OSThreadQueue` — `VIWaitForRetrace`
  sleeps on it and the retrace handler wakes it. In the host model this queue is host-owned
  (§4), so the `VIInit` shim just needs to make the host frame-pump's queue exist.
- `retraceCount` starts at 0; `VIGetRetraceCount()` (import) returns it.
- `VIGetTvFormat()` is compiled-in and reads `CurrTvMode` (`vi.c:915`) — a no-op `VIInit`
  leaves `CurrTvMode=0` ⇒ `VI_NTSC`, which is correct for MP4. Acceptable.

Minimum `VIInit` shim: initialize the host retrace queue/count; everything else (register
programming, filter taps, SRAM `displayOffsetH` via `__OSLockSram`) is cosmetic for frame‑0.

### 2d. `GXInit` + `InitGX` — LET-RUN (compiled-in, no blocking) — verified

`GXInit` is defined-internal and **runs in wasm**. Verified (subagent, SDK read) that the
entire GX init chain is **fire-and-forget register/FIFO writes with zero spin-waits**:
- The write-gather-pipe (WGP) at phys `0xCC008000` is an ordinary in-bounds wasm store; the
  `gx_wgpipe_*` shim (`shims/src/gx_wgpipe.c`, redirected from `GX_WRITE_*` in `GXPriv.h`
  per `build_wasm.sh:66-70`) routes it to the software FIFO ring. Writes are harmless.
- `GXInit` calls `__GXFifoInit` (installs CP int handler via the `__OSSetInterruptHandler`
  import — no-op), `GXInitFifoBase`/`GXSetCPUFifo`/`GXSetGPFifo` (PI/CP reg writes),
  `__GXPEInit` (PE control write), `EnableWriteGatherPipe` (PPC SPR writes → no-op in wasm).
  **No CP pointer polling, no `GXDrawDone`, no GP-drain wait.**
- `InitGX` → `GXCopyDisp(DemoCurrentBuffer, GX_TRUE)` (`init.c:127`) writes the EFB-copy
  trigger to the FIFO and **returns immediately — it does NOT wait for copy completion**
  (`GXFrameBuf.c` `GXCopyDisp`). So no PE-finish spin.
- `IsWriteGatherBufferEmpty()` is shimmed to `return 1` (`build_wasm.sh:76`), so any
  "WGP empty?" check that did exist can't spin.

⇒ **No staging or shim needed for GX beyond the WGP redirect that already exists.** GX is the
part that produces the frame‑0 FIFO the harness validates.

---

## 3. OS-globals + arena staging spec (the concrete fix for the current trap)

Under the identity map, guest `0x80000000` == wasm linear-memory offset `0x80000000`
(harness grows memory to 2072 MB so it is in-bounds; `recomp_run.mjs:50-57`). The harness
already stages an `OSBootInfo` there (`recomp_run.mjs:59-66`). What is **missing** is the
**arena globals**, which live in *module data* (statics), not at `0x80000000`, and which the
stubbed `OSInit` never sets.

### 3.1 What must be true before `InitMem` (init.c:59) runs

| Global | Where it lives | Current value | Must be set to |
|---|---|---|---|
| `__OSArenaLo` | OSArena.c:7 static (module data) | `(void*)-1` (0xFFFFFFFF) | a real in-bounds base, e.g. **`0x80100000`** |
| `__OSArenaHi` | OSArena.c:6 static (module data) | `0` | above memSize top, e.g. **`0x81000000`** (24 MB guest: `0x80000000+0x01800000` = `0x81800000`; pick hi ≤ that and ≥ lo+heap) |

Constraints from the consumers:
- `OSInitAlloc(lo,hi,1)` (`OSAlloc.c:327`) asserts `lo < hi` (`OSAlloc.c:334`) and
  `1 <= (hi-lo)/24` (`OSAlloc.c:335`); it writes a `HeapDesc` array at `lo` then returns a
  bumped `lo`. So `hi-lo` must be at least a few hundred bytes; give it MBs.
- `OSCreateHeap(lo,hi)` (`OSAlloc.c:354`) builds a free cell spanning `[lo,hi)`; must be
  in-bounds and 32-B aligned (InitMem already rounds).
- `OSAlloc(0x100000)` (`init.c:64`) then pulls the 1 MB GX FIFO from that heap — so
  `hi-lo` must exceed `0x100000` + framebuffers (2×`fb_size`, `fb_size` ≈ 640×480×2 ≈
  `0x96000`) + game heaps (`HuMemInitAll`). **Recommend a ≥ 8 MB arena span**, e.g.
  `lo=0x80100000`, `hi=0x81000000` (15 MB) — comfortably inside the 24 MB guest RAM window
  and inside the 2 GB wasm memory.

### 3.2 How to set them (two options — implementer picks)

- **Option A (host `OSInit` shim, preferred):** the host `OSInit` calls the compiled-in
  `OSSetArenaLo(0x80100000)` / `OSSetArenaHi(0x81000000)`. This requires those two exports;
  add `-Wl,--export=OSSetArenaLo -Wl,--export=OSSetArenaHi` in `build_wasm.sh` (link step,
  line 218) OR have the shim import nothing and instead write the statics directly (harder —
  statics aren't at a fixed guest address).
- **Option B (harness/host writes the statics directly):** locate `__OSArenaLo`/`__OSArenaHi`
  in the module's data segment and poke them. Fragile (addresses shift per build). Prefer A.

Simplest robust path: **export `OSSetArenaLo`/`OSSetArenaHi`** and have the host `OSInit`
shim call them with the constants above, then the current `InitMem` trap is gone and control
proceeds to `GXInit`.

### 3.3 Low-memory OS variables (0x800000xx) — what `OSInit` reads, and whether we care

`OSInit` (the import — does NOT run) reads these; listed for completeness of the future
`OSInit` shim, but **none block the compiled-in path today** because `OSInit` is stubbed:

| Addr | Symbol | Read at | Frame‑0 relevance |
|---|---|---|---|
| `0x80000000` | `OSBootInfo*` (arenaLo/Hi/consoleType/memorySize) | OS.c:228,243-289,338 | staged by harness already; only matters if `OSInit` shim reads it |
| `0x800000F4` | `OS_BI2_DEBUG_ADDRESS` (BI2Debug ptr) | OS.c:234 | leave **0** ⇒ `DebugInfo==NULL`, skip debug path |
| `0x800030E8` | `DEBUGFLAG_ADDR` | OS.c:240,244 | irrelevant while OSInit stubbed |
| `0x800030E9` | `OS_DEBUG_ADDRESS_2` (padSpec) | OS.c:241,246 | irrelevant |
| `0x000000D4` | `__OSCurrentContext` | OSContext.c:7 (`OS_BASE_CACHED|0xD4` = `0x800000D4`) | context is host-owned (§4) |
| `0x000000E4` | `__OSCurrentThread` | OSThread.c:14 (`=0x800000E4`) | thread is host-owned (§4) |
| `0x000000DC` | `__OSActiveThreadQueue` | OSThread.c:15 | host-owned (§4) |
| `__PIRegs[11]` | PI MMIO `0xCC003000+…` | OS.c:289 | reads 0 ⇒ consoleType low nibble 0; fine |

Because the whole OS thread/context/interrupt layer is an import set, **frame‑0 needs only
§3.1 (arena) staged**; the `0x800000xx` OS-globals are relevant only when/if a *real*
`OSInit`/thread port is written, not for the minimal frame.

---

## 4. Risk list — functions that BLOCK (infinite spin) ⇒ MUST be shimmed, not staged

The defining hazard: a `do/while`/`while` whose exit depends on a hardware event that never
occurs in wasm (an MMIO status bit or, critically, an **interrupt that never fires**).

### R1 — `VIWaitForRetrace` **(the target seam) — HARD BLOCKER, must be a host frame-pump**

`vi.c:421-432`:
```
startCount = retraceCount;
do { OSSleepThread(&retraceQueue); } while (startCount == retraceCount);
```
`retraceCount` is incremented **only** by `__VIRetraceHandler` (`vi.c:154`), which runs
**only on VI interrupt #24**. In wasm there is no VI interrupt ⇒ `retraceCount` never
changes ⇒ **infinite sleep**. This is *the* structural blocker of the whole boot.
- Since `VIWaitForRetrace`, `OSSleepThread`, `OSWakeupThread`, and the retrace handler are
  **all imports** (OSThread.c/vi.c don't compile), the host **owns** this entire mechanism.
- **Shim behavior:** the host `VIWaitForRetrace` must, on each call, (a) treat it as a frame
  boundary: flush/hand off the accumulated GP-FIFO to the renderer + present, (b) bump the
  host retrace counter (so `VIGetRetraceCount` advances), and (c) return — cooperatively
  yielding rather than sleeping on a never-signalled queue. For the *headless harness* it is
  already stubbed to increment and, on the first call, throw `{__frame0}` to stop and dump
  the FIFO (`recomp_run.mjs:31-36`). For the real host it becomes the present/pump.
- This is why the deliverable target is defined as "first `VIWaitForRetrace`": it is exactly
  the point the host must convert a hardware-vsync wait into a cooperative frame pump.

### R2 — `InitVI`'s `VIWaitForRetrace` — same blocker, hit FIRST (init.c:174,177)

`InitVI` (`init.c:168`) calls `VIWaitForRetrace` once (and twice if interlaced;
`RenderMode->viTVmode & 1`). This is reached at **step 13**, before `main.c:75`. Same shim
(R1) satisfies it. NTSC 480i (`GXNtsc480IntDf`) is interlaced ⇒ **two** waits here.

### R3 — SI transfer-complete spins — LET-RUN (exit immediately with MMIO=0)

`SIInit` (`SIBios.c:311`) and `SISync` (`SIBios.c:374`) do `while (__SIRegs[13] & 1);`.
With MMIO reading 0, bit 0 is 0 ⇒ loop **exits immediately**. **Not a blocker.** (These are
in import units anyway; noted so they aren't mistaken for hazards if SI is later compiled in.)

### R4 — DVD drive-status spin — NOT on MP4's path (JTAG-only)

`fstload.c:51` `while (DVDGetDriveStatus()!=0);` waits on a DI interrupt. Only reached via
`__fstLoad` on **JTAG** boot (`bootInfo->magic == OS_BOOTINFO_MAGIC_JTAG`). MP4 boots normal
bootrom ⇒ not taken. `DVDInit` is an import/no-op anyway. **Not a blocker for MP4.**

### R5 — `omMasterInit` overlay load (main.c:74) — NOT a frame‑0 blocker (verified)

Read `omMasterInit` (`objmain.c:55-65`): it does **not** `DVDRead` synchronously. It calls
`omDLLInit(ovl_list)`, creates a **process** `HuPrcCreate(omWatchOverlayProc,…)`
(`objmain.c:58`), and `omOvlCallEx(start_ovl,…)` (`objmain.c:62`) which only *queues* the
overlay request (`omnextovl`). The real overlay `DVDRead` happens inside
`omWatchOverlayProc` (`objmain.c:67-107`), which is a cooperative **process** dispatched by
`HuPrcCall(1)` in the **main loop body** (`main.c:99`) — i.e. **after** `main.c:75`. So
`main.c:75`'s `VIWaitForRetrace` is reachable **without** servicing any overlay DVD read;
`omMasterInit` itself is LET-RUN (memory/process setup only, `OSReport` imports are no-ops).
- **Deferred (not for the first frame, but for the first *loop iteration*):** once the main
  loop runs `HuPrcCall(1)`, `omWatchOverlayProc` → `omDLLStart` → overlay `DVDRead` needs a
  synchronous host `DVDRead` that copies from the ROM image and signals done inline (else it
  would spin like R1/R4). Flagged for the NEXT milestone (steady-state), not for reaching the
  first `VIWaitForRetrace`. (`kerent.c`, the `_kerjmp` overlay dispatcher, is a *skipped*
  unit ⇒ already a host boundary.)

### R6 — Idle-thread busy-wait in the scheduler — host-owned (not reached today)

`OSThread.c:284` `while (RunQueueBits == 0);` (in `SelectThread`) is the SDK idle spin. In
the host thread model this is replaced by the cooperative pump (R1); it never runs because
OSThread.c is an import. Noted so a future *real* thread port doesn't reintroduce it.

### Non-blockers confirmed (LET-RUN)
`GXInit`/`InitGX`/`GXCopyDisp` (§2d, no waits), `InitMem` (once §3), `OSAlloc`/`OSInitAlloc`/
`OSCreateHeap` (pure memory once arena valid), `InitRenderMode` (mode!=NULL early return),
`OSGetProgressiveMode` (reads a global, returns 0).

---

## 5. Minimal work list to reach the target (ordered)

1. **Stage the arena (§3.1/3.2).** Export `OSSetArenaLo`/`OSSetArenaHi`; host `OSInit` shim
   calls them with `lo=0x80100000`, `hi=0x81000000`. **This alone clears the current
   `InitMem` OOB trap** and lets `GXInit`/`InitGX` run and emit the frame‑0 FIFO.
2. **`OSGetConsoleType` stub → 0** (retail/else heap branch; avoid `LoadMemInfo`/DVD). Already
   satisfied by the harness's default-0 stub; make it explicit in the real host.
3. **`VIInit` shim (§2c):** create the host retrace queue + zero counter so the pump has
   state. `VIGetRetraceCount`→host counter; `VIGetTvFormat`(compiled-in) already returns NTSC.
4. **`VIWaitForRetrace` shim = frame pump (R1/R2):** on call, hand the GP-FIFO to the
   renderer + present, bump the counter, return (cooperative). Headless harness already stops
   at the first call and validates the FIFO. This is the seam that *defines* the target.
5. **`DVDInit`/`PADInit` = no-op stubs (§2b).** Safe.
6. **`omMasterInit` is LET-RUN for frame‑0 (R5, verified)** — no DVD read needed to reach
   `main.c:75`. Its overlay `DVDRead` fires later inside `HuPrcCall(1)` (main loop); a
   synchronous host `DVDRead` from the ROM image is the FOLLOW-ON milestone (first loop
   iteration), not required for the first `VIWaitForRetrace`.
7. **Thread primitives (`OSSleepThread`/`OSWakeupThread`/`OSCreateThread`/`OSDisableInterrupts`
   …)** become thin host functions consistent with the cooperative pump; for frame‑0 only
   `OSDisableInterrupts`/`OSRestoreInterrupts` (already no-op stubs returning 0) and the
   `VIWaitForRetrace` pump matter. A full thread scheduler is **not** required to reach the
   first frame.

**Definition of done:** `node recomp_run.mjs` prints
`reached FIRST VIWaitForRetrace, fifo_pos=N` with N>0 and a FIFO decode showing cp/xf/bp/draw
opcodes — i.e. steps 1–13 run and `InitGX` emitted a real frame — with, as a stretch, steps
16–23 also clearing so `main.c:75` is the reached call rather than `init.c:174`.
