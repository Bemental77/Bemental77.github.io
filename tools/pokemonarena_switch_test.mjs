#!/usr/bin/env node
// POKEMONARENA FREE SWITCH TEST -- "Will you switch your Pokemon?" (the Gen 3 trainer-battle prompt, Battle Style SHIFT / SET).
//
// What the feature is: when the CPU's Pokemon has fainted and the CPU has another, the CPU chooses its replacement first and then the human is asked, in the ROM's own words, "<TRAINER> is about to
// send out <MON>. Will you switch your Pokemon?" with YES / NO. YES opens the party screen (B comes back to the question) and the Pokemon picked comes in NOW, for free: it uses no move and no turn,
// takes its entry hazards and abilities, and only then does the CPU's replacement come in. NO changes nothing. It exists only against the CPU (an online battle has no such prompt) and BATTLE STYLE: SET
// (arena.battlestyle, ?style=set, the pause menu's row) never asks. The engine expresses it as `freeSwitch` (a request { phase 'switch', reason 'free' }, answered by { kind 'switch', slot } or the new
// { kind 'stay' }, wire word 7), so the answer is an ordinary recorded choice: the choice log, the replay, the reload record, the stats collector and the controller API all see it as one.
//
//   A  ENGINE      the offer, its request, both answers, hazards / abilities on entry, no turn used, refusals, the cases where nothing is offered, entry faints, forfeit, snapshot / restore / replay, the wire
//   B  CONTROLLER  matchctl: who is offered (a human seat against a CPU, nobody else: an online controller never), the CPU answers FIRST, onLocalChoice, whole battles under three answer policies, replay
//   C  STATS       the match summary of battles with free switches: turns are engine turns, the switch is counted as a switch, nothing breaks
//   D  SCENE       the real scene on the real engine: the ROM text, YES / NO (cursor on YES), the party screen and B back, NO, taps, the pause menu, BATTLE STYLE: SET (frame for frame the old battle), the menu row
//   E  RESUME      battle_resume.js: a saved battle with free switches replays to the same state; a record from before (or into a controller that does not offer) is refused cleanly
//   F  SETTINGS    style_settings.js, ?style= in the battle address, the ROM's own option words, opensOnPreview, ai.js
//   G  MUTANTS     one-snippet defects (a temp copy of pokemonarena/js each); each must fail a NAMED check
//
//   node tools/pokemonarena_switch_test.mjs [--mutants]        ARENA_ROM, ARENA_SEEDS (default 30)
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
const SEEDS = Math.max(6, Number(process.env.ARENA_SEEDS || 30));
const WANT_MUTANTS = process.argv.includes('--mutants');
const J = (x) => JSON.stringify(x);
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));

let passed = 0, failed = 0;
const failures = [];
function report(name, ok, detail) { if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { failed++; const why = typeof ok === 'string' ? ok : detail || ''; failures.push(name + ': ' + why); console.log('  FAIL ' + name + (why ? ' -- ' + String(why).slice(0, 400) : '')); } }
const head = (s) => console.log('\n== ' + s);

const loadFrom = async (dir) => {
  const u = (n) => import(pathToFileURL(path.join(dir, n)).href);
  const [T, E, ED, MC, AI, SC, BU, BT, RS, BB, OM, SS, MS, CS] = await Promise.all([u('tables.js'), u('engine.js'), u('engine_data.js'), u('matchctl.js'), u('ai.js'), u('scene.js'), u('battle_ui.js'), u('battle_text.js'), u('battle_resume.js'), u('battle_boot.js'), u('online_match.js'), u('style_settings.js'), u('match_stats.js'), u('career_stats.js')]);
  const pack = T.loadPack(rom, { verify: 'header', dexText: false });
  return { T, E, ED, MC, AI, SC, RS, BB, OM, SS, MS, CS, pack, ui: BU.createBattleUi(rom), text: BT.loadBattleText(rom, manifest), BT };
};

/* ===================================================================================================== the suite, over any module tree */
async function suite(M) {
  const out = [];
  const add = (name, result, detail) => out.push([name, result === true ? true : (detail !== undefined && detail !== '' ? String(detail) : result === false ? 'false' : result)]);
  const blk = async (name, fn) => { try { await fn(); } catch (e) { add('crash/' + name, 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } };
  const { E, ED, MC, AI, SC, RS, BB, OM, SS, MS, CS, pack, ui, text, BT } = M;
  const teamOf = (seed, n) => MC.randomTeam(pack, seed, n);
  const abId = (name) => pack.abilities.find((a) => a && a.name === name).id;

  /* ---- engine harness: white-box, so every case is exact. A battle on turn 1 (no preview), then the foe's active Pokemon "has just fainted" and the end of the turn opens the replacement phase ---- */
  const mk = (o = {}) => {
    const A = teamOf(100 + (o.seed || 1), o.n || 6), B = teamOf(200 + (o.seed || 1), o.nB || o.n || 6);
    const b = E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: o.seed || 1, names: ['A', 'B'], freeSwitch: 'fs' in o ? o.fs : [true, false], ...(o.opts || {}) });
    return { b, A, B };
  };
  const ko = (b, s) => { const m = b.act(s); m.hp = 0; m.fnt = 1; m.s = 0; m.sc = 0; };
  const endTurn = (b) => { b.drain(); b.endOfTurn(); return b.drain(); };
  const foeAnswers = (b, k = 0) => { const r = b.requests()[1]; const slot = r.switches[k].slot; const res = b.choose(1, { kind: 'switch', slot }); return { res, slot }; };
  // a ready-made offer: side 1 is KO'd, the end of the turn has run, the CPU side has chosen its replacement
  const offered = (o = {}) => { const x = mk(o); if (o.pre) o.pre(x.b); ko(x.b, 1); if (o.also) o.also(x.b); x.ev0 = endTurn(x.b); x.foe = foeAnswers(x.b, o.foeK || 0); return x; };
  const idx = (ev, pred, from = 0) => { for (let i = from; i < ev.length; i++) if (pred(ev[i])) return i; return -1; };

  /* ---- A. ENGINE ---- */
  await blk('engine', async () => {
    const x = offered();
    const b = x.b, S = b.s;
    add('engine/the offer opens the faint phase with the foe asked to replace AND the other side offered: S.fo 0, fs [1,0], need [true,true], reason faint', S.phase === 'switch' && S.reason === 'faint' && S.fo === 0 && J(S.fs) === '[1,0]' && J(S.need) === '[true,true]', J({ phase: S.phase, reason: S.reason, fo: S.fo, fs: S.fs, need: S.need }));
    const rq = b.requests();
    add('engine/the offered side\'s request is { phase switch, reason free, switches (every living Pokemon but the active one), next, canForfeit }', rq[0].phase === 'switch' && rq[0].reason === 'free' && rq[0].switches.length === 5 && rq[0].switches.every((m) => m.hp > 0 && m.slot !== S.sides[0].act) && 'next' in rq[0] && rq[0].canForfeit === true, J(rq[0]).slice(0, 220));
    add('engine/... `next` names the foe\'s replacement exactly as the foe chose it (slot, species, name, level)', (() => { const t = S.sides[1].team[x.foe.slot]; return !!rq[0].next && rq[0].next.slot === x.foe.slot && rq[0].next.sp === t.sp && rq[0].next.name === t.name && rq[0].next.level === t.level; })(), J(rq[0].next));
    add('engine/... the foe\'s own request is the ordinary forced replacement (reason faint) until it has chosen, and `next` is null before it has', (() => { const y = mk(); ko(y.b, 1); endTurn(y.b); const r = y.b.requests(); return r[1].phase === 'switch' && r[1].reason === 'faint' && r[0].reason === 'free' && r[0].next === null; })(), J(b.requests()[1]).slice(0, 100));
    add('engine/it is not ready until the offered side answers, and advance() then does nothing at all', !b.ready() && (() => { const h0 = b.hash(); const ev = b.advance(); return ev.length === 0 && b.hash() === h0 && S.phase === 'switch'; })());

    // NO
    const n0 = offered();
    const turn0 = n0.b.s.turn, actBefore = n0.b.s.sides[0].act, hpBefore = n0.b.s.sides[0].team.map((m) => m.hp);
    const r0 = n0.b.choose(0, { kind: 'stay' });
    const ev = n0.b.advance();
    add('engine/NO ({ kind stay }) is accepted, logged once as an ordinary choice, and the battle goes on with the foe\'s replacement alone', r0.ok && J(n0.b.choiceLog.map((e) => [e.s, e.c.kind])) === '[[1,"switch"],[0,"stay"]]' && J(ev.map((e) => e.t + ':' + e.s).filter((q) => /switch|turn/.test(q))) === '["switch-in:1","turn:undefined"]', J({ r0, ev: ev.map((e) => e.t + ':' + e.s) }));
    add('engine/... the player\'s Pokemon is untouched (same active, same HP) and the next turn is exactly one more than before: a free switch is not a turn', n0.b.s.sides[0].act === actBefore && J(n0.b.s.sides[0].team.map((m) => m.hp)) === J(hpBefore) && n0.b.s.turn === turn0 + 1 && n0.b.s.phase === 'move' && n0.b.s.fo === undefined, J({ turn0, turn: n0.b.s.turn, phase: n0.b.s.phase }));
    add('engine/... the replacement is the one the foe chose and only it entered (one switch-in on side 1, none on side 0)', ev.filter((e) => e.t === 'switch-in').length === 1 && ev.find((e) => e.t === 'switch-in').s === 1 && ev.find((e) => e.t === 'switch-in').m === n0.foe.slot, J(ev.filter((e) => e.t === 'switch-in')));

    // YES
    const y0 = offered();
    const pp0 = J(y0.b.s.sides[0].team.map((m) => m.mv.map((q) => q.pp)));
    const slotY = y0.b.requests()[0].switches[2].slot;
    const ry = y0.b.choose(0, { kind: 'switch', slot: slotY });
    const evy = y0.b.advance();
    const tags = evy.map((e) => e.t + (e.s !== undefined ? ':' + e.s : ''));
    add('engine/YES ({ kind switch, slot }) brings that Pokemon in: switch-out and switch-in for the player, THEN the foe\'s switch-in, then the next turn', ry.ok && J(tags.filter((q) => /^(switch-out|switch-in|turn)/.test(q))) === '["switch-out:0","switch-in:0","switch-in:1","turn"]' && y0.b.s.sides[0].act === slotY, J(tags));
    add('engine/... it uses no move (no move-use event, every PP untouched) and no turn (the next turn is old + 1)', !evy.some((e) => e.t === 'move-use') && J(y0.b.s.sides[0].team.map((m) => m.mv.map((q) => q.pp))) === pp0 && y0.b.s.turn === y0.b.s.turn && y0.b.s.turn === x.b.s.turn + 1 && y0.b.s.phase === 'move', J({ turn: y0.b.s.turn }));
    add('engine/... the choice log reads: the foe\'s replacement first (the CPU answers first), then the player\'s switch', J(y0.b.choiceLog) === J([{ s: 1, c: { kind: 'switch', slot: y0.foe.slot } }, { s: 0, c: { kind: 'switch', slot: slotY } }]), J(y0.b.choiceLog));
    add('engine/... the event for the old Pokemon says it left: switch-out carries its slot, switch-in the new one\'s species and slot', (() => { const so = evy.find((e) => e.t === 'switch-out'), si = evy.find((e) => e.t === 'switch-in' && e.s === 0); return so.m === 0 && si.m === slotY && si.sp === y0.b.s.sides[0].team[slotY].sp; })());

    // hazards and abilities on entry
    const hz = offered({ also: (bb) => { bb.s.sides[0].hz.sr = 1; bb.s.sides[0].team.forEach((m) => { m.ty = [ED.T.NORMAL]; }); bb.s.sides[0].hz.sp = 2; } });
    hz.b.choose(0, { kind: 'switch', slot: 3 });
    const hev = hz.b.advance();
    const hiR = idx(hev, (e) => e.t === 'hazard-damage' && e.s === 0 && e.hz === 'rocks'), hiS = idx(hev, (e) => e.t === 'hazard-damage' && e.s === 0 && e.hz === 'spikes'), siFoe = idx(hev, (e) => e.t === 'switch-in' && e.s === 1), siMe = idx(hev, (e) => e.t === 'switch-in' && e.s === 0);
    add('engine/YES: the new Pokemon takes Stealth Rock and Spikes, and the damage comes BEFORE the foe\'s Pokemon is sent out', siMe >= 0 && hiR > siMe && hiS > siMe && hiR < siFoe && hiS < siFoe && hz.b.s.sides[0].team[3].hp < hz.b.s.sides[0].team[3].mhp, J({ siMe, hiR, hiS, siFoe, hp: hz.b.s.sides[0].team[3].hp + '/' + hz.b.s.sides[0].team[3].mhp }));
    const fhz = offered({ also: (bb) => { bb.s.sides[1].hz.sr = 1; } });
    fhz.b.choose(0, { kind: 'stay' });
    const fev = fhz.b.advance();
    add('engine/the foe\'s replacement still takes ITS hazards as it enters (the offer does not skip them)', idx(fev, (e) => e.t === 'hazard-damage' && e.s === 1) > idx(fev, (e) => e.t === 'switch-in' && e.s === 1) && idx(fev, (e) => e.t === 'switch-in' && e.s === 1) >= 0, J(fev.map((e) => e.t + ':' + e.s)));
    const dz = offered({ also: (bb) => { bb.s.sides[0].team[4].ab = abId('Drizzle'); } });
    dz.b.choose(0, { kind: 'switch', slot: 4 });
    const dev = dz.b.advance();
    add('engine/YES: the new Pokemon\'s entry ability runs (Drizzle sets the rain) before the foe\'s Pokemon arrives, and the weather is on when the foe enters', idx(dev, (e) => e.t === 'weather') > idx(dev, (e) => e.t === 'switch-in' && e.s === 0) && idx(dev, (e) => e.t === 'weather') < idx(dev, (e) => e.t === 'switch-in' && e.s === 1) && dz.b.s.wx[0] === ED.WX.RAIN, J(dev.map((e) => e.t + ':' + e.s)));
    const it = offered({ also: (bb) => { bb.s.sides[0].team[4].ab = abId('Intimidate'); } });
    it.b.choose(0, { kind: 'switch', slot: 4 });
    const iev = it.b.advance();
    add('engine/YES with Intimidate: it finds nobody to intimidate (the foe\'s Pokemon has fainted and the replacement is not in yet), as in the real game, and the replacement arrives at +0', !iev.some((e) => e.t === 'stat-change') && it.b.act(1).sg.atk === 0 && idx(iev, (e) => e.t === 'ability' && e.s === 0) < 0 || (iev.some((e) => e.t === 'ability' && e.s === 0) && !iev.some((e) => e.t === 'stat-change') && it.b.act(1).sg.atk === 0), J(iev.map((e) => e.t + ':' + e.s)));

    // refusals
    const z = offered();
    const code = (side, c) => z.b.choose(side, c).code;
    add('engine/refused by name during the offer: the active slot (active), a slot outside the team (bad-slot), a fainted one (fainted), a move / a preview (wrong-phase)', (() => { z.b.s.sides[0].team[5].hp = 0; z.b.s.sides[0].team[5].fnt = 1; return code(0, { kind: 'switch', slot: 0 }) === 'active' && code(0, { kind: 'switch', slot: 9 }) === 'bad-slot' && code(0, { kind: 'switch', slot: 5 }) === 'fainted' && code(0, { kind: 'move', slot: 0 }) === 'wrong-phase' && code(0, { kind: 'preview', order: [0] }) === 'wrong-phase'; })(), J([code(0, { kind: 'switch', slot: 0 }), code(0, { kind: 'move', slot: 0 })]));
    const w = mk(); ko(w.b, 1); endTurn(w.b);
    add('engine/a stay from the side that is NOT offered (the foe being replaced) is wrong-phase, and so is one at an ordinary turn (nothing is asked)', w.b.choose(1, { kind: 'stay' }).code === 'wrong-phase' && mk().b.choose(0, { kind: 'stay' }).code === 'wrong-phase', J([w.b.choose(1, { kind: 'stay' }).code, mk().b.choose(0, { kind: 'stay' }).code]));
    const w2 = mk({ fs: [true, false] }); ko(w2.b, 0); endTurn(w2.b);
    add('engine/a stay in an ordinary replacement phase (the player\'s own Pokemon fainted: no offer) is wrong-phase', w2.b.s.fo === undefined && w2.b.requests()[0].reason === 'faint' && w2.b.choose(0, { kind: 'stay' }).code === 'wrong-phase', J(w2.b.requests()[0]).slice(0, 100));
    const z2 = offered(); z2.b.choose(0, { kind: 'stay' });
    add('engine/an answer is final: a second one is already-chosen (the same or the other)', z2.b.choose(0, { kind: 'stay' }).code === 'already-chosen' && z2.b.choose(0, { kind: 'switch', slot: 1 }).code === 'already-chosen');
    add('engine/a hostile stay (extra fields, a getter) is read once and accepted as a plain stay', (() => { const q = offered(); const c = { kind: 'stay', slot: 99, junk: {} }; Object.defineProperty(c, 'order', { get() { throw new Error('read'); } }); return q.b.choose(0, c).ok && J(q.b.choiceLog[q.b.choiceLog.length - 1]) === '{"s":0,"c":{"kind":"stay"}}'; })());

    // nothing offered
    const none = (label, fn, why) => { const q = mk(); fn(q.b); ko(q.b, 1); endTurn(q.b); add('engine/not offered ' + label, q.b.s.fo === undefined && q.b.requests()[0].phase === 'wait' && q.b.requests()[1].phase === 'switch' && J(q.b.s.need) === '[false,true]' && why === why, J({ fo: q.b.s.fo, need: q.b.s.need, rq: q.b.requests()[0].phase })); };
    { const q = mk({ fs: [false, true] }); ko(q.b, 1); endTurn(q.b); add('engine/not offered when the option is on for the OTHER side only ([false, true]: side 0 sees an ordinary wait)', q.b.s.fo === undefined && q.b.requests()[0].phase === 'wait' && J(q.b.s.need) === '[false,true]'); }
    none('when the player\'s Pokemon is trapped (it could not leave the field)', (bb) => { bb.act(0).v.meanlook = 1; }, 'x');
    none('when the player\'s Pokemon is held by a binding move', (bb) => { bb.act(0).v.trap = { t: 3, src: 1, var: 0 }; }, 'x');
    none('when the player\'s Pokemon has taken root (Ingrain)', (bb) => { bb.act(0).v.ingrain = 1; }, 'x');
    none('when Fairy Lock holds the field', (bb) => { bb.s.fl = 2; }, 'x');
    { const q = mk(); q.b.act(1).ab = abId('Shadow Tag'); ko(q.b, 1); endTurn(q.b); add('engine/still offered when the fainted foe held Shadow Tag (a trapper that has fainted holds nobody)', q.b.s.fo === 0 && q.b.requests()[0].reason === 'free', J({ fo: q.b.s.fo })); }
    none('when nobody is left on the player\'s bench', (bb) => { bb.s.sides[0].team.forEach((m, i) => { if (i !== bb.s.sides[0].act) { m.hp = 0; m.fnt = 1; m.s = 0; } }); }, 'x');
    { const q = mk(); ko(q.b, 1); ko(q.b, 0); endTurn(q.b); add('engine/not offered when BOTH Pokemon fainted (each side just replaces its own, as in a double faint)', q.b.s.fo === undefined && J(q.b.s.need) === '[true,true]' && q.b.requests()[0].reason === 'faint' && q.b.requests()[1].reason === 'faint'); }
    { const q = mk({ n: 6, nB: 1 }); ko(q.b, 1); endTurn(q.b); add('engine/not offered when the foe has no replacement (its last Pokemon fainted: the battle simply ends)', q.b.s.fo === undefined && q.b.winner === 0 && q.b.s.phase === 'end'); }
    { const q = mk({ fs: [true, true] }); ko(q.b, 0); endTurn(q.b); add('engine/with the option on for both sides, the offer goes to the OTHER side of whoever fainted (side 0 KO\'d: side 1 is offered)', q.b.s.fo === 1 && q.b.requests()[1].reason === 'free' && q.b.requests()[0].reason === 'faint'); }

    // the new Pokemon faints on entry
    const ef = offered({ also: (bb) => { bb.s.sides[0].hz.sr = 1; bb.s.sides[0].team[3].hp = 1; } });
    ef.b.choose(0, { kind: 'switch', slot: 3 });
    const eev = ef.b.advance();
    const rqE = ef.b.requests();
    add('engine/YES into a Pokemon that faints on entry: the foe\'s replacement does NOT come in yet; the player must choose an ordinary replacement (reason faint) and the foe\'s choice is kept', eev.some((e) => e.t === 'faint' && e.s === 0) && !eev.some((e) => e.t === 'switch-in' && e.s === 1) && rqE[0].phase === 'switch' && rqE[0].reason === 'faint' && rqE[1].phase === 'wait' && ef.b.s.fo === undefined && J(ef.b.s.need) === '[true,true]', J({ rq: rqE.map((r) => r.phase + ':' + r.reason), need: ef.b.s.need }));
    const rep0 = rqE[0].switches[0].slot;
    ef.b.choose(0, { kind: 'switch', slot: rep0 });
    const eev2 = ef.b.advance();
    add('engine/... then both replacements come in together (the foe as it chose) and the battle is on its next turn', eev2.filter((e) => e.t === 'switch-in').length === 2 && ef.b.s.phase === 'move' && ef.b.s.turn === x.b.s.turn + 1 && ef.b.s.sides[1].act === ef.foe.slot, J(eev2.map((e) => e.t + ':' + e.s)));

    // forfeit during the offer
    const fo = offered();
    add('engine/a forfeit during the offer ends the battle (the other side wins), the offer is gone from the state and the snapshot still restores', (() => { fo.b.choose(0, { kind: 'forfeit' }); fo.b.advance(); if (!(fo.b.winner === 1 && fo.b.s.fo === undefined && fo.b.s.phase === 'end')) return J({ w: fo.b.winner, fo: fo.b.s.fo }); try { return E.restoreBattle(fo.b.snapshot(), { pack }).hash() === fo.b.hash(); } catch (e) { return String(e.code) + ' ' + e.message; } })());

    // snapshot / restore at the offer
    const sn = offered();
    const snap = sn.b.snapshot();
    let rs = null, rsErr = '';
    try { rs = E.restoreBattle(snap, { pack }); } catch (e) { rsErr = String(e && e.code) + ' ' + String(e && e.message); }
    add('engine/a snapshot taken during the offer restores to the same hash, the same offer (S.fo, fs) and the same requests', !!rs && rs.hash() === sn.b.hash() && rs.s.fo === 0 && J(rs.s.fs) === '[1,0]' && J(rs.requests()) === J(sn.b.requests()), rsErr);
    add('engine/viewFor() and previewDamage() work during the offer (the view model has no surprise)', (() => { try { sn.b.viewFor(0); sn.b.viewFor(1); return true; } catch (e) { return String(e.message); } })());
    if (rs) {
      rs.choose(0, { kind: 'switch', slot: 2 }); sn.b.choose(0, { kind: 'switch', slot: 2 }); rs.advance(); sn.b.advance();
      add('engine/... and the restored battle and the original agree after the same answer (hash and event log)', rs.hash() === sn.b.hash() && rs.logHash() === sn.b.logHash());
    }
    const forged = (f) => { const c = JSON.parse(JSON.stringify(snap)); delete c.hash; f(c.s); try { E.restoreBattle(c, { pack }); return 'accepted'; } catch (e) { return e.code; } };
    add('engine/forged snapshots are refused by the validator itself (its hash removed): fo without fs, fo on a side that is not offered, fo=2, fs [0,0], fs of one, fs [2,0]', forged((s) => { delete s.fs; }) === 'snapshot-invalid' && forged((s) => { s.fs = [0, 1]; }) === 'snapshot-invalid' && forged((s) => { s.fo = 2; }) === 'snapshot-invalid' && forged((s) => { s.fs = [0, 0]; delete s.fo; }) === 'snapshot-invalid' && forged((s) => { s.fs = [1]; }) === 'snapshot-invalid' && forged((s) => { s.fs = [2, 0]; }) === 'snapshot-invalid', J([forged((s) => { delete s.fs; }), forged((s) => { s.fs = [0, 1]; }), forged((s) => { s.fo = 2; }), forged((s) => { s.fs = [0, 0]; delete s.fo; }), forged((s) => { s.fs = [1]; }), forged((s) => { s.fs = [2, 0]; })]));
    add('engine/... and an offer in the wrong phase (fo while the phase is move) or with the foe not asked is refused too', forged((s) => { s.phase = 'move'; }) === 'snapshot-invalid' && forged((s) => { s.need = [true, false]; }) === 'snapshot-invalid', J([forged((s) => { s.phase = 'move'; }), forged((s) => { s.need = [true, false]; })]));

    // options
    const bad = (o) => { try { mk({ opts: o, fs: undefined }); return 'no error'; } catch (e) { return e && e.code ? e.code : String(e && e.message); } };
    add('engine/freeSwitch: true, false, null, undefined, [true,false] and [false,false] are accepted; "yes", 1, [true], [1,0], [true,false,true] and {} are refused by name (bad-argument)',
      ['no error'].concat([true, false, null, undefined, [true, false], [false, false]].map((v) => bad({ freeSwitch: v }))).every((r) => r === 'no error') && ['yes', 1, [true], [1, 0], [true, false, true], {}].every((v) => bad({ freeSwitch: v }) === 'bad-argument'),
      J([true, false, null, undefined, [true, false], [false, false]].map((v) => bad({ freeSwitch: v })).concat(['yes', 1, [true], [1, 0], {}].map((v) => bad({ freeSwitch: v })))));

    // nothing else changes: option off == a battle that never heard of it
    const plain = mk({ fs: undefined, opts: {} }).b, off1 = mk({ fs: false }).b, off2 = mk({ fs: [false, false] }).b, onB = mk({ fs: [true, false] }).b;
    add('engine/without the option (or with it false / [false,false]) the state has no fs key, and the hash, the events and the requests are those of a battle that never heard of it', !('fs' in plain.s) && !('fs' in off1.s) && !('fs' in off2.s) && 'fs' in onB.s && plain.hash() === off1.hash() && plain.hash() === off2.hash() && J(plain.events) === J(off1.events) && J(plain.requests()) === J(off2.requests()), J(Object.keys(onB.s).join()).slice(0, 80));
    const drive = (bb, step) => { for (let g = 0; g < 2000 && bb.winner === null; g++) { const rq = bb.requests(); for (let s = 0; s < 2; s++) { const r = rq[s]; if (r.phase === 'move') bb.choose(s, { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot }); else if (r.phase === 'switch') bb.choose(s, step(s, r)); } if (bb.ready()) bb.advance(); } return bb; };
    const pol = (s, r) => (r.reason === 'free' ? { kind: 'stay' } : { kind: 'switch', slot: r.switches[0].slot });
    const pa = drive(mk({ seed: 5, fs: undefined, opts: {} }).b, pol), pb = drive(mk({ seed: 5, fs: [false, false] }).b, pol);
    add('engine/... over a whole battle played the same way: the same final hash, log hash and turn count', pa.hash() === pb.hash() && pa.logHash() === pb.logHash() && pa.turn === pb.turn && pa.winner === pb.winner, J([pa.turn, pb.turn]));
    add('engine/the engine\'s own reason list: the free switch is a request reason of phase switch only, never a state reason (S.reason stays faint)', (() => { const q = offered(); return q.b.s.reason === 'faint' && q.b.requests()[0].reason === 'free'; })());

    // an organic offer (a real KO), its replay and its log
    let org = null;
    for (let seed = 1; seed <= 30 && !org; seed++) {
      const A = teamOf(seed * 7 + 1, 6), B = teamOf(seed * 7 + 2, 6);
      const o = { pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed, names: ['A', 'B'], freeSwitch: [true, false] };
      const bb = E.createBattle(o);
      for (let g = 0; g < 300 && bb.winner === null && bb.s.fo === undefined; g++) {
        const rq = bb.requests();
        for (let s = 0; s < 2; s++) { const r = rq[s]; if (r.phase === 'move') bb.choose(s, { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot }); else if (r.phase === 'switch') bb.choose(s, { kind: 'switch', slot: r.switches[0].slot }); }
        if (bb.ready()) bb.advance();
      }
      if (bb.s.fo !== undefined) org = { o, bb };
    }
    add('engine/a real KO offers the switch (an organic offer was found by playing)', !!org);
    if (org) {
      const stayB = E.restoreBattle(org.bb.snapshot(), { pack }), yesB = E.restoreBattle(org.bb.snapshot(), { pack });
      const finish = (bb) => drive(bb, pol);
      const st = bb2log(org, 'stay'), yy = bb2log(org, 'switch');
      function bb2log(g, kind) { const c = E.restoreBattle(g.bb.snapshot(), { pack }); const slot = c.requests()[0].switches[0].slot; c.choose(0, kind === 'stay' ? { kind: 'stay' } : { kind: 'switch', slot }); drive(c, pol); return c; }
      void stayB; void yesB; void finish;
      for (const [nm, bb] of [['stay', st], ['switch', yy]]) {
        let rp = null, rpErr = '';
        try { rp = E.replay({ ...org.o, choiceLog: bb.choiceLog }); } catch (e) { rpErr = String(e && e.code) + ' ' + String(e && e.message); }
        add('engine/replay of the choice log of a battle with a free switch (' + nm + ') reproduces the events and the hash', !!rp && rp.hash === bb.hash() && J(rp.events) === J(bb.events), rpErr);
      }
      add('engine/replay WITHOUT the option refuses that log (the answer comes where nothing is asked): the option is part of the battle', (() => { try { E.replay({ ...org.o, freeSwitch: undefined, choiceLog: st.choiceLog }); return 'accepted'; } catch (e) { return e.code === 'replay-rejected' ? true : String(e.code); } })());
      add('engine/... and with the option on for the OTHER side only', (() => { try { E.replay({ ...org.o, freeSwitch: [false, true], choiceLog: st.choiceLog }); return 'accepted'; } catch (e) { return e.code === 'replay-rejected' ? true : String(e.code); } })());
    }

    // the wire
    let wire = true;
    for (let v = 0; v < 65536; v++) { const c = E.decodeChoice(v); if (c !== null && E.encodeChoice(c) !== v) wire = false; }
    add('engine/wire: stay is the 16-bit word 7, decode(7) is stay, forfeit stays 3, and every 16-bit pattern is still canonical or refused (exhaustive)', E.encodeChoice({ kind: 'stay' }) === 7 && J(E.decodeChoice(7)) === '{"kind":"stay"}' && J(E.decodeChoice(3)) === '{"kind":"forfeit"}' && wire && E.decodeChoice(11) === null && E.decodeChoice(15) === null && E.decodeChoice(19) === null && E.CHOICE_KINDS.includes('stay'));
  });

  /* ---- B. CONTROLLER ---- */
  await blk('api', async () => {
    const build = (seed, sides, o = {}) => {
      const A = teamOf(seed * 1000 + 1, o.nA || 6), B = teamOf(seed * 1000 + 2, o.nB || 6);
      return MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, names: ['You', 'CPU'], ...(o.opts || {}), sides: sides || [{ kind: 'human' }, { kind: 'cpu', level: o.level || 'normal', seed: seed + 5 }] });
    };
    const H = { kind: 'human' }, C = (s) => ({ kind: 'cpu', level: 'normal', seed: s }), R = { kind: 'remote' };
    const fsOf = (sides) => build(3, sides, { opts: { freeSwitch: true } }).battle.s.fs;
    add('api/freeSwitch: true offers a human seat that faces a CPU and nobody else: [human, cpu] -> [1,0], [cpu, human] -> [0,1]', J(fsOf([H, C(1)])) === '[1,0]' && J(fsOf([C(1), H])) === '[0,1]', J([fsOf([H, C(1)]), fsOf([C(1), H])]));
    add('api/... a remote seat (an online battle), two humans, two CPUs: no offer at all (the state has no fs key)', [[H, R], [R, H], [H, H], [C(1), C(2)], [R, C(1)]].every((s) => fsOf(s) === undefined), J([[H, R], [R, H], [H, H], [C(1), C(2)]].map((s) => fsOf(s))));
    add('api/without the option nothing is offered; a value that is not a boolean is a RangeError', build(3).battle.s.fs === undefined && build(3, undefined, { opts: { freeSwitch: false } }).battle.s.fs === undefined && (() => { try { build(3, undefined, { opts: { freeSwitch: 'yes' } }); return false; } catch (e) { return e instanceof RangeError; } })());

    // a real offer through the controller
    const play = (seed, answer, o = {}) => {
      const c = build(seed, undefined, { opts: { freeSwitch: true, ...(o.opts || {}) } }); c.start();
      const offers = [];
      for (let g = 0; g < 600 && c.winner === null; g++) {
        const r = c.pending(0); if (!r) break;
        if (r.phase === 'switch' && r.reason === 'free') { offers.push({ req: r, turn: c.turn, log: c.battle.choiceLog.length, foeAct: c.battle.s.sides[1].act }); c.submit(0, answer(r, offers.length)); }
        else if (r.phase === 'move') c.submit(0, { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot });
        else if (r.phase === 'switch') c.submit(0, { kind: 'switch', slot: r.switches[0].slot });
        else if (r.phase === 'preview') c.submit(0, { kind: 'preview', order: [0] });
      }
      return { c, offers };
    };
    const yes = (r) => ({ kind: 'switch', slot: r.switches[0].slot }), no = () => ({ kind: 'stay' }), alt = (r, n) => (n % 2 ? yes(r) : no());
    const gy = play(2, yes);
    add('api/ctl.pending(0) is the free request { phase switch, reason free, switches, next } while the CPU has already answered (pending(1) is null)', gy.offers.length >= 1 && gy.offers[0].req.reason === 'free' && !!gy.offers[0].req.next, J(gy.offers[0] && gy.offers[0].req).slice(0, 120));
    // the CPU answered FIRST and its choice is what `next` names; the human's answer does not change it
    const sameSeed = (answer) => { const c = build(2, undefined, { opts: { freeSwitch: true } }); c.start(); for (let g = 0; g < 600; g++) { const r = c.pending(0); if (!r) break; if (r.reason === 'free') { const cpu = c.battle.choiceLog[c.battle.choiceLog.length - 1]; const next = r.next; c.submit(0, answer(r)); return { cpu, next, foeNow: c.battle.s.sides[1].team[c.battle.s.sides[1].act].orig, c }; } c.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : r.phase === 'preview' ? { kind: 'preview', order: [0] } : { kind: 'switch', slot: r.switches[0].slot }); } return null; };
    const s1 = sameSeed(yes), s2 = sameSeed(no);
    add('api/the CPU\'s replacement is chosen BEFORE the offer (the last logged choice is its own, side 1) and is the one `next` names; YES or NO, the very same Pokemon comes in', !!s1 && !!s2 && s1.cpu.s === 1 && s1.cpu.c.kind === 'switch' && s1.next.slot === s1.cpu.c.slot && J(s1.cpu) === J(s2.cpu) && s1.foeNow === s2.foeNow, J([s1 && s1.cpu, s2 && s2.cpu]));
    add('api/the answer is announced once as the local choice: stay as the wire word 7, a switch as its own word', (() => { const c = build(2, undefined, { opts: { freeSwitch: true } }); c.start(); const got = []; c.onLocalChoice((e) => got.push(e)); for (let g = 0; g < 600; g++) { const r = c.pending(0); if (!r) break; if (r.reason === 'free') { got.length = 0; c.submit(0, { kind: 'stay' }); break; } c.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : r.phase === 'preview' ? { kind: 'preview', order: [0] } : { kind: 'switch', slot: r.switches[0].slot }); } return got.length === 1 && got[0].wire === 7 && got[0].side === 0 && J(got[0].choice) === '{"kind":"stay"}'; })());
    add('api/a refused answer is refused by the controller too: nothing is announced and the offer stays open', (() => { const c = build(2, undefined, { opts: { freeSwitch: true } }); c.start(); for (let g = 0; g < 600; g++) { const r = c.pending(0); if (!r) return false; if (r.reason === 'free') { const got = []; c.onLocalChoice((e) => got.push(e)); const x1 = c.submit(0, { kind: 'switch', slot: c.battle.s.sides[0].act }); const x2 = c.submit(0, { kind: 'move', slot: 0 }); return !x1.ok && x1.code === 'active' && !x2.ok && got.length === 0 && c.pending(0) && c.pending(0).reason === 'free'; } c.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : r.phase === 'preview' ? { kind: 'preview', order: [0] } : { kind: 'switch', slot: r.switches[0].slot }); } return false; })());

    // whole battles under three answer policies
    let fin = 0, finWhy = '', offersTotal = 0, turnOk = true, turnWhy = '', rpOk = true, rpWhy = '', det = true;
    for (const [nm, ans] of [['always YES', yes], ['always NO', no], ['alternating', alt]]) for (let s = 1; s <= Math.min(SEEDS, 14); s++) {
      const g = play(s, ans);
      if (g.c.winner !== null) fin++; else finWhy = nm + ' seed ' + s;
      offersTotal += g.offers.length;
      const evs = g.c.battle.events, tn = evs.filter((e) => e.t === 'turn').map((e) => e.n);
      if (!tn.every((n, i) => n === i + 1) || tn[tn.length - 1] !== g.c.battle.turn) { turnOk = false; turnWhy = nm + ' seed ' + s + ' ' + J(tn.slice(-4)); }
      const A = teamOf(s * 1000 + 1, 6), B = teamOf(s * 1000 + 2, 6);
      let rp = null; try { rp = E.replay({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: s * 77, names: ['You', 'CPU'], freeSwitch: [true, false], choiceLog: g.c.battle.choiceLog }); } catch (e) { rpWhy = nm + ' seed ' + s + ' ' + String(e && e.code) + ' ' + String(e && e.message).slice(0, 60); }
      if (!rp || rp.hash !== g.c.battle.hash() || J(rp.events) !== J(evs)) { rpOk = false; rpWhy = rpWhy || nm + ' seed ' + s + ' differs'; }
      const g2 = play(s, ans); if (g2.c.battle.hash() !== g.c.battle.hash()) det = false;
    }
    add('api/whole battles under three answer policies (always YES, always NO, alternating) x ' + Math.min(SEEDS, 14) + ' seeds all finish, and offers were really made (' + offersTotal + ')', fin === 3 * Math.min(SEEDS, 14) && offersTotal >= 30, finWhy + ' fin ' + fin + ' offers ' + offersTotal);
    add('api/... the turn events are consecutive 1..N and N is the engine\'s turn (a free switch never opens, skips or repeats a turn)', turnOk, turnWhy);
    add('api/... every choice log (stays and switches included) replays to the same hash and the same events with freeSwitch [true,false]', rpOk, rpWhy);
    add('api/... the same seed and the same answers give the same battle (deterministic)', det);
    // a free switch uses no turn: the turn counter when the offer opens is the one the answer leaves behind until the next turn begins
    const t1 = play(2, yes);
    add('api/the answer does not advance the turn by itself: at the offer the turn is T, and right after YES it is T + 1 (the next turn began once, as it does after any faint)', t1.offers.length >= 1 && (() => { const c = build(2, undefined, { opts: { freeSwitch: true } }); c.start(); for (let g = 0; g < 600; g++) { const r = c.pending(0); if (!r) return false; if (r.reason === 'free') { const T = c.turn; c.submit(0, yes(r)); return c.turn === T + 1 || c.winner !== null; } c.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : r.phase === 'preview' ? { kind: 'preview', order: [0] } : { kind: 'switch', slot: r.switches[0].slot }); } return false; })());

    // online: nothing changes
    const codeA = await OM.randomTeamCode(pack, 301, 6), codeB = await OM.randomTeamCode(pack, 302, 6);
    const ja = await OM.judgeTeamCode(codeA.code || codeA, pack), jb = await OM.judgeTeamCode(codeB.code || codeB, pack);
    let onlineFree = 0, onlineOk = true;
    for (const fmt of ['3v3', '6v6']) for (let sd = 1; sd <= 4; sd++) {
      const host = OM.buildNetController({ pack, mySide: 0, seed: sd * 91, fmt, names: ['Ann', 'Bob'], mine: ja, theirs: jb });
      const guest = OM.buildNetController({ pack, mySide: 1, seed: sd * 91, fmt, names: ['Ann', 'Bob'], mine: jb, theirs: ja });
      if (host.battle.s.fs !== undefined || guest.battle.s.fs !== undefined) onlineOk = false;
      for (let g = 0; g < 900 && host.winner === null; g++) {
        let any = false;
        for (const [me, you, side] of [[host, guest, 0], [guest, host, 1]]) {
          const r = me.pending(side);
          if (!r) continue;
          if (r.reason === 'free') onlineFree++;
          const ch = r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : r.phase === 'switch' ? { kind: 'switch', slot: r.switches[0].slot } : { kind: 'preview', order: fmt === '3v3' ? [0, 1, 2] : [0] };
          me.submit(side, ch); you.submitRemote(ch); any = true;
        }
        if (!any) break;
      }
      if (host.winner === null || host.battle.hash() !== guest.battle.hash()) onlineOk = false;
    }
    add('api/ONLINE is unchanged: buildNetController has no fs in its state on either machine, no request is ever a free offer over 8 played matches (3v3 and 6v6), and both machines agree on the final hash', onlineOk && onlineFree === 0, J({ onlineOk, onlineFree }));
    const chk = (r) => { try { return AI.createAi({ pack, level: 'hard', seed: 3 }).choose(r, {}, {}); } catch (e) { return 'threw'; } };
    add('api/ai.js answers a free offer with stay (a CPU standing in for a person says NO) and draws nothing from its generator', J(chk({ phase: 'switch', reason: 'free', switches: [{ slot: 1 }] })) === '{"kind":"stay"}' && (() => { try { const a = AI.createAi({ pack, level: 'normal', seed: 3 }), b = AI.createAi({ pack, level: 'normal', seed: 3 }); a.choose({ phase: 'switch', reason: 'free', switches: [{ slot: 1 }] }, {}, {}); return a.rng() === b.rng(); } catch (e) { return false; } })());
  });

  /* ---- C. STATS ---- */
  await blk('stats', async () => {
    let ok = true, why = '', withFree = 0, careerOk = true, sw = 0;
    for (let s = 1; s <= Math.min(SEEDS, 12); s++) {
      const A = teamOf(s * 1000 + 1, 6), B = teamOf(s * 1000 + 2, 6);
      const c = MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: s * 77, freeSwitch: true, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: s + 5 }] }); c.start();
      let n = 0;
      for (let g = 0; g < 600 && c.winner === null; g++) { const r = c.pending(0); if (!r) break; if (r.reason === 'free') { n++; c.submit(0, n % 2 ? { kind: 'switch', slot: r.switches[0].slot } : { kind: 'stay' }); } else c.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot } : { kind: 'switch', slot: r.switches[0].slot }); }
      if (n) withFree++;
      const evs = c.battle.events, teams = [0, 1].map((sd) => c.battle.s.sides[sd].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
      const sum = MS.summarizeMatch(evs, { viewSide: 0, teams });
      if (sum.turns !== c.battle.turn) { ok = false; why = 'seed ' + s + ' summary turns ' + sum.turns + ' vs engine ' + c.battle.turn; }
      const outs = evs.filter((e) => e.t === 'switch-out' && e.s === 0).length;
      if (sum.sides[0].switches !== outs) { ok = false; why = 'seed ' + s + ' switches ' + sum.sides[0].switches + ' vs switch-out events ' + outs; }
      sw += outs;
      const turnsOnField = sum.sides[0].mons.reduce((a, m) => a + m.turns, 0);
      if (turnsOnField > evs.filter((e) => e.t === 'turn').length) { ok = false; why = 'seed ' + s + ' turns on the field ' + turnsOnField; }
      const m = CS.matchFromSummary(sum, { id: 'x' + s, at: 1, fmt: '6v6', cpu: 'normal', ruleset: 'arena-gen3-standard', playMs: 1000 });
      if (m.turns !== c.battle.turn || m.me.switches !== sum.sides[0].switches) careerOk = false;
    }
    add('stats/for ' + Math.min(SEEDS, 12) + ' battles with free switches (' + withFree + ' had at least one): summary.turns is the engine turn, the switch counts as a switch (side switches = switch-out events), turns on the field never exceed the turn events', ok && withFree >= 5, why + ' withFree ' + withFree);
    add('stats/... and the career\'s match (turns, switches) says the same, so the fastest-win / longest-battle logic reads engine turns, as before', careerOk && sw >= 5, 'switches ' + sw);
  });

  /* ---- D. SCENE ---- */
  const mkScene = (o = {}) => {
    const seed = o.seed || 2;
    const A = teamOf(seed * 1000 + 1, o.n || 6), B = teamOf(seed * 1000 + 2, 6);
    const mySide = o.side || 0;
    const sides = mySide === 0 ? [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: seed + 5 }] : [{ kind: 'cpu', level: 'normal', seed: seed + 5 }, { kind: 'human' }];
    const teams = mySide === 0 ? [A.recs, B.recs] : [B.recs, A.recs];
    const ctl = MC.createMatchController({ pack, teams, seed: seed * 77, ...(o.opts || {}), ...(o.fs === false ? {} : { freeSwitch: true }), names: mySide === 0 ? ['You', 'CPU Normal'] : ['CPU Normal', 'You'], sides });
    ctl.start();
    let styleVal = o.style || 'switch';
    const style = o.noStyle ? undefined : { get: () => ({ style: styleVal }), set: (p) => { if (p && (p.style === 'set' || p.style === 'switch')) styleVal = p.style; return { style: styleVal }; }, val: () => styleVal };
    const scene = SC.createScene({ ui, pack, text, ctl, viewSide: mySide, env: 0, textSpeed: 'fast', meta: mySide === 0 ? [A.meta, B.meta] : [B.meta, A.meta], trainer: 'CPU Normal', playerName: 'You', quitLabel: 'BACK TO HUB', style, resultGuard: 0, anim: o.anim, animator: o.animator, hooks: o.hooks || {} });
    scene.begin(); for (let i = 0; i < 4000 && scene.mode === 'steps'; i++) scene.tick();
    return { scene, ctl, A, B, style, texts: [] };
  };
  const press = (sc, ...keys) => { for (const k of keys) { sc.press(k); sc.tick(); } };
  // play the human's seat until `until(x)` holds; the free question stops it (the caller answers). Collects every typed message in x.texts.
  const drive = (x, until, max = 80000) => {
    const sc = x.scene;
    for (let n = 0; n < max; n++) {
      const cur = sc.S.cur; if (cur && cur.t === 'text' && x.texts[x.texts.length - 1] !== cur.text) x.texts.push(cur.text);
      if (cur && cur.question && cur.tw && cur.tw.done && !cur.tw.waiting) x.qTicks = (x.qTicks || 0) + 1;       // frames a finished question waits before its YES / NO box opens
      if (until(x)) return true;
      const m = sc.mode;
      if (m === 'result') return false;
      if (m === 'steps' || m === 'wait') { sc.tick(); const c2 = sc.S.cur; if (c2 && c2.t === 'text' && !(c2.question && c2.tw.done && !c2.tw.waiting)) sc.press('a'); continue; }       // (A is not pressed once the question is typed: A would skip the hold this test measures)
      if (m === 'preview') { const p = sc.S.preview; for (let i = 0; i < p.mine.length && sc.mode === 'preview' && p.picks.length < p.pick; i++) sc.choose.preview(i); continue; }
      if (m === 'action') { sc.choose.action(0); continue; }
      if (m === 'moves') { const i = (sc.S.req.moves || []).findIndex((q) => !q.disabled); sc.choose.move(Math.max(0, i)); continue; }
      if (m === 'party') { sc.press('a'); continue; }
      if (m === 'confirm') { if (sc.S.confirm.kind === 'free') return false; sc.press('a'); continue; }
      sc.tick();
    }
    return false;
  };
  const atPrompt = (x) => x.scene.mode === 'confirm' && !!x.scene.S.confirm && x.scene.S.confirm.kind === 'free';
  const reach = (o = {}) => { for (let seed = o.from || 2; seed < (o.from || 2) + 25; seed++) { const x = mkScene({ ...o, seed }); if (drive(x, atPrompt)) return x; } return null; };
  const settleTo = (x, modes = ['action', 'result']) => { for (let n = 0; n < 40000 && !modes.includes(x.scene.mode); n++) { x.scene.tick(); if (x.scene.S.cur && x.scene.S.cur.t === 'text') x.scene.press('a'); if (x.scene.mode === 'confirm' && x.scene.S.confirm.kind === 'free') break; } return x.scene.mode; };
  const lastHuman = (ctl) => ctl.battle.choiceLog.slice().reverse().find((e) => e.s === 0);
  const fill = (tpl, foeName, mon) => tpl.replace('{42}', foeName).replace('{1}', mon);
  await blk('scene', async () => {
    const x = reach();
    add('scene/a prompt arrives in a real battle (the foe fainted, it has another Pokemon, the player has a bench)', !!x);
    if (!x) return;
    const sc = x.scene, req = x.ctl.pending(0);
    // the text, from the ROM
    const romTpl = BT.decodeTemplate(rom, 0x441b80);
    add('scene/the ROM holds the line this prompt is built from (the string at 0x441b80, an independent decode of the ROM bytes) and the manifest points at it', romTpl === '{42} is about to send out {1}.\\pWill you switch your Pok\u00e9mon?' && manifest.strings['style.ask'].off === 0x441b80 && text.source('style.ask') === 'manifest', J([romTpl, manifest.strings['style.ask']]));
    const expect = fill(romTpl, 'CPU Normal', req.next.name);
    add('scene/the question typed is the ROM\'s own line with the trainer and the foe\'s next Pokemon filled in: "CPU Normal is about to send out <MON>.<page>Will you switch your Pokemon?"', x.texts.includes(expect), J({ expect, last: x.texts.slice(-2) }));
    add('scene/nothing in the prompt is invented: the scene lists no fallback for it (style.ask comes from the ROM; the YES / NO words are the scene\'s own as at every other YES / NO)', !sc.fallbacks().some((k) => /style|opt\./.test(k)), J(sc.fallbacks()));
    add('scene/the question names the foe\'s NEXT Pokemon as the controller holds it (the CPU\'s own choice), and that is the Pokemon that then comes in', (() => { const t = x.ctl.battle.s.sides[1].team[req.next.slot]; return req.next.name === t.name; })());
    // the box
    add('scene/the YES / NO box opens the moment the question has been typed (at most 3 frames after it is done, not after the 36-frame hold every message has)', (x.qTicks || 0) <= 3, J({ qTicks: x.qTicks }));
    add('scene/the YES / NO box is open over the second page: rows YES, NO, the cursor on YES (A answers YES), mode confirm, kind free', sc.mode === 'confirm' && J(sc.state().overlay) === '["YES","NO"]' && sc.S.confirm.cursor === 0 && sc.S.overlay.cursor === 0, J({ ov: sc.state().overlay, cur: sc.S.confirm && sc.S.confirm.cursor }));
    add('scene/the message box under it holds the ROM\'s second page, "Will you switch your Pokemon?", and nothing else', J(sc.view().box.text.filter(Boolean)) === J(['Will you switch your Pok\u00e9mon?']) && sc.view().box.mode === 'message', J(sc.view().box));
    add('scene/while it is open the engine has not moved on: the foe\'s fainted Pokemon is still its active one, the offer is open and the turn is unchanged', x.ctl.battle.s.fo === 0 && x.ctl.battle.s.sides[1].team[x.ctl.battle.s.sides[1].act].hp === 0 && x.ctl.pending(0).reason === 'free', J({ fo: x.ctl.battle.s.fo }));

    // YES -> party -> B -> back to the question
    const T0 = x.ctl.turn, logN = x.ctl.battle.choiceLog.length;
    press(sc, 'a');
    add('scene/A on YES opens the party screen with CANCEL available (not the forced screen of a fainted Pokemon), the cursor on the first living Pokemon that is not out', sc.mode === 'party' && sc.S.party.free === true && sc.view().party.canCancel === true && sc.S.party.mons[sc.S.party.cursor] && !sc.S.party.mons[sc.S.party.cursor].fainted && !sc.S.party.mons[sc.S.party.cursor].active, J({ m: sc.mode, free: sc.S.party && sc.S.party.free, c: sc.view().party && sc.view().party.canCancel }));
    add('scene/nothing has been sent yet: the party screen only asks (no new choice in the log, the turn unchanged)', x.ctl.battle.choiceLog.length === logN && x.ctl.turn === T0);
    press(sc, 'b');
    add('scene/B on the party screen is back at the question, with the very same text and the cursor on YES again', sc.mode === 'confirm' && sc.S.confirm.kind === 'free' && J(sc.view().box.text.filter(Boolean)) === J(['Will you switch your Pok\u00e9mon?']) && sc.S.confirm.cursor === 0, J({ m: sc.mode }));
    press(sc, 'a');
    sc.pointer({ kind: 'click', x: ui.GEOM.party.cancel.x + 4, y: ui.GEOM.party.cancel.y + 4 });
    add('scene/a tap on CANCEL goes back to the question too', sc.mode === 'confirm' && sc.S.confirm.kind === 'free', sc.mode);
    // a flash message at the party screen must not replace the question
    press(sc, 'a');
    const actMon = sc.S.party.mons.findIndex((m) => m.active);
    sc.S.party.cursor = actMon; press(sc, 'a');
    const flashed = sc.mode === 'steps';
    settleFlash(sc);
    add('scene/choosing the Pokemon that is already out says the ROM\'s line and stays at the party screen (nothing is sent)', flashed && sc.mode === 'party' && x.ctl.battle.choiceLog.length === logN, J({ flashed, m: sc.mode }));
    press(sc, 'b');
    add('scene/... and B afterwards still shows the QUESTION under the YES / NO, not the flash', sc.mode === 'confirm' && J(sc.view().box.text.filter(Boolean)) === J(['Will you switch your Pok\u00e9mon?']), J(sc.view().box.text));
    function settleFlash(s) { for (let n = 0; n < 4000 && s.mode === 'steps'; n++) { s.tick(); if (s.S.cur && s.S.cur.t === 'text') s.press('a'); } }

    // YES + a Pokemon
    press(sc, 'a', 'down');
    const pick = sc.S.party.cursor, pickSlot = sc.S.party.mons[pick].slot, pickName = sc.S.party.mons[pick].name;
    press(sc, 'a');
    const sentOk = x.ctl.battle.choiceLog.slice(logN).filter((e) => e.s === 0).length === 1 && J(x.ctl.battle.choiceLog[logN]) === J({ s: 0, c: { kind: 'switch', slot: pickSlot } });
    add('scene/A on a Pokemon sends { kind switch, slot } for exactly that one (one new choice from side 0)', sentOk, J(x.ctl.battle.choiceLog.slice(-3)));
    const evsAfter = x.ctl.battle.events;
    const so = idx(evsAfter, (e) => e.t === 'switch-out' && e.s === 0, evsAfter.findLastIndex((e) => e.t === 'faint' && e.s === 1)), si = idx(evsAfter, (e) => e.t === 'switch-in' && e.s === 0, so), sf = idx(evsAfter, (e) => e.t === 'switch-in' && e.s === 1, so);
    add('scene/the events are switch-out, switch-in (the picked Pokemon), THEN the foe\'s switch-in (the player changed first)', so >= 0 && si > so && sf > si && evsAfter[si].m === pickSlot, J({ so, si, sf }));
    settleTo(x);
    add('scene/the screen shows what the engine holds: the picked Pokemon is the player\'s, and the foe\'s replacement is the one it announced', sc.state().player && sc.state().player.name === pickName && x.ctl.battle.s.sides[0].team[x.ctl.battle.s.sides[0].act].name === pickName && sc.state().foe && sc.state().foe.name === req.next.name, J({ p: sc.state().player && sc.state().player.name, pickName, f: sc.state().foe && sc.state().foe.name, next: req.next.name }));
    add('scene/the free switch used no turn: at the next action menu the turn is exactly the old one plus one', sc.mode === 'action' && x.ctl.turn === T0 + 1, J({ T0, turn: x.ctl.turn, m: sc.mode }));
    add('scene/the question\'s state is gone (S.free null) so the next offer is asked again', sc.S.free === null);

    // NO
    const n = reach({ from: 5 });
    if (n) {
      const nsc = n.scene, nTurn = n.ctl.turn, nAct = n.ctl.battle.s.sides[0].act;
      press(nsc, 'down');
      add('scene/down moves the cursor to NO', nsc.S.confirm.cursor === 1 && nsc.S.overlay.cursor === 1);
      press(nsc, 'a');
      add('scene/A on NO sends { kind stay } and nothing else; the foe\'s Pokemon comes in; the player\'s Pokemon stays; the turn is old + 1', J(lastHuman(n.ctl)) === '{"s":0,"c":{"kind":"stay"}}' && settleTo(n) === 'action' && n.ctl.battle.s.sides[0].act === nAct && n.ctl.turn === nTurn + 1 && nsc.state().foe.name === n.ctl.battle.s.sides[1].team[n.ctl.battle.s.sides[1].act].name, J({ m: nsc.mode, turn: n.ctl.turn, nTurn }));
    } else add('scene/NO case needs a prompt', false);
    const b1 = reach({ from: 9 });
    if (b1) { press(b1.scene, 'b'); add('scene/B at the question is NO ({ kind stay }), as in the game', J(lastHuman(b1.ctl)) === '{"s":0,"c":{"kind":"stay"}}' && b1.scene.mode !== 'confirm', J(b1.ctl.battle.choiceLog.slice(-2))); } else add('scene/B case needs a prompt', false);

    // pointer
    const p1 = reach({ from: 12 });
    if (p1) {
      const find = (sc2, i) => { for (let yy = 0; yy < 160; yy += 2) for (let xx = 100; xx < 240; xx += 2) { const h = sc2.hit(xx, yy); if (h && h.kind === 'overlay' && h.index === i) return { x: xx, y: yy }; } return null; };
      const yes = find(p1.scene, 0), no = find(p1.scene, 1);
      add('scene/the YES and NO rows can be hit by a tap, and a tap beside the box is "back" (a tap goes back without the pad)', !!yes && !!no && p1.scene.hit(10, 10).kind === 'back', J({ yes, no, beside: p1.scene.hit(10, 10) }));
      if (yes) { p1.scene.pointer({ kind: 'click', x: yes.x, y: yes.y }); add('scene/a tap on YES opens the party screen', p1.scene.mode === 'party' && p1.scene.S.party.free === true, p1.scene.mode); }
      const rows = ui.rowRects(ui.GEOM.party, p1.scene.S.party ? p1.scene.S.party.mons.length : 0);
      if (p1.scene.S.party) { const k = p1.scene.S.party.mons.findIndex((m) => !m.fainted && !m.active); const slot = p1.scene.S.party.mons[k].slot; p1.scene.pointer({ kind: 'click', x: ui.GEOM.party.x + 20, y: rows[k].y + 6 }); add('scene/a tap on a Pokemon\'s row sends the switch for that Pokemon', J(lastHuman(p1.ctl)) === J({ s: 0, c: { kind: 'switch', slot } }), J(p1.ctl.battle.choiceLog.slice(-2))); }
    }
    const p2 = reach({ from: 15 });
    if (p2) {
      const find = (sc2, i) => { for (let yy = 0; yy < 160; yy += 2) for (let xx = 100; xx < 240; xx += 2) { const h = sc2.hit(xx, yy); if (h && h.kind === 'overlay' && h.index === i) return { x: xx, y: yy }; } return null; };
      const no = find(p2.scene, 1);
      if (no) p2.scene.pointer({ kind: 'click', x: no.x, y: no.y });
      add('scene/a tap on NO answers stay', J(lastHuman(p2.ctl)) === '{"s":0,"c":{"kind":"stay"}}', J(p2.ctl.battle.choiceLog.slice(-2)));
    }
    const p3 = reach({ from: 18 });
    if (p3) { p3.scene.pointer({ kind: 'click', x: 10, y: 10 }); add('scene/a tap beside the box (on the picture) is B: NO', J(lastHuman(p3.ctl)) === '{"s":0,"c":{"kind":"stay"}}', J(p3.ctl.battle.choiceLog.slice(-2))); }

    // pause menu and forfeit
    const pm = reach({ from: 21 });
    if (pm) {
      press(pm.scene, 'start');
      add('scene/Start at the question does nothing (as at every YES / NO): the question stays open', pm.scene.mode === 'confirm' && pm.scene.S.confirm.kind === 'free');
      press(pm.scene, 'a'); press(pm.scene, 'start');
      const rows2 = pm.scene.S.menu ? pm.scene.S.menu.rows.slice() : [];
      add('scene/Start at the free party screen opens the pause menu with FORFEIT, and RESUME comes back to the party screen', pm.scene.mode === 'menu' && rows2.includes('FORFEIT') && (() => { press(pm.scene, 'a'); return pm.scene.mode === 'party' && pm.scene.S.party.free; })(), J(rows2));
      press(pm.scene, 'start'); press(pm.scene, ...Array(pm.scene.S.menu.rows.indexOf('FORFEIT')).fill('down'), 'a');
      add('scene/FORFEIT from there asks YES / NO first; NO comes back to the party screen', pm.scene.mode === 'confirm' && pm.scene.S.confirm.kind === 'forfeit' && (() => { press(pm.scene, 'a'); return pm.scene.mode === 'party' && pm.scene.S.party.free === true && pm.ctl.winner === null; })(), pm.scene.mode);
    }

    // BATTLE STYLE: SET: no prompt, frame for frame the old battle
    const frames = (o) => {
      const seed = o.seed;
      const A = teamOf(seed * 1000 + 1, 6), B = teamOf(seed * 1000 + 2, 6);
      const ctl = MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, ...(o.fs ? { freeSwitch: true } : {}), names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: seed + 5 }] });
      const style = o.style ? { get: () => ({ style: o.style }), set() {} } : undefined;
      const scene = SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You', style });
      const ai = AI.createAi({ pack, level: 'normal', seed: seed ^ 0x5bd1e995 });
      scene.S.auto = { ai, decide(req) { return ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); } };
      ctl.start(); scene.begin();
      const h = crypto.createHash('sha1'); let nF = 0, prompts = 0;
      while (nF++ < 400000 && scene.mode !== 'result') { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); if (scene.mode === 'confirm') prompts++; h.update(ui.render(scene.view()).rgba); }
      return { digest: h.digest('hex'), frames: nF, prompts, ctl, ev: J(ctl.battle.events), stays: ctl.battle.choiceLog.filter((e) => e.c.kind === 'stay').length };
    };
    let sameAll = true, sameWhy = '', stays = 0;
    for (const seed of [1, 2, 3, 4, 6, 8]) { const a = frames({ seed, fs: false }), b = frames({ seed, fs: true, style: 'set' }); stays += b.stays; if (a.digest !== b.digest || a.frames !== b.frames || a.ev !== b.ev || b.prompts) { sameAll = false; sameWhy = 'seed ' + seed + ' frames ' + a.frames + '/' + b.frames + ' events ' + (a.ev === b.ev) + ' prompts ' + b.prompts; } }
    add('scene/BATTLE STYLE: SET is the old battle, FRAME FOR FRAME: 6 battles played with no free switch in the engine and with it offered and the scene answering NO give the same frame digest, frame count and event log (' + stays + ' stays answered), and no prompt ever opened', sameAll && stays >= 6, sameWhy + ' stays ' + stays);
    const setCtl = frames({ seed: 2, fs: true, style: 'set' });
    add('scene/... SET answers are ordinary recorded choices: one { kind stay } per offer in the log, from side 0', setCtl.ctl.battle.choiceLog.filter((e) => e.c.kind === 'stay').every((e) => e.s === 0) && setCtl.stays >= 1);
    const noOpt = reach({ fs: false });
    add('scene/a controller that does not offer (no freeSwitch) never asks: the scene is exactly what it was before the feature', noOpt === null);
    const on = frames({ seed: 2, fs: true, style: 'switch' });
    add('scene/BATTLE STYLE: SHIFT (the default, here with a style object) with the scene\'s auto player also answers (ai.js says NO) and plays the same battle events as SET', on.ev === setCtl.ev && on.stays === setCtl.stays, 'stays ' + on.stays + '/' + setCtl.stays);

    // the pause menu row, and flipping the style in the middle of a battle
    const mm = mkScene({ seed: 4, opts: { pick: 0 } });
    drive(mm, (q) => q.scene.mode === 'action');
    press(mm.scene, 'start');
    const rowsM = mm.scene.S.menu.rows;
    const styleRow = rowsM.findIndex((r) => /^BATTLE STYLE/.test(r));
    add('scene/the pause menu has a BATTLE STYLE row, in the ROM\'s words ("Battle Style: Shift"), after the animation rows and before FORFEIT', styleRow > 0 && rowsM[styleRow] === 'BATTLE STYLE: SHIFT' && rowsM.indexOf('FORFEIT') === styleRow + 1, J(rowsM));
    add('scene/... the three words come from the ROM (Battle Style, Shift, Set) and the menu still fits the screen (rows end above y 160, the longest label fits its box)', (() => { const o = mm.scene.S.overlay, g = ui.overlayRects(o); return g.win.y + g.win.h <= 160 && g.win.x + g.win.w <= 240 && rowsM.every((r) => ui.measure('normal', r) <= o.w - 12) || rowsM.every((r) => ui.measure('smallNarrow', r) <= o.w - 12); })() && text.compose('opt.style') === 'Battle Style' && text.compose('opt.shift') === 'Shift' && text.compose('opt.set') === 'Set' && ['opt.style', 'opt.shift', 'opt.set'].every((k) => text.source(k) === 'manifest'), J(mm.scene.S.overlay));
    press(mm.scene, ...Array(styleRow).fill('down'), 'a');
    add('scene/A on the row flips it: the label reads SET, the setting object says set, and the menu stays open on that row', mm.style.val() === 'set' && mm.scene.mode === 'menu' && mm.scene.S.menu.rows[styleRow] === 'BATTLE STYLE: SET' && mm.scene.S.menu.cursor === styleRow, J({ v: mm.style.val(), rows: mm.scene.S.menu.rows }));
    press(mm.scene, 'a');
    add('scene/... and again flips it back to SHIFT (the row toggles, it does not stick)', mm.style.val() === 'switch' && mm.scene.S.menu.rows[styleRow] === 'BATTLE STYLE: SHIFT');
    press(mm.scene, 'b');
    add('scene/a scene whose page gave no style object has no BATTLE STYLE row (an online battle: nothing to set)', (() => { const q = mkScene({ seed: 4, noStyle: true, opts: { pick: 0 } }); drive(q, (z) => z.scene.mode === 'action'); press(q.scene, 'start'); return !q.scene.S.menu.rows.some((r) => /STYLE/.test(r)); })());

    // flipping in the middle of a battle: the first offer is asked, then SET, then no more questions
    let flip = null;
    for (let seed = 2; seed < 40 && !flip; seed++) {
      const q = mkScene({ seed });
      if (!drive(q, atPrompt)) continue;
      press(q.scene, 'down', 'a');                               // NO to the first
      q.style.set({ style: 'set' });
      let asked = 0;
      for (let g = 0; g < 4; g++) { if (!drive(q, atPrompt)) break; asked++; press(q.scene, 'down', 'a'); }
      if (q.ctl.battle.choiceLog.filter((e) => e.c.kind === 'stay').length >= 3 || (asked === 0 && q.ctl.battle.choiceLog.filter((e) => e.c.kind === 'stay').length >= 2)) flip = { q, asked };
    }
    add('scene/flipping to SET in the middle of a battle takes effect at the very next offer: no question is asked again and the log still gets its stays (exact, replay-safe)', !!flip && flip.asked === 0, flip ? J({ asked: flip.asked }) : 'no battle with two offers found');
    add('scene/... and flipping back to SHIFT asks again at the next offer', (() => { for (let seed = 2; seed < 40; seed++) { const q = mkScene({ seed, style: 'set' }); drive(q, (z) => z.scene.mode === 'action' && z.ctl.battle.choiceLog.some((e) => e.c.kind === 'stay')); if (!q.ctl.battle.choiceLog.some((e) => e.c.kind === 'stay')) continue; q.style.set({ style: 'switch' }); if (drive(q, atPrompt)) return true; } return false; })());

    // 6v6 and 3v3: the prompt comes after the preview
    const lead6 = reach({ opts: { ...MC.formatOpts('6v6') } });
    add('scene/6v6 (with the lead preview first) asks too', !!lead6);
    const t3 = reach({ opts: { ...MC.formatOpts('3v3') } });
    add('scene/3v3 (team preview first) asks too, with a bench of the other living picks only', !!t3 && t3.scene.S.confirm.kind === 'free' && t3.ctl.pending(0).switches.length <= 2, t3 && J(t3.ctl.pending(0).switches.length));
    const g1 = reach({ side: 1 });
    add('scene/seated on side 1 (a guest-style seat) the question works the same', !!g1 && g1.scene.S.confirm.kind === 'free');

    // forfeit while the answer is pending works from the party screen
    const fq = reach({ from: 24 });
    if (fq) { press(fq.scene, 'a'); press(fq.scene, 'start'); press(fq.scene, ...Array(fq.scene.S.menu.rows.indexOf('FORFEIT')).fill('down'), 'a', 'up', 'a'); for (let n = 0; n < 6000 && fq.scene.mode !== 'result'; n++) { fq.scene.tick(); if (fq.scene.S.cur && fq.scene.S.cur.t === 'text') fq.scene.press('a'); } add('scene/YES to FORFEIT from the free party screen ends the battle with the player\'s forfeit', fq.ctl.winner === 1 && fq.ctl.battle.s.fo === undefined, J({ w: fq.ctl.winner, m: fq.scene.mode })); }
  });

  /* ---- E. RESUME ---- */
  await blk('resume', async () => {
    const mem = () => { const d = new Map(); return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k), d }; };
    const seed = 2, A = teamOf(seed * 1000 + 1, 6), B = teamOf(seed * 1000 + 2, 6);
    const makeCtl = (fs = true) => MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, ...(fs ? { freeSwitch: true } : {}), names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: seed + 5 }] });
    const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    const st = mem(); const store = RS.createResumeStore({ storage: st, key: 'k', seed });
    const ctl = makeCtl(); ctl.start(); store.attach(ctl);
    let offers = 0;
    for (let g = 0; g < 600 && ctl.winner === null && offers < 3; g++) { const r = ctl.pending(0); if (!r) break; if (r.reason === 'free') { offers++; ctl.submit(0, offers === 2 ? { kind: 'switch', slot: r.switches[0].slot } : { kind: 'stay' }); } else ctl.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((q) => !q.disabled).slot } : { kind: 'switch', slot: r.switches[0].slot }); }
    await flush();
    const rec = JSON.parse(st.getItem('k') || 'null');
    add('resume/the saved record holds the answers as ordinary choices (stay, switch, stay among the moves) and the state they led to', !!rec && offers === 3 && rec.choices.filter((c) => c.kind === 'stay').length === 2 && rec.choices.filter((c) => c.kind === 'switch').length >= 1, J(rec && rec.choices.map((c) => c.kind)));
    const fresh = makeCtl(); fresh.start();
    const r2 = RS.createResumeStore({ storage: st, key: 'k', seed }).restore({ ctl: fresh, makeCtl, navType: 'reload' });
    add('resume/a reload replays them into a fresh battle and lands on the same state (hash and turn), restored true', r2.info.restored === true && r2.ctl.battle.hash() === ctl.battle.hash() && r2.ctl.turn === ctl.turn, J(r2.info));
    add('resume/... the replayed controller is at the same point: the same request is pending (a move, or the next offer)', J(r2.ctl.pending(0)) === J(ctl.pending(0)));
    // into a controller that does not offer: the saved stay has nowhere to go
    const f3 = makeCtl(false); f3.start();
    const r3 = RS.createResumeStore({ storage: st, key: 'k', seed }).restore({ ctl: f3, makeCtl: () => makeCtl(false), navType: 'reload' });
    add('resume/a record with free-switch answers replayed into a battle that does not offer is refused cleanly (not restored, a reason naming the refused choice, a fresh started controller back)', r3.info.restored === false && /refused/.test(r3.info.reason) && r3.ctl !== f3 && r3.ctl.winner === null, J(r3.info));
    // a record from before: it has no answers where the new battle asks one. The old battle is played in lockstep with a twin that offers, up to the move after the KO that the twin asks about.
    const old = makeCtl(false), twin = makeCtl(true); old.start(); twin.start();
    const st2 = mem(), s2 = RS.createResumeStore({ storage: st2, key: 'k', seed }); s2.attach(old);
    const pick1 = (r) => (r.phase === 'move' ? { kind: 'move', slot: r.moves.find((q) => !q.disabled).slot } : { kind: 'switch', slot: r.switches[0].slot });
    let asked = false;
    for (let g = 0; g < 600 && old.winner === null; g++) {
      const rt = twin.pending(0), ro = old.pending(0); if (!rt || !ro) break;
      if (rt.reason === 'free') { asked = true; old.submit(0, pick1(ro)); break; }
      const ch = pick1(ro); old.submit(0, ch); twin.submit(0, ch);
    }
    await flush();
    const f4 = makeCtl(); f4.start();
    const r4 = RS.createResumeStore({ storage: st2, key: 'k', seed }).restore({ ctl: f4, makeCtl, navType: 'reload' });
    add('resume/a record saved before the feature (a KO and then the next move, no answer: the new battle asks there) cannot replay into a battle that offers: refused cleanly, and the page starts again', asked && r4.info.restored === false && /refused/.test(r4.info.reason) && r4.ctl.pending(0) && r4.ctl.pending(0).phase === 'move', J(r4.info));
  });

  /* ---- F. SETTINGS, GLUE, TEXT ---- */
  await blk('settings', async () => {
    const mem = (init) => { const d = new Map(init ? Object.entries(init) : []); return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k), d }; };
    add('settings/the key is arena.battlestyle and the words are switch (the default) and set', SS.STYLE_KEY === 'arena.battlestyle' && J(SS.STYLES) === '["switch","set"]' && SS.DEFAULT_STYLE === 'switch' && SS.createStyleSettings().get().style === 'switch');
    add('settings/a stored "set" is read; anything that is not exactly one of the two words (junk, JSON, another case, a trailing space, empty) is the default', SS.createStyleSettings({ storage: mem({ 'arena.battlestyle': 'set' }) }).get().style === 'set' && ['SET', 'Set', 'set ', '"set"', '{"style":"set"}', '', 'shift', 'x'.repeat(500), null].every((v) => SS.createStyleSettings({ storage: mem(v === null ? {} : { 'arena.battlestyle': v }) }).get().style === 'switch'));
    add('settings/set() persists the plain word, toggle() flips it, a wrong value is ignored, listeners are told, and a storage that throws neither breaks nor stops the setting', (() => { const m = mem(); const c = SS.createStyleSettings({ storage: m }); let told = 0; c.onChange(() => told++); c.set({ style: 'set' }); const a = m.getItem('arena.battlestyle') === 'set'; c.set({ style: 'bogus' }); const b = c.get().style === 'set'; c.toggle(); const d = c.get().style === 'switch' && m.getItem('arena.battlestyle') === 'switch'; const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } }; const e = SS.createStyleSettings({ storage: boom }); e.set({ style: 'set' }); return a && b && d && told === 3 && e.get().style === 'set'; })());
    add('settings/?style=set overrides the stored value for this visit only (it is not written back); ?style=switch too; a bad ?style= is a query error and the stored value stands', (() => { const m = mem({ 'arena.battlestyle': 'switch' }); const c = SS.createStyleSettings({ storage: m, search: '?style=set' }); const bad = SS.createStyleSettings({ storage: mem({ 'arena.battlestyle': 'set' }), search: '?style=SET' }); return c.get().style === 'set' && m.getItem('arena.battlestyle') === 'switch' && SS.createStyleSettings({ storage: mem({ 'arena.battlestyle': 'set' }), search: '?style=switch' }).get().style === 'switch' && J(bad.queryErrors) === '["style"]' && bad.get().style === 'set' && J(SS.parseStyleQuery('?style=x').errors) === '["style"]' && SS.parseStyleQuery('?a=1').errors.length === 0; })());
    const okQ = (q) => BB.parseBattleQuery(q);
    add('settings/the battle address takes ?style=switch|set; another value is refused by name and never echoed', okQ('?style=set').ok && okQ('?style=switch').ok && (() => { const r = okQ('?style=<b>evil</b>'); return !r.ok && r.error.param === 'style' && !JSON.stringify(r.error).includes('evil'); })() && !okQ('?style=SET').ok && okQ('').ok, J(okQ('?style=x').error));
    // the ROM's own option
    add('settings/the ROM has this very option: the Options row "Battle Style", its values "Shift" and "Set", and the help line saying what each does (read from the ROM bytes)', BT.decodeTemplate(rom, 0xf3ff84) === 'Battle Style' && BT.decodeTemplate(rom, 0x78b148) === 'Shift' && BT.decodeTemplate(rom, 0x78b154) === 'Set' && /^Shift offers a free switch when\nan opposing Pok\u00e9mon faints\. Set\nsends the next foe in without a\nfree switch\.$/.test(BT.decodeTemplate(rom, 0x78bca8)), J([BT.decodeTemplate(rom, 0xf3ff84), BT.decodeTemplate(rom, 0x78b148), BT.decodeTemplate(rom, 0x78b154)]));
    add('settings/the catalog finds them: the manifest offsets are the ones above, with their hashes, and the finder alone gives the same words', ['opt.style', 'opt.shift', 'opt.set', 'style.ask'].every((k) => !!manifest.strings[k] && BT.loadBattleText(rom, null).source(k) === 'scan' && BT.loadBattleText(rom, null).compose(k, { foeName: 'X', b2: 'Y' }) === BT.loadBattleText(rom, manifest).compose(k, { foeName: 'X', b2: 'Y' })) && manifest.strings['opt.style'].off === 0xf3ff84 && manifest.strings['opt.shift'].off === 0x78b148 && manifest.strings['opt.set'].off === 0x78b154 && manifest.count === Object.keys(manifest.strings).length);
    // opensOnPreview
    const sizes = (fmtOpts, nA, nB) => { const c = MC.createMatchController({ pack, teams: [teamOf(61, nA).recs, teamOf(62, nB).recs], seed: 9, ...fmtOpts, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 1 }] }); c.start(); return MC.opensOnPreview(c); };
    add('settings/opensOnPreview: 3v3 yes, 6v6 with a lead to choose yes, a 6v6 team of ONE no (there is no preview for it), a foe team of one with six of mine yes, a battle with no preview option no', sizes(MC.formatOpts('3v3'), 6, 6) === true && sizes(MC.formatOpts('6v6'), 6, 6) === true && sizes(MC.formatOpts('6v6'), 1, 6) === false && sizes(MC.formatOpts('6v6'), 6, 1) === true && sizes({ pick: 0 }, 6, 6) === false, J([sizes(MC.formatOpts('3v3'), 6, 6), sizes(MC.formatOpts('6v6'), 6, 6), sizes(MC.formatOpts('6v6'), 1, 6), sizes(MC.formatOpts('6v6'), 6, 1), sizes({ pick: 0 }, 6, 6)]));
  });
  return out;
}

/* ===================================================================================================== mutants */
// [id, file, from, to, [the named check(s) that must fail]]
const MUTANTS = [
  ['G01 the engine offers to a side that is not asked for it (the option is ignored)', 'engine.js', "if (!S.fs[y] || !S.need[y ^ 1] || S.need[y]) continue;", "if (!S.need[y ^ 1] || S.need[y]) continue;", ['engine/not offered when the option is on for the OTHER side only']],
  ['G02 the offer goes to the side whose own Pokemon fainted instead of the side facing it', 'engine.js', "if (!S.fs[y] || !S.need[y ^ 1] || S.need[y]) continue;", "if (!S.fs[y] || S.need[y ^ 1] || !S.need[y]) continue;", ['engine/the offer opens the faint phase', 'engine/a stay in an ordinary replacement phase']],
  ['G04 a trapped Pokemon is offered the switch', 'engine.js', "if (!this.canSwitch(y) || this.switchOptions(y).length === 0) continue;", "if (this.switchOptions(y).length === 0) continue;", ['engine/not offered when the player\'s Pokemon is trapped']],
  ['G05 a side with nobody on its bench is offered the switch', 'engine.js', "if (!this.canSwitch(y) || this.switchOptions(y).length === 0) continue;", "if (!this.canSwitch(y)) continue;", ['engine/not offered when nobody is left on the player\'s bench']],
  ['G06 the offered side is not marked as needing to answer (the foe\'s replacement comes in at once)', 'engine.js', "S.fo = y; S.need[y] = true;", "S.fo = y;", ['engine/the offer opens the faint phase', 'engine/it is not ready until the offered side answers']],
  ['G07 the request does not say reason free', 'engine.js', "out.push({ side, phase: 'switch', reason: 'free', switches:", "out.push({ side, phase: 'switch', reason: S.reason, switches:", ['engine/the offered side\'s request is']],
  ['G08 the request does not name the foe\'s replacement', 'engine.js', "next: pick ? { slot: pick.slot, sp: pick.sp, name: pick.name, level: pick.level } : null,", "next: null,", ['engine/... `next` names the foe\'s replacement']],
  ['G09 a stay is accepted from anybody, any time', 'engine.js', "if (S.fo !== side) return { ok: false, code: 'wrong-phase' };\n      sd.ch = { kind: 'stay' };", "if (false) return { ok: false, code: 'wrong-phase' };\n      sd.ch = { kind: 'stay' };", ['engine/a stay from the side that is NOT offered', 'engine/a stay in an ordinary replacement phase']],
  ['G10 a stay is not logged as a choice', 'engine.js', "      sd.ch = { kind: 'stay' };\n      this.choiceLog.push({ s: side, c: { kind: 'stay' } });", "      sd.ch = { kind: 'stay' };", ['engine/NO ({ kind stay }) is accepted, logged once']],
  ['G11 the free switch is made but the Pokemon does not come in (the answer is thrown away)', 'engine.js', "      if (ch && ch.kind === 'switch') {\n        this.doSwitch(fo, ch.slot, {});", "      if (ch && ch.kind === 'switch' && false) {\n        this.doSwitch(fo, ch.slot, {});", ['engine/YES ({ kind switch, slot }) brings that Pokemon in']],
  ['G12 the free switch is made AFTER the foe\'s replacement (entries deferred: the foe comes in first)', 'engine.js', "        this.doSwitch(fo, ch.slot, {});\n        this.checkWinner();\n        if (S.phase === 'end') return;", "        this.doSwitch(fo, ch.slot, { defer: true }); S.sides[fo].ch = { kind: 'switch', slot: ch.slot }; S.need[fo] = true; return;", ['engine/YES ({ kind switch, slot }) brings that Pokemon in']],
  ['G13 the entry effects of the new Pokemon are skipped (no hazards, no abilities)', 'engine.js', "        this.doSwitch(fo, ch.slot, {});\n        this.checkWinner();", "        this.doSwitch(fo, ch.slot, { defer: true });\n        this.checkWinner();", ['engine/YES: the new Pokemon takes Stealth Rock and Spikes', 'engine/YES: the new Pokemon\'s entry ability runs']],
  ['G14 the free switch uses up a turn (the next turn is started before the foe\'s replacement is sent)', 'engine.js', "        if (this.act(fo).hp <= 0 && this.aliveCount(fo) > 0) { S.need[fo] = true; return; }\n      }\n    }", "        if (this.act(fo).hp <= 0 && this.aliveCount(fo) > 0) { S.need[fo] = true; return; }\n      }\n      S.turn += 1;\n    }", ['engine/YES ({ kind switch, slot }) brings that Pokemon in', 'engine/NO ({ kind stay })', 'engine/... it uses no move']],
  ['G15 a Pokemon that faints on entry is not noticed (the foe comes in over a dead active)', 'engine.js', "        if (this.act(fo).hp <= 0 && this.aliveCount(fo) > 0) { S.need[fo] = true; return; }", "", ['engine/YES into a Pokemon that faints on entry']],
  ['G17 a switch to the Pokemon that is already out is accepted during the offer', 'engine.js', "if (slot === sd.act) return { ok: false, code: 'active' };", "if (false) return { ok: false, code: 'active' };", ['engine/refused by name during the offer']],
  ['G18 the offer stays in the state after a forfeit', 'engine.js', "    delete S.fo;                       // a free-switch offer that was open when the battle ended (a forfeit) goes with it\n", "", ['engine/a forfeit during the offer ends the battle']],
  ['G19 replay forgets the option', 'engine.js', "lead: o.lead, freeSwitch: o.freeSwitch, names: o.names", "lead: o.lead, names: o.names", ['engine/replay of the choice log of a battle with a free switch']],
  ['G20 a forged offer in a snapshot is accepted', 'engine_validate.js', "if (!S.fs || S.fs[S.fo] !== 1) fail('s.fo', 'a free-switch offer to a side that is not offered it');", "", ['engine/forged snapshots are refused by the validator itself']],
  ['G21 the snapshot validator does not check the phase of an open offer', 'engine_validate.js', "if (S.phase !== 'switch' || S.reason !== 'faint' || S.need[S.fo] !== true || S.need[S.fo ^ 1] !== true) fail('s.fo',", "if (false) fail('s.fo',", ['engine/... and an offer in the wrong phase']],
  ['G22 stay has no wire word', 'engine.js', "  if (c.kind === 'stay') return 7;\n", "", ['engine/wire: stay is the 16-bit word 7']],
  ['G23 stay decodes from any pattern of kind 3', 'engine.js', "v === 3 ? { kind: 'forfeit' } : v === 7 ? { kind: 'stay' } : null;", "v === 3 ? { kind: 'forfeit' } : { kind: 'stay' };", ['engine/wire: stay is the 16-bit word 7']],
  ['G24 the engine offers when the option is false too (S.fs is set for [false,false])', 'engine.js', "    if (!fs[0] && !fs[1]) fs = null;               // nobody is offered anything: the battle is exactly the one without the option\n", "", ['engine/without the option (or with it false']],
  ['G25 a bad freeSwitch value is accepted', 'engine.js', "else throw new EngineError('freeSwitch must be true, false or [boolean, boolean]', null, 'bad-argument');", "else fs = null;", ['engine/freeSwitch: true, false, null']],
  ['G26 the controller offers to a remote seat (an online battle would be asked)', 'matchctl.js', "sidesSpec[side].kind === 'human' && sidesSpec[side ^ 1].kind === 'cpu'", "sidesSpec[side].kind !== 'cpu'", ['api/... a remote seat (an online battle), two humans, two CPUs: no offer at all']],
  ['G27 the controller does not pass the option on', 'matchctl.js', "pick: opts.pick || 0, lead: opts.lead, freeSwitch, names,", "pick: opts.pick || 0, lead: opts.lead, names,", ['api/freeSwitch: true offers a human seat']],
  ['G28 the controller turns the option on for every battle', 'matchctl.js', "const freeSwitch = opts.freeSwitch === true ? [0, 1].map(", "const freeSwitch = true ? [0, 1].map(", ['api/without the option nothing is offered']],
  ['G30 the AI answers a free offer with a switch', 'ai.js', "if (request.phase === 'switch' && request.reason === 'free') return { kind: 'stay' };", "", ['api/ai.js answers a free offer with stay']],
  ['G31 the scene never asks (the offer is answered NO without a word, whatever the setting)', 'scene.js', "    if (S.free) return;                                                      // the question is on its way or on screen\n    if (autoStay()) return;", "    if (S.free) return;\n    submit({ kind: 'stay' }); return;", ['scene/a prompt arrives in a real battle']],
  ['G32 SET is not honoured (the question is asked anyway)', 'scene.js', "if (!cfg || cfg.style !== 'set') return false;", "return false;", ['scene/BATTLE STYLE: SET is the old battle, FRAME FOR FRAME']],
  ['G33 SET answers only at idle, after the events are read (the replacement arrives in a second batch)', 'scene.js', "    S.overlay = null; S.mode = 'steps'; S.party = null; S.preview = null; S.free = null;\n    autoStay();", "    S.overlay = null; S.mode = 'steps'; S.party = null; S.preview = null; S.free = null;", ['scene/BATTLE STYLE: SET is the old battle, FRAME FOR FRAME']],
  ['G53 the question holds for 36 frames like any message before its YES / NO box opens', 'scene.js', "else if (st.question || ++st.hold >= MSG_HOLD ||", "else if (++st.hold >= MSG_HOLD ||", ['scene/the YES / NO box opens the moment the question has been typed']],
  ['G34 the cursor starts on NO', 'scene.js', "S.confirm = { kind: 'free', cursor: 0, back: 'steps' };\n    S.overlay = { rows: ['YES', 'NO'], cursor: 0, w: 48, x: 176 };", "S.confirm = { kind: 'free', cursor: 1, back: 'steps' };\n    S.overlay = { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 176 };", ['scene/the YES / NO box is open over the second page']],
  ['G35 NO does not answer (the offer stays open and the scene waits for ever)', 'scene.js', "else if (c.kind === 'free') { if (yes) openFreeParty(); else submit({ kind: 'stay' }); }", "else if (c.kind === 'free') { if (yes) openFreeParty(); }", ['scene/A on NO sends { kind stay }']],
  ['G36 B on the free party screen leaves for the action menu instead of the question', 'scene.js', "if (free) openFreeConfirm(); else S.mode = 'action';", "S.mode = 'action';", ['scene/B on the party screen is back at the question']],
  ['G37 the party screen is the forced one (no CANCEL: the player cannot go back)', 'scene.js', "enterParty(req, false); S.party.free = true;", "enterParty(req, true); S.party.free = true;", ['scene/A on YES opens the party screen with CANCEL available']],
  ['G38 the question is invented English instead of the ROM line', 'scene.js', "qText(msg('style.ask', roles(foeSide, { b2: req.next && req.next.name ? req.next.name : '?' })), { question: true });", "qText('Do you want to change Pokemon?', { question: true });", ['scene/the question typed is the ROM\'s own line']],
  ['G39 the question names the wrong Pokemon (the foe\'s fainted one, not its next)', 'scene.js', "{ b2: req.next && req.next.name ? req.next.name : '?' }", "{ b2: S.P[foeSide].name }", ['scene/the question typed is the ROM\'s own line']],
  ['G40 the question box is lost behind the YES / NO (the last typed page is not kept)', 'scene.js', "if (!S.free.box) S.free.box = S.lastBox;", "S.free.box = { mode: 'message', text: ['', ''], arrow: false };", ['scene/the message box under it holds the ROM']],
  ['G41 a flash at the party screen replaces the question on the way back', 'scene.js', "return S.free && S.free.box ? S.free.box : S.lastBox;", "return S.lastBox;", ['scene/... and B afterwards still shows the QUESTION']],
  ['G42 the answer does not clear the question (the next offer is never asked)', 'scene.js', "S.overlay = null; S.mode = 'steps'; S.party = null; S.preview = null; S.free = null;\n    autoStay();", "S.overlay = null; S.mode = 'steps'; S.party = null; S.preview = null;\n    autoStay();", ['scene/the question\'s state is gone']],
  ['G43 the pause menu has no BATTLE STYLE row', 'scene.js', "    if (bs) rows.push(styleLabel(bs));", "", ['scene/the pause menu has a BATTLE STYLE row']],
  ['G44 the row does not flip the setting', 'scene.js', "if (c) opts.style.set({ style: c.style === 'set' ? 'switch' : 'set' });", "", ['scene/A on the row flips it']],
  ['G45 the row shows invented words instead of the ROM\'s', 'scene.js', "(msg('opt.style') || 'Battle Style').toUpperCase() + ': ' + (msg(c.style === 'set' ? 'opt.set' : 'opt.shift')", "'BATTLE STYLE' + ': ' + (c.style === 'set' ? 'OFF' : 'ON') + (msg(c.style === 'set' ? 'opt.set' : 'opt.shift') && ''", ['scene/the pause menu has a BATTLE STYLE row']],
  ['G46 an offer is asked while the question is already open (a second question is queued every tick)', 'scene.js', "    if (S.free) return;                                                      // the question is on its way or on screen", "", ['scene/the question\'s state is gone', 'scene/B on the party screen is back at the question']],
  ['G47 the style setting accepts any stored text', 'style_settings.js', "return typeof raw === 'string' && STYLES.includes(raw) ? raw : DEFAULT_STYLE;", "return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_STYLE;", ['settings/a stored "set" is read']],
  ['G48 a bad ?style= is not an error', 'style_settings.js', "if (v === 'switch' || v === 'set') out.style = v; else out.errors.push('style');", "if (v === 'switch' || v === 'set') out.style = v;", ['settings/?style=set overrides the stored value']],
  ['G49 ?style= is written back to the storage', 'style_settings.js', "const cur = { style: q.style !== undefined ? q.style : stored };", "const cur = { style: q.style !== undefined ? q.style : stored }; if (storage && q.style !== undefined) { try { storage.setItem(STYLE_KEY, cur.style); } catch (_e) { /* */ } }", ['settings/?style=set overrides the stored value']],
  ['G50 the battle address does not know ?style=', 'battle_boot.js', "  if (parseStyleQuery(search).errors.includes('style')) return bad('style', 'That battle style cannot be used', 'The battle style must be switch or set.');\n", "", ['settings/the battle address takes ?style=switch|set']],
  ['G51 the sound hint still thinks a 6v6 battle has no preview', 'matchctl.js', "return !!st && (st.lead ? me >= 0 && st.sizes[me] > 1 : !!st.pick);", "return !!st && !!st.pick;", ['settings/opensOnPreview']],
  ['G52 text: the Shift word is taken from the wrong string', 'battle_text.js', "'opt.shift': { s: '<FC 01 06><FC 03 07>Shift', region: [0x78b100, 0x78b200] },", "'opt.shift': { s: '<FC 01 06><FC 03 07>Set', region: [0x78b100, 0x78b200] },", ['settings/the catalog finds them']],
];

/* ===================================================================================================== run */
function copyJs(dest) { fs.mkdirSync(dest, { recursive: true }); for (const n of fs.readdirSync(JS)) { const s = path.join(JS, n); if (fs.statSync(s).isFile() && (n.endsWith('.js') || n.endsWith('.json'))) fs.copyFileSync(s, path.join(dest, n)); } return dest; }

head('A-F. the real modules');
const real = await loadFrom(JS);
const t0 = Date.now();
const res = await suite(real);
for (const [name, ok] of res) report(name, ok);
console.log(`  ${res.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

if (WANT_MUTANTS) {
  head('G. mutants (a temp copy of pokemonarena/js each)');
  const only = (process.env.ARENA_MUTANTS || '').split(',').filter(Boolean);
  const run = async (file, from, to) => {
    const dir = copyJs(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-switch-')));
    try {
      if (file) { const p = path.join(dir, file); const s = fs.readFileSync(p, 'utf8'); const n = s.split(from).length - 1; if (n !== 1) throw new Error('mutation target found ' + n + 'x in ' + file + ': ' + from.slice(0, 80)); fs.writeFileSync(p, s.replace(from, () => to)); }
      const M = await loadFrom(dir);
      return (await suite(M)).filter(([, ok]) => ok !== true).map(([n]) => n);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  };
  const twin = await run(null);
  report('mutants: the unmutated copy through the same loader passes every check', twin.length === 0, twin.slice(0, 3).join(' | '));
  let caught = 0, ran = 0;
  for (const [id, file, from, to, expect] of MUTANTS) {
    if (only.length && !only.some((o) => id.startsWith(o))) continue;
    ran++;
    let fails;
    try { fails = await run(file, from, to); } catch (e) { report(id + ' loads', false, e.message); continue; }
    const named = expect.some((x) => fails.some((f) => f.startsWith(x.slice(0, 70))));
    if (named) caught++;
    report(id + ' -> caught by a NAMED check', named, 'failed: ' + (fails.join(' | ').slice(0, 300) || 'none'));
  }
  console.log(`  mutants ${caught}/${ran}`);
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }
