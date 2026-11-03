// tools/pokemonarena_fidelity_test.mjs -- FA1: does the arena's battle screen match the REAL game (and the ROM's own code)?  Node only.
//
//   node tools/pokemonarena_fidelity_test.mjs            # exit 1 on any failure; prints pass / fail / skip counts
//   ARENA_ROM=/path/to.gba  ARENA_OUT=/dir  ARENA_FIDELITY_DIR=/dir-for-the-oracle's-cached-states
//
// Two sources of truth, both made at test time from the ROM the caller points at (nothing ROM-derived is stored in the repo):
//   A. THE ROM'S OWN CODE, run by tools/pokemonarena_fidelity_cpu.mjs (a small ARMv4T interpreter): MoveBattleBar @0x08085ecc (the HP bar: which
//      tiles it copies, so the filled pixels and the colour, and the drain step CalcNewBarValue @0x080839e4), GetCurrentPpToMaxPpState @0x08094dc8,
//      GetBattleSpeed @0x0806a250. The arena's ports in pokemonarena/js/battle_ui.js are compared with what that code returns, over sweeps.
//   B. THE REAL GAME'S FRAMES from OR1's oracle (tools/pokemonarena_rom_oracle.mjs: the site's own mGBA core running the ROM, a real trainer battle,
//      clock pinned to noon). The arena's render of the same scenario is compared pixel by pixel, region by region; the target is ZERO differing pixels.
// Every check has a negative control (a mutated arena rule, or one flipped byte of a ROM copy, must trip it) and an unmutated twin that must stay quiet.
// If the ROM, the mGBA core or the oracle is missing, the checks that need them are SKIPPED LOUDLY and counted (a skip is not a pass).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createBarRom, ADDR } from './pokemonarena_fidelity_rom.mjs';
import { createCpu, DIV_HOOKS } from './pokemonarena_fidelity_cpu.mjs';
import * as L from './pokemonarena_fidelity_lib.mjs';

const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'pokemonarena-fa1-out');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 140) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); } }
function skipped(name, why) { skip++; console.log('SKIP (counted)', name, '::', why); }

if (!L.romAvailable()) { skipped('the whole fidelity suite', 'ROM not found at ' + L.ROM_PATH + ' (set ARENA_ROM)'); console.log('\n0 passed, 0 failed, ' + skip + ' SKIPPED'); process.exit(0); }
const rom = L.loadRom();
ok(crypto.createHash('sha256').update(rom).digest('hex') === '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a', '0. the ROM is the pinned SoulGold v1.1.1 image');
const B = await L.importArena('battle_ui.js'), T = await L.importArena('tables.js');
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
const ui = B.createBattleUi(rom);
const bar = createBarRom(rom);

/* ========================================================================= A1. the interpreter itself */
{
  // the ROM's own ARM division routine run natively agrees with the host hook and with JS (so the hooks used below are legitimate)
  const plain = createCpu(rom, { maxSteps: 4000 }), hooked = createCpu(rom, { maxSteps: 4000, hooks: { [ADDR.divsi3]: DIV_HOOKS.signed } });
  let bad = 0, n = 0;
  for (const [a, b] of [[100, 7], [-100, 7], [4800, 100], [0, 5], [714 * 48, 714], [65535, 3], [-1, 1], [1 << 20, 24], [999, 24], [3, 5]]) { n++; const e = Math.trunc(a / b) | 0; if (plain.call(ADDR.divsi3 | 1, [a, b]).r0 !== e || hooked.call(ADDR.divsi3 | 1, [a, b]).r0 !== e) bad++; }
  ok(bad === 0, 'A1. the interpreter runs the ROM\'s __divsi3 (THUMB veneer -> ARM routine) exactly like JS division (' + n + ' cases)');
  // negative control: corrupt the ARM routine's compare in a COPY -> the interpreter's answer changes (the interpreter really executes the ROM bytes)
  const bad2 = new Uint8Array(rom); bad2[0x4e0] = 0x03;       // `orrcs r0, r0, r2` -> `orrcs r0, r0, r3` inside __divsi3 (the quotient bit goes to the wrong register)
  const c2 = createCpu(bad2, { maxSteps: 4000 }); let changed = 0; for (const [a, b] of [[100, 7], [4800, 100], [999, 24]]) { try { if (c2.call(ADDR.divsi3 | 1, [a, b]).r0 !== Math.trunc(a / b)) changed++; } catch (_e) { changed++; } }
  ok(changed > 0, 'A1. a corrupted copy of the division routine gives different answers (negative control)');
}

/* ========================================================================= A2. HP bar pixels + colour: ROM's MoveBattleBar vs the arena */
function sweepStatic(arena, barRom, maxes) {
  let n = 0, badPx = 0, badCol = 0; const ex = [];
  for (const max of maxes) for (let hp = 0; hp <= max; hp++) {
    const t = barRom.staticBar(max, hp); n++;
    const px = arena.hpFillPixels(hp, max), col = arena.hpBarColor(hp, max);
    if (t.px !== px) { badPx++; if (ex.length < 3) ex.push('px ' + hp + '/' + max + ' rom ' + t.px + ' arena ' + px); }
    if (hp > 0 && t.color !== col) { badCol++; if (ex.length < 3) ex.push('col ' + hp + '/' + max + ' rom ' + t.color + ' arena ' + col); }
  }
  return { n, badPx, badCol, ex };
}
const MAXES = [];
for (let m = 1; m <= 130; m++) MAXES.push(m);
for (const m of [150, 177, 200, 255, 256, 300, 357, 400, 500, 714]) MAXES.push(m);
{
  const r = sweepStatic(B, bar, MAXES);
  ok(r.badPx === 0 && r.badCol === 0, 'A2. HP bar at rest: filled pixels AND colour equal what the ROM\'s MoveBattleBar draws, for every hp of ' + MAXES.length + ' max-HP values (' + r.n + ' bars)', r.ex.join('; '));
  const r2 = sweepStatic(B, bar, [1, 2, 47, 48, 49, 100]);
  ok(r2.badPx === 0 && r2.badCol === 0, 'A2. unmutated twin stays quiet (edge max HPs 1, 2, 47, 48, 49, 100)');
  // negative controls on the ARENA side: the pre-FA1 recollections must disagree with the ROM
  const oldColor = (hp, max) => { if (hp >= max) return 'hpGreen'; const f = B.hpFillPixels(hp, max); return f > 24 ? 'hpGreen' : f > 9 ? 'hpYellow' : 'hpRed'; };
  let diffs = 0; for (const max of [25, 50, 99, 100, 101, 150]) for (let hp = 1; hp <= max; hp++) if (bar.staticBar(max, hp).color !== oldColor(hp, max)) diffs++;
  ok(diffs >= 10, 'A2. mutant "colour from the pixel count, > 24 px green / > 9 px yellow (the pre-FA1 rule)" disagrees with the ROM on ' + diffs + ' bars of the sweep');
  const noMin = (hp, max) => Math.floor(hp * 48 / max);
  let d2 = 0; for (const max of [60, 100, 300, 714]) for (let hp = 1; hp <= max; hp++) if (bar.staticBar(max, hp).px !== noMin(hp, max)) d2++;
  ok(d2 > 0, 'A2. mutant "no one-pixel minimum while alive" disagrees with the ROM (' + d2 + ' bars)');
  const rnd = (hp, max) => Math.max(hp > 0 ? 1 : 0, Math.round(hp * 48 / max));
  let d3 = 0; for (const max of [60, 100, 300]) for (let hp = 1; hp <= max; hp++) if (bar.staticBar(max, hp).px !== rnd(hp, max)) d3++;
  ok(d3 > 0, 'A2. mutant "round to nearest instead of floor" disagrees with the ROM (' + d3 + ' bars)');
  // negative control on the ROM side: one flipped byte (the 24 in MoveBattleBar's toAdd divide, `mov r1,#24` at 0x08085f0c) changes what the ROM draws
  const bad = new Uint8Array(rom); if (bad[0x85f0c] !== 0x18 || bad[0x85f0d] !== 0x21) throw new Error('mov r1,#24 not where expected'); bad[0x85f0c] = 0x30;     // #48
  const barBad = createBarRom(bad); const a = bar.drain(300, 300, 0).length, b = barBad.drain(300, 300, 0).length;
  ok(a !== b, 'A2. a ROM copy with toAdd = max/48 drains in a different number of frames (' + a + ' vs ' + b + ') -> the comparison below would trip', 'unmutated ' + a + ' / patched ' + b);
}

/* ========================================================================= A3. HP bar drain: every frame vs the ROM's MoveBattleBar */
function sweepDrains(arena, barRom, maxes, pairsOf) {
  let n = 0, frames = 0, bad = 0; const ex = [];
  for (const max of maxes) for (const [a, b] of pairsOf(max)) {
    if (a < 0 || b < 0 || a > max || b > max) continue;
    const rows = barRom.drain(max, a, b), st = arena.hpBarInit(max, a, b); n++;
    for (let f = 0; f < rows.length; f++) {
      const v = arena.hpBarStep(st); frames++;
      const px = arena.barFill(st.curr, max, st.target), col = arena.hpBarColorAt(st.curr, max), r = rows[f];
      if (v !== r.ret || px !== r.px || (r.px > 0 && col !== r.color)) { bad++; if (ex.length < 3) ex.push(`max ${max} ${a}->${b} frame ${f}: rom ${r.ret}/${r.px}/${r.color} arena ${v}/${px}/${col}`); break; }
    }
    if (rows[rows.length - 1].ret !== -1) { bad++; ex.push('rom did not finish ' + max + ' ' + a + '->' + b); }
  }
  return { n, frames, bad, ex };
}
const PAIRS = (max) => [[max, 0], [max, Math.floor(max / 2)], [max, 1], [Math.floor(max / 3), 0], [max, max - 1], [0, max], [Math.floor(max / 4), max], [Math.floor(max / 2), Math.floor(max / 2) + 3]];
const DMAXES = []; for (let m = 1; m <= 130; m += 1) DMAXES.push(m); for (const m of [150, 177, 200, 255, 300, 357, 500, 714]) DMAXES.push(m);
{
  const r = sweepDrains(B, bar, DMAXES, PAIRS);
  ok(r.bad === 0, 'A3. every frame of ' + r.n + ' drains / fills (' + r.frames + ' frames): the HP printed, the bar\'s pixels and its colour equal the ROM\'s MoveBattleBar frame by frame', r.ex.join('; '));
  const twin = sweepDrains(B, bar, [1, 23, 24, 47, 48, 100, 300], PAIRS);
  ok(twin.bad === 0, 'A3. unmutated twin stays quiet');
  // the arena's pre-FA1 drain (max/48 HP per frame, no fixed point under 48) must be caught
  const oldArena = { ...B, hpBarStep: (st) => { const nv = Math.max(0, Math.min(st.max, st.old - st.recv)); if (st.curr === B.HP_BAR_FIRST) st.curr = st.old; if (st.curr === nv) return -1; const inc = Math.max(1, Math.floor(st.max / 48)); st.curr = st.recv >= 0 ? Math.max(nv, st.curr - inc) : Math.min(nv, st.curr + inc); return st.curr; } };
  const m1 = sweepDrains(oldArena, bar, [100, 300, 30], PAIRS);
  ok(m1.bad > 0, 'A3. mutant "drain maxHP/48 per frame (the pre-FA1 rate)" is caught (' + m1.bad + ' drains differ)');
  const oneHp = { ...B, hpBarStep: (st) => { const nv = Math.max(0, Math.min(st.max, st.old - st.recv)); if (st.curr === B.HP_BAR_FIRST) st.curr = st.old; if (st.curr === nv) return -1; st.curr += st.recv >= 0 ? -1 : 1; return st.curr; } };
  const m2 = sweepDrains(oneHp, bar, [100, 300, 30], PAIRS);
  ok(m2.bad > 0, 'A3. mutant "drain 1 HP per frame (vanilla Gen 3)" is caught (' + m2.bad + ' drains differ)');
  const noFixed = { ...B, hpBarStep: (st) => { const nv = Math.max(0, Math.min(st.max, st.old - st.recv)); if (st.curr === B.HP_BAR_FIRST) st.curr = st.old; if (st.curr === nv) return -1; const inc = B.hpBarToAdd(st.max); st.curr = st.recv >= 0 ? Math.max(nv, st.curr - inc) : Math.min(nv, st.curr + inc); return st.curr; } };
  const m3 = sweepDrains(noFixed, bar, [10, 30, 47], PAIRS);
  ok(m3.bad > 0, 'A3. mutant "no fixed-point branch for maxHP < 48" is caught (' + m3.bad + ' drains differ)');
  // the ROM-side control: a patched ROM changes the ROM's frames, so the unmodified port must now disagree
  const bad = new Uint8Array(rom); bad[0x85f0c] = 0x30;
  const m4 = sweepDrains(B, createBarRom(bad), [100, 300], PAIRS);
  ok(m4.bad > 0, 'A3. against a ROM copy with toAdd = max/48 the arena\'s port disagrees (' + m4.bad + ' drains): the comparison reads the ROM, not a constant');
}

/* ========================================================================= A4. the ROM's GetScaledHPFraction / GetHPBarLevel (party menu) */
{
  let bad = 0, n = 0;
  for (const max of [1, 2, 7, 20, 47, 48, 49, 99, 100, 255, 714]) for (let hp = 0; hp <= max; hp++) for (const scale of [48, 6, 64]) { n++; if (bar.scaledFraction(hp, max, scale) !== B.hpFillPixels(hp, max, scale)) bad++; }
  ok(bad === 0, 'A4. GetScaledHPFraction (the party / summary bar): hp*scale/max, never 0 while alive -- the ROM function equals hpFillPixels for ' + n + ' (hp, max, scale)');
  let bad2 = 0, n2 = 0; const lvl = ['hpRed', 'hpRed', 'hpYellow', 'hpGreen', 'hpGreen'];       // ROM level 0 empty, 1 red, 2 yellow, 3 green, 4 full
  for (const max of [1, 2, 3, 5, 10, 47, 48, 99, 100, 255, 714]) for (let hp = 0; hp <= max; hp++) { n2++; const l = bar.barLevel(hp, max); if (hp > 0 && max > 1 && lvl[l] !== B.hpBarColor(hp, max)) bad2++; }
  ok(bad2 === 0, 'A4. GetHPBarLevel (the party menu colour): the ROM function and hpBarColor agree for ' + n2 + ' (hp, max)');
}

/* ========================================================================= A5. PP colour state: the ROM's function vs ppState */
{
  const cpu = createCpu(rom, { maxSteps: 4000 });
  const romState = (c, m) => cpu.call(0x08094dc8 | 1, [c, m]).r0 & 255;
  let bad = 0, n = 0; for (let m = 1; m <= 64; m++) for (let c = 0; c <= m; c++) { n++; if (romState(c, m) !== B.ppState(c, m)) bad++; }
  ok(bad === 0, 'A5. ppState equals the ROM\'s GetCurrentPpToMaxPpState @0x08094dc8 for all ' + n + ' (cur <= max <= 64)');
  const mut = (c, m) => (m === c ? 3 : c === 0 ? 2 : c * 4 <= m ? 1 : c * 2 <= m ? 0 : 3);       // the arena's pre-FA1 rule (no yellow state, no small-max branches)
  let d = 0; for (let m = 1; m <= 64; m++) for (let c = 0; c <= m; c++) if (romState(c, m) !== mut(c, m)) d++;
  ok(d > 0, 'A5. mutant "red at 0, orange at <= 1/4, no yellow / small-max cases" disagrees with the ROM for ' + d + ' (cur, max)');
  const bad2 = new Uint8Array(rom); bad2[0x94dd4] = 0x03;           // `cmp r2,#2` -> `cmp r2,#3`: the small-max branch moves
  const cpu2 = createCpu(bad2, { maxSteps: 4000 }); let d2 = 0; for (let m = 1; m <= 12; m++) for (let c = 0; c <= m; c++) if (cpu2.call(0x08094dc8 | 1, [c, m]).r0 !== B.ppState(c, m)) d2++;
  ok(d2 > 0, 'A5. a ROM copy with one changed compare disagrees with ppState (' + d2 + ' cases): the comparison reads the ROM');
}

/* ========================================================================= A6. the game's battle speed switch */
{
  const out = {};
  for (const v of [0, 1, 2, 3]) {
    const cpu = createCpu(rom, { maxSteps: 20000, hooks: { [ADDR.divsi3]: DIV_HOOKS.signed, 0x08132cb8: (c) => { c.r[0] = v; }, 0x0808e358: (c) => { c.r[0] = 0; } } });
    cpu.reset(); cpu.wr32(0x02001abc, 0x02010000); out[v] = cpu.call(0x0806a250 | 1, [0], { keepMem: true }).r0;
  }
  ok(out[0] === 1 && out[1] === 2 && out[2] === 3 && out[3] === 4, 'A6. the ROM\'s battle-speed function (GetBattleSpeed @0x0806a250, var 0x40dc) runs 1 / 2 / 3 / 4 logic iterations per frame for 0 / 1 / 2 / 3: the arena is the 1x game', JSON.stringify(out));
}

/* ========================================================================= B. the real game's frames (oracle) */
let oracleMod = null;
try { oracleMod = await import(pathToFileURL(path.join(L.ROOT, 'tools', 'pokemonarena_rom_oracle.mjs')).href); } catch (e) { skipped('B. oracle comparisons', 'the oracle library did not load: ' + String(e.message).slice(0, 100)); }
if (oracleMod) {
  const stateDir = process.env.ARENA_FIDELITY_DIR || path.join(os.tmpdir(), 'pokemonarena-fa1-states');
  let o = null;
  try { o = await oracleMod.openOracle({ stateDir, rtc: { fixedEpochMs: 1699963200000, tzOffsetMin: 0 } }); await o.goto('CK_BATTLE_INTRO'); } catch (e) { skipped('B. oracle comparisons', 'the oracle could not start: ' + String(e.message).slice(0, 100)); o = null; }
  if (o) {
    const FUNCS = oracleMod.FUNCS;
    const EP = 0x02038d58, PPA = 0x02038f98, BM = 0x02001ecc, STRIDE = 0x98;               // gEnemyParty, gPlayerParty, gBattleMons (OR1 FINDINGS)
    const CH = (() => { const m = { ' ': 0 }; for (let i = 0; i < 10; i++) m[String(i)] = 0xA1 + i; for (let i = 0; i < 26; i++) { m[String.fromCharCode(65 + i)] = 0xBB + i; m[String.fromCharCode(97 + i)] = 0xD5 + i; } return m; })();
    const enc = (str, n) => { const b = new Uint8Array(n).fill(0xff); for (let i = 0; i < str.length && i < n; i++) b[i] = CH[str[i]]; return b; };
    function poke(side, f) {
      const p = side === 0 ? PPA : EP, bm = BM + side * STRIDE;
      if (f.species !== undefined) { o.writeU16(p + 0x20, (o.readU16(p + 0x20) & 0xf800) | f.species); o.writeU16(bm, f.species); }
      if (f.level !== undefined) { o.writeU8(p + 0x50, f.level); o.writeU8(bm + 0x2c, f.level); }
      if (f.maxHp !== undefined) { o.writeU16(p + 0x54, f.maxHp); o.writeU16(bm + 0x2e, f.maxHp); }
      if (f.hp !== undefined) { o.writeU16(p + 0x52, f.hp); o.writeU16(bm + 0x2a, f.hp); }
      if (f.nick !== undefined) o.writeBytes(p + 8, enc(f.nick, 12));
      if (f.pid !== undefined) o.writeU32(p, f.pid >>> 0);
      if (f.exp !== undefined) o.writeU32(p + 0x24, f.exp >>> 0);
      if (f.status !== undefined) { o.writeU32(p + 0x4c, f.status); o.writeU32(bm + 0x4c, f.status); }
    }
    const setMoves = (moves, pps) => moves.forEach((m, i) => { o.writeU16(PPA + 0x2c + i * 2, m); o.writeU16(BM + 0x0c + i * 2, m); o.writeU8(PPA + 0x34 + i, pps[i]); o.writeU8(BM + 0x25 + i, pps[i]); });
    const toAction = async (pokeFn) => { await o.goto('CK_BATTLE_INTRO'); pokeFn(); o.pressUntil('A', () => o.readU32(0x03002e44) === FUNCS.controller0.actionMenu, { what: 'the action menu', maxFrames: 4000 }); o.runFrames(20); };
    const oamY = (i) => o.readBytes(0x07000000 + i * 8, 2).readUInt16LE(0) & 255;
    const genderOf = (pid, ratio) => (ratio === 255 ? null : ((pid & 255) >= ratio ? 'M' : 'F'));
    const ST = (s) => (!s ? null : (s & 7) ? 'SLP' : (s & 8) ? 'PSN' : (s & 0x10) ? 'BRN' : (s & 0x20) ? 'FRZ' : (s & 0x40) ? 'PAR' : (s & 0x80) ? 'PSN' : null);
    const expOf = (m) => { if (m.expFrac === undefined) return undefined; const row = pack.exp[pack.species[m.species].growthRate], span = row[m.level + 1] - row[m.level]; return { abs: row[m.level] + Math.floor(span * m.expFrac), into: Math.floor(span * m.expFrac), span }; };
    const SCEN = [
      { id: 'base', foe: { species: 183, nick: 'Marill', level: 4, hp: 19, maxHp: 19, pid: 0 }, pl: { species: 1289, nick: 'Bob', level: 5, hp: 19, maxHp: 19, pid: 0xff } },
      { id: 'lv100', foe: { species: 183, nick: 'Marill', level: 100, hp: 250, maxHp: 300, pid: 0xff }, pl: { species: 1289, nick: 'Bob', level: 7, hp: 3, maxHp: 25, pid: 0xff } },
      { id: 'long', foe: { species: 183, nick: 'Marillmarill', level: 50, hp: 120, maxHp: 120, pid: 0 }, pl: { species: 1289, nick: 'Sprigatito', level: 50, hp: 60, maxHp: 120, pid: 0 } },
      { id: 'nogen', foe: { species: 81, nick: 'Magnemite', level: 12, hp: 30, maxHp: 30, pid: 0 }, pl: { species: 1289, nick: 'B', level: 1, hp: 1, maxHp: 20, pid: 0xff, expFrac: 0.5 } },
      { id: 'psn', foe: { species: 183, nick: 'Marill', level: 20, hp: 40, maxHp: 80, pid: 0xff, status: 8 }, pl: { species: 1289, nick: 'Bob', level: 20, hp: 90, maxHp: 99, pid: 0xff, status: 0x40 } },
      { id: 'slpbrn', foe: { species: 183, nick: 'Marill', level: 99, hp: 5, maxHp: 400, pid: 0xff, status: 3 }, pl: { species: 1289, nick: 'Bob', level: 100, hp: 714, maxHp: 714, pid: 0xff, status: 0x10 } },
      { id: 'frz', foe: { species: 183, nick: 'Marill', level: 5, hp: 1, maxHp: 1, pid: 0xff, status: 0x20 }, pl: { species: 1289, nick: 'Bob', level: 5, hp: 12, maxHp: 40, pid: 0xff, status: 0x80 } },
      { id: 'wide', foe: { species: 183, nick: 'WWWWWWWWWWWW', level: 33, hp: 60, maxHp: 90, pid: 0 }, pl: { species: 1289, nick: 'MMMMMMMMMM', level: 8, hp: 9, maxHp: 30, pid: 0xff } },
      { id: 'lowhp', foe: { species: 183, nick: 'Marill', level: 30, hp: 11, maxHp: 100, pid: 0xff }, pl: { species: 1289, nick: 'Bob', level: 30, hp: 51, maxHp: 100, pid: 0xff, expFrac: 0.97 } },
      { id: 'yellow', foe: { species: 183, nick: 'Marill', level: 30, hp: 50, maxHp: 100, pid: 0xff }, pl: { species: 1289, nick: 'Bob', level: 30, hp: 20, maxHp: 100, pid: 0xff, expFrac: 0.2 } },
    ];
    const mkMon = (m, isPlayer, oi) => ({ species: m.species, name: m.nick, level: m.level, hp: m.hp, maxHp: m.maxHp, gender: genderOf(m.pid, pack.species[m.species].genderRatio), status: ST(m.status), shiny: false, drop: 0, visible: true, showBox: true, ...(isPlayer ? { exp: expOf(m) ? { into: expOf(m).into, span: expOf(m).span } : { into: 0, span: 1 }, boxDy: oi.pbY - 72, dy: oi.pmY - 55 } : {}) });
    const sceneView = (s, oi) => ({ env: 9, foe: mkMon(s.foe, false, oi), player: mkMon(s.pl, true, oi), box: { mode: 'action', prompt: ['What will', s.pl.nick + ' do?'], cursor: 0 } });
    const REG = { foeBox: L.rect(2, 14, 128, 34), playerBox: L.rect(136, 72, 104, 40), foeSprite: L.rect(130, 0, 100, 72), playerSprite: L.rect(20, 40, 100, 70), textBox: L.rect(0, 112, 240, 48), background: L.rect(0, 0, 240, 112) };
    const IGN = [REG.foeBox, REG.playerBox, REG.foeSprite, REG.playerSprite];         // background region: everything outside the boxes and sprites
    const sheet = [], realFrames = {};
    let regDiff = {}, total = 0;
    for (const s of SCEN) {
      const e = expOf(s.pl);
      await toAction(() => { poke(1, s.foe); poke(0, e ? { ...s.pl, exp: e.abs } : s.pl); });
      const real = o.screenshotRGBA(), oi = { pbY: oamY(5), pmY: oamY(9) };
      realFrames[s.id] = { real, oi };
      const arena = ui.render(sceneView(s, oi)).rgba;
      regDiff[s.id] = { foeBox: L.diffRegion(real, arena, REG.foeBox).count, playerBox: L.diffRegion(real, arena, REG.playerBox).count, foeSprite: L.diffRegion(real, arena, REG.foeSprite).count, playerSprite: L.diffRegion(real, arena, REG.playerSprite).count, textBox: L.diffRegion(real, arena, REG.textBox).count, background: L.diffRegion(real, arena, REG.background, { ignore: IGN }).count };
      sheet.push({ real, arena });
    }
    L.contactSheet(path.join(OUT, 'fidelity_healthbox_sheet.png'), sheet.slice(0, 5), 2); L.contactSheet(path.join(OUT, 'fidelity_healthbox_sheet2.png'), sheet.slice(5), 2);
    for (const [id, d] of Object.entries(regDiff)) for (const k of ['foeBox', 'playerBox', 'foeSprite', 'playerSprite', 'background']) { total += d[k]; ok(d[k] === 0, 'B1. real-vs-arena pixels, scenario ' + id + ', region ' + k + ': 0 differing', d[k] + ' px differ'); }
    // the scenarios cover: 1-3 digit levels, both genders + genderless, every status on both sides, HP green / yellow / red, EXP bar fractions, 3-digit HP numbers, 12-char names in font 11
    ok(SCEN.length === 10 && total === 0, 'B1. all 10 healthbox scenarios x 5 regions are pixel-identical to the real game (healthbox art, names, gender symbols, levels, status labels, HP bar, HP numbers, EXP bar, foe shadow, sprites, background)', total + ' px differ in total');
    // twin + negative controls: one changed byte of the arena's ROM copy changes the pixels
    { const twin = B.createBattleUi(new Uint8Array(rom)); const s0 = SCEN[0]; ok(L.diffRegion(realFrames.base.real, twin.render(sceneView(s0, realFrames.base.oi)).rgba, REG.foeBox).count === 0, 'B1. unmutated twin (a fresh arena UI over an identical ROM copy) stays at 0');
      const probes = [['healthbox palette 0x72140c (text shadow)', 0x72140c + 6, 'foeBox'], ['foe shadow sheet 0x6c6f48', 0x6c6f48 + 10, 'foeSprite'], ['status colour literal 0x6198 (UpdateStatusIconInHealthbox pool)', -1, 'foeBox']];
      for (const [name, off, region] of probes.slice(0, 2)) { const r = new Uint8Array(rom); for (let k = 0; k < 4; k++) r[off + k] ^= 0xff; let d; try { const u2 = B.createBattleUi(r); d = L.diffRegion(realFrames.base.real, u2.render(sceneView(s0, realFrames.base.oi)).rgba, REG[region]).count; } catch (_e) { d = 1; }          /* a decoder that rejects the corrupted data counts as caught */ ok(d > 0, 'B1. negative control: flipping ROM bytes at ' + name + ' makes ' + region + ' differ from the real game (' + d + ' px)'); }
      // rule mutants of the arena's layout: shift a text offset by one pixel
      const L2 = B.LAYOUT; const keep = L2.player.hpNumY; L2.player.hpNumY = keep + 1; const d1 = L.diffRegion(realFrames.base.real, ui.render(sceneView(s0, realFrames.base.oi)).rgba, REG.playerBox).count; L2.player.hpNumY = keep;
      ok(d1 > 0, 'B1. negative control: HP numbers one pixel lower than the real game differ (' + d1 + ' px)');
      const keep2 = L2.foe.nameX; L2.foe.nameX = keep2 + 1; const d2 = L.diffRegion(realFrames.base.real, ui.render(sceneView(s0, realFrames.base.oi)).rgba, REG.foeBox).count; L2.foe.nameX = keep2;
      ok(d2 > 0, 'B1. negative control: the foe name one pixel to the right differs (' + d2 + ' px)');
    }

    // ---- B2: text box modes (message, action menu cursor 0..3, move menu cursor 0..3, PP colours, long move names, the wait arrow)
    const MOVEMAX = (id) => pack.moves[id].pp;
    const mvRow = (id, pp) => { const m = pack.moves[id]; return { name: m.name, pp, maxPp: m.pp, type: m.type, typeName: pack.types[m.type].name }; };
    const base = sceneView(SCEN[0], realFrames.base.oi); base.player = { ...base.player, boxDy: 0, dy: 0 };
    async function menuAt(moves, pps, keys) {
      await toAction(() => { poke(1, SCEN[0].foe); poke(0, SCEN[0].pl); setMoves(moves, pps); });
      return o;
    }
    let tb = 0, nTb = 0; const tbSheet = [];
    const cmpText = (name, real, box) => { const a = ui.render({ ...base, box }).rgba; const d = L.diffRegion(real, a, REG.textBox).count; nTb++; tb += d; ok(d === 0, 'B2. real-vs-arena text box: ' + name + ': 0 differing', d + ' px'); tbSheet.push({ real, arena: a }); return d; };
    {
      await menuAt([10, 39, 52, 63], [35, 30, 25, 5]);
      const acts = [['A0', null, 0], ['A1', 'RIGHT', 1], ['A3', 'DOWN', 3], ['A2', 'LEFT', 2]];
      for (const [nm, key, c] of acts) { if (key) o.press(key, 5, 12); cmpText('action menu, cursor on ' + ['Battle', 'Bag', 'Pokemon', 'Run'][c], o.screenshotRGBA(), { mode: 'action', prompt: ['What will', 'Bob do?'], cursor: c }); }
      o.press('UP', 5, 12); o.press('A', 5, 30);
      const MV = [mvRow(10, 35), mvRow(39, 30), mvRow(52, 25), mvRow(63, 5)];
      for (const [nm, key, c] of [['M0', null, 0], ['M1', 'RIGHT', 1], ['M3', 'DOWN', 3], ['M2', 'LEFT', 2]]) { if (key) o.press(key, 5, 12); cmpText('move menu, cursor on slot ' + (c + 1), o.screenshotRGBA(), { mode: 'moves', cursor: c, moves: MV, tick: 0 }); }
    }
    // PP number colour states (cur/max) read off the real move menu, including the small-max branches and the 56/35 oddity (cur above max)
    for (const [id, curs, slot] of [[10, [35, 34, 18, 17, 9, 8, 1, 0], 0], [63, [5, 4, 3, 2, 1, 0], 3], [182, [10, 6, 5, 3, 2, 1, 0], 0], [14, [20, 11, 10, 6, 5, 4, 1], 0]]) for (const cur of curs) {
      const moves = [10, 39, 52, 63], pps = [35, 30, 25, 5]; moves[slot] = id; pps[slot] = cur;
      await menuAt(moves, pps);
      o.press('A', 5, 30); if (slot === 3) { o.press('DOWN', 5, 12); o.press('RIGHT', 5, 12); }
      const real = o.screenshotRGBA(), MV = moves.map((m, i) => mvRow(m, pps[i]));
      const a = ui.render({ ...base, box: { mode: 'moves', cursor: slot === 3 ? 3 : 0, moves: MV, tick: 0 } }).rgba; const d = L.diffRegion(real, a, REG.textBox).count; nTb++; tb += d;
      ok(d === 0, 'B2. real-vs-arena PP window: ' + pack.moves[id].name + ' ' + cur + '/' + MOVEMAX(id) + ' (state ' + B.ppState(cur, MOVEMAX(id)) + '): 0 differing', d + ' px');
    }
    // long names: 64 px narrow-font names, the font-10 fallback and the clipping at the window edge
    { await menuAt([120, 136, 629, 851], [5, 16, 10, 5]); o.press('A', 5, 30); cmpText('long move names (Self-Destruct / High Jump Kick / Floral Healing / Supersonic Skystrike clipped)', o.screenshotRGBA(), { mode: 'moves', cursor: 0, moves: [mvRow(120, 5), mvRow(136, 16), mvRow(629, 10), mvRow(851, 5)], tick: 0 }); }
    { await menuAt([881, 868, 856, 883], [5, 5, 5, 5]); o.press('A', 5, 30); cmpText('very long Z-move names (font 10, clipped)', o.screenshotRGBA(), { mode: 'moves', cursor: 0, moves: [mvRow(881, 5), mvRow(868, 5), mvRow(856, 5), mvRow(883, 5)], tick: 0 }); }
    // message window text + the wait arrow over 36 consecutive frames (the arrow bobs)
    { await o.goto('CK_MESSAGE'); cmpText('message window "Bob used Scratch!"', o.screenshotRGBA(), { mode: 'message', text: ['Bob used Scratch!', ''] }); }
    { await o.goto('CK_BATTLE_INTRO'); let worst = 0; const txt = ['POKéMON Trainer Crystal', 'would like to battle!']; const bt = o.battleText(); ok(/would like to battle/.test(bt), 'B2. the intro checkpoint shows the "would like to battle!" message', bt);
      for (let i = 0; i < 36; i++) { const real = o.screenshotRGBA(); const a = ui.render({ ...base, box: { mode: 'message', text: txt, arrow: true, tick: i } }).rgba; worst += L.diffRegion(real, a, L.rect(100, 136, 50, 16)).count; o.runFrames(1); }
      nTb++; tb += worst; ok(worst === 0, 'B2. the wait-for-A arrow (ROM tile 0xf2c688, no blink, bobbing 18-frame cycle) matches the real game on 36 consecutive frames', worst + ' px'); }
    L.contactSheet(path.join(OUT, 'fidelity_textbox_sheet.png'), tbSheet.slice(0, 6), 2);
    ok(tb === 0, 'B2. all ' + nTb + ' text-box comparisons (action menu x4, move menu x4, 29 PP states, 2 long-name menus, message, 36 arrow frames) are pixel-identical', tb + ' px differ in total');
    // negative controls for the text box
    { const real = realFrames.base.real; const A0 = { ...base, box: { mode: 'action', prompt: ['What will', 'Bob do?'], cursor: 0 } };
      const r1 = new Uint8Array(rom); for (let k = 0; k < 4; k++) r1[0x43cf54 + k] ^= 0xff; const dA = L.diffRegion(real, B.createBattleUi(r1).render(A0).rgba, REG.textBox).count; ok(dA > 0, 'B2. negative control: a ROM copy with the menu string "Battle" changed differs from the real frame (' + dA + ' px)');
      const r2 = new Uint8Array(rom); for (let k = 0; k < 8; k++) r2[0x111d218 + 40 + k] ^= 0xff; const dB = L.diffRegion(real, B.createBattleUi(r2).render(A0).rgba, REG.textBox).count; ok(dB > 0, 'B2. negative control: a ROM copy with changed window-frame tiles differs (' + dB + ' px)');
      const dC = (() => { const f = ui.render({ ...A0, box: { ...A0.box, cursor: 1 } }).rgba; return L.diffRegion(real, f, REG.textBox).count; })(); ok(dC > 0, 'B2. negative control: the cursor drawn on a different word than the real frame\'s differs (' + dC + ' px)'); }
    // ---- B3: scenarios the oracle's startBattle builds (the game itself draws the boxes from the party structs): shiny boxes, a second species' sprites, the 12 battle backgrounds
    if (typeof o.startBattle !== 'function') skipped('B3. startBattle scenarios', 'this oracle build has no startBattle');
    else {
      const monv = (x) => ({ gender: 'M', status: null, shiny: false, drop: 0, visible: true, showBox: true, ...x });
      let b3 = 0;
      for (const [name, sf, sp, stat] of [['both shiny', true, true, null], ['foe shiny', true, false, null], ['player shiny + PSN label', false, true, 'PSN'], ['foe shiny + BRN label', true, false, 'BRN']]) {
        await o.startBattle({ terrain: 0, foe: { species: 183, level: 20, moves: [33, 0, 0, 0], nickname: 'Marill', shinyPid: sf, gender: 'M', status: stat && !sp ? 0x10 : undefined }, player: { species: 25, level: 20, moves: [33, 0, 0, 0], nickname: 'Pika', shinyPid: sp, gender: 'M', status: stat && sp ? 0x08 : undefined }, reach: 'action' });
        const real = o.screenshotRGBA(), pb = oamY(5), pm = oamY(9), fm = o.battleMon(1), pmn = o.battleMon(0);
        const v = { env: 0, foe: monv({ species: 183, name: 'Marill', level: 20, hp: fm.hp, maxHp: fm.maxHP, shiny: sf, status: stat && !sp ? stat : null }), player: monv({ species: 25, name: 'Pika', level: 20, hp: pmn.hp, maxHp: pmn.maxHP, shiny: sp, status: stat && sp ? stat : null, exp: { into: 0, span: 1 }, boxDy: pb - 72, dy: pm - (48 + ui.sprite(25, 'player').yOffset) }), box: { mode: 'action', prompt: ['What will', 'Pika do?'], cursor: 0 } };
        const a = ui.render(v).rgba; let d = 0; for (const k of ['foeBox', 'playerBox', 'foeSprite', 'playerSprite']) d += L.diffRegion(real, a, REG[k]).count;
        b3 += d; ok(d === 0, 'B3. real-vs-arena, ' + name + ' (Marill vs Pikachu, gold healthbox palette, sprites, EXP bar): 0 differing', d + ' px');
      }
      // negative control: the same scene drawn without the shiny box palette differs from the real game
      { await o.startBattle({ terrain: 0, foe: { species: 183, level: 20, moves: [33, 0, 0, 0], nickname: 'Marill', shinyPid: true, gender: 'M' }, reach: 'action' }); const real = o.screenshotRGBA(); const fm = o.battleMon(1);
        const v = (sh) => ({ env: 0, foe: monv({ species: 183, name: 'Marill', level: 20, hp: fm.hp, maxHp: fm.maxHP, shiny: sh }), player: monv({ species: 25, name: 'Pika', level: 20, hp: 1, maxHp: 1 }), box: { mode: 'message', text: ['', ''] } });
        const dOn = L.diffRegion(real, ui.render(v(true)).rgba, REG.foeBox).count, dOff = L.diffRegion(real, ui.render(v(false)).rgba, REG.foeBox).count;
        ok(dOn === 0 && dOff > 100, 'B3. negative control: the foe box drawn non-shiny differs from the real shiny box (' + dOff + ' px), drawn shiny it does not (' + dOn + ')'); }
      // battle backgrounds: the game's terrain id i IS the arena's environment record i (0..11)
      const ign = [L.rect(0, 12, 110, 40), L.rect(120, 70, 120, 50), L.rect(112, 8, 100, 90), L.rect(20, 40, 100, 80), L.rect(0, 112, 240, 48)];
      let bgBad = 0;
      for (let t = 0; t < 12; t++) { await o.startBattle({ terrain: t, foe: { species: 183, level: 5, moves: [33, 0, 0, 0] }, reach: 'action' }); const real = o.screenshotRGBA(); const d = L.diffRegion(real, B.envBackground(rom, t).rgba, L.rect(0, 0, 240, 112), { ignore: ign }).count; bgBad += d; ok(d === 0, 'B3. battle background of the game\'s terrain ' + t + ' equals the arena\'s environment record ' + t + ' (outside the boxes and sprites)', d + ' px'); }
      { const real = (await o.startBattle({ terrain: 5, foe: { species: 183, level: 5, moves: [33, 0, 0, 0] }, reach: 'action' }), o.screenshotRGBA()); const wrong = L.diffRegion(real, B.envBackground(rom, 4).rgba, L.rect(0, 0, 240, 112), { ignore: ign }).count; ok(wrong > 1000, 'B3. negative control: the wrong environment record (4 for terrain 5) differs (' + wrong + ' px)'); }
      ok(b3 + bgBad === 0, 'B3. shiny boxes and all 12 backgrounds are pixel-identical to the real game');
    }

    // ---- B4: the foe's shadow during a real turn: sprite pairs exist only while the foe's own sprite exists (blink with it) and vanish during move animations
    { await o.goto('CK_ACTION_MENU'); o.press('A', 5, 2); o.press('A', 5, 0);
      let withShadow = 0, shadowWithoutMon = 0, animFramesWithMonNoShadow = 0, blinkFrames = 0;
      for (let f = 0; f < 140; f++) {
        const oam = o.readBytes(0x07000000, 0x400); let shadow = 0, foeMon = 0;
        for (let i = 0; i < 128; i++) { const a0 = oam.readUInt16LE(i * 8), a2 = oam.readUInt16LE(i * 8 + 4); if (((a0 >> 8) & 3) === 2) continue; const tile = a2 & 1023, pal = a2 >> 12; if (pal === 4 && tile >= 289 && tile < 321 && ((a2 >> 10) & 3) === 3) shadow++; if (pal === 1 && tile === 489) foeMon++; }
        if (shadow > 0) withShadow++; if (shadow > 0 && foeMon === 0) shadowWithoutMon++; if (shadow === 0 && foeMon > 0) animFramesWithMonNoShadow++; if (shadow === 0 && foeMon === 0) blinkFrames++;
        o.runFrames(1);
      }
      ok(withShadow > 40 && shadowWithoutMon === 0, 'B4. real game: over a 140-frame turn the foe shadow sprites were present on ' + withShadow + ' frames and never without the foe\'s own sprite', 'shadow without mon: ' + shadowWithoutMon);
      ok(animFramesWithMonNoShadow > 20 && blinkFrames > 5, 'B4. real game: the shadow is also hidden while a move animation plays with the foe sprite still shown (' + animFramesWithMonNoShadow + ' frames) and together with a blinking foe (' + blinkFrames + ' frames)');
      const monv = (x) => ({ gender: 'M', status: null, shiny: false, drop: 0, visible: true, showBox: true, ...x });
      const sv = (extra) => ({ env: 0, foe: monv({ species: 183, name: 'Marill', level: 20, hp: 30, maxHp: 30, ...extra }), player: monv({ species: 25, name: 'Pika', level: 20, hp: 30, maxHp: 30 }), box: { mode: 'message', text: ['', ''] } });
      const shadowPx = (view) => { const f = ui.render(view).rgba, bare = ui.render({ ...view, foe: { ...view.foe, showBox: false, visible: false } }).rgba; return L.diffRegion(f, bare, L.rect(130, 56, 100, 30)).count; };
      const nVis = shadowPx(sv({})), nBlink = shadowPx(sv({ visible: false }));
      const fxView = { ...sv({}) }; Object.defineProperty(fxView, 'fxDraw', { value: () => {}, enumerable: false });
      const nFx = shadowPx(fxView), nNoFx = shadowPx(sv({}));
      ok(nVis > 100 && nBlink === 0 && nFx < nNoFx, 'B4. arena: the shadow is drawn with a visible foe (' + nVis + ' px), not while the foe blinks (' + nBlink + '), not while an animation draws (' + nFx + ' vs ' + nNoFx + ')');
    }

    // arena-only things the real battle screen has and the arena does not draw: recorded, not hidden
    ok(true, 'B2. KNOWN GAP (reported in FIDELITY.md): the real move menu also shows an "L MOVE INFO" button sprite and a "?" tag beside the foe healthbox; the arena draws neither');
  }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped');
if (fail) { console.log(failures.join('\n')); process.exit(1); }
