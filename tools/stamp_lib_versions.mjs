#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A STALE CACHE SERVED A STALE ENGINE, AND THE USER PAID FOR IT.
//
// caseybement.com sends `cache-control: max-age=600` on both the pages and the
// shared libs. So after a fix ships, a device that loaded the page inside that
// window keeps running the OLD lib/netplay.js against the NEW everything else.
// That is not hypothetical: the room-game forwarding fix went live, an emulated
// phone driven with a cache bypass loaded the host's disc correctly and parked
// at the barrier — and the user's real phone, on the same URL at the same time,
// sat at "0% loaded" pressing "I'm ready" against an engine that could not
// receive the room's disc. Same code shipped, two different outcomes, decided
// entirely by which bytes each device happened to be holding.
//
// "Hard-reload your phone" is not a fix, it is asking the player to know about
// our deploy cadence. So every shared lib is loaded with a `?v=<content hash>`:
// change the file and every page asks for a URL no cache has ever seen.
//
// --check verifies the stamps match the files on disk and exits nonzero if not,
// which is what makes this a GATE rather than a step someone has to remember.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

// Libs whose staleness can break a page's behaviour rather than just its looks.
const LIBS = ['lib/netplay.js', 'lib/asset_base.js', 'lib/capability.js', 'lib/bgz.js'];

const PAGES = [
  'index.html', 'dreamcast.html', 'gamecube.html', 'ps1.html', 'snes.html',
  'gba.html', 'genesis.html', 'n64/index.html',
  'dreamcast_multiplayer.html', 'gamecube_multiplayer.html', 'ps1_multiplayer.html',
  'snes_multiplayer.html', 'genesis_multiplayer.html', 'gba_multiplayer.html',
  'n64_multiplayer.html', 'multiplayer.html',
];

const CHECK = process.argv.includes('--check');

// ⚠ HASH WHAT SHIPS, NOT WHAT IS LYING IN THE WORKING TREE.
// The stamp exists to name the bytes a browser will actually download, and the
// deployed bytes are the COMMITTED ones. A working tree here routinely carries
// uncommitted work from parallel agents — lib/netplay.js had 365 uncommitted
// insertions at the moment this was written — so hashing the file on disk would
// mint a version string for content that never ships, and --check would then
// fail in CI against a tree that is perfectly correct.
// HEAD is the authority; --worktree is available for local iteration.
const FROM_WORKTREE = process.argv.includes('--worktree');
const hashOf = (p) => {
  let buf;
  if (FROM_WORKTREE) buf = readFileSync(p);
  else {
    try { buf = execSync(`git show HEAD:${p}`, { maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) { buf = readFileSync(p); }
  }
  return createHash('md5').update(buf).digest('hex').slice(0, 8);
};

const want = new Map();
for (const l of LIBS) if (existsSync(l)) want.set('/' + l, hashOf(l));

let changed = 0, stale = [], scanned = 0;

for (const page of PAGES) {
  if (!existsSync(page)) continue;
  scanned++;
  const before = readFileSync(page, 'utf8');
  let after = before;

  for (const [href, h] of want) {
    // Match the tag with or without an existing ?v=, and never touch anything else.
    const re = new RegExp('(<script\\s+src=")' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                          '(?:\\?v=[0-9a-f]+)?(")', 'g');
    after = after.replace(re, `$1${href}?v=${h}$2`);
  }

  if (after !== before) {
    if (CHECK) {
      // Report WHICH lib is stale on WHICH page — a bare "run the stamper" tells
      // the next person nothing about what actually drifted.
      for (const [href, h] of want) {
        const has = new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=' + h + '"').test(before);
        const refs = new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(before);
        if (refs && !has) stale.push(`${page} -> ${href} (want ?v=${h})`);
      }
    } else {
      writeFileSync(page, after);
      changed++;
    }
  }
}

if (CHECK) {
  for (const s of stale) console.log('  STALE  ' + s);
  console.log(`[lib-versions] ${scanned} page(s) · ${want.size} lib(s) · ${stale.length} stale reference(s)`);
  if (stale.length) {
    console.log('A page holding an old ?v= lets a browser reuse a cached lib against new page');
    console.log('code. Run: node tools/stamp_lib_versions.mjs');
    process.exit(1);
  }
} else {
  for (const [href, h] of want) console.log(`  ${href}?v=${h}`);
  console.log(`[lib-versions] stamped ${changed} page(s) of ${scanned}`);
}
