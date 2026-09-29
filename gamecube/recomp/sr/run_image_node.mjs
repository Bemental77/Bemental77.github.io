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
//   SRN_AR=0 SRN_RM=0 SRN_IRQ=0 SRN_PIREV=0 SRN_VI=0 SRN_AI=0   the 2026-09-29 models (sr_image_set_model)
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
const MODELS = { AR: 1, RM: 2, IRQ: 3, PIREV: 4, VI: 5, AI: 6 };
const setModel = opt('_sr_image_set_model'), getModel = opt('_sr_image_get_model');
for (const [k, id] of Object.entries(MODELS)) {
  if (!setModel) { arms[k.toLowerCase()] = 'absent'; continue; }
  setModel(id, +env('SRN_' + k, 1));
  arms[k.toLowerCase()] = getModel(id);
}
api.setWatchdog(+env('SRN_WATCHDOG', 3000000) >>> 0);
api.setStrict(+env('SRN_STRICT', 0));
if (process.env.SRN_OSMODE) api.osMode(+process.env.SRN_OSMODE);

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
const log = S.summarize(S.readLog(M, api));
const n = api.devLogN(), dbase = api.devLogPtr() >>> 2, first = [];
for (let i = 0; i < n; i++) first.push([hex(H[dbase + 2 * i]), H[dbase + 2 * i + 1]]);
const extra = {};
for (const [k, fn] of [['dspEvents', '_sr_image_dsp_events'], ['aramBytes', '_sr_image_aram_bytes'],
                       ['irqDelivered', '_sr_image_irq_delivered'], ['decDelivered', '_sr_image_dec_delivered'],
                       ['irqLast', '_sr_image_irq_last'], ['piCause', '_sr_image_pi_cause'],
                       ['piMask', '_sr_image_pi_mask'], ['viFrames', '_sr_image_vi_frames'],
                       ['tbCalls', '_sr_tb_calls'],
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
  peek,
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
