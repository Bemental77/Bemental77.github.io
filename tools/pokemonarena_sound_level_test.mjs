#!/usr/bin/env node
// tools/pokemonarena_sound_level_test.mjs -- LOUDNESS: does a player at the UNITY sliders (master 0.7, music 0.6: audio_mixer.js UNITY), hear the music at the level the REAL game plays it?
//
// UPDATED DELIBERATELY (the user: "play music as soon as you join, but at half volume on the slider"): a first-time visitor now starts at Master 0.5 (AM.DEFAULTS.master), which is UNDER the
// game's level on purpose (gain (0.5/0.7)^2 = 0.51, -5.85 dB). The calibration claim below (the engine at gain 1.0 IS the real game's level) is therefore asserted at the UNITY positions, where it has always
// been true, and the new starting volume is asserted separately (a quiet start: -5.85 dB, within 0.3 dB, and quieter than the unity median). Until this change UNITY and DEFAULTS were the same numbers.
//
//   node tools/pokemonarena_sound_level_test.mjs               # needs the SoulGold ROM (and the Ultra Violet ROM for its half); SKIPPED LOUDLY (counted) when absent
//
// THE QUESTION (FV1, round 4): "at defaults (master 0.7, music 0.6 = gain 0.176) the sink peak was 0.047 and RMS ~0.009-0.015; at master and music 100% the peak was 0.397, RMS 0.0795.
// The owner's complaint was about silence: choose defaults so a first-time player at the defaults hears the music at the level the real game outputs at the same game volume."
//
// THE REFERENCE: the real game in the site's mGBA core (MU1's rig: the game's own m4aSongNumStart starts the song; the core's audio is captured at 65536 Hz). Its level IS the real
// game's level at full game volume: lib/volume.js (the site's volume slider for the GBA page) defaults to 100% = gain 1.0, so nothing is applied on top of the core's output.
// THE ARENA: the engine's offline render (SongEngine = what music.js plays in real time) times the default bus gains of audio_mixer.js (gainFor at DEFAULTS), then the soft limiter.
// Both are high-passed at 25 Hz (the oracle's PSG carries a DC offset) and measured over seconds 2..10 of the song (RMS and peak).
//
// TOLERANCE (stated): +-1.0 dB of RMS per song, +-0.5 dB for the median over the songs. The engine's own calibration against the oracle (MUSIC.md: median level ratio 1.004) and the four
// SoulGold songs measured on the day this file was written (+0.03 / +0.07 / -0.04 / -0.03 dB) are far inside it; the old defaults sat 15 dB below it.
// NEGATIVE CONTROLS (the same comparison must FAIL): the old law at the default positions (0.49 x 0.36 = 0.176, -15 dB); both sliders at 100% under the new law (+6 dB); the old law
// imported from a MUTATED copy of audio_mixer.js; the limiter-free worst case at the top of the sliders (it clips, so the limiter is needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, J } = L;
const C = L.makeCounter('sound-level');
const JS = path.join(root, 'pokemonarena', 'js');
const head = (s) => console.log('\n== ' + s);
if (!fs.existsSync(L.ROM_PATH)) { console.log('SKIP (counted): the SoulGold ROM is not present'); C.ok(true, 'SKIPPED: no ROM'); C.finish(); process.exit(0); }

const MO = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_music_oracle.mjs')).href);
const AM = await import(pathToFileURL(path.join(JS, 'audio_mixer.js')).href);
const MAP = await import(pathToFileURL(path.join(JS, 'music_map.js')).href);

const TOL = { soulgold: { rms: 1.0, peak: 1.5 }, ultraviolet: { rms: 1.5, peak: 3.0 } };         // per song, dB. Ultra Violet is looser because ITS engine calibration is looser (PSG-heavy songs, MUSIC.md): it measured -1.31 / -0.58 dB, the engine's residual, not the mixer's
const TOL_DB = 1.0, TOL_MEDIAN_DB = 0.5;
const SEC = 10, FROM = 2;                                  // measured over seconds 2..10 of the song
const db = (x) => 20 * Math.log10(x);
const peak = (x, s = 0, n = x.length - s) => { let m = 0; for (let i = 0; i < n; i++) { const v = Math.abs(x[s + i]); if (v > m) m = v; } return m; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** the arena's sink for a rendered signal: the default (or given) slider positions -> bus gains -> the soft limiter */
function sinkOf(mono, { master = AM.UNITY.master, music = AM.UNITY.music, gain = AM.gainFor, limiter = true } = {}) {
  const g = gain(master, 'master') * gain(music, 'music'); const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) { const v = mono[i] * g; out[i] = limiter ? AM.limit(v) : v; }
  return out;
}
async function measure(rig, label, idx) {
  const sv = MO.startSongVerified(rig, rig.base, idx); if (!sv.ok) throw new Error('the game did not accept song ' + idx);
  const cap2 = MO.captureFrames(rig.core, Math.round((SEC + 1) * 59.7275));
  const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
  const f = MO.to32k(all); const game = MO.hpf(MO.toMono(f.l, f.r));
  const eng = MO.hpf(MO.renderMono(rig, idx, SEC + 1).mono);
  const s0 = 32768 * FROM, n = 32768 * (SEC - FROM);
  const gameRms = MO.rms(game, s0, n), gamePk = peak(game, s0, n);
  const at = (opts) => { const s = sinkOf(eng, opts); return { rms: MO.rms(s, s0, n), peak: peak(s, s0, n) }; };
  return { label, idx, gameRms, gamePk, engineRms: MO.rms(eng, s0, n), at };
}

const SONGS = { soulgold: ['hub', 'editor', 'preview', 'battle_normal', 'battle_hard', 'result_win'], ultraviolet: ['hub', 'battle_normal'] };
const rows = [], rigs = {};
for (const [st, which] of [['soulgold', 'sg'], ['ultraviolet', 'uv']]) {
  if (!MO.romAvailable(which)) { console.log('SKIP (counted): the ' + st + ' ROM is not present; its songs were not measured'); C.ok(true, 'SKIPPED: no ' + st + ' ROM'); continue; }
  head('the ' + st + ' soundtrack: the real game (mGBA) vs the arena at the UNITY sliders (master ' + AM.UNITY.master + ', music ' + AM.UNITY.music + ')');
  const rig = await MO.openRig(which); rigs[st] = rig;
  for (const key of SONGS[st]) {
    const rec = MAP.songFor(st, key); const m = await measure(rig, st + ':' + key + ' (song ' + rec.index + ')', rec.index);
    const def = m.at({}), old = m.at({ gain: (v) => v * v, limiter: false }), loud = m.at({ master: 1, music: 1 }), start = m.at({ master: AM.DEFAULTS.master, music: AM.DEFAULTS.music });
    const d = db(def.rms / m.gameRms);
    rows.push({ ...m, st, key, def, old, loud, d, start });
    console.log('   ' + m.label.padEnd(30) + 'game rms ' + m.gameRms.toFixed(4) + ' peak ' + m.gamePk.toFixed(3) + ' | arena@default rms ' + def.rms.toFixed(4) + ' peak ' + def.peak.toFixed(3) + ' (' + (d >= 0 ? '+' : '') + d.toFixed(2) + ' dB) | old law ' + db(old.rms / m.gameRms).toFixed(1) + ' dB | sliders 100% ' + (db(loud.rms / m.gameRms) >= 0 ? '+' : '') + db(loud.rms / m.gameRms).toFixed(1) + ' dB');
  }
}
if (!rows.length) { C.finish(); process.exit(0); }

head('checks');
for (const r of rows) {
  C.ok(Math.abs(r.d) <= TOL[r.st].rms, 'level: ' + r.label + ': the arena at the unity sliders is ' + (r.d >= 0 ? '+' : '') + r.d.toFixed(2) + ' dB from the real game (tolerance +-' + TOL[r.st].rms + ' dB)', J({ game: r.gameRms, arena: r.def.rms }));
  C.ok(Math.abs(db(r.def.peak / r.gamePk)) <= TOL[r.st].peak, 'level: ' + r.label + ': PEAK ' + r.def.peak.toFixed(3) + ' vs the game\'s ' + r.gamePk.toFixed(3) + ' (' + db(r.def.peak / r.gamePk).toFixed(2) + ' dB, tolerance +-' + TOL[r.st].peak + ' dB: a peak depends on the exact notes the two renders place)');
  C.ok(Math.abs(db(r.def.rms / r.engineRms)) < 0.001, 'level: ' + r.label + ': the unity sliders pass the music through at EXACTLY gain 1.0 (the limiter does not touch it: its peak ' + r.def.peak.toFixed(3) + ' is under the 0.8 knee)');
}
const sgRows = rows.filter((r) => r.st === 'soulgold'), medSg = median(sgRows.map((r) => r.d));
C.ok(sgRows.length === 0 || Math.abs(medSg) <= TOL_MEDIAN_DB, 'level: the MEDIAN of the ' + sgRows.length + ' SoulGold songs (the default soundtrack) is ' + medSg.toFixed(2) + ' dB from the real game (tolerance +-' + TOL_MEDIAN_DB + ' dB)');
const med = median(rows.map((r) => r.d));
C.ok(Math.abs(med) <= TOL_MEDIAN_DB, 'level: the MEDIAN of all the ' + rows.length + ' songs is ' + (med >= 0 ? '+' : '') + med.toFixed(2) + ' dB from the real game (tolerance +-' + TOL_MEDIAN_DB + ' dB)');
// THE NEW STARTING VOLUME: Master 0.5 with music and effects at unity. Quiet on purpose: -5.85 dB from the game's level, still audible, and the same for every song (the gain is one number).
{
  const want = db(AM.gainFor(AM.DEFAULTS.master, 'master') * AM.gainFor(AM.DEFAULTS.music, 'music')), startD = rows.map((r) => db(r.start.rms / r.gameRms)), medStart = median(startD);
  C.ok(Math.abs(AM.DEFAULTS.master - 0.5) < 1e-9 && Math.abs(want - 20 * Math.log10((0.5 / 0.7) ** 2)) < 1e-9 && Math.abs(want + 5.85) < 0.01, 'start: a first-time visitor starts at Master 0.5 (' + want.toFixed(2) + ' dB re the real game by the gain law)');
  C.ok(Math.abs(medStart - want) < 0.3 && medStart < median(rows.map((r) => r.d)) - 5, 'start: the MEDIAN of the ' + rows.length + ' songs at the starting volume is ' + medStart.toFixed(2) + ' dB from the real game (the law says ' + want.toFixed(2) + ', tolerance 0.3 dB) and well under the unity level');
  C.ok(rows.every((r) => r.start.rms > 0.01), 'start: no song is inaudible at the starting volume (RMS above 0.01; the quietest is ' + Math.min(...rows.map((r) => r.start.rms)).toFixed(3) + ')');
}
C.ok(rows.every((r) => r.def.rms > 0.02), 'level: no song reaches the sink below RMS 0.02 at the unity sliders (FV1\'s old defaults: 0.009-0.015); the quietest is ' + Math.min(...rows.map((r) => r.def.rms)).toFixed(3));

head('negative controls: the SAME comparison must fail');
{
  const oldD = rows.map((r) => db(r.old.rms / r.gameRms)), loudD = rows.map((r) => db(r.loud.rms / r.gameRms));
  C.ok(oldD.every((x) => Math.abs(x) > TOL_DB * 5) && Math.abs(median(oldD) + 15.07) < 0.4, 'control: the OLD law at the default positions (0.7 x 0.6 squared = 0.176) is ' + median(oldD).toFixed(1) + ' dB from the game on median and fails every song (this is the 15 dB FV1 measured)', J(oldD.map((x) => +x.toFixed(1))));
  C.ok(loudD.every((x) => x > TOL_DB * 3) && Math.abs(median(loudD) - 6.02) < 0.5, 'control: BOTH sliders at 100% under the new law is ' + median(loudD).toFixed(1) + ' dB OVER the game (+3 dB per bus) and fails every song: the defaults are not the maximum', J(loudD.map((x) => +x.toFixed(1))));
  // the old law, imported from a mutated COPY of the mixer: the same code path as the shipped one with one line changed
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-level-')); const src = fs.readFileSync(path.join(JS, 'audio_mixer.js'), 'utf8');
  const a = 'if (x <= v0) return (x / v0) * (x / v0);', b = 'return 1 + (GAIN_MAX - 1) * ((x - v0) / (1 - v0));';
  if (src.split(a).length !== 2 || src.split(b).length !== 2) { C.ok(false, 'control: the mixer\'s gain law could not be mutated (text moved)'); }
  else {
    fs.writeFileSync(path.join(tmp, 'audio_mixer.js'), src.replace(a, () => 'if (x <= 1) return x * x;').replace(b, () => 'return 1;'));
    const OLD = await import(pathToFileURL(path.join(tmp, 'audio_mixer.js')).href);
    const r0 = rows[0]; const s = sinkOf(MO.hpf(MO.renderMono(rigs.soulgold, r0.idx, SEC + 1).mono), { gain: OLD.gainFor });
    const dd = db(MO.rms(s, 32768 * FROM, 32768 * (SEC - FROM)) / r0.gameRms);
    C.ok(Math.abs(dd) > TOL_DB * 5, 'control: a MUTATED mixer (the old square law) puts ' + r0.label + ' at ' + dd.toFixed(1) + ' dB from the game: the comparison fails it, as it must');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

head('headroom: music + sound effects together, at the defaults and at the top of the sliders (offline, sample-aligned at the loudest second of the music)');
{
  const rig = rigs.soulgold;
  const sfxIdx = ['se_hit_super', 'se_hit_normal', 'se_faint', 'se_lowhp', 'se_error'].map((k) => MAP.songFor('soulgold', k).index);
  const sfx = sfxIdx.map((i) => MO.hpf(MO.renderMono(rig, i, 3).mono));
  const worst = { def: 0, max: 0, maxNoLimiter: 0, defNoLimiter: 0 }; let which = '';
  for (const key of ['hub', 'preview', 'battle_normal', 'battle_hard', 'result_win']) {
    const idx = MAP.songFor('soulgold', key).index; const m = MO.hpf(MO.renderMono(rig, idx, 20).mono);
    // the loudest second of the music
    let best = 0, at = 0; for (let s = 0; s + 32768 <= m.length; s += 4096) { const p = peak(m, s, 32768); if (p > best) { best = p; at = s; } }
    // find the instant of the single loudest sample in that second and lay EVERY effect on it (a worst case no battle reaches: five effects at one instant, all at the music's peak)
    let pk = at, pv = 0; for (let i = at; i < at + 32768; i++) if (Math.abs(m[i]) > pv) { pv = Math.abs(m[i]); pk = i; }
    const mix = new Float32Array(32768 * 3); for (let i = 0; i < mix.length; i++) mix[i] = m[Math.min(m.length - 1, pk - 16384 + i)];
    for (const e of sfx) { const o = 16384; let ep = 0, ei = 0; for (let i = 0; i < Math.min(e.length, 32768); i++) if (Math.abs(e[i]) > ep) { ep = Math.abs(e[i]); ei = i; } for (let i = 0; i < e.length; i++) { const j = o - ei + i; if (j >= 0 && j < mix.length) mix[j] += e[i]; } }
    // music bus gain and fx bus gain differ: model them separately (music through master x music, effects through master x fx), at the defaults and at 100% / 100% / 100%
    const mus = new Float32Array(mix.length), fxs = new Float32Array(mix.length);
    for (let i = 0; i < mix.length; i++) mus[i] = m[Math.min(m.length - 1, pk - 16384 + i)];
    for (let i = 0; i < mix.length; i++) fxs[i] = mix[i] - mus[i];
    const chain = (pos, limiter) => { const gm = AM.gainFor(pos.master, 'master'), gmu = AM.gainFor(pos.music, 'music'), gf = AM.gainFor(pos.fx, 'fx'); let p = 0; for (let i = 0; i < mix.length; i++) { const v = (mus[i] * gmu + fxs[i] * gf) * gm; const o = limiter ? AM.limit(v) : v; if (Math.abs(o) > p) p = Math.abs(o); } return p; };
    const D = { master: AM.UNITY.master, music: AM.UNITY.music, fx: AM.UNITY.fx }, X = { master: 1, music: 1, fx: 1 };
    const rd = { def: chain(D, true), defNo: chain(D, false), max: chain(X, true), maxNo: chain(X, false) };
    if (rd.max > worst.max) { worst.max = rd.max; which = key; }
    worst.def = Math.max(worst.def, rd.def); worst.defNoLimiter = Math.max(worst.defNoLimiter, rd.defNo); worst.maxNoLimiter = Math.max(worst.maxNoLimiter, rd.maxNo);
    console.log('   ' + key.padEnd(14) + 'music peak ' + best.toFixed(3) + ' + five effects at the same instant -> sink peak at defaults ' + rd.def.toFixed(3) + ' (' + rd.defNo.toFixed(3) + ' without the limiter), at 100% x 100% x 100% ' + rd.max.toFixed(3) + ' (' + rd.maxNo.toFixed(3) + ' without)');
  }
  C.ok(worst.max <= AM.LIMIT_CEIL + 1e-9 && worst.def <= AM.LIMIT_CEIL + 1e-9, 'headroom: even with five effects landing on the music\'s single loudest sample, the sink never exceeds ' + AM.LIMIT_CEIL + ' (defaults ' + worst.def.toFixed(3) + ', everything at 100% ' + worst.max.toFixed(3) + ', worst song ' + which + '): no clipping');
  C.ok(worst.maxNoLimiter > 1, 'headroom control: WITHOUT the soft limiter the same worst case at the top of the sliders reaches ' + worst.maxNoLimiter.toFixed(2) + ' (> 1.0 = clipping), so the limiter is what keeps it clean');
  C.ok(worst.defNoLimiter > 0.5, 'headroom: at the defaults the unlimited worst case is ' + worst.defNoLimiter.toFixed(2) + ' (the real game\'s own mixer is at the same level, so a stack this dense is rare: the limiter only rounds it off)');
}

head('the limiter itself');
{
  const xs = []; for (let i = -1000; i <= 1000; i++) xs.push(i / 100);        // -10 .. +10
  C.ok(xs.every((x) => Math.abs(AM.limit(x)) <= AM.LIMIT_CEIL + 1e-12) && xs.every((x) => AM.limit(-x) === -AM.limit(x)), 'limiter: |output| <= ' + AM.LIMIT_CEIL + ' for every input from -10 to +10, odd-symmetric');
  C.ok([0, 0.1, 0.5, 0.79, 0.8, -0.8, -0.6].every((x) => AM.limit(x) === x), 'limiter: the identity up to the ' + AM.LIMIT_KNEE + ' knee (music at the game\'s level is untouched)');
  let mono = true, prev = -2; for (let i = 0; i <= 2000; i++) { const y = AM.limit(i / 200); if (y < prev - 1e-12) mono = false; prev = y; }
  C.ok(mono, 'limiter: monotonic (a louder input is never quieter)');
  const c = AM.limiterCurve(); C.ok(c.length === 4097 && Math.abs(c[0] + AM.limit(1)) < 1e-6 && Math.abs(c[4096] - AM.limit(1)) < 1e-6 && Math.abs(c[2048]) < 1e-9, 'limiter: the WaveShaper curve has 4097 points, matches limit() at the ends and is 0 at the middle');
}
C.finish();
process.exit(0);
