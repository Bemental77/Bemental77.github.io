// tools/pokemonarena_event_codes_test.mjs - EVERY engine event code against the real scene and the ROM text table (AN1 round 7).
//
//   node tools/pokemonarena_event_codes_test.mjs
//   ARENA_SKIP_MUTANTS=1 ...   skip the source-mutant half      ARENA_EVSEEDS=<n> seeds per move / item in the sweep (default 2)      ARENA_EVDUMP=1  print every row with the ROM keys / offsets it uses
//
// WHY: a code the engine emits that the scene does not show is invisible to a player; one that the ROM HAS a line for is a defect. ENGINE.md section 12 lists the codes, engine*.js emits them. This test
//      keeps one ROW per code: (event kind, the fields that tell its variants apart) -> what the player sees. It extracts the codes from the engine source (every emit({ t: ... }) literal), runs EVERY legal
//      move and item through real engine lab battles (random foes, abilities, items, weather, terrain, hazards, screens), plays each event through the REAL scene with and without itself, and compares.
//   O  (own)      the event adds a line of the ROM's own text. The catalog keys that produced it are read off the scene (text.compose is recorded) and must be ROM-pinned keys with offsets in text_manifest.json
//                 (no flagged fallback outside ALLOWED_FB); `keys` pins which ones.
//   C  (carried)  the event adds nothing because another event of the same turn says it (a critical hit is the damage's flag, a faint line is the faint event ...): `by` must match a line of that turn.
//   Z  (silent)   the event is invisible and the ROM text table has no battle line that names it: `kw` (keywords) are searched in every decoded ROM battle string; `elsewhere` lists the ones the ROM uses for
//                 something else. A row is MEASURED where its note says so: the real game (the mGBA oracle, tools/pokemonarena_rom_oracle.mjs) printed that line, or nothing.
// A code the engine emits that has no row, a row the engine no longer emits, a flagged fallback, a throw, or a blank text line fails. Ability fx codes have their own table: pokemonarena_scene_events_test.mjs.
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
let pass = 0, fail = 0, nChecks = 0;
function ok(cond, name, detail) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); } }
const t0 = Date.now();
console.log('pokemonarena event-codes test; ROM', ROM_PATH, rom.length, 'B; node', process.version);

const LIB = await import(pathToFileURL(path.join(here, 'pokemonarena_engine_lib.mjs')).href);
const EM = await LIB.loadModules(JS);
const BTR = await import(pathToFileURL(path.join(JS, 'battle_text.js')).href);
const RULES = await import(pathToFileURL(path.join(JS, 'rules.js')).href);
async function loadStack(dir, bust = '') {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + bust;
  const [BT, MC, SC, B, T, AM] = await Promise.all(['battle_text.js', 'matchctl.js', 'scene.js', 'battle_ui.js', 'tables.js', 'anim_mon.js'].map((f) => import(u(f))));
  return { BT, MC, SC, B, T, AM, dir };
}
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }

// the ROM's battle strings, decoded, as one lower-case blob (letters and digits only): "does any ROM line name this?"
const normKw = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const romBlob = (() => { const parts = []; let p = BTR.TEXT_REGION[0]; const hi = BTR.TEXT_REGION[1]; while (p < hi) { while (p < hi && (rom[p] === 0xff || rom[p] === 0x00)) p++; if (p >= hi) break; const st = p; while (p < hi && rom[p] !== 0xff) p++; parts.push(normKw(BTR.decodeTemplate(rom, st))); p++; } return parts.join('|'); })();
// keywords the ROM uses for something else, with what
const ELSEWHERE = { laststand: 'the raid shield wording ("barrier broke! It\'s making a last stand!")', wish: 'the wish event\'s arrival line ("<mon>\'s wish came true!")' };
// flagged (non-ROM) lines the scene is allowed to show: the list in scene.js's header
const ALLOWED_FB = new Set(['lifeorb', 'sludge', 'heal.shell-bell', 'heal.black-sludge', 'balloonpop', 'turncap', 'scr.veil', 'tn.5.on', 'tn.5.off', 'party.notfainted']);

/* ======================================================================================== the rows */
const O = (keys, o) => Object.assign({ need: 'own', keys: keys || null }, o || {});
const C = (by, o) => Object.assign({ need: 'carried', by }, o || {});
const Z = (kw, note, o) => Object.assign({ need: 'silent', kw, note }, o || {});
const EVENT_CODES = {
  "avoid": O(),
  "cant-move:why=disabled": O(),
  "cant-move:why=flinch": O(),
  "cant-move:why=frz": O(),
  "cant-move:why=gravity": O(),
  "cant-move:why=heal-block": O(["cant.healblock"]),
  "cant-move:why=lost-focus": O(),
  "cant-move:why=love": O(),
  "cant-move:why=par": O(),
  "cant-move:why=recharge": O(),
  "cant-move:why=sky-drop": Z(['sky drop'], "the held Pokemon just skips its turn: the ROM has the start line (took into the sky) and the \"too heavy\" refusal only; the real game did not show a line when the held Pokemon was kept from moving"),
  "cant-move:why=slp": O(),
  "cant-move:why=taunt": O(),
  "cant-move:why=throat-chop": O(["cant.throat"]),
  "cant-move:why=torment": O(),
  "cant-move:why=truant": O(),
  "charge:sinv=": O(),
  "charge:sinv=air": O(),
  "charge:sinv=ground": O(),
  "charge:sinv=shadow": O(),
  "charge:sinv=water": O(),
  "confusion-hit": O(),
  "copy:how=ability-copy": O(["copy.acquired"]),
  "copy:how=ability-set": O(["copy.acquired"]),
  "copy:how=assist": O(),
  "copy:how=copycat": O(),
  "copy:how=guard-swap": O(["copy.statswap"]),
  "copy:how=heart-swap": O(["copy.statswap"]),
  "copy:how=instruct": O(["copy.instruct"]),
  "copy:how=lingering-aroma": Z(['lingering aroma'], "the real game showed no text when the holder was hit (holder not confirmed active); no ROM line names it"),
  "copy:how=me-first": O(),
  "copy:how=metronome": O(["metronome"]),
  "copy:how=mimic": O(["copy.mimic"]),
  "copy:how=mirror-move": O(),
  "copy:how=mummy": O(["ab.acquired"]),
  "copy:how=nature-power": O(["copy.naturepower"]),
  "copy:how=power-swap": O(["copy.statswap"]),
  "copy:how=psych-up": O(["copy.psychup"]),
  "copy:how=role-play": O(["copy.roleplay"]),
  "copy:how=skill-swap": O(["ab.swapped"]),
  "copy:how=sleep-talk": Z(['sleep talk'], "the move it calls is announced; the copy itself has no line"),
  "copy:how=trace": O(["ab.trace"]),
  "copy:how=transform": O(["transformed"]),
  "copy:how=wandering-spirit": C(/swapped Abilities with its target!/i),
  "crit": C(/critical hit/i),
  "damage:src=aftermath": O(["dmg.hurt"]),
  "damage:src=bad-dreams": O(["dmg.tormented"]),
  "damage:src=belly-drum": O(),
  "damage:src=bide": C(/unleashed its energy/i),
  "damage:src=black-sludge": O(),
  "damage:src=brn": O(),
  "damage:src=clangorous-soul": Z(['clangorous'], "MEASURED: only the stat line shows, the HP cost is silent"),
  "damage:src=confusion": C(/hurt itself in its confusion/i),
  "damage:src=crash": C(/kept going and crashed/i),
  "damage:src=curse": O(["hurt.curse"]),
  "damage:src=destiny-bond": O(),
  "damage:src=disguise": C(/disguise was busted/i),
  "damage:src=dry-skin": O(["dmg.toll"]),
  "damage:src=explosion": C(/fainted/i),
  "damage:src=fbt": O(),
  "damage:src=fillet-away": Z(['fillet'], "MEASURED: only the stat line shows"),
  "damage:src=final-gambit": C(/fainted/i),
  "damage:src=force-return": Z(['force return'], "no ROM line names it"),
  "damage:src=future-sight": C(/attack/i),
  "damage:src=hail": O(),
  "damage:src=healing-wish": C(/fainted/i),
  "damage:src=innards-out": O(["dmg.hurt"]),
  "damage:src=jaboca": O(["hurt.helmet"]),
  "damage:src=last-stand": Z(['last stand'], "the ability's recoil: no line names it (the raid-shield wording is another thing)"),
  "damage:src=leech-seed": O(),
  "damage:src=life-orb": O(),
  "damage:src=liquid-ooze": C(/sucked up the liquid ooze/i),
  "damage:src=memento": C(/fainted/i),
  "damage:src=mind-blown": Z(['mind blown'], "MEASURED: no line for the recoil"),
  "damage:src=move": O(),
  "damage:src=nightmare": O(["dmg.nightmare"]),
  "damage:src=pain-split": O(),
  "damage:src=perish": C(/perish count/i),
  "damage:src=powder": O(["hurt.powder"]),
  "damage:src=psn": O(),
  "damage:src=recoil": O(),
  "damage:src=rocky-helmet": O(),
  "damage:src=rough-skin": O(),
  "damage:src=salt-cure": O(["hurt.trap"]),
  "damage:src=sandstorm": O(),
  "damage:src=shed-tail": O(["shedtail"]),
  "damage:src=solar-power": O(["dmg.toll"]),
  "damage:src=spikes": C(/spikes/i),
  "damage:src=spiky-shield": O(["hurt.helmet"]),
  "damage:src=stealth-rock": C(/pointed stones/i),
  "damage:src=sticky-barb": O(["hurt.barb"]),
  "damage:src=substitute": C(/substitute/i),
  "damage:src=tox": O(),
  "damage:src=trap": O(),
  "destiny-bond": O(),
  "drain": O(),
  "draw": O(),
  "endure": O(),
  "fail:why=already-confused": O(),
  "fail:why=already-status": O(),
  "fail:why=failed": O(),
  "fail:why=no-sleep": O(),
  "fail:why=no-target": O(),
  "fail:why=powder": O(),
  "fail:why=primal-weather": O(["wx.fizzle.rain","wx.fizzle.sun"]),
  "fail:why=rooted": O(),
  "fail:why=safeguard": O(),
  "fail:why=substitute": O(),
  "fail:why=terrain": O(),
  "faint": O(),
  "field:k=court-change,on=1": O(),
  "field:k=electric-terrain,on=0": O(),
  "field:k=electric-terrain,on=1": O(),
  "field:k=fairy-lock,on=0": Z(['fairy lock'], "MEASURED: no end line in three turns"),
  "field:k=fairy-lock,on=1": O(),
  "field:k=grassy-terrain,on=0": O(),
  "field:k=grassy-terrain,on=1": O(),
  "field:k=gravity,on=0": O(),
  "field:k=gravity,on=1": O(),
  "field:k=ion-deluge,on=1": O(),
  "field:k=magic-room,on=0": O(),
  "field:k=magic-room,on=1": O(),
  "field:k=misty-terrain,on=0": O(),
  "field:k=misty-terrain,on=1": O(),
  "field:k=mud-sport,on=0": O(),
  "field:k=mud-sport,on=1": O(),
  "field:k=psychic-terrain,on=0": O(),
  "field:k=psychic-terrain,on=1": O(),
  "field:k=trick-room,on=0": O(),
  "field:k=trick-room,on=1": O(),
  "field:k=water-sport,on=0": O(),
  "field:k=water-sport,on=1": O(),
  "field:k=wonder-room,on=0": O(),
  "field:k=wonder-room,on=1": O(),
  "forced-out": O(),
  "forfeit": O(),
  "future-sight": O(),
  "hazard-clear:hz=all": O(["hz.away.spikes","hz.clear.spikes"]),
  "hazard-clear:hz=tspikes": O(["hz.clear.tspikes"]),
  "hazard-damage:hz=rocks": O(),
  "hazard-damage:hz=spikes": O(),
  "hazard:hz=rocks": O(["hz.rocks"]),
  "hazard:hz=spikes": O(["hz.spikes"]),
  "hazard:hz=ts": O(["hz.tspikes"]),
  "hazard:hz=tspikes": O(["hz.tspikes"]),
  "hazard:hz=web": O(["hz.web"]),
  "heal:src=aqua-ring": O(),
  "heal:src=berry": C(/restored/i),
  "heal:src=black-sludge": O(),
  "heal:src=channel-earth": Z(['channel earth'], "ability heal: no ROM line names it"),
  "heal:src=cheek-pouch": Z(['cheek pouch'], "ability heal: no ROM line names it"),
  "heal:src=consume": Z(['consume'], "ability heal: no ROM line names it"),
  "heal:src=drain": C(/energy drained/i),
  "heal:src=dry-skin": O(["heal.raindish"]),
  "heal:src=earth-eater": O(["heal.absorb"]),
  "heal:src=enigma-berry": C(/restored/i),
  "heal:src=glacial": Z(['glacial'], "ability heal: no ROM line names it"),
  "heal:src=grassy-terrain": O(["heal.terrain"]),
  "heal:src=healing-wish": C(/healing wish/i),
  "heal:src=ice-body": O(["heal.icebody"]),
  "heal:src=ingrain": O(),
  "heal:src=jade-bloom": Z(['jade bloom'], "ability heal: no ROM line names it"),
  "heal:src=leech-seed": C(/sapped/i),
  "heal:src=leftovers": O(),
  "heal:src=lifesteal": Z(['lifesteal'], "ability heal: no ROM line names it"),
  "heal:src=maim-and-mend": Z(['maim and mend'], "ability heal: no ROM line names it"),
  "heal:src=mending": Z(['mending'], "ability heal: no ROM line names it"),
  "heal:src=move": O(),
  "heal:src=oran": C(/restored/i),
  "heal:src=pain-split": O(),
  "heal:src=poison-heal": O(["heal.poisonheal"]),
  "heal:src=present": O(["heal.move"]),
  "heal:src=rain-dish": O(["heal.raindish"]),
  "heal:src=reborn": Z(['reborn'], "the bar fills after the hit: no ROM line names the ability"),
  "heal:src=reef-warden": Z(['reef warden'], "ability heal: no ROM line names it"),
  "heal:src=regenerator": Z(['regenerator'], "Regenerator heals as the Pokemon leaves: no ROM line (UNVERIFIED in the real game)"),
  "heal:src=rejuvenation": Z(['rejuvenation'], "ability heal: no ROM line names it"),
  "heal:src=rest": O(["st.restheal"]),
  "heal:src=revival-blessing": C(/revived/i),
  "heal:src=ritualist": O(["heal.absorb"]),
  "heal:src=shell-bell": O(),
  "heal:src=sitrus": C(/restored/i),
  "heal:src=spectral-drain": Z(['spectral drain'], "ability heal: no ROM line names it"),
  "heal:src=strength-sap": O(["drained"]),
  "heal:src=swallow": O(["heal.move"]),
  "heal:src=volt-absorb": O(["heal.absorb"]),
  "heal:src=water-absorb": O(["heal.absorb"]),
  "heal:src=wish": C(/wish came true/i),
  "immune:why=ability": O(["ab.blocks","ab.immune","ab.useless","immune"]),
  "immune:why=ability-confuse": O(),
  "immune:why=ability-status": O(),
  "immune:why=airborne": O(),
  "immune:why=powder": O(),
  "immune:why=prankster": O(),
  "immune:why=type": O(),
  "immune:why=type-status": O(),
  "item:fx=balloon-pop": O(),
  "item:fx=berserk-gene": Z(['berserk gene'], "the stat rise and the confusion show as their own lines"),
  "item:fx=bestow": O(["item.bestow"]),
  "item:fx=blunder-policy": O(),
  "item:fx=booster-energy": Z(['booster energy'], "inert in singles (the engine has no Protosynthesis / Quark Drive)"),
  "item:fx=cure": O(["cure.par","cure.psn","cure.brn","cure.slp","cure.frz"]),
  "item:fx=cure-confusion": O(["cure.conf"]),
  "item:fx=custap": O(["item.custap"]),
  "item:fx=eject-button": O(["item.eject"]),
  "item:fx=eject-pack": O(["item.eject"]),
  "item:fx=enigma": O(["heal.berry"]),
  "item:fx=fling": O(["item.fling"]),
  "item:fx=focus-band": O(["sash"]),
  "item:fx=gem": O(["item.gem"]),
  "item:fx=harvest": O(),
  "item:fx=hit-boost": O(),
  "item:fx=incinerate": O(["item.burnt"]),
  "item:fx=knocked-off": O(),
  "item:fx=lansat": O(["item.lansat"]),
  "item:fx=leppa": O(["item.leppa"]),
  "item:fx=mental-herb": Z(['mental herb'], "the cures it makes show as their own volatile-end lines"),
  "item:fx=micle": O(["item.micle"]),
  "item:fx=mirror-herb": O(["item.mirrorherb"]),
  "item:fx=natural-gift": Z(['natural gift'], "no ROM line; the move's damage shows"),
  "item:fx=oran": O(),
  "item:fx=pinch-heal": O(),
  "item:fx=pluck": O(["item.pluck"]),
  "item:fx=power-herb": O(["item.powerherb"]),
  "item:fx=recycle": O(["item.recycle"]),
  "item:fx=red-card": O(["item.redcard"]),
  "item:fx=resist-berry": O(["resistberry"]),
  "item:fx=room-service": O(["item.statdown"]),
  "item:fx=sash": O(["sash"]),
  "item:fx=sitrus": O(),
  "item:fx=starf": O(),
  "item:fx=stat-berry": O(),
  "item:fx=stuff-cheeks": Z(['stuff', 'cheek'], "no ROM line (not oracle-reached: no berry)"),
  "item:fx=teatime": Z(['teatime', 'tea time'], "no ROM line"),
  "item:fx=terrain-seed": O(["item.statup"]),
  "item:fx=thorn-berry": C(/hurt by .*Berry/i),
  "item:fx=throat-spray": O(),
  "item:fx=weakness-policy": O(["item.statup"]),
  "item:fx=white-herb": O(),
  "miss": O(),
  "move-use": O(),
  "multi-hit": O(),
  "noop:what=,why=": O(),
  "noop:what=,why=bounced": O(["ab.coat"]),
  "noop:what=,why=snatched": O(["snatch.done"]),
  "noop:what=magnitude,why=": O(["oneblow"]),
  "noop:what=spite,why=": O(["spite"]),
  "perish": O(),
  "pivot": O(),
  "pp-drain": O(["grudge.pp","spite"]),
  "preview": Z([], "structural: the team preview screen"),
  "protect-break": O(),
  "protected:pk=1": O(),
  "protected:pk=11": O(),
  "protected:pk=12": O(),
  "protected:pk=2": O(),
  "protected:pk=3": O(),
  "protected:pk=4": O(),
  "protected:pk=5": O(),
  "protected:pk=6": O(),
  "protected:pk=7": O(),
  "protected:pk=8": O(),
  "protected:pk=9": O(),
  "recoil:crash=": C(/damaged by the recoil/i),
  "recoil:crash=1": O(),
  "revive": O(),
  "screen-end:k=light": O(),
  "screen-end:k=luckyChant": O(),
  "screen-end:k=mist": O(),
  "screen-end:k=reflect": O(),
  "screen-end:k=sg": O(),
  "screen-end:k=tw": O(),
  "screen-end:k=veil": O(),
  "screen:k=light": O(),
  "screen:k=luckyChant": O(),
  "screen:k=mist": O(),
  "screen:k=reflect": O(),
  "screen:k=sg": O(),
  "screen:k=tw": O(),
  "screen:k=veil": O(),
  "start": Z([], "structural: the opening is the switch-ins"),
  "stat-change": O(),
  "stat-fail:why=ability": O(),
  "stat-fail:why=item": O(),
  "stat-fail:why=max": O(),
  "stat-fail:why=min": O(),
  "stat-fail:why=mist": O(),
  "stats-reset:partial=,inverted=": O(),
  "stats-reset:partial=,inverted=1": O(),
  "stats-reset:partial=1,inverted=": O(),
  "status-clear:st=1,why=purify": O(),
  "status-clear:st=1,why=shed-skin": O(),
  "status-clear:st=1,why=wake": O(),
  "status-clear:st=2,why=berry": O(),
  "status-clear:st=2,why=cure": O(),
  "status-clear:st=2,why=heal-bell": O(["bell","aroma"]),
  "status-clear:st=2,why=psycho-shift": O(),
  "status-clear:st=2,why=purify": O(["purify"]),
  "status-clear:st=2,why=shed-skin": O(),
  "status-clear:st=3,why=cure": O(),
  "status-clear:st=3,why=heal-bell": O(["bell","aroma"]),
  "status-clear:st=3,why=psycho-shift": O(),
  "status-clear:st=3,why=shed-skin": O(),
  "status-clear:st=3,why=take-heart": O(),
  "status-clear:st=5,why=cure": O(),
  "status-clear:st=5,why=cured": O(),
  "status-clear:st=5,why=heal-bell": O(["bell","aroma"]),
  "status-clear:st=5,why=lum": O(),
  "status-clear:st=5,why=psycho-shift": O(),
  "status-clear:st=5,why=shed-skin": O(),
  "status-clear:st=5,why=take-heart": O(),
  "status-clear:st=6,why=cure": O(),
  "status-clear:st=6,why=psycho-shift": O(),
  "status-clear:st=6,why=shed-skin": O(),
  "status-clear:st=6,why=take-heart": O(),
  "status-clear:st=7,why=psycho-shift": O(),
  "status-clear:st=7,why=shed-skin": O(),
  "status-set:st=1,fx=dire-claw": O(),
  "status-set:st=1,fx=effect-spore": O(["ab.sleepspore"]),
  "status-set:st=1,fx=move": O(),
  "status-set:st=1,fx=rest": O(),
  "status-set:st=1,fx=secondary": O(),
  "status-set:st=1,fx=yawn": O(),
  "status-set:st=2,fx=": O(),
  "status-set:st=2,fx=baneful-bunker": O(),
  "status-set:st=2,fx=dire-claw": O(),
  "status-set:st=2,fx=effect-spore": O(["ab.poisonpt"]),
  "status-set:st=2,fx=fling": O(),
  "status-set:st=2,fx=move": O(),
  "status-set:st=2,fx=poison-point": O(["ab.poisonpt"]),
  "status-set:st=2,fx=poison-touch": O(),
  "status-set:st=2,fx=psycho-shift": O(),
  "status-set:st=2,fx=secondary": O(),
  "status-set:st=2,fx=synchronize": O(),
  "status-set:st=2,fx=toxic-spikes": O(),
  "status-set:st=3,fx=beak-blast": O(),
  "status-set:st=3,fx=blazing-sun": O(),
  "status-set:st=3,fx=burning-bulwark": O(),
  "status-set:st=3,fx=flame-body": O(["ab.flamebody"]),
  "status-set:st=3,fx=flame-orb": O(),
  "status-set:st=3,fx=flameburst": O(),
  "status-set:st=3,fx=fling": O(),
  "status-set:st=3,fx=move": O(),
  "status-set:st=3,fx=psycho-shift": O(),
  "status-set:st=3,fx=secondary": O(),
  "status-set:st=3,fx=spicy-spray": O(),
  "status-set:st=3,fx=synchronize": O(),
  "status-set:st=3,fx=tri-attack": O(),
  "status-set:st=4,fx=frost-nova": O(),
  "status-set:st=5,fx=dire-claw": O(),
  "status-set:st=5,fx=effect-spore": O(["ab.static"]),
  "status-set:st=5,fx=fling": O(),
  "status-set:st=5,fx=move": O(),
  "status-set:st=5,fx=plasma-surge": O(),
  "status-set:st=5,fx=psycho-shift": O(),
  "status-set:st=5,fx=secondary": O(),
  "status-set:st=5,fx=static": O(["ab.static"]),
  "status-set:st=5,fx=synchronize": O(),
  "status-set:st=5,fx=tri-attack": O(),
  "status-set:st=6,fx=fling": O(),
  "status-set:st=6,fx=move": O(),
  "status-set:st=6,fx=psycho-shift": O(),
  "status-set:st=6,fx=secondary": O(),
  "status-set:st=6,fx=toxic-chain": O(),
  "status-set:st=6,fx=toxic-orb": O(),
  "status-set:st=6,fx=toxic-spikes": O(),
  "status-set:st=7,fx=permafrost": O(),
  "status-set:st=7,fx=psycho-shift": O(),
  "status-set:st=7,fx=secondary": O(),
  "status-set:st=7,fx=synchronize": O(),
  "status-set:st=7,fx=tri-attack": O(),
  "struggle": O(),
  "sub-break": O(),
  "sub-damage": O(),
  "sub-set": O(),
  "switch-in": O(),
  "switch-out": O(),
  "trick:how=": O(),
  "trick:how=magician": O(["steal"]),
  "trick:how=pickpocket": O(["steal"]),
  "trick:how=sticky-barb": O(["barb.attach"]),
  "turn": Z([], "structural: no battle text of its own"),
  "turn-cap": O(),
  "type-change": O(),
  "volatile-end:v=airborne": Z([], "a charging Fly / Bounce state is dropped when the Pokemon leaves the field: nothing to say"),
  "volatile-end:v=confusion": O(),
  "volatile-end:v=disable": O(),
  "volatile-end:v=embargo": O(["end.embargo"]),
  "volatile-end:v=encore": O(),
  "volatile-end:v=heal-block": O(["end.wore","cure.healblock"]),
  "volatile-end:v=magnet-rise": O(["end.wore"]),
  "volatile-end:v=leech-seed": O(["vol.leechend"], { note: "round 5: Rapid Spin frees its user from Leech Seed (MEASURED, ROM 0x4428e0)" }),
  "volatile-end:v=syrup-bomb": Z(['syrup bomb'], "no end line in the ROM"),
  "volatile-end:v=taunt": O(),
  "volatile-end:v=telekinesis": O(["end.telekinesis"]),
  "volatile-end:v=throat-chop": O(["end.throat"]),
  "volatile-end:v=trap": O(["vol.trap.end", "trap.free"], { note: "round 8: \"was freed from <move>!\" and, from Rapid Spin, \"got free of <foe>'s <move>!\" (MEASURED)" }),
  "volatile:v=aqua-ring": O(),
  "volatile:v=bide": Z(['bide'], "MEASURED: the first Bide turn prints nothing; storing / unleashing have their own volatiles"),
  "volatile:v=bide-storing": O(["vol.bide.store"]),
  "volatile:v=bide-unleash": O(["vol.bide.go"]),
  "volatile:v=charged": O(["charge.generic"]),
  "volatile:v=confusion": O(),
  "volatile:v=curse": O(),
  "volatile:v=destiny-bond": O(["vol.destiny"]),
  "volatile:v=disable": O(),
  "volatile:v=electrify": O(["vol.electrify"]),
  "volatile:v=embargo": O(["vol.embargo"]),
  "volatile:v=encore": O(),
  "volatile:v=endure": O(["braced"]),
  "volatile:v=focus-energy": O(),
  "volatile:v=foresight": O(),
  "volatile:v=future-sight": O(),
  "volatile:v=gastro-acid": O(["vol.gastro"]),
  "volatile:v=grudge": O(["vol.grudge"]),
  "volatile:v=heal-block": O(["vol.healblock"]),
  "volatile:v=imprison": O(),
  "volatile:v=infatuated": O(["love.each"]),
  "volatile:v=infatuation": O(),
  "volatile:v=ingrain": O(),
  "volatile:v=laser-focus": O(["vol.laser"]),
  "volatile:v=leech-seed": O(),
  "volatile:v=lock-on": O(),
  "volatile:v=magic-coat": O(["vol.coat"]),
  "volatile:v=magnet-rise": O(["vol.magnet"]),
  "volatile:v=miracle-eye": O(["vol.foresight"]),
  "volatile:v=nightmare": O(["vol.nightmare"]),
  "volatile:v=noescape": O(["vol.noescape"]),
  "volatile:v=perish-song": O(),
  "volatile:v=powder": O(["vol.powder"]),
  "volatile:v=power-trick": O(["vol.powertrick"]),
  "volatile:v=protect": O(["protected"]),
  "volatile:v=salt-cure": O(["vol.saltcure"]),
  "volatile:v=sky-drop": O(["vol.skydrop"]),
  "volatile:v=snatch": O(["snatch.set"]),
  "volatile:v=speed-swap": O(["copy.speedswap"]),
  "volatile:v=split": O(["split.power","split.guard"]),
  "volatile:v=syrup-bomb": O(["vol.syrup"]),
  "volatile:v=tar-shot": O(["vol.tarshot"]),
  "volatile:v=taunt": O(),
  "volatile:v=telekinesis": O(["vol.telekinesis"]),
  "volatile:v=torment": O(),
  "volatile:v=trap": O(["vol.trap", "trap.wrap", "trap.bind", "trap.clamp", "trap.sand", "trap.magma", "trap.infest", "trap.cage", "trap.snap"], { note: "round 8: each binding move has its own start line (MEASURED, 10 moves)" }),
  "volatile:v=trapped": O(),
  "volatile:v=wish": Z(['wish'], "MEASURED: using Wish prints nothing; the ROM line is the arrival (the wish event)"),
  "volatile:v=yawn": O(),
  "weather-end:w=1": O(),
  "weather-end:w=2": O(),
  "weather-end:w=3": O(),
  "weather-end:w=4": O(),
  "weather-end:w=5": O(),
  "weather-end:w=6": O(["wx.6.end"]),
  "weather-end:w=7": O(["wx.7.end"]),
  "weather-end:w=8": O(["wx.8.end"]),
  "weather-tick:w=1": O(),
  "weather-tick:w=2": O(),
  "weather-tick:w=3": O(),
  "weather-tick:w=4": O(),
  "weather-tick:w=5": O(),
  "weather-tick:w=8": O(["wx.norelief.winds"], { note: "round 5: strong winds print \"blow on regardless\" every turn (MEASURED, ROM 0x43f784); the engine now emits the tick" }),
  "weather:w=1": O(),
  "weather:w=2": O(),
  "weather:w=3": O(),
  "weather:w=4": O(),
  "weather:w=5": O(),
  "win": O(),
  "wish:hw=": O(),
  "wish:hw=1": O(["wish.heal"]),
  "wish:hw=2": O(["wish.lunar"]),
};

/* ======================================================================================== helpers for samples */
const KEYLIKE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const REC = { keys: [] };                                   // every catalog key text.compose is asked for while a play runs
function recordCompose(text) { const comp = text.compose; text.compose = (k, ...a) => { REC.keys.push(k); return comp.call(text, k, ...a); }; }
const msetDiff = (a, b) => { const m = new Map(); for (const x of b) m.set(x, (m.get(x) || 0) + 1); const out = []; for (const x of a) { const n = m.get(x) || 0; if (n > 0) m.set(x, n - 1); else out.push(x); } return out; };

// the engine events of one code as an injectable event (static-only codes and the few that need a setup)
function genEvent(code, side, act, ids) {
  const i = code.indexOf(':'); const kind = i < 0 ? code : code.slice(0, i); const rest = i < 0 ? '' : code.slice(i + 1);
  const e = { t: kind, s: side, m: act };
  for (const part of rest ? rest.split(',') : []) { const [k, v] = part.split('='); if (v === '' || v === undefined) continue; e[k] = /^-?\d+$/.test(v) ? Number(v) : v; }
  const D = { mv: ids.tackle, it: ids.oran, ab: ids.intimidate, n: 2, w: 1, st: 1, stat: 'atk', delta: 1, from: 100, to: 90, max: 100, eff: 4096, sp: 25, lv: 50, hz: 'spikes', k: 'light', v: 'confusion' };
  for (const k of Object.keys(D)) if (e[k] === undefined && ((kind === 'damage' || kind === 'heal') ? ['from', 'to', 'max', 'eff', 'mv'].includes(k) : ['mv', 'it', 'ab', 'n', 'stat', 'delta'].includes(k) && kindNeeds(kind, k))) e[k] = D[k];
  if (kind === 'damage' && e.src === undefined) e.src = 'move';
  return e;
}
const NEEDS = { 'cant-move': ['mv'], copy: ['mv', 'ab'], trick: ['it'], item: ['it'], immune: ['mv', 'ab'], fail: ['mv'], 'stat-fail': ['stat', 'ab'], 'stat-change': ['stat', 'delta'], perish: ['n'], 'pp-drain': ['mv'], noop: ['mv'], 'future-sight': ['mv'], 'move-use': ['mv'], 'status-set': [], protected: [] };
const kindNeeds = (kind, k) => (NEEDS[kind] || []).includes(k);
const CODE_SETUP = {};    // code -> (ctx) => { pre, evs, i } for the codes that need more than the single event

/* ======================================================================================== the sweep */
function collectSamples(L, pack, ids) {
  const SUP = RULES.engineSupports(pack);
  const moves = Object.keys(L.D.moveByName).filter((n) => n && n !== 'Struggle' && SUP.moves.has(L.D.moveByName[n]));
  const items = Object.keys(L.D.itemByName).filter((n) => n && n !== '-----' && SUP.items.has(L.D.itemByName[n]));
  const abil = EM.engine_abilities.ABILITY_NAMES.filter((n) => L.D.abilityByName[n] !== undefined);
  const PRESETS = [{}, {}, { pw: 6 }, { pw: 7 }, { pw: 8 }, { wx: [1, 5] }, { wx: [2, 5] }, { wx: [3, 5] }, { wx: [5, 5] }, { tn: [1, 5] }, { tn: [2, 5] }, { tn: [3, 5] }, { tn: [4, 5] }, { gv: 5 }, { tr: 5 },
    { sd: [{ hz: { sp: 2, ts: 2, sr: 1, sw: 1 }, reflect: 5, light: 5, sg: 5, mist: 5, tw: 4 }, { hz: { sp: 1, ts: 1, sr: 1, sw: 1 }, reflect: 5, light: 5, veil: 5 }] }];
  const samples = new Map(); let nBattles = 0, nEvents = 0, nErr = 0;
  const keep = (ev, tag) => {
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]; nEvents++; if (e.t === 'ability' || e.t === 'turn' || e.t === 'start' || e.t === 'preview') continue;
      const k = codeOfEvent(e); let a = samples.get(k); if (!a) samples.set(k, a = []);
      const pv = ev[i - 1], sig = pv ? pv.t + (pv.fx || pv.why || pv.how || pv.v || '') : '^';
      if (a.filter((x) => x.sig === sig).length < 2 && a.length < 14) a.push({ evs: ev, i, tag, sig });
    }
  };
  const mv4 = (rnd, first) => { const o = first ? [first] : []; while (o.length < 4) { const n = moves[Math.floor(rnd() * moves.length)]; if (!o.includes(n)) o.push(n); } return o; };
  const it0 = (rnd) => (rnd() < 0.5 ? 0 : items[Math.floor(rnd() * items.length)]);
  const base = (rnd, ms, it) => ({ moves: ms, bench: [{ moves: [moves[Math.floor(rnd() * moves.length)]] }], benchSpec: {}, hp: 300, mhp: 400, ab: abil[Math.floor(rnd() * abil.length)], it, st: { atk: 120, def: 100, spa: 120, spd: 100, spe: 100 } });
  const drive = (spec, first, turns, rnd, tag) => {
    let b; try { b = L.lab(spec); } catch (e) { nErr++; return; }
    nBattles++;
    try {
      for (let tn = 0; tn < turns && b.s.phase !== 'end'; tn++) {
        let any = false;
        for (const q of b.requests()) {
          if (q.phase === 'move') { const okm = q.moves.filter((m) => !m.disabled); let c; if (q.struggle || !okm.length) c = { kind: 'move', slot: 4 }; else if (first && first[q.side] !== undefined && tn < 3 && okm.some((m) => m.slot === first[q.side])) c = L.MV(first[q.side]); else c = L.MV(okm[Math.floor(rnd() * okm.length)].slot); b.choose(q.side, c); any = true; }
          else if (q.phase === 'switch' && q.switches[0]) { b.choose(q.side, L.SW(q.switches[0].slot)); any = true; }
        }
        if (!any) break;
        keep(b.advance(), tag);
      }
    } catch (e) { nErr++; }
  };
  const SEEDS = Number(process.env.ARENA_EVSEEDS || 2); let pi = 0;
  for (const m of moves) for (const orient of [0, 1]) for (let seed = 1; seed <= SEEDS; seed++) {
    const rnd = mulberry(seed * 7919 + orient * 101 + m.length); const mine = base(rnd, mv4(rnd, m), 0), other = base(rnd, mv4(rnd), it0(rnd)); const pre = PRESETS[pi++ % PRESETS.length];
    drive(Object.assign(orient === 0 ? { a: mine, b: other } : { a: other, b: mine }, { seed: seed * 13 }, pre), orient === 0 ? [0, undefined] : [undefined, 0], 12, rnd, 'move:' + m);
  }
  for (const it of items) for (const orient of [0, 1]) for (let seed = 1; seed <= SEEDS; seed++) {
    const rnd = mulberry(seed * 104729 + orient * 31 + it.length); const mine = base(rnd, mv4(rnd), it), other = base(rnd, mv4(rnd), it0(rnd)); const pre = PRESETS[pi++ % PRESETS.length];
    drive(Object.assign(orient === 0 ? { a: mine, b: other } : { a: other, b: mine }, { seed: seed * 17 }, pre), null, 20, rnd, 'item:' + it);
  }
  return { samples, nBattles, nEvents, nErr };
}
const DISC = { 'cant-move': ['why'], charge: ['sinv'], copy: ['how'], fail: ['why'], field: ['k', 'on'], hazard: ['hz'], 'hazard-clear': ['hz'], 'hazard-damage': ['hz'], heal: ['src'], damage: ['src'], immune: ['why'], item: ['fx'], noop: ['what', 'why'], screen: ['k'], 'screen-end': ['k'], 'stat-fail': ['why'],
  'stats-reset': ['partial', 'inverted'], 'status-clear': ['st', 'why'], 'status-set': ['st', 'fx'], trick: ['how'], volatile: ['v'], 'volatile-end': ['v'], weather: ['w'], 'weather-end': ['w'], 'weather-tick': ['w'], protected: ['pk'], recoil: ['crash'], wish: ['hw'] };
function codeOfEvent(e) { const d = DISC[e.t]; if (!d) return e.t; return e.t + ':' + d.map((f) => f + '=' + (e[f] === undefined ? '' : e[f])).join(','); }

// every event code the engine SOURCE can emit: the literal t of every emit({ ... }) and the literal values of the fields that tell its variants apart
function scanEmitCodes() {
  const BS = String.fromCharCode(92); const kinds = new Map(); let total = 0;
  const objEnd = (s, i) => { let d = 0, q = null; for (let k = i; k < s.length; k++) { const c = s[k]; if (q) { if (c === BS) { k++; continue; } if (c === q) q = null; continue; } if (c === "'" || c === '"' || c === '`') { q = c; continue; } if (c === '{') d++; else if (c === '}') { d--; if (d === 0) return k; } } return -1; };
  const pairs = (body) => { const parts = []; let d = 0, q = null, cur = ''; for (let k = 0; k < body.length; k++) { const c = body[k]; if (q) { cur += c; if (c === BS) { cur += body[++k]; continue; } if (c === q) q = null; continue; } if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; } if ('([{'.includes(c)) { d++; cur += c; continue; } if (')]}'.includes(c)) { d--; cur += c; continue; } if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; } cur += c; } if (cur.trim()) parts.push(cur); return parts.map((p) => /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(p)).filter(Boolean).map((m) => [m[1], (m[2] === undefined ? m[1] : m[2]).trim()]); };
  for (const f of fs.readdirSync(JS).filter((x) => /^engine.*\.js$/.test(x))) {
    const s = fs.readFileSync(path.join(JS, f), 'utf8'); const re = /\bemit\(\s*\{/g; let m;
    while ((m = re.exec(s))) { const i = m.index + m[0].length - 1, e = objEnd(s, i); if (e < 0) continue; total++; const ps = pairs(s.slice(i + 1, e)); const tp = ps.find((p) => p[0] === 't'); const tm = tp && /^'([a-z-]+)'$/.exec(tp[1]); if (!tm) continue; const k = tm[1]; if (!kinds.has(k)) kinds.set(k, new Map()); for (const [key, val] of ps) { const lit = /^'([^']*)'$/.exec(val); if (lit && DISC[k] && DISC[k].includes(key)) { if (!kinds.get(k).has(key)) kinds.get(k).set(key, new Set()); kinds.get(k).get(key).add(lit[1]); } } }
  }
  return { kinds, total };
}

// codes that need a setup (or a neighbour event) to be played; the sweep's single-batch windows cannot show them: pre = events played first, evs = the window, i = the index of the event under test
const SETUP = {
  'hazard-clear:hz=all': (r, h) => ({ pre: ['spikes', 'web', 'tspikes', 'rocks'].map((k) => h.hz(r, h.ME, k)), evs: [h.mu(r, h.ME, 'Rapid Spin'), h.E(r, h.ME, { t: 'hazard-clear', hz: 'all' })], i: 1 }),
  'hazard-clear:hz=tspikes': (r, h) => ({ pre: [h.hz(r, h.ME, 'tspikes')], evs: [h.E(r, h.ME, { t: 'hazard-clear', hz: 'tspikes' })] }),
  'fail:why=primal-weather': (r, h) => ({ pre: [{ t: 'weather', s: h.FOE, m: h.act(r, h.FOE), w: 6 }], evs: [h.mu(r, h.ME, 'Ember'), h.E(r, h.ME, { t: 'fail', mv: h.mvId('Ember'), why: 'primal-weather' })] }),
  'damage:src=jaboca': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'item', it: h.itId('Jaboca Berry'), fx: 'thorn-berry', used: 1 }), h.E(r, h.ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'jaboca', eff: 4096 })] }),
  'copy:how=wandering-spirit': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Wandering Spirit'), fx: 'wandering-spirit' }), h.E(r, h.ME, { t: 'copy', how: 'wandering-spirit', ab: h.abId('Wandering Spirit') })] }),
  'copy:how=lingering-aroma': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Lingering Aroma'), fx: 'lingering-aroma' }), h.E(r, h.ME, { t: 'copy', how: 'lingering-aroma', ab: h.abId('Lingering Aroma') })] }),
  'heal:src=revival-blessing': (r, h) => { const bench = r.ctl.battle.s.sides[h.ME].team.findIndex((x, k) => k !== h.act(r, h.ME)); return { evs: [{ t: 'revive', s: h.ME, m: bench }, { t: 'heal', s: h.ME, m: bench, from: 0, to: 40, max: 100, src: 'revival-blessing' }] }; },
  'item:fx=harvest': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'ability', ab: h.abId('Harvest'), fx: 'harvest' }), h.E(r, h.ME, { t: 'item', it: h.ids.oran, fx: 'harvest' })] }),
  'damage:src=liquid-ooze': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Liquid Ooze'), fx: 'liquid-ooze' }), h.E(r, h.ME, { t: 'damage', from: 100, to: 90, max: 100, src: 'liquid-ooze', eff: 4096 })] }),
  'damage:src=disguise': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Disguise'), fx: 'disguise' }), h.E(r, h.FOE, { t: 'immune', why: 'ability', ab: h.abId('Disguise'), mv: h.ids.tackle }), h.E(r, h.FOE, { t: 'damage', from: 100, to: 88, max: 100, src: 'disguise', eff: 4096 })] }),
  'status-set:st=5,fx=static': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Static'), fx: 'static' }), h.E(r, h.ME, { t: 'status-set', st: 5, fx: 'static' })] }),
  'status-set:st=3,fx=flame-body': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Flame Body'), fx: 'flame-body' }), h.E(r, h.ME, { t: 'status-set', st: 3, fx: 'flame-body' })] }),
  'status-set:st=2,fx=poison-point': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Poison Point'), fx: 'poison-point' }), h.E(r, h.ME, { t: 'status-set', st: 2, fx: 'poison-point' })] }),
  'status-set:st=1,fx=effect-spore': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Effect Spore'), fx: 'effect-spore' }), h.E(r, h.ME, { t: 'status-set', st: 1, fx: 'effect-spore' })] }),
  'status-set:st=2,fx=effect-spore': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Effect Spore'), fx: 'effect-spore' }), h.E(r, h.ME, { t: 'status-set', st: 2, fx: 'effect-spore' })] }),
  'status-set:st=5,fx=effect-spore': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Effect Spore'), fx: 'effect-spore' }), h.E(r, h.ME, { t: 'status-set', st: 5, fx: 'effect-spore' })] }),
  'status-clear:st=2,why=heal-bell': (r, h) => ({ evs: [h.mu(r, h.ME, 'Heal Bell'), h.E(r, h.ME, { t: 'status-clear', st: 2, why: 'heal-bell' })], i: 1 }),
  'status-clear:st=2,why=purify': (r, h) => ({ evs: [h.mu(r, h.ME, 'Purify'), h.E(r, h.FOE, { t: 'status-clear', st: 2, why: 'purify' })], i: 1 }),
  'heal:src=enigma-berry': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'item', it: h.ids.oran, fx: 'enigma', used: 1 }), h.E(r, h.ME, { t: 'heal', from: 50, to: 75, max: 100, src: 'enigma-berry' })], i: 1 }),
  'heal:src=rest': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'status-set', st: 1, fx: 'rest' }), h.E(r, h.ME, { t: 'heal', from: 50, to: 100, max: 100, src: 'rest' })], i: 1 }),
  'item:fx=terrain-seed': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'item', it: h.ids.oran, fx: 'terrain-seed', used: 1 }), h.E(r, h.ME, { t: 'stat-change', stat: 'def', delta: 1 })], i: 0 }),
  'item:fx=room-service': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'item', it: h.ids.oran, fx: 'room-service', used: 1 }), h.E(r, h.ME, { t: 'stat-change', stat: 'spe', delta: -1 })], i: 0 }),
  'status-clear:st=1,why=purify': (r, h) => ({ evs: [h.mu(r, h.ME, 'Purify'), h.E(r, h.FOE, { t: 'status-clear', st: 1, why: 'purify' })], i: 1 }),
  'item:fx=cure': (r, h) => ({ evs: [h.E(r, h.ME, { t: 'item', it: h.ids.oran, fx: 'cure', used: 1 }), h.E(r, h.ME, { t: 'status-clear', st: 2, why: 'berry' })], i: 0 }),
  'status-clear:st=3,why=heal-bell': (r, h) => ({ evs: [h.mu(r, h.ME, 'Heal Bell'), h.E(r, h.ME, { t: 'status-clear', st: 3, why: 'heal-bell' })], i: 1 }),
  'status-clear:st=5,why=heal-bell': (r, h) => ({ evs: [h.mu(r, h.ME, 'Heal Bell'), h.E(r, h.ME, { t: 'status-clear', st: 5, why: 'heal-bell' })], i: 1 }),
  'immune:why=ability': (r, h) => ({ evs: [h.E(r, h.FOE, { t: 'ability', ab: h.abId('Soundproof'), fx: 'soundproof' }), h.E(r, h.FOE, { t: 'immune', why: 'ability', ab: h.abId('Soundproof'), mv: h.mvId('Hyper Voice') })], i: 1 }),
};
const SETUP_CODES = new Set(Object.keys(SETUP));

/* ======================================================================================== the test */
async function core(M, opts = {}) {
  const f = [];
  const t = (name, cond, detail) => { nChecks++; if (cond !== true) f.push(name + (detail ? ' [' + String(detail).slice(0, 160) + ']' : '')); };
  const pack = M.T.loadPack(rom, { verify: 'header', dexText: false }), ui = M.B.createBattleUi(rom), text = M.BT.loadBattleText(rom, manifest);
  recordCompose(text);
  const L = LIB.makeLab(EM, pack);
  const idOf = (list, n) => { const x = list.find((y) => y && y.name === n); if (!x) throw new Error('no ' + n); return x.id; };
  const mvId = (n) => idOf(pack.moves, n), itId = (n) => idOf(pack.items, n), abId = (n) => idOf(pack.abilities, n);
  const ids = { tackle: mvId('Tackle'), oran: itId('Oran Berry'), intimidate: abId('Intimidate') };
  const ME = 0, FOE = 1;
  function rig() {
    const A = M.MC.randomTeam(pack, 4001, 6), B = M.MC.randomTeam(pack, 4002, 6);
    const ctl = M.MC.createMatchController({ pack, teams: [A.recs, B.recs], seed: 7, pick: 0, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 3 }] });
    const scene = M.SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: [A.meta, B.meta], trainer: 'CPU', playerName: 'You' });
    const real = ctl.takeEvents.bind(ctl); let pending = null;
    ctl.takeEvents = () => { if (pending) { const e = pending; pending = null; return e; } return real(); };
    ctl.start(); scene.begin();
    let g = 0; while (scene.mode !== 'action' && g++ < 6000) { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); }
    const r = { ctl, scene, ok: scene.mode === 'action' };
    r.play = (events) => {
      const texts = [], anims = [], seenQ = new Set(); let err = null, last = null; pending = events;
      try {
        for (let n = 0; n < 6000; n++) {
          scene.tick();
          for (const st of scene.S.queue) if (st.t === 'moveanim' && !seenQ.has(st)) { seenQ.add(st); anims.push(st.kind + ':' + st.id); }
          const c = scene.S.cur; if (c && c !== last) { last = c; if (c.t === 'text') texts.push(c.text); }
          if (c && c.t === 'text' && scene.mode === 'steps') scene.press('a');
          if (!pending && !scene.S.cur && !scene.S.queue.length && scene.mode !== 'steps') break;
        }
      } catch (e) { err = String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | '); }
      return { texts, anims, err };
    };
    return r;
  }
  const act = (r, side) => r.ctl.battle.s.sides[side].act;
  const nameOf = (r, side) => { const v = r.scene.view(); return side === ME ? v.player.name : v.foe.name; };
  const E = (r, side, o) => Object.assign({ s: side, m: act(r, side) }, o);
  const lines = (o) => o.texts.map((x) => String(x).replace(/\s+/g, ' ').trim());
  let r = rig();
  t('rig: the scene reaches the first action menu', r.ok, r.scene.mode);
  if (!r.ok) return f;

  /* ---- 1. the exact lines (subject, order, count): MEASURED in the real game where the name says so (tools/pokemonarena_oracle scenarios, ROM offsets in the notes) ---- */
  const chk = (name, build, ...res) => { const rr = rig(); const o = rr.play(build(rr)); const l = lines(o); t(name, !o.err && l.length === res.length && res.every((re, i) => re.test(l[i])) && l.every((x) => x !== '' && !KEYLIKE.test(x)), o.err || JSON.stringify(l)); return { rr, o, l }; };
  const mu = (rr, side, name, extra) => E(rr, side, Object.assign({ t: 'move-use', mv: mvId(name), called: 0 }, extra));
  const hz = (rr, side, k) => E(rr, side, { t: 'hazard', s: side, hz: k, n: 1 });
  {
    // hazards swept away: the real game names each, in this order (Spikes, Sticky Web, Toxic Spikes, Stealth Rock), Rapid Spin / Mortal Spin "blew away", Defog / Tidy Up "disappeared"
    const setUp = (rr) => rr.play([hz(rr, ME, 'rocks'), hz(rr, ME, 'tspikes'), hz(rr, ME, 'web'), hz(rr, ME, 'spikes')]);
    r = rig(); setUp(r); let o = r.play([mu(r, ME, 'Rapid Spin'), E(r, ME, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: Rapid Spin names what it blew away, in the game\'s order (MEASURED, 0x4428c5 0x4404b7 0x4404d1 0x44049a)', lines(o).length === 5 && /Rapid Spin/.test(lines(o)[0]) && /blew away Spikes!$/.test(lines(o)[1]) && /blew away Sticky Web!$/.test(lines(o)[2]) && /blew away Toxic Spikes!$/.test(lines(o)[3]) && /blew away Stealth Rock!$/.test(lines(o)[4]), JSON.stringify(lines(o)));
    r = rig(); setUp(r); o = r.play([mu(r, ME, 'Mortal Spin'), E(r, ME, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: Mortal Spin the same (MEASURED)', lines(o).length === 5 && lines(o).slice(1).every((x) => /blew away/.test(x)), JSON.stringify(lines(o)));
    r = rig(); setUp(r); o = r.play([mu(r, ME, 'Defog'), E(r, ME, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: Defog says each hazard "disappeared ... your team", same order (MEASURED, 0x442... hz.clear)', lines(o).length === 5 && /spikes disappeared from the ground around your team!$/.test(lines(o)[1]) && /sticky web has disappeared/.test(lines(o)[2]) && /poison spikes disappeared/.test(lines(o)[3]) && /pointed stones disappeared/.test(lines(o)[4]), JSON.stringify(lines(o)));
    r = rig(); setUp(r); o = r.play([mu(r, ME, 'Tidy Up'), E(r, ME, { t: 'hazard-clear', hz: 'all' }), E(r, ME, { t: 'stat-change', stat: 'atk', delta: 1 }), E(r, ME, { t: 'stat-change', stat: 'spe', delta: 1 })]);
    t('hazards: Tidy Up order', lines(o).findIndex((x) => /Tidying up complete!$/.test(x)) === 5 && lines(o).filter((x) => /Tidying up/.test(x)).length === 1 && /rose!$/.test(lines(o)[6]), JSON.stringify(lines(o)));
    r = rig(); o = r.play([mu(r, ME, 'Rapid Spin'), E(r, ME, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: a sweep with nothing there says nothing more than the move', lines(o).length === 1, JSON.stringify(lines(o)));
    r = rig(); r.play([hz(r, ME, 'spikes')]); o = r.play([mu(r, FOE, 'Defog'), E(r, ME, { t: 'hazard-clear', hz: 'all' }), E(r, ME, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: once swept, the hazard is gone from the scene\'s note (the second sweep says nothing)', lines(o).filter((x) => /disappeared/.test(x)).length === 1, JSON.stringify(lines(o)));
    r = rig(); r.play([hz(r, ME, 'rocks')]); r.play([E(r, ME, { t: 'field', k: 'court-change', on: 1 })]); o = r.play([mu(r, FOE, 'Defog'), E(r, FOE, { t: 'hazard-clear', hz: 'all' })]);
    t('hazards: Court Change moves the scene\'s note to the other side (the next sweep names it)', lines(o).filter((x) => /pointed stones disappeared/.test(x)).length === 1, JSON.stringify(lines(o)));
  }
  {
    // the copy moves and the moves they call
    chk('copy: Skill Swap "swapped Abilities with its target!" (MEASURED, 0x4425ef)', (rr) => [E(rr, ME, { t: 'copy', how: 'skill-swap', ab: abId('Static') })], /swapped Abilities with its target!$/);
    chk('copy: Role Play "copied <foe>\'s Ability!" (MEASURED, 0x4426b9)', (rr) => [E(rr, ME, { t: 'copy', how: 'role-play', ab: abId('Static') })], /copied .*'s Ability!$/);
    chk('copy: Worry Seed / Simple Beam / Entrainment "<target> acquired <ability>!" (MEASURED, 0x44102b)', (rr) => [E(rr, FOE, { t: 'copy', how: 'ability-set', ab: abId('Insomnia') }), E(rr, FOE, { t: 'copy', how: 'ability-copy', ab: abId('Guts') })], /acquired Insomnia!$/, /acquired Guts!$/);
    chk('copy: Psych Up "copied <foe>\'s stat changes!" (MEASURED, 0x44290c)', (rr) => [E(rr, ME, { t: 'copy', how: 'psych-up' })], /copied .*'s stat changes!$/);
    chk('copy: Heart / Guard / Power Swap "switched stat changes with its target!" (MEASURED, 0x440fbf)', (rr) => ['heart-swap', 'guard-swap', 'power-swap'].map((how) => E(rr, ME, { t: 'copy', how })), /switched stat changes with its target!$/, /switched stat changes/, /switched stat changes/);
    chk('copy: Mimic "learned <move>!" (MEASURED, 0x443708)', (rr) => [E(rr, ME, { t: 'copy', how: 'mimic', mv: mvId('Tackle') })], /learned Tackle!$/);
    chk('copy: Nature Power "turned into <move>!" then the called move is announced (MEASURED, 0x442810)', (rr) => [mu(rr, ME, 'Nature Power'), E(rr, ME, { t: 'copy', how: 'nature-power', mv: mvId('Energy Ball') }), mu(rr, ME, 'Energy Ball', { called: 1 })], /used Nature Power!$/, /Nature Power turned into Energy Ball!$/, /used Energy Ball!$/);
    chk('copy: Mirror Move / Copycat / Me First announce the move they call (MEASURED)', (rr) => ['mirror-move', 'copycat', 'me-first'].flatMap((how) => [E(rr, ME, { t: 'copy', how, mv: mvId('Tackle') }), mu(rr, ME, 'Tackle', { called: 1 })]), /used Tackle!$/, /used Tackle!$/, /used Tackle!$/);
    chk('copy: Metronome says its own line and does NOT announce the move (unchanged)', (rr) => [E(rr, ME, { t: 'copy', how: 'metronome', mv: mvId('Tackle') }), mu(rr, ME, 'Tackle', { called: 1 })], /let it use Tackle!$/);
    chk('copy: Instruct "followed <user>\'s instructions!" (ROM 0x440020; not oracle-reached)', (rr) => [E(rr, FOE, { t: 'copy', how: 'instruct', mv: mvId('Tackle') })], /followed .*'s instructions!$/);
  }
  {
    // snatch, volatiles, their ends, the cannot-move lines
    chk('snatch: setting it "waits for a target to make a move!" (MEASURED, 0x4424e7)', (rr) => [E(rr, ME, { t: 'volatile', v: 'snatch' })], /waits for a target to make a move!$/);
    chk('snatch: it works "<snatcher> snatched <foe>\'s move!" (MEASURED, 0x4424ce)', (rr) => [E(rr, FOE, { t: 'noop', why: 'snatched', mv: mvId('Swords Dance') })], /snatched .*'s move!$/);
    const VOLS = [['electrify', /moves have been electrified!$/], ['embargo', /can't use items anymore!$/], ['gastro-acid', /Ability was suppressed!$/], ['grudge', /wants its target to bear a grudge!$/], ['heal-block', /was prevented from healing!$/], ['laser-focus', /concentrated intensely!$/],
      ['magic-coat', /shrouded itself with Magic Coat!$/], ['magnet-rise', /levitated with electromagnetism!$/], ['miracle-eye', /was identified!$/], ['powder', /is covered in powder!$/], ['power-trick', /switched its Attack and Defense!$/], ['salt-cure', /is being salt cured!$/], ['syrup-bomb', /got covered in sticky candy syrup!$/],
      ['tar-shot', /became weaker to fire!$/], ['telekinesis', /was hurled into the air!$/], ['bide-storing', /is storing energy!$/], ['bide-unleash', /unleashed its energy!$/], ['destiny-bond', /hoping to take its attacker down with it!$/], ['endure', /braced itself!$/], ['noescape', /can no longer escape!$/], ['protect', /protected itself!$/]];
    for (const [v, re] of VOLS) chk('volatile ' + v + ': the ROM line (MEASURED)', (rr) => [E(rr, FOE, { t: 'volatile', v })], re);
    chk('volatile sky-drop "<user> took <target> into the sky!" (MEASURED, 0x43f49b)', (rr) => [E(rr, FOE, { t: 'volatile', v: 'sky-drop' })], /^.* took .* into the sky!$/);
    chk('volatile split: Power Split / Guard Split (MEASURED)', (rr) => [mu(rr, ME, 'Power Split'), E(rr, ME, { t: 'volatile', v: 'split' }), mu(rr, ME, 'Guard Split'), E(rr, ME, { t: 'volatile', v: 'split' })], /Power Split/, /shared its power with the target!$/, /Guard Split/, /shared its guard with the target!$/);
    chk('volatile speed-swap "<user> switched Speed with its target!" (MEASURED, 0x43f0db)', (rr) => [E(rr, ME, { t: 'volatile', v: 'speed-swap' })], /switched Speed with its target!$/);
    chk('volatile charged: the Charge move says "began charging power!"; an ability\'s charge does not (MEASURED)', (rr) => [E(rr, ME, { t: 'stat-change', stat: 'spd', delta: 1 }), E(rr, ME, { t: 'volatile', v: 'charged' }), E(rr, FOE, { t: 'ability', ab: abId('Wind Power'), fx: 'shockwiring' }), E(rr, FOE, { t: 'volatile', v: 'charged' })], /rose!$/, /began charging power!$/);
    chk('volatile-end embargo "can use items again!" (MEASURED, 0x440ce9)', (rr) => [E(rr, FOE, { t: 'volatile-end', v: 'embargo' })], /can use items again!$/);
    chk('volatile-end heal-block "<mon>\'s Heal Block wore off!" (MEASURED, 0x440cc3)', (rr) => [E(rr, FOE, { t: 'volatile-end', v: 'heal-block' })], /'s Heal Block wore off!$/);
    chk('volatile-end heal-block cured by a Mental Herb "is cured of its heal block!" (ROM 0x43f9d7)', (rr) => [E(rr, FOE, { t: 'item', it: itId('Mental Herb'), fx: 'mental-herb', used: 1 }), E(rr, FOE, { t: 'volatile-end', v: 'heal-block' })], /is cured of its heal block!$/);
    chk('volatile-end magnet-rise "<mon>\'s electromagnetism wore off!" (MEASURED, 0x440cc3 + the word 0x440cd6)', (rr) => [E(rr, FOE, { t: 'volatile-end', v: 'magnet-rise' })], /'s electromagnetism wore off!$/);
    chk('volatile-end telekinesis "was freed from the telekinesis!" (MEASURED, 0x440ca0)', (rr) => [E(rr, FOE, { t: 'volatile-end', v: 'telekinesis' })], /was freed from the telekinesis!$/);
    chk('volatile-end throat-chop "can use sound-based moves again!" (ROM 0x43fff9; not oracle-reached)', (rr) => [E(rr, FOE, { t: 'volatile-end', v: 'throat-chop' })], /can use sound-based moves again!$/);
    chk('volatile-end leech-seed (Rapid Spin) "shed Leech Seed!" and trap "got free of" (ENGINE REQUEST 5; ROM 0x4428dd 0x4428f4)', (rr) => [E(rr, ME, { t: 'volatile-end', v: 'leech-seed', why: 'rapid-spin' }), E(rr, ME, { t: 'volatile-end', v: 'trap', why: 'rapid-spin' })], /shed Leech Seed!$/, /got free of .*'s/);
    chk('cant-move heal-block "was prevented from healing!" (MEASURED, 0x44056f)', (rr) => [E(rr, FOE, { t: 'cant-move', why: 'heal-block', mv: mvId('Recover') })], /was prevented from healing!$/);
    chk('cant-move throat-chop "The effects of Throat Chop prevent <mon> from using certain moves!" (MEASURED, 0x43ffb7)', (rr) => [E(rr, FOE, { t: 'cant-move', why: 'throat-chop', mv: mvId('Hyper Voice') })], /^The effects of Throat Chop prevent .* from using certain moves!$/);
  }
  {
    // damage, heal, pp, wish, items, tricks
    chk('damage powder "When the flame touched the powder ..." (MEASURED, 0x44020f)', (rr) => [E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'powder', eff: 4096 })], /exploded!$/);
    chk('damage salt-cure "<mon> is hurt by Salt Cure!" (MEASURED, 0x442f66)', (rr) => [E(rr, FOE, { t: 'damage', from: 100, to: 88, max: 100, src: 'salt-cure', eff: 4096 })], /is hurt by Salt Cure!$/);
    chk('damage jaboca "<attacker> was hurt by <holder>\'s Jaboca Berry!" (MEASURED, 0x442348)', (rr) => [E(rr, FOE, { t: 'item', it: itId('Jaboca Berry'), fx: 'thorn-berry', used: 1 }), E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'jaboca', eff: 4096 })], /was hurt by .*'s Jaboca Berry!$/);
    chk('damage spiky-shield "<attacker> was hurt by <holder>\'s Spiky Shield!" (MEASURED, 0x442348)', (rr) => [E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'spiky-shield', eff: 4096 })], /was hurt by .*'s Spiky Shield!$/);
    chk('damage sticky-barb "<mon> was hurt by the Sticky Barb!" (MEASURED, 0x441161)', (rr) => [E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'sticky-barb', eff: 4096 })], /was hurt by the Sticky Barb!$/);
    chk('damage solar-power / aftermath / innards-out / bad-dreams: the ROM wording (MEASURED, 0x44091d 0x44090e 0x4409d0)', (rr) => ['solar-power', 'aftermath', 'innards-out', 'bad-dreams'].map((src) => E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src, eff: 4096 })), /Solar Power takes its toll!$/, /was hurt!$/, /was hurt!$/, /is tormented!$/);
    chk('damage shed-tail "shed its tail to create a decoy!" (ROM 0x43e5c4; not oracle-reached: the move needs a bench)', (rr) => [E(rr, ME, { t: 'damage', from: 100, to: 50, max: 100, src: 'shed-tail', eff: 4096 })], /shed its tail to create a decoy!$/);
    chk('heal grassy-terrain "is healed by the grassy terrain!" (MEASURED, 0x44012a)', (rr) => [E(rr, ME, { t: 'heal', from: 80, to: 90, max: 100, src: 'grassy-terrain' })], /is healed by the grassy terrain!$/);
    chk('heal present "HP was restored." (MEASURED, 0x4431c5)', (rr) => [E(rr, ME, { t: 'heal', from: 80, to: 90, max: 100, src: 'present' })], /HP was restored\.$/);
    chk('heal strength-sap "had its energy drained!" (MEASURED, 0x44347b)', (rr) => [E(rr, ME, { t: 'heal', from: 80, to: 90, max: 100, src: 'strength-sap' })], /had its energy drained!$/);
    chk('pp-drain after a faint = Grudge "<attacker>\'s <move> lost all its PP due to the grudge!" (MEASURED, 0x44254c)', (rr) => [E(rr, ME, { t: 'faint' }), E(rr, FOE, { t: 'pp-drain', mv: mvId('Tackle') })], /fainted!$/, /Tackle lost all its PP due to the grudge!$/);
    chk('pp-drain without a faint = a PP cut "lost 3 PP from <move>!" (ROM 0x442ad2)', (rr) => [E(rr, FOE, { t: 'pp-drain', mv: mvId('Tackle') })], /lost 3 PP from Tackle!$/);
    chk('wish: Healing Wish / Lunar Dance arrive with their own lines, Wish with the old one (MEASURED/ROM 0x4406f4 0x4406b1)', (rr) => [E(rr, ME, { t: 'wish', hw: 1 }), E(rr, ME, { t: 'wish', hw: 2 }), E(rr, ME, { t: 'wish' })], /^The healing wish came true for /, /became cloaked in mystical moonlight!$/, /wish came true!$/);
    const IT = [['fling', /flung its Oran Berry!$/], ['custap', /can act faster than normal, thanks to its Oran Berry!$/], ['micle', /boosted the accuracy of its next move using Oran Berry!$/], ['lansat', /used the Oran Berry to get pumped!$/], ['mirror-herb', /used its Mirror Herb to mirror its opponent's stat changes!$/],
      ['red-card', /held up its Red Card against /], ['eject-button', /is switched out with the Oran Berry!$/], ['eject-pack', /is switched out with the Oran Berry!$/], ['gem', /^The Oran Berry strengthened .*'s power!$/], ['power-herb', /became fully charged due to its Oran Berry!$/]];
    for (const [fx, re] of IT) chk('item ' + fx + ': the ROM line (' + (['fling', 'custap', 'mirror-herb', 'gem'].includes(fx) ? 'MEASURED' : 'ROM; not oracle-reached') + ')', (rr) => [E(rr, ME, { t: 'item', it: ids.oran, fx, used: 1 })], re);
    chk('item leppa "restored PP to its move <move> using its <item>!" (ROM 0x441962)', (rr) => [mu(rr, ME, 'Tackle'), E(rr, ME, { t: 'item', it: ids.oran, fx: 'leppa', used: 1 })], /used Tackle!$/, /restored PP to its move Tackle using its Oran Berry!$/);
    chk('item stat items: "Using <item>, the <stat> of <mon> [sharply] rose!" for each stat they change (MEASURED: Kee Berry, Weakness Policy, Throat Spray)', (rr) => [E(rr, ME, { t: 'item', it: itId('Weakness Policy'), fx: 'weakness-policy', used: 1 }), E(rr, ME, { t: 'stat-change', stat: 'atk', delta: 2 }), E(rr, ME, { t: 'stat-change', stat: 'spa', delta: 2 })],
      /^Using Weakness Policy, the Attack of .* sharply rose!$/, /^Using Weakness Policy, the Sp\. Atk of .* sharply rose!$/);
    chk('item room-service "Using <item>, the Speed of <mon> fell!"', (rr) => [E(rr, ME, { t: 'item', it: ids.oran, fx: 'room-service', used: 1 }), E(rr, ME, { t: 'stat-change', stat: 'spe', delta: -1 })], /^Using Oran Berry, the Speed of .* fell!$/);
    chk('a stat change after an unrelated event is the plain line (the item context ends)', (rr) => [E(rr, ME, { t: 'item', it: ids.oran, fx: 'throat-spray', used: 1 }), E(rr, ME, { t: 'faint' }), E(rr, ME, { t: 'stat-change', stat: 'atk', delta: 1 })], /fainted!$/, /Attack rose!$/);
    chk('trick: Pickpocket / Magician / Thief "<thief> stole <victim>\'s <item>!" (MEASURED, 0x442abd)', (rr) => [E(rr, ME, { t: 'trick', how: 'magician', it: ids.oran }), E(rr, FOE, { t: 'trick', how: 'pickpocket', it: ids.oran }), E(rr, ME, { t: 'trick', it: ids.oran, from: FOE, steal: 1 })], /stole .*'s Oran Berry!$/, /stole .*'s Oran Berry!$/, /stole .*'s Oran Berry!$/);
    chk('trick: Sticky Barb "The Sticky Barb attached itself to <mon>!" (ROM 0x43fa8d)', (rr) => [E(rr, FOE, { t: 'trick', how: 'sticky-barb', it: itId('Sticky Barb') })], /^The Sticky Barb attached itself to /);
    chk('trick: Trick / Switcheroo "switched items", then both obtained lines (MEASURED, 0x441376)', (rr) => [E(rr, ME, { t: 'trick', it: itId('Leftovers'), from: FOE }), E(rr, FOE, { t: 'trick', it: ids.oran, from: ME })], /switched items with its target!$/, /obtained Leftovers\.(\\p| )(The opposing )?.* obtained Oran Berry\.$/);
    chk('trick: with one empty hand only the receiving side obtained something', (rr) => [E(rr, ME, { t: 'trick', it: itId('Leftovers'), from: FOE }), E(rr, FOE, { t: 'trick', it: 0, from: ME })], /switched items with its target!$/, /obtained Leftovers\.$/);
    chk('noop magnitude has no side and must not throw (it threw before round 7)', (rr) => [mu(rr, ME, 'Magnitude'), { t: 'noop', what: 'magnitude', n: 7 }], /used Magnitude!$/, /^Magnitude 7!$/);
  }
  {
    // abilities' own wording on a status / infatuation / Flash Fire; the weather lines of the primal weathers; the entry announcements and the other fx codes REQUESTED of the engine
    const ST = (rr, abName, fx, st, byHolder) => [E(rr, FOE, { t: 'ability', ab: abId(abName), fx }), E(rr, ME, { t: 'status-set', st, fx })];
    chk('status by ability: Static "<holder>\'s Static paralyzed <victim>, so it may be unable to move!" (MEASURED, 0x443369)', (rr) => ST(rr, 'Static', 'static', 5), /Static paralyzed .*, so it may be unable to move!$/);
    chk('status by ability: Flame Body "<holder>\'s Flame Body burned <victim>!" (MEASURED, 0x443455)', (rr) => ST(rr, 'Flame Body', 'flame-body', 3), /'s Flame Body burned /);
    chk('status by ability: Poison Point "<victim> was poisoned by <holder>\'s Poison Point!" (MEASURED, 0x4434e6)', (rr) => ST(rr, 'Poison Point', 'poison-point', 2), /was poisoned by .*'s Poison Point!$/);
    chk('status by ability: Effect Spore sleep / poison / paralysis (MEASURED paralysis; 0x443546 0x4434e6 0x443369)', (rr) => [...ST(rr, 'Effect Spore', 'effect-spore', 1), ...ST(rr, 'Effect Spore', 'effect-spore', 2), ...ST(rr, 'Effect Spore', 'effect-spore', 5)], /Effect Spore made .* sleep!$/, /was poisoned by .*'s Effect Spore!$/, /Effect Spore paralyzed /);
    chk('status without an ability keeps the plain line', (rr) => [E(rr, ME, { t: 'status-set', st: 5, fx: 'move' })], /is paralyzed, so it may be unable to move!$/);
    chk('infatuation by Cute Charm "<holder>\'s Cute Charm infatuated <victim>!" (MEASURED, 0x441855)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Cute Charm'), fx: 'cute-charm' }), E(rr, ME, { t: 'volatile', v: 'infatuation' })], /Cute Charm infatuated /);
    chk('Flash Fire: the first absorption "raised the power of Fire-type moves!", the next ones the immunity line (MEASURED, 0x4423d3)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Flash Fire'), fx: 'flash-fire' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Flash Fire'), mv: mvId('Ember') }), E(rr, FOE, { t: 'ability', ab: abId('Flash Fire'), fx: 'flash-fire' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Flash Fire'), mv: mvId('Ember') })],
      /Flash Fire raised the power of Fire-type moves!$/, /Flash Fire made Ember ineffective!$/);
    chk('Flash Fire after a switch is "first" again', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Flash Fire'), fx: 'flash-fire' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Flash Fire'), mv: mvId('Ember') }), E(rr, FOE, { t: 'faint' }), E(rr, FOE, { t: 'ability', ab: abId('Flash Fire'), fx: 'flash-fire' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Flash Fire'), mv: mvId('Ember') })],
      /raised the power of Fire-type moves!$/, /fainted!$/, /raised the power of Fire-type moves!$/);
    const PW = (rr, w) => rr.play([{ t: 'weather', s: FOE, m: act(rr, FOE), w }]);
    for (const [w, re] of [[6, /Rain continues to fall\.$/], [7, /The sunlight is strong\.$/], [8, /blow on regardless!$/]]) chk('primal weather ' + w + ': each turn says the weather\'s own line (MEASURED, 0x442124 0x442... 0x43f781)', (rr) => { PW(rr, w); return [{ t: 'weather-tick', w }]; }, re);
    chk('a Fire move in heavy rain "The Fire-type attack fizzled out in the heavy rain!" and nothing else (MEASURED, 0x43f849)', (rr) => { PW(rr, 6); return [mu(rr, ME, 'Ember'), E(rr, ME, { t: 'fail', mv: mvId('Ember'), why: 'primal-weather' })]; }, /used Ember!$/, /fizzled out in the heavy rain!$/);
    chk('a Water move in harsh sun "The Water-type attack evaporated in the extremely harsh sunlight!" (MEASURED, 0x43f8ee)', (rr) => { PW(rr, 7); return [mu(rr, ME, 'Water Gun'), E(rr, ME, { t: 'fail', mv: mvId('Water Gun'), why: 'primal-weather' })]; }, /used Water Gun!$/, /evaporated in the extremely harsh sunlight!$/);
    chk('a weather move into heavy rain / harsh sun / strong winds says which one it cannot change, then "But it failed!" (MEASURED)', (rr) => { PW(rr, 6); return [mu(rr, ME, 'Sunny Day'), E(rr, ME, { t: 'fail', mv: mvId('Sunny Day'), why: 'failed' })]; }, /used Sunny Day!$/, /There is no relief from this heavy rain!$/, /But it failed!$/);
    chk('... harsh sun', (rr) => { PW(rr, 7); return [mu(rr, ME, 'Rain Dance'), E(rr, ME, { t: 'fail', mv: mvId('Rain Dance'), why: 'failed' })]; }, /used Rain Dance!$/, /sunlight was not lessened at all!$/, /But it failed!$/);
    chk('... strong winds', (rr) => { PW(rr, 8); return [mu(rr, ME, 'Rain Dance'), E(rr, ME, { t: 'fail', mv: mvId('Rain Dance'), why: 'failed' })]; }, /used Rain Dance!$/, /blow on regardless!$/, /But it failed!$/);
    chk('a non-weather move that fails in a primal weather is still just "But it failed!"', (rr) => { PW(rr, 6); return [mu(rr, ME, 'Tackle'), E(rr, ME, { t: 'fail', mv: mvId('Tackle'), why: 'failed' })]; }, /used Tackle!$/, /But it failed!$/);
    chk('the primal weather ends and a move fails: no stale primal line', (rr) => { PW(rr, 6); rr.play([{ t: 'weather-end', w: 6 }]); return [mu(rr, ME, 'Sunny Day'), E(rr, ME, { t: 'fail', mv: mvId('Sunny Day'), why: 'failed' })]; }, /used Sunny Day!$/, /But it failed!$/);
    // the entry announcements and Slow Start's end: MEASURED lines; the ENGINE does not emit these fx codes yet (ENGINE REQUEST 1/2): the scene is ready for them
    const ENT = [['pressure', /is exerting its pressure!$/], ['mold-breaker', /breaks the mold!$/], ['turboblaze', /is radiating a blazing aura!$/], ['teravolt', /is radiating a bursting aura!$/], ['dark-aura', /is radiating a dark aura!$/], ['fairy-aura', /is radiating a fairy aura!$/], ['aura-break', /reversed all other Pokémon's auras!$/],
      ['anticipation', /shuddered!$/], ['weather-lock', /The effects of the weather disappeared\.$/], ['slow-start-end', /finally got its act together!$/]];
    for (const [fx, re] of ENT) chk('(requested) ability fx ' + fx + ' says the ROM line (' + (['anticipation'].includes(fx) ? 'ROM 0x4408fe; not oracle-reached' : 'MEASURED') + ')', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Intimidate'), fx })], re);
    chk('(requested) Forewarn "Forewarn alerted <holder> to <foe>\'s <move>!" (MEASURED, 0x4408e4)', (rr) => [E(rr, ME, { t: 'ability', ab: abId('Forewarn'), fx: 'forewarn', mv: mvId('Tackle') })], /^Forewarn alerted .* to .*'s Tackle!$/);
    chk('(requested) Frisk "<holder> frisked <foe> and found its <item>!" (MEASURED, 0x44084f)', (rr) => [E(rr, ME, { t: 'ability', ab: abId('Frisk'), fx: 'frisk', it: ids.oran })], /frisked .* and found its Oran Berry!$/);
    chk('a damage event flagged `winds` says the strong-winds line FIRST and then the effectiveness of what is left (MEASURED, 0x43f750; round 8 corrected: it used to replace the effectiveness line)', (rr) => [E(rr, FOE, { t: 'damage', from: 100, to: 90, max: 100, src: 'move', mv: mvId('Rock Slide'), eff: 2048, winds: 1 })], /The mysterious strong winds weakened the attack!$/, /not very effective/);
    // a called move other than those above: Magic Bounce's has its own line, a bare called move is silent
    chk('a called move with no caller context is silent', (rr) => [mu(rr, ME, 'Tackle', { called: 1 })]);
  }
  {
    chk('Spite: the TARGET\'s move loses PP: "<target> lost 4 PP from <move>!" (MEASURED: the player\'s Spite named the wild Pokemon)', (rr) => [E(rr, FOE, { t: 'noop', what: 'spite', mv: mvId('Tackle'), n: 4 })], /^The opposing .* lost 4 PP from Tackle!$/);
    chk('infatuation: every turn "<mon> is in love with <foe>!" (MEASURED, 0x44323f)', (rr) => [E(rr, ME, { t: 'volatile', v: 'infatuated' })], /is in love with the opposing /);
    chk('Nightmare: "began having a nightmare!" and each turn "is locked in a nightmare!" (MEASURED, 0x442a81 0x442a61)', (rr) => [E(rr, FOE, { t: 'volatile', v: 'nightmare' }), E(rr, FOE, { t: 'damage', from: 100, to: 75, max: 100, src: 'nightmare', eff: 4096 })], /began having a nightmare!$/, /is locked in a nightmare!$/);
    chk('items: Bestow / Incinerate / Pluck (MEASURED, 0x4402b1 0x43fec2 0x43fea0)', (rr) => [E(rr, ME, { t: 'item', it: ids.oran, fx: 'bestow' }), E(rr, FOE, { t: 'item', it: ids.oran, fx: 'incinerate', used: 1 }), E(rr, FOE, { t: 'item', it: ids.oran, fx: 'pluck', used: 0 })], /^The opposing .* received Oran Berry from /, /'s Oran Berry was burnt up!$/, /stole and ate its target's Oran Berry!$/);
    chk('items: Recycle "found one <item>!" (ROM 0x44174a) and a Focus Band "hung on using its <item>!" (ROM 0x4418ce)', (rr) => [E(rr, ME, { t: 'item', it: ids.oran, fx: 'recycle' }), E(rr, ME, { t: 'item', it: ids.oran, fx: 'focus-band' })], /found one Oran Berry!$/, /hung on using its Oran Berry!$/);
    chk('heal by Rain Dish / Dry Skin in rain: "<mon>\'s <ability> restored its HP a little!" (MEASURED, 0x4418ac)', (rr) => [E(rr, FOE, { t: 'heal', from: 50, to: 62, max: 100, src: 'rain-dish' }), E(rr, FOE, { t: 'heal', from: 50, to: 62, max: 100, src: 'dry-skin' })], /Rain Dish restored its HP a little!$/, /Dry Skin restored its HP a little!$/);
    chk('heal by Ice Body "<mon>\'s Ice Body healed it a little bit!" and Poison Heal "The poisoning healed <mon> a little bit!" (MEASURED, 0x4408c4 0x4409e1)', (rr) => [E(rr, FOE, { t: 'heal', from: 50, to: 62, max: 100, src: 'ice-body' }), E(rr, FOE, { t: 'heal', from: 50, to: 62, max: 100, src: 'poison-heal' })], /Ice Body healed it a little bit!$/, /^The poisoning healed .* a little bit!$/);
    chk('Dry Skin in the sun "<mon>\'s Dry Skin takes its toll!" (MEASURED, 0x44091d)', (rr) => [E(rr, FOE, { t: 'damage', from: 100, to: 88, max: 100, src: 'dry-skin', eff: 4096 })], /Dry Skin takes its toll!$/);
    {
      // Stockpile (MEASURED, scratchpad scn7 through the oracle): the engine has no count / end event, so the scene reads them off the move's own events (ROM 0x442d99 "<mon> stockpiled N!", 0x43ed80 "<mon>'s stockpiled effect wore off!")
      const sc = (rr, st, d) => E(rr, ME, { t: 'stat-change', stat: st, delta: d, now: d });
      const stk = (rr) => [mu(rr, ME, 'Stockpile'), sc(rr, 'def', 1), sc(rr, 'spd', 1)];
      const rr = rig(); let o = rr.play(stk(rr));
      t('stockpile: "used", "stockpiled 1!", then ONE "Defense and Sp. Def rose!" line (MEASURED)', lines(o).length === 3 && /stockpiled 1!$/.test(lines(o)[1]) && /'s Defense and Sp\. Def rose!$/.test(lines(o)[2]), JSON.stringify(lines(o)));
      o = rr.play(stk(rr)); t('stockpile: the second one says 2', lines(o).length === 3 && /stockpiled 2!$/.test(lines(o)[1]), JSON.stringify(lines(o)));
      o = rr.play([mu(rr, ME, 'Swallow'), E(rr, ME, { t: 'heal', from: 50, to: 75, max: 100, src: 'swallow' }), sc(rr, 'def', -2), sc(rr, 'spd', -2)]);
      t('swallow: the heal, ONE "Defense and Sp. Def harshly fell!" line, then "stockpiled effect wore off!" (MEASURED)', lines(o).length === 4 && /'s Defense and Sp\. Def harshly fell!$/.test(lines(o)[2]) && /'s stockpiled effect wore off!$/.test(lines(o)[3]), JSON.stringify(lines(o)));
      o = rr.play(stk(rr)); t('stockpile: after the end the count starts at 1 again', lines(o).length === 3 && /stockpiled 1!$/.test(lines(o)[1]), JSON.stringify(lines(o)));
      o = rr.play([mu(rr, ME, 'Spit Up'), E(rr, FOE, { t: 'damage', from: 100, to: 80, max: 100, src: 'move', eff: 4096, mv: mvId('Spit Up') }), sc(rr, 'def', -1), sc(rr, 'spd', -1)]);
      t('spit up: ONE "Defense and Sp. Def fell!" line, then "wore off!" (MEASURED)', lines(o).length === 3 && /'s Defense and Sp\. Def fell!$/.test(lines(o)[1]) && /wore off!$/.test(lines(o)[2]), JSON.stringify(lines(o)));
      o = rr.play([mu(rr, ME, 'Spit Up'), E(rr, ME, { t: 'fail', mv: mvId('Spit Up'), why: 'failed' })]);
      t('spit up with nothing stored: only "But it failed!" (no "wore off")', lines(o).length === 2 && /But it failed!$/.test(lines(o)[1]), JSON.stringify(lines(o)));
      rr.play(stk(rr)); rr.play(stk(rr)); rr.play(stk(rr)); o = rr.play([mu(rr, ME, 'Stockpile'), E(rr, ME, { t: 'fail', mv: mvId('Stockpile'), why: 'failed' })]);
      t('a fourth Stockpile fails: no "stockpiled 4!"', lines(o).length === 2 && /But it failed!$/.test(lines(o)[1]), JSON.stringify(lines(o)));
      o = rr.play([mu(rr, ME, 'Swallow'), E(rr, ME, { t: 'heal', from: 50, to: 100, max: 100, src: 'swallow' }), sc(rr, 'def', -3), sc(rr, 'spd', -3)]);
      t('swallow after three: "severely fell!" in ONE line', lines(o).length === 4 && /Defense and Sp\. Def severely fell!$/.test(lines(o)[2]), JSON.stringify(lines(o)));
      const r2 = rig(); o = r2.play([mu(r2, ME, 'Stockpile'), sc(r2, 'def', 1), E(r2, ME, { t: 'stat-fail', stat: 'spd', why: 'max' })]);
      t('stockpile with the two changes NOT a pair keeps two lines', lines(o).length === 4 && /stockpiled 1!$/.test(lines(o)[1]) && /Defense rose!$/.test(lines(o)[2]) && /Sp\. Def won't go any higher!$/.test(lines(o)[3]), JSON.stringify(lines(o)));
    }
    {
      // AN1 round 8: the binding moves, Rapid Spin and Delta Stream's weakened hits. MEASURED through the oracle (scratchpad scn9, scn11, scn13): every binding move has a start line of its own and names itself in
      // "is hurt by <move>!" and "was freed from <move>!" (ROM 0x442f93 0x442fcd 0x442f7a 0x442faa 0x441661 0x440efb 0x440308 0x43ecf6 0x43f47c, 0x442f66, 0x442f4f); Rapid Spin: Speed rose, "got free of <foe>'s <move>!" (0x4428f4),
      // "shed Leech Seed!" (0x4428e0), then the hazards, in that order
      const TRAPS = [['Wrap', /^Volcarona was wrapped by the opposing .*!$/], ['Bind', /was squeezed by the opposing/], ['Clamp', /^The opposing .* clamped down on Volcarona!$/], ['Fire Spin', /became trapped in the vortex!$/], ['Whirlpool', /became trapped in the vortex!$/],
        ['Sand Tomb', /became trapped by the quicksand!$/], ['Magma Storm', /became trapped by swirling magma!$/], ['Infestation', /has been afflicted with an infestation by the opposing/], ['Thunder Cage', /^The opposing .* trapped Volcarona!$/], ['Snap Trap', /got trapped by a snap trap!$/]];
      for (const [nm, re] of TRAPS) {
        const rr = rig(); const l = lines(rr.play([mu(rr, FOE, nm), E(rr, ME, { t: 'volatile', v: 'trap', var: 0 }), E(rr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'trap' }), E(rr, ME, { t: 'volatile-end', v: 'trap' })]));
        t('trap ' + nm + ': the move\'s own start line, "is hurt by ' + nm + '!", "was freed from ' + nm + '!" (MEASURED)', l.length === 4 && re.test(l[1]) && new RegExp(' is hurt by ' + nm + '!$').test(l[2]) && new RegExp(' was freed from ' + nm + '!$').test(l[3]), JSON.stringify(l));
      }
      {
        const rr = rig(); rr.play([mu(rr, FOE, 'Wrap'), E(rr, ME, { t: 'volatile', v: 'trap', var: 0 }), E(rr, ME, { t: 'volatile', v: 'leech-seed' }), hz(rr, ME, 'spikes')]);
        const l = lines(rr.play([mu(rr, ME, 'Rapid Spin'), E(rr, ME, { t: 'stat-change', stat: 'spe', delta: 1, now: 1 }), E(rr, ME, { t: 'volatile-end', v: 'trap', why: 'rapid-spin', var: 0 }), E(rr, ME, { t: 'volatile-end', v: 'leech-seed', why: 'rapid-spin' }), E(rr, ME, { t: 'hazard-clear', hz: 'all' })]));
        t('Rapid Spin: Speed rose, got free of the foe\'s Wrap, shed Leech Seed, blew away Spikes - in the game\'s order (MEASURED)', l.length === 5 && /used Rapid Spin!$/.test(l[0]) && /Speed rose!$/.test(l[1]) && /^Volcarona got free of the opposing .*'s Wrap!$/.test(l[2]) && /^Volcarona shed Leech Seed!$/.test(l[3]) && /blew away Spikes!$/.test(l[4]), JSON.stringify(l));
        const r3 = rig(); const l3 = lines(r3.play([mu(r3, ME, 'Rapid Spin'), E(r3, ME, { t: 'stat-change', stat: 'spe', delta: 1, now: 1 })]));
        t('Rapid Spin with nothing to free says only the move and the Speed rise', l3.length === 2, JSON.stringify(l3));
      }
      const dmw = (rr, eff, o) => E(rr, ME, Object.assign({ t: 'damage', from: 100, to: 70, max: 100, src: 'move', eff, mv: mvId('Rock Slide') }, o));
      for (const [lbl, eff, re] of [['neutral', 4096, null], ['super effective', 8192, /^It's super effective!$/], ['not very effective', 2048, /^It's not very effective/]]) {
        const rr = rig(); const l = lines(rr.play([mu(rr, FOE, 'Rock Slide'), dmw(rr, eff, { winds: 1 })]));
        t('Delta Stream clamp, ' + lbl + ' after it: the weakened line FIRST, then what is left (MEASURED, scn13)', l.length === (re ? 3 : 2) && /^The mysterious strong winds weakened the attack!$/.test(l[1]) && (!re || re.test(l[2])), JSON.stringify(l));
      }
      { const rr = rig(); const l = lines(rr.play([mu(rr, FOE, 'Rock Slide'), dmw(rr, 8192)])); t('no clamp, super effective: only the effectiveness line', l.length === 2 && /^It's super effective!$/.test(l[1]), JSON.stringify(l)); }
    }
    {
      // AN1 round 8: the entry announcements the engine now emits, WORDING and WHO says it. MEASURED through the oracle (scratchpad scn10, scn12 at level 80 where Forewarn / Anticipation need it): the holder's own
      // name and the foe's move in Forewarn, the item in Frisk, a foe holder reads the same with the sides swapped
      const me = nameOf(r, ME), fo = nameOf(r, FOE);
      const AB = (rr, side, name, fx, extra) => E(rr, side, Object.assign({ t: 'ability', ab: abId(name), fx }, extra));
      const one = (build) => { const rr = rig(); return lines(rr.play(build(rr))); };
      const q = (x) => x.split('').map((c) => (/[A-Za-z0-9 ]/.test(c) ? c : String.fromCharCode(92) + c)).join('');
      let l = one((rr) => [AB(rr, ME, 'Forewarn', 'forewarn', { mv: mvId('Hyper Fang') })]);
      t('Forewarn (mine): "Forewarn alerted <me> to the opposing <foe>\'s Hyper Fang!" (MEASURED)', l.length === 1 && new RegExp('^Forewarn alerted ' + q(me) + " to the opposing " + q(fo) + "'s Hyper Fang!$").test(l[0]), JSON.stringify(l));
      l = one((rr) => [AB(rr, FOE, 'Forewarn', 'forewarn', { mv: mvId('Hyper Fang') })]);
      t('Forewarn (the foe\'s): "Forewarn alerted the opposing <foe> to <me>\'s Hyper Fang!" (MEASURED)', l.length === 1 && new RegExp('^Forewarn alerted the opposing ' + q(fo) + ' to ' + q(me) + "'s Hyper Fang!$").test(l[0]), JSON.stringify(l));
      l = one((rr) => [AB(rr, ME, 'Frisk', 'frisk', { it: ids.oran })]);
      t('Frisk (mine): "<me> frisked the opposing <foe> and found its Oran Berry!" (MEASURED)', l.length === 1 && new RegExp('^' + q(me) + ' frisked the opposing ' + q(fo) + ' and found its Oran Berry!$').test(l[0]), JSON.stringify(l));
      l = one((rr) => [AB(rr, FOE, 'Frisk', 'frisk', { it: ids.oran })]);
      t('Frisk (the foe\'s): "The opposing <foe> frisked <me> and found its Oran Berry!" (MEASURED)', l.length === 1 && new RegExp('^The opposing ' + q(fo) + ' frisked ' + q(me) + ' and found its Oran Berry!$').test(l[0]), JSON.stringify(l));
      l = one((rr) => [AB(rr, ME, 'Anticipation', 'anticipation')]); t('Anticipation (mine): "<me> shuddered!" (MEASURED)', l.length === 1 && l[0] === me + ' shuddered!', JSON.stringify(l));
      l = one((rr) => [AB(rr, FOE, 'Anticipation', 'anticipation')]); t('Anticipation (the foe\'s): "The opposing <foe> shuddered!"', l.length === 1 && l[0] === 'The opposing ' + fo + ' shuddered!', JSON.stringify(l));
      l = one((rr) => [AB(rr, FOE, 'Pressure', 'pressure')]); t('Pressure (the foe\'s): "The opposing <foe> is exerting its pressure!" (MEASURED)', l.length === 1 && l[0] === 'The opposing ' + fo + ' is exerting its pressure!', JSON.stringify(l));
      l = one((rr) => [AB(rr, ME, 'Mold Breaker', 'mold-breaker')]); t('Mold Breaker (mine): "<me> breaks the mold!" (MEASURED)', l.length === 1 && l[0] === me + ' breaks the mold!', JSON.stringify(l));
      l = one((rr) => [E(rr, ME, { t: 'weather', w: 8, s: FOE }), { t: 'weather-tick', w: 8 }]); t('Delta Stream: the start line, then the per-turn line (MEASURED, scn3)', l.length === 2 && /^Mysterious strong winds are protecting Flying-type Pok/.test(l[0]) && l[1] === 'The mysterious strong winds blow on regardless!', JSON.stringify(l));
    }
    chk('Water Absorb with room to heal: "restored HP using its Water Absorb!" and NO immunity line (MEASURED, 0x442459)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Water Absorb'), fx: 'absorb' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Water Absorb'), mv: mvId('Water Gun') }), E(rr, FOE, { t: 'heal', from: 50, to: 75, max: 100, src: 'water-absorb' })], /^The opposing .* restored HP using its Water Absorb!$/);
    chk('Water Absorb at full HP: "made <move> useless!" (MEASURED, 0x441688)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Water Absorb'), fx: 'absorb' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Water Absorb'), mv: mvId('Water Gun') })], /Water Absorb made Water Gun useless!$/);
    chk('Lightning Rod / Sap Sipper: only the stat line (MEASURED)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Lightning Rod'), fx: 'absorb' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Lightning Rod'), mv: mvId('Thunder Shock') }), E(rr, FOE, { t: 'stat-change', stat: 'spa', delta: 1 })], /Sp\. Atk rose!$/);
    chk('Levitate / Wonder Guard: the plain "It doesn\'t affect <mon>" (MEASURED)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Levitate'), fx: 'levitate' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Levitate'), mv: mvId('Earthquake') })], /^It doesn't affect the opposing /);
    chk('Soundproof / Bulletproof "<mon>\'s <ability> blocks <move>!" (MEASURED, 0x441417)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Soundproof'), fx: 'soundproof' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Soundproof'), mv: mvId('Hyper Voice') })], /Soundproof blocks Hyper Voice!$/);
    chk('Dazzling / Queenly Majesty / Armor Tail "<mon>\'s <ability> prevents <foe> from using <move>!" (ROM 0x442479; not oracle-reached)', (rr) => [E(rr, FOE, { t: 'ability', ab: abId('Dazzling'), fx: 'dazzling' }), E(rr, FOE, { t: 'immune', why: 'ability', ab: abId('Dazzling'), mv: mvId('Quick Attack') })], /Dazzling prevents .* from using Quick Attack!$/);
    chk('Heal Bell: one "A bell chimed!" for the move, nothing per Pokemon; Aromatherapy the aroma line (MEASURED, 0x441ec7 0x441720)', (rr) => [mu(rr, ME, 'Heal Bell'), E(rr, ME, { t: 'status-clear', st: 2, why: 'heal-bell' }), E(rr, FOE, { t: 'status-clear', st: 2, why: 'heal-bell' }), mu(rr, ME, 'Aromatherapy'), E(rr, ME, { t: 'status-clear', st: 2, why: 'heal-bell' })], /used Heal Bell!$/, /A bell chimed!$/, /used Aromatherapy!$/, /A soothing aroma wafted through the area!$/);
    chk('Purify "<user> cured <target>\'s problem!" (MEASURED, 0x43fe6e)', (rr) => [mu(rr, ME, 'Purify'), E(rr, FOE, { t: 'status-clear', st: 2, why: 'purify' })], /used Purify!$/, /cured the opposing .*'s problem!$/);
  }
  {
    const nm = pack.moves.length;
    t('lines: the catalog has the keys these checks read, all ROM-pinned', ['hz.away.spikes', 'tidy', 'snatch.set', 'copy.roleplay', 'item.statup', 'steal', 'trick.both', 'wx.fizzle.rain', 'ab.static', 'dmg.toll', 'ab.pressure', 'wx.winds.weak', 'trap.free', 'word.magnet'].every((k) => text.has(k) && text.source(k) !== 'fallback' && manifest.strings[k] && manifest.strings[k].off > 0x43c14c), '');
    void nm;
  }
  if (opts.fast && opts.only !== 'sweep') return f;

  /* ---- 2. the table: every event code of the engine source and of a sweep of every legal move and item, against its row ---- */
  const scan = scanEmitCodes();
  const rows = Object.keys(EVENT_CODES);
  // codes the source names with literals
  const srcCodes = new Set(); for (const [k, fields] of scan.kinds) { const d = DISC[k]; if (!d) { if (k !== 'ability') srcCodes.add(k); continue; } for (const fld of d) { const vals = fields.get(fld); if (vals) for (const v of vals) srcCodes.add(d.length === 1 ? k + ':' + fld + '=' + v : k + ':' + d.map((x) => x + '=' + (x === fld ? v : '')).join(',')); } }
  const kindsInTable = new Set(rows.map((c) => c.split(':')[0]));
  const ENGINE_KINDS = new Set(EM.engine.EVENT_CODES);
  t('table: every event KIND of the engine (EVENT_CODES, ' + ENGINE_KINDS.size + ' kinds; ' + scan.total + ' emit calls scanned) has a row, except `ability` (its own table in pokemonarena_scene_events_test.mjs)', [...ENGINE_KINDS].filter((k) => k !== 'ability').every((k) => kindsInTable.has(k)), [...ENGINE_KINDS].filter((k) => k !== 'ability' && !kindsInTable.has(k)).join(','));
  t('table: every row\'s kind is one the engine has', [...kindsInTable].every((k) => ENGINE_KINDS.has(k)), [...kindsInTable].filter((k) => !ENGINE_KINDS.has(k)).join(','));
  t('table: every emit literal the source scan found is a kind of the engine', [...scan.kinds.keys()].every((k) => ENGINE_KINDS.has(k)), [...scan.kinds.keys()].filter((k) => !ENGINE_KINDS.has(k)).join(','));
  // the srcs / fx the source names with literals in dealDamage / healMon / setStatus / consumeItem calls: each must be in some row's code
  const lit = { damage: new Set(), heal: new Set(), status: new Set(), item: new Set() };
  for (const fl of fs.readdirSync(JS).filter((x) => /^engine.*\.js$/.test(x))) {
    const src = fs.readFileSync(path.join(JS, fl), 'utf8');
    for (const m of src.matchAll(/dealDamage\([^;]*?src:\s*'([a-z-]+)'/g)) lit.damage.add(m[1]);
    for (const m of src.matchAll(/healMon\([^;]*?src:\s*'([a-z-]+)'/g)) lit.heal.add(m[1]);
    for (const m of src.matchAll(/setStatus\([^;]*?fx:\s*'([a-z-]+)'/g)) lit.status.add(m[1]);
    for (const m of src.matchAll(/consumeItem\([^,;]*,\s*'([a-z-]+)'/g)) lit.item.add(m[1]);
  }
  const hasRow = (kind, field, v) => rows.some((c) => c.startsWith(kind + ':') && new RegExp('(^|[:,])' + field + '=' + v.replace(/[-]/g, '\\-') + '($|,)').test(c));
  const litMissing = [...[...lit.damage].filter((v) => !hasRow('damage', 'src', v)).map((v) => 'damage:' + v), ...[...lit.heal].filter((v) => !hasRow('heal', 'src', v)).map((v) => 'heal:' + v), ...[...lit.status].filter((v) => !hasRow('status-set', 'fx', v)).map((v) => 'status:' + v), ...[...lit.item].filter((v) => !hasRow('item', 'fx', v)).map((v) => 'item:' + v)];
  t('table: every src / fx the source names in dealDamage / healMon / setStatus / consumeItem calls is in a row (' + lit.damage.size + ' damage srcs, ' + lit.heal.size + ' heal srcs, ' + lit.status.size + ' status fx, ' + lit.item.size + ' item fx)', litMissing.length === 0, litMissing.join(' | '));
  const swept = collectSamples(L, pack, ids);
  t('sweep: ' + swept.nBattles + ' real-engine battles (every legal move and item, random foes / abilities / items / weather / terrain / hazards / screens) ran, ' + swept.nEvents + ' events, no engine error', swept.nErr === 0 && swept.nBattles > 3000, swept.nErr + ' errors, ' + swept.nBattles + ' battles');
  const unknown = [...swept.samples.keys()].filter((c) => !EVENT_CODES[c]);
  t('sweep: every code the engine emitted in the sweep is a row of the table', unknown.length === 0, unknown.join(' | '));
  const literalMissing = [...srcCodes].filter((c) => !EVENT_CODES[c] && ![...rows].some((x) => x.startsWith(c.split(',')[0])));
  t('table: every literal code the engine source names is a row (or a row of the same field value)', literalMissing.length === 0, literalMissing.join(' | '));

  // samples of the codes the sweep did not reach: one injected event (or a setup the code needs)
  const injected = new Map();
  for (const code of rows) {
    if (swept.samples.has(code) && !SETUP_CODES.has(code)) continue;
    const mkr = rig(); const side = ME, a = act(mkr, side);
    let pre = null, evs, i = 0;
    if (code === 'hazard-clear:hz=all') { pre = [hz(mkr, ME, 'spikes'), hz(mkr, ME, 'web'), hz(mkr, ME, 'tspikes'), hz(mkr, ME, 'rocks')]; evs = [mu(mkr, ME, 'Rapid Spin'), E(mkr, ME, { t: 'hazard-clear', hz: 'all' })]; i = 1; }
    else if (code === 'hazard-clear:hz=tspikes') { pre = [hz(mkr, ME, 'tspikes')]; evs = [E(mkr, ME, { t: 'hazard-clear', hz: 'tspikes' })]; }
    else if (code === 'fail:why=primal-weather') { pre = [{ t: 'weather', s: FOE, m: act(mkr, FOE), w: 6 }]; evs = [mu(mkr, ME, 'Ember'), E(mkr, ME, { t: 'fail', mv: mvId('Ember'), why: 'primal-weather' })]; i = 1; }
    else if (code === 'damage:src=jaboca') { evs = [E(mkr, FOE, { t: 'item', it: itId('Jaboca Berry'), fx: 'thorn-berry', used: 1 }), E(mkr, ME, { t: 'damage', from: 100, to: 88, max: 100, src: 'jaboca', eff: 4096 })]; i = 1; }
    else if (SETUP[code]) { const sp = SETUP[code](mkr, { mu, hz, E, ids, mvId, itId, abId, ME, FOE, act }); pre = sp.pre || null; evs = sp.evs; i = sp.i === undefined ? sp.evs.length - 1 : sp.i; }
    else evs = [genEvent(code, side, a, ids)];
    injected.set(code, [{ pre, evs, i, tag: 'injected' }]);
  }
  const allSamples = (code) => (SETUP_CODES.has(code) ? injected.get(code) : swept.samples.get(code) || injected.get(code)) || [];

  // play one sample with / without its event in a FRESH scene; the keys text.compose was asked for are recorded
  const playS = (s, withTarget) => {
    const rr = rig(); if (s.pre) rr.play(s.pre);
    const evs = withTarget ? s.evs : s.evs.filter((_x, q) => q !== s.i);
    REC.keys = []; const o = rr.play(evs); const keys = REC.keys.slice();
    return { texts: o.texts, keys, err: o.err, fb: [...rr.scene.fallbacks()] };
  };
  const stats = { O: 0, C: 0, Z: 0 }; const dump = [];
  let nPlays = 0, nThrow = 0, nFlag = 0;
  for (const code of rows) {
    const row = EVENT_CODES[code]; stats[row.need === 'own' ? 'O' : row.need === 'carried' ? 'C' : 'Z']++;
    const ss = allSamples(code);
    if (!ss.length) { t('code ' + code + ': seen in the sweep or injectable', false, 'no sample'); continue; }
    let own = 0, byOk = false; const added = new Set(), addedKeys = new Set(), flagged = new Set(); let err = null; let sampleTexts = null;
    for (const s of ss) {
      const a = playS(s, true), b = playS(s, false); nPlays += 2;
      if (a.err || b.err) { err = a.err || b.err; nThrow++; }
      const dt = msetDiff(a.texts, b.texts), dk = msetDiff(a.keys, b.keys);
      a.fb.forEach((x) => { if (!ALLOWED_FB.has(x)) flagged.add(x); });
      if (a.texts.some((x) => String(x).trim() === '' || KEYLIKE.test(String(x).trim()))) flagged.add('BLANK/KEY text');
      if (dt.length) { own++; dt.forEach((x) => added.add(x)); dk.forEach((x) => addedKeys.add(x)); if (!sampleTexts) sampleTexts = dt.slice(0, 2); }
      if (row.need === 'carried' && row.by.test(a.texts.join(' | '))) byOk = true;
    }
    nFlag += flagged.size;
    const keysOK = [...addedKeys].filter((k) => manifest.strings[k]);
    t('code ' + code + ': plays without a throw, no flagged fallback, no blank text', !err && flagged.size === 0, (err || '') + ' ' + [...flagged].join(','));
    if (row.need === 'own') {
      const wantOK = !row.keys || row.keys.some((k) => addedKeys.has(k));
      t('code ' + code + ': O - the event adds a line of the ROM\'s text (' + own + ' of ' + ss.length + ' samples)' + (row.keys ? ', through ' + row.keys.join(' / ') : ''), own > 0 && wantOK, 'added ' + JSON.stringify([...added].slice(0, 2)) + ' keys ' + [...addedKeys].slice(0, 5).join(','));
      if (own > 0) t('code ' + code + ': every ROM key it used is pinned in text_manifest.json', [...addedKeys].every((k) => !manifest.strings[k] || (manifest.strings[k].off > 0x43c14c && text.source(k) !== 'fallback')), [...addedKeys].filter((k) => manifest.strings[k] && text.source(k) === 'fallback').join(','));
    } else if (row.need === 'carried') {
      t('code ' + code + ': C - the event adds nothing, another event of the turn says it (' + row.by + ')', own === 0 && byOk, 'own ' + own + ' by ' + byOk + ' added ' + JSON.stringify([...added].slice(0, 2)));
    } else {
      const present = (row.kw || []).filter((k) => romBlob.includes(normKw(k)) && !ELSEWHERE[normKw(k)]);
      t('code ' + code + ': Z - the event adds nothing and no ROM battle line names ' + JSON.stringify(row.kw) + ' (' + row.note + ')', own === 0 && present.length === 0, 'own ' + own + ' ' + JSON.stringify([...added].slice(0, 2)) + ' ROM names: ' + present.join(','));
    }
    if (process.env.ARENA_EVDUMP) dump.push(code.padEnd(46) + row.need.padEnd(8) + String(own).padStart(3) + '/' + ss.length + ' ' + [...addedKeys].map((k) => k + (manifest.strings[k] ? '@0x' + manifest.strings[k].off.toString(16) : '')).join(' ').slice(0, 90));
  }
  t('table: the sweep and the injections played ' + nPlays + ' scene runs over ' + rows.length + ' codes (' + stats.O + ' O, ' + stats.C + ' C, ' + stats.Z + ' Z), none threw', nThrow === 0 && rows.length > 380, nThrow + ' threw');
  if (process.env.ARENA_EVDUMP) console.log(dump.join('\n'));
  core.summary = { rows: rows.length, ...stats, battles: swept.nBattles, events: swept.nEvents, plays: nPlays };
  return f;
}

/* ======================================================================================== run */
const real = await loadStack(JS);
const realFails = await core(real, {});
for (const x of realFails) ok(false, 'core: ' + x);
ok(realFails.length === 0, '1. every event-code check passes on the real tree (' + realFails.length + ' failing)');
if (core.summary) console.log('event-code table: ' + JSON.stringify(core.summary));

if (process.env.ARENA_SKIP_MUTANTS !== '1') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-evcodes-'));
  const copyTree = (name) => { const d = path.join(tmp, name); fs.cpSync(JS, d, { recursive: true }); return d; };
  const twinDir = copyTree('twin'); const twin = await loadStack(twinDir, '?twin'); const twinFails = await core(twin, { fast: true });
  ok(twinFails.length === 0, '2. the unmutated twin (copied tree, fast mode) is quiet', twinFails.slice(0, 3).join(' | '));
  const mutants = [
    ['scene.js', 'hazards are not remembered (a sweep names nothing)', (s) => s.replace('S.notes.hz[e.s].add(hk);', '')],
    ['scene.js', 'hazards are remembered on the wrong side', (s) => s.replace('S.notes.hz[e.s].add(hk);', 'S.notes.hz[e.s ^ 1].add(hk);')],
    ['scene.js', 'Rapid Spin says "disappeared" like Defog', (s) => s.replace("const spin = /Spin$/.test(S.notes.lastMove[userSide] || '');", 'const spin = false;')],
    ['scene.js', 'a sweep names the hazards in the wrong order', (s) => s.replace("const HZ_ORDER = ['spikes', 'web', 'tspikes', 'rocks'];", "const HZ_ORDER = ['rocks', 'tspikes', 'web', 'spikes'];")],
    ['scene.js', 'Tidy Up never says "Tidying up complete!"', (s) => s.replace("if (tidyFor === e.s) { tidyFor = -1; qMsg('tidy', roles(e.s)); }", 'if (tidyFor === e.s) { tidyFor = -1; }')],
    ['scene.js', 'Court Change does not move the hazards', (s) => s.replace("if (e.k === 'court-change') { const t0 = S.notes.hz[0]; S.notes.hz[0] = S.notes.hz[1]; S.notes.hz[1] = t0; }", '')],
    ['scene.js', 'Snatch working says nothing', (s) => s.replace("else if (e.why === 'snatched') qMsg('snatch.done'", "else if (e.why === 'zzz') qMsg('snatch.done'")],
    ['scene.js', 'Skill Swap says nothing', (s) => s.replace("if (e.how === 'skill-swap') qMsg('ab.swapped', roles(e.s));", "if (e.how === 'zzz') qMsg('ab.swapped', roles(e.s));")],
    ['scene.js', 'Psych Up says nothing', (s) => s.replace("else if (e.how === 'psych-up') qMsg('copy.psychup'", "else if (e.how === 'zzz') qMsg('copy.psychup'")],
    ['scene.js', 'Mimic says nothing', (s) => s.replace("else if (e.how === 'mimic') qMsg('copy.mimic'", "else if (e.how === 'zzz') qMsg('copy.mimic'")],
    ['scene.js', 'the move Mirror Move calls is not announced', (s) => s.replace("'copycat', 'me-first', 'assist', 'mirror-move',", "'copycat', 'me-first', 'assist',")],
    ['scene.js', 'every called move is announced (Metronome too)', (s) => s.replace("if (!e.called || (pv && ((pv.t === 'ability'", "if (true || (pv && ((pv.t === 'ability'")],
    ['scene.js', 'Electrify says nothing', (s) => s.replace("electrify: 'vol.electrify', ", '')],
    ['scene.js', 'Protect says nothing when it is used', (s) => s.replace("protect: 'protected' };", '};')],
    ['scene.js', 'Sky Drop says nothing', (s) => s.replace("else if (v === 'sky-drop') qMsg('vol.skydrop', roles(e.s ^ 1, { other: monName(e.s, false) }));", '')],
    ['scene.js', 'Power Split and Guard Split read the same', (s) => s.replace("qMsg(/Power/.test(S.notes.lastMove[e.s] || '') ? 'split.power' : 'split.guard', roles(e.s))", "qMsg('split.guard', roles(e.s))")],
    ['scene.js', 'the Charge move says nothing', (s) => s.replace("if (!(pa7 && pa7.t === 'ability')) qMsg('charge.generic', roles(e.s));", '')],
    ['scene.js', 'an ability\'s charge says "began charging power!" too', (s) => s.replace("if (!(pa7 && pa7.t === 'ability')) qMsg('charge.generic', roles(e.s));", "qMsg('charge.generic', roles(e.s));")],
    ['scene.js', 'Magnet Rise ends without the word', (s) => s.replace("text.compose('word.magnet')", "''")],
    ['scene.js', 'a Mental Herb cure of Heal Block reads as it wearing off', (s) => s.replace("qMsg(herb ? 'cure.healblock' : 'end.wore'", "qMsg('end.wore'")],
    ['scene.js', 'Embargo never ends', (s) => s.replace("embargo: 'end.embargo', telekinesis:", 'telekinesis:')],
    ['scene.js', 'Throat Chop\'s refusal says nothing', (s) => s.replace(", 'throat-chop': 'cant.throat' }[e.why];", ' }[e.why];')],
    ['scene.js', 'Heal Block\'s refusal says nothing', (s) => s.replace("'heal-block': 'cant.healblock', ", '')],
    ['scene.js', 'Static says the plain paralysis line', (s) => s.replace("else if (byAb && byAb.fx === 'static' && e.st === 5) qMsg('ab.static', roles(byAb.s, abR));", '')],
    ['scene.js', 'Flame Body says the plain burn line', (s) => s.replace("else if (byAb && byAb.fx === 'flame-body' && e.st === 3) qMsg('ab.flamebody', roles(byAb.s, abR));", '')],
    ['scene.js', 'Poison Point says the plain poison line', (s) => s.replace("else if (byAb && (byAb.fx === 'poison-point' || byAb.fx === 'effect-spore') && e.st === 2) qMsg('ab.poisonpt'", "else if (false) qMsg('ab.poisonpt'")],
    ['scene.js', 'Cute Charm says the plain love line', (s) => s.replace("else if (v === 'infatuation' && pa7 && pa7.t === 'ability' && pa7.fx === 'cute-charm') qMsg(", "else if (false) qMsg(")],
    ['scene.js', 'Flash Fire never says the boost line', (s) => s.replace("if (first) { qMsg('ab.flashfire'", "if (false) { qMsg('ab.flashfire'")],
    ['scene.js', 'Flash Fire is always "first"', (s) => s.replace('const first = !S.notes.ff[e.s]; S.notes.ff[e.s] = true;', 'const first = true;')],
    ['scene.js', 'a stat item\'s stat change reads as the plain line', (s) => s.replace('if (usingItem && usingItem.side === e.s) qMsg(up ?', 'if (false && usingItem && usingItem.side === e.s) qMsg(up ?')],
    ['scene.js', 'the stat item context never ends', (s) => s.replace("if (usingItem && e.t !== 'stat-change' && e.t !== 'item') usingItem = null;", '')],
    ['scene.js', 'a steal reads as a switch of items', (s) => s.replace("else if (e.steal || e.how === 'pickpocket' || e.how === 'magician') qMsg('steal'", "else if (false) qMsg('steal'")],
    ['scene.js', 'a Trick says no "obtained" lines', (s) => s.replace("if (itn && n2) qMsg('trick.both'", "if (false) qMsg('trick.both'")],
    ['scene.js', 'a Fire move into heavy rain says "But it failed!"', (s) => s.replace("else if (w === 'primal-weather') qMsg(", "else if (w === 'zzz') qMsg(")],
    ['scene.js', 'a weather move into a primal weather just fails', (s) => s.replace('if (S.notes.pw >= 6 && S.notes.pw <= 8 && WEATHER_MOVES.has(moveName(e.mv))) qMsg(', 'if (false) qMsg(')],
    ['scene.js', 'the scene forgets the primal weather ended', (s) => s.replace("S.notes.pw = 0; break;", 'break;')],
    ['scene.js', 'a turn of primal weather says nothing', (s) => s.replace("{ 6: 'wx.1.tick', 7: 'wx.2.tick', 8: 'wx.norelief.winds' }[e.w] ||", '{}[e.w] ||')],
    ['scene.js', 'Healing Wish and Lunar Dance read as Wish', (s) => s.replace("qMsg(e.hw === 1 ? 'wish.heal' : e.hw === 2 ? 'wish.lunar' : 'wishcame'", "qMsg('wishcame'")],
    ['scene.js', 'Grudge is read as a PP cut', (s) => s.replace("if (grudged) qMsg('grudge.pp'", "if (false) qMsg('grudge.pp'")],
    ['scene.js', 'Jaboca Berry\'s damage says nothing', (s) => s.replace("else if (src === 'jaboca' || src === 'rowap') qMsg(", "else if (src === 'zzz') qMsg(")],
    ['scene.js', 'Powder\'s explosion says nothing', (s) => s.replace("else if (src === 'powder') qMsg('hurt.powder', r);", '')],
    ['scene.js', 'Solar Power takes no toll', (s) => s.replace("else if (src === 'solar-power' || src === 'dry-skin') qMsg('dmg.toll'", "else if (src === 'dry-skin') qMsg('dmg.toll'")],
    ['scene.js', 'Grassy Terrain\'s heal says nothing', (s) => s.replace("else if (src === 'grassy-terrain') qMsg('heal.terrain', r);", '')],
    ['scene.js', 'Magnitude\'s event with no side throws again', (s) => s.replace("roles(e.s !== undefined ? e.s : userSide, { b1: String(e.n || '') })", "roles(e.s, { b1: String(e.n || '') })")],
    ['scene.js', 'the entry announcements the engine will emit say nothing', (s) => s.replace("else if (ENTRY_KEY[fx]) qMsg(ENTRY_KEY[fx], roles(e.s));", '')],
    ['scene.js', 'Delta Stream weakening a hit says nothing', (s) => s.replace("if (e.winds) qMsg('wx.winds.weak', roles(e.s));", '')],
    ['scene.js', 'the Static line is the Flame Body one', (s) => s.replace("byAb.fx === 'static' && e.st === 5) qMsg('ab.static'", "byAb.fx === 'static' && e.st === 5) qMsg('ab.flamebody'")],
    ['scene.js', 'a Delta Stream clamp replaces the effectiveness line again', (s) => s.replace("if (e.winds) qMsg('wx.winds.weak', roles(e.s));\n          if (e.eff > 4096) qMsg('super', roles(e.s));", "if (e.winds) qMsg('wx.winds.weak', roles(e.s));\n          else if (e.eff > 4096) qMsg('super', roles(e.s));")],
    ['scene.js', 'every binding move says the vortex line', (s) => s.replace('const tk = TRAP_START[S.notes.trap[e.s]];', 'const tk = null;')],
    ['scene.js', 'a binding move is not named (hurt by the trap)', (s) => s.replace("(S.notes.lastMove[e.s ^ 1] || 'the trap')", "'the trap'")],
    ['scene.js', 'Clamp says the victim first', (s) => s.replace("Clamp: ['trap.clamp', 1]", "Clamp: ['trap.clamp']")],
    ['scene.js', 'Rapid Spin frees from a binding move with the end-of-duration line', (s) => s.replace("qMsg('trap.free', roles(e.s,", "qMsg('vol.trap.end', roles(e.s,")],
    ['scene.js', 'Rapid Spin says nothing for Leech Seed', (s) => s.replace("else if (e.v === 'leech-seed') qMsg('vol.leechend', roles(e.s));", "else if (e.v === 'leech-seed') { /* nothing */ }")],
    ['scene.js', 'Forewarn alerts the foe, not the holder', (s) => s.replace("{ slots: { '41': 'hn', '40': 'fn' } }", "{ slots: { '41': 'fn', '40': 'hn' } }")],
    ['scene.js', 'Frisk is said by the frisked side', (s) => s.replace("qMsg('ab.frisk', roles(e.s, { other: monName(e.s ^ 1, false), b1: itemName(e.it) }))", "qMsg('ab.frisk', roles(e.s ^ 1, { other: monName(e.s, false), b1: itemName(e.it) }))")],
    ['scene.js', 'an announcement is said by the opposite side', (s) => s.replace('else if (ENTRY_KEY[fx]) qMsg(ENTRY_KEY[fx], roles(e.s));', 'else if (ENTRY_KEY[fx]) qMsg(ENTRY_KEY[fx], roles(e.s ^ 1));')],
    ['scene.js', 'Stockpile says no count', (s) => s.replace("qMsg('stk.n', roles(e.s, { b1: String(++S.notes.stk[e.s]) }));", "++S.notes.stk[e.s];")],
    ['scene.js', 'Swallow / Spit Up say nothing when the stockpile ends', (s) => s.replace("() => qMsg('stk.end', roles(e.s))", "() => {}")],
    ['scene.js', 'the count does not start again after the end', (s) => s.replace("if (ended) { S.notes.stk[e.s] = 0;", "if (ended) {")],
    ['scene.js', 'the Defense + Sp. Def pair is two lines', (s) => s.replace("if (pairIdx.has(i)) {", "if (false) {")],
    ['scene.js', 'a failed Stockpile still counts', (s) => s.replace("if (first && first.t === 'fail') return;", "")],
    ['scene.js', 'the Rapid Spin Stealth Rock line is the Spikes one', (s) => s.replace("qMsg('hz.away.' + hk, roles(userSide))", "qMsg('hz.away.' + (hk === 'rocks' ? 'spikes' : hk), roles(userSide))")],
    ['scene.js', 'a pivot says nothing (only the sweep sees it)', (s) => s.replace("case 'pivot': pivotFlag[e.s] = true; qMsg('wentback', roles(e.s)); break;", "case 'pivot': pivotFlag[e.s] = true; break;"), { full: 1 }],
    ['scene.js', 'a miss says nothing (only the sweep sees it)', (s) => s.replace("case 'miss': qMsg('miss', roles(e.s)); break;", "case 'miss': break;"), { full: 1 }],
    ['scene.js', 'a heal by Leftovers says nothing (only the sweep sees it)', (s) => s.replace("if (src === 'leftovers') qMsg('heal.leftovers', roles(e.s, { item: 'Leftovers' }));", "if (src === 'leftovers') { /* nothing */ }"), { full: 1 }],
  ];
  let killed = 0;
  for (let mi = 0; mi < mutants.length; mi++) {
    const [file, name, fn, mopts] = mutants[mi];
    const dir = copyTree('m' + mi); const src = fs.readFileSync(path.join(dir, file), 'utf8'); const out = fn(src);
    if (out === src) { ok(false, '2. mutant "' + name + '" did not change the source (the mutant itself is broken)'); continue; }
    fs.writeFileSync(path.join(dir, file), out);
    let fails; try { const MM = await loadStack(dir, '?m' + mi); fails = await core(MM, mopts && mopts.full ? { only: 'sweep' } : { fast: true }); } catch (e) { fails = ['threw: ' + String(e.message).slice(0, 80)]; }
    const dead = fails.length > 0; if (dead) killed++;
    ok(dead, '2. mutant killed: ' + file + ' / ' + name, dead ? fails[0].slice(0, 80) : 'survived');
  }
  console.log('mutants killed ' + killed + ' of ' + mutants.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s); ' + nChecks + ' individual checks ran inside the core runs (real tree + twin + mutants)');
if (fail) process.exit(1);
