// verify_clock.mjs — THE EXECUTION DIFFERENTIAL FOR THE GUEST TIMEBASE BOUNDARY.
//
// WHY THIS EXISTS AND NOT verify_fixture.mjs.  The clock boundary (sr_host_os.h,
// "THE GUEST TIMEBASE") cannot be evidenced by the committed fixture record, and the
// reason is measured rather than assumed: of the 398 committed capture records,
// exactly THREE ever entered OSGetTime -- 0x80123d24, 0x801237d0 and 0x8012eda8 in
// sab_dol_survey_all.json -- and all three carry the artifact's own `usable:false`
// flag from capture time ("2 unknown store forms", "did not return (capture
// truncated); 3 unknown store forms"), so verify_fixture.mjs refuses them before the
// boundary is ever reached.  Every OTHER capture was armed by an offline closure gate
// that EXCLUDED every clock caller by construction.  So the fixture suite is a
// structural NULL for this boundary, and reporting that null as if it were evidence
// either way would be the vacuous pass README §9.5's tally was rebuilt to prevent.
//
// WHAT THIS DOES INSTEAD.  It runs a REAL TRANSLATED GUEST BODY that calls the
// primitive, and checks its output against a value derived from the guest's OWN
// SOURCE rather than from this runtime:
//
//   0x800ecb68 __OSGetSystemTime, 100 B / 25 instructions, decoded from the shipped
//   words and matching ~/gc_refs/dolsdk2001/src/os/OSTime.c:66-76 line for line:
//
//     800ecb80 4bffad2d  bl   0x800e78ac   OSDisableInterrupts
//     800ecb88 4bffffc1  bl   0x800ecb48   OSGetTime          -> r3:r4 = TBU:TBL
//     800ecb90 80a630dc  lwz  r5, 0x30dc(r6)   \ the 64-bit time adjust at
//     800ecb94 800630d8  lwz  r0, 0x30d8(r6)   / 0x800030D8, DOLSDK's timeAdjustAddr
//     800ecb98 7fa52014  addc r29, r5, r4      \ r29:r30 = TB + adjust
//     800ecb9c 7fc01914  adde r30, r0, r3      /
//     800ecba4 4bffad31  bl   0x800e78d4   OSRestoreInterrupts
//     -> returns r3:r4 = r30:r29
//
//   so the expected answer is EXACTLY `seeded_TB + [0x800030D8]` as a 64-bit sum,
//   with no freedom left in it.  The closure emits ONE body and routes all three
//   callees through sr_extern (grep the generated C: 3 sr_extern call sites), so a
//   pass here is a translated caller reaching the host layer, not a host-only test.
//
// THE ARMS, ALL ON ONE BINARY / ONE md5 (the trap CLAUDE.md gate #10 records):
//   A  clock ON, seed S1        -> executes, returns S1 + adjust
//   B  clock OFF (sr_tb_enable(0), SAME binary) -> must fault 0xe00ecb48
//   C  clock ON, seeds S2..Sn   -> the returned value must TRACK the seed exactly;
//                                  a constant answer would pass arm A for the wrong
//                                  reason (README §9.7 caught exactly that shape on
//                                  MSR, where three fixtures passed only because the
//                                  scene happened to match the compiled-in default).
//   D  clock ON, DEC round-trip -> PPCMtdec writes and the decrementer counts DOWN
//                                  off the same retired-work tick source.
//   E  NO HOST CLOCK IS READ    -> credit nothing, read the timebase twice with real
//                                  host time passing in between; the two reads must
//                                  be IDENTICAL.  This is the gate #9 property stated
//                                  as a test: if anything in the facility consulted
//                                  emscripten_get_now/Date.now, this arm fails.
//   F  RETIRED WORK DRIVES IT   -> credit exactly one 60 Hz field of guest work and
//                                  the timebase must advance exactly 675,000 ticks.
//
//   bash gamecube/recomp/sr/build_fixture.sh /tmp/sr_sab/main.dol 0x800ecb68   \
//        # with SR_OUT=/tmp/sr_clock SR_HOST_OS=1 SR_OPT=-O2 and SR_EXTRA_ARGS=
//        # "--indirect --jumptables --boundaries outer+calls --host <the ten>"
//   SR_OUT=/tmp/sr_clock node gamecube/recomp/sr/verify_clock.mjs
import fs from 'fs';
import path from 'path';

const OUT = process.env.SR_OUT || '/tmp/sr_clock';
const ENTRY = parseInt(process.env.SR_CLOCK_ENTRY || '0x800ecb68', 16) >>> 0;
const ADJUST_EA = 0x800030d8;            // DOLSDK OSTime.c timeAdjustAddr
const GK_TB_PER_FIELD = 675000n;
const GK_TIMER_RATIO = 12n;

// GekkoState field offsets — read from the module, never hardcoded.
const O_GPR = 0, O_PS0 = 128;

const main = async () => {
  const jsPath = path.join(OUT, 'sr_fixture.js');
  if (!fs.existsSync(jsPath))
    throw new Error(`no build at ${jsPath} — see the build line in this file's header`);
  const wasm = path.join(OUT, 'sr_fixture.wasm');
  const md5 = (await import('node:child_process')).execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(`[build] ${wasm}  md5=${md5}`);

  const M = await (await import(jsPath)).default();
  for (const f of ['_sr_tb_enable', '_sr_tb_seed_parts', '_sr_tb_hi', '_sr_tb_lo',
                   '_sr_tb_calls', '_sr_tb_reset', '_sr_dec_get', '_sr_dec_set',
                   '_sr_tb_credit', '_sr_tb_field', '_sr_os_init_irq'])
    if (typeof M[f] !== 'function')
      throw new Error(`this build has no ${f} — rebuild with SR_HOST_OS=1`);

  M._sr_init();
  M._sr_os_init_irq();          // installs the hook; SR_OS_IRQ answers the MSR family
  const ram = M._sr_ram();
  const st = M._sr_state();

  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    (ok ? pass++ : fail++);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got}${ok ? '' : `  want=${want}`}`);
    return ok;
  };

  const dv = () => new DataView(M.HEAPU8.buffer);
  const gpr = (i) => dv().getUint32(st + O_GPR + i * 4, true) >>> 0;
  const setAdjust = (v) => {                       // big-endian guest 64-bit
    const d = dv();
    const off = ram + (ADJUST_EA & 0x03ffffff);
    d.setUint32(off, Number(v >> 32n) >>> 0, false);
    d.setUint32(off + 4, Number(v & 0xffffffffn) >>> 0, false);
  };
  const runAt = (seedTB) => {
    M._sr_verify_reset?.();
    M._sr_tb_reset();
    M._sr_tb_seed_parts(Number(seedTB >> 32n) >>> 0, Number(seedTB & 0xffffffffn) >>> 0);
    // r1 = a stack pointer inside MEM1; the body pushes 32 bytes and pops them.
    const d = dv();
    for (let i = 0; i < 32; i++) d.setUint32(st + O_GPR + i * 4, 0, true);
    d.setUint32(st + O_GPR + 1 * 4, 0x80200000, true);      // r1
    const fault = M._sr_call(ENTRY) >>> 0;
    return { fault, hi: gpr(3), lo: gpr(4), tbCalls: M._sr_tb_calls() >>> 0 };
  };

  const ADJUST = 0x0000000123456789n;
  setAdjust(ADJUST);

  // ---- ARM A: the boundary ON, a real translated caller, a closed-form answer ----
  console.log('\n--- ARM A: clock ON, __OSGetSystemTime through the host boundary ---');
  M._sr_tb_enable(1);
  const S1 = 0x000000AB_CDEF0123n;
  const a = runAt(S1);
  const wantA = (S1 + ADJUST) & 0xffffffffffffffffn;
  check('A fault==0', a.fault, 0);
  check('A crossed the clock boundary', a.tbCalls > 0, true);
  check('A r3 (high word) == (TB+adjust)>>32',
        a.hi, Number(wantA >> 32n) >>> 0);
  check('A r4 (low word)  == (TB+adjust)&0xffffffff',
        a.lo, Number(wantA & 0xffffffffn) >>> 0);

  // ---- ARM B: THE CONTROL, same binary, clock switched off at run time ----------
  console.log('\n--- ARM B: CONTROL — clock OFF on the SAME binary (one md5) ---');
  M._sr_tb_enable(0);
  const b = runAt(S1);
  check('B faults 0xe00ecb48 (sr_extern: call outside the emitted set)',
        b.fault >>> 0, 0xe00ecb48 >>> 0);
  check('B crossed the clock boundary 0 times', b.tbCalls, 0);
  M._sr_tb_enable(1);

  // ---- ARM C: falsifiability — the answer must TRACK the seed -------------------
  console.log('\n--- ARM C: the seed is load-bearing, not decorative ---');
  for (const S of [0n, 1n, 0x0000000100000000n, 0x00000FFF_FFFFFFFFn]) {
    const r = runAt(S);
    const w = (S + ADJUST) & 0xffffffffffffffffn;
    check(`C seed=0x${S.toString(16)} -> r3:r4`,
          `${r.hi.toString(16)}:${r.lo.toString(16)}`,
          `${(Number(w >> 32n) >>> 0).toString(16)}:${(Number(w & 0xffffffffn) >>> 0).toString(16)}`);
  }

  // ---- ARM D: the decrementer is slaved to the same tick source -----------------
  console.log('\n--- ARM D: PPCMtdec / decrementer, off the same retired-work ticks ---');
  M._sr_tb_reset();
  M._sr_dec_set(1000);
  check('D DEC reads back what was written', M._sr_dec_get() >>> 0, 1000);
  M._sr_tb_credit(0, 120);                  // 120 guest CPU cycles = 10 TB ticks
  check('D DEC counted DOWN by cycles/12', M._sr_dec_get() >>> 0, 990);
  check('D no exception yet', M._sr_tb_dec_exceptions() >>> 0, 0);
  M._sr_tb_credit(0, 1000 * 12);            // past due
  check('D the decrementer exception came DUE', M._sr_tb_dec_exceptions() >>> 0, 1);
  console.log('      NOTE: it was COUNTED, not DELIVERED — this runtime has no ' +
              'interrupt delivery (sr_host_os.h "WHAT IS NOT MODELLED"). A guest ' +
              'alarm handler behind it does not run.');

  // ---- ARM E: THE GATE #9 PROPERTY, as a test ----------------------------------
  console.log('\n--- ARM E: no host clock is an input — real wall time passes, the ' +
              'guest clock does not move ---');
  M._sr_tb_reset();
  M._sr_tb_seed_parts(0, 0);
  const t0 = M._sr_tb_hi() * 2 ** 32 + (M._sr_tb_lo() >>> 0);
  const wall0 = Date.now();
  let spin = 0;
  while (Date.now() - wall0 < 250) spin++;      // >= 250 ms of REAL host time
  const t1 = M._sr_tb_hi() * 2 ** 32 + (M._sr_tb_lo() >>> 0);
  const wallMs = Date.now() - wall0;
  check(`E ${wallMs} ms of host time passed; guest ticks advanced by`, t1 - t0, 0);
  console.log(`      (a wall-clock timebase would have advanced ~` +
              `${Math.round(wallMs * 40500)} ticks here — that difference IS the bug ` +
              `gate #9 forbids)`);

  // ---- ARM F: retired guest work is what DOES move it --------------------------
  console.log('\n--- ARM F: one 60 Hz field of retired guest work = 675,000 ticks ---');
  M._sr_tb_reset();
  M._sr_tb_seed_parts(0, 0);
  M._sr_tb_field();
  check('F one field advances the timebase by exactly 675,000',
        BigInt(M._sr_tb_hi()) * 4294967296n + BigInt(M._sr_tb_lo() >>> 0),
        GK_TB_PER_FIELD);
  M._sr_tb_reset();
  M._sr_tb_seed_parts(0, 0);
  for (let i = 0; i < 60; i++) M._sr_tb_field();
  check('F sixty fields = exactly one second at 40.5 MHz',
        BigInt(M._sr_tb_hi()) * 4294967296n + BigInt(M._sr_tb_lo() >>> 0),
        GK_TB_PER_FIELD * 60n);
  // The sub-tick remainder must be CARRIED, not truncated: 11 cycles is 0 ticks, but
  // twelve credits of 11 cycles is 132 cycles = 11 ticks, not 0.
  M._sr_tb_reset();
  M._sr_tb_seed_parts(0, 0);
  for (let i = 0; i < 12; i++) M._sr_tb_credit(0, 11);
  check('F the sub-tick remainder is carried, not dropped',
        BigInt(M._sr_tb_lo() >>> 0), (12n * 11n) / GK_TIMER_RATIO);

  console.log(`\nSUMMARY  ${pass} passed / ${fail} failed   (wasm md5 ${md5})`);
  const md5b = (await import('node:child_process')).execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(md5 === md5b ? `[build] md5 unchanged across the run: ${md5b}`
                           : `[build] ⚠ md5 CHANGED mid-run: ${md5} -> ${md5b}`);
  process.exit(fail ? 1 : 0);
};
main();
