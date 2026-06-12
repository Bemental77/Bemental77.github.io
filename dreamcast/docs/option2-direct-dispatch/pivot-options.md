# SH4 throughput pivot options — sideways angles

Companion to `README.md` + `BLOCKERS.md`. We've cliff'd at ~9.5K block-dispatches/sec; native target is ~20M (~2000×). Five-researcher consensus is that Option 2 (Emscripten MAIN_MODULE/SIDE_MODULE + dlopen) has 5 hard blockers and is not credible. This doc explores other architectures.

Constraint: no time estimates. Speculation flagged. Citations required.

---

## TL;DR — what to do next

**Try Angle 7 first** (single change in one file, replicates the production architecture used by nasomers/flycast-wasm wasm-jit that reportedly reaches **20-40+ FPS** on Dreamcast titles in WASM). It is the strongest production precedent we have, and it converges on what our Option 2 was trying to achieve but does it in 1 file instead of 7 phases.

Drop Option 2 entirely. Drop the multi-module sharding plan. Drop SIDE_MODULE/dlopen.

---

## The angles

### Angle 1 — Per-game ahead-of-time (AOT) static recompilation

**Description.** Statically translate the PSO disc image's SH4 code to WASM offline, ship the resulting module(s). At runtime, no JIT — just dispatch into a fixed function table.

**Production examples.**
- **N64Recomp** ([N64Recomp/N64Recomp](https://github.com/N64Recomp/N64Recomp)) statically recompiles MIPS N64 ROMs to C. Produces shippable native ports (Zelda 64 Recompiled, Majora's Mask Recompiled). Per [readonlymemo.com](https://readonlymemo.com/decompilation-projects-and-n64-recompiled-list/), the technique requires significant per-game tweaks (instruction patterns, undefined behavior, indirect-jump tables).
- **PS2Recomp** (mentioned in [Time Extension Jan 2026](https://www.timeextension.com/news/2026/01/native-pc-ports-of-ps2-games-could-be-on-the-way-thanks-to-new-recompilation-experiment)): "there won't be a single static recompiler for the PS2 that just recompiles any ISO… they'll need to have per-game tweaks."
- **redream** is dynamic, not AOT. ([redream.io progress 2018](https://redream.io/posts/progress-report-january-2018) confirms: "the SH4 code is dynamically recompiled… results are cached.")
- **No AOT SH4-to-anything project exists in production.** Speculation: PSO has self-modifying code via the SH4's `OCBP`/`OCBI` and apploader chains; static lifting would need to fall back to a JIT for unknown regions anyway.

**Cost in our codebase.** Tooling does not exist. Would need:
- An offline SH4 lifter (decoder ≈ `flycast-src/core/hw/sh4/dyna/decoder.cpp:*`)
- Indirect-jump-table discovery for `jmp @Rn`/`braf` (N64Recomp had thousands of LOC for this on MIPS)
- A WASM emitter targeting the host runtime + `Sh4Context` ABI (≈ what `bementalJIT/guests/sh4/wasm_emit.cpp` already does but with no dynamic context)
- Fallback dispatch for unrecognized code paths
- Per-game patching kit similar to N64Recomp's `mods/` mechanism

**Expected throughput.** Speculation: if static recompilation lands, WASM execution would be at Liftoff-tier baseline — V8 published baseline is "tens of MB/s compile, runs at ~50% of TurboFan" ([Liftoff blog](https://v8.dev/blog/liftoff)). With TurboFan over time, single-digit-percent slower than native ([Jangda et al, USENIX ATC '19](https://www.usenix.org/system/files/atc19-jangda.pdf): WebAssembly is 1.55× slower than native on average on V8). At 200 MHz emulated SH4, that's ≥75% native. **Plausibly ships PSO at full speed if it works.**

**Blocker that kills it.** N64Recomp's MIPS lifter took years and required per-game patches. SH4 has nothing equivalent. PSO uses self-modifying loaders (apploader, syscalls in ROM-mapped area, GD-ROM-driver overlays). A first-cut AOT lifter would have to fall back to a JIT for unhandled code, which means we still need everything we have today plus a brand-new offline pipeline. This is a from-scratch research project, not a pivot.

**Verdict.** Out of scope for a near-term pivot. Worth noting as a long-term roadmap item if/when dynamic JIT hits a ceiling we can't break.

---

### Angle 2 — Pure SH4 interpreter in WASM (skip the JIT entirely)

**Description.** Compile flycast's `Sh4Interpreter::Run()` (existing, at `dreamcast/flycast-src/core/hw/sh4/interpr/sh4_interpreter.cpp:41-69`) to WASM via Emscripten. No dynarec. Dispatch is `OpPtr[op](ctx, op)` in a tight C loop. V8 compiles the C loop to Liftoff → TurboFan once and never re-Liftoffs.

**Production examples.**
- **flycast-wasm main branch** ([nasomers/flycast-wasm](https://github.com/nasomers/flycast-wasm)) ships exactly this. README data:
  - v1 interpreter: 0.4-5 FPS
  - upstream interpreter: 0.4-5 FPS
  - upstream + ASYNCIFY_REMOVE optimization: 0.5-6.7 FPS (+37%)
- For comparison the same project's wasm-jit branch reaches 20-40+ FPS — meaning **pure interpreter loses to JIT by ~6-8× on Dreamcast titles**, much closer than the our current 21000-2000× gap.
- **PS1 in our own repo** (`ps1/ps1Wasm/`) ships PCSX-wasm-style pure interpreter and runs commercial titles at full speed. PS1 R3000A is ~33 MHz vs SH4 200 MHz, so the rate-ratio shows interpretation can sustain ~6× the work.

**Cost in our codebase.** Flycast already has both paths wired:
- `dreamcast/flycast-src/core/emulator.cpp:513` → `recompiler = Get_Sh4Recompiler();`
- `dreamcast/flycast-src/core/emulator.cpp:520` → `interpreter = Get_Sh4Interpreter();`
- `dreamcast/flycast-src/core/emulator.cpp:528` → selected by `if(config::DynarecEnabled)`

In `dreamcast/flycast-bridge/EmscriptenWorker.cpp`, add **one line** alongside the `ThreadedRendering.override(false)` at line 396:
```cpp
config::DynarecEnabled.override(false);
```
Then drop `bementalJIT` from the link entirely (or leave it dead-code — `FEAT_SHREC == DYNAREC_JIT` won't be compiled into the SH4 path).

There is no "skip the bridge" — flycast's interpreter calls `IReadMem16`/`OpPtr[op]`/`sh4cycles.executeCycles(op)`, all of which already work in the WASM build because the same memory model is used by the dynarec.

**Expected throughput.** Speculation, but anchored: nasomers measured 0.4-5 FPS with stock Emscripten settings. We get the **same +37% lift** from ASYNCIFY_REMOVE on hot interpreter functions (currently we have `-sASYNCIFY=1` unconditionally — `dreamcast/flycast-bridge/flycast_worker_link.sh:202`). So ~0.5-6.7 FPS as a first cut, possibly more once we also strip Asyncify from `Sh4Interpreter::Run` + `OpPtr` + `IReadMem*` + `Do_Exception`.

**Blocker that kills it.** None structural — flycast supports it natively. But the resulting throughput is bounded at ~7 FPS on PSO. **Insufficient to render gameplay** (PSO needs ≥30 FPS for menu/input/audio sync). **However**, it would unlock "first frame renders" as a milestone, which we cannot achieve today.

**Verdict.** Worth shipping as a **side branch** for milestone hunting (does rendering pipeline actually work? Does audio sync?). Not a final answer.

---

### Angle 3 — Parallelism: threaded rendering + parallel block speculation

**Description.** SH4 dispatch is inherently single-threaded. But rendering, audio, and DMA can move off-core. Flycast already ships `ThreadedRendering=true` by default (`dreamcast/flycast-src/core/cfg/option.cpp:112`). **We force it OFF** in `dreamcast/flycast-bridge/EmscriptenWorker.cpp:396`.

**Production examples.**
- **Parallel-N64** ([libretro.com/parallel-n64](https://www.libretro.com/index.php/parallel-n64-with-parallel-rsp-dynarec-release-fast-and-accurate-n64-emulation/)): parallel RSP dynarec + multithreaded ANGRYLION. Fastest LLE N64 core.
- **Speculative parallel CPU emulation**: no production precedent for single-thread guest CPUs. ([Grokipedia: Dynamic recompilation](https://grokipedia.com/page/Dynamic_recompilation) only mentions branch prediction within a block.)

**Cost in our codebase.**
- Re-enabling ThreadedRendering: remove the override at `EmscriptenWorker.cpp:396`, then debug whatever broke when we disabled it. The comment at `EmscriptenWorker.cpp:714` says "ThreadedRendering=true runs on a std::async-spawned pthread. Plain […]" — implying pthread/Asyncify interaction. Our `flycast_worker_link.sh:201` has `PTHREAD_POOL_SIZE=8`, so the slot exists.
- Speculative-execute: speculation, no precedent. Don't pursue.

**Expected throughput.** Speculation, but bounded: GPU work moves off the SH4 thread, so the SH4 thread gains back the cycles it was spending on `pvr::core_vblank` work. From the cycle-drain in `rec_wasm.cpp:920-960`, the per-VBLANK cost is non-trivial. Best case **single-digit-percent CPU-time reclaim** for the SH4. Does not change the fundamental dispatch ceiling.

**Blocker that kills it.** ThreadedRendering was DISABLED for a reason — original comment "DEBUG: force ThreadedRendering=false to bypass std::async pthread." It probably broke under Asyncify or our SAB layout. Re-enabling requires debugging the original failure. The win is modest even if it works.

**Verdict.** Low priority. Re-investigate when SH4 throughput is already at-or-near native and audio/render sync is a frame-pacing question.

---

### Angle 4 — Lower-fidelity SH4 clock

**Description.** Run SH4 at simulated 50 MHz instead of 200 MHz. Audio plays slow but game logic runs.

**Production examples.** None for Dreamcast. **PCSX2/PCSX-R EE-cyclerate** ([pcsx2.net](https://pcsx2.net/)) does this for PS2 EE clock at -75% — well-documented hack. Speculation that the same trick can work for SH4.

**Cost in our codebase.**
- Flycast does not expose a clock-scaling knob. `SH4_TIMESLICE = 448` at `dreamcast/flycast-src/core/hw/sh4/sh4_sched.h:4` is the timeslice; `CPU_RATIO = 8` is hardcoded in `dreamcast/flycast-src/core/hw/sh4/sh4_cycles.h:67-71`.
- Closest existing flycast option: `SkipFrame` / `AutoSkipFrame` at `dreamcast/flycast-src/core/cfg/option.cpp:102-104`. This is **frame** skipping (skip TA rendering work), not CPU clock scaling.
- Would need to either patch flycast-src (against our no-patching rule per `feedback_no_dolphin_patching.md`) or hack `sh4cycles.executeCycles` in our bridge.

**Expected throughput.** **Does not help dispatch throughput.** Slowing the simulated clock does not change the actual dispatch-per-wallsec rate — it only changes how guest-cycle accounting compares to wall time. If we're at 9.5K disp/s wall, a slower simulated clock means we appear to run at higher % of native, but actual game progress is the same.

What CAN help is **reducing the work per SH4 cycle**: SkipFrame=1 cuts TA list builds in half. This is real wallclock reduction.

**Blocker that kills it.** Clock-scaling does not address the ceiling. Frame-skipping helps render-bound workloads but PSO is CPU-bound (we don't reach rendering today).

**Verdict.** Skip. Misnamed pivot — what we actually want is `SkipFrame` enabled, which is one config line, separate from anything dispatch-related.

---

### Angle 5 — Different host JIT (port rec-x64 to WASM target, or use wasm-runtime-in-wasm)

**Description (variant A).** Port flycast's `rec-x64.cpp` (xbyak-based x86-64 emitter, 1423 lines at `dreamcast/flycast-src/core/rec-x64/rec_x64.cpp`) to emit WASM bytecode instead. More mature register allocator + addressing modes than our bementalJIT.

**Description (variant B).** Use an interpreter-in-WASM (e.g., a tiny WASM bytecode interpreter compiled by V8 once) as the dispatch substrate. V8 never re-Liftoffs.

**Production examples.**
- **Variant A**: no production precedent for porting an existing x86 emitter to WASM. SHIL IR backends in flycast cover ARM, ARM64, x86, x64 — adding a WASM backend is what `rec_wasm.cpp` already does (nasomers's wasm-jit branch is exactly this: 51/70 SHIL ops emitted natively).
- **Variant B** ([wingo/wasm-jit](https://github.com/wingo/wasm-jit) + Wingo's "self-hosted dispatch" idea in `ppc_exterior_worker_2026_05_05.md`): no shipping Dreamcast emulator. SpiderMonkey-in-WASM exists for Servo experiments. Speculation that V8 would not re-tier this — but the actual dispatcher loop is hot enough that V8 should tier it.

**Cost in our codebase.**
- Variant A: replace `bementalJIT/guests/sh4/wasm_emit.cpp` (1452 lines) with a SHIL-to-WASM emitter that ports xbyak idioms. Massive — but this is what we're already doing, just incrementally. We're at 51/70 ops (per nasomers) or however many we have.
- Variant B: write a 5K-instruction SH4 interpreter as a WASM module that takes opcode bytes as input. Replace dispatcher → interpreter. Throughput: bounded by interpreter speed, same as Angle 2.

**Expected throughput.** Variant A = same trajectory as today, possibly with better SHIL coverage. Variant B = Angle 2 with extra steps.

**Blocker that kills it.** Variant A is what we're already doing incrementally. The architecture isn't the wall; the **per-block module instantiation cost** is the wall (per `dreamcast_inwasm_dispatcher_plan.md` — Liftoff per-flush). Variant B does not solve dispatch fan-out — it solves emit cost. We don't have an emit-cost problem.

**Verdict.** Variant A: keep doing what we're doing, but learn from nasomers's actual implementation rather than re-deriving. Variant B: not warranted given the cliff is dispatch-fan-out.

---

### Angle 6 — Native-side dispatch via dedicated worker + SAB (ppc_exterior_worker pattern)

**Description.** Mirror the GameCube architecture (`ppc_exterior_worker_2026_05_05.md`): SH4 JIT lives in its own dedicated Web Worker, separate from the flycast worker that owns rendering/audio/DMA. Communication via SharedArrayBuffer + Atomics.notify, not postMessage.

**Production examples.**
- **In this repo**: `gamecube/ppc-worker/` ships with `ppc_worker.js`, `ppc_worker_emcc.{js,wasm,worker.js}`, `build_ppc_worker.sh`, `sab_layout.h`. The page-mediated mailbox sits in `gamecube/dolphin-bridge/worker_funcs.js`. Per `gamecube.html` lines 206-253, it has been wired and the wiring has been load-bearing — the PPC worker is handshake-instantiated at page-load.
- However, per memory `bementaljit_native_emit_dormant_2026_05_12.md` and `bementaljit_path_correction_2026_05_12.md`, the PPC-exterior-worker is **NOT FINISHED** on the GameCube side either. It's structurally wired but performance has not been demonstrated to be better than the in-dolphin-worker path. The directive in `ppc_exterior_worker_2026_05_05.md` says "not implemented yet" (line 149).

**Cost in our codebase.**
- SH4 + flycast are heavily intertwined — SH4 reads PVR/Holly/AICA MMIO via `sh4_mem_read*` (currently `sh4_mem_read*` is in the **same** module as SH4). Splitting requires either:
  - Mirroring all MMIO state into SAB (~kilobytes), with SAB-backed accessors on the SH4-worker side
  - OR cross-worker JS-mediated MMIO (which reintroduces the JS hop we're trying to remove)
- Plus mirror the PowerPCState-equivalent (`Sh4Context`, ~1KB) into SAB
- New file: `dreamcast/sh4-worker/sh4_worker.{js,cpp}` + link script
- Modifications: `dreamcast.html` to spawn the worker, `dreamcast/flycast-bridge/flycast_worker.js` to drop SH4 + accept MMIO writes from SAB

**Expected throughput.** Speculation, not measured even on GameCube: per `ppc_exterior_worker_2026_05_05.md` line 35, current GameCube is "1.5-2% of native" — and that's **before** the exterior worker actually starts running. The directive's target is >100% native via three wins: dedicated CPU, TurboFan tier-up, pre-warm. Whether any of those three actually deliver remains unmeasured.

**Blocker that kills it.** This is **the same architecture as our current setup**, just moved to a different worker. The dispatch fan-out problem (1395 distinct WebAssembly export wrappers → megamorphic IC → 19× cliff, per `dreamcast_inwasm_dispatcher_plan.md`) **is identical inside a dedicated worker**. Moving the JIT to its own thread does not change V8's IC behavior on dispatch. The gamecube directive talks about wins from "long-lived module gets TurboFan-tiered" — but every WebAssembly.Module we create is its own short-lived thing, regardless of which worker creates it.

**Verdict.** Major architectural lift with no production proof, even in our own repo. Probably NOT the pivot. **What is** worth borrowing from this angle: the SAB-mediated `flycast_run_block` so the JS hop is eliminated. That's Angle 7.

---

### Angle 7 — Replicate nasomers/flycast-wasm wasm-jit: dispatch table in `__indirect_function_table`, called from C via `call_indirect`

**Description.** Per WebFetch of [nasomers/flycast-wasm wasm-jit](https://github.com/nasomers/flycast-wasm/blob/wasm-jit/upstream/patches/rec_wasm.cpp):

> "Each compiled WASM block is registered in Emscripten's `__indirect_function_table` for WebAssembly's `call_indirect` instruction. The dispatch table maps PC hashes to indices within this table, enabling direct WASM-to-WASM calls."
>
> ```c
> #define JIT_TABLE_SIZE (1 << 20)    // 1M entries (~4MB)
> static u32 jit_dispatch_table[JIT_TABLE_SIZE];
> static u32 jit_dispatch_pc[JIT_TABLE_SIZE];   // collision guard
> static u32 jit_dispatch_hash[JIT_TABLE_SIZE]; // SMC guard
> ```
> "the hot path remains pure WebAssembly… Cache misses fall back to C via `rdv_FailedToFindBlock()`."

The key insight: **register each compiled block as an entry in Emscripten's `__indirect_function_table` via `addFunction`** (Emscripten runtime API, requires `ALLOW_TABLE_GROWTH=1` — which we already have at `flycast_worker_link.sh:200`). Then the C dispatcher calls `((BlockFn)wasm_get_table_entry(idx))(ctx, ram)` which the WASM compiler lowers to `call_indirect` against the SAME `__indirect_function_table` the caller is in. **No cross-instance hop.** No JS roundtrip on the hot path.

**Production examples.**
- **nasomers/flycast-wasm wasm-jit branch** reaches "20-40+ FPS" per its README. Same emulator (flycast), same target (browser), same SHIL IR pipeline. They emit per-block WASM modules (just like us) and reach FPS levels we are nowhere near. The architectural difference is the dispatch substrate.
- **Emscripten dynCall + ALLOW_TABLE_GROWTH** is documented at [emscripten Interacting-with-code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html). The `addFunction(fn, sig)` returns a table index; subsequent indirect-call against that index via the same instance is the V8 fast path.
- V8 documentation ([v8.dev wasm-speculative-optimizations](https://v8.dev/blog/wasm-speculative-optimizations)) confirms call_indirect inlining gives 1.19× average and 1.59× combined with deopt, **specifically against module-resident tables**.

**Why our current architecture is slow.** Per our `dreamcast_inwasm_dispatcher_plan.md`:
- Each block is `new WebAssembly.Module()` + `new WebAssembly.Instance()` — each is a distinct `WasmExportedFunction`
- JS-side dispatch is `flycast_vaddr_to_fn.get(vaddr)(ctxPtr, ramBase)` — once 5+ distinct fn refs reach the IC, it goes megamorphic
- The "epoch" path (one module per N blocks) cleans this up but the per-flush re-Liftoff cost makes that worse

The fix is **one stable table** that the JS side instantiates once. Per-block functions are added to that table at indices returned by `addFunction`. The C dispatcher does NOT go through JS — it does a wasm-native indirect call against the stable table.

**Cost in our codebase — this is a one-file change.**

File: `dreamcast/flycast-bridge/rec_wasm.cpp` (currently 1139 lines).

Current shape (lines 96-103):
```cpp
EM_JS(uint32_t, wasm_dispatcher_run_block,
      (uint32_t vaddr, uintptr_t ctx_ptr, uintptr_t ram_base),
{
    if (typeof flycast_run_block === 'function') {
        return flycast_run_block(vaddr >>> 0, ctx_ptr >>> 0, ram_base >>> 0) >>> 0;
    }
    return (vaddr + 2) >>> 0;
});
```

Replace the EM_JS with a C function-pointer table:

```cpp
// Indexed by PC hash; populated by wasm_register_block via Emscripten's
// addFunction (returns __indirect_function_table index, callable from C).
typedef uint32_t (*BlockFn)(uint32_t ctx_ptr, uint32_t ram_base);
#define JIT_TABLE_SIZE (1<<20)
static BlockFn  s_block_fn[JIT_TABLE_SIZE];   // 4 MB on wasm32
static uint32_t s_block_pc[JIT_TABLE_SIZE];   // collision guard

static inline BlockFn lookup(uint32_t vaddr) {
    uint32_t h = (vaddr * 2654435761u) & (JIT_TABLE_SIZE - 1);
    return (s_block_pc[h] == vaddr) ? s_block_fn[h] : nullptr;
}
```

The trampoline (currently rec_wasm.cpp:347-352):
```cpp
// before:
const u32 next_pc_raw = wasm_dispatcher_run_block(pc, (uintptr_t)ctx, (uintptr_t)s_ram_base);

// after:
BlockFn fn = lookup(pc);
if (!fn) {
    /* cache miss: compile then re-lookup */
    rdv_FailedToFindBlock(pc);
    fn = lookup(pc);
}
const u32 next_pc_raw = fn((uint32_t)(uintptr_t)ctx, (uint32_t)(uintptr_t)s_ram_base);
```

And the JS register hook (`dreamcast/flycast-bridge/flycast_worker_funcs.js:104` `flycast_register_block`) replaces:
- the `flycast_block_instances` Map populate
- the `flycast_vaddr_to_fn` Map populate
- with: `Module.addFunction(instance.exports.run, 'iii')` → write the returned index into `_s_block_fn[hash]` + write `vaddr` into `_s_block_pc[hash]` via `HEAP32`.

Emit-side adjustment in `bementalJIT/guests/sh4/wasm_emit.cpp`:
- Drop the multi-export "epoch" module concept entirely
- Re-enable single-block module emit (we already have `build_block` at line 1347)
- Each compiled block module has ONE export of signature `(i32 ctx, i32 ram) -> i32`
- Block imports the shared memory (same as today)

**Critical**: `Module.addFunction` is for adding **JS** functions to the table. For adding **WASM** functions (a WASM export from a separately-instantiated module), the path is:
```js
const idx = wasmTable.length;
wasmTable.grow(1);
wasmTable.set(idx, instance.exports.run);  // wasm fn ref, NOT JS
```
This is the [WebAssembly.Table.grow + Table.set path](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Table/grow). Calling that fn via `call_indirect` from C **stays in WASM** even though the function lives in a different module — because they all share the same Table.

Required JS-library shim or post-js: a helper `__wasm_install_block(bytes, len, vaddr) -> table_idx` that synchronously compiles + instantiates + grows the table + returns the index. EM_JS body, single function. Per-block.

**The cross-instance call_indirect concern is real but mitigated.** Per [V8 wasm-speculative-optimizations](https://v8.dev/blog/wasm-speculative-optimizations): "When a call_indirect can change instance, there is a slower call path." nasomers hits this every dispatch and still gets 20-40 FPS — so the slow path is *not* the megamorphic-IC catastrophe we see today. Likely because V8's "slow cross-instance call_indirect" is single-digit-ns slower than the fast path, vs our current `Map.get` + JS-wasm wrapper which is hundreds of ns.

**Expected throughput.** Anchored: nasomers reports **20-40+ FPS** on Dreamcast titles in WASM with this architecture. At PSO target 30 FPS that's ≥30 FPS = playable. Our 9.5K disp/sec → if nasomers is hitting 30 FPS that implies ~660K disp/s (rough flycast SH4-cycles-per-frame estimate). So a **~70× throughput improvement** is consistent with their data point.

**Blocker that kills it.** Plausible blockers, ordered by likelihood:
1. **`addFunction` for wasm-exported fns vs JS fns**: Emscripten's stock `addFunction(jsFunc, sig)` wraps `jsFunc` as a JS-to-wasm callable. For wasm-export fn refs we may need to bypass it and write directly to `wasmTable` (the Emscripten-named export of `__indirect_function_table`). This is the verifiable path — nasomers does this, and MDN documents `Table.set(idx, wasmFnRef)` as supported since Chrome 69 / Firefox 78. Low risk.
2. **PTHREAD_POOL_SIZE=8 + addFunction interaction (Emscripten #17034)**: each addFunction posts the new function to every pthread. At N=2000 blocks × 8 pthreads = 16K postMessage round-trips for table sync. Mitigation: SH4 thread is the only one calling these blocks, so the pool can be smaller or the postMessage suppressed. nasomers's data suggests this is not catastrophic.
3. **ASYNCIFY=1 wraps wasm-exported fn refs**: per [emscripten Asyncify docs](https://emscripten.org/docs/porting/asyncify.html), Asyncify instruments imports. Block bodies don't make async imports (they call `sh4_mem_read*` which are synchronous), so the wrapping should be a no-op. ASYNCIFY_REMOVE on the dispatcher fn + block fns explicitly is the path nasomers took for their +37% interpreter win.
4. **Self-modifying-code invalidation**: nasomers uses a hash guard (`jit_dispatch_hash[]` stores first-opcode). Flycast already has SMC detection in `bm_GetCodeByVAddr` — the existing path stays unchanged.

None of these is structural. nasomers shipped through them.

**Verdict.** **This is the pivot.**

---

## Ranked

Rank by P(works) × expected throughput delta:

| # | Angle | P(works) | Throughput gain | Score |
|---|---|---|---|---|
| 1 | **Angle 7** (nasomers-shape `__indirect_function_table`) | 0.7 | ~70× (9.5K→660K disp/s) | **49** |
| 2 | Angle 2 (pure interpreter) | 0.95 | ~5× (single-FPS) | 4.75 |
| 3 | Angle 1 (AOT static recompile) | 0.05 | ~100× (if it works) | 5 |
| 4 | Angle 6 (exterior worker) | 0.2 | ~3× (speculative) | 0.6 |
| 5 | Angle 3 (threaded rendering) | 0.5 | ~1.05× | 0.5 |
| 6 | Angle 5 (variant A — keep emitting more ops) | 1.0 | ~1.2× | 1.2 |
| 7 | Angle 4 (clock-scaling) | n/a | does-not-apply | 0 |

P numbers are subjective. The big-gap winner is Angle 7 by ≈10×.

---

## The ONE option to actually try next — Angle 7 sketch

Single-file C change in `dreamcast/flycast-bridge/rec_wasm.cpp` + ~30 LoC JS shim. Detailed sketch:

### 1. New EM_JS body that installs a block into `wasmTable`

Replace `wasm_dispatcher_register_block` (rec_wasm.cpp:62-71):
```cpp
EM_JS(int, wasm_dispatcher_install_block,
      (const uint8_t* bytes, uint32_t len, uint32_t vaddr),
{
    // sync compile + instantiate + grow wasmTable + set the slot. Returns
    // table index >= 1, or 0 on failure.
    return flycast_install_block(bytes >>> 0, len >>> 0, vaddr >>> 0) | 0;
});
```

### 2. JS side — `dreamcast/flycast-bridge/flycast_worker_funcs.js`

Add (after the existing `flycast_register_block`):
```js
var flycast_block_modules = [];   // keep refs alive so V8 doesn't GC
function flycast_install_block(bytesPtr, len, vaddr) {
    try {
        var view  = HEAPU8.subarray(bytesPtr, bytesPtr + len);
        var bytes = new Uint8Array(view);
        var mod   = new WebAssembly.Module(bytes);
        var inst  = new WebAssembly.Instance(mod, flycast_wasm_imports);
        flycast_block_modules.push(inst);
        var fn = inst.exports.run;            // signature (i32 ctx, i32 ram) -> i32
        var idx = wasmTable.length;
        wasmTable.grow(1);
        wasmTable.set(idx, fn);
        return idx;
    } catch (e) {
        flycast_last_register_error = String(e);
        return 0;
    }
}
```

### 3. C side — direct call via wasm function pointer

Replace the trampoline at rec_wasm.cpp:347-352 with the table-lookup + direct call shown in Angle 7 above. The signature `BlockFn` is a regular C function pointer; the WASM toolchain lowers `fn(ctx, ram)` to `call_indirect $__indirect_function_table fn` automatically when `fn` came from a JS-installed table slot of matching signature.

### 4. Drop the epoch path entirely

In `rec_wasm.cpp`, remove:
- `wasm_dispatcher_install_epoch` (lines 85-94)
- `g_active_blocks` accumulator (search "active_blocks")
- `flush_epoch()` (search)
- `build_epoch_module` call sites

The "build one giant module on every flush" approach is what's costing us the per-flush Liftoff time. **Each new block is a tiny one-function module compiled in microseconds**, then linked into the shared `__indirect_function_table` for O(1) future dispatch.

### 5. Add to `flycast_worker_link.sh` (lines ~196-216)

Add:
```
-sEXPORTED_RUNTIME_METHODS=['wasmTable']
```
to make `wasmTable` reachable from `flycast_worker_funcs.js`. (Already partially via `EXPORTED_RUNTIME` at line 217 — verify and extend.)

ASYNCIFY_REMOVE list for hot SH4 functions (separate +37% lift from nasomers's data):
```
-sASYNCIFY_REMOVE='["sh4_mem_read8","sh4_mem_read16","sh4_mem_read32","sh4_mem_write8","sh4_mem_write16","sh4_mem_write32","sh4_interp_ifb","sh4_interp_shil_fb","Sh4Interpreter::Run"]'
```

### 6. Verification path

- A/B via env var `?dreamcast_dispatch=table|epoch` (epoch = current, table = new)
- Same `dreamcast/build_and_probe.sh` harness — compare `unique_pcs` and `disp_per_s` at 30s wall
- Kill criteria: if `disp_per_s` is not ≥10× current 9.5K within first 60s wall, the architecture is not paying off — revert
- Cross-check at 1500+ blocks: this is where the megamorphic cliff hits today; if the table path is flat through 5000+ blocks, the architecture is sound

---

## Things to STOP pursuing

Per `feedback_execute_dont_offer.md`: this list is final, not a menu.

1. **Option 2 — Emscripten MAIN_MODULE / SIDE_MODULE / dlopen.** 5 blockers consolidated in `BLOCKERS.md`. Even if it works, it's the same call_indirect destination as Angle 7 with 10× the build complexity (`MAIN_MODULE=2`, PIC rebuild, dlopen-pthread-proxy, Asyncify-cross-module bug #13049, side-module-cross-pthread bug #17034). **Delete `dreamcast/docs/option2-direct-dispatch/phase1-7*.md` after this pivot lands.**

2. **Bounded-epoch / sharded epoch / cap-at-256-blocks.** Both attempts shipped (per `dreamcast_inwasm_dispatcher_plan.md` ATTEMPTED block), both no-ops. The per-flush Liftoff cost is unavoidable as long as we keep creating multi-export modules. The pivot is to **stop creating multi-export modules**, period.

3. **In-wasm binary-search dispatcher.** Already attempted + reverted (same memory). The added module-size bloat from the dispatcher tree made the per-flush Liftoff cost worse. Dead end.

4. **Multi-module partition by "code locality" or "REL boundary".** Inherited concept from GameCube (`multi_module_partition_2026_05_03.md`). Dreamcast has no REL concept; partition heuristics don't transfer. Drop.

5. **AOT static recompile (Angle 1).** Worth keeping as a long-term north star but not a pivot — no SH4 lifter exists and apploader-style overlay code defeats pure static lifting.

6. **Lower-fidelity clock scaling (Angle 4).** Misnamed; what we want is `SkipFrame=1` which is a flycast option and separate from dispatch architecture.

7. **Speculative parallel block execution (Angle 3 §2).** No production precedent on any single-thread guest CPU. Pure research bet.

8. **Variant B (interpreter-in-wasm-bytecode).** No throughput advantage over Angle 2's straight C interpreter. Strict subset.

---

## Sources

- [nasomers/flycast-wasm](https://github.com/nasomers/flycast-wasm) — the production WASM Dreamcast emulator we should mirror
- [nasomers/flycast-wasm wasm-jit branch](https://github.com/nasomers/flycast-wasm/blob/wasm-jit/upstream/patches/rec_wasm.cpp) — the JIT architecture using `__indirect_function_table`
- [V8 wasm speculative optimizations](https://v8.dev/blog/wasm-speculative-optimizations) — call_indirect inlining
- [V8 wasm tail calls](https://v8.dev/blog/wasm-tail-call) — `return_call` semantics
- [V8 Liftoff](https://v8.dev/blog/liftoff) — baseline compiler ~50% of TurboFan
- [V8 wasm compilation pipeline](https://v8.dev/docs/wasm-compilation-pipeline) — tier-up rules
- [Jangda et al., USENIX ATC '19](https://www.usenix.org/system/files/atc19-jangda.pdf) — WASM is 1.55× slower than native average
- [Emscripten Asyncify](https://emscripten.org/docs/porting/asyncify.html) — ASYNCIFY_REMOVE
- [WebAssembly.Table.grow MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Table/grow) — runtime table extension
- [Emscripten addFunction issue #17891](https://github.com/emscripten-core/emscripten/issues/17891) — table-grow cost considerations
- [Emscripten Interacting with code](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html) — `addFunction`/`removeFunction`
- [Parallel-N64 / Parallel RSP dynarec](https://www.libretro.com/index.php/parallel-n64-with-parallel-rsp-dynarec-release-fast-and-accurate-n64-emulation/) — parallelism precedent (RSP, not CPU)
- [N64Recomp](https://github.com/N64Recomp/N64Recomp) — AOT static recompilation production tool
- [redream progress Jan 2018](https://redream.io/posts/progress-report-january-2018) — confirms redream is dynamic, not AOT
- [PS2Recomp coverage](https://www.timeextension.com/news/2026/01/native-pc-ports-of-ps2-games-could-be-on-the-way-thanks-to-new-recompilation-experiment) — AOT requires per-game tweaks
- Memory: `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_inwasm_dispatcher_plan.md` — failed in-wasm dispatcher + bounded-epoch + observation that per-flush Liftoff is the bottleneck
- Memory: `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_jit_perf_phase1.md` — current state baseline (29 PCs, 393K disp/s peak before cliff)
- Memory: `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/ppc_exterior_worker_2026_05_05.md` — Angle 6 directive (not yet implemented even on GameCube)
