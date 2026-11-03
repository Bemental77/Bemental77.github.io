#!/usr/bin/env node
// POKEMONARENA BATTLE ENGINE TEST  (stage E1)
//
// Proves that pokemonarena/js/engine*.js (+ the engine layer in rules.js) compute what they claim against the REAL pack decoded
// from the pinned ROM, that the checks can fail, and that the engine is deterministic across machines:
//
//   * HAND-COMPUTED SUITES (tools/pokemonarena_engine_suite1/2/3/4.mjs): ~420 checks (suite4 = the fixes after the two adversarial verifiers); every damage / accuracy / status number has its
//     arithmetic written above it; one scenario for every move-effect CLASS (the run fails if a class has no test), plus abilities,
//     items, the API (requests / choose / forfeit / preview / snapshot / replay / views / wire encoding) and the rules layer.
//   * GOLDEN REPLAYS: 40 seeded battles between random LEGAL teams reduced to hashes (pokemonarena/engine.golden.json, hashes only).
//   * FUZZ: N random battles (default 2000) with invariants (0 <= hp <= max, pp bounds, stage bounds, event stream == state,
//     termination, hash stable across snapshot/restore and replay).
//   * MUTANTS: 127 one-snippet edits of the engine source (the implementer's 45, the verifiers' own, and one per fix), ALL must be killed, and every 'named' one by a named check; the unmutated twin goes through the same loader
//     and must stay quiet and reproduce the golden digest.
//   * POISONED PACK: one type-chart cell flipped -> a hand-computed check fails and the golden digest changes.
//   * BROWSER PARITY: the same digest from headless Chrome (muted, throwaway profile, bare CDP) - needs no manual server.
//   * PERFORMANCE: battles/s and ms/turn, with machine load; reported, never asserted.
//
// USAGE   node tools/pokemonarena_engine_test.mjs            (exits non-zero on any failure)
// ENV     ARENA_ROM, ARENA_FUZZ (2000), ARENA_SKIP_MUTANTS=1, ARENA_SKIP_BROWSER=1, ARENA_UPDATE_GOLDEN=1 (rewrites
//         pokemonarena/engine.golden.json and pokemonarena/engine_coverage.json), ARENA_PORT (8096), ARENA_CDP_PORT (9285)
// Reads the ROM, writes only the two JSON files above and a scratch tree under the OS temp dir. Pure ASCII.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadPack } from '../pokemonarena/js/tables.js';
import { loadModules, mulberry32, RS } from './pokemonarena_engine_lib.mjs';
import { suite1 } from './pokemonarena_engine_suite1.mjs';
import { suite2 } from './pokemonarena_engine_suite2.mjs';
import { suite3 } from './pokemonarena_engine_suite3.mjs';
import { suite4 } from './pokemonarena_engine_suite4.mjs';
import { MUTANTS } from './pokemonarena_engine_mutants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS_DIR = path.join(root, 'pokemonarena', 'js');
const GOLDEN = path.join(root, 'pokemonarena', 'engine.golden.json');
const COVERAGE = path.join(root, 'pokemonarena', 'engine_coverage.json');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const FUZZ_N = Number(process.env.ARENA_FUZZ || 2000);
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const PORT = Number(process.env.ARENA_PORT || 8096), CDP = Number(process.env.ARENA_CDP_PORT || 9285);
const DIGEST_N = 40, DIGEST_SEED = 1;

let passed = 0, failed = 0;
const failures = [];
function t(name, ok, detail = '') {
  if (ok === true) { passed++; console.log(`  ok   ${name}`); } else {
    failed++;
    const why = typeof ok === 'string' ? ok : detail;
    failures.push(`${name}: ${why}`);
    console.log(`  FAIL ${name}${why ? '  -- ' + String(why).slice(0, 400) : ''}`);
  }
}
const head = (s) => console.log(`\n== ${s}`);
const J = (x) => JSON.stringify(x);

if (!fs.existsSync(ROM_PATH)) { console.error(`ROM not found: ${ROM_PATH}  (set ARENA_ROM)`); process.exit(2); }
const rom = fs.readFileSync(ROM_PATH);
const romBytes = new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength);
const pack = loadPack(romBytes, { verify: 'header', dexText: false });
const winLoad = () => {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 15000 });
    return Number(String(r.stdout).trim()) || null;
  } catch (_e) { return null; }
};
const load0 = winLoad();
console.log(`machine: ${os.cpus().length} logical CPUs, Windows Win32_Processor LoadPercentage at start: ${load0 === null ? 'n/a' : load0 + '%'}; node ${process.version}`);

function runSuites(M, p, opts = {}) {
  const out = [];
  const s1 = suite1(M, p, rom), s2 = suite2(M, p, rom), s3 = suite3(M, p, rom, opts), s4 = suite4(M, p, rom, opts);
  for (const c of [...s1, ...s2.checks, ...s3, ...s4]) {
    let r;
    try { r = c.fn(); } catch (e) { r = 'threw ' + String((e && e.message) || e).slice(0, 200); }
    out.push({ id: c.id, ok: r === true, why: r === true ? '' : String(r) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
head('hand-computed suites (real modules)');
const M0 = await loadModules(JS_DIR);
const res0 = runSuites(M0, pack);
for (const r of res0) if (!r.ok) t(r.id, r.why); else passed++;
console.log(`  ${res0.filter((r) => r.ok).length} / ${res0.length} suite checks pass`);
if (res0.some((r) => !r.ok)) { /* failures already counted by t() */ }
t('suites/enough-checks', res0.length >= 380, `only ${res0.length}`);

// ---------------------------------------------------------------------------------------------
head('golden replays (hashes only)');
const dg = M0.engine_digest.digestBattles(pack, DIGEST_N, DIGEST_SEED);
const dg2 = M0.engine_digest.digestBattles(pack, DIGEST_N, DIGEST_SEED);
t('golden/digest-is-reproducible-in-process', dg.digest === dg2.digest);
const goldenObj = { note: 'Hashes only. Regenerate with ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_engine_test.mjs after an intentional engine change.', engineVersion: M0.engine_data.ENGINE_VERSION, battles: DIGEST_N, seed0: DIGEST_SEED, ruleset: RS, digest: dg.digest, rows: dg.rows };
if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify(goldenObj, null, 1) + '\n'); console.log('  wrote ' + GOLDEN); }
let golden = null;
try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); } catch (_e) { /* reported below */ }
t('golden/file-present', golden !== null, 'run with ARENA_UPDATE_GOLDEN=1 once');
if (golden) {
  t('golden/digest-matches', golden.digest === dg.digest, `file ${golden.digest} computed ${dg.digest}`);
  const bad = golden.rows.filter((r, i) => J(r) !== J(dg.rows[i]));
  t('golden/every-battle-matches', bad.length === 0, bad.length ? `first differing battle i=${bad[0].i}` : '');
  t('golden/only-hashes-and-counts', golden.rows.every((r) => Object.keys(r).every((k) => ['i', 'hash', 'logHash', 'turns', 'winner', 'events'].includes(k))));
  t('golden/battles-cover-wins-draws-and-previews', new Set(golden.rows.map((r) => r.winner)).has(0) && new Set(golden.rows.map((r) => r.winner)).has(1) && golden.rows.reduce((s, r) => s + r.turns, 0) > 600);
}

// ---------------------------------------------------------------------------------------------
head('coverage report (ids and counts only)');
{
  const R = M0.rules, D = M0.engine_data;
  const sup = R.engineSupports(pack);
  const kinds = M0.engine_moves.IMPLEMENTED_KINDS;
  const usedEffect = {};
  for (const mv of pack.moves) if (mv.id) usedEffect[mv.effect] = (usedEffect[mv.effect] || 0) + 1;
  const impl = Object.keys(D.EFFECTS).map(Number).filter((id) => kinds.has(D.EFFECTS[id].kind)).sort((a, b) => a - b);
  const unimpl = Object.keys(usedEffect).map(Number).filter((id) => !impl.includes(id)).sort((a, b) => a - b);
  const reasons = {};
  for (const [id, why] of Object.entries(sup.moveReasons)) (reasons[why] ||= []).push(Number(id));
  const classUnlock = {};
  for (const id of impl) classUnlock[D.EFFECTS[id].kind] = (classUnlock[D.EFFECTS[id].kind] || 0) + (usedEffect[id] || 0);
  const excl = R.engineExcludedSpecies(pack, RS);
  const cov = R.engineCoverage(pack, RS);
  // "supported" = the engine can run it; "reachable" = some engine-legal species can actually be given it (any level up to 100, every
  // enabled learn source). 79 supported moves (Z-moves, event-only moves, a few legendary signatures) can never appear on a legal team.
  const exclIds = new Set(excl.map((e) => e.id));
  const reachable = new Set();
  for (const sid of pack.roster) { if (exclIds.has(sid)) continue; for (const id of R.legalMoves(pack, sid, 100, RS)) reachable.add(id); }
  const unreachable = sup.moveList.filter((id) => !reachable.has(id));
  const coverage = {
    note: 'Ids and counts only (no names, no text). Regenerate with ARENA_UPDATE_GOLDEN=1.',
    engineVersion: D.ENGINE_VERSION,
    counts: {
      movesTotal: pack.moves.length - 1, movesSupported: sup.moves.size, movesUnsupported: pack.moves.length - 1 - sup.moves.size,
      movesReachable: reachable.size, movesSupportedButUnreachable: unreachable.length,
      abilitiesTotal: pack.abilities.length - 1, abilitiesSupported: sup.abilities.size,
      itemsTotal: pack.items.length - 1, itemsSupported: sup.items.size,
      effectIdsInRom: Object.keys(usedEffect).length, effectIdsImplemented: impl.length, effectIdsUnimplemented: unimpl.length,
      speciesRoster: pack.roster.length, speciesLegalUnderEngine: cov.species, speciesExcluded: excl.length,
      moveClasses: kinds.size,
    },
    movesUnlockedPerClass: classUnlock,
    effectIds: { implemented: impl, unimplemented: unimpl },
    moves: { supported: sup.moveList, supportedButUnreachable: unreachable, unsupportedByReason: reasons },
    abilities: { supported: sup.abilityList },
    items: { supported: sup.itemList },
    speciesExcluded: excl,
  };
  if (UPDATE) { fs.writeFileSync(COVERAGE, JSON.stringify(coverage) + '\n'); console.log('  wrote ' + COVERAGE); }
  let file = null;
  try { file = JSON.parse(fs.readFileSync(COVERAGE, 'utf8')); } catch (_e) { /* below */ }
  t('coverage/file-present', file !== null, 'run with ARENA_UPDATE_GOLDEN=1 once');
  if (file) t('coverage/file-matches-the-computed-support', J(file) === J(coverage), 'engine_coverage.json is stale');
  console.log(`  moves ${coverage.counts.movesSupported}/${coverage.counts.movesTotal} supported (${coverage.counts.movesReachable} reachable on a legal team), abilities ${coverage.counts.abilitiesSupported}/${coverage.counts.abilitiesTotal}, items ${coverage.counts.itemsSupported}/${coverage.counts.itemsTotal}`);
  console.log(`  effect ids: ${coverage.counts.effectIdsImplemented} implemented of ${coverage.counts.effectIdsInRom} in the ROM; ${coverage.counts.moveClasses} classes; species legal ${cov.species}/${pack.roster.length} (${excl.length} excluded)`);
  t('coverage/numbers-are-consistent', coverage.counts.movesSupported + coverage.counts.movesUnsupported === coverage.counts.movesTotal && cov.species + excl.length === pack.roster.length);
  t('coverage/reachable-plus-unreachable-is-supported', reachable.size + unreachable.length === sup.moves.size && unreachable.every((id) => !reachable.has(id)) && [...reachable].every((id) => sup.moves.has(id)));
  t('coverage/support-sets-have-no-id-collisions-with-banned', sup.moves.size > 500 && sup.abilities.size > 100 && sup.items.size > 500);
  globalThis.__coverage = coverage;
}

// ---------------------------------------------------------------------------------------------
head(`fuzz: ${FUZZ_N} random battles between random LEGAL teams`);
{
  const E = M0.engine, DG = M0.engine_digest;
  const tFuzz0 = process.hrtime.bigint();
  let battles = 0, turnsTotal = 0, draws = 0, caps = 0, replays = 0, restores = 0, previews = 0;
  const errs = {};
  const eventKinds = {};
  for (let bi = 0; bi < FUZZ_N; bi++) {
    const rnd = DG.makePrng(0x5a5a5a + bi * 104729);
    const na = 1 + rnd(6), nb = 1 + rnd(6);
    try {
      const A = DG.randomTeam(pack, rnd, na), B = DG.randomTeam(pack, rnd, nb);
      const pick = (na >= 3 && nb >= 3 && rnd(5) === 0) ? 1 + rnd(3) : 0;
      if (pick) previews++;
      const seed = rnd(0x7fffffff);
      const b = E.createBattle({ pack, ruleset: RS, teams: [A, B], seed, pick, validate: bi % 8 === 0 });
      const track = [{}, {}];
      const snapAt = 1 + rnd(25);
      let twin = null;
      const hpOf = () => { for (let s = 0; s < 2; s++) b.s.sides[s].team.forEach((m) => { if (track[s][m.slot] === undefined) track[s][m.slot] = m.hp; }); };
      const apply = (evs) => {
        for (const e of evs) {
          eventKinds[e.t] = (eventKinds[e.t] || 0) + 1;
          if (e.t === 'damage' || e.t === 'heal') track[e.s][e.m] = e.to;
          else if (e.t === 'faint') track[e.s][e.m] = 0;
          else if (e.t === 'switch-in') track[e.s][e.m] = e.hp;
          else if (e.t === 'preview') { track[e.s] = {}; }
        }
      };
      hpOf(); apply(b.drain());
      let guard = 0;
      const choose = (bt, side, r) => {
        let c;
        if (r.phase === 'preview') { const idx = r.team.map((m) => m.slot); const order = []; while (order.length < r.pick) order.push(idx.splice(rnd(idx.length), 1)[0]); c = { kind: 'preview', order }; }
        else if (r.phase === 'move') {
          if (r.switches.length && rnd(100) < 12) c = { kind: 'switch', slot: r.switches[rnd(r.switches.length)].slot };
          else { const ok = r.moves.filter((m) => !m.disabled); c = { kind: 'move', slot: ok[rnd(ok.length)].slot }; }
        } else if (r.phase === 'switch') c = { kind: 'switch', slot: r.switches[rnd(r.switches.length)].slot };
        else return null;
        return c;
      };
      while (b.winner === null && guard++ < 3000) {
        const reqs = b.requests();
        const cs = [null, null];
        for (let s = 0; s < 2; s++) {
          const c = choose(b, s, reqs[s]);
          if (c) { cs[s] = c; const res = b.choose(s, c); if (!res.ok) throw new Error('rejected a legal choice: ' + J(c) + ' ' + res.code); }
        }
        if (!b.ready()) throw new Error('not ready after every needed side chose');
        if (twin) { for (let s = 0; s < 2; s++) if (cs[s]) { const r2 = twin.choose(s, cs[s]); if (!r2.ok) throw new Error('twin rejected ' + J(cs[s]) + ' ' + r2.code); } }
        const evs = b.advance();
        if (twin) { const ev2 = twin.advance(); if (J(ev2) !== J(evs) || twin.hash() !== b.hash()) throw new Error('restored twin diverged at turn ' + b.turn); }
        hpOf(); apply(evs);
        // invariants
        for (let s = 0; s < 2; s++) for (const m of b.s.sides[s].team) {
          if (!Number.isInteger(m.hp) || m.hp < 0 || m.hp > m.mhp) throw new Error(`hp out of range ${m.name} ${m.hp}/${m.mhp}`);
          if ((m.hp === 0) !== (m.fnt === 1)) throw new Error('fnt flag mismatch');
          for (const mv of m.mv) if (!Number.isInteger(mv.pp) || mv.pp < 0 || mv.pp > mv.mx) throw new Error(`pp out of range ${mv.pp}/${mv.mx}`);
          for (const k of Object.keys(m.sg)) if (!Number.isInteger(m.sg[k]) || m.sg[k] < -6 || m.sg[k] > 6) throw new Error(`stage ${k} ${m.sg[k]}`);
          const tr = track[s][m.slot];
          if (tr !== undefined && tr !== m.hp) throw new Error(`event stream says ${tr}, state says ${m.hp} for side ${s} slot ${m.slot}`);
        }
        const hh = b.hash();
        if (typeof hh !== 'string' || hh.length !== 16) throw new Error('bad hash');
        if (!twin && b.turn >= snapAt && b.winner === null && rnd(3) === 0) {
          const snap = JSON.parse(JSON.stringify(b.snapshot()));
          twin = E.restoreBattle(snap, { pack });
          if (twin.hash() !== b.hash()) throw new Error('restore hash differs');
          restores++;
        }
      }
      if (b.winner === null) throw new Error('did not terminate');
      if (b.winner === -1) draws++;
      if (b.events.some((e) => e.t === 'turn-cap')) caps++;
      if (bi % 25 === 0) {
        const rp = E.replay({ pack, ruleset: RS, teams: [A, B], seed, pick, choiceLog: b.choiceLog, validate: false });
        if (rp.hash !== b.hash() || J(rp.events) !== J(b.events)) throw new Error('replay differs');
        replays++;
      }
      battles++; turnsTotal += b.turn;
    } catch (e) {
      const k = String((e && e.message) || e).replace(/\d+/g, 'N').slice(0, 120);
      errs[k] = errs[k] || { n: 0, first: bi, stack: String(e.stack || '').split('\n').slice(0, 4).join(' | ') };
      errs[k].n++;
    }
  }
  const fuzzMs = Number(process.hrtime.bigint() - tFuzz0) / 1e6;
  for (const [k, v] of Object.entries(errs)) t(`fuzz/${k}`, `${v.n} battles, first #${v.first}: ${v.stack}`);
  t(`fuzz/${FUZZ_N}-battles-all-terminate-and-keep-invariants`, battles === FUZZ_N && Object.keys(errs).length === 0, `ok ${battles}`);
  { const known = new Set(M0.engine.EVENT_CODES); const unknown = Object.keys(eventKinds).filter((k) => !known.has(k)); t('fuzz/every-emitted-event-code-is-in-EVENT_CODES', unknown.length === 0, unknown.join(', ')); }
  t('fuzz/at-least-2000-battles', FUZZ_N >= 2000 || process.env.ARENA_FUZZ !== undefined, 'lower ARENA_FUZZ was requested');
  t('fuzz/exercised-restore-replay-preview-and-many-event-kinds', restores > FUZZ_N / 40 && replays > FUZZ_N / 150 && previews > FUZZ_N / 40 && Object.keys(eventKinds).length >= 30, `restores ${restores} replays ${replays} previews ${previews} kinds ${Object.keys(eventKinds).length}`);
  console.log(`  ${battles} battles, ${turnsTotal} turns, ${draws} draws, ${caps} turn-cap draws, ${restores} snapshot twins, ${replays} replays, ${previews} previews, ${Object.keys(eventKinds).length} event kinds in ${(fuzzMs / 1000).toFixed(1)} s`);
  console.log('  event kinds seen: ' + Object.keys(eventKinds).sort().join(' '));
  globalThis.__fuzzMs = fuzzMs; globalThis.__fuzzTurns = turnsTotal; globalThis.__fuzzBattles = battles;
}

// ---------------------------------------------------------------------------------------------
if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  head(`mutants: ${MUTANTS.length} one-snippet edits of the engine source (all must be killed) + the unmutated twin`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-engine-mut-'));
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"type":"module"}');
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const srcs = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(JS_DIR, f), 'utf8')]));
  async function variant(tag, mut) {
    const dir = path.join(tmpRoot, tag, 'js');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      let s = srcs[f];
      if (mut && f === mut[1]) {
        const n = s.split(mut[2]).length - 1;
        if (n !== 1) throw new Error(`mutant snippet occurs ${n} times in ${f}: ${mut[2].slice(0, 60)}`);
        s = s.replace(mut[2], () => mut[3]);
      }
      fs.writeFileSync(path.join(dir, f), s);
    }
    try {
      const M = await loadModules(dir);
      const rs = runSuites(M, pack, { cheap: true });
      const fail = rs.find((r) => !r.ok);
      if (fail) return { killed: true, by: fail.id, n: rs.filter((r) => !r.ok).length };
      const d = M.engine_digest.digestBattles(pack, DIGEST_N, DIGEST_SEED);
      if (d.digest !== dg.digest) return { killed: true, by: 'golden digest', n: 0 };
      return { killed: false, digest: d.digest, checks: rs.length };
    } catch (e) { return { killed: true, by: 'crash: ' + String(e.message).slice(0, 80), n: 0 }; }
  }
  const twin = await variant('twin', null);
  t('mutants/unmutated-twin-is-quiet-and-reproduces-the-golden-digest', !twin.killed && twin.digest === dg.digest, J(twin));
  let killedN = 0;
  const survivors = [], digestOnly = [];
  for (let i = 0; i < MUTANTS.length; i++) {
    const m = MUTANTS[i];
    const r = await variant('m' + i, m);
    if (r.killed) {
      killedN++;
      console.log(`  killed  ${m[0]}  <- ${r.by}`);
      if (m[4] === 'named' && (r.by === 'golden digest' || String(r.by).startsWith('crash'))) digestOnly.push(m[0] + ' <- ' + r.by);
    } else { survivors.push(m[0]); console.log(`  SURVIVED ${m[0]}`); }
  }
  t(`mutants/all-${MUTANTS.length}-killed`, survivors.length === 0, 'survivors: ' + survivors.join('; '));
  t('mutants/named-mutants-are-killed-by-a-named-check-not-by-the-golden-digest-or-a-crash', digestOnly.length === 0, digestOnly.join('; '));
  t('mutants/at-least-100', MUTANTS.length >= 100);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} else console.log('\n(mutants skipped: ARENA_SKIP_MUTANTS=1)');

// ---------------------------------------------------------------------------------------------
head('poisoned pack control: one type-chart cell flipped');
{
  const bad = JSON.parse(JSON.stringify(pack));
  const T = M0.engine_data.T;
  bad.typeChart[T.FIRE][T.GRASS] = 4096; // Fire vs Grass 2x -> 1x
  for (const [x, y] of [[T.WATER, T.FIRE], [T.ELECTRIC, T.WATER], [T.GROUND, T.FIRE], [T.FIGHTING, T.NORMAL]]) bad.typeChart[x][y] = 4096;   // a few more common super-effective cells: the 40 golden battles do not always use Fire against Grass
  const rs = runSuites(M0, bad, { cheap: true });
  const hit = rs.filter((r) => !r.ok).map((r) => r.id);
  t('poison/a-hand-computed-damage-check-fails', hit.includes('damage/stab-then-type-122-and-30'), J(hit.slice(0, 5)));
  const dp = M0.engine_digest.digestBattles(bad, DIGEST_N, DIGEST_SEED);
  t('poison/golden-digest-changes', dp.digest !== dg.digest);
  t('poison/the-unpoisoned-pack-is-quiet', res0.filter((r) => !r.ok).length === 0);
}

// ---------------------------------------------------------------------------------------------
head('performance (reported, not asserted)');
{
  const n = 200;
  const t0 = process.hrtime.bigint();
  const d = M0.engine_digest.digestBattles(pack, n, 9000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const turns = d.rows.reduce((s, r) => s + r.turns, 0);
  console.log(`  team build + ${n} battles (${turns} turns) in ${ms.toFixed(0)} ms  => ${(n / (ms / 1000)).toFixed(0)} battles/s, ${(ms / turns).toFixed(3)} ms per turn (includes random team construction)`);
  // engine only: pre-built teams
  const DG = M0.engine_digest;
  const rnd = DG.makePrng(77);
  const teams = []; for (let i = 0; i < 100; i++) teams.push([DG.randomTeam(pack, rnd, 6), DG.randomTeam(pack, rnd, 6)]);
  let tt = 0;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < teams.length; i++) { const b = M0.engine.createBattle({ pack, ruleset: RS, teams: teams[i], seed: i + 1, validate: false }); DG.playRandom(b, DG.makePrng(i + 5)); tt += b.turn; }
  const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`  engine only: 100 six-vs-six battles (${tt} turns) in ${ms1.toFixed(0)} ms => ${(100 / (ms1 / 1000)).toFixed(0)} battles/s, ${(ms1 / tt).toFixed(3)} ms per turn`);
  console.log(`  fuzz loop (with invariants + hashing every turn): ${(globalThis.__fuzzMs / globalThis.__fuzzTurns).toFixed(3)} ms per turn over ${globalThis.__fuzzTurns} turns`);
  const bb = M0.engine.createBattle({ pack, ruleset: RS, teams: teams[0], seed: 1, validate: false });
  const th = process.hrtime.bigint();
  let hh = 0; for (let i = 0; i < 200; i++) hh += bb.hash().length;
  console.log(`  hash(): ${(Number(process.hrtime.bigint() - th) / 1e6 / 200).toFixed(3)} ms per call (${hh / 200} hex chars)`);
}

// ---------------------------------------------------------------------------------------------
if (process.env.ARENA_SKIP_BROWSER !== '1') {
  head('Node vs headless Chrome parity (same digest)');
  let server = null;
  try {
    const { withBrowser } = await import('./headless_cdp.mjs');
    const lg = [];
    server = spawn(process.execPath, [path.join(here, 'devserver.mjs')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => lg.push(String(d))); server.stderr.on('data', (d) => lg.push(String(d)));
    for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://localhost:${PORT}/pokemonarena/package.json`); if (r.ok) break; } catch (_e) { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
    const url = `http://localhost:${PORT}/pokemonarena/package.json`;
    const out = await withBrowser({ port: CDP, width: 800, height: 600 }, async (page) => {
      await page.navigate(url);
      const expr = `(async () => {
        const T = await import('/pokemonarena/js/tables.js'); const D = await import('/pokemonarena/js/engine_digest.js');
        const buf = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/Pokemon%20SoulGold%20(v1.1.1).gba')).arrayBuffer());
        const pack = T.loadPack(buf, { verify: 'header', dexText: false });
        const t0 = performance.now();
        const d = D.digestBattles(pack, ${DIGEST_N}, ${DIGEST_SEED});
        return { digest: d.digest, rows: d.rows, ms: performance.now() - t0, ua: navigator.userAgent, hasMathRandomUsed: false };
      })()`;
      return page.eval(expr);
    });
    t('parity/chrome-digest-equals-node-digest', out.digest === dg.digest, `chrome ${out.digest} node ${dg.digest}`);
    t('parity/every-battle-hash-equal', out.rows.every((r, i) => J(r) === J(dg.rows[i])));
    console.log(`  ${out.ua}; digest of ${DIGEST_N} battles computed in the browser in ${out.ms.toFixed(0)} ms`);
  } catch (e) { t('parity/browser-run', String((e && e.message) || e)); } finally {
    if (server) { try { server.kill(); } catch (_e) { /* ignore */ } }
  }
} else console.log('\n(browser parity skipped: ARENA_SKIP_BROWSER=1)');

// ---------------------------------------------------------------------------------------------
const load1 = winLoad();
console.log(`\nmachine load at end (Win32_Processor LoadPercentage): ${load1 === null ? 'n/a' : load1 + '%'}`);
console.log('\nWHAT THIS DOES NOT PROVE: the damage / status / weather numbers are the modern-generation defaults (ENGINE.md lists every');
console.log('"assumed" row) checked against hand arithmetic, not against the real hack; only the stat-stage ratio table and the stat formula are');
console.log('ROM-static. Innate abilities ARE modelled (level-gated 75/85/95, MEASURED on 3 species and 60 damage scenarios); terrain, Gravity, gender, frostbite, primal weather, Neutralizing Gas and the Ruin abilities are modelled since round 3 (MEASURED, ROMDIFF.md section 8); mid-battle form changes, Mega / Z / Dynamax / Tera and the parts listed in ROMDIFF.md 8.7 are not. Doubles are out of scope. Chrome parity is one engine (V8); Firefox/Safari are untested.');
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFAILURES:'); for (const f of failures) console.log(' - ' + f); process.exit(1); }
process.exit(0);
