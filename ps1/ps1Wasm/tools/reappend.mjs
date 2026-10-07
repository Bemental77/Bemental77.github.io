#!/usr/bin/env node
// reappend.mjs — put the hand-written worker block back on a rebuilt core.
//
// dist/wasmpsx_worker.js is TWO things: line 1 is emcc's output for
// pcsx-wasm-src (runtime + js/worker_funcs.js as --post-js); everything after
// it (~65 KB: the lockstep gate, the governor takeover, the undo-log rollback
// ring, the audio ring, the VRAM span copy) was appended BY HAND and exists in
// no source file. A rebuild produces a new line 1 only, so this tool carries
// the block across:
//
//     out = <new emcc line 1> + "\n" + <dist lines 2..end, byte-for-byte>
//
// ⚠ THE BLOCK HARD-CODES ADDRESSES OF ONE BINARY (its CORE table, STATIC_END,
// STATIC_SPANS). It guards them itself: coreSigOk() checks three rodata strings
// at fixed addresses and, if they are not there, runs the core WITHOUT the
// takeover (no rollback). So this tool does not trust a rebuild to be laid out
// like the old one — it reads the new linker map (-Wl,-Map) and the new wasm
// and FAILS unless every address the block writes or hashes is unchanged:
//     PsxType   = Config + 53261        UseFrameSkip / UseFrameLimit
//     updatedDisplay = updated_display  palFlag = PSXDisplay + 40
//     gpuStat   = lGPUstatusRet         sbrk = sbrk_val
//     STATIC_SPANS hole = in_buffer .. in_buffer+16 (the dfsound wall-clock pair)
//     STATIC_END <= __heap_base - 64 KB (the hashed range ends inside static
//                   data) and the pad plugin's state `g` lies below it, so every
//                   pad/multitap byte is in the fingerprint
// (offsets: offsetof(PcsxConfig,PsxType) = 53261 with sizeof 0xd00e, and
// offsetof(PSXDisplay_t,PAL) = 40 with sizeof 0x4c — both sizes are checked
// against the map, so a struct change fails here rather than mis-pointing.)
// Only then is the ONE line that names the old build — `sigs:` — re-pointed at
// the same three strings in the new rodata (found by content; one common
// delta required). Everything else is copied unchanged, and the diff is
// printed so it can be read.
//
// USAGE  node reappend.mjs --line1 NEW.js --wasm NEW.wasm --map NEW.map --from dist/wasmpsx_worker.js --out OUT.js
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf('--' + n); if (i < 0 || i + 1 >= argv.length) throw new Error('--' + n + ' is required'); return argv[i + 1]; };
const fail = (m) => { console.error('[reappend] FAIL: ' + m); process.exit(1); };

const line1 = fs.readFileSync(arg('line1'), 'utf8').replace(/\n+$/, '');
if (line1.includes('\n')) fail('the new emcc output is not one line');
const from = fs.readFileSync(arg('from'), 'utf8');
const nl = from.indexOf('\n');
if (nl < 0) fail('--from has no appended block');
const block = from.slice(nl + 1);

// ── the new binary: data image + __heap_base ─────────────────────────────────
function wasmImage(file) {
  const b = fs.readFileSync(file); let p = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const sleb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= -1 << s; return r; };
  const mem = new Uint8Array(1 << 21); let heapBase = null, hi = 0;
  while (p < b.length) {
    const id = b[p++], size = leb(), end = p + size;
    if (id === 6) { const n = leb(); for (let i = 0; i < n; i++) { p += 2; const op = b[p++]; const v = op === 0x41 ? sleb() : null; p++; if (i === 0) heapBase = v; } }
    if (id === 11) { const n = leb(); for (let i = 0; i < n; i++) { const fl = leb(); if (fl !== 0) fail('passive/indexed data segment'); p++; const off = sleb(); p++; const len = leb(); mem.set(b.subarray(p, p + len), off); hi = Math.max(hi, off + len); p += len; } }
    p = end;
  }
  return { mem: mem.subarray(0, hi), heapBase };
}
const W = wasmImage(arg('wasm'));
if (!W.heapBase) fail('no __heap_base global in the new wasm');

// ── the new linker map: symbol -> [addr, size] ──────────────────────────────
const sym = new Map();
for (const ln of fs.readFileSync(arg('map'), 'utf8').split('\n')) {
  const m = /^\s*([0-9a-f]+)\s+([0-9a-f]+|-)\s+([0-9a-f]+)\s+(\S+)\s*$/.exec(ln);
  if (m && !m[4].includes('(')) sym.set(m[4], [parseInt(m[1], 16), parseInt(m[3], 16)]);
}
const at = (name, size) => {
  const s = sym.get(name); if (!s) fail('symbol ' + name + ' not in the map');
  if (size != null && s[1] !== size) fail(name + ' is ' + s[1] + ' bytes, the block assumes ' + size);
  return s[0];
};

// ── the block's own numbers ─────────────────────────────────────────────────
const num = (re, what) => { const m = re.exec(block); if (!m) fail('cannot find ' + what + ' in the block'); return +m[1]; };
const old = {
  PsxType: num(/\n\s*PsxType: (\d+),/, 'CORE.PsxType'),
  UseFrameSkip: num(/\n\s*UseFrameSkip: (\d+),/, 'CORE.UseFrameSkip'),
  UseFrameLimit: num(/\n\s*UseFrameLimit: (\d+),/, 'CORE.UseFrameLimit'),
  updatedDisplay: num(/\n\s*updatedDisplay: (\d+),/, 'CORE.updatedDisplay'),
  palFlag: num(/\n\s*palFlag: (\d+),/, 'CORE.palFlag'),
  gpuStat: num(/\n\s*gpuStat: (\d+),/, 'CORE.gpuStat'),
  sbrk: num(/\n\s*sbrk: (\d+),/, 'CORE.sbrk'),
  STATIC_END: num(/\n\s*var STATIC_END = (\d+);/, 'STATIC_END'),
};
const spans = /\n\s*var STATIC_SPANS = \[1024, (\d+), (\d+), STATIC_END\];/.exec(block);
if (!spans) fail('cannot find STATIC_SPANS');
const want = {
  PsxType: at('Config', 0xd00e) + 53261,
  UseFrameSkip: at('UseFrameSkip'), UseFrameLimit: at('UseFrameLimit'),
  updatedDisplay: at('updated_display'), palFlag: at('PSXDisplay', 0x4c) + 40,
  gpuStat: at('lGPUstatusRet'), sbrk: at('sbrk_val'),
};
const bad = [];
for (const k of Object.keys(want)) if (want[k] !== old[k]) bad.push(k + ': block ' + old[k] + ', new build ' + want[k]);
const inb = at('in_buffer', 8), lt = at('last_time', 8);
if (+spans[1] !== inb || +spans[2] !== inb + 16 || lt !== inb + 8) bad.push('STATIC_SPANS hole [' + spans[1] + ',' + spans[2] + ') is not in_buffer/last_time at ' + inb + '/' + lt);
const stackLow = W.heapBase - 65536;
if (old.STATIC_END > stackLow) bad.push('STATIC_END ' + old.STATIC_END + ' is past the end of static data (' + stackLow + ')');
const g = sym.get('g');
if (!g || g[0] + g[1] > old.STATIC_END) bad.push('the pad state g ' + JSON.stringify(g) + ' is not inside the fingerprinted range [1024,' + old.STATIC_END + ')');
for (const extra of ['mt']) { const s = sym.get(extra); if (s && s[0] + s[1] > old.STATIC_END) bad.push(extra + ' ' + JSON.stringify(s) + ' is not inside the fingerprinted range'); }
if (bad.length) fail('the new build is not laid out like the one the block was written for:\n  ' + bad.join('\n  '));

// ── re-point the signature guard ─────────────────────────────────────────────
const sigLine = /\n(\s*sigs: \[\[(\d+), 'SetAutoFrameCap %d %f\\n'\], \[(\d+), 'ES\\u0000'\], \[(\d+), 'CD-ROM ID: %\.9s\\n'\]\],)/.exec(block);
if (!sigLine) fail('cannot find the sigs: line');
const find = (s) => {
  const needle = Buffer.from(s, 'latin1'), hay = Buffer.from(W.mem.buffer, W.mem.byteOffset, W.mem.length);
  const i = hay.indexOf(needle); if (i < 0) fail('rodata string ' + JSON.stringify(s) + ' is not in the new wasm');
  if (hay.indexOf(needle, i + 1) >= 0) fail('rodata string ' + JSON.stringify(s) + ' is not unique');
  return i;
};
const a1 = find('SetAutoFrameCap %d %f\n\0'), a3 = find('CD-ROM ID: %.9s\n\0');
const d = a1 - +sigLine[2];
if (a3 - +sigLine[4] !== d) fail('the two unique signature strings moved by different amounts (' + d + ' vs ' + (a3 - +sigLine[4]) + ')');
const a2 = +sigLine[3] + d;
if (W.mem[a2] !== 0x45 || W.mem[a2 + 1] !== 0x53 || W.mem[a2 + 2] !== 0) fail('"ES\\0" is not at ' + a2 + ' (old ' + sigLine[3] + ' + ' + d + ')');
const newSig = sigLine[1].replace(sigLine[2], String(a1)).replace(sigLine[3], String(a2)).replace(sigLine[4], String(a3));
const outBlock = block.replace(sigLine[1], newSig);

fs.writeFileSync(arg('out'), line1 + '\n' + outBlock);
const oldL = block.split('\n'), newL = outBlock.split('\n');
let changed = 0;
for (let i = 0; i < oldL.length; i++) if (oldL[i] !== newL[i]) { changed++; console.log('[reappend] block line ' + (i + 2) + ':\n  - ' + oldL[i].trim() + '\n  + ' + newL[i].trim()); }
console.log('[reappend] OK — every address the block writes or hashes is unchanged (CORE, STATIC_SPANS, STATIC_END inside static data, g ' + JSON.stringify(g) + '); '
  + changed + ' block line(s) changed (signature delta ' + d + '); __heap_base ' + W.heapBase + '; ' + newL.length + ' block lines');
