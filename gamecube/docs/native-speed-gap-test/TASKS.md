# Native-speed gap test — what is gamecube.html actually lacking?

## Goal

`feedback_native_speed_acceptance.md` sets the bar at ≥100% native PowerPC speed sustained — Gekko @ 486 MHz ≈ ~486M instructions/sec on a clean inner loop. Every per-PC lever has shipped (op0 fix, B1 idle-skip, B2/B6 FP+mtmsr, fcmpu/fctiw, B11 liveness, Phase 2e ppc-worker cutover, publishers, sleep-tick extension). Sustained throughput has not moved into the target band.

**Question this topic answers**: across the four boundaries the dispatch path crosses (in-WASM → C → EM_ASM_INT → JS-side ppc_worker.js → gamecube.html orchestration), which single layer's cost dominates, and is what gamecube.html is lacking discoverable WITHOUT modifying the dispatch path itself?

Design a measurement that pins the cost at each boundary. Implementation is a follow-on topic; this topic produces the test design + the data the test should collect to make the gap visible.

## Anchored facts (verified before writing this plan)

These are the citations the test design pivots on. Any future session amending this doc must re-verify them against the live tree per pre-action gate #3.

- `gamecube/ppc-worker/ppc_worker_main.cpp:1083` — every PPC dispatch in the C inner loop calls `g_bcache.region_dispatch(pc, &next)`.
- `bementalJIT/src/block_cache.cpp:899` — `BlockCache::region_dispatch` body is `return EM_ASM_INT({ ... })`. **Per-dispatch C→JS round-trip is structural in the current path.**
- `gamecube/ppc-worker/ppc_worker_main.cpp:1092` — `__atomic_sub_fetch(p_dc, 1, __ATOMIC_ACQ_REL)` — downcount drains by 1 per dispatch regardless of actual block instruction count. In-source comment names this as "block-cycles plumbing is step 2 / Q3".
- `gamecube/ppc-worker/ppc_worker_main.cpp:1078-1081` — in-source comment names the EM_ASM_INT crossing as a Q1 architectural decision, "Step 2 will replace with direct wasm call".
- Per the survey of `gamecube/dolphin-bridge/worker_funcs.js:44-75` (not re-verified line-by-line; treat as a hypothesis until re-read): dolphin_worker dispatches in 100K-iter batches at boot, transitioning to 10K-per-tick at 60 Hz steady-state, yielding via `setTimeout(0)` between batches.
- Per the survey of `gamecube.html:890-943` (not re-verified): main thread polls a SAB mailbox every 4ms via `setInterval` for command routing.
- No per-second `disp/s` rate counter exists in any of the files surveyed. Slice-wise iteration counts are written to SAB at `0x025010E0..F` and logged every 2s by the page as `[phase4-slice]`. **The test must add a per-second rate measurement; one does not exist.**

## Hypotheses + kill criteria

Each hypothesis is a candidate for "what gamecube.html is lacking." Each has a numerical kill criterion. Multiple may survive; the measurement spec produces the data to rank them.

### H1 — Per-dispatch EM_ASM_INT round-trip is the dominant cost

Stated cost: each dispatch crosses C → JS → wasm-region-fn → returns. The lower bound on EM_ASM round-trip cost on V8 is ~100ns at best, ~1μs typical, even with no body. At 486M dispatches/sec target, the per-dispatch budget is ~2ns — three orders of magnitude under EM_ASM floor.

**Kill criterion**: Measurement L1 (in-C tight dispatch loop, no JS crossing — see below) shows ≤2× the rate of L2 (current C path with EM_ASM_INT per dispatch). If L1 is 100×+ faster than L2, H1 is the dominant cost.

### H2 — Downcount = 1 per dispatch causes spurious slice exits

Stated cost: real Gekko blocks average ~6-12 instructions per block (Dolphin's own JIT block stats). Draining downcount by 1 per dispatch means the slice budget allotted by CoreTiming runs out N× faster than intended, forcing N× more slice round-trips per emulated-wall-second.

**Kill criterion**: ratio `actual_slice_exits_per_sec / (expected_slice_exits_per_sec_given_real_block_cycles)` ≥ 5. Measured by capturing the slice-exit count over 30s, computing the expected count from `g_compile_cycles` per-block averages, and dividing.

### H3 — The slice cap (C_SLICE_CAP = 4096, PHASE4_MAX_SLICE) is itself a throughput cap

Stated cost: even with zero per-dispatch overhead, the loop returns every 4096 iters at most. Each return costs at least the SAB write + JS-side reload + relinearize cost.

**Kill criterion**: vary `C_SLICE_CAP` over {256, 1024, 4096, 16384, 65536} on a hot-path benchmark. If steady-state dispatch rate scales sub-linearly with the cap (e.g. cap 16× → rate ≤ 2× higher), slice-exit overhead dominates.

### H4 — V8 TurboFan tier-up never lands on region modules

Stated cost: per `lever_3_tierup_blocked_2026_05_05.md` and `module_discard_timing.md`, region modules are discarded by relink cadence before tier-up completes. Region runs at Liftoff baseline forever.

**Kill criterion**: run a single fixed region through ≥300K dispatches without relink. Measure dispatch rate at t=0..1s vs t=10..11s. If <2× speedup over time, tier-up not paying off OR not landing.

### H5 — dolphin_worker is the actual cap, ppc-worker is idle-waiting

Stated cost: `worker_funcs.js:44-75` runs dolphin's inner loop at 60 Hz × 10K = 600K dispatches/sec ceiling steady-state. If ppc-worker is gated on dolphin-side state (CT events, MMIO mirror sync, exception delivery), ppc-worker's own dispatch rate is irrelevant.

**Kill criterion**: measure ppc-worker wall-time-inside-slice vs wall-time-waiting-for-dolphin over 30s. If wait ratio > 0.5, ppc-worker speed doesn't matter; dolphin_worker is the cap.

### H6 — gamecube.html main-thread orchestration steals worker budget

Stated cost: `setInterval(4ms)` mailbox poll = 250 polls/sec. Each poll reads SAB atomics, dispatches postMessages. Main thread also handles canvas/audio. If main-thread is saturated, workers stall on postMessage backpressure.

**Kill criterion**: Chrome trace (already captured via `PROBE_TRACE_PATH`) shows main-thread CPU > 80% during the steady-state segment. If under 30%, H6 is not the cap.

## Files touched

| File | Why |
|---|---|
| `gamecube/microbench/microbench.html` | New. Host page that loads ppc-worker WITHOUT dolphin_worker — the only way to measure pure dispatch in isolation. |
| `gamecube/microbench/microbench.js` | New. Test harness — runs each measurement layer, computes deltas, emits JSON results. |
| `gamecube/microbench/fixture_block.cpp` | New. Hand-built 16-instruction Gekko block (`add`, `addi`, `mulli`, `cmpwi`, `bne`, `blr` mix) emitted by bementalJIT into a region. Stable across runs. |
| `gamecube/ppc-worker/ppc_worker_main.cpp` | Possibly add 3 microbench-only exports: `ppc_mb_dispatch_pure_c(count)` (no EM_ASM), `ppc_mb_dispatch_via_emasm(count)` (current path), `ppc_mb_get_rate_window()` (rolling 1s rate). All `#ifdef PPC_WORKER_MICROBENCH`-gated so production build is unaffected. |
| `gamecube/ppc-worker/build_ppc_worker.sh` | Add `--microbench` flag that defines `PPC_WORKER_MICROBENCH=1`. |
| `gamecube/docs/native-speed-gap-test/refs/measurements-baseline.json` | New artifact. Pre-test baseline numbers. |
| `gamecube/docs/native-speed-gap-test/refs/measurements-current.json` | New artifact. Result of running the test against the current build. |
| `gamecube/docs/native-speed-gap-test/refs/chrome-trace-steady-state.json` | New artifact. 10s of steady-state for H6. |

## Tasks

Tasks A–E build the four measurement layers + the rate-window infra. Tasks F–H execute the hypothesis tests against the harness. F–H are parallel-safe once A–E land.

### Task A — Add a stable fixture block + a pure-C dispatch loop

**Resource**: `bementalJIT/guests/powerpc/` (emit path), `gamecube/ppc-worker/ppc_worker_main.cpp` (worker entry).

**Action**: Build a 16-instruction Gekko block by hand-feeding bytes to bementalJIT's PPC emitter. Compile once at microbench-init. Add a microbench-only entry point `ppc_mb_dispatch_pure_c(u32 count)` that calls into the compiled region's wasm function pointer **directly from C** with NO EM_ASM crossing — call the C-side trampoline that bementalJIT already exposes via `BlockCache::lookup_handle` (verify the lookup returns a directly-callable handle; if not, this task escalates to "add a direct-call path to bementalJIT" and the test design pauses).

**Concrete change** (sketch — verify exact call surface before edit):

```c
#ifdef PPC_WORKER_MICROBENCH
extern "C" EMSCRIPTEN_KEEPALIVE
u64 ppc_mb_dispatch_pure_c(u32 count) {
    // Verify bementalJIT exposes a C-direct call surface. If not,
    // this becomes "design the surface first" and the test pauses.
    const u32 fixture_pc = ppc_mb_get_fixture_pc();
    u64 dispatches = 0;
    for (u32 i = 0; i < count; ++i) {
        s32 next = 0;
        if (!g_bcache.region_dispatch_c_direct(fixture_pc, &next)) break;
        ++dispatches;
    }
    return dispatches;
}
#endif
```

**Verification**: `nm gamecube/ppc-worker/ppc_worker_emcc.wasm | grep ppc_mb_dispatch_pure_c` returns non-empty after `bash gamecube/ppc-worker/build_ppc_worker.sh --microbench`.

**Kills H1 if**: this task discovers no C-direct call surface exists in bementalJIT. That itself is the answer — the surface is what gamecube is lacking.

### Task B — Wrap the current EM_ASM_INT path in a microbench export

**Resource**: `gamecube/ppc-worker/ppc_worker_main.cpp` + the verified `BlockCache::region_dispatch` at `bementalJIT/src/block_cache.cpp:887`.

**Action**: Add `ppc_mb_dispatch_via_emasm(u32 count)` that wraps the existing `region_dispatch` call in a loop. Same fixture block. Same control flow as `ppc_worker_run_slice` but with all the exit checks stripped — just dispatch.

**Verification**: count returned matches `count` argument over 1M iters (no errors, no misses).

### Task C — Add a rolling 1-second rate window in C

**Resource**: `emscripten_get_now()` (already used in `wasm_block_trampoline` per memory).

**Action**: Add `ppc_mb_get_rate_window()` returning the last 1s dispatch rate, computed by sampling `dispatches` and `now()` every 16K iters into a 16-slot ring.

**Verification**: harness can read rate every 100ms during a long run.

### Task D — Microbench host page (no dolphin_worker)

**Resource**: `gamecube.html` lines 207-249 (worker spawn pattern from the survey — verify before copying).

**Action**: Build `gamecube/microbench/microbench.html` that:

1. Allocates SAB-backed `WebAssembly.Memory` (smaller — 32 MB is enough for the microbench).
2. Spawns ONLY ppc-worker (no dolphin_worker, no mailbox, no canvas, no audio).
3. Sends `init` with a fake SAB layout (just the bare addresses ppc-worker needs).
4. Calls each `ppc_mb_*` export from `microbench.js`.
5. Logs results to the page + `console.log` as JSON.

**Verification**: open `http://localhost:8080/gamecube/microbench/microbench.html` (via `npm run web`) and confirm ppc-worker initializes without dolphin.

### Task E — Harness logic in `microbench.js`

**Resource**: the three exports from A/B/C.

**Action**: For each layer (L1 pure-C, L2 EM_ASM, L3 via worker postMessage from page, L4 end-to-end through full gamecube.html — skip L4 in this topic, defer to comparison run later), run:

- 5s warmup (discard).
- 30s measurement window. Sample rate every 100ms.
- Report: median rate, p95, total dispatches, count of dispatches per second sustained over the last 10s.

Emit JSON to `gamecube/docs/native-speed-gap-test/refs/measurements-current.json`:

```json
{
  "L1_pure_c":      { "median_disp_per_sec": ..., "p95": ..., "sustained_10s": ... },
  "L2_via_emasm":   { "median_disp_per_sec": ..., "p95": ..., "sustained_10s": ... },
  "L3_via_worker":  { "median_disp_per_sec": ..., "p95": ..., "sustained_10s": ... },
  "deltas":         { "L1_over_L2": ..., "L2_over_L3": ... },
  "context":        { "fixture_block_pc": "0x...", "fixture_block_instrs": 16, "build_sha": "..." }
}
```

**Verification**: file exists, all four medians populated, deltas computed.

### Task F — H1 test (parallel after A–E)

Run harness. `L1_over_L2` ratio is the H1 verdict.

- ≥100× → H1 confirmed dominant cost. **Follow-on topic**: `gamecube/docs/ppc-worker-direct-dispatch/` (mirror the dreamcast `nasomers-table-dispatch` pattern — install region exports into `__indirect_function_table`, lower C call to `call_indirect`, no JS hop).
- 10–100× → H1 contributes but isn't sole cap.
- ≤2× → H1 falsified.

### Task G — H2 test (parallel after A–E)

Add `ppc_mb_dispatch_with_cycles(u32 count, u32 cycles_per_block)` that decrements downcount by `cycles_per_block` per dispatch. Compare rate at cycles=1 vs cycles=8 over 30s of WALL-CLOCK (the variable being measured is "slice exits per emulated-second", not dispatch rate, so divide by `(dispatches × cycles) / 486_000_000`).

### Task H — H3 / H4 / H5 / H6 tests (parallel after A–E)

- **H3**: rerun L2 with `C_SLICE_CAP` env-var override at {256, 1024, 4096, 16384, 65536}.
- **H4**: rerun L2 for 60s, plot rate-window over time. If slope > 0 over first 30s and flattens, tier-up worked.
- **H5**: full-stack run (NOT microbench) with both workers; instrument `wall-time inside ppc-worker run-slice` vs `wall-time waiting for dolphin postMessage reply`. Add to ppc_worker.js (small change).
- **H6**: full-stack run with chrome://tracing enabled (PROBE_TRACE_PATH). Grep main-thread CPU%.

## Dependency graph

```
Task A (pure-C dispatch)   ──┐
Task B (EM_ASM wrapper)    ──┤  parallel
Task C (rate window)       ──┤
Task D (host page)         ──┤
Task E (harness JS)        ──┘
                            ↓
Task F (H1 verdict)  ──┐
Task G (H2 verdict)  ──┤  parallel after A–E
Task H (H3-H6)       ──┘
                            ↓
                Synthesis: rank surviving hypotheses, open follow-on topic
```

## Required-for-survival measurement (rank order, what counts as "found the gap")

After F–H land, the deliverable is `refs/measurements-current.json` annotated with which hypotheses were kill-criterion-confirmed, which were falsified, which inconclusive. The follow-on topic is named for the highest-ranked surviving hypothesis. Throughput stays a hypothesis with named cause until kill criteria evaluate against numbers.

## What this plan deliberately does NOT do

- **No changes to the production dispatch path.** Every code change is `#ifdef PPC_WORKER_MICROBENCH`-gated. Probing must not perturb what we're measuring.
- **No replacement of `region_dispatch` with `call_indirect` here.** That is the follow-on if H1 wins. Doing both in one topic conflates fix-design with measurement.
- **No claim that "we'd be at native if X were fixed."** The output is data + ranked hypotheses, not a foregone conclusion. The user has explicitly rejected the pattern of asserting a cause before the data lands.
- **No reliance on the existing `[phase4-slice]` 2-second log.** That measures slice exits, not steady-state dispatch rate, and the test needs the latter.

## References

- `gamecube/docs/README.md` — pattern + oracle inventory.
- `gamecube/docs/identify-the-actual-blocker/TASKS.md` — sibling topic; complementary (that one audits the wedge claim, this one audits the throughput-cap claim).
- `gamecube/ppc-worker/ppc_worker_main.cpp:1075-1108` — verified inner loop with the EM_ASM crossing comment.
- `bementalJIT/src/block_cache.cpp:887-915` — verified `region_dispatch` EM_ASM_INT body.
- `gamecube/dolphin-bridge/worker_funcs.js:44-75` — dolphin_worker boot/steady dispatch cadence (per survey, not re-verified).
- `gamecube.html:890-943`, `207-249`, `481-502`, `774-829` — orchestration call sites (per survey, not re-verified).
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_native_speed_acceptance.md` — the bar.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/ppc_exterior_worker_2026_05_05.md` — why ppc-worker exists.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/lever_3_tierup_blocked_2026_05_05.md` — H4 motivation.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/module_discard_timing.md` — H4 motivation.
- `dreamcast/docs/nasomers-table-dispatch/TASKS.md` — the architecture the H1-confirmed follow-on topic would mirror.
- `dreamcast/docs/option2-direct-dispatch/README.md` — prior local research bundle on the same EM_ASM-per-dispatch cost on the SH4 side.
