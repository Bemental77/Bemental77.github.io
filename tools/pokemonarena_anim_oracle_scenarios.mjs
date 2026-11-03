// tools/pokemonarena_anim_oracle_scenarios.mjs -- battle situations the REAL game needs before it will animate a move at all.
//
// A move whose conditions are not met shows NO animation ("But it failed", "It doesn't affect ...", the move simply cannot be used), so the real game
// cannot be recorded for it from the one trainer battle the OR1 oracle has as a checkpoint. Measured on the nine moves that failed there (round 1):
//   Whirlwind 18 / Roar 46 / Teleport 100   -- a TRAINER battle refuses to let the foe (or the user) flee: use a wild battle (user level >= foe level)
//   Disable 50 / Mimic 102 / Mirror Move 119 -- need a move the foe has already used: play one turn first
//   Counter 68                               -- needs a physical hit taken earlier in the same turn: a fast foe with a physical move
//   Recover 105                              -- fails at full HP: wound the user
//   Dragon Rage 82                           -- Marill is Water/Fairy (immune to Dragon): use a foe without the Fairy type
// Each scenario here leaves the oracle at the move menu, ready for captureMove(). `ladder` is the order a batch tries them in; the first scenario in which the
// wanted animation starts is recorded with the result, so a reader can see what each move needed.
import { KEY, FINDINGS, FUNCS, STATUS1 } from './pokemonarena_rom_oracle.mjs';

const ctrl = (o) => o.readU32(FINDINGS.gBattlerControllerFuncs.addr);
async function toMoveMenu(o) {
  o.pressUntil('A', () => ctrl(o) === FUNCS.controller0.moveMenu, { what: 'the move menu', gap: 20 });
  o.runFrames(25);
}
const BULKY = { hp: 300, maxHp: 300 };
const RATTATA = (extra = {}) => ({ species: 19, level: 2, moves: [33], ...extra });

export const SCENARIOS = Object.freeze({
  // the checkpoint every earlier result was recorded from: the scripted trainer battle against Crystal's Marill (Lv4, Water/Fairy), the user is Bob's Sprigatito (Lv5)
  trainer: async (o) => { await o.goto('CK_MOVE_MENU'); },
  // a wild battle: Whirlwind / Roar / Teleport can end it
  wild: async (o) => { await o.startBattle({ foe: RATTATA(), reach: 'action' }); await toMoveMenu(o); },
  // one full turn first (the user's Tackle against a bulky foe that answers with its own Tackle), then the move menu again: the foe now HAS a last move
  prior: async (o) => { await o.startBattle({ foe: RATTATA(BULKY), reach: 'action' }); o.playTurn(0); if (ctrl(o) !== FUNCS.controller0.actionMenu) throw new Error('scenario prior: the turn did not return to the action menu'); await toMoveMenu(o); },
  // the user at a few HP: Recover and the other healing moves are not refused
  wounded: async (o) => { await o.startBattle({ foe: RATTATA(BULKY), reach: 'action' }); o.setBattleMon(0, { hp: 4 }); await toMoveMenu(o); },
  // a foe that outspeeds the user and hits with a physical move: Counter / Mirror Coat-like reflection needs damage taken first
  fastfoe: async (o) => { await o.startBattle({ foe: RATTATA({ ...BULKY, stats: { spe: 300, atk: 60 } }), reach: 'action' }); await toMoveMenu(o); },
  // foes of other types, for the moves the types above are immune to
  ghost: async (o) => { await o.startBattle({ foe: { species: 92, level: 2, moves: [33], ...BULKY }, reach: 'action' }); await toMoveMenu(o); },       // Gastly: Normal / Fighting do nothing, Ghost hits
  rock: async (o) => { await o.startBattle({ foe: { species: 74, level: 2, moves: [33], ...BULKY }, reach: 'action' }); await toMoveMenu(o); },        // Geodude: Electric does nothing
  flying: async (o) => { await o.startBattle({ foe: { species: 16, level: 2, moves: [33], ...BULKY }, reach: 'action' }); await toMoveMenu(o); },      // Pidgey: Ground does nothing
  // Teleport (Gen 8+ behaviour) switches the user out, so the party needs a second Pokemon
  wild2: async (o) => { await o.startBattle({ foe: RATTATA(), player: [{ species: 1289, level: 5, moves: [33] }, { species: 19, level: 5, moves: [33] }], reach: 'action' }); await toMoveMenu(o); },
  // Mimic cannot copy a move the user already knows (the capture gives the user Tackle in slot 1): the foe answers with Scratch instead
  priorScratch: async (o) => { await o.startBattle({ foe: RATTATA({ ...BULKY, moves: [10] }), reach: 'action' }); o.playTurn(0); if (ctrl(o) !== FUNCS.controller0.actionMenu) throw new Error('scenario priorScratch: the turn did not return to the action menu'); await toMoveMenu(o); },
  // a sleeping foe (Dream Eater / Nightmare), a poisoned user is not needed: add statuses here when a move proves to need one
  asleep: async (o) => { await o.startBattle({ foe: RATTATA({ ...BULKY, status: STATUS1.slp }), reach: 'action' }); await toMoveMenu(o); },
});

/** The order a batch tries the scenarios in (cheap and most common first). */
export const LADDER = Object.freeze(['trainer', 'wild', 'prior', 'wounded', 'fastfoe', 'priorScratch', 'wild2', 'ghost', 'rock', 'flying', 'asleep']);
/** The foe's species in each scenario (the engine needs it to draw the same two Pokemon). The user is the game's own Sprigatito (1289) in all of them. */
export const FOE_SPECIES = Object.freeze({ trainer: 183, wild: 19, prior: 19, wounded: 19, fastfoe: 19, priorScratch: 19, wild2: 19, ghost: 92, rock: 74, flying: 16, asleep: 19 });

export async function reachMoveMenu(o, name) {
  const f = SCENARIOS[name];
  if (!f) throw new Error('unknown scenario ' + name);
  await f(o);
}
const words = (b, off) => [0, 1, 2, 3].map((i) => b.readUInt32LE(off + 4 * i));
/** The battle the real game recorded the move in, as engine options: its Random2 / Random() state, the clock, the terrain, which gSprites slots and OBJ palette slots the battle already holds, and
 *  the registers it had left (only those the engine's own battle setup does not already reproduce). Environment, not behaviour: none of it is part of what the comparison tests. */
export function envCtx(cap, terrain) {
  const bsi = cap.anim[0].bsi, bs = [bsi[0], bsi[1]].every((v) => v !== 255 && v < 64) ? [bsi[0], bsi[1]] : [9, 11];
  const spr = cap.anim[0].spr, occ = [];
  for (let i = 0; i < 64; i++) if ((spr[i * 0x44 + 0x3e] & 1) && !bs.includes(i)) occ.push(i);
  const tags = [...Array(16).keys()].map((i) => cap.env0.tags.readUInt16LE(2 * i));
  const io = {};
  for (const r of [0x00, 0x08, 0x0a, 0x0c, 0x0e, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x1c, 0x1e, 0x40, 0x42, 0x44, 0x46, 0x48, 0x4a, 0x4c, 0x50, 0x52, 0x54]) io[r] = cap.ioPrev.readUInt16LE(r);
  const m = cap.env0.mons, battleMons = [0, 1].map((b) => ({ species: m.readUInt16LE(b * 0x98), hp: m.readUInt16LE(b * 0x98 + 0x2a), level: m[b * 0x98 + 0x2c], maxHP: m.readUInt16LE(b * 0x98 + 0x2e) }));
  return { rng2: words(cap.rngPrev, 8), rng1: words(cap.anim[0].rng, 0x18), hour: 22, terrain, battlerSlots: bs, occupiedSlots: occ, paletteTags: tags, reservedPalettes: cap.env0.reserved, io,
    battleTypeFlags: cap.env0.btf, battleMons, tileBitmap: [...cap.env0.tileBitmap],
    // gBattle_BGx_X/Y and gBattle_WINxH/V (0x02001c52..): the battle's VBlank callback rewrites the scroll and window registers from these every frame
    battleVars: cap.varsPrev ? [...Array(12).keys()].map((i) => cap.varsPrev.readUInt16LE(2 * i)) : undefined };
}

/** A capture (without the screenshots) as a gzip-able JSON string, so a result can be re-compared against a changed engine without running the real game again. Scratch only: it holds
 *  RAM images of a ROM-driven run and is never committed. */
export function packCapture(cap, meta) {
  const b64 = (b) => Buffer.from(b).toString('base64');
  return JSON.stringify({ meta, started: cap.started, rngPrev: b64(cap.rngPrev), ioPrev: b64(cap.ioPrev), varsPrev: cap.varsPrev ? b64(cap.varsPrev) : null,
    env0: { ...cap.env0, tags: b64(cap.env0.tags), mons: b64(cap.env0.mons), animSpecies: b64(cap.env0.animSpecies), tileBitmap: b64(cap.env0.tileBitmap) },
    anim: cap.anim.map((a) => ({ f: a.f, active: a.active, io: b64(a.io), tasks: b64(a.tasks), rng: b64(a.rng), bsi: b64(a.bsi), spr: b64(a.spr), blk: b64(a.blk), pf: a.pf ? b64(a.pf) : null })) });
}
export function unpackCapture(json) {
  const o = JSON.parse(json), d = (s) => Buffer.from(s, 'base64');
  return { meta: o.meta, cap: { started: o.started, rngPrev: d(o.rngPrev), ioPrev: d(o.ioPrev), varsPrev: o.varsPrev ? d(o.varsPrev) : null, env0: { ...o.env0, tags: d(o.env0.tags), mons: d(o.env0.mons), animSpecies: d(o.env0.animSpecies), tileBitmap: d(o.env0.tileBitmap) },
    anim: o.anim.map((a) => ({ f: a.f, active: a.active, io: d(a.io), tasks: d(a.tasks), rng: d(a.rng), bsi: d(a.bsi), spr: d(a.spr), blk: d(a.blk), pf: a.pf ? d(a.pf) : null })) } };
}
export { KEY };
