// genesis_multitap_rom.mjs — a 128 KB Mega Drive ROM, written here, whose
// 68000 code READS FOUR PADS THROUGH A MULTITAP, BOTH KINDS, and leaves what it
// read in work RAM. No shipped ROM uses one (genesis/genesisWasm/roms holds
// Sonic 3 and X-Men, both two-player), so the 3- and 4-player tests drive this.
// It is GUEST CODE on the real I/O path — GPGX's io_ctrl.c port handlers,
// gamepad.c wayplay_*, teamplayer.c — not a peek at the page's variables.
//
// Every pass of its main loop (it never waits for V-blank, so a frame boundary
// — and so every savestate a rollback loads — usually falls in the middle of a
// Team Player handshake or a 4-Way Play select):
//   EA 4-WAY PLAY: for n = 0..3, port B data <- n<<4 (TL/TR select, UP/DOWN
//     low = latch), then port A read with TH=1 and TH=0 (3-button protocol).
//   SEGA TEAM PLAYER on port A: TH=1 TR=1 (counter 0), then 15 writes toggling
//     TH low / TR, one read per write — the handshake (counters 1-7: start,
//     ack, the four pad-type nibbles) and the data nibbles (counter 8+2k =
//     pad k's RLDU, 9+2k = its SACB, active low).
// At reset it latches port B's TH high with UP/DOWN low and reads port A once:
// 0x7C there is the 4-Way Play's presence answer (gamepad.c wayplay_1_read).
// The header's I/O field says "J4" (3-button pad + Team Player), which is what
// genesis.html's per-game rule reads to plug in a Team Player.
//
// WORK RAM MAP (68000 $FF0000 + offset; NOTE: GPGX keeps work RAM in 16-bit
// words in host order, so the byte at offset o is at retro RAM index o ^ 1):
//   $00-$07  4-Way Play pads 0..3: (TH=1 byte ?1CBRLDU, TH=0 byte ?0SA00DU)
//   $10-$17  running sums of $00-$07's two halves (mod 256)
//   $20      the reset-time 4-Way Play presence read (0x7C = present)
//   $30-$33  main-loop pass counter
//   $40-$4E  Team Player reads at counters 1..15 (low nibble)
//   $60-$6E  running sums of $40-$4E (mod 256)
//
// USAGE  import { buildGenesisMultitapRom, WRAM, ramByte } from './genesis_multitap_rom.mjs'
export const WRAM = { wayplay: 0x00, wpSums: 0x10, wpDetect: 0x20, passes: 0x30, tp: 0x40, tpSums: 0x60 };
// The byte the 68000 sees at $FF0000+o, out of retro_get_memory_data(SYSTEM_RAM).
export const ramByte = (heap, ptr, o) => heap[ptr + (o ^ 1)];

export function buildGenesisMultitapRom() {
  const ROM = new Uint8Array(0x20000);
  const w16 = (o, v) => { ROM[o] = (v >> 8) & 0xff; ROM[o + 1] = v & 0xff; };
  const w32 = (o, v) => { w16(o, (v >>> 16) & 0xffff); w16(o + 2, v & 0xffff); };
  const str = (o, s, n) => { for (let i = 0; i < n; i++) ROM[o + i] = i < s.length ? s.charCodeAt(i) : 0x20; };
  const ENTRY = 0x200, RTE_AT = 0x3f0;
  // vectors: SSP, PC, then every exception to an RTE
  w32(0, 0x00fffe00); w32(4, ENTRY);
  for (let v = 2; v < 64; v++) w32(v * 4, RTE_AT);
  w16(RTE_AT, 0x4e73);                                   // rte
  // header
  str(0x100, 'SEGA MEGA DRIVE ', 16);
  str(0x110, '(C)BMTL 2026.OCT', 16);
  str(0x120, 'BEMENTAL MULTITAP TEST', 48);
  str(0x150, 'BEMENTAL MULTITAP TEST', 48);
  str(0x180, 'GM 00000000-00', 14);
  str(0x190, 'J4', 16);                                  // 3-button pad + Team Player
  w32(0x1a0, 0); w32(0x1a4, ROM.length - 1);
  w32(0x1a8, 0x00ff0000); w32(0x1ac, 0x00ffffff);
  str(0x1b0, '', 12);
  str(0x1c8, '', 40);
  str(0x1f0, 'JUE', 16);
  // ── code ──
  const c = []; const W = (...ws) => { for (const x of ws) c.push(x & 0xffff); };
  const here = () => ENTRY + c.length * 2;
  const L = (a) => [(a >>> 16) & 0xffff, a & 0xffff];
  W(0x46fc, 0x2700);                                     // move.w #$2700,sr
  W(0x1039, ...L(0xa10001));                             // move.b $A10001,d0
  W(0x0200, 0x000f);                                     // andi.b #$0F,d0
  const beqAt = here(); W(0x6700, 0);                    // beq.w notmss
  W(0x23fc, 0x5345, 0x4741, ...L(0xa14000));             // move.l #'SEGA',$A14000
  const notmss = here(); c[(beqAt - ENTRY) / 2 + 1] = (notmss - (beqAt + 2)) & 0xffff;
  W(0x41f9, ...L(0xff0000));                             // lea $FF0000,a0
  W(0x703f);                                             // moveq #63,d0
  const clr = here(); W(0x4298);                         // clr.l (a0)+
  { const at = here(); W(0x51c8, (clr - (at + 2)) & 0xffff); }   // dbra d0,clr
  W(0x41f9, ...L(0xff0000));                             // lea $FF0000,a0
  W(0x13fc, 0x0060, ...L(0xa10009));                     // port A ctrl: TH, TR out
  W(0x13fc, 0x007f, ...L(0xa1000b));                     // port B ctrl: all out
  W(0x13fc, 0x0040, ...L(0xa10005));                     // port B: TH high, UP/DOWN low (latch)
  W(0x4e71, 0x4e71);
  W(0x1179, ...L(0xa10003), 0x0020);                     // move.b $A10003,$20(a0)
  // ── main loop ──
  const loop = here();
  W(0x7200);                                             // moveq #0,d1
  const wp = here();
  W(0x1001);                                             // move.b d1,d0
  W(0xe908);                                             // lsl.b #4,d0
  W(0x13c0, ...L(0xa10005));                             // move.b d0,$A10005  (select pad n)
  W(0x13fc, 0x0040, ...L(0xa10003));                     // TH=1
  W(0x4e71, 0x4e71);
  W(0x1439, ...L(0xa10003));                             // move.b $A10003,d2
  W(0x13fc, 0x0000, ...L(0xa10003));                     // TH=0
  W(0x4e71, 0x4e71);
  W(0x1639, ...L(0xa10003));                             // move.b $A10003,d3
  W(0x3801);                                             // move.w d1,d4
  W(0xd844);                                             // add.w d4,d4
  W(0x1182, 0x4000);                                     // move.b d2,0(a0,d4.w)
  W(0x1183, 0x4001);                                     // move.b d3,1(a0,d4.w)
  W(0xd530, 0x1010);                                     // add.b d2,$10(a0,d1.w)
  W(0xd730, 0x1014);                                     // add.b d3,$14(a0,d1.w)
  W(0x5201);                                             // addq.b #1,d1
  W(0x0c01, 0x0004);                                     // cmpi.b #4,d1
  { const at = here(); const d = wp - (at + 2); if (d < -128) throw new Error('bne.s range'); W(0x6600 | (d & 0xff)); }
  // Team Player, port A
  W(0x13fc, 0x0060, ...L(0xa10003));                     // TH=1 TR=1 -> counter 0
  W(0x4e71);
  W(0x7200);                                             // moveq #0,d1
  W(0x7a20);                                             // moveq #$20,d5  (TH=0 TR=1)
  const tp = here();
  W(0x13c5, ...L(0xa10003));                             // move.b d5,$A10003 -> counter++
  W(0x4e71, 0x4e71);
  W(0x1439, ...L(0xa10003));                             // move.b $A10003,d2
  W(0x0202, 0x000f);                                     // andi.b #$0F,d2
  W(0x1182, 0x1040);                                     // move.b d2,$40(a0,d1.w)
  W(0xd530, 0x1060);                                     // add.b d2,$60(a0,d1.w)
  W(0x0a05, 0x0020);                                     // eori.b #$20,d5  (toggle TR)
  W(0x5201);                                             // addq.b #1,d1
  W(0x0c01, 0x000f);                                     // cmpi.b #15,d1
  { const at = here(); const d = tp - (at + 2); if (d < -128) throw new Error('bne.s range'); W(0x6600 | (d & 0xff)); }
  W(0x13fc, 0x0060, ...L(0xa10003));                     // TH high again
  W(0x52a8, 0x0030);                                     // addq.l #1,$30(a0)
  { const at = here(); W(0x6000, (loop - (at + 2)) & 0xffff); }  // bra.w loop
  if (here() >= RTE_AT) throw new Error('code overruns the RTE');
  c.forEach((x, i) => w16(ENTRY + i * 2, x));
  // checksum (words 0x200..end), as the header expects
  let sum = 0; for (let o = 0x200; o < ROM.length; o += 2) sum = (sum + ((ROM[o] << 8) | ROM[o + 1])) & 0xffff;
  w16(0x18e, sum);
  return ROM;
}
