// tools/pokemonarena_netmatch_lib.mjs -- shared rig for the networked-match tests: two netmatch.js instances joined by a scriptable in-memory wire, each driving
// a REAL match controller on a REAL ROM pack, with the engine's own AI standing in for the human at each seat.
//
//   const rig = await makeRig({ seedBase: 7, fmt: '3v3' });
//   await rig.run();                      // plays to the end
//   rig.host / rig.guest                  { nm, ctl, ai, side, log }
//   rig.wire.drop = (from, msg) => true   // lose a message
//
// Nothing here is test logic: it is the infrastructure the test file builds its cases on. Pure ASCII.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
export const ROM_PATH = path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const js = (f) => pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href;

export async function loadStack(dir) {
  const base = dir ? (f) => pathToFileURL(path.join(dir, f)).href : js;
  const [netmatch, om, tables, rom, ai, engine, matchctl] = await Promise.all(['netmatch.js', 'online_match.js', 'tables.js', 'rom.js', 'ai.js', 'engine.js', 'matchctl.js'].map((f) => import(base(f))));
  const romBytes = fs.readFileSync(ROM_PATH);
  const pack = tables.loadPack(romBytes, { verify: 'header', dexText: false });
  return { netmatch, om, tables, rom, ai, engine, matchctl, pack, romBytes };
}

export const settle = () => new Promise((r) => setImmediate(r));

// a deterministic byte stream for a test (xorshift32), so nonces and halves are reproducible
export function rngBytes(seed) {
  let s = (seed >>> 0) || 1;
  return (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; u[i] = s & 255; } return u; };
}

/**
 * opts: seedBase, fmt ('3v3' | '6v6'), teamA / teamB (ARENA1 codes; default random teams), nameA / nameB, limits, mutate(player, which) to wrap a side,
 *       aiLevelA / aiLevelB, fpA / fpB (fingerprint overrides), romA / romB, autoplay (default true)
 */
export async function makeRig(S, opts = {}) {
  const { netmatch, om, pack, ai } = S;
  const seedBase = opts.seedBase === undefined ? 1 : opts.seedBase;
  const fmt = opts.fmt || '3v3';
  const rs = 'arena-gen3-standard';
  const codeA = opts.teamA || await om.randomTeamCode(pack, 100 + seedBase, 6, rs);
  const codeB = opts.teamB || await om.randomTeamCode(pack, 200 + seedBase, 6, rs);
  const fp = om.engineFingerprint(pack);
  const romSha = S.rom.PINNED.sha256;
  const clock = { t: 1000 };
  const wire = { q: { host: [], guest: [] }, drop: null, log: [], down: false, sent: { host: 0, guest: 0 } };
  const players = {};
  const mkPlayer = async (role, code, name, i) => {
    const side = role === 'host' ? 0 : 1;
    const judged = await om.judgeTeamCode(code, pack);
    if (!judged.ok && !opts.allowBadOwn) throw new Error('own team rejected: ' + judged.message);
    const P = { role, side, name, code, log: [], notices: [], ends: [], phases: [], judged, ai: ai.createAi({ pack, level: (role === 'host' ? opts.aiLevelA : opts.aiLevelB) || 'normal', seed: 31 * (i + 1) + seedBase }), chose: 0 };
    const peerRole = role === 'host' ? 'guest' : 'host';
    P.nm = netmatch.createNetMatch({
      role, room: opts.room || 'ROOM' + seedBase, now: () => clock.t, randomBytes: rngBytes(seedBase * 7919 + i * 104729 + 13), limits: opts.limits,
      send: (msg) => {
        let m = JSON.parse(JSON.stringify(msg));
        if (wire.rewrite) { const x = wire.rewrite(role, m); if (x) m = JSON.parse(JSON.stringify(x)); }       // a hostile or buggy sender: what leaves is not what the engine meant
        wire.log.push({ from: role, msg: m });
        wire.sent[role]++;
        if (wire.down) return false;
        if (wire.drop && wire.drop(role, m)) return true;
        wire.q[peerRole].push(m);
        return true;
      },
      mine: { rom: (role === 'host' ? opts.romA : opts.romB) || romSha, fp: (role === 'host' ? opts.fpA : opts.fpB) || fp, rs: judged.rs || rs, name, team: code, size: judged.size || 0, fmt: role === 'host' ? fmt : undefined },
      judge: async (card) => { const j = await om.judgeTeamCode(card.team, pack); P.theirs = j; return j; },
      makeController: ({ seed, mySide, fmt: f, names }) => { P.mc = { seed, names, fmt: f }; return om.buildNetController({ pack, mySide, seed, fmt: f, names, mine: P.judged, theirs: P.theirs }); },
      on: {
        phase: (p, info) => P.phases.push(p), notice: (t, k) => P.notices.push(t + '|' + k), end: (r) => P.ends.push(r),
        controller: (ctl) => { P.ctl = ctl; },
      },
    });
    return P;
  };
  players.host = await mkPlayer('host', codeA, opts.nameA || 'Alice', 0);
  players.guest = await mkPlayer('guest', codeB, opts.nameB || 'Bob', 1);
  if (opts.mutate) opts.mutate(players, wire);

  const deliver = async (to, limit = 10000) => {
    let n = 0;
    while (wire.q[to].length && n++ < limit) { const m = wire.q[to].shift(); players[to].nm.receive(m); await settle(); }
    return n;
  };
  const pumpWire = async () => { let any = 0, n; do { n = (await deliver('host')) + (await deliver('guest')); any += n; } while (n); return any; };
  // the "human": when a request is open for my side, answer it with the AI (once)
  const act = (P) => {
    const ctl = P.nm.ctl;
    if (!ctl || P.nm.phase !== 'playing') return false;
    const req = ctl.pending(P.side);
    if (!req) return false;
    P.nm.screenReady();
    if (P.hold) return false;
    const c = P.ai.choose(req, ctl.view(P.side), { previewInfo: { foe: ctl.previewInfo[P.side ^ 1] } });
    if (!c) return false;
    const r = ctl.submit(P.side, c);
    if (!r.ok) throw new Error('local choice refused: ' + r.code + ' ' + JSON.stringify(c));
    P.chose++;
    return true;
  };
  const rig = {
    S, wire, clock, host: players.host, guest: players.guest, fp, codeA, codeB, pumpWire, deliver,
    async start() { players.host.nm.start(); players.guest.nm.start(); await settle(); await pumpWire(); },
    /** one round of play for both seats + wire; returns true if anything moved */
    async step() {
      let moved = false;
      for (const P of [players.host, players.guest]) if (act(P)) moved = true;
      await settle();
      if (await pumpWire()) moved = true;
      return moved;
    },
    async run(maxSteps = 4000) {
      await rig.start();
      for (let i = 0; i < maxSteps; i++) {
        const moved = await rig.step();
        const done = [players.host, players.guest].every((P) => ['over', 'failed', 'closed'].includes(P.nm.phase));
        if (done) return true;
        if (!moved) { await settle(); if (!(await rig.step())) return false; }
      }
      return false;
    },
    /** step until fn() holds (the handshake judges team codes asynchronously, which takes real event-loop turns, not just microtasks) */
    async until(fn, max = 3000) {
      for (let i = 0; i < max; i++) {
        if (fn()) return true;
        if (!(await rig.step())) await new Promise((r) => setTimeout(r, 1));
      }
      return fn();
    },
    tick() { players.host.nm.tick(); players.guest.nm.tick(); },
    advance(ms) { clock.t += ms; },
  };
  return rig;
}
