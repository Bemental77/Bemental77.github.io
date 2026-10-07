// ps1_multitap_disc.mjs — a PS1 DISC, written here, whose program READS FOUR
// PADS THROUGH A MULTITAP the way a multitap game does, and leaves what it read
// in main RAM. No shipped disc (ps1.html ROMS[]: Monster Rancher 2, Metal Gear
// Solid, Harry Potter, Legend of Dragoon) uses a multitap, so the 3- and
// 4-player tests drive this instead. It is GUEST CODE on the real bus path —
// the BIOS boots it from SYSTEM.CNF, and it drives the SIO registers
// (JOY_DATA/STAT/MODE/CTRL/BAUD at 0x1F801040..4E) and polls I_STAT bit 7 for
// each ACK, exactly as a game's pad driver does — not a peek at page variables.
//
// A real multitap title to verify with later: Crash Team Racing (SCUS-94426,
// 4 players through a multitap in port 1); also Crash Bash, Micro Machines V3,
// Bomberman World.
//
// WHAT THE PROGRAM DOES — continuously, NOT synchronised to V-blank, so frame
// boundaries fall in the middle of transfers and the multitap's protocol state
// is live whenever a savestate is taken:
//   T0 port 1: 01 42 00 + 32 bytes (4 blocks of 42 00 00 00 00 00 00 00)
//      = a FULL "all four" read when the previous transfer's TAP byte was 1
//        (answer 80 5A + four 8-byte slot blocks), else slot A passed through.
//   T1..T4 port 1: 0n 42 TAP 00 00 for n = 1..4 = slots A..D one at a time
//      (TAP = 0, except T4 sends TAP = 1, which makes the NEXT T0 a full read).
//   T5 port 2: 01 42 00 00 00 (with a multitap in port 1, port 2 is empty).
// Each byte waits for RX ready, reads the reply, waits for the ACK (I_STAT bit
// 7) with a timeout; no ACK ends the transfer (as on hardware). Every reply
// byte and ACK is folded into a running checksum, so the state depends on the
// whole history of every pad.
//
// MAIN RAM MAP (guest 0x800F0000 = psxM + 0xF0000), RAM below:
//   +0x00 u32 loop count     +0x04 u32 checksum    +0x08 u32 V-blanks seen
//   +0x0C 'MTAP' (program alive)
//   +0x10 + 0x28*t  record of transfer t (0..5): [0] bytes exchanged,
//                   [1 + i] reply to byte i
//   +0x100 u16 x4  slot A..D buttons from the last FULL read (KeyStatus, active-low)
//   +0x108 u8      reply to T0's command byte (0x80 = it was a full read)
//   +0x110 u16 x4  slot A..D buttons read one at a time (0xEEEE: no complete reply)
//   +0x118 u16     port 2 pad buttons (0xEEEE: none)
//   +0x120 u8 x4   slot A..D ID byte in the last full read (0x41 pad, 0xFF empty)
//   +0x124 u8 x4   slot A..D ID byte read one at a time (0xEE: nothing answered)
//   +0x128 u8      port 2 ID byte
//
// USAGE  import { buildMultitapDisc, RAM } from './ps1_multitap_disc.mjs'
//        node tools/ps1_multitap_disc.mjs OUT.bin   (writes the raw 2352-byte-sector image)
export const RAM = {
  base: 0xF0000, loops: 0x00, sum: 0x04, vblanks: 0x08, magic: 0x0C, rec: 0x10, recSize: 0x28,
  fullBtn: 0x100, fullHdr: 0x108, passBtn: 0x110, port2Btn: 0x118, fullId: 0x120, passId: 0x124, port2Id: 0x128,
};
export const MAGIC = 0x5041544D;   // 'MTAP'

const R = { zero: 0, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, a3: 7, t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14, t7: 15,
            s0: 16, s1: 17, s2: 18, s3: 19, t8: 24, t9: 25, ra: 31 };

class Asm {
  constructor(base) { this.base = base; this.w = []; this.labels = {}; this.fix = []; }
  here() { return this.base + this.w.length * 4; }
  label(n) { if (n in this.labels) throw new Error('dup label ' + n); this.labels[n] = this.here(); }
  emit(x) { this.w.push(x >>> 0); }
  I(op, rs, rt, imm) { this.emit((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)); }
  Rt(rs, rt, rd, sa, fn) { this.emit((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn); }
  nop() { this.emit(0); }
  lui(rt, v) { this.I(0x0f, 0, rt, v); }
  ori(rt, rs, v) { this.I(0x0d, rs, rt, v); }
  andi(rt, rs, v) { this.I(0x0c, rs, rt, v); }
  addiu(rt, rs, v) { this.I(0x09, rs, rt, v); }
  sltiu(rt, rs, v) { this.I(0x0b, rs, rt, v); }
  li(rt, v) {
    v |= 0;
    if (v >= -32768 && v < 32768) this.addiu(rt, R.zero, v);
    else { this.lui(rt, (v >>> 16) & 0xffff); if (v & 0xffff) this.ori(rt, rt, v & 0xffff); }
  }
  // every load is followed by a nop (the R3000 load delay slot)
  lw(rt, off, rs) { this.I(0x23, rs, rt, off); this.nop(); }
  lbu(rt, off, rs) { this.I(0x24, rs, rt, off); this.nop(); }
  lhu(rt, off, rs) { this.I(0x25, rs, rt, off); this.nop(); }
  sw(rt, off, rs) { this.I(0x2b, rs, rt, off); }
  sh(rt, off, rs) { this.I(0x29, rs, rt, off); }
  sb(rt, off, rs) { this.I(0x28, rs, rt, off); }
  addu(rd, rs, rt) { this.Rt(rs, rt, rd, 0, 0x21); }
  or(rd, rs, rt) { this.Rt(rs, rt, rd, 0, 0x25); }
  xor(rd, rs, rt) { this.Rt(rs, rt, rd, 0, 0x26); }
  and(rd, rs, rt) { this.Rt(rs, rt, rd, 0, 0x24); }
  sll(rd, rt, sa) { this.Rt(0, rt, rd, sa, 0x00); }
  // every branch/jump is followed by a nop (the delay slot is never used)
  beq(rs, rt, l) { this.fix.push([this.w.length, l, 'b']); this.I(0x04, rs, rt, 0); this.nop(); }
  bne(rs, rt, l) { this.fix.push([this.w.length, l, 'b']); this.I(0x05, rs, rt, 0); this.nop(); }
  j(l) { this.fix.push([this.w.length, l, 'j']); this.emit(0x02 << 26); this.nop(); }
  jal(l) { this.fix.push([this.w.length, l, 'j']); this.emit(0x03 << 26); this.nop(); }
  jr(rs) { this.Rt(rs, 0, 0, 0, 0x08); this.nop(); }
  mfc0(rt, rd) { this.emit((0x10 << 26) | (0 << 21) | (rt << 16) | (rd << 11)); this.nop(); }
  mtc0(rt, rd) { this.emit((0x10 << 26) | (4 << 21) | (rt << 16) | (rd << 11)); this.nop(); }
  resolve() {
    for (const [i, l, k] of this.fix) {
      const t = this.labels[l]; if (t === undefined) throw new Error('no label ' + l);
      if (k === 'b') { const off = (t - (this.base + i * 4 + 4)) >> 2; if (off < -32768 || off > 32767) throw new Error('branch range'); this.w[i] = (this.w[i] & 0xffff0000 | (off & 0xffff)) >>> 0; }
      else this.w[i] = (this.w[i] | ((t >>> 2) & 0x3ffffff)) >>> 0;
    }
    return this.w;
  }
}

const TEXT = 0x80010000, DATA = 0x80018000, RES = 0x800F0000;

function buildProgram() {
  const a = new Asm(TEXT);
  const send = [];   // [address, bytes]
  const T_FULL = [0x01, 0x42, 0x00]; for (let i = 0; i < 4; i++) T_FULL.push(0x42, 0, 0, 0, 0, 0, 0, 0);
  const txns = [{ ctrl: 0x1003, bytes: T_FULL }];
  for (let n = 1; n <= 4; n++) txns.push({ ctrl: 0x1003, bytes: [n, 0x42, n === 4 ? 1 : 0, 0, 0] });
  txns.push({ ctrl: 0x3003, bytes: [0x01, 0x42, 0x00, 0x00, 0x00] });
  let dp = DATA;
  for (const t of txns) { t.addr = dp; send.push([dp, t.bytes]); dp += (t.bytes.length + 3) & ~3; }

  // ── start ──
  a.mfc0(R.t0, 12); a.li(R.t1, -2); a.and(R.t0, R.t0, R.t1); a.mtc0(R.t0, 12); a.nop();   // SR.IEc = 0: no interrupts taken
  a.lui(R.s0, 0x1f80);
  a.li(R.t0, 0x81); a.sw(R.t0, 0x1074, R.s0);              // I_MASK = vblank | SIO (polled, never taken)
  a.li(R.t0, 0x0d); a.sh(R.t0, 0x1048, R.s0);              // JOY_MODE: 8 bits, x1
  a.li(R.t0, 0x88); a.sh(R.t0, 0x104e, R.s0);              // JOY_BAUD
  a.li(R.t0, 0x40); a.sh(R.t0, 0x104a, R.s0);              // JOY_CTRL: reset
  a.sh(R.zero, 0x104a, R.s0);
  a.lui(R.s1, RES >>> 16);
  a.li(R.t0, 0); a.label('clr'); a.addu(R.t1, R.s1, R.t0); a.sw(R.zero, 0, R.t1); a.addiu(R.t0, R.t0, 4); a.li(R.t2, 0x200); a.bne(R.t0, R.t2, 'clr');
  a.li(R.t0, MAGIC); a.sw(R.t0, RAM.magic, R.s1);
  a.li(R.s3, 0x811c9dc5 | 0);
  // ── the loop ──
  a.label('loop');
  a.lw(R.t0, 0x1070, R.s0); a.andi(R.t0, R.t0, 1); a.beq(R.t0, R.zero, 'novb');
  a.li(R.t1, -2); a.sw(R.t1, 0x1070, R.s0); a.lw(R.t2, RAM.vblanks, R.s1); a.addiu(R.t2, R.t2, 1); a.sw(R.t2, RAM.vblanks, R.s1);
  a.label('novb');
  txns.forEach((t, k) => {
    a.li(R.a1, t.ctrl); a.li(R.a2, t.addr | 0); a.li(R.a3, t.bytes.length); a.addiu(R.s2, R.s1, RAM.rec + RAM.recSize * k);
    a.jal('txn');
    const rec = RAM.rec + RAM.recSize * k;
    if (k === 0) {
      a.lbu(R.t0, rec + 2, R.s1); a.sb(R.t0, RAM.fullHdr, R.s1);
      a.li(R.t1, 0x80); a.bne(R.t0, R.t1, 'nofull');
      for (let i = 0; i < 4; i++) {
        const b = rec + 1 + 3 + 8 * i;
        a.lbu(R.t2, b + 2, R.s1); a.lbu(R.t3, b + 3, R.s1); a.sll(R.t3, R.t3, 8); a.or(R.t2, R.t2, R.t3); a.sh(R.t2, RAM.fullBtn + 2 * i, R.s1);
        a.lbu(R.t2, b, R.s1); a.sb(R.t2, RAM.fullId + i, R.s1);
      }
      a.label('nofull');
    } else {
      const btn = k <= 4 ? RAM.passBtn + 2 * (k - 1) : RAM.port2Btn, id = k <= 4 ? RAM.passId + (k - 1) : RAM.port2Id;
      a.lbu(R.t0, rec, R.s1);
      a.li(R.t2, 0xee); a.sltiu(R.t1, R.t0, 2); a.bne(R.t1, R.zero, 'noid' + k); a.lbu(R.t2, rec + 2, R.s1); a.label('noid' + k); a.sb(R.t2, id, R.s1);
      a.li(R.t2, 0xeeee); a.sltiu(R.t1, R.t0, 5); a.bne(R.t1, R.zero, 'nobtn' + k);
      a.lbu(R.t2, rec + 4, R.s1); a.lbu(R.t3, rec + 5, R.s1); a.sll(R.t3, R.t3, 8); a.or(R.t2, R.t2, R.t3);
      a.label('nobtn' + k); a.sh(R.t2, btn, R.s1);
    }
  });
  a.lw(R.t0, RAM.loops, R.s1); a.addiu(R.t0, R.t0, 1); a.sw(R.t0, RAM.loops, R.s1);
  a.sw(R.s3, RAM.sum, R.s1);
  a.j('loop');

  // ── txn: a1 = JOY_CTRL (port + DTR), a2 = bytes, a3 = count, s2 = record ──
  a.label('txn');
  a.addu(R.t9, R.ra, R.zero);
  a.sh(R.a1, 0x104a, R.s0);
  a.li(R.t4, 0);
  a.label('tl');
  a.addu(R.t5, R.a2, R.t4); a.lbu(R.a0, 0, R.t5);
  a.jal('xfer');
  a.addu(R.t6, R.s2, R.t4); a.sb(R.v0, 1, R.t6);
  a.sll(R.t7, R.s3, 5); a.addu(R.s3, R.s3, R.t7); a.xor(R.s3, R.s3, R.v0);   // sum = sum*33 ^ reply
  a.sll(R.t7, R.v1, 8); a.xor(R.s3, R.s3, R.t7);                              //       ^ ack<<8
  a.addiu(R.t4, R.t4, 1);
  a.beq(R.v1, R.zero, 'tdone');
  a.bne(R.t4, R.a3, 'tl');
  a.label('tdone');
  a.sb(R.t4, 0, R.s2);
  a.sh(R.zero, 0x104a, R.s0);                                                 // DTR off: the transfer ends
  a.jr(R.t9);

  // ── xfer: a0 -> v0 reply, v1 = ACKed ──
  a.label('xfer');
  a.sb(R.a0, 0x1040, R.s0);
  a.li(R.t1, 100);
  a.label('xr'); a.lhu(R.t2, 0x1044, R.s0); a.andi(R.t2, R.t2, 2); a.bne(R.t2, R.zero, 'xro'); a.addiu(R.t1, R.t1, -1); a.bne(R.t1, R.zero, 'xr');
  a.label('xro');
  a.lbu(R.v0, 0x1040, R.s0);
  a.li(R.t1, 3000);
  a.label('xa'); a.lw(R.t2, 0x1070, R.s0); a.andi(R.t2, R.t2, 0x80); a.bne(R.t2, R.zero, 'xao'); a.addiu(R.t1, R.t1, -1); a.bne(R.t1, R.zero, 'xa');
  a.li(R.v1, 0); a.jr(R.ra);
  a.label('xao');
  a.li(R.t2, -129); a.sw(R.t2, 0x1070, R.s0);                                 // I_STAT: acknowledge bit 7
  a.lhu(R.t3, 0x104a, R.s0); a.ori(R.t3, R.t3, 0x10); a.sh(R.t3, 0x104a, R.s0);  // JOY_CTRL: acknowledge
  a.li(R.v1, 1); a.jr(R.ra);

  const code = a.resolve();
  if (TEXT + code.length * 4 > DATA) throw new Error('code overlaps data');
  const size = 0x9000;   // TEXT .. DATA + 4 KB, a whole number of 2 KB sectors
  const img = new Uint8Array(size);
  const dv = new DataView(img.buffer);
  code.forEach((w, i) => dv.setUint32(i * 4, w, true));
  for (const [addr, bytes] of send) img.set(bytes, addr - TEXT);
  return img;
}

function psxExe(text) {
  const h = new Uint8Array(2048), dv = new DataView(h.buffer);
  h.set(Buffer.from('PS-X EXE', 'latin1'), 0);
  dv.setUint32(0x10, TEXT, true);         // pc0
  dv.setUint32(0x14, 0, true);            // gp0
  dv.setUint32(0x18, TEXT, true);         // t_addr
  dv.setUint32(0x1c, text.length, true);  // t_size
  dv.setUint32(0x30, 0x801fff00, true);   // s_addr
  h.set(Buffer.from('Sony Computer Entertainment Inc. for North America area', 'latin1'), 0x4c);
  const out = new Uint8Array(2048 + text.length); out.set(h, 0); out.set(text, 2048);
  return out;
}

// ── a raw MODE2/2352 image with a minimal ISO9660 file system ───────────────
function bcd(n) { return ((n / 10) | 0) * 16 + (n % 10); }
function both32(dv, off, v) { dv.setUint32(off, v, true); dv.setUint32(off + 4, v, false); }
function both16(dv, off, v) { dv.setUint16(off, v, true); dv.setUint16(off + 2, v, false); }
function dirRecord(name, lba, size, isDir) {
  const id = typeof name === 'number' ? Uint8Array.of(name) : Buffer.from(name, 'latin1');
  const len = 33 + id.length + ((33 + id.length) & 1);
  const r = new Uint8Array(len), dv = new DataView(r.buffer);
  r[0] = len; both32(dv, 2, lba); both32(dv, 10, size);
  r.set([126, 1, 1, 0, 0, 0, 0], 18);            // 2026-01-01 00:00:00
  r[25] = isDir ? 2 : 0; both16(dv, 28, 1); r[32] = id.length; r.set(id, 33);
  return r;
}

export function buildMultitapDisc() {
  const exe = psxExe(buildProgram());
  const cnf = Buffer.from('BOOT = cdrom:\\PSX.EXE;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n', 'latin1');
  const L_PATH = 18, M_PATH = 19, ROOT = 20, CNF = 21, EXE = 22;
  const exeSectors = Math.ceil(exe.length / 2048), total = EXE + exeSectors + 16;
  const user = Array.from({ length: total }, () => new Uint8Array(2048));
  // primary volume descriptor
  { const p = user[16], dv = new DataView(p.buffer);
    p[0] = 1; p.set(Buffer.from('CD001'), 1); p[6] = 1;
    p.set(Buffer.from('PLAYSTATION'.padEnd(32), 'latin1'), 8);
    p.set(Buffer.from('BEMENTAL_MULTITAP'.padEnd(32), 'latin1'), 40);
    both32(dv, 80, total); both16(dv, 120, 1); both16(dv, 124, 1); both16(dv, 128, 2048);
    both32(dv, 132, 10); dv.setUint32(140, L_PATH, true); dv.setUint32(148, M_PATH, false);
    p.set(dirRecord(0, ROOT, 2048, true), 156); p[881] = 1; }
  { const t = user[17]; t[0] = 255; t.set(Buffer.from('CD001'), 1); t[6] = 1; }
  for (const [s, le] of [[L_PATH, true], [M_PATH, false]]) {
    const p = user[s], dv = new DataView(p.buffer); p[0] = 1; dv.setUint32(2, ROOT, le); dv.setUint16(6, 1, le); p[8] = 0;
  }
  { let o = 0; const d = user[ROOT];
    for (const r of [dirRecord(0, ROOT, 2048, true), dirRecord(1, ROOT, 2048, true),
                     dirRecord('PSX.EXE;1', EXE, exe.length, false), dirRecord('SYSTEM.CNF;1', CNF, cnf.length, false)]) { d.set(r, o); o += r.length; } }
  user[CNF].set(cnf);
  for (let i = 0; i < exeSectors; i++) user[EXE + i].set(exe.subarray(i * 2048, (i + 1) * 2048));
  // 2352-byte MODE2 form 1 sectors: sync, BCD MSF header, subheader, 2048 data (EDC/ECC left zero)
  const out = new Uint8Array(total * 2352);
  for (let s = 0; s < total; s++) {
    const o = s * 2352, a = s + 150;
    out[o] = 0; out.fill(0xff, o + 1, o + 11); out[o + 11] = 0;
    out[o + 12] = bcd((a / 4500) | 0); out[o + 13] = bcd(((a / 75) | 0) % 60); out[o + 14] = bcd(a % 75); out[o + 15] = 2;
    const last = (s === CNF) || (s === EXE + exeSectors - 1) || s === 17;
    const sub = [0, 0, last ? 0x89 : 0x08, 0];
    out.set(sub, o + 16); out.set(sub, o + 20);
    out.set(user[s], o + 24);
  }
  return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const fs = await import('node:fs');
  const d = buildMultitapDisc();
  fs.writeFileSync(process.argv[2] || 'multitap.bin', d);
  console.log('wrote ' + d.length + ' bytes (' + d.length / 2352 + ' sectors)');
}
