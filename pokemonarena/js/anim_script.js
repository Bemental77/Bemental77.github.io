// pokemonarena/js/anim_script.js -- static decoder for the ROM's battle-animation script bytecode.
//
// The engine itself never uses this module to play anything: the ROM's own interpreter (RunAnimScriptCommand + its 53 command handlers) runs on
// the ARMv4T interpreter in anim_cpu.js. This module is the READ-ONLY side: it names the commands, knows their operand layout, and walks a script
// without executing it, so tests can prove properties of every script in the ROM (it terminates, its sprite sheets decode, its sprite templates
// and task functions point into the cartridge ...) and tools can label what an animation is made of.
//
// The command table (index -> name, length) was derived two ways and they agree: (1) by running each of the ROM's 53 handlers on synthetic
// operand bytes and measuring how far the handler advances the script pointer, and (2) by tracing the commands the real scripts execute across
// all 936 moves (tools/pokemonarena_anim_test.mjs 'script command lengths'). The ROM's command table lives at ROM 0x00421154 (53 THUMB handler
// pointers; RunAnimScriptCommand at 0x080297b0 indexes it with the command byte). Names follow the Gen-3 vocabulary by behaviour; the numbering is THIS
// ROM's (it is not the vanilla Emerald numbering).
//
// Pure ES module: no ROM data inside, only layouts.

export class ScriptError extends Error { constructor(msg) { super(msg); this.name = 'ScriptError'; } }

export const CMD_TABLE_ROM_OFFSET = 0x421154;
export const CMD_COUNT = 53;

// kind: 'seq' (falls through) | 'end' | 'stop' (never returns) | 'jump' (no fall-through) | 'cond' (target + fall-through) | 'call' | 'return'
// ptrAt: operand offset of a script pointer (0 = the opcode byte is at 0). Lengths are in bytes including the opcode. 'var' = argc-prefixed.
// verified: true when the length was observed on executed real scripts (see test); false = measured on the handler only.
const T = (name, len, kind = 'seq', extra = {}) => ({ name, len, kind, ...extra });
export const COMMANDS = Object.freeze([
  T('loadspritegfx', 3), T('unloadspritegfx', 3),
  T('createsprite', 'var', 'seq', { argcAt: 6, base: 7 }),            // template ptr(4), subpriority u8, argc u8, argc x u16
  T('createvisualtask', 'var', 'seq', { argcAt: 6, base: 7 }),        // func ptr(4), priority u8, argc u8, argc x u16
  T('delay', 2), T('waitforvisualfinish', 1), T('hang1', 1, 'stop'), T('hang2', 1, 'stop'), T('end', 1, 'end'),
  T('playse', 3), T('monbg', 2), T('clearmonbg', 2), T('setalpha', 3), T('blendoff', 1),
  T('call', 5, 'call', { ptrAt: 1 }), T('return', 1, 'return'), T('setvar', 4),
  T('ifelse', 9, 'cond2', { ptrAt: 1, ptrAt2: 5 }),                   // taken pointer chosen by a condition byte: both are successors
  T('jumpif', 6, 'cond', { ptrAt: 2 }), T('jump', 5, 'jump', { ptrAt: 1 }),
  T('fadetobg', 2), T('restorebg', 1), T('waitbgfadeout', 1), T('waitbgfadein', 1), T('changebg', 2),
  T('panse_19', 4), T('setpan', 2), T('panse_1b', 7), T('panse_1c', 6), T('panse_1d', 5), T('setbldcnt', 3),
  T('createsoundtask', 'var', 'seq', { argcAt: 5, base: 6, verified: false }),
  T('waitsound', 1), T('jumpargeq', 8, 'cond', { ptrAt: 4 }), T('monbg_22', 2), T('clearmonbg_23', 2),
  T('jumpifcontest', 5, 'cond', { ptrAt: 1 }), T('op25', 4), T('op26', 7), T('panse_27', 7),
  T('op28', 2), T('op29', 1), T('op2a', 2), T('monbgprio_2b', 2), T('monbgprio_2c', 2), T('op2d', 2), T('invisible', 2), T('visible', 1),
  T('createtaskontargets', 'var', 'seq', { argcAt: 7, base: 8 }), T('createspriteontargets', 'var', 'seq', { argcAt: 7, base: 8 }), T('createspriteontargets_32', 'var', 'seq', { argcAt: 7, base: 8 }),
  // op33 (handler 0x0802a4a5): `33 value ptr` -- compares `value` with a species-derived byte and JUMPS to ptr when equal, else skips the 4 pointer bytes: a 6-byte conditional jump.
  // op34 (handler 0x080299b1): `34 b argc <argc x u16>` -- copies argc halfwords into gBattleAnimArgs, then creates the battler's form sprite: 3 + 2*argc bytes (it was listed as a fixed
  // 3 bytes, which desynchronised every walk through a script that uses it with arguments: Dragon Darts, move 697). Both read off the handlers' own pointer arithmetic.
  T('op33', 6, 'cond', { ptrAt: 2 }), T('op34', 'var', 'seq', { argcAt: 2, base: 3 }),
]);

const u8 = (rom, o) => rom[o];
const u16 = (rom, o) => rom[o] | (rom[o + 1] << 8);
const u32 = (rom, o) => (rom[o] | (rom[o + 1] << 8) | (rom[o + 2] << 16) | (rom[o + 3] << 24)) >>> 0;
const romOff = (rom, p) => { if (p < 0x08000000 || p - 0x08000000 >= rom.length) return -1; return p - 0x08000000; };

/** Decode one command at ROM offset `o`. Returns { op, name, len, kind, ptrs: [romOffsets|-1], args: number[] }. Throws ScriptError for an opcode the table does not know. */
export function decodeCommand(rom, o) {
  const op = u8(rom, o);
  const c = COMMANDS[op];
  if (!c) throw new ScriptError(`unknown command 0x${op.toString(16)} at ROM 0x${o.toString(16)}`);
  let len = c.len;
  const args = [];
  if (len === 'var') { const argc = u8(rom, o + c.argcAt); len = c.base + 2 * argc; for (let i = 0; i < argc; i++) args.push(u16(rom, o + c.base + 2 * i)); }
  const ptrs = [];
  if (c.ptrAt) ptrs.push(romOff(rom, u32(rom, o + c.ptrAt)));
  if (c.ptrAt2) ptrs.push(romOff(rom, u32(rom, o + c.ptrAt2)));
  const out = { op, name: c.name, len, kind: c.kind, ptrs, args, at: o };
  if (op === 0x00 || op === 0x01) out.tag = u16(rom, o + 1);
  if (op === 0x02 || op === 0x03) { out.target = u32(rom, o + 1); out.sub = u8(rom, o + 5); }
  if (op === 0x09) out.song = u16(rom, o + 1);
  if (op === 0x14) out.bg = u8(rom, o + 1);
  return out;
}

/**
 * Walk every command reachable from `start` (ROM offset), following jumps, calls and both arms of conditionals, without executing anything.
 * Returns { commands: [decoded...], ends: n, spriteTags:Set, templates:Set(ROM pointers), tasks:Set(ROM pointers), songs:Set, bgs:Set, loops: bool, budgetExceeded: bool }.
 * `budget` bounds the number of distinct commands visited (typed result, never a hang).
 */
export function walkScript(rom, start, budget = 4000) {
  const seen = new Set(), stack = [start], commands = [];
  const res = { commands, ends: 0, stops: 0, spriteTags: new Set(), templates: new Set(), tasks: new Set(), songs: new Set(), bgs: new Set(), loops: false, budgetExceeded: false, error: null };
  const calls = [];
  while (stack.length) {
    let o = stack.pop();
    while (true) {
      if (o < 0 || o >= rom.length) { res.error = `script runs off the cartridge at ${o}`; break; }
      if (seen.has(o)) { res.loops = res.loops || true; break; }
      if (seen.size >= budget) { res.budgetExceeded = true; return res; }
      seen.add(o);
      let c;
      try { c = decodeCommand(rom, o); } catch (e) { res.error = e.message; break; }
      commands.push(c);
      if (c.tag !== undefined && c.op === 0x00) res.spriteTags.add(c.tag);
      if (c.op === 0x02) res.templates.add(c.target);
      if (c.op === 0x03) res.tasks.add(c.target);
      if (c.song !== undefined) res.songs.add(c.song);
      if (c.bg !== undefined) res.bgs.add(c.bg);
      if (c.kind === 'end') { res.ends++; break; }
      if (c.kind === 'stop') { res.stops++; break; }
      if (c.kind === 'return') break;
      if (c.kind === 'jump') { o = c.ptrs[0]; continue; }
      if (c.kind === 'call') { stack.push(o + c.len); o = c.ptrs[0]; continue; }   // the callee's `return` resumes after the call: walk the continuation too
      if (c.kind === 'cond' || c.kind === 'cond2') for (const p of c.ptrs) stack.push(p);
      if (c.kind === 'cond2') break;
      o += c.len;
    }
  }
  return res;
}
