#!/usr/bin/env node
// Fail the deploy if a RUNTIME asset was stripped by the rsync exclude list.
//
// WHY THIS EXISTS (measured 2026-09-01, on the LIVE site):
//   Two shipped features were silently dead in production because the deploy
//   filter excluded directories that runtime code fetches:
//
//   * `dolphin_captures/sab.map`  — excluded by `--exclude='dolphin_captures'`.
//     `gamecube/dolphin-bridge/worker_funcs.js:654` fetches it at boot, and the
//     comment above that line spells out the consequence: only ~258 symbols
//     load, so the HLE patches for OSReport/___blank/OSPanic that depend on a
//     symbol-DB lookup do not all install, the wasm runs the real OSPanic body
//     on a fault, and it reaches PPCHalt. Sonic Adventure 2 Battle booted that
//     way for every visitor.
//
//   * `n64/bementalJIT/mips_emit.js` — excluded by `--exclude='bementalJIT'`.
//     An rsync pattern with no leading slash matches ANY path component, so a
//     rule meant for the two JIT SOURCE trees also stripped the N64 page's
//     runtime emitter. Proven with `rsync -n`: 0 files under `n64/bementalJIT`
//     were copied. Every JIT wave landed for N64 could never load in a browser.
//
//   Both files were present in git and on `prod`, and both returned 404 live —
//   which is exactly the failure a repo-side check cannot see. The artifact is
//   the only place this is observable, so the check runs against the artifact.
//
// USAGE
//   node tools/verify_deploy_assets.mjs <staged-dir>     # CI: after rsync
//   node tools/verify_deploy_assets.mjs --live <origin>  # spot-check a deploy
//
// It is deliberately conservative: it only asserts on ABSOLUTE, literal URLs it
// can see statically. A dynamically-built URL is reported as UNCHECKED rather
// than guessed at, so a pass never means more than it should.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { extractAll, selfTest, assetBase } from './catalog_urls.mjs';

// Files whose literal runtime URLs must resolve in the artifact. These are the
// entry points a browser actually loads — pages plus the worker shims/glue they
// spawn. Dev-only tooling is deliberately absent.
const SOURCES = [
  'gamecube.html',
  'dreamcast.html',
  'n64/index.html',
  'n64.html',
  'gamecube/dolphin-bridge/worker_funcs.js',
  'gamecube/dolphin_libretro/dolphin_worker.js',
  'dreamcast/flycast_libretro/flycast_worker.js',
  // The three older emulator pages were NOT covered until 2026-09-01. They are
  // as much a part of what a visitor hits as the GC/DC/N64 pages, and the same
  // rsync-exclude class of bug would have been just as invisible on them.
  'ps1.html',
  'gba.html',
  'snes.html',
  'gba/gbaWasm/dist/script.js',          // -> input_controller.js
  'gba/gbaWasm/dist/input_controller.js', // -> 44gba.js
  'genesis.html',
];

// Runtime assets that are REQUIRED but are never spelled out as a literal URL in
// any source, so the scanner above cannot see them. Each entry names the code
// that fetches it, because an unexplained entry here is just a wish list.
const ALWAYS_REQUIRED = new Map([
  // Emscripten sidecars, resolved at runtime through Module.locateFile.
  ['/ps1/ps1Wasm/dist/pcsx_ww.wasm',
   'ps1.html Module.locateFile = f => "/ps1/ps1Wasm/dist/" + f'],
  ['/ps1/ps1Wasm/dist/wasmpsx_worker.js',
   'ps1.html var_setup(): new Worker("/ps1/ps1Wasm/dist/wasmpsx_worker.js?v=" + Date.now())'],
  ['/ps1/ps1Wasm/dist/wasmpsx_worker.wasm',
   'wasmpsx_worker.js locateFile("wasmpsx_worker.wasm")'],
  ['/ps1/ps1Wasm/dist/wasmpsx_worker.data',
   'wasmpsx_worker.js preload package — it CONTAINS THE PSX BIOS at /bios/ps-41a.bin; without it the emulator has no BIOS to boot'],
  ['/gba/gbaWasm/dist/44gba.wasm',
   'gba script.js Module.locateFile = p => "/gba/gbaWasm/dist/" + p'],
  ['/snes/snesWasm/snes9x_2005.wasm',
   'snes.html Module.locateFile = p => "/snes/snesWasm/" + p'],
  // ⚠ THE ONE RUNTIME URL ON THE N64 PAGE THAT NOTHING CAN SEE. It is a bare
  // RELATIVE literal inside a vendored dist script — n64/N64Wasm/dist/script.js:253
  // `let file = 'assets.zip';` — and it resolves only because n64/index.html:49
  // sets <base href="/n64/N64Wasm/dist/">. No static scanner recovers it, and it
  // sits one directory away from n64/N64Wasm/roms, which deploy.exclude now
  // strips. A future exclusion widened from `/n64/N64Wasm/roms` to
  // `/n64/N64Wasm` would drop it in total silence — the same shape as the
  // mips_emit.js production 404 this file exists for.
  ['/n64/N64Wasm/dist/assets.zip',
   "n64/N64Wasm/dist/script.js:253 downloadFile('assets.zip'), resolved against <base href> on n64/index.html:49"],
  // Block-gzip disc reader, and the per-track block indexes. The reader is a
  // literal <script src>, but the worker reaches it through importScripts and
  // the indexes are only ever built as `base + file.index`, so nothing here is
  // a literal URL the scanner could see.
  //
  // ⚠ LOSING AN INDEX DOES NOT DEGRADE GRACEFULLY IN THE WAY THAT MATTERS. The
  // page refuses to stream without one and falls back to the EAGER path — which
  // for these tracks means a phone downloading the whole disc again, i.e. the
  // exact bug the format was built to remove, restored silently and only on
  // production. That is the same shape as the sab.map and mips_emit.js losses
  // this file already exists to catch.
  ['/lib/bgz.js', 'dreamcast.html <script src>, and flycast_worker.js importScripts("/lib/bgz.js")'],
  // (The six disc indexes that used to be listed here are DERIVED from the
  //  catalog now — see tools/catalog_urls.mjs. A list maintained beside the
  //  catalog is precisely what drifted and shipped four 404ing games while this
  //  very check reported "67 present · 0 MISSING".)
  // Built-in ROMs: fetched from an array literal, not a literal URL argument.
  ['/snes/snesWasm/roms/simcity.smc', 'snes.html ROMS[0].url'],
  ['/genesis/genesisWasm/dist/genesis_plus_gx.wasm',
   'genesis.html Module.locateFile = p => "/genesis/genesisWasm/dist/" + p'],
  // Both Mega Drive ROMs are listed explicitly: their names contain SPACES and
  // PARENTHESES, so they are exactly the kind of URL a static scanner should not
  // be trusted to recover from a source file, and a deploy filter that dropped
  // the directory would otherwise pass silently.
  ['/genesis/genesisWasm/roms/Sonic the Hedgehog 3 (USA).gen', 'genesis.html ROMS[0].url'],
  ['/genesis/genesisWasm/roms/X-Men (U).gen', 'genesis.html ROMS[1].url'],
  // (The PS1 chunk probe that used to be listed here is derived too — and now
  //  ALL EIGHT titles' chunks are, not just the first chunk of the default one.)
]);

// Known-optional at runtime: the code has an explicit graceful path, so a 404 is
// a slower start rather than a broken page. Each needs the citation that proves
// it, so this list cannot quietly become a place to bury real breakage.
const OPTIONAL = new Map([
  ['/gamecube/dolphin_libretro/handlereverb.bjaotm',
   'gamecube.html:2624 logs "[aot] fetch failed: ... — runtime compile only"'],
  ['/state.bin',
   'probe-only savestate served by tools/*_probe.js; never fetched by a real visit'],
]);

const args = process.argv.slice(2);
const liveMode = args[0] === '--live';
const root = liveMode ? '.' : (args[0] || '_deploy');
const origin = liveMode ? (args[1] || 'https://caseybement.com') : null;
// The git ref that is actually deployed. Sources are read from HERE in live
// mode so the question asked is 'is the DEPLOYED code missing an asset?'.
const liveRef = process.env.DEPLOY_REF || 'origin/prod';

// Absolute URLs whose PATH is literal, even when a suffix is appended.
//
// ⚠ THE FIRST VERSION OF THIS REGEX MISSED THE BUG THIS FILE EXISTS FOR.
// It required a closing quote immediately after the path, so
//   s.src = '/n64/bementalJIT/mips_emit.js?v=' + Date.now()
// did not match — and that file is one of the two production 404s that
// motivated the whole check. A guard that cannot catch its own founding case is
// decoration, so the terminator is now `?`, `#`, or the quote, and a trailing
// concatenation is allowed. `assertCatchesFoundingCases()` below pins both.
const URL_RE = /(?:fetch\(|importScripts\(|new\s+(?:Shared)?Worker\(|\.src\s*=\s*|src\s*=\s*|href\s*=\s*)['"](\/[A-Za-z0-9_][A-Za-z0-9_./-]*?)(?:['"?#])/g;

// Split-asset prefixes: the page builds `<prefix><suffix>` (e.g. ROM chunks
// named partaa..partaf, per the ROM_CHUNKS array). The literal prefix is not a
// URL and asserting on it produces a false MISSING, so it is reported as a
// prefix and the FIRST real chunk is checked instead — which still catches a
// deploy filter that strips the whole directory.
const SPLIT_PREFIX_SUFFIXES = ['aa', 'ab', 'ac'];
const looksLikeSplitPrefix = (u) => /\.part$/.test(u) || /\.bin\.part$/.test(u);

const found = new Map();   // url -> Set(source)
const unchecked = [];
const catalogFaults = [];         // structural faults in the catalog itself, not 404s
const skipDirAbsent = new Set();  // staged mode: whole disc dir absent from the checkout

// ---------------------------------------------------------------------------
// THE GAME CATALOGS — derived, never hand-listed, and now ALL FIVE of them.
//
// The extraction moved to tools/catalog_urls.mjs so that this check and
// tools/verify_live_catalogs.mjs read the catalogs from ONE place. It used to
// cover dreamcast.html only; gamecube.html, ps1.html, the N64 list and the GBA
// romlist were still represented by a handful of hand-written singleton URLs —
// i.e. by exactly the maintained-beside-it list that drifted and shipped four
// 404ing games while this file reported "67 present · 0 MISSING".
// ---------------------------------------------------------------------------

// ⚠ SOURCE/TARGET COHERENCE — a flaw this tool shipped with, caught in review.
// The first version read WORKING-TREE sources while checking LIVE URLs, which
// silently conflates two different questions: "is production broken right now?"
// and "will production break once I ship what I have?". It reported
// /lib/capability.js as a production 404 when no deployed page referenced it —
// the reference existed only in an uncommitted edit. In --live mode the sources
// must therefore come from the SAME ref that is deployed.
function readSource(path) {
  if (!liveMode) {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
  try {
    return execSync(`git show ${liveRef}:${path}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

for (const src of SOURCES) {
  const text = readSource(src);
  if (text === null) {
    unchecked.push(`${src}: not present in ${liveMode ? liveRef : 'the working tree'}`);
    continue;
  }
  for (const m of text.matchAll(URL_RE)) {
    const u = m[1];
    if (u.endsWith('/')) continue;                  // directory, not an asset
    if (!found.has(u)) found.set(u, new Set());
    found.get(u).add(src);
  }
  // Count the dynamic forms we deliberately do NOT assert on, so the report says
  // how much of the surface this check actually covers.
  const dyn = (text.match(/(?:fetch\(|importScripts\()\s*[`'"]?\s*(?:\$\{|['"]\s*\+)/g) || []).length;
  if (dyn) unchecked.push(`${src}: ${dyn} dynamically-built URL(s) not statically checkable`);

}

// ── EVERY CATALOG'S OWN URLS ────────────────────────────────────────────────
// Evaluated from the catalogs themselves. A parse failure is FATAL, never an
// empty list: a silently-empty catalog reports "0 MISSING", which is the exact
// PASS that shipped over four broken games.
{
  const { urls: catUrls, faults, unreadable } = extractAll(readSource);
  for (const f of faults) catalogFaults.push(f);
  for (const u of unreadable) {
    console.error('[deploy-assets] FATAL: could not read the catalog source ' + u +
      '. Refusing to report a result — a catalog that contributes nothing must not' +
      ' read as a pass.');
    process.exit(2);
  }
  for (const [u, why] of catUrls) {
    if (!found.has(u)) found.set(u, new Set());
    found.get(u).add(why);
  }
}

// ── OFFSITE URLS ────────────────────────────────────────────────────────────
// The game library is served from a SEPARATE Pages repo at the SAME ORIGIN
// (see deploy.exclude, the OFFSITE-BEGIN block). Those URLs are deliberately
// not in this artifact, so asking "is the file in _deploy?" about them is the
// wrong question — it would report every ROM and every disc part as MISSING.
//
// ⚠ THEY ARE NOT THEREFORE UNCHECKED, and this must never become a way to bury
// breakage. Existence-in-the-artifact simply cannot answer it;
// `node tools/verify_live_catalogs.mjs` resolves every one of them against the
// live origin with a real ranged GET, which is the only place the answer lives.
// This block only decides WHICH question each URL gets asked.
//
// The prefix is read from the page's own ASSET_BASE rather than written out
// here, so there is no second copy of it to drift.
const OFFSITE = (() => {
  const b = assetBase(readSource);   // lib/asset_base.js — the one constant
  return b ? (u) => u === b || u.startsWith(b + '/') : () => false;
})();
const offsite = [];

const missing = [], optionalMissing = [], ok = [];

async function check(u) {
  if (liveMode) {
    const r = await fetch(origin + u, { method: 'HEAD' }).catch(() => null);
    return r && r.ok;
  }
  const p = join(root, u.replace(/^\//, ''));
  try { return statSync(p).size > 0; } catch { return false; }
}

// SELF-TEST: the regex must catch both production 404s that motivated this file.
// Run unconditionally — a silent regression here makes every later PASS a lie.
function assertCatchesFoundingCases() {
  const cases = [
    ["s.src = '/n64/bementalJIT/mips_emit.js?v=' + Date.now();", '/n64/bementalJIT/mips_emit.js',
     'dynamic .src with a cache-busting query — the N64 JIT emitter, 404 in production'],
    ["var mapResp = await fetch('/dolphin_captures/sab.map');", '/dolphin_captures/sab.map',
     'plain fetch — the SAB symbol map, 404 in production'],
    ['<script src="/lib/capability.js"></script>', '/lib/capability.js',
     'plain script tag'],
    ["pcsx_worker = new Worker('/ps1/ps1Wasm/dist/wasmpsx_worker.js?v=' + Date.now());",
     '/ps1/ps1Wasm/dist/wasmpsx_worker.js',
     'new Worker() — a worker URL is as load-bearing as a script tag; ps1.html spawns its whole emulator this way'],
  ];
  for (const [src, want, why] of cases) {
    const hits = [...src.matchAll(URL_RE)].map((m) => m[1]);
    if (!hits.includes(want)) {
      console.error(`[deploy-assets] SELF-TEST FAILED: did not extract ${want}\n  from: ${src}\n  case: ${why}`);
      process.exit(2);
    }
  }
}
assertCatchesFoundingCases();

// SELF-TEST 2: the CATALOG extraction must catch ITS founding case — the
// 2026-09-08 break, where four games named .part*.gz files the bgz conversion
// had deleted. That test now lives beside the extraction it guards, in
// tools/catalog_urls.mjs, and additionally pins that ASSET_BASE is actually
// APPLIED — a silently-empty base would put every URL back on the old origin
// and still "resolve" in a staged check, which is the move-shaped version of
// the same false pass. A gate that cannot fail on the bug it was written for
// is decoration, and this one shipped a PASS over that exact bug once already.
selfTest();

for (const [u, why] of ALWAYS_REQUIRED) {
  if (!found.has(u)) found.set(u, new Set([`ALWAYS_REQUIRED (${why})`]));
}
const urls = [...found.keys()].sort();
for (const u of urls) {
  // Staged mode, whole disc directory not in the checkout — see the note in the
  // catalog block. Reported, never counted as breakage.
  if (skipDirAbsent.has(u)) continue;
  // Served from the asset repo — resolved by verify_live_catalogs.mjs instead.
  if (OFFSITE(u)) { offsite.push(u); continue; }
  if (looksLikeSplitPrefix(u)) {
    // Check the first real chunk instead of the (non-existent) prefix.
    // The chunk may be stored gzipped (the pages inflate it), so accept either
    // spelling. Checking only the raw name reported a FALSE MISSING for every
    // ROM the moment the libraries were compressed — the gate failed the deploy
    // on files that were present under a different extension.
    const probes = [u + SPLIT_PREFIX_SUFFIXES[0], u + SPLIT_PREFIX_SUFFIXES[0] + '.gz'];
    let hit = null;
    for (const probe of probes) { if (await check(probe)) { hit = probe; break; } }
    if (hit) { ok.push(`${u}* (probed ${hit.slice(u.length)})`); }
    else { missing.push(probes[0] + ' (and .gz)'); found.set(probes[0] + ' (and .gz)', found.get(u)); }
    continue;
  }
  const present = await check(u);
  if (present) { ok.push(u); continue; }
  (OPTIONAL.has(u) ? optionalMissing : missing).push(u);
}

if (skipDirAbsent.size) {
  unchecked.push(`dreamcast.html: ${skipDirAbsent.size} catalog URL(s) skipped — their disc ` +
                 `directory is absent from this checkout (use --live to assert on them)`);
}
console.log(`[deploy-assets] target=${liveMode ? origin : resolve(root)}`);
console.log(`[deploy-assets] ${ok.length} present · ${offsite.length} offsite · ` +
            `${optionalMissing.length} optional-missing · ${missing.length} MISSING`);
if (offsite.length) {
  console.log(`  offsite   ${offsite.length} catalog URL(s) are served from the asset repo at the same`);
  console.log(`            origin, so they are NOT expected in this artifact. Existence here`);
  console.log(`            cannot answer for them — resolve them against the live origin with:`);
  console.log(`              node tools/verify_live_catalogs.mjs`);
}
for (const u of optionalMissing) console.log(`  optional  ${u}\n            (${OPTIONAL.get(u)})`);
for (const u of unchecked) console.log(`  unchecked ${u}`);
for (const u of missing) console.log(`  MISSING   ${u}\n            referenced by: ${[...found.get(u)].join(', ')}`);

for (const f of catalogFaults) console.log(`  CATALOG   ${f}`);

// A structural catalog fault fails even when every URL resolves — that is the
// point of it. Silent disc corruption is strictly worse than a 404.
if (catalogFaults.length) {
  console.error(
    `\n[deploy-assets] FAIL — ${catalogFaults.length} structural fault(s) in the GAMES catalog.\n` +
    `These are NOT missing files; every URL may resolve. A .bgz file whose entry\n` +
    `has no index: loads COMPRESSED BYTES into the disc buffer as if they were\n` +
    `disc data (dreamcast.html:3614), which boots a corrupt disc instead of\n` +
    `failing. Wire the index: the way GAMES.gauntlet does.\n`);
  process.exit(1);
}

if (missing.length) {
  console.error(
    `\n[deploy-assets] FAIL — ${missing.length} runtime asset(s) referenced by shipped code are absent.\n` +
    `If a file is present in git but missing here, an rsync --exclude in\n` +
    `.github/workflows/deploy.yml stripped it. Note that a pattern WITHOUT a\n` +
    `leading slash matches ANY path component: '--exclude=bementalJIT' also\n` +
    `strips n64/bementalJIT. Root-anchor it ('/bementalJIT') or narrow it.\n`
  );
  process.exit(1);
}
console.log('[deploy-assets] PASS');
