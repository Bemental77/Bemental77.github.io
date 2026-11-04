#!/usr/bin/env node
// POKEMONARENA LEAD PREVIEW TEST -- "in a 6v6 battle you choose which Pokemon is sent out first".
//
// What the feature is: `lead: true` (matchctl FORMATS['6v6']) opens a preview in which each side chooses ONE Pokemon, { kind: 'preview', order: [slot] }; that Pokemon is sent out first and the
// rest of the team follows in team order. A side with one Pokemon is not asked. The CPU picks its own lead with ai.js (a preview of pick 1). The 3v3 preview (`pick: 3`) is untouched.
//
//   A  ENGINE     the state, the request, the choice, the order the battle uses, teams of 1..6, refusals, snapshot / restore / replay, the 16-bit wire word, and that a battle with no `lead`
//                 keeps its state, its start event and its hash (the engine goldens are pokemonarena_engine_test.mjs's; this checks the same thing on a direct pair).
//   B  CONTROLLER matchctl: FORMATS, formatOpts, the lead through ctl.pending / ctl.submit (what the Tower calls), the CPU's lead (ai.js, deterministic, chosen before and without the human's),
//                 whole battles of every team size from both seats.
//   C  SCENE      the real scene on the real engine: the preview, the ROM line, the numbered order, the YES / NO, NO, B, the pause menu, mouse / touch hits, a guest seat, small teams,
//                 the 3v3 preview exactly as it was, and that the question fits the title row.
//   D  RESUME     battle_resume.js: the lead choice is part of the replayed history (a reload lands on the same state); a record saved before the lead preview existed is refused cleanly.
//   E  PAGE GLUE  battle_boot.js resolveBattle (spec.lead) and online_match.js buildNetController (the online controller asks for the lead too).
//   F  MUTANTS    one-snippet defects of engine.js / engine_validate.js / matchctl.js / scene.js / online_match.js (a temp copy of pokemonarena/js each); each must fail a NAMED check.
//
//   node tools/pokemonarena_lead_test.mjs [--mutants]        ARENA_ROM, ARENA_SEEDS (default 40)
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const SEEDS = Math.max(8, Number(process.env.ARENA_SEEDS || 40));
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
  const [T, E, MC, AI, SC, BU, BT, RS, BB, OM] = await Promise.all([u('tables.js'), u('engine.js'), u('matchctl.js'), u('ai.js'), u('scene.js'), u('battle_ui.js'), u('battle_text.js'), u('battle_resume.js'), u('battle_boot.js'), u('online_match.js')]);
  const pack = T.loadPack(rom, { verify: 'header', dexText: false });
  return { T, E, MC, AI, SC, RS, BB, OM, pack, ui: BU.createBattleUi(rom), text: BT.loadBattleText(rom, manifest) };
};

/* ===================================================================================================== the suite, over any module tree */
async function suite(M) {
  const out = [];
  const add = (name, result) => out.push([name, result]);
  const blk = async (name, fn) => { try { await fn(); } catch (e) { add('crash/' + name, 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } };
  const { E, MC, AI, SC, RS, BB, OM, pack, ui, text } = M;
  const teamOf = (seed, n) => MC.randomTeam(pack, seed, n);
  const origs = (b, side) => b.s.sides[side].team.map((m) => m.orig);
  const mkBattle = (nA, nB, o = {}) => {
    const A = teamOf(100 + (o.seed || 1), nA), B = teamOf(200 + (o.seed || 1), nB);
    const b = E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: o.seed || 1, names: ['A', 'B'], ...(o.opts || { lead: true }) });
    return { b, A, B };
  };
  const rest = (n, lead) => [lead].concat(Array.from({ length: n }, (_, i) => i).filter((i) => i !== lead));

  /* ---- A. ENGINE ---- */
  await blk('engine', async () => {
    const { b, A, B } = mkBattle(6, 6);
    const rq = b.requests();
    add('engine/a lead battle opens in the preview phase, both sides asked, state lead 1 pick 1', b.s.phase === 'preview' && b.s.lead === 1 && b.s.pick === 1 && J(b.s.need) === '[true,true]', J({ phase: b.s.phase, lead: b.s.lead, pick: b.s.pick, need: b.s.need }));
    add('engine/the request says phase preview, pick 1, lead true and lists the whole team', rq.every((r, i) => r.phase === 'preview' && r.pick === 1 && r.lead === true && r.team.length === 6 && r.team.every((m, k) => m.slot === k)), J(rq[0]).slice(0, 200));
    const st = b.events.find((e) => e.t === 'start');
    add('engine/the start event carries lead 1', !!st && st.lead === 1 && st.pick === 1, J(st));
    // every lead, both sides: the chosen one first, the rest in team order, all six fight
    let allOk = true, why = '';
    for (let lead = 0; lead < 6 && allOk; lead++) {
      const x = mkBattle(6, 6, { seed: 3 });
      const l2 = (lead + 2) % 6;
      const r0 = x.b.choose(0, { kind: 'preview', order: [lead] }), r1 = x.b.choose(1, { kind: 'preview', order: [l2] });
      const ev = x.b.advance();
      const p0 = ev.find((e) => e.t === 'preview' && e.s === 0), p1 = ev.find((e) => e.t === 'preview' && e.s === 1);
      const sw = [0, 1].map((s) => ev.find((e) => e.t === 'switch-in' && e.s === s));
      if (!(r0.ok && r1.ok && J(origs(x.b, 0)) === J(rest(6, lead)) && J(origs(x.b, 1)) === J(rest(6, l2)) && p0 && J(p0.order) === J(rest(6, lead)) && p1 && J(p1.order) === J(rest(6, l2))
        && sw[0] && sw[0].sp === x.A.recs[lead].species && sw[1] && sw[1].sp === x.B.recs[l2].species)) { allOk = false; why = 'lead ' + lead + ' ' + J(origs(x.b, 0)) + ' ' + J(origs(x.b, 1)) + ' ' + J(sw.map((e) => e && e.sp)); }
    }
    add('engine/each of the six leads is sent out first and the whole team fights (the preview event holds the full order)', allOk, why);
    // the rest keep team order, not some other order
    const y = mkBattle(6, 6, { seed: 4 }); y.b.choose(0, { kind: 'preview', order: [4] }); y.b.choose(1, { kind: 'preview', order: [0] }); y.b.advance();
    add('engine/the rest keep TEAM order behind the lead (4 leads: 4 0 1 2 3 5; 0 leads: 0 1 2 3 4 5)', J(origs(y.b, 0)) === '[4,0,1,2,3,5]' && J(origs(y.b, 1)) === '[0,1,2,3,4,5]', J([origs(y.b, 0), origs(y.b, 1)]));
    add('engine/after the preview the slots follow the new order (slot = position) and the battle is on turn 1 asking for moves', y.b.s.sides[0].team.every((m, i) => m.slot === i) && y.b.s.phase === 'move' && y.b.turn === 1 && y.b.requests().every((r) => r.phase === 'move'), J({ phase: y.b.s.phase, turn: y.b.turn }));

    // refusals
    const z = mkBattle(6, 6, { seed: 5 });
    const code = (c) => z.b.choose(0, c).code;
    add('engine/an order of two, of none, a slot outside the team, a negative, a fraction, a string and a move are refused by name',
      code({ kind: 'preview', order: [0, 1] }) === 'bad-order' && code({ kind: 'preview', order: [] }) === 'bad-order' && code({ kind: 'preview', order: [6] }) === 'bad-order' && code({ kind: 'preview', order: [-1] }) === 'bad-order'
      && code({ kind: 'preview', order: [1.5] }) === 'bad-order' && code({ kind: 'preview', order: ['1'] }) === 'bad-order' && code({ kind: 'move', slot: 0 }) === 'wrong-phase' && code({ kind: 'switch', slot: 1 }) === 'wrong-phase',
      J([code({ kind: 'preview', order: [0, 1] }), code({ kind: 'preview', order: [6] }), code({ kind: 'move', slot: 0 })]));
    const ok1 = z.b.choose(0, { kind: 'preview', order: [2] });
    add('engine/a lead is final: a second choice from the same side is refused (already-chosen) and the other side is still asked', ok1.ok && z.b.choose(0, { kind: 'preview', order: [3] }).code === 'already-chosen' && z.b.requests()[0].phase === 'wait' && z.b.requests()[1].phase === 'preview' && !z.b.ready());
    add('engine/the lead is in the choice log, one entry of one slot', J(z.b.choiceLog) === J([{ s: 0, c: { kind: 'preview', order: [2] } }]), J(z.b.choiceLog));
    add('engine/a side may forfeit during the lead preview', (() => { const w = mkBattle(6, 6, { seed: 6 }); return w.b.choose(1, { kind: 'forfeit' }).ok && (w.b.choose(0, { kind: 'preview', order: [1] }), w.b.advance(), w.b.winner === 0); })());

    // team sizes
    let sizesOk = true, sizesWhy = '';
    for (const [na, nb] of [[2, 6], [6, 3], [4, 5], [2, 2], [6, 2]]) {
      const x = mkBattle(na, nb, { seed: 7 });
      const rq2 = x.b.requests();
      const la = na - 1, lb = Math.floor(nb / 2);
      const r0 = x.b.choose(0, { kind: 'preview', order: [la] }), r1 = x.b.choose(1, { kind: 'preview', order: [lb] });
      x.b.advance();
      if (!(rq2[0].team.length === na && rq2[1].team.length === nb && r0.ok && r1.ok && J(origs(x.b, 0)) === J(rest(na, la)) && J(origs(x.b, 1)) === J(rest(nb, lb)) && x.b.s.phase === 'move')) { sizesOk = false; sizesWhy = na + 'v' + nb + ' ' + J(origs(x.b, 0)) + ' ' + J(origs(x.b, 1)); }
    }
    add('engine/teams of 2..6 on either side (and different sizes) choose a lead among exactly their own members', sizesOk, sizesWhy);
    add('engine/a lead beyond a smaller team is refused (slot 4 of a 3-Pokemon team)', (() => { const x = mkBattle(6, 3, { seed: 8 }); return x.b.choose(1, { kind: 'preview', order: [4] }).code === 'bad-order' && x.b.choose(1, { kind: 'preview', order: [2] }).ok; })());
    const one = mkBattle(1, 6, { seed: 9 });
    const rq1 = one.b.requests();
    add('engine/a team of ONE is not asked: its request is wait, only the other side must choose', rq1[0].phase === 'wait' && rq1[1].phase === 'preview' && J(one.b.s.need) === '[false,true]' && !one.b.ready() && one.b.choose(0, { kind: 'preview', order: [0] }).ok === false, J({ rq: rq1.map((r) => r.phase), need: one.b.s.need }));
    one.b.choose(1, { kind: 'preview', order: [3] }); one.b.advance();
    add('engine/... and once the other side has chosen the battle starts with the one Pokemon leading', one.b.s.phase === 'move' && J(origs(one.b, 0)) === '[0]' && J(origs(one.b, 1)) === J(rest(6, 3)), J([origs(one.b, 0), origs(one.b, 1)]));
    const two1 = mkBattle(1, 1, { seed: 10 });
    add('engine/two teams of one need no preview at all: the battle is already on turn 1 (events: start, preview x2, switch-ins)', two1.b.s.phase === 'move' && two1.b.turn === 1 && two1.b.events.filter((e) => e.t === 'preview').length === 2 && two1.b.requests().every((r) => r.phase === 'move'), J({ phase: two1.b.s.phase, turn: two1.b.turn }));
    add('engine/a one-Pokemon side can still forfeit during the other side\'s lead preview', (() => { const x = mkBattle(1, 6, { seed: 11 }); return x.b.choose(0, { kind: 'forfeit' }).ok && (x.b.choose(1, { kind: 'preview', order: [0] }), x.b.advance(), x.b.winner === 1); })());

    // options
    const bad = (o) => { try { E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: 1, names: ['A', 'B'], ...o }); return 'no error'; } catch (e) { return e && e.code ? e.code : String(e && e.message); } };
    add('engine/lead and pick together are refused by name (bad-argument), and so is a lead that is not a boolean', bad({ lead: true, pick: 3 }) === 'bad-argument' && bad({ lead: 'yes' }) === 'bad-argument' && bad({ lead: 1 }) === 'bad-argument' && bad({ lead: false, pick: 3 }) === 'no error' && bad({ lead: undefined }) === 'no error', J([bad({ lead: true, pick: 3 }), bad({ lead: 'yes' }), bad({ lead: false, pick: 3 })]));

    // nothing else changes
    const plain = E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: 1, names: ['A', 'B'] });
    const p3 = E.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: 1, names: ['A', 'B'], pick: 3 });
    add('engine/a battle with no lead has no lead key in its state or its start event, and no lead field in a request (so its hash and digest are what they were)',
      !('lead' in plain.s) && !('lead' in p3.s) && !('lead' in plain.events.find((e) => e.t === 'start')) && !('lead' in p3.events.find((e) => e.t === 'start')) && !('lead' in p3.requests()[0]) && plain.s.phase === 'move' && p3.s.phase === 'preview' && p3.requests()[0].pick === 3,
      J({ plain: Object.keys(plain.s).join(), p3: Object.keys(p3.s).join() }));
    add('engine/the 3v3 preview still takes exactly three and keeps the picked order (pick 3 order [4,1,2])', (() => { p3.choose(0, { kind: 'preview', order: [4, 1, 2] }); p3.choose(1, { kind: 'preview', order: [0, 1, 2] }); p3.advance(); return J(origs(p3, 0)) === '[4,1,2]' && p3.s.sides[0].team.length === 3; })());

    // snapshot / restore / replay
    const s1 = mkBattle(6, 5, { seed: 12 });
    const snap0 = s1.b.snapshot();
    let restored0 = null, rerr = '';
    try { restored0 = E.restoreBattle(snap0, { pack }); } catch (e) { rerr = String(e && e.message); }
    add('engine/a snapshot taken at the lead preview restores (the lead flag is part of the checked state) and is the same battle', !!restored0 && restored0.hash() === s1.b.hash() && restored0.requests()[0].lead === true, rerr);
    s1.b.choose(0, { kind: 'preview', order: [3] }); s1.b.choose(1, { kind: 'preview', order: [1] }); s1.b.advance();
    for (let k = 0; k < 6 && s1.b.winner === null; k++) { const rq3 = s1.b.requests(); for (let s = 0; s < 2; s++) if (rq3[s].phase === 'move') s1.b.choose(s, { kind: 'move', slot: rq3[s].moves.find((m) => !m.disabled).slot }); else if (rq3[s].phase === 'switch') s1.b.choose(s, { kind: 'switch', slot: rq3[s].switches[0].slot }); if (s1.b.ready()) s1.b.advance(); }
    const snap1 = s1.b.snapshot();
    let restored1 = null; try { restored1 = E.restoreBattle(snap1, { pack }); } catch (e) { rerr = String(e && e.message); }
    add('engine/a snapshot taken after some turns restores to the same hash', !!restored1 && restored1.hash() === s1.b.hash(), rerr);
    let rp = null, rpErr = '';
    try { rp = E.replay({ pack, ruleset: 'arena-gen3-standard', teams: [s1.A.recs, s1.B.recs], seed: 12, lead: true, names: ['A', 'B'], choiceLog: s1.b.choiceLog }); } catch (e) { rpErr = String(e && e.code) + ' ' + String(e && e.message); }
    add('engine/replay of the choice log with lead true reproduces the battle (hash and event log)', !!rp && rp.hash === s1.b.hash() && J(rp.events) === J(s1.b.events), rp ? rp.hash + ' vs ' + s1.b.hash() : rpErr);
    add('engine/replay WITHOUT lead refuses the same log (the first choice is a preview in a battle with none): the option is part of the battle', (() => { try { E.replay({ pack, ruleset: 'arena-gen3-standard', teams: [s1.A.recs, s1.B.recs], seed: 12, names: ['A', 'B'], choiceLog: s1.b.choiceLog }); return 'accepted'; } catch (e) { return e.code === 'replay-rejected' ? true : String(e.code); } })());
    const forged = (f) => { const sn = JSON.parse(JSON.stringify(snap0)); delete sn.hash; f(sn.s); try { E.restoreBattle(sn, { pack }); return 'accepted'; } catch (e) { return e.code; } };
    add('engine/a snapshot that says lead 2, lead with pick 3, or lead 0 is refused as snapshot-invalid by the validator itself (its state hash removed, so the rule is what refuses it)', forged((s) => { s.lead = 2; }) === 'snapshot-invalid' && forged((s) => { s.pick = 3; }) === 'snapshot-invalid' && forged((s) => { s.lead = 0; }) === 'snapshot-invalid', J([forged((s) => { s.lead = 2; }), forged((s) => { s.pick = 3; }), forged((s) => { s.lead = 0; })]));
    const di = mkBattle(6, 6, { seed: 13 }), dj = mkBattle(6, 6, { seed: 13 });
    di.b.choose(0, { kind: 'preview', order: [1] }); dj.b.choose(0, { kind: 'preview', order: [2] });
    for (const x of [di, dj]) { x.b.choose(1, { kind: 'preview', order: [0] }); x.b.advance(); }
    add('engine/the lead is part of the battle: two leads, two states', di.b.hash() !== dj.b.hash() && di.b.logHash() !== dj.b.logHash());
    // the wire
    let wireOk = true;
    for (let i = 0; i < 6; i++) { const w = E.encodeChoice({ kind: 'preview', order: [i] }); const d = E.decodeChoice(w); if (!(w >= 0 && w <= 0xffff && d && d.kind === 'preview' && J(d.order) === J([i]) && E.encodeChoice(d) === w)) wireOk = false; }
    add('engine/a lead is one 16-bit wire word and round-trips for slots 0..5 (the protocol needs no new message)', wireOk);
  });

  /* ---- B. CONTROLLER ---- */
  await blk('api', async () => {
    add('api/FORMATS: 6v6 is { pick 0, lead true }, 3v3 is { pick 3 } and has no lead', MC.FORMATS['6v6'].pick === 0 && MC.FORMATS['6v6'].lead === true && MC.FORMATS['3v3'].pick === 3 && !MC.FORMATS['3v3'].lead, J(MC.FORMATS));
    add('api/formatOpts gives the pair to spread into createMatchController, and refuses a format the Arena does not play', J(MC.formatOpts('6v6')) === '{"pick":0,"lead":true}' && J(MC.formatOpts('3v3')) === '{"pick":3,"lead":false}' && (() => { for (const f of ['9v9', '', undefined, null, 6, '__proto__', 'toString']) { try { MC.formatOpts(f); return false; } catch (e) { if (!(e instanceof RangeError)) return false; } } return true; })());
    const build = (seed, nA, nB, sides, o = {}) => {
      const A = teamOf(seed * 1000 + 1, nA), B = teamOf(seed * 1000 + 2, nB);
      return MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 77, ...(o.opts || MC.formatOpts('6v6')), names: ['You', 'CPU'], validate: o.validate, sides: sides || [{ kind: 'human' }, { kind: 'cpu', level: o.level || 'normal', seed: seed + 5 }] });
    };
    // the Tower's way: validate false, the options spread from the format, a human lead through ctl.submit
    const tw = build(5, 6, 6, undefined, { validate: false }); tw.start();
    const pn = tw.pending(0);
    add('api/ctl.pending(0) is the lead request { phase preview, pick 1, lead true, team } while the CPU has already answered (pending(1) is null)', !!pn && pn.phase === 'preview' && pn.pick === 1 && pn.lead === true && pn.team.length === 6 && tw.pending(1) === null && tw.needs(0) === true, J(pn).slice(0, 120));
    const sub = tw.submit(0, { kind: 'preview', order: [3] });
    add('api/ctl.submit(0, { kind: "preview", order: [3] }) starts the battle with the 4th Pokemon out (the human side, through the same controller the Tower uses)', sub.ok && tw.battle.s.phase === 'move' && J(origs(tw.battle, 0)) === '[3,0,1,2,4,5]' && tw.turn === 1, J({ sub, order: origs(tw.battle, 0) }));
    add('api/the controller announces the lead as the local choice (onLocalChoice: the wire word of a one-slot preview)', (() => { const c = build(6, 6, 6); c.start(); const got = []; c.onLocalChoice((ev) => got.push(ev)); c.submit(0, { kind: 'preview', order: [5] }); return got.length === 1 && got[0].side === 0 && got[0].wire === E.encodeChoice({ kind: 'preview', order: [5] }); })());
    add('api/a refused lead is refused by the controller too and nothing is announced or advanced', (() => { const c = build(7, 6, 6); c.start(); const got = []; c.onLocalChoice((ev) => got.push(ev)); const r = c.submit(0, { kind: 'preview', order: [9] }); return !r.ok && r.code === 'bad-order' && got.length === 0 && c.battle.s.phase === 'preview'; })());
    add('api/without lead (pick 0) there is no preview: the first Pokemon leads and the first request is a move (the battle the Arena played before)', (() => { const c = build(8, 6, 6, undefined, { opts: { pick: 0 } }); c.start(); const r = c.pending(0); return r && r.phase === 'move' && J(origs(c.battle, 0)) === '[0,1,2,3,4,5]'; })());
    add('api/lead and pick together throw from the controller (an EngineError)', (() => { try { build(9, 6, 6, undefined, { opts: { pick: 3, lead: true } }); return false; } catch (e) { return e && e.code === 'bad-argument'; } })());

    // the CPU's lead
    const leads = { easy: new Set(), normal: new Set(), hard: new Set() };
    let cpuOk = true, cpuWhy = '', firstIsCpu = true, indep = true;
    for (let s = 1; s <= SEEDS; s++) for (const level of ['easy', 'normal', 'hard']) {
      const c = build(s, 6, 6, undefined, { level }); c.start();
      const log = c.battle.choiceLog;
      const cpuLead = log.length === 1 && log[0].s === 1 ? log[0].c : null;
      if (!cpuLead || J(Object.keys(cpuLead)) !== '["kind","order"]' || cpuLead.kind !== 'preview' || cpuLead.order.length !== 1 || !(cpuLead.order[0] >= 0 && cpuLead.order[0] < 6)) { cpuOk = false; cpuWhy = level + ' seed ' + s + ' ' + J(log); continue; }
      leads[level].add(cpuLead.order[0]);
      if (log[0].s !== 1) firstIsCpu = false;
      // the CPU asked ai.js for a preview of pick 1 with the public foe roster: the same answer, computed by hand here
      const ai = AI.createAi({ pack, level, seed: s + 5 });
      const req = c.battle.requests()[1];
      const again = ai.choose({ ...req, phase: 'preview' }, c.battle.viewFor(1), { previewInfo: { foe: c.previewInfo[0] } });
      if (!again || J(again.order) !== J(cpuLead.order)) { indep = false; cpuWhy = 'ai ' + level + ' seed ' + s + ' ' + J(again) + ' vs ' + J(cpuLead); }
      // the same battle with the human choosing differently: the CPU's lead does not change (it answered before the human could be seen)
      c.submit(0, { kind: 'preview', order: [s % 6] });
      if (J(origs(c.battle, 1)) !== J(rest(6, cpuLead.order[0]))) { cpuOk = false; cpuWhy = 'order ' + J(origs(c.battle, 1)); }
    }
    add('api/the CPU answers its lead preview at once: one logged choice (side 1, one slot of its team) before the human has chosen, and its team order is lead + rest', cpuOk && firstIsCpu, cpuWhy);
    add('api/the CPU\'s lead is exactly what ai.js answers for a preview of pick 1 (same seed, same public information): the way it picks for 3v3', indep, cpuWhy);
    add('api/the CPU really picks: normal and hard use more than one lead over ' + SEEDS + ' battles (it does not just send slot 0)', leads.normal.size >= 3 && leads.hard.size >= 3 && leads.easy.size >= 3, J({ e: leads.easy.size, n: leads.normal.size, h: leads.hard.size }));
    add('api/the CPU\'s lead is deterministic: the same seeds give the same lead and the same battle', (() => { const a = build(11, 6, 6); const b = build(11, 6, 6); a.start(); b.start(); a.submit(0, { kind: 'preview', order: [2] }); b.submit(0, { kind: 'preview', order: [2] }); return J(a.battle.choiceLog) === J(b.battle.choiceLog) && a.battle.hash() === b.battle.hash(); })());

    // whole battles from both seats, every team size, and the replay of each
    let fin = 0, finWhy = '';
    for (const [na, nb] of [[1, 1], [1, 6], [2, 6], [6, 2], [3, 4], [6, 6], [5, 6]]) for (let s = 1; s <= 3; s++) {
      const A = teamOf(s * 31 + na, na), B = teamOf(s * 37 + nb, nb);
      const c = MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: s * 101, ...MC.formatOpts('6v6'), names: ['A', 'B'], sides: [{ kind: 'cpu', level: 'normal', seed: s }, { kind: 'cpu', level: 'hard', seed: s + 1 }] });
      c.start();
      let rp3 = null; try { rp3 = E.replay({ pack, ruleset: 'arena-gen3-standard', teams: [A.recs, B.recs], seed: s * 101, lead: true, names: ['A', 'B'], choiceLog: c.battle.choiceLog }); } catch (e) { finWhy = 'replay threw ' + String(e && e.code); }
      if (rp3 && c.winner !== null && rp3.hash === c.battle.hash() && c.battle.turn >= 1) fin++; else if (rp3) finWhy = na + 'v' + nb + ' seed ' + s + ' winner ' + c.winner + ' ' + rp3.hash + ' vs ' + c.battle.hash();
    }
    add('api/whole CPU-vs-CPU battles with a lead preview finish for teams of 1..6 (1v1, 1v6, 2v6, 6v2, 3v4, 6v6, 5v6 x 3 seeds), and a replay of each choice log (lead true) reproduces it hash for hash', fin === 21, finWhy + ' ' + fin);
  });

  /* ---- C. SCENE ---- */
  const mkScene = (nMine, fmt, o = {}) => {
    const seed = o.seed || 9;
    const A = teamOf(seed * 10 + 1, nMine), B = teamOf(seed * 10 + 2, o.nFoe || 6);
    const mySide = o.side || 0;
    const sides = mySide === 0 ? [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 3 }] : [{ kind: 'cpu', level: 'normal', seed: 3 }, { kind: 'human' }];
    const teams = mySide === 0 ? [A.recs, B.recs] : [B.recs, A.recs];
    const ctl = MC.createMatchController({ pack, teams, seed, ...MC.formatOpts(fmt), names: mySide === 0 ? ['You', 'CPU Normal'] : ['CPU Normal', 'You'], sides });
    ctl.start();
    const scene = SC.createScene({ ui, pack, text, ctl, viewSide: mySide, env: 0, textSpeed: 'fast', meta: mySide === 0 ? [A.meta, B.meta] : [B.meta, A.meta], trainer: 'CPU Normal', playerName: 'You', quitLabel: 'BACK TO HUB', hooks: o.hooks });
    scene.begin(); for (let i = 0; i < 4000 && scene.mode === 'steps'; i++) scene.tick();
    return { scene, ctl, A, B, side: mySide };
  };
  const press = (sc, ...keys) => { for (const k of keys) { sc.press(k); sc.tick(); } };
  const toAction = (sc, max = 30000) => { for (let n = 0; n < max && sc.mode !== 'action' && sc.mode !== 'result'; n++) { sc.tick(); if (sc.mode === 'steps') sc.press('a'); } return sc.mode; };
  const romTitle = text.compose('party.choose', {}).replace(/(\\p|\s)+$/, '').replace(/^\s+/, '');
  await blk('scene', async () => {
    const x = mkScene(6, '6v6');
    const v0 = x.scene.view();
    add('scene/a 6v6 battle starts in the team-preview mode with all six rows and the foe roster beside them', x.scene.mode === 'preview' && v0.screen === 'preview' && v0.preview.mine.length === 6 && v0.preview.foe.length === 6, x.scene.mode);
    add('scene/the title is the ROM\'s own line "Choose a Pokemon." (party.choose), not the 3v3 counter, and nothing is numbered yet', v0.preview.title === romTitle && /^Choose a Pok/.test(v0.preview.title) && text.source('party.choose') !== 'fallback' && J(v0.preview.picks) === '[]', J([v0.preview.title, romTitle, v0.preview.picks]));
    add('scene/nothing the ROM could have said is invented: only confirm.lead is a fallback (no preview.title), and only once a Pokemon is picked', J(x.scene.fallbacks()) === '[]', J(x.scene.fallbacks()));
    // the 4th Pokemon by the d-pad and A
    press(x.scene, 'down', 'down', 'down');
    add('scene/the cursor moves down three rows', x.scene.view().preview.cursor === 3, String(x.scene.view().preview.cursor));
    press(x.scene, 'a');
    const v1 = x.scene.view();
    add('scene/A on a row opens the YES / NO at once and picks that one (state picks [3])', x.scene.mode === 'confirm' && J(x.scene.state().overlay) === '["YES","NO"]' && J(x.scene.state().picks) === '[3]', J({ m: x.scene.mode, ov: x.scene.state().overlay, picks: x.scene.state().picks }));
    add('scene/the question is "Send out this one first?" and the whole team is numbered in the order the battle will use (the lead 1, the rest in team order)', v1.preview.title === 'Send out this one first?' && J(v1.preview.picks) === '[3,0,1,2,4,5]', J([v1.preview.title, v1.preview.picks]));
    add('scene/that question is listed as a fallback (the ROM has no line for it), the ROM title is not', J(x.scene.fallbacks()) === '["confirm.lead"]', J(x.scene.fallbacks()));
    press(x.scene, 'a');                                  // YES (the cursor starts on YES)
    add('scene/YES sends the choice: the controller holds a preview of [3] for this side and the battle has started', x.scene.mode === 'steps' && J(x.ctl.battle.choiceLog.filter((e) => e.s === 0).map((e) => e.c)) === J([{ kind: 'preview', order: [3] }]) && x.ctl.battle.s.phase === 'move', J({ m: x.scene.mode, log: x.ctl.battle.choiceLog }));
    toAction(x.scene);
    const act = x.ctl.battle.s.sides[0];
    add('scene/the Pokemon that is sent out is the 4th of the team (engine and screen agree: orig 3, its name on the player\'s box)', x.scene.mode === 'action' && act.team[act.act].orig === 3 && x.scene.state().player.name === act.team[act.act].name && act.team[act.act].name === (x.A.recs[3].nickname || pack.species[x.A.recs[3].species].name), J({ m: x.scene.mode, orig: act.team[act.act].orig, shown: x.scene.state().player && x.scene.state().player.name }));
    add('scene/the party screen after the preview lists the team in that order: the lead active, the others behind it in team order', (() => { press(x.scene, 'down', 'a'); const p = x.scene.S.party; const ok = !!p && p.mons[0].active && J(p.mons.map((m) => m.slot)) === '[0,1,2,3,4,5]' && p.mons[0].name === act.team[0].name; if (x.scene.S.party) press(x.scene, 'b'); return ok; })());

    // NO, and B
    const y = mkScene(6, '6v6', { seed: 10 });
    press(y.scene, 'down', 'down', 'a', 'down', 'a');              // pick the 3rd, move to NO, A
    add('scene/NO goes back to the preview with the pick cleared and sends nothing (the controller still asks the lead)', y.scene.mode === 'preview' && J(y.scene.state().picks) === '[]' && y.ctl.pending(0) && y.ctl.pending(0).phase === 'preview' && y.ctl.battle.choiceLog.filter((e) => e.s === 0).length === 0, J({ m: y.scene.mode, picks: y.scene.state().picks }));
    press(y.scene, 'up', 'up', 'a', 'b');                            // pick the 1st, B at the question
    add('scene/B at the question is NO as well', y.scene.mode === 'preview' && J(y.scene.state().picks) === '[]' && y.ctl.battle.choiceLog.filter((e) => e.s === 0).length === 0, J({ m: y.scene.mode }));
    press(y.scene, 'a', 'a');                                        // pick the 1st again, YES: a lead of slot 0 is allowed (the team order is then unchanged)
    toAction(y.scene);
    add('scene/the first Pokemon may be chosen too (team order unchanged) and then leads', J(origs(y.ctl.battle, 0)) === '[0,1,2,3,4,5]' && y.scene.mode === 'action');
    const bb = mkScene(6, '6v6', { seed: 11 }); press(bb.scene, 'b', 'b');
    add('scene/B on the preview with nothing picked does nothing', bb.scene.mode === 'preview' && J(bb.scene.state().picks) === '[]');
    // pause menu + forfeit at the lead preview
    const pm = mkScene(6, '6v6', { seed: 12 });
    press(pm.scene, 'start');
    const rows = pm.scene.S.menu ? pm.scene.S.menu.rows.slice() : [];
    add('scene/Start at the lead preview opens the pause menu with FORFEIT in it (as at the 3v3 preview)', pm.scene.mode === 'menu' && rows.includes('FORFEIT'), J(rows));
    press(pm.scene, ...Array(rows.indexOf('FORFEIT')).fill('down'), 'a');
    add('scene/FORFEIT asks YES / NO first', pm.scene.mode === 'confirm' && pm.scene.S.confirm && pm.scene.S.confirm.kind === 'forfeit' && J(pm.scene.state().overlay) === '["YES","NO"]');
    press(pm.scene, 'a');                                  // the forfeit question starts on NO
    add('scene/NO comes back to the lead preview (nothing chosen, nothing forfeited)', pm.scene.mode === 'preview' && pm.ctl.winner === null && pm.scene.view().preview.title === romTitle);

    // mouse / touch: the hit test finds the rows and the YES / NO
    const m = mkScene(6, '6v6', { seed: 13 });
    const G = ui.GEOM.preview.mine, rr = ui.rowRects(G, 6);
    const hits = rr.map((r) => m.scene.hit(G.x + 20, r.y + 6));
    add('scene/each of the six rows is hit by a tap (kind preview, index 0..5), and the foe column is not', hits.every((h, i) => h && h.kind === 'preview' && h.index === i) && !m.scene.hit(200, rr[2].y + 6), J(hits));
    m.scene.pointer({ kind: 'click', x: G.x + 20, y: rr[3].y + 6 });
    add('scene/a tap on the 4th row picks it and asks (YES / NO)', m.scene.mode === 'confirm' && J(m.scene.state().picks) === '[3]', m.scene.mode);
    let yes = null, no = null;
    for (let yy = 0; yy < 160 && !yes; yy += 2) for (let xx = 100; xx < 200; xx += 2) { const h = m.scene.hit(xx, yy); if (h && h.kind === 'overlay' && h.index === 0) { yes = { x: xx, y: yy }; break; } }
    for (let yy = 0; yy < 160 && !no; yy += 2) for (let xx = 100; xx < 200; xx += 2) { const h = m.scene.hit(xx, yy); if (h && h.kind === 'overlay' && h.index === 1) { no = { x: xx, y: yy }; break; } }
    add('scene/the YES and NO boxes can be hit by a tap', !!yes && !!no, J({ yes, no }));
    if (no) m.scene.pointer({ kind: 'click', x: no.x, y: no.y });
    add('scene/a tap on NO goes back to the preview with nothing chosen', m.scene.mode === 'preview' && J(m.scene.state().picks) === '[]' && m.ctl.battle.choiceLog.filter((e) => e.s === 0).length === 0, m.scene.mode);
    m.scene.pointer({ kind: 'click', x: G.x + 20, y: rr[5].y + 6 });
    if (yes) m.scene.pointer({ kind: 'click', x: yes.x, y: yes.y });
    toAction(m.scene);
    add('scene/a tap on the 6th row and on YES sends it out first', J(origs(m.ctl.battle, 0)) === '[5,0,1,2,3,4]' && m.scene.mode === 'action', J(origs(m.ctl.battle, 0)));

    // a guest seat (side 1), as an online guest sees it
    const g = mkScene(6, '6v6', { seed: 14, side: 1 });
    press(g.scene, 'down', 'down', 'a', 'a');
    toAction(g.scene);
    add('scene/seated on side 1 (an online guest) the lead preview works the same: the 3rd Pokemon leads', g.scene.mode === 'action' && J(origs(g.ctl.battle, 1)) === '[2,0,1,3,4,5]' && g.scene.state().player.name === g.ctl.battle.s.sides[1].team[0].name, J(origs(g.ctl.battle, 1)));

    // small teams
    const s2 = mkScene(2, '6v6', { seed: 15 });
    add('scene/a team of two shows two rows (the foe\'s six beside them) and chooses between them', s2.scene.mode === 'preview' && s2.scene.view().preview.mine.length === 2 && s2.scene.view().preview.foe.length === 6, s2.scene.mode);
    press(s2.scene, 'down', 'a', 'a'); toAction(s2.scene);
    add('scene/... the second leads and the first follows', J(origs(s2.ctl.battle, 0)) === '[1,0]' && s2.scene.mode === 'action', J(origs(s2.ctl.battle, 0)));
    const s1 = mkScene(1, '6v6', { seed: 16 });
    add('scene/a team of ONE has no lead to choose: no preview, the battle goes straight on (to the first menu)', s1.scene.mode !== 'preview' && toAction(s1.scene) === 'action' && J(origs(s1.ctl.battle, 0)) === '[0]', s1.scene.mode);
    const f1 = mkScene(6, '6v6', { seed: 17, nFoe: 1 });
    add('scene/a foe team of ONE leaves the player\'s lead preview as it is (six rows, a foe column of one)', f1.scene.mode === 'preview' && f1.scene.view().preview.mine.length === 6 && f1.scene.view().preview.foe.length === 1, f1.scene.mode);

    // 3v3 as it was
    const t3 = mkScene(6, '3v3', { seed: 18 });
    const w3 = t3.scene.view();
    add('scene/3v3 is exactly the preview it was: "Choose 3 (0/3)", then the picks numbered in the order chosen, then "Send out this team?"', w3.preview.title === 'Choose 3 (0/3)' && J(w3.preview.picks) === '[]', w3.preview.title);
    press(t3.scene, 'down', 'a', 'down', 'a');
    const w3b = t3.scene.view();
    add('scene/... two picks (1 then 3rd) show [1,2] and the counter reads 2/3', w3b.preview.title === 'Choose 3 (2/3)' && J(w3b.preview.picks) === '[1,2]', J([w3b.preview.title, w3b.preview.picks]));
    press(t3.scene, 'down', 'a');
    const w3c = t3.scene.view();
    add('scene/... and the third opens "Send out this team?" with the three picks only', t3.scene.mode === 'confirm' && w3c.preview.title === 'Send out this team?' && J(w3c.preview.picks) === '[1,2,3]' && J(t3.scene.fallbacks()) === '["preview.title"]', J([w3c.preview.title, w3c.preview.picks, t3.scene.fallbacks()]));

    // the question fits the title row: it must end before the widest foe name begins
    const room = 232 - ui.measure('normal', 'WWWWWWWWWW');
    add('scene/"Send out this one first?" fits the title row beside the widest 10-letter trainer name (' + (8 + ui.measure('normal', 'Send out this one first?')) + ' < ' + room + ' px)', 8 + ui.measure('normal', 'Send out this one first?') + 4 < room && 8 + ui.measure('normal', romTitle) + 4 < room, J([8 + ui.measure('normal', 'Send out this one first?'), room]));
  });

  /* ---- D. RESUME ---- */
  await blk('resume', async () => {
    const mem = () => { const d = new Map(); return { getItem: (k) => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), removeItem: (k) => d.delete(k), d }; };
    const seed = 4242, A = teamOf(77, 6), B = teamOf(78, 6);
    const makeCtl = () => MC.createMatchController({ pack, teams: [A.recs, B.recs], seed, ...MC.formatOpts('6v6'), names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 9 }] });
    const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
    const st = mem(); const store = RS.createResumeStore({ storage: st, key: 'k', seed });
    const ctl = makeCtl(); ctl.start(); store.attach(ctl);
    ctl.submit(0, { kind: 'preview', order: [3] });
    for (let k = 0; k < 4 && ctl.winner === null; k++) { const r = ctl.pending(0); if (!r) break; ctl.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((q) => !q.disabled).slot } : { kind: 'switch', slot: r.switches[0].slot }); }
    await flush();
    const rec = JSON.parse(st.getItem('k') || 'null');
    add('resume/the saved record starts with the lead choice: { kind preview, order [3] }, then the moves', !!rec && rec.choices[0] && rec.choices[0].kind === 'preview' && J(rec.choices[0].order) === '[3]' && rec.choices.length >= 2, J(rec).slice(0, 160));
    const fresh = makeCtl(); fresh.start();
    const store2 = RS.createResumeStore({ storage: st, key: 'k', seed });
    const r2 = store2.restore({ ctl: fresh, makeCtl, navType: 'reload' });
    add('resume/a reload replays the lead into a fresh battle and lands on the same state (hash and turn), restored true', r2.info.restored === true && r2.ctl.battle.hash() === ctl.battle.hash() && r2.ctl.turn === ctl.turn && J(origs(r2.ctl.battle, 0)) === J(origs(ctl.battle, 0)), J(r2.info));
    add('resume/the replayed battle has the chosen Pokemon in front, as before the reload', origs(r2.ctl.battle, 0)[0] === 3 && r2.ctl.battle.s.sides[0].act !== undefined, J(origs(r2.ctl.battle, 0)));
    // a record from before the lead preview existed: its first choice is a move
    const old = mem(); old.setItem('k', JSON.stringify({ v: RS.RESUME_VERSION, seed, choices: [{ kind: 'move', slot: 0 }, { kind: 'move', slot: 1 }], hash: 'deadbeef', turn: 3 }));
    const store3 = RS.createResumeStore({ storage: old, key: 'k', seed });
    const f3 = makeCtl(); f3.start();
    const r3 = store3.restore({ ctl: f3, makeCtl, navType: 'reload' });
    add('resume/a record saved before the lead preview existed (it starts with a move) is refused cleanly: not restored, a reason that names the refused choice, the record cleared', r3.info.restored === false && /refused/.test(r3.info.reason) && /wrong-phase/.test(r3.info.reason) && old.getItem('k') === null, J(r3.info));
    add('resume/... and the page starts again at the lead preview (a fresh started controller that asks for the lead, nothing replayed)', r3.ctl !== f3 && r3.ctl.pending(0) && r3.ctl.pending(0).phase === 'preview' && r3.ctl.pending(0).lead === true && r3.ctl.battle.choiceLog.filter((e) => e.s === 0).length === 0, J(r3.ctl.pending(0)).slice(0, 80));
    // 3v3 records keep resuming
    const A3 = teamOf(81, 6), B3 = teamOf(82, 6);
    const mk3 = () => MC.createMatchController({ pack, teams: [A3.recs, B3.recs], seed, ...MC.formatOpts('3v3'), names: ['You', 'CPU Normal'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 9 }] });
    const st3 = mem(); const sx = RS.createResumeStore({ storage: st3, key: 'k', seed });
    const c3 = mk3(); c3.start(); sx.attach(c3);
    c3.submit(0, { kind: 'preview', order: [4, 1, 2] });
    for (let k = 0; k < 3 && c3.winner === null; k++) { const r = c3.pending(0); if (!r) break; c3.submit(0, r.phase === 'move' ? { kind: 'move', slot: r.moves.find((q) => !q.disabled).slot } : { kind: 'switch', slot: r.switches[0].slot }); }
    await flush();
    const n3 = mk3(); n3.start();
    const rr3 = RS.createResumeStore({ storage: st3, key: 'k', seed }).restore({ ctl: n3, makeCtl: mk3, navType: 'reload' });
    add('resume/a 3v3 record resumes exactly as before (same hash)', rr3.info.restored === true && rr3.ctl.battle.hash() === c3.battle.hash(), J(rr3.info));
  });

  /* ---- E. PAGE GLUE ---- */
  await blk('glue', async () => {
    const r6 = await BB.resolveBattle(pack, { team: null, foe: 'random', seed: 5, format: '6v6', cpu: 'normal' });
    const r3 = await BB.resolveBattle(pack, { team: null, foe: 'random', seed: 5, format: '3v3', cpu: 'normal' });
    add('boot/resolveBattle: a 6v6 spec has lead true and pick 0, a 3v3 spec lead false and pick 3', r6.ok && r6.spec.lead === true && r6.spec.pick === 0 && r3.ok && r3.spec.lead === false && r3.spec.pick === 3, J([r6.ok && r6.spec.lead, r6.ok && r6.spec.pick, r3.ok && r3.spec.lead, r3.ok && r3.spec.pick]));
    const sp = r6.spec;
    const ctl = MC.createMatchController({ pack, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, lead: sp.lead, names: sp.names, sides: sp.sides }); ctl.start();
    add('boot/a controller built from the page\'s own spec asks the lead first', !!ctl.pending(0) && ctl.pending(0).phase === 'preview' && ctl.pending(0).lead === true, J(ctl.pending(0)).slice(0, 80));
    // online glue: both machines' controllers ask their lead; the opponent is the remote side
    const codeA = await OM.randomTeamCode(pack, 301, 6), codeB = await OM.randomTeamCode(pack, 302, 4);
    const ja = await OM.judgeTeamCode(codeA.code || codeA, pack), jb = await OM.judgeTeamCode(codeB.code || codeB, pack);
    const host = OM.buildNetController({ pack, mySide: 0, seed: 77, fmt: '6v6', names: ['Ann', 'Bob'], mine: ja, theirs: jb });
    const guest = OM.buildNetController({ pack, mySide: 1, seed: 77, fmt: '6v6', names: ['Ann', 'Bob'], mine: jb, theirs: ja });
    add('online/buildNetController on 6v6: both machines open a lead preview for their own side (a team of 6 and a team of 4), and share one state hash', host.pending(0) && host.pending(0).lead === true && host.pending(0).team.length === 6 && guest.pending(1) && guest.pending(1).lead === true && guest.pending(1).team.length === 4 && host.battle.hash() === guest.battle.hash(), J([host.pending(0), guest.pending(1)]).slice(0, 100));
    add('online/... its netMeta says lead true for 6v6 and false for 3v3', host.netMeta.lead === true && host.netMeta.pick === 0 && OM.buildNetController({ pack, mySide: 0, seed: 77, fmt: '3v3', names: ['Ann', 'Bob'], mine: ja, theirs: jb }).netMeta.lead === false);
    host.submit(0, { kind: 'preview', order: [2] }); guest.submit(1, { kind: 'preview', order: [3] });
    host.submitRemote({ kind: 'preview', order: [3] }); guest.submitRemote({ kind: 'preview', order: [2] });
    add('online/the two machines that exchange their leads land on one position (host 3rd leads, guest 4th leads)', host.battle.hash() === guest.battle.hash() && origs(host.battle, 0)[0] === 2 && origs(host.battle, 1)[0] === 3 && host.battle.s.phase === 'move', J([origs(host.battle, 0), origs(host.battle, 1)]));
  });
  return out;
}

/* ===================================================================================================== mutants */
const MUTANTS = [
  ['F01 the engine ignores the lead: the order is only what was picked (a team of one)', 'engine.js', "        order = [lead];\n        for (let i = 0; i < sd.team.length; i++) if (i !== lead) order.push(i);", "        order = [lead];", ['engine/each of the six leads is sent out first and the whole team fights']],
  ['F02 the rest are put behind the lead in REVERSE team order', 'engine.js', "for (let i = 0; i < sd.team.length; i++) if (i !== lead) order.push(i);", "for (let i = sd.team.length - 1; i >= 0; i--) if (i !== lead) order.push(i);", ['engine/the rest keep TEAM order behind the lead']],
  ['F03 the lead is not moved to the front (team order is kept whatever was chosen)', 'engine.js', "        const lead = order[0];\n        order = [lead];", "        const lead = 0;\n        order = [lead];", ['engine/each of the six leads is sent out first and the whole team fights']],
  ['F04 a team of one is asked like any other', 'engine.js', "const one = S.sides[side].team.length < 2;", "const one = false;", ['engine/a team of ONE is not asked']],
  ['F05 two teams of one still wait in a preview nobody can answer', 'engine.js', "if (!S.need[0] && !S.need[1]) this.applyPreview();", "", ['engine/two teams of one need no preview at all']],
  ['F06 the request does not say lead', 'engine.js', "pick: S.pick, ...(S.lead ? { lead: true } : {}), canForfeit: cf,", "pick: S.pick, canForfeit: cf,", ['engine/the request says phase preview, pick 1, lead true']],
  ['F07 every battle\'s start event says lead', 'engine.js', "      ...(S.lead ? { lead: 1 } : {}),", "      lead: 1,", ['engine/a battle with no lead has no lead key']],
  ['F08 lead and pick are accepted together', 'engine.js', "if (lead && opts.pick) throw", "if (false) throw", ['engine/lead and pick together are refused by name']],
  ['F09 the state says lead for every battle', 'engine.js', "  if (lead) s.lead = 1;", "  s.lead = 1;", ['engine/a battle with no lead has no lead key']],
  ['F10 replay forgets the lead option', 'engine.js', "pick: o.pick, lead: o.lead, freeSwitch: o.freeSwitch, names: o.names", "pick: o.pick, freeSwitch: o.freeSwitch, names: o.names", ['engine/replay of the choice log with lead true reproduces the battle']],
  ['F11 a snapshot with a forged lead is accepted', 'engine_validate.js', "if (S.lead !== undefined && (S.lead !== 1 || S.pick !== 1)) fail(", "if (false) fail(", ['engine/a snapshot that says lead 2, lead with pick 3, or lead 0 is refused']],
  ['F12 a lead may be a second Pokemon too (the order may be two long)', 'engine.js', "if (!Array.isArray(o) || o.length !== S.pick) return { ok: false, code: 'bad-order' };", "if (!Array.isArray(o) || o.length < 1) return { ok: false, code: 'bad-order' };", ['engine/an order of two, of none, a slot outside the team']],
  ['F13 6v6 has no lead', 'matchctl.js', "'6v6': Object.freeze({ pick: 0, lead: true })", "'6v6': Object.freeze({ pick: 0, lead: false })", ['api/FORMATS: 6v6 is { pick 0, lead true }', 'boot/resolveBattle: a 6v6 spec has lead true']],
  ['F14 the controller drops the lead option', 'matchctl.js', "pick: opts.pick || 0, lead: opts.lead, freeSwitch, names,", "pick: opts.pick || 0, freeSwitch, names,", ['api/ctl.pending(0) is the lead request']],
  ['F15 formatOpts forgets the lead', 'matchctl.js', "return { pick: f.pick, lead: !!f.lead };", "return { pick: f.pick, lead: false };", ['api/formatOpts gives the pair to spread']],
  ['F16 the scene shows the 3v3 counter at the lead preview', 'scene.js', "p.lead ? (leadAsk ? 'Send out this one first?' : (msg('party.choose', roles(viewSide)) || 'Choose a Pokemon.')) : p.picks.length", "p.picks.length", ['scene/the title is the ROM\'s own line']],
  ['F17 the order numbers show only the lead', 'scene.js', "picks: p.lead ? leadOrder(p) : p.picks,", "picks: p.picks,", ['scene/the question is "Send out this one first?" and the whole team is numbered']],
  ['F18 the title is invented English instead of the ROM line', 'scene.js', "(msg('party.choose', roles(viewSide)) || 'Choose a Pokemon.')", "'Choose your lead'", ['scene/the title is the ROM\'s own line']],
  ['F19 the scene does not know it is a lead preview (it asks for one pick but never opens the question)', 'scene.js', "lead: !!req.lead, mine,", "lead: false, mine,", ['scene/the title is the ROM\'s own line']],
  ['F20 NO still sends the lead', 'scene.js', "if (yes) submit({ kind: 'preview', order: S.preview.picks.map((i) => S.preview.mine[i].slot) });", "if (true) submit({ kind: 'preview', order: S.preview.picks.map((i) => S.preview.mine[i].slot) });", ['scene/NO goes back to the preview with the pick cleared']],
  ['F21 the numbers put the rest in reverse order', 'scene.js', "p.mine.map((_, i) => i).filter((i) => i !== p.picks[0])", "p.mine.map((_, i) => i).filter((i) => i !== p.picks[0]).reverse()", ['scene/the question is "Send out this one first?" and the whole team is numbered']],
  ['F22 the question is not listed as a fallback', 'scene.js', "leadAsk ? 'confirm.lead' : 'preview.title'", "leadAsk ? 'preview.title' : 'preview.title'", ['scene/that question is listed as a fallback']],
  ['F23 the online controller is built without the lead', 'online_match.js', "seed: seed >>> 0, ...formatOpts(fmt), names:", "seed: seed >>> 0, pick: FORMATS[fmt].pick, names:", ['online/buildNetController on 6v6']],
  ['F24 the online netMeta forgets the lead', 'online_match.js', "pick: FORMATS[fmt].pick, lead: !!FORMATS[fmt].lead, fmt };", "pick: FORMATS[fmt].pick, lead: false, fmt };", ['online/... its netMeta says lead true']],
  ['F25 the page spec forgets the lead', 'battle_boot.js', "pick, lead: !!FORMATS[params.format].lead, names:", "pick, lead: false, names:", ['boot/resolveBattle: a 6v6 spec has lead true']],
];

/* ===================================================================================================== run */
function copyJs(dest) { fs.mkdirSync(dest, { recursive: true }); for (const n of fs.readdirSync(JS)) { const s = path.join(JS, n); if (fs.statSync(s).isFile() && (n.endsWith('.js') || n.endsWith('.json'))) fs.copyFileSync(s, path.join(dest, n)); } return dest; }

head('A-E. the real modules');
const real = await loadFrom(JS);
const t0 = Date.now();
const res = await suite(real);
for (const [name, ok] of res) report(name, ok);
console.log(`  ${res.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

if (WANT_MUTANTS) {
  head('F. mutants (a temp copy of pokemonarena/js each)');
  const run = async (file, from, to) => {
    const dir = copyJs(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-lead-')));
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
    const named = expect.some((x) => fails.some((f) => f.startsWith(x.slice(0, 70))));
    if (named) caught++;
    report(id + ' -> caught by a NAMED check', named, 'failed: ' + (fails.join(' | ').slice(0, 300) || 'none'));
  }
  console.log(`  mutants ${caught}/${MUTANTS.length}`);
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }
