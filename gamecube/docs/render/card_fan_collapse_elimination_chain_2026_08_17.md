# MP4 "Pick a card" fan → white cube: elimination chain + root cause (2026-08-14 … 08-17)

**Symptom.** Mario Party 4 board-intro "Pick a card to get this party started!" scene. Native Dolphin
renders an envelope + a **fan of 6 character cards** (each a portrait + a decorated frame). The WASM
port (dual-core, WGPU) renders a **white cube with faint red character line-art** where the fan should
be — the 6 cards **stacked at one point** instead of fanned.

**Root cause (settled, order 15j build #29).** The guest computes the 6 per-card position matrices
**collapsed** (all `tx=0`, no fan rotation) **under our bementalJIT** — an emitter arithmetic bug in the
card **fan-compute** path (the code that builds each card's world transform). It is NOT a render bug:
the entire GX/WGPU render pipeline was exonerated across ~28 diagnostic builds. This is the same class
as the `ps_madds0` bent-legs fix (PSO), on the card faces.

## The two ground truths

- **Native golden = `cardsAndEnvelope.dff`** (a FifoRecorder capture of this exact scene). Decoded with
  a byte-exact CP/VAT/XF FIFO parser (scratchpad `dff_decode_fan_tex.mjs`, validated: walks frame 0 to
  EOF exactly). The 6 card faces (draws #40–#45, 4-vertex QUADS binding per-card portraits `0x9674e0`,
  `0x96fd80`, `0x978620`, `0x980ec0`, `0x989760`, `0x992000` + a shared EFB-copy frame `0x792cc0` on
  texmap1) each have a **DISTINCT FANNED** position matrix:
  `tx = -23.1 / -17.1 / -6.5 / +6.4 / +14.6 / +22.7`, rotations `cos/sin` of `±10° / ±30° / ±50°`,
  `tz ≈ -523`. Each uses `PosMtxIdx=0` **reloaded per card** via `GXLoadPosMtxImm`.
- **Port = `MarioParty4 (4).gcs.gz`** (Casey's white-cube savestate). The port's `xfmem.posMatrices[0]`
  at every card draw = **`tx=0, ty=-125`** (the frame-center matrix); no fanned matrix anywhere.

## The render lane, fully exonerated (~28 builds)

Every stage measured correct (port instrumentation via SAB cells + fork-diffs vs `~/gc_refs/dolphin-
upstream`; all now stripped):

| Claim | Verdict | Evidence |
|---|---|---|
| Texture decode / TLUT | CLEAN | `0x1227e0` (the sheen, mis-chased early) decodes `nonBlack=4095/4096`, TLUT `0x9cf318e3` correct |
| Texture bind | CLEAN | fan draws bind real textures (`allReal`, no dummy); card faces bind portrait + EFB frame |
| Composite / EFB readback | REFUTED | the frame `0x792cc0` is a real EFB-copy, bound on all 9160 card draws (`framesNull=0`) |
| Sampler wrap | CLEAN | port `wrapU/V=REPEAT` == native `TX_SETMODE0=0x195` |
| Texgen (normal-source + dual-tex post-matrix) | CLEAN | shader + uniform upload byte-identical to upstream (fork-diff) |
| Tex matrix (slot 54→const 0) | eliminated | force-identity on the fan's tex matrix stayed black |
| XF-matrix-write flush | CLEAN | `XFMemWritten → g_vertex_manager->Flush()` byte-identical to upstream; no batch-merge across a matrix reload |
| Vertex-loader frac / component-promotion | REFUTED | byte-identical to upstream; texcoords emit as Float32; WGPU 3→4 promotion excludes Float |

Key reframes along the way: the fan UV is **texgen-generated from the vertex NORMAL** (no texcoord
attribute), through tex-mtx-54 + dual-tex post-matrix-61 — not a vertex-attribute frac bug. `0x1227e0`
(a 64×64 wavy material) is a **sheen**, not the card art; the card art is the `0x9674e0` face-icon
atlas. `board/char_wheel.c` (2D `HuSprPosSet`) and `board/start.c` (dice) are NOT this scene.

## The load-site evidence (guest-side, order 15c–15j)

- Build #27: port `xfmem.posMatrices[0]` collapsed to `tx=0` at all card draws (dff = fanned).
- Build #28 + fork-diff (`wf_027ea452`): the `LoadXFReg` path is byte-identical to upstream and receives
  varied matrices — so the collapse is **not** flush/delivery; it is at or before the guest's matrix
  computation.
- Build #29 (three-way discriminator, Casey's 15e design): at every card draw, the fanned-slot scan =
  `fanned=0` (no fanned matrix in any `posMatrices` slot) with the write-seq advancing and `tx=0`
  loaded ⇒ **A3: the guest computes collapsed matrices under our JIT.**

Native-side confirmation attempts (GDB break on `GXLoadPosMtxImm=0x800CF570`, symbols.txt) proved the
instrument works but were blocked at the source: no native savestate captures the card fan (`cardMenu.
sav` and slot-2 both decode to a THP movie/transition — `THPGXYuv2RgbSetup`/`HuSprDisp`/`pfDrawFonts`);
input-driving the native GUI to the fan failed (osascript key events don't reach Dolphin; screencapture
TCC-blocked). The dff remains the aligned native golden (fanned).

## Next: the fix (fresh phase, decomp-pinned — no LR-hook needed)

The fan-compute fn is statically pinnable from the decomp: it builds each card's world transform via a
rotation/spread loop whose angle constants must reproduce `±10/30/50°` and `tx −23..+23`. Then a B1-style
differential fixture (native interpreter vs our JIT on that fn, known inputs; `aot_merge`/`golden_invoke`
tooling extracts the guest words by address) → the divergent op → emitter fix → conformance goldens →
slot-2 screenshot as acceptance → PSO limbs re-tested first in the family → commit.

Tools banked: `dff_decode_fan_tex.mjs` / `dff_card_positions.mjs` / `dff_card_stack.mjs` (CP/VAT/XF FIFO
decoders), `gdb_bp3.py` (native RSP break-on-fn: matrix + LR caller + r3 source), `PROBE_SCAN_FAN`
(guest-RAM matrix-signature scan). Memory: `gc_wgpu_card_texture_confirm_kill_2026_08_14`.
