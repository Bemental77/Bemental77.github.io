// verify_xform.mjs — diff the statically recompiled indexed-with-update load/stores
// against golden vectors captured from native Dolphin's REFERENCE INTERPRETER.
//
//   SR_OUT=/tmp/sr_xform node gamecube/recomp/sr/verify_xform.mjs <goldens.json>
//
// Build first:
//   python3 gamecube/recomp/sr/xform_vectors.py --emit-c /tmp/xform_gen.c \
//           --goldens <goldens.json>
//   SR_OUT=/tmp/sr_xform SR_GEN=/tmp/xform_gen.c \
//     bash gamecube/recomp/sr/build_slice.sh <main.dol> 0x0
//
// Pass criterion per vector, all of it, no averaging:
//   * rA (the UPDATED BASE) bit-identical      <- the whole point of the update forms
//   * rD bit-identical                          (loads)
//   * frD bit-identical as RAW 64-BIT BITS      (FP loads; never compared as doubles)
//   * the 32-byte memory window around the effective address bit-identical (stores)
//
// The update forms are exactly where a sign error hides: an unsigned rB would load the
// right value and write back the wrong base, so a test that only checked the loaded
// value would pass. Half the vectors use a negative index for that reason.
import fs from 'node:fs';
import path from 'node:path';

const SLICE = process.env.SR_OUT || '/tmp/sr_xform';
const O_GPR = 0, O_PS0 = 128, O_PS1 = 384, O_CR = 640, O_XER = 644, O_LR = 648,
      O_CTR = 652, O_FPSCR = 656, O_GQR = 660, O_PC = 692, SZ = 696;
const RA = 3, RB = 5, RD = 4;

const main = async () => {
  const goldPath = process.argv[2] || '/tmp/xform_goldens.json';
  const j = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  const factory = (await import(path.resolve(SLICE, 'sr_slice.js'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  if (M._sr_state_size() !== SZ) throw new Error(`GekkoState ${M._sr_state_size()} != ${SZ}`);
  const ram = M._sr_ram(), st = M._sr_state();
  const phys = (a) => (a >>> 0) & 0x03ffffff;
  const DATA = j.data >>> 0, SCRATCH = j.scratch >>> 0;

  console.log(`slice  : ${path.resolve(SLICE, 'sr_slice.wasm')}`);
  console.log(`oracle : ${j.oracle}`);
  console.log(`vectors: ${j.vectors.length}\n`);

  let pass = 0, fail = 0;
  const byForm = new Map();
  for (let i = 0; i < j.vectors.length; i++) {
    const v = j.vectors[i];
    const entry = (SCRATCH + i * 8) >>> 0;
    const H = M.HEAPU8, dv = new DataView(H.buffer);

    H.fill(0xa5, ram + phys(DATA), ram + phys(DATA) + 0x2000);
    const ea = ((v.r3 >>> 0) + (v.r5 >>> 0)) >>> 0;
    const payload = Buffer.from(v.data, 'hex');
    H.set(payload, ram + phys(ea));

    H.fill(0, st, st + SZ);
    dv.setUint32(st + O_GPR + RA * 4, v.r3 >>> 0, true);
    dv.setUint32(st + O_GPR + RB * 4, v.r5 >>> 0, true);
    if (v.kind === 'st')
      dv.setUint32(st + O_GPR + RD * 4, payload.readUInt32BE(0) >>> 0, true);
    // 64-bit values arrive as HEX STRINGS: a JSON number cannot hold
    // 0x7FEFFFFFFFFFFFFF and JSON.parse silently rewrites it as +Inf.
    if (v.kind === 'fst') dv.setBigUint64(st + O_PS0 + RD * 8, BigInt('0x' + v.fpr), true);
    dv.setUint32(st + O_PC, entry, true);

    const fault = M._sr_call(entry) >>> 0;
    const dv2 = new DataView(M.HEAPU8.buffer);
    const gotR3 = dv2.getUint32(st + O_GPR + RA * 4, true) >>> 0;
    const gotR4 = dv2.getUint32(st + O_GPR + RD * 4, true) >>> 0;
    const gotF4 = dv2.getBigUint64(st + O_PS0 + RD * 8, true);
    const lo = phys(v.mem_lo >>> 0);
    const gotMem = Buffer.from(M.HEAPU8.subarray(ram + lo, ram + lo + 32)).toString('hex');

    const diffs = [];
    if (fault !== 0) diffs.push(`fault ${fault.toString(16)}`);
    if (gotR3 !== (v.out_r3 >>> 0))
      diffs.push(`rA(updated base) want ${(v.out_r3 >>> 0).toString(16)} got ${gotR3.toString(16)}`);
    if (v.kind === 'ld' && gotR4 !== (v.out_r4 >>> 0))
      diffs.push(`rD want ${(v.out_r4 >>> 0).toString(16)} got ${gotR4.toString(16)}`);
    if (v.kind === 'fld' && gotF4 !== BigInt('0x' + v.out_f4))
      diffs.push(`frD want ${v.out_f4} got ${gotF4.toString(16).padStart(16, '0')}`);
    if ((v.kind === 'st' || v.kind === 'fst') && gotMem !== v.out_mem)
      diffs.push(`mem@${(v.mem_lo >>> 0).toString(16)}\n      want ${v.out_mem}\n      got  ${gotMem}`);

    const rec = byForm.get(v.mnemonic) || { pass: 0, fail: 0 };
    if (diffs.length) {
      fail++; rec.fail++;
      console.log(`FAIL  ${v.name.padEnd(12)} ${diffs.join('\n      ')}`);
    } else { pass++; rec.pass++; }
    byForm.set(v.mnemonic, rec);
  }

  console.log('\nper form:');
  for (const [m, r] of byForm)
    console.log(`  ${m.padEnd(8)} ${String(r.pass).padStart(3)} bit-exact / ${r.fail} mismatched`);
  console.log(`\nRESULT : ${pass} bit-exact / ${fail} mismatched  of ${pass + fail}`);
  process.exit(fail ? 1 : 0);
};
main();
