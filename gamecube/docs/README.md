# gamecube/docs — per-investigation task bundles

Canonical home for gamecube/Dolphin investigations. Mirrors `dreamcast/docs/`. Each subdirectory is one **topic** (one wedge, one bringup item, one perf claim worth proving). Each topic contains either a single `TASKS.md` (mirror of `dreamcast/docs/nasomers-table-dispatch/TASKS.md`) or a multi-phase bundle (mirror of `dreamcast/docs/option2-direct-dispatch/`).

Pre-action gate #1 in the repo-root `CLAUDE.md` requires reading the relevant `gamecube/docs/<topic>/TASKS.md` before improvising any probe / test / measurement action.

---

## The failure mode this folder exists to prevent

Across many sessions, the recurring failure has been: **declaring "JIT throughput" as the cause of a stall before proving the actual blocker is throughput and not a discrete unresolved wedge.**

The throughput conclusion is fluent, defensible-sounding, and almost always wrong on the first try. The corrections in `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/`:

- `feedback_throughput_assertion_pattern.md` — never say "it's a throughput issue" / "slow loop" without disasm + reg-delta + emitted-wasm citations.
- `feedback_idle_diagnosis_methodology.md` — stuck PC = real bug. Diagnose via symbol + worker instr/regs + MMIO trace, then kill the probe. Don't wait for throughput to "magically resolve" — at 50K disp/sec, idle loops never finish in wall-time.
- `feedback_use_all_oracles_first.md` — inventory ALL local oracles before declaring blocked. The user has called this out repeatedly: "you already have the resources" / "fucking ridiculous I need to keep pointing you at them."
- `feedback_use_native_log_first.md` — use the native Dolphin log + symbol map BEFORE adding more WASM instrumentation.
- `feedback_tighten_up_oracles.md` — use `sab.map` + native Dolphin + emitter source IN PARALLEL on stuck-PC bugs.
- `feedback_no_dolphin_patching.md` — observe natively, implement in `bementalJIT/` + `gamecube/dolphin-bridge/`. Do not patch `gamecube/dolphin-src/`.

The pattern that works (see `dreamcast/docs/nasomers-table-dispatch/TASKS.md` for the rigor target):

1. Inventory the oracles **first** — every concrete resource that can answer "what is actually happening at PC=X".
2. Write the plan as a table: each step pinned to a specific oracle, each with a concrete expected artifact (a file path, a log grep, a numerical assertion).
3. Order steps by dependency. Mark which are parallel-safe.
4. Define **kill criteria** for the working hypothesis — what observation would falsify it.
5. Every claim about repo or runtime state cites a file:line or a probe-log grep. Throughput is never a default conclusion; it is a hypothesis that has to clear its own kill criteria.

---

## Available oracles + tools (the resource table)

Use this as the starting point when populating a topic's resource table.

### Native ground-truth oracles

| Resource | What it answers |
|---|---|
| **Native Dolphin** (user runs locally, ≤10s runs per `feedback_native_dolphin_short_runs.md`) | Ground truth: what real Dolphin does on the same disc through this PC range, no wasm involved. Best-first answer for "is this stall structural in the game or a bug in our build?" |
| **`~/Downloads/GameCubeSDK`** (`Extra SDKs + Tools + Libraries + Docs.rar`, `GCN_UberInstaller_v14.rar`, Metrowerks CodeWarrior, SNSystems ProDG) | HLE OS API signatures, OS source for matching observed PC ranges. Extract from `.rar` before use. |
| **`gamecube/IPL.bin`** | Real IPL boot ROM — vendored. Used by the dolphin_worker link. |

### Symbol maps + ROM identity

| Resource | What it answers |
|---|---|
| `tools/gsne8p.map` | Sonic Adventure 2 Battle (USA, GSNE8P Rev.00) symbol map. PC → function name. |
| `tools/gpoe8p.map` | Phantasy Star Online symbol map. |
| `dolphin_captures/sab.map` | Captured SAB symbol map (parallel to `tools/gsne8p.map`). |
| `gamecube/roms/Sonic Adventure 2 - Battle (USA).iso` (+ `.bin.partaa…partaq`) | SAB test ROM. GSNE8P Rev.00. |
| `gamecube/roms/PhantasyStarOnline1And2Plus.bin.parta*` | PSO test ROM, split. |

### Bridge + JIT source (what the wasm side actually does)

| Resource | What it answers |
|---|---|
| `gamecube/dolphin-src/Source/Core/Core/HW/*.cpp` (especially `ProcessorInterface.cpp`, `DSPHLE.cpp`, MMIO handlers under `gamecube/dolphin-src/Source/Core/Core/HW/MMIO*`) | What dolphin's native MMIO handlers expect on read/write. Use to validate any "the mirror is canonical" claim (`item6_mmio_stage2_design.md` walks the wrinkles). |
| `gamecube/dolphin-bridge/` (`EmscriptenWorker.cpp`, `dolphin_stubs.cpp`, `worker_funcs.js`, `dolphin_worker_link.sh`, `patches/`) | Page-mediated mailbox + dolphin worker glue. Don't patch dolphin-src — patch here. |
| `gamecube/ppc-worker/` (`ppc_worker_main.cpp`, `ppc_worker.js`, `sab_layout.h`) | Standalone PowerPC JIT worker (Phase 2 architecture). SAB layout in `sab_layout.h`. |
| `gamecube/bementalJIT/include/bementalJIT/` + `gamecube/bementalJIT/src/` + `gamecube/bementalJIT/guests/powerpc/` (+ `guests/powerpc-next/`) | PowerPC emitter + block cache. Where any emit-side fix lands. GameCube uses `gamecube/bementalJIT/` — not the repo-root `bementalJIT/` (which is Dreamcast-only). |

### Build + probe pipeline

| Resource | What it answers |
|---|---|
| **The 3-step foreground flow** (no wrapper — the root `build_and_probe.sh` was deleted by user directive 2026-05-30, commit `270e38c`, and must not be re-introduced; the Dreamcast equivalent wrapper still lives at `dreamcast/build_and_probe.sh`) | Canonical inner-loop (dual-core WebGPU), run discretely and in the foreground: (1) `source $HOME/emsdk-upstream/emsdk_env.sh && cd gamecube/dolphin-src/build-wasm-4010 && emmake make dolphin_libretro -j4`; (2) `bash gamecube/dolphin-bridge/dolphin_worker_link_4010.sh`; (3) `PROBE_HEADLESS=0 PROBE_VANILLA_WEBGPU=1 ROM_IDX=0 node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1`. **Build dir + link `BUILD=` must match** or the wasm is STALE — after linking, verify `grep -c -a "<a-string-you-just-edited>" gamecube/dolphin_libretro/dolphin_worker_emcc.wasm`. `build-wasm` + `dolphin_worker_link.sh` = legacy OGL/3.1.67. Do not improvise `emcc`, do not re-bundle the steps. **For any unknown, start at `gamecube/docs/ORACLES.md` (native dolphin dual-core first).** |
| `gamecube/ppc-worker/build_ppc_worker.sh` | Builds ppc-worker. Also drives `gamecube/bementalJIT/build-emcc/` on first run. |
| `gamecube/dolphin-bridge/dolphin_worker_link.sh` | The canonical link script (step 2). Produces `gamecube/dolphin_libretro/dolphin_worker_emcc.{js,wasm}`; includes `worker_funcs.js` via `--post-js`. |
| `/tmp/probe.log` + `/tmp/probe-trace.json` + `/tmp/probe-metrics.json` | Probe console output (stdout redirect) + chrome://tracing artifact + page.metrics() snapshots. `/tmp/probes/<name>.*` archives are historical (written by the deleted wrapper's `--name` flag — nothing writes them now). |

#### `dolphin_render_probe.js` configuration

No CLI flags — env vars only: `PROBE_DURATION_MS` (default 60000), `PROBE_QUERY` (URL query string, e.g. `ppcbootdispatch=1`), `ROM_IDX` (live gamecube.html ROMS[] index, verified 2026-06-14: 0=Mario Party 4, 1=SAB, 2=PSO, 3=240pSuite — the old "0=SAB,1=PSO" was stale), `PROBE_TRACE_PATH`, `PROBE_METRICS_PATH`, `PROBE_NO_TRACE`, `PROBE_JS_FLAGS`, plus stuck-pattern early-exit knobs (`PROBE_STUCK_*`) — see the constants at the top of the script.

### Runtime-state tools (gamecube/tools/)

| Resource | What it answers |
|---|---|
| `gamecube/tools/dump_sab_pc.mjs` | Dump PC + register state from SAB at a moment in time. First call before any throughput hypothesis on a stuck-PC. |
| `gamecube/tools/diagnose_gc.mjs` | General GC/runtime diagnostic. |
| `gamecube/tools/find_address_uses.mjs` / `find_branches_to.mjs` / `find_callers.mjs` / `find_readers.mjs` / `find_writers.mjs` / `find_mtspr_dec.mjs` | Pattern hunts in the SAB/symbol space. Use these instead of grepping wasm by hand. |
| `gamecube/tools/perf_counters.mjs` / `hb_histogram.mjs` / `wild-perf.mjs` | Perf telemetry. Use AFTER the discrete wedge has been ruled out. |
| `gamecube/tools/wasm-trace-summary.mjs` | Summarize a Chrome trace from `PROBE_TRACE_PATH`. |
| `gamecube/tools/sab_disasm.py` | PowerPC disassembly of SAB regions. Use to identify what the wasm-emitted block actually corresponds to. |
| `gamecube/tools/run_perf_t1.mjs` | Runs the bementalJIT T1 perf harness. |

### Guest-PC census (read `docs/pc-census/TASKS.md` BEFORE quoting a share)

| Resource | What it answers |
|---|---|
| `PROBE_PC_SAMPLE=1` on the probe | Records the guest PC on a 2 ms timer into `/tmp/wasm_pc_hist.json`, 10s segments. Bucket width is `PROBE_PC_BUCKET` (default **4** = the exact PC) and is stored in the artifact. |
| `gamecube/tools/annotate_pc_hist.py` | Renders the census by function. **`SEG_SPLIT=1` is the one to run** — a pooled ranking mixes boot, DVD load and the scene, and does not reproduce run to run (a 14.9% row measured 0.1% on a rerun of the same build). `SEG_MIN`/`SEG_MAX` restrict to a phase. `TOPN`, `ROM_IDX`. |
| `gamecube/tools/gc_symbols.py` | Address → name. Layers the name map over the recovered boundary map and reports provenance via `kind()`: `named` / `xmatch` / `recovered` / `none`. `GC_SYMS_NO_FNMAP=1` = names only (the pre-2026-09-04 behaviour); `GC_SYMS_XMATCH=1` = also use the 96%-precise content-matched names. |
| `gamecube/tools/gc_funcmap.py` | Recovers function boundaries from a DOL → `tools/<game>_fn.map`. **`--rom 0 --validate --no-map-seeds` scores it against MP4's decomp ground truth** (97.92% exact-start recall, 99.34% attribution) — run that before trusting it on a game with no decomp. |
| `gamecube/tools/gc_disasm.py` | Static PowerPC disassembly of a DOL by address or by recovered function, capstone + Gekko paired-single, symbolised branch targets. `--classify` prints the load/store/call/back-edge shape a busy-wait verdict rests on. Prefer over `dump_sab_pc.mjs` for anything static — no browser, no lock, no load. |
| `gamecube/tools/gc_xmatch.py` | Names a game's recovered functions by content-matching MP4's decomp (unlike `cross_ref_expand.py`, which matches by linker layout). `--check` scores precision against the names already known. |

### SDK signature scanning (tools/ at repo root)

| Resource | What it answers |
|---|---|
| `tools/gcsdk_scan.py` + `tools/gcsdk_siggen.py` | SDK symbol signature scan against game binaries — names HLE candidates from the SDK source. |
| `tools/gmpe01_fn.map` / `gsne8p_fn.map` / `gpoe8p_fn.map` / `suite240p_fn.map` | Recovered function boundaries (generated — `gc_funcmap.py`). Unnamed entries are `fn_<addr>`, which is a boundary, not a claimed identity. |
| `tools/gsne8p_xmatch.map` | SAB names inherited from MP4 by content match (generated — `gc_xmatch.py`), 96.0% precise on labelled examples. Opt-in. |

### Tests (the existing proven harnesses)

| Resource | What it answers |
|---|---|
| `gamecube/bementalJIT/tests/` — Emscripten targets (build via `emcmake cmake -S gamecube/bementalJIT -B gamecube/bementalJIT/build-emcc-test -DBEMENTAL_BUILD_TESTS=ON -DBEMENTAL_GUEST_POWERPC=ON && emmake make -C gamecube/bementalJIT/build-emcc-test`); test list: `test_dispatch`, `test_gekko`, `test_perf_t1`, `test_pi_mask_path`, `test_str_hle_pattern`, `test_analyst`, `test_diff`. **Note**: `tests/CMakeLists.txt` early-returns under a native cmake ("requires Emscripten") — all outputs are `.html`, not native binaries. Run by serving the build dir over HTTP and opening the `.html` in a browser. | Emscripten-only correctness harness for emit / dispatch / Gekko / perf-T1 / PI-mask / `str` HLE / analyst / diff (no SH4 — GameCube copy has no SH4 guest). |
| `node gamecube/seqlock.test.mjs` | SAB seqlock primitive smoke test (19/19 per memory). |
| `node gamecube/ringbuffer.test.mjs` | SAB ringbuffer primitive smoke test. |

---

## Per-topic directory convention

```
gamecube/docs/<topic>/
  TASKS.md              # single-file plan, dependency-ordered
  README.md             # only if multi-phase (see option2-direct-dispatch for shape)
  phaseN-*.md           # only if multi-phase
  BLOCKERS.md           # known blockers / abandoned approaches
  refs/                 # reference snippets, captured logs, citations
```

Topic name = short kebab-case description of the question being resolved (e.g. `identify-the-actual-blocker`, `dsphle-ucode-handshake`, `ppc-worker-cold-start-or-not`). The directory itself is the answer to "what is this investigation about" — don't name topics by file shape (`tasks-list`) or by the conclusion (`throughput-fix`) before the conclusion is proven.

### Required sections in a topic's `TASKS.md`

1. **Goal** — one paragraph. The question being answered, not the answer.
2. **Working hypothesis + kill criteria** — what would falsify the hypothesis. If a step finds a kill condition, the topic forks or closes.
3. **Files touched** (table) — every file expected to change, even one-line. Forces planning before coding.
4. **Tasks** ordered by dependency. Each task:
   - **File**: which file.
   - **Concrete change**: literal diff sketch with line numbers (line numbers can drift — verify before edit per pre-action gate #3).
   - **Verification**: one specific check (a grep on a probe log, a numerical bound, a test binary exit code). No "looks right."
   - **Why this is here**: optional. Use when the step is non-obvious.
5. **Dependency graph** — ASCII. Lets a future reader (or you next session) see what's parallel-safe.
6. **What this plan deliberately does NOT do** — list the dropped scope so the next session doesn't reopen it.
7. **References** — file:line citations from the live tree, memory file links, and any external URLs.

### Forbidden in topic docs

- Time estimates of any kind (hours / days / weeks / S-M-L / "quick" / "ambitious"). Per `feedback_no_time_estimates.md`. Use the dependency graph + kill criteria to describe progress, not wall-clock.
- Bare assertions about repo/runtime state without a cite or a hedge per pre-action gate #6.
- "Just" or "simply" prefixed solutions — if the solution were simple the topic wouldn't be in `docs/`.
- A summary section that promotes hedged sections from the body into a confident conclusion. The user has identified this specific pattern as the failure mode (see `feedback_throughput_assertion_pattern.md`): hedged sections collapse into a single confident answer in the summary. Either don't write a summary, or write the summary FIRST and ensure every hedge in the body downgrades it explicitly.

---

## Current topics

| Topic | Status | Question |
|---|---|---|
| `identify-the-actual-blocker/` | open | "Cache cold-start" was named the bottleneck in `phase_2e_cutover_works_cache_bottleneck.md`, but never confirmed against the oracle inventory. Is it really cache cold-start, or is there a discrete unresolved wedge upstream? |
| `native-speed-gap-test/` | open | Across the four boundaries the dispatch path crosses (in-WASM → C → EM_ASM_INT → JS-side ppc_worker.js → gamecube.html orchestration), which single layer's cost is dominant? Microbench design that pins per-layer cost so the gap is measurable, not assumed. |
| `executed-op-census/` | open | Every op-level number in this tree is a STATIC emitted-op count, and `dd6759fb` already paid for that confusion once (`psq_st`'s "107x" is behind an `op_if` the float path never enters). Where do `wasm-function[13]`'s EXECUTED ops actually go on SAB? Ships the instrument (emitted ops x executed frequency, conditional arms separated) and two levers sized with it. |
| `wasm-tier/` | **measured 2026-09-04** | `webAssemblyFindings.md:525` claimed "Verified: **there is no TurboFan tier-up for our JIT'd blocks**, no matter how hot they get" — from V8 blog posts, never measured. **REFUTED**: real emitted SAB blocks reach `compiler: TurboFan`, and the threshold is exactly `--wasm-tiering-budget (13,000,000) / code_body_bytes` executions (confirmed on 3 blocks over a 275x size range). **The tier is worth 2.108x on emitted bodies** (318 real blocks, census-weighted; median 2.75x) — bigger than the whole +8.7% lever inventory AND bigger than `executed-op-census`'s 1.27x ceiling, and multiplicative with it. Under default V8, 260/323 modules tier up on their own, leaving a **1.164x** residual. ⚠ **`dolphin_render_probe.js:159` forces `--no-liftoff` on every run and a web page cannot set V8 flags — so every absolute guest rate this tree has published was measured in a configuration the product cannot ship.** The live A/B attempting to size that is VOID (AI-DMA says +17.1%, peFrames says −21%: not scene-matched). |
| `cross-instance-edge-cost/` | open | What does one chain edge cost under each module topology? Prices the unmeasured premise under `designs/wasm-dispatch-research.md` candidate #1. **Measured: the shipping per-block-module shape costs 2.1-3.7x per edge vs same-instance (Chrome 152 + node, 12 cells). But `block_cache.h:17-20` is half wrong — an INTERNAL table buys nothing (B/A2 median 0.99); SAME-INSTANCE is the whole effect.** Candidate #2 (self-emitted IC) refuted at N=512. Batch size ceiling below 1024. **The follow-up then refuted my own coverage model: sweeping in-batch coverage 0%->87.5% moves the gain NOT AT ALL (1.71-1.97x throughout), because even at 0% coverage 8 modules beat 512 modules-of-one by 1.885x. The variable is INSTANCE COUNT, not coverage** — an easier design target, and it re-explains all three recorded region-promotion negatives. |
| `guest-rate-witness/` | **measured 2026-09-04** | Is there a GC guest-clock witness that can be CROSS-CHECKED, the way Dreamcast's AICA witness can? Yes. `ai_dma_cb` / `aid_fire` / `global_timer` agree to ≤0.0009 in all 12 measurable cells; MP4's guest-executed `retraceCount` agrees to 0.10-0.16%; `drawn/s ÷ guest-rate` recovers the title's native fps on 10 of 12. **The standing rig is `gamecube/tools/guest_rate_witness.mjs` — run it before quoting any GC speed number.** Headline: PSO's title screen is a genuine 0.9992x AND is 71.8% idle-skipped, executing 137.3 MHz of a 486 MHz Gekko. Every `1.00x` must now ship with its idle-skip share. |
| `jit-correctness-rulebook/` | **refuted 2026-05-18** | Diff'd bementalJIT vs JIT64 for stwu/lwz/emit_ea_d directly. Semantics match. The JIT is correctly executing broken guest code: `lwz r4, 408(r3)` with r3=0 → MEM1[408]=0 → SRR0=0 → rfi to PC=0 (already documented at JitWasm.cpp:3060-3068). The wedge is upstream: OS-state / context-save corruption (something writes instruction bytes into a thread Context's save area, or invokes OSLoadContext with r3=0). New topic needed for that. |

Add a row here when starting a new topic.
