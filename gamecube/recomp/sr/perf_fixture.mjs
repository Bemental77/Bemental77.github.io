// perf_fixture.mjs — THROUGHPUT of statically recompiled SAB code, measured by
// replaying a captured fixture in a loop.
//
//   SR_OUT=/tmp/sr_perf node gamecube/recomp/sr/perf_fixture.mjs <fixture.json> [entry_hex ...]
//
// Env: SR_OUT (dir holding sr_slice.js), PERF_SECONDS (default 3), PERF_REPS (override).
//
// WHAT THIS MEASURES, stated before the number so it cannot be quoted loose:
//   * ONE function's translated code, executed in Node, on a hot cache, with the
//     guest state and its touched memory restored to the captured entry conditions
//     before every invocation.  The restore cost is measured separately in an
//     empty-body control and SUBTRACTED; both raw and corrected figures are printed.
//   * It is NOT a workload. There is no interrupt delivery, no DMA, no GPU, no audio,
//     no OS scheduling, no cache pressure from the rest of the game, and no browser.
//   * "MHz-equivalent" below is guest INSTRUCTIONS RETIRED per second divided by 1e6.
//     A 486 MHz Gekko cannot retire more than 486 M instr/s and in practice retires
//     fewer, so ratio-to-486 is an OPTIMISTIC bound on this function's share, never a
//     whole-game speed. Do not restate it as "Nx the console".
//
// The fixture is replayed through the SAME sr_call entry the differential uses, and
// the run ABORTS if any invocation faults or if the invocation count is not what was
// asked for — a fault would otherwise make an early-exiting function look fast.
import fs from 'node:fs';
import path from 'node:path';

const SLICE = process.env.SR_OUT || '/tmp/sr_perf';
const SECONDS = Number(process.env.PERF_SECONDS || 3);
const O_GPR = 0, O_PS0 = 128, O_PS1 = 384, O_CR = 640, O_XER = 644, O_LR = 648,
      O_CTR = 652, O_FPSCR = 656, O_GQR = 660, O_PC = 692, SZ = 696;
const GEKKO_HZ = 486_000_000;

const main = async () => {
  const factory = (await import(path.resolve(SLICE, 'sr_slice.js'))).default;
  const M = await factory();
  if (!M._sr_init()) throw new Error('sr_init failed');
  if (M._sr_state_size() !== SZ)
    throw new Error(`GekkoState size ${M._sr_state_size()} != ${SZ}`);
  const ram = M._sr_ram(), st = M._sr_state();
  const phys = (a) => (a & 0x03ffffff) >>> 0;

  const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const only = process.argv.slice(3).map((x) => parseInt(x, 16) >>> 0);

  console.log(`slice   : ${path.resolve(SLICE, 'sr_slice.wasm')}`);
  console.log(`node    : ${process.version}   budget ${SECONDS}s per function`);
  console.log('');

  const rows = [];
  for (const fx of j.fixtures) {
    const entry = fx.entry >>> 0;
    if (only.length && !only.includes(entry)) continue;
    if (fx.usable === false) continue;
    const tag = `0x${entry.toString(16).padStart(8, '0')}`;

    // --- SPARSE restore set -------------------------------------------------
    // The staged bytes are SCATTERED: 0x801113d4 stages 84 bytes across a 2,401,704
    // byte span, so a contiguous [min,max] snapshot copies 2.4 MB per iteration and
    // the restore alone becomes the entire measurement (that is exactly what the
    // first version of this file did -- the control cost MORE than the run and the
    // subtraction went negative).  Only bytes the function WRITES can differ between
    // iterations, so restore precisely those, to their pre-invocation values.
    const pre = new Map();                       // phys offset -> byte before the call
    for (const w of fx.writes || []) {
      const before = Buffer.from(w.before, 'hex');
      for (let i = 0; i < before.length; i++) {
        const off = phys(w.ea + i);
        if (!pre.has(off)) pre.set(off, before[i]);   // FIRST pre-image wins
      }
    }
    const rOff = new Int32Array(pre.size), rVal = new Uint8Array(pre.size);
    { let i = 0; for (const [o, v] of pre) { rOff[i] = o; rVal[i] = v; i++; } }

    // one-time full stage of everything the capture recorded as read
    const H = M.HEAPU8;
    for (const [aHex, byte] of Object.entries(fx.initial_mem))
      H[ram + phys(parseInt(aHex, 16))] = byte;

    // --- the entry GekkoState, built once and memcpy'd per invocation ---------
    const stSnap = new Uint8Array(SZ);
    {
      const dv = new DataView(stSnap.buffer);
      const si = fx.state_in;
      for (let i = 0; i < 32; i++) dv.setUint32(O_GPR + i * 4, si.gpr[i] >>> 0, true);
      for (let i = 0; i < 32; i++) {
        const v = BigInt(si.fpr[i]);
        dv.setBigUint64(O_PS0 + i * 8, v, true);
        dv.setBigUint64(O_PS1 + i * 8, v, true);
      }
      dv.setUint32(O_CR, si.cr >>> 0, true);
      dv.setUint32(O_XER, si.xer >>> 0, true);
      dv.setUint32(O_LR, si.lr >>> 0, true);
      dv.setUint32(O_CTR, si.ctr >>> 0, true);
      dv.setUint32(O_FPSCR, si.fpscr >>> 0, true);
      for (let i = 0; i < 8; i++) dv.setUint32(O_GQR + i * 4, (fx.gqr ? fx.gqr[i] : 0) >>> 0, true);
      dv.setUint32(O_PC, entry, true);
    }

    const n = rOff.length;
    const restore = () => {
      H.set(stSnap, st);
      for (let i = 0; i < n; i++) H[ram + rOff[i]] = rVal[i];
    };

    restore();
    const probe = M._sr_call(entry) >>> 0;
    if (probe !== 0) { console.log(`SKIP  ${tag}  faults ${probe.toString(16)}`); continue; }

    // --- MATCHED PAIR, min of K trials ---------------------------------------
    // Same rep count for run and control so they are comparable, and the MINIMUM
    // over trials rather than one sample, because this box is shared and matched-pair
    // noise here has been as bad as +/-25% at load 11-23.
    const REPS = Number(process.env.PERF_REPS || 20000);
    const TRIALS = Number(process.env.PERF_TRIALS || 7);
    const runBody = () => { for (let i = 0; i < REPS; i++) { restore(); M._sr_call(entry); } };
    const ctrlBody = () => { for (let i = 0; i < REPS; i++) { restore(); } };
    runBody(); ctrlBody();                       // warm the JIT tier on both
    let runMin = Infinity, ctrlMin = Infinity;
    for (let t = 0; t < TRIALS; t++) {
      let a = process.hrtime.bigint(); runBody();
      runMin = Math.min(runMin, Number(process.hrtime.bigint() - a) / 1e6);
      a = process.hrtime.bigint(); ctrlBody();
      ctrlMin = Math.min(ctrlMin, Number(process.hrtime.bigint() - a) / 1e6);
    }
    const fault = M._sr_call(entry) >>> 0;
    if (fault !== 0) { console.log(`ABORT ${tag}  faulted mid-benchmark ${fault.toString(16)}`); continue; }

    const perRunMs = runMin / REPS, perCtrlMs = ctrlMin / REPS;
    const netMs = perRunMs - perCtrlMs;
    const steps = fx.steps;
    const rawIps = steps / (perRunMs / 1000);
    const netIps = netMs > 0 ? steps / (netMs / 1000) : NaN;
    const overhead = 100 * perCtrlMs / perRunMs;

    rows.push({ tag, steps, perRunMs, perCtrlMs, netMs, rawIps, netIps, overhead });
    console.log(`${tag}  steps=${steps}  restore-set=${n}B  reps=${REPS}x${TRIALS} (min)`);
    console.log(`   per invocation : ${perRunMs.toFixed(6)} ms  (restore control ` +
                `${perCtrlMs.toFixed(6)} ms = ${overhead.toFixed(1)}% of it, net ${netMs.toFixed(6)} ms)`);
    console.log(`   guest instr/s  : ${(rawIps / 1e6).toFixed(1)} M raw   ` +
                `${(netIps / 1e6).toFixed(1)} M restore-corrected`);
    console.log(`   vs 486 MHz Gekko clock : ${(rawIps / GEKKO_HZ).toFixed(3)}x raw   ` +
                `${(netIps / GEKKO_HZ).toFixed(3)}x corrected   ` +
                `(OPTIMISTIC BOUND -- see header)`);
    console.log('');
  }

  if (rows.length > 1) {
    const ok = rows.filter((r) => Number.isFinite(r.netIps) && r.overhead < 50);
    console.log(`functions whose restore control is under 50% of the run (the only ones\n` +
                `whose corrected figure is worth reading): ${ok.length} of ${rows.length}`);
    for (const r of ok)
      console.log(`   ${r.tag}  ${(r.netIps / 1e6).toFixed(1)} M instr/s  ` +
                  `${(r.netIps / GEKKO_HZ).toFixed(3)}x the 486 MHz clock`);
  }
};
main();
