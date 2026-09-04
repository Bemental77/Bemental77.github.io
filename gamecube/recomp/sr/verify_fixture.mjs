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
//   5. exit CR / LR / CTR             bit-identical  (XER is EXCLUDED -- see below)
//   6. ordered memory-write log       identical as a sequence of per-byte CHANGE
//                                     events (granularity-independent: native `stmw`
//                                     is one 72-byte record, the translation emits 18
//                                     stores, and both expand to the same event list)
//
// FPSCR is reported but NOT part of the pass criterion: gekko_rt.h states outright
// that the exception/FPRF bits are not modelled.  It is printed either way so the
// gap stays visible instead of being quietly dropped.
//
// XER is reported but NOT scored either, and for a sharper reason: THE ORACLE CANNOT
// SEE IT.  Dolphin keeps XER in split fields (PowerPC.h:157-161 xer_ca / xer_so_ov /
// xer_stringctrl; :200 SetCarry writes xer_ca) and the only two references to
// spr[SPR_XER] in all of Source/Core/Core/PowerPC are GDBStub.cpp:451 (the read this
// harness uses) and :674 (the write).  Nothing keeps that slot live, so register 69
// is a stale value on BOTH sides of the diff.
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

// ---------------------------------------------------------------- exact JSON
// A JS Number CANNOT hold a 64-bit FPR pattern, and `JSON.parse` silently rounds
// one to the nearest double.  This corrupted BOTH sides of the differential:
// `state_in.fpr` (so the wasm was fed a slightly wrong input) and `state_out.fpr`
// (so the EXPECTED value was wrong).  `BigInt(v)` at the use site does not help --
// by then the precision is already gone.
//
// MEASURED, on the stg13D overlay fixture 0x8121d80c:
//     interpreter state_out.fpr[2] = 0x3f23a865467c9bd3 = 4549665201502067667
//     through a JS double          = 4549665201502067712 = 0x3f23a865467c9c00
// The wasm produced 0x3f23a865467c9bd3 -- exactly right -- and this harness
// reported it as `want=...9c00 got=...9bd3`, i.e. it blamed the translator for the
// reader's own rounding.  Same class of bug as the one xform_vectors.py already
// paid for (goldens there are hex strings for this reason); this file reads the
// older number-valued fixtures, so it must parse them exactly instead.
//
// Numbers too large to be exact become BigInt, from the RAW SOURCE TEXT.  Every
// other field (gpr, cr, ea, ...) is <= 32 bits and stays a Number.
const SOURCE_REVIVER_OK = (() => {
  try {
    return JSON.parse('{"a":4550999638074826707}',
                      (k, v, ctx) => (ctx && ctx.source) ? ctx.source : v).a === '4550999638074826707';
  } catch { return false; }
})();

function parseExact(text) {
  if (!SOURCE_REVIVER_OK) {
    // Never fall back silently to the lossy reader -- that is what produced a
    // false FAIL in the first place.
    throw new Error(
      `this Node (${process.version}) has no JSON source reviver, so 64-bit FPR ` +
      `values cannot be read exactly. Node 21+ is required.`);
  }
  return JSON.parse(text, function (k, v, ctx) {
    if (typeof v === 'number' && ctx && typeof ctx.source === 'string' &&
        /^-?\d+$/.test(ctx.source) && !Number.isSafeInteger(v))
      return BigInt(ctx.source);
    return v;
  });
}

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
  // COUNTS, NOT A VERDICT.  "ALL FIXTURES BIT-EXACT" used to print whenever nothing
  // FAILED -- including a run in which every fixture was refused and none was scored,
  // which is a vacuous pass and exactly the shape a survey must never report. Every
  // refusal is tallied by its reason so a gap is visible as a named class with a
  // count, rather than as a smaller denominator nobody printed.
  const tally = { pass: 0, fail: 0, refused: 0, notBuilt: 0 };
  const why = new Map();
  const refuse = (kind, line) => {
    tally.refused++;
    why.set(kind, (why.get(kind) || 0) + 1);
    console.log(line);
  };
  for (const file of process.argv.slice(2)) {
    const j = parseExact(fs.readFileSync(file, 'utf8'));
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
        refuse(`unusable at capture (${why})`,
               `SKIP  0x${entry.toString(16).padStart(8, '0')}  usable:false — ${why}`);
        continue;
      }
      // NOT REPLAYABLE BY CONSTRUCTION: the harness stages guest MEM1 only
      // (sr_ram covers 0x80000000..0x81800000), so an invocation that reads or
      // writes outside it has bytes the fixture never captured.  Replaying it
      // reads poison and produces a wall of register diffs that look like a
      // translation defect and are not one -- the same trap `usable:false`
      // exists for.  Reject it here rather than scoring it.
      if (fx.outside_mem1?.length) {
        const list = fx.outside_mem1.slice(0, 3)
          .map((a) => `0x${(a >>> 0).toString(16)}`).join(', ');
        // Name the REGION, not just "outside MEM1": these are two distinct pieces of
        // Gekko state, each with its own reason for being unmodelled, and lumping
        // them together hides which one to fix first.
        //   0xE0000000..  the LOCKED L1 CACHE (Memmap.h:253, 256 KB).  gekko_rt.h
        //     gk_phys() masks an EA with 0x03FFFFFF, so 0xE0000030 would alias onto
        //     MEM1 offset 0x30 -- and the oracle cannot even read it back: an `m`
        //     packet there panics (see native_oracle_gdb.py).
        //   0xCC008000   WPAR, the write-gather pipe -- i.e. the guest pushing GX
        //     commands.  MMIO, not memory; nothing in the replay models it.
        const region = (a) => ((a >>> 0) >= 0xE0000000 && (a >>> 0) < 0xE0040000)
          ? 'Gekko locked L1 cache 0xE00000xx'
          : ((a >>> 0) === 0xCC008000 ? 'WPAR write-gather pipe 0xCC008000'
                                      : `unmodelled 0x${(a >>> 0).toString(16)}`);
        const kinds = [...new Set(fx.outside_mem1.map(region))];
        refuse(`touches ${kinds.join(' + ')}`,
               `SKIP  0x${entry.toString(16).padStart(8, '0')}  not replayable — ` +
               `touches ${fx.outside_mem1.length} address(es) outside MEM1 (${list}` +
               `${fx.outside_mem1.length > 3 ? ', ...' : ''}) = ${kinds.join(' + ')}; ` +
               `the harness stages MEM1 only`);
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
        tally.notBuilt++;
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
      // XER IS NOT OBSERVABLE THROUGH THIS ORACLE, so it cannot be a pass criterion.
      // Dolphin's interpreter keeps XER in SPLIT FIELDS -- PowerPC.h:157-161
      // `xer_ca` / `xer_so_ov` / `xer_stringctrl` -- and PowerPC.h:200
      // `SetCarry(ca) { xer_ca = ca; }` never writes spr[SPR_XER].  The ONLY two
      // references to spr[SPR_XER] anywhere in Source/Core/Core/PowerPC are
      // GDBStub.cpp:451 (the read this harness uses, register 69) and :674 (the
      // write).  Nothing syncs the slot, so it reports whatever was last poked into
      // it, forever.
      //
      // The tell, on fixture 0x8010334c: state_in.xer == state_out.xer ==
      // 0x20000000 with `xer` absent from the capture's own delta -- i.e. the
      // oracle claims XER never changed across an invocation that executes four
      // `addic.` and two `sraw`, every one of which writes CA.  Comparing against
      // that produced `xer want=20000000 got=0` on a run where every GPR, every
      // FPR, CR, LR, CTR, all 66 ordered write events and all 84 final memory
      // bytes were bit-identical.  Reported, never scored -- same treatment FPSCR
      // gets, and for a better-evidenced reason.
      for (const k of ['cr', 'lr', 'ctr'])
        if (A.out[k] !== (so[k] >>> 0))
          bad.push(`${k} want=${(so[k] >>> 0).toString(16)} got=${A.out[k].toString(16)}`);
      const xerNote = A.out.xer === (so.xer >>> 0) ? 'match'
        : `want=${(so.xer >>> 0).toString(16)} got=${A.out.xer.toString(16)} ` +
          `(NOT OBSERVABLE: GDBStub.cpp:451 reads a dead spr[SPR_XER] slot)`;
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
      tally[ok ? 'pass' : 'fail']++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag}  steps=${fx.steps} bl=${fx.n_calls} ` +
                  `stores=${fx.writes.length} write-events=${want.length} ` +
                  `final-mem-bytes=${fx._memBytes} ` +
                  `staged=${Object.keys(fx.initial_mem).length} ` +
                  `ps1-indep=${ps1Indep}  fpscr:${fpscrNote}  xer:${xerNote}`);
      for (const b of bad.slice(0, 20)) console.log(`        ${b}`);
    }
  }
  const attempted = tally.pass + tally.fail + tally.refused + tally.notBuilt;
  console.log(`\nSUMMARY  ${tally.pass} verified / ${attempted} attempted / ` +
              `${tally.refused + tally.notBuilt} refused` +
              (tally.fail ? ` / ${tally.fail} MISMATCHED` : ''));
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1]))
    console.log(`  refused ${String(n).padStart(4)}  ${k}`);
  if (tally.notBuilt)
    console.log(`  refused ${String(tally.notBuilt).padStart(4)}  not in this build`);
  // A run in which nothing was SCORED is not a pass, however few things failed.
  if (tally.fail) console.log('MISMATCHES PRESENT');
  else if (!tally.pass) console.log('NOTHING WAS SCORED — every fixture was refused');
  else console.log(`ALL ${tally.pass} SCORED FIXTURES BIT-EXACT`);
  process.exit(tally.fail || !tally.pass ? 1 : 0);
};
main();
