# MUSIC.md - the ROM's own music engine (MU1)

The arena plays the music and the sound effects of the two ROMs it already knows, decoded from the ROM bytes at runtime by a
first-party re-implementation of the GBA "m4a" / MP2K ("Sappy") sound engine. Nothing ROM-derived is committed: only offsets,
song indexes, hashes and measured constants. Nobody can listen in the test rig, so every claim below is either **exact by
construction and checked against the real engine** or labelled **approximate**; the measuring instrument is the real engine
itself, running the same ROM in the site's own mGBA core (`tools/pokemonarena_music_oracle.mjs`).

Files: `js/mp2k.js` (ROM parsing), `js/mp2k_synth.js` (sequencer + mixer, pure), `js/music.js` (the API), `js/music_test_double.js`
(recording `AudioContext` fake that the tests - and MU3's tests - use), `js/music.golden.json` (sha256 hashes and counts only),
`tools/pokemonarena_music_test.mjs`, `tools/pokemonarena_music_oracle.mjs`.

## Song tables

Found by scanning each ROM for the m4a structures (`js/mp2k.js` `findSongTable`) and cross-checked against the game's own code
(a literal-pool word equal to the table address, with the player table pointer next to it). All offsets are FILE offsets;
ROM pointers are `0x08000000 + offset`. MU2: read this section for `ROM_PROFILES`.

| | SoulGold (v1.1.1) | Ultra Violet |
|---|---|---|
| file | `gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba` | `gba/gbaWasm/roms/pokemonUltraViolet.gba` |
| size | 33,554,432 | 16,777,216 |
| sha256 | `8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a` | `467fe116ff6d7d5723b9f8fc60dd81c698c5d4e27b1b444168f3be292848d015` |
| header title / game code / maker / version | `POKEMON EMER` / `BPEE` / `01` / 0 | `ULTRA VIOLET` / `PUVV` / `01` / 0 |
| **song table offset** (`gSongTable`) | **`0x15e8ed8`** (22974168) | **`0x4a32cc`** (4862668) |
| entries | **988** (697 with tracks, 291 empty "dummy" entries incl. entry 0) | **347** (346 with tracks, entry 0 empty) |
| entry layout | 8 bytes `{u32 header*, u16 player, u16 player2}` | same |
| player table (`gMPlayTable`) | `0x15e8ea8` = table - 48 (4 players x 12 B) | `0x4a329c` = table - 48 |
| max tracks per player (BGM, SE1, SE2, SE3) | 16, 3, 9, 1 | 10, 3, 9, 1 |
| RAM player infos (BGM, SE1, SE2, SE3) | `0x03004508, 0x03004338, 0x030042f8, 0x03004178` | `0x03007300, 0x03007340, 0x03007380, 0x030073d0` |
| code references to the table (literal pool words) | `0x1a0188, 0x1a09bc, 0x1a0a04` | `0x1dd11c, 0x1dd150, 0x1dd19c, 0x1dd1f0, 0x1dd224` |
| mixer measured from `gSoundInfo` in RAM after boot | maxChans 12, masterVol 12, pcmFreq 13379 (freq index 4), pcmDmaPeriod 7, samplesPerVBlank 224, reverb 0 until a song header sets it | maxChans 5, masterVol 12, pcmFreq 13379, pcmDmaPeriod 7, samplesPerVBlank 224, reverb 0 until a song header sets it |

Song index = index into this table (entry 0 is the empty song). The `player` field says which music player runs the entry:
0 = BGM, 1..3 = SE1..SE3. SoulGold: the 344 music (player 0) entries lie in 350..987, interleaved with 84 SE2 entries (51 of them the
zero-length-wave stubs 559..609, see deviation 9); the other sound effects (223 on SE1, 39 more on SE2, 7 on SE3) are indexes 1..269 and SE3 is 81-86 and 90.
Ultra Violet: the 73 music entries lie in 264..346 interleaved with 10 SE2 entries; sound effects are 1..255 plus a few SE2 up to 338 (SE3 is 74-79 and 83).
Read `player` from the entry (`listSongs(rom)[i].player`), never from the index range. An entry whose header has zero tracks is
"empty" (`listSongs(rom)[i].empty`): playing it is a no-op in the real game and `music.play()` reports `empty-song` through `onError`.

Two corrections worth knowing (both cost time once): the table does NOT start at the first entry with tracks - entry 0 is a
zero-track header that still carries a voicegroup pointer, so a scan that only accepts all-zero dummies starts one entry late and
every index is off by one; and in SoulGold the title/intro song is index **802** (16 tracks, 76 s, does not loop), not 803.

## API

```js
import { createMusic, renderSong, listSongs, MIXER_PROFILES, detectSoundtrack } from './music.js';

const music = await createMusic({ ctx, destination, fxDestination /* default: destination */, rom, soundtrack, onEnded, onError });
music.play(index, { fadeInMs = 400, crossfadeMs = 600 })   // song-table index; crossfades from the current song; returns false (and calls onError) instead of throwing
music.stop({ fadeOutMs = 600 });  music.pause();  music.resume();  music.dispose();
music.state()   // { index, playing, loops, positionMs, paused, underruns, effects, crossfading, soundtrack, bufferedMs, disposed }
music.playEffect(index, { pan = 0, volume = 1 }) // -> handle { index, player, ignored, done, stop() }

renderSong(rom, index, { seconds, sampleRate = 32768, loops = 1, soundtrack, mixer, only, maxSeconds = 600 }) // -> { left, right, meta }   (any index, music or effect)
listSongs(rom, { analyze })   // -> [{ index, tracks, priority, reverb, player, empty, (lengthMs, loops, loopStartMs, loopLengthMs, bpm, notes) }]
```

* `rom` is the ROM bytes (`Uint8Array`/`ArrayBuffer`) or an `Mp2kRom`. `ctx` is never created here; `destination` is an AudioNode (MU3 passes the Music bus).
* **Sound effects are song-table entries** (the real game starts them with the same function as music). `playEffect(index)` runs the entry on its own
  player (`entry.player` 1..3; player-0 entries use player 1), overlapping the BGM, routed to `fxDestination`. `pan` is -1..1 or the engine's
  -63..63 (any `|pan| > 1` is read as engine units and divided by 63). The engine's player rule is modelled: one song per SE player, a new effect
  replaces the playing one only if its header priority is >= the playing one's, otherwise `handle.ignored === true`; at most 8 effects sound at once.
* A looping song loops forever (the engine's GOTO); a jingle (non-looping) calls `onEnded(index)` once after it has played out.
* `state().underruns` counts times the scheduler found its queue empty (see "Real-time buffering").
* `renderSong` is pure and deterministic. Without `seconds` it renders a jingle's length + 0.5 s, or intro + `loops` passes of the loop body.
  A request over `maxSeconds` throws `Mp2kError('render-budget')`. `meta` carries tempo, track count, loop start/length, peak, polyphony, voice-family note counts.
* Errors are typed (`Mp2kError.code`): `song-index`, `bad-ptr`, `oob`, `seq-runaway` (a zero-wait command loop is cut after 4096 commands in one tick), `no-song-table`,
  `rom-size`, `render-budget`, `empty-song`, `no-context`. The page never sees an untyped exception from `music.play`.

## Real-time buffering, seams, and start-up cost

* **Chunks are rendered at the AudioContext's own sample rate** (`ctx.sampleRate`: 48000, 44100, 96000, ...; an unusable rate falls back to 32768) in 0.25 s chunks, each scheduled with `start(frame / rate)` on a WHOLE context frame, back to back,
  and the scheduler keeps >= 1.0 s queued ahead of `ctx.currentTime` (top-up every 100 ms). A stall of less than ~1 s cannot glitch the music; a longer one lets the queue run dry, the next top-up counts it in `state().underruns`, restarts
  the stream from "now" and carries on (tested with a simulated 4 s freeze: 1 underrun, 1.2 s re-buffered).
* **Why not 32768 Hz buffers (the first version).** Measured in headless Chrome 156 (`--browser-only` section of the test): two back-to-back 8192-frame buffers at 32768 Hz on a 48000 Hz context are rendered with ONE EXTRA output frame at the end
  of the first buffer, which lands on the first frame of the second and is summed with it - the boundary sample comes out about double its neighbours, a one-sample click every 0.25 s. Probe result (Chrome/156.0.0.0, two constant-1.0 buffers, boundary frame value): 32768-Hz buffers on a 48000 Hz context **2.000** (neighbours 1.000); on a 44100 Hz context 1.000; on a 96000 Hz context 1.000 (the small seam errors the verifier saw at 44100/96000 are resampler phase, not a sum); 48000-Hz buffers on a 48000 Hz context 1.000 exactly.
  Buffers that already have the context's rate are not resampled and are exact. The mechanism was found with that probe, not assumed.
* **Seam test**: Node (`seams @rate` checks: every buffer has the context rate, every chunk starts on a whole context frame, 0 frames of gap or overlap, and the chunks played back to back equal ONE uninterrupted engine render bit for bit, at 32768 / 44100 / 48000 / 96000 Hz)
  plus the Chrome measurement (`node tools/pokemonarena_music_test.mjs --browser-only`; needs the shared browser lock; one session, about 20 s of work once the lock is free). Result in Chrome 156.0.0.0 with an `OfflineAudioContext` driven by a manual clock, 12 s of song 889, 39 seams each: at 48000, 44100 and 96000 Hz the largest difference between the chunked stream and ONE uninterrupted buffer is **0.0 at every seam and at every mid-chunk control point** (9e-13 over the whole 10 s). The old behaviour (`createMusic({ _bufferRate: 32768 })`, a test hook that also reproduces its float start times) is the negative control in both tests: in Chrome **30 of 39 seams differ from the reference by more than 0.03 (max 0.347)** while the mid-chunk controls differ by 5.6e-8, i.e. the error is exactly at the seams.
* `renderSong` stays at 32768 Hz by default: it is the deterministic reference that the goldens and the oracle comparisons pin. The real-time path runs the same `SongEngine` at the context rate, so its audio is the same music resampled by the
  engine itself (linear interpolation of the samples at the new step) rather than by the browser; it is not bit-identical to a 32768 Hz render, and is bit-identical to `renderSong(..., { sampleRate: ctx.sampleRate })` (tested).
* **First activation does not hitch**: the two shipped ROMs are recognised by header game code + size and their song table is verified entry by entry in about a millisecond (no ~100 ms whole-ROM scan; any mismatch falls back to the scan);
  the player table is found by adjacency without scanning for code references; the loop analysis is deferred off the start-up path (computed on first use, a few ms); `play()` itself renders ONE chunk (0.25 s) and each 100 ms top-up at most 2 (1 when >= 0.5 s is queued), so no single call is a long task even at 96000 Hz
  (measured in "Performance and tests"). No `hint` argument is needed (it is still accepted).
* An AudioWorklet was not used: it would need the ROM, the voice tables and the synth inside the audio thread; main-thread chunking works with a recording test double and measured 95-240x faster than real time (render cost per second of audio, warm: SoulGold's worst songs 0.0080 / 0.0063 / 0.0103 s at 32768 / 48000 / 96000 Hz, Ultra Violet's 0.0050 / 0.0061 / 0.0107).

## What is exact, what is measured, what is approximate

"Exact" below means: the same arithmetic as the real engine's, checked against the real engine's RAM/registers or audio in the oracle. It does NOT mean
"disassembled and proven": the m4a code was not disassembled; the model was written from knowledge of the engine and every behavioural claim was then
tested against the engine itself. Where the oracle could not discriminate, the item is in the approximate list.

### Exact (reproduced and checked against the oracle)

* **Song table, player table, headers, voicegroups** - found by scan, cross-checked against the game's code; the RAM `songHeader` of the engine's BGM/SE
  player equals the table entry's header pointer for every compared song (identity is read from RAM, never assumed).
* **Tick model**: 24 ticks per quarter note; `tempoC += tempoD * tempoU / 256; while (tempoC >= 150) tick()` once per video frame (59.7275 Hz, 280,896 cycles);
  initial tempo 150 BPM-units until a TEMPO command; `TEMPO n` sets `tempoD = 2n`. Checked: the engine's `tempoD` in RAM (148, 126, 91...) equals what the
  sequence data produces, and the whole-song loudness envelope correlates 0.98-1.00 on pure-sample songs (a 5% tempo error drops waveform correlation from 0.98 to 0.15-0.36).
* **Command set and order inside a tick** (gate-time countdown, commands, wait counter, LFO), running status, PATT depth 3, REPT, GOTO, FINE, TIE/EOT, PRIO,
  KEYSH, BEND/BENDR (range in semitones, x4 in 1/256-semitone units), TUNE, MOD/MODT/LFOS/LFODL (triangle LFO, once per tick), VOL/PAN with the engine's
  `TrkVolPitSet` and per-channel `ChnVolSet` integer formulas, key-split and rhythm voicegroups (a drum voice's pitch comes from its own entry).
* **Direct-sound envelope**: attack adds, decay multiplies by `decay/256`, sustain level, release multiplies by `release/256`, one step per video frame;
  `x = envelope * (masterVol + 1) >> 4`, `envR = rightVol * x >> 8`. Linear interpolation between samples, loop start/end from the wave header, fixed-frequency voices
  (type 0x08) step at the mixer rate (13379 Hz) without interpolation, DPCM-compressed waves are decoded with the codec cries.js documents (no song uses one: 0 of the 396 distinct waves SoulGold's songs reference and 0 of Ultra Violet's 83; so the DPCM path is untested against the oracle).
* **Mixer parameters** of both ROMs, read from `gSoundInfo` in RAM after boot (not assumed): SoulGold 12 direct-sound channels, Ultra Violet 5; both masterVol 12, 13379 Hz,
  224 samples per video frame, 7-frame DMA period. `tools/pokemonarena_music_oracle.mjs --mixer` re-measures them; the test asserts `MIXER_PROFILES` equals them.
* **Reverb**, measured by impulse-response identification of the oracle's output against the synth's dry render (the song-805 identification showed no echo energy near
  1 frame and two echoes at 7 and 8 frames): `wet[n] = reverb/256 * (out[n - 7F] + out[n - 8F])`, fed back from the output, F = one video frame (548.65 samples at 32768 Hz). After the model
  was put in, the same identification shows no tap above 0.012 anywhere in 20,000 samples (the echo energy at those lags was 0.13 before). Songs set the level through the header's reverb byte (bit 7 + level, 50 in these ROMs).
* **PSG initial volume** `(rightVol + leftVol) >> 4` clipped to 15 equals the hardware envelope register's initial volume (sound effect 4: 10, effect 31: 9, song 980 chord: 11).
* **PSG pulse level**: a square at envelope volume v is a unipolar 0 / 3v pulse in units of 1/128 full scale (v = 10 -> 0.2344 of full scale in the oracle's output, exactly 30/128).
* **Wave-channel volume code** (SOUND3CNT_H), MEASURED on settled frames only (the synth's envelope constant over 5 frames and the register constant over 5 frames; a first version used every frame, transitions included, and was off by a step):
  envelope 2,3,4 -> 25%; 6,7,8,9 -> 50%; 10,11,12,13 -> 75% (the register's bit 15 "force 75%"); 14,15 -> 100%. Natural songs plus patched COPIES of six songs whose wave notes sweep every envelope value 0..15 (`--wave-map`;
  4,120 settled frames, the test asserts 4120 of 4120 agree). Not observed in the settled data: envelope 0 (silence), 1 and 5; the independent verifier's register trace saw 1 -> mute and 5 -> 25% and the table is a 4-wide quantiser (thresholds 2, 6, 10, 14), so those two entries are taken from there and the step pattern.
* **Square-wave pitch register**: x = floor(2048 - 131072 / f) with f equal-tempered (A = 440) at the continuous pitch (key + bend + tune + vibrato); i.e. the divisor is CEIL(131072/f). Measured on the oracle for every key 36..108 with a patched copy that plays one square note per key
  (`node tools/pokemonarena_music_oracle.mjs --key-sweep`, also a test): among the 28 keys 56..108 where ceil and round-to-nearest differ, the oracle follows ceil on 27 (e.g. key 87 -> divisor 106, key 93 -> 75, key 105 -> 38). Rounding to nearest, which this synth used first, had put 28 of 73 keys one register step (up to 1.6%) flat or sharp.
* **Square 1 sweep** (NR10 = the voice's `pan_sweep` byte): x -> x +- (x >> shift) every T/128 s, stopped when it passes 2047; it is used by 18 SoulGold songs (effects 1, 5, 7, 10, 15, 16, 23, 34, 45, 46, 50, 72, 79, 121, 267, 268, 368, 387) and 16 Ultra Violet effects. Effect 16's worst octave band went from 14.4 dB to 3.7 dB with it.
* **Noise sampling**: the LFSR output is averaged over TWO instants per output sample (mid-sample and end). A point-sampled LFSR was +2..4 dB too bright in the 4.8-9.6 kHz octave against the oracle, a full-sample box average -5..-8 dB too dull; two instants: effects 6, 16, 17, 35 are within 1.4-3.7 dB.
* **The PSG is not reverbed, and the direct-sound mix is one video frame behind the PSG.** The engine's reverb works on the PCM buffer only (the PSG is hardware); with the PSG kept out of it the envelope correlation of PSG-only effects rose (4: 0.973 -> 0.992, 10: 0.987 -> 0.994, 23: 0.985 -> 0.997).
  And the direct-sound audio is double-buffered through the sound DMA, so it sounds one frame (16.7 ms) AFTER the PSG notes written in the same frame: modelling that (`dsDelay: 1`) took effect 56 (a sample plus a square) from waveform 0.81 to 0.96 and envelope 0.95 to 0.997, and made the BGM and SE latencies equal.
* **Ultra Violet is MONO.** `gSoundInfo.mode` is 1 there (0 in SoulGold) and the real output has L == R in every captured sample: 73 of 73 music songs (3-4 s each) and 7 effects, 0 differing samples; SoulGold songs differ in 86-96% of frames (805, 350, 802). The synth renders UV with L = R = (L + R)/2 (`mono: true` in its `MIXER_PROFILES`).
  Averaging the panned mix matched the oracle better than forcing the PSG to full level on both sides, or taking only one channel. The test asserts L == R for UV and L != R for SoulGold, in the synth and in a fresh oracle capture.
* **Latency**: after the direct-sound frame is modelled, the oracle's audio lags the synth by 1 video frame (17.6-17.8 ms) for songs and effects alike (it was 2 frames for songs and 1 for effects before).
* **Output stage**: direct-sound output is multiplied by 0.75 (`pcmGain`) relative to the 8-bit-domain arithmetic above. This is a CALIBRATION constant, measured (median RMS ratio oracle/synth 1.004 over
  86 SoulGold songs with 0.75); it is not derived from any source.

### Approximate or different (every known deviation)

1. **Resampling**: the original mixes at 13379 Hz, then the console DAC holds each sample (zero-order hold) and mGBA resamples to 32768/65536 Hz. This synth steps sample
   positions directly at the output rate with linear interpolation. It therefore has no 13.4 kHz imaging: **the top octave (9.6-16 kHz) is 4-13 dB LOWER than the real console's** (the oracle has ~+9 dB more energy there: images of the hold; not reproduced because it would change every render and the images are an artefact of the console's DAC, not music). The octave bands from 60 Hz to 9.6 kHz agree within 1.3 dB on the compared SoulGold songs.
2. **Envelope and volume are constant within a video frame** (as in the engine), so very fast envelopes step at 59.7 Hz; no declick. The first frame of a note uses the new volume at once.
3. **Voice stealing when every direct-sound channel is busy**: free channel first, then a releasing one, then the lowest priority, ties by track order and age. The tie-break is NOT understood: "A" (an earlier
   track may take an equal-priority channel) fits SoulGold slightly better (median waveform correlation 0.955 vs 0.945 on 12 songs) and "S" (never) fits Ultra Violet song 321 far better (0.873 vs 0.691), so
   `MIXER_PROFILES` carries `steal: 'A'` for SoulGold and `'S'` for Ultra Violet. **But it is not where the weak songs lose their score.** Reading the real mixer's channel structs per frame (slot status, key, owning track) and comparing the SET of live non-releasing notes with the synth's, frame by frame over the first 480 frames: Jaccard 0.979 mean over 10 Ultra Violet songs (299, 286, 297, 293, 274 and 303, 298 are exactly 1.000), 0.973 over 6 SoulGold songs (436, 461, 447, 511 exactly 1.000); policies "A" and "S" score identically there. The real engine reads the owning TRACK's priority at comparison time (priority is not stored in the channel), which this synth stores per note - untested because no compared window differs. What the weak songs lose is PSG phase, the choice among RELEASING channels, and the sweep/vibrato details below.
4. **PSG (square / programmable wave / noise)** are re-created from the hardware's documented behaviour, not from the engine's own tables: duty patterns 12.5/25/50/75% area-averaged per output sample (band-limited), 4-bit programmable waves played at 65536/(2048-n) Hz
   (the hardware wave channel; octave chosen by a weak log-spectrum preference over +-1 octave), noise by the 15/7-bit LFSR clocked per the engine's NR43 table (index = key - 21) and sampled at two instants per output sample. The software envelope
   (attack/decay/sustain/release stepping 1 volume unit every N frames) is validated only by loudness-envelope correlation on 13 PSG-only sound effects (0.88-0.99), not register by register: the
   hardware keeps part of the envelope in its own counter, which the register nibble does not show.
   Waveform-level agreement of the PSG is now good where the pitch is a plain key (effect 31: 0.95, 56: 0.96, song 980: 0.58 from 0.29) and still low where a note is bent, swept or vibrato'd or two squares overlap (effects 4: 0.39, 45: 0.15, 46: 0.28): the register arithmetic under bend/tune/vibrato is the continuous formula above (verified on one bent note: it reproduces the oracle's 2048 Hz where linear interpolation between per-semitone registers does not), the sweep start-up and the hardware duty phase are simplified. The PSG is verified by pitch rule, spectrum, loudness envelope and level.
5. **PSG DC**: mGBA (the oracle) keeps the pulse's DC offset (unipolar output). A real GBA AC-couples its output and a DC step on every note is a click, so the synth removes DC with a ~10 Hz one-pole high pass.
   The oracle comparisons high-pass BOTH sides at 25 Hz so this cannot bias a metric.
6. **Wave-channel volume for envelope values 0, 1 and 5** are not in the settled oracle data (see the exact list). The sweep's first step timing and shadow-register overflow check are simplified. The hardware length counter (voice `length`) is modelled as an auto-stop and not verified.
7. **Opcodes**: XCMD handles only the echo volume/length pair (`xIECV`/`xIECL`) and treats any other xcmd as "one parameter byte, ignore"; MEMACC (which writes game RAM) is skipped; the unused slots
   0xB6-0xB8, 0xC6, 0xC7, 0xC9-0xCC are no-ops. The pseudo-echo (`xIECV`) path is implemented as understood and NOT verified (no compared song was checked for it).
8. **Not implemented**: the engine's own fade-out (`m4aMPlayFadeOut`) - fades are done with gain ramps; reverse playback (voice type 0x10); the cry songs' special modes.
9. **SoulGold's zero-length-wave stubs** (song-table indexes 559..609, 51 entries on SE player 2): their voice points at a wave header with `size = 0` at 44100 Hz; the real engine outputs a nearly constant
   DC level for them (measured: mean -4800/32768, AC rms 3000 on song 559, envelope ramping up then decaying), i.e. a control/marker signal rather than audio. The synth renders them silent (counted as an unsupported voice).
   Do not use them as sound effects.
10. **Reverb default**: a song whose header has no reverb flag renders with reverb 0 (the boot value measured in RAM); in the real game the level persists from the previously started song.
11. **Mixer rate for fixed-frequency voices** is the measured 13379 Hz; a ROM that switched the mixer rate at run time would not be followed (not observed, not exhaustively checked).
12. **Two SoulGold sound effects (946, 975) have 10 and 11 tracks on a 9-track player**; the engine drops the extra tracks and so does the synth (not compared against the oracle).
13. **Real-time path** differs from the offline renderer only by chunking (0.25 s), the sample rate (the context's own, e.g. 48000 Hz, instead of the 32768 Hz reference) and the gain ramps for fades; the same `SongEngine` produces both. See "Real-time buffering, seams, and start-up cost".

### Calibration constants (all measured, none derived)

| constant | value | how measured |
|---|---|---|
| `pcmGain` (direct-sound output scale) | 0.75 | RMS ratio oracle/synth over 86 SoulGold songs = 1.004 (median), 84 within +-10% |
| PSG pulse level | 3 LSB (of 128) per envelope-volume step | oracle waveform of sound effect 4: 0 / 0.2344 at volume 10 |
| reverb taps | lags 7 and 8 video frames, gain reverb/256 | impulse response of song 802 against the dry render |
| residual latency (oracle vs synth) | 1 video frame (17.6-17.8 ms), songs and effects | aligned lag of every comparison, after `dsDelay: 1` |
| `dsDelay` | 1 frame | effect 56: waveform 0.81 -> 0.96; BGM and SE lags become equal |
| square register | `floor(2048 - 131072/f)` | `--key-sweep`: 27 of 28 distinguishing keys |
| wave-channel volume table | 4-step quantiser, thresholds 2/6/10/14 | settled frames, 4120 of 4120 agree |
| mono | Ultra Violet only (`gSoundInfo.mode` 1) | L == R in 80 of 80 captures |
| `MIXER_PROFILES` | see "Song tables" | `gSoundInfo` in RAM |

## Oracle comparison (the real m4a engine in mGBA vs `renderSong`)

How it works (`tools/pokemonarena_music_oracle.mjs`; run `node tools/pokemonarena_music_oracle.mjs`, `--quick`, `--songs sg:805 uv:321`, `--mixer`, `--wave-map`, `--stereo [--rom sg|uv]`):
the ROM boots in `gba/mgba/mgba_core.js` (read-only here); the game's OWN `m4aSongNumStart(index)` is entered by editing the saved CPU state (the bridge has no register API), returning into the
interrupted code through a tiny stub in unused EWRAM; the call is PROVEN to have taken because one frame later the player's `songHeader` pointer in RAM equals the song-table entry's header pointer
(1 try for SoulGold from a silenced state, 8-17 for Ultra Violet, whose CPU sits in different code each frame); then 8 s of the core's audio are captured and compared with `renderSong` for the same index.
Natural rows use OR1's real-battle oracle (`tools/pokemonarena_rom_oracle.mjs`): the GAME chose the song, the index is read from RAM, and alignment uses the engine's own tick counter.
Some measurements (`--wave-map`, the key sweep) run on in-memory PATCHED COPIES of the ROM (a song's note velocities/volumes rewritten, or a synthetic one-note-per-key song written into free space); the file and the repo are never touched, and the real engine and the synth always run the same patched bytes.

Metrics (mono, 32768 Hz, both sides high-passed at 25 Hz): **envCorr** = correlation of 20 ms RMS loudness envelopes; **waveCorr** = sample-by-sample correlation over 3 s at the best alignment; **logSpec** = mean
log-magnitude-spectrum correlation 100 Hz-5 kHz; **level** = RMS(oracle) / RMS(synth); **bandMax** = largest |dB difference| over the 7 octave bands 60 Hz-9.6 kHz; **onsetF1** = note-onset agreement within 25 ms. `lag` is now
about 17.7 ms (1 video frame) for everything: the direct-sound frame delay is modelled, so the old 34 ms (songs) vs 16 ms (effects) split is gone.
Controls (same procedure, best alignment): a different song of the same ROM, and the right song at 1.05x tempo. Run 2026-11-02 on a shared 16-CPU Windows box (other agents running; Windows reports no load average).

| compared | tracks | envCorr | waveCorr | logSpec | level | bandMax dB | onsetF1 | control: wrong song (wave / env) | control: tempo x1.05 (wave / env) |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| SoulGold 802 | 16 | 0.992 | 0.972 | 0.910 | 1.012 | 1.1 | 1.00 | 0.181 / 0.154 | 0.209 / 0.304 |
| SoulGold 805 | 7 | 1.000 | 0.980 | 0.770 | 1.009 | 0.7 | 0.92 | 0.067 / 0.039 | 0.153 / 0.270 |
| SoulGold 350 | 9 | 0.977 | 0.945 | 0.871 | 0.998 | 0.3 | 0.89 | 0.029 / -0.097 | 0.167 / 0.226 |
| SoulGold 362 | 8 | 0.981 | 0.912 | 0.840 | 1.011 | 0.5 | 0.90 | 0.035 / 0.016 | 0.194 / 0.387 |
| SoulGold 399 | 8 | 0.978 | 0.910 | 0.792 | 1.014 | 1.3 | 0.91 | 0.048 / 0.250 | 0.318 / 0.288 |
| SoulGold 4 (sound effect) | 1 | 0.992 | 0.890 | 0.687 | 0.967 | 0.8 | 1.00 | 0.025 / 0.399 | 0.767 / 0.889 |
| SoulGold 10 (sound effect) | 1 | 0.998 | 0.450 | 0.716 | 0.995 | 0.7 | 0.00 | 0.064 / 0.723 | 0.450 / 0.998 |
| SoulGold 16 | 3 | 0.994 | 0.399 | 0.558 | 0.986 | 3.6 | 0.00 | 0.044 / 0.487 | 0.400 / 0.996 |
| SoulGold 31 (sound effect) | 1 | 0.996 | 0.917 | 0.861 | 0.931 | 6.8 | 0.00 | 0.016 / 0.256 | 0.917 / 0.996 |
| SoulGold 35 (sound effect) | 1 | 0.998 | 0.641 | 0.422 | 1.002 | 1.9 | 1.00 | 0.089 / -0.297 | 0.641 / 0.998 |
| SoulGold 56 | 2 | 0.998 | 0.964 | 0.451 | 0.977 | 0.8 | 0.00 | 0.047 / -0.120 | 0.964 / 0.998 |
| Ultra Violet 321 | 5 | 0.978 | 0.879 | 0.778 | 0.953 | 0.9 | 0.80 | 0.014 / -0.215 | 0.379 / 0.859 |
| Ultra Violet 264 | 7 | 0.983 | 0.666 | 0.795 | 0.996 | 0.3 | 1.00 | 0.051 / -0.061 | 0.131 / 0.516 |
| SoulGold 888 (natural, CK_BATTLE_INTRO) | - | 0.999 | 0.976 | 0.913 | 1.007 | 0.7 | 0.92 | 0.096 (best lag) | - |
| SoulGold 887 (natural, CK_WILD_INTRO) | - | 0.997 | 0.988 | 0.919 | 1.014 | 0.7 | 1.00 | 0.080 (best lag) | - |

Reading it: the sample-based (direct-sound) songs reproduce the real engine nearly sample for sample (SoulGold 802, 805 and both battle themes: waveform correlation 0.972-0.988, level within 1.4%).
Songs that also use the PSG voices keep the loudness envelope (0.98) and level and now also most of the waveform (0.91-0.95 for songs 350/362/399; it was 0.90-0.94 before the pitch rule and the DS/PSG timing were fixed).
Sound effects: 4 (0.89), 31 (0.92) and 56 (0.96) match sample for sample; 10 (0.45), 16 (0.40) and 35 (0.64, noise) have an envelope correlation of 0.99+ but keep a lower waveform match (bends, a sweep, noise, overlapping squares).
The short sound effects are weak evidence for the tempo control (a one-note effect barely drifts in 2.5 s): their wrong-song control separates them, the tempo control does not always.

### Beyond the headline rows: many more background songs

Same procedure (8 s per song, a scratch bulk script; every 4th SoulGold background song and EVERY Ultra Violet background song; the song-start call was proven for every one). Before this fix round / after:

| ROM | songs | envCorr median / p10 | waveCorr median / p10 / min | level median, within +-10% | no PSG: waveCorr median | with PSG: waveCorr median, envCorr |
|---|---:|---|---|---|---|---|
| SoulGold, before | 86 | 0.980 / 0.853 | 0.914 / 0.544 / 0.289 | 1.004, 84 of 86 | 0.975 (42) | 0.747 (44), 0.933 |
| **SoulGold, now** | 86 | **0.992 / 0.887** | **0.925 / 0.543 / 0.436** | 1.004, **85 of 86** | 0.971 (42) | **0.769** (44), **0.966** |
| Ultra Violet, before | 73 | 0.885 / 0.737 | 0.702 / 0.492 / 0.279 | 1.004, 69 of 73 | 0.955 (2) | 0.701 (71), 0.881 |
| **Ultra Violet, now** | 73 | **0.931 / 0.838** | 0.697 / 0.447 / 0.371 | 1.008, **70 of 73** | 0.940 (2) | 0.694 (71), **0.924** |

The loudness envelope improved clearly on both ROMs (the wave-channel table, the PSG-out-of-reverb and the DS-after-PSG timing); the median waveform correlation did not move on Ultra Violet (0.70): its songs are PSG-heavy (71 of 73) and the waveform of a PSG note depends on
bend/sweep/vibrato arithmetic and the hardware duty phase, which are simplified. Weakest now - SoulGold: 486, 980, 503, 984, 552, 411, 849 (37 note steals), 443 (envelope 0.91-0.99, waveform 0.44-0.52); Ultra Violet: 291, 272, 332, 281, 293, 274, 343, 289 (envelope 0.87-0.98, waveform 0.37-0.45).
The weakest songs named by the independent verifier moved as follows (envelope correlation, verifier's number -> mine now): Ultra Violet 299 0.566 -> 0.81, 286 0.659 -> 0.85, 297 0.704 -> 0.84; SoulGold 436 0.681-0.714 -> 0.95.

### Voice allocation measured directly (the stealing question)

For ten Ultra Violet and six SoulGold songs the real mixer's channel structs (`gSoundInfo.chans[]`: status byte, key at +0x11, owning track pointer at +0x2C) were read every video frame and the SET of live non-releasing notes (track, key) was compared with the synth's, frame by frame over the first 480 frames:
mean Jaccard **0.979 (Ultra Violet)** and **0.973 (SoulGold)**; Ultra Violet 299, 286, 297, 293, 274, 303, 298 and SoulGold 436, 461, 447, 511 are exactly 1.000. The stealing policies "A" and "S" score identically there. So at least in these windows the voice allocation is not what lowers the weak songs' scores (it differs only in
which RELEASING channel is kept, which is inaudible). The real engine reads the owning track's priority at the moment of comparison; this synth stores it per note. No compared window differs, so that was left alone and is a known simplification.

### Mutants and negative controls (all in `tools/pokemonarena_music_test.mjs`; each must fail the named check, and the unmutated twin passes)

| mutation of the synth | caught by | measured |
|---|---|---|
| output gain x1.5 | level within 10% | level 0.673 |
| masterVol 12 -> 8 | level within 10% | level 1.471 |
| tempo +2% | waveform correlation >= 0.9 | 0.285 (unmutated 0.979) |
| reverb off | waveform correlation below the unmutated one | 0.949 vs 0.979 |
| 3 direct-sound channels instead of 12 | waveform correlation | 0.327 |
| wrong song / 5% tempo error | the per-song controls in the table above | waveform 0.02-0.21 / 0.13-0.36 |
| square register rounded to nearest | effect 31 waveform | 0.347 vs 0.917; and key 87 -> 105 instead of 106 |
| PSG put through the reverb | effect 4 envelope | 0.973 vs 0.992 |
| no one-frame DS delay | effect 56 waveform | 0.806 vs 0.964 |
| no NR10 sweep | effect 16 worst octave band | 12.9 dB vs 3.7 dB |
| noise box-averaged over the whole sample | effect 35 worst octave band | 8.0 dB vs 1.9 dB |
| the previous wave-volume table | settled-frame agreement | fewer than 4120 of 4120 |
| Ultra Violet in stereo | `L == R` | 98,289 differing samples in 3 s |

## Performance and tests

* Render cost (`renderSong`, one core, Node 24.19 on Windows 11, shared machine, CPU busy 15-70% during the runs; Windows reports no load average), warm, seconds of CPU per second of audio: SoulGold's worst songs 0.0080 / 0.0063 / 0.0103 at 32768 / 48000 / 96000 Hz,
  Ultra Violet's 0.0050 / 0.0061 / 0.0107 - i.e. 95-240x faster than real time at every device rate. The test's full sweep: all 697 SoulGold songs (2615 s of audio) in 6.3 s, all 346 Ultra Violet songs (796 s) in 2.6 s, worst single song 170x / 149x real time.
* **First activation** (a fresh Node process, cold JIT, the recording double): `createMusic` 0.7-1.2 ms (it was ~100 ms: the whole-ROM scan; now the known song table is verified in ~1 ms), `play()` 15-23 ms (one 0.25 s chunk plus building the voice; the loop analysis is deferred), and every later 100 ms top-up
  0.4-0.8 ms on average, 3-7 ms worst (at 96000 Hz). The two long tasks of 55 and 112 ms a verifier saw on the first key press were the scan and the analysis; both are off that path.
* `node tools/pokemonarena_music_test.mjs` -> **233 passed, 0 failed, 0 skipped** (109 s, both ROMs, OR1 states warm); `--no-oracle` -> 178 passed, 0 failed, 1 skipped (the oracle section, counted). 41 of the checks are explicit `[control]` negative controls (before this round: 190 passed, 28 controls).
  `node tools/pokemonarena_music_test.mjs --browser-only` (headless Chrome 156 + `OfflineAudioContext`, no audio device; waits for the shared browser lock) -> **6 passed, 0 failed**: the doubled-boundary mechanism probe, bit-exact seams at 48000 / 44100 / 96000 Hz, and the old behaviour failing the same measurement (30 of 39 seams > 0.03).
  It covers: both song tables located by scan AND by the fast known-table path, cross-checked against the code, every header of both tables, a walk of all 1043 non-empty songs, a render of every one of them (finite, within full scale, audible except the 51 documented stubs), bit-exact determinism and sha256 goldens
  (`js/music.golden.json`, hashes and counts only) for 16 songs, corrupted-input checks (typed errors; a zero-wait loop cut in about 1 ms; nothing hangs), real-time checks against the recording AudioContext double (look-ahead, crossfade, jingle end, pause/resume, effects, priority rule, error containment,
  a simulated 4 s stall, and the seam invariants at four device rates), the oracle comparisons above, mutants of the synth against captured effects and songs, the square-register / wave-volume / sweep / noise / DS-delay / PSG-reverb / mono checks, and two natural captures.
* Other suites re-run after this round: `node tools/pokemonarena_music_map_test.mjs` 906 passed, 0 failed, 0 skipped (before: 906/0); `node tools/pokemonarena_sound_test.mjs` 159 passed, 0 failed (before: 159/0). `tools/pokemonarena_sound_page_test.mjs` (browser, drives the director with real `music.js` in a page) was NOT re-run in this round - it needs the browser lock.
* Goldens are hashes of the Float32 output on THIS Node/V8 (`Math.pow`/`Math.exp` are not specified bit-exactly across engines); the test also stores a 10-bit-quantised hash and, on a different Node/platform, accepts that one instead of the strict hash. This round changed the reference renders on purpose (new PSG pitch rule, wave table, sweep, noise sampling, PSG out of the reverb,
  direct-sound mix one frame behind the PSG, Ultra Violet mono), so every golden that involves those was regenerated; the SoulGold direct-sound-only songs changed only by the one-frame delay.

## When the music may start: the browser's autoplay policy, MEASURED

The Arena starts its music **as soon as the browser allows it**: it tries at page load, and where the browser refuses, the visitor's very first click, tap or key press anywhere on the page starts it. What "as soon as the browser allows it" means was
**measured, not assumed**, in a real Chrome launched without `--autoplay-policy=no-user-gesture-required` (every other test of this project runs with that flag, so they cannot say anything about the policy a visitor has), muted with `--mute-audio`:
`node tools/pokemonarena_autoplay_test.mjs` (the experiment is its first section; page code is not involved).

Measured 2026-11-03 on **Chrome/156.0.8078.79** (Windows 11, `--headless=new`), default autoplay policy, a fresh profile:

| situation | `navigator.userActivation.hasBeenActive` | a NEW `AudioContext()` |
|---|---|---|
| the hub just loaded, no gesture yet | false | `suspended`; `resume()` stays pending |
| a real click (CDP mouse) on a same-origin link that loads `battle.html` | **true** in the new document | **`running` at once** |
| a real click whose handler calls `location.assign(battle.html)` (what the hub does on Start) | **true** | **`running` at once** |
| the same battle address typed (no gesture; the control) | false | `suspended` again |

So **Chrome carries the visitor's click across a same-origin navigation** (sticky user activation), and Web Audio may start in the new document without a second click. The old mixer wasted that: it created no context until it saw a *new* gesture event in
the new document, which is why the battle music seemed to need "another click". The mixer now tries at once (`audio_mixer.js` `earlyStart`, switched on by `sound_system.js`): it creates the context and asks it to resume; Chrome runs it where the carried gesture or an autoplay
permission allows it, and the music starts as soon as the song is decoded, before the battle screen has needed any input. Where it does not (a typed address, a bookmark, a reload with no gesture) the context stays suspended and the listeners that were
armed at the same moment (`keydown`, `mousedown`, `pointerdown`, `pointerup`, `touchstart`, `touchend`, captured on the window, removed once the context runs) start it on the first gesture **anywhere**, with no Sound button, and the
"start the sound" hint is shown until then. A visitor who muted the sound stored `muted`: nothing is created at load (their first gesture still creates the context, so a controller can unmute later); a stored choice of any field always wins over the new defaults.
A page that LOADS in a hidden tab (opened in the background) makes no early try at load, so it makes it the moment the tab is shown (`audio_mixer.js` `setHidden(false)`; tested in `tools/pokemonarena_sound_test.mjs`: allowed -> running at once, blocked -> a suspended context that the first gesture starts, muted -> still nothing).

Also measured: **a bare modifier key (Shift) is not a user activation in Chrome** (a letter key, an arrow or Tab is); `Escape` is not either (the HTML rule). Both are cases of `tools/pokemonarena_autoplay_test.mjs`, not only a remark: it presses a real Shift and a real Escape on a page with no gesture and checks that the context stays suspended and `navigator.userActivation.hasBeenActive` stays false (Chrome/156.0.8078.79: it does), then a letter key starts it. A **controller button** is not one (the page tries `unlock()` on a pad press anyway and hides the hint: where a
browser does count it, the sound starts; this box has no physical pad, so that path is only exercised with the synthetic one in the tests).

**Not measured:** Safari and Firefox (their policies differ: Safari also wants the unlock inside a `touchend` or click; Firefox's block list is per site), Chrome on Android (it may also weigh a Media Engagement score), and a visitor whose site data or autoplay setting is
different. The page behaves the same everywhere (try at load, then the first gesture); only *which* of the two applies differs. `tools/pokemonarena_autoplay_test.mjs` always prints what it measured and asserts only what holds in every browser (a document nobody has touched has no user activation);
when the browser it runs on does not reproduce the table above it **prints `SKIP:` and skips the table-specific cases and every page case (exit 0)** instead of failing them. That promise is tested too: the file re-runs itself against a table it
cannot match (the measured one with every verdict flipped, through `ARENA_AUTOPLAY_EXPECT`) and requires exit 0, a `SKIP:` line, no `FAIL` line and no page case run.

## What plays when a battle begins: the classic battle theme from the first frame

In the real game the battle song is chosen **at the start of the battle** (`GetBattleBGM`, reached through `PlayMapChosenOrBattleBGM`: MUSIC_MAP.md has the addresses): the wild theme for a wild Pokemon, the trainer theme for a trainer, the leader theme for a Leader / Elite Four member
(SoulGold songs **887 / 888 / 889**, Ultra Violet's **298 / 297 / 296**). The Arena maps the CPU level onto that: `easy` is the wild theme, `normal` the trainer theme, `hard` the leader theme (`music_map.js` `battle_easy` / `battle_normal` / `battle_hard`).

* **What it did before:** the team preview of a 3v3 battle (the Quick Battle default) played the song `preview`, SoulGold **416** `MUS-ENCOUNTER-INTENSE`, which is the *overworld* trainer-encounter theme the game plays when a trainer spots you, a medium-confidence mood pick for the preview
  (MUSIC_MAP.md), and the battle song only began after the team was chosen. A 6v6 battle (no preview) already started on the battle song.
* **What it does now:** the battle song of the CPU level starts at the **first frame of the battle**, team preview included (`sound_system.js` `battleFrameInner`: the preview asks the director for `battle_<cpu>`), and carries on unchanged into the first turn (asking for the song that is already playing restarts nothing: one `play`,
  no second one). The song's own intro and loop are the engine's (`MUSIC.md` "Exact": a track that ends in a GOTO loops); the result music (fanfare, then `result_win` / `result_lose`) is unchanged. `music_map.js` and the director's fallback table still define `preview`; nothing in a battle asks for it.
* **The soundtrack choice** (SOUND panel: SoulGold / Ultra Violet) changes the song because `songFor(soundtrack, key)` does; Ultra Violet has all three levels (298 / 297 / 296), so the same rule holds there.
* **Verified by** `tools/pokemonarena_sound_page_test.mjs` (the real director's `play` log: cpu=hard asks for the hard song at the team preview and plays it once through the first turn; the whole sequence is song, jingle, result) and `tools/pokemonarena_autoplay_test.mjs` (a battle reached
  by a click starts its song before any input in the battle document: cpu=normal asks for `battle_normal` first and the engine is told to play it, never `preview`).

## All songs

Generated from the ROMs by `analyzeSong` (length = a jingle's length, or intro + one pass of the loop). Columns: player (BGM/SE1/SE2/SE3), tracks, header priority, header reverb (`-` = not set), first tempo in engine BPM units
(`*` = the tempo changes later), length in seconds, loop (loop start / loop body in seconds), note count over that length, voice-family notes (direct-sound / square / wave / noise).
**No song is mapped to a game moment here; that is MU2's job** (`pokemonarena/MUSIC_MAP.md`). Song 802 of SoulGold is the title/intro piece (16 tracks, 76 s, ends).

### SoulGold - 697 songs with tracks

| index | player | tracks | prio | reverb | bpm | length s | loop (starts s / body s) | notes | voices (ds/sq/wave/noise notes) |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | SE1 | 1 | 5 | 50 | 132 | 0.49 | no (ends) | 3 | 0/3/0/0 |
| 2 | SE1 | 1 | 5 | 50 | 144 | 0.43 | no (ends) | 4 | 0/4/0/0 |
| 3 | SE1 | 1 | 5 | 50 | 120 | 0.40 | no (ends) | 4 | 0/4/0/0 |
| 4 | SE1 | 1 | 5 | 50 | 144 | 1.02 | no (ends) | 9 | 0/9/0/0 |
| 5 | SE2 | 1 | 5 | 50 | 300 | 0.17 | no (ends) | 5 | 0/5/0/0 |
| 6 | SE1 | 1 | 5 | 50 | 220 | 0.30 | no (ends) | 2 | 0/0/0/2 |
| 7 | SE2 | 1 | 2 | 50 | 220 | 0.30 | no (ends) | 1 | 0/1/0/0 |
| 8 | SE1 | 1 | 5 | 50 | 110 | 0.57 | no (ends) | 2 | 0/0/0/2 |
| 9 | SE1 | 1 | 5 | 50 | 120 | 0.65 | no (ends) | 8 | 0/0/0/8 |
| 10 | SE1 | 1 | 4 | 50 | 120 | 0.22 | no (ends) | 2 | 0/2/0/0 |
| 11 | SE1 | 1 | 4 | 50 | 120 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 12 | SE1 | 2 | 5 | 50 | 90 | 0.27 | no (ends) | 3 | 1/0/0/2 |
| 13 | SE1 | 2 | 5 | 50 | 90 | 1.19 | no (ends) | 4 | 2/0/0/2 |
| 14 | SE1 | 2 | 5 | 50 | 90 | 1.44 | no (ends) | 24 | 12/0/0/12 |
| 15 | SE1 | 3 | 5 | 50 | 90 | 0.43 | no (ends) | 9 | 3/3/0/3 |
| 16 | SE1 | 3 | 5 | 50 | 90 | 0.85 | no (ends) | 5 | 2/1/0/2 |
| 17 | SE1 | 1 | 5 | 50 | 150 | 0.67 | no (ends) | 13 | 0/0/0/13 |
| 18 | SE1 | 1 | 4 | 50 | 120 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 19 | SE1 | 1 | 4 | 50 | 220 | 1.94 | no (ends) | 2 | 0/0/0/2 |
| 20 | SE1 | 1 | 4 | 50 | 240 | 0.77 | no (ends) | 4 | 4/0/0/0 |
| 21 | SE1 | 1 | 4 | 50 | 100 | 0.40 | no (ends) | 5 | 0/5/0/0 |
| 22 | SE1 | 1 | 4 | 50 | 100 | 0.32 | no (ends) | 3 | 0/3/0/0 |
| 23 | SE1 | 1 | 4 | 50 | 128 | 0.15 | no (ends) | 2 | 0/2/0/0 |
| 24 | SE2 | 4 | 4 | 50 | 144 | 0.65 | no (ends) | 11 | 5/6/0/0 |
| 25 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 26 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 27 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 28 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 29 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 30 | SE1 | 1 | 4 | 50 | 240 | 1.02 | no (ends) | 1 | 1/0/0/0 |
| 31 | SE1 | 1 | 4 | 50 | 240 | 0.27 | no (ends) | 2 | 0/2/0/0 |
| 32 | SE1 | 1 | 4 | 50 | 240 | 0.37 | no (ends) | 4 | 0/4/0/0 |
| 33 | SE1 | 1 | 5 | 50 | 240 | 1.66 | no (ends) | 1 | 0/1/0/0 |
| 34 | SE1 | 1 | 4 | 50 | 180 | 0.10 | no (ends) | 2 | 0/2/0/0 |
| 35 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 0/0/0/3 |
| 36 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 0/0/0/3 |
| 37 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 8 | 0/0/0/8 |
| 38 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 4 | 0/0/0/4 |
| 39 | SE1 | 1 | 4 | 50 | 120 | 1.16 | no (ends) | 10 | 0/0/0/10 |
| 40 | SE1 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/0/0/2 |
| 41 | SE1 | 2 | 4 | 50 | 120 | 0.34 | no (ends) | 10 | 5/0/0/5 |
| 42 | SE1 | 2 | 4 | 50 | 150 | 0.17 | no (ends) | 7 | 0/4/0/3 |
| 43 | SE1 | 1 | 4 | 50 | 170 | 0.74 | no (ends) | 1 | 1/0/0/0 |
| 44 | SE2 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 6 | 3/0/0/3 |
| 45 | SE1 | 1 | 4 | 50 | 110 | 0.77 | no (ends) | 7 | 0/7/0/0 |
| 46 | SE1 | 1 | 4 | 50 | 110 | 0.85 | no (ends) | 8 | 0/8/0/0 |
| 47 | SE1 | 1 | 4 | 50 | 220 | 0.43 | no (ends) | 2 | 0/0/0/2 |
| 48 | SE1 | 1 | 4 | 50 | 220 | 0.37 | no (ends) | 4 | 4/0/0/0 |
| 49 | SE1 | 2 | 4 | 50 | 150 | 6.45 | 1.61 / 4.82 | 29 | 3/0/0/26 |
| 50 | SE1 | 3 | 4 | 50 | 150 | 2.43 | no (ends) | 5 | 1/4/0/0 |
| 51 | SE2 | 1 | 4 | 50 | 150 | 0.47 | no (ends) | 2 | 0/0/0/2 |
| 52 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 3/0/0/3 |
| 53 | SE2 | 1 | 4 | 50 | 150 | 4.04 | 0.00 / 4.02 | 2 | 2/0/0/0 |
| 54 | SE1 | 1 | 4 | 50 | 180 | 0.52 | no (ends) | 3 | 0/3/0/0 |
| 55 | SE1 | 2 | 5 | 50 | 150 | 0.72 | no (ends) | 12 | 6/6/0/0 |
| 56 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 57 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 58 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 59 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 60 | SE2 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 4 | 2/0/0/2 |
| 61 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 62 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 63 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 64 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 65 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 66 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 67 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 68 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 69 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 70 | SE2 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 71 | SE2 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 2 | 2/0/0/0 |
| 72 | SE1 | 2 | 5 | 50 | 128 | 0.62 | no (ends) | 7 | 3/4/0/0 |
| 73 | SE1 | 2 | 5 | 50 | 150 | 1.07 | no (ends) | 4 | 2/2/0/0 |
| 74 | SE2 | 1 | 4 | 50 | 240 | 0.27 | no (ends) | 6 | 6/0/0/0 |
| 75 | SE2 | 1 | 4 | 50 | 240 | 0.22 | no (ends) | 5 | 5/0/0/0 |
| 76 | SE2 | 1 | 4 | 50 | 240 | 0.22 | no (ends) | 9 | 9/0/0/0 |
| 77 | SE2 | 1 | 4 | 50 | 240 | 0.34 | no (ends) | 3 | 3/0/0/0 |
| 78 | SE2 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 3/0/0/0 |
| 79 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 5 | 0/5/0/0 |
| 80 | SE1 | 1 | 4 | 50 | 150 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 81 | SE3 | 1 | 2 | 50 | 220 | 0.99 | 0.28 / 0.69 | 3 | 3/0/0/0 |
| 82 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 83 | SE3 | 1 | 2 | 50 | 220 | 0.70 | 0.28 / 0.40 | 3 | 3/0/0/0 |
| 84 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 85 | SE3 | 1 | 2 | 50 | 220 | 0.99 | 0.28 / 0.69 | 3 | 3/0/0/0 |
| 86 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 87 | SE1 | 1 | 3 | 50 | 220 | 1.67 | no (ends) | 4 | 4/0/0/0 |
| 88 | SE1 | 1 | 3 | 50 | 220 | 1.39 | no (ends) | 1 | 1/0/0/0 |
| 89 | SE1 | 2 | 4 | 50 | 150 | 3.63 | no (ends) | 2 | 1/0/0/1 |
| 90 | SE3 | 1 | 3 | 50 | 150 | 2.43 | no (ends) | 8 | 0/8/0/0 |
| 91 | SE1 | 2 | 5 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 92 | SE2 | 1 | 2 | 50 | 150 | 8.05 | no (ends) | 1 | 1/0/0/0 |
| 93 | SE2 | 1 | 2 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 94 | SE1 | 2 | 5 | 50 | 220 | 0.57 | 0.00 / 0.55 | 6 | 3/0/0/3 |
| 95 | SE1 | 2 | 5 | 50 | 128 | 0.50 | no (ends) | 5 | 2/3/0/0 |
| 96 | SE1 | 1 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 97 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 98 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 99 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 2 | 2/0/0/0 |
| 100 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 2 | 2/0/0/0 |
| 101 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 6 | 6/0/0/0 |
| 102 | SE1 | 1 | 5 | 50 | 220 | 0.57 | no (ends) | 10 | 10/0/0/0 |
| 103 | SE1 | 1 | 5 | 50 | 110 | 3.03 | no (ends) | 2 | 0/0/0/2 |
| 104 | SE1 | 2 | 5 | 50 | 110 | 2.50 | no (ends) | 2 | 1/0/0/1 |
| 105 | SE1 | 1 | 5 | 50 | 150 | 4.84 | no (ends) | 1 | 1/0/0/0 |
| 106 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 107 | SE1 | 2 | 5 | 50 | 110 | 3.72 | no (ends) | 2 | 1/0/0/1 |
| 108 | SE1 | 1 | 5 | 50 | 100 | 0.10 | no (ends) | 2 | 0/2/0/0 |
| 109 | SE1 | 1 | 5 | 50 | 100 | 0.25 | no (ends) | 6 | 0/6/0/0 |
| 110 | SE1 | 2 | 5 | 50 | 144 | 0.34 | no (ends) | 16 | 8/8/0/0 |
| 111 | SE1 | 2 | 5 | 50 | 144 | 0.34 | no (ends) | 16 | 8/8/0/0 |
| 112 | SE1 | 2 | 5 | 50 | 144 | 1.27 | no (ends) | 78 | 39/39/0/0 |
| 113 | SE1 | 2 | 5 | 50 | 150 | 0.42 | no (ends) | 11 | 11/0/0/0 |
| 114 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 115 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 1 | 1/0/0/0 |
| 116 | SE2 | 1 | 5 | 50 | 150 | 0.07 | no (ends) | 1 | 0/0/0/1 |
| 117 | SE1 | 1 | 5 | 50 | 120 | 0.40 | no (ends) | 4 | 4/0/0/0 |
| 118 | SE2 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 8 | 3/0/0/5 |
| 119 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 12 | 6/0/0/6 |
| 120 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 2/0/0/2 |
| 121 | SE1 | 2 | 4 | 50 | 220 | 1.12 | no (ends) | 26 | 12/14/0/0 |
| 122 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 5 | 3/0/0/2 |
| 123 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 6 | 3/0/0/3 |
| 124 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 2/0/0/0 |
| 125 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 1/0/0/1 |
| 126 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 2/0/0/0 |
| 127 | SE1 | 1 | 4 | 50 | 220 | 1.94 | no (ends) | 1 | 1/0/0/0 |
| 128 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 6 | 3/0/0/3 |
| 129 | SE1 | 1 | 4 | 50 | 250 | 0.50 | no (ends) | 1 | 1/0/0/0 |
| 130 | SE1 | 2 | 4 | 50 | 250 | 0.99 | no (ends) | 16 | 8/0/0/8 |
| 131 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 5 | 5/0/0/0 |
| 132 | SE2 | 1 | 4 | 50 | 150 | 1.22 | 0.40 / 0.80 | 3 | 3/0/0/0 |
| 133 | SE2 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 1 | 1/0/0/0 |
| 134 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 4/0/0/0 |
| 135 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 136 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 4 | 2/0/0/2 |
| 137 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 7 | 4/0/0/3 |
| 138 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 10 | 5/0/0/5 |
| 139 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 2/0/0/2 |
| 140 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 141 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 8 | 4/0/0/4 |
| 142 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 143 | SE1 | 1 | 4 | 50 | 180 | 0.35 | no (ends) | 1 | 1/0/0/0 |
| 144 | SE1 | 2 | 4 | 50 | 150 | 0.57 | no (ends) | 2 | 1/0/0/1 |
| 145 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 2 | 1/0/0/1 |
| 146 | SE1 | 2 | 4 | 50 | 150 | 3.23 | no (ends) | 2 | 1/0/0/1 |
| 147 | SE1 | 2 | 4 | 50 | 220 | 0.85 | no (ends) | 7 | 4/0/0/3 |
| 148 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 10 | 10/0/0/0 |
| 149 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 5 | 2/0/0/3 |
| 150 | SE2 | 2 | 4 | 50 | 150 | 1.62 | no (ends) | 2 | 1/0/0/1 |
| 151 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 152 | SE2 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 3 | 3/0/0/0 |
| 153 | SE1 | 1 | 4 | 50 | 150 | 1.22 | 0.40 / 0.80 | 3 | 3/0/0/0 |
| 154 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 1 | 1/0/0/0 |
| 155 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 4/0/0/0 |
| 156 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 2/0/0/2 |
| 157 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 2/0/0/2 |
| 158 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 15 | 9/0/0/6 |
| 159 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 5 | 3/0/0/2 |
| 160 | SE1 | 1 | 4 | 50 | 250 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 161 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 15 | 13/0/0/2 |
| 162 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 163 | SE1 | 1 | 4 | 50 | 150 | 1.62 | no (ends) | 1 | 1/0/0/0 |
| 164 | SE1 | 2 | 4 | 50 | 150 | 2.03 | no (ends) | 2 | 1/0/0/0 (1 unsupported) |
| 165 | SE1 | 1 | 4 | 50 | 150 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 166 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 167 | SE2 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 168 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 169 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 4/0/0/0 |
| 170 | SE2 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 171 | SE1 | 1 | 4 | 50 | 150 | 1.62 | no (ends) | 6 | 6/0/0/0 |
| 172 | SE1 | 2 | 4 | 50 | 100 | 4.39 | no (ends) | 8 | 8/0/0/0 |
| 173 | SE1 | 2 | 4 | 50 | 100 | 3.18 | no (ends) | 4 | 4/0/0/0 |
| 174 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 6 | 6/0/0/0 |
| 175 | SE1 | 1 | 4 | 50 | 150 | 0.27 | no (ends) | 5 | 5/0/0/0 |
| 176 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 177 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 3 | 3/0/0/0 |
| 178 | SE1 | 2 | 4 | 50 | 150 | 1.22 | no (ends) | 8 | 6/0/0/2 |
| 179 | SE1 | 2 | 4 | 50 | 150 | 0.87 | no (ends) | 40 | 20/20/0/0 |
| 180 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 181 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 1/1/0/0 |
| 182 | SE1 | 1 | 4 | 50 | 150 | 1.32 | no (ends) | 1 | 1/0/0/0 |
| 183 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 3 | 3/0/0/0 |
| 184 | SE1 | 1 | 4 | 50 | 150 | 0.72 | no (ends) | 2 | 2/0/0/0 |
| 185 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 186 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 187 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 6/0/0/0 |
| 188 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 1 | 1/0/0/0 |
| 189 | SE1 | 2 | 4 | 50 | 190 | 0.59 | no (ends) | 2 | 1/1/0/0 |
| 190 | SE1 | 1 | 4 | 50 | 150 | 0.52 | no (ends) | 5 | 5/0/0/0 |
| 191 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 10 | 8/0/0/2 |
| 192 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 15 | 12/0/0/3 |
| 193 | SE1 | 1 | 4 | 50 | 190 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 194 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 6/0/0/0 |
| 195 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 196 | SE1 | 1 | 4 | 50 | 220 | 0.57 | no (ends) | 6 | 6/0/0/0 |
| 197 | SE1 | 2 | 4 | 50 | 220 | 0.37 | no (ends) | 13 | 2/0/0/11 |
| 198 | SE1 | 2 | 4 | 50 | 150 | 0.62 | no (ends) | 16 | 8/0/0/8 |
| 199 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 7 | 7/0/0/0 |
| 200 | SE1 | 1 | 4 | 50 | 190 | 0.82 | no (ends) | 8 | 8/0/0/0 |
| 201 | SE2 | 1 | 4 | 50 | 150 | 3.23 | no (ends) | 1 | 1/0/0/0 |
| 202 | SE1 | 2 | 4 | 50 | 150 | 2.28 | no (ends) | 44 | 22/22/0/0 |
| 203 | SE1 | 1 | 4 | 50 | 150 | 0.92 | no (ends) | 9 | 9/0/0/0 |
| 204 | SE1 | 1 | 4 | 50 | 150 | 0.92 | no (ends) | 9 | 9/0/0/0 |
| 205 | SE1 | 1 | 4 | 50 | 180 | 0.18 | no (ends) | 3 | 3/0/0/0 |
| 206 | SE1 | 2 | 4 | 50 | 180 | 0.27 | no (ends) | 5 | 3/2/0/0 |
| 207 | SE1 | 2 | 4 | 50 | 150 | 0.92 | no (ends) | 16 | 8/8/0/0 |
| 208 | SE1 | 2 | 4 | 50 | 150 | 0.92 | no (ends) | 16 | 8/8/0/0 |
| 209 | SE2 | 1 | 4 | 50 | 220 | 0.50 | no (ends) | 8 | 8/0/0/0 |
| 210 | SE1 | 1 | 4 | 50 | 150 | 0.32 | no (ends) | 8 | 8/0/0/0 |
| 211 | SE1 | 2 | 4 | 50 | 150 | 4.84 | no (ends) | 84 | 48/36/0/0 |
| 212 | SE1 | 1 | 4 | 50 | 150 | 0.32 | no (ends) | 2 | 2/0/0/0 |
| 213 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 214 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 14 | 6/0/0/8 |
| 215 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 16 | 8/0/0/8 |
| 216 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 11 | 1/0/0/10 |
| 217 | SE1 | 2 | 4 | 50 | 150 | 1.12 | no (ends) | 37 | 24/13/0/0 |
| 218 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 26 | 26/0/0/0 |
| 219 | SE1 | 2 | 4 | 50 | 200 | 2.43 | no (ends) | 54 | 1/0/0/53 |
| 220 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 8 | 1/0/0/7 |
| 221 | SE1 | 2 | 4 | 50 | 220 | 1.12 | no (ends) | 6 | 4/0/0/2 |
| 222 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 223 | SE2 | 1 | 4 | 50 | 150 | 2.43 | no (ends) | 1 | 1/0/0/0 |
| 224 | SE1 | 2 | 4 | 50 | 150 | 0.77 | no (ends) | 9 | 7/0/0/2 |
| 225 | SE1 | 2 | 4 | 50 | 180 | 0.43 | no (ends) | 8 | 5/3/0/0 |
| 226 | SE1 | 2 | 4 | 50 | 210 | 0.85 | no (ends) | 19 | 9/10/0/0 |
| 227 | SE1 | 2 | 4 | 50 | 150 | 3.63 | no (ends) | 12 | 4/8/0/0 |
| 228 | SE1 | 2 | 5 | 50 | 150 | 1.27 | no (ends) | 24 | 12/12/0/0 |
| 229 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 230 | SE1 | 2 | 4 | 50 | 150 | 1.62 | no (ends) | 28 | 1/0/0/27 |
| 231 | SE1 | 2 | 4 | 50 | 100 | 3.33 | no (ends) | 8 | 8/0/0/0 |
| 232 | SE1 | 2 | 4 | 50 | 150 | 0.27 | no (ends) | 6 | 3/0/0/3 |
| 233 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 10 | 3/0/0/7 |
| 234 | SE2 | 2 | 4 | 50 | 150 | 3.43 | no (ends) | 92 | 56/0/0/36 |
| 235 | SE2 | 2 | 4 | 50 | 150 | 2.83 | no (ends) | 2 | 1/0/0/1 |
| 236 | SE1 | 2 | 4 | 50 | 150 | 2.83 | no (ends) | 5 | 5/0/0/0 |
| 237 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 2 | 1/0/0/1 |
| 238 | SE2 | 2 | 4 | 50 | 220 | 0.43 | no (ends) | 7 | 3/0/0/4 |
| 239 | SE1 | 2 | 4 | 50 | 170 | 1.17 | no (ends) | 48 | 26/22/0/0 |
| 240 | SE1 | 2 | 4 | 50 | 150 | 2.23 | no (ends) | 2 | 1/0/0/1 |
| 241 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 242 | SE1 | 2 | 4 | 50 | 150 | 0.52 | no (ends) | 17 | 10/0/0/7 |
| 243 | SE2 | 2 | 4 | 50 | 150 | 3.33 | no (ends) | 40 | 20/20/0/0 |
| 244 | SE1 | 2 | 4 | 50 | 170 | 0.90 | no (ends) | 24 | 12/12/0/0 |
| 245 | SE1 | 2 | 4 | 50 | 170 | 1.17 | no (ends) | 48 | 26/22/0/0 |
| 246 | SE1 | 2 | 4 | 50 | 190 | 2.80 | no (ends) | 10 | 1/0/0/9 |
| 247 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 16 | 8/0/0/8 |
| 248 | SE1 | 2 | 5 | 50 | 110 | 0.57 | no (ends) | 4 | 0/1/0/3 |
| 249 | SE1 | 1 | 5 | 50 | 182 | 0.69 | no (ends) | 2 | 0/0/0/2 |
| 250 | SE1 | 1 | 5 | 50 | 182 | 1.67 | no (ends) | 1 | 0/0/0/1 |
| 251 | SE1 | 2 | 5 | 50 | 174 | 1.76 | no (ends) | 11 | 9/0/0/2 |
| 252 | SE1 | 2 | 5 | 50 | 310 | 0.10 | no (ends) | 3 | 1/0/0/2 |
| 253 | SE1 | 2 | 5 | 50 | 422 | 0.07 | no (ends) | 4 | 2/2/0/0 |
| 254 | SE1 | 2 | 5 | 50 | 310 | 0.20 | no (ends) | 3 | 2/0/0/1 |
| 255 | SE1 | 1 | 5 | 50 | 124 | 0.64 | no (ends) | 1 | 1/0/0/0 |
| 256 | SE1 | 2 | 5 | 50 | 164 | 3.70 | no (ends) | 6 | 3/3/0/0 |
| 257 | SE1 | 1 | 5 | 50 | 420 | 0.60 | no (ends) | 14 | 14/0/0/0 |
| 258 | SE1 | 1 | 5 | 50 | 420 | 0.60 | no (ends) | 14 | 14/0/0/0 |
| 259 | SE1 | 1 | 5 | 50 | 420 | 0.32 | no (ends) | 7 | 4/3/0/0 |
| 260 | SE1 | 3 | 5 | 50 | 262 | 1.86 | no (ends) | 26 | 1/23/0/2 |
| 261 | SE1 | 2 | 5 | 50 | 150 | 0.87 | no (ends) | 40 | 20/20/0/0 |
| 262 | SE1 | 1 | 5 | 50 | 240 | 0.37 | no (ends) | 4 | 0/4/0/0 |
| 263 | SE1 | 2 | 5 | 50 | 136 | 0.47 | no (ends) | 40 | 20/20/0/0 |
| 264 | SE1 | 2 | 5 | 50 | 120 | 0.65 | no (ends) | 10 | 4/6/0/0 |
| 265 | SE1 | 2 | 5 | 50 | 92 | 1.00 | no (ends) | 2 | 2/0/0/0 |
| 266 | SE1 | 2 | 5 | 50 | 92 | 1.34 | no (ends) | 6 | 6/0/0/0 |
| 267 | SE1 | 3 | 5 | 50 | 98* | 1.86 | no (ends) | 19 | 12/5/0/2 |
| 268 | SE1 | 3 | 5 | 50 | 112* | 1.67 | no (ends) | 19 | 12/5/0/2 |
| 269 | SE1 | 1 | 5 | 50 | 100 | 1.22 | no (ends) | 8 | 0/0/0/8 |
| 350 | BGM | 9 | 0 | 50 | 108 | 36.85 | 0.00 / 36.83 | 838 | 506/332/0/0 |
| 351 | BGM | 4 | 0 | 50 | 130 | 37.12 | 3.72 / 33.38 | 629 | 629/0/0/0 |
| 352 | BGM | 7 | 0 | 50 | 140 | 14.01 | 0.22 / 13.78 | 306 | 217/69/20/0 |
| 353 | BGM | 7 | 0 | 50 | 140 | 15.69 | 1.89 / 13.78 | 347 | 242/79/26/0 |
| 354 | BGM | 8 | 0 | 50 | 150* | 48.22 | 6.28 / 41.92 | 918 | 496/280/141/0 (1 unsupported) |
| 355 | BGM | 8 | 0 | 50 | 140 | 35.11 | 7.53 / 27.56 | 979 | 473/385/121/0 |
| 356 | BGM | 3 | 0 | 50 | 120 | 34.17 | 2.01 / 32.15 | 340 | 340/0/0/0 |
| 357 | BGM | 4 | 0 | 50 | 128 | 67.83 | 7.53 / 60.27 | 711 | 711/0/0/0 |
| 358 | BGM | 3 | 0 | 50 | 186 | 106.97 | 12.98 / 93.98 | 1263 | 1263/0/0/0 |
| 359 | BGM | 8 | 0 | 50 | 114 | 34.12 | 0.27 / 33.84 | 768 | 392/232/36/108 |
| 360 | BGM | 9 | 0 | 50 | 132 | 36.78 | 0.23 / 36.53 | 884 | 473/281/130/0 |
| 361 | BGM | 8 | 0 | 50 | 134 | 57.59 | 0.00 / 57.58 | 1530 | 928/478/124/0 |
| 362 | BGM | 8 | 0 | 50 | 126 | 32.55 | 1.93 / 30.61 | 877 | 408/241/43/185 |
| 363 | BGM | 7 | 0 | 50 | 100 | 38.59 | 0.00 / 38.58 | 486 | 276/192/18/0 |
| 364 | BGM | 7 | 0 | 50 | 128 | 33.92 | 0.00 / 33.90 | 809 | 451/237/121/0 |
| 365 | BGM | 6 | 0 | 50 | 82 | 71.69 | 1.10 / 70.57 | 989 | 655/334/0/0 |
| 366 | BGM | 9 | 0 | 50 | 130 | 42.44 | 3.48 / 38.94 | 635 | 422/98/60/46 (9 unsupported) |
| 367 | SE2 | 5 | 5 | 50 | 174 | 1.41 | no (ends) | 26 | 12/14/0/0 |
| 368 | SE2 | 4 | 5 | 50 | 132 | 2.31 | no (ends) | 33 | 23/10/0/0 |
| 369 | SE2 | 7 | 5 | 50 | 150* | 5.24 | no (ends) | 143 | 80/46/17/0 |
| 370 | SE2 | 6 | 5 | 50 | 150* | 2.76 | no (ends) | 48 | 32/16/0/0 |
| 371 | SE2 | 7 | 5 | 50 | 150 | 5.04 | no (ends) | 96 | 49/38/9/0 |
| 372 | SE2 | 7 | 5 | 50 | 150* | 3.23 | no (ends) | 83 | 49/28/6/0 |
| 373 | BGM | 6 | 0 | 50 | 68 | 89.56 | 0.89 / 88.65 | 673 | 529/144/0/0 |
| 374 | BGM | 8 | 0 | 50 | 124 | 50.58 | 3.90 / 46.66 | 1058 | 551/379/128/0 |
| 375 | BGM | 7 | 0 | 50 | 120* | 80.52 | 16.21 / 64.29 | 972 | 731/237/4/0 |
| 376 | SE2 | 4 | 0 | 50 | 120 | 1.02 | no (ends) | 10 | 2/8/0/0 |
| 377 | BGM | 7 | 0 | 50 | 120 | 32.16 | 16.07 / 16.07 | 772 | 481/130/161/0 |
| 378 | SE2 | 6 | 5 | 50 | 150 | 2.63 | no (ends) | 42 | 36/6/0/0 |
| 379 | BGM | 8 | 0 | 50 | 144 | 15.50 | 2.09 / 13.39 | 483 | 287/120/29/47 |
| 380 | BGM | 7 | 0 | 50 | 138 | 15.76 | 1.76 / 13.98 | 518 | 294/156/68/0 |
| 381 | BGM | 8 | 0 | 50 | 100 | 39.50 | 0.90 / 38.58 | 650 | 420/187/43/0 |
| 382 | BGM | 8 | 0 | 50 | 128 | 33.92 | 3.77 / 30.14 | 891 | 455/221/47/168 |
| 383 | BGM | 7 | 0 | 50 | 100 | 28.95 | 0.00 / 28.93 | 494 | 352/142/0/0 |
| 384 | BGM | 9 | 0 | 50 | 128 | 40.05 | 0.49 / 39.55 | 909 | 446/330/133/0 |
| 385 | BGM | 8 | 0 | 50 | 142 | 12.76 | 2.56 / 10.18 | 309 | 152/84/15/52 (6 unsupported) |
| 386 | BGM | 9 | 0 | 50 | 100 | 44.02 | 0.60 / 43.40 | 739 | 408/264/67/0 |
| 387 | SE2 | 5 | 5 | 50 | 150* | 1.94 | no (ends) | 36 | 27/9/0/0 |
| 388 | SE2 | 7 | 5 | 50 | 150* | 11.42 | no (ends) | 223 | 130/81/12/0 |
| 389 | SE2 | 7 | 5 | 50 | 150* | 4.39 | no (ends) | 118 | 88/18/12/0 |
| 390 | SE2 | 7 | 5 | 50 | 144 | 2.53 | no (ends) | 68 | 42/20/6/0 |
| 391 | SE2 | 5 | 5 | 50 | 180 | 2.36 | no (ends) | 38 | 34/4/0/0 |
| 392 | BGM | 7 | 0 | 50 | 180* | 19.96 | 15.55 / 4.39 | 804 | 323/320/161/0 |
| 393 | BGM | 7 | 0 | 50 | 128 | 41.45 | 0.00 / 41.44 | 860 | 622/144/94/0 |
| 394 | BGM | 7 | 0 | 50 | 128 | 41.45 | 0.00 / 41.44 | 944 | 566/184/194/0 |
| 395 | BGM | 7 | 0 | 50 | 128 | 41.45 | 0.00 / 41.44 | 948 | 638/136/174/0 |
| 396 | BGM | 5 | 0 | 50 | 128 | 41.45 | 0.00 / 41.44 | 904 | 398/332/174/0 |
| 397 | BGM | 5 | 0 | 50 | 128 | 18.38 | 1.42 / 16.94 | 409 | 335/74/0/0 |
| 398 | BGM | 10 | 0 | 50 | 84 | 46.48 | 0.55 / 45.91 | 614 | 406/159/49/0 |
| 399 | BGM | 8 | 0 | 50 | 128 | 61.95 | 1.66 / 60.27 | 1642 | 814/461/113/254 |
| 400 | BGM | 9 | 0 | 50 | 104 | 39.43 | 2.33 / 37.09 | 967 | 551/120/79/217 |
| 401 | BGM | 10 | 0 | 50 | 128* | 41.64 | 3.77 / 37.85 | 1542 | 726/319/228/269 |
| 402 | BGM | 9 | 0 | 50 | 136 | 73.60 | 16.84 / 56.74 | 2088 | 1242/637/209/0 |
| 403 | BGM | 9 | 0 | 50 | 138 | 50.70 | 1.76 / 48.92 | 1383 | 961/293/129/0 |
| 404 | BGM | 8 | 0 | 50 | 172 | 44.89 | 5.61 / 39.26 | 1613 | 1063/477/73/0 |
| 405 | BGM | 9 | 0 | 50 | 108 | 54.43 | 0.84 / 53.58 | 1170 | 788/382/0/0 |
| 406 | BGM | 9 | 0 | 50 | 124 | 94.33 | 3.90 / 90.41 | 3238 | 1820/825/192/401 |
| 407 | BGM | 9 | 0 | 50 | 90 | 13.41 | 2.68 / 10.71 | 439 | 237/59/50/93 |
| 408 | BGM | 6 | 0 | 50 | 80* | 56.19 | 0.00 / 56.17 | 1332 | 1052/204/76/0 |
| 409 | BGM | 8 | 0 | 50 | 120 | 42.21 | 2.01 / 40.18 | 1534 | 837/342/128/227 |
| 410 | BGM | 7 | 0 | 50 | 136* | 8.12 | 1.93 / 6.18 | 316 | 185/88/43/0 |
| 411 | BGM | 10 | 0 | 50 | 86 | 86.93 | 25.23 / 61.68 | 2916 | 1823/576/154/363 |
| 412 | BGM | 9 | 0 | 50 | 136 | 16.27 | 2.08 / 14.18 | 1162 | 555/408/83/116 |
| 413 | BGM | 10 | 0 | 50 | 144* | 100.36 | no (ends) | 3959 | 2451/1141/367/0 |
| 414 | BGM | 10 | 0 | 50 | 118* | 35.80 | no (ends) | 988 | 743/245/0/0 |
| 415 | BGM | 10 | 0 | 50 | 128 | 33.92 | 3.77 / 30.14 | 1374 | 613/372/152/237 |
| 416 | BGM | 8 | 0 | 50 | 140 | 14.23 | 0.43 / 13.78 | 676 | 364/176/81/55 |
| 417 | BGM | 9 | 0 | 50 | 140 | 31.24 | 3.67 / 27.56 | 1490 | 878/371/0/241 |
| 418 | BGM | 9 | 0 | 50 | 128 | 68.08 | 0.25 / 67.81 | 2814 | 1243/818/176/577 |
| 419 | BGM | 10 | 0 | 50 | 140 | 31.24 | 3.67 / 27.56 | 1619 | 773/466/163/217 |
| 420 | BGM | 8 | 0 | 50 | 128 | 26.39 | 3.77 / 22.60 | 765 | 377/158/72/158 |
| 421 | BGM | 10 | 0 | 50 | 128 | 33.92 | 3.77 / 30.14 | 1374 | 613/372/152/237 |
| 422 | BGM | 8 | 0 | 50 | 128 | 68.31 | 8.02 / 60.27 | 1641 | 790/253/146/452 |
| 423 | BGM | 9 | 0 | 50 | 122 | 21.26 | 3.47 / 17.78 | 603 | 261/128/42/172 |
| 424 | BGM | 9 | 0 | 50 | 142 | 10.50 | 3.68 / 6.80 | 358 | 207/73/25/53 |
| 425 | BGM | 9 | 0 | 50 | 120 | 66.32 | no (ends) | 290 | 147/78/19/46 |
| 426 | BGM | 10 | 0 | 50 | 182 | 70.32 | 0.08 / 70.22 | 2306 | 1181/507/281/337 |
| 427 | BGM | 10 | 0 | 50 | 94 | 66.70 | 0.00 / 66.69 | 1414 | 640/346/155/273 |
| 428 | BGM | 9 | 0 | 50 | 142 | 20.61 | 0.22 / 20.38 | 974 | 516/144/169/145 |
| 429 | BGM | 10 | 0 | 50 | 134 | 53.99 | 9.01 / 44.97 | 1791 | 692/501/272/326 |
| 430 | BGM | 9 | 0 | 50 | 118 | 40.89 | 0.00 / 40.87 | 974 | 533/154/126/161 |
| 431 | BGM | 9 | 0 | 50 | 156 | 31.13 | 6.38 / 24.73 | 1240 | 780/175/104/181 |
| 432 | BGM | 10 | 0 | 50 | 90 | 53.59 | 0.00 / 53.58 | 910 | 550/74/98/188 |
| 433 | BGM | 10 | 0 | 50 | 124 | 82.66 | 0.99 / 81.65 | 2394 | 1105/501/417/371 |
| 434 | BGM | 10 | 0 | 50 | 102 | 82.76 | 21.28 / 61.46 | 3125 | 1862/615/110/538 |
| 435 | BGM | 4 | 0 | 50 | 116 | 37.44 | 0.00 / 37.42 | 370 | 370/0/0/0 |
| 436 | BGM | 10 | 0 | 50 | 122 | 35.85 | 0.25 / 35.58 | 1192 | 470/382/164/176 |
| 437 | BGM | 9 | 0 | 50 | 148 | 53.78 | 0.00 / 53.76 | 1041 | 592/333/116/0 |
| 438 | BGM | 8 | 0 | 50 | 140 | 36.18 | 0.00 / 36.16 | 770 | 556/108/106/0 |
| 439 | BGM | 8 | 0 | 50 | 148 | 13.26 | 6.73 / 6.51 | 512 | 233/157/73/49 |
| 440 | BGM | 8 | 0 | 50 | 128 | 41.45 | 0.00 / 41.44 | 1518 | 716/628/174/0 |
| 441 | BGM | 10 | 0 | 50 | 148 | 21.41 | 0.22 / 21.18 | 852 | 386/214/86/166 |
| 442 | BGM | 9 | 0 | 50 | 184* | 14.90 | no (ends) | 762 | 512/154/72/24 |
| 443 | BGM | 6 | 0 | 50 | 108 | 36.30 | 0.57 / 35.71 | 637 | 102/192/150/193 |
| 444 | BGM | 3 | 0 | 50 | 78 | 49.48 | 0.00 / 49.46 | 434 | 0/385/49/0 |
| 445 | BGM | 8 | 0 | 50 | 136 | 54.77 | 0.23 / 54.51 | 1597 | 615/486/222/274 |
| 446 | BGM | 8 | 0 | 50 | 128 | 15.57 | 0.49 / 15.07 | 418 | 210/75/32/101 |
| 447 | BGM | 7 | 0 | 50 | 114 | 34.39 | 0.54 / 33.84 | 827 | 580/118/129/0 |
| 448 | BGM | 8 | 0 | 50 | 136 | 44.35 | 1.77 / 42.56 | 2251 | 1102/521/243/385 |
| 449 | BGM | 10 | 0 | 50 | 134 | 10.82 | 3.60 / 7.20 | 396 | 179/100/56/61 |
| 450 | BGM | 9 | 0 | 50 | 134 | 22.07 | 0.45 / 21.60 | 1095 | 537/311/150/97 |
| 451 | BGM | 8 | 0 | 50 | 128 | 16.98 | 1.89 / 15.07 | 492 | 262/184/46/0 |
| 452 | BGM | 8 | 0 | 50 | 128 | 33.92 | 3.77 / 30.14 | 982 | 588/324/70/0 |
| 453 | BGM | 9 | 0 | 50 | 142 | 10.31 | 3.52 / 6.78 | 418 | 199/86/50/83 |
| 454 | BGM | 10 | 0 | 50 | 142 | 30.59 | 3.40 / 27.17 | 1301 | 612/272/157/260 |
| 455 | BGM | 10 | 0 | 50 | 94* | 172.97 | no (ends) | 2700 | 1860/690/150/0 |
| 456 | BGM | 2 | 0 | 50 | 138* | 102.55 | 0.89 / 101.64 | 403 | 403/0/0/0 |
| 457 | BGM | 9 | 0 | 50 | 122 | 43.75 | 4.20 / 39.53 | 1116 | 789/236/91/0 |
| 458 | BGM | 9 | 0 | 50 | 128 | 51.00 | 20.84 / 30.14 | 665 | 444/137/84/0 |
| 459 | SE2 | 9 | 5 | 50 | 122* | 4.13 | no (ends) | 154 | 72/28/14/40 |
| 460 | SE2 | 5 | 5 | 50 | 96 | 1.91 | no (ends) | 50 | 18/22/10/0 |
| 461 | BGM | 10 | 0 | 50 | 106 | 77.92 | 11.95 / 65.95 | 2655 | 1500/432/290/433 |
| 462 | BGM | 7 | 0 | 50 | 90 | 10.73 | 0.00 / 10.71 | 245 | 86/159/0/0 |
| 463 | BGM | 9 | 0 | 50 | 96 | 89.34 | 44.12 / 45.20 | 1683 | 1002/468/0/213 |
| 464 | BGM | 7 | 0 | 50 | 120 | 26.14 | no (ends) | 225 | 62/124/39/0 |
| 465 | BGM | 7 | 0 | 50 | 122* | 51.47 | 3.97 / 47.48 | 1077 | 763/314/0/0 |
| 466 | SE2 | 9 | 5 | 50 | 122* | 5.22 | no (ends) | 190 | 85/30/15/60 |
| 467 | BGM | 10 | 0 | 50 | 144 | 46.90 | 6.70 / 40.18 | 1487 | 685/407/178/217 |
| 468 | BGM | 10 | 0 | 50 | 120 | 54.26 | 1.51 / 52.74 | 1029 | 623/232/0/174 |
| 469 | BGM | 9 | 0 | 50 | 144 | 64.89 | 2.93 / 61.95 | 3307 | 1563/798/497/449 |
| 470 | BGM | 6 | 1 | 50 | 196 | 49.22 | 9.85 / 39.36 | 649 | 551/98/0/0 |
| 471 | BGM | 10 | 1 | 50 | 190 | 94.08 | 3.97 / 90.09 | 3618 | 1870/541/622/585 |
| 472 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1891 | 720/560/267/344 |
| 473 | BGM | 3 | 0 | 50 | 144 | 20.11 | 6.70 / 13.39 | 256 | 159/0/0/97 |
| 474 | BGM | 8 | 1 | 50 | 196 | 52.92 | 13.54 / 39.36 | 1063 | 840/154/69/0 |
| 475 | BGM | 8 | 1 | 50 | 200 | 101.28 | 12.05 / 89.20 | 2341 | 1666/354/321/0 |
| 476 | BGM | 8 | 1 | 50 | 198 | 90.13 | 12.19 / 77.92 | 1860 | 1391/441/28/0 |
| 477 | BGM | 8 | 1 | 50 | 196 | 76.30 | 12.31 / 63.97 | 1571 | 1083/415/73/0 |
| 478 | BGM | 8 | 1 | 50 | 212 | 65.98 | 11.38 / 54.58 | 1484 | 1184/275/24/0 (1 unsupported) |
| 479 | BGM | 8 | 1 | 50 | 160 | 60.29 | 30.14 / 30.14 | 1422 | 736/656/30/0 |
| 480 | BGM | 6 | 1 | 50 | 196 | 49.22 | 9.85 / 39.36 | 649 | 551/98/0/0 |
| 481 | BGM | 8 | 1 | 50 | 196 | 65.21 | 12.31 / 52.89 | 1241 | 987/189/65/0 |
| 482 | BGM | 8 | 1 | 50 | 214 | 61.98 | 11.27 / 50.70 | 1343 | 886/284/173/0 |
| 483 | BGM | 8 | 1 | 50 | 202 | 79.39 | 23.29 / 56.09 | 1571 | 1179/277/114/0 (1 unsupported) |
| 484 | BGM | 8 | 0 | 50 | 146 | 16.54 | 9.91 / 6.61 | 472 | 229/135/45/63 |
| 485 | BGM | 8 | 0 | 50 | 146 | 43.38 | 0.42 / 42.95 | 1344 | 459/502/0/383 |
| 486 | BGM | 10 | 0 | 50 | 130 | 74.20 | 1.86 / 72.33 | 1942 | 1009/632/147/154 |
| 487 | BGM | 7 | 0 | 50 | 128 | 33.92 | 0.00 / 33.90 | 809 | 451/237/121/0 |
| 488 | SE2 | 4 | 5 | 50 | 146 | 6.63 | no (ends) | 40 | 20/20/0/0 |
| 489 | BGM | 8 | 0 | 50 | 188 | 12.21 | no (ends) | 536 | 278/116/51/91 |
| 490 | BGM | 10 | 0 | 50 | 140 | 45.22 | 3.88 / 41.32 | 1256 | 831/346/77/2 |
| 491 | BGM | 9 | 0 | 50 | 120 | 36.18 | 2.01 / 34.16 | 1178 | 616/290/108/164 |
| 492 | BGM | 8 | 0 | 50 | 128 | 82.89 | 7.53 / 75.34 | 913 | 523/390/0/0 |
| 493 | BGM | 2 | 0 | 50 | 146 | 2.09 | no (ends) | 10 | 0/5/5/0 |
| 494 | BGM | 8 | 0 | 50 | 134 | 34.44 | 0.23 / 34.19 | 865 | 428/336/101/0 |
| 495 | BGM | 7 | 0 | 50 | 146 | 8.69 | 2.08 / 6.60 | 188 | 114/46/28/0 |
| 496 | BGM | 9 | 0 | 50 | 174 | 6.78 | 1.22 / 5.54 | 171 | 95/44/0/32 |
| 497 | BGM | 8 | 0 | 50 | 154 | 9.43 | 3.15 / 6.26 | 289 | 173/71/0/45 |
| 498 | BGM | 9 | 0 | 50 | 152 | 28.58 | 1.59 / 26.97 | 1028 | 484/284/109/151 |
| 499 | BGM | 10 | 0 | 50 | 128 | 105.75 | 0.25 / 105.48 | 1456 | 794/338/98/226 |
| 500 | BGM | 7 | 0 | 50 | 110* | 92.54 | 0.00 / 92.52 | 1117 | 1005/112/0/0 |
| 501 | BGM | 10 | 0 | 50 | 132 | 65.78 | 14.62 / 51.15 | 1728 | 737/495/254/242 |
| 502 | BGM | 9 | 0 | 50 | 94* | 250.64 | no (ends) | 4741 | 3650/933/158/0 |
| 503 | BGM | 8 | 0 | 50 | 116 | 25.23 | 0.27 / 24.95 | 548 | 351/85/104/8 |
| 504 | BGM | 6 | 0 | 50 | 118 | 20.96 | 0.52 / 20.43 | 467 | 328/139/0/0 |
| 505 | BGM | 9 | 0 | 50 | 124 | 36.23 | 5.11 / 31.11 | 1270 | 474/437/112/247 |
| 506 | BGM | 10 | 0 | 50 | 124 | 35.03 | 3.90 / 31.11 | 951 | 327/376/81/167 |
| 507 | BGM | 8 | 0 | 50 | 136 | 32.38 | 4.00 / 28.36 | 827 | 496/240/91/0 |
| 508 | BGM | 10 | 0 | 50 | 186 | 57.06 | 2.60 / 54.45 | 2131 | 1090/570/158/313 |
| 509 | BGM | 10 | 0 | 50 | 172 | 102.35 | 19.64 / 82.69 | 3387 | 1452/1140/236/559 |
| 510 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1578 | 633/334/267/344 |
| 511 | BGM | 10 | 0 | 50 | 172 | 74.32 | 14.03 / 60.27 | 3259 | 1605/870/286/498 |
| 512 | BGM | 6 | 0 | 50 | 88 | 43.87 | 0.00 / 43.85 | 526 | 378/148/0/0 |
| 513 | BGM | 6 | 0 | 50 | 120 | 17.09 | 1.00 / 16.07 | 426 | 212/214/0/0 |
| 514 | BGM | 9 | 0 | 50 | 160 | 25.63 | 13.56 / 12.05 | 719 | 465/124/0/130 |
| 515 | BGM | 10 | 0 | 50 | 116 | 33.28 | 0.00 / 33.27 | 702 | 378/259/65/0 |
| 516 | BGM | 10 | 0 | 50 | 114 | 71.93 | 8.47 / 63.44 | 1414 | 861/264/66/223 |
| 517 | BGM | 7 | 0 | 50 | 100 | 32.56 | 3.62 / 28.93 | 575 | 329/190/56/0 |
| 518 | BGM | 6 | 0 | 50 | 134 | 59.40 | 1.81 / 57.58 | 405 | 327/74/0/0 (4 unsupported) |
| 519 | BGM | 9 | 0 | 50 | 114* | 59.40 | 3.72 / 55.67 | 1935 | 1031/465/126/313 |
| 520 | BGM | 9 | 0 | 50 | 120 | 34.17 | 2.01 / 32.15 | 804 | 396/207/68/133 |
| 521 | BGM | 7 | 0 | 50 | 110 | 39.48 | 2.19 / 37.27 | 906 | 641/265/0/0 |
| 522 | BGM | 9 | 0 | 50 | 136 | 16.27 | 2.08 / 14.18 | 1162 | 555/408/83/116 |
| 523 | BGM | 7 | 0 | 50 | 140 | 15.69 | 1.89 / 13.78 | 347 | 242/79/26/0 |
| 524 | BGM | 8 | 0 | 50 | 150* | 48.22 | 6.28 / 41.92 | 918 | 496/280/141/0 (1 unsupported) |
| 525 | BGM | 9 | 0 | 50 | 116 | 37.44 | 0.00 / 37.42 | 1031 | 528/329/60/114 |
| 526 | BGM | 9 | 0 | 50 | 126 | 61.73 | 0.49 / 61.23 | 1363 | 787/254/61/261 |
| 527 | BGM | 9 | 0 | 50 | 168 | 20.11 | 2.88 / 17.21 | 604 | 291/137/52/124 |
| 528 | BGM | 9 | 0 | 50 | 168 | 18.68 | 1.44 / 17.23 | 565 | 267/127/52/119 |
| 529 | SE2 | 7 | 5 | 50 | 64* | 3.35 | no (ends) | 96 | 51/35/10/0 |
| 530 | SE2 | 6 | 5 | 50 | 44* | 2.68 | no (ends) | 58 | 38/20/0/0 |
| 531 | SE2 | 8 | 5 | 50 | 64* | 3.60 | no (ends) | 152 | 108/37/7/0 |
| 532 | SE2 | 5 | 5 | 50 | 192 | 1.27 | no (ends) | 78 | 75/0/0/3 |
| 533 | BGM | 5 | 0 | 50 | 150 | 8.76 | no (ends) | 364 | 363/1/0/0 |
| 534 | BGM | 7 | 0 | 50 | 140 | 14.01 | 0.22 / 13.78 | 306 | 217/69/20/0 |
| 535 | BGM | 1 | 0 | 50 | 120 | 8.30 | 0.25 / 8.04 | 63 | 63/0/0/0 |
| 536 | BGM | 6 | 0 | 50 | 120 | 12.07 | 0.00 / 12.05 | 158 | 127/31/0/0 |
| 537 | BGM | 7 | 0 | 50 | 120 | 2.03 | no (ends) | 17 | 15/2/0/0 |
| 538 | BGM | 8 | 0 | 50 | 138 | 45.89 | 0.45 / 45.42 | 1345 | 460/502/0/383 |
| 539 | BGM | 8 | 0 | 50 | 134 | 47.25 | 0.45 / 46.78 | 1345 | 460/502/0/383 |
| 540 | BGM | 10 | 0 | 50 | 114 | 33.87 | 0.00 / 33.85 | 702 | 378/259/65/0 |
| 541 | BGM | 7 | 0 | 50 | 124 | 17.53 | 1.96 / 15.55 | 303 | 229/0/0/74 |
| 542 | BGM | 8 | 0 | 50 | 148 | 42.79 | 0.42 / 42.36 | 1344 | 459/502/0/383 |
| 543 | BGM | 7 | 0 | 50 | 110* | 92.54 | 0.00 / 92.52 | 1065 | 1005/60/0/0 |
| 544 | BGM | 8 | 0 | 50 | 146 | 16.54 | 9.91 / 6.61 | 472 | 229/135/45/63 |
| 545 | BGM | 10 | 0 | 50 | 124 | 37.45 | 4.39 / 33.05 | 1358 | 684/403/65/206 |
| 546 | BGM | 10 | 0 | 50 | 128 | 105.75 | 0.25 / 105.48 | 1456 | 794/338/98/226 |
| 547 | BGM | 9 | 0 | 50 | 126 | 61.73 | 0.49 / 61.23 | 1363 | 787/254/61/261 |
| 548 | BGM | 9 | 0 | 50 | 120 | 52.51 | 4.27 / 48.22 | 1237 | 592/318/125/202 |
| 549 | BGM | 9 | 0 | 50 | 116 | 43.66 | 10.40 / 33.25 | 1317 | 620/340/119/238 |
| 550 | SE2 | 2 | 5 | 50 | 80 | 51.25 | no (ends) | 24 | 24/0/0/0 |
| 551 | BGM | 10 | 0 | 50 | 128* | 81.84 | 16.34 / 65.48 | 3623 | 1116/1700/554/253 |
| 552 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1578 | 633/334/267/344 |
| 553 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1775 | 620/544/267/344 |
| 554 | BGM | 7 | 0 | 50 | 164 | 8.84 | 2.95 / 5.88 | 280 | 153/82/0/45 |
| 555 | BGM | 7 | 0 | 50 | 128 | 15.09 | 0.00 / 15.07 | 438 | 89/349/0/0 |
| 556 | BGM | 7 | 0 | 50 | 128 | 33.92 | 0.00 / 33.90 | 809 | 451/237/121/0 |
| 557 | BGM | 6 | 0 | 50 | 72 | 53.59 | 0.00 / 53.58 | 522 | 376/146/0/0 |
| 558 | BGM | 4 | 0 | 50 | 144 | 3.78 | 0.42 / 3.35 | 47 | 25/17/0/5 |
| 559 | SE2 | 1 | 4 | - | 120 | 1.00 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 560 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 561 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 562 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 563 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 564 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 565 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 566 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 567 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 568 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 569 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 570 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 571 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 572 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 573 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 574 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 575 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 576 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 577 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 578 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 579 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 580 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 581 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 582 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 583 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 584 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 585 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 586 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 587 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 588 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 589 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 590 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 591 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 592 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 593 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 594 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 595 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 596 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 597 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 598 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 599 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 600 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 601 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 602 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 603 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 604 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 605 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 606 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 607 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 608 | SE2 | 1 | 4 | - | 120 | 4.04 | 2.01 / 2.01 | 1 | 1/0/0/0 (1 unsupported) |
| 609 | SE2 | 1 | 4 | - | 120 | 1.16 | no (ends) | 1 | 1/0/0/0 (1 unsupported) |
| 612 | BGM | 9 | 0 | 50 | 50 | 72.34 | 3.62 / 68.71 | 723 | 723/0/0/0 |
| 614 | BGM | 9 | 0 | 50 | 140 | 75.79 | 0.00 / 75.78 | 3024 | 3024/0/0/0 |
| 621 | BGM | 9 | 0 | 50 | 118 | 90.43 | 12.78 / 77.64 | 2862 | 2862/0/0/0 |
| 622 | BGM | 9 | 0 | 50 | 134 | 86.61 | 11.03 / 75.56 | 3173 | 3173/0/0/0 |
| 630 | BGM | 9 | 0 | 50 | 86 | 75.71 | 2.81 / 72.88 | 1896 | 1896/0/0/0 |
| 631 | BGM | 9 | 0 | 50 | 122 | 71.41 | 0.25 / 71.14 | 2464 | 2464/0/0/0 |
| 632 | BGM | 10 | 0 | 50 | 94 | 107.76 | 46.18 / 61.56 | 2772 | 2772/0/0/0 |
| 638 | BGM | 9 | 0 | 50 | 50 | 72.34 | 3.62 / 68.71 | 609 | 609/0/0/0 |
| 646 | BGM | 8 | 0 | 50 | 134 | 68.39 | 7.20 / 61.18 | 2084 | 2084/0/0/0 |
| 649 | BGM | 7 | 0 | 50 | 104 | 111.31 | 0.00 / 111.29 | 1392 | 1392/0/0/0 |
| 652 | BGM | 6 | 0 | 50 | 120 | 30.15 | 2.01 / 28.13 | 607 | 607/0/0/0 |
| 653 | BGM | 8 | 0 | 50 | 128 | 91.38 | 14.13 / 77.23 | 3260 | 3260/0/0/0 |
| 654 | BGM | 7 | 0 | 50 | 100 | 48.24 | 0.00 / 48.22 | 1469 | 1469/0/0/0 |
| 658 | BGM | 10 | 0 | 50 | 92 | 110.08 | 47.18 / 62.89 | 2772 | 2772/0/0/0 |
| 659 | BGM | 8 | 0 | 50 | 96 | 48.37 | 3.15 / 45.20 | 2112 | 2112/0/0/0 |
| 663 | BGM | 8 | 0 | 50 | 152 | 76.16 | 3.18 / 72.97 | 1473 | 1473/0/0/0 |
| 665 | BGM | 8 | 0 | 50 | 60 | 64.31 | 16.07 / 48.22 | 664 | 664/0/0/0 |
| 669 | BGM | 8 | 0 | 50 | 110 | 55.92 | 3.30 / 52.61 | 2096 | 2096/0/0/0 |
| 670 | BGM | 9 | 0 | 50 | 96 | 67.20 | 1.89 / 65.30 | 1773 | 1773/0/0/0 |
| 671 | BGM | 10 | 0 | 50 | 156* | 85.32 | 2.33 / 82.98 | 1700 | 1700/0/0/0 |
| 672 | BGM | 9 | 0 | 50 | 116 | 43.66 | 2.09 / 41.55 | 360 | 360/0/0/0 |
| 673 | BGM | 8 | 0 | 50 | 114 | 69.82 | 0.00 / 69.80 | 2204 | 2204/0/0/0 |
| 675 | BGM | 11 | 0 | 50 | 64 | 90.43 | 0.00 / 90.41 | 1690 | 1690/0/0/0 |
| 685 | BGM | 8 | 0 | 50 | 130 | 59.37 | 14.85 / 44.50 | 1477 | 1477/0/0/0 |
| 691 | BGM | 8 | 0 | 50 | 308 | 14.11 | 1.57 / 12.52 | 823 | 823/0/0/0 |
| 692 | BGM | 9 | 0 | 50 | 130 | 11.15 | 1.86 / 9.28 | 667 | 667/0/0/0 |
| 693 | BGM | 7 | 0 | 50 | 286 | 10.15 | 0.85 / 9.28 | 484 | 484/0/0/0 |
| 694 | BGM | 9 | 0 | 50 | 110 | 19.76 | 2.19 / 17.55 | 1216 | 1216/0/0/0 |
| 695 | BGM | 8 | 0 | 50 | 280 | 16.39 | 2.60 / 13.78 | 830 | 830/0/0/0 |
| 696 | BGM | 7 | 0 | 50 | 250 | 12.56 | 1.94 / 10.60 | 551 | 551/0/0/0 |
| 697 | BGM | 8 | 0 | 50 | 160 | 23.00 | 3.40 / 19.59 | 921 | 921/0/0/0 |
| 698 | BGM | 9 | 0 | 50 | 140* | 34.57 | 7.01 / 27.54 | 416 | 416/0/0/0 |
| 699 | BGM | 8 | 0 | 50 | 208 | 22.05 | 1.17 / 20.86 | 415 | 415/0/0/0 |
| 700 | BGM | 8 | 0 | 50 | 150 | 20.91 | 1.61 / 19.29 | 1249 | 1249/0/0/0 |
| 701 | BGM | 9 | 0 | 50 | 228 | 11.27 | 2.78 / 8.47 | 483 | 483/0/0/0 |
| 702 | BGM | 9 | 0 | 50 | 170 | 25.55 | 2.85 / 22.69 | 835 | 835/0/0/0 |
| 703 | BGM | 6 | 0 | 50 | 120 | 32.41 | 0.25 / 32.15 | 893 | 893/0/0/0 |
| 704 | BGM | 8 | 0 | 50 | 134 | 18.02 | 3.60 / 14.40 | 975 | 975/0/0/0 |
| 705 | BGM | 8 | 0 | 50 | 202 | 40.60 | 4.79 / 35.80 | 1349 | 1349/0/0/0 |
| 707 | BGM | 9 | 0 | 50 | 180 | 92.44 | 13.39 / 79.03 | 3089 | 3089/0/0/0 |
| 708 | BGM | 10 | 0 | 50 | 186 | 110.20 | 22.05 / 88.13 | 3414 | 3414/0/0/0 |
| 709 | BGM | 9 | 0 | 50 | 184 | 96.99 | 13.11 / 83.86 | 2587 | 2587/0/0/0 |
| 711 | BGM | 9 | 0 | 50 | 180 | 154.72 | 16.07 / 138.63 | 3545 | 3545/0/0/0 |
| 712 | BGM | 9 | 0 | 50 | 164* | 85.92 | 8.14 / 77.77 | 2942 | 2942/0/0/0 |
| 716 | BGM | 8 | 0 | 50 | 150* | 55.77 | 17.40 / 38.36 | 1303 | 1303/0/0/0 |
| 802 | BGM | 16 | 0 | 50 | 148* | 75.94 | no (ends) | 2792 | 2792/0/0/0 |
| 803 | BGM | 8 | 0 | 50 | 118 | 25.57 | 17.38 / 8.17 | 651 | 651/0/0/0 |
| 805 | BGM | 7 | 0 | 50 | 126 | 30.64 | 15.32 / 15.30 | 1167 | 1167/0/0/0 |
| 807 | BGM | 12 | 0 | 50 | 140 | 72.78 | 0.43 / 72.33 | 1908 | 1908/0/0/0 |
| 811 | BGM | 14 | 0 | 50 | 128 | 60.29 | 7.53 / 52.74 | 869 | 869/0/0/0 |
| 812 | BGM | 9 | 0 | 50 | 150* | 51.30 | 4.29 / 47.00 | 1126 | 1126/0/0/0 |
| 813 | BGM | 14 | 0 | 50 | 108* | 65.00 | 2.24 / 62.73 | 2259 | 2259/0/0/0 |
| 814 | BGM | 12 | 0 | 50 | 120 | 68.58 | 20.34 / 48.22 | 2086 | 2086/0/0/0 |
| 815 | BGM | 11 | 0 | 50 | 136 | 42.58 | 7.10 / 35.46 | 1200 | 1200/0/0/0 |
| 816 | BGM | 9 | 0 | 50 | 84 | 80.38 | 0.00 / 80.36 | 1830 | 1830/0/0/0 |
| 817 | BGM | 7 | 0 | 50 | 88 | 74.00 | 0.00 / 73.99 | 850 | 850/0/0/0 |
| 818 | BGM | 9 | 0 | 50 | 100* | 58.92 | 7.87 / 51.03 | 1333 | 1333/0/0/0 |
| 819 | BGM | 14 | 0 | 50 | 128 | 37.94 | 7.79 / 30.14 | 1273 | 1273/0/0/0 |
| 820 | BGM | 9 | 0 | 50 | 132 | 54.82 | 18.27 / 36.53 | 1676 | 1676/0/0/0 |
| 821 | BGM | 9 | 0 | 50 | 130 | 53.81 | 5.58 / 48.22 | 1477 | 1477/0/0/0 |
| 822 | BGM | 12 | 0 | 50 | 132 | 43.87 | 20.09 / 23.76 | 1010 | 1010/0/0/0 |
| 823 | BGM | 13 | 0 | 50 | 96* | 52.76 | 7.99 / 44.75 | 533 | 533/0/0/0 |
| 824 | BGM | 11 | 0 | 50 | 122 | 73.15 | 9.89 / 63.24 | 1766 | 1766/0/0/0 |
| 825 | BGM | 13 | 0 | 50 | 126 | 34.47 | 3.83 / 30.62 | 1022 | 1022/0/0/0 |
| 826 | BGM | 13 | 0 | 50 | 60 | 60.29 | 12.05 / 48.22 | 970 | 970/0/0/0 |
| 827 | BGM | 13 | 0 | 50 | 130 | 33.40 | 1.86 / 31.53 | 1072 | 1072/0/0/0 |
| 828 | BGM | 12 | 0 | 50 | 84* | 53.78 | 3.06 / 50.70 | 1027 | 1027/0/0/0 |
| 829 | BGM | 4 | 0 | 50 | 70 | 41.35 | 0.00 / 41.34 | 219 | 219/0/0/0 |
| 830 | BGM | 11 | 0 | 50 | 104 | 37.40 | 9.58 / 27.81 | 661 | 661/0/0/0 |
| 831 | BGM | 11 | 0 | 50 | 116 | 40.82 | 7.53 / 33.27 | 1425 | 1425/0/0/0 |
| 832 | BGM | 13 | 0 | 50 | 114* | 39.63 | 6.63 / 32.98 | 1199 | 1199/0/0/0 |
| 833 | BGM | 12 | 0 | 50 | 106 | 34.14 | 2.28 / 31.84 | 1040 | 1040/0/0/0 |
| 834 | BGM | 12 | 0 | 50 | 128 | 34.88 | 4.72 / 30.14 | 1117 | 1117/0/0/0 |
| 835 | BGM | 8 | 0 | 50 | 114 | 33.87 | 0.00 / 33.85 | 797 | 797/0/0/0 |
| 836 | BGM | 11 | 0 | 50 | 136* | 52.62 | 3.68 / 48.92 | 1297 | 1297/0/0/0 |
| 837 | BGM | 14 | 0 | 50 | 120 | 42.46 | 2.26 / 40.18 | 1435 | 1435/0/0/0 |
| 838 | BGM | 10 | 0 | 50 | 138 | 39.45 | 6.23 / 33.20 | 1416 | 1416/0/0/0 |
| 839 | BGM | 13 | 0 | 50 | 162 | 48.02 | 9.31 / 38.69 | 1908 | 1908/0/0/0 |
| 840 | BGM | 9 | 0 | 50 | 92 | 26.47 | 5.49 / 20.96 | 706 | 706/0/0/0 |
| 841 | BGM | 12 | 0 | 50 | 130 | 82.56 | 23.19 / 59.35 | 4012 | 4012/0/0/0 |
| 844 | BGM | 10 | 0 | 50 | 108 | 55.84 | 35.73 / 20.09 | 1490 | 1490/0/0/0 |
| 845 | BGM | 7 | 0 | 50 | 108* | 64.41 | 0.00 / 64.39 | 734 | 734/0/0/0 |
| 846 | BGM | 13 | 0 | 50 | 84 | 40.20 | 5.74 / 34.44 | 927 | 927/0/0/0 |
| 847 | BGM | 12 | 0 | 50 | 140* | 111.37 | 16.04 / 95.32 | 2111 | 2111/0/0/0 |
| 848 | BGM | 11 | 0 | 50 | 90* | 53.07 | 23.46 / 29.60 | 671 | 671/0/0/0 |
| 849 | BGM | 14 | 0 | 50 | 86* | 53.95 | 11.07 / 42.86 | 856 | 856/0/0/0 |
| 850 | BGM | 8 | 0 | 50 | 132 | 36.55 | 3.67 / 32.87 | 881 | 881/0/0/0 |
| 851 | BGM | 11 | 0 | 50 | 130 | 48.24 | 3.72 / 44.50 | 878 | 878/0/0/0 |
| 852 | BGM | 9 | 0 | 50 | 160 | 81.39 | 15.07 / 66.30 | 1845 | 1845/0/0/0 |
| 853 | BGM | 14 | 0 | 50 | 130 | 72.34 | 12.99 / 59.34 | 2525 | 2525/0/0/0 |
| 854 | BGM | 12 | 0 | 50 | 92* | 109.77 | 0.00 / 109.75 | 2093 | 2093/0/0/0 |
| 855 | BGM | 13 | 0 | 50 | 120 | 65.31 | 17.08 / 48.22 | 1386 | 1386/0/0/0 |
| 856 | BGM | 9 | 0 | 50 | 130 | 44.54 | 0.00 / 44.52 | 1230 | 1230/0/0/0 |
| 857 | BGM | 8 | 0 | 50 | 140* | 46.93 | 13.14 / 33.77 | 914 | 914/0/0/0 |
| 858 | BGM | 7 | 0 | 50 | 128 | 15.80 | 8.25 / 7.53 | 182 | 182/0/0/0 |
| 860 | BGM | 10 | 0 | 50 | 182 | 27.17 | 5.98 / 21.18 | 1092 | 1092/0/0/0 |
| 861 | BGM | 11 | 0 | 50 | 182 | 22.55 | 1.34 / 21.20 | 995 | 995/0/0/0 |
| 864 | BGM | 3 | 0 | 50 | 240 | 4.04 | 0.00 / 4.02 | 23 | 23/0/0/0 |
| 865 | BGM | 9 | 0 | 50 | 160 | 37.89 | 0.20 / 37.67 | 1503 | 1503/0/0/0 |
| 867 | BGM | 13 | 0 | 50 | 150 | 58.08 | 0.20 / 57.86 | 2144 | 2144/0/0/0 |
| 868 | BGM | 5 | 0 | 50 | 84 | 11.87 | 0.37 / 11.48 | 255 | 255/0/0/0 |
| 870 | BGM | 5 | 0 | 50 | 74 | 32.60 | 0.00 / 32.58 | 246 | 246/0/0/0 |
| 871 | BGM | 8 | 0 | 50 | 132 | 23.82 | 1.89 / 21.92 | 768 | 768/0/0/0 |
| 872 | BGM | 3 | 0 | 50 | 200 | 18.10 | 9.64 / 8.44 | 74 | 74/0/0/0 |
| 873 | BGM | 4 | 0 | 50 | 78* | 32.03 | 13.24 / 18.77 | 338 | 338/0/0/0 |
| 874 | BGM | 11 | 0 | 50 | 116 | 41.59 | 8.32 / 33.25 | 1146 | 1146/0/0/0 |
| 875 | BGM | 7 | 0 | 50 | 142 | 47.57 | 6.80 / 40.75 | 1820 | 1820/0/0/0 |
| 876 | BGM | 13 | 0 | 50 | 140 | 27.69 | 7.00 / 20.68 | 1219 | 1219/0/0/0 |
| 878 | BGM | 8 | 0 | 50 | 148 | 16.31 | 3.27 / 13.03 | 473 | 473/0/0/0 |
| 879 | BGM | 11 | 0 | 50 | 160 | 15.47 | 3.40 / 12.05 | 653 | 653/0/0/0 |
| 880 | BGM | 9 | 0 | 50 | 132 | 24.23 | 2.29 / 21.92 | 449 | 449/0/0/0 |
| 881 | BGM | 8 | 0 | 50 | 132* | 23.86 | 5.66 / 18.18 | 468 | 468/0/0/0 |
| 882 | BGM | 10 | 0 | 50 | 118* | 11.13 | 3.08 / 8.04 | 372 | 372/0/0/0 |
| 883 | BGM | 9 | 0 | 50 | 160 | 13.78 | 1.71 / 12.05 | 523 | 523/0/0/0 |
| 884 | BGM | 10 | 0 | 50 | 144 | 15.09 | 1.67 / 13.39 | 610 | 610/0/0/0 |
| 885 | BGM | 11 | 0 | 50 | 164 | 14.73 | 2.95 / 11.77 | 599 | 599/0/0/0 |
| 886 | BGM | 6 | 0 | 50 | 144 | 22.20 | 8.79 / 13.39 | 569 | 569/0/0/0 |
| 887 | BGM | 11 | 0 | 50 | 182 | 53.01 | 15.91 / 37.09 | 2156 | 2156/0/0/0 |
| 888 | BGM | 11 | 0 | 50 | 186* | 125.32 | 23.51 / 101.80 | 4458 | 4458/0/0/0 |
| 889 | BGM | 14 | 0 | 50 | 188* | 76.87 | 16.64 / 60.21 | 3281 | 3281/0/0/0 |
| 890 | BGM | 11 | 0 | 50 | 180 | 69.83 | 13.56 / 56.26 | 2774 | 2774/0/0/0 |
| 891 | BGM | 13 | 0 | 50 | 188* | 69.16 | 17.91 / 51.23 | 2278 | 2278/0/0/0 |
| 892 | BGM | 14 | 0 | 50 | 190 | 105.34 | 12.69 / 92.64 | 3639 | 3639/0/0/0 |
| 893 | BGM | 14 | 0 | 50 | 190* | 84.65 | 2.93 / 81.70 | 2331 | 2331/0/0/0 |
| 894 | BGM | 14 | 0 | 50 | 190 | 105.34 | 12.69 / 92.64 | 3499 | 3499/0/0/0 |
| 895 | BGM | 13 | 0 | 50 | 184 | 68.16 | 23.59 / 44.55 | 2517 | 2517/0/0/0 |
| 897 | BGM | 10 | 0 | 50 | 172 | 93.24 | 11.22 / 82.01 | 3644 | 3644/0/0/0 |
| 898 | BGM | 14 | 0 | 50 | 184 | 69.47 | 6.23 / 63.22 | 3682 | 3682/0/0/0 |
| 899 | BGM | 8 | 0 | 50 | 160* | 19.62 | 7.55 / 12.05 | 657 | 657/0/0/0 |
| 900 | BGM | 9 | 0 | 50 | 152 | 14.30 | 1.59 / 12.69 | 644 | 644/0/0/0 |
| 901 | BGM | 8 | 0 | 50 | 152 | 12.71 | 0.00 / 12.69 | 556 | 556/0/0/0 |
| 902 | BGM | 9 | 0 | 50 | 164 | 38.24 | 2.95 / 35.28 | 1215 | 1215/0/0/0 |
| 903 | BGM | 14 | 0 | 50 | 154* | 86.01 | 18.47 / 67.52 | 3535 | 3535/0/0/0 |
| 904 | BGM | 12 | 0 | 50 | 188 | 71.53 | 20.21 / 51.30 | 2320 | 2320/0/0/0 |
| 913 | BGM | 5 | 0 | 50 | 96 | 82.89 | 2.51 / 80.36 | 1860 | 1860/0/0/0 |
| 915 | BGM | 7 | 0 | 50 | 46* | 89.72 | 22.43 / 67.27 | 2772 | 2772/0/0/0 |
| 917 | BGM | 10 | 0 | 50 | 190 | 93.93 | 5.09 / 88.82 | 2726 | 2726/0/0/0 |
| 927 | BGM | 9 | 0 | 50 | 100 | 71.14 | 3.62 / 67.51 | 1493 | 1493/0/0/0 |
| 928 | BGM | 7 | 0 | 50 | 120 | 56.27 | 12.05 / 44.20 | 1539 | 1539/0/0/0 |
| 929 | BGM | 9 | 0 | 50 | 120 | 64.31 | 4.02 / 60.27 | 1352 | 1352/0/0/0 |
| 931 | BGM | 10 | 0 | 50 | 106 | 29.60 | 2.28 / 27.31 | 898 | 898/0/0/0 |
| 933 | BGM | 8 | 0 | 50 | 82* | 24.93 | 1.10 / 23.81 | 351 | 351/0/0/0 |
| 934 | BGM | 9 | 0 | 50 | 92 | 26.47 | 5.49 / 20.96 | 555 | 555/0/0/0 |
| 938 | BGM | 15 | 0 | 50 | 128 | 87.61 | 0.95 / 86.64 | 1700 | 1700/0/0/0 |
| 939 | BGM | 12 | 0 | 50 | 114 | 34.12 | 0.27 / 33.84 | 1119 | 1119/0/0/0 |
| 943 | BGM | 12 | 0 | 50 | 196* | 49.69 | 9.91 / 39.76 | 942 | 942/0/0/0 |
| 946 | SE2 | 10 | 5 | 50 | 132 | 2.14 | no (ends) | 77 | 77/0/0/0 |
| 947 | SE2 | 6 | 5 | 50 | 174 | 0.77 | no (ends) | 34 | 34/0/0/0 |
| 948 | SE2 | 8 | 5 | 50 | 190 | 1.96 | no (ends) | 97 | 97/0/0/0 |
| 949 | SE2 | 7 | 5 | 50 | 170 | 2.14 | no (ends) | 101 | 101/0/0/0 |
| 950 | SE2 | 9 | 5 | 50 | 162 | 3.78 | no (ends) | 197 | 197/0/0/0 |
| 951 | SE2 | 8 | 5 | 50 | 140 | 4.69 | no (ends) | 201 | 201/0/0/0 |
| 952 | SE2 | 9 | 5 | 50 | 134 | 2.95 | no (ends) | 140 | 140/0/0/0 |
| 954 | SE2 | 6 | 5 | 50 | 150 | 1.89 | no (ends) | 50 | 50/0/0/0 |
| 955 | SE2 | 8 | 5 | 50 | 140 | 1.27 | no (ends) | 79 | 79/0/0/0 |
| 968 | SE2 | 6 | 5 | 50 | 152 | 2.56 | no (ends) | 139 | 139/0/0/0 |
| 975 | SE2 | 11 | 5 | 50 | 122* | 3.73 | no (ends) | 141 | 141/0/0/0 |
| 977 | BGM | 9 | 0 | 50 | 130 | 61.23 | 1.86 / 59.35 | 2155 | 1226/860/0/69 |
| 978 | BGM | 9 | 0 | 50 | 130 | 33.40 | 3.72 / 29.67 | 517 | 276/241/0/0 |
| 979 | BGM | 4 | 0 | 50 | 120 | 46.01 | 4.80 / 41.19 | 843 | 312/531/0/0 |
| 980 | BGM | 6 | 0 | 50 | 182* | 43.78 | 1.34 / 42.43 | 1140 | 538/518/84/0 |
| 981 | BGM | 4 | 0 | 50 | 140 | 27.57 | 0.00 / 27.56 | 198 | 38/160/0/0 |
| 982 | BGM | 4 | 0 | 50 | 140 | 27.57 | 0.00 / 27.56 | 198 | 47/151/0/0 |
| 983 | BGM | 9 | 0 | 50 | 120 | 42.21 | 2.01 / 40.18 | 1031 | 353/445/0/233 |
| 984 | BGM | 5 | 0 | 50 | 84 | 90.08 | 8.25 / 81.81 | 499 | 0/499/0/0 |
| 985 | BGM | 5 | 0 | 50 | 120 | 39.08 | 20.29 / 18.77 | 1321 | 961/360/0/0 |
| 986 | BGM | 4 | 0 | 50 | 120 | 71.42 | 1.93 / 69.48 | 1430 | 419/1011/0/0 |
| 987 | BGM | 5 | 0 | 50 | 154 | 14.10 | 1.57 / 12.51 | 277 | 55/222/0/0 |

Empty entries (header has zero tracks; playing one is a no-op): 0, 270-349, 610-611, 613, 615-620, 623-629, 633-637, 639-645, 647-648, 650-651, 655-657, 660-662, 664, 666-668, 674, 676-684, 686-690, 706, 710, 713-715, 717-801, 804, 806, 808-810, 842-843, 859, 862-863, 866, 869, 877, 896, 905-912, 914, 916, 918-926, 930, 932, 935-937, 940-942, 944-945, 953, 956-967, 969-974, 976 (291 entries).

### Ultra Violet - 346 songs with tracks

| index | player | tracks | prio | reverb | bpm | length s | loop (starts s / body s) | notes | voices (ds/sq/wave/noise notes) |
|---:|---|---:|---:|---:|---:|---:|---|---:|---|
| 1 | SE1 | 1 | 5 | 50 | 132 | 0.49 | no (ends) | 3 | 0/3/0/0 |
| 2 | SE1 | 1 | 5 | 50 | 144 | 0.43 | no (ends) | 4 | 0/4/0/0 |
| 3 | SE1 | 1 | 5 | 50 | 120 | 0.40 | no (ends) | 4 | 0/4/0/0 |
| 4 | SE1 | 1 | 5 | 50 | 144 | 1.02 | no (ends) | 9 | 0/9/0/0 |
| 5 | SE2 | 1 | 5 | 50 | 300 | 0.17 | no (ends) | 5 | 0/5/0/0 |
| 6 | SE1 | 1 | 5 | 50 | 220 | 0.30 | no (ends) | 2 | 0/0/0/2 |
| 7 | SE2 | 1 | 2 | 50 | 220 | 0.30 | no (ends) | 1 | 0/1/0/0 |
| 8 | SE1 | 1 | 5 | 50 | 110 | 0.57 | no (ends) | 2 | 0/0/0/2 |
| 9 | SE1 | 1 | 5 | 50 | 120 | 0.65 | no (ends) | 8 | 0/0/0/8 |
| 10 | SE1 | 1 | 4 | 50 | 120 | 0.22 | no (ends) | 2 | 0/2/0/0 |
| 11 | SE1 | 1 | 4 | 50 | 120 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 12 | SE1 | 2 | 5 | 50 | 90 | 0.27 | no (ends) | 3 | 1/0/0/2 |
| 13 | SE1 | 2 | 5 | 50 | 90 | 1.19 | no (ends) | 4 | 2/0/0/2 |
| 14 | SE1 | 2 | 5 | 50 | 90 | 1.44 | no (ends) | 24 | 12/0/0/12 |
| 15 | SE1 | 3 | 5 | 50 | 90 | 0.43 | no (ends) | 9 | 3/3/0/3 |
| 16 | SE1 | 3 | 5 | 50 | 90 | 0.85 | no (ends) | 5 | 2/1/0/2 |
| 17 | SE1 | 1 | 5 | 50 | 150 | 0.67 | no (ends) | 13 | 0/0/0/13 |
| 18 | SE1 | 1 | 4 | 50 | 120 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 19 | SE1 | 1 | 4 | 50 | 220 | 1.94 | no (ends) | 2 | 0/0/0/2 |
| 20 | SE1 | 1 | 4 | 50 | 240 | 0.77 | no (ends) | 4 | 4/0/0/0 |
| 21 | SE1 | 1 | 4 | 50 | 100 | 0.40 | no (ends) | 5 | 0/5/0/0 |
| 22 | SE1 | 1 | 4 | 50 | 100 | 0.32 | no (ends) | 3 | 0/3/0/0 |
| 23 | SE1 | 1 | 4 | 50 | 128 | 0.15 | no (ends) | 2 | 0/2/0/0 |
| 24 | SE2 | 4 | 4 | 50 | 144 | 0.65 | no (ends) | 11 | 5/6/0/0 |
| 25 | SE1 | 1 | 4 | 50 | 240 | 0.27 | no (ends) | 2 | 0/2/0/0 |
| 26 | SE1 | 1 | 4 | 50 | 240 | 0.37 | no (ends) | 4 | 0/4/0/0 |
| 27 | SE1 | 1 | 5 | 50 | 240 | 1.66 | no (ends) | 1 | 1/0/0/0 |
| 28 | SE1 | 1 | 4 | 50 | 180 | 0.10 | no (ends) | 2 | 0/2/0/0 |
| 29 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 0/0/0/3 |
| 30 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 0/0/0/3 |
| 31 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 8 | 0/0/0/8 |
| 32 | SE1 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 4 | 0/0/0/4 |
| 33 | SE1 | 1 | 4 | 50 | 120 | 1.16 | no (ends) | 10 | 0/0/0/10 |
| 34 | SE1 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/0/0/2 |
| 35 | SE1 | 2 | 4 | 50 | 120 | 0.34 | no (ends) | 10 | 5/0/0/5 |
| 36 | SE1 | 2 | 4 | 50 | 150 | 0.17 | no (ends) | 7 | 0/4/0/3 |
| 37 | SE1 | 1 | 4 | 50 | 170 | 0.74 | no (ends) | 1 | 1/0/0/0 |
| 38 | SE2 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 6 | 3/0/0/3 |
| 39 | SE1 | 1 | 4 | 50 | 110 | 0.77 | no (ends) | 7 | 0/7/0/0 |
| 40 | SE1 | 1 | 4 | 50 | 110 | 0.85 | no (ends) | 8 | 0/8/0/0 |
| 41 | SE1 | 1 | 4 | 50 | 220 | 0.43 | no (ends) | 2 | 0/0/0/2 |
| 42 | SE1 | 1 | 4 | 50 | 220 | 0.37 | no (ends) | 4 | 4/0/0/0 |
| 43 | SE1 | 2 | 4 | 50 | 150 | 6.45 | 1.61 / 4.82 | 29 | 3/0/0/26 |
| 44 | SE1 | 3 | 4 | 50 | 150 | 2.43 | no (ends) | 5 | 1/4/0/0 |
| 45 | SE2 | 1 | 4 | 50 | 150 | 0.47 | no (ends) | 2 | 0/0/0/2 |
| 46 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 3/0/0/3 |
| 47 | SE2 | 1 | 4 | 50 | 150 | 4.04 | 0.00 / 4.02 | 2 | 2/0/0/0 |
| 48 | SE1 | 2 | 5 | 50 | 150 | 0.72 | no (ends) | 12 | 6/6/0/0 |
| 49 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 50 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 51 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 52 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 1/1/0/0 |
| 53 | SE2 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 4 | 2/0/0/2 |
| 54 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 55 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 56 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 57 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 58 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 59 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 60 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 61 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 62 | SE2 | 2 | 4 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 63 | SE2 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 64 | SE2 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 2 | 2/0/0/0 |
| 65 | SE1 | 2 | 5 | 50 | 128 | 0.62 | no (ends) | 7 | 3/4/0/0 |
| 66 | SE1 | 2 | 5 | 50 | 150 | 1.07 | no (ends) | 4 | 2/2/0/0 |
| 67 | SE2 | 1 | 4 | 50 | 240 | 0.27 | no (ends) | 6 | 6/0/0/0 |
| 68 | SE2 | 1 | 4 | 50 | 240 | 0.22 | no (ends) | 5 | 5/0/0/0 |
| 69 | SE2 | 1 | 4 | 50 | 240 | 0.22 | no (ends) | 9 | 9/0/0/0 |
| 70 | SE2 | 1 | 4 | 50 | 240 | 0.34 | no (ends) | 3 | 3/0/0/0 |
| 71 | SE2 | 1 | 4 | 50 | 150 | 0.17 | no (ends) | 3 | 3/0/0/0 |
| 72 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 5 | 0/5/0/0 |
| 73 | SE1 | 1 | 4 | 50 | 150 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 74 | SE3 | 1 | 2 | 50 | 220 | 0.99 | 0.28 / 0.69 | 3 | 3/0/0/0 |
| 75 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 76 | SE3 | 1 | 2 | 50 | 220 | 0.70 | 0.28 / 0.40 | 3 | 3/0/0/0 |
| 77 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 78 | SE3 | 1 | 2 | 50 | 220 | 0.99 | 0.28 / 0.69 | 3 | 3/0/0/0 |
| 79 | SE3 | 1 | 2 | 50 | 220 | 0.57 | no (ends) | 2 | 2/0/0/0 |
| 80 | SE1 | 1 | 3 | 50 | 220 | 1.67 | no (ends) | 4 | 4/0/0/0 |
| 81 | SE1 | 1 | 3 | 50 | 220 | 1.39 | no (ends) | 1 | 1/0/0/0 |
| 82 | SE1 | 2 | 4 | 50 | 150 | 3.63 | no (ends) | 2 | 1/0/0/1 |
| 83 | SE3 | 1 | 3 | 50 | 150 | 0.62 | 0.00 / 0.60 | 3 | 0/3/0/0 |
| 84 | SE1 | 2 | 5 | 50 | 150 | 0.32 | no (ends) | 4 | 2/2/0/0 |
| 85 | SE2 | 1 | 2 | 50 | 150 | 8.05 | no (ends) | 1 | 1/0/0/0 |
| 86 | SE2 | 1 | 2 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 87 | SE1 | 2 | 5 | 50 | 220 | 0.57 | 0.00 / 0.55 | 6 | 3/0/0/3 |
| 88 | SE1 | 2 | 5 | 50 | 128 | 0.50 | no (ends) | 5 | 2/3/0/0 |
| 89 | SE1 | 1 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 90 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 91 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 92 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 2 | 2/0/0/0 |
| 93 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 2 | 2/0/0/0 |
| 94 | SE1 | 1 | 5 | 50 | 150 | 0.42 | no (ends) | 6 | 6/0/0/0 |
| 95 | SE1 | 1 | 5 | 50 | 220 | 0.57 | no (ends) | 10 | 10/0/0/0 |
| 96 | SE1 | 1 | 5 | 50 | 110 | 3.03 | no (ends) | 2 | 0/0/0/2 |
| 97 | SE1 | 2 | 5 | 50 | 110 | 2.50 | no (ends) | 2 | 1/0/0/1 |
| 98 | SE1 | 1 | 5 | 50 | 150 | 4.84 | no (ends) | 1 | 1/0/0/0 |
| 99 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 100 | SE1 | 2 | 5 | 50 | 110 | 3.72 | no (ends) | 2 | 1/0/0/1 |
| 101 | SE1 | 1 | 5 | 50 | 100 | 0.10 | no (ends) | 2 | 0/2/0/0 |
| 102 | SE1 | 1 | 5 | 50 | 100 | 0.25 | no (ends) | 6 | 0/6/0/0 |
| 103 | SE1 | 2 | 5 | 50 | 144 | 0.34 | no (ends) | 16 | 8/8/0/0 |
| 104 | SE1 | 2 | 5 | 50 | 144 | 0.34 | no (ends) | 16 | 8/8/0/0 |
| 105 | SE1 | 2 | 5 | 50 | 144 | 1.27 | no (ends) | 78 | 39/39/0/0 |
| 106 | SE1 | 2 | 5 | 50 | 150 | 0.42 | no (ends) | 11 | 11/0/0/0 |
| 107 | SE1 | 2 | 5 | 50 | 150 | 0.22 | no (ends) | 2 | 1/0/0/1 |
| 108 | SE1 | 1 | 5 | 50 | 150 | 0.12 | no (ends) | 1 | 1/0/0/0 |
| 109 | SE2 | 1 | 5 | 50 | 150 | 0.07 | no (ends) | 1 | 0/0/0/1 |
| 110 | SE1 | 1 | 5 | 50 | 120 | 0.40 | no (ends) | 4 | 4/0/0/0 |
| 111 | SE2 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 8 | 3/0/0/5 |
| 112 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 12 | 6/0/0/6 |
| 113 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 2/0/0/2 |
| 114 | SE1 | 2 | 4 | 50 | 220 | 1.12 | no (ends) | 26 | 12/14/0/0 |
| 115 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 5 | 3/0/0/2 |
| 116 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 6 | 3/0/0/3 |
| 117 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 2/0/0/0 |
| 118 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 1/0/0/1 |
| 119 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 2 | 2/0/0/0 |
| 120 | SE1 | 1 | 4 | 50 | 220 | 1.94 | no (ends) | 1 | 1/0/0/0 |
| 121 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 6 | 3/0/0/3 |
| 122 | SE1 | 1 | 4 | 50 | 250 | 0.50 | no (ends) | 1 | 1/0/0/0 |
| 123 | SE1 | 2 | 4 | 50 | 250 | 0.99 | no (ends) | 16 | 8/0/0/8 |
| 124 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 5 | 5/0/0/0 |
| 125 | SE2 | 1 | 4 | 50 | 150 | 1.22 | 0.40 / 0.80 | 3 | 3/0/0/0 |
| 126 | SE2 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 1 | 1/0/0/0 |
| 127 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 4/0/0/0 |
| 128 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 129 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 4 | 2/0/0/2 |
| 130 | SE1 | 2 | 4 | 50 | 150 | 0.22 | no (ends) | 7 | 4/0/0/3 |
| 131 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 10 | 5/0/0/5 |
| 132 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 2/0/0/2 |
| 133 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 134 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 8 | 4/0/0/4 |
| 135 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 136 | SE1 | 1 | 4 | 50 | 180 | 0.35 | no (ends) | 1 | 1/0/0/0 |
| 137 | SE1 | 2 | 4 | 50 | 150 | 0.57 | no (ends) | 2 | 1/0/0/1 |
| 138 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 2 | 1/0/0/1 |
| 139 | SE1 | 2 | 4 | 50 | 150 | 3.23 | no (ends) | 2 | 1/0/0/1 |
| 140 | SE1 | 2 | 4 | 50 | 220 | 0.85 | no (ends) | 7 | 4/0/0/3 |
| 141 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 10 | 10/0/0/0 |
| 142 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 5 | 2/0/0/3 |
| 143 | SE2 | 2 | 4 | 50 | 150 | 1.62 | no (ends) | 2 | 1/0/0/1 |
| 144 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 145 | SE2 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 3 | 3/0/0/0 |
| 146 | SE1 | 1 | 4 | 50 | 150 | 1.22 | 0.40 / 0.80 | 3 | 3/0/0/0 |
| 147 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 1 | 1/0/0/0 |
| 148 | SE1 | 1 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 4/0/0/0 |
| 149 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 2/0/0/2 |
| 150 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 4 | 2/0/0/2 |
| 151 | SE1 | 2 | 4 | 50 | 220 | 0.57 | no (ends) | 15 | 9/0/0/6 |
| 152 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 5 | 3/0/0/2 |
| 153 | SE1 | 1 | 4 | 50 | 250 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 154 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 15 | 13/0/0/2 |
| 155 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 156 | SE1 | 1 | 4 | 50 | 150 | 1.62 | no (ends) | 1 | 1/0/0/0 |
| 157 | SE1 | 2 | 4 | 50 | 150 | 2.03 | no (ends) | 2 | 1/0/0/0 (1 unsupported) |
| 158 | SE1 | 1 | 4 | 50 | 150 | 2.03 | no (ends) | 1 | 1/0/0/0 |
| 159 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 160 | SE2 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 161 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 162 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 4 | 4/0/0/0 |
| 163 | SE2 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 164 | SE1 | 1 | 4 | 50 | 150 | 1.62 | no (ends) | 6 | 6/0/0/0 |
| 165 | SE1 | 2 | 4 | 50 | 100 | 4.39 | no (ends) | 8 | 8/0/0/0 |
| 166 | SE1 | 2 | 4 | 50 | 100 | 3.18 | no (ends) | 4 | 4/0/0/0 |
| 167 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 6 | 6/0/0/0 |
| 168 | SE1 | 1 | 4 | 50 | 150 | 0.27 | no (ends) | 5 | 5/0/0/0 |
| 169 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 2/0/0/0 |
| 170 | SE1 | 1 | 4 | 50 | 150 | 0.82 | no (ends) | 3 | 3/0/0/0 |
| 171 | SE1 | 2 | 4 | 50 | 150 | 1.22 | no (ends) | 8 | 6/0/0/2 |
| 172 | SE1 | 2 | 4 | 50 | 150 | 0.87 | no (ends) | 40 | 20/20/0/0 |
| 173 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 174 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 2 | 1/1/0/0 |
| 175 | SE1 | 1 | 4 | 50 | 150 | 1.32 | no (ends) | 1 | 1/0/0/0 |
| 176 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 3 | 3/0/0/0 |
| 177 | SE1 | 1 | 4 | 50 | 150 | 0.72 | no (ends) | 2 | 2/0/0/0 |
| 178 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 179 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 180 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 6/0/0/0 |
| 181 | SE1 | 1 | 4 | 50 | 150 | 0.62 | no (ends) | 1 | 1/0/0/0 |
| 182 | SE1 | 2 | 4 | 50 | 190 | 0.59 | no (ends) | 2 | 1/1/0/0 |
| 183 | SE1 | 1 | 4 | 50 | 150 | 0.52 | no (ends) | 5 | 5/0/0/0 |
| 184 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 10 | 8/0/0/2 |
| 185 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 15 | 12/0/0/3 |
| 186 | SE1 | 1 | 4 | 50 | 190 | 0.27 | no (ends) | 1 | 1/0/0/0 |
| 187 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 6 | 6/0/0/0 |
| 188 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 3 | 3/0/0/0 |
| 189 | SE1 | 1 | 4 | 50 | 220 | 0.57 | no (ends) | 6 | 6/0/0/0 |
| 190 | SE1 | 2 | 4 | 50 | 220 | 0.37 | no (ends) | 13 | 2/0/0/11 |
| 191 | SE1 | 2 | 4 | 50 | 150 | 0.62 | no (ends) | 16 | 8/0/0/8 |
| 192 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 7 | 7/0/0/0 |
| 193 | SE1 | 1 | 4 | 50 | 190 | 0.82 | no (ends) | 8 | 8/0/0/0 |
| 194 | SE2 | 1 | 4 | 50 | 150 | 3.23 | no (ends) | 1 | 1/0/0/0 |
| 195 | SE1 | 2 | 4 | 50 | 150 | 2.28 | no (ends) | 44 | 22/22/0/0 |
| 196 | SE1 | 1 | 4 | 50 | 150 | 0.92 | no (ends) | 9 | 9/0/0/0 |
| 197 | SE1 | 1 | 4 | 50 | 150 | 0.92 | no (ends) | 9 | 9/0/0/0 |
| 198 | SE1 | 1 | 4 | 50 | 180 | 0.18 | no (ends) | 3 | 3/0/0/0 |
| 199 | SE1 | 2 | 4 | 50 | 180 | 0.27 | no (ends) | 5 | 3/2/0/0 |
| 200 | SE1 | 2 | 4 | 50 | 150 | 0.92 | no (ends) | 16 | 8/8/0/0 |
| 201 | SE1 | 2 | 4 | 50 | 150 | 0.92 | no (ends) | 16 | 8/8/0/0 |
| 202 | SE2 | 1 | 4 | 50 | 220 | 0.50 | no (ends) | 8 | 8/0/0/0 |
| 203 | SE1 | 1 | 4 | 50 | 150 | 0.32 | no (ends) | 8 | 8/0/0/0 |
| 204 | SE1 | 2 | 4 | 50 | 150 | 4.84 | no (ends) | 84 | 48/36/0/0 |
| 205 | SE1 | 1 | 4 | 50 | 150 | 0.32 | no (ends) | 2 | 2/0/0/0 |
| 206 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 1 | 1/0/0/0 |
| 207 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 14 | 6/0/0/8 |
| 208 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 16 | 8/0/0/8 |
| 209 | SE1 | 2 | 4 | 50 | 150 | 1.02 | no (ends) | 11 | 1/0/0/10 |
| 210 | SE1 | 2 | 4 | 50 | 150 | 1.12 | no (ends) | 37 | 24/13/0/0 |
| 211 | SE1 | 1 | 4 | 50 | 150 | 1.22 | no (ends) | 26 | 26/0/0/0 |
| 212 | SE1 | 2 | 4 | 50 | 200 | 2.43 | no (ends) | 54 | 1/0/0/53 |
| 213 | SE1 | 2 | 4 | 50 | 220 | 0.30 | no (ends) | 8 | 1/0/0/7 |
| 214 | SE1 | 2 | 4 | 50 | 220 | 1.12 | no (ends) | 6 | 4/0/0/2 |
| 215 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 2 | 2/0/0/0 |
| 216 | SE2 | 1 | 4 | 50 | 150 | 2.43 | no (ends) | 1 | 1/0/0/0 |
| 217 | SE1 | 2 | 4 | 50 | 150 | 0.77 | no (ends) | 9 | 7/0/0/2 |
| 218 | SE1 | 2 | 4 | 50 | 180 | 0.43 | no (ends) | 8 | 5/3/0/0 |
| 219 | SE1 | 2 | 4 | 50 | 210 | 0.85 | no (ends) | 19 | 9/10/0/0 |
| 220 | SE1 | 2 | 4 | 50 | 150 | 3.63 | no (ends) | 12 | 4/8/0/0 |
| 221 | SE1 | 2 | 5 | 50 | 150 | 1.27 | no (ends) | 24 | 12/12/0/0 |
| 222 | SE1 | 1 | 4 | 50 | 150 | 0.22 | no (ends) | 3 | 3/0/0/0 |
| 223 | SE1 | 2 | 4 | 50 | 150 | 1.62 | no (ends) | 28 | 1/0/0/27 |
| 224 | SE1 | 2 | 4 | 50 | 100 | 3.33 | no (ends) | 8 | 8/0/0/0 |
| 225 | SE1 | 2 | 4 | 50 | 150 | 0.27 | no (ends) | 6 | 3/0/0/3 |
| 226 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 10 | 3/0/0/7 |
| 227 | SE2 | 2 | 4 | 50 | 150 | 3.43 | no (ends) | 92 | 56/0/0/36 |
| 228 | SE2 | 2 | 4 | 50 | 150 | 2.83 | no (ends) | 2 | 1/0/0/1 |
| 229 | SE1 | 2 | 4 | 50 | 150 | 2.83 | no (ends) | 5 | 5/0/0/0 |
| 230 | SE1 | 2 | 4 | 50 | 150 | 0.82 | no (ends) | 2 | 1/0/0/1 |
| 231 | SE2 | 2 | 4 | 50 | 220 | 0.43 | no (ends) | 7 | 3/0/0/4 |
| 232 | SE1 | 2 | 4 | 50 | 170 | 1.17 | no (ends) | 48 | 26/22/0/0 |
| 233 | SE1 | 2 | 4 | 50 | 150 | 2.23 | no (ends) | 2 | 1/0/0/1 |
| 234 | SE1 | 1 | 4 | 50 | 150 | 0.42 | no (ends) | 1 | 1/0/0/0 |
| 235 | SE1 | 2 | 4 | 50 | 150 | 0.52 | no (ends) | 17 | 10/0/0/7 |
| 236 | SE2 | 2 | 4 | 50 | 150 | 3.33 | no (ends) | 40 | 20/20/0/0 |
| 237 | SE1 | 2 | 4 | 50 | 170 | 0.90 | no (ends) | 24 | 12/12/0/0 |
| 238 | SE1 | 2 | 4 | 50 | 170 | 1.17 | no (ends) | 48 | 26/22/0/0 |
| 239 | SE1 | 2 | 4 | 50 | 190 | 2.80 | no (ends) | 10 | 1/0/0/9 |
| 240 | SE1 | 2 | 4 | 50 | 150 | 0.42 | no (ends) | 16 | 8/0/0/8 |
| 241 | SE1 | 2 | 5 | 50 | 110 | 0.57 | no (ends) | 4 | 0/1/0/3 |
| 242 | SE1 | 1 | 5 | 50 | 182 | 0.69 | no (ends) | 2 | 0/0/0/2 |
| 243 | SE1 | 1 | 5 | 50 | 182 | 1.67 | no (ends) | 1 | 0/0/0/1 |
| 244 | SE1 | 2 | 5 | 50 | 174 | 1.76 | no (ends) | 11 | 9/0/0/2 |
| 245 | SE1 | 2 | 5 | 50 | 310 | 0.10 | no (ends) | 3 | 1/0/0/2 |
| 246 | SE1 | 2 | 5 | 50 | 422 | 0.07 | no (ends) | 4 | 2/2/0/0 |
| 247 | SE1 | 2 | 5 | 50 | 310 | 0.20 | no (ends) | 3 | 2/0/0/1 |
| 248 | SE1 | 1 | 5 | 50 | 124 | 0.64 | no (ends) | 1 | 1/0/0/0 |
| 249 | SE1 | 2 | 5 | 50 | 164 | 3.70 | no (ends) | 6 | 3/3/0/0 |
| 250 | SE1 | 1 | 5 | 50 | 420 | 0.60 | no (ends) | 14 | 14/0/0/0 |
| 251 | SE1 | 1 | 5 | 50 | 420 | 0.60 | no (ends) | 14 | 14/0/0/0 |
| 252 | SE1 | 1 | 5 | 50 | 420 | 0.32 | no (ends) | 7 | 4/3/0/0 |
| 253 | SE1 | 3 | 5 | 50 | 262 | 1.86 | no (ends) | 26 | 1/23/0/2 |
| 254 | SE1 | 2 | 5 | 50 | 150 | 0.87 | no (ends) | 40 | 20/20/0/0 |
| 255 | SE1 | 1 | 5 | 50 | 240 | 0.37 | no (ends) | 4 | 0/4/0/0 |
| 256 | SE2 | 4 | 5 | 50 | 132 | 2.31 | no (ends) | 33 | 23/10/0/0 |
| 257 | SE2 | 5 | 5 | 50 | 174 | 1.07 | no (ends) | 26 | 12/14/0/0 |
| 258 | SE2 | 6 | 5 | 50 | 150* | 2.44 | no (ends) | 48 | 32/16/0/0 |
| 259 | SE2 | 7 | 5 | 50 | 150 | 3.83 | no (ends) | 96 | 49/38/9/0 |
| 260 | SE2 | 7 | 5 | 50 | 150* | 5.24 | no (ends) | 143 | 80/46/17/0 |
| 261 | SE2 | 7 | 5 | 50 | 150* | 3.23 | no (ends) | 83 | 49/28/6/0 |
| 262 | SE2 | 5 | 5 | 50 | 150* | 1.94 | no (ends) | 36 | 27/9/0/0 |
| 263 | SE2 | 4 | 1 | 50 | 120 | 1.02 | no (ends) | 10 | 2/8/0/0 |
| 264 | BGM | 7 | 1 | 50 | 120 | 32.16 | 16.07 / 16.07 | 772 | 481/130/161/0 |
| 265 | BGM | 8 | 0 | 50 | 196 | 76.30 | 12.31 / 63.97 | 1571 | 1083/415/73/0 |
| 266 | BGM | 8 | 1 | 50 | 198 | 90.13 | 12.19 / 77.92 | 1860 | 1391/441/28/0 |
| 267 | BGM | 4 | 1 | 50 | 116 | 37.44 | 0.00 / 37.42 | 370 | 370/0/0/0 |
| 268 | SE2 | 7 | 5 | 50 | 150* | 4.39 | no (ends) | 118 | 88/18/12/0 |
| 269 | SE2 | 7 | 5 | 50 | 144 | 2.53 | no (ends) | 68 | 42/20/6/0 |
| 270 | SE2 | 6 | 5 | 50 | 150 | 2.63 | no (ends) | 42 | 36/6/0/0 |
| 271 | SE2 | 5 | 5 | 50 | 180 | 2.36 | no (ends) | 38 | 34/4/0/0 |
| 272 | BGM | 8 | 0 | 50 | 146 | 16.54 | 9.91 / 6.61 | 472 | 229/135/45/63 |
| 273 | BGM | 8 | 0 | 50 | 146 | 43.38 | 0.42 / 42.95 | 1344 | 459/502/0/383 |
| 274 | BGM | 10 | 0 | 50 | 130 | 74.20 | 1.86 / 72.33 | 1942 | 1009/632/147/154 |
| 275 | BGM | 7 | 0 | 50 | 128 | 33.92 | 0.00 / 33.90 | 809 | 451/237/121/0 |
| 276 | SE2 | 4 | 5 | 50 | 146 | 6.63 | no (ends) | 40 | 20/20/0/0 |
| 277 | BGM | 8 | 0 | 50 | 188 | 12.21 | no (ends) | 536 | 278/116/51/91 |
| 278 | BGM | 10 | 0 | 50 | 140 | 45.22 | 3.88 / 41.32 | 1256 | 831/346/77/2 |
| 279 | BGM | 9 | 0 | 50 | 120 | 36.18 | 2.01 / 34.16 | 1178 | 616/290/108/164 |
| 280 | BGM | 8 | 0 | 50 | 128 | 82.89 | 7.53 / 75.34 | 913 | 523/390/0/0 |
| 281 | BGM | 2 | 0 | 50 | 146 | 2.09 | no (ends) | 10 | 0/5/5/0 |
| 282 | BGM | 8 | 0 | 50 | 134 | 34.44 | 0.23 / 34.19 | 865 | 428/336/101/0 |
| 283 | BGM | 7 | 0 | 50 | 146 | 8.69 | 2.08 / 6.60 | 188 | 114/46/28/0 |
| 284 | BGM | 9 | 0 | 50 | 174 | 6.78 | 1.22 / 5.54 | 171 | 95/44/0/32 |
| 285 | BGM | 8 | 0 | 50 | 154 | 9.43 | 3.15 / 6.26 | 289 | 173/71/0/45 |
| 286 | BGM | 9 | 0 | 50 | 152 | 28.58 | 1.59 / 26.97 | 1028 | 484/284/109/151 |
| 287 | BGM | 10 | 0 | 50 | 128 | 105.75 | 0.25 / 105.48 | 1456 | 794/338/98/226 |
| 288 | BGM | 7 | 0 | 50 | 110* | 92.54 | 0.00 / 92.52 | 1117 | 1005/112/0/0 |
| 289 | BGM | 10 | 0 | 50 | 132 | 65.78 | 14.62 / 51.15 | 1728 | 737/495/254/242 |
| 290 | BGM | 9 | 0 | 50 | 94* | 250.64 | no (ends) | 4741 | 3650/933/158/0 |
| 291 | BGM | 8 | 0 | 50 | 116 | 25.23 | 0.27 / 24.95 | 548 | 351/85/104/8 |
| 292 | BGM | 6 | 0 | 50 | 118 | 20.96 | 0.52 / 20.43 | 467 | 328/139/0/0 |
| 293 | BGM | 9 | 0 | 50 | 124 | 36.23 | 5.11 / 31.11 | 1270 | 474/437/112/247 |
| 294 | BGM | 10 | 0 | 50 | 124 | 35.03 | 3.90 / 31.11 | 951 | 327/376/81/167 |
| 295 | BGM | 8 | 0 | 50 | 136 | 32.38 | 4.00 / 28.36 | 827 | 496/240/91/0 |
| 296 | BGM | 10 | 0 | 50 | 186 | 57.06 | 2.60 / 54.45 | 2131 | 1090/570/158/313 |
| 297 | BGM | 10 | 0 | 50 | 172 | 102.35 | 19.64 / 82.69 | 3387 | 1452/1140/236/559 |
| 298 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1578 | 633/334/267/344 |
| 299 | BGM | 10 | 0 | 50 | 172 | 74.32 | 14.03 / 60.27 | 3259 | 1605/870/286/498 |
| 300 | BGM | 6 | 0 | 50 | 88 | 43.87 | 0.00 / 43.85 | 526 | 378/148/0/0 |
| 301 | BGM | 6 | 0 | 50 | 120 | 17.09 | 1.00 / 16.07 | 426 | 212/214/0/0 |
| 302 | BGM | 9 | 0 | 50 | 160 | 25.63 | 13.56 / 12.05 | 719 | 465/124/0/130 |
| 303 | BGM | 10 | 0 | 50 | 116 | 33.28 | 0.00 / 33.27 | 702 | 378/259/65/0 |
| 304 | BGM | 10 | 0 | 50 | 114 | 71.93 | 8.47 / 63.44 | 1414 | 861/264/66/223 |
| 305 | BGM | 7 | 0 | 50 | 100 | 32.56 | 3.62 / 28.93 | 575 | 329/190/56/0 |
| 306 | BGM | 6 | 0 | 50 | 134 | 59.40 | 1.81 / 57.58 | 405 | 327/74/0/0 (4 unsupported) |
| 307 | BGM | 9 | 0 | 50 | 114* | 59.40 | 3.72 / 55.67 | 1935 | 1031/465/126/313 |
| 308 | BGM | 9 | 0 | 50 | 120 | 34.17 | 2.01 / 32.15 | 804 | 396/207/68/133 |
| 309 | BGM | 7 | 0 | 50 | 110 | 39.48 | 2.19 / 37.27 | 906 | 641/265/0/0 |
| 310 | BGM | 9 | 0 | 50 | 136 | 16.27 | 2.08 / 14.18 | 1162 | 535/428/83/116 |
| 311 | BGM | 7 | 0 | 50 | 140 | 15.69 | 1.89 / 13.78 | 347 | 242/79/26/0 |
| 312 | BGM | 8 | 0 | 50 | 150* | 48.22 | 6.28 / 41.92 | 918 | 496/280/141/0 (1 unsupported) |
| 313 | BGM | 9 | 0 | 50 | 116 | 37.44 | 0.00 / 37.42 | 1031 | 528/329/60/114 |
| 314 | BGM | 9 | 0 | 50 | 126 | 61.73 | 0.49 / 61.23 | 1363 | 787/254/61/261 |
| 315 | BGM | 9 | 0 | 50 | 168 | 20.11 | 2.88 / 17.21 | 604 | 291/137/52/124 |
| 316 | BGM | 9 | 0 | 50 | 168 | 18.68 | 1.44 / 17.23 | 565 | 267/127/52/119 |
| 317 | SE2 | 7 | 5 | 50 | 64* | 3.35 | no (ends) | 96 | 51/35/10/0 |
| 318 | SE2 | 6 | 5 | 50 | 44* | 2.68 | no (ends) | 58 | 38/20/0/0 |
| 319 | SE2 | 8 | 5 | 50 | 64* | 3.60 | no (ends) | 152 | 108/37/7/0 |
| 320 | SE2 | 5 | 5 | 50 | 192 | 1.27 | no (ends) | 78 | 75/0/0/3 |
| 321 | BGM | 5 | 0 | 50 | 150 | 8.76 | no (ends) | 364 | 363/1/0/0 |
| 322 | BGM | 7 | 0 | 50 | 140 | 14.01 | 0.22 / 13.78 | 306 | 217/69/20/0 |
| 323 | BGM | 1 | 0 | 50 | 120 | 8.30 | 0.25 / 8.04 | 63 | 63/0/0/0 |
| 324 | BGM | 6 | 0 | 50 | 120 | 12.07 | 0.00 / 12.05 | 158 | 127/31/0/0 |
| 325 | BGM | 7 | 0 | 50 | 120 | 2.03 | no (ends) | 17 | 15/2/0/0 |
| 326 | BGM | 8 | 0 | 50 | 138 | 45.89 | 0.45 / 45.42 | 1345 | 460/502/0/383 |
| 327 | BGM | 8 | 0 | 50 | 134 | 47.25 | 0.45 / 46.78 | 1345 | 460/502/0/383 |
| 328 | BGM | 10 | 0 | 50 | 114 | 33.87 | 0.00 / 33.85 | 702 | 378/259/65/0 |
| 329 | BGM | 7 | 0 | 50 | 124 | 17.53 | 1.96 / 15.55 | 303 | 229/0/0/74 |
| 330 | BGM | 8 | 0 | 50 | 148 | 42.79 | 0.42 / 42.36 | 1344 | 459/502/0/383 |
| 331 | BGM | 7 | 0 | 50 | 110* | 92.54 | 0.00 / 92.52 | 1065 | 1005/60/0/0 |
| 332 | BGM | 8 | 0 | 50 | 146 | 16.54 | 9.91 / 6.61 | 472 | 229/135/45/63 |
| 333 | BGM | 10 | 0 | 50 | 124 | 37.45 | 4.39 / 33.05 | 1358 | 684/403/65/206 |
| 334 | BGM | 10 | 0 | 50 | 128 | 105.75 | 0.25 / 105.48 | 1456 | 794/338/98/226 |
| 335 | BGM | 9 | 0 | 50 | 126 | 61.73 | 0.49 / 61.23 | 1363 | 787/254/61/261 |
| 336 | BGM | 9 | 0 | 50 | 120 | 52.51 | 4.27 / 48.22 | 1237 | 592/318/125/202 |
| 337 | BGM | 9 | 0 | 50 | 116 | 43.66 | 10.40 / 33.25 | 1317 | 620/340/119/238 |
| 338 | SE2 | 2 | 5 | 50 | 80 | 51.25 | no (ends) | 24 | 24/0/0/0 |
| 339 | BGM | 10 | 0 | 50 | 128* | 81.84 | 16.34 / 65.48 | 3623 | 1116/1700/554/253 |
| 340 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1578 | 633/334/267/344 |
| 341 | BGM | 8 | 0 | 50 | 182 | 45.07 | 13.26 / 31.79 | 1775 | 620/544/267/344 |
| 342 | BGM | 7 | 0 | 50 | 164 | 8.84 | 2.95 / 5.88 | 280 | 153/82/0/45 |
| 343 | BGM | 7 | 0 | 50 | 128 | 15.09 | 0.00 / 15.07 | 438 | 89/349/0/0 |
| 344 | BGM | 7 | 0 | 50 | 128 | 33.92 | 0.00 / 33.90 | 809 | 451/237/121/0 |
| 345 | BGM | 6 | 0 | 50 | 72 | 53.59 | 0.00 / 53.58 | 522 | 376/146/0/0 |
| 346 | BGM | 4 | 0 | 50 | 144 | 3.78 | 0.42 / 3.35 | 47 | 25/17/0/5 |

Empty entries (header has zero tracks; playing one is a no-op): 0 (1 entries).

