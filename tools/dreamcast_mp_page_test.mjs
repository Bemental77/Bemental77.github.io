#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE LEGACY LOBBIES' GAME LISTS, AGAINST THE TWO LISTS THEY WERE COPIED FROM.
//
// WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE.
//   It asserted the STREAMING guest: a video track, pixels sampled out of
//   #mpVideo, a pad mask on __dcmpMask, and the headline requirement that the
//   guest issue ZERO requests under /dreamcast/. Streaming was cancelled by
//   user directive 2026-09-08; under lockstep every player runs their own core
//   and therefore does pull the disc, so that requirement is now backwards.
//   tools/audit_all.mjs carried it anyway, labelled STALE and EXPECTED TO FAIL,
//   with a 30-minute budget and a 563 MB disc boot behind it.
//
//   It never reached any of that. Measured 2026-09-16, the run died on its
//   FIRST page assertion:
//       Error [TypeError]: Cannot read properties of null (reading 'hidden')
//       at evaluate ... dreamcast_mp_page_test.mjs:108
//   because #lobby no longer exists on dreamcast_multiplayer.html. So the one
//   check the audit table itself called "still live" — the disc-list drift —
//   never ran either. A permanently red cell that reaches none of its subjects
//   teaches people to read past failures, which is worse than no cell at all.
//
// WHAT IT IS NOW. Exactly that still-live check, and nothing else.
//   dreamcast_multiplayer.html:193-195 states the contract in its own words:
//   "Fetching dreamcast.html to read its <select id="romSelect"> would cost a
//   lobby the whole emulator page, so the list is copied and
//   tools/dreamcast_mp_page_test.mjs compares the two and FAILS on drift."
//   n64_multiplayer.html copies its list the same way. A copied list that
//   drifts is not cosmetic: lib/netplay.js refuses a pairing whose game names
//   differ, and the barrier FAILS the room when two machines load different
//   games (lib/netplay.js, _checkBarrier: 'different game: everyone must load').
//
//   No browser, no server, no disc — so it runs in CI, where the rig it
//   replaces could never go.
//
// USAGE   node tools/dreamcast_mp_page_test.mjs
// EXIT    0 = every copied list still matches its sources. 1 = drift.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'fs';
import vm from 'vm';

let pass = 0; const fails = [];
const ok  = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? ' — ' + d : '')); };
const bad = (n, why) => { fails.push(n); console.log('  FAIL  ' + n + '\n        ' + why); };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const need = {
  dcLobby: 'dreamcast_multiplayer.html',
  n64Lobby: 'n64_multiplayer.html',
  dcPage: 'dreamcast.html',
  n64Page: 'n64/index.html',
  oneUrl: 'multiplayer.html',
};
const src = {};
for (const [k, f] of Object.entries(need)) {
  src[k] = read(f);
  if (src[k] === null) {
    console.error(`[dreamcast-mp-page] FATAL: cannot read ${f} — refusing to report a pass`);
    process.exit(2);
  }
}

// ---- the five lists --------------------------------------------------------
// Each extractor is anchored on the literal the file actually ships, never on a
// line number: CLAUDE.md records line numbers going stale the moment anything
// above them is edited.
const between = (html, open, close) => {
  const i = html.indexOf(open);
  if (i < 0) return null;
  const j = html.indexOf(close, i + open.length);
  return j < 0 ? null : html.slice(i, j);
};

// dreamcast_multiplayer.html: var GAMES = [ { value: 'pso2', ... }, ... ];
const dcLobbyKeys = (html) => {
  const block = between(html, 'var GAMES = [', '];');
  return block ? [...block.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]) : null;
};
// dreamcast.html: <select id="romSelect"> <option value="pso2" ...
const dcPageKeys = (html) => {
  const block = between(html, '<select id="romSelect">', '</select>');
  return block ? [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]) : null;
};
// n64_multiplayer.html: var GAMES = [ 'Super Mario 64', "Conker's Bad Fur Day", ... ];
// ⚠ BOTH QUOTE STYLES. A single-quote-only pattern here read "Conker's Bad Fur
// Day" as the fragment `s Bad Fur Day",` and reported a drift that was purely
// the extractor's — the two titles that need double quotes are exactly the two
// this list has lost twice.
const n64LobbyKeys = (html) => {
  const block = between(html, 'var GAMES = [', '];');
  return block
    ? [...block.matchAll(/(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2])
    : null;
};
// n64/index.html: const ROMS = [ { label: '...' }, ... ]
const n64PageKeys = (html) => {
  const block = between(html, 'const ROMS = [', '];');
  return block
    ? [...block.matchAll(/label:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2])
    : null;
};
// multiplayer.html: the ONE lobby's catalogue, read through its own literal.
const oneUrlKeys = (html, sysKey) => {
  const start = html.indexOf('var CONSOLES = [');
  const end = html.indexOf('var BY_KEY = {};');
  if (start < 0 || end < 0) return null;
  const CONSOLES = vm.runInNewContext('(function(){ ' + html.slice(start, end) + ' return CONSOLES; })()');
  const c = CONSOLES.find((x) => x.key === sysKey);
  return c ? c.games.map((g) => g.key) : null;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (l) => (l === null ? '<could not parse>' : '[' + l.join(' | ') + ']');

const lists = {
  'dreamcast_multiplayer.html': dcLobbyKeys(src.dcLobby),
  'dreamcast.html':             dcPageKeys(src.dcPage),
  'multiplayer.html(dreamcast)': oneUrlKeys(src.oneUrl, 'dreamcast'),
  'n64_multiplayer.html':       n64LobbyKeys(src.n64Lobby),
  'n64/index.html':             n64PageKeys(src.n64Page),
  'multiplayer.html(n64)':      oneUrlKeys(src.oneUrl, 'n64'),
};

// A list that cannot be parsed is a FAILURE, never a skip: the extractor going
// blind is exactly how a drift gate silently stops gating.
for (const [name, l] of Object.entries(lists)) {
  if (l === null || l.length === 0) bad('list-parses-' + name, 'no game list could be read out of ' + name);
}

const compare = (n, aName, bName) => {
  const a = lists[aName], b = lists[bName];
  if (a === null || b === null) return;                  // already failed above
  same(a, b)
    ? ok(n, `${a.length} game(s), same order`)
    : bad(n, `${aName}=${show(a)}\n        ${bName}=${show(b)}\n        ` +
             'a copied list that drifts hands two machines different games, and the start barrier ' +
             'FAILS the room on that (lib/netplay.js _checkBarrier, "different game: everyone must load")');
};

compare('dreamcast-lobby-matches-the-emulator-page', 'dreamcast_multiplayer.html', 'dreamcast.html');
compare('dreamcast-lobby-matches-the-one-url-lobby', 'dreamcast_multiplayer.html', 'multiplayer.html(dreamcast)');
compare('n64-lobby-matches-the-emulator-page',       'n64_multiplayer.html',       'n64/index.html');
compare('n64-lobby-matches-the-one-url-lobby',       'n64_multiplayer.html',       'multiplayer.html(n64)');

console.log(`\n[dreamcast-mp-page] ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
