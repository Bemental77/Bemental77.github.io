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
];

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
const URL_RE = /(?:fetch\(|importScripts\(|\.src\s*=\s*|src\s*=\s*|href\s*=\s*)['"](\/[A-Za-z0-9_][A-Za-z0-9_./-]*?)(?:['"?#])/g;

// Split-asset prefixes: the page builds `<prefix><suffix>` (e.g. ROM chunks
// named partaa..partaf, per the ROM_CHUNKS array). The literal prefix is not a
// URL and asserting on it produces a false MISSING, so it is reported as a
// prefix and the FIRST real chunk is checked instead — which still catches a
// deploy filter that strips the whole directory.
const SPLIT_PREFIX_SUFFIXES = ['aa', 'ab', 'ac'];
const looksLikeSplitPrefix = (u) => /\.part$/.test(u) || /\.bin\.part$/.test(u);

const found = new Map();   // url -> Set(source)
const unchecked = [];

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

const urls = [...found.keys()].sort();
for (const u of urls) {
  if (looksLikeSplitPrefix(u)) {
    // Check the first real chunk instead of the (non-existent) prefix.
    const probe = u + SPLIT_PREFIX_SUFFIXES[0];
    const present = await check(probe);
    if (present) { ok.push(`${u}* (probed ${SPLIT_PREFIX_SUFFIXES[0]})`); }
    else { missing.push(probe); found.set(probe, found.get(u)); }
    continue;
  }
  const present = await check(u);
  if (present) { ok.push(u); continue; }
  (OPTIONAL.has(u) ? optionalMissing : missing).push(u);
}

console.log(`[deploy-assets] target=${liveMode ? origin : resolve(root)}`);
console.log(`[deploy-assets] ${ok.length} present · ${optionalMissing.length} optional-missing · ${missing.length} MISSING`);
for (const u of optionalMissing) console.log(`  optional  ${u}\n            (${OPTIONAL.get(u)})`);
for (const u of unchecked) console.log(`  unchecked ${u}`);
for (const u of missing) console.log(`  MISSING   ${u}\n            referenced by: ${[...found.get(u)].join(', ')}`);

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
