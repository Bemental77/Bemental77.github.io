#!/usr/bin/env node
// verify_ctxsw.mjs — WITNESS a real guest context switch in the static-recomp
// runtime, and differentially check the host boundary against the shipped code.
//
//   node gamecube/recomp/sr/verify_ctxsw.mjs [outdir]      (default /tmp/sr_ctxsw)
//
// It runs three things, in increasing strength:
//
//   A. DIFFERENTIAL, non-switching paths.  Three scenarios in which the shipped
//      SelectThread returns normally, run twice: once through the TRANSLATED
//      function (the oracle build) and once through host_select_thread.  Exit
//      GekkoState and MEM1 must match exactly.
//   B. DIFFERENTIAL, the switching path.  Both builds are frozen at the instant
//      OSLoadContext has loaded the next thread and is about to rfi, and the two
//      frozen machines are diffed (registers + an FNV-1a hash of all 24 MB).
//      This is the only way to compare the switch, because on the real machine
//      SelectThread never returns from it.
//   C. THE WITNESS.  A textbook DOLSDK cooperative round trip, entirely in
//      translated guest code: thread A calls OSSleepThread(&q) -> switch -> thread
//      B runs OSWakeupThread(&q) -> switch back -> A resumes inside SelectThread
//      and OSSleepThread returns.  Two distinct host threads; A's callee-saved
//      registers are sentinel-checked across the round trip.
import fs from 'node:fs';
import path from 'node:path';

const OUT   = process.argv[2] || '/tmp/sr_ctxsw';
const TRACE = process.argv[3] || '/tmp/sr_ctxsw_trace';

// ---------------------------------------------------------------- guest map
// Real addresses (baked into the shipped code, recovered in sr_host_os.h).
const G_CURRENT_THREAD = 0x800000e4, OS_CURRENT_CONTEXT = 0x800000d4;
const OS_CURRENT_PHYS  = 0x800000c0, OS_FPU_CONTEXT     = 0x800000d8;
const RUNQUEUE         = 0x802babb8;
// Chosen by this harness (r13-relative, so the value is not load-bearing; picked
// to sit above RunQueue and below the staged threads).
const R13   = 0x802e0000;
const RQBITS = R13 - 30176, RQHINT = R13 - 30172, RESCHED = R13 - 30168;
const THREAD_A = 0x80300000, THREAD_B = 0x80301000, QUEUE = 0x80302000;
const STACK_A  = 0x8030ff00, STACK_B  = 0x8031ff00;
const R2 = 0x802c8000, MSR0 = 0x00009032;

const OSSleepThread = 0x800ec890, OSWakeupThread = 0x800ec97c, SelectThread = 0x800ebd68;
const OSTH = { STATE: 712, ATTR: 714, SUSPEND: 716, PRIORITY: 720, BASE: 724,
               VAL: 728, QUEUE: 732, LINK_NEXT: 736, LINK_PREV: 740 };
const OSCTX = { CR: 128, LR: 132, CTR: 136, XER: 140, SRR0: 408, SRR1: 412,
                MODE: 416, STATE: 418, GQR: 420 };

let pass = 0, fail = 0;
const ok  = (n, c, extra = '') => { c ? pass++ : fail++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? '   ' + extra : ''}`); };
const eq = (n, got, want) => ok(n, got === want,
  `got ${typeof got === 'number' ? '0x' + (got >>> 0).toString(16) : got} want ` +
  `${typeof want === 'number' ? '0x' + (want >>> 0).toString(16) : want}`);

// ------------------------------------------------------------------ module
async function boot(dir) {
  const factory = (await import(path.resolve(dir, 'sr_ctxsw.mjs'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  const ram = M._sr_ram(), stp = M._sr_state();
  // GekkoState: gpr[32]=0..127, ps0[32]=128..383, ps1[32]=384..639, then
  // cr,xer,lr,ctr,fpscr,gqr[8],pc from 640.  Asserted, not assumed.
  if (M._sr_state_size() !== 696)
    throw new Error(`GekkoState is ${M._sr_state_size()} B, not 696 — re-derive the offsets`);
  const wbe32 = (a, v) => { const p = ram + (a & 0x03ffffff);
    M.HEAPU8[p] = (v >>> 24) & 255; M.HEAPU8[p + 1] = (v >>> 16) & 255;
    M.HEAPU8[p + 2] = (v >>> 8) & 255; M.HEAPU8[p + 3] = v & 255; };
  const rbe32 = (a) => { const p = ram + (a & 0x03ffffff);
    return ((M.HEAPU8[p] << 24) | (M.HEAPU8[p + 1] << 16) |
            (M.HEAPU8[p + 2] << 8) | M.HEAPU8[p + 3]) >>> 0; };
  const wbe16 = (a, v) => { const p = ram + (a & 0x03ffffff);
    M.HEAPU8[p] = (v >>> 8) & 255; M.HEAPU8[p + 1] = v & 255; };
  const rbe16 = (a) => { const p = ram + (a & 0x03ffffff);
    return ((M.HEAPU8[p] << 8) | M.HEAPU8[p + 1]) >>> 0; };
  // GekkoState layout is gpr[32] then ps0/ps1 (8-byte) then the scalars; read the
  // offsets the same way verify_fixture.mjs does — off gpr and the known order.
  const S = {
    gpr: (i) => M.HEAPU32[(stp >> 2) + i],
    setGpr: (i, v) => { M.HEAPU32[(stp >> 2) + i] = v >>> 0; },
    // gpr 32*4=128, ps0 32*8=256 -> 384, ps1 -> 640; then cr,xer,lr,ctr,fpscr,gqr[8],pc
    base: 640,
    u32: (o) => M.HEAPU32[(stp + 640 + o) >> 2],
    setU32: (o, v) => { M.HEAPU32[(stp + 640 + o) >> 2] = v >>> 0; },
  };
  const F = { CR: 0, XER: 4, LR: 8, CTR: 12, FPSCR: 16, GQR: 20, PC: 52 };
  return { M, ram, stp, wbe32, rbe32, wbe16, rbe16, S, F,
           zero: (a, n) => M.HEAPU8.fill(0, ram + (a & 0x03ffffff),
                                            ram + (a & 0x03ffffff) + n) };
}

// ------------------------------------------------------- stage the OS world
// Mirrors __OSThreadInit (~/gc_refs/dolsdk2001/src/os/OSThread.c:140-158) plus one
// OSCreateThread'd second thread, written straight into MEM1.
function stage(E, { schedA = 8, schedB = 16, reschedule = 0, curThread = THREAD_A,
                    curContext = THREAD_A, aState = 2, aCtxState = 0,
                    bEntry = OSWakeupThread, bArg = QUEUE } = {}) {
  E.M.HEAPU8.fill(0, E.ram, E.ram + 0x01800000);
  E.wbe32(OS_CURRENT_CONTEXT, curContext);
  E.wbe32(OS_CURRENT_PHYS, curContext & 0x3fffffff);
  E.wbe32(OS_FPU_CONTEXT, 0);
  E.wbe32(G_CURRENT_THREAD, curThread);
  E.wbe32(RESCHED, reschedule);
  E.wbe32(RQHINT, 0);
  E.wbe32(RQBITS, 0);

  // thread A — the one that is RUNNING
  E.wbe16(THREAD_A + OSTH.STATE, aState);
  E.wbe16(THREAD_A + OSTH.ATTR, 1);
  E.wbe32(THREAD_A + OSTH.PRIORITY, schedA);
  E.wbe32(THREAD_A + OSTH.BASE, schedA);
  E.wbe16(THREAD_A + OSCTX.STATE, aCtxState);
  E.wbe32(THREAD_A + OSCTX.SRR1, MSR0);

  // thread B — READY, queued on RunQueue[schedB], as OSCreateThread + OSResumeThread
  // would have left it.  Its context is what OSInitContext builds: srr0 = entry.
  E.wbe16(THREAD_B + OSTH.STATE, 1);
  E.wbe16(THREAD_B + OSTH.ATTR, 1);
  E.wbe32(THREAD_B + OSTH.PRIORITY, schedB);
  E.wbe32(THREAD_B + OSTH.BASE, schedB);
  E.wbe32(THREAD_B + OSTH.QUEUE, RUNQUEUE + schedB * 8);
  E.wbe32(RUNQUEUE + schedB * 8 + 0, THREAD_B);
  E.wbe32(RUNQUEUE + schedB * 8 + 4, THREAD_B);
  E.wbe32(RQBITS, (1 << (31 - schedB)) >>> 0);
  E.wbe32(THREAD_B + OSCTX.SRR0, bEntry);
  E.wbe32(THREAD_B + OSCTX.SRR1, MSR0);
  E.wbe16(THREAD_B + OSCTX.STATE, 0);
  E.wbe32(THREAD_B + 4, STACK_B);          // context.gpr[1]
  E.wbe32(THREAD_B + 8, R2);               // context.gpr[2]
  E.wbe32(THREAD_B + 12, bArg);            // context.gpr[3]  = the argument
  E.wbe32(THREAD_B + 13 * 4, R13);         // context.gpr[13] = SDA base
  for (let r = 14; r < 32; r++) E.wbe32(THREAD_B + r * 4, (0xbb000000 | r) >>> 0);
  E.wbe32(THREAD_B + OSCTX.LR, 0xdead0000);

  E.wbe32(QUEUE + 0, 0); E.wbe32(QUEUE + 4, 0);
}

function setRegs(E, { r1 = STACK_A, r3 = QUEUE, lr = 0xfeed0000 } = {}) {
  for (let i = 0; i < 32; i++) E.S.setGpr(i, 0);
  E.S.setGpr(1, r1); E.S.setGpr(2, R2); E.S.setGpr(3, r3); E.S.setGpr(13, R13);
  for (let r = 14; r < 32; r++) E.S.setGpr(r, (0xaa000000 | r) >>> 0);
  E.S.setU32(E.F.LR, lr); E.S.setU32(E.F.CR, 0); E.S.setU32(E.F.XER, 0);
  E.S.setU32(E.F.CTR, 0);
}

const snapRegs = (E) => {
  const g = []; for (let i = 0; i < 32; i++) g.push(E.S.gpr(i) >>> 0);
  return { gpr: g, cr: E.S.u32(E.F.CR) >>> 0, xer: E.S.u32(E.F.XER) >>> 0,
           lr: E.S.u32(E.F.LR) >>> 0, ctr: E.S.u32(E.F.CTR) >>> 0,
           pc: E.S.u32(E.F.PC) >>> 0 };
};
const memHash = (E) => { let h = 2166136261 >>> 0;
  for (let i = 0; i < 0x01800000; i++) { h = (h ^ E.M.HEAPU8[E.ram + i]) >>> 0;
    h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };

const EV = { 1:'DISABLE_IRQ', 2:'ENABLE_IRQ', 3:'RESTORE_IRQ', 4:'SET_CTX', 5:'GET_CTX',
             6:'CLEAR_CTX', 10:'SELECT_ENTER', 11:'SELECT_SAVE', 12:'HANDOFF',
             13:'START_THREAD', 14:'RESUMED', 15:'SELECT_RETURN', 16:'THREAD_ENTRY',
             17:'THREAD_EXIT', 20:'SAVECTX', 21:'LOADCTX' };
function dumpTrace(E, label) {
  const n = E.M._sr_os_trace_n(), p = E.M._sr_os_trace();
  console.log(`\n--- ${label}: ${n} host-boundary events`);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ev = E.M.HEAPU32[(p >> 2) + i * 3], a = E.M.HEAPU32[(p >> 2) + i * 3 + 1],
          b = E.M.HEAPU32[(p >> 2) + i * 3 + 2];
    rows.push([ev, a, b]);
    console.log(`  ${String(i).padStart(3)}  ${(EV[ev] || ev).padEnd(14)} ` +
                `a=0x${(a >>> 0).toString(16).padStart(8, '0')} ` +
                `b=0x${(b >>> 0).toString(16).padStart(8, '0')}`);
  }
  return rows;
}

// ============================================================================
// A guest thread's host thread parks for good once it has handed control back, so
// a module instance carries slot bindings forward.  Each section therefore gets
// its own instance — sharing one would let section B's parked thread B resume into
// section C's freshly re-staged world.
const haveTrace = fs.existsSync(path.join(TRACE, 'sr_ctxsw.mjs'));
if (!haveTrace) console.log(`(no oracle build at ${TRACE}; differentials A/B skipped)`);
async function hleInst() { const E = await boot(OUT);
  E.M._sr_os_init(4); E.M._sr_os_mode(1); E.M._sr_os_set_timeout(4000); return E; }
async function orcInst() { const E = await boot(TRACE);
  E.M._sr_os_init(4); E.M._sr_os_mode(2); E.M._sr_os_set_timeout(4000); return E; }

// ---------------------------------------------------- A. non-switching paths
// SelectThread's only argument is `yield` in r3, so every direct call here passes 0.
const SCENARIOS = [
  ['Reschedule > 0 refuses',        { reschedule: 1 }],
  ['context != currentThread',      { curContext: THREAD_B }],
  ['yield=0, no better priority',   { schedA: 8, schedB: 16 }],
];
if (haveTrace) {
  console.log('\n=== A. differential: paths where SelectThread RETURNS ===');
  const hleA = await hleInst(), trcA = await orcInst();
  for (const [name, opts] of SCENARIOS) {
    const runs = [hleA, trcA].map((E) => {
      stage(E, opts); setRegs(E, { r3: 0 }); E.M._sr_os_trace_reset();
      E.M._sr_os_set_msr(MSR0); E.M._sr_os_bind_self(THREAD_A);
      const f = E.M._sr_call(SelectThread) >>> 0;
      return { f, r: snapRegs(E), h: memHash(E), msr: E.M._sr_os_get_msr() >>> 0 };
    });
    const [H, T] = runs;
    const regsSame = JSON.stringify(H.r) === JSON.stringify(T.r);
    ok(`A: ${name} — fault`, H.f === T.f && H.f === 0,
       `hle=0x${H.f.toString(16)} trace=0x${T.f.toString(16)}`);
    ok(`A: ${name} — GekkoState identical`, regsSame,
       regsSame ? '' : `\n      hle  ${JSON.stringify(H.r)}\n      orac ${JSON.stringify(T.r)}`);
    ok(`A: ${name} — MEM1 identical`, H.h === T.h,
       `hle=0x${H.h.toString(16)} trace=0x${T.h.toString(16)}`);
    ok(`A: ${name} — MSR identical`, H.msr === T.msr,
       `hle=0x${H.msr.toString(16)} trace=0x${T.msr.toString(16)}`);
  }
}

// -------------------------------------------------------- B. the switch path
if (haveTrace) {
  console.log('\n=== B. differential: the SWITCH, frozen at the rfi ===');
  // The oracle build must NOT actually hand off (it has no HLE), so it is run in
  // TRACE mode where OSLoadContext snapshots and returns.  The HLE build hands off
  // for real; its snapshot is taken at the same instant, before ht_post.
  // A must be LOWER priority than B (16 vs 8) or yield=0 refuses to switch at all.
  const hle = await hleInst(), trc = await orcInst();
  const opts = { schedA: 16, schedB: 8, aState: 2 };
  stage(trc, opts); setRegs(trc, { r3: 0 }); trc.M._sr_os_set_msr(MSR0);
  trc.M._sr_os_trace_reset(); trc.M._sr_os_snapshot_reset();
  trc.M._sr_os_bind_self(THREAD_A);
  const tf = trc.M._sr_call(SelectThread) >>> 0;
  const tsnapValid = trc.M._sr_os_snapshot_valid();

  stage(hle, opts); setRegs(hle, { r3: 0 }); hle.M._sr_os_set_msr(MSR0);
  hle.M._sr_os_trace_reset(); hle.M._sr_os_snapshot_reset();
  hle.M._sr_os_bind_self(THREAD_A);
  const hf = hle.M._sr_call(SelectThread) >>> 0;
  const hsnapValid = hle.M._sr_os_snapshot_valid();

  // NOTE on the fault codes printed here: this scenario deliberately does not
  // complete a round trip — thread B's entry (OSWakeupThread on an empty queue)
  // does nothing and returns, which is SR_F_FELL_OFF (0xC506xxxx) by design.  The
  // assertion is about the FROZEN state at the rfi, not about the run finishing.
  ok('B: oracle reached the rfi', tsnapValid === 1, `fault=0x${tf.toString(16)}`);
  ok('B: HLE reached the rfi', hsnapValid === 1, `fault=0x${hf.toString(16)} (0xC506 = B ran off its entry, expected here)`);
  if (tsnapValid && hsnapValid) {
    const rd = (E) => { const p = E.M._sr_os_snapshot();
      const g = []; for (let i = 0; i < 32; i++) g.push(E.M.HEAPU32[(p >> 2) + i] >>> 0);
      const u = (o) => E.M.HEAPU32[(p + 640 + o) >> 2] >>> 0;
      return { gpr: g, cr: u(0), xer: u(4), lr: u(8), ctr: u(12), pc: u(52) }; };
    const R1 = rd(hle), R2s = rd(trc);
    const same = JSON.stringify(R1) === JSON.stringify(R2s);
    ok('B: frozen GekkoState identical', same,
       same ? `pc=0x${R1.pc.toString(16)} r1=0x${R1.gpr[1].toString(16)}`
            : `\n      hle  ${JSON.stringify(R1)}\n      orac ${JSON.stringify(R2s)}`);
    const h1 = hle.M._sr_os_snapshot_hash() >>> 0, h2 = trc.M._sr_os_snapshot_hash() >>> 0;
    ok('B: frozen MEM1 identical', h1 === h2,
       `hle=0x${h1.toString(16)} orac=0x${h2.toString(16)}`);
    eq('B: rfi target is thread B\'s entry', R1.pc >>> 0, OSWakeupThread);
  }
  dumpTrace(trc, 'oracle (translated SelectThread + host context primitives)');
}

// ============================================================ C. THE WITNESS
console.log('\n=== C. WITNESS: A OSSleepThread -> B OSWakeupThread -> A resumes ===');
const hle = await hleInst();
stage(hle, { schedA: 8, schedB: 16, bEntry: OSWakeupThread, bArg: QUEUE });
setRegs(hle, { r1: STACK_A, r3: QUEUE, lr: 0xfeed0000 });
hle.M._sr_os_set_msr(MSR0);
hle.M._sr_os_trace_reset(); hle.M._sr_os_snapshot_reset();
hle.M._sr_os_bind_self(THREAD_A);

const before = snapRegs(hle);
const t0 = Date.now();
const fault = hle.M._sr_call(OSSleepThread) >>> 0;
const dt = Date.now() - t0;
const after = snapRegs(hle);
const rows = dumpTrace(hle, 'HLE round trip');

console.log('');
eq('C: OSSleepThread returned with no fault', fault, 0);
ok('C: it returned at all (the resume unwound correctly)', dt < 3500, `${dt} ms`);
eq('C: __gCurrentThread is back to A', hle.rbe32(G_CURRENT_THREAD), THREAD_A);
eq('C: __OSCurrentContext is back to A', hle.rbe32(OS_CURRENT_CONTEXT), THREAD_A);
eq('C: A is RUNNING again', hle.rbe16(THREAD_A + OSTH.STATE), 2);
eq('C: B is READY', hle.rbe16(THREAD_B + OSTH.STATE), 1);
eq('C: B is back on RunQueue[16]', hle.rbe32(RUNQUEUE + 16 * 8), THREAD_B);
eq('C: RunQueueBits shows only B', hle.rbe32(RQBITS), (1 << (31 - 16)) >>> 0);
eq('C: the sleep queue is empty again', hle.rbe32(QUEUE), 0);
eq('C: A left the sleep queue (queue ptr cleared)', hle.rbe32(THREAD_A + OSTH.QUEUE), 0);
eq('C: A\'s saved srr0 is the OSSaveContext return', hle.rbe32(THREAD_A + OSCTX.SRR0), 0x800ebe6c);
eq('C: A\'s context stamped gpr[3]=1 for the resume', hle.rbe32(THREAD_A + 12), 1);

// Two DISTINCT host threads really ran.
eq('C: host slot 0 ran thread A', hle.M._sr_os_slot_thread(0) >>> 0, THREAD_A);
eq('C: host slot 1 ran thread B', hle.M._sr_os_slot_thread(1) >>> 0, THREAD_B);
eq('C: slot 1 was started', hle.M._sr_os_slot_started(1), 1);
const tid0 = hle.M._sr_os_slot_tid(0) >>> 0, tid1 = hle.M._sr_os_slot_tid(1) >>> 0;
ok('C: the two guest threads ran on DIFFERENT host threads', tid0 !== tid1 && tid1 !== 0,
   `tid0=0x${tid0.toString(16)} tid1=0x${tid1.toString(16)}`);

// The register proof.  B's context stages r14..r31 as 0xBB0000rr and B's translated
// code runs with them; if A comes back with 0xAA0000rr, the save/restore was real.
let regsRestored = true, firstBad = '';
for (let r = 14; r < 32; r++) {
  if (r === 30 || r === 31) continue;            // callee-saved through the frames
  if (after.gpr[r] !== before.gpr[r]) {
    regsRestored = false;
    if (!firstBad) firstBad = `r${r}: 0x${after.gpr[r].toString(16)} != 0x${before.gpr[r].toString(16)}`;
  }
}
ok('C: A\'s r14..r29 survived the round trip through B', regsRestored, firstBad);
eq('C: r30 restored by the epilogues', after.gpr[30] >>> 0, before.gpr[30] >>> 0);
eq('C: r31 restored by the epilogues', after.gpr[31] >>> 0, before.gpr[31] >>> 0);
eq('C: stack pointer restored', after.gpr[1] >>> 0, STACK_A);
eq('C: LR restored', after.lr >>> 0, 0xfeed0000);

// The trace must contain the switch in BOTH directions.
const ev = rows.map((r) => r[0]);
ok('C: two SELECT_SAVEs (A then B)', ev.filter((e) => e === 11).length === 2);
ok('C: two HANDOFFs', ev.filter((e) => e === 12).length === 2);
ok('C: B\'s host thread was started', ev.includes(13) && ev.includes(16));
ok('C: A was RESUMED on its own host thread', ev.includes(14));
const h1 = rows.find((r) => r[0] === 12), h2 = rows.filter((r) => r[0] === 12)[1];
if (h1 && h2) {
  eq('C: first handoff is A -> B', h1[1] >>> 0, THREAD_A);
  eq('C: first handoff target is B', h1[2] >>> 0, THREAD_B);
  eq('C: second handoff is B -> A', h2[1] >>> 0, THREAD_B);
  eq('C: second handoff target is A', h2[2] >>> 0, THREAD_A);
}

// ============================================ E. THREE THREADS, NON-LIFO
// Two threads can be explained away as nesting: B could have run on A's stack and
// returned.  A rotation cannot.  A sleeps, B sleeps, C wakes both and the scheduler
// picks A — so A resumes while B is STILL PARKED, which a single-stack scheme cannot
// do: resuming A on one stack would have to discard B's frames.
console.log('\n=== E. ROTATION: A -> B -> C -> A, with B still parked ===');
{
  const THREAD_C = 0x80303000, STACK_C = 0x8032ff00;
  const E = await hleInst();
  stage(E, { schedA: 8, schedB: 16, bEntry: OSSleepThread, bArg: QUEUE });
  // add C at priority 24, READY on RunQueue[24], entry = OSWakeupThread(&q)
  E.wbe16(THREAD_C + OSTH.STATE, 1);
  E.wbe16(THREAD_C + OSTH.ATTR, 1);
  E.wbe32(THREAD_C + OSTH.PRIORITY, 24);
  E.wbe32(THREAD_C + OSTH.BASE, 24);
  E.wbe32(THREAD_C + OSTH.QUEUE, RUNQUEUE + 24 * 8);
  E.wbe32(RUNQUEUE + 24 * 8 + 0, THREAD_C);
  E.wbe32(RUNQUEUE + 24 * 8 + 4, THREAD_C);
  E.wbe32(RQBITS, ((1 << (31 - 16)) | (1 << (31 - 24))) >>> 0);
  E.wbe32(THREAD_C + OSCTX.SRR0, OSWakeupThread);
  E.wbe32(THREAD_C + OSCTX.SRR1, MSR0);
  E.wbe32(THREAD_C + 4, STACK_C);
  E.wbe32(THREAD_C + 8, R2);
  E.wbe32(THREAD_C + 12, QUEUE);
  E.wbe32(THREAD_C + 13 * 4, R13);
  for (let r = 14; r < 32; r++) E.wbe32(THREAD_C + r * 4, (0xcc000000 | r) >>> 0);

  setRegs(E, { r1: STACK_A, r3: QUEUE, lr: 0xfeed0000 });
  E.M._sr_os_set_msr(MSR0); E.M._sr_os_trace_reset(); E.M._sr_os_bind_self(THREAD_A);
  const b4 = snapRegs(E);
  const t = Date.now();
  const f = E.M._sr_call(OSSleepThread) >>> 0;
  const ms = Date.now() - t;
  const rows2 = dumpTrace(E, 'rotation');
  const ev2 = rows2.map((r) => r[0]);
  const hand = rows2.filter((r) => r[0] === 12);
  console.log('');
  eq('E: OSSleepThread returned with no fault', f, 0);
  ok('E: it returned (no deadlock)', ms < 3500, `${ms} ms`);
  ok('E: three SELECT_SAVEs (A, B, C)', ev2.filter((e) => e === 11).length === 3);
  ok('E: three HANDOFFs', hand.length === 3);
  if (hand.length === 3) {
    eq('E: A -> B', hand[0][2] >>> 0, THREAD_B);
    eq('E: B -> C', hand[1][2] >>> 0, THREAD_C);
    eq('E: C -> A', hand[2][2] >>> 0, THREAD_A);
  }
  const tids = [0, 1, 2].map((i) => E.M._sr_os_slot_tid(i) >>> 0);
  ok('E: three DISTINCT host threads', new Set(tids).size === 3, tids.map((x) => '0x' + x.toString(16)).join(' '));
  eq('E: __gCurrentThread is A', E.rbe32(G_CURRENT_THREAD), THREAD_A);
  eq('E: A is RUNNING', E.rbe16(THREAD_A + OSTH.STATE), 2);
  eq('E: B was woken and is READY', E.rbe16(THREAD_B + OSTH.STATE), 1);
  eq('E: C is READY', E.rbe16(THREAD_C + OSTH.STATE), 1);
  eq('E: the sleep queue is empty', E.rbe32(QUEUE), 0);
  eq('E: RunQueueBits = B(16) | C(24)', E.rbe32(RQBITS),
     ((1 << (31 - 16)) | (1 << (31 - 24))) >>> 0);
  let rr = true, bad = '';
  for (let r = 14; r < 30; r++) if (snapRegs(E).gpr[r] !== b4.gpr[r]) {
    rr = false; if (!bad) bad = `r${r}`;
  }
  ok('E: A\'s r14..r29 survived TWO intervening threads', rr, bad);
}

// ================================================ D. the CONTROL ARM
// The same run with the host layer switched OFF must reproduce, exactly, the fault
// this whole exercise started from: gamecube/docs/static-recomp-sab/README.md:1252
// records `SKIP 0x800f13a8 faults 0xe00e78ac` on the whole-image build.  0xE0 is
// sr_extern's prefix and the low 24 bits are the callee, so
//   0xE0000000 | (0x800e78ac & 0x00FFFFFF) = 0xE0000000 | 0x0E78AC = 0xE00E78AC
// i.e. an unresolved direct call to OSDisableInterrupts.  If mode OFF does NOT
// produce it, the pass above proves nothing about the host layer being load-bearing.
console.log('\n=== D. CONTROL: host layer OFF must reproduce the documented fault ===');
{
  const off = await boot(OUT);
  off.M._sr_os_init(4); off.M._sr_os_mode(0);          // SR_OS_OFF
  stage(off, { schedA: 8, schedB: 16 });
  setRegs(off, { r1: STACK_A, r3: QUEUE });
  const f = off.M._sr_call(OSSleepThread) >>> 0;
  eq('D: OFF faults at 0xe00e78ac (README.md:1252, OSDisableInterrupts)', f, 0xe00e78ac);
  ok('D: and 0xE0 is sr_extern, not a locked-cache address',
     ((f >>> 24) === 0xE0) && ((0xE0000000 | (0x800e78ac & 0x00ffffff)) >>> 0) === f);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
