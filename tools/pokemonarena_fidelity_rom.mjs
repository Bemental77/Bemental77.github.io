// tools/pokemonarena_fidelity_rom.mjs -- runs the Pokemon SoulGold ROM's OWN battle-interface code (via tools/pokemonarena_fidelity_cpu.mjs) so the
// FIDELITY stage can compare the arena with what the game itself computes. Hand-written; contains no ROM data: addresses only, and every
// result is produced by executing the ROM bytes the caller passes in.
//
// Addresses (file offset = address - 0x08000000), each found by the method in pokemonarena/FIDELITY.md:
//   MoveBattleBar            0x08085ecc  (THUMB)  draws the 6-tile HP bar of a healthbox: calls CalcNewBarValue, CalcBarFilledPixels, picks the colour
//   CalcNewBarValue          0x080839e4           the drain/fill step (returns the HP to print, or -1 when the bar has arrived)
//   CalcBarFilledPixels      0x0808434c           HP -> filled pixels (spread over 6 tiles)
//   GetScaledHPFraction      0x08086c84           hp * scale / maxHp, never 0 while hp > 0 (party menu, summary)
//   GetHPBarLevel            0x08086cac           4 full / 3 green / 2 yellow / 1 red / 0 empty (party menu, summary, low-HP beep)
//   CopyToTileMem?           0x0808490c           the healthbox tile copy MoveBattleBar calls once per bar tile (hooked to record which element it copies)
//   element table            0x0872028c           the 32-byte healthbox element tiles: index 3..11 green 0..8 px, 50..58 yellow, 59..67 red
//   __divsi3 / __udivsi3     0x0828913c / 0x08289070 (THUMB veneers into ARM routines at 0x0800046c / 0x08000350)
import { createCpu, DIV_HOOKS } from './pokemonarena_fidelity_cpu.mjs';

export const ADDR = Object.freeze({
  moveBattleBar: 0x08085ecc, calcNewBarValue: 0x080839e4, calcBarFilledPixels: 0x0808434c, getScaledHPFraction: 0x08086c84, getHPBarLevel: 0x08086cac,
  tileCopy: 0x0808490c, elementTable: 0x0872028c, divsi3: 0x0828913c, udivsi3: 0x08289070,
});
const EL = Object.freeze({ green: 3, yellow: 50, red: 59 });   // element index of the "0 px" tile of each colour (+k = k filled pixels)

export function createBarRom(rom) {
  const copies = [];
  const hooks = {
    [ADDR.divsi3]: DIV_HOOKS.signed, [ADDR.udivsi3]: DIV_HOOKS.unsigned,
    [ADDR.tileCopy]: (cpu) => { copies.push(cpu.r[1] >>> 0); },
  };
  const cpu = createCpu(rom, { maxSteps: 400000, hooks });
  // plain (un-hooked) CPU: the division routines run as ROM code -- used to prove the hook agrees with the ROM
  const cpuPlain = createCpu(rom, { maxSteps: 400000, hooks: { [ADDR.tileCopy]: (c) => { copies.push(c.r[1] >>> 0); } } });
  const P = 0x02010000, BARS = 0x02011000, SPRITEBAR = 0;
  function arm(c, max, old, recv) {
    c.reset();
    c.wr32(0x02001c4c, P);                                           // gBattleSpritesDataPtr -> a struct whose first five fields point at scratch arrays
    for (let i = 0; i < 6; i++) c.wr32(P + 4 * i, 0x02020000 + i * 0x1000);
    c.wr32(P + 12, BARS);                                            // ->battleBars
    c.wr32(BARS + 4, max); c.wr32(BARS + 8, old); c.wr32(BARS + 12, recv); c.wr32(BARS + 16, -32768);
    return BARS + 16;
  }
  function decodeCopies() {
    let px = 0, color = null;
    for (const s of copies) {
      const e = (s - ADDR.elementTable) / 32;
      if (e >= EL.green && e <= EL.green + 8) { px += e - EL.green; color = color || 'hpGreen'; }
      else if (e >= EL.yellow && e <= EL.yellow + 8) { px += e - EL.yellow; color = color || 'hpYellow'; }
      else if (e >= EL.red && e <= EL.red + 8) { px += e - EL.red; color = color || 'hpRed'; }
      else throw new Error('unexpected healthbox element copy 0x' + s.toString(16));
    }
    return { px, color, tiles: copies.length };
  }
  function frame(c) {
    copies.length = 0;
    const r0 = c.call(ADDR.moveBattleBar | 1, [SPRITEBAR, 0, 0, 0], { keepMem: true }).r0;
    return Object.assign({ ret: r0 }, decodeCopies());
  }
  return {
    cpu, cpuPlain, ADDR,
    // one MoveBattleBar call on a fresh bar at rest on `hp` (what a switch-in draws): { px, color }
    staticBar(max, hp, which = cpu) { arm(which, max, hp, 0); const f = frame(which); return { px: f.px, color: f.color, tiles: f.tiles }; },
    // every frame of a drain/fill `from` -> `to` on a bar of `max`: [{ ret, px, color, curr }] until the ROM returns -1 (inclusive)
    drain(max, from, to, cap = 4000) {
      const cv = arm(cpu, max, from, from - to), out = [];
      for (let i = 0; i < cap; i++) { const f = frame(cpu); f.curr = cpu.rd32(cv); out.push(f); if (f.ret === -1) break; }
      return out;
    },
    // the ROM's pure functions, called directly
    scaledFraction(hp, max, scale) { return cpu.call(ADDR.getScaledHPFraction | 1, [hp, max, scale], { keepMem: true }).r0 & 255; },
    barLevel(hp, max) { return cpu.call(ADDR.getHPBarLevel | 1, [hp, max], { keepMem: true }).r0; },
    // CalcNewBarValue called directly (what the unit tests mutate): returns { ret, curr }
    newBarValue(max, old, recv, currIn, scale, toAdd) {
      cpu.reset(); cpu.wr32(0x02000100, currIn);
      const r = cpu.call(ADDR.calcNewBarValue | 1, [max, old, recv, 0x02000100, scale, toAdd], { keepMem: true });
      return { ret: r.r0, curr: cpu.rd32(0x02000100) };
    },
  };
}
