// verify_cache.mjs — THE EXECUTION DIFFERENTIAL FOR THE CACHE-MAINTENANCE BOUNDARY.
//
// WHY THIS EXISTS AND NOT verify_fixture.mjs.  Same structural reason as
// verify_clock.mjs: the committed capture record cannot speak to this boundary,
// because the offline closure gate that ARMED every one of those captures refused
// any function whose closure reached a cache op.  Every DCFlushRange / DCStoreRange /
// DCInvalidateRange caller was excluded BY CONSTRUCTION, so the fixture suite is a
// structural NULL here and quoting its silence as a pass would be vacuous.
//
// WHAT THIS DOES INSTEAD.  It runs the SDK's REAL TRANSLATED BODIES and checks them
// against an expectation derived from ~/gc_refs/dolsdk2001/src/os/OSCache.c and
// OSSync.c rather than from this runtime.  Five entries, all leaves, all emitted:
//
//   0x800e4e1c DCInvalidateRange  OSCache.c:87-104   dcbi  loop, no `sc`
//   0x800e4e4c DCFlushRange       OSCache.c:107-125  dcbf  loop + `sc`
//   0x800e4e80 DCStoreRange       OSCache.c:127-146  dcbst loop + `sc`
//   0x800e34c4 PPCSync            `sc; blr`          the bare vector
//   0x8014b504 (LC tag allocator) dcbi + dcbz_l x9   THE POSITIVE CONTROL
//
// THE TRAP THIS IS BUILT TO AVOID.  Four of the five arms assert that memory did NOT
// change, and "nothing happened" is exactly the shape of a VACUOUS null — it passes
// just as well when the body never ran, when the harness is looking at the wrong
// bytes, or when the region was already what it was compared against.  So every
// no-change arm is paired with two independent liveness proofs on the SAME binary:
//
//   1. THE REGISTER TAIL.  The loops are counted: they leave r3 advanced by 32 per
//      line, r4 = the line count, r5 = the low-5-bits test, CTR = 0 and CR0 set.  A
//      body that did not run leaves the inputs.  These are the same registers
//      verify_fixture.mjs scores (:521-543), and they are why the cache functions are
//      TRANSLATED rather than host-bound: a stub that "does nothing" would freeze
//      every one of them.
//   2. THE POSITIVE CONTROL, 0x8014b504, in the SAME wasm with the SAME md5.  It is a
//      dcbi + dcbz_l loop over the locked cache, so it MUST zero memory in exactly the
//      region the other arms say is untouched.  If the harness could not observe a
//      guest store at all, that arm fails and the four nulls mean nothing.
//
// And `sc` gets its own falsifiability arm: the DOLSDK vector (OSSync.c:9-21) is
// `mfspr r9,HID0 / ori r10,r9,8 / ... / rfi`, so r9 and r10 must TRACK HID0 rather
// than being a constant that happens to match the boot value.
//
//   SR_OUT=/tmp/sr_cache SR_OPT=-O2 \
//   SR_EXTRA_ARGS="--indirect --jumptables --boundaries outer+calls" \
//   bash gamecube/recomp/sr/build_fixture.sh /tmp/sr_sab/main.dol \
//        0x800e4e1c 0x800e4e4c 0x800e4e80 0x800e34c4 0x8014b504 0x800e4f14
//   SR_OUT=/tmp/sr_cache node gamecube/recomp/sr/verify_cache.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

const OUT = process.env.SR_OUT || '/tmp/sr_cache';
const A = {
  DCInvalidateRange: 0x800e4e1c,
  DCFlushRange:      0x800e4e4c,
  DCStoreRange:      0x800e4e80,
  ICInvalidateRange: 0x800e4f14,
  PPCSync:           0x800e34c4,
  LCAllocTags:       0x8014b504,
};
// GekkoState offsets — the same constants verify_fixture.mjs:46-47 uses, and the
// build asserts them against sizeof(GekkoState) below rather than trusting them.
const O_GPR = 0, O_CR = 640, O_CTR = 652, SZ = 696;
const LC_BASE = 0xe0000000;            // gekko_rt.h: real backing memory, not a mask
const LC_GUARD_EA = 0x80394ce8;        // 0x8014b50c `lwz r0,40(r5)`, r5 = 0x80394cc0
const LC_GUARD_BIT = 0x10000000;       // 0x8014b510 `rlwinm. r0,r0,0,3,3`

const main = async () => {
  const jsPath = path.join(OUT, 'sr_fixture.js');
  if (!fs.existsSync(jsPath))
    throw new Error(`no build at ${jsPath} — see the build line in this file's header`);
  const wasm = path.join(OUT, 'sr_fixture.wasm');
  const md5 = execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(`[build] ${wasm}  md5=${md5}`);

  const M = await (await import(jsPath)).default();
  for (const f of ['_sr_hid0', '_sr_set_hid0'])
    if (typeof M[f] !== 'function')
      throw new Error(`this build has no ${f} — rebuild, build_fixture.sh exports it`);
  M._sr_init();
  const ram = M._sr_ram(), st = M._sr_state();
  const RAM_SIZE = M._sr_ram_size() >>> 0, TAIL = M._sr_tail_size() >>> 0;

  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = (typeof got === 'bigint' || typeof want === 'bigint')
      ? BigInt(got) === BigInt(want) : got === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got}${ok ? '' : `  want=${want}`}`);
    return ok;
  };
  const dv = () => new DataView(M.HEAPU8.buffer);
  const gpr = (i) => dv().getUint32(st + O_GPR + i * 4, true) >>> 0;
  const setGpr = (i, v) => dv().setUint32(st + O_GPR + i * 4, v >>> 0, true);
  if ((M._sr_state_size() | 0) !== SZ)
    throw new Error(`GekkoState is ${M._sr_state_size()} B, not ${SZ} — the field ` +
                    `offsets in this file are stale, re-derive them before trusting it`);
  const cr0 = () => (dv().getUint32(st + O_CR, true) >>> 28) & 0xf;
  const ctr = () => dv().getUint32(st + O_CTR, true) >>> 0;

  // Byte helpers.  gk_phys masks 26 bits, so the locked cache lives PAST g_ram_size in
  // the tail buffer (gekko_rt.h GK_TAIL) — this maps the same way the runtime does.
  const off = (ea) => ((ea >>> 0) >= LC_BASE && (ea >>> 0) < LC_BASE + 0x40000)
    ? RAM_SIZE + ((ea >>> 0) - LC_BASE) : ((ea >>> 0) & 0x03ffffff);
  const fill = (ea, n, seed) => {
    const h = M.HEAPU8, b = ram + off(ea);
    for (let i = 0; i < n; i++) h[b + i] = (seed + i * 7) & 0xff;
  };
  const snap = (ea, n) => Buffer.from(M.HEAPU8.subarray(ram + off(ea), ram + off(ea) + n));
  const same = (a, b) => Buffer.compare(a, b) === 0;

  // run(addr, r3, r4) with the whole register file zeroed first, so every non-zero
  // output register is something the BODY wrote.
  const run = (addr, r3, r4) => {
    const d = dv();
    for (let i = 0; i < 32; i++) d.setUint32(st + O_GPR + i * 4, 0, true);
    d.setUint32(st + O_CR, 0, true);
    d.setUint32(st + O_CTR, 0, true);
    setGpr(1, 0x80200000); setGpr(3, r3); setGpr(4, r4);
    const fault = M._sr_call(addr >>> 0) >>> 0;
    return { fault, r3: gpr(3), r4: gpr(4), r5: gpr(5), r9: gpr(9), r10: gpr(10),
             ctr: ctr(), cr0: cr0() };
  };

  console.log(`[mem] MEM1 ${RAM_SIZE} B + tail ${TAIL} B (locked cache @ ${LC_BASE.toString(16)})`);

  // ---------------------------------------------------------------------------
  // ARM 1 — the three range ops leave MEMORY untouched, and their REGISTER TAIL
  //          proves the loop ran.  OSCache.c: lines = ((n + (addr&31 ? 32 : 0)) + 31)
  //          >> 5; r3 ends at addr + 32*lines; r5 = addr & 31; CTR ends 0.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM 1: dcbi / dcbf / dcbst change no memory, but DO run ---');
  const EA = 0x80300000, N = 256;
  const lines = ((N + ((EA & 31) ? 32 : 0)) + 31) >> 5;
  for (const [name, addr] of [['DCInvalidateRange', A.DCInvalidateRange],
                              ['DCFlushRange', A.DCFlushRange],
                              ['DCStoreRange', A.DCStoreRange],
                              ['ICInvalidateRange', A.ICInvalidateRange]]) {
    fill(EA, N, 0x5a);
    const before = snap(EA, N);
    const r = run(addr, EA, N);
    const after = snap(EA, N);
    check(`${name} fault==0`, r.fault, 0);
    check(`${name} leaves all ${N} bytes byte-identical`, same(before, after), true);
    check(`${name} r3 advanced to addr + 32*${lines}`, r.r3, (EA + 32 * lines) >>> 0);
    check(`${name} r4 == line count`, r.r4, lines);
    check(`${name} r5 == addr & 31 (the clrlwi. test)`, r.r5, EA & 31);
    check(`${name} CTR ran to 0`, r.ctr, 0);
  }

  // The early-out arms: OSCache.c:89-90 `cmplwi nBytes,0 / blelr`.  n == 0 must touch
  // nothing AND leave r3/r4 as passed — a body that ran the loop anyway would not.
  console.log('\n--- ARM 1b: the n==0 early-out (OSCache.c:89-90 cmplwi/blelr) ---');
  for (const [name, addr] of [['DCInvalidateRange', A.DCInvalidateRange],
                              ['DCFlushRange', A.DCFlushRange]]) {
    const r = run(addr, EA, 0);
    check(`${name}(addr,0) returns with r3 untouched`, r.r3, EA >>> 0);
    check(`${name}(addr,0) returns with r4 == 0`, r.r4, 0);
  }

  // Unaligned start: OSCache.c:91-93 adds a whole extra line when addr & 31.
  console.log('\n--- ARM 1c: the unaligned-start correction (OSCache.c:91-93) ---');
  {
    const ua = EA + 8, l2 = ((N + 32) + 31) >> 5;
    const r = run(A.DCFlushRange, ua, N);
    check('DCFlushRange(addr&31 != 0) adds one line', r.r4, l2);
    check('DCFlushRange(unaligned) r5 == 8', r.r5, 8);
  }

  // ---------------------------------------------------------------------------
  // ARM 2 — `sc`.  DOLSDK's vector clobbers r9 and r10 and restores HID0.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM 2: `sc` = the DOLSDK 0xC00 vector (OSSync.c:9-21) ---');
  const hid0Boot = M._sr_hid0() >>> 0;
  check('HID0 seeded with the BS2 boot value (Boot_BS2Emu.cpp:85)', hid0Boot, 0x0011c464);
  {
    const r = run(A.PPCSync, 0, 0);
    check('PPCSync fault==0', r.fault, 0);
    check('PPCSync r9 == HID0', r.r9, hid0Boot);
    check('PPCSync r10 == HID0 | ABE(0x8)', r.r10, (hid0Boot | 8) >>> 0);
    check('PPCSync leaves HID0 net unchanged', M._sr_hid0() >>> 0, hid0Boot);
  }
  {
    const r = run(A.DCFlushRange, EA, N);
    check('DCFlushRange carries the sc clobber out to its caller (r9)', r.r9, hid0Boot);
    check('DCFlushRange carries the sc clobber out to its caller (r10)',
          r.r10, (hid0Boot | 8) >>> 0);
    const q = run(A.DCInvalidateRange, EA, N);
    check('DCInvalidateRange has NO sc, so r9 stays 0', q.r9, 0);
    check('DCInvalidateRange has NO sc, so r10 stays 0', q.r10, 0);
  }
  // FALSIFIABILITY: r9/r10 must TRACK HID0, not be a constant that matches the default.
  console.log('\n--- ARM 2b: the answer tracks HID0 — a constant would pass 2 wrongly ---');
  for (const v of [0x00000000, 0x0011c464, 0xdeadbe00, 0xffffffff]) {
    M._sr_set_hid0(v);
    const r = run(A.PPCSync, 0, 0);
    check(`HID0=0x${(v >>> 0).toString(16)} -> r9:r10`,
          `${r.r9.toString(16)}:${r.r10.toString(16)}`,
          `${(v >>> 0).toString(16)}:${((v | 8) >>> 0).toString(16)}`);
  }
  M._sr_set_hid0(hid0Boot);

  // ---------------------------------------------------------------------------
  // ARM 3 — THE POSITIVE CONTROL.  Same binary, same md5.  dcbz_l is a REAL store.
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM 3: POSITIVE CONTROL — dcbz_l zeroes the locked cache ---');
  {
    // The guard at 0x8014b50c/:510 gates the whole body on a bit in a global.
    const d = dv();
    d.setUint32(ram + off(LC_GUARD_EA), 0, false);      // big-endian guest word
    fill(LC_BASE, 512, 0x33);
    const beforeOff = snap(LC_BASE, 512);
    const g0 = run(A.LCAllocTags, LC_BASE, 256);
    check('guard CLEAR: fault==0', g0.fault, 0);
    check('guard CLEAR: beqlr- taken, memory untouched',
          same(beforeOff, snap(LC_BASE, 512)), true);

    d.setUint32(ram + off(LC_GUARD_EA), LC_GUARD_BIT, false);
    fill(LC_BASE, 512, 0x33);
    const before = snap(LC_BASE, 512);
    const g1 = run(A.LCAllocTags, LC_BASE, 256);
    const after = snap(LC_BASE, 512);
    check('guard SET: fault==0', g1.fault, 0);
    check('guard SET: the first 256 bytes are ZEROED by dcbz_l',
          after.subarray(0, 256).every((b) => b === 0), true);
    check('guard SET: byte 256.. is NOT touched (the loop is bounded)',
          same(before.subarray(256), after.subarray(256)), true);
    check('guard SET: this proves the harness CAN see a guest store', same(before, after), false);
    check('guard SET: r5 walked 256 bytes of tags', g1.r5, 256);
  }

  // ---------------------------------------------------------------------------
  // ARM 4 — the locked cache is REAL MEMORY, not an alias of MEM1 offset 0.
  //          (gekko_rt.h: gk_phys would fold 0xE0000030 onto MEM1 0x30.)
  // ---------------------------------------------------------------------------
  console.log('\n--- ARM 4: dcbz_l did not fold into MEM1 low memory ---');
  {
    const d = dv();
    for (let i = 0; i < 256; i++) M.HEAPU8[ram + i] = 0xa5;
    d.setUint32(ram + off(LC_GUARD_EA), LC_GUARD_BIT, false);
    run(A.LCAllocTags, LC_BASE, 256);
    check('MEM1 offset 0..255 untouched by a locked-cache dcbz_l',
          M.HEAPU8.subarray(ram, ram + 256).every((b) => b === 0xa5), true);
  }

  console.log(`\nSUMMARY  ${pass} passed / ${fail} failed   (wasm md5 ${md5})`);
  const md5b = execFileSync('md5', ['-q', wasm]).toString().trim();
  console.log(md5 === md5b ? `[build] md5 unchanged across the run: ${md5b}`
                           : `[build] ⚠ md5 CHANGED mid-run: ${md5} -> ${md5b}`);
  process.exit(fail ? 1 : 0);
};
main();
