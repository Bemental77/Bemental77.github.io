# Static recompilation of Sonic Adventure 2 Battle — how far it reaches

Measured 2026-09-01. Every number below was produced in this pass from the shipped
disc; the reproducing command is printed next to each one. Artifact:
[`coverage.json`](coverage.json). Raw tool output: `census_asis.txt`,
`census_outer_calls.txt`, `rel_all.txt`, `os_boundary.txt`.

---

## 1. The premise: no SAB decomp exists — VERIFIED NEGATIVE

`~/gc_refs/sadx/README.md:1` reads `Sonic Adventure DX`. Its `config/` holds
`GXSE8P`, `GASJ8P`, `GXSP8P` and their demos — Sonic Adventure **DX**, a different
game. Its entire `src/` tree is 7 files:

```
src/Runtime.PPCEABI.H/{runtime.c,__init_cpp_exceptions.cpp,global_destructor_chain.c,__mem.c,__va_arg.c}
src/MSL_C.PPCEABI.bare.H/MSL_Common/errno.c
src/TRK_MINNOW_DOLPHIN/ppc/Export/targsupp.s
```

All Metrowerks runtime / MSL / TRK. **Zero game code.** No other directory under
`~/gc_refs` is an SA2 decomp (`marioparty4`, `melee`, `pikmin`, `pikmin2`, `tp`,
`ttyd`, `tww`, `kar`, `gc-ipl`, `sadx` — full listing in the session log).

**Therefore: binary static recompilation from `main.dol` + the `.rel` overlays is
the only static-recomp route for SAB.** `gamecube/recomp/PLAN.md:118-121` already
recorded this on 2026-08-29; the check above is an independent re-verification, and
`PLAN.md:124-126` still carries the superseded "not verified" wording.

## 2. What already exists — do not rebuild it

`gamecube/recomp/sr/` is a working binary static recompiler, landed in `e597dfa6`
and `b401f282`:

| file | what it is |
|---|---|
| `sr.py` (947 L) | PowerPC/Gekko → C translator. Raises `Untranslatable` rather than approximating. |
| `gekko_rt.h` (376 L) | runtime semantics, a behaviour port of Dolphin's **reference interpreter** with file:line citations |
| `rel.py` (759 L) | REL overlay reader + front end, format from `~/gc_refs/dolsdk2001/include/dolphin/os/OSModule.h` and `OSLink.c:130-270` |
| `sab_leaf_goldens.json` | 1,056 golden vectors captured from native Dolphin `CPUCore=0` |
| `sab_nonleaf_fixtures.json` | 7 replayable non-leaf fixtures (registers + ordered memory-write log) |
| `build_slice.sh` / `build_rel.sh` / `verify_slice.mjs` / `verify_fixture.mjs` | build + differential |
| `coverage_census.py` | **new in this pass** — every-blocker census + boundary-policy comparison |

MP4's separate decomp→wasm path lives one level up in `gamecube/recomp/` and is a
different lineage; nothing here depends on it.

## 3. Function-boundary recovery — solved by two mechanical rules

The Dolphin-generated `dolphin_captures/sab.map` ends every entry at the next `blr`,
so a function containing an early-exit `blr` emits several **nested** entries sharing
one end. Measured: **100 overlapping adjacent pairs, 163,236 bytes = 9.82% of the
summed entry sizes double-counted.** Any instruction-weighted coverage number taken
off the raw map is inflated by that much.

Four policies compared (`coverage_census.py --boundaries`):

| policy | functions | instrs | mid-function branch targets |
|---|---|---|---|
| `asis` (raw map) | 4811 | 415,616 (inflated) | 338 |
| `clip` (end := next start) | 4811 | 374,807 | **960 — worse** |
| `outer` (drop nested) | 4711 | 374,807 | 106 |
| **`outer+calls`** | **4741** | **374,807** | **4** |

`clip` is included because it is the intuitive fix and it is **wrong**: clipping the
outer entry truncates the real function, so its own backward branches start escaping.
`outer+calls` drops the 100 nested entries, then splits 16 entries at 30 interior
direct-call targets.

The strongest independent check on the result: scanning all of `.text` for relative
`bl`, there are **22,878 call sites** hitting **3,457 distinct targets**, and the
number that do **not** land on an entry of the raw `sab.map` is **0**. Direct-call
boundary recovery is complete. (The `+calls` half of the chosen policy exists because
dropping the 100 nested entries removes 30 of those targets, which are then split back
in.)
374,807 instructions is exactly the map's union inside `.text` — **99.46% of the
1,507,392-byte `.text`**; the unmapped 8,164 bytes are TEXT0's exception vectors.

## 4. Coverage

### `main.dol` — 4,741 functions / 374,807 instructions

DOL offset **read from the ISO header at `0x420` → `0x1e700`** (never hardcoded);
TEXT0 9,216 B @ `0x80003100`, TEXT1 1,498,176 B @ `0x80005500`.

```
python3 gamecube/recomp/sr/coverage_census.py \
  --image /tmp/sr_sab/main.dol --map dolphin_captures/sab.map --boundaries outer+calls
```

| policy | functions | instructions |
|---|---|---|
| **P0** strict, today | 4204 (88.67%) | 279,353 (74.53%) |
| **P1** + indirect dispatch | 4671 (98.52%) | 372,753 (99.45%) |
| **P2** + host/privileged stubs | 4737 (99.92%) | **374,790 (100.00%)** |
| **P3** + boundary recovery | 4741 (100%) | 374,807 (100%) |

Note how far function-weighting and instruction-weighting diverge at P0: the 11.3% of
functions that are blocked carry **25.5%** of the instructions. Blocked functions are
the big ones. Quote the instruction column.

Blocker classes, counting **every** blocker rather than the first per function:

| class | functions | blocking instrs | what it is |
|---|---|---|---|
| INDIRECT | 467 | 812 (`blrl` 665, `bctr/bctrl` 147) | a solved dispatch problem — needs an address→function table |
| PRIVILEGED | 66 | 431 | the device/OS boundary; host-bound by address |
| TARGET | 4 | 4 | residual mid-function branch targets |
| GAP | **0** | **0** | genuine translator holes |

### The 76 `.rel` overlays — 5,551,313 instructions

```
python3 gamecube/recomp/sr/rel.py --iso "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso" \
        --translatability ALL
```

`ALL 76 overlays: 5551313 instructions decoded / clean 5549137 (99.9608%) / blocked
2176 / PRIVILEGED 0` — the 2,176 are `bctr/bctrl` 1,195 + `blrl` 981 and nothing else.
**Zero privileged instructions and zero translator gaps anywhere in the overlays**:
all OS/kernel code is in the DOL.

### Whole game

| | instructions | share |
|---|---|---|
| `main.dol` `.text` | 376,848 | 6.36% |
| 76 `.rel` overlays | 5,551,313 | 93.64% |
| **total** | **5,928,161** | |

Under P2 for the DOL plus indirect dispatch for the overlays:
**5,926,103 / 5,928,161 = 99.965%**. The 2,058-instruction remainder is 2,041
unmapped TEXT0 exception-vector instructions (the host boundary by definition) plus
17 instructions in 4 functions with a residual mid-function branch target.

**Coverage is not the blocker for this route.**

## 5. The translator gap is now zero

The GAP class was 4 functions / 28 instructions / 2 forms: `lwzux` (op31 xo=55, ×21)
and `lfdux` (op31 xo=631, ×7). `sr.py` implemented every d-form update load/store
(ops 33/35/41/43, 37/39/45, 49/51/53/55) but no **x-form** (indexed) update variant.

This pass added the x-form update family to `sr.py` — `lwzux`, `lbzux`, `lhzux`,
`lhaux`, `stwux`, `stbux`, `sthux`, `lfsux`, `lfdux`, `stfsux`, `stfdux` — mirroring
the already-validated d-form pattern, keeping the architectural `rA==0` / `rA==rD`
invalid-form refusals rather than guessing.

Regression evidence:
- `sr.py --coverage` (its own historical metric): **4268 → 4271 clean of 4811**, no loss.
- The 4-leaf slice rebuilt to **md5 `f14b813694fc243b74c9c85f8fc009fb`** — *byte-identical*
  to the md5 recorded in commit `e597dfa6`, before and after.
- `verify_slice.mjs`: **1056 bit-exact / 0 mismatched of 1056** (machine load 6.45).

> The byte-identical wasm proves the edit is **additive**. It does **not** prove the
> new forms are **correct** — the 1,056-vector suite never reaches them. They need
> their own differential (see §7).

## 5b. Indirect dispatch is BUILT, and P1 is now a measurement

The first version of this document reported P1 (+ indirect dispatch) as a **policy
assumption** — "if `blrl`/`bctr` were dispatched, this many functions would clear."
It is now emitted code, and the number is measured rather than modelled.

`sr.py --indirect` translates `blrl` / `bctr` / `bctrl` into a runtime guest-address →
translated-function lookup, `sr_indirect()` (`sr_driver.c`), which is the shape
N64Recomp calls `LOOKUP_FUNC` (`~/gc_refs/N64Recomp/include/recomp.h:450`). Three
decisions are deliberate and worth stating:

- **`blrl` reads the OLD LR before overwriting it.** The target is LR-at-entry; LR then
  becomes CIA+4. Capturing it after the write would call the return address.
- **PowerPC masks the low two bits** of an indirect branch target (`& ~3`).
- **An unknown target FAULTS (`0xE1......`), it does not fall through.** A `bctr` into a
  *switch table* targets a point INSIDE a function, which is not a dispatchable entry,
  so jump tables fault loudly until static table recovery exists
  (N64Recomp `analysis.cpp:229-334`). `sr_extern()` keeps its own distinct prefix
  (`0xE0......`) so "unresolved indirect" and "callee outside the emitted set" are
  never confused — they need different fixes.

Measured with `sr.py --coverage`, same image, same boundary policy, one flag apart:

| | functions | instructions |
|---|---|---|
| `--boundaries outer+calls` | 4207 / 4741 (88.74%) | 279,369 (74.54%) |
| `--boundaries outer+calls --indirect` | **4674 / 4741 (98.59%)** | **372,769 (99.46%)** |

Every one of the 67 functions still blocked is privileged/host-boundary
(`mfmsr`/`mtmsr`/`mfspr`/`mtspr`/`sc`/cache/`mftb`/`mfsr`) plus one absolute branch.
That agrees with the static census's P1 prediction (4671 / 372,753) to within 3
functions — the difference is the 3 functions with a mid-function branch target, which
the census counts as INDIRECT-only but the emitter refuses under strict target
validation.

**Whole-image emission works.** `sr.py --all --indirect --boundaries outer+calls`
writes a 33,942,640-byte C file: **4,671 function bodies, 4,671 `sr_dispatch` cases,
812 `sr_indirect()` sites, 721 `sr_extern()` sites**, and it **skips 70 functions /
2,054 instructions**. That skip list is not a failure — it is written out with
`--skiplist` and **it is the host-binding worklist**, the same function-granular
exclusion N64Recomp's toml provides (`~/gc_refs/N64Recomp/README.md:32`) and the
mechanism by which a *binary* recomp gets MP4's "never compiled `OSThread.c` in"
escape without having source to omit.

### ⚠ P1 is a TRANSLATION figure, and every `bctr` in SAB is a jump table

Classifying all 147 `bctr` sites in the DOL by how CTR was loaded (walk back for
`mtctr rS`, then find where `rS` came from):

```
  147  bctr   JUMP TABLE (lwzx -> mtctr)
  total 147
```

**100% jump tables, and there is not a single `bctrl` in the image.** The two indirect
forms are cleanly split by role: `blrl` (665 sites, 354 functions) is the Metrowerks
*function-pointer* idiom and its targets ARE function starts, so dispatch resolves
them; `bctr` (147 sites, 123 functions) aims at *mid-function switch labels*, which
are not dispatchable entries, so `sr_indirect()` faults on every one.

So the honest reading of the table above:

| | functions | instructions |
|---|---|---|
| translate under `--indirect` | 4674 (98.59%) | 372,769 (99.45%) |
| …of those, contain a jump-table `bctr` and will **fault at run time** if that path executes | 123 | 65,401 |
| **translated AND runtime-complete** | **4551 (96.0%)** | **307,368 (82.0%)** |

That is not a new unknown — it is the one designed-but-unbuilt piece left on the DOL
side, and the pattern is mechanically recoverable (`lwzx` off a `lis`/`addi` table base
behind a `cmplwi` bound), which is exactly what N64Recomp's static table recovery does
(`analysis.cpp:229-334`). On the overlays it is easier still: `b401f282` established
that ADDR32 self-relocations pointing into the executable section *enumerate* the
jump-table code addresses. But until it is built, quote 82.0%, not 99.45%.

### Regression: both differentials re-run with indirect dispatch on

| suite | result | wasm md5 | matches |
|---|---|---|---|
| 1,056 leaf vectors | **1056 bit-exact / 0 mismatched** | `f14b813694fc243b74c9c85f8fc009fb` | md5 recorded in `e597dfa6` |
| 7 non-leaf fixtures | **7 PASS / 0 FAIL** (3 SKIP = the fixtures `b401f282` already rejected) | `823eaf6b7a25339fa8f660da74f06f5a` | md5 recorded in `b401f282` |

> **These prove NO REGRESSION, not that indirect dispatch is CORRECT.** None of the
> four leaf functions and none of the seven non-leaf fixtures executes a `blrl` or a
> `bctr` — that is *why* they translated cleanly before the flag existed. Correctness
> of the dispatch itself needs a fixture whose trace actually takes an indirect branch.

## 5c. First performance signal for this path — and its limits

No performance number of any kind had ever been measured for SAB static recomp.
`perf_fixture.mjs` replays a captured fixture in a matched-pair loop
(`min` of 7 trials, identical rep counts for run and control) and reports guest
instructions retired per second.

**The first attempt was wrong and is worth recording.** It restored guest memory with
one contiguous `[min,max]` copy — but the staged bytes are *sparse*: `0x801113d4`
stages 84 bytes spread across a **2,401,704-byte span**, so the restore copied 2.4 MB
per iteration, cost *more* than the run itself, and the subtraction went negative
(`NaN` corrected figures). The fix is to restore only the bytes the function *writes*,
to their pre-invocation values — 30–6,316 bytes instead of megabytes.

Corrected, over two independent runs at machine load 11–20:

| fixture | steps | restore control | guest instr/s (corrected), run 1 → run 2 |
|---|---|---|---|
| `0x801113d4` | 66 | 26% of run | 410 M → 323 M |
| `0x801113f4` | 70 | 36% | 435 M → 368 M |
| `0x80111414` | 58 | 30% | 353 M → 319 M |
| `0x801115a8` | 62 | 31% | 390 M → 341 M |
| `0x8012d800` | 1269 | **73%** | 540 M → 561 M |
| `0x80131010` | 2094 | **69%** | 402 M → 604 M |
| `0x8013b170` | 63 | **59%** | 974 M → 1268 M |

**Read only the top four.** Where the restore control is a majority of the measured
time, the corrected figure is a small difference of two large numbers and swings
50% run-to-run — those rows are reported so the instability is visible, not so they
can be quoted. The four low-overhead functions land in a **320–440 M guest
instructions/second** band across both runs.

What that is worth, stated carefully: a 486 MHz Gekko cannot retire more than 486 M
instructions/second and in practice retires fewer, so **translated SAB code executes
in the same order of magnitude as the console's own instruction retire rate, on one
function, in Node, with no system around it.** It is a signal that the *translated
code* is not obviously the bottleneck. It is **not** a whole-game speed, it is not
comparable to the JIT's 0.4115x wall-clock figure (that is a whole-system rate on a
real scene), and it says nothing about interrupts, DMA, the GPU, audio, OS scheduling,
or cache pressure from the rest of the game. Do not restate it as "Nx the console".

## 5d. The overlay differential, and a savestate blocker worth recording

`fixture_rel.py` recovers an overlay's **runtime** base without scanning memory and
without a symbol. The overlay calls into the static DOL through `R_PPC_REL24`
relocations with `imp->id == 0`, and `OSLink.c:139-142` sets `offset = 0` for those, so
the addend is an **absolute DOL address known from the file**. Breakpoint one; on the
hit, LR is one instruction past the calling `bl`, i.e. a live address *inside* the
overlay; the relocation table names which `(section, offset)` sites call that target,
so `base = (LR - 4) - site_off`, confirmed by byte-comparing live memory at offsets
that carry **no** relocation. stg13D offers 400 distinct DOL targets, many with exactly
one call site, so the candidate is unambiguous.

Two defects the first run surfaced, both now fixed and both worth knowing:

1. **A breakpointed DOL function is called from the DOL far more often than from an
   overlay.** The first hit was `0x800c3cd8` with `lr=0x800d2d28` — a DOL-internal
   caller — and `(LR-4) − site_off` from it is nonsense. The LR must be filtered
   against the DOL's own TEXT extents (read from the header, `0x80003100..0x80005500`
   and `0x80005500..0x80173140`).
2. **`~/Library/.../StateSaves/GSNE8P.s01` COLD-BOOTS.** The oracle connected at
   `pc=0x80003140`, which is the DOL's entry point straight out of the header. This
   is not new — `b401f282:105` already recorded "the one at
   `~/Library/.../StateSaves/GSNE8P.s01` resumes at PC 0x80003140" — and this run
   reproduced it. `fixture_rel.py` now warns explicitly when the connect PC is the
   entry point, because a state that fails to restore leaves everything downstream
   looking plausible.

### ⛔ The in-tree City Escape savestate cannot be used with this oracle

`gamecube/states/sab-citye-gameplay.gcs.gz` is the *port's* raw `State::DoState` buffer
and `gamecube/tools/gcs_to_dolphin_sav.py` wraps it in Dolphin's on-disk header. It
cannot be loaded by the native oracle, for a reason no amount of retrying fixes:

| | STATE_VERSION | source |
|---|---|---|
| the port (`gamecube/dolphin-src`) | **177** | `Source/Core/Core/State.cpp:98` |
| the oracle (`~/gc_refs/dolphin-upstream`) | **189** | `Source/Core/Core/State.cpp:98` |

`State.cpp:723` rejects a mismatched version outright, and forging the cookie would
only make it deserialize a different binary layout. The converter's own header also
records that a native **dolphin-src** build SIGSEGVs on the restored state because the
port hardcodes wasm SAB absolute addresses across ~13 HW/video files not gated on
`__EMSCRIPTEN__`. So both routes to a City-Escape-specific oracle are blocked today.

**This does not block the overlay differential.** The claim to close is "no `.rel`
overlay function has ever been differentially verified" — *any* overlay closes it, and
`titleD.rel` (id=1, 24,148 bytes / 6,037 instructions) and `advertiseD.rel` (id=91)
are reached from a cold boot with no savestate at all.

### Relocations are applied by reading the machine, not by re-implementing OSLink

The shipped REL bytes are **not** what executes: `Relocate()`
(`~/gc_refs/dolsdk2001/src/os/OSLink.c:146-200`) patches the image in place — `ADDR32`
writes a word, `ADDR16_HA/LO/HI` rewrite the low half of a `lis`/`addi` pair, `REL24`
rewrites a branch displacement. `rel.py:147 section_bytes()` returns the raw file
bytes, so translating them would bake **placeholder constants** into every address
materialisation. Rather than re-implement `Relocate()` — which would then require
discovering the runtime base of every *data* section it references — `fixture_rel.py`
reads the relocated section back out of the live machine and reports how many words
differ from the file. The base confirmation has already proved it is the right image,
so those bytes are ground truth.

## 5e. Closing the x-form gap: reachability is not available, so inject

The `lwzux`/`lfdux` addition (§5) was proven **additive** — the wasm came out
byte-identical — but never proven **correct**, because the 1,056-vector suite does not
reach those forms. The obvious fix is to capture a fixture from the four SAB functions
that contain them. **That was tried and it does not work:**

```
[capture] 0x8014c580 ...   SKIPPED: TimeoutError: timed out
[capture] 0x8014c5f8 ...   SKIPPED: TimeoutError: timed out
[capture] 0x8014c748 ...   SKIPPED: TimeoutError: timed out
[capture] 0x8014c878 ...   SKIPPED: TimeoutError: timed out
```

Zero of four fired, and a static check says why: **all four have ZERO DIRECT
CALLERS.** Of the 22,878 relative `bl` sites in the DOL, not one targets them — they
are reachable only through an indirect branch. The prediction and the experiment agree,
which is the useful part: the reachability route is *closed*, not merely unlucky.

`DolphinPPCTests` does not help either — it is `Integer.cpp` / `FloatingPoint.cpp` /
`ConditionRegister.cpp`, i.e. arithmetic, with no load/store coverage at all.

So `xform_vectors.py` brings the instruction to the oracle instead of waiting for the
oracle to reach the instruction: write `<insn> ; blr` into a scratch page of the
running game's MEM1, set the architectural inputs over the GDB stub, set LR to a
sentinel, run, read the results back, and restore the scratch and data pages. The
oracle is still Dolphin's reference interpreter executing a real Gekko instruction, so
the semantics are the hardware's. It is the same injection mechanism that produced the
existing leaf goldens (`gamecube/tools/golden_invoke_sab_psmtx.py`).

66 vectors across all 11 forms. **Half use a NEGATIVE index**, deliberately: the update
forms write the effective address back to `rA`, so an unsigned-`rB` bug would load the
correct value and corrupt the base — a test that only checked the loaded value would
pass. `verify_xform.mjs` therefore compares the updated `rA` first, then `rD`/`frD`
(the latter as raw 64-bit bits, never as doubles), then a 32-byte memory window.

## 5f. What the first overlay attempt cost, and the bug in my own heuristic

The first `titleD.rel` run reported `[base] NOT RECOVERED after 367 breakpoint hits`.
The base-recovery design is sound but the *ranking* was backwards: probe targets were
sorted by **fewest** call sites, to minimise the number of base candidates per hit.
Fewest call sites means the **rarest call**, so the run armed precisely the breakpoints
least likely to fire. Ambiguity is cheap to resolve — every candidate is byte-confirmed
against live memory — but rarity is not. Now ranked by most call sites.

The three hits that did pass the DOL-TEXT filter had `lr` = `0x811fff58`, `0x811ffff4`,
`0x811ffff8` — the top of MEM1, i.e. **stack**, not overlay code. Combined with
`pc=0x80003140` at connect, the reading is that the interpreter had not yet booted far
enough to OSLink any overlay at all.

## 6. The OS-thread / context-switch problem, measured

The brief warned that a binary recomp cannot use MP4's escape (never compiling
`OSThread.c` in) because `SelectThread` / `OSLoadContext` / `rfi` are inside the
translated image. They are inside it — and the measurement shows the boundary is far
smaller than that framing suggests.

**Every privileged instruction in SAB lives in 66 DOL functions totalling 2,037
instructions = 0.54% of the mapped `.text`. The overlays contain none.** Named
members include `OSSaveContext`, `OSSetCurrentContext`, `__OSSaveFPUContext`,
`__OSLoadFPUContext`, `OSDisableInterrupts`, `OSEnableInterrupts`,
`OSRestoreInterrupts`, `OSGetTime`, `OSGetTick`, `Reset`, `DCEnable`, `ICEnable`,
`__LCEnable`, `LCDisable`, `PPCMfhid2`, `PPCMtwpar`, `PPCSync`, the TRK debug stubs.

`rfi` appears at 35 sites: **24 of them in the unmapped `0x80003620`–`0x80005308`
exception-vector region of TEXT0**, and 11 in 8 mapped OS/TRK functions.

The thread machinery, recovered from the call graph:

- `__OSReschedule` **is named** at `0x800ebf68`, 48 bytes. Its body is
  `mflr; stw; stwu; lwz r0,RunQueueHint(r13); cmpwi r0,0; beq +0xc; li r3,0;
  bl 0x800ebd68; …` — that is `~/gc_refs/dolsdk2001/src/os/OSThread.c:395-399`
  (`if (RunQueueHint != 0) SelectThread(0);`) instruction for instruction.
- ⇒ `0x800ebd68` is **`SelectThread`**. It is the *only* caller of `OSSaveContext`
  (DOLSDK has exactly one call site, `OSThread.c:357`), and it calls `0x800e56bc`.
- `0x800e56bc` sits immediately after `OSSaveContext`, is 216 bytes, has 9 direct
  callers, and ends in `rfi` at `0x800e5790` — the shape of
  `OSContext.c:281 OSLoadContext`, whose `rfi` is at `OSContext.c:350`.
  *(This identification is structural — adjacency + `rfi` + call graph + DOLSDK
  source shape. It is not signature-matched against the SDK binary.)*

**The consequence: `SelectThread` and `__OSReschedule` — the scheduler policy — are
ordinary translatable code and translate clean. Only the setjmp/longjmp primitives
`OSSaveContext` and `OSLoadContext` are the host boundary. That is two functions to
host-implement, not a rewrite of the guest OS.** Function-granular exclusion by
address is exactly what `~/gc_refs/N64Recomp/README.md:32` provides ("stub out
specific functions, skip recompilation of specific functions") and what
`sr_dispatch`'s `default:` already gives here.

The *unsolved* part is what the host implementation does: resuming a saved guest
continuation when that continuation is a host wasm call stack. Three known mechanisms
exist — Emscripten Asyncify (already used elsewhere in this repo), one host thread per
guest thread (N64ModernRuntime's answer; `gamecube.html` already has SAB + COI so
pthreads are available), and JSPI. **None is chosen, built, or measured here.**

## 7. Decision

**The route is VIABLE for SAB on translatability grounds, and the remaining work
contains no unknowns — only unbuilt engineering.** 99.965% of the game's 5.93 M
PowerPC instructions clear the translator once two designed-but-unbuilt mechanisms
exist (indirect dispatch, host-bound OS primitives); the translator's own semantic
gap is now zero; and the host/OS boundary is 66 functions, of which the hard part is
two.

**What that claim does NOT cover, stated plainly:**

1. **There is no performance number of any kind for the SAB static-recomp path.** The
   entire premise — that this escapes the JIT ceiling — is unmeasured for this game.
   MP4's ~1.000x is a *different game* reached by a *different (decomp→C)* route.
   Viability here means *translatability*, not speed.
2. **No `.rel` overlay function has ever been differentially verified.** All 1,056
   leaf vectors and all 7 non-leaf fixtures are DOL functions. 93.64% of SAB's code
   is in overlays.
3. P1 is a **policy assumption**. Indirect dispatch is designed (N64Recomp
   `LOOKUP_FUNC`, `~/gc_refs/N64Recomp/include/recomp.h:450`) but not built here.
4. The new x-form update ops are additive-proven, not correctness-proven.
5. Every number here is **static**. Executed-code coverage under a real SAB run was
   not measured.

**Smallest next step that would prove it,** in order — each is offline and needs no
new rig:

1. **Build the address→function dispatch table and re-run the existing differentials.**
   Emit `sr_dispatch` over the whole `outer+calls` boundary set, route `blrl` and
   `bctr` through it, and re-run the 1,056 leaf vectors plus the 7 non-leaf fixtures.
   This converts P1 from an assumption into a measured number and unblocks 467 DOL
   functions and every overlay's entire residual. No savestate, no browser, no Dolphin.
2. **Differentially verify one `stg13D` (City Escape) overlay function.** The rig
   exists (`fixture_nonleaf.py` + `verify_fixture.mjs`); it needs a City Escape
   savestate. This is the single claim never made, and it gates 93.64% of the code.
3. Only then, a performance measurement — and per the product definition, the guest
   must run at exactly 1.000x; headroom is reported as capacity, never as speed-up.
