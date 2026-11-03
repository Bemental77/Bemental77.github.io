#!/usr/bin/env node
// tools/gba_room_protocol_test.mjs - exit tests for stage GR1: the GBA link-cable ROOM protocol (gba/mgba/room.js).
//
//   node tools/gba_room_protocol_test.mjs                 # everything that runs in Node (about 3 min): module tables battery mutants equivalent sweep docs cards tables-live frames policy e2e
//   node tools/gba_room_protocol_test.mjs --browser       # + room.js loaded as an ES module in headless Chrome (bare CDP, --mute-audio, PORT=8092 devserver)
//   node tools/gba_room_protocol_test.mjs --only config,end,e2e
//   node tools/gba_room_protocol_test.mjs --fast          # skip the sections that boot real cores (tables-live, frames, policy, e2e)
//   node tools/gba_room_protocol_test.mjs --campaign     # + the independent verifier's 74 one-line rewrites of room.js against the whole battery (opt-in: minutes)
//   GBA_ROOM_JS=<a rewritten copy of room.js> node tools/gba_room_protocol_test.mjs --only module,tables,battery,sweep,cards,frames   # an external mutation campaign
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (`[control]`: a mutant of room.js or a corrupted
// input that must be caught) next to the unmutated twin that must stay quiet. The mutants are made by rewriting room.js's SOURCE in memory
// and importing the result through a data: URL, so the file on disk is never touched.
//
// WHAT RUNS WHAT.
//   * The protocol is exercised against the REAL lib/netplay.js Lockstep engine (the card exchange, the start barrier, rsReplay, the
//     fingerprint compare) wired through a STAR bus that relays only what Session relays (RELAYED, parsed out of netplay.js).
//   * The machine is exercised on REAL mGBA cores (gba/mgba/mgba_core.js, Super Bust-A-Move / Kirby / Sonic Advance 3).
//   * The clean-end handshake is exercised on a FAKE core (a toy two-player "trade" machine) so a crash point can be swept exhaustively;
//     it is a model of the Trade Center, NOT Pokemon: no Pokemon save with a Cable Club in reach exists on this machine.
//   * No audio device is opened (Node only; the browser leg runs with --mute-audio). Timings are informational, taken on a shared box.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_JS = process.env.GBA_ROOM_JS ? path.resolve(process.env.GBA_ROOM_JS) : path.join(ROOT, 'gba/mgba/room.js');   // GBA_ROOM_JS: run everything against a rewritten copy (external mutation campaigns)
const DIST = path.join(ROOT, 'gba/mgba/dist');
const ROMS = path.join(ROOT, 'gba/gbaWasm/roms');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const FAST = flag('--fast');
const PORT = Number(process.env.GBA_TEST_PORT || 8092);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const info = (s) => console.log(`       ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5hex = (b) => crypto.createHash('md5').update(b).digest('hex');
const rom = (n) => fs.readFileSync(path.join(ROMS, n));
function cpuLoad() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 });
    const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null;
  } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// load room.js (real, and mutants through data: URLs), the engine, the core
// ---------------------------------------------------------------------------------------------------------------------------------
const SRC = fs.readFileSync(ROOM_JS, 'utf8');
async function loadSrc(src) { return import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64')); }
function mutate(from, to) {
  const parts = SRC.split(from);
  if (parts.length !== 2) throw new Error(`mutant anchor must occur exactly once (found ${parts.length - 1}): ${from.slice(0, 80)}`);
  return parts.join(to);
}
(0, eval)(fs.readFileSync(path.join(ROOT, 'lib/netplay.js'), 'utf8'));          // a script, not a module: sets globalThis.Netplay
const { Lockstep } = globalThis.Netplay;
const MgbaCore = require(path.join(ROOT, 'gba/mgba/mgba_core.js'));
const BUILDINFO = JSON.parse(fs.readFileSync(path.join(DIST, 'mgba_core.buildinfo.json'), 'utf8'));
const WASM = fs.readFileSync(path.join(DIST, 'mgba_core.wasm'));
const CORE_MD5 = BUILDINFO.md5['mgba_core.wasm'];
const R = await import(pathToFileURL(ROOM_JS).href);                              // the real module, loaded by path
const RELAYED = (() => {                                                           // the ONLY message types a guest's star link forwards (lib/netplay.js)
  const m = /const RELAYED = \{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, 'lib/netplay.js'), 'utf8'));
  return Object.fromEntries(m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean).map((k) => [k, 1]));
})();

// ---------------------------------------------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------------------------------------------
const GAMES = { sbam: 'Super Bust-A-Move', kirby: 'Kirby Nightmare in Dreamland', sa3: 'Sonic Advance 3' };
const ROOM_ID = '00112233445566aa';
const cfgFor = (game, seats, extra = {}, M = R) => M.makeConfig(Object.assign({ game, seats, coreBuildMd5: CORE_MD5, fixedEpochMs: 1700000000000, tzOffsetMin: -300, roomId: ROOM_ID }, extra));
const patternImage = (n, seed) => { const u = new Uint8Array(n); let x = (seed * 2654435761) >>> 0; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; u[i] = x >>> 24; } return u; };
const expectErr = async (fn) => { try { const v = await fn(); return { code: null, value: v }; } catch (e) { return { code: e && e.code, error: e, message: e && e.message, detail: e && e.detail }; } };
const same8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// Things the battery needs on every run (it runs once on the real module and once per mutant): read or built ONCE.
const memo = new Map();
const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
const romOnce = (name) => once('rom:' + name, () => rom(name));
const romFlipped = (name, at) => once('romflip:' + name + at, () => { const b = Buffer.from(romOnce(name)); b[at] ^= 1; return b; });     // a COPY, one byte different, same length
const wasmFlipped = () => once('wasmflip', () => { const b = Buffer.from(WASM); b[1000] ^= 1; return b; });
const bombGzip = () => once('bomb', () => new Uint8Array(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024))));      // 20 MiB of zeros -> about 20 KiB of gzip
const smallGzip = () => once('smallgz', () => new Uint8Array(zlib.gzipSync(Buffer.alloc(100))));              // inflates to 100 bytes

// A core that records what bootMachine does to it, so the boot contract is checked without booting 8 MiB of emulator for every mutant.
function stubMgba({ saveTag = 'sram', setSaveOk = true } = {}) {
  const calls = [];
  const core = {
    setRtc(a) { calls.push(['setRtc', a]); },
    loadRom(b, o) { calls.push(['loadRom', b.length]); return { saveTag }; },
    setSave(s, img) { calls.push(['setSave', s, Buffer.from(img)]); return setSaveOk; },
    close() { calls.push(['close']); },
    hash: (i) => 0x1000 + i, hashGame: (i) => 0x2000 + i, hashLink: () => 0x3000,
    setKeys() {}, runFrame() { return 0; },
  };
  return { MgbaCore: { create: async (o) => { calls.push(['create', o.seats]); return core; } }, calls, core };
}
// Count what a decompressor really produces: wrap the host's DecompressionStream so a bomb's cost is measured, not assumed.
async function withCountingInflate(fn) {
  const Real = globalThis.DecompressionStream; let produced = 0;
  globalThis.DecompressionStream = class extends Real {
    get readable() { return this._c || (this._c = super.readable.pipeThrough(new TransformStream({ transform(ch, ctl) { produced += ch.length; ctl.enqueue(ch); } }))); }
  };
  try { const r = await fn(); return { r, produced }; } finally { globalThis.DecompressionStream = Real; }
}

// A STAR bus of real Lockstep engines: a guest's message reaches the HOST only; the host forwards only RELAYED types to the other guests;
// the host's messages reach everyone. This is what lib/netplay.js's Session does (netplay.js:8958-9000), so a design that relied on a custom
// guest-to-guest message would fail here the way it would in a real room.
function starBus(ids, lockstepOpts, extra = {}) {
  const bus = { engines: [], byId: {}, sent: [], hook: null };
  const host = ids[0];
  const toEngine = (id, m) => { const e = bus.byId[id]; if (e) e.receive(m); };
  for (const id of ids) {
    const e = new Lockstep(Object.assign({}, lockstepOpts, extra, {
      host: id === host, peerId: id,
      send: (m) => {
        let tagged = Object.assign({ peer: id }, m);
        bus.sent.push(tagged.t);
        if (bus.hook) { tagged = bus.hook(id, tagged); if (!tagged) return; }
        if (id === host) { for (const g of ids) if (g !== host) toEngine(g, tagged); }
        else { toEngine(host, tagged); if (RELAYED[m.t]) for (const g of ids) if (g !== host && g !== id) toEngine(g, tagged); }
      },
    }));
    bus.engines.push(e); bus.byId[id] = e;
  }
  bus.host = bus.byId[host];
  return bus;
}
const seatAll = (bus) => { for (const e of bus.engines) bus.host.seat(e.peerId, 1); };

// Per-frame key expansion of a gba_link_smoke script (same step semantics as its runScript), out[f][seat].
function keysByFrame(steps, seats) {
  const out = [], keys = new Array(seats).fill(0), KEY = MgbaCore.KEY;
  const sel = (t) => (t === 'all' ? [...Array(seats).keys()] : Array.isArray(t) ? t : [t]);
  const maskOf = (names) => String(names).split('+').reduce((m, n) => m | (n === 'NONE' ? 0 : KEY[n.toUpperCase()]), 0);
  const step = (n) => { for (let i = 0; i < n; i++) out.push(keys.slice()); };
  for (const st of steps) {
    const c = st[0];
    if (c === 'wait') step(st[1]);
    else if (c === 'tap') { const hold = st[3] === undefined ? 6 : st[3], gap = st[4] === undefined ? 12 : st[4]; for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(hold); for (const s of sel(st[1])) keys[s] = 0; step(gap); }
    else if (c === 'hold') { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(st[3]); for (const s of sel(st[1])) keys[s] = 0; }
    else if (c === 'mash') { for (let i = 0; i < st[3]; i++) { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(3); for (const s of sel(st[1])) keys[s] = 0; step(5); } }
  }
  return out;
}

// Hand-build a SELF-CONSISTENT raw-codec envelope (valid chunk hashes, image hash, sizes) so that only the check under test can refuse it.
function forgeEntry({ seat, typeCode, raw }) {
  const M = R, n = raw.length ? Math.ceil(raw.length / 12288) : 0, env = new Uint8Array(28 + 4 * n + raw.length);
  const put = (o, v) => { env[o] = v & 255; env[o + 1] = (v >>> 8) & 255; env[o + 2] = (v >>> 16) & 255; env[o + 3] = (v >>> 24) & 255; };
  env.set([0x47, 0x42, 0x53, 0x31], 0); env[4] = seat; env[5] = typeCode; env[6] = 0; env[7] = 0;
  put(8, raw.length); put(12, raw.length); put(16, 12288); put(20, M.fnv1a(raw)); env[24] = n & 255; env[25] = n >>> 8;
  for (let i = 0; i < n; i++) put(28 + 4 * i, M.fnv1a(raw.subarray(i * 12288, Math.min(raw.length, (i + 1) * 12288))));
  env.set(raw, 28 + 4 * n);
  return { port: seat, size: raw.length, hash: M.cardHash(raw), enc: 'gba1;raw', bytes: env };
}

// An envelope that LISTS ONE CHUNK MORE than its payload holds, the extra hash being the hash of the empty piece: self-consistent in every
// way except the chunk count, so only the count check refuses it.
function forgeExtraChunk({ seat, typeCode, raw }) {
  const M = R, n = Math.ceil(raw.length / 12288), env = new Uint8Array(28 + 4 * (n + 1) + raw.length);
  const put = (o, v) => { env[o] = v & 255; env[o + 1] = (v >>> 8) & 255; env[o + 2] = (v >>> 16) & 255; env[o + 3] = (v >>> 24) & 255; };
  env.set([0x47, 0x42, 0x53, 0x31], 0); env[4] = seat; env[5] = typeCode;
  put(8, raw.length); put(12, raw.length); put(16, 12288); put(20, M.fnv1a(raw)); env[24] = (n + 1) & 255; env[25] = (n + 1) >>> 8;
  for (let i = 0; i < n; i++) put(28 + 4 * i, M.fnv1a(raw.subarray(i * 12288, Math.min(raw.length, (i + 1) * 12288))));
  put(28 + 4 * n, M.fnv1a(new Uint8Array(0)));
  env.set(raw, 28 + 4 * (n + 1));
  return { port: seat, size: raw.length, hash: M.cardHash(raw), enc: 'gba1;raw', bytes: env };
}

// A toy two-player TRADE machine standing in for a core (model of the Trade Center, not Pokemon): a seat's A-button edge is an OFFER; the next
// edge from a DIFFERENT seat is the CONFIRM and swaps the first 8 bytes of the two seats' battery images. Deterministic in (images, keys).
class FakeCore {
  constructor(seats, images) { this.seats = seats; this.img = images.map((x) => x.slice()); this.k = new Array(seats).fill(0); this.pk = new Array(seats).fill(0); this.offer = -1; this.n = 0; }
  setKeys(s, k) { this.k[s] = k & 0x3FF; }
  runFrame() {
    for (let s = 0; s < this.seats; s++) {
      if (!((this.k[s] & 1) && !(this.pk[s] & 1))) continue;
      if (this.offer < 0) this.offer = s;
      else if (this.offer !== s) { const a = this.offer; for (let i = 0; i < 8; i++) { const t = this.img[a][i]; this.img[a][i] = this.img[s][i]; this.img[s][i] = t; } this.offer = -1; }
    }
    this.pk = this.k.slice(); this.n++; return 0;
  }
  exportSave(s) { return this.img[s].slice(); }
  hash(s) { let h = 0x811c9dc5 ^ this.n; for (let i = 0; i < 32; i++) h = Math.imul(h ^ this.img[s][i], 0x01000193) >>> 0; return h; }
  hashLink() { return this.offer + 1; }
  close() {}
}

// ===============================================================================================================================
// THE BATTERY: every pure / fake-core check that a mutant of room.js can be held against. battery(M) returns [{ name, pass, detail }].
// It never throws and never prints, so the same battery runs against the real module (all must pass) and against each mutant (the named
// checks must fail).
// ===============================================================================================================================
async function battery(M, only) {
  const out = [];
  let cur = '';
  const chk = (name, cond, detail = '') => out.push({ name, pass: !!cond, detail, section: cur });
  // `only` (a Set of section names) lets a mutant run just the sections that hold the checks it is expected to trip.
  const guard = async (name, fn) => { if (only && !only.has(name)) return; cur = name; try { await fn(); } catch (e) { out.push({ name: name + ' (threw)', pass: false, detail: String((e && e.stack) || e).split('\n').slice(0, 2).join(' | '), section: name }); } };
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return (e && e.code) || ('THREW:' + ((e && e.message) || e)); } };
  const kirby = cfgFor(GAMES.kirby, 2, {}, M), kirby3 = cfgFor(GAMES.kirby, 3, {}, M), sa3 = cfgFor(GAMES.sa3, 2, {}, M);

  // ---- config + disc ---------------------------------------------------------------------------------------------------------
  await guard('config', async () => {
    const text = M.encodeConfig(kirby);
    chk('config: encode -> decode -> encode is the identity', M.encodeConfig(M.decodeConfig(text)) === text);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()));
    chk('config: a reordered (non-canonical) text is refused ROOM_ENCODING', await codeOf(() => M.decodeConfig(reordered)) === 'ROOM_ENCODING');
    chk('config: an unknown extra key is refused ROOM_ENCODING', await codeOf(() => M.decodeConfig(JSON.stringify(Object.assign(JSON.parse(text), { x: 1 })))) === 'ROOM_ENCODING');
    const bad = (o) => codeOf(() => cfgFor(GAMES.kirby, 2, o, M));
    chk('config: a wrong protocol version is ROOM_VERSION', await codeOf(() => M.validateConfig(Object.assign({}, kirby, { v: 2 }))) === 'ROOM_VERSION');
    chk('config: a ROM md5 other than the title\'s is ROOM_ROM', await bad({ romMd5: 'f'.repeat(32) }) === 'ROOM_ROM');
    chk('config: a malformed core md5 is ROOM_CORE', await bad({ coreBuildMd5: 'xyz' }) === 'ROOM_CORE');
    chk('config: a seat count the title never linked at is ROOM_SEATS', await codeOf(() => cfgFor(GAMES.sa3, 3, {}, M)) === 'ROOM_SEATS');
    chk('config: a fractional epoch is ROOM_CLOCK', await bad({ fixedEpochMs: 1.5 }) === 'ROOM_CLOCK');
    chk('config: a time zone beyond +-1440 min is ROOM_CLOCK', await bad({ tzOffsetMin: 2000 }) === 'ROOM_CLOCK');
    chk('config: a save type that is not the title\'s is ROOM_SAVETYPE', await bad({ saveTypes: ['flash1m', 'flash1m'] }) === 'ROOM_SAVETYPE');
    chk('config: an input delay of 0 is ROOM_DELAY', await bad({ inputDelay: 0 }) === 'ROOM_DELAY');
    chk('config: a non-roomable title (Pokemon SoulGold) is ROOM_NOT_ROOMABLE', await codeOf(() => M.validateConfig({ v: 1, game: 'Pokemon SoulGold' })) === 'ROOM_NOT_ROOMABLE');
    chk('config: a room id that is not 16 hex digits is ROOM_ID', await bad({ roomId: 'abc' }) === 'ROOM_ID');
    chk('config: a player label over 32 characters, or not a string, is ROOM_ENCODING', (await bad({ players: ['x'.repeat(33), ''] })) === 'ROOM_ENCODING' && (await bad({ players: [7, ''] })) === 'ROOM_ENCODING' && (await bad({ players: ['x'.repeat(32), ''] })) === null);
    chk('config: input delay 1 and 30 are accepted; 0, 31 and 3000 are ROOM_DELAY (DELAY_MAX is 30 frames, half a second)', (await bad({ inputDelay: 1 })) === null && (await bad({ inputDelay: 30 })) === null && (await bad({ inputDelay: 0 })) === 'ROOM_DELAY' && (await bad({ inputDelay: 31 })) === 'ROOM_DELAY' && (await bad({ inputDelay: 3000 })) === 'ROOM_DELAY');
    chk('config: the pinned epoch is accepted at +-9e15 ms and refused beyond it (ROOM_CLOCK)', (await bad({ fixedEpochMs: 9e15 })) === null && (await bad({ fixedEpochMs: 9e15 + 2 })) === 'ROOM_CLOCK' && (await bad({ fixedEpochMs: -9e15 - 2 })) === 'ROOM_CLOCK');
    chk('config: the pinned time zone is accepted at +-1440 min and refused beyond it (ROOM_CLOCK)', (await bad({ tzOffsetMin: 1440 })) === null && (await bad({ tzOffsetMin: -1440 })) === null && (await bad({ tzOffsetMin: 1441 })) === 'ROOM_CLOCK' && (await bad({ tzOffsetMin: -1441 })) === 'ROOM_CLOCK');
    // a game name is chosen by a peer: names that live on Object.prototype are an UNKNOWN title, never a crash and never a different error
    const protoNames = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'], pr = {};
    for (const g of protoNames) {
      pr[g] = { why: M.whyNotRoomable(g), seat: await codeOf(() => M.seatRules(g)), roster: await codeOf(() => M.checkRoster(g, ['a', 'b'])), spec: await codeOf(() => M.saveSpec(g)),
        validate: await codeOf(() => M.validateConfig(Object.assign({}, kirby, { game: g }))), make: await codeOf(() => M.makeConfig({ game: g, seats: 2, coreBuildMd5: CORE_MD5, fixedEpochMs: 1, roomId: ROOM_ID })) };
    }
    chk('config: game names that exist on Object.prototype (constructor, __proto__, toString, valueOf, hasOwnProperty) are an unknown title: whyNotRoomable says so, seatRules/checkRoster are ROOM_NOT_ROOMABLE, saveSpec/validateConfig/makeConfig are ROOM_GAME - never a TypeError, never ROOM_ROM',
      protoNames.every((g) => typeof pr[g].why === 'string' && /unknown title/.test(pr[g].why) && pr[g].seat === 'ROOM_NOT_ROOMABLE' && pr[g].roster === 'ROOM_NOT_ROOMABLE' && pr[g].spec === 'ROOM_GAME' && pr[g].validate === 'ROOM_GAME' && pr[g].make === 'ROOM_GAME'), JSON.stringify(pr.constructor));
    chk('config: the real titles still resolve (the own-property lookup did not hide them)', M.whyNotRoomable(GAMES.kirby) === null && M.seatRules(GAMES.kirby).max === 4 && M.saveSpec(GAMES.kirby).bytes === 0x8000);
  });
  await guard('disc', async () => {
    const sav = 'abcd1234';
    const d = (c, s = sav) => M.discString(c, s);
    const codes = (a, b) => M.compareDisc(a, b).map((x) => x.code);
    chk('disc: the same config and set give the identical string', d(kirby) === d(cfgFor(GAMES.kirby, 2, {}, M)));
    chk('disc: names the core (ROOM_CORE)', codes(d(kirby), d(cfgFor(GAMES.kirby, 2, { coreBuildMd5: '1'.repeat(32) }, M))).includes('ROOM_CORE'));
    chk('disc: names the seat count (ROOM_SEATS)', codes(d(kirby), d(kirby3)).includes('ROOM_SEATS'));
    chk('disc: names the clock epoch (ROOM_CLOCK)', codes(d(kirby), d(cfgFor(GAMES.kirby, 2, { fixedEpochMs: 1700000001000 }, M))).includes('ROOM_CLOCK'));
    chk('disc: names the clock zone (ROOM_CLOCK)', codes(d(kirby), d(cfgFor(GAMES.kirby, 2, { tzOffsetMin: 0 }, M))).includes('ROOM_CLOCK'));
    chk('disc: names the room id (ROOM_ID)', codes(d(kirby), d(cfgFor(GAMES.kirby, 2, { roomId: 'ffeeddccbbaa9988' }, M))).includes('ROOM_ID'));
    chk('disc: names the game (ROOM_GAME)', codes(d(kirby), d(sa3)).includes('ROOM_GAME'));
    chk('disc: names the ROM (ROOM_ROM)', codes(d(kirby), d(sa3)).includes('ROOM_ROM'));
    chk('disc: names the save type (ROOM_SAVETYPE)', codes(d(kirby), d(sa3)).includes('ROOM_SAVETYPE'));
    chk('disc: names the agreed save set (ROOM_SAVESET)', codes(d(kirby), d(kirby, 'deadbeef')).includes('ROOM_SAVESET'));
    chk('disc: names the protocol version (ROOM_VERSION) and stops there', JSON.stringify(codes(d(kirby), d(kirby).replace(/^gba1/, 'gba2'))) === '["ROOM_VERSION"]');
    chk('disc: the input delay is NOT folded (the host retunes it mid-room)', d(kirby) === d(cfgFor(GAMES.kirby, 2, { inputDelay: 9 }, M)));
    chk('disc: the player labels are NOT folded (a returning page is a new peer)', d(kirby) === d(cfgFor(GAMES.kirby, 2, { players: ['Ann', 'Bob'] }, M)));
    const m = M.compareDisc(d(kirby), d(cfgFor(GAMES.kirby, 2, { fixedEpochMs: 1700000001000 }, M)))[0];
    chk('disc: a refusal carries a human sentence and a machine code', !!m && m.code === 'ROOM_CLOCK' && /clock/.test(m.message) && m.field === 'clock');
    const ex = M.explainBarrierFailure(d(kirby), { A: d(kirby), B: d(sa3) });
    chk('disc: explainBarrierFailure lists only the peers that differ', ex.length === 1 && ex[0].peer === 'B');
    const loc = M.checkLocalAgainstConfig(kirby, { game: GAMES.kirby, romMd5: '0'.repeat(32), coreBuildMd5: CORE_MD5 });
    chk('disc: this machine\'s own ROM md5 is checked against the config before the barrier (ROOM_ROM)', loc.length === 1 && loc[0].code === 'ROOM_ROM');
    // a barrier failure always carries an explanation: a disc that differs in a field this page does not know, or only in how it is written, is NAMED
    const dK = d(kirby), parts = dK.split('|'), reorder = [parts[0], ...parts.slice(1).reverse()].join('|');
    const unk = M.compareDisc(dK, dK + '|new=1');
    chk('disc: a peer that sends a field this page does not know is NAMED (one ROOM_ENCODING entry, field disc, the field quoted) - never an empty explanation', unk.length === 1 && unk[0].code === 'ROOM_ENCODING' && unk[0].field === 'disc' && /"new"/.test(unk[0].message), JSON.stringify(unk.map((x) => x.code)));
    const reo = M.compareDisc(dK, reorder);
    chk('disc: the same fields in a different order are NAMED (ROOM_ENCODING, "different order")', reo.length === 1 && reo[0].code === 'ROOM_ENCODING' && /different order/.test(reo[0].message));
    const rep2 = M.compareDisc(dK, dK + '|rom=' + 'f'.repeat(32));
    chk('disc: a repeated field is NAMED as well as the value it overrides', rep2.some((x) => x.code === 'ROOM_ENCODING') && rep2.some((x) => x.code === 'ROOM_ROM'));
    const both = M.compareDisc(dK, d(cfgFor(GAMES.kirby, 2, { fixedEpochMs: 1700000001000 }, M)) + '|new=1').map((x) => x.code);
    chk('disc: a known field AND an unknown one differing together are both named (ROOM_CLOCK + ROOM_ENCODING)', both.includes('ROOM_CLOCK') && both.includes('ROOM_ENCODING'), both.join('+'));
    const ex2 = M.explainBarrierFailure(dK, { A: dK, B: dK + '|new=1' });
    chk('disc: explainBarrierFailure names a peer whose disc differs ONLY in an unknown field (it used to return [] and the refusal had no reason)', ex2.length === 1 && ex2[0].peer === 'B' && ex2[0].mismatches[0].code === 'ROOM_ENCODING');
    const perturbed = [dK + '|', dK + '||x', dK + ' ', dK.toUpperCase(), dK.replace('|room=', '|room ='), 'hello', parts.slice(0, 5).join('|'), dK + '|=x'];
    chk('disc: compareDisc is [] ONLY for identical strings - eight perturbations (trailing bar, empty part, space, upper case, truncated, garbage, nameless value) are each named', perturbed.every((p) => M.compareDisc(dK, p).length >= 1) && M.compareDisc(dK, dK).length === 0, perturbed.filter((p) => M.compareDisc(dK, p).length < 1).join(' ; '));
    chk('disc: parseDisc builds a prototype-less record (a peer chooses the keys: __proto__= and constructor= cannot reach Object.prototype)', (() => { const o = M.parseDisc(dK + '|__proto__=x|constructor=y'); return Object.getPrototypeOf(o) === null && o.constructor === 'y' && ({}).constructor === Object; })());
  });

  // ---- seats -----------------------------------------------------------------------------------------------------------------
  await guard('seats', async () => {
    const rc = (game, roster, o) => codeOf(() => M.checkRoster(game, roster, o));
    chk('seats: Kirby accepts 2, 3 and 4 players', (await rc(GAMES.kirby, ['a', 'b'])) === null && (await rc(GAMES.kirby, ['a', 'b', 'c'])) === null && (await rc(GAMES.kirby, ['a', 'b', 'c', 'd'])) === null);
    chk('seats: Super Bust-A-Move accepts exactly 2', (await rc(GAMES.sbam, ['a', 'b'])) === null && (await rc(GAMES.sbam, ['a', 'b', 'c'])) === 'SEATS_RANGE' && (await rc(GAMES.sbam, ['a'])) === 'SEATS_RANGE');
    chk('seats: a hole in the roster is SEATS_GAP', (await rc(GAMES.kirby, ['a', null, 'c', null])) === 'SEATS_GAP');
    chk('seats: one machine holding two seats is SEATS_MULTI', (await rc(GAMES.kirby, ['a', 'a'])) === 'SEATS_MULTI');
    chk('seats: the host must hold seat 1 (the link master)', (await rc(GAMES.kirby, ['b', 'a'], { hostPeer: 'a' })) === 'SEATS_HOST');
    chk('seats: a title with no passing row is not roomable (Monster Rancher: could-not-reach)', (await rc('Monster Rancher Advance 2', ['a', 'b'])) === 'ROOM_NOT_ROOMABLE');
    chk('seats: seatRules reports host seat 0 as the SIO master', M.seatRules(GAMES.kirby).hostSeat === 0 && M.seatRules(GAMES.kirby).masterSeat === 0);
  });

  // ---- save entries ----------------------------------------------------------------------------------------------------------
  await guard('saves', async () => {
    const img = patternImage(0x8000, 7);                                          // incompressible -> raw codec, 3 payload chunks
    const entry = await M.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw: img });
    chk('saves: entry = { port, size, hash, enc, bytes } with size/hash over the RAW image', entry.port === 1 && entry.size === 0x8000 && entry.hash === M.cardHash(img) && entry.enc === 'gba1;raw');
    const v = await M.verifySaveEntry({ config: kirby, port: 1, entry });
    chk('saves: an untouched entry verifies and returns the identical image', Buffer.compare(Buffer.from(v.raw), Buffer.from(img)) === 0 && v.hash === entry.hash);
    const blank = await M.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: M.blankSave(GAMES.kirby) });
    chk('saves: a blank 0xFF battery compresses (gzip) and still verifies', blank.enc === 'gba1;gzip' && blank.bytes.length < 2000 && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 0, entry: blank }))) === null);
    const tam = (e, f) => { const b = e.bytes.slice(); f(b); return Object.assign({}, e, { bytes: b }); };
    const payloadAt = (e) => 28 + (e.bytes[26] | (e.bytes[27] << 8)) + 4 * (e.bytes[24] | (e.bytes[25] << 8));
    const t1 = await expectErr(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[payloadAt(entry) + 12288 + 100] ^= 0x01; }) }));
    chk('saves: a flipped bit in payload chunk 2 is SAVE_TAMPERED_CHUNK naming the seat and chunk', t1.code === 'SAVE_TAMPERED_CHUNK' && t1.detail && t1.detail.chunk === 1 && t1.detail.seat === 1 && /chunk 2 of 3/.test(t1.message || ''));
    chk('saves: a flipped bit in the LAST chunk is caught too', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[b.length - 1] ^= 0x80; }) }))) === 'SAVE_TAMPERED_CHUNK');
    chk('saves: wrong size - a 16 KiB image cannot be made for a 32 KiB battery (SAVE_BAD_SIZE)', (await codeOf(() => M.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: new Uint8Array(0x4000) }))) === 'SAVE_BAD_SIZE');
    chk('saves: wrong size - a fully self-consistent 16 KiB image in a 32 KiB sram seat is SAVE_BAD_SIZE', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: forgeEntry({ seat: 1, typeCode: 1, raw: patternImage(0x4000, 5) }) }))) === 'SAVE_BAD_SIZE');
    chk('saves: the forge helper itself is sound - the same hand-built envelope with the RIGHT size verifies', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: forgeEntry({ seat: 1, typeCode: 1, raw: patternImage(0x8000, 5) }) }))) === null);
    chk('saves: wrong size - the entry and the envelope disagree (SAVE_BAD_SIZE)', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: Object.assign({}, entry, { size: 0x7fff }) }))) === 'SAVE_BAD_SIZE');
    chk('saves: over the 128 KiB flash cap is SAVE_TOO_BIG', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[8] = 0; b[9] = 0; b[10] = 0x04; }) }))) === 'SAVE_TOO_BIG');
    chk('saves: wrong save type - the envelope says flash1m in a Kirby (sram) room (SAVE_WRONG_TYPE)', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[5] = 3; }) }))) === 'SAVE_WRONG_TYPE');
    chk('saves: a seat claim that is not the port it arrived on is SAVE_SEAT_CLAIM', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[4] = 0; }) }))) === 'SAVE_SEAT_CLAIM');
    chk('saves: a wrong envelope magic is SAVE_ENVELOPE', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[0] = 0; }) }))) === 'SAVE_ENVELOPE');
    chk('saves: an envelope from ANOTHER protocol version (magic "GBS2" / "GBS0") is ROOM_VERSION by name, with both versions in the sentence; a non-digit "GBSx" and a foreign magic stay SAVE_ENVELOPE; the current version still verifies', await (async () => {
      const code = (f) => codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, f) }));
      const v2 = await code((b) => { b[3] = 0x32; }), v0 = await code((b) => { b[3] = 0x30; }), vx = await code((b) => { b[3] = 0x78; }), foreign = await code((b) => { b[0] = 0x58; b[3] = 0x32; }), ok1 = await code(() => {});
      let text = ''; try { await M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[3] = 0x32; }) }); } catch (e) { text = e.message + ' ' + JSON.stringify(e.detail); }
      return v2 === 'ROOM_VERSION' && v0 === 'ROOM_VERSION' && vx === 'SAVE_ENVELOPE' && foreign === 'SAVE_ENVELOPE' && ok1 === null && /protocol 2/.test(text) && /speaks 1/.test(text);
    })());
    chk('saves: a truncated envelope is SAVE_ENVELOPE', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: Object.assign({}, entry, { bytes: entry.bytes.slice(0, entry.bytes.length - 5) }) }))) === 'SAVE_ENVELOPE');
    chk('saves: an image whose whole-image hash differs is SAVE_BAD_HASH', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: Object.assign({}, entry, { hash: 'deadbeef' }) }))) === 'SAVE_BAD_HASH');
    // a decompression bomb: valid chunk hashes, gzip that inflates to 20 MB, declared 32 KiB
    const bomb = { available: () => true, deflate: async () => bombGzip(), inflate: M.webCodec.inflate };
    const be = await M.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw: img, codec: bomb });
    chk('saves: a gzip bomb (20 MiB declared as 32 KiB, every chunk hash valid) is refused SAVE_BAD_SIZE', be.enc === 'gba1;gzip' && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: be }))) === 'SAVE_BAD_SIZE');
    const counted = await withCountingInflate(() => codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: be })));
    chk('saves: ...and it is refused WITHOUT being inflated: the decompressor handed over under 1 MiB of the 20 MiB (inflate stops reading at the declared size and cancels)', counted.r === 'SAVE_BAD_SIZE' && counted.produced < (1 << 20), 'decompressor produced ' + counted.produced + ' bytes');
    const full = await withCountingInflate(async () => { const r = await M.webCodec.inflate(bombGzip(), 1 << 30); return r.length; });
    chk('saves: the counter itself is sound - with the cap out of the way the same stream yields all 20 MiB (the < 1 MiB above is not an artifact of the wrapper)', full.r === 20 * 1024 * 1024 && full.produced === 20 * 1024 * 1024, 'produced ' + full.produced);
    // contributions
    // ---- each size / shape check, held against an envelope that passes every OTHER check, so the check under test is the one that refuses it
    // a few hundred bytes of gzip that DECLARE 64 KiB for a 32 KiB SRAM seat: small enough to pass the entry-size bound, so only the chip's own cap can refuse it
    chk('saves: a gzip save that declares 64 KiB for a 32 KiB SRAM seat is SAVE_TOO_BIG by the chip\'s own cap (the 128 KiB flash cap alone would let it through to SAVE_BAD_SIZE)', blank.enc === 'gba1;gzip' && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 0, entry: tam(blank, (b) => { b[8] = 0; b[9] = 0; b[10] = 1; b[11] = 0; }) }))) === 'SAVE_TOO_BIG');
    chk('saves: an entry whose enc label disagrees with its envelope is SAVE_ENC', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: Object.assign({}, entry, { enc: 'gba1;gzip' }) }))) === 'SAVE_ENC');
    chk('saves: a flipped bit in the envelope\'s whole-image hash is SAVE_BAD_HASH (the entry\'s own hash is not the only one checked)', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[20] ^= 1; }) }))) === 'SAVE_BAD_HASH');
    const lie = { available: () => true, deflate: async () => smallGzip(), inflate: M.webCodec.inflate };
    const le = await M.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw: img, codec: lie });
    chk('saves: gzip that inflates to 100 bytes under a 32 KiB declaration is SAVE_BAD_SIZE (named by size, not left to SAVE_BAD_HASH)', le.enc === 'gba1;gzip' && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: le }))) === 'SAVE_BAD_SIZE');
    chk('saves: a chunk size other than the 12 KiB wire piece is SAVE_ENVELOPE', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: tam(entry, (b) => { b[16] = 0; b[17] = 0x20; b[18] = 0; b[19] = 0; }) }))) === 'SAVE_ENVELOPE');
    chk('saves: a payload length over the cap is SAVE_TOO_BIG at the envelope header, before the chunk accounting', (await codeOf(() => M.parseSaveEnvelope(tam(entry, (b) => { b[12] = 0; b[13] = 0; b[14] = 4; b[15] = 0; }).bytes))) === 'SAVE_TOO_BIG');
    chk('saves: an envelope that lists one chunk more than its payload holds is SAVE_ENVELOPE (and the same envelope with the right count verifies)', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: forgeExtraChunk({ seat: 1, typeCode: 1, raw: patternImage(0x8000, 5) }) }))) === 'SAVE_ENVELOPE' && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: forgeEntry({ seat: 1, typeCode: 1, raw: patternImage(0x8000, 5) }) }))) === null);
    const huge = Object.assign({}, entry, { bytes: new Uint8Array(1 << 20) });
    chk('saves: an entry far larger than any honest save is SAVE_TOO_BIG before it is parsed or hashed', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 1, entry: huge }))) === 'SAVE_TOO_BIG');
    const hostE = await M.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: M.blankSave(GAMES.kirby), config: kirby });
    chk('saves: verifySaveSet applies the same bound to every seat\'s entry (SAVE_TOO_BIG)', (await codeOf(() => M.verifySaveSet({ config: kirby, set: { 0: hostE, 1: huge } }))) === 'SAVE_TOO_BIG');
    chk('saves: ROOM_CARD_LIMITS is the largest honest envelope (header + config + piece hashes + a flash image) - the numbers a transport-level guard needs', M.ROOM_CARD_LIMITS.maxCardBytes === 28 + 4096 + 4 * 11 + 131072 && M.ROOM_CARD_LIMITS.maxPieces === Math.ceil(M.ROOM_CARD_LIMITS.maxCardBytes / 12288) && M.ROOM_CARD_LIMITS.maxCards === 4, JSON.stringify(M.ROOM_CARD_LIMITS));
    chk('saves: verifySaveEntry refuses a port outside the room (SAVE_SEAT_RANGE), not a TypeError', (await codeOf(() => M.verifySaveEntry({ config: kirby, port: 2, entry }))) === 'SAVE_SEAT_RANGE' && (await codeOf(() => M.verifySaveEntry({ config: kirby, port: -1, entry }))) === 'SAVE_SEAT_RANGE');
    chk('saves: no stored save -> a blank 0xFF chip of the title\'s size', (() => { const c = M.chooseContribution(GAMES.kirby, null); return c.source === 'blank' && c.raw.length === 0x8000 && c.raw.every((x) => x === 0xFF); })());
    chk('saves: no stored save on a title with no battery -> an EMPTY image (Super Bust-A-Move)', (() => { const c = M.chooseContribution(GAMES.sbam, null); return c.source === 'none' && c.raw.length === 0; })());
    chk('saves: a stored save of the right size is used as is', M.chooseContribution(GAMES.kirby, img).source === 'stored');
    chk('saves: a stored save of the WRONG size is rejected (blank contributed, warning given)', (() => { const c = M.chooseContribution(GAMES.kirby, new Uint8Array(1000)); return c.source === 'rejected-stored' && /1000 bytes/.test(c.warn) && c.raw.length === 0x8000; })());
    const e0 = await M.makeSaveEntry({ game: GAMES.sbam, seat: 0, raw: new Uint8Array(0), config: cfgFor(GAMES.sbam, 2, {}, M) });
    chk('saves: an empty (no-battery) entry round-trips and carries the host config', (await codeOf(() => M.verifySaveEntry({ config: cfgFor(GAMES.sbam, 2, {}, M), port: 0, entry: e0 }))) === null && M.readRoomConfig({ 0: e0 }).roomId === ROOM_ID);
  });
  await guard('set', async () => {
    const mk = async (seat, cfg) => M.makeSaveEntry({ game: GAMES.kirby, seat, raw: patternImage(0x8000, seat + 1), config: cfg });
    const e0 = await mk(0, kirby), e1 = await mk(1);
    const set = { 0: e0, 1: e1 };
    const good = await M.verifySaveSet({ config: kirby, set });
    chk('set: a complete, honest set verifies; setHash = the engine formula', good.images.length === 2 && good.setHash === M.cardSetHash(set) && good.hashes[1] === e1.hash);
    chk('set: the engine\'s own fingerprint must equal the recomputed one (ROOM_SAVESET)', (await codeOf(() => M.verifySaveSet({ config: kirby, set, engineSetHash: '00000000' }))) === 'ROOM_SAVESET');
    chk('set: a missing seat is SAVE_MISSING_SEAT', (await codeOf(() => M.verifySaveSet({ config: kirby, set: { 0: e0 } }))) === 'SAVE_MISSING_SEAT');
    chk('set: a seat beyond the room is SAVE_SEAT_RANGE', (await codeOf(() => M.verifySaveSet({ config: kirby, set: { 0: e0, 1: e1, 2: e1 } }))) === 'SAVE_SEAT_RANGE');
    const dup = Object.assign({}, e1, { port: 1, bytes: e0.bytes.slice() });
    chk('set: two ports claiming the same seat is SAVE_DUPLICATE_SEAT', (await codeOf(() => M.verifySaveSet({ config: kirby, set: { 0: e0, 1: dup } }))) === 'SAVE_DUPLICATE_SEAT');
    const e2 = await mk(2);
    chk('set: ports holding each others seat envelopes is SAVE_SEAT_CLAIM', (await codeOf(() => M.verifySaveSet({ config: kirby3, set: { 0: e0, 1: e2, 2: e1 } }))) === 'SAVE_SEAT_CLAIM');
    chk('set: the host config is read out of seat 0\'s envelope', M.readRoomConfig(set).roomId === ROOM_ID && M.readRoomConfig(set).seats === 2);
    chk('set: a host that sent no config is SAVE_CFG_MISSING', (await codeOf(() => M.readRoomConfig({ 0: e1 }))) === 'SAVE_CFG_MISSING');
  });
  await guard('catalogue', async () => {
    chk('catalogue: ROOMABLE = exactly the titles with a passing row', JSON.stringify(Object.keys(M.ROOMABLE)) === JSON.stringify([GAMES.sbam, GAMES.kirby, GAMES.sa3]));
    chk('catalogue: Kirby 2/3/4, Super Bust-A-Move 2, Sonic Advance 3 2', M.ROOMABLE[GAMES.kirby].counts.join() === '2,3,4' && M.ROOMABLE[GAMES.sbam].counts.join() === '2' && M.ROOMABLE[GAMES.sa3].counts.join() === '2');
    chk('catalogue: SoulGold, Ultra Violet, Sim City 2000, Monster Rancher are NOT roomable, each with a reason', ['Pokemon SoulGold', 'PKMN Ultra Violet', 'Sim City 2000', 'Monster Rancher Advance 2'].every((g) => !M.ROOMABLE[g] && /./.test(M.whyNotRoomable(g))));
    chk('catalogue: deriveRoomable puts a title in only when a row is LINKED', (() => { const rows = M.LINK_ROWS.map((r) => (r.id === 'mra2-2p' ? Object.assign({}, r, { outcome: 'linked' }) : r)); return !!M.deriveRoomable(M.LINK_ROWS, M.TITLES)[GAMES.sa3] && !M.deriveRoomable(M.LINK_ROWS, M.TITLES)['Monster Rancher Advance 2'] && !!M.deriveRoomable(rows, M.TITLES)['Monster Rancher Advance 2']; })());
  });

  // ---- words + commit plan ---------------------------------------------------------------------------------------------------
  await guard('words', async () => {
    chk('words: keys survive an encode/decode round trip and nothing else is set', (() => { for (const k of [0, 1, 0x3FF, 0x155, 0x2AA]) { const d = M.decodeWord(M.encodeWord(k, null)); if (d.keys !== k || d.kind !== 0 || d.bad) return false; } return true; })());
    chk('words: keys above the ten GBA bits are masked, never smuggled into the control field', M.decodeWord(M.encodeWord(0xFFFF, null)).keys === 0x3FF && M.decodeWord(M.encodeWord(0xFFFF, null)).kind === 0);
    chk('words: a DIGEST symbol round-trips (kind, position, 16-bit payload)', (() => { const d = M.decodeWord(M.encodeWord(5, { kind: 2, pos: 3, payload: 0xBEEF })); return d.kind === 2 && d.pos === 3 && d.payload === 0xBEEF && d.keys === 5 && !d.bad; })());
    chk('words: kind 3 and set reserved bits read as bad IDLE (ignored the same way on every machine)', M.decodeWord(0xC0000000).bad === true && M.decodeWord(0xC0000000).kind === 0 && M.decodeWord(0x10000000).bad === true);
    chk('words: stray payload bits on an IDLE or WANT word, or a position on a WANT word, read as bad IDLE (the same on every machine)', M.decodeWord(1 << 10).bad === true && M.decodeWord((1 << 30) | (1 << 10)).bad === true && M.decodeWord((1 << 30) | (1 << 26)).bad === true && M.decodeWord(1 << 30).bad === false && M.decodeWord(0).bad === false);
    chk('words: the wire form is 4 little-endian bytes', (() => { const b = M.wordToBytes(0x80030005); return b.length === 4 && b[0] === 5 && b[1] === 0 && b[2] === 3 && b[3] === 0x80 && M.bytesToWord(b, 0) === 0x80030005; })());
  });

  // ---- persistence: local seat only; only on a clean end ---------------------------------------------------------------------
  await guard('persist', async () => {
    const images = [patternImage(0x8000, 1), patternImage(0x8000, 2), patternImage(0x8000, 3)];
    // seats 0 and 1 trade (their first 8 bytes swap); seat 2 never touches its save
    const sim = simulate(M, { seats: 3, D: 2, images, wantFrom: [100, 110, 120], trade: true });
    chk('persist: a clean 3-seat end commits on every machine', sim.machines.every((m) => m.end.phase === 'commit'));
    const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
    for (let s = 0; s < 2; s++) {
      const m = sim.machines[s], plan = m.commitPlan({ key: 'sav', previous: images[s] });
      chk(`persist: seat ${s} writes ONLY its own seat's image (never a peer's)`, plan.writes.length === 1 && plan.writes[0].key === 'sav' && same(plan.writes[0].bytes, m.core.exportSave(s)) && !same(plan.writes[0].bytes, m.core.exportSave(1 - s)));
    }
    chk('persist: the seat that never changed its save is not rewritten (skip: unchanged)', sim.machines[2].commitPlan({ key: 'sav', previous: images[2] }).skip === 'unchanged');
    const unclean = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], trade: true, corrupt: { machine: 1, seat: 1, byte: 3 }, T: 600 });
    chk('persist: an unclean end (digests mismatch) writes NOTHING - commitPlan refuses (COMMIT_NOT_CLEAN)', unclean.machines.every((m) => m.end.phase === 'unclean' && m.captured) && (await codeOf(() => unclean.machines[0].commitPlan({ key: 'sav', previous: images[0] }))) === 'COMMIT_NOT_CLEAN');
    chk('persist: planCommit on a non-commit state is COMMIT_NOT_CLEAN', (await codeOf(() => M.planCommit({ endState: { phase: 'digest', n: 2 }, localSeat: 0, finalImage: images[0], initialImage: images[1], key: 'k' }))) === 'COMMIT_NOT_CLEAN');
    const cm = { phase: 'commit', n: 2 };
    chk('persist: planCommit refuses a local seat outside the room (SAVE_SEAT_RANGE), so a bad index can never pick a peer\'s image', (await codeOf(() => M.planCommit({ endState: cm, localSeat: 2, finalImage: images[0], initialImage: images[1], key: 'k' }))) === 'SAVE_SEAT_RANGE' && (await codeOf(() => M.planCommit({ endState: cm, localSeat: -1, finalImage: images[0], initialImage: images[1], key: 'k' }))) === 'SAVE_SEAT_RANGE');
    chk('persist: an unchanged image is not rewritten (skip: unchanged)', M.planCommit({ endState: cm, localSeat: 0, finalImage: images[0], initialImage: images[0].slice(), key: 'k' }).skip === 'unchanged');
    chk('persist: a stored save the room could not use is never overwritten (skip: stored-invalid)', M.planCommit({ endState: cm, localSeat: 0, finalImage: images[0], initialImage: images[1], key: 'k', source: 'rejected-stored' }).skip === 'stored-invalid');
    chk('persist: the previous image is kept under <key>.pre-room before it is replaced', (() => { const p = M.planCommit({ endState: cm, localSeat: 0, finalImage: images[0], initialImage: images[1], key: 'k', previous: images[1] }); return p.backups.length === 1 && p.backups[0].key === 'k.pre-room' && Buffer.compare(Buffer.from(p.backups[0].bytes), Buffer.from(images[1])) === 0; })());
    chk('persist: a title with no battery writes nothing (skip: no-battery)', M.planCommit({ endState: cm, localSeat: 0, finalImage: new Uint8Array(0), initialImage: new Uint8Array(0), key: 'k' }).skip === 'no-battery');
  });

  // ---- the end handshake -----------------------------------------------------------------------------------------------------
  await guard('end', async () => {
    const images = [patternImage(0x8000, 1), patternImage(0x8000, 2), patternImage(0x8000, 3), patternImage(0x8000, 4)];
    for (const n of [2, 3, 4]) {
      const s = simulate(M, { seats: n, D: 2, images: images.slice(0, n), wantFrom: Array.from({ length: n }, (_, i) => 100 + 7 * i), trade: n >= 2 });
      const F = s.machines.map((m) => m.end.F), G = s.machines.map((m) => m.end.G);
      chk(`end: ${n} seats, staggered votes - every machine commits at the SAME agreed frame (F=${F[0]}) and decision frame (G=${G[0]})`, s.machines.every((m) => m.end.phase === 'commit') && new Set(F).size === 1 && new Set(G).size === 1 && F[0] >= 100 + 7 * (n - 1) + 30);
      chk(`end: ${n} seats - each store changed only at its own key, holds exactly ITS OWN seat's final image, and only after the commit (seats that traded wrote once, the others not at all)`, s.stores.every((st, i) => st.log.every((w) => w.key === 'sav' && w.seat === i) && st.log.length === (i < 2 ? 1 : 0) && Buffer.compare(Buffer.from(st.get('sav')), Buffer.from(s.machines[i].core.exportSave(i))) === 0));
    }
    const t = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], trade: true });
    chk('end: a completed trade is in the committed images (seat 0 holds seat 1\'s old first 8 bytes and vice versa)', Buffer.compare(Buffer.from(t.stores[0].get('sav').subarray(0, 8)), Buffer.from(images[1].subarray(0, 8))) === 0 && Buffer.compare(Buffer.from(t.stores[1].get('sav').subarray(0, 8)), Buffer.from(images[0].subarray(0, 8))) === 0);
    // kill between OFFER and CONFIRM: seat 0 offers (frame 40), seat 1 would confirm at 60 but its machine dies at sample frame 55
    const k = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], trade: true, kill: { seat: 1, at: 55 }, T: 1500 });
    chk('end: KILL a peer between the trade offer and its confirmation -> the trade never completes, nobody commits', k.machines[0].end.phase !== 'commit' && k.machines[0].core.offer === 0);
    chk('end: ...and NEITHER save changed (survivor\'s store untouched, dead peer\'s store untouched)', k.stores.every((st) => st.log.length === 0) && Buffer.compare(Buffer.from(k.stores[0].get('sav')), Buffer.from(images[0])) === 0 && Buffer.compare(Buffer.from(k.stores[1].get('sav')), Buffer.from(images[1])) === 0);
    chk('end: ...and the survivor\'s in-memory seat is still offerable as a manual export (never auto-persisted)', k.machines[0].core.exportSave(0).length === 0x8000);
    // a vote needs EVERY seat: one seat that never votes
    const lone = simulate(M, { seats: 3, D: 2, images: images.slice(0, 3), wantFrom: [100, 100, Infinity], T: 800 });
    chk('end: two of three voting never ends the room', lone.machines.every((m) => m.end.phase === 'run' && m.end.F === null));
    // a flickering vote resets the count
    const fl = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], flicker: { seat: 1, from: 120, to: 123 } });
    chk('end: a vote withdrawn before everyone held it for 30 frames resets - the room ends LATER, not earlier', fl.machines.every((m) => m.end.phase === 'commit') && fl.machines[0].end.F >= 123 + 30 - 3);
    // one machine's saves differ (a desync the fingerprint has not caught yet): everyone refuses, by name
    const mm = simulate(M, { seats: 3, D: 2, images: images.slice(0, 3), wantFrom: [100, 100, 100], corrupt: { machine: 1, seat: 2, byte: 100 }, T: 600 });
    chk('end: one machine whose saves differ -> END_MISMATCH on EVERY machine, nobody commits', mm.machines.every((m) => m.end.phase === 'unclean' && m.end.why.code === 'END_MISMATCH') && mm.stores.every((st) => st.log.length === 0));
    chk('end: ...and the refusal names the seats that differ', mm.machines[0].end.why.detail.seats.length > 0 && /differ/.test(mm.machines[0].end.why.message));
    // a seat that votes but never sends its digest
    const mute = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], muteDigest: 1, T: 1500 });
    chk('end: a seat that never completes its digest -> END_TIMEOUT on every machine at the same frame, nobody commits', mute.machines.every((m) => m.end.phase === 'unclean' && m.end.why.code === 'END_TIMEOUT') && new Set(mute.machines.map((m) => m.end.F)).size === 1 && mute.stores.every((st) => st.log.length === 0));
    // a seat contradicting itself
    const cf = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], conflict: 1, T: 800 });
    chk('end: a seat sending two different values for one digest position -> END_CONFLICT, nobody commits', cf.machines.every((m) => m.end.phase === 'unclean' && m.end.why.code === 'END_CONFLICT') && cf.stores.every((st) => st.log.length === 0));
    // robustness: a skipped / duplicated sample (the engine fills frames it skipped with the last pad)
    const dup = simulate(M, { seats: 3, D: 2, images: images.slice(0, 3), wantFrom: [100, 100, 100], dupDigest: true });
    chk('end: skipped/duplicated pad samples while the digest is in flight do not break it (positions are self-describing and cycle)', dup.machines.every((m) => m.end.phase === 'commit'));
    // the journal record is demanded on EVERY sample that carries position 3 (the engine may skip the first one)
    {
      let st = M.endInit({ seats: 2, hold: 3 });
      for (let f = 0; f < 6; f++) { const r = M.endStep(st, f, [M.decodeWord(M.encodeWord(0, { kind: M.KIND.WANT })), M.decodeWord(M.encodeWord(0, { kind: M.KIND.WANT }))]); st = r.state; }
      st = M.endCapture(st, { roomId: ROOM_ID, frame: st.F, imageHashes: ['aaaaaaaa', 'bbbbbbbb'] });
      let right = st.phase === 'digest' && !!st.capture;
      for (let fs = st.F + 1; fs <= st.F + 24; fs++) {
        const k = (fs - st.F - 1) % 4, r = M.endLocalCtl(st, fs, false);
        if (!r.sym || r.sym.kind !== M.KIND.DIGEST || r.sym.pos !== k || (k === 3) !== !!r.journal || (r.journal && r.journal.state !== 'last-symbol')) right = false;
      }
      chk('end: the last-symbol journal is demanded on EVERY sample carrying position 3 (a skipped first cycle must not escape it) and on no other', right);
    }
    // ---- the digest binds what it must, and every one of its four positions is compared
    {
      const hs = ['aaaaaaaa', 'bbbbbbbb'], d0 = JSON.stringify(M.endDigest(ROOM_ID, 100, hs));
      chk('end: the digest binds the agreed frame, the room id, every seat\'s image hash and their order', d0 !== JSON.stringify(M.endDigest(ROOM_ID, 101, hs)) && d0 !== JSON.stringify(M.endDigest('ffeeddccbbaa9988', 100, hs)) && d0 !== JSON.stringify(M.endDigest(ROOM_ID, 100, ['aaaaaaab', 'bbbbbbbb'])) && d0 !== JSON.stringify(M.endDigest(ROOM_ID, 100, ['bbbbbbbb', 'aaaaaaaa'])) && d0 === JSON.stringify(M.endDigest(ROOM_ID, 100, hs.slice())));
      chk('end: the digest is 4 values of 16 bits (DIGEST_POSITIONS)', M.endDigest(ROOM_ID, 100, hs).length === 4 && M.endDigest(ROOM_ID, 100, hs).every((x) => Number.isInteger(x) && x >= 0 && x <= 0xFFFF));
      const want = M.decodeWord(M.encodeWord(0, { kind: M.KIND.WANT }));
      const runDigest = (bad) => {
        let st = M.endInit({ seats: 2, hold: 1 });
        st = M.endStep(st, 0, [want, want]).state;
        st = M.endCapture(st, { roomId: ROOM_ID, frame: 0, imageHashes: hs });
        for (let k = 0; k < 4 && st.phase === 'digest'; k++) {
          const sy = (seat) => M.decodeWord(M.encodeWord(0, { kind: M.KIND.DIGEST, pos: k, payload: (st.capture.digest[k] ^ (seat === 1 && k === bad ? 1 : 0)) & 0xFFFF }));
          st = M.endStep(st, 1 + k, [sy(0), sy(1)]).state;
        }
        return st.phase + ':' + (st.why ? st.why.code : '');
      };
      chk('end: a digest that is right in all four positions commits (the quiet twin of the next check)', runDigest(-1) === 'commit:');
      chk('end: ONE wrong position - any of the four - from one seat is END_MISMATCH (a comparison of position 0 alone would let three of them through)', [0, 1, 2, 3].every((k) => runDigest(k) === 'unclean:END_MISMATCH'), [0, 1, 2, 3].map(runDigest).join(' '));
      let st = M.endInit({ seats: 2, hold: 3 });
      const junk = M.decodeWord((1 << 30) | 0x10000000);       // kind WANT with a reserved bit set: malformed
      for (let fr = 0; fr < 10; fr++) st = M.endStep(st, fr, [want, junk]).state;
      chk('end: a malformed word never counts as a WANT-END vote (the room does not end on garbage; the garbage is counted)', junk.bad === true && st.phase === 'run' && st.streak[1] === 0 && st.bad === 10);
      const s5 = M.endStep(M.endInit({ seats: 2, hold: 1 }), 5, [want, want]).state;
      const wrongF = M.endCapture(s5, { roomId: ROOM_ID, frame: 6, imageHashes: hs }), rightF = M.endCapture(s5, { roomId: ROOM_ID, frame: 5, imageHashes: hs });
      chk('end: endCapture takes only the AGREED frame (a capture of any other frame is ignored)', wrongF.capture === null && !!rightF.capture && rightF.capture.frame === 5);
    }
    // ---- the journal: room.js makes every record itself, and no record ever holds a PEER's image
    const js = simulate(M, { seats: 2, D: 2, images: images.slice(0, 2), wantFrom: [100, 100], trade: true });
    const jinfo = [0, 1].map((sx) => {
      const m = js.machines[sx], recs = js.journals[sx], mine = m.core.exportSave(sx), peer = m.core.exportSave(1 - sx), by = (st) => recs.filter((r) => r.state === st);
      const localOnly = (r) => r.seat === sx && r.room === ROOM_ID && r.image instanceof Uint8Array && same8(r.image, mine) && !same8(r.image, peer) && r.imageHash === M.cardHash(mine);
      const collapsed = recs.map((r) => r.state).filter((x, i, a) => i === 0 || a[i - 1] !== x).join('>');
      return { sx, staged: by('staged'), last: by('last-symbol'), before: by('committing'), after: by('committed'), localOnly, collapsed, mine, m };
    });
    chk('end: room.js ITSELF makes the \'staged\' record - once per machine, on the capture frame, naming room, seat and the local seat\'s hash, carrying no image', jinfo.every((j) => j.staged.length === 1 && j.staged[0].F === j.m.captured.frame && j.staged[0].seat === j.sx && j.staged[0].room === ROOM_ID && j.staged[0].imageHash === M.cardHash(j.mine) && !('image' in j.staged[0])), jinfo.map((j) => j.staged.length).join());
    chk('end: every \'last-symbol\' record carries the LOCAL seat\'s final image and its hash - never a peer\'s', jinfo.every((j) => j.last.length >= 1 && j.last.every(j.localOnly)), jinfo.map((j) => j.last.length + ' records').join());
    chk('end: the \'committing\' record carries the local seat\'s image, the storage key and the hash of the value it replaces', jinfo.every((j) => j.before.length === 1 && j.localOnly(j.before[0]) && j.before[0].key === 'sav' && j.before[0].previousHash === M.cardHash(images[j.sx]) && j.before[0].skip === null));
    chk('end: the journal is written in the order staged > last-symbol > committing > committed', jinfo.every((j) => j.collapsed === 'staged>last-symbol>committing>committed' && j.after.length === 1 && j.after[0].seat === j.sx), jinfo.map((j) => j.collapsed).join(' | '));
    chk('end: a commit is journal(committing), put(<key>.pre-room), put(<key>), journal(committed) - in that order, and touches no other key', jinfo.every((j) => { const st = js.plans[j.sx].steps; return st.length === 4 && st[0].op === 'journal' && st[0].record.state === 'committing' && st[1].op === 'put' && st[1].key === 'sav.pre-room' && st[2].op === 'put' && st[2].key === 'sav' && st[3].op === 'journal' && st[3].record.state === 'committed'; }));
    // ---- recovery: recoverPlan decides, runSteps executes; checked on the records this module just made
    {
      const j0 = jinfo[0], rec = j0.before[0], fin = j0.mine, old = images[0], lastRec = j0.last[j0.last.length - 1], stg = j0.staged[0];
      const exec = (plan, stored) => { const st = new Map(); if (stored) st.set('sav', stored.slice()); const jr = []; M.runSteps(plan.steps, { journal: (r) => jr.push(r), put: (k, b) => st.set(k, b.slice()) }); return { st, jr }; };
      const rp = (record, stored, choice) => M.recoverPlan({ record, key: 'sav', stored, choice });
      const a1 = rp(rec, old), x1 = exec(a1, old);
      chk('recover: a \'committing\' record over the OLD value is finished: the old value is backed up under <key>.pre-room, the final image is written, the record closes \'committed\'', a1.action === 'finish-commit' && a1.outcome === 'completed' && same8(x1.st.get('sav.pre-room'), old) && same8(x1.st.get('sav'), fin) && x1.jr.length === 1 && x1.jr[0].state === 'committed');
      const a2 = rp(rec, fin), x2 = exec(a2, fin);
      chk('recover: ...over the FINAL value (it died after the write) it writes nothing - above all it does not copy the new value over the backup', a2.outcome === 'already-written' && !x2.st.has('sav.pre-room') && same8(x2.st.get('sav'), fin) && x2.jr[0].state === 'committed' && a2.steps.filter((x) => x.op === 'put').length === 0);
      const foreign = patternImage(0x8000, 77), a3 = rp(rec, foreign), x3 = exec(a3, foreign);
      chk('recover: ...over a value that is NEITHER (somebody else wrote it since) it writes nothing and closes the record \'aborted\' - the room never overwrites a save it did not replace', a3.outcome === 'stored-changed' && a3.steps.every((x) => x.op === 'journal') && same8(x3.st.get('sav'), foreign) && x3.jr[0].state === 'aborted');
      const tamperedImg = Object.assign({}, rec, { image: (() => { const b = rec.image.slice(); b[5] ^= 1; return b; })() });
      chk('recover: a record whose image does not match its own hash is journal-invalid: NOTHING is written', rp(tamperedImg, old).action === 'journal-invalid' && rp(tamperedImg, old).steps.length === 0);
      chk('recover: a record written for another storage key is journal-invalid', M.recoverPlan({ record: rec, key: 'other', stored: old }).action === 'journal-invalid');
      const idb = rp(lastRec, old);
      chk('recover: a \'last-symbol\' record over the OLD value is IN DOUBT: nothing is written until the player answers (needsChoice)', idb.action === 'in-doubt' && idb.needsChoice === true && idb.steps.length === 0 && idb.wouldDo === 'completed');
      const ap = rp(lastRec, old, 'apply'), xa = exec(ap, old);
      chk('recover: ...\'apply\' finishes the commit exactly like a committing record (backup, final image, committed)', ap.outcome === 'completed' && same8(xa.st.get('sav'), fin) && same8(xa.st.get('sav.pre-room'), old) && xa.jr[0].state === 'committed');
      const dc = rp(lastRec, old, 'discard'), xd = exec(dc, old);
      chk('recover: ...\'discard\' leaves storage untouched and closes the record \'aborted\'', dc.outcome === 'user-discarded' && dc.steps.every((x) => x.op === 'journal') && same8(xd.st.get('sav'), old) && xd.jr[0].state === 'aborted');
      chk('recover: ...and when applying would change nothing (the stored value already IS the final image) there is no question to ask', rp(lastRec, fin).outcome === 'already-written' && !rp(lastRec, fin).needsChoice);
      chk('recover: a \'staged\' record is discarded (the page died before its last symbol left, so no peer can have committed) and closes \'aborted\'', rp(stg, old).action === 'discard' && rp(stg, old).steps.length === 1 && rp(stg, old).steps[0].record.state === 'aborted');
      const rej = Object.assign({}, rec, { source: 'rejected-stored', skip: 'stored-invalid' });
      chk('recover: a stored save the room could not use (rejected-stored) is NEVER overwritten by a recovery, committing or in doubt', rp(rej, old).outcome === 'skipped:stored-invalid' && rp(rej, old).steps.every((x) => x.op === 'journal') && rp(Object.assign({}, lastRec, { source: 'rejected-stored' }), old).outcome === 'skipped:stored-invalid');
      const empty = Object.assign({}, lastRec, { image: new Uint8Array(0), imageHash: M.cardHash(new Uint8Array(0)) });
      chk('recover: a title with no battery has nothing to recover (skipped:no-battery) and asks nothing', rp(empty, null).outcome === 'skipped:no-battery' && !rp(empty, null).needsChoice);
      chk('recover: committed / aborted / absent records need nothing', rp({ state: 'committed' }, old).action === 'none' && rp({ state: 'aborted' }, old).action === 'none' && rp(null, old).action === 'none');
      chk('recover: runSteps refuses an operation it does not know (COMMIT_BAD_STEP) and runs only the first \`limit\` steps', (await codeOf(() => M.runSteps([{ op: 'wipe' }], { journal() {}, put() {} }))) === 'COMMIT_BAD_STEP' && (() => { let n = 0; return M.runSteps([{ op: 'journal', record: {} }, { op: 'journal', record: {} }, { op: 'journal', record: {} }], { journal() { n++; } }, 2) === 2 && n === 2; })());
    }
    // idempotent sampling
    const a = new M.RoomMachine(new FakeCore(2, images.slice(0, 2)), cfgFor(GAMES.kirby, 2, {}, M), 0, images.slice(0, 2), 'stored');
    a.setWantEnd(true);
    const p1 = a.localPad(5, 17), p2 = a.localPad(5, 17);
    chk('end: sampling the same frame twice gives the identical pad (a stalled frame is retried)', Buffer.compare(Buffer.from(p1.pad), Buffer.from(p2.pad)) === 0);
    chk('machine: step() refuses an input image shorter than seats x 4 bytes (an engine left at padBytes 2 would otherwise read zeros silently)', (() => { try { a.step(new Uint8Array(4)); return false; } catch (e) { return e instanceof RangeError; } })());
    chk('machine: the end journal lives under one key per game', M.journalKey('Sonic Advance 3') === 'gba-room-journal:Sonic Advance 3' && M.journalKey('Sonic Advance 3') !== M.journalKey(GAMES.kirby));
    chk('end: recovery table: staged -> discard, last-symbol -> in-doubt, committing -> finish-commit, committed/none -> none',
      M.endRecover({ state: 'staged' }).action === 'discard' && M.endRecover({ state: 'last-symbol' }).action === 'in-doubt' && M.endRecover({ state: 'committing' }).action === 'finish-commit' && M.endRecover({ state: 'committed' }).action === 'none' && M.endRecover(null).action === 'none');
  });

  // ---- the options every peer hands the engine: delay lockstep, replay on, checkpoints off, rollback off ----------------------------------
  await guard('options', async () => {
    const b = M.baseLockstepOptions(), h = M.lockstepOptions(cfgFor(GAMES.kirby, 3, { inputDelay: 5 }, M));
    chk('options: delay lockstep only - rollback 0, rsReplay on, checkpoints off, 4-byte pads, 4 ports, a fingerprint every 60 frames', b.rollback === 0 && b.rollbackOk === false && b.rsReplay === true && b.rsCheckpoint === false && b.padBytes === 4 && b.portCount === 4 && b.hashEvery === 60 && M.HASH_EVERY === 60);
    chk('options: a joiner\'s base options carry no field names yet; the host\'s add its delay and seat0..seatN-1,link (so a desync names the seat)', b.fieldNames === null && h.delay === 5 && h.fieldNames.join() === 'seat0,seat1,seat2,link' && h.padBytes === b.padBytes && h.hashEvery === b.hashEvery && M.fieldNames(2).join() === 'seat0,seat1,link');
    chk('options: DISCONNECT_POLICY and CHECKPOINT_POLICY say what the options say', M.DISCONNECT_POLICY.rsReplay === true && M.DISCONNECT_POLICY.rsCheckpoint === false && M.DISCONNECT_POLICY.rollback === false && M.CHECKPOINT_POLICY.enabled === false && typeof M.DISCONNECT_POLICY.unmeasured === 'string' && /phone/.test(M.DISCONNECT_POLICY.unmeasured));
  });

  // ---- gate 9: ONE step() is ONE emulated frame, and the engine is told the hardware rate (fake core: deterministic, no timing) ---------
  await guard('frame', async () => {
    const imgs2 = [patternImage(0x8000, 1), patternImage(0x8000, 2)], cfg2 = cfgFor(GAMES.kirby, 2, {}, M), z = new Uint8Array(8);
    const fc = new FakeCore(2, imgs2), m = new M.RoomMachine(fc, cfg2, 0, imgs2, 'stored'), deltas = [];
    for (let i = 0; i < 20; i++) { const b = fc.n; m.step(z); deltas.push(fc.n - b); }
    chk('frame: every step() runs the core EXACTLY ONE frame (gate 9: the guest runs at 1.000x - never two frames per call)', deltas.every((x) => x === 1) && fc.n === 20 && m.frame === 20, deltas.join(''));
    const bad = new FakeCore(2, imgs2); bad.runFrame = function () { this.n++; return 1; };
    const mb = new M.RoomMachine(bad, cfg2, 0, imgs2, 'stored'), rb = mb.step(z);
    chk('frame: a non-zero core status is returned and counted as an incident - never swallowed', rb.status === 1 && mb.incidents === 1 && m.incidents === 0);
    const HW = 16777216 / 280896;
    chk('frame: the lockstep options carry the hardware frame rate 16777216/280896 = 59.7275 Hz, never a faster one (frameHz paces the engine)', M.baseLockstepOptions().frameHz === HW && M.lockstepOptions(cfg2).frameHz === HW && M.GBA_HZ === HW && Math.abs(HW - 59.7275) < 1e-4);
    chk('frame: step() takes the input image and nothing else (there is no speed argument)', M.RoomMachine.prototype.step.length === 1);
  });

  // ---- bootMachine on a core that records what is done to it (so a flipped ROM or a skipped setRtc is a failure, not an unmeasured path) ------
  await guard('boot', async () => {
    const T = M.TITLES, kirbyFile = T[GAMES.kirby].file, sbamFile = T[GAMES.sbam].file;
    const cfgK = cfgFor(GAMES.kirby, 2, {}, M), cfgS = cfgFor(GAMES.sbam, 2, {}, M);
    const kb = romOnce(kirbyFile), sb = romOnce(sbamFile), empty2 = [new Uint8Array(0), new Uint8Array(0)];
    const imgK = [M.blankSave(GAMES.kirby), patternImage(0x8000, 3)];
    const ok1 = stubMgba();
    const mach = await M.bootMachine({ MgbaCore: ok1.MgbaCore, config: cfgK, rom: kb, images: imgK, localSeat: 1, wasmBinary: WASM });
    const rtc = ok1.calls.filter((c) => c[0] === 'setRtc'), sets = ok1.calls.filter((c) => c[0] === 'setSave');
    chk('boot: the room\'s clock pin - fixedEpochMs AND tzOffsetMin - reaches the core (setRtc is called once, with both)', rtc.length === 1 && rtc[0][1].fixedEpochMs === cfgK.fixedEpochMs && rtc[0][1].tzOffsetMin === cfgK.tzOffsetMin && cfgK.tzOffsetMin !== 0, JSON.stringify(rtc));
    chk('boot: every seat gets ITS OWN image through setSave (seat 0 the blank chip, seat 1 its pattern) and the core is made for the room\'s seat count', sets.length === 2 && sets[0][1] === 0 && same8(sets[0][2], imgK[0]) && sets[1][1] === 1 && same8(sets[1][2], imgK[1]) && ok1.calls.some((c) => c[0] === 'create' && c[1] === 2));
    chk('boot: a machine built on the recording core fingerprints hash() per seat then the link hash - not hashGame, and the link hash is not dropped', mach.localSeat === 1 && JSON.stringify(mach.fingerprint().words) === JSON.stringify([0x1000, 0x1001, 0x3000]) && mach.fingerprint().hash === M.foldWords([0x1000, 0x1001, 0x3000]));
    const refuse = async (opts, stubOpts) => { const st = stubMgba(stubOpts); const e = await expectErr(() => M.bootMachine(Object.assign({ MgbaCore: st.MgbaCore, wasmBinary: WASM, localSeat: 0 }, opts))); return { code: e.code, calls: st.calls }; };
    const noCore = (r) => !r.calls.some((c) => c[0] === 'create');
    const f1 = await refuse({ config: cfgS, rom: romFlipped(sbamFile, 0x100000), images: empty2 });
    chk('boot: a ROM one byte different (same length, same save-library string) is refused ROOM_ROM before any core exists', f1.code === 'ROOM_ROM' && noCore(f1), f1.code);
    const f2 = await refuse({ config: cfgS, rom: sb.subarray(0, sb.length - 1), images: empty2 });
    chk('boot: a ROM one byte short, or empty, is refused ROOM_ROM before any core exists', f2.code === 'ROOM_ROM' && noCore(f2) && (await refuse({ config: cfgS, rom: new Uint8Array(0), images: empty2 })).code === 'ROOM_ROM');
    const f3 = await refuse({ config: cfgS, rom: sb, images: empty2, wasmBinary: wasmFlipped() });
    chk('boot: a core build one byte different (the wasm this page loaded) is ROOM_CORE before any core exists', f3.code === 'ROOM_CORE' && noCore(f3), f3.code);
    const f4 = await refuse({ config: cfgK, rom: kb, images: imgK }, { setSaveOk: false });
    chk('boot: a core that refuses a seat\'s save is SAVE_REFUSED_BY_CORE and the half-built core is closed', f4.code === 'SAVE_REFUSED_BY_CORE' && f4.calls.some((c) => c[0] === 'close'), f4.code);
    const f5 = await refuse({ config: cfgK, rom: kb, images: imgK }, { saveTag: 'flash1m' });
    chk('boot: a cartridge whose own save-library string is not the title table\'s is ROOM_ROM and the core is closed', f5.code === 'ROOM_ROM' && f5.calls.some((c) => c[0] === 'close'), f5.code);
    const f6 = await refuse({ config: cfgK, rom: kb, images: [imgK[0], new Uint8Array(100)] });
    chk('boot: an image of the wrong size for a seat is SAVE_BAD_SIZE and the core is closed', f6.code === 'SAVE_BAD_SIZE' && f6.calls.some((c) => c[0] === 'close'), f6.code);
    chk('boot: a local seat outside the room is SAVE_SEAT_RANGE before anything is hashed', (await refuse({ config: cfgK, rom: kb, images: imgK, localSeat: 2 })).code === 'SAVE_SEAT_RANGE');
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the transcript simulator: N RoomMachines on fake cores, fed the SAME applied image each frame, with sampling delay D, a kill schedule and
// fault injection. Each machine has a store (a Map) and a journal log; the "page" persists journal records before using the pad that needs them.
// ---------------------------------------------------------------------------------------------------------------------------------
function simulate(M, o) {
  const n = o.seats, D = o.D === undefined ? 2 : o.D, T = o.T || 600, images = o.images;
  const cfg = cfgFor(GAMES.kirby, n, {}, M);
  const machines = [], stores = [], journals = [], sent = [], plans = [];
  for (let i = 0; i < n; i++) {
    const core = new FakeCore(n, images);
    if (o.corrupt && o.corrupt.machine === i) core.img[o.corrupt.seat][o.corrupt.byte] ^= 0x55;
    machines.push(new M.RoomMachine(core, cfg, i, images.map((x) => x.slice()), 'stored'));
    const st = new Map([['sav', images[i].slice()]]); st.log = []; st.backupLog = []; st.journal = null; stores.push(st);
    journals.push([]); sent.push([]); plans.push(null);
  }
  // a page's storage: the journal is ONE record (the latest); a put under <key> is logged as a save write, under <key>.pre-room as a backup
  const persist = (s, rec) => { journals[s].push(rec); stores[s].journal = rec; };
  const ioOf = (s) => ({ journal: (rec) => persist(s, rec), put: (k, b) => { stores[s].set(k, b.slice()); (/\.pre-room$/.test(k) ? stores[s].backupLog : stores[s].log).push({ key: k, seat: s }); } });
  const alive = (s, f) => !(o.kill && o.kill.seat === s && f >= o.kill.at);
  const q = new Map();                                    // applied frame -> [word per seat]
  const wordsAt = (f) => { if (!q.has(f)) q.set(f, new Array(n).fill(0)); return q.get(f); };
  const lastWord = new Array(n).fill(0), conflictSeen = {};
  const done = () => machines.every((m, s) => !alive(s, 1e9) ? true : (m.end.phase === 'commit' || m.end.phase === 'unclean'));
  for (let f = 0; f < T; f++) {
    for (let s = 0; s < n; s++) {
      if (!alive(s, f) || !machines[s]) continue;
      const m = machines[s];
      let keys = 0;
      if (o.trade && s === 0 && f >= 40 && f < 43) keys = 1;
      if (o.trade && s === 1 && f >= 60 && f < 63) keys = 1;
      const wf = o.wantFrom ? o.wantFrom[s] : Infinity;
      let w = wf !== undefined && f >= wf;
      if (o.flicker && o.flicker.seat === s && f >= o.flicker.from && f < o.flicker.to) w = false;
      m.setWantEnd(w);
      const lp = m.localPad(keys, f);
      if (lp.journal) persist(s, lp.journal);
      let word = M.bytesToWord(lp.pad, 0);
      const dec = M.decodeWord(word);
      if (o.muteDigest === s && dec.kind === M.KIND.DIGEST) word = M.encodeWord(keys, { kind: M.KIND.WANT });
      // a seat that contradicts itself: its SECOND digest symbol re-sends position 0 with a different payload
      if (o.conflict === s && dec.kind === M.KIND.DIGEST && (conflictSeen[s] = (conflictSeen[s] || 0) + 1) === 2) word = M.encodeWord(keys, { kind: M.KIND.DIGEST, pos: 0, payload: (M.decodeWord(lastWord[s]).payload ^ 1) & 0xFFFF });
      if (o.dupDigest && dec.kind === M.KIND.DIGEST && (f % 3) === 1) word = lastWord[s];
      lastWord[s] = word;
      if (dec.kind === M.KIND.DIGEST) sent[s].push({ f, pos: dec.pos });
      wordsAt(f + D)[s] = word >>> 0;
    }
    const words = wordsAt(f);
    const image = new Uint8Array(n * 4);
    for (let s = 0; s < n; s++) image.set(M.wordToBytes(words[s]), s * 4);
    for (let s = 0; s < n; s++) {
      if (!alive(s, f)) continue;
      const m = machines[s];
      const out = m.step(image);
      if (out.journal) persist(s, out.journal);
      if (m.end.phase === 'commit' && !stores[s].committed) {
        stores[s].committed = true;
        const plan = m.commitPlan({ key: 'sav', previous: stores[s].get('sav') });
        plans[s] = plan;
        if (!o.deferCommit) M.runSteps(plan.steps, ioOf(s), o.crashAt && o.crashAt.seat === s ? o.crashAt.k : undefined);
      }
    }
    q.delete(f);
    if (done() && f > 10) break;
  }
  return { machines, stores, journals, sent, plans };
}

// Sweep every (seats, delay, dying seat, death frame): the property is about WHO MAY COMMIT, so it is checked on every death frame.
function crashSweep(M, images, quick) {
  const v = { i1: [], i2: [], i3: [], i4: [], i5: [] };
  let runs = 0, committed = 0, notCommitted = 0, inDoubt = 0, selfCommitted = 0;
  for (const n of (quick ? [2] : [2, 3])) for (const D of (quick ? [2] : [0, 2, 5])) {
    const base = simulate(M, { seats: n, D, images: images.slice(0, n), wantFrom: Array.from({ length: n }, () => 100), trade: true });
    const lastG = base.machines[0].end.G || 200;
    for (let s = 0; s < n; s++) for (let k = 90; k <= lastG + 12; k++) {
      runs++;
      const r = simulate(M, { seats: n, D, images: images.slice(0, n), wantFrom: Array.from({ length: n }, () => 100), kill: { seat: s, at: k }, T: 1100, trade: true });
      const surv = r.machines.filter((_, i) => i !== s);
      const tag = `n=${n} D=${D} seat=${s} dies@${k}`;
      const phases = new Set(surv.map((m) => m.end.phase)), Fs = new Set(surv.map((m) => m.end.F)), Gs = new Set(surv.map((m) => m.end.G));
      if (phases.size !== 1 || Fs.size !== 1 || Gs.size !== 1) v.i2.push(`${tag}: phases ${[...phases]} F ${[...Fs]} G ${[...Gs]}`);
      const did = surv[0].end.phase === 'commit';
      const all4 = new Set(r.sent[s].filter((x) => x.f < k).map((x) => x.pos)).size === 4;
      if (did && !all4) v.i1.push(`${tag}: survivors COMMITTED but the dead seat emitted ${new Set(r.sent[s].filter((x) => x.f < k).map((x) => x.pos)).size}/4 positions`);
      if (!did && all4) v.i1.push(`${tag}: dead seat emitted all 4 positions yet the survivors did not commit (phase ${[...phases]})`);
      const j = r.journals[s], lastRec = j.length ? j[j.length - 1] : null;
      const rec = M.endRecover(lastRec).action;
      const selfDone = r.machines[s].end.phase === 'commit';          // the machine committed itself before it died
      if (did ? (selfDone ? rec !== 'none' : rec !== 'in-doubt') : !(rec === 'discard' || rec === 'none')) v.i3.push(`${tag}: survivors ${did ? 'committed' : 'did not commit'} but the dead machine recovers as '${rec}' (journal ${JSON.stringify(lastRec && lastRec.state)})`);
      if (did) { committed++; if (rec === 'in-doubt') inDoubt++; else selfCommitted++; } else notCommitted++;
      // the dead machine's page restarts, reads its journal and (asked) applies an in-doubt room. Whatever the survivors did, its storage ends up
      // holding its seat's CONSENSUS final image if they committed and its initial image if they did not - never a peer's, never a torn value
      {
        const st = r.stores[s], jr = [];
        const rp = M.recoverPlan({ record: st.journal, key: 'sav', stored: st.get('sav'), choice: 'apply' });
        M.runSteps(rp.steps, { journal: (x) => jr.push(x), put: (kk, b) => st.set(kk, b.slice()) });
        const want = did ? surv[0].captured.images[s] : images[s];
        if (!same8(st.get('sav'), want)) v.i5.push(`${tag}: after recovery (${rp.action}/${rp.outcome}) the dead machine's store holds ${M.cardHash(st.get('sav'))} and should hold ${M.cardHash(want)}`);
      }
      r.stores.forEach((st, i) => {
        if (st.log.some((w) => w.key !== 'sav' || w.seat !== i)) v.i4.push(`${tag}: machine ${i} wrote ${JSON.stringify(st.log)}`);
        if (st.log.length && !(r.machines[i].end.phase === 'commit')) v.i4.push(`${tag}: machine ${i} wrote without a commit`);
        if (i === s && st.log.length && !selfDone) v.i4.push(`${tag}: the dead machine wrote without having committed itself`);
      });
    }
  }
  // ABSTAINERS: everyone alive, but seat s never votes - nobody may commit (a vote is required from EVERY seat)
  for (const n of (quick ? [2] : [2, 3])) for (const D of (quick ? [2] : [0, 2, 5])) for (let s = 0; s < n; s++) {
    runs++;
    const r = simulate(M, { seats: n, D, images: images.slice(0, n), wantFrom: Array.from({ length: n }, (_, i) => (i === s ? Infinity : 100)), T: 400 });
    if (r.machines.some((m) => m.end.phase === 'commit' || m.end.F !== null)) v.i1.push(`n=${n} D=${D}: seat ${s} never voted yet the room ended (phases ${r.machines.map((m) => m.end.phase)})`);
    if (r.stores.some((st) => st.log.length)) v.i4.push(`n=${n} D=${D}: seat ${s} never voted yet a store was written`);
  }
  return { runs, violations: v, committed, notCommitted, inDoubt, selfCommitted };
}

// Kill the machine after EVERY prefix of its final commit steps - and again after every prefix of its recovery - then restart it. Whatever the cut:
// its storage ends holding either its seat's initial image or its seat's final image (never a torn value, never a peer's), the backup holds the
// initial image whenever the final one was written, the journal is closed, and one more restart finds nothing left to do. This is the "kill during
// the final commit" case the end handshake alone does not reach: the machine had already DECIDED to commit.
function commitCrashSweep(M, images) {
  const v = [], seen = new Set();
  let runs = 0;
  const iof = (st) => ({ journal: (r) => { st.journal = r; }, put: (k, b) => st.set(k, b.slice()) });
  const fresh = (init, rec) => { const st = new Map([['sav', init.slice()]]); st.journal = rec; return st; };
  for (const n of [2, 3]) {
    const base = simulate(M, { seats: n, D: 2, images: images.slice(0, n), wantFrom: Array.from({ length: n }, () => 100), trade: true, deferCommit: true });
    for (let s = 0; s < n; s++) {
      const m = base.machines[s], plan = base.plans[s], init = images[s], fin = m.captured.images[s];
      const lastRec = base.stores[s].journal, changed = !same8(init, fin);                   // the journal holds the 'last-symbol' record when the commit starts
      for (let k = 0; k <= plan.steps.length; k++) for (const choice of (k === 0 ? ['apply', 'discard'] : ['apply'])) {
        const crashed = () => { const st = fresh(init, lastRec); M.runSteps(plan.steps, iof(st), k); return st; };
        const c0 = crashed();
        seen.add(c0.journal.state + (same8(c0.get('sav'), fin) ? '/key=final' : '/key=old') + (k === 0 ? '/' + choice : ''));
        const rp0 = M.recoverPlan({ record: c0.journal, key: 'sav', stored: c0.get('sav'), choice });
        for (let j = 0; j <= rp0.steps.length; j++) {
          runs++;
          const st = crashed();
          M.runSteps(rp0.steps, iof(st), j);                                                   // dies again in the middle of its recovery
          const rp = M.recoverPlan({ record: st.journal, key: 'sav', stored: st.get('sav'), choice });
          M.runSteps(rp.steps, iof(st));
          const rp2 = M.recoverPlan({ record: st.journal, key: 'sav', stored: st.get('sav'), choice });
          const tag = `n=${n} seat=${s} cut@${k}/${plan.steps.length} choice=${choice} recovery-cut@${j}/${rp0.steps.length}`;
          const sav = st.get('sav'), bak = st.get('sav.pre-room'), wantFinal = !(k === 0 && choice === 'discard');
          const stray = [...st.keys()].filter((x) => x !== 'sav' && x !== 'sav.pre-room');
          if (stray.length) v.push(`${tag}: stray keys ${stray}`);
          if (!same8(sav, wantFinal ? fin : init)) v.push(`${tag}: the key holds ${M.cardHash(sav)}, expected ${M.cardHash(wantFinal ? fin : init)}`);
          if (bak && !same8(bak, init)) v.push(`${tag}: the backup is not the initial image`);
          if (wantFinal && changed && !bak) v.push(`${tag}: the final image was written without a backup of the old one`);
          if (!st.journal || st.journal.state !== (wantFinal ? 'committed' : 'aborted')) v.push(`${tag}: the journal ends '${st.journal && st.journal.state}'`);
          if (rp2.steps.length) v.push(`${tag}: one more restart still has ${rp2.steps.length} steps to do`);
        }
      }
    }
  }
  return { runs, violations: v, seen: [...seen].sort() };
}

// ===============================================================================================================================
// MUTANTS: each is a one-line rewrite of room.js. The named battery checks must FAIL on it (and pass on the real module).
// ===============================================================================================================================
const DISC_DROPS = [
  ['g', "'g=' + encodeURIComponent(c.game), ", '', 'disc: names the game (ROOM_GAME)'],
  ['rom', "'rom=' + c.romMd5, ", '', 'disc: names the ROM (ROOM_ROM)'],
  ['core', "'core=' + c.coreBuildMd5, ", '', 'disc: names the core (ROOM_CORE)'],
  ['n (seats)', "'n=' + c.seats,", '', 'disc: names the seat count (ROOM_SEATS)'],
  ['clk (clock)', "'clk=' + c.fixedEpochMs + '@' + c.tzOffsetMin, ", '', 'disc: names the clock epoch (ROOM_CLOCK)'],
  ['st (saveType)', "'st=' + c.saveTypes.join(','), ", '', 'disc: names the save type (ROOM_SAVETYPE)'],
  ['room', "'room=' + c.roomId, ", '', 'disc: names the room id (ROOM_ID)'],
  ['sav (save set)', "'sav=' + (setHash || '-')", "'sav=-'", 'disc: names the agreed save set (ROOM_SAVESET)'],
];
const MUTANTS = [
  ...DISC_DROPS.map(([f, from, to, expect]) => ({ name: `disc string drops the '${f}' field`, from, to, expect: [expect] })),
  { name: 'skip the per-chunk hash check', from: "if (fnv1a(piece) !== env.chunkHashes[i]) fail('SAVE_TAMPERED_CHUNK'", to: "if (false) fail('SAVE_TAMPERED_CHUNK'", expect: ['saves: a flipped bit in payload chunk 2 is SAVE_TAMPERED_CHUNK naming the seat and chunk', 'saves: a flipped bit in the LAST chunk is caught too'] },
  { name: 'accept two ports claiming one seat', from: "if (claims.has(env.seat)) fail('SAVE_DUPLICATE_SEAT'", to: "if (false) fail('SAVE_DUPLICATE_SEAT'", expect: ['set: two ports claiming the same seat is SAVE_DUPLICATE_SEAT'] },
  { name: 'ignore the save type', from: "if (typeName !== cfg.saveTypes[port]) fail('SAVE_WRONG_TYPE'", to: "if (false) fail('SAVE_WRONG_TYPE'", expect: ["saves: wrong save type - the envelope says flash1m in a Kirby (sram) room (SAVE_WRONG_TYPE)"] },
  { name: 'ignore the save size', from: "if (chip.sizes.indexOf(env.rawSize) < 0) fail('SAVE_BAD_SIZE'", to: "if (false) fail('SAVE_BAD_SIZE'", expect: ['saves: wrong size - a fully self-consistent 16 KiB image in a 32 KiB sram seat is SAVE_BAD_SIZE'] },
  { name: 'accept a set with a missing seat', from: "if (!set || !set[s]) fail('SAVE_MISSING_SEAT'", to: "if (false) fail('SAVE_MISSING_SEAT'", expect: ['set: a missing seat is SAVE_MISSING_SEAT'] },
  { name: 'persist a PEER seat (the local plan writes seat+1\'s image)', from: 'finalImage: this.captured.images[L]', to: 'finalImage: this.captured.images[(L + 1) % this.seats]', expect: ['persist: seat 0 writes ONLY its own seat\'s image (never a peer\'s)', 'end: 2 seats - each store changed only at its own key, holds exactly ITS OWN seat\'s final image, and only after the commit (seats that traded wrote once, the others not at all)'] },
  { name: 'commit on an UNCLEAN end (planCommit ignores the phase)', from: "if (!endState || endState.phase !== 'commit') fail('COMMIT_NOT_CLEAN'", to: "if (!endState) fail('COMMIT_NOT_CLEAN'", expect: ['persist: an unclean end (digests mismatch) writes NOTHING - commitPlan refuses (COMMIT_NOT_CLEAN)', 'persist: planCommit on a non-commit state is COMMIT_NOT_CLEAN'] },
  { name: 'commit although the digests MISMATCH', from: "if (wrong.length) return endUnclean(s, 'END_MISMATCH'", to: "if (false) return endUnclean(s, 'END_MISMATCH'", expect: ['end: one machine whose saves differ -> END_MISMATCH on EVERY machine, nobody commits'] },
  { name: 'commit on the digest TIMEOUT', from: 'if (f - s.F >= s.timeout) {', to: "if (f - s.F >= s.timeout) { s.phase = 'commit'; s.G = f; return { state: s, event: { type: 'commit', frame: f, F: s.F } };", expect: ['end: a seat that never completes its digest -> END_TIMEOUT on every machine at the same frame, nobody commits'] },
  { name: 'end the room when ANY seat votes (some instead of every)', from: 'if (s.streak.every((x) => x >= s.hold))', to: 'if (s.streak.some((x) => x >= s.hold))', expect: ['end: two of three voting never ends the room'] },
  { name: 'a withdrawn vote does not reset the count', from: 'syms[i].kind === KIND_WANT ? s.streak[i] + 1 : 0', to: 'syms[i].kind === KIND_WANT ? s.streak[i] + 1 : s.streak[i]', expect: ['end: a vote withdrawn before everyone held it for 30 frames resets - the room ends LATER, not earlier'] },
  { name: 'recovery treats an in-doubt record as safe to discard', from: "case 'last-symbol': return { action: 'in-doubt' };", to: "case 'last-symbol': return { action: 'discard' };", expect: ['end: recovery table: staged -> discard, last-symbol -> in-doubt, committing -> finish-commit, committed/none -> none'] },
  { name: 'journal only the FIRST position-3 sample', from: 'const last = k === DIGEST_POSITIONS - 1;', to: 'const last = sampleFrame - state.F - 1 === DIGEST_POSITIONS - 1;', expect: ['end: the last-symbol journal is demanded on EVERY sample carrying position 3 (a skipped first cycle must not escape it) and on no other'] },
  { name: 'accept a seat that contradicts itself', from: "else if (cur !== y.payload) return endUnclean(s, 'END_CONFLICT'", to: "else if (false) return endUnclean(s, 'END_CONFLICT'", expect: ['end: a seat sending two different values for one digest position -> END_CONFLICT, nobody commits'] },
  { name: 'accept a roster with a hole in it', from: "if (occ[i] !== i) fail('SEATS_GAP'", to: "if (false) fail('SEATS_GAP'", expect: ['seats: a hole in the roster is SEATS_GAP'] },
  { name: 'accept a non-canonical config text', from: "if (encodeConfig(c) !== text) fail('ROOM_ENCODING'", to: "if (false) fail('ROOM_ENCODING'", expect: ['config: a reordered (non-canonical) text is refused ROOM_ENCODING', 'config: an unknown extra key is refused ROOM_ENCODING'] },
  { name: 'the catalogue admits a title without a passing row', from: "r.outcome === 'linked'", to: "r.outcome !== 'zzz'", expect: ['catalogue: ROOMABLE = exactly the titles with a passing row', 'catalogue: deriveRoomable puts a title in only when a row is LINKED'] },
  // ---- gate 9
  { name: 'step() runs the core TWICE per call (a 2x fast-forward)', from: 'const status = this.core.runFrame();', to: 'this.core.runFrame(); const status = this.core.runFrame();', expect: ['frame: every step() runs the core EXACTLY ONE frame'] },
  { name: 'the engine is told a frame rate of 120 Hz', from: 'fieldNames: null, frameHz: GBA_HZ };', to: 'fieldNames: null, frameHz: 120 };', expect: ['frame: the lockstep options carry the hardware frame rate'] },
  { name: 'the hardware frame length is wrong (GBA_HZ doubles)', from: 'export const GBA_CYCLES_PER_FRAME = 280896;', to: 'export const GBA_CYCLES_PER_FRAME = 140448;', expect: ['frame: the lockstep options carry the hardware frame rate'] },
  { name: 'a non-zero core status is swallowed', from: 'if (status) this.incidents++;', to: '', expect: ['frame: a non-zero core status is returned and counted'] },
  // ---- the journal and its recovery
  { name: 'the commit journal says "staged" instead of "committing" (M41)', from: "Object.assign({ state: 'committing', F: this.end.F, key }", to: "Object.assign({ state: 'staged', F: this.end.F, key }", expect: ["end: the 'committing' record carries", 'end: the journal is written in the order', 'end: a commit is journal(committing)'] },
  { name: "the commit journal carries a PEER seat's image (M42)", from: '{ image: this.captured.images[L].slice(), imageHash', to: '{ image: this.captured.images[(L + 1) % this.seats].slice(), imageHash', expect: ["end: the 'committing' record carries"] },
  { name: "the last-symbol journal carries a PEER seat's image (M43)", from: 'return this.captured ? this.captured.images[this.localSeat].slice() : null; }', to: 'return this.captured ? this.captured.images[(this.localSeat + 1) % this.seats].slice() : null; }', expect: ["end: every 'last-symbol' record carries"] },
  { name: 'journalAfter never says committed (M44)', from: "plan.journalAfter = { state: 'committed'", to: "plan.journalAfter = { state: 'committing'", expect: ['end: the journal is written in the order', 'end: a commit is journal(committing)'] },
  { name: 'room.js never creates the staged record', from: 'journal = this._capture(f);', to: 'this._capture(f);', expect: ["end: room.js ITSELF makes the 'staged' record"] },
  { name: 'endCapture ignores which frame was agreed (M49)', from: "if (state.phase !== 'digest' || state.F !== frame || state.capture) return state;", to: "if (state.phase !== 'digest' || state.capture) return state;", expect: ['end: endCapture takes only the AGREED frame'] },
  { name: 'a malformed word counts as a WANT-END vote (M55)', from: 'syms[i].kind === KIND_WANT ? s.streak[i] + 1 : 0', to: '(syms[i].kind === KIND_WANT || syms[i].bad) ? s.streak[i] + 1 : 0', expect: ['end: a malformed word never counts as a WANT-END vote'] },
  { name: 'the end digest does not bind the agreed frame (M07)', from: "const text = roomId + '|' + frame + '|' + imageHashes.join(',');", to: "const text = roomId + '|' + imageHashes.join(',');", expect: ['end: the digest binds the agreed frame'] },
  { name: 'the end digest does not bind the room id (M08)', from: "const text = roomId + '|' + frame + '|' + imageHashes.join(',');", to: "const text = frame + '|' + imageHashes.join(',');", expect: ['end: the digest binds the agreed frame'] },
  { name: 'only digest position 0 is compared (M09)', from: 's.got[i].some((x, k) => x !== s.capture.digest[k])', to: 's.got[i].some((x, k) => k === 0 && x !== s.capture.digest[k])', expect: ['end: ONE wrong position'] },
  { name: 'decodeWord ignores stray payload on idle/want words (M06)', from: 'if ((kind === KIND_IDLE || kind === KIND_WANT) && (pos !== 0 || payload !== 0)) bad = true;', to: '', expect: ['words: stray payload bits'] },
  { name: 'planCommit drops its local-seat range check (M16)', from: "if (!isInt(localSeat) || localSeat < 0 || localSeat >= endState.n) fail('SAVE_SEAT_RANGE'", to: "if (false) fail('SAVE_SEAT_RANGE'", expect: ['persist: planCommit refuses a local seat outside the room'] },
  { name: 'recovery overwrites a value somebody else wrote', from: "if (sh !== before) return { action, outcome: 'stored-changed'", to: "if (false) return { action, outcome: 'stored-changed'", expect: ['recover: ...over a value that is NEITHER'] },
  { name: 'recovery rewrites over the final value (and backs the NEW value up)', from: "if (sh === rec.imageHash) return done('already-written', []);", to: '', expect: ['recover: ...over the FINAL value'] },
  { name: 'recovery backs up the FINAL image instead of the old value', from: "if (have) steps.push({ op: 'put', key: key + '.pre-room', bytes: have.slice() });", to: "if (have) steps.push({ op: 'put', key: key + '.pre-room', bytes: image.slice() });", expect: ["recover: a 'committing' record over the OLD value is finished"] },
  { name: 'recovery overwrites a stored save the room could not use', from: "if (rec.skip || rec.source === 'rejected-stored') return done(", to: 'if (rec.skip) return done(', expect: ['recover: a stored save the room could not use'] },
  { name: 'recovery trusts a journal image that does not match its hash', from: 'if (!isHex(rec.imageHash, 8) || cardHash(image) !== rec.imageHash) return invalid(', to: 'if (false) return invalid(', expect: ['recover: a record whose image does not match its own hash'] },
  { name: 'recovery ignores which storage key the journal was written for', from: 'if (rec.key !== undefined && rec.key !== key) return invalid(', to: 'if (false) return invalid(', expect: ['recover: a record written for another storage key'] },
  { name: 'an in-doubt room is applied without asking the player', from: "if (choice === 'apply') return p;", to: 'return p;', expect: ["recover: a 'last-symbol' record over the OLD value is IN DOUBT"] },
  { name: 'discarding an in-doubt room still writes', from: "if (choice === 'discard') return { action: 'in-doubt', outcome: 'user-discarded', steps: [stepJournal(abortedRecord(record, 'user-discarded'))] };", to: '', expect: ["recover: ...'discard' leaves storage untouched"] },
  { name: 'runSteps ignores the step limit', from: 'const n = limit === undefined ? steps.length : Math.max(0, Math.min(steps.length, limit | 0));', to: 'const n = steps.length;', expect: ['recover: runSteps refuses an operation it does not know'] },
  // ---- saves
  { name: 'verifySaveEntry drops the per-chip SAVE_TOO_BIG (M19)', from: "if (env.rawSize > SAVE_CAPS[chip.cap]) fail('SAVE_TOO_BIG'", to: "if (false) fail('SAVE_TOO_BIG'", expect: ['saves: a gzip save that declares 64 KiB for a 32 KiB SRAM seat'] },
  { name: 'verifySaveEntry drops the enc-label check (M20)', from: "if (entry.enc !== ENC[env.codec]) fail('SAVE_ENC'", to: "if (false) fail('SAVE_ENC'", expect: ['saves: an entry whose enc label disagrees'] },
  { name: "verifySaveEntry checks only the entry hash, not the envelope's (M23)", from: 'if (h !== entry.hash || fnv1a(raw) !== env.imageHash)', to: 'if (h !== entry.hash)', expect: ["saves: a flipped bit in the envelope's whole-image hash"] },
  { name: 'verifySaveEntry drops the inflated-size check (M24)', from: "if (raw.length !== env.rawSize) fail('SAVE_BAD_SIZE'", to: "if (false) fail('SAVE_BAD_SIZE'", expect: ['saves: gzip that inflates to 100 bytes'] },
  { name: 'parseSaveEnvelope reports another protocol version as SAVE_ENVELOPE again (GR2 fix A1)', from: "b[3] >= 0x30 && b[3] <= 0x39 && b[3] !== MAGIC[3]) fail('ROOM_VERSION'", to: "false) fail('ROOM_VERSION'", expect: ['saves: an envelope from ANOTHER protocol version'] },
  { name: 'parseSaveEnvelope drops the chunk-size check (M25)', from: "if (e.chunkSize !== WIRE_CHUNK) fail('SAVE_ENVELOPE'", to: "if (false) fail('SAVE_ENVELOPE'", expect: ['saves: a chunk size other than the 12 KiB wire piece'] },
  { name: 'parseSaveEnvelope drops the raw/payload cap (M27)', from: "if (e.rawSize > SAVE_CAPS.flash || e.payloadSize > SAVE_CAPS.flash + 1024) fail('SAVE_TOO_BIG'", to: "if (false) fail('SAVE_TOO_BIG'", expect: ['saves: a payload length over the cap'] },
  { name: 'parseSaveEnvelope drops the chunk-count consistency check (M27b)', from: "if (e.chunkCount !== (e.payloadSize ? Math.ceil(e.payloadSize / WIRE_CHUNK) : 0)) fail('SAVE_ENVELOPE'", to: "if (false) fail('SAVE_ENVELOPE'", expect: ['saves: an envelope that lists one chunk more'] },
  { name: 'the inflate cap is removed, so a bomb is fully inflated (M29)', from: 'if (total > max) { await r.cancel()', to: 'if (false) { await r.cancel()', expect: ['saves: ...and it is refused WITHOUT being inflated'] },
  { name: 'an oversize entry is parsed instead of refused up front', from: "if (entry.bytes.length > bound) fail('SAVE_TOO_BIG'", to: "if (false) fail('SAVE_TOO_BIG'", expect: ['saves: an entry far larger than any honest save'] },
  { name: "verifySaveSet does not bound a seat's entry", from: "if (e.bytes.length > ROOM_CARD_LIMITS.maxCardBytes) fail('SAVE_TOO_BIG'", to: "if (false) fail('SAVE_TOO_BIG'", expect: ['saves: verifySaveSet applies the same bound'] },
  { name: 'verifySaveEntry takes any port', from: "if (!isInt(port) || port < 0 || port >= cfg.seats) fail('SAVE_SEAT_RANGE'", to: "if (false) fail('SAVE_SEAT_RANGE'", expect: ['saves: verifySaveEntry refuses a port outside the room'] },
  // ---- boot
  { name: 'bootMachine drops the ROM md5 and length check (M30)', from: 'if (romBytes.length !== t.romBytes || md5(romBytes) !== cfg.romMd5) fail(', to: 'if (false) fail(', expect: ['boot: a ROM one byte different', 'boot: a ROM one byte short, or empty'] },
  { name: 'bootMachine drops the core build md5 (M31)', from: 'if (wm !== cfg.coreBuildMd5) fail(', to: 'if (false) fail(', expect: ['boot: a core build one byte different'] },
  { name: 'bootMachine skips setRtc (M32)', from: 'core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: cfg.tzOffsetMin });', to: '', expect: ["boot: the room's clock pin"] },
  { name: 'bootMachine pins the time zone to 0 (M32b)', from: 'core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: cfg.tzOffsetMin });', to: 'core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: 0 });', expect: ["boot: the room's clock pin"] },
  { name: 'bootMachine never calls setSave (M33)', from: 'if (!core.setSave(s, images[s])) fail(', to: 'if (false) fail(', expect: ['boot: every seat gets ITS OWN image'] },
  { name: 'bootMachine ignores a refused setSave (M33b)', from: "fail('SAVE_REFUSED_BY_CORE'", to: "(0, function () {})('SAVE_REFUSED_BY_CORE'", expect: ["boot: a core that refuses a seat's save"] },
  { name: 'bootMachine drops the save-library-string check (M34)', from: "if (info.saveTag !== t.saveTag) fail('ROOM_ROM'", to: "if (false) fail('ROOM_ROM'", expect: ['boot: a cartridge whose own save-library string'] },
  { name: 'the fingerprint leaves out the link hash (M36)', from: 'words.push(this.core.hashLink());', to: '', expect: ['boot: a machine built on the recording core fingerprints'] },
  { name: 'the fingerprint uses hashGame instead of hash (M36b)', from: 'for (let i = 0; i < this.seats; i++) words.push(this.core.hash(i));', to: 'for (let i = 0; i < this.seats; i++) words.push(this.core.hashGame(i));', expect: ['boot: a machine built on the recording core fingerprints'] },
  // ---- config, disc, names
  { name: 'DELAY_MAX 3000 (M51)', from: 'export const DELAY_MIN = 1, DELAY_MAX = 30, DELAY_DEFAULT = 3;', to: 'export const DELAY_MIN = 1, DELAY_MAX = 3000, DELAY_DEFAULT = 3;', expect: ['config: input delay 1 and 30 are accepted'] },
  { name: 'validateConfig drops the players check (M59)', from: "cfg.players.some((s) => typeof s !== 'string' || s.length > 32)", to: 'false', expect: ['config: a player label over 32'] },
  { name: 'validateConfig drops the epoch bound (M60)', from: 'Math.abs(cfg.fixedEpochMs) > 9e15', to: 'false', expect: ['config: the pinned epoch is accepted'] },
  { name: 'validateConfig drops the time zone bound (M61)', from: 'Math.abs(cfg.tzOffsetMin) > 1440', to: 'false', expect: ['config: the pinned time zone is accepted'] },
  { name: 'a game name is looked up WITHOUT an own-property check (titleOf)', from: 'const titleOf = (game) => (own(TITLES, game) ? TITLES[game] : null);', to: 'const titleOf = (game) => TITLES[game];', expect: ['config: game names that exist on Object.prototype'] },
  { name: 'ROOMABLE is looked up WITHOUT an own-property check (roomableOf)', from: 'const roomableOf = (game) => (own(ROOMABLE, game) ? ROOMABLE[game] : null);', to: 'const roomableOf = (game) => ROOMABLE[game];', expect: ['config: game names that exist on Object.prototype'] },
  { name: 'compareDisc stays silent on unknown / reordered fields', from: 'if (why.length || !out.length) {', to: 'if (false) {', expect: ['disc: a peer that sends a field this page does not know', 'disc: the same fields in a different order', 'disc: explainBarrierFailure names a peer'] },
  { name: 'parseDisc builds an ordinary object (a peer chooses the keys)', from: 'const out = Object.create(null);', to: 'const out = {};', expect: ['disc: parseDisc builds a prototype-less record'] },
  { name: 'rsReplay off (M35)', from: 'rollbackOk: false, rsReplay: true, rsCheckpoint: false,', to: 'rollbackOk: false, rsReplay: false, rsCheckpoint: false,', expect: ['options: delay lockstep only'] },
  { name: 'checkpoints on (M35b)', from: 'rollbackOk: false, rsReplay: true, rsCheckpoint: false,', to: 'rollbackOk: false, rsReplay: true, rsCheckpoint: true,', expect: ['options: delay lockstep only'] },
  { name: 'rollback 8 (M35c)', from: 'hashEvery: HASH_EVERY, rollback: 0, rollbackOk: false,', to: 'hashEvery: HASH_EVERY, rollback: 8, rollbackOk: false,', expect: ['options: delay lockstep only'] },
  { name: 'fingerprint every 600 frames (M35d)', from: 'export const HASH_EVERY = 60;', to: 'export const HASH_EVERY = 600;', expect: ['options: delay lockstep only'] },
  { name: 'field names omit the link layer (M65)', from: "f.push('link'); return f;", to: 'return f;', expect: ['options: a joiner'] },
  { name: 'fold the input delay into the disc (it would refuse a room the host retuned)', from: "'room=' + c.roomId, ", to: "'room=' + c.roomId, 'dly=' + c.inputDelay, ", expect: ['disc: the input delay is NOT folded (the host retunes it mid-room)'] },
];

const CAMPAIGN = [
  ["M01-fastforward","step runs TWO frames per call (gate 9)","const status = this.core.runFrame();","this.core.runFrame(); const status = this.core.runFrame();"],
  ["M02-ignore-seat1-keys","step feeds keys only to seat 0","this.core.setKeys(i, d.keys);","this.core.setKeys(i, i === 0 ? d.keys : 0);"],
  ["M03-keys-not-masked-to-seat","every seat gets seat0 keys","this.core.setKeys(i, d.keys);","this.core.setKeys(i, decodeWord(bytesToWord(image, 0)).keys);"],
  ["M05-reserved-bits-ok","decodeWord ignores reserved bits","let bad = resv !== 0 || kind === 3;","let bad = kind === 3;"],
  ["M06-idle-payload-ok","decodeWord ignores stray payload on idle/want","if ((kind === KIND_IDLE || kind === KIND_WANT) && (pos !== 0 || payload !== 0)) bad = true;",""],
  ["M07-digest-no-frame","endDigest does not bind frame","const text = roomId + '|' + frame + '|' + imageHashes.join(',');","const text = roomId + '|' + imageHashes.join(',');"],
  ["M08-digest-no-room","endDigest does not bind room id","const text = roomId + '|' + frame + '|' + imageHashes.join(',');","const text = frame + '|' + imageHashes.join(',');"],
  ["M09-digest-only-pos0","endStep compares only digest position 0","s.got[i].some((x, k) => x !== s.capture.digest[k])","s.got[i].some((x, k) => k === 0 && x !== s.capture.digest[k])"],
  ["M10-hold1","END_HOLD_FRAMES = 1","export const END_HOLD_FRAMES = 30;","export const END_HOLD_FRAMES = 1;"],
  ["M13-no-backup","planCommit never backs up previous","const backups = previous && toU8(previous).length ? [{ key: key + '.pre-room', bytes: toU8(previous).slice() }] : [];","const backups = [];"],
  ["M14-overwrite-rejected","planCommit overwrites a rejected stored save","if (source === 'rejected-stored') return { writes: [], backups: [], skip: 'stored-invalid' };",""],
  ["M15-always-write","planCommit rewrites unchanged","if (eqBytes(fin, ini)) return { writes: [], backups: [], skip: 'unchanged' };",""],
  ["M16-no-localseat-range","planCommit drops local seat range check","if (!isInt(localSeat) || localSeat < 0 || localSeat >= endState.n) fail('SAVE_SEAT_RANGE'","if (false) fail('SAVE_SEAT_RANGE'"],
  ["M17-accept-wrong-stored","chooseContribution accepts wrong-size stored","if (chk.ok) return { raw: s.slice(), source: 'stored', warn: null };","return { raw: s.slice(), source: 'stored', warn: null };"],
  ["M18-blank-zero","blankSave fills 0x00","return new Uint8Array(saveSpec(game).bytes).fill(0xFF);","return new Uint8Array(saveSpec(game).bytes).fill(0x00);"],
  ["M19-no-toobig","verifySaveEntry drops SAVE_TOO_BIG","if (env.rawSize > SAVE_CAPS[chip.cap]) fail('SAVE_TOO_BIG'","if (false) fail('SAVE_TOO_BIG'"],
  ["M20-no-enc-check","verifySaveEntry drops enc/envelope check","if (entry.enc !== ENC[env.codec]) fail('SAVE_ENC'","if (false) fail('SAVE_ENC'"],
  ["M21-no-size-check","verifySaveEntry drops entry.size==envelope","if ((entry.size | 0) !== env.rawSize) fail('SAVE_BAD_SIZE'","if (false) fail('SAVE_BAD_SIZE'"],
  ["M22-no-hash-check","verifySaveEntry drops whole-image hash","if (h !== entry.hash || fnv1a(raw) !== env.imageHash) fail('SAVE_BAD_HASH'","if (false) fail('SAVE_BAD_HASH'"],
  ["M23-no-envhash","verifySaveEntry drops envelope image hash only","if (h !== entry.hash || fnv1a(raw) !== env.imageHash)","if (h !== entry.hash)"],
  ["M23b-no-entryhash","verifySaveEntry drops entry.hash only","if (h !== entry.hash || fnv1a(raw) !== env.imageHash)","if (fnv1a(raw) !== env.imageHash)"],
  ["M24-no-inflated-size","verifySaveEntry drops inflated-size check","if (raw.length !== env.rawSize) fail('SAVE_BAD_SIZE'","if (false) fail('SAVE_BAD_SIZE'"],
  ["M25-no-chunksize","parseSaveEnvelope drops chunkSize check","if (e.chunkSize !== WIRE_CHUNK) fail('SAVE_ENVELOPE'","if (false) fail('SAVE_ENVELOPE'"],
  ["M26-no-lenaccount","parseSaveEnvelope drops length accounting","if (b.length !== HDR + e.cfgLen + 4 * e.chunkCount + e.payloadSize) fail('SAVE_ENVELOPE'","if (false) fail('SAVE_ENVELOPE'"],
  ["M27-no-rawcap","parseSaveEnvelope drops rawSize cap","if (e.rawSize > SAVE_CAPS.flash || e.payloadSize > SAVE_CAPS.flash + 1024) fail('SAVE_TOO_BIG'","if (false) fail('SAVE_TOO_BIG'"],
  ["M27b-no-chunkcount","parseSaveEnvelope drops chunkCount consistency","if (e.chunkCount !== (e.payloadSize ? Math.ceil(e.payloadSize / WIRE_CHUNK) : 0)) fail('SAVE_ENVELOPE'","if (false) fail('SAVE_ENVELOPE'"],
  ["M28-no-seatrange","verifySaveSet drops seat range","if (p < 0 || p >= cfg.seats) fail('SAVE_SEAT_RANGE'","if (false) fail('SAVE_SEAT_RANGE'"],
  ["M28b-no-engine-hash","verifySaveSet drops engineSetHash compare","if (engineSetHash != null && engineSetHash !== setHash) fail('ROOM_SAVESET'","if (false) fail('ROOM_SAVESET'"],
  ["M29-no-inflate-cap","inflate cap removed","if (total > max) { await r.cancel()","if (false) { await r.cancel()"],
  ["M30-no-rommd5","bootMachine drops ROM md5","if (romBytes.length !== t.romBytes || md5(romBytes) !== cfg.romMd5) fail(","if (false) fail("],
  ["M30b-no-romlen","bootMachine drops ROM length check only","if (romBytes.length !== t.romBytes || md5(romBytes) !== cfg.romMd5)","if (md5(romBytes) !== cfg.romMd5)"],
  ["M31-no-wasmmd5","bootMachine drops wasm md5","if (wm !== cfg.coreBuildMd5) fail(","if (false) fail("],
  ["M32-no-setrtc","bootMachine skips setRtc","core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: cfg.tzOffsetMin });",""],
  ["M32b-tz-zero","bootMachine pins tz 0","core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: cfg.tzOffsetMin });","core.setRtc({ fixedEpochMs: cfg.fixedEpochMs, tzOffsetMin: 0 });"],
  ["M33-no-setsave","bootMachine skips setSave","if (!core.setSave(s, images[s])) fail(","if (false) fail("],
  ["M33b-setsave-ignored-result","bootMachine ignores setSave refusal","fail('SAVE_REFUSED_BY_CORE'","(0, function(){})('SAVE_REFUSED_BY_CORE'"],
  ["M34-no-savetag","bootMachine drops saveTag check","if (info.saveTag !== t.saveTag) fail('ROOM_ROM'","if (false) fail('ROOM_ROM'"],
  ["M35-replay-off","options rsReplay false","rollbackOk: false, rsReplay: true, rsCheckpoint: false,","rollbackOk: false, rsReplay: false, rsCheckpoint: false,"],
  ["M35b-ckpt-on","options rsCheckpoint true","rollbackOk: false, rsReplay: true, rsCheckpoint: false,","rollbackOk: false, rsReplay: true, rsCheckpoint: true,"],
  ["M35c-rollback-on","options rollback 8","hashEvery: HASH_EVERY, rollback: 0, rollbackOk: false,","hashEvery: HASH_EVERY, rollback: 8, rollbackOk: false,"],
  ["M35d-hashevery","hash cadence 600 (slow desync detection)","export const HASH_EVERY = 60;","export const HASH_EVERY = 600;"],
  ["M35e-frameHz","frameHz 120","frameHz: GBA_HZ };","frameHz: 120 };"],
  ["M36-no-hashlink","fingerprint skips hashLink","words.push(this.core.hashLink());",""],
  ["M36b-hashgame","fingerprint uses hashGame (PSG masked)","for (let i = 0; i < this.seats; i++) words.push(this.core.hash(i));","for (let i = 0; i < this.seats; i++) words.push(this.core.hashGame(i));"],
  ["M37-frame-no-inc","RoomMachine.frame does not advance","this.frame = f + 1;","this.frame = f;"],
  ["M38-capture-initial","capture uses initial image not exportSave","const img = x ? x : this.initial[i].slice();","const img = this.initial[i].slice();"],
  ["M39-no-journal","endLocalCtl never journals","journal: last ? { state: 'last-symbol', F: state.F, digest: state.capture.digest.slice() } : null","journal: null"],
  ["M40-recover-committing-none","recovery drops a committing record","case 'committing': return { action: 'finish-commit' };","case 'committing': return { action: 'none' };"],
  ["M41-journalBefore-state","commit journalBefore state is staged","Object.assign({ state: 'committing', F: this.end.F, key }","Object.assign({ state: 'staged', F: this.end.F, key }"],
  ["M42-journalBefore-peerimg","commit journalBefore carries a PEER seat image","{ image: this.captured.images[L].slice(), imageHash","{ image: this.captured.images[(L + 1) % this.seats].slice(), imageHash"],
  ["M43-journal-lastsym-peerimg","last-symbol journal image is a PEER seat","return this.captured ? this.captured.images[this.localSeat].slice() : null;","return this.captured ? this.captured.images[(this.localSeat + 1) % this.seats].slice() : null;"],
  ["M44-journalAfter-state","journalAfter says committing (never marks done)","plan.journalAfter = { state: 'committed'","plan.journalAfter = { state: 'committing'"],
  ["M45-host-seat-unchecked","checkRoster drops host check","if (o.hostPeer != null && roster[0] !== o.hostPeer) fail('SEATS_HOST'","if (false) fail('SEATS_HOST'"],
  ["M46-multi-seat-ok","checkRoster drops multi-seat check","if (new Set(occ.map((p) => roster[p])).size !== n) fail('SEATS_MULTI'","if (false) fail('SEATS_MULTI'"],
  ["M47-seats-range-ok","checkRoster drops seat-count check","if (rules.counts.indexOf(n) < 0) fail('SEATS_RANGE'","if (false) fail('SEATS_RANGE'"],
  ["M48-version-continue","compareDisc continues after tag mismatch","if (a.tag !== b.tag) return [","if (false) return ["],
  ["M49-capture-wrong-frame","endCapture ignores the agreed frame","if (state.phase !== 'digest' || state.F !== frame || state.capture) return state;","if (state.phase !== 'digest' || state.capture) return state;"],
  ["M50-timeout-huge","END_DIGEST_TIMEOUT huge (never times out)","export const END_DIGEST_TIMEOUT = 900;","export const END_DIGEST_TIMEOUT = 1e12;"],
  ["M51-delay-max-big","DELAY_MAX 3000","export const DELAY_MIN = 1, DELAY_MAX = 30, DELAY_DEFAULT = 3;","export const DELAY_MIN = 1, DELAY_MAX = 3000, DELAY_DEFAULT = 3;"],
  ["M52-delay-zero-ok","DELAY_MIN 0","export const DELAY_MIN = 1, DELAY_MAX = 30, DELAY_DEFAULT = 3;","export const DELAY_MIN = 0, DELAY_MAX = 30, DELAY_DEFAULT = 3;"],
  ["M53-conflict-first-wins-silent","END_CONFLICT ignored (first wins)","else if (cur !== y.payload) return endUnclean(s, 'END_CONFLICT'","else if (false) return endUnclean(s, 'END_CONFLICT'"],
  ["M54-digest-pos-unchecked","digest pos any (no 0..3 bound)","const cur = s.got[i][y.pos];","const cur = s.got[i][y.pos & 3];"],
  ["M55-bad-counts-as-want","bad word still counts as WANT vote","for (let i = 0; i < s.n; i++) s.streak[i] = syms[i].kind === KIND_WANT ? s.streak[i] + 1 : 0;","for (let i = 0; i < s.n; i++) s.streak[i] = (syms[i].kind === KIND_WANT || syms[i].bad) ? s.streak[i] + 1 : 0;"],
  ["M56-seat-claim-skip","verifySaveEntry drops SAVE_SEAT_CLAIM","if (env.seat !== port) fail('SAVE_SEAT_CLAIM'","if (false) fail('SAVE_SEAT_CLAIM'"],
  ["M57-cfgbytes-4096","config size cap removed","if (cfgBytes.length > CFG_MAX) fail('SAVE_ENVELOPE'","if (false) fail('SAVE_ENVELOPE'"],
  ["M58-readcfg-any-seat","readRoomConfig reads seat 1 instead of seat 0","const e = set && set[0];","const e = set && set[1];"],
  ["M59-validate-players","validateConfig drops players check","cfg.players.some((s) => typeof s !== 'string' || s.length > 32)","false"],
  ["M60-validate-fixedEpoch-range","validateConfig epoch bound removed","Math.abs(cfg.fixedEpochMs) > 9e15","false"],
  ["M61-validate-tz-range","validateConfig tz bound removed","Math.abs(cfg.tzOffsetMin) > 1440","false"],
  ["M62-step-no-endstep","step skips the end state machine","const r = endStep(this.end, f, syms);\n    this.end = r.state;","const r = { state: this.end, event: null };"],
  ["M63-localPad-always-want","localPad ignores wantEnd (votes forever)","if (state.phase === 'run') return { sym: want ? { kind: KIND_WANT } : null, journal: null };","if (state.phase === 'run') return { sym: { kind: KIND_WANT }, journal: null };"],
  ["M64-pad-bytes-2","PAD_BYTES 2","export const PAD_BYTES = 4;","export const PAD_BYTES = 2;"],
  ["M65-fieldnames","fieldNames omits link","f.push('link'); return f;","return f;"],
  ["M66-fold-roomid-out","discString folds nothing of sav","'sav=' + (setHash || '-')","'sav=' + (setHash || '-') + ''"],
];
const EQ_IDS = new Set(['M30b', 'M54', 'M57', 'M66']);

// ===============================================================================================================================
// sections
// ===============================================================================================================================
async function sectionModule() {
  section('module: room.js is a pure ES module; the shared hashes equal the engine\'s; md5 is correct');
  const forbidden = [/\bfrom\s+['"]node:/, /\brequire\s*\(/, /\bdocument\./, /\bwindow\b/, /\blocalStorage\b/, /\bindexedDB\b/, /\bfetch\s*\(/, /\bDate\.now\b/, /\bMath\.random\b/, /\bprocess\./, /\bBuffer\b/, /\bsetTimeout\b/];
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const hits = forbidden.filter((re) => re.test(stripped)).map(String);
  ok('no DOM, node:, network, storage, clock, randomness or timers in room.js (code only; comments stripped)', hits.length === 0, hits.join(' '));
  ok('no import statements at all (it must load from a data: URL)', !/^\s*import\s/m.test(stripped));
  const names = ['PROTOCOL_VERSION', 'makeConfig', 'encodeConfig', 'decodeConfig', 'discString', 'compareDisc', 'explainBarrierFailure', 'makeSaveEntry', 'verifySaveSet', 'verifySaveEntry', 'readRoomConfig', 'chooseContribution',
    'bootMachine', 'RoomMachine', 'endInit', 'endStep', 'endCapture', 'endLocalCtl', 'endRecover', 'planCommit', 'lockstepOptions', 'fieldNames', 'checkRoster', 'seatRules', 'ROOMABLE', 'TITLES', 'LINK_ROWS', 'md5', 'cardHash', 'cardSetHash', 'RoomError', 'ERROR_CODES'];
  ok('the documented exports exist', names.every((n) => n in R), names.filter((n) => !(n in R)).join(','));
  const viaData = await loadSrc(SRC);
  ok('the same source loads through a data: URL (what the mutants rely on)', viaData.PROTOCOL_VERSION === R.PROTOCOL_VERSION && viaData.md5(new Uint8Array(3)) === R.md5(new Uint8Array(3)));
  // hashes shared with the engine
  let same = true;
  for (const n of [0, 1, 7, 100, 12288, 40000]) { const b = crypto.randomBytes(n); if (R.cardHash(b) !== Lockstep.cardHash(new Uint8Array(b))) same = false; }
  ok('cardHash equals Lockstep.cardHash on 6 random buffers', same);
  const set = { 0: { size: 32768, hash: 'aaaaaaaa' }, 2: { size: 0, hash: '811c9dc5' }, 1: { size: 5, hash: 'bbbbbbbb' } };
  ok('cardSetHash equals Lockstep.cardSetHash (port order, size, hash; enc omitted)', R.cardSetHash(set) === Lockstep.cardSetHash(set));
  control('cardSetHash is sensitive to a size, to a hash and to a port', R.cardSetHash(set) !== R.cardSetHash({ ...set, 0: { size: 32767, hash: 'aaaaaaaa' } }) && R.cardSetHash(set) !== R.cardSetHash({ ...set, 0: { size: 32768, hash: 'aaaaaaab' } }) && R.cardSetHash(set) !== R.cardSetHash({ 0: set[0], 3: set[2], 1: set[1] }));
  // md5: RFC 1321 vectors + node crypto + the real ROMs and the wasm
  const vec = { '': 'd41d8cd98f00b204e9800998ecf8427e', a: '0cc175b9c0f1b6a831c399e269772661', abc: '900150983cd24fb0d6963f7d28e17f72', 'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b', '12345678901234567890123456789012345678901234567890123456789012345678901234567890': '57edf4a22be3c955ac49da2e2107b67a' };
  ok('md5: the six RFC 1321 test vectors', Object.entries(vec).every(([k, h]) => R.md5(Buffer.from(k)) === h));
  let agree = true; for (const n of [0, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100000]) { const b = crypto.randomBytes(n); if (R.md5(b) !== md5hex(b)) agree = false; }
  ok('md5: equals node crypto on 12 sizes around every padding boundary', agree);
  control('md5 control: a one-bit difference changes the digest', R.md5(Buffer.from('abc')) !== R.md5(Buffer.from('abd')));
  ok('md5: the page can hash the wasm it loaded and compare with dist/mgba_core.buildinfo.json', R.md5(WASM) === CORE_MD5, CORE_MD5);
  const sg = rom('Pokemon SoulGold (v1.1.1).gba'), t0 = performance.now();
  ok('md5: SoulGold (32 MiB) = b2c5caf9bc6dd28a44052427ee3ab1b7', R.md5(sg) === 'b2c5caf9bc6dd28a44052427ee3ab1b7', `${(performance.now() - t0).toFixed(0)} ms`);
}

async function sectionTables() {
  section('tables: ROM md5s, save types, the ROOMABLE catalogue vs the link rig');
  for (const [key, t] of Object.entries(R.TITLES)) {
    const b = rom(t.file);
    ok(`TITLES[${key}]: file md5 and size match the table`, md5hex(b) === t.romMd5 && b.length === t.romBytes);
  }
  const smoke = await import(pathToFileURL(path.join(ROOT, 'tools/gba_link_smoke.mjs')).href);
  const rig = smoke.TITLES;
  ok('LINK_ROWS = tools/gba_link_smoke.mjs TITLES (id, rom, seats, outcome), verbatim', JSON.stringify(R.LINK_ROWS.map((r) => [r.id, r.rom, r.seats, r.outcome])) === JSON.stringify(rig.map((r) => [r.id, r.rom, r.seats, r.expect])));
  const mutatedRows = R.LINK_ROWS.map((r) => (r.id === 'mra2-2p' ? { ...r, outcome: 'linked' } : r));
  control('catalogue control: a rows list that says Monster Rancher linked would change ROOMABLE (so the diff against the rig matters)', JSON.stringify(Object.keys(R.deriveRoomable(mutatedRows, R.TITLES))) !== JSON.stringify(Object.keys(R.ROOMABLE)));
  const expectRoomable = {};
  for (const t of rig.filter((x) => x.expect === 'linked')) expectRoomable[t.rom] = (expectRoomable[t.rom] || new Set()).add(t.seats);
  const got = Object.fromEntries(Object.entries(R.ROOMABLE).map(([k, v]) => [R.TITLES[k].file, new Set(v.counts)]));
  ok('ROOMABLE = exactly the (rom, seat count) pairs the rig recorded as linked', JSON.stringify(Object.entries(got).map(([k, v]) => [k, [...v].sort()]).sort()) === JSON.stringify(Object.entries(expectRoomable).map(([k, v]) => [k, [...v].sort()]).sort()));
  ok('every ROOMABLE title has a battery contract (a save type with a size)', Object.keys(R.ROOMABLE).every((k) => R.TITLES[k].saveType !== null));
  // save-type codes equal the adapter's
  ok('SAVE_TYPES codes equal MgbaCore.SAVE_TYPES', Object.entries(R.SAVE_TYPES).every(([k, v]) => MgbaCore.SAVE_TYPES[k] === v.code));
  ok('SAVE_CAPS: flash 128 KiB, SRAM 32 KiB, EEPROM 8 KiB; every chip size is under its cap', R.SAVE_CAPS.flash === 131072 && R.SAVE_CAPS.sram === 32768 && R.SAVE_CAPS.eeprom === 8192 && Object.values(R.SAVE_TYPES).every((c) => c.sizes.every((n) => n <= R.SAVE_CAPS[c.cap])));
  ok("lockstep options: a joiner's base options (no config yet) carry the same policy; the host's add its delay and the N-seat field names", (() => { const b = R.baseLockstepOptions(), h = R.lockstepOptions(cfgFor(GAMES.kirby, 3, { inputDelay: 5 })); return b.rollback === 0 && b.rsReplay === true && b.rsCheckpoint === false && b.padBytes === 4 && b.fieldNames === null && h.delay === 5 && h.fieldNames.join() === 'seat0,seat1,seat2,link' && h.padBytes === b.padBytes && h.hashEvery === b.hashEvery; })());
  ok('DISCONNECT: the lockstep options are delay-only, replay on, checkpoints off, 4-byte pads', (() => { const o = R.lockstepOptions(cfgFor(GAMES.kirby, 2)); return o.rollback === 0 && o.rsReplay === true && o.rsCheckpoint === false && o.padBytes === 4 && o.portCount === 4 && o.hashEvery === 60 && o.fieldNames.join() === 'seat0,seat1,link'; })());
}

async function sectionTablesLive() {
  section('tables (live cores): the per-title save table against what mGBA really does');
  const spec = {};
  for (const [key, t] of Object.entries(R.TITLES)) {
    const c = await MgbaCore.create({ seats: 1 });
    const inf = c.loadRom(rom(t.file));
    ok(`${key}: core.info.saveTag = '${t.saveTag}' (the table's)`, inf.saveTag === t.saveTag, `saveType ${inf.saveType}`);
    if (t.saveBytes) {
      const accepts = {};
      for (const n of [0x200, 0x2000, 0x8000, 0x10000, 0x20000]) { const c2 = await MgbaCore.create({ seats: 1 }); c2.loadRom(rom(t.file)); accepts[n] = c2.setSave(0, new Uint8Array(n).fill(0xFF)); c2.close(); }
      ok(`${key}: mGBA accepts a ${t.saveBytes}-byte image and refuses every other raw size`, Object.entries(accepts).every(([n, v]) => v === (Number(n) === t.saveBytes)), JSON.stringify(accepts));
    } else if (t.saveTag === 'none') {
      const c2 = await MgbaCore.create({ seats: 1 }); c2.loadRom(rom(t.file));
      for (let i = 0; i < 300; i++) c2.runFrame();
      ok(`${key}: no save-library string and the game never touches save memory -> exportSave stays null (hence a 0-byte seat image)`, c2.exportSave(0) === null);
      c2.close();
      const acc = [];
      for (const n of [0x200, 0x8000, 0x10000]) { const c3 = await MgbaCore.create({ seats: 1 }); c3.loadRom(rom(t.file)); acc.push(c3.setSave(0, new Uint8Array(n).fill(0xFF))); c3.close(); }
      ok(`${key}: setSave accepts ANY size (there is no tag to check it against) - so the room must never call it, and the 0-byte contract has to be enforced by room.js`, acc.every((x) => x === true), JSON.stringify(acc));
    }
    c.close();
    spec[key] = inf;
  }
  // BLANK EQUIVALENCE: contributing the blank chip = never calling setSave (so "a peer with no save" changes nothing about the machine)
  section('blank: a peer with no save contributes a 0xFF chip - the same machine as "no setSave" (900 frames, pinned RTC)');
  for (const key of [GAMES.kirby, GAMES.sa3, 'Monster Rancher Advance 2', 'Pokemon SoulGold']) {
    const t = R.TITLES[key], b = rom(t.file);
    const run = async (blank) => {
      const c = await MgbaCore.create({ seats: 1 });
      c.setRtc({ fixedEpochMs: 1700000000000, tzOffsetMin: -300 }); c.loadRom(b);
      if (blank) c.setSave(0, R.blankSave(key));
      for (let i = 0; i < 900; i++) { c.setKeys(0, (i % 90) < 4 ? 8 : (i % 70) < 3 ? 1 : 0); c.runFrame(); }
      const r = { h: c.hash(0), save: c.exportSave(0) }; c.close(); return r;
    };
    const a = await run(false), z = await run(true);
    ok(`${key}: blank chip == no setSave (state hash and exported save identical after 900 frames)`, a.h === z.h && a.save && z.save && Buffer.compare(Buffer.from(a.save), Buffer.from(z.save)) === 0, `hash 0x${a.h.toString(16)}`);
    if (key === GAMES.kirby) {
      const off = await (async () => { const c = await MgbaCore.create({ seats: 1 }); c.setRtc({ fixedEpochMs: 1700000000000, tzOffsetMin: -300 }); c.loadRom(b); c.setSave(0, patternImage(0x8000, 9)); for (let i = 0; i < 900; i++) { c.setKeys(0, (i % 90) < 4 ? 8 : (i % 70) < 3 ? 1 : 0); c.runFrame(); } const h = c.hash(0); c.close(); return h; })();
      control('blank control: a NON-blank save is a different machine (the equivalence is not vacuous)', off !== a.h);
    }
  }
}

async function sectionBattery() {
  section('battery on the real module (config, disc, seats, saves, words, persistence, end handshake + crash sweep)');
  const res = await battery(R);
  for (const r of res) ok(r.name, r.pass, r.detail);
  const fails = res.filter((r) => !r.pass).length;
  info(`${res.length} battery checks on the real module, ${fails} failing`);
  return res;
}

async function sectionMutants(real) {
  section('mutants: each one-line rewrite of room.js must trip the named battery checks (the unmutated twin above is quiet)');
  // an expectation is a check name or a PREFIX of one; only the battery sections that hold the expected checks are run on the mutant
  for (const mu of MUTANTS) {
    let src; try { src = mutate(mu.from, mu.to); } catch (e) { fail++; console.log(`  FAIL [control] ${mu.name}: ${e.message}`); continue; }
    const missing = mu.expect.filter((e) => !real.some((r) => r.name.startsWith(e)));
    if (missing.length) { fail++; console.log(`  FAIL [control] ${mu.name}: expects a check that does not exist on the real module: ${missing[0]}`); continue; }
    const secs = new Set(mu.expect.flatMap((e) => real.filter((r) => r.name.startsWith(e)).map((r) => r.section)));
    let res;
    try { res = await battery(await loadSrc(src), secs); } catch (e) { fail++; console.log(`  FAIL [control] ${mu.name}: the mutant battery crashed ${e.message}`); continue; }
    const failed = res.filter((r) => !r.pass).map((r) => r.name);
    const tripped = mu.expect.filter((e) => failed.some((n) => n.startsWith(e)));
    const extra = failed.length > tripped.length ? ` (+${failed.length - tripped.length} others in the same sections)` : '';
    control(`mutant '${mu.name}'`, tripped.length === mu.expect.length, `tripped ${tripped.length}/${mu.expect.length}${extra}`);
  }
}

// ===============================================================================================================================
// EQUIVALENT REWRITES: a mutant that cannot change behavior is not a gap, but "I think it is equivalent" is not a proof. Each one is held to a
// PROBE (inputs that exercise the rewritten line) run on the real module and on the rewrite: the observable results must be identical, and a
// sibling rewrite that DOES change behavior must be told apart by the same probe (so the probe is not blind).
// ===============================================================================================================================
const EQUIVALENT = [
  { id: 'M30b', name: 'bootMachine without the ROM LENGTH pre-check (md5 subsumes it: another length is another md5; the length test only avoids hashing a buffer of the wrong size)',
    from: 'romBytes.length !== t.romBytes || ', to: '', ctrl: ['romBytes.length !== t.romBytes || md5(romBytes) !== cfg.romMd5', 'false'],
    cases: 'an empty ROM, a 1-byte ROM, a ROM one byte short, a ROM one byte long',
    async probe(M) {
      const file = M.TITLES[GAMES.sbam].file, sb = romOnce(file), cfg = cfgFor(GAMES.sbam, 2, {}, M), out = [];
      for (const r of [new Uint8Array(0), new Uint8Array(1), sb.subarray(0, sb.length - 1), Buffer.concat([sb, Buffer.from([0])])]) {
        const st = stubMgba(); const e = await expectErr(() => M.bootMachine({ MgbaCore: st.MgbaCore, config: cfg, rom: r, images: [new Uint8Array(0), new Uint8Array(0)], localSeat: 0, wasmBinary: WASM }));
        out.push([e.code, st.calls.length]);
      }
      return JSON.stringify(out);
    } },
  { id: 'M54', name: 'the digest position is masked & 3 before indexing (decodeWord already yields only 0..3: the field is 2 bits wide)',
    from: 'const cur = s.got[i][y.pos];', to: 'const cur = s.got[i][y.pos & 3];', ctrl: ['const cur = s.got[i][y.pos];', 'const cur = s.got[i][y.pos & 1];'],
    cases: 'every position 0..3 delivered in all 24 orders, plus 100,000 random words (the largest decoded position is 3)',
    async probe(M) {
      const hs = ['aaaaaaaa', 'bbbbbbbb'], want = M.decodeWord(M.encodeWord(0, { kind: M.KIND.WANT })), res = [];
      const perms = []; const perm = (a, r) => { if (!a.length) perms.push(r); else a.forEach((x, i) => perm(a.filter((_, j) => j !== i), r.concat(x))); }; perm([0, 1, 2, 3], []);
      for (const order of perms) {
        let st = M.endStep(M.endInit({ seats: 2, hold: 1 }), 0, [want, want]).state;
        st = M.endCapture(st, { roomId: ROOM_ID, frame: 0, imageHashes: hs });
        order.forEach((k, i) => { const sy = M.decodeWord(M.encodeWord(0, { kind: M.KIND.DIGEST, pos: k, payload: st.capture.digest[k] })); st = M.endStep(st, 1 + i, [sy, sy]).state; });
        res.push(st.phase + ':' + JSON.stringify(st.got));
      }
      let x = 12345, maxPos = 0;
      for (let i = 0; i < 100000; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; const d = M.decodeWord(x); if (!d.bad && d.kind === 2) maxPos = Math.max(maxPos, d.pos); }
      return JSON.stringify({ res, maxPos });
    } },
  { id: 'M57', name: 'the 4096-byte room-config cap in an envelope is removed (the largest VALID config is far below it, so the cap is defense in depth)',
    from: "if (cfgBytes.length > CFG_MAX) fail('SAVE_ENVELOPE'", to: "if (false) fail('SAVE_ENVELOPE'", ctrl: ['const CFG_MAX = 4096;', 'const CFG_MAX = 100;'],
    cases: 'the WORST-CASE valid config (4 seats, every label 32 NUL characters, which JSON writes as 6 bytes each)',
    async probe(M) {
      const cfg = M.makeConfig({ game: GAMES.kirby, seats: 4, coreBuildMd5: CORE_MD5, fixedEpochMs: -9e15, tzOffsetMin: -1440, roomId: ROOM_ID, inputDelay: 30, players: Array(4).fill('\u0000'.repeat(32)) });
      const len = new TextEncoder().encode(M.encodeConfig(cfg)).length;
      const e = await expectErr(() => M.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: M.blankSave(GAMES.kirby), config: cfg }));
      return JSON.stringify({ len, code: e.code });
    } },
  { id: 'M66', name: "the save-set field of the disc string gets + '' appended (a no-op rewrite)",
    from: "'sav=' + (setHash || '-')", to: "'sav=' + (setHash || '-') + ''", ctrl: ["'sav=' + (setHash || '-')", "'sav=' + (setHash || '-') + 'x'"],
    cases: 'setHash undefined, null, empty and a real hash',
    async probe(M) { const c = cfgFor(GAMES.kirby, 2, {}, M); return JSON.stringify([undefined, null, '', 'abcd1234'].map((h) => M.discString(c, h))); } },
];

async function sectionEquivalent() {
  section('equivalent rewrites: proven by a probe that gives identical results on the real module and on the rewrite (and a probe that is not blind)');
  for (const eq of EQUIVALENT) {
    let a, b, c;
    try {
      a = await eq.probe(R); b = await eq.probe(await loadSrc(mutate(eq.from, eq.to)));
      c = await eq.probe(await loadSrc(mutate(eq.ctrl[0], eq.ctrl[1])));
    } catch (e) { fail++; console.log(`  FAIL ${eq.id}: the probe crashed ${(e && e.message) || e}`); continue; }
    ok(`equivalent ${eq.id}: ${eq.name} - the same results on ${eq.cases}`, a === b && a.length > 20, a.length > 120 ? a.slice(0, 120) + '...' : a);
    control(`equivalent ${eq.id}: the probe is not blind - a rewrite that DOES change this line gives different results`, a !== c);
  }
  const worst = JSON.parse(await EQUIVALENT.find((x) => x.id === 'M57').probe(R));
  ok(`M57: the largest valid room config encodes to ${worst.len} bytes, under the 4096-byte envelope cap (so the cap is unreachable from a validated config)`, worst.len < 4096 && worst.code === null, JSON.stringify(worst));
}

async function sectionSweep() {
  section('crash sweep: kill any one seat at EVERY frame of the end handshake (2-3 seats x delay 0/2/5), on the fake trade core');
  const images = [patternImage(0x8000, 1), patternImage(0x8000, 2), patternImage(0x8000, 3), patternImage(0x8000, 4)];
  const t0 = performance.now();
  const sw = crashSweep(R, images);
  info(`${sw.runs} runs in ${((performance.now() - t0) / 1000).toFixed(1)} s: survivors committed in ${sw.committed}, did not in ${sw.notCommitted}; the dead machine was IN DOUBT (sent its last symbol, never saw the decision) in ${sw.inDoubt} and had already committed itself in ${sw.selfCommitted}`);
  ok('no peer ever commits unless the dead seat had emitted all 4 digest positions (and the converse)', sw.violations.i1.length === 0, sw.violations.i1.slice(0, 2).join(' ; '));
  ok('every surviving machine reaches the same phase and the same F/G (deterministic consensus)', sw.violations.i2.length === 0, sw.violations.i2.slice(0, 2).join(' ; '));
  ok('the dead machine\'s journal recovers as in-doubt (or none, if it had committed itself first) when the survivors committed, and discard/none when they did not', sw.violations.i3.length === 0, sw.violations.i3.slice(0, 2).join(' ; '));
  ok('no store is ever written unless its machine reached commit, and never any other key', sw.violations.i4.length === 0, sw.violations.i4.slice(0, 2).join(' ; '));
  ok('the dead machine, RESTARTED (recoverPlan + runSteps, an in-doubt room applied), ends holding its seat\'s consensus final image when the survivors committed and its initial image when they did not - never a peer\'s, never a torn value', sw.violations.i5.length === 0, sw.violations.i5.slice(0, 2).join(' ; '));
  ok('the sweep exercised every outcome (early deaths commit nowhere; a death between the last symbol and the decision leaves the dead peer IN DOUBT; later deaths had already committed)', sw.committed > 0 && sw.notCommitted > 0 && sw.inDoubt > 0 && sw.inDoubt + sw.selfCommitted === sw.committed, `survivors committed ${sw.committed}, did not ${sw.notCommitted}; in-doubt ${sw.inDoubt}, self-committed ${sw.selfCommitted}`);
  for (const [name, from, to] of [
    ['ends the room when ANY seat votes', 'if (s.streak.every((x) => x >= s.hold))', 'if (s.streak.some((x) => x >= s.hold))'],
    ['recovery discards an in-doubt record', "case 'last-symbol': return { action: 'in-doubt' };", "case 'last-symbol': return { action: 'discard' };"],
    ['commits on the digest timeout', 'if (f - s.F >= s.timeout) {', "if (f - s.F >= s.timeout) { s.phase = 'commit'; s.G = f; return { state: s, event: { type: 'commit', frame: f, F: s.F } };"],
  ]) {
    const M = await loadSrc(mutate(from, to));
    const bad = crashSweep(M, images, true);
    const n = bad.violations.i1.length + bad.violations.i2.length + bad.violations.i3.length + bad.violations.i4.length + bad.violations.i5.length;
    control(`sweep mutant '${name}' violates the invariants`, n > 0, `${n} violations in ${bad.runs} runs`);
  }
  // the machine had already DECIDED to commit and dies in the middle of the write: every prefix of the commit, then every prefix of its recovery
  section('commit crash sweep: kill the machine after EVERY prefix of its final commit steps and again after every prefix of its recovery (2-3 seats, in-doubt applied or discarded)');
  const t1 = performance.now(), cs = commitCrashSweep(R, images);
  info(`${cs.runs} runs in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  ok('after every cut, storage holds ONLY the seat\'s initial or final image under its own key, the backup is the initial image whenever the final one was written, the journal is closed, and one more restart has nothing left to do', cs.violations.length === 0, cs.violations.slice(0, 2).join(' ; '));
  ok('the cuts landed in every state the commit passes through: journal last-symbol (nothing written), committing with the key still old, committing with the key already final, committed - and both answers to an in-doubt room were exercised', ['last-symbol/key=old/apply', 'last-symbol/key=old/discard', 'committing/key=old', 'committing/key=final', 'committed/key=final'].every((x) => cs.seen.includes(x)), cs.seen.join(' '));
  for (const [name, from, to] of [
    ['the commit journal says staged (M41)', "Object.assign({ state: 'committing', F: this.end.F, key }", "Object.assign({ state: 'staged', F: this.end.F, key }"],
    ["the commit journal holds a PEER seat's image (M42)", '{ image: this.captured.images[L].slice(), imageHash', '{ image: this.captured.images[(L + 1) % this.seats].slice(), imageHash'],
    ["the last-symbol journal holds a PEER seat's image (M43)", 'return this.captured ? this.captured.images[this.localSeat].slice() : null; }', 'return this.captured ? this.captured.images[(this.localSeat + 1) % this.seats].slice() : null; }'],
    ['recovery re-copies over a value already written', "if (sh === rec.imageHash) return done('already-written', []);", ''],
    ['recovery backs up the FINAL image', "if (have) steps.push({ op: 'put', key: key + '.pre-room', bytes: have.slice() });", "if (have) steps.push({ op: 'put', key: key + '.pre-room', bytes: image.slice() });"],
    ['recovery never closes the journal', 'steps: steps.concat([committed]) });', 'steps });'],
  ]) {
    const M = await loadSrc(mutate(from, to));
    const bad = commitCrashSweep(M, images);
    control(`commit sweep mutant '${name}' violates the invariants`, bad.violations.length > 0, `${bad.violations.length} violations in ${bad.runs} runs: ${bad.violations[0] || ''}`.slice(0, 200));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// frames (gate 9) on REAL cores: one step() is one emulated frame of every seat. Deterministic - counters, not clocks.
// ---------------------------------------------------------------------------------------------------------------------------------
async function realFrameFacts(M) {
  const game = GAMES.sbam, cfg = cfgFor(game, 2, {}, M), b = rom(R.TITLES[game].file);
  const m = await M.bootMachine({ MgbaCore, config: cfg, rom: b, images: [new Uint8Array(0), new Uint8Array(0)], localSeat: 0, wasmBinary: WASM });
  const z = new Uint8Array(8), N = 600;
  let perCall = true, c200 = null;
  for (let i = 0; i < N; i++) { m.step(z); if (m.core.frames(0) !== i + 1 || m.core.frames(1) !== i + 1) perCall = false; if (i === 199) c200 = [m.core.cycles(0), m.core.cycles(1)]; }
  // cycles per frame is the SLOPE between frame 200 and frame 600 (the absolute count starts at a line offset after power-on: -392 cycles/frame averaged over 600)
  const out = { perCall, N, frames: [m.core.frames(0), m.core.frames(1)], mframe: m.frame, cyc: [(m.core.cycles(0) - c200[0]) / (N - 200), (m.core.cycles(1) - c200[1]) / (N - 200)] };
  m.close();
  return out;
}
async function sectionFrames() {
  section('frames (gate 9): one step() is one emulated frame of EVERY seat, on real cores - counters, not clocks, so it cannot be load-dependent');
  const f = await realFrameFacts(R);
  ok(`after EACH of ${f.N} step() calls both seats' own frame counters equal the call count (final ${f.frames}, machine.frame ${f.mframe})`, f.perCall && f.frames[0] === f.N && f.frames[1] === f.N && f.mframe === f.N);
  ok('guest cycles per frame, over frames 200-600, are 280,896 (the hardware frame length) within the bounded link jitter, so GBA_HZ = 16,777,216 / 280,896 IS the rate the core advances at', f.cyc.every((c) => Math.abs(c - 280896) < 30) && R.GBA_CYCLES_PER_FRAME === 280896 && R.GBA_CLOCK_HZ === 16777216 && R.GBA_HZ === 16777216 / 280896, `cycles/frame ${f.cyc.map((c) => c.toFixed(2))}`);
  const two = await loadSrc(mutate('const status = this.core.runFrame();', 'this.core.runFrame(); const status = this.core.runFrame();'));
  const fm = await realFrameFacts(two);
  control(`frames control: a step() that runs the core twice is caught by the cores' own frame counters (counters ${fm.frames}, not ${f.N})`, !(fm.perCall && fm.frames[0] === fm.N && fm.frames[1] === fm.N));
  const hz = await loadSrc(mutate('fieldNames: null, frameHz: GBA_HZ };', 'fieldNames: null, frameHz: 120 };'));
  control('frames control: a frameHz of 120 is not the hardware rate', hz.baseLockstepOptions().frameHz !== 16777216 / 280896 && R.baseLockstepOptions().frameHz === 16777216 / 280896);

  // the pinned zone reaches the GAME's own calendar (the only RTC cartridge we ship): SoulGold latches the clock a few frames after power-on
  const sg = rom(R.TITLES['Pokemon SoulGold'].file), cal = async (tz) => {
    const c = await MgbaCore.create({ seats: 1 }); c.setRtc({ fixedEpochMs: 1700000000000, tzOffsetMin: tz }); c.loadRom(sg);
    for (let i = 0; i < 120; i++) c.runFrame();
    const w = c.rtcWitness(0); c.close(); return w;
  };
  const w5 = await cal(-300), w0 = await cal(0);
  ok('rtcWitness: SoulGold latches the pinned clock within 120 frames and its decoded calendar is the room\'s fixed-offset wall clock (epoch 1700000000, UTC-5 -> 2023-11-14 17:13:20)', w5.present && w5.pinned && w5.utcOffsetSec === -18000 && w5.latches > 0 && w5.firstUnix === 1700000000 && w5.calendar.year === 2023 && w5.calendar.month === 11 && w5.calendar.day === 14 && w5.calendar.hour === 17 && w5.calendar.minute === 13, JSON.stringify(w5.calendar) + ' latches ' + w5.latches);
  control('rtcWitness control: the same epoch at UTC+0 reads 22:13 - the offset the room pins really changes what the game sees', w0.calendar.hour === 22 && w0.calendar.minute === 13 && w0.utcOffsetSec === 0 && w5.calendar.hour !== w0.calendar.hour, JSON.stringify(w0.calendar));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// docs: the README sections that code and README itself point at must exist, and must not contradict the measurements
// ---------------------------------------------------------------------------------------------------------------------------------
const README_PATH = path.join(ROOT, 'gba/mgba/README.md');
function lintReadme(text, codeFiles) {
  const problems = [];
  const heads = [...text.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].trim());
  if (!heads.some((h) => /^Rooms\b/.test(h))) problems.push('no "Rooms" section');
  if (!heads.some((h) => /^Determinism pins\b/.test(h))) problems.push('no "Determinism pins" section');
  for (const m of text.matchAll(/section "([^"]+)"/g)) if (!heads.some((h) => h.startsWith(m[1]))) problems.push(`dangling pointer in the README: section "${m[1]}"`);
  for (const [file, src] of Object.entries(codeFiles || {})) for (const m of src.matchAll(/README\.md "([^"]+)"/g)) if (!heads.some((h) => h.startsWith(m[1]))) problems.push(`${file} points at README section "${m[1]}", which does not exist`);
  for (const must of ['rtcWitness', 'no DST', 'rsReplay', 'in-doubt', 'recoverPlan', 'commitSteps', 'hashGame', 'ROOM_CARD_LIMITS']) if (!text.toLowerCase().includes(must.toLowerCase())) problems.push(`the README never mentions ${must}`);
  if (/restored from another('|’)?s states evolves identically/.test(text)) problems.push('the README says an instance restored from savestates "evolves identically" to one that kept running (contradicts the hashGame row)');
  return problems;
}
async function sectionDocs() {
  section('docs: gba/mgba/README.md has the Rooms and Determinism pins sections that README, room.js and mgba_core.js point at');
  const text = fs.readFileSync(README_PATH, 'utf8');
  const code = { 'gba/mgba/room.js': SRC, 'gba/mgba/mgba_core.js': fs.readFileSync(path.join(ROOT, 'gba/mgba/mgba_core.js'), 'utf8') };
  const p = lintReadme(text, code);
  ok('the README has a "Rooms" and a "Determinism pins" section, every pointer to a section lands on a heading, it names rtcWitness / no DST / the rsReplay decision / the in-doubt recovery, and it no longer claims a restored instance evolves identically', p.length === 0, p.join(' ; '));
  control('docs control: a README without its Rooms heading is caught', lintReadme(text.replace(/^## Rooms.*$/m, '## Roomz'), code).length > 0);
  control('docs control: a README without its Determinism pins heading is caught', lintReadme(text.replace(/^## Determinism pins.*$/m, '## Pins'), code).length > 0);
  control('docs control: the old contradiction ("a fresh instance restored from another\'s states evolves identically") is caught', lintReadme(text + '\nA fresh instance restored from another\'s states evolves identically.\n', code).length > 0);
  control('docs control: a pointer from the code to a section that is not there is caught', lintReadme(text, { 'x.js': 'see gba/mgba/README.md "Nonexistent"' }).length > 0);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// campaign (opt-in: --campaign): the independent verifier's whole list of one-line rewrites, against the whole battery
// ---------------------------------------------------------------------------------------------------------------------------------
async function sectionCampaign() {
  section(`campaign: ${CAMPAIGN.length} one-line rewrites of room.js (the independent verifier's list; anchors updated where room.js changed) - each must fail at least one battery check`);
  const killed = [], survived = [], equivalent = [];
  for (const [id, desc, from, to] of CAMPAIGN) {
    if (EQ_IDS.has(id.split('-')[0])) { equivalent.push(id.split('-')[0]); continue; }
    let src; try { src = mutate(from, to); } catch (e) { fail++; console.log(`  FAIL [control] ${id}: ${e.message}`); continue; }
    const res = await battery(await loadSrc(src));
    const bad = res.filter((r) => !r.pass);
    if (bad.length) killed.push(id); else survived.push(id);
    control(`campaign ${id} ${desc}`, bad.length > 0, bad.length ? `first: ${bad[0].name.slice(0, 90)}` : 'NOT CAUGHT');
  }
  info(`campaign: ${killed.length} killed, ${survived.length} survived, ${equivalent.length} equivalent (${equivalent.join(', ')}; proven by the probes in section 'equivalent') of ${CAMPAIGN.length}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// engine-level: the card exchange, the barrier and the named refusals, on REAL Lockstep engines in a STAR bus
// ---------------------------------------------------------------------------------------------------------------------------------
async function exchange(ids, game, { tamper, forgeClaim, forgeType, noSaveFor = [], images = {} } = {}) {
  const seats = ids.length, cfg = cfgFor(game, seats);
  const bus = starBus(ids, R.lockstepOptions(cfg));
  seatAll(bus);
  const size = R.TITLES[game].saveBytes;
  const raws = ids.map((id, i) => (noSaveFor.includes(i) ? R.chooseContribution(game, null).raw : (images[i] || (size ? patternImage(size, 10 + i) : new Uint8Array(0)))));
  if (tamper) bus.hook = (from, m) => {
    if (m.t === 'lsvmu' && from === tamper.peer && (m.i | 0) === tamper.piece) {
      const b = Buffer.from(m.d, 'base64'); b[tamper.at] ^= 0x04; return Object.assign({}, m, { d: b.toString('base64') });
    }
    return m;
  };
  for (let i = 0; i < seats; i++) {
    let e = await R.makeSaveEntry({ game, seat: i, raw: raws[i], config: i === 0 ? cfg : undefined });
    if (forgeClaim && forgeClaim.seat === i) e = { ...e, bytes: (() => { const b = e.bytes.slice(); b[4] = forgeClaim.claims; return b; })() };
    if (forgeType && forgeType.seat === i) e = { ...e, bytes: (() => { const b = e.bytes.slice(); b[5] = forgeType.code; return b; })() };
    bus.engines[i].contributeCards([e]);
  }
  return { bus, cfg, raws };
}

async function sectionCards() {
  section('cards: the save exchange over the REAL contributeCards / start barrier, 2, 3 and 4 seats');
  for (const n of [2, 3, 4]) {
    const ids = ['H', 'A', 'B', 'C'].slice(0, n);
    const { bus, cfg, raws } = await exchange(ids, GAMES.kirby);
    const [H, ...guests] = bus.engines;
    ok(`${n} seats: the engine assembled the set on the host and on every guest, same fingerprint`, !!H.cards && guests.every((g) => g.cards && g.cardSetHash === H.cardSetHash));
    const vs = [];
    for (const e of bus.engines) vs.push(await R.verifySaveSet({ config: R.readRoomConfig(e.cards), set: e.cards, engineSetHash: e.cardSetHash }));
    ok(`${n} seats: every peer verifies the set and reads the HOST's config out of seat 0's envelope`, vs.every((v) => v.setHash === vs[0].setHash && v.config.roomId === cfg.roomId && v.config.seats === n && v.config.fixedEpochMs === cfg.fixedEpochMs));
    ok(`${n} seats: every peer recovers every seat's image byte for byte`, vs.every((v) => v.images.every((im, s) => Buffer.compare(Buffer.from(im), Buffer.from(raws[s])) === 0)));
    const disc = R.discString(cfg, vs[0].setHash);
    for (const e of bus.engines) e.declareReady(disc);
    ok(`${n} seats: the barrier releases (all running) on the identical disc string`, bus.engines.every((e) => e.state === 'running'), bus.engines.map((e) => e.state).join());
    ok(`${n} seats: rsReplay was agreed by every page (the room is a replay room), rollback is off`, bus.engines.every((e) => e._rsRoom === true && e.rollback === 0));
  }
  // a peer with no save contributes the blank chip; the room sees exactly those bytes
  {
    const { bus, raws } = await exchange(['H', 'A'], GAMES.kirby, { noSaveFor: [1] });
    const v = await R.verifySaveSet({ config: R.readRoomConfig(bus.engines[0].cards), set: bus.engines[0].cards });
    ok('a peer with no save: its seat arrives as the blank 0xFF chip on every machine', v.images[1].length === 0x8000 && v.images[1].every((x) => x === 0xFF) && Buffer.compare(Buffer.from(v.images[0]), Buffer.from(raws[0])) === 0);
  }
  // a no-battery title: size 0 entries still complete the engine's assembly
  {
    const { bus } = await exchange(['H', 'A'], GAMES.sbam);
    const v = await R.verifySaveSet({ config: R.readRoomConfig(bus.engines[1].cards), set: bus.engines[1].cards, engineSetHash: bus.engines[1].cardSetHash });
    ok('a title with no battery (Super Bust-A-Move): empty entries complete the exchange and verify', !!bus.engines[0].cards && v.images.every((x) => x.length === 0));
  }
  // REFUSALS, over the real engine
  {
    const { bus } = await exchange(['H', 'A'], GAMES.kirby, { tamper: { peer: 'A', piece: 2, at: 60 } });
    const H = bus.engines[0];
    ok('tampered chunk: the engine ALONE installs the corrupted set without complaint (that is why the envelope exists)', !!H.cards && typeof H.cardSetHash === 'string');
    const e = await expectErr(() => R.verifySaveSet({ config: R.readRoomConfig(H.cards), set: H.cards, engineSetHash: H.cardSetHash }));
    ok('tampered chunk: verifySaveSet refuses it BY NAME (SAVE_TAMPERED_CHUNK, seat 2, a chunk number)', e.code === 'SAVE_TAMPERED_CHUNK' && e.detail.seat === 1 && Number.isInteger(e.detail.chunk), e.message);
    const g = bus.engines[1];
    const e2 = await expectErr(() => R.verifySaveSet({ config: R.readRoomConfig(g.cards), set: g.cards }));
    ok('tampered chunk: the guest that received the tampered piece refuses it the same way', e2.code === 'SAVE_TAMPERED_CHUNK');
  }
  {
    const { bus } = await exchange(['H', 'A'], GAMES.kirby, { forgeType: { seat: 1, code: 3 } });
    const e = await expectErr(() => R.verifySaveSet({ config: R.readRoomConfig(bus.host.cards), set: bus.host.cards }));
    ok('wrong save type: refused SAVE_WRONG_TYPE', e.code === 'SAVE_WRONG_TYPE', e.message);
  }
  {
    const { bus } = await exchange(['H', 'A'], GAMES.kirby, { forgeClaim: { seat: 1, claims: 0 } });
    const e = await expectErr(() => R.verifySaveSet({ config: R.readRoomConfig(bus.host.cards), set: bus.host.cards }));
    ok('duplicate seat claim: seat 2 claiming to be seat 1 is refused SAVE_DUPLICATE_SEAT', e.code === 'SAVE_DUPLICATE_SEAT', e.message);
  }
  {
    const ids = ['H', 'A', 'B'], cfg = cfgFor(GAMES.kirby, 3), bus = starBus(ids, R.lockstepOptions(cfg));
    seatAll(bus);
    bus.engines[0].contributeCards([await R.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: patternImage(0x8000, 1), config: cfg })]);
    bus.engines[1].contributeCards([await R.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw: patternImage(0x8000, 2) })]);
    ok('missing seat: the engine holds the room (no set) and names the silent seat', bus.engines[0].cards === null && JSON.stringify(bus.engines[0].cardsWaitingFor()) === '[{"port":2,"peer":"B"}]');
    const partial = { 0: (await R.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: patternImage(0x8000, 1), config: cfg })), 1: await R.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw: patternImage(0x8000, 2) }) };
    ok('missing seat: verifySaveSet refuses a 2-entry set for a 3-seat room (SAVE_MISSING_SEAT)', (await expectErr(() => R.verifySaveSet({ config: cfg, set: partial }))).code === 'SAVE_MISSING_SEAT');
  }
  {
    const ids = ['H', 'A'], cfg = cfgFor(GAMES.kirby, 2), bus = starBus(ids, R.lockstepOptions(cfg));
    seatAll(bus);
    const bad = await R.makeSaveEntry({ game: GAMES.sa3, seat: 1, raw: patternImage(0x10000, 3) });
    bus.engines[0].contributeCards([await R.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: patternImage(0x8000, 1), config: cfg })]);
    bus.engines[1].contributeCards([bad]);
    const e = await expectErr(() => R.verifySaveSet({ config: cfg, set: bus.host.cards }));
    ok('wrong size / type from a different game\'s battery: a 64 KiB flash image in a Kirby room is refused (SAVE_WRONG_TYPE)', e.code === 'SAVE_WRONG_TYPE', e.message);
  }
  // THE BARRIER NAMES EVERY MISMATCH
  section('barrier: every mismatch is refused BY NAME on the real engine (rom, core, seats, clock, saveType, version, ...)');
  const variants = [
    ['core', (c) => cfgFor(GAMES.kirby, 2, { coreBuildMd5: 'a'.repeat(32) }), 'ROOM_CORE'],
    ['seats', () => cfgFor(GAMES.kirby, 3), 'ROOM_SEATS'],
    ['clock (epoch)', () => cfgFor(GAMES.kirby, 2, { fixedEpochMs: 1700000009000 }), 'ROOM_CLOCK'],
    ['clock (zone)', () => cfgFor(GAMES.kirby, 2, { tzOffsetMin: 60 }), 'ROOM_CLOCK'],
    ['room id', () => cfgFor(GAMES.kirby, 2, { roomId: 'abcdefabcdefabcd' }), 'ROOM_ID'],
    ['game + rom + saveType', () => cfgFor(GAMES.sa3, 2), 'ROOM_SAVETYPE'],
    ['game + rom + saveType (rom)', () => cfgFor(GAMES.sa3, 2), 'ROOM_ROM'],
    ['version', () => 'VERSION', 'ROOM_VERSION'],
  ];
  const mine = cfgFor(GAMES.kirby, 2);
  for (const [name, mk, code] of variants) {
    const bus = starBus(['H', 'A'], R.lockstepOptions(mine));
    seatAll(bus);
    let failed = null; bus.host.on('barrier-failed', (x) => { failed = x; });
    const theirs = mk();
    const dA = theirs === 'VERSION' ? R.discString(mine, 'cafef00d').replace(/^gba1/, 'gba2') : R.discString(theirs, 'cafef00d');
    bus.engines[0].declareReady(R.discString(mine, 'cafef00d')); bus.engines[1].declareReady(dA);
    const ex = failed ? R.explainBarrierFailure(failed.expected, failed.discs) : [];
    ok(`barrier refuses a room whose peer differs in ${name}, and the refusal names ${code}`, !!failed && bus.host.state === 'failed' && ex.length === 1 && ex[0].peer === 'A' && ex[0].mismatches.some((m) => m.code === code && m.message.length > 20 && m.field), ex[0] ? ex[0].mismatches.map((m) => m.code).join('+') : 'no refusal');
  }
  {
    const bus = starBus(['H', 'A'], R.lockstepOptions(mine)); seatAll(bus);
    bus.engines[0].declareReady(R.discString(mine, 'cafef00d')); bus.engines[1].declareReady(R.discString(cfgFor(GAMES.kirby, 2, { inputDelay: 9, players: ['x', 'y'] }), 'cafef00d'));
    control('barrier control: a different input delay / player labels does NOT refuse the room (they are not folded)', bus.engines.every((e) => e.state === 'running'));
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// policy: the disconnect decision, with its numbers
// ---------------------------------------------------------------------------------------------------------------------------------
async function sectionPolicy() {
  section('policy: rsReplay ON / checkpoints OFF / rollback OFF - the evidence');
  ok('the in-band END channel rides only message types the star relays (lib/netplay.js RELAYED): input frames `ls` and fingerprints `lsh`', RELAYED.ls === 1 && RELAYED.lsh === 1);
  ok('room.js defines no message of its own (nothing to relay): no "t:" message literal and no send() call', !/\bt:\s*'/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')) && !/\bsend\s*\(/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  // replay == live, on real cores
  const game = GAMES.kirby, seats = 2, b = rom(R.TITLES[game].file);
  const cfg = cfgFor(game, seats), images = [patternImage(0x8000, 21), patternImage(0x8000, 22)];
  const mkm = () => R.bootMachine({ MgbaCore, config: cfg, rom: b, images, localSeat: 0, wasmBinary: WASM });
  const live = await mkm();
  const frames = 3000, img = new Uint8Array(4 * R.PAD_BYTES), log = [], chain = [];
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    const k0 = (f % 97) < 3 ? 8 : (f % 53) < 2 ? 1 : 0, k1 = (f % 89) < 3 ? 8 : (f % 61) < 2 ? 1 : 0;
    img.set(R.wordToBytes(R.encodeWord(k0, null)), 0); img.set(R.wordToBytes(R.encodeWord(k1, null)), 4);
    log.push(img.slice());
    live.step(img);
    if (f % 60 === 0) chain.push(live.fingerprint().words);
  }
  const liveMs = performance.now() - t0;
  const replay = await mkm(), rchain = [];
  const t1 = performance.now();
  for (let f = 0; f < frames; f++) { replay.step(log[f]); if (f % 60 === 0) rchain.push(replay.fingerprint().words); }
  const replayMs = performance.now() - t1;
  ok(`REPLAY == LIVE: a fresh machine fed the recorded input images reproduces all ${chain.length} per-seat + link fingerprints of a ${frames}-frame Kirby room`, JSON.stringify(chain) === JSON.stringify(rchain));
  const skip = await mkm(), schain = [];
  for (let f = 0; f < frames; f++) { if (f === 1500) continue; skip.step(log[f]); if (f % 60 === 0) schain.push(skip.fingerprint().words); }
  control('replay control: dropping ONE input image from the history diverges the chain (a replay is not a no-op)', JSON.stringify(chain) !== JSON.stringify(schain));
  info(`replay speed for this room: ${(frames / (replayMs / 1000)).toFixed(0)} frames/s (live loop here ${(frames / (liveMs / 1000)).toFixed(0)} frames/s, no pacing)`);
  live.close(); replay.close(); skip.close();
  // the capacity table that the decision rests on
  const load0 = cpuLoad();
  info(`machine load before the capacity table: Windows CPU busy ${load0}% (informational; not a load average; the user's own browser may be running)`);
  const rows = [['sbam', 2], ['kirby', 2], ['kirby', 3], ['kirby', 4], ['sa3', 2]];
  const fpsBy = {};
  for (const [k, n] of rows) {
    const g = GAMES[k], bytes = rom(R.TITLES[g].file), c = cfgFor(g, n);
    const m = await R.bootMachine({ MgbaCore, config: c, rom: bytes, images: Array.from({ length: n }, () => R.blankSave(g)), localSeat: 0, wasmBinary: WASM });
    const z = new Uint8Array(4 * R.PAD_BYTES);
    for (let i = 0; i < 600; i++) m.step(z);
    const N = 1500, t = performance.now();
    for (let i = 0; i < N; i++) m.step(z);
    const msPer = (performance.now() - t) / N;
    fpsBy[k + n] = 1000 / msPer;
    if (k === 'kirby' && n === 4) { const t3 = performance.now(); for (let i = 0; i < 100; i++) m.fingerprint(); info(`fingerprint (4 seats: 4 x hash(0x61000-byte state) + link): ${((performance.now() - t3) / 100).toFixed(2)} ms per call, once per ${R.HASH_EVERY} frames`); }
    m.close();
    const x = (1000 / msPer) / R.GBA_HZ, catchup = R.replayCost({ roomFrames: 107000, replayFps: 1000 / msPer });
    info(`${g} x${n} seats: ${msPer.toFixed(2)} ms/frame -> ${Math.round(1000 / msPer)} frames/s = ${x.toFixed(1)}x hardware; a 30-minute room (107,000 frames) is caught up in ${catchup.toFixed(0)} s (${(catchup / 60).toFixed(1)} min)`);
    ok(`${g} x${n}: replay capacity beats hardware (a returning page CAN catch up; ${x.toFixed(1)}x)`, x > 1.5);
  }
  info(`machine load after the capacity table: ${cpuLoad()}%`);
  ok('replayCost is the closed form roomFrames / (replayFps - 59.7275); Infinity when replay cannot outrun the room', Math.abs(R.replayCost({ roomFrames: 1000, replayFps: R.GBA_HZ + 100 }) - 10) < 1e-9 && R.replayCost({ roomFrames: 1000, replayFps: 59 }) === Infinity);
  // the host's input archive for a long room (lib/netplay.js _histArchive: 1 + portCount x padBytes bytes per frame)
  const stride = 1 + 4 * R.PAD_BYTES;
  info(`host input archive for replay: ${stride} bytes/frame (portCount 4 x padBytes ${R.PAD_BYTES} + mask) -> ${(stride * 107000 / 1048576).toFixed(2)} MiB per 30 minutes, ${(stride * 107000 * 4 / 1048576).toFixed(1)} MiB per 2 hours`);
  // checkpoints: the tripwire - a savestate-restored instance does not match a continuing one
  section('policy tripwire: restored-vs-continuing divergence (why checkpoints are OFF) - Sonic Advance 3, a ROOMABLE title, 2 linked seats');
  const sa = rom(R.TITLES[GAMES.sa3].file);
  const mk = async () => { const c = await MgbaCore.create({ seats: 2 }); c.setRtc({ fixedEpochMs: 1700000000000, tzOffsetMin: 0 }); c.loadRom(sa); return c; };
  const a = await mk(), keyAt = (i) => ((i % 97) < 3 ? 8 : (i % 53) < 2 ? 1 : 0);
  for (let i = 0; i < 900; i++) { a.setKeys(0, keyAt(i)); a.setKeys(1, keyAt(i + 7)); a.runFrame(); }
  const states = [a.saveState(0), a.saveState(1)];
  const rb = await mk(); rb.loadStates(states);
  let dh = 0, dg = 0, n = 0, vid = 0;
  for (let i = 900; i < 1500; i++) {
    for (const c of [a, rb]) { c.setKeys(0, keyAt(i)); c.setKeys(1, keyAt(i + 7)); c.runFrame(); }
    if (i % 20 === 0) { n++; if (a.hash(0) !== rb.hash(0)) dh++; if (a.hashGame(0) !== rb.hashGame(0)) dg++; }
    if (Buffer.compare(Buffer.from(a.video(0)), Buffer.from(rb.video(0))) !== 0) vid++;
  }
  info(`after loadStates at frame 900, 600 identical-input frames, ${n} samples: hash() differs ${dh}/${n}, hashGame() differs ${dg}/${n}, video frames differing ${vid}/600`);
  ok('TRIPWIRE: a restored instance diverges from a continuing one on Sonic Advance 3 (hashGame differs) - so checkpoints stay OFF; if this check ever FAILS the core got exact: revisit CHECKPOINT_POLICY', dg > 0 && R.CHECKPOINT_POLICY.enabled === false, `hashGame differs ${dg}/${n}`);
  a.close(); rb.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// e2e: real engines + real cores + room.js, end to end
// ---------------------------------------------------------------------------------------------------------------------------------
async function playRoom({ game, seats, images, frames, keysFor, wantAt, corruptMachine, hashCheck = true }) {
  const ids = ['H', 'A', 'B', 'C'].slice(0, seats);
  const cfg = cfgFor(game, seats);
  const bus = starBus(ids, R.lockstepOptions(cfg));
  seatAll(bus);
  const size = R.TITLES[game].saveBytes;
  for (let i = 0; i < seats; i++) bus.engines[i].contributeCards([await R.makeSaveEntry({ game, seat: i, raw: images[i] || new Uint8Array(0), config: i === 0 ? cfg : undefined })]);
  const romBytes = rom(R.TITLES[game].file), machines = [];
  let disc0 = null;
  for (let i = 0; i < seats; i++) {
    const e = bus.engines[i];
    const v = await R.verifySaveSet({ config: R.readRoomConfig(e.cards), set: e.cards, engineSetHash: e.cardSetHash });
    const imgs = (corruptMachine && corruptMachine.machine === i) ? v.images.map((x, s) => (s === corruptMachine.seat ? patternImage(size, 99) : x)) : v.images;
    machines.push(await R.bootMachine({ MgbaCore, config: v.config, rom: romBytes, images: imgs, localSeat: i, wasmBinary: WASM }));
    const disc = R.discString(cfg, v.setHash); if (!disc0) disc0 = disc;
    e.declareReady(disc);
  }
  const chain = machines.map(() => []), journals = machines.map(() => []), events = [];
  let guard = 0;
  while (guard++ < frames * 400) {
    let progressed = false;
    for (let i = 0; i < seats; i++) {
      const e = bus.engines[i], m = machines[i];
      if (e.state === 'desync' || e.state === 'failed') continue;
      if (wantAt !== undefined && m.frame >= wantAt) m.setWantEnd(true);
      const lp = m.localPad(keysFor(i, e.frame), e.frame);
      if (lp.journal) journals[i].push(lp.journal);
      const r = e.beginFrame(lp.pad);
      if (!r.ready) continue;
      const out = m.step(r.image);
      let h = null, w = null;
      if (hashCheck && e.wantsHash(r.frame)) { const fp = m.fingerprint(); h = fp.hash; w = fp.words; chain[i].push([r.frame, ...w]); }
      e.endFrame(h, w);
      progressed = true;
      if (out.event) events.push({ machine: i, ...out.event });
    }
    const minFrame = Math.min(...machines.map((m) => m.frame));
    if (machines.every((m) => m.end.phase === 'commit' || m.end.phase === 'unclean') || (wantAt === undefined && minFrame >= frames)) break;
    if (bus.engines.some((e) => e.state === 'desync' || e.state === 'failed')) break;
    if (!progressed) break;
  }
  return { bus, machines, chain, journals, events, cfg };
}

async function sectionE2E() {
  section('e2e: Super Bust-A-Move, 2 seats, two simulated peers (real engines in a star, real cores, scripted menu walk into the 1P-vs-2P battle)');
  const smoke = await import(pathToFileURL(path.join(ROOT, 'tools/gba_link_smoke.mjs')).href);
  const keys = keysByFrame(smoke.SBAM_SCRIPT, 2);
  const load0 = cpuLoad();
  const t0 = performance.now();
  const r = await playRoom({ game: GAMES.sbam, seats: 2, images: [new Uint8Array(0), new Uint8Array(0)], frames: keys.length + 60, wantAt: keys.length + 20, keysFor: (i, f) => (keys[f] ? keys[f][i] : 0) });
  const ms = performance.now() - t0;
  info(`${r.machines[0].frame} frames x 2 machines x 2 cores in ${(ms / 1000).toFixed(1)} s (unpaced; machine load ${load0}% -> ${cpuLoad()}%)`);
  const [a, b] = r.machines;
  ok('the engine reported NO desync and both machines ran the same number of frames', r.bus.engines.every((e) => e.state !== 'desync' && e.state !== 'failed') && a.frame === b.frame, `frames ${a.frame}/${b.frame}`);
  ok(`per-seat + link fingerprint chains are IDENTICAL on both peers (${r.chain[0].length} samples, every ${R.HASH_EVERY} frames, hash() strict)`, r.chain[0].length > 50 && JSON.stringify(r.chain[0]) === JSON.stringify(r.chain[1]));
  ok('both machines\' game cores are really LINKED (witnesses().linked, zero incidents) - not just equal', a.core.witnesses().linked && b.core.witnesses().linked && a.core.witnesses().incidents === 0 && b.core.witnesses().incidents === 0 && a.incidents === 0 && b.incidents === 0, `multi rounds ${a.core.witnesses().multiRounds}`);
  ok('the in-band END handshake ran inside the room: both machines agreed on F and committed at the same frame', a.end.phase === 'commit' && b.end.phase === 'commit' && a.end.F === b.end.F && a.end.G === b.end.G, `F ${a.end.F} G ${a.end.G}`);
  ok('a no-battery title writes nothing (skip: no-battery) on either peer', a.commitPlan({ key: 'sav' }).skip === 'no-battery' && b.commitPlan({ key: 'sav' }).skip === 'no-battery');
  // control: B's seat 1 muted differs -> chains differ (the chain is a real witness)
  const keys2 = keys.map((k) => [k[0], 0]);
  const m = await playRoom({ game: GAMES.sbam, seats: 2, images: [new Uint8Array(0), new Uint8Array(0)], frames: keys.length + 60, keysFor: (i, f) => (keys2[f] ? keys2[f][i] : 0) });
  const n2 = Math.min(m.chain[0].length, r.chain[0].length);
  control('e2e control: the same room with seat 1 MUTED gives a different chain (equality above is not vacuous), yet is still identical across its own two peers', JSON.stringify(m.chain[0].slice(0, n2)) !== JSON.stringify(r.chain[0].slice(0, n2)) && JSON.stringify(m.chain[0]) === JSON.stringify(m.chain[1]), `${n2} samples compared`);
  for (const mm of [...r.machines, ...m.machines]) mm.close();

  section('e2e: Kirby, 2 seats, DIFFERENT synced saves, 1500 frames, then a clean end that commits only the local seat');
  const imgs = [patternImage(0x8000, 31), patternImage(0x8000, 32)];
  const kk = await playRoom({ game: GAMES.kirby, seats: 2, images: imgs, frames: 1500, wantAt: 1500, keysFor: (i, f) => ((f + 31 * i) % 120) < 4 ? (i ? 1 : 8) : 0 });
  const [k0, k1] = kk.machines;
  ok('Kirby x2: no desync, identical chains', kk.bus.engines.every((e) => e.state !== 'desync' && e.state !== 'failed') && JSON.stringify(kk.chain[0]) === JSON.stringify(kk.chain[1]) && kk.chain[0].length > 20, `${kk.chain[0].length} samples`);
  ok('Kirby x2: both machines hold the same battery for BOTH seats at the agreed frame', k0.captured && k1.captured && k0.captured.hashes.join() === k1.captured.hashes.join(), k0.captured && k0.captured.hashes.join());
  ok('Kirby x2: the clean end committed on both', k0.end.phase === 'commit' && k1.end.phase === 'commit' && k0.end.F === k1.end.F);
  const p0 = k0.commitPlan({ key: 'sav', previous: imgs[0] }), p1 = k1.commitPlan({ key: 'sav', previous: imgs[1] });
  ok('Kirby x2: each peer\'s plan writes exactly its own seat\'s final image and backs up what was there', p0.writes.length <= 1 && p1.writes.length <= 1 && (p0.skip === 'unchanged' || Buffer.compare(Buffer.from(p0.writes[0].bytes), Buffer.from(k0.captured.images[0])) === 0) && (p1.skip === 'unchanged' || Buffer.compare(Buffer.from(p1.writes[0].bytes), Buffer.from(k1.captured.images[1])) === 0), `seat0 ${p0.skip || 'write'}, seat1 ${p1.skip || 'write'}`);
  // control: peer B boots a DIFFERENT image for seat 1 (it skipped verification) -> the engine's fingerprint compare catches it, naming the seat field
  const bad = await playRoom({ game: GAMES.kirby, seats: 2, images: imgs, frames: 900, keysFor: () => 0, corruptMachine: { machine: 1, seat: 1 } });
  const H = bad.bus.engines[0];
  const desync = H.desync || bad.bus.engines[1].desync;
  control('e2e control: a peer that installs a DIFFERENT image for one seat desyncs; the engine stops the room and names the diverged field', !!desync && bad.bus.engines.some((e) => e.state === 'desync'), desync ? `frame ${desync.frame}` : 'no desync reported');
  const det = bad.bus.engines.map((e) => e.desync && e.desync.fields).find((f) => f && f.length);
  control('...and the field is NAMED (seatN / link), not "w0"', !!det && /^(seat\d|link)$/.test(det[0].name), det ? det.map((x) => x.name).join(',') : 'no fields (details arrive on the next message)');
  for (const mm of [...kk.machines, ...bad.machines]) mm.close();

  section('e2e: Kirby 3 and 4 seats (3 and 4 machines, each simulating every seat), distinct saves, clean end');
  for (const n of [3, 4]) {
    const im = Array.from({ length: n }, (_, i) => patternImage(0x8000, 40 + i));
    const t = performance.now();
    const rr = await playRoom({ game: GAMES.kirby, seats: n, images: im, frames: 400, wantAt: 200, keysFor: (i, f) => ((f + 17 * i) % 90) < 3 ? 8 : 0 });
    ok(`Kirby x${n}: identical chains on all ${n} machines, no desync`, rr.bus.engines.every((e) => e.state !== 'desync' && e.state !== 'failed') && rr.chain.every((c) => JSON.stringify(c) === JSON.stringify(rr.chain[0])) && rr.chain[0].length >= 4, `${rr.chain[0].length} samples, ${((performance.now() - t) / 1000).toFixed(1)} s`);
    ok(`Kirby x${n}: all ${n} machines commit at the same frame; every machine holds every seat's identical image`, rr.machines.every((m) => m.end.phase === 'commit' && m.end.G === rr.machines[0].end.G) && rr.machines.every((m) => m.captured.hashes.join() === rr.machines[0].captured.hashes.join()));
    for (const mm of rr.machines) mm.close();
  }
  // a stall-free replay of a recorded room by a "returning page" is in the policy section; here: boot refusals
  section('boot: bootMachine refuses a ROM / core that is not the room\'s, by name');
  const cfg = cfgFor(GAMES.kirby, 2), kb = rom(R.TITLES[GAMES.kirby].file), imgs2 = [R.blankSave(GAMES.kirby), R.blankSave(GAMES.kirby)];
  const bad1 = await expectErr(() => R.bootMachine({ MgbaCore, config: cfg, rom: rom(R.TITLES[GAMES.sa3].file), images: imgs2, localSeat: 0, wasmBinary: WASM }));
  ok('a different ROM is refused ROOM_ROM before a core is created', bad1.code === 'ROOM_ROM');
  const wasm2 = Buffer.from(WASM); wasm2[wasm2.length - 1] ^= 1;      // a COPY: Buffer.slice() is a view and would corrupt WASM for the rest of the run
  const bad2 = await expectErr(() => R.bootMachine({ MgbaCore, config: cfg, rom: kb, images: imgs2, localSeat: 0, wasmBinary: wasm2 }));
  ok('a different emulator core (one byte off) is refused ROOM_CORE', bad2.code === 'ROOM_CORE');
  const bad3 = await expectErr(() => R.bootMachine({ MgbaCore, config: cfg, rom: kb, images: [R.blankSave(GAMES.kirby), new Uint8Array(100)], localSeat: 0, wasmBinary: WASM }));
  ok('an image of the wrong size for a seat is refused SAVE_BAD_SIZE', bad3.code === 'SAVE_BAD_SIZE');
  const good = await R.bootMachine({ MgbaCore, config: cfg, rom: kb, images: imgs2, localSeat: 1, wasmBinary: WASM });
  ok('...while the same boot with the right ROM, core and images succeeds', good.seats === 2 && good.localSeat === 1);
  ok('the pin is applied: every seat\'s cartridge clock starts at the room\'s fixed epoch', good.core.rtcUnix(0) === 1700000000 && good.core.rtcUnix(1) === 1700000000 && good.core.rtcWitness(0).pinned === true && good.core.rtcWitness(1).utcOffsetSec === -300 * 60, `rtcUnix ${good.core.rtcUnix(0)}, utcOffsetSec ${good.core.rtcWitness(1).utcOffsetSec}`);
  good.close();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// browser leg: room.js loaded as an ES module in headless Chrome (muted), the same answers as Node
// ---------------------------------------------------------------------------------------------------------------------------------
async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba/mgba/room.js`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}
async function sectionBrowser() {
  section('browser: room.js as an ES module in headless Chrome (bare CDP, --mute-audio, throwaway profile)');
  const srv = await ensureServer();
  try {
    const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
    await withBrowser({ port: 9254, width: 800, height: 600 }, async (page) => {
      await page.navigate(`http://localhost:${PORT}/contact.html`);
      const probe = `(async () => {
        const R = await import('/gba/mgba/room.js');
        const raw = new Uint8Array(0x8000); for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 3) & 255;
        const cfg = R.makeConfig({ game: 'Kirby Nightmare in Dreamland', seats: 2, coreBuildMd5: '${CORE_MD5}', fixedEpochMs: 1700000000000, tzOffsetMin: -300, roomId: '${ROOM_ID}' });
        const e0 = await R.makeSaveEntry({ game: 'Kirby Nightmare in Dreamland', seat: 0, raw: R.blankSave('Kirby Nightmare in Dreamland'), config: cfg });
        const e1 = await R.makeSaveEntry({ game: 'Kirby Nightmare in Dreamland', seat: 1, raw });
        const v = await R.verifySaveSet({ config: cfg, set: { 0: e0, 1: e1 } });
        const t = e1.bytes.slice(); t[t.length - 3] ^= 1;
        let tam = null; try { await R.verifySaveEntry({ config: cfg, port: 1, entry: Object.assign({}, e1, { bytes: t }) }); } catch (e) { tam = e.code; }
        return JSON.stringify({ md5: R.md5(new TextEncoder().encode('abc')), card: R.cardHash(raw), setHash: v.setHash, disc: R.discString(cfg, v.setHash), gz0: e0.enc, gzLen0: e0.bytes.length, enc1: e1.enc, tam,
          img1: R.cardHash(v.images[1]), noDom: typeof document, cs: typeof CompressionStream, ds: typeof DecompressionStream, secure: self.isSecureContext });
      })()`;
      const b = JSON.parse(await page.eval(probe));
      const raw = new Uint8Array(0x8000); for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 3) & 255;
      const cfg = R.makeConfig({ game: GAMES.kirby, seats: 2, coreBuildMd5: CORE_MD5, fixedEpochMs: 1700000000000, tzOffsetMin: -300, roomId: ROOM_ID });
      const e0 = await R.makeSaveEntry({ game: GAMES.kirby, seat: 0, raw: R.blankSave(GAMES.kirby), config: cfg }), e1 = await R.makeSaveEntry({ game: GAMES.kirby, seat: 1, raw });
      const v = await R.verifySaveSet({ config: cfg, set: { 0: e0, 1: e1 } });
      ok('Chrome: the module imports (ES module over HTTP) and the page has CompressionStream / DecompressionStream', b.cs === 'function' && b.ds === 'function');
      ok('Chrome == Node: md5, cardHash, the agreed set fingerprint and the disc string are identical', b.md5 === '900150983cd24fb0d6963f7d28e17f72' && b.card === R.cardHash(raw) && b.setHash === v.setHash && b.disc === R.discString(cfg, v.setHash), b.disc);
      ok('Chrome: a gzip-compressed blank save is produced by the browser\'s own CompressionStream and verifies (only the RAW hash is compared, so deflate output may differ between engines)', b.gz0 === 'gba1;gzip' && b.gzLen0 < 2000 && b.img1 === R.cardHash(raw), `browser envelope ${b.gzLen0} B, node envelope ${e0.bytes.length} B`);
      control('Chrome: a tampered envelope is refused by name there too', b.tam === 'SAVE_TAMPERED_CHUNK', String(b.tam));
      const errs = page.errors.filter((e) => !/favicon.ico/.test(e));          // the host page has no favicon; that 404 is the harness, not the module
      ok('the page console showed no errors (other than the favicon 404)', errs.length === 0, errs.join(' | ').slice(0, 200));
    });
  } finally { srv.stop(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
async function main() {
  console.log(`gba_room_protocol_test: room.js ${md5hex(Buffer.from(SRC)).slice(0, 8)} (${SRC.split('\n').length} lines), protocol ${R.PROTOCOL_VERSION}, core ${CORE_MD5.slice(0, 8)}, Node ${process.version}`);
  let real = null;
  if (want('module')) await sectionModule();
  if (want('tables')) await sectionTables();
  if (want('battery') || want('mutants')) real = await sectionBattery();
  if (want('mutants')) await sectionMutants(real);
  if (want('equivalent')) await sectionEquivalent();
  if (want('sweep')) await sectionSweep();
  if (want('docs')) await sectionDocs();
  if (want('cards')) await sectionCards();
  if (!FAST && want('tables-live')) await sectionTablesLive();
  if (!FAST && want('frames')) await sectionFrames();
  if (!FAST && want('policy')) await sectionPolicy();
  if (!FAST && want('e2e')) await sectionE2E();
  if (flag('--browser') && want('browser')) await sectionBrowser();
  if (flag('--campaign')) await sectionCampaign();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
