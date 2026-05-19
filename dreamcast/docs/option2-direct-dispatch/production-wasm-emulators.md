# Production WASM Emulators: Architecture Survey for High-MHz CPU JIT

Research scope: emulators in production that emulate a CPU of >= 100 MHz inside the browser, with attention to dispatch architecture, JIT codegen strategy, and the JS/wasm boundary cost. Goal: find proven patterns relevant to a 200 MHz SH4 (Dreamcast) JIT currently stuck at ~0.005% native (~9.5K block-dispatches/sec).

---

## 1. Project table

| Project | CPU emulated | Native MHz | Measured speed | Architecture | Source |
|---|---|---|---|---|---|
| **CheerpX / WebVM** | x86 / x86_64 | 1000+ | 200–300 MIPS peak, 30–100 MIPS avg (~0.05–0.3% native MIPS); 6.7x slowdown on Fibonacci to 100K | Single-pass x86→wasm JIT; "all code reachable from hot entry → one wasm function"; relies on **wasm tail calls** for indirect jumps; multi-tier JIT (interpret → compile) | leaningtech.com/blog, [cheerpx.io/blog/cx-10](https://cheerpx.io/blog/cx-10) |
| **v86** | x86 (Pentium 4 ISA) | 100s of MHz | ~44x slowdown vs native on Fibonacci to 100K (~2.3% native); boots Windows 95/98/2000, Linux | Page-granularity JIT (4KB x86 page → one wasm module). `JIT_THRESHOLD=200_000` hotness, `MAX_PAGES=3` reachable pages per module, central wasm dispatch loop with `LOOP_COUNTER=100_003`, dispatch via wasm table `call_indirect` | github.com/copy/v86 |
| **QEMU-Wasm (ktock)** | x86_64, AArch64, RISCV64 | 1000+ | Boots Raspberry Pi Linux in browser; experimental; explicit performance numbers not published | Hybrid TCI (interpreter) + TCG (JIT): TBs that hit ~1000 executions are emitted as wasm modules. Each TB = one wasm module imported into a shared instance | github.com/ktock/qemu-wasm |
| **jor1k (recompiled)** | OpenRISC | 50 MHz | >1 billion IPS claimed (recompiled mode) | **Ahead-of-time** ELF→wasm recompilation. Whole binary becomes one wasm module of a giant switch-goto. Author's punchline: "providing JavaScript engines tens of thousands of code chunks a second simply does not work." | jor1k wiki |
| **JSLinux / TinyEMU** | x86, RISC-V | n/a | x86 ~100 MIPS (Firefox 2017), Primes 190s on M1 Chrome = "comparable to 200 MHz RISC-V" | **Pure interpreter** compiled with Emscripten; no JIT, no wasm-codegen. Single emscripten module; main loop runs entirely inside wasm | bellard.org/jslinux/tech.html |
| **mGBA (wasm)** | ARM7TDMI | 16.78 | 60 FPS reportedly playable | Emscripten-compiled C **interpreter** (no native ARM→wasm JIT). Inner loop entirely in wasm. mGBA upstream has no JIT in any backend | github.com/thenick775/gbajs3 |
| **DeSmuME wasm** | ARM946 + ARM7 | 67 + 33 | Most 2D games 60 FPS on modern devices; 3D mixed | Emscripten interpreter, no JIT in wasm build (upstream JIT is x86/ARM only) | github.com/44670/desmume-wasm |
| **PCSX-ReARMed wasm** | MIPS R3000A | 33 | Playable on most PS1 titles in RetroArch web player | Interpreter via emscripten; ARM dynarec disabled in wasm builds | github.com/BinBashBanana/webretro |
| **PPSSPP wasm** | MIPS Allegrex | 333 | No official wasm port; users report attempts only | Upstream JIT is x86/ARM. WebAssembly port has been an open issue (#13567) for years | github.com/hrydgard/ppsspp |
| **Cemu wasm** | PowerPC Espresso | 1240 | Not ported | Desktop-only emulator | github.com/cemu-project/Cemu |
| **PCSX2 wasm** | Emotion Engine | 294 | Not ported | Desktop-only emulator | github.com/PCSX2/pcsx2 |
| **Ruffle (AVM2)** | n/a (bytecode VM) | n/a | "Still far from Flash Player speeds" | **Pure interpreter** in Rust→wasm. Verifier + optimizer pass added 2024. No JIT. JIT explicitly listed as open research | github.com/ruffle-rs/ruffle |
| **Box86 / Box64** | x86 / x86_64 | n/a | n/a in browser | **No wasm port exists.** Native dynarec only (ARM64/RISC-V/LoongArch hosts) | box86.org |
| **EmulatorJS** | aggregator | varies | "Dolphin (GameCube/Wii) is expected to be unplayable" | Distributes RetroArch libretro cores compiled to wasm. CPU performance == per-core | emulatorjs.org/docs |
| **Flycast WASM** (us / nasomers) | SH4 | 200 | v1 interpreter 0.4–5 FPS; wasm-jit branch claims 20–40+ FPS in development | SH4 → SHIL IR → `rec_wasm.cpp` → wasm bytecode → `WebAssembly.compile()` → dispatch via `call_indirect` from a C dispatch loop "to keep JavaScript out of the hot path" (51/70 SHIL ops emit natively) | github.com/nasomers/flycast-wasm |

---

## 2. Per-project deep dives (matches our criteria)

### 2.1 CheerpX / WebVM (the gold standard reference)

**Why this matters:** CheerpX is the only project in the survey that JITs a >1 GHz host CPU to wasm and achieves single-digit slowdown on best-case loops (2x–3x), 5x–10x on average. They are openly the most-engineered JIT-in-wasm project in production.

**Architecture (from leaningtech blog posts and cheerpx.io):**
- Two-tier: fast x86 interpreter + hot-path JIT.
- **Region-based codegen, not per-block.** Quoting them directly: *"all the code reachable via direct jumps and hot enough from a given entry point will become 1 Wasm function."* The unit of wasm-module emission is a closed call-graph region, not a basic block or a 4K page.
- **Indirect jumps use wasm tail calls** (`return_call_indirect`). This is the only way to keep the call stack flat across indirect-jump-heavy x86 code (e.g. interpreter loops, return polymorphism). Without tail calls the wasm stack grows monotonically.
- **Devirtualization**: CheerpX records observed indirect-call targets at runtime and rewrites them as direct calls, exactly mirroring what TurboFan does for self-hosted wasm (V8's "wasm-speculative-optimizations" post).

**Critical V8 footgun documented by CheerpX themselves** ("Extreme WebAssembly 2"):
> "Liftoff does not support Wasm tail calls and the compiler will give up and silently upgrade to Turbofan."

For a JIT engine that ships hundreds of small wasm modules and wants tail-call dispatch, this means startup is dominated by TurboFan compile time, not Liftoff. CheerpX explicitly considers this a regression bug.

**Numbers we can cite:**
- 5x–10x slowdown vs native on average application workloads; 2x–3x on the best-optimized inner loops (cheerpx.io/blog/cx-10).
- 6.7x slowdown on Fibonacci(100K), where v86 is 44x slower than native (~6.5x faster than v86 on the same micro).
- Reported MIPS in the WebVM Hacker News thread: 200–300 MIPS peak, ~30–100 MIPS sustained (vs ~100,000 MIPS native), so CheerpX's *peak* is roughly 0.2–0.3% of native MIPS at the same clock.

**What this tells us about our SH4 problem:** Even the most-engineered production wasm JIT for a 1 GHz+ CPU is 5x–10x slower than native in mixed workloads. A 200 MHz SH4 with the same engineering would land around 20–40 MHz emulated wall-clock = 10–20% native — **not** ≥100%. Nobody in production has shown ≥100% native for a >100 MHz CPU in browser wasm.

---

### 2.2 v86 (the most-public x86 JIT-in-wasm)

**Key files (`copy/v86`):**
- `src/rust/jit.rs` — `jit_analyze_and_generate`, `jit_increase_hotness_and_maybe_compile`, `follow_jump`. Constants: `JIT_THRESHOLD: u32 = 200_000`, `MAX_PAGES: u32 = 3`.
- `src/rust/cpu/cpu.rs` — `LOOP_COUNTER: i32 = 100_003`, `INTERPRETER_ITERATION_LIMIT: u32 = 100_001`, `WASM_TABLE_OFFSET`, `call_indirect1` extern.
- `docs/how-it-works.md` — the architectural doc.

**Architecture in plain English** (cited from `how-it-works.md`):
1. Interpreter mode collects entry points (call/indirect-jump targets) and bumps a hotness counter per 4KB **x86 page**.
2. When a page hits `JIT_THRESHOLD` (200K executions), v86 follows reachable jumps up to `MAX_PAGES` (3) and emits one wasm module containing **a single function whose body is one big `br_table` switch** over the entry points in that page. (v86's exact wording: *"generates a single function with a big switch statement (brtable), to ensure that all functions and targets of indirect jumps are reachable from other modules."*)
3. The dispatch loop lives in the main wasm module. It runs `LOOP_COUNTER ≈ 100K` iterations per JS-call, each iteration doing one `call_indirect` into the wasm table for the next entry point's compiled function. The compiled function executes until it needs to exit, returns to the loop, and the loop computes the next entry point.
4. **The JS hop is amortized over ~100K dispatches** — only one JS→wasm transition per `main_loop` invocation.

**Module-emission discipline:** v86 ships *one wasm module per 4K page (plus reachable pages up to MAX_PAGES = 3)*. `MAX_PAGES` is deliberately small because "module generation is fairly slow … memory usage blows up." Each page is conservatively ~hundreds of x86 basic blocks fused into one `br_table` wasm function.

**Performance reality:** The blog/HN benchmark that anyone can reproduce is Fibonacci(100K): v86 is 44x slower than native. Boot times: Linux distros 30s–2min in browser. This is the **most-cited published number** for v86 production speed.

---

### 2.3 QEMU-Wasm (`ktock/qemu-wasm`)

**Architecture:**
- New TCG (Tiny Code Generator) backend that emits wasm bytecode.
- Hybrid: TCI (the IR interpreter) for cold paths + TCG-wasm for hot paths.
- **One wasm module per TB** (translation block, ≈ basic-block granularity).
- Modules import shared memory and helper functions from a base instance — exactly the pattern we are considering for SH4.
- Threshold for tier-up to wasm: **TBs that execute ~1000 times** (from FOSDEM 2025 slides and `qemu-riscv` mailing list patches).

**Why this is interesting for us:** It is the closest published implementation to a per-block (or near-per-block) wasm JIT for a high-MHz CPU. **No measured performance numbers are published** in the README. The FOSDEM 2025 / KVM Forum 2025 talks reference it as experimental.

**Note on dispatch:** Because modules can't run from memory, every TB-wasm invocation goes through `WebAssembly.Module` + `Instance` + `call_indirect`. They explicitly batch by *runtime hotness* (1000 executions), not by upfront analysis, so cold-start is bounded by the interpreter speed of TCI.

---

### 2.4 jor1k recompiled mode (the cautionary tale)

OpenRISC ELF AOT-recompiled to **one** giant wasm module (switch-goto over the entire program). Claims >1 billion IPS but the author bluntly notes: *"Providing JavaScript engines ten thousands of code chunks a second simply does not work."* QEMU-wasm and v86 both validate this by amortizing — v86 with the page+brtable shape, QEMU with the ~1000-execution hotness threshold.

This is the single most relevant prior-art warning in the whole survey: **emit fewer, larger wasm modules, less often**.

---

### 2.5 JSLinux / TinyEMU (the surprising interpreter result)

**Architecture:** Bellard's TinyEMU C source, compiled with Emscripten as **pure interpreter**. No JIT. No runtime wasm codegen. The dispatch loop is entirely inside the emscripten wasm module.

**Measured speed:**
- ~100 MIPS for x86 in Firefox 2017 (`bellard.org/jslinux/tech.html`).
- Primes benchmark 190s on an M1 Mac Mini in Chrome, equated by Bellard to "a 200 MHz single-issue RISC-V CPU."

**Why this matters to us:** This is the only result in the survey that achieves something close to our SH4 target clock — 200 MHz RISC-V on an M1 — and it does it with **a pure interpreter, no JIT at all**, because the entire dispatch lives inside one wasm module. The TinyEMU x86 interpreter is a textbook decoded-dispatch loop (switch on opcode), and Emscripten + V8 produce code competitive with our SH4 problem class.

**The structural punchline:** if our SH4 interpreter were the only thing running in the hot loop *with the dispatch loop also in wasm*, ~200 MHz emulated speed is empirically reachable today, today, without a JIT — provided we avoid the JS hop.

---

### 2.6 Flycast WASM (`nasomers/flycast-wasm` wasm-jit branch — this codebase)

Already documented in `dreamcast/flycast-bridge/`. SHIL→wasm pipeline in `rec_wasm.cpp`. 51/70 SHIL ops emit native. Dispatch loop in C "to keep JavaScript out of the hot path." Claims 20–40+ FPS during in-development testing.

Of all surveyed projects this is the only one that is directly comparable to our work and the only one that targets SH4. The reported speed claim (20–40 FPS vs the v1 interpreter's 0.4–5 FPS) maps to ≈4×–80× speedup from JIT, but the underlying CPU clock-fraction it achieves is not separately reported in the README.

---

## 3. Synthesis: what successful projects share

1. **The dispatch loop is INSIDE wasm, not JS.** Every project that hits useful CPU rates (v86 main_loop, CheerpX dispatch fn, QEMU-wasm dispatch, JSLinux interpreter, Flycast WASM C loop) runs its inner loop entirely inside a wasm function and amortizes JS↔wasm transitions over thousands–hundreds-of-thousands of dispatches. **Nobody** runs a per-block JS callback in the hot path.

2. **Modules are batched, not per-block.** v86: 4KB-page (~hundreds of blocks) per module, MAX_PAGES=3. CheerpX: whole reachable hot region per wasm function. QEMU-wasm: per-TB but with a ~1000-execution threshold so cold blocks never become modules. jor1k: whole binary. The shared lesson: small, frequently-invoked modules are the death of browser-wasm JIT performance.

3. **JIT-trigger thresholds are high.** v86 = 200,000 executions per page. QEMU-wasm = ~1000 executions per TB. Below the threshold, code runs in an interpreter — also inside wasm.

4. **Indirect jumps want wasm tail calls.** CheerpX is explicit: indirect jumps in x86 need `return_call_indirect` to keep the wasm stack from growing. Liftoff dropping tail-call support and forcing TurboFan compile is a published bug from their POV. Available in Chromium and Firefox today; absent on Safari < 18.2.

5. **Memory access is direct.** Every project either uses linear-memory loads with masked addressing (v86, CheerpX, QEMU) or imports a shared linear memory into JIT modules. No project routes memory access through JS imports in the hot path.

6. **Performance ceiling for >100 MHz JIT-in-wasm is ~5x–10x slowdown vs native (CheerpX, best case 2x–3x).** This is a hard empirical fact across the most-engineered project in the space. No project shows ≥100% native speed for a CPU >100 MHz in browser wasm.

---

## 4. Honest verdict

**Nobody has solved "≥100% native speed for a >100 MHz CPU in browser wasm."** The closest are:
- **CheerpX** at 200–300 MIPS peak on a guest CPU that natively runs ~100,000 MIPS = 0.2–0.3% native MIPS at best, 0.05% sustained.
- **JSLinux RISC-V interpreter** at ~"200 MHz equivalent" on an M1 in Chrome — but that's the *target* RISC-V clock the interpreter emulates fast enough to keep up with on the M1, not a percentage of the M1's actual instruction throughput.
- **v86** at ~2.3% native on Fibonacci(100K), running Windows 95 in a few seconds of boot.

If our goal is "near-native SH4 (200 MHz) in browser wasm" the published prior art does not support that ceiling. Reachable with current engineering, based on the survey:
- ~20–40 FPS Dreamcast in-development (our own Flycast WASM wasm-jit branch).
- The realistic ceiling based on CheerpX (the best-engineered datapoint) is probably 10–20% native equivalent for a 200 MHz CPU — i.e. **20–40 MHz emulated**, which roughly matches the Flycast WASM JIT in-development claims.

The single most actionable architectural finding for our project: **collapse the dispatch loop into wasm and stop generating one tiny module per block.** Every project that achieves useful CPU rates does this. v86's `JIT_THRESHOLD = 200_000` / `MAX_PAGES = 3` / `LOOP_COUNTER = 100_003` constants are the most concrete reference design we have. Our current ~100µs/block dispatch (= 10K dispatches/sec) is almost certainly dominated by the JS↔wasm hop, exactly the failure mode jor1k named in 2014.

---

## 5. Sources

- v86 — github.com/copy/v86 ; `docs/how-it-works.md` ; `src/rust/jit.rs` ; `src/rust/cpu/cpu.rs`
- CheerpX 1.0 — cheerpx.io/blog/cx-10
- CheerpX deep architecture — medium.com/leaningtech/cheerpx-using-webassembly-to-run-any-programming-language-in-the-browser-3306e1b68f06
- Extreme WebAssembly 2 (tail calls + CheerpX) — labs.leaningtech.com/blog/extreme-webassembly-2-the-sad-state-of-webassembly-tail-calls
- WebVM / CheerpX MIPS — Hacker News news.ycombinator.com/item?id=30167403
- QEMU-Wasm — github.com/ktock/qemu-wasm ; FOSDEM 2025 slides ; KVM Forum 2025 talk
- jor1k 1-billion-IPS write-up — github.com/s-macke/jor1k/wiki/Breaking-the-1-billion-instructions-per-second-barrier-via-Dynamic-Recompilation-and-WebAssembly
- JSLinux tech notes — bellard.org/jslinux/tech.html
- Bellard TinyEMU — bellard.org/tinyemu
- V8 Liftoff — v8.dev/blog/liftoff
- V8 wasm tail calls — v8.dev/blog/wasm-tail-call
- V8 wasm speculative optimizations — v8.dev/blog/wasm-speculative-optimizations
- Flycast WASM (wasm-jit branch) — github.com/nasomers/flycast-wasm
- HN: V86 thread — news.ycombinator.com/item?id=31270543
- HN: Flycast WASM thread — news.ycombinator.com/item?id=47098978
- mGBA / gbajs3 — github.com/thenick775/gbajs3
- DeSmuME WASM — github.com/44670/desmume-wasm
- PPSSPP wasm tracking issue — github.com/hrydgard/ppsspp/issues/13567
- Ruffle optimisations Sep 2024 — ruffle.rs/blog/2024/09/12/optimisations-text-more
- EmulatorJS cores — emulatorjs.org/docs4devs/cores
- RetroArch emscripten — github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md
