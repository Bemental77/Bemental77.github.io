#!/usr/bin/env node
// tools/gba_mgba_solo_test.mjs - exit tests for stage G3: SOLO play in gba.html runs on mGBA (WebAssembly).
//
//   node tools/gba_mgba_solo_test.mjs                    # Node-only sections (~1-2 min): static converter layout audio saves
//   node tools/gba_mgba_solo_test.mjs --browser          # + the real page in headless Chrome (bare CDP, tools/headless_cdp.mjs, PORT=8092)
//   node tools/gba_mgba_solo_test.mjs --only converter,audio
//   node tools/gba_mgba_solo_test.mjs --stamp            # rewrite the ?v= content tokens in gba.html / script.js, then exit (after rebuilding gba/mgba)
//   GBA_SOLO_OUT=<dir> ...                               # where PNGs / downloads / the JSON report go (default: <tmp>/gba-mgba-solo)
//
// 2026-11-01 (stage GP): gba.html moved to the site's page standard (dark #desktop/#controlBar page, standard ids, plain DOM instead of
// Bootstrap + rivets + toastr; tools/gba_page_standard_test.mjs judges the LOOK). This file followed its ids and nothing else:
//   #btnPlayGame -> #btnStart, #romselect -> #romSelect (phone: #mobileRomSelect + #mobileSplashStart), the SP menu -> #mobileMenu
//   (#mobileMenuBtn, #mExportSav ...), #spShell/#spScreen -> #mobileShell/#mobileScreen, the old toastr tap -> window.__gbaToasts, the
//   save/load buttons by id instead of by onclick text. input_controller.js is now a content-versioned <script> (a fifth ?v= token).
//   The phone section starts on the standard splash. Every check and every control below it is unchanged.
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (a mutant it must catch, printed `[control]`)
// next to the unmutated twin that must stay quiet.
//
// What each section proves, and what it does not:
//   static     gba.html loads the mGBA glue + wrapper before script.js, with ?v= content tokens that match the files on disk (a stale
//              glue next to a fresh wasm is a torn core); nothing on the page loads the 44vba core, a Worker, a SharedArrayBuffer or the
//              coi service worker; script.js carries the gate-9 `roomLocked` seam.
//   converter  MgbaCore.battery (gba/mgba/mgba_core.js): 44vba's 0x22000-byte buffer <-> mGBA raw .sav, for sram / flash512 / flash1m /
//              eeprom, blank and malformed inputs.
//   layout     THE ORACLE for that converter: the vendored 44vba core is loaded in Node, a real game is run in it AND in mGBA on the same
//              key stream, and the two batteries must agree byte for byte after conversion (both directions). Kirby (SRAM), Sonic
//              Advance 3 (Flash 64K) and Sim City 2000 (EEPROM) write their saves unaided; Flash 128K (SoulGold) is NOT exercised
//              here: no title we ship writes a 1 Mbit flash without a played-through save point, so that layout rests on 44vba's source
//              (memory.cpp `flashSaveMemory = libretro_save_buf`) and on the flash64K result sharing the same code path.
//   audio      MgbaCore.AudioPipe: exact per-guest-second output count, pitch, pass-through, rate switches, and the MEASURED guest audio
//              rate of every shipped ROM (the table printed by this section is the evidence for the 48,000 Hz sink rate in script.js).
//   saves      real cores: setSave/exportSave/reset semantics the page relies on, and legacy -> mGBA -> accepted-by-the-cartridge for each chip.
//   browser    gba.html itself: boot, ROM picker, Play, frame counter, audio sink, title + in-game screenshots, a key moves a cursor,
//              Export/Import .sav through the real buttons (file chooser + download), battery persistence across a reload, save state
//              round trip, legacy 44vba data handling, the 390x844 touch shell, the capability gate, the gate-9 speed lock, solo pacing.
//              It does NOT prove anything about a real phone, a real audio device, WebKit or low-memory devices.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MGBA = path.join(ROOT, 'gba/mgba');
const DIST = path.join(MGBA, 'dist');
const ROMS = path.join(ROOT, 'gba/gbaWasm/roms');
const MgbaCore = require(path.join(MGBA, 'mgba_core.js'));
const BAT = MgbaCore.battery;
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const OUT = process.env.GBA_SOLO_OUT ? path.resolve(process.env.GBA_SOLO_OUT) : path.join(os.tmpdir(), 'gba-mgba-solo');
const PORT = Number(process.env.GBA_TEST_PORT || 8092);
// GBA_CDP_OFFSET=N moves every Chrome this suite launches from 92xx to 92xx+N, so two copies (or a sibling agent's) can run at once (the browser lock is gone)
const CDP_OFFSET = Number(process.env.GBA_CDP_OFFSET) || 0;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const info = (s) => console.log(`       ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const rom = (n) => fs.readFileSync(path.join(ROMS, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqBytes = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

const SBAM = 'Super Bust-A-Move (U).gba', KIRBY = 'Kirby - Nightmare in Dream Land (U).gba', MRA2 = 'Monster Rancher Advance 2 (U).gba',
  SA3 = 'Sonic Advance 3 (U).gba', SOUL = 'Pokemon SoulGold (v1.1.1).gba', UV = 'pokemonUltraViolet.gba', SIMCITY = 'Sim City 2000 (U).gba';
const ALL_ROMS = [KIRBY, SOUL, SA3, SIMCITY, SBAM, MRA2, UV];
// The key stream used on BOTH cores in the layout oracle and the audio table: START, A, idle, A, B, A in 8-frame slots.
const MASH = (f) => [8, 1, 0, 1, 2, 1][Math.floor(f / 8) % 6];
const pattern = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed + (i >> 8) * 7) & 0xFF; return b; };

function readText(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
const GBA_HTML = 'gba.html', SCRIPT_JS = 'gba/gbaWasm/dist/script.js', INPUT_JS = 'gba/gbaWasm/dist/input_controller.js';
const fileMd5 = (p) => md5(fs.readFileSync(path.join(ROOT, p))).slice(0, 8);
const TOKENS = [
  { label: 'dist/mgba_core.js (glue)', file: 'gba/mgba/dist/mgba_core.js', re: /\/gba\/mgba\/dist\/mgba_core\.js\?v=([A-Za-z0-9_]+)/, in: GBA_HTML },
  { label: 'mgba_core.js (wrapper)', file: 'gba/mgba/mgba_core.js', re: /\/gba\/mgba\/mgba_core\.js\?v=([A-Za-z0-9_]+)/, in: GBA_HTML },
  { label: 'script.js', file: SCRIPT_JS, re: /\/gba\/gbaWasm\/dist\/script\.js\?v=([A-Za-z0-9_]+)/, in: GBA_HTML },
  { label: 'input_controller.js', file: INPUT_JS, re: /\/gba\/gbaWasm\/dist\/input_controller\.js\?v=([A-Za-z0-9_]+)/, in: GBA_HTML },
  { label: 'dist/mgba_core.wasm (MGBA_WASM_V)', file: 'gba/mgba/dist/mgba_core.wasm', re: /const MGBA_WASM_V = '([0-9a-f]+)'/, in: SCRIPT_JS },
];

// ---------------------------------------------------------------------------------------------------------------------
function stampTokens() {
  // script.js first: its MGBA_WASM_V edit changes script.js's own md5, which gba.html then records.
  for (const t of [TOKENS.find((x) => /MGBA_WASM_V/.test(x.label)), ...TOKENS.filter((x) => /glue|wrapper|input_controller/.test(x.label)), TOKENS.find((x) => x.label === 'script.js')]) {
    const p = path.join(ROOT, t.in); const txt = fs.readFileSync(p, 'utf8');
    const m = t.re.exec(txt); if (!m) throw new Error('token not found for ' + t.label);
    const next = txt.replace(m[0], m[0].replace(m[1], fileMd5(t.file)));
    if (next !== txt) { fs.writeFileSync(p, next); console.log(`stamped ${t.label}: ${m[1]} -> ${fileMd5(t.file)}`); }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
function staticSection() {
  section('static: what gba.html and script.js load');
  const html = readText(GBA_HTML), script = readText(SCRIPT_JS), input = readText(INPUT_JS);
  for (const t of TOKENS) {
    const m = t.re.exec(readText(t.in));
    ok(`${t.label}: ${t.in} carries the content token md5(file)[0:8]`, !!m && m[1] === fileMd5(t.file), `${m ? m[1] : 'MISSING'} vs ${fileMd5(t.file)}  (fix: node tools/gba_mgba_solo_test.mjs --stamp)`);
  }
  // the SAME check, fed a page whose token was changed by one hex digit, must fail
  control('a token that is one hex digit off is recognised as stale', TOKENS.every((t) => { const txt = readText(t.in), m = t.re.exec(txt); const flipped = m[1].slice(0, -1) + (m[1].slice(-1) === '0' ? '1' : '0'); const m2 = t.re.exec(txt.replace(m[0], m[0].replace(m[1], flipped))); return m2[1] !== fileMd5(t.file); }));
  const iGlue = html.indexOf('/gba/mgba/dist/mgba_core.js?v='), iWrap = html.indexOf('/gba/mgba/mgba_core.js?v='), iInput = html.indexOf('/gba/gbaWasm/dist/input_controller.js?v='), iScript = html.indexOf('/gba/gbaWasm/dist/script.js?v=');
  ok('gba.html loads the glue, then the wrapper, then input_controller.js, then script.js', iGlue > 0 && iGlue < iWrap && iWrap < iInput && iInput < iScript, `${iGlue} < ${iWrap} < ${iInput} < ${iScript}`);
  // The 44vba loader is a <script> injection with src = '.../44gba.js...'; a COMMENT naming the files is fine.
  const loads44 = (txt) => /src\s*=\s*['"][^'"\n]*44gba/.test(txt) || /Module\._emu[A-Za-z]+\(/.test(txt) || /window\[['"]wasmReady['"]\]\s*=/.test(txt);
  ok('nothing on the page loads or calls the 44vba core (no 44gba src, no Module._emu* call, no window.wasmReady)', !loads44(html) && !loads44(script) && !loads44(input));
  control('the 44vba loader (the old input_controller.js tail) is caught', loads44("var wasmScript = document.createElement('script')\nwasmScript.src = '/gba/gbaWasm/dist/44gba.js?v=' + rando3"));
  control('a Module._emuRunFrame call is caught', loads44('Module._emuRunFrame(this._getKeyMask());'));
  const threaded = (txt) => /new\s+Worker\s*\(/.test(txt) || /new\s+SharedArrayBuffer\s*\(/.test(txt) || /<script[^>]+coi-serviceworker/.test(txt);
  ok('gba.html and script.js create no Worker / SharedArrayBuffer and load no coi service worker', !threaded(html) && !threaded(script));
  control('the threading scan catches a Worker, a SharedArrayBuffer and a coi tag', threaded('new Worker("x")') && threaded('new SharedArrayBuffer(8)') && threaded('<script src="/coi-serviceworker.js">'));
  ok('script.js has the gate-9 seam: roomLocked pins the loop to speed 1 and makes setGameSpeed refuse', /this\.roomLocked\s*=\s*false/.test(script) && /const speed = this\.roomLocked \? 1 : this\.gameSpeed/.test(script) && /if \(this\.roomLocked\) \{ this\.gameSpeed = 1; return false; \}/.test(script));
  ok('script.js reads the guest frame rate from the core (MgbaCore.FPS), not a rounded constant', /window\.MgbaCore\.FPS/.test(script));
  ok('script.js keeps the literal wasm URL (tools/verify_deploy_assets.mjs can only see literals)', script.includes('/gba/mgba/dist/mgba_core.wasm'));
  ok('the file picker accepts .gba only', /<input id="fileInput" type="file" accept="\.gba" \/>/.test(html));
  ok('gba.html no longer claims the core "cannot" do lockstep / has no link cable', !/this core implements no link cable|_emuRunFrame\(keyMask\)` has signature/.test(html));
  ok('gba.html offers Export .sav and Import .sav on the toolbar AND in the touch menu', ['btnExportSav', 'btnImportSav', 'mExportSav', 'mImportSav', 'savInput'].every((id) => html.includes(`id="${id}"`)));
  const buildinfo = JSON.parse(fs.readFileSync(path.join(DIST, 'mgba_core.buildinfo.json'), 'utf8'));
  ok('the wasm on disk is the one dist/mgba_core.buildinfo.json recorded', buildinfo.md5['mgba_core.wasm'] === md5(fs.readFileSync(path.join(DIST, 'mgba_core.wasm'))), buildinfo.md5['mgba_core.wasm']);
}

// ---------------------------------------------------------------------------------------------------------------------
// A converter with the layout WRONG, for the controls: SRAM/flash read from the EEPROM area and EEPROM read from offset 0.
function mutantFromLegacy(legacy, kind) {
  const b = new Uint8Array(legacy);
  if (kind === 'eeprom') return { kind, bytes: b.slice(0, 0x200) };
  const n = { sram: 0x8000, flash512: 0x10000, flash1m: 0x20000 }[kind];
  return { kind, bytes: b.slice(0x2000, 0x2000 + n) };
}

function converterSection() {
  section('converter: 44vba 0x22000-byte buffer <-> mGBA raw .sav');
  const L = 0x22000;
  const mkLegacy = (raw, at) => { const b = new Uint8Array(L).fill(0xFF); b.set(raw, at); return b; };
  const cases = [['sram', 0x8000, 0], ['flash512', 0x10000, 0], ['flash1m', 0x20000, 0]];
  for (const [kind, n, at] of cases) {
    const raw = pattern(n, 5); const legacy = mkLegacy(raw, at);
    const c = BAT.fromLegacy(legacy, kind);
    ok(`${kind}: fromLegacy returns exactly the first 0x${n.toString(16)} bytes`, c && c.kind === kind && eqBytes(c.bytes, raw), `${c && c.bytes.length} bytes`);
    ok(`${kind}: toLegacy(fromLegacy(L)) rebuilds the buffer byte for byte (0xFF elsewhere)`, eqBytes(BAT.toLegacy(c.bytes, kind), legacy));
    ok(`${kind}: fromLegacy(toLegacy(raw)) == raw`, eqBytes(BAT.fromLegacy(BAT.toLegacy(raw, kind), kind).bytes, raw));
    ok(`${kind}: guessKind (no ROM tag) names it from the bytes alone`, BAT.guessKind(legacy) === kind, BAT.guessKind(legacy));
    ok(`${kind}: an untagged ROM (kind 'none') still converts via guessKind`, eqBytes(BAT.fromLegacy(legacy, 'none').bytes, raw) && eqBytes(BAT.fromLegacy(legacy).bytes, raw));
    control(`${kind}: a converter with the layout WRONG is caught by the round-trip check`, !eqBytes(mutantFromLegacy(legacy, kind).bytes, raw));
  }
  // EEPROM: 512 B unless anything sits above 0x200 in the EEPROM area
  const e512 = pattern(0x200, 9), e8k = pattern(0x2000, 11);
  const L512 = mkLegacy(e512, 0x20000), L8k = mkLegacy(e8k, 0x20000);
  ok('eeprom: 512 B of data -> a 512-byte raw save', eqBytes(BAT.fromLegacy(L512, 'eeprom').bytes, e512));
  ok('eeprom: data above 0x200 -> an 8192-byte raw save', eqBytes(BAT.fromLegacy(L8k, 'eeprom').bytes, e8k));
  ok('eeprom: toLegacy puts it at 0x20000 and nothing below', (() => { const t = BAT.toLegacy(e512, 'eeprom'); return eqBytes(t, L512) && t.subarray(0, 0x20000).every((v) => v === 0xFF); })());
  ok('eeprom: untagged guess picks eeprom from the upper area', BAT.guessKind(L8k) === 'eeprom' && BAT.guessKind(L512) === 'eeprom');
  control('eeprom: reading it from offset 0 (the SRAM layout) finds nothing', mutantFromLegacy(L512, 'eeprom').bytes.every((v) => v === 0xFF) && !eqBytes(mutantFromLegacy(L512, 'eeprom').bytes, e512));
  // blank / malformed
  ok('a blank legacy buffer (all 0xFF) is not a save: fromLegacy -> null', BAT.fromLegacy(new Uint8Array(L).fill(0xFF), 'flash1m') === null);
  ok('a zero-filled legacy buffer is NOT treated as blank (0x00 is data; only 0xFF is an unwritten chip)', BAT.fromLegacy(new Uint8Array(L), 'sram') !== null);
  ok('a buffer that is not 0x22000 bytes is not legacy', !BAT.isLegacy(new Uint8Array(0x20000)) && BAT.isLegacy(new Uint8Array(L)) && BAT.fromLegacy(new Uint8Array(0x20000).fill(1), 'flash1m') === null);
  ok('isRawSize accepts exactly the five chip sizes (and not 0x22000)', [0x200, 0x2000, 0x8000, 0x10000, 0x20000].every((n) => BAT.isRawSize(n)) && ![0, 1, 0x100, 0x4000, 0x18000, 0x22000].some((n) => BAT.isRawSize(n)));
  ok('toLegacy refuses a length no chip has', BAT.toLegacy(new Uint8Array(3), 'sram') === null && BAT.toLegacy(new Uint8Array(0x300), 'eeprom') === null && BAT.toLegacy(new Uint8Array(0x8000), 'eeprom') === null);
  ok('isBlank: all 0xFF only', BAT.isBlank(new Uint8Array(64).fill(0xFF)) && !BAT.isBlank(new Uint8Array(64)) && !(() => { const b = new Uint8Array(64).fill(0xFF); b[63] = 0xFE; return BAT.isBlank(b); })());
  // the input must not be mutated or aliased
  const src = mkLegacy(pattern(0x8000, 3), 0), copy = src.slice(); const out = BAT.fromLegacy(src, 'sram'); out.bytes[0] ^= 0xFF;
  ok('fromLegacy returns a copy: editing the result does not touch the input', eqBytes(src, copy));
}

// ---------------------------------------------------------------------------------------------------------------------
// Load the vendored 44vba core into Node (it signals readiness through two GLOBAL callbacks, exactly as in the page).
async function load44() {
  const g = globalThis;
  let ready = false;
  g.wasmReady = () => { ready = true; };
  g.writeAudio = () => {};
  const file = path.join(ROOT, 'gba/gbaWasm/dist/44gba.js');
  delete require.cache[require.resolve(file)];
  g.Module = { locateFile: (p) => path.join(ROOT, 'gba/gbaWasm/dist', p) };
  const M = require(file);
  for (let i = 0; i < 600 && !ready; i++) await sleep(25);
  if (!ready) throw new Error('44vba never signalled wasmReady');
  return M;
}
async function run44(romName, frames) {
  const bytes = new Uint8Array(rom(romName)), M = await load44();
  M.HEAPU8.set(bytes, M._emuGetSymbol(1)); M._emuLoadROM(bytes.length);
  const code = String.fromCharCode(bytes[0xAC], bytes[0xAD], bytes[0xAE], bytes[0xAF]);
  if (['BPRE', 'BPGE', 'BPEE', 'PUVV'].includes(code)) M._emuSetSaveType(3, 0x20000);   // exactly what the old page did
  M._emuResetCpu();
  const sav = M._emuGetSymbol(2);
  for (let f = 1; f <= frames; f++) M._emuRunFrame(MASH(f));
  return M.HEAPU8.slice(sav, sav + L44);
}
const L44 = 0x22000;
async function runMgba(romName, frames) {
  const core = await MgbaCore.create({ seats: 1 }); const inf = core.loadRom(rom(romName));
  for (let f = 1; f <= frames; f++) { core.setKeys(0, MASH(f)); core.runFrame(); }
  const sv = core.exportSave(0); core.close();
  return { info: inf, save: sv ? sv.slice() : null };
}

async function layoutSection() {
  section('layout oracle: the SAME game on the real 44vba core and on mGBA, same key stream -> the converter must reproduce mGBA\'s bytes');
  // frames: enough for each game to have written its save unaided (measured: Kirby first write ~frame 30, SA3 ~150, SimCity ~1140).
  for (const [name, frames, wantKind] of [[KIRBY, 2400, 'sram'], [SA3, 3000, 'flash512'], [SIMCITY, 3000, 'eeprom']]) {
    const legacy = await run44(name, frames), mg = await runMgba(name, frames);
    const kind = mg.info.saveTag;
    ok(`${name}: the ROM's own tag says ${wantKind}`, kind === wantKind, kind);
    const nonFF = legacy.reduce((c, v) => c + (v === 0xFF ? 0 : 1), 0);
    ok(`${name}: 44vba really wrote a save (${nonFF} non-0xFF bytes) - the comparison below is not vacuous`, nonFF > 0 && mg.save && !BAT.isBlank(mg.save));
    const conv = BAT.fromLegacy(legacy, kind);
    ok(`${name}: fromLegacy(44vba buffer) == mGBA's exportSave, ${mg.save && mg.save.length} bytes, every byte`, !!conv && eqBytes(conv.bytes, mg.save), conv ? `${conv.bytes.length} B vs ${mg.save && mg.save.length} B` : 'null');
    ok(`${name}: toLegacy(mGBA save) == the 44vba buffer, all 0x22000 bytes`, eqBytes(BAT.toLegacy(mg.save, kind), legacy));
    const mut = mutantFromLegacy(legacy, kind);
    control(`${name}: the wrong-layout converter does NOT reproduce mGBA's save`, !eqBytes(mut.bytes, mg.save));
    // where the bytes sit, for the record
    const where = []; for (let o = 0; o < L44; o += 0x1000) { let n = 0; for (let i = o; i < o + 0x1000; i++) if (legacy[i] !== 0xFF) n++; if (n) where.push('0x' + o.toString(16)); }
    info(`${name}: 44vba wrote into the 4 KiB blocks at ${where.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
function sineI16(n, hz, sr, amp = 12000, ph0 = 0) { const a = new Int16Array(n * 2); for (let i = 0; i < n; i++) { const v = Math.round(amp * Math.sin(2 * Math.PI * hz * (ph0 + i) / sr)); a[2 * i] = v; a[2 * i + 1] = v; } return a; }
function zeroCrossHz(f32, frames, sr) { let c = 0; for (let i = 1; i < frames; i++) if ((f32[2 * (i - 1)] < 0) !== (f32[2 * i] < 0)) c++; return c / 2 / (frames / sr); }
// Feed `seconds` of a sine through a pipe in video-frame-sized batches (cumulative-floor batch sizes, like the core's own 1096/1100 mix).
function feed(pipe, inRate, seconds, hz, labelRate) {
  const FPS = MgbaCore.FPS, total = Math.round(seconds * FPS); let done = 0, sent = 0; const outs = [];
  for (let f = 1; f <= total; f++) {
    const upto = Math.floor(f * inRate / FPS), n = upto - sent;
    const buf = sineI16(n, hz, inRate, 12000, sent);
    const r = pipe.process(buf, n, labelRate || inRate);
    outs.push(Float32Array.from(r.samples.subarray(0, r.frames * 2)));
    sent += n; done += r.frames;
  }
  const all = new Float32Array(done * 2); let o = 0; for (const p of outs) { all.set(p, o); o += p.length; }
  return { sent, out: done, all, guestSeconds: sent / inRate };
}

function audioPipeUnit() {
  section('audio pipe: MgbaCore.AudioPipe (page-side conversion to the sink\'s fixed rate)');
  const OUT_RATE = 48000;
  for (const inRate of [65536, 32768]) {
    const p = new MgbaCore.AudioPipe(OUT_RATE), r = feed(p, inRate, 60, 1000);
    const ideal = r.sent * OUT_RATE / inRate;
    ok(`${inRate} -> ${OUT_RATE}: ${r.sent} input frames (${r.guestSeconds.toFixed(3)} guest s) give ${r.out} output frames, ideal ${ideal.toFixed(2)} (within 2)`, Math.abs(r.out - ideal) <= 2, `diff ${(r.out - ideal).toFixed(2)}`);
    const hz = zeroCrossHz(r.all, r.out, OUT_RATE);
    ok(`${inRate} -> ${OUT_RATE}: a 1000 Hz tone comes out at ${hz.toFixed(2)} Hz (within 0.2%)`, Math.abs(hz - 1000) < 2, `${hz.toFixed(3)} Hz`);
    let peak = 0; for (let i = 0; i < r.all.length; i++) peak = Math.max(peak, Math.abs(r.all[i]));
    ok(`${inRate} -> ${OUT_RATE}: level preserved (peak ${peak.toFixed(4)} vs ${(12000 / 32768).toFixed(4)})`, Math.abs(peak - 12000 / 32768) < 0.02 * (12000 / 32768) + 0.02);
  }
  // the controls: the same check must FAIL for a pipe that is told the wrong input rate, and for one that loses its phase each batch
  { const p = new MgbaCore.AudioPipe(OUT_RATE), r = feed(p, 65536, 10, 1000, 32768); const hz = zeroCrossHz(r.all, r.out, OUT_RATE);
    control('a pipe told 32768 for 65536-Hz data plays the wrong pitch (caught by the pitch check)', Math.abs(hz - 1000) > 50, `${hz.toFixed(1)} Hz`); }
  { let out = 0, sent = 0; const FPS = MgbaCore.FPS, total = Math.round(30 * FPS);
    for (let f = 1; f <= total; f++) { const upto = Math.floor(f * 65536 / FPS), n = upto - sent; out += new MgbaCore.AudioPipe(OUT_RATE).process(sineI16(n, 1000, 65536), n, 65536).frames; sent = upto; }
    const ideal = sent * OUT_RATE / 65536;
    control('a pipe that forgets its phase every batch drifts from the exact count (caught by the count check)', Math.abs(out - ideal) > 2, `${out} vs ${ideal.toFixed(1)}`); }
  { const p = new MgbaCore.AudioPipe(OUT_RATE); const src = sineI16(2048, 440, 48000); const r = p.process(src, 2048, 48000);
    let maxErr = 0; for (let i = 0; i < 2048 * 2; i++) maxErr = Math.max(maxErr, Math.abs(r.samples[i] - src[i] / 32768));
    ok('48000 -> 48000 is exact pass-through (sample for sample, 2048 frames)', r.frames === 2048 && maxErr < 1e-6, `max error ${maxErr}`); }
  { const p = new MgbaCore.AudioPipe(OUT_RATE); const dc = new Int16Array(4096 * 2).fill(1000); let last = 0;
    for (let k = 0; k < 4; k++) { const r = p.process(dc, 4096, 65536); last = r.samples[2 * (r.frames - 1)]; }
    ok('DC survives the box filter at the right level (1000/32768)', Math.abs(last - 1000 / 32768) < 1e-5, String(last)); }
  { const p = new MgbaCore.AudioPipe(OUT_RATE); let sent = 0, out = 0; const FPS = MgbaCore.FPS;
    for (let f = 1; f <= 600; f++) { const rate = f <= 300 ? 65536 : 32768; const n = Math.floor(rate / FPS) + (f % 2); out += p.process(sineI16(n, 700, rate), n, rate).frames; sent += n / rate; }
    const ideal = sent * OUT_RATE; ok('a mid-stream rate change (65536 -> 32768) keeps the per-second count (within 3 frames)', Math.abs(out - ideal) <= 3, `${out} vs ${ideal.toFixed(1)}`); }
  ok('rejects a non-integer output rate', (() => { try { new MgbaCore.AudioPipe(48000.5); return false; } catch (e) { return e instanceof RangeError; } })());
  ok('an unknown input rate (0) yields nothing instead of garbage', new MgbaCore.AudioPipe(OUT_RATE).process(new Int16Array(8), 4, 0).frames === 0);
}

async function audioMeasureSection() {
  section('audio rate: MEASURED on every shipped ROM (frames the core hands over per video frame, then through the pipe)');
  info('rows: ROM | reported rate(s) | mean audio frames per video frame after warm-up | per guest second | pipe output per guest second');
  const rows = [];
  for (const name of ALL_ROMS) {
    const core = await MgbaCore.create({ seats: 1 }); core.loadRom(rom(name));
    const pipe = new MgbaCore.AudioPipe(48000); const N = 1800, rates = {}; let tot = 0, cnt = 0, outTot = 0, warm = 10;
    for (let f = 1; f <= N; f++) {
      core.setKeys(0, MASH(f)); core.runFrame(); const a = core.audio(0);
      const o = pipe.process(a.samples, a.frames, a.rate);
      if (f > warm) { tot += a.frames; cnt++; outTot += o.frames; rates[a.rate] = (rates[a.rate] || 0) + 1; }
    }
    core.close();
    const per = tot / cnt, perSec = per * MgbaCore.FPS, outPerSec = outTot / cnt * MgbaCore.FPS;
    const dom = Number(Object.entries(rates).sort((a, b) => b[1] - a[1])[0][0]);
    rows.push({ name, rates, per, perSec, outPerSec, dom });
    info(`${name.padEnd(42)} ${JSON.stringify(rates).padEnd(32)} ${per.toFixed(3).padStart(9)}  ${perSec.toFixed(1).padStart(9)}  ${outPerSec.toFixed(1).padStart(9)}`);
    ok(`${name}: the reported rate is one of the two documented ones (32768 / 65536)`, Object.keys(rates).every((r) => r === '32768' || r === '65536'), JSON.stringify(rates));
    ok(`${name}: frames per guest second is within 0.5% of the dominant reported rate ${dom}`, Math.abs(perSec - dom) / dom < 0.005, `${perSec.toFixed(1)}`);
    ok(`${name}: the pipe emits 48000 per guest second within 0.5%`, Math.abs(outPerSec - 48000) / 48000 < 0.005, `${outPerSec.toFixed(1)}`);
  }
  const mixed = rows.filter((r) => r.dom === 65536).length, low = rows.filter((r) => r.dom === 32768).length;
  info(`${mixed} of ${rows.length} ROMs run the sound engine at 65536 Hz, ${low} at 32768 Hz (the 44vba constant the old page used was 47,878; it fits none of them)`);
  control('the 44vba constant (47,878/s) is NOT within 0.5% of any rate mGBA reported here (so reusing it would have been wrong)', rows.every((r) => Math.abs(47878 - r.perSec) / r.perSec > 0.005));
}

// ---------------------------------------------------------------------------------------------------------------------
async function savesSection() {
  section('saves: what the page asks of the real core, and a legacy save reaching each kind of cartridge');
  // 1. the semantics script.js relies on (SoulGold, Flash 1M)
  const pat = pattern(0x20000, 7), pat2 = pat.map((v) => v ^ 0x5A);
  let c = await MgbaCore.create({ seats: 1 }); c.loadRom(rom(SOUL));
  ok('SoulGold: setSave(128 KiB) before the first frame is accepted and exportSave returns the same bytes at once', c.setSave(0, pat) === true && eqBytes(c.exportSave(0), pat));
  for (let f = 0; f < 1500; f++) { c.setKeys(0, f % 60 < 6 ? 8 : 0); c.runFrame(); }
  ok('SoulGold: after 1500 frames of boot + title the cartridge has not rewritten it (export == import)', eqBytes(c.exportSave(0), pat));
  ok('SoulGold: setSave mid-game is accepted too (Import .sav while playing)', c.setSave(0, pat2) === true && eqBytes(c.exportSave(0), pat2));
  c.reset();
  ok('SoulGold: reset() power-cycles and KEEPS the imported battery (export == import)', eqBytes(c.exportSave(0), pat2));
  for (let f = 0; f < 300; f++) { c.setKeys(0, 0); c.runFrame(); }
  ok('SoulGold: and the game that boots from it leaves it alone for 300 frames', eqBytes(c.exportSave(0), pat2));
  ok('a 64 KiB image is REFUSED by a 1 Mbit-flash cartridge (control: the bridge checks the chip size)', c.setSave(0, pat.subarray(0, 0x10000)) === false);
  control('a legacy 0x22000-byte buffer is REFUSED by setSave (the page must convert first)', c.setSave(0, new Uint8Array(0x22000)) === false);
  ok('a refused import left the previous battery in place', eqBytes(c.exportSave(0), pat2));
  c.close();
  // 2. a legacy buffer -> converter -> the cartridge accepts it and hands the same chip image back
  for (const [name, kind, n] of [[KIRBY, 'sram', 0x8000], [SA3, 'flash512', 0x10000], [SOUL, 'flash1m', 0x20000], [SIMCITY, 'eeprom', 0x200]]) {
    const raw = pattern(n, 21), legacy = BAT.toLegacy(raw, kind);
    c = await MgbaCore.create({ seats: 1 }); const inf = c.loadRom(rom(name));
    const conv = BAT.fromLegacy(legacy, inf.saveTag);
    const accepted = !!conv && c.setSave(0, conv.bytes);
    ok(`${name} (${inf.saveTag}): legacy buffer -> converter -> setSave accepted, exportSave == the chip image (${n} B)`, accepted && eqBytes(c.exportSave(0), raw));
    const mut = mutantFromLegacy(legacy, kind);
    const mutAccepted = c.setSave(0, mut.bytes) && eqBytes(c.exportSave(0), raw);
    control(`${name}: the wrong-layout converter does NOT yield the saved data`, !mutAccepted);
    c.close();
  }
  // 3. EEPROM size: an 8 KiB legacy image reaches an EEPROM cartridge as 8 KiB
  { const raw = pattern(0x2000, 33), conv = BAT.fromLegacy(BAT.toLegacy(raw, 'eeprom'), 'eeprom');
    const cc = await MgbaCore.create({ seats: 1 }); cc.loadRom(rom(SIMCITY));
    ok('Sim City 2000: an 8 KiB EEPROM image is accepted and read back whole', conv.bytes.length === 0x2000 && cc.setSave(0, conv.bytes) && eqBytes(cc.exportSave(0), raw)); cc.close(); }
  // 4. a game that writes its own battery: persistence logic needs a stable, non-blank export after real play
  { const k = await MgbaCore.create({ seats: 1 }); k.loadRom(rom(KIRBY));
    ok('Kirby: before the game touches its save, exportSave is null (the page must not persist "nothing")', k.exportSave(0) === null);
    for (let f = 1; f <= 400; f++) { k.setKeys(0, MASH(f)); k.runFrame(); }
    const b = k.exportSave(0); ok('Kirby: after 400 frames the game has written a 32 KiB battery that is not blank', !!b && b.length === 0x8000 && !BAT.isBlank(b), b ? b.length + ' B' : 'null');
    k.close(); }
}

// =====================================================================================================================
// BROWSER
// =====================================================================================================================
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s || '', 'base64'));

// Helpers injected into every page (window.__t).
const PAGE_HELPERS = `(() => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('GBAWASMDB'); r.onupgradeneeded = (e) => { if (!e.target.result.objectStoreNames.contains('GBAWASMSTATES')) e.target.result.createObjectStore('GBAWASMSTATES', { autoIncrement: true }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const u8ToB64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const b64ToU8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  window.__t = {
    u8ToB64, b64ToU8,
    async idbGet(key) { const db = await open(); const v = await new Promise((res) => { const r = db.transaction('GBAWASMSTATES').objectStore('GBAWASMSTATES').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }); return v ? u8ToB64(v instanceof Uint8Array ? v : new Uint8Array(v)) : null; },
    async idbPut(key, b64) { const db = await open(); await new Promise((res, rej) => { const tx = db.transaction('GBAWASMSTATES', 'readwrite'); tx.objectStore('GBAWASMSTATES').put(b64ToU8(b64), key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; },
    async idbKeys() { const db = await open(); return new Promise((res) => { const out = []; db.transaction('GBAWASMSTATES').objectStore('GBAWASMSTATES').openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push(String(c.key)); c.continue(); } else res(out); }; }); },
    canvasStats() {
      const d = myApp.drawContext.getImageData(0, 0, 240, 160).data; let nz = 0, h = 0x811C9DC5; const set = new Set();
      for (let i = 0; i < d.length; i += 4) { const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; if (v) nz++; set.add(v); h ^= d[i]; h = Math.imul(h, 16777619); h ^= d[i + 1]; h = Math.imul(h, 16777619); h ^= d[i + 2]; h = Math.imul(h, 16777619); }
      return { nonBlack: nz / 38400, colors: set.size, hash: h >>> 0 };
    },
    async gunzipLen(b64) { const ds = new DecompressionStream('gzip'); const w = ds.writable.getWriter(); w.write(b64ToU8(b64)); w.close(); return (await new Response(ds.readable).arrayBuffer()).byteLength; },
    async gzipB64(len, fill) { const cs = new CompressionStream('gzip'); const w = cs.writable.getWriter(); w.write(new Uint8Array(len).fill(fill || 0)); w.close(); return u8ToB64(new Uint8Array(await new Response(cs.readable).arrayBuffer())); },
    // The page records every toast it raises as "<kind>: <text>" in window.__gbaToasts (script.js gbaToast); there is no toastr to tap any more.
    get toasts() { return window.__gbaToasts || []; },
  };
  return true;
})()`;

async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}

function cpuLoad() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 });
    const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null;
  } catch (_e) { return null; }
}

const KEYS = { Enter: ['Enter', 'Enter', 13], Down: ['ArrowDown', 'ArrowDown', 40], A: ['m', 'KeyM', 77], B: ['n', 'KeyN', 78] };
async function press(page, k, hold = 110) { await page.press(KEYS[k][0], KEYS[k][1], KEYS[k][2], hold); }
async function rectOf(page, sel) { return JSON.parse(await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`)); }
// A real click lands on whatever is on top at that point. The page's #toast is pointer-events:none, so it cannot swallow a click (the old
// toastr container could: the Export .sav click was once swallowed by the 'Imported ...' toast), but the toast is still cleared first and
// the hit-test is asserted: a click that would not reach the button is a harness error, not a pass.
async function clickSel(page, sel) {
  await page.eval("(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); return true; })()");
  const r = await rectOf(page, sel); const x = Math.round(r.x + r.w / 2), y = Math.round(r.y + r.h / 2);
  const hit = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}), h = document.elementFromPoint(${x}, ${y}); return !!h && (h === e || e.contains(h)); })()`);
  if (!hit) throw new Error('clickSel: the point (' + x + ',' + y + ') of ' + sel + ' is covered by another element');
  await page.click(x, y);
}
async function bootPage(page, urlQuery = '') {
  await page.navigate(`http://localhost:${PORT}/gba.html${urlQuery}`);
  await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 });
  await page.eval(PAGE_HELPERS);
}
async function startRom(page, title, { via = 'click' } = {}) {
  await page.eval(`(() => { const s = document.getElementById('romSelect'); const o = [...s.options].find((x) => x.textContent.includes(${JSON.stringify(title)})); s.value = o.value; s.dispatchEvent(new Event('change')); return o.value; })()`);
  if (via === 'click') await clickSel(page, '#btnStart'); else await page.eval('myApp.loadRom()');
  await page.waitFor('myApp.isRunning === true && myApp.frameCnt > 5', { timeoutMs: 60000 });
}
async function waitFrames(page, n, { speed = 1, timeoutMs = 120000 } = {}) {
  const start = await page.eval('myApp.frameCnt');
  await page.eval(`myApp.setGameSpeed(${speed})`);
  await page.waitFor(`myApp.frameCnt >= ${start + n}`, { timeoutMs });
  await page.eval('myApp.setGameSpeed(1)');
  return start + n;
}
// Downloads need `eventsEnabled: true` in this headless-new Chrome (measured: without it a blob download clicked from the page
// never produced a file; with it the file lands under its suggested name).
// UNPACED capacity: the page's loop is paused (isRunning=false) while 600 frames run back to back in the page's own core. A HEADROOM figure (how much
// faster than hardware this core could be driven here), not a presented rate and not a claim about any device.
async function measureCapacity(page, n = 600) {
  return JSON.parse(await page.eval(`(() => { const a = myApp; a.isRunning = false; const c = a.core; const N = ${n}; const t = performance.now(); for (let i = 0; i < N; i++) { c.setKeys(0, 0); c.runFrame(); } const ms = (performance.now() - t) / N; a.isRunning = true; a._lastFrameTime = null; return JSON.stringify({ ms }); })()`)).ms;
}
async function allowDownloads(page, dir) {
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true })
    .catch(() => page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }));
}
// Runtime.evaluate has no top-level await, so the async read goes through a promise the helper returns.
async function idbKeys(page) { return JSON.parse(await page.eval('__t.idbKeys().then((k) => JSON.stringify(k))')); }
async function waitDownload(dir, nameLike, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.includes(nameLike) && !x.endsWith('.crdownload')) : [];
    if (f.length) return path.join(dir, f[0]);
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}

async function desktopSession(R) {
  section('browser A: desktop - boot, SoulGold, title + in-game screenshots, key input, audio, battery import/export, states, speed lock, pacing');
  const dl = path.join(OUT, 'dl_A'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  await withBrowser({ port: 9251 + CDP_OFFSET, width: 1000, height: 900 }, async (page) => {
    await allowDownloads(page, dl);
    // ---- boot
    await bootPage(page);
    const boot = JSON.parse(await page.eval(`JSON.stringify({ iso: crossOriginIsolated, sab: typeof SharedArrayBuffer, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), mgba: typeof window.MgbaCore, factory: typeof window.createMgbaCore, heap: myApp.core.memory().heapBytes, err: myApp.rivetsData.lblError, scripts: [...document.scripts].map((s) => s.src).filter((s) => /gba/.test(s)).map((s) => s.replace(location.origin, '')) })`));
    ok('the page is NOT cross-origin isolated, has no SharedArrayBuffer and no controlling service worker - and the core booted anyway', boot.iso === false && boot.sab === 'undefined' && boot.sw === false && boot.mgba === 'object' && boot.factory === 'function' && boot.err === '', JSON.stringify({ iso: boot.iso, sab: boot.sab, sw: boot.sw, heap: boot.heap }));
    ok('no 44vba file was requested by the page', !boot.scripts.some((s) => /44gba/.test(s)), boot.scripts.join(' '));
    const res44 = JSON.parse(await page.eval(`JSON.stringify(performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /44gba/.test(n)))`));
    ok('the Resource Timing list holds no 44gba.js / 44gba.wasm request', res44.length === 0, JSON.stringify(res44));
    // ---- capability gate
    const gate = JSON.parse(await page.eval(`(async () => { await Capability.ready; return JSON.stringify({ spec: Capability.SPECS.gba, verdict: Capability.verdict(Capability.SPECS.gba).level, startBlocked: ['btnStart', 'mobileSplashStart'].map((id) => { const e = document.getElementById(id); return e ? (e.getAttribute('aria-disabled') || e.disabled || false) : null; }), sabBlockers: Capability.blockers({ sab: 'required' }).length, coiBlockers: Capability.blockers({ coi: 'required' }).length }); })()`));
    ok('Capability.SPECS.gba requires only wasm, and this page passes its own gate (verdict ok, Start not held down)', JSON.stringify(gate.spec) === '{"wasm":"required"}' && gate.verdict === 'ok' && gate.startBlocked[0] !== true && gate.startBlocked[0] !== 'true', JSON.stringify(gate));
    control('the same page FAILS a spec that asks for SharedArrayBuffer / isolation (so the gate can say no here, and gba simply does not ask)', gate.sabBlockers > 0 && gate.coiBlockers > 0, `sab blockers ${gate.sabBlockers}, coi blockers ${gate.coiBlockers}`);
    const net0 = JSON.parse(await page.eval('JSON.stringify(__gbaNet())'));
    // ---- start SoulGold
    await startRom(page, 'SoulGold');
    const net1 = JSON.parse(await page.eval('JSON.stringify(__gbaNet())'));
    // GR2 (rooms are wired): `supported` is now Netplay.supported() && room.js loaded - true in headless Chrome - and a SOLO page reports no session and a
    // free speed control. (Before GR2 this asserted supported:false with a reason; that was the honest answer while rooms were not wired.)
    ok('window.__gbaNet() - the "emulator is running" witness tools/mobile_chrome_test.mjs reads - says live:false before Start and live:true with frames > 0 after, no session / mode "none", roomLocked false, core "mgba"', net0.live === false && net0.frames === 0 && net1.live === true && net1.frames > 0 && net1.supported === true && net1.mode === 'none' && net1.session === false && net1.roomLocked === false && net1.core === 'mgba', JSON.stringify({ before: { live: net0.live, frames: net0.frames }, after: { live: net1.live, frames: net1.frames, supported: net1.supported, mode: net1.mode, core: net1.core } }));
    const rinfo = JSON.parse(await page.eval('JSON.stringify(myApp.romInfo)'));
    ok('Start on "Pokemon SoulGold" loaded the right ROM (code BPEE, 32 MiB, flash1m)', rinfo.code === 'BPEE' && rinfo.romSize === 33554432 && rinfo.saveTag === 'flash1m', JSON.stringify({ code: rinfo.code, size: rinfo.romSize, tag: rinfo.saveTag }));
    const f0 = await page.eval('myApp.frameCnt'); await sleep(2000); const f1 = await page.eval('myApp.frameCnt');
    ok('the frame counter is advancing (2 s window)', f1 - f0 > 60, `${f1 - f0} frames`);
    control('a paused core would fail that check (isRunning=false for 600 ms freezes the counter)', await (async () => { await page.eval('myApp.isRunning = false'); const a = await page.eval('myApp.frameCnt'); await sleep(600); const b = await page.eval('myApp.frameCnt'); await page.eval('myApp.isRunning = true'); return b === a; })());
    // ---- audio
    const au = JSON.parse(await page.eval(`JSON.stringify({ ctx: !!myApp.audioContext, state: myApp.audioContext && myApp.audioContext.state, rate: myApp.audioContext && myApp.audioContext.sampleRate, cart: window.__cartAudio })`));
    ok('an AudioContext was created by the Start click and is running', au.ctx && au.state === 'running', JSON.stringify({ state: au.state, rate: au.rate }));
    ok('the cart_audio sink is a worklet created with srcRate 48000 and has been fed', au.cart && au.cart.mode === 'worklet' && au.cart.srcRate === 48000 && au.cart.rxFrames > 0, JSON.stringify(au.cart));
    // ---- canvas + title
    { const cur = Number(await page.eval('myApp.frameCnt')); await waitFrames(page, Math.max(1, 1000 - cur), { speed: 5 }); }
    await sleep(700);
    const title = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('the canvas is not blank on the title screen (non-black pixels and several colours)', title.nonBlack > 0.1 && title.colors > 8, JSON.stringify(title));
    control('a never-drawn canvas would fail that check (a fresh 240x160 canvas reads as 0% non-black, 1 colour)', await page.eval(`(() => { const c = document.createElement('canvas'); c.width = 240; c.height = 160; const d = c.getContext('2d').getImageData(0, 0, 240, 160).data; let nz = 0; for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) nz++; return nz === 0; })()`));
    const png1 = path.join(OUT, 'solo_title.png'); await page.screenshot(png1); R.screens.title = png1;
    // ---- key input moves a cursor (main menu: New Game / Option)
    await press(page, 'Enter'); await sleep(1500);
    const m0 = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())')); await sleep(600); const m0b = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('on the main menu the picture is STABLE with no input (two samples 600 ms apart are identical)', m0.hash === m0b.hash && m0.nonBlack > 0.5, `${m0.hash} / ${m0b.hash}`);
    await press(page, 'Down'); await sleep(700);
    const m1 = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('pressing Down on the keyboard moved the menu cursor (canvas changed after the key)', m1.hash !== m0.hash, `${m0.hash} -> ${m1.hash}`);
    await sleep(600); const m1b = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('and the new picture is stable too (the change was the cursor, not noise)', m1b.hash === m1.hash);
    const png2 = path.join(OUT, 'solo_menu.png'); await page.screenshot(png2); R.screens.menu = png2;
    // the same press through the SP-style flag path is covered by the mobile section; here also prove the key reached the core, not only the canvas
    const seen = await page.eval(`(async () => { const c = myApp.core, orig = c.setKeys.bind(c); let got = 0; c.setKeys = (s, m) => { got |= m; return orig(s, m); }; await new Promise((r) => setTimeout(r, 50)); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); await new Promise((r) => setTimeout(r, 120)); document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' })); c.setKeys = orig; return got; })()`);
    ok('the Up key reached core.setKeys as KEY.UP (64)', (seen & 64) === 64, 'mask bits seen ' + seen);
    // ---- in-game frame: New Game -> Professor Oak
    await press(page, 'A');
    await page.eval('myApp.setGameSpeed(5)');
    for (let i = 0; i < 12; i++) { await press(page, 'A', 80); await sleep(220); }
    await page.eval('myApp.setGameSpeed(1)'); await sleep(900);
    const ig = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('after New Game and key mashing the picture is a different, non-blank in-game scene (not the title, not the menu)', ig.hash !== title.hash && ig.hash !== m1.hash && ig.nonBlack > 0.3 && ig.colors > 8, JSON.stringify(ig));
    const png3 = path.join(OUT, 'solo_ingame.png'); await page.screenshot(png3); R.screens.ingame = png3;
    { const ms = await measureCapacity(page); R.capacity_ingame = { scene: 'SoulGold, Professor Oak intro (dialogue box, 2 sprites)', ms_per_frame: +ms.toFixed(3), headroom_x: +((1000 / MgbaCore.FPS) / ms).toFixed(1) };
      info(`CAPACITY in-game scene (${R.capacity_ingame.scene}; loop paused, 600 back-to-back core frames): ${ms.toFixed(3)} ms/frame = ${R.capacity_ingame.headroom_x}x headroom over the 16.742 ms budget; spare capacity, not a presented rate`);
      ok('the core has headroom over 1.000x in the in-game scene too (ms/frame < 16.74)', ms < 1000 / MgbaCore.FPS, ms.toFixed(3) + ' ms'); }
    // ---- BATTERY: Import .sav through the real button + file chooser, Export .sav through the real button + download
    const imp = pattern(0x20000, 77), impFile = path.join(OUT, 'import_A.sav'); fs.writeFileSync(impFile, imp);
    await page.send('DOM.enable'); await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
    const chooser = new Promise((resolve) => { const h = (m) => { if (m.method === 'Page.fileChooserOpened') { page.handlers = page.handlers.filter((x) => x !== h); resolve(m.params); } }; page.handlers.push(h); });
    await clickSel(page, '#btnImportSav');
    const fc = await Promise.race([chooser, sleep(8000).then(() => null)]);
    ok('clicking Import .sav opened the file chooser (intercepted)', !!fc && fc.backendNodeId > 0, fc ? 'mode ' + fc.mode : 'no chooser');
    if (fc) await page.send('DOM.setFileInputFiles', { files: [impFile], backendNodeId: fc.backendNodeId });
    await page.waitFor('!!myApp.lastImport', { timeoutMs: 10000 }).catch(() => {});
    const li = JSON.parse(await page.eval('JSON.stringify(myApp.lastImport || null)'));
    const coreFrames = await page.eval('myApp.core.frames(0)');
    ok('the 128 KiB .sav was imported (lastImport.bytes == 131072) and the game restarted from power-on (judged by the core frame counter, which a reset clears; the page frameCnt is cumulative)', !!li && li.bytes === 131072 && coreFrames < 400, JSON.stringify({ li, coreFrames }));
    const live = unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))'));
    ok('Export (live core) == the imported bytes, all 131072', eqBytes(live, imp));
    await sleep(500);
    await clickSel(page, '#btnExportSav');
    const dlf = await waitDownload(dl, '.sav');
    ok('clicking Export .sav downloaded "Pokemon SoulGold (v1.1.1).sav" (named after the ROM, not "…gba.sav")', !!dlf && path.basename(dlf) === 'Pokemon SoulGold (v1.1.1).sav', dlf ? path.basename(dlf) : 'no file');
    ok('the downloaded file is byte-identical to what was imported (131072 B)', !!dlf && eqBytes(fs.readFileSync(dlf), imp), dlf ? fs.statSync(dlf).size + ' B' : '');
    const stored = unb64(await page.eval(`__t.idbGet(${JSON.stringify('Pokemon SoulGold (v1.1.1).gba.mgba.sav')})`) || '');
    ok('IndexedDB holds the battery under the NEW key <rom>.mgba.sav (raw 128 KiB), and the old <rom>.sav key was not created', eqBytes(stored, imp) && !((await idbKeys(page)).includes('Pokemon SoulGold (v1.1.1).gba.sav')));
    // negative controls at the UI seam
    const bad = JSON.parse(await page.eval(`(async () => { const r = []; r.push(await myApp.importSavBytes(new Uint8Array(1000), 'bad.sav')); r.push(await myApp.importSavBytes(new Uint8Array(0x8000).fill(1), 'sram-into-flash.sav')); return JSON.stringify({ r, t: __t.toasts.slice(-2) }); })()`));
    ok('a 1000-byte file and a 32 KiB SRAM image are refused by a Flash-1M game, with a message', bad.r[0] === false && bad.r[1] === false && bad.t.length === 2, JSON.stringify(bad));
    ok('and the refused imports changed nothing (the stored battery is still the imported one)', eqBytes(unb64(await page.eval(`__t.idbGet(${JSON.stringify('Pokemon SoulGold (v1.1.1).gba.mgba.sav')})`)), imp) && eqBytes(unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))')), imp));
    // ---- SAVE STATE (in session): button -> IndexedDB -> Load State
    await page.eval('myApp.lastSavedState = null; myApp.lastRestore = null');
    const ssPre = await page.eval('myApp.frameCnt');
    await clickSel(page, '#btnSave');
    await page.waitFor('myApp.lastSavedState && myApp.lastSavedState.storedBytes > 0', { timeoutMs: 15000 });
    const ss = JSON.parse(await page.eval('JSON.stringify(myApp.lastSavedState)'));
    const stateB64 = await page.eval(`__t.idbGet(${JSON.stringify('Pokemon SoulGold (v1.1.1).gba.mgba.state.gz')})`);
    ok('Save State wrote <rom>.mgba.state.gz: a gzip that inflates to exactly 0x61000 bytes, and is small', !!stateB64 && (await page.eval(`__t.gunzipLen(${JSON.stringify(stateB64)})`)) === 0x61000 && ss.storedBytes < 0x61000, `${ss.storedBytes} B stored for ${ss.bytes} B`);
    ok('the old state key <rom>.sav.state was NOT written', !((await idbKeys(page)).includes('Pokemon SoulGold (v1.1.1).gba.sav.state')));
    await waitFrames(page, 200);
    const afterRun = JSON.parse(await page.eval('JSON.stringify({ g: myApp.core.hashGame(0), f: myApp.core.frames(0) })'));
    ok('after 200 more frames the machine is in a different state than the one saved (so the restore below can fail)', afterRun.g !== ss.hashGame && afterRun.f > ss.frames, `${hex(ss.hashGame)} -> ${hex(afterRun.g)}`);
    await page.waitFor('document.getElementById("btnLoad").disabled === false', { timeoutMs: 5000 });
    await clickSel(page, '#btnLoad');
    await page.waitFor('!!myApp.lastRestore', { timeoutMs: 15000 });
    const rs = JSON.parse(await page.eval('JSON.stringify(myApp.lastRestore)'));
    ok('Load State restored the saved machine: hashGame == the one captured when it was saved, same frame counter', rs.hashGame === ss.hashGame && rs.frames === ss.frames, `${hex(rs.hashGame)} vs ${hex(ss.hashGame)}, frames ${rs.frames} vs ${ss.frames}`);
    const f2a = await page.eval('myApp.frameCnt'); await sleep(800);
    ok('and the game keeps running from it', (await page.eval('myApp.frameCnt')) > f2a + 20);
    // controls: a state that is the wrong size / not a gzip is refused and changes nothing
    const refused = JSON.parse(await page.eval(`(async () => {
      const key = 'Pokemon SoulGold (v1.1.1).gba.mgba.state.gz'; const good = await __t.idbGet(key);
      const small = await __t.gzipB64(1000, 3); await __t.idbPut(key, small);
      myApp.lastRestore = null; const before = myApp.core.hashGame(0);
      await myApp.loadStateLocal();
      const out = { wrongSizeRefused: myApp.lastRestore === null && myApp.core.hashGame(0) === before, toast: __t.toasts.slice(-1)[0] };
      const big = await __t.gzipB64(0x61000 + 1, 0); const r1 = await myApp.importStateBytes(Uint8Array.from(atob(big), (c) => c.charCodeAt(0)));
      const r2 = await myApp.importStateBytes(new Uint8Array([1, 2, 3, 4, 5]));
      out.importOversize = r1; out.importNotGzip = r2; out.oversizeToast = __t.toasts.slice(-2)[0];
      const own = Uint8Array.from(atob(good), (c) => c.charCodeAt(0)); out.importOwn = await myApp.importStateBytes(own);
      out.restoredKey = (await __t.idbGet(key)) === good;
      return JSON.stringify(out); })()`));
    ok('a stored state of the wrong size is refused by Load State, with a message, and the machine is untouched', refused.wrongSizeRefused && /bytes|unreadable|accept/i.test(refused.toast || ''), JSON.stringify({ r: refused.wrongSizeRefused, t: refused.toast }));
    ok('Import State refuses a gzip of 0x61001 bytes and a non-gzip file; it accepts our own export', refused.importOversize === false && refused.importNotGzip === false && refused.importOwn === true && refused.restoredKey, JSON.stringify(refused));
    // ---- legacy state seam (the old core's key is reported, never loaded)
    // (the full legacy flow, with a pre-seeded profile, is browser session B)
    // ---- THE SPEED CONTROL IS NOT A WAY AROUND GATE 9
    const lock = JSON.parse(await page.eval(`(async () => {
      const a = { open: myApp.setGameSpeed(5), speed: myApp.gameSpeed };
      myApp.setGameSpeed(1);
      myApp.roomLocked = true; const f0 = myApp.frameCnt; const r = myApp.setGameSpeed(5); const sp = myApp.gameSpeed;
      await new Promise((res) => setTimeout(res, 2000)); const d = myApp.frameCnt - f0;
      myApp.roomLocked = false; myApp.setGameSpeed(1);
      return JSON.stringify({ a, refused: r === false, speedAfterRefusal: sp, framesIn2s: d }); })()`));
    ok('with roomLocked=true setGameSpeed(5) is refused and the guest still runs 1 frame per 1/59.7275 s (2 s => ~120 frames, not ~600)', lock.a.open === true && lock.refused && lock.speedAfterRefusal === 1 && lock.framesIn2s > 100 && lock.framesIn2s < 140, JSON.stringify(lock));
    control('with the lock OFF speed 5 really does multiply the guest (the check above would fail without the lock)', await (async () => { const a = await page.eval('myApp.frameCnt'); await page.eval('myApp.setGameSpeed(5)'); await sleep(1000); const b = await page.eval('myApp.frameCnt'); await page.eval('myApp.setGameSpeed(1)'); return b - a > 200; })());
    // ---- PACING + RATE (solo, 1.000x). Not a device number.
    await sleep(500);
    const L0 = cpuLoad();
    const au0 = JSON.parse(await page.eval('JSON.stringify(window.__cartAudio)'));
    const rx0 = await page.eval('window.__cartAudio.rxFrames'), fr0 = await page.eval('myApp.frameCnt'), t0 = Date.now();
    await sleep(10000);
    const au1 = JSON.parse(await page.eval('JSON.stringify(window.__cartAudio)'));
    const rx1 = await page.eval('window.__cartAudio.rxFrames'), fr1 = await page.eval('myApp.frameCnt'), t1 = Date.now();
    const L1 = cpuLoad();
    const secs = (t1 - t0) / 1000, fps = (fr1 - fr0) / secs, audioFps = (rx1 - rx0) / 48000 / secs;
    R.rate = { paced_fps: +fps.toFixed(3), vs_59_7275: +(fps / MgbaCore.FPS).toFixed(4), guest_speed_via_audio: +audioFps.toFixed(4), seconds: +secs.toFixed(2), cpu_before: L0, cpu_after: L1 };
    info(`PACED (the page's own loop, 1.000x target): ${fps.toFixed(2)} guest fps over ${secs.toFixed(1)} s = ${(fps / MgbaCore.FPS).toFixed(4)}x of 59.7275; audio produced ${audioFps.toFixed(4)} s of sound per wall second; Windows CPU ${L0}% -> ${L1}%`);
    ok('the solo loop runs the guest at 1.000x of 59.7275 fps (within 1.5%) - a pacing check, NOT a performance claim', Math.abs(fps / MgbaCore.FPS - 1) < 0.015, fps.toFixed(3) + ' fps');
    ok('the audio sink received 1.000x seconds of sound per wall second (an independent witness: within 1.5%)', Math.abs(audioFps - 1) < 0.015, audioFps.toFixed(4));
    ok('the sink counted no overflow and the guest never ran faster than hardware (frames <= wall time x 59.7275 + 3)', (fr1 - fr0) <= secs * MgbaCore.FPS + 3 && JSON.parse(await page.eval('JSON.stringify(window.__cartAudio.overflowFrames)')) === 0);
    const sinkStats = JSON.parse(await page.eval('JSON.stringify(window.__cartAudio)')); R.audio = sinkStats;
    // The session totals above include the seconds this test itself spent fast-forwarded (audio is dropped at speed > 1 on purpose) and paused; the
    // PACED window is the one that says whether the sink played a steady 1.000x stream without a gap.
    const dUnder = au1.underruns - au0.underruns, dMissing = au1.missingFrames - au0.missingFrames, dOver = au1.overflowFrames - au0.overflowFrames;
    R.audio_paced_window = { seconds: +secs.toFixed(2), underruns: dUnder, missingFrames: dMissing, overflowFrames: dOver, backlogAtEnd: au1.backlog };
    info(`audio sink over the PACED window only: underruns +${dUnder}, missingFrames +${dMissing}, overflowFrames +${dOver}, backlog ${au1.backlog} frames`);
    ok('over the 10 s paced window the sink played with no gap and no overflow (underruns +0, missingFrames +0, overflowFrames +0)', dUnder === 0 && dMissing === 0 && dOver === 0, JSON.stringify(R.audio_paced_window));
    info(`audio sink: underruns=${sinkStats.underruns} missingFrames=${sinkStats.missingFrames} overflowFrames=${sinkStats.overflowFrames} mode=${sinkStats.mode}`);
    // capacity (unpaced; the loop is paused while it is measured). A headroom figure, not a presented rate.
    const cap = { ms: await measureCapacity(page) };
    R.capacity = { ms_per_frame: +cap.ms.toFixed(3), headroom_x: +((1000 / MgbaCore.FPS) / cap.ms).toFixed(1) };
    info(`CAPACITY (loop paused, 600 back-to-back core frames, SoulGold seconds after a power-cycle: logos/title): ${cap.ms.toFixed(3)} ms/frame vs the 16.742 ms budget = ${((1000 / MgbaCore.FPS) / cap.ms).toFixed(1)}x headroom; this is spare capacity, not a presented rate`);
    ok('the core has headroom over 1.000x here (ms/frame < the 16.74 ms budget)', cap.ms < 1000 / MgbaCore.FPS, cap.ms.toFixed(3) + ' ms');
    ok('no runFrame incident and no page error in the whole session', (await page.eval('myApp.incidents')) === 0 && page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
    R.session_A_errors = page.errors.slice(0, 5);
    await sleep(300);
  });
}

async function persistSession(R) {
  section('browser B: battery persistence across a reload (a real game\'s own save), flash import persistence, and the old core\'s data');
  const dl = path.join(OUT, 'dl_B'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  const KIRBY_NAME = KIRBY, KB = (s) => `${KIRBY_NAME}${s}`;
  await withBrowser({ port: 9252 + CDP_OFFSET, width: 1000, height: 900 }, async (page) => {
    await allowDownloads(page, dl);
    // ---- 1. Kirby writes its own SRAM; the page persists it on the falling edge, unaided
    await bootPage(page); await startRom(page, 'Kirby');
    await page.eval('myApp.setGameSpeed(5)');
    for (let i = 0; i < 30; i++) { await press(page, i % 3 === 0 ? 'Enter' : 'A', 60); await sleep(150); }
    await page.eval('myApp.setGameSpeed(1)');
    await page.waitFor(`__t.idbKeys().then((k) => k.includes(${JSON.stringify(KB('.mgba.sav'))}))`, { timeoutMs: 20000 }).catch(() => {});
    const liveSave = unb64(await page.eval('(() => { const b = myApp.core.exportSave(0); return b ? __t.u8ToB64(b) : ""; })()'));
    const persisted = unb64(await page.eval(`__t.idbGet(${JSON.stringify(KB('.mgba.sav'))}).then((v) => v || '')`) || '');
    ok('Kirby wrote a real 32 KiB battery and the page persisted it WITHOUT being asked (falling-edge write; no manual flush)', liveSave.length === 0x8000 && persisted.length === 0x8000 && !BAT.isBlank(persisted), `${liveSave.length} B live, ${persisted.length} B stored`);
    await page.eval('myApp.setGameSpeed(1)');
    await page.eval('myApp._flushBattery()'); await sleep(400);
    const live2 = unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))'));
    const stored2 = unb64(await page.eval(`__t.idbGet(${JSON.stringify(KB('.mgba.sav'))})`));
    ok('after a flush the stored copy equals the live battery byte for byte', eqBytes(live2, stored2));
    const png = path.join(OUT, 'solo_kirby.png'); await page.screenshot(png); R.screens.kirby = png;
    // ---- 2. reload: the same ROM comes back with that save (no Import involved)
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'Kirby');
    const reloaded = unb64(await page.eval('(() => { const b = myApp.core.exportSave(0); return b ? __t.u8ToB64(b) : ""; })()') || '');
    ok('after a RELOAD the core was handed the stored battery: exportSave right after Play == the pre-reload battery (32 KiB, every byte)', eqBytes(reloaded, stored2), `${reloaded.length} B`);
    const flagOk = await page.eval('myApp.rivetsData.noLocalSave === false');
    ok('the page knows a battery exists for this ROM (noLocalSave false)', flagOk === true);
    // Export .sav button == stored
    await clickSel(page, '#btnExportSav'); const f = await waitDownload(dl, 'Kirby');
    ok('Export .sav after the reload downloads "Kirby - Nightmare in Dream Land (U).sav" equal to the persisted battery', !!f && path.basename(f) === 'Kirby - Nightmare in Dream Land (U).sav' && eqBytes(fs.readFileSync(f), stored2), f ? path.basename(f) : 'none');
    // ---- 2b. a file the core REFUSES must not re-key the running game (rom_name moves only after the core accepts)
    const refuse = JSON.parse(await page.eval(`(async () => {
      const t = new Uint8Array(0x400); t[0xB2] = 0x96; const f0 = myApp.frameCnt, n0 = myApp.rom_name;
      await myApp._loadRomArrayBuffer(new Uint8Array(0x400).buffer, 'junk-no-0x96.gba');   // refused by the page (header byte)
      await myApp._loadRomArrayBuffer(t.buffer, 'junk-no-logo.gba');                       // passes the page, refused by the core (NOT_A_GBA_ROM, before it touches the game)
      await new Promise((r) => setTimeout(r, 600));
      return JSON.stringify({ n0, name: myApp.rom_name, running: myApp.isRunning, advanced: myApp.frameCnt > f0 + 10, toasts: __t.toasts.slice(-2) }); })()`));
    ok('two refused files (bad header byte; right byte but no logo) leave Kirby running under its own name, and both say why', refuse.name === refuse.n0 && refuse.name === KIRBY && refuse.running && refuse.advanced && refuse.toasts.length === 2 && refuse.toasts.every((t) => /^error:/.test(t)), JSON.stringify(refuse));
    ok('and no key was written for either refused file', !(await idbKeys(page)).some((k) => /^junk/.test(k)));
    // ---- 2c. a ROM dropped while another game runs: the running game's battery is written under ITS key before the core discards it
    const replaceRun = async (stubFlush) => {
      await page.navigate(`http://localhost:${PORT}/gba.html`);
      await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
      await startRom(page, 'Kirby');
      const before = unb64(await page.eval(`__t.idbGet(${JSON.stringify(KB('.mgba.sav'))})`));
      const mut = Uint8Array.from(before); mut[stubFlush ? 9 : 5] ^= 0xFF; mut[stubFlush ? 7000 : 6000] ^= 0x55;
      const r = JSON.parse(await page.eval(`(async () => {
        const set = myApp.core.setSave(0, __t.b64ToU8(${JSON.stringify(b64(mut))}));
        ${stubFlush ? 'myApp._flushBattery = async () => {};' : ''}
        const rom = ROMLIST.find((x) => x.title.includes('Sonic')); const ab = await (await fetch(rom.url)).arrayBuffer();
        await myApp._loadRomArrayBuffer(ab, ${JSON.stringify(SA3)});
        await new Promise((res) => setTimeout(res, 400));
        return JSON.stringify({ set, name: myApp.rom_name, running: myApp.isRunning, noLocalSave: myApp.rivetsData.noLocalSave }); })()`));
      const after = unb64(await page.eval(`__t.idbGet(${JSON.stringify(KB('.mgba.sav'))})`));
      return { r, before, mut, after, keys: await idbKeys(page) };
    };
    const rr = await replaceRun(false);
    ok('replacing Kirby with Sonic Advance 3 while Kirby runs: the Kirby battery (modified in memory) was written under the KIRBY key first, the page now runs Sonic, and Sonic did not inherit it', rr.r.set === true && eqBytes(rr.after, rr.mut) && !eqBytes(rr.after, rr.before) && rr.r.name === SA3 && rr.r.running && rr.r.noLocalSave === true && !rr.keys.includes(SA3 + '.mgba.sav'), JSON.stringify({ r: rr.r, flushed: eqBytes(rr.after, rr.mut) }));
    const rc = await replaceRun(true);
    control('the same replacement with the flush stubbed out LOSES the modified battery (the check above would fail on a page that does not flush first)', rc.r.set === true && !eqBytes(rc.after, rc.mut) && eqBytes(rc.after, rc.before), JSON.stringify({ lost: !eqBytes(rc.after, rc.mut) }));
    // Control: a different game does NOT inherit it
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'Sonic Advance 3');
    ok('control: another game (Sonic Advance 3) starts with NO battery from Kirby (noLocalSave true, no key written for it yet)', (await page.eval('myApp.rivetsData.noLocalSave')) === true && !(await idbKeys(page)).some((k) => k.startsWith('Sonic Advance 3')));
    // ---- 3. LEGACY: the old core's data. Seed a 0x22000 buffer + an old-format state for SoulGold and Sim City, then start them.
    const SG = 'Pokemon SoulGold (v1.1.1).gba', SC = 'Sim City 2000 (U).gba';
    const sgRaw = pattern(0x20000, 91), sgLegacy = BAT.toLegacy(sgRaw, 'flash1m');
    const scRaw = pattern(0x200, 92), scLegacy = BAT.toLegacy(scRaw, 'eeprom');
    const oldState = await page.eval('__t.gzipB64(3 * 1048576, 5)');   // stands in for the old core's gzip of a heap image (it only has to exist and not be an mGBA state)
    await page.eval(`(async () => { await __t.idbPut(${JSON.stringify(SG + '.sav')}, ${JSON.stringify(b64(sgLegacy))}); await __t.idbPut(${JSON.stringify(SG + '.sav.state')}, ${JSON.stringify(oldState)}); await __t.idbPut(${JSON.stringify(SC + '.sav')}, ${JSON.stringify(b64(scLegacy))}); return true; })()`);
    const before = { sgSav: md5(Buffer.from(sgLegacy)), st: md5(Buffer.from(unb64(oldState))), scSav: md5(Buffer.from(scLegacy)) };
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'SoulGold');
    const sgLive = unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))'));
    ok('SoulGold: the old core\'s 0x22000-byte save was CONVERTED and loaded: exportSave == its first 128 KiB (flash 1M)', eqBytes(sgLive, sgRaw), `${sgLive.length} B`);
    const sgNew = await page.eval(`__t.idbGet(${JSON.stringify(SG + '.mgba.sav')})`);
    ok('the converted battery was written ONCE to the new key <rom>.mgba.sav (raw 128 KiB)', !!sgNew && eqBytes(unb64(sgNew), sgRaw));
    const after = { sgSav: md5(Buffer.from(unb64(await page.eval(`__t.idbGet(${JSON.stringify(SG + '.sav')})`)))), st: md5(Buffer.from(unb64(await page.eval(`__t.idbGet(${JSON.stringify(SG + '.sav.state')})`)))) };
    ok('the old keys <rom>.sav and <rom>.sav.state are byte-for-byte UNTOUCHED', after.sgSav === before.sgSav && after.st === before.st, `${after.sgSav} / ${after.st}`);
    const lg = JSON.parse(await page.eval(`JSON.stringify({ flag: myApp.rivetsData.legacyState, note: myApp.rivetsData.legacyStateNote, noState: myApp.rivetsData.noLocalState, loadDisabled: document.getElementById('btnLoad').disabled, noteVisible: (() => { const e = document.getElementById('legacyStateNote'); return !!e && getComputedStyle(e).display !== 'none' && e.textContent.length > 20; })(), spNote: document.getElementById('mLegacyNote').textContent, toasts: __t.toasts.filter((t) => /state from the old emulator core/.test(t)).length })`));
    ok('a state left by the old core is REPORTED: note set, visible on the page, a warning toast, and Load State stays disabled', lg.flag === true && /old emulator core/.test(lg.note) && /cannot be loaded/.test(lg.note) && lg.noteVisible && lg.noState === true && lg.loadDisabled === true && lg.toasts >= 1, JSON.stringify({ flag: lg.flag, vis: lg.noteVisible, dis: lg.loadDisabled, toasts: lg.toasts }));
    ok('the touch-menu copy of the notice is filled in as well', /old emulator core/.test(lg.spNote));
    await page.eval('myApp.lastRestore = null; myApp.loadStateLocal()'); await sleep(500);
    ok('pressing Load State anyway loads nothing and says why (the legacy blob is never fed to mGBA)', (await page.eval('myApp.lastRestore')) === null && /old emulator core/.test(await page.eval('__t.toasts.slice(-1)[0]')));
    // Import .sav, then a RELOAD, then Play: the next session starts with exactly the imported bytes (flash 1M, through the real import path)
    { const imp2 = pattern(0x20000, 123);
      const impOk = await page.eval(`myApp.importSavBytes(__t.b64ToU8(${JSON.stringify(b64(imp2))}), 'again.sav')`);
      await page.navigate(`http://localhost:${PORT}/gba.html`);
      await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
      await startRom(page, 'SoulGold');
      const afterReload = unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))'));
      ok('Import .sav (SoulGold, 128 KiB) -> RELOAD -> Play: the new session starts with exactly the imported bytes', impOk === true && eqBytes(afterReload, imp2), afterReload.length + ' B');
      control('...and that is not the previous battery (the converted legacy save differs from the import)', !eqBytes(afterReload, sgRaw)); }
    // Sim City: legacy EEPROM
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'Sim City');
    const scLive = unb64(await page.eval('__t.u8ToB64(myApp.core.exportSave(0))'));
    ok('Sim City 2000: the old core\'s EEPROM (at 0x20000) was converted: exportSave == the 512-byte chip image', eqBytes(scLive, scRaw), `${scLive.length} B`);
    ok('control: Sim City has NO old state, so no legacy notice is shown', (await page.eval('myApp.rivetsData.legacyState')) === false && JSON.parse(await page.eval('JSON.stringify(__t.toasts.filter((t) => /state from the old emulator core/.test(t)).length)')) === 0);
    // a legacy buffer that is blank is not imported
    await page.eval(`__t.idbPut(${JSON.stringify(SBAM_NAME + '.sav')}, ${JSON.stringify(b64(new Uint8Array(0x22000).fill(0xFF)))})`);
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'Bust-A-Move');
    ok('control: an all-0xFF legacy buffer (the old page stored these every minute) is NOT imported as a save (no <rom>.mgba.sav written)', !(await idbKeys(page)).includes(SBAM_NAME + '.mgba.sav'));
    // ---- 4. a stored battery that this cartridge refuses must not be overwritten
    await page.eval(`__t.idbPut(${JSON.stringify(KIRBY + '.mgba.sav')}, ${JSON.stringify(b64(new Uint8Array(0x10000).fill(7)))})`);
    await page.navigate(`http://localhost:${PORT}/gba.html`);
    await page.waitFor('window.myApp && myApp.isWasmReady === true', { timeoutMs: 40000 }); await page.eval(PAGE_HELPERS);
    await startRom(page, 'Kirby');
    await page.eval('myApp.setGameSpeed(5)'); for (let i = 0; i < 12; i++) { await press(page, 'A', 60); await sleep(150); } await page.eval('myApp.setGameSpeed(1)'); await page.eval('myApp._flushBattery()'); await sleep(600);
    const kept = unb64(await page.eval(`__t.idbGet(${JSON.stringify(KIRBY + '.mgba.sav')})`));
    ok('a stored 64 KiB image that an SRAM cartridge REFUSES is left untouched (the session does not overwrite it) and a toast explains', kept.length === 0x10000 && kept.every((v) => v === 7) && (await page.eval('myApp._batBlocked')) === true && /does not fit/.test(await page.eval('__t.toasts.filter((t) => /does not fit/.test(t)).slice(-1)[0] || ""')));
    R.session_B_errors = page.errors.slice(0, 5);
    ok('no page error in session B', page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  });
}
const SBAM_NAME = SBAM;

async function mobileSession(R) {
  section('browser C: 390x844 phone viewport - the touch shell renders without horizontal scroll, controls reach the core');
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  await withBrowser({ port: 9253 + CDP_OFFSET, width: 390, height: 844, mobile: true }, async (page) => {
    await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    await bootPage(page);
    const pre = JSON.parse(await page.eval('JSON.stringify({ mobile: myApp.mobileMode, sw: document.documentElement.scrollWidth, iw: innerWidth, bw: document.body.scrollWidth })'));
    const spl = JSON.parse(await page.eval(`JSON.stringify({ splash: getComputedStyle(document.getElementById('mobileSplash')).display, desktop: getComputedStyle(document.getElementById('desktop')).display, startOn: !document.getElementById('mobileSplashStart').disabled, party: !document.getElementById('mobileSplashNet').hidden && document.getElementById('mobileSplashNet').offsetWidth > 0 })`));
    ok('before Start: mobileMode is on, the standard splash (#mobileSplash) is shown over the shell, the desktop page is hidden, and the 390 px viewport does not overflow', pre.mobile === true && spl.splash === 'flex' && spl.desktop === 'none' && pre.sw <= pre.iw && pre.bw <= pre.iw, JSON.stringify({ pre, spl }));
    // GR2: rooms are wired, so the splash Party button is VISIBLE (before GR2 this asserted it was hidden: a control that cannot work is worse than none)
    ok('the splash Start is enabled once the core is ready, and the splash Party button is visible (the room is wired: it is not a dead control)', spl.startOn === true && spl.party === true);
    // tap the splash Start with a touch
    await page.eval(`(() => { const s = document.getElementById('mobileRomSelect'); const o = [...s.options].find((x) => x.textContent.includes('Kirby')); s.value = o.value; })()`);
    const pr = await rectOf(page, '#mobileSplashStart'); await page.tap(Math.round(pr.x + pr.w / 2), Math.round(pr.y + pr.h / 2));
    await page.waitFor('myApp.isRunning === true && myApp.frameCnt > 30', { timeoutMs: 60000 });
    await sleep(1500);
    const sh = JSON.parse(await page.eval(`JSON.stringify({ shell: getComputedStyle(document.getElementById('mobileShell')).display, splash: getComputedStyle(document.getElementById('mobileSplash')).display, sw: document.documentElement.scrollWidth, iw: innerWidth, bw: document.body.scrollWidth, ih: innerHeight, sh: document.documentElement.scrollHeight, canvasParent: document.getElementById('canvas').parentElement.id })`));
    ok('the GBA SP touch shell is shown (display:flex), the splash is gone, and the canvas lives in #mobileScreen', sh.shell === 'flex' && sh.splash === 'none' && sh.canvasParent === 'mobileScreen', JSON.stringify({ shell: sh.shell, splash: sh.splash, parent: sh.canvasParent }));
    ok('no horizontal scroll while playing: documentElement.scrollWidth and body.scrollWidth <= innerWidth (390)', sh.sw <= sh.iw && sh.bw <= sh.iw, `scrollWidth ${sh.sw}, body ${sh.bw}, inner ${sh.iw}`);
    const cs = JSON.parse(await page.eval('JSON.stringify(__t.canvasStats())'));
    ok('the canvas is drawing (non-black, several colours) in the shell', cs.nonBlack > 0.05 && cs.colors > 4, JSON.stringify(cs));
    const ctrls = JSON.parse(await page.eval(`JSON.stringify([['mobileA', .5, .5], ['mobileB', .5, .5], ['mobileStart', .5, .5], ['mobileSelect', .5, .5], ['mobileL', .5, .5], ['mobileR', .5, .5], ['spDpadV', .5, .15], ['spDpadH', .15, .5], ['mobileMenuBtn', .5, .5]].map(([id, fx, fy]) => { const e = document.getElementById(id); if (!e) return { id, missing: true }; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(Math.round(r.x + r.width * fx), Math.round(r.y + r.height * fy)); return { id, inView: r.right <= innerWidth + 0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.width > 0, self: !!hit && (hit === e || e.contains(hit) || hit.contains(e)) }; }))`));
    ok('every touch control is inside the viewport and is what a tap at its centre hits', ctrls.every((c) => c.inView && c.self), JSON.stringify(ctrls.filter((c) => !(c.inView && c.self))));
    const mp = path.join(OUT, 'solo_mobile.png'); await page.screenshot(mp); R.screens.mobile = mp;
    // touch A / Start / d-pad Down reach the CORE as key bits (the loop reads flags once per frame; the 50 ms press floor must make a tap visible)
    await page.eval(`window.__masks = []; (() => { const c = myApp.core, o = c.setKeys.bind(c); c.setKeys = (s, m) => { window.__masks.push(m); return o(s, m); }; })()`);
    for (const [id, bit, label] of [['mobileA', 1, 'A'], ['mobileStart', 8, 'Start']]) {
      const r = await rectOf(page, '#' + id); await page.eval('window.__masks.length = 0'); await page.tap(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)); await sleep(250);
      const seen = await page.eval('window.__masks.some((m) => (m & ' + bit + ') !== 0)');
      ok(`a touch tap on ${label} reaches core.setKeys with the ${label} bit (even for a 0 ms tap, thanks to the press floor)`, seen === true);
    }
    { const r = await rectOf(page, '#spDpadV'); await page.eval('window.__masks.length = 0'); await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h * 0.9) }] }); await sleep(120); await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(120);
      ok('a touch on the lower half of the d-pad reaches the core as DOWN (128)', await page.eval('window.__masks.some((m) => (m & 128) !== 0)') === true); }
    control('with no touch the core is handed mask 0 (the bits above are not stuck on)', await (async () => { await sleep(300); await page.eval('window.__masks.length = 0'); await sleep(300); return await page.eval('window.__masks.length > 5 && window.__masks.every((m) => m === 0)'); })());
    // the menu: Export/Import .sav reachable
    const mb = await rectOf(page, '#mobileMenuBtn'); await page.tap(Math.round(mb.x + mb.w / 2), Math.round(mb.y + mb.h / 2)); await sleep(400);
    const menu = JSON.parse(await page.eval(`JSON.stringify({ open: document.getElementById('mobileMenu').classList.contains('open'), sw: document.documentElement.scrollWidth, iw: innerWidth, items: ['mExportSav', 'mImportSav', 'mSpeed', 'mMove'].map((id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return { id, w: r.width, vis: r.right <= innerWidth && r.left >= 0, self: hit === e }; }), overlayScrollW: document.getElementById('mobileMenu').scrollWidth, overlayClientW: document.getElementById('mobileMenu').clientWidth })`));
    ok('the touch menu (#mobileMenu) opens by touch and lists Export .sav, Import .sav, Speed and Move Controls, inside the viewport (the overlay scrolls vertically; no horizontal overflow)', menu.open && menu.items.every((i) => i.vis) && menu.overlayScrollW <= menu.overlayClientW && menu.sw <= menu.iw, JSON.stringify(menu));
    const mm = path.join(OUT, 'solo_mobile_menu.png'); await page.screenshot(mm); R.screens.mobileMenu = mm;
    ok('no page error in the mobile session', page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  });
}

// =====================================================================================================================
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (flag('--stamp')) { stampTokens(); return; }
  const wasmPath = path.join(DIST, 'mgba_core.wasm'), jsPath = path.join(DIST, 'mgba_core.js');
  const before = { wasm: md5(fs.readFileSync(wasmPath)), js: md5(fs.readFileSync(jsPath)), wrapper: md5(fs.readFileSync(path.join(MGBA, 'mgba_core.js'))) };
  console.log(`gba_mgba_solo_test: wasm md5 ${before.wasm}  glue md5 ${before.js}  wrapper md5 ${before.wrapper}`);
  const load0 = cpuLoad();
  console.log(`machine: ${os.cpus().length} logical CPUs; Windows has no load average, so CPU busy % is reported instead: ${load0 === null ? 'n/a' : load0 + '%'} at start (numbers from this box are not device numbers)`);
  const R = { screens: {}, started: new Date().toISOString() };
  if (want('static')) staticSection();
  if (want('converter')) converterSection();
  if (want('layout')) await layoutSection();
  if (want('audio')) { audioPipeUnit(); await audioMeasureSection(); }
  if (want('saves')) await savesSection();
  if (flag('--browser')) {
    spawnSync(process.execPath, [path.join(ROOT, 'tools/browser_leak_guard.js'), 'reap'], { stdio: 'inherit' });
    const srv = await ensureServer();
    try {
      if (want('desktop')) await desktopSession(R);
      if (want('persist')) await persistSession(R);
      if (want('mobile')) await mobileSession(R);
    } finally { srv.stop(); }
  }
  section('hash guard');
  const after = { wasm: md5(fs.readFileSync(wasmPath)), js: md5(fs.readFileSync(jsPath)), wrapper: md5(fs.readFileSync(path.join(MGBA, 'mgba_core.js'))) };
  console.log(`       md5 after : wasm ${after.wasm}  glue ${after.js}  wrapper ${after.wrapper}`);
  ok('wasm, glue and wrapper unchanged between the start and the end of this run (no torn relink)', before.wasm === after.wasm && before.js === after.js && before.wrapper === after.wrapper);
  R.cpu_end = cpuLoad(); R.pass = pass; R.fail = fail; R.md5 = before;
  try { fs.writeFileSync(path.join(OUT, 'gba_mgba_solo_report.json'), JSON.stringify(R, null, 1)); } catch (_e) { /* best effort */ }
  console.log(`\nscreens: ${JSON.stringify(R.screens)}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
