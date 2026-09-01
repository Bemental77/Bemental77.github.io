# MP4 card-menu white textures — static confirm-or-kill (Order 14c), 2026-08-14

Oracle pair: `~/Downloads/cardMenu.sav` (native Dolphin 5.0, cards render) vs
`~/Downloads/MarioParty4 (4).gcs.gz` (port, cards white). Port repro captured this session
(`/tmp/card_port_b.png`, overlay 0x4a): the board-intro "Pick a card to get this party started!"
— sky/mountains/trees/grass/castle all textured correctly; only the central **card/die** faces
render white with faint red character line-art. Specific texture *class* fails, not a global
texture failure. traps=0.

## Verdict: the palette-family prior is RIGHT about the ASSET, WRONG about the port mechanism

**CONFIRMED (asset side, bytes read):** the card-fan textures ARE palettized **CI8 + RGB565 TLUT**.
- `~/gc_refs/marioparty4/src/dolphin/.../hsfdraw.c:1775-1779` — dataFmt=9/pixSize=8 dispatches to
  `GXInitTlutObj(GX_TL_RGB565)` + `GXLoadTlut` + `GXInitTexObjCI(GX_TF_C8)`.
- `modesel.bin` subfile 0x00 bitmaps `card4`/`card3`: byte@0x08=0x09 (dataFmt), byte@0x09=0x08
  (pixSize). 32 of 39 card-fan bitmaps are CI8+RGB565-TLUT.
- `hsfload.c:936-938` binds the card palette into `bitmap_new->palData` (guest RAM) — the cards are
  **RAM-resident HSF assets**, not EFB copies and not memory-card banner blits.

**KILLED (port side, verified live):** "the WGPU backend drops / can't decode CI textures" — FALSE.
- `VideoBackends/WGPU/WGPUMain.cpp:52` `bSupportsPaletteConversion=false`, `:62`
  `bSupportsGPUTextureDecoding=false` — GPU decode + GPU palette-conversion are both OFF, which
  **forces the CPU decode path**.
- `VideoCommon/TextureCacheBase.cpp` (~1679/1717): `decode_on_gpu` is therefore false, so
  `TexDecoder_Decode(dst, GetData(), …, GetTextureFormat(), GetTlutAddress(), GetTlutFormat())`
  runs on the CPU **with the real TLUT** for every CI texture. A RAM-resident CI8 texture decodes
  correctly here. So "unhandled CI format" is not the bug.

**ALSO REFUTED (my verification, correcting the workflow):** the workflow proposed the primary root
as "EFB→RAM readback is a no-op stub (EFB never written to RAM) → CPU decodes stale/zero RAM →
uniform white." The live code refutes it:
- `WGPUTexture.cpp:278-305` `CopyFromTexture`/`Flush` are near-stubs, BUT the real EFB readback is
  **async**: `WGPUTexture.cpp:307-329` `ReadTexels` handles `m_pending_encode` + defers to a
  `wgpuBufferMapAsync` callback (`WGPUGfx.cpp:1172,1232`) that writes guest RAM on encode
  completion, and the encode IS scheduled — `WGPUTextureCache.h:287` `wst->m_pending_encode =
  &ctx->pending;`. So EFB copies DO reach guest RAM (async). Don't "implement the readback" — it
  exists.

**The `:1421` palette-reject is real but doesn't bite the cards.** `TextureCacheBase.cpp:1420-1421`:
`(base_hash==entry->hash && (!GetPaletteSize() || bSupportsPaletteConversion))` is FALSE for a
palettized reference of an EFB copy (since bSupportsPaletteConversion=false) → EFB-copy-as-CI is not
reused → stale-RAM CPU decode → white. This ONLY fires when a CI texture's address is owned by an
EFB copy. The cards are RAM assets, so unless a cache **address collision** makes a card texture
alias an EFB-copy entry, this branch isn't taken.

## Where that leaves it — a RUNTIME question the static read cannot settle

RAM-resident CI8 cards SHOULD decode correctly on the CPU with their TLUT, yet they're white. The
fault is therefore in the runtime DATA reaching the decoder, NOT the decode code. Surviving
candidates (all runtime):
1. **TLUT data-flow:** `GetTlutAddress()`/`GetTlutFormat()` (TMEM tracking from the game's
   `GXLoadTlut` → BP TLUT load) points at stale/wrong palette → structured indices decoded through a
   bad palette → mostly white. (My screenshot's faint-red structure is *consistent* with this but
   can't disambiguate texture-structure from red die geometry/vertex-color.)
2. **Cache address collision:** the card texture aliases an EFB-copy entry → `:1421` reject → stale.
3. **Texture-cache bind / hash** returning the wrong entry.

## Fix direction (CORRECTED from the order's expectation)

It is **NOT** "add TLUT/palette support to WGPU" — that path is present and forced-on. It is a
runtime TLUT-dataflow / bind bug on RAM-resident CI textures. Do not build "implement
WGPUStagingTexture readback" (it's wired) or "add CPU CI decode" (it's wired).

## Three-symptom link — WEAKENED, not confirmed

The palette-family united the three at the ASSET level, but the port roots diverge:
- **Cards:** RAM CI8, CPU decode present → runtime TLUT/bind bug.
- **Black minigame:** EFB copies happen and the async readback IS wired → likely a present/async-
  timing issue, NOT "readback missing."
So "one fix, three symptoms" is unlikely as stated. Confirm per-symptom before merging.

## The ONE decisive probe (needs an instrumentation build)

At the CPU decode site (`TextureCacheBase.cpp` ~1717), for the first ~40 CI decodes in the card
scene, log: `GetTextureFormat()`, `GetTlutAddress()` + first TLUT words, first index-data words, a
uniform-vs-structured check on `dst_buffer`, and whether an EFB-copy entry was matched/rejected at
that address (`:1421`). Interpretation:
- CI8 + EFB-copy rejected at its address → coupled EFB-copy-as-CI (address collision).
- CI8, pure RAM, TLUT bytes zero/stale → **TLUT data-flow bug** (leading suspect).
- CI8, TLUT sane, dst structured-correct but still white on screen → texture-bind/sampler.
- non-CI → not palette at all.
Build via canonical build-wasm-4010 → dolphin_worker_link_4010.sh → probe ROM_IDX=0,
PROBE_LOAD_STATE=(4).gcs.gz, PROBE_HEADLESS=0.

Method note: the static pass did its job — confirmed the asset class, killed two wrong theories
(unhandled-CI, EFB-stub), and narrowed to a runtime question with a precise probe. Confidence
medium; the probe is the confirmer.

## PROBE RESULTS (2026-08-14) — the palette-family hypothesis is MEASURED-FALSE

Instrumented the CPU decode site (`TextureCacheBase.cpp:1717`) via SAB cells at 0x026B3B00 (the
video/device thread's console does NOT relay to puppeteer — SAB is the channel). Loaded
`(4).gcs.gz`, card menu (omcurovl=0x4a), traps=0. Readout:
```
dec=42 ci=27 uniform=10
maxCI:       576x480 C8 tlutfmt=RGB5A3 idx=0x0 tlut=0xf8feffff px0=pxm=pxl=0xffffffff structured=0
efbPalReject=0
maxStructCI: 128x256 px0=0xff8cbeef (opaque skin-tone)
```

**Five theories now killed (asset-CI was the only true part of the prior):**
1. unhandled-CI — CPU decode path present + forced-on (static).
2. EFB-readback-stubbed — async readback wired (static).
3. cache-hashes-texture-not-TLUT — `full_hash=base_hash^hash(TLUT)`, hit test requires it (static).
4. TLUT-stale/zero/0xFFFF — **measured** a real varied RGB5A3 palette (`0xf8feffff`), not white/zero.
5. matched-dim EFB-copy-palette-reject — **measured** `efbPalReject=0` (never fired).

**What IS measured:** the CI DECODER WORKS — a 128x256 CI decodes to real structured skin-tone
content (`0xff8cbeef`). But a 576x480 (non-power-of-2, render-target-shaped) CI8 texture decodes to
UNIFORM WHITE because its backing index-data RAM (`GetData()`) reads ZERO (`idx=0x0` → palette
entry 0 = `0xffff` = opaque white in RGB5A3). So the failure is **texture DATA, not texture
format/palette/cache/decoder** — content that should be in guest RAM isn't there at decode time.

**The visible die faces** show white WITH faint red character line-art — a *structured* texture
decoding to mostly-white (portrait fill missing, outline surviving), which is a third category
distinct from the uniform-white 576x480 and the correct 128x256. So the die-face texture is not yet
individually isolated; the measured 576x480-zeroed-RAM texture is the concrete instance of the
data-not-populated class.

**Fix DIRECTION (corrected again):** not palette/format support (all exonerated) — it is
**texture-data population**: GPU-rendered / DMA'd content not reaching the guest RAM that the CPU
texture-decode samples (render-target-shaped dims + zeroed RAM). Whether this shares the
black-minigame's present/readback root is plausible but unproven (efbPalReject=0 rules out the exact
matched-dim sub-case). NEXT STEP = texture→draw correlation to isolate the exact die-face texture
and whether its RAM is zeroed (data) or decoded-fine-but-bound-wrong (bind). Instrumentation is live
in the worker (STRIP markers `[cardtex probe 2026-08-14]`); strip before any perf measurement.

## READBACK-RACE TIMELINE (order 14e) — race KILLED + a measurement-scoping error found

Built a three-way timeline (EFB-copy issue / async readback land / CPU decode) + an address-keyed
PENDING-SET (RAM copies issued-but-not-landed). Result on the white 576x480 texture (dataPtr stable
`0x1b69f5a0`):
```
efbCopies~7000  ramCopies~3500  lands~3500 (all land)  |  match=0  pendingMatch=0  ram@decode=0
```
- **Readback race KILLED**: `pendingMatch=0` — no RAM readback pending for this address at decode;
  and every RAM copy lands (`lands==ramCopies`). Not the one-frame race order 14e predicted.
- **`ram@decode=0` = my capture mis-targeted.** The probe boots MP4 ~25s (thousands of EFB copies)
  before loading the card savestate; a decode at ram-copy-count 0 happened during **early boot**, not
  the card menu. The "largest CI across the whole run" heuristic grabbed a **boot-time render-target**
  (576x480, uniform white) — a RED HERRING, not the die face. The die face is uniform-white's
  opposite: white **with red structure** (`structured=1`), never captured.
- Net: 6 theories now dead (unhandled-CI, EFB-stub, cache-key, TLUT-stale, EFB-palette-reject,
  readback-race). The CI pipeline is clean. The die-face texture itself remains UNMEASURED.

**Corrected NEXT step:** SCENE-GATED capture — reset the SAB cells on savestate-load (or gate on
omcurovl=0x4a) so only card-menu decodes are captured, and target the die-face signature
(structured, mostly-white). Only then does the timeline run on the RIGHT texture. This is a
measurement-scoping fix, not a new hypothesis. Instrumentation live (STRIP markers).

## SCENE-GATED RESULT (corrected) — the card-menu textures DECODE CORRECTLY; bug is DOWNSTREAM

Reset the SAB capture cells right after the savestate load (probe-side, JS-only) so only CARD-MENU
decodes are captured (excludes boot). Result:
```
dec=41 ci=25 uniform=8  maxCI = 128x256  C8  tlutfmt=RGB565  idx=0x03020100  tlut=0x8fedf1ed
                        px0=0xff8cbeef px1/2=0xff5a9ed6 pxl=0xff9cc3e7  structured=1
```
The 576x480 uniform-white texture is GONE (it was boot). The largest card-menu CI texture is
128x256 (portrait-sized), C8 + **RGB565** TLUT (matching the decomp's hsfdraw.c:1773 card path), with
**REAL index data** (idx=0x03020100, sequential — not zeroed), a real varied palette, and THREE
DIFFERENT decoded skin-tone pixels (`structured=1`). **The card-menu portrait textures decode
correctly in the port.**

**Verdict: the decode / data / palette / cache pipeline is CLEAN for the card menu (measured). The
white die faces are DOWNSTREAM of decode — a texture-BIND / sampler / TEV fault in the WGPU draw
path** (the correctly-decoded portrait isn't reaching the die's pixels). This is order 14c/14d's
branch 3 ("everything correct through decode yet white → bind-path"). Screenshot on the same run
still shows the white-with-red die → the correct texture exists in the cache but isn't sampled onto
the die.

**Theories killed (7):** unhandled-CI, EFB-readback-stub, cache-key-TLUT, TLUT-stale,
EFB-palette-reject, readback-race, texture-data-zeroed(card-menu). The original palette-family
direction (14c) and both data-population directions are all measured-false. **Fix lane = WGPU texture
BIND/sampler/TEV**, NOT texture data or format. NEXT = texture→draw correlation: log which cache
entry the die's draw binds (is it the correct 128x256 portrait entry, or a white/default/wrong bind).
Instrumentation live (STRIP markers `[cardtex probe 2026-08-14]`) — strip before perf.

## MULTI-TEXTURE BIND-LOG (order 14f) — native-named config + a targeting wall

Native reference: FifoRecorder-from-cardMenu.sav is BLOCKED (savestate 5.0-20240 won't load in the
eb44b64 oracle — confirmed fresh boot; no nogui fifo trigger). Pivoted to the DECOMP as native-source
reference: the die-face material is MULTI-TEXTURE — HsfMaterial numAttrs>=2, attribute i ->
GX_TEXMAP i, own TEV stage (hsfdraw.c:1113-1451, :598, :1123). So portrait + line-art on separate
texmap slots; symptom (portrait white / line-art red-correct) fits a per-slot fault.

Port bind-log at TextureCacheBase::BindTextures (VertexManagerBase.cpp:643): captured the LARGEST
card-menu multi-texture draw (sig=53248): `texgens=2 TM0[used,entry,@91d580,128x128]
TM1[used,entry,@792cc0,192x192]`. **Both texmaps used AND both have valid cache entries** -> the
"null tentry -> skipped SetTexture -> stale white slot" sub-case is NOT occurring on this draw; where
slots are used they're populated. IF this were the die, the fault would be downstream (WGPU
SetTexture / bind-group / uber-shader texture wiring), not the cache bind.

**TARGETING WALL (honest):** the captured draw binds 128x128+192x192, but the known-correct portrait
is 128x256 — different textures. With 60,404 multi-texture draws in the card menu, "largest by
signature" is an unreliable die discriminator (3rd mis-target: boot-tex, largest-CI, largest-multi-
tex). The exact DIE-FACE draw + which specific texture it samples + whether THAT texture's content is
white are still unpinned.

**Solid after 7 builds:** CI decode pipeline clean (128x256 portrait decodes correct); die is multi-
texture; 8 theories dead (+readback-race, +card-menu-data-zeroed, +null-slot-bind on the sampled
draw). NOT yet named: the die-face-specific texture/draw and the white mechanism.
**Focused next step (needs a discriminator, not "largest"):** key the capture by a specific texture
ADDRESS — add the portrait's addr to the decode capture, then log the draw that BINDS that addr +
that texture's decoded content (white vs structured). OR a WGPU uber-shader texture-wiring audit
(are all used texmaps actually wired to the shader, or does only slot 0 reach it). Instrumentation
live (7 builds of `[cardtex probe 2026-08-14]` in TextureCacheBase.cpp + WGPUTextureCache.h) — strip
before any perf work; NOT committed.
