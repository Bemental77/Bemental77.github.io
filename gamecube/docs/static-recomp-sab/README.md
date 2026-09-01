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
