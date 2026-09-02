// [recomp-live 2026-08-25] The decomp->wasm recomp running in a dedicated Web Worker — the
// CPU half of the live browser pipeline. Boots mp4_game.wasm with the full host layer
// (ported from recomp_probe.mjs), serves DVD reads from the split ROM parts (the deployed
// gamecube/roms/MarioParty4.bin.parta* — the TRIMMED image; pair with mp4_fst_trimmed.bin),
// and per game frame:
//   - scans the frame's GP-FIFO for NEW display lists and NEW vertex-array bindings,
//     walks new DLs once to size their arrays exactly (maxIndex+1)*stride, and byte-swaps
//     f32-based arrays LE->BE into shadow copies,
//   - posts {fifo, regions} to the page (transferables), which forwards to dolphin_worker's
//     'recompFrame' handler (RAM region writes + recomp_render_fifo + recomp_present),
//   - reads pad input from a SAB the page's keyboard handlers write,
//   - paces via Atomics.wait on the SAB until the page grants the next frame budget.
// Message in: {cmd:'boot', parts:[ArrayBuffer x6], fst:ArrayBuffer, glueUrl, wasmUrl,
//              pace:SharedArrayBuffer, stage:SharedArrayBuffer?, card:ArrayBuffer?}
//              pace i32[0]=frame-credits i32[1]=btn i32[2]=dstk i32[3]=stkx i32[4]=stky
//              i32[5]=uncapped i32[8]=held-stkx i32[9]=held-stky, and the savestate channel
//              i32[10]=cmd i32[11]=total i32[12]=chunkLen i32[13]=seq i32[14]=consumed
//              i32[15]=status (see the SAVE STATES block).
//            | {cmd:'cardLoad', img:ArrayBuffer}  swap the live memory-card image (import)
//            | {cmd:'cardDump'}                   snapshot the live card out right now
//            NOTE: inbound messages are only serviced BEFORE Module._main() is called — after
//            that this worker never returns to its event loop (see SAVE STATES).
// Message out: {cmd:'frame', fifo, regions:[{addr,bytes}], n} | {cmd:'log', txt}
//            | {cmd:'audioRate', rate}                 output sample rate, sent once at boot
//            | {cmd:'audio', buf:ArrayBuffer, len}     int16 stereo PCM, `len` in BYTES
//            | {cmd:'card', seq, img:ArrayBuffer}  2 MiB .raw memory-card image to persist
//            | {cmd:'stateSaved', n, buf} | {cmd:'stateLoadReady'} | {cmd:'stateRestored', n}
//            | {cmd:'stateError', op, txt}

let Module = null, viRetrace = 0;
let paceI32 = null;
let inputScript = null;   // frame -> [btn, dstk, stkx, stky] canned choreography (?board=1)
let peekAddrs = null;      // debug: guest offsets to hex-dump every 1200 frames (boot msg)
let testFullMem = false;   // debug: ship full mem1 every frame (fixture-equivalence bisect)
let XF_SHADOW_ALL = false; // matrix-memory shadow BROKE glyph texgen state (2026-08-26 bisect); registers-only
let parts = [], fstBuf = null;
const PART_SIZE = 104857600;   // 100MiB fixed part boundaries (gamecube.html chunkRange)

// ---- AUDIO transport (page AudioWorklet ring) -------------------------------------------
// THE STATE OF THIS PATH, so nobody reads sound out of it that isn't there. [2026-09-02] THE
// SHIPPED gamecube/recomp/mp4_game.wasm IS STILL SILENT, and that is now a DELIBERATE choice
// rather than a missing feature: the audio build exists, it works, and it is held back because
// it breaks the game one screen later. Measured, both arms hash-guarded, box load 4.0-5.3:
//   * RECOMP_MUSYX=1 build, title screen — audible YES: 63.55 s audible, 2,035,503 audible
//     frames, 0 gaps, 0 discontinuities, peak 0.0758, at speed 1.000x / 60 shown / 60
//     published. (tools/audio_probe.mjs; its tap validated 12/12 by tools/audio_tap_selftest.)
//   * THE SHIPPED build, same page, same scene — 0 audible out of 2,596,864 RENDERED frames,
//     also 1.000x / 60 / 60. So silence here is real silence, not a dead instrument: the
//     transport below is healthy and pushing ~26,900 PCM frames/s of zeros.
//   * RECOMP_MUSYX=1 build, one screen later — pressing Start and advancing into the
//     file-select flow TRAPS with `main stopped: memory access out of bounds` (logged by this
//     worker), after which the page reads 0 shown / 0 published and speed decays to 0.24x
//     STARVED. 2 of 2 runs; the shipped and HEAD-default builds survived the same scripted
//     journey at 1.00x / 60 published and logged no trap, 0 of 2 each.
// See gamecube/recomp/build_wasm.sh's header for the re-gating recipe. The one thing to carry
// forward: A TITLE-SCREEN AUDIO MEASUREMENT CANNOT SEE THAT BUG. Do not ship an audio build on
// a title-only pass.
//
// Why compiling MusyX in was necessary but not sufficient: on real hardware MusyX mixes on the
// DSP — hw_dolphin.c hands salBuildCommandList's output to the `dspSlave` microcode
// (dsp_import.c:4, 0x19E0 bytes of GC-DSP code) — and the MUSY_TARGET_PC backend is a stub,
// not a software renderer (hw_pc.c:89 salAiGetDest returns NULL). Three pieces closed it, all
// under RECOMP_MUSYX: a software AX-style mixer over the _PB voice blocks (gc_musyx_mix.c), a
// SAL backend + AI DMA model (gc_musyx_hw.c, gc_musyx_ai.c), and big-endian swappers for
// /sound/mpgcsnd.msm and the sequences (gc_musyx_bswap.c, gc_musyx_song_bswap.c).
//
// ALSO OPEN, AND NOT THE SAME BUG: the sound is QUIET — title music peaks at 0.0758
// (~-22 dBFS). It is NOT a global attenuation; the same build peaked 0.9037 later in the menu
// flow. Two unverified candidates: (a) the mixer renders only the DRY stereo mix, so aux sends
// (reverb/chorus), surround and studio-to-studio inputs contribute nothing; (b) OSGetSoundMode
// reads an all-zero emulated SRAM (EXILock is a `return 0` host stub, so OSRtc.c:100 ReadSram
// never fills it), so msmsys.c:909 selects MONO and every voice pans dead centre
// (synth.c:670-692) instead of the SURROUND audio.c:62 would otherwise pick. Do not paper over
// the level with a gain here — that would hide whichever one it is.
//
// The transport itself: this worker -> {cmd:'audio'} -> gamecube.html ->
// window._gcAudioPushSamples -> the SAB ring -> /gamecube/audio-worklet.js -> ctx.destination.
// `?audiotest=1` feeds it a synthetic tone so the wiring can be PROVEN independently of the
// engine (it is NOT game audio and must never be quoted as evidence that the game has sound).
//
// GATE #9: the sample count is derived from viRetrace — EMULATED time — never from
// performance.now(). Audio therefore cannot pull, push or stretch the guest clock, and
// frames/s divided by 32000 is an independent witness of the guest rate (the GameCube
// analogue of Dreamcast's AICA witness).
const AUDIO_RATE = 32000;      // MusyX's own output rate: hw_pc.c:76 / hw_dolphin.c:77 *outFreq
let audioTest = false;         // ?audiotest=1 — synthetic tone, transport self-test only
let audioAcc = 0;              // fractional carry so 60 frames emit exactly AUDIO_RATE samples
let audioPhase = 0;

const log = (txt) => postMessage({ cmd: 'log', txt: '[recomp-worker] ' + txt });

// One emulated video frame's worth of audio, posted to the page's worklet ring. Called from
// VIWaitForRetrace, right after viRetrace++, so the sample count is a function of EMULATED
// time alone (gate #9). The carry keeps 60 consecutive retraces at exactly AUDIO_RATE
// samples (533,533,534,... ) instead of truncating 533.33 and drifting 20 samples/second flat.
function pumpAudio() {
  audioAcc += AUDIO_RATE;
  const n = (audioAcc / 60) | 0;
  audioAcc -= n * 60;
  if (n <= 0) return;
  let pcm = null;
  // ENGINE PATH (not yet built — see the AUDIO transport note at the top of this file). When a
  // software mixer exists it stages int16 stereo frames inside the wasm heap and returns how
  // many it actually produced; copy them out because the heap can move on a memory growth.
  if (Module && Module.___recomp_audio_pump && Module.___recomp_audio_base) {
    const got = Module.___recomp_audio_pump(n) | 0;
    if (got > 0) {
      const base = Module.___recomp_audio_base() >>> 0;
      pcm = new Int16Array(Module.wasmMemory.buffer.slice(base, base + got * 4));
    }
  }
  // TRANSPORT SELF-TEST (?audiotest=1). A 440 Hz sine at 0.15 full scale, phase-continuous
  // across frames so tools/audio_probe.mjs reads 0 discontinuities and 0 gaps when the whole
  // chain is healthy. This is NOT game audio and never runs without the query parameter.
  if (!pcm && audioTest) {
    pcm = new Int16Array(n * 2);
    const step = (2 * Math.PI * 440) / AUDIO_RATE;
    for (let i = 0; i < n; i++) {
      const s = (Math.sin(audioPhase) * 4915) | 0;
      pcm[i * 2] = s; pcm[i * 2 + 1] = s;
      audioPhase += step;
      if (audioPhase > 2 * Math.PI) audioPhase -= 2 * Math.PI;
    }
  }
  if (!pcm) return;
  postMessage({ cmd: 'audio', buf: pcm.buffer, len: pcm.byteLength }, [pcm.buffer]);
}

// ---- memory card (gamecube/recomp/shims/src/gc_card.c) ----------------------------------
// gc_card.c owns a 2 MiB RAM image that IS a real .raw GameCube memory card. The host's two
// jobs: (1) seed the persisted image into [base, base+size) BEFORE Module._main(), because
// CARDInit runs INSIDE main (via HuCardInit) and adopts whatever is there — after main starts
// it is too late; (2) snapshot it back out once the shim's dirty counter goes quiet, so a
// save lands in IndexedDB without writing 2 MiB to the page on every frame of a save.
// ALLOW_MEMORY_GROWTH is on, so wasmMemory.buffer is DETACHED and replaced by every heap
// growth: never cache it, always re-read Module.wasmMemory.buffer, and copy out with .slice()
// (which also yields a fresh transferable ArrayBuffer, since the wasm memory itself is not).
let cardBase = 0, cardSize = 0, cardSeq = 0;
let cardQuiet = -1;                    // -1 = nothing pending; >=0 = frames since last change
const CARD_QUIET_FRAMES = 45;          // ~0.75s at 60fps: past the end of a multi-write save

function cardSnapshot() {
  if (!Module || !cardBase) return false;
  const img = Module.wasmMemory.buffer.slice(cardBase, cardBase + cardSize);
  postMessage({ cmd: 'card', seq: cardSeq, img }, [img]);
  return true;
}

function cardPoll() {
  if (!cardBase || !Module.___recomp_card_seq) return;
  const s = Module.___recomp_card_seq() >>> 0;
  if (s !== cardSeq) { cardSeq = s; cardQuiet = 0; return; }   // still writing
  if (cardQuiet < 0 || ++cardQuiet < CARD_QUIET_FRAMES) return;
  cardQuiet = -1;
  if (cardSnapshot()) log('memcard: snapshot at seq ' + cardSeq);
}

// Live image swap (page "Import Card"). Re-runs the shim's adopt so the new directory/FAT are
// picked up; the game re-mounts before every save/load operation, so this takes effect at the
// next SLCardMount without a reload.
function cardLoad(buf) {
  if (!Module || !cardBase) { log('memcard: import ignored (not booted yet)'); return; }
  const u8 = new Uint8Array(buf);
  if (u8.length !== cardSize) {
    log('memcard: import rejected — ' + u8.length + 'B, want ' + cardSize + 'B'); return;
  }
  new Uint8Array(Module.wasmMemory.buffer, cardBase, cardSize).set(u8);
  const ok = Module.___recomp_card_adopt ? Module.___recomp_card_adopt() : 0;
  cardSeq = Module.___recomp_card_seq ? Module.___recomp_card_seq() >>> 0 : cardSeq;
  cardQuiet = -1;                      // the page already holds these bytes; nothing to persist
  log('memcard: imported ' + cardSize + 'B, adopt=' + ok);
}

// ---- GX state tracking for incremental region sync --------------------------------------
let vcdLo = 0, vcdHi = 0;
const vatA = new Array(8).fill(0);
const arrayBase = new Array(16).fill(0), arrayStride = new Array(16).fill(0);
const knownDLs = new Map();          // guest addr -> {size, keys:Set} (walked+synced)
const knownArrays = new Map();       // "base|stride" -> synced byte count so far
const pairSeen = new Map();          // per-frame: "base|stride" -> {base, stride} from B0 writes
// BP texture state: SETIMAGE0 (0x88-0x8B tex0-3, 0xA8-0xAB tex4-7) w/h/fmt per slot;
// SETIMAGE3 (0x94-0x97, 0xB4-0xB7) base>>5 per slot. TLUT loads: 0x64 src>>5, 0x65 tmem+count.
const texImg0 = new Array(8).fill(0);
const texBound = new Map();          // phys base -> byte size (bound this frame)
let tlutSrc = 0;
const knownTex = new Map();          // phys base -> {size, lastSync}
let staticTop = 0;                   // wasm data-segment end (__recomp_static_top): binds below
                                     // it are compiled-in .inc assets, sourced from low memory
// GX texture format -> bits per texel (tile-padded dims give the safe overestimate)
const TEX_BPP = { 0: 4, 1: 8, 2: 8, 3: 16, 4: 16, 5: 16, 6: 32, 8: 4, 9: 8, 10: 16, 14: 4 };
const gxShadow = { cp: new Map(), xf: new Map(), bp: new Map() };  // for the takeover prologue
let sentPrologue = false;
let cacheDirty = false;   // set on any DVD read: the heap turns over on scene loads, and every
                          // address-keyed cache (DLs/arrays/textures) is invalid — resnapshot.

const FMT_SZ = [1, 1, 2, 2, 4];
const COL_SZ = [2, 3, 4, 2, 3, 4];
function attrList(vat) {
  const va = vatA[vat];
  const list = [];
  const posT = (vcdLo >> 9) & 3, nrmT = (vcdLo >> 11) & 3, c0T = (vcdLo >> 13) & 3, c1T = (vcdLo >> 15) & 3;
  if (vcdLo & 1) list.push({ sz: 1 });
  for (let i = 0; i < 8; i++) if (vcdLo & (1 << (1 + i))) list.push({ sz: 1 });
  const push = (t, directSz, arrIdx) => {
    if (t === 1) list.push({ sz: directSz });
    else if (t === 2) list.push({ sz: 1, idx: arrIdx });
    else if (t === 3) list.push({ sz: 2, idx: arrIdx });
  };
  push(posT, (((va & 1) ? 3 : 2)) * FMT_SZ[(va >> 1) & 7], 0);
  push(nrmT, ((((va >> 9) & 1) ? 9 : 3)) * FMT_SZ[(va >> 10) & 7], 1);
  push(c0T, COL_SZ[(va >> 14) & 7], 2);
  push(c1T, COL_SZ[(va >> 18) & 7], 3);
  for (let i = 0; i < 8; i++) {
    const tT = (vcdHi >> (2 * i)) & 3;
    const dsz = i === 0 ? (((va >> 21) & 1) ? 2 : 1) * FMT_SZ[(va >> 22) & 7] : 8;
    push(tT, dsz, 4 + i);
  }
  return list;
}

// Walk one GX stream (frame or DL body): update reg shadows, collect new DLs, and for
// indexed draws track max index per bound array. buf = Uint8Array, guest = whether offsets
// are guest addresses (DL bodies) — used only for labels.
function rdU16b(buf, o) { return (buf[o] << 8) | buf[o + 1]; }
function rdU32b(buf, o) { return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0; }
function walkStream(mem, buf, start, end, depth, newDLs, touched) {
  let p = start;
  // [perf 2026-08-28] these were closures over `buf`, rebuilt on EVERY call —
  // and walkStream recurses once per display list. Module-scope helpers taking
  // buf explicitly let V8 inline them instead.
  const rdU16 = (o) => rdU16b(buf, o);
  const rdU32 = (o) => rdU32b(buf, o);
  while (p < end) {
    const op = buf[p++];
    if (op === 0x00) continue;
    else if (op === 0x08) {
      const a = buf[p], v = rdU32(p + 1); p += 5;
      gxShadow.cp.set(a, v);
      if (a === 0x50) vcdLo = v; else if (a === 0x60) vcdHi = v;
      else if (a >= 0x70 && a <= 0x77) vatA[a - 0x70] = v;
      else if (a >= 0xA0 && a <= 0xAF) arrayBase[a - 0xA0] = v;
      else if (a >= 0xB0 && a <= 0xBF) {
        arrayStride[a - 0xB0] = v;
        // FIXTURE-PARITY array discovery: every stride write pairs with its slot's current
        // base — collect the pair regardless of DLs. (Index-walk extents missed every
        // re-bound DL invocation; the fixture's linear pair scan + clip extents renders
        // everything correctly and is now the live policy too.)
        const b0 = arrayBase[a - 0xB0];
        if (b0 && v) pairSeen.set((b0 >>> 0) + '|' + (v >>> 0), { base: b0 >>> 0, stride: v >>> 0 });
      }
    }
    else if (op === 0x10) {
      const hdr = rdU32(p); p += 4;
      const count = (hdr >>> 16) + 1, xfAddr = hdr & 0xFFFF;
      // Shadow ALL XF writes — including matrix memory (< 0x1000). Matrix slots the game
      // loads once per scene (UI ortho, static camera) live only in the frame that set
      // them; a skipRender'd frame dropped them forever (skips>0 corrupted every scene,
      // skips=0 was pixel-perfect — 2026-08-26 bisect).
      if (XF_SHADOW_ALL || xfAddr >= 0x1000)
        for (let k = 0; k < count; k++) gxShadow.xf.set(xfAddr + k, rdU32(p + 4 * k));
      p += 4 * count;
    }
    else if (op === 0x61) {
      const v = rdU32(p); p += 4;
      const reg = (v >>> 24) & 0xff, val = v & 0xffffff;
      gxShadow.bp.set(reg, val);
      let slot = -1;
      if (reg >= 0x88 && reg <= 0x8B) { texImg0[reg - 0x88] = val; }
      else if (reg >= 0xA8 && reg <= 0xAB) { texImg0[4 + (reg - 0xA8)] = val; }
      else if (reg >= 0x94 && reg <= 0x97) slot = reg - 0x94;
      else if (reg >= 0xB4 && reg <= 0xB7) slot = 4 + (reg - 0xB4);
      else if (reg === 0x64) tlutSrc = (val << 5) >>> 0;
      else if (reg === 0x65) {
        // TLUT load: count field (bits 10-20) x 32B from tlutSrc
        const n32 = (val >>> 10) & 0x7FF;
        if (tlutSrc && n32) texBound.set(tlutSrc, Math.max(texBound.get(tlutSrc) || 0, n32 * 32));
      }
      if (slot >= 0) {
        const base = (val << 5) >>> 0;
        const i0 = texImg0[slot];
        const w = ((i0 & 0x3FF) + 1), h = (((i0 >>> 10) & 0x3FF) + 1), fmt = (i0 >>> 20) & 0xF;
        const bpp = TEX_BPP[fmt] || 32;
        // EXACT base-level size, tile-padded — no mip fudge. The old +34% "mip headroom"
        // made the RAW texture sync overrun into whatever follows the texture in the heap,
        // stomping the head of just-swapped f32 vertex arrays with LE bytes (the live-only
        // persistent world garbage; the fixture never syncs textures and was immune).
        // Mip chains beyond level 0 may sync stale — refine with SETIMAGE1's TMEM size if
        // mip shimmer shows up.
        const wp = (w + 7) & ~7, hp = (h + 7) & ~7;
        const size = (wp * hp * bpp) >> 3;
        if (base) texBound.set(base, Math.max(texBound.get(base) || 0, size));
      }
    }
    else if (op >= 0x20 && op <= 0x38 && (op & 7) === 0) p += 4;
    else if (op === 0x48) continue;
    else if (op === 0x40) {
      const addr = rdU32(p), size = rdU32(p + 4); p += 8;
      if (depth > 0) continue;
      if (size > 0) {
        // Walk once PER (DL, binding signature) — NOT once per DL. Hu3D re-calls the same
        // DL with different CP array bindings per model piece; walk-once-per-address left
        // every re-bound invocation's arrays untouched and unswapped (the worker only ever
        // discovered ~270 of the frame's 726 arrays — the live world's raw-LE ribbons).
        // Key on the attribute bases indexed draws actually use (pos/nrm/clr0/tex0).
        const bk = arrayBase[0] + '|' + arrayBase[1] + '|' + arrayBase[2] + '|' + arrayBase[4];
        let ent = knownDLs.get(addr);
        if (!ent) { ent = { size, keys: new Set() }; knownDLs.set(addr, ent); }
        if (!ent.keys.has(bk)) {
          ent.keys.add(bk);
          if (ent.keys.size === 1) newDLs.push({ addr, size });   // sync DL bytes once
          const ofs = addr & 0x01FFFFFF;
          const gm = new Uint8Array(mem.buffer, 0x80000000 + ofs, size);
          walkStream(mem, gm, 0, size, depth + 1, newDLs, touched);
        }
      }
    }
    // [perf 2026-08-28] was: [0x80,0x88,...,0xB8].includes(op & 0xF8) — an array
    // literal ALLOCATED and linearly scanned on every draw opcode (1300 draws/frame).
    // Those eight values are the multiples of 8 in [0x80,0xB8] and (op & 0xF8) is
    // already a multiple of 8, so the test is exactly this range check.
    else if (op >= 0x80 && op <= 0xBF) {
      const vat = op & 7, n = rdU16(p); p += 2;
      // array extents come from the clip heuristic now (fixture parity) — draws just skip
      const attrs = attrList(vat);
      let perVert = 0;
      for (const a2 of attrs) perVert += a2.sz;
      p += n * perVert;
      if (p > end) { log('DRAW OVERRUN in walk'); return; }
    }
    else { log('walk: unknown op 0x' + op.toString(16) + ' at +0x' + (p - 1).toString(16)); return; }
  }
}

function buildPrologue() {
  const pro = [];
  const pu8 = (v) => pro.push(v & 0xff);
  const pu32 = (v) => { pu8(v >>> 24); pu8(v >>> 16); pu8(v >>> 8); pu8(v); };
  for (const [a, v] of gxShadow.cp) { pu8(0x08); pu8(a); pu32(v); }
  // XF entries: coalesce consecutive addresses into multi-word LOAD_XF_REG runs — matrix
  // memory arrives as 12-word bursts, and one-word-per-command would triple the prologue.
  {
    const keys = [...gxShadow.xf.keys()].sort((x, y) => x - y);
    for (let i = 0; i < keys.length; ) {
      let j = i + 1;
      while (j < keys.length && keys[j] === keys[j - 1] + 1 && j - i < 16) j++;   // XF count field is 4 bits
      pu8(0x10); pu32(((j - i - 1) << 16) | keys[i]);
      for (let k = i; k < j; k++) pu32(gxShadow.xf.get(keys[k]));
      i = j;
    }
  }
  for (const [r, v] of gxShadow.bp) { pu8(0x61); pu32(((r & 0xff) << 24) | (v & 0xffffff)); }
  // GXInit-era XF matrix-memory defaults the game writes ONCE at boot — outside every
  // captured frame, so the shadow never sees them. The sprite/glyph texgens reference
  // GX_IDENTITY (slot 60 = XF addr 0xF0) and GX_PTIDENTITY (post-transform 0x5F4); stale
  // decoder memory there collapsed the glyph T coordinate into full-height bars.
  const ONE = 0x3f800000;
  const ident = [ONE, 0, 0, 0, 0, ONE, 0, 0, 0, 0, ONE, 0];
  for (const base of [0xF0, 0x5F4]) {
    pu8(0x10); pu32(((ident.length - 1) << 16) | base);
    for (const w of ident) pu32(w);
  }
  return new Uint8Array(pro);
}

// Copy an array region, swapping f32-based strides (8/12) LE->BE for Dolphin's vertex loader.
// HISTORY: mid-session the pools measured BE only because the HSF swapper's pristine-copy
// restore hole (ClusterProc <- unswapped data.file[0]) was re-BE-ing them per frame; with
// swapper Fixes A-D every GPU-visible pool is LE in guest memory (LE-everywhere), so the
// bridge owns the LE->BE conversion at the sync boundary. s8/rgba8 strides copy raw.
function swap4InPlace(out) {
  for (let k = 0; k + 4 <= out.length; k += 4) {
    const t0 = out[k]; out[k] = out[k + 3]; out[k + 3] = t0;
    const t1 = out[k + 1]; out[k + 1] = out[k + 2]; out[k + 2] = t1;
  }
}
const f32Arrays = [];   // [{b, e}] guest-phys intervals of known f32 (stride 8/12) arrays
function regionBytes(mem, base, stride, count) {
  const src = new Uint8Array(mem.buffer, 0x80000000 + (base & 0x01FFFFFF), count);
  const out = new Uint8Array(count);
  out.set(src);
  if (stride === 8 || stride === 12) {
    swap4InPlace(out);
    const b = base & 0x01FFFFFF;
    f32Arrays.push({ b, e: b + count });
  }
  return out;
}

// ---- SAVE STATES ------------------------------------------------------------------------
// The page's Save/Load buttons used to post to dolphin_worker unconditionally. In recomp mode
// dolphin is ONLY the WGPU renderer — the game is here — so those buttons captured and
// restored the renderer and the game never moved. gamecube.html now routes them to this
// worker; this section is the worker half.
//
// WHY A SAB COMMAND CELL AND NOT postMessage: once boot() calls Module._main() this worker
// NEVER returns to its event loop, so inbound messages are never serviced. The Hu scheduler's
// context switches are Emscripten Asyncify fibers and mp4_game.js drives them from a
// SYNCHRONOUS trampoline — `Fibers.trampoline(){...do{ Fibers.finishContextSwitch(fiber)
// }while(Fibers.nextFiber)}`, reached from `Asyncify.maybeStopUnwind()` — so the whole game
// runs inside one JS task, and the frame pacer then blocks the thread outright
// (`Atomics.wait(paceI32, 0, 0, 500)` in the VIWaitForRetrace stub below). postMessage OUT is
// unaffected (that is how frames ship). So the page pokes a command cell in the pace SAB and
// this worker services it at the one place its JS still runs: the per-frame VI stub.
//
// WHY THE SNAPSHOT IS TAKEN AND RESTORED AT THE VI PUMP POINT, IN PLACE:
//   * The wasm CALL STACK (frame locals) is not in linear memory and cannot be read from JS.
//     At the pump point the live chain is main -> HuSysDoneRender -> SwapBuffers ->
//     VIWaitForRetrace (decomp src/game/main.c:109 `HuSysDoneRender(retrace)` inside main's
//     while(1); src/game/init.c:192 HuSysDoneRender -> :215 SwapBuffers -> :226
//     VIWaitForRetrace — the ROOT context, not a Hu process fiber) and
//     NO live local carries state across that call: main's met0/met1/i are scratch reassigned
//     before their next use, and `retrace` was already consumed by the HuSysDoneRender call
//     that is on the stack. So overwriting linear memory under those three frames is sound
//     AT THIS POINT — and only at this point.
//   * Restoring in the SAME instance (rather than a fresh worker) is required, not just
//     cheaper: the suspended fibers' rewind-function ids live in linear memory
//     (`asyncifyData+8`, set by Asyncify.setDataRewindFunc) and are indices into the GLUE's
//     Asyncify.callStackIdToFunc map, which is per-instance JS state we cannot restore.
//     Same instance => the ids stay meaningful. It also means the disc parts and the module
//     never have to be re-fetched.
//
// INCLUDED in a state: every touched 64 KiB page of wasm linear memory (that is the guest
// MEM1 window at 0x80000000, the FST at 0x81C00000, the recomp's own .data/.bss incl. the
// ARAM array and the 2 MiB card image, the C heap, every fiber's C stack and Asyncify spill
// stack); the shadow-stack pointer (`emscripten_stack_get_current`, a wasm global, NOT in
// linear memory); viRetrace (the game's whole clock — OSGetTime/OSGetTick/VIGetRetraceCount
// are all derived from it); and the JS-side GX decoder state that the next frame's FIFO walk
// cannot re-derive on its own (vcdLo/vcdHi, vatA, arrayBase/arrayStride, texImg0, tlutSrc,
// staticTop, and the gxShadow cp/xf/bp register shadow that buildPrologue() emits).
//
// DELIBERATELY EXCLUDED:
//   * knownDLs / knownArrays / knownTex / texBound / pairSeen / f32Arrays — the incremental
//     region-sync caches. They describe what DOLPHIN has already been sent, and after a
//     restore dolphin's mirror is a different timeline. Carrying them over is exactly the
//     "the state loads but the picture never changes" failure, so the restore CLEARS them and
//     sets cacheDirty + sentPrologue=false, forcing a full mem1 + prologue resend next frame.
//   * The disc parts and the FST buffer — same worker, still loaded, byte-identical.
//   * The pace SAB cells — credits/buttons/stick are live input plumbing owned by the page,
//     not game state; the page resets its own in-flight bookkeeping on stateRestored.
//   * Memory-card JS state (cardSeq/cardQuiet, gamecube.html's GCRECOMPCARD store). The card
//     IMAGE is inside linear memory and so is restored; the card shim's own dirty counter is
//     restored with it, and the existing cardPoll() re-syncs IndexedDB on its own terms.
//   * Wasm mutable globals other than __stack_pointer — notably the stack-limit globals set
//     by emscripten_stack_set_limits. There is no getter export, so they cannot be read. They
//     are unchanged across the operation because save and restore both happen on the ROOT
//     context at the same call depth, and Fibers.finishContextSwitch resets them from the
//     (restored) fiber struct at the next context switch.
//   * Anything in the dolphin worker. It is the renderer; the forced full resync re-seeds it.
const ST_CMD = 10, ST_TOTAL = 11, ST_LEN = 12, ST_SEQ = 13, ST_CONSUMED = 14, ST_STATUS = 15;
const ST_PAGE = 65536;            // wasm page granularity; memory size is always a multiple
const ST_MAGIC = 'GCRECOMP';
const ST_VERSION = 1;
let stageSab = null;              // page-allocated staging SAB (inbound transport for load)

function stateWasmApi() {
  const w = Module && Module.wasmExports;
  if (!w || typeof w.emscripten_stack_get_current !== 'function'
         || typeof w._emscripten_stack_restore !== 'function')
    throw new Error('mp4_game.wasm does not export emscripten_stack_get_current/_restore — '
                  + 'this build cannot save or restore state');
  return w;
}

// Sparse page image of the whole linear memory. Exact (no layout heuristics): every 64 KiB
// page is tested for all-zero and only non-zero pages are stored, so untouched address space
// (the ~2 GiB hole between the C heap and the guest window) costs nothing but the scan.
function stateSnapshot() {
  const w = stateWasmApi();
  const buf = Module.wasmMemory.buffer;          // never cache: ALLOW_MEMORY_GROWTH detaches
  const memSize = buf.byteLength;
  const u32 = new Uint32Array(buf);
  const perPage = ST_PAGE >>> 2;
  const nPages = Math.ceil(memSize / ST_PAGE);
  const idx = [];
  for (let p = 0; p < nPages; p++) {
    const s = p * perPage, e = Math.min(s + perPage, u32.length);
    for (let i = s; i < e; i++) if (u32[i] !== 0) { idx.push(p); break; }
  }
  const hdr = {
    v: ST_VERSION, game: 'MarioParty4',
    memSize, page: ST_PAGE, pages: idx.length,
    sp: w.emscripten_stack_get_current() >>> 0,
    viRetrace, staticTop, vcdLo, vcdHi, tlutSrc,
    vatA: vatA.slice(), arrayBase: arrayBase.slice(), arrayStride: arrayStride.slice(),
    texImg0: texImg0.slice(),
    gxCp: [...gxShadow.cp], gxXf: [...gxShadow.xf], gxBp: [...gxShadow.bp],
  };
  const json = new TextEncoder().encode(JSON.stringify(hdr));
  const out = new Uint8Array(16 + json.length + 4 * idx.length + idx.length * ST_PAGE);
  const dvw = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = ST_MAGIC.charCodeAt(i);
  dvw.setUint32(8, ST_VERSION, true);
  dvw.setUint32(12, json.length, true);
  out.set(json, 16);
  let o = 16 + json.length;
  for (let i = 0; i < idx.length; i++) dvw.setUint32(o + 4 * i, idx[i], true);
  o += 4 * idx.length;
  const src = new Uint8Array(buf);
  for (let i = 0; i < idx.length; i++)
    out.set(src.subarray(idx[i] * ST_PAGE, idx[i] * ST_PAGE + ST_PAGE), o + i * ST_PAGE);
  log('state: snapshot f' + viRetrace + ' — ' + idx.length + '/' + nPages + ' pages ('
      + (out.length / 1048576).toFixed(1) + ' MB raw), sp=0x' + hdr.sp.toString(16));
  return out;
}

function stateApply(u8) {
  const w = stateWasmApi();
  if (!u8 || u8.length < 16) throw new Error('save state is truncated');
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(u8[i]);
  if (magic !== ST_MAGIC)
    throw new Error('not a recomp save state (header "' + magic.replace(/[^\x20-\x7e]/g, '?') + '")');
  const dvw = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ver = dvw.getUint32(8, true);
  if (ver !== ST_VERSION)
    throw new Error('save state version ' + ver + ', this build reads version ' + ST_VERSION);
  const jlen = dvw.getUint32(12, true);
  const hdr = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + jlen)));
  if (hdr.page !== ST_PAGE) throw new Error('save state page size ' + hdr.page + ' != ' + ST_PAGE);
  // INTEGRITY GATE, before anything destructive. The shadow-stack pointer at the VI pump point
  // is deterministic for a given build (main's address-taken met0/met1 frame + the two callee
  // frames). A mismatch means the state was captured at a DIFFERENT call context, and
  // restoring linear memory under the live frames would be silent corruption — refuse instead.
  const curSp = w.emscripten_stack_get_current() >>> 0;
  if ((hdr.sp >>> 0) !== curSp)
    throw new Error('shadow-stack pointer mismatch (state 0x' + (hdr.sp >>> 0).toString(16)
                  + ', live 0x' + curSp.toString(16) + ') — refusing to restore');
  if (hdr.memSize > Module.wasmMemory.buffer.byteLength) Module._emscripten_resize_heap(hdr.memSize);
  const buf = Module.wasmMemory.buffer;
  if (buf.byteLength < hdr.memSize)
    throw new Error('cannot grow wasm memory to ' + hdr.memSize + 'B');
  const need = 16 + jlen + 4 * hdr.pages + hdr.pages * ST_PAGE;
  if (u8.length < need) throw new Error('save state truncated: ' + u8.length + 'B, need ' + need + 'B');
  // Pages absent from the index were all-zero at save time and must be zero again, so zero
  // everything first — the restored image is then byte-exact, not a merge with this timeline.
  const dst = new Uint8Array(buf);
  dst.fill(0);
  let o = 16 + jlen;
  const pidx = new Uint32Array(hdr.pages);
  for (let i = 0; i < hdr.pages; i++) pidx[i] = dvw.getUint32(o + 4 * i, true);
  o += 4 * hdr.pages;
  for (let i = 0; i < hdr.pages; i++)
    dst.set(u8.subarray(o + i * ST_PAGE, o + (i + 1) * ST_PAGE), pidx[i] * ST_PAGE);
  w._emscripten_stack_restore(hdr.sp >>> 0);
  // JS-side decoder/clock state
  viRetrace = hdr.viRetrace >>> 0;
  staticTop = hdr.staticTop >>> 0;
  vcdLo = hdr.vcdLo >>> 0; vcdHi = hdr.vcdHi >>> 0; tlutSrc = hdr.tlutSrc >>> 0;
  for (let i = 0; i < 8; i++) { vatA[i] = hdr.vatA[i] >>> 0; texImg0[i] = hdr.texImg0[i] >>> 0; }
  for (let i = 0; i < 16; i++) { arrayBase[i] = hdr.arrayBase[i] >>> 0; arrayStride[i] = hdr.arrayStride[i] >>> 0; }
  gxShadow.cp.clear(); for (const [k, v] of hdr.gxCp) gxShadow.cp.set(k >>> 0, v >>> 0);
  gxShadow.xf.clear(); for (const [k, v] of hdr.gxXf) gxShadow.xf.set(k >>> 0, v >>> 0);
  gxShadow.bp.clear(); for (const [k, v] of hdr.gxBp) gxShadow.bp.set(k >>> 0, v >>> 0);
  // RENDERER HANDSHAKE — see the EXCLUDED note above. Everything dolphin has been told about
  // guest RAM is now wrong, so drop every address-keyed cache and force a full mem1 + prologue
  // resend on the very next frame.
  knownDLs.clear(); knownArrays.clear(); knownTex.clear(); texBound.clear(); pairSeen.clear();
  f32Arrays.length = 0;
  cacheDirty = true; sentPrologue = false;
  if (Module.___recomp_dirty_reset) Module.___recomp_dirty_reset();
  log('state: restored f' + viRetrace + ' (' + hdr.pages + ' pages, sp=0x' + (hdr.sp >>> 0).toString(16) + ')');
}

// Blocking chunk receiver. The page cannot Atomics.wait (main thread) and this worker cannot
// receive messages (see above), so the page fills the staging SAB and bumps ST_SEQ, we copy
// and bump ST_CONSUMED, and the page polls that. ST_LEN < 0 marks end of stream.
function stateReceive() {
  if (!stageSab) throw new Error('no staging buffer — the page did not pass one at boot');
  const stage = new Uint8Array(stageSab);
  Atomics.store(paceI32, ST_STATUS, 1);
  postMessage({ cmd: 'stateLoadReady' });
  let seq = Atomics.load(paceI32, ST_SEQ);
  let out = null, off = 0;
  const deadline = Date.now() + 120000;
  for (;;) {
    while (Atomics.load(paceI32, ST_SEQ) === seq) {
      if (Date.now() > deadline) throw new Error('timed out waiting for state bytes from the page');
      Atomics.wait(paceI32, ST_SEQ, seq, 200);
    }
    seq = Atomics.load(paceI32, ST_SEQ);
    const len = Atomics.load(paceI32, ST_LEN) | 0;
    if (len < 0) { Atomics.store(paceI32, ST_CONSUMED, seq); Atomics.notify(paceI32, ST_CONSUMED); break; }
    if (!out) {
      const total = Atomics.load(paceI32, ST_TOTAL) >>> 0;
      if (!total) throw new Error('page published a zero-length state');
      out = new Uint8Array(total);
    }
    if (off + len > out.length) throw new Error('state overrun: ' + (off + len) + ' > ' + out.length);
    out.set(stage.subarray(0, len), off);
    off += len;
    Atomics.store(paceI32, ST_CONSUMED, seq);
    Atomics.notify(paceI32, ST_CONSUMED);
  }
  if (!out || off !== out.length)
    throw new Error('state transfer short: ' + off + '/' + (out ? out.length : 0) + 'B');
  return out;
}

// Serviced once per frame from the VIWaitForRetrace stub, after the frame has been fully
// shipped/reset/paced — so the game is at a clean frame boundary in both directions.
function stateServiceCmd() {
  const cmd = Atomics.exchange(paceI32, ST_CMD, 0);
  if (!cmd) return;
  if (cmd === 1) {
    try {
      const blob = stateSnapshot();
      Atomics.store(paceI32, ST_STATUS, 2);
      postMessage({ cmd: 'stateSaved', n: viRetrace, buf: blob.buffer }, [blob.buffer]);
    } catch (err) {
      Atomics.store(paceI32, ST_STATUS, 3);
      postMessage({ cmd: 'stateError', op: 'save', txt: String((err && err.message) || err) });
    }
  } else if (cmd === 2) {
    try {
      stateApply(stateReceive());
      Atomics.store(paceI32, ST_STATUS, 2);
      postMessage({ cmd: 'stateRestored', n: viRetrace });
    } catch (err) {
      Atomics.store(paceI32, ST_STATUS, 3);
      postMessage({ cmd: 'stateError', op: 'load', txt: String((err && err.message) || err) });
    }
  }
}

function serveDvdRead(mem, dv, block, addr, length, offset, cbIdx) {
  block >>>= 0; addr >>>= 0; length >>>= 0; offset >>>= 0;
  cacheDirty = true;
  const dst = new Uint8Array(mem.buffer, addr, length);
  let done = 0;
  while (done < length) {
    const pi = Math.floor((offset + done) / PART_SIZE);
    const po = (offset + done) % PART_SIZE;
    const part = parts[pi];
    if (!part) { dst.fill(0, done); break; }
    const chunk = Math.min(length - done, PART_SIZE - po);
    dst.set(new Uint8Array(part, po, chunk), done);
    done += chunk;
  }
  dv.setInt32(block + 12, 0, true);
  dv.setUint32(block + 32, length, true);
  const cb = cbIdx ? Module.wasmExports.__indirect_function_table.get(cbIdx) : null;
  if (cb) cb(length | 0, block | 0);
  return 1;
}

async function boot(msg) {
  parts = msg.parts;
  fstBuf = new Uint8Array(msg.fst);
  paceI32 = new Int32Array(msg.pace);
  if (msg.stage) stageSab = msg.stage;   // savestate load transport (see the SAVE STATES block)

  const wasmBinary = await (await fetch(msg.wasmUrl)).arrayBuffer();
  // Static-texture boundary = end of the wasm's INITIALIZED data segments (~0x25204): every
  // compiled-in .inc texture/TLUT lives below it, every real guest-RAM texture above it
  // (lowest observed 0x2bf800). NOT __data_end/__heap_base — those include BSS (the 16MB
  // ARAM array), land at ~21.7MB, and misroute nearly every guest texture to wasm-low
  // (all-black board, 2026-08-27 regression during this fix's bring-up).
  staticTop = (function (u8) {
    let p = 8;
    const leb = () => { let r = 0, s = 0, b; do { b = u8[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
    const sleb = () => { let r = 0, s = 0, b; do { b = u8[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); if (s < 32 && (b & 0x40)) r |= (-1 << s); return r >>> 0; };
    let maxEnd = 0;
    while (p < u8.length) {
      const id = u8[p++], len = leb(), end = p + len;
      if (id === 11) {
        const cnt = leb();
        for (let i = 0; i < cnt; i++) {
          const flags = leb();
          let ofs = 0;
          if (flags === 0 || flags === 2) { if (flags === 2) leb(); p++; ofs = sleb(); p++; }   // skip i32.const opcode + end
          const sz = leb(); p += sz;
          if (flags !== 1 && ofs + sz > maxEnd) maxEnd = ofs + sz;
        }
      }
      p = end;
    }
    return maxEnd;
  })(new Uint8Array(wasmBinary));
  log('static data end: 0x' + staticTop.toString(16));
  const wasmModule = await WebAssembly.compile(wasmBinary);
  const isEmscriptenProvided = (name) =>
    name.startsWith('emscripten_') || name.startsWith('__asyncify') || name.startsWith('asyncify_') ||
    name.startsWith('__wasm') || name.startsWith('invoke_') || name === 'memory' ||
    /^(_?abort|_?assert|proc_exit|fd_write|fd_read|fd_close|fd_seek|environ_get|environ_sizes_get|_tzset_js|_localtime_js|_gmtime_js|_mktime_js|emscripten_date_now|_emscripten_get_now_is_monotonic|getentropy|_setitimer_js|__syscall_.*|segfault|__stack_chk_fail|_munmap_js|_mmap_js|__cxa_.*|setTempRet0|getTempRet0|__handle_stack_overflow|_emscripten_memcpy_js|_emscripten_runtime_keepalive_clear)$/.test(name);
  const hostNames = [];
  for (const imp of WebAssembly.Module.imports(wasmModule))
    if (imp.kind === 'function' && (imp.module === 'env' || imp.module === 'wasi_snapshot_preview1')
        && !isEmscriptenProvided(imp.name)) hostNames.push(imp.name);

  const mem = () => Module.wasmMemory;
  const dv = () => new DataView(mem().buffer);

  function stub(n) {
    return (...a) => {
      switch (n) {
        case 'OSInit':
          Module._OSSetArenaLo(0x80004000); Module._OSSetArenaHi(0x81800000); return 0;
        case 'OSGetTime': case '__OSGetSystemTime': return BigInt(viRetrace) * 675000n;
        case 'OSGetTick': return (viRetrace * 675000) >>> 0;
        case 'DVDInit': { const f = Module.___DVDFSInit; if (f) f(); return 0; }
        case 'DVDReadAbsAsyncPrio':
        case 'DVDReadAbsAsyncForBS': return serveDvdRead(mem(), dv(), a[0], a[1], a[2], a[3], a[4]);
        case 'VIGetRetraceCount': return viRetrace;
        case 'VIWaitForRetrace': {
          const pos = Module._gx_fifo_pos ? Module._gx_fifo_pos() : 0;
          if (pos > 0) {
            const base = Module._gx_fifo_base();
            const fb = new Uint8Array(mem().buffer.slice(base, base + pos));
            const newDLs = [], touched = new Map();
            try { walkStream(mem(), fb, 0, pos, 0, newDLs, touched) } catch (e) { log('walk threw: ' + e.message); }
            const regions = [];
            for (const d of newDLs)
              regions.push({ addr: d.addr & 0x01FFFFFF,
                             bytes: new Uint8Array(mem().buffer.slice(0x80000000 + (d.addr & 0x01FFFFFF),
                                                                      0x80000000 + (d.addr & 0x01FFFFFF) + d.size)) });
            // texture regions BEFORE arrays: both are raw guest slices except arrays are
            // byte-swapped — on any residual overlap the swapped array copy must win
            // (apply order is list order on the dolphin side).
            // Sync on FIRST sight only (per-frame dynamic updates flow through the
            // dirty-range ring below — the game's own DCStoreRange calls).
            // STATIC ASSETS: a bind whose masked base falls below the wasm data-segment end
            // (__recomp_static_top ~0x25204; lowest real guest texture 0x2bf800) is a
            // compiled-in .inc asset living in LOW wasm memory — the guest window at that
            // offset is zeros. Source those bytes from the static, shipped to the same
            // guest-physical offset (unused low MEM1) so Dolphin's decoder finds them.
            for (const [base, size] of texBound) {
              const ofs = base & 0x01FFFFFF;
              if (ofs + size > 0x01800000) continue;
              const kt = knownTex.get(base);
              if (!kt || size > kt.size) {
                knownTex.set(base, { size, lastSync: viRetrace });
                const src = (staticTop && ofs + size <= staticTop) ? ofs : 0x80000000 + ofs;
                regions.push({ addr: ofs, bytes: new Uint8Array(mem().buffer.slice(src, src + size)) });
              }
            }
            texBound.clear();
            // Arrays: fixture-parity clip extents. pairSeen = every (base,stride) bound
            // this frame (top-level + walked-DL bodies) + the CP shadow's current 16 slots
            // (bindings persisting from earlier frames). Extent = clip at the nearest
            // FOLLOWING clip point (any pair base, DL addr, or texture base), cap 256KB —
            // exactly the DUMPFIX heuristic every clean fixture render used. Sync on first
            // sight; content updates flow via the dirty ring; restages invalidate.
            for (let si = 0; si < 16; si++) {
              const sb = arrayBase[si], ss = arrayStride[si];
              if (sb && ss) pairSeen.set((sb >>> 0) + '|' + (ss >>> 0), { base: sb >>> 0, stride: ss >>> 0 });
            }
            {
              const newPairs = [...pairSeen.values()].filter((pr) => !knownArrays.has((pr.base >>> 0) + '|' + (pr.stride >>> 0)));
              if (newPairs.length) {
                const clipPts = [...new Set([
                  ...[...pairSeen.values()].map((pr) => pr.base & 0x01FFFFFF),
                  ...[...knownArrays.keys()].map((k) => parseInt(k, 10) & 0x01FFFFFF),
                  ...[...knownDLs.keys()].map((a2) => a2 & 0x01FFFFFF),
                  ...[...knownTex.keys()].map((t2) => t2 & 0x01FFFFFF),
                ])].sort((x, y) => x - y);
                for (const pr of newPairs) {
                  const b2 = pr.base & 0x01FFFFFF;
                  if (b2 >= 0x01800000) continue;
                  let next = 0x01800000;
                  for (const cpt of clipPts) if (cpt > b2) { next = cpt; break; }
                  const ext = Math.min(next - b2, 0x40000, 0x01800000 - b2);
                  if (ext <= 0) continue;
                  knownArrays.set((pr.base >>> 0) + '|' + (pr.stride >>> 0), ext);
                  regions.push({ addr: b2, bytes: regionBytes(mem(), pr.base, pr.stride, ext) });
                  if (peekAddrs && peekAddrs.some((pa) => Math.abs(pa - b2) < 0x2000))
                    log('pairSync f' + viRetrace + ' base=0x' + b2.toString(16) + ' stride=' + pr.stride + ' ext=' + ext);
                }
              }
              pairSeen.clear();
            }
            // dirty-range ring (gc_dirty_ring.c): the game's DCStoreRange/DCFlushRange calls
            // mark exactly the CPU-written GPU-visible bytes this frame (skinning vertex
            // writes, glyph textures, minigame arrays). Drain, filter to guest RAM, forward.
            if (Module.___recomp_dirty_count) {
              const dn = Module.___recomp_dirty_count();
              if (Module.___recomp_dirty_overflow && Module.___recomp_dirty_overflow()) {
                cacheDirty = true;   // pathological burst (whole-heap flush): full resnapshot next frame
              } else if (dn > 0) {
                const dbase = Module.___recomp_dirty_base() >>> 0;
                const dvw = new DataView(mem().buffer, dbase, dn * 8);
                for (let di = 0; di < dn; di++) {
                  const da = dvw.getUint32(di * 8, true), dsRaw = dvw.getUint32(di * 8 + 4, true);
                  const restage = !!(dsRaw & 0x80000000), ds = dsRaw & 0x7FFFFFFF;
                  if (da < 0x80000000 || da + ds > 0x81800000) continue;   // stack/out-of-RAM: drop
                  if (ds > 0x100000) { cacheDirty = true; continue; }      // jumbo: full resync instead
                  const ofs = da - 0x80000000;
                  // A walked DL's identity IS its content (the walk extracted its array
                  // bindings) — any write over it, DC flush or restage, invalidates it.
                  for (const [ka, ent2] of knownDLs) {
                    const kOfs = ka & 0x01FFFFFF;
                    if (kOfs < ofs + ds && kOfs + ent2.size > ofs) knownDLs.delete(ka);
                  }
                  if (restage) {
                    // ARAM->MRAM restage: the range now holds a DIFFERENT asset (heap
                    // reuse) — every address-keyed cache entry overlapping it is stale
                    // (walk-once DLs poisoned whole scenes before this). Drop them so
                    // next frame's walk re-discovers + re-syncs. A DC flush (restage=
                    // false) is a content update to the SAME data — arrays/tex stay.
                    // ALSO clear every DL's walk memory: array bindings live inside DL
                    // bodies, and an invalidated array re-syncs only when a body walk
                    // re-emits its pair (0x955000 stayed raw-LE forever without this).
                    for (const ent3 of knownDLs.values()) ent3.keys.clear();
                    for (const [k, kn] of knownArrays) {
                      const kOfs = parseInt(k, 10) & 0x01FFFFFF;
                      if (kOfs < ofs + ds && kOfs + kn > ofs) knownArrays.delete(k);
                    }
                    for (const [tb, tv] of knownTex) {
                      const kOfs = tb & 0x01FFFFFF;
                      if (kOfs < ofs + ds && kOfs + tv.size > ofs) knownTex.delete(tb);
                    }
                    for (let fi = f32Arrays.length - 1; fi >= 0; fi--)
                      if (f32Arrays[fi].b < ofs + ds && f32Arrays[fi].e > ofs) f32Arrays.splice(fi, 1);
                  }
                  const by = new Uint8Array(mem().buffer.slice(da, da + ds));
                  // dirty range inside a known f32 vertex/texcoord array (skinning/morph
                  // writes are LE floats) -> swap for Dolphin; anything else (glyph
                  // textures, DLs, misc buffers) is byte-exact -> raw
                  for (const iv of f32Arrays)
                    if (ofs >= iv.b && ofs + ds <= iv.e) { swap4InPlace(by); break; }
                  regions.push({ addr: ofs, bytes: by });
                }
              }
              if (Module.___recomp_dirty_reset) Module.___recomp_dirty_reset();
            }
            let mem1Snap = null;
            if (cacheDirty || testFullMem) {
              cacheDirty = false;
              knownDLs.clear(); knownArrays.clear(); knownTex.clear(); f32Arrays.length = 0;
              mem1Snap = mem().buffer.slice(0x80000000, 0x81800000);
            }
            if (!sentPrologue) { sentPrologue = true;
              if (!mem1Snap) mem1Snap = mem().buffer.slice(0x80000000, 0x81800000);
            }
            // Prepend the rolling register shadow to EVERY frame (~1.5KB): each frame is then
            // fully self-contained, so the renderer may skip backlogged frames without the
            // decoder losing persistent CP/XF/BP state carried only by a skipped frame.
            const pro = buildPrologue();
            const fifo = new Uint8Array(pro.length + fb.length);
            fifo.set(pro, 0); fifo.set(fb, pro.length);
            const transfers = [fifo.buffer, ...regions.map((r) => r.bytes.buffer)];
            if (mem1Snap) transfers.push(mem1Snap);
            postMessage({ cmd: 'frame', n: viRetrace, fifo: fifo.buffer, mem1: mem1Snap,
                          regions: regions.map((r) => ({ addr: r.addr, bytes: r.bytes.buffer })) }, transfers);
          }
          if (Module._gx_fifo_reset) Module._gx_fifo_reset();
          // input from the pace SAB (page keyboard/gamepad): buttons/d-pad (cells 1-2) are
          // one-shot edges (exchange-cleared — they feed the game's EDGE-triggered
          // HuPadBtnDown/HuPadDStkRep); the analog stick merges the HELD state the page
          // maintains in cells 8/9 via keydown/keyup (HuPadStkX/Y are LEVEL thresholds —
          // a single-frame blip can't drive held-analog UIs like character select).
          const scripted = inputScript ? inputScript[viRetrace + 1] : null;
          const os3 = Atomics.exchange(paceI32, 3, 0), os4 = Atomics.exchange(paceI32, 4, 0);
          const h3 = Atomics.load(paceI32, 8), h4 = Atomics.load(paceI32, 9);
          if (Module.___recomp_set_inject_btn) Module.___recomp_set_inject_btn(Atomics.exchange(paceI32, 1, 0) | (scripted ? scripted[0] : 0));
          if (Module.___recomp_set_inject_dstk) Module.___recomp_set_inject_dstk(Atomics.exchange(paceI32, 2, 0) | (scripted ? scripted[1] : 0));
          if (Module.___recomp_set_inject_stkx) Module.___recomp_set_inject_stkx(os3 || h3 || (scripted ? scripted[2] : 0));
          if (Module.___recomp_set_inject_stky) Module.___recomp_set_inject_stky(os4 || h4 || (scripted ? scripted[3] : 0));
          viRetrace++;
          pumpAudio();
          cardPoll();
          // debug: periodic guest-side hex of watched addresses (boot msg peekAddrs;
          // diff against the dolphin worker's recompPeek of the same guest offsets)
          if (peekAddrs && (viRetrace % 1200) === 0) {
            for (const pa of peekAddrs) {
              const u8p = new Uint8Array(mem().buffer, 0x80000000 + pa, 48);
              log('guestPeek f' + viRetrace + ' 0x' + pa.toString(16) + ' = ' +
                  [...u8p].map((b) => b.toString(16).padStart(2, '0')).join(''));
              const inF32 = f32Arrays.some((iv) => pa >= iv.b && pa < iv.e);
              const nearArr = [...knownArrays.keys()].filter((k) => Math.abs((parseInt(k, 10) & 0x01FFFFFF) - pa) < 0x2000);
              log('class 0x' + pa.toString(16) + ': inF32=' + inF32 + ' nearKnownArrays=' + JSON.stringify(nearArr)
                  + ' knownArrTotal=' + knownArrays.size + ' knownDLs=' + knownDLs.size + ' f32ivs=' + f32Arrays.length);
            }
          }
          // pacing: consume one frame credit; block until the page grants more (uncapped=freerun)
          if (!Atomics.load(paceI32, 5)) {
            while (Atomics.load(paceI32, 0) <= 0) Atomics.wait(paceI32, 0, 0, 500);
            Atomics.sub(paceI32, 0, 1);
          }
          // savestate command cell — LAST, so the frame is fully shipped, the FIFO reset and
          // the pacing credit consumed before a snapshot is taken or memory is overwritten.
          stateServiceCmd();
          return 0;
        }
        default: return 0;
      }
    };
  }

  const instantiateWasm = (info, receive) => {
    info.env ??= {};
    for (const name of hostNames) info.env[name] = stub(name);
    WebAssembly.instantiate(wasmModule, info).then((inst) => receive(inst, wasmModule));
    return {};
  };
  const createModule = (await import(msg.glueUrl)).default;
  Module = await createModule({ instantiateWasm, noInitialRun: true });
  if (Module.wasmMemory.buffer.byteLength < 0x82000000) Module._emscripten_resize_heap(0x82000000);
  // MEMORY CARD — must happen BEFORE _main(): CARDInit (inside main, via HuCardInit) adopts
  // whatever bytes sit in the image buffer, and formats a blank card if they don't validate.
  if (Module.___recomp_card_base && Module.___recomp_card_size) {
    cardBase = Module.___recomp_card_base() >>> 0;
    cardSize = Module.___recomp_card_size() >>> 0;
    if (Module.___recomp_card_time)
      Module.___recomp_card_time(Math.max(0, Math.floor(Date.now() / 1000) - 946684800) >>> 0);
    if (msg.card && msg.card.byteLength === cardSize) {
      new Uint8Array(Module.wasmMemory.buffer, cardBase, cardSize).set(new Uint8Array(msg.card));
      log('memcard: seeded persisted image (' + cardSize + 'B) at 0x' + cardBase.toString(16));
    } else {
      log('memcard: no persisted image (' + (msg.card ? msg.card.byteLength + 'B, wrong size' : 'none')
          + ') — the shim will format a blank card');
    }
    cardSeq = Module.___recomp_card_seq ? Module.___recomp_card_seq() >>> 0 : 0;
  } else {
    log('memcard: shim exports missing — build_wasm.sh EXPORTED_FUNCTIONS is stale, saves are OFF');
  }
  if (msg.autoboard && Module.___recomp_autoboard_arm) { Module.___recomp_autoboard_arm(1); log('AUTOBOARD armed'); }
  if (msg.inputScript) { inputScript = msg.inputScript; log('input script: ' + Object.keys(inputScript).length + ' entries'); }
  if (msg.peekAddrs) peekAddrs = msg.peekAddrs;
  if (msg.testFullMem) { testFullMem = true; log('TESTFULLMEM: full mem1 every frame'); }
  // Tell the page the output rate BEFORE any 'audio' message, so it builds the AudioContext at
  // the right rate the first time (the same contract dolphin_worker's 'audioRate' has).
  audioTest = !!msg.audioTest;
  postMessage({ cmd: 'audioRate', rate: AUDIO_RATE });
  log('audio: rate ' + AUDIO_RATE + ' Hz, source = ' +
      (Module.___recomp_audio_pump ? 'engine' : (audioTest ? '?audiotest=1 SYNTHETIC TONE (transport self-test, not game audio)'
        : 'NONE — MusyX is not compiled in, this path is silent')));
  if (msg.xfShadowAll === false) { XF_SHADOW_ALL = false; log('XF shadow: registers only'); }

  // stage BootInfo (LE) + FST (BE->LE entry table) + FSTLocation
  const d = new DataView(Module.wasmMemory.buffer);
  d.setUint32(0x80000000, 0x0D15EA5E, true);
  d.setUint32(0x80000008, 0x01800000, true);
  d.setUint32(0x80000014, 2, true);
  const fst = fstBuf.slice();
  const fdv = new DataView(fst.buffer, fst.byteOffset, fst.length);
  const maxEntry = fdv.getUint32(8, false), eb = maxEntry * 12;
  for (let i = 0; i + 4 <= eb; i += 4) fdv.setUint32(i, fdv.getUint32(i, false), true);
  new Uint8Array(Module.wasmMemory.buffer).set(fst, 0x81C00000);
  d.setUint32(0x80000038, 0x81C00000, true);
  d.setUint32(0x8000003C, fst.length, true);
  log('module up (' + hostNames.length + ' host stubs, ' + parts.length + ' disc parts); running main()');
  try { await Module._main(); } catch (e) { log('main stopped: ' + (e.message || e)); }
}

onmessage = (e) => {
  if (e.data.cmd === 'boot') boot(e.data).catch((err) => log('boot failed: ' + (err.stack || err)));
  else if (e.data.cmd === 'cardLoad') cardLoad(e.data.img);
  else if (e.data.cmd === 'cardDump') { if (!cardSnapshot()) log('memcard: dump ignored (not booted yet)'); }
};
