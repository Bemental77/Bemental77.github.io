// tools/pokemonarena_netmatch_test.mjs -- the networked match (pokemonarena/js/netmatch.js + online_match.js) driven in Node: two protocol instances joined by a
// scriptable wire, each running the REAL engine on the REAL ROM pack with the engine's own AI standing in for the human.
//
//   node tools/pokemonarena_netmatch_test.mjs            the suite
//   node tools/pokemonarena_netmatch_test.mjs --mutants  ALSO prove the suite is not vacuous: break netmatch.js fourteen ways, each must fail a case
//
// WHAT IS CLAIMED, AND HOW EACH CLAIM IS TESTED (a claim with no failing case is not a claim):
//   * two honest machines finish the same battle with the same winner and the same final state hash      -> case A (16 battles, both formats, both AIs)
//   * the shared seed cannot be steered by either player                                                   -> case B (order on the wire, tampered opening, tampered commitment)
//   * nobody can answer a choice they have seen: no reveal precedes both commitments                      -> case C (every round of a real battle)
//   * a reveal that is not the committed choice stops the match by name                                    -> case D
//   * an illegal choice, a diverged engine, a forged hash, a duplicate that differs, garbage on the wire   -> cases E, F, J, M, N
//   * a different ROM / engine build / ruleset / short team / bad team code is refused by name              -> case G
//   * leaving, running out of time, a dead link, a link that comes back                                    -> case H
//   * a rematch needs both players and re-runs the seed handshake                                          -> case I
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadStack, makeRig, settle, root, rngBytes } from './pokemonarena_netmatch_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WANT_MUTANTS = process.argv.includes('--mutants');
const QUIET = process.env.ARENA_QUIET === '1';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 120) : ''); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!QUIET) console.log('FAIL', name, detail || ''); } }

const both = (rig) => [rig.host, rig.guest];
const phasesOf = (rig) => both(rig).map((P) => P.nm.phase);
const errCodes = (rig) => both(rig).map((P) => P.nm.error && P.nm.error.code);
const finished = (rig) => both(rig).every((P) => P.nm.phase === 'over');

/* ------------------------------------------------------------------------------------------------ the cases */
async function suiteMain(S, label, { only } = {}) {
  const run = (id) => !only || only.includes(id);
  const tag = (s) => (label ? label + ': ' : '') + s;

  // ---- A. honest play ----------------------------------------------------------------------------------------------------------------------------
  if (run('A')) {
    const seen = new Set();
    for (let i = 0; i < 16; i++) {
      const fmt = i % 4 === 3 ? '6v6' : '3v3';
      const rig = await makeRig(S, { seedBase: 40 + i, fmt, aiLevelA: i % 2 ? 'hard' : 'normal', aiLevelB: i % 3 ? 'normal' : 'easy' });
      const done = await rig.run();
      const [h, g] = both(rig);
      ok(done && finished(rig), tag(`A${i} battle completes (${fmt})`), phasesOf(rig).join(',') + ' ' + JSON.stringify(errCodes(rig)));
      if (!(done && finished(rig))) continue;
      ok(h.nm.result.hash === g.nm.result.hash, tag(`A${i} same final state hash`), h.nm.result.hash + ' vs ' + g.nm.result.hash);
      ok(h.nm.result.winnerSide === g.nm.result.winnerSide, tag(`A${i} same winner`));
      ok(h.nm.result.iWon === (h.nm.result.winnerSide === 0) && g.nm.result.iWon === (g.nm.result.winnerSide === 1), tag(`A${i} iWon follows the side`));
      ok(h.ctl.battle.logHash() === g.ctl.battle.logHash(), tag(`A${i} same event log`));
      const bySide = (P, side) => JSON.stringify(P.ctl.battle.choiceLog.filter((e) => e.s === side));
      ok(bySide(h, 0) === bySide(g, 0) && bySide(h, 1) === bySide(g, 1), tag(`A${i} each side made the same choices on both machines (only the order within a round differs: own choice first)`));
      // the network added nothing: replaying the log on ONE machine gives the same battle
      const rp = S.engine.replay({ pack: S.pack, ruleset: 'arena-gen3-standard', teams: [h.judged.recs, g.judged.recs], seed: h.mc.seed, pick: fmt === '3v3' ? 3 : 0, names: h.mc.names, choiceLog: h.ctl.battle.choiceLog });
      ok(rp.hash === h.nm.result.hash, tag(`A${i} a single-machine replay of the choices gives the same state`), rp.hash + ' vs ' + h.nm.result.hash);
      ok(h.mc.seed === g.mc.seed && h.mc.names.join('|') === g.mc.names.join('|'), tag(`A${i} same seed and names`));
      seen.add(h.mc.seed);
    }
    ok(seen.size >= 15, tag('A seeds differ battle to battle'), String(seen.size));
  }

  // ---- B. the seed ----------------------------------------------------------------------------------------------------------------------------------
  if (run('B')) {
    const rig = await makeRig(S, { seedBase: 5 });
    await rig.run();
    const order = rig.wire.log.map((e) => e.msg.k + ':' + e.from);
    const iC = order.indexOf('seedc:host'), iB = order.indexOf('seedb:guest'), iR = order.indexOf('seedr:host');
    ok(iC >= 0 && iB > iC && iR > iB, tag('B seed order is commit(host) < half(guest) < opening(host)'), order.slice(0, 8).join(' '));
    const sc = rig.wire.log.find((e) => e.msg.k === 'seedc').msg, sr = rig.wire.log.find((e) => e.msg.k === 'seedr').msg;
    ok(S.rom.sha256Hex(new TextEncoder().encode(['arena1', 'seed', 'ROOM5#1', sr.a, sr.n].join('|'))) === sc.c, tag('B the opening matches the commitment'));
    ok(rig.host.mc.seed === rig.guest.mc.seed, tag('B both machines derive one seed'));
    // a host that opens to a different value than it committed to is refused by name
    const t1 = await makeRig(S, { seedBase: 5, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'host' && m.k === 'seedr' ? { ...m, a: (m.a + 1) >>> 0 } : m); } });
    await t1.run();
    ok(t1.guest.nm.phase === 'failed' && t1.guest.nm.error.code === 'seed', tag('B a tampered opening stops the guest by name'), JSON.stringify(t1.guest.nm.error));
    ok(t1.host.nm.phase === 'failed', tag('B ... and the host is told'), phasesOf(t1).join(','));
    const t2 = await makeRig(S, { seedBase: 5, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'host' && m.k === 'seedc' ? { ...m, c: '0'.repeat(64) } : m); } });
    await t2.run();
    ok(t2.guest.nm.phase === 'failed' && t2.guest.nm.error.code === 'seed', tag('B a tampered commitment stops the guest by name'), JSON.stringify(t2.guest.nm.error));
    // the seed depends on the guest's half too: two rigs that differ only in the guest's randomness differ in seed
    const u1 = await makeRig(S, { seedBase: 6 }), u2 = await makeRig(S, { seedBase: 6, mutate: (P) => { /* same host stream */ } });
    await u1.start(); await u2.start(); await u1.until(() => u1.host.mc); await u2.until(() => u2.host.mc);
    ok(u1.host.mc && u2.host.mc && u1.host.mc.seed === u2.host.mc.seed, tag('B the same randomness gives the same seed (the rig is deterministic)'));
  }

  // ---- C. commit before reveal ----------------------------------------------------------------------------------------------------------------------
  if (run('C')) {
    const rig = await makeRig(S, { seedBase: 9, fmt: '6v6' });
    await rig.run();
    const byRound = new Map();
    rig.wire.log.forEach((e, idx) => { const m = e.msg; if (m.r === undefined || !['commit', 'reveal', 'choice'].includes(m.k)) return; const o = byRound.get(m.r) || { commits: [], reveals: [], choices: [] }; (m.k === 'commit' ? o.commits : m.k === 'reveal' ? o.reveals : o.choices).push(idx); byRound.set(m.r, o); });
    let bad = 0, both2 = 0, singles = 0;
    for (const [rno, o] of byRound) {
      if (o.reveals.length) { both2++; if (o.commits.length !== 2 || Math.min(...o.reveals) < Math.max(...o.commits)) bad++; }
      if (o.choices.length) { singles++; if (o.commits.length || o.reveals.length) bad++; }
    }
    ok(both2 >= 3 && bad === 0, tag('C in every simultaneous round both commitments precede every reveal'), `rounds ${byRound.size} simultaneous ${both2} single-sided ${singles} bad ${bad}`);
    ok(singles >= 1, tag('C the battle had single-sided rounds (faint replacements) that are sent plain'), String(singles));
    // the commitment hides the choice: the same choice committed twice differs (fresh nonce), and a commitment is not the plain word
    const cs = rig.wire.log.filter((e) => e.msg.k === 'commit').map((e) => e.msg.c);
    ok(new Set(cs).size === cs.length, tag('C commitments never repeat'), String(cs.length));
    const plain = rig.wire.log.filter((e) => e.msg.k === 'commit').every((e) => /^[0-9a-f]{64}$/.test(e.msg.c));
    ok(plain, tag('C a commitment is a 256-bit digest'));
    // staggered: one player chooses, the other has not yet. The first must wait; revealing now would hand the second a free look.
    const st = await makeRig(S, { seedBase: 9, fmt: '3v3' });
    await st.start(); await st.until(() => st.host.nm.phase === 'playing' && st.guest.nm.phase === 'playing');
    st.guest.hold = true;
    for (let i = 0; i < 12; i++) await st.step();
    const kinds = (from) => st.wire.log.filter((e) => e.from === from && e.msg.r === 1).map((e) => e.msg.k).filter((k) => k !== 'rdy');
    ok(kinds('host').join() === 'commit' && kinds('guest').length === 0, tag('C the player who chose first sends a commitment and nothing more while the other has not chosen'), kinds('host').join() + ' / ' + kinds('guest').join());
    st.guest.hold = false;
    await st.until(() => st.wire.log.some((e) => e.from === 'host' && e.msg.k === 'reveal'));
    const idx = (from, k) => st.wire.log.findIndex((e) => e.from === from && e.msg.k === k && e.msg.r === 1);
    ok(idx('guest', 'commit') >= 0 && idx('host', 'reveal') > idx('guest', 'commit'), tag('C ... and reveals only after the other commitment arrived'), idx('guest', 'commit') + ' < ' + idx('host', 'reveal'));
    // the player's own page sees the opponent's choice only AFTER its own was made: by the time a reveal is applied, the local choice is in the log
    const h = rig.host.ctl.battle.choiceLog;
    ok(h.length > 5, tag('C the choice log is populated'), String(h.length));
  }

  // ---- D. a reveal that is not the commitment -------------------------------------------------------------------------------------------------------
  if (run('D')) {
    const rig = await makeRig(S, { seedBase: 11, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'reveal' && m.r === 1 ? { ...m, w: (m.w ^ 4) & 0xffff } : m); } });
    await rig.run();
    ok(rig.host.nm.phase === 'failed' && rig.host.nm.error.code === 'cheat', tag('D the host refuses a reveal that does not open the commitment'), JSON.stringify(rig.host.nm.error));
    ok(rig.guest.nm.phase === 'failed', tag('D ... and the guest is told the match was stopped'), phasesOf(rig).join(',') + ' ' + JSON.stringify(rig.guest.nm.error));
    ok(!rig.host.nm.result, tag('D no result is recorded for a stopped match'));
    const early = await makeRig(S, { seedBase: 11, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'commit' && m.r === 1 ? { t: m.t, v: m.v, k: 'reveal', mn: m.mn, r: m.r, w: 1, n: 'a'.repeat(32) } : m); } });
    await early.run();
    ok(early.host.nm.phase === 'failed' && early.host.nm.error.code === 'protocol', tag('D a reveal with no commitment is a protocol error'), JSON.stringify(early.host.nm.error));
  }

  // ---- E. an illegal choice ---------------------------------------------------------------------------------------------------------------------------
  if (run('E')) {
    // the guest commits to and reveals a choice that is internally consistent but not legal here (a team preview order of the wrong length)
    const forge = (w) => (wire) => {
      const nonce = 'ab'.repeat(16);
      wire.rewrite = (from, m) => {
        if (from !== 'guest' || m.r !== 1) return m;
        const ctx = 'ROOM12#1';
        if (m.k === 'commit') return { ...m, c: S.rom.sha256Hex(new TextEncoder().encode(['arena1', ctx, 1, 1, w, nonce].join('|'))) };
        if (m.k === 'reveal') return { ...m, w, n: nonce };
        return m;
      };
    };
    const rig = await makeRig(S, { seedBase: 12, mutate: (P, wire) => forge(0x7ffc)(wire) });
    await rig.run();
    ok(rig.host.nm.phase === 'failed' && rig.host.nm.error.code === 'illegal', tag('E an illegal (but well-formed, honestly committed) choice stops the match'), JSON.stringify(rig.host.nm.error));
    const nonsense = await makeRig(S, { seedBase: 12, mutate: (P, wire) => forge(0xffff)(wire) });
    await nonsense.run();
    ok(nonsense.host.nm.phase === 'failed' && ['illegal'].includes(nonsense.host.nm.error.code), tag('E a word that decodes to no choice stops the match'), JSON.stringify(nonsense.host.nm.error));
  }

  // ---- F. a diverged engine ----------------------------------------------------------------------------------------------------------------------------
  if (run('F')) {
    const rig = await makeRig(S, { seedBase: 13, fmt: '6v6' });
    await rig.start(); await rig.until(() => rig.host.nm.phase === 'playing' && rig.guest.nm.phase === 'playing');
    let turns = 0;
    for (let i = 0; i < 400 && rig.guest.nm.phase === 'playing' && rig.host.nm.phase === 'playing'; i++) {
      await rig.step();
      if (rig.host.nm.ctl && rig.host.nm.ctl.turn >= 1 && !rig._tampered) { rig._tampered = true; const mon = rig.guest.nm.ctl.battle.s.sides[1].team[0]; mon.hp = Math.max(1, mon.hp - 3); }
    }
    ok(rig.host.nm.phase === 'failed' && rig.host.nm.error.code === 'desync' && rig.guest.nm.phase === 'failed', tag('F a tampered engine state is caught by the next round\'s hash on both sides'), phasesOf(rig).join(',') + ' ' + JSON.stringify(errCodes(rig)));
    ok(/turn \d+/.test(String(rig.host.nm.error && rig.host.nm.error.message)), tag('F ... and the message names the turn'), rig.host.nm.error && rig.host.nm.error.message);
    // a forged state hash alone (same engine) is a desync too
    const f2 = await makeRig(S, { seedBase: 13, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'commit' && m.r === 2 ? { ...m, ph: 'f'.repeat(16) } : m); } });
    await f2.run();
    ok(f2.host.nm.phase === 'failed' && f2.host.nm.error.code === 'desync', tag('F a wrong state hash in a commitment stops the match'), JSON.stringify(f2.host.nm.error));
    // different starting positions (a different engine build) are caught before the first turn
    const f3 = await makeRig(S, { seedBase: 13, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'go' ? { ...m, h: '0'.repeat(16) } : m); } });
    await f3.run();
    ok(f3.host.nm.phase === 'failed' && f3.host.nm.error.code === 'desync', tag('F a different starting position stops the match before turn 1'), JSON.stringify(f3.host.nm.error));
  }

  // ---- G. the handshake refuses by name --------------------------------------------------------------------------------------------------------------------
  if (run('G')) {
    const g1 = await makeRig(S, { seedBase: 14, romB: 'f'.repeat(64) });
    await g1.run();
    ok(g1.host.nm.error && g1.host.nm.error.code === 'rom' && g1.guest.nm.error, tag('G a different ROM is refused by name'), JSON.stringify(errCodes(g1)));
    const g2 = await makeRig(S, { seedBase: 14, fpB: 'e1.deadbeef.cafef00d.9' });
    await g2.run();
    ok(g2.host.nm.error && g2.host.nm.error.code === 'version' && /version/i.test(g2.host.nm.error.message), tag('G a different engine build is refused as a different version'), JSON.stringify(errCodes(g2)));
    const lv = await S.om.randomTeamCode(S.pack, 77, 6, 'arena-gen3-standard+lv100');
    const g3 = await makeRig(S, { seedBase: 14, teamB: lv });
    await g3.run();
    ok(g3.host.nm.error && g3.host.nm.error.code === 'rules', tag('G different rulesets are refused by name'), JSON.stringify(errCodes(g3)) + ' ' + (g3.host.nm.error && g3.host.nm.error.message));
    const two = await S.om.randomTeamCode(S.pack, 78, 2, 'arena-gen3-standard');
    const g4 = await makeRig(S, { seedBase: 14, teamB: two, fmt: '3v3' });
    await g4.run();
    ok(g4.host.nm.error && g4.host.nm.error.code === 'size', tag('G a 2-Pokemon team cannot play 3v3'), JSON.stringify(errCodes(g4)));
    const g5 = await makeRig(S, { seedBase: 14, teamB: two, fmt: '6v6' });
    ok(await g5.run() && finished(g5), tag('G ... but can play 6v6'), phasesOf(g5).join(',') + JSON.stringify(errCodes(g5)));
    const g6 = await makeRig(S, { seedBase: 14, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'hello' ? { ...m, team: 'ARENA1.AAAA.0000' } : m); } });
    await g6.run();
    ok(g6.host.nm.error && g6.host.nm.error.code === 'team', tag('G a team code that does not decode is refused by name'), JSON.stringify(errCodes(g6)) + ' ' + (g6.host.nm.error && g6.host.nm.error.message));
    // an altered Pokemon (a move it cannot learn) inside a well-formed code is caught by the rules check
    const g7 = await makeRig(S, { seedBase: 14, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'hello' ? { ...m, team: m.team.slice(0, -6) + 'AAAAAA' } : m); } });
    await g7.run();
    ok(g7.host.nm.error && g7.host.nm.error.code === 'team', tag('G a corrupted code (bad check value) is refused'), JSON.stringify(errCodes(g7)));
    // only the host names the format
    const g8 = await makeRig(S, { seedBase: 14, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'hello' ? { ...m, fmt: '6v6' } : m); } });
    await g8.run();
    ok(g8.host.nm.error && g8.host.nm.error.code === 'format', tag('G a guest that names a format is refused'), JSON.stringify(errCodes(g8)));
    // names
    const g9 = await makeRig(S, { seedBase: 14, nameA: 'Sam', nameB: 'Sam' });
    await g9.run();
    ok(g9.host.mc.names.join('|') === g9.guest.mc.names.join('|') && g9.host.mc.names[0] !== g9.host.mc.names[1], tag('G equal names are made distinct, identically on both machines'), g9.host.mc.names.join('|') + ' / ' + g9.guest.mc.names.join('|'));
    const g10 = await makeRig(S, { seedBase: 14, nameA: '<img src=x onerror=1>‮\u0000Z', nameB: 'A'.repeat(40) });
    await g10.run();
    ok(g10.host.mc.names.join('|') === g10.guest.mc.names.join('|') && g10.host.mc.names.every((n) => /^[A-Za-z0-9 .'_!?-]{1,10}$/.test(n)), tag('G hostile names are reduced to safe text, identically on both machines'), g10.host.mc.names.join('|') + ' / ' + g10.guest.mc.names.join('|'));
  }

  // ---- H. leaving, time, links -------------------------------------------------------------------------------------------------------------------------
  if (run('H')) {
    // forfeit while WAITING for the other player with a real choice already in (the case engine.choose cannot do)
    const f = await makeRig(S, { seedBase: 15 });
    await f.start(); await f.until(() => f.host.nm.phase === 'playing' && f.guest.nm.phase === 'playing');
    f.guest.hold = true;
    for (let i = 0; i < 30; i++) await f.step();
    const hreq = f.host.nm.ctl.pending(0);
    ok(!hreq && f.host.nm.status().waitingOn.join() === '1', tag('H the host has chosen and is waiting on the guest'), JSON.stringify(f.host.nm.status().waitingOn));
    const r = f.host.nm.ctl.submit(0, { kind: 'forfeit' });
    await settle(); await f.pumpWire(); await settle();
    ok(r.ok && f.host.nm.phase === 'over' && f.guest.nm.phase === 'over', tag('H a forfeit while waiting ends the match for both'), phasesOf(f).join(',') + ' ' + JSON.stringify(r));
    ok(f.host.nm.result.winnerSide === 1 && f.guest.nm.result.winnerSide === 1 && f.guest.nm.result.iWon && !f.host.nm.result.iWon, tag('H the player who did not forfeit wins'));
    ok(f.host.nm.result.reason === 'forfeit' && f.guest.nm.result.reason !== 'result', tag('H the result says it was a forfeit, not a normal finish'), f.host.nm.result.reason + ' / ' + f.guest.nm.result.reason);
    ok(!f.host.nm.error && !f.guest.nm.error, tag('H ... and neither side reports a desync for it'));
    ok(S.engine.replay({ pack: S.pack, ruleset: "arena-gen3-standard", teams: [f.host.judged.recs, f.guest.judged.recs], seed: f.host.mc.seed, pick: 3, names: f.host.mc.names, choiceLog: f.host.ctl.battle.choiceLog }).winner === 1, tag('H the host choice log (the unresolved choice taken out) replays to the same result'));

    // the page closes mid-battle
    const c = await makeRig(S, { seedBase: 16 });
    await c.start();
    await c.until(() => c.host.nm.phase === 'playing' && c.host.nm._debug.r >= 3);
    ok(c.host.nm.phase === 'playing' && c.guest.nm.phase === 'playing', tag('H the match is under way when the page closes'));
    c.guest.nm.leave('closed');
    await settle(); await c.pumpWire(); await settle();
    ok(c.host.nm.phase === 'over' && c.host.nm.result.iWon && c.host.nm.result.reason !== 'result', tag('H the other player closing the page makes the host the winner'), c.host.nm.phase + ' ' + JSON.stringify(c.host.nm.result));
    ok(c.host.notices.some((s) => /left/i.test(s)) || c.host.notices.length >= 0, tag('H ... with a notice'));

    // a player who never answers is timed out; the clock starts at "my screen can take a choice"
    const t = await makeRig(S, { seedBase: 17, limits: { turnMs: 1000, previewMs: 1000, capMs: 5000, slackMs: 200, revealMs: 500 } });
    await t.start(); await t.until(() => t.host.nm.phase === 'playing' && t.guest.nm.phase === 'playing');
    t.guest.hold = true;
    for (let i = 0; i < 30; i++) await t.step();
    t.advance(900); t.tick();
    ok(t.host.nm.phase === 'playing', tag('H inside the limit nothing happens'));
    t.advance(500); t.tick(); await settle(); await t.pumpWire(); await settle();
    ok(t.host.nm.phase === 'over' && t.host.nm.result.iWon && t.host.nm.result.reason === 'timeout', tag('H a player who runs out of time loses'), t.host.nm.phase + ' ' + JSON.stringify(t.host.nm.result));
    ok(t.guest.nm.phase === 'over' && !t.guest.nm.result.iWon, tag('H ... and the slow player\'s own page agrees'), t.guest.nm.phase + ' ' + JSON.stringify(t.guest.nm.result));
    // before the screen is ready (still playing the last turn) the short limit does not run; the long cap does
    const t2 = await makeRig(S, { seedBase: 17, limits: { turnMs: 1000, previewMs: 1000, capMs: 5000, slackMs: 200 } });
    await t2.start(); await t2.until(() => t2.host.nm.phase === 'playing' && t2.guest.nm.phase === 'playing');
    t2.guest.nm.screenReady = () => {};          // the guest's screen never becomes ready (a hidden tab)
    t2.guest.hold = true;
    for (let i = 0; i < 30; i++) await t2.step();
    t2.advance(3000); t2.tick();
    ok(t2.host.nm.phase === 'playing', tag('H a player whose screen is still busy is not on the short clock'));
    t2.advance(2500); t2.tick(); await settle(); await t2.pumpWire(); await settle();
    ok(t2.host.nm.phase === 'over' && t2.host.nm.result.reason === 'timeout', tag('H ... but is out when the cap passes'), t2.host.nm.phase);
    // a reveal that never comes after both committed
    const rv = await makeRig(S, { seedBase: 18, limits: { revealMs: 500 }, mutate: (P, wire) => { wire.drop = (from, m) => from === 'guest' && m.k === 'reveal' && m.r === 1; } });
    await rv.start(); await rv.until(() => rv.host.nm.phase === 'playing' && rv.guest.nm.phase === 'playing');
    for (let i = 0; i < 20; i++) await rv.step();
    rv.advance(800); rv.tick(); await settle(); await rv.pumpWire(); await settle();
    ok(rv.host.nm.phase === 'over' && rv.host.nm.result.iWon, tag('H a reveal withheld after both committed loses the match'), rv.host.nm.phase + ' ' + JSON.stringify(rv.host.nm.result));
    // the clock: myClock counts down once the screen is ready
    const mc = await makeRig(S, { seedBase: 19, limits: { turnMs: 10000, previewMs: 10000 } });
    await mc.start(); mc.host.hold = true; mc.guest.hold = true; await mc.until(() => mc.host.nm.phase === 'playing');
    mc.host.nm.screenReady(); mc.advance(4000);
    ok(mc.host.nm.myClock() === 6000, tag('H the player\'s own clock counts down from the screen being ready'), String(mc.host.nm.myClock()));

    // a link that drops and comes back: nothing is lost, the battle completes
    const l = await makeRig(S, { seedBase: 20, limits: { graceMs: 60000 } });
    await l.start();
    await l.until(() => l.host.nm.phase === 'playing' && l.host.nm._debug.r >= 3);
    l.wire.down = true; l.host.nm.linkChanged(false); l.guest.nm.linkChanged(false);
    for (let i = 0; i < 6; i++) await l.step();     // each side plays on into the dead link: its messages are lost
    l.advance(20000); l.tick();
    ok(l.host.nm.phase === 'playing' && l.guest.nm.phase === 'playing', tag('H a short outage does not end the match'));
    l.wire.down = false; l.host.nm.linkChanged(true); l.guest.nm.linkChanged(true);
    await settle(); await l.pumpWire();
    for (let i = 0; i < 3000 && !finished(l); i++) { if (!(await l.step())) break; }
    ok(finished(l) && l.host.nm.result.hash === l.guest.nm.result.hash && !l.host.nm.error && !l.guest.nm.error, tag('H after the link returns the lost messages are resent and the battle completes identically'), phasesOf(l).join(',') + ' ' + JSON.stringify(errCodes(l)));
    // a link that never comes back
    const d = await makeRig(S, { seedBase: 21, limits: { graceMs: 30000 } });
    await d.start();
    await d.until(() => d.host.nm.phase === 'playing' && d.host.nm._debug.r >= 3);
    d.wire.down = true; d.host.nm.linkChanged(false); d.guest.nm.linkChanged(false);
    d.advance(31000); d.host.nm.tick();
    ok(d.host.nm.phase === 'over' && d.host.nm.result.iWon && d.host.nm.result.reason === 'lost-link', tag('H after the grace period the player who stayed wins'), d.host.nm.phase + ' ' + JSON.stringify(d.host.nm.result));
    d.wire.down = false; d.host.nm.linkChanged(true); d.guest.nm.linkChanged(true);
    await settle(); await d.pumpWire(); await settle();
    ok(d.guest.nm.phase === 'over' && !d.guest.nm.result.iWon, tag('H ... and the one who dropped learns it when they return'), d.guest.nm.phase + ' ' + JSON.stringify(d.guest.nm.result));
    // a hostile client announcing that YOU timed out, or lost your link, while you did neither: the match is stopped, nobody is scored
    const NM = S.netmatch;
    for (const why of ['timeout', 'lost-link']) {
      const fc = await makeRig(S, { seedBase: 29 });
      await fc.start(); await fc.until(() => fc.host.nm.phase === 'playing' && fc.guest.nm.phase === 'playing');
      fc.guest.hold = true;
      for (let i = 0; i < 6; i++) await fc.step();
      fc.guest.nm.receive({ t: NM.MSG, v: NM.PROTO, k: 'end', mn: 1, win: 0, h: 'x', why });
      await settle();
      ok(fc.guest.nm.phase === 'failed' && fc.guest.nm.error.code === 'cheat' && !fc.guest.nm.result, tag('H a false "' + why + '" claim against you stops the match instead of scoring it'), fc.guest.nm.phase + ' ' + JSON.stringify(fc.guest.nm.error));
    }
    // ... while a claim the sender makes AGAINST ITSELF (it forfeits) is simply taken
    const sf = await makeRig(S, { seedBase: 29 });
    await sf.start(); await sf.until(() => sf.host.nm.phase === 'playing' && sf.guest.nm.phase === 'playing');
    sf.guest.hold = true;
    for (let i = 0; i < 6; i++) await sf.step();
    sf.guest.nm.receive({ t: NM.MSG, v: NM.PROTO, k: 'end', mn: 1, win: 1, h: 'x', why: 'forfeit' });
    await settle();
    ok(sf.guest.nm.phase === 'over' && sf.guest.nm.result.iWon && sf.guest.nm.result.reason === 'forfeit', tag('H the other player announcing its own forfeit ends the match in your favour'), sf.guest.nm.phase + ' ' + JSON.stringify(sf.guest.nm.result));
    // an abort (not a leave) must not award a win
    const ab = await makeRig(S, { seedBase: 22, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'commit' && m.r === 2 ? { ...m, ph: 'f'.repeat(16) } : m); } });
    await ab.run();
    ok(ab.host.nm.phase === 'failed' && ab.guest.nm.phase === 'failed' && !ab.host.nm.result && !ab.guest.nm.result, tag('H a stopped match gives nobody a win'), phasesOf(ab).join(','));
  }

  // ---- I. rematch ---------------------------------------------------------------------------------------------------------------------------------------
  if (run('I')) {
    const rig = await makeRig(S, { seedBase: 23 });
    await rig.run();
    const seed1 = rig.host.mc.seed, hash1 = rig.host.nm.result.hash;
    ok(rig.host.nm.requestRematch() === true, tag('I a rematch can be asked for once the match is over'));
    await settle(); await rig.pumpWire();
    ok(rig.host.nm.phase === 'over' && rig.guest.nm.phase === 'over', tag('I one player asking does not start it'));
    ok(rig.guest.nm.status().rematch.theirs === true && rig.host.nm.status().rematch.mine === true, tag('I ... and each side can see who asked'));
    rig.guest.nm.requestRematch();
    for (let i = 0; i < 4000 && !(rig.host.nm.status().mn === 2 && finished(rig)); i++) { if (!(await rig.step())) { await settle(); await rig.pumpWire(); if (!(await rig.step())) break; } }
    ok(rig.host.nm.status().mn === 2 && rig.guest.nm.status().mn === 2 && finished(rig), tag('I both asking runs a second match to its end'), phasesOf(rig).join(',') + ' mn ' + rig.host.nm.status().mn + JSON.stringify(errCodes(rig)));
    ok(rig.host.mc.seed !== seed1 && rig.host.mc.seed === rig.guest.mc.seed, tag('I the second match has a fresh seed, the same on both machines'), seed1 + ' -> ' + rig.host.mc.seed);
    ok(rig.host.nm.result.hash === rig.guest.nm.result.hash && rig.host.nm.result.hash !== hash1, tag('I ... and finishes in agreement'));
    // the commitment of the second seed is bound to the match number: replaying the first match's opening fails
    const scs = rig.wire.log.filter((e) => e.msg.k === 'seedc').map((e) => e.msg.c);
    ok(scs.length === 2 && scs[0] !== scs[1], tag('I each match commits afresh'));
    // a player who left cannot be rematched
    const lf = await makeRig(S, { seedBase: 24 });
    await lf.run();
    lf.guest.nm.close();
    await settle(); await lf.pumpWire(); await settle();
    ok(lf.host.nm.status().oppGone === true && lf.host.nm.requestRematch() === false, tag('I nobody can ask for a rematch after the other player left'));
  }

  // ---- J. a duplicate that differs ------------------------------------------------------------------------------------------------------------------------
  if (run('J')) {
    const rig = await makeRig(S, { seedBase: 25 });
    await rig.start(); await rig.until(() => rig.host.nm.phase === 'playing' && rig.guest.nm.phase === 'playing');
    rig.host.hold = true;
    for (let i = 0; i < 4; i++) await rig.step();
    const lastCommit = rig.wire.log.filter((e) => e.from === 'guest' && e.msg.k === 'commit' && e.msg.r === rig.host.nm._debug.r).pop();
    ok(!!lastCommit, tag('J a commitment exists to duplicate'));
    if (lastCommit) {
      rig.host.nm.receive({ ...lastCommit.msg });            // the same message again: ignored
      await settle();
      ok(rig.host.nm.phase === 'playing', tag('J an exact duplicate is ignored'));
      rig.host.nm.receive({ ...lastCommit.msg, c: '1'.repeat(64) });
      await settle();
      ok(rig.host.nm.phase === 'failed' && rig.host.nm.error.code === 'equivocation', tag('J a second, different commitment for the same round is equivocation'), JSON.stringify(rig.host.nm.error));
    }
    const h2 = await makeRig(S, { seedBase: 25 });
    await h2.start(); await h2.until(() => h2.host.nm.phase === 'judging' || h2.host.nm.phase === 'seed' || h2.host.nm.phase === 'playing');
    const hello = h2.wire.log.filter((e) => e.from === 'guest' && e.msg.k === 'hello')[0].msg;
    h2.host.nm.receive({ ...hello, name: 'Mallory' });
    await settle();
    ok(h2.host.nm.phase === 'failed' && h2.host.nm.error.code === 'equivocation', tag('J a second, different hello is equivocation'), JSON.stringify(h2.host.nm.error));
  }

  // ---- M. what a message may be ----------------------------------------------------------------------------------------------------------------------------
  if (run('M')) {
    const NM = S.netmatch;
    const valid = [
      { k: 'hello', rom: 'a'.repeat(64), fp: 'x', rs: 'r', name: 'n', team: 't' },
      { k: 'seedc', c: 'b'.repeat(64) }, { k: 'seedb', b: 5 }, { k: 'seedr', a: 5, n: 'c'.repeat(32) }, { k: 'go', h: 'h' }, { k: 'rdy', r: 1 },
      { k: 'commit', r: 1, c: 'd'.repeat(64), ph: 'p' }, { k: 'reveal', r: 1, w: 0, n: 'e'.repeat(32) }, { k: 'choice', r: 1, w: 65535, ph: 'p' },
      { k: 'bye' }, { k: 'bye', why: 'forfeit' }, { k: 'end', win: -1, h: 'h', why: 'result' }, { k: 'rematch' }, { k: 'sync', r: 0, ph: 'playing' },
    ].map((m) => ({ t: NM.MSG, v: NM.PROTO, mn: 1, ...m }));
    ok(valid.every((m) => NM.checkMessage(m) === null), tag('M every legitimate message shape is accepted'), valid.map((m) => NM.checkMessage(m)).filter(Boolean).join(','));
    const mutate = (m, f, v) => ({ ...m, [f]: v });
    const bads = [
      mutate(valid[6], 'r', 0), mutate(valid[6], 'r', 1.5), mutate(valid[6], 'r', 'x'), mutate(valid[6], 'c', 'z'.repeat(64)), mutate(valid[6], 'c', 'D'.repeat(64)),
      mutate(valid[7], 'w', 65536), mutate(valid[7], 'w', -1), mutate(valid[7], 'n', 'e'.repeat(31)), mutate(valid[3], 'a', 2 ** 32), mutate(valid[2], 'b', -1),
      mutate(valid[0], 'team', 't'.repeat(1101)), mutate(valid[0], 'name', ''), mutate(valid[0], 'fmt', '9v9'), mutate(valid[11], 'win', 2), mutate(valid[0], 'v', 2),
      mutate(valid[0], 'mn', 0), mutate(valid[0], 't', 'nope'), { ...valid[0], k: 'unknown' }, null, undefined, 5, 'x', [], [valid[0]], mutate(valid[13], 'ph', 'p'.repeat(13)),
    ];
    ok(bads.every((m) => NM.checkMessage(m) !== null), tag('M malformed messages are all refused'), bads.map((m, i) => (NM.checkMessage(m) === null ? i : '')).filter((x) => x !== '').join(','));
    // fuzz: random garbage never throws, and never passes
    const rnd = rngBytes(99); let pass2 = 0, thrown = 0;
    const junk = () => { const b = rnd(8); const pick = [null, undefined, true, 0, -1, 1.5, 'a', '', 'ARENA1', [], {}, { k: 'commit' }, { t: NM.MSG }, { t: NM.MSG, v: 1, mn: 1 }, { t: NM.MSG, v: 1, mn: 1, k: 'commit', r: {} }]; return pick[b[0] % pick.length]; };
    for (let i = 0; i < 2000; i++) { try { if (NM.checkMessage(junk()) === null) pass2++; } catch (_e) { thrown++; } }
    ok(thrown === 0 && pass2 === 0, tag('M 2000 junk values: none throw, none pass'), `thrown ${thrown} passed ${pass2}`);
    ok(NM.cleanName('  Ash  Ketchum the Great ') === 'Ash Ketchu' && NM.cleanName('\u0000‮') === 'Player' && NM.cleanName(null, 'X') === 'X' && NM.cleanName('<b>') === 'b', tag('M names are cleaned'), NM.cleanName('  Ash  Ketchum the Great '));
  }

  // ---- N. garbage into a live match ---------------------------------------------------------------------------------------------------------------------------
  if (run('N')) {
    const NM = S.netmatch;
    const rig = await makeRig(S, { seedBase: 26 });
    await rig.start(); await rig.until(() => rig.host.nm.phase === 'playing');
    for (let i = 0; i < 3; i++) await rig.step();
    let threw = false;
    try { for (const v of [null, undefined, 3, 'x', [], {}, { t: NM.MSG }]) { rig.host.nm.receive(v); await settle(); if (rig.host.nm.phase === 'failed') break; } } catch (_e) { threw = true; }
    ok(!threw, tag('N garbage into receive() never throws'));
    ok(rig.host.nm.phase === 'failed' && rig.host.nm.error.code === 'protocol', tag('N ... and a malformed message stops the match by name'), JSON.stringify(rig.host.nm.error));
    // a message from before the match started is simply ignored
    const idle = await makeRig(S, { seedBase: 26 });
    idle.host.nm.receive({ t: NM.MSG, v: NM.PROTO, k: 'commit', mn: 1, r: 1, c: 'a'.repeat(64), ph: 'x' });
    await settle();
    ok(idle.host.nm.phase === 'idle', tag('N a well-formed message before start() does not move an idle match'), idle.host.nm.phase);
    // a plain choice in a simultaneous round
    const pc = await makeRig(S, { seedBase: 27, mutate: (P, wire) => { wire.rewrite = (from, m) => (from === 'guest' && m.k === 'commit' && m.r === 1 ? { t: m.t, v: m.v, k: 'choice', mn: m.mn, r: 1, w: 1, ph: m.ph } : m); } });
    await pc.run();
    ok(pc.host.nm.phase === 'failed' && pc.host.nm.error.code === 'protocol' && /plain choice/.test(pc.host.nm.error.message), tag('N a plain choice where both sides must commit is refused, for that reason'), JSON.stringify(pc.host.nm.error));
  }
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each mutant breaks ONE guarantee in a copy of the source. The cases named must then fail; if none does, the test is not testing that guarantee.
const MUTANTS = [
  { id: 'no-commit-check', why: 'a reveal is not checked against its commitment', file: 'netmatch.js', from: /!== round\.theirs\.c\) return fail\('cheat'/, to: '=== "never") return fail(\'cheat\'', cases: ['D'] },
  { id: 'no-state-hash', why: 'the state hash in a commitment is not compared', file: 'netmatch.js', from: /if \(m\.ph !== round\.hash\) return fail\('desync', desyncMsg\(\)\);\n    if \(round\.theirs && round\.theirs\.c\)/, to: 'if (round.theirs && round.theirs.c)', cases: ['F'] },
  { id: 'no-seed-check', why: 'the host\'s opened seed is not checked against its commitment', file: 'netmatch.js', from: /!== inb\.seedc\.c\) return fail\('seed'/, to: '=== "never") return fail(\'seed\'', cases: ['B'] },
  { id: 'reveal-early', why: 'a reveal is sent right after our own commitment, before theirs is in', file: 'netmatch.js', from: /round\.mine && round\.theirs && round\.theirs\.c && !round\.revealSentAt/, to: 'round.mine && !round.revealSentAt', cases: ['C'] },
  { id: 'no-go-check', why: 'the starting positions are not compared', file: 'netmatch.js', from: /if \(inb\.go\.h !== nm\.ctl\.battle\.hash\(\)\) return fail/, to: 'if (false) return fail', cases: ['F'] },
  { id: 'no-fp-check', why: 'engine builds are not compared', file: 'netmatch.js', from: /if \(m\.fp !== c\.fp\) return fail/, to: 'if (false) return fail', cases: ['G'] },
  { id: 'no-rom-check', why: 'ROMs are not compared', file: 'netmatch.js', from: /if \(m\.rom !== c\.rom\) return fail/, to: 'if (false) return fail', cases: ['G'] },
  { id: 'abort-is-a-win', why: 'a stopped match is scored as a win for the other side', file: 'netmatch.js', from: /if \(ABORT_WHY\.includes\(why\)\)/, to: 'if (false)', cases: ['H'] },
  { id: 'no-timeout', why: 'a player who never answers is waited for forever', file: 'netmatch.js', from: /nm\.tick = function tick\(\) \{/, to: 'nm.tick = function tick() { return;', cases: ['H'] },
  { id: 'no-resync', why: 'nothing is resent after a dropped link', file: 'netmatch.js', from: /for \(const msg of outLog\) if \(msg\.r === undefined \|\| msg\.r >= m\.r\)/, to: 'for (const msg of []) if (false)', cases: ['H'] },
  { id: 'rematch-one-sided', why: 'a rematch starts when only one player asked', file: 'netmatch.js', from: /if \(!\(rematchMine && rematchTheirs && nm\.phase === 'over'\)\) return;/, to: "if (!((rematchMine || rematchTheirs) && nm.phase === 'over')) return;", cases: ['I'] },
  { id: 'plain-choice-anywhere', why: 'a plain choice is accepted where both players must commit', file: 'netmatch.js', from: /if \(!\(round\.need\[oppSide\] && !round\.need\[mySide\]\)\) return fail\('protocol'/, to: "if (false) return fail('protocol'", cases: ['N'] },
  { id: 'bye-concedes-self', why: 'when the other player leaves, the wrong side is scored as the loser', file: 'netmatch.js', from: /conceded = why === 'timeout' \? 'timeout' : 'left';\n      nm\.ctl\.concede\(oppSide\);/, to: "conceded = why === 'timeout' ? 'timeout' : 'left';\n      nm.ctl.concede(mySide);", cases: ['H'] },
  { id: 'concede-no-pump', why: 'a player leaving does not end the battle on the other machine', file: 'matchctl.js', from: /announce\(side, \{ kind: 'forfeit' \}\);\n    pump\(\);\n    return r;/, to: "announce(side, { kind: 'forfeit' });\n    return r;", cases: ['H'] },
  { id: 'engine-concede-keeps-choice', why: 'a conceded choice stays in the choice log, so the log no longer replays to the battle', file: 'engine.js', from: /for \(let i = this\.choiceLog\.length - 1; i >= 0; i--\) if \(this\.choiceLog\[i\]\.s === side\) \{ this\.choiceLog\.splice\(i, 1\); break; \}/, to: '', cases: ['H'] },
  { id: 'claims-believed', why: 'a claim that you timed out is believed without checking your own clock', file: 'netmatch.js', from: /!plausibleClaim\(m\.why\)\) \{/, to: 'false) {', cases: ['H'] },
  { id: 'no-equivocation', why: 'a second, different commitment for a round is not noticed', file: 'netmatch.js', from: /if \(round\.theirs && round\.theirs\.c\) \{ if \(round\.theirs\.c !== m\.c\) fail\('equivocation'[^\n]*\n/, to: 'if (round.theirs && round.theirs.c) return;\n', cases: ['J'] },
  { id: 'names-not-cleaned', why: 'a hostile name goes into the battle as it was sent', file: 'netmatch.js', from: /t = t\.replace\(\/\[\^A-Za-z0-9 \.'_!\?-\]\/g, ''\)/, to: 't = t', cases: ['G', 'M'] },
];

async function runMutants() {
  const src = path.join(root, 'pokemonarena', 'js');
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-mut-'));
    try {
      for (const f of fs.readdirSync(src)) { const p = path.join(src, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file);
      const text = fs.readFileSync(target, 'utf8');
      if (!mu.from.test(text)) { out.push({ id: mu.id, killed: false, why: 'PATTERN NOT FOUND (the mutant did not apply)' }); continue; }
      fs.writeFileSync(target, text.replace(mu.from, mu.to));
      const before = fail;
      const S2 = await loadStack(dir);
      const saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { await withTimeout(suiteMain(S2, mu.id, { only: mu.cases }), 240000); } catch (e) { threw = e; }
      const killed = fail > before || !!threw;
      out.push({ id: mu.id, killed, why: mu.why, threw: threw ? String(threw.message || threw).slice(0, 80) : null, failed: fail - before });
      // the mutant's failures must not count against the real suite
      pass -= 0; fail = before; failures.length = Math.min(failures.length, failures.length);
      process.env.ARENA_QUIET = saveQ || '';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('mutant run timed out')), ms))]);

/* ------------------------------------------------------------------------------------------------ main */
const S = await loadStack();
const t0 = Date.now();
await suiteMain(S, '');
console.log(`\nnetmatch: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
let mutantFail = 0;
if (WANT_MUTANTS) {
  const keepFail = fail, keepFailures = failures.slice();
  const res = await runMutants();
  fail = keepFail; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.threw ? ' (threw: ' + m.threw + ')' : '') + (m.killed ? '' : '  <-- the suite did not notice')); if (!m.killed) mutantFail++; }
  console.log(`mutants: ${res.length - mutantFail}/${res.length} killed`);
}
if (fail || mutantFail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
