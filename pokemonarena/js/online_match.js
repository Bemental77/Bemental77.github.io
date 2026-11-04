// pokemonarena/js/online_match.js -- the Arena-specific half of a networked match, with no DOM and no network: turn a team code into the records the engine
// runs, build the match controller for ONE side of a two-player battle, and fingerprint the engine so two pages on different builds refuse each other by name.
//
//   const mine = await judgeTeamCode(code, pack);            // { ok, rs, size, recs, meta, name } | { ok:false, message }
//   const ctl  = buildNetController({ pack, mySide, seed, fmt, names, mine, theirs });   // started; sides [human|remote] in the right order
//   const fp   = engineFingerprint(pack);                    // same engine + same ROM data => same string
//
// netmatch.js (the protocol) is handed these as callbacks; the page (online.js) and tools/pokemonarena_netmatch_test.mjs use the SAME functions, so what the
// test judges is what the page judges.

import { decodeTeamCode, encodeTeamCode, validateDecodedTeam } from './teamcode.js';
import { createMatchController, randomTeam, teamFromMons, FORMATS, formatOpts } from './matchctl.js';
import { PINNED } from './rom.js';
import { DEFAULT_RULESET_ID } from './rules.js';
import { ENGINE_VERSION } from './engine.js';

const reasons = (v) => v.reasons.slice(0, 3).map((r) => r.message || r.code).join('; ');

/**
 * Decode and validate an ARENA1 team code exactly as the battle page does for ?team= (ROM pin ON, rules-level validation). Never throws.
 * -> { ok:true, rs, size, name, recs, meta, code } | { ok:false, message }
 */
export async function judgeTeamCode(code, pack) {
  try {
    const r = await decodeTeamCode(code, { expectRomSha256: PINNED.sha256 });
    if (!r.ok) return { ok: false, message: r.message || 'The team code could not be read.' };
    const v = validateDecodedTeam(r.team, pack);
    if (!v.ok) return { ok: false, message: 'The team breaks the rules of its ruleset: ' + reasons(v) };
    const t = teamFromMons(r.team.mons, r.team.ruleset);
    return { ok: true, rs: r.team.ruleset, size: r.team.mons.length, name: r.team.name, recs: t.recs, meta: t.meta, code: String(code).replace(/\s+/g, '') };
  } catch (e) { return { ok: false, message: 'The team could not be checked (' + (e && e.message ? e.message : e) + ').' }; }
}

/** Profile-shaped records for a random team (the shape encodeTeamCode takes): the engine's records plus the cosmetic data they do not carry. */
function monsOf(recs, meta) {
  return recs.map((rec, i) => ({
    species: rec.species, nickname: '', level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item || 0,
    moves: rec.moves.map((m) => ({ id: m.id, ppUps: m.ppUps || 0 })), ev: { ...rec.evs }, iv: { ...rec.ivs },
    gender: (meta[i] && (meta[i].gender === 'M' || meta[i].gender === 'F')) ? meta[i].gender : '-', shiny: !!(meta[i] && meta[i].shiny), friendship: 70,
  }));
}

/** A random legal team as a team CODE, so a visitor with no saved team can still play. -> { code } (judge it like any other). */
export async function randomTeamCode(pack, seed, size = 6, ruleset = DEFAULT_RULESET_ID) {
  const t = randomTeam(pack, seed >>> 0, size, ruleset);
  return encodeTeamCode({ name: 'Random', ruleset, romSha256: PINNED.sha256, mons: monsOf(t.recs, t.meta) });
}

/**
 * The controller for ONE machine of a two-player battle. Side 0 is the host's team and side 1 the guest's on BOTH machines, so the two engines are the
 * same engine; only who is the human and who is the remote differs. The controller is returned STARTED (opening events delivered).
 */
export function buildNetController({ pack, mySide, seed, fmt, names, mine, theirs }) {
  if (mySide !== 0 && mySide !== 1) throw new RangeError('mySide must be 0 or 1');
  if (!Object.prototype.hasOwnProperty.call(FORMATS, fmt)) throw new RangeError('format must be 6v6 or 3v3');
  if (mine.rs !== theirs.rs) throw new RangeError('the two teams use different rules');
  const human = { kind: 'human', concede: true }, remote = { kind: 'remote' };
  const teams = mySide === 0 ? [mine.recs, theirs.recs] : [theirs.recs, mine.recs];
  const ctl = createMatchController({
    pack, ruleset: mine.rs, teams, seed: seed >>> 0, ...formatOpts(fmt), names: [String(names[0]), String(names[1])],       // 3v3: pick 3; 6v6: a lead preview (both players choose their lead, committed and revealed together like every other round)
    sides: mySide === 0 ? [human, remote] : [remote, human],
  });
  ctl.start();
  ctl.netMeta = { meta: mySide === 0 ? [mine.meta, theirs.meta] : [theirs.meta, mine.meta], ruleset: mine.rs, pick: FORMATS[fmt].pick, lead: !!FORMATS[fmt].lead, fmt };
  return ctl;
}

/**
 * A short string that is the same on two machines only when their engine and ROM data play a fixed battle identically. It rides in the hello, so a
 * visitor with a cached older script gets "different version of the Arena" rather than a desync twenty turns in.
 */
export function engineFingerprint(pack) {
  const rs = DEFAULT_RULESET_ID;
  const a = randomTeam(pack, 0x1badb002, 6, rs), b = randomTeam(pack, 0x2badcafe, 6, rs);
  const ctl = createMatchController({
    pack, ruleset: rs, teams: [a.recs, b.recs], seed: 0x5eed1234, pick: 3, names: ['A', 'B'],
    sides: [{ kind: 'cpu', level: 'normal', seed: 11 }, { kind: 'cpu', level: 'normal', seed: 22 }],
  });
  ctl.start();
  const i = ctl.info();
  return 'e' + ENGINE_VERSION + '.' + i.hash.slice(0, 16) + '.' + i.logHash.slice(0, 16) + '.' + i.turn;
}
