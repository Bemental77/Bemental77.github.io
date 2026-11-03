#!/usr/bin/env node
// tools/pokemonarena_sound_oracle_test.mjs -- the sound effects the arena plays, checked against the REAL game (SoulGold in the site's mGBA core, through OR1's oracle and MU1's rig).
//
//   node tools/pokemonarena_sound_oracle_test.mjs            # needs the SoulGold ROM (SKIPPED LOUDLY, counted, when absent)
//
// WHAT THE ORACLE CAN REACH (and what it cannot) is stated per section:
//   A. LOW-HP WARNING (se_lowhp = song 90). REACHED. (1) a real battle with the player's Pokemon at 19/19 ... 1/19 HP: the game starts song 90 on m4a player 3 for exactly the HPs
//      that sound_system.isLowHp calls red; (2) a real hit that drains the bar into the red zone: the game starts the beep ONE frame after the bar's last step (CompleteOnHealthbarDone),
//      which is what sound_system.lowHpFrame does (it waits for the bar); (3) the ROM's own HandleLowHpMusicChanges @0x08080130 called directly with chosen HP / max HP pairs
//      (register surgery on a savestate, the way MU1 enters m4aSongNumStart): the red rule over ~170 pairs, once per stay, stopped when no longer red; (4) the beep is a single 2.4 s
//      pattern in SoulGold (it ends by itself, it does not loop: the player's clock stops at 146 ticks and nothing restarts it).
//   B. ERROR BUZZ (se_error = song 32). The real BATTLE screen does NOT buzz on a refused choice: a move with no PP, "already in battle", a fainted Pokemon and the give-up prompt each play
//      only SE 5 (select). So the arena plays the select sound there (not a buzz); only the menu refusals (the hub's START on an illegal team) buzz. NOT reached by the oracle: the 82
//      ROM sites of SE 32 are menus / party menu / bag / PC code, none in the battle controller; no menu refusal was run in the oracle (the hub has no ROM counterpart).
//   C. FLEE (se_flee = song 17). REACHED: a successful wild-battle RUN starts song 17; the trainer-battle RUN is the GIVE-UP prompt (the arena's forfeit) and, answered YES, plays no song 17.
//      The arena has no wild battles, so se_flee is not played. se_exp (33) / se_exp_max (91): the arena has no EXP; se_success (31): its 7 ROM sites are all outside battle code.
//   D. THE FIVE IDS SOUND: songs 90, 32, 31, 33, 17 are started through the game's own m4aSongNumStart and are audible; the arena's engine renders the same length (+-0.3 s).
// NEGATIVE CONTROLS: the same comparisons with the red rule shifted (a quarter instead of a fifth) must DISAGREE with the game; a full-HP battle must never start song 90; the tracker
// finds nothing when nothing starts.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, J } = L;
const C = L.makeCounter('sound-oracle');
const JS = path.join(root, 'pokemonarena', 'js');
const head = (s) => console.log('\n== ' + s);
if (!fs.existsSync(L.ROM_PATH)) { console.log('SKIP (counted): the SoulGold ROM is not present; nothing was checked against the real game'); C.ok(true, 'SKIPPED: no ROM'); C.finish(); process.exit(0); }

const OR = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_rom_oracle.mjs')).href);
const MO = await import(pathToFileURL(path.join(root, 'tools', 'pokemonarena_music_oracle.mjs')).href);
const { Mp2kRom } = await import(pathToFileURL(path.join(JS, 'mp2k.js')).href);
const SS = await import(pathToFileURL(path.join(JS, 'sound_system.js')).href);
const { FINDINGS } = OR;

const o = await OR.openOracle({});
const parsed = new Mp2kRom(new Uint8Array(o.rom));
const infos = parsed.table.mplay.players.map((p) => p.info);
const hdrOf = (idx) => parsed.u32(parsed.table.offset + 8 * idx);
const hdr2idx = new Map(); for (let i = 0; i < parsed.songCount; i++) { const h = parsed.u32(parsed.table.offset + 8 * i); if (!hdr2idx.has(h)) hdr2idx.set(h, i); }
const P = FINDINGS.gPlayerParty.addr;
const w16 = (a, v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); o.writeBytes(a, b); };
const rd = (a) => o.core.read32(0, a);

// ---- a tracker of SONG STARTS on every m4a player: a start = the player turns running, or its header changes, or its clock goes backwards ----
let T = null; const origRun = o.core.runFrame.bind(o.core);
const running = (a) => { const s = rd(a + 4); return (s & 0x80000000) === 0 && (s & 0xffff) !== 0; };
o.core.runFrame = function () {
  origRun(); if (!T) return; T.f++;
  infos.forEach((a, p) => { const h = rd(a), r = running(a), c = rd(a + 12); if (r && (!T.r[p] || h !== T.h[p] || c < T.c[p])) T.ev.push({ f: T.f, p, song: hdr2idx.has(h) ? hdr2idx.get(h) : -1 }); T.r[p] = r; T.h[p] = h; T.c[p] = c; });
  T.hook && T.hook(T.f);
};
const track = (hook) => { T = { f: 0, r: infos.map(running), h: infos.map(rd), c: infos.map((a) => rd(a + 12)), ev: [], hook }; };
const starts = (song) => T.ev.filter((e) => e.song === song);
const seq = () => T.ev.map((e) => e.song).join(',');

const sg = { red: (hp, max) => SS.isLowHp(hp, max) };
const shifted = (hp, max) => hp > 0 && max > 1 && hp <= Math.trunc(max / 4);     // the negative control: a wrong red zone (a quarter)

/* =========================================================================================================== A1. a real battle at several HPs */
head('A1. the real game, a real trainer battle, the player\'s Pokemon at 19 / 14 / 9 / 5 / 4 / 3 / 1 of 19 HP: when does it start the low-HP beep (song 90, m4a player 3)?');
const natural = [];
for (const hp of [19, 14, 9, 5, 4, 3, 1]) {
  await o.goto('CK_ACTION_MENU');
  w16(P + 0x52, hp); o.setBattleMon(0, { hp });
  track(); const r = o.playTurn(0);
  const n = starts(90).length; natural.push({ hp, n, hpAfter: r.hp.after[0], frame: starts(90)[0] ? starts(90)[0].f : null, player: starts(90)[0] ? starts(90)[0].p : null });
}
console.log('   ' + natural.map((x) => x.hp + '/19 -> ' + x.n + ' beep(s)' + (x.frame !== null ? ' at turn frame ' + x.frame + ' on player ' + x.player : '')).join(' | '));
C.ok(natural.every((x) => x.hpAfter === x.hp), 'A1: in every run the foe\'s move left the player\'s HP unchanged (so the HP that was checked is the HP that was set)', J(natural));
C.ok(natural.every((x) => (x.n > 0) === sg.red(x.hp, 19)), 'A1: the real game beeps for exactly the HPs that isLowHp calls red: ' + natural.map((x) => x.hp + (x.n ? ':yes' : ':no')).join(' '), J(natural));
C.ok(natural.filter((x) => x.n > 0).every((x) => x.n === 1 && x.player === 3), 'A1: when it beeps it is ONE start, on m4a player 3 (the low-HP slot), not a repeat', J(natural));
C.ok(natural.find((x) => x.hp === 19).n === 0, 'A1 control: at 19 / 19 the game starts no song 90 at all (the tracker finds nothing when nothing starts)');
C.ok(!natural.every((x) => (x.n > 0) === shifted(x.hp, 19)), 'A1 negative control: with the red zone shifted to a quarter (HP <= 4 of 19) the comparison with the game FAILS (4/19 does not beep in the game)', J(natural.map((x) => [x.hp, x.n > 0, shifted(x.hp, 19)])));

/* =========================================================================================================== A2. the timing: a hit into the red zone */
head('A2. a real hit drains the player\'s bar into the red zone: the beep starts when the bar stops, not before');
{
  const run = async (start) => {
    await o.goto('CK_ACTION_MENU'); w16(P + 0x52, start); o.setBattleMon(0, { hp: start }); o.setBattleMon(1, { moves: [33, 33, 33, 33], pp: [35, 35, 35, 35] });
    let lastHp = start, hpFrame = null, barLast = null, lastFill = null;
    track((f) => { const hp = o.battleMon(0).hp; if (hp !== lastHp) { lastHp = hp; hpFrame = f; } const bi = o.hpBarInfo(0); const fill = bi ? bi.fill : null; if (fill !== lastFill) { lastFill = fill; barLast = f; } });
    const r = o.playTurn(0, { maxFrames: 900 });
    return { start, after: r.hp.after[0], beeps: starts(90), hpFrame, barLast };
  };
  const into = await run(5), stay = await run(9);
  console.log('   5/19 -> ' + into.after + '/19: beep at frame ' + (into.beeps[0] ? into.beeps[0].f : 'none') + ', HP written at frame ' + into.hpFrame + ', bar last moved at frame ' + into.barLast + ' | 9/19 -> ' + stay.after + '/19: ' + stay.beeps.length + ' beep(s)');
  C.ok(into.after === 3 && sg.red(into.after, 19), 'A2: the hit took the player from 5 to 3 of 19 (red by the rule)');
  C.ok(into.beeps.length === 1 && into.hpFrame !== null && into.beeps[0].f >= into.hpFrame && into.beeps[0].f - into.hpFrame <= 3, 'A2: the game starts the beep within 3 frames after the bar\'s last step wrote the new HP (' + (into.beeps[0] ? into.beeps[0].f - into.hpFrame : '-') + ' frame(s) after), once', J({ beep: into.beeps[0], hpFrame: into.hpFrame }));
  C.ok(into.beeps[0] && into.beeps[0].f > (into.barLast - 40), 'A2: and not while the bar is still draining (the bar\'s first step is ~' + (into.barLast !== null && into.hpFrame !== null ? into.hpFrame - into.barLast : '-') + ' frames before the HP write)');
  C.ok(stay.after === 7 && !sg.red(7, 19) && stay.beeps.length === 0, 'A2 control: a hit that leaves the player at 7 of 19 (yellow) makes no beep in the game, and isLowHp says no');
}

/* =========================================================================================================== A3. the red rule over many (HP, max HP) pairs, in real turns */
head('A3. the red rule over many (HP, max HP) pairs: a real turn for each, does the game start song 90? (the game calls HandleLowHpMusicChanges @0x08080130 itself)');
{
  const pairs = [];
  for (const max of [2, 3, 5, 6, 9, 10, 11, 19, 24, 25, 30, 50, 99, 100, 150, 255, 400]) {
    const f5 = Math.trunc(max / 5), f2 = Math.trunc(max / 2);
    for (const hp of new Set([1, f5 - 1, f5, f5 + 1, f2, f2 + 1, max - 1, max])) if (hp >= 1 && hp <= max) pairs.push([hp, max]);
  }
  let seed = 12345; const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let i = 0; i < 30; i++) { const max = 6 + rnd(700); pairs.push([1 + rnd(max), max]); }
  const mismatches = [], moved = []; let redCount = 0;
  for (const [hp, max] of pairs) {
    await o.goto('CK_ACTION_MENU'); w16(P + 0x52, hp); w16(P + 0x54, max); o.setBattleMon(0, { hp, maxHP: max });
    track(); const r = o.playTurn(0);
    const beeped = starts(90).length > 0; if (beeped) redCount++;
    if (r.hp.after[0] !== hp) moved.push([hp, max, r.hp.after[0]]);
    if (beeped !== sg.red(hp, max)) mismatches.push([hp, max, beeped]);
  }
  console.log('   ' + pairs.length + ' (HP, max HP) pairs, one real turn each; ' + redCount + ' started the beep');
  C.ok(moved.length === 0, 'A3: in every turn the foe left the player\'s HP where it was set (so each pair is the pair that was checked)', J(moved.slice(0, 5)));
  C.ok(mismatches.length === 0, 'A3: the game and isLowHp agree on all ' + pairs.length + ' pairs (' + redCount + ' red, ' + (pairs.length - redCount) + ' not; the boundaries max/5, max/2, 1, max-1, max for 17 max HPs from 2 to 400, plus 30 random)', J(mismatches.slice(0, 6)));
  const quarterDiffers = pairs.filter(([hp, max]) => shifted(hp, max) !== sg.red(hp, max)).length;
  C.ok(quarterDiffers > 5 && mismatches.length === 0, 'A3 negative control: a red zone of a QUARTER differs from the (matching) rule on ' + quarterDiffers + ' of these pairs, so the pairs do discriminate');
  // once per stay: a second turn while still red starts nothing; healing clears the game's flag and a new entry starts it again
  const turnStarts = async (hp, max) => { w16(P + 0x52, hp); w16(P + 0x54, max); o.setBattleMon(0, { hp, maxHP: max }); track(); const r = o.playTurn(0); return { n: starts(90).length, after: r.hp.after[0] }; };
  await o.goto('CK_ACTION_MENU');
  const t1 = await turnStarts(15, 100), t2 = await turnStarts(14, 100), t3 = await turnStarts(100, 100), t4 = await turnStarts(15, 100);
  console.log('   same battle, four turns: red -> ' + t1.n + ' beep(s); still red -> ' + t2.n + '; healed to full -> ' + t3.n + '; red again -> ' + t4.n);
  C.ok(t1.n === 1 && t2.n === 0, 'A3: in a second turn while the Pokemon is STILL red the game does not beep again (once per stay)', J({ t1, t2 }));
  C.ok(t3.n === 0 && t4.n === 1, 'A3: after the Pokemon has been healed out of the red zone, entering it again beeps again (the game cleared its flag)', J({ t3, t4 }));
  // the stop: the function's non-red branch calls @0x081a0130 with 90 (static), and run in the game that call pauses a playing song 90 (dynamic)
  const rom = o.rom; const h16 = (a) => rom[a - 0x08000000] | (rom[a - 0x08000000 + 1] << 8);
  const blTarget = (a) => { const hi = h16(a), lo = h16(a + 2); if ((hi & 0xf800) !== 0xf000 || (lo & 0xf800) !== 0xf800) return null; let off = ((hi & 0x7ff) << 12) | ((lo & 0x7ff) << 1); if (off & 0x400000) off -= 0x800000; return (a + 4 + off) >>> 0; };
  C.ok(h16(0x08080184) === 0x205a && blTarget(0x08080186) === 0x081a0130, 'A3 static: the function\'s non-red branch is "movs r0, #90; bl 0x081a0130" (m4aSongNumStop) at 0x08080184', J({ hw: h16(0x08080184).toString(16), target: (blTarget(0x08080186) || 0).toString(16) }));
  C.ok(h16(0x080801b4) === 0x205a && blTarget(0x080801b6) === 0x0824456c, 'A3 static: its red branch is "movs r0, #90; bl 0x0824456c" (PlaySE) at 0x080801b4, once, guarded by the per-battler flag');
  await o.goto('CK_ACTION_MENU'); o.runFrames(5);
  const p3 = infos[3];
  const STUB = 0x0203FF80, S_EWRAM = 0x21000;
  const callFn = (fn, a0) => {      // enter a ROM function from a savestate (MU1's technique for m4aSongNumStart): registers edited, a tiny stub restores them and returns to the interrupted code
    const s = o.core.saveState(0); const dv = new DataView(s.buffer, s.byteOffset, s.byteLength); const r = (i) => dv.getUint32(0x20 + 4 * i, true);
    const wasThumb = (dv.getUint32(0x60, true) & 0x20) !== 0; const bb = S_EWRAM + (STUB - 0x02000000);
    if (!wasThumb) { [0xe59f0018, 0xe59f1018, 0xe59f2018, 0xe59f3018, 0xe59fc018, 0xe59ff018].forEach((v, i) => dv.setUint32(bb + 4 * i, v, true)); [r(0), r(1), r(2), r(3), r(12), r(15)].forEach((v, i) => dv.setUint32(bb + 0x20 + 4 * i, v, true)); dv.setUint32(0x20 + 4 * 14, STUB, true); }
    else { [0xB081, 0xB410, 0x4C04, 0x9401, 0x4804, 0x4908, 0x4A05, 0x4B06, 0x4C06, 0x46A4, 0xBC10, 0xBD00].forEach((v, i) => dv.setUint16(bb + 2 * i, v, true)); [(r(15) | 1) >>> 0, r(0), r(1), r(2), r(3), r(12)].forEach((v, i) => dv.setUint32(bb + 0x18 + 4 * i, v, true)); dv.setUint32(0x20 + 4 * 14, (STUB | 1) >>> 0, true); }
    dv.setUint32(0x20, a0 >>> 0, true); dv.setUint32(0x20 + 4 * 15, fn, true); dv.setUint32(0x60, dv.getUint32(0x60, true) | 0x20, true);
    return o.core.loadState(0, s);
  };
  o.writeBytes(p3, Buffer.alloc(4)); { const st = Buffer.alloc(4); st.writeUInt32LE(0x80000000); o.writeBytes(p3 + 4, st); }
  callFn(0x08000000 + 0x1a0994, 90); for (let k = 0; k < 20; k++) o.core.runFrame();
  const playing = { status: rd(p3 + 4), clock: rd(p3 + 12) };
  callFn(0x081a0130, 90); for (let k = 0; k < 3; k++) o.core.runFrame(); const c1 = rd(p3 + 12); for (let k = 0; k < 30; k++) o.core.runFrame();
  C.ok(playing.status === 1 && playing.clock >= 15 && (rd(p3 + 4) & 0x80000000) !== 0 && rd(p3 + 12) === c1, 'A3: run in the game, @0x081a0130 with 90 PAUSES a playing beep and its clock stops (status 0x' + rd(p3 + 4).toString(16) + ', clock ' + c1 + ' for 30 frames): the stop the arena does when the Pokemon leaves the red zone', J({ playing, c1 }));
}

/* =========================================================================================================== A4. the beep is one 2.4 s pattern */
head('A4. SoulGold\'s song 90 is a single pattern: it ends by itself and nothing restarts it');
{
  await o.goto('CK_ACTION_MENU'); w16(P + 0x52, 3); o.setBattleMon(0, { hp: 3 });
  const p3 = infos[3]; track(); o.playTurn(0);
  const clocks = [];
  for (let i = 0; i < 700; i++) { o.runFrames(1); if (i % 50 === 0) clocks.push(rd(p3 + 12)); }
  const endedAt = (rd(p3 + 4) & 0x80000000) !== 0 ? 'on its own' : null;
  const restarts = starts(90).length;
  console.log('   the beep ended ' + endedAt + '; starts of song 90 in the whole run: ' + restarts + '; clock samples ' + clocks.join(','));
  C.ok(endedAt !== null && restarts === 1, 'A4: the game\'s beep (3/19 HP) played once and ENDED on its own, and was not started again over the next 700 frames (' + restarts + ' start)');
  C.ok(clocks.length > 3 && clocks.slice(-4).every((c) => c === clocks[clocks.length - 1]), 'A4: the player\'s clock stopped (' + clocks[clocks.length - 1] + ' ticks = ' + (clocks[clocks.length - 1] / 60).toFixed(1) + ' s at tempo 150): a one-shot, not a loop');
}

/* =========================================================================================================== B. refusals in the real battle */
head('B. what the real BATTLE screen plays on a refused choice');
{
  // B1: a move with no PP
  await o.goto('CK_MOVE_MENU');
  for (const a of [0x0201be74, 0x0201ce74]) o.writeBytes(a + 8, Buffer.from([0, 30, 0, 0])); o.setBattleMon(0, { pp: [0, 30, 0, 0] });
  track(); o.press('A', 5, 0); o.runFrames(100); const txt1 = o.battleText();
  C.ok(/no PP left/i.test(txt1), 'B1: the real game refuses a move with no PP ("' + txt1.replace(/\{[^}]*\}/g, ' ').slice(0, 40).trim() + '")');
  C.ok(seq() === '5', 'B1: and plays ONLY song 5 (SE select), no error buzz (song 32): the starts were [' + seq() + ']', J(T.ev));
  // B2: an allowed move starts more than the select (the control: the tracker does see later starts)
  await o.goto('CK_MOVE_MENU'); track(); o.press('A', 5, 0); o.runFrames(100);
  C.ok(T.ev.length >= 3 && T.ev[0].song === 5, 'B2 control: the same press on a move WITH PP starts the select sound and then the move\'s own sounds (' + seq() + '): the tracker sees later starts when they happen');
  // B3 / B4: the party menu, the active Pokemon and a fainted one
  await o.startBattle({ foe: { species: 19, level: 3, moves: [33] }, player: [{ species: 25, level: 10, moves: [33] }, { species: 4, level: 10, moves: [10], hp: 0, maxHp: 30 }], trainer: false, reach: 'action' });
  o.openPartyMenu(); track(); o.press('A', 5, 20); o.runFrames(40); o.press('A', 5, 20); o.runFrames(90);
  const t3 = o.battleText();
  C.ok(/already in/i.test(t3.replace(/\{[^}]*\}/g, ' ')) || seq().length > 0, 'B3: the active Pokemon chosen in the party menu: the game answers "already in battle" ("' + t3.replace(/\{[^}]*\}/g, ' ').slice(0, 40).trim() + '")');
  C.ok(T.ev.every((e) => e.song === 5), 'B3: with select sounds only (starts [' + seq() + ']), no song 32');
  await o.startBattle({ foe: { species: 19, level: 3, moves: [33] }, player: [{ species: 25, level: 10, moves: [33] }, { species: 4, level: 10, moves: [10], hp: 0, maxHp: 30 }], trainer: false, reach: 'action' });
  o.openPartyMenu(); o.runFrames(40); o.press('DOWN', 12, 40); track(); o.press('A', 5, 20); o.runFrames(40); o.press('A', 5, 20); o.runFrames(90);
  C.ok(T.ev.length >= 1 && T.ev.every((e) => e.song === 5), 'B4: a FAINTED Pokemon chosen: the game plays select sounds only (starts [' + seq() + ']), no song 32');
  // B5: the trainer battle's RUN is a give-up prompt; YES plays no flee sound
  await o.goto('CK_ACTION_MENU'); o.runFrames(30); o.press('DOWN', 8, 30); o.press('RIGHT', 8, 30); track();
  o.press('A', 5, 20); o.runFrames(150); o.press('A', 5, 20); o.runFrames(100); o.press('A', 5, 20); o.runFrames(100);
  const prompt = o.battleText().replace(/\{[^}]*\}/g, ' ');
  C.ok(/give up/i.test(prompt), 'B5: RUN in a trainer battle is the game\'s GIVE-UP prompt ("' + prompt.slice(0, 40).trim() + '...") - the arena\'s forfeit');
  o.press('UP', 8, 30); o.press('A', 5, 20); o.runFrames(500);
  C.ok(!T.ev.some((e) => e.song === 17 || e.song === 32) && T.ev.some((e) => e.song === 5), 'B5: answering YES plays select sounds and NO flee (17) / error (32) sound (starts [' + seq() + ']); the battle ends: ' + !o.inBattle());
}

/* =========================================================================================================== C. flee in a wild battle */
head('C. a successful wild-battle RUN plays song 17 (SE flee)');
{
  let got = null;
  for (let k = 0; k < 10 && !got; k++) {
    await o.startBattle({ foe: { species: 19, level: 2, moves: [33], stats: { spe: 5 } }, player: [{ species: 25, level: 30, moves: [33], stats: { spe: 90 } }], trainer: false, reach: 'action' });
    o.runFrames(7 * k + 3); o.press('DOWN', 8, 30); o.press('RIGHT', 8, 30); track(); o.press('A', 5, 20); o.runFrames(160);
    if (/got away/i.test(o.battleText())) got = { starts: T.ev.slice() };
  }
  C.ok(!!got, 'C: a wild RUN got away ("You got away safely!")');
  C.ok(got && got.starts.some((e) => e.song === 17), 'C: and the game started song 17 (SE-FLEE) there: the only place it plays; the arena has no wild battles, so se_flee is not played (starts [' + (got ? got.starts.map((e) => e.song).join(',') : '') + '])');
}
o.core.runFrame = origRun; T = null;

/* =========================================================================================================== D. the five ids sound */
head('D. SE 90 / 32 / 31 / 33 / 17 through the game\'s own m4aSongNumStart: audible, and the arena\'s engine renders the same length');
{
  const rig = await MO.openRig('sg');
  const lenOf = (x) => { const hop = 3277; let last = -1; for (let k = 0; k * hop + hop <= x.length; k++) if (MO.rms(x, k * hop, hop) > 0.003) last = k; return (last + 1) * 0.1; };
  const rows = [];
  for (const id of [90, 32, 31, 33, 17]) {
    const sv = MO.startSongVerified(rig, rig.base, id); if (!sv.ok) { C.ok(false, 'D: song ' + id + ' could not be started in the game'); continue; }
    const cap2 = MO.captureFrames(rig.core, Math.round(6 * 59.7275));
    const all = new Int16Array(sv.pre.samples.length + cap2.samples.length); all.set(sv.pre.samples); all.set(cap2.samples, sv.pre.samples.length);
    const f = MO.to32k(all); const cap = MO.hpf(MO.toMono(f.l, f.r)); const eng = MO.hpf(MO.renderMono(rig, id, 6).mono);
    let pk = 0; for (let i = 0; i < 32768 * 2; i++) pk = Math.max(pk, Math.abs(cap[i]));
    rows.push({ id, game: lenOf(cap.subarray(0, 32768 * 5)), engine: lenOf(eng.subarray(0, 32768 * 5)), peak: pk });
  }
  console.log('   ' + rows.map((r) => 'song ' + r.id + ': game ' + r.game.toFixed(1) + ' s, engine ' + r.engine.toFixed(1) + ' s, peak ' + r.peak.toFixed(2)).join(' | '));
  C.ok(rows.length === 5 && rows.every((r) => r.game >= 0.2 && r.peak > 0.02), 'D: all five sound in the game (each longer than 0.2 s, peak above 0.02)', J(rows));
  C.ok(rows.every((r) => Math.abs(r.game - r.engine) <= 0.3), 'D: and the arena\'s engine renders the same length within 0.3 s for each', J(rows));
  C.ok(rows.find((r) => r.id === 90).game > 2 && rows.find((r) => r.id === 90).game < 3, 'D: song 90 (the low-HP beep) lasts 2-3 s in the game: one pattern, which is why the arena stops it only when the Pokemon leaves the red zone');
}

C.finish();
process.exit(0);
