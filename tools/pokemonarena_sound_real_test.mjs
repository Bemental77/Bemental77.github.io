#!/usr/bin/env node
// tools/pokemonarena_sound_real_test.mjs -- the REAL sound path in headless Chrome (muted by --mute-audio): the real AudioContext, the real music.js engine, the real ROM, the real
// pages. Nothing here is a test double. A recording TAP is put on the sink (every node that feeds ctx.destination) before the page runs, so what is measured is what the speakers
// would get: RMS and peak, sample by sample.
//
//   node tools/pokemonarena_sound_real_test.mjs            # needs the SoulGold ROM, music.js, music_map.js; ~3 minutes; takes the machine-wide browser lock
//   node tools/pokemonarena_sound_real_test.mjs --no-mutants
//   ARENA_PORT=8104 ARENA_CDP=9355 ARENA_OUT=<dir>
//
// 1. LEVEL AT THE SINK (round 4, item 2): the hub's song at the DEFAULT sliders, measured at the sink, against the REAL GAME's level for the same song (mGBA through MU1's rig):
//    +-1.5 dB (RMS over seconds 2..12 of the song; the page is a real-time synthesis with the browser's own timing, hence wider than the offline test's +-1.0). Then the sliders at
//    100% / 100% / 100%: +6 dB over the default. NEGATIVE CONTROL: an overlay copy of the page with the OLD square law must measure about -15 dB and FAIL the same check.
// 2. THE WIN / LOSE RESULT SEQUENCE IN REAL TIME (item 4): director.result('win') plays the victory fanfare (song 951) to its end, THEN the result song (436); lose: 391 then 492;
//    draw: 492 alone. Timed on the real clock, with the engine's underrun counter before and after and the sink non-silent in both parts. NO synchronous autoplay is running.
// 3. WORST-CASE HEADROOM IN A REAL BATTLE (item 2): a battle played in real time with every slider at 100%: cries, hit sounds, faint sounds, the ROM's move sounds and the music
//    together. The sink never exceeds the limiter's ceiling (0.95). NEGATIVE CONTROL: an overlay copy WITHOUT the limiter must clip (> 1.0) in the same battle.
//    Also counted in that battle: one effectiveness sound per damaging hit, one faint sound per faint (the animator's own copy of it is dropped, not doubled).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.ARENA_PORT = process.env.ARENA_PORT || '8104';
process.env.ARENA_CDP = process.env.ARENA_CDP || '9355';
const L = await import('./pokemonarena_hub_lib.mjs');
const { withBrowser, acquireBrowserLock } = await import('./headless_cdp.mjs');
const lockedBrowser = async (o, fn) => { const release = await acquireBrowserLock({ timeoutMs: 4 * 3600e3, pollMs: 1000 }); try { return await withBrowser({ ...o, lock: false }, fn); } finally { release(); } };
const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
const { root, BASE, sleep, J, errsOf, addInit } = L;
const ARGS = new Set(process.argv.slice(2));
const C = L.makeCounter('sound-real');
const PA = process.env.ARENA_PA || path.join(root, 'pokemonarena');
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-sound-real');
fs.mkdirSync(OUT, { recursive: true });
const head = (s) => console.log('\n== ' + s);
const JS = path.join(PA, 'js');
let cdp = L.CDP0;
const HUB = '__arenaHub', BAT = '__arenaBattle';

const have = (f) => fs.existsSync(path.join(JS, f));
if (!fs.existsSync(L.ROM_PATH) || !have('music.js') || !have('music_map.js')) { console.log('SKIP (counted): the SoulGold ROM, music.js or music_map.js is absent'); C.ok(true, 'SKIPPED'); C.finish(); process.exit(0); }
const AM = await import(pathToFileURL(path.join(JS, 'audio_mixer.js')).href);
const MAP = await import(pathToFileURL(path.join(JS, 'music_map.js')).href);
const MO = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_music_oracle.mjs')).href);

/* ------------------------------------------------------------------------------------------------ the sink tap (runs in the page, before any page script) */
const TAP_SRC = `(() => {
  const Real = window.AudioContext || window.webkitAudioContext; if (!Real || window.__tap) return;
  const T = window.__tap = { ctxs: [], post: [], pre: [], sr: 0 };
  const origConnect = AudioNode.prototype.connect;
  class Tap extends Real {
    constructor(o) {
      super(o); T.ctxs.push(this); T.sr = this.sampleRate;
      const mk = (store) => {
        const sp = this.createScriptProcessor(2048, 2, 2), z = this.createGain(); z.gain.value = 0; origConnect.call(sp, z); origConnect.call(z, this.destination);
        sp.onaudioprocess = (e) => { const b = e.inputBuffer, l = b.getChannelData(0), r = b.numberOfChannels > 1 ? b.getChannelData(1) : l; const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2; store.push(m); };
        return sp;
      };
      this.__post = mk(T.post); this.__pre = mk(T.pre);
    }
  }
  window.AudioContext = Tap; window.webkitAudioContext = Tap;
  AudioNode.prototype.connect = function (dst, ...rest) {
    const res = origConnect.call(this, dst, ...rest);
    try { const c = this.context; if (c && c.__post && this !== c.__post && this !== c.__pre) { if (dst === c.destination) origConnect.call(this, c.__post); else if (typeof WaveShaperNode !== 'undefined' && dst instanceof WaveShaperNode) origConnect.call(this, c.__pre); } } catch (e) { /* the tap never breaks the page */ }
    return res;
  };
  const flat = (store) => { let n = 0; for (const c of store) n += c.length; const out = new Float32Array(n); let o = 0; for (const c of store) { out.set(c, o); o += c.length; } return out; };
  // seconds since the first audible sample (> 1e-3) of the post-limiter signal; null before it
  T.onset = (store) => { const a = flat(store || T.post); for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 1e-3) return i / T.sr; return null; };
  // RMS (25 Hz high-passed, like the oracle comparison) and peak over [from, to) seconds of the capture
  T.stats = (which, from, to) => {
    const a = flat(which === 'pre' ? T.pre : T.post), sr = T.sr, k = 1 - Math.exp(-2 * Math.PI * 25 / sr); let lp = 0, s = 0, n = 0, pk = 0;
    const i0 = Math.floor(from * sr), i1 = Math.min(a.length, Math.floor(to * sr));
    for (let i = 0; i < i1; i++) { lp += k * (a[i] - lp); if (i >= i0) { const y = a[i] - lp; s += y * y; n++; const v = Math.abs(a[i]); if (v > pk) pk = v; } }
    return { rms: n ? Math.sqrt(s / n) : 0, peak: pk, seconds: a.length / sr, n };
  };
  // the peak of the raw signal over everything captured since the second 'from'
  T.peakSince = (which, from) => { const a = flat(which === 'pre' ? T.pre : T.post); let pk = 0; for (let i = Math.floor(from * T.sr); i < a.length; i++) { const v = Math.abs(a[i]); if (v > pk) pk = v; } return pk; };
  T.now = () => flat(T.post).length / T.sr;
})();`;
const db = (x) => 20 * Math.log10(x);

async function key(page, name, hold = 35) {
  const K = { down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], right: ['ArrowRight', 'ArrowRight', 39], a: ['Enter', 'Enter', 13], shift: ['Shift', 'ShiftLeft', 16] }[name];
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: K[0], code: K[1], windowsVirtualKeyCode: K[2] }); await sleep(hold);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: K[0], code: K[1], windowsVirtualKeyCode: K[2] }); await sleep(30);
}
const fresh = async (page, base) => { await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}'); };
const dstate = (page) => page.eval('window.__arenaSound.state().director');

/* ------------------------------------------------------------------------------------------------ the oracle's level of the hub song */
let oracleRms = null, oracleSong = MAP.songFor('soulgold', 'hub').index;
{
  const rig = await MO.openRig('sg');
  const sv = MO.startSongVerified(rig, rig.base, oracleSong); if (!sv.ok) throw new Error('the game did not accept song ' + oracleSong);
  const cap2 = MO.captureFrames(rig.core, Math.round(14 * 59.7275));
  const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
  const f = MO.to32k(all); const hp = MO.hpf(MO.toMono(f.l, f.r));
  oracleRms = MO.rms(hp, 32768 * 2, 32768 * 10);
  console.log('   the real game (mGBA), song ' + oracleSong + ' (hub), RMS over seconds 2..12: ' + oracleRms.toFixed(4));
}
const TOL_DB = 1.5;

/* ------------------------------------------------------------------------------------------------ 1. level at the sink */
/** open the hub with the real engine, press a key, wait for the song, and measure the sink over seconds 2..12 of the song; returns the numbers */
async function levelRun(page, base, { sliders = null, tag = '' } = {}) {
  await fresh(page, base);
  if (sliders) await page.eval(`localStorage.setItem('arena.audio', JSON.stringify(${J({ v: 1, ...sliders, muted: false, soundtrack: 'soulgold' })}))`);
  await page.navigate(base + '/pokemonarena/');
  await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
  const before = await page.eval('window.__tap.ctxs.length');
  await key(page, 'down');
  await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return (d.cur && d.cur.key === 'hub' && d.engineState && d.engineState.playing) || d.error; })()`, { timeoutMs: 120000 });
  const d0 = await dstate(page);
  const gains = await page.eval('window.__arenaSound.mixer.getAudioState().gains');
  await page.waitFor(`window.__tap.onset() !== null`, { timeoutMs: 20000 });
  const onset = await page.eval('window.__tap.onset()');
  const u0 = (await dstate(page)).engineState.underruns;
  await page.waitFor(`window.__tap.now() >= ${onset + 13}`, { timeoutMs: 60000 });
  const st = await page.eval(`window.__tap.stats('post', ${onset + 2}, ${onset + 12})`);
  const d1 = await dstate(page);
  return { tag, before, d0, gains, onset, st, underruns: d1.engineState.underruns - u0, error: d1.error, errors: errsOf(page).filter((x) => !/favicon/.test(x)) };
}

/* ------------------------------------------------------------------------------------------------ 3. a real-time battle */
async function battleRun(page, base, { seconds = 28, cpu = 'hard', until = null } = {}) {       // until: a JS expression over `r` (the counters) that ends the run early once true (after at least 8 s)
  await fresh(page, base);
  await page.eval(`localStorage.setItem('arena.audio', JSON.stringify({ v: 1, master: 1, music: 1, fx: 1, muted: false, soundtrack: 'soulgold' }))`);
  await page.navigate(base + '/pokemonarena/battle.html?seed=7&format=3v3&cpu=' + cpu + '&speed=fast');
  await page.waitFor(`window.${BAT} && ${BAT}.state === 'ready' && window.__arenaSound`, { timeoutMs: 120000 });
  await page.eval(`(() => {
    const h = window.${BAT}.scene.hooks, d = window.__arenaSound.director; const rec = window.__rec = { hits: 0, faints: 0, sounds: 0, byKey: {}, byIndex: {}, soundIdx: {} };
    const oh = h.onHit, of = h.onFaint, os = h.onSound;
    h.onHit = (s, i) => { rec.hits++; return oh && oh(s, i); }; h.onFaint = (s, sp) => { rec.faints++; return of && of(s, sp); }; h.onSound = (i, p) => { rec.sounds++; rec.soundIdx[i] = (rec.soundIdx[i] || 0) + 1; return os && os(i, p); };
    const ps = d.playSfx, pe = d.playEffectIndex;
    d.playSfx = (k, o) => { rec.byKey[k] = (rec.byKey[k] || 0) + 1; return ps(k, o); };
    d.playEffectIndex = (i, p, v) => { rec.byIndex[i] = (rec.byIndex[i] || 0) + 1; return pe(i, p, v); };
  })()`);
  await page.waitFor(`${BAT}.mode === 'preview'`, { timeoutMs: 60000 });
  await key(page, 'shift');                                                    // the first activation: the real context starts
  await page.waitFor(`window.__tap.ctxs.length === 1 && window.__tap.ctxs[0].state === 'running'`, { timeoutMs: 20000 });
  await page.eval(`(() => { const a = window.${BAT}; for (const i of [0, 1, 2]) a.scene.choose.preview(i); })()`);
  await sleep(200); await page.eval(`window.${BAT}.press('a')`);
  const t0 = await page.eval('window.__tap.now()');
  const u0 = await page.eval(`(() => { const e = window.__arenaSound.state().director.engineState; return e ? e.underruns : 0; })()`);
  const deadline = Date.now() + seconds * 1000; let turns = 0, lastMode = '';
  while (Date.now() < deadline) {
    const m = await page.eval(`${BAT}.mode`);
    if (m === 'result') break;
    if (until && (await page.eval(`(() => { const r = window.__rec; return !!(${until}); })()`)) && (await page.eval('window.__tap.now()')) - t0 >= 8) break;
    if (m === 'action') { await page.eval(`${BAT}.press('a')`); await sleep(50); await page.eval(`${BAT}.press('a')`); turns++; }
    else if (m === 'party') { for (let i = 0; i < 6; i++) { await page.eval(`(() => { try { ${BAT}.scene.choose.party(${i}); } catch (e) {} })()`); } }
    else await page.eval(`${BAT}.press('a')`);
    lastMode = m; await sleep(70);
  }
  const rec = await page.eval('window.__rec');
  const u1 = await page.eval(`(() => { const e = window.__arenaSound.state().director.engineState; return e ? e.underruns : 0; })()`);
  return { rec, turns, lastMode, seconds: (await page.eval('window.__tap.now()')) - t0, underruns: u1 - u0, post: await page.eval(`window.__tap.peakSince('post', ${t0})`), pre: await page.eval(`window.__tap.peakSince('pre', ${t0})`), state: await page.eval('window.__arenaSound.state()'), errors: errsOf(page).filter((x) => !/favicon/.test(x)) };
}

// a hub whose second team is illegal (hub_test.mjs's own fixture, trimmed): START on it is refused
const FAKE_HUB = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', teams: [
  { id: 't1', name: 'Kanto Squad', size: 3, legal: true, problems: 0, names: ['Pikachu', 'Charizard', 'Snorlax'], lead: { species: 25 } },
  { id: 't2', name: 'Duo', size: 2, legal: false, problems: 2, names: ['Mew', 'Mewtwo'], lead: { species: 150 } }] },
  { id: 'p2', name: 'BLUE', teams: [{ id: 't9', name: 'Blue Team', size: 4, legal: true, problems: 0, names: ['A', 'B', 'C', 'D'], lead: { species: 131 } }] }] };
/** the real hub, a real key press unlocks the sound, then START on the illegal team through the real key path (Down, A, Down, Right, Down x3, A) */
async function hubRefusedRun(page, base) {
  await fresh(page, base); await page.navigate(base + '/pokemonarena/');
  await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
  await key(page, 'shift');
  await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return (d.cur && d.cur.key === 'hub' && d.engineState && d.engineState.playing) || d.error; })()`, { timeoutMs: 120000 });
  await page.eval(`window.${HUB}.model.setData(${J(FAKE_HUB)})`);
  for (const k of ['down', 'a', 'down', 'right', 'down', 'down', 'down']) await key(page, k, 45);
  const before = await page.eval('window.__arenaSound.state().menuSfx.length');
  await key(page, 'a', 45); await sleep(300);
  const s = await page.eval('window.__arenaSound.state()');
  const view = await page.eval(`JSON.stringify(window.${HUB}.view())`);
  return { menuSfx: s.menuSfx, added: s.menuSfx.slice(before), sfx: s.director.sfx, flash: /Fix 2 problems/.test(view), err: s.director.error, errors: errsOf(page).filter((x) => !/favicon/.test(x)) };
}
/** the real battle page, the sound unlocked, the player's Pokemon pushed into the red zone and back out through the scene's own display state */
async function lowHpRun(page, base) {
  await fresh(page, base); await page.navigate(base + '/pokemonarena/battle.html?seed=7&format=3v3&cpu=normal&speed=fast');
  await page.waitFor(`window.${BAT} && ${BAT}.state === 'ready' && window.__arenaSound`, { timeoutMs: 120000 });
  await page.waitFor(`${BAT}.mode === 'preview'`, { timeoutMs: 60000 });
  await key(page, 'shift');
  await page.waitFor(`window.__tap.ctxs.length === 1 && window.__tap.ctxs[0].state === 'running'`, { timeoutMs: 20000 });
  await page.eval(`(() => { const a = window.${BAT}; for (const i of [0, 1, 2]) a.scene.choose.preview(i); })()`);
  await sleep(200); await page.eval(`window.${BAT}.press('a')`);
  await page.waitFor(`${BAT}.mode === 'action'`, { timeoutMs: 90000 });
  await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return d.engine && d.cur; })()`, { timeoutMs: 60000 });
  await sleep(500);
  const lh = () => page.eval('window.__arenaSound.state().lowHp');
  const sfxOf = () => page.eval(`window.__arenaSound.state().director.sfx.filter((e) => e.key === 'se_lowhp').map((e) => ({ index: e.index, played: e.played }))`);
  const l0 = await lh();
  await page.eval(`(() => { const d = window.${BAT}.scene.S.disp[0]; d.maxHp = 40; d.hp = 3; })()`);
  await page.waitFor(`window.__arenaSound.state().lowHp.on === true`, { timeoutMs: 5000 }).catch(() => {});
  await sleep(300);
  const l1 = await lh(), s1 = await sfxOf(), eff1 = await page.eval('window.__arenaSound.state().director.engineState.effects');
  await sleep(2500);                                             // the beep (2.4 s in SoulGold) is over; the Pokemon is still red: nothing starts again
  const l2 = await lh();
  await page.eval(`window.${BAT}.scene.S.disp[0].hp = 40`);
  await page.waitFor(`window.__arenaSound.state().lowHp.on === false`, { timeoutMs: 5000 }).catch(() => {});
  await sleep(200);
  const l3 = await lh();
  await page.eval(`window.${BAT}.scene.S.disp[0].hp = 2`);
  await page.waitFor(`window.__arenaSound.state().lowHp.plays === 2`, { timeoutMs: 5000 }).catch(() => {});
  const l4 = await lh();
  return { l0, l1, s1, eff1, l2, l3, l4, sfxAll: await sfxOf(), errors: errsOf(page).filter((x) => !/favicon/.test(x)), err: await page.eval('window.__arenaSound.state().director.error') };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-real-mut-'));
const server = await L.startServer();
try {
  await lockedBrowser({ port: cdp++, width: 1280, height: 800 }, async (page) => {
    await addInit(page, TAP_SRC);

    head('1. the level at the sink: the hub song at the default sliders vs the real game');
    const A = await levelRun(page, BASE, { tag: 'default' });
    const dA = db(A.st.rms / oracleRms);
    console.log('   default sliders: bus gains ' + J(A.gains) + '; sink RMS ' + A.st.rms.toFixed(4) + ' peak ' + A.st.peak.toFixed(3) + ' over song seconds 2..12 (' + (dA >= 0 ? '+' : '') + dA.toFixed(2) + ' dB from the real game\'s ' + oracleRms.toFixed(4) + '); underruns ' + A.underruns);
    C.ok(A.before === 0 && A.d0.engine && !A.error && A.errors.length === 0, 'level: the real engine played the hub song on the REAL AudioContext (no error)', J({ err: A.error, errors: A.errors }));
    C.ok(Math.abs(dA) <= TOL_DB, 'level: at the DEFAULT sliders the sink is ' + (dA >= 0 ? '+' : '') + dA.toFixed(2) + ' dB from the real game (tolerance +-' + TOL_DB + ' dB): a first-time player hears the music at the level the game plays it', J({ sink: A.st.rms, game: oracleRms }));
    const g = A.gains || {};
    C.ok(Math.abs((g.master || 0) - 1) < 1e-3 && Math.abs((g.music || 0) - 1) < 1e-3 && Math.abs((g.fx || 0) - 1) < 1e-3, 'level: the three buses are at gain 1.0 at the defaults', J(g));
    C.ok(A.st.peak <= AM.LIMIT_CEIL + 1e-6 && A.st.rms > 0.02, 'level: the sink peak ' + A.st.peak.toFixed(3) + ' is under the limiter ceiling and the RMS ' + A.st.rms.toFixed(4) + ' is far above the old defaults\' 0.009-0.015');
    C.ok(A.underruns === 0, 'level: no underrun while the hub song played for 12 s on the real clock (' + A.underruns + ')');

    const B = await levelRun(page, BASE, { tag: 'max', sliders: { master: 1, music: 1, fx: 1 } });
    const dB = db(B.st.rms / A.st.rms);
    console.log('   every slider at 100%: sink RMS ' + B.st.rms.toFixed(4) + ' peak ' + B.st.peak.toFixed(3) + ' (' + (dB >= 0 ? '+' : '') + dB.toFixed(2) + ' dB over the default)');
    C.ok(Math.abs(dB - 6.02) <= 1.0, 'level: with master and music at 100% the sink is ' + dB.toFixed(2) + ' dB over the default (+3 dB per bus = +6 dB; tolerance 1 dB), so the defaults are not the top of the range', J({ def: A.st.rms, max: B.st.rms }));
    C.ok(B.st.peak <= AM.LIMIT_CEIL + 1e-6, 'level: and even there the sink peak ' + B.st.peak.toFixed(3) + ' stays at or under the limiter ceiling ' + AM.LIMIT_CEIL);

    head('2. the result sequence in real time (director.result), underruns counted');
    {
      await fresh(page, BASE); await page.navigate(BASE + '/pokemonarena/');
      await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready' && window.__arenaSound`, { timeoutMs: 60000 });
      await key(page, 'down');
      await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return (d.cur && d.cur.key === 'hub') || d.error; })()`, { timeoutMs: 120000 });
      const idx = (k) => MAP.songFor('soulgold', k).index;
      for (const [outcome, first, then] of [['win', 'victory_sting', 'result_win'], ['lose', 'defeat', 'result_lose'], ['draw', null, 'result_lose']]) {
        await page.eval(`window.__arenaSound.director.set('hub')`);
        await page.waitFor(`(() => { const d = window.__arenaSound.state().director; return d.cur && d.cur.key === 'hub'; })()`, { timeoutMs: 20000 });
        await sleep(1500);
        const u0 = (await dstate(page)).engineState.underruns, t0 = await page.eval('window.__tap.now()');
        const pre = (await dstate(page)).cur;
        await page.eval(`window.__arenaSound.director.result('${outcome}')`);
        const seen = []; const start = Date.now(); let last = pre ? pre.index : null;
        while (Date.now() - start < 45000) {
          const d = await dstate(page); const cur = d.cur ? d.cur.index : null;
          if (cur !== last) { seen.push({ index: cur, key: d.cur ? d.cur.key : null, atMs: Date.now() - start }); last = cur; }
          if (seen.length >= (first ? 2 : 1) && seen[seen.length - 1].key === then && Date.now() - start > seen[seen.length - 1].atMs + 2500) break;
          await sleep(100);
        }
        const d1 = await dstate(page), u1 = d1.engineState.underruns, t1 = await page.eval('window.__tap.now()');
        const keys = seen.map((s) => s.key).filter((k) => k !== null);
        const jingleMs = first ? (seen.find((s) => s.key === then) || { atMs: 0 }).atMs - (seen.find((s) => s.key === first) || { atMs: 0 }).atMs : 0;
        const sink = await page.eval(`(() => { const a = window.__tap.stats('post', ${t0 + 0.5}, ${t1}); return a; })()`);
        console.log('   ' + outcome + ': ' + seen.map((s) => s.key + '(' + s.index + ')@' + (s.atMs / 1000).toFixed(1) + 's').join(' -> ') + (first ? '; the fanfare lasted ' + (jingleMs / 1000).toFixed(1) + ' s' : '') + '; underruns ' + (u1 - u0) + '; sink RMS ' + sink.rms.toFixed(3) + ' peak ' + sink.peak.toFixed(3));
        C.ok(J(keys) === J(first ? [first, then] : [then]), 'result ' + outcome + ': the songs play in this order: ' + (first ? first + ' (' + idx(first) + ') then ' : '') + then + ' (' + idx(then) + ')', J(seen));
        if (first) C.ok(jingleMs >= 1500 && jingleMs <= 15000, 'result ' + outcome + ': the fanfare was allowed to play to its own end before the result song started (' + (jingleMs / 1000).toFixed(1) + ' s; a fanfare cut short would be < 1.5 s)', J({ jingleMs }));
        C.ok(!d1.error && d1.cur && d1.cur.key === then && d1.engineState.playing, 'result ' + outcome + ': ' + then + ' is playing when the sequence is over, no error', J({ cur: d1.cur, err: d1.error }));
        C.ok(u1 - u0 === 0, 'result ' + outcome + ': 0 underruns during the whole sequence on the real clock (' + (u1 - u0) + ')');
        C.ok(sink.rms > 0.01 && sink.peak <= AM.LIMIT_CEIL + 1e-6, 'result ' + outcome + ': the sink carried sound all the way through (RMS ' + sink.rms.toFixed(3) + ') and stayed under the ceiling');
      }
      C.ok(errsOf(page).filter((x) => !/favicon/.test(x)).length === 0, 'result: no page or console error', J(errsOf(page)));
    }

    head('3. the worst case in a REAL battle: every slider at 100%, real cries, move sounds, hit and faint sounds, the battle song');
    const W = await battleRun(page, BASE, { seconds: 75, until: 'r.hits >= 3 && r.faints >= 1' });
    const faintIdx = MAP.songFor('soulgold', 'se_faint').index;
    console.log('   ' + W.seconds.toFixed(0) + ' s of real time, ' + W.turns + ' turns, last mode ' + W.lastMode + '; hits ' + W.rec.hits + ', faints ' + W.rec.faints + ', animator sounds ' + W.rec.sounds + ' (distinct ' + Object.keys(W.rec.soundIdx).length + '); cries ' + W.state.plays + '; underruns ' + W.underruns + '; sink peak ' + W.post.toFixed(3) + ' (before the limiter ' + W.pre.toFixed(3) + ')');
    C.ok(W.seconds >= 8 && W.rec.hits >= 2 && W.state.plays >= 2 && W.rec.sounds >= 5, 'battle: a real battle ran in real time with hits, cries and animator sounds (' + W.seconds.toFixed(0) + ' s, ' + W.rec.hits + ' hits, ' + W.state.plays + ' cries, ' + W.rec.sounds + ' animator sounds)', J({ s: W.seconds, hits: W.rec.hits, plays: W.state.plays, sounds: W.rec.sounds }));
    C.ok(W.post <= AM.LIMIT_CEIL + 1e-6, 'battle: the sink peak over the whole battle is ' + W.post.toFixed(3) + ' <= ' + AM.LIMIT_CEIL + ' (the limiter\'s ceiling): NO CLIPPING with music, cries and effects together at 100% / 100% / 100%');
    C.ok(W.pre > 1.0, 'battle control: BEFORE the limiter the same signal reached ' + W.pre.toFixed(3) + ' (> 1.0): without it this battle would clip', J({ pre: W.pre }));
    const hitSfx = Object.entries(W.rec.byKey).filter(([k]) => /^se_hit_/.test(k)).reduce((s, [, n]) => s + n, 0);
    C.ok(hitSfx === W.rec.hits && W.rec.hits > 0, 'battle: one effectiveness sound per damaging hit (' + hitSfx + ' sounds for ' + W.rec.hits + ' hits): the animator delivers no such sound, so the hook plays it', J(W.rec.byKey));
    C.ok(!Object.keys(W.rec.soundIdx).some((i) => [12, 13, 14].includes(Number(i))), 'battle: the animator delivered ' + Object.keys(W.rec.soundIdx).length + ' distinct sounds (' + Object.keys(W.rec.soundIdx).sort((a, b) => a - b).join(',') + ') and NONE of the effectiveness sounds 12 / 13 / 14: that is why "the animator has sounds" must not silence the hit hook', J(W.rec.soundIdx));
    C.ok((W.rec.byKey.se_faint || 0) === W.rec.faints && (W.rec.byIndex[faintIdx] || 0) === 0, 'battle: one faint sound per faint (' + (W.rec.byKey.se_faint || 0) + ' for ' + W.rec.faints + ' faints); the animator\'s own copy of sound ' + faintIdx + ' (it delivered ' + (W.rec.soundIdx[faintIdx] || 0) + ') was dropped, not doubled (' + (W.rec.byIndex[faintIdx] || 0) + ' reached the engine)', J({ byKey: W.rec.byKey, byIndex: W.rec.byIndex, sound: W.rec.soundIdx[faintIdx] }));
    C.ok(W.errors.length === 0 && !W.state.director.error, 'battle: no page or console error, no engine error', J({ errors: W.errors, err: W.state.director.error }));
    console.log('   (underruns during the battle: ' + W.underruns + ' - reported, not asserted: this page also runs the animation CPU and the engine on one thread)');
    try { await page.screenshot(path.join(OUT, 'battle_real.png')); } catch (_e) { /* ignore */ }

    head('4. a refused START in the hub is heard as the ERROR buzz (SE 32) through the real key path and the real engine');
    const H = await hubRefusedRun(page, BASE);
    const errIdx = MAP.songFor('soulgold', 'se_error').index, lowIdx = MAP.songFor('soulgold', 'se_lowhp').index;
    console.log('   START on the illegal team: ' + (H.flash ? 'the text box says "Fix 2 problems..."' : 'NO refusal message') + '; the sounds of the last press: ' + J(H.added) + '; engine sfx tail ' + J(H.sfx.slice(-2)));
    C.ok(H.flash, 'hub: START on the illegal team was REFUSED (the hub\'s text box says "Fix 2 problems in the TEAM BUILDER first")');
    C.ok(H.added.length === 1 && H.added[0] === 'se_error', 'hub: that refused press played se_error (the error buzz), not the select sound', J(H.added));
    C.ok(H.sfx.length > 0 && H.sfx[H.sfx.length - 1].key === 'se_error' && H.sfx[H.sfx.length - 1].index === errIdx && H.sfx[H.sfx.length - 1].played === true, 'hub: and the REAL engine accepted it (song ' + errIdx + ', SE-FAILURE)', J(H.sfx.slice(-1)));
    C.ok(H.menuSfx.slice(0, -1).every((k) => k !== 'se_error') && H.errors.length === 0 && !H.err, 'hub: the presses before it (cursor moves, A) made their ordinary sounds, no page error', J({ menuSfx: H.menuSfx, errors: H.errors }));

    head('5. the low-HP warning in a REAL battle page with the real engine: starts once in the red zone, not again, stops when healed, starts again');
    const LH = await lowHpRun(page, BASE);
    console.log('   lowHp state: before ' + J(LH.l0) + ' | in the red ' + J(LH.l1) + ' (engine effects ' + LH.eff1 + ') | 2.5 s later ' + J(LH.l2) + ' | healed ' + J(LH.l3) + ' | red again ' + J(LH.l4) + '; sfx ' + J(LH.sfxAll));
    C.ok(LH.l0.on === false && LH.l0.plays === 0, 'low HP: at the start of the battle no warning', J(LH.l0));
    C.ok(LH.l1.on === true && LH.l1.plays === 1 && LH.s1.length === 1 && LH.s1[0].index === lowIdx && LH.s1[0].played === true && LH.eff1 >= 1, 'low HP: the player\'s Pokemon at 3 of 40 HP starts the warning ONCE (song ' + lowIdx + ', accepted by the real engine, sounding)', J({ l1: LH.l1, s1: LH.s1, eff1: LH.eff1 }));
    C.ok(LH.l2.on === true && LH.l2.plays === 1, 'low HP: 2.5 s later, still red: it did not start again (the game\'s once-per-stay rule)', J(LH.l2));
    C.ok(LH.l3.on === false && LH.l3.stops === 1, 'low HP: healed to 40 of 40 the warning is stopped (the game\'s m4aSongNumStop)', J(LH.l3));
    C.ok(LH.l4.plays === 2 && LH.l4.on === true, 'low HP: and the next entry into the red zone starts it again', J(LH.l4));
    C.ok(LH.errors.length === 0 && !LH.err, 'low HP: no page error, no engine error', J({ errors: LH.errors, err: LH.err }));

    if (!ARGS.has('--no-mutants')) {
      head('negative controls: overlay copies of the page with ONE defect, the same measurements');
      let port = Number(process.env.ARENA_OVERLAY_PORT || 18105) + 40;
      const overlay = async (name, rel, from, to) => { const d = copyTree(PA, path.join(TMP, name)); mutateFile(d, rel, from, to); return startOverlay({ dir: d, port: port++, upstream: BASE }); };
      // (a) the OLD square law: the same default sliders now measure about -15 dB
      {
        const ov = await overlay('oldlaw', 'js/audio_mixer.js', 'if (x <= v0) return (x / v0) * (x / v0);\n  return 1 + (GAIN_MAX - 1) * ((x - v0) / (1 - v0));', 'return x * x;');
        try {
          const M = await levelRun(page, ov.url, { tag: 'old law' }); const dM = db(M.st.rms / oracleRms);
          console.log('   OLD LAW overlay: sink RMS ' + M.st.rms.toFixed(4) + ' (' + dM.toFixed(2) + ' dB from the real game)');
          C.ok(Math.abs(dM) > TOL_DB * 4 && Math.abs(dM + 15.1) < 1.5, 'control: the same page with the OLD law measures ' + dM.toFixed(1) + ' dB from the game (about -15) and FAILS the +-' + TOL_DB + ' dB check: the sink-level test discriminates', J({ sink: M.st.rms }));
        } finally { ov.stop(); }
      }
      // (b) no soft limiter: the same battle clips at the top of the sliders
      {
        const ov = await overlay('nolimiter', 'js/audio_mixer.js', "if (typeof ctx.createWaveShaper === 'function') { try {", 'if (false) { try {');
        try {
          const M = await battleRun(page, ov.url, { seconds: 40, until: 'r.hits >= 2' });
          console.log('   NO-LIMITER overlay: sink peak ' + M.post.toFixed(3) + ' over ' + M.seconds.toFixed(0) + ' s of the same battle');
          C.ok(M.post > 1.0, 'control: the same battle WITHOUT the limiter reaches a sink peak of ' + M.post.toFixed(3) + ' (> 1.0 = clipping), so the clean peak above is the limiter\'s doing', J({ post: M.post }));
        } finally { ov.stop(); }
      }
      // (d) the hub does not pass the model's effects on: a refused START is only a select sound again
      {
        const ov = await overlay('noerr', 'js/boot.js', "soundSys.menuSfx(e.action, before !== soundSys.sig(model.state()), true, fx); return; }", "soundSys.menuSfx(e.action, before !== soundSys.sig(model.state()), true); return; }");
        try {
          const M = await hubRefusedRun(page, ov.url);
          C.ok(M.flash && !(M.added.length === 1 && M.added[0] === 'se_error'), 'control: with the hub\'s effects not passed to the sound system the refused START plays ' + J(M.added) + ' instead of se_error: the check above discriminates', J(M.added));
        } finally { ov.stop(); }
      }
      // (e) the warning is never started
      {
        const ov = await overlay('nolow', 'js/sound_system.js', "const h = director.playSfx('se_lowhp');", 'const h = null;');
        try {
          const M = await lowHpRun(page, ov.url);
          C.ok(M.s1.length === 0 && M.eff1 === 0, 'control: with the playSfx call removed the same run starts NO warning (' + M.s1.length + ' sfx entries, ' + M.eff1 + ' engine effects): the low-HP check discriminates', J({ s1: M.s1, eff1: M.eff1 }));
        } finally { ov.stop(); }
      }
      // (c) the old "the first animator sound switches the hit sound off" rule: the real battle loses its hit sounds
      {
        const ov = await overlay('hitgate', 'js/sound_system.js', "chain('onHit', (_side, info) => { playKey(HIT_KEY(info && info.eff)); });", "chain('onHit', (_side, info) => { if (!S.animSounds) playKey(HIT_KEY(info && info.eff)); });");
        try {
          const M = await battleRun(page, ov.url, { seconds: 60, until: 'r.hits >= 2' });
          const hs = Object.entries(M.rec.byKey).filter(([k]) => /^se_hit_/.test(k)).reduce((s, [, n]) => s + n, 0);
          console.log('   HIT-GATE overlay: ' + hs + ' effectiveness sounds for ' + M.rec.hits + ' hits');
          C.ok(M.rec.hits > 0 && hs < M.rec.hits, 'control: with the old gate (the first animator sound switches the hit hook off) only ' + hs + ' of ' + M.rec.hits + ' hits made their sound, which is the regression the coordinator saw', J(M.rec.byKey));
        } finally { ov.stop(); }
      }
    }
  });
} finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ } L.stopServer(server); L.reapLeaks(); }
C.finish();
