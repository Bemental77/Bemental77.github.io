// tools/pokemonarena_anim_test.mjs -- tests of the ROM animation engine (pokemonarena/js/move_anim.js and friends).
//   node tools/pokemonarena_anim_test.mjs [--full] [--golden-update] [--oracle]
//     (default) static parse of all 935 move scripts, command lengths vs executed scripts, golden frame-stream hashes, determinism, negative controls,
//               coverage-file integrity + re-run of a sample, typed errors, a 150-move smoke run, performance numbers
//     --full    runs all 935 moves + every general / status / special / bg animation (about 3 minutes)
//     --golden-update  rewrites pokemonarena/js/anim.golden.json (hashes only) from the current engine
//     --oracle  also runs a few moves against the REAL game through OR1's mGBA oracle and compares sprite state frame by frame (needs the route to be buildable), and (round 6) the whole FIELD
//               pixel by pixel + the luminance of the terrain (tools/pokemonarena_anim_field_compare.mjs) with negative controls that switch each effect off
// Exits non-zero on any failure. Skips loudly (exit 0, counted) when the ROM is absent.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { createMoveAnimator, KIND_RANGE, MoveAnimError, AD, Engine } from '../pokemonarena/js/move_anim.js';
import { AnimPpu } from '../pokemonarena/js/anim_ppu.js';
import { walkScript, decodeCommand, COMMANDS } from '../pokemonarena/js/anim_script.js';
import { decompressAny } from '../pokemonarena/js/gfxcodec.js';
import { songInfo, defaultIsSEPlaying, cryFrames } from '../pokemonarena/js/anim_sound.js';
import { GbaCpu } from '../pokemonarena/js/anim_cpu.js';

const args = process.argv.slice(2);
const FULL = args.includes('--full'), UPDATE = args.includes('--golden-update'), ORACLE = args.includes('--oracle');
const ROM_PATH = process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba';
if (!fs.existsSync(ROM_PATH)) { console.log('SKIPPED: ROM not found at ' + ROM_PATH + ' (set ARENA_ROM)'); process.exit(0); }
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const SHA = '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a';
const GOLDEN = 'pokemonarena/js/anim.golden.json', COVERAGE = 'pokemonarena/js/anim_coverage.json';
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + name + (detail ? ' -- ' + detail : '')); } return !!cond; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dv = new DataView(rom.buffer, rom.byteOffset);
const base = new Uint8ClampedArray(240 * 160 * 4);
const flat = () => { for (let i = 0; i < base.length; i += 4) { base[i] = 80; base[i + 1] = 120; base[i + 2] = 88; base[i + 3] = 255; } };

// ---- the reference animations whose whole frame stream is pinned (hashes only)
const CASES = [
  { kind: 'move', id: 33, label: 'Tackle' }, { kind: 'move', id: 52, label: 'Ember' }, { kind: 'move', id: 55, label: 'Water Gun' }, { kind: 'move', id: 85, label: 'Thunderbolt' },
  { kind: 'move', id: 94, label: 'Psychic' }, { kind: 'move', id: 63, label: 'Hyper Beam' }, { kind: 'move', id: 89, label: 'Earthquake' }, { kind: 'move', id: 14, label: 'Swords Dance' },
  { kind: 'move', id: 45, label: 'Growl' }, { kind: 'move', id: 79, label: 'Sleep Powder' }, { kind: 'move', id: 73, label: 'Leech Seed' }, { kind: 'move', id: 57, label: 'Surf' },
  { kind: 'general', id: 0, label: 'stat change', ctx: { animArg: 14 } }, { kind: 'general', id: 9, label: 'general 9' }, { kind: 'general', id: 10, label: 'general 10' },
  { kind: 'status', id: 2, label: 'status 2' }, { kind: 'status', id: 4, label: 'status 4' }, { kind: 'special', id: 2, label: 'special 2' }, { kind: 'bg', id: 7, label: 'background 7' },
];
function streamHash(an, c) {
  const run = an.start(c.kind, c.id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 1, ...(c.ctx || {}) });
  const h = crypto.createHash('sha256'); let n = 0;
  while (!run.done && n < 1800) { run.step(); flat(); run.draw(base); h.update(base); n++; }
  return { hash: h.digest('hex').slice(0, 32), frames: n, error: run.error ? run.error.message : null, truncated: run.truncated };
}

const t0 = performance.now();
console.log('== identity');
ok(rom.length === 33554432, 'ROM length'); ok(sha(rom) === SHA, 'ROM sha256 is the pinned SoulGold v1.1.1');
const an = await createMoveAnimator({ rom });
let threw = null; try { await createMoveAnimator({ rom: new Uint8Array(100) }); } catch (e) { threw = e; }
ok(threw instanceof MoveAnimError, 'a wrong ROM is refused with a typed error', String(threw));

console.log('== static parse of every move script (anim_script.js, nothing executed)');
{
  let withEnd = 0, errs = [], tagsBad = [], sheetsBad = [], tmplBad = [], taskBad = [], cmds = 0;
  const PIC = 0x421624;
  for (let id = 1; id <= 935; id++) {
    const sp = dv.getUint32(0x769860 + id * 0x48 + 0x44, true) - 0x08000000;
    const w = walkScript(rom, sp); cmds += w.commands.length;
    if (w.error || w.budgetExceeded) errs.push(id);
    if (w.ends + w.stops > 0) withEnd++;
    for (const tag of w.spriteTags) {
      const idx = tag - 10000, e = PIC + idx * 16;
      if (idx < 0 || idx > 0x3ff || dv.getUint16(e + 6, true) !== tag) { tagsBad.push(id); continue; }
      const sheet = dv.getUint32(e, true) - 0x08000000, pal = dv.getUint32(e + 8, true) - 0x08000000;
      try { decompressAny(rom, sheet); } catch (er) { sheetsBad.push(id + ':' + tag); }
      if (pal < 0 || pal >= rom.length) sheetsBad.push(id + ':pal' + tag);
    }
    for (const t of w.templates) { const o = t - 0x08000000; if (o < 0 || o + 24 > rom.length || (dv.getUint32(o + 20, true) & 1) === 0) tmplBad.push(id); }
    for (const t of w.tasks) if ((t & 1) === 0 || t < 0x08000000 || t - 0x08000000 >= rom.length) taskBad.push(id);
  }
  ok(errs.length === 0, 'every script walks without leaving the cartridge or hitting an unknown command', errs.slice(0, 8).join(','));
  ok(withEnd === 935, 'every script reaches an end / hang command', `${withEnd}/935`);
  ok(sheetsBad.length === 0, 'every sprite sheet and palette a script loads decodes', sheetsBad.slice(0, 6).join(' '));
  ok(tmplBad.length === 0 && taskBad.length === 0, 'every createsprite template / createvisualtask function points into the cartridge (THUMB)', `${tmplBad.slice(0, 4)} ${taskBad.slice(0, 4)}`);
  ok(tagsBad.length <= 2, 'sprite-sheet tags resolve in the ROM table (the one static desync is move 697, lengths of two commands unverified)', tagsBad.join(','));
  console.log(`   ${cmds} commands decoded in 935 scripts; ${withEnd} terminate; tag desyncs ${tagsBad.length}`);
}

console.log('== script command lengths: static table vs commands the ROM really executed');
{
  let checked = 0, bad = [];
  for (let id = 1; id <= 150; id++) {
    const tr = []; tr.push = function (a, b) { Array.prototype.push.call(this, { a, b }); }; an.eng.scriptTrace = tr;
    const run = an.start('move', id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 } });
    let f = 0; while (!run.done && f < 500) { run.step(); f++; }
    for (let k = 0; k + 1 < tr.length; k++) {
      const c = COMMANDS[tr[k].b]; const d = tr[k + 1].a - tr[k].a;
      if (!c || c.kind !== 'seq' || d <= 0 || d > 200) continue;
      let len = -1; try { len = decodeCommand(rom, tr[k].a - 0x08000000).len; } catch (e) { /* counted below */ }
      checked++; if (len !== d && !(c.verified === false)) bad.push(`${id}:0x${tr[k].b.toString(16)} ${len}/${d}`);
    }
  }
  an.eng.scriptTrace = null;
  ok(bad.length === 0, `static command lengths agree with ${checked} executed sequential commands`, bad.slice(0, 5).join(' '));
}

console.log('== determinism, golden frame streams, negative controls');
{
  const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : null;
  const got = {};
  for (const c of CASES) got[c.kind + ':' + c.id] = streamHash(an, c);
  const twin = streamHash(an, CASES[0]);
  ok(twin.hash === got['move:33'].hash && twin.frames === got['move:33'].frames, 'same seed, same animation -> the identical frame stream (twice in one engine)');
  const an2 = await createMoveAnimator({ rom });
  ok(streamHash(an2, CASES[1]).hash === got['move:52'].hash, 'a second engine instance renders the identical stream (boot is deterministic)');
  // an RNG-using move depends on the seed
  const r1 = (() => { const run = an.start('move', 28, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 1 }); const h = crypto.createHash('sha256'); let n = 0; while (!run.done && n < 400) { run.step(); flat(); run.draw(base); h.update(base); n++; } return h.digest('hex'); })();
  const r2 = (() => { const run = an.start('move', 28, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 2 }); const h = crypto.createHash('sha256'); let n = 0; while (!run.done && n < 400) { run.step(); flat(); run.draw(base); h.update(base); n++; } return h.digest('hex'); })();
  ok(r1 !== r2, 'a different seed changes a move that uses Random (Sand Attack: 60 calls of the ROM Random2)');
  for (const c of CASES) { const g = got[c.kind + ':' + c.id]; ok(!g.error && !g.truncated && g.frames > 5, `${c.label}: plays to the end`, g.error || ''); }
  if (UPDATE || !golden) {
    fs.writeFileSync(GOLDEN, JSON.stringify({ schema: 1, romSha256: SHA, note: 'sha256 (first 128 bits) of the RGBA frames of the whole animation, drawn onto a flat 240x160 picture each frame; species 4 (side 0) vs species 1 (side 1), seed 1; hashes only', cases: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, { hash: v.hash, frames: v.frames }])) }, null, 1));
    console.log('   golden file written: ' + GOLDEN);
  } else {
    for (const c of CASES) { const k = c.kind + ':' + c.id, g = golden.cases[k]; ok(g && g.hash === got[k].hash && g.frames === got[k].frames, `golden ${c.label} (${k})`, g ? `${got[k].hash} != ${g.hash}` : 'no golden'); }
  }
  // negative control 1: change ONE byte of Tackle's script (the delay operand) in a private copy of the ROM: the stream must change
  const sp = dv.getUint32(0x769860 + 33 * 0x48 + 0x44, true) - 0x08000000;
  let delayAt = -1; for (let i = sp; i < sp + 80; i++) if (rom[i] === 0x04 && rom[i + 1] === 0x06) { delayAt = i + 1; break; }
  const mutRom = rom.slice(); mutRom[delayAt] = 0x20;
  const anM = await createMoveAnimator({ rom: mutRom });
  const mh = streamHash(anM, CASES[0]);
  ok(delayAt > 0 && mh.hash !== got['move:33'].hash, 'negative control: a changed script byte (delay 6 -> 32) changes the stream', `delayAt ${delayAt}`);
  // negative control 2: a CPU whose ASR does not sign-extend must not reproduce the golden stream (the code under test really runs on the CPU)
  const origSh = GbaCpu.prototype._ldsh, origAsr = GbaCpu.prototype._shift;
  GbaCpu.prototype._ldsh = function (a) { return this.mem.read16(a & ~1) >>> 0; };                                    // LDSH zero-extends
  GbaCpu.prototype._shift = function (mode, v, amt, reg, setC) { return mode === 2 ? origAsr.call(this, 1, v, amt, reg, setC) : origAsr.call(this, mode, v, amt, reg, setC); };   // ASR is logical
  let mut2; try { mut2 = streamHash(await createMoveAnimator({ rom }), CASES[0]); } catch (e) { mut2 = { hash: 'threw ' + e.message }; } finally { GbaCpu.prototype._ldsh = origSh; GbaCpu.prototype._shift = origAsr; }
  ok(mut2.hash !== got['move:33'].hash, 'negative control: a CPU whose LDSH / ASR do not sign-extend does not reproduce the golden stream');
  ok(streamHash(await createMoveAnimator({ rom }), CASES[0]).hash === got['move:33'].hash, 'unmutated twin: after restoring the CPU the golden stream is reproduced');
}

console.log('== API contract and typed errors');
{
  const run = an.start('move', 33, { attacker: { side: 'player', species: 4 }, target: { side: 'foe', species: 1 } });
  ok(typeof run.step === 'function' && typeof run.draw === 'function' && typeof run.on === 'function' && typeof run.battlerState === 'function' && run.done === false, 'run exposes step / draw / on / battlerState / done');
  const sounds = []; run.on('sound', (e) => sounds.push(e)); let n = 0; while (!run.done && n < 200) { run.step(); n++; }
  ok(run.done && n === run.frame, 'run.done becomes true and run.frame counts steps', `${n} ${run.frame}`);
  const sa = an.start('move', 33, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 } }); sa.step();
  const bs = sa.battlerState(0), bf = sa.battlerState(1);
  ok(bs && bf && 'dx' in bs && 'scaleX' in bs && 'rot' in bs && 'visible' in bs && 'alpha' in bs, 'battlerState has dx dy scaleX scaleY rot visible alpha tint');
  const evs = []; const sb = an.start('move', 33, {}); sb.on('sound', (e) => evs.push(e)); let k = 0; while (!sb.done && k < 100) { sb.step(); k++; }
  ok(evs.length >= 1 && Number.isInteger(evs[0].index) && Number.isInteger(evs[0].pan), 'Tackle raises a sound event with a song-table index and a pan', JSON.stringify(evs[0]));
  for (const [kind, id] of [['move', 0], ['move', 5000], ['general', 99], ['status', -1], ['special', 8], ['nonsense', 1]]) { let e = null; try { an.start(kind, id, {}); } catch (x) { e = x; } ok(e instanceof MoveAnimError, `start(${kind}, ${id}) throws a typed MoveAnimError`, String(e)); }
  ok(['exact', 'approx', 'fallback', 'none'].includes(an.available('move', 33)), 'available() answers with one of the four words');
}

console.log('== coverage file');
{
  ok(fs.existsSync(COVERAGE), 'coverage file exists (tools/pokemonarena_anim_coverage.mjs writes it)');
  if (fs.existsSync(COVERAGE)) {
    const cov = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'));
    let sumOk = true; for (const k of Object.keys(cov.status)) { const c = { exact: 0, approx: 0, fallback: 0, none: 0 }; for (const v of Object.values(cov.status[k])) c[v]++; for (const s of Object.keys(c)) if (c[s] !== cov.counts[k][s]) sumOk = false; }
    ok(sumOk, 'per-kind counts equal the per-id statuses');
    ok(sha(JSON.stringify(cov.status)) === cov.statusHash, 'statusHash matches the status table');
    ok(Object.keys(cov.status.move).length === 935 && Object.keys(cov.status.general).length === 56 && Object.keys(cov.status.status).length === 10 && Object.keys(cov.status.special).length === 8 && Object.keys(cov.status.bg).length === 85, 'the table covers 935 moves, 56 general, 10 status, 8 special, 85 background animations');
    // re-run a sample: the status of each must be reproduced by a fresh classification of the same rules
    const anC = await createMoveAnimator({ rom, coverage: cov });
    ok(anC.available('move', 33) === cov.status.move[33], 'available() reads the coverage file');
    const sample = [33, 52, 55, 85, 94, 63, 89, 14, 45, 79, 232, 854, 502, 852, 5, 61];
    let mism = [];
    for (const id of sample) {
      const run = anC.start('move', id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 1 }); let f = 0;
      while (!run.done && f < 1800) { run.step(); f++; }
      const live = run.error ? 'fallback' : (run.truncated ? 'fallback' : 'ran');
      const rec = cov.status.move[id];
      if ((rec === 'fallback') !== (live === 'fallback')) mism.push(`${id}:${rec}/${live}`);
    }
    ok(mism.length === 0, 'a sample of 16 moves re-runs with the same playable / fallback outcome as the coverage file', mism.join(' '));
    console.log('   coverage: ' + JSON.stringify(cov.counts));
  }
}

console.log(FULL ? '== all 935 moves + every general / status / special / bg animation' : '== smoke: 150 moves (use --full for all)');
{
  let faults = [], n = 0;
  const lim = FULL ? 935 : 150;
  for (let id = 1; id <= lim; id++) {
    const run = an.start('move', id, { attacker: { side: id & 1, species: 4 }, target: { side: (id & 1) ^ 1, species: 1 }, seed: 1 }); let f = 0;
    while (!run.done && f < 1800) { run.step(); f++; }
    n++; if (run.error || run.truncated) faults.push(id + ':' + (run.error ? run.error.name : 'cut'));
  }
  const allowed = new Set(['502:CpuBudgetError', '852:cut']);
  const unexpected = faults.filter((x) => !allowed.has(x));
  ok(unexpected.length === 0, `${n} moves run to the end (documented exceptions: ${[...allowed].join(' ')})`, unexpected.join(' '));
  if (FULL) for (const kind of ['general', 'status', 'special', 'bg']) {
    const [lo, hi] = KIND_RANGE[kind]; const bad = [];
    for (let id = lo; id <= hi; id++) { const run = an.start(kind, id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 } }); let f = 0; while (!run.done && f < 1800) { run.step(); f++; } if (run.error || run.truncated) bad.push(id); }
    ok(bad.length <= (kind === 'general' ? 3 : kind === 'special' ? 1 : kind === 'bg' ? 2 : 0), `${kind}: every id runs (cut-off ids ${bad.join(',') || 'none'})`);
  }
}

console.log('== round 2: environment fidelity (each pin was measured on the REAL game through OR1; each has a negative control)');
{
  const mem = an.eng.mem, P = { attacker: { side: 0, species: 1289 }, target: { side: 1, species: 183 } };
  const run2 = (id, ctx = {}, kind = 'move') => an.start(kind, id, { ...P, ...ctx });
  const stepsOf = (run, max = 1800) => { let n = 0; while (!run.done && n < max) { run.step(); n++; } return n; };
  const sprites = (cb) => { const out = []; for (let i = 0; i < 64; i++) { const b = AD.sprites + i * 0x44; if ((mem.ewU8(b + 0x3e) & 1) && (cb === undefined || mem.ewU32(b + 0x1c) === cb)) out.push({ id: i, x: mem.ewS16(b + 0x20), y: mem.ewS16(b + 0x22), d: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => mem.ewS16(b + 0x2e + 2 * k)) }); } return out; };
  const firstSprite = (run, cb, limit = 40) => { for (let k = 0; k < limit; k++) { run.step(); const s = sprites(cb); if (s.length) return s[0]; } return null; };
  const inUse = () => sprites().map((s) => s.id).join(',');

  // sprite slots: CreateSprite hands out the lowest free slot and callbacks keep ids in data words, so the occupancy must be the real battle's
  run2(33);
  ok(inUse() === '0,1,2,3,4,5,9,11,60,61,62,63', 'the battle environment holds gSprites 0-5, 9 (player), 11 (foe) and 60-63, exactly as the real singles battle (OR1)', inUse());
  run2(33, { occupiedSlots: null });
  ok(inUse() === '0,1,2,3,4,5,6,7,8,9,10,11', 'negative control: occupiedSlots null gives the old dense layout (0-11)', inUse());
  const REAL_RNG2 = [0x2c55b0e5, 0xa8a5bd14, 0x38f9e972, 0x1ed];            // the real game's Random2 state on the frame before Double Kick launched (OR1)
  const dk = firstSprite(run2(24, { rng2: REAL_RNG2 }), 0x0803f11d);
  ok(dk && dk.d[7] === 7 && dk.x === 183 && dk.y === 53, 'Double Kick (24) with the real Random2 state: its hit effect is at (183,53) and keeps child sprite id 7 in data[7], like the real game', JSON.stringify(dk));
  const dkDense = firstSprite(run2(24, { rng2: REAL_RNG2, occupiedSlots: null }), 0x0803f11d);
  ok(dkDense && dkDense.d[7] === 13 && dkDense.x === 183, 'negative control: with the dense layout the same move stores id 13 (the engine\'s old, wrong number)', JSON.stringify(dkDense));
  const dkOther = firstSprite(run2(24, { rng2: [1, 2, 3, 4] }), 0x0803f11d);
  ok(dkOther && (dkOther.x !== 183 || dkOther.y !== 53), 'negative control: another Random2 state moves the hit effect (the position really is drawn from Random2)', JSON.stringify(dkOther));
  // OBJ palette slots 4-10 are taken by the healthbox etc.; Light Screen stores (palette index + 16) * 16 in data[0]
  const ls = firstSprite(run2(113), 0x0804eccd), ls2 = firstSprite(run2(113, { paletteTags: new Array(16).fill(0xffff), reservedPalettes: 4 }), 0x0804eccd);
  ok(ls && ls.d[0] === 448 && ls2 && ls2.d[0] === 336, 'Light Screen (113): palette slot 12 -> data[0] 448 with the real battle\'s tags (the real game also stores 448); 336 when the slots are free', `${ls && ls.d[0]} ${ls2 && ls2.d[0]}`);
  // singles: the partner battlers are absent
  run2(33);
  ok(mem.ewU8(AD.battlerPositions + 2) === 0xff && mem.ewU8(AD.battlerPositions + 3) === 0xff && mem.ewU8(AD.battlersCount) === 2, 'singles: battlers 2 and 3 are absent (position 0xff, battlersCount 2) -- the old model created a spurious partner BG task that shifted every task id');
  // self-targeting runs: the user is both attacker and target; ctx.bystander names the other Pokemon (Mist's mist sits 8 px lower than for a foe-targeted run: measured in the real game)
  const mistSelf = firstSprite(an.start('move', 54, { attacker: { side: 0, species: 1289 }, target: { side: 0, species: 1289 }, bystander: { species: 183 } }), 0x08045161);
  const mistFoe = firstSprite(run2(54), 0x08045161);
  ok(mistSelf && mistSelf.y === 64 && mistFoe && mistFoe.y === 56, 'Mist (54): y 64 when the target is the user (as in the real game), 56 for a foe target -- the target side matters', `${mistSelf && mistSelf.y} ${mistFoe && mistFoe.y}`);
  // the real main loop draws Random() twice per iteration
  { const r = run2(33); const d0 = mem.read32(AD.rng1 + 12); for (let k = 0; k < 10; k++) r.step(); const adv = mem.read32(AD.rng1 + 12) - d0;
    const r2 = run2(33, { mainLoopRandom: false }); const e0 = mem.read32(AD.rng1 + 12); for (let k = 0; k < 10; k++) r2.step(); ok(adv === 20 && mem.read32(AD.rng1 + 12) - e0 === 0, 'Random() state advances by 2 per frame like the real main loop (20 in 10 steps); 0 with mainLoopRandom false', `${adv}`); }

  // DecompressDataWithHeaderVram's smol decoder (0x0811c080): the model's heap is ~2 KB tighter than the real one, so terrain 9's 12 KB tile stream could not be allocated natively
  { const r = run2(5, { terrain: 9 }); const n = stepsOf(r);
    ok(!r.error && !r.truncated && n === 155, 'move 5 on terrain 9 (the scripted trainer battle\'s) plays to the end: 155 steps', `${n} ${r.error && r.error.message}`);
    an.eng.nativeSmol = true; let bad; try { const r2 = run2(5, { terrain: 9 }); stepsOf(r2); bad = r2.error; } finally { an.eng.nativeSmol = false; }
    ok(bad && bad.name === 'CpuBudgetError', 'negative control: with the native smol routine the same run dies (Alloc returns NULL -> the ROM\'s assertion loop)', String(bad)); }
  { // the JS decoder and the native routine write identical bytes (VRAM destination; streams the native routine can run in this heap)
    run2(33); const cpu = an.eng.cpu; const u32 = (o) => (rom[o] | rom[o + 1] << 8 | rom[o + 2] << 16 | rom[o + 3] << 24) >>> 0; const srcs = [];
    for (let t = 0; t <= 40 && srcs.length < 14; t++) { const p = u32(0x430470 + t * 64 + 48); if (!srcs.includes(p)) srcs.push(p); }
    let same = 0, tried = 0; const out = (native, p) => { an.eng.nativeSmol = native; for (let i = 0; i < 0x4000; i += 2) mem.write16(0x06010000 + i, 0xeeee); try { cpu.call(0x0811c6c5, [p, 0x06010000], { budget: 8000000 }); } catch (e) { return null; } finally { an.eng.nativeSmol = false; } const b = Buffer.alloc(0x4000); for (let i = 0; i < 0x4000; i++) b[i] = mem.read8(0x06010000 + i); return b; };
    for (const p of srcs) { const a = out(false, p), b = out(true, p); if (!b) continue; tried++; if (a && Buffer.compare(a, b) === 0) same++; }
    ok(tried >= 8 && same === tried, `the gfxcodec smol decoder and the ROM's own routine write identical bytes on ${tried} terrain tile streams`, `${same}/${tried}`); }

  // sound-effect waits: IsSEPlaying answered from the song header (anim_sound.js)
  { const s139 = songInfo(rom, 139);
    ok(s139.player === 1 && s139.tracks === 2 && s139.frames === 24 && !s139.loops, 'song 139 (Tackle\'s hit): SE1 player, 2 tracks, 24 frames at the default tempo', JSON.stringify(s139));
    ok(defaultIsSEPlaying(rom, 139, 24) === true && defaultIsSEPlaying(rom, 139, 25) === false, 'defaultIsSEPlaying is true while elapsed < the song length + 1 frame of player latency, false after');
    const calls = []; const withSE = stepsOf(run2(33)), noSE = stepsOf(run2(33, { isSEPlaying: () => false })), spy = stepsOf(run2(33, { isSEPlaying: (i, el) => { calls.push([i, el]); return el < 24; } }));
    ok(withSE === 40 && noSE === 28 && spy === 39, 'Tackle ends when its sound would: 40 steps with the song-length estimate (28 when the wait is disabled, 39 for a callback that says 24 frames); a ctx.isSEPlaying callback gets (song index, frames since start)', `${withSE} ${noSE} ${spy}`);
    ok(calls.length > 5 && calls.every(([i]) => i === 139) && calls[0][1] < calls[calls.length - 1][1], 'the callback is asked about the real song-table index 139 with a growing elapsed count', JSON.stringify(calls.slice(0, 3)));
    const evs = []; const rr = run2(33); rr.on('sound', (e) => evs.push(e.index)); stepsOf(rr); ok(evs.includes(139), 'sound events still carry the real song-table index (139)', evs.join(',')); }
  // cries
  { const r = run2(46, { target: { side: 1, species: 19 } }); const ev = []; r.on('cry', (e) => ev.push(e)); stepsOf(r);
    ok(ev.length === 2 && ev[0].species === 1289 && Number.isInteger(ev[0].pan), 'Roar raises two `cry` events carrying the species and pan (the host plays the cry)', JSON.stringify(ev));
    ok(cryFrames(rom, 1289) === 84 && cryFrames(rom, 0) === null, 'cryFrames reads the wave length from the ROM: species 1289 = 84 frames; species 0 has none'); }
  // frame budget
  { const r = run2(33); r.step(); const first = r.stepInstr; stepsOf(r); const r2 = run2(33, { frameBudget: 1000 }); r2.step();
    ok(first > 0 && r.peakStepInstr >= first && r.peakStepInstr < 3000000 && r.heavySteps === 0, 'run.stepInstr / peakStepInstr report the instructions of a frame step (Tackle peaks below the 3M call budget)', `${first} ${r.peakStepInstr}`);
    ok(r2.error && r2.error.name === 'CpuBudgetError' && r2.done, 'negative control: a frame that exceeds ctx.frameBudget ends the run with a typed CpuBudgetError', String(r2.error)); }
  // script commands 0x33 / 0x34
  { let at = -1, argc = 0; { const w = walkScript(rom, dv.getUint32(0x769860 + 697 * 0x48 + 0x44, true) - 0x08000000); for (const c of w.commands) if (c.op === 0x34 && c.args.length) { at = c.at; argc = c.args.length; break; } }
    ok(at > 0 && decodeCommand(rom, at).len === 3 + 2 * argc, 'command 0x34 is `34 b argc <argc halfwords>`: 3 + 2*argc bytes (Dragon Darts, move 697, desynchronised when it was fixed at 3)', `${at} ${argc}`);
    let c33 = null; outer: for (let id = 1; id <= 935; id++) { const w = walkScript(rom, dv.getUint32(0x769860 + id * 0x48 + 0x44, true) - 0x08000000); for (const c of w.commands) if (c.op === 0x33) { c33 = { id, c }; break outer; } }
    ok(!c33 || (c33.c.len === 6 && c33.c.kind === 'cond' && c33.c.ptrs.length === 1 && c33.c.ptrs[0] > 0), 'command 0x33 is a 6-byte conditional jump with a script pointer at +2' + (c33 ? ` (first used by move ${c33.id})` : ' (not used by any move script)')); }
}

console.log('== performance (per GBA frame; this machine, cold + warm)');
{
  const load = os.loadavg()[0];
  let worst = 0;
  for (const id of [33, 55, 85, 94, 57]) {
    const run = an.start('move', id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 } });
    let ts = 0, td = 0, n = 0, mx = 0; flat();
    while (!run.done && n < 300) { const a = performance.now(); run.step(); const b = performance.now(); run.draw(base); const c = performance.now(); ts += b - a; td += c - b; mx = Math.max(mx, c - a); n++; }
    worst = Math.max(worst, (ts + td) / n);
    console.log(`   move ${id}: ${n} frames, step ${(ts / n).toFixed(3)} ms + draw ${(td / n).toFixed(3)} ms per frame (worst single frame ${mx.toFixed(1)} ms)`);
  }
  console.log(`   load average ${load.toFixed(2)} (os.loadavg: 0 on Windows), ${os.cpus().length} cores; frame budget at 59.7275 Hz = 16.74 ms`);
  ok(worst < 12, 'mean step+draw per frame stays under 12 ms', worst.toFixed(2));
}


console.log('== round 6: the terrain follows the ROM\'s palette fades; the colour effects are the pinned mGBA\'s (each with a negative control)');
{
  const e5 = (c) => (c << 3) | (c >> 2);
  // the terrain is the caller's picture: a flat gray here (200 -> 5-bit 25); the faded value of every frame is read back from the PPU output of that picture
  const grayRun = (kind, id, ctx = {}) => {
    const run = an.start(kind, id, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 }, ...ctx }); const fr = { width: 240, height: 160, data: new Uint8ClampedArray(240 * 160 * 4) };
    const series = []; let n = 0;
    while (!run.done && n < 600) { for (let i = 0; i < fr.data.length; i += 4) { fr.data[i] = 200; fr.data[i + 1] = 200; fr.data[i + 2] = 200; fr.data[i + 3] = 255; } run.step(); run.draw(fr); const q = (10 * 240 + 120) * 4; series.push([fr.data[q], fr.data[q + 1], fr.data[q + 2]]); n++; }
    return series;
  };
  // what the ROM asks of the terrain: the first AnimTask_BlendBattleAnimPal (task 0x0805522d) of the script that selects the BG palettes (bit 0): args = mask, delay, start, end, colour
  const bgBlend = (id) => { const w = walkScript(rom, rd32(0x769860 + id * 0x48 + 0x44) - 0x08000000, 6000); const c = w.commands.find((x) => x.op === 3 && x.target === 0x805522d && (x.args[0] & 1)); return c ? { end: c.args[3], color: c.args[4] } : null; };
  function rd32(o) { return dv.getUint32(o, true); }
  const blendCh = (L, end, color5) => L + (((color5 - L) * end) >> 4);                 // BlendPalette: r + (((target - r) * coeff) >> 4), 5-bit channels
  const MOVES = [['Thunderbolt', 85], ['Fire Blast', 126], ['Thunder Wave', 86], ['Hail', 258], ['Rain Dance', 240], ['Sunny Day', 241]];
  for (const [name, id] of MOVES) {
    const b = bgBlend(id); if (!ok(b, name + ': the script has a BG palette blend task (read from the ROM)')) continue;
    const L = 200 >> 3, target = (c) => (b.color & 31) | 0, col = [b.color & 31, (b.color >> 5) & 31, (b.color >> 10) & 31];
    const want = [0, 1, 2].map((ch) => e5(blendCh(L, b.end, col[ch])));
    const s = grayRun('move', id); const dark = b.color === 0; const ext = (ch) => dark ? Math.min(...s.map((v) => v[ch])) : Math.max(...s.map((v) => v[ch]));
    ok(ext(0) === want[0] && ext(1) === want[1] && ext(2) === want[2], `${name}: the terrain goes to the ROM's own blend (end coefficient ${b.end} toward ${dark ? 'black' : '0x' + b.color.toString(16)}): ${want.join(',')} from a gray of ${e5(L)}`, 'got ' + [ext(0), ext(1), ext(2)].join(','));
    ok(s[0][0] === e5(L) && s[s.length - 1][0] === e5(L), name + ': the terrain starts and ends untouched', s[0] + ' / ' + s[s.length - 1]);
  }
  { const s = grayRun('move', 63); ok(Math.min(...s.map((v) => v[0])) === 0 && s[0][0] === e5(25) && s[s.length - 1][0] === e5(25), 'Hyper Beam: the terrain goes black and comes back (the ROM drives it through its palette blend tasks)', 'min ' + Math.min(...s.map((v) => v[0]))); }
  { let any = 0; for (const id of [33, 52, 45]) { const run = an.start('move', id, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 } }); let n = 0; while (!run.done && n < 300) { run.step(); n++; if (run.eng.baseFadeLut()) any++; } }
    ok(any === 0, 'Tackle / Ember / Growl never fade the terrain (the colour map is null on every frame)', 'frames with a map ' + any); }
  { // the ramp survives restorebg: Hypnosis loads an animation background (its own palette over the ramp) and then the terrain again (the real terrain palette over it)
    const run = an.start('move', 95, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 } }); let sawAnim = false, n = 0, wasLost = false;
    while (!run.done && n < 400) { run.step(); n++; if (run.eng.bg3Anim) sawAnim = true; if (sawAnim && run.eng.bg3Anim && run.eng.baseFadeLut() === null) wasLost = true; }
    const m = run.eng.mem, intact = [0, 5, 15].every((e) => m.ewU16(AD.plttUnfaded + 32 + e * 2) === (e | (e << 5) | (e << 10))) && [0, 7].every((e) => m.ewU16(AD.plttUnfaded + 64 + e * 2) === ((16 + e) | ((16 + e) << 5) | ((16 + e) << 10)));
    ok(sawAnim && intact, 'Hypnosis: after the animation background and restorebg the terrain ramp is back in palette slots 1 and 2', 'sawAnim ' + sawAnim + ' intact ' + intact); }
  { // frames of Surf / Earthquake / Sandstorm carry what the PPU needs (a streamed BLDALPHA; BG3 scroll)
    const feats = (id) => { const run = an.start('move', id, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 } }); const fr = new Uint8ClampedArray(240 * 160 * 4); const seen = new Set(); let n = 0, bg3 = new Set(), dma = new Set();
      while (!run.done && n < 300) { run.step(); run.draw(fr); n++; for (const f of run.ppu.features) seen.add(f); bg3.add(run.eng.mem.io[0x1c] | (run.eng.mem.io[0x1d] << 8)); if (run.eng.mem.hblankDma) dma.add('0x' + (run.eng.mem.hblankDma.dad - 0x04000000).toString(16)); } return { seen, bg3: bg3.size, dma: [...dma] }; };
    const surf = feats(57), eq = feats(89);
    ok(surf.dma.includes('0x52'), 'Surf: the ROM streams BLDALPHA per scanline (HBlank DMA to 0x04000052), which the PPU replays', surf.dma.join(','));
    ok(eq.bg3 > 10, 'Earthquake: BG3 is scrolled by the ROM (' + eq.bg3 + ' different X values), which the base picture follows'); }
  // negative controls: each effect switched off must be DETECTED by the checks above
  { const gb = grayRun('move', 85); const orig = Engine.prototype.baseFadeLut; Engine.prototype.baseFadeLut = () => null;
    try { const s = grayRun('move', 85); ok(Math.min(...s.map((v) => v[0])) === e5(25) && Math.min(...gb.map((v) => v[0])) < e5(25), 'negative control: with the terrain colour map switched off Thunderbolt never dims the terrain (the check above fails)'); } finally { Engine.prototype.baseFadeLut = orig; } }
  { const orig = Engine.prototype.seedBaseRamp; Engine.prototype.seedBaseRamp = function () { this.terrainReloaded = false; };
    try { const s = grayRun('move', 85); ok(Math.min(...s.map((v) => v[0])) === e5(25), 'negative control: without the palette ramp the ROM\'s blends find nothing to fade (the terrain stays at ' + e5(25) + ')'); } finally { Engine.prototype.seedBaseRamp = orig; } }
  { const frameAt = (id, n) => { const r = an.start('move', id, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 } }); for (let i = 0; i < n && !r.done; i++) r.step(); const fr = new Uint8ClampedArray(240 * 160 * 4); for (let i = 0; i < fr.length; i += 4) { fr[i] = 80; fr[i + 1] = 120; fr[i + 2] = 88; fr[i + 3] = 255; } r.draw(fr); return fr; };
    const f = AnimPpu.prototype._regForLine; const good = frameAt(57, 40); AnimPpu.prototype._regForLine = function (off, y, bs) { return off >= 0x50 && off <= 0x55 ? bs : f.call(this, off, y, bs); };
    try { const bad = frameAt(57, 40); let d = 0; for (let i = 0; i < good.length; i++) if (good[i] !== bad[i]) d++; ok(d > 1000, 'negative control: a PPU that ignores the streamed BLDALPHA draws Surf differently (' + d + ' channel values differ at frame 40)'); } finally { AnimPpu.prototype._regForLine = f; } }
  { const run = (mode) => { const r = an.start('move', 33, { attacker: { side: 0, species: 6 }, target: { side: 1, species: 143 } }); const old = an.ppu.colorMath; an.ppu.colorMath = mode; const fr = new Uint8ClampedArray(240 * 160 * 4); const h = crypto.createHash('sha256'); let n = 0; while (!r.done && n < 200) { r.step(); for (let i = 0; i < fr.length; i += 4) { fr[i] = 200; fr[i + 1] = 200; fr[i + 2] = 200; fr[i + 3] = 255; } r.draw(fr); h.update(fr); n++; } an.ppu.colorMath = old; return h.digest('hex'); };
    ok(run('mgba') !== run('gba'), "the two colour-effect rules give different Tackle frames ('gba' = the hardware's 5-bit rule of rounds 1-5, 'mgba' = the pinned mGBA's, measured on the real game)"); }
}

if (ORACLE) {
  console.log("== real-game oracle (OR1): sprites, tasks, script, I/O registers and the END frame, frame by frame, with the real battle's own environment");
  const { openOracle } = await import('./pokemonarena_rom_oracle.mjs');
  const { captureMove } = await import('./pokemonarena_anim_oracle_probe.mjs');
  const { compareMove } = await import('./pokemonarena_anim_oracle_compare.mjs');
  const { reachMoveMenu, envCtx, FOE_SPECIES } = await import('./pokemonarena_anim_oracle_scenarios.mjs');
  const o = await openOracle({ stateDir: process.env.ARENA_OR1_DIR });
  // 33 Tackle, 52 Ember, 55 Water Gun, 85 Thunderbolt: plain; 24 Double Kick: Random2 + sprite slots; 54 Mist: self target; 5 Mega Punch: lag frames + the terrain-9 restore; 113 Light Screen: palette slots;
  // 232 Metal Claw: an open-bus read; 18 Whirlwind and 100 Teleport: need the wild / two-Pokemon scenarios the trainer battle refuses
  // the third value pins the END frame: 0 = the engine ends on the real game's frame; -1 = one frame early (the sound-length estimate is off by one for ~10% of the moves: ANIM.md, "Sound-effect waits")
  const CASES = [[33, 'trainer', 0], [52, 'trainer', -1], [55, 'trainer', 0], [85, 'trainer', 0], [24, 'trainer', 0], [54, 'trainer', 0], [5, 'trainer', 0], [113, 'trainer', 0], [232, 'trainer', -1], [18, 'wild', -1], [100, 'wild2', 0]];
  for (const [id, sc, endDelta] of CASES) {
    let cap = null, terrain = 0;
    for (const idle of [0, 7, 11, 17]) { await reachMoveMenu(o, sc); terrain = o.readU8(0x02001d43); cap = captureMove(o, { moves: [id, 33, 0, 0], idle }); if (cap.started >= 0 && cap.anim.length > 3) break; cap = null; }
    if (!ok(cap, `move ${id}: the real game animates it in the ${sc} scenario`)) continue;
    const r = await compareMove({ an, realSpr: cap.anim.map((a) => a.spr), realBsi: cap.anim.map((a) => a.bsi), realIo: cap.anim.map((a) => a.io), realTasks: cap.anim.map((a) => a.tasks), realBlk: cap.anim.map((a) => a.blk), realRng: cap.anim.map((a) => a.rng), moveId: id, spB: FOE_SPECIES[sc], ctx: envCtx(cap, terrain) });
    ok(r.exact === r.total && r.tasks.exact === r.tasks.total && r.io.shapeBad.length === 0 && (!r.blk.first || (endDelta !== 0 && r.blk.first.k === r.blk.lastK)) && r.end.delta === endDelta, `move ${id} [${sc}]: sprites ${r.exact}/${r.total}, tasks ${r.tasks.exact}/${r.tasks.total}, I/O ${r.io.exact}/${r.io.total} (shape differences [${r.io.shapeBad}]), script equal, end-frame delta ${r.end.delta}, lag frames [${r.lag}]`);
  }
  // negative control: the SAME comparison with the engine's old environment (dense sprite slots, default seed) must NOT be identical for Double Kick
  { await reachMoveMenu(o, 'trainer'); const cap = captureMove(o, { moves: [24, 33, 0, 0] });
    const r = await compareMove({ an, realSpr: cap.anim.map((a) => a.spr), realBsi: cap.anim.map((a) => a.bsi), realBlk: cap.anim.map((a) => a.blk), realRng: cap.anim.map((a) => a.rng), moveId: 24, ctx: { occupiedSlots: null } });
    ok(r.exact < r.total, 'negative control: Double Kick with the old dense sprite layout and the default seed is NOT identical to the real game', `${r.exact}/${r.total}`); }

  // ---- ROUND 6: the whole FIELD, pixel by pixel, and the luminance of the terrain (tools/pokemonarena_anim_field_compare.mjs). The sprite-state comparison above never looked at what the PPU draws.
  console.log('== round 6 against the real game: the field (everything but the healthboxes and the text window) frame by frame, the terrain luminance, and the oracle\'s colour-effect arithmetic');
  const FC = await import('./pokemonarena_anim_field_compare.mjs');
  const { createBattleUi } = await import('../pokemonarena/js/battle_ui.js'); const { loadPack } = await import('../pokemonarena/js/tables.js');
  const pack = loadPack(rom, { verify: 'header', dexText: false }), ui = createBattleUi(rom);
  const o6 = await FC.openFieldOracle();                  // the clock pinned to noon: the arena's terrain is the day picture
  const cal = await FC.calibrate(o6);
  ok(cal.brightnessMismatch === 0 && cal.brightnessChecked > 400000 && cal.alphaMismatch === 0 && cal.alphaChecked > 200000 && cal.fiveBitAlphaMismatch > 1000, `the oracle's colour effects are the PPU's: brightness up / down, EVY 1..16: ${cal.brightnessChecked} channel values, ${cal.brightnessMismatch} mismatches; alpha blend, 8 EVA / EVB pairs: ${cal.alphaChecked} values, ${cal.alphaMismatch} mismatches (the 5-bit rule: ${cal.fiveBitAlphaMismatch})`);
  const mid = (nm) => pack.moves.findIndex((m) => m && m.name === nm);
  const rows = {};
  // [name, bound on the mean differing field pixels per frame (of 18,496) at the aligned offset, bound within +-14 real frames]: the dimming moves, Surf and Mist are exact; Earthquake keeps a small residue (see ANIM.md);
  // Hypnosis / Confuse Ray / Psychic are exact up to ONE lag frame of the real game (one main-loop iteration that needs more than a video frame)
  const FIELD = [['Thunderbolt', 3, 3], ['Hyper Beam', 3, 3], ['Fire Blast', 3, 3], ['Rain Dance', 3, 3], ['Thunder Wave', 3, 3], ['Hail', 3, 3], ['Sunny Day', 3, 3], ['Ice Beam', 3, 3], ['Aurora Beam', 3, 3], ['Giga Drain', 3, 3], ['Tackle', 3, 3], ['Hydro Pump', 3, 3],
    ['Surf', 3, 3], ['Mist', 3, 3], ['Swords Dance', 3, 3], ['Earthquake', 100, 100], ['Hypnosis', 2000, 20], ['Confuse Ray', 2500, 20], ['Psychic', 4000, 20]];
  for (const [nm, bound, tolBound] of FIELD) {
    const lag = ['Hypnosis', 'Confuse Ray', 'Psychic'].includes(nm);
    const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid(nm), name: nm }); rows[nm] = r;
    ok(r.meanDiffPx <= bound && r.tolMeanDiffPx <= tolBound && (lag ? r.lumTolMaxDiff <= 2 : r.lumMaxDiff <= 1) && r.frames > 20, `${nm}: field ${r.meanDiffPx} differing px / frame (bound ${bound}), within +-14 frames ${r.tolMeanDiffPx} (bound ${tolBound}), terrain luminance within ${lag ? r.lumTolMaxDiff + ' (within +-14 frames; ' + r.lumMaxDiff + ' at the aligned frame: a fade shifted by the lag frame)' : r.lumMaxDiff} of the real game's over ${r.lumReal.length} samples [${r.lumReal.join(',')}]`);
  }
  { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Toxic'), name: 'Toxic', foe: 130 }); ok(r.meanDiffPx === 0 && r.exactFrames === r.frames, `Toxic (against a Gyarados: Snorlax's Immunity makes the real game skip the animation): ${r.frames} of ${r.frames} frames pixel-exact`, JSON.stringify(r).slice(0, 200)); }
  // negative controls: each missing effect must push the SAME comparison past its bound
  { const orig = Engine.prototype.baseFadeLut; Engine.prototype.baseFadeLut = () => null;
    try { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Thunderbolt'), name: 'Thunderbolt' });
      ok(r.meanDiffPx > 5000 && r.lumMaxDiff >= 40, `negative control: with the terrain colour map switched off Thunderbolt differs by ${r.meanDiffPx} px / frame and its luminance is off by ${r.lumMaxDiff} (round 5 measured 8351 and 77)`); } finally { Engine.prototype.baseFadeLut = orig; } }
  { const old = AnimPpu.prototype._regForLine; AnimPpu.prototype._regForLine = function (off, y, b) { return off >= 0x50 && off <= 0x55 ? b : old.call(this, off, y, b); };
    try { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Surf'), name: 'Surf' }); ok(r.meanDiffPx > 1000, `negative control: ignoring the streamed BLDALPHA leaves Surf ${r.meanDiffPx} px / frame off (bound 3)`); } finally { AnimPpu.prototype._regForLine = old; } }
  { const old = AnimPpu.prototype._regForLine; AnimPpu.prototype._regForLine = function (off, y, b) { const d = this.mem.hblankDma; return d && d.dad - 0x04000000 === off ? this.mem.read16(d.sad + 2 * y) : old.call(this, off, y, b); };
    try { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Surf'), name: 'Surf' }); ok(r.meanDiffPx > 100, `negative control: applying a streamed register to its OWN line (no one-line delay) leaves Surf ${r.meanDiffPx} px / frame off: all of line 111 (bound 3)`); } finally { AnimPpu.prototype._regForLine = old; } }
  { const old = AnimPpu.prototype._regForLine; AnimPpu.prototype._regForLine = function (off, y, b) { return off === 0x1c || off === 0x1e ? 0 : old.call(this, off, y, b); };
    try { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Earthquake'), name: 'Earthquake' }); ok(r.meanDiffPx > 500, `negative control: ignoring BG3's scroll leaves Earthquake ${r.meanDiffPx} px / frame off (bound 100)`); } finally { AnimPpu.prototype._regForLine = old; } }
  { const old = an.ppu.colorMath; an.ppu.colorMath = 'gba';
    try { const r = await FC.compareMove({ o: o6, an, ui, pack, moveId: mid('Aurora Beam'), name: 'Aurora Beam' }); ok(r.meanDiffPx > 1000, `negative control: the hardware's 5-bit colour effects (rounds 1-5) leave Aurora Beam ${r.meanDiffPx} px / frame off (bound 3)`); } finally { an.ppu.colorMath = old; } }
}

console.log(`\npokemonarena_anim_test: passed ${pass}, failed ${fail}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail === 0 ? 0 : 1);
