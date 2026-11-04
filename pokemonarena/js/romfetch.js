// pokemonarena/js/romfetch.js -- fetch the SoulGold v1.1.1 ROM the site already serves, with progress, and refuse
// anything that is not byte-identical to the pinned image.
//
// Browser + Node (it only needs fetch and, optionally, WebCrypto; both can be injected so a test can drive every
// failure path without a network). Nothing ROM-derived is stored here: only the URL and the pin.
//
//   import { romUrl, loadVerifiedRom, RomLoadError } from './romfetch.js';
//   try { const rom = await loadVerifiedRom({ onProgress: (got, total) => ... }); }
//   catch (e) { if (e instanceof RomLoadError) show(e.kind, e.message); }
//
// Error kinds (what the error screen switches on):
//   'missing'  the request failed or the server answered non-2xx (ROM not deployed / wrong ASSET_BASE / offline)
//   'length'   a 200 whose body is not 33,554,432 bytes (truncated download, an HTML 404 page served as 200, ...)
//   'format'   right length, but the cartridge header is not POKEMON EMER / BPEE / maker 01 / version 0
//   'hash'     header looks right but the SHA-256 is not the pinned v1.1.1 image (another build or a patched copy)
//
// The URL is built the way every page on the site builds a library URL: window.ASSET_BASE if it is a STRING
// (including the empty string, which is the "library ships in this repo" setting), otherwise '/gamedata'. It is
// typeof-guarded and NEVER `||`, because '' is falsy and `ASSET_BASE || '/gamedata'` would silently ignore the
// revert switch in lib/asset_base.js.

import { PINNED, identify, sha256HexFast } from './rom.js';
import { readCachedRom, writeCachedRom, dropCachedRom } from './romcache.js';

export const ROM_PATH = '/gba/gbaWasm/roms/Pokemon%20SoulGold%20(v1.1.1).gba';
export const DEFAULT_ASSET_BASE = '/gamedata';

export class RomLoadError extends Error {
  constructor(kind, message, details) {
    super(message);
    this.name = 'RomLoadError';
    this.kind = kind;
    this.details = details || null;
  }
}

// `scope` is the global object to read ASSET_BASE from (a test passes a stub).
export function romUrl(scope = globalThis) {
  const w = scope && scope.window ? scope.window : scope;
  const base = (w && typeof w.ASSET_BASE === 'string') ? w.ASSET_BASE : DEFAULT_ASSET_BASE;
  return base + ROM_PATH;
}

const mb = (n) => (n / 1048576).toFixed(1);

// Download `url` into one Uint8Array. onProgress(received, total) is called as chunks arrive; total is the
// Content-Length when the server sent one, else the pinned length (a gzip-encoded response reports the compressed
// size, which would make the bar overshoot, so the header is only trusted when it is not larger than the pin).
export async function fetchRom({ url = romUrl(), fetchImpl = globalThis.fetch, onProgress = null, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(url, signal ? { signal } : undefined);
  } catch (e) {
    throw new RomLoadError('missing', 'Could not request the ROM (' + (e && e.message ? e.message : e) + ') from ' + url, { url });
  }
  if (!res.ok) throw new RomLoadError('missing', 'The server answered HTTP ' + res.status + ' for the ROM at ' + url, { url, status: res.status });
  const header = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
  const total = header > 0 && header <= PINNED.length ? header : PINNED.length;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onProgress) onProgress(buf.length, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (e) { throw new RomLoadError('missing', 'The ROM download was interrupted after ' + mb(got) + ' MB (' + (e && e.message ? e.message : e) + ')', { url, got }); }
    if (r.done) break;
    chunks.push(r.value); got += r.value.length;
    if (onProgress) onProgress(got, Math.max(total, got));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// A reason string for people: JSON.stringify of a zeroed cartridge title put the literal characters \u0000 on the error screen.
// Runs of escaped NULs read as '(blank)', any other \uXXXX escape or raw control character as '?'.
export function readable(reason) {
  return String(reason)
    .replace(/(?:\\u0000)+/g, '(blank)')
    .replace(/\\u[0-9a-fA-F]{4}/g, '?')
    .replace(/[\x00-\x1f\x7f]/g, '?');
}

// Length -> header -> SHA-256, in that order, each with its own error kind. Returns { sha256 } on success.
export async function verifyRom(bytes, hasher = sha256HexFast) {
  if (!(bytes instanceof Uint8Array)) throw new RomLoadError('format', 'ROM bytes are not a Uint8Array');
  if (bytes.length !== PINNED.length) {
    throw new RomLoadError('length', 'The ROM file is ' + bytes.length + ' bytes; Pokemon SoulGold v1.1.1 is ' + PINNED.length + ' bytes (' + mb(PINNED.length) + ' MB). The download may be truncated, or the server returned a page instead of the ROM.', { length: bytes.length });
  }
  const quick = identify(bytes, { hash: 'none' });
  if (!quick.ok) {
    throw new RomLoadError('format', 'This file is not Pokemon SoulGold v1.1.1: ' + quick.reasons.map(readable).join('; ') + '.', { reasons: quick.reasons });
  }
  const sha = await hasher(bytes);
  if (sha !== PINNED.sha256) {
    throw new RomLoadError('hash', 'This is not the Pokemon SoulGold v1.1.1 image this page is built for (SHA-256 ' + sha.slice(0, 16) + '... instead of ' + PINNED.sha256.slice(0, 16) + '...). Another version or a modified copy will not work here.', { sha256: sha });
  }
  return { sha256: sha };
}

/**
 * Fetch (or recall) the ROM and verify it. -> { bytes, sha256, cached, verified } | (deferVerify, recalled copy) { bytes, sha256, cached: true, verify }
 *
 * THE PERSISTENT COPY (romcache.js). On a real page (no fetchImpl injected) a ROM that was verified on an earlier visit is read back from Cache Storage instead of downloaded again; a
 * copy is written only after a successful full verification. `persist: true | false` overrides the default; a test that injects fetchImpl never touches the cache.
 *
 * `deferVerify: true` is for a page that wants to put its first frame up at once (the hub): a recalled copy is returned immediately WITHOUT re-hashing, with `verify()` instead of `verified`:
 * calling it runs the full length + header + SHA-256 check (it rejects with the same RomLoadError and drops the stored copy). The caller must call it, and should do so right AFTER its first
 * frame: handing 32 MB to WebCrypto copies the buffer on the calling thread (measured ~25 ms at full speed, ~90 ms at 4x CPU), which is exactly what the first frame should not wait for.
 * Without `deferVerify` the check completes before this returns, as it always did (`verified` is then already resolved, and there is no `verify`). A freshly DOWNLOADED ROM is always
 * verified before this returns.
 */
export async function loadVerifiedRom(opts = {}) {
  const persist = opts.persist !== undefined ? !!opts.persist : (opts.fetchImpl === undefined && opts.hasher === undefined);
  if (persist) {
    const hit = await readCachedRom(opts);
    if (hit) {
      if (opts.onProgress) opts.onProgress(PINNED.length, PINNED.length);
      const check = async () => { try { return await verifyRom(hit.bytes, opts.hasher); } catch (e) { await dropCachedRom(opts); throw e; } };
      if (opts.deferVerify) return { bytes: hit.bytes, sha256: hit.sha256, cached: true, verify: check };
      try { const { sha256 } = await check(); return { bytes: hit.bytes, sha256, cached: true, verified: Promise.resolve({ sha256 }) }; } catch (_e) { /* the stored copy was bad and is gone: the network below decides */ }
    }
  }
  const bytes = await fetchRom(opts);
  const { sha256 } = await verifyRom(bytes, opts.hasher);
  if (persist) writeCachedRom(bytes, opts).catch(() => { /* a copy that could not be kept costs the next visit a download, nothing else */ });
  return { bytes, sha256, cached: false, verified: Promise.resolve({ sha256 }) };
}
