#!/usr/bin/env node
// CONTROL-MAP DRIFT GATE — does player 2 get the button player 1 gets?
//
// Every console here ships as a PAIR of pages: the emulator page (player 1, the
// host) and a `*_multiplayer.html` lobby (player 2, the guest). Each side owns
// its own copy of the same two tables — physical-gamepad index -> guest button,
// and keyboard key -> guest button — because the guest page deliberately does
// not load the emulator. Two copies of one fact is a drift machine, and it had
// already drifted on three of the six pairs when this file was written
// (2026-09-08), each time under a comment asserting the two were identical:
//
//   genesis   4 of 6 face buttons  (guest A/B/X/Y/C/Z where the host has B/C/A/Y/X/Z)
//   gamecube  pad index 7 and 9    (host had Start on the RIGHT TRIGGER, none on Start)
//   n64       pad index 4 and 6    (L and Z swapped) + three bindings the host has not got
//
// A drift here is invisible from either UI: both pages look right, both players
// press "the jump button", and only one of them jumps.
//
// WHAT IT COMPARES, PER PAIR
//   pad   every gamepad button index both pages bind, resolved to the GUEST
//         BUTTON NAME (not to the intermediate key label or RETRO id the page
//         happens to route through), so `KEYMAP.a` on one side and `B.a` on the
//         other are compared as the same thing
//   keys  every keyboard key both pages bind, likewise resolved to a button name
//
// Plus one extra assertion that is the same class of bug in a different table:
// dreamcast.html's savestate EXPORT FILENAME must be derived from the selected
// disc. It was the literal 'dcx-pso2-state.bin' for all five discs, so a
// Gauntlet Legends state downloaded named as a PSO state.
//
// HOW IT READS THE TABLES, AND WHY
// The tables are static literals inside page-level IIFEs — nothing publishes
// them on `window`, and reaching them for real would mean booting six emulators
// (gamecube and dreamcast want cross-origin isolation and ~1 GB of disc) and
// adding a test seam to twelve files. So: this fetches each page's SOURCE OVER
// HTTP from the dev server (so it tests what the server actually serves, not a
// file that happens to be on disk), slices out the named declarations with a
// string/comment-aware scanner, and EVALUATES them in a real browser. The
// values therefore come from a JS engine, not from a hand-rolled parser that
// could quietly mis-read a trailing comma or a computed `[B.up]:` key. Only the
// slicing is textual, and a slice that fails to find its declaration is a hard
// error, never a silent empty table.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime   # gate, per CLAUDE.md
//   npm run web                                       # port 8080, gate #2
//   node tools/control_map_drift_test.mjs
//
// ENV
//   CHROME_PATH  path to Chrome (default: the macOS bundle)
//   ORIGIN       default http://localhost:8080
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';

// ---------------------------------------------------------------------------
// Slice a `const|var|let NAME = <literal>;` out of a source file.
//
// Textual, but not naive: it tracks '/"/` strings, // and /* */ comments and
// (){}[] nesting, so a `;` inside `[';']` (gamecube_multiplayer's C-down key)
// or a `/*L3*/` label inside an array (dreamcast) does not end the slice.
// ---------------------------------------------------------------------------
function sliceDecl(src, name, { occurrence = 1, from = 0 } = {}) {
  const re = new RegExp('(?:^|[^\\w$.])((?:const|var|let)\\s+' + name + '\\s*=)', 'g');
  re.lastIndex = from;
  let m, seen = 0;
  while ((m = re.exec(src))) { if (++seen === occurrence) break; }
  if (!m || seen !== occurrence) {
    throw new Error(`declaration ${occurrence > 1 ? '#' + occurrence + ' of ' : ''}\`${name}\` not found`);
  }
  // Start at the const/var/let keyword, not at the name: sliceDeclAs rewrites
  // that keyword, and a slice that dropped it would declare a GLOBAL instead.
  const start = m.index + m[0].indexOf(m[1]);
  let i = re.lastIndex;                 // just past the '='
  let depth = 0, q = null, line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (c === ';' && depth === 0) break;
  }
  if (i >= src.length) throw new Error(`declaration \`${name}\` never terminated`);
  return { text: src.slice(start, i + 1), end: i + 1 };
}

// Keep the declaration under its own name — sibling tables on the same page
// reference it (`[B.up]:` as a computed key, `GP_BTN_TO_RETRO` built out of
// `RB`) — and bind a second, uniform name for the normalizer to use.
function sliceDeclAlias(src, name, alias, opts) {
  return sliceDecl(src, name, opts).text + `\nconst ${alias} = ${name};`;
}

// Renaming variant, for a table that lives inside a function body and collides
// with another of the same name (gamecube.html has TWO `keyToPad` tables that
// mean different things). Safe only when nothing else in the slice set refers
// to the original name.
function sliceDeclAs(src, name, alias, opts) {
  const { text } = sliceDecl(src, name, opts);
  return text.replace(new RegExp('^(?:const|var|let)\\s+' + name), 'const ' + alias);
}

// Return the object literal a zero-arg method returns, as `const ALIAS = {...};`
// (gba.html has no tables of its own — the vendored InputController owns them).
function sliceReturnedObject(src, method, alias) {
  const at = src.indexOf(method + '(');
  if (at < 0) throw new Error(`method \`${method}\` not found`);
  const ret = src.indexOf('return', at);
  if (ret < 0) throw new Error(`\`${method}\` has no return`);
  const open = src.indexOf('{', ret);
  let depth = 0, q = null, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) break; }
  }
  return `const ${alias} = ${src.slice(open, i + 1)};`;
}

// ---------------------------------------------------------------------------
// THE PAIRS. `decls` is what to slice out of the page; `normalize` is a JS
// expression evaluated after those slices, returning
//   { pad: { <gamepad index>: <button name> }, keys: { <key>: <button name> } }
// in ONE vocabulary per console, so the two sides are directly comparable.
// ---------------------------------------------------------------------------

// Shape A: the multiplayer pages that key a bit-id table (B/D/RB) by name and
// carry `GP` as an array of ids plus `KEYMAP` as id -> [keys].
const MP_ID_ARRAY = `(() => {
  const inv = {}; for (const [n, i] of Object.entries(IDS)) inv[i] = n.toLowerCase();
  const pad = {}; GP.forEach((v, i) => { if (typeof v === 'number' && v >= 0) pad[i] = inv[v] || ('id' + v); });
  const keys = {};
  for (const [idStr, v] of Object.entries(KEYMAP)) {
    for (const k of (Array.isArray(v) ? v : [v])) keys[String(k).toLowerCase()] = inv[idStr] || ('id' + idStr);
  }
  return { pad, keys };
})()`;

// Shape B: the multiplayer pages that carry `GP` as an array of BUTTON NAMES
// and `KEYMAP` as name -> [keys] (snes, gba, n64).
const MP_NAME_ARRAY = `(() => {
  const pad = {}; GP.forEach((v, i) => { if (v) pad[i] = String(v).toLowerCase(); });
  const keys = {};
  for (const [n, v] of Object.entries(KEYMAP)) {
    for (const k of (Array.isArray(v) ? v : [v])) keys[String(k).toLowerCase()] = n.toLowerCase();
  }
  return { pad, keys };
})()`;

// Shape C: a vendored InputController's `Mapping_*` / `Joy_Mapping_*` defaults
// (n64/index.html copies them; gba.html loads them). ACT names the subset that
// is a GUEST BUTTON — `Menu` is a page control and the analog-stick keys are a
// host-only convenience, so neither is compared.
const DEFAULTS_TABLE = `(() => {
  const pad = {}, keys = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const joy = k.startsWith('Joy_Mapping_');
    const name = ACT[k.replace(/^(?:Joy_)?Mapping_/, '')];
    if (!name) continue;
    if (joy) { if (v >= 0) pad[Number(v)] = name; }
    else keys[String(v).toLowerCase()] = name;
  }
  return { pad, keys };
})()`;

const PAIRS = [
  {
    name: 'genesis',
    host: {
      url: '/genesis.html',
      decls: (s) => [sliceDecl(s, 'GP_BTN').text, sliceDecl(s, 'KEYMAP').text],
      normalize: `(() => ({
        pad: Object.fromEntries(Object.entries(GP_BTN).map(([i, n]) => [Number(i), String(n).toLowerCase()])),
        keys: Object.fromEntries(Object.entries(KEYMAP).map(([k, n]) => [String(k).toLowerCase(), String(n).toLowerCase()])),
      }))()`,
    },
    guest: {
      url: '/genesis_multiplayer.html',
      decls: (s) => [sliceDeclAlias(s, 'B', 'IDS'), sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_ID_ARRAY,
    },
  },
  {
    name: 'gamecube',
    host: {
      url: '/gamecube.html',
      // Three tables, because a gamepad press on this page takes two hops:
      // GP_BUTTON_KEYS gives a KEYMAP key LABEL, and dispatchKey's own keyToPad
      // turns that label into a pad button. The SECOND keyToPad (the one with
      // 'm' on it) is the PHYSICAL keyboard — that is the one a real key press
      // reaches, so it is the one compared against the guest's KEYMAP.
      decls: (s) => [
        sliceDecl(s, 'KEYMAP').text,
        sliceDecl(s, 'GP_BUTTON_KEYS').text,
        sliceDeclAs(s, 'keyToPad', 'DISPATCH_KEYTOPAD', { occurrence: 1 }),
        sliceDeclAs(s, 'keyToPad', 'PHYS_KEYTOPAD', { occurrence: 2 }),
      ],
      normalize: `(() => {
        const pad = {};
        for (const [i, label] of Object.entries(GP_BUTTON_KEYS)) {
          const b = DISPATCH_KEYTOPAD[label];
          if (b) pad[Number(i)] = b.toLowerCase();
        }
        const keys = {};
        for (const [k, b] of Object.entries(PHYS_KEYTOPAD)) keys[String(k).toLowerCase()] = String(b).toLowerCase();
        return { pad, keys };
      })()`,
    },
    guest: {
      url: '/gamecube_multiplayer.html',
      decls: (s) => [sliceDeclAlias(s, 'B', 'IDS'), sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_ID_ARRAY,
    },
  },
  {
    name: 'n64',
    host: {
      url: '/n64/index.html',
      decls: (s) => [
        sliceDeclAlias(s, 'MAPPING_DEFAULTS', 'DEFAULTS'),
        `const ACT = { Left:'left', Right:'right', Up:'up', Down:'down',
                       Action_A:'a', Action_B:'b', Action_Start:'start',
                       Action_Z:'z', Action_L:'l', Action_R:'r',
                       Action_CUP:'cup', Action_CDOWN:'cdown',
                       Action_CLEFT:'cleft', Action_CRIGHT:'cright' };`,
      ],
      normalize: DEFAULTS_TABLE,
    },
    guest: {
      url: '/n64_multiplayer.html',
      decls: (s) => [sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_NAME_ARRAY,
    },
  },
  {
    name: 'ps1',
    host: {
      url: '/ps1.html',
      // Start/Select are applied over the base table from two overridable
      // constants (?startbtn / ?selectbtn), so resolve them the way the page does.
      decls: (s) => [
        sliceDecl(s, 'KEYMAP').text,
        sliceDecl(s, 'GP_BUTTON_KEYS').text,
        'const GP_START_BTN = 9, GP_SELECT_BTN = 8;   // page defaults; ?startbtn/?selectbtn override',
      ],
      normalize: `(() => {
        const inv = {}; for (const [n, k] of Object.entries(KEYMAP)) inv[String(k).toLowerCase()] = n.toLowerCase();
        const t = Object.assign({}, GP_BUTTON_KEYS);
        if (GP_START_BTN >= 0) t[GP_START_BTN] = KEYMAP.start;
        if (GP_SELECT_BTN >= 0) t[GP_SELECT_BTN] = KEYMAP.select;
        const pad = {};
        for (const [i, label] of Object.entries(t)) pad[Number(i)] = inv[String(label).toLowerCase()];
        const keys = {};
        for (const [n, k] of Object.entries(KEYMAP)) keys[String(k).toLowerCase()] = n.toLowerCase();
        return { pad, keys };
      })()`,
    },
    guest: {
      url: '/ps1_multiplayer.html',
      decls: (s) => [sliceDeclAlias(s, 'D', 'IDS'), sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_ID_ARRAY,
    },
  },
  {
    name: 'snes',
    host: {
      url: '/snes.html',
      decls: (s) => [sliceDecl(s, 'GP_BTN').text, sliceDecl(s, 'KEYMAP').text],
      normalize: `(() => ({
        pad: Object.fromEntries(Object.entries(GP_BTN).map(([i, n]) => [Number(i), String(n).toLowerCase()])),
        keys: Object.fromEntries(Object.entries(KEYMAP).map(([k, n]) => [String(k).toLowerCase(), String(n).toLowerCase()])),
      }))()`,
    },
    guest: {
      url: '/snes_multiplayer.html',
      decls: (s) => [sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_NAME_ARRAY,
    },
  },
  {
    name: 'gba',
    host: {
      // gba.html owns no tables — the vendored InputController ships the
      // defaults and the page's remap modal edits them, so THIS file is the
      // host side of the comparison.
      url: '/gba/gbaWasm/dist/input_controller.js',
      decls: (s) => [
        sliceReturnedObject(s, 'defaultKeymappings', 'DEFAULTS'),
        `const ACT = { Left:'left', Right:'right', Up:'up', Down:'down',
                       Action_A:'a', Action_B:'b',
                       Action_Start:'start', Action_Select:'select',
                       Action_L:'l', Action_R:'r' };`,
      ],
      normalize: DEFAULTS_TABLE,
    },
    guest: {
      url: '/gba_multiplayer.html',
      decls: (s) => [sliceDecl(s, 'KEYMAP').text, sliceDecl(s, 'GP').text],
      normalize: MP_NAME_ARRAY,
    },
  },
  {
    name: 'dreamcast',
    host: {
      url: '/dreamcast.html',
      decls: (s) => [
        sliceDeclAlias(s, 'RB', 'IDS'),
        sliceDecl(s, 'KEYMAP').text,
        sliceDeclAlias(s, 'GP_BTN_TO_RETRO', 'GP'),
      ],
      normalize: MP_ID_ARRAY,
    },
    guest: {
      url: '/dreamcast_multiplayer.html',
      decls: (s) => [
        sliceDeclAlias(s, 'RB', 'IDS'),
        sliceDecl(s, 'KEYMAP').text,
        sliceDeclAlias(s, 'GP_BTN_TO_RETRO', 'GP'),
      ],
      normalize: MP_ID_ARRAY,
    },
  },
];

// ---------------------------------------------------------------------------
async function fetchText(url) {
  const r = await fetch(ORIGIN + url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status} (is \`npm run web\` running?)`);
  return r.text();
}

function diffTable(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort((x, y) => (isNaN(+x) || isNaN(+y) ? String(x).localeCompare(String(y)) : +x - +y));
  const out = [];
  for (const k of keys) if ((a[k] ?? '(unbound)') !== (b[k] ?? '(unbound)')) {
    out.push({ k, host: a[k] ?? '(unbound)', guest: b[k] ?? '(unbound)' });
  }
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  (await import('./browser_leak_guard.js')).default.guard(browser, 'control_map_drift_test');

  let failures = 0;
  try {
    const page = await browser.newPage();
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });

    const readSide = async (side) => {
      const src = await fetchText(side.url);
      const decls = side.decls(src).join('\n');
      return page.evaluate(
        (d, n) => new Function(d + '\nreturn (' + n + ');')(),
        decls, side.normalize,
      );
    };

    console.log('CONTROL-MAP DRIFT — host page vs its _multiplayer.html counterpart');
    console.log('origin: ' + ORIGIN + '\n');

    for (const pair of PAIRS) {
      let host, guest;
      try {
        host = await readSide(pair.host);
        guest = await readSide(pair.guest);
      } catch (e) {
        failures++;
        console.log(`FAIL  ${pair.name.padEnd(10)} could not read the tables: ${e.message}`);
        continue;
      }
      const padDiff = diffTable(host.pad, guest.pad);
      const keyDiff = diffTable(host.keys, guest.keys);
      const n = padDiff.length + keyDiff.length;
      if (!n) {
        console.log(`PASS  ${pair.name.padEnd(10)} pad ${String(Object.keys(host.pad).length).padStart(2)} bindings, `
          + `keys ${String(Object.keys(host.keys).length).padStart(2)} bindings — identical`);
        continue;
      }
      failures++;
      console.log(`FAIL  ${pair.name.padEnd(10)} ${n} mismatch${n === 1 ? '' : 'es'}`);
      console.log(`        ${pair.host.url}  vs  ${pair.guest.url}`);
      for (const d of padDiff) {
        console.log(`        gamepad button ${String(d.k).padStart(2)}: host -> ${String(d.host).padEnd(10)} guest -> ${d.guest}`);
      }
      for (const d of keyDiff) {
        console.log(`        key ${JSON.stringify(d.k).padEnd(12)}: host -> ${String(d.host).padEnd(10)} guest -> ${d.guest}`);
      }
    }

    // -- same class, different table: a per-disc export filename ---------------
    console.log('');
    const dc = await fetchText('/dreamcast.html');
    const literal = dc.match(/\.download\s*=\s*['"`]([^'"`]*)['"`]/);
    const derived = /const stateFileName\s*=[^;\n]*currentGameKey\(\)/.test(dc);
    if (literal) {
      failures++;
      console.log(`FAIL  dreamcast  savestate export filename is the literal '${literal[1]}'`
        + ' — every disc downloads under one disc\'s name');
    } else if (!derived) {
      failures++;
      console.log('FAIL  dreamcast  no stateFileName() derived from currentGameKey() — an exported'
        + ' state cannot say which disc it came from');
    } else {
      console.log('PASS  dreamcast  savestate export filename derives from the selected disc');
    }

    console.log('');
    console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? '' : 's'})` : 'RESULT: PASS');
  } finally {
    await browser.close();
  }
  process.exit(failures ? 1 : 0);
})();
