# Static recompilation of Sonic Adventure 2 Battle — how far it reaches

Measured 2026-09-01, extended 2026-09-02. Every number below was produced from the
shipped disc; the reproducing command is printed next to each one. Artifact:
[`coverage.json`](coverage.json). Raw tool output: `census_asis.txt`,
`census_outer_calls.txt`, `rel_all.txt`, `os_boundary.txt`.

## Status at a glance

| claim | evidence |
|---|---|
| leaf golden vectors | **1056 bit-exact / 0** — wasm md5 `f14b813694fc243b74c9c85f8fc009fb` |
| non-leaf fixtures | **7 PASS / 0 FAIL** — md5 `823eaf6b7a25339fa8f660da74f06f5a` |
| `blrl` indirect dispatch, by execution | **3 PASS / 0 FAIL** |
| x-form update load/store | **66 bit-exact / 0**, all 11 forms |
| **`.rel` OVERLAY functions, by execution** | **18 PASS across two modules** — `otherprintD` 6/6, `stg13D` 12/15 with **0 refused** (was 4/15 with 11 refused, all one cause: the Gekko locked L1 cache), §5g/§5h/§5k |
| **Gekko locked L1 cache (`0xE00000xx`)** | **modelled as real memory, staged from the oracle, compared byte for byte** — 8 refusals converted to bit-exact passes, with a `-DSR_NO_LC_MODEL` control arm that fails exactly those 8 and passes exactly the 4 that never touch it, §5k |
| `bctr` jump tables | **145 of 147 recovered**, and one **PASS by execution** with a faulting control arm, §5b |
| whole-image build at **`-O2`** | **builds, instantiates, 1056/0 bit-exact** — the "`-O0` is a real scaling constraint" note was an artifact worth **~24x**, §5j |
| **DOL functions verified by execution** | **330 distinct, bit-exact** of 375 attempted — 44 of the top-120 hot functions, 19.92% of sampled PCs, §9.5 |
| **`bctr` jump tables, by execution** | **43 verified**, with a **47-for-47 falsifying control arm** (no-`--jumptables` build: 46 fault, 1 stack-exhausts), §9.5 |
| **`blrl` dispatch, by execution** | **48 of 48** fixtures carry an offline proof that the target was unreachable by direct calls, §9.5 |
| **overlay `bctr` recovery, all 76** | **1,189 of 1,195 (99.5%)** relocated vs **0 of 1,195** raw; 18,246 targets, 0 bogus, §9.1 |
| **whole-image runtime completeness** | **99.88%** of 5,923,824 instructions (was 92.43% with the overlay half unrecovered), §9.2 |
| translator divergence found by the survey | **1** — `fctiwz` negative-zero high word, 620 sites exposed; fixed, §9.5 |
| **whole-image throughput** | ⛔ **NO VALID NUMBER — `0.50-0.54x`, `0.62x` and `0.676x` are all VOID, §8.6e.** `HandleReverb` is **not bit-exact** (308 spurious writes to a page the guest only reads), and `perf_browser.mjs`'s restore set does not cover them, so **rep 1 of ~160,000 timed invocations is the only one computing native's answer**. Direction of the error unknown — do not apply a correction factor. |
| **JIT baseline, re-measured** | **0.3781x delivered / 141.6 MHz executed / 23.2% idle-skipped**, stock V8, n=3, cross-witness spread ≤0.0005. **1.000x costs 373.5 MHz on this scene → the JIT is 2.64x short.** §8.6b |
| ~~JIT baseline `0.4450x`~~ | **RETRACTED, §8.6c** — a 75 s cold boot read over one 40 s window; re-reading that band from four fresh runs of ONE frozen binary returns **0.3338x–0.5097x**. The V8-tier mismatch §8.1 warned about measures **null on both engines** (§8.6d) and was the least of its defects. |
| **WHOLE-IMAGE BOOT IN A BROWSER** | **LINKS, INSTANTIATES, AND RUNS THE GUEST'S OWN `__start`** — wasm md5 `7bcca5756df27133d684c4281410171b`. `__init_registers` / `__init_hardware` / `__init_data` / `DBInit` all return **fault-free**, then `OSInit` reaches **27 distinct hardware registers** across PI/MI/DSP/SI/EXI/DI in **126 host-boundary crossings**. It stops in **`__OSInitAudioSystem`**, spinning on a DSP register — **no device model and no interrupt delivery**, not a translator bug (the GAP class is still zero). Modelling one register (EXI `TSTART`) moved it from 21 registers to 27, with a **falsifying control arm on the same md5**. **Nothing renders and no `drawn/s` is claimed.** §10 |
| **guest OS CONTEXT SWITCH** | **WORKS** — 63 assertions / 0 failures, incl. a three-thread non-LIFO rotation on three real host threads and a control arm that reproduces `0xe00e78ac` with the host layer off. §6 (superseded there) and [`recomp/sr/CONTEXT_SWITCH.md`](../../recomp/sr/CONTEXT_SWITCH.md) |

The two 2026-09-02 additions each came from a **harness** defect, not a translator one,
and both are worth remembering because both produced a confident wrong reading:

1. Seven overlay attempts failed because the oracle binary was `STATE_VERSION` **189**
   and the savestate is **177**; Dolphin rejects the mismatch and then **silently
   cold-boots**, which reads as "the boot is too slow to reach an overlay" (§5h).
2. The overlay differential's one reported mismatch was `JSON.parse` rounding a 64-bit
   FPR — the harness blamed the translator for its own precision loss (§5h).

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
| `test_lc_model.c` | native C, no emscripten: asserts the region model (locked L1 = real memory, WPAR = write-only sink). Build it twice — plain, and with `-DSR_NO_LC_MODEL` for the falsification control arm — and **both must pass**, on inverted expectations. See §5k. |

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

**Whole-image emission works, and it LINKS.** `sr.py --all --indirect --boundaries
outer+calls` writes a 33,942,640-byte C file: **4,671 function bodies, 4,671
`sr_dispatch` cases, 812 `sr_indirect()` sites, 721 `sr_extern()` sites**, and it
**skips 70 functions / 2,054 instructions**. That C compiles and links to a real
**21,538,982-byte WebAssembly module, md5 `c5b33b99aad50163b488b647ece420df`** (3
compiler warnings, no errors) — so the whole-DOL static recompilation of SAB is not a
paper exercise, it is a module.

**And the whole-image build is bit-exact.** Running the 1,056 leaf golden vectors
against that 4,671-function binary rather than the 4-function slice:

```
  PSMTXConcat            264 bit-exact / 0 mismatched
  PSMTXInverse           264 bit-exact / 0 mismatched
  PSMTXMultVec           264 bit-exact / 0 mismatched
  PSVECCrossProduct      264 bit-exact / 0 mismatched
  RESULT    : 1056 bit-exact / 0 mismatched  of 1056
```

md5 `c5b33b99aad50163b488b647ece420df` identical before and after the run. This is a
materially stronger statement than the slice result: the vectors now execute inside a
module that also contains 812 indirect-dispatch sites and every other translated
function in the image, so nothing about the surrounding 4,667 functions perturbs them.

The 7 non-leaf fixtures run against the whole-image build too — **7 PASS / 0 FAIL**,
md5 `51092aa5272349e1d8a1ed7aa25aead3` identical before and after, with the 3
`usable:false` records correctly skipped.

**Two things the whole-image build exposed that a closure build cannot.**

1. **V8 has a hard per-function size ceiling and `-O2` crosses it.** Built at `-O2`,
   the whole-image module fails at instantiate with
   `CompileError: WebAssembly.instantiate(): size 8549242 > maximum function size 7654321`
   — clang inlines the translated bodies into `sr_dispatch` and the result exceeds
   V8's limit. It reads like a corrupt wasm, not a size limit. A whole-image build
   must lower the optimisation level (`SR_OPT=-O0`); both build scripts now take that
   knob. ~~This is a **real scaling constraint on this route**, not a one-off.~~

   > **⛔ THAT LAST SENTENCE IS WRONG, AND IT COST A 24x UNDER-READING. Corrected
   > 2026-09-04 — see §8.** It is not a scaling constraint on the route, it is an
   > artifact of emitting `sr_dispatch` in the *same translation unit* as the bodies.
   > Every arm of that switch calls exactly one `fn_*` exactly once, so `-O2` inlines
   > all 4,671 bodies into it — and inlining there buys nothing whatsoever. Split
   > `sr_dispatch` into its own TU (`sr.py --dispatch-out`, `build_slice.sh
   > SR_DISPATCH_C=`) and emcc cannot inline across it without LTO, so the bodies keep
   > full `-O2` and the module instantiates. Measured: the whole image builds at `-O2`,
   > scores **1056 bit-exact / 0 of 1056**, and runs **~24x** faster than the `-O0`
   > build this bullet mandated.
2. **A rig defect that would have read as a correctness regression.**
   `verify_fixture.mjs` ignored the artifact's own `usable:false` flag. Three records
   in `sab_nonleaf_fixtures.json` carry it with the reason recorded at capture time —
   `0x800e3970` has **30 unknown store forms** so its write log is incomplete *by
   construction*, and `0x80118180` hit the **40,000-step cap without returning** so
   its capture is truncated. A closure build hid this by never emitting them
   (`not in this build`); the whole-image build emits everything, so they ran and
   "failed" with `read of UNSTAGED guest byte` and a write log that overflowed to
   exactly 1,048,576 events (`g_wlog_cap = 1<<20`). Neither can be a pass criterion,
   and the flag is now honoured. That skip list is not a failure — it is written out with
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
jump-table code addresses. ~~But until it is built, quote 82.0%, not 99.45%.~~

### ✅ BUILT, 2026-09-02 — `sr.py --jumptables`

```
python3 gamecube/recomp/sr/sr.py --image /tmp/sr_sab/main.dol \
        --map dolphin_captures/sab.map --boundaries outer+calls --jumptable-census
```
```
bctr sites in translatable functions : 147
  jump table RECOVERED               : 145 (98.6%)
  refused                            : 2
         1  no lis/addi forming the table base
         1  table base r3 defined by op32          (the base is LOADED from memory)

case targets recovered: 3983
       3969  inside the same function (emitted as a label)
         14  another function start (emitted as a tail call)

functions containing a bctr          : 123  (65401 instructions)
  every bctr in them resolved        : 122  (65033 instructions)
```

A recovered `bctr` becomes a real dispatch instead of a fault:

```c
{ switch (st->ctr & ~3u) {  case 0x80019d68u: goto L_80019d68;
                            case 0x80019d70u: goto L_80019d70;
                            default: sr_indirect(st, st->ctr & ~3u); return; } }
```

The `default:` arm still faults deliberately — a CTR value outside the table means the
bound check was not what we read, and must not be guessed.

**Zero of the 3,983 targets is misaligned, mid-other-function, or outside a mapped
function.** That is the strongest available static check: a mis-recovered table base
would produce garbage addresses, and none appear.

Two findings worth carrying:

- The base is often materialised into a **different register** than `lis` wrote
  (`lis r4,0x8018` / `addi r5,r4,23276` / `lwzx ?,r5,?`). A matcher requiring
  `addi rT,rT,LO` missed **9 of 147**; a backward def-chain walk gets them.
- Two tables aim at `0x8014c580`, `0x8014c5f8`, `0x8014c748`, `0x8014c878` — **exactly
  the four functions §5e found have ZERO DIRECT CALLERS.** They are not four functions;
  they are switch cases of one, which the Dolphin map over-split at each `blr` (§3).
  §5e's conclusion that "the reachability route is closed" was right about the symptom;
  the cause is a jump table, and `xform_vectors.py`'s injection harness — which was
  built to work around it — turns out not to have been the only option.

**Runtime-complete on the DOL therefore goes 307,368 (82.0%) → 372,401 (99.4%)** of
374,807 mapped instructions, once these functions can execute their switches.

### Verified BY EXECUTION, with a control arm

The existing non-leaf suite contains **zero** `bctr` functions, so re-running it with
`--jumptables` would have been a **vacuous** test. `fixture_nonleaf.py --discover
--bctr-only` found three `bctr` functions live in the City Escape scene, and every
fixture now records `bctr_executed` so a vacuous run cannot be mistaken for a pass:

| entry | steps | `bctr_executed` | usable |
|---|---|---|---|
| `0x800e2194` | 20 | **0** — took an early exit | yes, but proves nothing here |
| **`0x8010334c`** | **135** | **1** | **yes** — `unknown=0`, `outside_mem1=0`, ps1-indep |
| `0x801011d8` | 79 | 2 | no — 12 unknown store forms, and touches WPAR `0xcc008000` |

Both arms of `0x8010334c`, same fixture, one flag apart:

| arm | result |
|---|---|
| `--indirect` only | **FAIL** — `fault=0xe11034f4` (`sr_indirect` refusing the jump-table target), 12 wrong GPRs, wrong LR, 63 write events instead of 66, wrong final memory |
| `--indirect --jumptables` | **PASS** — fault 0, every GPR/FPR/CR/LR/CTR, all **66** ordered write events and all **84** final-memory bytes bit-identical |

The fault address in the control arm is the proof that the table was the difference:
`0xE1......` is `sr_indirect`'s "unresolved indirect target" prefix and `0x1034f4` is a
mid-function switch label. **`sr.py --jumptables` is verified by execution, not only by
static recovery.**

### ⚠ And the pass needed one more harness correction: XER is not observable

Before that PASS, the run reported exactly one difference — `xer want=20000000 got=0` —
on a fixture where everything else was bit-identical. That is **not** a translator bug:

- Dolphin keeps XER in **split fields** (`PowerPC.h:157-161` `xer_ca` / `xer_so_ov` /
  `xer_stringctrl`), and `PowerPC.h:200` `SetCarry(ca) { xer_ca = ca; }` never touches
  `spr[SPR_XER]`.
- The **only two** references to `spr[SPR_XER]` in all of `Source/Core/Core/PowerPC`
  are `GDBStub.cpp:451` (the read this harness uses, register 69) and `:674` (the
  write). **Nothing keeps that slot live.**
- The tell was in the capture itself: `state_in.xer == state_out.xer == 0x20000000`,
  with `xer` absent from the capture's own `delta` — the oracle claiming XER never
  changed across an invocation that executes four `addic.` and two `sraw`, every one of
  which writes CA.

XER is now reported and never scored, like FPSCR. Both sides of that comparison were
stale, so it could never have been a valid criterion.

**One real translator divergence did surface while chasing it**, and it is fixed on its
own merit rather than because it changed this result (it did not): our `sraw` clamped
the shift to 31 and tested the low `sh` bits, but `Interpreter_Integer.cpp:331-342`
sets CA from the **sign bit** when `rB & 0x20`, because a shift of 32+ shifts every bit
out. The clamped form answers NO for `rS = 0x80000000` — the one negative value with no
other bit set. `sr.py` now mirrors the interpreter's structure exactly; the 4-function
leaf slice still builds to md5 `f14b813694fc243b74c9c85f8fc009fb` and still scores
1056/0, so the change is provably additive.

### Regression: both differentials re-run with indirect dispatch on

| suite | result | wasm md5 | matches |
|---|---|---|---|
| 1,056 leaf vectors | **1056 bit-exact / 0 mismatched** | `f14b813694fc243b74c9c85f8fc009fb` | md5 recorded in `e597dfa6` |
| 7 non-leaf fixtures | **7 PASS / 0 FAIL** (3 SKIP = the fixtures `b401f282` already rejected) | `823eaf6b7a25339fa8f660da74f06f5a` | md5 recorded in `b401f282` |

> Those two suites prove NO REGRESSION, not that indirect dispatch is CORRECT: none of
> the four leaf functions and none of the seven non-leaf fixtures executes a `blrl` or a
> `bctr` — that is *why* they translated cleanly before the flag existed.

### `blrl` dispatch, proven by execution — 3 PASS / 0 FAIL

Three SAB functions whose traces really take an indirect branch, captured from the
reference interpreter and replayed against the **whole-image** build
(md5 `51092aa5272349e1d8a1ed7aa25aead3`, unchanged across the run):

```
PASS  0x80119828  steps=77   bl=2  stores=15  write-events=42  ps1-indep=true  fpscr:match
PASS  0x801197d0  steps=63   bl=1  stores=13  write-events=27  ps1-indep=true  fpscr:match
PASS  0x801197fc  steps=157  bl=4  stores=43  write-events=69  ps1-indep=true  fpscr:match
```

**That the `blrl` was actually taken is not assumed, it is shown.** Each of the three
entry functions contains **exactly one `blrl` and ZERO direct `bl` targets**, yet the
captured traces entered other functions anyway:

| entry | direct `bl` targets | entered | reachable only via `blrl` |
|---|---|---|---|
| `0x80119828` | *(none)* | 4 functions | `0x800e44a8`, `0x800e4650`, `0x801198c4` |
| `0x801197d0` | *(none)* | 3 functions | `0x800e4554`, `0x8011989c` |
| `0x801197fc` | *(none)* | 6 functions | `0x8000532c`, `0x8000535c`, `0x800e4554`, `0x80119778`, `0x801198ec` |

Control cannot have reached those addresses any other way, so `sr_indirect()` resolved
a real function pointer and the result is bit-exact on exit registers, the ordered
memory-write log, final memory, and zero reads of unstaged memory. Fixtures committed
at `gamecube/recomp/sr/sab_blrl_fixtures.json`.

**`bctr` is still unproven and still faults** — see the jump-table section above; that
is the remaining half of the indirect story and the reason the runtime-complete figure
is 82.0%.

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
<!-- STILL TRUE for gamecube/states/sab-citye-gameplay.gcs.gz, but it stopped
     mattering: a DIFFERENT state, ~/Library/.../StateSaves/GSNE8P.s01, is already
     parked in City Escape and IS loadable — by /Applications/Dolphin.app, which is
     the 2603a build that wrote it. See §5h. -->


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

### RESULT: 66 bit-exact / 0 mismatched of 66

```
  lwzux   6 / 0     lbzux   6 / 0     lhzux   6 / 0     lhaux   6 / 0
  stwux   6 / 0     stbux   6 / 0     sthux   6 / 0
  lfsux   6 / 0     lfdux   6 / 0     stfsux  6 / 0     stfdux  6 / 0
  RESULT : 66 bit-exact / 0 mismatched  of 66
```

Goldens committed at `gamecube/recomp/sr/sab_xform_goldens.json`. **The x-form update
forms are now verified by EXECUTION against the reference interpreter, not by
inspection** — the gap §5 opened is closed.

#### The first run said 60/6, and all six were my harness

Before trusting a translator diagnosis, the shape of the failures was checked: `stfdux`
stored `7ff0000000000000` when handed `7fefffffffffffff`, and `lfdux` lost exactly one
low bit. That is not how a translation bug looks — it is how **JSON number precision**
looks:

```
python wrote 0x7FEFFFFFFFFFFFFF = 9218868437227405311
JS JSON.parse gives  9218868437227405000 = 0x7ff0000000000000
```

A JS `Number` cannot hold a 64-bit pattern, so `JSON.parse` silently rewrote `DBL_MAX`
as `+Inf` — on both the *input* the wasm was given and the *expected* value it was
compared against. The goldens file itself was always exact (Python writes integers at
full precision); only the JavaScript read was lossy. 64-bit values are now serialised
as hex strings and parsed with `BigInt`, and the same 66 vectors pass. **No translator
change was made — the translator was right the first time**, and reporting those six as
translator bugs would have been a false accusation with a plausible-looking diff table
attached.

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

### The LR trick is structurally wrong for tail-called helpers — replaced by a scan

Base recovery originally read LR at a breakpoint on a DOL function the overlay calls,
on the reasoning that LR points one instruction past the calling `bl`. With the probe
ranking fixed, the probes finally fired — and every hit reported LR as a **constant
top-of-MEM1 value**:

```
[base] hit 0x80071214 lr=0x811fff80 site=+0xbec -> candidate 0x811ff390  confirm=no
[base] hit 0x80071214 lr=0x811fff80 site=+0xc44 -> candidate 0x811ff338  confirm=no
[base] hit 0x80070c20 lr=0x811fff84 site=+0x348 -> candidate 0x811ffc38  confirm=no
[base] hit 0x80022d34 lr=0x811fffa8 site=+0x350 -> candidate 0x811ffc54  confirm=no
```

Byte-identical LR across dozens of hits of the same target is not a return address —
it is a stale value, because those helpers are entered by a **tail branch**, which does
not write LR. The method assumes a `bl` and there is no way to tell from the stop
whether one happened. A stale LR yields a plausible-looking candidate that never
confirms, which is exactly the failure mode that wastes runs.

**Replaced by a direct MEM1 signature scan**, which does not care how a callee was
entered: pick a 32-byte window of the exec section that contains **no relocation site**
(OSLink patches those in memory, so they cannot match the file) and is not a run of one
byte, then search MEM1 for it and confirm the implied base with the existing
byte-comparison. For `titleD` the chosen window is at `+0x2640`, has 26 distinct bytes,
and occurs exactly **once** in the section. Scanning is also breakpoint-free, so it
costs none of the interpreter slowdown below.

### The scan cost IS the budget — measured, and it inverted the run

The first scanning build re-scanned `0x80100000..0x81800000` on an interval. Measured
over 981 s:

```
[base] t+175s after 62 stops — scanning MEM1 ...   not resident yet
[base] t+344s after 65 stops — scanning MEM1 ...   not resident yet
[base] t+502s after 67 stops — scanning MEM1 ...   not resident yet
[base] t+661s after 69 stops — scanning MEM1 ...   not resident yet
[base] t+819s after 71 stops — scanning MEM1 ...   not resident yet
[base] t+981s after 73 stops — scanning MEM1 ...
```

Six scans, ~160 s each = **960 of the 981 s spent scanning with the guest halted**, and
the guest reached only **1.4 s of emulated time** (0.0016x). 23 MB at chunk `0x400` is
~57,000 GDB round trips. Note also **62–73 stops in 981 s** — the v3 probe ranking is
doing its job; the breakpoints were *not* the cost this time, the scan was.

Two things follow, and both are now fixed: advance the boot **first** with no scanning
at all, then scan **once**; and narrow the window — a REL is `OSAlloc`'d from the arena,
which begins above the DOL's BSS end (`0x801de600 + 1,900,309`), so low MEM1 cannot
contain it. The upper arena is searched first because that is where the earlier LR
values pointed, with `--scan-chunk` raised to `0x1000` (the stub rejects a single
`0x2000` read, so that is the ceiling).

**"Not resident" is also the honest reading of those six scans**: at 1.4 s of emulated
boot the game has not reached the point where it `OSLink`s anything. The signature was
not missed — the overlay was not there yet.

### Fourth bottleneck: the client was leaving the CPU halted

With the scan moved after the boot, the boot itself still crawled — **1.5 s of emulated
time in 600 s = 0.0025x**, against the 0.0328x measured earlier. The mechanism is in
`native_oracle_gdb`'s own docstrings: `GDB.cont()` *"blocks until a breakpoint hits (no
async break exists)"*, and `GDB.resync()` finishes by calling `pc()`, which requires a
**halted** CPU. Pairing a 30 s `cont` timeout with a `resync` therefore stalls the
guest — a probe fires, Dolphin halts the CPU and waits for the client, and the client is
sitting inside a 30 s timeout doing nothing.

Boot advance now arms **one** hot anchor (`OSDisableInterrupts` `0x800e78ac`, 212 direct
callers), uses an 8 s timeout, and re-continues immediately on every stop with no
per-stop work, printing progress every 120 s so the rate is visible during the run
rather than reconstructed afterwards.

### Four bottlenecks, each measured, none of them the same thing

This is the part worth carrying forward: every attempt failed for a *different* reason,
so no single fix would have worked, and each cause was found by measuring rather than
guessing.

| # | cause | evidence | fix |
|---|---|---|---|
| 1 | probe rarity | 367 breakpoint hits, none from the overlay | rank by overlay-calls ÷ DOL-callers |
| 2 | breakpoint storm | 40 armed → 0.010x (3.0 s emulated / 300 s wall) | 12 DOL-quiet probes |
| 3 | scan cost | 960 of 981 s scanning, guest at 1.4 s emulated | boot first, scan once, narrowed window |
| 4 | CPU left halted | 1.5 s emulated / 600 s = 0.0025x vs 0.0328x | one hot anchor, stops answered at once |

Two further defects were structural rather than tuning: the **LR trick is unsound for
tail-called helpers** (§ above), and `rel_emit.py --base` was translating **raw file
bytes** instead of the live relocated section, which would have produced a
register/memory diff that looked like a translator bug and was not one.

### Probe selection, three revisions, two of them wrong

| rev | ranked by | why it failed |
|---|---|---|
| v1 | **fewest** overlay call sites | fewest sites = the *rarest* call; 367 hits, none from the overlay |
| v2 | **most** overlay call sites | the most-called DOL helpers are the ones the **DOL itself** calls constantly, so every armed breakpoint fires on internal traffic; with 40 armed the interpreter fell to **0.010x** (3.0 s emulated in ~300 s wall) versus 0.0328x unimpeded — the breakpoints, not the interpreter, were the bottleneck |
| v3 | overlay sites ÷ (1 + DOL-internal callers) | called often by the overlay, rarely by the static image; both numbers are known ahead of time — the overlay's from its relocation table, the DOL's from its own call graph |

For `titleD`, v3 picks `0x80022ecc` (12 overlay calls, 1 DOL caller) where v2 picked
`0x80114058` (34 overlay calls but **20** DOL callers).

### The real reason, measured: the interpreter runs SAB at 0.0328x real time

That last sentence was a reading, so I measured it. Dolphin's reference interpreter
emits one AI DMA callback per fixed slice of *emulated* time — 200.18/s on hardware
(`CLAUDE.md:44`; `SystemTimers.cpp:78-83` derives the period from the core clock). The
oracle log from the x-form run reached `AID-fire n=2996` in about 456 s of wall clock:

```
2996 AID fires / 200.18 per s  = 14.97 s EMULATED
14.97 s emulated / 456 s wall  = 0.0328x real time  (~1/30)
```

So the budgets were never close:

| budget | emulated boot reached |
|---|---|
| 240 s (my titleD run) | **~7.9 s** |
| 300 s (my stg13D run) | ~9.8 s |
| 900 s | ~29.5 s |

A GameCube title screen is tens of seconds of emulated boot away, so a 240 s budget
cannot reach one no matter how the probe targets are ranked. **The ranking bug was
real and the budget was also wrong** — two independent causes, and fixing only the
first would have failed again identically. `fixture_rel.py` now sizes `--budget` for
base recovery separately from `--discover-budget` (the machine is already booted by
then), and documents the conversion so the next person picks a number in emulated
time rather than wall time.

## 5g. Overlay differential: ACHIEVED — and the blocker was never the savestate

> **SUPERSEDED, 2026-09-02.** Everything below this banner down to §5h is the record of
> seven failed attempts. It is kept because the six causes it documents were all real
> and all measured. But its CONCLUSION — "what is missing is a Dolphin savestate parked
> where an overlay is resident, written by the upstream oracle so its `STATE_VERSION` is
> 189" — was **wrong, and backwards**. See §5h.

### RESULT

```
PASS  0x8121d80c  steps=236 bl=7 stores=22 write-events=47 final-mem-bytes=60
                  staged=148 ps1-indep=true   fpscr:want=a622c000 got=a6204000 (NOT MODELLED)
```

`stg13D.rel` (City Escape) function at runtime address `0x8121d80c` — exit GPRs, FPR
PS0 lanes, CR/XER/LR/CTR, the **complete 47-event ordered memory-write log**, and all
60 bytes of final memory are bit-identical to native Dolphin's reference interpreter.
Zero reads of unstaged guest memory, zero faults, PS1-independent. wasm md5
`6f810afa5a28391d2522d3ce3eb173fd`, identical before and after the run; machine load 4.66.

Artifacts: `gamecube/recomp/sr/sab_rel_stg13D_fixtures.json` and the relocated section
`gamecube/recomp/sr/sab_rel_stg13D.sec1.live.bin`.

Seven attempts failed for six measured reasons, and then an unmeasured seventh.

Original section follows.

### The (superseded) framing

Seven attempts. **Zero overlay functions have been differentially verified**, which
remains the largest unverified claim in this route — the overlays are 93.64% of SAB's
code. The tooling is finished and tested; what is missing is a way to get the reference
interpreter to a scene where an overlay is resident.

### Six distinct causes, each measured and each removed

| # | cause | evidence | outcome |
|---|---|---|---|
| 1 | `REPO` path two levels up | `ModuleNotFoundError: native_oracle_gdb` | fixed; `--selftest` added |
| 2 | probe ranking v1 (fewest sites) | 367 hits, none from the overlay | rank by overlay ÷ DOL calls |
| 3 | probe ranking v2 (most sites) | 40 armed → 0.010x | 12 DOL-quiet probes |
| 4 | scan cost | 960 of 981 s scanning | boot first, scan once, `chunk=0x1000` → **12 s for 20.6 MB** |
| 5 | LR trick unsound | LR byte-identical across dozens of hits = stale, tail-branch entry | replaced by MEM1 signature scan |
| 6 | `resync()` in the boot loop | 0.0025x | removed |

I also introduced a regression of my own along the way: "fix" #6 by arming a very hot
anchor made it **6× worse** (0.0004x, 2,170,350 stops = 2,412/s), because the per-stop
round trip became the run.

### The structural blocker, measured two ways

`GDB.cont()` blocks until a breakpoint hits — *"no async break exists"* — and
`GDB.resync()` ends in `pc()`, which needs a halted CPU. The consequence:

```
Step B  4 functions x ONE cont(timeout=120), uninterrupted
        2996 AID fires = 14.97 s emulated in ~480 s   =  0.0312x
rev 6   cont re-issued after every timeout, only 117 stops in 566 s
        434 AID fires  =  2.17 s emulated in  566 s   =  0.0038x
```

Stops were *not* the cost in rev 6 (117 of them). The difference is that Step B got
**one clean 120 s `cont` per connection**, while rev 6 re-issues `cont` after each
timeout. *I have not proven the stub fails to resume after a timeout* — but 0.0038x
with almost no stops is consistent with that and inconsistent with the alternative.

Either way the arithmetic is fatal for a cold boot:

| rate | wall clock to reach ~30 s of emulated boot |
|---|---|
| 0.0312x (best possible, uninterrupted) | ~16 min |
| 0.0038x (measured, repeated conts) | **2.2 hours of held lock** |

A GameCube title screen is tens of seconds of emulated boot away. Taking 2+ hours of a
lock that siblings queue on — one acquisition here already cost 2,975 s of waiting, and
an ownerless lock starved 18 waiters earlier the same day — is not a reasonable thing to
do, and the 0.0312x path cannot be sustained across the many `cont` cycles a full boot
needs.

### The precise remaining requirement

**A Dolphin savestate parked at a scene where an overlay is resident, written by the
upstream oracle build so its `STATE_VERSION` is 189.** That deletes the boot entirely
and makes every future overlay capture a matter of seconds.

Why the two states already present do not work:

- `gamecube/states/sab-citye-gameplay.gcs.gz` is the port's format, `STATE_VERSION` **177**
  (`gamecube/dolphin-src/.../State.cpp:98`), and the oracle is **189**
  (`~/gc_refs/dolphin-upstream/.../State.cpp:98`); `State.cpp:723` rejects the mismatch.
- `~/Library/.../StateSaves/GSNE8P.s01` **cold-boots** — connect PC is `0x80003140`,
  the DOL entry point (reproducing `b401f282:105`).

Producing one needs the **GUI** Dolphin: `dolphin-emu-nogui` has `--save_state` for
*loading* only, and the GDB stub cannot write a savestate, so this is a one-time manual
step and not something this tooling can do for itself.

### What is already built and waiting for that savestate

- `fixture_rel.py` — base recovery by relocation-free MEM1 signature scan (**12 s for
  20.6 MB**), live relocated-section dump, entry discovery, fixture capture, `--selftest`.
- `rel_emit.py --base --entry --live-section` — emits overlay functions at their real
  runtime addresses **with their transitive DOL callee closure** in one TU, from the
  *relocated* bytes. Dry-run verified: 1 overlay function + 4 DOL functions, 104
  instructions.
- `verify_fixture.mjs` — unchanged acceptance criteria, and it now honours `usable:false`.

None of that needs revisiting. The next session's first action is the savestate.

## 5h. What was actually wrong: the ORACLE BINARY, not the state

**The state was there the whole time.** `~/Library/Application Support/Dolphin/StateSaves/GSNE8P.s01`
is parked in City Escape with `stg13D.rel` resident. Every run above loaded it into a
Dolphin that **cannot read it**, and Dolphin's response to that is not an error — it is
to carry on **cold-booting**.

| | STATE_VERSION | |
|---|---|---|
| `GSNE8P.s01` (cookie `0xBAADBB6F` − `0xBAADBABE`, revision `Dolphin 2603a`) | **177** | the state |
| `~/gc_refs/dolphin-upstream/build-oracle` — what `fixture_nonleaf.py:41` pinned | **189** | rejects it at `State.cpp:723` |
| `/Applications/Dolphin.app` — `Dolphin 2603a`, the build that WROTE the state | **177** | reads it |

So §5g's requirement ("a state written by the upstream oracle so its version is 189")
had it exactly backwards: what was needed was **a Dolphin that reads 177**, and it was
already installed. With `/Applications/Dolphin.app` as the oracle the connect PC is
`0x801012b4` — not `0x80003140` — on the first try.

This also explains why only the OVERLAY differential ever failed. A cold boot still
executes plenty of `main.dol`, so the leaf and non-leaf DOL fixtures captured fine; an
overlay is not `OSLink`'d until the game reaches the level, so it was never present.
Every "the interpreter runs SAB at 0.0328x, a title screen is tens of seconds of
emulated boot away" measurement in §5f is correct and was solving a problem that did
not need to be solved.

`native_oracle_gdb.pick_oracle()` now derives the binary from the state file's own
version cookie and **raises** rather than launching a Dolphin that would silently
cold-boot. `fixture_rel.py` and `fixture_nonleaf.py` both use it.

### Base recovery: ask the guest OS, do not scan for it

`OSLink` registers every linked module in `__OSModuleInfoList` (`0x800030C8`,
`OSLink.c:81`) and `OSLink.c:216-238` makes every field ABSOLUTE once linked. So the
overlay's runtime base is simply *readable*, in about ten GDB reads:

```
[modlist] __OSModuleInfoList: 1 module(s) linked
[modlist]   id=13  'c:\sonic2gc\cw\output\stg13D.plf'  sec1@0x811fff48 377296B EXEC
[modlist] stg13D.rel id=13 sec1 base=0x811fff48 byte-confirm=OK (16384 windows)
```

That replaces the breakpoint-LR arithmetic, the MEM1 signature scan (12 s) and the
600 s boot advance with a single structured read, and it *enumerates* what is resident
instead of confirming a guess about one module. The same walk can be done entirely
offline against the decompressed savestate — the state's LZ4 payload contains MEM1, and
reading `0x800030C8` out of it gives the same answer with no Dolphin at all.

### The seventh cause — an aligned-only relocation test

With the CORRECT base handed over by the module list, `confirm_base()` still said
**FAILED**. Of stg13D's 18,818 relocation sites in the executable section, **12,790
(68.0%) sit at `site_off % 4 == 2`** — the immediate half of a `lis`/`addi` pair, which
`R_PPC_ADDR16_HA/LO` patch through `*(u16*)p` (`OSLink.c:170-181`). Only the 6,028
`R_PPC_REL24` sites are word-aligned. Both `confirm_base()` and `pick_signature()`
tested `(off + k) for k in range(0, window, 4)`, so they were blind to two thirds of the
relocations: they would call a window "relocation-free", compare it to live memory, and
read a legitimate OSLink patch as a mismatch. **This would have defeated the signature
scan too**, so no amount of fixing the boot would ever have produced a confirmed base.

`patched_byte_offsets()` now derives the exact per-type byte ranges, and acceptance is a
contiguous-region compare: *every* differing byte must lie inside a relocation site.

| | bytes differing outside a relocation range |
|---|---|
| true base `0x811fff48` | **0** of 16,384 compared |
| control: base off by 16 bytes | **262,032** — rejected |

The control matters: with the old test the "check" could pass vacuously.

### The differential said FAIL, and the harness was the liar

The first run reported one difference on the one usable fixture:

```
f2(ps0) want=3f23a865467c9c00 got=3f23a865467c9bd3
```

Top 42 bits identical, low bits different — a rounding shape, so the shape was checked
before the translator was blamed. The interpreter's own `state_out.fpr[2]` is
`0x3f23a865467c9bd3` — **the value labelled `got`**. A JS `Number` cannot hold a 64-bit
FPR pattern:

```
0x3f23a865467c9bd3 = 4549665201502067667
through a JS double = 4549665201502067712 = 0x3f23a865467c9c00
```

`verify_fixture.mjs` read the fixture with plain `JSON.parse`, which corrupted **both**
`state_in.fpr` (so the wasm was fed a slightly wrong input) and `state_out.fpr` (so the
EXPECTED value was wrong). The wasm had been exactly right and the harness blamed the
translator for its own rounding. This is the **same class of bug §5e already paid for**
— `xform_vectors.py` serialises 64-bit values as hex strings for precisely this reason —
resurfacing in a different file that reads the older number-valued fixtures.

Fixed by parsing through the Node JSON **source reviver**, which recovers the exact
digits, and hard-failing on a runtime that lacks it rather than silently degrading.
Re-audited every committed suite for values that a double cannot hold exactly:

| suite | inexact values | consequence |
|---|---|---|
| `sab_leaf_goldens.json` | **0** | prior 1056/0 unaffected |
| `sab_xform_goldens.json` | **0** | prior 66/0 unaffected (already hex strings) |
| `sab_blrl_fixtures.json` | **0** | prior 3 PASS unaffected |
| `sab_nonleaf_fixtures.json` | **6** (NaN payloads) | re-run required |

`sab_nonleaf_fixtures.json` re-run under the fixed reader: **7 PASS / 0 FAIL**, wasm md5
`823eaf6b7a25339fa8f660da74f06f5a` — identical to the md5 already recorded in §5b. No
regression.

### Two of the three captured fixtures are NOT replayable, by construction

`0x81217f48` and `0x81200438` each touch six addresses at `0xE0000000+`. The replay
harness stages guest MEM1 only, so those bytes were never captured and replaying reads
poison — producing a wall of register diffs that looks exactly like a translation defect
and is not one. `verify_fixture.mjs` now refuses a fixture with a non-empty
`outside_mem1` and says why, the same way it honours `usable:false`.

So the honest score for this capture is **1 usable fixture, 1 PASS** — not 3 of 3.

> **⌦ SUPERSEDED by §5k (2026-09-04).** "Not replayable, by construction" was true of
> the harness, not of the guest state: the locked cache is ordinary memory and both
> `0x81217f48` and `0x81200438` are now bit-exact with their `0xE00000xx` bytes staged
> from the oracle and compared. The `outside_mem1` blanket refusal is gone; WPAR is
> the only region that still gets a sink.

## 5j. The `-O0` constraint was an artifact, and removing it is worth ~24x

§5b recorded "a whole-image build must lower the optimisation level (`SR_OPT=-O0`) …
this is a real scaling constraint on this route." **It is not a constraint on the route.
It is a constraint on emitting `sr_dispatch` in the same translation unit as the bodies**,
and it was suppressing every whole-image performance number by a factor of ~24.

`sr_dispatch` is a 4,671-arm switch in which **every arm calls exactly one `fn_*`
exactly once**. At `-O2` clang therefore inlines all 4,671 translated bodies into it,
producing one function larger than V8's hard per-function ceiling. Inlining there was
never worth anything — there is no call-site specialisation to win.

The fix is `sr.py --dispatch-out <file>` + `build_slice.sh SR_DISPATCH_C=<file>`:
`sr_dispatch` becomes its own TU, emcc does no cross-TU inlining without LTO, and the
bodies keep full `-O2` including leaf inlining at their own call sites.

**The change is provably additive.** Regenerating the whole image *without*
`--dispatch-out` produces byte-identical C — md5 `4216085a115d3b829321e789a037b638`
before and after the edit — which is the same "byte-identical output proves additive"
standard §5 used for the x-form work.

| whole-image build | wasm | instantiates | 1,056 leaf goldens |
|---|---|---|---|
| `-O0`, dispatch in-file | 24,940,816 B, md5 `2f91901b3a7b532a7534b8a5752fa501` | yes | — |
| **`-O2`, dispatch split** | **22,710,127 B, md5 `b0e35dc87ee1567bc5a1215a0dd42153`** | **yes** | **1056 bit-exact / 0** |

Both built from the same generated C with `--all --indirect --jumptables --boundaries
outer+calls` (4,671 bodies, 4,671 dispatch cases, 812 `sr_indirect` sites, 721
`sr_extern` sites; 70 functions / 2,054 instructions skipped as the host-binding
worklist). md5 identical before and after the goldens run.

### It was TWO stacked penalties, not one, and only one of them is `-O2`

Isolated with matched builds one variable apart, same 12-function closure, same
fixtures, same harness (`perf_fixture.mjs`, min of 7 trials, restore-corrected):

| fixture | whole-image `-O0` | **closure** `-O0` | **closure** `-O2` | whole-image `-O2` |
|---|---|---|---|---|
| `0x801113d4` | 12.7 M | 77.3 M | 432.5 M | **326.6 M** |
| `0x801113f4` | 13.6 M | 79.6 M | 380.0 M | **319.6 M** |
| `0x80111414` | 11.7 M | 71.7 M | 342.3 M | **287.4 M** |
| `0x801115a8` | 11.5 M | 72.5 M | 362.3 M | **299.0 M** |

(guest instructions/second, restore-corrected)

- **`-O2` vs `-O0` on identical code: ~4.8-5.6x.** That is the compiler.
- **Whole-image vs closure at the same `-O0`: a further ~6x.** That is *not* the
  compiler and it is not the translated bodies — it is `sr_dispatch` itself. At `-O0`
  clang lowers a 4,671-case sparse switch without the balanced search tree it builds at
  `-O2`, and `sr_call` pays that on *every* invocation. On a 58-70 instruction fixture
  the dispatch swamped the function. **The `-O0` whole-image figure was measuring the
  harness, not the recompiled code.**
- The two multiply to the ~24x between the first and last columns.

Whole-image `-O2` lands ~15-25% below closure `-O2`, which is the honest residual cost
of having all 4,671 functions in one 22.7 MB module.

> **Reading note carried from §5c:** as the engine gets faster the fixed per-invocation
> *restore* control grows as a share of the measurement. At whole-image `-O0` all 7
> non-leaf fixtures had a restore control under 50% of the run; at `-O2` only 4 do, so
> only 4 are quotable. Faster code makes *fewer* fixtures quotable, not more — a
> corrected figure whose control is a majority of the run is a small difference of two
> large numbers and swings 50% run-to-run.

## 5k. The Gekko locked L1 cache was the single cause of every survey refusal

The two overlay surveys attempted 21 functions and verified 10. **All 11 refusals had
one cause**: the invocation reads the Gekko locked L1 cache at `0xE00000xx`. Not a long
tail of unrelated gaps — one named wall, 100% of the refusals, and a wall built out of
two wrong beliefs.

### What the oracle says the locked cache actually is

**It is ordinary memory, and both halves of the reference say so.**

- Guest side, `~/gc_refs/dolsdk2001/src/os/OSCache.c:309-365` `__LCEnable()`: the region
  is mapped by **DBAT3** (`lis r3, LC_BASE_PREFIX` = `0xE000`, `mtspr DBAT3L/DBAT3U`) and
  locked with `LC_LINES = 512` × 32 B `dcbz_l`. After that the program addresses it with
  plain `lwz`/`stw`/`psq_l`/`psq_st`. There is no special access instruction.
- Host side, Dolphin: `MMU.cpp:246-253` (read) and `MMU.cpp:437-442` (write) are a
  straight `memcpy` in and out of `m_l1_cache`. `Memmap.h:253` sizes it 256 KB at
  `0xE0000000`; `Memmap.cpp:114` registers it. **No cache semantics are modelled at all.**

SAB uses it as a matrix stack. `main.dol 0x80116098` is the push: read the stack pointer
from `0x803ae0c4`, `addi r5,r3,48`, then six `psq_l`/`psq_lu` and six `psq_st`/`psq_stu`
— 48 bytes, one 3×4 `Mtx`.

### Why the oracle "could not" read it — a HOST-side pointer path, not a guest fault

An `m` packet at `0xE00000xx` panics Dolphin and then segfaults it. The chain is entirely
in Dolphin's own tree:

| step | what happens |
|---|---|
| `GDBStub.cpp:826` | gates the read on `MMU::HostIsRAMAddress` |
| `MMU.cpp:926-929` | answers **TRUE** — segment `0xE` inside the L1 cache *is* RAM |
| `GDBStub.cpp:831` | so it calls `Memory::GetPointerForRange` |
| `Memmap.cpp:722-723` | `GetSpanForAddress` masks with `0x3FFFFFFF` and **has no L1 arm** |
| `Memmap.cpp:739-740` | `PanicAlertFmt("Unknown Pointer …")`, returns an empty span |
| `GDBStub.cpp:833-834` | hands the resulting `nullptr` to `Mem2hex` |

`0xE0000030 & 0x3FFFFFFF == 0x20000030`, which is the address in the panic the user saw.
**Two of Dolphin's own predicates disagree with each other**, and the guest was never
faulting: guest loads reach the cache through `MMU.cpp:246-253` and are served correctly.

### The fix: read it the way the machine reads it

`native_oracle_gdb.LockedCacheReader` reads the cache by **executing one guest
instruction** — an `lwz rD,0(rA)` — with `rA` pointed at the address wanted, then
reading `rD`. No Dolphin patch, no host pointer, no `m` packet.

Three properties of it were each paid for with a failed run, and each is a rule worth
keeping:

**1. It WRITES NOTHING.** The gadget instruction is one already present in `main.dol`,
found by reading a window of guest text and decoding it (`lwz r5,0(r6)` at
`0x800031b4`), not one this tool assembles into a scratch page. The first version did
write its own into the page `read_gqrs` uses, at `+0x100`.

**2. `MSR.EE` is cleared across the resume**, the way `LCEnable()` brackets its own
locked-cache setup (`OSDisableInterrupts` / `OSRestoreInterrupts`,
`OSCache.c:371-377`). Without it the very first attempt failed at the self-test:

```
RSPError: gadget selftest: step landed at 1284, not 0x81790104
```

`1284` is `0x504` — one instruction past the **external-interrupt vector**.
`Interpreter.cpp SingleStep()` calls `CoreTiming::Advance()` *before*
`SingleStepInner()`, so a timer event delivered at that boundary vectors the CPU away
and the step executes the ISR's first instruction instead of the gadget, leaving
`SRR0` pointing into the gadget. `PowerPC.cpp:720` gates delivery on
`exceptions && m_ppc_state.msr.EE`. Masking also means no ISR can inject instructions
into a fixture the reader is called from the middle of.

**3. It is built LAZILY, on first use inside a capture — never at connect.** An
earlier version built it at connect "so it would not be built mid-trace". That is
backwards, and it cost a whole capture run: the survey armed 16 breakpoints and saw
**zero fires in 300 s**, which reads exactly like "this scene does not run those
functions". The control that settles it is `read_gqrs`, which is known-good — the
recorded survey called it after each of its 15 captures and kept capturing — and
which, **called at connect, times out on its very first `cont` to its own sentinel**.
So the connect-time context is what is special, not the reader. Built lazily, the
reader first runs at a breakpoint stop inside a capture, which is exactly the context
`read_gqrs` is proven in.

Diagnosing (3) took a bisect against a control that fires the overlay anchor
`0x81218a30` every ~0.55 s (5 fires in 2.7 s). Each action alone, same savestate, same
binary:

| arm | anchor |
|---|---|
| control — connect, arm, `cont` | FIRED 0.5 s |
| + read guest text (`m` only) | FIRED 0.5 s |
| + add and remove the sentinel breakpoint | FIRED 0.5 s |
| + write MSR with EE cleared and back | FIRED 0.6 s |
| + hijack PC and restore it, **no execution** | FIRED 0.6 s |
| + resume the guest's OWN next instruction | FIRED 0.5 s |
| + single-step (which vectored to `0x504`), **no PC restore** | FIRED 0.5 s |
| **whole reader at connect** | **nothing in 60 s** |

and a separate probe proved the guest was **not** wedged in that last row —
`OSDisableInterrupts` kept firing 6 times in 0.3 s. "Nothing fired" was never
"the emulator is dead", which is the failure mode that made the first re-capture look
like a scene problem.

### The model

`gekko_rt.h` now separates two things that were one class called "unmodelled":

- **`0xE0000000..0xE0040000`, the locked cache — real memory.** A backing buffer in the
  tail past MEM1, staged from the capture, loads checked against the staged map, stores
  logged to the change log and compared byte for byte like any MEM1 store.
- **`0xCC008000..0xCC009000`, WPAR — a sink.** MMIO, write-only; there is nothing to read
  back, so its stores stay uncompared and are flagged on the result line.

This is **unconditional now, not `SR_VERIFY`-only**: `gk_phys` masks to 26 bits, so in the
shipping runtime `0xE0000030` aliased onto MEM1 offset `0x30` and a locked-cache store
**corrupted guest low memory**. `gk_dcbz` went through the raw mask too — and `dcbz` on a
locked-cache line is exactly how `OSCache.c:349-352` establishes the lock.

### The result: 11 refusals → 0, and 8 of them converted to bit-exact passes

Same 15 functions, same scene, same savestate, re-captured with the locked cache staged.

| | before | after |
|---|---|---|
| **verified bit-exact** | 4 | **12** |
| refused | **11** | **0** |
| mismatched | 0 | 3 |
| attempted | 15 | 15 |

The 8 that converted, each now comparing its locked-cache bytes rather than skipping
them (`read / written` are addresses, `words` are gadget reads):

| entry | steps | locked L1 | write events | final bytes |
|---|---|---|---|---|
| `0x81217f48` | 59 | 6 read / 0 written, 12 words | 36 | 44 |
| `0x81200438` | 35 | 6 read / 0 written, 12 words | 9 | 64 |
| `0x8120cb54` | 900 | 6 read / 9 written, 102 words | 390 | 244 |
| `0x81212248` | 619 | 6 read / 9 written, 66 words | 248 | 187 |
| `0x812127b8` | 554 | 6 read / 18 written, 114 words | 270 | 312 |
| `0x8121d210` | 1063 | 6 read / 8 written, 108 words | 564 | 359 |
| `0x81218584` | 1002 | 6 read / 12 written, 84 words | 524 | 523 |
| `0x812185b4` | 990 | 6 read / 12 written, 84 words | 517 | 515 |

Every GPR, every FPR PS0, CR, LR, CTR bit-identical; every ordered per-byte write event
identical in order; every final memory byte identical; zero unstaged reads;
PS1-independent on both replay arms. The 4 that already passed still pass.

**THE FAULTING CONTROL ARM.** Rebuild the *same* generated C with
`SR_CFLAGS=-DSR_NO_LC_MODEL`, which drops only `gk_tail`'s locked-cache arm so
`0xE00000xx` aliases into MEM1 the way it did before:

```
SUMMARY  4 verified / 15 attempted / 0 refused / 11 MISMATCHED
```

**Exactly the 8 converted fixtures fail, and exactly the 4 that never touch the window
still pass** — i.e. the control arm reproduces the pre-change verified set precisely.
The model is what made them pass. `test_lc_model.c` carries the same discipline at the
unit level: it is built twice and both builds must pass, the second on inverted
expectations.

**The 3 that did not convert are blocked by something else, and it is named.**
`0x81212004`, `0x81200460` and `0x81200678` (163, 506 and 303 `bl` each) all fault
`0xE1` — `sr_indirect()` could not resolve an INDIRECT callee, which
`verify_fixture.mjs` already reports as an address to add rather than a divergence to
investigate. Adding them iteratively converged: 6 roots, then 8, then 10, each round
resolving one target and revealing the next, until `rel_emit.py` refused to go further:

```
CLOSURE BLOCKED at 0x80113f98: mtspr SPR913 (privileged/host)
CLOSURE BLOCKED at 0x8011c18c: branch target 0x8011c140 is not a function start
```

`SPR913` is `GQR1`; `sr.py` raises `Untranslatable` rather than approximate a
quantisation-register write, and `0x8011c140` is `PSMTXReorder`, branched into
mid-function. So the remaining ceiling on these three is **translator coverage of the
indirect-callee closure**, not the locked cache. That is the honest count: the locked
cache stopped being a blocker for 8 of 11, and named the blocker for the other 3.


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

~~**The consequence: `SelectThread` and `__OSReschedule` — the scheduler policy — are
ordinary translatable code and translate clean. Only the setjmp/longjmp primitives
`OSSaveContext` and `OSLoadContext` are the host boundary. That is two functions to
host-implement, not a rewrite of the guest OS.**~~
~~The *unsolved* part is what the host implementation does: resuming a saved guest
continuation when that continuation is a host wasm call stack. Three known mechanisms
exist — Emscripten Asyncify, one host thread per guest thread, and JSPI. **None is
chosen, built, or measured here.**~~

**⛔ SUPERSEDED 2026-09-04 — THE PROPOSED CUT IS IMPOSSIBLE, AND THE PROBLEM IS
SOLVED A DIFFERENT WAY. See [`gamecube/recomp/sr/CONTEXT_SWITCH.md`](../../recomp/sr/CONTEXT_SWITCH.md);
63 assertions, 0 failures, `node gamecube/recomp/sr/verify_ctxsw.mjs`.**

1. **A host-implemented `OSSaveContext` cannot exist.** It is a `setjmp`: it returns
   TWICE. `sr.py:205` emits a guest call as a host call, so a host `OSSaveContext`'s
   frame is dead the moment it returns the first time and there is nothing left to
   `longjmp` into. Measured, not argued: a spike with exactly that shape throws out
   of the module under BOTH longjmp backends — `Infinity` on the emscripten default,
   `WebAssembly.Exception` under `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`. So the
   three mechanisms listed above are not three ways to build this cut; two of them
   (Asyncify, JSPI) are the only ways, and both cost the whole translated image.
2. **The cut belongs one function higher, at `SelectThread` `0x800ebd68`** — the only
   function containing both the save (`0x800ebe68`, its sole `bl` site) and the load
   (`0x800ebf48`). There the park point and the resume point are the SAME host C
   frame, so the switch is a semaphore hand-off between one host thread per guest
   thread with **no stack switching at all**: no Asyncify, no `-sSUPPORT_LONGJMP`, no
   JSPI, and zero instrumentation of any translated body.
3. **The resume is bit-exact, not approximated.** `OSSaveContext` stamps
   `srr0 = 0x800ebe6c` (the `bl` return) and `gpr[3] = 1`; the code there is
   `cmplwi r3,0; beq` → `li r3,0` → epilogue, i.e. `SelectThread` returns NULL. A
   host `SelectThread` that returns NULL after the round trip IS the machine.
4. **One guest function is replaced.** `OSCreateThread`, `OSExitThread`,
   `OSSleepThread`, `OSWakeupThread`, `OSJoinThread`, `__OSReschedule`, the mutexes
   and the message queues all stay translated on the real guest structs. The host
   layer verifies bit-exact against the TRANSLATED shipped `SelectThread` used as its
   own oracle — identical `GekkoState` and identical FNV-1a over all 24 MB of MEM1,
   including at the `rfi` instant of the switch itself.
5. **The pthreads cost does not apply.** It was N64ModernRuntime's cost because the
   N64 page deliberately lacks SAB. `gamecube.html:8` loads `coi-serviceworker.js`;
   confirmed by execution rather than by reading the tag — the witness reports two
   (and, in the three-thread rotation, three) distinct `pthread_self()` values.

Still open there: no interrupt delivery, so no preemption — the eight
non-`SelectThread` `OSLoadContext` sites are exception-return paths and still fault
by name; an exception context resumes at an arbitrary PC and DOES need host stack
switching. Function-granular exclusion by address is now built as `sr.py --host`,
matching `~/gc_refs/N64Recomp/README.md:32`.

## 8. The whole-image performance number, and exactly what it is not

> # ⛔ EVERY STATIC-RECOMP THROUGHPUT FIGURE IN §8.1 THROUGH §8.5 IS VOID
>
> **Read [§8.6](#86-the-matched-re-take--the-jit-arm-holds-and-the-sr-arm-is-void)
> first. Do not quote `0.50-0.54x`, `0.62x`, `0.621x`, `0.676x` or `0.4450x` from the
> sections below, and do not rescale them** — the error direction is unknown, so no
> correction factor exists.
>
> * **The SR numerator is not a measurement of the verified computation.**
>   `HandleReverb` `0x800fa704` — the single fixture carrying §8.1a's headline — is
>   **not bit-exact**: it makes 308 spurious writes to `0x802bba84..0x802bbcfb`, a
>   page native only *reads*. `perf_browser.mjs` builds its restore set from
>   `fx.writes` only, which does not cover that page, so the corruption **persists
>   across reps** and rep 1 of ~160,000 timed invocations is the only one computing
>   native's answer. §8.6e.
> * **The `0.4450x` JIT denominator is not reproducible** — one 40 s window on a boot
>   transient; the same band re-read from four fresh runs of one frozen binary returns
>   **0.3338x–0.5097x**. §8.6c.
> * **The `×1.0774` conversion is the wrong CPI** (static, where the JIT's cycles are
>   dynamic; the dynamic value is ≤1.0017). §8.6f.
> * The V8-tier mismatch the boxes below warn about is real but measures **null on
>   both engines**. It was the least of the four defects. §8.6d.
>
> The sections below are kept unedited as the record of how the number was built and
> what it cost to find out it was wrong. **The one surviving measurement is the JIT
> arm, re-taken in §8.6b: `0.3781x` delivered, `141.6 MHz` executed, `23.2%`
> idle-skipped, against the `373.5 MHz` that 1.000x costs on this scene — 2.64x
> short.**

Measured 2026-09-04. §5c's caveat — "there is no whole-game number, and the fixture
figure is not comparable to the JIT's wall-clock rate" — is *partly* closed here: the
throughput is now measured on the **whole-image** build rather than a 12-function
closure, and against a **same-session** JIT baseline rather than a quoted one. It is
still not a system rate, and §8.3 is the list of reasons.

### 8.1 The two numbers

**JIT baseline, measured this session, stock HEAD, no rebuild** (gate-#8 clean):

```
ROM_IDX=1 PROBE_HEADLESS=0 PROBE_DURATION_MS=75000 node gamecube/tools/dolphin_render_probe.js
[guestclock:throttled] RAW ticksHz=486000000 period=121392 NumBlocks=20 window=40.00s
                       d(ai_dma_cb)=71264 d(aid_fire)=3563
[guestclock:throttled] ai_dma_cb=1781.56/s (hw 4003.56/s) => guest=0.4450x  aid_fire=89.07
```

**`guest = 0.4450x`.** ~~Both witnesses agree~~ (1781.56/4003.56 = 0.44500;
89.07/200.18 = 0.44495).

> **⚠ TWO CORRECTIONS TO THIS BASELINE, both received 2026-09-04 after §8 was written.
> Neither is re-measured here; both are recorded so the number is not re-quoted as it
> stands.**
>
> 1. **`ai_dma_cb` and `aid_fire` are TWO READINGS OF ONE CLOCK, not independent
>    corroboration** (established by a concurrent agent). Their agreement to 5 decimal
>    places is arithmetic, not evidence. `published/s` and `drawn/s` are the genuinely
>    separate metrics; the same agent voided a live A/B on the grounds that the AI-DMA
>    witness said +17.1% while `peFrames`/`published`/`shown` all said −21%, and two
>    guest-side counters disagreeing in DIRECTION means a dirty rig, not a finding.
> 2. **THIS IS AN UNMATCHED PAIR IN THE V8 TIER, and §8.4's "~1.1-1.2x the JIT" rests
>    on it.** When this baseline was taken, `dolphin_render_probe.js` defaulted its V8
>    flags to `--no-liftoff`, forcing every wasm module straight into TurboFan — a
>    configuration **a web page cannot request**. The SR arm was measured by
>    `perf_browser.mjs`, which launches Chrome with `args: ['--no-sandbox',
>    '--disable-dev-shm-usage']` (`perf_browser.mjs:211`) and therefore ran on **stock
>    V8**. So the JIT arm had a tier advantage the SR arm did not. Commit `d7c3415b`
>    changed the probe default to empty; commit `6c210459` sizes the tier at 2.108x on
>    emitted bodies, of which ~1.164x is the residual the flag was handing the JIT arm
>    under stock V8. **Re-take both arms under the same flag before quoting any ratio
>    from §8.1/§8.4.** Matched-pair ratios taken off one binary (§5j's `-O0`/`-O2`
>    columns, §8.1a's two runs) are unaffected.
>
> **✅ RE-TAKEN 2026-09-04 — §8.6. Both corrections landed, and two LARGER ones were
> found underneath them.** The matched pair exists now (both arms stock V8,
> interleaved, one frozen binary each), and the V8 tier — the thing this box was
> written about — turned out to be **not resolvable on either engine** (§8.6d).
>
> What actually broke this JIT baseline is the **window**: `0.4450x` is one 40 s read
> of a 75 s cold boot, and re-reading that same band out of four fresh runs of the
> same frozen binary returns **0.3338x, 0.3592x, 0.5010x, 0.5097x** (§8.6c). **Do not
> quote `0.4450x` at all** — it is not reproducible. The scene-stable replacement,
> n=3, is **`0.3781x` delivered / `141.6 MHz` executed / `23.2%` idle-skipped**
> (§8.6b).
>
> And what broke the OTHER side is worse and is not about measurement at all: the SR
> arm's fixture **is not bit-exact**, and the harness re-runs it ~160,000 times on
> state its restore set never repairs, so **no SR throughput figure in §8 can be
> quoted or rescaled** (§8.6e).

~~This is *higher* than the 0.4115x in
`gamecube/docs/sab-frame-governor/TASKS.md:20-21`~~ — that comparison is void for the
same reason: both sides of it are whole-run reads across the boot transient. The
phase-snap observation it rests on (`"leafInline":"4851/15/15/219
lastIdlePc=80117e0c"`, the frame-governor loop at `0x80117e0c` now being
idle-collapsed) is a code-state claim and is unaffected. **Quote §8.6, not `0.4450x`
and not `0.4115x`.**

**Static recomp, whole-image `-O2` build** (md5 `b0e35dc87ee1567bc5a1215a0dd42153`,
identical before and after the run), measured **in Chrome** by
`gamecube/recomp/sr/perf_browser.mjs` — new in this pass — min of 7 trials,
restore-corrected, under `tools/probe_lock.sh`, machine load 3.97 → 4.91:

```
SR_OUT=/tmp/sr_wi_o2_web node gamecube/recomp/sr/perf_browser.mjs \
  gamecube/recomp/sr/sab_nonleaf_fixtures.json gamecube/recomp/sr/sab_blrl_fixtures.json \
  gamecube/recomp/sr/sab_bctr_fixtures.json    gamecube/recomp/sr/sab_rel_stg13D_fixtures.json
```

| fixture | steps | guest instr/s | ×CPI 1.066 → guest cycles/s | ÷486 MHz |
|---|---|---|---|---|
| `0x801113d4` | 66 | 280.9 M | 299.4 M | **0.616x** |
| `0x801113f4` | 70 | 304.3 M | 324.4 M | **0.667x** |
| `0x80111414` | 58 | 269.8 M | 287.6 M | **0.592x** |
| `0x801115a8` | 62 | 275.6 M | 293.8 M | **0.605x** |
| **aggregate** (instruction-weighted) | | **282.9 M** | **301.6 M** | **0.621x** |

Node cross-check on the same binary, same fixtures, at a quieter load (2.14 → 3.41)
read 287.4-326.6 M, aggregate ~308 M → 0.676x. **Chrome is the number to quote**, because
the JIT baseline it is being compared against is only ever measured in Chrome; running
the two engines in two different runtimes would be an unmatched pair (gate #10). The
~8% Node/Chrome spread is within the load difference between the two runs and should
not be read as a runtime effect.

**Why the browser run is measured on a *separately linked* binary and that is safe:**
`-sENVIRONMENT` changes only the JS glue, and the web relink produced a wasm with the
**identical md5** `b0e35dc87ee1567bc5a1215a0dd42153`. Hash-guarded before and after.

### 8.1a The one HOT-PATH fixture — and it is the best measurement here, and it is lower

Everything above is measured on functions that exist as fixtures by accident of what was
capturable, not because they are hot. Mapping the PC histogram onto recovered function
boundaries (§8.5) puts **none of them in the top 120**. One hot function was captured for
this pass — `0x800fa704` `HandleReverb`, **rank #9 at 3.21%** of the measured profile:

```
0x800fa704  steps=14423  restore-set=3632B
   per invocation : 0.065750 ms  (restore control 0.002000 ms = 3.0% of it, net 0.063750 ms)
   guest instr/s  : 219.4 M raw   226.2 M restore-corrected
```

**Two runs, hash-guarded to the same wasm md5:**

| run | load | guest instr/s (corrected) | × CPI 1.0774 | ÷486 MHz |
|---|---|---|---|---|
| 1 | 1.72 | 226.2 M (3.0% control) | 243.7 M | **0.5015x** |
| 2 | 3.36 | 242.4 M (3.3% control) | 261.2 M | **0.5374x** |

**So the hot-path figure is `0.50x-0.54x`,** a 7.2% run-to-run spread at loads 1.72 vs
3.36 — consistent with this rig's documented ~6-7% resolution at low load, and reported
as a range rather than collapsed to one decimal.

**This is the most trustworthy number in §8 and it should be preferred over the
aggregate above**, on all four axes that have produced bad readings in this project:

| | the four `0x80111xxx` fixtures | `HandleReverb` |
|---|---|---|
| in the measured hot profile | **no** (none in top 120) | **yes, rank #9, 3.21%** |
| restore control as share of run | 27-31% | **3.0%** |
| guest instructions per invocation | 58-70 | **14,423** |
| machine load | 3.97 → 4.91 | **1.72** |

So the honest range across real SAB code is **0.50x-0.67x, and the highest-quality
point sits at the bottom of it.** Read the headline as **0.50-0.54x**, not 0.62x.

> One function is not a profile. `HandleReverb` is audio DSP work and its instruction mix
> need not resemble the Hu3D/game-logic hot path. This narrows the sample's *quality*
> problem, not its *size* problem.

### 8.1c The hot path is mostly NOT capturable, which is a finding in itself

**11 hot functions attempted, 2 usable, 5 rejected, 4 never reached** in a 120 s window.
Oracle `/Applications/Dolphin.app` (STATE_VERSION 177), connect `pc=0x801012b4` — the
§5h restore tell, so the state loaded rather than cold-booting.

| entry | share | outcome |
|---|---|---|
| `0x8011fff4` | 5.16% (#2) | reject — `outside_mem1` = `0xcc008000` (**write-gather pipe**) |
| `0x80120158` | 3.43% | never reached in 120 s |
| **`0x800fa704`** | **3.21%** | **USABLE** — `HandleReverb`, the §8.1a measurement |
| `0x8012338c` | 2.20% | never reached |
| `0x800fa574` | 1.91% | reject — `ps1_dependency` = **320** (reads PS1 of `f0` before defining it) |
| `0x8011da30` | 1.53% | reject — 8 addresses at `0xe00000f0..011c` (**locked cache**) |
| `0x8011d7b4` | 1.34% | reject — `0xcc008000` |
| `0x800e7854` | 1.29% | never reached |
| `0x800e74d8` | 1.26% | never reached |
| `0x80103d28` | 0.83% | reject — `0xcc008000` |
| **`0x800f13a8`** | **0.71%** | **usable capture, but FAULTS on replay** — see below |

`outside_mem1` means the function touches addresses the MEM1-only replay harness cannot
stage — i.e. **MMIO**. `ps1_dependency` means the result depends on an incoming
paired-single lane the GDB stub cannot read. Both are properties of the *code*, not of
the tooling's luck: **SAB's hot path talks to hardware and uses paired singles**, so a
replay-based throughput rig will keep bouncing off it. That is an argument for the
continuous-execution experiment in §8.4 rather than for capturing more fixtures.

> **⚠ The static MMIO predictor does NOT work — do not filter candidates on it.**
> A `lis 0xCC00/0xCC01/0xE000` scan of the function body flagged **none** of
> `0x8011fff4`, `0x8011d7b4`, `0x8011da30`, and all three touched MMIO under the oracle.
> `0x8011da30` is a 48-instruction leaf whose 192 bytes contain no such `lis`, yet it hit
> eight `0xE00000xx` addresses. Only the oracle decides.

### 8.1d The host boundary, demonstrated BY EXECUTION

The second usable capture, `0x800f13a8`, is the most useful negative in this document:

```
SKIP  0x800f13a8  faults 0xe00e78ac
```

`0xE0......` is `sr_extern`'s prefix — "a direct call to a function outside the emitted
set" (`sr_driver.c:30-33`) — and the low bits name the callee: **`0x800e78ac` =
`OSDisableInterrupts`**, which is entry #22 of the 70-function skiplist because it uses
`mfmsr` (`op31 xo=83`). Its sibling `OSRestoreInterrupts` `0x800e78d4` is in the same
trace and the same skiplist.

So a 40-instruction hot function, captured cleanly with zero MMIO and zero PS1
dependency, **still cannot execute** — not because of any translator gap, but because
two of its callees are host-boundary primitives that do not exist yet. **This is §6's
argument turned from a static count into a runtime fault with an address attached**, and
it is the concrete shape of why §8.4 says the blocker is the host layer rather than
throughput.

> **✅ CLOSED 2026-09-04.** Those primitives now exist —
> [`gamecube/recomp/sr/CONTEXT_SWITCH.md`](../../recomp/sr/CONTEXT_SWITCH.md). Two
> notes worth keeping, because both were re-derived the hard way:
> * **`0xe00e78ac` is NOT the Gekko locked L1 cache**, despite the `0xE0` prefix and
>   despite `gekko_rt.h` modelling `0xE0000000` as an unmapped window. It is
>   `sr_extern`'s fault ENCODING, `sr_driver.c` `0xE0000000 | (addr & 0x00FFFFFF)`,
>   so the callee it names is `0x800e78ac`. Test D of `verify_ctxsw.mjs` asserts the
>   decomposition so this cannot be re-confused.
> * `os_boundary.txt:276`'s "**suspected** OSLoadContext: adjacent to OSSaveContext,
>   ends in rfi" is now **byte-exact**: the shipped words carry the Restartable
>   Atomic Sequence fixup with `0x800e78ac` / `0x800e78bc` as literals — the first
>   and last instruction of `OSDisableInterrupts`. The RAS window and the fault
>   address are the same 20 bytes.

### 8.1b Three results that came free with the run

- **`SKIP 0x8121d80c faults 0xbad0d80c`** — the `stg13D` overlay function is *absent*
  from the DOL-only whole-image build, and says so by execution. `0xBAD00000|addr` is
  `sr_call`'s "not in `sr_dispatch`" code (`sr_driver.c:47`), distinct from
  `sr_extern`'s `0xE0` and `sr_indirect`'s `0xE1`. This is the overlay gap (§8.3 item 6)
  demonstrated rather than asserted.
- **The three `blrl` fixtures and the `bctr` fixture all ran to completion with fault 0**
  in the `-O2` split-dispatch build. `perf_browser.mjs` aborts a fixture on any fault,
  so this is a free regression check that indirect dispatch and recovered jump tables
  still work after the dispatch TU was split out.
- **Restore control dominates far more in Chrome**: 74.7-91.5% for every fixture except
  the four `0x80111xxx` ones (27-31%). `0x8013b170` "reads" 1260.0 M corrected off a
  78.3% control — a small difference of two large numbers. Those rows are printed so the
  instability is visible, not so they can be quoted, and the harness filters them.

### 8.2 Why the ÷486 conversion is legitimate, and where CPI comes from

The JIT's guest rate is *credited Gekko cycles / 486e6*, and credited cycles are the sum
of Dolphin's own per-opcode `num_cycles` (`PPCTables.cpp` `GekkoOPTemplate`, accumulated
at `ppc_analyst.cpp:650`). A throughput measured in guest *instructions* per second is
therefore not directly a guest rate — it has to be multiplied by cycles-per-instruction
under **the same cost model**, or the two sides are not the same unit.

Only 40 of 243 opcodes cost more than 1 cycle. Computed over the recovered `outer+calls`
boundary set:

| scope | instructions | cycles | static CPI |
|---|---|---|---|
| whole `.text` | 374,807 | 410,972 | **1.0965** |
| the measured fixture closures (16 fns) | 727 | 775 | **1.0660** |

`mtspr` (2 cycles, and `mtlr`/`mtctr` are `mtspr`) is 1.31% of `.text` and dominates the
correction; `mulli`/`mullw`/`lmw`/`stmw`/`fdivs` follow. **This is a STATIC CPI over the
function bodies, not a dynamic CPI over the executed path** — the fixtures record
`steps` and the ordered write log but not the executed instruction stream, so the
executed mix cannot be recovered from them. The correction is small (+6.6%) and its
error is smaller still, but it is an estimate, not a measurement.

### 8.3 What this number is NOT — read before quoting it

**0.676x is translated-code throughput. It is not "SAB runs at 0.68x".** The gap
between the two is unmeasured, and every item below makes 0.676x optimistic:

1. **There is no host layer at all.** No interrupt delivery, no DMA, no GPU/FIFO, no
   audio, no OS scheduling, no DVD. The JIT's 0.4450x includes all of them. This is the
   single largest reason the two are not comparable, and its size is unknown.
2. **It is bare function replay on a hot cache** — one function, invoked 20,000 times
   in a loop, with its working set resident. No cache pressure from the rest of the game.
3. **The sample is 4 functions**, and they are *not* drawn from the hot profile —
   mapping the measured PC histogram onto function boundaries puts none of them in the
   top 120. They are the functions for which verified fixtures happen to exist.
4. **Only 4 of 7 non-leaf fixtures are quotable at all**, because the per-invocation
   restore control crosses 50% of the run for the three larger ones once the code is
   this fast (§5j reading note).
5. **SR has no idle-skip; the JIT's 0.4450x does.** The JIT is credited for cycles it
   never executed (the `leafInline` collapse of the governor loop). On an
   executed-work basis the two engines are closer than these numbers suggest; on a
   delivered-rate basis SR would need the same mechanism to keep up. Neither engine's
   phantom share was re-measured here — `[mips]` is unvalidated (CLAUDE.md gate #10)
   and shipped OFF in this run.
6. **The build is `main.dol` only.** The 76 `.rel` overlays are 93.64% of SAB's static
   instructions and are absent. That matters less than it sounds *on this scene* —
   96.92% of the 15,478 PC samples in the histogram fall inside the DOL's `.text`,
   2.90% at `0x80bc____` (arena, i.e. an overlay) — but City Escape gameplay, where
   `stg13D` is resident and running, would shift that a lot. **This is the boot/menu
   scene, not gameplay.**
7. **7 of the 70 skipped functions are in the hot profile**, including
   `OSRestoreInterrupts` (0.53%), so even the DOL side is not fully executable yet.

### 8.5 Where "hot" comes from, and how much of the workload the DOL build covers

`gamecube/recomp/sr/profile_map.py` (new) maps the JIT probe's 256-byte PC histogram onto
the **same** recovered boundaries the emitter uses, so the hot set is measured rather than
assumed. Straddling buckets are split by covered bytes; buckets outside every recovered
function are reported as `unmapped`, not folded into a neighbour.

```
python3 gamecube/recomp/sr/profile_map.py            # -> /tmp/sab_hot.json
samples 15478   unmapped 476 (3.08%)
functions touched 2033 of 4741 recovered
0x80117e40     112B     1008.0    6.51%  cum   6.51%   zz_80117e40_
0x8011fff4     304B      798.1    5.16%  cum  11.67%   zz_8011fff4_
0x80117eb0      92B      720.0    4.65%  cum  16.32%   zz_80117eb0_
0x800f3780     152B      638.6    4.13%  cum  20.45%   zz_800f3780_
0x80003140     276B      603.1    3.90%  cum  24.34%   zz_80003140_
0x80117df8      72B      576.1    3.72%  cum  28.07%   zz_80117df8_
0x80120158     648B      530.2    3.43%  cum  31.49%   zz_80120158_
0x800f3718     104B      518.8    3.35%  cum  34.84%   getCurrentFieldEvenOdd
0x800fa704    1292B      496.3    3.21%  cum  38.05%   HandleReverb
```

Two things follow that matter for §8:

- **The workload has a long tail.** 2,033 distinct functions are touched and it takes ~47
  of them to reach 66% of samples. There is no small hot set to hand-optimise.
- **The DOL-only build covers 96.92% of the executed samples on this scene** — 15,002 of
  15,478 inside the DOL's `.text`, 449 (2.90%) at `0x80bc____` (the OSAlloc arena, i.e. an
  overlay), 27 below `0x80003100`. So the "overlays are 93.64% of the instructions"
  figure, which is about *static code*, badly overstates the runtime gap **on this
  scene**. City Escape gameplay with `stg13D` resident would shift it substantially, and
  that has not been measured.

### 8.4 The honest reading

On the one comparison that can be made today — translated code versus the JIT's
whole-system rate, which favours the recompiler — static recomp measures
~~**0.50x-0.67x against 0.4450x**~~. Weighting by measurement quality (§8.1a), the
number to carry is the hot-path one:

| | ~~translated-code rate~~ | ~~vs JIT 0.4450x~~ | ~~still needed for 1.000x~~ |
|---|---|---|---|
| `HandleReverb`, hot, 3% control, 2 runs | ~~0.50x-0.54x~~ | ~~1.13-1.21x~~ | ~~1.86-2.00x~~ |
| four non-hot fixtures, aggregate | ~~0.621x~~ | ~~1.40x~~ | ~~1.61x~~ |

> **⛔ EVERY CELL OF THIS TABLE IS VOID — §8.6. Do not quote any of them, and do not
> rescale them.** Both columns failed, for unrelated reasons:
> 1. **The numerator is not a measurement of the verified computation.**
>    `HandleReverb` is **not bit-exact** — 308 spurious writes of `0xff` to
>    `0x802bba84..0x802bbcfb`, a page native only *reads* — and `perf_browser.mjs`'s
>    restore set (built from `fx.writes` only) does not cover them, so the corruption
>    persists and **rep 1 of ~160,000 timed invocations is the only one computing
>    native's answer**. The direction of the error is UNKNOWN. §8.6e.
> 2. **The `0.4450x` denominator is not reproducible** — re-reading its 40 s band out
>    of four fresh runs of one frozen binary returns **0.3338x–0.5097x**. §8.6c.
> 3. Secondary, and it was in SR's favour: the numerator used a **static** CPI
>    (1.0774) where the JIT's cycles are **dynamic**. `HandleReverb`'s dynamic CPI is
>    **≤1.0017**, so those cells were additionally inflated by up to 7.55%. §8.6f.
> 4. The V8-tier mismatch this box used to warn about is real but measures
>    **null on both engines** (§8.6d). It was the least of the four.

**What replaces it is only half a comparison, because only half of it survived.** The
JIT arm is re-measured and solid — `0.3781x` delivered, `141.6 MHz` executed, `23.2%`
idle-skipped, against the `373.5 MHz` that 1.000x costs on this scene, i.e. **2.64x
short**. There is **no static-recomp number to put next to it.** The paragraph below
therefore stands on its structural argument alone, not on any measured ratio: the SR
side has no host layer, no interrupts, no GPU, no audio, no OS scheduling, and a hot
cache, so *every* unknown still points the same way.

That is *not* the "it obviously escapes the ceiling" result the route was pitched on,
and it is *not* a refutation either, because the comparison is unequal in the
recompiler's favour and the host layer that would close the gap is unbuilt. **The
decisive experiment is still the one nobody has run: SAB executing continuously through
the recompiled image with a host layer under it.** The blocker for that is §6's
`OSSaveContext`/`OSLoadContext` pair plus the ~66 privileged functions, not throughput.

What DID change decisively this session is §5j: before the split-dispatch fix, any
whole-image measurement would have read **~0.03x** and this route would have looked
dead on arrival for a reason that was entirely an artifact of how one switch statement
was emitted.

## 8.6 THE MATCHED RE-TAKE — the JIT arm holds, and the SR arm is VOID

Measured 2026-09-04. §8.1's boxed correction said the JIT-vs-SR ratio "must be
re-taken with both arms under the same flag." This is that re-take. It did not
produce a ratio, because **checking the SR arm's correctness before quoting its speed
found that the benchmark is not measuring the verified computation.**

### 8.6a The headline

| | verdict |
|---|---|
| **JIT arm** | **SOLID.** SAB attract scene, stock V8: **0.3781x delivered guest clock, 141.6 MHz executed, 23.2% idle-skipped.** Cross-witness spread ≤0.0005, n=3, independently corroborated. |
| **`0.4450x` (the old JIT denominator)** | **RETRACTED.** Not reproducible: the same 40 s band re-read from four fresh runs of one frozen binary returns **0.3338x–0.5097x**. |
| **SR arm** | **VOID — no static-recomp throughput number can be quoted today**, including `0.50-0.54x`, `0.62x` and `0.676x`. §8.6e. |
| **the comparison** | **CANNOT BE MADE.** Not for the V8 reason §8.1 flagged — that one measures null (§8.6d) — but because the SR measurand is broken. |

**What 1.000x actually costs on this scene**, since that half IS measured:

```
executed MHz needed for 1.000x = 486 MHz x (1 - idle-skip 23.2%) = 373.5 MHz
   the JIT executes 141.6 MHz  ->  2.64x short
```

### 8.6b The JIT arm

`node gamecube/tools/guest_rate_witness.mjs --only sab-cold-mips` (the standing
witness rig), `ROM_IDX=1`, `?bjit_mips=1`, frozen `PROBE_ROOT` snapshot, under
`tools/probe_lock.sh` with `PROBE_LOCK_MAX_LOAD=3`, orphan-reaped first. Stock V8 is
now the probe default (`d7c3415b`). Worker `.wasm` md5
`82bc8f8b6e1c6ac8db27ec0a5d49dadb`, checked before AND after every run and identical
every time. Medians over 20 five-second windows in `t ∈ [60,160] s`:

| run | V8 | delivered (W1) | W1≡W2≡W3 spread | credited | **executed** | **idle-skip** | drawn/s |
|---|---|---:|---:|---:|---:|---:|---:|
| `j-stock-r1` | stock | 0.3761x | 0.0003 | 182.8 MHz | 135.6 MHz | 22.7% | 21.2 |
| `j-stock-r2` | stock | 0.3781x | 0.0002 | 183.8 MHz | 141.9 MHz | 23.2% | 22.2 |
| `j-stock-r3` | stock | 0.3811x | 0.0002 | 185.2 MHz | 141.6 MHz | 23.3% | 22.1 |
| `j-nl-r1` | `--no-liftoff` | 0.3658x | 0.0005 | 177.8 MHz | 135.8 MHz | 22.9% | 21.6 |
| `j-nl-r2` | `--no-liftoff` | 0.3880x | 0.0003 | 188.6 MHz | 146.3 MHz | 22.8% | 22.4 |
| `j-nl-r3` | `--no-liftoff` | 0.3617x | 0.0002 | 175.7 MHz | 136.7 MHz | 22.8% | 21.0 |

**Independent corroboration.** `gamecube/docs/sab-frame-governor/TASKS.md` records
`[mips] EXECUTED=133.3 MHz` on the same disc and scene on 2026-09-01, a different
session and a different invocation. This campaign reads 135.6–146.3 MHz.

**The idle-skip is mandatory context, not a footnote.** 23.2% of the credited clock
is jumped over rather than executed, so `0.3781x` and `141.6 MHz` are two different
true statements about the same run and neither substitutes for the other
(`gamecube/docs/guest-rate-witness/TASKS.md` §F2/§F3).

### 8.6c Why `0.4450x` is retracted: the window was a lottery

§8.1's baseline is a 75 s cold boot read over a single 40 s window. **SAB's boot is
not steady there.** Re-reading that band (`t ∈ [35,75] s`) out of this session's own
four runs — same disc, same frozen binary — gives **0.3338x, 0.3592x, 0.5010x,
0.5097x**, a 1.53x spread with `0.4450x` sitting in the middle of it.

The mechanism is visible per window: the boot transient reaches **1.0014x with 81.5%
idle-skip and executed collapsed to 90.2 MHz**, and the attract loop's tail enters
another idle phase at `t ≳ 160 s` (57–82% idle-skip). Between them sits ~100 s of
steady work at 22–23% idle-skip. **Only that band is comparable between runs**, which
is why every figure in §8.6b is cut to it.

The two arms are on the same scene: the hot profile that ranks `HandleReverb` #9 was
produced by `gamecube/docs/sab-frame-governor/TASKS.md` from `ROM_IDX=1
PROBE_DURATION_MS=75000`, a SAB cold boot. Screenshots at `t = 118 s`
(`/tmp/gcm/j-*/sab-cold-mips.png`) show fully rendered 3D at ~21 drawn/s.

> Two things the screenshots also show. (1) The arms sit at *different points of the
> attract sequence* at the same instant — one frame is the City Escape demo, another
> a Knuckles cutscene — so they are matched on scene, not frame-for-frame on content;
> the mitigation is the 20-window median over ~100 s of a flat series, and the
> residual is inside the quoted spread rather than separated from it. (2) **City
> Escape renders correctly from cold boot on this binary**, while the `sab-ingame`
> savestate cell draws the same level at 2.6/s behind a live HUD over a black world —
> a lead for that open question pointing at the restore, not the renderer.

### 8.6d The V8 tier is NOT resolvable live, on EITHER engine

`gamecube/docs/wasm-tier/TASKS.md` sizes the tier at 2.108x on emitted bodies with a
**1.164x** residual under stock V8, and voided its own live pair. This campaign took
the matched live pair — and found no resolvable effect on either engine. The JIT's
stock runs (0.3761 / 0.3781 / 0.3811) and its `--no-liftoff` runs (0.3658 / 0.3880 /
0.3617) **interleave**; the SR cells likewise straddle the flag inside their own
noise.

So the V8-tier defect §8.1 warned about is real as a *method* flaw and is now closed
by making both harnesses default to stock V8 (`d7c3415b`, plus the new
`PERF_JS_FLAGS` knob in `perf_browser.mjs` — **the SR harness previously had no way
to set a V8 flag at all, which is why the old pair could only ever be unmatched**).
But it is **not what made the old number wrong.** Stated as a limitation rather than
a refutation: this rig resolves ~6–7% at low load and 1.164x would have been visible;
that it is not is consistent with `wasm-tier`'s own "260 of 323 modules tier up
unaided".

### 8.6e ⛔ THE SR ARM IS VOID — the benchmark runs on corrupted state after rep 1

Before quoting the SR speed, its correctness was checked. It does not hold.

**1. `HandleReverb` is not bit-exact.** On a whole-image `-DSR_VERIFY` build whose
`sr_gen.c` is md5 `31ff4d0c2e893694d8f4009bcc07c9c3`, **byte-identical to the `-O2`
perf build's `sr_gen.c`** (same translated C, different compile flags),
`verify_fixture.mjs` returns, reproduced identically on two consecutive runs:

```
FAIL  0x800fa704  steps=14423 bl=0 stores=1481 write-events=3454 ... ps1-indep=true
        write events: want 3454, got 3762
        write event #134: want [0x3ece69]=a7 got [0x2bba84]=ff
SUMMARY  0 verified / 7 attempted / 5 refused / 2 MISMATCHED
```

Fault 0, unstaged 0, exit GPRs / FPR PS0 / CR / LR / CTR all match, final memory over
native's 3632 stored bytes matches. It fails on exactly one criterion — the ordered
write log — and it fails by doing **more** memory work: **308 spurious writes of
`0xff`** across `0x802bba84..0x802bbcfb`.

**2. That page is one the guest only READS.** Confirmed here directly from the
committed fixture, no build required:

```
restore-set bytes (from fx.writes): 3632      <- matches README 8.1a's "restore-set=3632B"
does the restore set cover 0x802bba84?  False
native write EA range: 0x803c0b88 .. 0x803fff58   (never touches page 0x802bb000)
initial_mem staged on page 0x802bb000: 640 bytes, 0x802bba80..0x802bbcff
```

So native stages 640 bytes there because the guest reads that structure, and never
writes one byte of it. The translation clobbers it.

**3. The corruption PERSISTS ACROSS REPS on the perf binary, so the benchmark is not
measuring the verified computation.** `perf_browser.mjs` builds its restore set from
`fx.writes` **only** and stages `initial_mem` once before the loop, so any byte the
translation writes outside `fx.writes` is never restored. Replaying the fixture
directly on the real `-O2` perf wasm `b0e35dc87ee1567bc5a1215a0dd42153`, staged
exactly as `perf_browser.mjs` stages it, reproduced the same **308** changed bytes on
that page — a second instrument, a different binary, the same number — and then:

```
rep 2: fault=0x0  final-memory mismatches vs native = 839 / 3632
rep 3: fault=0x0  final-memory mismatches vs native = 839 / 3632
rep 4: fault=0x0  final-memory mismatches vs native = 839 / 3632
```

With the defaults `PERF_REPS=20000 × PERF_TRIALS=7` plus a warm-up pass, **rep 1 is
the only one of ~160,000 timed invocations computing native's answer**, while
`fx.steps = 14423` — the oracle's count for rep 1 — is divided by the mean wall time
of all of them. **The denominator does not describe the numerator.**

**Direction of the error is UNKNOWN.** Nobody has measured whether the
corrupted-input reps are faster or slower than the correct one, so `0.50-0.54x` is
not "too high" or "too low" — it is not a measurement of a defined quantity. Do not
salvage it by applying a correction factor.

> **The harness asserted a correctness property it does not have.**
> `perf_browser.mjs`'s header says its fixtures are "already verified bit-exact by
> `verify_fixture.mjs` / `verify_slice.mjs`". That is now known false for the one
> fixture carrying the headline. **The four `0x80111xxx` fixtures behind the `0.62x`
> aggregate have not been audited** and must be treated as unverified until they are.
> The `-O2` perf build also **structurally cannot host the verify harness** —
> `build_slice.sh` exports only `_sr_init/_sr_ram/_sr_ram_size/_sr_state/_sr_state_size/_sr_call/_malloc`
> with no `-DSR_VERIFY`, while `verify_fixture.mjs` needs `sr_fixture.js` from
> `build_fixture.sh` — so **speed and correctness have never been measured on the
> same binary.** That is the gap that let this through.

### 8.6f The CPI conversion was also wrong, in SR's favour

Independent of the above, and load-bearing for any re-take. §8.1a multiplies SR by a
**static** CPI of 1.0774 while the JIT's credited cycles are **dynamic** (charged per
block execution), so the two sides were not in the same unit.

The static figure itself reproduces exactly — `HandleReverb` is 323 instructions
costing 348 Gekko cycles, 348/323 = **1.077399**, using `num_cycles` from
`GekkoOPTemplate` in
`gamecube/dolphin-src/Source/Core/Core/PowerPC/PPCTables.cpp` (9 tables, 243 entries;
**34 of them carry `num_cycles > 1`, not the 40 §8.2 states** — 40 is the `!= 1`
count, which also catches five `Subtable` dispatch stubs and `unknown_instruction` at
0 cycles). But the *dynamic* CPI is far lower: the function has **exactly one
backward edge** (`bdnz` at `0x800fa9e4` → `0x800fa850`) and **all five multi-cycle
instructions sit outside that loop** (`stmw` prologue, `lmw` epilogue, `mtctr`, two
`mulli`), so at most 25 extra cycles are ever charged:

```
dynamic CPI <= (14423 + 25) / 14423 = 1.0017
```

Corroborated by the fixture's own write log: the 45 store PCs outside the loop each
executed once, the 9 inside executed 159–161 times. **The static 1.0774 overstates
this fixture by up to 7.55%.** Any future SR number must convert dynamically, or
report guest instructions per second and not convert at all.

### 8.6g What a valid re-take needs

1. **Fix the 308 spurious writes**, or establish which store is mis-targeted. Not
   diagnosed here — nobody disassembled the emitted C for that store.
2. **Make `perf_browser.mjs` fail loud instead of silently drifting.** It already
   re-checks `fault` after the benchmark; it does **not** re-check state. Comparing
   final memory against the fixture after the last rep would have caught this on day
   one, and is cheap.
3. **Measure speed and correctness on the SAME binary** — today `-O2` cannot host the
   verify harness at all.
4. **Audit the four `0x80111xxx` fixtures** before `0.62x` is quoted again.
5. **A scene-locked JIT arm.** The cold-boot attract loop works but is content-mixed;
   the in-repo SAB savestate is unusable until the black-world defect is resolved.

### 8.6h The honest reading

**The strategic question is not answered, and it is less answered than it looked
yesterday.** What is known:

- The **JIT** side is now measured properly for the first time: `0.3781x` delivered
  with `23.2%` of the clock skipped, `141.6 MHz` executed against the `373.5 MHz`
  that 1.000x costs on this scene — **2.64x short**, on the V8 configuration a
  visitor actually gets.
- The **static-recomp** side has **no valid throughput number at all.** The premise
  it was pitched on — "this escapes the JIT ceiling" — remains exactly as unproven as
  it was before §8 was written, and the intermediate answer ("~1.1-1.2x the JIT") is
  withdrawn from both directions: its denominator was a lottery and its numerator was
  not a measurement of the verified computation.
- §8.4's structural conclusion is untouched and is now the *only* thing §8 supports:
  **the decisive experiment is SAB executing continuously through the recompiled
  image with a host layer under it, and the blocker is that host layer, not
  throughput.**

**Three sizings of this route have now evaporated under re-measurement.** The pattern
in all three is the same and is worth naming: a number was produced by a rig that had
never been asked to prove the thing it was timing was correct. The cheapest guard
against a fourth is item 2 above.


## 9. Whole-image runtime completeness, and the wall moving from TRANSLATION to VERIFICATION

Measured 2026-09-04, second pass. Three things were open. All three are now measured:
what fraction of SAB's image translates **and can execute**; what stops the rest, by
cause with counts; and whether the verified fraction is bounded by the translator, by
the capture rig, or by the scene.

### 9.1 The overlays' RUNTIME completeness was never measured. It is 99.5%.

`rel.py --translatability ALL` is an **instruction-form** figure. It does not say a
module can execute: under `--indirect` a `bctr` *translates* — into `sr_indirect()` —
and then **faults**, because a switch case is an address inside a function and not a
dispatchable entry. On the DOL that distinction is the whole gap between 82.0% and
99.4% (§5b). For the 76 overlays — 93.64% of SAB's static instructions — it had never
been measured, and `rel_emit.py`'s stg13D result was the only data point.

`gamecube/recomp/sr/rel_jt_census.py` (new) measures it across every overlay, with the
**unrelocated arm run as a control**, so the effect of applying OSLink's `Relocate()`
offline is measured here rather than generalised from one module.

```
python3 gamecube/recomp/sr/rel_jt_census.py \
  --iso "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso" --raw-arm
```

| | relocated | raw (control) |
|---|---|---|
| `bctr` sites (de-duplicated) | 1,195 | 1,195 |
| jump table **RECOVERED** | **1,189 (99.5%)** | **0 (0.0%)** |
| case targets recovered | 18,246 | 0 |
| …inside the same function (label) | 17,015 | — |
| …another function start (tail call) | 1,231 | — |
| …**misaligned, mid-other-function, or outside** | **0** | — |
| runtime-complete instructions | **5,544,279 / 5,549,017 (99.91%)** | 5,103,003 (91.96%) |

**74 of the 76 overlays are at 100%.** All 6 refusals are in two modules —
`advertiseD.rel` 5, `titleD.rel` 1 — and each is named: 4 `table word not in image`
where the table lives in a **BSS section**, whose runtime address genuinely is not
derivable from the file (`OSLink.c:236-240` assigns it from OSLink's `bss` pointer) and
must come from `__OSModuleInfoList`; 1 `table base r4 defined by op31` (the base is
computed, not materialised by `lis`/`addi` — the same class as the DOL's 2 refusals);
and 1 with no `lis`/`addi` at all. The census gives BSS and the null section a base in
a distinct `0xB0......` window precisely so a table landing there is **visibly** not a
code address rather than resolving to a plausible one.

Three things are worth carrying:

- **The control arm is the point.** 1,193 of the 1,195 raw-arm refusals are
  `table word 0 at 0x00000000 not in image` — the shipped file words are
  `R_PPC_ADDR32` placeholders and the data section is not even in the image. Applying
  `Relocate()` offline is not an optimisation here, it is the entire mechanism.
- **Zero of the 18,246 recovered targets is bogus.** A mis-recovered table base
  produces garbage addresses and none appear — the same static check §5b applied to
  the DOL's 3,983, at 4.6x the scale.
- **⚠ A site whose two overlapping bodies DISAGREE is reported, not resolved.** One
  exists (`CartD.rel`). The cause is structural: `recover_jump_table`'s backward
  def-chain walk is bounded by the body's own start (`sr.py:230`, `:262`), so a body
  that begins after the `lis` cannot see the table base. The first body's verdict is
  taken and the disagreement is counted.

> **TWO DENOMINATOR BUGS THIS CENSUS FOUND IN ITSELF.** Both inflated a headline, and
> both are the same shape as traps already documented here.
>
> 1. **Reachability bodies OVERLAP, so counting per body double-counts.** The first run
>    reported **1,818** `bctr` sites; a linear scan of the same sections finds
>    **1,195**, i.e. the per-body figure was **1.52x** the truth and both the numerator
>    and denominator of "99.1% recovered" were wrong. Instructions are worse: summed
>    bodies come to 7,184,226 against 5,549,017 distinct — **29.5% double-counted**,
>    *exceeding the executable sections themselves*. Only the union may be quoted. This
>    is §3's 9.82% DOL-map trap, resurfacing on the overlay side.
>    **`stg13D`'s recorded "0 of 23 → 23 of 23" was 23 body-visits of 15 distinct
>    sites** (linear scan: 15 `bctr`, 0 `bctrl`). The ratio was right; the denominator
>    was not.
>    The census now runs the linear scan as its own control on **every** run and
>    **raises** if the de-duplicated count exceeds it. Both instruments now agree
>    exactly at 1,195 — and `rel.py --translatability ALL`, which derives its
>    `1195 bctr/bctrl` a third independent way, agrees too.
>    *(The DOL needs no such correction: its `outer+calls` boundary set was checked and
>    has **zero** overlap — summed 374,807 = union 374,807 — and a linear scan finds
>    exactly the 147 `bctr` the census reports inside mapped `.text`, plus 12 `bctr`
>    and 1 `bctrl` bit-patterns that lie in DATA segments. So §5b's "not a single
>    `bctrl` in the image" is right about code; the one `bctrl` encoding is data at
>    `0x80176034`.)*
> 2. **A missing base raised instead of counting.** `Rel.relocate()` looks the base up
>    *before* it dispatches on relocation type, so a `R_DOLPHIN_NOP` naming section 0 —
>    which writes nothing — still raised, and 4 overlays were silently absent from the
>    first aggregate.

### 9.2 Whole image

| | instructions | runtime-complete |
|---|---|---|
| `main.dol` (mapped `.text`, `outer+calls`) | 374,807 | 372,401 (99.36%) |
| 76 `.rel` overlays (de-duplicated) | 5,549,017 | 5,544,279 (99.91%) |
| **total** | **5,923,824** | **5,916,680 (99.88%)** |

Both DOL figures reproduce exactly (`sr.py --jumptable-census`: 145 of 147 sites,
122 of 123 functions, 3,983 targets; `--coverage --indirect --jumptables`: 4,674 of
4,741 functions, 372,769 instructions). The published overlay baseline reproduces too
(`5551313 decoded / 5549137 clean / 0 PRIVILEGED`). Before this pass the overlay half
was unmeasured; with its jump tables unrecovered the whole-image figure is **92.43%**.

**Translation is not the wall** — with the denominator attached: 99.88% of 5.92 M
PowerPC instructions translate *and* have every indirect branch statically resolved.

### 9.3 The DOL's real blocker is ONE function, and it is not a translator gap

Translating in isolation is not enough to build a fixture: the entry **and its whole
transitive callee closure** must translate, or the emitted code calls `sr_extern()` and
faults. §8.1d showed one instance. Measured across the whole DOL
(`fixture_dol.py --shapes-only`, which delegates to `rel_shapes.classify`):

| | functions | instructions |
|---|---|---|
| translate clean **with full callee closure** | **3,581 (75.5%)** | 240,714 (64.2%) |
| blocked | 1,160 (24.5%) | 134,093 (35.8%) |

and the blocked column is a handful of addresses, not a long tail:

| blocking callee | functions | instructions | what it is |
|---|---|---|---|
| **`0x800e78ac`** | **745** | **99,587 (26.6% of `.text`)** | `OSDisableInterrupts` — one `mfmsr` |
| `0x800e4e1c` | 99 | 10,855 | cache op `x470` |
| `0x800e78d4` | 91 | 7,508 | `OSRestoreInterrupts` — `mfmsr` |
| `0x800e4e4c` | 54 | 6,443 | `sc` |
| `0x8011c18c` | 16 | 1,048 | mid-function branch target |
| `0x80108e98` | 16 | 1,043 | `mfmsr` |
| (its own `mfmsr`) | 14 | 291 | |
| `0x800e55d4` | 13 | 908 | `mfmsr` |

**One 20-byte guest function blocks 745 others — 15.7% of the image's functions and
26.6% of its instructions — purely by sitting in their closure.** That is not a
translator hole (the GAP class is still zero, §5); it is §6's host boundary, sized
statically there at 66 functions / 0.54% of `.text`, re-sized here by its **blast
radius**. **Read that 745 as a first-blocker attribution, not as what removing this
callee buys** — §9.7 host-implements it and measures the answer at **+499**, because
265 of the 745 reach a second, unrelated boundary as well and `rel_shapes.classify`
stops at the first. It is owned by the concurrent context-switch work (`sr_host_os.c`, whose
trace events already include `SR_EV_DISABLE_IRQ` / `SR_EV_ENABLE_IRQ` /
`SR_EV_RESTORE_IRQ`); this table is what landing it is worth. Nothing here implements
it — it is left as an explicit unimplemented boundary, and every candidate whose
closure touches it is excluded by construction.

### 9.4 Changing the DRIVING METHOD for `main.dol`, not the translator

The DOL had no survey. It had `fixture_nonleaf.py --discover` (arm breakpoints, count
hits) and then `--capture` **one address at a time**, each of which has to reach its
entry a **second** time — so a function that runs once per scene is refused, which is
exactly the class a survey is for. The overlays got `fixture_rel.py --survey` (capture
at the moment the breakpoint fires, `at_entry=True`); the DOL never did.

`gamecube/recomp/sr/fixture_dol.py` (new) is that survey for `main.dol`. It **reuses
`fixture_rel.survey_waves` unchanged** — `base = 0`, offsets are absolute guest
addresses — so it inherits all five hard-won properties instead of re-deriving them:
capture-at-fire, never abandoning a `cont` (this stub has no async break), a calibrated
rare-but-live control anchor, delete-on-fire enumeration, and leaving enumeration early
while control is still available. Candidates are gated **offline** on closure-clean
translation under the same `--indirect --jumptables` the whole-image build uses (§9.3),
then selected round-robin across shape buckets, rarest first.

Two runs, same parked City Escape savestate, oracle `/Applications/Dolphin.app`
(STATE_VERSION 177), connect `pc=0x801012b4` — the §5h restore tell, so the state
loaded rather than cold-booting. Both under `tools/probe_lock.sh`.

| | armed | executed here | captured | usable |
|---|---|---|---|---|
| run 1 (shape-spread sample) | 300 | 66 | 65 | 59 |
| run 2 (**every eligible entry**) | 2,704 | 373 | 372 | 336 |
| **distinct** | | | **375** | |

**Every capture wave took 100% of its live set** — 23/23, 24/24, 18/18 in run 1 and
32/32 nine times in run 2, i.e. **437 of 437 attempts**, at ~2.5 s each. (The one
executed entry per run that is not captured is the control anchor, which `survey_waves`
excludes from its own waves by construction.) Nothing was lost to the "never reached
again" refusal that dominated the one-at-a-time flow. **All 2,331 run-2 refusals have a
single cause: `never executed in this scene`.**

### 9.5 RESULT — 330 DOL functions verified bit-exact, and one real translator bug

Replayed against a **whole-image** build (all 4,671 translated functions, `--indirect
--jumptables`, `-O0`, wasm md5 `402d92fbc37861830d9565e73f1e92ab`, identical before and
after every run):

```
SUMMARY  385 verified / 437 attempted / 42 refused
```

De-duplicated across the two runs: **330 distinct DOL functions PASS**, 8 FAIL, 37 SKIP.
For scale, the entire prior DOL record was 4 leaf functions + 7 non-leaf + 3 `blrl` +
1 `bctr`. **No entry passes in one run and fails in the other**, which is a free
consistency check on 55 functions captured twice from independent invocations.

**44 of the measured top-120 hot functions are verified, covering 19.92% of sampled
PCs** (`profile_map.py`). §8.1c's attempt at the hot path was *11 attempted, 2 usable*;
the difference is not a better rig, it is that the locked L1 stopped being a blanket
refusal (§5k) and that capture stopped costing a second traversal.

#### The one real divergence, and it was found BY EXECUTION

Of the mismatches, exactly one carried **no fault** — `0x80023ba0`, 492 of 495 write
events identical, differing in a single byte:

```
write events: want 495, got 492
write event #287: want [0x3c11eb]=1 got [0x3c11eb]=0
```

That byte is the high word of an `stfd` at `0x801115ec`, and the value stored was
produced by `fctiwz f0, f0` one instruction earlier at `0x801115e8`. `fctiwz` leaves the
high 32 bits architecturally undefined, and the reference interpreter fills them by a
rule `sr.py` did not model —
`~/gc_refs/dolphin/.../Interpreter_FloatingPoint.cpp:135-137`:

```cpp
u64 result = 0xfff8000000000000ull | value;
if (value == 0 && std::signbit(b))     // "Based on HW tests"
  result |= 0x100000000ull;
```

A small **negative** operand that truncates to integer 0 is distinguishable from `+0`.
`sr.py` emitted only `0xFFF8000000000000ull | value`. Fixed; the fixture now passes with
all 495 write events bit-identical, and **620 `fctiwz` sites across 264 DOL functions
were exposed to it**.

> This is the argument for a *broad* differential in one data point. The gap is
> invisible to inspection, invisible to the 1,056 leaf vectors, invisible to the 7
> committed non-leaf fixtures, and only observable at all because the guest happens to
> spill the result to memory with `stfd` where the ordered write log can see it.

**Every remaining mismatch is a host-boundary fault, not a translation divergence**, and
the fault code names the callee: 4× `0xe00e78ac` (`OSDisableInterrupts`, `mfmsr`
— **all four are now PASSES, §9.7**), 5×
`0xe0113fc0` (`mtspr SPR913`), 1× `0xe1212248` (an indirect call into `stg13D` overlay
code, absent from a DOL-only build). All are on the 70-function skiplist or outside the
image, and all were reached through an **indirect** call — which the offline closure
gate cannot see. So that gate is necessary but not sufficient, and the residual is
§9.3's boundary rather than anything the translator got wrong.

> **A regression gate ran first, on both builds.** The committed non-leaf, `blrl` and
> `bctr` suites score **12 verified / 16 attempted / 0 mismatched** before and after the
> `fctiwz` change. That matters more than usual here: these builds link `gekko_rt.h` /
> `sr_driver.c` from a working tree a concurrent agent was editing, so each snapshot's
> inputs were hash-recorded and the prior results re-proved before any new number was
> taken.

#### The jump-table control arm, at 47x its previous scale

`--jumptables` may only be credited on fixtures whose captured trace actually executed a
`bctr`, and the pass must be paired with a build in which an unreached path faults.
`survey_report.py --bctr-json` extracts exactly those, replayed against two whole-image
builds **one flag apart**:

| arm | wasm md5 | result |
|---|---|---|
| `--indirect --jumptables` | `402d92fbc37861830d9565e73f1e92ab` | **43 verified / 47** (4 = the `0xe0113fc0` boundary fault) |
| **control: `--indirect`, NO `--jumptables`** | `93965999105a20bbb267bae06120878a` | **0 verified / 47** |

Every control-arm failure is accounted for: **46 fault `0xE1......`** — `sr_indirect`'s
"unresolved indirect target" — naming a mid-function switch label, and **1 exhausts the
host stack**. That last one is worth keeping: where a recovered case label *coincides*
with a function start, `sr_indirect` happily dispatches to it, the callee re-enters from
the top, and the result is unbounded host recursion rather than a clean fault. So the
no-jumptables build does not merely refuse — it can diverge silently until the stack
dies. (Scored one process per fixture; a single crash otherwise truncates the run.)

That takes the `--jumptables` evidence from **one** function verified by execution
(§5b) to **43**, with a 47-for-47 falsifying control.

#### `blrl` dispatch, proven offline from the captured trace

`survey_report.py` recomputes, per fixture, the functions reachable from the entry
through **direct `bl` edges only**, and reports which members of the trace's `entered`
set fall outside it — those can only have been reached through an indirect branch.
**48 of 48 `blrl`-executing fixtures carry that proof** (one entered 68 functions of
which 67 are unreachable directly). This is §5b's argument mechanised, so it is re-run
rather than re-written.

### 9.6 The honest reading, and what is still open

The bound on verification moved, and it is worth being exact about where it now sits:

- **Capture cost is no longer the constraint.** 437 of 437 attempts succeeded at ~2.5 s
  each.
- **The scene is the constraint, and it binds far less on the DOL than on an overlay.**
  373 of 2,704 eligible DOL entries (13.8%) execute in the parked City Escape scene;
  the comparable overlay figure was 16 of 734. **The way to more breadth is more
  SCENES, not a faster rig** — a second savestate is now the highest-value input to
  this route.
- **330 verified is 6.96% of the image's 4,741 functions**, and 44 of the top-120 hot
  ones. That is the honest fraction; the other 93% is unverified, most of it because
  this scene never runs it.

What this does **not** show:

1. Nothing here is a throughput measurement. §8's numbers are untouched (and carry
   their own correction — see the boxed note in §8.1).
2. `usable` is derived conservatively: a `ps1_dependency` marks a capture unusable here
   as it does in `fixture_nonleaf.py`, even though `verify_fixture.mjs` would also
   catch a real dependence by replaying twice. 11 captures were refused on that basis.
3. **A second, unobserved `fctiw` gap is left open and named.** `fctiw` (xo=14, **8
   sites in 1 DOL function**; `fctiwz` is xo=15 with 620) must round per FPSCR[RN], and
   `sr.py` truncates unconditionally. It is not a one-line fix: Dolphin's own reference
   (`RoundToIntegerMode`, `Interpreter_FloatingPoint.cpp:37-49`) implements it with the
   2^52 add/subtract trick, which **delegates to the HOST rounding mode** — and wasm has
   no dynamic rounding mode to set. Modelling the three non-default modes needs an
   explicit transcription, and until it exists this is an approximation living inside a
   translator whose stated contract is to refuse rather than approximate.
4. The offline closure gate cannot see indirect callees, so a candidate can still reach
   the host boundary at run time (8 did). §9.7 removes the MSR half of that boundary:
   4 of those 8 now pass, with the boundary-off control arm proving the primitive is
   what carries them. The rest reach `mtspr SPR913`, which is still unbuilt.

### 9.7 The MSR/interrupt host boundary — BUILT, and the 745 is +499 not +745

`0x800e78ac` `OSDisableInterrupts` is host-implemented, together with the six
sibling addresses the closure measurably requires. Reproduce every number below with:

```bash
# the closure delta, both arms from ONE process and ONE classify() implementation
python3 gamecube/recomp/sr/fixture_dol.py --shapes-only --irq-hosts --new-only
# the containment audit (exit 2 if any EMITTED body could observe MSR)
python3 gamecube/recomp/sr/sr.py --image /tmp/sr_sab/main.dol --map dolphin_captures/sab.map \
  --boundaries outer+calls --indirect --jumptables --msr-audit \
  --host 0x800e78ac --host 0x800e78c0 --host 0x800e78d4 \
  --host 0x800e3494 --host 0x800e349c --host 0x80108e98 --host 0x80108ea0
```

#### The set, chosen by leave-one-out rather than by name

`sr_host_os.c` already carried byte-exact transcriptions of the three
`OSInterrupt.c` primitives (they were built for the context switch); what was
missing was a way to link them **without** the thread pool, a `--host` set for the
closure gate, and a measurement. `SR_OS_IRQ` (`sr_host_os.h`) is that mode: it
answers for the MSR family and nothing else, adds exactly one word of host state
(`g_msr`), creates no host thread and needs no `-pthread` — `sr_os_init_irq()`.
`__TRK_get_MSR` / `__TRK_set_MSR` are `mfmsr r3; blr` and `mtmsr r3; blr` verbatim
(SAB links two byte-identical copies of each), i.e. the same primitive, so they are
in the same boundary.

Closure-clean DOL functions, `sr.closure_of(..., hosts=)`, whole `outer+calls` set:

| host set | closure-clean | vs baseline |
|---|---|---|
| baseline (none) | **3,581** / 4,741 | — |
| all seven | **4,080** / 4,741 | **+499 functions, +73,972 instructions = 19.74% of `.text`** |

**The unit is the PAIR, not the function**, and this is why "measure, don't guess"
was the instruction:

| address | alone | dropped from the seven |
|---|---|---|
| `0x800e78ac` `OSDisableInterrupts` | +65 | **−492** |
| `0x800e78d4` `OSRestoreInterrupts` | +4 | **−431** |
| `0x800e78c0` `OSEnableInterrupts` | +1 | −1 |
| `0x800e3494` `__TRK_get_MSR` | +1 | −1 |
| `0x800e349c` `__TRK_set_MSR` | +1 | −1 |
| `0x80108e98` `__TRK_get_MSR` | +3 | −6 |
| `0x80108ea0` `__TRK_set_MSR` | +1 | −4 |

`OSDisableInterrupts` on its own is worth **65**; in the presence of
`OSRestoreInterrupts` it is worth **492**. Almost every caller brackets
`level = OSDisableInterrupts(); … ; OSRestoreInterrupts(level)`, and a closure is an
AND — freeing one leaf of a pair frees nothing. Neither is a majority of the 745 by
itself; together they are.

#### §9.3's "745" is a FIRST-BLOCKER attribution, not a blast radius

`rel_shapes.classify` stops at a function's first blocking callee, so its histogram
answers "which callee did I trip over first", not "what does removing this callee
buy". `sr.closure_of` collects **every** blocker, and against the same 745:

| | functions | instructions |
|---|---|---|
| of the published 745, **UNBLOCKED** | **480** | 72,622 |
| of the published 745, **still blocked** | **265** | 26,965 |
| newly clean whose first blocker was something *else* | +19 | +1,350 |
| **net** | **+499** | **+73,972** |

> **A denominator bug this measurement had, and the control that caught it.** The
> first pass reported **+506**. A host-bound address has an EMPTY closure walk by
> construction — the walk stops at it — so `rel_shapes.classify` scored all seven as
> "translates clean" and they landed in the newly-unblocked set. They are not
> candidates: `sr.py` drops them from the emitted set (`sel -= hosts`), so there is no
> translated body to capture a fixture against. Exactly 7 functions and 27
> instructions of inflation, and the tell was a passing fixture reporting that it had
> "executed a newly-unblocked function" which turned out to be `0x800e78ac` itself.
> `classify` now refuses a host-bound entry by name. Same class as §9.1's overlapping
> reachability bodies: a count that is right about everything except what it counts.

**265 of the 745 do not move**, because their closure reaches a second, unrelated
boundary. Named, with complete blocker sets (a function can appear twice):

| next blocker | of the 265 | what it is | owner |
|---|---|---|---|
| `0x800ecb48` `OSGetTime` | 208 | `mfspr` time base (`op31 xo=371`) | unclaimed — the largest remaining single boundary |
| `0x800e34bc` (map: `PPCMtwpar`) | 145 | `7c7603a6` = **`mtspr SPR22`** — the DECREMENTER, not WPAR; `sab.map` is partial so read the name as approximate | with the clock, below |
| `0x800e55d4` `OSSetCurrentContext` | 89 | `mfmsr` + MSR[FP] | context switch (`sr_host_os.c`, already written) |
| `0x800e56bc` `OSLoadContext` | 86 | `rfi` | context switch |
| `0x800e563c` `OSSaveContext` | 86 | the setjmp | context switch |
| `0x800e4e4c` `DCFlushRange` | 53 | `dcbf` loop + `sc` | unclaimed cache-maintenance boundary |
| `0x800e4e1c` `DCInvalidateRange` | 52 | `dcbi` loop | same |
| `0x800ecb60` `OSGetTick` | 28 | `mfspr` time base | with `OSGetTime` |
| `0x800e34c4` `PPCSync` | 13 | `sync` | — |

So the honest headline is **+499 of a claimed 745**, and the next thing worth
building on this route is a host **CLOCK**, not more of the interrupt boundary. Read
from the shipped words rather than the map names, the clock is bigger than any single
row above: `OSGetTime` is a `mftb`/`mftbu` retry loop (`op31 xo=371`), `OSGetTick` is
one `mftb`, and `0x800e34bc` is `mtspr SPR22` — the decrementer. That is 208 + 28 +
145 blocked-function memberships across three addresses that are all one facility.
`sr_host_os.c` already owns the pattern: one word of host state behind a handful of
byte-exact transcriptions.

#### What the 499 are worth, against the MEASURED workload rather than `.text`

`profile_map.py` against the same recorded SAB PC histogram §8.5 uses:

**7 of the measured top-120 hot functions are in the 499, and they carry 14.49% of
all sampled PCs** — `0x80117eb0` (5.90%), `0x800f3780` (5.23%), `0x800fe130` (0.91%),
`0x800f13a8` (0.90%), `0x800f135c` (0.76%), `0x800f3694` (0.67%), `0x800ff870`
(0.13%). For scale, the entire verified DOL record of 330 functions covers 19.92%
(§9.5), and **not one of these seven was ever armable** — the closure gate excluded
all of them from every arm list ever built.

`0x800f13a8` is worth naming: it is the function §8.1d recorded as
`SKIP 0x800f13a8 faults 0xe00e78ac`, the observation this whole boundary was sized
from. Its closure is clean now.

That was a **static** claim when written — closure-clean and therefore armable.
`0x800f13a8` has since been captured and verified bit-exact (below); the other six of
the seven have not.

#### Is a one-word MSR a lie the guest can detect? Enumerated, not argued

`sr.py --msr-audit` lists every function in `main.dol` containing an instruction
that can observe or alter MSR — `mfmsr`, `mtmsr`, `rfi`, and `mfspr`/`mtspr` naming
SRR0/SRR1 (`rfi` does `MSR <- SRR1`, so SRR1 is an MSR alias) — and classifies each:

```
28 functions can observe MSR: 7 host-bound, 21 refused, 0 EMITTED
PASS: no emitted body can reach MSR except through the host boundary.
```

**Zero** translated bodies in the whole-image build can materialise an MSR access.
The other 21 (`__LCEnable`, `__OSDBIntegrator`, `__DBExceptionDestination`, the TRK
debugger stubs, the exception vectors) are refused by the translator and remain
explicit faults. So `g_msr` is not an approximation of a register the guest can also
read some other way — **within the emitted image it is the only representation of
MSR that exists**, and it is exact on every path that can reach it. The audit exits
2 if that ever stops being true.

What this does **not** cover, and it is unchanged by this work: MSR[EE]'s *effect*.
There is no interrupt delivery in this runtime (§6 / `CONTEXT_SWITCH.md` §7.1), so
EE gates nothing, and a guest that spins waiting for a flag an ISR would set still
never leaves the loop. The bit's *value* is modelled exactly; its *consequence* is
not modelled at all, and that is the pre-existing hole, not a new one.

One named residual: `sr_indirect` (`sr_driver.c:58`) does **not** consult
`sr_host_hook`, so an indirect (`blrl`/`bctr`) call landing on a host-bound address
would fault `0xE10E78AC` instead of being serviced. Left as a loud, correctly-named
refusal rather than fixed speculatively: no committed fixture reaches one that way
(`os_boundary.txt:33` records 212 **direct** `bl` sites for `0x800e78ac`), and the
4 fixtures below reach it through direct `bl` inside indirectly-reached callees.

#### Verified BY EXECUTION, with the control arm inside the same binary

Whole-image `-O2` build, `--indirect --jumptables --boundaries outer+calls` plus the
seven `--host` addresses, linked `SR_HOST_OS=1`. wasm md5
`c06edbbfb073ebc50cbb29fffa936b98`, **identical before and after both arms**. Machine
load 2.2–4.1 throughout. Inputs hash-recorded, because this build links two files a
concurrent agent was editing: `gekko_rt.h` blob
`73d9d97fd8a876b97877e3c49cf29e753965a4a7` and `sr_driver.c` blob
`f17627d5d28c1acf6e08856373600ce04d1a80fc`, both as at `f80a1ee1` — `gekko_rt.h` has
been modified in the working tree since, so a rebuild will NOT reproduce this md5.

The emitted set is *unchanged* at 4,671/4,741 functions —
all seven host-bound addresses were already refused, so nothing new is translated;
what changes is only whether a `bl` to one of them faults.

The routing is wired and countable: the generated whole-image C contains **no body**
for any of the seven and reaches them through `sr_extern` at **469 call sites** —
212 for `OSDisableInterrupts`, 246 for `OSRestoreInterrupts`, 4 for
`OSEnableInterrupts`, 7 across the four TRK accessors. The 212 is an independent
corroboration: `os_boundary.txt:33` counted 212 direct `bl` sites for `0x800e78ac`
from the raw binary, by a different instrument.

`verify_fixture.mjs` now seeds `g_msr` from `state_in.msr` per fixture and **scores
MSR as an output** against `state_out.msr` (454 of the 456 committed captures have
`state_out.msr == state_in.msr`; the two that do not are truncated captures already
refused). It also counts host-boundary crossings per fixture, so a pass that never
touched the boundary cannot be mistaken for evidence about it.

**The control arm is `SR_OS_MODE=0` on the SAME binary** — one md5, so the pair
cannot be confounded by a relink (the trap CLAUDE.md gate #10 records):

| arm | verified | attempted | mismatched |
|---|---|---|---|
| `SR_OS_IRQ` | **401** | 453 | 6 |
| **control, boundary OFF** | 397 | 453 | 10 |

The delta is exactly **4**, and they are exactly the 4 fixtures the host arm reports
as having crossed the boundary (`host-calls=4` each): `0x80123cec` (captured twice,
in both surveys), `0x801307cc`, `0x80132ab8`. With the boundary off each fails

```
fault=0xe00e78ac: DIRECT call to 0x??e78ac is outside the emitted set
        r4 want=0     got=10
        r5 want=9032  got=0
```

— i.e. the control does not merely fault, it is missing precisely the values the
primitive produces (`r5` = the restored MSR, `r4` = the EE bit `OSRestoreInterrupts`
returns). **4 of 4, 0 of 4 without.**

**And the seeding itself is falsifiable, not decorative.** Replaying `0x80123cec`
against the same binary with three different seeds, everything else identical:

| `sr_os_set_msr` seed | host-calls | fault | `r4` | `r5` | MSR out | |
|---|---|---|---|---|---|---|
| `0x9032` = `state_in.msr` | 4 | 0 | `0` | `9032` | `0x9032` | **PASS** |
| `0xb032` | 4 | 0 | `0` | `b032` | `0xb032` | FAIL |
| `0x1032` | 4 | 0 | `0` | `1032` | `0x1032` | FAIL |

`r5` tracks the seed exactly, which is the primitive doing its job — `mtmsr` writes
the restored MSR and the caller sees it. `0xb032` is not a hypothetical: it is the
MSR in **327 of the 372** captures in `sab_dol_survey_all.json`, so any
boundary-crossing fixture from the ordinary City Escape scene would have failed on
`r4`/`r5` with `sr_host_os.c`'s compiled-in default. These three passed only because
they happen to have been captured at `0x9032`. The 6 remaining mismatches are the
pre-existing ones §9.5 already names — 5× `0xe0113fc0` (`mtspr SPR913`) and 1×
`0xe1212248` (an indirect call into overlay code absent from a DOL-only build) — and
the 4× `0xe00e78ac` §9.5 recorded are gone.

The committed context-switch suite is a regression gate on this change and is
unchanged: `verify_ctxsw.mjs` **63 passed, 0 failed**, including its own control arm
D (`sr_os_mode(0)` → `0xe00e78ac`).

#### Capturing the 499: what the first attempt cost, and the knob that caused it

The 499 have never been armed, so they need a fresh oracle run. The first attempt
**aborted with 0 captured**, and the cause is worth recording because it is a knob this
tool already documents:

```
[survey] anchor = +0x800e7c74, 2 hits in 60s = one per 30.0s; 58 candidates fired during calibration
[survey] enumerating which of 485 candidates execute here (delete-on-fire, up to 420s) ...
[survey]   50 fired, 435 still armed, t+4s
[survey]   60 fired, 425 still armed, t+126s
[survey]   90 fired, 395 still armed, t+182s
[survey] ABORTED: TimeoutError: timed out
```

485 candidates were armed (`--max-arm 500 --max-closure 160`) against the tool's
documented defaults of 300 / 40. `survey_waves`' own docstring says why that is the
wrong direction — *"with 300 breakpoints armed on per-frame functions the interpreter
is stopped almost continuously and buys almost no EMULATED time"* — and this set is
worse than a shape spread for exactly that reason: it is drawn from the newly-unblocked
pool, which is disproportionately **hot**. The trace shows it directly: 50 candidates
fired in the first 4 seconds and the next 10 took 122. Emulated time then crawled
slowly enough that the anchor's calibrated 30 s period stretched past the 180 s `cont`
deadline, and **abandoning a `cont` is not recoverable on this stub** (§9.4), so the
run ends rather than degrading.

Two things this does establish, at no extra cost:

- **At least 148 of the 499 execute in the parked City Escape scene** — 58 fired during
  the 60 s anchor calibration and 90 more during enumeration, all of them newly-unblocked
  entries. Against the baseline set's 373 of 2,704 (13.8%), this pool is far denser,
  which is what a hot pool should be.
- The failure is a **cost** knob, not a correctness one. Nothing here says the
  candidates are unreachable.

**The retry aborted differently, and that one I cannot explain.** Armed set cut to 148
entries that are both newly-unblocked *and* present in the measured SAB PC profile — so
every armed entry is known to execute somewhere, which the blind 485-wide enumeration
could not assume — with `--cont-timeout 400`. It died ~90 s in, inside the 60 s anchor
calibration:

```
[oracle] connected; pc=0x801012b4
[survey] calibrating an anchor over 60s ...
[survey] ABORTED: ConnectionResetError: [Errno 54] Connection reset by peer
```

**Cause undetermined.** What has been ruled out, each by looking rather than by
reasoning: no macOS crash report was written; `/tmp/sr_dol_oracle_9149.log` ends at
normal DSP init with no panic and is byte-for-byte the same length as every other
oracle log in this session; a sibling's teardown cannot have taken it, because
`native_oracle_gdb.Dolphin.kill()` is `self.proc.kill()` on its own pid, not a
pattern-matched `pkill -f Dolphin`; and the previous run survived the same calibration
phase with **more** breakpoints armed (485), which rules out armed-set size as the
direct cause. Recorded as an open, reproducible-or-not failure rather than attributed
to a guess.

**The third attempt worked, and it is the acceptance evidence.** 60 armed — ranks
3..62 of the same profiled list, with the two hottest entries (`0x80117eb0` 5.90%,
`0x800f3780` 5.23%) DROPPED, because an armed breakpoint on the hottest function in
the scene is exactly what `survey_waves` warns buys no emulated time. That one change
made enumeration finish in 27 s instead of timing out:

```
[survey] anchor = +0x800f4b2c, 5 hits in 45s = one per 9.0s; 14 candidates fired during calibration
[survey] no new candidate for 25s — ending enumeration early at t+26s
[survey] 14 of 60 candidates executed in 27s; 46 never did
[survey] wave done: 13/13 captured; 13 total in 33s
```

**All 13 captured entries are members of the 499** (checked, not assumed). Replayed
against the same whole-image build, md5 `c06edbbfb073ebc50cbb29fffa936b98` before and
after both arms, load 3.0–5.2:

| arm | verified | attempted | refused | mismatched |
|---|---|---|---|---|
| `SR_OS_IRQ` | **10** | 13 | 3 | 0 |
| **control, boundary OFF** | 3 | 13 | 3 | **7** |

The 3 refusals are `usable:false` at capture (unknown store forms), refused identically
in both arms. **The delta is exactly 7 — the 7 the host arm reports as having crossed
the boundary — and every one of them faults `0xe00e78ac` with the boundary off:**

| entry | shape | steps | captured MSR | control-arm diff |
|---|---|---|---|---|
| `0x800f13a8` | nonleaf | 40 | `0xb032` | `r4 want=0 got=802d49e0`, `r5 want=b032` |
| `0x800f3628` | nonleaf | 136 | `0xb032` | `r3 want=1`, `r5 want=b032` |
| `0x8013e824` | nonleaf+fp | 969 | `0xb032` | `r5 want=b032 got=3` |
| `0x800ebac4` | nonleaf | 28 | `0x1032` | `r4 want=0 got=1`, `r5 want=1032 got=0` |
| `0x800eba84` | nonleaf | 28 | `0x1030` | `r5 want=1030 got=77e3cb` |
| `0x80124164` | nonleaf+blrl | 100 | `0x9032` | `r3 want=1`, `r4 want=0` |
| `0x80123e90` | nonleaf+blrl | 93 | `0x9032` | `r3 want=1`, `r4 want=0` |

**7 of 7 with the boundary, 0 of 7 without**, on one binary. `0x800f13a8` is the
function §8.1d recorded as `SKIP 0x800f13a8 faults 0xe00e78ac` — the observation this
whole boundary was sized from. It is now bit-exact: all 5 write events, all 16 final
memory bytes, every GPR, FPR, CR, LR, CTR and MSR.

**This is also where MSR seeding stops being a synthetic argument.** Five of the seven
were captured at an MSR that is NOT `sr_host_os.c`'s compiled-in `0x9032` — three at
`0xb032`, one at `0x1032`, one at `0x1030` — and the control arm prints the wanted
value (`r5 want=b032`, `r5 want=1032`, `r5 want=1030`). Without seeding from
`state_in.msr` those five would have failed on `r4`/`r5` in the *host* arm too.

Also verified and worth separating out: `0x80024cb8`, `0x80141168` and `0x8013ba58`
pass in **both** arms — they are members of the 499 that this scene reaches without
touching the boundary. They are honest passes for the translator, not evidence for the
boundary, and the `host-calls` counter is what tells them apart.

Artifact: `gamecube/recomp/sr/sab_dol_irq_fixtures.json`.

**What these 4 are and are not.** They are proof the primitive is correct and
load-bearing — but their *entries* were already closure-clean, and they reach
`OSDisableInterrupts` through a `blrl`ed callee, which is §9.6's residual item 4.
**None of the 499 newly-unblocked functions is among them** (measured: zero overlap
between the newly-unblocked set and either committed survey), because the offline
gate excluded all 499 from every arm list ever built. Capturing them needs a new
oracle run, and the constraint on that is the one §9.6 already named — the scene,
not the rig.

## 10. THE WHOLE-IMAGE BOOT — it runs in a browser, and it stops at the first device

Everything above this section is a **fixture**: one function, or one closure, staged from
a native-Dolphin capture, run once, diffed. A fixture never executes `__start`, never
touches a device register, and never needs a value the hardware boot left in low memory.
This section is the first thing here that does.

New, all landed together:

| file | what it is |
|---|---|
| `recomp/sr/build_image.sh` | the whole-image build. `--all --indirect --jumptables --dispatch-out`, the 13-address guest-OS `--host` set, `-DSR_MMIO`, linked `-sENVIRONMENT=web,worker`. `SR_FNS="<addrs>"` is a seconds-long bring-up arm that builds one closure through the identical host layer and flags. |
| `recomp/sr/sr_image.c` | the boot host layer: DOL loader, SPR file, timebase, FPU-context copy, the device boundary, the boundary log |
| `recomp/sr_image/sr_image_worker.js` | the browser module worker: fetches `main.dol`, stages low memory, drives the guest |
| `recomp/sr_image/sr_image_boot.html` | standalone bring-up page |
| `tools/sr_image_probe.mjs` | the probe. `SRP_MODE=walk\|whole`, `SRP_WALK=<addr[:3=v+4=v]>,…`, `SRP_EXI=0`, `SRP_WATCHDOG=N`, `SRP_STRICT=1` |
| `gamecube.html` | `?srimage=1` routing (`GcRate.routeImage`), 9 new `?ratetest=1` assertions — 21j…21r |

`gekko_rt.h` is shared with every fixture in this directory, so the two additions to it
(the device window and the device hooks) are **`-DSR_MMIO`-gated and proven inert**
rather than argued to be. Compiling `sr_driver.c` and `sr_host_os.c` at `-O2` against
`HEAD`'s header and against the edited one gives **byte-identical object files** in both
existing modes:

| TU | mode | md5 (HEAD) | md5 (edited) |
|---|---|---|---|
| `sr_driver.c` | `-DSR_VERIFY` | `4ec9c15943b7…` | `4ec9c15943b7…` |
| `sr_host_os.c` | `-DSR_VERIFY` | `b0a34dfd32b9…` | `b0a34dfd32b9…` |
| `sr_driver.c` | plain | `6acf7f22067d…` | `6acf7f22067d…` |
| `sr_host_os.c` | plain | `130167114355…` | `130167114355…` |

The two are also made **mutually exclusive by `#error`**: `SR_VERIFY` owns `GK_RD`/
`GK_WPOST` for the differential's staged-read and ordered-write instruments, and
`SR_MMIO` needs the same two hooks for device semantics. Nothing needs both — but a
build that silently got one instrument instead of the other would produce a plausible
wrong answer.

### 10.1 What was measured

Two whole-image binaries, both `-O1`, both md5-identical before and after every run.
4,668 of 4,741 functions (98.46%) / 372,613 of 374,807 instructions (99.41%) translated;
73 host-bound or refused.

| | wasm | size | device layer |
|---|---|---|---|
| **A** | `0464002e92cecfaa3c1202484286249b` | 44,087,406 B | window only, no register modelled |
| **B** (headline) | `7bcca5756df27133d684c4281410171b` | 47,894,210 B | + EXI `TSTART` model, inventory, watchdog |

B is 8.6% larger: the device hooks put one compare against the window on every guest load
and store. That is the price of `-DSR_MMIO` and it is why no measurement build should
define it.

| acceptance step | result |
|---|---|
| 1. the image LINKS | **YES** — 0 errors (both A and B) |
| 2. the worker INSTANTIATES in a browser | **YES** — Chrome, module worker, `main.dol` 1,960,192 B laid into a 25,165,824 B MEM1, entry `0x80003140` |
| 3. guest code EXECUTES | **YES**, from the real entry point — `sr_image_boot()` → `sr_call(0x80003140)`, not a stepped walk |
| 4. something RENDERS | **NO**, and the cause is named in §10.2 / §10.2b |
| 5. `drawn/s` nonzero | **NO. Not claimed.** There is no renderer on this path at all. |

**Binary B, `whole` mode, the guest's own `__start`** (machine load 2.15–2.73):

| | model ON | model OFF (control, same md5) |
|---|---|---|
| distinct hardware registers reached | **27** — PI, MI, DSP/AI, SI, EXI, DI | **21** |
| device writes | 28 | 21 |
| EXI `TSTART` clears | 2 | **0** |
| host-boundary crossings | **126** (16 distinct) | 110 (13 distinct) |
| last register touched | `0xCC005012` DSP/AI write | `0xCC00680C` EXI read — *the spin* |
| ended by | watchdog, in `__OSInitAudioSystem` | watchdog, in `EXISync` |

**Binary B reproduces the closure builds exactly** — 126 crossings, 16 distinct addresses,
27 registers, same order — which is independent confirmation that the `SR_FNS` closure arm
is a faithful instrument and not an artefact of building less code.

Binary A is kept in this table because it is the *before*: with no register modelled at
all, the boot never got past the SRAM read, so its device inventory is the empty set and
its trajectory is the one in §10.2.

**On binary A — `__start`'s own callee sequence, one call at a time** (`SRP_MODE=walk`;
the sequence is exact because `__start` is straight-line on this boot — both its branches
test `0x800000F4`, which is 0 on a retail boot):

| # | guest fn | result |
|---|---|---|
| 1 | `0x80003254` `__init_registers` | returns, **fault 0**, r1 = `0x803c1450` |
| 2 | `0x80003330` `__init_hardware` | returns, **fault 0**, 22 boundary crossings |
| 3 | `0x80003270` `__init_data` | returns, **fault 0** — the `.data` copy + `.bss` clear loops ran |
| 4 | `0x800ecf08` `DBInit` | returns, **fault 0** |
| 5 | `0x800e362c` `OSInit` | **NEVER RETURNS** |

Walking `OSInit`'s own callees (weaker instrument — a standalone call sees the previous
step's registers, not its caller's arguments; noted as such in the worker) puts **16
consecutive guest functions through fault-free** and lands the hang precisely:

```
0x800ecb68 ✓  0x800e4b20 ✓  0x800e4b18 ✓  0x800e3970 ✓  0x800eb8dc ✓  0x800e3d84 ✓
0x800e888c ✓  0x800e7928 ✓  0x800e78f8 ✓  0x800e5ba8 ✓  0x800e5294 ✓  0x800e71b4 ✓
0x800ea98c ✓  →  0x800e9778  HANGS
```

`0x800e9778` is `__OSReadROM`, the SRAM read, and it is straight-line — no backward
branch — so the hang is in a callee. Walking those with the real arguments staged into
the GPRs (`EXILock(0,1,0)`, `EXISelect(0,1,3)`, `EXIImm(0,…)`, `EXISync(0)`) isolates it
to one function.

### 10.2 What stops it: **`EXISync` at `0x800e6494`**, and it is not a translator bug

```
800e6678  lwz    r0, 12(r31)          ; software channel state, MEM1 0x802CA88C
800e667c  rlwinm r0, r0, 0, 29, 29    ; bit 0x4 = "transfer pending"
800e6680  bne    0x800e64cc
800e64cc  lwz    r0, 12(r29)          ; EXI channel 0 CR, MMIO 0xCC00680C
800e64d0  rlwinm r0, r0, 0, 31, 31    ; bit 0x1 = TSTART
800e64d4  bne    0x800e6678           ; ...forever
```

Two layers, one root cause. `EXIImm` starts a transfer; on hardware the EXI controller
clears `TSTART` when it completes and then raises the EXI **interrupt**, whose handler
clears the software "pending" bit. **This runtime has neither a device model nor any
interrupt delivery**, so both bits stay set and the guest spins.

Note what this is *not*. The translation is not implicated: the loop is a faithful
translation of a loop that on real hardware exits because a *device* changed a word.
`sr.py`'s GAP class is still zero. The blocker moved from **translation** to **the
machine around it** — which is the same wall §9.6 predicted from a different direction.

### 10.2a The fix, and its falsifying control arm — MEASURED

Modelling EXI `TSTART` as **self-clearing** — an EXI device with zero latency, a statement
about timing that invents no bytes — unblocks it. Measured on a `SR_FNS` closure build of
`__OSReadROM` (32 functions, 1,699 instructions), wasm md5
**`b0fcb5e4ae664696f5598cc555c58bff`**, and **both arms are the same binary with the same
md5**, switched at run time by `sr_image_set_exi_model()`:

| arm | `__OSReadROM` (`0x800e9778`) | device reads | TSTART clears |
|---|---|---|---|
| **model ON** | **returns, fault 0, r3 = 1, 2.0 ms** | 8 | **2** |
| **model OFF** (control) | **NEVER RETURNS** — watchdog fired | **3,000,001** | **0** |

The control is what makes the first row mean anything: the pass is caused by the model and
nothing else, and no relink stands between the two readings. The register inventory shows
the same thing from the other side — the ON arm's last two events are
`0xcc00680c EXI-model-cleared-TSTART` followed by the guest's read of it, while the OFF
arm's inventory simply stops at that read and never grows again.

It also demonstrates the watchdog: the OFF arm ended at exactly `watchdog + 1` device
reads with its log intact, instead of hanging the worker and reporting nothing.

### 10.2b With EXI modelled, the boot advances — and the next two walls are named

Same technique, a larger closure build (`OSInit` + its callee graph: 86 functions, 5,409
instructions, wasm md5 **`c74e60e06dadce2860865e33ed249388`**). `OSInit` now reaches
**27 distinct hardware registers** across **PI, MI, SI, DI, EXI and DSP/AI** — it was
0 before, because it never got past the SRAM read. Walking its callees:

| guest fn | | result |
|---|---|---|
| `0x800e9778` | `__OSReadROM` | **now returns** — fault 0, r3 = 1 (was the wedge) |
| `0x800eb940` | `__OSThreadInit` | returns, but faults `0xC60E579C` |
| `0x800e4b74` | `__OSInitAudioSystem` | **WEDGES** — watchdog, r3 left at `0xCC005000` |

**Wall 2 — DSP.** `__OSInitAudioSystem` polls a DSP register in the `0xCC005000` block
(last first-touch: a write to `0xCC005012`). Identical class to EXI: a device register
that hardware changes and this runtime does not. It is the next device along, not a new
kind of problem.

**Wall 3 — the guest-OS context primitives, and this one is a build-mode gap, not a
missing device.** `0xC60E579C` decodes as `SR_F_IMG_UNIMPL | 0x0E579C` → `0x800E579C`
`OSClearContext`, with `0x800E55D4` `OSSetCurrentContext` right behind it. Both ARE
implemented in `sr_host_os.c` — but `sr_host_call()` returns 0 for the whole context
family when `g_mode == SR_OS_IRQ`, which is the mode this build installs
(`sr_os_init_irq()`, no `-pthread`). They belong to `SR_OS_HLE`, the mode that owns
`SelectThread` and needs one host thread per guest thread. **So the context-switch work
in §6 / `CONTEXT_SWITCH.md` is not merely compatible with the boot — the boot reaches
the exact point that needs it, 124 host-boundary crossings in.** Linking the image
`-pthread` and calling `sr_os_init()` instead of `sr_os_init_irq()` is the change.

### 10.3 Three things that came free with the run

1. **The `OSDisableInterrupts` host boundary carries real traffic.** 108 host-boundary
   crossings were recorded before the hang, and they sum exactly
   (`/tmp/sr-exi2.json`, last completed step `0x800e60ac`):

   | address | class | count | |
   |---|---|---|---|
   | `0x800e78ac` | OS | 34 | `OSDisableInterrupts` |
   | `0x800e78d4` | OS | 34 | `OSRestoreInterrupts` |
   | `0x800ecb48` | REAL | 13 | `OSGetTime` |
   | `0x800e34ac` / `0x800e34b4` / `0x800e34a4` | REAL | 9 / 5 / 4 | the SPR accessors |
   | `0x800e4f5c` / `0x800e4e08` | VOID | 2 / 2 | `ICEnable` / `DCEnable` |
   | `0x800e349c` / `0x800e3494` | OS | 2 / 1 | the TRK MSR pair |
   | `0x80003330` / `0x800e3d38` | REAL | 1 / 1 | `__init_hardware` / `__OSPSInit` |
   | | | **108** | |

   §9.3 sized the interrupt boundary statically at 745 blocked DOL functions; the top
   two rows are it executing, 68 crossings in one partial `OSInit`.
2. **A hang no longer costs the evidence.** The first `OSInit` probe recorded 100
   boundary crossings and returned *none* of them, because the log was posted only from
   the `done` message that a wedged call never sends. The worker now posts the log after
   every step, and the C layer has a device-access watchdog that throws out of the module
   — the only way to stop a running guest here (no `-pthread`, no Asyncify, no interrupt,
   and `sr.py`'s bodies have no fault check between instructions: `grep g_fault` on the
   generated file finds one `#define` and no reads).
3. **A boundary crossing is the only observable.** A guest `bl` is a host C call, so
   there is no PC to poll. The trajectory in §10.1 is a *boundary* trajectory, and every
   number here should be read as one.

### 10.4 Honest inventory of the host layer

`sr_image.c` puts every host address in exactly one of three states, machine-readable at
run time. The third is the point:

- **REAL** — `__init_hardware`, `__OSPSInit` (GQRs cleared, which is the *only* mode
  `gekko_rt.h`'s paired-single code implements), the SPR accessors (decoded from the
  shipped instruction word, not a hardcoded table), `OSGetTime`/`OSGetTick` (host
  monotonic at 40.5 MHz, **1:1 with wall time — gate #9 forbids scaling it**),
  `__OSSaveFPUContext`/`__OSLoadFPUContext`.
- **VOID** — 13 cache-control functions. Not a shortcut: MEM1 here is one flat buffer
  with no cache and no address translation, so `DCEnable` has no state to change. The one
  thing this does *not* cover is `DCInvalidateRange` before re-reading a DMA-written
  buffer, and that is written down in the source rather than discovered later.
- **UNIMPL** — everything else **faults and names itself**, and `SRP_STRICT=1` makes the
  first one throw. This is deliberate contrast with `gamecube/recomp/`'s MP4 host layer,
  which resolved 127 of 136 imports through `default: return 0` and shipped with **no
  audio at all** because nothing could see it from the inside.

Two fidelity gaps are recorded rather than papered over: the FST is staged at the disc's
own `0x803EDE20` while `arenaLo` is left 0 (so SAB's arena starts *below* the FST — the
apploader would have set it past), and the device window is a backing buffer, not a
device model.

### 10.5 The next things to build, named and ordered

Not more translation — the translator's GAP class is still zero and 99.41% of `.text` is
in the image. Three items, in the order the boot hits them:

1. **A device layer.** EXI proved the shape of the fix in ~40 lines and one falsifying
   control; DSP is next (§10.2b), then DI, VI and SI. The `sr_image_dev_log` inventory
   makes this list measured rather than guessed — 27 registers across six blocks are
   already recorded, and the register a wedged run last touched names the next one.
2. **`SR_OS_HLE` instead of `SR_OS_IRQ`** — link the image `-pthread` and call
   `sr_os_init()`. §6 and `CONTEXT_SWITCH.md` already built and verified this (63
   assertions / 0 failures); the boot reaches `__OSThreadInit` and asks for it.
3. **An interrupt path.** Even a fully modelled device is only half of it: `EXISync`'s
   *other* poll is on a software flag that only the EXI **interrupt handler** clears, and
   `__OSInterruptInit` ran cleanly while nothing will ever call its handlers. Modelling a
   device without delivering its interrupt buys one poll loop, not a boot.

Only after those does "something renders" become a question about the renderer.

## 11. The guest TIMEBASE as a host facility — +189, and the one place gate #9 breaks by accident

`0x800ecb48` `OSGetTime`, `0x800ecb60` `OSGetTick` and `0x800e34bc` `PPCMtdec` are
host-implemented, driven by **retired guest work** and never by the host clock.
Reproduce every number below with:

```bash
# the closure delta, both arms from ONE process and ONE classify() implementation
python3 gamecube/recomp/sr/fixture_dol.py --shapes-only --irq-hosts --clock-hosts --new-only
# the containment audit (exit 2 if any EMITTED body could read the clock)
python3 gamecube/recomp/sr/sr.py --image /tmp/sr_sab/main.dol --map dolphin_captures/sab.map \
  --boundaries outer+calls --indirect --jumptables --tb-audit \
  --host 0x800ecb48 --host 0x800ecb60 --host 0x800e34bc
# the execution differential, six arms on ONE binary
SR_OUT=/tmp/sr_clock SR_HOST_OS=1 SR_OPT=-O2 SR_EXTRA_ARGS="--indirect --jumptables \
  --boundaries outer+calls --host 0x800e78ac --host 0x800e78c0 --host 0x800e78d4 \
  --host 0x800e3494 --host 0x800e349c --host 0x80108e98 --host 0x80108ea0 \
  --host 0x800ecb48 --host 0x800ecb60 --host 0x800e34bc" \
  bash gamecube/recomp/sr/build_fixture.sh /tmp/sr_sab/main.dol 0x800ecb68
SR_OUT=/tmp/sr_clock node gamecube/recomp/sr/verify_clock.mjs
```

### 11.1 THE INVARIANT — and why the obvious implementation is a gate-#9 bug

```
TB  = TB_origin + floor(GUEST_CYCLES_RETIRED / 12)
DEC = DEC_at_write - floor((GUEST_CYCLES_RETIRED - cycles_at_write) / 12)
```

**Guest cycles are the only input to the rate. A host wall-clock ORIGIN is legitimate;
a host wall-clock RATE is not.** That distinction is not a house rule — it is exactly
what the reference does. Dolphin `SystemTimers.cpp:213-218`:

```cpp
GetFakeTimeBase() = FakeTBStartValue
                  + (CoreTiming::GetTicks() - FakeTBStartTicks) / TIMER_RATIO;
```

`CoreTiming::GetTicks()` is the **emulated CPU cycle counter**, not wall time;
`:199-204` `GetFakeDecrementer()` is the same expression counting down; `SystemTimers.h:41`
`TIMER_RATIO = 12` and `:103` `m_cpu_core_clock = 486000000` give 40.5 MHz, the constant
CLAUDE.md gate #9 already names. The **only** wall-clock input Dolphin has is the
origin, taken once at boot from the RTC (`:269`, seconds-since-GC-epoch × 40.5e6).

Why it matters here rather than in the abstract: this runtime does not deliver guest
work at hardware rate — the honest JIT figure is **0.3781x delivered** (§8.6b). Drive
the timebase from `emscripten_get_now()` and the guest gets ~1.00 s of *time* for every
~0.38 s of *work* it retired, so its time:work ratio — a **constant of the hardware** —
becomes a function of the host. Guest deadlines fire early, measured intervals read
long, and two replays of the same computation disagree, so no differential can ever be
bit-exact. In the other direction, a host **faster** than hardware (the entire point of
the 120 headroom target) makes guest time run **slow** against guest work. Both
directions are the gate-#9 failure. Deriving the clock from retired work makes the
ratio exactly hardware's **at any host speed**, and leaves "how much wall time one
second of guest time costs" as a quantity measured *outside* the guest — gate #9's
second, independent knob.

> **This was live in the tree, with a comment arguing it was safe.** `sr_image.c`'s
> `img_timebase()` read `emscripten_get_now()` under the note *"THE GUEST CLOCK IS HOST
> WALL TIME, 1:1. It is not scaled and it must never be"*. The reasoning is plausible
> and wrong for one measured reason: 1:1 with the host is not 1:1 with the hardware
> unless the host delivers guest work at hardware rate, and it does not. That function
> now delegates to `sr_tb_read()`, so the image has one clock instead of two.
> `sr_image.c` also routed `mtspr 22` into its generic SPR file, where the write was a
> dead store nothing counted down; SPR 22 is now special-cased to the shared
> decrementer. **Both edits are in a file another agent owns and are deliberately left
> uncommitted** — flag them rather than sweeping them into a commit message that does
> not describe them (the failure `279f710e` is recorded for).

### 11.2 The set — read from the shipped words, because the map is wrong here

```
0x800ecb48 OSGetTime  7c6d42e6 mftbu r3 / 7c8c42e6 mftb r4 / 7cad42e6 mftbu r5
                      7c032800 cmpw r3,r5 / 4082fff0 bne -16 / 4e800020 blr
0x800ecb60 OSGetTick  7c6c42e6 mftb r3 / 4e800020 blr
0x800e34bc PPCMtdec   7c7603a6 mtspr 22,r3 / 4e800020 blr
```

`sab.map` calls `0x800e34bc` **`PPCMtwpar`** and that is wrong: the Gekko SPR field is
encoded in swapped halves, and reassembling it gives **22 = DEC**. WPAR is SPR 921.
`~/gc_refs/dolsdk2001/src/os/OSTime.c:15-38` is the same code as C, and
`.../OSAlarm.c:37-46` `SetTimer` is why `PPCMtdec` belongs in this boundary rather than
its own — it computes `alarm->fire - OSGetTime()` and `PPCMtdec`s the result.

**`r5` and `CR0` are outputs of `OSGetTime`, not scratch.** The retry loop leaves
`r5 = TBU` and `CR0 = EQ` from `cmpw r3,r5`, and the fixture differential scores both,
so a host implementation that set only `r3:r4` would fail against its own translation.
All three bodies are leaves that touch **no memory and take no stack frame**, which is
what makes them safe to answer for without perturbing an ordered write log.

### 11.3 The closure delta, and the pair effect reproduced independently

`rel_shapes.classify`, whole `outer+calls` set, all arms from one process:

| host set | closure-clean | vs 3,581 baseline |
|---|---|---|
| baseline (none) | 3,581 / 4,741 | — |
| SR_OS_IRQ only (§9.7) | 4,080 / 4,741 | +499 |
| **IRQ + clock (3)** | **4,269 / 4,741** | **+688 fn, +86,744 instr = 23.14% of `.text`** |

**The clock's own contribution is +189 functions / +12,772 instructions (3.41% of
`.text`)** on top of the committed 4,080. Leave-one-out, on top of the IRQ set:

| address | alone | dropped from the set |
|---|---|---|
| `0x800ecb48` `OSGetTime` | +70 | **−182** |
| `0x800ecb60` `OSGetTick` | +7 | −10 |
| `0x800e34bc` `PPCMtdec` | **+0** | **−112** |

`PPCMtdec` on its own is worth **nothing** and costs **112** when removed — §9.7's
"the unit is the PAIR" finding, reproduced on a different pair for a different reason
(`SetTimer` needs `OSGetTime` to compute the delta it then writes to the decrementer).
Measuring it was the only way to know: by name it looks like the least important of
the three.

**The task framing of "381 blocked-function memberships" over-reads by design.** 208 +
28 + 145 counts *memberships*, and a function appears in several rows; the ceiling was
never more than the 265 that §9.7 left blocked, and **197** of those 265 clear when the
2nd in-image timebase reader is included (**189** without it — see below). The rest
reach a second, unrelated boundary.

**A 4th address exists and is deliberately NOT host-bound.** `0x80169ae8` is a
C-compiled `OSGetTime`: `mftbu r4 / mftb r31 / mftbu r0 / cmpw / bne`, then
`li r3,0; li r5,32; bl 0x8010b338` (a 64-bit shift helper) and `or r4,r4,r31`, i.e. it
returns `r3:r4 = TBU:TBL` — the same **value**. It is not the same **function**: it
takes a stack frame and writes `r0` and `r31` into it, and host-binding it would
silently delete two writes the oracle records in the ordered write log. Measured cost of
leaving it out: **8 functions**. Named rather than quietly taken.

### 11.4 Containment — `sr.py --tb-audit`, the same shape as `--msr-audit`

```
0x800e34bc PPCMtwpar       1 site(s) [mtspr DEC]                       HOST-BOUND
0x800e8e90 Reset           2 site(s) [mftb TBL]                        refused (mfspr SPR1008)
0x800ecb48 OSGetTime       3 site(s) [mftb TBL, mftb TBU]              HOST-BOUND
0x800ecb60 OSGetTick       1 site(s) [mftb TBL]                        HOST-BOUND
0x8010a6b4 zz_8010a6b4_    3 site(s) [mfspr DEC, mftb TBL, mftb TBU]   refused (op31 xo=595)
0x8010a86c TRKRestoreExtended1Block 3 site(s) [mtspr DEC, mtspr TBL(w), mtspr TBU(w)]  refused
0x80169ae8 zz_80169ae8_    3 site(s) [mftb TBL, mftb TBU]              refused (op31 xo=371)

7 functions can observe the timebase/decrementer: 3 host-bound, 4 refused, 0 EMITTED
PASS: no emitted body can reach the timebase except through the host boundary.
```

**Seven functions in the entire image can see guest time, and zero of them are
emitted.** So `g_tb` is not an approximation the guest can catch out by reading the
clock some other way — inside the emitted image it is the only representation of guest
time that exists. The audit exits 2 if that stops being true. (Writing the TB —
`mttbl`/`mttbu` — occurs in exactly one function, the Metrowerks debug monitor's
`TRKRestoreExtended1Block`; it stays refused.)

### 11.5 Verified BY EXECUTION, with the control arm inside the same binary

The committed fixture record **cannot** evidence this boundary, and that is measured,
not assumed: of 398 committed capture records, exactly **three** ever entered
`OSGetTime` — `0x80123d24`, `0x801237d0`, `0x8012eda8` in `sab_dol_survey_all.json` —
and **all three carry the artifact's own `usable:false` flag** from capture time
("2 unknown store forms"; "did not return (capture truncated)"), so `verify_fixture.mjs`
refuses them before the boundary is reached. Every other capture was armed by a closure
gate that excluded every clock caller by construction. `verify_fixture.mjs` now says so
explicitly rather than reporting a quiet zero.

So the differential runs a **real translated guest body** whose answer comes from the
guest's own source: **`0x800ecb68 __OSGetSystemTime`**, 100 B / 25 instructions,
decoded from the shipped words and matching `~/gc_refs/dolsdk2001/src/os/OSTime.c:66-76`
line for line — `OSDisableInterrupts` / `OSGetTime` / add the 64-bit adjust at
`0x800030D8` / `OSRestoreInterrupts`, returning `r3:r4 = TB + adjust`. Its closure emits
**one** body and reaches all three callees through `sr_extern`, so a pass is a
translated caller reaching the host layer. `verify_clock.mjs`, wasm md5
`16748f7f71959ed30fff49135ec7adf0` **identical before and after every arm**, machine
load 1.3–2.2:

| arm | what it establishes | result |
|---|---|---|
| **A** clock ON | `fault=0`, boundary crossed, `r3:r4 == seed + adjust` exactly | 4/4 |
| **B** clock OFF, **same binary** | must fault `0xe00ecb48`, 0 crossings | 2/2 |
| **C** four different seeds | the answer **tracks the seed**; a constant would pass A for the wrong reason | 4/4 |
| **D** `PPCMtdec` | DEC reads back; counts **down** by `cycles/12`; the exception comes due | 4/4 |
| **E** gate #9, as a test | 250 ms of **real host time** passes → guest ticks advance by **0** | 1/1 |
| **F** retired work | one field = **exactly 675,000** ticks; 60 fields = 40,500,000; sub-tick remainder carried | 3/3 |

**18 passed / 0 failed.** Arm E is the invariant stated as an executable check: a
wall-clock timebase would have advanced ~10,125,000 ticks in that window, and that
difference *is* the bug. Arm B is the falsifying control — same md5, switch flipped at
run time, so the pair cannot be confounded by a relink.

> **`sr_tb_enable()` is a separate switch from `sr_os_mode()` on purpose.** Turning the
> clock off via `sr_os_mode(0)` would also turn the MSR boundary off, and the delta
> would be un-attributable between two facilities. `SR_TB=0` isolates the clock.

### 11.6 Arm C FAILED first, and it was a real translator bug

On the first run, arm C failed on one seed:

```
FAIL  C seed=0xfffffffffff -> r3:r4  got=1000:23456788  want=1001:23456788
```

The high word was low by exactly 1 — a lost carry. Cause, at `sr.py:507` as it stood:
`addc` (op31 xo=10) shared the `add` (xo=266) arm and emitted a plain
`st->gpr[D] = A + B;`, **never writing XER[CA]** — while `adde` one instruction later
has always *consumed* `XER[CA]` correctly. So every 64-bit add compiled as the canonical
`addc rLO; adde rHI` pair silently dropped the carry, and was wrong by 1 in the high
word **only when the low halves actually carried**. `subfc` (xo=8) and `addic`/`addic.`
(op 12/13) were already correct, which is what makes this an omission rather than a
modelling decision.

**Blast radius, from the raw binary: 54 `addc` sites across 16 of the 4,741 functions,
10 of them immediately followed by `adde`.** It was invisible to the 1,056 leaf vectors,
to the 330 verified DOL functions and to inspection — and it surfaced only because
`__OSGetSystemTime` became reachable at all, which required this boundary to exist. Same
lesson as §9.5's `fctiwz`: a broad differential finds what reading cannot.

**The fix is provably confined**, by the §5j standard. Regenerating the whole image with
HEAD's translator and with the fixed one, same flags and same 10 `--host` addresses:

| | |
|---|---|
| changed statements in `sr_gen.c` | **54** — exactly the 54 `addc` sites counted independently from the binary |
| every removed line | a bare `st->gpr[D] = A + B;` (0 exceptions) |
| every added line | sets `XER[CA]` (0 exceptions) |
| `sr_dispatch.c` | **byte-identical**, md5 `c0d7757848e9a1ad4e62ad64c154294a` |

**Regression gate:** the committed context-switch suite, rebuilt through the changed
translator, is **63 passed / 0 failed**, including its own control arm D
(`sr_os_mode(0)` → `0xe00e78ac`).

### 11.7 What is NOT modelled — stated so nothing here implies completeness

* **Decrementer interrupt DELIVERY.** The register is exact; its consequence is not.
  Dolphin's `DecrementerCallback` (`SystemTimers.cpp:139-143`) sets `DEC = 0xFFFFFFFF`
  and raises `EXCEPTION_DECREMENTER`; this runtime has **no interrupt delivery at all**
  (§6, `CONTEXT_SWITCH.md` §7.1), and the 8 non-`SelectThread` `OSLoadContext` sites —
  the exception-return paths — still fault `SR_F_LOADCTX_EXC`. So the facility **counts**
  the exceptions that would have fired (`sr_tb_dec_exceptions()`, surfaced per-run by
  `verify_fixture.mjs`) and delivers none. Direct consequence: `OSSetAlarm` programs a
  timer whose handler never runs. This is the **same pre-existing hole MSR[EE] has** —
  value exact, effect absent — neither widened nor narrowed here.
* **No driver is attached in the whole-image build yet.** The facility owns the
  register; the driver owns the credit. The proven one is
  `sr_tb_retrace()` = +675,000 ticks per guest VI retrace, which is what
  `recomp_worker.js:786` drives the shipping MP4 recomp's `OSGetTime` from at
  **0.999x**. Until `sr_image.c`'s boot loop calls it, **the clock is frozen** — and a
  frozen clock raises `SR_F_TB_STALL` after `SR_TB_STALL_MAX` uncredited reads, naming
  the caller. That is deliberate: a stall is *loud*, a wall clock is *silently wrong*.
* **The fixture rig does not advance the clock within one replay.** There is no
  per-instruction retire counter in this runtime, so there is no honest cycle count to
  credit for one invocation, and interpolating from the oracle's `steps` would be a
  fabricated rate — the same class of error as reading the host clock. A fixture that
  measures an *interval* inside a single call therefore sees a delta of 0. Limitation of
  the **rig**, not the facility.
* **No committed capture carries a guest TB.** `native_oracle_gdb.arch_state` now reads
  GDB register ids **114/115/116** (`GDBStub.cpp:489-496` `SPR_TL`/`SPR_TU`/`SPR_DEC`),
  so a future survey will; `verify_fixture.mjs` seeds and scores `tb`/`dec` only when the
  capture has them, and refuses to seed 0 otherwise — the rule §9.7 established for MSR.

### 11.8 What blocks the remaining 472, measured the same way

Complete blocker sets (`sr.closure_of`) over every still-blocked entry, so this is a
blast radius and not a first-blocker histogram:

| next blocker | blocks | what it is |
|---|---|---|
| `0x800e55d4` `OSSetCurrentContext` | 216 | `mfmsr` + MSR[FP] — context switch, **already written** in `sr_host_os.c` |
| `0x800e563c` `OSSaveContext` | 198 | the setjmp — same |
| `0x800e56bc` `OSLoadContext` | 198 | `rfi` — same |
| `0x800e4e4c` `DCFlushRange` | 190 | `dcbf` loop + `sc` — unclaimed cache-maintenance boundary |
| `0x800e4e1c` `DCInvalidateRange` | 178 | `dcbi` loop — same |
| `0x800e4e80` `DCStoreRange` | 53 | same |
| `0x80113fc0` / `0x80113f98` | 31 / 31 | `mtspr SPR913` (the GQR/quantised path) |
| `0x800e34c4` `PPCSync` | 21 | `sync` |

So the next boundary worth building is the **context switch** (already transcribed, and
`SR_OS_HLE` exists — it needs the closure gate and a measurement, not new code), and
after it **cache maintenance**, which `sr_image.c` already argues is `IMG_D_VOID` on
structural grounds: there is no cache in this runtime to control.

## 7. Decision

**The route is VIABLE for SAB on translatability grounds, and the remaining work
contains no unknowns — only unbuilt engineering.** 99.965% of the game's 5.93 M
PowerPC instructions clear the translator once two designed-but-unbuilt mechanisms
exist (indirect dispatch, host-bound OS primitives); the translator's own semantic
gap is now zero; and the host/OS boundary is 66 functions, of which the hard part is
two.

**What that claim does NOT cover, stated plainly:**

1. **There is STILL no valid performance number for the SAB static-recomp path.**
   The 2026-09-04 "SUPERSEDED" answer to this item — `0.50-0.54x vs 0.4450x`,
   `~1.1-1.2x the JIT` — is **withdrawn from both sides (§8.6)**, and this item
   reverts to open. The numerator is not a measurement of the verified computation
   (`HandleReverb` is not bit-exact, and `perf_browser.mjs` re-runs it ~160,000 times
   on state its restore set never repairs — §8.6e); the denominator was a
   40 s window on a boot transient that returns `0.3338x–0.5097x` from one frozen
   binary (§8.6c).
   **What IS now measured is the JIT half, properly:** 1.000x on this scene costs
   **373.5 MHz of executed Gekko work** (486 MHz × (1 − 23.2% idle-skip), the
   idle-skip measured rather than assumed) and the JIT executes **141.6 MHz** of it —
   **2.64x short**, on the V8 configuration a visitor actually gets.
   **The premise "this escapes the JIT ceiling" is unproven and currently
   unmeasured**: what is known is what the JIT costs, not that a system built
   on it would hit 1.000x. Read §8.3 and §8.6f before quoting any of it.
2. ~~**No `.rel` overlay function has ever been differentially verified.**~~
   **CLOSED 2026-09-02 (§5g/§5h): `stg13D.rel` `0x8121d80c` is bit-exact** — exit
   registers, the 47-event ordered write log, and final memory. One function, from one
   scene, so it evidences that overlay code translates correctly; it does not sample
   the overlays broadly. The rig is now seconds-per-capture, so breadth is cheap.
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
2. ~~**Differentially verify one `stg13D` (City Escape) overlay function.**~~ **DONE
   2026-09-02 — §5g.** It did not need a new savestate; it needed the Dolphin that can
   READ the one already on disk.
3. **Capture a fixture that EXECUTES a recovered jump table.** `--jumptables` resolves
   145 of 147 `bctr` sites and the emitted switch compiles, but nothing has yet run one
   against the oracle — the existing non-leaf suite contains zero `bctr` functions, so
   re-running it proves nothing. `fixture_nonleaf.py --discover --bctr-only` finds
   candidates and every fixture records `bctr_executed`. Until that lands, the
   99.4% runtime-complete figure is STATIC.
4. **Broaden the overlay sample.** One overlay function is evidence that overlay code
   translates; it is not a survey. Capture is now seconds per function against a
   resident scene, and `fixture_rel.py` reports every resident module, so this is
   cheap. Prefer fixtures with an empty `outside_mem1` — 2 of the first 3 captures
   were rejected on that basis.
5. Only then, a performance measurement — and per the product definition, the guest
   must run at exactly 1.000x; headroom is reported as capacity, never as speed-up.
