# Single-module revival — audit + next-step ranking

Companion to `BLOCKERS.md`. The Phase 1 doc lists single-module emission
(`~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/single_module_jit_plan.md`)
as the Option 2 fallback. The SH4 side already has a partial
implementation. This doc audits it, identifies what's salvageable, and
ranks the next steps that don't require committing to dlopen.

No time estimates per
`~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_time_estimates.md`.

---

## 1. Status of the existing single-module scaffold

### What is already in tree

The "single-module-per-epoch" plan in `single_module_jit_plan.md` Path A
("periodic re-link, multi-function module accumulating N functions, atomic
table swap") IS the architecture currently shipping on the SH4 side. The
implementation is complete end-to-end:

| Piece | File | Lines |
|---|---|---|
| `WasmModuleBuilder` multi-function emit | `bementalJIT/include/bementalJIT/wasm_module_builder.h` | (the `op_return_call` / multi-func APIs added at commit `117dcf6` per `single_module_jit_plan.md` §"Status as of 2026-05-03") |
| Merged module emit | `bementalJIT/guests/sh4/wasm_emit.cpp:1390-1450` (`build_epoch_module`) | one module, N `run_<i>` exports, type+import sections shared |
| Body-emit helper used by both single-block and N-block paths | `bementalJIT/guests/sh4/wasm_emit.cpp:1255-1312` (`emitBlockFuncBody`) | with optional `vaddr_to_idx` for intra-link |
| Intra-module tail-call linking | `bementalJIT/guests/sh4/wasm_emit.cpp:1074-1180` (`emitBlockExit`) | `return_call WIMPORT_COUNT+idx` for `BET_StaticJump` + bilateral `BET_Cond` |
| Bridge-side accumulator + flush | `dreamcast/flycast-bridge/rec_wasm.cpp:130-280` (`flush_epoch`, `EPOCH_BATCH=64`, `EPOCH_MAX_ACTIVE=512`) | speculative-merge, FIFO eviction with `bm_DiscardBlock`, rollback on install failure |
| JS-side instance swap | `dreamcast/flycast-bridge/flycast_worker_funcs.js:136-172` (`flycast_install_epoch`) | atomic swap of `flycast_active_instance` + `flycast_vaddr_to_fn` Map |
| Dispatch trampoline | `dreamcast/flycast-bridge/flycast_worker_funcs.js:174-188` (`flycast_run_block`) | `Map.get(vaddr)` + `fn(ctxPtr, ramBase)` |
| EM_JS C-side wrappers | `dreamcast/flycast-bridge/rec_wasm.cpp:85-103` (`wasm_dispatcher_install_epoch`, `wasm_dispatcher_run_block`) | thin shim |
| Per-block module fallback removed | `dreamcast/flycast-bridge/rec_wasm.cpp:384-401` (`WasmDynarec::compile`) | "Epoch-only path. The per-block register_block fallback was removed 2026-05-17 after a 5-min probe showed it was the CAUSE of the throughput cliff" |

### What it does correctly

- One `WebAssembly.Module` + one `WebAssembly.Instance` per epoch — V8
  cross-instance `call_indirect` deopt is structurally avoided
  (`single_module_jit_plan.md` §"Why we're slow"). All N currently-active
  blocks live in the same instance.
- Intra-link via `return_call` for `BET_StaticJump` and bilateral
  `BET_Cond` (`emitBlockExit` at `wasm_emit.cpp:1074-1180`,
  `sibling_func_idx` at `wasm_emit.cpp:1060-1072`). Unbounded chains in
  O(1) stack — tail call replaces frame.
- Cycle-drain emitted at each block prologue
  (`wasm_emit.cpp:1275-1282`), per
  `dreamcast_jit_perf_phase1.md` item #2. Replaces rec_wasm's coarse
  flat `-= 32` per dispatch.
- Failure rollback in `flush_epoch` keeps `pending` intact on install
  fail so the next attempt retries (`rec_wasm.cpp:224-261`).
- Bounded epoch with eviction: `EPOCH_MAX_ACTIVE=512` + `bm_DiscardBlock`
  on evicted entries (`rec_wasm.cpp:171, 202-213`). Without
  `bm_DiscardBlock` evicted vaddrs would silently fall through to
  `flycast_run_block`'s `pc+2` fallback.

### What does NOT work

- **Throughput cliffs hard at the same point regardless of size cap.**
  Per `dreamcast_inwasm_dispatcher_plan.md` §"Bounded-epoch attempt"
  (2026-05-17): capping at 512 with FIFO eviction did NOT remove the
  cliff. Same ~9.5K disp/s after the same wall-time mark. **This proves
  the cliff is NOT per-flush module-size growth.**
- **In-wasm dispatcher made it worse, not better.** Per same memory file
  §"ATTEMPTED + REVERTED": single `dispatch(vaddr,ctx,ram)` export with
  binary-search tree dropped throughput from 21K → 9.5K disp/s at 1395
  blocks. Code comment preserves the lesson at
  `wasm_emit.cpp:1409-1416`: "V8 spent so much time recompiling the
  growing dispatcher fn on each flush ... that sustained throughput at
  1395 blocks dropped from 21K → 9.5K disp/s".
- **`video_cb` still gets data=0** — game hasn't reached its render loop.
  Per `dreamcast_jit_perf_phase1.md` §"What's NOT done": "boot-progression-speed
  issue, not a JIT correctness issue".

---

## 2. Why it cliffs at 1395 blocks

The 2026-05-17 dispatcher-plan memory has **two competing theories**:

1. **V8 IC megamorphic** (initial): `flycast_run_block`'s `fn(ctxPtr, ramBase)`
   call site has its inline cache go megamorphic once `fn` cycles through
   ≥5 distinct `WasmExportedFunction`s. This was the theory that motivated
   the in-wasm dispatcher fix.
2. **Liftoff per-flush recompile** (revised, after the in-wasm dispatcher
   regressed): "the perf gap isn't actually V8 megamorphic IC — it's V8
   having to re-Liftoff-compile the entire epoch module on every flush.
   At 1395 blocks the module is ~500KB and growing."

### Both theories are now refuted by the bounded-epoch test

The same memory file (§"Bounded-epoch attempt") records: capping at 512
blocks with FIFO eviction keeps **per-flush Liftoff cost constant** but
**did not remove the cliff** — same ~9.5K disp/s after the same wall-time
mark. If the bottleneck were Liftoff recompile time, capping at 512
would have measurably helped. It did not.

The conclusion in that memory: *"It's about something the boot enters at
the ~2-minute mark — likely a hot game-code loop where the per-dispatch
cost dominates (JS-to-wasm call cost, EM_JS overhead, C++ try/catch for
SH4ThrownException, etc.)."*

### From the code, the actual per-dispatch path on a hot epoch hit is

1. `flycast` SH4 dispatcher calls `block->code` (the trampoline).
2. `wasm_block_trampoline()` at `rec_wasm.cpp:330-365` reads
   `ctx->pc`, fills `s_ram_base`, calls `wasm_dispatcher_run_block` via
   EM_JS. **That's a wasm→JS round trip** (EM_JS bodies live in JS).
3. JS-side `flycast_run_block` at `flycast_worker_funcs.js:174-188` does
   `Map.get(vaddr)` then `fn(ctxPtr, ramBase)`. **That's a JS→wasm
   round trip back into the epoch instance.**
4. Block body runs. Any memory access goes through imports
   `sh4_read*` / `sh4_write*` (wasm→JS→wasm round trips per memory
   access) per `wasm_emit.cpp:410, 463-465, 483, 494, 537-539`.
5. Block exit either stores PC + returns (return path goes back through
   the JS shim back to C++), OR — for `BET_StaticJump` + bilateral
   `BET_Cond` linked tails — emits `return_call` directly to a sibling
   block in the same epoch instance, staying in wasm (`emitBlockExit`
   at `wasm_emit.cpp:1083-1087`).

The intra-link path (5b) IS already optimal. The non-linked path (5a)
pays **3 wasm↔JS boundary crossings per block dispatch** (item 2, 3, and
the return). Plus N more for memory imports if the block does any
read/write that isn't fast-pathed.

### Most likely true cause

**The JS-hop per dispatch is the dominant cost, AND intra-link doesn't
fire often enough to amortize it.** Per
`dreamcast_jit_perf_phase1.md` §"What's NOT done":
*"dispatch count stayed similar (7.9M/30s) — suggests tight BIOS loops
aren't getting linked (mostly self-loops or to non-active-set blocks)."*

Self-loops are explicitly excluded by `sibling_func_idx`
(`wasm_emit.cpp:1068`: `if (target_vaddr == self_vaddr) return -1`).
And `BET_Cond` requires BOTH arms in the active set
(`wasm_emit.cpp:1176`); a single arm missing falls back to dispatcher
return. Eviction cap of 512 makes "both arms present" fragile in any
loop that fanned past the cap.

The 1395-block cliff is consistent with this: cliff timing correlates
with reaching code that loops in a wider working set than the eviction
cap supports, so intra-link rate drops, so per-dispatch JS hops dominate.

The Option 2 README's Phase 6 microbench (`#ifdef DISPATCH_MICROBENCH`)
would confirm this empirically — it's a paste-ready timing block around
`wasm_block_trampoline()`. **Has not been run on the current build.**
That measurement is a precondition for confidence in option ranking
below.

---

## 3. Options (a)-(g) ranked by reliability × delta

Reliability is "low risk of regression vs current 9.5K-disp/s baseline".
Delta is "expected throughput improvement based on code reading and
referenced memory".

### (g) Move SH4 thread to a dedicated wasm worker

**Rank: 1 (reliability=high, delta=large).**

Mirrors `ppc_exterior_worker_2026_05_05.md` directive applied to SH4.
The PowerPC-side memory explicitly cites three structural wins:
"one CPU core's worth of compute, dedicated" + "V8 tier-up to TurboFan
(long-lived worker)" + "Pre-loading warmth". Same physics applies here.

Current SH4 runs inside `flycast_worker.js` which also owns canvas wiring,
audio worklet plumbing, postMessage routing for mbx-cmd, and Module
boot. Per `flycast_worker_funcs.js:190-220` the worker is multi-purpose.
Splitting SH4 dispatch into its own worker — with the existing
`PROXY_TO_PTHREAD=1` model — gives V8 a long-lived consistent target for
TurboFan tier-up, and isolates dispatch from page-RAF/audio jitter.

The dispatch loop ALREADY runs on a pthread (per
`flycast_worker_funcs.js:16-18`: *"Defined OUTSIDE the pthread guard
so they're reachable on whichever pthread ends up running the SH4
dispatch loop (PROXY_TO_PTHREAD=1)"*). Promoting it to its own Web
Worker is incremental, not a from-scratch refactor.

**Next steps**:
- Stand up a `sh4-worker.js` mirroring `gamecube/ppc-worker/`.
- SAB layout for the SH4 ctx + RAM (mirror gamecube's `sab_layout.h`).
- Atomics.notify/wait for `cycle_counter` underflow + INTC pump from the
  bridge.
- The seqlock + ringbuffer primitives at `gamecube/seqlock.js` +
  `gamecube/ringbuffer.js` are reusable as-is — they ship with smoke
  tests (`gamecube/seqlock.test.mjs`, `gamecube/ringbuffer.test.mjs`).

**Risk**: large refactor; the SAB layout for SH4 ctx + ram_base + INTC
state has to be designed carefully so the bridge can safely raise SPG
interrupts from the main worker while SH4 dispatches.

### (c) Pre-allocated stable funcref table + per-block tiny modules

**Rank: 2 (reliability=medium, delta=large).**

Per `dreamcast_inwasm_dispatcher_plan.md` §"What's left to try" item 1:
*"One stable dispatcher module that holds a typed-funcref table imported
from JS. Per-block tiny modules add their fns to the table at
instantiate-time. Dispatcher does `call_ref` which V8 inlines per
type-feedback. No growing module, no per-flush recompile."*

Topology:
- ONE long-lived "dispatcher module" instance (never re-instantiated)
  that holds a funcref table imported from JS via
  `new WebAssembly.Table({initial:N, maximum:M, element:'anyfunc'})`.
- The dispatcher exports `dispatch(vaddr, ctx, ram) → next_pc` doing
  `vaddr → table_idx` lookup (perfect-hash or sparse binary tree on
  vaddr→slot mapping shipped via shared memory) then `call_indirect
  table` with the resolved index.
- Per-block tiny SIDE-style modules each have ONE function;
  instantiation publishes the function into the shared table at a
  reserved slot (table.set from JS post-instantiate via
  `inst.exports.run` cast to funcref).
- The dispatcher module is LONG-LIVED. V8 collects feedback on its
  `call_indirect` over millions of dispatches → speculative inlining
  fires.

This is the textbook fix the V8 blog cited in `single_module_jit_plan.md`
§"Why we're slow" — `call_indirect` from inside the dispatcher module
against a table the dispatcher OWNS-the-declaration-of is intra-instance.
The blocks live in different instances, but the **call site is in the
dispatcher's instance and dispatches via the dispatcher's declared
table** — V8's instance-check at the call site passes (the table belongs
to the call site's instance), so no deopt.

Per `dreamcast_inwasm_dispatcher_plan.md` §"Critical": *"table MUST be
module-declared, not Emscripten's imported `__indirect_function_table`.
Cross-instance call_indirect deopts."* — true if the dispatcher imports
the main module's table; this design has the dispatcher OWN the table
and JS imports it back to write into.

**Key question that must be verified before commitment**: does V8
actually inline `call_indirect` against an imported funcref table when
the table's contents come from foreign instances? The V8 blog cites
**instance**-check at call site; the table belongs to the dispatcher's
instance, but the funcrefs IN the table point to foreign instances.
This is the open empirical question — the V8 blog doesn't explicitly
cover the case where the call_indirect target is intra-instance-with-
table-decl but cross-instance-with-function-decl. The pessimistic
reading is "still deopts because the function lives in a different
instance"; the optimistic reading is "the speculative inlining still
fires because the call site has the table in hand".

**Next steps**:
- Write minimal V8/Node spike: one dispatcher module with declared
  table; N=2000 tiny single-fn modules; populate table from JS; run
  hot dispatch loop. Measure `ns/call` direct vs the current
  `flycast_run_block` path. This is a smaller experiment than the
  Option 2 dlopen spike and answers the cross-instance-table question
  directly.
- If the spike answers go: change emit to make each block a single-fn
  module that imports the shared memory + `env.sh4_*` imports + table,
  drops its export into a reserved slot. The dispatcher module's emit
  is then stable (no growing module). Per-block compile cost shrinks
  (tiny modules) — but per-block instantiation still happens, so the
  total Liftoff work doesn't actually go down. The win is dispatch
  shape, not module-build cost.

**Risk**: requires the V8 spike to validate the inlining assumption.
If V8 deopts because funcref points to foreign instance, no win over
current path; we paid the instance-explosion cost again.

### (b) Lazy compile — defer flush until N blocks change

**Rank: 3 (reliability=medium, delta=medium).**

Per `dreamcast_inwasm_dispatcher_plan.md` §"What's left to try" item
"Avoid on-miss flush": *"only flush on batch (every 64 compiles). But
this breaks dispatch of freshly-compiled blocks; trampoline returns
vaddr+2 advancing past the new block. Would need a 'pending compile'
cache that JS checks before falling through."*

Current code at `rec_wasm.cpp:751-766` flushes on EVERY cache-miss
("flush_epoch("miss")"). With cache misses dominating early boot,
Liftoff re-runs over and over even with the eviction cap. If we keep
pending blocks dispatchable via a small parallel per-block-instance
cache (the OLD path that was removed 2026-05-17), the flush rate
collapses.

**Why the per-block fallback was removed**: `rec_wasm.cpp:386-396`
comment: *"the per-block register_block fallback was removed 2026-05-17
after a 5-min probe showed it was the CAUSE of the throughput cliff at
block-count 1395"*. So we can't just put it back wholesale.

But there's a middle ground: keep a SMALL fixed-N "pending" instance
that holds only the last K=64 compiled blocks. JS-side: `Map.get(va)`
checks epoch map first, falls through to pending map. Each pending
flush is small + bounded. Cliff doesn't re-emerge because pending size
is capped.

**Next steps**:
- Add `flycast_pending_instance` + `flycast_pending_vaddr_to_fn` in
  `flycast_worker_funcs.js`. Built from per-block modules (current
  `flycast_register_block` path) but evicted on every batch-flush.
- In `flycast_run_block`, lookup order: epoch → pending → pc+2.
- Drop the `flush_epoch("miss")` call at `rec_wasm.cpp:765`; rely on
  `EPOCH_BATCH=64` only.
- Verify the pending instance never exceeds K=64 (small, cheap to
  recompile).

**Risk**: re-introduces multi-instance dispatch fanout for the bottom
K blocks. If those K are hot, IC at the JS-side `fn(...)` call site
still gets some megamorphic pressure — the original cliff condition.
Bounded by K which is small, but unproven that K=64 stays under
mono-/poly-morphic threshold.

### (a) Bounded epoch + LRU eviction (variant we tried was FIFO)

**Rank: 4 (reliability=high, delta=low to none — already tried).**

Per `dreamcast_inwasm_dispatcher_plan.md` §"Bounded-epoch attempt": FIFO
at 512 *"Throughput cliff identical — same 9.5K disp/s after the same
wall-time-mark."* LRU instead of FIFO might marginally help (keeps hot
blocks resident, makes intra-link more likely to fire) but the
bounded-epoch result already disproves the per-flush-recompile theory,
so LRU isn't expected to break the cliff either.

**Next steps**: keep `EPOCH_MAX_ACTIVE=512` for memory hygiene, but
switch the eviction in `rec_wasm.cpp:202-213` to LRU by tracking
hit-counts (would need a counter incremented in JS per `Map.get`, mirrored
back via SAB, or in C++ via a per-vaddr counter touched from the
trampoline). Worth the simplicity to combine with option (b) above —
LRU would keep "linked-tail-call siblings" in residence longer than
FIFO.

**Risk**: needs the hit-count plumbing JS→C++; tiny but new surface.

### (d) Async compile via `WebAssembly.compileStreaming` or background worker

**Rank: 5 (reliability=high, delta=low).**

Could offload Liftoff to a background thread so the SH4 thread doesn't
block on `new WebAssembly.Module(bytes)` in
`flycast_install_epoch` at `flycast_worker_funcs.js:145`. But the
bounded-epoch test already proved per-flush compile cost isn't the
dominant cost, so async-compiling smaller pieces doesn't structurally
change throughput. Useful for SMOOTHING jitter (no synchronous compile
stalls), not for raising the ceiling.

**Next steps**: switch `new WebAssembly.Module(copy)` to
`await WebAssembly.compile(copy)` (no streaming form for in-memory
bytes — use `WebAssembly.compile`). Requires the bridge to handle
the async — `flycast_install_epoch` becomes async, which means
`wasm_dispatcher_install_epoch` needs to wait. Under ASYNCIFY this
works via `Asyncify.handleSleep` in an EM_JS body. Adds latency to
the install; for batch flushes this is fine.

**Risk**: small. Adds latency between compile and dispatchability of
new blocks; mainloop's `flush_epoch("miss")` correctness relies on the
freshly compiled block being callable on the next iter, which becomes
violated. Have to combine with option (b) — keep a synchronous tiny
pending cache for new blocks until the async compile lands.

### (e) V8-specific Chrome command-line flags

**Rank: 6 (reliability=high, delta=unknown).**

`--no-liftoff`, `--liftoff-only`, `--wasm-tier-up`, `--turbofan` etc.
The bundled GameCube probe harness already passes `--no-liftoff`
(`jit_lever_state_2026_05_14.md`: *"--no-liftoff default in probe
harness"*). For our user-facing build, can't pass V8 flags via Chrome
on the user's machine — these only help if we're benchmarking under
Node or with a launch script.

For **probe iteration only**, useful. Land Phase 6's microbench
(`DISPATCH_MICROBENCH`) and run it with + without `--no-liftoff`,
+ with `--turbofan-on-next-call-from-api` etc. Empirically bounds
what TurboFan-only could yield. If TurboFan-only gives ≫9.5K disp/s,
the answer becomes "make the worker live long enough that V8 tier-ups
on its own" — which is option (g).

**Next steps**: add `--no-liftoff` to whatever node-based probe harness
the SH4 build uses (mirror gamecube's `dreamcast/build_and_probe.sh`).
Compare A/B.

**Risk**: zero — measurement only. Just informational.

### (f) Skip the JS dispatcher entirely (in-wasm dispatcher)

**Rank: 7 (reliability=DEMONSTRATED FAILURE, delta=negative).**

Per `dreamcast_inwasm_dispatcher_plan.md` §"ATTEMPTED + REVERTED" and
`wasm_emit.cpp:1409-1416`: tried, made things worse, code comment
preserves the lesson. Don't redo straight. Variants worth considering
fold into option (c) — the dispatcher IS the dispatcher module, but
the table is module-declared and persistent across flushes (not rebuilt
per flush, which was what made (f) regress).

**Next steps**: don't. Subsumed by (c).

---

## 4. The ONE option to try first

**(g) Move SH4 thread to a dedicated wasm worker** — followed by
**(e) measurement gate** as a precondition.

### Why first

1. **Highest expected delta.** PowerPC-side memory
   `ppc_exterior_worker_2026_05_05.md` projects "~2× from TurboFan
   tier-up + dedicated CPU core" before any architectural change to
   dispatch. SH4 is in the same regime.
2. **Reliability is high.** The PROXY_TO_PTHREAD pattern is already in
   place — SH4 already runs on a pthread. Promoting it to a dedicated
   worker is incremental.
3. **It is the only option that addresses the right diagnosis.** Both
   the bounded-epoch test (refutes per-flush Liftoff theory) AND the
   in-wasm dispatcher regression (refutes the "JS dispatch IC" theory)
   leave only "per-dispatch JS-hop cost" and "V8 not tier-uping because
   the work isn't long-lived enough". (g) directly addresses the
   second; combined with future option (c) it addresses both.
4. **It unblocks future options.** Once SH4 is in its own worker, the
   shared funcref-table topology (c) is much easier to land — the
   table lives in the worker's wasm memory, and the dispatcher loop
   never returns to the page main thread.
5. **The blockers in Option 2's dlopen path** (B2 #13049 asyncify+
   side-module, B3 asyncify per-call wrapping, B4 dlopen main-thread
   sync, B5 #14896 pthread+exceptions+O3 regression) **all evaporate**
   — we're not adding side modules, not adding dlopen, not changing
   the link flag set.

### What to do BEFORE landing it

Land Phase 6's `DISPATCH_MICROBENCH` block (paste-ready in
`phase6-verify-measure.md` §2) around `wasm_block_trampoline()` in
`rec_wasm.cpp:330-365`. Print median ns/dispatch over 100K samples.
This tells us:

- If median is ~100μs: the JS-hop hypothesis is confirmed; (g) wins big.
- If median is ~10μs: dispatch isn't the problem; (g) won't help nearly
  as much — pivot to investigating block-body cost (memory imports,
  IFB fallbacks).
- If median is in between: (g) helps proportionally.

This is the same Gate A from `BLOCKERS.md` §"Gate A". It costs almost
nothing and decides whether (g) is worth the refactor.

### Sketch of the (g) change

Mirror `gamecube/ppc-worker/` topology applied to SH4:

- New file: `dreamcast/sh4-worker/sh4_worker.js` + `sh4_worker_link.sh`
- Bridge changes to `dreamcast/flycast-bridge/rec_wasm.cpp`:
  - Replace direct `flush_epoch` / `wasm_dispatcher_install_epoch` calls
    with SAB-mediated submission of compiled bytes + vaddrs to the SH4
    worker.
  - Replace `wasm_block_trampoline` with an SAB ringbuffer write of the
    pc-to-execute + an `Atomics.wait` on the result.
  - Or — better — move the dispatcher loop itself INTO the SH4 worker,
    so the bridge calls into the SH4 worker only for INTC events, not
    per-dispatch.
- New file: `dreamcast/sh4-worker/sab_layout.h` — SH4 ctx + RAM offsets,
  cycle counter, INTC pend mailbox, ringbuffer for new-block install.
- Reuse: `gamecube/seqlock.js`, `gamecube/ringbuffer.js`, their tests.
- Page-side: `dreamcast/flycast-bridge/worker_funcs.js`-equivalent doing
  mailbox routing between `flycast_worker` and `sh4-worker`.

The dispatcher loop running entirely inside the SH4 worker — bridge
only writes INTC raises to the SAB mailbox, never round-trips — is what
gives the JS-hop savings on TOP of the worker-isolation savings. Per
`ppc_exterior_worker_2026_05_05.md` §"Self-hosted dispatch (Wingo/Hoot:
dispatch runs inside WASM, never returns to JS) — eliminates per-block
JS↔WASM boundary cost"*.

---

## 5. Kill criterion

After landing (g) + the Phase 6 microbench:

- **Kill criterion**: median dispatch-cost STAYS at ≥10μs after the
  worker split AND a 60-second wall warmup window (long enough for V8
  TurboFan tier-up to fire on the long-lived worker). If both of those
  hold and `video_cb` data is still 0 after 5 wall minutes, then
  **single-module emission alone cannot close the throughput gap**;
  pivot to one of:
  - Option 2 dlopen (the bundle this doc is filed under), or
  - AOT static recompilation (`single_module_jit_plan.md` Path B —
    fork N64Recomp into a Dreamcast/SH4 equivalent).

The "stays at ≥10μs after worker split" predicate is the empirical kill
signal — it means the per-dispatch wasm↔JS boundary cost is dominant
even when V8 has had time to tier up, AND the JS round trip didn't
shorten by moving to a dedicated worker. At that point single-module
emission has nothing more to give.

Until that measurement is taken, the Option 2 dlopen pivot is
premature.

---

## Citations

### Memory files
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/single_module_jit_plan.md` — original GameCube-side plan, V8 cross-instance deopt verbatim quote
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_inwasm_dispatcher_plan.md` — ATTEMPTED+REVERTED + Bounded-epoch attempt + What's left to try
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_jit_perf_phase1.md` — phase1 perf items #1-#5 shipped state
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/ppc_exterior_worker_2026_05_05.md` — exterior-worker directive, dedicated-core + TurboFan tier-up theory
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/multi_module_partition_2026_05_03.md` — GameCube-side partition study (informs option (c) sharding topology)
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_session_2026_05_16.md` — throughput cliff first observation (415K→46K @ 1394 blocks)
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/jit_lever_state_2026_05_14.md` — `--no-liftoff` baseline noted
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_time_estimates.md` — applied throughout

### Code
- `dreamcast/flycast-bridge/rec_wasm.cpp:96-103` — `wasm_dispatcher_run_block` EM_JS shim
- `dreamcast/flycast-bridge/rec_wasm.cpp:130-280` — epoch state + `flush_epoch`
- `dreamcast/flycast-bridge/rec_wasm.cpp:330-365` — `wasm_block_trampoline`
- `dreamcast/flycast-bridge/rec_wasm.cpp:384-401` — `compile`, per-block fallback removed
- `dreamcast/flycast-bridge/rec_wasm.cpp:748-766` — mainloop cache-miss + flush
- `dreamcast/flycast-bridge/flycast_worker_funcs.js:45-188` — JS-side epoch + register_block + run_block
- `bementalJIT/guests/sh4/wasm_emit.cpp:1060-1180` — `sibling_func_idx` + `emitBlockExit` intra-link
- `bementalJIT/guests/sh4/wasm_emit.cpp:1255-1312` — `emitBlockFuncBody`
- `bementalJIT/guests/sh4/wasm_emit.cpp:1319-1342` — shared `emitTypeImportSection`
- `bementalJIT/guests/sh4/wasm_emit.cpp:1390-1450` — `build_epoch_module`
- `bementalJIT/guests/sh4/wasm_emit.h:30-40` — `WIMPORT_*` enum (the 8 imports)
- `gamecube/ppc-worker/`, `gamecube/seqlock.js`, `gamecube/ringbuffer.js` — reference for option (g) refactor

### Companion docs in this bundle
- `dreamcast/docs/option2-direct-dispatch/BLOCKERS.md`
- `dreamcast/docs/option2-direct-dispatch/phase1-feasibility.md` §3 (V8 cross-instance deopt quote)
- `dreamcast/docs/option2-direct-dispatch/phase6-verify-measure.md` §2 (the microbench)
