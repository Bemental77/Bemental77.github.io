// tools/pokemonarena_anim_coverage.mjs -- runs EVERY animation the ROM has (936 moves, 56 general, 10 status, 8 special, 81 background effects)
// through the engine and writes the honest coverage table: exact | approx | fallback | none, with the reason for each.
//
//   node tools/pokemonarena_anim_coverage.mjs [--out pokemonarena/js/anim_coverage.json] [--md <file>] [--oracle <final.json>] [--stat <stat_real.json>] [--quick]
//     --oracle  the real-game comparison (tools/pokemonarena_anim_oracle_batch.mjs + the summary step in ANIM.md): per move whether sprites, tasks, script, I/O shape and END FRAME all matched
//     --stat    tools/pokemonarena_anim_oracle_stat.mjs output (the 14 stat-change animations): marks general 0 verified when every arrow sprite matched
//
// Definitions (the same ones ANIM.md prints):
//   none      the ROM has no animation for it (its script is the ROM's immediate-`end` placeholder).
//   fallback  the engine could not play it: a CPU fault, an instruction-budget overrun, or a script that never ends (cut off at maxFrames).
//   approx    it plays to the end, but something it used is an approximation: an access to memory the model does not have (unmapped; an open-bus value is returned),
//             a Pokemon cry (its length is not modelled: the cry task ends at once), the real-time clock (pinned to noon), a PPU feature that is approximated
//             (anim_ppu.js APPROX_FEATURES), or a MEASURED difference from the real game (the oracle comparison did not match frame for frame, end frame included).
//             The sound-effect wait (IsSEPlaying) is modelled from the song header (anim_sound.js) and is NOT a reason by itself: its accuracy is measured by the end-frame
//             comparison, and a move whose end frame differs from the real game's is approx for that measured reason.
//   exact     it plays to the end through the ROM's own code with NONE of the above. "verified" in the JSON means additionally that a run of the
//             real game (OR1's mGBA oracle) produced the same sprite state frame for frame (tools/pokemonarena_anim_oracle_batch.mjs).
// The output holds statuses, counters and hashes only: no ROM bytes, no pixels.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createMoveAnimator, KIND_RANGE, AD } from '../pokemonarena/js/move_anim.js';
import { APPROX_FEATURES } from '../pokemonarena/js/anim_ppu.js';

const args = process.argv.slice(2);
const opt = { out: 'pokemonarena/js/anim_coverage.json', md: null, quick: false, oracle: null, stat: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--quick') opt.quick = true;
  else if (args[i] === '--oracle') opt.oracle = args[++i];
  else if (args[i] === '--stat') opt.stat = args[++i];
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--md') opt.md = args[++i];
}
const rom = new Uint8Array(fs.readFileSync(process.env.ARENA_ROM || 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
const an = await createMoveAnimator({ rom });
const eng = an.eng;
const DEFAULT_SCRIPT = 0x082ba097;
const base = new Uint8ClampedArray(240 * 160 * 4).fill(96);
const kinds = ['move', 'general', 'status', 'special', 'bg'];
const verified = { move: new Set(), general: new Set(), status: new Set(), special: new Set(), bg: new Set() };
const oracleDiff = { move: new Set() };
const oracleWhy = {}, neverAnimated = new Set(), endOff = new Set();
if (opt.oracle) {
  const fin = JSON.parse(fs.readFileSync(opt.oracle, 'utf8'));
  const full = new Set(fin.verified);
  for (const r of fin.all) {
    if (r.error) { neverAnimated.add(r.id); continue; }
    if (full.has(r.id)) { verified.move.add(r.id); continue; }
    const why = [];
    if (r.sprites[0] !== r.sprites[1]) why.push('sprites'); if (r.tasks[0] !== r.tasks[1]) why.push('tasks'); if (r.ioShapeBad && r.ioShapeBad.length) why.push('io'); if (!r.scriptEqual && !r.seWaitOnly) why.push('script');
    if (!why.length && r.end && r.end.delta !== 0) { why.push('end-frame' + (r.end.delta > 0 ? '+' : '') + r.end.delta); endOff.add(r.id); }
    oracleDiff.move.add(r.id); oracleWhy[r.id] = why;
  }
}
if (opt.stat) { const st = JSON.parse(fs.readFileSync(opt.stat, 'utf8')); if (st.length && st.every((c) => c.sprites && c.sprites[0] === c.sprites[1])) verified.general.add(0); }
const KNOWN = {   // reasons established by hand (ANIM.md, "Fallbacks"); the engine's own behaviour is still what sets fallback / exact
  move: { 502: 'doubles-only: Ally Switch swaps with a partner battler; the real singles battle never animates it (OR1: no animation in 22 tries over 11 scenarios)', 852: 'waits at 0x082bcef0 (waitforvisualfinish) for the BG-scroll task 0x08055121, which ends only on gBattleAnimArgs[7] == 0xffff; the real game passes that wait, the model does not (unexplained)' },
  general: { 3: 'waits (callback 0x080514ad) for the player mon sprite to reach animation command 1; the model\'s mon sprite stays on command 0' },
  special: { 4: 'waits (task 0x08052b09) for the player mon sprite to reach animation command 1; the model\'s mon sprite stays on command 0' },
};

const result = { schema: 2, tool: 'tools/pokemonarena_anim_coverage.mjs', romSha256: null, counts: {}, status: {}, reasons: {}, verified: {}, oracleDiff: {}, stats: {} };
const t0 = performance.now();
let totalFrames = 0;
for (const kind of kinds) {
  const [lo, hi] = KIND_RANGE[kind];
  result.status[kind] = {}; result.reasons[kind] = {};
  const stat = { frames: 0, instr: 0, maxInstrPerFrame: 0 };
  for (let id = lo; id <= hi; id++) {
    if (opt.quick && kind === 'move' && id > 60) break;
    let status = 'exact'; const why = [];
    let run = null, frames = 0, feats = new Set();
    const i0 = eng.cpu.icount;
    try {
      run = an.start(kind, id, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 1, args: kind === 'general' && id === 0 ? [] : [] });
      if (eng.mem.ewU32(AD.anim) === DEFAULT_SCRIPT && kind === 'move') { status = 'none'; why.push('placeholder-script'); }
      while (!run.done && frames < 1800) {
        const c0 = eng.cpu.icount;
        run.step(); frames++;
        stat.maxInstrPerFrame = Math.max(stat.maxInstrPerFrame, eng.cpu.icount - c0);
        if (frames % 6 === 1) { base.fill(96); run.draw(base); for (const f of an.ppu.features) feats.add(f); }
      }
      if (run.error) { status = 'fallback'; why.push('fault:' + run.error.name + ':' + String(run.error.message).replace(/0x[0-9a-f]+/g, 'X').slice(0, 48)); }
      else if (run.truncated || !run.done) { status = 'fallback'; why.push('never-ends'); }
    } catch (e) { status = 'fallback'; why.push('start:' + String(e.message).slice(0, 60)); }
    if (status === 'exact' || status === 'none') {
      // an unmapped read returns the open-bus value (the prefetched instruction); a move the real game CONFIRMED frame for frame (verified) has had that value checked, so it is not an approximation there
      if (eng.mem.unmapped.size && !(kind === 'move' && verified.move.has(id))) { status = status === 'none' ? status : 'approx'; why.push('unmapped:' + [...eng.mem.unmapped.keys()].slice(0, 3).join(',')); }
      if (eng.counters.cries) { status = status === 'none' ? status : 'approx'; why.push('cry-length:' + eng.counters.cries); }   // the cry task ends at once (cryModel 'none'); the `cry` event carries species and pan
      if (eng.counters.rtc) { status = status === 'none' ? status : 'approx'; why.push('rtc'); }
      for (const f of feats) if (APPROX_FEATURES.includes(f)) { status = status === 'none' ? status : 'approx'; why.push('ppu:' + f); }
      if (kind === 'move' && oracleDiff.move.has(id)) { status = status === 'none' ? status : 'approx'; why.push('oracle-diff:' + (oracleWhy[id] || []).join('+')); }
    }
    if (status === 'fallback' && KNOWN[kind] && KNOWN[kind][id]) why.push('known:' + KNOWN[kind][id]);
    if (kind === 'move' && neverAnimated.has(id) && status !== 'none') why.push('not-reachable-in-oracle');   // informational: the real game never animated it in any of 11 scenarios, so there is no comparison
    stat.frames += frames; stat.instr += eng.cpu.icount - i0; totalFrames += frames;
    if (run) stat.peakStepInstr = Math.max(stat.peakStepInstr || 0, run.peakStepInstr || 0), stat.heavySteps = (stat.heavySteps || 0) + (run.heavySteps || 0);
    result.status[kind][id] = status;
    if (why.length) result.reasons[kind][id] = why;
  }
  result.counts[kind] = { exact: 0, approx: 0, fallback: 0, none: 0 };
  for (const v of Object.values(result.status[kind])) result.counts[kind][v]++;
  result.verified[kind] = [...verified[kind]].sort((a, b) => a - b);
  if (kind === 'move') { result.oracleDiff.move = [...oracleDiff.move].sort((a, b) => a - b); result.neverAnimated = [...neverAnimated].sort((a, b) => a - b); result.endFrameOff = [...endOff].sort((a, b) => a - b); }
  result.stats[kind] = stat;
}
result.stats.wallMs = Math.round(performance.now() - t0); result.stats.totalFrames = totalFrames;
result.romSha256 = '8071e2c348d54c3ec7b78b53837c5cbd757d5cfc461a50fa5ffbc9f5ab35060a';
// hash of the status table: a test pins it, so any change to the engine that moves a status is a visible diff
result.statusHash = crypto.createHash('sha256').update(JSON.stringify(result.status)).digest('hex');
fs.writeFileSync(opt.out, JSON.stringify(result));
console.log('coverage', JSON.stringify(result.counts), 'frames', totalFrames, 'wall ms', result.stats.wallMs, 'statusHash', result.statusHash.slice(0, 16));
if (opt.md) {
  const lines = [];
  for (const kind of kinds) {
    lines.push(`### ${kind}  (${Object.entries(result.counts[kind]).map(([k, v]) => `${k} ${v}`).join(', ')})`, '', '| id | status | verified vs real game | reason |', '|---|---|---|---|');
    for (const [id, st] of Object.entries(result.status[kind])) {
      if (st === 'exact' && !verified[kind].has(Number(id)) && kind === 'move') continue;   // exact-by-construction moves are summarised, not listed
      lines.push(`| ${id} | ${st} | ${verified[kind].has(Number(id)) ? 'yes' : ''} | ${(result.reasons[kind][id] || []).join('; ')} |`);
    }
    lines.push('');
  }
  fs.writeFileSync(opt.md, lines.join('\n'));
}
