// pokemonarena/js/scene.js -- the battle SCENE: turns the engine's event list into a timed sequence of frames (messages typed from the
// ROM's own strings, HP bars draining, send-outs, faints), runs the menus (FIGHT / BAG / POKeMON / RUN, moves, party, team preview,
// confirm, result) and maps every input action (keyboard / pad actions and pointer events) onto them.
//
// Pure ES module (browser + Node): no DOM, no timers, no Math.random / Date. The caller advances it with tick() once per GBA frame
// (59.7275 Hz) and draws ui.render(scene.view()); a scripted run of (events, presses, ticks) therefore gives identical frames.
//
//   const scene = createScene({ ui, pack, text, ctl, viewSide: 0, env: 0, textSpeed: 'mid', hooks, meta, trainer: 'CPU Normal', playerName: 'You' });
//   scene.press('a'); scene.tick(); const frame = ui.render(scene.view());
//
// ANIMATIONS (AN1; opts.anim = the settings from anim_settings.js, opts.animator = the ROM move animator from move_anim.js, both optional): with them
// on, a move turn is "X used MOVE!" -> the move's ROM animation (a blocking 'moveanim' step; ANIM.md) -> the target's blink and HP drain -> the messages,
// status / stat / weather effects play their ROM animations the same way, a Pokemon comes out of a ROM ball and the foe's front picture swaps at the
// ROM's own times (anim_mon.js). An animation the animator reports as 'none', or animations switched off, leave exactly the behaviour below.
// scene.animInfo() says what played and what the animator reported for each; its `log` is the list of animation PROBLEMS (a throw, a cut-off run: the tests and the browser suite require it empty), its
// `notes` the benign events (a prepared effect made again because the screen changed: `restale`; a prewarm given up for a full engine pool: `shed`). hooks.onSound(index, pan) receives the ROM song-table index (and pan -127..127) of
// every sound an animation plays, so the page's audio director can play it; hooks.onCry(species, pan) is a Pokemon cry an animation script starts (the page plays it through the sound
// system's effects bus; the engine does not model the cry's length). NOT done: the ROM's per-species motion routines (frontAnimId / backAnimId)
// are not run, so a Pokemon does not move on send-out; the ball's arc and the release timings are chosen by eye.
//
// SYSTEM ANIMATIONS (round 3; anim_sys.js; animator.prepare/start('system', id, ctx), used for an id the animator calls 'exact' or 'approx'): the battle's opening, the send-outs, recalls,
// faints and hit blinks are the ROM's own battle code. A system run draws the WHOLE screen (terrain, Pokemon, trainers, balls, shadows, healthboxes); the scene draws only its own text box,
// tags and menus over it (run.draw with BG0 off; battle_ui.js skips its own field when the view has fxSys). The opening is id 1 (the TRAINER intro: the opponent is a CPU trainer, and the
// wild intro would draw "a wild X appeared"), with the scene's own three messages typed over it: each `message` event of the run starts one, and A is pressed for the ROM (setKeys) when it has
// been read. The foe trainer's picture is a ROM trainer picked by opts.cpuLevel from opts.trainerChoices (anim_sys.js), the player's back sprite follows opts.playerGender. Mid-battle events: ids 2..7 start a wild-style pre-roll from the lead pair the scene shows NOW (the experience of the level is given, or a trainer setup recomputes the level),
// 8 / 9 the trainer one. The ROM's hidden pre-roll (100-250 ms of ROM code) is run by animator.prepare() in 3 ms slices, one a tick (pumpSys), as soon as an event is foreseeable (prepareSys: the next event of the queue, while the previous one plays), and the opening's battle state is pre-rolled while it plays; begin() hands the run over when the step before it is done and the handle is ready, and until then the step holds the previous picture while the scene keeps ticking (animInfo().waited). The animator's pool of three engines holds the live run and up to two prepared ones (the prewarm borrows one while the opening plays). opts.clock (the page passes performance.now) shrinks the slice on a frame whose ROM move animation is already heavy; opts.sysClock (the tests) is the clock the animator slices by, so a run is deterministic. Animations off, an animator without 'system', a 'fallback' answer or any throw leave the old
// steps (and the animations-off frame stream is the one it always was). tools/pokemonarena_anim_scene_test.mjs "handoff" compares the scene's picture with the run's, both directions.
//
// WHAT IS APPROXIMATE (also listed in the page's docs): without an animation a damaging move makes the attacker
// lunge a few pixels and the target blink; a send-out slides the sprite and its healthbox in from the screen edge through a white
// silhouette; a recall is the reverse; a faint sinks the sprite. FA1: HP bars move exactly as the ROM's MoveBattleBar does (maxHP/24 HP a frame, fixed point under 48 HP; battle_ui.js
// hpBarStep, checked against the ROM's code), and the typed text runs at the real game's one character a frame. Still chosen by eye, not read from the ROM: the message hold, the blink length,
// the send-out / recall slide and the faint sink (FIDELITY.md lists what was measured). The BAG is disabled (no items in this format).
//
// NOT ROM TEXT (scene.fallbacks() lists the ones a run actually used). Every battle message comes from the ROM's own strings
// (battle_text.js: 400 catalog entries, all found; round 5 added frostbite, terrain, Gravity, the sports and rooms, primal weather, perish, revive; round 6 the ability lines: Neutralizing Gas, the four Ruin
// abilities, Unnerve / As One, Slow Start, Supersweet Syrup, Harvest, Disguise, Liquid Ooze, Sturdy, Magic Bounce / Magic Coat, Mummy, Wandering Spirit, Wind Power / Electromorphosis, Anger Point; round 7 every other event code the ROM has a line for: the hazards a Rapid Spin / Defog / Tidy Up clears, Snatch, the
// `copy` events, Static / Flame Body / Poison Point / Effect Spore / Cute Charm / Flash Fire's first absorption, the Solar Power / Aftermath / Innards Out / Bad Dreams damage lines, the stat-raising items, Stockpile's
// count / end / one-line Defense + Sp. Def pair; tools/pokemonarena_event_codes_test.mjs keeps one row per code). The exceptions, written in this file
// because the ROM has no matching line:
//   events:   Life Orb recoil ('lifeorb'), Black Sludge damage / heal ('sludge', 'heal.black-sludge'), Shell Bell heal ('heal.shell-bell'),
//             Air Balloon pop ('balloonpop'), Aurora Veil going up ('scr.veil'), a drawn game at the turn cap ('turncap'), the Scorched Field terrain
//             starting / ending ('tn.5.on', 'tn.5.off'). A code the engine emits and the ROM has no line for (heal block, throat chop, pp-drain ...) shows NOTHING: a missing key is never shown as its key
//   Round 8: the engine now emits the switch-in announcements (Pressure, Mold Breaker, Turboblaze / Teravolt, the Auras, Cloud Nine / Air Lock, Anticipation, Forewarn, Frisk), Slow Start's end, Delta Stream's tick and its `winds` flag, and
//   Rapid Spin's volatile-end events, and the scene shows each with the wording measured through the oracle (a binding move names itself everywhere: its start line, "hurt by", "freed from", "got free of").
//   menus:    "Send out this team?" and the "Choose 3 (n/3)" counter on the team preview ('preview.title', 'confirm.team'), "Leave this battle?"
//             ('confirm.quit'), "Waiting for the other player..." ('wait'), choosing a living Pokemon on the Revival Blessing screen ('party.notfainted'), the result-screen buttons REMATCH / NEW BATTLE / LEAVE and the
//             start-menu rows (drawn with the ROM font, worded here), the words SOUND / FORFEIT / QUIT, and 'submit.*' (a choice the engine refused)
//   The party-menu prompt, "already in battle", "no energy left to battle", "already selected" and "can't be switched out" ARE ROM lines
//   (the party-menu text pool at 0xf43700). Placeholder roles (which {id} is the move, the item, the foe) were inferred from the wording of
//   the strings that use them, not from the ROM code (see battle_text.js).
// WHAT THE SCREENS ARE: the party / preview / result screens are composed from ROM pieces (window ring, 2-frame menu icons, HP-bar tiles,
//   status icons, fonts, palette colours); the game's own party-menu background and panel art was NOT located, so those layouts are this
//   module's composition, not a copy of the game's.

import { createTypewriter, TEXT_SPEED } from './textfx.js';
import { GENERAL, STATUS, SPECIAL, STATUS_ANIM_OF, WEATHER_ANIM_OF, statAnimArg, speciesAnimInfo, frontFrameAt, ballGfx } from './anim_mon.js';
import { SYS, LAYERS_NO_TEXT, partySpec, eventId, sysPlayable, pickTrainer } from './anim_sys.js';
import { summarizeMatch } from './match_stats.js';
import { buildRecapPages } from './recap_model.js';

export const GBA_FPS = 59.7275;
const MSG_HOLD = 36;            // frames a finished message stays up before the next step (A / B skips it)
const PAGE_AUTO = 50;           // frames a finished page waits for a button before the next page appears on its own
const SLIDE_FRAMES = 22;
const BLINK_FRAMES = 12;
const ST_LABEL = { 1: 'SLP', 2: 'PSN', 3: 'BRN', 4: 'FRZ', 5: 'PAR', 6: 'PSN', 7: 'FRB' };
const ST_WORD = { 1: 'slp', 2: 'psn', 3: 'brn', 4: 'frz', 5: 'par', 6: 'psn', 7: 'frb' };
const STAT_KEY = { atk: 'stat.atk', def: 'stat.def', spa: 'stat.spa', spd: 'stat.spd', spe: 'stat.spe', acc: 'stat.acc', eva: 'stat.eva' };
const WX_TAG = { 1: 'RAIN', 2: 'SUN', 3: 'SAND', 4: 'HAIL', 5: 'SNOW', 6: 'HEAVY RAIN', 7: 'HARSH SUN', 8: 'WINDS' };
const TN_TAG = { 1: 'GRASSY', 2: 'ELECTRIC', 3: 'MISTY', 4: 'PSYCHIC', 5: 'SCORCHED' };       // engine terrain ids (ENGINE.md 12)
const TN_OF = { 'grassy-terrain': 1, 'electric-terrain': 2, 'misty-terrain': 3, 'psychic-terrain': 4, 'scorched-terrain': 5 };
const FIELD_KEY = { gravity: 'gravity', 'mud-sport': 'mud', 'water-sport': 'water', 'wonder-room': 'wonder', 'magic-room': 'magic', 'fairy-lock': 'fairy', 'ion-deluge': 'ion', 'court-change': 'court' };
const ACTIONS = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];
export const RESULT_OPTIONS = Object.freeze(['REMATCH', 'NEW BATTLE', 'LEAVE']);
// W1 fix D1: the result screen ignores a CHOICE (A, a click, a tap) until it has been on screen this many frames (about 1.5 s at 59.7 Hz). Before this, a player
// mashing A through the last battle message started REMATCH 4 frames after the result appeared and never saw who won. A press is always a fresh key-down
// (the input layer drops OS auto-repeat), so "released and pressed again" holds by construction; opts.resultGuard overrides (0 = no guard, for scripted runs).
export const RESULT_GUARD_FRAMES = 90;

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const inRect = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export function createScene(opts) {
  const { ui, pack, text, ctl } = opts;
  const viewSide = opts.viewSide === undefined ? 0 : opts.viewSide;
  const foeSide = viewSide ^ 1;
  const hooks = opts.hooks || {};
  const meta = opts.meta || [[], []];
  const trainer = opts.trainer || 'CPU';
  const playerName = opts.playerName || 'You';
  const textSpeed = opts.textSpeed || 'mid';
  const delay = TEXT_SPEED[textSpeed] === undefined ? TEXT_SPEED.mid : TEXT_SPEED[textSpeed];
  const fallbacks = new Set();             // text the ROM could not supply (reported by scene.fallbacks())
  const R = ui.R;

  /* -------------------------------------------------------------------------------- animation (AN1; see the header and ANIM.md) */
  // opts.anim = the settings (anim_settings.js: get() -> { on, speed, skip }); with none the scene behaves exactly as it did before animations existed.
  // opts.animator = the shared ROM move animator (move_anim.js createMoveAnimator); with none (or an animation it reports 'none') a damaging move
  // falls back to the old lunge + blink. The animator's sides are SCREEN sides: 0 = the player's battler (bottom left), 1 = the foe's (top right).
  let animator = opts.animator || null;
  const animCfg = () => { const c = opts.anim && typeof opts.anim.get === 'function' ? opts.anim.get() : opts.anim; return c && c.on ? c : null; };
  const A = { run: null, step: null, n: 0, seed: (opts.animSeed >>> 0) || 1, mon: [null, null], balls: [null, null], recalled: -1, ballOk: null, charging: [0, 0], spInfo: new Map(), log: [], notes: [], coverage: { exact: 0, approx: 0, fallback: 0, none: 0 }, byId: {}, played: 0, sounds: 0, cries: 0, sysPlayed: 0, lastMon: [null, null], sysLog: [], skipped: 0, mute: false, skipReq: false };
  const screenSide = (side) => (side === viewSide ? 0 : 1);
  const speciesAnim = (sp) => { let v = A.spInfo.get(sp); if (v === undefined) { try { v = speciesAnimInfo(ui.rom, sp); } catch (_e) { v = null; } A.spInfo.set(sp, v); } return v; };
  const animMix = (a, b) => ((Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0);

  /* ---------------------------------------------------------------------------------------------- state */
  const S = {
    mode: 'steps', tick: 0, queue: [], cur: null, resume: null,
    disp: [null, null], held: { a: false, b: false },
    P: [freshPlan(), freshPlan()],       // the director's picture of each side AFTER every event queued so far
    lastBox: { mode: 'message', text: ['', ''] },
    weather: 0, trickRoom: false, terrain: 0, gravity: false,
    cursor: 0, moveCursor: 0, partyCursor: 0, partyCancelSel: false,
    party: null, preview: null, result: null, overlay: null, confirm: null, menu: null,
    turn: 0, notes: { trap: ['', ''], disabled: ['', ''], lastItem: ['', ''], lastMove: ['', ''], gas: [false, false], hz: [new Set(), new Set()], ff: [false, false], pw: 0, stk: [0, 0] },
    ended: false, quit: false, hashLog: [],
    recap: null, career: null, careerVer: 0, matchEnded: false,
  };
  function freshPlan() { return { shown: false, name: '', sp: 0, level: 0, hpFrac: 1, status: null, orig: 0, slot: 0 }; }

  /* ---------------------------------------------------------------------------------------- text helpers */
  const speciesName = (id) => (pack.species[id] ? pack.species[id].name : '?');
  const moveName = (id) => (pack.moves[id] ? pack.moves[id].name : '?');
  const abilityName = (id) => (pack.abilities[id] ? pack.abilities[id].name : '?');
  // AN1 round 7: the order the real game takes hazards in (MEASURED: Rapid Spin and Defog with all four up), the moves that name the weather they set, the items whose stat change reads "Using <item>, the <stat> of <mon> rose!"
  const HZ_ORDER = ['spikes', 'web', 'tspikes', 'rocks'];
  const WEATHER_MOVES = new Set(['Rain Dance', 'Sunny Day', 'Sandstorm', 'Hail', 'Snowscape']);
  const STAT_ITEM_FX = new Set(['stat-berry', 'starf', 'hit-boost', 'throat-spray', 'blunder-policy', 'weakness-policy', 'terrain-seed', 'room-service', 'adrenaline-orb']);
  const ANNOUNCED_COPY = new Set(['copycat', 'me-first', 'assist', 'mirror-move', 'sleep-talk', 'nature-power', 'instruct']);       // the move they call is announced ("<mon> used Tackle!"): MEASURED for mirror-move, copycat, me-first, nature-power
  const ENTRY_KEY = { pressure: 'ab.pressure', 'mold-breaker': 'ab.moldbreaker', turboblaze: 'ab.turboblaze', teravolt: 'ab.teravolt', 'dark-aura': 'ab.darkaura', 'fairy-aura': 'ab.fairyaura', 'aura-break': 'ab.aurabreak', anticipation: 'ab.anticipation',
    'weather-lock': 'ab.weatherlock', 'slow-start-end': 'ab.slowstartend' };
  const STOCK_RUN = new Set(['damage', 'sub-damage', 'sub-break', 'heal', 'crit', 'multi-hit', 'stat-change', 'stat-fail', 'miss', 'immune', 'avoid', 'protected', 'noop']);       // what can sit between their move-use and the stat falls
  const TRAP_START = { Wrap: ['trap.wrap'], Bind: ['trap.bind'], Clamp: ['trap.clamp', 1], 'Sand Tomb': ['trap.sand'], 'Magma Storm': ['trap.magma'], Infestation: ['trap.infest'], 'Thunder Cage': ['trap.cage', 1], 'Snap Trap': ['trap.snap'] };       // move -> [catalog key, 1 when the trapper is the subject]; Fire Spin / Whirlpool and the rest say "trapped in the vortex"
  const STOCK_MOVES = new Set(['Stockpile', 'Spit Up', 'Swallow']);                       // AN1 round 7: the three moves that print the stockpile count / the end / one line for the Defense + Sp. Def pair
  const RUIN_KEY = { 'Sword of Ruin': 'ab.ruin.def', 'Beads of Ruin': 'ab.ruin.spd', 'Tablets of Ruin': 'ab.ruin.atk', 'Vessel of Ruin': 'ab.ruin.spa' };
  const itemName = (id) => (pack.items[id] ? pack.items[id].name : '?');
  const typeName = (id) => (pack.types[id] ? pack.types[id].name : '?');
  const foePrefixCap = () => text.compose('pfx.foe.cap');
  const monName = (side, cap) => (side === viewSide ? S.P[side].name : (cap ? foePrefixCap() : lowerFirst(foePrefixCap())) + S.P[side].name);
  const teamWord = (side, cap) => (side === viewSide ? (cap ? text.compose('side.you.cap') : text.compose('side.you.low')) : (cap ? foePrefixCap().trim() : lowerFirst(foePrefixCap().trim())));
  const ownerName = (side) => (side === viewSide ? playerName : trainer);
  function roles(side, extra) {
    return Object.assign({
      subj: monName(side, true), other: monName(side ^ 1, false), foeName: trainer, playerName,
      mine: S.P[viewSide].name, foeMon: S.P[foeSide].name, teamCap: teamWord(side, true), teamLow: teamWord(side, false), ownerName: ownerName(side),
    }, extra || {});
  }
  // a message must reach the ROM font as glyphs it has; control markers ('\n', '\\p') stay
  function safeMsg(str) {
    return str.split('\\p').map((page) => page.split('\n').map((ln) => ui.safeText(ln)).join('\n')).join('\\p');
  }
  const clean = (s) => s.replace(/(\\p|\s)+$/, '').replace(/^\s+/, '');
  function msg(key, r, o) {
    if (!text.has(key)) { fallbacks.add(key); return ''; }               // never the key itself: a player must not read 'wx.9.start'
    if (text.source(key) === 'fallback') fallbacks.add(key);
    return clean(text.compose(key, r || {}, o && o.slots));
  }
  const rawMsg = (key, s) => { fallbacks.add(key); return s; };

  /* ----------------------------------------------------------------------------------------------- queue */
  const q = (step) => { S.queue.push(step); return step; };
  const qText = (str, o) => q({ t: 'text', text: str, wait: !!(o && o.wait) });
  const qMsg = (key, r, o) => { const m = msg(key, r, o); if (m) qText(m, o); };
  const qCall = (fn) => q({ t: 'call', fn });
  const qPause = (n) => q({ t: 'pause', n });
  // AN1: a blocking animation step, resolved when it STARTS (settings and animator are read then, so a toggled setting is honoured). kind: 'move' | 'general' |
  // 'status' | 'special' | 'bg'; a = the acting side (engine side), d = the side it is aimed at; noPlay = the move will not animate (it missed / was refused);
  // fb = what to do when no animation plays: 'lunge' (the pre-animation attacker lunge) or nothing.
  const qAnim = (kind, id, a, d, o) => q(Object.assign({ t: 'moveanim', kind, id, a, d, args: [], turn: 0, fb: null, noPlay: false }, o || {}));

  /* --------------------------------------------------------------------------- director: events -> steps */
  function monForSide(side, e) {
    const m = (meta[side] || [])[e.orig] || {};
    const sp = pack.species[e.sp];
    let gender = m.gender === undefined ? null : m.gender;
    if (m.gender === undefined && sp) { const r = sp.genderRatio; gender = r === 255 ? null : r === 0 ? 'M' : r === 254 ? 'F' : null; }
    return { species: e.sp, name: e.name, level: e.lv, gender, hp: e.hp, maxHp: e.max, status: ST_LABEL[e.st] || null, shiny: !!m.shiny, slot: e.m, orig: e.orig };
  }
  function sendOutKey(hpFrac) {
    // the player's send-out line depends on how healthy the foe is (Gen 3 thresholds, from memory: 70 / 40 / 10 percent)
    const p = Math.round(hpFrac * 100);
    return p > 69 ? 'go.1' : p > 39 ? 'go.2' : p > 9 ? 'go.3' : 'go.4';
  }
  function recallKey(hpFrac) {
    const p = Math.round(hpFrac * 100);
    return p > 69 ? 'back.1' : p > 39 ? 'back.2' : p > 9 ? 'back.3' : 'back.4';
  }

  function reorderLeads(events) {
    // at the start both leads arrive together (side 0 first); the foe's send-out is shown first
    const out = events.slice();
    const i0 = out.findIndex((e) => e.t === 'switch-in' && e.s === viewSide && !S.P[viewSide].shown);
    const i1 = out.findIndex((e) => e.t === 'switch-in' && e.s === foeSide && !S.P[foeSide].shown);
    if (i0 >= 0 && i1 >= 0 && i0 < i1 && !S.P[viewSide].shown && !S.P[foeSide].shown) { const t = out[i0]; out[i0] = out[i1]; out[i1] = t; }
    return out;
  }

  // the two leads at the start: the scene's own texts (computed in the old order, so the roles read the same plan) and the steps the old code would have queued, kept as the fallback
  function bundleIntro(ef, ep) {
    const P = S.P, foeMon = monForSide(foeSide, ef), myMon = monForSide(viewSide, ep);
    const challenge = msg('foe.challenge', roles(foeSide), {});
    P[foeSide] = { shown: true, name: ef.name, sp: ef.sp, level: ef.lv, hpFrac: ef.max > 0 ? ef.hp / ef.max : 1, status: ST_LABEL[ef.st] || null, orig: ef.orig, slot: ef.m };
    const sendout = msg('foe.sendout', roles(foeSide, { foeMon: ef.name, b1: ef.name }));
    P[viewSide] = { shown: true, name: ep.name, sp: ep.sp, level: ep.lv, hpFrac: ep.max > 0 ? ep.hp / ep.max : 1, status: ST_LABEL[ep.st] || null, orig: ep.orig, slot: ep.m };
    const go = msg(sendOutKey(P[foeSide].hpFrac), roles(viewSide, { b1: ep.name, mine: ep.name }));
    q({
      t: 'sysintro', foe: foeMon, player: myMon, texts: [challenge, sendout, go],
      fallback: [{ t: 'text', text: challenge, wait: false }, { t: 'text', text: sendout, wait: false }, { t: 'slidein', side: foeSide, mon: foeMon }, { t: 'text', text: go, wait: false }, { t: 'slidein', side: viewSide, mon: myMon }],
    });
  }

  // the name of a Pokemon of the party by engine slot (a revived one is on the bench, so no display holds it)
  function benchName(side, slot) { try { const t = ctl.battle.s.sides[side].team[slot]; return t && t.name ? t.name : 'The Pokemon'; } catch (_e) { return 'The Pokemon'; } }

  function director(events) {
    const evs = reorderLeads(events);
    let draggedFlag = [false, false], pivotFlag = [false, false];
    const sidesWhoHit = new Set(), skipAt = new Set();
    let userSide = 0;                                         // who used the last move (a field event without a side: Court Change)
    afterDrain[0] = afterDrain[1] = null; pendingAbsorb[0] = pendingAbsorb[1] = null;
    let usingItem = null, tidyFor = -1, bellSaid = false;                       // AN1 round 7: the item whose stat change is being read; the side that used Tidy Up and has not said "Tidying up complete!" yet
    // AN1 round 6: the gas goes with the Pokemon that held it (a switch, a faint); the ROM's line is said when the LAST holder leaves
    const gasLeaves = (side) => { if (S.notes.gas[side]) { S.notes.gas[side] = false; if (!S.notes.gas[0] && !S.notes.gas[1]) qMsg('ab.gas.off', roles(side)); } };
    // AN1 round 7: Stockpile. The engine has no event for the count nor for the end, so both are read off the move's own events (MEASURED, scn7 through the oracle: "<mon> stockpiled N!" after the
    // animation and before the stat line, ROM 0x442d99; "<mon>'s stockpiled effect wore off!" after Swallow's / Spit Up's own stat falls, ROM 0x43ed80; and the Defense + Sp. Def pair is ONE line,
    // "Defense and Sp. Def rose!", the " and " being the ROM's own glue string). A pair that is not two equal def / spd changes of the user stays two lines.
    const afterIdx = new Map(), pairIdx = new Set();
    const runAfter = (k) => { const fn = afterIdx.get(k); if (fn) { afterIdx.delete(k); fn(); } };
    const isPair = (j, s) => { const a = evs[j], b = evs[j + 1]; return !!(a && b && a.t === 'stat-change' && b.t === 'stat-change' && a.s === s && b.s === s && a.stat === 'def' && b.stat === 'spd' && a.delta === b.delta); };
    const stockpileMove = (i, e, mvn) => {
      const first = evs[i + 1];
      if (first && first.t === 'fail') return;                                                  // a fourth Stockpile, a Spit Up / Swallow with nothing stored: "But it failed!"
      if (mvn === 'Stockpile') { qMsg('stk.n', roles(e.s, { b1: String(++S.notes.stk[e.s]) })); if (isPair(i + 1, e.s)) pairIdx.add(i + 1); return; }
      let j = i + 1, ended = false, lastFall = -1;
      for (; j < evs.length && STOCK_RUN.has(evs[j].t); j++) {
        const x = evs[j];
        if (x.t === 'stat-change' && x.s === e.s && x.delta < 0 && (x.stat === 'def' || x.stat === 'spd')) { ended = true; lastFall = j; if (isPair(j, e.s)) { pairIdx.add(j); lastFall = ++j; } }
        else if (mvn === 'Swallow' ? (x.t === 'heal' && x.s === e.s) : ((x.t === 'damage' || x.t === 'sub-damage') && x.s !== e.s)) ended = true;
      }
      if (ended) { S.notes.stk[e.s] = 0; afterIdx.set(lastFall >= 0 ? lastFall : j - 1, () => qMsg('stk.end', roles(e.s))); }
    };
    for (let i = 0; i < evs.length; i++) {
      if (skipAt.has(i)) { runAfter(i); continue; }
      const e = evs[i], nx = evs[i + 1];
      const P = S.P;
      if (usingItem && e.t !== 'stat-change' && e.t !== 'item') usingItem = null;
      switch (e.t) {
        case 'start': break;
        case 'preview': break;
        case 'turn': qCall(() => { S.turn = e.n; }); break;
        case 'switch-in': {
          const mon = monForSide(e.s, e);
          const lead = !P[e.s].shown;
          // AN1 round 3: both leads at the start of the battle are ONE system animation (the ROM's own intro: the trainer, the ball throw, the Pokemon, the healthboxes), with the
          // scene's own three messages typed over it; without it (animations off, no animator) the old steps below run
          if (lead && e.s === foeSide && !P[foeSide].shown && !P[viewSide].shown && sysOn(SYS.introTrainer)) {
            const j = evs.findIndex((x, k) => k > i && x.t === 'switch-in' && x.s === viewSide);
            if (j > i) { bundleIntro(e, evs[j]); skipAt.add(j); break; }
          }
          if (lead && !P[foeSide].shown && !P[viewSide].shown && e.s === foeSide) qMsg('foe.challenge', roles(e.s), {});
          P[e.s] = { shown: true, name: e.name, sp: e.sp, level: e.lv, hpFrac: e.max > 0 ? e.hp / e.max : 1, status: ST_LABEL[e.st] || null, orig: e.orig, slot: e.m };
          if (draggedFlag[e.s]) { qMsg('draggedout', roles(e.s)); draggedFlag[e.s] = false; }
          else if (e.s === foeSide) qMsg('foe.sendout', roles(e.s, { foeMon: e.name, b1: e.name }));
          else qMsg(sendOutKey(S.P[foeSide].hpFrac), roles(e.s, { b1: e.name, mine: e.name }));
          q({ t: 'slidein', side: e.s, mon });
          break;
        }
        case 'switch-out': {
          const old = P[e.s];
          gasLeaves(e.s); S.notes.ff[e.s] = false; S.notes.stk[e.s] = 0;
          if (draggedFlag[e.s] || pivotFlag[e.s]) { /* the text came with forced-out / pivot */ pivotFlag[e.s] = false; }
          else if (e.s === viewSide) qMsg(recallKey(P[foeSide].hpFrac), roles(e.s, { b1: old.name }));
          else qMsg('foe.withdrew', roles(e.s, { b1: old.name }));
          if (!sysOn(eventId('recall', e.s, viewSide))) qAnim('special', e.s === viewSide ? SPECIAL.SWITCH_OUT_PLAYER_MON : SPECIAL.SWITCH_OUT_OPPONENT_MON, e.s, e.s);
          q({ t: 'slideout', side: e.s });
          break;
        }
        case 'forced-out': draggedFlag[e.s] = true; break;
        case 'pivot': pivotFlag[e.s] = true; qMsg('wentback', roles(e.s)); break;
        case 'move-use': {
          userSide = e.s;
          const mv = pack.moves[e.mv];
          S.notes.lastMove[e.s] = moveName(e.mv);
          // AN1 round 6/7: a move another move or ability calls is announced when the real game announces it ("<holder> used Dragon Dance!" for Dancer; "<mon> used Tackle!" after Mirror Move, Copycat, Me First,
          // Nature Power: MEASURED through the oracle) and not when its caller has a line of its own (Magic Bounce, Metronome)
          const pv = evs[i - 1];
          if (!e.called || (pv && ((pv.t === 'ability' && pv.fx === 'dancer') || (pv.t === 'copy' && ANNOUNCED_COPY.has(pv.how))))) qMsg('used', roles(e.s, { b3: moveName(e.mv) }));
          if (moveName(e.mv) === 'Tidy Up') tidyFor = e.s;
          bellSaid = false;
          // AN1: "X used MOVE!" -> the move's ROM animation -> damage / HP bar -> messages. A move the game rejects before animating (a miss, an avoid,
          // a protect, a failure) has no animation; one the target is immune to still animates, then says so (recollection of the decomp's script order).
          // With animations off, or when the animator has none for this move, the step turns into the old lunge (damaging moves with a hit or a miss next).
          const charges = !!(nx && nx.t === 'charge');
          const second = A.charging[e.s] === e.mv && !charges;
          if (!charges) A.charging[e.s] = 0;
          qAnim('move', e.mv, e.s, mv && (mv.target === 7 || mv.target === 8) ? e.s : e.s ^ 1, {
            noPlay: !!(nx && (nx.t === 'miss' || nx.t === 'avoid' || nx.t === 'protected' || nx.t === 'fail')),
            fb: mv && mv.category !== 2 && nx && (nx.t === 'damage' || nx.t === 'miss') ? 'lunge' : null, turn: second ? 1 : 0,
          });
          if (STOCK_MOVES.has(moveName(e.mv))) stockpileMove(i, e, moveName(e.mv));
          break;
        }
        case 'copy':
          // AN1 round 7: every `how` the engine emits that the ROM has a line for (MEASURED for skill-swap, role-play, ability-set, ability-copy, psych-up, the three swaps, mimic, nature-power)
          if (e.how === 'skill-swap') qMsg('ab.swapped', roles(e.s));
          else if (e.how === 'role-play') qMsg('copy.roleplay', roles(e.s, { other: monName(e.s ^ 1, false) }));
          else if (e.how === 'ability-set' || e.how === 'ability-copy') qMsg('copy.acquired', roles(e.s, { ability: abilityName(e.ab) }));
          else if (e.how === 'psych-up') qMsg('copy.psychup', roles(e.s, { other: monName(e.s ^ 1, false) }));
          else if (e.how === 'power-swap' || e.how === 'guard-swap' || e.how === 'heart-swap') qMsg('copy.statswap', roles(e.s));
          else if (e.how === 'mimic') qMsg('copy.mimic', roles(e.s, { b1: moveName(e.mv) }));
          else if (e.how === 'nature-power') qMsg('copy.naturepower', roles(e.s, { move: moveName(e.mv) }));
          else if (e.how === 'instruct') qMsg('copy.instruct', roles(e.s, { other: monName(e.s ^ 1, false) }));
          else if (e.how === 'metronome') qMsg('metronome', roles(e.s, { move: moveName(e.mv) }));
          else if (e.how === 'transform') qMsg('transformed', roles(e.s, { b1: speciesName(e.sp) }));
          else if (e.how === 'mummy') qMsg('ab.acquired', roles(e.s, { ability: abilityName(e.ab) }));
          else if (e.how === 'trace') qMsg('ab.trace', roles(e.s, { b1: monName(e.s ^ 1, false).replace(/^the opposing /, ''), b2: abilityName(e.ab) }));
          break;
        case 'miss': qMsg('miss', roles(e.s)); break;
        case 'avoid': qMsg('avoid', roles(e.s)); break;
        case 'fail': {
          const w = e.why;
          if (w === 'already-status') { const st = P[e.s ^ 1].status; qMsg(st === 'SLP' ? 'already.slp' : st === 'BRN' ? 'already.brn' : st === 'PAR' ? 'already.par' : st === 'PSN' ? 'already.psn' : 'failed', roles(e.s ^ 1)); }
          else if (w === 'already-confused') qMsg('already.conf', roles(e.s ^ 1));
          else if (w === 'safeguard') qMsg('scr.sgblock', roles(e.s ^ 1));
          else if (w === 'primal-weather') qMsg(S.notes.pw === 6 ? 'wx.fizzle.rain' : 'wx.fizzle.sun', roles(0));       // a Fire move in heavy rain / a Water move in harsh sun: one line, no "But it failed!" (MEASURED)
          else {
            // a weather move into a primal weather says which one it cannot change, THEN fails (MEASURED: "There is no relief from this heavy rain!" / "But it failed!")
            if (S.notes.pw >= 6 && S.notes.pw <= 8 && WEATHER_MOVES.has(moveName(e.mv))) qMsg(S.notes.pw === 6 ? 'wx.norelief.rain' : S.notes.pw === 7 ? 'wx.norelief.sun' : 'wx.norelief.winds', roles(0));
            qMsg('failed', roles(e.s));
          }
          break;
        }
        case 'immune': {
          if (e.why === 'ability') {
            const pa = evs[i - 1], pf = pa && pa.t === 'ability' && pa.s === e.s ? pa.fx : '', abn = abilityName(e.ab), mvn = moveName(e.mv);
            const heals = !!(nx && nx.t === 'heal' && nx.s === e.s), boosts = !!(nx && nx.t === 'stat-change' && nx.s === e.s);
            if (pf === 'absorb') { if (heals) pendingAbsorb[e.s] = abn; else if (!boosts) qMsg('ab.useless', roles(e.s, { ability: abn, move: mvn })); }          // "restored HP using its <ability>!" / "made <move> useless!" / just the stat line
            else if (pf === 'wind-rider' || pf === 'wind-chime') { if (!boosts) qMsg('ab.immune', roles(e.s, { ability: abn, move: mvn })); }
            else if (pf === 'levitate' || pf === 'wonder-guard' || pf === 'allseeing-idol' || pf === 'electromagnetism') qMsg('immune', roles(e.s, { other: monName(e.s, false) }));
            else if (pf === 'soundproof' || pf === 'bulletproof') qMsg('ab.blocks', roles(e.s, { ability: abn, move: mvn }));
            else if (pf === 'dazzling' || pf === 'armor-tail' || pf === 'queenly-majesty') qMsg('ab.prevents', roles(e.s, { ability: abn, move: mvn, other: monName(e.s ^ 1, false) }));
            else qMsg('ab.immune', roles(e.s, { ability: abn, move: mvn }));
          }
          else if (e.why === 'ability-confuse') qMsg('ab.confuse', roles(e.s, { ability: abilityName(e.ab) }));
          else qMsg('immune', roles(e.s, { other: monName(e.s, false) }));
          break;
        }
        case 'protected': qMsg('protected', roles(e.s)); break;
        case 'protect-break': qMsg('fell.feint', roles(e.s)); break;
        case 'cant-move': {
          const k = { slp: 'cant.slp', frz: 'cant.frz', par: 'cant.par', flinch: 'cant.flinch', recharge: 'cant.recharge', truant: 'cant.truant', 'lost-focus': 'cant.focus', disabled: 'cant.disabled', taunt: 'cant.taunt', gravity: 'cant.gravity', love: 'cant.love', torment: 'cant.torment', imprison: 'cant.imprison', 'heal-block': 'cant.healblock', 'throat-chop': 'cant.throat' }[e.why];
          if (!k) break;                                          // sky-drop ...: the ROM has no line for it (searched in tools/pokemonarena_event_codes_test.mjs), so none is shown
          const mvn = e.mv && pack.moves[e.mv] ? moveName(e.mv) : e.why === 'disabled' ? S.notes.disabled[e.s] : S.notes.lastMove[e.s];
          qMsg(k, roles(e.s, { move: mvn || 'that move', other: monName(e.s, false) }));
          break;
        }
        case 'struggle': qMsg('cant.struggle', roles(e.s)); break;
        case 'charge': {
          A.charging[e.s] = e.mv;
          const nm = pack.moves[e.mv] ? pack.moves[e.mv].name : '';
          let k = 'charge.generic';
          if (e.sinv === 'ground') k = 'charge.ground'; else if (e.sinv === 'water') k = 'charge.water'; else if (e.sinv === 'air') k = nm === 'Bounce' ? 'charge.bounce' : 'charge.air';
          else if (/Solar/.test(nm)) k = 'charge.light'; else if (/Skull Bash/.test(nm)) k = 'charge.head'; else if (/Razor Wind/.test(nm)) k = 'charge.wind'; else if (/Sky Attack/.test(nm)) k = 'charge.sky';
          qMsg(k, roles(e.s));
          break;
        }
        case 'confusion-hit': q({ t: 'shake', side: e.s }); qMsg('confhit', roles(e.s)); break;
        case 'crit': break;                                    // reported with the damage it belongs to
        case 'multi-hit': qMsg('multihit', roles(e.s, { b1: String(e.n) })); break;
        case 'damage': { const ds = e.s; i = handleDamage(evs, i); flushAfterDrain(ds); break; }
        case 'heal': handleHeal(e, evs, i); break;
        case 'drain': qMsg('drained', roles(e.s ^ 1)); break;
        case 'recoil': if (e.crash) qMsg('crashed', roles(e.s)); break;
        case 'endure': qMsg('endured', roles(e.s)); break;
        case 'sub-set': qMsg('subset', roles(e.s)); break;
        case 'sub-damage': qMsg('subtook', roles(e.s, { other: monName(e.s, false) })); break;
        case 'sub-break': qMsg('subfaded', roles(e.s)); break;
        case 'destiny-bond': qMsg('destiny', roles(e.s)); break;
        case 'wish': qAnim('general', GENERAL.WISH_HEAL, e.s, e.s); qMsg(e.hw === 1 ? 'wish.heal' : e.hw === 2 ? 'wish.lunar' : 'wishcame', roles(e.s, { b1: P[e.s].name, other: monName(e.s, false) })); break;       // hw 1 = Healing Wish, 2 = Lunar Dance (their own ROM lines); no hw = Wish
        case 'future-sight': qMsg('tookattack', roles(e.s, { b1: moveName(e.mv) })); qAnim('general', GENERAL.FUTURE_SIGHT_HIT, e.s ^ 1, e.s); break;
        case 'faint': {
          const nm = P[e.s].name;
          q({ t: 'faint', side: e.s });
          P[e.s].hpFrac = 0;
          qMsg('fainted', roles(e.s));
          gasLeaves(e.s); S.notes.ff[e.s] = false; S.notes.stk[e.s] = 0;
          void nm;
          break;
        }
        case 'status-set': {
          const lab = ST_LABEL[e.st];
          P[e.s].status = lab || null;
          if (STATUS_ANIM_OF[e.st] !== undefined) qAnim('status', STATUS_ANIM_OF[e.st], e.s, e.s);        // the status effect plays, then the message and the icon
          const pa = evs[i - 1], byAb = pa && pa.t === 'ability' && pa.s !== e.s && (pa.fx === e.fx || pa.fx === 'static' || pa.fx === 'flame-body' || pa.fx === 'poison-point' || pa.fx === 'effect-spore') ? pa : null;
          const abR = byAb ? { ability: abilityName(byAb.ab), other: monName(e.s, false) } : null;
          if (e.fx === 'rest') qMsg('st.rest', roles(e.s));
          else if (byAb && byAb.fx === 'static' && e.st === 5) qMsg('ab.static', roles(byAb.s, abR));
          else if (byAb && byAb.fx === 'flame-body' && e.st === 3) qMsg('ab.flamebody', roles(byAb.s, abR));
          else if (byAb && (byAb.fx === 'poison-point' || byAb.fx === 'effect-spore') && e.st === 2) qMsg('ab.poisonpt', roles(e.s, { ability: abilityName(byAb.ab), other: monName(byAb.s, false) }));
          else if (byAb && byAb.fx === 'effect-spore' && e.st === 5) qMsg('ab.static', roles(byAb.s, abR));
          else if (byAb && byAb.fx === 'effect-spore' && e.st === 1) qMsg('ab.sleepspore', roles(byAb.s, abR));
          else qMsg('st.' + (e.st === 6 ? 'tox' : (ST_WORD[e.st] || 'psn')), roles(e.s));
          q({ t: 'set', fn: () => { if (S.disp[e.s]) S.disp[e.s].status = lab || null; } });
          break;
        }
        case 'status-clear': {
          P[e.s].status = null;
          const w = e.why;
          if (w === 'wake') qMsg('clr.wake', roles(e.s));
          else if (w === 'heal-bell') { if (!bellSaid) { bellSaid = true; qMsg(/Aromatherapy/.test(S.notes.lastMove[userSide] || '') ? 'aroma' : 'bell', roles(userSide)); } }       // MEASURED: one line for the move, nothing per Pokemon
          else if (w === 'purify') qMsg('purify', roles(e.s ^ 1, { other: monName(e.s, false) }));                   // MEASURED: "<user> cured <target>'s problem!"
          else if (e.st === 7 && w !== 'berry' && w !== 'lum' && w !== 'rest') qMsg('clr.frb', roles(e.s));
          else if (w === 'thaw') qMsg('clr.thaw', roles(e.s));
          else if ((w === 'berry' || w === 'lum') && S.notes.lastItem[e.s]) qMsg('cure.' + (ST_WORD[e.st] || 'psn'), roles(e.s, { item: S.notes.lastItem[e.s] }));
          else if (w !== 'rest') qMsg('clr.generic', roles(e.s));
          q({ t: 'set', fn: () => { if (S.disp[e.s]) S.disp[e.s].status = null; } });
          break;
        }
        case 'volatile': {
          const v = e.v;
          const k = { confusion: 'conf.start', 'leech-seed': 'vol.seeded', taunt: 'vol.taunt', encore: 'vol.encore', yawn: 'vol.yawn', 'lock-on': 'vol.lockon', foresight: 'vol.foresight', 'focus-energy': 'vol.focus', ingrain: 'vol.ingrain', 'aqua-ring': 'vol.aqua', trapped: 'vol.noescape', curse: 'vol.curse', 'future-sight': 'foresaw', infatuation: 'vol.love', torment: 'vol.torment', 'perish-song': 'vol.perish', imprison: 'vol.imprison' }[v];
          if (v === 'trap') S.notes.trap[e.s] = e.mv ? moveName(e.mv) : (S.notes.lastMove[e.s ^ 1] || 'the trap');          // the engine's trap event names no move: it is the trapper's last one (AN1 round 8)
          if (v === 'confusion') qAnim('status', STATUS.CONFUSION, e.s, e.s);
          else if (v === 'curse') qAnim('status', STATUS.CURSED, e.s, e.s);
          // AN1 round 7: the volatiles the ROM has a line for (MEASURED through the oracle for every key below except where tools/pokemonarena_event_codes_test.mjs says otherwise)
          const VOL7 = { 'destiny-bond': 'vol.destiny', endure: 'braced', noescape: 'vol.noescape', electrify: 'vol.electrify', embargo: 'vol.embargo', 'gastro-acid': 'vol.gastro', grudge: 'vol.grudge', 'heal-block': 'vol.healblock', 'laser-focus': 'vol.laser',
            'magic-coat': 'vol.coat', 'magnet-rise': 'vol.magnet', 'miracle-eye': 'vol.foresight', powder: 'vol.powder', 'power-trick': 'vol.powertrick', 'salt-cure': 'vol.saltcure', snatch: 'snatch.set', 'syrup-bomb': 'vol.syrup',
            'tar-shot': 'vol.tarshot', telekinesis: 'vol.telekinesis', 'bide-storing': 'vol.bide.store', 'bide-unleash': 'vol.bide.go', protect: 'protected' };
          const pa7 = evs[i - 1];
          if (VOL7[v]) qMsg(VOL7[v], roles(e.s));
          else if (v === 'sky-drop') qMsg('vol.skydrop', roles(e.s ^ 1, { other: monName(e.s, false) }));
          else if (v === 'nightmare') qMsg('vol.nightmare', roles(e.s));
          else if (v === 'infatuated') qMsg('love.each', roles(e.s, { other: monName(e.s ^ 1, false) }));          // MEASURED: every turn, before "immobilized by love"
          else if (v === 'split') qMsg(/Power/.test(S.notes.lastMove[e.s] || '') ? 'split.power' : 'split.guard', roles(e.s));
          else if (v === 'speed-swap') qMsg('copy.speedswap', roles(e.s, { b1: text.compose(STAT_KEY.spe || 'stat.spe') }));
          else if (v === 'charged') { if (!(pa7 && pa7.t === 'ability')) qMsg('charge.generic', roles(e.s)); }       // the Charge move; an ability's charge has its own line (or none)
          else if (v === 'infatuation' && pa7 && pa7.t === 'ability' && pa7.fx === 'cute-charm') qMsg('ab.cutecharm', roles(pa7.s, { ability: abilityName(pa7.ab), other: monName(e.s, false) }));
          else if (v === 'disable') { S.notes.disabled[e.s] = moveName(e.mv); const cb = evs[i - 1]; if (cb && cb.t === 'ability' && cb.fx === 'cursed-body') qMsg('ab.cursedbody', roles(e.s, { b3: moveName(e.mv), other: monName(cb.s, false), ability: abilityName(cb.ab) })); else qMsg('vol.disable', roles(e.s, { b1: moveName(e.mv) })); }
          else if (v === 'trap') {
            // AN1 round 8 (MEASURED through the oracle, scn11, every binding move): the start line is the move's own; "hurt by <move>" and "freed from <move>" name it. Clamp and Thunder Cage say the TRAPPER first
            const tk = TRAP_START[S.notes.trap[e.s]];
            if (tk && tk[1]) qMsg(tk[0], roles(e.s ^ 1, { other: monName(e.s, false) })); else qMsg(tk ? tk[0] : 'vol.trap', roles(e.s, { other: monName(e.s ^ 1, false) }));
          }
          else if (k) qMsg(k, roles(e.s, { other: monName(e.s ^ 1, false) }));
          break;
        }
        case 'volatile-end': {
          const k = { confusion: 'conf.end', taunt: 'vol.taunt.end', disable: 'vol.disable.end', encore: 'vol.encore.end', trap: 'vol.trap.end', infatuation: 'vol.love.end', torment: 'vol.torment.end',
            embargo: 'end.embargo', telekinesis: 'end.telekinesis', 'throat-chop': 'end.throat' }[e.v];
          const herb = evs.slice(Math.max(0, i - 4), i).some((x) => x.t === 'item' && x.s === e.s && x.fx === 'mental-herb');
          if (e.v === 'heal-block') qMsg(herb ? 'cure.healblock' : 'end.wore', roles(e.s, { b1: 'Heal Block' }));                   // MEASURED: "<mon>'s Heal Block wore off!"
          else if (e.v === 'magnet-rise') qMsg('end.wore', roles(e.s, { b1: text.compose('word.magnet') }));                      // MEASURED: "<mon>'s electromagnetism wore off!"
          else if (e.v === 'leech-seed') qMsg('vol.leechend', roles(e.s));
          else if (e.v === 'trap' && e.why === 'rapid-spin') qMsg('trap.free', roles(e.s, { other: monName(e.s ^ 1, false), b1: S.notes.trap[e.s] || 'the trap' }));
          else if (k) qMsg(k, roles(e.s, { b1: S.notes.trap[e.s] || 'the trap' }));
          break;
        }
        case 'type-change': {
          const prev = evs[i - 1];
          if (prev && prev.t === 'ability' && prev.s === e.s) qMsg('typeability', roles(e.s, { ability: abilityName(prev.ab), b1: typeName(e.ty[0]) }));
          else qMsg('typechange', roles(e.s, { b1: typeName(e.ty[0]) }));
          break;
        }
        case 'stat-change': {
          let prev = evs[i - 1];
          if (prev && prev.t === 'heal' && evs[i - 2] && evs[i - 2].t === 'ability' && evs[i - 2].s === prev.s) prev = evs[i - 2];       // [ability, heal, stat change] (Jade Bloom): the line still names the ability
          if (prev && prev.t === 'ability' && prev.fx === 'intimidate' && e.s !== prev.s) break;      // the ability line already said it
          const d = e.delta, up = d > 0, n = Math.abs(d);
          qAnim('general', GENERAL.STATS_CHANGE, e.s, e.s, { animArg: statAnimArg(e.stat, d) });          // the stat arrows play, then the message
          const adv = n >= 3 ? text.compose(up ? 'adv.drastically' : 'adv.severely') : n === 2 ? text.compose(up ? 'adv.sharply' : 'adv.harshly') : '';
          let st = text.compose(STAT_KEY[e.stat] || 'stat.atk');
          if (pairIdx.has(i)) { const b = evs[i + 1]; skipAt.add(i + 1); qAnim('general', GENERAL.STATS_CHANGE, e.s, e.s, { animArg: statAnimArg(b.stat, b.delta) }); st += text.compose('word.and') + text.compose(STAT_KEY[b.stat]); }
          if (tidyFor === e.s) { tidyFor = -1; qMsg('tidy', roles(e.s)); }                                       // MEASURED: the hazards go, "Tidying up complete!", then the stats
          if (usingItem && usingItem.side === e.s) qMsg(up ? 'item.statup' : 'item.statdown', roles(e.s, { item: usingItem.item, b1: st, b2: adv, other: monName(e.s, false) }));      // MEASURED: "Using Kee Berry, the Defense of Machop rose!"
          else if (prev && prev.t === 'ability' && prev.s === e.s && up && prev.fx === 'anger-point') qMsg('stat.abilitymax', roles(e.s, { ability: abilityName(prev.ab), b1: st }));
          else if (prev && prev.t === 'ability' && prev.s === e.s && up && prev.fx !== 'intimidate') qMsg('stat.abilityup', roles(e.s, { ability: abilityName(prev.ab), b1: st, b2: adv }));
          else qMsg(up ? 'stat.up' : 'stat.down', roles(e.s, { b1: st, b2: adv, ability: '' }));
          break;
        }
        case 'stat-fail': {
          const st = text.compose(STAT_KEY[e.stat] || 'stat.atk');
          if (e.why === 'max') qMsg('stat.max', roles(e.s, { b1: st }));
          else if (e.why === 'min') qMsg('stat.min', roles(e.s, { b1: st }));
          else if (e.why === 'mist') qMsg('stat.mist', roles(e.s));
          else qMsg('stat.abilityblock', roles(e.s, { ability: e.ab ? abilityName(e.ab) : 'ability' }));
          break;
        }
        case 'stats-reset': {
          if (nx && nx.t === 'stats-reset' && nx.s !== e.s) { qMsg('stat.haze', roles(e.s)); i++; } else qMsg('stat.reset', roles(e.s));
          break;
        }
        case 'weather': {
          const prev = evs[i - 1];
          const w = e.w;
          // AN1 round 6: the ENGINE emits the weather first and its ability event right after it (setWeather, then show), so the pair is read in that order (the older order, ability first, is read too).
          // Primal weather (6 heavy rain, 7 harsh sun, 8 strong winds) is set by an ability as well: the real game says its own start line (no "made it rain" line for it) and then plays the same
          // "continues" animation the other weather abilities do (MEASURED through the oracle, tools/pokemonarena_anim_scene_test.mjs: Primordial Sea = general 9 like Drizzle, Desolate Land = general 10
          // like Drought, Delta Stream = general 29).
          const isW = (x) => x && x.t === 'ability' && (x.fx === 'weather' || x.fx === 'primal-weather') ? x : null;
          const ab = isW(nx) && nx.s === e.s ? nx : isW(prev) ? prev : null;
          if (ab && ab.fx === 'weather' && (w === 1 || w === 2 || w === 3)) qMsg('wxab.' + w, roles(ab.s, { ability: abilityName(ab.ab) }));
          else qMsg('wx.' + w + '.start', roles(e.s));
          // a weather ability has no move animation of its own: the weather's "continues" animation plays (a weather MOVE's own animation already did)
          if (ab && WEATHER_ANIM_OF[w] !== undefined) qAnim('general', WEATHER_ANIM_OF[w], e.s, e.s ^ 1);
          qCall(() => { S.weather = w; }); S.notes.pw = w;
          break;
        }
        case 'weather-tick': { const tk = { 6: 'wx.1.tick', 7: 'wx.2.tick', 8: 'wx.norelief.winds' }[e.w] || 'wx.' + e.w + '.tick'; if (text.has(tk)) qMsg(tk, roles(0)); if (WEATHER_ANIM_OF[e.w] !== undefined) qAnim('general', WEATHER_ANIM_OF[e.w], 0, 1); break; }
        case 'weather-end': qMsg('wx.' + e.w + '.end', roles(0)); qCall(() => { S.weather = 0; }); S.notes.pw = 0; break;
        case 'hazard': { const hk = e.hz === 'ts' ? 'tspikes' : e.hz; S.notes.hz[e.s].add(hk); qMsg('hz.' + hk, roles(e.s)); break; }           // Toxic Debris says 'ts', the move says 'tspikes': the same Toxic Spikes line (AN1 round 6)
        case 'hazard-damage': qMsg(e.hz === 'rocks' ? 'hurt.rocks' : 'hurt.spikes', roles(e.s, { other: monName(e.s, false) })); break;
        case 'hazard-clear': {
          // AN1 round 7: hz 'all' (Rapid Spin, Mortal Spin, Defog, Tidy Up) names each hazard that was there, in the order the real game does (MEASURED with all four up): Rapid Spin / Mortal Spin say
          // "<user> blew away <hazard>!", the others "The <hazard> disappeared from ... <team>!"
          const kinds = e.hz === 'all' ? HZ_ORDER.filter((hk) => S.notes.hz[e.s].has(hk)) : [e.hz];
          const spin = /Spin$/.test(S.notes.lastMove[userSide] || '');
          for (const hk of kinds) { S.notes.hz[e.s].delete(hk); if (e.hz === 'all' && spin) qMsg('hz.away.' + hk, roles(userSide)); else qMsg('hz.clear.' + hk, roles(e.s)); }
          break;
        }
        case 'screen': {
          const k = { reflect: 'scr.reflect', light: 'scr.light', sg: 'scr.sg', tw: 'scr.tw', mist: 'scr.mist' }[e.k];
          if (k) qMsg(k, roles(e.s)); else qText(rawMsg('scr.veil', teamWord(e.s, true) + ' team is covered by a veil!'));
          break;
        }
        case 'screen-end': {
          const k = { sg: 'scr.end.sg', tw: 'scr.end.tw' }[e.k];
          if (k) qMsg(k, roles(e.s)); else qMsg('scr.end.generic', roles(e.s, { b1: { reflect: 'Reflect', light: 'Light Screen', veil: 'Aurora Veil', mist: 'Mist' }[e.k] || 'the screen' }));
          break;
        }
        case 'field': {
          // ENGINE.md 12: k = trick-room (the first one), the five terrains, gravity, the sports, the rooms, fairy lock, ion deluge, court change; on 1 = it starts, 0 = it ends.
          // The ROM has a line for each start (and most ends); one it does not have (Scorched Field, Fairy Lock's end ...) is shown as flagged text or not at all. Never an unknown key.
          const on = e.on ? 1 : 0;
          if (e.k === 'court-change') { const t0 = S.notes.hz[0]; S.notes.hz[0] = S.notes.hz[1]; S.notes.hz[1] = t0; }
          if (e.k === 'trick-room') { qMsg(on ? 'field.tr.on' : 'field.tr.off', roles(e.s !== undefined ? e.s : 0)); qCall(() => { S.trickRoom = !!on; }); }
          else if (TN_OF[e.k]) {
            const id = TN_OF[e.k];
            if (text.has('tn.' + id + (on ? '.on' : '.off'))) qMsg('tn.' + id + (on ? '.on' : '.off'), roles(0));
            else qText(rawMsg('tn.' + id + (on ? '.on' : '.off'), on ? 'The ground was scorched!' : 'The scorched ground cooled.'));
            qCall(() => { S.terrain = on ? id : 0; });
          } else if (FIELD_KEY[e.k]) {
            const key = 'fld.' + FIELD_KEY[e.k] + (on ? '.on' : '.off');
            if (text.has(key)) qMsg(key, roles(e.s !== undefined ? e.s : userSide));
            if (e.k === 'gravity') qCall(() => { S.gravity = !!on; });
          }
          break;
        }
        case 'perish': qMsg('perish', roles(e.s, { b1: String(e.n) })); break;
        case 'revive': qMsg('revive', roles(e.s, { b1: benchName(e.s, e.m) })); break;
        case 'pp-drain': {
          const grudged = evs.slice(0, i).some((x) => x.t === 'faint' && x.s === (e.s ^ 1));
          if (grudged) qMsg('grudge.pp', roles(e.s, { b1: moveName(e.mv) }));
          else qMsg('spite', roles(e.s, { b1: '3', b2: '3', move: moveName(e.mv) }), { slots: { '0': 'move', '1': 'b1' } });
          break;
        }
        case 'ability': {
          // AN1 round 6 (FV1: Neutralizing Gas and the Ruin abilities showed nothing). A weather ability's line is said by the weather event (above). Every other `fx` code is classed in
          // tools/pokemonarena_scene_events_test.mjs ABILITY_FX: the lines below are the ROM's own for that ability; a code with no line here shows through the event that follows it (a stat change,
          // a status, a type change, an immunity ...), through the HP bar alone, or not at all, and the test says which and proves the ROM has no line of its own for it.
          const ab = abilityName(e.ab), fx = e.fx;
          if (fx === 'intimidate') qMsg('ab.intimidate', roles(e.s, { ability: ab, other: monName(e.s ^ 1, false) }));
          else if (fx === 'neutralizing-gas') { S.notes.gas[e.s] = true; qMsg('ab.gas.on', roles(e.s)); }
          else if (fx === 'ruin') { const k = RUIN_KEY[ab]; if (k) qMsg(k, roles(e.s, { ability: ab })); }
          else if (fx === 'unnerve') { if (/^As One/.test(ab)) qMsg('ab.asone', roles(e.s)); qMsg('ab.unnerve', roles(e.s ^ 1)); }
          else if (fx === 'slow-start') qMsg('ab.slowstart', roles(e.s));
          else if (fx === 'supersweet-syrup') qMsg('ab.syrup', roles(e.s, { other: monName(e.s, false) }));
          else if (fx === 'harvest') qMsg('ab.harvest', roles(e.s, { item: nx && nx.t === 'item' && nx.fx === 'harvest' ? itemName(nx.it) : 'Berry' }));
          else if (fx === 'disguise') { qMsg('ab.disguise', roles(e.s)); if (nx && nx.t === 'immune' && nx.why === 'ability') skipAt.add(i + 1); }
          else if (fx === 'liquid-ooze') qMsg('ab.ooze', roles(e.s ^ 1));
          else if (fx === 'sturdy') afterDrain[e.s] = () => qMsg('ab.sturdy', roles(e.s, { ability: ab }));
          else if (fx === 'wandering-spirit') qMsg('ab.swapped', roles(e.s));
          else if (ENTRY_KEY[fx]) qMsg(ENTRY_KEY[fx], roles(e.s));                                                  // AN1 round 8: the engine emits these now; MEASURED wording
          else if (fx === 'forewarn') qMsg('ab.forewarn', roles(e.s, { ability: ab, hn: monName(e.s, false), fn: monName(e.s ^ 1, false), b1: moveName(e.mv) }), { slots: { '41': 'hn', '40': 'fn' } });
          else if (fx === 'frisk') qMsg('ab.frisk', roles(e.s, { other: monName(e.s ^ 1, false), b1: itemName(e.it) }));
          else if (fx === 'flash-fire') { const first = !S.notes.ff[e.s]; S.notes.ff[e.s] = true; if (first) { qMsg('ab.flashfire', roles(e.s, { ability: ab })); if (nx && nx.t === 'immune' && nx.why === 'ability') skipAt.add(i + 1); } }       // MEASURED: the first absorption says "raised the power of Fire-type moves", the next ones "made <move> ineffective"
          else if (fx === 'electromorphosis' || fx === 'wind-power') qMsg('ab.charged', roles(e.s, { move: S.notes.lastMove[e.s ^ 1] || 'that move', other: monName(e.s, false) }));       // MEASURED (Wind Power through the oracle): said after the hit's own lines
          else if (fx === 'magic-bounce' && nx && nx.t === 'noop' && nx.why === 'bounced') { qMsg('ab.bounce', roles(e.s ^ 1, { move: moveName(nx.mv), other: monName(e.s, false), ability: ab })); skipAt.add(i + 1); }
          break;
        }
        case 'item': {
          const it = itemName(e.it);
          S.notes.lastItem[e.s] = it;
          const f = e.fx;
          if (f === 'oran' || f === 'sitrus' || f === 'pinch-heal') qMsg('heal.berry', roles(e.s, { item: it }));
          else if (f === 'white-herb') qMsg('herb', roles(e.s, { item: it }));
          else if (f === 'sash') qMsg('sash', roles(e.s, { item: it }));
          else if (f === 'cure-confusion') qMsg('cure.conf', roles(e.s, { item: it }));
          else if (f === 'knocked-off') qMsg('knockoff', roles(e.s ^ 1, { other: monName(e.s, false), item: it }));
          else if (f === 'resist-berry') qMsg('resistberry', roles(e.s, { item: it, other: monName(e.s, false) }));
          else if (f === 'balloon-pop') qText(rawMsg('balloonpop', roles(e.s).subj + "'s " + it + ' popped!'));
          else if (f === 'enigma') qMsg('heal.berry', roles(e.s, { item: it }));
          else if (f === 'bestow') qMsg('item.bestow', roles(e.s ^ 1, { item: it, other: monName(e.s, false) }));            // MEASURED: "<receiver> received <item> from <giver>!"
          else if (f === 'incinerate') qMsg('item.burnt', roles(e.s, { item: it }));                                  // MEASURED
          else if (f === 'pluck') qMsg('item.pluck', roles(e.s ^ 1, { item: it }));                                    // MEASURED: "<eater> stole and ate its target's <item>!"
          else if (f === 'recycle') qMsg('item.recycle', roles(e.s, { item: it }));                                    // ROM 0x44174a; not oracle-reached
          else if (f === 'focus-band') qMsg('sash', roles(e.s, { item: it }));                                         // ROM "hung on using its Focus Band" (the Sash line); not oracle-reached
          else if (f === 'fling') qMsg('item.fling', roles(e.s, { item: it }));
          else if (f === 'custap') qMsg('item.custap', roles(e.s, { b1: it }));
          else if (f === 'micle') qMsg('item.micle', roles(e.s, { item: it }));
          else if (f === 'lansat') qMsg('item.lansat', roles(e.s, { item: it }));
          else if (f === 'leppa') qMsg('item.leppa', roles(e.s, { item: it, b1: S.notes.lastMove[e.s] || 'that move' }));
          else if (f === 'mirror-herb') qMsg('item.mirrorherb', roles(e.s));
          else if (f === 'red-card') qMsg('item.redcard', roles(e.s, { other: monName(e.s ^ 1, false) }));
          else if (f === 'eject-button' || f === 'eject-pack') qMsg('item.eject', roles(e.s, { item: it }));
          else if (f === 'gem') qMsg('item.gem', roles(e.s, { item: it, other: monName(e.s, false) }));
          else if (f === 'power-herb') qMsg('item.powerherb', roles(e.s, { item: it }));
          if (STAT_ITEM_FX.has(f)) usingItem = { side: e.s, item: it };                  // the stat changes that follow read "Using <item>, the <stat> of <mon> rose!"
          break;
        }
        case 'trick': {
          const itn = e.it ? itemName(e.it) : '';
          if (e.how === 'sticky-barb') qMsg('barb.attach', roles(e.s, { item: itn, other: monName(e.s, false) }));
          else if (e.steal || e.how === 'pickpocket' || e.how === 'magician') qMsg('steal', roles(e.s, { other: monName(e.from !== undefined ? e.from : e.s ^ 1, false), item: itn }));       // MEASURED: "<thief> stole <foe>'s <item>!"
          else if (nx && nx.t === 'trick' && nx.from === e.s && e.from === nx.s) {
            // Trick / Switcheroo: the pair of events is one swap
            qMsg('trick', roles(e.s));
            const n2 = nx.it ? itemName(nx.it) : '';
            if (itn && n2) qMsg('trick.both', roles(e.s, { b1: itn, b2: n2, o2: monName(nx.s, true) }), { slots: { '10': 'o2' } });
            else if (itn) qMsg('trick.one1', roles(e.s, { b1: itn }));
            else if (n2) qMsg('trick.one2', roles(nx.s, { b2: n2 }));
            skipAt.add(i + 1);
          } else qMsg('trick', roles(e.s));
          break;
        }
        case 'noop': {
          if (e.what === 'spite') qMsg('spite', roles(e.s, { b1: String(e.n || 4), b2: String(e.n || 4), move: moveName(e.mv) }), { slots: { '0': 'move', '1': 'b1' } });       // MEASURED: the target's name (the engine's event side)
          else if (e.what === 'magnitude') qMsg('oneblow', roles(e.s !== undefined ? e.s : userSide, { b1: String(e.n || '') }));       // the engine's Magnitude event has no side (roles(undefined) threw)
          else if (e.why === 'bounced') qMsg('ab.coat', roles(e.s, { move: moveName(e.mv) }));       // Magic Coat; Magic Bounce's pair is read at its ability event
          else if (e.why === 'snatched') qMsg('snatch.done', roles(e.s, { other: monName(e.s ^ 1, false) }));       // MEASURED: "<snatcher> snatched <foe>'s move!"
          else qMsg('nothing', roles(e.s));
          break;
        }
        case 'forfeit': qMsg('forfeit.done', roles(e.s)); break;
        case 'turn-cap': qText(rawMsg('turncap', 'The battle was called a draw.')); break;
        case 'win': {
          const youWon = e.s === viewSide;
          qMsg(youWon ? 'result.win' : 'result.lose', roles(viewSide));
          q({ t: 'end', winner: e.s });
          break;
        }
        case 'draw': qMsg('result.draw', roles(viewSide)); q({ t: 'end', winner: -1 }); break;
        default: break;
      }
      runAfter(i);
      void sidesWhoHit;
    }
  }

  // AN1 round 6: a line that belongs right after the HP bar of a side's hit has drained (Sturdy: "endured the hit using Sturdy!", then the effectiveness line)
  const afterDrain = [null, null];
  const pendingAbsorb = [null, null];                 // AN1 round 7: the absorb ability whose heal comes next (its line replaces the immunity line)
  function flushAfterDrain(side) { const fn = afterDrain[side]; if (fn) { afterDrain[side] = null; fn(); } }

  // damage events: the HP drain, the blink, then the messages that belong to that hit (critical, effectiveness, multi-hit count)
  function handleDamage(evs, i) {
    const e = evs[i], nx = evs[i + 1], P = S.P;
    P[e.s].hpFrac = e.max > 0 ? e.to / e.max : 0;
    const drain = () => q({ t: 'drain', side: e.s, to: e.to, max: e.max });
    if (e.src === 'move') {
      // AN1: the 2nd, 3rd... hit of a multi-hit move animates again (the first hit's animation was queued at move-use)
      const pv = evs[i - 1];
      if (pv && pv.t === 'damage' && pv.s === e.s && pv.mv === e.mv && pv.src === 'move') qAnim('move', e.mv, e.s ^ 1, e.s);
      if (e.to < e.from) q({ t: 'shake', side: e.s, eff: e.eff, crit: !!e.crit });
      drain();
      flushAfterDrain(e.s);
      if (e.crit) qMsg('crit', roles(e.s));
      const more = nx && nx.t === 'damage' && nx.s === e.s && nx.mv === e.mv && nx.src === 'move';
      if (!more) {
        let k = i;
        if (nx && nx.t === 'multi-hit') { qMsg('multihit', roles(nx.s, { b1: String(nx.n) })); k = i + 1; }
        const mv = pack.moves[e.mv];
        if (mv && mv.effect === 29 && e.to === 0) qMsg('ohko', roles(e.s));
        else {
          // AN1 round 8 (MEASURED through the oracle, scn13, and by FA2 in ROMDIFF.md section 9): `winds` means the Delta Stream clamp fired. The weakened line is said whenever it did, and THEN the real game
          // still says what is left (Rock into Butterfree: weakened, then "super effective"; into Skarmory: weakened, then "not very effective"; into Pidgey: weakened and nothing more)
          if (e.winds) qMsg('wx.winds.weak', roles(e.s));
          if (e.eff > 4096) qMsg('super', roles(e.s));
          else if (e.eff > 0 && e.eff < 4096) qMsg('resist', roles(e.s));
        }
        return k;
      }
      return i;
    }
    // AN1: end-of-turn poison and burn: the message, THEN the status animation, THEN the bar drains. MEASURED in the real game through the oracle (tools/pokemonarena_rom_oracle.mjs
    // startBattle + playTurn, a poisoned and a burned Pikachu, the CPU's Snorlax): poison text on turn frame 474, the mon's tint frames 517-573, the HP bar first moves on 589; burn
    // text 473, tint 518-536, bar 557. (The text before the drain also holds with animations off; it used to come after.) Curse and leech seed keep animation -> bar -> text:
    // not measured.
    if (e.src === 'psn' || e.src === 'tox' || e.src === 'brn' || e.src === 'fbt') {
      qMsg(e.src === 'brn' ? 'hurt.brn' : e.src === 'fbt' ? 'hurt.frb' : 'hurt.psn', roles(e.s));
      qAnim('status', e.src === 'brn' ? STATUS.BRN : e.src === 'fbt' ? STATUS.FRZ : STATUS.PSN, e.s, e.s);
      drain();
      return i;
    }
    if (e.src === 'curse') qAnim('status', STATUS.CURSED, e.s, e.s);
    else if (e.src === 'leech-seed') qAnim('general', GENERAL.LEECH_SEED_DRAIN, e.s ^ 1, e.s);
    drain();
    const src = e.src, r = roles(e.s);
    const map = { recoil: 'recoil', psn: 'hurt.psn', tox: 'hurt.psn', brn: 'hurt.brn', 'leech-seed': 'hurt.seed', sandstorm: 'hurt.sand', hail: 'hurt.hail', curse: 'hurt.curse', crash: null, 'belly-drum': 'bellydrum' };
    if (src === 'trap') qMsg('hurt.trap', roles(e.s, { b1: S.notes.trap[e.s] || 'the trap' }));
    else if (src === 'rocky-helmet') qMsg('hurt.helmet', roles(e.s, { other: monName(e.s ^ 1, false), b1: 'Rocky Helmet' }));
    else if (src === 'rough-skin') qMsg('hurt.roughskin', roles(e.s, { other: monName(e.s ^ 1, false), ability: 'Rough Skin' }));
    else if (src === 'life-orb') qText(rawMsg('lifeorb', r.subj + ' lost some of its HP!'));
    else if (src === 'black-sludge') qText(rawMsg('sludge', r.subj + ' was hurt by its Black Sludge!'));
    else if (src === 'pain-split' && !(P[e.s].painSplit)) { qMsg('shared', r); }
    else if (src === 'explosion' || src === 'memento' || src === 'final-gambit' || src === 'healing-wish' || src === 'destiny-bond') { if (src === 'destiny-bond') qMsg('taketeam', r); }
    else if (src === 'solar-power' || src === 'dry-skin') qMsg('dmg.toll', roles(e.s, { ability: src === 'dry-skin' ? 'Dry Skin' : 'Solar Power' }));              // MEASURED: "<mon>'s Solar Power / Dry Skin takes its toll!"
    else if (src === 'nightmare') qMsg('dmg.nightmare', r);                                                 // MEASURED: "<mon> is locked in a nightmare!"
    else if (src === 'innards-out' || src === 'aftermath') qMsg('dmg.hurt', r);                              // MEASURED: "<attacker> was hurt!" for both
    else if (src === 'bad-dreams') qMsg('dmg.tormented', r);                                                // MEASURED: "<sleeper> is tormented!"
    else if (src === 'spiky-shield') qMsg('hurt.helmet', roles(e.s, { other: monName(e.s ^ 1, false), b1: 'Spiky Shield' }));        // MEASURED: "<attacker> was hurt by <holder>'s Spiky Shield!"
    else if (src === 'salt-cure') qMsg('hurt.trap', roles(e.s, { b1: 'Salt Cure' }));                         // MEASURED: "<mon> is hurt by Salt Cure!"
    else if (src === 'jaboca' || src === 'rowap') qMsg('hurt.helmet', roles(e.s, { other: monName(e.s ^ 1, false), b1: S.notes.lastItem[e.s ^ 1] || 'Jaboca Berry' }));      // MEASURED (Jaboca)
    else if (src === 'sticky-barb') qMsg('hurt.barb', roles(e.s, { item: 'Sticky Barb' }));                  // MEASURED
    else if (src === 'powder') qMsg('hurt.powder', r);                                                      // MEASURED
    else if (src === 'shed-tail') qMsg('shedtail', r);
    else if (map[src]) qMsg(map[src], r);
    return i;
  }

  function handleHeal(e, evs, i) {
    const P = S.P;
    if (e.m !== undefined && P[e.s].slot !== undefined && e.m !== P[e.s].slot) return;          // a Pokemon on the bench (Revival Blessing): its HP is not what the healthbox shows
    P[e.s].hpFrac = e.max > 0 ? e.to / e.max : 1;
    if (e.src === 'ingrain') qAnim('general', GENERAL.INGRAIN_HEAL, e.s, e.s);
    q({ t: 'drain', side: e.s, to: e.to, max: e.max });
    const r = roles(e.s), src = e.src;
    if (src === 'leftovers') qMsg('heal.leftovers', roles(e.s, { item: 'Leftovers' }));
    else if (src === 'rest') qMsg('st.restheal', r);
    else if (src === 'move' || src === 'present' || src === 'swallow') qMsg('heal.move', r);                                   // MEASURED: Present heals with "<mon>'s HP was restored."
    else if (src === 'grassy-terrain') qMsg('heal.terrain', r);                                              // MEASURED
    else if (src === 'strength-sap') qMsg('drained', roles(e.s ^ 1));                                          // MEASURED: "<foe> had its energy drained!"
    else if (src === 'ingrain') qMsg('heal.ingrain', r);
    else if (src === 'aqua-ring') qMsg('heal.aqua', roles(e.s, { other: monName(e.s, false) }));
    else if (src === 'pain-split') { const prev = evs[i - 1]; if (!(prev && prev.t === 'damage' && prev.src === 'pain-split')) qMsg('shared', r); }
    else if (src === 'shell-bell' || src === 'black-sludge') qText(rawMsg('heal.' + src, r.subj + ' restored a little HP using its ' + (src === 'shell-bell' ? 'Shell Bell' : 'Black Sludge') + '!'));
    else if (pendingAbsorb[e.s]) { qMsg('heal.absorb', roles(e.s, { ability: pendingAbsorb[e.s] })); pendingAbsorb[e.s] = null; }       // MEASURED: "<mon> restored HP using its Water Absorb!"
    else if (src === 'ice-body') qMsg('heal.icebody', roles(e.s, { ability: 'Ice Body' }));                          // MEASURED: "<mon>'s Ice Body healed it a little bit!"
    else if (src === 'rain-dish' || src === 'dry-skin') qMsg('heal.raindish', roles(e.s, { ability: src === 'dry-skin' ? 'Dry Skin' : 'Rain Dish' }));       // MEASURED: "restored its HP a little!"
    else if (src === 'poison-heal') qMsg('heal.poisonheal', roles(e.s, { other: monName(e.s, false) }));            // MEASURED: "The poisoning healed <mon> a little bit!"
    else if (src === 'water-absorb' || src === 'volt-absorb' || src === 'earth-eater' || src === 'ritualist') qMsg('heal.absorb', roles(e.s, { ability: src.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') }));
  }

  /* --------------------------------------------------------------------------- the step engine (per frame) */
  function setBoxText(str) {
    const tw = createTypewriter({ text: safeMsg(str), measure: (s) => ui.measure('normal', s), maxWidth: R.msg.w - 4, delay: 0 });
    while (!tw.done && !tw.waiting) tw.tick(true);                    // a static prompt: the first page, fully printed
    return tw;
  }

  /* ---- AN1: animation steps ---- */
  const MAX_ANIM_FRAMES = 1800;               // a step that has not finished after 30 s of game time is cut (a script that never ends must not freeze the battle)
  const MAX_SKIP_FRAMES = 4096;
  function battlerInfo(side) {
    const d = S.disp[side], P = S.P[side], isPlayer = side === viewSide;
    const sp = d ? d.species : P.sp, c = isPlayer ? ui.LAYOUT.playerCenter : ui.LAYOUT.foeCenter;
    let y = c[1];
    try { const s = ui.sprite(sp, isPlayer ? 'player' : 'foe', { shiny: !!(d && d.shiny), female: !!(d && d.gender === 'F') }); y += s.yOffset - (isPlayer ? 0 : s.elevation); } catch (_e) { /* no picture: the centre stands */ }
    return { side: screenSide(side), x: c[0], y, species: sp, shiny: !!(d && d.shiny), female: !!(d && d.gender === 'F'), visible: !!(d && d.visible !== false), level: P.level, w: 64, h: 64 };
  }
  function startMoveAnim(st) {
    st.run = null; st.n = 0;
    const cfg = animCfg();
    let avail = 'none';
    if (cfg && animator) { try { avail = animator.available(st.kind, st.id) || 'none'; } catch (_e) { avail = 'none'; A.log.push('available() threw for ' + st.kind + ':' + st.id); } }
    if (!st.noPlay && cfg && animator) { A.coverage[avail] = (A.coverage[avail] || 0) + 1; A.byId[st.kind + ':' + st.id] = avail; }
    // the run draws both Pokemon, so an animation cannot play while one of them is off the screen (a faint just happened, nobody sent out yet)
    const away = (s) => !S.disp[s] || S.disp[s].visible === false;
    const selfRun = st.a === st.d;
    // only 'exact' and 'approx' play; the engine's 'fallback' (it cannot run that one) and 'none' leave the old lunge + blink (ANIM.md "Coverage")
    const playable = avail === 'exact' || avail === 'approx';
    if (playable && (away(st.a) || away(st.d) || away(st.a ^ 1))) { avail = 'none'; st.fb = null; }
    st.avail = avail;
    if (playable && avail !== 'none' && !st.noPlay) {
      try {
        const run = animator.start(st.kind, st.id, { attacker: battlerInfo(st.a), target: battlerInfo(st.d), isDouble: false, args: (st.args || []).slice(), animArg: st.animArg | 0, terrain: opts.env | 0, bystander: selfRun ? (({ species, shiny, female }) => ({ species, shiny, female }))(battlerInfo(st.a ^ 1)) : undefined, seed: animMix(A.seed, ++A.n), turn: st.turn | 0 });
        if (run && typeof run.step === 'function') {
          st.run = run; A.step = st; A.played++;
          if (typeof run.on === 'function') {
            run.on('sound', (ev) => { A.sounds++; if (!A.mute && hooks.onSound && ev) hooks.onSound(ev.index, ev.pan); });
            run.on('cry', (ev) => { A.cries++; if (!A.mute && hooks.onCry && ev) hooks.onCry(ev.species, ev.pan); });          // a Pokemon cry the script starts (Growl, Roar...): the page plays it
          }
          return;
        }
      } catch (e) { A.log.push('start() threw for ' + st.kind + ':' + st.id + ': ' + String(e && e.message ? e.message : e).slice(0, 80)); }
      avail = 'none';
    }
    // nothing plays: what the pre-animation scene did (a lunge), unless the move was rejected before it could animate and an animation does exist
    if (st.fb === 'lunge' && (avail === 'none' || avail === 'fallback' || !cfg || !animator)) { st.t = 'lunge'; st.side = st.a; st.n = 0; }
  }
  function endMoveAnim(st) {
    if (st.run && st.kind === 'special' && (st.id === SPECIAL.SWITCH_OUT_PLAYER_MON || st.id === SPECIAL.SWITCH_OUT_OPPONENT_MON)) A.recalled = st.a;
    if (st.run && st.run.error) A.log.push('run error ' + st.kind + ':' + st.id + ': ' + String(st.run.error && st.run.error.message ? st.run.error.message : st.run.error).slice(0, 80));
    st.run = null; if (A.step === st) A.step = null;
  }
  function startMonFx(side) {
    const cfg = animCfg(), d = S.disp[side];
    if (!cfg || !d) { A.mon[side] = null; return; }
    const info = speciesAnim(d.species);
    const len = info && info.frames > 1 ? info.delay + info.duration : 0;
    A.mon[side] = len > 0 ? { t: 0, info, len } : null;
    if (A.mon[side] && side !== viewSide) d.frame = frontFrameAt(info, 0);
  }
  function monFxTick() {
    for (let s = 0; s < 2; s++) {
      const m = A.mon[s], d = S.disp[s];
      if (!m) continue;
      if (!d) { A.mon[s] = null; continue; }
      m.t++;
      d.frame = s === viewSide ? 0 : frontFrameAt(m.info, m.t);                 // the foe shows its front picture; the player's back picture has one frame
      if (m.t > m.len) { d.frame = 0; A.mon[s] = null; }
    }
  }

  // AN1: the send-out. The player's ball is thrown along a parabola from the trainer's side, the foe's appears at its spot; the ball opens, then the Pokemon
  // grows out of a white silhouette and its healthbox slides in. The ball sprite is the ROM's (anim_mon.js ballGfx); the path, the spin and the frame counts are
  // CHOSEN BY EYE (the ROM's own throw is native code that is not run here).
  const BALL_ARC = 24, BALL_OPEN = 8, BALL_GROW = 16;
  function ballAvailable() { if (A.ballOk === null) { try { A.ballOk = !!ballGfx(ui.rom, 1); } catch (_e) { A.ballOk = false; } } return A.ballOk; }
  function runBallRelease(st, d) {
    const side = st.side, arc = side === viewSide ? BALL_ARC : 0, total = arc + BALL_OPEN + BALL_GROW;
    const n = ++st.n, c = battlerInfo(side);
    if (n <= arc) {
      const u = n / arc, sx = 20, sy = 104;
      A.balls[side] = { x: sx + (c.x - sx) * u, y: sy + (c.y - sy) * u - 4 * 40 * u * (1 - u), frame: 0, rot: u * Math.PI * 4, ball: 1 };
    } else if (n <= arc + BALL_OPEN) {
      A.balls[side] = { x: c.x, y: c.y, frame: n - arc >= 3 ? 1 : 0, rot: 0, ball: 1 };
    } else {
      const g = n - arc - BALL_OPEN, u = g / BALL_GROW;
      A.balls[side] = null;
      if (g === 1) { d.visible = true; if (hooks.onSendOut) hooks.onSendOut(side, st.mon.species, st.mon); }
      d.scale = 0.25 + 0.75 * u; d.tint = Math.round(16 * (1 - u)); d.boxDx = Math.round(-sgn(side) * 140 * (1 - u));
    }
    if (n >= total) { d.scale = undefined; d.tint = 0; d.boxDx = 0; d.visible = true; A.balls[side] = null; startMonFx(side); return true; }
    return false;
  }

  /* ---- AN1 round 3: the battle's SYSTEM animations (animator.start('system', id, ctx); anim_sys.js, ANIM.md "Round 3") ---- */
  const sysOn = (id) => !!animCfg() && sysPlayable(animator, id);
  const SYS_MAX = 3000, KEY_A = 1;
  const expOf = (sp, lv) => { const g = pack.species[sp] && pack.species[sp].growthRate, row = pack.exp && pack.exp[g]; return row && row[lv] !== undefined ? row[lv] : 0; };
  const pspec = (m, o) => partySpec(m, o, expOf);
  // round 4: the foe trainer's ROM picture follows the CPU level (opts.cpuLevel, opts.trainerChoices from anim_sys.js trainerChoices(rom)) and is the same for the whole battle; the player's back sprite follows opts.playerGender
  let trainerMemo;
  const trainerId = () => (trainerMemo !== undefined ? trainerMemo : (trainerMemo = pickTrainer(opts.trainerChoices, opts.cpuLevel, A.seed)));
  const SYS_KIND = { shake: 'hit', faint: 'faint', slidein: 'sendout', slideout: 'recall' };         // scene step -> system event
  const monCopy = (d) => (d ? { species: d.species, name: d.name, level: d.level, gender: d.gender, hp: d.hp, maxHp: d.maxHp, status: d.status, shiny: d.shiny } : null);
  function wireSys(run) {
    if (typeof run.on !== 'function') return;
    run.on('sound', (ev) => { A.sounds++; if (!A.mute && hooks.onSound && ev) hooks.onSound(ev.index, ev.pan); });
    run.on('cry', (ev) => { A.cries++; if (!A.mute && hooks.onCry && ev) hooks.onCry(ev.species, ev.pan); });
  }
  // ---- round 4: a system run is PREPARED in slices (ANIM.md "Round 4") ----
  // animator.prepare('system', id, ctx) plays the ROM's hidden pre-roll (100-250 ms of ROM code) in SLICE_MS slices, ONE slice a scene tick (pumpSys), while the previous picture plays; begin() hands over the run
  // when the step before it is done and the handle is ready (the same frames as start(), bit for bit). Not ready yet = the step HOLDS the previous picture and the scene keeps ticking (A.waited counts those ticks).
  // The animator has a pool of three engines: the run that plays, the NEXT event (prepared as soon as it is foreseeable: prepareSys) and the battle-state prewarm. An animator without prepare() falls back to start().
  const SLICE_MS = 3, FRAME_MS = 16.7, RENDER_MS = 4;
  A.pend = []; A.waited = 0; A.stepMs = 0;
  // a heavy ROM move animation can take 10-13 ms a frame on its own: the slice is what is left of the frame (after the previous tick's steps and the render), between 0.5 and SLICE_MS ms
  const sliceBudget = () => (opts.clock ? Math.max(0.5, Math.min(SLICE_MS, FRAME_MS - RENDER_MS - A.stepMs)) : SLICE_MS);
  const sysSeed = () => animMix(A.seed, 0x5eed);         // ONE seed for the hidden pre-roll of every event of a battle, so events that start from the same parties share the engine's pre-roll cache
  const isReady = (P) => { if (!P.ready && P.h && P.h.ready) P.ready = true; return P.ready; };
  const unpend = (P) => { A.pend = A.pend.filter((x) => x !== P); };
  // THE PREWARM IS THE FIRST TO GO. startSysIntro hands the opening's battle state to a 'battle' handle that holds an engine until its pre-roll is done, and pumpSys serves the events before it, so on a slow
  // machine it can still be pending when the first events are being prepared. The pool of three then holds the run that plays or waits, two prepared events and the prewarm: four, and the prepare of the third
  // event throws "the system engine pool is exhausted" -- that effect was then not prepared ahead and started late (reproduced with the real animator on the deterministic clock, seeds 2-5 with the player
  // switching on purpose, on the committed HEAD scene too; ANIM.md "Round 8"). The prewarm only fills the battle-state cache, which the first event's own pre-roll fills as well, so it is the one to give up:
  // a prepare that throws "pool is exhausted" while one is pending disposes it and prepares again once (a second throw is the caller's, and is logged). Every other prepare, and every other fault, is untouched. Noted in animInfo().notes / .shed, not logged.
  function prepareHandle(id, ctx, warm) {
    try { return animator.prepare('system', id, ctx); } catch (e) {
      const w = warm ? null : A.pend.find((x) => x.warm);
      if (!w || !/pool is exhausted/.test(String(e && e.message))) throw e;           // only THIS fault: any other throw would leak a second engine slot if the prepare ran again (battle_sys.js SystemRun does not release its slot when its constructor throws)
      dropPrep(w); A.shed = (A.shed | 0) + 1; A.notes.push('system ' + id + ' prepare() threw (' + String(e && e.message ? e.message : e).slice(0, 60) + '): the prewarm was given up and it was prepared again');
      return animator.prepare('system', id, ctx);
    }
  }
  function newPrep(id, ctx, warm) {
    const P = { id, h: null, run: null, ready: false, failed: false, warm: !!warm };
    try {
      if (typeof animator.prepare === 'function') { P.h = prepareHandle(id, ctx, warm); A.pend.push(P); }
      else if (warm) return null;
      else { P.run = animator.start('system', id, ctx); P.ready = true; }
    } catch (e) { A.log.push('system ' + id + ' prepare() threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); return null; }
    return P;
  }
  function dropPrep(P) { if (!P) return; unpend(P); if (P.h && !P.begun && !P.failed) { try { P.h.dispose(); } catch (_e) { /* ignore */ } } P.failed = true; P.ready = false; }
  // one slice for the oldest unfinished handle (events before the prewarm), once per tick
  function pumpSys() {
    if (!A.pend.length) return;
    const P = A.pend.find((x) => !x.warm) || A.pend[0];
    try { P.h.advance(sliceBudget()); P.ready = !!P.h.ready; } catch (e) { P.failed = true; A.log.push('system ' + P.id + ' advance() threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); unpend(P); return; }
    if (P.ready) unpend(P);
  }
  // the context of one mid-battle event (ids 2..9), built from what the scene shows NOW (HP, status, shininess, nicknames) so the first frame is the scene's own picture
  // THE STALE-PICTURE DEFECT (reported: "when pokemon get hit or faint, or after they switch out and the new pokemon gets hit, it shows the old pokemon briefly, and the health bars go wrong"). Every event is
  // PREPARED AHEAD (prepareSys), while the steps before it are still to play; the scene's displayed Pokemon (S.disp) changes only when a send-out / recall / faint EFFECT FINISHES (finishSysEvent), and a recall
  // leaves the slot empty with the recalled Pokemon in A.lastMon. So an effect prepared behind a switch was built from the OLD Pokemon (its species, its HP bar), and then played, as prepared, for the NEW one:
  // Quilava's picture and a full bar for the whole blink of Jirachi's hit (reproduced frame by frame, see ANIM.md "Round 7"). A drain does not wait for its end either: runStep 'drain' writes d.hp on EVERY frame
  // of the bar (hpBarStep), so an effect prepared while a bar is moving is seeded with a MID-DRAIN value, which is neither the old bar nor the new one. Two fixes, both needed:
  //  1. eventCtx is given the display state PROJECTED through the steps ahead of the event (proj, built by projectStep as prepareSys walks the queue): the Pokemon that WILL be there, with a drain's END value.
  //     It is used for every Pokemon the effect DRAWS (drawsLead): both sides of a hit, a faint and a recall, and the OTHER side of a send-out. The side that SENDS OUT is the Pokemon being replaced and no frame of
  //     the effect shows it (every frame of a send-out is identical for any HP or species of it, ANIM.md "Round 7b"), so that one keeps the plain read of the display the effect was measured with.
  //  2. sysEventStart re-checks a prepared effect against what is on screen NOW (ctxSig, over the same Pokemon) and prepares it again if they differ (a drain that finished meanwhile, a case nobody foresaw): a
  //     late picture is a brief hold of the previous one (A.waited), a wrong picture is the defect.
  const drawsLead = (kind) => kind !== 'sendout';
  const ctxSig = (ctx, kind, st) => JSON.stringify(drawsLead(kind) ? [ctx.foe, ctx.player] : (st.side === viewSide ? [ctx.foe, null] : [null, ctx.player]));
  // what differs between two signatures, for the diagnostics: 'player.hp 175->40'
  const sigDiff = (a, b) => { try { const x = JSON.parse(a), y = JSON.parse(b), out = []; ['foe', 'player'].forEach((k, i) => { const m = x[i] || {}, n = y[i] || {}; for (const f of new Set([...Object.keys(m), ...Object.keys(n)])) if (JSON.stringify(m[f]) !== JSON.stringify(n[f])) out.push(k + '.' + f + ' ' + JSON.stringify(m[f]) + '->' + JSON.stringify(n[f])); }); return out.slice(0, 4).join(', '); } catch (_e) { return ''; } };
  // what a step does to the Pokemon on screen, applied to proj = [side 0, side 1] (undefined = whatever S.disp shows; null = nobody; else a Pokemon record)
  function projectStep(proj, step) {
    if (!step) return;
    const t = step.t === 'sysevent' ? step.orig : step.t, k = step.t === 'sysevent' ? step.kind : null;
    if (t === 'slidein' || k === 'sendout') proj[step.side] = step.mon;
    else if (t === 'slideout' || k === 'recall') proj[step.side] = null;
    else if (t === 'drain') {                      // an HP bar that is draining (or filling) ends at st.to, but S.disp[side].hp is the bar's value THIS FRAME (runStep 'drain' sets it every frame): read mid-drain it is neither the old
      const base = proj[step.side] !== undefined ? proj[step.side] : (S.disp[step.side] || A.lastMon[step.side]);       // bar nor the new one, and a picture seeded with it shows a bar that went back up for the length of the effect (the second half of the defect)
      if (base && Number.isInteger(step.to)) proj[step.side] = Object.assign({}, base, { hp: step.to });
    }
  }
  function eventCtx(st, kind, id, proj) {
    const mine = st.side === viewSide, other = st.side ^ 1;
    const cur = (side) => { const pm = proj && (side !== st.side || drawsLead(kind)) ? proj[side] : undefined; return pm || S.disp[side] || A.lastMon[side]; };
    const lead = cur(st.side) || (kind === 'sendout' ? st.mon : null), foeOther = cur(other);
    if (!lead || !foeOther) return null;
    const own = pspec(lead, kind === 'faint' ? { hp: 0 } : undefined), oth = pspec(foeOther);
    const ctx = { foe: mine ? oth : own, player: mine ? own : oth, environment: opts.env | 0, trainer: id >= 8 ? (trainerId() > 1 ? trainerId() : 1) : 0, seed: sysSeed(), maxFrames: SYS_MAX };         // ids 8 / 9 are the trainer's own; for 2..7 a WILD-style pre-roll keeps the foe's stored HP (a trainer-mode setup recomputes the foe's max HP and shifts its bar by 1-2 px, measured)
    if (kind === 'sendout') ctx.switchIn = pspec(st.mon);
    if (opts.playerGender === 'F' || opts.playerGender === 'M') ctx.gender = opts.playerGender;
    if (opts.sysClock) ctx.clock = opts.sysClock;
    return ctx;
  }
  const makeSysRun = (st, kind, id, proj) => { const ctx = eventCtx(st, kind, id, proj); const P = ctx ? newPrep(id, ctx, false) : null; if (P) P.sig = ctxSig(ctx, kind, st); return P; };
  // the NEXT system event of the queue gets its handle as soon as it is foreseeable (the queue is built when the engine's events arrive: a message, the move animation and the hit blink give it hundreds of ticks)
  function prepareSys() {
    if (!animator) return;
    if (!animCfg()) { for (const nx of S.queue) if (nx.prep) { dropPrep(nx.prep); nx.prep = undefined; } return; }
    let drain = false, ahead = 0;
    const proj = [undefined, undefined];                // what each side will show when the events being prepared play (see eventCtx)
    projectStep(proj, S.cur);                           // the step playing now may be a switch that has not finished
    for (let k = 0; k < Math.min(S.queue.length, 12); k++) {
      const nx = S.queue[k], kind = SYS_KIND[nx.t];
      if (kind) {
        if (nx.prep === undefined) {
          if (drain && kind !== 'faint') return;           // a bar drain before it changes the HP the picture must show (a faint is 0 anyway)
          const id = eventId(kind, nx.side, viewSide);
          nx.prep = sysOn(id) ? makeSysRun(nx, kind, id, proj) : null;
        }
        projectStep(proj, nx);
        if (nx.prep && ++ahead >= 2) return;               // the pool holds three engines: the playing run and two prepared ones
        continue;
      }
      if (nx.t === 'drain') { drain = true; projectStep(proj, nx); } else if (nx.t !== 'text' && nx.t !== 'moveanim' && nx.t !== 'pause') return;
    }
  }
  function beginSysRun(st) { A.step = st; A.played++; A.sysPlayed++; wireSys(st.run); }
  function sysEventStart(st, kind) {
    const id = eventId(kind, st.side, viewSide);
    let P = st.prep; st.prep = null;
    if (st.noSys || !sysOn(id)) { dropPrep(P); return false; }
    if (P && P.sig !== undefined) {         // prepared ahead from what was on screen THEN (or what would be): is it still what is on screen now?
      const fresh = eventCtx(st, kind, id), now = fresh && ctxSig(fresh, kind, st);
      if (fresh && now !== P.sig) { const why = sigDiff(P.sig, now); dropPrep(P); P = null; A.restale = (A.restale | 0) + 1; A.notes.push('system ' + id + ' stale: ' + why); }       // benign (a brief hold, never a wrong picture): counted and noted, NOT in A.log, which is the list of animation PROBLEMS
    }
    if (!P) P = makeSysRun(st, kind, id);
    if (!P) return false;
    st.orig = st.t; st.t = 'sysevent'; st.kind = kind; st.id = id; st.n = 0; st.P = P; st.run = null;
    if (P.run) { st.run = P.run; beginSysRun(st); }
    return true;
  }
  // the handle failed (prepare / advance / begin threw): the old step plays instead
  function sysEventFailed(st, e) {
    if (e) A.log.push('system ' + st.id + ' begin() threw: ' + String(e && e.message ? e.message : e).slice(0, 80));
    dropPrep(st.P); st.P = null; st.run = null; st.t = st.orig; st.noSys = true; st.restarted = true;
    startStep(st);
    return false;
  }
  function runSysEvent(st) {
    if (!st.run) {
      const P = st.P;
      if (!P || P.failed) return sysEventFailed(st, null);
      if (!isReady(P)) { A.waited++; return false; }           // the pre-roll is not finished: the previous picture stays, the scene keeps ticking
      try { st.run = P.h ? P.h.begin() : P.run; P.begun = true; } catch (e) { return sysEventFailed(st, e); }
      beginSysRun(st);
    }
    const r = st.run;
    try { r.step(); } catch (e) { A.log.push('system ' + st.id + ' step() threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); finishSysEvent(st); return true; }
    st.n++;
    if (r.done || st.n >= SYS_MAX) { if (!r.done) A.log.push('cut system ' + st.id + ' after ' + st.n + ' frames'); finishSysEvent(st); return true; }
    return false;
  }
  function finishSysEvent(st) {
    const side = st.side;
    if (A.step === st) A.step = null;
    if (st.run && st.run.error) A.log.push('system ' + st.id + ' run error: ' + String(st.run.error && st.run.error.message ? st.run.error.message : st.run.error).slice(0, 80));
    st.run = null; st.P = null;
    if (st.kind === 'faint') { const d = S.disp[side]; A.lastMon[side] = monCopy(d); if (d) { d.visible = false; d.showBox = false; } }
    else if (st.kind === 'sendout') { S.disp[side] = Object.assign({}, st.mon, { drop: 0, visible: true, showBox: true, dx: 0, dy: 0, tint: 0, boxDx: 0, frame: 0 }); A.mon[side] = null; }
    else if (st.kind === 'recall') { A.lastMon[side] = monCopy(S.disp[side]); S.disp[side] = null; }
  }
  // the battle's opening: one run; the scene's own messages are typed over it (the run draws without BG0), one per ROM message, and A is pressed for the ROM when each is read
  function startSysIntro(st) {
    st.n = 0; st.msg = 0; st.tw = null; st.hold = 0; st.waitN = 0; st.shown = null; st.keyLeft = 0; st.msgQ = []; st.kind = 'system'; st.id = SYS.introTrainer; st.run = null; st.P = null;
    if (sysOn(SYS.introTrainer)) {
      const ctx = Object.assign({ foe: pspec(st.foe), player: pspec(st.player), environment: opts.env | 0, keys: null, seed: animMix(A.seed, ++A.n), maxFrames: SYS_MAX }, trainerId() > 1 ? { trainer: trainerId() } : {}, opts.playerGender === 'F' || opts.playerGender === 'M' ? { gender: opts.playerGender } : {}, opts.sysClock ? { clock: opts.sysClock } : {});
      st.P = newPrep(SYS.introTrainer, ctx, false);
      if (st.P) {
        if (st.P.run) beginIntro(st, st.P.run);
        // the first events of the battle start from these two Pokemon at full HP: pre-roll that state while the opening plays (same ctx as the events, so the first hit of turn 1 finds it cached)
        const wctx = { foe: pspec(st.foe), player: pspec(st.player), environment: opts.env | 0, trainer: 0, seed: sysSeed(), maxFrames: SYS_MAX };
        if (opts.playerGender === 'F' || opts.playerGender === 'M') wctx.gender = opts.playerGender;
        if (opts.sysClock) wctx.clock = opts.sysClock;
        newPrep('battle', wctx, true);
        return;
      }
    }
    S.queue.unshift(...st.fallback); st.t = 'pause'; st.n = -1;                      // the old steps instead; this step is a zero-length pause
  }
  function beginIntro(st, run) {
    st.run = run; A.step = st; A.played++; A.sysPlayed++; wireSys(run);
    if (typeof run.on === 'function') run.on('message', (m) => { if (m && st.msg + st.msgQ.length < st.texts.length) st.msgQ.push(m); });
  }
  function runSysIntro(st) {
    if (!st.run) {                                                                   // the opening is still being prepared: the picture stays, the scene keeps ticking
      const P = st.P;
      if (!P || P.failed) { dropPrep(P); S.queue.unshift(...st.fallback); return true; }
      if (!isReady(P)) { A.waited++; return false; }
      let run = null; try { run = P.h ? P.h.begin() : P.run; P.begun = true; } catch (e) { A.log.push('system intro begin() threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); dropPrep(P); S.queue.unshift(...st.fallback); return true; }
      beginIntro(st, run);
    }
    const r = st.run;
    const firstOfTick = st.tickId !== S.tick;
    // BATTLE SPEED steps the ROM several times per frame, but never through the scene's typed message: while a message is being typed / read the ROM only waits at its {FB}, so those frames stay 1 per tick
    if (!firstOfTick && (st.tw || st.msgQ.length)) return false;
    if (firstOfTick) {                                                               // text and keys advance once per frame; the ROM may step several times (BATTLE SPEED)
      st.tickId = S.tick;
      if (st.keyLeft > 0 && --st.keyLeft === 0) r.setKeys(0);
      if (!st.tw && st.msgQ.length) {
        st.msgQ.shift();
        const text = st.texts[st.msg++];
        st.tw = createTypewriter({ text: safeMsg(text), measure: (x) => ui.measure('normal', x), maxWidth: R.msg.w - 4, delay });
        st.hold = 0; st.waitN = 0; st.shown = null;
      }
      if (st.tw) {
        const tw = st.tw, fast = S.held.a || S.held.b;
        if (!tw.done && !tw.waiting) tw.tick(fast);
        else if (tw.waiting) { if (++st.waitN >= PAGE_AUTO || fast) { tw.next(); st.waitN = 0; } }
        else if (++st.hold >= MSG_HOLD || (fast && st.hold >= 6)) { st.shown = tw.lines(); st.tw = null; r.setKeys(KEY_A); st.keyLeft = 3; }       // read: A for the ROM's wait
      }
    }
    try { r.step(); } catch (e) { A.log.push('system intro step() threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); finishSysIntro(st); return true; }
    st.n++;
    if (r.ready || r.done || st.n >= SYS_MAX) { if (!(r.ready || r.done)) A.log.push('cut system intro after ' + st.n + ' frames'); finishSysIntro(st); return true; }
    return false;
  }
  function finishSysIntro(st) {
    const r = st.run;
    if (r && typeof r.setKeys === 'function') { try { r.setKeys(0); } catch (_e) { /* ignore */ } }
    if (r && r.error) A.log.push('system intro run error: ' + String(r.error && r.error.message ? r.error.message : r.error).slice(0, 80));
    if (st.tw) { st.shown = st.tw.lines(); st.tw = null; }
    S.lastBox = { mode: 'message', text: st.shown || ['', ''], arrow: false };
    for (const [side, mon] of [[foeSide, st.foe], [viewSide, st.player]]) { S.disp[side] = Object.assign({}, mon, { drop: 0, visible: true, showBox: true, dx: 0, dy: 0, tint: 0, boxDx: 0, frame: 0 }); A.mon[side] = null; }
    if (A.step === st) A.step = null;
    st.run = null;
  }

  function startStep(st) {
    switch (st.t) {
      case 'sysintro': startSysIntro(st); break;
      case 'moveanim': startMoveAnim(st); break;
      case 'text': {
        st.tw = createTypewriter({ text: safeMsg(st.text), measure: (s) => ui.measure('normal', s), maxWidth: R.msg.w - 4, delay });
        st.hold = 0; st.waitN = 0;
        break;
      }
      case 'pause': st.n = st.n | 0; break;
      case 'drain': {
        const d = S.disp[st.side];
        st.max = st.max || (d ? d.maxHp : 1);
        st.bar = ui.hpBarInit(st.max, d ? d.hp : st.to, st.to);       // FA1: the ROM's MoveBattleBar / CalcNewBarValue (maxHP/24 HP a frame, fixed point under 48)
        break;
      }
      case 'shake': st.n = 0; if (hooks.onHit && !st.restarted) hooks.onHit(st.side, { eff: st.eff, crit: st.crit }); sysEventStart(st, 'hit'); break;
      case 'lunge': st.n = 0; break;
      case 'slidein': {
        if (sysEventStart(st, 'sendout')) break;                      // AN1 round 3: the ROM's own send-out (ball throw, silhouette, cry, motion, healthbox slide)
        const d = Object.assign({}, st.mon, { drop: 0, visible: true, showBox: true, dx: 0, dy: 0, tint: 16, boxDx: 0, frame: 0 });
        S.disp[st.side] = d; st.n = 0;
        // AN1: with animations on, a Pokemon comes out of a ROM ball (ball art + palette from the ROM, arc and timings chosen by eye) instead of sliding in
        st.ball = !!animCfg() && ballAvailable();
        if (st.ball) { d.visible = false; d.boxDx = Math.round(-sgn(st.side) * 140); }
        else if (hooks.onSendOut) hooks.onSendOut(st.side, st.mon.species, st.mon);
        break;
      }
      case 'slideout': if (sysEventStart(st, 'recall')) break; st.n = A.recalled === st.side ? SLIDE_FRAMES - 1 : 0; A.recalled = -1; break;      // AN1: the animator's recall already took the Pokemon off the screen
      case 'faint': st.n = 0; if (hooks.onFaint && !st.restarted) hooks.onFaint(st.side, S.disp[st.side] ? S.disp[st.side].species : 0); sysEventStart(st, 'faint'); break;
      case 'end': S.ended = true; break;
      default: break;
    }
  }

  const sgn = (side) => (side === viewSide ? -1 : 1);       // the player's mon enters from the left, the foe's from the right
  // returns true when the step is finished
  function runStep(st) {
    switch (st.t) {
      case 'text': {
        const tw = st.tw, fast = S.held.a || S.held.b;
        if (!tw.done && !tw.waiting) tw.tick(fast);
        else if (tw.waiting) { if (++st.waitN >= PAGE_AUTO || fast) { tw.next(); st.waitN = 0; } }
        else if (++st.hold >= MSG_HOLD || (fast && st.hold >= 6)) { S.lastBox = { mode: 'message', text: tw.lines(), arrow: false }; return true; }
        return false;
      }
      case 'pause': return --st.n < 0;
      case 'call': st.fn(); return true;
      case 'set': st.fn(); return true;
      case 'drain': {
        const d = S.disp[st.side];
        if (!d) return true;
        const v = ui.hpBarStep(st.bar);                                  // the HP the ROM prints this frame, or -1 once the bar has arrived
        d.maxHp = st.max || d.maxHp;
        if (v === -1) { d.hp = st.to; d.barCurr = undefined; d.barTarget = undefined; return true; }
        d.hp = v; d.barCurr = st.bar.curr; d.barTarget = st.bar.target;
        return false;
      }
      case 'shake': {
        const d = S.disp[st.side];
        if (!d) return true;
        st.n++;
        d.visible = !((st.n >> 1) & 1) || st.n >= BLINK_FRAMES;
        if (st.n >= BLINK_FRAMES) { d.visible = true; return true; }
        return false;
      }
      case 'lunge': {
        const d = S.disp[st.side];
        if (!d) return true;
        st.n++;
        const dir = st.side === viewSide ? 1 : -1;
        const k = st.n <= 4 ? st.n : 8 - st.n;
        d.dx = dir * 3 * clamp(k, 0, 4);
        if (st.n >= 8) { d.dx = 0; return true; }
        return false;
      }
      case 'slidein': {
        const d = S.disp[st.side];
        if (st.ball) return runBallRelease(st, d);
        st.n++;
        const t = Math.min(1, st.n / SLIDE_FRAMES);
        d.dx = Math.round(sgn(st.side) * 120 * (1 - t));
        d.boxDx = Math.round(-sgn(st.side) * 140 * (1 - t));
        d.tint = Math.round(16 * (1 - Math.max(0, (st.n - 6) / (SLIDE_FRAMES - 6))));
        if (st.n >= SLIDE_FRAMES) { d.dx = 0; d.boxDx = 0; d.tint = 0; startMonFx(st.side); return true; }
        return false;
      }
      case 'sysintro': return runSysIntro(st);
      case 'sysevent': return runSysEvent(st);
      case 'moveanim': {
        const r = st.run;
        if (!r) return true;
        const cfg = animCfg();
        try {
          if (cfg && cfg.skip && (A.skipReq || S.held.a || S.held.b)) {            // press-to-skip is opt-in (`?animskip=1`); by default a press does nothing here
            A.mute = true; let g = 0; while (!r.done && g++ < MAX_SKIP_FRAMES) r.step(); A.mute = false; A.skipReq = false; A.skipped++;
          } else { r.step(); }
        } catch (e) { A.mute = false; A.log.push('step() threw for ' + st.kind + ':' + st.id + ': ' + String(e && e.message ? e.message : e).slice(0, 80)); endMoveAnim(st); return true; }
        st.n++;
        if (r.done || st.n >= MAX_ANIM_FRAMES) { if (!r.done) A.log.push('cut ' + st.kind + ':' + st.id + ' after ' + st.n + ' frames'); endMoveAnim(st); return true; }
        return false;
      }
      case 'slideout': {
        const d = S.disp[st.side];
        if (!d) return true;
        st.n++;
        const t = Math.min(1, st.n / SLIDE_FRAMES);
        d.tint = Math.min(16, Math.round(16 * t * 2));
        d.dx = Math.round(sgn(st.side) * 120 * t);
        d.boxDx = Math.round(-sgn(st.side) * 140 * t);
        if (st.n >= SLIDE_FRAMES) { S.disp[st.side] = null; return true; }
        return false;
      }
      case 'faint': {
        const d = S.disp[st.side];
        if (!d) return true;
        d.drop += 4; st.n++;
        if (d.drop >= 64) { d.visible = false; d.showBox = false; return true; }
        return false;
      }
      case 'end': return true;
      default: return true;
    }
  }

  /* ------------------------------------------------------------------------------------------ mode logic */
  function pendingReq() { return ctl.pending(viewSide); }

  function buildPartyMons(req) {
    const v = ctl.view(viewSide);
    const origs = ctl.origOf ? ctl.origOf(viewSide) : [];
    return v.you.team.map((m) => {
      const mm = (meta[viewSide] || [])[origs[m.slot]] || {};
      let gender = mm.gender === undefined ? null : mm.gender;
      if (mm.gender === undefined) { const r = pack.species[m.sp].genderRatio; gender = r === 255 ? null : r === 0 ? 'M' : r === 254 ? 'F' : null; }
      return { slot: m.slot, species: m.sp, name: m.name, level: m.level, hp: m.hp, maxHp: m.max, status: ST_LABEL[m.st] || null, fainted: m.hp <= 0, gender, shiny: !!mm.shiny, active: m.slot === v.you.active, ...(req && req.reason === 'revive' ? { revivable: Array.isArray(req.switches) && req.switches.some((x) => x.slot === m.slot) } : {}) };
    });
  }

  function enterAction(req) {
    S.mode = 'action'; S.overlay = null; S.cursor = 0; S.moveCursor = 0; S.req = req;
  }
  function enterParty(req, forced) {
    const mons = buildPartyMons(req);
    const revive = !!req && req.reason === 'revive';
    const first = mons.findIndex((m) => (revive ? m.revivable : !m.fainted && !m.active));
    S.party = { mons, forced, req, revive, cursor: first >= 0 ? first : 0 };
    S.mode = 'party'; S.overlay = null; S.req = req; S.partyCancelSel = false;
  }
  function enterPreview(req) {
    const origs = req.team.map((t) => t.slot);
    const mine = req.team.map((t) => {
      const mm = (meta[viewSide] || [])[t.slot] || {};
      const r = pack.species[t.sp].genderRatio;
      const gender = mm.gender === undefined ? (r === 255 ? null : r === 0 ? 'M' : r === 254 ? 'F' : null) : mm.gender;
      return { slot: t.slot, species: t.sp, name: t.name, level: t.level, gender, shiny: !!mm.shiny };
    });
    const foe = (ctl.previewInfo[foeSide] || []).map((f) => ({ species: f.sp, name: speciesName(f.sp), level: f.level, gender: null, shiny: false }));
    void origs;
    S.preview = { req, pick: req.pick, mine, foe, picks: [], cursor: 0, confirming: false };
    S.mode = 'preview'; S.overlay = null; S.req = req;
  }
  function startResult() {
    const w = ctl.winner;
    const v = ctl.view(viewSide);
    const youWon = w === viewSide;
    const key = w === -1 ? 'result.draw' : youWon ? 'result.win' : 'result.lose';
    const head = msg(key, roles(viewSide)).replace(/\\p/g, ' ');
    const mine = v.you.team.map((m) => ({ species: m.sp, fainted: m.hp <= 0, shiny: false, name: m.name }));
    const foe = v.foe.team.map((m) => (m.hidden ? { species: (ctl.battle.s.sides[foeSide].team[m.slot] || {}).sp || 1, fainted: !!m.fnt, hidden: true } : { species: m.sp, fainted: m.fnt === 1 || (m.hpPct === 0), shiny: false }));
    // H1 integration: the page may name the result buttons (1-3 short strings; battle_boot.js passes REMATCH / EDIT TEAM / BACK TO HUB); anything else keeps the defaults
    const named = opts.resultOptions;
    const options = Array.isArray(named) && named.length >= 1 && named.length <= 3 && named.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 14) ? named.slice() : RESULT_OPTIONS.slice();
    S.result = { head: head.split('\n').slice(0, 2), mine, foe, cursor: 0, winner: w, options, since: S.tick, recap: false, summary: null };
    // ST1: the match recap. The summary is a pure fold of the engine's whole event log (match_stats.js), so a battle that was replayed after a reload gives the same one.
    // opts.recap === false keeps the plain three-button result screen (the scene tests that pin it); hooks.onMatchEnd(info) hears the finished match once (the page writes the career).
    if (opts.recap !== false) {
      try {
        const teams = [0, 1].map((sd) => ctl.battle.s.sides[sd].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
        S.result.summary = summarizeMatch(ctl.battle.events, { viewSide, teams });
        S.result.recap = true;
      } catch (_e) { S.result.summary = null; S.result.recap = false; }
    }
    S.mode = 'result'; S.overlay = null;
    if (!S.matchEnded) {
      S.matchEnded = true;
      S.career = S.result.summary && typeof hooks.onMatchEnd === 'function' ? { state: 'pending' } : null; S.careerVer++;
      if (S.result.summary && typeof hooks.onMatchEnd === 'function') { try { hooks.onMatchEnd({ summary: S.result.summary, ticks: S.tick, winner: w }); } catch (_e) { /* the page's recorder must not stop the result screen */ } }
    }
  }

  // called when the queue is empty and nothing is running
  function idle() {
    if (S.resume) { const r = S.resume; S.resume = null; S.mode = r.mode; if (r.fn) r.fn(); return; }
    if (S.ended) { if (S.mode !== 'result' && S.mode !== 'recap') startResult(); return; }
    // events that arrived while the scene was busy
    const ev = ctl.takeEvents();
    if (ev.length) { director(ev); S.mode = 'steps'; return; }
    if (S.mode === 'confirm' || S.mode === 'menu') return;                // an overlay is open: leave the menus alone
    const req = pendingReq();
    if (S.auto && req && (req.phase === 'preview' || req.phase === 'move' || req.phase === 'switch')) { const c = S.auto.decide(req); if (c) { submit(c); return; } }
    if (!req) { if (ctl.winner !== null) { S.ended = true; return; } if (S.mode !== 'wait') S.mode = 'wait'; return; }
    if (req.phase === 'preview') { if (S.mode !== 'preview') enterPreview(req); }
    else if (req.phase === 'move') { if (S.mode !== 'action' && S.mode !== 'moves' && S.mode !== 'party') enterAction(req); else S.req = req; }
    else if (req.phase === 'switch') { if (S.mode !== 'party') enterParty(req, true); }
  }

  // AN1: BATTLE SPEED 2x / 4x runs every step except a typed message that many times per frame; with animations off the speed is not applied
  const stepReps = (st) => { const c = animCfg(); return !c || !(c.speed >= 2) || st.t === 'text' ? 1 : c.speed; };
  function tick() {
    S.tick++;
    if (animator) { prepareSys(); pumpSys(); }                                       // round 4: the next system run is prepared, one slice a tick, whatever BATTLE SPEED is
    { const c = animCfg(); if (c) { for (let k = 0; k < (c.speed >= 2 ? c.speed : 1); k++) monFxTick(); } else if (A.mon[0] || A.mon[1]) { for (let s = 0; s < 2; s++) { if (S.disp[s]) S.disp[s].frame = 0; A.mon[s] = null; } } }
    if (S.mode === 'steps' || S.mode === 'wait' || S.cur || S.queue.length) {
      const ts = opts.clock ? opts.clock() : 0;
      let guard = 0;
      while (guard++ < 64) {
        if (!S.cur) {
          if (!S.queue.length) { idleTick(); break; }
          S.cur = S.queue.shift(); startStep(S.cur);
          S.mode = 'steps';
        }
        let done = runStep(S.cur);
        for (let k = 1, reps = stepReps(S.cur); k < reps && !done; k++) done = runStep(S.cur);
        if (done) { S.cur = null; continue; }
        break;
      }
      if (opts.clock) A.stepMs = opts.clock() - ts;
    } else { A.stepMs = 0; idleTick(); }
  }
  function idleTick() { idle(); }

  /* ------------------------------------------------------------------------------------------- submitting */
  function flash(str, resumeMode) {
    // a one-off message from a menu, then back to where the player was
    S.resume = { mode: resumeMode };
    S.mode = 'steps';
    qText(safeMsgOr(str));
  }
  const safeMsgOr = (s) => s;

  function submit(choice) {
    const r = ctl.submit(viewSide, choice);
    if (!r.ok) { flash(rawMsg('submit.' + r.code, 'That choice is not allowed (' + r.code + ').'), S.mode); return r; }
    S.overlay = null; S.mode = 'steps'; S.party = null; S.preview = null;
    return r;
  }

  const moveRows = () => {
    const req = S.req;
    return (req && req.moves ? req.moves : []).map((m) => {
      const mv = pack.moves[m.id];
      return { slot: m.slot, id: m.id, name: mv ? mv.name : '?', pp: m.pp, maxPp: m.max, type: mv ? mv.type : 0, disabled: m.disabled, reason: m.reason };
    });
  };

  function chooseMove(i) {
    const rows = moveRows(), m = rows[i];
    if (!m) return;
    if (m.disabled) {
      const mine = S.P[viewSide].name;
      const r = roles(viewSide, { move: m.name, item: itemName(ctl.view(viewSide).you.team[ctl.view(viewSide).you.active].it) });
      const k = { 'no-pp': 'sel.nopp', disabled: 'cant.disabled', taunt: 'cant.taunt', encore: 'sel.encore', choice: 'sel.choice', 'assault-vest': 'sel.vest' }[m.reason];
      void mine;
      flash(k ? msg(k, r) : rawMsg('sel.' + m.reason, 'That move cannot be used.'), 'moves');
      return;
    }
    submit({ kind: 'move', slot: m.slot });
  }

  function chooseParty(i) {
    const p = S.party; if (!p) return;
    const m = p.mons[i]; if (!m) return;
    const r = roles(viewSide, { subj: m.name });
    if (p.revive) {                                            // Revival Blessing: only the fainted Pokemon the request lists can be chosen
      if (!m.revivable) { flash(rawMsg('party.notfainted', m.name + ' has not fainted.'), 'party'); return; }
      submit({ kind: 'switch', slot: m.slot }); return;
    }
    if (m.active) { flash(msg('party.already', r), 'party'); return; }
    if (m.fainted) { flash(msg('party.nofight', r), 'party'); return; }
    if (p.req.phase === 'move' && p.req.trapped) { flash(msg('party.trapped', roles(viewSide, { subj: S.P[viewSide].name })), 'party'); return; }
    submit({ kind: 'switch', slot: m.slot });
  }

  // `back` = the mode the player was in (a forfeit chosen from the pause menu can come from the team preview or from the waiting screen,
  // not only from the action menu); NO returns there. The default stays NO.
  function openConfirm(kind, back) {
    S.confirm = { kind, cursor: 1, back: back || 'action' };
    S.overlay = back === 'preview' ? { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 120, y: 60 } : { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 176 };
    S.mode = 'confirm';
  }
  function resolveConfirm(yes) {
    const c = S.confirm; S.confirm = null; S.overlay = null;
    if (!c) return;
    if (c.kind === 'forfeit') { if (yes) { S.mode = 'steps'; submit({ kind: 'forfeit' }); } else S.mode = c.back || 'action'; }
    else if (c.kind === 'team') {
      if (yes) submit({ kind: 'preview', order: S.preview.picks.map((i) => S.preview.mine[i].slot) });
      else { S.mode = 'preview'; if (S.preview) { S.preview.confirming = false; S.preview.picks = []; } }
    } else if (c.kind === 'quit') { if (yes) { S.quit = true; if (hooks.onQuit) hooks.onQuit(); } S.mode = c.back || 'action'; }
  }

  // W1: a page that can open the Controls panel passes hooks.onControls(done); the menu then lists CONTROLS (RESUME / CONTROLS / SOUND /
  // FORFEIT / <last row>) and opens again after the panel closes. opts.quitLabel names the last row ('BACK TO HUB' on the battle page; the
  // default stays QUIT, which the scene tests pin).
  const quitLabel = typeof opts.quitLabel === 'string' && opts.quitLabel.length > 0 && opts.quitLabel.length <= 14 ? opts.quitLabel : 'QUIT';
  const menuWide = typeof hooks.onControls === 'function' || quitLabel !== 'QUIT';
  function openMenu(cursorLabel) {
    if (S.mode === 'menu') return;
    const rows = ['RESUME'];
    if (typeof hooks.onControls === 'function') rows.push('CONTROLS');
    rows.push('SOUND: ' + (opts.sound && opts.sound.get() ? 'ON' : 'OFF'));
    const ac = animSettings();
    if (ac) rows.push('ANIMATION: ' + (ac.on ? 'ON' : 'OFF'), 'BATTLE SPEED: ' + ac.speed + 'X');                       // AN1
    if (!S.ended && ctl.winner === null && (S.mode === 'action' || S.mode === 'moves' || S.mode === 'party' || S.mode === 'wait' || S.mode === 'preview')) rows.push('FORFEIT');
    rows.push(quitLabel);
    const at = cursorLabel ? Math.max(0, rows.findIndex((r) => r.startsWith(cursorLabel))) : 0;
    S.menu = { rows, back: S.mode, cursor: at };
    S.overlay = ac ? { rows, cursor: at, w: 104, x: 132, y: 8 } : menuWide ? { rows, cursor: at, w: 88, x: 148, y: 20 } : { rows, cursor: at, w: 76, x: 160, y: 20 };
    S.mode = 'menu';
  }
  // AN1: the settings object, when the page gave one the menu can change ({ get, set })
  const animSettings = () => (opts.anim && typeof opts.anim.get === 'function' && typeof opts.anim.set === 'function' ? opts.anim.get() : null);
  function menuActivate(i) {
    const m = S.menu; if (!m) return;
    const label = m.rows[i];
    const back = m.back;
    const close = () => { S.menu = null; S.overlay = null; S.mode = back; };
    if (label === 'RESUME') close();
    else if (label === 'CONTROLS') {
      close();
      // the page shows the panel and calls done() when it closes; the menu comes back where it was, so Back from CONTROLS lands on CONTROLS
      hooks.onControls(() => { if (S.mode === back) openMenu('CONTROLS'); });
    }
    else if (label.startsWith('SOUND') && opts.sound && typeof opts.sound.open === 'function') { close(); opts.sound.open(() => { if (S.mode === back) openMenu('SOUND'); }); }       // MU3: a page that has the volume panel opens it (done() when it closes); the menu comes back where it was
    else if (label.startsWith('SOUND')) { if (opts.sound) opts.sound.set(!opts.sound.get()); close(); openMenu('SOUND'); S.menu.back = back; }
    else if (label.startsWith('ANIMATION')) { const c = animSettings(); if (c) opts.anim.set({ on: !c.on }); close(); openMenu('ANIMATION'); S.menu.back = back; }
    else if (label.startsWith('BATTLE SPEED')) { const c = animSettings(); if (c) opts.anim.set({ speed: c.speed === 1 ? 2 : c.speed === 2 ? 4 : 1 }); close(); openMenu('BATTLE SPEED'); S.menu.back = back; }
    else if (label === 'FORFEIT') { S.menu = null; S.overlay = null; S.mode = back; openConfirm('forfeit', back); }   // always asks (YES / NO), from the action menu, the team preview and the waiting screen alike
    else if (label === quitLabel) { S.menu = null; S.overlay = null; S.mode = back; if (S.ended || ctl.winner !== null) { if (hooks.onQuit) hooks.onQuit(); } else openQuitConfirm(back); }
  }
  function openQuitConfirm(back) { S.confirm = { kind: 'quit', cursor: 1, back }; S.overlay = back === 'preview' ? { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 120, y: 60 } : { rows: ['YES', 'NO'], cursor: 1, w: 48, x: 176 }; S.mode = 'confirm'; }

  /* ------------------------------------------------------------------------------------------- input */
  function press(a) {
    if (!ACTIONS.includes(a)) return false;
    const m = S.mode;
    if (a === 'start' && m !== 'confirm' && m !== 'result' && m !== 'menu' && m !== 'recap') { openMenu(); return true; }
    if (m === 'menu') return menuInput(a);
    if (m === 'steps' || m === 'wait') return stepsInput(a);
    if (m === 'action') return actionInput(a);
    if (m === 'moves') return movesInput(a);
    if (m === 'party') return partyInput(a);
    if (m === 'preview') return previewInput(a);
    if (m === 'confirm') return confirmInput(a);
    if (m === 'result') return resultInput(a);
    if (m === 'recap') return recapInput(a);
    return false;
  }

  function stepsInput(a) {
    const st = S.cur;
    if (a !== 'a' && a !== 'b') return false;
    if (st && st.t === 'text') {
      const tw = st.tw;
      if (tw.waiting) { tw.next(); st.waitN = 0; }
      else if (!tw.done) { while (!tw.done && !tw.waiting) tw.tick(true); }
      else st.hold = MSG_HOLD;
      return true;
    }
    if (st && st.t === 'moveanim') { const c = animCfg(); if (c && c.skip) { A.skipReq = true; return true; } }          // AN1: a press skips only when `skip` is on (it is off by default: the game does not skip)
    return false;
  }

  function actionInput(a) {
    if (a === 'left' || a === 'right') S.cursor ^= 1;
    else if (a === 'up' || a === 'down') S.cursor ^= 2;
    else if (a === 'a') actionActivate(S.cursor);
    else if (a === 'b') { S.cursor = 0; }
    return true;
  }
  function actionActivate(c) {
    S.cursor = c;
    const req = S.req;
    if (c === 0) {
      if (req && req.struggle) { submit({ kind: 'move', slot: req.moves[0].slot }); return; }
      S.mode = 'moves'; S.moveCursor = 0;
    } else if (c === 1) flash(msg('bag.no', roles(viewSide)), 'action');
    else if (c === 2) { enterParty(req, false); S.party.fromAction = true; }
    else openConfirm('forfeit');
  }

  function movesInput(a) {
    const n = moveRows().length || 1;
    if (a === 'left' || a === 'right') { const c = S.moveCursor ^ 1; if (c < n) S.moveCursor = c; }
    else if (a === 'up' || a === 'down') { const c = S.moveCursor ^ 2; if (c < n) S.moveCursor = c; }
    else if (a === 'a') chooseMove(S.moveCursor);
    else if (a === 'b') S.mode = 'action';
    else if (a === 'x' || a === 'select') {
      const m = moveRows()[S.moveCursor];
      const d = m && pack.moves[m.id] ? pack.moves[m.id].desc : '';
      if (d) { flash(d.replace(/\s+/g, ' '), 'moves'); }
    }
    return true;
  }

  function partyInput(a) {
    const p = S.party; if (!p) return false;
    const n = p.mons.length;
    if (a === 'up') { if (S.partyCancelSel) { S.partyCancelSel = false; p.cursor = n - 1; } else p.cursor = Math.max(0, p.cursor - 1); }
    else if (a === 'down') { if (p.cursor >= n - 1 && !p.forced) S.partyCancelSel = true; else p.cursor = Math.min(n - 1, p.cursor + 1); }
    else if (a === 'left' || a === 'right') { if (!p.forced) S.partyCancelSel = !S.partyCancelSel; }
    else if (a === 'a') { if (S.partyCancelSel) { leaveParty(); } else chooseParty(p.cursor); }
    else if (a === 'b') { if (!p.forced) leaveParty(); }
    return true;
  }
  function leaveParty() { S.party = null; S.partyCancelSel = false; S.mode = 'action'; }

  function previewInput(a) {
    const p = S.preview; if (!p) return false;
    const n = p.mine.length;
    if (a === 'up') p.cursor = Math.max(0, p.cursor - 1);
    else if (a === 'down') p.cursor = Math.min(n - 1, p.cursor + 1);
    else if (a === 'a') previewToggle(p.cursor);
    else if (a === 'b') { if (p.picks.length) p.picks.pop(); }
    return true;
  }
  function previewToggle(i) {
    const p = S.preview; if (!p) return;
    p.cursor = i;
    const k = p.picks.indexOf(i);
    if (k >= 0) { p.picks.splice(k, 1); return; }
    if (p.picks.length >= p.pick) { flash(msg('party.selected', roles(viewSide, { subj: p.mine[i].name })), 'preview'); return; }
    p.picks.push(i);
    if (p.picks.length === p.pick) { p.confirming = true; S.confirm = { kind: 'team', cursor: 0 }; S.overlay = { rows: ['YES', 'NO'], cursor: 0, w: 48, x: 120, y: 60 }; S.mode = 'confirm'; }
  }

  function confirmInput(a) {
    const c = S.confirm; if (!c) return false;
    if (a === 'up' || a === 'down') { c.cursor ^= 1; S.overlay.cursor = c.cursor; }
    else if (a === 'a') resolveConfirm(c.cursor === 0);
    else if (a === 'b') resolveConfirm(false);
    return true;
  }
  function menuInput(a) {
    const m = S.menu; if (!m) return false;
    const n = m.rows.length;
    if (a === 'up') { m.cursor = (m.cursor + n - 1) % n; S.overlay.cursor = m.cursor; }
    else if (a === 'down') { m.cursor = (m.cursor + 1) % n; S.overlay.cursor = m.cursor; }
    else if (a === 'a') menuActivate(m.cursor);
    else if (a === 'b' || a === 'start') { S.menu = null; S.overlay = null; S.mode = m.back; }
    return true;
  }
  function resultInput(a) {
    const r = S.result; if (!r) return false;
    // ST1: with the recap the cursor runs over RECAP (-1, the chip at the far left) and then the page's own options (0..n-1), round and round; without it over the options only, as before
    const n = r.options.length, lo = r.recap ? -1 : 0;
    if (a === 'left' || a === 'up') r.cursor = r.cursor - 1 < lo ? n - 1 : r.cursor - 1;
    else if (a === 'right' || a === 'down') r.cursor = r.cursor + 1 > n - 1 ? lo : r.cursor + 1;
    else if (a === 'a') chooseResult(r.cursor);
    return true;
  }
  const resultGuard = Number.isInteger(opts.resultGuard) && opts.resultGuard >= 0 ? opts.resultGuard : RESULT_GUARD_FRAMES;
  const resultArmed = () => !!S.result && S.tick - S.result.since >= resultGuard;
  function chooseResult(i) {
    const r = S.result; if (!r) return;
    if (i === -1 && !r.recap) return;
    r.cursor = i;
    if (!resultArmed()) return; // D1: the result screen has not been readable long enough yet: the choice is ignored
    if (i === -1) { openRecap(); return; }
    if (hooks.onResult) hooks.onResult(r.options[i], { winner: r.winner });
  }

  /* ---- ST1: the match recap pages. Keys: left / right (or up / down, L / R) turn the page, A turns it and, on the last page, goes back, B and Start go back. Pointer: PREV / NEXT / BACK, a click on the page = A. */
  let pagesCache = null;
  function recapPages() {
    const r = S.result;
    if (pagesCache && pagesCache.ver === S.careerVer && pagesCache.summary === r.summary) return pagesCache.pages;
    const pages = buildRecapPages(r.summary, { moveName, speciesName, career: S.career, mineLabel: playerName.toUpperCase(), foeLabel: trainer.toUpperCase() });
    pagesCache = { ver: S.careerVer, summary: r.summary, pages };
    return pages;
  }
  function openRecap() { if (!S.result || !S.result.recap) return; S.recap = { page: 0, hover: null }; S.mode = 'recap'; S.overlay = null; }
  function closeRecap() { S.recap = null; if (S.result) S.mode = 'result'; }
  function recapStep(d) { const rc = S.recap; if (!rc) return; const last = recapPages().length - 1; rc.page = clamp(rc.page + d, 0, last); }
  function recapInput(a) {
    const rc = S.recap; if (!rc) return false;
    const last = recapPages().length - 1;
    if (a === 'left' || a === 'up' || a === 'l') recapStep(-1);
    else if (a === 'right' || a === 'down' || a === 'r') recapStep(1);
    else if (a === 'a') { if (rc.page < last) recapStep(1); else closeRecap(); }
    else if (a === 'b' || a === 'start') closeRecap();
    return true;
  }

  function hold(a, b) { S.held.a = !!a; S.held.b = !!b; }

  /* ----------------------------------------------------------------------------------- pointer / hit tests */
  const actionCells = () => ui.actionCells();
  const moveCells = () => ui.moveCells();

  // what is under (x, y) in screen pixels right now: { kind, index } | null. The same regions drive hover and click.
  function hit(x, y) {
    const m = S.mode;
    if (S.overlay && (m === 'confirm' || m === 'menu')) {
      const g = ui.overlayRects(S.overlay);
      for (let i = 0; i < g.rows.length; i++) if (inRect(g.rows[i], x, y)) return { kind: 'overlay', index: i };
      return { kind: 'back', index: 0 };          // W1 fix A4: a tap beside an open menu / YES-NO box goes back (RESUME / NO): touch never depends on the on-screen pad
    }
    if (m === 'action') { const c = actionCells(); for (let i = 0; i < 4; i++) if (inRect(c[i], x, y)) return { kind: 'action', index: i }; return null; }
    if (m === 'moves') {
      const c = moveCells(), n = moveRows().length;
      for (let i = 0; i < Math.min(4, n); i++) if (inRect(c[i], x, y)) return { kind: 'move', index: i };
      if (inRect(ui.moveInfoRect(), x, y)) return { kind: 'info', index: 0 };          // W1 fix A5: a click on the PP / TYPE boxes reads the highlighted move's description (a mouse has no C / X key)
      return y < ui.R.mv[0].y ? { kind: 'back', index: 0 } : null;          // W1 fix A4: a tap on the picture above the move menu goes back to the action menu
    }
    if (m === 'party' && S.party) {
      const G = ui.GEOM.party, rows = ui.rowRects(G, S.party.mons.length);
      // the rows are contiguous bands: anything in the list column maps to the nearest row
      if (x >= G.x - 8) { for (let i = 0; i < rows.length; i++) if (y >= rows[i].y - 1 && y < rows[i].y + G.pitch - 1) return { kind: 'party', index: i }; }
      if (!S.party.forced && inRect(G.cancel, x, y)) return { kind: 'cancel', index: 0 };
      return null;
    }
    if (m === 'preview' && S.preview) {
      const G = ui.GEOM.preview.mine, rows = ui.rowRects(G, S.preview.mine.length);
      if (x < G.x + G.w + 4) for (let i = 0; i < rows.length; i++) if (y >= rows[i].y - 1 && y < rows[i].y + G.pitch - 1) return { kind: 'preview', index: i };
      return null;
    }
    if (m === 'recap' && S.recap) {
      for (const c of ui.GEOM.recap.chips) if (inRect({ x: c.x - 2, y: c.y - 4, w: c.w + 4, h: c.h + 8 }, x, y)) return { kind: 'recap-' + c.id, index: 0 };
      return inRect({ x: 0, y: 0, w: 240, h: 138 }, x, y) ? { kind: 'recap-page', index: 0 } : null;
    }
    if (m === 'result' && S.result) {
      const g = ui.resultRects(S.result);
      if (g.recap && inRect({ x: g.recap.x - 2, y: g.recap.y - 4, w: g.recap.w + 4, h: g.recap.h + 8 }, x, y)) return { kind: 'recap', index: -1 };
      for (let i = 0; i < g.options.length; i++) if (inRect({ x: g.options[i].x - 2, y: g.options[i].y - 4, w: g.options[i].w + 4, h: g.options[i].h + 8 }, x, y)) return { kind: 'result', index: i };
      return null;
    }
    if (m === 'steps' || m === 'wait') return { kind: 'text', index: 0 };
    return null;
  }

  // ev: { kind: 'move' | 'click' | 'wheel', x, y (screen px, may be fractional), steps }
  function pointer(ev) {
    if (ev.kind === 'wheel') { const s = ev.steps || 0; const a = s > 0 ? 'down' : 'up'; for (let i = 0; i < Math.abs(s); i++) wheelStep(a); return true; }
    if (ev.x === null || ev.x === undefined) return false;
    const h = hit(ev.x, ev.y);
    if (!h) return false;
    if (ev.kind === 'move') { hover(h); return true; }
    if (ev.kind === 'click') { hover(h); activate(h); return true; }
    return false;
  }
  function wheelStep(a) {
    const m = S.mode;
    if (m === 'party' && S.party) partyInput(a); else if (m === 'preview') previewInput(a); else if (m === 'confirm') confirmInput(a); else if (m === 'menu') menuInput(a);
    else if (m === 'action') actionInput(a); else if (m === 'moves') movesInput(a); else if (m === 'result') resultInput(a === 'down' ? 'right' : 'left'); else if (m === 'recap') recapInput(a === 'down' ? 'right' : 'left');
  }
  function hover(h) {
    switch (h.kind) {
      case 'action': S.cursor = h.index; break;
      case 'move': S.moveCursor = h.index; break;
      case 'party': if (S.party) { S.party.cursor = h.index; S.partyCancelSel = false; } break;
      case 'cancel': S.partyCancelSel = true; break;
      case 'preview': if (S.preview) S.preview.cursor = h.index; break;
      case 'overlay': if (S.menu) { S.menu.cursor = h.index; S.overlay.cursor = h.index; } else if (S.confirm) { S.confirm.cursor = h.index; S.overlay.cursor = h.index; } break;
      case 'result': if (S.result) S.result.cursor = h.index; break;
      case 'recap': if (S.result) S.result.cursor = -1; break;
      case 'recap-prev': case 'recap-back': case 'recap-next': if (S.recap) S.recap.hover = h.kind.slice(6); break;
      case 'recap-page': if (S.recap) S.recap.hover = null; break;
      default: break;
    }
  }
  function activate(h) {
    switch (h.kind) {
      case 'action': actionActivate(h.index); break;
      case 'move': chooseMove(h.index); break;
      case 'party': chooseParty(h.index); break;
      case 'cancel': leaveParty(); break;
      case 'preview': previewToggle(h.index); break;
      case 'overlay': if (S.menu) menuActivate(h.index); else if (S.confirm) resolveConfirm(h.index === 0); break;
      case 'result': chooseResult(h.index); break;
      case 'recap': chooseResult(-1); break;
      case 'recap-prev': recapStep(-1); break;
      case 'recap-next': recapStep(1); break;
      case 'recap-back': closeRecap(); break;
      case 'recap-page': recapInput('a'); break;
      case 'text': press('a'); break;
      case 'back': press('b'); break;
      case 'info': press('x'); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------------------------------- view */
  function monView(d, isPlayer) {
    if (!d) return undefined;
    const o = { species: d.species, name: d.name, level: d.level, gender: d.gender, hp: d.hp, maxHp: d.maxHp, status: d.status, shiny: d.shiny, drop: d.drop, visible: d.visible, showBox: d.showBox, dx: d.dx, dy: d.dy, tint: d.tint, boxDx: d.boxDx, frame: d.frame | 0 };
    if (isPlayer) o.exp = { into: 0, span: 1 };
    if (d.barCurr !== undefined) { o.barCurr = d.barCurr; o.barTarget = d.barTarget; }        // FA1: the moving HP bar is drawn from the ROM's animated value
    if (d.scale !== undefined && d.scale !== 1) { o.scaleX = d.scale; o.scaleY = d.scale; }
    // AN1: while an animation runs it draws BOTH Pokemon (displaced, scaled, rotated, blended and tinted as the ROM script says; ANIM.md "draw", and since AN2's round 2
    // the other Pokemon of a self-targeting run too: ctx.bystander), so the scene's own sprites stand down. The healthboxes and the text box stay the scene's.
    if (fxRun()) {
      o.visible = false;
      if (S.cur.kind === 'move') o.showBox = false;           // the real game hides both healthboxes for the length of a MOVE animation (MEASURED on its Scratch capture, ANIM.md)
    }
    return o;
  }
  const fxRun = () => { const st = S.cur; return st && (st.t === 'moveanim' || st.t === 'sysintro' || st.t === 'sysevent') && st.run && !st.run.done ? st.run : null; };
  function staticBox(lines, arrow) { return { mode: 'message', text: lines, arrow: !!arrow }; }
  const effMode = () => (S.mode === 'menu' && S.menu ? S.menu.back : S.mode);        // the menu overlay draws over whatever was on screen
  function boxFor() {
    const m = effMode();
    if (m === 'action') {
      const nm = S.P[viewSide].name;
      const p = msg('prompt.action', roles(viewSide, { b1: nm })).split('\n');
      return { mode: 'action', prompt: [p[0] || 'What will', p[1] || nm + ' do?'], cursor: S.cursor };
    }
    // tick: the frame counter, so the one move name too long for its 64 px window (a Z-move nobody can know) scrolls through it instead of being cut (battle_ui.js marqueeOffset)
    if (m === 'moves') { const rows = moveRows(); return { mode: 'moves', cursor: S.moveCursor, moves: rows.map((r) => ({ name: r.name, pp: r.pp, maxPp: r.maxPp, type: r.type, typeName: typeName(r.type) })), tick: S.tick }; }
    if (m === 'confirm' && S.confirm) {
      const k = S.confirm.kind;
      const s = k === 'forfeit' ? msg('forfeit.ask', roles(viewSide)).split(/(?<=[?!.]) /)[0] : k === 'team' ? 'Send out this team?' : 'Leave this battle?';
      if (k !== 'forfeit') fallbacks.add('confirm.' + k);
      return staticBox(setBoxText(s).lines(), false);
    }
    if (m === 'wait') return staticBox(setBoxText(rawMsg('wait', 'Waiting for the other player...')).lines(), false);
    if (S.cur && S.cur.t === 'sysintro') {                    // AN1 round 3: the scene's own message over the opening run
      const st = S.cur;
      if (st.tw) { S.lastBox = { mode: 'message', text: st.tw.lines(), arrow: st.tw.waiting, tick: S.tick }; return S.lastBox; }
      return st.shown ? { mode: 'message', text: st.shown, arrow: false } : { mode: 'none' };
    }
    const c = S.cur && S.cur.t === 'text' ? S.cur : null;
    if (c) { S.lastBox = { mode: 'message', text: c.tw.lines(), arrow: c.tw.waiting, tick: S.tick }; return S.lastBox; }     // FA1: the real arrow is shown for the whole wait and does not blink (battle_ui.js bobs it)
    return S.lastBox;
  }
  function view() {
    const m = effMode();
    const ov = S.overlay ? S.overlay : null;
    if (m === 'party' && S.party) {
      const p = S.party;
      return { screen: 'party', overlay: ov, party: { mons: p.mons, cursor: p.cursor, tick: S.tick, canCancel: !p.forced, cancelSel: S.partyCancelSel, prompt: msg('party.choose', roles(viewSide)).replace(/ (?=[^ ]*$)/, '\n').split('\n') } };
    }
    if ((m === 'preview' || (m === 'confirm' && S.preview && S.confirm && (S.confirm.kind === 'team' || ((S.confirm.kind === 'forfeit' || S.confirm.kind === 'quit') && S.confirm.back === 'preview')))) && S.preview) {
      const p = S.preview;
      const asking = m === 'confirm' && (S.confirm.kind === 'forfeit' || S.confirm.kind === 'quit');       // D3: leaving from the pause menu at the team preview keeps the preview behind its YES / NO too
      const left = asking ? (S.confirm.kind === 'quit' ? 'Leave this battle?' : 'Give up this battle?') : p.picks.length >= p.pick ? 'Send out this team?' : 'Choose ' + p.pick + ' (' + p.picks.length + '/' + p.pick + ')';
      fallbacks.add(asking ? (S.confirm.kind === 'quit' ? 'confirm.quit' : 'confirm.forfeit.preview') : 'preview.title');
      return { screen: 'preview', overlay: ov, preview: { mine: p.mine, foe: p.foe, picks: p.picks, cursor: p.cursor, tick: S.tick, title: left, foeTitle: trainer, prompt: [] } };
    }
    if (m === 'recap' && S.result && S.recap) {
      const pages = recapPages(), i = clamp(S.recap.page, 0, pages.length - 1);
      return { screen: 'recap', recap: { page: pages[i], title: pages[i].title, index: i, count: pages.length, canPrev: i > 0, canNext: i < pages.length - 1, hover: S.recap.hover, tick: S.tick, backLabel: 'BACK' } };
    }
    if (m === 'result' && S.result) {
      const r = S.result;
      return { screen: 'result', result: { head: r.head, mine: r.mine, foe: r.foe, options: r.options, cursor: r.cursor, tick: S.tick, mineLabel: playerName.toUpperCase(), foeLabel: trainer.toUpperCase(), ...(r.recap ? { recap: true, recapLabel: 'RECAP' } : {}) } };
    }
    const tags = [];
    if (S.trickRoom) tags.push('TRICK ROOM');
    if (S.weather && WX_TAG[S.weather]) tags.push(WX_TAG[S.weather]);
    if (S.terrain && TN_TAG[S.terrain]) tags.push(TN_TAG[S.terrain]);
    if (S.gravity) tags.push('GRAVITY');
    const v = { env: opts.env | 0, foe: monView(S.disp[foeSide], false), player: monView(S.disp[viewSide], true), box: boxFor(), tags, overlay: ov };
    // The opening's run is not prepared yet: the real game's first frames are BLACK (then the wipe-in). Drawing the scene's own field here would show the terrain with the strip the text box
    // covers (hot pink in the ROM's art, 240x48) for the 10 ticks the pre-roll takes.
    if (S.cur && S.cur.t === 'sysintro' && !S.cur.run) v.blank = true;
    // FA1: while the player chooses (action / move menu) the real game bobs the player's healthbox and Pokemon by 1 px: the box between 0 and +1 with a half period of
    // 18.3 displayed frames at the oracle save's 2x battle speed (= 36.6 at the real 1x this scene runs at), the Pokemon 0 / +1 with a half period of 18 (36 at 1x); measured
    // from the real OAM over 140 frames. The phase at the moment the menu opens is not reproduced.
    if ((S.mode === 'action' || S.mode === 'moves') && v.player) { v.player.boxDy = (((S.tick / 36.6) | 0) & 1) ? 0 : 1; v.player.dy = (v.player.dy | 0) + ((((S.tick / 36) | 0) & 1) ? 0 : 1); }
    // AN1: while an animation runs the view says which one and which frame (so the page repaints every frame), and carries a NON-enumerable draw function that
    // composites the animation onto the terrain picture (both Pokemon included); battle_ui.js render calls it between the terrain and the healthboxes
    if (A.balls[0] || A.balls[1]) v.balls = A.balls.filter(Boolean).map((b) => Object.assign({}, b));
    const run = fxRun();
    if (run) {
      v.fx = { id: S.cur.kind + ':' + S.cur.id, frame: S.cur.n };
      const sys = S.cur.t !== 'moveanim';
      if (sys) v.fxSys = true;                         // a system run draws the whole battle screen (terrain, Pokemon, trainers, healthboxes); battle_ui.js render draws only the text box over it
      Object.defineProperty(v, 'fxDraw', { value: (frame) => { try { run.draw(frame, sys ? { layers: LAYERS_NO_TEXT } : {}); } catch (e) { A.log.push('draw threw: ' + String(e && e.message ? e.message : e).slice(0, 80)); } }, enumerable: false });
    }
    return v;
  }

  function state() {
    const d = (x) => (x ? { name: x.name, hp: x.hp, max: x.maxHp, status: x.status, visible: x.visible, drop: x.drop } : null);
    const c = S.cur && S.cur.t === 'text' ? S.cur : null;
    return {
      mode: S.mode, tick: S.tick, queue: S.queue.length, step: S.cur ? S.cur.t : null, turn: S.turn, ended: S.ended,
      player: d(S.disp[viewSide]), foe: d(S.disp[foeSide]), cursor: S.cursor, moveCursor: S.moveCursor, partyCursor: S.party ? S.party.cursor : null,
      text: c ? c.tw.lines() : S.lastBox.text, weather: S.weather, picks: S.preview ? S.preview.picks.slice() : null, overlay: S.overlay ? S.overlay.rows.slice() : null,
      resultCursor: S.result ? S.result.cursor : null, resultArmed: resultArmed(), winner: ctl.winner,
      recapPage: S.recap ? S.recap.page : null, recapCount: S.recap && S.result && S.result.recap ? recapPages().length : null, career: S.career ? S.career.state : null,
    };
  }

  const scene = {
    tick, press, hold, pointer, hit, view, state,
    hooks, S,
    fallbacks: () => Array.from(fallbacks).sort(),
    // run frames until a button is needed (tests): returns the number of frames consumed
    settle(max = 200000) { let n = 0; while (n < max && (S.mode === 'steps' || S.cur || S.queue.length)) { tick(); n++; } return n; },
    // W1 fix D11: a RESUMED battle (battle_boot.js replays the saved choices into a fresh controller, then begin()s) is played through here at the speed of a held A button, drawing
    // nothing, up to the first screen that needs the player; the HP bars, the Pokemon on the field, the weather and the last message are then the ones a live game would show.
    catchUp(max = 300000) { const a = S.held.a, b = S.held.b; S.held.a = true; let n = 0; try { while (n < max && (S.mode === 'steps' || S.cur || S.queue.length)) { tick(); n++; } } finally { S.held.a = a; S.held.b = b; } return n; },
    // feed the events the controller already holds (call once after ctl.start())
    begin() { const ev = ctl.takeEvents(); if (ev.length) { director(ev); S.mode = 'steps'; } return scene; },
    quitRequested: () => S.quit,
    setAnimator: (a) => { animator = a || null; },
    // AN1: what the animation layer did this battle (the page's diagnostics and the tests): how many animations the animator played, what it said about each
    // (exact | approx | fallback | none, by "kind:id"), sounds forwarded, presses that skipped, the front-picture swaps in flight, and the problems it logged
    animInfo: () => ({ active: !!animCfg(), animator: !!animator, played: A.played, sounds: A.sounds, cries: A.cries, sys: A.sysPlayed, waited: A.waited, restale: A.restale | 0, shed: A.shed | 0, skipped: A.skipped, coverage: Object.assign({}, A.coverage), byId: Object.assign({}, A.byId), running: A.step ? { kind: A.step.kind, id: A.step.id, n: A.step.n } : null, mon: A.mon.map((m) => (m ? { t: m.t, len: m.len } : null)), log: A.log.slice(), notes: A.notes.slice() }),
    choose: { move: chooseMove, party: chooseParty, result: chooseResult, action: actionActivate, preview: previewToggle },
    // ST1: the recap. setCareer({ state: 'saved' | 'duplicate' | 'none' | 'error', profileName, callouts, stats, note, note2 }) tells the RECORD page what was written (the page calls it when the store has answered)
    setCareer(info) { S.career = info && typeof info === 'object' ? { ...info } : null; S.careerVer++; },
    summary: () => (S.result ? S.result.summary : null),
    recapPages: () => (S.result && S.result.recap ? recapPages() : []),
    recap: { open: openRecap, close: closeRecap, step: recapStep },
    get mode() { return S.mode; },
    get ended() { return S.ended; },
  };
  return scene;
}
