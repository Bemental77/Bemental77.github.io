#!/usr/bin/env node
// tools/pokemonarena_rom_oracle_test.mjs - exit tests for stage OR1: the real-battle ORACLE (tools/pokemonarena_rom_oracle.mjs).
//
//   node tools/pokemonarena_rom_oracle_test.mjs                  # everything (about 1-2 minutes; boots the real ROM several times)
//   node tools/pokemonarena_rom_oracle_test.mjs --only memory,battle
//   ARENA_ROM=<path> ...                                          # the SoulGold v1.1.1 ROM (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//   ARENA_OR1_DIR=<dir> ...                                       # a warm checkpoint cache (default: a fresh temp dir per run, so every run PROVES the route)
//
// Exit code is non-zero on any failure. A missing ROM SKIPS LOUDLY (counted, printed, exit 0) - the ROM is not in the repo's deployable tree.
// Every check that matters has a NEGATIVE CONTROL (`[control]`: a mutant it must catch) beside the unmutated twin that must stay quiet.
// Nothing ROM-derived is written inside the repo: states, PNGs and the corrupted ROM copy live in <tmp>/pokemonarena-or1-test-*.
//
// What this does NOT prove: that the oracle is the arena's reference for any particular behaviour (that is FA1/FA2's work); it proves the oracle itself
// is deterministic, reaches the game's own battle code, and reads/writes the machine it claims to.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeText } from '../pokemonarena/js/charset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const O = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_rom_oracle.mjs')).href);
const { openOracle, FINDINGS, FUNCS, KEY } = O;
const argv = process.argv.slice(2);
const only = (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, caught, detail = '') => { if (caught) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const section = (s) => console.log('\n== ' + s);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pokemonarena-or1-test-'));
const WARM = process.env.ARENA_OR1_DIR || null;
const romPath = O.DEFAULT_ROM;

if (!fs.existsSync(romPath)) {
  skip++; console.log(`SKIP (loud): the SoulGold ROM is not at ${romPath}; ${1} section group skipped. 0 passed, 0 failed, ${skip} skipped.`);
  process.exit(0);
}
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* gone */ } };
process.on('exit', cleanup);
const mk = async (dir, extra = {}) => openOracle({ stateDir: dir || path.join(TMP, 'cache-' + Math.random().toString(36).slice(2, 8)), ...extra });
const rom = fs.readFileSync(romPath);

// ---------------------------------------------------------------------------------------------------------------------------------------
if (want('static')) {
  section('static: pinned inputs and the library surface');
  ok('ROM is SoulGold v1.1.1 (sha256 8071e2c3...5060a)', sha256(rom).startsWith('8071e2c348d54c3e') && sha256(rom).endsWith('5ab35060a'), sha256(rom).slice(0, 12));
  const wasm = fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.wasm'));
  ok('the pinned wasm is the one the oracle was written against (md5 13474b38...)', md5(wasm) === '13474b3883009819a5ac7304e568cb0a', md5(wasm));
  const bi = JSON.parse(fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.buildinfo.json'), 'utf8'));
  ok('buildinfo records that same wasm md5', bi.md5['mgba_core.wasm'] === md5(wasm));
  const src = fs.readFileSync(path.join(ROOT, 'tools/pokemonarena_rom_oracle.mjs'), 'utf8');
  ok('the library has no network or child-process use (first-party only)', !/\bfetch\s*\(|node:child_process|node:http|node:https|require\(['"]https?/.test(src));
  ok('the library does not write inside the repo (no writeFileSync to a ROOT-relative literal)', !/writeFileSync\(\s*path\.join\(ROOT/.test(src));
  const o = await mk(null);
  ok('checkpoint list has the six required names + route/wild extras', ['CK_BATTLE_INTRO', 'CK_ACTION_MENU', 'CK_MOVE_MENU', 'CK_MESSAGE', 'CK_HP_DRAINING', 'CK_PARTY_MENU', 'CK_WILD_ACTION_MENU', 'CK_GRASS'].every((n) => o.checkpointNames().includes(n)), o.checkpointNames().join(','));
  ok('FINDINGS addresses are word-aligned EWRAM/IWRAM and gBattleMons has 4 battlers of 0x98', [FINDINGS.gBattleMons.addr, FINDINGS.gPlayerParty.addr, FINDINGS.gEnemyParty.addr, FINDINGS.gMain.addr].every((a) => a % 4 === 0) && FINDINGS.gBattleMons.stride === 0x98 && FINDINGS.gEnemyParty.addr + 6 * 0x60 === FINDINGS.gPlayerParty.addr);
  o.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------------
let shared = null;       // one oracle reused by the read-mostly sections (its cache dir is WARM or fresh)
async function sharedOracle() { if (!shared) { shared = await mk(WARM); } return shared; }

if (want('determinism')) {
  section('determinism: two independent boots -> identical frames; a different key stream -> different frames (control)');
  const run = async (script) => { const o = await mk(null); o.script(script); const h = []; for (let i = 0; i < 6; i++) { o.runFrames(150); h.push(o.frameHash()); } const out = { chain: h.join(','), hash: o.hash(), frame: o.frame }; o.close(); return out; };
  const S = 'w1500 A@40 w60 A@40 w100';
  const a = await run(S), b = await run(S), c = await run(S.replace('A@40 w60', 'B@40 w60'));
  ok('two fresh boots with the same key script have identical frame-hash chains (6 samples)', a.chain === b.chain, a.chain.slice(0, 33) + '...');
  ok('...and an identical full machine hash at the end', a.hash === b.hash && a.frame === b.frame, `frame ${a.frame}`);
  control('a different key stream gives a different chain (the check can fail)', a.chain !== c.chain);
  const needle = Buffer.from(encodeText('would like to battle!', { terminate: false }));          // the trainer-battle intro line, in the game's charset (charset.js)
  const copy = Buffer.from(rom); let at = -1, from = 0; for (;;) { const i = rom.indexOf(needle, from); if (i < 0) break; if (at < 0) at = i; copy[i + 1] ^= 0x01; from = i + 1; }   // every copy: one glyph changed
  const corrupt = path.join(TMP, 'corrupt.gba'); fs.writeFileSync(corrupt, copy);
  const viaRoute = async (extra) => { const o = await mk(null, extra); await o.goto('CK_BATTLE_INTRO'); const r = { hash: o.frameHash(), text: o.battleText() }; if (extra) o.savePng(path.join(TMP, 'corrupt_intro.png'), { scale: 2 }); o.close(); return r; };
  const clean = await viaRoute(null), mutant = await viaRoute({ romPath: corrupt });
  ok('the intro line was found in the ROM (so the corrupted copy really differs)', at > 0, 'offset 0x' + at.toString(16));
  ok('the unmodified ROM reaches the intro prompt via the route', /would like to battle/.test(clean.text), JSON.stringify(clean.text));
  control('a corrupted ROM byte (one glyph of the intro line) gives a different frame hash AND different battle text at the same checkpoint', mutant.hash !== clean.hash && mutant.text !== clean.text, clean.hash + ' vs ' + mutant.hash + ' ' + JSON.stringify(mutant.text.slice(0, 30)));
}

if (want('checkpoints')) {
  section('checkpoints: the route reaches the REAL battle; builds are reproducible; the cache is equivalent to a rebuild');
  const dirA = path.join(TMP, 'A'), dirB = path.join(TMP, 'B');
  const a = await mk(dirA); const t0 = Date.now(); const ra = await a.goto('CK_ACTION_MENU'); const msA = Date.now() - t0;
  ok('CK_ACTION_MENU built from boot by playing the game', ra.cached === false && a.inBattle(), `${msA} ms, frame ${ra.frame}`);
  ok('the game itself says "What will Bob do?" (battle text buffer)', a.battleText() === 'What will\nBob do?', JSON.stringify(a.battleText()));
  ok('gMain.callback2 is the battle main loop; the controller is in the action-menu state', a.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2.battleMain && a.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu);
  const m0 = a.battleMon(0), m1 = a.battleMon(1);
  ok('gBattleMons[0] is Bob the starter (species 1289, Lv5, moves Scratch 10 / Tail Whip 39, 19/19 HP)', m0.species === 1289 && m0.level === 5 && m0.moves[0] === 10 && m0.moves[1] === 39 && m0.hp === 19 && m0.maxHP === 19);
  ok('gBattleMons[1] is the foe (species 183 Lv4, Pound 1 / Tail Whip 39, 19/19)', m1.species === 183 && m1.level === 4 && m1.moves[0] === 1 && m1.moves[1] === 39 && m1.hp === 19);
  ok('gBattleTypeFlags = TRAINER|IS_MASTER (0x0c) in the scripted trainer battle', a.readU32(FINDINGS.gBattleTypeFlags.addr) === 0x0c);
  ok('both HP bars read 48 px full off the frame', a.hpBarFill(0) === 48 && a.hpBarFill(1) === 48);
  const png = a.savePng(path.join(TMP, 'ck_action_menu.png'), { scale: 2 }); ok('a PNG of the checkpoint was written', fs.statSync(png).size > 2000, png);
  const blobA = md5(fs.readFileSync(a._ckFile('CK_ACTION_MENU')));
  const hA = a.frameHash(); a.runFrames(7); a.close();
  const b = await mk(dirB); const rb = await b.goto('CK_ACTION_MENU');
  ok('a second, independent build (fresh dir, fresh core) writes the byte-identical checkpoint blob', md5(fs.readFileSync(b._ckFile('CK_ACTION_MENU'))) === blobA, blobA);
  ok('...and lands on the identical frame', b.frameHash() === hA && rb.frame === ra.frame, hA);
  const rc = await b.goto('CK_ACTION_MENU');
  ok('goto() again hits the cache and reproduces the same frame hash', rc.cached === true && b.frameHash() === hA);
  b.runFrames(500, KEY.A); const drift = b.frameHash();
  await b.goto('CK_ACTION_MENU');
  ok('after running 500 frames elsewhere, goto() restores exactly the same frame', b.frameHash() === hA && drift !== hA);
  // cache equivalence: the same checkpoint rebuilt (ignoring the cache) equals the cached blob
  await b.goto('CK_ACTION_MENU', { rebuild: true });
  ok('a forced rebuild (cache ignored) writes the same blob as the cached one', md5(fs.readFileSync(b._ckFile('CK_ACTION_MENU'))) === blobA);
  // every checkpoint is reachable and shows what it says
  const expect = { CK_BATTLE_INTRO: (o) => /would like to battle/.test(o.battleText()), CK_MOVE_MENU: (o) => o.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.moveMenu,
    CK_MESSAGE: (o) => o.battleText().startsWith('Bob used Scratch'), CK_HP_DRAINING: (o) => { const f = o.hpBarFill(1); return f !== null && f >= 30 && f <= 42 && o.battleMon(1).hp === 19; },
    CK_PARTY_MENU: (o) => o.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2Party.partyMenu, CK_WILD_ACTION_MENU: (o) => o.battleText() === 'What will\nBob do?' && o.readU32(FINDINGS.gBattleTypeFlags.addr) === 4 && o.battleMon(1).species === 163 };
  for (const [n, pred] of Object.entries(expect)) { await b.goto(n); ok(`${n} shows its state`, pred(b), JSON.stringify(b.battleText().slice(0, 30)) + ' foeBar ' + b.hpBarFill(1)); b.savePng(path.join(TMP, n + '.png'), { scale: 2 }); }
  control('the HP_DRAINING predicate rejects the full-bar checkpoint (it can fail)', (await b.goto('CK_ACTION_MENU'), !expect.CK_HP_DRAINING(b)));
  b.close();
}

if (want('memory')) {
  section('memory: reads agree with the core, writes round-trip, a write has an effect');
  const o = await sharedOracle(); await o.goto('CK_ACTION_MENU');
  let bad = 0; for (let i = 0; i < 4000; i++) { const a = 0x02000000 + i * 4; if (o.readU32(a) !== o.coreRead32(a)) bad++; }
  ok('EWRAM: 4000 words read through the heap path equal the core\'s own bus-neutral read32', bad === 0, `${bad} mismatches`);
  bad = 0; for (let i = 0; i < 2000; i++) { const a = 0x03000000 + i * 4; if (o.readU32(a) !== o.coreRead32(a)) bad++; }
  ok('IWRAM: 2000 words agree', bad === 0, `${bad} mismatches`);
  for (const [name, base] of [['palette', 0x05000000], ['OAM', 0x07000000], ['VRAM', 0x06000000], ['IO', 0x04000000]]) { bad = 0; for (let i = 0; i < 256; i++) { const a = base + i * 4; if (o.readU32(a) !== o.coreRead32(a)) bad++; } ok(`${name}: 256 words agree`, bad === 0); }
  ok('ROM reads equal the file (the header title)', o.readBytes(0x080000a0, 12).toString('latin1') === 'POKEMON EMER');
  ok('readU8/U16/U32 are consistent views of the same bytes', (() => { const a = FINDINGS.gBattleMons.addr; return o.readU16(a) === (o.readU8(a) | (o.readU8(a + 1) << 8)) && o.readU32(a) === (o.readU16(a) | (o.readU16(a + 2) << 16)) >>> 0; })());
  // write round trips
  const snap = Buffer.from(o.saveStateBlob()); const T = 0x0203f000;
  for (const [n, fn, rd, v] of [['U8', 'writeU8', 'readU8', 0xa5], ['U16', 'writeU16', 'readU16', 0xbeef], ['U32', 'writeU32', 'readU32', 0xdeadbeef]]) { o[fn](T, v); const mask = n === 'U8' ? 0xff : n === 'U16' ? 0xffff : 0xffffffff; ok(`EWRAM write${n} -> read${n} round-trips and the core's own read32 agrees`, o[rd](T) === v && ((o.coreRead32(T) & mask) >>> 0) === v); }
  o.writeBytes(0x03007000, [1, 2, 3, 4, 5]); ok('IWRAM writeBytes round-trips', [...o.readBytes(0x03007000, 5)].join() === '1,2,3,4,5');
  o.loadStateBlob(snap); o.runFrames(1);
  // a VRAM write (via the savestate) changes the picture; writing the identical value does not. (A palette write would be overwritten by the game's own per-frame
  // palette DMA - measured: no visible effect - so it is not used as the evidence.)
  o.loadStateBlob(snap); o.runFrames(2); const same = o.frameHash();
  let changed = false, hitAt = 0; for (let off = 0x10000; off >= 0 && !changed; off -= 0x20) { const a = 0x06000000 + off; o.loadStateBlob(snap); o.runFrames(1); o.writeU32(a, (o.readU32(a) ^ 0xffffffff) >>> 0); o.runFrames(1); if (o.frameHash() !== same) { changed = true; hitAt = a; } }
  ok('writing VRAM (via the savestate) changes the next frame', changed, '0x' + hitAt.toString(16));
  o.loadStateBlob(snap); o.runFrames(1); o.writeU32(hitAt, o.readU32(hitAt)); o.runFrames(1);
  control('writing the SAME VRAM value is invisible (the effect check can fail)', o.frameHash() === same);
  // a write has an effect on the game: foe hp in the battle struct is what the game reads next
  o.loadStateBlob(snap); o.runFrames(1); o.setBattleMon(1, { hp: 7 }); ok('setBattleMon writes hp where battleMon() reads it', o.battleMon(1).hp === 7 && o.readU16(FINDINGS.gBattleMons.addr + 0x98 + 0x2a) === 7);
  o.setBattleMon(1, { species: 25, maxHP: 33, moves: [85, 0, 0, 0], statStages: [6, 6, 6, 6, 6, 6, 6, 6], nickname: 'ZAP' }); const m = o.battleMon(1);
  ok('setBattleMon: species / maxHP / moves / nickname land in the struct', m.species === 25 && m.maxHP === 33 && m.moves[0] === 85 && o.readBytes(FINDINGS.gBattleMons.addr + 0x98 + 0x34, 4).equals(Buffer.from(encodeText('ZAP', { terminate: true }))));
  o.loadStateBlob(snap); o.runFrames(1);
  ok('loadStateBlob restores memory exactly (the poked values are gone)', o.readU16(0x0203f000) !== 0xbeef && o.battleMon(1).hp === 19);
  let thrown = false; try { o.writeU8(0x08000000, 1); } catch (_e) { thrown = true; } control('writing ROM is refused', thrown);
  thrown = false; try { o.readU8(0x01000000); } catch (_e) { thrown = true; } control('reading outside every region is refused', thrown);
}

if (want('battle')) {
  section('battle: the REAL game plays a turn; scenario control changes the outcome; the RNG knob');
  const o = await sharedOracle(); await o.goto('CK_ACTION_MENU');
  const blob = Buffer.from(o.saveStateBlob());
  const r = o.playTurn(0);
  ok('playTurn(Scratch) plays the real turn: "Bob used Scratch!" then the foe\'s Tail Whip, back at the action menu', r.text.some((t) => /^Bob used Scratch/.test(t.text)) && r.text.some((t) => /Marill used Tail/.test(t.text)) && !r.over, r.text.map((t) => t.frame + ':' + JSON.stringify(t.text.slice(0, 20))).join(' '));
  ok('Scratch hurt the foe (19 -> ' + r.hp.after[1] + ') and Tail Whip lowered Bob\'s Defense stage', r.hp.after[1] < 19 && r.hp.after[1] >= 0 && o.battleMon(0).statStages[2] === 5, 'stages ' + o.battleMon(0).statStages.join(''));
  // determinism of the turn
  o.loadStateBlob(blob); o.runFrames(1); const r2 = o.playTurn(0); o.loadStateBlob(blob); o.runFrames(1); const r3 = o.playTurn(0);
  ok('the same turn from the same checkpoint is identical (damage, frames, text frames)', JSON.stringify([r2.hp, r2.frames, r2.text]) === JSON.stringify([r3.hp, r3.frames, r3.text]));
  // the RNG knob: idle frames at the menu change the roll. A big-damage scenario (Lv50 Tackle into a 200-HP Lv30 foe) so the 85-100% roll is visible in whole HP.
  await o.startBattle({ foe: { species: 163, level: 30, moves: [33], hp: 200, maxHp: 200, stats: { atk: 40, def: 40, spe: 10, spa: 40, spd: 40 } }, player: { species: 6, level: 50, hp: 150, maxHp: 153, moves: [33, 1], stats: { atk: 104, def: 98, spe: 120, spa: 129, spd: 105 } }, reach: 'action' });
  const big = Buffer.from(o.saveStateBlob());
  const dmg = new Set(); for (let d = 0; d < 14; d++) { o.loadStateBlob(big); o.runFrames(1); const t = o.playTurn(0, { delay: d }); dmg.add(t.hp.before[1] - t.hp.after[1]); }
  ok('idle-frame delay before choosing the move changes the damage roll (>= 4 distinct damages over 14 delays)', dmg.size >= 4, [...dmg].sort((x, y) => x - y).join(','));
  control('without the delay the same turn gives a single damage value (the sweep above is not noise in the harness)', (() => { const q = new Set(); for (let i = 0; i < 3; i++) { o.loadStateBlob(big); o.runFrames(1); const t = o.playTurn(0); q.add(t.hp.before[1] - t.hp.after[1]); } return q.size === 1; })());
  // scenario control: a custom battle
  const pk = await o.pack(); const sid = (n) => pk.species.findIndex((s) => s && s.name === n);
  const st = await o.startBattle({ foe: { species: sid('Pikachu'), level: 37, hp: 60, maxHp: 90, moves: [85, 33], genderRatio: pk.species[sid('Pikachu')].genderRatio, gender: 'F' }, player: { species: sid('Charizard'), level: 50, hp: 150, maxHp: 153, moves: [53, 33], nickname: 'Char' }, reach: 'action' });
  const c0 = o.battleMon(0), c1 = o.battleMon(1);
  ok('startBattle(): the game built the battle from my party structs (Charizard Lv50 150/153 vs Pikachu Lv37 60/90)', c0.species === sid('Charizard') && c0.level === 50 && c0.hp === 150 && c0.maxHP === 153 && c1.species === sid('Pikachu') && c1.level === 37 && c1.hp === 60 && c1.maxHP === 90, JSON.stringify([c0.species, c0.level, c0.hp, c0.maxHP, c1.species, c1.level, c1.hp, c1.maxHP]));
  ok('...as a WILD battle (flags 0x04) at the action menu with the right name', o.readU32(FINDINGS.gBattleTypeFlags.addr) === 4 && st.text === 'What will\nChar do?', JSON.stringify(st.text));
  const fill1 = o.hpBarFill(1), fill0 = o.hpBarFill(0);
  ok('the real healthboxes draw the HP ratio: foe 60/90 -> bar ' + fill1 + ' px (expect 31-33 of 48), player 150/153 -> ' + fill0 + ' px (expect 46-48)', fill1 >= 31 && fill1 <= 33 && fill0 >= 46 && fill0 <= 48);
  o.savePng(path.join(TMP, 'custom_battle.png'), { scale: 2 });
  // a set HP is read back by the game: foe at 1 HP + Scratch-class move -> faints
  o.setBattleMon(1, { hp: 1 }); const tk = o.playTurn(0, { maxFrames: 1500 });
  ok('with the foe at 1 HP the real game finishes the battle (foe fainted message or battle over)', tk.over || tk.text.some((t) => /fainted/i.test(t.text)) || o.battleMon(1).hp === 0, tk.text.map((t) => JSON.stringify(t.text.slice(0, 24))).join(' '));
  control('an unmodified turn at full HP does NOT end the battle', (() => { return !r.over; })());
  // a multi-mon player party with statuses: the game builds the party screen from it
  const mkm = (sp, lv, hp, mhp, mv, extra = {}) => ({ species: sp, level: lv, hp, maxHp: mhp, moves: mv, ...extra });
  await o.startBattle({ foe: mkm(163, 20, 60, 60, [33]), player: [mkm(6, 50, 150, 153, [53, 33], { status: 0x10 }), mkm(25, 37, 5, 90, [85]), mkm(94, 40, 0, 100, [33]), mkm(183, 22, 40, 80, [33], { status: 0x40 })], reach: 'action' });
  ok('the lead party-tail status (burn 0x10) reaches gBattleMons[0].status1 (+0x54)', o.battleMon(0).status1 === 0x10 && o.battleMon(1).status1 === 0, '0x' + o.battleMon(0).status1.toString(16));
  const party = [0, 1, 2, 3, 4, 5].map((i) => o.readU16(FINDINGS.gPlayerParty.addr + i * 0x60 + 0x20) & 0x7ff);
  ok('startBattle(player: [4 specs]) replaced the whole party in RAM (4 species then 2 empty slots)', party.join() === '6,25,94,183,0,0', party.join());
  o.openPartyMenu(); const pm = o.screenshotRGBA(); o.savePng(path.join(TMP, 'party_menu.png'), { scale: 2 });
  ok('the in-battle party screen opens on that party (callback2 = the party menu)', o.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2Party.partyMenu);
  const rows = [0, 1, 2, 3].map((i) => { let n = 0; for (let x = 20; x < 110; x++) { const k = ((28 + i * 24) * 240 + x) * 4; n += pm[k] + pm[k + 1] + pm[k + 2] > 120 ? 1 : 0; } return n; });
  ok('the screen is drawn (non-black row panels in the party column)', rows.every((n) => n > 20), rows.join());
  await o.startBattle({ foe: mkm(163, 20, 60, 60, [33]), player: mkm(6, 50, 150, 153, [53, 33]) });
  control('without a status in the party struct the lead reads status1 = 0 (the status check can fail)', o.battleMon(0).status1 === 0);
  // shiny: a PID that renders shiny vs normal differs in the healthbox colour
  const frame = async (shinyPid) => { await o.startBattle({ foe: { species: 163, level: 10, moves: [33], hp: 30, maxHp: 30, shinyPid }, reach: 'intro' }); return o.frameHash(); };
  const hn = await frame(false), hs = await frame(true), hn2 = await frame(false);
  ok('a shiny PID and a normal PID give different frames; the same normal PID twice gives the same frame', hn !== hs && hn === hn2);
}

if (want('audio')) {
  section('audio: the core\'s audio buffer -> Float32 (for the music stage)');
  const o = await sharedOracle(); await o.goto('CK_ACTION_MENU');
  const a = o.captureAudio(120);
  ok('120 video frames give ~2 s of audio at the game\'s programmed rate', [32768, 65536].includes(a.rate) && Math.abs(a.audioFrames / a.rate - 120 / 59.7275) < 0.05, `rate ${a.rate}, ${a.audioFrames} frames = ${(a.audioFrames / a.rate).toFixed(3)} s`);
  let peak = 0, nz = 0; for (let i = 0; i < a.samples.length; i++) { const v = Math.abs(a.samples[i]); if (v > peak) peak = v; if (v > 1e-4) nz++; }
  ok('the battle music is not silence (peak ' + peak.toFixed(3) + ', ' + nz + ' non-zero samples) and every sample is within [-1, 1]', peak > 0.01 && peak <= 1 && nz > 1000);
  const b = (await (async () => { await o.goto('CK_ACTION_MENU'); return o.captureAudio(120); })());
  ok('capturing the same checkpoint twice gives bit-identical audio', Buffer.compare(Buffer.from(a.int16.buffer), Buffer.from(b.int16.buffer)) === 0);
  await o.goto('CK_MOVE_MENU'); const c = o.captureAudio(120);
  control('audio from a different checkpoint (the move menu) differs from the action-menu audio (the comparison can fail)', Buffer.compare(Buffer.from(a.int16.buffer), Buffer.from(c.int16.buffer)) !== 0);
}

if (want('round2')) {
  section("round 2: the game's RNG, battle variables, realDamage, the knobs (each with a before/after), terrain, trainer, capture pack");
  const o = await sharedOracle(); await o.goto('CK_ACTION_MENU');
  // ---- RNG
  const s0 = [0x12345678, 0x9abcdef0, 0x0fedcba9, 0x77]; o.setRng(s0); o.runFrames(1);
  let sim = s0; for (let i = 0; i < 2; i++) sim = O.sfc32Step(sim).s;
  const got = o.getRng();
  ok("RNG: one idle frame advances the game's state by exactly two sfc32 steps (word for word)", got.every((v, i) => v === sim[i]), got.map((v) => v.toString(16)).join(' '));
  let sim3 = s0; for (let i = 0; i < 3; i++) sim3 = O.sfc32Step(sim3).s;
  control('...and not by three (the check can fail)', !got.every((v, i) => v === sim3[i]));
  ok('findRngSeed returns a state whose simulated draws satisfy the constraints', (() => { const c = [{ pos: 1, lo: 4096, hi: 8191 }, { pos: 0, lo: 62806, hi: 65535 }]; const sd = O.sfc32Draws(O.findRngSeed(c, { K: 4, key: 't' }), 4); return sd[1] >= 4096 && sd[1] <= 8191 && sd[0] >= 62806; })());
  // ---- realDamage
  const pk = await o.pack(); const mid = (n) => pk.moves.find((m) => m && m.name === n).id; const aid = (n) => pk.abilities.find((a) => a && a.name === n).id, iid = (n) => pk.items.find((a) => a && a.name === n).id;
  const tk = mid('Tackle'), wg = mid('Water Gun'), em = mid('Ember'), eq = mid('Earthquake');
  const t0 = Date.now(); const first = await o.realDamage({ move: tk, rollIndex: 0 }); const firstMs = Date.now() - t0;
  ok("realDamage(Tackle) returns a damage and finds the move's draw positions (roll, crit)", first.damage > 0 && first.positions.roll !== null && first.positions.crit !== null, `damage ${first.damage}, positions ${JSON.stringify(first.positions)}, first call ${firstMs} ms (includes the probes)`);
  const t1 = Date.now(); const rolls = []; for (let k = 0; k < 16; k++) rolls.push((await o.realDamage({ move: tk, rollIndex: k })).damage); const per = (Date.now() - t1) / 16;
  ok('the 16 roll indices give a non-increasing damage table from 100% to ~85%', rolls.every((v, i) => i === 0 || v <= rolls[i - 1]) && rolls[15] / rolls[0] > 0.8 && rolls[15] / rolls[0] < 0.9 && new Set(rolls).size >= 8, rolls.join(',') + `  (${per.toFixed(0)} ms per call)`);
  ok('cost: a cached-move call is under 1 second on this machine', per < 1000, per.toFixed(0) + ' ms');
  const again = await o.realDamage({ move: tk, rollIndex: 5 }); ok('the same request twice gives the same damage', again.damage === rolls[5]);
  const crit = await o.realDamage({ move: tk, rollIndex: 0, crit: true }), nocrit = await o.realDamage({ move: tk, rollIndex: 0, crit: false });
  ok('crit:true multiplies the same-roll damage by 1.5 and the game prints "A critical hit!"; crit:false does not', crit.crit && !nocrit.crit && Math.abs(crit.damage / nocrit.damage - 1.5) < 0.05, `${nocrit.damage} -> ${crit.damage}`);
  const c7 = await o.realDamage({ move: tk, rollIndex: 7, crit: true }); ok('roll and crit are independent draws (crit with roll 7 = 1.5 x the plain roll 7)', Math.abs(c7.damage - 1.5 * rolls[7]) <= 1.5, `${c7.damage} vs ${rolls[7]}`);
  const v = first.vars; ok('at the moment of damage gBattlerAttacker=0, gBattlerTarget=1, gCurrentMove=Tackle and the mirror holds the damage', v && v.attacker === 0 && v.target === 1 && v.currentMove === tk && v.mirror === first.damage, JSON.stringify(v));
  const foeAtk = await o.realDamage({ move: tk, attackerSide: 1, rollIndex: 0 }); ok('attackerSide:1 makes the foe the attacker (gBattlerAttacker=1, target=0) and deals the same damage', foeAtk.vars && foeAtk.vars.attacker === 1 && foeAtk.vars.target === 0 && foeAtk.damage === rolls[0], JSON.stringify(foeAtk.vars) + ' ' + foeAtk.damage);
  // ---- knobs: before / after at the SAME roll (ratios against the unmodified base)
  const base = { tk: rolls[0], wg: (await o.realDamage({ move: wg })).damage, em: (await o.realDamage({ move: em })).damage };
  const R = async (spec, b) => (await o.realDamage(spec)).damage / b;
  const near = (x, y, tol = 0.04) => Math.abs(x - y) <= tol;
  const r3 = (k, x) => (typeof x === 'number' ? +x.toFixed(3) : x);
  const rr = { rainW: await R({ move: wg, weather: 'rain' }, base.wg), rainF: await R({ move: em, weather: 'rain' }, base.em), sunW: await R({ move: wg, weather: 'sun' }, base.wg), sunF: await R({ move: em, weather: 'sun' }, base.em) };
  ok('weather word: rain = Water x1.5 / Fire x0.5; sun = Fire x1.5 / Water x0.5', near(rr.rainW, 1.5) && near(rr.rainF, 0.5) && near(rr.sunF, 1.5) && near(rr.sunW, 0.5), JSON.stringify(rr, r3));
  const sc = { reflP: await R({ move: tk, screens: { reflect: true } }, base.tk), reflS: await R({ move: wg, screens: { reflect: true } }, base.wg), lightS: await R({ move: wg, screens: { light: true } }, base.wg), lightP: await R({ move: tk, screens: { light: true } }, base.tk), veilP: await R({ move: tk, screens: { veil: true } }, base.tk), veilS: await R({ move: wg, screens: { veil: true } }, base.wg), sgm: await R({ move: tk, screens: { safeguard: true, mist: true } }, base.tk) };
  ok('side words: Reflect halves physical only, Light Screen special only, Aurora Veil (0x20) both; Safeguard + Mist change no damage', near(sc.reflP, 0.5) && near(sc.reflS, 1) && near(sc.lightS, 0.5) && near(sc.lightP, 1) && near(sc.veilP, 0.5) && near(sc.veilS, 0.5) && near(sc.sgm, 1), JSON.stringify(sc, r3));
  const kn = { atk2: await R({ move: tk, attacker: { stages: { atk: 2 } } }, base.tk), def2: await R({ move: tk, defender: { stages: { def: 2 } } }, base.tk), brn: await R({ move: tk, attacker: { status1: 'brn' } }, base.tk), par: await R({ move: tk, attacker: { status1: 'par' } }, base.tk), psn: await R({ move: tk, attacker: { status1: 'psn' } }, base.tk) };
  ok('stat stages: Atk +2 about x2, Def +2 about x0.5; status: burn halves physical damage, paralysis and poison do not', kn.atk2 > 1.9 && kn.atk2 < 2.05 && kn.def2 > 0.48 && kn.def2 < 0.56 && near(kn.brn, 0.5) && near(kn.par, 1) && near(kn.psn, 1), JSON.stringify(kn, r3));
  const sl = await o.realDamage({ move: tk, attacker: { status1: 'slp' } }), fz = await o.realDamage({ move: tk, attacker: { status1: 'frz' } });
  ok('status: a sleeping or frozen attacker deals no damage within the 700-frame window', sl.damage === 0 && fz.damage === 0);
  control('the same attacker awake deals damage (the status check can fail)', base.tk > 0);
  const ab = { hp: await R({ move: tk, attacker: { ability: aid('Huge Power') } }, base.tk), cb: await R({ move: tk, attacker: { item: iid('Choice Band') } }, base.tk), lo: await R({ move: tk, attacker: { item: iid('Life Orb') } }, base.tk), stab: await R({ move: tk, attacker: { types: [1, 1] } }, base.tk) };
  ok("ability and item ids written to the struct act: Huge Power ~x2, Choice Band ~x1.5, Life Orb ~x1.3; a Normal attacker gets STAB x1.5 (type ids are the ROM's: Normal = 1)", ab.hp > 1.9 && ab.hp < 2.05 && near(ab.cb, 1.5, 0.05) && near(ab.lo, 1.3, 0.05) && near(ab.stab, 1.5), JSON.stringify(ab, r3));
  const lev = await o.realDamage({ move: eq, defender: { ability: aid('Levitate') } }), noLev = await o.realDamage({ move: eq });
  ok('Levitate defender takes 0 from Earthquake; the same defender without it takes damage', lev.damage === 0 && noLev.damage > 0, `${lev.damage} vs ${noLev.damage}`);
  const fb = mid('Focus Blast'); const hitY = await o.realDamage({ move: fb, rollIndex: 0, hit: true }), hitN = await o.realDamage({ move: fb, rollIndex: 0, hit: false });
  ok('accuracy is controllable: Focus Blast (70%) with the accuracy draw forced high hits, forced low misses (0 damage)', hitY.damage > 0 && hitN.damage === 0 && hitY.positions.acc !== null, `${hitY.damage} vs ${hitN.damage}, positions ${JSON.stringify(hitY.positions)}`);
  const slashTbl = []; for (const r of [0, 15]) slashTbl.push((await o.realDamage({ move: mid('Slash'), rollIndex: r })).damage);
  ok('a high-crit-ratio move (Slash) with crit:false (default) never crits: roll 15 < roll 0', slashTbl[1] < slashTbl[0], slashTbl.join(' < '));
  // ---- variables: writes with effect
  const slash = mid('Slash'); const w0 = await o.realDamage({ move: tk, rollIndex: 0 }); const w1 = await o.realDamage({ move: tk, rollIndex: 0, mutate: { from: 6, n: 8, addr: FINDINGS.gCurrentMove.addr, size: 2, value: slash } });
  ok('writing gCurrentMove (Slash) while the damage is being computed raises the damage', w1.damage > w0.damage * 1.3, `${w0.damage} -> ${w1.damage}`);
  const w2 = await o.realDamage({ move: tk, rollIndex: 0, mutate: { from: 0, n: 40, addr: FINDINGS.gBattlerTarget.addr, size: 1, value: 0 }, maxFrames: 120 });
  control('writing gBattlerTarget = 0 redirects the hit: the foe takes no damage (the target variable has effect)', w2.damage === 0);
  const weakFoe = { atk: 80, level: 50 };   // a foe much weaker than the attacker, so computing the hit with ITS stats is visible
  const w3a = await o.realDamage({ move: tk, rollIndex: 0, defender: weakFoe }), w3 = await o.realDamage({ move: tk, rollIndex: 0, defender: weakFoe, mutate: { from: 0, n: 14, addr: FINDINGS.gBattlerAttacker.addr, size: 1, value: 1 } });
  ok("writing gBattlerAttacker = 1 early makes the game compute the damage with the other battler's stats (a weak foe: smaller damage)", w3.damage > 0 && w3.damage < w3a.damage * 0.7, `${w3a.damage} -> ${w3.damage}`);
  // ---- terrain / trainer / bars / capture pack
  const tfr = []; for (const t of [0, 2, 7]) { await o.startBattle({ foe: { species: 163, level: 10, moves: [33], hp: 30, maxHp: 30 }, terrain: t }); tfr.push(o.frameHash()); }
  await o.startBattle({ foe: { species: 163, level: 10, moves: [33], hp: 30, maxHp: 30 }, terrain: 0 }); const t0again = o.frameHash();
  ok('startBattle({terrain}) changes the battle background (grass / sand / cave frames all differ) and is repeatable', new Set(tfr).size === 3 && t0again === tfr[0], tfr.join(' '));
  await o.startBattle({ foe: { species: 163, level: 10, moves: [33], hp: 30, maxHp: 30 } }); control('without a terrain option the grass base gives the grass background', o.frameHash() === tfr[0]);
  await o.startBattle({ trainer: 'game', player: { species: 6, level: 50, hp: 150, maxHp: 153, moves: [33], nickname: 'Charizard' }, reach: 'intro' });
  ok("startBattle({trainer:'game'}): the game builds the trainer battle itself - Crystal's intro text, Marill Lv4, TRAINER flag", /Trainer/.test(o.battleText()) && /Crystal/.test(o.battleText()) && o.battleMon(1).species === 183 && o.battleMon(1).level === 4 && (o.readU32(FINDINGS.gBattleTypeFlags.addr) & 8) === 8, JSON.stringify(o.battleText()));
  const bar = async (php, fhp) => { await o.startBattle({ foe: { species: 25, level: 30, moves: [33], hp: fhp, maxHp: 60, nickname: 'Pikachu' }, player: { species: 6, level: 50, hp: php, maxHp: 153, moves: [33], nickname: 'Charizard' }, reach: 'action' }); return [o.hpBarInfo(0), o.hpBarInfo(1)]; };
  const [g0, g1] = await bar(150, 60), [y0, y1] = await bar(60, 25), [r0, r1] = await bar(10, 8);
  ok('HP bar colours and widths read off real healthboxes: green / yellow / red, fill = floor(48*hp/max)', g0.color === 'green' && g0.fill === 47 && g1.fill === 48 && y0.color === 'yellow' && y0.fill === 18 && y1.fill === 20 && r0.color === 'red' && r0.fill === 3 && r1.color === 'red' && r1.fill === 6, JSON.stringify([g0.color, g0.fill, y0.color, y0.fill, y1.fill, r0.color, r0.fill, r1.fill]));
  await o.startBattle({ foe: { species: 163, level: 30, moves: [33], hp: 200, maxHp: 200, stats: { atk: 40, def: 40, spe: 10, spa: 40, spd: 40 } }, player: { species: 6, level: 50, hp: 150, maxHp: 153, moves: [33, 1], stats: { atk: 104, def: 98, spe: 120, spa: 129, spd: 105 } }, reach: 'action' });
  const tr = o.playTurn(0, { bars: true }); const fills = tr.bars.map((b) => b.foe).filter((x) => x !== null);
  ok('playTurn({bars:true}) records the per-frame bar fill: the foe bar drains in several steps (48 -> smaller)', fills[0] === 48 && Math.min(...fills) < 44 && new Set(fills).size >= 4, [...new Set(fills)].join(','));
  const cdir = path.join(TMP, 'fa1pack'); const cp = await o.capturePack(cdir);
  ok('capturePack writes the FA1 reference set (6 status healthboxes whose status1 words are right, HP colours, faint sheets, trainer intro, terrains)', ['status_brn', 'status_psn', 'status_par', 'status_slp', 'status_frz', 'status_tox', 'hp_red', 'faint_foe_sheet', 'trainer_intro', 'terrains'].every((k) => fs.existsSync(cp.files[k])) && cp.notes.status_brn.player === 0x10 && cp.notes.status_tox.foe === 0x80 && /Crystal/.test(cp.notes.trainer_intro), Object.keys(cp.files).length + ' files');
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (shared) shared.close();
process.exit(fail ? 1 : 0);
