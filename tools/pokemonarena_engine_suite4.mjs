// tools/pokemonarena_engine_suite4.mjs -- checks added after the two adversarial verifiers (fidelity, robustness) failed stage E1:
// one named check per defect they proved, each with its arithmetic written above it, plus the checks that kill the mutants that
// survived (Sturdy at any HP, Multiscale always on, Fur Coat 1.5x, Sun no longer stops freezing, Sand Rock SpD x2) or were killed
// only by the golden digest (trap residual, Focus Sash, Sitrus).  Same shape as suites 1-3: an array of { id, fn }.
// Lab defaults (tools/pokemonarena_engine_lib.mjs): level 50, every stat 100 (speed A 100, B 50), 200 HP, type '???' (no STAB,
// everything neutral), no ability, no item.  A plain hit draws [crit rand(24), roll rand(16)]; NC = no crit + max roll.

import { makeLab, RS } from './pokemonarena_engine_lib.mjs';

export function suite4(M, pack, rom, opts = {}) {
  const L = makeLab(M, pack);
  const { lab, run, turn, mid, MV, SW, of, lost, healed, eq, J, T, scripted } = L;
  const E = M.engine, R = M.rules, DG = M.engine_digest;
  const checks = [];
  const add = (id, fn) => checks.push({ id, fn });
  const A = (m, extra) => Object.assign({ moves: [m] }, extra || {});
  const NC = [1, 0];
  const FORFEIT = { kind: 'forfeit' };
  const errOf = (fn) => { try { fn(); return 'no error'; } catch (e) { return e && e.name === 'EngineError' ? 'EngineError:' + e.code : (e && e.name) + ':' + String(e && e.message).slice(0, 60); } };
  const dmgOf = (ev, s) => lost(ev, s, 'move');
  const hitOfRun = (spec, rng) => lost(run(spec, { rng: rng || [1, 0, 99] }).ev, 1, 'move');   // Flamethrower's 10% burn draw is 99 (no effect); Pound ignores the extra draw

  // ================================================================== D1 Explosion / Self-Destruct always faint their user
  // Explosion BP250 is irrelevant here: whether the move HITS or not, the user faints once it was used.
  add('fix-d1/explosion-vs-a-ghost-user-still-faints', () => {
    const r = run({ a: A('Explosion', { bench: [A('Splash')] }), b: { ty: [T.GHOST] } }, { rng: [] });
    return eq([r.A.hp, r.A.fnt, r.B.hp, of(r.ev, 'immune').length, of(r.ev, 'faint').map((e) => e.s)], [0, 1, 200, 1, [0]]);
  });
  // eva +6 against accuracy 100: floor(100*3/9) = 33 ; rand(100) = 99 -> miss
  add('fix-d1/explosion-that-misses-still-faints-its-user', () => {
    const r = run({ a: A('Explosion', { bench: [A('Splash')] }), b: { sg: { eva: 6 } } }, { rng: [99] });
    return eq([of(r.ev, 'miss').length, r.A.hp, r.B.hp], [1, 0, 200]);
  });
  add('fix-d1/self-destruct-into-protect-still-faints-its-user', () => {
    const r = run({ a: A('Self-Destruct', { bench: [A('Splash')] }), b: { moves: ['Protect'], st: { spe: 120 } } }, { rng: [] });
    return eq([of(r.ev, 'protected').length, r.A.hp, r.B.hp], [1, 0, 200]);
  });
  add('fix-d1/explosion-against-a-semi-invulnerable-target-still-faints-its-user', () => {
    const r = run({ a: A('Explosion', { bench: [A('Splash')] }), b: { v: { sinv: 'ground' } } }, { rng: [] });
    return eq([of(r.ev, 'avoid').length, r.A.hp, r.B.hp], [1, 0, 200]);
  });
  add('fix-d1/damp-stops-the-explosion-and-spares-the-user', () => {
    const r = run({ a: A('Explosion'), b: { ab: 'Damp' } }, { rng: [] });
    return eq([of(r.ev, 'fail').map((e) => e.why), r.A.hp, r.B.hp], [['damp'], 200, 200]);
  });
  // Explosion BP250: floor(22*250*100/100 / 50) + 2 = 112 (a hit still faints the user, exactly once)
  add('fix-d1/a-hit-explosion-faints-the-user-exactly-once', () => {
    const r = run({ a: A('Explosion', { bench: [A('Splash')] }) }, { rng: NC });
    return eq([dmgOf(r.ev, 1), of(r.ev, 'faint').map((e) => e.s), r.A.hp], [112, [0], 0]);
  });

  // ================================================================== D2 a frozen target is thawed by a Fire-type hit
  // Ember (acc 100, burn 10%): [crit 1, roll 0, burn roll 99 = no burn]
  add('fix-d2/ember-thaws-a-frozen-target', () => {
    const r = run({ a: A('Ember'), b: { s: 4 } }, { rng: [1, 0, 99] });
    return eq([r.B.s, of(r.ev, 'status-clear').map((e) => e.why + '@' + e.s), r.B.hp < 200], [0, ['thaw@1'], true]);
  });
  add('fix-d2/a-non-fire-hit-does-not-thaw', () => {
    const r = run({ a: A('Pound'), b: { s: 4 } }, { rng: [1, 0, 1] }); // the third value: B's own thaw roll fails
    return eq([r.B.s, of(r.ev, 'cant-move').map((e) => e.why)], [4, ['frz']]);
  });
  add('fix-d2/a-substitute-absorbs-the-fire-hit-so-nothing-thaws', () => {
    const r = run({ a: A('Ember'), b: { s: 4, v: { sub: 50 } } }, { rng: [1, 0, 1] });
    return eq([r.B.s, of(r.ev, 'sub-damage').length, of(r.ev, 'status-clear').length], [4, 1, 0]);
  });
  add('fix-d2/scald-thaws-a-frozen-target', () => {
    const r = run({ a: A('Scald'), b: { s: 4 } }, { rng: [1, 0, 99] });
    return eq([r.B.s, of(r.ev, 'status-clear').map((e) => e.why)], [0, ['thaw']]);
  });

  // ================================================================== D3 x2 damage against a semi-invulnerable target the move reaches
  // Earthquake BP100 physical: floor(22*100*100/100/50)+2 = 46 ; x2 vs a Dig user = 92
  // the target is mid-way through Dig / Dive / Fly (the flag is set; its own turn is a Splash so it draws no random number)
  const semi = (kind) => ({ v: { sinv: kind } });
  add('fix-d3/earthquake-doubles-against-a-dig-user', () => {
    const plain = run({ a: A('Earthquake') }, { rng: NC });
    const dug = run({ a: A('Earthquake'), b: semi('ground') }, { rng: NC });
    return eq([dmgOf(plain.ev, 1), dmgOf(dug.ev, 1)], [46, 92]);
  });
  // Thunder (acc 70, paralysis 30%) is flagged in the ROM as reaching a Fly user, but it is not doubled: [acc 0, crit 1, roll 0, para roll 99]
  add('fix-d3/thunder-reaches-a-fly-user-but-does-not-double', () => {
    const plain = run({ a: A('Thunder') }, { rng: [0, 1, 0, 99] });
    const flew = run({ a: A('Thunder'), b: semi('air') }, { rng: [0, 1, 0, 99] });
    return eq([dmgOf(plain.ev, 1) > 0, dmgOf(flew.ev, 1), of(flew.ev, 'avoid').length], [true, dmgOf(plain.ev, 1), 0]);
  });
  // Surf BP90 special: floor(22*90*100/100/50)+2 = 41 ; x2 vs a Dive user = 82
  add('fix-d3/surf-doubles-against-a-dive-user', () => {
    const plain = run({ a: A('Surf') }, { rng: NC });
    const dove = run({ a: A('Surf'), b: semi('water') }, { rng: NC });
    return eq([dmgOf(plain.ev, 1), dmgOf(dove.ev, 1)], [41, 82]);
  });
  // Gust BP40 special, Flying: floor(22*40*100/100/50)+2 = 19 ; x2 vs a Fly user = 38
  add('fix-d3/gust-doubles-against-a-fly-user', () => {
    const plain = run({ a: A('Gust') }, { rng: NC });
    const flew = run({ a: A('Gust'), b: semi('air') }, { rng: NC });
    return eq([dmgOf(plain.ev, 1), dmgOf(flew.ev, 1)], [19, 38]);
  });
  // Stomp BP65 physical: floor(22*65*100/100/50)+2 = 30 ; x2 vs a Minimized target = 60 (flinch roll 99 = none)
  add('fix-d3/stomp-doubles-against-a-minimized-target', () => {
    const plain = run({ a: A('Stomp') }, { rng: [1, 0, 99] });
    const mini = run({ a: A('Stomp'), b: { v: { mini: 1 } } }, { rng: [1, 0, 99] });
    return eq([dmgOf(plain.ev, 1), dmgOf(mini.ev, 1)], [30, 60]);
  });
  add('fix-d3/using-minimize-marks-the-user-and-stomp-family-never-misses-it', () => {
    const b = lab({ a: { moves: ['Splash'], st: { spe: 100 } }, b: { moves: ['Minimize'], st: { spe: 200 } } });
    turn(b, MV(0), MV(0));
    const flag = b.s.sides[1].team[0].v.mini;
    // Dragon Rush (accuracy 75, flinch 20%): against a Minimized target no accuracy roll is drawn: [crit, roll, flinch]
    const c = lab({ a: A('Dragon Rush'), b: { v: { mini: 1 } } });
    const ev = turn(c, MV(0), MV(0), [1, 0, 99]);
    return eq([flag, of(ev, 'miss').length, dmgOf(ev, 1) > 0], [1, 0, true]);
  });

  // ================================================================== D4 Prankster-boosted status moves fail against Dark targets
  add('fix-d4/prankster-thunder-wave-fails-against-a-dark-type', () => {
    const r = run({ a: A('Thunder Wave', { ab: 'Prankster' }), b: { ty: [T.DARK] } }, { rng: [] });
    return eq([r.B.s, of(r.ev, 'immune').map((e) => e.why)], [0, ['prankster']]);
  });
  add('fix-d4/prankster-still-works-against-a-non-dark-target-and-without-prankster-against-dark', () => {
    const a = run({ a: A('Thunder Wave', { ab: 'Prankster' }) }, { rng: [0, 3] }); // accuracy roll, then B's full-paralysis roll (3 = it moves)
    const c = run({ a: A('Thunder Wave'), b: { ty: [T.DARK] } }, { rng: [0, 3] });
    return eq([a.B.s, c.B.s], [5, 5]);
  });
  add('fix-d4/prankster-self-and-damaging-moves-ignore-the-dark-rule', () => {
    const sd = run({ a: A('Swords Dance', { ab: 'Prankster' }), b: { ty: [T.DARK] } }, { rng: [] });
    const dm = run({ a: A('Pound', { ab: 'Prankster' }), b: { ty: [T.DARK] } }, { rng: NC });
    return eq([sd.A.sg.atk, dmgOf(dm.ev, 1)], [2, 19]);
  });

  // ================================================================== D5 Ghost types are not trapped by Shadow Tag / Arena Trap / Magnet Pull
  const bench = [A('Splash')];
  add('fix-d5/shadow-tag-does-not-trap-a-ghost', () => {
    const b = lab({ a: { moves: ['Splash'], ab: 'Shadow Tag' }, b: { moves: ['Splash'], ty: [T.GHOST], bench } });
    return eq([b.requests()[1].trapped, b.choose(1, SW(1)).ok], [false, true]);
  });
  add('fix-d5/shadow-tag-still-traps-a-non-ghost-and-a-shed-shell-frees-it', () => {
    const b = lab({ a: { moves: ['Splash'], ab: 'Shadow Tag' }, b: { moves: ['Splash'], bench } });
    const c = lab({ a: { moves: ['Splash'], ab: 'Shadow Tag' }, b: { moves: ['Splash'], it: 'Shed Shell', bench } });
    return eq([b.requests()[1].trapped, b.choose(1, SW(1)).code, c.requests()[1].trapped], [true, 'trapped', false]);
  });
  add('fix-d5/arena-trap-does-not-trap-a-grounded-ghost-either', () => {
    const b = lab({ a: { moves: ['Splash'], ab: 'Arena Trap' }, b: { moves: ['Splash'], ty: [T.GHOST], bench } });
    const c = lab({ a: { moves: ['Splash'], ab: 'Arena Trap' }, b: { moves: ['Splash'], bench } });
    return eq([b.requests()[1].trapped, c.requests()[1].trapped], [false, true]);
  });

  // ================================================================== D6 / D7 accuracy exceptions
  add('fix-d6/toxic-from-a-poison-type-never-misses', () => {
    const r = run({ a: A('Toxic', { ty: [T.POISON] }), b: { sg: { eva: 6 } } }, { rng: [] }); // not a single rand(100)
    return eq([r.B.s, of(r.ev, 'miss').length], [6, 0]);
  });
  add('fix-d6/toxic-from-a-non-poison-type-can-still-miss', () => {
    const r = run({ a: A('Toxic'), b: { sg: { eva: 6 } } }, { rng: [99] }); // acc 90 * 3/9 = 30 -> 99 misses
    return eq([r.B.s, of(r.ev, 'miss').length], [0, 1]);
  });
  // Sheer Cold: base 30 for an Ice-type user, 20 for any other user, plus (user level - target level)
  const sheer = (spec, roll) => { const r = run({ a: A('Sheer Cold', spec.a), b: spec.b }, { rng: [roll] }); return of(r.ev, 'miss').length === 0 && r.B.hp === 0 ? 'hit' : 'miss'; };
  add('fix-d7/sheer-cold-is-20-percent-for-a-non-ice-user', () => eq([sheer({ a: {} }, 19), sheer({ a: {} }, 20)], ['hit', 'miss']));
  add('fix-d7/sheer-cold-is-30-percent-for-an-ice-user', () => eq([sheer({ a: { ty: [T.ICE] } }, 29), sheer({ a: { ty: [T.ICE] } }, 30)], ['hit', 'miss']));
  add('fix-d7/sheer-cold-adds-the-level-difference-after-the-base', () => eq([sheer({ a: { level: 60 } }, 29), sheer({ a: { level: 60 } }, 30)], ['hit', 'miss']));

  // ================================================================== fainted Pokemon carry no status
  add('fix-minor/a-fainted-pokemon-has-no-status', () => {
    const r = run({ a: A('Pound', { st: { atk: 999 } }), b: { hp: 5, s: 2, sc: 0, bench } }, { rng: NC });
    const v = r.b.viewFor(0).foe.activeDetail;
    return eq([r.B.hp, r.B.s, r.B.sc, v.st, of(r.ev, 'faint').length], [0, 0, 0, 0, 1]);
  });
  add('fix-minor/a-fainted-toxic-pokemon-resets-its-counter', () => {
    const r = run({ a: A('Pound', { st: { atk: 999 } }), b: { hp: 5, s: 6, sc: 4, bench } }, { rng: NC });
    return eq([r.B.s, r.B.sc], [0, 0]);
  });

  // ================================================================== Transform reports the copied stat stages
  add('fix-minor/transform-event-carries-the-copied-stages', () => {
    const b = lab({ a: A('Transform'), b: { moves: ['Splash'], sg: { atk: 2, spe: -1 } } });
    const ev = turn(b, MV(0), MV(0));
    const cp = of(ev, 'copy', (e) => e.how === 'transform')[0];
    return eq([cp.sg.atk, cp.sg.spe, b.s.sides[0].team[0].sg.atk, b.s.sides[0].team[0].sg.spe], [2, -1, 2, -1]);
  });

  // ================================================================== Metronome never calls a Z-move or Max Guard
  const BANNED_Z = ['Breakneck Blitz', 'All-Out Pummeling', 'Supersonic Skystrike', 'Acid Downpour', 'Tectonic Rage', 'Continental Crush', 'Savage Spin-Out', 'Never-Ending Nightmare',
    'Corkscrew Crash', 'Inferno Overdrive', 'Hydro Vortex', 'Bloom Doom', 'Gigavolt Havoc', 'Shattered Psyche', 'Subzero Slammer', 'Devastating Drake', 'Black Hole Eclipse', 'Twinkle Tackle',
    'Catastropika', '10,000,000 Volt Thunderbolt', 'Stoked Sparksurfer', 'Pulverizing Pancake', 'Sinister Arrow Raid', 'Malicious Moonsault', 'Oceanic Operetta', "Let's Snuggle Forever",
    'Clangorous Soulblaze', 'Guardian of Alola', 'Searing Sunraze Smash', 'Menacing Moonraze Maelstrom', 'Soul-Stealing 7-Star Strike', 'Max Guard'];
  add('fix-minor/metronome-pool-excludes-every-z-move-and-max-guard', () => {
    const pool = new Set(lab({}).callablePool());
    const leaked = BANNED_Z.filter((n) => { const id = mid(n); return pool.has(id); });
    return eq([leaked, pool.size > 400, pool.has(mid('Flamethrower'))], [[], true, true]);
  });
  if (!opts.cheap) add('fix-minor/metronome-never-calls-a-z-move-in-1500-seeds', () => {
    const banned = new Set(BANNED_Z.map(mid));
    for (let seed = 1; seed <= 1500; seed++) {
      const b = lab({ a: A('Metronome'), seed });
      turn(b, MV(0), MV(0));
      for (const e of b.events) if (e.t === 'move-use' && e.called && banned.has(e.mv)) return `seed ${seed} called ${pack.moves[e.mv].name}`;
    }
    return true;
  });

  // ================================================================== B1 previewDamage is a pure function of the battle
  const stateKey = (b) => [b.hash(), b.logHash(), b.events.length, b.s.rng, J(b.choiceLog)].join('|');
  add('fix-b1/preview-of-present-magnitude-echoed-voice-struggle-changes-nothing', () => {
    const b = lab({ a: { moves: ['Present', 'Magnitude', 'Echoed Voice', 'Struggle'] }, b: { hp: 10 } });
    const k0 = stateKey(b);
    const got = ['Present', 'Magnitude', 'Echoed Voice', 'Struggle'].map((n) => { const v = b.previewDamage(0, mid(n), { roll: 0 }); return v; });
    return eq([stateKey(b) === k0, got.every((v) => Number.isInteger(v) && v > 0), b.s.sides[1].team[0].hp, b.s.sides[0].ev], [true, true, 10, undefined]);
  });
  // two identical battles, only one previewed, must hash identically after the same turn (the lockstep desync Ever-B found)
  add('fix-b1/a-previewed-battle-and-an-unpreviewed-twin-stay-in-lockstep', () => {
    for (const n of ['Present', 'Magnitude', 'Echoed Voice', 'Struggle', 'Pound']) {
      const mk = () => lab({ a: { moves: [n] }, seed: 42 });
      const x = mk(), y = mk();
      y.previewDamage(0, mid(n), { roll: 3, crit: true }); y.previewDamage(1, mid(n));
      for (const b of [x, y]) { b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); }
      if (x.hash() !== y.hash() || x.logHash() !== y.logHash()) return `${n}: ${x.hash()} vs ${y.hash()}`;
    }
    return true;
  });
  // Present expected power 65: floor(22*65*100/100/50)+2 = 30 ; Magnitude 71: floor(22*71/50)+2 = 33 ; Echoed Voice first use 40: 19
  add('fix-b1/preview-uses-the-documented-expected-power', () => {
    const b = lab({ a: { moves: ['Splash'] } }); // the preview takes any move id, the user need not know it
    const v = (n, o) => b.previewDamage(0, mid(n), o || { roll: 0 });
    return eq([v('Present'), v('Magnitude'), v('Echoed Voice'), v('Seismic Toss'), v('Splash'), v('Fissure'), v('Psywave'), v('Sonic Boom'), v('Present', { roll: 15 }) < v('Present')], [30, 33, 19, 50, 0, 200, 50, 20, true]);
  });
  add('fix-b1/preview-never-heals-the-foe-and-never-writes-an-event', () => {
    for (let seed = 1; seed < 60; seed++) {
      const b = lab({ a: { moves: ['Present'] }, b: { hp: 10 }, seed });
      const n0 = b.events.length;
      b.previewDamage(0, mid('Present'), { roll: 0 });
      if (b.s.sides[1].team[0].hp !== 10 || b.events.length !== n0) return `seed ${seed}`;
    }
    return true;
  });
  add('fix-b1/preview-bad-arguments-throw-engine-errors', () => {
    const b = lab({});
    return eq([errOf(() => b.previewDamage(0, 99999)), errOf(() => b.previewDamage(0, 'x')), errOf(() => b.previewDamage(2, mid('Pound'))), errOf(() => b.previewDamage(0, null))], Array(4).fill('EngineError:bad-argument'));
  });
  if (!opts.cheap) add('fix-b1/preview-of-every-supported-move-changes-no-state-hash', () => {
    const sup = R.engineSupports(pack);
    const rnd = DG.makePrng(2024);
    for (let bi = 0; bi < 2; bi++) {
      const live = E.createBattle({ pack, ruleset: RS, teams: [DG.randomTeam(pack, rnd, 3), DG.randomTeam(pack, rnd, 3)], seed: 7 + bi, validate: false });
      for (let t = 0; t < 2 * bi && live.winner === null; t++) { // the second battle is previewed after two turns of play
        for (let sd = 0; sd < 2; sd++) { const r = live.requests()[sd]; if (r.phase === 'move') live.choose(sd, { kind: 'move', slot: r.moves.find((m) => !m.disabled).slot }); else if (r.phase === 'switch') live.choose(sd, { kind: 'switch', slot: r.switches[0].slot }); }
        live.advance();
      }
      const k0 = stateKey(live);
      for (const id of sup.moveList) for (let sd = 0; sd < 2; sd++) {
        const v = live.previewDamage(sd, id, { roll: id % 16, crit: id % 3 === 0 });
        if (!Number.isInteger(v) || v < 0) return `move ${id}: returned ${v}`;
        if (stateKey(live) !== k0) return `move ${id} (${pack.moves[id].name}) side ${sd} changed the battle`;
      }
    }
    return true;
  });

  // ================================================================== B2 replay equals the live battle for every phase mix, forfeits included
  const sameAsLive = (b, mk) => {
    const rp = E.replay({ pack, ruleset: RS, ...mk(), choiceLog: b.choiceLog, validate: false });
    return rp.hash === b.hash() && J(rp.events) === J(b.events) ? true : `live ${b.hash()} replay ${rp.hash}; events equal ${J(rp.events) === J(b.events)}`;
  };
  const mkTeams = (a, bb, seed) => () => ({ teams: [a.map((m) => Object.assign(R.blankRec(m.species || 25, pack, RS), { moves: m.moves.map(mid) })), bb.map((m) => Object.assign(R.blankRec(m.species || 25, pack, RS), { moves: m.moves.map(mid) }))], seed });
  const T2 = mkTeams([{ moves: ['Pound'] }, { moves: ['Splash'] }], [{ moves: ['Pound'] }, { moves: ['Splash'] }], 9);
  const live = (mk, f) => { const o = mk(); const b = E.createBattle({ pack, ruleset: RS, teams: o.teams, seed: o.seed, validate: false }); f(b); return b; };
  add('fix-b2/forfeit-then-the-opponents-move-replays', () => { const b = live(T2, (x) => { x.choose(0, FORFEIT); x.choose(1, MV(0)); x.advance(); }); return eq([b.winner, b.choiceLog.length], [1, 2]) === true ? sameAsLive(b, T2) : 'live not as expected'; });
  add('fix-b2/the-opponents-move-then-a-forfeit-replays', () => { const b = live(T2, (x) => { x.choose(1, MV(0)); x.choose(0, FORFEIT); x.advance(); }); return b.winner === 1 ? sameAsLive(b, T2) : 'winner ' + b.winner; });
  add('fix-b2/both-forfeit-is-a-draw-and-replays', () => { const b = live(T2, (x) => { x.choose(0, FORFEIT); x.choose(1, FORFEIT); x.advance(); }); return b.winner === -1 ? sameAsLive(b, T2) : 'winner ' + b.winner; });
  // the waiting side forfeits during a faint replacement: the replacement is resolved FIRST (as a driver that advances when ready), then the forfeit
  add('fix-b2/a-waiting-side-forfeits-in-a-faint-switch-phase', () => {
    const mk = mkTeams([{ species: 292, moves: ['Splash'] }, { moves: ['Splash'] }], [{ species: 150, moves: ['Shadow Ball'] }, { species: 144, moves: ['Splash'] }], 3);
    const b = live(mk, (x) => {
      x.choose(0, MV(0)); x.choose(1, MV(0)); x.advance();
      if (x.requests()[0].phase !== 'switch' || x.requests()[1].phase !== 'wait') throw new Error('setup: ' + x.requests().map((r) => r.phase));
      x.choose(0, SW(1)); x.choose(1, FORFEIT); x.advance();
    });
    return b.winner === 0 && b.turn === 2 ? sameAsLive(b, mk) : `winner ${b.winner} turn ${b.turn}`;
  });
  add('fix-b2/forfeit-after-the-eager-advance-gives-the-same-state-as-forfeit-before-it', () => {
    // driver A advances as soon as ready(); driver B lets the forfeit arrive first. The log is identical, so the end states must be too.
    const mk = mkTeams([{ species: 292, moves: ['Splash'] }, { moves: ['Splash'] }], [{ species: 150, moves: ['Shadow Ball'] }, { species: 144, moves: ['Splash'] }], 3);
    const eager = live(mk, (x) => { x.choose(0, MV(0)); x.choose(1, MV(0)); x.advance(); x.choose(0, SW(1)); x.advance(); x.choose(1, FORFEIT); x.advance(); });
    const lazy = live(mk, (x) => { x.choose(0, MV(0)); x.choose(1, MV(0)); x.advance(); x.choose(0, SW(1)); x.choose(1, FORFEIT); x.advance(); });
    return eq([eager.hash() === lazy.hash(), J(eager.choiceLog) === J(lazy.choiceLog)], [true, true]);
  });
  add('fix-b2/a-locked-side-can-forfeit-and-the-request-says-so', () => {
    const b = lab({ a: { moves: ['Solar Beam'] }, b: { moves: ['Splash'] } });
    turn(b, MV(0), MV(0)); // turn 1: A charges
    const rq = b.requests();
    const r1 = b.choose(0, FORFEIT);
    const ok = [rq[0].phase, rq[0].locked, rq[0].canForfeit, r1.ok, b.choose(1, MV(0)).ok];
    b.advance();
    return eq([ok, b.winner], [['wait', true, true, true, true], 1]);
  });
  add('fix-b2/canForfeit-is-false-once-a-real-choice-was-made', () => {
    const b = lab({});
    const before = b.requests()[0].canForfeit;
    b.choose(0, MV(0));
    return eq([before, b.requests()[0].canForfeit, b.requests()[1].canForfeit, b.choose(0, FORFEIT).code], [true, false, true, 'already-chosen']);
  });
  // both sides locked: advance() runs the locked turn by itself and stops where a choice is needed
  add('fix-minor/advance-runs-turns-in-which-nobody-has-a-choice', () => {
    const b = lab({ a: { moves: ['Solar Beam'] }, b: { moves: ['Solar Beam'] } });
    b.choose(0, MV(0)); b.choose(1, MV(0));
    const ev = b.advance();
    const rq = b.requests();
    return eq([b.turn, b.ready(), rq.map((r) => r.phase), of(ev, 'turn').map((e) => e.n)], [3, false, ['move', 'move'], [2, 3]]);
  });
  if (!opts.cheap) add('fix-b2/replay-equals-live-for-random-drivers-with-random-forfeits', () => {
    let forfeits = 0, ok = 0;
    for (let bi = 0; bi < 90; bi++) {
      const rnd = DG.makePrng(0xf0f0 + bi * 7);
      const A3 = DG.randomTeam(pack, rnd, 1 + rnd(3)), B3 = DG.randomTeam(pack, rnd, 1 + rnd(3));
      const seed = rnd(1 << 30);
      const b = E.createBattle({ pack, ruleset: RS, teams: [A3, B3], seed, validate: false });
      let guard = 0;
      while (b.winner === null && guard++ < 400) {
        const sides = rnd(2) ? [0, 1] : [1, 0];
        for (const s of sides) {
          const r = b.requests()[s];
          if (b.winner !== null) break;
          if (r.canForfeit && rnd(40) === 0) { if (b.choose(s, FORFEIT).ok) forfeits++; }
          else if (r.phase === 'move') { const okm = r.moves.filter((m) => !m.disabled); if (r.switches.length && rnd(8) === 0) b.choose(s, SW(r.switches[rnd(r.switches.length)].slot)); else b.choose(s, MV(okm[rnd(okm.length)].slot)); }
          else if (r.phase === 'switch') b.choose(s, SW(r.switches[rnd(r.switches.length)].slot));
          if (rnd(3) === 0 && b.ready()) b.advance(); // sometimes advance the moment it is ready, sometimes later
        }
        if (b.ready()) b.advance();
      }
      const rp = E.replay({ pack, ruleset: RS, teams: [A3, B3], seed, choiceLog: b.choiceLog, validate: false });
      if (rp.hash !== b.hash() || J(rp.events) !== J(b.events)) return `battle ${bi}: replay differs (live ${b.hash()} replay ${rp.hash}) log ${J(b.choiceLog).slice(-200)}`;
      ok++;
    }
    return forfeits >= 15 ? true : `only ${forfeits} forfeits exercised (${ok} battles)`;
  });

  // ================================================================== B3 restoreBattle refuses every malformed snapshot with a named error
  const base = () => { const b = lab({ a: { moves: ['Pound', 'Flamethrower'], bench: [A('Pound')] }, b: { moves: ['Pound'], bench: [A('Pound')] }, seed: 5 }); turn(b, MV(0), MV(0), [1, 0, 1, 0]); return b.snapshot(); };
  const tamper = (f) => { const s = JSON.parse(JSON.stringify(base())); delete s.hash; f(s); return errOf(() => E.restoreBattle(s, { pack })); };
  const BAD = {
    'hp below zero': (s) => { s.s.sides[0].team[0].hp = -5; },
    'hp above max': (s) => { s.s.sides[0].team[0].hp = 1e9; },
    'hp not a number': (s) => { s.s.sides[0].team[0].hp = null; },
    'fnt flag lies': (s) => { s.s.sides[0].team[0].fnt = 1; },
    'status on a fainted mon': (s) => { const m = s.s.sides[1].team[0]; m.hp = 0; m.fnt = 1; m.s = 2; },
    'active slot out of range': (s) => { s.s.sides[0].act = 99; },
    'species not in the pack': (s) => { s.s.sides[0].team[0].sp = 99999; },
    'move id not in the pack': (s) => { s.s.sides[0].team[0].mv[0].id = 99999; },
    'pp above max': (s) => { s.s.sides[0].team[0].mv[0].pp = 9999; },
    'one side missing': (s) => { s.s.sides.pop(); },
    'unknown phase': (s) => { s.s.phase = 'zzz'; },
    'rng a string': (s) => { s.s.rng = 'abc'; },
    'weather id out of range': (s) => { s.s.wx[0] = 99; },
    'stage out of range': (s) => { s.s.sides[0].team[0].sg.atk = 9; },
    'unknown volatile': (s) => { s.s.sides[0].team[0].v.bogus = 1; },
    'unknown state field': (s) => { s.s.evil = 1; },
    '__proto__ key': (s) => { Object.defineProperty(s.s, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true }); },
    'state is null': (s) => { s.s = null; },
    'state is empty': (s) => { s.s = {}; },
    'winner without end': (s) => { s.s.winner = 0; },
    'mark beyond the log': (s) => { s.mark = s.events.length + 5; },
    'event with an unknown code': (s) => { s.events.push({ t: 'bogus' }); },
    'choice log entry is not a choice': (s) => { s.log.push({ s: 0, c: { kind: 'dance' } }); },
    'turn above the cap': (s) => { s.s.turn = 5000; },
    'hazard layers out of range': (s) => { s.s.sides[0].hz.sp = 9; },
    'item id out of range': (s) => { s.s.sides[0].team[0].it = 99999; },
    'seed above u32': (s) => { s.s.seed = 2 ** 40; },
    'another ruleset id in the envelope': (s) => { s.ruleset = 'strict-champions'; },
  };
  for (const [name, f] of Object.entries(BAD)) add(`fix-b3/restore-refuses-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, () => { const r = tamper(f); return r === 'EngineError:snapshot-invalid' ? true : r; });
  add('fix-b3/restore-without-options-or-with-a-bad-pack-or-a-bad-snapshot-type-is-an-engine-error', () => {
    const s = base();
    return eq([errOf(() => E.restoreBattle(s)), errOf(() => E.restoreBattle(s, {})), errOf(() => E.restoreBattle(s, { pack: {} })), errOf(() => E.restoreBattle(null, { pack })), errOf(() => E.restoreBattle(undefined, { pack })), errOf(() => E.restoreBattle('x', { pack })), errOf(() => E.restoreBattle(5, { pack })),
      errOf(() => E.restoreBattle({ ...s, v: 99 }, { pack }))], ['EngineError:bad-argument', 'EngineError:bad-argument', 'EngineError:pack-invalid', 'EngineError:snapshot-invalid', 'EngineError:snapshot-invalid', 'EngineError:snapshot-invalid', 'EngineError:snapshot-invalid', 'EngineError:snapshot-version']);
  });
  add('fix-b3/a-tampered-state-with-an-old-hash-is-refused-even-when-every-range-is-valid', () => {
    const s = JSON.parse(JSON.stringify(base()));
    s.s.sides[0].team[0].hp -= 1; // still a legal value, but the hash no longer matches
    return eq(errOf(() => E.restoreBattle(s, { pack })), 'EngineError:snapshot-invalid');
  });
  add('fix-b3/restore-never-aliases-or-changes-its-input-and-a-good-snapshot-round-trips', () => {
    const s = base(), copy = J(s);
    const b = E.restoreBattle(s, { pack });
    b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance();
    return eq([J(s) === copy, b.turn, E.restoreBattle(JSON.parse(copy), { pack }).hash() === JSON.parse(copy).hash], [true, 3, true]);
  });
  add('fix-b3/a-snapshot-made-with-another-pack-is-refused', () => {
    const bad = JSON.parse(JSON.stringify(pack));
    bad.typeChart[T.FIRE][T.GRASS] = 4096;
    return eq([errOf(() => E.restoreBattle(base(), { pack: bad })), E.restoreBattle(base(), { pack: JSON.parse(JSON.stringify(pack)) }).turn], ['EngineError:snapshot-rom', 2]);
  });
  add('fix-b3/stepBattle-with-a-bad-snapshot-or-bad-choices-is-an-engine-error', () => {
    const s = base();
    return eq([errOf(() => E.stepBattle(s, null, { pack })), errOf(() => E.stepBattle(s, [MV(9), null], { pack })), errOf(() => E.stepBattle({}, [null, null], { pack })), errOf(() => E.stepBattle(s, [MV(0), MV(0)], { pack }))], ['EngineError:bad-argument', 'EngineError:step-rejected', 'EngineError:snapshot-version', 'no error']);
  });
  add('fix-b3/snapshot-carries-the-log-the-fingerprint-and-the-hash', () => {
    const b = lab({ a: { moves: ['Pound'] }, seed: 5 });
    turn(b, MV(0), MV(0), NC);
    const s = b.snapshot();
    const r = E.restoreBattle(s, { pack });
    return eq([J(s.log) === J(b.choiceLog), s.log.length, typeof s.packFp, s.packFp.length, s.hash === b.hash(), J(r.choiceLog) === J(b.choiceLog), J(r.events) === J(b.events)], [true, 2, 'string', 16, true, true, true]);
  });

  // ================================================================== TypeError -> EngineError
  const recOf = (n, moves) => Object.assign(R.blankRec(n || 25, pack, RS), moves ? { moves } : {});
  const create = (a, b, extra) => () => E.createBattle({ pack, ruleset: RS, teams: [a, b], seed: 1, ...(extra || {}) });
  add('fix-minor/bad-team-records-are-engine-errors-not-type-errors', () => {
    const ok = recOf(25);
    const v = [errOf(create([null], [ok])), errOf(create([undefined], [ok])), errOf(create([5], [ok])), errOf(create([{ ...ok, moves: 'Pound' }], [ok])), errOf(create([{ ...ok, moves: [null] }], [ok])), errOf(create([{ ...ok, moves: [{}] }], [ok])),
      errOf(create([{ ...ok, moves: [99999] }], [ok])), errOf(create([{ ...ok, moves: [] }], [ok])), errOf(create([{ ...ok, species: 'x' }], [ok])), errOf(create([{ ...ok, species: 99999 }], [ok])), errOf(create([ok], [ok], { validate: false, teams: [[{ ...ok, moves: [null] }], [ok]] }))];
    return v.every((x) => x.startsWith('EngineError:')) ? true : J(v);
  });
  add('fix-minor/createBattle-without-options-or-teams-is-an-engine-error', () => eq([errOf(() => E.createBattle()), errOf(() => E.createBattle({})), errOf(() => E.createBattle({ pack })), errOf(() => E.createBattle({ pack, teams: [[recOf(25)]] })), errOf(() => E.createBattle({ pack, teams: 5 }))],
    ['EngineError:bad-argument', 'EngineError:pack-invalid', 'EngineError:bad-argument', 'EngineError:bad-argument', 'EngineError:bad-argument']));
  add('fix-minor/a-move-the-engine-cannot-run-is-refused-even-with-validate-false', () => {
    const ids0 = Object.keys(M.engine_support.engineSupport(pack).moveReasons);
    if (ids0.length === 0) return true;
    const mimic = Number(ids0[0]);   // any move the engine cannot run
    return eq(errOf(create([recOf(150, [mimic])], [recOf(25)], { validate: false })), 'EngineError:team-invalid');
  });
  add('fix-minor/a-hostile-seed-or-name-is-an-engine-error-or-coerced', () => eq([errOf(() => E.createBattle({ pack, ruleset: RS, teams: [[recOf(25)], [recOf(25)]], seed: 5n })), errOf(() => E.createBattle({ pack, ruleset: RS, teams: [[recOf(25)], [recOf(25)]], seed: 1, names: [{ toString() { throw new Error('boom'); } }, 'b'] })), errOf(() => E.createBattle({ pack, ruleset: RS, teams: [[recOf(25)], [recOf(25)]], seed: 'abc' }))],
    ['EngineError:bad-argument', 'EngineError:bad-argument', 'no error']));
  add('fix-minor/a-throwing-or-shape-shifting-choice-is-refused-or-read-once', () => {
    const b = lab({ a: { moves: ['Pound', 'Flamethrower'], bench } });
    const boom = { get kind() { throw new Error('boom'); } };
    const prox = new Proxy({}, { get() { throw new Error('proxy boom'); }, ownKeys() { throw new Error('proxy boom'); } });
    let reads = 0;
    const shifty = { get kind() { reads++; return reads === 1 ? 'move' : 'forfeit'; }, get slot() { return 1; } };
    const r = [b.choose(0, boom).code, b.choose(0, prox).code, b.choose(0, shifty)];
    return eq([r[0], r[1], r[2].ok, b.s.sides[0].ch, reads], ['bad-choice', 'bad-choice', true, { kind: 'move', slot: 1, mv: mid('Flamethrower') }, 1]);
  });
  add('fix-minor/preview-order-array-is-copied-when-accepted', () => {
    const six = { moves: ['Pound'], bench: [A('Pound'), A('Pound'), A('Pound'), A('Pound'), A('Pound')] };
    const b = lab({ a: six, b: six, pick: 3 });
    const order = [4, 2, 5];
    const r = b.choose(0, { kind: 'preview', order });
    order[0] = 0;
    return eq([r.ok, b.s.sides[0].ch.order], [true, [4, 2, 5]]);
  });

  // ================================================================== corrupted packs are refused with a named error
  add('fix-minor/a-corrupted-pack-is-refused-with-pack-invalid', () => {
    const cl = () => JSON.parse(JSON.stringify(pack));
    const cases = [
      (p) => { p.moves[mid('Tackle')].type = 25; }, (p) => { p.moves[mid('Tackle')].category = 4; }, (p) => { p.typeChart[3][4] = 100000; }, (p) => { p.typeChart.length = 10; },
      (p) => { p.species[25].types = [30, 1]; }, (p) => { p.moves[mid('Tackle')].bytes = [1]; }, (p) => { p.moves[mid('Tackle')].additional = 'x'; }, (p) => { p.species = null; },
      (p) => { p.items[5].holdEffect = -1; }, (p) => { p.moves[mid('Tackle')].power = 'high'; },
    ];
    const got = cases.map((f) => { const p = cl(); f(p); return errOf(() => E.createBattle({ pack: p, ruleset: RS, teams: [[recOf(25)], [recOf(25)]], seed: 1, validate: false })); });
    return got.every((x) => x === 'EngineError:pack-invalid') ? true : J(got);
  });
  add('fix-minor/the-real-pack-and-a-json-clone-of-it-both-validate', () => eq([errOf(create([recOf(25)], [recOf(25)])), errOf(() => E.createBattle({ pack: JSON.parse(JSON.stringify(pack)), ruleset: RS, teams: [[recOf(25)], [recOf(25)]], seed: 1, validate: false }))], ['no error', 'no error']));

  // ================================================================== information model
  add('fix-minor/viewFor-shows-the-whole-foe-team-during-team-preview-and-hides-the-bench-afterwards', () => {
    const six = { moves: ['Pound'], bench: [A('Pound'), A('Pound'), A('Pound'), A('Pound'), A('Pound')] };
    const b = lab({ a: six, b: six, pick: 3 });
    const pre = b.viewFor(0).foe.team;
    b.choose(0, { kind: 'preview', order: [0, 1, 2] }); b.choose(1, { kind: 'preview', order: [3, 4, 5] }); b.advance();
    const post = b.viewFor(0).foe.team;
    return eq([pre.length, pre.filter((m) => m.hidden).length, pre.every((m) => m.sp > 0), post.length, post.filter((m) => m.hidden).length], [6, 0, true, 3, 2]);
  });

  // ================================================================== D8 the checks that kill the surviving mutants
  // Sturdy: only from FULL hp. A 10-HP target hit for 19: at 10/10 it survives with 1 (Sturdy), at 9/10 it faints.
  add('ability/sturdy-does-nothing-below-full-hp', () => {
    const full = run({ a: A('Pound'), b: { ab: 'Sturdy', hp: 10, mhp: 10 } }, { rng: NC });
    const part = run({ a: A('Pound'), b: { ab: 'Sturdy', hp: 9, mhp: 10 } }, { rng: NC });
    return eq([full.B.hp, part.B.hp, part.B.fnt], [1, 0, 1]);
  });
  add('item/focus-sash-does-nothing-below-full-hp-and-is-consumed-at-full', () => {
    const full = run({ a: A('Pound'), b: { it: 'Focus Sash', hp: 10, mhp: 10 } }, { rng: NC });
    const part = run({ a: A('Pound'), b: { it: 'Focus Sash', hp: 9, mhp: 10 } }, { rng: NC });
    return eq([full.B.hp, full.B.it, part.B.hp, part.B.it !== 0], [1, 0, 0, true]);
  });
  // Multiscale halves damage only at FULL hp: Earthquake 46 -> pokeMod(46, 2048) = 23 at 200/200, 46 at 199/200
  add('ability/multiscale-halves-only-at-full-hp', () => {
    const full = run({ a: A('Earthquake'), b: { ab: 'Multiscale' } }, { rng: NC });
    const part = run({ a: A('Earthquake'), b: { ab: 'Multiscale', hp: 199 } }, { rng: NC });
    return eq([dmgOf(full.ev, 1), dmgOf(part.ev, 1)], [23, 46]);
  });
  // Fur Coat doubles Defense: floor(22*100*100/200/50)+2 = 24 (a 1.5x coat would give floor(22*100*100/150/50)+2 = 31)
  add('ability/fur-coat-doubles-defense', () => eq(dmgOf(run({ a: A('Earthquake'), b: { ab: 'Fur Coat' } }, { rng: NC }).ev, 1), 24));
  // Ice Beam gives FROSTBITE 10% (round 3: the hack's Ice moves never freeze, MEASURED); under harsh sunlight it cannot land, without sun the same roll does (ST.FBT = 7)
  add('status/harsh-sunlight-blocks-freezing', () => {
    const sun = run({ a: A('Ice Beam'), wx: [2, 5] }, { rng: [1, 0, 0] });
    const none = run({ a: A('Ice Beam') }, { rng: [1, 0, 0] });
    return eq([sun.B.s, none.B.s], [0, 7]);
  });
  // frostbite: 1/16 residual, the holder's special damage halved, physical untouched, Ice types and Magma Armor immune (all MEASURED, ROMDIFF.md 8.1)
  add('fa3/frostbite-residual-halves-special-and-spares-ice-types', () => {
    const r = run({ a: A('Splash', { s: 7 }) });
    const sp = hitOfRun({ a: A('Flamethrower', { s: 7 }) }), sp0 = hitOfRun({ a: A('Flamethrower') }), ph = hitOfRun({ a: A('Pound', { s: 7 }) }, [1, 0]), ph0 = hitOfRun({ a: A('Pound') }, [1, 0]);
    const ice = run({ a: A('Ice Beam'), b: { ty: [T.ICE] } }, { rng: [1, 0, 0] }), ma = run({ a: A('Ice Beam'), b: { ab: 'Magma Armor' } }, { rng: [1, 0, 0] });
    return eq([lost(r.ev, 0, 'fbt'), sp < sp0 && sp === Math.floor(sp0 / 2), ph === ph0, ice.B.s, ma.B.s], [12, true, true, 0, 0]);
  });
  // Sandstorm raises a Rock type's Sp.Def x1.5: Psychic BP90 special vs Rock: A = 100, D = pokeMod(100, 6144) = 150: floor(22*90*100/150/50)+2 = 28 (no sand: 41; a x2 boost would give 21)
  add('weather/sandstorm-raises-rock-sp-def-by-one-and-a-half', () => {
    const sand = run({ a: A('Psychic'), b: { ty: [T.ROCK] }, wx: [3, 5] }, { rng: [1, 0, 99] });
    const none = run({ a: A('Psychic'), b: { ty: [T.ROCK] } }, { rng: [1, 0, 99] });
    return eq([dmgOf(sand.ev, 1), dmgOf(none.ev, 1)], [28, 41]);
  });
  // Wrap-style trapping: 1/8 max HP per turn (200 -> 25), and the timer runs out at t < 0 without a last tick
  add('status/trap-residual-is-an-eighth-and-ends-on-schedule', () => {
    const r = run({ a: A('Splash'), b: { v: { trap: { t: 1, src: 0, var: 0 } } } }, { rng: [] });
    const r2 = run({ a: A('Splash'), b: { v: { trap: { t: 0, src: 0, var: 0 } } } }, { rng: [] });
    return eq([lost(r.ev, 1, 'trap'), r.B.v.trap && r.B.v.trap.t, lost(r2.ev, 1, 'trap'), r2.B.v.trap], [25, 0, 0, undefined]);
  });
  // Sitrus Berry: at or below half HP it restores a quarter (50 of 200) and is consumed; Dragon Rage deals exactly 40
  add('item/sitrus-triggers-at-half-hp-and-heals-a-quarter', () => {
    const edge = run({ a: A('Dragon Rage'), b: { it: 'Sitrus Berry', hp: 140 } }, { rng: [] }); // 140-40 = 100 = half -> triggers
    const above = run({ a: A('Dragon Rage'), b: { it: 'Sitrus Berry', hp: 141 } }, { rng: [] }); // 101 > half -> no
    return eq([edge.B.hp, edge.B.it, above.B.hp, above.B.it !== 0], [150, 0, 101, true]);
  });
  add('item/oran-berry-heals-ten-at-half-hp', () => eq(run({ a: A('Dragon Rage'), b: { it: 'Oran Berry', hp: 130 } }, { rng: [] }).B.hp, 100));

  // ================================================================== the API contract that the mutants of the robustness verifier broke
  add('api/a-side-with-nothing-to-choose-gets-not-needed', () => {
    const b = lab({ a: { moves: ['Pound'] }, b: { hp: 1, bench: [A('Pound')] } });
    turn(b, MV(0), MV(0), NC); // B faints; only B must pick a replacement
    return eq([b.requests().map((r) => r.phase), b.choose(0, MV(0)).code, b.choose(0, SW(0)).code], [['wait', 'switch'], 'not-needed', 'not-needed']);
  });
  add('api/struggle-slot-is-refused-while-a-move-has-pp', () => {
    const b = lab({ a: { moves: ['Pound'] } });
    return eq([b.choose(0, MV(4)).code, b.requests()[0].moves.map((m) => m.slot)], ['bad-slot', [0]]);
  });
  // The turn cap is the literal 300 (not read back from the module under test): turn 299 plays on, turn 300 is the last
  add('api/turn-cap-is-exactly-300', () => {
    const b = lab({});
    b.s.turn = 299;
    turn(b, MV(0), MV(0)); // resolves turn 299 and opens turn 300
    const mid1 = [b.turn, b.winner, of(b.events, 'turn-cap').length];
    const ev = turn(b, MV(0), MV(0)); // resolves turn 300; the next turn would be 301
    return eq([mid1, b.winner, of(ev, 'turn-cap').map((e) => e.n), E.MECHANICS.find((m) => m.name === 'turnCap').value], [[300, null, 0], -1, [300], 300]);
  });
  // ================================================================== crit odds: decoded from the ROM (file offsets; nothing executed)
  const u32 = (o) => rom.readUInt32LE(o), u16 = (o) => rom.readUInt16LE(o);
  const table5 = (o) => [0, 1, 2, 3, 4].map((i) => u32(o + 4 * i));
  add('rom-static/crit-odds-tables-and-config-byte-match-the-ROM', () => eq([table5(0x476b7c), table5(0x476b90), table5(0x476ba4), table5(0x476bb8), rom[0x64b40c]], [[24, 8, 2, 1, 1], [16, 8, 2, 1, 1], [17, 32, 64, 85, 128], [16, 8, 4, 3, 2], 8]));
  // the routine at 0xe7a7c indexes base 0x08476b3c + stage*4 and loads +64 (>5), +84 (==5), +104 (==1), +124 (otherwise); GetConfig (0x1731a0) reads [0x0864b40c + id]
  add('rom-static/crit-dispatch-code-selects-the-gen7-table-for-the-ROM-config-byte', () => {
    const code = [u16(0xe7a82), u16(0xe7ae0), u16(0xe7ae4), u16(0xe7ac6), u16(0xe7a78), u16(0xe7ab2), u16(0xe7ac2)];
    return eq([code, u32(0xe7af0), u32(0x1731b0), u16(0x1731a4)], [[0x6c1b, 0x6d5b, 0x6e9b, 0x6fdb, 0x2805, 0x2805, 0x2801], 0x08476b3c, 0x0864b40c, 0x2bce]);
  });
  add('rom-static/the-engine-crit-odds-are-the-gen7-table-up-to-stage-3', () => {
    const odds = M.engine_data.E.critOdds, row = M.engine_data.MECHANICS.find((m) => m.name === 'critOdds');
    return eq([J(odds), row.source, J(row.value)], [J(table5(0x476b7c).slice(0, 4)), 'rom-static', J(odds)]);
  });
  // hash64 = two FNV-1a passes: the first half is the standard 32-bit FNV-1a (e40c292c for "a"), the second a different basis / prime
  add('api/hash64-known-vectors', () => eq(['', 'a', 'abc', 'pokemonarena', '{"a":1,"b":[1,2,3]}'].map((x) => E.hash64(x)), ['811c9dc59747b28c', 'e40c292c5c55b6ab', '1a47e90b0579bc6b', '048e3c7908a890af', 'e340019fef006868']));
  // after the team preview the picked members are renumbered 0..k-1 in pick order; a switch to slot 1 brings out the SECOND pick
  add('api/preview-renumbers-the-picked-team-slots', () => {
    const six = { moves: ['Pound'], bench: [A('Pound'), A('Pound'), A('Pound'), A('Pound'), A('Pound')] };
    const b = lab({ a: six, b: six, pick: 3 });
    b.choose(0, { kind: 'preview', order: [4, 2, 5] }); b.choose(1, { kind: 'preview', order: [1, 3, 0] }); b.advance();
    const slots = b.s.sides[0].team.map((m) => m.slot), orig = b.s.sides[0].team.map((m) => m.orig);
    const sw = b.requests()[0].switches.map((x) => x.slot);
    b.choose(0, SW(1)); b.choose(1, MV(0)); b.advance();
    return eq([slots, orig, sw, b.s.sides[0].team[b.s.sides[0].act].orig], [[0, 1, 2], [4, 2, 5], [1, 2], 2]);
  });
  // a preview must work on a battle whose state is deeply frozen: it may read, never write
  add('fix-b1/preview-works-on-a-deeply-frozen-battle', () => {
    const b = lab({ a: { moves: ['Present', 'Magnitude', 'Echoed Voice', 'Struggle'] }, b: { hp: 10 } });
    const freeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) freeze(o[k]); } return o; };
    freeze(b.s); freeze(b.events); freeze(b.choiceLog);
    const got = ['Present', 'Magnitude', 'Echoed Voice', 'Struggle', 'Pound', 'Seismic Toss'].map((n) => b.previewDamage(0, mid(n), { roll: 2 }));
    return got.every((v) => Number.isInteger(v) && v > 0) ? true : J(got);
  });
  add('api/snapshot-log-is-the-choice-log', () => {
    const b = lab({ a: { moves: ['Pound'] } });
    turn(b, MV(0), MV(0), NC); turn(b, MV(0), MV(0), NC);
    const s = b.snapshot();
    return eq([s.log.length, J(s.log) === J(b.choiceLog), s.log[0]], [4, true, { s: 0, c: { kind: 'move', slot: 0 } }]);
  });
  // ================================================================== FA2: fixes found by the differential against the real game (pokemonarena/ROMDIFF.md)
  // accuracy / evasion stage: the ROM multiplies by {33,36,43,50,60,75,100,133,166,200,233,266,300} percent and floors:
  // 100 -> 33 36 43 50 60 75 100 133 166 200 233 266 300 ; 75 at +1 = floor(75*133/100) = 99 (not 100) ; 90 at -5 = floor(90*36/100) = 32 ; 70 at +1 = 93
  add('fa2/accuracy-stage-table-is-the-ROM-one-and-floors', () => {
    const C = M.engine_calc;
    const row = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((s) => C.applyAccStage(100, s));
    return eq([row, C.applyAccStage(75, 1), C.applyAccStage(90, -5), C.applyAccStage(70, 1), C.applyAccStage(100, 9), C.applyAccStage(100, -9)], [[33, 36, 43, 50, 60, 75, 100, 133, 166, 200, 233, 266, 300], 99, 32, 93, 300, 33]);
  });
  add('fa2/accuracy-stage-row-is-labelled-as-measured-in-the-real-game', () => {
    const r = M.engine_data.MECHANICS.find((m) => m.name === 'accuracyStageRatio');
    return eq([r.source, J(r.value)], ['rom-live', J([33, 36, 43, 50, 60, 75, 100, 133, 166, 200, 233, 266, 300])]);
  });
  // a stage -4 attacker (accuracy 100 -> 43): rand(100) = 42 hits, 43 misses
  add('fa2/accuracy-minus-4-hits-below-43-and-misses-from-43', () => {
    const hit = run({ a: A('Pound', { sg: { acc: -4 } }) }, { rng: [42, 1, 0] });
    const miss = run({ a: A('Pound', { sg: { acc: -4 } }) }, { rng: [43] });
    return eq([of(hit.ev, 'miss').length, of(miss.ev, 'miss').length], [0, 1]);
  });
  // weather: 5 turns including the turn it was set; it deals damage at the end of turns 1-4 and ends WITHOUT damage at the end of turn 5.
  // sandstorm 1/16 of 200 = 12 per tick; counter 2 left -> tick, then ends on the next turn with no damage
  add('fa2/weather-ends-without-damage-on-its-last-turn', () => {
    const b = lab({ a: A('Splash'), b: A('Splash'), wx: [3, 2] });
    const e1 = turn(b, MV(0), MV(0));
    const h1 = [b.s.sides[0].team[0].hp, b.s.sides[1].team[0].hp];
    const e2 = turn(b, MV(0), MV(0));
    const h2 = [b.s.sides[0].team[0].hp, b.s.sides[1].team[0].hp];
    return eq([h1, h2, of(e1, 'weather-end').length, of(e2, 'weather-end').length, b.s.wx[0]], [[188, 188], [188, 188], 0, 1, 0]);
  });
  // Flame Orb: the burn is applied AFTER the end-of-turn status damage, so the first turn costs nothing; the next turn burns for 200/16 = 12
  add('fa2/flame-orb-burns-after-the-status-damage-of-the-same-turn', () => {
    const b = lab({ a: A('Splash', { it: 'Flame Orb' }), b: A('Splash') });
    turn(b, MV(0), MV(0));
    const m = b.s.sides[0].team[0], after1 = [m.s, m.hp];
    turn(b, MV(0), MV(0));
    return eq([after1, m.hp], [[3, 200], 188]);
  });
  // Toxic Orb: counter starts at 1: nothing on the turn it activates, then floor(200/16) = 12, then 2*12 = 24 (the ROM divides first, then multiplies by the counter)
  add('fa2/toxic-orb-first-damage-comes-the-turn-after', () => {
    const b = lab({ a: A('Splash', { it: 'Toxic Orb' }), b: A('Splash') });
    const hp = []; for (let i = 0; i < 3; i++) { turn(b, MV(0), MV(0)); hp.push(b.s.sides[0].team[0].hp); }
    return eq(hp, [200, 188, 164]);
  });
  // Wring Out / Crush Grip: power = max(1, floor(120 * hp / maxHP)) -- the ROM's maximum is 120, not 121 (measured against the real game: no value 121 or hp-8 power 6 fits)
  add('fa2/wring-out-power-is-floor-120-hp-over-max-min-1', () => {
    const K = M.engine_moves.MOVE_KINDS.wringout;
    const p = (hp, mhp) => K.power({ mv: { power: 120 }, target: { hp, mhp } });
    return eq([p(192, 192), p(96, 192), p(32, 192), p(8, 192), p(1, 6000), p(200, 200)], [120, 60, 20, 5, 1, 120]);
  });
  // dual-type effectiveness: the two multipliers are multiplied first, then applied once with half-down rounding (Normal Body Slam into Steel/Rock: 1024/4096)
  // D = 100: floor(100/4) = 25 either way; D = 27: perType floor(floor(27/2)/2) = 6, combined (27*1024+2047)>>12 = 7
  add('fa2/dual-type-multipliers-are-combined-before-rounding', () => {
    const C = M.engine_calc;
    return eq([C.pokeMod(27, C.typeProduct([2048, 2048])), C.pokeMod(100, C.typeProduct([8192, 2048])), C.pokeMod(27, C.typeProduct([8192, 8192])), C.pokeMod(27, C.typeProduct([0, 8192]))], [7, 100, 108, 0]);
  });
  // Body Slam BP 85, level 50, 100 vs 100, no STAB: base floor(22*85*100/100/50)+2 = 39; into Steel/Rock (0.5 and 0.5): combined 1024/4096 ->
  // (39*1024 + 2047) >> 12 = 10 (the old per-type floor gave floor(floor(39/2)/2) = 9); Fire Punch BP 75 into Grass/Water (2x and 0.5x) = x1: 35
  add('fa2/engine-applies-the-combined-dual-type-multiplier', () => {
    const b = lab({ a: { moves: ['Body Slam'], ty: [T.MYSTERY] }, b: { ty: [T.STEEL, T.ROCK] } });
    const c = lab({ a: { moves: ['Fire Punch'], ty: [T.MYSTERY] }, b: { ty: [T.GRASS, T.WATER] } });
    return eq([b.previewDamage(0, mid('Body Slam'), { roll: 0 }), c.previewDamage(0, mid('Fire Punch'), { roll: 0 })], [10, 35]);
  });
  // Life Orb is 5325/4096 (the ROM's UQ4.12 1.3, not the floored 5324): 100 -> floor((100*5325 + 2047) / 4096) = 130
  // the engine path: Pound level 50 BP 40 at Attack 74 vs Defense 100 = base 15; Life Orb 15 * 5325 / 4096 = 19.50 -> 20 (5324 would give 19)
  add('fa2/life-orb-modifier-is-5325', () => {
    const b = lab({ a: { moves: ['Pound'], st: { atk: 74 }, it: 'Life Orb' } });
    return eq([M.engine_data.E.lifeOrbMod, b.previewDamage(0, mid('Pound'), { roll: 0 })], [5325, 20]);
  });
  // toxic damage = floor(maxHP / 16) * counter (divide first): 411 -> 25, 50, 75 (not floor(411*2/16) = 51)
  add('fa2/toxic-divides-first-then-multiplies-by-the-counter', () => {
    const b = lab({ a: A('Splash', { hp: 411, mhp: 411, s: 6, sc: 1 }), b: A('Splash') });
    const hp = []; for (let i = 0; i < 3; i++) { turn(b, MV(0), MV(0)); hp.push(b.s.sides[0].team[0].hp); }
    return eq(hp, [386, 336, 261]);
  });
  // an HP-triggered berry also fires at the END of the turn when the holder is at or under its threshold without any damage that turn
  // (Sitrus at 100/200 = exactly 50 percent: eaten, +200/4 = 50)
  add('fa2/sitrus-at-exactly-half-is-eaten-at-end-of-turn', () => {
    const b = lab({ a: A('Splash', { it: 'Sitrus Berry', hp: 100 }), b: A('Splash') });
    turn(b, MV(0), MV(0));
    const m = b.s.sides[0].team[0];
    return eq([m.hp, m.it], [150, 0]);
  });
  add('fa2/sitrus-just-above-half-is-kept', () => {
    const b = lab({ a: A('Splash', { it: 'Sitrus Berry', hp: 101 }), b: A('Splash') });
    turn(b, MV(0), MV(0));
    const m = b.s.sides[0].team[0];
    return eq([m.hp, m.it === 0], [101, false]);
  });
  // confusion self-hit is 33 percent exactly: rand(100) 32 hits itself, 33 does not
  add('fa2/confusion-self-hit-threshold-is-33-of-100', () => {
    const hit = run({ a: A('Pound', { v: { conf: 3 } }) }, { rng: [32, 0] });
    const no = run({ a: A('Pound', { v: { conf: 3 } }) }, { rng: [33, 1, 0] });
    return eq([of(hit.ev, 'confusion-hit').length, of(no.ev, 'confusion-hit').length, no.B.hp < 200], [1, 0, true]);
  });
  // ================================================================== FA2 round 2: innate abilities (MEASURED in the real game, pokemonarena/ROMDIFF.md section 7)
  // level gate: slot 0/1/2 of the species record is active from battle level 75/85/95, so the default level 50 has none and +lv100 has all three
  const ZAP = pack.species.findIndex((x) => x && x.name === 'Zapdos');
  const zapBattle = (rsid) => { const rec = M.rules.blankRec(ZAP, pack, RS); rec.moves = [mid('Splash')]; return M.engine.createBattle({ pack, ruleset: rsid, teams: [[rec], [M.rules.blankRec(25, pack, RS)].map((r) => { r.moves = [mid('Splash')]; return r; })], seed: 1, validate: false }); };
  add('fa2/innate-level-gate-none-at-50-all-three-at-100', () => {
    const lo = zapBattle(RS).s.sides[0].team[0], hi = zapBattle(RS + '+lv100').s.sides[0].team[0];
    return eq([lo.inn, hi.inn, J(M.engine_data.E.innateLevels)], [undefined, pack.species[ZAP].innates.filter((x) => x), '[75,85,95]']);
  });
  add('fa2/innate-level-gate-is-75-85-95-exactly', () => { const g = (lv) => M.engine.activeInnates([11, 22, 33], lv); return eq([g(74), g(75), g(84), g(85), g(94), g(95), g(100), g(1)], [[], [11], [11], [11, 22], [11, 22], [11, 22, 33], [11, 22, 33], []]); });
  add('fa2/innate-same-hook-modifiers-multiply', () => eq(hitOf({ a: A('Pound', { ab: 'Huge Power', inn: ['Gorilla Tactics'] }) }), dmgBase(40, pm(100, 12288))));
  // type-boost abilities fit the ATTACK stat and not the base power: with Sp.Atk 191 and Sp.Def 113 the two readings differ by 1 HP (88 vs 89)
  add('fa2/ab-type-boost-acts-on-the-attack-stat-not-base-power', () => eq([hitOf({ a: A('Thunderbolt', { ab: 'Transistor', st: { spa: 191 } }), b: { st: { spd: 113 } } }), dmgBase(90, pm(191, 5325), 113) !== dmgBase(pm(90, 5325), 191, 113)], [dmgBase(90, pm(191, 5325), 113), true]));
  add('fa2/innate-level-gate-row-is-labelled-as-measured', () => {
    const r = M.engine_data.MECHANICS.find((m) => m.name === 'innateAbilities');
    return eq([r && r.source], ['rom-live']);
  });
  // Zapdos at level 100: Pressure (main) + innate Drizzle: the innate sets the rain at switch-in and its pop-up names Drizzle, flagged as an innate
  add('fa2/innate-drizzle-sets-rain-and-the-popup-is-flagged', () => {
    const b = zapBattle(RS + '+lv100');
    const ab = of(b.events, 'ability').filter((e) => e.fx === 'weather');   // Zapdos' main Pressure also announces itself at entry since round 5
    const drz = pack.abilities.findIndex((x) => x && x.name === 'Drizzle');
    return eq([b.s.wx[0], ab.length, ab[0] && ab[0].ab === drz, ab[0] && ab[0].inn, ab[0] && ab[0].fx], [1, 1, true, 1, 'weather']);
  });
  add('fa2/innate-reveals-only-that-ability-to-the-opponent', () => {
    const b = zapBattle(RS + '+lv100');
    const drz = pack.abilities.findIndex((x) => x && x.name === 'Drizzle');
    const v = b.viewFor(1).opp ? b.viewFor(1).opp : b.viewFor(1).foe;
    const rv = v && (v.activeDetail ? v.activeDetail.revealed : v.team[v.active].revealed);
    const pressure = pack.abilities.findIndex((x) => x && x.name === 'Pressure');   // its entry text (ROM 0x43fcb8) shows the main ability, as in the real game
    return eq([rv.ab, rv.inn], [pressure, [drz]]);
  });
  add('fa2/innate-state-round-trips-and-a-bad-innate-id-is-refused', () => {
    const b = zapBattle(RS + '+lv100');
    const snap = b.snapshot();
    const ok = M.engine.restoreBattle(J(snap) && JSON.parse(J(snap)), { pack });
    const bad = JSON.parse(J(snap)); bad.s.sides[0].team[0].inn = [999999];
    return eq([ok.hash() === b.hash(), errOf(() => M.engine.restoreBattle(bad, { pack }))], [true, 'EngineError:snapshot-invalid']);
  });
  // damage: innate Huge Power = main Huge Power ; the same ability from both sources counts once ; two different halvers multiply
  const eqk = (g) => (a, b) => eq(g(a), g(b));
  add('fa2/innate-huge-power-equals-main-huge-power', () => {
    const m = run({ a: A('Pound', { ab: 'Huge Power' }) }, { rng: NC }), i = run({ a: A('Pound', { inn: ['Huge Power'] }) }, { rng: NC }), n = run({ a: A('Pound') }, { rng: NC });
    return eq([lost(i.ev, 1), lost(m.ev, 1) === lost(i.ev, 1), lost(n.ev, 1) < lost(i.ev, 1)], [lost(m.ev, 1), true, true]);
  });
  // Flamethrower into a neutral 100/100 defender at level 50: 22*90*100/100/50 = 39, +2 = 41 ; Thick Fat halves the attack (A=50): 22*90*50/100/50 = 19, +2 = 21 ;
  // Heatproof halves the base power (45): 22*45/50 = 19, +2 = 21 ; both: 22*45*50/100/50 = 9, +2 = 11
  add('fa2/innate-halvers-multiply-and-the-same-ability-twice-counts-once', () => {
    const d = (def) => lost(run({ a: A('Flamethrower'), b: Object.assign({ moves: ['Splash'] }, def) }, { rng: [1, 0, 99] }).ev, 1);
    return eq([d({}), d({ ab: 'Thick Fat' }), d({ ab: 'Thick Fat', inn: ['Thick Fat'] }), d({ inn: ['Heatproof'] }), d({ ab: 'Thick Fat', inn: ['Heatproof'] })], [41, 21, 21, 21, 11]);
  });
  // the Prankster block on Dark targets and the +1 priority both see an innate Prankster
  add('fa2/innate-prankster-gets-priority-and-the-dark-block', () => {
    const b = lab({ a: A('Thunder Wave', { inn: ['Prankster'], st: { spe: 10 } }), b: A('Splash', { st: { spe: 200 } }) });
    const pr = b.priorityOf(b.act(0), b.move(mid('Thunder Wave')));
    const dark = run({ a: A('Thunder Wave', { inn: ['Prankster'] }), b: { ty: [T.DARK] } }, { rng: [] });
    return eq([pr, of(dark.ev, 'fail').length + of(dark.ev, 'immune').length > 0], [1, true]);
  });
  // an innate Mold Breaker ignores the defender's Thick Fat
  add('fa2/innate-mold-breaker-ignores-a-breakable-ability', () => {
    const d = (atk) => lost(run({ a: A('Flamethrower', atk), b: { moves: ['Splash'], ab: 'Thick Fat' } }, { rng: [1, 0, 99] }).ev, 1);
    return eq([d({}), d({ inn: ['Mold Breaker'] })], [21, 41]);
  });
  // switch-in order is one global order, not main-first: Intimidate and Drizzle act Drizzle first whichever slot holds which (MEASURED pairs: Zapdos, Kyogre, ...)
  add('fa2/innate-switch-in-order-is-global', () => {
    const order = (x) => { const b = lab({ a: A('Splash', x), b: A('Splash') }); const n = b.events.length; b.entry(0); return b.events.slice(n).filter((e) => e.t === 'ability').map((e) => e.fx); };
    return eq([order({ ab: 'Intimidate', inn: ['Drizzle'] }), order({ ab: 'Drizzle', inn: ['Intimidate'] })], [['weather', 'intimidate'], ['weather', 'intimidate']]);
  });
  add('fa2/switch-in-order-lists-the-measured-pairs', () => {
    const O = M.engine_exec.SWITCH_IN_ORDER, i = (n) => O.indexOf(n);
    const pairs = [['Glacial', 'Snow Warning'], ['Snow Warning', 'Pressure'], ['Drizzle', 'Pressure'], ['Air Lock', 'Pressure'], ['Cloud Nine', 'Drizzle'], ['Dark Aura', 'Pressure'], ['Pressure', 'Download'],
      ['Forewarn', 'Intimidate'], ['Forewarn', 'Trace'], ['Mold Breaker', 'Intimidate'], ['Unnerve', 'Intimidate'], ['Unnerve', 'Forewarn'], ['Psychic Surge', 'Forewarn'], ['Psychic Surge', 'Intimidate'], ['Psychic Surge', 'Uncanny'], ['Uncanny', 'Trace']];
    return eq(pairs.filter(([x, y]) => !(i(x) >= 0 && i(y) > i(x))), []);
  });
  // ================================================================== FA2 round 2: abilities and items added after probing the real game
  // The expectations are computed with an independent helper (not the engine's own functions): dmgBase(bp, A, D) = floor(floor(22*bp*A/D)/50)+2 at level 50, pm(v, m) = floor((v*m+2047)/4096).
  const pm = (v, m) => Math.floor((v * m + 2047) / 4096);
  const dmgBase = (bp, A = 100, D = 100) => Math.floor(Math.floor(22 * bp * A / D) / 50) + 2;
  // a battle whose RNG is scripted for its first draws and then answers "no crit, max roll, no chance effect": rand(16) = 0, rand(24) = 1, rand(100) = 99, anything else 0
  const prun = (spec, o = {}) => { const b = lab(spec); const sc = o.rng || []; let k = 0; b.rand = (n) => (k < sc.length ? sc[k++] : n === 16 ? 0 : n === 100 ? 99 : n === 24 ? 1 : 0); const ev = turn(b, MV(0), MV(0)); return { b, ev, A: b.s.sides[0].team[b.s.sides[0].act], B: b.s.sides[1].team[b.s.sides[1].act], S: b.s }; };
  const hitOf = (spec) => lost(prun(spec).ev, 1, 'move');
  const enter2 = (ab, extra) => { const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab } }, b: Object.assign({ moves: ['Splash'] }, extra || {}) }); turn(b, SW(1), MV(0)); return b; };
  // type-boost abilities act on the ATTACK stat (MEASURED): Transistor x1.3 (5325) Thunderbolt BP90, Fire Mane x1.5 Flamethrower BP90
  add('fa2/ab-transistor-and-fire-mane-boost-the-attack-stat', () => eq([hitOf({ a: A('Thunderbolt', { ab: 'Transistor' }) }), hitOf({ a: A('Flamethrower', { ab: 'Fire Mane' }) }), hitOf({ a: A('Surf', { ab: 'Fire Mane' }) })], [dmgBase(90, pm(100, 5325)), dmgBase(90, pm(100, 6144)), dmgBase(90)]));
  add('fa2/ab-enigma-doubles-moves-with-power-in-the-name', () => eq([hitOf({ a: A('Power Gem', { ab: 'Enigma' }) }), hitOf({ a: A('Pound', { ab: 'Enigma' }) })], [dmgBase(160), dmgBase(40)]));
  add('fa2/ab-generalist-boosts-moves-outside-the-users-types', () => eq([hitOf({ a: A('Flamethrower', { ab: 'Generalist' }) }), hitOf({ a: A('Flamethrower', { ab: 'Generalist', ty: [T.FIRE] }) })], [dmgBase(pm(90, 5120)), Math.floor(dmgBase(90) * 1.5)]));
  add('fa2/ab-last-stand-boosts-and-costs-a-tenth', () => { const r = prun({ a: A('Pound', { ab: 'Last Stand' }) }, { rng: [1, 0, 99] }); return eq([lost(r.ev, 1, 'move'), r.A.hp], [dmgBase(pm(40, 5325)), 180]); });
  // Omega: the product of the chart is replaced (MEASURED on dual types): attacker -> at least x2, even into a Ghost; defender -> always x0.5
  add('fa2/ab-omega-forces-the-type-product', () => eq([hitOf({ a: A('Pound', { ab: 'Omega' }), b: { ty: [T.GHOST] } }), hitOf({ a: A('Flamethrower', { ab: 'Omega' }), b: { ty: [T.WATER, T.ROCK] } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Omega', ty: [T.GRASS] } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Omega', ty: [T.WATER, T.ROCK] } })], [pm(dmgBase(40), 8192), pm(dmgBase(90), 8192), pm(dmgBase(90), 2048), pm(dmgBase(90), 2048)]));
  add('fa2/ab-acidic-and-inversion-rewrite-the-chart', () => eq([hitOf({ a: A('Sludge Bomb', { ab: 'Acidic' }), b: { ty: [T.STEEL] } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Inversion', ty: [T.WATER] } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Inversion', ty: [T.GRASS] } })], [pm(dmgBase(90), 8192), pm(dmgBase(90), 8192), pm(dmgBase(90), 2048)]));
  add('fa2/ab-siegebreaker-attacks-with-two-thirds-of-its-defense', () => eq([hitOf({ a: A('Pound', { ab: 'Siegebreaker' }) }), hitOf({ a: A('Flamethrower', { ab: 'Siegebreaker', st: { def: 300 } }) })], [dmgBase(40, Math.floor(100 * 2 / 3)), dmgBase(90, 200)]));
  // Phalanx / Spectral halve the attacker's stat of that category (MEASURED fit), Aura Guard halves contact damage, Guardian x0.85
  add('fa2/ab-phalanx-and-spectral-halve-the-attackers-stat', () => eq([hitOf({ a: A('Pound'), b: { ab: 'Phalanx' } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Phalanx' } }), hitOf({ a: A('Flamethrower'), b: { ab: 'Spectral' } })], [dmgBase(40, pm(100, 2048)), dmgBase(90), dmgBase(90, pm(100, 2048))]));
  add('fa2/ab-auras-boost-every-move-of-the-type-and-aura-break-reverses', () => eq([hitOf({ a: A('Dark Pulse'), b: { ab: 'Dark Aura' } }), hitOf({ a: A('Dark Pulse', { ab: 'Dark Aura' }) }), hitOf({ a: A('Dark Pulse', { ab: 'Dark Aura' }), b: { ab: 'Aura Break' } })], [dmgBase(pm(80, 5448)), dmgBase(pm(80, 5448)), dmgBase(pm(80, 3072))]));
  add('fa2/ab-mega-sol-moves-behave-as-in-sun', () => eq([hitOf({ a: A('Flamethrower', { ab: 'Mega Sol' }) }), hitOf({ a: A('Surf', { ab: 'Mega Sol' }) })], [pm(dmgBase(90), 6144), pm(dmgBase(90), 2048)]));
  add('fa2/ab-normal-to-type-abilities-boost-by-a-fifth', () => eq([hitOf({ a: A('Body Slam', { ab: 'Dragonize' }) }), hitOf({ a: A('Body Slam', { ab: 'Flamilate' }), b: { ty: [T.GRASS] } })], [dmgBase(pm(85, 4915)), pm(dmgBase(pm(85, 4915)), 8192)]));
  // priority at full HP: acts first against a faster foe only while healthy
  add('fa2/ab-full-hp-priority-abilities', () => {
    const first = (hp) => of(prun({ a: { moves: ['Flamethrower'], ab: 'Heat Rush', st: { spe: 10 }, hp }, b: { moves: ['Pound'], st: { spe: 200 } } }).ev, 'move-use')[0].s;
    return eq([first(200), first(100)], [0, 1]);
  });
  add('fa2/ab-stall-moves-last-in-its-bracket', () => { const b = lab({ a: { moves: ['Pound'], ab: 'Stall', st: { spe: 200 } }, b: { moves: ['Pound'], st: { spe: 10 } } }); return eq(of(turn(b, MV(0), MV(0), [1, 0, 1, 0]), 'move-use').map((e) => e.s), [1, 0]); });
  // entry effects: the stage deltas the real game showed
  add('fa2/ab-entry-stat-changes', () => {
    const f = (ab) => enter2(ab).s.sides[1].team[0].sg, m = (ab) => enter2(ab).s.sides[0].team[1].sg;
    return eq([f('Uncanny').spa, f('Breaking').def, f('Disquiet').spd, f('Tangling').spe, f('Infernal').atk, f('Infernal').def, m('Intrepid Sword').atk, m('Dauntless Shield').def, m('Resolute Guard').spd, m('Skip Step').spe, m('Glacial').spd], [-1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1]);
  });
  add('fa2/ab-entry-field-effects', () => {
    const e1 = enter2('Windburst').s.sides[0].tw, e2 = enter2('Showtime').s.tr, e3 = enter2('Restoring').s.sides[0].team[1].v.aring, e4 = enter2('Rooted').s.sides[0].team[1].v.ingrain;
    return eq([e1 > 0, e2 > 0, e3, e4], [true, true, 1, 1]);
  });
  add('fa2/ab-end-of-turn-foe-drops', () => eq([prun({ a: A('Splash', { ab: 'Arctic Aura' }) }).B.sg.atk, prun({ a: A('Splash', { ab: 'Stormrider' }) }).B.sg.spd, prun({ a: A('Splash', { ab: 'Volcano Howl' }) }).B.sg.def], [-1, -1, -1]));
  add('fa2/ab-end-of-turn-heals', () => eq([prun({ a: A('Splash', { ab: 'Rejuvenation', hp: 100 }) }).A.hp, prun({ a: A('Splash', { ab: 'Glacial', hp: 100 }), wx: [5, 5] }).A.hp, prun({ a: A('Splash'), b: { ab: 'Bad Dreams', s: 1, sc: 3 } }).B.hp], [120, 100 + 25, 200]));
  add('fa2/ab-hit-reactions', () => eq([prun({ a: A('Pound'), b: { ab: 'Water Compaction' } }, { rng: NC }).B.sg.def, prun({ a: A('Surf'), b: { ab: 'Water Compaction' } }, { rng: NC }).B.sg.def, prun({ a: A('Flamethrower'), b: { ab: 'Solidify' } }, { rng: [1, 0, 99] }).B.sg.spd, prun({ a: A('Surf'), b: { ab: 'Steam Engine' } }, { rng: NC }).B.sg.spe, prun({ a: A('Pound'), b: { ab: 'Cotton Down' } }, { rng: NC }).A.sg.spe, prun({ a: A('Pound'), b: { ab: 'Inky' } }, { rng: NC }).A.sg.acc, prun({ a: A('Pound'), b: { ab: 'Spicy Spray' } }, { rng: NC }).A.s], [0, 2, 1, 6, -1, -1, 3]));
  add('fa2/ab-force-return-reflects-thirty-percent', () => { const r = prun({ a: A('Pound'), b: { ab: 'Force Return' } }, { rng: NC }); return eq(lost(r.ev, 0, 'force-return'), Math.floor(19 * 30 / 100)); });
  add('fa2/ab-after-hit-chances-use-the-draw', () => eq([prun({ a: A('Pound', { ab: 'Soothing' }) }, { rng: [1, 0, 9, 0] }).B.s, prun({ a: A('Pound', { ab: 'Soothing' }) }, { rng: [1, 0, 10, 0] }).B.s, prun({ a: A('Pound', { ab: 'Toxic Chain' }) }, { rng: [1, 0, 29, 0] }).B.s, prun({ a: A('Pound', { ab: 'Toxic Chain' }) }, { rng: [1, 0, 30, 0] }).B.s, prun({ a: A('Pound', { ab: 'Blazing Sun' }) }, { rng: NC }).B.s], [1, 0, 6, 0, 0]));
  add('fa2/ab-lifesteal-family-heals-from-damage', () => eq([healed(prun({ a: A('Pound', { ab: 'Lifesteal', hp: 100 }) }, { rng: NC }).ev, 0), healed(prun({ a: A('Earthquake', { ab: 'Spectral Drain', hp: 100 }) }, { rng: NC }).ev, 0)], [Math.floor(19 / 8), Math.floor(dmgBase(100) / 4)]));
  add('fa2/ab-status-move-blockers-and-bounce', () => {
    const tw = (ab) => prun({ a: A('Thunder Wave'), b: { ab } }, { rng: [0] });
    return eq([tw('Good as Gold').B.s, tw('Solar Armor').B.s, tw('Magic Bounce').A.s, tw('Magic Bounce').B.s, prun({ a: A('Growl'), b: { ab: 'Magic Bounce' } }).A.sg.atk, prun({ a: A('Quick Attack'), b: { ab: 'Dazzling' } }, { rng: NC }).B.hp], [0, 0, 5, 0, -1, 200]);
  });
  add('fa2/ab-stone-face-and-nine-lives-endure-a-full-hp-ko', () => eq([prun({ a: A('Pound', { st: { atk: 999 } }), b: { ab: 'Stone Face', hp: 40, mhp: 40 } }, { rng: NC }).B.hp, prun({ a: A('Pound', { st: { atk: 999 } }), b: { ab: 'Nine Lives', hp: 40, mhp: 40 } }, { rng: NC }).B.hp], [10, 1]));
  add('fa2/ab-charged-state-doubles-the-next-electric-move', () => {
    const b = prun({ a: { moves: ['Pound', 'Thunderbolt'] }, b: { moves: ['Pound'], ab: 'Electromorphosis' } }).b; const e = b.s.sides[1].team[0].v.chgd;
    return eq([e, hitOf({ a: A('Gust'), b: { ab: 'Wind Rider' } })], [1, 0]);
  });
  add('fa2/ab-absorbers-added', () => eq([prun({ a: A('Surf'), b: { ab: 'Smouldering' } }, { rng: [] }).B.sg.spd, prun({ a: A('Shadow Ball'), b: { ab: 'Ritualist', hp: 100 } }, { rng: [] }).B.hp, prun({ a: A('Gust'), b: { ab: 'Wind Rider' } }, { rng: [] }).B.sg.atk, prun({ a: A('Gust'), b: { ab: 'Wind Chime' } }, { rng: [] }).B.sg.spa, prun({ a: A('Earthquake'), b: { ab: 'Eelevate' } }, { rng: [] }).B.hp], [1, 150, 1, 1, 200]));
  add('fa2/ab-ritualist-absorbs-before-the-type-chart', () => eq(prun({ a: A('Shadow Ball'), b: { ab: 'Ritualist', hp: 100, ty: [T.NORMAL] } }, { rng: [] }).B.hp, 150));
  add('fa2/ab-parental-bond-and-dual-strike-hit-twice-for-a-quarter', () => { const r = prun({ a: A('Pound', { ab: 'Parental Bond' }) }, { rng: [1, 0, 1, 0] }); return eq([lost(r.ev, 1, 'move'), of(r.ev, 'multi-hit')[0].n], [19 + pm(19, 1024), 2]); });
  add('fa2/ab-aura-shield-blocks-the-first-attack-only', () => { const b = lab({ a: { moves: ['Pound'] }, b: { moves: ['Splash'], ab: 'Aura Shield' } }); const dflt = (n) => (n === 16 ? 0 : n === 100 ? 99 : n === 24 ? 1 : 0); b.rand = dflt; turn(b, MV(0), MV(0)); const h1 = b.s.sides[1].team[0].hp; b.rand = dflt; turn(b, MV(0), MV(0)); return eq([h1, b.s.sides[1].team[0].hp], [200, 200 - 19]); });
  add('fa2/ab-soul-abilities-add-a-type', () => eq([hitOf({ a: A('Shadow Ball', { ab: 'Phantom Soul' }) }), hitOf({ a: A('Shadow Ball') })], [Math.floor(dmgBase(80) * 1.5), dmgBase(80)]));
  add('fa2/ab-long-reach-removes-contact', () => eq(lost(prun({ a: A('Pound', { ab: 'Long Reach' }), b: { ab: 'Rough Skin' } }, { rng: NC }).ev, 0, 'rough-skin'), 0));
  add('fa2/ab-cheek-pouch-heals-a-third-after-a-berry', () => { const r = prun({ a: A('Pound'), b: { ab: 'Cheek Pouch', it: 'Sitrus Berry', hp: 70, mhp: 200 } }, { rng: NC }); return eq([healed(r.ev, 1)], [Math.floor(200 / 4) + Math.floor(200 / 3)]); });
  add('fa2/ab-mirror-armor-bounces-a-drop', () => { const r = prun({ a: A('Growl'), b: { ab: 'Mirror Armor' } }); return eq([r.A.sg.atk, r.B.sg.atk], [-1, 0]); });
  add('fa2/ab-dancer-copies-a-dance-move', () => { const r = prun({ a: A('Swords Dance'), b: { ab: 'Dancer' } }); return eq([r.A.sg.atk, r.B.sg.atk], [2, 2]); });
  add('fa2/ab-opportunist-copies-a-raise-once', () => { const r = prun({ a: A('Swords Dance'), b: { ab: 'Opportunist' } }); return eq([r.A.sg.atk, r.B.sg.atk], [2, 2]); });
  add('fa2/ab-liquid-voice-turns-sound-moves-to-water-without-a-boost', () => eq(hitOf({ a: A('Hyper Voice', { ab: 'Liquid Voice' }), b: { ty: [T.FIRE] } }), pm(dmgBase(90), 8192)));
  add('fa2/ab-momentum-raises-speed-after-a-priority-move', () => eq(prun({ a: A('Quick Attack', { ab: 'Momentum' }) }, { rng: NC }).A.sg.spe, 1));
  // items: Gem x1.3 once; Power items halve speed; Iron Ball grounds; the three Berry-style hit reactions; Metronome is a FINAL-step factor of 1.2 per consecutive use (MEASURED)
  add('fa2/it-gems-boost-once-and-are-used-up', () => { const b = lab({ a: { moves: ['Flamethrower'], it: 'Fire Gem' } }); const e1 = turn(b, MV(0), MV(0), [1, 0, 99]); const e2 = turn(b, MV(0), MV(0), [1, 0, 99]); return eq([lost(e1, 1, 'move'), lost(e2, 1, 'move'), b.s.sides[0].team[0].it], [pm(dmgBase(90), 5325), dmgBase(90), 0]); });
  add('fa2/it-power-items-and-iron-ball-halve-speed', () => { const sp = (it) => { const b = lab({ a: { moves: ['Splash'], it, st: { spe: 100 } } }); return b.speed(b.s.sides[0].team[0]); }; return eq([sp('Power Bracer'), sp('Macho Brace'), sp('Iron Ball'), sp(0)], [50, 50, 50, 100]); });
  add('fa2/it-iron-ball-grounds-a-flying-holder', () => eq(prun({ a: A('Earthquake'), b: { it: 'Iron Ball', ty: [T.FLYING] } }, { rng: NC }).B.hp < 200, true));
  add('fa2/it-stat-reaction-items', () => eq([prun({ a: A('Surf'), b: { it: 'Absorb Bulb' } }, { rng: NC }).B.sg.spa, prun({ a: A('Thunderbolt'), b: { it: 'Cell Battery' } }, { rng: [1, 0, 99] }).B.sg.atk, prun({ a: A('Pound'), b: { it: 'Kee Berry' } }, { rng: NC }).B.sg.def, prun({ a: A('Flamethrower'), b: { it: 'Maranga Berry' } }, { rng: [1, 0, 99] }).B.sg.spd, prun({ a: A('Pound'), b: { it: 'Absorb Bulb' } }, { rng: NC }).B.sg.spa], [1, 1, 1, 1, 0]));
  add('fa2/it-jaboca-and-rowap-hurt-an-eighth-of-the-attackers-max-hp', () => eq([lost(prun({ a: A('Pound'), b: { it: 'Jaboca Berry' } }, { rng: NC }).ev, 0, 'jaboca'), lost(prun({ a: A('Flamethrower'), b: { it: 'Rowap Berry' } }, { rng: [1, 0, 99] }).ev, 0, 'jaboca')], [25, 25]));
  add('fa2/it-sticky-barb-hurts-the-holder-and-moves-on-contact', () => { const r = prun({ a: A('Splash'), b: { it: 'Sticky Barb' } }); const c = prun({ a: A('Pound'), b: { it: 'Sticky Barb' } }, { rng: NC }); return eq([lost(r.ev, 1, 'sticky-barb'), c.A.it !== 0, c.B.it], [25, true, 0]); });
  add('fa2/it-metronome-grows-twenty-percent-per-consecutive-use', () => { const b = lab({ a: { moves: ['Pound'], it: 'Metronome' } }); const d = [1, 2, 3].map(() => lost(turn(b, MV(0), MV(0), NC), 1, 'move')); return eq(d, [19, pm(19, 4915), pm(19, 5734)]); });
  add('fa2/it-species-items', () => { const clam = lab({ a: { moves: ['Splash'] } }); return eq([hitOf({ a: A('Pound', { it: 'Punching Glove' }) }), hitOf({ a: A('Fire Punch', { it: 'Punching Glove' }) })], [dmgBase(40), dmgBase(pm(75, 4505))]); });
  add('fa2/it-enigma-berry-heals-a-quarter-after-a-super-effective-hit', () => { const r = prun({ a: A('Flamethrower'), b: { it: 'Enigma Berry', ty: [T.GRASS], hp: 200 } }, { rng: [1, 0, 99] }); return eq(healed(r.ev, 1), 50); });
  add('fa2/it-safety-goggles-and-umbrella-and-ring-target', () => eq([prun({ a: A('Spore'), b: { it: 'Safety Goggles' } }, { rng: [] }).B.s, prun({ a: A('Splash'), b: { it: 'Safety Goggles' }, wx: [3, 5] }).B.hp, hitOf({ a: A('Flamethrower'), b: { it: 'Utility Umbrella' }, wx: [1, 5] }), hitOf({ a: A('Pound'), b: { it: 'Ring Target', ty: [T.GHOST] } })], [0, 200, dmgBase(90), dmgBase(40)]));
  add('fa2/it-binding-band-and-mental-herb', () => eq([prun({ a: A('Wrap', { it: 'Binding Band' }) }, { rng: [0, 1, 0, 0] }).B.hp < prun({ a: A('Wrap') }, { rng: [0, 1, 0, 0] }).B.hp, prun({ a: A('Taunt'), b: { moves: ['Swords Dance'], it: 'Mental Herb' } }, { rng: [0] }).B.sg.atk], [true, 2]));
  add('fa2/it-red-card-sends-the-attacker-out', () => { const r = prun({ a: A('Pound', { bench: [A('Splash')] }), b: { it: 'Red Card' } }); return eq([r.S.sides[0].act, r.B.it], [1, 0]); });
  add('fa2/it-eject-button-and-pack-ask-the-holder-for-a-replacement', () => {
    const btn = prun({ a: A('Pound'), b: { it: 'Eject Button', bench: [A('Splash')] } });
    const pack2 = prun({ a: A('Growl'), b: { it: 'Eject Pack', bench: [A('Splash')] } });
    return eq([btn.S.phase, btn.S.need[1], btn.B.it, pack2.S.phase, pack2.S.need[1]], ['switch', true, 0, 'switch', true]);
  });
  add('fa2/it-blunder-policy-raises-speed-by-two-after-an-accuracy-miss', () => { const r = prun({ a: A('Thunder', { it: 'Blunder Policy' }) }, { rng: [99] }); return eq([of(r.ev, 'miss').length, r.A.sg.spe, r.A.it], [1, 2, 0]); });
  add('fa2/it-mirror-herb-copies-every-raise-of-a-move-once', () => { const r = prun({ a: A('Dragon Dance'), b: { it: 'Mirror Herb' } }); return eq([r.A.sg.atk, r.A.sg.spe, r.B.sg.atk, r.B.sg.spe, r.B.it], [1, 1, 1, 1, 0]); });
  // Burrower (ROM text; not probed): Dig is used in ONE turn and is 50 percent stronger: BP80 -> 120: floor(22*120/50)+2 = 54 on the first turn
  add('fa2/ab-burrower-digs-in-one-turn-with-more-power', () => { const r = prun({ a: A('Dig', { ab: 'Burrower' }) }); const n = prun({ a: A('Dig') }); return eq([lost(r.ev, 1, 'move'), lost(n.ev, 1, 'move'), of(n.ev, 'charge').length], [dmgBase(120), 0, 1]); });
  add('fa2/support-reasons-are-in-plain-words', () => { const S = M.engine_support; const rn = (id) => S.moveReason(pack, id); const dyn = pack.moves.find((m) => m && m.name === 'Max Strike').id; const mega = pack.items.find((i) => i.name === 'Venusaurite').id; const gen = pack.abilities.find((a) => a.name === 'Stance Change').id; return eq([rn(dyn).code, S.itemReason(pack, mega).code, S.abilityReason(pack, gen).code, typeof S.REASON_TEXT['form-change'], S.REASON_TEXT['terrain']], ['dynamax', 'mega', 'form-change', 'string', undefined]); });
  // the owner's rule: nothing a legal team can hold is refused only because it is 'not built yet'.  Every unsupported move a species learns, ability a species has (slot or innate) and held item has a specific reason code
  // ---- round 3 abilities (each was run against the real game, ROMDIFF.md 8.2; Frost Nova, Wimp Out and Emergency Exit only from the ROM text)
  add('r3/reborn-survives-the-first-lethal-hit-at-full-hp-and-only-once', () => {
    const b = lab({ a: { moves: ['Splash'], inn: ['Reborn'], hp: 100, mhp: 400 }, b: { moves: ['Pound'], st: { atk: 800 } } });
    turn(b, MV(0), MV(0)); const first = b.s.sides[0].team[0].hp; const rb1 = b.s.sides[0].team[0].rb;
    b.s.sides[0].team[0].hp = 100; turn(b, MV(0), MV(0));
    return eq([first, rb1, b.winner], [400, 1, 1]);
  });
  add('r3/parrying-keeps-focus-punch-after-a-hit', () => {
    const run1 = (inn) => { const b = lab({ a: { moves: ['Focus Punch'], inn, st: { spe: 10 } }, b: { moves: ['Pound'], st: { spe: 100 } } }); const ev = turn(b, MV(0), MV(0)); return [of(ev, 'cant-move').filter((e) => e.why === 'lost-focus').length, lost(ev, 1, 'move')]; };
    const w = run1(['Parrying']), n = run1([]);
    return eq([w[0], w[1] > 0, n[0], n[1]], [0, true, 1, 0]);
  });
  add('r3/time-spiral-negates-every-priority', () => {
    const first = (inn) => { const b = lab({ a: { moves: ['Pound'], inn, st: { spe: 10 } }, b: { moves: ['Quick Attack'], st: { spe: 100 } } }); const ev = turn(b, MV(0), MV(0)); return of(ev, 'move-use')[0].s; };
    return eq([first(['Time Spiral']), first([])], [0, 1]);
  });
  add('r3/tidal-deity-ignores-protect-and-screens-only-at-full-hp', () => {
    const go = (hp) => { const b = lab({ a: { moves: ['Pound'], inn: ['Tidal Deity'], hp, mhp: 200, st: { spe: 10 } }, b: { moves: ['Protect'], st: { spe: 100 } } }); return lost(turn(b, MV(0), MV(0)), 1, 'move'); };
    const sc = (hp) => { const b = lab({ a: { moves: ['Pound'], inn: ['Tidal Deity'], hp, mhp: 200 }, b: { moves: ['Splash'] }, sd: [{}, { reflect: 5 }] }); return lost(turn(b, MV(0), MV(0)), 1, 'move'); };
    return eq([go(200) > 0, go(150), sc(200) > sc(150)], [true, 0, true]);
  });
  add('r3/orichalcum-pulse', () => {
    const dmg = (ab, wx) => { const b = lab({ a: { moves: ['Pound'], ab }, b: { moves: ['Splash'], hp: 2000, mhp: 2000 }, ...(wx ? { wx } : {}) }); return lost(turn(b, MV(0), MV(0)), 1, 'move'); };
    return eq([dmg('Orichalcum Pulse', [2, 5]) > dmg('Orichalcum Pulse', null), dmg('Orichalcum Pulse', [2, 5]) > dmg(0, [2, 5])], [true, true]);
  });
  add('r3/frost-nova-freezes-its-killer-for-one-turn', () => {
    const b = lab({ a: { moves: ['Splash'], inn: ['Frost Nova'], hp: 1, mhp: 200, bench: [{ moves: ['Splash'] }] }, b: { moves: ['Pound', 'Splash'], st: { spe: 100 } } });
    const ev = turn(b, MV(0), MV(0)); const foe = b.s.sides[1].team[0];
    return eq([foe.s, foe.v.fn], [M.engine_data.ST.FRZ, 1]);
  });
  add('r3/wimp-out-and-emergency-exit-ask-for-a-replacement-at-half-hp', () => {
    const go = (ab) => { const b = lab({ a: { moves: ['Splash'], ab, hp: 200, mhp: 200, bench: [{ moves: ['Splash'] }] }, b: { moves: ['Pound'], st: { atk: 800 } } }); turn(b, MV(0), MV(0)); const rq = b.requests()[0]; return [rq.phase, rq.reason]; };
    return eq([go('Wimp Out'), go('Emergency Exit')], [['switch', 'pivot'], ['switch', 'pivot']]);
  });
  // ---- round 5: entry announcements, Slow Start's end, the Delta Stream tick and flag, Rapid Spin freeing its user (each line MEASURED in the real game, ROMDIFF.md section 9)
  const enter = (abName, foe, inn) => { const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: abName, ...(inn ? { inn: [inn] } : {}), ty: [T.NORMAL] } }, b: { moves: ['Splash'], ty: [T.NORMAL], ...(foe || {}) } }); b.drain(); b.choose(0, SW(1)); b.choose(1, MV(0)); return b.advance().filter((e) => e.t === 'ability' && e.s === 0); };
  add('r5/entry-announcements', () => {
    const fx = (n, foe) => enter(n, foe).map((e) => e.fx).join(',');
    const frisk = enter('Frisk', { it: 'Oran Berry' }), fw = enter('Forewarn', { moves: ['Pound', 'Earthquake', 'Splash'] }), none = enter('Frisk', {});
    return eq([fx('Pressure'), fx('Mold Breaker'), fx('Turboblaze'), fx('Teravolt'), fx('Dark Aura'), fx('Fairy Aura'), fx('Aura Break'), fx('Cloud Nine'), fx('Air Lock'), frisk.length && frisk[0].fx, frisk.length && frisk[0].it === L.D.itemByName['Oran Berry'], none.length,
      fw.length && fw[0].fx, fw.length && fw[0].mv === L.mid('Earthquake'), fx('Anticipation', { moves: ['Pound'] }), fx('Anticipation', { moves: ['Karate Chop'] }), fx('Anticipation', { moves: ['Guillotine'] }), fx('Anticipation', { moves: ['Explosion'] })],
    ['pressure', 'mold-breaker', 'turboblaze', 'teravolt', 'dark-aura', 'fairy-aura', 'aura-break', 'weather-lock', 'weather-lock', 'frisk', true, 0, 'forewarn', true, '', 'anticipation', 'anticipation', '']);
  });
  add('r5/forewarn-power-rules', () => {
    const pick = (mvs) => { const e = enter('Forewarn', { moves: mvs }); return e.length ? e[0].mv : 0; };
    const id = (n) => L.mid(n);
    return eq([pick(['Seismic Toss', 'Rock Slide']) === id('Seismic Toss'), pick(['Seismic Toss', 'Flamethrower']) === id('Flamethrower'), pick(['Counter', 'Thunder']) === id('Counter'), pick(['Counter', 'Hyper Beam']) === id('Hyper Beam'),
      pick(['Fissure', 'Earthquake']) === id('Fissure'), pick(['Fissure', 'Hyper Beam']) === id('Hyper Beam'), pick(['Flamethrower', 'Thunderbolt', 'Ice Beam', 'Splash']) === id('Ice Beam'), pick(['Splash', 'Growl']) === id('Growl')], [true, true, true, true, true, true, true, true]);
  });
  add('r5/slow-start-ends-at-the-end-of-turn-five-once', () => {
    const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Slow Start' } }, b: { moves: ['Splash'] } });
    b.drain(); b.choose(0, SW(1)); b.choose(1, MV(0)); b.advance();
    const turns = []; for (let k = 0; k < 7; k++) { b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); turns.push(of(b.advance(), 'ability').filter((e) => e.fx === 'slow-start-end').length); }
    return eq(turns, [0, 0, 0, 1, 0, 0, 0]);   // the switch-in turn already counts one: 5 -> 4 at its end, 0 at the end of the fourth turn after it (= the fifth turn on the field)
  });
  add('r5/delta-stream-ticks-every-turn-and-flags-the-clamped-hit', () => {
    const ticks = (pw) => { const b = lab({ a: { moves: ['Splash'] }, b: { moves: ['Splash'] }, ...(pw ? { pw } : {}) }); let n = 0; for (let k = 0; k < 3; k++) { b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); n += of(b.advance(), 'weather-tick').filter((e) => e.w === 8).length; } return n; };
    const hitEv = (mv, ty, pw) => { const b = lab({ a: { moves: [mv], ty: [T.NORMAL] }, b: { moves: ['Splash'], ty, hp: 400, mhp: 400 }, ...(pw ? { pw } : {}) }); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); return b.advance().find((e) => e.t === 'damage' && e.s === 1); };
    return eq([ticks(8), ticks(0), hitEv('Rock Slide', [T.FLYING], 8).winds, hitEv('Rock Slide', [T.BUG, T.FLYING], 8).winds, hitEv('Pound', [T.FLYING], 8).winds, hitEv('Rock Slide', [T.FLYING], 0).winds, hitEv('Rock Slide', [T.NORMAL], 8).winds], [3, 0, 1, 1, undefined, undefined, undefined]);
  });
  add('r5/rapid-spin-frees-its-user-after-the-speed-rise', () => {
    const b = lab({ a: { moves: ['Rapid Spin'], v: { trap: { t: 3, src: 1, var: 0 }, seeded: 1 } }, b: { moves: ['Splash'], ty: [T.NORMAL], hp: 400, mhp: 400 } });
    b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev = b.advance();
    const keys = ev.filter((e) => e.t === 'stat-change' || e.t === 'volatile-end').map((e) => e.t === 'stat-change' ? 'spe' : e.v + ':' + e.why);
    return eq(keys, ['spe', 'trap:rapid-spin', 'leech-seed:rapid-spin']);
  });
  // round 6: the leads of a battle enter in SPEED order, equal speeds side 0 first (MEASURED, oracle with forced stats: slow player vs fast foe prints the foe's Pressure before the player's Mold Breaker,
  // fast player the other way round, equal speeds the player first; Drizzle against Drought: the slower one acts last and its weather stays). The oracle's player is battler 0, the engine's side 0.
  add('r6/start-of-battle-entries-follow-speed-and-ties-go-to-side-0', () => {
    const idOf = (n) => pack.roster.find((id) => pack.species[id].name === n);
    const start = (n0, ab0, l0, n1, ab1, l1) => {
      const rec = (n, ab, lv) => { const sid = idOf(n); const r = M.rules.blankRec(sid, pack, RS); r.level = lv; r.abilitySlot = pack.species[sid].abilities.indexOf(pack.abilities.find((x) => x && x.name === ab).id); return r; };
      const b = M.engine.createBattle({ pack, ruleset: RS, teams: [[rec(n0, ab0, l0)], [rec(n1, ab1, l1)]], seed: 1, validate: false });
      return { keys: b.events.filter((e) => e.t === 'ability').map((e) => e.s + ':' + e.fx), wx: b.s.wx[0], spd: [b.speed(b.act(0)), b.speed(b.act(1))] };
    };
    // the ruleset fixes the level, so the speed order comes from the species (base Speed: Aerodactyl 130, Pinsir 85, Politoed 70, Vulpix 65)
    const slow = start('Pinsir', 'Mold Breaker', 50, 'Aerodactyl', 'Pressure', 50), fast = start('Aerodactyl', 'Pressure', 50, 'Pinsir', 'Mold Breaker', 50), tie = start('Aerodactyl', 'Pressure', 50, 'Aerodactyl', 'Pressure', 50);
    const w1 = start('Politoed', 'Drizzle', 50, 'Vulpix', 'Drought', 50), w2 = start('Vulpix', 'Drought', 50, 'Politoed', 'Drizzle', 50);
    return eq([slow.spd[0] < slow.spd[1], slow.keys.join(','), fast.spd[0] > fast.spd[1], fast.keys.join(','), tie.spd[0] === tie.spd[1], tie.keys.join(','), w1.spd[0] > w1.spd[1], w1.keys.join(','), w1.wx, w2.spd[0] < w2.spd[1], w2.keys.join(','), w2.wx],
      [true, '1:pressure,0:mold-breaker', true, '0:pressure,1:mold-breaker', true, '0:pressure,1:pressure', true, '0:weather,1:weather', 2, true, '1:weather,0:weather', 2]);
  });
  // rules.js refuses in plain words: the generic code text and the per-item message both say WHY, and neither says the engine "cannot run it yet"
  add('r3/engine-refusals-say-why-in-plain-words', () => { const R = M.rules; const bad = [];
    for (const code of ['move.engine-unsupported', 'ability.engine-unsupported', 'item.engine-unsupported', 'species.engine-no-ability', 'species.engine-no-move']) if (/yet|battle engine/.test(R.RULE_CODES[code])) bad.push(code);
    const mega = pack.items.find((i) => i.name === 'Venusaurite').id; const rec = R.blankRec(445, pack, RS); rec.item = mega;
    const r = R.validateMon(rec, pack, RS).reasons.find((x) => x.code === 'item.engine-unsupported');
    const sp = M.engine_support; const w = sp.itemReason(pack, mega).why;
    if (!r || !r.message.includes('Venusaurite') || !r.message.includes(w) || r.reason !== w || /yet/.test(r.message)) bad.push('item message ' + (r && r.message));
    const dar = pack.roster.find((id) => pack.species[id].name === 'Darmanitan'); const rd = R.blankRec(dar, pack, RS); rd.abilitySlot = 2;
    const ra = R.validateMon(rd, pack, RS).reasons.find((x) => x.code === 'ability.engine-unsupported');
    if (!ra || !ra.message.includes('Zen Mode') || !ra.message.includes(sp.abilityReason(pack, ra.ability).why)) bad.push('ability message ' + (ra && ra.message));
    return eq([bad], [[]]); });
  add('r3/no-reachable-gap-is-only-not-yet', () => { const S = M.engine_support; const sup = S.engineSupport(pack); const bad = [];
    for (const sid of pack.roster) { const sp = pack.species[sid]; for (const id of [...sp.abilities, ...(sp.innates || [])]) if (id && !sup.abilities.has(id) && S.abilityReason(pack, id).code === 'not-yet') bad.push('ability ' + pack.abilities[id].name + ' of ' + sp.name);
      for (const k of Object.keys(M.rules.learnsetOf(pack, sid, true))) { const id = Number(k); if (pack.moves[id] && !sup.moves.has(id) && S.moveReason(pack, id).code === 'not-yet') bad.push('move ' + pack.moves[id].name + ' of ' + sp.name); } }
    for (const it of pack.items) if (it && it.id && !sup.items.has(it.id) && S.itemReason(pack, it.id).code === 'not-yet') bad.push('item ' + it.name);
    return eq([[...new Set(bad)].slice(0, 6)], [[]]); });
  // ================================================================== ROUND 3 (FA2): terrain, Gravity, primal weather, gender, the new abilities.  Each number was first measured in the real game (ROMDIFF.md section 8).
  // go: one lenient turn: every draw is 0 except rand(100) = 99 (no secondary effect; a 100-accuracy move hits) and rand(24) = 1 (no crit)
  const LEN = (n) => (n === 100 ? 99 : n === 24 ? 1 : 0);
  const go = (spec, draw) => { const b = lab(spec); b.rand = draw || LEN; b.drain(); b.choose(0, MV(0)); if (!b.choose(1, MV(0)).ok) b.choose(1, { kind: 'move', slot: 4 }); const ev = b.advance(); return { b, ev, A: b.s.sides[0].team[b.s.sides[0].act], B: b.s.sides[1].team[b.s.sides[1].act] }; };
  const dmgGo = (spec) => lost(go(spec).ev, 1, 'move');
  const turns = (b, n) => { for (let i = 0; i < n; i++) { b.drain(); b.choose(0, MV(0)); if (!b.choose(1, MV(0)).ok) b.choose(1, { kind: 'move', slot: 4 }); b.rand = LEN; b.advance(); } };
  add('r3/grassy-terrain-heals-a-grounded-sixteenth-and-lasts-five-turns', () => {
    const b = lab({ a: { moves: ['Splash'], hp: 100 }, b: { moves: ['Splash'], hp: 100, ty: [T.FLYING] }, tn: [1, 5] });
    turns(b, 1);
    const one = [b.s.sides[0].team[0].hp, b.s.sides[1].team[0].hp];
    turns(b, 4);
    return eq([one, b.s.sides[0].team[0].hp, b.s.sides[1].team[0].hp, b.s.tn], [[112, 100], 160, 100, undefined]);
  });
  add('r3/electric-and-misty-terrain-block-sleep-and-status-for-the-grounded-only', () => {
    const f = (mv, tn, bx) => go({ a: A(mv), b: Object.assign({ moves: ['Splash'] }, bx || {}), tn: [tn, 5] }, (n) => (n === 24 ? 1 : 0)).B.s;
    return eq([f('Spore', 2), f('Spore', 2, { ty: [T.FLYING] }), f('Thunder Wave', 2), f('Thunder Wave', 3), f('Thunder Wave', 3, { ty: [T.FLYING] }), f('Toxic', 3), f('Spore', 4)], [0, 1, 5, 0, 5, 0, 1]);
  });
  add('r3/misty-terrain-stops-confusion-and-psychic-terrain-stops-priority-at-the-grounded', () => {
    const conf = (tn) => (go({ a: A('Confuse Ray'), b: { moves: ['Splash'] }, tn: [tn, 5] }).B.v.conf ? 1 : 0);
    const qa = (bx) => go({ a: A('Quick Attack'), b: Object.assign({ moves: ['Splash'] }, bx || {}), tn: [4, 5] }).B.hp;
    return eq([conf(3), conf(2), qa(), qa({ ty: [T.FLYING] }) < 200], [0, 1, 200, true]);
  });
  add('r3/terrain-boosts-the-users-own-type-and-halves-earth-and-dragon-moves', () => eq([
    dmgGo({ a: A('Energy Ball') }), dmgGo({ a: A('Energy Ball'), tn: [1, 5] }), dmgGo({ a: A('Energy Ball', { ty: [T.FLYING] }), tn: [1, 5] }),
    dmgGo({ a: A('Earthquake') }), dmgGo({ a: A('Earthquake'), tn: [1, 5] }), dmgGo({ a: A('Dragon Claw') }), dmgGo({ a: A('Dragon Claw'), tn: [3, 5] }),
  ], [41, 53, 41, 46, 24, 37, 19]));
  add('r3/grassy-glide-goes-first-only-on-grassy-terrain', () => {
    const glide = (tn) => { const g = go({ a: { moves: ['Grassy Glide'], st: { spe: 10 } }, b: { moves: ['Pound'], st: { spe: 100 }, hp: 30 }, ...(tn ? { tn: [tn, 5] } : {}) }); return of(g.ev, 'move-use').map((e) => e.s)[0]; };
    return eq([glide(1), glide(0), glide(2)], [0, 1, 1]);
  });
  add('r3/gravity-grounds-ground-immunities-and-raises-accuracy-by-five-thirds', () => {
    const hp = (spec) => go(spec).B.hp;   // the foe uses Harden: Gravity bans Splash and would turn it into Struggle
    const fb = (gv) => go({ a: A('Focus Blast'), b: { moves: ['Splash'] }, ...(gv ? { gv: 5 } : {}) }, (n) => (n === 100 ? 99 : n === 24 ? 1 : 0)).B.hp;   // 70 percent accuracy: a draw of 99 misses; x5/3 = 116 always hits
    return eq([hp({ a: A('Earthquake'), b: { moves: ['Splash'], ty: [T.FLYING] } }), hp({ a: A('Earthquake'), b: { moves: ['Harden'], ty: [T.FLYING] }, gv: 5 }) < 200, hp({ a: A('Earthquake'), b: { moves: ['Harden'], ab: 'Levitate' }, gv: 5 }) < 200, hp({ a: A('Earthquake'), b: { moves: ['Harden'], ab: 'Allseeing Idol' }, gv: 5 }), fb(false), fb(true) < 200], [200, true, true, 200, 200, true]);
  });
  add('r3/primal-weathers-cancel-the-opposite-element-and-strong-winds-cut-flying-weaknesses', () => {
    const fire = go({ a: A('Flamethrower'), b: { moves: ['Splash'] }, wx: [1, 16], pw: 6 }).B.hp, water = go({ a: A('Surf'), b: { moves: ['Splash'] }, wx: [2, 16], pw: 7 }).B.hp;
    const ice = (pw) => go({ a: A('Ice Beam'), b: { moves: ['Splash'], ty: [T.FLYING] }, ...(pw ? { wx: [0, 0], pw } : {}) }).B.hp;
    const set = (mv, pw, wxid) => go({ a: A(mv), wx: [wxid, 16], pw }).b.s.pw;
    return eq([fire, water, ice(0) < ice(8), set('Sunny Day', 6, 1), set('Rain Dance', 8, 0)], [200, 200, true, 6, 8]);
  });
  add('r3/primal-weather-abilities-set-it-on-entry-and-it-ends-with-its-last-holder', () => {
    const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Primordial Sea' } }, b: { moves: ['Splash'] } });
    b.rand = LEN; b.drain(); b.choose(0, SW(1)); b.choose(1, MV(0)); b.advance();
    const on = [b.s.pw, b.s.wx[0]];
    const c = lab({ a: { moves: ['Splash'], ab: 'Delta Stream', hp: 1, bench: [{ moves: ['Splash'] }] }, b: { moves: ['Pound'] }, pw: 8, wx: [0, 0] });
    c.rand = LEN; c.drain(); c.choose(0, MV(0)); c.choose(1, MV(0)); c.advance();
    return eq([on, c.s.pw], [[6, 1], undefined]);
  });
  add('r3/gender-attract-cute-charm-rivalry-and-the-destiny-knot', () => {
    const rival = (ga, gb) => dmgGo({ a: A('Pound', { ab: 'Rivalry', g: ga }), b: { moves: ['Splash'], g: gb } });
    const charm = (u) => { const b = lab({ a: A('Pound', { g: 0 }), b: { moves: ['Splash'], ab: 'Cute Charm', g: 1 } }); b.rand = (n) => Math.floor(n * u); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); return b.s.sides[0].team[0].v.inf || 0; };
    const kb = go({ a: A('Attract', { g: 0 }), b: { moves: ['Splash'], g: 1, it: 'Destiny Knot' } });
    return eq([rival(0, 0), rival(0, 1), rival(2, 0), charm(0.9), charm(0.1), [kb.A.v.inf || 0, kb.B.v.inf || 0]], [24, 15, 19, 1, 0, [1, 1]]);
  });
  add('r3/infatuation-immobilizes-on-a-high-draw-and-lets-a-low-draw-through', () => {
    const f = (u) => { const b = lab({ a: A('Pound', { v: { inf: 1 } }), b: { moves: ['Splash'] } }); b.rand = (n) => Math.floor(n * u); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev = b.advance(); return of(ev, 'cant-move').filter((e) => e.why === 'love').length; };
    return eq([f(0.9), f(0.1)], [1, 0]);
  });
  add('r3/neutralizing-gas-ruin-abilities-permafrost-and-the-scorched-field', () => {
    const ng = go({ a: A('Earthquake', { ab: 'Neutralizing Gas' }), b: { moves: ['Splash'], ab: 'Levitate' } }).B.hp;
    const ngShield = go({ a: A('Earthquake', { ab: 'Neutralizing Gas' }), b: { moves: ['Splash'], ab: 'Levitate', it: 'Ability Shield' } }).B.hp;
    const base = dmgGo({ a: A('Pound'), b: { moves: ['Splash'] } });
    const sword = dmgGo({ a: A('Pound', { ab: 'Sword of Ruin' }), b: { moves: ['Splash'] } }), swordT = dmgGo({ a: A('Pound'), b: { moves: ['Splash'], ab: 'Sword of Ruin' } });
    const beads = dmgGo({ a: A('Flamethrower', { ab: 'Beads of Ruin' }), b: { moves: ['Splash'] } }), beads0 = dmgGo({ a: A('Flamethrower'), b: { moves: ['Splash'] } });
    const pf = (u) => { const b = lab({ a: A('Pound', { ab: 'Permafrost' }), b: { moves: ['Splash'] } }); b.rand = (n) => Math.floor(n * u); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); return b.s.sides[1].team[0].s; };
    const burn = go({ a: A('Will-O-Wisp'), b: { moves: ['Splash'], ab: 'Permafrost' } }).B.s;
    const scorch = (mv) => [dmgGo({ a: A(mv) }), dmgGo({ a: A(mv), tn: [5, 5] })];
    return eq([ng < 200, ngShield, sword > base, swordT, beads > beads0, pf(0.9), pf(0.1), burn, scorch('Flamethrower')[1] > scorch('Flamethrower')[0], scorch('Surf')[1] < scorch('Surf')[0]], [true, 200, true, base, true, 7, 0, 0, true, true]);
  });
  add('r3/mimicry-and-booster-energy-and-terrain-seeds-and-magnify-field-at-switch-in', () => {
    const sw = (ab, bench, spec) => { const b = lab(Object.assign({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: Object.assign({ ab }, bench) }, b: { moves: ['Splash'] } }, spec)); b.rand = LEN; b.drain(); b.choose(0, SW(1)); b.choose(1, MV(0)); b.advance(); return b; };
    const mim = sw('Mimicry', {}, { tn: [1, 5] }).s.sides[0].team[1];
    const boost = sw('Quark Drive', { it: 'Booster Energy' }).s.sides[0].team[1];
    const seed = sw('Pressure', { it: 'Grassy Seed' }, { tn: [1, 5] }).s.sides[0].team[1];
    const mag = sw('Magnify Field', {}, { tn: [1, 3] });
    return eq([mim.v.ty, boost.it, boost.v.be, seed.it, seed.sg.def, mag.s.tn[1]], [[T.GRASS], 0, 1, 0, 1, 4]);
  });
  return checks;
}
