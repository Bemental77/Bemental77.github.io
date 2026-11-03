// tools/pokemonarena_anim_sheets.mjs - contact sheets (PNG strips) of the battle animations as the SCENE plays them, for a human (or an agent) to OPEN and judge.
//
//   node tools/pokemonarena_anim_sheets.mjs [name ...]      names: sendout tackle ember watergun growl swordsdance thunderwave rain faint all (default all)
//   ARENA_OUT=<dir>   (default: the AN1 scratch folder)      ARENA_ANIMATOR=real|none (default real; "none" = no move animator, the lunge fallback)
//   ARENA_FRAMES=12   frames per strip                       ARENA_COLS=4
//
// Nothing here is committed or asserted: the PNGs hold ROM-derived pixels and live only in the output folder. Each sheet is a scripted 1v1 battle (a level-50
// attacker with the chosen move against a bulky foe), run through the real scene (scene.js + battle_ui.js) with animations ON; the strip is N frames spread evenly
// across the step being shown, labelled in the printed table with the move, what the animator reported for it (exact / approx / fallback / none) and the frame count.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gridSheet, writePNG } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const OUT = process.env.ARENA_OUT || 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin-Dev-Bemental77-github-io/c5557fc3-6bdd-45f1-a13c-2116f656d0fe/scratchpad/AN1/sheets';
const FRAMES = Number(process.env.ARENA_FRAMES || 12), COLS = Number(process.env.ARENA_COLS || 4);
fs.mkdirSync(OUT, { recursive: true });
const u = (f) => pathToFileURL(path.join(JS, f)).href;
const [T, B, BT, MC, SC, AI, AM] = await Promise.all(['tables.js', 'battle_ui.js', 'battle_text.js', 'matchctl.js', 'scene.js', 'ai.js', 'anim_mon.js'].map((f) => import(u(f))));
const romBuf = fs.readFileSync(path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba'));
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'));
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
const ui = B.createBattleUi(rom), text = BT.loadBattleText(rom, manifest);
let animator = null;
if ((process.env.ARENA_ANIMATOR || 'real') === 'real') { try { let coverage = null; try { coverage = JSON.parse(fs.readFileSync(path.join(JS, 'anim_coverage.json'), 'utf8')); } catch (_e) { /* none */ } animator = await (await import(u('move_anim.js'))).createMoveAnimator({ rom, coverage }); } catch (e) { console.log('no move animator:', String(e.message).slice(0, 100)); } }

const mid = (n) => pack.moves.findIndex((m) => m && m.name === n);
const cfg = { get: () => ({ on: true, speed: 1, skip: false }) };

// a 1v1 battle: the player's lead (species, level 50) knows `moves`; the foe is a bulky Snorlax that only uses Harden. `drive(scene)` is called every frame.
function battle(o) {
  const mk = (species, moves, seed) => { const t = MC.randomTeam(pack, seed, 1); const r = t.recs[0]; r.species = species; r.level = 50; r.moves = moves.map((id) => ({ id, ppUps: 0 })); return t; };
  const A = mk(o.species || 6, o.moves, 101), Bt = mk(143, [mid('Harden') >= 0 ? mid('Harden') : 106, mid('Rest') >= 0 ? mid('Rest') : 156], 102);
  A.meta[0] = { gender: null, shiny: false }; Bt.meta[0] = { gender: null, shiny: false };
  const ctl = MC.createMatchController({ pack, teams: [A.recs, Bt.recs], seed: o.seed || 7, pick: 0, names: ['You', 'CPU'], validate: false, sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 3 }] });
  const scene = SC.createScene({ ui, pack, text, ctl, viewSide: 0, env: o.env === undefined ? 4 : o.env, textSpeed: 'fast', meta: [A.meta, Bt.meta], trainer: 'CPU', playerName: 'You', anim: cfg, animator, animSeed: 5 });
  let slot = 0;
  scene.S.auto = { decide(req) { if (req.phase === 'move') { const k = req.moves.findIndex((m) => m.id === o.moves[Math.min(slot, o.moves.length - 1)] && !m.disabled); slot++; return { kind: 'move', slot: req.moves[Math.max(0, k)].slot }; } if (req.phase === 'switch') return { kind: 'switch', slot: req.options ? req.options[0].slot : 0 }; return null; } };
  ctl.start(); scene.begin();
  return { scene, ctl };
}
const pump = (scene) => { scene.tick(); if (scene.mode === 'steps' && scene.S.cur && scene.S.cur.t === 'text') scene.press('a'); };
const snap = () => { const f = ui.render(cur.scene.view()); return { width: 240, height: 160, rgba: f.rgba }; };
let cur = null;

// play until `match(step)` is the running step, then return its length by playing to the end of it
function measure(o, match) {
  const b = battle(o); cur = b;
  let n = 0, start = -1, end = -1, step = null;
  while (n++ < 30000 && b.scene.mode !== 'result') {
    pump(b.scene);
    const s = b.scene.S.cur;
    if (start < 0 && s && match(s)) { start = n; step = s; }
    if (start >= 0 && s !== step) { end = n; break; }
  }
  return { start, end, len: end - start, info: b.scene.animInfo() };
}
function strip(o, match) {
  const m = measure(o, match);
  if (m.start < 0) return { err: 'step never occurred' };
  const b = battle(o); cur = b;
  const want = new Set(Array.from({ length: FRAMES }, (_, i) => m.start + Math.floor((i * (m.len - 1)) / Math.max(1, FRAMES - 1))));
  const frames = []; let n = 0, ms = 0, k = 0, worst = 0;
  while (n++ < m.end + 2) {
    const t0 = process.hrtime.bigint(); pump(b.scene); const v = b.scene.view(); const t1 = process.hrtime.bigint();
    if (n >= m.start && n < m.end) { const dt = Number(t1 - t0) / 1e6; ms += dt; k++; worst = Math.max(worst, dt); }
    if (want.has(n)) frames.push(snap());
  }
  return { frames, len: m.len, avgMs: k ? ms / k : 0, worstMs: worst, info: b.scene.animInfo() };
}

const SHEETS = {
  sendout: () => { const o = { moves: [mid('Tackle')] }; return { title: 'send-out (the player\'s ball)', o, match: (s) => s.t === 'slidein' && s.side === 0 }; },
  tackle: () => ({ title: 'Tackle (physical)', o: { moves: [mid('Tackle')] }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Tackle') }),
  ember: () => ({ title: 'Ember (special)', o: { moves: [mid('Ember')] }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Ember') }),
  watergun: () => ({ title: 'Water Gun (special)', o: { moves: [mid('Water Gun')], species: 7 }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Water Gun') }),
  growl: () => ({ title: 'Growl (status, foe-targeting)', o: { moves: [mid('Growl')] }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Growl') }),
  swordsdance: () => ({ title: 'Swords Dance (status, self-targeting)', o: { moves: [mid('Swords Dance')] }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Swords Dance') }),
  thunderwave: () => ({ title: 'Thunder Wave (status move; its paralysis animation follows)', o: { moves: [mid('Thunder Wave')], species: 25 }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Thunder Wave') }),
  growlstat: () => ({ title: 'Growl: the foes Attack falls (stat arrows, general 0)', o: { moves: [mid('Growl')] }, match: (s) => s.t === 'moveanim' && s.kind === 'general' && s.id === 0 }),
  paralysis: () => ({ title: 'Thunder Wave: paralysis (status 5)', o: { moves: [mid('Thunder Wave')], species: 25 }, match: (s) => s.t === 'moveanim' && s.kind === 'status' }),
  rain: () => ({ title: 'Rain Dance (weather move)', o: { moves: [mid('Rain Dance')] }, match: (s) => s.t === 'moveanim' && s.kind === 'move' && s.id === mid('Rain Dance') }),
  faint: () => ({ title: 'faint (Hyper Beam finishes a weakened foe)', o: { moves: [mid('Hyper Beam'), mid('Hyper Beam'), mid('Hyper Beam'), mid('Hyper Beam')], species: 150, foeLevelOne: true }, match: (s) => s.t === 'faint' }),
};
const names = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const run = names.length && names[0] !== 'all' ? names : Object.keys(SHEETS);
console.log('animator:', animator ? 'real (move_anim.js)' : 'none (lunge fallback)', '| frames per strip', FRAMES, '| out', OUT);
console.log('sheet'.padEnd(12), 'what'.padEnd(46), 'frames', 'avg ms/frame', 'worst ms', 'animator said');
for (const name of run) {
  if (!SHEETS[name]) { console.log(name, 'unknown'); continue; }
  const d = SHEETS[name]();
  if (d.o.moves.some((x) => !(x >= 0))) { console.log(name.padEnd(12), 'a move id was not found in this pack'); continue; }
  let r;
  try { r = strip(d.o, d.match); } catch (e) { console.log(name.padEnd(12), 'error', String(e.message).slice(0, 100)); continue; }
  if (r.err) { console.log(name.padEnd(12), r.err); continue; }
  const sh = gridSheet(r.frames, COLS, 1, 4);
  writePNG(path.join(OUT, 'sheet_' + name + '.png'), sh.width, sh.height, sh.rgba);
  console.log(name.padEnd(12), d.title.padEnd(46), String(r.len).padStart(6), r.avgMs.toFixed(2).padStart(12), r.worstMs.toFixed(2).padStart(8), JSON.stringify(r.info.byId), JSON.stringify(r.info.log));
}
void AM; void AI;
