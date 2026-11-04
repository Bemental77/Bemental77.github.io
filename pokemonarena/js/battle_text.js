// pokemonarena/js/battle_text.js -- the battle MESSAGE strings, found in and composed from the SoulGold v1.1.1 ROM.
//
// Pure ES module (browser + Node): no DOM, no node: imports. It holds code, an ASCII catalog of the English text each message
// is expected to have (used as the SEARCH KEY, never shown while the ROM string exists) and nothing ROM-derived: the offsets and
// hashes of the strings that were found live in pokemonarena/text_manifest.json. The text a player reads comes from the ROM's
// own bytes, decoded at runtime in the visitor's browser from the ROM the site already serves.
//
//   import { loadBattleText } from './battle_text.js';
//   const text = loadBattleText(romBytes, manifest);           // manifest = text_manifest.json (or null: the finder runs)
//   text.compose('used', { subj: 'The opposing Pikachu', b3: 'Thunderbolt' })   // -> 'The opposing Pikachu used Thunderbolt!'
//
// HOW A MESSAGE IS FOUND. The ROM's battle message table is the pokeemerald-expansion one, stored back to back (each string 0xFF
// terminated, 4-byte aligned, zero padded) in 0x43c14c..0x444000. A catalog entry is the exact string (placeholders spelled
// `{id}` = the two bytes 0xFD id, `<NL>` = 0xFE, `<PARA>` = 0xFB, `<E>` = e-acute, `<ELL>` = the ellipsis glyph, `<FC 08 40>` = raw
// bytes); findMessage() looks for that byte string between a string boundary (0x00 padding / 0xFF) and a 0xFF terminator.
// text_manifest.json pins {offset, length, SHA-1} per key so a page load does not scan; if the manifest is absent or a hash
// does not match, the finder runs instead; if THAT finds nothing the entry is MISSING and its catalog text is used as a
// flagged fallback (text.report()).
//
// PLACEHOLDER ROLES. A string's `{id}` is filled from the ROLE of that id. The roles below were INFERRED FROM THE WORDING of the
// strings that use them (e.g. `{13} fainted!`, `Go! {5}!`, `It doesn't affect {3f}...`, `{16} only allows the use of {14}!`); the
// ROM code that fills them was not decoded. Where the same id sits in strings that disagree, the entry's own `slots` override it.
// Every `subj` id (the attacker / defender / effect battler "with prefix" names) resolves to the SAME mon in singles, so which of
// the four it is does not matter.

const MAX_LEN = 600;
export const TEXT_REGION = Object.freeze([0x43c14c, 0x444000]);
const MENU_REGION = [0xf43700, 0xf44800];

/* --------------------------------------------------------------------------------------------- the catalog */

// default role of each placeholder id (hex, lower case, no padding)
export const ROLE_OF = Object.freeze({
  '0': 'b1', '1': 'b2', '34': 'b3',
  '5': 'mine', '6': 'foeMon',
  'f': 'subj', '10': 'subj', '11': 'subj', '13': 'subj',
  '3e': 'other', '3f': 'other', '40': 'other', '41': 'other',
  '14': 'move', '16': 'item', '18': 'ability', '19': 'ability', '1a': 'ability', '1b': 'ability',
  '20': 'foeName', '21': 'foeName', '42': 'foeName', '43': 'foeName', '44': 'foeName', '1f': 'foeName',
  '23': 'playerName', '35': 'ownerName',
  '37': 'teamCap', '48': 'teamCap', '38': 'teamLow', '3b': 'teamLow', '47': 'teamLow',
});

// key -> exact ROM string (see the header for the notation). Grouped by what raises the message.
const RAW_MESSAGES = {
  // ---- flow
  'foe.challenge': '{42}<NL>would like to battle!<PARA>',
  'foe.sendout': '{42} sent out {6}!',
  'foe.withdrew': '{42} withdrew {0}!',
  'go.1': 'Go! {5}!',
  'go.2': "You're in charge, {0}!",
  'go.3': 'Go for it, {0}!',
  'go.4': "Your opponent's weak! Get 'em, {0}!",
  'back.1': '{0}, come back!',
  'back.2': 'OK, {0}! Come back!',
  'back.3': 'Good job, {0}! Come back!',
  'back.4': "{0}, that's enough! Come back!",
  'result.win': 'You defeated {42}!<PARA>',
  'result.lose': 'You lost to {42}!',
  'result.draw': 'You battled to a draw against {42}!',
  'forfeit.done': 'The match was forfeited.',
  'forfeit.ask': 'Would you like to give up on this battle and quit now? Quitting the battle is the same as losing the battle.',
  'bag.no': "Items can't be used now.<FC 08 40>",
  'run.no': "No! There's no running from a Trainer battle!<PARA>",
  'draggedout': '{10} was dragged out!<PARA>',
  'wentback': '{f} went back to {35}!',
  // the Gen 3 trainer-battle prompt (Battle Style SWITCH): the foe's next Pokemon is named, then the question; the YES / NO box is the scene's. {1} is the Pokemon about to be sent out (role b2)
  'style.ask': '{42} is about to send out {1}.<PARA>Will you switch your Pok<E>mon?',
  // the hack's own Options menu: the row "Battle Style" and its two values "Shift" (a free switch when an opposing Pokemon faints) and "Set" (the next foe comes in with none). Their strings live outside the battle text region
  'opt.style': { s: 'Battle Style', region: [0xf3ff00, 0xf40000] },
  'opt.shift': { s: '<FC 01 06><FC 03 07>Shift', region: [0x78b100, 0x78b200] },       // (these two carry the options menu's colour codes, FC 01 / FC 03)
  'opt.set': { s: '<FC 01 06><FC 03 07>Set', region: [0x78b100, 0x78b200] },
  // ---- attacking
  'used': '{f} used {34}!',
  'miss': "{f}'s attack missed!",
  'avoid': '{10} avoided the attack!',
  'failed': 'But it failed!',
  'noeffect': 'But it had no effect!',
  'nothing': 'But nothing happened!',
  'immune': "It doesn't affect {3f}<ELL>",
  'crit': 'A critical hit!',
  'super': "It's super effective!",
  'resist': "It's not very effective<ELL>",
  'ohko': "It's a one-hit KO!",
  'multihit': 'The Pok<E>mon was hit {0} time(s)!',
  'confhit': 'It hurt itself in its confusion!',
  'protected': '{13} protected itself!',
  'endured': '{10} endured the hit!',
  'braced': '{f} braced itself!',
  'fell.feint': '{10} fell for the feint!',
  'metronome': 'Waggling a finger let it use {14}!',
  'traced': "It traced {0}'s {1}!",
  'crashed': '{f} kept going and crashed!',
  'recoil': '{f} was damaged by the recoil!',
  'drained': '{10} had its energy drained!',
  'subtook': 'The substitute took damage for {3f}!<PARA>',
  'subset': '{f} put in a substitute!',
  'subfaded': "{10}'s substitute faded!<PARA>",
  'subalready': '{f} already has a substitute!',
  'subnohp': 'But it does not have enough HP left to make a substitute!',
  'shared': 'The battlers shared their pain!',
  'foresaw': '{f} foresaw an attack!',
  'tookattack': '{10} took the {0} attack!',
  'wishcame': "{0}'s wish came true!",
  'taketeam': '{10} took its attacker down with it!',
  'destiny': '{f} is hoping to take its attacker down with it!',
  'oneblow': 'Magnitude {0}!',
  // ---- cannot move
  'cant.slp': '{f} is fast asleep.',
  'cant.frz': '{f} is frozen solid!',
  'cant.par': "{f} couldn't move because it's paralyzed!",
  'cant.flinch': "{f} flinched and couldn't move!",
  'cant.recharge': '{f} must recharge!',
  'cant.truant': '{f} is loafing around!',
  'cant.focus': "{f} lost its focus and couldn't move!",
  'cant.disabled': "{f}'s {14} is disabled!<PARA>",
  'cant.taunt': "{f} can't use {14} after the taunt!<PARA>",
  'cant.struggle': '{f} has no moves left that it can use!<PARA>',
  // ---- two-turn moves
  'charge.generic': '{f} began charging power!',
  'charge.air': '{f} flew up high!',
  'charge.bounce': '{f} sprang up!',
  'charge.ground': '{f} burrowed its way under the ground!',
  'charge.water': '{f} hid underwater!',
  'charge.light': '{f} absorbed light!',
  'charge.head': '{f} tucked in its head!',
  'charge.wind': '{f} whipped up a whirlwind!',
  'charge.sky': '{f} became cloaked in a harsh light!',
  // ---- status
  'st.slp': '{11} fell asleep!',
  'st.psn': '{11} was poisoned!',
  'st.tox': '{11} was badly poisoned!',
  'st.brn': '{11} was burned!',
  'st.frz': '{11} was frozen solid!',
  'st.par': '{11} is paralyzed, so it may be unable to move!',
  'st.rest': '{f} went to sleep!',
  'st.restheal': '{f} slept and restored its HP!',
  'clr.wake': '{f} woke up!',
  'clr.thaw': '{13} thawed out!',
  'clr.generic': "{f}'s status returned to normal!",
  'already.slp': '{10} is already asleep!',
  'already.psn': '{10} is already poisoned!',
  'already.brn': '{10} is already burned!',
  'already.par': '{10} is already paralyzed!',
  'already.conf': '{10} is already confused!',
  'cure.par': "{13}'s {16} cured its paralysis!",
  'cure.psn': "{13}'s {16} cured its poison!",
  'cure.brn': "{13}'s {16} cured its burn!",
  'cure.slp': "{13}'s {16} woke it up!",
  'cure.frz': "{13}'s {16} defrosted it!",
  'cure.conf': "{13}'s {16} snapped it out of its confusion!",
  'conf.start': '{11} became confused!',
  'conf.end': '{f} snapped out of its confusion!',
  'conf.fatigue': '{13} became confused due to fatigue!',
  // ---- hp upkeep
  'hurt.psn': '{f} was hurt by its poisoning!',
  'hurt.brn': '{f} was hurt by its burn!',
  'hurt.seed': "{f}'s health is sapped by Leech Seed!",
  'hurt.sand': '{f} is buffeted by the sandstorm!',
  'hurt.hail': '{f} is buffeted by the hail!',
  'hurt.curse': '{f} is afflicted by the curse!',
  'hurt.trap': '{f} is hurt by {0}!',
  'hurt.spikes': '{13} was hurt by the spikes!',
  'hurt.rocks': 'Pointed stones dug into {41}!',
  'hurt.roughskin': "{f} was hurt by {3f}'s {19}!",
  'hurt.helmet': "{f} was hurt by {3f}'s {0}!",
  'heal.leftovers': '{13} restored a little HP using its {16}!',
  'heal.berry': '{13} restored its health using its {16}!',
  'heal.move': "{10}'s HP was restored.",
  'heal.full': "{10}'s HP is full!",
  'heal.ability': "{f}'s {18} healed it a little bit!",
  'heal.ingrain': '{f} absorbed nutrients with its roots!',
  'heal.aqua': "A veil of water restored {3e}'s HP!",
  'sash': '{10} hung on using its {16}!',
  'herb': '{13} returned its stats to normal using its {16}!',
  'knockoff': "{f} knocked off {3f}'s {16}!",
  'trick': '{f} switched items with its target!',
  'balloon': '{13} floats in the air with its Air Balloon!',
  'resistberry': 'The {16} weakened the damage to {41}!',
  // ---- stats
  'stat.up': "{13}'s {0} {1}rose!",
  'stat.down': "{10}'s {0} {1}fell!",
  'stat.max': "{10}'s {0} won't go any higher!",
  'stat.min': "{10}'s {0} won't go any lower!",
  'stat.abilityblock': "{13}'s {1a} prevents stat loss!",
  'stat.mist': '{13} is protected by the mist!',
  'stat.abilityup': "{f}'s {18} {1}raised its {0}!",
  'stat.reset': "{10}'s stat changes were removed!",
  'stat.haze': 'All stat changes were eliminated!',
  'adv.sharply': 'sharply ',
  'adv.harshly': 'harshly ',
  'adv.drastically': 'drastically ',
  'adv.severely': 'severely ',
  'stat.atk': 'Attack', 'stat.def': 'Defense', 'stat.spe': 'Speed', 'stat.spa': 'Sp. Atk', 'stat.spd': 'Sp. Def',
  'stat.acc': 'accuracy', 'stat.eva': 'evasiveness',
  // ---- weather and field
  'wx.1.start': 'It started to rain!', 'wx.1.tick': 'Rain continues to fall.', 'wx.1.end': 'The rain stopped.',
  'wx.2.start': 'The sunlight turned harsh!', 'wx.2.tick': 'The sunlight is strong.', 'wx.2.end': 'The sunlight faded.',
  'wx.3.start': 'A sandstorm kicked up!', 'wx.3.tick': 'The sandstorm is raging.', 'wx.3.end': 'The sandstorm subsided.',
  'wx.4.start': 'It started to hail!', 'wx.4.tick': 'The hail is crashing down.', 'wx.4.end': 'The hail stopped.',
  'wx.5.start': 'It started to snow!', 'wx.5.tick': 'Snow continues to fall.', 'wx.5.end': 'The snow stopped.',
  'wxab.1': "{13}'s {1a} made it rain!",
  'wxab.2': "{13}'s {1a} intensified the sun's rays!",
  'wxab.3': "{13}'s {1a} whipped up a sandstorm!",
  'hz.spikes': 'Spikes were scattered on the ground all around {3b} team!',
  'hz.tspikes': 'Poison spikes were scattered on the ground all around {3b} team!',
  'hz.rocks': 'Pointed stones float in the air around {3b} team!',
  'hz.web': 'A sticky web has been laid out on the ground around {3b} team!',
  'hz.webcaught': '{13} was caught in a sticky web!',
  'hz.clear.tspikes': 'The poison spikes disappeared from the ground around {47} team!',
  'hz.clear.spikes': 'The spikes disappeared from the ground around {38} team!',
  'hz.clear.rocks': 'The pointed stones disappeared from around {38} team!',
  'hz.clear.web': 'The sticky web has disappeared from the ground around {38} team!',
  'scr.reflect': 'Reflect made {38} team stronger against physical moves!',
  'scr.light': 'Light Screen made {38} team stronger against special moves!',
  'scr.sg': '{37} team cloaked itself in a mystical veil!',
  'scr.tw': 'The Tailwind blew from behind {38} team!',
  'scr.mist': '{37} team became shrouded in mist!',
  'scr.end.sg': '{37} team is no longer protected by Safeguard!',
  'scr.end.tw': "{37} team's Tailwind petered out!",
  'scr.end.generic': "{37} team's {0} wore off!",
  'scr.sgblock': '{13} is protected by Safeguard!',
  'field.tr.on': '{f} twisted the dimensions!',
  'field.tr.off': 'The twisted dimensions returned to normal!',
  // ---- AN1 round 5: what the engine's round 3 added (frostbite, terrain, Gravity, the sports and rooms, primal weather, perish, revive...). Every string below is in the ROM (found at 0x43e4a8..0x443258).
  'st.frb': '{11} got frostbite!',
  'hurt.frb': '{f} was hurt by its frostbite!',
  'cure.frb': "{13}'s {16} cured its frostbite!",
  'clr.frb': "{13}'s frostbite was cured!",
  'tn.1.on': 'Grass grew to cover the battlefield!',
  'tn.2.on': 'An electric current ran across the battlefield!',
  'tn.3.on': 'Mist swirled around the battlefield!',
  'tn.4.on': 'The battlefield got weird!',
  'tn.1.off': 'The grass disappeared from the battlefield.',
  'tn.2.off': 'The electricity disappeared from the battlefield.',
  'tn.3.off': 'The mist disappeared from the battlefield.',
  'tn.4.off': 'The weirdness disappeared from the battlefield!',
  'fld.gravity.on': 'Gravity intensified!',
  'fld.gravity.off': 'Gravity returned to normal!',
  'fld.mud.on': "Electricity's power was weakened!",
  'fld.mud.off': 'The effects of Mud Sport have faded.',
  'fld.water.on': "Fire's power was weakened!",
  'fld.water.off': 'The effects of Water Sport have faded.',
  'fld.wonder.on': 'It created a bizarre area in which Defense and Sp. Def stats are swapped!',
  'fld.wonder.off': 'Wonder Room wore off, and Defense and Sp. Def stats returned to normal!',
  'fld.magic.on': "It created a bizarre area in which Pok<E>mon's held items lose their effects!",
  'fld.magic.off': "Magic Room wore off, and held items' effects returned to normal!",
  'fld.fairy.on': 'No one will be able to run away during the next turn!',
  'fld.ion.on': 'A deluge of ions showers the battlefield!',
  'fld.court.on': '{f} swapped the battle effects affecting each side of the field!',
  'wx.6.start': 'A heavy rain began to fall!',
  'wx.6.end': 'The heavy rain has lifted!',
  'wx.7.start': 'The sunlight turned extremely harsh!',
  'wx.7.end': 'The extremely harsh sunlight faded!',
  'wx.8.start': 'Mysterious strong winds are protecting Flying-type Pok<E>mon!',
  'wx.8.end': 'The mysterious strong winds have dissipated!',
  'perish': "{f}'s perish count fell to {0}!",
  'revive': '{0} was revived and is ready to fight again!',
  'cant.gravity': "{f} can't use {14} because of gravity!<PARA>",
  'cant.love': '{f} is immobilized by love!',
  'cant.torment': "{f} can't use the same move twice in a row due to the torment!<PARA>",
  'cant.imprison': "{f} can't use its sealed {14}!<PARA>",
  'vol.love': '{10} fell in love!',
  'vol.love.end': '{13} got over its infatuation!',
  'vol.torment': '{10} was subjected to torment!',
  'vol.torment.end': '{13} is no longer tormented!',
  'vol.perish': 'All Pok<E>mon that heard the song will faint in three turns!',
  'vol.imprison': '{f} sealed any moves its target shares with it!',
  // ---- volatiles
  'vol.seeded': '{10} was seeded!',
  'vol.taunt': '{10} fell for the taunt!',
  'vol.taunt.end': '{13} shook off the taunt!',
  'vol.encore': '{10} must do an encore!',
  'vol.encore.end': '{13} ended its encore!',
  'vol.disable': "{10}'s {0} was disabled!",
  'vol.disable.end': "{13}'s move is no longer disabled!",
  'vol.yawn': '{10} grew drowsy!',
  'vol.trap': '{10} became trapped in the vortex!',
  'vol.trap.end': '{f} was freed from {0}!',
  'trap.wrap': '{10} was wrapped by {3e}!',
  'trap.bind': '{10} was squeezed by {3e}!',
  'trap.clamp': '{f} clamped down on {3f}!',
  'trap.sand': '{10} became trapped by the quicksand!',
  'trap.magma': '{10} became trapped by swirling magma!',
  'trap.infest': '{10} has been afflicted with an infestation by {3e}!',
  'trap.cage': '{f} trapped {3f}!',
  'trap.snap': '{10} got trapped by a snap trap!',
  'vol.lockon': '{f} took aim at {3f}!',
  'vol.foresight': '{10} was identified!',
  'vol.focus': '{10} is getting pumped!',
  'vol.ingrain': '{f} planted its roots!',
  'vol.aqua': '{f} surrounded itself with a veil of water!',
  'vol.noescape': '{10} can no longer escape!',
  'vol.curse': '{f} cut its own HP and put a curse on {3f}!',
  'vol.destiny': '{f} is hoping to take its attacker down with it!',
  'vol.leechend': '{f} shed Leech Seed!',
  'typechange': '{f} transformed into the {0} type!',
  'typeability': "{f}'s {18} transformed it into the {0} type!",
  'transformed': '{f} transformed into {0}!',
  // ---- abilities
  'ab.intimidate': "{13}'s {1a} cuts {3f}'s Attack!",
  'ab.immune': "{13}'s {1a} made {14} ineffective!",
  'ab.confuse': "{13}'s {1a} prevents confusion!",
  'ab.cursedbody': "{f}'s {34} was disabled by {3f}'s {19}!",
  'ab.trace': "It traced {0}'s {1}!",
  // AN1 round 6: the ability lines the engine's `ability` events had no scene line for (FV1: Neutralizing Gas and the four Ruin abilities showed nothing). Each is a whole ROM string, found once.
  'ab.gas.on': 'Neutralizing gas filled the area!',
  'ab.gas.off': 'The effects of the neutralizing gas wore off!',
  'ab.ruin.spd': "{13}'s {1a} weakened the Sp. Def of all surrounding Pok<E>mon!<PARA>",
  'ab.ruin.atk': "{13}'s {1a} weakened the Attack of all surrounding Pok<E>mon!<PARA>",
  'ab.ruin.def': "{13}'s {1a} weakened the Defense of all surrounding Pok<E>mon!<PARA>",
  'ab.ruin.spa': "{13}'s {1a} weakened the Sp. Atk of all surrounding Pok<E>mon!<PARA>",
  'ab.unnerve': '{48} team is too nervous to eat Berries!',
  'ab.asone': '{13} has two Abilities!',
  'ab.slowstart': '{13} is slow to get going!',
  'ab.harvest': '{f} harvested its {16}!',
  'ab.disguise': "{13}'s disguise was busted!",
  'ab.sturdy': '{10} endured the hit using {19}!',
  'ab.bounce': "{f}'s {14} was bounced back by {3f}'s {19}!",
  'ab.coat': '{11} bounced the {14} back!',
  'ab.syrup': 'A supersweet aroma is wafting from the syrup covering {3e}!',
  'ab.ooze': '{f} sucked up the liquid ooze!',
  'ab.acquired': '{f} acquired {18}!',
  'ab.swapped': '{f} swapped Abilities with its target!',
  'ab.charged': 'Being hit by {14} charged {3f} with power!',
  'stat.abilitymax': "{10}'s {19} maxed its {0}!",
  // AN1 round 7: the lines of every other event / fx code the engine emits that the ROM has a line for (hazards swept away, the copy moves, the volatiles, the items, the per-ability wording, primal weather, wishes ...). Each is a whole ROM string, found once; the codes and their evidence are in tools/pokemonarena_event_codes_test.mjs
  'hz.away.spikes': '{f} blew away Spikes!',
  'hz.away.rocks': '{f} blew away Stealth Rock!',
  'hz.away.web': '{f} blew away Sticky Web!',
  'hz.away.tspikes': '{f} blew away Toxic Spikes!',
  'tidy': 'Tidying up complete!',
  'snatch.set': '{f} waits for a target to make a move!',
  'snatch.done': "{10} snatched {41}'s move!",
  'copy.roleplay': "{f} copied {3f}'s Ability!",
  'copy.acquired': '{10} acquired {19}!',
  'copy.psychup': "{13} copied {40}'s stat changes!",
  'copy.statswap': '{f} switched stat changes with its target!',
  'copy.speedswap': '{f} switched {0} with its target!',
  'copy.mimic': '{f} learned {0}!',
  'copy.naturepower': 'Nature Power turned into {14}!',
  'vol.electrify': "{10}'s moves have been electrified!",
  'vol.embargo': "{10} can't use items anymore!",
  'vol.gastro': "{10}'s Ability was suppressed!",
  'vol.grudge': '{f} wants its target to bear a grudge!',
  'vol.healblock': '{10} was prevented from healing!',
  'vol.laser': '{f} concentrated intensely!',
  'vol.coat': '{f} shrouded itself with Magic Coat!',
  'vol.magnet': '{f} levitated with electromagnetism!',
  'vol.powder': '{10} is covered in powder!',
  'vol.powertrick': '{f} switched its Attack and Defense!',
  'vol.saltcure': '{10} is being salt cured!',
  'vol.skydrop': '{f} took {3f} into the sky!',
  'vol.syrup': '{10} got covered in sticky candy syrup!',
  'vol.tarshot': '{10} became weaker to fire!',
  'vol.telekinesis': '{10} was hurled into the air!',
  'vol.bide.store': '{f} is storing energy!',
  'vol.bide.go': '{f} unleashed its energy!',
  'split.power': '{f} shared its power with the target!',
  'split.guard': '{f} shared its guard with the target!',
  'end.embargo': '{f} can use items again!',
  'end.wore': "{13}'s {0} wore off!",
  'word.magnet': 'electromagnetism',
  'end.telekinesis': '{f} was freed from the telekinesis!',
  'end.throat': '{f} can use sound-based moves again!',
  'cant.healblock': '{f} was prevented from healing!<PARA>',
  'cant.throat': 'The effects of Throat Chop prevent {3e} from using certain moves!<PARA>',
  'hurt.powder': 'When the flame touched the powder on the Pok<E>mon, it exploded!',
  'hurt.barb': '{f} was hurt by the {16}!',
  'dmg.hurt': '{f} was hurt!',
  'dmg.toll': "{f}'s {18} takes its toll!",
  'dmg.tormented': '{10} is tormented!',
  'shedtail': '{f} shed its tail to create a decoy!',
  'heal.terrain': '{f} is healed by the grassy terrain!',
  'grudge.pp': "{f}'s {0} lost all its PP due to the grudge!",
  'item.fling': '{f} flung its {16}!',
  'item.custap': '{f} can act faster than normal, thanks to its {0}!',
  'item.micle': '{13} boosted the accuracy of its next move using {16}!',
  'item.lansat': '{13} used the {16} to get pumped!',
  'item.leppa': '{13} restored PP to its move {0} using its {16}!',
  'item.mirrorherb': "{13} used its Mirror Herb to mirror its opponent's stat changes!",
  'item.redcard': '{13} held up its Red Card against {3e}!',
  'item.eject': '{13} is switched out with the {16}!',
  'item.gem': "The {16} strengthened {3e}'s power!",
  'item.statup': 'Using {16}, the {0} of {41} {1}rose!',
  'item.statdown': 'Using {16}, the {0} of {41} {1}fell!',
  'steal': "{f} stole {40}'s {16}!",
  'barb.attach': 'The {16} attached itself to {3e}!',
  'trick.both': '{f} obtained {0}.<PARA>{10} obtained {1}.',
  'trick.one1': '{f} obtained {0}.',
  'trick.one2': '{10} obtained {1}.',
  'ab.static': "{13}'s {19} paralyzed {40}, so it may be unable to move!",
  'ab.flamebody': "{13}'s {19} burned {40}!",
  'ab.poisonpt': "{11} was poisoned by {41}'s {19}!",
  'ab.sleepspore': "{13}'s {19} made {40} sleep!",
  'ab.cutecharm': "{10}'s {19} infatuated {3e}!",
  'ab.flashfire': "{13}'s {1a} raised the power of Fire-type moves!",
  'wx.fizzle.rain': 'The Fire-type attack fizzled out in the heavy rain!',
  'wx.fizzle.sun': 'The Water-type attack evaporated in the extremely harsh sunlight!',
  'wx.norelief.rain': 'There is no relief from this heavy rain!',
  'wx.norelief.sun': 'The extremely harsh sunlight was not lessened at all!',
  'wx.norelief.winds': 'The mysterious strong winds blow on regardless!',
  'wish.heal': 'The healing wish came true for {41}!',
  'wish.lunar': '{13} became cloaked in mystical moonlight!',
  'cure.healblock': '{13} is cured of its heal block!',
  'copy.instruct': "{10} followed {3e}'s instructions!",
  'item.powerherb': '{f} became fully charged due to its {16}!',
  'ab.pressure': '{13} is exerting its pressure!',
  'ab.moldbreaker': '{13} breaks the mold!',
  'ab.turboblaze': '{13} is radiating a blazing aura!',
  'ab.teravolt': '{13} is radiating a bursting aura!',
  'ab.darkaura': '{13} is radiating a dark aura!',
  'ab.fairyaura': '{13} is radiating a fairy aura!',
  'ab.aurabreak': "{13} reversed all other Pok<E>mon's auras!",
  'ab.anticipation': '{13} shuddered!',
  'ab.forewarn': "{1a} alerted {41} to {40}'s {0}!",
  'ab.frisk': '{f} frisked {3f} and found its {0}!',
  'ab.weatherlock': 'The effects of the weather disappeared.',
  'ab.slowstartend': '{f} finally got its act together!',
  'wx.winds.weak': 'The mysterious strong winds weakened the attack!',
  'trap.free': "{f} got free of {3f}'s {0}!",
  'stk.n': '{f} stockpiled {0}!',
  'stk.end': "{f}'s stockpiled effect wore off!",
  'word.and': ' and ',
  'love.each': '{f} is in love with {41}!',
  'vol.nightmare': '{10} began having a nightmare!',
  'dmg.nightmare': '{f} is locked in a nightmare!',
  'item.bestow': '{10} received {16} from {3e}!',
  'item.burnt': "{11}'s {16} was burnt up!",
  'item.pluck': "{f} stole and ate its target's {16}!",
  'item.recycle': '{f} found one {16}!',
  'heal.raindish': "{f}'s {18} restored its HP a little!",
  'heal.icebody': "{f}'s {18} healed it a little bit!",
  'heal.poisonheal': 'The poisoning healed {3e} a little bit!',
  'bell': 'A bell chimed!',
  'aroma': 'A soothing aroma wafted through the area!',
  'purify': "{f} cured {3f}'s problem!",
  'heal.absorb': '{13} restored HP using its {1a}!',
  'ab.useless': "{13}'s {1a} made {14} useless!",
  'ab.blocks': "{13}'s {1a} blocks {14}!",
  'ab.prevents': "{10}'s {19} prevents {3e} from using {14}!",
  // ---- menus: the party-menu text pool (0xf43700..0xf44800) uses overworld placeholders: {2} = the Pokemon's name
  'party.choose': { s: 'Choose a Pok<E>mon.', region: MENU_REGION },
  'party.nofight': { s: '{2} has no energy<NL>left to battle!<FC 09>', region: MENU_REGION, slots: { '2': 'subj' } },
  'party.already': { s: '{2} is already<NL>in battle!<FC 09>', region: MENU_REGION, slots: { '2': 'subj' } },
  'party.selected': { s: '{2} has already been<NL>selected.<FC 09>', region: MENU_REGION, slots: { '2': 'subj' } },
  'party.trapped': { s: "{2} can't be switched<NL>out!<FC 09>", region: MENU_REGION, slots: { '2': 'subj' } },
  'fainted': '{13} fainted!<PARA>',
  'spite': '{10} lost {1} PP from {0}!',
  'prompt.action': 'What will<NL>{0} do?',
  'bellydrum': '{f} cut its own HP and maximized its Attack!',
  'sel.nopp': "There's no PP left for this move!<PARA>",
  'sel.encore': '{13} can only use {14}!<PARA>',
  'sel.choice': '{16} only allows the use of {14}!<PARA>',
  'sel.vest': 'The effects of the {16} prevent status moves from being used!<PARA>',
  // ---- party / menu words (the lower-case "the opposing " is the capitalised ROM string with its first letter lowered)
  'pfx.foe.cap': 'The opposing ',
  'side.you.cap': 'Your',
  'side.you.low': 'your',
};
export const MESSAGES = Object.freeze(RAW_MESSAGES);
const defOf = (key) => { const v = MESSAGES[key]; return typeof v === 'string' ? { s: v, region: TEXT_REGION, slots: null } : { s: v.s, region: v.region || TEXT_REGION, slots: v.slots || null }; };

// What to show when a message is missing from the ROM and when an event has no ROM message at all. Listed in text.report().
export const FALLBACKS = Object.freeze({
  'abilityTrigger': '{ab}!',
  'turncap': 'The battle was called a draw.',
  'drawn': 'The battle ended in a draw.',
  'stealthrock': 'Pointed stones dug into {mon}!',
});

/* ------------------------------------------------------------------------------------- byte-level helpers */

const hex2 = (n) => n.toString(16).padStart(2, '0');

// A tiny synchronous SHA-1 (RFC 3174) so the manifest check needs neither WebCrypto nor node:crypto.
export function sha1Hex(bytes) {
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const ml = bytes.length;
  const padLen = (((ml + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padLen - 8, Math.floor((ml * 8) / 4294967296), false);
  dv.setUint32(padLen - 4, (ml * 8) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let o = 0; o < padLen; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// Gen-3 character codes for the ASCII a catalog entry spells; the same letters, digits and punctuation the ROM battle text uses.
const PUNCT = new Map(Object.entries({ ' ': 0x00, '!': 0xab, '?': 0xac, '.': 0xad, '-': 0xae, ',': 0xb8, '/': 0xba, ':': 0xf0, "'": 0xb4, '&': 0x2d, '+': 0x2e, '%': 0x5b, '(': 0x5c, ')': 0x5d, ';': 0x36 }));
function charCode(ch) {
  if (PUNCT.has(ch)) return PUNCT.get(ch);
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return 0xa1 + (c - 48);
  if (c >= 65 && c <= 90) return 0xbb + (c - 65);
  if (c >= 97 && c <= 122) return 0xd5 + (c - 97);
  throw new Error('battle_text: no Gen-3 code for ' + JSON.stringify(ch));
}
// the multi-glyph tiles the ROM uses for "PK" "MN" etc. are accepted as {PK} {MN}
const GLYPH_TOKENS = { PK: 0x53, MN: 0x54, PO: 0x55, K: 0x59 };

/** catalog entry -> byte string WITHOUT the terminator. */
export function encodeNeedle(str) {
  const out = [];
  for (let i = 0; i < str.length;) {
    const ch = str[i];
    if (ch === '{') {
      const j = str.indexOf('}', i);
      const name = str.slice(i + 1, j);
      if (/^[0-9a-f]{1,2}$/.test(name)) out.push(0xfd, parseInt(name, 16));
      else if (GLYPH_TOKENS[name] !== undefined) out.push(GLYPH_TOKENS[name]);
      else throw new Error('battle_text: bad placeholder ' + str.slice(i, j + 1));
      i = j + 1; continue;
    }
    if (ch === '<') {
      const j = str.indexOf('>', i);
      const name = str.slice(i + 1, j);
      if (name === 'NL') out.push(0xfe); else if (name === 'PARA') out.push(0xfb); else if (name === 'SCR') out.push(0xfa);
      else if (name === 'E') out.push(0x1b); else if (name === 'ELL') out.push(0xb0);
      else if (/^FC( [0-9A-Fa-f]{2})+$/.test(name)) for (const h of name.split(' ')) out.push(h === 'FC' ? 0xfc : parseInt(h, 16));
      else throw new Error('battle_text: bad token ' + str.slice(i, j + 1));
      i = j + 1; continue;
    }
    out.push(charCode(ch)); i++;
  }
  return Uint8Array.from(out);
}



/** Every offset in [lo, hi) where the needle starts a string (preceded by padding / a terminator, followed by 0xFF). */
export function findMessage(rom, str, region = TEXT_REGION) {
  const n = encodeNeedle(str), out = [];
  const lo = region[0], hi = Math.min(region[1], rom.length) - n.length - 1;
  for (let i = lo; i <= hi; i++) {
    if (rom[i] !== n[0]) continue;
    if (i > lo && rom[i - 1] !== 0xff && rom[i - 1] !== 0x00) continue;
    if (rom[i + n.length] !== 0xff) continue;
    let k = 1;
    while (k < n.length && rom[i + k] === n[k]) k++;
    if (k === n.length) out.push(i);
  }
  return out;
}

// control codes (0xFC xx) and how many parameter bytes follow each (pret's text-control table)
const FC_PARAMS = { 1: 1, 2: 1, 3: 1, 4: 3, 5: 1, 6: 1, 7: 0, 8: 1, 9: 0, 10: 0, 11: 2, 12: 1, 13: 1, 14: 1, 15: 0, 16: 2, 17: 1, 18: 1, 19: 1, 20: 1, 21: 0, 22: 0, 23: 0, 24: 0 };

/** A string in the ROM -> the template text: placeholders `{id}`, line break '\n', paragraph break '\\p', control codes dropped. */
export function decodeTemplate(rom, off) {
  let s = '';
  for (let i = off; i < off + MAX_LEN; i++) {
    const b = rom[i];
    if (b === 0xff) break;
    if (b === 0xfd) { s += '{' + (rom[i + 1]).toString(16) + '}'; i++; continue; }
    if (b === 0xfe || b === 0xfa) { s += '\n'; continue; }
    if (b === 0xfb) { s += '\\p'; continue; }
    if (b === 0xfc) { const c = rom[i + 1]; i += 1 + (FC_PARAMS[c] === undefined ? 0 : FC_PARAMS[c]); continue; }
    s += GLYPH_OUT[b] !== undefined ? GLYPH_OUT[b] : (OUT[b] !== undefined ? OUT[b] : '?');
  }
  return s;
}
const OUT = (() => {
  const t = {};
  for (const [ch, code] of PUNCT) t[code] = ch;
  for (let i = 0; i < 10; i++) t[0xa1 + i] = String(i);
  for (let i = 0; i < 26; i++) { t[0xbb + i] = String.fromCharCode(65 + i); t[0xd5 + i] = String.fromCharCode(97 + i); }
  t[0x1b] = String.fromCharCode(0xe9); t[0xb0] = String.fromCharCode(0x2026); t[0xb5] = String.fromCharCode(0x2642); t[0xb6] = String.fromCharCode(0x2640);
  t[0x35] = '='; t[0xb9] = String.fromCharCode(0xd7); t[0xef] = String.fromCharCode(0x25b6);
  return t;
})();
const GLYPH_OUT = { 0x53: '{PK}', 0x54: '{MN}' };

/* ------------------------------------------------------------------------------------------ the manifest */

function stringBytes(rom, off) {
  let e = off; while (e < off + MAX_LEN && rom[e] !== 0xff) e++;
  return rom.subarray(off, e + 1);
}

/** Dev / test tool: scan the ROM for every catalog entry and return the manifest object (offsets and hashes only). */
export function buildManifest(rom, romSha256 = null) {
  const strings = {}, notFound = [], ambiguous = [];
  for (const key of Object.keys(MESSAGES)) {
    const d = defOf(key);
    const hits = findMessage(rom, d.s, d.region);
    if (!hits.length) { notFound.push(key); continue; }
    if (hits.length > 1) ambiguous.push(key);
    const b = stringBytes(rom, hits[0]);
    strings[key] = { off: hits[0], len: b.length, sha1: sha1Hex(b) };
  }
  return { version: 1, rom: romSha256, region: TEXT_REGION.slice(), count: Object.keys(strings).length, notFound, ambiguous, strings };
}

/* ---------------------------------------------------------------------------------------------- compose */


/**
 * Load the battle text. `manifest` is text_manifest.json (or null); `rom` the pinned ROM bytes.
 * Returns { has, source, template, compose, report, keys, stats }.
 */
export function loadBattleText(rom, manifest = null, o = {}) {
  const tmpl = new Map(), source = new Map(), slotsOf = new Map();           // key -> template string, key -> 'manifest' | 'scan' | 'fallback'
  for (const key of Object.keys(MESSAGES)) {
    let off = -1, how = 'fallback';
    const m = manifest && manifest.strings && manifest.strings[key];
    if (m && Number.isInteger(m.off) && m.off >= 0 && m.off + m.len <= rom.length && (o.trustOffsets || sha1Hex(rom.subarray(m.off, m.off + m.len)) === m.sha1)) { off = m.off; how = 'manifest'; }   // trustOffsets: tests only (a ROM copy with one string altered)
    const d = defOf(key);
    if (off < 0) { const hits = findMessage(rom, d.s, d.region); if (hits.length) { off = hits[0]; how = 'scan'; } }
    if (off >= 0) tmpl.set(key, decodeTemplate(rom, off));
    else tmpl.set(key, decodeNeedleText(d.s));
    slotsOf.set(key, d.slots);
    source.set(key, how);
  }

  // role -> string. Unknown / missing roles render as '?' (and are reported) rather than leaving a raw `{id}` on the screen.
  function fill(t, roles, slots, used) {
    return t.replace(/\{([0-9a-f]{1,2})\}/g, (all, id) => {
      const role = (slots && slots[id]) || ROLE_OF[id];
      if (used) used.add(id);
      const v = role === undefined ? undefined : roles[role];
      return v === undefined || v === null ? '?' : String(v);
    });
  }
  const text = {
    has: (key) => tmpl.has(key),
    template: (key) => { if (!tmpl.has(key)) throw new Error('battle_text: unknown message ' + key); return tmpl.get(key); },
    source: (key) => source.get(key),
    keys: () => Array.from(tmpl.keys()),
    // `roles` supplies the strings for the placeholder roles; the result uses '\n' for a line break and '\\p' for a page break.
    compose(key, roles = {}, slots) { return fill(text.template(key), roles, slots || slotsOf.get(key)); },
    // the same, with trailing whitespace and the page break removed (for one-line labels)
    plain(key, roles = {}, slots) { return text.compose(key, roles, slots).replace(/\\p/g, ' ').replace(/\n/g, ' ').replace(/ +/g, ' ').trim(); },
    report() {
      const bySource = { manifest: 0, scan: 0, fallback: 0 }, fallback = [];
      for (const [k, v] of source) { bySource[v]++; if (v === 'fallback') fallback.push(k); }
      return { total: tmpl.size, bySource, fallback };
    },
  };
  return text;
}

// the catalog entry as readable text (the fallback when the ROM has no such string): placeholders stay `{id}`
export function decodeNeedleText(str) {
  return str.replace(/<NL>/g, '\n').replace(/<PARA>/g, '\\p').replace(/<SCR>/g, '\n').replace(/<E>/g, String.fromCharCode(0xe9)).replace(/<ELL>/g, String.fromCharCode(0x2026)).replace(/<FC[ 0-9A-Fa-f]*>/g, '');
}

