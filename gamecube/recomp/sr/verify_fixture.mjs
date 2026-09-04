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
// "GUEST BYTE" INCLUDES THE GEKKO LOCKED L1 CACHE (0xE0000000..0xE0040000).  It is
// ordinary memory — DOLSDK OSCache.c:309-365 maps it with DBAT3 and the program then
// uses plain loads and stores on it, and Dolphin memcpys it in and out of m_l1_cache
// (MMU.cpp:246-253 / :437-442) with no cache semantics at all.  So it is staged,
// checked and compared exactly like MEM1.  The capture reads it by EXECUTING a guest
// `lwz` (native_oracle_gdb.LockedCacheReader), because asking the stub for a host
// pointer there panics Dolphin — Memmap.cpp:722-740 has no L1 arm while
// MMU.cpp:926-929 says the address IS RAM.  WPAR (0xCC008000) is the one region that
// stays a sink: it is write-only MMIO, so its stores are excluded and flagged.
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

// ------------------------------------------------------------ region mapping
// A MIRROR OF gekko_rt.h's gk_tail() / gk_phys(), and it has to stay one: the wasm
// side decides where a guest address lands, and every address this harness stages,
// poisons or compares has to land in the same place.  MEM1 masks to 26 bits; the two
// windows that are not MEM1 live in a tail past g_ram_size.
//   0xE0000000..0xE0040000  the Gekko locked L1 cache -- ORDINARY MEMORY (Dolphin
//     MMU.cpp:246-253 / :437-442 memcpy it; Memmap.h:253 sizes it), staged from the
//     capture and compared byte for byte like MEM1.
//   0xCC008000..0xCC009000  WPAR, the GX write-gather pipe -- MMIO, write-only, a
//     sink whose stores the wasm side never logs.
const GK_L1_SIZE = 0x00040000, GK_WPAR_SIZE = 0x00001000;
const GK_TAIL_SIZE = GK_L1_SIZE + GK_WPAR_SIZE;
const IN_L1 = (a) => ((a >>> 0) >>> 28) === 0xE && ((a >>> 0) & 0x0FFFFFFF) < GK_L1_SIZE;
const IN_WPAR = (a) => (((a >>> 0) & ~(GK_WPAR_SIZE - 1)) >>> 0) === 0xCC008000;

function expandWrites(writes, phys) {
  // -> [[physAddr, newByte], ...] in order, only bytes whose value CHANGED.
  const out = [];
  for (const w of writes) {
    const b = hexb(w.before), a = hexb(w.after);
    for (let i = 0; i < a.length; i++)
      if (b[i] !== a[i]) out.push([phys(w.ea + i), a[i]]);
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
  // A build without this export predates the locked-cache model, and replaying a
  // locked-cache fixture against it would write the tail off the end of the
  // allocation.  Fail loudly rather than produce numbers from the wrong binary.
  if (typeof M._sr_tail_size !== 'function')
    throw new Error('this sr_fixture build has no _sr_tail_size — rebuild it ' +
                    '(build_fixture.sh) before verifying locked-cache fixtures');
  const tailSize = M._sr_tail_size();
  if (tailSize !== GK_TAIL_SIZE)
    throw new Error(`tail size ${tailSize} != ${GK_TAIL_SIZE} — gekko_rt.h and ` +
                    `verify_fixture.mjs disagree about the region layout`);
  const bufSize = ramSize + tailSize;
  const phys = (a) => {
    const ea = a >>> 0;
    if (IN_L1(ea)) return (ramSize + (ea & (GK_L1_SIZE - 1))) >>> 0;
    if (IN_WPAR(ea)) return (ramSize + GK_L1_SIZE + (ea & (GK_WPAR_SIZE - 1))) >>> 0;
    return (ea & 0x03ffffff) >>> 0;
  };

  let allPass = true;
  // COUNTS, NOT A VERDICT.  "ALL FIXTURES BIT-EXACT" used to print whenever nothing
  // FAILED -- including a run in which every fixture was refused and none was scored,
  // which is a vacuous pass and exactly the shape a survey must never report. Every
  // refusal is tallied by its reason so a gap is visible as a named class with a
  // count, rather than as a smaller denominator nobody printed.
  const tally = { pass: 0, fail: 0, refused: 0, notBuilt: 0, passWithSink: 0, lcScored: 0 };
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
      // [derive 2026-09-04] A MISSING VERDICT MUST NOT READ AS A PASSING ONE.
      // Only fixture_rel.py wrote `usable`; fixture_nonleaf.py never did, so its
      // captures arrived as `undefined` — which is not `=== false` — and a
      // truncated or unknown-store capture replayed as sound. fixture_nonleaf.py
      // now records it, but artifacts captured before that do not (sab_bctr,
      // sab_blrl and sab_rel_stg13D_fixtures all carry 0 of the field), so the
      // verdict is DERIVED here from the same evidence rather than assumed.
      // Deriving keeps genuinely-sound old artifacts passing while refusing
      // unsound ones; treating absence as "fine" did the opposite.
      if (fx.usable === undefined) {
        const bad = [];
        if (fx.returned === false) bad.push(`did not return in ${fx.steps} steps`);
        if (fx.unknown_stores?.length) bad.push(`${fx.unknown_stores.length} unknown store forms`);
        // DELIBERATELY NOT outside_mem1 / ps1_dependency. Both have their own
        // downstream handling below (:176-187 scores write-only stores to known
        // unmodelled regions with a note and refuses READS), so deriving a
        // blanket refusal from them here would reject captures the existing
        // logic passes correctly. Only the two conditions that make a capture
        // unsound BY CONSTRUCTION are derived: a truncated trace, and an
        // incomplete write log.
        if (bad.length) {
          refuse(`unusable (derived: ${bad.join('; ')})`,
                 `SKIP  0x${entry.toString(16).padStart(8, '0')}  no usable field — derived unusable: ${bad.join('; ')}`);
          continue;
        }
      }
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
      // UNMODELLED REGIONS: refuse on a READ, score on write-only.
      //
      // The blanket "touches anything outside MEM1 -> not replayable" rule was too
      // strict and it was throwing away most of the survey: SAB's City Escape overlay
      // pushes GX commands through WPAR (0xCC008000) and uses the Gekko locked L1
      // (0xE00000xx) as scratch, so almost every drawing function tripped it.  Neither
      // region is memory anyone can compare -- the oracle cannot read them back
      // either (an `m` packet at 0xE00000xx panics Dolphin) -- but a function that
      // only WRITES there has every other effect fully checkable, and gekko_rt.h now
      // gives both windows a private sink whose stores are excluded from the change
      // log.  What is NOT sound is a READ of a byte this invocation did not write, so
      // that is still a refusal, by name.  Older fixtures carry no direction
      // information; those stay refused rather than being assumed write-only.
      //
      // [locked cache 2026-09-04] HALF OF THAT IS NOW OBSOLETE, and it was the whole
      // blocker: 11 of the 21 attempts across the two overlay surveys were refused,
      // every one of them for reading 0xE00000xx.  The locked L1 cache is not an
      // unmodelled region at all -- DOLSDK OSCache.c:309-365 maps it with DBAT3 and
      // the program uses plain loads and stores on it, and Dolphin models it as a
      // flat buffer (MMU.cpp:246-253 read, :437-442 write, Memmap.h:253 size).  It is
      // real memory here too now, staged from the capture and compared byte for byte.
      // The oracle reads it by EXECUTING a guest `lwz` rather than asking the stub
      // for a host pointer (native_oracle_gdb.LockedCacheReader), which is why the
      // Memmap.cpp:740 panic is no longer in the way.  WPAR stays a sink: it is MMIO.
      const okind = fx.outside_mem1_kind;
      const readsOutside = okind
        ? Object.entries(okind).filter(([, k]) => k !== 'store')
        : null;
      // THE ONLY WRITE-ONLY SINK LEFT IS WPAR.  The locked cache used to be in this
      // set and it was the single cause of every refusal in both overlay surveys;
      // it is modelled memory now, so a capture that still routes it through
      // `outside_mem1` is one taken BEFORE the model existed and has no staged bytes
      // for it.  Refusing such an artifact by name is the point -- replaying it
      // would read the tail's zeros and score a fixture on fabricated inputs.
      const KNOWN = (a) => IN_WPAR(a);
      const allKnown = (fx.outside_mem1 || []).every(KNOWN);
      let sinkNote = '';
      if (fx.outside_mem1?.length && okind && allKnown && readsOutside.length === 0) {
        sinkNote = ` [${fx.outside_mem1.length} WPAR store(s) NOT compared]`;
      } else if (fx.outside_mem1?.length) {
        const list = fx.outside_mem1.slice(0, 3)
          .map((a) => `0x${(a >>> 0).toString(16)}`).join(', ');
        // Name the REGION, not just "outside MEM1": these are distinct pieces of
        // Gekko state with distinct reasons, and lumping them together hides which
        // one to fix first.
        //   0xE0000000..  the LOCKED L1 CACHE.  MODELLED NOW -- so seeing it here at
        //     all means the CAPTURE predates the model and carries no staged bytes
        //     for it.  Re-capture; do not relax this.
        //   0xCC008000   WPAR, the write-gather pipe -- the guest pushing GX
        //     commands.  MMIO, not memory; there is nothing to read back, ever.
        const region = (a) => IN_L1(a)
          ? 'Gekko locked L1 cache 0xE00000xx'
          : (IN_WPAR(a) ? 'WPAR write-gather pipe 0xCC008000'
                        : `unmodelled 0x${(a >>> 0).toString(16)}`);
        const kinds = [...new Set(fx.outside_mem1.map(region))];
        const staleLC = fx.outside_mem1.some(IN_L1);
        const cause = staleLC
                      ? 'the locked cache is MODELLED now — this capture predates it ' +
                        '(no staged bytes for those addresses); re-capture it'
                    : !okind ? 'capture recorded no load/store direction'
                    : !allKnown ? 'an address outside the modelled windows'
                    // A WPAR READ is not a gap to close, unlike the locked cache: the
                    // write-gather pipe is MMIO (EA 0xCC008000 translates to physical
                    // 0x0C008000, which MMU.cpp:233-244 routes to the MMIO mapping),
                    // so there is no prior value to stage and reading it on the oracle
                    // would have side effects on the machine being observed.
                    : `${readsOutside.length} address(es) READ, not just written — a ` +
                      `WPAR read is MMIO with side effects, so it cannot be staged ` +
                      `from the oracle at all`;
        refuse(`touches ${kinds.join(' + ')} — ${cause}`,
               `SKIP  0x${entry.toString(16).padStart(8, '0')}  not replayable — ` +
               `touches ${fx.outside_mem1.length} address(es) outside MEM1 (${list}` +
               `${fx.outside_mem1.length > 3 ? ', ...' : ''}) = ${kinds.join(' + ')}; ` +
               `${cause}`);
        continue;
      }
      // LOCKED-CACHE PROVENANCE GATE.  This checks WHERE the 0xE00000xx bytes came
      // from, and nothing else — COMPLETENESS is already enforced exactly, and by a
      // better instrument: gk_rd_chk() faults on any read of an unstaged byte, so a
      // locked-cache read this capture missed shows up below as
      // `read of UNSTAGED guest byte 0xE00000xx` and FAILS the fixture. Re-deriving
      // that here would only add a way to be wrong (a load whose bytes this
      // invocation had already written is legitimately absent from initial_mem).
      // What the runtime cannot see is provenance, so that is what is checked:
      //   * staged 0xE00000xx bytes with no `locked_cache` record — nothing says how
      //     they were obtained, and an `m` packet there panics Dolphin, so an
      //     artifact claiming them without naming a reader is not trustworthy;
      //   * a reader this harness does not know; and
      //   * a record that claims locked-cache accesses while the gadget read zero
      //     words, which is what a silently-broken reader looks like.
      {
        const lcKeys = Object.keys(fx.initial_mem).filter((k) => IN_L1(parseInt(k, 16)));
        const lc = fx.locked_cache;
        const nKind = Object.keys(lc?.kind || {}).length;
        let bad = null;
        if (lcKeys.length && !lc)
          bad = [`${lcKeys.length} staged 0xE00000xx byte(s) but no locked_cache record`,
                 'locked-cache bytes with no capture record'];
        else if (lc && nKind && lc.reader !== 'lwz-gadget')
          bad = [`locked_cache.reader = ${JSON.stringify(lc.reader)}, not "lwz-gadget"`,
                 'locked-cache read by an unknown instrument'];
        else if (lc && nKind && !lc.words_read)
          bad = [`${nKind} locked-cache address(es) recorded but words_read = ` +
                 `${lc.words_read} — the reader never ran`,
                 'locked-cache record with no reader activity'];
        if (bad) {
          refuse(bad[1], `SKIP  0x${entry.toString(16).padStart(8, '0')}  ${bad[0]}`);
          continue;
        }
      }
      const want = expandWrites(fx.writes, phys);
      const tag = `0x${entry.toString(16).padStart(8, '0')}`;
      const runs = [];

      for (const ps1mode of ['ps1=ps0', 'ps1=0']) {
        const H = M.HEAPU8, dv = new DataView(H.buffer);
        // RESET FIRST, THEN STAGE.  sr_verify_reset() zeroes the locked-cache /
        // WPAR tail; staging before it would have the reset wipe every staged
        // locked-cache byte and turn each read into an unstaged-read fault.
        M._sr_verify_reset();
        H.fill(0xa5, ram, ram + bufSize);          // poison: nothing legitimate reads it
        H.fill(0, staged, staged + bufSize);
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
      if (A.fault !== 0) {
        // NAME THE FAULT.  sr_driver.c encodes what went wrong in the top byte, and
        // two of the three are BUILD COMPLETENESS, not a translation defect:
        //   0xE0 sr_extern()   a DIRECT call to a function outside the emitted set
        //   0xE1 sr_indirect() an INDIRECT target (blrl/bctrl/bctr) that is not a
        //                      dispatchable entry in this build -- and a static
        //                      closure walk cannot find those, because nothing names
        //                      them.  Measured: otherprintD 0x81200084 reported
        //                      fault=0xe10ff010 plus a wall of write-event and
        //                      final-memory diffs; the diffs were all downstream of
        //                      the missed call, and adding 0x800ff010 (an exact DOL
        //                      function start) as a root made the same fixture
        //                      bit-exact. Reported as an address to add, not as a
        //                      divergence to investigate.
        //   0x80 gk_ok()       a guest access outside MEM1 and outside the two
        //                      modelled windows -- that one IS a defect.
        const t = A.fault >>> 24, lo = (A.fault & 0x00ffffff).toString(16);
        bad.push(
          t === 0xE1 ? `fault=0x${A.fault.toString(16)}: INDIRECT target 0x??${lo} is ` +
                       `not in this build — re-emit with it as a root (a static ` +
                       `closure cannot discover an indirect callee)`
        : t === 0xE0 ? `fault=0x${A.fault.toString(16)}: DIRECT call to 0x??${lo} is ` +
                       `outside the emitted set`
        : `fault=0x${A.fault.toString(16)}` +
          (t === 0x80 ? ` (guest access outside MEM1 at phys 0x${lo})` : ''));
      }
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
      if (ok && sinkNote) tally.passWithSink++;
      // Count the locked-cache fixtures separately: "verified" means nothing here
      // unless it is visible WHICH results rest on staged 0xE00000xx bytes.
      const lcKind = fx.locked_cache?.kind || {};
      const nLC = Object.keys(lcKind).length;
      if (ok && nLC) tally.lcScored++;
      const lcNote = nLC
        ? ` [locked L1: ${Object.values(lcKind).filter((k) => k !== 'store').length} read / ` +
          `${Object.values(lcKind).filter((k) => k !== 'load').length} written, ` +
          `${fx.locked_cache.words_read} gadget words]`
        : '';
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${tag}${sinkNote}${lcNote}  steps=${fx.steps} bl=${fx.n_calls} ` +
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
  if (tally.passWithSink)
    console.log(`  NOTE ${String(tally.passWithSink).padStart(6)}  of the verified ` +
                `fixtures also store to WPAR (0xCC008000), which is write-only MMIO; ` +
                `those stores are not compared, everything else is`);
  if (tally.lcScored)
    console.log(`  NOTE ${String(tally.lcScored).padStart(6)}  of the verified ` +
                `fixtures read and/or write the Gekko locked L1 cache; those bytes ` +
                `ARE staged from the oracle and ARE compared`);
  // A run in which nothing was SCORED is not a pass, however few things failed.
  if (tally.fail) console.log('MISMATCHES PRESENT');
  else if (!tally.pass) console.log('NOTHING WAS SCORED — every fixture was refused');
  else console.log(`ALL ${tally.pass} SCORED FIXTURES BIT-EXACT`);
  process.exit(tally.fail || !tally.pass ? 1 : 0);
};
main();
