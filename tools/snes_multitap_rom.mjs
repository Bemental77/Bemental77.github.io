// snes_multitap_rom.mjs — a 128 KB LoROM, written here, that READS FIVE PADS
// THROUGH A SUPER MULTITAP the way a multitap game does, and leaves what it
// read in work RAM. No commercial ROM is shipped that uses a multitap
// (snes/snesWasm/roms holds SimCity only), so the 3- and 4-player tests drive
// this instead. It is GUEST CODE on the real bus path — S9xGetCPU's $4016/$4017
// and the auto-read registers — not a peek at the page's own variables.
//
// What the program does, every frame:
//   wait for V-blank, then for the auto-joypad read to finish ($4212 bit 0);
//   pad 1 <- $4218/9, pad 2 <- $421A/B, pad 3 <- $421E/F ($4201 bit 7 = 1);
//   $4201 bit 7 <- 0, then 16 serial reads of $4017: data line 0 -> pad 4,
//   data line 1 -> pad 5 (the multitap's second half); $4201 <- $FF;
//   a running sum per pad byte (the "game state" every pad feeds), frame count.
// At reset it latches $4016 and reads $4017 once: bit 1 is the multitap's
// presence ID (ppu.c returns 2 when IPPU.Controller == SNES_MULTIPLAYER5).
//
// WORK RAM MAP (Memory.RAM, i.e. bank $7E):
//   $10-$19  pads 1..5 as read this frame, little-endian 16-bit words
//   $20-$29  running byte sums of $10-$19 (mod 256) — depends on every pad's history
//   $30      frame counter (mod 256)
//   $31      $4017 read with $4016 latched, at reset (2 = a multitap answered)
//
// USAGE  import { buildMultitapRom, WRAM } from './snes_multitap_rom.mjs'
export const WRAM = { pads: 0x10, sums: 0x20, frame: 0x30, mtapId: 0x31 };

export function buildMultitapRom() {
  const ROM = new Uint8Array(0x20000);
  const code = [];
  const b = (...xs) => { for (const x of xs) code.push(x & 0xff); };
  const here = () => code.length;
  const rel = (from, to) => { const d = to - (from + 2); if (d < -128 || d > 127) throw new Error('branch out of range'); return d & 0xff; };
  const abs = (op, a) => b(op, a & 0xff, (a >> 8) & 0xff);
  // ── reset ──
  b(0x78);                    // SEI
  b(0x18, 0xfb);              // CLC ; XCE  -> native mode, A/X 8-bit
  b(0xc2, 0x10);              // REP #$10
  b(0xa2, 0xff, 0x1f);        // LDX #$1FFF
  b(0x9a);                    // TXS
  b(0xe2, 0x10);              // SEP #$10
  abs(0x9c, 0x4200);          // STZ $4200  (NMI off)
  b(0xa9, 0x80); abs(0x8d, 0x2100);  // forced blank
  b(0xa2, 0x00);              // LDX #0
  const clr = here();
  b(0x74, 0x00);              // STZ $00,X
  b(0xe8);                    // INX
  b(0xe0, 0x40);              // CPX #$40
  { const at = here(); b(0xd0, rel(at, clr)); }    // BNE clr
  // multitap presence: latch, read $4017, unlatch
  b(0xa9, 0x01); abs(0x8d, 0x4016);
  abs(0xad, 0x4017); b(0x85, 0x31);                // LDA $4017 ; STA $31
  abs(0x9c, 0x4016);                               // STZ $4016
  b(0xa9, 0xff); abs(0x8d, 0x4201);                // $4201 <- $FF
  b(0xa9, 0x01); abs(0x8d, 0x4200);                // auto-joypad read ON, NMI off
  // ── main loop ──
  const main = here();
  const w1 = here(); abs(0xad, 0x4212); { const at = here(); b(0x30, rel(at, w1)); }  // wait while in V-blank
  const w2 = here(); abs(0xad, 0x4212); { const at = here(); b(0x10, rel(at, w2)); }  // wait for V-blank
  const w3 = here(); abs(0xad, 0x4212); b(0x4a); { const at = here(); b(0xb0, rel(at, w3)); } // wait auto-read done
  for (const [reg, zp] of [[0x4218, 0x10], [0x4219, 0x11], [0x421a, 0x12], [0x421b, 0x13], [0x421e, 0x14], [0x421f, 0x15]]) { abs(0xad, reg); b(0x85, zp); }
  b(0x64, 0x16, 0x64, 0x17, 0x64, 0x18, 0x64, 0x19);   // STZ $16..$19
  abs(0x9c, 0x4201);                                     // $4201 bit 7 <- 0 : pads 4/5
  b(0xa2, 16);                                           // LDX #16
  const m = here();
  abs(0xad, 0x4017);                                     // LDA $4017
  b(0x4a, 0x26, 0x16, 0x26, 0x17);                       // LSR ; ROL $16 ; ROL $17   (data 0 -> pad 4)
  b(0x4a, 0x26, 0x18, 0x26, 0x19);                       // LSR ; ROL $18 ; ROL $19   (data 1 -> pad 5)
  b(0xca);                                               // DEX
  { const at = here(); b(0xd0, rel(at, m)); }            // BNE m
  b(0xa9, 0xff); abs(0x8d, 0x4201);                      // $4201 <- $FF
  b(0xa2, 0x00);                                         // LDX #0
  const s = here();
  b(0xb5, 0x20, 0x18, 0x75, 0x10, 0x95, 0x20);           // LDA $20,X ; CLC ; ADC $10,X ; STA $20,X
  b(0xe8, 0xe0, 0x0a);                                   // INX ; CPX #10
  { const at = here(); b(0xd0, rel(at, s)); }
  b(0xe6, 0x30);                                         // INC $30
  { const at = here(); b(0x80, rel(at, main)); }         // BRA main
  const nmi = here(); b(0x40);                           // RTI (never enabled)
  ROM.set(code, 0);
  // ── header ($7FC0 in a LoROM image) ──
  const name = 'BEMENTAL MULTITAP TEST';
  for (let i = 0; i < 21; i++) ROM[0x7fc0 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  ROM[0x7fd5] = 0x20;   // LoROM, slow
  ROM[0x7fd6] = 0x00;   // ROM only
  ROM[0x7fd7] = 0x07;   // 128 KB
  ROM[0x7fd8] = 0x00;   // no SRAM
  ROM[0x7fd9] = 0x01;   // North America (NTSC)
  ROM[0x7fda] = 0x33;
  ROM[0x7fdb] = 0x00;
  const vec = (off, a) => { ROM[off] = a & 0xff; ROM[off + 1] = (a >> 8) & 0xff; };
  const base = 0x8000;
  for (const o of [0x7fe4, 0x7fe6, 0x7fe8, 0x7fea, 0x7fee, 0x7ff4, 0x7ff8, 0x7ffa, 0x7ffe]) vec(o, base + nmi);
  vec(0x7ffc, base);    // RESET
  // checksum over the image with the complement/checksum fields set to ffff/0000
  vec(0x7fdc, 0xffff); vec(0x7fde, 0x0000);
  let sum = 0; for (let i = 0; i < ROM.length; i++) sum = (sum + ROM[i]) & 0xffff;
  vec(0x7fdc, sum ^ 0xffff); vec(0x7fde, sum);
  return ROM;
}
