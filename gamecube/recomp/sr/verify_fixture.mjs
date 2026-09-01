// verify_fixture.mjs — replay a NON-LEAF fixture captured from native Dolphin's
// reference interpreter against the statically recompiled wasm, and diff EVERYTHING.
//
//   node gamecube/recomp/sr/verify_fixture.mjs <fixture.json> [more.json ...]
//
// Acceptance, per fixture — all of these, no averaging, no "close enough":
//   1. fault == 0                     (no untranslated callee, no out-of-range access)
//   2. unstaged == 0                  every guest byte read was one the hardware read
//   3. exit GPR[0..31]                bit-identical
//   4. exit FPR PS0[0..31]            bit-identical (the GDB stub cannot see PS1)
//   5. exit CR / XER / LR / CTR       bit-identical
//   6. ordered memory-write log       identical as a sequence of per-byte CHANGE
//                                     events (granularity-independent: native `stmw`
//                                     is one 72-byte record, the translation emits 18
//                                     stores, and both expand to the same event list)
//
// FPSCR is reported but NOT part of the pass criterion: gekko_rt.h states outright
// that the exception/FPRF bits are not modelled.  It is printed either way so the
// gap stays visible instead of being quietly dropped.
//
// PS1 INDEPENDENCE: the stub exposes no PS1 lane, so each fixture is replayed TWICE
// — once with ps1 = ps0 and once with ps1 = 0.  Identical results are the evidence
// that this invocation does not depend on the unknown lane; a difference invalidates
// the fixture and is reported as such (never averaged away).
import fs from 'node:fs';
import path from 'node:path';

const SLICE = process.env.SR_OUT || '/tmp/sr_fixture';
const O_GPR = 0, O_PS0 = 128, O_PS1 = 384, O_CR = 640, O_XER = 644, O_LR = 648,
      O_CTR = 652, O_FPSCR = 656, O_GQR = 660, O_PC = 692, SZ = 696;

const hexb = (s) => Buffer.from(s, 'hex');

function expandWrites(writes) {
  // -> [[physAddr, newByte], ...] in order, only bytes whose value CHANGED.
  const out = [];
  for (const w of writes) {
    const b = hexb(w.before), a = hexb(w.after);
    for (let i = 0; i < a.length; i++)
      if (b[i] !== a[i]) out.push([((w.ea + i) & 0x03ffffff) >>> 0, a[i]]);
  }
  return out;
}

const main = async () => {
  const factory = (await import(path.resolve(SLICE, 'sr_fixture.js'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  if (M._sr_state_size() !== SZ)
    throw new Error(`GekkoState size ${M._sr_state_size()} != expected ${SZ}`);
  const ram = M._sr_ram(), ramSize = M._sr_ram_size(), st = M._sr_state();
  const staged = M._sr_staged(), wlog = M._sr_wlog();
  const phys = (a) => (a & 0x03ffffff) >>> 0;

  let allPass = true;
  for (const file of process.argv.slice(2)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const fx of j.fixtures) {
      const entry = fx.entry >>> 0;
      // HONOUR THE ARTIFACT'S OWN REJECTION FLAG.  Three records in
      // sab_nonleaf_fixtures.json carry usable:false with the reason recorded at
      // capture time -- 0x800e3970 has 30 unknown store forms so its write log is
      // INCOMPLETE BY CONSTRUCTION, and 0x80118180 hit the 40,000-step cap without
      // returning so the capture is TRUNCATED.  Neither can be a pass criterion.
      // A closure build hid this by never emitting them ("not in this build"); a
      // WHOLE-IMAGE build emits everything, so without this gate they run and
      // "fail", which reads exactly like a correctness regression and is not one.
      if (fx.usable === false) {
        const why = fx.unknown_stores?.length ? `${fx.unknown_stores.length} unknown store forms`
                  : fx.returned === false ? `did not return in ${fx.steps} steps`
                  : !fx.n_calls ? 'no bl executed' : 'marked unusable at capture';
        console.log(`SKIP  0x${entry.toString(16).padStart(8, '0')}  usable:false — ${why}`);
        continue;
      }
      const want = expandWrites(fx.writes);
      const tag = `0x${entry.toString(16).padStart(8, '0')}`;
      const runs = [];

      for (const ps1mode of ['ps1=ps0', 'ps1=0']) {
        const H = M.HEAPU8, dv = new DataView(H.buffer);
        H.fill(0xa5, ram, ram + ramSize);         // poison: nothing legitimate reads it
        H.fill(0, staged, staged + ramSize);
        for (const [aHex, byte] of Object.entries(fx.initial_mem)) {
          const p = phys(parseInt(aHex, 16));
          H[ram + p] = byte; H[staged + p] = 1;
        }
        H.fill(0, st, st + SZ);
        const si = fx.state_in;
        for (let i = 0; i < 32; i++) dv.setUint32(st + O_GPR + i * 4, si.gpr[i] >>> 0, true);
        for (let i = 0; i < 32; i++) {
          const v = BigInt(si.fpr[i]);
          dv.setBigUint64(st + O_PS0 + i * 8, v, true);
          dv.setBigUint64(st + O_PS1 + i * 8, ps1mode === 'ps1=ps0' ? v : 0n, true);
        }
        dv.setUint32(st + O_CR, si.cr >>> 0, true);
        dv.setUint32(st + O_XER, si.xer >>> 0, true);
        dv.setUint32(st + O_LR, si.lr >>> 0, true);
        dv.setUint32(st + O_CTR, si.ctr >>> 0, true);
        dv.setUint32(st + O_FPSCR, si.fpscr >>> 0, true);
        for (let i = 0; i < 8; i++)
          dv.setUint32(st + O_GQR + i * 4, (fx.gqr ? fx.gqr[i] : 0) >>> 0, true);
        dv.setUint32(st + O_PC, entry, true);

        M._sr_verify_reset();
        const fault = M._sr_call(entry) >>> 0;
        const unstaged = M._sr_unstaged() >>> 0;
        const n = M._sr_wlog_n() >>> 0;
        const H2 = M.HEAPU8, dv2 = new DataView(H2.buffer);
        const got = [];
        for (let i = 0; i < n; i++)
          got.push([dv2.getUint32(wlog + i * 8, true) >>> 0,
                    dv2.getUint32(wlog + i * 8 + 4, true) >>> 0]);
        const outSt = {
          gpr: Array.from({ length: 32 }, (_, i) => dv2.getUint32(st + O_GPR + i * 4, true) >>> 0),
          fpr: Array.from({ length: 32 }, (_, i) => dv2.getBigUint64(st + O_PS0 + i * 8, true)),
          cr: dv2.getUint32(st + O_CR, true) >>> 0,
          xer: dv2.getUint32(st + O_XER, true) >>> 0,
          lr: dv2.getUint32(st + O_LR, true) >>> 0,
          ctr: dv2.getUint32(st + O_CTR, true) >>> 0,
          fpscr: dv2.getUint32(st + O_FPSCR, true) >>> 0,
        };
        runs.push({ ps1mode, fault, unstaged, wlog: got, out: outSt });
      }

      // --- not in this build ------------------------------------------------
      // sr_call returns 0xBAD0xxxx when sr_dispatch has no case for the entry.  That
      // is "you did not translate this function", not a translation defect, so say so
      // instead of printing a wall of register diffs against an untouched state.
      if ((runs[0].fault >>> 16) === 0xBAD0) {
        console.log(`SKIP  ${tag}  not in this build (sr_dispatch has no entry)`);
        continue;
      }
      // --- PS1 independence -------------------------------------------------
      const [A, B] = runs;
      const sameWlog = A.wlog.length === B.wlog.length &&
        A.wlog.every((e, i) => e[0] === B.wlog[i][0] && e[1] === B.wlog[i][1]);
      const sameState = A.out.gpr.every((v, i) => v === B.out.gpr[i]) &&
        A.out.fpr.every((v, i) => v === B.out.fpr[i]) &&
        A.out.cr === B.out.cr && A.out.xer === B.out.xer &&
        A.out.lr === B.out.lr && A.out.ctr === B.out.ctr;
      const ps1Indep = sameWlog && sameState && A.fault === B.fault;

      // --- the diff ---------------------------------------------------------
      const so = fx.state_out;
      const bad = [];
      if (A.fault !== 0) bad.push(`fault=0x${A.fault.toString(16)}`);
      if (A.unstaged !== 0)
        bad.push(`read of UNSTAGED guest byte 0x${(A.unstaged & 0x7fffffff).toString(16)}`);
      for (let i = 0; i < 32; i++)
        if (A.out.gpr[i] !== (so.gpr[i] >>> 0))
          bad.push(`r${i} want=${(so.gpr[i] >>> 0).toString(16)} got=${A.out.gpr[i].toString(16)}`);
      for (let i = 0; i < 32; i++)
        if (A.out.fpr[i] !== BigInt(so.fpr[i]))
          bad.push(`f${i}(ps0) want=${BigInt(so.fpr[i]).toString(16)} got=${A.out.fpr[i].toString(16)}`);
      for (const k of ['cr', 'xer', 'lr', 'ctr'])
        if (A.out[k] !== (so[k] >>> 0))
          bad.push(`${k} want=${(so[k] >>> 0).toString(16)} got=${A.out[k].toString(16)}`);
      if (A.wlog.length !== want.length)
        bad.push(`write events: want ${want.length}, got ${A.wlog.length}`);
      let firstWDiff = -1;
      for (let i = 0; i < Math.min(want.length, A.wlog.length); i++)
        if (want[i][0] !== A.wlog[i][0] || want[i][1] !== A.wlog[i][1]) { firstWDiff = i; break; }
      if (firstWDiff >= 0)
        bad.push(`write event #${firstWDiff}: want [0x${want[firstWDiff][0].toString(16)}]=` +
                 `${want[firstWDiff][1].toString(16)} got [0x${A.wlog[firstWDiff][0].toString(16)}]=` +
                 `${A.wlog[firstWDiff][1].toString(16)}`);
      // FINAL MEMORY over every address the hardware stored to — including stores
      // that changed nothing.  The change-event list alone leaves one blind spot: a
      // translation that stores the byte's existing value to an address native never
      // touched emits no event.  This closes it.
      {
        const HF = M.HEAPU8;
        // LAST WRITER WINS: an address stored to more than once is only expected to
        // hold the final store's value, so fold the log down before comparing.
        const finalByte = new Map();
        for (const w of fx.writes) {
          const a = hexb(w.after);
          for (let i = 0; i < a.length; i++) finalByte.set((w.ea + i) >>> 0, a[i]);
        }
        for (const [ea, byte] of finalByte) {
          if (HF[ram + phys(ea)] !== byte)
            bad.push(`final memory 0x${ea.toString(16)}: want ${byte.toString(16)} ` +
                     `got ${HF[ram + phys(ea)].toString(16)}`);
        }
        fx._memBytes = finalByte.size;
      }
      if (!ps1Indep) bad.push('PS1-dependent: ps1=ps0 and ps1=0 gave different results');

      const fpscrNote = A.out.fpscr === (so.fpscr >>> 0) ? 'match'
        : `want=${(so.fpscr >>> 0).toString(16)} got=${A.out.fpscr.toString(16)} (NOT MODELLED)`;
      const ok = bad.length === 0;
      allPass = allPass && ok;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag}  steps=${fx.steps} bl=${fx.n_calls} ` +
                  `stores=${fx.writes.length} write-events=${want.length} ` +
                  `final-mem-bytes=${fx._memBytes} ` +
                  `staged=${Object.keys(fx.initial_mem).length} ` +
                  `ps1-indep=${ps1Indep}  fpscr:${fpscrNote}`);
      for (const b of bad.slice(0, 20)) console.log(`        ${b}`);
    }
  }
  console.log(allPass ? '\nALL FIXTURES BIT-EXACT' : '\nMISMATCHES PRESENT');
  process.exit(allPass ? 0 : 1);
};
main();
