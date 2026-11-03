// tools/pokemonarena_anim_oracle_stat.mjs -- checks the stat-change animation (general 0) against the REAL game, one stat at a time.
//   node tools/pokemonarena_anim_oracle_stat.mjs --dir <oracle state dir> [--out <json>]
// For each of 14 moves that raise / lower one stat (Swords Dance, Harden, Agility, ... Growl, Tail Whip, String Shot, ...) it plays the move in the real battle, waits for the GENERAL
// animation the game launches afterwards (the arrows), records its animArg (the u16 the game keeps at gBattleSpritesDataPtr->animationData->animArg: it encodes WHICH stat and which
// direction), the sprites of every frame, and then runs the engine's `general 0` with that same animArg and compares sprite state frame by frame. The result is the
// real game's own table: stat -> animArg, and whether the engine reproduces each one.
import fs from 'node:fs';
import { openOracle, KEY } from './pokemonarena_rom_oracle.mjs';
import { compareMove } from './pokemonarena_anim_oracle_compare.mjs';
import { reachMoveMenu } from './pokemonarena_anim_oracle_scenarios.mjs';
import { createMoveAnimator } from '../pokemonarena/js/move_anim.js';

const args = process.argv.slice(2), opt = { dir: undefined, out: null };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
const rom = new Uint8Array(fs.readFileSync('gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
const an = await createMoveAnimator({ rom });
const o = await openOracle({ stateDir: opt.dir });
// move, who changes, which stat (ATK 1 DEF 2 SPE 3 SPA 4 SPD 5 ACC 6 EVA 7), +/- amount as the move's effect says
const ONLY = (process.env.STAT_ONLY || '').split(',').filter(Boolean);
const CASES0 = [
  { move: 14, name: 'Swords Dance', stat: 'atk', amt: '+2', on: 'user' }, { move: 106, name: 'Harden', stat: 'def', amt: '+1', on: 'user' }, { move: 97, name: 'Agility', stat: 'spe', amt: '+2', on: 'user' },
  { move: 417, name: 'Nasty Plot', stat: 'spa', amt: '+2', on: 'user' }, { move: 133, name: 'Amnesia', stat: 'spd', amt: '+2', on: 'user' }, { move: 104, name: 'Double Team', stat: 'eva', amt: '+1', on: 'user' },
  { move: 45, name: 'Growl', stat: 'atk', amt: '-1', on: 'foe' }, { move: 39, name: 'Tail Whip', stat: 'def', amt: '-1', on: 'foe' }, { move: 81, name: 'String Shot', stat: 'spe', amt: '-2', on: 'foe' },
  { move: 313, name: 'Fake Tears', stat: 'spd', amt: '-2', on: 'foe' }, { move: 28, name: 'Sand Attack', stat: 'acc', amt: '-1', on: 'foe' }, { move: 230, name: 'Sweet Scent', stat: 'eva', amt: '-2', on: 'foe' },
  { move: 74, name: 'Growth', stat: 'spa', amt: '+1', on: 'user' }, { move: 336, name: 'Howl', stat: 'atk', amt: '+1', on: 'user' },
];
const CASES = ONLY.length ? CASES0.filter((c) => ONLY.includes(c.name)) : CASES0;
const SPR = 0x0203beb4, ANIM = 0x020018b4;
const animArgNow = () => { const bsd = o.readU32(0x02001c4c), ad = bsd ? o.readU32(bsd + 8) : 0; return ad ? o.readU16(ad) : -1; };
const out = [];
for (const c of CASES) {
  let rec = null;
  for (const idle of [0, 5, 11, 17, 23]) {
    await reachMoveMenu(o, 'trainer'); o.runFrames(idle); o.setBattleMon(0, { moves: [c.move, 33, 0, 0], pp: [20, 20, 20, 20] });
    let f = 0, firstDone = false, was = 0, cap = null;
    while (f < 1500) {
      o.core.setKeys(0, KEY.L | (f < 4 ? KEY.A : 0)); o.core.runFrame(); f++;
      const active = o.readU8(ANIM + 5), type = o.readU8(ANIM + 0x3e), idx = o.readU16(ANIM + 0x40);
      if (active && !cap && type === 0 && was === 0 && firstDone) { cap = { f0: f, arg: animArgNow(), idx, attacker: o.readU8(ANIM + 0x22), target: o.readU8(ANIM + 0x21), frames: [], bsi: Buffer.from(o.readBytes(0x02001d4c, 4)) }; }
      if (cap && active) cap.frames.push(Buffer.from(o.readBytes(SPR, 64 * 0x44)));
      if (cap && !active && cap.frames.length > 3) break;
      if (active && type === 1 && !cap) firstDone = true;
      was = active;
    }
    if (cap && cap.frames.length > 3) { rec = cap; break; }
  }
  if (!rec) { out.push({ ...c, error: 'the general animation never started' }); console.log(c.name, 'no general animation'); continue; }
  // the engine, with the real animArg and the real attacker / target (the real general animation: attacker == target == the battler whose stat changed)
  const side = rec.target & 1;
  const r = await compareMove({ an, realSpr: rec.frames, realBsi: rec.frames.map(() => rec.bsi), moveId: 0, kind: 'general', side, ignoreCbs: process.env.STAT_IGNORE_CLONE ? [0x082448d9] : [], ctx: { animArg: rec.arg, attacker: { side, species: side ? 183 : 1289 }, target: { side, species: side ? 183 : 1289 }, bystander: { species: side ? 1289 : 183 } } });
  if (process.env.STAT_DEBUG) for (const m of r.mismatches.slice(0, 3)) console.log('   frame', m.k, 'real-only', m.realOnly.join(' ; ').slice(0, 200), '| engine-only', m.engineOnly.join(' ; ').slice(0, 200));
  out.push({ ...c, animArg: rec.arg, realTarget: rec.target, realAttacker: rec.attacker, realFrames: rec.frames.length, sprites: [r.exact, r.total], offset: r.offset });
  console.log(`${c.name} (${c.stat} ${c.amt} on ${c.on}): real animArg ${rec.arg} (0x${rec.arg.toString(16)}) target battler ${rec.target}, ${rec.frames.length} frames; engine general 0 with that animArg: sprites ${r.exact}/${r.total} (offset ${r.offset})`);
}
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(out, null, 1));
