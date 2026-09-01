// verify_slice.mjs — run the STATICALLY RECOMPILED SAB functions (wasm) against golden
// vectors captured from NATIVE Dolphin's reference interpreter, and diff raw bytes.
//
//   node gamecube/recomp/sr/verify_slice.mjs <sab_main.dol> [goldens.json]
//
// Pass = every output byte identical, plus the r3 return value where the ABI has one.
// Anything else is a translation bug and is printed as a per-word hex diff — never
// averaged, never "close enough".
import fs from 'node:fs';
import path from 'node:path';

const DOL = process.argv[2];
const GOLD = process.argv[3] || '/tmp/sab_leaf_goldens.json';
const SLICE = process.env.SR_OUT || '/tmp/sr_slice';

// Must mirror gamecube/tools/golden_invoke_sab_psmtx.py's staging map exactly.
const A_IN = { 3: 0x81700000, 4: 0x81700100, 6: 0x81700200 };
const A_OUT = { 4: 0x81700300, 5: 0x81700400 };
const A_STK = 0x81760000;

// GekkoState field offsets (C layout; asserted against sr_state_size()).
const O_GPR = 0, O_GQR = 660, SZ = 696;

function loadDolSections(dol) {
  const b = fs.readFileSync(dol);
  const rd = (o) => b.readUInt32BE(o);
  const segs = [];
  for (let i = 0; i < 7; i++) {
    const off = rd(0x00 + i * 4), ad = rd(0x48 + i * 4), sz = rd(0x90 + i * 4);
    if (sz) segs.push({ ad, buf: b.subarray(off, off + sz) });
  }
  for (let i = 0; i < 11; i++) {
    const off = rd(0x1c + i * 4), ad = rd(0x64 + i * 4), sz = rd(0xac + i * 4);
    if (sz) segs.push({ ad, buf: b.subarray(off, off + sz) });
  }
  return segs;
}

const main = async () => {
  const factory = (await import(path.resolve(SLICE, 'sr_slice.js'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  const heap = () => M.HEAPU8;                 // ALLOW_MEMORY_GROWTH detaches old views
  if (M._sr_state_size() !== SZ)
    throw new Error(`GekkoState size ${M._sr_state_size()} != expected ${SZ}`);
  const ram = M._sr_ram(), ramSize = M._sr_ram_size(), st = M._sr_state();
  const phys = (a) => ram + (a & 0x03ffffff);

  // Stage the shipped DOL image: PSMTXConcat loads a constant from 0x803AD5C8 (DATA4),
  // so the translation is only correct against the real shipped data too.
  let staged = 0;
  for (const s of loadDolSections(DOL)) {
    const off = s.ad & 0x03ffffff;
    if (off + s.buf.length > ramSize) continue;
    heap().set(s.buf, ram + off); staged += s.buf.length;
  }

  const g = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
  const per = {}, failures = [];
  let pass = 0, fail = 0;

  for (const r of g.records) {
    const H = heap();
    H.fill(0, st, st + SZ);
    const dv = new DataView(H.buffer);
    dv.setUint32(st + O_GPR + 1 * 4, A_STK, true);
    dv.setUint32(st + O_GQR, 0, true);                 // GQR0 = float, no scale
    for (const [gpr, hex] of r.in) {
      const b = Buffer.from(hex, 'hex');
      H.set(b, phys(A_IN[gpr]));
      dv.setUint32(st + O_GPR + gpr * 4, A_IN[gpr], true);
    }
    const olen = r.dst.length / 2, oaddr = A_OUT[r.out_gpr];
    H.fill(0xcc, phys(oaddr), phys(oaddr) + olen);
    dv.setUint32(st + O_GPR + r.out_gpr * 4, oaddr, true);

    const fault = M._sr_call(parseInt(r.entry, 16));
    const got = Buffer.from(heap().subarray(phys(oaddr), phys(oaddr) + olen));
    const gotR3 = new DataView(heap().buffer).getUint32(st + O_GPR + 3 * 4, true);
    const want = Buffer.from(r.dst, 'hex');
    const okR3 = (r.r3 === null || r.r3 === undefined) || (gotR3 >>> 0) === (r.r3 >>> 0);

    per[r.fn] = per[r.fn] || { pass: 0, fail: 0 };
    if (fault === 0 && got.equals(want) && okR3) { pass++; per[r.fn].pass++; continue; }
    fail++; per[r.fn].fail++;
    if (failures.length < 12)
      failures.push({ fn: r.fn, case: r.case, fault, r3: [r.r3, gotR3 >>> 0],
                      want: want.toString('hex'), got: got.toString('hex'),
                      in: r.in.map(([k, v]) => `r${k}=${v}`) });
  }

  console.log(`slice     : ${SLICE}/sr_slice.wasm`);
  console.log(`oracle    : ${g.oracle}   goldens=${GOLD}`);
  console.log(`seed      : ${g.seed}   in-game passive: ${JSON.stringify(g.passive)}`);
  console.log(`DOL staged: ${staged} bytes into guest RAM`);
  for (const fn of Object.keys(per))
    console.log(`  ${fn.padEnd(20)} ${String(per[fn].pass).padStart(5)} bit-exact / ` +
                `${per[fn].fail} mismatched`);
  console.log(`RESULT    : ${pass} bit-exact / ${fail} mismatched  of ${g.records.length}`);
  for (const f of failures) {
    console.log(`\n  MISMATCH ${f.fn} ${f.case}  fault=0x${(f.fault >>> 0).toString(16)}` +
                (f.r3[0] === null ? '' : `  r3 want=${f.r3[0]} got=${f.r3[1]}`));
    for (const i of f.in) console.log(`    in  ${i}`);
    for (let i = 0; i < f.want.length / 2; i += 4) {
      const w = f.want.slice(i * 2, i * 2 + 8), o = f.got.slice(i * 2, i * 2 + 8);
      console.log(`    +${String(i).padStart(2)}  want ${w}  got ${o}${w === o ? '' : '   <-- differs'}`);
    }
  }
  process.exit(fail ? 1 : 0);
};
main();
