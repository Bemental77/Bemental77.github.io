# Phase 6 — Verify + measure (Option 2: direct dispatch)

Pre-build design. No source changes here. Phases 1–5 land the dlopen + C-side
function-pointer table that replaces the JS-mediated `flycast_run_block` hop;
this phase defines how we PROVE it works (boot parity), measure the win
(per-dispatch cost), and decide when to abandon (kill criteria).

Baselines this document compares against:
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_jit_perf_phase1.md`
  — 29 unique PCs in 30s wall, 393–397K disp/s peak, 0 exceptions, 14 epoch
  flushes / 30s, 4 boot milestones present.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_inwasm_dispatcher_plan.md`
  — current ceiling: 91–182 unique PCs in 5 min. Per-dispatch cost on the
  hot path measured at ~100 μs (post-cliff regime). Native target is ~50 ns
  (direct C call); <1 μs acceptable.

---

## 1. Boot-milestone assertion script

`dreamcast/tools/flycast_probe.js` `classify()` (lines 101–110) emits stdout
text containing the four milestone strings, all prefixed by line-of-origin
tags caught in the harness:

| Milestone | Source regex (verbatim from `classify()`) |
|---|---|
| Worker thread bootstrap | `\[page\] worker ready` |
| HW render hook captured | `SET_HW_RENDER captured` |
| Disc/IP.BIN loaded | `load_disc: retro_load_game returned true` |
| GL context reset returned | `hw_render\.context_reset returned` |

Exception count is tracked in `rec_wasm.cpp:925` (`g_exc_count.fetch_add`)
and surfaces in stdout when a `[exception]` line is logged AND in the 5s
`[stats]` flush line (`rec_wasm.cpp:988`) as `exc=N/s`.

Unique-PC sampling uses the per-1000 `[flycast-worker] sh4 dispatch #N pc=0xXXX`
line emitted from `rec_wasm.cpp:530` (gated behind `g_diag_enabled`, which
the probe defaults to ON via `flycast_diag_set(1)` on probe start).

### Bash assertion (run after `build_and_probe.sh --duration 300000 --log /tmp/probe-dc.log`):

```bash
LOG=${1:-/tmp/probe-dc.log}

# 4 boot milestones present (exit 1 if any missing)
for m in \
  '\[page\] worker ready' \
  'SET_HW_RENDER captured' \
  'load_disc: retro_load_game returned true' \
  'hw_render\.context_reset returned'; do
  if ! grep -qE "$m" "$LOG"; then
    echo "FAIL: missing milestone /$m/" >&2
    exit 1
  fi
done

# mainloop entry fires at least once (DEBUG_DISPATCH-gated line)
grep -qE 'mainloop entry #' "$LOG" || { echo "FAIL: no mainloop entry"; exit 1; }

# exception count = 0 (any [exception] # line is a fail; [stats] exc>0 is a fail)
if grep -qE '\[exception\] #' "$LOG"; then
  echo "FAIL: exceptions raised" >&2; exit 1
fi
if grep -E '\[stats\]' "$LOG" | grep -vE ' exc=0/s' >/dev/null; then
  echo "FAIL: stats line shows non-zero exc/s" >&2; exit 1
fi

# unique PCs >= 91 in the probe window
UNIQUE_PC=$(grep -oE 'sh4 dispatch #[0-9]+ pc=0x[0-9a-f]+' "$LOG" \
            | awk '{print $NF}' | sort -u | wc -l | tr -d ' ')
if [ "$UNIQUE_PC" -lt 91 ]; then
  echo "FAIL: only $UNIQUE_PC unique PCs (baseline >= 91)" >&2; exit 1
fi

echo "PASS: 4 milestones, mainloop entered, 0 exceptions, $UNIQUE_PC unique PCs"
```

The pipeline relies on `--keep-noise` NOT being set (probe filter already
drops the emcc dbg noise that would otherwise pollute the grep). Run from
the probe driver: `bash dreamcast/build_and_probe.sh --duration 300000 --name option2-verify && bash assert-boot.sh /tmp/dc-probes/option2-verify.log`.

### Optional richer assertion: epoch-flush count parity

Baseline had 14 epoch flushes / 30s. Under Option 2 the `flush_epoch` cadence
shouldn't change (compile path is identical; only dispatch differs). Add an
informational check:

```bash
FLUSHES=$(grep -cE '\[epoch\] flush #' "$LOG")
echo "INFO: $FLUSHES epoch flushes in window (baseline ~14 per 30s)"
```

Not a fail gate — if Option 2 reaches further into boot, flush count rises
naturally.

---

## 2. Per-dispatch cost microbench

### Instrumentation site

`dreamcast/flycast-bridge/rec_wasm.cpp` `mainloop()` (line 502 onwards) runs
the `while (ctx->CpuRunning) { try { ... wasm_block_trampoline(); ... } }`
loop. Under Option 2 the `wasm_block_trampoline()` call becomes a direct C
function-pointer invocation via the dlopen-resolved table. Wrap that call
site with a wall-clock batch timer.

### C++ to add (paste-ready, gated behind a new `DISPATCH_MICROBENCH` flag so
release builds don't pay the `emscripten_get_now` cost):

```cpp
#ifdef DISPATCH_MICROBENCH
static constexpr unsigned MBENCH_BATCH = 10000;
static unsigned          mbench_n      = 0;
static double            mbench_t0     = 0.0;
static unsigned long     mbench_total  = 0;

if (mbench_n == 0) mbench_t0 = emscripten_get_now();
wasm_block_trampoline();
if (++mbench_n == MBENCH_BATCH) {
    double dt_ms      = emscripten_get_now() - mbench_t0;
    double per_dispatch_us = (dt_ms * 1000.0) / (double)MBENCH_BATCH;
    mbench_total += MBENCH_BATCH;
    // Fire one [mbench] line per 100k dispatches (= every 10 batches).
    if ((mbench_total % 100000) == 0) {
        MAIN_THREAD_EM_ASM({
            postMessage({cmd: 'print', txt:
                '[mbench] per_dispatch_us=' + ($0).toFixed(3) +
                ' batch=' + ($1|0) +
                ' cumulative=' + ($2|0)});
        }, per_dispatch_us, (int)MBENCH_BATCH, (int)mbench_total);
    }
    mbench_n = 0;
}
#else
wasm_block_trampoline();
#endif
```

Rationale for batch=10000:
- `emscripten_get_now()` on the worker thread is `performance.now()`-backed
  with ~5 μs resolution under COOP+COEP isolation. A batch of 10000 gives
  measurement granularity ≈ 0.5 ns per dispatch — well below the <1 μs target.
- One `[mbench]` log line per 100k dispatches keeps the postMessage stream
  off the hot path (already a known killer per the inline-sampler comments
  in `rec_wasm.cpp:514–516`).

Gate via the existing `FLYCAST_RELEASE`/diag toggle in
`dreamcast/flycast-bridge/flycast_worker_link.sh:149` — add `DISPATCH_MICROBENCH`
to the same env-var family but inverted (default ON during Option 2 verify;
strip for the eventual production link).

### Grep pipeline

```bash
LOG=${1:-/tmp/probe-dc.log}
grep -E '\[mbench\] per_dispatch_us=' "$LOG" \
  | awk -F'[= ]' '{print $3}' \
  | sort -n \
  | awk '
      { a[NR]=$1; sum+=$1 }
      END {
        n=NR
        if (n==0) { print "no [mbench] lines"; exit 1 }
        mean = sum/n
        median = (n%2) ? a[(n+1)/2] : (a[n/2]+a[n/2+1])/2
        min = a[1]; max = a[n]
        printf "samples=%d  min=%.3f  median=%.3f  mean=%.3f  max=%.3f us/dispatch\n",
               n, min, median, mean, max
      }'
```

We watch `median` (resistant to GC / Liftoff-recompile spikes that show up
as outliers in `max`). Success = median < 1.0; stretch = median < 0.1.

### Cross-reference to baseline

The implicit baseline today is `400000 dispatches/sec` peak ≈ 2.5 μs/dispatch
on the fast loop, ramping to ~100 μs/dispatch on the cliff'd loop (per
`dreamcast_inwasm_dispatcher_plan.md`). The microbench picks up BOTH regimes
across the probe — sort + percentile makes the regime split visible.

---

## 3. Render-progress probe spec

### What "render" means here

`dreamcast/flycast-bridge/flycast_worker_funcs.js` (search for `video_cb`)
logs `[flycast-worker] video_cb w=H h=V data=0xPTR pitch=N` from libretro's
`retro_video_refresh_t` callback. Today `data=0` (NULL framebuffer) on every
call — the PVR has never reached STARTRENDER. Success line shape:

```
[flycast-worker] video_cb w=640 h=480 data=0x<non-zero> pitch=2560
```

### Probe duration

The probe's `--duration` flag (in ms) drives `flycast_probe.js:DURATION_MS`.
For Option 2 verify we need enough wall to reach the SAB-style polling-loop
plateau at minimum (today: 91 unique PCs after 5 min wall). Don't hardcode
a number here — drive iteratively: short verify run first (boot-parity
assertion above), then long render-probe (Section 6).

### Render success grep

```bash
LOG=${1:-/tmp/probe-dc.log}

# Any non-NULL framebuffer means PVR completed at least one frame
NONNULL=$(grep -E 'video_cb ' "$LOG" | grep -v 'data=0x0 ' | grep -vc 'data=0 ')
TOTAL=$(grep -cE 'video_cb ' "$LOG")
echo "video_cb: $NONNULL non-null of $TOTAL total"
[ "$NONNULL" -gt 0 ] && echo "RENDER REACHED" || echo "STILL PRE-RENDER"
```

### Companion checks (PC trajectory)

The post-IMASK=6 game-code entry from morning's `dreamcast_session_2026_05_16.md`
is PC 0x8c0c1e50. If we hit that we know we've cleared BIOS init. From the
sampled `[flycast-worker] sh4 dispatch` lines:

```bash
grep -oE 'sh4 dispatch #[0-9]+ pc=0x[0-9a-f]+' "$LOG" \
  | awk '{print $NF}' \
  | sort -u \
  | awk -F'x' '{ printf "%s\n", $2 }' \
  | sort -u \
  | (echo "Hit 0x8c0c1e50?"; grep -E '^8c0c1e[0-9a-f]{2}$' || echo "  no")
```

GDROM register writes — STARTRENDER lives at `0x005f8014` in the holly map.
If Phase 1–5 unblocks rendering we should see at least one such write
arrive at the bridge (logged in `EmscriptenWorker.cpp` MMIO trace under
`-DFLYCAST_BRIDGE_DIAG`):

```bash
grep -cE '\[gdrom\] W reg=0x5f8014' "$LOG"
```

A non-zero count without `[exception]` lines and with `video_cb data=0x<non-zero>`
following is the strongest single signal that Option 2 worked end-to-end.

---

## 4. Kill criteria — when to abandon Option 2

These are concrete numeric thresholds. Any single row failing in a probe run
means "Option 2 didn't deliver — go back to the architectural options listed
at the bottom of `dreamcast_inwasm_dispatcher_plan.md` (persistent funcref
table / dedicated worker / move dispatcher loop into wasm)."

| Signal | Threshold | Source |
|---|---|---|
| Median `[mbench] per_dispatch_us` | > 10.0 | Section 2 grep |
| Boot milestones present | < 4 | Section 1 grep |
| Exceptions in window | > 0 | `[exception] #` lines OR `exc>0/s` in `[stats]` |
| Unique PCs at 5 min wall | < 91 (baseline regression) | Section 1 grep |
| Throughput (peak disp/s in `[stats]`) | < 100K (3.9× below baseline) | `grep '\[stats\]' \| awk '/disp=/{print}'` |
| `install_epoch FAILED` lines | > 0 | `grep '\[rec_wasm\] install_epoch FAILED'` |

### Interpretation

- Per-dispatch > 10 μs means the dlopen path didn't actually eliminate the
  JS-trampoline cost — likely an indirection or marshaling step survived.
  No point investigating render; bail.
- Boot regression (< 4 milestones, > 0 exceptions, < 91 unique PCs) means
  Option 2 broke something semantic. Bail before sinking time into perf.
- Throughput < 100K disp/s while milestones are present means dispatch
  works but is no faster than the baseline — Option 2 missed its premise.

A passing run is: 4 milestones, 0 exceptions, ≥91 unique PCs, ≥100K disp/s
peak, ≥0 `install_epoch FAILED`, AND `[mbench]` median < 1 μs. Then we move
on to Section 6.

---

## 5. A/B build mode

`flycast_worker_link.sh:149` already shows the pattern: env var gates a set
of `-D` flags in the emcc command. We extend the same mechanism rather than
adding a separate link script (less drift, same archives, same JS post-js).

### Proposed: `FLYCAST_DISPATCH=js|c` env var

| Value | Meaning | What changes |
|---|---|---|
| `js` (default) | Current JS-mediated dispatch via `wasm_dispatcher_run_block` EM_JS | No flag added |
| `c` | Phase 1–5 direct-C dispatch via dlopen'd fn-ptr table | `-DFLYCAST_DISPATCH_DIRECT_C` added; rec_wasm.cpp uses the new path under `#ifdef` |

Add to `flycast_worker_link.sh` just after the existing `DIAG_FLAGS` block:

```bash
DISPATCH_FLAGS=""
case "${FLYCAST_DISPATCH:-js}" in
  js) echo "link: FLYCAST_DISPATCH=js (baseline JS-mediated dispatch)" ;;
  c)  DISPATCH_FLAGS="-DFLYCAST_DISPATCH_DIRECT_C"
      echo "link: FLYCAST_DISPATCH=c (Phase 1-5 direct-C dispatch)" ;;
  *)  echo "ERROR: FLYCAST_DISPATCH must be js or c" >&2; exit 2 ;;
esac
```

Append `$DISPATCH_FLAGS` next to `$DIAG_FLAGS` on the emcc command line.

### Invocation

```bash
# Baseline run (today's code path)
bash dreamcast/build_and_probe.sh --duration 300000 --name baseline-js

# Option 2 run (Phase 1-5 path)
FLYCAST_DISPATCH=c bash dreamcast/build_and_probe.sh --duration 300000 --name option2-c

# Diff
diff <(grep -E '^\[(stats|mbench|epoch)\]' /tmp/dc-probes/baseline-js.log) \
     <(grep -E '^\[(stats|mbench|epoch)\]' /tmp/dc-probes/option2-c.log)
```

`build_and_probe.sh --name X` archives to `/tmp/dc-probes/X.log` per
`build_and_probe.sh:40-46`, so A/B archives don't stomp each other.

### Why not a separate link script

The bridge TUs + archive list + Emscripten flags are identical between modes
— only one `#ifdef` flips inside `rec_wasm.cpp`. A second script would
double the maintenance burden for zero gain. Env var is consistent with the
existing `FLYCAST_RELEASE` pattern.

---

## 6. Long-running render probe

### Run shape

Use the probe in its longest-stable configuration:

```bash
FLYCAST_DISPATCH=c bash dreamcast/build_and_probe.sh \
  --skip-link \
  --duration 1800000 \
  --idle 60000 \
  --name option2-render-long \
  > /tmp/dc-probes/option2-render-long.stdout 2>&1
```

`--skip-link` reuses the verify-run's `.wasm` (no rebuild). `--idle 60000`
tolerates long quiet windows where the JIT is grinding through a polling
loop without emitting `[stats]`/`[mbench]` traffic.

### What to grep at the end

```bash
LOG=/tmp/dc-probes/option2-render-long.log

# 1. First framebuffer
echo "--- video_cb timeline ---"
grep -n 'video_cb ' "$LOG" | head -5
grep -E 'video_cb ' "$LOG" | awk '{
  for (i=1;i<=NF;i++) if ($i ~ /^data=/) { print $i; break }
}' | sort | uniq -c | sort -rn | head

# 2. PC trajectory — did we reach 0x8c0c1e50 (post-IMASK=6 game code)?
echo "--- game-code entry ---"
grep -oE 'pc=0x8c0c1e[0-9a-f]{2}' "$LOG" | sort -u

# 3. STARTRENDER writes
echo "--- STARTRENDER writes ---"
grep -cE '\[gdrom\] W reg=0x5f8014' "$LOG"

# 4. Throughput trajectory over time
echo "--- disp/s over time ---"
grep -E '\[stats\]' "$LOG" | awk -F'[= /]' '{print NR, $3}'

# 5. Microbench trajectory
echo "--- per-dispatch us over time ---"
grep -E '\[mbench\]' "$LOG" | awk -F'[= ]' '{print NR, $3}'

# 6. Epoch flush growth
echo "--- epoch flushes ---"
grep -cE '\[epoch\] flush #' "$LOG"

# 7. Exceptions (should stay 0)
echo "--- exceptions ---"
grep -cE '\[exception\] #' "$LOG"
```

### Interpreting partial results

| Pattern | Interpretation |
|---|---|
| `video_cb data=0x<non-zero>` appears | RENDER REACHED — Option 2 unblocked the goal |
| `pc=0x8c0c1e<xx>` appears, no `video_cb data=non-NULL` | Reached game code but stuck in pre-render init (PVR or asset-load) — Option 2 worked for dispatch but downstream subsystem (TA/PVR/maple) is the next gate |
| `pc=0x8c0c1e<xx>` never appears, `[stats] disp=` shows steady high disp/s | Still in BIOS/IP.BIN — throughput is fine but boot trajectory unchanged. Cross-check unique-PC count vs baseline; if equal, suspect a missing milestone Option 2 should have unblocked. |
| `[mbench] per_dispatch_us` median trajectory rises over time | The cliff is still present — Option 2 may have moved the cliff but not removed it |
| `[mbench]` flat low, but PC count flat | Per-dispatch is fast but dispatcher isn't making forward progress (stuck in tight loop). Probe a different gate: is `[stats] cache_miss/s` non-zero? |
| `install_epoch FAILED` appears | Epoch flush broke — Option 2 corrupted the merged-module path. Check `[rec_wasm] install_epoch FAILED #` line for the JS-side error message. |

### Success criteria for the long probe

- HARD: at least one `video_cb` line with `data=0x<non-zero>` AND `[exception]` count == 0.
- SOFT: PC trajectory passes 0x8c0c1e50, `[mbench]` median holds < 1 μs across the full window (not just the boot prefix).

If HARD passes, Option 2 is the architecture going forward. If only SOFT
passes, Option 2 worked for dispatch but next-issue downstream needs separate
investigation — start with PVR/TA register traces, not more dispatch tuning.

---

## 7. Open questions (need an actual build to answer)

These can't be settled from design alone:

1. **dlopen module size + load cost under Phases 1–5.** If the direct-C
   table is populated by a dlopen'd side module per epoch, the per-flush
   cost story may shift — does `dlopen` invoke Liftoff the same way
   `new WebAssembly.Module(...)` does? Need a `[mbench]`-style timer
   around the dlopen call itself, separate from per-dispatch.

2. **Per-block ABI marshaling cost.** Today's trampoline reads
   `ctx->pc`, calls JS with `(pc, ctx_ptr, ram_base)`. Direct-C path can
   inline that. But if Phase 1–5 keeps a thin marshal layer (e.g. to
   re-fetch `s_ram_base` per call), we may eat back the win. The microbench
   in Section 2 measures the END-TO-END dispatch cost so this is captured
   — but if median lands in the 5–10 μs range (close to kill but not
   quite), the answer matters for whether to push further.

3. **`SH4ThrownException` C++ try/catch cost.** The current loop body wraps
   `wasm_block_trampoline()` in `try { ... } catch (const SH4ThrownException&)`.
   If Option 2 keeps that try/catch, the catch-stack-frame cost on each
   iteration may dominate the new dispatch cost. Microbench can isolate
   this by toggling try/catch on/off in a separate sub-build (requires a
   second `-D` flag — pre-decision; flag only if Section 2 measures >1 μs).

4. **Microbench overhead floor.** `emscripten_get_now()` itself costs a
   nontrivial fraction of a microsecond. A pre-flight calibration —
   measure 10 calls to `emscripten_get_now()` back-to-back and subtract
   that from `[mbench]` numbers — would tighten the headline number. Not
   load-bearing for kill criteria (10 μs threshold is well above
   measurement noise), but useful for stretch target verification.

5. **Probe wall-time vs PC trajectory.** Today's baseline (91 PCs in 5 min)
   doesn't tell us the SHAPE of the trajectory (linear discovery rate vs
   step-function jumps at boot milestones). Knowing the shape lets us
   pick a probe duration that's large enough to clear the next plateau
   without over-running. Worth a one-time profile of the baseline:
   `grep -oE 'sh4 dispatch #[0-9]+ pc=0x[0-9a-f]+' /tmp/dc-probes/baseline-js.log
    | awk '{print $3, $NF}'` then plot dispatch# vs unique-PC count.

---

## File touch-list (Phase 6 implementation, when ready)

Design only — no edits in this phase. When implementing:

- `dreamcast/flycast-bridge/rec_wasm.cpp` — add the `#ifdef DISPATCH_MICROBENCH`
  block around `wasm_block_trampoline()` in `mainloop()`.
- `dreamcast/flycast-bridge/flycast_worker_link.sh` — add `FLYCAST_DISPATCH`
  env-var case + `DISPATCH_FLAGS` variable; thread into emcc command.
- New: `dreamcast/tools/assert-boot.sh` — Section 1 bash block, executable.
- New: `dreamcast/tools/mbench-summary.sh` — Section 2 grep+awk pipeline.
- New: `dreamcast/tools/render-summary.sh` — Section 6 grep set.

No changes to `dreamcast/tools/flycast_probe.js` required — its existing
console capture + `--log` output already feeds every grep above.
