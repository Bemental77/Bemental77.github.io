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
// THE GBA ENTRY (stage GR4) IS HELD TO A DIFFERENT SOURCE THAN THE OTHERS. Every other console's list mirrors a
// page's ROMS[]. The Game Boy Advance's is a SUBSET of gba.html's ROMLIST: only the titles gba/mgba/room.js
// ROOMABLE names (those with a passing link row), each with the seat counts that passed. This file imports
// room.js (a pure ES module) and fails if the lobby's titles, their order or their seat counts differ, if a
// title is not on the page, or if the lobby offers anything with no passing row. Each of those checks has a
// mutant run through the SAME judge (`[control]` lines): a check nobody has seen fail proves nothing.
//
// STATIC AND FAST — no browser, no server. Run from the repo root:
//   node tools/multiplayer_page_test.mjs
import { readFileSync, readdirSync } from 'fs';
import { webcrypto } from 'crypto';
import { pathToFileURL } from 'url';
import path from 'path';
import vm from 'vm';

let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  PASS  ${n} — ${d}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n} — ${d}`); };
// A negative control: `caught` is true when the judge REJECTED the mutant. A control that is not caught is a failure.
const control = (n, caught, d) => { caught ? (pass++, console.log(`  PASS  [control] ${n} — ${d}`)) : (fail++, console.log(`  FAIL  [control] ${n} was NOT caught — ${d}`)); };
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
// ---- GBA: the lobby offers exactly gba/mgba/room.js ROOMABLE ------------------
// gba.html forms lockstep link-cable rooms since stage GR2. The lobby's list is NOT the page's ROMLIST (seven
// titles): it is the subset that has a passing link row, with the seat counts that passed. The judge is a pure
// function of (lobby source, room.js exports, gba.html, mpgames.js SOLO, netplay.js CODE_TAGS) so the mutants
// below run through the very same code as the real tree.
const roomJs = await import(pathToFileURL(path.resolve('gba/mgba/room.js')).href);
const catalogueOf = (html) => {
  const s = html.indexOf('var CONSOLES = ['), e = html.indexOf('var BY_KEY = {};', s);
  return s >= 0 && e >= 0 ? vm.runInNewContext('(function(){ ' + html.slice(s, e) + ' return CONSOLES; })()') : [];
};
const romlistOf = (text) => {            // [{ title, url }] evaluated, not regexed: the list is built with ROM_BASE + 'name'
  const ctx = { window: {} };
  vm.runInNewContext(text + '\nthis.__R = ROMLIST;', ctx);
  return ctx.__R.map((r) => ({ title: r.title, url: r.url }));
};
const soloOf = (mpgamesSrc) => { const ctx = { window: {}, location: { search: '' } }; vm.runInNewContext(mpgamesSrc, ctx); return ctx.window.MPGames.SOLO; };
const tagsOf = (netplaySrc) => {
  const m = /const CODE_TAGS = (\{[^}]*\});/.exec(netplaySrc);
  return m ? vm.runInNewContext('(' + m[1] + ')') : null;
};
const liveHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const paramRead = (live, p) => new RegExp(`\\.(?:get|has)\\(\\s*['"]${p}['"]\\s*\\)`).test(live);

/** Returns { id: { pass, detail } } for every GBA lobby check. */
function judgeGba({ lobbyHtml, room, romlist, solo, gbaHtml, netplaySrc, netplayPages }) {
  const R = {};
  const put = (id, pass, detail) => { R[id] = { pass: !!pass, detail }; };
  const cons = catalogueOf(lobbyHtml);
  const c = cons.find((x) => x.key === 'gba');
  const lobbyLive = liveHtml(lobbyHtml);
  if (!c) { put('gba-in-catalogue', false, 'multiplayer.html has no gba entry'); return R; }
  put('gba-in-catalogue', true, 'present');

  // 1. the hand-off: literal in LIVE code, the host flag, and the receiver reads everything the lobby sends
  const want = '/gba.html?np=';
  const hostSends = ['np', 'game', 'host', 'seats'], joinSends = ['np', 'game', 'join'];
  const gbaLive = liveHtml(gbaHtml);
  const unread = [...new Set([...hostSends, ...joinSends])].filter((p) => !paramRead(gbaLive, p));
  put('gba-handoff', c.page === '/gba.html' && c.handoff === want && lobbyLive.includes("'" + want + "'") && c.hostFlag === 'host=1' && !unread.length,
    `page=${c.page} handoff=${c.handoff} literal-in-live-code=${lobbyLive.includes("'" + want + "'")} hostFlag="${c.hostFlag}" gba.html-never-reads=[${unread}]`);

  // 2. exactly ROOMABLE, in order, nothing with a failing row
  const lobbyKeys = c.games.map((g) => g.key), roomKeys = Object.keys(room.ROOMABLE);
  const extra = lobbyKeys.filter((k) => !roomKeys.includes(k)), missing = roomKeys.filter((k) => !lobbyKeys.includes(k));
  put('gba-offers-exactly-ROOMABLE', JSON.stringify(lobbyKeys) === JSON.stringify(roomKeys),
    `lobby=[${lobbyKeys.join(' | ')}] room.js ROOMABLE=[${roomKeys.join(' | ')}]` +
    (extra.length ? ` — offered with no passing row: ${extra.map((k) => k + ' (' + room.whyNotRoomable(k) + ')').join('; ')}` : '') +
    (missing.length ? ` — passing but not offered: ${missing.join(', ')}` : ''));

  // 3. the seat counts that passed, and the console's player cap
  const seatBad = c.games.filter((g) => !room.ROOMABLE[g.key] || JSON.stringify(g.seats) !== JSON.stringify(room.ROOMABLE[g.key].counts))
    .map((g) => `${g.key}: lobby seats=${JSON.stringify(g.seats)} passing rows=${JSON.stringify((room.ROOMABLE[g.key] || {}).counts)}`);
  const cap = Math.max(...Object.values(room.ROOMABLE).map((r) => r.max));
  put('gba-seat-counts-are-the-passing-rows', !seatBad.length && c.players === cap, seatBad.length ? seatBad.join('; ') : `players=${c.players} (room.js max ${cap})`);

  // 4. every offered title is on gba.html's own list, and is the same ROM room.js pinned
  const pageBad = c.games.map((g) => {
    const r = romlist.find((x) => x.title === g.key), t = room.TITLES[g.key];
    if (!r) return `${g.key}: not in gba/gbaWasm/dist/romlist.js`;
    if (!t) return `${g.key}: not in room.js TITLES`;
    const file = decodeURIComponent(r.url.split('/').pop());
    return file === t.file ? null : `${g.key}: page serves "${file}" but room.js pinned "${t.file}"`;
  }).filter(Boolean);
  if (!c.games.length) pageBad.push('the lobby offers no GBA title at all (a vacuous pass is not a pass)');
  put('gba-titles-are-on-the-page', !pageBad.length, pageBad.length ? pageBad.join('; ') : `${c.games.length} title(s) found in romlist.js, same file name as room.js TITLES`);

  // 5. single-player: Sim City 2000 (the plan), every key on the page, none offered, none roomable
  const soloGba = solo.gba || [];
  const soloBad = [];
  if (!soloGba.includes('Sim City 2000')) soloBad.push('Sim City 2000 is not in SOLO.gba');
  for (const k of soloGba) {
    if (!romlist.some((r) => r.title === k)) soloBad.push(`${k}: not on gba.html's list`);
    if (lobbyKeys.includes(k)) soloBad.push(`${k}: single-player yet offered by the lobby`);
    if (room.ROOMABLE[k]) soloBad.push(`${k}: single-player yet ROOMABLE in room.js`);
  }
  put('gba-solo-list', !soloBad.length, soloBad.length ? soloBad.join('; ') : `SOLO.gba=[${soloGba.join(' | ')}], all on the page, none offered, none roomable`);

  // 6. the room code. lib/netplay.js CODE_TAGS names a code's console. The plan gives 'B' to the GBA and reserves 'A' for the arena; both
  //    are REGISTERED now (the lead's one-line edit at lib/netplay.js:215), so the lobby needs no compensation of its own: the registry
  //    is pinned as text, its behaviour is pinned by RUNNING the engine's own makeCode/consoleOfCode in a vm, the lobby must still use
  //    consoleOfCode (joiner auto-detect, host re-mint), and no other page path may have been reclassified by the two new keys.
  const tags = tagsOf(netplaySrc), regBad = [];
  if (!tags) regBad.push('CODE_TAGS not found in lib/netplay.js');
  else {
    const vals = Object.values(tags);
    if (new Set(vals).size !== vals.length) regBad.push('two consoles share a tag: ' + JSON.stringify(tags));
    for (const [k, v] of Object.entries({ gba: 'B', pokemonarena: 'A' })) {
      if (tags[k] !== v) regBad.push(`${k} must be registered as '${v}' (the plan), found ${tags[k] === undefined ? 'nothing' : "'" + tags[k] + "'"}`);
      const owner = Object.keys(tags).find((x) => tags[x] === v && x !== k);
      if (owner) regBad.push(`'${v}' (${k}'s tag) is already ${owner}'s`);
    }
  }
  put('gba-room-code-registry', !regBad.length, regBad.length ? regBad.join('; ') : `CODE_TAGS ${JSON.stringify(tags)}: gba 'B', pokemonarena 'A' (the Arena's online matches), every tag unique`);

  // the engine's behaviour, not just its table: the real makeCode / consoleOfCode evaluated with a chosen location.pathname
  const engineAt = (pathname) => {
    const win = { location: { pathname, search: '', href: 'http://localhost' + pathname }, crypto: webcrypto, console: { log() {}, warn() {}, error() {} } };
    win.window = win;
    vm.runInNewContext(netplaySrc, win);
    return win.Netplay;
  };
  const engBad = [];
  try {
    const E = engineAt('/multiplayer.html');
    const draws = (fn, n = 64) => Array.from({ length: n }, fn);
    const g = draws(() => E.makeCode(5, 'gba')), pa = draws(() => E.makeCode(5, 'pokemonarena'));
    if (!g.every((c) => /^B[A-HJ-NP-Z2-9]{4}$/.test(c))) engBad.push(`makeCode(5,'gba') did not always start with B: ${g.slice(0, 4).join(',')}`);
    if (!g.every((c) => E.consoleOfCode(c) === 'gba')) engBad.push("consoleOfCode(a 'B' code) is not 'gba'");
    if (!pa.every((c) => /^A[A-HJ-NP-Z2-9]{4}$/.test(c))) engBad.push(`makeCode(5,'pokemonarena') did not always start with A: ${pa.slice(0, 4).join(',')}`);
    if (E.consoleOfCode('A2345') !== 'pokemonarena' || E.consoleOfCode('B2345') !== 'gba') engBad.push(`consoleOfCode('A2345')=${E.consoleOfCode('A2345')} consoleOfCode('B2345')=${E.consoleOfCode('B2345')}`);
    for (const [p, want] of [['/gba.html', 'B'], ['/gba_multiplayer.html', 'B'], ['/pokemonarena.html', 'A'], ['/pokemonarena/', 'A']]) {
      const bad = draws(() => engineAt(p).makeCode(5), 8).filter((c) => c.charAt(0) !== want);
      if (bad.length) engBad.push(`makeCode(5) on ${p} did not start with ${want}: ${bad[0]}`);
    }
  } catch (e) { engBad.push('could not run lib/netplay.js in a vm: ' + e.message); }
  put('gba-room-code-engine', !engBad.length, engBad.length ? engBad.join('; ') : "makeCode(5,'gba') x64 always B and read back as gba; makeCode(5,'pokemonarena') x64 always A; consoleOfCode('B…')=gba, ('A…')=pokemonarena; makeCode(5) on /gba.html and /gba_multiplayer.html starts B, on /pokemonarena.html and /pokemonarena/ starts A");

  // no PAGE that loads netplay.js may change console because 'gba' and 'pokemonarena' became keys of a substring match on location.pathname
  const stripGbaTags = (src) => src.replace(/,\s*gba:\s*'B'/, '').replace(/,\s*pokemonarena:\s*'A'/, '');
  const classify = (src, pathname) => {
    try {
      const win = { location: { pathname, search: '', href: 'http://localhost' + pathname }, crypto: webcrypto, console: { log() {}, warn() {}, error() {} } };
      win.window = win; vm.runInNewContext(src, win);
      const codes = Array.from({ length: 40 }, () => win.Netplay.makeCode(5));
      return codes.every((c) => c.charAt(0) === codes[0].charAt(0)) ? (win.Netplay.consoleOfCode(codes[0]) || null) : null;   // an untagged path draws a random first character
    } catch (e) { return 'ERR:' + e.message; }
  };
  const audit = (netplayPages || []).map((pg) => pg.paths.map((p) => ({ file: pg.file, path: p, before: classify(stripGbaTags(netplaySrc), p), after: classify(netplaySrc, p) }))).flat();
  const moved = audit.filter((r) => r.before !== r.after && !(r.file === 'gba.html' && r.before === null && r.after === 'gba'));
  // and each page lands on ITS OWN console (a table, so a new page that loads the engine must say what it is, and a substring key cannot hide in `before` too)
  const EXPECT_CONSOLE = {
    'dreamcast.html': 'dreamcast', 'dreamcast_multiplayer.html': 'dreamcast', 'gamecube.html': 'gamecube', 'gba.html': 'gba', 'genesis.html': 'genesis',
    'mp4-native.html': null, 'multiplayer.html': null, 'n64/index.html': 'n64', 'n64_multiplayer.html': 'n64', 'ps1.html': 'ps1', 'snes.html': 'snes',
    'tools/netplay_lsu_harness.html': null,   // null = untagged: the path names no console (the lobby and mp4-native.html pass their own key, or none)
  };
  for (const r of audit) {
    if (!(r.file in EXPECT_CONSOLE)) moved.push({ ...r, before: 'unlisted', after: 'declare ' + r.file + ' in EXPECT_CONSOLE' });
    else if (EXPECT_CONSOLE[r.file] !== r.after) moved.push({ ...r, before: 'expected ' + EXPECT_CONSOLE[r.file], after: String(r.after) });
  }
  put('gba-room-code-no-page-reclassified', audit.length > 0 && !moved.length && audit.some((r) => r.file === 'gba.html' && r.after === 'gba'),
    moved.length ? 'reclassified: ' + moved.map((r) => `${r.path} ${r.before}->${r.after}`).join(', ') : audit.length ?`${audit.length} path(s) of ${new Set(audit.map((r) => r.file)).size} page(s) that load netplay.js, classified with and without the two new keys: ${audit.map((r) => `${r.path}=${r.after}`).join(' ')} — only /gba.html changed (none -> gba)` : 'no page that loads netplay.js was found');

  // the lobby must keep USING the registry: the joiner is auto-detected from the code, and a party minted for another console is not reused
  const detUses = /var det = Netplay\.consoleOfCode \? Netplay\.consoleOfCode\(v\) : null;/.test(lobbyLive) && /setJoin\(det\)/.test(lobbyLive);
  const namedUses = /var named = code && Netplay\.consoleOfCode \? Netplay\.consoleOfCode\(code\) : null;/.test(lobbyLive) && /named && named !== sys\.key/.test(lobbyLive);
  const mintsPerConsole = (lobbyLive.match(/Netplay\.makeCode\(5, (?:sys|c)\.key\)/g) || []).length === 2 && !/Netplay\.makeCode\(5\)/.test(lobbyLive);
  put('gba-lobby-uses-the-code-registry', detUses && namedUses && mintsPerConsole, `joiner auto-detect from the code=${detUses} host re-mint when the code names another console=${namedUses} both mints pass the console key=${mintsPerConsole}`);
  return R;
}

{
  // every page that loads lib/netplay.js (root *.html, n64/index.html, tools/*.html), with the location.pathname(s) it is served at
  const netplayPages = [];
  for (const file of [...readdirSync('.').filter((f) => f.endsWith('.html')), 'n64/index.html', ...readdirSync('tools').filter((f) => f.endsWith('.html')).map((f) => 'tools/' + f)]) {
    let text; try { text = read(file); } catch (e) { continue; }
    if (!/<script[^>]*\/lib\/netplay\.js/.test(live(text))) continue;
    netplayPages.push({ file, paths: file === 'n64/index.html' ? ['/n64/', '/n64/index.html'] : ['/' + file] });
  }
  const inputs = {
    lobbyHtml: lobby, room: roomJs, romlist: romlistOf(read('gba/gbaWasm/dist/romlist.js')), solo: soloOf(read('lib/mpgames.js')),
    gbaHtml: read('gba.html'), netplaySrc: read('lib/netplay.js'), netplayPages,
  };
  const real = judgeGba(inputs);
  for (const [id, v] of Object.entries(real)) v.pass ? ok(id, v.detail) : bad(id, v.detail);

  // ---- negative controls: each mutant must trip the named check, through the same judge ----
  // Mutators edit a row's text by regex (not by exact spacing) so column alignment in multiplayer.html can change without breaking a control.
  const row = (k) => new RegExp('\\{ key: \'' + k + '\',[^}]*\\},');
  const edit = (h, re, fn) => { if (!re.test(h)) throw new Error('mutant anchor not found: ' + re); return h.replace(re, fn); };
  const SBAM = row('Super Bust-A-Move'), KIRBY = row('Kirby Nightmare in Dreamland'), SA3 = row('Sonic Advance 3');
  const mutantLobby = {
    'Monster Rancher Advance 2 added to the lobby (no passing row)': [(h) => edit(h, SBAM, (m) => m + " { key: 'Monster Rancher Advance 2', label: 'Monster Rancher Advance 2', seats: [2] },"), 'gba-offers-exactly-ROOMABLE'],
    'Sonic Advance 3 dropped from the lobby': [(h) => edit(h, SA3, () => ''), 'gba-offers-exactly-ROOMABLE'],
    'two titles swapped (order drift)': [(h) => { const sa3 = h.match(SA3)[0]; return edit(edit(h, SA3, () => ''), SBAM, (m) => sa3 + ' ' + m); }, 'gba-offers-exactly-ROOMABLE'],
    'Kirby renamed on the lobby only': [(h) => edit(h, KIRBY, (m) => m.replace(/Dreamland/g, 'Dream Land')), 'gba-titles-are-on-the-page'],
    'Kirby offered at 2 and 3 seats only (4 passed)': [(h) => edit(h, KIRBY, (m) => m.replace('[2, 3, 4]', '[2, 3]')), 'gba-seat-counts-are-the-passing-rows'],
    'Super Bust-A-Move offered at 4 seats (only 2 passed)': [(h) => edit(h, SBAM, (m) => m.replace('[2]', '[2, 4]')), 'gba-seat-counts-are-the-passing-rows'],
    'the console cap wrong (players: 2)': [(h) => edit(h, /players: 4, note: 'Link-cable rooms/, () => "players: 2, note: 'Link-cable rooms"), 'gba-seat-counts-are-the-passing-rows'],
    'the host flag removed': [(h) => edit(h, /handoff: '\/gba\.html\?np=', hostFlag: 'host=1'/, () => "handoff: '/gba.html?np=', hostFlag: ''"), 'gba-handoff'],
    'the hand-off pointing at the old redirect': [(h) => edit(h, /handoff: '\/gba\.html\?np='/, () => "handoff: '/gba_multiplayer.html?np='"), 'gba-handoff'],
    'the hand-off removed (the old "not online" entry)': [(h) => edit(h, /handoff: '\/gba\.html\?np='/, () => 'handoff: null'), 'gba-handoff'],
    'the lobby ignores consoleOfCode when a joiner types a code (the joiner would be asked, or sent to a wrong console)': [(h) => edit(h, /var det = Netplay\.consoleOfCode \? Netplay\.consoleOfCode\(v\) : null;/, () => 'var det = null;'), 'gba-lobby-uses-the-code-registry'],
    'the lobby ignores consoleOfCode when the host re-presses Open a party (a code for another console would be reused)': [(h) => edit(h, /var named = code && Netplay\.consoleOfCode \? Netplay\.consoleOfCode\(code\) : null;/, () => 'var named = null;'), 'gba-lobby-uses-the-code-registry'],
    'a code minted without the console key (it would be untagged on /multiplayer.html)': [(h) => edit(h, /code = Netplay\.makeCode\(5, c\.key\);/, () => 'code = Netplay.makeCode(5);'), 'gba-lobby-uses-the-code-registry'],
  };
  for (const [name, [mutate, id]] of Object.entries(mutantLobby)) {
    const r = judgeGba({ ...inputs, lobbyHtml: mutate(lobby) });
    control(`${name} → ${id}`, r[id] && r[id].pass === false, r[id] ? r[id].detail.slice(0, 200) : 'check missing');
  }
  // the rig's rows changing under the lobby: a title that starts to link must be OFFERED, one that stops must be dropped
  const rows = [...roomJs.LINK_ROWS];
  const withMra2 = rows.map((r) => (r.id === 'mra2-2p' ? { ...r, outcome: 'linked' } : r));
  const withoutSa3 = rows.map((r) => (r.id === 'sa3-2p' ? { ...r, outcome: 'could-not-reach' } : r));
  const noKirby4 = rows.filter((r) => r.id !== 'kirby-4p');
  for (const [name, rs, id] of [
    ['Monster Rancher Advance 2 starts linking in the rig', withMra2, 'gba-offers-exactly-ROOMABLE'],
    ['Sonic Advance 3 stops linking in the rig', withoutSa3, 'gba-offers-exactly-ROOMABLE'],
    ['Kirby loses its 4-seat row in the rig', noKirby4, 'gba-seat-counts-are-the-passing-rows'],
  ]) {
    const room = { ...roomJs, ROOMABLE: roomJs.deriveRoomable(rs, roomJs.TITLES) };
    const r = judgeGba({ ...inputs, room });
    control(`${name} → ${id}`, r[id].pass === false, r[id].detail.slice(0, 200));
  }
  // single-player list and the room-code registry
  const soloGba = inputs.solo.gba;
  for (const [name, solo, id] of [
    ['Sim City 2000 missing from SOLO.gba', { gba: [] }, 'gba-solo-list'],
    ['a roomable title called single-player', { gba: [...soloGba, 'Kirby Nightmare in Dreamland'] }, 'gba-solo-list'],
    ['a SOLO.gba key that is not on the page', { gba: [...soloGba, 'Sim City 3000'] }, 'gba-solo-list'],
  ]) {
    const r = judgeGba({ ...inputs, solo });
    control(`${name} → ${id}`, r[id].pass === false, r[id].detail.slice(0, 200));
  }
  // the room-code registry and the engine behind it (mutants of lib/netplay.js's TEXT; the file on disk is never touched)
  const np = inputs.netplaySrc;
  const mutEng = (re, to) => (s) => { if (!re.test(s)) throw new Error('engine mutant anchor not found: ' + re); return s.replace(re, to); };
  for (const [name, mut, id] of [
    ["gba dropped from the registry (the state HEAD's lib/netplay.js is in)", mutEng(/,\s*gba: 'B'/, ''), 'gba-room-code-registry'],
    ["pokemonarena dropped from the registry (the reservation lost)", mutEng(/,\s*pokemonarena: 'A'/, ''), 'gba-room-code-registry'],
    ["gba registered as 'S' (the genesis tag)", mutEng(/(const CODE_TAGS = \{[^}]*)gba: 'B'/, "$1gba: 'S'"), 'gba-room-code-registry'],
    ["pokemonarena registered as 'B'", mutEng(/(const CODE_TAGS = \{[^}]*)pokemonarena: 'A'/, "$1pokemonarena: 'B'"), 'gba-room-code-registry'],
    ["ps1 given the reserved 'B'", mutEng(/ps1: 'P'/, "ps1: 'B'"), 'gba-room-code-registry'],
    ["a tag used twice (snes 'S')", mutEng(/snes: 'X'/, "snes: 'S'"), 'gba-room-code-registry'],
    ["gba dropped from the registry -> makeCode(5,'gba') is no longer tagged", mutEng(/,\s*gba: 'B'/, ''), 'gba-room-code-engine'],
    ["makeCode ignores the tag table", mutEng(/\(key && CODE_TAGS\[key\] && n >= 5\)/, '(false)'), 'gba-room-code-engine'],
    ["consoleFromPath never matches (makeCode(5) on /gba.html untagged)", mutEng(/p\.indexOf\(k\) >= 0/, 'p.indexOf(k) < -1'), 'gba-room-code-engine'],
    ["consoleOfCode never names a console", mutEng(/if \(CODE_TAGS\[k\] === c\) return k;/, 'if (false) return k;'), 'gba-room-code-engine'],
    ["a registry key that is a substring of another page's path ('mp4' vs /mp4-native.html)", mutEng(/(const CODE_TAGS = \{[^}]*)pokemonarena: 'A'/, "$1pokemonarena: 'A', mp4: 'M'"), 'gba-room-code-no-page-reclassified'],
    ["a registry key that is a substring of every tools harness ('tools')", mutEng(/(const CODE_TAGS = \{[^}]*)pokemonarena: 'A'/, "$1pokemonarena: 'A', tools: 'T'"), 'gba-room-code-no-page-reclassified'],
  ]) {
    const r = judgeGba({ ...inputs, netplaySrc: mut(np) });
    control(`${name} → ${id}`, r[id].pass === false, r[id].detail.slice(0, 200));
  }
  // (the unmutated twins are the four room-code lines printed above from the real tree: registry, engine, no-page-reclassified, lobby-uses-the-code-registry)
}

// ---- single-player titles (lib/mpgames.js) ----------------------------------
// Every key there must be a real title on that console's page, or a rename
// silently re-offers a solo game for a party. (The GBA's solo list is checked
// against gba.html's ROMLIST above: its lobby list is only the roomable subset,
// so Sim City 2000 is on the PAGE and deliberately not in the lobby.)
{
  const ctx = { window: {}, location: { search: '' } };
  vm.runInNewContext(read('lib/mpgames.js'), ctx);
  const SOLO = ctx.window.MPGames.SOLO;
  for (const [sys, keys] of Object.entries(SOLO)) {
    const c = byKey[sys];
    if (sys === 'gba') continue;
    const missing = c ? keys.filter((k) => !c.games.some((g) => g.key === k)) : keys;
    missing.length ? bad(`${sys}-solo-keys-exist`, `not on the page: [${missing.join(' | ')}]`)
                   : ok(`${sys}-solo-keys-exist`, `${keys.length} single-player title(s), all on the page`);
  }
  for (const f of ['ps1.html', 'snes.html']) {
    /MPGames\.gateParty\(/.test(live(read(f)))
      ? ok(`${f}-party-gated`, 'Party disabled on a single-player game')
      : bad(`${f}-party-gated`, 'no MPGames.gateParty call');
  }
  // n64/index.html deliberately stopped gating the Party button on the selected game (its own comment says why: the lobby it opens disables Host
  // with the reason and lets a player on a solo title still Join a friend). The check pins that decision instead of the old gating.
  /MPGames\.gateParty\(/.test(live(read('n64/index.html')))
    ? bad('n64/index.html-party-not-gated', 'n64 gates Party again: the page documents that it does not')
    : ok('n64/index.html-party-not-gated', 'Party stays open on a single-player game; the lobby handles it');
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
  mp4native: { file: 'mp4-native.html', params: ['np', 'game', 'join'] },
  genesis:   { file: 'genesis.html',   params: ['np', 'game', 'join', 'host'] },
  snes:      { file: 'snes.html',      params: ['np', 'game', 'join', 'host'] },
  ps1:       { file: 'ps1.html',       params: ['np', 'game', 'join', 'host'] },
  // Pokemon Arena: the receiver is the battle page's online module (battle_boot.js hands it location.search); a battle, not a core
  pokemonarena: { file: 'pokemonarena/js/online.js', params: ['np', 'game', 'join', 'host'] },
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

// Pokemon Arena: the one game the lobby names is the one the page's own module names, and it is not a single-player title
{
  const { GAME_KEY } = await import(pathToFileURL(path.resolve('pokemonarena/js/online.js')).href);
  const c = byKey.pokemonarena;
  c && c.games.length === 1 && c.games[0].key === GAME_KEY && c.players === 2 && c.page === '/pokemonarena/battle.html'
    ? ok('pokemonarena-lobby-entry-matches-online.js', `game "${GAME_KEY}", 2 players, ${c.page}`)
    : bad('pokemonarena-lobby-entry-matches-online.js', c ? `lobby game=${JSON.stringify(c.games.map((g) => g.key))} online.js GAME_KEY="${GAME_KEY}" players=${c.players} page=${c.page}` : 'multiplayer.html has no pokemonarena entry');
  const ctxM = { window: {}, location: { search: '' } };
  vm.runInNewContext(read('lib/mpgames.js'), ctxM);
  (ctxM.window.MPGames.SOLO.pokemonarena || []).length === 0 && ctxM.window.MPGames.canRoom('pokemonarena', GAME_KEY)
    ? ok('pokemonarena-is-roomable', 'not a single-player title')
    : bad('pokemonarena-is-roomable', 'MPGames says the Arena cannot be roomed');
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
