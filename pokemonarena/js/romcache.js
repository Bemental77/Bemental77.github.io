// pokemonarena/js/romcache.js -- a persistent copy of the VERIFIED ROM, so that coming back to the Arena does not download 32 MB again.
//
// WHY. Every Arena page (hub, battle, team editor) loads the 32 MiB SoulGold image through romfetch.js. The browser's HTTP cache may or may not keep an entry that large
// (it depends on the server's headers and on how much disk the browser gives its cache; the dev server sends no-store), so "back to the hub" could be a full download behind
// a loading screen. This keeps one copy in the browser's Cache Storage instead, under a key that contains the pinned SHA-256.
//
// WHAT IS STORED, AND WHEN. Only after romfetch.js has fetched the ROM and verified it end to end (length, cartridge header, SHA-256 against the pin), by the same origin, in this
// browser. The entry carries the pin, the length and a revision of this format in its headers. Nothing from the ROM is ever committed to the repository: this is the visitor's own
// browser storage, holding the visitor's own download of the file the site already serves, exactly as the HTTP cache would.
//
// WHAT IS TRUSTED ON THE WAY BACK. An entry is used only if its headers name the current pin, the current length and the current revision, its body is exactly the pinned length,
// and its cartridge header still identifies as SoulGold v1.1.1. ANYTHING ELSE deletes the entry and means "go to the network": every failure here is a cache miss, never an error
// (Cache Storage can be missing, blocked, full, or evicted at any moment: private browsing, a locked-down browser, a quota). The SHA-256 itself is re-checked by the caller
// (the `verify()` that romfetch.js hands back with a deferred copy), right after the first frame on the hub; a mismatch drops the entry (dropCachedRom) and the page reloads through the full
// path. A copy that passes the cheap checks above but is corrupt INSIDE (a table the menu decodes) is not shown for a frame at all: boot.js start() hashes it on the spot and does the same.
//
// Pure of the DOM: `caches` is injectable, so tools/pokemonarena_hub_return_test.mjs drives every path in Node with a fake.

import { PINNED, identify } from './rom.js';

export const ROMCACHE_REV = 1;
export const CACHE_PREFIX = 'arena-rom-v';
export const CACHE_NAME = CACHE_PREFIX + ROMCACHE_REV;
/** Every key this module writes starts with this; the one entry that lives in the current cache is KEY_PREFIX + the pin. */
export const KEY_PREFIX = '/pokemonarena/.cache/rom-';
/** The key under which the one entry lives: it contains the pin, so a different pinned ROM is a different key. */
export const CACHE_KEY = KEY_PREFIX + PINNED.sha256;

// the path of a cache key: a Request (the real Cache API lists those, with an absolute URL) or a plain string (the test fake)
const keyPath = (k) => { const s = typeof k === 'string' ? k : (k && k.url) || ''; try { return new URL(s, 'http://x').pathname; } catch (_e) { return s; } };

// READING `caches` can itself throw (SecurityError: a browser with site data blocked), so the lookup is guarded like everything else here
const store = (opts) => {
  try {
    const c = opts && opts.caches !== undefined ? opts.caches : (typeof globalThis !== 'undefined' ? globalThis.caches : undefined);
    return c && typeof c.open === 'function' ? c : null;
  } catch (_e) { return null; }
};

/** -> { bytes: Uint8Array, sha256 } | null. Never throws. A bad entry is deleted. */
export async function readCachedRom(opts = {}) {
  const caches = store(opts);
  if (!caches) return null;
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const res = await cache.match(CACHE_KEY);
    if (!res) return null;
    const h = res.headers;
    const sha = h && h.get ? h.get('x-arena-sha256') : null, len = h && h.get ? Number(h.get('x-arena-length')) : NaN, rev = h && h.get ? h.get('x-arena-rev') : null;
    if (sha !== PINNED.sha256 || len !== PINNED.length || rev !== String(ROMCACHE_REV)) { await drop(cache); return null; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== PINNED.length || !identify(bytes, { hash: 'none' }).ok) { await drop(cache); return null; }
    return { bytes, sha256: sha };
  } catch (_e) {
    try { if (cache) await drop(cache); } catch (_e2) { /* nothing more to do */ }
    return null;
  }
}

async function drop(cache) { try { await cache.delete(CACHE_KEY); } catch (_e) { /* ignore */ } }

/** Keep a verified copy. Call ONLY with bytes that have passed verifyRom. -> true when stored. Never throws. */
export async function writeCachedRom(bytes, opts = {}) {
  const caches = store(opts);
  if (!caches || !(bytes instanceof Uint8Array) || bytes.length !== PINNED.length) return false;
  try {
    // an older revision (its own cache NAME) is dead weight: 32 MB each
    if (typeof caches.keys === 'function') for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) { try { await caches.delete(name); } catch (_e) { /* ignore */ } }
    const cache = await caches.open(CACHE_NAME);
    // ... and so is a copy of a previously pinned ROM: the cache NAME holds only the revision, the pin is in the KEY, so a new pin without a revision bump would otherwise keep the old 32 MB beside the new one
    if (typeof cache.keys === 'function') for (const k of await cache.keys()) { const p = keyPath(k); if (p.startsWith(KEY_PREFIX) && p !== CACHE_KEY) { try { await cache.delete(k); } catch (_e) { /* ignore */ } } }
    await cache.put(CACHE_KEY, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-arena-sha256': PINNED.sha256, 'x-arena-length': String(PINNED.length), 'x-arena-rev': String(ROMCACHE_REV) } }));
    return true;
  } catch (_e) { return false; }        // quota, blocked, private mode: the next visit simply downloads again
}

/** Forget the stored copy (a re-check failed, or a test). Never throws. */
export async function dropCachedRom(opts = {}) {
  const caches = store(opts);
  if (!caches) return false;
  try { const cache = await caches.open(CACHE_NAME); return await cache.delete(CACHE_KEY); } catch (_e) { return false; }
}
