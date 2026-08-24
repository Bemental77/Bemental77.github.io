# REL / Endianness Plan — reaching the bootDll LOGO frame (emcc-direct native port)

Synthesis of four parallel investigations (A: REL/overlay dispatch + AOT; B: OSLink + REL
format; C: endianness surface; D: what bootDll needs), reconciled against first-hand reads of
the git-clean tree on 2026-08-22. Every claim is cited `file:line` or explicitly hedged.

**Scope**: produce a grounded feasibility verdict + ordered implementation plan to reach the
**bootDll Nintendo-logo frame** (first real draw). NOT to implement.

---

## 0. Ground-truth corrections (verified this session — the investigations disagreed)

Three premises in the task prompt and in the investigations were checked against the live tree
and corrected. These change the plan, so they lead the document.

1. **The live harness is `recomp_run.mjs`, NOT `fiber_probe.mjs`.** `ls gamecube/recomp/`
   confirms `recomp_run.mjs` exists (10034 bytes, 2026-08-22) and there is **no `fiber_probe.mjs`**
   anywhere in the tree. `recomp_run.mjs:1-8` describes itself as the "ASYNCIFY / fiber build"
   Node harness. It DOES have fiber support (drops `-sSTANDALONE_WASM`, uses
   `emscripten_fiber_swap`, `recomp_run.mjs:2`) and DOES stage the arena
   (`recomp_run.mjs:51-59`), matching the task's "fiber scheduler works" claim. But per
   `recomp_run.mjs:49-81` (`makeStub`), it does **NOT** stage an ISO FST or serve real DVD reads
   — every host import except a small hand-listed set (`OSInit`, `OSGetTime`, `OSReport`,
   `VIWaitForRetrace`, …) is a **no-op returning 0** (`recomp_run.mjs:80`). Investigation B's
   "the ISO-serving harness in the task premise is not in the tree" is **correct**.
   *Consequence*: the plan must add a DVD-serving stub (§2 step 6) — it is a prerequisite, not
   an afterthought.

2. **OSLink is a no-op HOST IMPORT, not compiled-in — the "OSLink relocation spin" premise is
   FALSE for the clean tree.** `OSLink.c` fails to compile under emcc: confirmed in
   `/tmp/gc_recomp_build/fails.txt` (`OSLink.c: expected ';' after top level declarator`), caused
   by the Metrowerks absolute-address extern syntax at `~/gc_refs/marioparty4/src/dolphin/os/OSLink.c:77`
   (`OSModuleQueue __OSModuleInfoList : (OS_BASE_CACHED | 0x30C8);`) — verified by reading that
   line. `wasm-objdump -x /tmp/gc_recomp_build/mp4_game.wasm` shows `func[99] <env.OSLink> <-
   env.OSLink` — i.e. OSLink is an **undefined import**, stubbed to a no-op returning 0 by the
   harness (`recomp_run.mjs:80`). So `OSLink(...)` at `objdll.c:100` returns FALSE, prints
   "DLL Link Failed" (`objdll.c:101`), and the relocation loop **never runs**. Investigation B is
   correct; investigation A's "the current spin is OSLink's big-endian Relocate()" is **wrong**.
   (Tooling note for future readers: `wasm-objdump -j Import` printed 0 imports here — a
   section-name quirk; use `wasm-objdump -x … | grep '<- env.'` to enumerate imports reliably.)

3. **The actual overlay call-site line numbers differ from investigation A's.** Verified by
   reading `~/gc_refs/marioparty4/src/game/objdll.c`:
   - fresh-link path: `OSLink(...)` is at **objdll.c:100**; the prolog call
     `dll->ret = ((DLLProlog)dll->module->prolog)()` is at **objdll.c:112** (inside `omDLLLink`,
     under `if(flag == 1)`). Investigation A said :100/:108 — the :108 is off by 4.
   - already-loaded path: the prolog call `dll->ret = ((DLLProlog)dll->module->prolog)()` is at
     **objdll.c:41** (inside `omDLLStart`, `dllno>=0 && !flag`). Investigation A said :40.
   - epilog calls: `((DLLEpilog)dll->module->epilog)()` at **objdll.c:87** (`omDLLEnd`) and
     **objdll.c:119** (`omDLLUnlink`).
   Use the verified numbers below, not the investigation's.

Everything else in the four investigations that this session spot-checked held up: objdll.c /
objmain.c / dvd.c / sprman.c all compiled (objects present in `/tmp/gc_recomp_build/obj/`);
`src/REL/*` is skipped at `build_wasm.sh:274`; the sprman.c "already-relocated" sentinel is
`(u32)anim->bank & 0xFFFF0000` at `sprman.c:217`; HuDecodeData dispatches by `decode_type`
(`decode.c:183-207`) and NintendoDataDecode reads the header via native `*src++` at
`~/gc_refs/marioparty4/src/REL/bootDll/main.c:780,782`.

---

## 1. FEASIBILITY VERDICT

**Reachable: YES — a rendered bootDll Nintendo-logo frame is achievable with the emcc-direct
native-port approach, via the AOT-overlay strategy, with a SMALL per-format endianness fix set
(not a pervasive load/store layer).** Confidence: medium-high on the CPU/link path (grounded in
code reads + verified build state); the single largest unverified gate is the GX-FIFO→canvas
present bridge (§3, R1), which no investigation ran end-to-end.

Strategy selection, each with its deciding evidence:

- **AOT-compile the 3 bootDll units + static dispatch — CHOSEN over runtime OSLink+byte-swap.**
  Deciding facts: (a) OSLink doesn't even compile (`fails.txt`, `OSLink.c:77`), so the
  runtime-link path is dead work unless resurrected; (b) even a byte-swap-correct OSLink would
  relocate **PowerPC** opcodes that cannot execute in wasm — the RELs are PPC machine code and
  `src/REL/*` is not in the module (`build_wasm.sh:274`); (c) the RELs have full C source and
  bind to DOL functions **by plain symbol name** — investigation A resolved all 78
  `R_PPC_REL24` targets in the built `bootDll.rel` module-0 against `nm main.elf` to real DOL
  functions (omInitObjMan, Hu3DCameraCreate, HuPrcCreate, …), with **0 landing in the `_kerent`
  trampoline range and 0 unresolved**. So wasm-ld can resolve bootDll's imports against the
  already-compiled DOL exactly as dtk did against `main.elf`. AOT sidesteps OSLink AND the REL
  big-endian relocation format entirely.

- **kerent.c stays SKIPPED — no jump-table rewire.** The `_kerjmp_*` / `asm void _kerent(void)`
  table is entirely `#ifdef __MWERKS__` (per investigation A, `kerent.c:2043-2044`) → a no-op
  under clang, which is why `build_wasm.sh:274` correctly skips it. Under AOT the REL's C calls
  DOL symbols by name and wasm-ld binds them directly — the PPC trampoline is bypassed. (Hedge:
  I did not personally re-read kerent.c this session; this rests on investigation A + D's reads.)

- **Endianness: PER-FORMAT, not pervasive.** For the Nintendo-logo frame the surface is **tiny**
  and asset-local:
  - Nintendo logo is a **compiled-in** asset (`#include "nintendoData.inc"` at
    `bootDll/main.c:775`), decoded by the **endian-safe** HuDecodeData (`decode.c:176` — dispatches
    to HuDecodeLz/Slide/etc., which per investigations C+D reassemble multi-byte fields with
    explicit big-endian shifts, so decoded payload bytes are LE-identical). **No DVD read** for the
    logo sprite.
  - Only TWO native-read sites are LE-wrong on the logo path: (1) NintendoDataDecode's 2-field
    header read (`bootDll/main.c:780,782`, `u32 size = *src++` / `int decode_type = *src++` over
    the big-endian .inc header); (2) HuSprAnimRead's AnimData-tree pointer/count relocation
    (`sprman.c:209-238`). Both are bounded, known-layout swaps.
  - The GX **texel** bytes (`bmp->data`/`bmp->palData`) pass through GXInitTexObj/GXInitTlutObj
    untouched to the renderer backend (investigation C, `sprput.c:194-242`) — no C-side swap.
  A pervasive byte-swapping load/store layer is NOT required to reach first draw. The large HSF
  model-endianness surface (`hsfman.c` ~17 native-count sites) is **deferred** — the 3D title
  models are only created later in BootTitleCreate/BootTitleExec (investigation D,
  `bootDll/main.c:531-540`), past the logo.

**Where the spin actually is now (unresolved, hedged).** With OSLink a no-op, the current hang
is downstream of `objdll.c:100`. Two candidates, neither single-stepped this session:
(i) the garbage prolog call at `objdll.c:112` — `dll->module->prolog` is a big-endian field read
natively → garbage fn-ptr → `call_indirect` into garbage; (ii) a DVD-completion spin at
`dvd.c:54` `while(!CallBackStatus)` if `HuDvdDataReadDirect`'s async read never completes under a
no-op `DVDReadAsync` stub. The AOT strategy makes candidate (i) moot (we never dereference the
disc module->prolog) and step 6 fixes candidate (ii). **Confirming which fires is the cheapest
first action (§3, R4).**

---

## 2. CONCRETE ORDERED IMPLEMENTATION PLAN (dependency order)

Each step lists the exact file:line anchors and an effort tag (small / medium / large). All
builds/probes go through the canonical `build_wasm.sh` → `recomp_run.mjs` loop (no improvised
emcc; gate #4), on a CLEAN build (gate #8).

### Step 0 — Localize the live spin BEFORE changing anything *(small; de-risks the whole plan)*
Confirm which candidate (garbage-prolog `objdll.c:112` vs DVD-wait `dvd.c:54`) fires, so the
plan targets the real blocker. Add a gated `OSReport` marker (the build already has a
`RECOMP_MARKERS` diag path — investigation B cited `build_wasm.sh:98`; verify that anchor before
relying on it) at `objdll.c:100`, `:112`, and `dvd.c:54`, run `recomp_run.mjs`, read which marker
is last. Remove the markers before any perf/correctness measurement (gate #8). **This is the
canonical first action** — everything below assumes the AOT path removes the blocker, which step 0
confirms.

### Step 1 — Narrow the REL skip so ONLY bootDll's 3 units compile in *(medium)*
`build_wasm.sh:274`:
```
skip_unit() { case "$1" in */dolphin/mtx/*|*/game/kerent.c|*/src/REL/*|*/dolphin/card/*) return 0;; esac; return 1; }
```
Change the blanket `*/src/REL/*` to skip **all RELs except** `src/REL/bootDll/main.c`,
`src/REL/bootDll/language.c`, and `src/REL/executor.c` (the shared `_prolog`/`_epilog`). Do **NOT**
un-skip the other ~90 RELs: several share auto-generated `fn_1_XXXX` symbols that collide when
flat-linked — documented in `build_wasm.sh:266-273` and re-confirmed by investigation A
(`ls -d src/REL/*/` = 93 dirs). The 3-unit set is the minimal bootDll link, per
`build.ninja:9834-9842` (bootDll.preplf = executor.o + bootDll/main.o) and `configure.py:1022-1027`
(bootDll = main.c + language.c) as cited by investigation A. Also update the **parallel** skip
filter in the sig-reconciliation python at `build_wasm.sh:191` — verified this session it reads
`"/REL/" not in f` (the exact clause is in the `cfiles` list-comprehension) — so bootDll units
participate in signature reconciliation like the DOL units.
*Verify*: `ls /tmp/gc_recomp_build/obj | grep -i bootDll` returns 3 objects (currently 0 —
confirmed `grep -iE "objdll|objmain" ...` showed DOL objects but no bootDll object this session).
*Risk*: symbol collisions if the narrowing is too loose — include ONLY the 3 units.

### Step 2 — Confirm bootDll's imports resolve by name against the DOL *(small; a trial link)*
After step 1 builds, read `/tmp/gc_recomp_build/link.txt` (the wasm-ld log — verified this
session it lists `warning: undefined symbol: …` for genuine host boundaries like AIInitDMA,
CARDCheck). Success = **no NEW undefined symbols** introduced by bootDll beyond the existing host
set, and specifically **no `_kerjmp_*` undefined imports** (investigation A/B: REL→DOL calls bind
by name). Investigation A verified all 78 bootDll DOL imports exist as DOL functions against
`main.elf`, but a **live wasm-ld link** is the cheap confirm (investigation A flagged this as
inferred, not link-verified). `SystemInitF` is a DOL global written at `main.c:51` (per
investigation A) so bootDll's `extern SystemInitF` (`bootDll/main.c`) resolves against the DOL —
no host stub.

### Step 3 — Rewire omDLLLink / omDLLStart to dispatch AOT overlays directly *(medium)*
Replace the disc-load + OSLink + disc-prolog indirection with a static overlay-id→prolog table
for OVL_BOOT. Exact sites (verified this session):
- **`objdll.c:90` omDLLLink** — for OVL_BOOT, short-circuit before `objdll.c:98`
  (`HuDvdDataReadDirect(dllFile->name, …)`), `:99` (`HuMemDirectMalloc(HEAP_SYSTEM,
  dll->module->bssSize)` — do NOT read bssSize from an absent REL header), and `:100`
  (`OSLink(...)`). Set `dll->ret` from a direct call to the compiled-in `_prolog`
  (`executor.c:3`, which runs .ctors then calls ObjectSetup — investigation A) instead of the
  `objdll.c:112` `((DLLProlog)dll->module->prolog)()` dereference.
- **`objdll.c:41` omDLLStart** (already-loaded path) — mirror the same dispatch (the second
  `((DLLProlog)dll->module->prolog)()`).
- **Epilog** sites `objdll.c:87` and `objdll.c:119` mirror this if/when an overlay is torn down
  — NOT needed for the logo (bootDll is not unloaded before the logo draws).
Implementation shape: a small C table keyed OverlayID→{prolog,epilog} that these sites consult;
fall back to the existing OSLink path for non-AOT overlays. For bootDll the prolog target is
`_prolog` (`executor.c:3`), which calls `ObjectSetup` (`bootDll/main.c:57`, verified this
session — `void ObjectSetup(void)` printing "Boot ObjectSetup", creating cameras + HuPrcCreate(
BootExec, …) at `bootDll/main.c:72`).
*bss*: bootDll.rel bssSize is small (investigation B: 0x5c, big-endian header); under AOT the
compiled overlay's .bss is a normal wasm data segment, so the `objdll.c:99` malloc + the memset
at `objdll.c:38`/`:99` become no-ops or a tiny static clear. Do NOT read the (absent) REL header.

### Step 4 — Fix NintendoDataDecode's big-endian header read *(small)*
`~/gc_refs/marioparty4/src/REL/bootDll/main.c:780,782` (verified this session):
```
u32 size = *src++;            // native LE read of a BE u32 header
int decode_type = *src++;     // native LE read of a BE u32
```
Replace with a byte-wise big-endian assemble (mirror the `*data++<<24 | <<16 | <<8 | …` pattern
investigation C cited from `data.c:587-594`). Investigation C decoded the .inc header bytes
`00 04 38 C0 | 00 00 00 01` → BE gives size=0x000438C0 (276160) + decode_type=1
(DATA_DECODE_LZ); native LE gives size≈3.2 GB (malloc-fatal) + decode_type 0x01000000 (hits the
`default: decode tyep unknown` branch at `decode.c:207`, verified this session). 2-field fix.
Apply as a shim edit under `gamecube/recomp/shims/` or a perl bake in `build_wasm.sh` (the build
already carries verified compile-fix bakes — MEMORY: "8 verified compile-fix perl bakes"), not by
editing `~/gc_refs` in place.
*Verify*: after the fix, HuMemDirectMalloc requests 276160 bytes (not 3.2 GB) and HuDecodeLz
runs instead of "decode tyep unknown" — a cheap log check.

### Step 5 — Byte-swap the AnimData tree in HuSprAnimRead *(medium)*
`~/gc_refs/marioparty4/src/game/sprman.c:209-238` (verified this session). Add a one-time swap
pass that runs BEFORE the pointer relocations at `sprman.c:221-236`, gated by the existing
already-relocated sentinel `(u32)anim->bank & 0xFFFF0000` at `sprman.c:217` (verified — this test
distinguishes first-load from an already-relocated tree). Swap, per the AnimData/Bank/Pat/Bmp
layouts investigation C read from `animdata.h:25-81`:
- AnimData: `bankNum`/`patNum`/`bmpNum` (s16) + `bank`/`pat`/`bmp` (u32 offsets).
- then walk the same `bankNum`/`patNum`/`bmpNum` loops (mirroring `sprman.c:227-236`) swapping
  each bank->frame / pat->layer / bmp->palData / bmp->data offset, plus the frame/layer/bmp
  fields the draw path reads (`sprput.c:117-242`, investigation C).
*Caution (investigation C risk 1)*: the swap scope is "the AnimData tree" but investigation C
only confirmed the specific fields at `sprman.c:209-239` + `sprput.c:117-242`, not every
consumer (e.g. SpriteCalcFrame/HuSprExec animation-advance may read AnimFrameData fields). A
probe run of the actual on-screen logo is required to close this (§3, R2 de-risk).
*Caution (investigation C risk 2)*: use a **dedicated one-shot flag**, not reuse of `useNum`, so
the swap never double-applies if the raw blob is re-read. Do NOT touch `decode.c` (endian-safe)
or the GX texel path (backend decodes BE-tiled formats).

### Step 6 — Serve DVD reads + drive VIWaitForRetrace so the frame pump runs *(medium)*
Two harness changes in `recomp_run.mjs`:
- **DVD-completion**: the current catch-all no-op (`recomp_run.mjs:80`) leaves any
  `HuDvdDataReadDirect`/`DVDReadAsync` path spinning at `dvd.c:54` (investigation B). For the
  Nintendo logo specifically NO DVD read is needed (compiled-in .inc), so a minimal logo build
  can leave DVD stubbed **if step 0 confirms the spin is the prolog call, not the DVD wait**. If
  step 0 shows the DVD wait fires (e.g. bootDll's ObjectSetup or an earlier init reads a file
  before the logo), add a synchronous DVD stub that copies bytes from the ISO/FST and invokes the
  callback so `CallBackStatus` is set (`dvd.c:23` per investigation B). The ISO/FST staging code
  does NOT exist in `recomp_run.mjs` today (verified — `makeStub` has no ISO code) and is the
  larger sub-task if needed.
- **Frame pump**: `recomp_run.mjs:66-79` already increments `viRetrace` and captures the GP-FIFO
  on `VIWaitForRetrace`, with a `PUMP` mode (`recomp_run.mjs:17-18,70-75`) that resets the ring
  per frame and stops at `PUMP_MAX`. Run with `PUMP=1 PUMP_MAX=<enough-for-the-wipe>` so the
  fiber scheduler advances BootExec through its `HuPrcVSleep` loop (`bootDll/main.c:155-157`)
  past the DISPOFF→`HuSprAttrReset`→`WipeCreate(WIPE_MODE_IN)` reveal (`bootDll/main.c:153-154`,
  verified `HuSprAttrReset(group,0,HUSPR_ATTR_DISPOFF)` + `WipeCreate(WIPE_MODE_IN,…)` at
  `main.c:153-154`).

### Step 7 — Present a frame to the canvas *(large; the biggest unknown)*
The DOL's per-frame loop (`main.c:80-116`, verified this session: `HuSysBeforeRender` →
`Hu3DPreProc` → `HuPrcCall(1)` → `Hu3DExec` → `WipeExecAlways` → `HuSysDoneRender`) emits GX
commands into the GP-FIFO ring, which the build exports (`gx_fifo_base`/`gx_fifo_pos`/
`gx_fifo_reset`, referenced in `recomp_run.mjs:69-73,170-174` and the FIFO-export comment near
`build_wasm.sh:303-306` per MEMORY). `recomp_run.mjs` + `fifo_decode.mjs` already decode the FIFO
for DRAW primitives (`recomp_run.mjs:151-165`). To get pixels on a canvas the FIFO must be
replayed to WebGPU (the substantial unbuilt host layer per MEMORY:
`gc_wasm_recomp_decomp_native_port_2026_08_21`, "REMAINING = THE HOST LAYER"). **Milestone gate**:
success at the logo = `fifo_decode` reports `draw>0` for a frame AND (once the WebGPU replay
exists) the canvas shows non-black Nintendo-logo pixels. Node-only success signal = `draw>0` +
GXCopyDisp fired; on-canvas verification needs `recomp_render_test.html`
(`gamecube/recomp/recomp_render_test.html` exists, 4687 bytes) wired to the FIFO replay.

**Dependency graph**: 0 → {1 → 2 → 3} (link path) and {4, 5} (endianness, parallel to 3) all
precede 6 → 7. Step 0 gates everything (confirms the blocker); steps 4/5 are independent of the
AOT wiring and can be done in parallel with 1–3.

---

## 3. BIGGEST RISKS + cheapest de-risk

- **R1 — GX-FIFO → WebGPU present bridge may not actually paint pixels (HIGHEST risk).** Every
  investigation flagged this as out-of-scope-but-on-critical-path (D risk 4; MEMORY: "the real
  gating risk for ANY visible frame"). No investigation ran it end-to-end. *Cheapest de-risk*:
  before touching bootDll at all, drive the EXISTING DOL frame loop (`main.c:80-116`) with a
  non-black `Hu3DBGColorSet`/`GXSetCopyClear` and confirm `fifo_decode` reports register+draw
  traffic and the WebGPU replay paints a solid color (investigation D "Milestone 0", asset-free).
  If a solid clear can't reach the canvas, no logo can — fix the bridge first.

- **R2 — the AnimData swap set (step 5) may be incomplete** (investigation C risk 1: didn't audit
  every AnimFrameData consumer). *Cheapest de-risk*: after steps 4+5, run the logo and eyeball —
  a partially-swapped tree produces a garbled/mispositioned sprite (visible failure), not a silent
  wrong answer. Iterate field-by-field against `animdata.h` until the logo is clean.

- **R3 — symbol collision / link breakage if the REL skip narrowing is too loose** (A/B). *Cheapest
  de-risk*: strictly the 3 bootDll units in step 1; verify `link.txt` gains no new duplicate-symbol
  errors and `ls obj | grep bootDll` = exactly 3 (step 2).

- **R4 — the live spin is unconfirmed** (B: not single-stepped; garbage-prolog vs DVD-wait).
  *Cheapest de-risk*: step 0 — three `OSReport` markers, one clean run. Do this FIRST.

- **R5 — the fiber scheduler may not advance BootExec far enough within a bounded probe**
  (D risk 5). *Cheapest de-risk*: step 6's `PUMP_MAX` is tunable; bisect the frame count needed to
  cross the DISPOFF→reveal at `bootDll/main.c:153-154`, reading `viRetrace` from the harness output.

- **R6 — DVD staging is larger than the logo needs** (B). *Cheapest de-risk*: step 0 tells you
  whether ANY DVD read is on the pre-logo path; if not, skip the ISO/FST staging entirely for the
  logo milestone.

---

## 4. EFFORT CHARACTERIZATION (no time estimates)

| Step | What | Effort |
|---|---|---|
| 0 | Localize live spin (3 OSReport markers) | small |
| 1 | Narrow REL skip to bootDll's 3 units (`build_wasm.sh:274` + `:191`) | medium |
| 2 | Trial link — confirm imports resolve by name (`link.txt`) | small |
| 3 | AOT overlay dispatch table + rewire `objdll.c:41,90,100,112` | medium |
| 4 | NintendoDataDecode BE header (`bootDll/main.c:780,782`) | small |
| 5 | HuSprAnimRead AnimData-tree swap (`sprman.c:209-238`) | medium |
| 6 | DVD-serving stub (if needed) + PUMP frame drive (`recomp_run.mjs`) | medium (small if no DVD on logo path) |
| 7 | GP-FIFO → WebGPU present bridge to on-canvas pixels | large |

**Overall**: the CPU/link path (0–5) is small-to-medium and well-anchored — the AOT strategy
cleanly deletes OSLink + REL-relocation endianness, and the logo's endianness surface is two
bounded swaps. The dominant remaining effort is **step 7** (the WebGPU present host layer, already
flagged in MEMORY as "the substantial work"). The honest verdict: reaching the logo is gated less
by REL/endianness (now understood and small) and more by whether the FIFO→canvas bridge paints —
de-risk R1 before investing in the bootDll wiring.

---

*Anchors verified first-hand this session*: `recomp_run.mjs:1-8,17-18,49-81,66-79,151-174`;
`build_wasm.sh:191,274`; `/tmp/gc_recomp_build/fails.txt` (`OSLink.c` fail); `wasm-objdump -x
/tmp/gc_recomp_build/mp4_game.wasm` (`func[99] <env.OSLink> <- env.OSLink`);
`~/gc_refs/marioparty4/src/dolphin/os/OSLink.c:77`; `src/game/objdll.c:27-120` (call sites
:41,:87,:90,:100,:112,:119); `src/game/objmain.c:55-107`; `src/game/main.c:74,80-116`;
`src/REL/bootDll/main.c:57,72,115-160,775-787`; `src/game/decode.c:176-207`;
`src/game/sprman.c:209-240`. *Anchors taken on investigation trust (not re-read this session)*:
the 78-reloc `nm main.elf` resolution (A); `kerent.c:2043-2044` MWERKS gating (A/D); `animdata.h`
struct offsets (C); `build.ninja`/`configure.py` bootDll unit set (A); `dvd.c:23,54` callback/spin
(B); `hsfman.c` HSF endianness sites (C/D). Those are flagged for a trial-link / probe confirm in
the steps above.
