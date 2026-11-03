// tools/pokemonarena_cries_test.mjs - Node test for pokemonarena/js/cries.js (ROM cries of SoulGold v1.1.1)
//
//   node tools/pokemonarena_cries_test.mjs                    # run everything (starts its own devserver on 8095 + one headless Chrome on CDP 9281)
//   ARENA_BROWSER=0 node tools/pokemonarena_cries_test.mjs    # Node only (skips the headless-Chrome parity section)
//   ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_cries_test.mjs   # rewrite pokemonarena/cries.golden.json (HASHES ONLY), then run
//   ARENA_ROM=/path/to.gba overrides the ROM path.   ARENA_PORT / ARENA_CDP_PORT override 8095 / 9281.
//
// AUDIO RULE: this test NEVER opens an audio device. Every browser it starts carries --mute-audio (headless_cdp.mjs adds it).
// Playback plumbing is proved with a hand-written test double of AudioContext (counts createBuffer/createBufferSource/start
// calls); the one real Web Audio object touched is an OfflineAudioContext used ONLY for createBuffer (it has no output
// device, and startRendering/start are never called). A static check below fails the run if this file ever constructs a
// real realtime AudioContext.
//
// What it proves, and what would make it fail:
//   * structure: the 737-entry cry table is where cries.js says it is, found independently by a whole-ROM scan; the reverse
//     table mirrors it; the 737 waves are sorted, distinct, packed (gap 0..3 B); every header is type 1 / no loop; both
//     copies of the DPCM delta table in the ROM equal i*i / -(16-i)^2; the ROM's own code agrees (pool words, pitch
//     immediates, GetCryIdBySpecies bounds and the +0x40 field, the 33-byte stride, the decoder loop) - code is pinned by
//     SHA-1 of the windows in cries.golden.json, never by committed words;
//   * decode: all 737 cries decode; per-cry and aggregate SHA-1 equal the golden; the same bytes decoded by a second
//     formulation written in this file agree; all 1038 legal species resolve to a cry;
//   * sanity metrics per cry (length, peak, DC, RMS, clipping, loop) with regression bounds, and block-seam continuity
//     (the raw first sample of each block sits next to the previous block's running value);
//   * negative controls: a flipped compressed byte changes that cry only, only inside that block, by a constant (mod 256)
//     offset to the end of the block; every structural guard has a corrupted-ROM case that must throw the named code and an
//     unmutated twin that must not; a wrong-length table throws CryTableError('wrong-length');
//   * mutants: ~30 one-token mutations of cries.js source (data: URL import) must each be caught by the same battery;
//     an identical-copy twin loaded the same way must pass it (so the harness cannot fail on its own);
//   * audio: AudioContext test double - cryToAudioBuffer builds buffers of the right length/rate/contents and starts
//     nothing; playCry starts exactly one source, none when the context is suspended/closed, refuses bad gain;
//   * browser: headless Chrome decodes the same ROM through romfetch.js and reproduces the aggregate hash with WebCrypto.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const GOLDEN_PATH = path.join(root, 'pokemonarena', 'cries.golden.json');
const CRIES_SRC = path.join(root, 'pokemonarena', 'js', 'cries.js');
const UPDATE = process.env.ARENA_UPDATE_GOLDEN === '1';
const BROWSER = process.env.ARENA_BROWSER !== '0';
const PORT = Number(process.env.ARENA_PORT || 8095);
const CDP_PORT = Number(process.env.ARENA_CDP_PORT || 9281);
const modUrl = (n) => pathToFileURL(path.join(root, 'pokemonarena', 'js', n)).href;
const C = await import(modUrl('cries.js'));
const T = await import(modUrl('tables.js'));
const ROMJS = await import(modUrl('rom.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail || ''); }
}
const head = (s) => console.log('\n== ' + s);
const sha1 = (...parts) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest('hex'); };
const hex = (n) => '0x' + n.toString(16);

const romBuf = fs.readFileSync(ROM_PATH);
const rom = new Uint8Array(romBuf.buffer, romBuf.byteOffset, romBuf.length);
const dv = new DataView(rom.buffer, rom.byteOffset, rom.length);
const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
const load = () => { try { const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8' }); return (r.stdout || '').trim() + '% cpu'; } catch (_e) { return 'load n/a'; } };
console.log('pokemonarena cries test; ROM', ROM_PATH, romBuf.length, 'B; machine load', load());
const t0 = Date.now();

// ---- test-local helpers (independent of cries.js so a mutated cries.js cannot hide a change) -------------------------
function hashInput(cry) {
  const n = cry.pcm.length, b = Buffer.alloc(16 + n);
  b.writeUInt32LE(cry.cryId >>> 0, 0); b.writeUInt32LE(cry.rateFixed >>> 0, 4); b.writeUInt32LE(n, 8);
  b.writeUInt32LE(cry.loop ? cry.loop.start >>> 0 : 0xffffffff, 12);
  Buffer.from(cry.pcm.buffer, cry.pcm.byteOffset, n).copy(b, 16);
  return b;
}
const cryHash = (cry) => sha1(hashInput(cry));
const aggregate = (hashes) => sha1(hashes.join('\n'));
const TABLE = 0x15cb0dc, REVERSE = 0x15cd368, NCRY = 737, BUS = 0x08000000;
const waveOf = (i) => u32(TABLE + 12 * i + 4) - BUS;
// second formulation of the codec: build the nibble stream first, then accumulate with a plain integer and wrap with & 255
function decodeSecond(bytes, w) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const n = d.getUint32(w + 12, true), out = new Int8Array(n);
  const delta = (i) => (i < 8 ? i * i : -((16 - i) * (16 - i)));
  for (let blk = 0; blk * 64 < n; blk++) {
    const src = w + 16 + blk * 33;
    const nibbles = [bytes[src + 1] & 15];
    for (let j = 2; j < 33; j++) nibbles.push(bytes[src + j] >> 4, bytes[src + j] & 15);
    let s = bytes[src];
    out[blk * 64] = s;
    for (let k = 0; k < nibbles.length && blk * 64 + 1 + k < n; k++) { s = (s + delta(nibbles[k])) & 255; out[blk * 64 + 1 + k] = s; }
  }
  return out;
}
function pct(arr, ps = [0, 5, 50, 95, 100]) { const a = Array.from(arr).sort((x, y) => x - y); return ps.map((p) => a[Math.min(a.length - 1, Math.floor(a.length * p / 100))]); }
function metrics(cry) {
  const p = cry.pcm, n = p.length;
  let s = 0, s2 = 0, pk = 0, clip = 0, seamSum = 0, seamN = 0, innerSum = 0, innerN = 0;
  for (let i = 0; i < n; i++) {
    const v = p[i]; s += v; s2 += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; if (v >= 127 || v <= -128) clip++;
    if (i) { const d = Math.abs(v - p[i - 1]); if (i % 64 === 0) { seamSum += d; seamN++; } else { innerSum += d; innerN++; } }
  }
  const mean = s / n;
  return { id: cry.cryId, n, rate: cry.sampleRate, dur: n / cry.sampleRate, peak: pk, dc: mean, rms: Math.sqrt(s2 / n), rmsAC: Math.sqrt(Math.max(0, s2 / n - mean * mean)), clip, clipFrac: clip / n, seamSum, seamN, innerSum, innerN };
}
function expectThrow(fn, code, name) {
  try { fn(); return { name, ok: false, detail: 'did not throw (wanted ' + code + ')' }; }
  catch (e) { return { name, ok: e && e.code === code, detail: (e && e.name) + '/' + (e && e.code) + ': ' + (e && e.message) }; }
}

/* ===== 0. ROM identity + file hygiene =============================================================================== */
head('0. identity and hygiene');
ok(crypto.createHash('sha256').update(rom).digest('hex') === ROMJS.PINNED.sha256, 'ROM sha256 equals the pin in rom.js');
const src = fs.readFileSync(CRIES_SRC, 'utf8');
ok(!/from\s+['"]node:|\brequire\s*\(|\bBuffer\b|\bprocess\.|\bdocument\b|\bwindow\b/.test(src.replace(/\/\/.*$/gm, '')), 'cries.js has no node:/require/Buffer/process/document/window outside comments (runs in Node and browser, no DOM)');
ok(!/new\s+(webkit)?AudioContext\s*\(/.test(src.replace(/\/\/.*$/gm, '')), 'cries.js never constructs an AudioContext (only product code may, after a user gesture)');
ok((src.match(/\.start\(/g) || []).length === 1, 'cries.js calls .start( exactly once, inside playCry', String((src.match(/\.start\(/g) || []).length));
{ const me = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'); const code = me.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!new RegExp('new\\s+(webkit)?Audio' + 'Context\\s*\\(').test(code), 'this test file never constructs a realtime AudioContext (OfflineAudioContext only, never rendered)');
  ok(typeof globalThis.AudioContext === 'undefined', 'Node has no AudioContext global: nothing in this process can reach an audio device'); }

/* ===== 1. structure =================================================================================================== */
head('1. structure of the cry table (verified from the ROM, not from a document)');
const table = C.locateCryTable(rom);
ok(table.offset === TABLE && table.count === NCRY && table.stride === 12, 'locateCryTable: 737 entries x 12 B at 0x15cb0dc');
ok(table.reverseOffset === REVERSE && REVERSE === TABLE + NCRY * 12, 'reverse table starts exactly where the forward table ends (0x15cd368)');
{ const runs = C.scanForCryTable(rom, 16);
  ok(runs.length === 1 && runs[0].offset === TABLE && runs[0].count === NCRY, 'a whole-ROM scan for `20 3c 00 00 <ptr> ff 00 ff 00` finds exactly one run: 737 entries at the pinned offset', JSON.stringify(runs)); }
{ let rev = 0; for (let i = 0; i < NCRY; i++) { const o = REVERSE + 12 * i; if (rom[o] === 0x30 && rom[o + 1] === 0x3c && u32(o + 4) === u32(TABLE + 12 * i + 4)) rev++; }
  ok(rev === NCRY, 'all 737 reverse entries are type 0x30 and point at the same wave as the forward entry', String(rev)); }
{ const starts = Array.from({ length: NCRY }, (_, i) => waveOf(i));
  ok(new Set(starts).size === NCRY && starts.every((v, i) => i === 0 || v > starts[i - 1]), 'wave pointers are 737 distinct, strictly ascending file offsets');
  ok(starts.every((v) => v % 4 === 0), 'every wave starts 4-byte aligned');
  let types = 0, status = 0, loops = 0, gapsOk = 0, rateInt = 0; const rates = {};
  for (let i = 0; i < NCRY; i++) {
    const w = starts[i], n = u32(w + 12), end = w + 16 + 33 * Math.ceil(n / 64);
    if (u16(w) === 1) types++; if (u16(w + 2) === 0) status++; if (u32(w + 8) === 0) loops++;
    if (u32(w + 4) % 1024 === 0) rateInt++;
    const r = u32(w + 4) / 1024; rates[r] = (rates[r] || 0) + 1;
    const next = i + 1 < NCRY ? starts[i + 1] : end; if (next - end >= 0 && next - end < 4) gapsOk++;
  }
  ok(types === NCRY && status === NCRY && loops === NCRY, 'every wave header: type 1 (compressed), status 0 (no loop), loopStart 0', `${types}/${status}/${loops}`);
  ok(gapsOk === NCRY, 'every wave ends within 0..3 bytes of the next wave\'s start (the waves tile one region, 33 B/64-sample framing consistent)', String(gapsOk));
  ok(rateInt === NCRY, 'every rate field is an exact multiple of 1024 (an integer Hz)');
  console.log('  info rates Hz:', JSON.stringify(rates), ' wave region', hex(table.waveStart), '-', hex(table.waveEnd)); }
{ let hi = 0, blocks = 0;
  for (let i = 0; i < NCRY; i++) { const w = waveOf(i), nb = Math.ceil(u32(w + 12) / 64); for (let b = 0; b < nb; b++) { blocks++; if (rom[w + 16 + 33 * b + 1] >> 4) hi++; } }
  ok(blocks === 168630 && hi === 0, 'byte 1 of every one of the 168,630 blocks has a zero HIGH nibble (the codec uses only its low nibble there)', `${blocks} blocks, ${hi} nonzero`); }
{ const exp = Array.from({ length: 16 }, (_, i) => (i < 8 ? i * i : -((16 - i) * (16 - i))));
  const copies = C.CRY_LAYOUT.deltaTable.offsets.map((o) => Array.from({ length: 16 }, (_, k) => (rom[o + k] << 24) >> 24).join() === exp.join());
  ok(copies.length === 2 && copies.every(Boolean), 'both ROM copies of the DPCM delta table equal i*i (i<8) / -(16-i)^2 (i>=8)', JSON.stringify(copies));
  ok(Array.from(C.DELTA).join() === exp.join(), 'cries.js DELTA equals the same formula table'); }
{ // ROM CODE agrees with the module's assumptions (numeric relations and field decodes; code windows are pinned by hash below)
  const sp = T.LAYOUT.species;
  ok(u32(0x2442b0) - BUS === TABLE && u32(0x2442b8) - BUS === REVERSE, 'PlayCryInternal literal pool (0x2442b0/0x2442b8) holds the forward and reverse table addresses');
  ok(u32(0x1f3388) === T.MAX_SPECIES_ID + 1 && u32(0x1f338c) - BUS === sp.offset && u32(0x1f3390) === NCRY, 'GetCryIdBySpecies literals: species bound 1578, species table base 0x7c7310, cry-id bound 737 (ids above it mean "no cry")');
  const adds = u16(0x1f3356), ldrh = u16(0x1f3358);
  ok((adds >> 11) === 0x06 && ((adds >> 8) & 7) === 3 && (adds & 255) === C.CRY_LAYOUT.speciesCryIdField && (ldrh >> 11) === 0x11, 'GetCryIdBySpecies does `adds r3,#0x40 ; ldrh r3,[r3,#0]`: the cry id is the u16 at species-record +0x40', hex(adds) + ' ' + hex(ldrh));
  const jt = (k) => u32(0xf3c55c + 4 * k) - BUS;
  ok(jt(0) === 0x244296 && jt(5) === 0x2441aa, 'PlayCryInternal jump table (0xf3c55c): mode 0 (normal) -> 0x244296, mode 5 -> 0x2441aa');
  // neutral pitch: the normal case ends in `movs r3,#imm8 ; lsls r3,r3,#6` with imm8<<6 = 15360 = 60*256
  const mv = u16(0x24428a), sh = u16(0x24428c);
  ok((mv >> 11) === 0x04 && ((mv >> 8) & 7) === 3 && (sh >> 11) === 0 && ((sh >> 6) & 31) === 6 && (((mv & 255) << 6) === C.CRY_PITCH.normal), 'normal-mode pitch immediate decodes to 15360 (`movs r3,#0xf0 ; lsls r3,r3,#6`)');
  ok(u32(0x2442c0) === C.CRY_PITCH.faint && ((u16(0x2441b2) >> 11) === 0x09) && ((((0x2441b2 + 4) & ~3) + (u16(0x2441b2) & 255) * 4) === 0x2442c0), 'mode-5 case loads its pitch from the pool word at 0x2442c0 = 14440 (CRY_PITCH.faint)'); }
const goldenCode = [
  { name: 'ARM DPCM decoder (hi nibble first)', offset: 0x287ee4, length: 0x40 },
  { name: 'ARM block stride (mov r1,#0x21 ; mla)', offset: 0x287fd0, length: 8 },
  { name: 'Thumb GetCryIdBySpecies', offset: 0x1f3338, length: 0x4e },
  { name: 'Thumb PlayCryInternal body', offset: 0x2440b8, length: 0x1f4 },
  { name: 'PlayCryInternal jump table (14 words)', offset: 0xf3c55c, length: 56 },
].map((c) => ({ ...c, sha1: sha1(rom.subarray(c.offset, c.offset + c.length)) }));

/* ===== 2. golden (hashes only) ======================================================================================= */
head('2. decode all cries; golden');
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
const legal = pack.roster.slice();
const all = []; { const t1 = performance.now(); for (let id = 1; id <= NCRY; id++) all.push(C.decodeCry(rom, id, { table })); console.log(`  info decoded 737 cries in ${(performance.now() - t1).toFixed(0)} ms`); }
const hashes = all.map(cryHash), agg = aggregate(hashes);
const mapLines = legal.map((id) => `${id}:${pack.species[id].cryId}:${hashes[pack.species[id].cryId - 1]}`);
const speciesMapSha1 = sha1(mapLines.join('\n'));
const rateHist = {}; for (const c of all) rateHist[c.sampleRate] = (rateHist[c.sampleRate] || 0) + 1;
const totals = { sampleCount: all.reduce((a, c) => a + c.sampleCount, 0), blocks: all.reduce((a, c) => a + Math.ceil(c.sampleCount / 64), 0) };
const newGolden = {
  note: 'HASHES, OFFSETS AND COUNTS ONLY. Nothing ROM-derived (no samples, no instruction words) is stored here. cries[i] is SHA-1 over u32le(cryId), u32le(rate*1024), u32le(sampleCount), u32le(loopStart|0xffffffff) then the int8 samples of cry i+1. aggregateSha1 = SHA-1 of the 737 hex digests joined by \\n. speciesMapSha1 = SHA-1 of "speciesId:cryId:cryHash" lines for the legal roster joined by \\n. Regenerate: ARENA_UPDATE_GOLDEN=1 node tools/pokemonarena_cries_test.mjs',
  rom: { sha256: ROMJS.PINNED.sha256, md5: ROMJS.PINNED.md5, length: ROMJS.PINNED.length },
  pins: {
    table: { offset: hex(TABLE), stride: 12, count: NCRY }, reverse: { offset: hex(REVERSE) },
    deltaTable: C.CRY_LAYOUT.deltaTable.offsets.map(hex), deltaTableUsed: hex(table.deltaOffset),
    waveRegion: { start: hex(table.waveStart), end: hex(table.waveEnd) },
    wave: { headerBytes: 16, blockBytes: 33, blockSamples: 64 }, speciesCryIdField: hex(C.CRY_LAYOUT.speciesCryIdField),
  },
  romCode: goldenCode.map((c) => ({ name: c.name, offset: hex(c.offset), length: c.length, sha1: c.sha1 })),
  rates: rateHist, totals, speciesCount: legal.length, aggregateSha1: agg, speciesMapSha1, cries: hashes,
};
let golden;
if (UPDATE) { fs.writeFileSync(GOLDEN_PATH, JSON.stringify(newGolden, null, 1) + '\n'); console.log('  !! golden REWRITTEN at', GOLDEN_PATH, '- this run proves nothing about the hashes; re-run without ARENA_UPDATE_GOLDEN'); golden = newGolden; }
else golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
ok(Array.isArray(golden.cries) && golden.cries.length === NCRY && /^[0-9a-f]{40}$/.test(golden.aggregateSha1), 'golden file is well formed (737 per-cry hashes + aggregate)');
ok(golden.rom.sha256 === ROMJS.PINNED.sha256 && golden.rom.length === ROMJS.PINNED.length, 'golden is for the pinned ROM');
ok(JSON.stringify(golden).length < 80000 && golden.cries.every((h) => /^[0-9a-f]{40}$/.test(h)) && Object.keys(golden).every((k) => ['note', 'rom', 'pins', 'romCode', 'rates', 'totals', 'speciesCount', 'aggregateSha1', 'speciesMapSha1', 'cries'].includes(k)), 'golden is small (< 80 KB, so it cannot hold samples), every per-cry entry is a 40-hex SHA-1, and only the documented keys are present');
{ const pins = golden.pins;
  ok(pins.table.offset === hex(C.CRY_LAYOUT.table.offset) && pins.table.stride === C.CRY_LAYOUT.table.stride && pins.table.count === C.CRY_LAYOUT.table.count, 'MANIFEST CHECK: cries.js CRY_LAYOUT.table equals the golden pins (offset/stride/count)');
  ok(pins.reverse.offset === hex(C.CRY_LAYOUT.reverse.offset) && JSON.stringify(pins.deltaTable) === JSON.stringify(C.CRY_LAYOUT.deltaTable.offsets.map(hex)), 'MANIFEST CHECK: reverse table and delta-table offsets equal the golden pins');
  ok(pins.wave.headerBytes === C.CRY_LAYOUT.wave.headerBytes && pins.wave.blockBytes === C.CRY_LAYOUT.wave.blockBytes && pins.wave.blockSamples === C.CRY_LAYOUT.wave.blockSamples && pins.speciesCryIdField === hex(C.CRY_LAYOUT.speciesCryIdField), 'MANIFEST CHECK: wave framing and species cry-id field equal the golden pins');
  ok(pins.waveRegion.start === hex(table.waveStart) && pins.waveRegion.end === hex(table.waveEnd) && pins.deltaTableUsed === hex(table.deltaOffset), 'located wave region and delta-table copy equal the golden pins'); }
{ const bad = goldenCode.filter((c, i) => golden.romCode[i].sha1 !== c.sha1 || golden.romCode[i].offset !== hex(c.offset) || golden.romCode[i].length !== c.length).map((c) => c.name);
  ok(bad.length === 0 && golden.romCode.length === goldenCode.length, 'the ROM code windows (decoder, stride, GetCryIdBySpecies, PlayCryInternal, jump table) hash to the golden', bad.join('; ')); }

/* ===== 3. the battery (shared by the real module and by every mutant) ================================================= */
const work = rom.slice();                      // scratch copy for corruption controls (patched and restored in place)
const env = { rom, work, golden, pack, legal, table };
function patch(list) { const saved = list.map(([o, bytes]) => [o, Array.from(work.subarray(o, o + bytes.length))]); for (const [o, bytes] of list) work.set(bytes, o); return () => { for (const [o, bytes] of saved) work.set(bytes, o); }; }
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

// FakeAudio: a hand-written test double of AudioContext. It records every call; nothing here can reach a device.
function makeCtx({ state = 'running', currentTime = 1.5 } = {}) {
  const log = { buffers: [], sources: [], gains: [], starts: [], stops: 0, connects: [] };
  const ctx = {
    state, currentTime, sampleRate: 48000, destination: { kind: 'destination' },
    createBuffer(ch, len, rate) { const data = new Float32Array(len); const b = { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: () => data, data }; log.buffers.push(b); return b; },
    createBufferSource() { const s = { buffer: null, playbackRate: { value: 1 }, loop: false, onended: null, connect(n) { log.connects.push(['source', n]); }, disconnect() {}, start(when) { log.starts.push(when); }, stop() { log.stops++; } }; log.sources.push(s); return s; },
    createGain() { const g = { gain: { value: 1 }, connect(n) { log.connects.push(['gain', n]); }, disconnect() {} }; log.gains.push(g); return g; },
  };
  return { ctx, log };
}
const memStore = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };

async function battery(mod, E) {
  const out = [];
  const add = (name, cond, detail) => out.push({ name, ok: !!cond, detail });
  const step = async (name, fn) => { try { const r = await fn(); if (r && typeof r === 'object' && 'ok' in r) add(name, r.ok, r.detail); else add(name, r); } catch (e) { add(name, false, 'threw ' + (e && e.name) + ': ' + (e && e.message)); } };
  const W = E.work;
  const tbl = mod.locateCryTable(E.rom);

  // --- decode + golden ---------------------------------------------------------------------------------------------
  let cries = null;
  await step('decode: all 737 cries decode', () => { cries = []; for (let id = 1; id <= NCRY; id++) cries.push(mod.decodeCry(E.rom, id, { table: tbl })); return cries.length === NCRY; });
  if (!cries) return out;
  const hs = cries.map(cryHash);
  await step('golden: every per-cry SHA-1 equals the golden', () => { const bad = []; hs.forEach((h, i) => { if (h !== E.golden.cries[i]) bad.push(i + 1); }); return { ok: bad.length === 0, detail: bad.length + ' differ, first ' + bad.slice(0, 5) }; });
  await step('golden: aggregate SHA-1 equals the golden', () => aggregate(hs) === E.golden.aggregateSha1);
  await step('decode: rate = header/1024 for every cry; rate histogram and totals equal the golden', () => {
    const hist = {}; let tot = 0, blocks = 0, badRate = 0;
    for (const c of cries) { hist[c.sampleRate] = (hist[c.sampleRate] || 0) + 1; tot += c.sampleCount; blocks += Math.ceil(c.sampleCount / 64); if (c.sampleRate !== u32(waveOf(c.cryId - 1) + 4) / 1024 || c.rateFixed !== u32(waveOf(c.cryId - 1) + 4)) badRate++; }
    return badRate === 0 && JSON.stringify(hist) === JSON.stringify(E.golden.rates) && tot === E.golden.totals.sampleCount && blocks === E.golden.totals.blocks;
  });
  await step('decode: sampleCount equals the ROM header count; pcm is an Int8Array of exactly that length', () => cries.every((c) => c.pcm instanceof Int8Array && c.pcm.length === c.sampleCount && c.sampleCount === u32(waveOf(c.cryId - 1) + 12) && c.index === c.cryId - 1 && c.wave === waveOf(c.cryId - 1)));
  await step('decode: no cry loops (loop === null for all 737; status is 0 everywhere)', () => cries.every((c) => c.loop === null));
  await step('decode: duration = sampleCount / rate', () => cries.every((c) => Math.abs(c.durationSeconds - c.sampleCount / c.sampleRate) < 1e-9));
  await step('decode: deterministic - a second decode (fresh table, no reuse) is identical for 40 cries', () => { for (let id = 1; id <= NCRY; id += 19) { const a = mod.decodeCry(E.rom, id); if (cryHash(a) !== hs[id - 1]) return false; } return true; });
  await step('decode: cryHashBytes equals the test-local hash input for 40 cries', () => { for (let id = 1; id <= NCRY; id += 19) { const a = Buffer.from(mod.cryHashBytes(cries[id - 1])); if (!a.equals(hashInput(cries[id - 1]))) return false; } return true; });
  await step('decode: a second formulation (nibble stream, plain integer, & 255) agrees byte for byte on all 737', () => { for (let id = 1; id <= NCRY; id++) { const b = decodeSecond(E.rom, waveOf(id - 1)); const a = cries[id - 1].pcm; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { ok: false, detail: `cry ${id} sample ${i}` }; } return true; });

  // --- sanity metrics ----------------------------------------------------------------------------------------------
  const M = cries.map(metrics);
  await step('metrics: every cry is audible (peak >= 40, rms >= 5), bounded (n 1000..60000) and not DC-dominated (|dc| < 32)', () => M.every((m) => m.peak >= 40 && m.rms >= 5 && m.n >= 1000 && m.n <= 60000 && Math.abs(m.dc) < 32));
  await step('metrics: clipping is rare (no cry has >= 6% of samples at +-full scale - measured max is 4.1% - and at most 200 of the 737 touch full scale - measured 156)', () => M.every((m) => m.clipFrac < 0.06) && M.filter((m) => m.clip > 0).length <= 200);
  await step('metrics: rates are exactly 10512/11025/13000/13379 Hz and durations 0.1..4 s', () => M.every((m) => [10512, 11025, 13000, 13379].includes(m.rate) && m.dur > 0.1 && m.dur < 4));
  const seam = M.reduce((a, m) => a + m.seamSum, 0) / M.reduce((a, m) => a + m.seamN, 0), inner = M.reduce((a, m) => a + m.innerSum, 0) / M.reduce((a, m) => a + m.innerN, 0);
  await step('metrics: block seams are continuous - mean |jump| across a 64-sample seam <= 1.3x the mean inner step (measured 1.09; a wrong anchor byte measures > 2)', () => ({ ok: seam / inner <= 1.3, detail: `seam ${seam.toFixed(2)} inner ${inner.toFixed(2)} ratio ${(seam / inner).toFixed(3)}` }));

  // --- species mapping ---------------------------------------------------------------------------------------------
  await step('species: every one of the legal species resolves to a cry whose id is the pack cryId', () => { for (const id of E.legal) { const c = mod.cryForSpecies(E.pack, E.rom, id, { table: tbl }); if (!c || c.cryId !== E.pack.species[id].cryId || c.speciesId !== id || cryHash(c) !== hs[c.cryId - 1]) return { ok: false, detail: 'species ' + id }; } return E.legal.length === E.golden.speciesCount; });
  await step('species: species->cry map hash equals the golden', () => sha1(E.legal.map((id) => `${id}:${E.pack.species[id].cryId}:${hs[E.pack.species[id].cryId - 1]}`).join('\n')) === E.golden.speciesMapSha1);
  await step('species: null result for species 0, a removed slot, cryId 0 and cryId 738 (the ROM returns 0 above 737)', () => {
    const fake = { species: [null, { cryId: 0 }, { cryId: 738 }, { cryId: 65535 }, { cryId: 24 }, { cryId: 1.5 }] };
    return mod.cryForSpecies(E.pack, E.rom, 0, { table: tbl }) === null && mod.cryForSpecies(E.pack, E.rom, 21, { table: tbl }) === null && mod.cryForSpecies(fake, E.rom, 1, { table: tbl }) === null && mod.cryForSpecies(fake, E.rom, 2, { table: tbl }) === null && mod.cryForSpecies(fake, E.rom, 3, { table: tbl }) === null && mod.cryForSpecies(fake, E.rom, 5, { table: tbl }) === null && mod.cryForSpecies(fake, E.rom, 4, { table: tbl }).cryId === 24 && mod.cryForSpecies(fake, E.rom, 99, { table: tbl }) === null;
  });

  // --- structure of the located table ------------------------------------------------------------------------------
  await step('locate: offsets equal the golden pins', () => tbl.offset === TABLE && tbl.count === NCRY && tbl.reverseOffset === REVERSE && hex(tbl.waveStart) === E.golden.pins.waveRegion.start && hex(tbl.waveEnd) === E.golden.pins.waveRegion.end && hex(tbl.deltaOffset) === E.golden.pins.deltaTableUsed);

  // --- negative controls: each guard has a corrupted-ROM case that must throw the NAMED code, and a pristine twin ----------
  const w50 = waveOf(50), n50 = u32(w50 + 12), e5 = TABLE + 5 * 12;
  const cases = [
    ['rom-length', 'ROM one byte short', () => mod.locateCryTable(E.rom.subarray(0, E.rom.length - 1)), null],
    ['rom-header', 'cartridge title byte flipped', () => mod.locateCryTable(W), [[0xa0, [W[0xa0] ^ 1]]]],
    ['bad-entry', 'entry 5 type byte 0x20 -> 0x21', () => mod.locateCryTable(W), [[e5, [0x21]]]],
    ['bad-entry', 'entry 5 key byte 0x3c -> 0x3d', () => mod.locateCryTable(W), [[e5 + 1, [0x3d]]]],
    ['bad-entry', 'entry 5 envelope sustain 0xff -> 0xfe', () => mod.locateCryTable(W), [[e5 + 10, [0xfe]]]],
    ['bad-entry', 'entry 5 wave pointer points outside the ROM', () => mod.locateCryTable(W), [[e5 + 4, le32(0x0a000000)]]],
    ['reverse-mismatch', 'reverse entry 100 pointer differs from forward entry 100', () => mod.locateCryTable(W), [[REVERSE + 100 * 12 + 4, [W[REVERSE + 100 * 12 + 4] ^ 4]]]],
    ['reverse-mismatch', 'reverse entry 3 type 0x30 -> 0x20', () => mod.locateCryTable(W), [[REVERSE + 3 * 12, [0x20]]]],
    ['wave-header', 'wave 50 type 1 -> 2', () => mod.locateCryTable(W), [[w50, [2]]]],
    ['wave-header', 'wave 50 status 0 -> 0x1234', () => mod.locateCryTable(W), [[w50 + 2, [0x34, 0x12]]]],
    ['wave-header', 'wave 50 sample count 0', () => mod.locateCryTable(W), [[w50 + 12, le32(0)]]],
    ['wave-header', 'wave 50 sample count 2^24', () => mod.locateCryTable(W), [[w50 + 12, le32(1 << 24)]]],
    ['wave-header', 'wave 50 rate 1 kHz', () => mod.locateCryTable(W), [[w50 + 4, le32(1000 * 1024)]]],
    ['wave-header', 'wave 50 looped (status 0x4000) with loop start past its end', () => mod.locateCryTable(W), [[w50 + 2, [0, 0x40]], [w50 + 8, le32(n50 + 5)]]],
    ['wave-gap', 'wave 50 sample count + 64 (one block too long: overlaps the next wave)', () => mod.locateCryTable(W), [[w50 + 12, le32(n50 + 64)]]],
    ['wave-gap', 'wave 50 sample count - 64 (one block too short: 33-byte hole)', () => mod.locateCryTable(W), [[w50 + 12, le32(n50 - 64)]]],
    ['delta-table', 'a byte of BOTH delta-table copies corrupted', () => mod.locateCryTable(W), mod.CRY_LAYOUT.deltaTable.offsets.map((o) => [o + 9, [W[o + 9] ^ 1]])],
    ['wrong-length', 'declared count 736 (table is one longer)', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE, stride: 12, count: 736 }, reverse: { offset: REVERSE } } }), null],
    ['wrong-length', 'declared count 738 (runs into the reverse table)', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE, stride: 12, count: 738 }, reverse: { offset: REVERSE } } }), null],
    ['wrong-length', 'declared count 1', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE, stride: 12, count: 1 }, reverse: { offset: REVERSE } } }), null],
    ['wrong-length', 'declared count 0', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE, stride: 12, count: 0 }, reverse: { offset: REVERSE } } }), null],
    ['bad-entry', 'table offset misaligned by one byte', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE + 1, stride: 12, count: NCRY }, reverse: { offset: REVERSE } } }), null],
    ['wrong-length', 'table offset 37 entries before the end of the forward table, count 100 (runs into the reverse table)', () => mod.locateCryTable(E.rom, { layout: { table: { offset: TABLE + 12 * 700, stride: 12, count: 100 }, reverse: { offset: REVERSE } } }), null],
  ];
  for (const [code, name, fn, patches] of cases) {
    let restore = null;
    try { if (patches) restore = patch(patches); const r = expectThrow(fn, code, `control: ${name} -> ${code}`); add(r.name, r.ok, r.detail); }
    finally { if (restore) restore(); }
  }
  await step('twin: the pristine scratch copy (all patches restored) still locates and hashes like the original', () => { const tw = mod.locateCryTable(W); return tw.count === NCRY && sha1(Buffer.from(W.buffer, W.byteOffset, W.length)) === sha1(Buffer.from(E.rom.buffer, E.rom.byteOffset, E.rom.length)); });
  await step('twin: ONE delta-table copy corrupted is tolerated (the other copy is used) and decodes identically', () => { const o = mod.CRY_LAYOUT.deltaTable.offsets[0]; const r = patch([[o + 9, [W[o + 9] ^ 1]]]); try { const t2 = mod.locateCryTable(W); return t2.deltaOffset === mod.CRY_LAYOUT.deltaTable.offsets[1] && cryHash(mod.decodeCry(W, 24, { table: t2 })) === hs[23]; } finally { r(); } });
  for (const bad of [0, 738, -1, 1.5, '3', NaN, undefined, null, 2 ** 32 + 1]) {
    await step(`control: decodeCry(${String(bad)}) -> CryError cry-id`, () => { const r = expectThrow(() => mod.decodeCry(E.rom, bad, { table: tbl }), 'cry-id', ''); return r; });
  }
  await step('twin: decodeCry accepts the first and last ids (1 and 737)', () => mod.decodeCry(E.rom, 1, { table: tbl }).cryId === 1 && mod.decodeCry(E.rom, 737, { table: tbl }).cryId === 737);

  // --- compressed-byte flip: changes that cry only, only inside that block, by a constant offset ------------------------
  await step('control: flipping one compressed byte changes THAT cry only, only inside its 64-sample block, by a constant (mod 256) offset', () => {
    const id = 24, blk = 10, w = waveOf(id - 1), at = w + 16 + 33 * blk + 12;       // byte 12 of block 10
    const r = patch([[at, [W[at] ^ 0x10]]]);
    try {
      const t2 = mod.locateCryTable(W); const flipped = mod.decodeCry(W, id, { table: t2 });
      const a = cries[id - 1].pcm, b = flipped.pcm; let first = -1, last = -1; const diffs = new Set();
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (first < 0) first = i; last = i; diffs.add((b[i] - a[i]) & 255); }
      const start = blk * 64;
      const confined = first >= start && last < start + 64, constant = diffs.size === 1;
      const neighbours = [id - 1, id + 1].every((k) => cryHash(mod.decodeCry(W, k, { table: t2 })) === hs[k - 1]);
      return { ok: first === start + 22 && confined && constant && neighbours && cryHash(flipped) !== hs[id - 1], detail: `first ${first - start} last ${last - start} offsets ${[...diffs]}` };
    } finally { r(); }
  });
  await step('control: flipping the RAW first-sample byte of a block shifts the whole block by a constant and nothing else', () => {
    const id = 141, blk = 3, w = waveOf(id - 1), at = w + 16 + 33 * blk;
    const r = patch([[at, [W[at] ^ 0x08]]]);
    try {
      const flipped = mod.decodeCry(W, id, { table: mod.locateCryTable(W) }); const a = cries[id - 1].pcm, b = flipped.pcm; const diffs = new Set(); let changed = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed++; diffs.add((b[i] - a[i]) & 255); if (i < blk * 64 || i >= blk * 64 + 64) return false; }
      return changed === 64 && diffs.size === 1 && (diffs.has(8) || diffs.has(248));
    } finally { r(); }
  });

  // --- audio: test double only --------------------------------------------------------------------------------------
  const cry = cries[23];                                    // cryId 24
  await step('audio: cryToAudioBuffer builds ONE mono buffer with the right length, rate and contents, and starts nothing', () => {
    const { ctx, log } = makeCtx(); const b = mod.cryToAudioBuffer(ctx, cry);
    const d = b.getChannelData(0); let exact = d.length === cry.pcm.length;
    for (let i = 0; i < cry.pcm.length && exact; i++) if (d[i] !== cry.pcm[i] / 128) exact = false;
    return log.buffers.length === 1 && b.numberOfChannels === 1 && b.length === cry.sampleCount && b.sampleRate === cry.sampleRate && exact && log.sources.length === 0 && log.starts.length === 0 && log.gains.length === 0 && Math.min(...d) >= -1 && Math.max(...d) <= 127 / 128;
  });
  await step('audio: cryToAudioBuffer maps -128 to -1 and 127 to 127/128 exactly', () => {
    const { ctx } = makeCtx(); const b = mod.cryToAudioBuffer(ctx, { pcm: Int8Array.of(-128, 127, 0, -1, 1), sampleRate: 10512, sampleCount: 5 }).getChannelData(0);
    return b[0] === -1 && b[1] === 127 / 128 && b[2] === 0 && b[3] === -1 / 128 && b[4] === 1 / 128;
  });
  await step('audio: cryToAudioBuffer refuses a rate Web Audio cannot take and an empty cry (named errors)', () => {
    const { ctx } = makeCtx(); const a = expectThrow(() => mod.cryToAudioBuffer(ctx, { pcm: Int8Array.of(1, 2), sampleRate: 4000 }), 'rate', 'rate'); const b = expectThrow(() => mod.cryToAudioBuffer(ctx, { pcm: new Int8Array(0), sampleRate: 10512 }), 'cry', 'empty'); const c = expectThrow(() => mod.cryToAudioBuffer({}, cry), 'audio-context', 'ctx');
    return { ok: a.ok && b.ok && c.ok, detail: a.detail + ' | ' + b.detail + ' | ' + c.detail };
  });
  await step('audio: playCry on a running context starts EXACTLY ONE source, at `when`, through source -> gain -> destination', () => {
    const { ctx, log } = makeCtx(); const h = mod.playCry(ctx, cry, { when: 2.25, gain: 0.3 });
    const dest = log.connects.map((c) => c[0] + '>' + (c[1] === ctx.destination ? 'destination' : c[1] === log.gains[0] ? 'gain' : '?')).join();
    return !!h && log.starts.length === 1 && log.starts[0] === 2.25 && log.sources.length === 1 && log.gains.length === 1 && log.gains[0].gain.value === 0.3 && log.sources[0].playbackRate.value === 1 && log.sources[0].buffer === h.buffer && dest === 'source>gain,gain>destination' && Math.abs(h.duration - cry.sampleCount / cry.sampleRate) < 1e-9 && log.sources[0].loop === false;
  });
  await step('audio: playCry defaults - start time = ctx.currentTime, gain = DEFAULT_CRY_GAIN (<= 0.6)', () => { const { ctx, log } = makeCtx({ currentTime: 7.5 }); mod.playCry(ctx, cry); return log.starts.length === 1 && log.starts[0] === 7.5 && log.gains[0].gain.value === mod.DEFAULT_CRY_GAIN && mod.DEFAULT_CRY_GAIN <= 0.6 && mod.DEFAULT_CRY_GAIN > 0; });
  await step('audio: a suspended or closed context starts NOTHING (returns null, no buffer source created)', () => {
    const out2 = [];
    for (const state of ['suspended', 'closed', 'interrupted']) { const { ctx, log } = makeCtx({ state }); const h = mod.playCry(ctx, cry); out2.push(h === null && log.starts.length === 0 && log.sources.length === 0); }
    return out2.every(Boolean);
  });
  await step('audio: faint mode lowers the playback rate by 2^(-920/3072) (~0.8125); an explicit pitch overrides the mode', () => {
    const a = makeCtx(); mod.playCry(a.ctx, cry, { mode: 'faint' }); const b = makeCtx(); mod.playCry(b.ctx, cry, { pitch: 15360 + 3072 }); const c = makeCtx(); const h = mod.playCry(c.ctx, cry, { mode: 'faint' });
    const want = Math.pow(2, -920 / 3072);
    return Math.abs(a.log.sources[0].playbackRate.value - want) < 1e-12 && want > 0.81 && want < 0.82 && Math.abs(b.log.sources[0].playbackRate.value - 2) < 1e-12 && Math.abs(h.duration - cry.sampleCount / cry.sampleRate / want) < 1e-9 && a.log.starts.length === 1;
  });
  await step('audio: playCry refuses bad gain, bad mode and a context without createBufferSource (named errors), starting nothing', () => {
    const outs = [];
    for (const [opts, code] of [[{ gain: 1.5 }, 'gain'], [{ gain: -0.1 }, 'gain'], [{ gain: NaN }, 'gain'], [{ gain: '0.5' }, 'gain'], [{ mode: 'roar' }, 'mode'], [{ pitch: NaN }, 'pitch']]) { const { ctx, log } = makeCtx(); const r = expectThrow(() => mod.playCry(ctx, cry, opts), code, JSON.stringify(opts)); outs.push(r.ok && log.starts.length === 0); }
    outs.push(expectThrow(() => mod.playCry({}, cry), 'audio-context', 'noctx').ok);
    return outs.every(Boolean);
  });
  await step('audio: gain 0 and gain 1 (the bounds) are accepted', () => { const a = makeCtx(); const b = makeCtx(); mod.playCry(a.ctx, cry, { gain: 0 }); mod.playCry(b.ctx, cry, { gain: 1 }); return a.log.starts.length === 1 && b.log.starts.length === 1 && a.log.gains[0].gain.value === 0 && b.log.gains[0].gain.value === 1; });
  await step('audio: a prebuilt buffer is reused (no second createBuffer) and a looping cry sets loop points in seconds', () => {
    const { ctx, log } = makeCtx(); const buf = mod.cryToAudioBuffer(ctx, cry); mod.playCry(ctx, cry, { buffer: buf });
    const l = makeCtx(); mod.playCry(l.ctx, { ...cry, loop: { start: 1000, end: 2000 } }); const s = l.log.sources[0];
    return log.buffers.length === 1 && log.starts.length === 1 && s.loop === true && Math.abs(s.loopStart - 1000 / cry.sampleRate) < 1e-12 && Math.abs(s.loopEnd - 2000 / cry.sampleRate) < 1e-12;
  });

  // --- sound switch: MUTED by default -------------------------------------------------------------------------------
  await step('sound: default is OFF (no key, missing storage, throwing storage, any value but "1")', () => {
    const thrower = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    return mod.SOUND_KEY === 'arena.sound' && mod.isSoundOn(memStore()) === false && mod.isSoundOn(null) === false && mod.isSoundOn(thrower) === false && mod.isSoundOn(memStore({ 'arena.sound': '0' })) === false && mod.isSoundOn(memStore({ 'arena.sound': 'true' })) === false && mod.isSoundOn(memStore({ 'arena.sound': '1' })) === true && mod.isSoundOn(undefined) === false;
  });
  await step('sound: setSoundOn round-trips and never throws', () => { const s = memStore(); const a = mod.setSoundOn(true, s), on = mod.isSoundOn(s); const b = mod.setSoundOn(false, s), off = mod.isSoundOn(s); return a && b && on && !off && mod.setSoundOn(true, { setItem() { throw new Error('x'); } }) === false && mod.setSoundOn(true, null) === false; });
  await step('sound: playCryIfSoundOn starts nothing while muted, one source once switched on', () => {
    const m = makeCtx(); const r1 = mod.playCryIfSoundOn(m.ctx, cry, { storage: memStore() });
    const o = makeCtx(); const r2 = mod.playCryIfSoundOn(o.ctx, cry, { storage: memStore({ 'arena.sound': '1' }) });
    return r1 === null && m.log.starts.length === 0 && m.log.sources.length === 0 && !!r2 && o.log.starts.length === 1;
  });
  await step('wav: cryToWav is a valid 8-bit mono WAV whose data bytes are pcm+128 and whose header carries rate and length', () => {
    const w = mod.cryToWav(cry), d = new DataView(w.buffer, w.byteOffset, w.length), tag = (o) => String.fromCharCode(w[o], w[o + 1], w[o + 2], w[o + 3]);
    let same = w.length === 44 + cry.pcm.length; for (let i = 0; i < cry.pcm.length && same; i++) if (w[44 + i] !== ((cry.pcm[i] + 128) & 255)) same = false;
    return tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data' && d.getUint32(4, true) === 36 + cry.pcm.length && d.getUint32(24, true) === cry.sampleRate && d.getUint16(34, true) === 8 && d.getUint16(22, true) === 1 && d.getUint32(40, true) === cry.pcm.length && same;
  });
  await step('pitch law: neutral 15360 -> 1, +12 semitones -> 2, -12 -> 0.5; faint 14440 -> ~0.8125; non-finite throws', () => Math.abs(mod.cryPlaybackRate(15360) - 1) < 1e-15 && Math.abs(mod.cryPlaybackRate(15360 + 3072) - 2) < 1e-12 && Math.abs(mod.cryPlaybackRate(15360 - 3072) - 0.5) < 1e-12 && Math.abs(mod.cryPlaybackRate(mod.CRY_PITCH.faint) - 0.8125) < 3e-4 && expectThrow(() => mod.cryPlaybackRate(Infinity), 'pitch', '').ok);
  return out;
}

head('3. battery on the real module');
const real = await battery(C, env);
for (const r of real) ok(r.ok, r.name, r.detail);
console.log(`  ${real.length} battery checks on the real module`);

/* ===== 4. metrics report (distribution) =============================================================================== */
head('4. sanity-metric distribution over all 737 cries (info; bounds are asserted in the battery)');
{
  const M = all.map(metrics);
  const row = (label, arr, f = (x) => x) => console.log(`  ${label.padEnd(26)} min/p5/median/p95/max = ${pct(arr).map((x) => f(x)).join(' / ')}`);
  row('length (samples)', M.map((m) => m.n)); row('duration (s)', M.map((m) => m.dur), (x) => x.toFixed(3));
  row('peak |x| (0..128)', M.map((m) => m.peak)); row('DC offset (mean)', M.map((m) => m.dc), (x) => x.toFixed(2));
  row('RMS', M.map((m) => m.rms), (x) => x.toFixed(1)); row('clipped samples', M.map((m) => m.clip)); row('clipped fraction', M.map((m) => m.clipFrac), (x) => x.toFixed(4));
  console.log(`  cries touching full scale: ${M.filter((m) => m.clip > 0).length}; peak == 128: ${M.filter((m) => m.peak === 128).length}; loops: ${all.filter((c) => c.loop).length}; shared-wave species: ${new Set(legal.map((id) => pack.species[id].cryId)).size} distinct cry ids over ${legal.length} legal species`);
  const seam = M.reduce((a, m) => a + m.seamSum, 0) / M.reduce((a, m) => a + m.seamN, 0), inner = M.reduce((a, m) => a + m.innerSum, 0) / M.reduce((a, m) => a + m.innerN, 0);
  console.log(`  block-seam continuity: mean |jump| at seams ${seam.toFixed(2)} vs mean inner step ${inner.toFixed(2)} (ratio ${(seam / inner).toFixed(3)})`);
  // controls for the continuity metric itself: a decode that anchors each block on the WRONG byte (byte 2 instead of byte 0) must score badly,
  // and so must one whose blocks are read one byte late. (Reading byte 1's always-zero high nibble as an extra sample only inserts a duplicate
  // sample, so continuity cannot tell that variant from the real decode - it is NOT claimed to.)
  const D = C.DELTA;
  const ratioFor = (anchorByte, blockShift) => {
    let sSum = 0, sN = 0, iSum = 0, iN = 0;
    for (let id = 1; id <= NCRY; id += 7) {
      const w = waveOf(id - 1), n = u32(w + 12), out = new Int8Array(n);
      for (let p = 0, src = w + 16 + blockShift; p < n; p += 64, src += 33) {
        let acc = (rom[src + anchorByte] << 24) >> 24; out[p] = acc; let q = p + 1;
        if (q < n) { acc = ((acc + D[rom[src + 1] & 15]) << 24) >> 24; out[q++] = acc; }
        for (let j = 2; j < 33 && q < n; j++) { acc = ((acc + D[rom[src + j] >> 4]) << 24) >> 24; out[q++] = acc; if (q < n) { acc = ((acc + D[rom[src + j] & 15]) << 24) >> 24; out[q++] = acc; } }
      }
      for (let i = 1; i < n; i++) { const d = Math.abs(out[i] - out[i - 1]); if (i % 64 === 0) { sSum += d; sN++; } else { iSum += d; iN++; } }
    }
    return (sSum / sN) / (iSum / iN);
  };
  const rightAnchor = ratioFor(0, 0), wrongAnchor = ratioFor(2, 0), shifted = ratioFor(0, 1);
  console.log(`  control (every 7th cry): seam/inner ratio  correct ${rightAnchor.toFixed(3)}  anchor on byte 2 ${wrongAnchor.toFixed(3)}  blocks read one byte late ${shifted.toFixed(3)}`);
  ok(Math.abs(rightAnchor - 1.09) < 0.15 && wrongAnchor > 2 && shifted > 2, 'the continuity metric discriminates: a wrong anchor byte or a one-byte block shift scores > 2 where the real decode scores ~1.09', `${rightAnchor.toFixed(3)} / ${wrongAnchor.toFixed(3)} / ${shifted.toFixed(3)}`);
}

/* ===== 5. mutants of cries.js ========================================================================================= */
head('5. mutation matrix: every one-token mutant of cries.js must be caught by the battery');
const romUrlAbs = modUrl('rom.js');
async function loadVariant(text) {
  const withAbs = text.replace("from './rom.js'", `from '${romUrlAbs}'`);
  if (withAbs === text) throw new Error('import anchor not found');
  return import('data:text/javascript;base64,' + Buffer.from(withAbs, 'utf8').toString('base64'));
}
function sub(from, to) { return (s) => { const i = s.indexOf(from); if (i < 0 || s.indexOf(from, i + 1) >= 0) throw new Error('mutation anchor must occur exactly once: ' + from); return s.slice(0, i) + to + s.slice(i + from.length); }; }
const MUTANTS = [
  ['swap the nibble order (low first)', (s) => sub('@@HI@@', 'D[b & 15]')(sub('D[b & 15]', 'D[b >> 4]')(sub('D[b >> 4]', '@@HI@@')(s)))],
  ['byte 1 uses its HIGH nibble', sub('D[bytes[src + 1] & 15]', 'D[bytes[src + 1] >> 4]')],
  ['block is 32 bytes', sub('blockBytes: 33,', 'blockBytes: 32,')],
  ['block is 63 samples', sub('blockSamples: 64,', 'blockSamples: 63,')],
  ['cry id is the table index (no -1)', sub('const index = cryId - 1, w', 'const index = cryId, w')],
  ['rate divisor 1000', sub('const sampleRate = rateFixed / 1024;', 'const sampleRate = rateFixed / 1000;')],
  ['every wave reported as looping', sub("status === 0x4000 ? { start", 'status === 0 ? { start')],
  ['int8 -> float divides by 127', sub('out[i] = pcm[i] / 128;', 'out[i] = pcm[i] / 127;')],
  ['delta formula negative half off by one', sub('-((16 - i) * (16 - i))', '-((15 - i) * (15 - i))')],
  ['delta formula positive half linear', sub('(i < 8 ? i * i : ', '(i < 8 ? i : ')],
  ['no contiguity guard between waves', sub('if (gap < 0 || gap > 3)', 'if (false)')],
  ['no reverse-table mirror guard', sub('if (!entryShape(dv, bytes, o, R) || dv.getUint32(o + 4, true) - 0x08000000 !== waves[i])', 'if (false)')],
  ['no wave type guard', sub('if (type !== 1)', 'if (false)')],
  ['no wave status guard', sub('if (status !== 0 && status !== 0x4000)', 'if (false)')],
  ['no wave sample-count guard', sub('if (n < 1 || n > W.maxSamples)', 'if (false)')],
  ['no wave rate guard', sub('if (!(rate >= CRY_MIN_RATE && rate <= CRY_MAX_RATE)) throw new CryTableError', 'if (false) throw new CryTableError')],
  ['cryToAudioBuffer rate guard removed', sub('if (!(rate >= CRY_MIN_RATE && rate <= CRY_MAX_RATE)) throw new CryError', 'if (false) throw new CryError')],
  ['no delta-table guard', sub('if (deltaOffset < 0)', 'if (false)')],
  ['no "table is longer than declared" guard', sub('if (entryShape(dv, bytes, offset + count * stride, F))', 'if (false)')],
  ['no "declared count runs into the reverse table" guard', sub('if (entryShape(dv, bytes, o, R)) throw', 'if (false) throw')],
  ['entry shape ignores the key byte', sub('bytes[o + 1] !== CRY_LAYOUT.entry.key || ', '')],
  ['rom-length guard removed', sub('if (bytes.length !== PINNED.length) throw', 'if (false) throw')],
  ['header identity guard removed', sub('if (!id.ok) throw', 'if (false) throw')],
  ['cry id range check dropped at the low end', sub('cryId < 1 || cryId > table.count', 'cryId < 0 || cryId > table.count')],
  ['cry id range check dropped at the high end', sub('cryId < 1 || cryId > table.count', 'cryId < 1')],
  ['cry id must be an integer check dropped', sub('!Number.isInteger(cryId) || cryId < 1', 'cryId < 1')],
  ['cryForSpecies lets cryId 738 through', sub('id > table.count) return null', 'id > 99999) return null')],
  ['cryToAudioBuffer ignores the cry rate', sub('audioCtx.createBuffer(1, f.length, rate)', 'audioCtx.createBuffer(1, f.length, 44100)')],
  ['cryToAudioBuffer starts a source', sub('const buf = audioCtx.createBuffer(1, f.length, rate);', 'const buf = audioCtx.createBuffer(1, f.length, rate); audioCtx.createBufferSource().start();')],
  ['playCry plays on a suspended context', sub("if (audioCtx.state !== 'running') return null;", '')],
  ['playCry starts twice', sub('source.start(when);', 'source.start(when); source.start(when);')],
  ['playCry gain upper bound dropped', sub('gain >= 0 && gain <= 1', 'gain >= 0')],
  ['playCry ignores the mode (no faint)', sub('const rate = cryPlaybackRate(opts.pitch === undefined ? CRY_PITCH[mode] : opts.pitch);', 'const rate = 1;')],
  ['faint pitch constant wrong', sub('faint: 14440', 'faint: 14000')],
  ['pitch law 12 semitone octave becomes 11', sub('(pitch - CRY_PITCH.normal) / (256 * 12)', '(pitch - CRY_PITCH.normal) / (256 * 11)')],
  ['sound defaults to ON', sub("s.getItem(SOUND_KEY) === '1'", "s.getItem(SOUND_KEY) !== '0'")],
  ['sound switch ignored by playCryIfSoundOn', sub('if (!isSoundOn(opts.storage)) return null;', '')],
  ['sound key renamed', sub("export const SOUND_KEY = 'arena.sound';", "export const SOUND_KEY = 'arena.audio';")],
  ['cryToWav forgets the +128 bias', sub('out[44 + i] = (cry.pcm[i] + 128) & 255;', 'out[44 + i] = cry.pcm[i] & 255;')],
  ['hash input drops the sample rate', sub('dv.setUint32(4, cry.rateFixed, true);', '')],
];
{
  const twinMod = await loadVariant(src);
  const twin = await battery(twinMod, env);
  const twinBad = twin.filter((r) => !r.ok);
  ok(twinBad.length === 0, 'harness twin: an UNMUTATED copy of cries.js loaded through the same data: URL path passes the whole battery', twinBad.map((r) => r.name).join('; '));
  let caught = 0; const escaped = [];
  for (const [name, mutate] of MUTANTS) {
    let text; try { text = mutate(src); } catch (e) { ok(false, 'mutant anchor: ' + name, e.message); continue; }
    if (text === src) { ok(false, 'mutant changes the source: ' + name); continue; }
    let res;
    try { const m = await loadVariant(text); res = await battery(m, env); } catch (e) { res = [{ name: 'module failed to load/run: ' + e.message, ok: false }]; }
    const bad = res.filter((r) => !r.ok);
    if (bad.length) { caught++; ok(true, 'mutant caught: ' + name); console.log(`  caught  ${name.padEnd(58)} by ${bad.length} check(s), e.g. ${bad[0].name.slice(0, 80)}`); }
    else { escaped.push(name); ok(false, 'mutant ESCAPED: ' + name); }
  }
  console.log(`  mutants: ${caught}/${MUTANTS.length} caught, ${escaped.length} escaped${escaped.length ? ' -> ' + escaped.join('; ') : ''}`);
  console.log('  accepted equivalent mutant (not run): dropping the `<< 24) >> 24` 8-bit wrap in decodeCry - the Int8Array store wraps identically, so output is bit-for-bit unchanged');
}
// the golden comparison itself must fail on a tampered golden (control for the comparison)
{ const tampered = { ...env, golden: { ...golden, cries: golden.cries.map((h, i) => (i === 100 ? 'f'.repeat(40) : h)) } };
  const r = await battery(C, tampered);
  ok(r.filter((x) => !x.ok).some((x) => /per-cry SHA-1/.test(x.name)), 'control: a tampered golden (one hash changed) fails the per-cry check', r.filter((x) => !x.ok).map((x) => x.name).join('; '));
  ok(r.filter((x) => !x.ok).length <= 3, 'control: the tampered golden trips only the golden checks, not unrelated ones', r.filter((x) => !x.ok).map((x) => x.name).join('; ')); }

/* ===== 6. headless-Chrome parity ====================================================================================== */
async function waitPort(port, ms = 15000) { const t = Date.now(); for (;;) { try { const r = await fetch(`http://127.0.0.1:${port}/pokemonarena/manifest.json`); if (r.ok) return; } catch (_e) { /* not up yet */ } if (Date.now() - t > ms) throw new Error('devserver did not come up on ' + port); await new Promise((r) => setTimeout(r, 200)); } }
const stopServer = (child) => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); } catch (_e) { /* gone */ } };
if (BROWSER) {
  head('6. headless Chrome parity (own devserver on ' + PORT + ', CDP ' + CDP_PORT + ', --mute-audio, no realtime AudioContext)');
  spawnSync(process.execPath, [path.join(root, 'tools', 'browser_leak_guard.js'), 'reap'], { stdio: 'ignore', cwd: root });
  const child = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  try {
    await waitPort(PORT);
    const { withBrowser } = await import('./headless_cdp.mjs');
    const probe = `(async () => {
      // tripwire: any attempt to build a REALTIME AudioContext during this run throws and is counted (OfflineAudioContext is a different class)
      window.__acCalls = 0;
      for (const k of ['AudioContext', 'webkitAudioContext']) { window[k] = class { constructor() { window.__acCalls++; throw new Error('realtime AudioContext forbidden in tests'); } }; }
      const C = await import('/pokemonarena/js/cries.js');
      const T = await import('/pokemonarena/js/tables.js');
      const R = await import('/pokemonarena/js/romfetch.js');
      const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
      const sha1 = async (u8) => hex(await crypto.subtle.digest('SHA-1', u8));
      const t0 = performance.now();
      const loaded = await R.loadVerifiedRom();                         // fetch through romfetch.js, length + header + sha256 checked
      const rom = loaded.bytes; const tFetch = performance.now() - t0;
      const t1 = performance.now();
      const table = C.locateCryTable(rom);
      const hashes = [];
      for (let id = 1; id <= table.count; id++) hashes.push(await sha1(C.cryHashBytes(C.decodeCry(rom, id, { table }))));
      const tDecode = performance.now() - t1;
      const agg = await sha1(new TextEncoder().encode(hashes.join('\\n')));
      const pack = await T.loadPackAsync(rom, { dexText: false });
      const lines = pack.roster.map((id) => id + ':' + pack.species[id].cryId + ':' + hashes[pack.species[id].cryId - 1]);
      const map = await sha1(new TextEncoder().encode(lines.join('\\n')));
      let mapped = 0; for (const id of pack.roster) if (C.cryForSpecies(pack, rom, id, { table })) mapped++;
      // real Web Audio object, build-only: OfflineAudioContext has no output device; neither start() nor startRendering() is ever called
      const off = new OfflineAudioContext(1, 1, 44100);
      const cry = C.decodeCry(rom, 24, { table });
      const buf = C.cryToAudioBuffer(off, cry);
      const ch = buf.getChannelData(0);
      let exact = ch.length === cry.pcm.length; for (let i = 0; i < ch.length && exact; i++) if (ch[i] !== cry.pcm[i] / 128) exact = false;
      const buf2 = C.cryToAudioBuffer(off, C.decodeCry(rom, 662, { table }));
      const bad = rom.slice(); bad[0x15cb0dc] ^= 1;
      let refused = 'ACCEPTED'; try { C.locateCryTable(bad); } catch (e) { refused = e.name + '/' + e.code; }
      const ua = /HeadlessChrome\\/[0-9.]+/.exec(navigator.userAgent);
      return { agg, map, count: hashes.length, hashes, mapped, legal: pack.roster.length, tFetch, tDecode, audio: { len: buf.length, rate: buf.sampleRate, exact, ch: buf.numberOfChannels, len2: buf2.length, rate2: buf2.sampleRate }, refused, acCalls: window.__acCalls, offState: off.state, ua: ua ? ua[0] : navigator.userAgent, sound: localStorage.getItem('arena.sound') };
    })()`;
    const res = await withBrowser({ port: CDP_PORT, width: 800, height: 600 }, async (page) => {
      await page.navigate(`http://localhost:${PORT}/pokemonarena/manifest.json`);
      const r = await page.eval(probe);
      r.errors = page.errors.filter((e) => !/favicon\.ico/.test(e));   // the JSON viewer page asks for a favicon the dev server does not have
      return r;
    });
    console.log(`  info ${res.ua}: ROM fetch+verify ${res.tFetch.toFixed(0)} ms, decode+SHA-1 of ${res.count} cries ${res.tDecode.toFixed(0)} ms; machine ${load()}`);
    ok(res.agg === golden.aggregateSha1, 'browser aggregate SHA-1 of all 737 cries equals the golden (and the Node value)', `${res.agg} vs ${golden.aggregateSha1}`);
    ok(res.hashes.length === NCRY && res.hashes.every((h, i) => h === golden.cries[i]), 'browser per-cry SHA-1 equals the golden for every cry');
    ok(res.map === golden.speciesMapSha1 && res.mapped === res.legal && res.legal === golden.speciesCount, 'browser species->cry map hash equals the golden and all legal species resolve', `${res.mapped}/${res.legal}`);
    ok(res.audio.ch === 1 && res.audio.len === all[23].sampleCount && res.audio.rate === all[23].sampleRate && res.audio.exact && res.audio.rate2 === 13379, 'real browser AudioBuffer (OfflineAudioContext, createBuffer only) has the right channels/length/rate and exact int8/128 contents; 13379 Hz buffers are accepted', JSON.stringify(res.audio));
    ok(res.refused === 'CryTableError/bad-entry', 'browser locateCryTable refuses a ROM with one table bit flipped', res.refused);
    ok(res.acCalls === 0 && res.offState !== 'running' && res.sound === null, 'tripwire: zero realtime AudioContext constructions during decode + buffer plumbing (the OfflineAudioContext stayed ' + res.offState + '); arena.sound is unset in the fresh profile (muted by default)', JSON.stringify({ acCalls: res.acCalls, off: res.offState, sound: res.sound }));
    ok(res.errors.length === 0, 'no page errors in the browser', res.errors.join(' | '));
  } catch (e) { ok(false, 'browser parity run', e && e.message); }
  finally { stopServer(child); spawnSync(process.execPath, [path.join(root, 'tools', 'browser_leak_guard.js'), 'reap'], { stdio: 'ignore', cwd: root }); }
} else console.log('\n(section 6, browser parity, skipped: ARENA_BROWSER=0)');

console.log(`\n${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (fail) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
