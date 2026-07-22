# Native-exact dual-core — deviation inventory & strip list

**Principle (user directive 2026-07-22): the gap is ACCURACY to local native dolphin dual-core, not
throughput. Make the seam identical to native and DELETE whatever compensated for the difference.**
Native model (ORACLES.md, confirmed live): CPU thread = JIT + CoreTiming + ALL devices + interrupt
delivery, in-process; GPU thread = RunGpuLoop + render; ONE boundary = the GX FIFO.
Every item below was verified in-tree 2026-07-22 (this session); re-verify line refs before editing.

## A. Structural deviations (make identical to native)

1. **RunGpuLoop never runs.** gpu_thread is neutered (Core.cpp `#if defined(__EMSCRIPTEN__)` hunk in
   FifoPlayerThread-adjacent EmuThread code; motivated by the unexplained "gpu_thread reads
   distance=0 / memory-isolated" observation). Decode instead = retro_run (proxy-main) →
   `Fifo.h DrainFifoOnCpuThread` → `RunGpuOnCpu` — the SINGLE-CORE path. Native-exact target: the
   device-owning thread runs RunGpuLoop's dual-core chunk body (SafeCPReadPointer publication,
   per-chunk `AsyncRequests::PullEvents` (Fifo.cpp:423), gpu_mainloop semantics) — either by fixing
   the gpu_thread memory-isolation anomaly (root-cause it: a pthread MUST share memory; if the spawn
   path instantiates a fresh Memory that is a build/link bug) or by making proxy-main the GPU thread
   properly. The `[dc cp-gate]` mutex (MMIO.h/MMIO.cpp/Fifo.cpp) and `[dc safe-rp]` fix exist ONLY
   because RunGpuOnCpu is the decoder; delete both when decode is RunGpuLoop-exact.
2. **AsyncRequests drain cadence.** Native drains per chunk inside RunGpuLoop; ours drains once per
   retro_run AFTER the decode batch (Main.cpp "[present GATE B]") — ordering deviation (e.g., a
   queued ResetVideoBuffer from PI_FIFO_RESET applies after the batch that needed it).
3. **Dead-but-present takeover machinery** (native has NO takeover). The ppc-worker still spawns,
   handshakes, and polls forever ("boot-dispatch: anchor not reached (poll stays alive)" every run).
   Strip list: worker spawn (or gate behind an explicit flag), PixelEngine.cpp SetFinish arm block
   (armframe @0x026B0A30 / ho_arm @0x026B0980), JitWasm.cpp ho_arm clamp/park block (~L295-345),
   gamecube.html cpu_owner/armframe plumbing + handover gates, EmscriptenWorker owner-edge/one-clock
   blocks, `gpfifo_redirect_excursion_to_ring` + `g_gp_discard` + `g_in_drain` (GPFifo.cpp),
   `dolphin_sync_worker_fifo` + worker-fifo pub block (EmscriptenWorker.cpp), the GP ring
   (0x026C0000) and ppc_worker.js wgp-order/mi-regfile/perf-zero/pi-mask/mmio-mirror shadows — all
   takeover-era. Verify each is dead on the live path first (their own counters exist: wfArmed=0,
   gpRing head/tail=0, wgpGateN=0 across all 2026-07-22 runs).
4. **UpdateGatherPipe wp-invariant pre-sync + [dl-fifo fix] same_buffer gate** (GPFifo.cpp:100-141)
   — cross-worker-era resync; native has no equivalent. Review for deletion once (1) lands (the
   divergence source was the retired worker paths).
5. **Fifo tick heuristics** — SyncGPUCallback m_sync_ticks reset, SyncGPUForRegisterAccess
   force-drain (both `#ifdef __EMSCRIPTEN__`, Fifo.cpp), DrainFifoOnCpuThread's artificial
   m_sync_ticks seed (Fifo.h:75) — single-core-era; delete with (1).

## B. Diagnostic bloat (strip mechanically — grep the tags)

`grep -rn "dc-diag\|domino3\|TEMP]" gamecube/dolphin-src/Source/Core gamecube/dolphin-bridge` —
GPFifo.cpp (entry counters, live CP publish, &fifo publishes, wtgt dump), Fifo.cpp (rgoc/rgl
counters), CommandProcessor.cpp counters, DVDInterface.cpp DI counters, BPStructs.cpp SETIMAGE3,
OpcodeDecoding.cpp CALL_DL census + garbage-draw trap, JitWasm/EmscriptenWorker domino3 leftovers.
DONE 2026-07-22: cmd-ring, unkop byte-dump, out-of-sync assert enrichment (stripped same day, after
they caught the gather-pipe byte deletion).

## C. Keep (native-matching, or required until A1 lands)

- `[dc safe-rp fix]` RunGpuOnCpu SafeCPReadPointer publication — native RunGpuLoop behavior.
- `[dc cp-gate]` MMIO-write-vs-decode-chunk mutex — compensation, delete with A1.
- `[restructure gather-ownership]` proxy-main gather-drain gated to takeover mode — REMOVES a
  non-native call (the gather pipe is CPU-thread-private in native).
- `[park-trap disarm]` gamecube.html armframe default 0 — no takeover ⇒ never arm.

## STATUS 2026-07-22 PM — dual-core UNCONDITIONAL (user directive: "no flags, it is the only way")

gamecube.html always writes SAB 0x026B0AF0=1; Core.cpp gpu_thread ALWAYS runs RunGpuLoop;
Main.cpp's proxy-main DrainFifoOnCpuThread call is DELETED. There is ONE decode path: RunGpuLoop
on the gpu_thread, as native.

**GPU LOOP FIXED 2026-07-22 PM3 — the murder weapon was Core.cpp:1039:** under __LIBRETRO__ the
per-frame callback called `StopGpuLoop()` in dual-core (the native-libretro run-once-per-retro_run
idiom, paired with the Main.cpp #else branch we don't use) — it killed the persistent gpu_thread
loop ~300ms into EVERY boot (3 sleeps then m_shutdown; heartbeat 0x026B1BE4/1BE8 + dcInitDual
@0x026B1BE0 proved the path). Now gated `!defined(__EMSCRIPTEN__)`. VERIFIED LIVE: rglDrain=59,
cpDistGpuMax=32 (no backlog), sleepPre==sleepPost=49, nonceGpuSeen=1207 (live cross-thread reads).
Prepare() also made unconditional at Fifo::Init (dcInitDual=1 — order theory was moot).

**STORM RAISER FIXED 2026-07-22 PM6 — the throttler was disabled:** DolphinLibretro/Boot.cpp:541
`Core::SetIsThrottlerTempDisabled(true)` (libretro "frontend paces" idiom) ORs into
IsSpeedUnlimited (CoreTiming.cpp:577) — nothing paces the freed EmuThread, so emulated time raced
at wasm-max. FIX: emscripten keeps the throttler ENABLED (+ EMULATION_SPEED defaults 1.0 in
Boot.cpp/Options.cpp — note environment_cb returns false for GET_VARIABLE so call-site defs rule).
MEASURED: DSP interrupts 149,590 -> 19,638 per 90s (7.6x), audio 750K -> 122K samples/s (23x ->
3.8x native). Residual 3.8x = follow-up (VI-field Throttle cadence / max_fallback relaxation).

**PM16 2026-07-22 — EMUTHREAD CPU PROFILE (CDP, worker_2, 180K samples; PROBE_CPU_PROFILE=1):**
47.96% wasm-function[13] (the emitted guest-code module — unnamed runtime wasm), 11.50%
bem_chain_loop_c (dispatch), ~13% sleeps (futex+timedwait — throttle etc., correct), ~9.5% JS
boundary (wasm-to-js 3.18 + wrapper 1.95 + js-to-wasm ~1.3 + readEmAsmArgs/Module/Instance/
growMemViews ~2.9 — the emitted module's imports cross through JS trampolines), ~7.5% slowmem/
MMIO (MMU::WriteToHardware 3.58 + Read/Write templates + Memcheck 0.63 + dolphin_write16 1.0 +
dolphin_read32 0.39 + stateless_write_w 0.32), 1.60% emit_block_body_into (MID-RUN RECOMPILES —
check invalidation churn), 1.67% _emscripten_get_now (perf instruments — strip when done).
CAMPAIGN ORDER (impact x tractability): (1) funcref DIRECT LINKING of the emitted module's
imports (kills the ~9.5% JS boundary; the N64 M1 funcref bridge is the proven in-repo pattern —
n64/docs/jit); (2) dispatch (bem_chain_loop_c 11.5% — region promotion/chaining); (3) slowmem
audit (what falls to slowmem in the board scene? dolphin_write16=WPAR 16-bit? Memcheck gate);
(4) hot-block emit quality (the 48% — needs the guest block profiler hot-list + native sampler
diff); (5) recompile churn check. SIDE FINDING: worker_8 = libusb GC-adapter scanner BUSY-SPINS
a full core (libusb_handle_events_timeout_completed 100%) — kill/gate the adapter scan thread.

**PM15c — EmuThread split MEASURED (Advance bucket @0x026B3390/94 added to the dashboard):**
over ~90s: CoreTiming::Advance = 6.7s (~7.5%, 1.21M calls @ ~5.5us avg — devices/events are NOT
the lever), throttle-sleep 4.4s (~4.8%), device thread 2.1s (~2.3%) ⇒ **~87% of the EmuThread is
emitted-block execution + dispatch + import calls — the JIT engine is the whole 60fps campaign.**
Next decomposition: run the JIT block profiler (working tool per memory) for the guest hot-block
list; compare against the native PC sampler's list; attack the top blocks' emit quality
(conformance-gated via test_diff_next per change). Watch dispatch overhead + per-WGP-store import
cost (gpfWrite32 path fires per gather word during rendering) as candidate cross-cutting wins.

**PM15b — JIT campaign entry point (grounded):** powerpc-next ALREADY fastmem-guards psq loads/
stores (jit_load_store.cpp ~1255+: emit_fastmem_guard in the FLOAT paths; the "stfd/psq slowmem-
only" note was the OLD gekko-era bridge comment) and the psq conversions are bit-exact. So the
4.6x is NOT one missing fast path — profile FIRST: EmuThread self-time breakdown (dispatch loop
vs emitted-block execution vs import round-trips vs CoreTiming/device service). Tools: the JIT
block profiler (working per memory), the perf-split dashboard (0x026B3380/84/88), and the native
PC sampler for guest-function comparison. Per-change conformance via test_diff_next
(gamecube/tools/conformance/run.mjs).

**PM15 2026-07-22 — 60FPS LIMITER MEASURED: the guest JIT (EmuThread).** perf-split instruments
(slice self-time @0x026B3380/84, CPU throttle-sleep @0x026B3388 — kept as the perf dashboard):
over 90s, device thread = 2.1s busy (~2.4% util, 0.09ms/slice x 23K slices); CPU thread slept
only 4.75s (~95% busy) at ~21% native speed (13/60fps). Render side idles; JIT needs ~4.6x.
Independently reconfirms [[native-pc-sampler-and-decode-bottleneck-2026-07-12]] (native 80% idle
vs our ~5%; paired LOAD/STORE-bound). NEXT CAMPAIGN = bementalJIT emitter throughput: paired
load/store (psq_st/psq_l, stfd/lfd) fastmem coverage + emit quality, real downcount, then
re-measure on this dashboard. Route-A parallel GPU worker NOT needed for 60fps (GPU side at 2%).

**PM14 2026-07-22 — DEVICE-MIGRATION PHASE 1 LANDED: GEOMETRY RENDERS.** RunGpuLoop's payload
extracted as FifoManager::RunGpuLoopSlice() (Fifo.h/.cpp — native per-chunk protocol verbatim);
retro_run (proxied-main = the WebGPU device thread, whose pump yields the event loop the async
device init needed) runs the slice per pump (Main.cpp; GATE B retired — the slice pulls events);
the spawned gpu_thread PARKS (Core.cpp — never-Run mainloop keeps FlushGpu/ExitGpuLoop no-op).
All three decode device-gates auto-lift on the device thread. VERIFIED (MP4): drawN=1668,
drawVerts=6672, efbCopyN=832==peFrames (copy per frame), canvas 286,720/307,200 non-black,
aramReqN=1992, omcurovl=1, gc 718, 792 frames @63s (~12.5fps), zero popups. Dual-core split =
EmuThread (CPU: JIT+CoreTiming+devices) ∥ proxied-main (GPU: decode+render+present).
REMAINING: (1) PERF to 60fps on this baseline; (2) Phase 2 true parallel GPU worker (route A)
when perf demands it; (3) WGPUTextureCache CopyEFB-to-RAM still empty (the post-menu texture
garbage item) + depth-copy skip; (4) 240pSuite bringup; (5) final TEMP-ring strip.

**PM13 2026-07-22 — CROSS-GAME VERIFIED + HOT-PATH STRIP DONE.** MP4 (gc 754+, aram 1992,
zero popups), SAB (peFrames 401+), PSO (peFrames 1097+) all run the dual-core chain; 240pSuite
= separate pre-existing bringup bug (PC 0x80009374, pre-GX, libogc — own investigation).
Stripped (regression-verified identical boot): BlockingLoop per-iteration seq stamp, Fifo
payload/drain seq + dist-diag RMW probe + nonce (both halves), CommandProcessor per-burst
publishes, DSP per-UpdateInterrupts guest-queue reads. KEPT: cheap counters the probe reads,
the worker-error capture (permanent), all fixes. REMAINING TEMP to strip when rendering lands:
stage/frozenChunk probe fields, aram/cw/ctrl rings, sleep heartbeats, loop-exit marker.
**NEXT CAMPAIGN — WGPU device migration to the gpu_thread** (lifts the 3 decode gates + GATE B +
cp-gate + safe-rp, restores geometry): the hard constraint is async requestAdapter/requestDevice
on a pthread that never returns to its worker's event loop. Two viable routes: (A) message-driven
GPU WORKER (ppc-worker pattern: JS-driven worker owning device + decode, wasm exports per
message — no blocking mainloop, event loop turns naturally); (B) init-phase yielding on the
gpu_thread (structure RunGpuLoop entry as a continuation: create device via callbacks BEFORE
entering the blocking loop, with the pthread returning to its wrapper between steps). Then perf
to 60fps on the post-migration baseline.

**PM12 2026-07-22 — BOOT UNLOCKED ON TRUE DUAL-CORE.** The RunFifo freezes were wgpu calls on the
device-less gpu_thread, found chunk-by-chunk via the seq/stage/frozenChunk rig: drain#59 = EFB-copy
trigger (BPStructs BPMEM_TRIGGER_EFB_COPY — gated), drain#79 = the FIRST DRAW (0x80 quads →
VertexLoaderManager::RunVertices → WGPU vertex manager — gated in OpcodeDecoding.cpp, size-safe
since stream advance is computed independently). WITH BOTH GATES: aramReqN=1992 (full native
upload), peFrames fires, omcurovl=1, dvdCmdN 352+, gc 772+ @90s, frames 855 @63s, zero popups.
The boot chain that was dead all day (finish token -> FinishQueue -> ARAM #11 -> overlay -> DVD)
runs end-to-end. THE THREE INTERIM GATES (VertexManager Flush, EFB-copy trigger, draw/RunVertices)
defer actual GEOMETRY to nothing — visuals are cleared/XFB-only until the WGPU DEVICE MIGRATES to
the gpu_thread (the A1 endgame; lifts all three gates + GATE B + cp-gate + safe-rp). NEXT:
(1) cross-game probes (SAB/PSO/240p), (2) device migration, (3) diagnostic strip (seq/stage/
frozenChunk/aram/ctrl/cw rings + heartbeats), (4) perf to 60fps on the clean baseline.

**PM11 2026-07-22 — PM10's wait-primitive attribution REFUTED by its own fix; the freeze is
un-timestamped and the rig needs sequencing.** The raw-futex sleep replacement (BlockingLoop.h
[dc wait fix] — engine-level memory.atomic.wait 1ms slices on m_running_state, no condvar/clock;
KEPT, harmless and more robust) changed NOTHING: identical freeze. This run's state at freeze:
rglEntry==rglElse==rglPastPull==124,701,731 (last payload COMPLETED all publishes),
sleepPre==sleepPost=75 (not sleeping), rglExited=0 (not exited), cpIntWait=0 cpAtBp=0 (drain gates
OPEN), published distance=32 — yet drain #60 never entered AND the ledger says 93 credited − 59
drained = 1088 outstanding vs the published 32 (mutually inconsistent ⇒ the publishes straddle the
freeze instant with unknown ordering; gate #8 dirty-rig). WHAT'S CERTAIN: the gpu_thread stops
executing the mainloop entirely at some instant T (all its counters freeze together), in a state
that was healthy-spinning (~2M payloads/s), with no sleep, no exit, no blocked publish. NEXT
(rig-first): add a shared monotonic seq (one Atomics cell) stamped into EVERY publish site (GPU
payload, CPU burst, sleep pre/post) so T is ORDERED against the 93 bursts and the last drain; and
publish a gpu_thread liveness tick from OUTSIDE BlockingLoop (e.g. a wrapping for(;;) heartbeat in
RunGpuLoop around m_gpu_mainloop.Run) to separate "thread died/trapped" (worker onerror invisible
to the probe's console capture — also check page 'error' events) from "loop wedged in the switch".
A TRAPPED THREAD (wasm trap in a payload call reached at T, e.g. inside OpcodeDecoder on chunk 60)
now fits best — it explains frozen-everything with open gates and no sleep/exit, and the probe
currently captures no worker-level error events. Also verify the dist-diag values' instant by seq.

**PM10 2026-07-22 — TERMINAL FINDING: the gpu_thread's BlockingLoop WAIT PRIMITIVE dies.**
dist-diag discriminator: same &CPReadWriteDistance both threads (0x12072900), GPU plain load ==
RMW fetch_add(0) read (32/32) ⇒ NO memory/staleness anomaly — the GPU loop simply stopped
ITERATING near credit #59; the CPU then credited 34 more chunks (incl. the finish token, distance
1120) into a dead loop. Loop-exit marker @0x026B331C = 0 ⇒ m_gpu_mainloop.Run NEVER RETURNED: the
thread is suspended inside BlockingLoop STATE_SLEEPING's `m_new_work_event.WaitFor(100ms)` — BOTH
the 100ms self-timeout AND ~34 RunGpu()->Wakeup() notifies fail to rouse it, after ~81 successful
sleep/return cycles (sleep heartbeat 0x026B1BE4/1BE8; ~8s wall — note 81x100ms timeout ≈ 8s).
⇒ Common::Event::WaitFor (std::condition_variable::wait_for -> emscripten futex/clock) hangs
forever on this pthread after early success. FIX CANDIDATES: (1) replace the m_gpu_mainloop idle
wait with a raw SAB-native wait (emscripten_futex_wait / Atomics.wait loop with bounded timeout) —
bypasses condvar+clock entirely; (2) instrument Common/Event WaitFor internals (deadline value,
clock_gettime on that thread pre/post) to catch a frozen/overflowed per-thread clock; (3) test
timeout=0 (plain Wait()) + verifying Set() notify delivery separately. When the loop stays alive,
the finish token decodes -> PE_FINISH -> FinishQueue wakes -> ARAM #11 -> boot proceeds; ALL
downstream blockers (PM4-PM9) funnel through this one primitive.

**PM9 2026-07-22 — THE STALL IS THE FINISH TOKEN; the contradiction is now minimal and exact:**
0x801d45f4 = FinishQueue (symbols) — the main thread sleeps in GXWaitDrawDone; peFrames=0 in EVERY
run (SetFinish never fires); everything else (ARAM #11, overlay, DVD 12, gc) is downstream of that
wait. Ledger (ungated [domino3-real] counters + CTRL ring): gpbAdv=93 gpbEarly=0 — ALL 93 bursts
LINKED and credited (+2976); ctrlRing = six GXInit-era writes ending 0x15 (linked+read-enabled), NO
DL unlink ever (PM8's "34 unlinked" pointer-math story DEAD — it compared cross-run values).
Decoder consumed ~59 chunks then its CPReadWriteDistance loads return 0 (cpDistGpuMax=32) while
~34 credited chunks (containing the finish token) remain — WITH same-address coherence PROVEN for
the fifo's first word (nonceGpuFifo0==nonceCpuFifo0=0x312c40, live). So: plain atomic loads of ONE
field (CPReadWriteDistance) on the gpu_thread read 0 while the EmuThread's fetch_add history says
~1100 — either a stale-load engine anomaly specific to RMW-vs-load pairing, a signal error in the
diag (gate #8: suspect the instrument), or a zeroing store not yet found. NEXT (one run): in the
RunGpuLoop else-branch publish side-by-side {plain load, fetch_add(0) RMW read, &distance} and on
the EmuThread publish {distance, &distance} at each burst — same-window comparison settles
stale-load vs zeroed vs wrong-object in one probe. Then fix at whichever site that names.

**PM8 2026-07-22 — NATIVE TRACE + HARD-STALL PROOF + GUEST-STATE SNAPSHOT (the frontier):**
Native oracle (build-oracle nogui dual-core, [ARAM-DMA] trace): n=1-2 __OSInitAudioSystem 32B tests
(pc 800b5e80/5ec8), n=3-9 __ARChecksize 32B tests (800c67b8..6b9c), n=10 FIRST ARQ chunk 1280B at
ARStartDMA 800c6400, n=11+ 4KB stream (gc=33). OUR 10 completions == native n=1-10 exactly; we die
at the n=10→11 handoff. 258s probe: aramReqN still 10 ⇒ HARD STALL, not crawl. Guest state AT
completion #10 (published from CompleteARAM): __AR_Callback=0x800c706c (=__ARQInterruptServiceRoutine,
correctly registered), __ARQRequestQueueLo/Hi=0 (normal for MP4's synchronous one-at-a-time posts).
⇒ THE BREAK IS INSIDE THE GUEST ISR TAIL: __ARHandler entered (its +0x2c ack executed, ring),
callback pointer valid, yet the owner-callback→thread-wake→next-ARQPostRequest never happens —
~150 plain-code instructions (__ARHandler tail, __ARQInterruptServiceRoutine 0x800C706C size 0xCC,
__ARQServiceQueueLo) executed by OUR JIT fail to produce the wake. NEXT (pick one):
(1) publish __ARQRequestPendingLo (+ Hudson's wait-flag once identified) at completion + at each
VI tick — did the pop/owner-callback happen; (2) re-enable the JIT guest-PC ring across the ISR
window to see exactly where the flow derails; (3) run the conformance harness on the
__ARQInterruptServiceRoutine/__ARQServiceQueueLo blocks vs the DolphinPPCTests oracle (the ISR tail
uses lwz/stw/mtmsr/rfi patterns — a single emitter bug here explains a silent derail).

**ARAM CHAIN FULLY MAPPED 2026-07-22 PM7 (ARAM-filtered DSP_CONTROL write ring + MP4 symbols):**
the 13 ARAM-relevant control writes resolve to: 4x __OSInitAudioSystem init clears (0x800b5e18/
5e98/5ee0/5f34), SetInterruptMask+0x100 enable (0x800b742c), **7x __ARChecksize polled acks**
(0x800c67e0..6bbc — ARInit's size-detect test DMAs, serviced by POLLING not ISR), and **exactly
ONE __ARHandler+0x2c ISR ack** (0x800c6608, val 0x970 = masks ON + ARAM write-1-clear). Ten
completions = 7 checksize + 1 ISR-serviced + 2 that fired during a mask-off window
(maskedAramN=2). The upload dies right after the single __ARHandler run; aramReqN froze at 10.
REMAINING AMBIGUITY (one instrument): the ORDER of the last 3 completions vs the __ARHandler ack —
story A: pending statuses accumulated while masked, __ARHandler's write-1-clear ATE them (its ack
clears ALL pending ARAM statuses, not just its own) -> the wake for those chunks never fires;
story B: ARQ bookkeeping corrupted earlier (checksize-era). DISCRIMINATOR: interleave-sequence ring
(one shared seq counter stamped at每 CompleteARAM and each ARAM-ack write) — if masked completions
precede the 0x970 ack, story A is proven. FIX CANDIDATES: (A) hold GenerateDSPInterrupt(INT_ARAM)
re-assert after ack when completions>acks (make the status level-track outstanding completions —
what real HW effectively does since the serial SDK chain never accumulates), or match native
timing so completions cannot land in init's mask-off window (the checksize test-DMA completion
latency (count/32)*246 vs our JIT's placeholder downcount — cycle-accounting gap, the known
[[native-pc-sampler]] item). Compare __ARChecksize/__ARHandler in ~/gc_refs/dolsdk2001/src/ar/ar.c
before choosing.

**REMAINING (the second blocker, now isolated): ARAM enable clobbered — enARAM=8 < aramComplete=10.**
Two of ten ARAM-DMA completions arrived while DSP_CONTROL's ARAM interrupt-ENABLE was clear
(UpdateInterrupts enable&active census @0x026B2720): they never entered INT_CAUSE_DSP, the guest's
__ARHandler/ARQ callback never serviced them, upload dead at 10/1992. A DSP_CONTROL write between
completions carries a stale/wrong enable image (guest RMW vs completion interleave, or write-path
semantics diverging from dolsdk ar/arq driver expectations). NEXT: ring-log the last N DSP_CONTROL
WRITE values (+pc) around completions #9/#10 to catch the clobbering write; compare semantics with
~/gc_refs/dolsdk2001/src/ar/ (AR/ARQ ack composition) and upstream dolphin's DSP_CONTROL write
handler. Instruments live: aramReqN @0x026B1BD0, aramComplete @0x026B2700 (ungated), enDSP/ARAM/AID
@0x026B271C/20/24 (ungated), mailPopN @0x026B1BB0, dspCauseSet/Clr @0x026B1BC0/1BCC, extDeliv*
@0x026B1BC4/1BC8.

**BOOT STALL RE-CHARACTERIZED 2026-07-22 PM5 — it is the DSP INTERRUPT STORM, not a lost
interrupt (superseded by PM6 above):** new ungated counters (PI INT_CAUSE_DSP sets @0x026B1BC0 / clears @0x026B1BCC in
SetInterrupt; EXT delivery commits @0x026B1BC8 / with-DSP @0x026B1BC4 at the PowerPC.cpp EXT
commit) measured dspCauseSet=147,932 / dspCauseClr=147,931 / extDelivDsp=150,869 in one stalled
run — the guest ISR services DSP ~1.6K/s CONTINUOUSLY while aramReqN stays 10 and gc=0. Delivery
is NOT broken (previous "10th int lost" attribution WRONG; the takeover delivery gates I stripped
in PowerPC.cpp CheckExternalExceptions were dead — strip kept, it's correct bloat removal).
Mechanism (matches the C5 anti-storm note in DSP.cpp Do_ARAM_DMA verbatim: "EXT alternating
OSRestoreInterrupts/aramSyncTransferQueue forever — a new DSP completion always pending before
the guest's rfi lands"): something DSP-side re-raises INT_CAUSE_DSP immediately after every ack
(unconsumed DSP-HLE mailbox state is the prime suspect — MusyX init has mail pending while the
guest is still in the ARAM upload phase and can't consume it); the guest's generic acks
(DSP_CONTROL writes) also clear the ARAM-int status, so the ARQ callback never runs → upload
frozen at 10/1992 DMAs. ALSO: [audio-diag] 743,041 samples/s vs native 32,000 (23x overspeed;
morning runs were 65,890 = 2x) — the audio/DSP cadence is unthrottled in the new topology.
NEXT INSTRUMENT: at each dspCauseSet record the RAISER (DSP_CONTROL int-status bits + HLE
mail-pending flag) and count DSP_MAIL_FROM_DSP LO reads (mail pops) — separates "mail pending,
never popped" from "ARAM/AID re-raise"; then fix at the raiser (native = the guest pops the mail
because init ORDER differs, or our HLE raises early). Also verify DSP_CONTROL write handler ack
semantics vs upstream (generic ack clearing ARAM status it shouldn't).

**BOOT STALL LOCALIZED 2026-07-22 PM4 (native DVD oracle + req/completion counters):** native log
shows reads 1-11 = filesystem/banner, then guest-side overlay start (objman "Call New Ovl 1" →
"Link DLL:dll/bootdll.rel") = read 12. Our guest stalls BEFORE the overlay call (omcurovl=
0xffffffff, never 1) inside MP4's audio/ARAM init: **aramReqN=10 == aramComplete=10** (counters
now ungated: requests @0x026B1BD0 Do_ARAM_DMA, completions @0x026B2700 CompleteARAM) — ten DMAs
requested and completed, GenerateDSPInterrupt(INT_ARAM) called ten times, guest never kicks #11
(native runs ~1992). exc=4 pending in snapshots. THE 10th completion's EXTERNAL_INT never reaches
the guest ISR: the loss is between UpdateException's `Exceptions |= EXTERNAL_INT` and guest ISR
entry (JitWasm dispatch-loop delivery — suspect the idle-spin/hot-region chain not breaking for
pending EXT, or a delivery gate). NEXT: count UpdateException EXT raises vs JitWasm
CheckExceptions-with-EXT deliveries vs guest ISR entries in one run; check guestRetrace liveness
in the SAME run (if VI delivery also dies at the same instant, it's general EXT delivery death,
not DSP-specific). Also landed: [dc device-events] gate (RunGpuLoop pulls AsyncRequests only on
the device thread — presents no longer eaten by the gpu_thread; keep).

**REMAINING boot stall (original notes):** guest parks at apploader with dvdCmdN=11 frozen, peFrames=0 —
DVD command 12 never issues, upstream of all GX (the guest never sends a finish token). Suspects:
the same frame callback's unconditional `CPU().Break()` under __LIBRETRO__ (the `if
(s_stop_frame_step)` guard is compiled out — verify), AsyncRequests events now pulled on the
gpu_thread (device-gated present dropped), or the DVD completion chain. Reproduces identically
every run. Diagnostics to strip when boot lands: sleep-heartbeat (BlockingLoop.h), nonce
(GPFifo.cpp/Fifo.cpp), dcInitDual (Fifo.cpp), + probe fields.

**RESOLVED ATTRIBUTION 2026-07-22 PM2 (nonce run):** the gpu_thread SHARES memory (final proof:
its every else-iteration republishes the CPU's counter; the LAST republish read 0 ⇒ ALL 4,507,641
GPU iterations completed BEFORE the CPU's first gather flush — every "isolation"/zero reading was
a pre-boot snapshot). RunGpuLoop then entered an unbounded, uninstrumented wait inside
BlockingLoop (waitForN=0 — never the timed WaitFor; rglEntry==rglPastPull — not stuck in
PullEvents; no "Video Loop Ended" — never exited) and 93 subsequent RunGpu()→Wakeup() calls never
woke it. PRIME SUSPECT: Fifo::Init gates `m_gpu_mainloop.Prepare()` on IsDualCoreMode() — if the
config wasn't yet dual-core at Init time, the loop ran UNPREPARED and its sleep/wake state machine
is broken exactly like this. NEXT: log IsDualCoreMode() at Fifo::Init; candidate one-line fix =
unconditional Prepare(); else instrument BlockingLoop Wakeup/wait-entry state. Native oracle: the
identical machinery works natively, so the delta is init order or emscripten event primitives.

**Original statement of the bug (superseded attribution — emu-running gate was NOT the blocker):** RunGpuLoop iterates 4,625,501 times and takes the
NOT-RUNNING branch every single time (rglElse==rglEntry) — the gpu_thread observes
`m_emu_running_state` unset — while the CPU side has work queued (cpDistLive=2976, gpfBurst=93,
gpReadEn=1, cpLinkEn=1) and probe emuRunning=1. Guest parks at the apploader (dvdCmdN=11, gc=0,
PC=0x800ba2f0). Candidates: (a) two FifoManager/System instances (publish &m_fifo AND a
write-nonce from BOTH threads in one run to settle it — layout-identical instances make address
equality meaningless); (b) something repeatedly calls EmulatorState(false)/pauses (CPU-step or
pump machinery) so the flag is truly unset at every GPU-thread read. NOTE the probe's emuRunning
field must be checked for WHERE it's published — the 2026-07-21 "distance=0 = memory isolation"
claim died exactly because cpDistGpu is only published INSIDE the never-entered drain loop
(0 = never-published, not loaded-zero). Verify every diagnostic's publish site before trusting it.

## A1 experiment result (2026-07-22, ?gputhread=1 — flag SAB 0x026B0AF0, default OFF)

MP4 probe with `PROBE_QUERY="gputhread=1"`: **fifoAddrGpu == fifoAddrCpu == 0x120728f0** — the
gpu_thread publishes through the SAME shared memory the probe reads ⇒ the "memory-isolated
gpu_thread" neuter rationale is REFUTED (a private instance's SAB writes could never be visible).
rglEntry=4,621,008 (RunGpuLoop live, busy-spinning), rglDrain=0, cpDistGpu=0 — but the GUEST stalls
at boot (gc=0, frames=0, PC=0x800ba2f0 idle spin): with DrainFifoOnCpuThread off, some boot
dependency the proxy-main drain was carrying is missing (suspects: ViSwap/present chain feeding the
page, SafeCPReadPointer/SyncGPU interplay at the apploader). NEXT: find that dependency and make
boot complete in gputhread mode; then move the WGPU device to the gpu_thread; then delete
DrainFifoOnCpuThread + cp-gate + safe-rp + the RunGpuLoop busy-spin (GpuMaySleep wiring).

## Order

1. B (mechanical, zero live-path behavior risk) — then a clean baseline probe.
2. A3 (largest bloat mass; per-piece dead-path verification via the existing counters).
3. A1+A2 (decode = RunGpuLoop-exact on the device thread) — then delete C's compensations.
4. A4+A5 cleanup.

Acceptance per step: canonical 3-step loop, MP4 + SAB probes, zero popups, frames climbing, no new
faces. Open functional items tracked alongside: MP4 post-menu texture garbage (WGPUTextureCache
CopyEFB empty / depth-copy skip — one-shot '[wgpu]' console prints identify which fires in the
corrupted scene), 240pSuite renders nothing (PC 0x80009374, libogc path).
