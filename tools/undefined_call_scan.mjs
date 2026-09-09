#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CLASS OF DEFECT THIS EXISTS FOR, and it shipped:
//
// gamecube.html called gcNetRemoteMask(). That name — plus GCNET,
// gcNetApplyMask and gcNetPumpMirror — appeared ONLY at its call site and was
// defined nowhere in the repo. The throw landed BEFORE both
// `dolphin_worker.postMessage({cmd:'input'})` and the `setTimeout(pollController,10)`
// that re-arms the loop, so every GameCube visit lost ALL controller input and
// the poll loop died on its first pass. Buttons did nothing. Nothing on screen,
// and nothing in any existing harness, said why.
//
// A page-level syntax check CANNOT catch this: the file parses perfectly. Only
// resolving each call against the definitions actually reachable at runtime
// does. That is what this scans for.
//
// ⚠ COMMENTS MUST BE STRIPPED FIRST, and getting this wrong wastes a whole
// investigation. A first pass that scanned raw text reported six "undefined"
// names in dreamcast.html and dreamcast_multiplayer.html that were all prose
// inside comments — e.g. "netCaptureSurface(), netCountFrames(), the mirror".
// A second pass with the stripping regex written inline in a shell -e string
// had its backslashes mangled by the shell and reported the OPPOSITE error:
// three names as undefined that the file defines on lines 5749-5758. Both
// readings were artifacts of the instrument. Hence a real file, and hence the
// self-test at the bottom, which fails loudly rather than reporting a clean
// scan built on a broken regex.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'fs';

const PAGES = [
  'index.html', 'gamecube.html', 'dreamcast.html', 'ps1.html', 'snes.html',
  'gba.html', 'genesis.html', 'n64/index.html',
  'dreamcast_multiplayer.html', 'gamecube_multiplayer.html', 'ps1_multiplayer.html',
  'snes_multiplayer.html', 'genesis_multiplayer.html', 'gba_multiplayer.html',
  'n64_multiplayer.html',
];

// Every library a page may pull a definition from. A name defined here is not
// undefined, even though it is not in the page.
const LIBS = [
  'lib/netplay.js', 'lib/netplay-host.js', 'lib/netplay-guest.js',
  'lib/netplay-ui.js', 'lib/capability.js', 'lib/asset_base.js', 'lib/bgz.js',
  'coi-serviceworker.js',
];

// Project-shaped identifiers only. A bare `foo()` may be a browser or library
// global; these prefixes are ours, so an unresolved one is a real defect.
const CALL_RE = /\b((?:gc|dc|ps1|snes|gba|n64|gen|ls|net|cap)[A-Z]\w{2,})\s*\(/g;

// ⚠ A SINGLE PASS, NOT TWO REGEXES. Stripping block comments and line comments
// as separate global regexes is wrong in BOTH orders, and this cost a full
// investigation before it was understood:
//
//   block-first: a `//` line comment containing the text `lib/*.js` has its
//   `/*` read as a block-comment OPENER, swallowing every line down to the next
//   `*/`. That is exactly what happened here — the scanner reported
//   gcNetRemoteMask/gcNetApplyMask/gcNetPumpMirror as undefined while
//   gamecube.html defines all three, because a comment in that very stub says
//   "lib/" + a star + ".js".
//   line-first: a genuine multi-line block comment whose interior lines contain
//   `//` gets half-eaten, and its closing `*/` is then orphaned.
//
// Only a scanner that knows which construct it is already inside can be right,
// so this walks the text once and tracks state: string (three quote flavours),
// line comment, block comment. Escapes inside strings are honoured, because a
// `"\\"` would otherwise leave the string open and mis-classify the rest.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';   // code | line | block | sq | dq | bt | html
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '<' && src.startsWith('<!--', i)) { state = 'html'; i += 4; continue; }
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === '"') state = 'dq';
      else if (c === "'") state = 'sq';
      else if (c === '`') state = 'bt';
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
    if (state === 'html') { if (src.startsWith('-->', i)) { state = 'code'; i += 3; } else { if (c === '\n') out += c; i++; } continue; }
    // inside a string literal
    out += c;
    if (c === '\\') { if (i + 1 < n) out += src[i + 1]; i += 2; continue; }
    if ((state === 'dq' && c === '"') || (state === 'sq' && c === "'") || (state === 'bt' && c === '`')) state = 'code';
    i++;
  }
  return out;
}

function definesName(text, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [
    new RegExp('function\\s+' + n + '\\b'),
    new RegExp('(?:var|let|const)\\s+' + n + '\\b'),
    new RegExp(n + '\\s*[:=]\\s*(?:function|\\(|async)'),
    new RegExp('window\\.' + n + '\\s*='),
    new RegExp('\\b' + n + '\\s*\\([^)]*\\)\\s*\\{'),   // method shorthand
  ];
  return pats.some((p) => p.test(text));
}

// --- self-test: the instrument must prove itself before it reports ----------
{
  const star = String.fromCharCode(42);
  const fixture = [
    '// netCaptureSurface() in a comment must NOT count as a call',
    '// a path like lib/' + star + '.js inside a LINE comment must not open a block',
    '/' + star + ' gcBlockComment() also must not ' + star + '/',
    'function gcDefined() { return 1; }',
    'var lsThing = function () {};',
    'function gcAfterTrap() { return 2; }',
    'gcDefined(); lsThing(); gcAfterTrap(); gcMissing();',
    'var u = "https://example.com/x"; // a URL\'s // must not eat the line',
    'var lit = "/' + star + ' not a comment ' + star + '/";',
  ].join('\n');
  const s = stripComments(fixture);
  const called = [...s.matchAll(CALL_RE)].map((m) => m[1]);
  const missing = [...new Set(called)].filter((n) => !definesName(s, n));
  const fail = [];
  if (called.includes('netCaptureSurface')) fail.push('comment text counted as a call');
  if (called.includes('gcBlockComment')) fail.push('block comment counted as a call');
  if (!called.includes('gcMissing')) fail.push('a real call was missed');
  if (!definesName(s, 'gcDefined')) fail.push('function declaration not recognised');
  if (!definesName(s, 'lsThing')) fail.push('var-function assignment not recognised');
  if (!definesName(s, 'gcAfterTrap')) fail.push('a definition AFTER a line-comment star-slash trap was swallowed');
  if (missing.join(',') !== 'gcMissing') fail.push('wrong missing set: ' + missing.join(','));
  if (fail.length) {
    console.error('[undefined-calls] SELF-TEST FAILED — refusing to report a scan:');
    for (const f of fail) console.error('   ' + f);
    process.exit(2);
  }
}

let libText = '';
for (const l of LIBS) if (existsSync(l)) libText += '\n' + stripComments(readFileSync(l, 'utf8'));

const findings = [];
let scanned = 0;
for (const p of PAGES) {
  if (!existsSync(p)) continue;
  scanned++;
  const text = stripComments(readFileSync(p, 'utf8'));
  const called = [...text.matchAll(CALL_RE)].map((m) => m[1]);
  for (const name of [...new Set(called)]) {
    if (definesName(text, name) || definesName(libText, name)) continue;
    const line = text.slice(0, text.indexOf(name)).split('\n').length;
    findings.push({ page: p, name, line });
  }
}

for (const f of findings) {
  console.log(`  UNDEFINED CALL  ${f.page}:${f.line}  ${f.name}()`);
}
console.log(`[undefined-calls] ${scanned} page(s) scanned · ${findings.length} undefined call site(s)`);
if (findings.length) {
  console.log('A page with one of these parses fine and then throws at runtime,');
  console.log('killing everything downstream in the same function. gamecube.html');
  console.log('lost ALL controller input this way.');
  process.exit(1);
}
