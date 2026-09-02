# Making a WASM-hosted CPU-emulator dispatcher faster — external techniques, mapped

**Written** 2026-09-01. **Method:** web research (WebSearch/WebFetch) + read-only inspection of the
working tree + re-analysis of *existing* `.cpuprofile` artifacts already on disk. **No build, link,
probe, or browser was run for this document** (ten sibling agents were active; CPU contention would
void their measurements). No source file was modified.

**Citation rules used here** (CLAUDE.md gate #6): external claims carry a URL and a quoted passage;
repo claims carry `file:line` read in the session that produced this doc; anything else is explicitly
hedged. Where the brief that commissioned this document supplied a number I did not verify, it is
marked **[from brief, unverified here]**.

---

## 0. The most important finding first: `wasm-function[13]` is not a dispatcher

The commissioning brief describes `wasm-function[13]` as "the JIT's dispatcher/executor". **The repo
and the existing profiles say it is neither** — it is the aggregate of *every* JIT-emitted guest block
body.

> **Not novel — corroborating.** HEAD (`e52a1c1e`, 2026-09-01) already states this from the emitter
> side: *"wasm-function[13] settled: WIMPORT_COUNT=13 imports (ppc_emit.cpp:1953-1971) and 'run'
> exported at index 13 (:1981), one Module per block — so V8 aggregates thousands of block bodies under
> one symbol. It IS the emitted code; there is no dispatcher inside it to optimize."* What follows is an
> **independent confirmation from the profile side**, which additionally yields the module-locality
> curve that candidate #1 depends on. Line numbers differ between that commit's citation and mine
> because `ppc_emit.cpp` moved under me during the session; both point at the same construct.

Why the name collides:

- Each per-block module declares exactly `WIMPORT_COUNT` imported functions, and
  `constexpr u32 WIMPORT_COUNT = 13;` — `gamecube/bementalJIT/guests/powerpc-next/hle_prologue.h:35`.
- The single defined function is therefore function index 13 in *every* per-block module, exported as
  `"run"` — `gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp:1987-1994`.
- The module builder emits no name section: a grep for `emitCustom|CustomSection|NameSection` over
  `gamecube/bementalJIT/include/bementalJIT/wasm_module_builder.h` returned **no matches**.

So V8 labels thousands of distinct block bodies `wasm-function[13]`, and any profile aggregation keyed
on function *name* merges them all.

I confirmed this against four `.cpuprofile` files already on disk (dated 2026-08-29; I did not create
them, and I do not know which build or scene each came from — see §6). Script:
`<scratchpad>/cov.mjs`, which sums self-samples per node and splits `wasm-function[13]` nodes by their
`callFrame.url`:

| profile | samples | `wasm-function[13]` | distinct module URLs under it | top single module | `bem_chain_loop_c` | `wasm-to-js`+`js-to-wasm`+`wrapper` |
|---|---|---|---|---|---|---|
| `/tmp/sabB2_w4.cpuprofile` | 161,355 | **51.51%** | **4,461** | 4.5% of [13] | 11.35% | 13.96% |
| `/tmp/sabB3_w4.cpuprofile` | 56,281 | **47.07%** | **2,896** | 4.7% of [13] | 14.51% | 13.46% |
| `/tmp/prof_ctl_w4.cpuprofile` | 226,233 | **48.89%** | **2,754** | 2.1% of [13] | 6.18% | 14.35% |
| `/tmp/prof_in_w4.cpuprofile` | 264,934 | **38.04%** | **2,184** | 5.7% of [13] | 5.13% | 22.65% |

Three consequences that change the shape of the problem:

1. **The actual dispatcher is `bem_chain_loop_c` and it is 5.1–14.5%, not 68%.** It is a named C symbol
   in the host module (`gamecube/bementalJIT/src/block_cache.cpp:959`), so it profiles separately.
   Amdahl's ceiling on *dispatch* alone is therefore ~1.05–1.17x, not 1.47x.
2. **"[13] must get faster" = "emitted guest code must get faster."** That is consistent with the
   46.3x guest→wasm amplification **[from brief, unverified here]** and inconsistent with any
   dispatch-shaped fix.
3. **The JS/wasm boundary is 13.5–22.7% and is the largest *single* addressable non-[13] item** —
   larger than the dispatcher in three of four captures.

I could not reproduce the "68% on one GameCube scene / 49–50% on another" figure: across these four
captures `[13]` is 38.0–51.5%. That may be a different scene, a different build, or a different
aggregation. **Flagged as unreconciled** — see §6.

Module-locality curve (share of `wasm-function[13]` self-time held by the top-N hottest modules):

| profile | top-1 | top-16 | top-64 | top-256 | top-512 | top-1024 |
|---|---|---|---|---|---|---|
| `sabB2_w4` | 4.5% | 23.4% | 41.0% | 64.1% | 76.7% | 88.1% |
| `sabB3_w4` | 4.7% | 21.3% | 40.4% | 66.8% | 79.8% | 89.9% |
| `prof_ctl_w4` | 2.1% | 20.6% | 43.8% | 77.4% | 88.6% | 94.5% |
| `prof_in_w4` | 5.7% | 32.8% | 65.2% | 91.0% | 96.2% | 98.4% |

This independently reproduces the shape the repo already recorded from a different instrument —
`gamecube/bementalJIT/src/block_cache.cpp:221-226`: *"board top-512 = 77.8% / top-1024 = 91.0% /
top-2048 = 97.9%"*. It matters because it is the precondition for the #1 candidate below.

---

## 1. What this codebase already does (so we don't "discover" it twice)

Verified by reading the tree today:

| Technique | Status here | Evidence |
|---|---|---|
| **Wasm tail calls for block→block chaining** | **already emitted** | `op_return_call_indirect` at `guests/powerpc-next/ppc_emit.cpp:395, 400, 432, 1756`; `op_return_call` at `:313, 1748, 2371`; encoder at `include/bementalJIT/wasm_module_builder.h:722-730` |
| **In-wasm PC→slot dispatch cache (no JS in the hot path)** | already | epilogue probes `g_bem_disp_tag/slot` in linear memory, `ppc_emit.cpp:317-332`; arrays at `src/block_cache.cpp:119-137` |
| **SIMD byte-swap via `i8x16.shuffle`** | already | `guests/powerpc-next/jit_load_store.cpp:88-97` (`BSWAP32X2_SHUFFLE`, `BSWAP64_SHUFFLE`, `emit_v128_shuffle_self` = 3 ops); call sites `:1161, :1198, :1521, :2219` |
| **Relaxed SIMD** | already | `f32x4.relaxed_madd/nmadd` encoders `wasm_module_builder.h:676-677`; used `guests/powerpc-next/jit_paired.cpp:517, :669` |
| **Non-trapping float→int** | already | `wasm_module_builder.h:180-188, 686-689` |
| **Register cache in wasm locals** | already | 153 locals in 9 groups, `ppc_emit.cpp:2005-2022`; `reg_cache.cpp`, `fpr_reg_cache.cpp` |
| **In-wasm write-gather-pipe (WPAR) append** | already, incl. the const-EA path | `jit_load_store.cpp:472-664` (`emit_gp_append`), and the const-EA store arm calls it at `:1090-1104` |
| **Static direct-edge inline cache (guarded `return_call` by function index)** | already, but region-only | `ppc_emit.cpp:297-315`, gated `region_gen >= 0` |
| **Leaf-call inlining** | already, live | `guests/powerpc-next/ppc_analyst.h:194` (`kLeafInlineMaxOps = 8`), driver `dolphin-src/.../JitWasm/JitWasm.cpp:1065-1110` |
| **Multi-function region modules with an INTERNAL table** | implemented, **gated OFF** | `ppc_emit.cpp:2102-2168` (internal table `:2145-2147`); gates `src/block_cache.cpp:233` (`g_bem_promote_enabled = 0`), `:2161` (`s_merged_enabled = false`), `JitWasm.cpp:750` (`if (false)`) |
| **Branch hints** | half-built, **never emitted** | `op_if_hinted` at `wasm_module_builder.h:753`, zero call sites anywhere in `include/ guests/ src/`; and no custom-section emitter exists |
| **Sign-extension ops (`i32.extend8_s` etc.)** | **absent** | grep for `extend8_s|extend16_s|extend32_s|0xC0..0xC4` over `wasm_module_builder.h` returned nothing |
| **Bulk memory (`memory.fill`)** | encoder only, **no callers** | `wasm_module_builder.h:695-699` |
| **Multi-value** | unused | `emitFuncType` supports it (`wasm_module_builder.h:273`) but every call site passes resultCount 0 or 1 |
| **Exception handling, reference types beyond `funcref`, `call_ref`, atomics** | unused | no encoders found |

**The single structural fact that drives everything below:**

```
bem_chain_loop_c  (C, inside the HOST wasm instance)
  └─ call_indirect on wasmTable[handle]            src/block_cache.cpp:1057-1058
       └─ block instance #N .run()                 own Module, own Instance
            └─ probe g_bem_disp_tag/slot in memory ppc_emit.cpp:317-332
                 └─ return_call_indirect(type 0, table 0)   ppc_emit.cpp:400
                      └─ block instance #M .run()   ← CROSS-INSTANCE
```

Every per-block module **imports the host's table**:
`gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp:1984` emits
`emitImportTable("env", "__indirect_function_table", 0, false)`, and the JS side binds it at
`gamecube/bementalJIT/src/block_cache.cpp:620`:

```js
env.__indirect_function_table = wasmTable;
```
…then `new WebAssembly.Instance(mod, importObj)` at `:623`, one per block, pinned in
`Module.bemental_cache[idx]` at `:647-648`.

The repo's own header already states the problem, verbatim —
`gamecube/bementalJIT/include/bementalJIT/block_cache.h:17-20`:

> "Branches inside a body that target same-region PCs are emitted as `call_indirect (table 0, type 0)`
> — V8's speculative inlining requires the call_indirect target to live in the same instance's table,
> so the table MUST NOT be imported."

That requirement is satisfied only by the **gated-off** region shape. The shipping shape violates it on
every block edge.

---

## 2. Q1 — What current engine docs say about `call_indirect`, ICs, tiering, and deopt

### 1a. V8 shipped speculative `call_indirect` inlining + deopt in **Chrome M137** (24 June 2025)

Source: <https://v8.dev/blog/wasm-speculative-optimizations>

> "shipped with Google Chrome M137" — published 24 June 2025.

> "With the new `call_indirect` inlining, V8 now supports inlining Wasm-to-Wasm calls for all types of
> call instructions: direct `call`s, `call_ref`, `call_indirect`, and their respective tail-call
> variants `return_call`, `return_call_ref`, and `return_call_indirect`."

So **tail calls are inlinable too** — this is not a reason to avoid `return_call_indirect`.

The generated fast path checks: table bounds, **Wasm instance match**, and target-vs-inlined-assumption.
And the instance check is exactly our problem:

> "Correctly inlining functions that belong to a different instance (e.g., which are called via an
> imported table) would hence require additional compiler machinery as well as solving a few obstacles."

> "most calls are within a single instance anyway, so for the time being we check that the call
> target's instance matches the current instance, which lets the compiler make the simplifying
> assumption that both instances are the same. If not, we deoptimize in block 8 (due to wrong instance)
> or block 6 (due to wrong target)."

Note the parenthetical names our exact configuration: *"called via an imported table."*

Magnitude, same source:

> "on this particular microbenchmark, inlining, deopts, and subsequent optimizations speed up the
> program from around 675 ms to 90 ms execution time on an x64 workstation."

> "performing just speculative inlining without deopts speeds up the program 'only' to about 180 ms,
> compared to 90 ms with both inlining and deopts."

Real applications are far more modest — this is the honest number to plan against:

> "we see a 2% speedup in terms of runtime for `richards-wasm`… Next, we see a 1% speedup for a Wasm
> build of the widely-used SQLite 3 database, and 8% speedup for Dart Flute"

Feedback shape (bounds the design of any hand-rolled IC):

> "each entry can go through four stages over the course of the execution: Initially, all entries are
> _uninitialized_ (all call counts are zero), potentially transitioning to _monomorphic_ (a single call
> target was recorded), _polymorphic_ (up to four call targets), and finally _megamorphic_."

> "At each call site Liftoff also emits code to update the _feedback vector_."

After a deopt:

> "execution continues in the unoptimized code, in this case executing the `call_indirect`, which will
> also directly record the new call target in its feedback vector, so that any later tier-up is aware
> of this new target."

**Reading for us:** a chain edge whose target rotates over thousands of modules will go megamorphic
*and* fail the instance check. Best case V8 stops speculating; there is no documented path by which it
becomes fast.

### 1b. SpiderMonkey penalises shared tables the same way, with a number

Source: <https://dbezhetskov.dev/opt-ind-call/> (Dmitry Bezhetskov, SpiderMonkey; no explicit date on
the page)

> "test elem.code_ptr against null, switch_current_state(elem.instance), call elem.code_ptr"

> "we have to emit a roundtrip switch for states."

Measured result of removing that for private tables: **"internal calls become much faster −30%"** while
external calls pay **"+18%"**. The optimisation applies only to *private* (neither imported nor
exported) tables.

Emscripten's own dynamic-linking guidance states the rule plainly (quoted in search results from the
Emscripten docs / issue #8268 discussion; I read #8268 itself and it contains
*"the overhead of indirect calls is high"*, 8 March 2019):

> "If a table is imported/exported/initialized-with-import, a `call_indirect` can change instance and
> thus requires taking a slower call path."

**Both major engines therefore penalise the exact topology this JIT uses.** That is two independent
implementations, not one vendor quirk.

### 1c. Tiering: Liftoff → Turboshaft, call-count driven, **no OSR**

Source: <https://v8.dev/docs/wasm-compilation-pipeline> and
<https://raw.githubusercontent.com/v8/v8/main/docs/wasm/architecture.md>

> "V8 monitors how often WebAssembly functions get called. Once a function reaches a certain threshold,
> the function is considered hot, and re-compilation gets triggered on a background thread."

> "we don't do on-stack-replacement for Wasm" — so "if Turboshaft code becomes available after the
> function was called, the function call will complete its execution with Liftoff code."

> Turboshaft "replaced TurboFan for Wasm".

**Reading for us:** the tail-call chain is call-count-rich (every block edge is a call), so hot block
bodies should tier up. But a block body containing a long-running in-wasm loop entered once — e.g. the
resident self-loop at `ppc_emit.cpp:1341-1350` — cannot be rescued by OSR. That is a concrete,
testable hazard for the resident-loop arm.

Flag names for local experiments: `--wasm-dynamic-tiering` (embedder) /
`--enable-blink-features=WebAssemblyDynamicTiering` (Chrome), per
<https://v8.dev/blog/wasm-dynamic-tiering>. I did not find a published threshold value.

### 1d. Engine limits (bound how aggressively we can batch)

From `v8/src/wasm/wasm-limits.h` (reported via search, **not read directly by me — hedged**):
`kV8MaxWasmFunctions = 1,000,000`, `kV8MaxTableSize = 16 * 1024 * 1024`, max imports/exports 100,000.
If accurate, batching thousands of blocks per module is nowhere near a limit; the constraint is
compile latency, not counts.

---

## 3. Q2 — What other production wasm-hosted emulators/DBTs actually do

### 3a. `nasomers/flycast-wasm` — SH4→wasm JIT, same problem, same console family

This is the closest external analogue in existence and the repo already tracks it
(`dreamcast/docs/nasomers-table-dispatch/` per CLAUDE.md). Sources:
<https://github.com/nasomers/flycast-wasm> and
<https://github.com/nasomers/flycast-wasm/blob/main/TECHNICAL_WRITEUP.md>

Pipeline:

> "SH4 machine code -> Flycast decoder -> SHIL IR -> wasm bytecode emitter -> WebAssembly.compile ->
> function table -> call_indirect dispatch (C dispatch loop, no JS in the hot path)"

— i.e. **the same shape we have**, down to the C dispatch loop.

The four numbers worth stealing:

1. **Module batching.**
   > "Multiple pending blocks compile as one multi-function module per frame, which amortizes
   > per-module overhead from about 1 ms per block to about 20 µs per block."

   ~50x on compile cost, and it directly reduces instance count.

2. **The small-block dispatch problem, stated exactly as ours.**
   > "Single-block dispatch pays a table probe and an indirect call per basic block. That is tolerable,
   > but hot loops of 3-6 small blocks spend a large fraction of their time in dispatch overhead, and
   > the register cache dies at every block boundary."

   Their fix: *"Single blocks chain into statically-connected runs compiled as one module. Chain heads
   are primed into the dispatch table, so entering a chain costs the same as entering a block."*

3. **Register cache in locals.** *"Hot integer registers occupy WASM locals per block via `RegCache`"* —
   reported as a **"3-5x"** speedup versus context memory access.

4. **Import-crossing elimination.**
   > "roughly 450-500 K WASM-to-C import crossings per frame" before optimisation, reduced to
   > "approximately 9 K crossings per frame" by inline RAM guards
   > (`((phys | (phys+4)) >> 26) == 3`) and inline store-queue writes (`(addr >> 26) == 0x38`).

Plus a self-modifying-code technique we do not use: a per-4KB-page generation counter
(`g_fly_page_gen[]`) instead of hashing bytes, *"98.3% of dispatch hashing eliminated, from 1.97 M down
to 33 K hashed halfwords per frame."*

Headline claim: *"from about 2 FPS to a locked 60fps at native resolution with clean audio in the
heaviest titles tested"*, validated by *"Hundreds of thousands of block-level comparisons at zero
divergence."* They also say branch hints are *"already emitted on every guard slow path, dormant until
Chrome's V8 enables consumption by default"* — see §5 for why I think that sentence is stale.

### 3b. QEMU's TCG WebAssembly backend (Kohei Tokunaga, in review 2025)

Sources: <https://www.mail-archive.com/qemu-devel@nongnu.org/msg1116287.html> (cover letter),
<https://lists.gnu.org/archive/html/qemu-devel/2025-09/msg00163.html> (v3, Sept 2025),
<https://github.com/ktock/qemu-wasm>

> "To minimize compilation overhead and avoid hitting the browser's limitation of the number of
> instances, this backend integrates a forked TCI." TBs run on the interpreter by default and
> "frequently executed TBs compiled into WebAssembly."

v3 adds: *"lowered the maximum number of instances (MAX_INSTANCES) to avoid the out of memory error in
recent versions of FireFox."*

**Reading for us:** a second independent project treats *instance count* as a first-class resource
problem and solves it by (a) an interpreter tier and (b) an eviction policy. We currently create one
instance per block and never reuse an index — `src/block_cache.cpp:109-112` documents
`_bemental_next_idx` as monotonic. No published perf numbers in these cover letters.

### 3c. CheerpX — x86→wasm DBT in the browser, production

Source: <https://labs.leaningtech.com/blog/cx-10> (4 December 2024)

Two-tier: *"a fast interpreter that can also track the structure of running code with low overhead"* +
*"an advanced JIT engine that can generate high quality optimized WebAssembly code on the fly."*

Performance anchor: *"the slowdown can be as low as 2x/3x compared to native"* for good code, with
applications typically *"5x-10x slower than native"* and an aspiration of *"at most 5x slower than
native."*

**Reading for us:** the best-published browser-hosted DBT lands at 2-3x slowdown in the good case. Our
SAB figure of 0.4115x of hardware **[from brief, unverified here]** is ~2.4x slowdown *for the whole
emulator*, which is not obviously off the industry curve — the deficit is that a GameCube needs the
whole machine emulated, not just the CPU translated.

### 3d. WATaBoy — Game Boy→wasm JIT (28 June 2026)

Source: <https://humphri.es/blog/WATaBoy/>

Same linking pattern: *"adds the new instance's function to our main instance's indirect function
table"*, invoked *"using the `call_indirect` instruction."* Framing worth quoting:

> "Wasm is a Harvard architecture rather than a von Neumann architecture" — code generation must "reach
> out to the embedder (typically JavaScript) to compile, instantiate and link in our new Wasm bytecode."

Measured: ~1.2x faster than a native interpreter, ~1.5x faster than a wasm interpreter, and *"Safari
pulls ahead"* over Chrome and Firefox. Modest — a useful reminder that one-function-per-block wasm JIT
is not automatically a large win over interpretation.

### 3e. Andy Wingo, "just-in-time code generation within WebAssembly" (18 Aug 2022)

Source: <https://www.wingolog.org/archives/2022/08/18/just-in-time-code-generation-within-webassembly>

Establishes the pattern this codebase cites by name at `src/block_cache.cpp:625-627` ("Andy Wingo's
JIT-in-WASM pattern"):

> "To add code, the main program should generate a new WebAssembly module containing that code. Then we
> run a linking phase to actually bring that new code to life and make it available."

and recommends **function-level, batched** granularity: *"functions recorded as candidates during
interpretation before batch compilation."*

### 3f. Ruffle

Source: <https://github.com/ruffle-rs/ruffle/wiki/Roadmap> — AVM2 is interpreted; a JIT is listed as
open research, explicitly asking *"whether it's possible to JIT code directly to WebAssembly for the
web client."* No dispatch design to borrow.

### 3g. Classical DBT literature on region size (non-wasm, but the mechanism is ISA-independent)

- QEMU: *"mechanisms that allow multiple translation blocks (TBs) to be chained directly, without
  having to go back to the main loop"* (<https://www.qemu.org/docs/master/devel/tcg.html>). AFL's
  QEMU-mode measured *"a speedup of 3-4 times the mainline QEMU mode"* from re-enabling block chaining
  plus caching.
- Region/trace formation: *"a region can be a basic block, a trace (i.e., a single-entry multiple-exit
  path, also known as superblock), or as large as a whole function"*; processor-trace-guided region
  formation reports *"1.06x speedup"* over relaxed NETPlus (ACM 10.1145/3281664; the full text returned
  HTTP 403 to me, so this is **from search-result summary, not read directly — hedged**).
- HQEMU-class x86→x86-64 translation reports *"an average speedup of 1.62X in integer benchmarks, and
  3.02X in floating point benchmarks compared to QEMU"* (same caveat).

---

## 4. Q3 — Tail calls: **shipping in Chrome, and already used here**

Status: **shipped, not a flag.**

- V8: <https://v8.dev/blog/wasm-tail-call> — *"We are shipping WebAssembly tail calls in V8 v11.2!"*
  (published 6 April 2023). Opcodes: *"The WebAssembly tail call proposal adds their tail call
  counterparts: `return_call` and `return_call_indirect`."*
- Baseline: <https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline> — *"These web features
  are now available in all three major browser engines, and become **Baseline Newly available** as of
  December 11, 2024."*
- Part of the ratified standard: <https://webassembly.org/news/2025-09-17-wasm-3.0/> — *"Tail calls are
  a variant of function calls that immediately exit the current function, and thereby avoid taking up
  additional stack space."* Wasm 3.0 completed 17 September 2025.
- The proposal repo `WebAssembly/tail-call` was archived 3 March 2025 (search result) — i.e. done.

**And this JIT already emits them**: `ppc_emit.cpp:313, 395, 400, 432, 1748, 1756, 2371`;
`gekko_emit.cpp:1086, 1177`. So "adopt tail calls" is not an available lever — it is the status quo.

Three caveats that are *not* widely repeated and that matter here:

1. **Liftoff does not optimise tail calls.** <https://v8.dev/blog/wasm-tail-call>:
   > "Liftoff pushes the parameters, return address, and frame pointer to complete the frame as if this
   > was a regular call, and then shifts everything downwards to discard the caller frame"
   …and "they are not optimized in this tier", producing code that is "slower, but eventually tiers up
   to TurboFan if the function is hot enough."
   Newly compiled block modules therefore pay a *worse-than-call* chain edge until they tier up. With
   thousands of short-lived blocks, a large fraction of chain edges may never leave Liftoff.

2. **Tail-call dispatch has measured *worse* than the alternative in wasm.** Matt Keeter,
   <https://www.mattkeeter.com/blog/2026-04-05-tailcall/>, comparing a tail-call interpreter against a
   loop/match interpreter on a Mandelbrot benchmark:
   > Firefox 1.2x slower (311 ms vs 264 ms), **Chrome 3.7x slower (905 ms vs 244 ms)**, wasmtime 4.6x
   > slower (595 ms vs 128 ms)
   with the explanation *"Patterns which generate good assembly don't map well to the WASM stack
   machine, and the JITs aren't smart enough to lower it to optimal machine code."*
   This is an interpreter dispatch loop, not block-to-block chaining, so it does not transfer directly —
   but it is a direct, recent, Chrome-specific counterexample to "tail calls make dispatch fast", and it
   should be treated as a warning that `return_call_indirect` chaining deserves an A/B against a plain
   return-to-`bem_chain_loop_c`, not an assumption.

3. **Stack traces lose tail callers** — *"tail callers do not appear in stack traces… nor in the
   DevTools stack trace"* (V8 blog). Relevant to why profiles here show flat self-time rather than a
   guest call tree.

The historical article claiming Liftoff lacks tail-call support
(<https://labs.leaningtech.com/blog/extreme-webassembly-2-the-sad-state-of-webassembly-tail-calls>) is
dated **18 August 2020** and is stale in every particular; do not cite it.

---

## 5. Q4 — Other proposals: shipping vs not

### Shipping in real Chrome today

| Feature | Chrome status | Citation | Used here? |
|---|---|---|---|
| Fixed-width SIMD (`0xFD`) | shipped long ago; part of Wasm 3.0 baseline | <https://webassembly.org/news/2025-09-17-wasm-3.0/> | **yes** (`wasm_module_builder.h:633-673`) |
| Relaxed SIMD | shipped Chrome 114 (search result, **not read directly — hedged**); Wasm 3.0: *"Wasm 3.0 introduces 'relaxed' variants of these instructions that are allowed to have implementation-dependent behavior in certain edge cases."* | webassembly.org, above | **yes** (`jit_paired.cpp:517, 669`) |
| Tail calls | shipped V8 11.2 / Baseline 2024-12-11 | §4 | **yes** |
| **Branch hints** | **shipped Chrome M136** — Intent to Ship, 25 March 2025: *"Shipping on desktop 136, Shipping on Android 136, Shipping on WebView 136"* | <https://www.mail-archive.com/blink-dev@chromium.org/msg13157.html> | **NO — half-built** |
| Sign-extension ops | Wasm 2.0, universally shipped | — | **NO — absent** |
| Bulk memory | Wasm 2.0, universally shipped | — | encoder only, no callers |
| Multi-value | Wasm 2.0, universally shipped | — | **NO** |
| Typed function references / `call_ref` | Wasm 3.0: *"Reference types can now describe the exact shape of the referenced heap value"*, adds `call_ref` | webassembly.org | **NO** |
| Exception handling (`exnref`) | Wasm 3.0; Safari 18.4 completed the set | <https://platform.uno/blog/the-state-of-webassembly-2025-2026/> | **NO** |
| Memory64 | Chrome 133 (search result, **hedged**) | — | **NO**, and see caveat below |
| Multiple memories | Wasm 3.0; Safari expected 2026 | webassembly.org / platform.uno | **NO** |
| WasmGC | Wasm 3.0, all browsers | webassembly.org | **NO** — irrelevant here |

Branch-hint specifics (<https://github.com/WebAssembly/branch-hinting>): a custom section named
`metadata.code.branch_hint`, *"each hint is a single byte that applies to a corresponding `br_if` or
`if` instruction"*, and it *"allows the engine to make better decisions for code layout (improving
instruction cache hits) and register allocation."* The Intent to Ship notes it has *"no effect on
existing code by design"* — i.e. it is a pure hint, zero correctness risk. Leaning Technologies' account
(<https://labs.leaningtech.com/blog/branch-hinting>) says it *"landed in V8 92 under an experimental
flag"* and that CheerpX used it *"with measurable performance improvements"* — but I found **no
published number**. The flycast-wasm writeup's claim that hints are *"dormant until Chrome's V8 enables
consumption by default"* appears to predate M136; **I could not verify which is current** and this
should be settled by a version check before investing.

`call_ref` has one property directly relevant to §2's instance check —
<https://v8.dev/blog/wasm-speculative-optimizations>:

> "The fast path for `call_ref` inlining doesn't require an explicit instance check, since the
> `WasmFuncRef` object that is the `call_ref` input already includes the instance the function closes
> over."

That is a genuinely different mechanism from `call_indirect` and is discussed as candidate #2 below.

Memory64 caveat worth recording before anyone reaches for it
(<https://platform.uno/blog/the-state-of-webassembly-2025-2026/>):

> "browser engines were able to make some optimizations around 32-bit pointers that they're not able to
> do with 64-bit pointers", potentially causing "a large performance hit depending on the workload."

### NOT deployable — proposal stage, do not build on these

From <https://raw.githubusercontent.com/WebAssembly/proposals/main/README.md>:

- **Compilation Hints — Phase 2** (champion Emanuel Ziegler). This is the feature we would most want.
  Per <https://raw.githubusercontent.com/WebAssembly/compilation-hints/main/proposals/compilation-hints/Overview.md>
  it defines a per-function **compilation priority** and **optimization priority** ("estimated
  hotness"), instruction **frequencies**, and — precisely our case — **call targets**: *"This hint
  identifies probable indirect call targets with associated frequency percentages for `call_indirect`
  or `call_ref` instructions."* **Phase 2 is not shippable. Do not plan against it.**
- **JIT Interface — Phase 1** (champion Ben Titzer). Adds `func.new`, *"a new core Wasm bytecode,
  `func.new`, which creates a new function at runtime from bytecode stored in Wasm memory"*, plus
  "scope" sections constraining what generated code may touch
  (<https://raw.githubusercontent.com/WebAssembly/jit-interface/main/proposals/jit-interface/Explainer.md>).
  Its Problem statement validates the batching lever from the spec side:
  > "guest runtimes that generate new code are few, and they make a number of compromises, such as
  > **batching generated functions**, in order to workaround limitations and cost of new modules on host
  > platforms."
  **Phase 1. Years away. Track it; do not wait for it.**
- **Stack Switching — Phase 3.** Not shippable.

### `br_table` codegen quality

I could not find an authoritative statement on V8's `br_table` lowering. The general framing —
*"`br_table` represents the performance characteristics of a jump table"*, and LLVM's decision that
*"reducing code size for wasm defers possible jump table optimizations to the VM"* (reviews.llvm.org
D60966, D80863) — is all I found, and it is **from search-result summaries, not read directly**. Since
the merged region shape's entry dispatch is a `br_table` (`ppc_emit.cpp:2318-2324`), this is a real
unknown that should be settled by measurement, not by citation. **Flagged as unverified.**

---

## 6. Q5 — SIMD for a big-endian guest on a little-endian host

**The premise in the brief is already implemented, and the repo has evidence the scalar version was not
costing what it looks like it costs.**

Implemented (`gamecube/bementalJIT/guests/powerpc-next/jit_load_store.cpp:69-97`), with the rationale in
a comment I read at `:70-85`:

> "emit_bswap_i32 is 11 ops and the paired-single / f64 memory ops call it TWICE (the two halves of one
> 8-byte access) = 22 ops per access. One i8x16.shuffle reverses both 4-byte lanes at once, so 22 -> 1
> (+2 tee/get to feed the shuffle's two v128 operands)."

Masks at `:88-90`, helper `emit_v128_shuffle_self` at `:93-97`, call sites at `:1161` (lfd), `:1198`
(stfd), `:1521` (psq_l), `:2219` (psq_st).

**The counter-evidence, from this repo, at `jit_load_store.cpp:270-278`:**

> "Result 2026-08-12: bswap kernel 42.6->40.6 ns/iter = FLAT (V8 folds the rotr/and) — bswap is NOT a
> convertible tax."

That is a measured null on the *scalar* 11-op bswap. And HEAD (`e52a1c1e`) reports a second, independent
null on the *SIMD* replacement: *"SIMD byte-swap is ALREADY LANDED (dd6759fb): -887 emitted ops, and its
own matched pair at usable load measured 0.994x = NO measurable runtime difference."*

Two nulls on the same lever, from two instruments. This is the single most important sanity check in
this whole document: **emitted op count is not proportional to time for ALU idioms**, because
Turboshaft folds recognisable patterns. Any candidate below that is justified purely by "fewer emitted
ops" inherits that risk — including the sign-extension candidate. **Byte-swapping is a closed
question here: do not reopen it.**

Where SIMD *does* have room, per the Emscripten porting guide
(<https://emscripten.org/docs/porting/simd.html>), which flags per-instruction x86 lowering costs:

- Enable flags: **`-msimd128`**, **`-mrelaxed-simd`**.
- Avoid these — they are documented multi-instruction on x86: `i8x16.[shl|shr_s|shr_u]` *"5-11 x86
  instructions"*, `i64x2.shr_s` *"6-12"*, `[f32x4|f64x2].[min|max]` *"7-10"*,
  `i32x4.trunc_sat_f32x4_[u|s]` *"8-14"*, `[i8x16|i64x2].mul` *"10"*.
- Prefer constant `i8x16.shuffle` over `i8x16.swizzle`: swizzle costs *"3 extra x86 instructions in
  some runtimes"* because *"The zeroing behavior does not match x86."* The repo already chose shuffle.
- `v128` load/store are marked 🟡 — *"there is some information missing (e.g. type or alignment
  information) for a Wasm VM to be guaranteed to reconstruct the intended x86 SSE opcode."*

Remaining big-endian-shaped SIMD opportunities, ranked by how much of the emitted board work they
plausibly touch (all **unmeasured — hypotheses**):

1. **Gekko paired-singles are literally 2×f32 — a native `v128` shape.** Dolphin's own JIT does exactly
   this: *"Dolphin's JIT optimizes paired-singles using x86-64 SSE instructions (2x floats per XMM
   register) on x86-64"* (<https://www.mintlify.com/dolphin-emu/dolphin/architecture/cpu-emulation>,
   **from search-result summary, not read directly — hedged**). The repo already keeps FPRs as 32 v128
   locals (`jit_load_store.cpp:86` notes LOCAL_PSQ_V is index 152, "APPENDED after the 32 FPR v128s
   (120..151)"), so the register file is already vector-shaped. **[from brief, unverified here]**
   paired-single load/store is 45.6% of the board's emitted work.
2. **`dcbz` (zero a 32-byte cache line)** → one `v128.store` pair or `memory.fill`. The bulk-memory
   encoder already exists unused (`wasm_module_builder.h:695-699`).
3. **Bulk guest DMA / display-list byte-swapping** on the host side — `i8x16.shuffle` over 16 bytes at a
   time rather than per-word.
4. **`lmw`/`stmw` and register-save/restore prologues** — adjacent 32-bit words, same shuffle trick.

Explicitly **not** worth doing on the evidence: converting the remaining scalar `emit_bswap_i32` sites
(`:350, 354, 363, 406, 410, 418, 461, 465, 615, 619, 774, 778, 2188, 2225, 2229`) to SIMD, because the
2026-08-12 measurement above says the scalar form is already free.

One correctness note found while reading: `gamecube/bementalJIT/tests/test_gekko_next.cpp:2619-2622`
records a known bug in `emit_bswap_i16` — *"`emit_bswap_i16`'s `(x>>>8)` term is not masked to a byte
before the"* … (stores `0x1D66` instead of `0x1D24`). I did not verify whether it is still live; **flagged
for whoever owns that file.**

---

## 7. Ranked candidates

Ranking criterion: (expected effect on the *measured* profile) × (probability it survives contact) ÷
(blast radius). "Contained" is my judgement of how much code moves and how reversible it is.

---

### #1 — Batch hot blocks into few multi-function modules with a **module-internal** table

> **MEASURED 2026-09-02 — partly confirmed, and its central design constraint is
> REFUTED.** `gamecube/tools/wasm_edge_cost_bench.mjs` priced the four topologies
> directly (Chrome 152 and node, 12 cells, identical bodies/terminal/edge counts):
> the shipping per-block-module edge costs **2.1-3.7x** more than a same-instance
> edge, so the mechanism is real and larger than this section dared claim. **But
> "module-internal" is not the operative word — SAME-INSTANCE is.** An imported
> table costs nothing detectable once the target is in the caller's instance
> (six paired Chrome cells, median 0.99x). The dispatch cache and the shared
> `__indirect_function_table` therefore need no redesign at all. Two further
> results bound the follow-through: a single module of **1024** functions loses
> most of the win (B collapses 118 -> 38 Medge/s, stable over 10 reps), so the
> hot set must span several modules; and at the recorded ~5% region hit rate the
> blended speedup is **1.03x**, which is precisely why the three A/Bs below came
> out negative. Full write-up + the unblocking plan:
> `gamecube/docs/cross-instance-edge-cost/TASKS.md`.

**Deployability:** shipping Chrome. No proposal, no flag.

**External citations:**
- V8: *"we check that the call target's instance matches the current instance… If not, we deoptimize"*,
  and inlining across instances *"(e.g., which are called via an imported table)"* is explicitly not
  implemented — <https://v8.dev/blog/wasm-speculative-optimizations>.
- SpiderMonkey: private-table specialisation makes *"internal calls become much faster −30%"* —
  <https://dbezhetskov.dev/opt-ind-call/>.
- flycast-wasm: multi-function modules amortise *"from about 1 ms per block to about 20 µs per block"*;
  and *"hot loops of 3-6 small blocks spend a large fraction of their time in dispatch overhead, and the
  register cache dies at every block boundary"*; their fix is *"statically-connected runs compiled as
  one module"* with *"chain heads primed into the dispatch table"* —
  <https://github.com/nasomers/flycast-wasm/blob/main/TECHNICAL_WRITEUP.md>.
- Wasm JIT-interface Explainer: batching generated functions is the recognised workaround for
  *"limitations and cost of new modules on host platforms"*.

**Concretely in this codebase:**
- The requirement is already written down: `include/bementalJIT/block_cache.h:17-20`.
- The violation is one line: `src/block_cache.cpp:620` (`env.__indirect_function_table = wasmTable;`)
  plus the matching `emitImportTable` at `guests/powerpc-next/ppc_emit.cpp:1984`.
- The compliant module shape **already exists and is tested**: `build_region_module_next`
  (`ppc_emit.cpp:2102-2168`) imports **no** table (`emitImportSection(1u + WIMPORT_COUNT)` at `:2125`)
  and declares an internal one (`beginTableSection(1); emitTable(n_funcs, true, n_funcs,
  WASM_REF_FUNCREF)` at `:2145-2147`) populated by an active element segment at `:2157-2163`.
- Intra-region edges already tail-call through that internal table on an own-gen match
  (`ppc_emit.cpp:381-397`), and already emit a **direct** `op_return_call(direct_fidx[di])` for
  statically known edges (`:297-315`).
- It is switched off in three places: `src/block_cache.cpp:233` (`g_bem_promote_enabled = 0`),
  `src/block_cache.cpp:2161` (`s_merged_enabled = false`), `JitWasm.cpp:750` (`if (false)`).

**Contained-ness: HIGH for the mechanism, LOW for the policy.** No new emitter is required. The work is
entirely in *which* blocks get batched and *when* — the selection policy.

**Strongest reasons it might not work — and these are serious:**

1. **It has already been tried twice and measured net-negative.** `src/block_cache.cpp:213-217`:
   *"[region-ab 2026-07-13] A/B RE-RUN on the Party-Mode LOBBY… promote ON = 13.3fps / jit=55-56ms vs
   OFF = 14.5fps / jit=51ms… NET-NEGATIVE (~-8%)"*, and `:229-232`:
   *"[2026-08-20 DISABLED — MEASURED NET-NEGATIVE] N-fn promotion is a board REGRESSION: page-fps A/B on
   the real board… OFF +36% vs ON (proxy: peFrames 1814 vs 1337)… dispatch self-time 18.7% ON -> 8.8%
   OFF."*
2. **But the recorded root causes are policy, not shape.** The same comments name them: *"the coverage
   wall (~5% region hit -> per-miss membrane tax)"*, *"the promote-ring prologue"*, and a region-FIRST
   dispatch loop that *"pays a wasted EM_ASM membrane crossing per miss"*. All three are removable, and
   `JitWasm.cpp:739-750` says the membrane one already was: *"sealed-gen entries now register their
   `fn_k` wrappers directly in the GLOBAL dispatch table… so the normal chain path below enters regions
   at measured-zero cross-instance cost — no per-hit EM_ASM, no JS-first loop."* That is exactly
   flycast-wasm's "chain heads primed into the dispatch table."
3. **The selection signal was wrong, and the repo says so.** `src/block_cache.cpp:220-226`:
   *"the old ~5%-hit wall was promotion SELECTION (chain-head signal / ~570 wrong blocks), NOT thin
   locality"*, with a census showing top-512 = 77.8% of board entries. **My independent re-analysis of
   four existing profiles reproduces that**: top-512 modules hold 76.7–96.2% of `wasm-function[13]`
   self-time (§0). So the coverage precondition is satisfied by a *sample-ranked* selection.
4. **The ceiling on the dispatch half is small.** `bem_chain_loop_c` is 5.1–14.5% of samples. Removing
   *all* of it buys 1.05–1.17x. The case for this lever is therefore **not** dispatch — it is
   (a) enabling V8 to inline block→block edges at all, and (b) letting the register cache survive a
   block boundary, which flycast-wasm valued at *"3-5x"* for the register cache generally.
5. **`br_table` entry dispatch in the merged shape is an unmeasured unknown** (§5).

**Recommended experiment shape:** rank blocks by *profile self-time* (the `callFrame.url` histogram in
§0 is exactly this data, obtainable offline from an existing cpuprofile), seal the top 256–512 into 1–2
merged modules with **no imported table on the intra-region edge**, prime `fn_k` into the global table,
and A/B on page-fps against the current per-block baseline. Do not re-introduce a region-first dispatch
loop.

---

### #2 — Emit the inline cache ourselves instead of relying on V8's (which cannot fire cross-instance)

> **MEASURED 2026-09-02 — REFUTED at realistic scale. Do not build this.** Arm C
> of `wasm_edge_cost_bench.mjs` is exactly this shape: guard the loaded slot
> against each statically-known successor, direct `return_call` on a match, fall
> back to the indirect edge. It wins at N=64 (175 vs 109 Medge/s) and **loses at
> N=512 in 4 of 6 Chrome cells** (59.00 vs 84.41; 64.78 vs 69.66 on the
> SAB-shaped cell). Across hundreds of functions the guard ladder and the code
> growth cost more than the saved dispatch. This section's own stated risk — "if
> the successor distribution at the hot edges is flat, this is pure added cost" —
> is the right instinct; the measurement says it is worse than that, because it
> loses even where the successor set is small and statically known.

**Deployability:** shipping Chrome.

**External citation:** winliner, "The WebAssembly Indirect Call Inliner" (fitzgen,
<https://github.com/fitzgen/winliner>) — profile-guided speculative inlining of `call_indirect` done
*as a wasm-to-wasm transform*: *"If the callee index matches the profiled target (e.g., 42), execute the
inlined function body; otherwise, fall back to the original `call_indirect`."* Rationale:
*"inlining allows subsequent compiler optimizations like GVN and LICM to operate on the inlined code."*
V8's own feedback shape bounds the fan-out: *"polymorphic (up to four call targets)"*.

**Concretely here:** this pattern already exists at `ppc_emit.cpp:297-315` — a constant bucket load, a
generation check, then `b.op_return_call(direct_fidx[di])`. It is gated on `region_gen >= 0`, i.e. it
only exists inside a region module.

The reason it *cannot* be lifted to the per-block shape as-is: a `return_call` targets a function index
**within the caller's own module**, and each block is its own module. So candidate #2 is **strictly
downstream of candidate #1** — batching is what creates the address space in which a self-emitted IC is
expressible.

**Contained-ness: MEDIUM.** The emitter code exists; extending it to a 2–4-way IC keyed on the profiled
successor distribution is a bounded change to `emit_chain_or_return`.

**Strongest reason it might not work:** a guarded direct call that mispredicts costs a compare + branch
*on top of* the table probe we already pay, and PowerPC blocks ending in `bclr`/`bctr` (returns and
computed jumps) are genuinely polymorphic. If the successor distribution at the hot edges is flat, this
is pure added cost. That distribution is measurable offline from the existing dispatch counters before
writing any emitter code — **do that first.**

---

### #3 — Attack the JS/wasm boundary, which is bigger than the dispatcher

**Deployability:** shipping Chrome (it is not a wasm feature at all — it is code placement).

**Evidence, mine, from existing artifacts (§0):** `wasm-to-js` + `js-to-wasm:*` + `wrapper` =
**13.96% / 13.46% / 14.35% / 22.65%** of samples across the four profiles — larger than
`bem_chain_loop_c` in every one of them. `GPFifo::GPFifoManager::UpdateGatherPipe()` is 2.32% self in
`sabB2_w4`.

**External citation:** flycast-wasm reduced *"roughly 450-500 K WASM-to-C import crossings per frame"*
to *"approximately 9 K crossings per frame"* with inline address guards and inline store-queue writes —
<https://github.com/nasomers/flycast-wasm/blob/main/TECHNICAL_WRITEUP.md>. General V8 guidance in the
same direction: JS↔wasm calls pass through wrappers that *"comes with a performance cost"*
(<https://v8.dev/blog/v8-release-90>).

**Concretely here — and note the brief's premise is stale, per HEAD:** the brief states GX draw loops
make "SIX wasm→host import calls PER VERTEX because there is no in-wasm write-gather buffer." An
in-wasm write-gather arm **does** exist: `jit_load_store.cpp:472-664` implements
`GPFifo::FastWrite{8,16,32} + CheckGatherPipe` inline, with the region test at `:581-593` and the drain
still crossing via `WIMPORT_GATHER_DRAIN = 12` (`:568`). The **const-EA** store path now routes through
it too: `jit_load_store.cpp:1090-1104` emits `emit_gp_append` under a CPU-owner check before falling
back to `write_import_for_width`.

HEAD (`e52a1c1e`) is explicit about this and is the authority: *"'Six host import calls per vertex'
OVER-COUNTS: the FP half already takes the in-wasm arm live (emit_fp_words_gp_or_import, :729+). Only
the INTEGER const-EA half was still crossing."* — and that commit's Lever 2 closed it, measuring
*"43 emitted host-import call sites eliminated (-20 write8, -5 write16, -18 write32) across 6 blocks,
each dropping to ZERO"*, with the honest caveat *"Runtime effect UNMEASURED."*

**So the 13.5–22.7% boundary share I measured predates that fix.** It is not a live target number; it
is evidence that the boundary is worth continuing to attack, and the correct next step is to
re-profile after `e52a1c1e` rather than to design a new lever from my figure.

**Contained-ness: HIGH per path, but it is a long tail.** The named crossings still visible in the
profile are `dolphin_write32` (0.93%), `dolphin_read32` (0.78%), `stateless_read_w` (0.87%),
`PowerPC::MMU::Read<u32>` (0.86%), `MMU::WriteToHardwareSized<...,4u,false>` (1.13%),
`Interpreter::SingleStepInner()` (0.88%), `readEmAsmArgs` (0.88%) — each individually small.

**Strongest reason it might not work:** `wasm-to-js`/`wrapper`/`js-to-wasm` self-time is *the wrapper*,
not the work; some of it is unavoidable MMIO that must reach Dolphin's C++ device models. And the brief
warns (CLAUDE.md gate #10) that a profile share for anything that waits is inflated by the profiler.
**Size this with matched pairs, never from the cpuprofile.**

---

### #4 — Branch hints (`metadata.code.branch_hint`), shipped Chrome M136

**Deployability:** shipping Chrome, per the Intent to Ship — *"Shipping on desktop 136, Shipping on
Android 136, Shipping on WebView 136"*, 25 March 2025
(<https://www.mail-archive.com/blink-dev@chromium.org/msg13157.html>). *"no effect on existing code by
design"* — zero correctness risk.

**Concretely here — it is 60% built and 0% wired.** `op_if_hinted` exists at
`include/bementalJIT/wasm_module_builder.h:753-756` and records offsets into `m_branch_hints` (`:816`),
exposed by `branchHints()` (`:757`). But:
- grep for `op_if_hinted` across `include/ guests/ src/` found **only the definition** — no call sites;
- there is **no custom-section emitter** in the builder at all (grep for `emitCustom|CustomSection`
  returned nothing), so the recorded hints cannot be written out.

The branches worth hinting are all statically known-biased and all already emitted:
the fastmem guard (`jit_load_store.cpp`, `emit_fastmem_guard` → `op_if` at `:895`), the downcount bail
(`ppc_emit.cpp:233-244`), the exception-vector guard (`:257-272`), and the dispatch tag compare
(`:325-332`).

**Contained-ness: HIGH.** One custom-section emitter (~30 lines) plus a `likely` argument at ~6 emit
sites. Fully reversible; a no-op on engines that ignore it.

**Strongest reasons it might not work:** (a) I found **no published measurement** of branch-hint benefit
from anyone — Leaning Technologies claims CheerpX saw *"measurable performance improvements"* but
publishes no number, and the Intent to Ship contains *"no quantified performance measurement claims"*;
(b) flycast-wasm's writeup asserts hints are *"dormant until Chrome's V8 enables consumption by
default"*, which contradicts the M136 Intent to Ship — **I could not determine which is currently
true**, and this must be checked against the actual Chrome build before spending effort; (c) hints
affect code layout and register allocation, not instruction count, so the effect is likely small.

---

### #5 — Larger blocks: enable branch following / raise the terminator-bounded ceiling

**Deployability:** no wasm feature involved.

**External citations:** flycast-wasm's diagnosis is verbatim ours — *"hot loops of 3-6 small blocks
spend a large fraction of their time in dispatch overhead, and the register cache dies at every block
boundary."* QEMU block chaining measured *"a speedup of 3-4 times the mainline QEMU mode"* in AFL's
qemu-mode when re-enabled. Region-formation literature reports 1.06x (PT-guided vs NETPlus) and
1.62x/3.02x (HQEMU-class vs QEMU) — both **from search summaries, hedged**.

**Concretely here:**
- Cap is 64 instructions (`JitWasm.cpp:101`), and the repo already records that raising it to 160 was a
  wash because *"the hot working set is TERMINATOR-bounded (branches every <64 instrs), not
  cap-bounded"* (`JitWasm.cpp:89-100`).
- The unexploited knob is **branch following**: `m_enable_branch_following = false` at
  `guests/powerpc-next/ppc_analyst.h:75`, with a setter at `:41` that nothing calls. `JitWasm.cpp:96-99`
  calls it *"PM39's #1 structural item."*
- Run-fusion across seams exists (`src/block_cache.cpp:2175-2400`) but only fires at **seal** time, so
  with `g_bem_promote_enabled = 0` it never runs — the whole fusion lever is currently inert, which is
  consistent with the memory note that all four seal-census cells read 0 on a live scene.
- Leaf-call inlining is live and is the one form of superblock formation currently doing work
  (`ppc_analyst.h:194`, `JitWasm.cpp:1065-1110`).

**Contained-ness: MEDIUM.** Branch following changes what a block *is*, which touches SMC invalidation
(`m_fused_succ_to_pred`, `block_cache.h:289`), exception PC attribution, and the downcount accounting.
Not a flag flip.

**Strongest reason it might not work:** blocks of 3–5.5 instructions **[from brief, unverified here]**
are that small because the guest branches that often; following branches produces *speculative* code
that must still check the condition, so you trade a dispatch for a compare — the classic superblock
trade, and the literature's honest number for it is 1.06x, not 2x. Also, bigger blocks mean more
emitted code per block, and the 46.3x amplification **[from brief]** means code size is already a
pressure.

---

### #6 — Sign-extension opcodes (`i32.extend8_s` / `i32.extend16_s` / `i64.extend32_s`)

**Deployability:** Wasm 2.0; shipping everywhere for years.

**Concretely here:** absent from the encoder (verified: no `extend8_s`/`extend16_s`/`extend32_s` and no
`0xC0`–`0xC4` constants in `wasm_module_builder.h`). Every `extsb`/`extsh` and every signed sub-word
load therefore emits a shift pair plus two `i32.const`s — 4 ops where 1 would do.

**Contained-ness: VERY HIGH.** Five encoder methods plus the call sites in `jit_integer.cpp` and
`jit_load_store.cpp`. Trivially A/B-able and conformance-covered by `test_diff_next`.

**Strongest reason it might not work — and it is a strong one:** the repo's own measurement says exactly
this class of change is free-but-worthless. `jit_load_store.cpp:270-278`: stripping the 11-op bswap
entirely moved a kernel *"42.6->40.6 ns/iter = FLAT (V8 folds the rotr/and)."* Turboshaft almost
certainly folds `shl;shr_s` into a single sign-extending move too. **Expect a null.** The honest reason
to do it anyway is code size (46.3x amplification **[from brief]** is itself a cost — compile time,
instruction cache, and V8's own inlining budgets), not speed. Frame it that way or don't do it.

---

### #7 — `call_ref` / typed function references for the chain edge

**Deployability:** shipping — part of Wasm 3.0, *"Reference types can now describe the exact shape of the
referenced heap value"* plus *"the new `call_ref` instruction"*
(<https://webassembly.org/news/2025-09-17-wasm-3.0/>).

**Why it is interesting:** V8 explicitly says `call_ref` avoids the instance check that breaks us —
*"The fast path for `call_ref` inlining doesn't require an explicit instance check, since the
`WasmFuncRef` object that is the `call_ref` input already includes the instance the function closes
over"* (<https://v8.dev/blog/wasm-speculative-optimizations>). If that removes one of the two deopt
conditions for cross-instance edges, it is the only candidate that improves the *current* per-block
topology without batching.

**Concretely here:** would require reference types beyond `funcref`-in-tables (currently
`WASM_REF_FUNCREF = 0x70` used only for table element types), a way to get a `funcref` value into the
block (a `ref.func` won't reach another module — it would have to come from a `table.get` on a funcref
table, or be passed in), and a typed function type. The dispatch cache currently stores an **i32 table
index** in linear memory (`ppc_emit.cpp:317-332`), which cannot hold a reference — so the cache would
have to become a wasm table of funcrefs plus a parallel tag array.

**Contained-ness: LOW.** This is a redesign of the dispatch cache representation.

**Strongest reason it might not work:** V8's sentence is about *inlining*, not about the base call cost;
removing the instance check may not remove the *other* deopt condition (wrong target), and a
cross-instance target still cannot be inlined per the same blog's "additional compiler machinery"
paragraph. **I could not find any statement that `call_ref` is inlinable across instances.** Treat this
as research, not a plan.

---

### #8 — Bulk memory for `dcbz` and block copies

**Deployability:** Wasm 2.0, shipping everywhere.

**Concretely here:** `op_memory_fill` and `emitDataCountSection` exist at
`wasm_module_builder.h:695-699` and `:429` with **zero call sites**. `dcbz` zeroes a 32-byte cache line
and is common in GameCube framebuffer/heap code; `memory.fill` is the natural lowering.

**Contained-ness: HIGH.** One instruction's emitter, plus wiring the data-count section.

**Strongest reason it might not work:** two `v128.store`s may already be as fast as `memory.fill` for 32
bytes, and V8's `memory.fill` has a call-out threshold for small sizes that I did not verify.
**Unmeasured.**

---

### #9 — Multi-value, multi-memory, memory64

All shipping; all **low expected value here**, listed so nobody re-researches them.

- **Multi-value** — unused (`emitFuncType` supports it, every caller passes 0 or 1). Could let a block
  return `(next_pc, status)` without a store. The status already lives in linear memory that the C loop
  reads; the saving is a couple of ops per block exit. Small.
- **Multi-memory** — *"a single module can now declare (define or import) multiple memories"*
  (webassembly.org). Could separate guest RAM from JIT scratch, but adds a memory index to every access
  encoding and buys no bounds-check saving we don't already have. **Not recommended.**
- **Memory64** — actively risky: *"browser engines were able to make some optimizations around 32-bit
  pointers that they're not able to do with 64-bit pointers"*, with *"a large performance hit depending
  on the workload"* (<https://platform.uno/blog/the-state-of-webassembly-2025-2026/>).
  **Do not adopt.**

---

### #10 — Interpreter tier for cold blocks (instance-count control)

**Deployability:** no wasm feature involved.

**External citations:** QEMU's wasm backend runs TBs *"on TCI by default, with frequently executed TBs
compiled into WebAssembly"* explicitly *"to minimize compilation overhead and avoid hitting the
browser's limitation of the number of instances"*, and v3 *"lowered the maximum number of instances
(MAX_INSTANCES) to avoid the out of memory error in recent versions of FireFox"*. CheerpX uses the same
two-tier shape (<https://labs.leaningtech.com/blog/cx-10>).

**Concretely here:** an interpreter bridge already exists (`ppc_interp` is import idx 6,
`ppc_emit.cpp:1982`; `Interpreter::SingleStepInner()` shows at 0.88% in `sabB2_w4`), and
`Module._bemental_next_idx` never reuses a table index (`src/block_cache.cpp:109-112`). The four
profiles show 2,184–4,461 *live-and-sampled* modules; the total created is presumably much larger.

**Contained-ness: MEDIUM.** Policy change plus an eviction path.

**Strongest reason it might not work:** this is a *memory and compile-latency* lever, not a throughput
lever. It would only show up in steady-state fps if instance count is currently causing engine-side
pressure — **which I have not measured and cannot measure without a run.**

---

## 8. What I could not verify — read this before acting

1. **I ran no build, probe, or browser.** Every number in §0 comes from `.cpuprofile` files that were
   already on disk, dated 2026-08-29. I do not know which build, which scene, or which arm produced
   them, and profiles taken *with* a profiler attached are not comparable to unprofiled runs
   (CLAUDE.md gate #10). Treat §0's percentages as *structural* evidence (what the symbol names mean,
   how the time is distributed across modules) and **not** as a performance baseline.
   **They also predate HEAD (`e52a1c1e`, 2026-09-01)**, whose Lever 1 cut the per-edge terminal from
   41.3 to 32.8 unconditional ops and whose Lever 2 removed 43 host-import call sites. Both move
   exactly the two quantities §0 reports (`bem_chain_loop_c` share, boundary share). Any decision that
   turns on those percentages needs a fresh capture on HEAD first.
2. **The "68% / 49–50%" figure in the brief does not reproduce** in the four artifacts I checked
   (38.0%, 47.1%, 48.9%, 51.5%). Unreconciled.
3. **Unverified inputs taken from the brief:** the 46.3x amplification, the 9,388→434,681 op counts,
   the 15.6x-vs-Jit64 comparison, SAB 0.4115x, `ai_dma_cb` 1647.38/s, 3–5.5 guest instructions per
   block, "six imports per vertex", and the 1.47x/3.77x ceiling arithmetic.
4. **Branch-hint consumption status in the shipped Chrome** — the M136 Intent to Ship and the
   flycast-wasm writeup disagree. Not resolved.
5. **`br_table` lowering quality in V8** — no authoritative source found; the merged region shape
   depends on it.
6. **V8 wasm limits** (`kV8MaxWasmFunctions`, `kV8MaxTableSize`) — from search-result summaries of
   `wasm-limits.h`, not read directly.
7. **Dolphin's SSE paired-single handling** and the ACM/HQEMU region-formation numbers — from
   search-result summaries; the ACM full text returned HTTP 403.
8. **`emit_bswap_i16` masking bug** noted at `tests/test_gekko_next.cpp:2619-2622` — I did not check
   whether it is still live.

---

## 9. Sources

- [Speculative Optimizations for WebAssembly using Deopts and Inlining · V8](https://v8.dev/blog/wasm-speculative-optimizations)
- [WebAssembly tail calls · V8](https://v8.dev/blog/wasm-tail-call)
- [WebAssembly compilation pipeline · V8](https://v8.dev/docs/wasm-compilation-pipeline)
- [WebAssembly Architecture in V8 (docs/wasm/architecture.md)](https://raw.githubusercontent.com/v8/v8/main/docs/wasm/architecture.md)
- [WebAssembly Dynamic Tiering ready to try in Chrome 96 · V8](https://v8.dev/blog/wasm-dynamic-tiering)
- [V8 release v9.0 · V8](https://v8.dev/blog/v8-release-90)
- [WasmGC and Wasm tail call optimizations are now Baseline Newly available · web.dev](https://web.dev/blog/wasmgc-wasm-tail-call-optimizations-baseline)
- [Wasm 3.0 Completed · webassembly.org](https://webassembly.org/news/2025-09-17-wasm-3.0/)
- [WebAssembly/proposals README (phases)](https://raw.githubusercontent.com/WebAssembly/proposals/main/README.md)
- [WebAssembly/compilation-hints Overview.md](https://raw.githubusercontent.com/WebAssembly/compilation-hints/main/proposals/compilation-hints/Overview.md)
- [WebAssembly/jit-interface Explainer.md](https://raw.githubusercontent.com/WebAssembly/jit-interface/main/proposals/jit-interface/Explainer.md)
- [WebAssembly/branch-hinting Overview](https://github.com/WebAssembly/branch-hinting/blob/main/proposals/branch-hinting/Overview.md)
- [Intent to Ship: WebAssembly Branch Hints (blink-dev, 2025-03-25)](https://www.mail-archive.com/blink-dev@chromium.org/msg13157.html)
- [WebAssembly Branch Hinting: From an idea to W3C standard · Leaning Technologies](https://labs.leaningtech.com/blog/branch-hinting)
- [nasomers/flycast-wasm](https://github.com/nasomers/flycast-wasm) · [TECHNICAL_WRITEUP.md](https://github.com/nasomers/flycast-wasm/blob/main/TECHNICAL_WRITEUP.md)
- [tcg: Add WebAssembly backend (QEMU cover letter)](https://www.mail-archive.com/qemu-devel@nongnu.org/msg1116287.html) · [v3 (2025-09)](https://lists.gnu.org/archive/html/qemu-devel/2025-09/msg00163.html) · [ktock/qemu-wasm](https://github.com/ktock/qemu-wasm)
- [CheerpX 1.0: High performance x86 virtualization in the browser via WebAssembly](https://labs.leaningtech.com/blog/cx-10)
- [Extreme WebAssembly 1: pushing browsers to their absolute limits (2020-06-16)](https://labs.leaningtech.com/blog/extreme-webassembly-1-pushing-browsers-to-their-absolute-limits)
- [Extreme WebAssembly 2: the sad state of WebAssembly tail calls (2020-08-18 — STALE)](https://labs.leaningtech.com/blog/extreme-webassembly-2-the-sad-state-of-webassembly-tail-calls)
- [WATaBoy: JIT-ing Game Boy Instructions to Wasm Beats a Native Interpreter (2026-06-28)](https://humphri.es/blog/WATaBoy/)
- [just-in-time code generation within webassembly — wingolog](https://www.wingolog.org/archives/2022/08/18/just-in-time-code-generation-within-webassembly)
- [Optimization of Wasm's indirect calls for SpiderMonkey — Dmitry Bezhetskov](https://dbezhetskov.dev/opt-ind-call/)
- [Dynamic linking & indirect calls · emscripten-core/emscripten#8268](https://github.com/emscripten-core/emscripten/issues/8268)
- [SIMD support — Emscripten docs](https://emscripten.org/docs/porting/simd.html)
- [winliner: The WebAssembly Indirect Call Inliner](https://github.com/fitzgen/winliner)
- [A tail-call interpreter in (nightly) Rust — Matt Keeter](https://www.mattkeeter.com/blog/2026-04-05-tailcall/)
- [Translator Internals — QEMU documentation](https://www.qemu.org/docs/master/devel/tcg.html)
- [The State of WebAssembly – 2025 and 2026 · Uno Platform](https://platform.uno/blog/the-state-of-webassembly-2025-2026/)
- [Ruffle Roadmap](https://github.com/ruffle-rs/ruffle/wiki/Roadmap)
