# Guest OS context switching in the SAB static recompiler — SOLVED, with a witness

Measured 2026-09-04, machine load 2.29–2.63 throughout. Reproduce with:

```bash
bash gamecube/recomp/sr/build_ctxsw.sh "gamecube/roms/Sonic Adventure 2 - Battle (USA).iso"
SR_OUT=/tmp/sr_ctxsw_trace SR_TRACE_BUILD=1 bash gamecube/recomp/sr/build_ctxsw.sh /tmp/sr_ctxsw/main.dol
node gamecube/recomp/sr/verify_ctxsw.mjs /tmp/sr_ctxsw /tmp/sr_ctxsw_trace
```

**Result: 63 passed, 0 failed.** A guest thread switch really happens — thread A calls
the translated `OSSleepThread`, control crosses to a second host thread that runs the
translated `OSWakeupThread`, and A resumes *inside* `SelectThread` with its
callee-saved registers intact and `OSSleepThread` returning normally.

| | evidence |
|---|---|
| the switch happens | §6, trace of 17 host-boundary events, two `HANDOFF`s, two distinct host thread ids |
| it is not nesting in disguise | §6a, a three-thread **non-LIFO rotation** A→B→C→A that resumes A while B is still parked — three distinct host threads |
| the host layer is bit-exact with the shipped code | §5, three non-switching paths + the switch frozen at the `rfi`: identical `GekkoState` **and** identical FNV-1a over all 24 MB of MEM1 |
| the host layer is load-bearing | §5 control arm D: with `sr_os_mode(0)` the same run faults at exactly `0xe00e78ac`, the fault recorded in `docs/static-recomp-sab/README.md` §8.1d |
| cost to the translated code | §8 — no Asyncify, no SjLj, no JSPI, no instrumentation of any translated body |

---

## 1. What `0xe00e78ac` actually is (it is NOT the locked cache)

`docs/static-recomp-sab/README.md` §8.1d records `SKIP 0x800f13a8 faults 0xe00e78ac`
(grep for the string — that file is being edited concurrently, so a line number goes
stale; it was line 1252 at HEAD `b37ee217`).
The `0xE0…` prefix invites the reading "Gekko locked L1 cache" (`0xE0000000`, which
`gekko_rt.h:61` does model as an unmapped region). **It is not that.** It is
`sr_extern`'s fault *encoding*, `sr_driver.c:52`:

```c
if (!g_fault) g_fault = 0xE0000000u | (addr & 0x00FFFFFFu);
```

so `0xE0000000 | (0x800e78ac & 0x00FFFFFF)` = `0xE0000000 | 0x0E78AC` = **`0xE00E78AC`**,
and the callee it names is `0x800e78ac`. That address is `OSDisableInterrupts`
(`docs/static-recomp-sab/os_boundary.txt:33`, 20 B, 212 direct `bl` sites). The
identification is now byte-exact, not by name: the shipped words are

```
0x800e78ac  7c6000a6   mfmsr  r3
0x800e78b0  5464045e   rlwinm r4, r3, 0, 17, 15      ; clear MSR[EE]
0x800e78b4  7c800124   mtmsr  r4
0x800e78b8  54638ffe   rlwinm r3, r3, 17, 31, 31     ; return the old EE
0x800e78bc  4e800020   blr
```

which is `~/gc_refs/dolsdk2001/src/os/OSInterrupt.c:81-91` instruction for
instruction. Test **D** in `verify_ctxsw.mjs` asserts both the value and the
decomposition, so this cannot be re-confused later.

> **For the sibling agent who owns `0xE00000xx` / `0xCC008000`:** this fault is in
> your address *family* but not your problem. It is a fault code, not a memory
> access; no locked-cache read is involved. Nothing to hand off.

## 2. The blocker, stated precisely — and why §6's proposed cut is impossible

`docs/static-recomp-sab/README.md` §6 concluded (now marked superseded there):

> "Only the setjmp/longjmp primitives `OSSaveContext` and `OSLoadContext` are the
> host boundary. That is two functions to host-implement, not a rewrite of the
> guest OS."

**That cut cannot be implemented, and the reason is structural.** `OSSaveContext` is
a `setjmp`: it returns **twice** — 0 when saving, 1 when resumed. `sr.py` emits a
guest call as a host call (`sr.py:202`, `sr_extern`/`fn_{tgt:08x}(st);` at `sr.py:205`), so a host-implemented
`OSSaveContext` is an ordinary C function whose frame is **gone** the moment it
returns the first time. There is nothing left to `longjmp` back into.

This is not an argument, it is measured. A spike with the exact shape of the
proposed design — `save()` does `setjmp`, returns; the guest runs two more frames;
`load()` does `longjmp` — was built twice:

| toolchain arm | result |
|---|---|
| emcc default (`-sSUPPORT_LONGJMP=emscripten`) | `throw Infinity` escapes the module |
| `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` | `Exception [WebAssembly.Exception] {}` escapes the module |

Both are correct behaviour: the `jmp_buf`'s frame is dead, which is undefined
behaviour in C and an uncaught unwind in wasm. The three mechanisms
README §6 lists — Asyncify, one host thread per guest thread, JSPI — are therefore
**not three ways to implement that cut**; two of them (Asyncify, JSPI) are ways to
make a host stack switchable, and only they could implement it. The third does
something else, which is the answer below.

## 3. The host boundary, recovered from the shipped bytes

Nine guest functions, all verified word-for-word against `~/gc_refs/dolsdk2001`:

| guest | size | DOLSDK | role |
|---|---|---|---|
| `0x800e78ac` `OSDisableInterrupts` | 20 B | `OSInterrupt.c:81` | MSR[EE] |
| `0x800e78c0` `OSEnableInterrupts` | 20 B | `OSInterrupt.c:93` | MSR[EE] |
| `0x800e78d4` `OSRestoreInterrupts` | 36 B | `OSInterrupt.c:105` | MSR[EE] |
| `0x800e55d4` `OSSetCurrentContext` | 92 B | `OSContext.c:200` | `__OSCurrentContext`, MSR[FP] |
| `0x800e5630` `OSGetCurrentContext` | 12 B | `OSContext.c:236` | reads `0x800000d4` |
| `0x800e579c` `OSClearContext` | 36 B | `OSContext.c:390` | `mode`/`state` = 0 |
| `0x800e563c` `OSSaveContext` | 128 B | `OSContext.c:240` | **the setjmp** |
| `0x800e56bc` `OSLoadContext` | 216 B | `OSContext.c:281` | **the longjmp (`rfi`)** |
| `0x800ebd68` `SelectThread` | 512 B | `OSThread.c:325` | **the cut** |

`0x800e56bc` was "suspected `OSLoadContext`, adjacent to `OSSaveContext`, ends in
`rfi`" in `os_boundary.txt:276`; that identification is now byte-exact, because the
shipped code carries the Restartable-Atomic-Sequence fixup verbatim and its two
bounds are literal addresses:

```
0x800e56bc  3c80800e  lis   r4, 0x800e
0x800e56c0  80c30198  lwz   r6, 0x198(r3)       ; srr0
0x800e56c4  38a478ac  addi  r5, r4, 0x78ac      ; __RAS_OSDisableInterrupts_begin
0x800e56c8  7c062840  cmplw r6, r5
0x800e56cc  41800018  blt   _notInRAS
0x800e56d0  3c80800e  lis   r4, 0x800e
0x800e56d4  380478bc  addi  r0, r4, 0x78bc      ; __RAS_OSDisableInterrupts_end
…
0x800e5790  4c000064  rfi
```

`0x800e78ac` / `0x800e78bc` are exactly `OSDisableInterrupts`' first and last
instruction, matching `OSContext.c:284-296`. **The RAS window is the same function
that produced the `0xe00e78ac` fault** — the two ends of this problem are the same
20 bytes.

The r13-relative and absolute globals were read off the translated code rather than
guessed; each constant in `sr_host_os.h` carries the instruction that materialises it
(`RunQueue` = `0x802babb8`, `__gCurrentThread` = `0x800000e4`,
`__OSCurrentContext` = `0x800000d4`, `RunQueueBits/Hint/Reschedule` at
`r13-0x75E0/-0x75DC/-0x75D8`).

**`OSYieldThread` is not linked into SAB.** All eight `bl SelectThread` sites in the
DOL are preceded by `li r3,0` — every one is an inlined `__OSReschedule`, so
`yield` is 0 everywhere in the shipped game and the yield arm of `SelectThread` is
dead code in this binary.

## 4. The answer: cut at `SelectThread`, one host thread per guest thread

`SelectThread` is the **only** function that contains both the save and the load
(`os_boundary.txt:272-283`: `OSSaveContext` has exactly one `bl` site, `0x800ebe68`,
inside `SelectThread`; `OSLoadContext` has nine, one of which, `0x800ebf48`, is also
inside `SelectThread` — the other eight are exception-return paths). Cutting there
makes the park point and the resume point **the same host C frame**:

```
host_select_thread(st)                      ← one C frame, one host thread
   … DOLSDK scheduler algorithm on the real guest structs in MEM1 …
   ctx_save(A)                              ← the OSSaveContext field stores
   … pick next …
   ctx_load(B); snapshot(); post(slot_of_B); park(self)      ← the switch
   ─────────── parked; another host thread runs B ───────────
   ctx_load(A); goto L_800ebe6c             ← where the hardware's rfi lands
```

Resuming is a plain return from `pthread_cond_timedwait`. **No stack is ever
switched, captured, or unwound.** That is why the design needs no Asyncify, no
`-sSUPPORT_LONGJMP`, and no JSPI.

The resume target is exact rather than approximated: `OSSaveContext` stores
`srr0 = lr` and `gpr[3] = 1`, so hardware's `rfi` lands at the return address of
`bl OSSaveContext` (`0x800ebe6c`) with `r3 = 1`, and the two instructions there are
`cmplwi r3,0; beq` → `li r3,0` → epilogue. **A `SelectThread` that returns NULL after
the round trip is bit-exact with the machine**, and `goto L_800ebe6c` reproduces it
literally. Test C asserts the saved `srr0` is `0x800ebe6c` and the stamped
`gpr[3]` is 1.

### Why not the alternatives

| option | verdict |
|---|---|
| host-implement `OSSaveContext`/`OSLoadContext` only (README §6) | **impossible** — §2, measured twice |
| Asyncify fibers (`emscripten_fiber_swap`) | instruments the whole call graph; §8 of the SAB README measures translated-code throughput at 0.50–0.54x and this would be spent against it |
| JSPI | same objection plus availability; unnecessary once the cut moves up |
| one host thread per guest thread, cut at `SelectThread` | **chosen and built** — zero instrumentation of translated code |

This is N64Recomp's deletion (`~/gc_refs/N64Recomp/README.md:32`, "skip
recompilation of specific functions") applied at the smallest possible cut. N64Recomp
deletes the whole guest scheduler because libultra is HLE'd wholesale; here **one**
guest function is replaced, and `OSCreateThread`, `OSExitThread`, `OSCancelThread`,
`OSJoinThread`, `OSResumeThread`, `OSSleepThread`, `OSWakeupThread`,
`OSSetThreadPriority`, `__OSReschedule`, the mutexes and the message queues all stay
translated and keep operating on the real guest structures.

**The pthreads cost the brief warned about does not apply.** It was recorded as
N64Recomp's cost because the N64 page deliberately has no SharedArrayBuffer.
`gamecube.html:8` loads `/coi-serviceworker.js`, and `lib/capability.js` gates Start
on a *functional* SAB, so the GameCube page already has what this needs. Verified
here by execution rather than by reading the tag: the build in `build_ctxsw.sh` is
`-pthread`, and test C reports two different `pthread_self()` values for the two
guest threads.

## 5. How it was verified

`verify_ctxsw.mjs` runs four things. **A and B use the TRANSLATED shipped
`SelectThread` as the oracle for the host one** — `SR_TRACE_BUILD=1` keeps
`0x800ebd68` in the emitted set and host-implements only the context primitives, so
the two builds differ in exactly one function.

- **A — paths where `SelectThread` returns** (3 scenarios: `Reschedule > 0`,
  `currentContext != currentThread`, `yield=0` with no better priority). Exit
  `GekkoState`, MSR and a full FNV-1a over MEM1 must match. 12/12.
- **B — the switch.** It cannot be compared by exit state, because on the machine
  `SelectThread` never returns from it. Both builds are frozen at the instant
  `OSLoadContext` has loaded the next thread and is about to `rfi`, and the frozen
  machines are diffed. `snapshot GekkoState identical`, `snapshot MEM1 identical`,
  `pc == 0x800ec97c`. 5/5.
- **C — the witness**, §6. 29/29.
- **E — a three-thread rotation**, §6a. 15/15.
- **D — the control arm.** Same run, `sr_os_mode(0)`: **`0xe00e78ac`**. Without this
  the pass proves nothing about the host layer being load-bearing. 2/2.

## 6. The witness

A textbook DOLSDK cooperative round trip, in translated guest code on both sides.
Thread A (priority 8) is RUNNING; thread B (priority 16) is READY on `RunQueue[16]`.
The harness calls the translated `OSSleepThread(&q)` at `0x800ec890`:

```
  0  DISABLE_IRQ    a=0x00000001 b=0x00001032      OSSleepThread's bracket
  1  SELECT_ENTER   a=0x00000000 b=0x80300000      yield=0, current = A
  2  GET_CTX        a=0x80300000
  3  SELECT_SAVE    a=0x80300000 b=0x800ebe6c      A's continuation; srr0 = the bl return
  4  SET_CTX        a=0x80301000                   __OSCurrentContext = B
  5  START_THREAD   a=0x80301000 b=0x800ec97c      B's host thread, entry OSWakeupThread
  6  HANDOFF        a=0x80300000 b=0x80301000      A -> B
  7  THREAD_ENTRY   a=0x00000001 b=0x800ec97c      host slot 1 dispatches B
  8  DISABLE_IRQ    a=0x00000001 b=0x00001032      OSWakeupThread's bracket
  9  SELECT_ENTER   a=0x00000000 b=0x80301000      current = B
 10  GET_CTX        a=0x80301000
 11  SELECT_SAVE    a=0x80301000 b=0x800ebe6c      B's continuation
 12  SET_CTX        a=0x80300000                   __OSCurrentContext = A
 13  HANDOFF        a=0x80301000 b=0x80300000      B -> A
 14  RESUMED        a=0x80300000 b=0x00000000      A resumes on host slot 0
 15  SELECT_RETURN  a=0x00000000 b=0x80300000      SelectThread returns NULL
 16  RESTORE_IRQ    a=0x00000001 b=0x00009032      OSSleepThread's bracket closes
```

`OSSleepThread` returns with `fault == 0` in 55 ms. Post-state, all asserted:
`__gCurrentThread == A`, `__OSCurrentContext == A`, `A.state == RUNNING`,
`B.state == READY` back on `RunQueue[16]`, `RunQueueBits == 0x8000`, the sleep queue
empty again, `A.queue == 0`.

**The register proof.** Thread B's staged context holds `0xBB0000rr` in r14..r31 and
B's translated code runs with them; A entered with `0xAA0000rr`. After the round trip
A's r14..r29 are `0xAA0000rr` again, r30/r31 are restored by the two epilogues, r1 is
back to A's stack and LR to the harness sentinel. A same-stack nested call could not
produce that.

**The thread proof.** `sr_os_slot_tid(0) = 0xd068`, `sr_os_slot_tid(1) = 0x185f1d8`
— two different `pthread_t`s.

## 6a. Three threads, and why that is the argument-ending one

Two threads admit a sceptical reading: B could have run *nested* on A's host stack
and simply returned, and every assertion in §6 would still hold. A rotation cannot be
read that way. Test E stages a third thread and runs A→B→C→A:

- A (prio 8) calls the translated `OSSleepThread(&q)` → parks, switch to B.
- B (prio 16) *also* enters `OSSleepThread(&q)` → parks, switch to C.
- C (prio 24) enters `OSWakeupThread(&q)`, which wakes **both** A and B, `SetRun`s
  them, and reschedules; the scheduler picks A (highest priority).
- **A resumes while B is still parked.** On one host stack this is impossible:
  returning to A's frame would have to discard B's and C's frames, and B's would then
  be unrecoverable — but B is still a live READY thread the scheduler may pick next.

25 host-boundary events, three `SELECT_SAVE`s, three `HANDOFF`s in order
A→B, B→C, C→A, and three distinct `pthread_t`s (`0xd068`, `0x185f1d8`, `0x186fad0`).
Post-state: `__gCurrentThread == A`, A RUNNING, B and C READY,
`RunQueueBits == 0x8080` (bits for priority 16 and 24), sleep queue empty, and A's
r14..r29 unchanged across **two** intervening threads.

## 7. What is NOT solved — read before quoting any of this

1. **No interrupt delivery, so no preemption.** The eight non-`SelectThread`
   `OSLoadContext` call sites are exception-return paths
   (`zz_800e422c_`, `zz_800e5db8_`, `zz_800e7d84_`); they still fault, by name,
   with `SR_F_LOADCTX_EXC` (`0xC503…`). An exception context (`state & 0x02`)
   resumes at an *arbitrary* interrupted PC, not at a save point, and that case
   genuinely does need host stack switching — this design does not cover it. What
   it does cover is the whole cooperative path, which is what the guest's own
   scheduler, mutexes, message queues and `OSSleepThread`/`OSWakeupThread` use.
2. **The idle loop refuses instead of hanging.** `SelectThread`'s
   `while (RunQueueBits == 0)` at `0x800ebea0` is broken on hardware by an external
   interrupt. With no interrupt delivery it could never terminate, so it raises
   `SR_F_IDLE_NO_IRQ` rather than spinning.
3. **A guest thread that dies leaks its host thread.** `OSExitThread`
   (`0x800ec0b8`, identified: it stores `val` at `+0x2D8` and wakes `queueJoin`)
   leaves the thread MORIBUND, so `SelectThread` saves no continuation and the host
   thread parks inside its guest frames for good. A wasm host thread cannot unwind
   its own frames without an exception. This is the one place where
   `-fwasm-exceptions` would help, and it is a *one-way* unwind, which the spike in
   §2 showed the toolchain does build — unlike the two-return `setjmp` it refuses.
4. **`SR_MAX_THREADS` is 16 and every host thread is created in `sr_os_init()`.**
   Creating one later, from a thread that is already parked, would need the main
   thread to spawn a Worker while the main thread is itself blocked. SAB's real
   thread count has not been measured.
5. **Blocking is legal in a worker, not on a browser main thread.** The harness runs
   under Node where the main thread may block; a browser integration must run the
   recomp in a worker. `gamecube/recomp/recomp_worker.js` already is one.
6. **The witness stages its world; it is not a booted game.** Thread A and B, the
   run queue and the SDA base are written into MEM1 by the harness in the shape
   `__OSThreadInit` + `OSCreateThread` would leave them
   (`~/gc_refs/dolsdk2001/src/os/OSThread.c:140-158`). What is *not* staged is the
   code: `OSSleepThread`, `OSWakeupThread`, `__OSReschedule` and — in the oracle
   build — `SelectThread` are the shipped functions, translated by `sr.py` from
   `main.dol`. The next step is a switch that occurs during a real boot.
7. **`r13` is chosen by the harness** (`0x802e0000`). Every access to
   `RunQueueBits`/`Hint`/`Reschedule` in the shipped code is r13-relative, so the
   value is not load-bearing for the mechanism, but it is not SAB's real
   `_SDA_BASE_` and no claim here depends on it.

## 8. Cost

By construction the translated bodies are untouched: no Asyncify, no
`-sSUPPORT_LONGJMP`, no JSPI, no per-call instrumentation — the entire mechanism is
inside `sr_host_os.c`, reached through one function-pointer test in `sr_extern`
(`sr_driver.c:51`) that is NULL in every build that does not link the host layer.

`-pthread` is nevertheless a codegen change, so "does threading cost the translated
code?" is a matched pair, not an argument. **That pair is NOT TAKEN and no number is
claimed here.** The rig for it is committed and is one command:

```bash
# same generated whole-image C, linked both ways; only the flag differs
python3 gamecube/recomp/sr/sr.py --image /tmp/sr_ctxsw/main.dol \
  --map dolphin_captures/sab.map --all --indirect --jumptables \
  --boundaries outer+calls --dispatch-out /tmp/sr_wi_src/sr_dispatch.c \
  --out /tmp/sr_wi_src/sr_gen.c
SR_OUT=/tmp/sr_wi_base SR_FIXED_MEM=1 SR_GEN=/tmp/sr_wi_src/sr_gen.c \
  SR_DISPATCH_C=/tmp/sr_wi_src/sr_dispatch.c bash gamecube/recomp/sr/build_slice.sh <dol> ALL
SR_OUT=/tmp/sr_wi_pt   SR_PTHREAD=1   SR_GEN=/tmp/sr_wi_src/sr_gen.c \
  SR_DISPATCH_C=/tmp/sr_wi_src/sr_dispatch.c bash gamecube/recomp/sr/build_slice.sh <dol> ALL
# then, under tools/probe_lock.sh, alternate:
SR_OUT=/tmp/sr_wi_{base,pt} node gamecube/recomp/sr/perf_fixture.mjs \
  gamecube/recomp/sr/sab_nonleaf_fixtures.json
```

`SR_FIXED_MEM=1` exists so the non-pthread arm also drops `ALLOW_MEMORY_GROWTH`;
`-pthread` + growth is the documented slow path (`-Wpthreads-mem-growth`), and a pair
that differs in two flags is not a pair.

Why it was not taken here: the whole-image `-O2` link exceeds ten minutes per arm,
and a sibling agent held `tools/probe_lock.sh` for the whole window. Running two
`-O2` links over 33 MB of generated C during someone else's live measurement is
exactly the load contamination that has voided campaigns in this repo before. A
number produced that way would be worse than no number.

## 9. Files

| file | what |
|---|---|
| `sr_host_os.h` | the ABI: guest addresses, `OSContext`/`OSThread` offsets, fault codes, trace events — each constant cited to the instruction that materialises it |
| `sr_host_os.c` | the host layer: the 8 primitives + `host_select_thread`, a register-for-register transcription of `0x800ebd68` |
| `sr_driver.c` | `sr_host_hook` (NULL by default, so no existing build changes) consulted by `sr_extern` and `sr_call` |
| `sr.py` | `--host ADDR` (repeatable): never translate it, stop the closure there |
| `build_ctxsw.sh` | the `-pthread` build; `SR_TRACE_BUILD=1` produces the oracle |
| `verify_ctxsw.mjs` | differentials A/B, witness C, control D |
| `build_slice.sh` | `SR_PTHREAD=1` / `SR_FIXED_MEM=1` for the §8 matched pair |
