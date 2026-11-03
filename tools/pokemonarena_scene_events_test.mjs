// tools/pokemonarena_scene_events_test.mjs - the battle scene against what the engine's ROUND 3 added (ENGINE.md section 12): frostbite, terrain, Gravity, the sports and rooms, primal
// weather, perish, Revival Blessing (a switch request whose choices are the FAINTED), and the codes the scene has no line for. No browser.
//
//   node tools/pokemonarena_scene_events_test.mjs
//   ARENA_SKIP_MUTANTS=1 ...   skip the source-mutant half      ARENA_FUZZ=<n> real battles through the scene (default 40)      ARENA_ROM=<gba>
//
// WHAT IT PROVES (every group has a way to fail, shown by the mutant half)
//   text     each new event is shown with the ROM's OWN line for it (the catalog finds every new key in the ROM, none is a fallback), the right line for the right field (a keyword each: a grassy
//            terrain says grass, Gravity says gravity ...), the 11 field starts read differently from each other, an unknown code / field / weather id / why / volatile / ability fx shows NOTHING
//            (never a blank box, never a catalog key such as "wx.9.start") and never throws
//   state    frostbite is the FRB icon on the healthbox and the party screen; terrain / Gravity / primal weather are tags that appear and go; a heal of a Pokemon on the bench (Revival
//            Blessing) does not move the active Pokemon's HP bar
//   revive   a switch request with reason 'revive' opens the party screen on the FAINTED Pokemon the request lists, choosing one submits that slot, choosing a living one submits nothing;
//            the ordinary forced switch is unchanged; the CPU answers a revive request with a slot of the request
//   fuzz     real battles (random legal teams of the new pool) through the scene: no throw, no blank text, no catalog key on screen
//   abilityfx (AN1 round 6, FV1) every ability `fx` code the engine can emit has a row in ABILITY_FX saying what the player sees: the ROM's line for it, the line of the event that follows it, or the HP bar /
//            nothing (then no ROM battle line names the ability: the ROM text table is searched). The rows are checked three ways: the engine SOURCE is scanned for the codes (none new, none gone), all 439
//            registered abilities are played through the real engine (lab battles + a few scenarios for rare codes) and each ability event is played through the real scene with and without itself, and
//            about 60 hand-built checks give the exact lines (subject, order, the engine's own event order, the weather animations). 26 of the mutants are for this section; 4 of them only the sweep can kill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));
let pass = 0, fail = 0, nChecks = 0; const failures = [];
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); } }
const t0 = Date.now();
console.log('pokemonarena scene-events test; ROM', ROM_PATH, rom.length, 'B; node', process.version);

async function loadStack(dir, bust = '') {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + bust;
  const [BT, AI, MC, SC, B, T, AM] = await Promise.all(['battle_text.js', 'ai.js', 'matchctl.js', 'scene.js', 'battle_ui.js', 'tables.js', 'anim_mon.js'].map((f) => import(u(f))));
  return { BT, AI, MC, SC, B, T, AM, dir };
}

const NEW_KEYS = ['st.frb', 'hurt.frb', 'cure.frb', 'clr.frb', 'tn.1.on', 'tn.2.on', 'tn.3.on', 'tn.4.on', 'tn.1.off', 'tn.2.off', 'tn.3.off', 'tn.4.off', 'fld.gravity.on', 'fld.gravity.off', 'fld.mud.on', 'fld.mud.off',
  'fld.water.on', 'fld.water.off', 'fld.wonder.on', 'fld.wonder.off', 'fld.magic.on', 'fld.magic.off', 'fld.fairy.on', 'fld.ion.on', 'fld.court.on', 'wx.6.start', 'wx.6.end', 'wx.7.start', 'wx.7.end', 'wx.8.start', 'wx.8.end',
  'ab.gas.on', 'ab.gas.off', 'ab.ruin.spd', 'ab.ruin.atk', 'ab.ruin.def', 'ab.ruin.spa', 'ab.unnerve', 'ab.asone', 'ab.slowstart', 'ab.harvest', 'ab.disguise', 'ab.sturdy', 'ab.bounce', 'ab.coat', 'ab.syrup', 'ab.ooze', 'ab.acquired', 'ab.swapped', 'ab.charged', 'stat.abilitymax',
  'perish', 'revive', 'cant.gravity', 'cant.love', 'cant.torment', 'cant.imprison', 'vol.love', 'vol.love.end', 'vol.torment', 'vol.torment.end', 'vol.perish', 'vol.imprison'];
const KEYLIKE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const ALLOWED_FALLBACKS = new Set(['lifeorb', 'sludge', 'heal.shell-bell', 'heal.black-sludge', 'dmg.innards-out', 'dmg.solar-power', 'dmg.aftermath', 'dmg.spiky-shield', 'balloonpop', 'policy', 'scr.veil', 'turncap', 'tn.5.on', 'tn.5.off', 'party.notfainted']);

/* ================================================================================================ ability fx codes: the table
 * AN1 round 6 (FV1: Neutralizing Gas and the four Ruin abilities showed the player nothing). Every `fx` code the engine can put on an `ability` event is a row here, and the row says what the PLAYER SEES:
 *   need 'own'     the ability event itself makes the scene say a line (the ROM's own wording for that ability; `rx` is a keyword regex, never the line itself)
 *   need 'effect'  the scene says nothing for the ability event itself; the event that follows it (a stat change, a status, an immunity, a field, a hazard ...) shows a line
 *   need 'silent'  the player sees at most the HP bar move (why 'bar') or nothing at all (why 'state'); the ROM has no line that names the ability (proved by searching the ROM text table for
 *                  its name: `absent`), so no line is invented. `romAlso` records a ROM line that might belong to it but cannot be tied to it from the text table alone.
 * The sweep below plays every ability the engine registers through the real engine (lab battles) and the real scene, and compares what it sees with its row.  */
const UP = /raised its/i;
const OWN = (rx, o) => Object.assign({ need: 'own', rx }, o || {});
const EFF = (o) => Object.assign({ need: 'effect' }, o || {});
const BAR = (o) => Object.assign({ need: 'silent', why: 'bar' }, o || {});
const STT = (why, o) => Object.assign({ need: 'silent', why }, o || {});
const ABILITY_FX = {
  // round 5 (FA2): the entry announcements, Slow Start's end; every line MEASURED in the real game (ROM 0x43fcb8 / 0x4409bc / 0x440978 / 0x440998 / 0x43fc98 / 0x43fc78 / 0x43fc50 / 0x43fcd8 / 0x440890 / 0x4408e4 / 0x440900 / 0x440938)
  'pressure': OWN(/exerting its pressure/i), 'mold-breaker': OWN(/breaks the mold/i), 'turboblaze': OWN(/radiating a blazing aura/i), 'teravolt': OWN(/radiating a bursting aura/i), 'dark-aura': OWN(/radiating a dark aura/i), 'fairy-aura': OWN(/radiating a fairy aura/i),
  'aura-break': OWN(/reversed all other/i), 'weather-lock': OWN(/effects of the weather disappeared/i), 'frisk': OWN(/frisked .* and found its/i, { scn: 1 }), 'forewarn': OWN(/alerted .* to .*'s/i, { scn: 1 }), 'anticipation': OWN(/shuddered/i, { scn: 1 }), 'slow-start-end': OWN(/finally got its act together/i),
  'absorb': OWN(/restored HP using its|made .* useless!|rose!/i, { note: 'MEASURED: restored HP using its <ability> (0x442459), at full HP made <move> useless (0x441688), a stat-raising absorber just the stat line' }), 'abyssal-veil': EFF(), 'aftermath': EFF({ note: 'the damage event says "<attacker> was hurt!" (MEASURED, ROM 0x44090e)' }), 'allseeing-idol': OWN(/doesn't affect/i, { note: 'MEASURED (Levitate, Wonder Guard): the plain It-does-not-affect line' }),
  'anger-point': OWN(/maxed its Attack/i), 'arctic-aura': EFF(), 'armor-tail': OWN(/prevents .* from using/i, { note: 'ROM 0x442479 (not oracle-reached)' }), 'ash-assets': EFF({ note: 'the scorched field line (flagged: the ROM has none)' }), 'aura-shield': EFF(), 'backdraft': EFF(),
  'bad-dreams': EFF({ scn: 1, note: 'the damage event says "<sleeper> is tormented!" (MEASURED in the real game, ROM 0x4409d0)' }),
  'battle-fervor': OWN(UP), 'beast-boost': OWN(UP), 'berserk': OWN(UP), 'blazing-sun': EFF(), 'bloodlust': OWN(UP), 'brand-of-torment': EFF(), 'breaking': EFF(), 'bulletproof': OWN(/blocks/i, { note: 'MEASURED: holder ability blocks move (0x441417)' }),
  'channel-earth': BAR(), 'cheek-pouch': BAR(), 'chilling-neigh': OWN(UP), 'color-change': OWN(/transformed it into the .* type/i), 'competitive': OWN(UP), 'consume': BAR(), 'cotton-down': EFF(),
  'cud-chew': STT('state', { scn: 1, note: 'the berry is eaten again: its own effect shows through its events' }), 'cursed-body': OWN(/was disabled by .*Cursed Body/i), 'cute-charm': OWN(/Cute Charm infatuated/i, { scn: 1, note: 'MEASURED: "<holder>\'s Cute Charm infatuated <victim>!" (0x441855)' }),
  'dancer': OWN(/ used /i, { note: 'the called move IS announced ("<holder> used Dragon Dance!", MEASURED in the real game); the effect events then show their lines', scn: 1 }), 'dauntless-shield': OWN(UP), 'dazzling': OWN(/prevents .* from using/i, { note: 'ROM 0x442479 (not oracle-reached)' }), 'defiant': OWN(UP), 'disguise': OWN(/disguise was busted/i),
  'disquiet': EFF(), 'download': OWN(UP), 'dust-devil': EFF(), 'echoing': STT('state', { note: 'the flinch shows when the target tries to move', scn: 1 }), 'eelevate': OWN(UP), 'effect-spore': OWN(/Effect Spore/i, { note: 'MEASURED (paralysis): "<holder>\'s Effect Spore paralyzed <victim>, so it may be unable to move!" (0x443369); sleep 0x443546 and poison 0x4434e6 are the same family' }),
  'electromagnetism': OWN(/doesn't affect/i, { note: 'MEASURED (Levitate, Wonder Guard): the plain It-does-not-affect line' }), 'electromorphosis': OWN(/charged .* with power/i), 'fill-void': OWN(UP), 'flame-body': OWN(/Flame Body burned/i, { note: 'MEASURED: "<holder>\'s Flame Body burned <victim>!" (0x443455)' }), 'flameburst': EFF(), 'flash-fire': OWN(/Flash Fire raised the power of Fire-type moves/i, { note: 'MEASURED: the FIRST absorption says "raised the power of Fire-type moves!" (0x4423d3), the next ones the immunity line' }),
  'flee': EFF({ note: 'the pivot line' }), 'force-return': BAR(), 'glacial': OWN(UP), 'good-as-gold': EFF(), 'gooey': EFF(), 'gravity-well': EFF(), 'grim-neigh': OWN(UP), 'guard-stance': OWN(UP),
  'harvest': OWN(/harvested its/i), 'haunting': STT('state', { scn: 1, note: 'the flinch shows when the target tries to move' }), 'heatstorm': EFF(), 'hydration': EFF(), 'imposter': EFF({ names: ['Imposter'] }),
  'infernal': EFF(), 'inky': EFF(), 'innards-out': EFF({ note: 'the damage event says "<attacker> was hurt!" (MEASURED, ROM 0x44090e)' }), 'intimidate': OWN(/cuts/i), 'intrepid-sword': OWN(UP), 'jade-bloom': OWN(UP), 'justified': OWN(UP),
  'last-stand': BAR({ elsewhere: { 'last stand': 'the raid shield wording "barrier broke! It\'s making a last stand!"' } }), 'levitate': OWN(/doesn't affect/i, { note: 'MEASURED (Levitate, Wonder Guard): the plain It-does-not-affect line' }),
  'lifesteal': BAR(), 'lingering-aroma': STT('state', { romAlso: 'an ability-acquired line exists for Mummy (shown); the real game showed NO text when a Lingering Aroma holder was hit (oracle, holder not confirmed active)' }),
  'liquid-ooze': OWN(/sucked up the liquid ooze/i, { romNamed: 1 }), 'lunar-cycle': OWN(UP), 'magic-bounce': OWN(/was bounced back by .*Magic Bounce/i), 'magician': EFF(), 'magnify-field': STT('state', { note: 'the weather / terrain lasts two turns longer: nothing to see' }),
  'maim-and-mend': BAR(), 'mending': BAR({ note: 'a cured status shows its own line' }), 'mimicry': OWN(/transformed it into the .* type/i), 'mirage': EFF({ scn: 1 }), 'mirror-armor': EFF({ note: 'the bounced drop shows on the attacker' }),
  'momentum': OWN(UP), 'moody': OWN(UP), 'moxie': OWN(UP), 'mudslide': EFF({ scn: 1 }), 'multitype': OWN(/transformed it into the .* type/i, { scn: 1 }), 'mummy': EFF({ note: 'the copy event says "<attacker> acquired Mummy!" (the ROM line; MEASURED in the real game)' }),
  'neutralizing-gas': OWN(/Neutralizing gas filled the area/i, { romNamed: 1 }), 'opportunist': OWN(UP), 'perish-body': EFF(), 'permafrost': EFF(), 'pickpocket': EFF(), 'plantation': EFF(), 'plasma-surge': EFF(),
  'poison-point': OWN(/Poison Point/i, { note: 'MEASURED: "<victim> was poisoned by <holder>\'s Poison Point!" (0x4434e6)' }), 'poison-touch': EFF(),
  'polarity-shift': STT('state', { note: 'the two Speed stats are exchanged invisibly' }), 'primal-weather': EFF({ note: 'the weather event says the start line and plays the weather animation' }), 'protean': OWN(/transformed it into the .* type/i),
  'queenly-majesty': OWN(/prevents .* from using/i, { note: 'ROM 0x442479 (not oracle-reached)' }), 'rattled': OWN(UP), 'reborn': STT('state', { note: 'the hit leaves 1 HP and the bar fills: the bar moves, no text' }), 'reef-warden': BAR(), 'rejuvenation': BAR(), 'resolute-guard': OWN(UP), 'restoring': EFF(), 'rooted': EFF(),
  'rough-skin': EFF({ note: 'the ROM "was hurt by ... Rough Skin" line' }), 'ruin': OWN(/weakened the (Defense|Sp\. Def|Attack|Sp\. Atk) of all surrounding/i), 'sand-spit': EFF(), 'screen-cleaner': EFF(),
  'seed-sower': EFF(), 'seer': OWN(UP, { scn: 1 }), 'shed-skin': EFF(), 'shockwiring': STT('state', { note: 'charged on entry: nothing to see' }), 'showtime': EFF(), 'skip-step': OWN(UP), 'slow-start': OWN(/slow to get going/i),
  'solar-armor': EFF(), 'solar-power': EFF({ note: 'the damage event says "<mon>\'s Solar Power takes its toll!" (MEASURED, ROM 0x44091d)' }), 'solidify': OWN(UP), 'soothing': EFF({ elsewhere: { soothing: 'the Aromatherapy line "A soothing aroma wafted ..."' } }),
  'soul-heart': OWN(UP), 'soundproof': OWN(/blocks/i, { note: 'MEASURED: holder ability blocks move (0x441417)' }), 'spectral-drain': BAR(), 'speed-boost': OWN(UP), 'spicy-spray': EFF(), 'stamina': OWN(UP), 'static': OWN(/Static paralyzed/i, { note: 'MEASURED: "<holder>\'s Static paralyzed <victim>, so it may be unable to move!" (0x443369)' }),
  'steadfast': OWN(UP, { scn: 1 }), 'steam-engine': OWN(UP), 'stench': STT('state', { note: 'the flinch shows when the target tries to move' }), 'stormrider': EFF(), 'sturdy': OWN(/endured the hit using Sturdy/i, { scn: 1 }),
  'supersweet-syrup': OWN(/supersweet aroma/i), 'surge': EFF({ note: 'the field line' }), 'synchronize': EFF(), 'tangling': EFF(), 'tether': OWN(UP), 'thermal-exchange': OWN(UP), 'toxic-chain': EFF(),
  'toxic-debris': EFF({ note: 'the Toxic Spikes line (the hazard event says "ts", the move "tspikes")' }), 'trace': EFF({ names: ['Trace'], elsewhere: { trace: 'the Trace line "It traced ..." (the copy event shows it)' } }), 'uncanny': EFF(),
  'unnerve': OWN(/too nervous to eat Berries/i), 'volcano-howl': EFF(), 'wandering-spirit': OWN(/swapped Abilities/i), 'water-compaction': OWN(UP), 'weak-armor': EFF(),
  'weather': OWN(/made it rain|intensified the sun|whipped up a sandstorm/i), 'wind-chime': EFF(), 'wind-power': OWN(/charged .* with power/i), 'wind-rider': EFF(), 'windburst': EFF(),
  'wishmaker': STT('state', { note: 'Wish is set; the ROM line is the "wish came true" one at the end (the wish event)' }), 'wonder-guard': OWN(/doesn't affect/i, { note: 'MEASURED (Levitate, Wonder Guard): the plain It-does-not-affect line' }),
};
// ability codes the random sweep reaches too rarely: one small scenario each. spec = a lab spec; entry = the ability holder SWITCHES IN (its entry code runs); seeds = how many seeds to try
const FX_SCN = {
  // round 5 (FA2): the entry announcements that need a foe item / a super effective foe move
  'frisk': { a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Frisk' } }, b: { moves: ['Splash'], it: 'Oran Berry' }, entry: true, seeds: 2 },
  'anticipation': { a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Anticipation', ty: [1] } }, b: { moves: ['Karate Chop'] }, entry: true, seeds: 2 },
  'soundproof': { a: { ab: 'Soundproof' }, b: { moves: ['Hyper Voice'] }, seeds: 2 }, 'sturdy': { a: { ab: 'Sturdy', hp: 100, mhp: 100 }, b: { moves: ['Earthquake'], st: { atk: 600 } }, seeds: 2 },
  'mudslide': { a: { ab: 'Mudslide' }, b: { moves: ['Water Gun'] }, wx: [3, 5], seeds: 2 }, 'electromagnetism': { a: { ab: 'Electromagnetism' }, b: { moves: ['Earthquake'] }, seeds: 2 },
  'mirage': { a: { ab: 'Mirage', moves: ['Tackle'] }, b: { moves: ['Splash'] }, wx: [2, 5], seeds: 60 }, 'cute-charm': { a: { ab: 'Cute Charm', g: 1 }, b: { moves: ['Tackle'], g: 0 }, seeds: 80 },
  'echoing': { a: { ab: 'Echoing', moves: ['Hyper Voice'], st: { spe: 300 } }, b: { moves: ['Splash'] }, seeds: 60 }, 'dancer': { a: { ab: 'Dancer' }, b: { moves: ['Dragon Dance'] }, seeds: 2 },
  'allseeing-idol': { a: { ab: 'Allseeing Idol' }, b: { moves: ['Earthquake'] }, seeds: 2 }, 'bad-dreams': { a: { ab: 'Bad Dreams', moves: ['Splash'] }, b: { moves: ['Splash'], s: 1, sc: 5, hp: 400, mhp: 400 }, seeds: 3 },
  'cud-chew': { a: { ab: 'Cud Chew', it: 'Sitrus Berry', hp: 210, mhp: 400, moves: ['Splash'] }, b: { moves: ['Tackle'] }, seeds: 3 }, 'haunting': { a: { ab: 'Haunting', moves: ['Shadow Ball'], st: { spe: 300 } }, b: { moves: ['Splash'] }, seeds: 60 },
  'seer': { a: { ab: 'Seer', moves: ['Psychic'] }, b: { moves: ['Splash'] }, seeds: 2 }, 'steadfast': { a: { ab: 'Steadfast', moves: ['Splash'] }, b: { moves: ['Fake Out'], st: { spe: 300 } }, seeds: 3 },
  'multitype': { a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Multitype', it: 'Flame Plate' } }, b: { moves: ['Splash'] }, entry: true, seeds: 2 },
};

/* ================================================================================================ ability fx codes: the checks (called from core) */
const LIB = await import(pathToFileURL(path.join(here, 'pokemonarena_engine_lib.mjs')).href);
const EM = await LIB.loadModules(JS);
const BTR = await import(pathToFileURL(path.join(JS, 'battle_text.js')).href);
// the ROM's battle strings, decoded, as one lower-case blob (letters and digits only): "does any ROM line name this ability?"
const normFx = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const romBlob = (() => { const parts = []; let p = BTR.TEXT_REGION[0]; const hi = BTR.TEXT_REGION[1]; while (p < hi) { while (p < hi && (rom[p] === 0xff || rom[p] === 0x00)) p++; if (p >= hi) break; const st = p; while (p < hi && rom[p] !== 0xff) p++; parts.push(normFx(BTR.decodeTemplate(rom, st))); p++; } return parts.join('|'); })();
// every ability fx code the engine source can emit: the literal fx argument of show() and of the helpers that pass one on, plus the direct { t: 'ability', fx } emits
function scanFxCodes() {
  const IDX = { show: 2, entryFoe: 2, entrySelf: 2, eotFoe: 1, chanceStatus: 2, chanceFlinch: 1, prioBlock: 0, charge: 2, windImmune: 1, copyBoosts: 0 };
  const codes = new Set(), dynamic = [];
  const split = (s, start) => { const args = []; let depth = 0, cur = '', q = null; for (let i = start; i < s.length; i++) { const c = s[i]; if (q) { cur += c; if (c === '\\') { cur += s[++i]; continue; } if (c === q) q = null; continue; } if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; } if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; } if (c === ')' || c === ']' || c === '}') { if (depth === 0) { args.push(cur.trim()); return args; } depth--; cur += c; continue; } if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; } cur += c; } return args; };
  for (const f of fs.readdirSync(JS).filter((x) => /^engine.*\.js$/.test(x))) {
    const s = fs.readFileSync(path.join(JS, f), 'utf8'); const re = new RegExp('(?<![\\w.])(' + Object.keys(IDX).join('|') + ')\\(', 'g'); let m;
    while ((m = re.exec(s))) { const a = split(s, m.index + m[0].length)[IDX[m[1]]]; if (a === undefined) continue; const lm = /^'([a-z0-9-]+)'$/.exec(a); if (lm) codes.add(lm[1]); else dynamic.push(f + ': ' + m[1] + '(' + a.slice(0, 40) + ')'); }
    for (const mm of s.matchAll(/t:\s*'ability'[^}]*?fx:\s*('([a-z0-9-]+)'|[^,}]+)/g)) { if (mm[2]) codes.add(mm[2]); else dynamic.push(f + ': direct fx ' + mm[1].slice(0, 40)); }
  }
  return { codes, dynamic };
}
const EFFECT_TYPES = new Set(['stat-change', 'stat-fail', 'status-set', 'status-clear', 'volatile', 'volatile-end', 'type-change', 'immune', 'copy', 'weather', 'field', 'screen', 'screen-end', 'hazard', 'trick', 'item', 'noop', 'stats-reset', 'pivot', 'wish', 'endure', 'drain', 'fail']);
const PRE_TYPES = new Set(['weather', 'field', 'copy', 'screen-end']);       // events the engine emits BEFORE the ability event of the same effect
const FX_MOVES = ['Quick Attack', 'Giga Drain', 'Mega Drain', 'Drain Punch', 'Rain Dance', 'Sunny Day', 'Sandstorm', 'Hail', 'Snowscape', 'Electric Terrain', 'Grassy Terrain', 'Misty Terrain', 'Psychic Terrain', 'Spore', 'Protect', 'Taunt', 'Roar', 'U-turn', 'Fake Out', 'Dragon Dance', 'Growl', 'Leer', 'Screech', 'Charm', 'Toxic', 'Leech Seed', 'Trick Room', 'Gravity', 'Tailwind', 'Wish', 'Haze', 'Defog', 'Light Screen', 'Reflect', 'Aqua Ring', 'Ingrain', 'Belly Drum', 'Substitute', 'Recover', 'Hex', 'Flare Blitz', 'Knock Off', 'Thief', 'Pursuit', 'Crunch', 'Bite', 'Ice Beam', 'Thunder', 'Hurricane', 'Air Slash', 'Bug Buzz', 'Rock Slide', 'Dazzling Gleam', 'Ember', 'Lava Plume', 'Poison Gas', 'Yawn', 'Confuse Ray', 'Attract', 'Swagger', 'Perish Song', 'Skill Swap', 'Worry Seed', 'Role Play', 'Gastro Acid', 'Swords Dance', 'Nasty Plot', 'Calm Mind', 'Roost', 'Close Combat', 'Thunder Wave', 'Will-O-Wisp', 'Memento', 'Explosion', 'Trick', 'Bug Bite', 'Sucker Punch', 'Aqua Jet', 'Extreme Speed', 'Shadow Sneak', 'Focus Punch', 'Dragon Tail', 'Whirlwind', 'Flamethrower', 'Thunderbolt', 'Tackle', 'Psychic', 'Shadow Ball', 'Water Gun', 'Gust', 'Hyper Voice', 'Surf', 'Earthquake', 'Sludge Bomb', 'Dark Pulse'];
const FX_ITEMS = ['Sitrus Berry', 'Oran Berry', 'Lum Berry', 'Focus Sash', 'Leftovers', 'Life Orb', 'Rocky Helmet', 'Air Balloon', 'Black Sludge', 'Shell Bell', 'Electric Seed', 'Grassy Seed', 'Terrain Extender', 'Red Card', 'Eject Button', 'White Herb', 'Mirror Herb', 'Weakness Policy', 'Flame Orb', 'Toxic Orb', 'Power Herb', 0, 0, 0];

async function abilityFxChecks(M, pack, text, rig, t, opts) {
  const abId = (n) => { const a = pack.abilities.find((x) => x && x.name === n); if (!a) throw new Error('no ability ' + n); return a.id; };
  const itId = (n) => pack.items.find((x) => x && x.name === n).id;
  const mvId = (n) => pack.moves.find((x) => x && x.name === n).id;
  const ME = 0, FOE = 1;
  const slotOf = (r, side) => r.ctl.battle.s.sides[side].act;
  const ab = (r, side, name, fx, extra) => Object.assign({ t: 'ability', s: side, m: slotOf(r, side), ab: abId(name), fx }, extra || {});
  const nameOf = (r, side) => { const v = r.scene.view(); return side === ME ? v.player.name : v.foe.name; };
  const lines = (o) => o.texts.map((x) => String(x).replace(/\s+/g, ' ').trim());

  /* ---- 1. the lines the ability events say, one by one (the ROM's own lines, the right subject, the right order) ---- */
  {
    let r = rig(), o;
    // Neutralizing Gas: the entry line; the gas goes with the Pokemon that held it (switch or faint), and its ROM line is said when the LAST holder has gone
    o = r.play([ab(r, ME, 'Neutralizing Gas', 'neutralizing-gas')]);
    t('fx gas: the entry says the ROM line (not a fallback)', lines(o).length === 1 && /^Neutralizing gas filled the area!$/i.test(lines(o)[0]) && text.source('ab.gas.on') !== 'fallback', JSON.stringify(lines(o)));
    o = r.play([{ t: 'switch-out', s: ME, m: slotOf(r, ME) }]);
    t('fx gas: when its holder leaves, the ROM line "wore off" is said once', lines(o).filter((x) => /neutralizing gas wore off/i.test(x)).length === 1 && text.source('ab.gas.off') !== 'fallback', JSON.stringify(lines(o)));
    o = r.play([{ t: 'switch-out', s: ME, m: slotOf(r, ME) }]);
    t('fx gas: ... and not again when the next one leaves', lines(o).filter((x) => /wore off/i.test(x)).length === 0, JSON.stringify(lines(o)));
    r = rig(); r.play([ab(r, ME, 'Neutralizing Gas', 'neutralizing-gas'), ab(r, FOE, 'Neutralizing Gas', 'neutralizing-gas')]);
    o = r.play([{ t: 'switch-out', s: ME, m: slotOf(r, ME) }]);
    t('fx gas: with two holders the gas is still there when the first one leaves (no "wore off")', lines(o).filter((x) => /wore off/i.test(x)).length === 0, JSON.stringify(lines(o)));
    o = r.play([{ t: 'faint', s: FOE, m: slotOf(r, FOE) }]);
    t('fx gas: ... and gone when the last one faints', lines(o).filter((x) => /neutralizing gas wore off/i.test(x)).length === 1, JSON.stringify(lines(o)));
    r = rig(); o = r.play([{ t: 'switch-out', s: ME, m: slotOf(r, ME) }]);
    t('fx gas: a Pokemon that never held it leaves without a "wore off"', lines(o).filter((x) => /wore off/i.test(x)).length === 0, JSON.stringify(lines(o)));
    // the four Ruin abilities: each weakens ITS stat; the four lines are four different ones
    const RUIN = [['Sword of Ruin', /weakened the Defense of all surrounding/i], ['Beads of Ruin', /weakened the Sp\. Def of all surrounding/i], ['Tablets of Ruin', /weakened the Attack of all surrounding/i], ['Vessel of Ruin', /weakened the Sp\. Atk of all surrounding/i]];
    const seenRuin = new Set();
    for (const [nm, re] of RUIN) { r = rig(); o = r.play([ab(r, FOE, nm, 'ruin')]); const l = lines(o); seenRuin.add(l[0]); t('fx ruin: ' + nm + ' says its own ROM line (its stat, its holder, its name)', l.length === 1 && re.test(l[0]) && l[0].includes(nm) && l[0].includes(nameOf(r, FOE)), JSON.stringify(l)); }
    t('fx ruin: the four lines are four different lines', seenRuin.size === 4, String(seenRuin.size));
    t('fx ruin: all four are ROM lines, not fallbacks', ['ab.ruin.def', 'ab.ruin.spd', 'ab.ruin.atk', 'ab.ruin.spa'].every((k) => text.has(k) && text.source(k) !== 'fallback'));
    // Unnerve: the line is about the holder's FOE'S team; As One says its two-Abilities line first
    r = rig(); o = r.play([ab(r, ME, 'Unnerve', 'unnerve')]); t('fx unnerve: the holder is yours -> "The opposing team is too nervous to eat Berries!"', lines(o).length === 1 && /^The opposing team is too nervous to eat Berries!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, FOE, 'Unnerve', 'unnerve')]); t('fx unnerve: the holder is the foe -> "Your team is too nervous to eat Berries!"', lines(o).length === 1 && /^Your team is too nervous to eat Berries!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'As One', 'unnerve')]); t('fx unnerve: As One says "has two Abilities" and then the Unnerve line', lines(o).length === 2 && /has two Abilities!$/i.test(lines(o)[0]) && /too nervous to eat Berries/i.test(lines(o)[1]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Slow Start', 'slow-start')]); t('fx slow start: the ROM line with the holder\'s name', lines(o).length === 1 && /is slow to get going!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, ME)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Frisk', 'frisk', { it: itId('Oran Berry') })]); t('fx frisk: names the item of the foe', lines(o).length === 1 && /frisked .* and found its Oran Berry!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Forewarn', 'forewarn', { mv: mvId('Earthquake') })]); t('fx forewarn: alerts the holder to a move of the foe', lines(o).length === 1 && /alerted .* to .*'s Earthquake!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Anticipation', 'anticipation')]); t('fx anticipation: the holder shuddered', lines(o).length === 1 && /shuddered!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, ME)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Slow Start', 'slow-start-end')]); t('fx slow start end: the ROM line with the name of the holder', lines(o).length === 1 && /finally got its act together!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, ME)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, FOE, 'Supersweet Syrup', 'supersweet-syrup'), { t: 'stat-change', s: ME, m: slotOf(r, ME), stat: 'eva', delta: -1 }]);
    t('fx syrup: the aroma line names the holder, then the evasiveness line', lines(o).length === 2 && /^A supersweet aroma is wafting from the syrup covering /i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, FOE)) && /evasiveness/i.test(lines(o)[1]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, ME, 'Harvest', 'harvest'), { t: 'item', s: ME, m: slotOf(r, ME), it: itId('Sitrus Berry'), fx: 'harvest' }]);
    t('fx harvest: "harvested its Sitrus Berry"', lines(o).length === 1 && /harvested its Sitrus Berry!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // Disguise: busted, NOT "made X ineffective"
    r = rig(); o = r.play([ab(r, FOE, 'Disguise', 'disguise'), { t: 'immune', s: FOE, m: slotOf(r, FOE), why: 'ability', ab: abId('Disguise'), mv: mvId('Tackle') }]);
    t('fx disguise: the ROM line "disguise was busted" and no "ineffective" line', lines(o).length === 1 && /disguise was busted!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // Liquid Ooze: the DRAINER sucked it up
    r = rig(); o = r.play([ab(r, FOE, 'Liquid Ooze', 'liquid-ooze'), { t: 'damage', s: ME, m: slotOf(r, ME), from: 100, to: 90, max: 100, src: 'liquid-ooze', eff: 4096 }]);
    t('fx liquid ooze: the line is about the drainer (the Pokemon that lost the HP)', lines(o).length === 1 && /sucked up the liquid ooze!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, ME)), JSON.stringify(lines(o)));
    // Sturdy: after the bar, before the effectiveness line (MEASURED: the real game's order)
    r = rig(); o = r.play([{ t: 'move-use', s: ME, m: slotOf(r, ME), mv: mvId('Earthquake') }, ab(r, FOE, 'Sturdy', 'sturdy'), { t: 'damage', s: FOE, m: slotOf(r, FOE), from: 100, to: 1, max: 100, src: 'move', mv: mvId('Earthquake'), eff: 8192 }]);
    const ls = lines(o), iS = ls.findIndex((x) => /endured the hit using Sturdy!$/i.test(x)), iE = ls.findIndex((x) => /super effective/i.test(x));
    t('fx sturdy: "endured the hit using Sturdy!" after the move line and BEFORE "It\'s super effective!"', iS > 0 && iE > iS, JSON.stringify(ls));
    // Dancer: the repeated move is announced like any move (MEASURED: "<holder> used Dragon Dance!"); the move Magic Bounce sends back is not (it has its own line)
    r = rig(); o = r.play([ab(r, FOE, 'Dancer', 'dancer'), { t: 'move-use', s: FOE, m: slotOf(r, FOE), mv: mvId('Dragon Dance'), called: 1 }]);
    t('fx dancer: "<holder> used Dragon Dance!"', lines(o).length === 1 && /used Dragon Dance!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, FOE)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([{ t: 'move-use', s: FOE, m: slotOf(r, FOE), mv: mvId('Dragon Dance'), called: 1 }]);
    t('fx: any other called move is not announced as "used"', lines(o).length === 0, JSON.stringify(lines(o)));
    // Magic Bounce / Magic Coat
    r = rig(); o = r.play([ab(r, FOE, 'Magic Bounce', 'magic-bounce'), { t: 'noop', s: FOE, m: slotOf(r, FOE), why: 'bounced', mv: mvId('Leer') }]);
    t('fx magic bounce: "<user>\'s Leer was bounced back by <holder>\'s Magic Bounce!" (one line, no "nothing happened")', lines(o).length === 1 && /'s Leer was bounced back by .*Magic Bounce!$/i.test(lines(o)[0]) && lines(o)[0].startsWith(nameOf(r, ME)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([{ t: 'noop', s: FOE, m: slotOf(r, FOE), why: 'bounced', mv: mvId('Leer') }]);
    t('fx magic coat: the noop event alone is the Magic Coat line ("bounced the Leer back")', lines(o).length === 1 && /bounced the Leer back!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // copies: Mummy (the attacker acquires it), Wandering Spirit (the holder swaps), Cursed Body (the ROM wording)
    r = rig(); o = r.play([ab(r, FOE, 'Mummy', 'mummy'), { t: 'copy', s: ME, m: slotOf(r, ME), how: 'mummy', ab: abId('Mummy') }]);
    t('fx mummy: "<attacker> acquired Mummy!"', lines(o).length === 1 && /acquired Mummy!$/i.test(lines(o)[0]) && lines(o)[0].startsWith(nameOf(r, ME)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, FOE, 'Wandering Spirit', 'wandering-spirit'), { t: 'copy', s: ME, m: slotOf(r, ME), how: 'wandering-spirit', ab: abId('Wandering Spirit') }]);
    t('fx wandering spirit: "<holder> swapped Abilities with its target!"', lines(o).length === 1 && /swapped Abilities with its target!$/i.test(lines(o)[0]) && lines(o)[0].includes(nameOf(r, FOE)), JSON.stringify(lines(o)));
    r = rig(); o = r.play([ab(r, FOE, 'Cursed Body', 'cursed-body'), { t: 'volatile', s: ME, m: slotOf(r, ME), v: 'disable', mv: mvId('Tackle') }]);
    t('fx cursed body: the ROM wording "<move> was disabled by <holder>\'s Cursed Body!" (not the plain disable line)', lines(o).length === 1 && /Tackle was disabled by .*Cursed Body!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // Toxic Debris says 'ts', the move says 'tspikes': the same line
    r = rig(); o = r.play([ab(r, FOE, 'Toxic Debris', 'toxic-debris'), { t: 'hazard', s: ME, hz: 'ts', n: 1 }]);
    t('fx toxic debris: the Toxic Spikes line for the attacker\'s side (the code "ts" is read)', lines(o).length === 1 && /^Poison spikes were scattered on the ground all around /i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // charged (Wind Power / Electromorphosis): after the hit's own lines, with the move's name
    r = rig(); o = r.play([{ t: 'move-use', s: FOE, m: slotOf(r, FOE), mv: mvId('Gust') }, ab(r, ME, 'Wind Power', 'wind-power'), { t: 'volatile', s: ME, m: slotOf(r, ME), v: 'charged' }]);
    t('fx wind power: "Being hit by Gust charged <holder> with power!"', lines(o).length === 2 && /^Being hit by Gust charged .* with power!$/i.test(lines(o)[1]), JSON.stringify(lines(o)));
    // Anger Point: maxed
    r = rig(); o = r.play([ab(r, ME, 'Anger Point', 'anger-point'), { t: 'stat-change', s: ME, m: slotOf(r, ME), stat: 'atk', delta: 12 }]);
    t('fx anger point: "<holder>\'s Anger Point maxed its Attack!"', lines(o).length === 1 && /Anger Point maxed its Attack!$/i.test(lines(o)[0]), JSON.stringify(lines(o)));
    // weather abilities: the ENGINE's order is [weather, ability] (setWeather, then show); the older [ability, weather] reads the same; the animation is the weather's "continues" one
    const WX = [[1, 'Drizzle', /made it rain!$/i, 'general:9'], [2, 'Drought', /intensified the sun's rays!$/i, 'general:10'], [3, 'Sand Stream', /whipped up a sandstorm!$/i, 'general:11'], [5, 'Snow Warning', /snow/i, 'general:12']];
    for (const [w, nm, re, an] of WX) {
      for (const order of ['engine', 'older']) {
        r = rig(); const a = ab(r, ME, nm, 'weather'), wv = { t: 'weather', s: ME, m: slotOf(r, ME), w }; o = r.play(order === 'engine' ? [wv, a] : [a, wv]);
        t('fx weather: ' + nm + ' (' + order + ' event order): one ROM line and the weather animation ' + an, lines(o).length === 1 && re.test(lines(o)[0]) && o.anims.join() === an && r.scene.view().tags.length >= 1, JSON.stringify(lines(o)) + ' ' + o.anims.join());
      }
    }
    r = rig(); o = r.play([{ t: 'weather', s: ME, m: slotOf(r, ME), w: 1 }]);
    t('fx weather: a weather MOVE (no ability event) has no extra animation of its own', lines(o).length === 1 && /^It started to rain!$/i.test(lines(o)[0]) && o.anims.length === 0, JSON.stringify(lines(o)) + ' ' + o.anims.join());
    // primal weather: the start line of the weather, then the SAME animation the real game plays (oracle: Primordial Sea = general 9, Desolate Land = 10, Delta Stream = 29)
    for (const [w, nm, re, an] of [[6, 'Primordial Sea', /heavy rain began to fall!$/i, 'general:9'], [7, 'Desolate Land', /extremely harsh/i, 'general:10'], [8, 'Delta Stream', /strong winds/i, 'general:29']]) {
      for (const order of ['engine', 'older']) {
        r = rig(); const a = ab(r, ME, nm, 'primal-weather'), wv = { t: 'weather', s: ME, m: slotOf(r, ME), w }; o = r.play(order === 'engine' ? [wv, a] : [a, wv]);
        t('fx primal weather: ' + nm + ' (' + order + ' order): the ROM start line (once) and the animation ' + an, lines(o).length === 1 && re.test(lines(o)[0]) && o.anims.join() === an, JSON.stringify(lines(o)) + ' ' + o.anims.join());
      }
    }
    // an ability event with a code nobody knows still shows nothing and never throws
    r = rig(); o = r.play([ab(r, ME, 'Intimidate', 'zzz-ability'), ab(r, FOE, 'Intimidate', 'zzz-2')]);
    t('fx: a code nobody knows shows nothing and does not throw', lines(o).length === 0 && !o.err, JSON.stringify(lines(o)) + ' ' + o.err);
  }

  /* ---- 2. the table: every code the engine can emit, against the engine and the scene ---- */
  const L = LIB.makeLab(EM, pack);
  const scan = scanFxCodes();
  const rows = Object.keys(ABILITY_FX);
  t('fx table: the engine source emits ' + rows.length + ' ability codes: exactly the table\'s rows (none new, none gone)', scan.codes.size === rows.length && rows.every((c) => scan.codes.has(c)) && [...scan.codes].every((c) => ABILITY_FX[c]), 'new: ' + [...scan.codes].filter((c) => !ABILITY_FX[c]).join(',') + ' gone: ' + rows.filter((c) => !scan.codes.has(c)).join(','));
  t('fx table: the only non-literal fx arguments are the helpers\' own `fx` parameter and the As One ternary', scan.dynamic.every((d) => /\((fx|shadow \? 'grim-neigh' : 'chilling-neigh')\)$/.test(d)), scan.dynamic.join(' | '));
  if (opts.fast && opts.only !== 'abilityfx') return;

  // the sweep: every registered ability, as the one that SWITCHES IN (entry codes) or is hit / hits (the others), against random foes, items and moves, through the real engine; plus the scenarios
  const mulberry = LIB.mulberry32;
  const have = (n) => L.D.moveByName[n] !== undefined;
  const moves = FX_MOVES.filter(have), items = FX_ITEMS.filter((n) => n === 0 || L.D.itemByName[n] !== undefined);
  const names = EM.engine_abilities.ABILITY_NAMES.slice();
  const batches = [];                                  // [{ ev, tag }]
  const SEEDS = Number(process.env.ARENA_FXSEEDS || 10), TURNS = Number(process.env.ARENA_FXTURNS || 40);
  const drive = (b, first) => { const out = []; if (first) out.push(L.turn(b, first[0], first[1])); for (let tn = 0; tn < TURNS && b.s.phase !== 'end'; tn++) { let any = false; for (const q of b.requests()) { if (q.phase === 'move') { const okm = q.moves.filter((m) => !m.disabled); b.choose(q.side, q.struggle || !okm.length ? { kind: 'move', slot: 4 } : L.MV(okm[Math.floor(rnd() * okm.length)].slot)); any = true; } else if (q.phase === 'switch' && q.switches[0]) { b.choose(q.side, L.SW(q.switches[0].slot)); any = true; } } if (!any) break; out.push(b.advance()); } return out; };
  let rnd = mulberry(1); let nBattles = 0, nErr = 0;
  for (const nm of names) {
    for (const orient of [0, 1]) for (let seed = 1; seed <= SEEDS; seed++) {
      rnd = mulberry(seed * 977 + orient * 13 + nm.length);
      const mv4 = () => { const a = moves.slice(); const o = []; while (o.length < 4) o.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return o; };
      const st = { atk: 150, def: 100, spa: 150, spd: 100, spe: 100 };
      const sp = (side) => ({ moves: mv4(), bench: [{ moves: mv4() }], benchSpec: {}, hp: 400, mhp: 400, st: Object.assign({}, st, { spe: side === 0 ? 100 : 90 }) });
      const A = sp(0), B = sp(1);
      (orient === 0 ? A : B).benchSpec = { ab: nm, it: items[Math.floor(rnd() * items.length)], hp: 400, mhp: 400, st };
      (orient === 0 ? B : A).benchSpec = { ab: names[Math.floor(rnd() * names.length)], it: items[Math.floor(rnd() * items.length)], hp: 400, mhp: 400, st: Object.assign({}, st, { spe: 95 }) };
      try { const b = L.lab({ a: A, b: B, seed: seed * 101 }); for (const ev of drive(b, orient === 0 ? [L.SW(1), L.MV(0)] : [L.MV(0), L.SW(1)])) batches.push(ev); nBattles++; } catch (e) { nErr++; }
    }
  }
  for (const [code, sc] of Object.entries(FX_SCN)) {
    for (let seed = 1; seed <= sc.seeds; seed++) {
      rnd = mulberry(seed * 31 + code.length);
      try {
        const spec = { a: Object.assign({ moves: ['Splash'] }, sc.a), b: Object.assign({ moves: ['Splash'] }, sc.b), seed: seed * 7 };
        if (sc.wx) spec.wx = sc.wx;
        const b = L.lab(spec);
        for (const ev of drive(b, sc.entry ? [L.SW(1), L.MV(0)] : null)) batches.push(ev);
        nBattles++;
      } catch (e) { nErr++; }
    }
  }
  t('fx sweep: ' + nBattles + ' real-engine battles ran without an engine error', nErr === 0 && nBattles > 1000, nErr + ' errors, ' + nBattles + ' battles');

  // classify each ability event by what the scene shows for it ALONE: its slice (the event, the effect events it caused, the one event before it that the engine emits first) played with and without it
  // each play starts from a FRESH scene: a line can depend on the state the earlier plays left ("is already burned"), and the with / without pair must start from the same one
  const play = (evs) => { const o = rig().play(evs); return { texts: o.texts, err: o.err }; };
  const agg = {}; const shapeMemo = new Map(); let nEvents = 0, nPlays = 0, nThrow = 0; const byAb = new Map();
  for (const ev of batches) {
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]; if (e.t !== 'ability') continue;
      nEvents++; { const an = (pack.abilities[e.ab] && pack.abilities[e.ab].name) || String(e.ab); byAb.set(an, (byAb.get(an) || 0) + 1); }
      const caus = (x) => EFFECT_TYPES.has(x.t) || ((x.t === 'damage' || x.t === 'heal') && x.src === e.fx) || (x.t === 'move-use' && x.called) || (e.fx === 'sturdy' && x.t === 'damage' && x.s === e.s);
      let j = i + 1; while (j < ev.length && caus(ev[j])) j++;
      let k = i; while (k > 0 && PRE_TYPES.has(ev[k - 1].t)) k--;
      const win = ev.slice(k, j), ai = i - k;
      const key = e.fx + '|' + win.map((x) => x.t + (x.fx || '') + (x.how || '') + (x.v || '') + (x.why || '') + (x.src || '')).join(',');
      let cls = shapeMemo.get(key);
      if (!cls) {
        const a = play(win), b2 = play(win.filter((_x, q) => q !== ai)); nPlays += 2; if (a.err || b2.err) nThrow++;
        cls = { cls: a.texts.some((x) => !b2.texts.includes(x)) ? 'own' : a.texts.length ? 'effect' : 'silent', texts: a.texts, only: win.length === 1, bar: win.some((x) => (x.t === 'damage' || x.t === 'heal') && x.src === e.fx) };
        shapeMemo.set(key, cls);
      }
      if (process.env.ARENA_FXDEBUG === e.fx && cls.cls !== 'effect') console.log('FXDEBUG', cls.cls, key, JSON.stringify(cls.texts));
      const g = agg[e.fx] || (agg[e.fx] = { own: 0, effect: 0, silent: 0, silentBusy: 0, bar: 0, ownBad: [], names: new Set(), sample: null });
      g[cls.cls]++; g.names.add((pack.abilities[e.ab] && pack.abilities[e.ab].name) || String(e.ab));
      if (cls.cls === 'silent') { if (!cls.only) g.silentBusy++; if (cls.bar) g.bar++; }
      const row = ABILITY_FX[e.fx];
      if (cls.cls === 'own' && row && row.rx && !cls.texts.some((x) => row.rx.test(x))) g.ownBad.push(JSON.stringify(cls.texts).slice(0, 100));
      if (!g.sample) g.sample = cls.texts;
    }
  }
  t('fx sweep: ' + nEvents + ' ability events from the engine, ' + nPlays + ' scene plays, none throws', nThrow === 0 && nEvents > 2000, nThrow + ' threw, ' + nEvents + ' events');
  // abilities of ENGINE.md section 12 that are mechanics only: the engine never puts an ability event on them, so there is no code to show or to skip (a positive control: the same count finds the ones that do)
  const NO_EVENT = ['Parrying', 'Time Spiral', 'Tidal Deity', 'Generalist', 'Frost Nova'];
  t('fx sweep: the engine emits no ability event for ' + NO_EVENT.join(', ') + ' (mechanics only; their effects show through other events)', NO_EVENT.every((n) => names.includes(n) && !byAb.get(n)) && byAb.get('Intimidate') > 0 && byAb.get('Reborn') > 0, NO_EVENT.map((n) => n + ' ' + (byAb.get(n) || 0)).join(', '));
  const unknown = Object.keys(agg).filter((c) => !ABILITY_FX[c]);
  t('fx sweep: every code the engine emitted is a row of the table', unknown.length === 0, unknown.join(','));
  const missing = rows.filter((c) => !agg[c]);
  t('fx sweep: every row of the table was seen at least once', missing.length === 0, missing.join(','));
  const cnt = { own: 0, effect: 0, silent: 0 };
  for (const c of rows) {
    const row = ABILITY_FX[c], g = agg[c]; cnt[row.need]++; if (!g) continue;
    if (row.need === 'own') t('fx ' + c + ': the ability event says a line (' + g.own + ' of ' + (g.own + g.effect + g.silent) + ' windows)', g.own > 0 && g.ownBad.length === 0, g.ownBad.slice(0, 2).join(' | ') + ' sample ' + JSON.stringify(g.sample));
    else if (row.need === 'effect') t('fx ' + c + ': no line of its own; the effect event shows one (' + g.effect + ' windows), and it never stands silent with an effect on the screen', g.own === 0 && g.effect > 0 && g.silentBusy === 0, 'own ' + g.own + ' effect ' + g.effect + ' silent ' + g.silent + ' (busy ' + g.silentBusy + ')');
    else t('fx ' + c + ': ' + (row.why === 'bar' ? 'only the HP bar moves' : 'nothing visible') + ' (' + g.silent + ' silent windows' + (row.why === 'bar' ? ', ' + g.bar + ' with a bar' : '') + ')', g.own === 0 && g.silent > 0 && (row.why !== 'bar' || g.bar > 0), 'own ' + g.own + ' effect ' + g.effect + ' silent ' + g.silent + ' bar ' + g.bar);
    // the ROM text table: a silent row's ability is named by NO ROM battle line; a row marked romNamed is
    const nms = row.names || [...g.names];
    if (row.need === 'silent') {
      const present = nms.filter((n) => romBlob.includes(normFx(n)) && !(row.elsewhere && row.elsewhere[String(n).toLowerCase()]));
      t('fx ' + c + ': no ROM battle line names ' + nms.join(' / ') + ' (the text table was searched)', present.length === 0, 'named: ' + present.join(','));
    } else if (row.romNamed) {
      t('fx ' + c + ': the ROM text table names ' + nms.join(' / ') + ' (its own line exists)', nms.some((n) => romBlob.includes(normFx(n))), '');
    }
  }
  t('fx table: the three classes add up (' + cnt.own + ' say a line, ' + cnt.effect + ' show through the next event, ' + cnt.silent + ' silent)', cnt.own + cnt.effect + cnt.silent === rows.length && cnt.own > 40 && cnt.effect > 40 && cnt.silent > 10, JSON.stringify(cnt));
  if (process.env.ARENA_FXDUMP) { const dump = rows.map((c) => c + ' [' + ABILITY_FX[c].need + '] own ' + (agg[c] ? agg[c].own : '-') + ' eff ' + (agg[c] ? agg[c].effect : '-') + ' sil ' + (agg[c] ? agg[c].silent : '-') + ' ' + (agg[c] ? JSON.stringify(agg[c].sample).slice(0, 90) : '')); console.log(dump.join('\n')); }
  abilityFxChecks.summary = { rows: rows.length, cnt, nEvents, nBattles, nPlays };
}

async function core(M, opts = {}) {
  const f = [];
  const t = (name, cond, detail) => { nChecks++; if (cond !== true) f.push(name + (detail ? ' [' + String(detail).slice(0, 140) + ']' : '')); };
  const pack = M.T.loadPack(rom, { verify: 'header', dexText: false }), ui = M.B.createBattleUi(rom), text = M.BT.loadBattleText(rom, manifest);

  /* ---- the catalog: every new line is in the ROM ---- */
  t('catalog: every new key is found in the ROM (not a flagged fallback)', NEW_KEYS.every((k) => text.has(k) && text.source(k) !== 'fallback'), NEW_KEYS.filter((k) => !text.has(k) || text.source(k) === 'fallback').join(','));
  t('catalog: the manifest pins every new key (offset, length, SHA-1)', NEW_KEYS.every((k) => manifest.strings[k] && manifest.strings[k].off > 0x43c14c && /^[0-9a-f]{40}$/.test(manifest.strings[k].sha1)), '');

  // the catalog text of a key is only the SEARCH KEY of its ROM string: what the finder finds for it must be what the pinned manifest says (so a catalog line that drifts to another string is caught)
  const found = M.BT.buildManifest(rom, crypto.createHash('sha256').update(rom).digest('hex'));
  t('catalog: the finder finds every new key at the offset and with the SHA-1 the manifest pins', NEW_KEYS.every((k) => found.strings[k] && manifest.strings[k] && found.strings[k].off === manifest.strings[k].off && found.strings[k].sha1 === manifest.strings[k].sha1), NEW_KEYS.filter((k) => !found.strings[k] || !manifest.strings[k] || found.strings[k].off !== manifest.strings[k].off).join(','));

  /* ---- a scene on a real battle, brought to its first action menu; events are injected through the controller ---- */
  function rig() {
    const A = M.MC.randomTeam(pack, 4001, 6), B = M.MC.randomTeam(pack, 4002, 6);
    const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: 7, pick: 0, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 3 }] });
    const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
    const real = ctl.takeEvents.bind(ctl); let pending = null;
    ctl.takeEvents = () => { if (pending) { const e = pending; pending = null; return e; } return real(); };
    ctl.start(); scene.begin();
    let g = 0; while (scene.mode !== 'action' && g++ < 6000) { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
    const r = { ctl, scene, A, B, ok: scene.mode === 'action' };
    // play `events` through the director and the step engine; returns what a player would read, in order, and what the screen says afterwards
    r.play = (events) => {
      const texts = [], steps = [], anims = [], seenQ = new Set(); let err = null, last = null;
      pending = events;
      try {
        for (let n = 0; n < 4000; n++) {
          scene.tick();
          const c = scene.S.cur;
          for (const st of scene.S.queue) if (st.t === 'moveanim' && !seenQ.has(st)) { seenQ.add(st); anims.push(st.kind + ':' + st.id); }       // an animation step may begin and end inside one tick: read it from the queue
          if (c && c !== last) { last = c; steps.push(c.t); if (c.t === 'text') texts.push(c.text); if (c.t === 'moveanim' && !seenQ.has(c)) { seenQ.add(c); anims.push(c.kind + ':' + c.id); } }
          if (c && c.t === 'text' && scene.mode === 'steps') scene.press('a');
          if (!pending && !scene.S.cur && !scene.S.queue.length && scene.mode !== 'steps') break;
        }
      } catch (e) { err = String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | '); }
      return { texts, steps, anims, err, view: scene.view() };
    };
    return r;
  }
  const FOE = 1, ME = 0;
  const mon = (r, side) => { const v = r.scene.view(); return side === ME ? v.player : v.foe; };
  const base = (r, side) => ({ s: side, m: r.ctl.battle.s.sides[side].act });
  const sane = (name, o) => { t(name + ': does not throw', !o.err, o.err); t(name + ': no blank text and no catalog key on screen', o.texts.every((x) => String(x).trim() !== '' && !KEYLIKE.test(String(x).trim())), JSON.stringify(o.texts.filter((x) => String(x).trim() === '' || KEYLIKE.test(String(x).trim())))); };
  const has = (o, re) => o.texts.some((x) => re.test(x));

  let r = rig();
  t('rig: the scene reaches the first action menu on a real battle', r.ok, r.scene.mode);
  if (!r.ok) return f;
  if (opts.only === 'abilityfx') { await abilityFxChecks(M, pack, text, rig, t, opts); return f; }

  /* ---- frostbite ---- */
  {
    r = rig(); const nm = mon(r, FOE).name;
    let o = r.play([{ t: 'status-set', ...base(r, FOE), st: 7 }]); sane('frostbite set', o);
    t('frostbite: set says "got frostbite" with the Pokemon\'s name and the healthbox shows the FRB icon', has(o, /frostbite/i) && o.texts.some((x) => x.includes(nm)) && o.texts.length === 1 && o.view.foe.status === 'FRB', JSON.stringify(o.texts) + ' ' + o.view.foe.status);
    t('frostbite: it is not called poison, burn or freezing', !has(o, /poison|burn|frozen/i), JSON.stringify(o.texts));
    const hp0 = mon(r, FOE).hp, mx = mon(r, FOE).maxHp;
    o = r.play([{ t: 'damage', ...base(r, FOE), from: hp0, to: Math.max(1, hp0 - Math.max(1, mx >> 4)), max: mx, src: 'fbt', eff: 4096 }]); sane('frostbite damage', o);
    t('frostbite: the end-of-turn hurt line, then the bar drains', has(o, /hurt by its frostbite/i) && o.steps.includes('drain') && mon(r, FOE).hp < hp0, JSON.stringify(o.texts) + ' ' + mon(r, FOE).hp + '/' + hp0);
    o = r.play([{ t: 'status-clear', ...base(r, FOE), st: 7, why: 'thaw' }]); sane('frostbite cured', o);
    t('frostbite: cured says so and the icon goes', has(o, /frostbite was cured|cured its frostbite/i) && o.view.foe.status === null, JSON.stringify(o.texts));
    r = rig();
    o = r.play([{ t: 'item', ...base(r, ME), it: 1, fx: 'cure', used: 1 }, { t: 'status-set', ...base(r, ME), st: 7 }]);
    const o2 = r.play([{ t: 'status-clear', ...base(r, ME), st: 7, why: 'berry' }]); sane('frostbite berry', o2);
    t('frostbite: the player\'s own healthbox shows FRB too', o.view.player.status === 'FRB', o.view.player.status);
    // the picture: the icon is drawn, a label the ROM art has none for is not
    const v = r.scene.view(), withIcon = Object.assign({}, v, { foe: Object.assign({}, v.foe, { status: 'FRB' }) }), without = Object.assign({}, v, { foe: Object.assign({}, v.foe, { status: null }) });
    t('frostbite: the healthbox draws the FRB label (the picture differs from no status)', Buffer.compare(Buffer.from(ui.render(withIcon).rgba), Buffer.from(ui.render(without).rgba)) !== 0);
    const party = (st) => ui.render({ screen: 'party', party: { mons: r.A.recs.slice(0, 4).map((x, i) => ({ slot: i, species: x.species, name: 'MON' + i, level: 50, hp: 100, maxHp: 100, status: i === 1 ? st : null, fainted: false, gender: null, shiny: false, active: i === 0 })), cursor: 0, canCancel: false, prompt: ['x'] }, tags: [], overlay: null }).rgba;
    t('frostbite: the party screen draws the FRB icon', Buffer.compare(Buffer.from(party('FRB')), Buffer.from(party(null))) !== 0);
    t('frostbite: the status animation is the freeze one', M.AM.STATUS_ANIM_OF[7] === M.AM.STATUS.FRZ, String(M.AM.STATUS_ANIM_OF[7]));
  }

  /* ---- fields: terrain, Gravity, the sports, the rooms, fairy lock, ion deluge, court change ---- */
  {
    const FIELDS = [['trick-room', /dimension/i, /dimension/i], ['grassy-terrain', /grass/i, /grass/i], ['electric-terrain', /electric current/i, /electricity/i], ['misty-terrain', /mist/i, /mist/i], ['psychic-terrain', /weird/i, /weird/i],
      ['gravity', /gravity intensified/i, /gravity returned/i], ['mud-sport', /electricity.s power/i, /mud sport/i], ['water-sport', /fire.s power/i, /water sport/i], ['wonder-room', /defense and sp\. def stats are swapped/i, /wonder room wore off/i],
      ['magic-room', /held items lose/i, /magic room wore off/i], ['fairy-lock', /run away/i, null], ['ion-deluge', /ions/i, null], ['court-change', /swapped the battle effects/i, null]];
    const starts = [];
    for (const [k, onRe, offRe] of FIELDS) {
      r = rig();
      let o = r.play([{ t: 'field', k, on: 1 }]); sane(k + ' on', o);
      t(k + ': the start shows the ROM line for it (exactly one line)', o.texts.length === 1 && onRe.test(o.texts[0]), JSON.stringify(o.texts));
      starts.push(o.texts[0]);
      o = r.play([{ t: 'field', k, on: 0 }]); sane(k + ' off', o);
      t(k + ': the end ' + (offRe ? 'shows the ROM line for it' : 'shows nothing (the ROM has no line)'), offRe ? o.texts.length === 1 && offRe.test(o.texts[0]) : o.texts.length === 0 || k === 'trick-room', JSON.stringify(o.texts));
    }
    t('fields: the 13 starts read differently from each other (no field shows another field\'s line)', new Set(starts).size === starts.length, starts.length + ' starts, ' + new Set(starts).size + ' distinct');
    r = rig(); let o = r.play([{ t: 'field', k: 'scorched-terrain', on: 1 }]); sane('scorched on', o);
    t('scorched terrain: the ROM has no line, so a flagged line of ours is shown (and listed in scene.fallbacks)', o.texts.length === 1 && r.scene.fallbacks().includes('tn.5.on') && o.view.tags.includes('SCORCHED'), JSON.stringify(o.texts));
    o = r.play([{ t: 'field', k: 'court-change', on: 1, s: ME }]);
    t('court change: the Pokemon that used it is named (the event\'s side, else the last user)', o.texts.length === 1 && o.texts[0].includes(mon(r, ME).name), JSON.stringify(o.texts));
    r = rig(); o = r.play([{ t: 'field', k: 'zzz-field', on: 1 }, { t: 'field', k: 'zzz-field', on: 0 }]); sane('unknown field', o);
    t('an unknown field shows nothing', o.texts.length === 0, JSON.stringify(o.texts));
    // tags
    r = rig(); o = r.play([{ t: 'field', k: 'grassy-terrain', on: 1 }, { t: 'field', k: 'gravity', on: 1 }]);
    t('tags: a terrain and Gravity show as tags while they last', o.view.tags.includes('GRASSY') && o.view.tags.includes('GRAVITY'), JSON.stringify(o.view.tags));
    o = r.play([{ t: 'field', k: 'gravity', on: 0 }]); t('tags: Gravity\'s tag goes with it, the terrain\'s stays', !o.view.tags.includes('GRAVITY') && o.view.tags.includes('GRASSY'), JSON.stringify(o.view.tags));
    o = r.play([{ t: 'field', k: 'psychic-terrain', on: 1 }]); t('tags: a new terrain replaces the old tag', o.view.tags.includes('PSYCHIC') && !o.view.tags.includes('GRASSY'), JSON.stringify(o.view.tags));
    o = r.play([{ t: 'field', k: 'psychic-terrain', on: 0 }]); t('tags: the terrain tag goes when it ends', !o.view.tags.some((x) => /GRASSY|PSYCHIC|ELECTRIC|MISTY|SCORCHED/.test(x)), JSON.stringify(o.view.tags));
    t('the tag plates are drawn (the picture differs from no tags)', Buffer.compare(Buffer.from(ui.render(Object.assign({}, r.scene.view(), { tags: ['GRASSY', 'GRAVITY'] })).rgba), Buffer.from(ui.render(Object.assign({}, r.scene.view(), { tags: [] })).rgba)) !== 0);
  }

  /* ---- weather: the primal weathers (6 heavy rain, 7 harsh sun, 8 strong winds), and an id nobody knows ---- */
  {
    const RE = { 6: [/heavy rain began/i, /heavy rain has lifted/i], 7: [/extremely harsh/i, /extremely harsh sunlight faded/i], 8: [/strong winds/i, /dissipated/i] };
    for (const w of [6, 7, 8]) {
      r = rig(); let o = r.play([{ t: 'weather', s: FOE, m: 0, w }]); sane('primal weather ' + w + ' start', o);
      t('weather ' + w + ': the start shows the ROM line and the tag', o.texts.length === 1 && RE[w][0].test(o.texts[0]) && o.view.tags.length >= 1, JSON.stringify(o.texts) + ' ' + JSON.stringify(o.view.tags));
      o = r.play([{ t: 'weather-tick', w }]); sane('primal weather ' + w + ' tick', o);
      // round 7: MEASURED in the real game (tools/pokemonarena_event_codes_test.mjs): each turn of a primal weather says the weather's own line (heavy rain "Rain continues to fall.", harsh sun "The sunlight is strong.", strong winds "blow on regardless")
      t('weather ' + w + ': a turn of it shows the ROM line', o.texts.length === 1 && [/rain continues/i, /sunlight is strong/i, /blow on regardless/i][w - 6].test(o.texts[0]), JSON.stringify(o.texts));
      o = r.play([{ t: 'weather-end', w }]); sane('primal weather ' + w + ' end', o);
      t('weather ' + w + ': the end shows the ROM line and the tag goes', o.texts.length === 1 && RE[w][1].test(o.texts[0]) && o.view.tags.length === 0, JSON.stringify(o.texts) + ' ' + JSON.stringify(o.view.tags));
    }
    r = rig(); const o = r.play([{ t: 'weather', s: FOE, m: 0, w: 9 }, { t: 'weather-tick', w: 9 }, { t: 'weather-end', w: 9 }]); sane('weather 9', o);
    t('a weather id nobody knows shows nothing and sets no tag', o.texts.length === 0 && o.view.tags.length === 0, JSON.stringify(o.texts));
  }

  /* ---- the other new events ---- */
  {
    r = rig(); let o = r.play([{ t: 'perish', ...base(r, ME), n: 2 }]); sane('perish', o);
    t('perish: the count line names the Pokemon and the count', o.texts.length === 1 && /perish count/i.test(o.texts[0]) && o.texts[0].includes(mon(r, ME).name) && /2/.test(o.texts[0]), JSON.stringify(o.texts));
    o = r.play([{ t: 'pp-drain', ...base(r, FOE), mv: 33 }]); sane('pp-drain', o);
    t('pp-drain: a PP cut says "lost 3 PP" (the ROM line), no throw', o.texts.length === 1 && /lost 3 PP/i.test(o.texts[0]), JSON.stringify(o.texts));
    // Revival Blessing: the event, then the heal of the bench Pokemon
    r = rig(); const benchSlot = r.ctl.battle.s.sides[ME].team.findIndex((x, i) => i !== r.ctl.battle.s.sides[ME].act);
    const hpBefore = mon(r, ME).hp, bench = r.ctl.battle.s.sides[ME].team[benchSlot];
    o = r.play([{ t: 'revive', s: ME, m: benchSlot }, { t: 'heal', s: ME, m: benchSlot, from: 0, to: 40, max: bench.mhp, src: 'revival-blessing' }]); sane('revive', o);
    t('revive: the line names the Pokemon that came back', o.texts.length >= 1 && /revived/i.test(o.texts[0]) && o.texts[0].includes(bench.name), JSON.stringify(o.texts));
    t('revive: the heal of a Pokemon on the bench does not move the ACTIVE Pokemon\'s bar', !o.steps.includes('drain') && mon(r, ME).hp === hpBefore, o.steps.join(',') + ' ' + mon(r, ME).hp + '/' + hpBefore);
    // the same heal for the Pokemon that IS active still drains (the guard is about the bench, not about heals)
    const act = r.ctl.battle.s.sides[ME].act, am = r.ctl.battle.s.sides[ME].team[act];
    o = r.play([{ t: 'damage', s: ME, m: act, from: hpBefore, to: Math.max(1, hpBefore - 20), max: am.mhp, src: 'rocky-helmet', eff: 4096 }, { t: 'heal', s: ME, m: act, from: Math.max(1, hpBefore - 20), to: hpBefore, max: am.mhp, src: 'leftovers' }]);
    t('heal: a heal of the active Pokemon still moves its bar', o.steps.filter((x) => x === 'drain').length === 2 && mon(r, ME).hp === hpBefore, o.steps.join(','));
    // cant-move
    const CM = [['gravity', /gravity/i, true], ['love', /love/i, true], ['torment', /torment/i, true], ['imprison', /sealed/i, true], ['heal-block', /prevented from healing/i, true], ['throat-chop', /Throat Chop prevent/i, true], ['sky-drop', null, false], ['zzz', null, false]];
    for (const [why, re, line] of CM) {
      r = rig(); o = r.play([{ t: 'cant-move', ...base(r, FOE), why, mv: 33 }]); sane('cant-move ' + why, o);
      t('cant-move ' + why + ': ' + (line ? 'the ROM line for it' : 'no line (the ROM has none), no throw'), line ? o.texts.length === 1 && re.test(o.texts[0]) : o.texts.length === 0, JSON.stringify(o.texts));
    }
    // volatiles
    const VOL = [['infatuation', /in love/i], ['torment', /torment/i], ['perish-song', /heard the song/i], ['imprison', /sealed/i]];
    for (const [v, re] of VOL) { r = rig(); o = r.play([{ t: 'volatile', ...base(r, FOE), v }]); sane('volatile ' + v, o); t('volatile ' + v + ': the ROM line for it', o.texts.length === 1 && re.test(o.texts[0]), JSON.stringify(o.texts)); }
    for (const [v, re] of [['infatuation', /infatuation/i], ['torment', /no longer tormented/i]]) { r = rig(); o = r.play([{ t: 'volatile-end', ...base(r, FOE), v }]); sane('volatile-end ' + v, o); t('volatile-end ' + v + ': the ROM line for it', o.texts.length === 1 && re.test(o.texts[0]), JSON.stringify(o.texts)); }
    // round 7: these HAVE ROM lines (MEASURED); only a code nobody knows is silent
    r = rig(); o = r.play(['zzz', 'zzz-2'].flatMap((v) => [{ t: 'volatile', ...base(r, FOE), v }, { t: 'volatile-end', ...base(r, FOE), v }])); sane('other volatiles', o);
    t('a volatile nobody knows shows nothing', o.texts.length === 0, JSON.stringify(o.texts));
    // abilities and items with codes the scene has no line for, and codes nobody knows
    r = rig(); o = r.play([{ t: 'ability', ...base(r, FOE), ab: 1, fx: 'zzz-ability' }, { t: 'ability', ...base(r, ME), ab: 2, fx: 'primal-weather' }, { t: 'ability', ...base(r, ME), ab: 3, fx: 'zzz-2' }, { t: 'item', ...base(r, FOE), it: 5, fx: 'fling', used: 1 },
      { t: 'item', ...base(r, FOE), it: 5, fx: 'natural-gift', used: 1 }, { t: 'item', ...base(r, FOE), it: 5, fx: 'zzz-item', used: 1 }, { t: 'zzz-event', s: 0 }, { t: 'trick', s: ME }]); sane('abilities / items / unknown events', o);
    t('abilities and items without a line show nothing (the fling and the trick have lines now), unknown events are ignored', o.texts.length === 2 && /flung its/i.test(o.texts[0]) && /switched items/i.test(o.texts[1]), JSON.stringify(o.texts));
  }

  /* ---- ability fx codes (AN1 round 6): each ROM line, then the table of every code the engine can emit ---- */
  await abilityFxChecks(M, pack, text, rig, t, opts);

  /* ---- Revival Blessing: a switch request whose choices are the FAINTED Pokemon ---- */
  {
    r = rig();
    const sd = r.ctl.battle.s.sides[ME], act = sd.act, slots = sd.team.map((_x, i) => i).filter((i) => i !== act);
    const dead = slots[0], dead2 = slots[2];
    const realView = r.ctl.view.bind(r.ctl), realPending = r.ctl.pending.bind(r.ctl), realSubmit = r.ctl.submit.bind(r.ctl);
    const mk = (reason) => ({ phase: 'switch', reason, you: ME, switches: sd.team.map((m, i) => ({ slot: i, sp: m.sp, name: m.name, hp: i === dead || i === dead2 ? 0 : m.hp, max: m.mhp, st: 0, level: m.level })).filter((x) => (reason === 'revive' ? x.hp <= 0 : x.hp > 0) && x.slot !== act), trapped: false });
    let req = mk('revive'); const submits = [];
    r.ctl.view = (side) => { const v = realView(side); if (side === ME) { v.you = Object.assign({}, v.you, { team: v.you.team.map((m, i) => (i === dead || i === dead2 ? Object.assign({}, m, { hp: 0 }) : m)) }); } return v; };
    r.ctl.pending = (side) => (side === ME ? req : realPending(side));
    r.ctl.submit = (side, c) => { if (side === ME && c.kind === 'switch') { submits.push(c); req = null; return { ok: true }; } return realSubmit(side, c); };
    for (let n = 0; n < 6 && r.scene.mode !== 'party'; n++) r.scene.tick();
    let v = r.scene.view();
    t('revive: a switch request with reason "revive" opens the party screen', r.scene.mode === 'party' && v.screen === 'party', r.scene.mode);
    const mons = v.party ? v.party.mons : [];
    t('revive: only the FAINTED Pokemon the request lists are choices (revivable), the living are not', mons.length === 6 && mons.every((m) => m.revivable === (m.slot === dead || m.slot === dead2)), JSON.stringify(mons.map((m) => [m.slot, m.fainted, m.revivable])));
    t('revive: the cursor starts on the first Pokemon that can come back', v.party && mons[v.party.cursor] && mons[v.party.cursor].slot === dead, v.party && String(v.party.cursor));
    const living = mons.findIndex((m) => !m.fainted && !m.active);
    r.scene.choose.party(living);
    let g = 0; while (g++ < 400 && r.scene.S.cur === null && r.scene.S.queue.length === 0) r.scene.tick();
    t('revive: choosing a living Pokemon submits nothing and says why', submits.length === 0 && r.scene.fallbacks().includes('party.notfainted'), JSON.stringify(submits) + r.scene.fallbacks());
    for (let n = 0; n < 400 && r.scene.mode !== 'party'; n++) { r.scene.tick(); if (r.scene.mode === 'steps' && r.scene.S.cur && r.scene.S.cur.t === 'text') r.scene.press('a'); }
    const deadIdx = mons.findIndex((m) => m.slot === dead);
    r.scene.choose.party(deadIdx);
    t('revive: choosing a fainted Pokemon submits that slot as a switch', submits.length === 1 && submits[0].kind === 'switch' && submits[0].slot === dead, JSON.stringify(submits));
    // the ordinary forced switch (after a faint) is as before: a fainted Pokemon is refused, a living one submitted
    r = rig(); const sd2 = r.ctl.battle.s.sides[ME]; const act2 = sd2.act; const dead3 = sd2.team.findIndex((_m, i) => i !== act2);
    const rv = r.ctl.view.bind(r.ctl), rs = r.ctl.submit.bind(r.ctl), rp = r.ctl.pending.bind(r.ctl); const subs2 = []; let req2 = { phase: 'switch', reason: 'faint', you: ME, switches: sd2.team.map((m, i) => ({ slot: i, sp: m.sp, name: m.name, hp: m.hp, max: m.mhp, st: 0, level: m.level })).filter((x) => x.slot !== act2 && x.slot !== dead3), trapped: false };
    r.ctl.view = (side) => { const v2 = rv(side); if (side === ME) v2.you = Object.assign({}, v2.you, { team: v2.you.team.map((m, i) => (i === dead3 ? Object.assign({}, m, { hp: 0 }) : m)) }); return v2; };
    r.ctl.pending = (side) => (side === ME ? req2 : rp(side)); r.ctl.submit = (side, c) => { if (side === ME && c.kind === 'switch') { subs2.push(c); req2 = null; return { ok: true }; } return rs(side, c); };
    for (let n = 0; n < 6 && r.scene.mode !== 'party'; n++) r.scene.tick();
    v = r.scene.view(); const m2 = v.party ? v.party.mons : [];
    t('forced switch (not a revive): no Pokemon is marked revivable', r.scene.mode === 'party' && m2.every((m) => m.revivable === undefined), r.scene.mode);
    r.scene.choose.party(m2.findIndex((m) => m.slot === dead3)); for (let n = 0; n < 60; n++) r.scene.tick();
    t('forced switch: a fainted Pokemon is refused as before ("no energy left")', subs2.length === 0);
    for (let n = 0; n < 400 && r.scene.mode !== 'party'; n++) { r.scene.tick(); if (r.scene.mode === 'steps' && r.scene.S.cur && r.scene.S.cur.t === 'text') r.scene.press('a'); }
    r.scene.choose.party(m2.findIndex((m) => m.slot !== dead3 && m.slot !== act2));
    t('forced switch: a living Pokemon is submitted as before', subs2.length === 1 && subs2[0].kind === 'switch', JSON.stringify(subs2));
    // the whole thing on the REAL engine: a weak Pokemon is knocked out (forced switch), the next one uses Revival Blessing, the request comes back as reason 'revive' with the fainted one
    {
      const mv = (n) => pack.moves.findIndex((m) => m && m.name === n);
      const mkOne = (species, moves, seed, level) => { const tm = M.MC.randomTeam(pack, seed, 1); const x = tm.recs[0]; x.species = species; x.level = level; x.moves = moves.map((id) => ({ id, ppUps: 0 })); tm.meta[0] = { gender: null, shiny: false }; return tm; };
      const weak = mkOne(25, [mv('Tackle')], 501, 5), reviver = mkOne(143, [mv('Revival Blessing'), mv('Tackle')], 502, 50), killer = mkOne(150, [mv('Hyper Beam')], 503, 100);
      const AA = { recs: [weak.recs[0], reviver.recs[0]], meta: [weak.meta[0], reviver.meta[0]] };
      const ctl = M.MC.createMatchController({ pack, teams: [AA.recs, killer.recs], seed: 5, pick: 0, names: ['You', 'CPU'], validate: false, sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 3 }] });
      const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [AA.meta, killer.meta], trainer: 'CPU', playerName: 'You' });
      ctl.start(); scene.begin();
      const rb = mv('Revival Blessing'); const seen = [];
      for (let n = 0; n < 60000 && scene.mode !== 'result' && seen.filter((x) => x.startsWith('action')).length < 3; n++) {
        scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
        if (scene.mode === 'action') { const req = ctl.pending(0), sl = req.moves.findIndex((m) => m.id === rb); seen.push('action'); scene.choose.action(0); scene.choose.move(sl >= 0 ? sl : 0); }
        else if (scene.mode === 'party') {
          const req = ctl.pending(0), v = scene.view(); seen.push('party:' + req.reason + ':' + JSON.stringify(v.party.mons.map((m) => m.revivable === undefined ? '-' : m.revivable ? 'R' : 'x')));
          scene.choose.party(v.party.mons.findIndex((m) => m.slot === req.switches[0].slot));
        }
      }
      t('revive (real engine): a knock-out gives the ordinary forced switch, Revival Blessing gives the revive screen with the fainted Pokemon revivable', seen.includes('party:faint:["-","-"]') && seen.includes('party:revive:["R","x"]'), seen.join(' '));
      t('revive (real engine): choosing it brings the Pokemon back (the engine says so, its HP is above 0) and the battle goes on to the next action menu', ctl.battle.events.some((e) => e.t === 'revive') && ctl.view(0).you.team[0].hp > 0 && scene.mode !== 'result', 'hp ' + ctl.view(0).you.team[0].hp);
    }
    // the CPU answers a revive request with a slot the request lists (all three levels)
    r = rig(); const reqC = mk('revive');
    for (const level of ['easy', 'normal', 'hard']) {
      const ai = M.AI.createAi({ pack, level, seed: 9 }); const c = ai.choose(reqC, r.ctl.view(ME), { previewInfo: { foe: r.ctl.previewInfo[1] } });
      t('revive: the CPU (' + level + ') answers with a fainted slot of the request', c && c.kind === 'switch' && reqC.switches.some((x) => x.slot === c.slot), JSON.stringify(c));
    }
  }

  /* ---- real battles through the scene (the new pool of teams, the new mechanics) ---- */
  if (!opts.fast) {
    const N = Number(process.env.ARENA_FUZZ || 40), seen = new Map(); let thrown = 0, blank = 0, keys = 0, games = 0, unexpected = new Set();
    for (let seed = 1; seed <= N; seed++) {
      try {
        const A = M.MC.randomTeam(pack, seed * 313 + 1, 6), B = M.MC.randomTeam(pack, seed * 313 + 2, 6);
        const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: seed * 31, pick: 3, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: seed + 5 }] });
        const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: seed % 9, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
        const ai = M.AI.createAi({ pack, level: 'normal', seed: seed ^ 0x5bd1e995 });
        scene.S.auto = { ai, decide(req) { return ai.choose(req, ctl.view(0), { previewInfo: { foe: ctl.previewInfo[1] } }); } };
        ctl.start(); scene.begin();
        let last = null, n = 0;
        while (n++ < 300000 && scene.mode !== 'result') {
          scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a');
          const c = scene.S.cur; if (c && c !== last) { last = c; if (c.t === 'text') { const x = String(c.text).trim(); if (x === '') blank++; else if (KEYLIKE.test(x)) keys++; } }
        }
        games++;
        for (const e of ctl.battle.events) seen.set(e.t, (seen.get(e.t) || 0) + 1);
        for (const k of scene.fallbacks()) if (!ALLOWED_FALLBACKS.has(k)) unexpected.add(k);
      } catch (e) { thrown++; unexpected.add('threw ' + String(e.message).slice(0, 60)); }
    }
    t('fuzz: ' + games + ' real battles through the scene: none throws', thrown === 0 && games === N, thrown + ' threw, ' + games + ' played');
    t('fuzz: no blank text and no catalog key on screen in any of them', blank === 0 && keys === 0, blank + ' blank, ' + keys + ' keys');
    t('fuzz: the only lines that are not the ROM\'s are the known ones (scene.fallbacks)', unexpected.size === 0, [...unexpected].join(','));
    core.seen = seen;
  }
  return f;
}

/* ====================================================================================================== run */
const real = await loadStack(JS);
const realFails = await core(real, {});
for (const x of realFails) ok(false, 'core: ' + x);
ok(realFails.length === 0, '1. every scene-events check passes on the real tree (' + realFails.length + ' failing)');
if (abilityFxChecks.summary) console.log('ability fx table: ' + JSON.stringify(abilityFxChecks.summary));
if (core.seen) console.log('event codes in the fuzzed battles: ' + [...core.seen.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '));

if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sceneev-'));
  const copyTree = (name) => { const d = path.join(tmp, name); fs.cpSync(JS, d, { recursive: true }); return d; };
  const twinDir = copyTree('twin'); const twin = await loadStack(twinDir, '?twin'); const twinFails = await core(twin, { fast: true });
  ok(twinFails.length === 0, '2. the unmutated twin (copied tree, fast mode) is quiet', twinFails.slice(0, 3).join(' | '));
  const mutants = [
    ['scene.js', 'every field shows the trick-room line again', (s) => s.replace("if (e.k === 'trick-room') {", 'if (true) {')],
    ['scene.js', 'an unknown catalog key is shown as the key', (s) => s.replace("fallbacks.add(key); return ''; ", 'fallbacks.add(key); return key; ')],
    ['scene.js', 'frostbite has no label (no icon, no line of its own)', (s) => s.replace("6: 'PSN', 7: 'FRB' };\nconst ST_WORD", "6: 'PSN' };\nconst ST_WORD")],
    ['scene.js', 'frostbite is announced as poison', (s) => s.replace("5: 'par', 6: 'psn', 7: 'frb' };", "5: 'par', 6: 'psn', 7: 'psn' };")],
    ['scene.js', 'frostbite damage reads as poison damage', (s) => s.replace("e.src === 'fbt' ? 'hurt.frb' : 'hurt.psn'", "'hurt.psn'")],
    ['scene.js', 'the revive party screen is the ordinary one (a fainted Pokemon is refused)', (s) => s.replace('if (p.revive) {', 'if (false) {')],
    ['scene.js', 'the revive request is shown as an ordinary forced switch (reason ignored)', (s) => s.replace("const revive = !!req && req.reason === 'revive';", 'const revive = false;')],
    ['scene.js', 'the revive screen marks nobody revivable', (s) => s.replace("{ revivable: Array.isArray(req.switches) && req.switches.some((x) => x.slot === m.slot) }", '{ revivable: false }')],
    ['scene.js', 'a heal of a Pokemon on the bench moves the active bar', (s) => s.replace('if (e.m !== undefined && P[e.s].slot !== undefined && e.m !== P[e.s].slot) return;', '')],
    ['scene.js', 'terrain has no tag', (s) => s.replace("if (S.terrain && TN_TAG[S.terrain]) tags.push(TN_TAG[S.terrain]);", '')],
    ['scene.js', 'Gravity never ends its tag', (s) => s.replace("if (e.k === 'gravity') qCall(() => { S.gravity = !!on; });", "if (e.k === 'gravity') qCall(() => { S.gravity = true; });")],
    ['scene.js', 'primal weather has no tag', (s) => s.replace("6: 'HEAVY RAIN', 7: 'HARSH SUN', 8: 'WINDS' };", '};')],
    ['scene.js', 'the revive line names the wrong Pokemon (the active one)', (s) => s.replace("roles(e.s, { b1: benchName(e.s, e.m) })", "roles(e.s, { b1: monName(e.s, false) })")],
    ['scene.js', 'a perish line without the count', (s) => s.replace("roles(e.s, { b1: String(e.n) })); break;\n        case 'revive'", "roles(e.s, { b1: '' })); break;\n        case 'revive'")],
    ['scene.js', 'a turn of primal weather shows a line (the key)', (s) => s.replace("if (text.has(tk)) qMsg(tk, roles(0));", "if (text.has(tk)) qText(tk);")],
    ['battle_text.js', 'the grassy terrain line is the electric one', (s) => s.replace("'tn.1.on': 'Grass grew to cover the battlefield!',", "'tn.1.on': 'An electric current ran across the battlefield!',")],
    ['battle_text.js', 'the gravity line is missing from the catalog', (s) => s.replace("  'fld.gravity.on': 'Gravity intensified!',\n", '')],
    // AN1 round 6: the ability lines (FV1: Neutralizing Gas and the Ruin abilities showed nothing); a 4th element { full } = only the sweep half can kill it
    ['scene.js', 'Neutralizing Gas says nothing on entry', (s) => s.replace("else if (fx === 'neutralizing-gas') { S.notes.gas[e.s] = true; qMsg('ab.gas.on', roles(e.s)); }", "else if (fx === 'neutralizing-gas') { S.notes.gas[e.s] = true; }")],
    ['scene.js', 'the gas never wears off', (s) => s.replace('const gasLeaves = (side) => { if (S.notes.gas[side]) {', 'const gasLeaves = (side) => { if (false) {')],
    ['scene.js', 'the gas wears off when the FIRST holder leaves', (s) => s.replace('if (!S.notes.gas[0] && !S.notes.gas[1]) qMsg(', 'if (true) qMsg(')],
    ['scene.js', 'Beads of Ruin says the Defense line', (s) => s.replace("'Beads of Ruin': 'ab.ruin.spd'", "'Beads of Ruin': 'ab.ruin.def'")],
    ['battle_text.js', 'the Sword of Ruin line names the wrong stat', (s) => s.replace("'ab.ruin.def': \"{13}'s {1a} weakened the Defense of", "'ab.ruin.def': \"{13}'s {1a} weakened the Attack of")],
    ['scene.js', 'Unnerve is about the holder\'s own team', (s) => s.replace("qMsg('ab.unnerve', roles(e.s ^ 1));", "qMsg('ab.unnerve', roles(e.s));")],
    ['scene.js', 'As One has no two-Abilities line', (s) => s.replace("if (/^As One/.test(ab)) qMsg('ab.asone', roles(e.s)); ", '')],
    ['scene.js', 'Slow Start says nothing', (s) => s.replace("else if (fx === 'slow-start') qMsg('ab.slowstart', roles(e.s));", "else if (fx === 'slow-start') { /* nothing */ }")],
    ['scene.js', 'Disguise also says "made X ineffective"', (s) => s.replace("if (nx && nx.t === 'immune' && nx.why === 'ability') skipAt.add(i + 1); }", '}')],
    ['scene.js', 'Sturdy\'s line comes after the effectiveness line', (s) => s.replace('drain();\n      flushAfterDrain(e.s);\n', 'drain();\n')],
    ['scene.js', 'Magic Bounce also says "But nothing happened!"', (s) => s.replace("ability: ab })); skipAt.add(i + 1); }", 'ability: ab })); }')],
    ['scene.js', 'Magic Coat is "But nothing happened!"', (s) => s.replace("else if (e.why === 'bounced') qMsg('ab.coat', roles(e.s, { move: moveName(e.mv) }));", '')],
    ['scene.js', 'a Dancer move is not announced', (s) => s.replace("(pv.t === 'ability' && pv.fx === 'dancer') || ", '')],
    ['scene.js', 'Cursed Body is the plain disable line', (s) => s.replace("cb.fx === 'cursed-body') qMsg(", "cb.fx === 'cursed-body' && false) qMsg(")],
    ['scene.js', 'Mummy says nothing', (s) => s.replace("else if (e.how === 'mummy') qMsg('ab.acquired', roles(e.s, { ability: abilityName(e.ab) }));", '')],
    ['scene.js', 'Anger Point is "raised" like the others', (s) => s.replace("prev.fx === 'anger-point') qMsg('stat.abilitymax'", "prev.fx === 'zzz-anger-point') qMsg('stat.abilitymax'")],
    ['scene.js', 'Wind Power says nothing', (s) => s.replace("else if (fx === 'electromorphosis' || fx === 'wind-power') qMsg('ab.charged'", "else if (fx === 'zzz') qMsg('ab.charged'")],
    ['scene.js', 'Toxic Debris\' hazard code is not read', (s) => s.replace("const hk = e.hz === 'ts' ? 'tspikes' : e.hz;", 'const hk = e.hz;')],
    ['scene.js', 'a weather ability is read only in the OLDER order (ability first)', (s) => s.replace('const ab = isW(nx) && nx.s === e.s ? nx : isW(prev) ? prev : null;', 'const ab = isW(prev) ? prev : null;')],
    ['scene.js', 'primal weather plays no animation', (s) => s.replace("const isW = (x) => x && x.t === 'ability' && (x.fx === 'weather' || x.fx === 'primal-weather') ? x : null;", "const isW = (x) => x && x.t === 'ability' && x.fx === 'weather' ? x : null;")],
    ['anim_mon.js', 'Delta Stream plays the hail animation', (s) => s.replace('8: GENERAL.STRONG_WINDS_CONTINUE }', '8: GENERAL.HAIL_CONTINUES }')],
    ['anim_mon.js', 'Primordial Sea plays the sun animation', (s) => s.replace('6: GENERAL.RAIN_CONTINUES, 7:', '6: GENERAL.SUN_CONTINUES, 7:')],
    ['scene.js', 'an ability immunity says nothing (every absorb / immune ability goes silent)', (s) => s.replace("else qMsg('ab.immune', roles(e.s, { ability: abn, move: mvn }));", "else { /* nothing */ }"), { full: 1 }],
    ['scene.js', 'the "<ability> raised its <stat>" line is gone (every stat ability goes silent)', (s) => s.replace("prev.s === e.s && up && prev.fx !== 'intimidate') qMsg('stat.abilityup'", "prev.s === e.s && up && prev.fx === 'zzz') qMsg('stat.abilityup'"), { full: 1 }],
    ['scene.js', 'a stat change that follows an ability is dropped (the Intimidate rule applies to every ability)', (s) => s.replace("if (prev && prev.t === 'ability' && prev.fx === 'intimidate' && e.s !== prev.s) break;", "if (prev && prev.t === 'ability' && e.s !== prev.s) break;"), { full: 1 }],
    ['scene.js', 'a status that follows an ability is dropped', (s) => s.replace("case 'status-set': {\n          const lab = ST_LABEL[e.st];", "case 'status-set': {\n          if (evs[i - 1] && evs[i - 1].t === 'ability') break;\n          const lab = ST_LABEL[e.st];"), { full: 1 }],
  ];
  let killed = 0;
  for (let mi = 0; mi < mutants.length; mi++) {
    const [file, name, fn, mopts] = mutants[mi];
    const dir = copyTree('m' + mi); const src = fs.readFileSync(path.join(dir, file), 'utf8'); const out = fn(src);
    if (out === src) { ok(false, '2. mutant "' + name + '" did not change the source (the mutant itself is broken)'); continue; }
    fs.writeFileSync(path.join(dir, file), out);
    let fails; try { const M = await loadStack(dir, '?m' + mi); fails = await core(M, mopts && mopts.full ? { only: 'abilityfx' } : { fast: true }); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    const dead = fails.length > 0; if (dead) killed++;
    ok(dead, '2. mutant killed: ' + file + ' / ' + name, dead ? fails[0].slice(0, 80) : 'survived');
  }
  console.log('mutants killed ' + killed + ' of ' + mutants.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s); ' + nChecks + ' individual checks ran inside the core runs (real tree + twin + mutants)');
if (fail) process.exit(1);
