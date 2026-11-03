#!/usr/bin/env node
// tools/pokemonarena_music_oracle.mjs -- compare pokemonarena/js/mp2k_synth.js against the REAL m4a engine running in the
// site's first-party mGBA core (gba/mgba/mgba_core.js, read-only here).
//
//   node tools/pokemonarena_music_oracle.mjs                       # default suite: 5 SoulGold + 2 Ultra Violet songs, 3 sound effects, 2 natural battle themes
//   node tools/pokemonarena_music_oracle.mjs --quick               # 2 songs per ROM
//   node tools/pokemonarena_music_oracle.mjs --songs sg:805,350 uv:321
//   node tools/pokemonarena_music_oracle.mjs --mixer               # gSoundInfo of each ROM vs MIXER_PROFILES
//   node tools/pokemonarena_music_oracle.mjs --wave-map            # PSG wave-channel volume code (SOUND3CNT_H) vs the synth's envelope value
//   node tools/pokemonarena_music_oracle.mjs --json out.json
//
// HOW A SONG REACHES THE ORACLE (no assumption about which song plays):
//   1. boot the ROM, run to a quiet/steady frame, take a savestate;
//   2. call the GAME'S OWN m4aSongNumStart(index) (its address is pinned per ROM and PROVEN by behaviour below): the savestate's CPU
//      registers are edited to enter that function, with r14 pointing at a tiny stub in unused EWRAM that restores r0-r3,r12 and
//      returns to the interrupted code; the mGBA bridge has no register API, so the state is edited in memory (state layout: gprs at
//      0x20, cpsr 0x60, IWRAM at 0x19000, EWRAM at 0x21000; nothing outside this process is changed, nothing is written to the repo);
//   3. PROOF the call took: one frame later the BGM/SE player's songHeader pointer in RAM (gMPlayInfo) must equal the header pointer of
//      the requested song-table entry (tries are counted; a call that did not take is retried one frame later);
//   4. capture the core's audio (65536 Hz stereo int16) for N frames and compare with renderSong() for the same index.
// Natural captures (--natural / default suite) use tools/pokemonarena_rom_oracle.mjs (OR1): the GAME picks the battle theme; the song
// id is READ from the engine's RAM and mapped to a table index; alignment uses the engine's own tick counter (mplayInfo.clock).
//
// METRICS (all on mono, 32768 Hz, one-pole 25 Hz high-passed on BOTH sides so the oracle's retained PSG DC cannot bias anything):
//   envCorr   Pearson correlation of the 20 ms RMS loudness envelopes over the aligned span
//   waveCorr  Pearson correlation of the sample-by-sample waveforms over a 3 s window at the best sub-frame alignment
//   logSpec   mean over 2048-sample frames of the Pearson correlation of log-magnitude spectra, 100 Hz..5 kHz
//   levelRatio  RMS(oracle) / RMS(synth) over the span (1.0 = same loudness)
//   bandDb    per octave band (60-150, 150-300, ... 4800-9600 Hz) 10*log10(E_oracle/E_synth); maxAbs over the first 7 bands
//   onsetF1   F1 of note-onset times (envelope rise > 6 dB over the previous 20 ms) within +-25 ms
//   lagMs     alignment of the oracle relative to the synth (the engine's own mixing latency: 2 video frames for BGM, 1 for SE)
// NEGATIVE CONTROLS (same procedure, must score clearly worse): a different song of the same ROM; the same song at 1.05x tempo.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Mp2kRom } from '../pokemonarena/js/mp2k.js';
import { SongEngine, FRAME_HZ } from '../pokemonarena/js/mp2k_synth.js';
import { MIXER_PROFILES } from '../pokemonarena/js/music.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

export const ROMS = {
  sg: {
    key: 'soulgold', name: 'Pokemon SoulGold (v1.1.1)', env: 'ARENA_ROM', file: path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'),
    sha256: '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a',
    songTable: 0x15e8ed8, startFn: 0x1a0994, bgmInfo: 0x3004508, mplayTable: 0x15e8ea8, baseFrame: 600, silent: true,
  },
  uv: {
    key: 'ultraviolet', name: 'Ultra Violet', env: 'ARENA_ROM_UV', file: path.join(ROOT, 'gba/gbaWasm/roms/pokemonUltraViolet.gba'),
    sha256: '467fe116ff6d7d5723b9f8fc60dd81c698c5d4e27b1b444168f3be292848d015',
    songTable: 0x4a32cc, startFn: 0x1dd0f4, bgmInfo: 0x3007300, mplayTable: 0x4a329c, baseFrame: 200, silent: false,
  },
};

const STUB = 0x0203FF80, S_EWRAM = 0x21000, S_IWRAM = 0x19000;

// ---------------------------------------------------------------------------------------------------------------
// signal helpers
// ---------------------------------------------------------------------------------------------------------------
export function hpf(x, hz = 25, sr = 32768) { const k = 1 - Math.exp(-2 * Math.PI * hz / sr); const y = new Float32Array(x.length); let lp = 0; for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * k; y[i] = x[i] - lp; } return y; }
export function toMono(a, b) { const m = new Float32Array(a.length); for (let i = 0; i < m.length; i++) m[i] = (a[i] + b[i]) / 2; return m; }
export function corr(a, b, n) { n = n || Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; } return sab / Math.sqrt(saa * sbb + 1e-30); }
export function rms(x, s = 0, n = x.length - s) { let t = 0; for (let i = 0; i < n; i++) t += x[s + i] * x[s + i]; return Math.sqrt(t / Math.max(1, n)); }
export function envelope(x, hop) { const e = new Float32Array(Math.floor(x.length / hop)); for (let k = 0; k < e.length; k++) { let s = 0; for (let i = 0; i < hop; i++) s += x[k * hop + i] * x[k * hop + i]; e[k] = Math.sqrt(s / hop); } return e; }
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } } for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = i + j + len / 2; const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr; re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
export function magSpec(x, s, N = 2048) { const re = new Float64Array(N), im = new Float64Array(N); for (let i = 0; i < N; i++) re[i] = (x[s + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); fft(re, im); const m = new Float64Array(N / 2); for (let i = 0; i < N / 2; i++) m[i] = Math.hypot(re[i], im[i]); return m; }
export function logSpecCorr(a, b, sr = 32768, N = 2048, fmin = 100, fmax = 5000) { const frames = Math.floor((Math.min(a.length, b.length) - N) / N); const k0 = Math.floor(fmin * N / sr), k1 = Math.floor(fmax * N / sr); let tot = 0, cnt = 0; for (let f = 0; f < frames; f++) { const A = magSpec(a, f * N, N), B = magSpec(b, f * N, N); const la = [], lb = []; for (let k = k0; k < k1; k++) { la.push(Math.log(A[k] + 1e-4)); lb.push(Math.log(B[k] + 1e-4)); } tot += corr(la, lb); cnt++; } return cnt ? tot / cnt : 0; }
export const BAND_EDGES = [60, 150, 300, 600, 1200, 2400, 4800, 9600];
export function bandDb(a, b, sr = 32768, N = 2048) { const out = []; const fr = Math.floor((Math.min(a.length, b.length) - N) / (N / 2)); for (let bi = 0; bi < BAND_EDGES.length - 1; bi++) { let ea = 0, eb = 0; const k0 = Math.floor(BAND_EDGES[bi] * N / sr), k1 = Math.floor(BAND_EDGES[bi + 1] * N / sr); for (let f = 0; f < fr; f++) { const A = magSpec(a, f * (N / 2), N), B = magSpec(b, f * (N / 2), N); for (let k = k0; k < k1; k++) { ea += A[k] * A[k]; eb += B[k] * B[k]; } } out.push(10 * Math.log10((ea + 1e-12) / (eb + 1e-12))); } return out; }
export function onsets(x, sr = 32768) { const hop = Math.round(sr * 0.005); const e = envelope(x, hop); const out = []; let last = -1e9; for (let k = 4; k < e.length; k++) { const prev = (e[k - 1] + e[k - 2] + e[k - 3] + e[k - 4]) / 4; if (e[k] > 0.003 && e[k] > prev * 2 && k - last > 12) { out.push(k * 5); last = k; } } return out; }
export function onsetF1(oracleOn, synthOn, tolMs = 25) { const used = new Set(); let tp = 0; for (const t of oracleOn) { let best = -1, bd = tolMs + 1; for (let j = 0; j < synthOn.length; j++) { if (used.has(j)) continue; const d = Math.abs(synthOn[j] - t); if (d < bd) { bd = d; best = j; } } if (best >= 0 && bd <= tolMs) { used.add(best); tp++; } } const p = synthOn.length ? tp / synthOn.length : 0, r = oracleOn.length ? tp / oracleOn.length : 0; return { f1: p + r ? 2 * p * r / (p + r) : 0, precision: p, recall: r, oracle: oracleOn.length, synth: synthOn.length, matched: tp }; }

// ---------------------------------------------------------------------------------------------------------------
// the rig
// ---------------------------------------------------------------------------------------------------------------
export function romPath(which) { const c = ROMS[which]; return process.env[c.env] || c.file; }
export function romAvailable(which) { try { return fs.statSync(romPath(which)).isFile(); } catch (e) { return false; } }

export async function openRig(which, { patchRom } = {}) {
  const cfg = ROMS[which];
  const MgbaCore = require(path.join(ROOT, 'gba/mgba/mgba_core.js'));
  let romBytes = new Uint8Array(fs.readFileSync(romPath(which)));
  if (patchRom) romBytes = patchRom(romBytes);   // an in-memory patched COPY for measurements; the file and the repo are never touched
  const core = await MgbaCore.create({ seats: 1 });
  core.loadRom(romBytes);
  for (let f = 0; f < cfg.baseFrame; f++) core.runFrame();
  const mixer = findMixer(core);
  const rig = { which, cfg, core, rom: romBytes, mixer, parsed: new Mp2kRom(romBytes), base: null, baseInfo: {} };
  if (cfg.silent) { const sb = silentBase(rig); rig.base = sb.state; rig.baseInfo = { silentFrames: sb.frames }; } else rig.base = core.saveState(0);
  return rig;
}

/** gSoundInfo located in IWRAM by its ident word and plausibility of its fields. */
export function findMixer(core) {
  for (let a = 0x03000000; a < 0x03008000; a += 4) {
    if (core.read32(0, a) !== 0x68736D53) continue;
    const w1 = core.read32(0, a + 4), w2 = core.read32(0, a + 8), spv = core.read32(0, a + 16), pf = core.read32(0, a + 20);
    if ((w2 & 0xff) >= 1 && (w2 & 0xff) <= 12 && spv > 100 && spv < 1000 && pf > 5000 && pf < 50000) {
      return { addr: a, reverb: (w1 >> 8) & 0xff, maxChans: (w1 >> 16) & 0xff, masterVol: (w1 >>> 24) & 0xff, freqIndex: w2 & 0xff, mode: (w2 >> 8) & 0xff, pcmDmaPeriod: (w2 >>> 24) & 0xff, samplesPerVBlank: spv, pcmFreq: pf };
    }
  }
  return null;
}

function infoAddrFor(rig, index) {
  const h = rig.parsed.song(index);
  return rig.parsed.table.mplay.players[h.player >= 0 && h.player <= 3 ? h.player : 0].info;
}

/** Edit a savestate so the CPU enters the game's m4aSongNumStart(index) and returns to the interrupted code. */
function enterStartFn(core, cfg, index) {
  const s = core.saveState(0); const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const r = (i) => dv.getUint32(0x20 + 4 * i, true);
  const wasThumb = (dv.getUint32(0x60, true) & 0x20) !== 0;
  const base = S_EWRAM + (STUB - 0x02000000);
  if (!wasThumb) {
    const code = [0xe59f0018, 0xe59f1018, 0xe59f2018, 0xe59f3018, 0xe59fc018, 0xe59ff018];
    code.forEach((v, i) => dv.setUint32(base + 4 * i, v, true));
    [r(0), r(1), r(2), r(3), r(12), r(15)].forEach((v, i) => dv.setUint32(base + 0x20 + 4 * i, v, true));
    dv.setUint32(0x20 + 4 * 14, STUB, true);
  } else {
    // THUMB: sub sp,#4; push {r4}; ldr r4,=pc; str r4,[sp,#4]; ldr r0..r3; ldr r4,=r12; mov r12,r4; pop {r4}; pop {pc}
    const hw = [0xB081, 0xB410, 0x4C04, 0x9401, 0x4804, 0x4908, 0x4A05, 0x4B06, 0x4C06, 0x46A4, 0xBC10, 0xBD00];
    hw.forEach((v, i) => dv.setUint16(base + 2 * i, v, true));
    [(r(15) | 1) >>> 0, r(0), r(1), r(2), r(3), r(12)].forEach((v, i) => dv.setUint32(base + 0x18 + 4 * i, v, true));
    dv.setUint32(0x20 + 4 * 14, (STUB | 1) >>> 0, true);
  }
  dv.setUint8(S_IWRAM + (cfg.bgmInfo - 0x03000000) + 9, 0);   // MPlayStart refuses a lower-priority song; clear the BGM player's priority byte
  dv.setUint32(0x20, index, true);
  dv.setUint32(0x20 + 4 * 15, 0x08000000 + cfg.startFn, true);
  dv.setUint32(0x60, dv.getUint32(0x60, true) | 0x20, true);
  return core.loadState(0, s);
}

export function captureFrames(core, frames) {
  const chunks = []; let n = 0;
  for (let f = 0; f < frames; f++) { core.runFrame(); const a = core.audio(0); chunks.push(a.samples.slice()); n += a.frames; }
  const out = new Int16Array(n * 2); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return { samples: out, frames: n };
}
/** 65536 Hz int16 stereo -> 32768 Hz float (pairwise average). */
export function to32k(i16) { const n = Math.floor(i16.length / 4); const l = new Float32Array(n), r = new Float32Array(n); for (let i = 0; i < n; i++) { l[i] = (i16[4 * i] + i16[4 * i + 2]) / 65536; r[i] = (i16[4 * i + 1] + i16[4 * i + 3]) / 65536; } return { l, r }; }

/** Start song `index` through the game's own function from a saved base state; PROVES the call took (player songHeader == table entry). */
export function startSongVerified(rig, base, index, maxTries = 40) {
  const { core, cfg, parsed } = rig;
  const want = parsed.u32(parsed.table.offset + 8 * index);
  const info = infoAddrFor(rig, index);
  for (let t = 0; t < maxTries; t++) {
    core.loadState(0, base);
    for (let k = 0; k < t; k++) core.runFrame();
    if (!enterStartFn(core, cfg, index)) continue;
    const pre = captureFrames(core, 1);
    if (core.read32(0, info) === want) return { ok: true, tries: t + 1, pre, headerPointer: want, playerInfo: info };
  }
  return { ok: false, tries: maxTries };
}

function silentBase(rig) {
  const { core } = rig;
  const b0 = core.saveState(0);
  const r = startSongVerified(rig, b0, 0);
  if (!r.ok) throw new Error('could not start the empty song to silence the base state');
  let quiet = 0;
  for (let f = 0; f < 600; f++) {
    core.runFrame(); const a = core.audio(0); let m = 0; for (let i = 0; i < a.samples.length; i += 2) { const v = Math.abs(a.samples[i]); if (v > m) m = v; }
    if (m < 40) { if (++quiet >= 30) return { state: core.saveState(0), frames: f + 1 }; } else quiet = 0;
  }
  throw new Error('mixer did not fall silent');
}

function mixerOpts(rig, extra) { const m = rig.mixer; return { ...MIXER_PROFILES[rig.cfg ? rig.cfg.key : 'soulgold'], maxChans: m.maxChans, masterVol: m.masterVol, mixRate: m.pcmFreq, reverb: 0, ...(extra || {}) }; }

export function renderMono(rig, index, seconds, extra, engineOpts) {
  const N = Math.round(32768 * seconds);
  const e = new SongEngine(rig.parsed, index, { sampleRate: 32768, mixer: mixerOpts(rig, extra), ...(engineOpts || {}) });
  const L = new Float32Array(N), R = new Float32Array(N);
  e.read(L, R, 0, N);
  return { mono: toMono(L, R), stats: e.stats, engine: e };
}

/** Align `cap` (oracle) to `mine` (synth): coarse by the 20 ms envelope, fine by waveform, both inside [0, maxLagMs]. */
export function alignSignals(cap, mine, { maxLagMs = 600, coarseWin = 3 } = {}) {
  const hop = 655, ec = envelope(cap, hop), em = envelope(mine, hop);
  let best = null;
  const maxLag = Math.min(Math.floor(maxLagMs / 20), ec.length - 40);
  const n = Math.min(Math.floor(coarseWin * 1000 / 20), em.length, ec.length - maxLag - 1);
  for (let lag = 0; lag <= maxLag; lag++) { const c = corr(ec.subarray(lag, lag + n), em.subarray(0, n), n); if (!best || c > best.c) best = { lag, c }; }
  const W = Math.min(32768 * 3, Math.floor(Math.min(cap.length - best.lag * hop - 1400, mine.length) ));
  let bf = null;
  for (let d = Math.max(0, best.lag * hop - 700); d < best.lag * hop + 700; d++) { if (d + W > cap.length) break; const c = corr(cap.subarray(d, d + W), mine.subarray(0, W), W); if (!bf || c > bf.c) bf = { d, c }; }
  return { offset: bf.d, waveCorr3s: bf.c, coarseEnvCorr: best.c };
}

/** All metrics for an aligned pair (both already high-passed mono at 32768 Hz). */
export function scorePair(capHP, mineHP, offset, seconds) {
  const span = Math.min(Math.floor(32768 * seconds), capHP.length - offset, mineHP.length);
  const a = capHP.subarray(offset, offset + span), b = mineHP.subarray(0, span);
  const bd = bandDb(a, b);
  const oa = onsets(a), ob = onsets(b);
  return {
    spanSeconds: span / 32768,
    envCorr: corr(envelope(a, 655), envelope(b, 655)),
    waveCorr: corr(a.subarray(0, Math.min(span, 32768 * 3)), b.subarray(0, Math.min(span, 32768 * 3))),
    logSpec: logSpecCorr(a, b),
    levelRatio: rms(a) / (rms(b) + 1e-12),
    bandDb: bd, bandMaxAbs: Math.max(...bd.slice(0, 7).map(Math.abs)),
    onset: onsetF1(oa, ob),
  };
}

/** One song, one ROM: capture from the oracle, render, align, score, plus negative controls. */
export async function compareSong(rig, index, { seconds = 8, controls = true, controlWrong, tempoScale = 1.05 } = {}) {
  const { core, parsed } = rig;
  const h = parsed.song(index);
  const sv = startSongVerified(rig, rig.base, index);
  if (!sv.ok) return { which: rig.which, index, ok: false, error: 'game did not accept the song-start call' };
  const cap2 = captureFrames(core, Math.round(seconds * FRAME_HZ) + 30);
  const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
  const f = to32k(all); const capHP = hpf(toMono(f.l, f.r));
  const live = (name, extra, eo) => {
    const r = renderMono(rig, index, seconds + 1, extra, eo); const mineHP = hpf(r.mono);
    const al = alignSignals(capHP, mineHP, { maxLagMs: h.player === 0 ? 600 : 300 });
    return { stats: r.stats, align: al, score: scorePair(capHP, mineHP, al.offset, seconds - 2), name };
  };
  const main = live('synth');
  const out = {
    which: rig.which, rom: ROMS[rig.which].name, index, ok: true, tracks: h.trackCount, player: h.player, startTries: sv.tries,
    identity: { headerPointerInRam: '0x' + sv.headerPointer.toString(16), requested: index, matches: true },
    lagMs: +(main.align.offset / 32.768).toFixed(2), kinds: main.stats.kinds, stolen: main.stats.stolen,
    ...main.score,
  };
  if (controls) {
    let wrong = controlWrong;
    if (wrong === undefined) { for (let i = index + 1; i < parsed.songCount; i++) { const hh = parsed.song(i); if (hh.player === h.player && hh.trackCount >= 3 && i !== index) { wrong = i; break; } } }
    const wrongRender = renderMono(rig, wrong, seconds + 1); const wrongHP = hpf(wrongRender.mono);
    const alW = alignSignals(capHP, wrongHP, { maxLagMs: h.player === 0 ? 600 : 300 });
    out.controlWrongSong = { index: wrong, ...scorePair(capHP, wrongHP, alW.offset, seconds - 2) };
    const ts = live('tempo', undefined, { tempoScale });
    out.controlTempo = { tempoScale, ...ts.score };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// natural captures through OR1's oracle (the GAME chooses the song)
// ---------------------------------------------------------------------------------------------------------------
export async function compareNatural(checkpoint, { seconds = 8, stateDir } = {}) {
  let mod;
  try { mod = await import(pathToFileURL(path.join(HERE, 'pokemonarena_rom_oracle.mjs')).href); } catch (e) { return { ok: false, skipped: true, error: 'OR1 oracle unavailable: ' + e.message }; }
  const o = await mod.openOracle({ stateDir: stateDir || process.env.ARENA_OR1_DIR });
  const parsed = new Mp2kRom(new Uint8Array(fs.readFileSync(romPath('sg'))));
  await o.goto(checkpoint);
  const info = ROMS.sg.bgmInfo;
  const hdr = o.readU32(info), clock = o.readU32(info + 12), tempoD = o.readU16(info + 28), status = o.readU32(info + 4);
  const candidates = []; for (let i = 0; i < parsed.songCount; i++) if (parsed.u32(parsed.table.offset + 8 * i) === hdr) candidates.push(i);
  if (candidates.length !== 1) return { ok: false, checkpoint, error: `BGM header 0x${hdr.toString(16)} maps to ${candidates.length} table entries` };
  const index = candidates[0];
  const cap = o.captureAudio(Math.round(seconds * FRAME_HZ) + 10);
  // 65536 Hz (battle) or other: reduce to 32768 mono
  const rate = cap.rate, S = cap.samples; const nIn = S.length / 2;
  const ratio = rate / 32768; const nOut = Math.floor(nIn / ratio);
  const mono = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) { const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < b; k++) s += (S[2 * k] + S[2 * k + 1]) * 0.5; mono[i] = s / (b - a); }
  const capHP = hpf(mono);
  // where is the engine in the song? my engine ticks at the same rate: run it until its clock equals the oracle's
  const eng = new SongEngine(parsed, index, { sampleRate: 32768, mixer: { maxChans: 12, masterVol: 12, mixRate: 13379, reverb: 0 }, dryRun: true });
  let guard = 0; while (eng.clock < clock && guard++ < 200000) eng._makeFrame();
  const startFrame = eng.frame;
  const total = (startFrame / FRAME_HZ) + seconds + 2;
  const full = renderMono({ parsed, mixer: { maxChans: 12, masterVol: 12, pcmFreq: 13379 } }, index, total, { reverb: 0 });
  const mineAll = hpf(full.mono);
  const startSample = Math.round(startFrame * 32768 / FRAME_HZ);
  const mineSeg = mineAll.subarray(Math.max(0, startSample - 32768 / 2));
  // the oracle audio at t0 is what the engine mixed ~2 frames earlier: search +-0.5 s around the predicted alignment
  const W = 32768 * 3; let bf = null;
  const base = Math.round(32768 / 2);
  for (let d = Math.max(0, base - 20000); d < base + 20000; d++) { if (d + W > mineSeg.length || W > capHP.length) break; const c = corr(capHP.subarray(0, W), mineSeg.subarray(d, d + W), W); if (!bf || c > bf.c) bf = { d, c }; }
  const mine = mineSeg.subarray(bf.d);
  const score = scorePair(capHP, mine, 0, seconds - 2);
  // control: same oracle audio vs a different song's render at its own best alignment
  let wrong = -1; for (let i = index + 1; i < parsed.songCount; i++) { const hh = parsed.song(i); if (hh.player === 0 && hh.trackCount >= 3) { wrong = i; break; } }
  const wr = hpf(renderMono({ parsed, mixer: { maxChans: 12, masterVol: 12, pcmFreq: 13379 } }, wrong, 40, { reverb: 0 }).mono);
  let bw = null; for (let d = 0; d < 32768 * 20; d += 64) { if (d + W > wr.length) break; const c = corr(capHP.subarray(0, W), wr.subarray(d, d + W), W); if (!bw || c > bw.c) bw = { d, c }; }
  return {
    ok: true, which: 'sg', checkpoint, index, natural: true, rate,
    identity: { headerPointerInRam: '0x' + hdr.toString(16), tableIndex: index, status: '0x' + status.toString(16), clock, tempoD },
    predictedStartFrame: startFrame, refinedOffsetMs: +((bf.d - base) / 32.768).toFixed(1), waveCorr3sAtAlignment: bf.c,
    ...score, controlWrongSong: { index: wrong, bestWaveCorr3s: bw ? bw.c : null },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// extra measurements
// ---------------------------------------------------------------------------------------------------------------
export async function measureMixer(which) {
  const cfg = ROMS[which];
  const MgbaCore = require(path.join(ROOT, 'gba/mgba/mgba_core.js'));
  const core = await MgbaCore.create({ seats: 1 });
  core.loadRom(new Uint8Array(fs.readFileSync(romPath(which))));
  const rows = [];
  for (const fr of [60, 150]) { while (core.frames(0) < fr) core.runFrame(); rows.push({ frame: fr, ...findMixer(core) }); }
  const m = rows[rows.length - 1]; const prof = MIXER_PROFILES[cfg.key];
  return { which, measured: m, profile: prof, agree: m.maxChans === prof.maxChans && m.masterVol === prof.masterVol && m.pcmFreq === prof.mixRate, bootReverb: rows[0].reverb };
}

/**
 * Patch a COPY of a song's sequence data so its programmable-wave notes sweep every envelope value 0..15: track volumes become 127, the note
 * velocities cycle 4, 12, ... 124 (envelope = (rightVol + leftVol) >> 4 sweeps the range) and the wave voices get attack 0, sustain 15, release 0 so the
 * level settles at the envelope peak. The real engine and the synth then both run the SAME patched bytes.
 */
export function patchWaveSong(bytes, parsed, song) {
  const out = bytes.slice(); const h = parsed.song(song); let ctr = 0; const used = new Set();
  const oneArg = new Set([0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC8]);
  for (const start of h.tracks) {
    let o = start, rs = 0, guard = 0;
    while (guard++ < 40000 && o < out.length) {
      const b = out[o];
      if (b < 0x80) { // data byte under running status
        if (rs >= 0xCF) { o++; if (out[o] < 0x80) { out[o] = 8 * (ctr++ % 16) + 4; o++; if (out[o] < 0x80) o++; } else ctr++; }
        else if (rs === 0xBE) { out[o] = 127; o++; }
        else if (oneArg.has(rs)) o++;
        else o++;
        continue;
      }
      o++;
      if (b >= 0xBD) rs = b;
      if (b === 0xB1) break;
      if (b === 0xB2) break;
      if (b === 0xB3 || b === 0xB4) { if (b === 0xB3) o += 4; continue; }
      if (b === 0xB5) { o += 5; continue; }
      if (b === 0xB9) { o += 3; continue; }
      if (b === 0xCD) { o += 2; continue; }
      if (b === 0xCE) { if (out[o] < 0x80) o++; continue; }
      if (oneArg.has(b)) { if (b === 0xBD) used.add(out[o]); if (b === 0xBE) out[o] = 127; o++; continue; }
      if (b >= 0xCF) { // note: key, velocity, gate
        if (out[o] < 0x80) { o++; if (out[o] < 0x80) { out[o] = 8 * (ctr++ % 16) + 4; o++; if (out[o] < 0x80) o++; } else ctr++; }
        else ctr++;
      }
    }
  }
  let waveVoices = 0;
  for (const n of used) { const vo = h.voicegroup + 12 * n; if ((out[vo] & 7) === 3 && (out[vo] & 0xC0) === 0) { out[vo + 8] = 0; out[vo + 9] = 0; out[vo + 10] = 15; out[vo + 11] = 0; waveVoices++; } }
  return { bytes: out, waveVoices, notesPatched: ctr };
}

/**
 * Wave-channel volume map: for every SETTLED frame (the synth's envelope value constant over 5 frames and the oracle's SOUND3CNT_H volume code
 * constant over 5 frames, oracle one frame behind) pair the synth's envelope value with the oracle's code (1 = 100%, 2 = 50%, 3 = 25%, 0 = mute).
 * Runs on a patched copy (patchWaveSong) so values up to 15 occur. Returns { pairs: {"env->code": frames}, songs }.
 */
export async function waveMap(songs = [392, 396, 399, 354, 355, 364], { frames = 700, natural = [392, 396, 399, 359, 354, 355, 364, 377, 380, 384, 401, 404, 350, 362] } = {}) {
  const pairs = {}; const used = [];
  const base = new Mp2kRom(new Uint8Array(fs.readFileSync(romPath('sg'))));
  const plan = [...songs.map((x) => ({ song: x, patched: true })), ...natural.map((x) => ({ song: x, patched: false }))];
  for (const { song, patched } of plan) {
    const pp = patched ? patchWaveSong(new Uint8Array(fs.readFileSync(romPath('sg'))), base, song) : null;
    if (patched && !pp.waveVoices) continue;
    const rig = await openRig('sg', pp ? { patchRom: () => pp.bytes } : undefined);
    const sv = startSongVerified(rig, rig.base, song); if (!sv.ok) continue;
    const e = new SongEngine(rig.parsed, song, { sampleRate: 32768, dryRun: true, mixer: mixerOpts(rig) });
    const reg = [], mine = [];
    for (let f = 0; f < frames; f++) { rig.core.runFrame(); const v = rig.core.read16(0, 0x04000072); reg.push(((v >> 13) & 3) | ((v >> 15) & 1 ? 4 : 0)); }   // volume code; 4 = bit 15 'force 75%'
    for (let f = 0; f < frames; f++) { e._makeFrame(); const c = e.cgb[2]; mine.push(c ? c.vol : -1); }
    used.push(song);
    for (let f = 6; f < frames - 8; f++) {
      const v = mine[f]; if (v < 0) continue;
      let stable = true; for (let k = -2; k <= 2; k++) if (mine[f + k] !== v) { stable = false; break; }
      const c = reg[f + 1]; for (let k = -1; k <= 3; k++) if (reg[f + k] !== c) { stable = false; break; }
      if (stable) { const key = v + '->' + c; pairs[key] = (pairs[key] || 0) + 1; }
    }
  }
  return { pairs, songs: used };
}

/**
 * Is the real output mono? Plays each song through the game's own start call and counts the captured frames whose left and right int16 samples differ
 * (core.audio() at the core's own rate, no resampling involved). Returns [{ index, frames, differing, maxDiff, nonSilent }].
 */
export async function stereoCheck(which, songs, { seconds = 4 } = {}) {
  const rig = await openRig(which);
  const rows = [];
  for (const index of songs) {
    const sv = startSongVerified(rig, rig.base, index);
    if (!sv.ok) { rows.push({ index, error: 'start failed' }); continue; }
    const cap = captureFrames(rig.core, Math.round(seconds * FRAME_HZ));
    const all = new Int16Array(sv.pre.samples.length + cap.samples.length); all.set(sv.pre.samples); all.set(cap.samples, sv.pre.samples.length);
    let differing = 0, maxDiff = 0, loud = 0;
    for (let i = 0; i + 1 < all.length; i += 2) { const d = Math.abs(all[i] - all[i + 1]); if (d) differing++; if (d > maxDiff) maxDiff = d; if (Math.abs(all[i]) > 100) loud++; }
    rows.push({ index, frames: all.length / 2, differing, maxDiff, nonSilent: loud > 1000 });
  }
  return { rows, mixerMode: rig.mixer.mode };
}

/**
 * Square-wave pitch of every key 36..108 on the real engine. A synthetic song (one sq1 note per key, N24 + W24 at tempo 240) is written into free ROM space of an
 * in-memory COPY, the song-table entry of song 31 is pointed at it, the game plays it through its own start function, and the fundamental of each note is measured
 * from the core's native 65536 Hz output with a refined DFT. Returns [{ key, divisor (131072 / measured Hz), etDivisor (131072 / equal-tempered Hz) }].
 */
export async function keySweep(which = 'sg', { keys = null } = {}) {
  const KEYS = keys || Array.from({ length: 73 }, (_, i) => 36 + i);
  const base = new Mp2kRom(new Uint8Array(fs.readFileSync(romPath(which))));
  const SONG = 31; const hdr0 = base.song(SONG);
  let freeAt = -1; { const b = base.bytes; for (let o = b.length - 8192; o > b.length / 2; o -= 4096) { let ok = true; for (let i = 0; i < 4096; i += 4) if (b[o + i] !== 0xFF) { ok = false; break; } if (ok) { freeAt = o; break; } } }
  if (freeAt < 0) throw new Error('no free area in the ROM copy');
  const track = [0xBB, 120, 0xBD, 1, 0xBE, 100]; for (const k of KEYS) track.push(0xE7, k, 127, 0x98); track.push(0xB1);
  const patch = (b) => { const out = b.slice(); const dv = new DataView(out.buffer); const h = freeAt, t = freeAt + 16; out[h] = 1; out[h + 1] = 0; out[h + 2] = 5; out[h + 3] = 0; dv.setUint32(h + 4, 0x08000000 + hdr0.voicegroup, true); dv.setUint32(h + 8, 0x08000000 + t, true); for (let i = 0; i < track.length; i++) out[t + i] = track[i]; dv.setUint32(base.table.offset + 8 * SONG, 0x08000000 + h, true); return out; };
  const rig = await openRig(which, { patchRom: patch });
  const sv = startSongVerified(rig, rig.base, SONG); if (!sv.ok) throw new Error('key sweep: song start failed');
  const cap2 = captureFrames(rig.core, Math.round((KEYS.length * 0.2512 + 0.5) * FRAME_HZ));
  const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
  const sr = 65536, N = all.length / 2; const x = new Float32Array(N); for (let i = 0; i < N; i++) x[i] = (all[2 * i] + all[2 * i + 1]) / 65536;
  let lp = 0; const kk = 1 - Math.exp(-2 * Math.PI * 30 / sr); for (let i = 0; i < N; i++) { lp += (x[i] - lp) * kk; x[i] -= lp; }
  let on = 0; while (on < N && Math.abs(x[on]) < 0.01) on++;
  const refine = (st, len, f0) => { const w = new Float64Array(len); for (let i = 0; i < len; i++) w[i] = x[st + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / len)); const pw = (f) => { let re = 0, im = 0; const wv = 2 * Math.PI * f / sr; for (let i = 0; i < len; i++) { re += w[i] * Math.cos(wv * i); im += w[i] * Math.sin(wv * i); } return re * re + im * im; }; let best = 0, bf = f0; for (let f = f0 * 0.93; f <= f0 * 1.07; f += Math.max(0.25, f0 / 3000)) { const m = pw(f); if (m > best) { best = m; bf = f; } } return bf; };
  const rows = [];
  for (let i = 0; i < KEYS.length; i++) {
    const t0 = on + Math.round(i * (24 * 150 / (240 * FRAME_HZ)) * sr) + Math.round(0.03 * sr);
    if (t0 + 4096 > N) break;
    const fET = 440 * Math.pow(2, (KEYS[i] - 69) / 12);
    rows.push({ key: KEYS[i], divisor: 131072 / refine(t0, 4096, fET), etDivisor: 131072 / fET });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
function fmt(x, d = 3) { return typeof x === 'number' ? x.toFixed(d) : String(x); }
function printRow(r) {
  if (!r.ok) { console.log(`  ${r.which || ''} ${r.index ?? ''} ${r.checkpoint || ''}: NOT RUN - ${r.error}`); return; }
  console.log(`  ${r.which} song ${String(r.index).padStart(3)}${r.checkpoint ? ' (' + r.checkpoint + ')' : ''}  tracks=${r.tracks ?? '-'}  lag=${r.lagMs ?? r.refinedOffsetMs}ms  envCorr=${fmt(r.envCorr)} waveCorr=${fmt(r.waveCorr)} logSpec=${fmt(r.logSpec)} level=${fmt(r.levelRatio)} bandMaxAbs=${fmt(r.bandMaxAbs, 1)}dB onsetF1=${fmt(r.onset.f1, 2)}`);
  if (r.controlWrongSong) console.log(`        control wrong song ${r.controlWrongSong.index}: ${r.controlWrongSong.envCorr !== undefined ? `envCorr=${fmt(r.controlWrongSong.envCorr)} waveCorr=${fmt(r.controlWrongSong.waveCorr)} logSpec=${fmt(r.controlWrongSong.logSpec)} onsetF1=${fmt(r.controlWrongSong.onset.f1, 2)}` : `best waveCorr over lags=${fmt(r.controlWrongSong.bestWaveCorr3s)}`}`);
  if (r.controlTempo) console.log(`        control tempo x${r.controlTempo.tempoScale}: envCorr=${fmt(r.controlTempo.envCorr)} waveCorr=${fmt(r.controlTempo.waveCorr)} logSpec=${fmt(r.controlTempo.logSpec)} onsetF1=${fmt(r.controlTempo.onset.f1, 2)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const results = { when: new Date().toISOString(), node: process.version, load: os.loadavg ? os.loadavg() : null, cases: [] };
  console.log(`oracle run ${results.when}  node ${process.version}  loadavg ${JSON.stringify(results.load)}  cpus ${os.cpus().length}`);
  if (flag('--mixer')) {
    for (const w of Object.keys(ROMS)) { if (!romAvailable(w)) { console.log(`SKIP ${w}: ROM not found`); continue; } const m = await measureMixer(w); console.log(JSON.stringify(m)); results.cases.push({ mixer: m }); }
  } else if (flag('--stereo')) {
    // --stereo sg:805,350 uv:264,...   (default: every Ultra Violet music song and a few SoulGold ones)
    const which = opt('--rom', 'uv');
    const rigList = which === 'uv' ? (() => { const r0 = new Mp2kRom(new Uint8Array(fs.readFileSync(romPath('uv')))); const l = []; for (let i = 0; i < r0.songCount; i++) { const h = r0.song(i); if (!h.empty && h.player === 0) l.push(i); } return l; })() : [805, 350, 802];
    const res = await stereoCheck(which, rigList, { seconds: Number(opt('--seconds', 3)) });
    const bad = res.rows.filter((r) => r.differing > 0);
    console.log(`${which}: gSoundInfo.mode=${res.mixerMode}; ${res.rows.length} songs captured, ${res.rows.filter((r) => r.nonSilent).length} audible; songs with any L!=R sample: ${bad.length}`);
    for (const r of bad.slice(0, 12)) console.log(`  song ${r.index}: ${r.differing} of ${r.frames} frames differ (max |L-R| ${r.maxDiff})`);
    results.cases.push({ stereo: res });
  } else if (flag('--key-sweep')) {
    const rows = await keySweep('sg');
    const hi = rows.filter((r) => r.key >= 56); const disc = hi.filter((r) => Math.ceil(r.etDivisor - 1e-9) !== Math.round(r.etDivisor));
    console.log(`square pitch on the real engine, keys ${rows[0].key}..${rows[rows.length - 1].key}: measured divisor == ceil(131072/f) on ${hi.filter((r) => Math.round(r.divisor) === Math.ceil(r.etDivisor - 1e-9)).length} of ${hi.length} keys >= 56; of the ${disc.length} keys where ceil and round differ: ceil ${disc.filter((r) => Math.round(r.divisor) === Math.ceil(r.etDivisor - 1e-9)).length}, round ${disc.filter((r) => Math.round(r.divisor) === Math.round(r.etDivisor)).length}`);
    results.cases.push({ keySweep: rows });
  } else if (flag('--wave-map')) {
    const p = await waveMap(); console.log('wave channel (settled frames; patched copies and natural songs ' + p.songs.join(',') + '): synth envelope value -> oracle SOUND3CNT_H volume code (1=100%, 2=50%, 3=25%, 4=75% via bit 15, 0=mute):'); const by = {}; for (const [k, n] of Object.entries(p.pairs)) { const [v, c] = k.split('->'); (by[v] = by[v] || []).push('code' + c + ':' + n); } for (const v of Object.keys(by).sort((x, y) => x - y)) console.log('  env ' + v + ' -> ' + by[v].join(' ')); results.cases.push({ waveMap: p });
  } else {
    const quick = flag('--quick');
    let plan = { sg: quick ? [802, 805] : [802, 805, 350, 362, 399], uv: quick ? [321] : [321, 264] };
    const songsArg = argv.indexOf('--songs');
    if (songsArg >= 0) { plan = { sg: [], uv: [] }; for (const t of argv.slice(songsArg + 1)) { if (t.startsWith('--')) break; const [w, l] = t.split(':'); plan[w] = l.split(',').map(Number); } }
    for (const w of Object.keys(plan)) {
      if (!plan[w].length) continue;
      if (!romAvailable(w)) { console.log(`SKIP ${w}: ROM not found at ${romPath(w)}`); continue; }
      const rig = await openRig(w);
      console.log(`${ROMS[w].name}: mixer maxChans=${rig.mixer.maxChans} masterVol=${rig.mixer.masterVol} pcmFreq=${rig.mixer.pcmFreq}  base ${rig.cfg.silent ? 'silenced in ' + rig.baseInfo.silentFrames + ' frames' : 'frame ' + rig.cfg.baseFrame}`);
      for (const idx of plan[w]) { const r = await compareSong(rig, idx, { seconds: Number(opt('--seconds', 8)) }); results.cases.push(r); printRow(r); }
      // sound effects (PSG-only or short): one control-free capture each
      if (w === 'sg' && !quick && songsArg < 0) { for (const idx of [4, 10, 16, 31, 35, 56]) { const r = await compareSong(rig, idx, { seconds: 2.5, controls: true }); results.cases.push(r); printRow(r); } }
    }
    if ((flag('--natural') || (!quick && songsArg < 0)) && romAvailable('sg')) {
      for (const ck of ['CK_BATTLE_INTRO', 'CK_WILD_INTRO']) { const r = await compareNatural(ck, { seconds: 8 }); results.cases.push(r); printRow(r); }
    }
  }
  const out = opt('--json', null);
  if (out) { fs.writeFileSync(out, JSON.stringify(results, null, 1)); console.log('wrote ' + out); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((e) => { console.error(e); process.exit(1); });
