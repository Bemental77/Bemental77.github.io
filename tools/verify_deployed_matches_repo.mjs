#!/usr/bin/env node
// DOES PRODUCTION SERVE WHAT THIS REPO CONTAINS?
//
// WHY THIS EXISTS. The Dreamcast lockstep desync fix was measured green by two
// independent rigs — cross 3/3 byte-identical at 1,800 frames, 10,800 frames and
// four players — on a wasm that existed ONLY in the working tree. It was never
// committed, so production served the PRE-FIX binary the entire time:
//
//   prod wasm sha256: 15def50b201cfbc3   _emscripten_lockstep_normalize: absent
//   repo wasm sha256: 44e7b5aa6e6a3e79   _emscripten_lockstep_normalize: present
//
// The page shipped and the core did not. dreamcast.html asked for the handshake,
// the deployed core had no such export, and the only reason anyone found out was
// that the worker answers `ok:false — relink` instead of failing silently.
//
// ⚠ THE STRUCTURAL POINT: every harness in this repo — the standing auditor
// included — runs against the WORKING TREE on the machine that built it. A
// built-but-uncommitted artifact therefore passes everything locally while
// production runs something else. No amount of local green can see that, because
// nothing was comparing the two. A LOCAL PASS IS NOT A DEPLOYMENT.
//
// This compares the bytes production actually serves against the bytes committed
// at HEAD. It is deliberately about HEAD, not the working tree: an artifact you
// have built but not committed is not going to be deployed, and saying so is the
// whole point.
//
// USAGE  node tools/verify_deployed_matches_repo.mjs [--origin https://...]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ORIGIN = (process.argv.includes('--origin')
  ? process.argv[process.argv.indexOf('--origin') + 1]
  : 'https://caseybement.com').replace(/\/$/, '');

// Runtime artifacts a visitor actually executes. A mismatch in any of these
// means the site is running different code from the one the tests measured.
const FILES = [
  'dreamcast/flycast_libretro/flycast_worker_emcc.wasm',
  'dreamcast/flycast_libretro/flycast_worker_emcc.js',
  'dreamcast/flycast_libretro/flycast_worker.js',
  'dreamcast.html',
  'lib/netplay.js',
  'lib/bgz.js',
  'gamecube/dolphin_libretro/dolphin_worker_emcc.wasm',
  'gamecube.html',
  'ps1.html', 'snes.html', 'gba.html', 'genesis.html', 'n64/index.html',
];

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

function atHead(path) {
  try { return execFileSync('git', ['cat-file', '-p', `HEAD:${path}`], { maxBuffer: 1 << 30 }); }
  catch (e) { return null; }
}

let bad = 0, missing = 0, ok = 0;
console.log(`comparing ${ORIGIN} against git HEAD (${execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()})\n`);

for (const f of FILES) {
  const head = atHead(f);
  if (!head) { console.log(`  SKIP  ${f}  (not tracked at HEAD)`); continue; }
  let live;
  try {
    const r = await fetch(`${ORIGIN}/${f}`, { cache: 'no-store' });
    if (!r.ok) { console.log(`  MISSING  ${f}  http ${r.status}`); missing++; continue; }
    live = Buffer.from(await r.arrayBuffer());
  } catch (e) { console.log(`  MISSING  ${f}  ${e.message}`); missing++; continue; }
  const a = sha(head), b = sha(live);
  if (a === b) { console.log(`  ok    ${f}  ${a}`); ok++; }
  else {
    // Size direction is a useful hint: a live file OLDER than HEAD is the
    // "deploy has not landed yet" case; equal-age-different-bytes is worse.
    console.log(`  STALE ${f}\n          HEAD ${a} (${head.length} B)\n          live ${b} (${live.length} B)`);
    bad++;
  }
}

console.log(`\n${ok} match, ${bad} STALE, ${missing} missing`);
if (bad || missing) {
  console.log('\nProduction is not serving what HEAD contains. Either a deploy has not');
  console.log('finished, or an artifact was built and never committed — the second is');
  console.log('invisible to every other test in this repo, which all read the working tree.');
}
process.exit(bad || missing ? 1 : 0);
