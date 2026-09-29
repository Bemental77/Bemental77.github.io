// run_image_stream.mjs — the browser guest path (sr_image/sr_guest.js), run in node.
//
//   SR_IMG=<dir with a SR_PTHREAD=1 SR_MEM=1879048192 SR_POOL=14 SR_ENV=node build>
//   SRN_ISO=<sab.iso> SRS_MS=<wall ms to run, default 60000> SRS_OUT=<json> SRS_POSTMS=<pump period, 100>
//   [SRS_DUMP=<dir>: write the first posts' fifo as post_<n>.bin]
//   node gamecube/recomp/sr/run_image_stream.mjs
//
// It does exactly what sr_render_worker.js does in its guest mode — same module (sr_guest.js),
// same staging order as run_image_node.mjs — except that the posts are decoded here instead of
// being handed to Dolphin: every post's FIFO is walked as GP commands (the same sizing sr_gx.c
// uses) and its copies to the XFB are counted, so "the stream the page would get is whole
// frames, in order, nothing lost" is checked without a renderer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(process.env.SR_IMG);
const OUT = process.env.SRS_OUT || '/tmp/sr-image-stream.json';
const MS = +(process.env.SRS_MS || 60000), POSTMS = +(process.env.SRS_POSTMS || 100);
const stage = await import('data:text/javascript;base64,' +
  fs.readFileSync(path.join(HERE, '../sr_image/sr_boot_stage.js')).toString('base64'));
const G = await import(pathToFileURL(path.join(HERE, '../sr_image/sr_guest.js')).href);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const md5Before = md5(path.join(DIR, 'sab_image.wasm'));

const M = await (await import(pathToFileURL(path.join(DIR, 'sab_image.mjs')).href)).default();
const api = stage.bindImage(M, {});
if (!api.init()) throw new Error('sr_image_init() returned 0');

// staging — run_image_node.mjs's order: DOL, FST (old staging), low globals, vectors, apploader
const dol = fs.readFileSync(path.join(DIR, 'sab_main.dol'));
const p = M._malloc(dol.length); M.HEAPU8.set(dol, p); api.loadDol(p, dol.length); M._free(p);
stage.stageFst(M, api, new Uint8Array(fs.readFileSync(path.join(DIR, 'sab_fst.bin'))));
for (const [ea, v] of stage.OS_GLOBALS) api.setGlobal(ea >>> 0, v >>> 0);
for (const ea of stage.EXC_VECTORS) api.setGlobal(ea >>> 0, stage.PPC_RFI);

const isoSize = fs.statSync(process.env.SRN_ISO).size;
const t0 = performance.now();
const disc = await G.loadDisc(M, isoSize, (async function* () {
  const fd = fs.openSync(process.env.SRN_ISO, 'r'), buf = Buffer.alloc(64 << 20);
  for (let o = 0; o < isoSize;) { const n = fs.readSync(fd, buf, 0, buf.length, o); yield buf.subarray(0, n); o += n; }
  fs.closeSync(fd);
})());
const discMs = performance.now() - t0;
const apploader = G.stageApploader(M, api, M.HEAPU8.subarray(disc.ptr, disc.ptr + disc.size));

// the GP walk (sr_gx.c's sizing), for checking posts
const vat = Array.from({ length: 8 }, () => [0, 0, 0]); let vlo = 0, vhi = 0;
const cf = (f) => f <= 1 ? 1 : f <= 3 ? 2 : 4;
function vsize(v) {
  const [g0, g1, g2] = vat[v]; let s = 0, t;
  for (let b = 0; b < 9; b++) s += (vlo >> b) & 1;
  t = (vlo >> 9) & 3; if (t === 1) s += cf((g0 >> 1) & 7) * ((g0 & 1) ? 3 : 2); else if (t) s += t - 1;
  t = (vlo >> 11) & 3; if (t) { const ntb = (g0 >> 9) & 1, i3 = (g0 >>> 31) & 1;
    s += t === 1 ? cf((g0 >> 10) & 7) * (ntb ? 9 : 3) : (t - 1) * (ntb && i3 ? 3 : 1); }
  for (let c = 0; c < 2; c++) { t = (vlo >> (13 + 2 * c)) & 3; const f = (g0 >> (c ? 18 : 14)) & 7;
    s += t === 1 ? [2, 3, 4, 2, 3, 4][f] : t ? t - 1 : 0; }
  const cb = [21, 0, 9, 18, 27, 5, 14, 23], fb = [22, 1, 10, 19, 28, 6, 15, 24], gr = [0, 1, 1, 1, 1, 2, 2, 2];
  for (let i = 0; i < 8; i++) { t = (vhi >> (2 * i)) & 3; if (!t) continue; const g = [g0, g1, g2][gr[i]];
    s += t === 1 ? cf((g >> fb[i]) & 7) * (((g >> cb[i]) & 1) ? 2 : 1) : t - 1; }
  return s;
}
function walk(b) {
  let i = 0, copies = 0, prims = 0, bad = 0;
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  while (i < b.length) {
    const op = b[i];
    if (op === 0) { i++; continue; }
    if (op === 0x08) { const s = b[i + 1], v = u32(i + 2);
      if ((s & 0xF0) === 0x50) vlo = v; else if ((s & 0xF0) === 0x60) vhi = v;
      else if ((s & 0xF0) === 0x70) vat[s & 7][0] = v; else if ((s & 0xF0) === 0x80) vat[s & 7][1] = v;
      else if ((s & 0xF0) === 0x90) vat[s & 7][2] = v; i += 6; continue; }
    if (op === 0x10) { i += 5 + 4 * (((u32(i + 1) >>> 16) & 0xF) + 1); continue; }
    if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) { i += 5; continue; }
    if (op === 0x40) { i += 9; continue; }
    if (op === 0x48) { i += 1; continue; }
    if (op === 0x61) { if (b[i + 1] === 0x52 && (b[i + 3] & 0x40)) copies++; i += 5; continue; }
    if (op >= 0x80 && op <= 0xBF) { prims++; i += 3 + ((b[i + 1] << 8) | b[i + 2]) * vsize(op & 7); continue; }
    bad++; i++;
  }
  return { copies, prims, bad, overrun: i - b.length };
}

await G.startGuest(M, api, { hle: 12, snapMem: +(process.env.SRS_SNAPMEM || 0),
  idleLoop: process.env.SRS_IDLELOOP === undefined ? undefined : +process.env.SRS_IDLELOOP,
  exiModel: +(process.env.SRS_EXI || 1),
  fmaFast: process.env.SRS_FMA === undefined ? undefined : +process.env.SRS_FMA, si: +(process.env.SRS_SI || 0),
  input: (process.env.SRS_INPUT || '').split(',').filter(Boolean).map((x) => x.split(':').map((y) => parseInt(y))), card: process.env.SRS_CARD === undefined ? 1 : +process.env.SRS_CARD });
const pump = G.makePump(M, api);
const posts = [];
let copiesInPosts = 0, badOps = 0, overruns = 0;
if (process.env.SRS_DUMP) fs.mkdirSync(process.env.SRS_DUMP, { recursive: true });
// THE RATE SAMPLER (SRS_POSTMS=0 turns the pump off entirely, so the measurement arm does no
// 24 MB MEM1 copies): once per second, guest kcycles credited and idle-skipped, vs wall time.
const samples = [];
const rdg = (ea) => { const b = api.ram() + (ea & 0x01FFFFFF), U = M.HEAPU8; return ((U[b] << 24) | (U[b + 1] << 16) | (U[b + 2] << 8) | U[b + 3]) >>> 0; };
const modIds = () => { const o = []; for (let h = rdg(0x800030C8), n = 0; h && n < 8; h = rdg(h + 4), n++) o.push(rdg(h)); return o.join('/'); };
const sampler = setInterval(() => {
  samples.push({ xfb: M._sr_image_xfb_copies() >>> 0, prims: M._sr_gp_prims() >>> 0, vframes: M._sr_image_vi_frames() >>> 0, mods: modIds(), fault: '0x' + (M._sr_image_fault() >>> 0).toString(16), wallMs: performance.now() - t0, kc: M._sr_image_kcycles() >>> 0,
                 idleKc: M._sr_image_idle_kcycles() >>> 0, loopSkips: M._sr_image_idle_loop_skips ? M._sr_image_idle_loop_skips() >>> 0 : null, skips: M._sr_image_idle_skips() >>> 0, tb: M._sr_tb_calls() >>> 0, irq: M._sr_image_irq_delivered() >>> 0, fin: M._sr_image_pe_finishes() >>> 0 });
}, 1000);
const timer = POSTMS <= 0 ? null : setInterval(() => {
  const f = pump();
  if (!f) return;
  if (!f.fifo) { posts.push({ lost: f.lost }); return; }
  const w = walk(f.fifo);
  copiesInPosts += w.copies; badOps += w.bad; if (w.overrun) overruns++;
  if (process.env.SRS_DUMP && f.n <= 8) fs.writeFileSync(path.join(process.env.SRS_DUMP, `post_${f.n}.bin`), f.fifo);
  posts.push({ n: f.n, bytes: f.fifo.length, framesInPost: f.framesInPost, copies: w.copies, prims: w.prims,
               bad: w.bad, overrun: w.overrun, mem1: f.mem1.length, lost: f.lost,
               wallMs: +(performance.now() - t0).toFixed(0) });
}, POSTMS);
await new Promise((r) => setTimeout(r, MS));
if (timer) clearInterval(timer);
clearInterval(sampler);
const guest = G.guestCounters(M);
guest.exi = M._sr_exi_card_cmds ? { cardCmds: M._sr_exi_card_cmds() >>> 0, cardRd: M._sr_exi_card_rd() >>> 0, cardWr: M._sr_exi_card_wr() >>> 0, tstarts: M._sr_exi_tstarts() >>> 0, romReads: M._sr_exi_rom_reads() >>> 0 } : null;
guest.ov = { entries: M._sr_image_ov_entries() >>> 0, refused: M._sr_image_ov_refused() >>> 0,
  lastRefused: '0x' + (M._sr_image_ov_last_refused() >>> 0).toString(16),
  missingId: M._sr_image_ov_missing_id ? M._sr_image_ov_missing_id() >>> 0 : null,
  missingHdr: M._sr_image_ov_missing_hdr ? '0x' + (M._sr_image_ov_missing_hdr() >>> 0).toString(16) : null };
// the window: from the first sample at or past SRS_FROM_GS guest seconds (default 1.0, i.e.
// inside mcwarnD's frame loop) to the last sample
const FROM = +(process.env.SRS_FROM_GS || 1.0) * 486e3;
const TO = +(process.env.SRS_TO_GS || 30) * 486e3;   // stay inside mcwarnD: a later REL is not in the image
const inWin = samples.filter((x) => x.kc < TO);
const a = samples.find((x) => x.kc >= FROM), b = inWin[inWin.length - 1];
let rate = null;
if (a && b && b.wallMs > a.wallMs) {
  const w = (b.wallMs - a.wallMs) / 1000, dk = b.kc - a.kc, di = b.idleKc - a.idleKc;
  rate = { windowWallS: +w.toFixed(2), guestSecondsPerWallSecond: +(dk / 486e3 / w).toFixed(4),
           creditedMHz: +(dk / 1e3 / w).toFixed(2), executedMHz: +((dk - di) / 1e3 / w).toFixed(2),
           idleFraction: +(di / dk).toFixed(4), drawDonesPerWallS: +((b.fin - a.fin) / w).toFixed(2),
           mhzNeededAt1x: +(486 * (1 - di / dk)).toFixed(1) };
}
const result = {
  md5Before, md5After: md5(path.join(DIR, 'sab_image.wasm')), wallMs: MS, discMs: +discMs.toFixed(0),
  apploader, rate, guest, posts: posts.length, copiesInPosts, badOps, overruns,
  lost: posts.length ? posts[posts.length - 1].lost : 0,
  samples, firstPosts: posts.slice(0, 6), lastPosts: posts.slice(-3),
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, firstPosts: undefined, lastPosts: undefined }));
process.exit(0);
