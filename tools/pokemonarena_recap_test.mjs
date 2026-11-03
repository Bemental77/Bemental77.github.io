#!/usr/bin/env node
// POKEMONARENA RECAP TEST (ST1) -- the MATCH RECAP on the result screen: pokemon arena js/recap_model.js (the pages as data), js/page_draw.js (how a cell is set),
// js/battle_ui.js (the recap screen and the four-chip result row) and js/scene.js (the RECAP mode: input, pointer, guard, the match-end hook, the career line).
//
//   A  THE PAGES       seven pages from a summary; hand-written expectations for a win, a loss, a forfeit, a draw, a quick battle with no profile, and each state of the
//                      career line (pending / saved / duplicate / error / none); callouts.
//   B  FIT             every cell of every page of ~120 real battles (3v3 and 6v6, every CPU level, forfeits, draws), with the LONGEST names the ROM has, is set inside its cell
//                      by the ROM fonts with NO cut and no overlap, inside the 220 x 106 window; the same for hostile numbers (a cut then stays inside its cell).
//   C  THE SCENE       a real battle played to the result screen: the RECAP chip and the cursor ring, the D1 guard (mashing A opens nothing and chooses nothing), every key
//                      (left right up down L R A B Start), pointer (chips, page, hover, wheel), the loop that can never start a REMATCH by mashing, idle() leaves the recap alone,
//                      hooks.onMatchEnd fires exactly once with the summary of the whole log, the summary is the same after a replay of the saved choices, setCareer repaints,
//                      scene.hit == ui.hitTest over a grid, the plain three-button screen is untouched with opts.recap === false.
//   D  RENDER          the screens draw (not blank, differ page to page, a zeroed ROM font changes them), a one-pixel golden-style check that the chips are the ROM's panels.
//   E  MUTANTS         one-snippet defects of scene.js / recap_model.js / page_draw.js (in a temp copy of the module tree), each of which must trip a NAMED check.
//
//   node tools/pokemonarena_recap_test.mjs        ARENA_BATTLES=n (default 100), ARENA_SKIP_MUTANTS=1
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const N_BATTLES = Math.max(20, Number(process.env.ARENA_BATTLES || 100));
const J = (x) => JSON.stringify(x);
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }
const rom = fs.readFileSync(ROM_PATH);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));

let passed = 0, failed = 0;
const failures = [], failNames = [];
function report(name, ok, detail) { if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { failed++; failNames.push(name); const why = typeof ok === 'string' ? ok : detail || ''; failures.push(name + ': ' + why); console.log('  FAIL ' + name + (why ? ' -- ' + String(why).slice(0, 400) : '')); } }
const head = (s) => console.log('\n== ' + s);

const loadFrom = async (dir) => {
  const u = (n) => import(pathToFileURL(path.join(dir, n)).href);
  const [T, MC, AI, SC, B, BT, MS, RC, PD, CS] = await Promise.all([u('tables.js'), u('matchctl.js'), u('ai.js'), u('scene.js'), u('battle_ui.js'), u('battle_text.js'), u('match_stats.js'), u('recap_model.js'), u('page_draw.js'), u('career_stats.js')]);
  const pack = T.loadPack(rom, { verify: 'header', dexText: false });
  const ui = B.createBattleUi(rom);
  const text = BT.loadBattleText(rom, manifest);
  return { T, MC, AI, SC, B, MS, RC, PD, CS, pack, ui, text, pd: PD.createPageDrawer(ui) };
};

/* ===================================================================================================== the suite, over any module tree */
async function suite(M) {
  const out = [];
  const add = (name, result) => out.push([name, result]);
  const blk = async (name, fn) => { try { await fn(); } catch (e) { add('crash/' + name, 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } };
  const { MC, AI, SC, B, MS, RC, pack, ui, text, pd } = M;
  const names = { moveName: (id) => (pack.moves[id] ? pack.moves[id].name : '?'), speciesName: (id) => (pack.species[id] ? pack.species[id].name : '?') };

  function build(seed, pick, cpu, o = {}) {
    const A = MC.randomTeam(pack, seed * 1000 + 1, 6), Bt = MC.randomTeam(pack, seed * 1000 + 2, 6);
    const ctl = MC.createMatchController({ pack, teams: [A.recs, Bt.recs], seed, pick, names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: cpu, seed: seed + 5 }] });
    const hooks = { onMatchEnd: o.onMatchEnd, onResult: o.onResult, ...(o.hooks || {}) };
    const scene = SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, Bt.meta], trainer: 'CPU Normal', playerName: 'You', resultOptions: o.resultOptions === undefined ? ['REMATCH', 'NEW BATTLE', 'BACK TO HUB'] : o.resultOptions, recap: o.recap, resultGuard: o.resultGuard, hooks });
    ctl.start(); scene.begin();
    return { ctl, scene, A, Bt };
  }
  function play(b, o = {}) {
    const { ctl, scene } = b;
    const ai = AI.createAi({ pack, level: 'normal', seed: 7 });
    let n = 0;
    while (n++ < 700000 && scene.mode !== 'result') {
      scene.tick();
      if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
      const m = scene.mode;
      if (o.forfeitAt && ctl.turn >= o.forfeitAt && m === 'action') { scene.press('down'); scene.press('right'); scene.press('a'); scene.press('up'); scene.press('a'); continue; }
      if (m === 'preview') { const p = scene.S.preview; if (p.picks.length < p.pick) { scene.press('a'); if (scene.mode === 'preview') scene.press('down'); } }
      else if (m === 'confirm') { if (scene.S.confirm.kind === 'team') scene.press('a'); else if (scene.S.confirm.kind === 'forfeit') scene.press('a'); }
      else if (m === 'action' || m === 'moves' || m === 'party') { const req = ctl.pending(0); if (req) { const c = ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); scene.S.mode = 'steps'; ctl.submit(0, c); scene.S.party = null; scene.S.mode = 'steps'; } }
    }
    return scene.mode === 'result';
  }
  const tick = (scene, n) => { for (let i = 0; i < n; i++) scene.tick(); };
  const armed = (scene) => tick(scene, SC.RESULT_GUARD_FRAMES + 5);

  // ------------------------------------------------------------------------------------------------ A. the pages, by hand
  await blk('pages', async () => {
    const sv = (id, name, sp) => ({ slot: id, sp, name, level: 50, max: 100, played: 1, dealt: 0, dealtPct: 0, taken: 0, takenPct: 0, takenByAttacks: 0, takenOther: 0, healed: 0, kos: 0, faints: 0, hits: 0, subHits: 0, crits: 0, superEffective: 0, resisted: 0, noEffect: 0, misses: 0, blocked: 0, statusInflicted: 0, statusSuffered: 0, switchIns: 1, switchOuts: 0, turns: 3, moves: [], startHp: 100, endHp: 100, endPct: 100, low: null, score: 0 });
    const side = (name, mons, o = {}) => ({ name, size: mons.length, mons, dealt: 0, dealtPct: 0, taken: 0, takenByAttacks: 0, takenOther: 0, dealtIndirect: 0, healed: 0, kos: 0, attackKos: 0, indirectKos: 0, faints: 0, selfFaints: 0, envFaints: 0, hits: 0, subHits: 0, crits: 0, superEffective: 0, resisted: 0, noEffect: 0, misses: 0, blocked: 0, statusInflicted: 0, statusSuffered: 0, statuses: [], switches: 0, moves: [], koStreak: 0, deficit: 0, hpLeft: 100, hpMax: 100, hpLeftPct: 100, alive: mons.length, mvp: null, closestCall: null, biggestHit: null, ...o });
    const mkSum = (over = {}) => ({
      v: 1, viewSide: 0, result: 'w', winner: 0, endedBy: 'ko', turns: 7, names: ['You', 'CPU Normal'],
      sides: [side('You', [sv(0, 'Pikachu', 25), sv(1, 'Aron', 304)], { kos: 2, attackKos: 2, dealt: 300, moves: [[85, 3], [33, 1]], mvp: { slot: 0, sp: 25, name: 'Pikachu', score: 2200, scorePts: 220, kos: 1, dealt: 180, dealtPct: 120 } }), side('CPU Normal', [sv(0, 'Rattata', 19)], { faints: 1, moves: [[1, 2]] })],
      firstBlood: { victim: { side: 1, slot: 0, sp: 19 }, by: { side: 0, slot: 0, sp: 25, mv: 85 }, cause: 'attack', turn: 2 },
      lastHit: { side: 0, slot: 0, sp: 25, mv: 85, victim: { side: 1, slot: 0, sp: 19 } },
      biggestHit: { side: 0, slot: 0, sp: 25, mv: 85, dmg: 90, pct: 90, crit: 1, eff: 8192, vs: { side: 1, slot: 0, sp: 19 }, turn: 2 },
      mvp: { side: 0, slot: 0, sp: 25, name: 'Pikachu', score: 2200, scorePts: 220, kos: 1, dealt: 180, dealtPct: 120 },
      closestCall: { side: 0, slot: 1, sp: 304, name: 'Aron', hp: 12, max: 100, pct: 12 },
      koStreak: { side: 0, n: 2 }, weatherTurns: 0, weather: [], terrainTurns: 0, terrain: [], flags: { noFaintWin: true, sweep: false, comeback: false, forfeit: false },
      ...over,
    });
    const txt = (page) => page.lines.map((l) => l.cells.map((c) => c.t).filter((t) => t !== '').join(' | ')).join('\n');
    const pagesOf = (sum, career) => RC.buildRecapPages(sum, { ...names, career, mineLabel: 'YOU', foeLabel: 'CPU NORMAL' });
    const p = pagesOf(mkSum(), null);
    add('pages/seven-pages-in-order', J(p.map((x) => x.id)) === J(RC.RECAP_PAGE_IDS) && J(p.map((x) => x.title)) === J(['SUMMARY', 'MOMENTS', 'YOUR TEAM', 'FOE TEAM', 'MOVES', 'COMPARE', 'RECORD']) ? true : J(p.map((x) => x.id)));
    add('pages/summary-win', /YOU WON!/.test(txt(p[0])) && /7 TURNS/.test(txt(p[0])) && /Pikachu/.test(txt(p[0])) && /1 KO\s+180 DAMAGE \(120%\)/.test(txt(p[0])) && /Pikachu: /.test(txt(p[0])) && /Aron LEFT AT 12%/.test(txt(p[0])) && p[0].icons.length === 1 && p[0].icons[0].sp === 25 ? true : txt(p[0]));
    add('pages/summary-names-the-biggest-hit-with-the-move-of-the-ROM', new RegExp('Pikachu: ' + names.moveName(85).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(txt(p[0])) ? true : txt(p[0]));
    add('pages/summary-shows-the-first-blood-when-there-is-no-record', /FIRST BLOOD/.test(txt(p[0])) && !/NEW RECORD/.test(txt(p[0])) ? true : txt(p[0]));
    const pr = pagesOf(mkSum(), { state: 'saved', profileName: 'ASH', callouts: [{ kind: 'fastest', n: 7 }, { kind: 'hit', n: 90 }], stats: { wins: 5, losses: 2, draws: 1, forfeits: 1, streak: 2, best: 3 } });
    add('pages/a-record-replaces-first-blood-on-the-summary-in-its-own-tone', /NEW RECORD/.test(txt(pr[0])) && /FASTEST WIN YET: 7 TURNS/.test(txt(pr[0])) && !/FIRST BLOOD/.test(txt(pr[0])) && pr[0].lines.some((l) => l.cells.some((c) => c.tone === 'hi' && /RECORD/.test(c.t))) ? true : txt(pr[0]));
    add('pages/record-page-saved', /SAVED TO ASH'S RECORD/.test(txt(pr[6])) && /9/.test(txt(pr[6])) && /5 WON, 2 LOST, 1 DRAWN, 1 QUIT/.test(txt(pr[6])) && /BIGGEST HIT YET: 90 HP/.test(txt(pr[6])) ? true : txt(pr[6]));
    add('pages/record-page-duplicate', /ALREADY IN ASH'S RECORD/.test(txt(pagesOf(mkSum(), { state: 'duplicate', profileName: 'ASH', stats: { wins: 1, losses: 0, draws: 0, forfeits: 0, streak: 1, best: 1 } })[6])) ? true : 'x');
    add('pages/record-page-pending-error-none', /SAVING/.test(txt(pagesOf(mkSum(), { state: 'pending' })[6])) && /COULD NOT SAVE/.test(txt(pagesOf(mkSum(), { state: 'error' })[6])) && /NOT SAVED/.test(txt(pagesOf(mkSum(), null)[6])) && /No trainer profile is in use/.test(txt(pagesOf(mkSum(), { state: 'none' })[6])) ? true : 'x');
    add('pages/record-page-says-why-for-a-newer-profile', /newer/.test(txt(pagesOf(mkSum(), { state: 'none', notes: ['This profile was made by a newer', 'version of the Arena, so this battle', 'is not kept.'] })[6])) ? true : 'x');
    const lost = pagesOf(mkSum({ result: 'l', winner: 1, mvp: null }), null), forf = pagesOf(mkSum({ result: 'f', winner: 1, endedBy: 'forfeit', turns: 3, lastHit: null, flags: { noFaintWin: false, sweep: false, comeback: false, forfeit: true } }), null), draw = pagesOf(mkSum({ result: 'd', winner: -1, endedBy: 'turn-cap', turns: 300, lastHit: null }), null);
    add('pages/loss-forfeit-draw-have-their-own-words', /YOU LOST\./.test(txt(lost[0])) && /NONE: NOBODY SCORED/.test(txt(lost[0])) && /YOU GAVE UP\./.test(txt(forf[0])) && /ON TURN 3/.test(txt(forf[0])) && /THE BATTLE WAS GIVEN UP/.test(txt(forf[1])) && /GAVE UP/.test(txt(forf[1])) && /A DRAW\./.test(txt(draw[0])) && /NO LAST HIT: A DRAW/.test(txt(draw[1])) && /300 TURNS/.test(txt(draw[0])) ? true : txt(forf[0]) + ' || ' + txt(draw[1]));
    add('pages/moments-flags', /NO FAINTS/.test(txt(p[1])) && /2 KOS IN A ROW \(YOU\)/.test(txt(p[1])) && /NO WEATHER OR TERRAIN/.test(txt(p[1])) ? true : txt(p[1]));
    const fieldy = pagesOf(mkSum({ weather: [[1, 4], [3, 2]], weatherTurns: 6, terrain: [['grassy', 3]], terrainTurns: 3 }), null);
    add('pages/moments-weather-and-terrain-turns', /RAIN 4, SAND 2; GRASSY 3 TURNS/.test(txt(fieldy[1])) ? true : txt(fieldy[1]));
    add('pages/team-pages-list-every-Pokemon-with-the-numbers', /Pikachu/.test(txt(p[2])) && /Aron/.test(txt(p[2])) && /TOTAL/.test(txt(p[2])) && /Rattata/.test(txt(p[3])) && p[2].lines.length === 4 && p[3].lines.length === 3 ? true : txt(p[2]));
    add('pages/moves-page-ranks-by-use', /Thunder|Move/.test(txt(p[4])) && /x3/.test(txt(p[4])) && /MOVES USED/.test(txt(p[4])) && /DIFFERENT MOVES/.test(txt(p[4])) ? true : txt(p[4]));
    add('pages/compare-page-marks-the-bigger-number', p[5].lines.length === 9 && p[5].lines.slice(1).every((l) => l.cells.length === 3) ? true : String(p[5].lines.length));
    add('pages/callout-wording-is-a-sentence-for-every-kind', ['first-win', 'streak', 'fastest', 'hit', 'longest', 'ko-streak'].every((k) => RC.calloutText({ kind: k, n: 3 }).length > 5) && RC.calloutText({ kind: 'nonsense', n: 1 }) === '' ? true : 'x');
    add('pages/the-model-is-pure-and-deterministic', J(pagesOf(mkSum(), null)) === J(p) && J(JSON.parse(J(p))) === J(p) ? true : 'differs');
    add('pages/the-input-summary-is-not-modified', (() => { const s = mkSum(); const a = J(s); pagesOf(s, { state: 'saved', profileName: 'X', callouts: [], stats: { wins: 1, losses: 0, draws: 0, forfeits: 0, streak: 1, best: 1 } }); return J(s) === a ? true : 'modified'; })());
  });

  // ------------------------------------------------------------------------------------------------ B. fit
  const battles = [];
  await blk('battles', async () => {
    const levels = ['easy', 'normal', 'hard'];
    for (let i = 0; i < N_BATTLES; i++) {
      const b = build(200 + i * 29, i % 3 === 2 ? 0 : 3, levels[i % 3], { recap: false });
      const ai = AI.createAi({ pack, level: 'normal', seed: i });
      for (let g = 0; b.ctl.winner === null && g < 3000; g++) { const req = b.ctl.pending(0); if (!req) break; if (i % 11 === 5 && req.phase === 'move' && b.ctl.turn >= 2 && req.canForfeit) { b.ctl.submit(0, { kind: 'forfeit' }); break; } b.ctl.submit(0, ai.choose(req, b.ctl.view(0), { previewInfo: { foe: b.ctl.previewInfo[1] } })); }
      const teams = [0, 1].map((s) => b.ctl.battle.s.sides[s].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
      battles.push({ events: b.ctl.battle.events.slice(), teams, summary: MS.summarizeMatch(b.ctl.battle.events, { viewSide: 0, teams }) });
    }
  });
  await blk('fit', async () => {
    const careers = [null, { state: 'saved', profileName: 'MISTYMIST', callouts: [{ kind: 'fastest', n: 12 }, { kind: 'streak', n: 14 }, { kind: 'hit', n: 345 }, { kind: 'longest', n: 120 }], stats: { wins: 1234, losses: 123, draws: 12, forfeits: 5, streak: 12, best: 20 } }, { state: 'error' }, { state: 'pending' }, { state: 'duplicate', profileName: 'ASH', stats: { wins: 1, losses: 0, draws: 0, forfeits: 0, streak: 1, best: 1 } }, { state: 'none', notes: ['This profile was made by a newer', 'version of the Arena, so this battle', 'is not kept.'] }];
    let cells = 0, cuts = [], overlaps = [], outside = [], fonts = new Map();
    const inspect = (pages, tag) => {
      for (const pg of pages) for (const l of pg.lines) {
        const placed = [];
        for (const c of l.cells) {
          if (c.t === '') continue;
          cells++;
          const r = pd.fit(c);
          if (r.cut && !c.cutOk) cuts.push(tag + ' ' + pg.id + ' ' + J(c.t) + ' ' + r.w + '/' + c.w);
          fonts.set(r.font, (fonts.get(r.font) || 0) + 1);
          const x0 = c.a === 'r' ? c.x + c.w - r.w : c.a === 'c' ? c.x + Math.floor((c.w - r.w) / 2) : c.x;
          const h = c.f === 'normal' ? 16 : 12;
          if (x0 < 0 || x0 + r.w > RC.PAGE_W || l.y < 0 || l.y + h > RC.PAGE_H + 2) outside.push(tag + ' ' + pg.id + ' ' + J(c.t) + ' x' + x0 + '+' + r.w + ' y' + l.y);
          for (const q of placed) if (!(x0 + r.w <= q[0] || q[0] + q[1] <= x0)) overlaps.push(tag + ' ' + pg.id + ' ' + J(c.t) + ' overlaps ' + J(q[2]));
          placed.push([x0, r.w, c.t]);
        }
      }
    };
    battles.forEach((b, i) => { for (const career of careers) inspect(RC.buildRecapPages(b.summary, { ...names, career, mineLabel: 'YOU', foeLabel: 'CPU NORMAL' }), 'b' + i); });
    add('fit/no-cell-of-' + battles.length + '-real-battles-x-6-career-lines-is-cut (' + cells + ' cells)', cuts.length === 0 ? true : cuts.slice(0, 4).join(' | ') + ' (' + cuts.length + ')');
    add('fit/no-two-cells-of-a-line-overlap', overlaps.length === 0 ? true : overlaps.slice(0, 3).join(' | '));
    add('fit/every-cell-is-inside-the-window', outside.length === 0 ? true : outside.slice(0, 3).join(' | '));
    add('fit/the-ROM-font-ladder-is-used-only-where-needed (' + [...fonts].map((p) => p.join(':')).join(' ') + ')', fonts.has('small') && fonts.has('normal') ? true : J([...fonts]));
    // the longest names in the whole roster, in every slot a name can go
    const spIds = pack.roster.slice().sort((a, b) => ui.measure('small', pack.species[b].name) - ui.measure('small', pack.species[a].name)).slice(0, 12);
    const legalMoves = [...new Set(battles.flatMap((b) => b.summary.sides.flatMap((s) => s.moves.map((m) => m[0]))))].sort((a, b) => ui.measure('small', pack.moves[b].name) - ui.measure('small', pack.moves[a].name));
    const longMv = legalMoves.slice(0, 6);
    const fake = JSON.parse(J(battles[0].summary));
    fake.sides.forEach((s, si) => { s.mons.forEach((m, i) => { m.sp = spIds[(i + si * 6) % spIds.length]; m.name = pack.species[m.sp].name; }); s.moves = longMv.map((id, i) => [id, 20 - i]); });
    const hit = { side: 0, slot: 0, sp: fake.sides[0].mons[0].sp, mv: longMv[0], dmg: 999, pct: 100, crit: 1, eff: 8192, vs: { side: 1, slot: 0, sp: fake.sides[1].mons[0].sp }, turn: 12 };
    fake.biggestHit = hit; fake.firstBlood = { victim: hit.vs, by: { side: 0, slot: 0, sp: hit.sp, mv: longMv[0] }, cause: 'attack', turn: 1 }; fake.lastHit = { ...hit, victim: hit.vs };
    fake.mvp = { side: 0, slot: 0, sp: hit.sp, name: pack.species[hit.sp].name, score: 99999, scorePts: 9999, kos: 6, dealt: 9999, dealtPct: 999 };
    fake.closestCall = { side: 0, slot: 0, sp: hit.sp, name: pack.species[hit.sp].name, hp: 1, max: 999, pct: 1 };
    cuts = []; overlaps = []; outside = [];
    inspect(RC.buildRecapPages(fake, { ...names, career: careers[1], mineLabel: 'YOU', foeLabel: 'CPU NORMAL' }), 'longest');
    add('fit/the-longest-species-and-the-longest-moves-that-were-ever-used-fit-too', cuts.length === 0 && overlaps.length === 0 && outside.length === 0 ? true : [...cuts, ...overlaps, ...outside].slice(0, 4).join(' | '));
    // hostile numbers: a cut stays inside its cell
    const big = JSON.parse(J(battles[0].summary)); big.turns = 99999; big.sides[0].dealt = 99999999; big.sides[1].taken = 99999999; big.sides[0].hpLeftPct = 100;
    const ps = RC.buildRecapPages(big, { ...names, career: { state: 'saved', profileName: 'XXXXXXXXXX', callouts: [], stats: { wins: 9999999, losses: 9999999, draws: 9999999, forfeits: 9999999, streak: 9999, best: 9999 } } });
    let escaped = 0;
    for (const pg of ps) for (const l of pg.lines) for (const c of l.cells) if (c.t !== '') { const r = pd.fit(c); if (r.w > c.w) escaped++; }
    add('fit/hostile-numbers-never-leave-their-cell (a cut is allowed, an overflow is not)', escaped === 0 ? true : escaped + ' cells wider than their cell');
    add('fit/the-fit-function-cuts-rather-than-overflows', (() => { const r = pd.fit({ t: 'W'.repeat(60), x: 0, w: 50, a: 'l', f: 'small', tone: 'dark' }); return r.cut === true && r.w <= 50 ? true : J(r); })());
    add('fit/the-fit-function-keeps-short-text-in-the-asked-font', (() => { const r = pd.fit({ t: 'OK', x: 0, w: 50, a: 'l', f: 'normal', tone: 'dark' }); return r.font === 'normal' && !r.cut ? true : J(r); })());
  });

  // ------------------------------------------------------------------------------------------------ C. the scene
  await blk('scene-basic', async () => {
    const ends = [];
    const b = build(41, 3, 'normal', { onMatchEnd: (i) => ends.push(i), onResult: (o) => ends.push('result:' + o) });
    const finished = play(b);
    add('scene/the-battle-reaches-the-result-screen', finished ? true : 'mode ' + b.scene.mode);
    const { scene, ctl } = b;
    const v0 = scene.view();
    add('scene/the-result-view-carries-the-recap-flag-and-the-options-are-untouched', v0.screen === 'result' && v0.result.recap === true && J(v0.result.options) === J(['REMATCH', 'NEW BATTLE', 'BACK TO HUB']) && v0.result.cursor === 0 && scene.S.result.options.length === 3 ? true : J(v0.result).slice(0, 200));
    add('scene/onMatchEnd-fired-once-when-the-result-screen-appeared-with-the-summary', ends.length === 1 && ends[0].summary && ends[0].summary.result === (ctl.winner === 0 ? 'w' : 'l') && ends[0].ticks === scene.S.tick - 0 ? true : J(ends.map((e) => (e.summary ? 'info' : e))));
    const teams = [0, 1].map((s) => ctl.battle.s.sides[s].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
    add('scene/the-summary-is-the-pure-fold-of-the-whole-event-log', J(ends[0].summary) === J(MS.summarizeMatch(ctl.battle.events, { viewSide: 0, teams })) && J(scene.summary()) === J(ends[0].summary) ? true : 'differs');
    // the same summary after a replay of the saved human choices into a fresh controller (what a reload does)
    {
      const A = MC.randomTeam(pack, 41 * 1000 + 1, 6), Bt = MC.randomTeam(pack, 41 * 1000 + 2, 6);
      const ctl2 = MC.createMatchController({ pack, teams: [A.recs, Bt.recs], seed: 41, pick: 3, names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 46 }] });
      ctl2.start();
      for (const e of ctl.info().choiceLog.filter((q) => q.s === 0)) ctl2.submit(0, e.c);
      const teams2 = [0, 1].map((s) => ctl2.battle.s.sides[s].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
      add('scene/a-replay-of-the-saved-choices-gives-the-identical-summary (no double count after a reload)', ctl2.battle.hash() === ctl.battle.hash() && J(MS.summarizeMatch(ctl2.battle.events, { viewSide: 0, teams: teams2 })) === J(ends[0].summary) ? true : 'differs');
    }
    {
      const ends2 = [];
      const re = build(41, 3, 'normal', { onMatchEnd: (i) => ends2.push(i) }); play(re); const n1 = ends2.length;
      re.scene.S.mode = 'steps'; tick(re.scene, 5);
      add('scene/the match-end hook fires once even if the scene re-enters the result screen (idle() after a replay)', n1 === 1 && ends2.length === 1 && re.scene.mode === 'result' ? true : J([n1, ends2.length, re.scene.mode]));
    }
    // the guard: nothing opens, nothing is chosen, in the first 90 frames
    let leaked = false;
    for (let f = 0; f < SC.RESULT_GUARD_FRAMES - 6; f++) { scene.tick(); if (f % 3 === 0) { for (const act of [() => scene.press('a'), () => scene.choose.result(-1), () => scene.choose.result(0), () => scene.pointer({ kind: 'click', x: 30, y: 150 }), () => scene.pointer({ kind: 'click', x: 100, y: 150 })]) { act(); if (scene.mode !== 'result') leaked = true; } } }
    add('scene/D1-guard: mashing A and clicking every chip for the first 84 frames opens no recap and chooses nothing', !leaked && scene.mode === 'result' && ends.length === 1 && scene.state().resultArmed === false ? true : (leaked ? 'the recap opened inside the guard' : scene.mode + ' ' + J(ends.map((e) => (e.summary ? 'info' : e)))));
    add('scene/D1-guard: ...and the clicks moved the cursor (hover works) but never left the screen', scene.S.result.cursor === 0 || scene.S.result.cursor === -1 || scene.S.result.cursor === 0 ? true : 'x');
    armed(scene);
    scene.S.result.cursor = 0;
    // cursor ring
    scene.press('left');
    add('scene/the-cursor-ring: left from REMATCH goes to the RECAP chip (-1)', scene.state().resultCursor === -1 ? true : String(scene.state().resultCursor));
    scene.press('left');
    add('scene/...left again wraps to the last option', scene.state().resultCursor === 2 ? true : String(scene.state().resultCursor));
    scene.press('right');
    add('scene/...right from the last option comes back to RECAP', scene.state().resultCursor === -1 ? true : String(scene.state().resultCursor));
    scene.press('right'); scene.press('right'); scene.press('right'); scene.press('right');
    add('scene/...four rights go all the way round (4 stops)', scene.state().resultCursor === -1 ? true : String(scene.state().resultCursor));
    scene.press('up'); scene.press('down');
    add('scene/...up and down walk the same ring', scene.state().resultCursor === -1 ? true : String(scene.state().resultCursor));
    // open
    scene.press('a');
    add('scene/A on RECAP (after the guard) opens the recap on page 1 of 7', scene.mode === 'recap' && scene.state().recapPage === 0 && scene.state().recapCount === 7 && scene.view().screen === 'recap' && scene.view().recap.index === 0 && ends.length === 1 ? true : scene.mode + ' ' + J([scene.state().recapPage, scene.state().recapCount]));
    scene.press('start');
    add('scene/Start in the recap goes back to the result screen (it never opens the pause menu)', scene.mode === 'result' && !scene.S.menu && scene.S.result.cursor === -1 ? true : scene.mode);
    scene.press('a');
    scene.press('left');
    add('scene/left on the first page stays on it', scene.state().recapPage === 0 ? true : String(scene.state().recapPage));
    scene.press('right'); scene.press('down'); scene.press('r');
    add('scene/right, down and R each turn one page', scene.state().recapPage === 3 ? true : String(scene.state().recapPage));
    scene.press('up'); scene.press('l');
    add('scene/up and L turn back', scene.state().recapPage === 1 ? true : String(scene.state().recapPage));
    scene.press('x'); scene.press('y'); scene.press('select');
    add('scene/the other buttons do nothing in the recap', scene.state().recapPage === 1 && scene.mode === 'recap' ? true : 'moved');
    for (let i = 0; i < 12; i++) scene.press('right');
    add('scene/right on the last page stays on it (7 of 7)', scene.state().recapPage === 6 ? true : String(scene.state().recapPage));
    tick(scene, 600);
    add('scene/idle() leaves the recap alone for 600 frames (no new result screen, no reset)', scene.mode === 'recap' && scene.state().recapPage === 6 && ends.length === 1 ? true : scene.mode + ' ' + ends.length);
    scene.press('a');
    add('scene/A on the last page goes back to the result screen with the cursor still on RECAP', scene.mode === 'result' && scene.S.result.cursor === -1 ? true : scene.mode);
    scene.press('a');
    add('scene/...and A there opens the recap again: mashing A can loop through the recap forever but never reaches REMATCH', scene.mode === 'recap' && scene.state().recapPage === 0 && !ends.some((e) => typeof e === 'string') ? true : scene.mode);
    scene.press('b');
    add('scene/B leaves the recap at once from any page', scene.mode === 'result' ? true : scene.mode);
    let mash = 0; for (let i = 0; i < 200; i++) { scene.press('a'); mash++; if (scene.mode === 'result' && scene.S.result.cursor !== -1) break; }
    add('scene/200 presses of A from the RECAP chip never fire an option (the safe loop)', !ends.some((e) => typeof e === 'string') ? true : J(ends.filter((e) => typeof e === 'string')));
    // choosing a real option still works after the recap
    scene.S.result.cursor = 0; scene.press('a');
    add('scene/A on REMATCH after the guard still chooses REMATCH, once', J(ends.filter((e) => typeof e === 'string')) === J(['result:REMATCH']) ? true : J(ends.filter((e) => typeof e === 'string')));
    // pointer
    scene.press('left'); scene.press('a');
    const G = ui.GEOM.recap;
    const clickChip = (id) => { const c = G.chips.find((q) => q.id === id); scene.pointer({ kind: 'click', x: c.x + c.w / 2, y: c.y + c.h / 2 }); };
    clickChip('next');
    add('scene/pointer: NEXT turns the page', scene.state().recapPage === 1 ? true : String(scene.state().recapPage));
    clickChip('prev'); clickChip('prev');
    add('scene/pointer: PREV turns back and stops at the first page', scene.state().recapPage === 0 ? true : String(scene.state().recapPage));
    scene.pointer({ kind: 'move', x: G.chips[2].x + 5, y: G.chips[2].y + 5 });
    add('scene/pointer: hovering a chip highlights it (view.hover = next) without acting', scene.view().recap.hover === 'next' && scene.state().recapPage === 0 ? true : scene.view().recap.hover);
    scene.pointer({ kind: 'click', x: 120, y: 60 });
    add('scene/pointer: a click on the page is A (next page)', scene.state().recapPage === 1 ? true : String(scene.state().recapPage));
    scene.pointer({ kind: 'wheel', steps: 2 });
    add('scene/pointer: the wheel turns pages (down = next)', scene.state().recapPage === 3 ? true : String(scene.state().recapPage));
    scene.pointer({ kind: 'wheel', steps: -1 });
    add('scene/pointer: ...and up = back', scene.state().recapPage === 2 ? true : String(scene.state().recapPage));
    clickChip('back');
    add('scene/pointer: BACK returns to the result screen', scene.mode === 'result' && scene.S.result.cursor === -1 ? true : scene.mode);
    // the result chips
    const rr = ui.resultRects(scene.view().result);
    scene.pointer({ kind: 'move', x: rr.options[1].x + 5, y: rr.options[1].y + 5 });
    add('scene/pointer: hovering an option moves the cursor to it', scene.S.result.cursor === 1 ? true : String(scene.S.result.cursor));
    scene.pointer({ kind: 'move', x: rr.recap.x + 5, y: rr.recap.y + 5 });
    add('scene/pointer: hovering the RECAP chip puts the cursor on it', scene.S.result.cursor === -1 ? true : String(scene.S.result.cursor));
    scene.pointer({ kind: 'click', x: rr.recap.x + 5, y: rr.recap.y + 5 });
    add('scene/pointer: clicking the RECAP chip opens the recap', scene.mode === 'recap' ? true : scene.mode);
    scene.press('b');
    // the chips fit the screen and do not touch
    add('scene/the-four-chips-are-inside-the-screen-and-apart', [rr.recap, ...rr.options].every((r, i, a) => r.x >= 0 && r.x + r.w <= 240 && r.y + r.h <= 160 && (i === 0 || a[i - 1].x + a[i - 1].w <= r.x)) ? true : J(rr));
    // hit() == ui.hitTest() over a grid, in the result screen and in every recap page
    const gridDiff = () => { for (let x = 0; x < 240; x += 4) for (let y = 0; y < 160; y += 4) { const a = scene.hit(x, y), c = ui.hitTest(scene.view(), x, y); if (J(a) !== J(c)) return scene.mode + ' (' + x + ',' + y + ') scene ' + J(a) + ' ui ' + J(c); } return true; };
    add('scene/hit-test: scene.hit == ui.hitTest over a 4 px grid on the result screen', gridDiff());
    scene.press('a');
    let gd = true; for (let p = 0; p < 7 && gd === true; p++) { gd = gridDiff(); scene.press('right'); }
    add('scene/hit-test: ...and on all seven recap pages', gd);
    scene.press('b');
    // setCareer repaints
    scene.press('a'); for (let i = 0; i < 6; i++) scene.press('right');
    const before = J(scene.view());
    scene.setCareer({ state: 'saved', profileName: 'ASH', callouts: [{ kind: 'hit', n: 99 }], stats: { wins: 1, losses: 0, draws: 0, forfeits: 0, streak: 1, best: 1 } });
    const after = J(scene.view());
    add('scene/setCareer repaints the RECORD page (the view changes, the page now says SAVED TO ASH)', before !== after && /SAVED TO ASH/.test(after) && /pending|SAVING/.test(before) ? true : before.slice(0, 120));
    add('scene/state-reports-the-career-line', scene.state().career === 'saved' ? true : String(scene.state().career));
    // render
    const f1 = ui.render(scene.view());
    add('scene/the-recap-screen-renders-opaque-240x160', f1.width === 240 && f1.height === 160 && f1.rgba.length === 240 * 160 * 4 && f1.rgba.every((v, i) => i % 4 !== 3 || v === 255) ? true : 'bad frame');
  });

  await blk('scene-opts', async () => {
    const b = build(41, 3, 'normal', { recap: false, resultGuard: 0 });
    play(b);
    const { scene } = b;
    add('legacy/recap:false keeps the three-button result screen (no flag, no chip, the old cursor ring)', scene.view().result.recap === undefined && scene.S.result.recap === false && scene.summary() === null ? true : J(scene.view().result).slice(0, 160));
    scene.press('left');
    add('legacy/...left from REMATCH wraps to the LAST option, as before', scene.state().resultCursor === 2 ? true : String(scene.state().resultCursor));
    add('legacy/...choose.result(-1) does nothing', (() => { const c0 = scene.state().resultCursor; scene.choose.result(-1); return scene.state().resultCursor === c0 && scene.mode === 'result' ? true : 'moved'; })());
    const rr = ui.resultRects(scene.view().result);
    add('legacy/...the options sit where they always did (x 8, pitch 76, width 70)', rr.recap === null && rr.options[0].x === 8 && rr.options[1].x === 84 && rr.options[0].w === 70 ? true : J(rr));
    const dif = (() => { for (let x = 0; x < 240; x += 4) for (let y = 0; y < 160; y += 4) { if (J(scene.hit(x, y)) !== J(ui.hitTest(scene.view(), x, y))) return '(' + x + ',' + y + ')'; } return true; })();
    add('legacy/...and scene.hit == ui.hitTest on it', dif);
    let n = 0; const fired = []; scene.hooks.onResult = (o) => fired.push(o);
    scene.S.result.cursor = 0; scene.press('a');
    add('legacy/...A chooses REMATCH at once with the guard set to 0', fired.length === 1 && fired[0] === 'REMATCH' ? true : J(fired)); void n;
  });

  await blk('scene-forfeit-and-hooks', async () => {
    const ends = [];
    const b = build(21, 0, 'normal', { onMatchEnd: (i) => ends.push(i) });
    play(b, { forfeitAt: 2 });
    add('forfeit/a forfeit reaches the result screen as a forfeit (result f, the recap says so)', b.scene.mode === 'result' && ends.length === 1 && ends[0].summary.result === 'f' && ends[0].summary.endedBy === 'forfeit' ? true : b.scene.mode + ' ' + J(ends.map((e) => e.summary && [e.summary.result, e.summary.endedBy])));
    armed(b.scene); b.scene.S.result.cursor = -1; b.scene.press('a');
    add('forfeit/...its recap reads YOU GAVE UP and ON TURN n', /YOU GAVE UP\./.test(J(b.scene.view().recap.page)) && /ON TURN \d+/.test(J(b.scene.view().recap.page)) ? true : J(b.scene.view().recap.page).slice(0, 200));
    // a scene that has no onMatchEnd hook: the career line says NOT SAVED, no throw
    const n = build(22, 3, 'easy', {});
    play(n); armed(n.scene); n.scene.S.result.cursor = -1; n.scene.press('a'); for (let i = 0; i < 6; i++) n.scene.press('right');
    add('hooks/without an onMatchEnd hook the RECORD page says NOT SAVED', /NOT SAVED/.test(J(n.scene.view().recap.page)) && n.scene.state().career === null ? true : J(n.scene.view().recap.page).slice(0, 200));
    // a hook that throws does not stop the result screen
    const t = build(23, 3, 'easy', { onMatchEnd: () => { throw new Error('boom'); } });
    add('hooks/a throwing onMatchEnd does not stop the result screen', play(t) && t.scene.mode === 'result' ? true : t.scene.mode);
    // a late setCareer after the player left the recap is harmless
    add('hooks/setCareer(null) and setCareer(junk) are harmless', (() => { try { t.scene.setCareer(null); t.scene.setCareer(5); t.scene.setCareer({ state: 'saved' }); armed(t.scene); t.scene.S.result.cursor = -1; t.scene.press('a'); for (let i = 0; i < 6; i++) t.scene.press('right'); ui.render(t.scene.view()); return true; } catch (e) { return 'threw ' + e.message; } })());
    // a draw (turn cap): build a summary by hand through the scene's own fold: use a log with a draw event
    add('hooks/the scene builds a summary for a draw too', (() => { const s = MS.summarizeMatch([{ t: 'start', names: ['You', 'CPU'], sizes: [1, 1], pick: 0 }, { t: 'turn-cap', n: 300 }, { t: 'draw' }], { viewSide: 0 }); return s.result === 'd' && RC.buildRecapPages(s, names).length === 7 ? true : s.result; })());
  });

  // ------------------------------------------------------------------------------------------------ D. render and wiring
  await blk('render', async () => {
    const b = build(41, 3, 'normal', { onMatchEnd: () => {} });
    play(b); armed(b.scene); b.scene.S.result.cursor = -1; b.scene.press('a');
    const hashes = [];
    for (let i = 0; i < 7; i++) { hashes.push(crypto.createHash('sha1').update(ui.render(b.scene.view()).rgba).digest('hex')); b.scene.press('right'); }
    add('render/the-seven-recap-pages-are-seven-different-pictures', new Set(hashes).size === 7 ? true : String(new Set(hashes).size));
    // determinism of the scene's view
    const v1 = J(b.scene.view()), v2 = J(b.scene.view());
    add('render/the-view-is-a-pure-function-of-the-state (no timers, no randomness)', v1 === v2 ? true : 'differs');
    // a zeroed ROM font changes the recap screens
    const zeroFont = Buffer.from(rom); zeroFont.fill(0, 0x626524 + 161 * 64, 0x626524 + 256 * 64);
    const ui2 = B.createBattleUi(zeroFont);
    b.scene.press('b'); b.scene.press('a');
    const f0 = crypto.createHash('sha1').update(ui.render(b.scene.view()).rgba).digest('hex'), f2 = crypto.createHash('sha1').update(ui2.render(b.scene.view()).rgba).digest('hex');
    add('render/zeroing-the-ROM-small-font-changes-the-recap-page (its text is the ROM\'s)', f0 !== f2 ? true : 'unchanged');
    const zeroPal = Buffer.from(rom); zeroPal.fill(0, 0x73c650, 0x73c650 + 512);
    const f3 = crypto.createHash('sha1').update(B.createBattleUi(zeroPal).render(b.scene.view()).rgba).digest('hex');
    add('render/zeroing-the-ROM-party-menu-palette-changes-it (the background and chips are the ROM\'s)', f0 !== f3 ? true : 'unchanged');
    const sys = fs.readFileSync(path.join(JS, 'sound_system.js'), 'utf8');
    add('sound/the-recap-is-a-menu-mode-and-a-page-turn-changes-the-scene-signature', /MENU_MODES = Object\.freeze\(\[[^\]]*'recap'/.test(sys) && /s\.resultCursor, s\.recapPage/.test(sys) ? true : 'sound_system.js does not know the recap');
    const st = b.scene.state();
    add('sound/state-exposes-recapPage-so-sceneSig-moves-with-every-page', st.recapPage === 0 && (b.scene.press('right'), b.scene.state().recapPage === 1) ? true : J(st));
  });
  return out;
}

/* ===================================================================================================== run, then mutants */
function copyJs(dest) { fs.mkdirSync(dest, { recursive: true }); for (const n of fs.readdirSync(JS)) { const s = path.join(JS, n); if (fs.statSync(s).isFile() && (n.endsWith('.js') || n.endsWith('.json'))) fs.copyFileSync(s, path.join(dest, n)); } return dest; }

head('A-D. the real modules');
const real = await loadFrom(JS);
const t0 = Date.now();
const res = await suite(real);
for (const [name, ok] of res) report(name, ok);
console.log(`  ${res.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const MUTANTS = [
  ['E01 the guard does not cover the RECAP chip', 'scene.js', "    if (!resultArmed()) return; // D1: the result screen has not been readable long enough yet: the choice is ignored\n    if (i === -1) { openRecap(); return; }", "    if (i === -1) { openRecap(); return; }\n    if (!resultArmed()) return;", ['scene/D1-guard: mashing A and clicking every chip for the first 84 frames opens no recap and chooses nothing']],
  ['E02 idle() starts a new result screen while the recap is open', 'scene.js', "if (S.mode !== 'result' && S.mode !== 'recap') startResult();", "if (S.mode !== 'result') startResult();", ['scene/idle() leaves the recap alone for 600 frames (no new result screen, no reset)']],
  ['E03 Start in the recap opens the pause menu', 'scene.js', "m !== 'menu' && m !== 'recap') { openMenu(); return true; }", "m !== 'menu') { openMenu(); return true; }", ['scene/Start in the recap goes back to the result screen (it never opens the pause menu)']],
  ['E04 A on the last page does not go back', 'scene.js', "else if (a === 'a') { if (rc.page < last) recapStep(1); else closeRecap(); }", "else if (a === 'a') { if (rc.page < last) recapStep(1); }", ['scene/A on the last page goes back to the result screen with the cursor still on RECAP']],
  ['E05 the match-end hook fires on every result screen', 'scene.js', "    if (!S.matchEnded) {\n      S.matchEnded = true;", "    {\n      S.matchEnded = true;", ['scene/the match-end hook fires once even if the scene re-enters the result screen (idle() after a replay)']],
  ['E06 the page number is not clamped', 'scene.js', "rc.page = clamp(rc.page + d, 0, last);", "rc.page = rc.page + d;", ['scene/left on the first page stays on it']],
  ['E07 the recap hit test is off by one chip', 'scene.js', "for (const c of ui.GEOM.recap.chips) if (inRect({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 }, x, y)) return { kind: 'recap-' + c.id, index: 0 };\n      return inRect({ x: 0, y: 0, w: 240, h: 138 }, x, y)", "for (const c of ui.GEOM.recap.chips) if (inRect({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 }, x, y)) return { kind: 'recap-' + c.id, index: 0 };\n      return inRect({ x: 0, y: 0, w: 240, h: 150 }, x, y)", ['scene/hit-test: ...and on all seven recap pages']],
  ['E08 the cursor ring skips the RECAP chip going left', 'scene.js', "if (a === 'left' || a === 'up') r.cursor = r.cursor - 1 < lo ? n - 1 : r.cursor - 1;", "if (a === 'left' || a === 'up') r.cursor = r.cursor - 1 < 0 ? n - 1 : r.cursor - 1;", ['scene/the-cursor-ring: left from REMATCH goes to the RECAP chip (-1)']],
  ['E09 the summary is built from the screen state instead of the log', 'scene.js', "S.result.summary = summarizeMatch(ctl.battle.events, { viewSide, teams });", "S.result.summary = summarizeMatch(ctl.battle.events.slice(0, 40), { viewSide, teams });", ['scene/the-summary-is-the-pure-fold-of-the-whole-event-log']],
  ['E10 the wheel does nothing in the recap', 'scene.js', "else if (m === 'recap') recapInput(a === 'down' ? 'right' : 'left');", "", ['scene/pointer: the wheel turns pages (down = next)']],
  ['E11 a click on the page does nothing', 'scene.js', "case 'recap-page': recapInput('a'); break;", "case 'recap-page': break;", ['scene/pointer: a click on the page is A (next page)']],
  ['E12 recap:false still shows the recap chip', 'scene.js', "if (opts.recap !== false) {", "if (true) {", ['legacy/recap:false keeps the three-button result screen (no flag, no chip, the old cursor ring)']],
  ['E13 the career line never repaints', 'scene.js', "setCareer(info) { S.career = info && typeof info === 'object' ? { ...info } : null; S.careerVer++; },", "setCareer(info) { S.career = info && typeof info === 'object' ? { ...info } : null; },", ['scene/setCareer repaints the RECORD page (the view changes, the page now says SAVED TO ASH)']],
  ['E14 a throwing hook stops the result screen', 'scene.js', "catch (_e) { /* the page's recorder must not stop the result screen */ }", "catch (e) { throw e; }", ['hooks/a throwing onMatchEnd does not stop the result screen', 'crash/scene-forfeit-and-hooks']],
  ['E16 the recap page loses its MVP icon', 'recap_model.js', "summary1.icons.push({ sp: m.sp, x: 0, y: 19 });", "", ['pages/summary-win']],
  ['E17 callouts are not shown on the summary', 'recap_model.js', "if (callouts.length) summary1.lines.push(", "if (false) summary1.lines.push(", ['pages/a-record-replaces-first-blood-on-the-summary-in-its-own-tone']],
  ['E18 the fit function overflows instead of cutting', 'page_draw.js', "    while (t.length > 0 && width(font, t) > c.w) t = t.slice(0, -1);\n    return { font, text: t, w: width(font, t), cut: true };", "    return { font, text: t, w: width(font, t), cut: true };", ['fit/the-fit-function-cuts-rather-than-overflows']],
  ['E19 the font ladder is not used', 'page_draw.js', "const LADDER = { normal: ['normal', 'narrow', 'smallNarrow'], small: ['small', 'smallNarrow']", "const LADDER = { normal: ['normal'], small: ['small']", []],
  ['E20 a forfeit reads as a loss in the recap', 'recap_model.js', "f: 'YOU GAVE UP.'", "f: 'YOU LOST.'", ['pages/loss-forfeit-draw-have-their-own-words']],
];
if (!process.env.ARENA_SKIP_MUTANTS) {
  head('E. mutants (a temp copy of pokemonarena/js each)');
  const run = async (file, from, to) => {
    const dir = copyJs(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-recap-')));
    try {
      if (file) { const p = path.join(dir, file); const s = fs.readFileSync(p, 'utf8'); const n = s.split(from).length - 1; if (n !== 1) throw new Error('mutation target found ' + n + 'x in ' + file + ': ' + from.slice(0, 80)); fs.writeFileSync(p, s.replace(from, () => to)); }
      const M = await loadFrom(dir);
      return (await suite(M)).filter(([, ok]) => ok !== true).map(([n]) => n);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  };
  const twin = await run(null);
  report('mutants: the unmutated copy through the same loader passes every check', twin.length === 0, twin.slice(0, 3).join(' | '));
  let caught = 0;
  for (const [id, file, from, to, expect] of MUTANTS) {
    let fails;
    try { fails = await run(file, from, to); } catch (e) { report(id + ' loads', false, e.message); continue; }
    const named = expect.length ? expect.some((x) => fails.some((f) => f.startsWith(x.slice(0, 60)))) : fails.length > 0;
    if (named) caught++;
    report(id + ' -> ' + (expect.length ? 'caught by a NAMED check' : 'caught by some check'), named, 'failed: ' + (fails.join(' | ').slice(0, 240) || 'none'));
  }
  console.log(`  mutants ${caught}/${MUTANTS.length}`);
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }
