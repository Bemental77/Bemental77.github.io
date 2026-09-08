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
import { runInNewContext } from 'node:vm';

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
  ['/dreamcast/discs/pso2/Track3.bin.bgzi.json', 'dreamcast.html GAMES.pso2 files[].index'],
  ['/dreamcast/discs/cannonspike/Track3.bin.bgzi.json', 'dreamcast.html GAMES.cannonspike files[].index'],
  ['/dreamcast/discs/sa2/Track3.bin.bgzi.json', 'dreamcast.html GAMES.sa2 files[].index'],
  ['/dreamcast/discs/gauntlet/Track3.bin.bgzi.json', 'dreamcast.html GAMES.gauntlet files[].index'],
  ['/dreamcast/discs/gauntlet/Track5.bin.bgzi.json', 'dreamcast.html GAMES.gauntlet files[].index'],
  ['/dreamcast/discs/mvc2/MvC2.cdi.bgzi.json', 'dreamcast.html GAMES.mvc2 files[].index'],
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
  // PS1 discs are split; the page builds chunk names arithmetically from
  // ROM_ROOT + base + ".bin.parta" + <letter>, so probe the first chunk of the
  // default title. A deploy filter that strips the directory shows up here.
  // .gz because the ROM libraries are gzipped and inflated by the page — see
  // the chunkRange note in ps1.html. The raw name no longer exists anywhere.
  ['/ps1/ps1Wasm/roms/MonsterRancher2.bin.partaa.gz', 'ps1.html ROMS[0] chunkRange("MonsterRancher2","f")'],
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
// THE DREAMCAST DISC CATALOG — derived, never hand-listed.
//
// WHY THIS EXISTS (measured 2026-09-08, on the LIVE site): four of five
// Dreamcast games 404'd their disc in production WHILE THIS CHECK PASSED, 67
// present / 0 MISSING. A commit converted every disc to block-gzip (.bgz plus a
// .bgzi.json block index) and DELETED the old .gz parts, but updated only
// gauntlet's GAMES entry. Every file the check knew about existed; the catalog
// simply NAMED DIFFERENT ONES. "Does this file exist?" cannot see that. The
// only question that can is "does every URL the catalog NAMES resolve?", so the
// URL list is now derived FROM the catalog instead of maintained beside it —
// a list maintained beside it is precisely what drifted.
//
// The parts are built as .map(s => name + s + ext), so no static regex can
// recover them. The object literal is evaluated instead, in a bare context with
// no globals: it is pure data plus arrow functions over string literals.
function extractGames(text, srcName) {
  const i = text.indexOf('const GAMES = {');
  if (i < 0) return null;
  const j = text.indexOf('\n  };', i);
  if (j < 0) return null;
  // A parse failure must be LOUD. If this silently returned {}, the check would
  // go straight back to reporting 0 MISSING on a catalog that names nothing
  // which exists — the exact production failure above, wearing a PASS.
  const g = runInNewContext(text.slice(i, j + 5) + '\nGAMES;', Object.create(null),
                            { timeout: 5000, filename: srcName });
  if (!g || typeof g !== 'object' || !Object.keys(g).length) return null;
  return g;
}

// Every URL a game's entry names, plus the one structural rule that no amount
// of URL-resolving can express.
function catalogUrls(games) {
  const out = [];
  for (const [key, g] of Object.entries(games)) {
    // Not deployed on purpose — dreamcast.html:2152 relabels the option and
    // :3685 refuses to launch it. Asserting on it would be a false red.
    if (g.hosted === false) continue;
    const base = g.base;
    if (!base) { catalogFaults.push('GAMES.' + key + ' has no base'); continue; }
    for (const f of g.files || []) {
      const why = 'dreamcast.html GAMES.' + key + ' files[' + f.name + ']';
      if (f.parts) {
        // ⚠ THE RULE THIS GATE WILL NOT TRADE FOR SPEED. Per dreamcast.html:3614,
        // the extension test in fetchDiscInto is /\.gz$/, which does NOT match
        // ".bgz" — so a .bgz file with no index makes the EAGER path "silently
        // write COMPRESSED bytes" into the disc buffer. That is a corrupt disc
        // that still loads, not a clean failure. Every URL below would resolve
        // and the game would still be broken, so this is checked structurally
        // rather than by fetching anything. A 404 is loud and recoverable;
        // silent corruption is neither.
        if (f.parts.some((n) => /\.bgz$/.test(n)) && !f.index) {
          catalogFaults.push(
            'GAMES.' + key + ' ' + f.name + ' has .bgz parts but no index: — the eager path ' +
            'would write COMPRESSED bytes into the disc buffer (dreamcast.html:3614)');
        }
        if (f.index) out.push([base + f.index, why + ' .index']);
        for (const n of f.parts) out.push([base + n, why + ' .parts[]']);
      } else {
        out.push([base + f.name, why]);
      }
    }
    if (g.cue && !(g.files || []).some((f) => f.name === g.cue)) {
      out.push([base + g.cue, 'dreamcast.html GAMES.' + key + '.cue']);
    }
  }
  return out;
}

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

  // The disc catalog is DATA, not a URL literal — evaluate it and expand it.
  if (src === 'dreamcast.html') {
    const games = extractGames(text, src);
    if (!games) {
      console.error('[deploy-assets] FATAL: could not evaluate the GAMES catalog in ' + src +
        '. Refusing to report a result — this check PASSED at 67 present / 0 MISSING while ' +
        'four games were 404 in production, and a silently-empty catalog is that same PASS.');
      process.exit(2);
    }
    for (const [u, why] of catalogUrls(games)) {
      if (!found.has(u)) found.set(u, new Set());
      found.get(u).add(why);
    }
    // STAGED MODE ONLY: the CI checkout omits dreamcast/discs entirely — which
    // is why this harness had to be marked ci:false, since it reported MISSING
    // for files that were deployed fine and so nobody read the red. An ABSENT
    // DIRECTORY is not evidence of breakage; a PRESENT directory missing a
    // NAMED file is. Live mode has no such excuse and asserts on everything.
    if (!liveMode) {
      for (const [k, g] of Object.entries(games)) {
        if (g.hosted === false || !g.base) continue;
        if (!existsSync(join(root, g.base.replace(/^\//, '')))) {
          for (const [u] of catalogUrls({ [k]: g })) skipDirAbsent.add(u);
        }
      }
    }
  }
}

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

// SELF-TEST 2: the catalog expansion must catch ITS founding case — the
// 2026-09-08 break, where four games named .part*.gz files the bgz conversion
// had deleted. A gate that cannot fail on the bug it was written for is
// decoration, and this one shipped a PASS over that exact bug once already.
function assertCatchesCatalogFoundingCases() {
  const BROKEN = [
    "  const GAMES = {",
    "    sa2: { name: 'x', base: '/dreamcast/discs/sa2/', cue: 'S.cue',",
    "      files: [ { name: 'Track1.bin' },",
    "        { name: 'Track3.bin', bytes: 1,",
    "          parts: ['aa','ab'].map(s => 'Track3.bin.part' + s + '.gz') },",
    "        { name: 'S.cue' } ] },",
    "  };",
  ].join('\n');
  const g = extractGames(BROKEN, 'self-test');
  if (!g) { console.error('[deploy-assets] SELF-TEST FAILED: catalog would not evaluate'); process.exit(2); }
  const urls = catalogUrls(g).map(([u]) => u);
  // The .map()-built part names are the whole point: a static regex sees none
  // of these, which is why the 404s were invisible.
  for (const want of ['/dreamcast/discs/sa2/Track3.bin.partaa.gz',
                      '/dreamcast/discs/sa2/Track3.bin.partab.gz',
                      '/dreamcast/discs/sa2/Track1.bin']) {
    if (!urls.includes(want)) {
      console.error('[deploy-assets] SELF-TEST FAILED: catalog expansion did not yield ' + want +
                    '\n  got: ' + urls.join(', '));
      process.exit(2);
    }
  }
  // And the silent-corruption rule: .bgz parts with no index: must fault.
  const before = catalogFaults.length;
  catalogUrls(extractGames(BROKEN.replace(/\.gz'\)/, ".bgz')"), 'self-test'));
  if (catalogFaults.length !== before + 1) {
    console.error('[deploy-assets] SELF-TEST FAILED: .bgz parts with no index: did not fault');
    process.exit(2);
  }
  catalogFaults.length = before;   // discard the synthetic fault
}
assertCatchesCatalogFoundingCases();

for (const [u, why] of ALWAYS_REQUIRED) {
  if (!found.has(u)) found.set(u, new Set([`ALWAYS_REQUIRED (${why})`]));
}
const urls = [...found.keys()].sort();
for (const u of urls) {
  // Staged mode, whole disc directory not in the checkout — see the note in the
  // catalog block. Reported, never counted as breakage.
  if (skipDirAbsent.has(u)) continue;
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
console.log(`[deploy-assets] ${ok.length} present · ${optionalMissing.length} optional-missing · ${missing.length} MISSING`);
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
