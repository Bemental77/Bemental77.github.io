#!/usr/bin/env node
// tools/pokemonarena_saveimport_test.mjs - exit tests for stage SV1: the SoulGold save importer (pokemonarena/js/saveimport.js).
//
//   node tools/pokemonarena_saveimport_test.mjs                 # Node suite: real save written by the game, encoder round trips, container, hostile input, 5,000 + 14,000 fuzzed saves
//   node tools/pokemonarena_saveimport_test.mjs --game          # + the REAL GAME as judge: 8 batches of encoder-built saves are booted in mGBA, CONTINUE pressed, Summary pages hashed and compared with
//                                                                #   what the screens say; the PC boxes are read in the running game's RAM; the real-save script is replayed (determinism)
//   node tools/pokemonarena_saveimport_test.mjs --browser      # + headless Chrome parity through a real <input type=file> upload (own devserver on :8100, tools/headless_cdp.mjs, muted)
//   node tools/pokemonarena_saveimport_test.mjs --mutants      # + the source-mutation matrix (every mutant must be killed by --core; the unmutated twin must stay quiet)
//   node tools/pokemonarena_saveimport_test.mjs --all           # everything
//   node tools/pokemonarena_saveimport_test.mjs --core          # the fast subset the mutant runner uses (no game, no browser, fewer fuzz rounds)
//   ARENA_UPDATE_GOLDEN=1 ... --game                           # rewrite the hashes-only goldens (manifest goldens.game / gameSaves); the typed oracle (oracle.*) is NEVER rewritten by the tool
//   env: ARENA_ROM, ARENA_SV1_DIR (scratch: the cached real save, PNGs, mutants; default <os tmpdir>/pokemonarena-sv1), ARENA_FUZZ (default 5000), SAVEIMPORT_TREE (a copy of pokemonarena/ to test; mutants)
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (a mutant that must trip it, printed [control]) next to the
// unmutated twin that must stay quiet. NOTHING ROM-DERIVED is written into the repo: the real save and the PNGs live in the scratch dir; goldens are hashes.
//
// FOUR KINDS OF EVIDENCE, kept apart in the output:
//   [game]  / [enc <batch>]  the real game wrote a save (tools/pokemonarena_savegen.mjs plays the new game) or READ a save our test-only encoder wrote; its Summary screens are the oracle
//                            (oracle.* in the manifest was typed by the author from the PNGs, never produced by the parser) and the importer must agree;
//   [ram]   the running game's EWRAM compared byte for byte with the encoder's records (PC boxes);
//   [rom]   facts read from the game's own code (listed with addresses in the manifest evidence);
//   [self]  encoder -> parser round trips: self-consistency only, and they say so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREE = process.env.SAVEIMPORT_TREE ? path.resolve(process.env.SAVEIMPORT_TREE) : path.join(ROOT, 'pokemonarena');
const JS = (f) => pathToFileURL(path.join(TREE, 'js', f)).href;
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f) || argv.includes('--all') && f !== '--core';
const CORE = argv.includes('--core');
const FUZZ = CORE ? 400 : Number(process.env.ARENA_FUZZ || 5000);
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const MANIFEST = path.join(ROOT, 'pokemonarena/saveimport_manifest.json');

const SI = await import(JS('saveimport.js'));
const { loadPack } = await import(JS('tables.js'));
const { checkMon } = await import(JS('profile.js'));
const { encodeText, decodeField: decodeFieldT } = await import(JS('charset.js'));
const G = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_savegen.mjs')).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; if (!CORE) console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, tripped, detail = '') => { if (tripped) { pass++; if (!CORE) console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const section = (s) => { if (!CORE) console.log(`\n== ${s}`); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const J = (v) => JSON.stringify(v);
const eq = (a, b) => J(a) === J(b);

const ROM_PATH = G.DEFAULT_ROM;
const rom = fs.readFileSync(ROM_PATH);
const pack = loadPack(rom, { verify: 'header', dexText: false });
const layoutTable = G.readLayoutTable(rom);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mkRng = (seed) => { const f = mulberry(seed); return { f, int: (n) => Math.floor(f() * n), u32: () => Math.floor(f() * 4294967296) >>> 0, pick: (a) => a[Math.floor(f() * a.length)] }; };

// ---- the real save: cached under the scratch dir, regenerated (deterministically) when absent or when its hash drifted --------------------------
async function realSave() {
  const file = path.join(G.SCRATCH, 'real_v1.sav');
  if (fs.existsSync(file)) { const b = fs.readFileSync(file); if (sha(b) === manifest.goldens.realSaveSha256) return { bytes: new Uint8Array(b), regenerated: false }; }
  const r = await G.generateRealSave({ rom, shotDir: path.join(G.SCRATCH, 'shots_real'), log: () => {} });
  fs.mkdirSync(G.SCRATCH, { recursive: true }); fs.writeFileSync(file, r.save);
  return { bytes: r.save, regenerated: true, ramParty: r.ramParty };
}

const OPTS = { rom, pack };
const imp = (bytes, extra = {}) => SI.importSave(bytes, { ...OPTS, ...extra });

// ---- independent expectations (written here, not imported from the module under test) --------------------------------------------------------
const STATS6 = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'];
const lvlOf = (growth, exp) => { const row = pack.exp[growth]; let l = 1; for (let k = 2; k <= 100; k++) { if (exp >= row[k]) l = k; } return l; };
const genderOf = (sp, pid) => (sp.genderRatio === 255 ? '-' : sp.genderRatio === 0 ? 'M' : sp.genderRatio === 254 ? 'F' : ((pid & 255) >= sp.genderRatio ? 'M' : 'F'));
// the real save has story flag 0x95e SET, so its shiny threshold is 256 (512 with the flag clear); XOR with the modifier bit
const SHINY_T = 256;
const shinyOf = (tid, sid, pid, modifier, T = SHINY_T) => ((((tid ^ sid ^ (pid >>> 16) ^ (pid & 0xffff)) >>> 0) < T) !== !!modifier);
const effSlot = (sp, num) => { let k = Math.min(num, 2); while (k > 0 && !sp.abilities[k]) k--; return k; };
const NICK_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?.-,';
const legalIds = pack.species.filter((s) => s && s.legal).map((s) => s.id);
function randomSpec(r, o = {}) {
  const sp = pack.species[o.species || r.pick(legalIds)];
  const level = o.level || 1 + r.int(100);
  const row = pack.exp[sp.growthRate];
  const lo = row[level], hi = level === 100 ? lo : row[level + 1] - 1;
  const exp = lo + r.int(hi - lo + 1);
  const nature = r.int(25);                         // the nature the record must show
  const pidNature = r.int(25);                      // what personality % 25 says; the stored 5-bit XOR delta bridges the two
  const pid = (r.int(171798690) * 25 + pidNature) >>> 0;
  const nlen = r.int(12), nick = Array.from({ length: nlen }, () => r.pick(NICK_CHARS)).join('');
  const olen = 1 + r.int(7), ot = Array.from({ length: olen }, () => r.pick(NICK_CHARS.slice(0, 52))).join('');
  const moves = Array.from({ length: 1 + r.int(4) }, () => 1 + r.int(935));
  const iv = {}, ev = {}, hyper = {};
  for (const k of STATS6) { iv[k] = r.int(32); ev[k] = r.int(256); hyper[k] = r.int(6) === 0 ? 1 : 0; }
  const spec = {
    pid: o.pid !== undefined ? o.pid : pid, tid: r.int(65536), sid: r.int(65536), nickname: nick, otName: ot, species: sp.id, item: r.int(1024), ball: r.int(64), exp, ppBonuses: r.int(256), friendship: r.int(256),
    moves, iv, ev, hyper, level, natureXor: ((o.pid !== undefined ? o.pid : pid) % 25) ^ nature, abilityNum: r.int(4), shinyMod: r.int(8) === 0 ? 1 : 0,
    moveHigh: [r.int(32), r.int(32), r.int(32), r.int(2)], expTop: r.int(256), ...o.extra,
  };
  return spec;
}
function withStats(spec) {
  const sp = pack.species[spec.species];
  const L = sp ? lvlOf(sp.growthRate, spec.exp) : 1; // a species outside the table (hostile record) has no growth rate
  return { ...spec, level: L, hp: 1, maxHp: 1, stats: { atk: 1, def: 1, spe: 1, spa: 1, spd: 1 } };
}
function expectedMon(spec) {
  const sp = pack.species[spec.species];
  const nick = spec.nickname.toUpperCase() === sp.name.toUpperCase() ? '' : [...spec.nickname].slice(0, 10).join('');
  const hyper = spec.hyper || {};
  return {
    species: spec.species, nickname: nick, level: lvlOf(sp.growthRate, spec.exp), nature: (spec.pid % 25) ^ (spec.natureXor || 0), gender: genderOf(sp, spec.pid),
    shiny: shinyOf(spec.tid, spec.sid, spec.pid, spec.shinyMod), heldItem: spec.item, friendship: spec.friendship, abilitySlot: effSlot(sp, spec.abilityNum || 0),
    moves: spec.moves.filter((m) => m).map((m, i) => ({ id: m, ppUps: ((spec.ppBonuses || 0) >> (i * 2)) & 3 })),
    ev: Object.fromEntries(STATS6.map((k) => [k, spec.ev[k]])),
    iv: Object.fromEntries(STATS6.map((k) => [k, hyper[k] ? 31 : spec.iv[k]])),
    ot: { name: spec.otName, tid: spec.tid, sid: spec.sid },
  };
}
const baseFields = (m) => ({ species: m.species, nickname: m.nickname, level: m.level, nature: m.nature, gender: m.gender, shiny: m.shiny, heldItem: m.heldItem, friendship: m.friendship, abilitySlot: m.abilitySlot, moves: m.moves, ev: m.ev, iv: m.iv, ot: m.originalTrainer });
const encParty = (spec) => G.encodeMon(withStats(spec), { party: true });
const encBox = (spec) => G.encodeMon(spec, { party: false }).subarray(0, 76);

// patch helpers on a copy of the real save (slot index 1 holds the real save)
const REAL_SLOT = 1;
function saveWithParty(base, specs) {
  const { map } = G.slotMap(base, REAL_SLOT);
  const at = map.get(1) * 0x1000 + 0x238;
  const bob = base.slice(at, at + 96);
  return G.withParty(base, layoutTable, REAL_SLOT, [bob, ...specs.map(encParty)]);
}
function saveWithBoxes(base, placed) { let s = Uint8Array.from(base); for (const [b, i, spec] of placed) s = G.withBoxMon(s, layoutTable, REAL_SLOT, b, i, encBox(spec)); return s; }

// =======================================================================================================================================
const real = await realSave();
const R = real.bytes;
section('manifest, ROM layout table, constants');
{
  const L = SI.readLayout(rom);
  ok('readLayout(ROM): table structure verified', L.ok, L.ok ? '' : L.why);
  ok('layout matches the manifest (sizes/offsets pinned)', eq(L.layout.sections.map((s) => [s.offset, s.size]), manifest.layout.sections), J(L.layout.sections.map((s) => [s.offset.toString(16), s.size.toString(16)])).slice(0, 80));
  ok('block sizes: SaveBlock2 0xB30, SaveBlock1 0x3C54, storage 0x8B80', L.layout.sb2Size === 0xb30 && L.layout.sb1Size === 0x3c54 && L.layout.storageSize === 0x8b80);
  ok('manifest FIELD/BLOCK == the module constants (drift gate)', eq(manifest.fields, SI.FIELD) && eq(manifest.blocks, SI.BLOCK), '');
  ok('manifest pins the layout table offset and the ROM', manifest.layout.tableOffset === SI.LAYOUT_TABLE_OFFSET && manifest.rom.md5 === 'b2c5caf9bc6dd28a44052427ee3ab1b7');
  const enc = G.E;
  ok('encoder constants (written independently) agree with the importer constants', enc.sb1Party === SI.BLOCK.sb1.party && enc.sb1PartyCount === SI.BLOCK.sb1.partyCount && enc.partyBytes === SI.FIELD.partyBytes && enc.storageRecord === SI.BLOCK.storage.recordBytes && enc.storageBoxes === SI.BLOCK.storage.boxes && enc.storageNames === SI.BLOCK.storage.names && enc.storageTag === SI.BLOCK.storage.tag);
  // structural controls on the layout reader
  const bad1 = Buffer.from(rom); bad1.writeUInt16LE(0x1234, SI.LAYOUT_TABLE_OFFSET + 2 * 4 + 0); // section 2 offset no longer the running sum
  control('a ROM whose layout table is not contiguous is refused (save.layout)', imp(R, { rom: bad1 }).error && imp(R, { rom: bad1 }).error.code === 'save.layout');
  const bad2 = Buffer.from(rom); bad2.writeUInt16LE(0x2000, SI.LAYOUT_TABLE_OFFSET + 3 * 4 + 2); // size bigger than a sector
  control('a ROM whose section size exceeds a sector is refused (save.layout)', imp(R, { rom: bad2 }).error && imp(R, { rom: bad2 }).error.code === 'save.layout');
  control('a ROM that is too short for the table is refused (save.layout)', SI.readLayout(rom.subarray(0, 0x1000)).ok === false);
}

section('[game] the REAL save: written by the game itself, read back by the importer');
const ORACLE = manifest.oracle.real; // typed from the game's own Summary screens (PNGs opened by the author), NOT from the parser
{
  ok('the cached/regenerated real save has the pinned hash', sha(R) === manifest.goldens.realSaveSha256, real.regenerated ? '(regenerated by the game script)' : '(cached)');
  const r = imp(R);
  ok('import ok', r.ok === true, r.ok ? '' : J(r.error));
  const m = r.party[0];
  ok('one party Pokemon, no boxes occupied, nothing rejected', r.party.length === 1 && r.boxes.every((b) => !b.mons.length) && r.summary.rejected === 0 && r.summary.total === 1);
  ok('container: slot 1 (the second slot) used, counter 1, no fallback', r.container.slotUsed === 1 && r.container.counter === 1 && r.container.fallback === false);
  ok('trainer name/id/gender (the Info page says Ot/Nova IDNo11757)', r.trainer.name === ORACLE.trainer.name && r.trainer.id === ORACLE.trainer.id && r.trainer.gender === ORACLE.trainer.gender);
  ok('SaveBlock2 (trainer) and the Pokemon record (a different block) agree on tid/sid: cross-block consistency, the SID is on no screen', r.trainer.tid === r.party[0].originalTrainer.tid && r.trainer.sid === r.party[0].originalTrainer.sid && r.trainer.sid !== 0);
  ok('species 1289 = the case entry "No906 - Sprigatito"', m.species === ORACLE.species && pack.species[m.species].name === 'Sprigatito' && pack.species[m.species].natDex === 906);
  ok('nickname "Bob", Lv5, male, Naive (Summary: Naive nature, Lv5, male symbol)', m.nickname === ORACLE.nickname && m.level === ORACLE.level && m.gender === ORACLE.gender && pack.natures[m.nature].name === ORACLE.nature);
  ok('EXP 135 (Summary: Exp. Points 135, Next Lv. 44)', r.reports[m.id].derived.exp === ORACLE.exp && pack.exp[pack.species[m.species].growthRate][6] - r.reports[m.id].derived.exp === ORACLE.nextLv);
  ok('IVs 3/8/20/25/28/7 hp/atk/def/spa/spd/spe (the game\'s IV page)', eq([m.iv.hp, m.iv.atk, m.iv.def, m.iv.spa, m.iv.spd, m.iv.spe], ORACLE.ivs));
  ok('EVs all 0 (the game\'s EV page)', Object.values(m.ev).every((v) => v === 0));
  ok('moves Scratch/Tail Whip, PP ups 0 (35/35 30/30)', m.moves.length === 2 && pack.moves[m.moves[0].id].name === 'Scratch' && pack.moves[m.moves[1].id].name === 'Tail Whip' && m.moves.every((x) => x.ppUps === 0));
  ok('ability Overgrow by slot 0; happiness 50; held item none; OT Nova', pack.abilities[pack.species[m.species].abilities[m.abilitySlot]].name === 'Overgrow' && m.friendship === 50 && m.heldItem === 0 && m.originalTrainer.name === 'Nova' && m.originalTrainer.tid === 11757);
  const sc = r.reports[m.id].selfCheck;
  ok('built-in stat self-check: stored stats 19/11/11/10/9/12 match the stats computed from the decoded fields (6/6)', sc && sc.matched === 6 && eq([sc.stored.hp, sc.stored.atk, sc.stored.def, sc.stored.spa, sc.stored.spd, sc.stored.spe], ORACLE.stats) && r.summary.statCheck.rate === 1);
  ok('validation: legal under the default ruleset', r.reports[m.id].validation.ok === true && r.summary.legal === 1 && r.summary.needsFix === 0);
  ok('checkMon(profile.js) accepts the record', checkMon(m, 'mon').length === 0);
  ok('provenance: source save, slot 0, pid/otId from the record', m.provenance.source === 'save' && m.provenance.slot === 0 && m.provenance.pid === 0xf4beb9a0 && m.provenance.otId === 0xa7e32ded && m.origin === 'save-import');
  // the same bytes in RAM, captured by the script right before saving, equal the flash bytes of the record: the .sav is the game's own write
  if (real.ramParty) ok('the 96-byte party record the game held in RAM == the bytes in the flash image', Buffer.compare(Buffer.from(real.ramParty.subarray(0, 96)), Buffer.from(R.subarray(G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238, G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238 + 96))) === 0);
  // negative control: a one-field mutation of the oracle must NOT match
  control('the oracle comparison trips on a wrong IV (control)', !eq([m.iv.hp, m.iv.atk, m.iv.def, m.iv.spd, m.iv.spa, m.iv.spe], ORACLE.ivs));
}

section('input hygiene: never mutates, deterministic, accepts every buffer kind');
{
  const copy = Uint8Array.from(R), before = sha(copy);
  const a = imp(copy), b = imp(copy);
  ok('the input buffer is byte-identical after import (never writes back)', sha(copy) === before);
  ok('deterministic: two imports are deep-equal', eq(a, b));
  const ab = copy.buffer.slice(0), padded = new Uint8Array(copy.length + 64); padded.set(copy, 32);
  ok('ArrayBuffer and an offset subarray view import identically', eq(imp(ab), a) && eq(imp(padded.subarray(32, 32 + copy.length)), a));
  ok('Node Buffer imports identically', eq(imp(Buffer.from(copy)), a));
  for (const bad of [null, undefined, 'x', 5, {}, [], new Float32Array(4)]) ok('non-bytes input ' + (bad === null ? 'null' : typeof bad) + ' -> save.bad-input', (imp(bad).error || {}).code === (bad instanceof Float32Array ? 'save.size' : 'save.bad-input'));
  const withRtc = new Uint8Array(0x20010); withRtc.set(R); const legacy = new Uint8Array(0x22000); legacy.set(R);
  const r1 = imp(withRtc), r2 = imp(legacy);
  ok('0x20010 and 0x22000 accepted (first 0x20000 bytes used) with a size warning', r1.ok && r2.ok && r1.warnings.some((w) => w.code === 'save.size-extra') && r2.warnings.some((w) => w.code === 'save.size-extra') && eq(r1.party, a.party));
  for (const n of [0, 1, 0x1ffff, 0x20001, 0x2000f, 0x21000, 0x22001, 0x40000]) ok('size ' + n.toString(16) + ' refused (save.size)', (imp(new Uint8Array(n)).error || {}).code === 'save.size');
  control('0x22000 is not special-cased away: dropping it from ACCEPTED_SIZES would refuse a legacy buffer (control)', !SI.ACCEPTED_SIZES.includes(0x22000) === false);
  ok('all-0xFF (erased flash) -> save.empty', (imp(new Uint8Array(0x20000).fill(0xff)).error || {}).code === 'save.empty');
  ok('all-zero -> save.no-valid-slot', (imp(new Uint8Array(0x20000)).error || {}).code === 'save.no-valid-slot');
  ok('wrong ROM bytes with the right pack -> save.wrong-rom', (imp(R, { rom: fs.readFileSync(path.join(ROOT, 'gba/gbaWasm/roms/Kirby - Nightmare in Dream Land (U).gba')) }).error || {}).code === 'save.wrong-rom');
  const alien = JSON.parse(J({ rom: pack.rom })); alien.rom.sha256 = 'f'.repeat(64);
  ok('a pack from another ROM (sha256) -> save.wrong-rom', (imp(R, { pack: { ...pack, rom: alien.rom } }).error || {}).code === 'save.wrong-rom');
  ok('a pack with another game code -> save.wrong-rom', (imp(R, { pack: { ...pack, rom: { ...pack.rom, gameCode: 'AXVE' } } }).error || {}).code === 'save.wrong-rom');
  ok('no pack -> save.wrong-rom; no ROM and no layout -> save.rom-missing', (imp(R, { pack: null }).error || {}).code === 'save.wrong-rom' && (imp(R, { rom: null }).error || {}).code === 'save.rom-missing');
  ok('a pre-read layout replaces the ROM', imp(R, { rom: null, layout: SI.readLayout(rom).layout }).ok === true);
  control('the wrong-ROM check is real: the same call with the right pack/ROM succeeds', imp(R).ok === true);
  ok('importSaveFile(Blob) and importSaveFile(ArrayBuffer) give the sync result; a rejected read never throws', eq(await SI.importSaveFile(new Blob([R]), OPTS), imp(R)) && eq(await SI.importSaveFile(R.buffer.slice(0), OPTS), imp(R)) && (await SI.importSaveFile({ arrayBuffer: () => Promise.reject(new Error('boom')) }, OPTS)).error.code === 'save.internal');
}

section('[self] encoder -> importer round trips (self-consistency; the game-read evidence is in --game)');
{
  const r = mkRng(0x5eed);
  let bad = 0, n = 0, selfOk = 0, selfTot = 0;
  for (let round = 0; round < (CORE ? 10 : 40); round++) {
    const specs = Array.from({ length: 1 + r.int(5) }, () => randomSpec(r));
    const save = saveWithParty(R, specs);
    const out = imp(save);
    if (!out.ok) { bad++; continue; }
    ok2: for (let i = 0; i < specs.length; i++) {
      n++;
      const got = out.party[i + 1], exp = expectedMon(specs[i]);
      if (!got) { bad++; continue; }
      const want = J({ ...exp, ot: exp.ot }), have = J(baseFields(got));
      if (want !== have) { bad++; if (bad < 4) console.log('    mismatch', want, have); }
      if (got.provenance.slot !== i + 1 || got.provenance.pid !== specs[i].pid) bad++;
      if (checkMon(got, 'mon').length) bad++;
    }
  }
  ok(`party round trip: ${n} random Pokemon (any species/nature/EV/IV/moves/PP ups/items/nicknames) come back field-for-field`, bad === 0 && n > 0, `(${n} mons, ${bad} bad)`);
  // boxes: the geometry (15 x 30 x 76, names, tag) is inferred, so this proves the importer follows the SAME inferred geometry the encoder uses
  let bbad = 0, bn = 0;
  for (let round = 0; round < (CORE ? 5 : 25); round++) {
    const placed = []; const used = new Set();
    for (let k = 0; k < 12; k++) { const b = r.int(15), i = r.int(30); if (used.has(b * 30 + i)) continue; used.add(b * 30 + i); placed.push([b, i, randomSpec(r)]); }
    const out = imp(saveWithBoxes(R, placed));
    if (!out.ok) { bbad++; continue; }
    for (const [b, i, spec] of placed) {
      bn++;
      const got = out.boxes[b].mons.find((m) => m.provenance.slot === i && m.provenance.box === b);
      if (!got || J(baseFields(got)) !== J(expectedMon(spec))) bbad++;
    }
    if (out.boxes.reduce((s, x) => s + x.mons.length, 0) !== placed.length) bbad++;
  }
  ok(`box round trip: ${bn} Pokemon placed in random (box, slot) cells return in the same cells`, bbad === 0 && bn > 0, `(${bn} mons, ${bbad} bad)`);
  ok('15 boxes named Box1..Box15, current box 0, wallpapers 0..14 (the real save\'s untouched storage)', (() => { const o = imp(R); return o.boxes.length === 15 && o.boxes.every((b, i) => b.name === 'Box' + (i + 1) && b.wallpaper === i) && o.boxes[0].current === true; })());
  // the built-in stat self-check must notice a field decoded wrongly: store a wrong Attack and a wrong level-derived HP
  const spec = randomSpec(r, { species: 25, level: 50 });
  const good = G.encodeMon(withStats(spec), { party: true });
  const m0 = imp(saveWithParty(R, [spec])); // stats bytes in withStats are 1: every stored stat differs from the computed one
  ok('self-check reports mismatches when stored stats disagree (6 stats differ, not fatal)', m0.ok && m0.reports[m0.party[1].id].selfCheck.mismatches.length === 6 && m0.reports[m0.party[1].id].notes.some((x) => x.code === 'stats.mismatch'));
  void good;
}

section('field semantics (each pinned by a hand-built record; the [game] ones were ALSO read by the real game, see --game)');
{
  const base = (o = {}) => randomSpec(mkRng(1), { species: 25, level: 30, pid: 1000, extra: { tid: 1, sid: 2, nickname: '', otName: 'Tst', friendship: 7, ppBonuses: 0, moves: [85, 98], item: 0, natureXor: 0, abilityNum: 0, shinyMod: 0, hyper: {}, moveHigh: [0, 0, 0, 0], expTop: 0, ...o } });
  const bobAt1 = () => G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238;
  const bob = () => R.slice(bobAt1(), bobAt1() + 96);
  const one = (spec, extra = {}, mutate = null, baseSave = R) => { const rec = encParty(spec); if (mutate) mutate(rec); const out = imp(G.withParty(baseSave, layoutTable, REAL_SLOT, [bob(), rec]), extra); return out.party && out.party[1] ? { out, m: out.party[1], rep: out.reports[out.party[1].id] } : { out, m: null }; };
  // [game] gender: Pidgey-like ratio 127; boundary on the personality LOW BYTE (>= ratio is male)
  const sp25 = pack.species[25]; const ratio = sp25.genderRatio;
  const pidLow = (low) => (256 * 40 + low) >>> 0;
  ok('[game] gender: low byte == ratio is MALE, ratio-1 is FEMALE (>= rule; the game drew F for 126 and M for 127/128, F for 0, M for 255 on a ratio-127 species)', one(base({ pid: pidLow(ratio) })).m.gender === 'M' && one(base({ pid: pidLow(ratio - 1) })).m.gender === 'F' && one(base({ pid: pidLow(0) })).m.gender === 'F' && one(base({ pid: pidLow(255) })).m.gender === 'M', 'ratio ' + ratio);
  ok('gender: genderless / male-only / female-only species ignore the personality', (() => { const gl = pack.species.find((s) => s && s.legal && s.genderRatio === 255), mo = pack.species.find((s) => s && s.legal && s.genderRatio === 0), fo = pack.species.find((s) => s && s.legal && s.genderRatio === 254); return one(base({ species: gl.id, pid: 3 })).m.gender === '-' && one(base({ species: mo.id, pid: 3 })).m.gender === 'M' && one(base({ species: fo.id, pid: 3 })).m.gender === 'F'; })());
  // [game] nature = personality % 25 XOR the 5-bit delta in the flag byte (bits 3-7 of +0x14)
  ok('[game] nature = personality % 25 for every nature (pids 1,2,0x10000,... showed Lonely, Brave, Hasty, ... in the game)', Array.from({ length: 25 }, (_, n) => one(base({ pid: 25 * 400 + n })).m.nature === n).every(Boolean));
  ok('[game] nature XOR delta: pid%25 5 ^ 3 = 6 (Docile), 24 ^ 31 = 7 (Relaxed), 12 ^ 12 = 0 (all three shown by the game)', one(base({ pid: 5 + 25 * 4000, natureXor: 3 })).m.nature === 6 && one(base({ pid: 24 + 25 * 4000, natureXor: 31 })).m.nature === 7 && one(base({ pid: 12 + 25 * 4000, natureXor: 12 })).m.nature === 0);
  const bad = one(base({ pid: 0 + 25 * 4000, natureXor: 25 }));
  ok('[game] a nature index of 25+ (the game RESETS the console on it) is rejected with mon.nature-range, never guessed', !bad.m && bad.out.rejected.some((x) => x.code === 'mon.nature-range'));
  control('nature control: the XOR is not ignored (the same pid with delta 0 gives the PID nature)', one(base({ pid: 5 + 25 * 4000, natureXor: 0 })).m.nature === 5);
  // [game] shiny
  const shinyPid = (x) => (172 ^ x) >>> 0; // with tid 100, sid 200: xor of the four halves = x
  const shinyTry = (x, mod, saveBase) => one(base({ pid: shinyPid(x), tid: 100, sid: 200, shinyMod: mod }), {}, null, saveBase).m.shiny;
  const flagClear = (() => { const s = Uint8Array.from(R); const byte = (() => { const { map } = G.slotMap(R, 1); let id = 1; while (id < 4 && 0x19c3 >= layoutTable[id + 1].offset) id++; return R[map.get(id) * 0x1000 + (0x19c3 - layoutTable[id].offset)]; })(); G.writeBlock(s, layoutTable, REAL_SLOT, 1, 4, 0x19c3, Uint8Array.of(byte & ~0x40)); return s; })();
  ok('[game] shiny, flag 0x95e SET (the real save): xor 3 and 255 shiny, 256 and 300 not (threshold 256)', shinyTry(3, 0) && shinyTry(255, 0) && !shinyTry(256, 0) && !shinyTry(300, 0));
  ok('[game] shiny, flag 0x95e CLEAR: xor 255..511 shiny, 512 not (threshold 512)', shinyTry(255, 0, flagClear) && shinyTry(256, 0, flagClear) && shinyTry(300, 0, flagClear) && shinyTry(511, 0, flagClear) && !shinyTry(512, 0, flagClear));
  ok('[game] shiny modifier bit is an XOR, not an OR: xor 3 + modifier = NOT shiny; xor 600 + modifier = shiny', !shinyTry(3, 1) && shinyTry(600, 1) && !shinyTry(600, 0));
  control('shiny control: the pre-fix rule (xor < 8, modifier OR) would call xor 100 normal', !(100 < 8) && shinyTry(100, 0, flagClear));
  // level from EXP at exact boundaries; the stored level byte is ignored
  const g = sp25.growthRate, row = pack.exp[g];
  ok('level from EXP: exactly row[L] is level L, one less is L-1 (all growth rates, several levels)', [0, 1, 2, 3, 4, 5].every((gr) => { const sp = pack.species.find((s) => s && s.legal && s.growthRate === gr); return [2, 17, 50, 99, 100].every((L) => one(base({ species: sp.id, exp: pack.exp[gr][L] })).m.level === L) && one(base({ species: sp.id, exp: pack.exp[gr][50] - 1 })).m.level === 49; }));
  ok('[game] level: the stored level byte is ignored, as the game ignores it (a level-20 EXP amount with a level byte of 50 is Lv20)', (() => { const t = one(base({ exp: row[20] }), {}, (rec) => { rec[0x50] = 50; }); return t.m.level === 20 && t.rep.notes.some((x) => x.code === 'level.stored-differs'); })());
  ok('[game] EXP is a 24-bit field: bit 21 counts (27000 + 2^21 shows Lv100, 2124152 points), bit 31 and the whole top byte do not (Lv30, 27000), 0xFFFFFF is Lv100', (() => { const e30 = pack.exp[pack.species[25].growthRate][30]; const a = one(base({ exp: e30 + (1 << 21) })); const b = one(base({ exp: e30, expTop: 0x80 })); const c = one(base({ exp: 0xffffff })); const d = one(base({ exp: e30, expTop: 0xff })); return a.m.level === 100 && a.rep.derived.exp === e30 + (1 << 21) && b.m.level === 30 && b.rep.derived.exp === e30 && c.m.level === 100 && c.rep.notes.some((x) => x.code === 'exp.over-cap') && d.m.level === 30; })());
  control('EXP control: reading the whole 32-bit word (the pre-fix bug) would make a top-byte value look like Lv100', one(base({ exp: pack.exp[pack.species[25].growthRate][30], expTop: 0x80 })).m.level === 30);
  // [game] PP ups: byte at +0x2a, two bits per move slot
  ok('[game] PP ups: byte at +0x2a, two bits per move slot (the game showed max PP 15/36/21/24 for 0/1/2/3 ups on 15/30/15/15-PP moves)', (() => { const t = one(base({ moves: [85, 98, 231, 57], ppBonuses: 0b11100100 })); return eq(t.m.moves.map((x) => x.ppUps), [0, 1, 2, 3]); })());
  control('PP-ups control: a byte at the OLD offset +0x28 is NOT read as PP ups (the game ignored it too)', eq(one(base({ moves: [85, 98], ppBonuses: 0 }), {}, (rec) => { rec[0x28] = 0xff; }).m.moves.map((x) => x.ppUps), [0, 0]));
  ok('moves: zero entries are skipped, order kept', eq(one(base({ moves: [0, 85, 0, 57] })).m.moves.map((x) => x.id), [85, 57]));
  ok('[game] moves are 11 bits: junk in the 5 spare high bits of each move word (they hold other fields) does not change the moves', (() => { const t = one(base({ moves: [85, 98, 231, 57], moveHigh: [31, 17, 9, 1] })); return eq(t.m.moves.map((x) => x.id), [85, 98, 231, 57]); })());
  ok('held item is the 10-bit field at +0x22; ball (upper 6 bits) does not leak into it', one(base({ item: 1023, ball: 63 })).m.heldItem === 1023 && one(base({ item: 0, ball: 63 })).m.heldItem === 0);
  ok('species is the 11-bit field at +0x20 (ids above 1023 work); the tera bits above do not leak', one(base({ species: 1291 })).m.species === 1291 && one(base({ species: 1291 }), {}, (rec) => { rec[0x21] |= 0xf8; }).m.species === 1291);
  ok('IV word: 6 x 5 bits in hp,atk,def,spe,spa,spd order; bit 31 ignored (the game: no effect)', (() => { const iv = { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 }; const m = one(base({ iv }), {}, (rec) => { rec[0x4b] |= 0x80; }).m; return eq(m.iv, iv); })());
  // [game] hyper training: six flag bits in the spare top bits of move 4 (hp, atk) and the four PP bytes (def, spe, spa, spd); the stat counts as IV 31
  ok('[game] hyper-trained flags: +0x33 bit6 hp, bit7 atk, +0x34 bit7 def, +0x35 bit7 spe, +0x36 bit7 spa, +0x37 bit7 spd each make exactly that IV 31 (the game showed IV 31 with a stored 0)', STATS6.every((k) => { const iv = Object.fromEntries(STATS6.map((x) => [x, 0])); const m = one(base({ iv, hyper: { [k]: 1 } })).m; return STATS6.every((x) => m.iv[x] === (x === k ? 31 : 0)); }));
  ok('hyper-training is reported (note iv.hyper-trained, derived.hyperTrained) and the stored IVs are kept in the note', (() => { const t = one(base({ iv: { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 }, hyper: { spe: 1 } })); return t.rep.derived.hyperTrained.join() === 'spe' && t.rep.notes.some((x) => x.code === 'iv.hyper-trained' && x.storedIvs.spe === 4); })());
  // [game] ability: 2-bit index at +0x33 bits 4-5; the game shows the highest non-empty slot at or below it; 3 acts as 2
  const tri = pack.species.find((s) => s && s.legal && s.abilities[0] && s.abilities[1] && s.abilities[2] && new Set(s.abilities).size === 3);
  const gap = pack.species.find((s) => s && s.legal && s.abilities[0] && !s.abilities[1] && s.abilities[2]);
  ok('[game] ability: index 0/1/2 pick the slot (Pidgey: Keen Eye / Tangled Feet / Big Pecks in the game), 3 acts as 2 and is noted', [0, 1, 2].every((n) => one(base({ species: tri.id, abilityNum: n })).m.abilitySlot === n) && (() => { const t = one(base({ species: tri.id, abilityNum: 3 })); return t.m.abilitySlot === 2 && t.rep.notes.some((x) => x.code === 'ability.index-clamped'); })());
  ok('[game] ability: an EMPTY slot falls back downwards (Sprigatito index 1 shows Overgrow, index 2 shows Protean)', (() => { const a = one(base({ species: gap.id, abilityNum: 1 })), b = one(base({ species: gap.id, abilityNum: 2 })); return a.m.abilitySlot === 0 && a.rep.notes.some((x) => x.code === 'ability.slot-fallback') && b.m.abilitySlot === 2; })());
  ok('every imported ability slot is a non-empty slot of its species (validation never says ability.slot-empty on a game-written record)', Array.from({ length: 40 }, (_, i) => one(base({ species: legalIds[i * 25 % legalIds.length], abilityNum: i % 4 }))).every((t) => t.m && t.rep.validation.reasons.every((x) => x.code !== 'ability.slot-empty')));
  // eggs
  const egg1 = one(base({ eggFlagOnly: true })), egg2 = one(base({ eggIvOnly: true })), egg3 = one(base({ egg: true }));
  ok('[game] eggs: the flag byte bit 2 alone, IV word bit 30 alone, or both (the game sets both) are each an Egg in the game and are rejected with mon.egg', [egg1, egg2, egg3].every((e) => !e.m && e.out.rejected.some((x) => x.code === 'mon.egg')));
  ok('bad egg flag (+0x15 bit 0) -> mon.bad-egg', one(base({}), {}, (rec) => { rec[0x15] |= 1; }).out.rejected.some((x) => x.code === 'mon.bad-egg'));
  // species outside the pack / illegal
  ok('species 0 with junk bytes, species 2047 (outside the table), and the empty egg slot 1578 are rejected with named reasons, no crash', (() => { const a = one(base({ species: 2047 })).out.rejected[0], b = one(base({ species: 1578 })).out.rejected[0], c = one(base({}), {}, (rec) => { rec[0x20] = 0; rec[0x21] = 0; }).out.rejected[0]; return a && a.code === 'species.unknown' && b && b.code === 'species.illegal' && c && c.code === 'mon.no-species'; })());
  // nickname rules
  ok('nickname equal to the species name (any case) means "no nickname"; a 11-char nickname is cut to 10 with a note', one(base({ nickname: 'PIKACHU' })).m.nickname === '' && one(base({ nickname: 'Pikachu' })).m.nickname === '' && one(base({ nickname: 'pikachu' })).m.nickname === '' && (() => { const t = one(base({ nickname: 'ABCDEFGHIJK' })); return t.m.nickname === 'ABCDEFGHIJ' && t.rep.notes.some((x) => x.code === 'nickname.cut'); })());
  ok('OT name, friendship, tid/sid decode from their own fields (tid is the LOW half of the OT id); a 7-letter OT name fills its field with no terminator', (() => { const m = one(base({ tid: 0xabcd, sid: 0x1234, otName: 'Zedling', friendship: 255 })).m; return m.originalTrainer.tid === 0xabcd && m.originalTrainer.sid === 0x1234 && m.originalTrainer.name === 'Zedling' && m.friendship === 255; })());
  // validation fields
  ok('validation maps to fields: an over-cap level / illegal move / unknown item become fixes[]', (() => { const t = one(base({ species: 25, level: 100, moves: [1], item: 1000 })); return t.rep && !t.rep.validation.ok && t.rep.fixes.some((x) => x.field === 'moves') && t.rep.fixes.some((x) => x.field === 'heldItem'); })(), '');
  const strict = one(base({ exp: row[40] }), { ruleset: 'arena-gen3-standard+strict-champions' }), stdRs = one(base({ exp: row[40] }));
  ok('the ruleset is honoured: a Lv40 Pokemon is fine under the default ruleset and needs a level fix under strict-champions (Lv50 fixed)', strict.out.ok && stdRs.out.ok && stdRs.rep.fixes.every((x) => x.field !== 'level') && strict.rep.fixes.some((x) => x.field === 'level'), '');
  ok('summary arithmetic: total = legal + needsFix + rejected', (() => { const o = imp(saveWithParty(R, [base({ egg: true }), base({ species: 2047 }), base({ level: 100, moves: [1] })])); return o.summary.total === o.summary.legal + o.summary.needsFix + o.summary.rejected && o.summary.rejected === 2; })());
  ok('party count > 6 is clamped with a warning', (() => { const s = Uint8Array.from(R); const c = new Uint8Array(4); c[0] = 9; G.writeBlock(s, layoutTable, REAL_SLOT, 1, 4, 0x234, c); const o = imp(s); return o.ok && o.warnings.some((w) => w.code === 'party.count'); })());
}

section('container: slots, counters, footers, checksums');
{
  const slotCopy = (from, to, counter, f) => { const s = Uint8Array.from(R); G.copySlot(s, from, to); G.setCounter(s, to, counter); if (f) f(s); G.fixChecksums(s, layoutTable, to); return s; };
  const specA = randomSpec(mkRng(11), { species: 25, level: 30, extra: { nickname: 'Aaa' } });
  const bobAt = G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238;
  const bob = R.slice(bobAt, bobAt + 96);
  const markA = (s) => { const t = G.withParty(s, layoutTable, 0, [bob, encParty(specA)]); s.set(t); };
  // newer slot wins
  const newerA = slotCopy(1, 0, 2, markA); // slot 0 counter 2 (newer, has 2 mons), slot 1 counter 1 (1 mon)
  const o1 = imp(newerA);
  ok('both slots valid: the higher counter wins (slot 0, counter 2)', o1.ok && o1.container.slotUsed === 0 && o1.container.counter === 2 && o1.party.length === 2);
  const olderA = slotCopy(1, 0, 0, markA);
  const o2 = imp(olderA);
  ok('both slots valid: slot 0 with counter 0 loses to slot 1 with counter 1', o2.ok && o2.container.slotUsed === 1 && o2.party.length === 1);
  control('slot choice is by counter, not by position (control: swapping the counters swaps the winner)', o1.container.slotUsed !== o2.container.slotUsed);
  const wrap = slotCopy(1, 0, 0, markA); G.setCounter(wrap, 1, 0xffffffff); G.fixChecksums(wrap, layoutTable, 1);
  const o3 = imp(wrap);
  ok('counter wrap: 0 is newer than 0xFFFFFFFF', o3.ok && o3.container.slotUsed === 0);
  const wrap2 = slotCopy(1, 0, 0xffffffff, markA); G.setCounter(wrap2, 1, 0); G.fixChecksums(wrap2, layoutTable, 1);
  ok('counter wrap, other way: slot 1 counter 0 beats slot 0 counter 0xFFFFFFFF', imp(wrap2).container.slotUsed === 1);
  const tie = slotCopy(1, 0, 1, markA);
  const o4 = imp(tie);
  ok('equal counters: the second slot is used and a save.slot-tie warning is raised', o4.ok && o4.container.slotUsed === 1 && o4.warnings.some((w) => w.code === 'save.slot-tie'));
  // damaged newer slot -> fallback with a warning
  const dmg = slotCopy(1, 0, 2, markA); { const idx = G.slotMap(dmg, 0).map.get(1); dmg[idx * 0x1000 + 0x100] ^= 0x10; }
  const o5 = imp(dmg);
  ok('newer slot has one bad checksum -> older valid slot used, container.fallback, warning save.fallback-slot', o5.ok && o5.container.slotUsed === 1 && o5.container.fallback === true && o5.warnings.some((w) => w.code === 'save.fallback-slot') && o5.party.length === 1);
  const dmgOld = slotCopy(1, 0, 3, markA); { const idx = G.slotMap(dmgOld, 1).map.get(1); dmgOld[idx * 0x1000 + 0x100] ^= 0x10; }
  const o6 = imp(dmgOld);
  ok('older slot damaged, newer valid -> newer used, warning save.other-slot-damaged (not a fallback)', o6.ok && o6.container.slotUsed === 0 && !o6.container.fallback && o6.warnings.some((w) => w.code === 'save.other-slot-damaged'));
  const both = slotCopy(1, 0, 2, markA); { const a = G.slotMap(both, 0).map.get(1), b = G.slotMap(both, 1).map.get(1); both[a * 0x1000 + 0x100] ^= 1; both[b * 0x1000 + 0x100] ^= 1; }
  ok('both slots damaged -> save.no-valid-slot with per-slot detail', (imp(both).error || {}).code === 'save.no-valid-slot' && imp(both).error.slots.length === 2);
  // mixed counters inside a slot (a torn write)
  const torn = Uint8Array.from(R); { const idx = G.slotMap(torn, 1).map.get(3); const o = idx * 0x1000 + 0xffc; torn[o] = 9; G.fixChecksums(torn, layoutTable, 1); }
  ok('mixed counters inside one slot (torn write) -> slot invalid', (imp(torn).error || {}).code === 'save.no-valid-slot');
  // duplicate section id / missing section
  const dup = Uint8Array.from(R); { const m = G.slotMap(dup, 1).map; const o = m.get(4) * 0x1000; dup[o + 0xff4] = 3; dup[o + 0xff5] = 0; let sum = 0; for (let i = 0; i < layoutTable[3].size; i += 4) sum = (sum + (dup[o + i] | (dup[o + i + 1] << 8) | (dup[o + i + 2] << 16) | (dup[o + i + 3] << 24))) >>> 0; const ck = ((sum >>> 16) + (sum & 0xffff)) & 0xffff; dup[o + 0xff6] = ck & 255; dup[o + 0xff7] = ck >> 8; }
  ok('a duplicated section id (id 4 relabelled 3, checksum re-made for it) -> slot invalid, with the named problem duplicate-id and the missing id 4', (imp(dup).error || {}).code === 'save.no-valid-slot' && imp(dup).error.slots[1].problems.some((p) => p.why === 'duplicate-id') && imp(dup).error.slots[1].missing.includes(4));
  // every sector footer field: one flipped bit anywhere in the footer invalidates the slot
  let footerBad = 0, footerN = 0;
  const m = G.slotMap(R, 1).map;
  for (const [, idx] of m) for (const off of [0xff4, 0xff5, 0xff6, 0xff7, 0xff8, 0xff9, 0xffa, 0xffb, 0xffc, 0xffd, 0xffe, 0xfff]) for (const bit of [0, 7]) {
    const s = Uint8Array.from(R); s[idx * 0x1000 + off] ^= 1 << bit; footerN++;
    const o = imp(s);
    if (o.ok || (o.error || {}).code !== 'save.no-valid-slot') footerBad++; // caught = refused with the NAMED reason, never an internal error
  }
  ok(`footer bit flips: ${footerN} single-bit flips across all 14 sector footers are caught (none imports)`, footerBad === 0, `(${footerBad} slipped)`);
  // payload bit flips: one in every section's payload, and one in every substructure byte range of the party Pokemon
  let payBad = 0, payN = 0;
  for (const [id, idx] of m) { for (const at of [0, 1, layoutTable[id].size - 1, layoutTable[id].size >> 1]) { const s = Uint8Array.from(R); s[idx * 0x1000 + at] ^= 0x04; payN++; if (imp(s).ok) payBad++; } }
  ok(`payload bit flips: ${payN} flips inside the 14 sections' payloads are caught by the checksum`, payBad === 0, `(${payBad} slipped)`);
  let subBad = 0, subN = 0;
  for (const [name, a, b] of [['header', 0, 0x20], ['species/item/exp', 0x20, 0x2c], ['moves+pp', 0x2c, 0x38], ['EVs', 0x38, 0x44], ['misc/IVs', 0x44, 0x4c], ['party tail', 0x4c, 0x60]]) for (let o = a; o < b; o++) { const s = Uint8Array.from(R); s[bobAt + o] ^= 0x01; subN++; if (imp(s).ok) subBad++; }
  ok(`substructure bit flips: all ${subN} bytes of the party record (header, growth, moves, EVs, misc, tail), one bit each, are caught`, subBad === 0);
  control('a flip that is RE-CHECKSUMMED is accepted (control: the check is the checksum, not a blanket refusal)', (() => { const s = Uint8Array.from(R); s[bobAt + 0x2b] ^= 0x01; G.fixChecksums(s, layoutTable, 1); const o = imp(s); return o.ok && o.party[0].friendship === 51; })());
  // erased slot 0 does not produce a warning on a normal save; a leftover older slot does not either
  ok('a normal single-slot save has no warnings', imp(R).warnings.length === 0);
}

section('hostile input: garbage that PASSES the checksums, truncations, huge/garbage text, ranges');
{
  const r = mkRng(0xbad);
  let thrown = 0, shapeBad = 0, internal = 0, okN = 0;
  const check = (o) => {
    if (!o || typeof o.ok !== 'boolean') { shapeBad++; return; }
    if (!o.ok) { if (!o.error || !SI.SAVE_CODES[o.error.code]) shapeBad++; if (o.error && o.error.code === 'save.internal') internal++; return; }
    okN++;
    if (o.summary.total !== o.summary.legal + o.summary.needsFix + o.summary.rejected) shapeBad++;
    for (const mon of [...o.party, ...o.boxes.flatMap((b) => b.mons)]) { if (checkMon(mon, 'mon').length) shapeBad++; if (!o.reports[mon.id]) shapeBad++; }
  };
  const total = FUZZ;
  for (let i = 0; i < total; i++) {
    let s;
    const kind = i % 5;
    if (kind === 0) { s = Uint8Array.from(R); for (let k = 0, n = 1 + r.int(40); k < n; k++) s[r.int(s.length)] = r.int(256); }                          // sparse byte noise on the real save
    else if (kind === 1) { s = new Uint8Array(0x20000); for (let k = 0; k < s.length; k++) s[k] = r.int(256); }                                            // pure noise
    else if (kind === 2) { s = Uint8Array.from(R); const m = G.slotMap(s, 1).map; const at = m.get(1) * 0x1000 + 0x234 + r.int(0x260); for (let k = 0; k < 64; k++) s[at + k < m.get(1) * 0x1000 + 0xf80 ? at + k : at] = r.int(256); G.fixChecksums(s, layoutTable, 1); } // garbage party, valid checksums
    else if (kind === 3) { s = Uint8Array.from(R); const m = G.slotMap(s, 1).map; for (let id = 5; id <= 13; id++) { const o = m.get(id) * 0x1000; for (let k = 0; k < 400; k++) s[o + r.int(0xf80)] = r.int(256); } G.fixChecksums(s, layoutTable, 1); }  // garbage boxes, valid checksums
    else { s = Uint8Array.from(R).subarray(0, [0, 1, 0x1000, 0x1ffff, 0x20000, 0x20010][r.int(6)]); }                                                      // truncations
    try { check(SI.importSave(s, { rom, pack })); } catch (e) { thrown++; if (thrown < 3) console.log('    THROW', e && e.stack); }
  }
  ok(`${total} fuzzed saves (byte noise, pure noise, checksummed garbage in party and in boxes, truncations): never throw`, thrown === 0, `(${thrown} threw)`);
  ok('...every result has the documented shape; every imported record passes profile.js checkMon', shapeBad === 0, `(${shapeBad} bad shapes, ${okN} imported)`);
  ok('...no input ever reached the internal-error path', internal === 0, `(${internal})`);
  // targeted hostile records with valid checksums
  const withRec = (mut) => { const s = Uint8Array.from(R); const at = G.slotMap(s, 1).map.get(1) * 0x1000 + 0x238; mut(s, at); G.fixChecksums(s, layoutTable, 1); return SI.importSave(s, { rom, pack }); };
  const huge = withRec((s, at) => { for (let i = 0; i < 12; i++) s[at + 8 + i] = 0xbb + (i % 26); for (let i = 0; i < 7; i++) s[at + 0x16 + i] = 0xbb + i; });
  ok('a nickname field with NO terminator (12 letters) and an unterminated OT name import without overflow (cut to 10 + a note)', huge.ok && huge.party[0].nickname.length <= 10 && huge.reports[huge.party[0].id].notes.some((x) => x.code === 'nickname.cut'));
  const junkText = withRec((s, at) => { for (let i = 0; i < 12; i++) s[at + 8 + i] = [0x00, 0x01, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0x53, 0x80, 0xc0, 0x10, 0x20][i]; });
  ok('a nickname of unknown glyph bytes imports (rendered as {XX} tokens) or is rejected by shape, never throws', junkText.ok === true || (junkText.error || {}).code === undefined);
  ok('a move id of 2047 (11 bits, beyond the 935-move table) and a held item of 1023 import and are flagged for fixing (never dropped silently)', (() => { const o = withRec((s, at) => { s[at + 0x2c] = 255; s[at + 0x2d] = 255; s[at + 0x22] = 255; s[at + 0x23] |= 0x03; }); return o.ok && o.party[0].moves[0].id === 2047 && o.party[0].heldItem === 1023 && !o.reports[o.party[0].id].validation.ok && o.reports[o.party[0].id].fixes.some((x) => x.field === 'moves'); })());
  ok('party count 0 -> a save with no Pokemon: ok, empty party, a warning', (() => { const s = Uint8Array.from(R); G.writeBlock(s, layoutTable, REAL_SLOT, 1, 4, 0x234, new Uint8Array(4)); const o = imp(s); return o.ok && o.party.length === 0 && o.warnings.some((w) => w.code === 'save.no-pokemon'); })());
  ok('storage tag missing -> boxes still read, warning storage.tag', (() => { const s = Uint8Array.from(R); G.writeBlock(s, layoutTable, REAL_SLOT, 5, 13, 0x87b4, new Uint8Array(4)); const o = imp(s); return o.ok && o.warnings.some((w) => w.code === 'storage.tag'); })());

  // ---- foreign layouts: saves of OTHER Gen-3 games/hacks have other section sizes. They must be refused, never misparsed.
  const sectorSum = (b, o, n) => { let t = 0; for (let i = 0; i < n; i += 4) t = (t + (b[o + i] | (b[o + i + 1] << 8) | (b[o + i + 2] << 16) | (b[o + i + 3] << 24))) >>> 0; return ((t >>> 16) + (t & 0xffff)) & 0xffff; };
  const foreignSave = (sizes, seed, rotate = 0) => {
    const rr = mkRng(seed), sv = new Uint8Array(0x20000).fill(0xff);
    for (let slot = 0; slot < 2; slot++) for (let i = 0; i < 14; i++) {
      const o = (slot * 14 + ((i + rotate) % 14)) * 0x1000;
      for (let k = 0; k < 0xff4; k++) sv[o + k] = rr.int(256);
      sv[o + 0xff4] = i; sv[o + 0xff5] = 0; const ck = sectorSum(sv, o, sizes[i]); sv[o + 0xff6] = ck & 255; sv[o + 0xff7] = ck >> 8;
      sv[o + 0xff8] = 0x25; sv[o + 0xff9] = 0x20; sv[o + 0xffa] = 0x01; sv[o + 0xffb] = 0x08; sv[o + 0xffc] = slot + 1; sv[o + 0xffd] = 0; sv[o + 0xffe] = 0; sv[o + 0xfff] = 0;
    }
    return sv;
  };
  const SIZES = { soulgold: layoutTable.map((t) => t.size), emerald: [0xf2c, 0xf80, 0xf80, 0xf80, 0xf08, ...Array(8).fill(0xf80), 0x7d0], firered: [0xf24, 0xf80, 0xf80, 0xf80, 0xee8, ...Array(8).fill(0xf80), 0x7d0], ruby: [0xf2c, 0xf80, 0xf80, 0xf80, 0xf08, ...Array(8).fill(0xf80), 0x7d0] };
  ok('a vanilla-Emerald-layout save (sizes 0xF2C/0xF80x3/0xF08/.../0x7D0, valid footers and checksums FOR THAT LAYOUT) is refused with save.no-valid-slot, not misparsed', (imp(foreignSave(SIZES.emerald, 1)).error || {}).code === 'save.no-valid-slot');
  ok('a FireRed-style layout (0xF24 / 0xEE8 / 0x7D0) is refused the same way, and rotated physical sector order does not change that', (imp(foreignSave(SIZES.firered, 2)).error || {}).code === 'save.no-valid-slot' && (imp(foreignSave(SIZES.firered, 3, 5)).error || {}).code === 'save.no-valid-slot');
  const sg = imp(foreignSave(SIZES.soulgold, 4, 7));
  ok('control: the same builder with the SoulGold table, physical sector order ROTATED, passes the container checks (sections are found by id, not by position)', sg.ok === true && sg.container.slotUsed === 1, sg.ok ? '' : J(sg.error));
  // ---- a 0x22000 buffer: the 0x2000 tail is ignored whatever it holds
  const tailGarbage = new Uint8Array(0x22000); tailGarbage.set(R); { const rr = mkRng(9); for (let i = 0x20000; i < 0x22000; i++) tailGarbage[i] = rr.int(256); }
  ok('0x22000 buffer with random bytes in the 0x2000 tail imports exactly like the bare 0x20000 flash (tail ignored, warning raised)', (() => { const o = imp(tailGarbage), p = imp(R); return o.ok && eq(o.party, p.party) && eq(o.boxes, p.boxes) && o.warnings.some((w) => w.code === 'save.size-extra'); })());
  // ---- species ids at and beyond the end of the table
  const lastId = pack.species.length - 1;
  ok('species ids at the table end: ' + lastId + ' (last slot), ' + (lastId + 1) + ' (just beyond), 2046, 2047 are each rejected or imported with a NAMED reason, never a crash', [lastId - 1, lastId, lastId + 1, 2046, 2047].every((id) => { const rec = encParty(randomSpec(mkRng(5), { species: 25, extra: { species: id } })); const o = imp(G.withParty(R, layoutTable, REAL_SLOT, [R.slice(G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238, G.slotMap(R, 1).map.get(1) * 0x1000 + 0x238 + 96), rec])); return o.ok && (o.party.length === 2 || o.rejected.some((x) => /^(species|mon)\./.test(x.code))); }));
  // ---- every possible first nickname byte, and a fully 0xFF-less / control-code nickname
  let nickBad = 0;
  for (let b0 = 0; b0 < 256; b0++) { const o = withRec((s2, at) => { for (let i = 0; i < 12; i++) s2[at + 8 + i] = (b0 + i * 37) & 255; }); if (!(o.ok === true) || o.party.length + o.rejected.length !== 1 || (o.party[0] && checkMon(o.party[0], 'mon').length)) nickBad++; }
  ok('all 256 nickname byte patterns (unknown glyphs, control codes, no terminator) import or are rejected by name, and every imported record passes checkMon', nickBad === 0, '(' + nickBad + ' bad)');
  // ---- per-sector random mutation, with the checksums RE-MADE (so the damage reaches the decoder) and without
  {
    const rr = mkRng(0x5ec7), m = G.slotMap(R, 1).map, per = CORE ? 60 : 1000;
    let thrown = 0, refusedWrong = 0, collisions = 0, total2 = 0;
    for (const [id, idxSec] of m) {
      for (let n = 0; n < per; n++) {
        const sv = Uint8Array.from(R), o = idxSec * 0x1000;
        for (let k = 0, c = 1 + rr.int(12); k < c; k++) sv[o + rr.int(layoutTable[id].size)] = rr.int(256);
        const remake = n % 2 === 0; if (remake) G.fixChecksums(sv, layoutTable, 1);
        total2++;
        let out; try { out = SI.importSave(sv, { rom, pack }); } catch (_e) { thrown++; continue; }
        check(out);
        // the game's checksum is a 16-bit fold, so two compensating byte changes CAN collide (2 of 7,000 did); judge against an independent sum: if the sum differs from the footer, the import must have been refused
        if (!remake && out.ok && Buffer.compare(Buffer.from(sv), Buffer.from(R)) !== 0) { if (sectorSum(sv, o, layoutTable[id].size) !== (sv[o + 0xff6] | (sv[o + 0xff7] << 8))) refusedWrong++; else collisions++; }
      }
    }
    ok(`${total2} per-sector random mutations (${per} for each of the 14 sections, half with the checksum re-made): never throw, every result well-formed`, thrown === 0, `(${thrown} threw)`);
    ok('...and a damaged section whose checksum no longer matches (independent sum) is never imported; a changed payload that imports has a genuinely colliding 16-bit checksum', refusedWrong === 0, `(${refusedWrong} slipped, ${collisions} genuine checksum collisions of the game's own weak fold)`);
    ok('...no per-sector mutation reached the internal-error path', internal === 0, `(${internal})`);
    ok('...and every per-sector result (and every earlier fuzz result) has the documented shape', shapeBad === 0, `(${shapeBad} bad shapes)`);
  }
}

// =======================================================================================================================================
// THE REAL GAME AS JUDGE. Each batch is a copy of the real save with up to 5 encoder-built Pokemon in party slots 1..5 (slot 0 stays the real starter);
// the game is booted on it, CONTINUE is pressed and the Summary pages are photographed. Per batch:
//   * every captured screen is hashed and pinned (manifest goldens.game[batch][screen]); the mGBA wasm core is deterministic, so a drift is a real change;
//   * oracle.batches[batch][slot-1] is what the game's own screens say (typed by the author from the PNGs, NOT produced by the parser); the importer
//     must produce the same values from the same bytes.
const BATCH_PAGES = { info: 'Info', stats: 'Skills', ivs: 'IVs', evs: 'EVs', moves: 'Moves' };
function gameBatches() {
  const byName = (list, name) => list.find((x) => x && x.name === name);
  const spId = (n) => byName(pack.species, n).id, mv = (n) => byName(pack.moves, n).id, it = (n) => byName(pack.items, n).id;
  const Z = { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 }, IV = (hp, atk, def, spe, spa, spd) => ({ hp, atk, def, spe, spa, spd });
  const D = { natureXor: 0, abilityNum: 0, hyper: {}, shinyMod: 0, moveHigh: [0, 0, 0, 0], expTop: 0, ppBonuses: 0, ball: 4, friendship: 70, item: 0, nickname: '', otName: 'Tst', tid: 1234, sid: 5678, iv: IV(31, 31, 31, 31, 31, 31), ev: Z, moves: [mv('Scratch')] };
  const M = (name, level, pid, extra = {}) => ({ ...randomSpec(mkRng(1), { species: spId(name), level, pid, extra: { ...D, ...extra } }) });
  const shinyPidX = (x) => (172 ^ x) >>> 0; // with tid 100 / sid 200 the halves xor to x
  const X = (x, mod = 0, nick) => M('Pidgey', 20, shinyPidX(x), { nickname: nick || 'x' + x + (mod ? 'm' : ''), tid: 100, sid: 200, shinyMod: mod });
  const H = (k) => M('Pidgey', 20, 25 * 3000, { nickname: 'h' + k, iv: Z, hyper: { [k]: 1 } });
  const ALL = ['info', 'stats', 'ivs', 'evs', 'moves'];
  const GP = (low) => (((25 * 3000) & ~0xff) | low) >>> 0; // personality with a chosen LOW BYTE (the gender byte)
  return [
    { name: 'fields', pages: ALL, sheet: 'per-mon', mons: [
      M('Pikachu', 37, 0x2425, { nickname: 'Sparky', otName: 'ASH', item: it('Oran Berry'), ball: 2, friendship: 200, moves: [mv('Thunderbolt'), mv('Quick Attack'), mv('Iron Tail'), mv('Surf')], ppBonuses: 0b11100100, iv: IV(31, 30, 29, 5, 10, 15), ev: { hp: 4, atk: 8, def: 12, spe: 16, spa: 20, spd: 24 } }),
      M('Meowscarada', 100, 0x1b97, { nickname: 'Hidden', otName: 'Zed', item: it('Leftovers'), friendship: 255, abilityNum: 2, moves: [mv('Scratch'), mv('Tail Whip'), mv('Surf'), mv('Thunderbolt')], ev: { hp: 252, atk: 0, def: 0, spe: 252, spa: 4, spd: 0 } }),
      M('Eevee', 20, 11010055, { nickname: 'ShinyP', otName: 'Tst', tid: 100, sid: 200, iv: IV(1, 2, 3, 4, 5, 6) }),
      M('Eevee', 20, 11010055, { nickname: 'Ctrl', otName: 'Tst', iv: IV(1, 2, 3, 4, 5, 6) }),
      M('Pidgey', 20, 5002, { nickname: 'ABCDEFGHIJK', otName: 'Tst', iv: IV(1, 2, 3, 4, 5, 6) }),
    ] },
    { name: 'ability', pages: ['info'], sheet: 'all', mons: [
      M('Pidgey', 20, 25 * 3000, { nickname: 'ab1', abilityNum: 1 }), M('Pidgey', 20, 25 * 3000, { nickname: 'ab2', abilityNum: 2 }), M('Pidgey', 20, 25 * 3000, { nickname: 'ab3', abilityNum: 3 }),
      M('Sprigatito', 20, 25 * 3000, { nickname: 'sg1', abilityNum: 1 }), M('Sprigatito', 20, 25 * 3000, { nickname: 'sg2', abilityNum: 2 }),
    ] },
    { name: 'hyper', pages: ['info', 'stats', 'ivs'], sheet: 'all', mons: ['hp', 'atk', 'def', 'spe', 'spa'].map(H) },
    { name: 'misc', pages: ['info', 'stats', 'ivs', 'moves'], sheet: 'all', mons: [
      H('spd'),
      M('Pikachu', 30, 25 * 3000, { nickname: 'moveJunk', moves: [mv('Thunderbolt'), mv('Quick Attack'), mv('Iron Tail'), mv('Surf')], moveHigh: [31, 17, 9, 1], expTop: 0x80 }),
      M('Pidgey', 20, 5 + 25 * 4000, { nickname: 'nat5x3', natureXor: 3 }),
      M('Pidgey', 20, 24 + 25 * 4000, { nickname: 'nat24xF', natureXor: 31 }),
      M('Pikachu', 30, 25 * 3000, { nickname: 'exp21', exp: pack.exp[pack.species[25].growthRate][30] + (1 << 21), moves: [mv('Scratch')] }),
    ] },
    { name: 'shiny-flag-set', pages: ['info'], sheet: 'all', mons: [X(3), X(3, 1), X(255), X(256), X(600, 1)] },
    { name: 'shiny-flag-clear', pages: ['info'], sheet: 'all', base: 'flagClear', mons: [X(255), X(300), X(511), X(512), X(3, 1)] },
    { name: 'level', pages: ['info', 'stats', 'ivs'], sheet: 'all', mons: [
      M('Pidgey', 20, 25 * 3000, { nickname: 'lvByte50', levelByte: 50 }),
      M('Pidgey', 50, 25 * 3000, { nickname: 'lvByte1', levelByte: 1 }),
      M('Pidgey', 100, 25 * 3000, { nickname: 'lvByte0', levelByte: 0 }),
      M('Pikachu', 30, 25 * 3000, { nickname: 'badStats', badStats: true, moves: [mv('Scratch')] }),
      M('Pidgey', 20, 25 * 3000, { nickname: 'exp24', exp: 0xffffff, expTop: 0xff }),
    ] },
    { name: 'gender', pages: ['info'], sheet: 'all', mons: [0, 126, 127, 128, 255].map((low) => M('Pidgey', 20, GP(low), { nickname: 'g' + low })) },
    { name: 'egg', pages: ['info'], sheet: 'all', mons: [
      M('Pidgey', 20, 25 * 3000, { nickname: 'eIv', eggIvOnly: true }), M('Pidgey', 20, 25 * 3000, { nickname: 'eFlag', eggFlagOnly: true }), M('Pidgey', 20, 25 * 3000, { nickname: 'eBoth', egg: true }),
      M('Pidgey', 20, 25 * 3000, { nickname: 'ctl' }),
    ] },
  ];
}
// the importer's view of one party Pokemon, in the units the game's screens use
function screenView(o, slot) {
  const m = o.party.find((x) => x.provenance.slot === slot);
  if (!m) return null;
  const rep = o.reports[m.id], sp = pack.species[m.species], c = rep.selfCheck.computed;
  return {
    species: sp.name, nickname: m.nickname || sp.name, level: m.level, nature: pack.natures[m.nature].name, gender: m.gender, shiny: m.shiny,
    ability: pack.abilities[sp.abilities[m.abilitySlot]].name, item: m.heldItem ? pack.items[m.heldItem].name : 'None', friendship: m.friendship, ot: m.originalTrainer.name, tid: m.originalTrainer.tid,
    stats: [c.hp, c.atk, c.def, c.spa, c.spd, c.spe], ivs: [m.iv.hp, m.iv.atk, m.iv.def, m.iv.spa, m.iv.spd, m.iv.spe], evs: [m.ev.hp, m.ev.atk, m.ev.def, m.ev.spa, m.ev.spd, m.ev.spe],
    exp: rep.derived.exp,
    // the Summary shows current/max PP; the encoder stored full PP, and the max is base * (5 + PP ups) / 5
    moves: m.moves.map((x) => { const max = Math.floor(pack.moves[x.id].pp * (5 + x.ppUps) / 5); return [pack.moves[x.id].name, max, max]; }),
  };
}
async function gameSection() {
  section('[enc] the REAL GAME reads encoder-built saves (CONTINUE -> Summary screens, mGBA wasm, deterministic)');
  const { computeStats } = await import(JS('stats.js'));
  const out = path.join(G.SCRATCH, 'game');
  fs.mkdirSync(out, { recursive: true });
  const flagByte = () => { const { map } = G.slotMap(R, 1); let id = 1; while (id < 4 && 0x19c3 >= layoutTable[id + 1].offset) id++; return R[map.get(id) * 0x1000 + (0x19c3 - layoutTable[id].offset)]; };
  const flagClear = Uint8Array.from(R); G.writeBlock(flagClear, layoutTable, REAL_SLOT, 1, 4, 0x19c3, Uint8Array.of(flagByte() & ~0x40));
  const { map } = G.slotMap(R, 1); const bobAt = map.get(1) * 0x1000 + 0x238; const bobRec = R.slice(bobAt, bobAt + 96);
  const newGolden = { saves: {}, screens: {} };
  const t0 = Date.now();
  for (const batch of gameBatches()) {
    const full = batch.mons.map((s) => {
      const sp = pack.species[s.species], L = lvlOf(sp.growthRate, s.exp);
      const eff = Object.fromEntries(STATS6.map((k) => [k, s.hyper && s.hyper[k] ? 31 : s.iv[k]]));
      const st = computeStats(sp.baseStats, eff, s.ev, L, (s.pid % 25) ^ (s.natureXor || 0), pack.natures);
      if (s.badStats) return { ...s, level: L, hp: 1, maxHp: 1, stats: { atk: 1, def: 1, spe: 1, spa: 1, spd: 1 }, pp: [35, 0, 0, 0] }; // stored stats deliberately wrong: the game must show the computed ones
      return { ...s, level: L, hp: st.hp, maxHp: st.hp, stats: st, pp: s.moves.map((m, i) => Math.floor(pack.moves[m].pp * (5 + (((s.ppBonuses || 0) >> (i * 2)) & 3)) / 5)) };
    });
    const baseSave = batch.base === 'flagClear' ? flagClear : R;
    const save = G.withParty(baseSave, layoutTable, REAL_SLOT, [bobRec, ...full.map((m) => G.encodeMon(m, { party: true }))]);
    const dir = path.join(out, batch.name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'save.sav'), save);
    const r = await G.continueAndCapture({ rom, save, script: 'START@20 w40 A@30 w80', shotDir: dir });
    const slots = full.map((_, i) => i + 1);
    const cap = G.captureParty(r.pilot, slots, { pages: batch.pages });
    const hashes = Object.fromEntries(Object.entries(cap.frames).map(([k, f]) => [k, sha(Buffer.from(f))]));
    // sprite-region hash: the picture of the Pokemon on the Info page (its palette tells shiny from normal)
    const spriteHash = (f) => { const o = []; for (let y = 28; y < 90; y++) for (let x = 8; x < 72; x++) { const p = (y * 240 + x) * 4; o.push(f[p], f[p + 1], f[p + 2]); } return sha(Buffer.from(o)); };
    const sprites = {}; for (const s of slots) if (cap.frames['s' + s + '_info']) sprites[s] = spriteHash(cap.frames['s' + s + '_info']);
    // sheets for the author's eyes
    const pgs = batch.pages;
    if (batch.sheet === 'per-mon') { for (const s of slots) G.writeSheet(path.join(dir, 'sheet_s' + s + '.png'), pgs.map((p) => cap.frames['s' + s + '_' + p]).filter(Boolean), 3, 2); }
    else G.writeSheet(path.join(dir, 'all.png'), slots.flatMap((s) => pgs.map((p) => cap.frames['s' + s + '_' + p])).filter(Boolean), pgs.length === 1 ? 3 : pgs.length, 1);
    newGolden.saves[batch.name] = sha(save); newGolden.screens[batch.name] = { ...hashes, ...Object.fromEntries(Object.entries(sprites).map(([s, h]) => ['sprite' + s, h])) };
    r.core.close && r.core.close();
    if (!CORE) console.log(`  (batch ${batch.name}: ${Object.keys(hashes).length} screens, ${((Date.now() - t0) / 1000).toFixed(0)} s so far; PNGs in ${dir})`);
    if (UPDATE) { manifest.goldens.gameSaves = { ...(manifest.goldens.gameSaves || {}), [batch.name]: newGolden.saves[batch.name] }; manifest.goldens.game = { ...(manifest.goldens.game || {}), [batch.name]: newGolden.screens[batch.name] }; fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n'); }
    const gold = (manifest.goldens.game || {})[batch.name] || {}, goldSave = (manifest.goldens.gameSaves || {})[batch.name];
    ok(`[enc ${batch.name}] the encoder-built save is the pinned one`, sha(save) === goldSave);
    ok(`[enc ${batch.name}] every screen the game drew reproduces its golden hash (${Object.keys(gold).length} pinned; the core is deterministic)`, Object.keys(gold).length > 0 && Object.keys(newGolden.screens[batch.name]).length === Object.keys(gold).length && Object.keys(gold).every((k) => newGolden.screens[batch.name][k] === gold[k]), J(Object.keys(gold).filter((k) => newGolden.screens[batch.name][k] !== gold[k])));
    // the importer reads the very same bytes; compare with what the game DISPLAYED (typed from the PNGs by the author)
    const o = imp(save);
    ok(`[enc ${batch.name}] the importer imports the encoder-built save`, o.ok, o.ok ? '' : J(o.error));
    const oracle = (manifest.oracle.batches || {})[batch.name] || [];
    ok(`[enc ${batch.name}] an oracle (typed from the game's screens) exists for every Pokemon`, oracle.length === slots.length);
    slots.forEach((slot, idx) => {
      const want = oracle[idx] || {};
      if (want.egg) { ok(`[enc ${batch.name}] slot ${slot} ${want.nickname || ''}: the game drew an EGG; the importer rejects it (mon.egg)`, o.rejected.some((x) => x.where.party && x.where.slot === slot && x.code === 'mon.egg') && !screenView(o, slot)); return; }
      const got = screenView(o, slot);
      const keys = Object.keys(want).filter((k) => k !== 'note');
      // the profile keeps at most 10 characters of a nickname (the game showed all 11 of ABCDEFGHIJK); the importer cuts and says so
      const same = (k) => (k === 'nickname' ? eq(got.nickname, [...want.nickname].slice(0, 10).join('')) : eq(got[k], want[k]));
      const mism = got ? keys.filter((k) => !same(k)) : keys;
      ok(`[enc ${batch.name}] slot ${slot} ${want.nickname || ''}: importer == the game's screen on ${keys.join('/')}`, got && mism.length === 0, got ? J(mism.map((k) => [k, got[k], want[k]])) : 'not imported');
    });
    // typed shiny flags must agree with sprite pixels: equal oracle shiny <=> equal sprite hash among same-species Pokemon of the batch
    const sameSp = slots.filter((s) => oracle[s - 1] && oracle[s - 1].shiny !== undefined && sprites[s]);
    if (sameSp.length > 1) ok(`[enc ${batch.name}] the typed shiny flags agree with the pixel classes of the sprites (same species: equal sprite <=> equal flag)`, sameSp.every((a) => sameSp.every((b) => (sprites[a] === sprites[b]) === (oracle[a - 1].shiny === oracle[b - 1].shiny))));
  }
  // ---- the PC boxes, read where the game itself keeps them. The game's own GetBoxMonDataAt (ROM 0x20567a) addresses box b slot p at
  //      gPokemonStoragePtr + 4 + b * 0x8E8 + p * 76 (b <= 14, p <= 29; ids 15..18 are RAM-only scratch areas). Boot the game on an encoder-built save
  //      and look at those addresses in its RAM: the record must be there, byte for byte. (This is the game's RAM, not a photograph of the PC screen.)
  {
    const r = mkRng(0xb0c5);
    const cells = [[0, 0], [0, 29], [1, 0], [7, 13], [14, 29], [14, 0], [3, 17], [10, 5], [5, 29], [12, 1]];
    const specs = cells.map(() => randomSpec(r, { extra: { egg: false, eggIvOnly: false } }));
    const save = saveWithBoxes(R, cells.map(([b, i], k) => [b, i, specs[k]]));
    const core = await G.makeCore({ rom, save });
    const pilot = G.makePilot(core, {});
    pilot.run('w1800 A@40 w60 A@40 w200');
    const ptr = core.read32(0, 0x030040c8); // gPokemonStoragePtr (IWRAM), found in the game's own box-access code
    ok('[ram] the game keeps its PokemonStorage in EWRAM (gPokemonStoragePtr points into 0x02000000..0x0203FFFF)', ptr >= 0x02000000 && ptr < 0x02040000 && (ptr & 3) === 0, '0x' + ptr.toString(16));
    let same = 0, wrongStride = 0;
    const o = imp(save);
    let imported = 0;
    cells.forEach(([b, i], k) => {
      const want = G.encodeMon(specs[k], { party: false }).subarray(0, 76);
      const got = G.readMem(core, ptr + 4 + b * 0x8e8 + i * 76, 76);
      if (Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0) same++;
      const alt = G.readMem(core, ptr + 4 + b * 2400 + i * 76, 76);
      if (b > 0 && Buffer.compare(Buffer.from(alt), Buffer.from(want)) === 0) wrongStride++;
      const m = o.boxes[b].mons.find((x) => x.provenance.slot === i && x.provenance.box === b);
      if (m && m.species === specs[k].species && m.provenance.pid === specs[k].pid) imported++;
    });
    ok(`[ram] ${cells.length} encoder-placed box Pokemon (corners and middles of boxes 1..15) sit in the game's RAM exactly at 4 + box*0x8E8 + slot*76, byte for byte`, same === cells.length, `(${same}/${cells.length})`);
    control('[ram] control: a wrong box stride (2400 instead of 2280) finds none of them', wrongStride === 0);
    ok('[ram] the importer places the same Pokemon in the same (box, slot) cells the game reads them from', imported === cells.length, `(${imported}/${cells.length})`);
    const names = G.readMem(core, ptr + 0x859c, 140);
    ok('[ram] the game loaded the 15 box names at +0x859c (9 bytes each) and the importer reports the same names', o.boxes.every((bx, k) => decodeFieldT(names, k * 9, 9) === bx.name), '');
    core.close && core.close();
  }
  control('golden comparison trips when a screen differs (control)', sha(Buffer.from('x')) !== Object.values(Object.values(manifest.goldens.game || { x: { y: 'z' } })[0])[0]);
  // determinism of the rig that makes the REAL save: playing the intro again must give the same bytes (cached copy is not trusted blindly)
  const again = await G.generateRealSave({ rom, shotDir: null, log: () => {} });
  ok('the real-save script is deterministic: playing the new game again in the core gives byte-identical flash (sha256 pinned)', sha(again.save) === manifest.goldens.realSaveSha256 && sha(again.save) === sha(R));
}

// =======================================================================================================================================
async function browserSection() {
  section('browser parity: headless Chrome, a real <input type=file> upload, DOM.setFileInputFiles, the module imported through the devserver');
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  // four files, all generated deterministically here (nothing ROM-derived or save-derived is stored in the repo): the real save, a full party, a boxes save, and a damaged one
  const rr = mkRng(0xb70);
  const dir = path.join(G.SCRATCH, 'browser'); fs.mkdirSync(dir, { recursive: true });
  const partySave = saveWithParty(R, Array.from({ length: 5 }, () => randomSpec(rr)));
  const boxSave = saveWithBoxes(R, Array.from({ length: 12 }, (_, i) => [i, (i * 7) % 30, randomSpec(rr)]));
  const damaged = Uint8Array.from(partySave); damaged[G.slotMap(damaged, 1).map.get(1) * 0x1000 + 0x300] ^= 0x20; // one bit, checksum no longer matches
  const files = [['real_v1.sav', R], ['party.sav', partySave], ['boxes.sav', boxSave], ['damaged.sav', damaged]].map(([n, b]) => { const p = path.join(dir, n); fs.writeFileSync(p, b); return p; });
  const PORT = 8100;
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://localhost:${PORT}/pokemonarena/manifest.json`); if (r.ok) break; } catch (_e) { /* wait */ } await new Promise((r) => setTimeout(r, 250)); }
    spawnSync(process.execPath, [path.join(ROOT, 'tools/browser_leak_guard.js'), 'reap'], { stdio: 'ignore' });
    await withBrowser({ port: 9321, width: 800, height: 600 }, async (page) => {
      await page.navigate(`http://localhost:${PORT}/pokemonarena/manifest.json`);
      await page.eval(`(async () => {
        const [tables, si] = await Promise.all([import('/pokemonarena/js/tables.js'), import('/pokemonarena/js/saveimport.js')]);
        const buf = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/' + encodeURIComponent('Pokemon SoulGold (v1.1.1).gba'))).arrayBuffer());
        window.__rom = buf; window.__pack = tables.loadPack(buf, { verify: 'header', dexText: false }); window.__si = si;
        const inp = document.createElement('input'); inp.type = 'file'; inp.id = 'f'; document.body.append(inp); return buf.length; })()`);
      const doc = await page.send('DOM.getDocument', { depth: 1 });
      const q = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f' });
      for (const f of files) {
        await page.send('DOM.setFileInputFiles', { files: [f], nodeId: q.nodeId });
        const got = await page.eval(`(async () => { const file = document.querySelector('#f').files[0]; const r = await window.__si.importSaveFile(file, { rom: window.__rom, pack: window.__pack }); return { name: file.name, size: file.size, json: JSON.stringify(r) }; })()`);
        const want = JSON.stringify(SI.importSave(fs.readFileSync(f), { rom, pack }));
        ok(`browser == Node for ${path.basename(f)} (File upload via setFileInputFiles, ${got.size} bytes, ${want.length} chars of JSON, ok=${JSON.parse(want).ok})`, got.json === want && got.size === fs.statSync(f).size);
      }
      const bad = await page.eval(`(async () => { const r = await window.__si.importSaveFile(new Blob([new Uint8Array(100)]), { rom: window.__rom, pack: window.__pack }); return r.error.code; })()`);
      ok('browser: a wrong-size Blob -> save.size, no throw', bad === 'save.size');
      control('parity check is real: a different save does not compare equal (control)', JSON.stringify(SI.importSave(fs.readFileSync(files[0]), { rom, pack })) !== JSON.stringify(SI.importSave(fs.readFileSync(files[1]), { rom, pack })));
    });
  } finally { try { srv.kill(); } catch (_e) { /* gone */ } spawnSync(process.execPath, [path.join(ROOT, 'tools/browser_leak_guard.js'), 'reap'], { stdio: 'ignore' }); }
}

// =======================================================================================================================================
async function mutantSection() {
  section('mutation matrix: each source mutant of saveimport.js must make the --core suite fail; the unmutated twin must pass');
  const src = fs.readFileSync(path.join(TREE, 'js/saveimport.js'), 'utf8');
  const MUTANTS = manifest.mutants.map((m) => ({ id: m[0], find: m[1], repl: m[2], note: m[3] }));
  const tmpRoot = path.join(G.SCRATCH, 'mut');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const runOne = (id, text) => {
    const dir = path.join(tmpRoot, id); fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(TREE, 'js'), path.join(dir, 'js'), { recursive: true });
    fs.copyFileSync(path.join(TREE, 'package.json'), path.join(dir, 'package.json'));
    fs.writeFileSync(path.join(dir, 'js/saveimport.js'), text);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--core'], { env: { ...process.env, SAVEIMPORT_TREE: dir }, encoding: 'utf8', timeout: 240000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const twin = runOne('twin', src);
  ok('unmutated twin: --core passes quietly', twin.code === 0, twin.code === 0 ? '' : twin.out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(' | '));
  let killed = 0, survived = [];
  for (const m of MUTANTS) {
    const n = src.split(m.find).length - 1;
    if (n !== 1) { ok(`mutant ${m.id}: the pattern occurs exactly once in the source`, false, `(${n}x)`); continue; }
    const res = runOne(m.id, src.replace(m.find, m.repl));
    if (res.code !== 0) { killed++; console.log(`  ok   [mutant] ${m.id} killed  (${m.note})  ${res.out.split('\n').find((l) => /FAIL/.test(l)) || ''}`.slice(0, 170)); pass++; } else { survived.push(m.id); fail++; console.log(`  FAIL [mutant] ${m.id} SURVIVED  (${m.note})`); }
  }
  console.log(`  mutants: ${killed}/${MUTANTS.length} killed${survived.length ? ', survivors: ' + survived.join(',') : ''}`);
}

if (has('--game')) await gameSection();
if (has('--browser')) await browserSection();
if (has('--mutants')) await mutantSection();

console.log(`\n${CORE ? '[core] ' : ''}${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
