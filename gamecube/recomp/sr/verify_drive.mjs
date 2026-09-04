// verify_drive.mjs — THE EXECUTION DIFFERENTIAL FOR THE DRIVE (sr.py --retire).
//
// WHAT A "DRIVE" IS HERE.  f33b3795 landed the guest timebase as a host facility and
// said plainly that no driver was attached in the whole-image build, so the clock was
// FROZEN.  This is the driver, and it is deliberately NOT an event hook: every emitted
// BASIC BLOCK opens with `gk_retire(N)` carrying the summed Gekko cycle cost of its
// instructions, so guest time advances because the GUEST RAN, from the very first
// translated instruction.  That is the same place Dolphin drives its clock from — the
// JIT accumulates `opinfo->num_cycles` per instruction into the block downcount
// (Jit64/Jit.cpp:1003), the interpreter returns it per instruction
// (Interpreter.cpp:193), and CoreTiming::GetTicks()/12 is the timebase
// (SystemTimers.cpp:213-218).
//
// WHY NOT A RETRACE HOOK.  gamecube/recomp/recomp_worker.js holds MP4 at 0.999x with
// exactly one: `viRetrace * 675000n` answers OSGetTime, bumped once per
// VIWaitForRetrace.  It is the right shape and it stays available (sr_tb_retrace()),
// but it cannot be THE drive for this image for two measured reasons.  (1) SAB's
// VIWaitForRetrace is not in dolphin_captures/sab.map at all — grep it — so the
// address would have to be recovered by signature before it could be host-bound.
// (2) The translated DOLSDK body (~/gc_refs/dolsdk2001/src/vi/vi.c) sleeps on
// retraceQueue until a VI INTERRUPT bumps retraceCount, and this runtime has no
// interrupt delivery at all, so it would not complete.  A retrace driver is therefore
// inert until both of those are solved, while a retirement driver is live at
// instruction one — which is where the whole-image build actually is.
//
// ⚠ WHAT THIS DOES NOT CLAIM.  A cycle count is not a cycle-accurate model: Gekko is
// superscalar and Dolphin's num_cycles is a per-opcode constant, not a pipeline
// simulation.  What is claimed, and tested below, is the gate #9 property: guest time
// is a function of guest WORK and of nothing else, at the same 12-cycles-per-tick
// ratio the hardware has, so the guest can be neither sped up nor slowed down by the
// host.  How much WALL time a second of guest time costs is the separate quantity,
// measured outside the guest, that gate #9 calls headroom.
//
//   SR_OUT=/tmp/sr_drive SR_HOST_OS=1 SR_OPT=-O2 \
//   SR_EXTRA_ARGS="--retire --indirect --jumptables --boundaries outer+calls \
//     --host 0x800e78ac --host 0x800e78c0 --host 0x800e78d4 \
//     --host 0x800ecb48 --host 0x800ecb60 --host 0x800e34bc" \
//   bash gamecube/recomp/sr/build_fixture.sh /tmp/sr_sab/main.dol \
//        0x800ecb68 0x800e4e4c 0x800e4e1c 0x800e34c4
//   SR_OUT=/tmp/sr_drive node gamecube/recomp/sr/verify_drive.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

const OUT = process.env.SR_OUT || '/tmp/sr_drive';
const DCFlushRange = 0x800e4e4c;
const OSGetSystemTime = 0x800ecb68;
const O_GPR = 0, O_CR = 640, O_CTR = 652, SZ = 696;

// Gekko clock constants — Dolphin SystemTimers.h:41 / :103, the same three CLAUDE.md
// gate #9 names.  Nothing here is a host-time quantity.
const GK_TIMER_RATIO = 12n;
const GK_TB_HZ = 40500000n;
const GK_CPU_HZ = 486000000n;
const GK_TB_PER_FIELD = 675000n;
const GK_CYCLES_PER_FIELD = 8100000n;

// DCFlushRange's cost, derived from the SHIPPED WORDS + Dolphin's num_cycles table and
// checkable against the emitted gk_retire() calls in sr_gen.c:
//   800e4e4c cmplwi 1 + 800e4e50 blelr  1                       = 2   entry block
//   800e4e54 clrlwi. 1 + 800e4e58 beq   1                       = 2   align test
//   800e4e60 addi 1 + 800e4e64 rlwinm 1 + 800e4e68 mtctr 2      = 4   loop setup
//   800e4e6c dcbf 5 + 800e4e70 addi 1 + 800e4e74 bdnz 1         = 7   PER LINE
//   800e4e78 sc 2 + 800e4e7c blr 1                              = 3   the sc + return
// (mtspr = 2 and dcbf = 5 are Dolphin's, PPCTables.cpp s_table31; sc = 2 is primary.)
const dcFlushCycles = (lines) => 2n + 2n + 4n + 7n * BigInt(lines) + 3n;

const main = async () => {
  const jsPath = path.join(OUT, 'sr_fixture.js');
  if (!fs.existsSync(jsPath))
    throw new Error(`no build at ${jsPath} — see the build line in this file's header`);
  const wasm = path.join(OUT, 'sr_fixture.wasm');
  const md5 = execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(`[build] ${wasm}  md5=${md5}`);

  const M = await (await import(jsPath)).default();
  for (const f of ['_sr_tb_cycles_hi', '_sr_tb_cycles_lo', '_sr_tb_hi', '_sr_tb_lo',
                   '_sr_tb_reset', '_sr_tb_seed_parts', '_sr_tb_stalls', '_sr_tb_calls',
                   '_sr_tb_credit', '_sr_tb_field', '_sr_os_init_irq'])
    if (typeof M[f] !== 'function')
      throw new Error(`this build has no ${f} — rebuild with SR_HOST_OS=1`);
  M._sr_init();
  M._sr_os_init_irq();
  if ((M._sr_state_size() | 0) !== SZ)
    throw new Error(`GekkoState is ${M._sr_state_size()} B, not ${SZ}`);
  const st = M._sr_state();

  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = (typeof got === 'bigint' || typeof want === 'bigint')
      ? BigInt(got) === BigInt(want) : got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got}${ok ? '' : `  want=${want}`}`);
  };
  const dv = () => new DataView(M.HEAPU8.buffer);
  const cycles = () => (BigInt(M._sr_tb_cycles_hi() >>> 0) << 32n)
                     | BigInt(M._sr_tb_cycles_lo() >>> 0);
  const tb = () => (BigInt(M._sr_tb_hi() >>> 0) << 32n) | BigInt(M._sr_tb_lo() >>> 0);
  const run = (addr, r3 = 0, r4 = 0) => {
    const d = dv();
    for (let i = 0; i < 32; i++) d.setUint32(st + O_GPR + i * 4, 0, true);
    d.setUint32(st + O_CR, 0, true); d.setUint32(st + O_CTR, 0, true);
    d.setUint32(st + O_GPR + 4, 0x80200000, true);       // r1, a stack inside MEM1
    d.setUint32(st + O_GPR + 12, r3 >>> 0, true);
    d.setUint32(st + O_GPR + 16, r4 >>> 0, true);
    return M._sr_call(addr >>> 0) >>> 0;
  };

  // ---------------------------------------------------------------------------
  // ARM A — the drive is ATTACHED: executing a guest body advances the counter by
  //         exactly the cycles that body retired, with a closed form to compare to.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM A: guest execution retires cycles, in closed form ---');
  M._sr_tb_reset();
  check('A the counter starts at zero', cycles(), 0n);
  const fault = run(DCFlushRange, 0x80300000, 256);
  check('A DCFlushRange(aligned, 256) fault==0', fault, 0);
  check('A retired exactly 2+2+4+7*8+3 cycles', cycles(), dcFlushCycles(8));

  // THE CONTROL, same binary, same md5: the n==0 early-out runs ONLY the entry block,
  // so it must retire exactly 2 — the difference between the two runs is precisely the
  // work the guest did, and nothing else.
  M._sr_tb_reset();
  run(DCFlushRange, 0x80300000, 0);
  check('A CONTROL: the n==0 early-out retires exactly the entry block', cycles(), 2n);
  console.log('      (same wasm, same md5 — the delta 67 vs 2 IS the loop)');

  // ---------------------------------------------------------------------------
  // ARM B — LINEARITY.  A miscounted or per-function credit cannot track this.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM B: the credit tracks the WORK, line for line ---');
  for (const lines of [1, 2, 8, 64, 1024]) {
    M._sr_tb_reset();
    run(DCFlushRange, 0x80300000, lines * 32);
    check(`B ${lines} cache line(s) -> 11 + 7*${lines} cycles`,
          cycles(), dcFlushCycles(lines));
  }

  // ---------------------------------------------------------------------------
  // ARM C — THE RATIO IS THE HARDWARE'S.  This is gate #9 as arithmetic.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM C: 12 cycles per tick, 486 MHz per 40.5 MHz — exactly ---');
  M._sr_tb_reset(); M._sr_tb_seed_parts(0, 0);
  M._sr_tb_credit(Number(GK_CYCLES_PER_FIELD >> 32n), Number(GK_CYCLES_PER_FIELD & 0xffffffffn));
  check('C one 60 Hz field of guest work = exactly 675,000 ticks', tb(), GK_TB_PER_FIELD);
  M._sr_tb_reset(); M._sr_tb_seed_parts(0, 0);
  M._sr_tb_credit(Number(GK_CPU_HZ >> 32n), Number(GK_CPU_HZ & 0xffffffffn));
  check('C one second of guest CPU work = exactly 40,500,000 ticks', tb(), GK_TB_HZ);
  check('C the ratio is TIMER_RATIO', GK_CPU_HZ / GK_TB_HZ, GK_TIMER_RATIO);

  // ---------------------------------------------------------------------------
  // ARM D — TEST E FROM f33b3795, restated for the driven clock: real host time
  //         passing must move the guest clock by ZERO.  The driver must not have
  //         smuggled a wall clock in.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM D: host time passes; the guest clock does not move ---');
  M._sr_tb_reset(); M._sr_tb_seed_parts(0, 0);
  const c0 = cycles(), t0 = tb();
  const wall0 = Date.now();
  let spin = 0;
  while (Date.now() - wall0 < 250) spin++;
  const wallMs = Date.now() - wall0;
  check(`D ${wallMs} ms of host time -> guest cycles advanced by`, cycles() - c0, 0n);
  check(`D ${wallMs} ms of host time -> guest ticks advanced by`, tb() - t0, 0n);
  console.log(`      (a wall clock would have moved ~${wallMs * 40500} ticks; that ` +
              `difference IS the bug gate #9 forbids)`);

  // ---------------------------------------------------------------------------
  // ARM E — THE HOST'S SPEED IS NOT AN INPUT.  K identical guest calls cost exactly
  //         K times one call, however long the host took to make them, and two
  //         replays of the same work are bit-identical.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM E: determinism, and no speed-up from a faster host ---');
  const oneCall = () => { M._sr_tb_reset(); run(DCFlushRange, 0x80300000, 256); return cycles(); };
  const r1 = oneCall(), r2 = oneCall();
  check('E two replays of the same work are bit-identical', r1, r2);
  for (const K of [1, 10, 500]) {
    M._sr_tb_reset();
    const hostBefore = Date.now();
    for (let i = 0; i < K; i++) run(DCFlushRange, 0x80300000, 256);
    const hostMs = Date.now() - hostBefore;
    check(`E ${K} call(s) cost exactly ${K}x one call (host took ${hostMs} ms)`,
          cycles(), dcFlushCycles(8) * BigInt(K));
  }

  // ---------------------------------------------------------------------------
  // ARM F — THE COMPOSITION.  A REAL TRANSLATED GUEST BODY reads the clock through
  //         the host boundary and sees a value that moved because the guest worked.
  //         0x800ecb68 __OSGetSystemTime returns TB + the 64-bit adjust at 0x800030D8
  //         (~/gc_refs/dolsdk2001/src/os/OSTime.c:66-76), so the answer is closed-form.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM F: the guest reads its own clock and it has ADVANCED ---');
  {
    const ram = M._sr_ram(), d = dv(), off = ram + (0x800030d8 & 0x03ffffff);
    d.setUint32(off, 0, false); d.setUint32(off + 4, 0, false);   // adjust = 0
    M._sr_tb_reset(); M._sr_tb_seed_parts(0, 0);
    run(OSGetSystemTime);
    const first = (BigInt(dv().getUint32(st + O_GPR + 12, true) >>> 0) << 32n)
                | BigInt(dv().getUint32(st + O_GPR + 16, true) >>> 0);
    const cyclesAfterFirst = cycles();
    // Do a known amount of guest work, then ask again.
    run(DCFlushRange, 0x80300000, 1024 * 32);
    run(OSGetSystemTime);
    const second = (BigInt(dv().getUint32(st + O_GPR + 12, true) >>> 0) << 32n)
                 | BigInt(dv().getUint32(st + O_GPR + 16, true) >>> 0);
    const selfCost = cyclesAfterFirst;      // __OSGetSystemTime's own retired cycles
    console.log(`      __OSGetSystemTime itself retires ${selfCost} cycles per call`);
    check('F the second read is LATER than the first', second > first, true);
    check('F and later by exactly (the work + one more clock read) / 12',
          second - first, (dcFlushCycles(1024) + selfCost) / GK_TIMER_RATIO);
  }

  // ---------------------------------------------------------------------------
  // ARM G — THE STALL FAULT STILL MEANS WHAT IT SAYS.  With the drive attached a
  //         guest that polls the clock is NOT stalled — every poll retires work, which
  //         is what real hardware does.  This is a regression test for the guard: it
  //         used to count "reads since the last sr_tb_credit_cycles() call", and
  //         gk_retire() does not call that, so a --retire build would have raised
  //         SR_F_TB_STALL on a perfectly healthy clock after 100,000 reads.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM G: polling the clock is not a stall when work is retiring ---');
  {
    M._sr_tb_reset(); M._sr_tb_seed_parts(0, 0);
    const N = 150000;                       // > SR_TB_STALL_MAX (100,000)
    let f = 0;
    for (let i = 0; i < N; i++) { f = run(OSGetSystemTime); if (f) break; }
    check(`G ${N} guest clock reads, fault`, f, 0);
    check('G ...and zero stalls raised', M._sr_tb_stalls() >>> 0, 0);
    check('G the boundary really was crossed that many times',
          M._sr_tb_calls() >>> 0 >= N, true);
  }

  console.log(`\nSUMMARY  ${pass} passed / ${fail} failed   (wasm md5 ${md5})`);
  const md5b = execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(md5 === md5b ? `[build] md5 unchanged across the run: ${md5b}`
                           : `[build] ⚠ md5 CHANGED mid-run: ${md5} -> ${md5b}`);
  process.exit(fail ? 1 : 0);
};
main();
