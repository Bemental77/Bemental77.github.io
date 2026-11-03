#!/usr/bin/env node
// tools/gba_mgba_build_test.mjs - exit tests for stage G0 (gba/mgba): the reproducible, single-thread mGBA wasm build.
//
//   node tools/gba_mgba_build_test.mjs                      # artifact + git + provenance + Node runtime checks (~10 s)
//   node tools/gba_mgba_build_test.mjs --browser            # + the same core in headless Chrome on a NON-isolated page
//   node tools/gba_mgba_build_test.mjs --rebuild            # + two CLEAN builds, md5 compared (bit-reproducibility)
//   node tools/gba_mgba_build_test.mjs --png-dir <dir>      # where the framebuffer PNGs go (default: os.tmpdir())
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (a mutant the check must catch)
// next to the unmutated twin that must stay quiet; controls print as `[control]`.
//
// What it proves, and what it does not:
//   * It proves the artifact in gba/mgba/dist/ is a real wasm that git will store as a real blob (not an LFS pointer),
//     contains none of SharedArrayBuffer / new Worker / pthread / Atomics, declares no SHARED memory, records the pinned
//     source SHA, and runs two real ROMs for 600 frames in Node (and, with --browser, in Chrome).
//   * It does NOT prove a rebuild is bit-identical unless --rebuild is given; that is a measurement, reported either way.
//   * It does NOT prove link-cable correctness (G3) or multi-core determinism (G1); it only holds a 1-core twin-instance
//     frame-hash equality and a savestate round trip as early smoke signals for G1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { writePNG, scaleRGBA } from './arena_png.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'gba/mgba/dist');
const MGBA = path.join(ROOT, 'gba/mgba');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PNG_DIR = opt('--png-dir', process.env.GBA_MGBA_PNG_DIR || path.join(os.tmpdir(), 'gba_mgba_build_test'));

const PINNED_SHA = 'f1d5975d77285f77affbfe64b7050ebd5c4b6a77';
const SOULGOLD_MD5 = 'b2c5caf9bc6dd28a44052427ee3ab1b7';
const FRAMES = 600;
const HEADROOM_MIN = 16 * 1024 * 1024;
const FORBIDDEN = ['SharedArrayBuffer', 'new Worker', 'pthread', 'Atomics'];

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
}
// A negative control PASSES when the check under test rejects the mutant.
function control(name, rejected, detail = '') {
  if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); }
}
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
// build.sh writes the glue with LF; a Windows checkout with core.autocrlf=true may hand back CRLF. The glue's md5 is defined on the LF form.
const lf = (b) => Buffer.from(b.filter((c, i) => !(c === 0x0d && b[i + 1] === 0x0a)));
const section = (s) => console.log(`\n== ${s}`);

// ---------------------------------------------------------------------------------------------------------------------
// Pure checks (each is exercised on the real artifact AND on a mutant)
function isLfsPointer(buf) { return buf.length < 1024 && buf.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs'); }
function startsWithWasmMagic(buf) { return buf.length > 8 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d; }
function countOf(buf, needle) { let n = 0, i = 0; const nb = Buffer.from(needle); while ((i = buf.indexOf(nb, i)) >= 0) { n++; i += nb.length; } return n; }
function forbiddenHits(buf) { const h = {}; for (const w of FORBIDDEN) { const c = countOf(buf, w); if (c) h[w] = c; } return h; }
function headroomOk(peak, heap) { return heap - peak >= HEADROOM_MIN; }
// build.sh may MENTION pthreads in comments and in its own checks, but must never hand -pthread / a bare -DUSE_PTHREADS
// to a compiler, and must hand cmake the explicit OFF.
function buildShThreadClean(text) {
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return /-DUSE_PTHREADS=OFF/.test(code) && !/-DUSE_PTHREADS(?!=OFF)/.test(code) && !/(^|\s)-pthread(\s|$)/.test(code);
}

// Minimal wasm section reader: the memory limits (imported and defined) with their SHARED flag. A string scan cannot see a
// shared memory, and a module compiled with atomics + shared memory needs SharedArrayBuffer to even instantiate.
function wasmMemories(buf) {
  if (!startsWithWasmMagic(buf)) throw new Error('not a wasm binary');
  const o = { i: 8 }; const mems = [];
  const leb = () => { let r = 0, s = 0, b; do { b = buf[o.i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const memLimits = (kind) => { const f = buf[o.i++]; const initial = leb(); const max = (f & 1) ? leb() : null; mems.push({ kind, initial, max, shared: !!(f & 2), memory64: !!(f & 4) }); };
  while (o.i < buf.length) {
    const id = buf[o.i++]; const size = leb(); const end = o.i + size;
    if (id === 2) {
      const n = leb();
      for (let k = 0; k < n; k++) {
        const modLen = leb(); o.i += modLen; const fldLen = leb(); o.i += fldLen; // module, field names (NOT `o.i += leb()`: o.i is read before leb() advances it)
        const kind = buf[o.i++];
        if (kind === 0) leb();                  // func: type index
        else if (kind === 1) { o.i++; const f = buf[o.i++]; leb(); if (f & 1) leb(); } // table: reftype + limits
        else if (kind === 2) memLimits('import');
        else if (kind === 3) o.i += 2;          // global: valtype + mutability
        else if (kind === 4) { o.i++; leb(); }  // tag
        else throw new Error('unknown import kind ' + kind);
      }
    } else if (id === 5) { const n = leb(); for (let k = 0; k < n; k++) memLimits('defined'); }
    o.i = end;
  }
  return mems;
}
// Smallest valid-enough module with one SHARED memory (flags 0x03 = has-max + shared): the mutant for the memory check.
const SHARED_MEMORY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x03, 0x01, 0x01]);
const PLAIN_MEMORY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01]);

// rsync-subset matcher. tools/deploy_should_run.mjs exports the real one, but its ROOT is derived from URL.pathname, which
// is `/C:/...` on Windows and resolves to `C:\C:\...` (ENOENT), so it is imported when it works and mirrored otherwise.
function mirrorMatcher(rulesText) {
  const rules = rulesText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((pat) => {
    const anchored = pat.startsWith('/'); const body = anchored ? pat.slice(1) : pat;
    const rx = body.split('/').map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/');
    return { pat, rx: new RegExp(anchored ? `^${rx}(/|$)` : `(^|/)${rx}(/|$)`) };
  });
  return (f) => rules.find((r) => r.rx.test(f)) || null;
}
function deployVerdict(excluded) {
  const mustExclude = ['gba/mgba/build.sh', 'gba/mgba/patches/0001-cmake-honor-use-pthreads-off.patch', 'gba/mgba/README.md'];
  const mustServe = ['gba/mgba/dist/mgba_core.wasm', 'gba/mgba/dist/mgba_core.js', 'gba/mgba/dist/mgba_core.buildinfo.json', 'gba/mgba/SOURCE.md', 'gba/mgba/LICENSE-MPL-2.0'];
  return { wrongServed: mustExclude.filter((f) => !excluded(f)), wrongExcluded: mustServe.filter((f) => excluded(f)) };
}

// ---------------------------------------------------------------------------------------------------------------------
function git(args, input) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 1 << 26 }); }
function attrFilter(p) { const r = git(['check-attr', 'filter', '--', p]); return (r.stdout.match(/filter: (.*)\r?\n?$/) || [])[1]; }
function hashWith(p, file, filters) {
  const r = spawnSync('git', ['hash-object', ...(filters ? ['--path=' + p] : ['--no-filters']), '--stdin'], { cwd: ROOT, input: fs.readFileSync(file) });
  return r.status === 0 ? r.stdout.toString().trim() : 'ERR:' + r.stderr.toString().trim();
}

// ---------------------------------------------------------------------------------------------------------------------
async function loadCore(distDir = DIST) {
  const create = require(path.join(distDir, 'mgba_core.js'));
  const logs = [];
  const M = await create({ print: (l) => logs.push(String(l)), printErr: (l) => logs.push(String(l)) });
  return { M, logs };
}
function loadRom(M, rom, cores = 1) {
  M._mgs_init(cores);
  const p = M._malloc(rom.length); M.HEAPU8.set(rom, p);
  const rc = M._mgs_load_rom(p, rom.length);
  M._free(p);
  return rc;
}
function frameOf(M, player = 0) {
  const w = M._mgs_get_video_width(player), h = M._mgs_get_video_height(player), p = M._mgs_get_video(player);
  return { w, h, rgba: new Uint8Array(M.HEAPU8.buffer, p, w * h * 4).slice() };
}
function frameStats(f) {
  let nonBlack = 0; const colors = new Set();
  for (let i = 0; i < f.w * f.h; i++) { const c = f.rgba[i * 4] | (f.rgba[i * 4 + 1] << 8) | (f.rgba[i * 4 + 2] << 16); if (c) nonBlack++; colors.add(c); }
  return { nonBlack, distinct: colors.size };
}
// A frame "rendered something" when it is not blank and not a flat fill.
// 2x nearest-neighbour so the PNG is legible when opened.
function savePng(file, f) { const s = scaleRGBA(f.w, f.h, f.rgba, 2); writePNG(file, s.width, s.height, s.rgba); }
const rendered = (s) => s.nonBlack > 500 && s.distinct >= 8;
function runFrames(M, n) { for (let i = 0; i < n; i++) M._mgs_run_frame(); }

async function nodeRuntime(distDir, label) {
  const results = {};
  const roms = [
    { id: 'bam', file: 'gba/gbaWasm/roms/Super Bust-A-Move (U).gba', png: 'G0-super-bust-a-move-f600.png' },
    { id: 'soulgold', file: 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba', png: 'G0-pokemon-soulgold-f600.png' },
  ];
  for (const r of roms) {
    const abs = path.join(ROOT, r.file);
    ok(`${label}: ROM present: ${r.file}`, fs.existsSync(abs));
    if (!fs.existsSync(abs)) continue;
    const rom = fs.readFileSync(abs);
    if (r.id === 'soulgold') {
      ok('SoulGold md5 is the pinned v1.1.1 (b2c5caf9...)', md5(rom) === SOULGOLD_MD5, md5(rom));
      ok('SoulGold header game code is BPEE', rom.subarray(0xac, 0xb0).toString('latin1') === 'BPEE', rom.subarray(0xac, 0xb0).toString('latin1'));
    }
    const { M, logs } = await loadCore(distDir);
    const rc = loadRom(M, rom, 1);
    ok(`${r.id}: mgs_load_rom returned 0`, rc === 0, 'rc=' + rc);
    const t0 = performance.now(); runFrames(M, FRAMES); const ms = performance.now() - t0;
    const f = frameOf(M); const s = frameStats(f);
    ok(`${r.id}: ${FRAMES} frames ran, video ${f.w}x${f.h}`, f.w === 240 && f.h === 160);
    ok(`${r.id}: framebuffer rendered something`, rendered(s), `nonBlack=${s.nonBlack}/${f.w * f.h} distinctColors=${s.distinct}`);
    const png = path.join(PNG_DIR, r.png);
    savePng(png, f);
    console.log(`       png: ${png}`);
    console.log(`       informational: ${(ms / FRAMES).toFixed(3)} ms/frame in Node on a SHARED box (not a device number); mGBA log lines: ${logs.length}`);
    const hash = md5(f.rgba);
    results[r.id] = { hash, rendered: s, ms: ms / FRAMES };
    // audio path smoke
    M._mgs_get_audio(); const af = M._mgs_audio_frames();
    ok(`${r.id}: audio path produced frames`, af > 0 && M._mgs_get_audio_rate() === 32768, `frames=${af} rate=${M._mgs_get_audio_rate()}`);
    if (r.id === 'bam') {
      // CONTROL: a core that was loaded but never stepped has a blank framebuffer, so `rendered` must reject it.
      const c = await loadCore(distDir); loadRom(c.M, rom, 1);
      control('blank framebuffer (0 frames run) is rejected by the rendered-check', !rendered(frameStats(frameOf(c.M))));
      // Twin: an independent instance, same ROM, same frames, no input -> identical frame.
      const t = await loadCore(distDir); loadRom(t.M, rom, 1); runFrames(t.M, FRAMES);
      ok('twin instance reproduces the identical frame hash', md5(frameOf(t.M).rgba) === hash, hash);
      // CONTROL: the hash must be able to differ - 60 frames in is a different picture than 600.
      const e = await loadCore(distDir); loadRom(e.M, rom, 1); runFrames(e.M, 60);
      control('frame hash differs between frame 60 and frame 600', md5(frameOf(e.M).rgba) !== hash);
    }
    if (r.id === 'soulgold') {
      // Savestate round trip, on the ROM whose screen is still ANIMATING at frame 600 (Super Bust-A-Move holds a static logo
      // from ~frame 600, so it could not tell a good restore from a bad one). Restore, run N frames == run N straight through.
      const t2 = await loadCore(distDir); loadRom(t2.M, rom, 1); runFrames(t2.M, FRAMES);
      ok('soulgold: twin instance reproduces the identical frame hash while the screen is animating', md5(frameOf(t2.M).rgba) === hash, hash);
      runFrames(t2.M, 1);
      control('soulgold: one more frame changes the hash (so the animating frame is a sensitive witness)', md5(frameOf(t2.M).rgba) !== hash);
      t2.M._mgs_quit();
      const N = 20;
      const sz = M._mgs_save_state(0);
      ok('savestate captured', sz > 100000, 'size=' + sz);
      runFrames(M, N); const straight = md5(frameOf(M).rgba);
      ok('savestate restores', M._mgs_load_state(0) === 0);
      runFrames(M, N); const replay = md5(frameOf(M).rgba);
      ok(`savestate round trip: ${N} frames after restore == ${N} frames straight through`, straight === replay, straight);
      M._mgs_load_state(0); runFrames(M, N + 1);
      control('one extra frame after restore gives a different hash (the round-trip check can fail)', md5(frameOf(M).rgba) !== replay);
    }
    M._mgs_quit();
  }
  return results;
}

async function memoryChecks(buildinfo) {
  const rom = fs.readFileSync(path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba'));
  const rss0 = process.memoryUsage().rss;
  const { M } = await loadCore();
  const rssDelta = process.memoryUsage().rss - rss0;
  const heap = M.HEAPU8.length;
  ok('heap is exactly the documented INITIAL_MEMORY and does not grow', heap === buildinfo.link.initialMemory, `${heap} B = ${(heap / 1048576).toFixed(0)} MiB`);
  console.log(`       informational: RSS rose ${(rssDelta / 1048576).toFixed(1)} MiB on instantiate of a ${(heap / 1048576).toFixed(0)} MiB heap (Node/Windows, one measurement)`);
  loadRom(M, rom, 4); runFrames(M, 120); M._mgs_save_state(0);
  const peak = M._sbrk(0);
  ok('4 cores x 32 MiB SoulGold fit with >= 16 MiB headroom', headroomOk(peak, heap) && M.HEAPU8.length === heap, `peak ${(peak / 1048576).toFixed(1)} MiB of ${(heap / 1048576).toFixed(0)} MiB, headroom ${((heap - peak) / 1048576).toFixed(1)} MiB`);
  // Controls DERIVED from the measured peak, never from a constant heap size: the previous control ("the fork's 256 MiB heap fails") went
  // stale the moment the shared ROM mapping cut the 4-core peak from 294.8 to ~167 MiB, and a stale control reads as a red suite.
  control('a heap one byte short of peak + 16 MiB fails the headroom rule (the rule can fail)', !headroomOk(peak, peak + HEADROOM_MIN - 1));
  ok('boundary twin: a heap of exactly peak + 16 MiB passes the same rule', headroomOk(peak, peak + HEADROOM_MIN));
  control('a heap equal to the measured peak (zero headroom) fails the rule', !headroomOk(peak, peak));
  M._mgs_quit();
}

// ---------------------------------------------------------------------------------------------------------------------
async function browserCheck(nodeHash) {
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  const PORT = 8092;
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`)).ok; } catch (_e) { await new Promise((r) => setTimeout(r, 250)); } }
    ok('devserver (PORT=8092) is serving gba/mgba/dist', up);
    const head = await fetch(`http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.wasm`, { method: 'HEAD' });
    ok('server returns the wasm with a wasm content-type and the on-disk length', head.headers.get('content-type') === 'application/wasm' && Number(head.headers.get('content-length')) === fs.statSync(path.join(DIST, 'mgba_core.wasm')).size, `${head.headers.get('content-type')} ${head.headers.get('content-length')}`);
    const res = await withBrowser({ port: 9251, width: 640, height: 480 }, async (page) => {
      await page.navigate(`http://localhost:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`);
      return page.eval(`(async () => {
        const out = { crossOriginIsolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer };
        await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/gba/mgba/dist/mgba_core.js'; s.onload = res; s.onerror = () => rej(new Error('glue script failed to load')); document.head.appendChild(s); });
        const M = await createMgbaCore({ print() {}, printErr() {} });
        const rom = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/Super%20Bust-A-Move%20(U).gba')).arrayBuffer());
        M._mgs_init(1); const p = M._malloc(rom.length); M.HEAPU8.set(rom, p); out.rc = M._mgs_load_rom(p, rom.length); M._free(p);
        const t0 = performance.now(); for (let i = 0; i < ${FRAMES}; i++) M._mgs_run_frame(); out.msPerFrame = (performance.now() - t0) / ${FRAMES};
        const w = M._mgs_get_video_width(0), h = M._mgs_get_video_height(0), v = M._mgs_get_video(0);
        const px = new Uint8Array(M.HEAPU8.buffer, v, w * h * 4); let s = ''; for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, Math.min(px.length, i + 0x8000)));
        out.w = w; out.h = h; out.b64 = btoa(s); out.heap = M.HEAPU8.length;
        return out;
      })()`);
    });
    ok('headless Chrome page was NOT cross-origin isolated', res.crossOriginIsolated === false, `crossOriginIsolated=${res.crossOriginIsolated} typeof SharedArrayBuffer=${res.sab}`);
    // The browser heap must be the documented one in the SHIPPED buildinfo, not a number frozen into this test (it was 320 MiB until the
    // shared ROM mapping, 192 MiB since; a hardcoded value turned a correct change into a red --browser run).
    const biBrowser = JSON.parse(fs.readFileSync(path.join(DIST, 'mgba_core.buildinfo.json'), 'utf8'));
    const heapIsDocumented = (h) => h === biBrowser.link.initialMemory;
    ok('core instantiated and loaded the ROM in the browser', res.rc === 0 && heapIsDocumented(res.heap), `rc=${res.rc} heap=${res.heap} buildinfo.link.initialMemory=${biBrowser.link.initialMemory}`);
    control('the heap comparison rejects a heap one wasm page larger or smaller than the documented one', !heapIsDocumented(res.heap + 65536) && !heapIsDocumented(res.heap - 65536));
    const rgba = Buffer.from(res.b64, 'base64');
    ok('browser framebuffer rendered something', rendered(frameStats({ w: res.w, h: res.h, rgba })), `${res.w}x${res.h}`);
    ok('browser frame hash == Node frame hash (same ROM, same 600 frames)', md5(rgba) === nodeHash, md5(rgba));
    savePng(path.join(PNG_DIR, 'G0-browser-super-bust-a-move-f600.png'), { w: res.w, h: res.h, rgba: new Uint8Array(rgba) });
    console.log(`       png: ${path.join(PNG_DIR, 'G0-browser-super-bust-a-move-f600.png')}`);
    console.log(`       informational: ${res.msPerFrame.toFixed(3)} ms/frame in headless Chrome on a SHARED box (not a device number)`);
  } finally { try { server.kill(); } catch (_e) {} }
}

// ---------------------------------------------------------------------------------------------------------------------
function rebuildCheck() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgba_rebuild_'));
  const md5s = [];
  for (const n of [1, 2]) {
    const out = path.join(tmp, 'out' + n);
    const r = spawnSync('bash', [path.join(MGBA, 'build.sh'), '--clean'], { cwd: ROOT, env: { ...process.env, MGBA_OUT: out }, encoding: 'utf8', maxBuffer: 1 << 28 });
    fs.writeFileSync(path.join(tmp, `build${n}.log`), (r.stdout || '') + (r.stderr || ''));
    ok(`clean build #${n} exits 0`, r.status === 0, `log: ${path.join(tmp, `build${n}.log`)}`);
    md5s.push({ wasm: md5(fs.readFileSync(path.join(out, 'mgba_core.wasm'))), js: md5(fs.readFileSync(path.join(out, 'mgba_core.js'))) });
  }
  // CONTROL: the pin is enforced. An unreachable pinned SHA must make build.sh fail BEFORE it writes any artifact.
  const bogus = path.join(tmp, 'bogus-out');
  const rb = spawnSync('bash', [path.join(MGBA, 'build.sh')], { cwd: ROOT, env: { ...process.env, MGBA_REV: '0000000000000000000000000000000000000001', MGBA_SRC: path.join(tmp, 'bogus-src'), MGBA_BUILD: path.join(tmp, 'bogus-build'), MGBA_OUT: bogus }, encoding: 'utf8' });
  control('build.sh with an unreachable pinned SHA exits non-zero and writes no artifact', rb.status !== 0 && !fs.existsSync(path.join(bogus, 'mgba_core.wasm')), `exit ${rb.status}`);
  const dist = { wasm: md5(fs.readFileSync(path.join(DIST, 'mgba_core.wasm'))), js: md5(lf(fs.readFileSync(path.join(DIST, 'mgba_core.js')))) };
  console.log(`       build #1 wasm md5 ${md5s[0].wasm}  js md5 ${md5s[0].js}`);
  console.log(`       build #2 wasm md5 ${md5s[1].wasm}  js md5 ${md5s[1].js}`);
  console.log(`       dist     wasm md5 ${dist.wasm}  js md5 ${dist.js}`);
  ok('MEASUREMENT: two clean builds produce the identical wasm', md5s[0].wasm === md5s[1].wasm, md5s[0].wasm === md5s[1].wasm ? 'EQUAL' : 'UNEQUAL');
  ok('MEASUREMENT: two clean builds produce the identical js glue', md5s[0].js === md5s[1].js);
  ok('committed dist wasm equals a fresh clean build', md5s[0].wasm === dist.wasm && md5s[0].js === dist.js);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const wasmPath = path.join(DIST, 'mgba_core.wasm'), jsPath = path.join(DIST, 'mgba_core.js'), biPath = path.join(DIST, 'mgba_core.buildinfo.json');
  const present = [wasmPath, jsPath, biPath].every((p) => fs.existsSync(p));
  section('artifacts');
  ok('gba/mgba/dist has mgba_core.{wasm,js} and buildinfo', present);
  if (!present) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const wasm = fs.readFileSync(wasmPath), glue = fs.readFileSync(jsPath), buildinfo = JSON.parse(fs.readFileSync(biPath, 'utf8'));
  const before = { wasm: md5(wasm), js: md5(lf(glue)) };
  console.log(`       md5 before: wasm ${before.wasm}  js ${before.js}  (${wasm.length} B / ${glue.length} B)`);
  ok('wasm starts with 00 61 73 6d', startsWithWasmMagic(wasm), wasm.subarray(0, 4).toString('hex'));
  control('a 132-byte LFS pointer is rejected as a wasm', !startsWithWasmMagic(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 788292\n')));
  ok('working-tree wasm is not an LFS pointer and is a real size', !isLfsPointer(wasm) && wasm.length > 200000, `${wasm.length} B`);
  control('isLfsPointer recognises an LFS pointer', isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 788292\n')));
  const glueLf = lf(glue);
  ok('glue md5 survives a CRLF checkout (core.autocrlf=true) because it is defined on the LF form', md5(lf(Buffer.from(glueLf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1'))) === md5(glueLf) && !glueLf.includes(0x0d));
  control('a one-byte change to the glue changes the md5 the check compares', md5(lf(Buffer.concat([glueLf, Buffer.from(' ')]))) !== md5(glueLf));
  ok('buildinfo md5s match the files on disk (glue compared in its LF form)', buildinfo.md5['mgba_core.wasm'] === before.wasm && buildinfo.md5['mgba_core.js'] === before.js);

  section('git: the wasm is stored as a real blob');
  const P = 'gba/mgba/dist/mgba_core.wasm';
  const v = attrFilter(P);
  ok(`git check-attr filter ${P} is not lfs`, v !== undefined && v !== 'lfs', `filter: ${JSON.stringify(v)} (the same empty value the gba/gbaWasm/dist override line yields: ${JSON.stringify(attrFilter('gba/gbaWasm/dist/44gba.wasm'))})`);
  const ctl = 'gba/mgba/zz_control_not_overridden.wasm';
  control('a .wasm path with no override line is reported as lfs (the check can see lfs)', attrFilter(ctl) === 'lfs', 'filter: ' + attrFilter(ctl));
  const withF = hashWith(P, wasmPath, true), noF = hashWith(P, wasmPath, false), ctlF = hashWith(ctl, wasmPath, true);
  ok('git hash-object WITH filters == WITHOUT filters, so no clean filter rewrites it', withF === noF, withF);
  if (ctlF !== noF) control('the same bytes at the un-overridden path ARE rewritten by the lfs clean filter (pointer blob)', ctlF !== noF, ctlF);
  else console.log('       SKIP [control] git-lfs clean filter is not engaged on this machine, so the hash-object control cannot discriminate');

  section('forbidden strings and shared memory');
  const hw = forbiddenHits(wasm), hj = forbiddenHits(glue);
  ok(`wasm has zero of ${FORBIDDEN.join(' / ')}`, Object.keys(hw).length === 0, JSON.stringify(hw));
  ok(`glue js has zero of ${FORBIDDEN.join(' / ')}`, Object.keys(hj).length === 0, JSON.stringify(hj));
  for (const w of FORBIDDEN) control(`appending "${w}" to the glue is caught`, Object.keys(forbiddenHits(Buffer.concat([glue, Buffer.from('\n/* ' + w + ' */')]))).includes(w));
  const mems = wasmMemories(wasm);
  ok('wasm declares exactly one memory and it is NOT shared', mems.length === 1 && !mems[0].shared && !mems[0].memory64, JSON.stringify(mems));
  ok('wasm memory initial == INITIAL_MEMORY pages and has no growth room', mems.length === 1 && mems[0].initial * 65536 === buildinfo.link.initialMemory && (mems[0].max === null || mems[0].max === mems[0].initial), `initial=${mems[0] && mems[0].initial} pages max=${mems[0] && mems[0].max}`);
  control('a module with a shared memory is flagged by the memory reader', wasmMemories(SHARED_MEMORY_WASM)[0].shared === true);
  ok('unmutated twin: a plain memory is not flagged', wasmMemories(PLAIN_MEMORY_WASM)[0].shared === false);
  ok('buildinfo libmgba defines carry no pthread define', !buildinfo.libmgbaDefines.some((d) => /pthread/i.test(d)), buildinfo.libmgbaDefines.length + ' defines');
  ok('buildinfo libmgba defines carry ENABLE_DIRECTORIES (the bridge/lib layout define)', buildinfo.libmgbaDefines.includes('-DENABLE_DIRECTORIES'));

  section('provenance: SOURCE.md, pins, license, patches');
  const srcMd = fs.existsSync(path.join(MGBA, 'SOURCE.md')) ? fs.readFileSync(path.join(MGBA, 'SOURCE.md'), 'utf8') : '';
  const buildSh = fs.readFileSync(path.join(MGBA, 'build.sh'), 'utf8');
  const patches = fs.existsSync(path.join(MGBA, 'patches')) ? fs.readdirSync(path.join(MGBA, 'patches')).filter((f) => f.endsWith('.patch')) : [];
  const shaIn = (text) => text.includes(PINNED_SHA);
  ok('SOURCE.md records the pinned SHA', shaIn(srcMd), PINNED_SHA);
  control('SOURCE.md with the SHA altered fails the same check', !shaIn(srcMd.split(PINNED_SHA).join(PINNED_SHA.replace(/.$/, '0'))));
  ok('build.sh pins the same SHA', (buildSh.match(/MGBA_REV="\$\{MGBA_REV:-([0-9a-f]{40})\}"/) || [])[1] === PINNED_SHA);
  ok('dist buildinfo records the same SHA', buildinfo.source.commit === PINNED_SHA);
  ok('SOURCE.md names the fork repo URL', srcMd.includes('https://github.com/Spuds0588/mgba-splitscreen'));
  ok('SOURCE.md lists every patch in patches/', patches.length > 0 && patches.every((p) => srcMd.includes(p)), patches.join(', '));
  ok('buildinfo lists exactly the patches in patches/', JSON.stringify(buildinfo.source.patches.slice().sort()) === JSON.stringify(patches.slice().sort()));
  const lic = fs.existsSync(path.join(MGBA, 'LICENSE-MPL-2.0')) ? fs.readFileSync(path.join(MGBA, 'LICENSE-MPL-2.0'), 'utf8') : '';
  ok('LICENSE-MPL-2.0 is the Mozilla Public License 2.0 text', lic.startsWith('Mozilla Public License Version 2.0') && lic.includes('3.2. Distribution of Executable Form') && lic.length > 16000, lic.length + ' chars');
  ok('build.sh parses (bash -n)', spawnSync('bash', ['-n', path.join(MGBA, 'build.sh')]).status === 0);
  ok('build.sh passes -DUSE_PTHREADS=OFF to cmake and never -pthread / a bare -DUSE_PTHREADS to a compiler', buildShThreadClean(buildSh));
  control('re-adding a bare -DUSE_PTHREADS to the emcc line is caught', !buildShThreadClean(buildSh.replace('-DNDEBUG $DEFINES', '-DNDEBUG -DUSE_PTHREADS $DEFINES')));
  control('re-adding -pthread to the emcc line is caught', !buildShThreadClean(buildSh.replace('-DNDEBUG $DEFINES', '-DNDEBUG -pthread $DEFINES')));

  section('deploy.exclude');
  const exText = fs.readFileSync(path.join(ROOT, 'deploy.exclude'), 'utf8');
  let matcher = null, how = '';
  try { matcher = (await import(pathToFileURL(path.join(ROOT, 'tools/deploy_should_run.mjs')).href)).excluderFromExcludeFile(); matcher('x'); how = 'tools/deploy_should_run.mjs'; } catch (_e) { matcher = mirrorMatcher(exText); how = 'local mirror of its matcher (the shared one is not importable here)'; }
  console.log(`       matcher: ${how}`);
  const real = deployVerdict(matcher);
  ok('build.sh, patches/ and README.md are excluded from the deploy artifact', real.wrongServed.length === 0, real.wrongServed.join(', '));
  ok('dist/*, SOURCE.md and LICENSE-MPL-2.0 stay deployable', real.wrongExcluded.length === 0, real.wrongExcluded.join(', '));
  const stripped = exText.split('\n').filter((l) => !l.includes('/gba/mgba/')).join('\n');
  control('deploy.exclude without the gba/mgba lines would serve build.sh (check sees it)', deployVerdict(mirrorMatcher(stripped)).wrongServed.length > 0);
  control('a blanket /gba/mgba exclude would hide dist/ (check sees it)', deployVerdict(mirrorMatcher(stripped + '\n/gba/mgba\n')).wrongExcluded.length > 0);
  ok('OFFSITE-BEGIN/END markers are still intact (the workflow derives its sparse-checkout from them)', /OFFSITE-BEGIN/.test(exText) && /OFFSITE-END/.test(exText));

  section('Node runtime: two ROMs x 600 frames');
  const res = await nodeRuntime(DIST, 'dist');
  section('Node memory');
  await memoryChecks(buildinfo);

  if (flag('--browser')) { section('headless Chrome (non-isolated page)'); await browserCheck(res.bam && res.bam.hash); }
  if (flag('--rebuild')) { section('reproducibility: two clean builds'); rebuildCheck(); }

  section('hash guard');
  const after = { wasm: md5(fs.readFileSync(wasmPath)), js: md5(lf(fs.readFileSync(jsPath))) };
  console.log(`       md5 after : wasm ${after.wasm}  js ${after.js}`);
  ok('wasm and js unchanged between start and end of this run (no torn relink)', after.wasm === before.wasm && after.js === before.js);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('test crashed:', e); process.exit(2); });
