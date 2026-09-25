#!/usr/bin/env node
// tools/multiplayer_page_test.mjs — THE ONE-URL LOBBY'S CATALOGUE MUST MATCH
// EVERY PAGE IT HANDS OFF TO, AND EVERY PAGE MUST READ WHAT IT SENDS.
//
// multiplayer.html copies each console's game list (fetching six emulator pages
// to read their ROMS[] would cost a lobby the whole site). lib/netplay.js
// REFUSES a pairing whose game names differ, so a copied key that drifts from
// the page's own list fails the pairing with "the other player is on <game>" —
// and a lobby is the last place a player would look for that. This is the
// gate: it parses the lobby's catalogue and each page's live list, in order,
// and FAILS on any difference. n64_multiplayer.html's copy had already drifted
// two titles behind n64/index.html when this file was written.
//
// It also checks the other half of the contract: that each page's ?np=
// receiver reads the parameters the lobby sends (np, game, join, and host=1 on
// the three cartridge pages), so a hand-off cannot silently land on a page that
// ignores half of its URL.
//
// STATIC AND FAST — no browser, no server. Run from the repo root:
//   node tools/multiplayer_page_test.mjs
import { readFileSync } from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  PASS  ${n} — ${d}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n} — ${d}`); };
const read = (p) => readFileSync(p, 'utf8');

// Comments stripped, so a hand-off or a parameter read that only exists in
// prose cannot pass. Same recipe as tools/no_streaming_test.mjs.
const live = (html) => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ---- the lobby's catalogue --------------------------------------------------
const lobby = read('multiplayer.html');
const start = lobby.indexOf('var CONSOLES = [');
const end = lobby.indexOf('var BY_KEY = {};', start);
if (start < 0 || end < 0) { bad('catalogue-found', 'multiplayer.html has no `var CONSOLES = [` … `var BY_KEY = {};` block'); }
const CONSOLES = start >= 0 && end >= 0
  ? vm.runInNewContext('(function(){ ' + lobby.slice(start, end) + ' return CONSOLES; })()')
  : [];
const byKey = Object.fromEntries(CONSOLES.map((c) => [c.key, c]));
CONSOLES.length ? ok('catalogue-parses', CONSOLES.map((c) => `${c.key}:${c.games.length}`).join(' '))
                : bad('catalogue-parses', 'no consoles');

// ---- each page's own list, in order -------------------------------------------
// ROMS[] arrays name games by `label:`; dreamcast.html's picker is a literal
// <select> whose option VALUES are the keys the pairing compares.
const romsLabels = (html) => {
  const i = html.indexOf('const ROMS = [');
  if (i < 0) return null;
  const block = html.slice(i, html.indexOf('];', i));
  return [...block.matchAll(/label:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2]);
};
const dcKeys = (html) => {
  const i = html.indexOf('<select id="romSelect">');
  const block = html.slice(i, html.indexOf('</select>', i));
  return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PAGES = {
  dreamcast: { file: 'dreamcast.html',  list: dcKeys },
  n64:       { file: 'n64/index.html',  list: romsLabels },
  genesis:   { file: 'genesis.html',    list: romsLabels },
  snes:      { file: 'snes.html',       list: romsLabels },
  ps1:       { file: 'ps1.html',        list: romsLabels },
};
for (const [key, p] of Object.entries(PAGES)) {
  const c = byKey[key];
  if (!c) { bad(`${key}-in-catalogue`, 'missing from multiplayer.html'); continue; }
  const theirs = p.list(read(p.file));
  const ours = c.games.map((g) => g.key);
  same(theirs, ours)
    ? ok(`${key}-list-matches-${p.file}`, `${ours.length} game(s), same order`)
    : bad(`${key}-list-matches-${p.file}`, `page=[${theirs.join(' | ')}] lobby=[${ours.join(' | ')}] — a mismatched key fails the pairing`);
}

// GameCube: the lobby offers ONLY what can run a room. tools/undelivered.mjs
// 'gamecube-lockstep-is-mario-party-4-only' — the frame gate is the recomp
// engine, and RECOMP_TITLES on gamecube.html names exactly which titles that is.
{
  const gc = read('gamecube.html');
  const c = byKey.gamecube;
  const labels = romsLabels(gc) || [];
  const rt = gc.match(/RECOMP_TITLES\s*=\s*\{([^}]*)\}/);
  const recompBases = rt ? [...rt[1].matchAll(/(\w+)\s*:\s*1/g)].map((m) => m[1]) : [];
  const baseOf = Object.fromEntries([...gc.slice(gc.indexOf('const ROMS = ['), gc.indexOf('];', gc.indexOf('const ROMS = [')))
    .matchAll(/label:\s*'([^']*)'\s*,\s*base:\s*'([^']*)'/g)].map((m) => [m[2], m[1]]));
  const roomable = recompBases.map((b) => baseOf[b]).filter(Boolean);
  if (!c) bad('gamecube-in-catalogue', 'missing');
  else if (!c.games.every((g) => labels.includes(g.key))) bad('gamecube-list-is-on-gamecube.html', `lobby=[${c.games.map((g) => g.key)}] page=[${labels}]`);
  else if (!same(c.games.map((g) => g.key), roomable)) bad('gamecube-offers-only-roomable-titles', `lobby=[${c.games.map((g) => g.key)}] RECOMP_TITLES=[${roomable}]`);
  else ok('gamecube-offers-only-roomable-titles', `[${roomable.join(', ')}] — the recomp-gated title(s), and nothing on the JIT path`);
}
// GBA: no online play, and the lobby must say so rather than hand off.
{
  const c = byKey.gba;
  !c ? bad('gba-in-catalogue', 'missing — a visitor must be TOLD it is not online, not left to wonder')
     : (c.games.length === 0 && c.handoff === null)
       ? ok('gba-is-listed-as-not-online', 'no games, no hand-off')
       : bad('gba-is-listed-as-not-online', JSON.stringify({ games: c.games.length, handoff: c.handoff }));
}

// ---- single-player titles (lib/mpgames.js) ----------------------------------
// Every key there must be a real title on that console's page, or a rename
// silently re-offers a solo game for a party.
{
  const ctx = { window: {}, location: { search: '' } };
  vm.runInNewContext(read('lib/mpgames.js'), ctx);
  const SOLO = ctx.window.MPGames.SOLO;
  for (const [sys, keys] of Object.entries(SOLO)) {
    const c = byKey[sys];
    const missing = c ? keys.filter((k) => !c.games.some((g) => g.key === k)) : keys;
    missing.length ? bad(`${sys}-solo-keys-exist`, `not on the page: [${missing.join(' | ')}]`)
                   : ok(`${sys}-solo-keys-exist`, `${keys.length} single-player title(s), all on the page`);
  }
  for (const f of ['n64/index.html', 'ps1.html', 'snes.html']) {
    /MPGames\.gateParty\(/.test(live(read(f)))
      ? ok(`${f}-party-gated`, 'Party disabled on a single-player game')
      : bad(`${f}-party-gated`, 'no MPGames.gateParty call');
  }
  /MPGames\.isSolo\(/.test(live(lobby))
    ? ok('lobby-filters-solo', 'lobby offers only multiplayer titles')
    : bad('lobby-filters-solo', 'multiplayer.html does not filter through MPGames.isSolo');
}

// ---- the hand-off literals and the receivers --------------------------------
const lobbyLive = live(lobby);
const RECEIVER = {
  dreamcast: { file: 'dreamcast.html', params: ['np', 'game', 'join'] },
  n64:       { file: 'n64/index.html', params: ['np', 'game', 'join'] },
  gamecube:  { file: 'gamecube.html',  params: ['np', 'game', 'join'] },
  genesis:   { file: 'genesis.html',   params: ['np', 'game', 'join', 'host'] },
  snes:      { file: 'snes.html',      params: ['np', 'game', 'join', 'host'] },
  ps1:       { file: 'ps1.html',       params: ['np', 'game', 'join', 'host'] },
};
for (const [key, r] of Object.entries(RECEIVER)) {
  const c = byKey[key];
  if (!c) continue;
  // The literal prefix must be in the lobby's LIVE code, and must point at the page.
  const want = c.page + '?np=';
  c.handoff === want && lobbyLive.includes("'" + want + "'")
    ? ok(`${key}-handoff-literal`, want)
    : bad(`${key}-handoff-literal`, `handoff=${c.handoff} page=${c.page} present-in-live-code=${lobbyLive.includes("'" + want + "'")}`);
  // hostFlag: the cartridge pages need host=1, the others must NOT get one
  // (their bare ?np=&game= already means "host").
  const needsHost = r.params.includes('host');
  (needsHost ? c.hostFlag === 'host=1' : c.hostFlag === '')
    ? ok(`${key}-host-flag`, needsHost ? 'host=1' : 'none (bare ?np= hosts)')
    : bad(`${key}-host-flag`, `hostFlag="${c.hostFlag}" but ${r.file} ${needsHost ? 'needs host=1' : 'hosts on a bare ?np='}`);
  // The page reads every parameter the lobby sends.
  const pageLive = live(read(r.file));
  const unread = r.params.filter((p) => !new RegExp(`\\.(?:get|has)\\(\\s*['"]${p}['"]\\s*\\)`).test(pageLive));
  unread.length
    ? bad(`${key}-receiver-reads-${r.params.join('+')}`, `${r.file} never reads ?${unread.join(', ?')} — a hand-off would land on a page that ignores part of its URL`)
    : ok(`${key}-receiver-reads-${r.params.join('+')}`, r.file);
}

// The invite link the lobby mints must come back to THIS page with the three
// parameters its own receiver reads.
/multiplayer\.html\?np=/.test(lobbyLive) && /['"]&sys=['"]/.test(lobbyLive) && /\.get\(\s*['"]sys['"]\s*\)/.test(lobbyLive)
  ? ok('invite-link-round-trips', '/multiplayer.html?np=…&sys=…&game=… is minted and read back')
  : bad('invite-link-round-trips', 'the invite link is not minted with &sys= or not read back');

// The shared lib is loaded with a version stamp (tools/stamp_lib_versions.mjs
// --check is the gate on WHICH stamp; this only proves the page is under it).
/<script src="\/lib\/netplay\.js\?v=[0-9a-f]+">/.test(lobby)
  ? ok('netplay-lib-is-stamped', 'a stale cache cannot serve an old engine here')
  : bad('netplay-lib-is-stamped', 'multiplayer.html loads /lib/netplay.js without ?v=');

console.log(`\n[multiplayer-page] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
