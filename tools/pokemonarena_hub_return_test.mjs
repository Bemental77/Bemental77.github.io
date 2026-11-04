// tools/pokemonarena_hub_return_test.mjs -- COMING BACK TO THE HUB IS NOT A LOADING SCREEN (pokemonarena/js/romcache.js, romfetch.js, boot.js, arena.css).
//
//   node tools/pokemonarena_hub_return_test.mjs               node units, then real Chrome (hub, battle page) through the dev server and a small caching proxy
//   node tools/pokemonarena_hub_return_test.mjs --units       the node units only (no browser)
//   node tools/pokemonarena_hub_return_test.mjs --mutants     ALSO break the source one way at a time (modules and pages); every break must fail a named case
//   node tools/pokemonarena_hub_return_test.mjs --mutant=<text>   ONLY the page mutants whose id contains <text> (ARENA_VERBOSE=1 shows every case, passing ones too)
//   node tools/pokemonarena_hub_return_test.mjs warm reduced   only the named browser groups (warm earlykey reduced noscript corrupt bad blocked battle bfcache)
//   env: ARENA_PORT (dev server, 8297; the caching proxy is PORT+1), ARENA_CDP (9483, +1 per browser, 10 used), ARENA_OVERLAY_PORT (8337), ARENA_OUT (screenshots), ARENA_SKIP_SHOTS=1
//
// THE PROBLEM. Every Arena page loads the 32 MiB SoulGold image, so "back to the hub" was: a loading panel, a 32 MB download (or a lucky HTTP-cache hit), a SHA-256 of all of it, the decode,
// the hub. THE FIX (all of it in the page's own code, nothing from the ROM committed): a verified copy is kept in the browser's Cache Storage (romcache.js) and read back on the next visit;
// the loading panel is revealed only after 400 ms (by the stylesheet AND by a tiny INLINE timer in index.html, which runs before the page's module graph has loaded -- boot.js is not part of that
// first reveal and only shows the panel at once on Try again: "prefers-reduced-motion: reduce" switches every CSS animation off, and a visitor with it on used to see an empty page for the whole
// first download -- cases R*, which emulate it); the ROM starts loading before the page's modules have finished; the SHA-256 of a recalled copy is re-checked
// right AFTER the first frame (a mismatch drops the copy and reloads once through the full path; a copy so damaged INSIDE that the menu cannot be built is hashed at once and recovered the
// same way -- cases C3/C4). NOT done, and why: painting the last hub picture from first paint -- see README "Coming back to the hub".
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, throwaway profile, --mute-audio). A "warm return" is a second navigation in the SAME browser (the same profile and Cache Storage).
//
// THE RETURN CASES DO NOT DEPEND ON HOW FAST THIS MACHINE IS (contract(), below). The panel is revealed 400 ms after the page starts, so "a return shows no panel" is a statement about a return
// that is up inside 400 ms, and a return that load slows past it is, correctly, shown the panel. Every return is therefore judged by what it did relative to ITS OWN first-hub time: one that was
// up before the reveal must have shown 0 panel frames and written nothing to the live region; a slower one may show the panel for at most (its first-hub time - the reveal + one frame); and none
// may leave "Loading the game file" in the live region once the hub is up (each page is kept alive to 700 ms before it is judged, so a timer that fires AFTER the hub is up is seen).
// Mutants prove each judgement can fail (W4/W4b/R2/R2d/R3c: the reveal at once, the page's own reveal ignoring the 400 ms, the inline timer not looking at the page state).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const args = process.argv.slice(2);
const ONLY_MUTANT = (args.find((a) => a.startsWith('--mutant=')) || '').slice(9);        // --mutant=<text>: ONLY the page mutants whose id contains the text (to look at one closely; with ARENA_VERBOSE=1)
const UNITS_ONLY = args.includes('--units'), WANT_MUTANTS = args.includes('--mutants') || !!ONLY_MUTANT;
const PORT = Number(process.env.ARENA_PORT || 8297), PROXY = PORT + 1, CDP0 = Number(process.env.ARENA_CDP || 9483), OVL = Number(process.env.ARENA_OVERLAY_PORT || 8337);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-hub-return-shots');
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';
const ROM_PATH = path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
fs.mkdirSync(OUT, { recursive: true });

// A stored copy that is "header-valid but corrupt INSIDE": the right length and a good cartridge header (so romcache.js trusts it), with 4 KiB of 0xFF over the start of the MOVES table (tables.js
// LAYOUT.moves.offset). loadPack() then throws "moves: bad ROM pointer 0xffffffff" -- the menu cannot even be built. U14 proves both halves in Node (and that this constant still points at the table).
const BODY_HIT = { offset: 0x769860, length: 4096 };

let pass = 0, fail = 0, sink = null;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { if (!sink) pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name, detail ? ':: ' + String(detail).slice(0, 160) : ''); return; }
  if (sink) { sink.push(name + (detail ? ' :: ' + detail : '')); return; }
  fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || '');
}

/* =============================================================================================== 1. node units: the stored copy */
const ROM = new Uint8Array(fs.readFileSync(ROM_PATH));

function fakeCaches({ failOpen = false, failPut = false } = {}) {
  const stores = new Map();
  const api = {
    opens: 0, _stores: stores,
    async open(name) {
      api.opens++;
      if (failOpen) throw new Error('blocked');
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(k) { if (!m.has(k)) return undefined; const e = m.get(k); return new Response(e.body, { headers: e.headers }); },
        async put(k, res) { if (failPut) throw new Error('quota'); const body = new Uint8Array(await res.arrayBuffer()); const headers = {}; res.headers.forEach((v, kk) => { headers[kk] = v; }); m.set(k, { body, headers }); },
        async delete(k) { return m.delete(k); },
        async keys() { return [...m.keys()]; },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  return api;
}
const fakeResponse = (bytes) => ({ ok: true, status: 200, headers: { get: () => String(bytes.length) }, body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

async function units(M, tag) {
  const T = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const { C, F, R, T: TB } = M;     // TB = tables.js (T below is the case-name tagger)
  const PIN = R.PINNED;
  const entry = (caches) => (caches._stores.get(C.CACHE_NAME) || new Map()).get(C.CACHE_KEY);
  const raw = async (caches, { body = ROM, headers = {} } = {}) => {
    const cache = await caches.open(C.CACHE_NAME);
    await cache.put(C.CACHE_KEY, new Response(body, { headers: { 'x-arena-sha256': PIN.sha256, 'x-arena-length': String(PIN.length), 'x-arena-rev': String(C.ROMCACHE_REV), ...headers } }));
  };
  const bytesWith = (fn) => { const b = ROM.slice(); fn(b); return b; };

  {
    const caches = fakeCaches();
    ok((await C.readCachedRom({ caches })) === null, T('U1 an empty cache is a miss'), '');
    ok((await C.writeCachedRom(ROM, { caches })) === true, T('U2 a verified ROM is stored'), '');
    const r = await C.readCachedRom({ caches });
    ok(r && r.bytes.length === PIN.length && r.sha256 === PIN.sha256 && r.bytes[0x1234] === ROM[0x1234], T('U2b and read back byte for byte, with the pin it was stored under'), '');
    ok(C.CACHE_KEY.includes(PIN.sha256) && C.CACHE_NAME === C.CACHE_PREFIX + C.ROMCACHE_REV, T('U2c the key contains the pin and the name the revision (a different ROM or format is a different entry)'), C.CACHE_KEY);
  }
  {
    const bad = [
      ['another pin in the header', { headers: { 'x-arena-sha256': 'f'.repeat(64) } }],
      ['another length in the header', { headers: { 'x-arena-length': String(PIN.length - 1) } }],
      ['another revision', { headers: { 'x-arena-rev': '0' } }],
      ['no pin header', { headers: { 'x-arena-sha256': '' } }],
      ['a body one byte short', { body: ROM.subarray(0, PIN.length - 1) }],
      ['a body one byte long', { body: new Uint8Array([...ROM.subarray(0, 64), ...new Uint8Array(PIN.length - 64 + 1)]) }],
      ['a body that is not this cartridge (zeros, right length)', { body: new Uint8Array(PIN.length) }],
      ['a body with the wrong game code', { body: bytesWith((b) => { b[0xAC] = 0x58; }) }],
    ];
    let trusted = [], kept = [];
    for (const [name, spec] of bad) {
      const caches = fakeCaches();
      await raw(caches, spec);
      const r = await C.readCachedRom({ caches });
      if (r !== null) trusted.push(name);
      if (entry(caches)) kept.push(name);
    }
    ok(trusted.length === 0, T('U3 an entry that does not name the pin / length / revision, or whose body is not this cartridge, is a miss (' + bad.length + ' kinds)'), trusted.join(', '));
    ok(kept.length === 0, T('U3b and a bad entry is deleted, not left to be tried again'), kept.join(', '));
  }
  {
    const caches = fakeCaches();
    const no = [await C.writeCachedRom('x', { caches }), await C.writeCachedRom(new Uint8Array(10), { caches }), await C.writeCachedRom(ROM, { caches: null }), await C.writeCachedRom(ROM, { caches: fakeCaches({ failPut: true }) }), await C.writeCachedRom(ROM, { caches: fakeCaches({ failOpen: true }) })];
    ok(no.every((x) => x === false) && !entry(caches), T('U4 nothing is stored for a non-ROM, a short buffer, no Cache Storage, a full quota or a blocked store (false, never a throw)'), J(no));
    ok((await C.readCachedRom({ caches: fakeCaches({ failOpen: true }) })) === null && (await C.readCachedRom({ caches: null })) === null && (await C.dropCachedRom({ caches: null })) === false, T('U4b reading from a blocked or missing store is a miss'), '');
    // the browser's own `caches` THROWS when it is read (site data blocked: a SecurityError): the default lookup must treat that as a miss too
    Object.defineProperty(globalThis, 'caches', { get() { throw new Error('SecurityError: blocked'); }, configurable: true });
    let threw = false, out = null;
    try { out = [await C.readCachedRom(), await C.writeCachedRom(ROM), await C.dropCachedRom(), (await F.loadVerifiedRom({ fetchImpl: async () => fakeResponse(ROM), persist: true })).cached]; } catch (e) { threw = e; }
    delete globalThis.caches;
    ok(!threw && J(out) === J([null, false, false, false]), T('U4c a `caches` that throws when READ (site data blocked) is a miss for read, write and drop, and the load goes to the network'), String(threw && threw.message) + ' ' + J(out));
  }
  {
    const caches = fakeCaches();
    caches._stores.set(C.CACHE_PREFIX + '0', new Map([['x', 1]])); caches._stores.set(C.CACHE_PREFIX + '99', new Map([['x', 1]])); caches._stores.set('something-else', new Map([['x', 1]]));
    await C.writeCachedRom(ROM, { caches });
    const names = [...caches._stores.keys()].sort();
    ok(J(names) === J([C.CACHE_NAME, 'something-else'].sort()), T('U5 storing a copy removes every other revision of this cache (32 MB each) and nothing that is not ours'), J(names));
  }
  {
    // the cache NAME holds only the revision; the PIN is in the KEY. A ROM pinned differently under the same revision would otherwise sit beside the new copy for good (32 MB each).
    const caches = fakeCaches();
    const oldKey = C.KEY_PREFIX + 'f'.repeat(64), foreign = '/something/else';
    await raw(caches); // the current pin's entry, so the cache exists
    const m = caches._stores.get(C.CACHE_NAME);
    m.set(oldKey, { body: new Uint8Array(1024), headers: {} }); m.set(foreign, { body: new Uint8Array(8), headers: {} });
    ok(await C.writeCachedRom(ROM, { caches }), T('U5b the write that follows succeeds'), '');
    const left = [...m.keys()].sort();
    ok(J(left) === J([C.CACHE_KEY, foreign].sort()), T('U5b storing a copy removes a copy of a previously pinned ROM from the same cache (another pin in the key), and keeps a key that is not ours'), J(left));
    const r = await C.readCachedRom({ caches });
    ok(r && r.bytes[0x1234] === ROM[0x1234], T('U5c and what is left reads back'), '');
  }
  {
    // romfetch: the stored copy is used by real pages only
    const caches = fakeCaches();
    let fetches = 0, hashes = 0;
    const fetchImpl = async () => { fetches++; return fakeResponse(ROM); };
    const hasher = async (b) => { hashes++; return R.sha256HexFast(b); };
    await F.loadVerifiedRom({ fetchImpl, hasher, caches });
    ok(caches.opens === 0, T('U6 a caller that injects its own fetch (every test) never touches Cache Storage by default'), String(caches.opens));
    const first = await F.loadVerifiedRom({ fetchImpl, hasher, caches, persist: true });
    await sleep(50);
    ok(first.cached === false && first.sha256 === PIN.sha256 && fetches === 2 && !!entry(caches), T('U7 a downloaded ROM is verified, returned, and then stored'), J({ fetches, cached: first.cached, stored: !!entry(caches) }));
    const hBefore = hashes;
    const second = await F.loadVerifiedRom({ fetchImpl, hasher, caches, persist: true });
    ok(second.cached === true && fetches === 2 && second.sha256 === PIN.sha256 && second.bytes.length === PIN.length && hashes === hBefore + 1, T('U8 the next visit recalls it: no download, still fully verified (one hash)'), J({ fetches, cached: second.cached, hashes: hashes - hBefore }));
    ok((await second.verified).sha256 === PIN.sha256, T('U8b `verified` is resolved'), '');
    let seen = null; await F.loadVerifiedRom({ fetchImpl, hasher, caches, persist: true, onProgress: (a, b) => { seen = [a, b]; } });
    ok(seen && seen[0] === PIN.length && seen[1] === PIN.length, T('U9 a recalled copy reports full progress at once'), J(seen));
  }
  {
    const caches = fakeCaches();
    let fetches = 0, hashes = 0;
    const fetchImpl = async () => { fetches++; return fakeResponse(ROM); };
    const hasher = async (b) => { hashes++; return R.sha256HexFast(b); };
    await C.writeCachedRom(ROM, { caches });
    const d = await F.loadVerifiedRom({ fetchImpl, hasher, caches, persist: true, deferVerify: true });
    ok(d.cached === true && typeof d.verify === 'function' && d.verified === undefined && hashes === 0 && fetches === 0, T('U10 deferVerify: a recalled copy comes back at once, un-hashed, with verify() instead of verified'), J({ hashes, fetches, keys: Object.keys(d) }));
    await new Promise((r) => setTimeout(r, 30));
    ok(hashes === 0, T('U10b and nothing hashes it until the caller says so (hashing copies 32 MB on the calling thread: the first frame must not wait for that)'), String(hashes));
    const v = await d.verify();
    ok(v.sha256 === PIN.sha256 && hashes === 1, T('U10c verify() runs the full check'), String(hashes));
    // a downloaded ROM is never deferred
    const w = await F.loadVerifiedRom({ fetchImpl, hasher, caches: fakeCaches(), persist: true, deferVerify: true });
    ok(w.cached === false && w.verified && !w.verify, T('U10d a freshly downloaded ROM is always verified before it is returned'), J(Object.keys(w)));
  }
  {
    // a stored copy that is the right size and header but corrupted inside
    const flipped = bytesWith((b) => { b[0x1000000] ^= 0xff; });
    let caches = fakeCaches(); let fetches = 0;
    const fetchImpl = async () => { fetches++; return fakeResponse(ROM); };
    await raw(caches, { body: flipped });
    const d = await F.loadVerifiedRom({ fetchImpl, caches, persist: true, deferVerify: true });
    let kind = null; try { await d.verify(); } catch (e) { kind = e && e.kind; }
    ok(d.cached === true && kind === 'hash', T('U11 a copy corrupted inside is trusted for the first frame, and the re-check rejects it as a hash mismatch'), kind);
    ok(!entry(caches) && (await C.readCachedRom({ caches })) === null, T('U11b and the corrupt copy is gone'), '');
    caches = fakeCaches(); fetches = 0;
    await raw(caches, { body: flipped });
    const n = await F.loadVerifiedRom({ fetchImpl, caches, persist: true });
    await sleep(50);
    ok(n.cached === false && fetches === 1 && n.sha256 === PIN.sha256 && entry(caches) && entry(caches).body[0x1000000] === ROM[0x1000000], T('U12 without deferVerify a corrupt copy is caught before it is returned: the page goes to the network and the good ROM replaces it'), J({ fetches, cached: n.cached }));
  }
  {
    // a bad ROM from the network is never stored
    const caches = fakeCaches();
    const badBytes = bytesWith((b) => { b[0x1F00000] ^= 1; });
    let kind = null; try { await F.loadVerifiedRom({ fetchImpl: async () => fakeResponse(badBytes), caches, persist: true }); } catch (e) { kind = e && e.kind; }
    await sleep(50);
    ok(kind === 'hash' && !entry(caches), T('U13 a ROM that fails verification is refused and NOT stored'), J({ kind, stored: !!entry(caches) }));
    const zeros = new Uint8Array(PIN.length); kind = null;
    try { await F.loadVerifiedRom({ fetchImpl: async () => fakeResponse(zeros), caches, persist: true }); } catch (e) { kind = e && e.kind; }
    await sleep(30);
    ok(kind === 'format' && !entry(caches), T('U13b a file that is not the cartridge at all is refused by name and not stored'), String(kind));
    let k2 = null; try { await F.loadVerifiedRom({ fetchImpl: async () => { throw new Error('offline'); }, caches, persist: true }); } catch (e) { k2 = e && e.kind; }
    ok(k2 === 'missing', T('U13c a missing ROM with an empty cache is still the "missing" error screen'), String(k2));
  }
  {
    // A stored copy that is header-valid but corrupt INSIDE a table (BODY_HIT): the shape romcache.js cannot see (it checks length, headers and the cartridge header only). The hub's start() used to
    // die on it with no way out; it now hashes the copy on the spot (boot.js, cases C3/C4). These are the Node-checkable halves of that: the copy IS trusted by the cache, the menu CANNOT be built
    // from it, and verify() is what finds out and drops it.
    ok(TB.LAYOUT.moves.offset === BODY_HIT.offset, T('U14 BODY_HIT still points at the start of the moves table (tables.js LAYOUT)'), '0x' + TB.LAYOUT.moves.offset.toString(16));
    const hurt = bytesWith((b) => b.fill(0xff, BODY_HIT.offset, BODY_HIT.offset + BODY_HIT.length));
    const caches = fakeCaches(); let fetches = 0;
    const fetchImpl = async () => { fetches++; return fakeResponse(ROM); };
    await raw(caches, { body: hurt });
    let built = null; try { TB.loadPack(hurt, { verify: 'header', dexText: false }); } catch (e) { built = e; }
    const d = await F.loadVerifiedRom({ fetchImpl, caches, persist: true, deferVerify: true });
    ok(d.cached === true && fetches === 0 && built && /bad ROM pointer/.test(built.message), T('U14b a copy corrupt inside a table passes the cache\'s cheap checks (cached, no download) yet loadPack() throws on it: the case start() must recover from'), String(built && built.message).slice(0, 80));
    let kind = null; try { await d.verify(); } catch (e) { kind = e && e.kind; }
    ok(kind === 'hash' && !entry(caches) && (await C.readCachedRom({ caches })) === null, T('U14c and verify() rejects it as a hash mismatch and drops the stored copy, so the next load goes through the full path'), String(kind));
  }
}

/* ------------------------------------------------------------------------------------------------ module mutants */
const MODULE_MUTANTS = [
  { id: 'read-ignores-pin-header', file: 'romcache.js', from: "if (sha !== PINNED.sha256 || len !== PINNED.length || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }", to: "if (len !== PINNED.length || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }" },
  { id: 'read-ignores-length-header', file: 'romcache.js', from: "if (sha !== PINNED.sha256 || len !== PINNED.length || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }", to: "if (sha !== PINNED.sha256 || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }" },
  { id: 'read-ignores-revision', file: 'romcache.js', from: "if (sha !== PINNED.sha256 || len !== PINNED.length || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }", to: "if (sha !== PINNED.sha256 || len !== PINNED.length) { await drop(cache); return null; }" },
  { id: 'read-skips-body-validation', file: 'romcache.js', from: "if (bytes.length !== PINNED.length || !identify(bytes, { hash: 'none' }).ok) { await drop(cache); return null; }", to: '' },
  { id: 'read-ignores-cartridge-header', file: 'romcache.js', from: 'if (bytes.length !== PINNED.length || !identify(bytes, { hash: \'none\' }).ok) { await drop(cache); return null; }', to: 'if (bytes.length !== PINNED.length) { await drop(cache); return null; }' },
  { id: 'bad-entry-kept', file: 'romcache.js', from: 'async function drop(cache) { try { await cache.delete(CACHE_KEY); } catch (_e) { /* ignore */ } }', to: 'async function drop(cache) { /* kept */ }' },
  { id: 'write-accepts-any-length', file: 'romcache.js', from: "if (!caches || !(bytes instanceof Uint8Array) || bytes.length !== PINNED.length) return false;", to: "if (!caches) return false;" },
  { id: 'write-keeps-old-revisions', file: 'romcache.js', from: "if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) {", to: "if (false) {" },
  { id: 'write-keeps-old-pins', file: 'romcache.js', from: "if (p.startsWith(KEY_PREFIX) && p !== CACHE_KEY) {", to: "if (false) {" },
  { id: 'write-deletes-keys-that-are-not-ours', file: 'romcache.js', from: "if (p.startsWith(KEY_PREFIX) && p !== CACHE_KEY) {", to: "if (p !== CACHE_KEY) {" },
  { id: 'blocked-getter-throws', file: 'romcache.js', from: '    return c && typeof c.open === \'function\' ? c : null;\n  } catch (_e) { return null; }', to: '    return c && typeof c.open === \'function\' ? c : null;\n  } finally { /* nothing */ }' },
  { id: 'write-throws', file: 'romcache.js', from: "  } catch (_e) { return false; }        // quota, blocked, private mode: the next visit simply downloads again", to: "  } finally { /* nothing */ }" },
  { id: 'persist-even-when-injected', file: 'romfetch.js', from: "(opts.fetchImpl === undefined && opts.hasher === undefined)", to: "true" },
  { id: 'store-before-verify', file: 'romfetch.js', from: "  const { sha256 } = await verifyRom(bytes, opts.hasher);\n  if (persist) writeCachedRom(bytes, opts).catch(() => { /* a copy that could not be kept costs the next visit a download, nothing else */ });", to: "  if (persist) writeCachedRom(bytes, opts).catch(() => {});\n  const { sha256 } = await verifyRom(bytes, opts.hasher);" },
  { id: 'defer-verifies-at-once', file: 'romfetch.js', from: "if (opts.deferVerify) return { bytes: hit.bytes, sha256: hit.sha256, cached: true, verify: check };", to: "if (opts.deferVerify) { await check(); return { bytes: hit.bytes, sha256: hit.sha256, cached: true, verify: check }; }" },
  { id: 'failed-check-keeps-the-copy', file: 'romfetch.js', from: "catch (e) { await dropCachedRom(opts); throw e; }", to: "catch (e) { throw e; }" },
  { id: 'recalled-copy-never-hashed', file: 'romfetch.js', from: "const check = async () => { try { return await verifyRom(hit.bytes, opts.hasher); }", to: "const check = async () => { try { return { sha256: hit.sha256 }; }" },
  { id: 'recalled-copy-silent', file: 'romfetch.js', from: "if (opts.onProgress) opts.onProgress(PINNED.length, PINNED.length);", to: "" },
  { id: 'cache-never-read', file: 'romfetch.js', from: "const hit = await readCachedRom(opts);", to: "const hit = null;" },
];
async function loadModules(dir) {
  const q = '?x=' + Math.random().toString(36).slice(2);
  const [C, F, R, T] = await Promise.all(['romcache.js', 'romfetch.js', 'rom.js', 'tables.js'].map((f) => import(pathToFileURL(path.join(dir, f)).href + q)));
  return { C, F, R, T };
}
async function runModuleMutants() {
  const out = [];
  for (const mu of MODULE_MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-return-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile() && f.endsWith('.js')) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file), text = fs.readFileSync(target, 'utf8');
      const n = text.split(mu.from).length - 1;
      if (n !== 1) { out.push({ id: mu.id, killed: false, why: 'PATTERN FOUND ' + n + 'x' }); continue; }
      fs.writeFileSync(target, text.replace(mu.from, () => mu.to));
      const before = fail; const keep = sink; sink = []; let threw = null;
      try { const M = await loadModules(dir); await units(M, mu.id); } catch (e) { threw = e; }
      const caught = sink.length > 0 || !!threw; sink = keep; fail = before;
      out.push({ id: mu.id, killed: caught });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* =============================================================================================== 2. real Chrome */
let server = null;
async function startServer() {
  const probe = async () => { try { return (await fetch(`http://localhost:${PORT}/pokemonarena/`)).ok; } catch (_e) { return false; } };
  if (await probe()) return false;
  server = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT), WEB_ROOT: root }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && !(await probe()); i++) await sleep(250);
  return true;
}
// a proxy in front of the dev server: makes every response cacheable (the dev server says no-store, which also keeps pages out of the back/forward cache), and can serve a BAD ROM
const proxyState = { badRom: false, cacheable: true };
let proxy = null;
async function startProxy() {
  proxy = http.createServer(async (req, res) => {
    try {
      const headers = { ...req.headers }; delete headers.host; delete headers['if-none-match']; delete headers['if-modified-since'];
      if (proxyState.badRom && /\.gba/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(ROM.length) }); res.end(Buffer.alloc(ROM.length)); return; }
      const r = await fetch(`http://localhost:${PORT}${req.url}`, { method: req.method, headers });
      const out = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
      if (proxyState.cacheable) out['cache-control'] = 'public, max-age=3600';
      res.writeHead(r.status, out);
      if (!r.body) return res.end();
      const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; if (!res.write(Buffer.from(value))) await new Promise((k) => res.once('drain', k)); }
      res.end();
    } catch (e) { try { res.writeHead(502); res.end(String(e)); } catch (_e) { /* gone */ } }
  });
  await new Promise((k) => proxy.listen(PROXY, '127.0.0.1', k));
}

// what is recorded from document start: every animation frame's view of the loading panel, the first hub frame, load count, pageshow
const RECORDER = `(() => {
  // anim / reduce: what the stylesheet's own reveal animation resolves to on the first frame of a boot-state page, and whether the page sees prefers-reduced-motion (the arm-difference proof of the R cases);
  // live: the first text the persistent #live region gets while the page is in state boot (what a screen reader is told), liveAt: when it was first seen;
  // liveLog: EVERY change of that region's text in ANY state, as [ms, state, text] (a message written after the hub is up is the thing the first two cannot see)
  const rec = window.__rec = { frames: [], panelFrames: 0, linkFrames: 0, maxBar: 0, firstHub: null, shows: [], anim: null, reduce: null, live: null, liveAt: null, liveLog: [] };
  let lastLive = '';
  try { sessionStorage.setItem('__loads', String((Number(sessionStorage.getItem('__loads')) || 0) + 1)); } catch (e) {}
  const vis = (el) => { if (!el || el.hidden) return false; const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0 && r.height > 0; };
  const tick = () => {
    const b = document.getElementById('boot'), bar = document.getElementById('bar'), v = vis(b);
    if (document.body) { rec.frames.push([Math.round(performance.now()), v ? 1 : 0, document.body.dataset.state]); if (v) rec.panelFrames++;
      if (document.body.dataset.state === 'boot') { if (b && rec.anim === null) { rec.anim = getComputedStyle(b).animationName; rec.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } const lv = document.getElementById('live'); if (lv && lv.textContent && rec.live === null) { rec.live = lv.textContent; rec.liveAt = Math.round(performance.now()); } } const lv2 = document.getElementById('live'); const lt = lv2 ? lv2.textContent : ''; if (lt !== lastLive) { lastLive = lt; rec.liveLog.push([Math.round(performance.now()), document.body.dataset.state, lt]); } const link = document.getElementById('onlineLink'); if (document.body.dataset.state === 'boot' && link && getComputedStyle(link).visibility !== 'hidden') rec.linkFrames++; if (bar && +bar.value > rec.maxBar) rec.maxBar = +bar.value; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const orig = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function () { if (rec.firstHub === null && this.canvas.id === 'hub') rec.firstHub = Math.round(performance.now()); return orig.apply(this, arguments); };
  window.addEventListener('pageshow', (e) => { rec.shows.push(e.persisted ? 'persisted' : 'fresh'); });
})();`;
const BLOCK_CACHES = `Object.defineProperty(window, 'caches', { get() { throw new DOMException('blocked', 'SecurityError'); }, configurable: true });`;

async function newPage(page, { script = '' } = {}) {
  const ctr = { rom: 0, urls: [] };
  await page.send('Network.enable');
  page.handlers.push((m) => { if (m.method === 'Network.requestWillBeSent' && /\.gba(\?|$)/.test(m.params.request.url)) { ctr.rom++; ctr.urls.push(m.params.request.url.slice(-30)); } });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER + script });
  return ctr;
}
const visit = async (page, url, state = 'ready', ms = 90000) => { await page.navigate(url, { waitMs: 60000 }); await page.waitFor(`window.__arenaHub && window.__arenaHub.state === ${J(state)}`, { timeoutMs: ms }); return page.eval('window.__rec'); };
// The page kept alive until 700 ms after it started (past the 400 ms reveal timer, with margin): what it recorded, and what the DOM says NOW. visit() returns the moment the hub is up, which is
// too early to see a timer that fires after that.
const settled = async (page) => { await page.waitFor('performance.now() >= 700', { timeoutMs: 15000, pollMs: 25 }); return page.eval('Object.assign({}, window.__rec, { endLive: document.getElementById("live").textContent, endSlow: document.body.hasAttribute("data-slow"), endState: document.body.dataset.state })'); };
// THE LOAD-INDEPENDENT CONTRACT OF ONE RETURN (see the header). `rec` = window.__rec of the return; `end` = what settled() adds (omit it to judge the panel only).
// -> { hub, fast, frames, first, span, allowed, panel: [reasons it broke the panel contract], live: [reasons it broke the live-region contract] }
const REVEAL_EARLY = 395;          // the panel is revealed 400 ms after the page starts; 5 ms for the one-sample-per-frame recorder
function contract(rec, end) {
  const panel = [], live = [];
  const shown = rec.frames.filter((f) => f[1] === 1);
  const first = shown.length ? shown[0][0] : null, last = shown.length ? shown[shown.length - 1][0] : null;
  const gaps = rec.frames.slice(1).map((f, i) => f[0] - rec.frames[i][0]).sort((a, b) => a - b);
  const frame = Math.max(17, gaps.length ? gaps[gaps.length >> 1] : 17);                      // "one frame": the typical gap between two samples, never less than a 60 Hz frame
  const hub = rec.firstHub, fast = hub !== null && hub < REVEAL_EARLY;
  const span = first === null ? 0 : last - first, allowed = hub === null ? 0 : Math.max(0, hub - REVEAL_EARLY) + frame;
  if (hub === null) panel.push('the hub never drew a frame');
  if (first !== null && first < REVEAL_EARLY) panel.push('the panel was on screen at ' + first + ' ms, before the reveal');
  if (fast && rec.panelFrames > 0) panel.push('a return up at ' + hub + ' ms (before the reveal) showed the panel for ' + rec.panelFrames + ' frames');
  if (!fast && hub !== null && span > allowed) panel.push('the panel was on screen for ' + span + ' ms, more than the ' + Math.round(allowed) + ' ms this return ran past the reveal (+ one frame)');
  if (end) {
    const stale = rec.liveLog.filter((e) => /Loading the game file/.test(e[2]) && e[1] !== 'boot');
    if (stale.length) live.push('"Loading the game file" was in the live region at ' + stale[0][0] + ' ms while the page was in state "' + stale[0][1] + '"');
    if (/Loading the game file/.test(end.endLive)) live.push('the live region still says "' + String(end.endLive).slice(0, 40) + '" after the hub is up');       // (the hub then uses the region for its own announcements: "Main menu. QUICK BATTLE...")
    if (fast && rec.live !== null) live.push('a return up at ' + hub + ' ms (before the reveal) wrote "' + String(rec.live).slice(0, 30) + '" to the live region at ' + rec.liveAt + ' ms');
    if (fast && end.endSlow) live.push('a return up at ' + hub + ' ms (before the reveal) had data-slow set on <body> by 700 ms');
  }
  return { hub, fast, frames: rec.panelFrames, first, span, allowed: Math.round(allowed), panel, live };
}
const hubInfo = (page) => page.eval('({ state: window.__arenaHub.state, kind: window.__arenaHub.kind, sha: window.__arenaHub.sha256, rom: window.__arenaHub.rom || null, status: document.getElementById("romStatus").textContent, errHidden: document.getElementById("error").hidden, bootHidden: document.getElementById("boot").hidden })');
const cacheEntry = (page) => page.eval(`(async () => { const C = await import('/pokemonarena/js/romcache.js'); const c = await caches.open(C.CACHE_NAME); const r = await c.match(C.CACHE_KEY); if (!r) return null; const ab = await r.arrayBuffer(); const d = new Uint8Array(await crypto.subtle.digest('SHA-256', ab)); return { len: ab.byteLength, sha: Array.from(d, (x) => x.toString(16).padStart(2, '0')).join(''), hdr: r.headers.get('x-arena-sha256') }; })()`);
const waitCached = (page, ms = 15000) => page.waitFor(`(async () => { try { const C = await import('/pokemonarena/js/romcache.js'); const c = await caches.open(C.CACHE_NAME); return !!(await c.match(C.CACHE_KEY)); } catch (e) { return false; } })()`, { timeoutMs: ms });
const mutateStored = (page, how) => page.eval(`(async () => { const C = await import('/pokemonarena/js/romcache.js'); const c = await caches.open(C.CACHE_NAME); const r = await c.match(C.CACHE_KEY); const b = new Uint8Array(await r.arrayBuffer()); const hdr = {}; r.headers.forEach((v, k) => { hdr[k] = v; });
  let body = b; if (${J(how)} === 'flip') { body = b.slice(); body[0x1000000] ^= 0xff; } else if (${J(how)} === 'short') body = b.slice(0, b.length - 7);
  else if (${J(how)} === 'body') { body = b.slice(); body.fill(0xff, ${BODY_HIT.offset}, ${BODY_HIT.offset + BODY_HIT.length}); }
  await c.put(C.CACHE_KEY, new Response(body, { headers: hdr })); return body.length; })()`);
// every key in the current cache (as a path), and an entry for a previously pinned ROM (the pin is in the KEY, so it sits in the SAME cache)
const cacheKeys = (page) => page.eval(`(async () => { const C = await import('/pokemonarena/js/romcache.js'); const c = await caches.open(C.CACHE_NAME); return (await c.keys()).map((r) => new URL(r.url).pathname); })()`);
const addOldPin = (page) => page.eval(`(async () => { const C = await import('/pokemonarena/js/romcache.js'); const c = await caches.open(C.CACHE_NAME); await c.put(C.KEY_PREFIX + 'f'.repeat(64), new Response(new Uint8Array(2048), { headers: { 'x-arena-sha256': 'f'.repeat(64) } })); return (await c.keys()).length; })()`);
// the page's accessibility tree as a screen reader gets it: the text of every node that is NOT ignored and that is part of the loading panel
const panelTextInAxTree = async (page, tries = 15) => {
  await page.send('Accessibility.enable');
  let found = [];
  for (let i = 0; i < tries && found.length === 0; i++) {          // the tree is built lazily after enable(): ask again for a moment before concluding that the text is not in it
    const { nodes } = await page.send('Accessibility.getFullAXTree');
    found = nodes.filter((n) => !n.ignored && n.name && typeof n.name.value === 'string' && /Loading ROM|Fetching the ROM|Checking the ROM/.test(n.name.value)).map((n) => n.name.value);
    if (found.length === 0) await sleep(150);
  }
  return found;
};
const throttle = (page, mbps) => page.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: mbps ? mbps * 1048576 : -1, uploadThroughput: -1 });
const shot = async (page, name) => { if (SHOTS) { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* evidence, not the test */ } } };

async function groupWarm(origin) {
  // a desktop: first visit on a slow link (so the loading panel is expected), then the return
  await withBrowser({ port: CDP0, width: 1280, height: 800, lock: false }, async (page) => {
    const ctr = await newPage(page);
    await throttle(page, 24);
    const cold = await visit(page, origin + '/pokemonarena/');
    const ci = await hubInfo(page);
    ok(ci.state === 'ready' && ctr.rom === 1 && ci.rom && ci.rom.cached === false, 'W1 a first visit downloads the ROM once, verifies it and reaches the hub', J({ rom: ctr.rom, hub: ci.rom }));
    ok(cold.panelFrames >= 5 && cold.maxBar > 0.95, 'W2 a first visit still shows the loading panel with a progress bar that fills (' + cold.panelFrames + ' frames, bar to ' + cold.maxBar.toFixed(2) + ')', J({ frames: cold.panelFrames, bar: cold.maxBar }));
    // the control arm of the R cases: with motion allowed, the stylesheet's own reveal animation is what the page resolves (the R arm proves it resolves to none under "reduce")
    const firstSeenW = (() => { const f = cold.frames.find((x) => x[1] === 1); return f ? f[0] : null; })();
    ok(firstSeenW !== null && firstSeenW >= 395, 'W2c and not before the 400 ms delay (first frame with the panel at ' + firstSeenW + ' ms): neither the stylesheet nor the script may show it earlier', J(firstSeenW));
    ok(cold.reduce === false && cold.anim === 'arena-boot-in', 'W2b the normal-motion arm: the page sees no reduced-motion preference and the panel\'s reveal animation resolves to arena-boot-in', J({ reduce: cold.reduce, anim: cold.anim }));
    const ent = await waitCached(page).then(() => cacheEntry(page), () => null);
    ok(ent && ent.len === 33554432 && ent.sha === ent.hdr && ent.sha === '8071e2c3' + ent.sha.slice(8), 'W3 the verified ROM was kept in the browser (Cache Storage), under its pin', J(ent));
    await throttle(page, 0);
    ctr.rom = 0;
    // THREE returns, each judged by contract() against its OWN first-hub time (this box is shared with other suites and agents, and the panel is revealed 400 ms after the page starts, so a return
    // that load slows past that is, correctly, shown the panel -- the old "best of three shows 0 frames" failed on a loaded box with all three at 468-619 ms). A return up inside 400 ms
    // (113 ms idle, measured) must show NO panel frame at all; a slower one at most as long as it ran past the reveal, plus a frame.
    let warm = null, wi = null; const tries = [];
    for (let a = 0; a < 3; a++) {
      await visit(page, origin + '/pokemonarena/'); const info = await hubInfo(page);
      const w = await settled(page);
      tries.push({ ...contract(w, w), early: w.frames.filter((f) => f[0] < 395 && f[1]).length });
      if (!warm || (w.firstHub !== null && w.firstHub < warm.firstHub)) { warm = w; wi = info; }
    }
    const fastN = tries.filter((t) => t.fast).length;
    ok(tries.every((t) => t.early === 0), 'W4a the loading panel is never on screen in the first 400 ms of a page, in any of three returns (the CSS reveal delay)', J(tries));
    ok(tries.every((t) => t.panel.length === 0), 'W4 coming back: a return up before the 400 ms reveal NEVER shows the loading panel (0 frames, sampled on every animation frame from the start of the page), and a slower one shows it for no longer than it ran past the reveal + one frame (' + fastN + ' of 3 were up inside 400 ms on this machine; 113 ms idle)', J(tries));
    ok(tries.every((t) => t.live.length === 0), 'W4b and the live region (what a screen reader is told) never says "Loading the game file" once the hub is up: a return up inside 400 ms never writes it, none leaves it behind (judged at 700 ms)', J(tries));
    ok(ctr.rom === 0 && wi.rom && wi.rom.cached === true, 'W5 and the ROM is not downloaded again (no request for it at all)', J({ rom: ctr.rom, hub: wi.rom }));
    ok(wi.state === 'ready' && wi.sha === ci.sha && /ROM verified: Pokemon SoulGold v1\.1\.1 \(SHA-256 8071e2c3/.test(wi.status) && wi.errHidden && wi.bootHidden, 'W6 the hub says what it always said (ROM verified, with the pin)', wi.status.slice(0, 80));
    ok(warm.firstHub !== null && cold.firstHub !== null && warm.firstHub < cold.firstHub, 'W7 the hub is on screen sooner than a first visit (' + warm.firstHub + ' ms against ' + cold.firstHub + ' ms on a slow link)', J([warm.firstHub, cold.firstHub]));
    ok(warm.firstHub !== null && warm.firstHub <= 1500, 'W7b and well inside the budget that matters: before the 400 ms reveal of the panel on this machine, 1500 ms is the CI-load ceiling (measured ' + warm.firstHub + ' ms)', String(warm.firstHub));
    await page.waitFor('window.__arenaHub.rom && window.__arenaHub.rom.verified === true', { timeoutMs: 15000 }).catch(() => {});
    ok((await page.eval('window.__arenaHub.rom.verified')) === true, 'W8 a recalled copy is re-hashed right after the first frame, and passes', J(await page.eval('window.__arenaHub.rom')));
    const before = await page.eval('JSON.stringify(window.__arenaHub.view())');
    await page.eval('window.__arenaHub.press("down")');
    ok((await page.eval('JSON.stringify(window.__arenaHub.view())')) !== before && (await page.eval('window.__arenaHub.canvasHash()')) !== null, 'W9 the hub is usable at once (a key moves the cursor)', '');
    ok(page.errors.length === 0, 'W10 no page errors across both visits', J(page.errors).slice(0, 200));
    await shot(page, 'warm_1280_ready');
  });
  // a phone: the same, and the same return stretched out by a 4x slower CPU so the frames can be seen
  await withBrowser({ port: CDP0 + 2, width: 390, height: 844, mobile: true, lock: false }, async (page) => {
    const ctr = await newPage(page);
    await visit(page, origin + '/pokemonarena/');
    await waitCached(page);
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    ctr.rom = 0;
    const w1 = await visit(page, origin + '/pokemonarena/');
    const c1 = contract(w1);
    ok(c1.panel.length === 0 && ctr.rom === 0, 'W12 on a phone (390x844, touch) the return keeps the reveal contract (up before the 400 ms reveal: no loading panel at all; slower: only as long as it ran past it) and downloads nothing', J({ contract: c1, rom: ctr.rom }));
    await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // the return, stretched by the slow CPU so that the frames on the way can be LOOKED at: three bounded captures while it loads (a capture that hangs is abandoned after 4 s)
    const nav = page.navigate(origin + '/pokemonarena/', { waitMs: 30000 });
    if (SHOTS) for (const [i, d] of [[0, 40], [1, 140], [2, 140]]) { await sleep(d); await Promise.race([page.screenshot(path.join(OUT, 'warm_390_x4_' + i + '.png')).catch(() => null), sleep(4000)]); }
    await nav;
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 60000 });
    const w4 = await page.eval('window.__rec');
    // (this used to cap the panel at 30 frames, which is a wall-clock budget: a slow or loaded box fails it with the product unchanged. The panel's life is bounded by how far the return ran past the
    // reveal instead; the speed budget lives in W7b.)
    const c4 = contract(w4);
    ok(c4.panel.length === 0 && w4.firstHub !== null, 'W13 at 4x slower CPU (a stand-in for a phone) the hub still comes up from the stored copy, with the panel visible for no longer than the return ran past the 400 ms reveal (+ one frame): ' + c4.frames + ' frames, ' + c4.span + ' ms of ' + c4.allowed + ' allowed', J(c4));
    ok(w4.linkFrames === 0, 'W14 and until the hub is up the page does not show the Play online link on its own on an empty screen (it looked like a glitch): ' + w4.linkFrames + ' frames', J({ linkFrames: w4.linkFrames }));
    await shot(page, 'warm_390_x4_ready');
  });
}

async function groupCorrupt(origin) {
  await withBrowser({ port: CDP0 + 3, width: 900, height: 700, lock: false }, async (page) => {
    const ctr = await newPage(page);
    await visit(page, origin + '/pokemonarena/');
    await waitCached(page);
    // 1. a stored copy that is the wrong size: not trusted, the page goes to the network and puts a good copy back. An entry for a PREVIOUSLY PINNED ROM sits in the same cache
    // (the cache name holds the revision, the pin is in the key): storing the new copy must take it away (32 MB in real life), through the REAL Cache API (its keys() lists Requests).
    ok((await addOldPin(page)) === 2, 'C0 setup: an entry for another pin now sits in the same cache beside the good one', '');
    await mutateStored(page, 'short');
    ctr.rom = 0;
    await page.eval('sessionStorage.setItem("__loads", "0"); sessionStorage.removeItem("arena.rom.retry"); true');
    await visit(page, origin + '/pokemonarena/');
    const i1 = await hubInfo(page);
    const loads1 = await page.eval('Number(sessionStorage.getItem("__loads"))');
    // loads === 1: the CACHE refused the copy up front. (A copy it wrongly trusted would still end at the hub, because start() now recovers from one -- C3 -- but only after a second load.)
    ok(ctr.rom === 1 && i1.state === 'ready' && i1.rom.cached === false && loads1 === 1, 'C1 a stored copy of the wrong size is not trusted: the full download and verification run, in ONE load, and the hub comes up', J({ rom: ctr.rom, loads: loads1, hub: i1.rom }));
    await waitCached(page);
    const good = await cacheEntry(page);
    ok(good && good.len === 33554432 && good.sha === good.hdr, 'C1b and a good copy replaces it', J(good));
    const keys1 = await cacheKeys(page);
    ok(keys1.length === 1 && /\/rom-8071e2c3[0-9a-f]{56}$/.test(keys1[0]), 'C1c and the copy of the previously pinned ROM was removed with it: one entry is left, under the current pin', J(keys1));
    // 2. a stored copy that is the right size and header but corrupt inside: shown at once, caught by the re-check, reloaded ONCE through the full path
    await mutateStored(page, 'flip');
    ctr.rom = 0;
    await page.eval('sessionStorage.setItem("__loads", "0"); sessionStorage.removeItem("arena.rom.retry"); true');
    await page.navigate(origin + '/pokemonarena/', { waitMs: 30000 });
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready" && window.__arenaHub.rom && window.__arenaHub.rom.cached === false', { timeoutMs: 60000 });
    const i2 = await hubInfo(page);
    const loads = await page.eval('Number(sessionStorage.getItem("__loads"))');
    ok(loads === 2 && i2.state === 'ready' && ctr.rom >= 1, 'C2 a copy that is corrupt INSIDE is caught by the re-check after the first frame: the page reloads once through the full path and ends at the hub', J({ loads, rom: ctr.rom, hub: i2.rom }));
    await waitCached(page);
    const fixed = await cacheEntry(page);
    ok(fixed && fixed.sha === fixed.hdr && fixed.len === 33554432, 'C2b and the corrupt copy was replaced by a verified one', J(fixed));
    ok(i2.rom.verified === true && (await page.eval('sessionStorage.getItem("arena.rom.retry")')) === null, 'C2c the retry guard is cleared once a load verifies', '');
    // 3. a stored copy that is header-valid but corrupt INSIDE a table the menu decodes (BODY_HIT; U14 proves in Node that the cache trusts it and loadPack() throws on it). The menu cannot be built, so
    // start() throws BEFORE the re-check is ever scheduled: this used to be an error screen with no way out (the stored copy was never dropped, every reload read the same bytes). It must be hashed on
    // the spot, dropped, and recovered through the full path ONCE.
    await mutateStored(page, 'body');
    ctr.rom = 0;
    await page.eval('sessionStorage.setItem("__loads", "0"); sessionStorage.removeItem("arena.rom.retry"); true');
    await page.navigate(origin + '/pokemonarena/', { waitMs: 30000 });
    await page.waitFor('window.__arenaHub && (window.__arenaHub.state === "ready" || window.__arenaHub.state === "error")', { timeoutMs: 60000 });
    const i3 = await hubInfo(page);
    const loads3 = await page.eval('Number(sessionStorage.getItem("__loads"))');
    ok(i3.state === 'ready' && i3.rom && i3.rom.cached === false && loads3 === 2 && ctr.rom >= 1, 'C3 a copy that is corrupt inside a table (the menu cannot be built from it) is not a dead end: it is hashed at once, dropped, and the page reloads once through the full path and ends at the hub', J({ state: i3.state, kind: i3.kind, loads: loads3, rom: ctr.rom, hub: i3.rom }));
    await waitCached(page);
    const fixed3 = await cacheEntry(page);
    ok(fixed3 && fixed3.sha === fixed3.hdr && fixed3.len === 33554432, 'C3b and the damaged copy was replaced by a verified one', J(fixed3));
    // 4. the same damage with the reload guard already spent in this tab: no second reload (that is the loop the guard exists to stop); the error screen names it, and because the copy is gone the
    // very next load goes through the full path and works
    await mutateStored(page, 'body');
    ctr.rom = 0;
    await page.eval('sessionStorage.setItem("__loads", "0"); sessionStorage.setItem("arena.rom.retry", "1"); true');
    await page.navigate(origin + '/pokemonarena/', { waitMs: 30000 });
    await page.waitFor('window.__arenaHub && (window.__arenaHub.state === "ready" || window.__arenaHub.state === "error")', { timeoutMs: 60000 });
    await sleep(1500);                      // a reload would show up as a second load by now
    const i4 = await hubInfo(page);
    const loads4 = await page.eval('Number(sessionStorage.getItem("__loads"))');
    ok(i4.state === 'error' && i4.kind === 'hash' && !i4.errHidden && i4.bootHidden && loads4 === 1 && ctr.rom === 0, 'C4 with the reload guard already spent the damaged copy is NOT reloaded again: the error screen is shown (named, no loop)', J({ state: i4.state, kind: i4.kind, loads: loads4, rom: ctr.rom }));
    ok((await cacheEntry(page).catch(() => null)) === null, 'C4b and the damaged copy is gone from storage', '');
    await visit(page, origin + '/pokemonarena/');
    const i5 = await hubInfo(page);
    ok(i5.state === 'ready' && i5.rom.cached === false && ctr.rom === 1, 'C4c so the next load downloads, verifies and reaches the hub', J({ rom: ctr.rom, hub: i5.rom }));
  });
}

// A KEY PRESSED WHILE THE FIRST VISIT IS STILL LOADING is dropped, not queued: nothing listens until the menu is up, and nothing replays it then.
async function groupEarlyKey(origin) {
  await withBrowser({ port: CDP0 + 1, width: 1280, height: 800, lock: false }, async (page) => {
    await newPage(page);
    await throttle(page, 12);
    await page.navigate(origin + '/pokemonarena/', { waitMs: 20000 });
    await sleep(700);
    const during = await page.eval('window.__arenaHub ? window.__arenaHub.state : "no hook yet"');
    const histBefore = await page.eval('history.length');
    // Enter, as the browser delivers it (trusted events), and as plain events on the document and the window. On the main menu Enter is A on the first row, QUICK BATTLE, which a hub that HAD acted on it would open (#quick).
    await page.press('Enter', 'Enter', 13);
    await page.eval('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 90000 });
    await sleep(400);                       // a queued key would have been replayed by now
    const s = await page.eval('({ hash: location.hash, screen: window.__arenaHub.view().screen, path: window.__arenaHub.model.path(), cursor: window.__arenaHub.view().menu ? window.__arenaHub.view().menu.cursor : null, effects: window.__arenaHub.effects.slice(), navigated: window.__arenaHub.navigated || null, hist: history.length })');
    ok(during === 'boot', 'W11a the key really was pressed while the first visit was loading (the hub reported state boot at that moment)', String(during));
    ok(s.hash === '' && s.screen === 'main' && s.path === 'main' && s.cursor === 0 && s.effects.length === 0 && s.navigated === null && s.hist === histBefore, 'W11 a key pressed while the first visit was still loading is dropped (not queued): the hub comes up on the main menu with the cursor on the first row, no screen opened, no effect run, no page left, the history unchanged', J(s));
    // the control: the SAME key, once the hub is up, DOES open Quick Battle -- so the absence above is something this page could have shown
    await page.eval('window.__arenaHub.press("a")');
    const after = await page.eval('({ hash: location.hash, screen: window.__arenaHub.view().screen })');
    ok(after.hash === '#quick' && after.screen === 'quick', 'W11b control: the same key pressed now opens Quick Battle (#quick), so W11 would have seen a replayed one', J(after));
  });
}

// PREFERS-REDUCED-MOTION. "reduce" switches EVERY CSS animation off (!important, arena.css), and the loading panel used to be revealed by one: a visitor with Reduce Motion on (iOS, Android and Windows
// all map it to this query) saw an EMPTY page for the whole 32 MB first download, with nothing for a screen reader either. Headless Chrome does not do this by itself, so it is emulated (CDP
// Emulation.setEmulatedMedia); the arm proves itself by what the page resolves (the stylesheet's own reveal animation is "none" here and "arena-boot-in" in W2b).
async function groupReduced(origin) {
  const REDUCE = { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] };
  await withBrowser({ port: CDP0 + 8, width: 1280, height: 800, lock: false }, async (page) => {
    const ctr = await newPage(page);
    await page.send('Emulation.setEmulatedMedia', REDUCE);
    await throttle(page, 12);
    await page.navigate(origin + '/pokemonarena/', { waitMs: 60000 });
    // while the first download is going on: is the panel on screen, and is its text in the accessibility tree?
    const shown = await page.waitFor('document.body.dataset.state === "boot" && getComputedStyle(document.getElementById("boot")).visibility === "visible"', { timeoutMs: 6000, pollMs: 50 }).catch(() => false);
    const ax = shown ? await panelTextInAxTree(page).catch((e) => ['AX query failed: ' + e.message]) : [];
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 90000 });
    const cold = await page.eval('window.__rec');
    const ci = await hubInfo(page);
    ok(cold.reduce === true && cold.anim === 'none', 'R0 the arm does what it claims: the page sees prefers-reduced-motion and the stylesheet\'s own reveal animation resolves to none (it is arena-boot-in in W2b)', J({ reduce: cold.reduce, anim: cold.anim }));
    ok(ci.state === 'ready' && ctr.rom === 1 && ci.rom && ci.rom.cached === false, 'R0b the first visit downloads the ROM once and reaches the hub', J({ rom: ctr.rom, hub: ci.rom }));
    const firstSeen = (rec) => { const f = rec.frames.find((x) => x[1] === 1); return f ? f[0] : null; };
    ok(firstSeen(cold) !== null && firstSeen(cold) >= 395, 'R1e and not before the 400 ms delay (first frame with the panel at ' + firstSeen(cold) + ' ms): a page that is merely waiting on the network for a fast return must not flash it', J(firstSeen(cold)));
    ok(shown && cold.panelFrames >= 5 && cold.maxBar > 0.95, 'R1 with reduced motion a first visit STILL shows the loading panel with a progress bar that fills (' + cold.panelFrames + ' frames, bar to ' + cold.maxBar.toFixed(2) + '); it was an empty page for the whole download', J({ shown, frames: cold.panelFrames, bar: cold.maxBar }));
    ok(ax.some((t) => /Loading ROM|Fetching the ROM|Checking the ROM/.test(t)), 'R1b and its text is in the accessibility tree while it loads (not ignored), so a screen reader can reach it', J(ax));
    ok(typeof cold.live === 'string' && /Loading the game file/.test(cold.live), 'R1c and the persistent live region announces that the game file is loading', J(cold.live));
    const ent = await waitCached(page).then(() => cacheEntry(page), () => null);
    ok(ent && ent.len === 33554432 && ent.sha === ent.hdr, 'R1d the ROM was kept, as in any other first visit', J(ent));
    await throttle(page, 0);
    ctr.rom = 0;
    // the same returns as W4 (five of them, not three), judged the same way: each against its OWN first-hub time by contract(), so a box that is loaded past the 400 ms reveal (all five at 468-619 ms
    // once) cannot fail it, while the timer that flashes the panel on a fast return, or that keeps firing after the hub is up, still does
    const tries = [];
    for (let a = 0; a < 5; a++) {
      await visit(page, origin + '/pokemonarena/'); const info = await hubInfo(page);
      const w = await settled(page);
      tries.push({ ...contract(w, w), reduce: w.reduce, early: w.frames.filter((f) => f[0] < 395 && f[1]).length, cached: !!(info.rom && info.rom.cached), liveSeen: w.live });
    }
    const fastR = tries.filter((t) => t.fast).length;
    ok(tries.every((t) => t.reduce === true && t.early === 0), 'R2a with reduced motion the loading panel is never on screen in the first 400 ms of a return either', J(tries));
    ok(tries.every((t) => t.panel.length === 0), 'R2 and with reduced motion a return up before the 400 ms reveal still shows NO loading panel (0 frames), a slower one shows it for no longer than it ran past the reveal + one frame: the inline timer does not fire before the hub is up (' + fastR + ' of 5 were up inside 400 ms on this machine)', J(tries));
    ok(ctr.rom === 0 && tries.every((t) => t.cached), 'R2b and the ROM is not downloaded again', J({ rom: ctr.rom, tries }));
    ok(tries.every((t) => t.live.length === 0), 'R2d and the live region never says "Loading the game file" once the hub is up: a return up inside 400 ms never writes it (the inline timer looks at the page state), none leaves it behind (judged at 700 ms)', J(tries));
    ok(page.errors.length === 0, 'R2c no page errors', J(page.errors).slice(0, 200));
  });
  // Try again: the page has been up far longer than 400 ms by then, so the panel comes back AT ONCE (not another 400 ms of nothing) -- with reduced motion the script's timer is the only thing that can do it
  await withBrowser({ port: CDP0 + 8, width: 1280, height: 800, lock: false }, async (page) => {
    await newPage(page);
    await page.send('Emulation.setEmulatedMedia', REDUCE);
    await page.send('Network.setBlockedURLs', { urls: ['*SoulGold*'] });
    await page.navigate(origin + '/pokemonarena/', { waitMs: 30000 });
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "error" && !document.getElementById("retry").hidden', { timeoutMs: 30000 });
    await sleep(600);
    await page.send('Network.setBlockedURLs', { urls: [] });
    await throttle(page, 12);
    const tc = await page.eval('(() => { const t = performance.now(); document.getElementById("retry").click(); return t; })()');
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 90000 });
    const rec = await page.eval('window.__rec');
    const first = rec.frames.find((f) => f[0] >= tc && f[2] === 'boot' && f[1] === 1);
    ok(first && first[0] - tc < 300, 'R4 after an error, Try again shows the loading panel at once (first frame with it ' + (first ? Math.round(first[0] - tc) : 'never') + ' ms after the click; not another 400 ms of nothing), with reduced motion', J({ tc: Math.round(tc), first }));
    // ... and says so: the panel is out of the accessibility tree until it is revealed, so a screen reader hears the live region (boot.js armReveal). Read off the region's own log, from the click on:
    // on a slow box the FIRST load can have written (and, on its error, taken back) the same message before the click, so rec.live -- the first text ever seen in state boot -- is not Try again's.
    const said = rec.liveLog.find((e) => e[0] >= tc && e[1] === 'boot' && /Loading the game file/.test(e[2]));
    ok(!!said && said[0] - tc < 300, 'R4b and Try again announces it at once too: the live region says "Loading the game file" ' + (said ? Math.round(said[0] - tc) + ' ms after the click' : 'never'), J({ tc: Math.round(tc), said, log: rec.liveLog.slice(0, 6) }));
    const endLive4 = await page.eval('document.getElementById("live").textContent');
    ok(!/Loading the game file/.test(endLive4), 'R4c and the message is taken back when the hub is up (the region then carries the hub\'s own announcements)', J(endLive4));
  });
}

// NO HELP FROM THE PAGE'S MODULES. Three cases, each the only thing that can act in it:
//   R3  NO SCRIPT AT ALL (script execution switched off): the stylesheet's own 0 s keyframe still reveals the panel after 400 ms.
//   R3b REDUCED MOTION AND A MODULE GRAPH THAT NEVER ARRIVES (boot.js blocked: a first visit on a bad connection, a deploy gap): the keyframe is switched off, the modules have not started, and the
//       inline timer in index.html is all there is -- it must still reveal the panel and say so.
//   R3c THE SAME PAGE, ALREADY PAST LOADING when the timer fires (state forced to ready as <body> appears): the timer must do NOTHING. This is the deterministic form of "a return that is up inside
//       400 ms never writes the message" -- the real returns W4b / R2d check it too, but only when the machine is fast enough to be up inside 400 ms.
async function groupNoScript(origin) {
  const panel = '({ vis: getComputedStyle(document.getElementById("boot")).visibility, state: document.body.dataset.state, hook: !!window.__arenaHub, slow: document.body.dataset.slow || null, live: document.getElementById("live").textContent })';
  await withBrowser({ port: CDP0 + 9, width: 1280, height: 800, lock: false }, async (page) => {
    await newPage(page);
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    await page.navigate(origin + '/pokemonarena/', { waitMs: 20000 });
    await sleep(1000);
    const r = await page.eval(panel);
    ok(r.state === 'boot' && r.hook === false && r.slow === null && r.live === '' && r.vis === 'visible', 'R3 with no script at all the loading panel is still revealed after 400 ms, by the stylesheet alone', J(r));
  });
  await withBrowser({ port: CDP0 + 9, width: 1280, height: 800, lock: false }, async (page) => {
    await newPage(page);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.send('Network.setBlockedURLs', { urls: ['*/pokemonarena/js/boot.js*'] });
    await page.navigate(origin + '/pokemonarena/', { waitMs: 20000 });
    await sleep(1000);
    const r = await page.eval(panel);
    const anim = await page.eval('getComputedStyle(document.getElementById("boot")).animationName');
    ok(anim === 'none' && r.state === 'boot' && r.hook === false && r.slow === '1' && r.vis === 'visible' && /Loading the game file/.test(r.live), 'R3b with reduced motion (the keyframe is off, animation: ' + anim + ') and the page\'s modules never arriving, the inline timer still reveals the loading panel and announces it', J(r));
  });
  // R3c THE SAME PAGE, WITH THE LOADING OVER BEFORE THE TIMER FIRES. A return that is up inside 400 ms is up by the time the inline timer runs, and the timer must then leave the page alone (index.html:
  // `data-state !== 'boot'`). This is the load-independent form of "a fast return never writes the message": the page state is set to ready (what boot.js does when the hub is up) the moment <body>
  // exists, boot.js is blocked so nothing else touches it, and R3b above is the control (the same page left in state boot DOES get data-slow and the message).
  await withBrowser({ port: CDP0 + 9, width: 1280, height: 800, lock: false }, async (page) => {
    await newPage(page, { script: `new MutationObserver((_m, ob) => { if (document.body) { document.body.dataset.state = 'ready'; ob.disconnect(); } }).observe(document, { childList: true, subtree: true });` });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.send('Network.setBlockedURLs', { urls: ['*/pokemonarena/js/boot.js*'] });
    await page.navigate(origin + '/pokemonarena/', { waitMs: 20000 });
    await sleep(1000);
    const r = await page.eval(panel);
    ok(r.state === 'ready' && r.hook === false && r.slow === null && r.live === '', 'R3c with the page already past loading (state ready) when the 400 ms timer fires, the inline timer leaves it alone: no data-slow, nothing written to the live region (the arm is real: state ' + r.state + ', and in R3b the same page in state boot gets both)', J(r));
  });
}

async function groupBad(origin, proxyOrigin) {
  // the server's ROM is bad (zeros: right length, not the cartridge)
  await withBrowser({ port: CDP0 + 4, width: 900, height: 700, lock: false }, async (page) => {
    proxyState.badRom = true;
    try {
      const ctr = await newPage(page);
      await page.navigate(proxyOrigin + '/pokemonarena/', { waitMs: 30000 });
      await page.waitFor('window.__arenaHub && window.__arenaHub.state === "error"', { timeoutMs: 90000 });
      const i = await hubInfo(page);
      ok(i.state === 'error' && i.kind === 'format' && !i.errHidden && i.bootHidden && ctr.rom === 1, 'B1 a bad ROM from the server and nothing stored: the error screen, named, with the loading panel gone', J(i));
      ok((await cacheEntry(page).catch(() => null)) === null, 'B2 and the bad file was NOT kept', '');
      // now a good copy is stored (a visit when the server was fine), and the server goes bad: the page still has the cartridge it verified
      proxyState.badRom = false;
      await visit(page, proxyOrigin + '/pokemonarena/');
      await waitCached(page);
      proxyState.badRom = true;
      ctr.rom = 0;
      await visit(page, proxyOrigin + '/pokemonarena/');
      const i2 = await hubInfo(page);
      await page.waitFor('window.__arenaHub.rom && window.__arenaHub.rom.verified === true', { timeoutMs: 15000 }).catch(() => {});
      ok(i2.state === 'ready' && i2.rom.cached === true && ctr.rom === 0 && (await page.eval('window.__arenaHub.rom.verified')) === true, 'B3 the pin is on the CONTENT: a good stored copy is used even if the server\'s ROM has since gone bad (no request is made; the re-check passes)', J(i2.rom));
    } finally { proxyState.badRom = false; }
  });
}

async function groupBlocked(origin) {
  await withBrowser({ port: CDP0 + 5, width: 900, height: 700, lock: false }, async (page) => {
    const ctr = await newPage(page, { script: BLOCK_CACHES });
    await visit(page, origin + '/pokemonarena/');
    const a = await hubInfo(page);
    const n1 = ctr.rom; ctr.rom = 0;
    await visit(page, origin + '/pokemonarena/');
    const b = await hubInfo(page);
    ok(a.state === 'ready' && b.state === 'ready' && n1 === 1 && ctr.rom === 1 && a.rom.cached === false && b.rom.cached === false, 'K1 with Cache Storage blocked (private mode, a locked-down browser) every visit downloads and verifies as before, and works', J({ n1, n2: ctr.rom, a: a.rom, b: b.rom }));
    ok(page.errors.length === 0, 'K2 and raises no page error', J(page.errors).slice(0, 200));
  });
}

async function groupBattle(origin) {
  await withBrowser({ port: CDP0 + 6, width: 900, height: 700, lock: false }, async (page) => {
    const ctr = await newPage(page);
    await visit(page, origin + '/pokemonarena/');
    await waitCached(page);
    ctr.rom = 0;
    await page.navigate(origin + '/pokemonarena/battle.html?seed=5&format=3v3&anim=0', { waitMs: 30000 });
    await page.waitFor('window.__arenaBattle && window.__arenaBattle.state === "ready"', { timeoutMs: 90000 });
    ok(ctr.rom === 0, 'T1 the battle page uses the same stored copy (no ROM request), so the way TO a battle and back to the hub both skip the download', String(ctr.rom));
    ctr.rom = 0;
    await page.eval('window.__arenaBattle.state === "ready" && (location.href = "/pokemonarena/"); true');
    await page.waitFor('window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 60000 });
    const rec = await page.eval('window.__rec');
    const ct = contract(rec);
    ok(ctr.rom === 0 && ct.panel.length === 0, 'T2 BACK TO HUB from the battle page (a fresh navigation) keeps the reveal contract (no loading panel when it is up before the 400 ms reveal) and downloads nothing', J({ rom: ctr.rom, contract: ct }));
  });
}

async function groupBfcache(proxyOrigin) {
  await withBrowser({ port: CDP0 + 7, width: 900, height: 700, lock: false }, async (page) => {
    await newPage(page);
    await visit(page, proxyOrigin + '/pokemonarena/');
    await page.eval('window.__marker = 424242; true');
    await page.eval('location.href = "/pokemonarena/battle.html?online=1&net=local"; true');
    await page.waitFor('window.__arenaBattle && window.__arenaBattle.state === "online"', { timeoutMs: 60000 });
    await page.eval('history.back(); true');
    await page.waitFor('window.__marker === 424242 && window.__arenaHub && window.__arenaHub.state === "ready"', { timeoutMs: 15000 }).catch(() => {});
    const r = await page.eval('({ marker: window.__marker || null, state: window.__arenaHub && window.__arenaHub.state, shows: window.__rec && window.__rec.shows, vis: !document.getElementById("hub").hidden })');
    ok(r.marker === 424242 && r.state === 'ready' && r.vis, 'F1 browser Back to the hub restores the page itself from the back/forward cache (its state survived the trip: no load at all) when the server allows caching', J(r));
    ok(page.errors.length === 0, 'F2 and the restored hub raises no error', J(page.errors).slice(0, 200));
  });
}

const BROWSER_GROUPS = { warm: groupWarm, earlykey: groupEarlyKey, reduced: groupReduced, noscript: groupNoScript, corrupt: groupCorrupt, bad: groupBad, blocked: groupBlocked, battle: groupBattle, bfcache: groupBfcache };

/* ------------------------------------------------------------------------------------------------ page mutants */
const PAGE_MUTANTS = [
  { id: 'the loading panel appears at once again', file: 'arena.css', from: 'body[data-state="boot"] #boot { visibility: hidden; animation: arena-boot-in 0s linear 0.4s forwards; }', to: '', groups: ['warm'] },
  { id: 'the lone Play online link shows during boot', file: 'arena.css', from: 'body[data-state="boot"] #onlineLink { visibility: hidden; }', to: '', groups: ['warm'] },
  { id: 'the stored ROM is never recalled', file: 'js/romfetch.js', from: 'const hit = await readCachedRom(opts);', to: 'const hit = null;', groups: ['warm'] },
  { id: 'a downloaded ROM is never stored', file: 'js/romfetch.js', from: 'if (persist) writeCachedRom(bytes, opts).catch(() => { /* a copy that could not be kept costs the next visit a download, nothing else */ });', to: '', groups: ['warm'] },
  { id: 'the re-check is never scheduled', file: 'js/boot.js', from: 'window.requestAnimationFrame(() => window.setTimeout(recheck, 0));', to: '', groups: ['corrupt'] },
  { id: 'a failed re-check keeps the stored copy', file: 'js/romfetch.js', from: 'catch (e) { await dropCachedRom(opts); throw e; }', to: 'catch (e) { throw e; }', groups: ['corrupt'] },
  { id: 'a recalled copy is never re-hashed', file: 'js/romfetch.js', from: 'const check = async () => { try { return await verifyRom(hit.bytes, opts.hasher); }', to: 'const check = async () => { try { return { sha256: hit.sha256 }; }', groups: ['corrupt'] },
  { id: 'a short stored copy is trusted', file: 'js/romcache.js', from: "if (bytes.length !== PINNED.length || !identify(bytes, { hash: 'none' }).ok) { await drop(cache); return null; }", to: '', groups: ['corrupt'] },
  { id: 'a ROM is stored before it is verified', file: 'js/romfetch.js', from: "  const { sha256 } = await verifyRom(bytes, opts.hasher);\n  if (persist) writeCachedRom(bytes, opts).catch(() => { /* a copy that could not be kept costs the next visit a download, nothing else */ });", to: "  if (persist) writeCachedRom(bytes, opts).catch(() => {});\n  const { sha256 } = await verifyRom(bytes, opts.hasher);", groups: ['bad'] },
  { id: 'reduced motion: the inline timer does not reveal the loading panel', file: 'index.html', from: "b.setAttribute('data-slow', '1');", to: '', groups: ['reduced', 'noscript'] },
  { id: 'the inline timer reveals the loading panel at once (no 400 ms wait)', file: 'index.html', from: '}, Math.max(0, 400 - performance.now()));', to: '}, 0);', groups: ['reduced', 'warm'] },
  { id: 'the inline timer says nothing to a screen reader', file: 'index.html', from: "if (live && !live.textContent) live.textContent = 'Loading the game file. This can take a moment.';", to: '', groups: ['noscript'] },
  { id: 'Try again does not show the panel at once', file: 'js/boot.js', from: 'if (performance.now() < REVEAL_MS) return;', to: 'return;', groups: ['reduced'] },
  // the page's own reveal ignoring the 400 ms is "the panel is shown on a warm path": armReveal() runs in load() on EVERY visit, so a return that is up in ~110 ms gets the panel (and the message) from its first frame
  { id: 'the page\'s own reveal ignores the 400 ms (a warm return shows the panel)', file: 'js/boot.js', from: 'if (performance.now() < REVEAL_MS) return;', to: '', groups: ['warm', 'reduced'] },
  { id: 'Try again shows the panel but announces nothing', file: 'js/boot.js', from: 'if (els.live && els.live.textContent !== REVEAL_SAYS) els.live.textContent = REVEAL_SAYS;', to: '', groups: ['reduced'] },
  { id: 'the inline timer reveals the loading panel whatever state the page is in', file: 'index.html', from: "if (b.getAttribute('data-state') !== 'boot') return;", to: '', groups: ['noscript', 'reduced'] },
  { id: 'the stylesheet no longer reveals the panel (only the script does)', file: 'arena.css', from: 'visibility: hidden; animation: arena-boot-in 0s linear 0.4s forwards;', to: 'visibility: hidden;', groups: ['noscript'] },
  { id: 'a copy corrupt inside gets no recovery (the dead end)', file: 'js/boot.js', from: 'if (!verify) { showError(romError(e)); return; }', to: 'if (true) { showError(romError(e)); return; }', groups: ['corrupt'] },
  { id: 'the recovery ignores the reload guard (a loop)', file: 'js/boot.js', from: 'if (!tried) window.location.reload(); else showError(romError(e));', to: 'window.location.reload();', groups: ['corrupt'] },
  { id: 'a copy of a previously pinned ROM is kept', file: 'js/romcache.js', from: 'if (p.startsWith(KEY_PREFIX) && p !== CACHE_KEY) {', to: 'if (false) {', groups: ['corrupt'] },
  { id: 'a key pressed while loading is queued and replayed', file: 'js/boot.js', from: "const hook = window.__arenaHub = { state: 'boot', kind: null, error: null, effects: [], store: 'pending' };", to: "const hook = window.__arenaHub = { state: 'boot', kind: null, error: null, effects: [], store: 'pending' }; let __early = false; window.addEventListener('keydown', (e) => { if (e.key === 'Enter') __early = true; }, true); const __iv = setInterval(() => { if (__early && hook.state === 'ready' && hook.press) { clearInterval(__iv); hook.press('a'); } }, 20);", groups: ['earlykey'] },
  { id: 'a blocked Cache Storage breaks the page', file: 'js/romcache.js', from: '    return c && typeof c.open === \'function\' ? c : null;\n  } catch (_e) { return null; }', to: '    return c && typeof c.open === \'function\' ? c : null;\n  } finally { /* nothing */ }', groups: ['blocked'] },
  { id: 'the battle page does not use the stored copy', file: 'js/romfetch.js', from: 'const persist = opts.persist !== undefined ? !!opts.persist : (opts.fetchImpl === undefined && opts.hasher === undefined);', to: 'const persist = opts.persist !== undefined ? !!opts.persist : (opts.fetchImpl === undefined && opts.hasher === undefined && !opts.deferVerify);', groups: ['battle'] },
];
async function runPageMutants() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-return-pages-'));
  for (const m of PAGE_MUTANTS) {
    if (ONLY_MUTANT && !m.id.includes(ONLY_MUTANT)) continue;
    const dir = path.join(tmp, 'm'); fs.rmSync(dir, { recursive: true, force: true });
    copyTree(path.join(root, 'pokemonarena'), dir);
    try { mutateFile(dir, m.file, m.from, m.to); } catch (e) { ok(false, 'M. mutant "' + m.id + '" is applicable', e.message); continue; }
    // pages go through the overlay (the mutated tree) in front of the caching proxy, which is in front of the dev server
    const ov = await startOverlay({ dir, port: OVL, upstream: `http://127.0.0.1:${PROXY}` });
    const fails = []; const prev = sink; sink = fails;
    try { for (const g of m.groups) await BROWSER_GROUPS[g](ov.url, ov.url); } catch (e) { fails.push('crashed: ' + String(e && e.message ? e.message : e).slice(0, 100)); } finally { sink = prev; ov.stop(); }
    if (process.env.ARENA_VERBOSE) for (const x of fails) console.log('  caught by:', x.slice(0, 160));
    ok(fails.length > 0, 'M. page mutant "' + m.id + '" is caught', fails.length ? fails[0].slice(0, 120) : 'NOT CAUGHT');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

/* =============================================================================================== main */
const t0 = Date.now();
try {
  const M = await loadModules(SRC);
  // the README says how many ways --mutants breaks things: it has been wrong once (26 against 28), so the count is a case, not a sentence nobody checks
  {
    const readme = fs.readFileSync(path.join(root, 'pokemonarena', 'README.md'), 'utf8');
    const said = /`--mutants` breaks the modules and the pages (\d+) ways/.exec(readme);
    const real = MODULE_MUTANTS.length + PAGE_MUTANTS.length;
    ok(said && Number(said[1]) === real, 'U15 pokemonarena/README.md states how many ways --mutants breaks things (' + MODULE_MUTANTS.length + ' module + ' + PAGE_MUTANTS.length + ' page = ' + real + ')', said ? 'README says ' + said[1] : 'the sentence is not in the README');
  }
  await units(M, '');
  console.log(`hub return units: ${pass} passed, ${fail} failed`);
  if (WANT_MUTANTS && !ONLY_MUTANT) {
    const res = await runModuleMutants();
    let surv = 0;
    for (const r of res) { if (!r.killed) { surv++; fail++; failures.push('module mutant SURVIVED: ' + r.id + (r.why ? ' (' + r.why + ')' : '')); } }
    console.log(`module mutants: ${res.length - surv}/${res.length} killed` + (surv ? ' -- SURVIVORS: ' + res.filter((r) => !r.killed).map((r) => r.id).join(', ') : ''));
  }
  if (!UNITS_ONLY) {
    await startServer(); await startProxy();
    const direct = `http://localhost:${PORT}`, viaProxy = `http://localhost:${PROXY}`;
    const only = args.filter((a) => !a.startsWith('-'));
    for (const [name, fn] of Object.entries(BROWSER_GROUPS)) {
      if (ONLY_MUTANT || (only.length && !only.includes(name))) continue;
      try { await fn(name === 'bad' || name === 'bfcache' ? viaProxy : direct, viaProxy); } catch (e) { fail++; failures.push(`group ${name} crashed :: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); console.log('FAIL group', name, 'crashed:', e && e.message); }
    }
    if (WANT_MUTANTS) await runPageMutants();
  }
} catch (e) { fail++; failures.push('crashed :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
finally { if (proxy) proxy.close(); if (server) { try { server.kill(); } catch (_e) { /* ignore */ } } }
console.log(`\nhub return: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)  screenshots: ${OUT}`);
if (fail) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }
