# Sonic Adventure 2 — `pump stopped sh4_pc=0xac000012` at STORY SELECT

Reported from the live site: the game "died" while being played. The diagnostic dump carried

```
[flycast-shim] freerun run_iter threw (pump stopped): [object Object] sh4_pc=0xac000012
>> THE EMULATOR STALLED — telemetry at +96.0s, pc=0x8c10fe72 fps=63 fields=63 iters=61
boot reached  first-distinct-frame at +50.8s
```

**REPRODUCED, 11 runs / 11 crashes, deterministic to the bit.** Every field of the owner's
crash line is reproduced exactly, on a hermetic `origin/prod` snapshot, ~54 s after the first
distinct frame (guest held at 1.000x throughout).

---

## 1. What `sh4_pc=0xac000012` means

`_flycast_get_sh4_pc()` returns `Sh4cntx.pc` (`dreamcast/flycast-bridge/rec_wasm.cpp:1026`),
so it is the GUEST SH4 program counter, not a host address. `0xA0000000` is the SH4's P2
window, so `0xAC000012` is physical `0x0C000012` — 18 bytes into Dreamcast main RAM, read
uncached.

The faulting instruction is at `0xAC000010`, because the illegal-instruction throw carries
`ctx->pc - 2` (`core/hw/sh4/interpr/sh4_opcodes.cpp:1928`). Measured at the crash, that
memory reads `ffffffff`:

```
[crash-mem] pc-16 0xac000002: ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff ...
[crash-mem] ram+0 0x8c000000: ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff ...
```

That fill is REIOS's, not corruption: `reios_boot()` does
`memset(GetMemPtr(0x8C000000, 0), 0xFF, 64_KB)` (`core/reios/reios.cpp:646`) and then
installs BIOS entry points only at `0x8C0000B0`–`0x8C0000E0` and `0x8C001000`–`0x8C001008`
(`reios.cpp:36-44, 651-657`). **Everything else in the first 64 KB of RAM — including
`0x8C000010` — is `0xFF` under REIOS where a real Dreamcast BIOS has code.** `0xFFFF` is
not a valid SH4 opcode, so executing there raises `Sh4Ex_IllegalInstr`.

> This is a DIFFERENT signature from the historical `sh4_pc=0xa0000002` corrupt-disc case.
> That one is the reset vector: `reios_reset` writes `REIOS_OPCODE` at BIOS offset 0
> (`reios.cpp:776`) and `SYSCALL_ADDR(0xA0000000)` is hooked to `reios_boot`
> (`reios.cpp:735`), so `0xA0000002` = "the guest re-entered the BIOS boot trap", and
> `reios_boot` throws `Failed to locate bootfile`. `0xAC000012` is not that.

## 2. What actually throws — the `[object Object]` is now decoded

The shim's old handler printed `err.message || String(err)`. The Dreamcast link uses
`-fexceptions` (`dreamcast/flycast-bridge/flycast_worker_link.sh:346`), i.e. JS-based
emscripten EH, so a C++ throw arrives in JS as a `CppException` whose ONLY field is
`excPtr` (`flycast_worker_emcc.js:452-457`). No `.message`, no `.stack` — hence
`[object Object]` and the missing `stack=` in the field report. **The information was never
lost, only unformatted.** `dreamcast/flycast_libretro/flycast_worker.js` now walks
`ExceptionInfo` (`flycast_worker_emcc.js:1365-1376`: metadata sits 24 bytes below the thrown
object; `type` at +4) to the Itanium `type_info` and its `what()` string, and dumps the SH4
state and guest memory alongside. Same crash, now:

```
[flycast-shim] freerun run_iter threw (pump stopped): C++ throw excPtr=0xe327a38
  type=16FlycastException what="Fatal: SH4 exception when blocked"
  sh4_pc=0xac000012 sr=0x700000f0 BL=1 MD=1 spc=0x4f24eef4 ssr=0x60000001
  pr=0x8c50c3e8 vbr=0x8c00f400 pend=0x0 run=1
```

The mangled names `16FlycastException` / `18SH4ThrownException` are present in the SHIPPED
`flycast_worker_emcc.wasm`, so this decode works on the deployed binary with no relink.

`"Fatal: SH4 exception when blocked"` is thrown by `Do_Exception` when `SR.BL != 0`
(`core/hw/sh4/sh4_interrupts.cpp:222-223`) — a nested exception taken while the CPU is
already inside an exception handler. It is raised from INSIDE the mainloop's own
`catch (const SH4ThrownException&)` block (`rec_wasm.cpp:3358, 3399`), so nothing catches
it: it unwinds out of `dispatch_slice` → `mainloop` → `retro_run` → `emscripten_run_iter`
and into the shim's pump, which stops. That is why the tab keeps its last frame and the
page reports a stall instead of an error.

## 3. The full chain, from the measured state

| step | evidence |
|---|---|
| 1. Guest PC runs away to `0x4f24eef4` | `spc=0x4f24eef4` — `Do_Exception` writes `spc` only AFTER the `BL` check, so this is fault #1's saved PC (`sh4_interrupts.cpp:222-227`) |
| 2. `0x4f24eef4` holds `0xffffffff` → illegal instruction | `[crash-mem] spc-16 0x4f24eee4: 00000000 000f06fe 000f06fe 00000000 ffffffff ...` (5th word IS `spc`) |
| 3. Fault #1 vectors normally | `[crash-mem] CCN EXPEVT/INTEVT 0xff000024: 00000180 00000360` — `0x180` = `Sh4Ex_IllegalInstr` (`core/hw/sh4/sh4_if.h:260`). `ssr=0x60000001` = SR before it: MD=1 RB=1 **BL=0**, so this one was allowed |
| 4. `pc = vbr + 0x100` = `0x8c00f500`, `BL` set to 1 | `sh4_interrupts.cpp:229-233`; `vbr=0x8c00f400` |
| 5. SA2's handler saves EXPEVT and jumps to its dumper | disassembled from `[crash-mem] vbr+0x100+*` with `dreamcast/tools/sh4dis.py`: `mova`/`mov.l @(0xff000024)` → store to `0x8c15ae7c`, then `mov.l @(0x10,PC),R1` (= `0x8c15ad08`) / `jmp @R1` |
| 6. The dumper pushes all state, then dispatches through a per-EXPEVT table at `VBR+0x200+((EXPEVT-0x200)>>3)` and `jsr @R14` | disassembled at `0x8c15ada6-0x8c15adc6` |
| 7. Execution reaches `0xAC000010`, which is REIOS `0xFF` fill | `sh4_pc=0xac000012`, `[crash-mem] pc-16` all `ffffffff` |
| 8. Second illegal instruction, `BL` still 1 → `Do_Exception` throws → pump dies | `sr=0x700000f0` (`BL=1 MD=1 RB=1 IMASK=0xF`), `what="Fatal: SH4 exception when blocked"` |

**The root fault is step 1.** Steps 4-8 are SA2's own crash handler behaving as designed and
then falling off the end of REIOS's unimplemented low-RAM BIOS region. Fixing step 7 (giving
`0x8C000000`–`0x8C000FFF` real content) would change a hard pump death into the game's own
crash screen; it would NOT stop the game from crashing.

## 4. Reproduction

```bash
# hermetic snapshot of what the live site serves (prod page + prod worker),
# with the local disc parts symlinked in
H=/tmp/dc-herm; rm -rf $H; mkdir -p $H
git archive origin/prod dreamcast.html coi-serviceworker.js lib \
    dreamcast/audio-worklet.js dreamcast/flycast_libretro | tar -x -C $H
cp dreamcast/flycast_libretro/flycast_worker.js $H/dreamcast/flycast_libretro/  # the decoder
ln -s "$PWD/dreamcast/discs" $H/dreamcast/discs
PROBE_ROOT=$H PROBE_PORT=8790 node dreamcast/tools/flycast_probe.js --serve &

node tools/browser_leak_guard.js reap && uptime
mkdir /tmp/bemental-probe.lock                       # serialize against sibling agents
node dreamcast/tools/dc_input_repro.mjs --url http://localhost:8790 \
     --game sa2 --mash --nodirs --dur 200000 --name buttons --shotevery 3000
rmdir /tmp/bemental-probe.lock
```

Exit 2 and `=== REPRODUCED ===` on the fault. Crash lands ~54 s after the first distinct
frame; the last frame before it is **STORY SELECT with HERO highlighted**
(`/tmp/dc-shot-buttons-016.png`), i.e. the fault is the HERO-story confirm.

## 5. The arms (all on `/tmp/dc-herm`, box load 1.8–3.8)

| arm | input | guest rate | result |
|---|---|---|---|
| default × 3 (`--mash`) | arrows + buttons | 1.000x | **CRASH** @ +56 s, +56 s, +57 s |
| default × 2 (`--mash --nodirs`) | buttons only | 1.000x | **CRASH** @ +53 s, +54 s |
| `?noic=1` | buttons | 1.000x | **CRASH**, byte-identical line |
| `?noregcache=1` | buttons | 0.999x | **CRASH**, byte-identical line |
| `?nofastmem=1` | buttons | 1.002x | **CRASH**, byte-identical line |
| CDP CPU throttle ×2.2 | buttons | 1.000x | **CRASH** |
| CDP CPU throttle ×5 | buttons | 1.000x | **CRASH** |
| default + handler dump | buttons | 1.001x | **CRASH** (the run that produced §3 step 5-6) |
| **`?nochain=1`** | buttons | 0.732x | **no crash, 201 s** — reached City Escape GAMEPLAY |
| **`?nochain=1` (repeat)** | buttons | 0.732x | **no crash, 241 s** — City Escape, timer 01:44:42 |
| `--noinput` | none | 1.000x | no crash, 301 s (attract loop) |
| `--script "3000:Enter"` | one press | 1.001x | no crash, 181 s (attract demo) |

Every crash line is character-identical across arms and machines:
`sh4_pc=0xac000012 sr=0x700000f0 spc=0x4f24eef4 pr=0x8c50c3e8 vbr=0x8c00f400`.

Two things this settles:

- **Input is necessary, but only as a way to reach the menu.** 301 s of attract mode and
  181 s after a single Start press are both clean; the analog stick is irrelevant (the
  buttons-only arm crashes identically). What matters is driving the guest to
  title → 1P PLAY → STORY SELECT → confirm.
- **Host speed does not move it.** Under a 5× CDP CPU throttle the governor still held the
  guest at 0.99975x, and the crash landed at the same elapsed running time
  (`phaseMs` 54,768 ms vs 54,158 ms unthrottled). Note `phaseMs` is WALL time in the running
  phase, which equals guest time only because the guest rate was 1.000x in both arms — this
  is evidence that host throughput is irrelevant, NOT an independent guest-clock measurement.

## 6. The lead: block chaining

`?nochain=1` sets `g_chain_enabled=false` (`dreamcast.html:2311-2313` on prod posts
`{cmd:'setchain', on:0}`; the shim's `case 'setchain'` calls `flycast_set_chain`,
`rec_wasm.cpp:464-466`), which makes `sh4_jit_lookup_idx` return
`-1` unconditionally (`rec_wasm.cpp:424-425`). Emitted blocks then always exit to the C
trampoline instead of `return_call_indirect`-ing straight into the resolved target
(`rec_wasm.cpp:406-423`).

With that one lever off, the guest **passed the crash point twice and reached gameplay**;
with it on, the fault is 11/11. This is the only lever tested that changes the outcome —
`noic`, `noregcache` and `nofastmem` all still crash with a byte-identical line.

**Caveat, stated deliberately: this is a strong lead, not a proven cause.** `nochain` also
drops the guest to 0.732x, so timing differs. The usual "it never got there" confound is
refuted — the nochain arms ran 201 s and 241 s of wall at 0.732x (~147 s and ~176 s of
guest time), far past the 54 s mark, and
their screenshots show City Escape — but a timing-sensitive interaction that chaining merely
*exposes* is not excluded. Note also that chaining is not purely a dispatch shortcut: a
tail-linked block bypasses the trampoline, so it also changes how often interrupts and cycle
accounting are checked. Both readings live in the same lever.

## 7. NOT established

- **Why the guest PC reached `0x4f24eef4`.** That is the actual emulator bug and it is not
  in any artifact here. `g_pc_ring[128]` in `rec_wasm.cpp:1041` and its `ctx_snapshot`
  cases 60-67 (`:1183-1190`) look like the tool for this, but **nothing anywhere writes that
  array** — grepped across `dreamcast/` and `bementalJIT/`; those cases return 0. A block-entry
  PC ring that is actually filled, dumped by the shim on the throw, is the next step and it
  needs a rebuild (`dreamcast/build_and_probe.sh`).
- Whether an interpreter-only arm (`?interp=1`) survives — not run; it is far too slow to
  reach STORY SELECT in a bounded run.
- Whether other discs hit the same fault. Only `sa2` was tested.
- The owner's session had `1148939` audio dropout frames / `audioUnderrunSeconds=36` before
  the throw. Nothing here reproduces that (all arms held 1.000x with clean audio), and no
  claim is made that it is related.

## 8. Shipped from this investigation

- `dreamcast/flycast_libretro/flycast_worker.js` — decodes the C++ throw (type + `what()`),
  prints SH4 state (`sr`/`BL`/`spc`/`ssr`/`pr`/`vbr`/`pend`) and dumps guest memory around
  the fault, the exception vectors and `pr`/`spc`. JS-only; works against the deployed wasm.
  The next field report names its own exception instead of saying `[object Object]`.
- `dreamcast/tools/dc_input_repro.mjs` — the input rig, with a hard gate that VOIDS a
  negative result unless the pad bytes provably moved. The first attempt at this repro was
  wasted precisely because input silently never arrived.

---

## 9. 2026-10-01: the same crash, reported from a real phone as a "stall"

A real Android phone (ANGLE "ARM, Mali-G715, OpenGL ES 3.2") on prod sent:

```
>> THE EMULATOR STALLED — telemetry at +80.0s, pc=0x8c10fe72 fps=54 fields=54 iters=52
still working? NO — no progress for 33s while running   stall=1  pageError=0
audio  drain 0/s (-100%) · buffer 0/16384 · 2,022,181 dropout frames
depth-stencil in use  depth32f_stencil8 (vendor is not Mali/ARM)
```

`pc=0x8c10fe72` is the same lastPc as the original report at the top of this file. It is the
last heartbeat's PC sample (SA2's frame loop), not the fault. **Reproduced under phone
emulation** (Pixel UA, 915x412 @2x, touch, CDP 4x CPU on the page) with
`dc_input_repro.mjs --game sa2 --mash --nodirs`: the same line,
`what="Fatal: SH4 exception when blocked" sh4_pc=0xac000012 spc=0x4f24eef4`. The run then sat
on a frozen frame, and the page reported it exactly as the phone did: `still working? NO`,
`audio drain 0/s · buffer 0/16384`, `stall=1`. Caveat: CDP refuses
`Emulation.setCPUThrottlingRate` on dedicated workers ("only supported for pages"), so the
emulator worker itself was NOT throttled. Only the page was.

What was wrong on the page side, all fixed in `dreamcast.html`:

- **The crash line was never read.** The shim prints the decoded throw the instant the pump
  dies. Nothing sniffed it, so the report headline was the stall detector's guess 12 s later.
  The headline now leads with `THE GAME CRASHED INSIDE THE EMULATOR — <decoded throw>`, and
  the banner says so at once.
- **`drain 0/s` was read as "audio never drained".** In the reproduction the sink drained at
  the writer's rate (`consumedRate` tracked `[audio] wrote=`) for the whole time the guest ran.
  It dropped to 0 only when the guest died. The row now also prints the total seconds played
  and how long ago the last drain happened.
- **The depth-stencil row was wrong twice.** It was an inference from `gl.mali`, fed the
  MASKED vendor (`"WebKit"` on every Chrome). The inference also came from a gl4/OIT path this
  build does not run: the log reads `core/rend/gles/gles.cpp:624 ... OpenGL ES version 3.0`, and
  the GLES renderer allocates `GL_DEPTH24_STENCIL8` on GLES3 whatever the vendor
  (`gltex.cpp`). The shim now OBSERVES the renderer's `glRenderbufferStorage` call
  (measured: `DEPTH24_STENCIL8 640x480`), and the GPU is identified from the UNMASKED renderer.

### Runtime-lever arms on the current wasm (`eec9ff8c…`, box load 8-21, one run each)

| arm | result |
|---|---|
| `noidleskip=1` | **CRASH**, same line |
| `noimmfast=1` | **CRASH**, same line |
| `rteintc=1` | **CRASH**, same line |
| `noshard=1` | no crash in 110 s. **Inconclusive**: the default arm at the same load also did not reach the menu in 110 s |
| `noic=1` (earlier, section 5) | **CRASH**. That arm also never fills the lever-5E3 RAS (fill gated on `g_ic_generation`), so RAS is not necessary for the crash |

### Shipped mitigation: single-player rewind (`flycast_worker.js`, `recoverFromThrow`)

The core cannot be rebuilt on this box, so the root fault (why the PC reaches `0x4f24eef4`)
is still open. The shim now does the following:

- It keeps one serialized snapshot in the wasm heap, refreshed every 10-30 s at a clean
  asyncify boundary. Measured cost: 18.9-52.5 ms per 27.8-61.3 MB snapshot at load 15-17.
  The interval adapts so that the snapshot's share of wall time stays at or under ~0.25%.
- On a throw out of `run_iter` it clears the stale in-flight flag and restores the snapshot.
  `emscripten_load_state` also flushes the JIT. It then runs 60 s with block chaining off and
  restores chaining.
- It is off under lockstep. It allows at most 3 rewinds per 10 min; after that the old "pump
  stopped" behaviour and report stand. `?norecover=1` turns it off, and `?recoverchain=1`
  rewinds without turning chaining off.

Measured (`recdesk` arm): crash at +63 s, `REWOUND 8.3 s`, chaining off 60 s then back on.
No further fault through +205 s, and the final screenshot is the Hero-story intro cutscene
("That's a 10-4. Cargo secured on board..."), i.e. **past** the crash point. A `recoverchain`
arm (rewind + JIT flush, chaining left on) also had no second fault in the following ~130 s
(one run). That is a hint, not a result, that the fault depends on the JIT's state and not only
on guest input.
