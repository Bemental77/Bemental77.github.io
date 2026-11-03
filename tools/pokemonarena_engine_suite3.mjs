// tools/pokemonarena_engine_suite3.mjs -- the engine API (requests / choose / advance / forfeit / preview / snapshot / replay /
// views / choice encoding), determinism, and the rules.js engine layer.  Same shape as suites 1 and 2.

import { makeLab, RS } from './pokemonarena_engine_lib.mjs';

export function suite3(M, pack, rom, opts = {}) {
  const L = makeLab(M, pack);
  const { lab, run, turn, mid, MV, SW, of, eq, J, T } = L;
  const E = M.engine, R = M.rules;
  const checks = [];
  const add = (id, fn) => checks.push({ id, fn });
  const A = (m, extra) => Object.assign({ moves: [m] }, extra || {});
  const NC = [1, 0];

  // ------------------------------------------------------------------ requests and choices
  add('api/requests-shape-at-the-start', () => {
    const b = lab({ a: { moves: ['Pound', 'Splash'], bench: [A('Pound')] } });
    const [ra, rb] = b.requests();
    return eq([ra.phase, ra.canForfeit, ra.moves.map((m) => m.slot), ra.moves[0].pp, ra.switches.map((s) => s.slot), rb.phase, rb.switches.length, ra.trapped], ['move', true, [0, 1], 35, [1], 'move', 0, false]);
  });
  add('api/choose-error-codes', () => {
    const b = lab({ a: { moves: ['Pound', 'Splash'], pp: [0, 5], bench: [A('Pound')] }, b: { bench: [A('Pound')], benchSpec: { hp: 0 } } });
    const codes = [b.choose(2, MV(0)).code, b.choose(0, null).code, b.choose(0, { kind: 'dance' }).code, b.choose(0, MV(7)).code, b.choose(0, MV(0)).code, b.choose(0, SW(0)).code, b.choose(0, SW(5)).code, b.choose(1, SW(1)).code];
    const ok = b.choose(0, MV(1)).code;
    return eq([codes, ok, b.choose(0, MV(1)).code], [['bad-side', 'bad-choice', 'bad-choice', 'bad-slot', 'no-pp', 'active', 'bad-slot', 'fainted'], 'ok', 'already-chosen']);
  });
  add('api/not-ready-until-every-needed-side-has-chosen', () => {
    const b = lab({});
    const r0 = b.ready();
    b.choose(0, MV(0));
    const r1 = b.ready();
    const ev = b.advance();
    b.choose(1, MV(0));
    const r2 = b.ready();
    return eq([r0, r1, ev.length, r2], [false, false, 0, true]);
  });
  add('api/forfeit-ends-the-battle-with-the-other-side-winning', () => {
    const b = lab({});
    b.choose(0, { kind: 'forfeit' });
    const ev = b.advance();
    const c = lab({});
    c.choose(0, { kind: 'forfeit' }); c.choose(1, { kind: 'forfeit' });
    c.advance();
    return eq([b.winner, of(ev, 'forfeit').length, of(ev, 'win').map((e) => e.s), c.winner, b.requests()[0].phase, b.choose(0, MV(0)).code], [1, 1, [1], -1, 'end', 'ended']);
  });
  add('api/forced-switch-after-a-faint-asks-only-that-side', () => {
    const b = lab({ a: A('Pound'), b: { hp: 1, bench: [A('Pound')] } });
    turn(b, MV(0), MV(0), NC);
    const [ra, rb] = b.requests();
    const ev = turn(b, null, SW(1));
    return eq([b.s.turn, ra.phase, rb.phase, rb.reason, of(ev, 'switch-in').length, b.s.phase], [2, 'wait', 'switch', 'faint', 1, 'move']);
  });
  add('api/win-when-the-last-mon-faints', () => { const r = run({ a: A('Pound'), b: { hp: 1 } }, { rng: NC }); return eq([r.b.winner, of(r.ev, 'win').length], [0, 1]); });
  add('api/simultaneous-faint-of-the-last-mons-is-a-draw', () => { const r = run({ a: A('Explosion', { hp: 50 }), b: { hp: 30 } }, { rng: NC }); return eq([r.b.winner, of(r.ev, 'draw').length], [-1, 1]); });
  add('api/turn-cap-ends-in-a-draw', () => { const b = lab({}); b.s.turn = M.engine_data.E.turnCap; const ev = turn(b, MV(0), MV(0)); return eq([b.winner, of(ev, 'turn-cap').length], [-1, 1]); });
  add('api/struggle-when-out-of-pp', () => { const b = lab({ a: A('Pound', { pp: [0] }) }); const r = b.requests()[0]; return eq([r.struggle, r.moves.length, r.moves[0].slot, b.choose(0, MV(0)).code], [true, 1, 4, 'bad-slot']); });
  add('api/pp-decreases-by-one-and-by-two-under-pressure', () => eq([run({ a: A('Pound') }, { rng: NC }).A.mv[0].pp, run({ a: A('Pound'), b: { ab: 'Pressure' } }, { rng: NC }).A.mv[0].pp], [34, 33]));

  // ------------------------------------------------------------------ team preview (3 of 6)
  add('api/preview-then-leads', () => {
    const six = { moves: ['Pound'], bench: [A('Pound'), A('Pound'), A('Pound'), A('Pound'), A('Pound')] };
    const b = lab({ a: six, b: six, pick: 3 });
    const r0 = b.requests()[0];
    const bad = [b.choose(0, { kind: 'preview', order: [0, 1] }).code, b.choose(0, { kind: 'preview', order: [0, 0, 1] }).code, b.choose(0, MV(0)).code];
    b.choose(0, { kind: 'preview', order: [4, 2, 5] });
    const mid1 = b.requests()[0].phase;
    b.choose(1, { kind: 'preview', order: [1, 3, 0] });
    const ev = b.advance();
    return eq([r0.phase, r0.pick, r0.team.length, bad, mid1, b.s.sides[0].team.map((m) => m.orig), b.s.sides[1].team.map((m) => m.orig), of(ev, 'preview').length, b.s.phase, b.s.turn], ['preview', 3, 6, ['bad-order', 'bad-order', 'wrong-phase'], 'wait', [4, 2, 5], [1, 3, 0], 2, 'move', 1]);
  });
  add('api/pick-needs-enough-mons', () => { try { lab({ pick: 3 }); return 'accepted a 1-mon team with pick 3'; } catch (e) { return e.name === 'EngineError' ? true : String(e); } });

  // ------------------------------------------------------------------ choice encoding for the wire
  add('wire/choice-encode-decode-round-trip', () => {
    const cs = [];
    for (let s = 0; s <= 4; s++) cs.push({ kind: 'move', slot: s });
    for (let s = 0; s <= 5; s++) cs.push({ kind: 'switch', slot: s });
    cs.push({ kind: 'forfeit' }, { kind: 'preview', order: [5] }, { kind: 'preview', order: [0, 1, 2] }, { kind: 'preview', order: [5, 4, 3, 2] });
    for (const c of cs) { const v = E.encodeChoice(c); if (v < 0 || v > 0xffff || J(E.decodeChoice(v)) !== J(c)) return `${J(c)} -> ${v} -> ${J(E.decodeChoice(v))}`; }
    return true;
  });
  add('wire/every-16-bit-pattern-is-canonical-or-refused', () => {
    let ok = 0;
    for (let v = 0; v < 65536; v++) { const c = E.decodeChoice(v); if (c !== null) { if (E.encodeChoice(c) !== v) return `v=${v} decodes to ${J(c)} which re-encodes to ${E.encodeChoice(c)}`; ok++; } }
    return ok > 100 ? true : `only ${ok} valid encodings`;
  });
  add('wire/invalid-choices-do-not-encode', () => eq([E.encodeChoice(null), E.encodeChoice({ kind: 'move', slot: 5 }), E.encodeChoice({ kind: 'switch', slot: 6 }), E.encodeChoice({ kind: 'preview', order: [0, 1, 2, 3, 4] }), E.encodeChoice({ kind: 'preview', order: [6] }), E.encodeChoice({ kind: 'move', slot: -1 })], [-1, -1, -1, -1, -1, -1]));

  // ------------------------------------------------------------------ determinism, snapshot, replay, pure step
  const playScript = (b, seq) => { for (const [ca, cb] of seq) { b.choose(0, ca); b.choose(1, cb); b.advance(); } };
  const seqA = [[MV(0), MV(0)], [MV(1), MV(0)], [MV(0), MV(1)], [MV(0), MV(0)]];
  const duo = { a: { moves: ['Pound', 'Flamethrower'] }, b: { moves: ['Karate Chop', 'Water Gun'] } };
  add('determinism/same-seed-same-events-and-hash', () => {
    const x = lab({ ...duo, seed: 77 }), y = lab({ ...duo, seed: 77 }), z = lab({ ...duo, seed: 78 });
    playScript(x, seqA); playScript(y, seqA); playScript(z, seqA);
    return eq([J(x.events) === J(y.events), x.hash() === y.hash(), x.hash() === z.hash() && J(x.events) === J(z.events)], [true, true, false]);
  });
  add('determinism/snapshot-json-round-trip-mid-battle', () => {
    const x = lab({ ...duo, seed: 5 });
    playScript(x, seqA.slice(0, 2));
    const snap = JSON.parse(JSON.stringify(x.snapshot()));
    const y = E.restoreBattle(snap, { pack });
    const same = y.hash() === x.hash();
    playScript(x, seqA.slice(2)); playScript(y, seqA.slice(2));
    return eq([same, x.hash() === y.hash(), J(x.events) === J(y.events)], [true, true, true]);
  });
  add('determinism/restore-refuses-a-wrong-version-or-rom', () => {
    const x = lab({});
    const s = x.snapshot();
    const bad1 = { ...s, v: 99 };
    let e1 = null, e2 = null;
    try { E.restoreBattle(bad1, { pack }); } catch (e) { e1 = e.name; }
    try { E.restoreBattle({ ...s, packId: 'f'.repeat(64) }, { pack: { ...pack, rom: { ...pack.rom, sha256: '0'.repeat(64) } } }); } catch (e) { e2 = e.name; }
    return eq([e1, e2], ['EngineError', 'EngineError']);
  });
  add('determinism/replay-reproduces-events-and-hash', () => {
    const teams = (() => { const mk = (x) => { const r = R.blankRec(25, pack, RS); r.moves = x.map(mid); return r; }; return [[mk(['Pound', 'Flamethrower'])], [mk(['Karate Chop', 'Water Gun'])]]; })();
    const x = E.createBattle({ pack, ruleset: RS, teams, seed: 99, validate: false });
    for (const [ca, cb] of seqA) { x.choose(0, ca); x.choose(1, cb); x.advance(); }
    const rp = E.replay({ pack, ruleset: RS, teams, seed: 99, choiceLog: x.choiceLog, validate: false });
    return eq([rp.hash === x.hash(), J(rp.events) === J(x.events), x.choiceLog.length], [true, true, 8]);
  });
  add('determinism/stepBattle-is-a-pure-function-of-state-and-choices', () => {
    const x = lab({ ...duo, seed: 3 });
    x.drain();
    const snap = x.snapshot();
    const r1 = E.stepBattle(snap, [MV(0), MV(1)], { pack }), r2 = E.stepBattle(JSON.parse(JSON.stringify(snap)), [MV(0), MV(1)], { pack });
    x.choose(0, MV(0)); x.choose(1, MV(1)); const ev = x.advance();
    return eq([r1.hash === r2.hash, r1.hash === x.hash(), J(r1.events) === J(ev), J(snap) === J(x.snapshot()) ? 'unexpected' : 'ok'], [true, true, true, 'ok']);
  });
  add('determinism/hash-is-sensitive-to-state', () => { const x = lab({}), h = x.hash(); x.s.sides[1].team[0].hp -= 1; const h2 = x.hash(); x.s.sides[1].team[0].hp += 1; return eq([h === h2, x.hash() === h], [false, true]); });
  add('determinism/state-has-no-undefined-or-nan', () => { const x = lab({ ...duo }); playScript(x, seqA); try { x.hash(); } catch (e) { return String(e); } return JSON.stringify(x.s).indexOf('null') >= 0 && /NaN|undefined/.test(JSON.stringify(x.s)) ? 'bad value' : true; });
  add('determinism/rng-algorithm-is-the-documented-lcg', () => {
    const x = lab({ seed: 1 });
    x.s.rng = 1;
    const got = [x.rand(65536), x.rand(65536), x.rand(100)];
    let s = 1; const want = [];
    for (const n of [65536, 65536, 100]) { s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0; want.push((s >>> 16) % n); }
    return eq(got, want);
  });

  // ------------------------------------------------------------------ information hiding
  add('view/foe-hidden-info-is-not-exposed-until-revealed', () => {
    const b = lab({ a: { moves: ['Pound', 'Flamethrower'], it: 'Leftovers', ab: 'Technician' }, b: { moves: ['Karate Chop', 'Water Gun'], it: 'Life Orb', bench: [A('Pound')] } });
    const v0 = b.viewFor(0);
    const foe = v0.foe.activeDetail;
    const before = [foe.stats, foe.mv, foe.hp, foe.max, foe.ab, foe.it, foe.revealed.mv, foe.revealed.ab, foe.revealed.it, typeof foe.hpPct, v0.you.activeDetail.stats !== undefined, v0.foe.team[1].hidden];
    turn(b, MV(0), MV(0), [1, 0, 1, 0]);
    const f2 = b.viewFor(0).foe.activeDetail;
    return eq([before, f2.revealed.mv.length, f2.mv], [[undefined, undefined, undefined, undefined, undefined, undefined, [], null, null, 'number', true, 1], 1, undefined]);
  });
  add('view/choice-lock-and-flash-fire-are-not-visible-on-the-foe', () => {
    const b = lab({ a: A('Pound', { it: 'Choice Band', ab: 'Flash Fire', v: { ff: 1 } }) });
    turn(b, MV(0), MV(0), NC);
    const mine = b.viewFor(0).you.activeDetail.vol, foe = b.viewFor(1).foe.activeDetail.vol;
    return eq([mine.includes('choice'), mine.includes('ff'), foe.includes('choice'), foe.includes('ff')], [true, true, false, false]);
  });
  add('view/serialises-without-private-fields', () => { const b = lab({ a: A('Pound', { it: 'Leftovers' }) }); const s = JSON.stringify(b.viewFor(1).foe); return /"stats"|"mv":\[\{|"it":[1-9]/.test(s) ? 'foe view leaked: ' + s.slice(0, 200) : true; });

  // ------------------------------------------------------------------ the rules.js engine layer
  const sup = R.engineSupports(pack);
  const first = (pred) => pack.roster.find(pred);
  add('rules/engine-layer-is-on-in-the-default-ruleset-and-off-in-an-explicit-object', () => {
    const rs = R.resolveRuleset(RS);
    const off = { ...rs, engine: { enforce: false } };
    return eq([rs.engine.enforce, R.checkRuleset(off), R.checkRuleset({ ...rs, engine: { enforce: 'yes' } }).length > 0], [true, [], true]);
  });
  const rec = (sid, moves, extra) => Object.assign(R.blankRec(sid, pack, RS), { moves }, extra || {});
  // a move that is still unsupported AND that Mewtwo can legally learn (so the only fault is the engine layer); the set shrinks as moves are built, so it is found, not named
  const unsupMove = Number(Object.keys(sup.moveReasons).find((id) => R.validateMon(rec(150, [mid('Psychic'), Number(id)]), pack, RS).reasons.some((x) => x.code === 'move.engine-unsupported')));
  add('rules/unsupported-move-is-illegal-with-a-reason-code', () => {
    if (Number.isNaN(unsupMove)) return true;   // every learnable move is supported: nothing left to refuse
    const r = R.validateMon(rec(150, [mid('Psychic'), unsupMove]), pack, RS); // Mewtwo knows Helping Hand (a doubles-only move, so it stays unsupported in a singles engine)
    const off = R.validateMon(rec(150, [mid('Psychic'), unsupMove]), pack, { ...R.resolveRuleset(RS), engine: { enforce: false } });
    return eq([r.reasons.map((x) => x.code + '@' + x.path), r.reasons[0].why, off.ok], [['move.engine-unsupported@moves[1]'], sup.moveReasons[unsupMove], true]);
  });
  add('rules/unsupported-item-and-ability-codes', () => {
    const megaStone = pack.items.find((i) => i.name === 'Venusaurite').id;
    const r = R.validateMon(rec(3, [mid('Razor Leaf')], { item: megaStone }), pack, RS);
    const noAb = R.engineExcludedSpecies(pack, RS).find((e) => e.why === 'no-ability').id; // e.g. an Arceus form (Multitype)
    const z = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, g = R.validateMon({ species: noAb, level: 50, nature: 0, abilitySlot: 0, item: 0, moves: [R.legalMoves(pack, noAb, 100, RS)[0]], ivs: z, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } }, pack, RS);
    return eq([r.reasons.map((x) => x.code), g.reasons.map((x) => x.code)], [['item.engine-unsupported'], ['species.engine-no-ability']]);
  });
  add('rules/legalMoves-lists-only-supported-moves', () => {
    const lm = R.legalMoves(pack, 445, 100, RS);
    const all = R.legalMoves(pack, 445, 100, { ...R.resolveRuleset(RS), engine: { enforce: false } });
    return eq([lm.every((id) => sup.moves.has(id)), all.length >= lm.length, lm.length > 40], [true, true, true]);
  });
  add('rules/blankRec-is-valid-for-every-engine-legal-species-and-throws-for-excluded', () => {
    const ex = new Set(R.engineExcludedSpecies(pack, RS).map((e) => e.id));
    for (const id of pack.roster) {
      if (ex.has(id)) { try { R.blankRec(id, pack, RS); return `blankRec accepted excluded species ${id}`; } catch (e) { if (!(e instanceof RangeError)) return `wrong error for ${id}`; } continue; }
      const r = R.validateMon(R.blankRec(id, pack, RS), pack, RS);
      if (!r.ok) return `blankRec(${id}) invalid: ${J(r.reasons.map((x) => x.code))}`;
    }
    return true;
  });
  add('rules/excluded-species-report-and-final-counts', () => {
    const cov = R.engineCoverage(pack, RS);
    const ex = R.engineExcludedSpecies(pack, RS);
    return eq([cov.species + ex.length, cov.speciesLegalBeforeEngine, ex.every((e) => e.why === 'no-ability' || e.why === 'no-move'), cov.moves === sup.moves.size, cov.items === sup.items.size], [pack.roster.length, pack.roster.length, true, true, true]);
  });
  if (!opts.cheap) add('rules/every-engine-legal-species-can-battle', () => {
    // one tiny battle per legal species (round-robin vs Pikachu): construction + one turn must not throw
    const ex = new Set(R.engineExcludedSpecies(pack, RS).map((e) => e.id));
    let n = 0;
    for (const id of pack.roster) {
      if (ex.has(id)) continue;
      const a = R.blankRec(id, pack, RS), b = R.blankRec(25, pack, RS);
      const bt = E.createBattle({ pack, ruleset: RS, teams: [[a], [b]], seed: id, validate: true });
      bt.choose(0, MV(0)); bt.choose(1, MV(0)); bt.advance(); n++;
    }
    return n > 800 ? true : `only ${n} species`;
  });
  return checks;
}
