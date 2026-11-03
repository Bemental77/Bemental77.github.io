// tools/pokemonarena_anim_oracle_intro.mjs -- records the REAL game's battle start frame by frame (gSprites, gTasks, the I/O registers, the battle main function), with L held so the
// hack's battle-speed loop runs at its native rate, from the moment gMain.callback2 is pointed at CB2_InitBattle until the action menu.
//   node tools/pokemonarena_anim_oracle_intro.mjs --dir <oracle state dir> --out <file.cap.gz> [--kind wild|trainer] [--species 19] [--shiny 1]
// The output is a gzip JSON of per-frame Buffers (scratch only; never committed). A summary lists every sprite callback and task function in the order it first appears, which is how the
// ROM's own send-out / intro routines are found (they are the sprite callbacks and tasks the real run executes).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { openOracle, KEY, FINDINGS, FUNCS } from './pokemonarena_rom_oracle.mjs';

const args = process.argv.slice(2), opt = { dir: undefined, out: null, kind: 'wild', species: '19', shiny: '0', reach: 'action', follower: '0', shots: '' };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
const o = await openOracle({ stateDir: opt.dir });
const frames = [], shots = {};
const shotAt = new Set((opt.shots || '').split(',').filter(Boolean).map(Number));
const SPR = 0x0203beb4;
const origSet = o.core.setKeys.bind(o.core), origRun = o.core.runFrame.bind(o.core);
let rec = false, curKeys = 0;
o.core.setKeys = (p, k) => { curKeys = k; return origSet(p, k | KEY.L); };
o.core.runFrame = () => {
  origRun();
  if (!rec) return;
  if (shotAt.has(frames.length)) { shots[frames.length] = Buffer.from(o.screenshotRGBA()).toString('base64'); shots['pal' + frames.length] = Buffer.from(o.readBytes(0x05000000, 0x400)).toString('base64'); }
  frames.push({
    keys: curKeys, terrain: o.readU8(0x02001d43), rng: o.readU32(0x03005a74), vb: o.readU32(FINDINGS.gMain.addr + 0x20), spr: Buffer.from(o.readBytes(SPR, 64 * 0x44)), tasks: Buffer.from(o.readBytes(0x03005b34, 640)), io: Buffer.from(o.readBytes(0x04000000, 0x58)),
    main: o.readU32(FINDINGS.gBattleMainFunc.addr), ctl: [0, 1, 2, 3].map((i) => o.readU32(FINDINGS.gBattlerControllerFuncs.addr + 4 * i)), cb2: o.readU32(FINDINGS.gMain.addr + 4),
    bsi: Buffer.from(o.readBytes(0x02001d4c, 4)), fade: Buffer.from(o.readBytes(0x0203844c, 0x20)),
  });
};
// start recording when the battle is being built: startBattle writes callback2 = CB2_InitBattle, then runs frames
const wrapSet = o.writeU32.bind(o), wrapSet8 = o.writeU8.bind(o);
o.writeU32 = (a, v) => {
  if (a === FINDINGS.gMain.addr + 4 && v === FUNCS.cb2.battleInit) {
    rec = true;
    // The pinned save has the lead Pokemon FOLLOWING the player in the overworld (an object event with local id 0xfe at gObjectEvents, 36 bytes each from 0x02003314): the ROM's send-out
    // then skips the ball throw (task data 253 instead of 255; function 0x080666f4 -> 0x0813ba78). The arena has no overworld, so --follower 0 (default) deactivates all object events first.
    if (opt.maptype !== undefined) wrapSet8(0x02003840, Number(opt.maptype));   // gMapHeader.mapType: the battle background is tinted by the time of day only on an outdoor map type (1..3, 6)
    if (opt.follower !== '1') for (let i = 0; i < 16; i++) wrapSet8(0x02003314 + 36 * i, 0);
  }
  return wrapSet(a, v);
};
const foe = { species: Number(opt.species), level: 2, moves: [33], hp: 30, maxHp: 30 };
if (opt.shiny === '1') foe.shinyPid = true;
await o.startBattle({ foe, reach: opt.reach, trainer: opt.kind === 'trainer' ? false : false });
rec = false;
const cbs = new Map(), tfs = new Map();
frames.forEach((f, k) => {
  for (let i = 0; i < 64; i++) if (f.spr[i * 0x44 + 0x3e] & 1) { const cb = f.spr.readUInt32LE(i * 0x44 + 0x1c).toString(16); if (!cbs.has(cb)) cbs.set(cb, { first: k, slot: i }); }
  for (let i = 0; i < 16; i++) if (f.tasks[i * 40 + 4] === 1) { const fn = f.tasks.readUInt32LE(i * 40).toString(16); if (!tfs.has(fn)) tfs.set(fn, { first: k, slot: i }); }
});
console.log('frames recorded', frames.length);
console.log('sprite callbacks (first frame, slot):', [...cbs].map(([c, v]) => `${c}@${v.first}/${v.slot}`).join(' '));
console.log('task functions (first frame, slot):', [...tfs].map(([c, v]) => `${c}@${v.first}/${v.slot}`).join(' '));
const mains = []; let last = ''; frames.forEach((f, k) => { const s = f.main.toString(16) + '/' + f.ctl[0].toString(16) + '/' + f.ctl[1].toString(16); if (s !== last) { mains.push(k + ':' + s); last = s; } });
console.log('main/controller functions over time:', mains.join(' '));
if (opt.out && Object.keys(shots).length) fs.writeFileSync(opt.out + '.shots.json', JSON.stringify(shots));
if (opt.out) { const b = (x) => x.toString('base64'); fs.writeFileSync(opt.out, zlib.gzipSync(JSON.stringify(frames.map((f) => ({ ...f, spr: b(f.spr), tasks: b(f.tasks), io: b(f.io), bsi: b(f.bsi), fade: b(f.fade) }))))); console.log('written', opt.out); }
