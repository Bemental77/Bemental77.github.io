#!/usr/bin/env node
// EVERY URL THE SITE'S GAME CATALOGS ACTUALLY NAME — derived, never hand-listed.
//
// WHY THIS MODULE EXISTS (measured 2026-09-08, on the LIVE site): four of five
// Dreamcast games 404'd their disc in production WHILE tools/verify_deploy_assets.mjs
// PASSED at "67 present · 0 MISSING". A commit had converted every disc to
// block-gzip and deleted the old .gz parts, but updated only ONE catalog entry.
// Every file the check knew about existed; the catalog simply NAMED DIFFERENT
// ONES. "Does this file exist?" cannot see that. The only question that can is
// "does every URL the catalog NAMES resolve?"
//
// verify_deploy_assets.mjs learned that lesson for dreamcast.html alone. The
// other four catalogs — gamecube.html, ps1.html, the GBA romlist and the N64
// list — were still covered by a handful of hand-written singleton URLs, i.e.
// by exactly the maintained-beside-it list that drifted. Moving the whole
// library to a separate origin is precisely the change that would break all
// five at once, so the extraction is centralised here and both checkers read it.
//
// THE CATALOGS ARE DATA, NOT URL LITERALS. Part names are built with
// `.map(s => name + s + ext)` and chunk names with a character-code loop, so no
// static regex can recover them. Each catalog's own source slice is therefore
// EVALUATED, in a bare context with no globals except the `window.ASSET_BASE`
// the page itself sets — which is also read from the page rather than assumed,
// so this file holds no copy of it to drift.

import { runInNewContext } from 'node:vm';

// A parse failure must be LOUD. A silently-empty catalog reports "0 MISSING",
// which is the exact PASS that shipped over four broken games.
export class CatalogError extends Error {}

// The site's single asset-origin constant. It lives in lib/asset_base.js — ONE
// file for the whole site, so the split is revertible by editing one line — and
// it is READ here rather than copied, so this module cannot drift from it.
//
// ⚠ ANCHORED AT START-OF-LINE, and that is not cosmetic. lib/asset_base.js
// documents the switch with example assignments in its own comment header:
//     //     window.ASSET_BASE = '';
//     //     window.ASSET_BASE = '/gamedata';
// An unanchored regex matches the FIRST of those and reports the base as '',
// which would silently strip the prefix off all 207 catalog URLs and check the
// OLD paths — a green run proving nothing about what the site actually fetches.
export const ASSET_BASE_FILE = 'lib/asset_base.js';
export function assetBaseFromSource(text) {
  const m = /^window\.ASSET_BASE\s*=\s*'([^']*)'/m.exec(text);
  return m ? m[1] : null;
}
export function assetBase(read) {
  const t = read(ASSET_BASE_FILE);
  if (t === null || t === undefined) {
    throw new CatalogError(ASSET_BASE_FILE + ': not readable — cannot resolve any catalog URL');
  }
  const b = assetBaseFromSource(t);
  if (b === null) {
    throw new CatalogError(ASSET_BASE_FILE + ': no top-level `window.ASSET_BASE = \'...\'` assignment');
  }
  return b;
}

// Evaluate a slice of page source and hand back the named bindings. The sandbox
// has no globals beyond a stub `window`, so anything that reaches for the DOM,
// the network or the filesystem throws instead of silently yielding undefined.
function evalSlice(src, want, base, what) {
  const sandbox = Object.create(null);
  sandbox.window = { ASSET_BASE: base };
  let out;
  try {
    out = runInNewContext(src + '\n({' + want.map((w) => w + ':' + w).join(',') + '});',
                          sandbox, { timeout: 5000, filename: what });
  } catch (e) {
    throw new CatalogError(`${what}: ${e.message}`);
  }
  return out;
}

// Slice from `from` to the first `to` that follows `after`. Returns null when
// the shape is not there, so a caller can report it rather than guess.
function slice(text, from, after, to) {
  const i = text.indexOf(from);
  if (i < 0) return null;
  const a = text.indexOf(after, i);
  if (a < 0) return null;
  const j = text.indexOf(to, a);
  if (j < 0) return null;
  return text.slice(i, j + to.length);
}

// ── dreamcast.html — the five disc catalogs ────────────────────────────────
// Split files carry `parts[]` plus an `index` (.bgzi.json). The structural rule
// below is the one thing no amount of URL-resolving can express.
function dreamcast(text, faults, base) {
  const s = slice(text, 'const GAMES = {', 'const GAMES = {', '\n  };');
  if (!s) throw new CatalogError('dreamcast.html: could not locate the GAMES catalog');
  const { GAMES } = evalSlice(s, ['GAMES'], base, 'dreamcast.html GAMES');
  if (!GAMES || !Object.keys(GAMES).length) {
    throw new CatalogError('dreamcast.html: GAMES evaluated empty');
  }
  const out = [];
  for (const [key, g] of Object.entries(GAMES)) {
    // Not deployed on purpose — dreamcast.html relabels the option and refuses
    // to launch it. Asserting on it would be a false red.
    if (g.hosted === false) continue;
    if (!g.base) { faults.push(`GAMES.${key} has no base`); continue; }
    for (const f of g.files || []) {
      const why = `dreamcast.html GAMES.${key} files[${f.name}]`;
      if (f.parts) {
        // ⚠ THE RULE THIS GATE WILL NOT TRADE FOR SPEED. The extension test in
        // fetchDiscInto is /\.gz$/, which does NOT match ".bgz" — so a .bgz file
        // with no index makes the EAGER path write COMPRESSED bytes into the
        // disc buffer. Every URL would resolve and the game would still be
        // broken. A 404 is loud and recoverable; silent corruption is neither.
        if (f.parts.some((n) => /\.bgz$/.test(n)) && !f.index) {
          faults.push(`GAMES.${key} ${f.name} has .bgz parts but no index: — the eager ` +
                      `path would write COMPRESSED bytes into the disc buffer`);
        }
        if (f.index) out.push([g.base + f.index, why + ' .index']);
        for (const n of f.parts) out.push([g.base + n, why + ' .parts[]']);
      } else {
        out.push([g.base + f.name, why]);
      }
    }
    if (g.cue && !(g.files || []).some((f) => f.name === g.cue)) {
      out.push([g.base + g.cue, `dreamcast.html GAMES.${key}.cue`]);
    }
  }
  return out;
}

// ── gamecube.html / ps1.html — ROM_ROOT + chunkRange + ROMS ────────────────
// Both pages share the shape: a ROM_ROOT constant, a chunkRange() that builds
// `.bin.parta<letter>.gz` names by character code, and a ROMS array whose
// `chunks` field is the URL list. Entry 4 on the GameCube page concatenates
// ROM_ROOT inline instead, which the evaluation picks up for free.
function chunked(text, src, base) {
  const s = slice(text, 'const ROM_ROOT', 'const ROMS = [', '\n  ];');
  if (!s) throw new CatalogError(`${src}: could not locate ROM_ROOT/ROMS`);
  const { ROMS } = evalSlice(s, ['ROMS'], base, `${src} ROMS`);
  if (!Array.isArray(ROMS) || !ROMS.length) {
    throw new CatalogError(`${src}: ROMS evaluated empty`);
  }
  const out = [];
  for (const r of ROMS) {
    for (const u of r.chunks || []) out.push([u, `${src} ROMS[${r.label}].chunks`]);
  }
  return out;
}

// ── n64/index.html — filenames only; the directory is the fetch prefix ─────
// The list carries `file:` names with no directory at all. The prefix lives in
// loadRom(), so it is read from there rather than assumed — that is the whole
// reason this page's ROM path was invisible to a static URL scanner before.
function n64(text, base) {
  const s = slice(text, 'const ROMS = [', 'const ROMS = [', '\n  ];');
  if (!s) throw new CatalogError('n64/index.html: could not locate ROMS');
  const { ROMS } = evalSlice(s, ['ROMS'], base, 'n64/index.html ROMS');
  const m = /await fetch\(window\.ASSET_BASE \+ '([^']+)' \+ rom\.file\)/.exec(text);
  if (!m) throw new CatalogError('n64/index.html: could not read the ROM fetch prefix in loadRom()');
  const prefix = base + m[1];
  return ROMS.map((r) => [prefix + r.file, `n64/index.html ROMS[${r.label}]`]);
}

// ── the two romlist.js files — plain data, but built off their own base ────
function romlist(text, src, base) {
  const { ROMLIST } = evalSlice(text, ['ROMLIST'], base, src);
  if (!Array.isArray(ROMLIST) || !ROMLIST.length) {
    throw new CatalogError(`${src}: ROMLIST evaluated empty`);
  }
  return ROMLIST.map((r) => [r.url, `${src} ROMLIST[${r.title}]`]);
}

// Every catalog, keyed by the source file it is read from. `read(path)` returns
// the file's text or null; a null source is reported as unreadable rather than
// quietly contributing zero URLs — a catalog that vanishes must not read as a
// pass. Every extractor is handed the ONE base resolved from lib/asset_base.js.
export const CATALOGS = [
  { src: 'dreamcast.html', extract: (t, f, base) => dreamcast(t, f, base) },
  { src: 'gamecube.html',  extract: (t, f, base) => chunked(t, 'gamecube.html', base) },
  { src: 'ps1.html',       extract: (t, f, base) => chunked(t, 'ps1.html', base) },
  { src: 'n64/index.html', extract: (t, f, base) => n64(t, base) },
  { src: 'gba/gbaWasm/dist/romlist.js',
    extract: (t, f, base) => romlist(t, 'gba/gbaWasm/dist/romlist.js', base) },
];

// Returns { urls: [[url, why], ...], faults: [...], unreadable: [...] }.
export function extractAll(read) {
  const urls = [], faults = [], unreadable = [];
  // Resolved ONCE, from lib/asset_base.js, and handed to every extractor.
  const base = assetBase(read);
  for (const c of CATALOGS) {
    const text = read(c.src);
    if (text === null || text === undefined) { unreadable.push(c.src); continue; }
    try {
      for (const pair of c.extract(text, faults, base)) urls.push(pair);
    } catch (e) {
      if (e instanceof CatalogError) faults.push(e.message);
      else throw e;
    }
  }
  return { urls, faults, unreadable };
}

// SELF-TEST — the extraction must fail LOUDLY on its own founding cases, and a
// checker that cannot fail on the bug it was written for is decoration. Run by
// both callers at startup, so a silent regression here cannot make a PASS a lie.
export function selfTest() {
  const BASE = "// window.ASSET_BASE = '';   <- an EXAMPLE in the comment header\n" +
               "window.ASSET_BASE = '/gamedata';\n";
  const readStub = (p) => (p === ASSET_BASE_FILE ? BASE : null);

  // 1. THE COMMENT TRAP. lib/asset_base.js documents the switch with example
  //    assignments in its own header. An unanchored regex matches the FIRST of
  //    those and reports '', which strips the prefix off every catalog URL and
  //    checks the OLD paths — a green run proving nothing.
  if (assetBase(readStub) !== '/gamedata') {
    throw new Error('catalog_urls SELF-TEST FAILED: assetBase() picked up a COMMENTED example, got ' +
                    JSON.stringify(assetBase(readStub)));
  }
  // 2. '' MUST SURVIVE AS ''. It is the reverted value, and `||` would turn it
  //    back into '/gamedata' — a revert that silently does not revert.
  if (assetBaseFromSource("window.ASSET_BASE = '';\n") !== '') {
    throw new Error("catalog_urls SELF-TEST FAILED: the reverted value '' did not survive");
  }
  // 3. A MISSING constant file must THROW, never quietly yield ''.
  let threwBase = false;
  try { assetBase(() => null); } catch (e) { threwBase = e instanceof CatalogError; }
  if (!threwBase) throw new Error('catalog_urls SELF-TEST FAILED: a missing asset_base.js did not throw');

  // 4. The 2026-09-08 break: .map()-built part names a static regex cannot see.
  const BROKEN = [
    "  const GAMES = {",
    "    sa2: { name: 'x', base: window.ASSET_BASE + '/dreamcast/discs/sa2/', cue: 'S.cue',",
    "      files: [ { name: 'Track1.bin' },",
    "        { name: 'Track3.bin', bytes: 1,",
    "          parts: ['aa','ab'].map(s => 'Track3.bin.part' + s + '.gz') },",
    "        { name: 'S.cue' } ] },",
    "  };",
  ].join('\n');
  const faults = [];
  const got = dreamcast(BROKEN, faults, '/gamedata').map(([u]) => u);
  for (const w of ['/gamedata/dreamcast/discs/sa2/Track3.bin.partaa.gz',
                   '/gamedata/dreamcast/discs/sa2/Track3.bin.partab.gz',
                   '/gamedata/dreamcast/discs/sa2/Track1.bin']) {
    if (!got.includes(w)) {
      throw new Error(`catalog_urls SELF-TEST FAILED: did not yield ${w}\n  got: ${got.join(', ')}`);
    }
  }
  // 5. The base must actually be APPLIED to every URL.
  if (got.some((u) => !u.startsWith('/gamedata/'))) {
    throw new Error('catalog_urls SELF-TEST FAILED: a URL escaped the ASSET_BASE prefix');
  }
  // 6. The silent-corruption rule: .bgz parts with no index: must fault.
  const before = faults.length;
  dreamcast(BROKEN.replace(/\.gz'\)/, ".bgz')"), faults, '');
  if (faults.length !== before + 1) {
    throw new Error('catalog_urls SELF-TEST FAILED: .bgz parts with no index: did not fault');
  }
  // 7. A catalog that will not parse must THROW, never return empty.
  let threw = false;
  try { dreamcast('const GAMES = {\n  };', [], ''); } catch { threw = true; }
  if (!threw) throw new Error('catalog_urls SELF-TEST FAILED: an empty catalog did not throw');
}
