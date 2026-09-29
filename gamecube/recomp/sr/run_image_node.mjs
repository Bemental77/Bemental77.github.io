// run_image_node.mjs — drive the WHOLE-IMAGE SAB boot (build_image.sh) under NODE.
//
// sr_image_probe.mjs drives the same module in a real browser and stays the acceptance
// instrument for "does it instantiate IN A BROWSER".  This file answers the other
// question — "how far does the guest's own __start get?" — without a browser, so it
// needs no Chromium, no page, no server and no probe lock.  Both run the SAME wasm when
// the image is linked with SR_ENV=web,worker,node (one md5, two hosts).
//
// THE STAGING IS NOT RE-TYPED HERE.  Every cited low-memory value lives in
// ../sr_image/sr_boot_stage.js (OS_GLOBALS / EXC_VECTORS / bindImage / summarize /
// readDev).  That file is an ES module with a .js extension and no package.json
// "type", so Node would load it as CommonJS; it has no imports, so it is loaded
// verbatim through a data: URL instead.  One copy of the tables, not three.
//
//   SR_IMG=<dir with sab_image.mjs + sab_image.wasm + sab_main.dol [+ sab_fst.bin]> \
//   node gamecube/recomp/sr/run_image_node.mjs
//
// env (every switch is RUN-TIME, so each control arm is the same binary / same md5):
//   SRN_EXI=0 / SRN_DSP=0     turn ONE device model off
//   SRN_AR=0 SRN_RM=0 SRN_IRQ=0 SRN_PIREV=0 SRN_VI=0 SRN_AI=0 SRN_UCODE=0 SRN_AID=0 SRN_AXCMD=0   the 2026-09-29 models (sr_image_set_model)
//   SRN_OSMODE=<n>            sr_os_mode() after init (3 = IRQ default, 4 = CTX)
//   SRN_WATCHDOG=<n>          device READS before the watchdog throws (default 3000000)
//   SRN_STRICT=1              first unimplemented host boundary throws
//   SRN_OUT=<path>            JSON result (default /tmp/sr-image-node.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.env.SR_IMG || path.join(HERE, '../sr_image'));
const OUT = process.env.SRN_OUT || '/tmp/sr-image-node.json';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

const stageSrc = fs.readFileSync(path.join(HERE, '../sr_image/sr_boot_stage.js'), 'utf8');
const S = await import('data:text/javascript;base64,' + Buffer.from(stageSrc).toString('base64'));

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const wasmPath = path.join(DIR, 'sab_image.wasm');
const md5Before = md5(wasmPath);

const factory = (await import(pathToFileURL(path.join(DIR, 'sab_image.mjs')).href)).default;
const M = await factory();
const opt = (name) => (typeof M[name] === 'function' ? M[name] : null);
const api = S.bindImage(M, {
  setDspModel: '_sr_image_set_dsp_model', dspEvents: '_sr_image_dsp_events',
  aramBytes: '_sr_image_aram_bytes',
});
if (!api.init()) throw new Error('sr_image_init() returned 0');

api.setExiModel(+env('SRN_EXI', 1));
api.setDspModel(+env('SRN_DSP', 1));
// Later device models are optional exports: a binary that predates them simply lacks
// the switch, and the result records that rather than pretending the arm was set.
const arms = { exi: +env('SRN_EXI', 1), dsp: +env('SRN_DSP', 1) };
// sr_image_set_model(id, on): the [2026-09-29] models (sr_image.c "THE NEXT DEVICES").
// A binary that predates them lacks the export, and the result records 'absent' rather
// than pretending the arm was set.
const MODELS = { AR: 1, RM: 2, IRQ: 3, PIREV: 4, VI: 5, AI: 6, UCODE: 7, AID: 8, AXCMD: 9 };
const setModel = opt('_sr_image_set_model'), getModel = opt('_sr_image_get_model');
for (const [k, id] of Object.entries(MODELS)) {
  if (!setModel) { arms[k.toLowerCase()] = 'absent'; continue; }
  setModel(id, +env('SRN_' + k, 1));
  arms[k.toLowerCase()] = getModel(id);
}
api.setWatchdog(+env('SRN_WATCHDOG', 3000000) >>> 0);
// SRN_BUDGET=<M guest cycles>: bound the run by GUEST time (sr_image_set_budget_mcycles).
// Default 4860 = 10 s of Gekko time.  0 = unbounded.
if (opt('_sr_image_set_budget_mcycles')) M._sr_image_set_budget_mcycles(+env('SRN_BUDGET', 4860) >>> 0);
// SRN_HLE=<n>: SR_OS_HLE with n host threads (needs a SR_PTHREAD=1 build).
if (process.env.SRN_HLE) {
  if (!opt('_sr_image_init_hle')) throw new Error('SRN_HLE set but this binary was not linked SR_PTHREAD=1');
  // The timeout FIRST: the pool threads park inside sr_os_init with whatever it is then.
  M._sr_os_set_timeout(+env('SRN_PARK_MS', 600000));
  M._sr_image_init_hle(+process.env.SRN_HLE);
}
api.setStrict(+env('SRN_STRICT', 0));
if (process.env.SRN_OSMODE) api.osMode(+process.env.SRN_OSMODE);
// Thread events only (10..17) plus DEC_EXC (27): see sr_host_os.c g_trace_mask.
if (opt('_sr_os_trace_mask')) M._sr_os_trace_mask(+env('SRN_TRACE_MASK', 0x0803FC00), 0);
// SRN_PAST_FAULT=1: keep delivering interrupts after the first fault — EXPLORATORY ONLY.
if (opt('_sr_image_set_past_fault')) M._sr_image_set_past_fault(+env('SRN_PAST_FAULT', 0));
// Every fault in order (the first is g_fault; later ones are recorded by the image, if any).


// ---- staging: identical order to sr_boot_stage.js stageBoot()
const dol = fs.readFileSync(path.join(DIR, 'sab_main.dol'));
const p = M._malloc(dol.length);
M.HEAPU8.set(dol, p);
const copied = api.loadDol(p, dol.length);
M._free(p);
if (copied >>> 24 === 0xC6) throw new Error('sr_image_load_dol failed: 0x' + (copied >>> 0).toString(16));
let fst = { staged: false, why: 'no sab_fst.bin' };
const fstPath = path.join(DIR, 'sab_fst.bin');
if (fs.existsSync(fstPath)) fst = S.stageFst(M, api, new Uint8Array(fs.readFileSync(fstPath)));
for (const [ea, v] of S.OS_GLOBALS) api.setGlobal(ea >>> 0, v >>> 0);
for (const ea of S.EXC_VECTORS) api.setGlobal(ea >>> 0, S.PPC_RFI);
// Optional disc image for a DI model: the host layer reads it through a JS import, so
// only a binary that has one uses it.
const discHook = opt('_sr_image_set_disc_size');
if (discHook && process.env.SRN_ISO) {
  const st = fs.statSync(process.env.SRN_ISO);
  globalThis.__srDiscFd = fs.openSync(process.env.SRN_ISO, 'r');
  discHook(st.size >>> 0);
}

const hex = (v) => '0x' + (v >>> 0).toString(16);
const t0 = performance.now();
let ret = null, threw = null;
try { ret = api.boot() >>> 0; } catch (err) { threw = String(err && err.message || err); }
const ms = performance.now() - t0;

const gb = api.state() >>> 2, H = M.HEAPU32;
// GekkoState: gpr[32] | ps0[32] u64 | ps1[32] u64 | cr xer lr ctr fpscr gqr[8] pc
const tail = gb + 32 + 64 * 2;
const regs = { r1: hex(H[gb + 1]), r3: hex(H[gb + 3]), r4: hex(H[gb + 4]), r31: hex(H[gb + 31]),
               cr: hex(H[tail]), lr: hex(H[tail + 2]), ctr: hex(H[tail + 3]) };
// The GUEST call stack at the stop, read from the PowerPC EABI back chain: [r1] is the
// caller's r1 and [backchain + 4] is the LR its callee saved.  No PC exists in this image,
// so this is the only way to see WHERE a wedged guest is beyond the boundary log.
const rd32 = (ea) => { const b = api.ram() + (ea & 0x01FFFFFF), U = M.HEAPU8;
  return ((U[b] << 24) | (U[b + 1] << 16) | (U[b + 2] << 8) | U[b + 3]) >>> 0; };
const backtrace = [];
for (let sp = H[gb + 1] >>> 0, i = 0; i < 24 && sp >= 0x80000000 && sp < 0x81800000; i++) {
  const next = rd32(sp); if (next <= sp) break;
  backtrace.push(hex(rd32(next + 4))); sp = next;
}
const tailRing = [];
if (opt('_sr_image_tail')) {
  const tn = M._sr_image_tail_n() >>> 0, tb = M._sr_image_tail() >>> 2;
  for (let k = Math.max(0, tn - 64); k < tn; k++) {
    const i = tb + (k % 64) * 4;
    tailRing.push(`${hex(H[i])} lr=${hex(H[i + 1])} msr=${hex(H[i + 2])} th=${hex(H[i + 3])}`);
  }
}
// sr_host_os.c's event trace (the FIRST 4,096 events): thread hand-offs, starts, resumes.
const osTrace = [];
if (opt('_sr_os_trace')) {
  const tn = M._sr_os_trace_n() >>> 0, tb = M._sr_os_trace() >>> 2;
  const EV = {10:'SELECT_ENTER',11:'SELECT_SAVE',12:'HANDOFF',13:'START_THREAD',14:'RESUMED',15:'SELECT_RETURN',16:'THREAD_ENTRY',17:'THREAD_EXIT',27:'DEC_EXC'};
  for (let k = 0; k < tn; k++) {
    const ev = H[tb + 3 * k];
    if (EV[ev]) osTrace.push(`${EV[ev]} ${hex(H[tb + 3 * k + 1])} ${hex(H[tb + 3 * k + 2])}`);
  }
}
// Every guest thread on __OSActiveThreadQueue (0x800000DC head, linkActive at +0x2FC;
// dolsdk2001 include/dolphin/os/OSThread.h + OSThread.c), with its saved PC/LR/r1 and the
// back chain from its saved r1 — where each thread is PARKED when the run stops.
const threads = [];
for (let t = rd32(0x800000DC), n = 0; t && n < 32; t = rd32(t + 0x2FC), n++) {
  const bt = [];
  for (let sp = rd32(t + 4), i = 0; i < 12 && sp >= 0x80000000 && sp < 0x81800000; i++) {
    const next = rd32(sp); if (next <= sp) break; bt.push(hex(rd32(next + 4))); sp = next;
  }
  threads.push({ thread: hex(t), state: rd32(t + 0x2C8) >>> 16, prio: rd32(t + 0x2D0),
                 srr0: hex(rd32(t + 0x198)), lr: hex(rd32(t + 0x84)), r1: hex(rd32(t + 4)), bt });
}
// The thread that was RUNNING when the guest-time budget ran out, with its registers.
let atBudget = null;
if (opt('_sr_image_budget_thread') && H[(M._sr_image_budget_state() >>> 2) + 1]) {
  const b = M._sr_image_budget_state() >>> 2, bt2 = [];
  for (let sp = H[b + 1] >>> 0, i = 0; i < 16 && sp >= 0x80000000 && sp < 0x81800000; i++) {
    const next = rd32(sp); if (next <= sp) break; bt2.push(hex(rd32(next + 4))); sp = next;
  }
  atBudget = { thread: hex(M._sr_image_budget_thread()), lr: hex(H[b + 32 + 128 + 2]),
               r1: hex(H[b + 1]), r3: hex(H[b + 3]), bt: bt2, threads: [],
               runQueueBits: opt('_sr_image_budget_runq') ? hex(M._sr_image_budget_runq()) : null };
  if (opt('_sr_image_budget_threads')) {
    const tb = M._sr_image_budget_threads() >>> 2;
    for (let k = 0; k < (M._sr_image_budget_threads_n() >>> 0); k++) {
      const r = (j) => H[tb + 6 * k + j] >>> 0, bt3 = [];
      for (let sp = r(5), i = 0; i < 10 && sp >= 0x80000000 && sp < 0x81800000; i++) {
        const next = rd32(sp); if (next <= sp) break; bt3.push(hex(rd32(next + 4))); sp = next;
      }
      atBudget.threads.push({ thread: hex(r(0)), state: r(1), prio: r(2), srr0: hex(r(3)), lr: hex(r(4)), r1: hex(r(5)), bt: bt3 });
    }
  }
}
regs.msr = opt('_sr_os_get_msr') ? hex(M._sr_os_get_msr()) : null;
regs.curThread = hex(rd32(0x800000E4));
const log = S.summarize(S.readLog(M, api));
const n = api.devLogN(), dbase = api.devLogPtr() >>> 2, first = [];
for (let i = 0; i < n; i++) first.push([hex(H[dbase + 2 * i]), H[dbase + 2 * i + 1]]);
const extra = {};
for (const [k, fn] of [['dspEvents', '_sr_image_dsp_events'], ['aramBytes', '_sr_image_aram_bytes'],
                       ['irqDelivered', '_sr_image_irq_delivered'], ['decDelivered', '_sr_image_dec_delivered'],
                       ['irqLast', '_sr_image_irq_last'], ['piCause', '_sr_image_pi_cause'],
                       ['piMask', '_sr_image_pi_mask'], ['viFrames', '_sr_image_vi_frames'],
                       ['ucodeCrc', '_sr_image_ucode_crc'], ['axLists', '_sr_ax_lists'], ['axPBs', '_sr_ax_pbs'], ['axVoices', '_sr_ax_voices'], ['axUnknownCmds', '_sr_ax_unknown_cmds'], ['ucode', '_sr_image_ucode'], ['axCmdlist', '_sr_image_ax_cmdlist'],
                       ['indirectFaultLr', '_sr_image_indirect_fault_lr'], ['indirectFaultTarget', '_sr_image_indirect_fault_target'], ['tbCalls', '_sr_tb_calls'], ['idleSkips', '_sr_image_idle_skips'], ['idleMcycles', '_sr_image_idle_mcycles'], ['cyclesM', '_sr_image_cycles_m'],
                       ['tbStalls', '_sr_tb_stalls'], ['decExc', '_sr_tb_dec_exceptions'],
                       ['tbHi', '_sr_tb_hi'], ['tbLo', '_sr_tb_lo'], ['gxWrites', '_sr_gx_writes'],
                       ['gxBytes', '_sr_gx_bytes']]) {
  const f = opt(fn); if (f) extra[k] = f() >>> 0;
}
// SRN_PEEK=<ea>[:<n words>],...  read guest MEM1 words after the run (big-endian), so a
// runtime table (e.g. the exception table the guest's own OSInit filled) is READ, not guessed.
const peek = {};
for (const spec of (process.env.SRN_PEEK || '').split(',').filter(Boolean)) {
  const [eaS, nS] = spec.split(':'); const ea = parseInt(eaS, 16) >>> 0; const nw = +(nS || 1);
  const words = [];
  for (let i = 0; i < nw; i++) {
    const ph = (ea + 4 * i) & 0x01FFFFFF, b = api.ram() + ph, U = M.HEAPU8;
    words.push(hex(((U[b] << 24) | (U[b + 1] << 16) | (U[b + 2] << 8) | U[b + 3]) >>> 0));
  }
  peek[hex(ea)] = words;
}
if (getModel) for (const [k, id] of Object.entries(MODELS)) extra['ev_' + k] = M._sr_image_model_events(id) >>> 0;
const result = {
  peek, backtrace, tailRing, osTrace, threads, atBudget,
  wasm: wasmPath, md5Before, md5After: md5(wasmPath), arms,
  osMode: api.osGetMode(), fst, copied, ms, returned: ret === null ? null : hex(ret), threw,
  fault: hex(api.fault()), regs,
  devReads: api.devReads(), devWrites: api.devWrites(), exiClears: api.exiClears(),
  distinctRegs: new Set(first.filter(([, k]) => k === 1 || k === 2).map(([a]) => a)).size,
  devFirstTouch: first, extra,
  logTotal: log.total, logDropped: log.dropped, logDistinct: log.distinct,
  lastRuns: log.runs.slice(-40),
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const lastDev = first[first.length - 1];
console.log(JSON.stringify({
  md5: md5Before, md5Same: md5Before === result.md5After, arms, osMode: result.osMode, ms: Math.round(ms),
  returned: result.returned, threw, fault: result.fault, regs,
  devReads: result.devReads, devWrites: result.devWrites, distinctRegs: result.distinctRegs,
  lastDev, peek, crossings: log.total, distinctCrossings: log.distinct.length, extra,
  lastRuns: log.runs.slice(-8).map((r) => `${r.addr} ${r.disp} x${r.n}`),
}, null, 1));
console.log('full JSON ->', OUT);
