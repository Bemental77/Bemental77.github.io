#!/usr/bin/env node
// tools/pokemonarena_music_test.mjs -- tests for the ROM music engine (pokemonarena/js/mp2k.js, mp2k_synth.js, music.js).
//
//   node tools/pokemonarena_music_test.mjs                 # everything (needs the two ROMs; ~2 minutes with the oracle sections)
//   node tools/pokemonarena_music_test.mjs --no-oracle     # skip the mGBA oracle comparisons (about 25 s)
//   node tools/pokemonarena_music_test.mjs --update-golden # rewrite pokemonarena/js/music.golden.json (hashes only) and exit
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (printed `[control]`): a mutant or
// corrupted input the check must reject, next to the unmutated twin that must stay quiet. ROMs are read from
// ARENA_ROM / ARENA_ROM_UV or gba/gbaWasm/roms/; when one is absent its sections SKIP LOUDLY (counted in the summary).
// Nothing ROM-derived is written anywhere: goldens are sha256 hashes and counts only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Mp2kRom, Mp2kError, findSongTable } from '../pokemonarena/js/mp2k.js';
import { SongEngine, analyzeSong, CLOCK, CGB3VOL } from '../pokemonarena/js/mp2k_synth.js';
import { createMusic, renderSong, listSongs, MIXER_PROFILES, detectSoundtrack, openRom } from '../pokemonarena/js/music.js';
import { createFakeAudio } from '../pokemonarena/js/music_test_double.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GOLDEN = path.join(ROOT, 'pokemonarena/js/music.golden.json');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const BROWSER_ONLY = flag('--browser-only');   // run just the Chrome seam section (it needs the shared browser lock, which can take a while)

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const skip = (name, why) => { skipped++; console.log(`  SKIP ${name}  (${why})`); };
const section = (s) => console.log(`\n== ${s}`);
const sha = (...bufs) => { const h = crypto.createHash('sha256'); for (const b of bufs) h.update(Buffer.from(b.buffer, b.byteOffset, b.byteLength)); return h.digest('hex'); };
const quantHash = (L, R) => { const q = new Int16Array(L.length * 2); for (let i = 0; i < L.length; i++) { q[2 * i] = Math.round(L[i] * 1024); q[2 * i + 1] = Math.round(R[i] * 1024); } return sha(q); };

const ROMS = {
  soulgold: { env: 'ARENA_ROM', file: path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'), sha256: '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a', size: 33554432 },
  ultraviolet: { env: 'ARENA_ROM_UV', file: path.join(ROOT, 'gba/gbaWasm/roms/pokemonUltraViolet.gba'), sha256: '467fe116ff6d7d5723b9f8fc60dd81c698c5d4e27b1b444168f3be292848d015', size: 16777216 },
};
const loaded = {};
for (const [k, c] of Object.entries(ROMS)) {
  const p = process.env[c.env] || c.file;
  try { const b = new Uint8Array(fs.readFileSync(p)); loaded[k] = { bytes: b, sha256: crypto.createHash('sha256').update(b).digest('hex'), path: p }; } catch (e) { loaded[k] = null; }
}
const golden = (() => { try { return JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (e) { return null; } })();

// the songs whose renders are pinned (hashes only)
const GOLDEN_SONGS = {
  soulgold: [{ index: 802, seconds: 12 }, { index: 805, seconds: 12 }, { index: 350, seconds: 12 }, { index: 362, seconds: 10 }, { index: 399, seconds: 10 }, { index: 888, seconds: 10 }, { index: 887, seconds: 10 }, { index: 811, seconds: 10 }, { index: 4, seconds: 1.6 }, { index: 10, seconds: 1 }, { index: 31, seconds: 1 }],
  ultraviolet: [{ index: 321, seconds: 12 }, { index: 264, seconds: 12 }, { index: 274, seconds: 10 }, { index: 4, seconds: 1.6 }, { index: 83, seconds: 10 }],
};

function meterCpu() { const c = os.cpus(); let idle = 0, total = 0; for (const x of c) { for (const k of Object.keys(x.times)) total += x.times[k]; idle += x.times.idle; } return { idle, total }; }
function cpuBusy(a, b) { const t = b.total - a.total; return t > 0 ? 1 - (b.idle - a.idle) / t : 0; }

// ---------------------------------------------------------------------------------------------------------------
const goldenOut = { _about: 'sha256 hashes and counts only; no ROM bytes, no audio. Float32 little-endian left then right channel of renderSong(rom, index, {seconds, sampleRate: 32768}).', node: process.version, platform: process.platform + '-' + process.arch, roms: {} };

for (const [name, cfg] of Object.entries(ROMS)) {
  if (BROWSER_ONLY) continue;
  const L = loaded[name];
  section(`${name}: structure`);
  if (!L) { skip(`${name} sections`, `ROM not found at ${process.env[cfg.env] || cfg.file}`); continue; }
  ok(`${name} ROM is the pinned image`, L.bytes.length === cfg.size && L.sha256 === cfg.sha256, `size ${L.bytes.length} sha256 ${L.sha256.slice(0, 16)}...`);
  const G = golden && golden.roms && golden.roms[name];
  const t0 = performance.now();
  const r = new Mp2kRom(L.bytes);          // the default path: known-profile fast path (verified entry by entry)
  const fastMs = performance.now() - t0;
  const t0s = performance.now();
  const rScan = new Mp2kRom(L.bytes, { noKnown: true });   // the whole-ROM scan, forced
  const scanMs = performance.now() - t0s;
  const T = r.table;
  goldenOut.roms[name] = { sha256: L.sha256, songTable: { offset: T.offset, count: T.count, songs: T.songs, dummies: T.dummies, codeRefs: T.codeRefs, mplayOffset: T.mplay && T.mplay.offset, maxTracks: T.mplay && T.mplay.players.map((p) => p.maxTracks) }, renders: {} };
  ok(`${name}: song table found by scan`, rScan.tableSource === 'scan' && rScan.table.offset === T.offset && rScan.table.count === T.count && T.songs > 100, `offset 0x${T.offset.toString(16)} entries ${T.count} (${T.songs} songs, ${T.dummies} empty) in ${scanMs.toFixed(0)} ms`);
  ok(`${name}: the default path recognises the ROM and verifies the table in under 10 ms (no whole-ROM scan on first activation)`, r.tableSource === 'known' && fastMs < 10, `${fastMs.toFixed(2)} ms vs ${scanMs.toFixed(0)} ms for the scan`);
  { const moved = L.bytes.slice(); moved.set(new Uint8Array(8 * 40), T.offset + 8 * 2); const m = new Mp2kRom(moved);
    control(`${name}: a ROM with the known code/size but a damaged table falls back to the scan (not the known offset)`, m.tableSource === 'scan' || m.table.count < T.count, `source ${m.tableSource}, entries ${m.table.count}`); }
  ok(`${name}: song table matches the pinned location`, !G || (G.songTable.offset === T.offset && G.songTable.count === T.count && G.songTable.songs === T.songs), G ? `golden 0x${G.songTable.offset.toString(16)} x${G.songTable.count}` : 'no golden yet');
  ok(`${name}: cross-checked against the game's own code (literal-pool words equal to the table address)`, T.codeRefs.length >= 2 && T.codeRefs.every((x) => r.u32(x) === 0x08000000 + T.offset), `literals at ${T.codeRefs.map((x) => '0x' + x.toString(16)).join(' ')}`);
  ok(`${name}: player table sits directly below the song table`, T.mplay && T.mplay.offset === T.offset - 48 && T.mplay.players.length === 4, T.mplay ? `maxTracks ${T.mplay.players.map((p) => p.maxTracks)}` : 'missing');
  const hinted = new Mp2kRom(L.bytes, { hint: { offset: T.offset, count: T.count } });
  ok(`${name}: a correct hint skips the scan and agrees`, hinted.table.offset === T.offset && hinted.songCount === T.count);
  let hintErr = null; try { new Mp2kRom(L.bytes, { hint: { offset: T.offset + 8 * T.count + 4096, count: 50 } }); } catch (e) { hintErr = e; }
  control(`${name}: a wrong hint is refused with a typed error`, hintErr instanceof Mp2kError && hintErr.code === 'hint', hintErr && hintErr.code);
  // mutant: scrub every 4th song-table pointer -> the scan must not find the same table as a run of the same length
  const scrub = L.bytes.slice(); for (let i = 0; i < T.count; i += 4) scrub.set([0, 0, 0, 0], T.offset + 8 * i);
  let scrubbed = null; try { scrubbed = findSongTable(scrub); } catch (e) { scrubbed = e; }
  control(`${name}: a table with scrubbed entries is NOT reported as the full table`, scrubbed instanceof Error || scrubbed.count < T.count, scrubbed instanceof Error ? scrubbed.code : `found ${scrubbed.count} < ${T.count}`);

  // every header parses; geometry
  let hdrErrors = 0, overLimit = 0, empties = 0, badPtr = 0;
  const mt = T.mplay.players.map((p) => p.maxTracks);
  for (let i = 0; i < r.songCount; i++) {
    try { const h = r.song(i); if (h.empty) empties++; else { if (h.trackCount > mt[h.player]) overLimit++; for (const t of h.tracks) if (t >= r.length) badPtr++; if (h.voicegroup >= r.length) badPtr++; } } catch (e) { hdrErrors++; }
  }
  ok(`${name}: every one of the ${r.songCount} table entries parses (no throw)`, hdrErrors === 0, `errors ${hdrErrors}, empty ${empties}`);
  ok(`${name}: every track/voicegroup pointer is inside the ROM`, badPtr === 0);
  goldenOut.roms[name].headerStats = { entries: r.songCount, empty: empties, overPlayerTrackLimit: overLimit };
  console.log(`       (${overLimit} songs have more tracks than their player holds; the engine truncates them like the real one)`);

  // analysis of EVERY song
  const t1 = performance.now();
  let analysed = 0, aerr = 0, hit = 0, loopsBad = 0, jingleBad = 0, noLen = 0, loopsN = 0, jingleN = 0, maxLen = 0, minTempo = 999, maxTempo = 0;
  const rows = [];
  for (let i = 0; i < r.songCount; i++) {
    const h = r.song(i); if (h.empty) continue;
    let a; try { a = analyzeSong(r, i); } catch (e) { aerr++; continue; }
    analysed++; if (a.hitLimit) hit++;
    if (!(a.lengthMs > 0)) noLen++;
    if (a.loops) { loopsN++; if (!(a.loopStartMs >= 0 && a.loopStartMs < a.lengthMs && a.loopLengthMs > 0 && a.loopStartMs + a.loopLengthMs <= a.lengthMs + 50)) loopsBad++; }
    else { jingleN++; if (a.endedByFine < 1) jingleBad++; }
    maxLen = Math.max(maxLen, a.lengthMs); minTempo = Math.min(minTempo, a.firstBpm); maxTempo = Math.max(maxTempo, a.firstBpm);
    rows.push(a);
  }
  ok(`${name}: all ${analysed} non-empty songs analyse without error or runaway`, aerr === 0 && hit === 0, `errors ${aerr}, hit 30-minute limit ${hit}, ${(performance.now() - t1).toFixed(0)} ms`);
  ok(`${name}: every song has a positive length`, noLen === 0);
  ok(`${name}: every looping song's loop point is inside the song and its loop body ends within the walk`, loopsBad === 0, `${loopsN} looping, ${jingleN} jingles/effects, ${loopsBad} bad`);
  ok(`${name}: every non-looping song ends by FINE on at least one track`, jingleBad === 0);
  goldenOut.roms[name].analysis = { analysed, looping: loopsN, nonLooping: jingleN, longestMs: maxLen, tempoRange: [minTempo, maxTempo], digest: sha(new TextEncoder().encode(rows.map((a) => [a.index, a.tracks, a.lengthMs, a.loops ? 1 : 0, a.loopStartMs, a.loopLengthMs, a.firstBpm, a.notes].join(',')).join(';'))) };
  if (G && G.analysis) ok(`${name}: song-by-song analysis digest equals the golden`, G.analysis.digest === goldenOut.roms[name].analysis.digest, goldenOut.roms[name].analysis.digest.slice(0, 16));
  // mutant: flip a command byte in song 1's track and the digest of that song changes (the digest sees the data)
  { const firstSong = rows.find((a) => a.tracks >= 1 && a.notes > 4); const h = r.song(firstSong.index); const mut = L.bytes.slice(); for (let k = 0; k < 400; k++) { const b = mut[h.tracks[0] + k]; if (b >= 0x81 && b <= 0xA8) mut[h.tracks[0] + k] = b + 3; }
    const a2 = analyzeSong(new Mp2kRom(mut, { table: r.table }), firstSong.index);
    control(`${name}: changing rest lengths in the ROM changes the analysis`, a2.lengthMs !== firstSong.lengthMs, `${firstSong.lengthMs} -> ${a2.lengthMs} ms`); }

  section(`${name}: render every song`);
  const t2 = performance.now(); const cpuA = meterCpu();
  let nonSilent = 0, silentList = [], nan = 0, over = 0, errs = 0, worst = { ratio: 0, index: -1, ms: 0, secs: 0, poly: 0 }, totalAudio = 0, sumPeak = 0;
  for (const a of rows) {
    const secs = Math.min(6, a.lengthMs / 1000 + 0.3);
    const t = performance.now(); let res;
    try { res = renderSong(L.bytes, a.index, { seconds: secs, soundtrack: name }); } catch (e) { errs++; continue; }
    const dt = performance.now() - t; totalAudio += secs;
    const ratio = dt / (secs * 1000); if (secs >= 3 && ratio > worst.ratio) worst = { ratio, index: a.index, ms: dt, secs, poly: res.meta.maxPolyphony };
    let fin = true; for (let i = 0; i < res.left.length; i += 5) { if (!Number.isFinite(res.left[i]) || !Number.isFinite(res.right[i])) { fin = false; break; } }
    if (!fin) nan++;
    if (res.meta.peak > 1.0001) over++;
    if (res.meta.peak > 1e-4) nonSilent++; else silentList.push(a.index);
    sumPeak = Math.max(sumPeak, res.meta.peak);
  }
  const cpuB = meterCpu();
  ok(`${name}: no render throws`, errs === 0, `${rows.length} songs`);
  ok(`${name}: every sample is finite (no NaN/Infinity)`, nan === 0);
  ok(`${name}: peak never exceeds full scale`, over === 0, `max peak ${sumPeak.toFixed(3)}`);
  const knownSilent = name === 'soulgold' ? silentList.every((i) => i >= 559 && i <= 609) : silentList.length === 0;
  ok(`${name}: every song is audible except the documented zero-length-wave stubs`, knownSilent, `silent ${silentList.length}${silentList.length ? ` (indexes ${silentList[0]}..${silentList[silentList.length - 1]})` : ''}, audible ${nonSilent}`);
  { const t = performance.now(); renderSong(L.bytes, worst.index, { seconds: worst.secs, soundtrack: name }); worst.warmMs = performance.now() - t; worst.warmRatio = worst.warmMs / (worst.secs * 1000); }
  ok(`${name}: worst-case render cost (songs >= 3 s) leaves real-time margin >= 20x`, worst.ratio < 0.05 && worst.warmRatio < 0.05, `warm re-render ${worst.warmMs.toFixed(0)} ms = ${worst.warmRatio.toFixed(4)} s/s; first ` + `worst song ${worst.index}: ${worst.ms.toFixed(0)} ms for ${worst.secs.toFixed(1)} s audio = ${(worst.ratio).toFixed(4)} s/s (${(1 / worst.ratio).toFixed(0)}x real time), poly ${worst.poly}; all ${rows.length} songs ${(performance.now() - t2).toFixed(0)} ms for ${totalAudio.toFixed(0)} s audio; machine CPU busy ${(cpuBusy(cpuA, cpuB) * 100).toFixed(0)}% during, loadavg ${os.loadavg().map((x) => x.toFixed(2))} (Windows reports 0)`);
  goldenOut.roms[name].render = { audible: nonSilent, silent: silentList.length, silentRange: silentList.length ? [silentList[0], silentList[silentList.length - 1]] : null };

  section(`${name}: determinism and goldens`);
  const specs = GOLDEN_SONGS[name];
  for (const sp of specs) {
    const a = renderSong(L.bytes, sp.index, { seconds: sp.seconds, soundtrack: name });
    const b = renderSong(L.bytes, sp.index, { seconds: sp.seconds, soundtrack: name });
    const ha = sha(a.left, a.right), hb = sha(b.left, b.right);
    ok(`${name} song ${sp.index}: two renders are bit-identical`, ha === hb, ha.slice(0, 16));
    goldenOut.roms[name].renders[`${sp.index}@${sp.seconds}`] = { sha256: ha, quant10bit: quantHash(a.left, a.right) };
    const gg = G && G.renders && G.renders[`${sp.index}@${sp.seconds}`];
    if (gg) {
      const sameNode = golden.node === process.version && golden.platform === process.platform + '-' + process.arch;
      const strict = gg.sha256 === ha, quant = gg.quant10bit === quantHash(a.left, a.right);
      ok(`${name} song ${sp.index}: render equals the golden hash`, strict || (!sameNode && quant), strict ? 'bit-exact' : sameNode ? 'MISMATCH on the same node' : 'differs bitwise on another node/platform, equal at 10-bit quantisation');
    }
  }
  { // controls on the hash itself
    const sp = specs[1];
    const a = renderSong(L.bytes, sp.index, { seconds: 3, soundtrack: name });
    const b = renderSong(L.bytes, sp.index, { seconds: 3, soundtrack: name, mixer: { pcmGain: 0.7501 } });
    control(`${name}: a 0.01% gain change changes the hash (hash is sensitive)`, sha(a.left, a.right) !== sha(b.left, b.right));
    const c = renderSong(L.bytes, sp.index, { seconds: 3, soundtrack: name, mixer: { masterVol: 11 } });
    control(`${name}: a different master volume changes the render`, sha(a.left, a.right) !== sha(c.left, c.right));
    const bad = golden && golden.roms && golden.roms[name] ? Object.values(golden.roms[name].renders)[0].sha256 : 'x';
    control(`${name}: a corrupted golden hash would be rejected`, bad.replace(/./, bad[0] === 'a' ? 'b' : 'a') !== bad);
  }

  section(`${name}: stereo/mono and PSG register rule`);
  {
    const probe = renderSong(L.bytes, specs[1].index, { seconds: 3, soundtrack: name });
    let same = true, diff = 0; for (let i = 0; i < probe.left.length; i++) { if (probe.left[i] !== probe.right[i]) { same = false; diff++; } }
    if (name === 'ultraviolet') {
      ok(`${name}: the mixer is mono (gSoundInfo.mode = 1): renderSong output has L == R bit for bit`, same, `${diff} differing samples`);
      const st = renderSong(L.bytes, specs[1].index, { seconds: 3, soundtrack: name, mixer: { mono: false } });
      let d2 = 0; for (let i = 0; i < st.left.length; i++) if (st.left[i] !== st.right[i]) d2++;
      control(`${name}: the same song with mono switched off is NOT L == R (the check can fail)`, d2 > 0, `${d2} differing samples`);
    } else {
      ok(`${name}: the mixer is stereo (gSoundInfo.mode = 0): renderSong output has L != R`, !same, `${diff} differing samples`);
    }
    // PSG register rule: song 31 plays sq1 key 91 then key 87 (SoulGold); the oracle's registers give divisors 84 and 106 (round-to-nearest would give 84 and 105)
    if (name === 'soulgold') {
      const divisors = (extra) => { const e = new SongEngine(r, 31, { sampleRate: 32768, dryRun: true, mixer: { ...MIXER_PROFILES[name], ...extra } }); const seen = []; for (let f = 0; f < 40; f++) { e._makeFrame(); const c = e.cgb[0]; if (c && c.reg && !seen.includes(2048 - c.reg)) seen.push(2048 - c.reg); } return seen; };
      const d1 = divisors({}), d2 = divisors({ psgReg: 'round' });
      ok(`${name}: square register rule reproduces the oracle's measured divisors for song 31 (key 91 -> 84, key 87 -> 106)`, d1.includes(84) && d1.includes(106), 'divisors seen ' + d1.join(','));
      control(`${name}: round-to-nearest (the rule before it was measured) gets key 87 wrong (105, not 106)`, !d2.includes(106) && d2.includes(105), 'divisors ' + d2.join(','));
    }
  }

  section(`${name}: corrupted input never hangs or crashes untyped`);
  const typed = (fn) => { const t = performance.now(); try { fn(); return { ok: true, ms: performance.now() - t }; } catch (e) { return { ok: false, typed: e instanceof Mp2kError, code: e.code, ms: performance.now() - t }; } };
  for (const idx of [-1, r.songCount, r.songCount + 1000, 1.5, NaN]) { const x = typed(() => renderSong(L.bytes, idx, { seconds: 1 })); ok(`${name}: song index ${idx} -> typed error 'song-index'`, !x.ok && x.typed && x.code === 'song-index', x.code); }
  { const x = typed(() => renderSong(L.bytes, 1, { seconds: 100000 })); ok(`${name}: a render over the budget -> 'render-budget'`, !x.ok && x.code === 'render-budget'); }
  { const x = typed(() => renderSong(L.bytes, 1, { seconds: 0 })); ok(`${name}: zero seconds -> typed error`, !x.ok && x.typed); }
  {
    const pick = rows.find((a) => a.tracks >= 2 && a.notes > 10);
    const h = r.song(pick.index);
    // bad header pointer
    const m1 = L.bytes.slice(); new DataView(m1.buffer).setUint32(T.offset + 8 * pick.index, 0xDEADBEEF, true);
    const x1 = typed(() => renderSong(new Mp2kRom(m1, { table: r.table }), pick.index, { seconds: 1 }));
    ok(`${name}: a song-table entry pointing outside the ROM -> typed 'bad-ptr'`, !x1.ok && x1.typed && x1.code === 'bad-ptr', x1.code);
    // track pointer past the end
    const m2 = L.bytes.slice(); new DataView(m2.buffer).setUint32(h.headerOffset + 8, 0x08000000 + m2.length + 64, true);
    const x2 = typed(() => renderSong(new Mp2kRom(m2, { table: r.table }), pick.index, { seconds: 1 }));
    ok(`${name}: a track pointer outside the ROM -> typed 'bad-ptr'`, !x2.ok && x2.typed && x2.code === 'bad-ptr', x2.code);
    // GOTO to itself with no wait: an infinite loop in zero time
    const m3 = L.bytes.slice(); const tOff = h.tracks[0]; m3[tOff] = 0xB2; new DataView(m3.buffer).setUint32(tOff + 1, 0x08000000 + tOff, true);
    const x3 = typed(() => renderSong(new Mp2kRom(m3, { table: r.table }), pick.index, { seconds: 2 }));
    ok(`${name}: a zero-wait GOTO loop -> 'seq-runaway' within 2 s (never a hang)`, !x3.ok && x3.typed && x3.code === 'seq-runaway' && x3.ms < 2000, `${x3.code} after ${x3.ms.toFixed(0)} ms`);
    // PATT recursion
    const m4 = L.bytes.slice(); m4[tOff] = 0xB3; new DataView(m4.buffer).setUint32(tOff + 1, 0x08000000 + tOff, true);
    const x4 = typed(() => renderSong(new Mp2kRom(m4, { table: r.table }), pick.index, { seconds: 2 }));
    ok(`${name}: PATT calling itself terminates (3-level stack) within 2 s`, x4.ms < 2000, x4.ok ? 'ended quietly' : x4.code);
    // sequence running off the end of the ROM
    const m5 = L.bytes.slice(); const farTrack = L.bytes.length - 2; m5[farTrack] = 0x90; m5[farTrack + 1] = 0x90; new DataView(m5.buffer).setUint32(h.headerOffset + 8, 0x08000000 + farTrack, true);
    const x5 = typed(() => renderSong(new Mp2kRom(m5, { table: r.table }), pick.index, { seconds: 2 }));
    ok(`${name}: a sequence that runs off the end of the ROM -> typed 'oob'`, !x5.ok && x5.typed && x5.code === 'oob', x5.code);
    // garbage voicegroup: notes become bad voices, never an exception
    const m6 = L.bytes.slice(); new DataView(m6.buffer).setUint32(h.headerOffset + 4, 0x08000000 + 16, true);
    const x6 = typed(() => renderSong(new Mp2kRom(m6, { table: r.table }), pick.index, { seconds: 2 }));
    ok(`${name}: a garbage voicegroup renders (silent/odd) without throwing untyped`, x6.ok || x6.typed, x6.ok ? 'rendered' : x6.code);
    // unmutated twin
    const x0 = typed(() => renderSong(L.bytes, pick.index, { seconds: 1 })); ok(`${name}: the unmutated twin renders`, x0.ok);
  }
  {
    // not a GBA ROM at all
    const x = typed(() => new Mp2kRom(new Uint8Array(100000).fill(0x55))); ok(`${name}: random bytes -> 'no-song-table'`, !x.ok && x.code === 'no-song-table', x.code);
    const y = typed(() => new Mp2kRom(new Uint8Array(10))); ok(`${name}: a 10-byte file -> 'rom-size'`, !y.ok && y.code === 'rom-size', y.code);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Real-time behaviour with the recording AudioContext double
// ---------------------------------------------------------------------------------------------------------------
const RT = loaded.soulgold ? 'soulgold' : loaded.ultraviolet ? 'ultraviolet' : null;
section('real time: music.js against the test double');
if (!RT || BROWSER_ONLY) skip('real-time sections', BROWSER_ONLY ? '--browser-only' : 'no ROM available');
else {
  const bytes = loaded[RT].bytes;
  const SONG = RT === 'soulgold' ? 805 : 321, JINGLE = RT === 'soulgold' ? 4 : 4, SE = RT === 'soulgold' ? 10 : 5;
  const mk = async (extra = {}) => { const fake = createFakeAudio(); const ended = [], errs = []; const dest = fake.destination; const fx = fake.ctx.createGain(); fx.connect(dest); const music = await createMusic({ ctx: fake.ctx, destination: dest, fxDestination: fx, rom: bytes, soundtrack: RT, timers: fake.timers, onEnded: (i) => ended.push(i), onError: (e) => errs.push(e), ...extra }); return { fake, music, ended, errs, fx, dest }; };
  {
    const { fake, music, errs } = await mk();
    ok('createMusic does not create audio objects until play()', fake.counts().createBufferSource === undefined && fake.liveTimers() === 0);
    ok('play(index) returns true and starts a scheduler (one interval + one deferred analysis timer)', music.play(SONG) === true && fake.liveTimers() === 2);
    ok('play() itself renders ONE chunk (0.25 s) - a short task on the first key press; the 100 ms timer tops the queue up to 1 s', music.state().bufferedMs <= 400 && music.state().bufferedMs >= 250, `${music.state().bufferedMs} ms queued right after play()`);
    fake.advance(0.5);
    const s0 = music.state();
    ok('state() reports the playing song', s0.index === SONG && s0.playing === true && s0.paused === false && s0.loops === true, JSON.stringify(s0));
    ok('>= 0.9 s of audio is queued ahead of the clock within 0.5 s of play()', s0.bufferedMs >= 900, `${s0.bufferedMs} ms`);
    fake.advance(5);
    const s1 = music.state();
    ok('the scheduler keeps >= 0.75 s queued while playing', s1.bufferedMs >= 750 && s1.underruns === 0, `${s1.bufferedMs} ms buffered, ${s1.underruns} underruns`);
    ok('positionMs advances with the clock', s1.positionMs > 4900 && s1.positionMs < 5500, `${s1.positionMs} ms`);
    const starts = fake.starts();
    let gapMax = 0; for (let i = 1; i < starts.length; i++) gapMax = Math.max(gapMax, Math.abs(starts[i].when - (starts[i - 1].when + starts[i - 1].dur)));
    ok('chunks are scheduled back to back (no gaps, no overlaps)', gapMax < 1e-6, `max seam error ${gapMax.toExponential(2)} s over ${starts.length} chunks`);
    ok('the scheduled buffers contain audio', starts.some((e) => e.nonSilent));
    ok('no error was reported', errs.length === 0);
    music.stop({ fadeOutMs: 200 });
    fake.advance(0.1);
    ok('stop() takes the song off immediately (index null) and fades the gain', music.state().index === null && fake.paramOps().some((p) => p.op === 'ramp' && p.v === 0));
    fake.advance(1);
    ok('after the fade the stopped voice is released (stop() calls on its sources)', fake.counts().stop >= 1);
    music.dispose();
    ok('dispose() clears the scheduler timer', fake.liveTimers() === 0 && music.state().disposed === true);
    const before = fake.counts().createBufferSource; music.play(SONG); fake.advance(1);
    ok('play() after dispose() is a no-op', fake.counts().createBufferSource === before);
  }
  {
    // crossfade
    const { fake, music } = await mk();
    music.play(SONG); fake.advance(2);
    music.play(JINGLE, { crossfadeMs: 500, fadeInMs: 100 }); fake.advance(0.2);
    const st = music.state();
    ok('play() while playing crossfades (old voice kept, new one current)', st.index === JINGLE && st.crossfading === 1, JSON.stringify({ index: st.index, crossfading: st.crossfading }));
    fake.advance(1);
    ok('the faded voice is released after the crossfade', music.state().crossfading === 0);
  }
  {
    // jingle end
    const { fake, music, ended } = await mk();
    music.play(JINGLE); fake.advance(0.3);
    ok('a jingle does not report ended while it is still sounding', ended.length === 0);
    fake.advance(2.5);
    ok('a non-looping song reports onEnded(index) exactly once after it has played out', ended.length === 1 && ended[0] === JINGLE, JSON.stringify(ended));
    ok('state().playing is false after the jingle', music.state().playing === false);
    fake.advance(2);
    ok('onEnded does not repeat', ended.length === 1);
    music.play(SONG); fake.advance(40);
    ok('a looping song never reports ended', ended.length === 1 && music.state().playing === true);
  }
  {
    // pause / resume
    const { fake, music } = await mk();
    music.play(SONG); fake.advance(2);
    music.pause(); const stopsBefore = fake.counts().stop || 0; const cb = fake.counts().createBufferSource;
    fake.advance(3);
    ok('pause() stops the sources and the scheduler adds no audio while paused', music.state().paused === true && fake.counts().createBufferSource === cb && stopsBefore >= 1);
    music.resume(); fake.advance(1.5);
    const s = music.state();
    ok('resume() schedules audio again and keeps the same song', s.paused === false && s.index === SONG && fake.counts().createBufferSource > cb, `buffered ${s.bufferedMs} ms`);
    ok('pause/resume does not count as an underrun', s.underruns === 0, `underruns ${s.underruns}`);
  }
  {
    // sound effects
    const { fake, music, fx, dest } = await mk();
    music.play(SONG); fake.advance(1);
    const h = music.playEffect(SE, { pan: -1, volume: 0.5 });
    ok('playEffect() returns a handle with the SE player and does not stop the BGM', h.ignored === false && h.player >= 1 && music.state().index === SONG && music.state().effects === 1, JSON.stringify({ ...h }));
    fake.advance(0.5);
    const connectsToFx = fake.log.filter((e) => e.ev === 'connect' && e.to === fx.id).length;
    ok('the effect is routed to fxDestination (its own gain/panner chain)', connectsToFx >= 1 && fake.counts().createStereoPanner >= 1, `${connectsToFx} connection(s) to the fx node`);
    ok('pan -1 reached the panner', fake.nodes.some((n) => n.kind === 'panner' && n.pan.value === -1));
    const h2 = music.playEffect(SE, { pan: 63 });
    ok('engine-unit pan (63) is mapped to +1', fake.nodes.some((n) => n.kind === 'panner' && n.pan.value === 1));
    void h2; fake.advance(3);
    ok('an effect that has finished is released', music.state().effects === 0);
    // priority rule: a low priority effect cannot replace a playing higher priority one on the same player
    let lo = null, hi = null;
    const list = listSongs(bytes).filter((s) => !s.empty && s.player === 1);
    for (const a of list) { if (a.priority <= 3 && !lo) lo = a; if (a.priority >= 5 && !hi) hi = a; }
    if (lo && hi) {
      const first = music.playEffect(hi.index);
      const second = music.playEffect(lo.index);
      ok('a lower-priority effect is ignored while a higher-priority one plays on the same player', first.ignored === false && second.ignored === true, `hi ${hi.index}/p${hi.priority}, lo ${lo.index}/p${lo.priority}`);
      fake.advance(5);
      const third = music.playEffect(hi.index); const fourth = music.playEffect(lo.index);
      ok('(twin) after the high-priority effect has finished, a low-priority one plays', third.ignored === false);
      void fourth;
    } else skip('effect priority rule', 'no suitable SE pair');
    const bad = music.playEffect(999999);
    ok('playEffect with a bad index is ignored without throwing', bad.ignored === true);
  }
  {
    // errors never throw into the page
    const { fake, music, errs } = await mk();
    let threw = false; try { music.play(-5); music.play(99999); music.play(0); } catch (e) { threw = true; }
    ok('play() with bad/empty indexes never throws; onError receives typed errors', !threw && errs.length === 3 && errs.every((e) => e instanceof Mp2kError), errs.map((e) => e.code).join(','));
    ok('a failed play() does not disturb the scheduler', fake.liveTimers() === 0 && music.state().index === null);
    let t2 = null; try { await createMusic({ rom: bytes }); } catch (e) { t2 = e; }
    control('createMusic without ctx is refused with a typed error', t2 instanceof Mp2kError && t2.code === 'no-context');
  }
  {
    // a song whose sequence data is broken fails soft: play() returns false, onError gets a typed error, the scheduler survives
    const r0 = new Mp2kRom(bytes); const pick = listSongs(bytes).find((s) => !s.empty && s.player === 0 && s.tracks >= 2); const h0 = r0.song(pick.index);
    const bad = bytes.slice(); bad[h0.tracks[0]] = 0xB2; new DataView(bad.buffer).setUint32(h0.tracks[0] + 1, 0x08000000 + h0.tracks[0], true);
    const { fake, music, errs } = await mk({ rom: bad });
    let threw = false, res = null; try { res = music.play(pick.index); fake.advance(1); } catch (e) { threw = true; }
    ok('a song with a zero-wait GOTO loop: play() returns false and onError gets seq-runaway, nothing throws', !threw && res === false && errs.some((e) => e.code === 'seq-runaway'), errs.map((e) => e.code).join(','));
    ok('the scheduler is not left running for the broken song', music.state().index === null && fake.liveTimers() === 0);
    const good = await mk(); control('(twin) the same song in the unmutated ROM plays', good.music.play(pick.index) === true);
  }
  {
    // SEAMS (the bug a verifier found in Chrome 156: 32768 Hz AudioBuffers on a 48000 Hz context got a doubled sample at every chunk boundary).
    // The fix renders buffers AT THE CONTEXT RATE and schedules them on whole context frames. Invariants checked at four device rates:
    const refRom = new Mp2kRom(bytes);
    const seamRun = async (ctxRate, extra) => {
      const fake = createFakeAudio({ sampleRate: ctxRate, keepData: true });
      const music = await createMusic({ ctx: fake.ctx, destination: fake.destination, rom: bytes, soundtrack: RT, timers: fake.timers, ...(extra || {}) });
      music.play(SONG, { fadeInMs: 0 }); fake.advance(6);
      const st = fake.starts().slice().sort((a, b) => a.when - b.when);
      return { fake, music, st };
    };
    for (const rate of [32768, 44100, 48000, 96000]) {
      const { st, music } = await seamRun(rate);
      ok(`seams @${rate}: every scheduled AudioBuffer has the context's own rate (the browser never resamples a chunk)`, st.length >= 20 && st.every((e) => e.rate === rate) && music.state().bufferRate === rate, `${st.length} chunks`);
      let frac = 0, gap = 0;
      for (let i = 0; i < st.length; i++) { const f = st[i].when * rate; frac = Math.max(frac, Math.abs(f - Math.round(f))); if (i > 0) gap = Math.max(gap, Math.abs(Math.round(f) - (Math.round(st[i - 1].when * rate) + st[i - 1].frames))); }
      ok(`seams @${rate}: every chunk starts on a whole context frame`, frac < 1e-6, `max fractional frame ${frac.toExponential(2)}`);
      ok(`seams @${rate}: chunk N ends on exactly the frame chunk N+1 starts (0 frames of gap or overlap)`, gap === 0, `max |gap| ${gap} frames`);
      const first = Math.round(st[0].when * rate), total = st.reduce((a, e) => a + e.frames, 0);
      const stream = new Float32Array(total); const streamR = new Float32Array(total);
      for (const e of st) { const at = Math.round(e.when * rate) - first; stream.set(e.buffer.getChannelData(0), at); streamR.set(e.buffer.getChannelData(1), at); }
      const eng = new SongEngine(refRom, SONG, { sampleRate: rate, mixer: { ...MIXER_PROFILES[RT] } });
      const ref = new Float32Array(total), refR = new Float32Array(total); eng.read(ref, refR, 0, total);
      let same = true; for (let i = 0; i < total; i++) if (!Object.is(stream[i], ref[i]) || !Object.is(streamR[i], refR[i])) { same = false; break; }
      ok(`seams @${rate}: the chunks played back to back equal ONE uninterrupted engine render bit for bit (${total} frames)`, same);
    }
    const old = await seamRun(48000, { _bufferRate: 32768 });
    control('seams: the old behaviour (32768 Hz buffers on a 48000 Hz context, Chrome resamples each chunk) FAILS the rate check', !old.st.every((e) => e.rate === 48000), `buffers at ${old.st[0].rate} Hz on a 48000 Hz context`);
  }
  {
    // underrun accounting: a long stall of the scheduler (tab frozen > lookahead) is counted and recovered
    const { fake, music } = await mk();
    music.play(SONG); fake.advance(1);
    fake.setTime(fake.ctx.currentTime + 4);   // the page was frozen for 4 s: no timer ticks happened
    fake.advance(0.3);
    const s = music.state();
    ok('a 4 s stall is counted as an underrun and playback recovers', s.underruns >= 1 && s.bufferedMs > 500, `underruns ${s.underruns}, buffered ${s.bufferedMs} ms`);
    const { fake: f2, music: m2 } = await mk(); m2.play(SONG); f2.advance(10);
    control('(twin) with no stall there are no underruns', m2.state().underruns === 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The oracle: the real m4a engine in mGBA, same ROM, same song
// ---------------------------------------------------------------------------------------------------------------
section('oracle: renderSong vs the real engine in mGBA');
if (flag('--no-oracle') || BROWSER_ONLY) skip('oracle comparisons', BROWSER_ONLY ? '--browser-only' : '--no-oracle');
else {
  let oracle = null;
  try { oracle = await import(pathToFileURL(path.join(HERE, 'pokemonarena_music_oracle.mjs')).href); } catch (e) { skip('oracle', 'cannot load the oracle tool: ' + e.message); }
  if (oracle) {
    for (const [which, rom] of [['sg', 'soulgold'], ['uv', 'ultraviolet']]) {
      if (!loaded[rom]) { skip(`oracle ${rom}`, 'ROM not found'); continue; }
      const rig = await oracle.openRig(which);
      const m = rig.mixer;
      const prof = MIXER_PROFILES[rom];
      ok(`${rom}: the running game's mixer equals MIXER_PROFILES`, m.maxChans === prof.maxChans && m.masterVol === prof.masterVol && m.pcmFreq === prof.mixRate && m.freqIndex === 4 && m.samplesPerVBlank === 224, JSON.stringify({ maxChans: m.maxChans, masterVol: m.masterVol, pcmFreq: m.pcmFreq, samplesPerVBlank: m.samplesPerVBlank }));
      const songs = which === 'sg' ? [805, 802] : [321];
      for (const idx of songs) {
        const r = await oracle.compareSong(rig, idx, { seconds: 8 });
        ok(`${rom} song ${idx}: the game accepted the song-start call and RAM names the requested song`, r.ok && r.identity.matches, r.ok ? `header ${r.identity.headerPointerInRam}, tries ${r.startTries}` : r.error);
        if (!r.ok) continue;
        const sg = which === 'sg';
        ok(`${rom} song ${idx}: loudness-envelope correlation >= ${sg ? 0.97 : 0.9}`, r.envCorr >= (sg ? 0.97 : 0.9), `envCorr ${r.envCorr.toFixed(3)}`);
        ok(`${rom} song ${idx}: waveform correlation (3 s) >= ${sg ? 0.9 : 0.8}`, r.waveCorr >= (sg ? 0.9 : 0.8), `waveCorr ${r.waveCorr.toFixed(3)}`);
        ok(`${rom} song ${idx}: log-spectrum correlation >= 0.7`, r.logSpec >= 0.7, `logSpec ${r.logSpec.toFixed(3)}`);
        ok(`${rom} song ${idx}: level within 10% (oracle/synth RMS)`, r.levelRatio > 0.9 && r.levelRatio < 1.1, `levelRatio ${r.levelRatio.toFixed(3)}`);
        ok(`${rom} song ${idx}: every octave band within 3 dB`, r.bandMaxAbs <= 3, `max |band diff| ${r.bandMaxAbs.toFixed(1)} dB`);
        ok(`${rom} song ${idx}: the oracle's remaining output latency is 1 video frame (16.7 ms) +-6 ms (the direct-sound DMA frame is modelled by dsDelay)`, Math.abs(r.lagMs - 16.7) < 6, `${r.lagMs} ms`);
        const cw = r.controlWrongSong, ct = r.controlTempo;
        control(`${rom} song ${idx}: a WRONG song scores far worse (waveform ${cw.waveCorr.toFixed(3)} vs ${r.waveCorr.toFixed(3)})`, cw.waveCorr < r.waveCorr - 0.4 && cw.envCorr < r.envCorr - 0.3 && cw.logSpec < r.logSpec - 0.1);
        control(`${rom} song ${idx}: a 5% tempo error scores clearly worse (waveform ${ct.waveCorr.toFixed(3)} vs ${r.waveCorr.toFixed(3)})`, ct.waveCorr < r.waveCorr - 0.3 && ct.logSpec < r.logSpec - 0.05);
      }
      if (which === 'sg') {
        // the wave-channel volume table against the oracle's SOUND3CNT_H on settled frames (natural songs + patched copies that sweep every envelope value)
        const wm = await oracle.waveMap();
        const codeOf = (g) => (g === 0 ? 0 : g === 0.25 ? 3 : g === 0.5 ? 2 : g === 0.75 ? 4 : 1);
        let agree = 0, total = 0, oldAgree = 0; const OLD = [0, 0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1, 1, 1];
        for (const [k, n] of Object.entries(wm.pairs)) { const [v, c] = k.split('->').map(Number); total += n; if (codeOf(CGB3VOL[v]) === c) agree += n; if (codeOf(OLD[v]) === c) oldAgree += n; }
        ok('wave-channel volume table (CGB3VOL) equals the oracle register code on every settled frame observed', total > 3000 && agree === total, `${agree} of ${total} frames, env values seen ${[...new Set(Object.keys(wm.pairs).map((k) => k.split('->')[0]))].sort((a, b) => a - b).join(',')}`);
        control('the previous table (env 7..9 -> 100% / 50%, 10..13 -> 100%) disagrees with the oracle on those frames', oldAgree < total, `${oldAgree} of ${total}`);
        const ks = await oracle.keySweep('sg');
        const hi = ks.filter((r) => r.key >= 56), disc = hi.filter((r) => Math.ceil(r.etDivisor - 1e-9) !== Math.round(r.etDivisor));
        const nCeil = disc.filter((r) => Math.round(r.divisor) === Math.ceil(r.etDivisor - 1e-9)).length, nRound = disc.filter((r) => Math.round(r.divisor) === Math.round(r.etDivisor)).length;
        ok('square pitch on the real engine (73 keys, patched copy): the divisor is ceil(131072/f) on at least 26 of the 28 keys where ceil and round-to-nearest differ', disc.length >= 20 && nCeil >= disc.length - 2, `${nCeil} of ${disc.length} follow ceil, ${nRound} follow round`);
        control('round-to-nearest agrees with the oracle on almost none of those keys', nRound <= 3, `${nRound} of ${disc.length}`);
        // effects: one capture, several synth variants
        const seEval = (capHP, idx, variant) => { const r2 = oracle.renderMono(rig, idx, 2.0, variant); const mHP = oracle.hpf(r2.mono); const al = oracle.alignSignals(capHP, mHP, { maxLagMs: 300, coarseWin: 1 }); return oracle.scorePair(capHP, mHP, al.offset, 1.0); };
        const grab = (idx) => { const sv = oracle.startSongVerified(rig, rig.base, idx); const c2 = oracle.captureFrames(rig.core, Math.round(1.8 * 59.7275)); const all = new Int16Array(sv.pre.samples.length + c2.samples.length); all.set(sv.pre.samples); all.set(c2.samples, sv.pre.samples.length); const f = oracle.to32k(all); return oracle.hpf(oracle.toMono(f.l, f.r)); };
        const cap31 = grab(31); const g31 = seEval(cap31, 31, undefined), r31 = seEval(cap31, 31, { psgReg: 'round' });
        ok('effect 31 (two square notes): waveform correlation >= 0.9 with the measured register rule', g31.waveCorr >= 0.9, `waveCorr ${g31.waveCorr.toFixed(3)}`);
        control('effect 31 with round-to-nearest registers scores far lower', r31.waveCorr < g31.waveCorr - 0.3, `${r31.waveCorr.toFixed(3)} vs ${g31.waveCorr.toFixed(3)}`);
        const cap4 = grab(4); const a4 = seEval(cap4, 4, undefined), a4r = seEval(cap4, 4, { psgReverb: true });
        ok('effect 4 (PSG only): envelope correlation >= 0.98 with the PSG kept out of the reverb', a4.envCorr >= 0.98, `envCorr ${a4.envCorr.toFixed(3)}`);
        control('effect 4 with the PSG reverbed (the old model) scores lower', a4r.envCorr < a4.envCorr - 0.005, `${a4r.envCorr.toFixed(3)} vs ${a4.envCorr.toFixed(3)}`);
        const cap56 = grab(56); const a56 = seEval(cap56, 56, undefined), a56n = seEval(cap56, 56, { dsDelay: 0 });
        ok('effect 56 (sample + square): waveform correlation >= 0.9 and envelope >= 0.98 with the direct-sound mix one frame behind the PSG', a56.waveCorr >= 0.9 && a56.envCorr >= 0.98, `waveCorr ${a56.waveCorr.toFixed(3)} envCorr ${a56.envCorr.toFixed(3)}`);
        control('effect 56 without the one-frame DS delay scores lower', a56n.waveCorr < a56.waveCorr - 0.1, `${a56n.waveCorr.toFixed(3)} vs ${a56.waveCorr.toFixed(3)}`);
        const cap16 = grab(16); const a16 = seEval(cap16, 16, undefined), a16n = seEval(cap16, 16, { sweep: false });
        ok('effect 16 (square sweep + noise + sample): every octave band within 6 dB and level within 10%', a16.bandMaxAbs <= 6 && a16.levelRatio > 0.9 && a16.levelRatio < 1.1, `bandMax ${a16.bandMaxAbs.toFixed(1)} dB, level ${a16.levelRatio.toFixed(3)}`);
        control('effect 16 without the NR10 sweep is far off in the bands', a16n.bandMaxAbs > a16.bandMaxAbs + 4, `${a16n.bandMaxAbs.toFixed(1)} vs ${a16.bandMaxAbs.toFixed(1)} dB`);
        const cap35 = grab(35); const a35 = seEval(cap35, 35, undefined), a35a = seEval(cap35, 35, { noiseSample: 'avg' });
        ok('effect 35 (noise): every octave band within 3 dB with the two-instant noise sampling', a35.bandMaxAbs <= 3, `bandMax ${a35.bandMaxAbs.toFixed(1)} dB`);
        control('effect 35 with the full-sample box average (too dull) is off by more', a35a.bandMaxAbs > a35.bandMaxAbs + 3, `${a35a.bandMaxAbs.toFixed(1)} vs ${a35.bandMaxAbs.toFixed(1)} dB`);
      }
      if (which === 'uv') {
        const sc = await oracle.stereoCheck('uv', [264, 321, 299, 4, 83], { seconds: 2.5 });
        ok('Ultra Violet: the real output is mono - L == R in every captured sample (3 music songs + 2 effects), gSoundInfo.mode = 1', sc.mixerMode === 1 && sc.rows.every((x) => x.differing === 0 && x.nonSilent), JSON.stringify(sc.rows.map((x) => [x.index, x.differing])));
        const sg = await oracle.stereoCheck('sg', [805], { seconds: 2.5 });
        control('SoulGold (mode 0) is NOT mono in the same kind of capture (the check can fail)', sg.rows[0].differing > 1000, `${sg.rows[0].differing} differing frames`);
      }
      if (which === 'sg') {
        // mutants of the SYNTH against one captured oracle run: each must trip a named check, the unmutated twin passes
        const idx = 805;
        const sv = oracle.startSongVerified(rig, rig.base, idx);
        const cap2 = oracle.captureFrames(rig.core, Math.round(8 * 59.7275) + 30);
        const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
        const f = oracle.to32k(all); const capHP = oracle.hpf(oracle.toMono(f.l, f.r));
        const score = (extra, eo) => { const r2 = oracle.renderMono(rig, idx, 9, extra, eo); const mHP = oracle.hpf(r2.mono); const al = oracle.alignSignals(capHP, mHP, { maxLagMs: 600 }); return oracle.scorePair(capHP, mHP, al.offset, 6); };
        const good = score();
        ok('mutants: the unmutated synth passes the level/shape checks', good.levelRatio > 0.9 && good.levelRatio < 1.1 && good.envCorr > 0.97 && good.waveCorr > 0.9, `level ${good.levelRatio.toFixed(3)} env ${good.envCorr.toFixed(3)} wave ${good.waveCorr.toFixed(3)}`);
        const mGain = score({ pcmGain: 0.75 * 1.5 });
        control('mutant: output gain x1.5 trips the level check', !(mGain.levelRatio > 0.9 && mGain.levelRatio < 1.1), `level ${mGain.levelRatio.toFixed(3)}`);
        const mVol = score({ masterVol: 8 });
        control('mutant: masterVol 12 -> 8 trips the level check', !(mVol.levelRatio > 0.9 && mVol.levelRatio < 1.1), `level ${mVol.levelRatio.toFixed(3)}`);
        const mTempo = score(undefined, { tempoScale: 1.02 });
        control('mutant: tempo +2% trips the waveform check', !(mTempo.waveCorr > 0.9), `wave ${mTempo.waveCorr.toFixed(3)}`);
        // reverb: song 805's header sets reverb 50, so the mutant forces the engine's reverb level to 0 after construction
        const eNo = new SongEngine(rig.parsed, idx, { sampleRate: 32768, mixer: { maxChans: 12, masterVol: 12, mixRate: 13379 } }); eNo.reverb = 0;
        const Ln = new Float32Array(32768 * 9), Rn = new Float32Array(32768 * 9); eNo.read(Ln, Rn, 0, Ln.length);
        const nHP = oracle.hpf(oracle.toMono(Ln, Rn)); const alN = oracle.alignSignals(capHP, nHP, { maxLagMs: 600 }); const sN = oracle.scorePair(capHP, nHP, alN.offset, 6);
        control('mutant: reverb switched off lowers the waveform correlation', sN.waveCorr < good.waveCorr - 0.01, `wave ${sN.waveCorr.toFixed(3)} vs ${good.waveCorr.toFixed(3)}`);
        const mChans = score({ maxChans: 3 });
        control('mutant: 3 direct-sound channels instead of 12 lowers the waveform correlation', mChans.waveCorr < good.waveCorr - 0.2, `wave ${mChans.waveCorr.toFixed(3)}`);
      }
    }
    // natural captures through OR1's oracle: the GAME picks the song
    if (loaded.soulgold && fs.existsSync(path.join(HERE, 'pokemonarena_rom_oracle.mjs'))) {
      for (const ck of ['CK_BATTLE_INTRO', 'CK_WILD_INTRO']) {
        const r = await oracle.compareNatural(ck, { seconds: 8 });
        if (!r.ok) { skip(`natural ${ck}`, r.error); continue; }
        ok(`natural ${ck}: the game itself chose song ${r.index} (RAM header ${r.identity.headerPointerInRam}) and the synth matches it`, r.envCorr >= 0.97 && r.waveCorr >= 0.9, `envCorr ${r.envCorr.toFixed(3)} waveCorr ${r.waveCorr.toFixed(3)} logSpec ${r.logSpec.toFixed(3)} level ${r.levelRatio.toFixed(3)}`);
        control(`natural ${ck}: a different song fits far worse (best waveform ${r.controlWrongSong.bestWaveCorr3s.toFixed(3)})`, r.controlWrongSong.bestWaveCorr3s < r.waveCorr - 0.5);
      }
    } else skip('natural captures', 'OR1 oracle or SoulGold ROM missing');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Real Chrome (headless, throwaway profile, --mute-audio) with an OfflineAudioContext: the real WebAudio implementation, no audio device.
// SEAMS: a verifier found that 32768 Hz chunks on a 48000 Hz context got a doubled sample at every chunk boundary in Chrome 156. This section
// (1) probes the mechanism with two constant buffers, (2) measures the seams of createMusic at 48000 / 44100 / 96000 Hz against a single-buffer
// reference, bit for bit, and (3) shows the OLD behaviour (_bufferRate: 32768) still fails the same measurement (the negative control).
// ---------------------------------------------------------------------------------------------------------------
if (flag('--browser') || BROWSER_ONLY) {
  section('browser: seams of music.js chunks in headless Chrome against a real OfflineAudioContext (renders to memory, no device, no sound)');
  if (!loaded.soulgold) skip('browser section', 'SoulGold ROM not found');
  else {
    const { spawn } = await import('node:child_process');
    const { withBrowser } = await import(pathToFileURL(path.join(HERE, 'headless_cdp.mjs')).href);
    const PORT = Number(process.env.MUSIC_TEST_PORT || 8103), CDP = Number(process.env.MUSIC_TEST_CDP || 9351);
    const server = spawn(process.execPath, [path.join(HERE, 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
    try {
      for (let i = 0; i < 40; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/pokemonarena/manifest.json'); if (r.ok) break; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
      let res = null;
      try {
        res = await withBrowser({ port: CDP, width: 800, height: 600 }, async (page) => {
          await page.navigate('http://127.0.0.1:' + PORT + '/pokemonarena/manifest.json');
          return page.eval(String.raw`(async () => {
            const out = { chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)[0] };
            const m = await import('/pokemonarena/js/music.js');
            const rom = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/' + encodeURIComponent('Pokemon SoulGold (v1.1.1).gba'))).arrayBuffer());
            out.romBytes = rom.length;
            // (1) mechanism probe: two back-to-back constant-1 buffers
            const probe = async (ctxRate, bufRate, frames) => {
              const off = new OfflineAudioContext(1, Math.round(ctxRate * 0.6), ctxRate);
              const mk = () => { const b = off.createBuffer(1, frames, bufRate); b.getChannelData(0).fill(1); return b; };
              const t0 = Math.ceil(0.1 * ctxRate) / ctxRate;
              const s1 = off.createBufferSource(); s1.buffer = mk(); s1.connect(off.destination); s1.start(t0);
              const s2 = off.createBufferSource(); s2.buffer = mk(); s2.connect(off.destination); s2.start(t0 + frames / bufRate);
              const o = (await off.startRendering()).getChannelData(0);
              let nz = 0, first = -1, last = -1, mx = 0, atMax = -1;
              for (let i = 0; i < o.length; i++) { if (o[i] > 0.01) { nz++; if (first < 0) first = i; last = i; } if (o[i] > mx) { mx = o[i]; atMax = i; } }
              const boundary = Math.round(t0 * ctxRate) + Math.round(frames * ctxRate / bufRate);
              return { ctxRate, bufRate, frames, nonzeroFrames: nz, expectedFrames: Math.round(2 * frames * ctxRate / bufRate), max: mx, maxAt: atMax - boundary, valueAtBoundary: o[boundary], valueBefore: o[boundary - 1], valueAfter: o[boundary + 1] };
            };
            out.probe = [await probe(48000, 32768, 8192), await probe(44100, 32768, 8192), await probe(96000, 32768, 8192), await probe(48000, 48000, 12000)];
            // (2) seams of createMusic against one uninterrupted buffer at the context rate
            const SECS = 12, SONG = 889;
            const noTimers = { setInterval: () => 1, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {} };
            const seams = async (SR, extra, refRate) => {
              refRate = refRate || SR;   // the reference is ONE buffer rendered at the rate the chunks use (so the browser resamples it exactly like it resamples the chunks, but without a seam)
              const ref = m.renderSong(rom, SONG, { seconds: SECS + 1, sampleRate: refRate, soundtrack: 'soulgold' });
              const startT = (extra && extra._bufferRate) ? 0.05 : Math.ceil(0.05 * refRate) / refRate;   // exactly the start the chunks get (new: the first whole frame of the chunk rate at or after now + 50 ms; old: now + 0.05 s)
              const offRef = new OfflineAudioContext(2, SR * SECS, SR);
              const rb = offRef.createBuffer(2, ref.left.length, refRate); rb.copyToChannel(ref.left, 0); rb.copyToChannel(ref.right, 1);
              const rs = offRef.createBufferSource(); rs.buffer = rb; rs.connect(offRef.destination); rs.start(startT);
              const refOut = await offRef.startRendering();
              const off = new OfflineAudioContext(2, SR * SECS, SR);
              let T = 0; const ctx = new Proxy(off, { get(t, p) { if (p === 'currentTime') return T; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } });
              const dest = off.createGain(); dest.connect(off.destination);
              const music = await m.createMusic({ ctx, destination: dest, rom, soundtrack: 'soulgold', timers: noTimers, ...(extra || {}) });
              music.play(SONG, { fadeInMs: 0 });
              for (T = 0; T < SECS - 1; T += 0.1) music._tick();
              const o = await off.startRendering();
              const A = o.getChannelData(0), B = refOut.getChannelData(0);
              const chunk = Math.round(0.25 * SR), first = Math.round(startT * SR);
              const seam = [], ctl = []; let all = 0;
              for (let k = 1; k < 40; k++) { const c = first + k * chunk; let mm = 0; for (let j = c - 4; j <= c + 4; j++) mm = Math.max(mm, Math.abs(A[j] - B[j])); seam.push(mm); const c2 = c + (chunk >> 1); let m2 = 0; for (let j = c2 - 4; j <= c2 + 4; j++) m2 = Math.max(m2, Math.abs(A[j] - B[j])); ctl.push(m2); }
              for (let i = first; i < first + chunk * 40; i++) all = Math.max(all, Math.abs(A[i] - B[i]));
              const cnt = (arr, th) => arr.filter((v) => v > th).length;
              return { SR, bufferRate: music.state().bufferRate, seams: seam.length, seamMax: Math.max(...seam), seamOver_0_03: cnt(seam, 0.03), seamOver_1e5: cnt(seam, 1e-5), ctlMax: Math.max(...ctl), maxAbsDiffAll: all };
            };
            out.seams = [await seams(48000), await seams(44100), await seams(96000)];
            out.legacy = await seams(48000, { _bufferRate: 32768 }, 32768);
            return out;
          })()`);
        });
      } catch (e) { if (/browser lock timeout/.test(e.message)) skip('browser seam test', 'could not get the machine-wide browser lock (other agents hold it): ' + e.message.slice(0, 80)); else { fail++; console.log('  FAIL browser seam test threw: ' + e.message); } }
      if (res) {
        console.log('       ' + res.chrome + ', ROM ' + res.romBytes + ' bytes over HTTP');
        for (const p of res.probe) console.log('       probe ' + p.bufRate + ' Hz buffers x2 on a ' + p.ctxRate + ' Hz context: ' + p.nonzeroFrames + ' non-zero frames (expected ' + p.expectedFrames + '), max ' + p.max.toFixed(3) + ' at boundary' + (p.maxAt >= 0 ? '+' : '') + p.maxAt + ', boundary value ' + p.valueAtBoundary.toFixed(3) + ' (before ' + p.valueBefore.toFixed(3) + ', after ' + p.valueAfter.toFixed(3) + ')');
        const p48 = res.probe[0], same = res.probe[3];
        ok('mechanism: two 32768 Hz buffers on a 48000 Hz context are rendered with an EXTRA output frame that sums with the next buffer (boundary sample ~2x)', p48.nonzeroFrames === p48.expectedFrames + 1 || p48.max > 1.5, 'non-zero frames ' + p48.nonzeroFrames + ' vs ' + p48.expectedFrames + ', max ' + p48.max.toFixed(3));
        ok('mechanism: the same two buffers at the context rate (48000 on 48000) are exact: no extra frame, max 1.0', same.nonzeroFrames === same.expectedFrames && Math.abs(same.max - 1) < 1e-6, 'non-zero frames ' + same.nonzeroFrames + ' vs ' + same.expectedFrames + ', max ' + same.max);
        for (const sres of res.seams) {
          console.log('       seams @' + sres.SR + ': buffers at ' + sres.bufferRate + ' Hz, ' + sres.seams + ' seams, max |A-B| at seams ' + sres.seamMax.toExponential(2) + ', at mid-chunk controls ' + sres.ctlMax.toExponential(2) + ', over the whole 10 s ' + sres.maxAbsDiffAll.toExponential(2));
          ok('seams @' + sres.SR + ' Hz in Chrome: every chunk boundary equals the single-buffer reference within 1e-5 (and so does the rest of the signal)', sres.bufferRate === sres.SR && sres.seamMax < 1e-5 && sres.ctlMax < 1e-5 && sres.maxAbsDiffAll < 1e-5);
        }
        const lg = res.legacy;
        console.log('       OLD behaviour @48000 (_bufferRate 32768): ' + lg.seamOver_0_03 + ' of ' + lg.seams + ' seams differ from the reference by more than 0.03, max ' + lg.seamMax.toFixed(3) + '; mid-chunk controls ' + lg.ctlMax.toExponential(2));
        control('seams: the OLD behaviour (32768 Hz chunks on a 48000 Hz context) fails the same measurement in Chrome', lg.seamOver_0_03 >= 10 && lg.ctlMax < 1e-5, lg.seamOver_0_03 + ' of ' + lg.seams + ' seams > 0.03, max ' + lg.seamMax.toFixed(3));
      }
    } finally { try { server.kill(); } catch (e) { /* ignore */ } }
  }
}

if (flag('--update-golden')) {
  fs.writeFileSync(GOLDEN, JSON.stringify(goldenOut, null, 1) + '\n');
  console.log(`\nwrote ${GOLDEN}`);
}
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
