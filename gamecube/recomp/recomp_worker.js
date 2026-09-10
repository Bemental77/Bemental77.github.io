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
//              i32[15]=status (see the SAVE STATES block). i32[16..31] = the FOUR-PORT pad
//              block and i32[32..99] = the guest-state witness window — see the PAD_PORTS /
//              PEEK_SEQ block further down. Cells 1-4 and 8-9 stay live as a port-0 alias.
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
// [part-table 2026-09-04] Cumulative byte offset of each disc part, built at boot from the
// parts' REAL byteLengths (buildPartIndex, called from boot()). This REPLACES
// `const PART_SIZE = 104857600;  // 100MiB fixed part boundaries (gamecube.html chunkRange)`,
// which serveDvdRead divided the read offset by. chunkRange (gamecube.html:2064) only builds
// part URLs — it says nothing about part SIZE — and the sizes on disk say the constant was
// wrong twice over. Measured with `ls -la gamecube/roms/*.bin.parta*` on 2026-09-04:
//   * MarioParty4.bin.parta{a..e} ARE 104,857,600 B, but partaf is 74,094,592 B. The old clamp
//     `Math.min(length - done, PART_SIZE - po)` sized the copy off the CONSTANT, not off the
//     short final part, so `new Uint8Array(part, po, chunk)` threw RangeError on any read that
//     ran off the end of the trimmed image instead of zero-filling it.
//   * SonicAdventure2Battle.bin.parta{a..p} and PhantasyStarOnline1And2Plus.bin.parta{a..p} are
//     89,128,960 B each (partaq 33,914,880 B) — NOT 100 MiB. `offset / PART_SIZE` maps every
//     read of those images to the wrong part at the wrong offset, with no error at all.
// gamecube.html's prefetchDisc() (:7924-7942) hardcodes the six MP4 parts, so only the first
// failure is reachable from the shipping page today — but the second is one chunk-list change
// away, and a cumulative table makes the split layout DATA rather than an assumption.
let partStarts = [], discBytes = 0;

function buildPartIndex(list) {
  partStarts = new Array(list.length);
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    partStarts[i] = acc;
    acc += (list[i] && list[i].byteLength) | 0;
  }
  discBytes = acc;
  return acc;
}

// ---- AUDIO transport (page AudioWorklet ring) -------------------------------------------
// THE STATE OF THIS PATH. [2026-09-02] THE SHIPPED gamecube/recomp/mp4_game.wasm NOW HAS SOUND
// (md5 00f457ce…, built with RECOMP_MUSYX=1). MP4 routes to the recomp by default
// (gamecube.html:1038), so this is what a visitor hears. Measured on gamecube.html, every run
// hash-guarded before and after and serialized through tools/probe_lock.sh, box load 2.5-5.4:
//   * AUDIBLE, and driven PAST the title (Start x2 then A x8): audible YES, 2,265,587 audible
//     frames, 70.7 s audible, peak 0.9008, on AudioContext id 1 — rank contexts by audible
//     frames, NOT contexts[0], because this page builds a vestigial one too.
//   * THE OLD SHIPPED build on the SAME journey: audible NO, "rendered frames were all exactly
//     zero", 0 of 3,076,096 frames. So the difference is the sound, not the rig.
//     (tools/audio_probe.mjs; its tap validated 12/12 by tools/audio_tap_selftest.mjs.)
//   * 0 traps in 3 of 3 runs; guest rate 0.999x, 60 shown / 60 published, drawn 180/s, held to
//     t=111s, screenshotted on MP4's PARTY MODE character-select screen.
//
// WHAT IT COST: headroom, not speed. The guest still runs at 0.999x, but producible capacity
// fell from ~433-495 fps (7.2-8.2x hw) on the silent build to ~104-111 fps (1.7-1.8x hw) with
// the software mixer in, so the page no longer reports "120 REACHED". Guest rate and presented
// rate are separate knobs (CLAUDE.md gate #9); this moved only the second one.
//
// THE BUG THAT HELD THIS BACK FOR A ROUND was three wrong assumptions about the MusyX ARR
// sequence format in shims/src/gc_musyx_song_bswap.c — see that file and build_wasm.sh. The
// lesson for THIS file: `main stopped: memory access out of bounds` names nothing on its own,
// which is why the catch below now logs e.stack. A TITLE-SCREEN AUDIO MEASUREMENT CANNOT CLEAR
// AN AUDIO BUILD — the title-only pass read entirely green while the build died one screen on.
//
// Why compiling MusyX in was necessary but not sufficient: on real hardware MusyX mixes on the
// DSP — hw_dolphin.c hands salBuildCommandList's output to the `dspSlave` microcode
// (dsp_import.c:4, 0x19E0 bytes of GC-DSP code) — and the MUSY_TARGET_PC backend is a stub,
// not a software renderer (hw_pc.c:89 salAiGetDest returns NULL). Three pieces closed it, all
// under RECOMP_MUSYX: a software AX-style mixer over the _PB voice blocks (gc_musyx_mix.c), a
// SAL backend + AI DMA model (gc_musyx_hw.c, gc_musyx_ai.c), and big-endian swappers for
// /sound/mpgcsnd.msm and the sequences (gc_musyx_bswap.c, gc_musyx_song_bswap.c).
//
// ALSO OPEN, AND NOT THE SAME BUG — TWO separate audio-quality defects, neither a ship blocker:
//   (1) THE TITLE IS QUIET, the menu is not. Title music peaks 0.0758 (~-22 dBFS); the same
//       build measured peak 0.9008 across a run driven into the menu flow, so it is NOT a
//       global attenuation and there is no gain node to blame in this file or gamecube.html.
//       Two candidates, both still unverified: (a) the mixer renders only the DRY stereo mix,
//       so aux sends (reverb/chorus), surround and studio-to-studio inputs contribute nothing;
//       (b) OSGetSoundMode() returns 0 => MONO, every voice panned dead centre
//       (synth.c:670-692), where audio.c:60 would otherwise pick SURROUND. (b) has a CONFIRMED
//       mechanism as of 2026-09-02: `wasm-objdump -j Import -x mp4_game.wasm` lists
//       `env.EXILock` as a host import, this file answers unknown imports with
//       `default: return 0`, and OSRtc.c:107 `if (!EXILock(...))` therefore makes ReadSram bail
//       — so the emulated SRAM stays all-zero and msmsys.c:909 selects MONO. What is NOT
//       verified is that this is what makes the TITLE specifically quiet.
//   (2) CLICKS. Over the 70.7 s audible window the tap counted 69 discontinuities with
//       maxStep 0.854 against peak 0.9008 — near-full-scale sample-to-sample jumps, about one
//       per second. A title-only pass had read 0 of these, which is another reason not to
//       trust one. Cause unknown; not investigated.
// Do NOT paper over either with a gain node — that hides whichever one it is.
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
let audioStallFrames = 0;      // consecutive frames the mixer returned 0 samples (see pumpAudio)
const AUDIO_STALL_FRAMES = 120;
// A score that keeps crossing the threshold could emit two lines per 2 s indefinitely. Bounded
// the same way OSReport is, and it says so when it stops rather than going quiet unannounced.
let audioStallEpisodes = 0;
const AUDIO_STALL_MAX_EPISODES = 20;

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
  // ENGINE PATH. The software mixer (shims/src/gc_musyx_mix.c, RECOMP_MUSYX=1) stages int16
  // stereo frames inside the wasm heap and returns how many it actually produced; copy them out
  // because the heap can move on a memory growth.
  if (Module && Module.___recomp_audio_pump && Module.___recomp_audio_base) {
    const got = Module.___recomp_audio_pump(n) | 0;
    if (got > 0) {
      const base = Module.___recomp_audio_base() >>> 0;
      pcm = new Int16Array(Module.wasmMemory.buffer.slice(base, base + got * 4));
    }
    // A mixer that produces nothing is the audio-path version of `default: return 0` — the
    // transport stays healthy, every producer-side counter still reads fine, and the page is
    // simply silent with nothing saying so. Report the transition in BOTH directions, once
    // each, so a stall is attributable to a moment rather than discovered by listening.
    // Threshold is in EMULATED frames (gate #9): 120 frames = 2 s of guest time, long enough
    // that ordinary between-cue silence in a sequenced score does not trip it.
    if (got > 0) {
      if (audioStallFrames >= AUDIO_STALL_FRAMES && audioStallEpisodes <= AUDIO_STALL_MAX_EPISODES)
        log('audio: mixer produced samples again after ' + audioStallFrames + ' silent frames');
      audioStallFrames = 0;
    } else if (++audioStallFrames === AUDIO_STALL_FRAMES
               && ++audioStallEpisodes <= AUDIO_STALL_MAX_EPISODES) {
      log('audio: mixer has returned 0 samples for ' + AUDIO_STALL_FRAMES + ' consecutive frames'
          + ' (' + (AUDIO_STALL_FRAMES / 60).toFixed(1) + ' s of emulated time) — the transport is '
          + 'fine and the page will be SILENT. active voices = '
          + (Module.___recomp_musyx_active_voices ? Module.___recomp_musyx_active_voices() : '?')
          + (audioStallEpisodes === AUDIO_STALL_MAX_EPISODES
             ? ' [' + AUDIO_STALL_MAX_EPISODES + 'th episode — further stall reports suppressed]' : ''));
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

// ── FOUR CONTROLLER PORTS ───────────────────────────────────────────────────────────────────
// [2026-09-10] Mario Party 4 is THE four-player title and this engine could express exactly one
// player: gc_input.c held four SCALARS, their setters took no port, and build_wasm.sh baked
// `HuPadBtnDown[0]`. Nothing about the GAME was the limit — game/pad.c declares every channel
// as [4] and HuPadRead loops i=0..3 — so the whole blocker lived in the two lines above and in
// the six single-port SAB cells below.
//
// The pace SAB now carries one block per port. Cells 0..15 are UNCHANGED (credits, the legacy
// port-0 cells, the savestate channel); the per-port block starts at PAD_BASE:
//
//   PAD_BASE + port*PAD_STRIDE + 0   btn   one-shot edge  -> HuPadBtnDown[port]
//                              + 1   dstk  one-shot edge  -> HuPadDStkRep[port]
//                              + 2   stkx  HELD level     -> HuPadStkX[port]
//                              + 3   stky  HELD level     -> HuPadStkY[port]
//
// ⚠ THE LEGACY CELLS ARE AN ALIAS FOR PORT 0, NOT A SECOND SOURCE OF TRUTH. gamecube.html's
// keyboard listeners and gamecube/recomp/recomp_probe.mjs:348-353 write cells 1/2/3/4/8/9 and
// call ___recomp_set_inject_*; folding them into port 0 here is what keeps a keyboard-only
// visitor (and every existing harness) working while a gamepad on index 1 reaches port 1.
const PAD_PORTS = 4, PAD_BASE = 16, PAD_STRIDE = 4;

// ── THE LOCKSTEP INTERLOCK ──────────────────────────────────────────────────────────────────
// Two cells, and between them they are the whole worker half of the frame gate.
//
//   PAD_ACK   bumped once per guest frame, at the END of applyPads — i.e. after the credit was
//             consumed and the pad bytes were latched. The page needs this because THE PAD
//             CELLS ARE A SINGLE SLOT, NOT A QUEUE: if it wrote a second frame's image before
//             the first was latched, the second would silently overwrite the first and the two
//             machines would run different inputs on the same numbered frame — a desync that
//             looks like nothing at all. PEEK_SEQ cannot serve: it is bumped BEFORE the credit
//             wait, so it advances while an unlatched image is still pending.
//   LS_ARMED  non-zero = a room owns the input. applyPads then reads ONLY the per-port block
//             and ignores the legacy port-0 aliases and the ?board=1 script, because under
//             lockstep the local keyboard's bytes must travel through the room and come back in
//             the agreed image — folding them straight into port 0 as well would apply this
//             machine's own input a frame early and only on this machine.
const PAD_ACK = 33, LS_ARMED = 34;

// ── GUEST-STATE WITNESS WINDOW ──────────────────────────────────────────────────────────────
// A postMessage cannot reach this worker once _main() runs (see the SAVE STATES block), and the
// guest's state lives in THIS worker's wasm instance — so the page has no way to read what the
// game itself thinks its four pads are doing. That is not a debugging luxury: "four ports are
// wired" is only worth anything if it can be checked against the GAME'S OWN arrays rather than
// against the flag we just set. Each frame the worker mirrors two things into the pace SAB and
// bumps PEEK_SEQ last, so the page reads them synchronously with no guest cooperation:
//
//   WIT_*   ___recomp_pad_witness() — the game's own HuPadBtnDown/HuPadBtn/HuPadDStkRep/
//           HuPadStkX/HuPadStkY/HuPadErr/winKey/GWPlayerCfg, read BY C SYMBOL in gc_input.c.
//           ⚠ THIS IS A NATIVE PORT, NOT AN EMULATOR: there is no Gekko address map, so the
//           GameCube addresses in the symbol map (HuPadBtnDown = 0x801D3AD0) name NOTHING here.
//           A harness that peeked those MEM1 offsets read four zeros and looked exactly like
//           dead input — it was reading empty arena.
//   PEEK_*  the raw MEM1 offsets named by the boot message's peekAddrs, which DO exist (the
//           arena the renderer is fed from) and are what the older guestPeek log line dumps.
const PEEK_SEQ = 32;              // bumped AFTER everything below is filled (publish barrier)
const WIT_BASE = 36, WIT_CELLS = 48;                            // ___recomp_pad_witness block
const PEEK_BASE = WIT_BASE + WIT_CELLS;                         // = 80; first MEM1 window cell
const PEEK_WINDOWS = 4;           // how many raw MEM1 windows are mirrored
const PEEK_CELLS = 16;            // 64 bytes each
// FINGERPRINT CELLS. A room that is frame-gated with nothing comparing the two
// simulations is worse than one that is not gated, because it looks right while
// each player watches a different game. gamecube.html drives beginFrame() and
// endFrame() per guest frame and has never called submitHash(), for the honest
// reason that the recomp published no deterministic state hash. These three
// cells are that hash.
//
// ⚠ WHAT IS HASHED AND WHY ONLY THAT. The GUEST WINDOW ONLY (MEM1 at
// 0x80000000). This is a native port, not an emulator: the recomp's own
// .data/.bss, C heap and fiber stacks sit in the same linear memory and hold
// HOST pointers, allocation order and Asyncify bookkeeping that differ between
// two browsers WITHOUT the simulation having diverged at all. Hashing those
// would report a divergence on every healthy room, which is worse than no
// fingerprint: an alarm that is always on gets switched off.
// ⚠ PLACED AT 200, NOT DIRECTLY AFTER THE PEEK WINDOWS. Cells immediately past
// the old end of the layout did not behave as private: values written there
// came back as things this file never stored. Rather than litigate ownership of
// a contested cell, the fingerprint sits well clear of it. The page allocates
// 1024 B = 256 cells, so 200-202 are inside the buffer with room to spare.
const FP_SEQ  = 200;              // bumped last (publish barrier)
const FP_FRAME = 201;             // which guest frame the hash below describes
const FP_HASH = 202;              // the hash itself
const FP_DIAG = 203;              // stage / covered, for a rig to read
// A TEST SEAM WITH A PURPOSE. A divergence detector that has never reported a
// divergence is untested, and the only honest way to test one is to cause one.
// Setting this cell on ONE console perturbs its hash, which must make both sides
// report a desync. It proves the REPORTING path — compare, name the frame, raise
// it — not the coverage; coverage is argued from what is hashed, above.
const FP_INJECT = 204;
const PACE_I32_CELLS = PEEK_BASE + PEEK_WINDOWS * PEEK_CELLS;   // = 144; unchanged

// Deliver one frame of pad state to the guest, one call per port. Prefers the four-port export;
// falls back to the legacy single-port setters when running against an older mp4_game.wasm, in
// which case ports 1-3 are simply not delivered (rather than silently landing on player 1).
function applyPads() {
  if (!Module) return;
  const lsOn = Atomics.load(paceI32, LS_ARMED) !== 0;
  const scripted = (!lsOn && inputScript) ? inputScript[viRetrace + 1] : null;
  // legacy port-0 cells: two one-shot edges, two one-shot sticks, two held sticks
  const lBtn = Atomics.exchange(paceI32, 1, 0), lDstk = Atomics.exchange(paceI32, 2, 0);
  const lOsX = Atomics.exchange(paceI32, 3, 0), lOsY = Atomics.exchange(paceI32, 4, 0);
  const lHeldX = Atomics.load(paceI32, 8), lHeldY = Atomics.load(paceI32, 9);
  const setPad = Module.___recomp_set_pad || null;
  for (let p = 0; p < PAD_PORTS; p++) {
    const b = PAD_BASE + p * PAD_STRIDE;
    let btn = Atomics.exchange(paceI32, b, 0);
    let dstk = Atomics.exchange(paceI32, b + 1, 0);
    let stkx = Atomics.load(paceI32, b + 2);
    let stky = Atomics.load(paceI32, b + 3);
    if (p === 0 && !lsOn) {
      btn |= lBtn; dstk |= lDstk;
      stkx = stkx || lOsX || lHeldX; stky = stky || lOsY || lHeldY;
      if (scripted) {
        btn |= scripted[0]; dstk |= scripted[1];
        stkx = stkx || scripted[2]; stky = stky || scripted[3];
      }
    }
    if (setPad) setPad(p, btn, dstk, stkx, stky);
    else if (p === 0) {
      if (Module.___recomp_set_inject_btn) Module.___recomp_set_inject_btn(btn);
      if (Module.___recomp_set_inject_dstk) Module.___recomp_set_inject_dstk(dstk);
      if (Module.___recomp_set_inject_stkx) Module.___recomp_set_inject_stkx(stkx);
      if (Module.___recomp_set_inject_stky) Module.___recomp_set_inject_stky(stky);
    }
  }
  // LAST, and it is a promise to the page: everything above has been latched into the guest's
  // own globals, so the slot is free for the next frame's image.
  Atomics.add(paceI32, PAD_ACK, 1);
  Atomics.notify(paceI32, PAD_ACK);
}

// Mirror the game's own pad state (and any watched MEM1 windows) into the pace SAB. Called once
// per frame, after the guest has run. Cheap: 176 B + up to 4×64 B of copying.
function publishPeek() {
  if (!Module || !paceI32 || paceI32.length < PACE_I32_CELLS) return;
  const buf = Module.wasmMemory.buffer;
  if (Module.___recomp_pad_witness) {
    const at = Module.___recomp_pad_witness() >>> 0;      // fills the block, returns its address
    if (at && at + WIT_CELLS * 4 <= buf.byteLength)
      new Uint8Array(paceI32.buffer).set(new Uint8Array(buf, at, WIT_CELLS * 4), WIT_BASE * 4);
  }
  if (peekAddrs && peekAddrs.length) {
    const src = new Uint8Array(buf);
    const dst = new Uint8Array(paceI32.buffer);
    const n = Math.min(peekAddrs.length, PEEK_WINDOWS);
    for (let w = 0; w < n; w++) {
      const off = 0x80000000 + (peekAddrs[w] >>> 0);
      if (off + PEEK_CELLS * 4 > src.length) continue;
      dst.set(src.subarray(off, off + PEEK_CELLS * 4), (PEEK_BASE + w * PEEK_CELLS) * 4);
    }
  }
  Atomics.store(paceI32, PEEK_SEQ, (Atomics.load(paceI32, PEEK_SEQ) + 1) | 0);
}

// ---------------------------------------------------------------------------
// THE STATE FINGERPRINT.
//
// Sampled, not exhaustive: MEM1 is 24 MiB and hashing all of it every frame
// would cost more than the frame. A strided FNV-1a over one word in every 64
// touches ~384 KiB per hash and still covers the whole window, so a divergence
// anywhere in guest RAM is caught within a few hashes rather than never.
//
// ⚠ EVERY CONSOLE MUST HASH THE SAME FRAME. The frame number travels WITH the
// hash and lib/netplay.js compares like for like; a hash without its frame is
// two machines comparing different moments and calling it a fork.
const FP_EVERY = 30;              // guest frames between fingerprints

// ⚠ WHAT IS HASHED, AND WHY NOT "GUEST RAM".
//
// The first attempt hashed 24 MiB at linear offset 0x80000000, on the strength
// of a comment in this file calling that "the guest MEM1 window". It published
// NOTHING, every frame, silently: linear memory here is 300 MB, so that offset
// is a gigabyte and a half past the end. The comment describes a configuration
// this build is not in. Measured, not assumed — the module was asked:
//
//   ___recomp_pad_witness() = 19093136   ___recomp_card_base() = 16946112
//   ___recomp_aram_base()   = 168880     wasmMemory            = 300 MB
//
// and both consoles returned IDENTICAL values, which is what makes hashing at
// these addresses meaningful at all.
//
// So the fingerprint covers two things with known extent that are unambiguously
// GUEST state, rather than a broad sweep of a native port's linear memory —
// which holds host pointers, malloc order and Asyncify bookkeeping that differ
// between two healthy browsers and would report a fork on every room:
//
//   1. THE GAME'S OWN LIVE STATE — the ___recomp_pad_witness() block: MP4's
//      HuPadBtnDown/HuPadBtn/HuPadDStkRep/HuPadStkX/HuPadStkY/HuPadErr/winKey/
//      GWPlayerCfg, read by C symbol. It changes every frame and is exactly
//      what diverges first when two machines stop agreeing about the game.
//   2. THE MEMORY CARD IMAGE — strided. Each console adopts its OWN card from
//      IndexedDB before _main(), which is a known divergence SOURCE this gate
//      does not close; including it here means that fork is REPORTED instead of
//      silent.
//
// ⚠ THIS IS NOT A WHOLE-STATE HASH, and must not be described as one. It will
// catch a divergence that reaches the game's own variables or the card, which
// is the class that matters, and it can miss one confined to memory it does not
// cover. That is a smaller claim than "fingerprinted" and it is the true one.
const FP_CARD_STRIDE = 64;        // words: sample 1 in 64 of the card image

function publishFingerprint(frame) {
  if (!Module || !paceI32 || paceI32.length <= FP_DIAG) return;
  if ((frame % FP_EVERY) !== 0) return;
  let h = 0x811c9dc5;
  let covered = 0;
  try {
    const buf = Module.wasmMemory.buffer;
    if (Module.___recomp_pad_witness) {
      const at = Module.___recomp_pad_witness() >>> 0;
      if (at && at + WIT_CELLS * 4 <= buf.byteLength) {
        const w = new Uint32Array(buf, at, WIT_CELLS);
        for (let i = 0; i < w.length; i++) h = Math.imul((h ^ w[i]) >>> 0, 0x01000193) >>> 0;
        covered++;
      }
    }
    if (Module.___recomp_card_base && Module.___recomp_card_size) {
      const cb = Module.___recomp_card_base() >>> 0, cs = Module.___recomp_card_size() >>> 0;
      if (cb && cs >= 4 && cb + cs <= buf.byteLength) {
        const c = new Uint32Array(buf, cb, cs >>> 2);
        for (let i = 0; i < c.length; i += FP_CARD_STRIDE) h = Math.imul((h ^ c[i]) >>> 0, 0x01000193) >>> 0;
        covered++;
      }
    }
  } catch (e) { Atomics.store(paceI32, FP_DIAG, -1); return; }
  Atomics.store(paceI32, FP_DIAG, covered);
  // Nothing readable means nothing to say. Publishing a hash over zero bytes
  // would make two consoles "agree" without either having looked at the guest —
  // which is precisely the false green this replaced.
  if (!covered) {
    if (!publishFingerprint._said) {
      publishFingerprint._said = 1;
      postMessage({ cmd: 'print', txt: '[gc-lockstep] ⚠ NO STATE FINGERPRINT: neither the pad-witness ' +
                    'block nor the card image is readable, so a divergence would go undetected' });
    }
    return;
  }
  const inject = Atomics.load(paceI32, FP_INJECT) | 0;
  if (inject) h = Math.imul((h ^ inject) >>> 0, 0x01000193) >>> 0;
  Atomics.store(paceI32, FP_FRAME, frame | 0);
  Atomics.store(paceI32, FP_HASH, h | 0);
  Atomics.store(paceI32, FP_SEQ, (Atomics.load(paceI32, FP_SEQ) + 1) | 0);
}


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
    const off = offset + done;
    // Zero-fill stays the behaviour for a read the assembled image cannot answer, but it is now
    // reachable ONLY when the offset genuinely falls past the end (or lands in a part that was
    // never delivered) — never because a fixed 100 MiB stride mis-sized a copy. See the
    // part-table note at the top of this file for the measured part sizes.
    if (off >= discBytes) { dst.fill(0, done); break; }
    let pi = 0;
    while (pi + 1 < partStarts.length && partStarts[pi + 1] <= off) pi++;
    const part = parts[pi];
    if (!part) { dst.fill(0, done); break; }
    const po = off - partStarts[pi];
    const chunk = Math.min(length - done, part.byteLength - po);
    if (chunk <= 0) { dst.fill(0, done); break; }
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
  buildPartIndex(parts);   // real per-part byteLengths -> serveDvdRead's map (note at :37-53)
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

  // ---- OSReport: the guest's own diagnostic channel ---------------------------------------
  // It used to fall through to `default: return 0`, so EVERY OSReport in the game, in MusyX's
  // asserts, and in this port's own shims went nowhere. That is not a cosmetic gap: the shims
  // deliberately report what they cannot classify rather than guessing (gc_musyx_bswap.c's
  // "MSMBSWAP unclassified read" is the example), and a report nobody can read is the same as
  // no report. It cost a round of the audio bring-up: the sequencer trapped and the only line
  // available was `main stopped: memory access out of bounds`.
  //
  // ABI. OSReport is declared variadic, and wasm32 has no varargs — clang lowers a variadic
  // call to (fmt_ptr, va_ptr) where va_ptr addresses a caller-allocated buffer of PROMOTED
  // arguments: i32 4-byte aligned, f64 and i64 8-byte aligned. Confirmed on this module rather
  // than assumed: `wasm-objdump -j Import -x mp4_game.wasm` gives `func[1] sig=2 <OSReport>`
  // and `wasm-objdump -j Type -x` gives `type[2] (i32, i32) -> nil`.
  //
  // RATE LIMITED. Each line is a postMessage to the page, so a guest error loop would flood the
  // console and perturb timing. After OSREPORT_MAX lines it says so once and goes quiet; it
  // never silently truncates.
  const OSREPORT_MAX = 500;
  let osReportN = 0;
  const cstr = (ptr) => {
    if (!ptr) return '(null)';
    const u8 = new Uint8Array(mem().buffer);
    let e = ptr >>> 0, lim = (e + 4096) >>> 0;
    while (e < lim && u8[e]) e++;
    return new TextDecoder().decode(u8.subarray(ptr >>> 0, e));
  };
  function osReport(fmtPtr, vaPtr) {
    if (osReportN >= OSREPORT_MAX) return;
    if (++osReportN === OSREPORT_MAX) { log('OSReport: rate limit reached (' + OSREPORT_MAX + ' lines), further reports suppressed'); return; }
    let fmt, out = '';
    try { fmt = cstr(fmtPtr); } catch (e) { log('OSReport: unreadable format @0x' + (fmtPtr >>> 0).toString(16)); return; }
    const d = dv();
    let va = vaPtr >>> 0;
    const i32 = () => { const v = d.getInt32(va, true); va += 4; return v; };
    const u32 = () => { const v = d.getUint32(va, true); va += 4; return v >>> 0; };
    const f64 = () => { va = (va + 7) & ~7; const v = d.getFloat64(va, true); va += 8; return v; };
    const i64 = () => { va = (va + 7) & ~7; const v = d.getBigInt64(va, true); va += 8; return v; };
    try {
      for (let i = 0; i < fmt.length; i++) {
        if (fmt[i] !== '%') { out += fmt[i]; continue; }
        // flags/width/precision are consumed but not honoured — this is a diagnostic channel,
        // not a formatter; the VALUES are what matter and mis-padding must never lose one.
        let j = i + 1, lenmod = '';
        while (j < fmt.length && '-+ #0123456789.*'.includes(fmt[j])) j++;
        while (j < fmt.length && 'hlLqjzt'.includes(fmt[j])) { lenmod += fmt[j]; j++; }
        const c = fmt[j];
        if (c === undefined) { out += fmt.slice(i); break; }
        switch (c) {
          case '%': out += '%'; break;
          case 'd': case 'i': out += (lenmod.includes('ll') ? i64() : i32()).toString(); break;
          case 'u': out += (lenmod.includes('ll') ? i64() : u32()).toString(); break;
          case 'x': out += (lenmod.includes('ll') ? i64() : u32()).toString(16); break;
          case 'X': out += (lenmod.includes('ll') ? i64() : u32()).toString(16).toUpperCase(); break;
          case 'p': out += '0x' + u32().toString(16); break;
          case 'c': out += String.fromCharCode(i32() & 0xff); break;
          case 'f': case 'F': case 'g': case 'G': case 'e': case 'E': out += f64().toString(); break;
          case 's': out += cstr(u32()); break;
          // An unknown specifier means the arg walk is no longer trustworthy: stop rather than
          // print values pulled from the wrong offsets.
          default: out += '%' + c + '<unhandled, args truncated>'; i = fmt.length; break;
        }
        i = j;
      }
    } catch (e) { out += ' <OSReport arg walk failed: ' + (e.message || e) + '>'; }
    log('OSReport: ' + out.replace(/\n+$/, ''));
  }

  // ---- UNIMPLEMENTED HOST IMPORTS: the census ---------------------------------------------
  // WHY THIS EXISTS. `default: return 0` used to swallow every host import this file does not
  // model, and a stub that returns 0 is indistinguishable, from the guest's side, from a call
  // that SUCCEEDED. That is not hypothetical here — it is how this port shipped soundless and
  // how it still downmixes to MONO:
  //
  //   MEASURED on the shipped mp4_game.wasm (md5 00f457ce…) 2026-09-04, by parsing its import
  //   and name sections: 82 imports, 79 of them host stubs after the isEmscriptenProvided
  //   filter above, 10 with a real switch case — so 69 fell through `default: return 0`.
  //
  //   THE CONSEQUENCE, traced to source: OSGetSoundMode (~/gc_refs/marioparty4/src/dolphin/os/
  //   OSRtc.c:273-282) returns `(sram->flags & 0x4) ? STEREO : MONO` off the static SramControlBlock
  //   `Scb` (OSRtc.c:24, BSS => all zero). It is supposed to be filled by __OSInitSram
  //   (OSRtc.c:161-164) via ReadSram (OSRtc.c:100), which bails on `if (!EXILock(...)) return FALSE`
  //   (OSRtc.c:105-107) leaving the buffer untouched. So the flag is never set and the mode is
  //   always MONO.
  //
  //   ⚠ CORRECTION to the note at the top of this file and to build_wasm.sh:43, both of which
  //   blame EXILock's `return 0` directly. In the SHIPPED binary EXILock is never reached on the
  //   read path at all. The argument is about CALLERS, not about what survived linking:
  //   __OSInitSram's only caller anywhere in the decomp is OS.c:279, inside OSInit — and OSInit
  //   is a host import handled by the `case 'OSInit'` below, so OS.c is not compiled and nothing
  //   in the module calls __OSInitSram. The SRAM read path is unreachable, and implementing the
  //   EXI imports alone would be a NULL FIX for the sound mode: nothing would call them.
  //   (The wasm name section agrees — __OSInitSram/ReadSram are absent from its 1601 named
  //   functions — but do NOT lean on that alone: msmSysInit and salCalcVolume are also absent
  //   and are certainly live, because inlined callees do not appear there. Name-section absence
  //   is corroboration here, not proof; the caller argument is the proof.)
  //
  // WHAT THIS DOES. Every unmodelled import is counted and its FIRST call is logged by name.
  // Counting is the point: it converts "69 unknowns" into two much smaller, actionable facts —
  // which stubs the guest actually reaches, and which are provably dead in this workload. A name
  // that never appears in the census was never called, and needs no model.
  //
  // WHY NOT LOG EVERY CALL. OSDisableInterrupts/OSRestoreInterrupts run per frame; a postMessage
  // per call would flood the page and perturb a timing-sensitive path (CLAUDE.md gate #8 —
  // diagnostics must not change what they measure). First-call-only + a counter is free.
  //
  // HOST_MODELLED is NOT an excuse list. A name belongs here only with a citation for why
  // returning 0 is the CORRECT emulation of that call in this port, not merely a harmless one.
  // Anything else stays unlisted and gets reported as UNIMPLEMENTED, including calls I believe
  // are probably fine — "probably fine" is the assumption this whole block exists to stop.
  const HOST_MODELLED = {
    PADRead:        'input is injected, not polled — gc_input.c:1-8 (no VI-retrace ISR fires PadReadVSync)',
    PADInit:        'ditto — gc_input.c:1-8',
    PADReset:       'ditto — gc_input.c:1-8',
    PADSetSpec:     'ditto — gc_input.c:1-8',
    PADRecalibrate: 'ditto — gc_input.c:1-8',
    PADControlMotor:'no rumble device is modelled',
    DCInvalidateRange: 'wasm linear memory is flat and coherent — no D-cache to invalidate',
    PPCSync:        'no store queue to drain on a flat heap',
    __sync:         'no store queue to drain on a flat heap',
    PPCMfhid2:      'no Gekko SPRs in wasm',
    PPCMthid2:      'no Gekko SPRs in wasm',
    PPCMfwpar:      'no Gekko SPRs in wasm (gather pipe is modelled by gx_wgpipe.c)',
    PPCMtwpar:      'no Gekko SPRs in wasm (gather pipe is modelled by gx_wgpipe.c)',
    LCEnable:       'the locked L1 cache is ordinary memory here (see docs/static-recomp-sab)',
  };
  const unimplHits = new Map();     // name -> call count, for every import with no switch case
  function unimplemented(n) {
    const c = (unimplHits.get(n) || 0) + 1;
    unimplHits.set(n, c);
    if (c === 1 && !(n in HOST_MODELLED))
      log('UNIMPLEMENTED host import: ' + n + '() called for the first time — returning 0, which the '
          + 'guest cannot distinguish from success. Census at boot+exit lists all of them.');
    return 0;
  }
  // Called once the module is up (all names known) and again on demand, so the list is visible
  // in the page console and capturable by tools/audio_probe.mjs / the render probe.
  function reportImportCensus(when) {
    const unmodelled = hostNames.filter((n) => !HANDLED.has(n));
    const called = unmodelled.filter((n) => unimplHits.has(n));
    const dead = unmodelled.filter((n) => !unimplHits.has(n));
    // Count the switch cases this module ACTUALLY imports, not HANDLED.size: OSPanic has a case
    // but is not among mp4_game.wasm's imports, so HANDLED.size would make the census print
    // 11 + 69 = 80 against 79 host imports. An instrument whose own arithmetic does not close
    // is not worth reading.
    const modelled = hostNames.filter((n) => HANDLED.has(n)).length;
    log('host-import census (' + when + '): ' + hostNames.length + ' host imports, '
        + modelled + ' modelled by a switch case, ' + unmodelled.length + ' returning 0.');
    if (called.length)
      log('  REACHED by the guest (' + called.length + '): '
          + called.sort((a, b) => unimplHits.get(b) - unimplHits.get(a))
                 .map((n) => n + '×' + unimplHits.get(n) + (n in HOST_MODELLED ? '(modelled)' : ''))
                 .join(', '));
    if (dead.length)
      log('  never called in this run (' + dead.length + '): ' + dead.sort().join(', '));
    postMessage({ cmd: 'importCensus', when, total: hostNames.length, modelled,
                  stubbed: unmodelled.length,
                  reached: called.map((n) => ({ name: n, calls: unimplHits.get(n),
                                                modelled: n in HOST_MODELLED })),
                  dead });
  }

  // The names with a real body below. Kept next to the switch so the two cannot drift apart:
  // the census subtracts this set from hostNames, so a case added without a HANDLED entry would
  // be miscounted as stubbed (loud and wrong-in-the-safe-direction) rather than silently missed.
  const HANDLED = new Set(['OSReport', 'OSPanic', 'OSInit', 'OSGetTime', '__OSGetSystemTime',
    'OSGetTick', 'DVDInit', 'DVDReadAbsAsyncPrio', 'DVDReadAbsAsyncForBS', 'VIGetRetraceCount',
    'VIWaitForRetrace']);

  function stub(n) {
    return (...a) => {
      switch (n) {
        // OSReport is the only one of the family this module actually imports today
        // (`wasm-objdump -j Import -x mp4_game.wasm` lists `func[1] sig=2 <OSReport>` and no
        // OSPanic/OSFatal). OSPanic is kept because it is the same walk shifted by two
        // — OSPanic(file, line, fmt, ...) — and a panic is the one message worth never losing.
        case 'OSReport': osReport(a[0], a[1]); return 0;
        case 'OSPanic':  log('OSPanic at ' + cstr(a[0]) + ':' + a[1]); osReport(a[2], a[3]); return 0;
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
          // input from the pace SAB (page keyboard/gamepad): buttons/d-pad are one-shot edges
          // (exchange-cleared — they feed the game's EDGE-triggered HuPadBtnDown/HuPadDStkRep);
          // the analog stick is the HELD state the page maintains via keydown/keyup (HuPadStkX/Y
          // are LEVEL thresholds — a single-frame blip can't drive held-analog UIs like
          // character select). Now FOUR PORTS: see the PAD_* block at the top of this file.
          // Cells 1/2/3/4/8/9 remain live as a PORT-0 ALIAS so the existing keyboard listeners
          // and gamecube/recomp/recomp_probe.mjs keep working unchanged.
          publishPeek();
          viRetrace++;
          // The fingerprint is keyed on the GUEST FRAME, and viRetrace IS that
          // clock here (gamecube.html derives the guest rate from it). Published
          // after the increment so the number names the frame just completed.
          publishFingerprint(viRetrace);
          pumpAudio();
          cardPoll();
          // Periodic host-import census. main() never returns to the worker event loop (see the
          // SAVE STATES note), so this frame hook is the only place a running census can be
          // emitted. Every 1800 frames = every 30 s of EMULATED time; one postMessage per 30 s
          // is far below the per-frame traffic already on this path.
          if ((viRetrace % 1800) === 0) reportImportCensus('frame ' + viRetrace);
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
          // ⚠ THE INPUT LATCH IS *AFTER* THE CREDIT WAIT, AND THAT ORDER IS LOAD-BEARING.
          // This is the whole lockstep primitive: one credit granted == one guest frame run with
          // exactly the pad bytes that were in the SAB when it was granted. Latching before the
          // wait (where this used to be) made the binding off by one — the worker read the pads,
          // THEN parked, so anything the page wrote while it was parked landed a frame late.
          // Deterministic, so it was harmless for a single player, but a netplay peer must be
          // able to say "frame N runs with THESE bytes" and have it be true. It is also after
          // stateServiceCmd because a restore overwrites linear memory, which is where
          // __recomp_inject_* lives — latching first would hand the guest bytes a restore then
          // discards.
          applyPads();
          return 0;
        }
        // NOT a silent 0 any more — see the census block above. The return value is unchanged
        // (still 0) on purpose: this commit makes the gap VISIBLE without changing any guest-
        // observable value, so it cannot itself be the cause of a behaviour change.
        default: return unimplemented(n);
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
  log('module up (' + hostNames.length + ' host stubs, ' + parts.length + ' disc parts, ' +
      discBytes + 'B image); running main()');
  // Boot census: every unmodelled import is 'never called' at this point, so this line is the
  // full inventory of what has no body. The later censuses are the interesting ones — they say
  // which of these the guest actually reaches.
  reportImportCensus('boot');
  // The STACK is the whole diagnosis when this fires. `main stopped: memory access out of
  // bounds` on its own names nothing — a wasm trap message carries no location — and that is
  // exactly how the 2026-09-02 audio-build trap stayed unattributed for a whole round. The
  // stack DOES carry it, provided the wasm was linked with --profiling-funcs (build_wasm.sh
  // honours RECOMP_PROFILING_FUNCS=1); without the name section the frames are `wasm-function[N]`
  // indices, which `wasm-objdump -x` still resolves offline. Costs nothing on the happy path.
  try { await Module._main(); }
  catch (e) {
    log('main stopped: ' + (e.message || e));
    if (e && e.stack) log('main stopped, stack:\n' + String(e.stack).split('\n').slice(0, 40).join('\n'));
    // A trap is exactly when the stub inventory matters most: an import that returned a plausible
    // 0 several thousand frames earlier is a prime suspect for a fault with no local cause.
    reportImportCensus('after main stopped');
  }
}

onmessage = (e) => {
  if (e.data.cmd === 'boot') boot(e.data).catch((err) => log('boot failed: ' + (err.stack || err)));
  else if (e.data.cmd === 'cardLoad') cardLoad(e.data.img);
  else if (e.data.cmd === 'cardDump') { if (!cardSnapshot()) log('memcard: dump ignored (not booted yet)'); }
};
