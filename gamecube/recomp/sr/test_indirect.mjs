// test_indirect.mjs — MECHANISM test for sr_indirect() (blrl / bctr / bctrl dispatch).
//
//   SR_OUT=/tmp/sr_ind node gamecube/recomp/sr/test_indirect.mjs <sab_main.dol>
//
// Build first:
//   SR_OUT=/tmp/sr_ind SR_EXTRA_ARGS="--indirect --boundaries outer+calls" \
//     bash gamecube/recomp/sr/build_slice.sh <main.dol> 0x8012af58 0x800ede34
//
// WHAT THIS IS AND IS NOT.  This asserts that the indirect-dispatch PLUMBING behaves:
// that a resolvable target actually reaches the callee's body, that an unresolvable one
// FAULTS with the right code instead of falling through, and that the caller's LR
// round-trip survives the call.  It is NOT an oracle test — nothing here is compared
// against hardware.  Semantic correctness of an indirect branch needs a captured
// fixture whose trace really takes one (gamecube/recomp/sr/fixture_nonleaf.py).
//
// The subject is SAB's Metrowerks function-pointer thunk at 0x8012af58:
//   mflr r0; stw r0,4(r1); stwu r1,-8(r1); lwz r12,-28752(r13); mtlr r12; blrl;
//   lwz r0,12(r1); addi r1,r1,8; mtlr r0; blr
// The callee address is READ FROM GUEST MEMORY at r13-28752, so the test can aim the
// indirect branch anywhere simply by writing that slot.
import fs from 'node:fs';
import path from 'node:path';

const SLICE = process.env.SR_OUT || '/tmp/sr_ind';
const O_GPR = 0, O_PS0 = 128, O_PS1 = 384, O_CR = 640, O_XER = 644, O_LR = 648,
      O_CTR = 652, O_FPSCR = 656, O_GQR = 660, O_PC = 692, SZ = 696;

const THUNK = 0x8012af58 >>> 0;      // the blrl thunk
const TARGET = 0x800ede34 >>> 0;     // PSVECCrossProduct — a pure leaf, 3 args
const SLOT_DISP = -28752;            // lwz r12, SLOT_DISP(r13)
const A_R13 = 0x81700000 >>> 0;      // wherever we like; we own this memory
const A_STK = 0x81760000 >>> 0;
const A_IN1 = 0x81710000 >>> 0, A_IN2 = 0x81710100 >>> 0, A_OUT = 0x81710200 >>> 0;
const LR_SENTINEL = 0x81780000 >>> 0;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: got ${got}, want ${want}`);
  ok ? pass++ : fail++;
};

const main = async () => {
  const dolPath = process.argv[2];
  if (!dolPath) throw new Error('usage: test_indirect.mjs <sab_main.dol>');
  const factory = (await import(path.resolve(SLICE, 'sr_slice.js'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  if (M._sr_state_size() !== SZ) throw new Error(`GekkoState ${M._sr_state_size()} != ${SZ}`);
  const ram = M._sr_ram(), st = M._sr_state();
  const phys = (a) => (a & 0x03ffffff) >>> 0;
  const H = () => M.HEAPU8;
  const DV = () => new DataView(M.HEAPU8.buffer);

  // stage the DOL so any incidental read hits real bytes
  const b = fs.readFileSync(dolPath);
  const rd = (o) => b.readUInt32BE(o);
  for (let i = 0; i < 7; i++) {
    const off = rd(0x00 + i * 4), ad = rd(0x48 + i * 4), sz = rd(0x90 + i * 4);
    if (sz) H().set(b.subarray(off, off + sz), ram + phys(ad));
  }
  for (let i = 0; i < 11; i++) {
    const off = rd(0x1c + i * 4), ad = rd(0x64 + i * 4), sz = rd(0xac + i * 4);
    if (sz) H().set(b.subarray(off, off + sz), ram + phys(ad));
  }

  const setup = (slotValue) => {
    const dv = DV();
    H().fill(0, st, st + SZ);
    dv.setUint32(st + O_GPR + 1 * 4, A_STK, true);          // r1 = stack
    dv.setUint32(st + O_GPR + 13 * 4, A_R13, true);         // r13 = small-data base
    dv.setUint32(st + O_GPR + 3 * 4, A_IN1, true);
    dv.setUint32(st + O_GPR + 4 * 4, A_IN2, true);
    dv.setUint32(st + O_GPR + 5 * 4, A_OUT, true);
    dv.setUint32(st + O_LR, LR_SENTINEL, true);
    dv.setUint32(st + O_PC, THUNK, true);
    // the function pointer the thunk loads, big-endian in guest memory
    dv.setUint32(ram + phys(A_R13 + SLOT_DISP), 0, false);
    new DataView(M.HEAPU8.buffer).setUint32(ram + phys(A_R13 + SLOT_DISP), slotValue >>> 0, false);
    // two distinguishable input vectors, and a poisoned output
    for (let i = 0; i < 3; i++) {
      DV().setFloat32(ram + phys(A_IN1) + i * 4, [1, 0, 0][i], false);
      DV().setFloat32(ram + phys(A_IN2) + i * 4, [0, 1, 0][i], false);
    }
    H().fill(0xcc, ram + phys(A_OUT), ram + phys(A_OUT) + 12);
  };

  console.log(`slice: ${path.resolve(SLICE, 'sr_slice.wasm')}`);
  console.log(`thunk 0x${THUNK.toString(16)} -> indirect target from [r13${SLOT_DISP}]\n`);

  // --- 1. a RESOLVABLE indirect target reaches the callee ---------------------
  setup(TARGET);
  const f1 = M._sr_call(THUNK) >>> 0;
  check('resolvable target: no fault', f1, 0);
  // PSVECCrossProduct((1,0,0),(0,1,0)) = (0,0,1): the callee really ran
  const out = [0, 1, 2].map((i) => DV().getFloat32(ram + phys(A_OUT) + i * 4, false));
  check('callee executed (cross product x)', out[0], 0);
  check('callee executed (cross product y)', out[1], 0);
  check('callee executed (cross product z)', out[2], 1);
  check('caller LR restored across the call', DV().getUint32(st + O_LR, true) >>> 0,
        LR_SENTINEL);

  // --- 2. an UNRESOLVABLE target FAULTS, and with the indirect prefix ---------
  const BOGUS = 0x80000004 >>> 0;   // in MEM1, word-aligned, not a function start
  setup(BOGUS);
  const f2 = M._sr_call(THUNK) >>> 0;
  check('unresolvable target: faults with 0xE1 prefix', f2 >>> 24, 0xE1);
  check('fault carries the offending address', f2 & 0x00ffffff, BOGUS & 0x00ffffff);

  // --- 3. the fault prefix is DISTINCT from sr_extern's -----------------------
  check('indirect fault prefix != sr_extern prefix (0xE0)', (f2 >>> 24) !== 0xE0, true);

  // --- 4. a target that is a start but NOT in this build still faults ---------
  //     (sr_dispatch has no case for it -> must not silently do nothing)
  const NOT_EMITTED = 0x800ed368 >>> 0;   // PSMTXConcat, deliberately not linked here
  setup(NOT_EMITTED);
  const f3 = M._sr_call(THUNK) >>> 0;
  check('start outside the emitted set faults', f3 >>> 24, 0xE1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};
main();
