# Item 7 — CoreTiming + event queue moved into ppc-worker (design)

**Status:** design + minimal-risk infrastructure stub. The shared-SAB event queue is **specified but not yet populated** under this item; ppc-worker gains a pure-PPC event dispatch path it can use once dolphin pushes entries. Dolphin's existing `m_event_queue` and `Advance()` keep running unchanged. The cutover (moving live entries into the shared queue, retiring `Advance()` for pure-PPC events) is gated under a future phase.

## 1. The core architectural wrinkle

ppc-worker (Phase 2g and onward, see `ppc_worker_2e4_to_2g.md`) drives the PPC inner loop directly out of shared SAB state. The exit reasons today are:

- `stop-flag` — page/dolphin asked ppc-worker to yield via `SAB[0x02500000]`.
- `exception-pending` — `ppc_state.Exceptions` is non-zero and either MSR.EE allows it or a non-external exception is pending.
- `downcount-exhausted` — `ppc_state.downcount` reached zero.
- `idle-skip` — same-PC dispatch ≥100 times in a row.
- `wall-time-cap` — perf-measurement cap.

Of those, **`downcount-exhausted` is the hot exit**. It is the path through which CoreTiming events get serviced. Each exit walks: ppc-worker → page → `postMessage` → dolphin's pthread → `CoreTiming::Advance()` → fires `m_event_queue` heads → reschedules itself → `ppc_state.downcount = slice_length` → returns control. Every round-trip kills V8's inlining of the inner loop because the dispatch function returns and is re-entered (Liftoff was about to tier up; the small-lifespan reset throws away that work — directly the case made in `ppc_exterior_worker_2026_05_05.md`).

Today: ppc-worker exits, dolphin advances events, ppc-worker resumes. There is no architectural reason most events must traverse a worker boundary — many event callbacks (`DecrementerCallback`, `PatchEngineCallback` in non-fired branches, scheduler-self-reschedule for `DSPCallback` cadence-only) mutate state that already lives in shared SAB. The two-worker round-trip is pure cost for those.

The goal is therefore **not** "move CoreTiming wholesale into ppc-worker" — that would force GPU/DVD/audio events onto the wrong thread. The goal is to **split events by who needs to service them**, run the pure-PPC ones in ppc-worker, and signal dolphin asynchronously when it has work.

## 2. Event categorization

Walked all `RegisterEvent` call sites under `gamecube/dolphin-src/Source/Core/Core/`. Categories:

### 2a. Pure-PPC events (handler only mutates `ppc_state` / SAB-mapped state)

These can run entirely in ppc-worker. Their callback bodies do not touch dolphin's C++ data structures (VI internal state, DSP::DMAState, DI::CommandState, etc.).

| Event | Registered in | Callback effect |
|---|---|---|
| `DecCallback` | `SystemTimers.cpp:284` | sets `ppc_state.spr[SPR_DEC]=0xFFFFFFFF` + ORs `EXCEPTION_DECREMENTER` into `ppc_state.Exceptions`. Pure SAB-state mutation. |

That is the entire list. Every other `RegisterEvent` callback touches dolphin-side device state.

### 2b. Hybrid: scheduler-cadence events whose handler is owned by dolphin but whose **rescheduling** is pure timer arithmetic

These are events that re-`ScheduleEvent` themselves on a fixed period. ppc-worker can fire the cadence (advance `global_timer`, observe queue head, treat the event as "consumed" for cadence purposes) and signal dolphin asynchronously when the side-effect callback actually needs to run. In effect, the queue ENTRY moves into ppc-worker's view but the CALLBACK still runs on dolphin's pthread — coupled by a flag in SAB that dolphin polls in its outer Run() loop.

| Event | Registered in | Side-effect target |
|---|---|---|
| `VICallback` | `SystemTimers.cpp:285` | `VideoInterface::Update` — half-line tick, drives XFB present, raises VI IRQ. Side-effect: dolphin (page) → GPU worker. |
| `DSPCallback` | `SystemTimers.cpp:286` | `DSP::UpdateDSPSlice` — DSP-HLE rate clocking. Side-effect: dolphin/audio worklet. |
| `AudioDMACallback` | `SystemTimers.cpp:287` | `DSP::UpdateAudioDMA` — pushes 32-byte PCM to mixer. Side-effect: audio worklet. |
| `AICallback` | `AudioInterface.cpp:204` | sample-rate clocking + IRQ. Side-effect: audio worklet. |
| `GPUSleeper` | `SystemTimers.cpp:290` | `Fifo::GpuMaySleep` — hint, no IRQ. Pure no-op on most ticks. |
| `PatchEngine` | `SystemTimers.cpp:291` | `PatchEngine::ApplyFramePatches` — once per VI field; touches MEM1 (already in SAB). |

### 2c. Hardware-completion events (handler must run on dolphin)

These are scheduled by HW side-effect writes (DI command kickoff, AR DMA, SI transfer, EXI transfer). The handler walks dolphin's device state and raises an IRQ via `ProcessorInterface`. ppc-worker has no model of these devices.

| Event | Registered in | Trigger |
|---|---|---|
| `FinishReadDVDThread` | `DVDThread.cpp:46` | DVD read completion. |
| `FinishExecutingCommand` | `DVDInterface.cpp:291` | DVD command completion. |
| `AutoChangeDisc`, `EjectDisc`, `InsertDisc` | `DVDInterface.cpp:286-288` | Disc-swap UI. |
| `DSPint` | `DSP.cpp:128` | DSP IRQ pulse. |
| `ARAMint` | `DSP.cpp:129` | ARAM DMA completion. |
| `EXIUpdateInterrupts`, `ChangeEXIDevice` | `EXI.cpp:160-162` | EXI transfer/IRQ. |
| `SITransferPending`, `SIEventChannel{0..3}` | `SI.cpp:241-253` | SI transfer completion. |
| `EXI_DeviceMemoryCard::s_et_cmd_done` etc. | `EXI_DeviceMemoryCard.cpp:91-93` | Memcard I/O. |
| `IPCInterrupt` | `WII_IPC.cpp:117` | Wii IPC (not used on GC titles). |
| `ToggleResetButton`, `IOSNotify*` | `ProcessorInterface.cpp:65-69` | UI-level reset/power. |
| `IPC_HLE_UpdateCallback` | `SystemTimers.cpp:289` | Wii IPC tick. |

These STAY in dolphin's `m_event_queue`. ppc-worker is unaware of them.

### 2d. The fourth category: ppc-worker-INITIATED scheduling

Some guest-code paths cause an event to be scheduled (e.g. `mtspr DEC` calls `SystemTimersManager::DecrementerSet` which calls `core_timing.RemoveEvent` + `ScheduleEvent`). When that code runs inside ppc-worker as JIT'd block, it cannot reach `CoreTimingManager::ScheduleEvent` directly. Two options: (a) it bounces through the mailbox to dolphin; (b) the schedule goes into the shared queue directly. (b) is correct only for the pure-PPC `DecCallback` event. The proposed split makes this clean: `DEC` is a pure-PPC event, and its scheduling happens by writing the shared queue, which ppc-worker can do without a round-trip.

## 3. SAB layout for the shared event queue

Following the pattern already in `sab_layout.h`. New region at `0x02680000` (immediately after the Stage-2 MMIO classification reserve at `0x02670000`; doesn't collide with mirror at `0x02600000`, cls tables at `0x02640000`/`0x02660000`, PowerPCState at `0x02400000`, mailbox at `0x02000000`, scratch at `0x02100000`, or stop-flag at `0x02500000`).

```
0x02680000 + 0x00     u64   ct_global_timer            (ppc-worker writer; dolphin observer)
0x02680000 + 0x08     u32   ct_slice_length            (page-sized; either side may set during Advance handoff)
0x02680000 + 0x0C     u32   ct_event_seq               (seqlock counter; even=stable)
0x02680000 + 0x10     u32   ct_event_count             (number of valid records below)
0x02680000 + 0x20     u32   ct_dolphin_pending_mask    (bitset; ppc sets bits when a hybrid event "fired" and dolphin must service its side-effect)
0x02680000 + 0x24     u32   ct_ppc_pending_schedule    (counter; bumped by dolphin when it pushes a new entry it wants ppc to see immediately — forces ppc to re-sort on next iter)
0x02680000 + 0x28     u32   ct_writer_owner            (0 = idle, 1 = ppc, 2 = dolphin — coarse arbitration for queue mutation; reads always free)
0x02680000 + 0x80     records[256] of CtEventRecord (24 B each → 6 KB)
```

`CtEventRecord`:

```
struct CtEventRecord {
    s64 time;            // absolute sim time (cycles)
    u32 event_type_id;   // small integer ID; see registry below
    u32 userdata_lo;
    u32 userdata_hi;
    u32 flags;           // bit 0 = pure-ppc, bit 1 = hybrid (dolphin side-effect), bit 2 = entry valid, bit 3 = removed (tombstone)
};
```

Total `0x02680000 .. 0x02681900` ≈ 6.5 KB. Plenty of headroom; capacity 256 outstrips typical Dolphin `m_event_queue` size (≈ 6-8 entries live in steady state).

The queue is NOT kept sorted in-place. ppc-worker walks the records linearly each tick (256 × 24 B = 6 KB → fits L1; one cache line per few records). It tracks the minimum `time` over valid non-tombstoned entries; on `global_timer >= min_time`, fires.

Why not a heap? Because heap mutation is hard under concurrent reads. Linear walk + seqlock guard is dead-simple, and 256 entries × constant work per tick is cheaper than a single mailbox round-trip.

### 3a. Event-type registry

A fixed small enum, mirrored on both sides, baked at build time:

```
enum CtEventTypeId : u32 {
    CT_EV_NONE              = 0,
    CT_EV_DECREMENTER       = 1,  // pure-PPC
    CT_EV_VI                = 2,  // hybrid
    CT_EV_DSP               = 3,  // hybrid
    CT_EV_AUDIO_DMA         = 4,  // hybrid
    CT_EV_AI                = 5,  // hybrid
    CT_EV_GPU_SLEEPER       = 6,  // hybrid (no-op IRQ-wise; cheap on ppc side)
    CT_EV_PATCH_ENGINE      = 7,  // hybrid
    // Hardware-completion events live in dolphin's local queue ONLY;
    // they are NOT mirrored into the shared queue. Dolphin's Advance()
    // still services them.
    CT_EV_DOLPHIN_OPAQUE    = 64, // sentinel meaning "ppc must not interpret"
};
```

ppc-worker only acts on `event_type_id < 64`. Anything `>= 64` is treated as opaque-to-ppc and only useful for sim-time ordering (it isn't put in the shared queue at all in the initial design — see §4d for the alternative).

## 4. Atomicity protocol

### 4a. Queue mutation: single-writer seqlock

The seqlock primitive at `gamecube/seqlock.js` (and its 19/19-pass spec) is the model. Adapted: writes happen across multiple `CtEventRecord` slots, so the seqlock guards the whole records array, not just one record.

Writer protocol (mutation = insert, remove, or remove-all):
1. CAS `ct_writer_owner` from 0 to my-id (ppc=1, dolphin=2). On failure, spin briefly then yield (back to compile path / Advance respectively). The slow path is fine — mutations are rare relative to ticks.
2. `Atomics.add(ct_event_seq, +1)` → odd.
3. Mutate records[].
4. `Atomics.store(ct_event_count, new_count)`.
5. `Atomics.add(ct_event_seq, +1)` → even.
6. Store `ct_writer_owner = 0`.

Reader protocol (used inside the ppc-worker inner loop's tick check):
1. `s0 = Atomics.load(ct_event_seq)`. If odd, skip this tick (try again next).
2. Find minimum `time` across valid entries.
3. `s1 = Atomics.load(ct_event_seq)`. If `s1 != s0`, skip this tick.
4. On `global_timer >= min_time`, fire (see §4b).

Skipping a tick is safe: `global_timer` only monotonically advances; the next iter will retry.

### 4b. Firing a pure-PPC event

When ppc-worker observes `global_timer >= records[i].time` AND `records[i].event_type_id == CT_EV_DECREMENTER` AND `records[i].flags & FLAG_PURE_PPC`:

1. Tombstone the record (write `flags |= FLAG_REMOVED`) WITHOUT acquiring the writer lock. The seqlock isn't needed for a single-word tombstone if dolphin's reader is tolerant of seeing stale entries (it is — dolphin's `Advance()` walks the queue and matches by `event_type_id`, so seeing a tombstoned entry just makes it skip).

   Actually: to keep the protocol clean, tombstone IS a mutation and DOES go through the seqlock. Acceptable cost; happens ~once per 41 666 ticks (DEC fires at most once per HW DEC value).

2. Apply the callback effect directly:
   ```cpp
   ppc_state.spr[SPR_DEC] = 0xFFFFFFFF;
   __atomic_or_fetch(&ppc_state.Exceptions, EXCEPTION_DECREMENTER, __ATOMIC_RELEASE);
   ```
3. Continue dispatching. No exit, no postMessage, no round-trip.

### 4c. Firing a hybrid event

For `CT_EV_VI` etc., ppc-worker:

1. Reschedules its own copy (the cadence is fixed and known: VI = ticks-per-half-line, DSP = `DSP_UpdateRate()`, etc.). Cadence values are written by dolphin into a small `ct_cadence[8]` array at queue init.
2. Sets the corresponding bit in `ct_dolphin_pending_mask`.
3. Does NOT exit. Continues dispatching.
4. Dolphin's outer Run() loop polls `ct_dolphin_pending_mask` (it already polls `SAB[0x02500000]` every 4096 iters — same heartbeat). On non-zero, it clears matching bits and invokes the corresponding C++ callback (`VICallback`, `DSPCallback`, etc.). The callback runs in dolphin's context, so it can touch VI/DSP/AI state and post to GPU/audio workers as it does today.

Latency: ~1 ms at the current 4096-iter heartbeat, which is < 1 VI half-line at any realistic emulated rate. For audio cadence (32 KHz → 31 µs per sample-pair), 1 ms is ~32 samples. That is at the edge of what the audio worklet's jitter buffer absorbs; if it pops in practice, the heartbeat shortens or dolphin's polling moves to a dedicated `MessagePort` channel.

### 4d. Dolphin pushes a hardware-completion event

When guest code (running in ppc-worker) does a write to e.g. DI_CMD that schedules `FinishExecutingCommand` ticks-in-future: today that write traverses the MMIO mailbox → dolphin → `DVDInterface::FinishExecutingCommand` → `ScheduleEvent`. With the design here, that path is **unchanged**. Dolphin pushes hardware-completion events into its OWN local queue (the existing `m_event_queue`), not the shared queue. The shared queue holds only categories 2a and 2b. Dolphin's `Advance()` still runs (less often — only when its local queue has work due) and fires those.

The two queues coexist. `ct_global_timer` is the canonical sim time; dolphin reads it from SAB at the top of `Advance()` and processes any local-queue entries due by then.

### 4e. Order between the two queues

A hardware-completion event in dolphin's local queue may need to fire before a pure-PPC event in the shared queue (or vice versa). Easiest invariant: dolphin's `Advance()` runs whenever (a) its local queue head is due OR (b) `ct_dolphin_pending_mask != 0` OR (c) every ≥ N ms regardless (safety floor). Within Advance(), the pure-PPC event callbacks in the shared queue are NOT re-fired — they've already run in ppc-worker. Dolphin's queue is processed by `m_globals.global_timer`, which mirrors `ct_global_timer`. Correctness is preserved as long as ppc-worker fires pure-PPC events at their scheduled time AND dolphin sees the resulting state (already true: PowerPCState lives in shared SAB).

The corner case is ordering between a pure-PPC and a hardware-completion event scheduled for the same cycle, when the hw one would have raised an exception that the pure-PPC one observes. That's vanishingly rare; resolution = dolphin's polling cadence is short enough that it never lags pure-PPC firing by more than the heartbeat. We accept the ordering slip; it's bounded.

## 5. Implementation phases

Phases I → V; each ships independently. Acceptance bar at each phase: `?ppcdispatch=1` cascade tests pass, SAB boot reaches the same milestone it does today (frames ≥ current baseline), perf measurement either improves or holds steady (no regression).

### Phase I — SAB layout + queue plumbing (LOW RISK; INFRASTRUCTURE-ONLY)

**This phase ships under item 7 alongside the design doc.** Lays the SAB region, defines the C++ struct, exports stub queue read/write helpers in ppc-worker. No event actually moves yet — dolphin keeps using its local queue, ppc-worker's run-continuous loop is unchanged.

Concrete files touched:
- `gamecube/ppc-worker/sab_layout.h` — add `CT_QUEUE_*` constants and `CtEventRecord` struct.
- `gamecube/ppc-worker/ppc_worker_main.cpp` — add `ppc_worker_ct_queue_init()` (zeroes header + writes magic), `ppc_worker_ct_queue_dump(buf)` (diag), `ppc_worker_ct_fire_due_pure(now_lo, now_hi)` returning the count of pure-PPC events fired this call (stub: returns 0 since queue is empty).
- No changes to dolphin or `ppc_worker.js` yet.

Verification: WASM builds, no behavior change, `Module._ppc_worker_ct_queue_init()` callable, `Module._ppc_worker_ct_fire_due_pure(0,0)` returns 0.

### Phase II — Mirror `DecCallback` into the shared queue

Dolphin keeps registering `DecCallback` AND additionally publishes its scheduled times into the shared queue (one entry of type `CT_EV_DECREMENTER`). ppc-worker's inner loop polls; on due, fires the callback effect locally AND signals dolphin to remove the duplicate from its local queue (or dolphin matches by `event_type_id` on `Advance()` and skips the entry seeing it already tombstoned).

Risk: dolphin's `RemoveEvent` / `ScheduleEvent` calls run from C++ contexts that don't expect a parallel writer. We need dolphin's `SystemTimersManager::DecrementerSet` to publish through the new shared-queue API (which uses the seqlock). One-call-site change; the existing call already serializes against the JIT (CPU thread).

Phase II measurable win: `DEC`-driven scheduler wakes no longer cause ppc-worker to exit and round-trip. Current SAB-boot trace shows DEC firing a handful of times per second; the win is small in absolute count but high-leverage because DEC interrupts are *exactly* the kind of event that breaks the inner loop's V8 tier-up sequence.

### Phase III — Mirror hybrid events (VI/DSP/AI/AudioDMA/etc.)

For each event in category 2b, dolphin publishes its `ScheduleEvent` calls into the shared queue. ppc-worker fires the cadence locally (just reschedule) AND sets the corresponding bit in `ct_dolphin_pending_mask`. Dolphin's Run() loop polls the mask in its heartbeat block (already polls `SAB[0x02500000]`; co-locate). On bit set: clear bit, call the existing C++ callback.

Risk: cadence drift between the dolphin-side queue and the shared queue if the two get out of sync. Mitigation: dolphin stops scheduling these events into its local queue once Phase III ships; the shared queue is canonical for them. Behind a build flag `BEMENTAL_SHARED_CT_EVENTS=1` so Phase III can be reverted.

### Phase IV — Cadence values + clock-rate handoff

The cadence numbers (VI ticks-per-half-line, DSP rate, AI rate) are computed by dolphin from config + HW state. Move them into the `ct_cadence[8]` SAB array on init/clock-change. ppc-worker reads them when rescheduling a hybrid event. No behavior change for fixed-clock workloads; this is preparation for `ChangePPCClock` and overclocking.

### Phase V — Retire `Advance()` for pure-PPC events

Dolphin's `Advance()` stops processing the now-shared-queue events. Its local queue holds only hardware-completion events. `global_timer` is still advanced by Dolphin (because dolphin owns `slice_length`) — but the only places that mutate the shared queue based on `global_timer` are ppc-worker (firing pure/hybrid) and the side-effect callbacks (rescheduling themselves). At this point, dolphin's `Run()` outer loop runs **only** to (a) service hardware-completion events and (b) drain the `ct_dolphin_pending_mask`. PPC dispatch lives entirely in ppc-worker.

## 6. What ships in this commit (item 7)

- This design doc.
- **Phase I infrastructure stub** (only):
  - `gamecube/ppc-worker/sab_layout.h` gains the `CT_QUEUE_*` constants, `CtEventRecord` struct, and `CtEventTypeId` enum.
  - `gamecube/ppc-worker/ppc_worker_main.cpp` gains `ppc_worker_ct_queue_init`, `ppc_worker_ct_queue_count`, `ppc_worker_ct_fire_due_pure(now_lo, now_hi)`, and a private `fire_pure_decrementer` helper that applies the DEC callback effect to PowerPCState in SAB.
- No changes to dolphin or `ppc_worker.js`. Build verification only.

## 7. Non-goals

- Not moving GPU/DVD/audio events. The existing dolphin/page route stays.
- Not changing the seqlock semantics. Reusing the existing `seqlock.js` shape.
- Not opening a new postMessage channel. The dolphin-side polling reuses the existing 4096-iter heartbeat.
- Not changing CoreTiming throttling. Wall-clock throttling stays in `CoreTimingManager::Throttle`; the design here is about who fires events, not who paces them.

## 8. Open question deferred to Phase II

`DecCallback` writes `ppc_state.Exceptions` with EXCEPTION_DECREMENTER. ppc-worker's inner loop already polls `Exceptions` and exits on non-zero with EE set. So even after Phase II, a DEC fire causes an inner-loop exit when the guest re-enables interrupts — that's correct and desirable. The point of moving DEC into ppc-worker isn't to avoid the exit at exception delivery; it's to avoid the exit at the **cadence boundary** (every `decValue * TIMER_RATIO` cycles), which today exits even when MSR.EE is clear and no exception will be delivered.
