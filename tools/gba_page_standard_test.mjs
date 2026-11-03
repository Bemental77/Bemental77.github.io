#!/usr/bin/env node
// tools/gba_page_standard_test.mjs — is gba.html the same FAMILY as ps1, n64, dreamcast, genesis and snes?
//
//   node tools/gba_page_standard_test.mjs                  # the static leg (Node only, ~1 s)
//   node tools/gba_page_standard_test.mjs --browser        # + headless Chrome: computed styles, lifecycle, gate, phone splash
//   node tools/gba_page_standard_test.mjs --browser --only desktop,behaviour,early,gate,mobile,captest   # pick sections
//   node tools/gba_page_standard_test.mjs --browser --shots <dir>           # also save PNGs (gba and the reference pages)
//
// WHY IT EXISTS. gba.html was the odd one out: a WHITE Bootstrap-4 page (blue "Play Game" / "Browse" / "Remap Buttons", a dashed
// drop box, no Party, none of the standard element ids) next to five dark pages that share one skeleton. "Looks like the same
// family" is a judgement, so this makes the judgement MECHANICAL — and it does not hard-code the standard. It COMPUTES it, at test
// time, from the five reference pages themselves:
//   * ids         every id present in >= 4 of the 5 pages (minus the room-panel namespace net*, which the later room stage owns,
//                 and the one documented geometry exemption below);
//   * libs        every /lib/*.js (and other shared script) present in >= 4 of the 5, and the order they agree on;
//   * toolbar     the pairwise order of #controlBar's children that the references agree on;
//   * css         every (selector, property) on which >= 4 of the 5 stylesheets agree, for the family's selectors;
//   * computed    the same, measured in a real browser on the rendered pages (desktop 1280x800 and the phone splash);
//   * splash      the strings and ids of the mobile splash.
// so when a sibling moves, the standard moves with it and this test cannot rot into a description of a page that no longer exists.
//
// EVERY IMPORTANT CHECK HAS A NEGATIVE CONTROL: a mutant that must trip the NAMED check ("[control]"), next to the unmutated twin that
// must stay quiet. Mutants here: rename a standard id, re-add a Bootstrap stylesheet, restore the custom startIds, show Party from outside the room wiring, swap
// two toolbar buttons, drop a library, repaint the page white (all on the page text), and — in a real browser — the same ideas on
// the live DOM, a re-enabled gated Start, a shrunk touch target and a horizontal overflow.
//
// WHAT IT DOES NOT PROVE. Chrome (headless, SwiftShader) is not WebKit, and no real phone is involved: a 390x844 emulated viewport
// with an iPhone user agent reproduces the LAYOUT and the touch-event path, not Safari's engine, its safe areas or its memory.
// No audio device is opened (every browser here is started with --mute-audio by tools/headless_cdp.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const SHOTS = opt('--shots', '');
const PORT = Number(process.env.GBA_TEST_PORT || 8092);
// GBA_CDP_OFFSET=N moves every Chrome this suite launches from 92xx to 92xx+N, so two copies (or a sibling agent's) can run at once (the browser lock is gone)
const CDP_OFFSET = Number(process.env.GBA_CDP_OFFSET) || 0;
const REFS = ['ps1.html', 'n64/index.html', 'dreamcast.html', 'genesis.html', 'snes.html'];
const GBA = 'gba.html';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const info = (s) => console.log(`       ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. PARSING. Small, string-level, deliberately dumb: the pages are hand-written HTML and this has to survive all six.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
const noNoscript = (h) => h.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
const markup = (h) => noComments(noNoscript(h)).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const idsOf = (h) => new Set([...markup(h).matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const cssOf = (h) => [...noComments(noNoscript(h)).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
const norm = (v) => String(v).replace(/\s+/g, ' ').replace(/\s*!important/i, ' !important').trim().toLowerCase();

// Depth-0 rules only ('@media' / '@supports' blocks are skipped: a rule inside one is conditional, not the page's baseline).
function parseRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const map = {}; let i = 0;
  while (i < css.length) {
    const ob = css.indexOf('{', i); if (ob < 0) break;
    const sel = css.slice(i, ob).trim();
    let d = 1, j = ob + 1;
    while (j < css.length && d > 0) { if (css[j] === '{') d++; else if (css[j] === '}') d--; j++; }
    const body = css.slice(ob + 1, j - 1);
    if (sel && !sel.startsWith('@')) {
      const decls = {};
      body.split(';').forEach((x) => { const k = x.indexOf(':'); if (k > 0) decls[x.slice(0, k).trim().toLowerCase()] = norm(x.slice(k + 1)); });
      for (const one of sel.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) map[one] = Object.assign(map[one] || {}, decls);
    }
    i = j;
  }
  return map;
}

// The element opened by `<tag ... id="X" ...>` -> its attribute text, or null.
function openTagOf(h, id) {
  const m = new RegExp('<([a-zA-Z0-9]+)\\b([^>]*\\sid="' + id + '"[^>]*)>', 'i').exec(noComments(noNoscript(h)).replace(/<script[\s\S]*?<\/script>/gi, ''));
  return m ? m[2] : null;
}
// The inner HTML of the element whose open tag is at `at` (balanced over tags of the same name).
function balancedInner(h, at, tag) {
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi'); re.lastIndex = at;
  let d = 0, m, begin = -1;
  while ((m = re.exec(h))) {
    if (!m[1]) { d++; if (begin < 0) begin = re.lastIndex; } else { d--; if (d === 0) return h.slice(begin, m.index); }
  }
  return null;
}
// The ids of #controlBar's DIRECT children, in document order.
function barChildren(h) {
  const t = markup(h);
  const at = t.search(/<div id="controlBar"/); if (at < 0) return [];
  const inner = balancedInner(t, at, 'div') || '';
  const out = []; const re = /<(\/?)([a-zA-Z0-9]+)\b([^>]*)>/g; let m, depth = 0;
  while ((m = re.exec(inner))) {
    const [, close, tag, attrs] = m;
    const selfClosing = /\/\s*$/.test(attrs) || /^(input|br|img|hr)$/i.test(tag);
    if (close) { depth--; continue; }
    if (depth === 0) { const id = /\bid="([^"]+)"/.exec(attrs); if (id) out.push(id[1]); }
    if (!selfClosing) depth++;
  }
  return out;
}
const scriptSrcs = (h) => [...noComments(h).matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]);
const libKey = (src) => src.split('?')[0];
const textBetween = (h, re) => { const m = re.exec(markup(h)); return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null; };
const stripJsComments = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const inlineJs = (h) => [...noComments(h).matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => stripJsComments(m[1])).join('\n');

// A strict majority among the values, or null: the best value must be held by >= max(2, N - 1) of the N that HAVE a value.
function majority(values) {
  const have = values.filter((v) => v !== undefined && v !== null);
  if (have.length < 3) return null;
  const cnt = new Map(); have.forEach((v) => cnt.set(v, (cnt.get(v) || 0) + 1));
  const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
  return best[1] >= Math.max(3, have.length - 1) ? best[0] : null;
}

// Pairwise order the references agree on: a before b is a rule when >=3 pages order the pair and the majority is strict, or when 2
// pages do and neither dissents. Returns f(a,b) -> -1 (a first), 1 (b first), 0 (no rule).
function pairRule(lists) {
  const v = new Map();
  for (const l of lists) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { const k = l[i] + '\u0000' + l[j]; v.set(k, (v.get(k) || 0) + 1); }
  return (a, b) => {
    const ab = v.get(a + '\u0000' + b) || 0, ba = v.get(b + '\u0000' + a) || 0, n = ab + ba;
    if (n < 2 || ab === ba) return 0;
    if (n === 2 && ab !== 0 && ba !== 0) return 0;
    return ab > ba ? -1 : 1;
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. THE STANDARD, computed from the five reference pages.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Documented exemptions. Each is a statement about the GBA SP clamshell, not a convenience.
const EXEMPT_IDS = {
  mobileBottom: 'the other shells hold Start and the menu button in one #mobileBottom bar; the GBA SP clamshell puts the menu button in #spMenuRow and Start/Select in #spSys (the layout the user-facing touch tests were built around)',
};
// The room panel (#netOverlay and every net* id) is the ROOM STAGE's. The two Party buttons are NOT exempt: they must exist, hidden in the
// markup, and be unhidden ONLY by the room wiring behind Netplay.supported() (stage GR2 wired it; before that they stayed hidden for good).
const ROOM_ID = /^net[A-Z]/;
// netplay.js is loaded since stage GR2 (the room is formed on this page). mpgames.js is the LOBBY's catalogue (a later stage) and stays out.
const ROOM_STAGE_LIBS = ['/lib/mpgames.js'];
// The body of a named inline function (brace-matched), '' when absent.
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const o = src.indexOf('{', i); let d = 0;
  for (let k = o; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(o, k + 1); }
  return '';
}
// Selectors whose rules are the family's skeleton. Everything the references agree on for each is required of gba.html.
const FAMILY_SELECTORS = ['html', 'body', '#desktop', '#title', '#controlBar', '#controlBar button', '#controlBar button:hover:not(:disabled)',
  '#controlBar button:disabled', '#controlBar select', '#canvasWrap', '#statusBar', '#mobileSplash', '#mobileSplash h3',
  '#mobileSplash button#mobileSplashStart', '#mobileSplash .rotateTip', '#toast', '#toast.show', '#toast.err', '#mobileStatus', '#rotateHint',
  '#mobileMenu', '#mobileMenuBox', '.menuBtn', '.sysBtn', '#mobileShell', '#canvas'];
// Where gba.html is ALLOWED to differ, with the reason. (selector|property -> why)
const EXEMPT_CSS = {
  '#canvas|aspect-ratio': 'a GBA frame is 3:2 (240x160); the other five display at 4:3. tools/device_matrix.mjs asserts "3 / 2" on this page.',
};

function computeStandard() {
  const pages = REFS.map((p) => ({ p, html: read(p) }));
  const std = { refs: pages.map((x) => x.p) };
  // ids
  const idCount = new Map();
  for (const { html } of pages) for (const id of idsOf(html)) idCount.set(id, (idCount.get(id) || 0) + 1);
  std.ids = [...idCount.entries()].filter(([id, n]) => n >= 4 && !ROOM_ID.test(id) && !EXEMPT_IDS[id]).map(([id]) => id).sort();
  std.exemptIds = Object.keys(EXEMPT_IDS).filter((id) => (idCount.get(id) || 0) >= 4);
  // libs and their order
  const libCount = new Map(); const libLists = [];
  for (const { html } of pages) { const l = [...new Set(scriptSrcs(html).map(libKey).filter((s) => s.startsWith('/')))]; libLists.push(l); l.forEach((s) => libCount.set(s, (libCount.get(s) || 0) + 1)); }
  std.libs = [...libCount.entries()].filter(([, n]) => n >= 4).map(([s]) => s);
  std.libOrder = pairRule(libLists.map((l) => l.filter((s) => std.libs.includes(s))));
  // toolbar
  std.bars = pages.map(({ html }) => barChildren(html));
  std.barOrder = pairRule(std.bars);
  // css
  const rules = pages.map(({ html }) => parseRules(cssOf(html)));
  std.css = {};
  for (const sel of FAMILY_SELECTORS) {
    const defining = rules.filter((r) => r[sel]);
    if (defining.length < 4) continue;
    const props = new Set(); defining.forEach((r) => Object.keys(r[sel]).forEach((k) => props.add(k)));
    for (const k of props) {
      const vals = rules.map((r) => (r[sel] ? r[sel][k] : undefined));
      const m = majority(vals);
      if (m !== null && vals.filter((v) => v === m).length >= 4) (std.css[sel] = std.css[sel] || {})[k] = m;
    }
  }
  // splash strings
  std.splash = {
    label: majority(pages.map(({ html }) => textBetween(html, /<label for="mobileRomSelect"[^>]*>([\s\S]*?)<\/label>/))),
    tip: majority(pages.map(({ html }) => textBetween(html, /<p class="rotateTip"[^>]*>([\s\S]*?)<\/p>/))),
    start: majority(pages.map(({ html }) => textBetween(html, /<button id="mobileSplashStart"[^>]*>([\s\S]*?)<\/button>/))),
    hint: majority(pages.map(({ html }) => textBetween(html, /<div id="rotateHint"[^>]*>([\s\S]*?)<\/div>/))),
    // the heading AND the splash title read "<CONSOLE> Wasm" on >= 4 of the references (ps1's <title> carries a suffix and dreamcast's
    // says "(Bemental77)", so the on-page headings are the standard, not <title>); the pattern is the standard, the console name is not
    titlePattern: pages.filter(({ html }) => /<h3 id="title">[A-Za-z0-9 ]+ Wasm<\/h3>/.test(html) || /<div id="mobileSplash">\s*<h3>[A-Za-z0-9 ]+ Wasm<\/h3>/.test(markup(html))).length >= 4 ? 'X Wasm' : null,
  };
  // the viewport meta: the content >= 4 of the 5 agree on (dreamcast.html alone omits user-scalable/viewport-fit)
  std.viewport = majority(pages.map(({ html }) => { const m = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(noComments(html)); return m ? m[1].replace(/\s+/g, ' ').trim() : null; }));
  // how each page calls the gate
  std.gateCalls = pages.map(({ html, p }) => ({ p, call: (/Capability\.autoGate\(([^;]*?)\)\s*;/.exec(inlineJs(html)) || [])[1] || null }));
  return std;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. THE STATIC JUDGE. Pure: (page text, script.js text, std) -> [{name, ok, detail}]. Run on the real page AND on mutants.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function judgeStatic(html, scriptJs, std) {
  const r = [];
  const add = (name, cond, detail = '') => r.push({ name, ok: !!cond, detail });
  const ids = idsOf(html);

  // ids
  const missing = std.ids.filter((id) => !ids.has(id));
  add('ids', missing.length === 0, missing.length ? 'missing: ' + missing.join(' ') : `${std.ids.length} standard ids present`);

  // Party: present in both standard places, HIDDEN in the markup, and unhidden ONLY by the room wiring (the inline wireNetplay(), whose first
  // statement is the Netplay.supported() guard) - never by script.js and never by any other page code.
  const nt = openTagOf(html, 'btnNet'), sn = openTagOf(html, 'mobileSplashNet');
  const hiddenAttr = (t) => !!t && /\shidden(\s|=|$)/.test(' ' + t.replace(/style="[^"]*"/g, ''));
  const inl = inlineJs(html);
  const wire = fnBody(inl, 'wireNetplay');
  const outside = wire ? inl.replace(wire, '') : inl;
  const unhides = (src) => src.split('\n').some((l) => /btnNet|mobileSplashNet|mNet/.test(l) && /\.hidden\s*=\s*false|removeAttribute\(\s*['"]hidden|\.style\.display|classList|\.style\.cssText|setAttribute/.test(l));
  const guarded = /^\{\s*if \(!netSupported\(\)\) return;/.test(wire);
  const shown = unhides(outside) || /btnNet|mobileSplashNet/.test(stripJsComments(scriptJs));
  add('party-wired', hiddenAttr(nt) && hiddenAttr(sn) && guarded && /\.hidden\s*=\s*false/.test(wire) && !shown, `btnNet hidden=${hiddenAttr(nt)} mobileSplashNet hidden=${hiddenAttr(sn)} wiring guarded by Netplay.supported()=${guarded} unhidden elsewhere=${shown}`);

  // toolbar order
  const bar = barChildren(html);
  const bad = [];
  for (let i = 0; i < bar.length; i++) for (let j = i + 1; j < bar.length; j++) if (std.barOrder(bar[i], bar[j]) === 1) bad.push(`${bar[i]} before ${bar[j]}`);
  add('toolbar-order', bad.length === 0 && bar.length > 8, bad.length ? 'violates the references: ' + bad.slice(0, 4).join('; ') : `${bar.length} controls: ${bar.join(' ')}`);
  // the GBA additions sit where their sibling idioms put them
  const at = (id) => bar.indexOf(id);
  const extras = at('btnExportSav') === at('btnImport') + 1 && at('btnImportSav') === at('btnExportSav') + 1 && at('btnBrowse') === at('btnStart') + 1
    && at('btnRemap') > at('btnFull') && at('btnRemap') < at('btnNet') && at('btnNet') === bar.length - 1;
  add('toolbar-gba-additions', extras, 'Browse after Start; Export/Import .sav straight after Import State; Remap after Fullscreen; Party last');

  // libs
  const srcs = scriptSrcs(html).map(libKey);
  const missingLibs = std.libs.filter((l) => !srcs.includes(l) && !ROOM_STAGE_LIBS.includes(l));
  const order = []; const have = srcs.filter((l, i) => std.libs.includes(l) && srcs.indexOf(l) === i);   // gba's own order
  for (let i = 0; i < have.length; i++) for (let j = i + 1; j < have.length; j++) if (std.libOrder(have[i], have[j]) === 1) order.push(`${have[i].split('/').pop()} is before ${have[j].split('/').pop()} (the references load it after)`);
  add('libs', missingLibs.length === 0, missingLibs.length ? 'missing: ' + missingLibs.join(' ') : `${have.length} shared libs present: ${have.map((l) => l.split('/').pop()).join(' ')}`);
  add('libs-order', order.length === 0, order.length ? order.join('; ') : 'in the order the references agree on');
  add('room-wiring', srcs.filter((s) => s === '/lib/netplay.js').length === 1 && !srcs.some((s) => ROOM_STAGE_LIBS.includes(s)) && !srcs.some((s) => /netplay-host/.test(s)), 'lib/netplay.js (the lockstep engine) is loaded once; mpgames.js (the lobby catalogue) and netplay-host.js (the streaming half) are not');
  add('no-coi-no-vendor-scripts', !srcs.some((s) => /coi-serviceworker|\/gba\/vendor\//.test(s)), srcs.filter((s) => /coi-serviceworker|\/gba\/vendor\//.test(s)).join(' '));

  // the Bootstrap look and its stack are gone
  const sheets = [...noComments(html).matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((m) => m[0]);
  // whole class tokens only: this page's own .btn-a / .sp-btn-circle are not Bootstrap's .btn
  const BS = new Set(['btn', 'btn-primary', 'btn-secondary', 'btn-outline-secondary', 'btn-sm', 'container', 'form-control', 'form-group', 'alert', 'alert-danger', 'alert-warning', 'modal', 'modal-dialog', 'modal-content', 'nav-tabs', 'nav-link', 'nav-item', 'close', 'table', 'text-center']);
  const bsClasses = [...markup(html).matchAll(/\sclass="([^"]*)"/g)].some((m) => m[1].split(/\s+/).some((t) => BS.has(t) || /^m[tbxy]?-\d$/.test(t)));
  const stackJs = /\$\(|\bjQuery\b|\brivets\b|\btoastr\b|\.modal\(/.test(stripJsComments(scriptJs)) || /\bjQuery\b|\brivets\b|\btoastr\b|\.modal\(/.test(inlineJs(html));
  add('no-bootstrap-stack', sheets.length === 0 && !bsClasses && !/\srv-[a-z]/.test(markup(html)) && !stackJs, `stylesheets=${sheets.length} bootstrap classes=${bsClasses} rivets attrs=${/\srv-[a-z]/.test(markup(html))} jquery/rivets/toastr in code=${stackJs}`);

  // the capability gate uses the DEFAULT start ids (the standard ids carry the aria-disabled protocol)
  const gate = /Capability\.autoGate\(([^;]*?)\)\s*;/.exec(inlineJs(html));
  const refCalls = std.gateCalls.filter((g) => g.call && /^Capability\.SPECS\.\w+$/.test(g.call.trim())).length;
  add('gate-default-start-ids', !!gate && gate[1].trim() === 'Capability.SPECS.gba' && !/startIds|btnPlayGame|spLoadBtn/.test(html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')), `call: autoGate(${gate ? gate[1].trim() : '(none)'}); ${refCalls}/5 references call it with the spec alone`);
  add('gate-protocol', /aria-disabled/.test(scriptJs) && ids.has('btnStart') && ids.has('mobileSplashStart'), 'script.js reads aria-disabled before re-enabling Start; both standard Start ids exist for lib/capability.js to hold down');

  // title and splash strings
  add('title', std.splash.titlePattern === 'X Wasm' && /<title>GBA Wasm<\/title>/.test(html) && /<h3 id="title">GBA Wasm<\/h3>/.test(html) && /<div id="mobileSplash">\s*<h3>GBA Wasm<\/h3>/.test(markup(html)), `the references' <title> pattern is "${std.splash.titlePattern}"`);
  const label = textBetween(html, /<label for="mobileRomSelect"[^>]*>([\s\S]*?)<\/label>/), tip = textBetween(html, /<p class="rotateTip"[^>]*>([\s\S]*?)<\/p>/);
  add('splash-strings', label === std.splash.label && tip === std.splash.tip && textBetween(html, /<button id="mobileSplashStart"[^>]*>([\s\S]*?)<\/button>/) === std.splash.start, `"${label}" / "${tip}" vs the references' "${std.splash.label}" / "${std.splash.tip}"`);
  add('rotate-hint', textBetween(html, /<div id="rotateHint"[^>]*>([\s\S]*?)<\/div>/) === std.splash.hint, `"${std.splash.hint}"`);

  // CSS: every (selector, property) the references agree on
  const mine = parseRules(cssOf(html)); const diffs = [];
  for (const [sel, props] of Object.entries(std.css)) {
    for (const [k, v] of Object.entries(props)) {
      if (EXEMPT_CSS[sel + '|' + k]) continue;
      const got = mine[sel] ? mine[sel][k] : undefined;
      if (got === undefined) diffs.push(`${sel} { ${k} } missing (want ${v})`);
      else if (norm(got) !== norm(v)) diffs.push(`${sel} { ${k}: ${got} } want ${v}`);
    }
  }
  const nProps = Object.values(std.css).reduce((a, p) => a + Object.keys(p).length, 0);
  add('css-tokens', diffs.length === 0, diffs.length ? `${diffs.length} differ: ` + diffs.slice(0, 5).join(' | ') : `${nProps} properties on ${Object.keys(std.css).length} selectors match the references`);
  add('canvas-aspect-3-2', (parseRules(cssOf(html))['#canvas'] || {})['aspect-ratio'] === '3 / 2', 'the one declared difference: 3 / 2, not 4 / 3');

  // nothing may flash white while loading
  const firstStyle = html.indexOf('<style'), firstScriptSrc = html.search(/<script\b[^>]*\ssrc=/);
  const early = /<style>[^<]*html,\s*body\s*\{[^}]*background:\s*#111/.exec(html.slice(0, firstScriptSrc > 0 ? firstScriptSrc : 0));
  add('no-white-flash', firstStyle > 0 && firstStyle < firstScriptSrc && !!early, 'an inline #111 style precedes the first <script src>');

  // the viewport: without it a phone lays the page out at 980 px and the splash/shell are scaled-down desktop. CDP's device-metrics
  // override does NOT need the meta, so the browser leg cannot see it go - it has to be read here.
  const vp = (/<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(noComments(html)) || [])[1];
  add('viewport-meta', !!std.viewport && !!vp && vp.replace(/\s+/g, ' ').trim() === std.viewport, `"${vp || '(none)'}" vs the references' "${std.viewport}"`);
  // libs only SOME references load, but which this page's own features depend on: ROM URLs go through ASSET_BASE (lib/asset_base.js),
  // the mGBA AudioPipe feeds lib/cart_audio.js, and lib/audiodiag.js is what Copy debug reads for the audio section
  const needLibs = ['/lib/asset_base.js', '/lib/cart_audio.js', '/lib/audiodiag.js'];
  const missNeed = needLibs.filter((l) => !srcs.includes(l));
  add('gba-own-libs', missNeed.length === 0, missNeed.length ? 'missing: ' + missNeed.join(' ') : needLibs.map((l) => l.split('/').pop()).join(' ') + ' present');
  add('autosave-wired', /Autosave\.init\(\{[\s\S]*canSave[\s\S]*roomLocked[\s\S]*save:/.test(inlineJs(html)), 'Autosave.init with canSave refusing a room (roomLocked) and save: -> saveStateLocal');

  // the JS-off floor and the debug button
  add('noscript-floor', /<noscript>\s*<style>[^<]*#desktop,\s*#mobileShell\s*\{\s*display:\s*none\s*!important/.test(html) && ids.has('nojs'), '#nojs + the noscript rule hiding #desktop and #mobileShell');
  const dbg = /data-debugreport="bar"/.test(html) && /data-debugreport="menu"/.test(html) && /data-debugreport="splash"/.test(html);
  const libSpots = (() => { try { const m = /gba:\s*\{[^}]*\}/.exec(read('lib/debugreport.js')); return m ? m[0] : ''; } catch (e) { return ''; } })();
  const libStandard = /#controlBar/.test(libSpots) && /#mClose/.test(libSpots) && /#mobileSplashNet/.test(libSpots);
  // lib/debugreport.js owns the spots (SPOTS.gba: #controlBar, #mClose, #mobileSplashNet and the Party panel's #netClose); gba.html used to
  // mount the buttons itself while SPOTS.gba still named the old Bootstrap page, and that mount is gone: a second mount would be dead weight.
  add('debug-report-spots', libStandard && !dbg, libStandard ? (dbg ? 'SPOTS.gba is standard but gba.html still carries a mount of its own (redundant)' : 'lib/debugreport.js SPOTS.gba uses the standard anchors and gba.html mounts nothing itself') : 'lib/debugreport.js SPOTS.gba is not the standard shape');
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. THE STATIC LEG: the real page, then the mutants.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const failing = (rs) => rs.filter((x) => !x.ok).map((x) => x.name);
function staticLeg() {
  section('static: gba.html against the standard computed from ' + REFS.join(', '));
  const std = computeStandard();
  info(`standard: ${std.ids.length} ids (>= 4 of 5), ${std.libs.length} libs, ${Object.keys(std.css).length} css selectors; exempt id(s): ${std.exemptIds.join(', ') || 'none'} (${std.exemptIds.map((i) => EXEMPT_IDS[i]).join('; ')})`);
  const html = read(GBA), script = read('gba/gbaWasm/dist/script.js');
  const res = judgeStatic(html, script, std);
  res.forEach((x) => ok(x.name, x.ok, x.detail));

  // The standard must be what the references say, not an empty set the page passes vacuously.
  ok('the computed standard is not vacuous (>= 25 ids, >= 6 libs, >= 100 css properties, a toolbar order with >= 20 rules)',
    std.ids.length >= 25 && std.libs.length >= 6 && Object.values(std.css).reduce((a, p) => a + Object.keys(p).length, 0) >= 100
      && (() => { let n = 0; const all = [...new Set(std.bars.flat())]; for (const a of all) for (const b of all) if (a < b && std.barOrder(a, b) !== 0) n++; return n >= 20; })(),
    `ids ${std.ids.length}, libs ${std.libs.length}`);
  // each reference page must itself pass the judge's reading of its own order/lib rules (the rules are consistent with their own source)
  const selfCheck = REFS.map((p) => { const b = barChildren(read(p)); let v = 0; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (std.barOrder(b[i], b[j]) === 1) v++; return [p, v]; });
  info('toolbar-rule violations inside the references themselves (each is a page that disagrees with its siblings): ' + selfCheck.map(([p, v]) => `${p}=${v}`).join(' '));

  // ── NEGATIVE CONTROLS: each mutant must trip its NAMED check; the unmutated twin has already passed above.
  const mutate = (name, fn, expectCheck, scriptJs = script) => {
    const m = fn(html);
    if (m === html && scriptJs === script) { ok(`[control] ${name} - the mutation applied`, false, 'the pattern was not found in gba.html'); return; }
    const out = judgeStatic(m, scriptJs, std);
    const bad = failing(out);
    control(`${name} fails "${expectCheck}"`, bad.includes(expectCheck), 'failed: ' + (bad.join(', ') || 'nothing'));
  };
  mutate('renaming #btnSave to #btnSaveState', (h) => h.replace('id="btnSave"', 'id="btnSaveState"'), 'ids');
  mutate('renaming #mobileSplashStart', (h) => h.replace('id="mobileSplashStart"', 'id="btnPlay"'), 'ids');
  mutate('removing #canvasWrap', (h) => h.replace('id="canvasWrap"', 'id="stage"'), 'ids');
  mutate('re-adding the Bootstrap stylesheet', (h) => h.replace('<title>GBA Wasm</title>', '<title>GBA Wasm</title><link rel="stylesheet" href="/gba/vendor/bootstrap.min.css">'), 'no-bootstrap-stack');
  mutate('a Bootstrap button class on Start', (h) => h.replace('<button id="btnStart" disabled>', '<button id="btnStart" class="btn btn-primary" disabled>'), 'no-bootstrap-stack');
  mutate('re-adding jQuery', (h) => h.replace('<script src="/lib/wakelock.js"></script>', '<script src="/gba/vendor/jquery-3.3.1.min.js"></script><script src="/lib/wakelock.js"></script>'), 'no-coi-no-vendor-scripts');
  mutate('restoring the custom startIds', (h) => h.replace('Capability.autoGate(Capability.SPECS.gba)', "Capability.autoGate(Capability.SPECS.gba, { startIds: ['btnPlayGame', 'spLoadBtn'] })"), 'gate-default-start-ids');
  mutate('making the toolbar Party button visible', (h) => h.replace('<button id="btnNet" type="button" hidden>', '<button id="btnNet" type="button">'), 'party-wired');
  mutate('making the splash Party button visible', (h) => h.replace('<button id="mobileSplashNet" type="button" hidden', '<button id="mobileSplashNet" type="button"'), 'party-wired');
  mutate('page code that shows Party', (h) => h.replace('</body>', "<script>document.getElementById('btnNet').hidden = false;</script></body>"), 'party-wired');
  mutate('the room wiring without its Netplay.supported() guard', (h) => h.replace('function wireNetplay() {\n      if (!netSupported()) return;', 'function wireNetplay() {\n'), 'party-wired');
  mutate('swapping Save State and Load State in the toolbar', (h) => { const a = '<button id="btnSave" disabled>Save State</button>', b = '<button id="btnLoad" disabled>Load State</button>'; return h.includes(a) && h.includes(b) ? h.replace(a, '@@A@@').replace(b, a).replace('@@A@@', b) : h; }, 'toolbar-order');
  mutate('moving Party off the end of the toolbar', (h) => h.replace('<button id="btnNet" type="button" hidden>Party</button>', '').replace('<button id="btnStart" disabled>', '<button id="btnNet" type="button" hidden>Party</button>\n    <button id="btnStart" disabled>'), 'toolbar-order');
  mutate('dropping lib/volume.js', (h) => h.replace('<script src="/lib/volume.js?v=1"></script>', ''), 'libs');
  // (stamp-agnostic: tools/stamp_lib_versions.mjs rewrites every ?v= hash when a lib changes, and a mutant that quotes one goes quietly inert)
  mutate('loading lib/xboxinput.js BEFORE lib/capability.js', (h) => { const m = /<script src="\/lib\/capability\.js[^"]*"><\/script>/.exec(h); return m ? h.replace(m[0], '').replace('<script src="/lib/xboxinput.js"></script>', '<script src="/lib/xboxinput.js"></script>' + m[0]) : h; }, 'libs-order');
  mutate('loading the STREAMING host', (h) => h.replace('<script src="/lib/wakelock.js"></script>', '<script src="/lib/wakelock.js"></script><script src="/lib/netplay-host.js"></script>'), 'room-wiring');
  mutate('dropping lib/netplay.js (the lockstep engine)', (h) => h.replace(/<script src="\/lib\/netplay\.js[^"]*"><\/script>/, ''), 'room-wiring');
  mutate('repainting the page white', (h) => h.replace('html, body { margin: 0; padding: 0; height: 100%; background: #111;', 'html, body { margin: 0; padding: 0; height: 100%; background: #fff;'), 'css-tokens');
  mutate('a different button colour', (h) => h.replace('#controlBar button { padding: 8px 14px; border: 1px solid #444; background: #222;', '#controlBar button { padding: 8px 14px; border: 1px solid #444; background: #007bff;'), 'css-tokens');
  mutate('the 4:3 aspect the other five use', (h) => h.replace('aspect-ratio: 3 / 2; max-width: 100%; max-height: 100%; }', 'aspect-ratio: 4 / 3; max-width: 100%; max-height: 100%; }'), 'canvas-aspect-3-2');
  mutate('a white flash window (the guard style moved after the scripts)', (h) => h.replace('<style>html, body { background: #111; color: #ddd; }</style>', ''), 'no-white-flash');
  mutate('a different title', (h) => h.replace('<title>GBA Wasm</title>', '<title>Game Boy Advance Player</title>'), 'title');
  mutate('a different splash line', (h) => h.replace('Rotate to landscape for the best view.', 'Turn your phone.'), 'splash-strings');
  mutate('Browse moved away from Start', (h) => h.replace('<button id="btnBrowse" disabled>Browse…</button>', '').replace('<button id="btnRemap" type="button">', '<button id="btnBrowse" disabled>Browse…</button><button id="btnRemap" type="button">'), 'toolbar-gba-additions');
  mutate('removing the viewport meta', (h) => h.replace(/<meta name="viewport"[^>]*>/, ''), 'viewport-meta');
  mutate('a viewport that allows pinch-zoom (no user-scalable=no)', (h) => h.replace('width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover', 'width=device-width, initial-scale=1.0'), 'viewport-meta');
  mutate('dropping lib/audiodiag.js', (h) => h.replace('<script src="/lib/audiodiag.js"></script>', ''), 'gba-own-libs');
  mutate('dropping lib/cart_audio.js', (h) => h.replace(/<script src="\/lib\/cart_audio\.js[^"]*"><\/script>/, ''), 'gba-own-libs');
  mutate('dropping lib/asset_base.js', (h) => h.replace(/<script src="\/lib\/asset_base\.js[^"]*"><\/script>/, ''), 'gba-own-libs');
  mutate('removing the Autosave.init call', (h) => h.replace(/Autosave\.init\(\{[\s\S]*?\}\);/, ''), 'autosave-wired');
  mutate('an Auto-save that ignores roomLocked', (h) => h.replace(' && !window.myApp.roomLocked', ''), 'autosave-wired');
  mutate('script.js using toastr again', () => html, 'no-bootstrap-stack', script + '\ntoastr.info("x");\n');
  mutate('script.js using jQuery again', () => html, 'no-bootstrap-stack', script + '\n$("#x").show();\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 5. THE BROWSER LEG
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ev = (page, fn, arg) => page.eval('(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')');
const evAsync = (page, fn, arg) => page.eval('(async () => (' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + '))()');
let HC = null;
async function loadHarness() { if (!HC) HC = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href); return HC; }
async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba.html`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}
function cpuLoad() {
  try { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 }); const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null; } catch (_e) { return null; }
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot(path.join(SHOTS, name)); } };

// Computed styles, in the page. `spec` is [[label, [selector alternatives], [props]]]. A missing element gives null.
const COMPUTED = (spec) => {
  const out = {};
  for (const [label, sels, props] of spec) {
    let el = null; for (const s of sels) { el = document.querySelector(s); if (el) break; }
    if (!el) { out[label] = null; continue; }
    const cs = getComputedStyle(el), o = {};
    for (const p of props) o[p] = cs[p];
    out[label] = o;
  }
  return out;
};
const DESKTOP_SPEC = [
  ['body', ['body'], ['backgroundColor', 'color', 'fontFamily', 'overflow', 'marginTop']],
  ['desktop', ['#desktop', '#wrap'], ['display', 'flexDirection', 'alignItems', 'paddingTop', 'rowGap']],
  ['title', ['#title'], ['fontSize', 'letterSpacing', 'color', 'marginTop', 'textAlign']],
  ['controlBar', ['#controlBar'], ['display', 'flexWrap', 'justifyContent', 'columnGap']],
  ['button', ['#btnStart'], ['backgroundColor', 'color', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderTopLeftRadius', 'fontSize', 'minHeight', 'minWidth', 'paddingTop', 'paddingLeft', 'cursor']],
  ['select', ['#romSelect'], ['backgroundColor', 'color', 'borderTopColor', 'borderTopLeftRadius', 'fontSize', 'minHeight']],
  ['stage', ['#canvasWrap'], ['backgroundColor', 'display', 'alignItems', 'justifyContent']],
  ['statusBar', ['#statusBar'], ['color', 'fontSize', 'fontFamily', 'columnGap', 'display']],
  ['keyHelp', ['#keyHelp'], ['color', 'fontSize', 'textAlign', 'lineHeight']],
  ['toast', ['#toast'], ['position', 'backgroundColor', 'color', 'fontSize', 'borderTopLeftRadius', 'pointerEvents']],
];
const SPLASH_SPEC = [
  ['splash', ['#mobileSplash'], ['display', 'position', 'flexDirection', 'alignItems', 'justifyContent', 'rowGap', 'paddingTop', 'zIndex', 'color', 'textAlign']],
  ['h3', ['#mobileSplash h3'], ['fontSize', 'marginTop']],
  ['select', ['#mobileSplash select'], ['fontSize', 'backgroundColor', 'color', 'borderTopLeftRadius', 'minWidth']],
  ['start', ['#mobileSplashStart'], ['backgroundColor', 'color', 'borderTopColor', 'borderTopLeftRadius', 'fontSize', 'minWidth']],
  ['tip', ['#mobileSplash .rotateTip'], ['fontSize', 'opacity']],
];
function computedMajority(maps, label) {
  const out = {};
  const have = maps.map((m) => m && m[label]).filter(Boolean);
  if (have.length < 3) return out;
  for (const k of Object.keys(have[0])) { const m = majority(have.map((h) => h[k])); if (m !== null) out[k] = m; }
  return out;
}
const diffComputed = (mine, std) => { const bad = []; for (const [k, v] of Object.entries(std)) if (!mine || mine[k] !== v) bad.push(`${k}: ${mine ? mine[k] : 'no element'} want ${v}`); return bad; };

async function gotoReady(page, url, readyExpr) {
  await page.navigate(url);
  if (readyExpr) await page.waitFor(readyExpr, { timeoutMs: 45000 });
  await sleep(500);
}
async function clickCentre(page, sel) {
  const r = await ev(page, (s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2); const h = document.elementFromPoint(x, y); return { x, y, hit: !!h && (h === e || e.contains(h)) }; }, sel);
  if (!r || !r.hit) throw new Error('clickCentre: ' + sel + ' is not what is at its own centre: ' + JSON.stringify(r));
  await page.click(r.x, r.y);
}

// What the page looks like right now (one function, so a mutant can be judged by the SAME code as the real page).
const SNAPSHOT = () => {
  const $ = (id) => document.getElementById(id);
  const bar = [...$('controlBar').children].filter((e) => !e.hidden && getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), dis: !!e.disabled }; });
  const sheets = [...document.styleSheets].map((s) => ({ owner: s.ownerNode ? s.ownerNode.tagName : '?', href: s.href || '' }));
  const dis = (id) => (($(id) || {}).disabled);
  return {
    bar, sheets,
    linkSheets: sheets.filter((s) => s.owner === 'LINK').map((s) => s.href),
    globals: { jQuery: typeof window.jQuery, rivets: typeof window.rivets, toastr: typeof window.toastr, bootstrap: typeof window.bootstrap },
    bsVisual: document.querySelectorAll('.btn, .btn-primary, .form-control, .container, .alert').length,
    partyVisible: ['btnNet', 'mobileSplashNet'].map((id) => { const e = $(id); return e ? { id, shown: !!(e.offsetWidth || e.offsetHeight) && !e.hidden } : { id, shown: null }; }),
    partyText: ($('btnNet') || {}).textContent,
    lifecycle: Object.fromEntries(['btnStart', 'btnBrowse', 'btnSave', 'btnLoad', 'btnExport', 'btnImport', 'btnExportSav', 'btnImportSav', 'btnReset', 'btnMute', 'btnFull', 'btnRemap'].map((id) => [id, dis(id)])),
    status: ($('status') || {}).textContent, fps: ($('fps') || {}).textContent, keyHelp: ($('keyHelp') || {}).textContent,
    autosave: (() => { const l = document.querySelector('#controlBar .autosaveToggle'); const s = $('btnSave'); return !!l && !!s && l.previousElementSibling === s; })(),
    volume: (() => { const v = document.querySelector('#controlBar .bem-volume'); const m = $('btnMute'); return !!v && !!m && v.previousElementSibling === m; })(),
    debugBtns: ['bar', 'menu', 'splash'].map((k) => { const e = document.querySelector('[data-debugreport="' + k + '"]'); return { k, present: !!e, text: e ? e.textContent.trim() : null }; }),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    hscroll: document.documentElement.scrollWidth - innerWidth,
  };
};
// Items on the same visual row, left to right, then rows top to bottom.
const visualOrder = (bar) => [...bar].sort((a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x)).map((x) => x.id);

function judgeDesktopPre(s, std, domOrderIds) {
  const r = []; const add = (name, cond, detail = '') => r.push({ name, ok: !!cond, detail });
  add('browser: no stylesheet <link> (only inline <style>)', s.linkSheets.length === 0, JSON.stringify(s.linkSheets));
  add('browser: jQuery / rivets / toastr / bootstrap are not loaded and no Bootstrap element is on the page', Object.values(s.globals).every((v) => v === 'undefined') && s.bsVisual === 0, JSON.stringify({ g: s.globals, bs: s.bsVisual }));
  add('browser: Party (#btnNet) is visible and reads "Party" once the room module has loaded; the splash Party exists but only the phone shell shows it', s.partyVisible[0].shown === true && s.partyText === 'Party' && s.partyVisible[1].shown === false, JSON.stringify({ v: s.partyVisible, text: s.partyText }));
  add('browser: the rendered toolbar reads left-to-right, top-to-bottom in DOM order', JSON.stringify(visualOrder(s.bar)) === JSON.stringify(domOrderIds), visualOrder(s.bar).join(' '));
  add('browser: Save/Load/Export/Import/.sav/Reset/Mute/Fullscreen are all disabled before a game runs; Start and Browse are enabled',
    ['btnSave', 'btnLoad', 'btnExport', 'btnImport', 'btnExportSav', 'btnImportSav', 'btnReset', 'btnMute', 'btnFull'].every((id) => s.lifecycle[id] === true) && s.lifecycle.btnStart === false && s.lifecycle.btnBrowse === false, JSON.stringify(s.lifecycle));
  add('browser: the Auto-save checkbox follows Save State and the volume slider follows Mute (lib/autosave.js, lib/volume.js)', s.autosave && s.volume, `autosave ${s.autosave}, volume ${s.volume}`);
  add('browser: the status line reads "Core ready. Pick a game and press Start."', /^Core ready\. Pick a game and press Start\.$/.test(s.status || ''), s.status);
  add('browser: a Copy debug button sits in the toolbar', s.debugBtns[0].present && /Copy debug/.test(s.debugBtns[0].text || ''), JSON.stringify(s.debugBtns[0]));
  add('browser: the page background is rgb(17, 17, 17)', s.bodyBg === 'rgb(17, 17, 17)', s.bodyBg);
  return r;
}

async function desktopSession(std) {
  section('browser A: desktop 1280x800 - computed styles against the five references, lifecycle, then mutants');
  const { withBrowser } = await loadHarness();
  await withBrowser({ port: 9251 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => {
    // ---- the references, measured: the same computed-style questions asked of every page
    const maps = [];
    for (const p of REFS) {
      try { await gotoReady(page, `http://localhost:${PORT}/${p}`); maps.push(await ev(page, COMPUTED, DESKTOP_SPEC)); await shot(page, 'ref_' + path.basename(p, '.html').replace('index', 'n64') + '_1280.png'); }
      catch (e) { maps.push(null); info(`reference ${p} could not be measured: ${e.message}`); }
    }
    info(`measured ${maps.filter(Boolean).length} of ${REFS.length} reference pages`);
    ok('at least four reference pages were measured', maps.filter(Boolean).length >= 4);
    // ---- gba
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    await sleep(600);
    const mine = await ev(page, COMPUTED, DESKTOP_SPEC);
    const allBad = [];
    let nProps = 0;
    for (const [label] of DESKTOP_SPEC) { const sm = computedMajority(maps, label); nProps += Object.keys(sm).length; diffComputed(mine[label], sm).forEach((d) => allBad.push(label + ' ' + d)); }
    ok('computed styles: every property >= 4 of the references agree on (body, desktop, title, toolbar, button, select, stage, status bar, key help, toast) is the same on gba.html', allBad.length === 0 && nProps >= 40, allBad.length ? allBad.slice(0, 6).join(' | ') : `${nProps} computed properties match`);
    // the control: the same comparison fed a page whose button is blue and background white must fail
    const mutMine = JSON.parse(JSON.stringify(mine)); mutMine.button.backgroundColor = 'rgb(0, 123, 255)'; mutMine.body.backgroundColor = 'rgb(255, 255, 255)';
    control('computed-style comparison: a blue button on a white page is caught', (() => { let n = 0; for (const [label] of DESKTOP_SPEC) n += diffComputed(mutMine[label], computedMajority(maps, label)).length; return n >= 2; })());
    await shot(page, 'gba_pre_1280.png');

    const domOrder = await ev(page, () => [...document.getElementById('controlBar').children].filter((e) => !e.hidden && getComputedStyle(e).display !== 'none').map((e) => e.id || e.className));
    await page.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 30000 });   // the room module (an ES module import) has loaded
    const snap0 = await ev(page, SNAPSHOT);
    judgeDesktopPre(snap0, std, domOrder).forEach((x) => ok(x.name, x.ok, x.detail));
    ok('the title is "GBA Wasm" and the document title says so', (await ev(page, () => document.getElementById('title').textContent + '|' + document.title)) === 'GBA Wasm|GBA Wasm');

    // ---- mutants of the LIVE page, judged by the same function
    const mutants = [
      ['Party hidden again', () => { const b = document.getElementById('btnNet'); b.hidden = true; b.style.display = 'none'; }, 'browser: Party (#btnNet) is visible and reads "Party" once the room module has loaded; the splash Party exists but only the phone shell shows it'],
      ['a Bootstrap stylesheet linked in', () => new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/gba/vendor/bootstrap.min.css'; l.onload = l.onerror = () => res(true); document.head.appendChild(l); }), 'browser: no stylesheet <link> (only inline <style>)'],
      ['a Bootstrap button on the page', () => { const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = 'x'; document.body.appendChild(b); }, 'browser: jQuery / rivets / toastr / bootstrap are not loaded and no Bootstrap element is on the page'],
      ['Save State moved to the end of the toolbar', () => { const bar = document.getElementById('controlBar'); bar.appendChild(document.getElementById('btnSave')); }, 'browser: the rendered toolbar reads left-to-right, top-to-bottom in DOM order'],
      ['Save State enabled before any game runs', () => { document.getElementById('btnSave').disabled = false; }, 'browser: Save/Load/Export/Import/.sav/Reset/Mute/Fullscreen are all disabled before a game runs; Start and Browse are enabled'],
      ['the page painted white', () => { document.body.style.background = '#fff'; }, 'browser: the page background is rgb(17, 17, 17)'],
      ['the Auto-save checkbox removed', () => { document.querySelector('#controlBar .autosaveToggle').remove(); }, 'browser: the Auto-save checkbox follows Save State and the volume slider follows Mute (lib/autosave.js, lib/volume.js)'],
    ];
    for (const [name, fn, expect] of mutants) {
      await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
      await ev(page, fn);
      const s = await ev(page, SNAPSHOT);
      // the judge is always given the ORIGINAL order (what a correct page renders); the reorder mutant's page now differs from it
      const bad = failing(judgeDesktopPre(s, std, domOrder));
      control(`mutant "${name}" trips "${expect}"`, bad.includes(expect), 'failed: ' + (bad.join(' / ') || 'nothing'));
    }

    // ---- the real lifecycle: Start -> every control that needed a game lights up
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    await ev(page, () => { const s = document.getElementById('romSelect'); const o = [...s.options].find((x) => /SoulGold/.test(x.textContent)); s.value = o.value; s.dispatchEvent(new Event('change')); });
    await clickCentre(page, '#btnStart');
    await page.waitFor('myApp.isRunning === true && myApp.frameCnt > 90', { timeoutMs: 60000 });
    await ev(page, () => { myApp.setGameSpeed(5); });                       // a measurement arm only, to reach the title screen quickly
    await page.waitFor('myApp.frameCnt > 900', { timeoutMs: 60000 });
    await ev(page, () => { myApp.setGameSpeed(1); });
    await sleep(1500);
    const run = await ev(page, SNAPSHOT);
    const L = run.lifecycle;
    ok('after Start: Save State, Import State, Export/Import .sav, Reset, Mute and Fullscreen are enabled; Load State and Export State stay disabled until a state exists',
      ['btnSave', 'btnImport', 'btnExportSav', 'btnImportSav', 'btnReset', 'btnMute', 'btnFull'].every((id) => L[id] === false) && L.btnLoad === true && L.btnExport === true, JSON.stringify(L));
    ok('after Start: the status line reads "Running — <rom>" and #fps carries the standard "guest N/s (Nx hardware) · presented N/s" text',
      /^Running — Pokemon SoulGold/.test(run.status) && /^guest [\d.]+\/s \([\d.]+x hardware\) · presented [\d.]+\/s$/.test(run.fps || ''), `${run.status} | ${run.fps}`);
    ok('after Start: #keyHelp lists the keyboard (D-pad arrows, A, B, L, R, Start, Select) in the family\'s words and ends with "A gamepad works too."', /^Keyboard — D-pad arrows · m A · n B · q L · e R · Enter Start · v Select\. A gamepad works too\./.test(run.keyHelp || ''), run.keyHelp);
    const box = await ev(page, () => { const c = document.getElementById('canvas').getBoundingClientRect(), w = document.getElementById('canvasWrap').getBoundingClientRect(); return { cw: c.width, ch: c.height, ratio: c.width / c.height, inside: c.left >= w.left - 1 && c.right <= w.right + 1 && c.top >= w.top - 1 && c.bottom <= w.bottom + 1, fillsH: Math.abs(c.height - w.height) <= 1, fillsW: Math.abs(c.width - w.width) <= 1 }; });
    ok('the canvas is a 3:2 picture fitted INSIDE #canvasWrap (container-query fit: touches the box on one axis)', Math.abs(box.ratio - 1.5) < 0.02 && box.inside && (box.fillsH || box.fillsW), JSON.stringify(box));
    await shot(page, 'gba_ingame_1280.png');
    // Save State -> Load/Export light up
    await clickCentre(page, '#btnSave');
    await page.waitFor('document.getElementById("btnLoad").disabled === false && document.getElementById("btnExport").disabled === false', { timeoutMs: 20000 });
    ok('pressing Save State enables Load State and Export State (a state now exists for this game)', true);
    // the toolbar buttons do not keep keyboard focus (Enter is Start in the game)
    const focus = await ev(page, () => document.activeElement && document.activeElement.tagName);
    ok('after clicking a toolbar button focus is NOT left on it (Enter would re-fire Save State from the game)', focus === 'BODY', String(focus));
    // Remap dialog, opened from the standard toolbar button
    await clickCentre(page, '#btnRemap');
    const rm = await ev(page, () => ({ open: document.getElementById('remapPanel').classList.contains('open'), rows: document.querySelectorAll('#remapRows .remapRow').length, bg: getComputedStyle(document.getElementById('remapBox')).backgroundColor }));
    ok('Remap opens the n64-style dark dialog (#remapPanel > #remapBox) with the ten GBA bindings', rm.open && rm.rows === 10 && rm.bg === 'rgb(29, 29, 29)', JSON.stringify(rm));
    await shot(page, 'gba_remap_1280.png');
    await ev(page, () => document.getElementById('remapClose').click());
    ok('the page raised no script error through the whole desktop session', page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  });
}

// ---- NOTHING MAY FLASH WHITE WHILE LOADING: what is <html>'s background at the moment the FIRST <script src> is parsed?
// A MutationObserver installed before any page script records it. The control is a REAL mutant: the same page served with its
// early guard <style> cut out (Fetch.fulfillRequest rewrites the document), which must read transparent (the browser's own white).
const EARLY_PROBE = `(function () { window.__early = null; var mo = new MutationObserver(function () { if (window.__early) return;
  var s = document.querySelector('script[src]'); if (!s) return;
  window.__early = { bg: getComputedStyle(document.documentElement).backgroundColor, scheme: (document.querySelector('meta[name=color-scheme]') || {}).content || null, firstSrc: s.getAttribute('src') }; mo.disconnect(); });
  mo.observe(document, { childList: true, subtree: true }); })();`;
async function earlyPaintSession() {
  section('browser F: nothing flashes white while the page loads (the first <script src> is parsed with the dark background already applied)');
  const { withBrowser } = await loadHarness();
  const run = async (page, mutate) => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY_PROBE });
    if (mutate) {
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/gba.html*', requestStage: 'Response' }] });
      page.handlers.push(async (m) => {
        if (m.method !== 'Fetch.requestPaused') return;
        try {
          const b = await page.send('Fetch.getResponseBody', { requestId: m.params.requestId });
          const text = (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body).replace('<style>html, body { background: #111; color: #ddd; }</style>', '').replace('<meta name="color-scheme" content="dark" />', '');
          await page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(text, 'utf8').toString('base64') });
        } catch (e) { try { await page.send('Fetch.continueRequest', { requestId: m.params.requestId }); } catch (_e) { /* gone */ } }
      });
    }
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    return ev(page, () => window.__early);
  };
  let real = null, mut = null;
  await withBrowser({ port: 9256 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => { real = await run(page, false); });
  await withBrowser({ port: 9257 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => { mut = await run(page, true); });
  ok('the page: <html> is already rgb(17, 17, 17) when the first library <script> is parsed', !!real && real.bg === 'rgb(17, 17, 17)', JSON.stringify(real));
  control('the SAME page served without its early guard style reads transparent at that moment (the browser would paint white): the probe can fail', !!mut && mut.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(mut));
}

// ---- the capability gate
const FORCE_BLOCKED = `(function () { var real; Object.defineProperty(window, 'Capability', { configurable: true, get: function () { return real; }, set: function (v) { real = v; try { if (v && v.SPECS) v.SPECS.gba = { wasm: 'required', sab: 'required' }; } catch (e) {} } }); })();`;
async function gateSession() {
  section('browser B: the capability gate holds the STANDARD Start ids (and the page never re-enables them)');
  const { withBrowser } = await loadHarness();
  const probe = (page) => ev(page, () => { const g = (id) => { const e = document.getElementById(id); return e ? { disabled: e.disabled, aria: e.getAttribute('aria-disabled'), blocked: e.getAttribute('data-cap-blocked'), text: e.textContent.trim().slice(0, 48), pe: e.style.pointerEvents } : null; };
    return { start: g('btnStart'), splash: g('mobileSplashStart'), browse: g('btnBrowse'), ready: !!(window.myApp && myApp.isWasmReady), running: !!(window.myApp && myApp.isRunning), gate: window.__cap && window.__cap.gate ? { blocked: window.__cap.gate.blocked, level: window.__cap.gate.level } : null, wasm: typeof WebAssembly }; });
  const judge = (p, expectBlocked) => { const r = []; const add = (n, c, d) => r.push({ name: n, ok: !!c, detail: d }); const heldStart = p.start && p.start.aria === 'true' && p.start.disabled === true && /wasm|sab|coi/.test(p.start.blocked || '') && /Cannot run here/.test(p.start.text);
    if (expectBlocked) { add('Start (#btnStart) is held down by the capability layer: disabled + aria-disabled="true" + data-cap-blocked + "Cannot run here"', heldStart, JSON.stringify(p.start)); add('the splash Start (#mobileSplashStart) is held down too', p.splash && p.splash.aria === 'true' && p.splash.disabled === true, JSON.stringify(p.splash)); add('Browse is held down with it (a ROM from disk must not start the page behind the gate)', p.browse && p.browse.disabled === true, JSON.stringify(p.browse)); }
    else { add('un-gated twin: Start is enabled and carries no aria-disabled', p.start && p.start.disabled === false && !p.start.aria && !p.start.blocked, JSON.stringify(p.start)); add('un-gated twin: the splash Start and Browse are enabled', p.splash && p.splash.disabled === false && p.browse && p.browse.disabled === false, JSON.stringify({ splash: p.splash, browse: p.browse })); }
    return r; };
  // ---- arm 1: forced unsupported (spec asks for SharedArrayBuffer + isolation, which this page deliberately does not have), core boots anyway
  let blocked = null, twin = null;
  await withBrowser({ port: 9252 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FORCE_BLOCKED });
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    await page.waitFor('window.__cap && window.__cap.gate', { timeoutMs: 15000 }).catch(() => {});
    await sleep(2500);                                        // long after the core is ready: a page that re-enables Start would have done it by now
    blocked = await probe(page);
    judge(blocked, true).forEach((x) => ok(x.name, x.ok, x.detail));
    ok('the core WAS ready while Start stayed held (this is the case the ownership protocol exists for)', blocked.ready === true, `ready=${blocked.ready} gate=${JSON.stringify(blocked.gate)}`);
    // a held Start cannot start the page by any road
    await page.click(Math.round(await ev(page, () => { const b = document.getElementById('btnStart').getBoundingClientRect(); return b.x + b.width / 2; })), Math.round(await ev(page, () => { const b = document.getElementById('btnStart').getBoundingClientRect(); return b.y + b.height / 2; })));
    await sleep(500);
    const via = await evAsync(page, async () => { const ab = new ArrayBuffer(0x400); new Uint8Array(ab)[0xB2] = 0x96; const r = await myApp._loadRomArrayBuffer(ab, 'x.gba'); const s = await myApp.startFromList(); return { loadRefused: r === false, running: myApp.isRunning, toast: (window.__gbaToasts || []).slice(-1)[0] }; });
    ok('clicking the held Start, calling startFromList() and dropping a ROM all leave the emulator NOT running', !via.running && via.loadRefused, JSON.stringify(via));
    // the mutant: a page that re-enables the held button (what the ownership protocol forbids) is caught by the same judge
    await ev(page, () => { const b = document.getElementById('btnStart'); b.disabled = false; b.removeAttribute('aria-disabled'); b.removeAttribute('data-cap-blocked'); b.textContent = 'Start'; });
    control('mutant: a Start button re-enabled behind the gate is caught', failing(judge(await probe(page), true)).length >= 1);
    await shot(page, 'gba_gate_blocked_1280.png');
  });
  // ---- arm 2: the twin, no override
  await withBrowser({ port: 9253 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => {
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    await sleep(1500);
    twin = await probe(page);
    judge(twin, false).forEach((x) => ok(x.name, x.ok, x.detail));
    ok('arm-difference proof: the forced arm and the twin DIFFER in the measured value (aria-disabled "true" vs absent), so the arm is not a placebo', blocked && twin && blocked.start.aria === 'true' && !twin.start.aria);
  });
  // ---- arm 3: WebAssembly ABSENT as the page sees it - the REAL "cannot run here".
  // Two ways, in order: V8's --noexpose_wasm (did NOT remove it in headless Chrome 156 here - the first version of this arm was VOID), then
  // `delete window.WebAssembly` injected before any page script runs (Page.addScriptToEvaluateOnNewDocument). Either way what is measured
  // is `typeof WebAssembly` IN THE PAGE: if it is still 'object' the arm is VOID and says so. The twin (arm 2) is the arm-difference proof:
  // there the same probe reads 'object' and Start is enabled.
  let noWasm = null;
  await withBrowser({ port: 9254 + CDP_OFFSET, width: 1280, height: 800, args: ['--js-flags=--noexpose_wasm'] }, async (page) => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { delete window.WebAssembly; } catch (e) {}' });
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`);
    await page.waitFor('window.__cap && window.__cap.gate', { timeoutMs: 15000 }).catch(() => {});
    await sleep(1500);
    noWasm = await probe(page);
    if (noWasm.wasm !== 'undefined') { info('neither --noexpose_wasm nor deleting window.WebAssembly removed it in this Chrome; this arm is VOID (reported, not passed)'); return; }
    ok('with WebAssembly truly absent the standard Start is held down by the capability layer (not by the page)', noWasm.start && noWasm.start.aria === 'true' && noWasm.start.disabled === true && /wasm/.test(noWasm.start.blocked || ''), JSON.stringify(noWasm.start));
    ok('and the page says why instead of sitting there (the core failure is shown in #banner)', await ev(page, () => /Could not start the emulator core/.test(document.getElementById('banner').textContent)), await ev(page, () => document.getElementById('banner').textContent.slice(0, 90)));
  });
  // ---- arm 4: phone splash gated
  await withBrowser({ port: 9255 + CDP_OFFSET, width: 390, height: 844, mobile: true }, async (page) => {
    await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FORCE_BLOCKED });
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    await page.waitFor('window.__cap && window.__cap.gate', { timeoutMs: 15000 }).catch(() => {});
    await sleep(2000);
    const p = await probe(page);
    ok('on a phone the splash Start (#mobileSplashStart) is held down: disabled, aria-disabled="true", pointer-events none, "Cannot run here"', p.splash && p.splash.aria === 'true' && p.splash.disabled === true && p.splash.pe === 'none' && /Cannot run here/.test(p.splash.text), JSON.stringify(p.splash));
    const r = await ev(page, () => { const b = document.getElementById('mobileSplashStart').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
    await page.tap(r.x, r.y); await sleep(600);
    ok('tapping the held splash Start starts nothing (the splash that carries the explanation is still there)', (await ev(page, () => ({ running: myApp.isRunning, splash: getComputedStyle(document.getElementById('mobileSplash')).display }))).running === false);
    await shot(page, 'gba_gate_blocked_390.png');
  });
}

// ---- the console arm (Xbox Edge): tools/device_matrix.mjs asserts these for gba.html through puppeteer; this is the same judge over bare CDP
// (tools/device_matrix.mjs launches puppeteer; it now carries --mute-audio on every launch (stage GP), and its gba console judge asserts
// the same facts - #desktop shown, #mobileShell hidden, canvas parent #canvasWrap, ratio 1.5, 3 / 2 rule, back-trap - so run it too:
//   MATRIX_BASE=http://localhost:8092 CHROME_PATH=<chrome.exe> node tools/device_matrix.mjs --page=gba   (server up; take the browser lock first)).
const XBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36 Edge/110.0.1587.57';
async function consoleSession() {
  section('browser G: the console arm (Xbox UA, 1920x1080): the desktop page, the 3:2 rule, the back-button trap');
  const { withBrowser } = await loadHarness();
  const probe = (page) => ev(page, () => { const c = document.getElementById('canvas'); const r = c.getBoundingClientRect(); const ok = window.dispatchEvent(new KeyboardEvent('keydown', { key: 'BrowserBack', cancelable: true, bubbles: true }));
    return { consoleClass: document.documentElement.classList.contains('console-ua'), mobile: myApp.mobileMode, desktop: getComputedStyle(document.getElementById('desktop')).display, shell: getComputedStyle(document.getElementById('mobileShell')).display,
      cssAspect: getComputedStyle(c).aspectRatio, ratio: +(r.width / r.height).toFixed(3), keySwallowed: ok === false, sentinel: !!(history.state && history.state.gba === 1), startOn: !document.getElementById('btnStart').disabled }; });
  let desk = null;
  await withBrowser({ port: 9251 + CDP_OFFSET, width: 1920, height: 1080 }, async (page) => {
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true'); desk = await probe(page);
  });
  await withBrowser({ port: 9252 + CDP_OFFSET, width: 1920, height: 1080 }, async (page) => {
    await page.send('Emulation.setUserAgentOverride', { userAgent: XBOX_UA });
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    const p = await probe(page);
    ok('Xbox UA: the page sets .console-ua, is NOT in touch-shell mode (a console is not a touch device) and shows the desktop page', p.consoleClass && p.mobile === false && p.desktop === 'flex' && p.shell === 'none', JSON.stringify(p));
    ok('Xbox UA: the canvas keeps the 3 / 2 rule (not the 4 / 3 the other five use) and renders 3:2', p.cssAspect === '3 / 2' && Math.abs(p.ratio - 1.5) < 0.02, `cssAspect=${p.cssAspect} ratio=${p.ratio}`);
    ok('Xbox UA: the back-button trap holds (a BrowserBack keydown is swallowed; the history sentinel is in place)', p.keySwallowed && p.sentinel, `swallowed=${p.keySwallowed} sentinel=${p.sentinel}`);
    ok('Xbox UA: Start is usable (the gate did not hold it)', p.startOn);
    control('arm-difference proof: the same page on a desktop UA has no .console-ua class, so the arm changed something', desk && desk.consoleClass === false && p.consoleClass === true, JSON.stringify({ desktopUA: desk && desk.consoleClass }));
  });
}

// ---- the lib's own suite on this page
async function captestSession() {
  section('browser C: ?captest=1 (lib/capability.test.js, run ON gba.html)');
  const { withBrowser } = await loadHarness();
  await withBrowser({ port: 9256 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => {
    await gotoReady(page, `http://localhost:${PORT}/${GBA}?captest=1`);
    await page.waitFor('window.__capTest && window.__capTest.done === true', { timeoutMs: 90000 });
    const t = JSON.parse(await page.eval('JSON.stringify({ pass: __capTest.pass, fail: __capTest.fail, expect: __capTest.expect, mutants: __capTest.mutants && (__capTest.mutants.length || Object.keys(__capTest.mutants).length), bad: (__capTest.lines || []).filter((l) => /FAIL/.test(String(l))).slice(0, 3) })'));
    ok('lib/capability.test.js on gba.html: 0 failures and at least the expected number of passing assertions', t.fail === 0 && t.pass >= t.expect, JSON.stringify(t));
  });
}

// ---- the phone
const MOBILE_SNAP = () => {
  const $ = (id) => document.getElementById(id);
  const vw = innerWidth, vh = innerHeight;
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  // EFFECTIVE hit area: the centre and the corners of a 44x44 box around the centre must all land on the control (or its pseudo-element)
  const eff = (id) => { const e = $(id); if (!e) return { id, present: false }; const r = e.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const self = (p) => !!p && (p === e || e.contains(p));
    // how far from the centre, in each direction, does a tap still land on this control (its invisible ::after included)? 1 px steps, up to 80.
    const ext = (dx, dy) => { let n = 0; for (let k = 1; k <= 80; k++) { if (self(document.elementFromPoint(Math.round(cx + dx * k), Math.round(cy + dy * k)))) n = k; else break; } return n; };
    // +1: the pixel at the centre itself (a 44 px box measures 22 up + 21 down + 1)
    const effW = ext(-1, 0) + ext(1, 0) + 1, effH = ext(0, -1) + ext(0, 1) + 1;
    return { id, present: true, w: Math.round(r.width), h: Math.round(r.height), effW, effH, inView: r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5, centreIsSelf: self(document.elementFromPoint(Math.round(cx), Math.round(cy))), hit44: effW >= 44 && effH >= 44 }; };
  return {
    vw, vh, hscroll: document.documentElement.scrollWidth - vw, bodyScroll: document.body.scrollWidth - vw,
    splash: getComputedStyle($('mobileSplash')).display, desktop: getComputedStyle($('desktop')).display, shell: getComputedStyle($('mobileShell')).display,
    ids: ['mobileSplash', 'mobileSplashStart', 'mobileSplashNet', 'mobileRomSelect', 'mobileStatus', 'rotateHint', 'mobileMenuBtn', 'mobileMenu', 'mobileMenuBox', 'mClose', 'mobileA', 'mobileB', 'mobileStart', 'mobileDpadDisc', 'mobileScreen'].filter((id) => !$(id)),
    partyShown: $('mobileSplashNet') ? !$('mobileSplashNet').hidden && vis($('mobileSplashNet')) : null,
    splashTexts: { h3: ($('mobileSplash').querySelector('h3') || {}).textContent, label: ($('mobileSplash').querySelector('label') || {}).textContent, tip: ($('mobileSplash').querySelector('.rotateTip') || {}).textContent, start: $('mobileSplashStart').textContent.trim() },
    debugInSplash: !!$('mobileSplash').querySelector('[data-debugreport="splash"]'), debugBtn: (() => { const e = $('mobileSplash').querySelector('[data-debugreport="splash"]'); const r = e && e.getBoundingClientRect(); return r ? { w: Math.round(r.width), h: Math.round(r.height), text: e.textContent.trim() } : null; })(),
    splashTargets: ['mobileSplashStart', 'mobileRomSelect', 'mobileSplashNet'].map(eff).concat([(() => { const e = $('mobileSplash').querySelector('[data-debugreport="splash"]'); if (!e) return { id: 'debug', present: false }; e.id = e.id || '__dbg'; return eff(e.id); })()]),
    gameTargets: ['mobileA', 'mobileB', 'mobileL', 'mobileR', 'mobileStart', 'mobileSelect', 'mobileMenuBtn', 'mobileDpadDisc'].map(eff),
    canvasParent: $('canvas').parentElement && $('canvas').parentElement.id, canvasRect: (() => { const r = $('canvas').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    bg: getComputedStyle($('mobileShell')).backgroundImage.slice(0, 60),
  };
};
function judgeMobileSplash(s, std, tag) {
  const r = []; const add = (n, c, d = '') => r.push({ name: `${tag}: ${n}`, ok: !!c, detail: d });
  add('the standard splash ids exist (mobileSplash, Start, Party, RomSelect, status, hint, menu, controls, screen)', s.ids.length === 0, 'missing: ' + s.ids.join(' '));
  add('the dark splash is shown, the desktop page is hidden, the SP shell is behind it', s.splash === 'flex' && s.desktop === 'none' && s.shell === 'flex', JSON.stringify({ splash: s.splash, desktop: s.desktop, shell: s.shell }));
  add('the splash words are the family\'s: title "GBA Wasm", "Choose a game", Start, "Rotate to landscape for the best view."', s.splashTexts.h3 === 'GBA Wasm' && s.splashTexts.label === std.splash.label && s.splashTexts.start === std.splash.start && s.splashTexts.tip === std.splash.tip, JSON.stringify(s.splashTexts));
  add('the splash Party button is visible (the room is wired, so it is not a dead control)', s.partyShown === true);
  add('a Copy debug button is on the splash', s.debugInSplash && /Copy debug/.test((s.debugBtn || {}).text || ''), JSON.stringify(s.debugBtn));
  add('no horizontal scroll', s.hscroll <= 0 && s.bodyScroll <= 0, `document ${s.hscroll}, body ${s.bodyScroll}`);
  add('every splash control has a >= 44 px effective touch target', s.splashTargets.every((t) => t.present && t.hit44), JSON.stringify(s.splashTargets.filter((t) => !(t.present && t.hit44)).map((t) => `${t.id} box ${t.w}x${t.h} effective ${t.effW}x${t.effH}`)));
  return r;
}
function judgeMobileGame(s, tag) {
  const r = []; const add = (n, c, d = '') => r.push({ name: `${tag}: ${n}`, ok: !!c, detail: d });
  add('after Start the splash is gone, the SP shell is shown and the canvas lives in #mobileScreen', s.splash === 'none' && s.shell === 'flex' && s.canvasParent === 'mobileScreen', JSON.stringify({ splash: s.splash, shell: s.shell, parent: s.canvasParent }));
  add('every touch control is inside the viewport and is what a tap at its centre hits', s.gameTargets.every((t) => t.present && t.inView && t.centreIsSelf), JSON.stringify(s.gameTargets.filter((t) => !(t.present && t.inView && t.centreIsSelf))));
  add('every touch control has a >= 44 px effective target (width and height, measured by hit-testing outward from its centre)', s.gameTargets.every((t) => t.present && t.hit44), JSON.stringify(s.gameTargets.filter((t) => !(t.present && t.hit44)).map((t) => `${t.id} box ${t.w}x${t.h} effective ${t.effW}x${t.effH}`)));
  add('no horizontal scroll while playing', s.hscroll <= 0 && s.bodyScroll <= 0, `document ${s.hscroll}, body ${s.bodyScroll}`);
  return r;
}

async function mobileSession(std) {
  const { withBrowser } = await loadHarness();
  for (const [w, h, tag] of [[390, 844, 'phone 390x844'], [844, 390, 'phone landscape 844x390']]) {
    section(`browser D: ${tag} - the standard splash, then the SP touch shell`);
    await withBrowser({ port: tag.includes('landscape') ? 9258 : 9257, width: w, height: h, mobile: true }, async (page) => {
      await page.send('Emulation.setUserAgentOverride', { userAgent: IPHONE });
      await page.setViewport(w, h, { mobile: true, dpr: 2 });
      // the references' splash, measured
      const maps = [];
      for (const p of REFS) {
        try { await gotoReady(page, `http://localhost:${PORT}/${p}`); await page.waitFor('document.getElementById("mobileSplash") && getComputedStyle(document.getElementById("mobileSplash")).display !== "none"', { timeoutMs: 20000 }); maps.push(await ev(page, COMPUTED, SPLASH_SPEC)); await shot(page, `ref_${path.basename(p, '.html').replace('index', 'n64')}_splash_${w}x${h}.png`); }
        catch (e) { maps.push(null); info(`reference ${p} splash could not be measured: ${e.message}`); }
      }
      ok('at least four reference splashes were measured', maps.filter(Boolean).length >= 4, `${maps.filter(Boolean).length}`);
      await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
      await sleep(600);
      const mine = await ev(page, COMPUTED, SPLASH_SPEC);
      let nProps = 0; const bad = [];
      for (const [label] of SPLASH_SPEC) { const sm = computedMajority(maps, label); nProps += Object.keys(sm).length; diffComputed(mine[label], sm).forEach((d) => bad.push(label + ' ' + d)); }
      ok(`${tag}: the splash's computed styles match the references' (${nProps} properties)`, bad.length === 0 && nProps >= 15, bad.slice(0, 6).join(' | '));
      await shot(page, `gba_splash_${w}x${h}.png`);
      const s0 = await ev(page, MOBILE_SNAP);
      judgeMobileSplash(s0, std, tag).forEach((x) => ok(x.name, x.ok, x.detail));
      // mutants of the live splash
      const mutants = [
        ['the splash Start shrunk to 30 px', () => { const b = document.getElementById('mobileSplashStart'); b.style.cssText += ';min-height:0;height:30px;padding:0 20px;min-width:0;width:90px'; }, 'every splash control has a >= 44 px effective touch target'],
        ['the Party button hidden', () => { document.getElementById('mobileSplashNet').hidden = true; }, 'the splash Party button is visible (the room is wired, so it is not a dead control)'],
        ['a 200 px overflow to the right', () => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:0;top:0;width:' + (innerWidth + 200) + 'px;height:2px'; document.body.appendChild(d); document.documentElement.style.overflowX = 'visible'; document.body.style.overflow = 'visible'; }, 'no horizontal scroll'],
        ['the splash hidden', () => { document.getElementById('mobileSplash').style.display = 'none'; }, 'the dark splash is shown, the desktop page is hidden, the SP shell is behind it'],
      ];
      for (const [name, fn, expect] of mutants) {
        await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
        await ev(page, fn);
        const bad2 = failing(judgeMobileSplash(await ev(page, MOBILE_SNAP), std, tag).map((x) => ({ ...x, name: x.name.replace(tag + ': ', '') })));
        control(`${tag}: mutant "${name}" trips "${expect}"`, bad2.includes(expect), 'failed: ' + (bad2.join(' / ') || 'nothing'));
      }
      // Start for real, by touch
      await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
      await ev(page, () => { const s = document.getElementById('mobileRomSelect'); const o = [...s.options].find((x) => /SoulGold/.test(x.textContent)); s.value = o.value; });
      const c = await ev(page, () => { const b = document.getElementById('mobileSplashStart').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; });
      await page.tap(c.x, c.y);
      await page.waitFor('myApp.isRunning === true && myApp.frameCnt > 90', { timeoutMs: 60000 });
      await ev(page, () => { myApp.setGameSpeed(5); });
      await page.waitFor('myApp.frameCnt > 900', { timeoutMs: 60000 });
      await ev(page, () => { myApp.setGameSpeed(1); });
      await sleep(1500);
      const s1 = await ev(page, MOBILE_SNAP);
      judgeMobileGame(s1, tag).forEach((x) => ok(x.name, x.ok, x.detail));
      await shot(page, `gba_ingame_${w}x${h}.png`);
      const mut = await (async () => { await ev(page, () => { const d = document.getElementById('mobileA'); d.style.cssText += ';position:fixed;left:' + (innerWidth - 10) + 'px;'; }); return failing(judgeMobileGame(await ev(page, MOBILE_SNAP), '').map((x) => ({ ...x, name: x.name.replace(': ', '') }))); })();
      control(`${tag}: mutant "the A button pushed off the right edge" trips the in-viewport check`, mut.some((n) => /inside the viewport/.test(n)), mut.join(' / '));
      ok(`${tag}: no script error through the phone session`, page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ---- behaviour parity: everything the old Bootstrap page did, through the new standard controls
async function behaviourSession() {
  section('browser E: behaviour parity - Browse, drag and drop, Reset, Mute, Export/Import State, Fullscreen, keyboard, gamepad, Remap');
  const { withBrowser } = await loadHarness();
  const dl = path.join(os.tmpdir(), 'gba-standard-dl'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
  const ROMDIR = path.join(ROOT, 'gba/gbaWasm/roms');
  await withBrowser({ port: 9259 + CDP_OFFSET, width: 1280, height: 800 }, async (page) => {
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true }).catch(() => page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }));
    await gotoReady(page, `http://localhost:${PORT}/${GBA}`, 'window.myApp && myApp.isWasmReady === true');
    const toasts = () => ev(page, () => (window.__gbaToasts || []).slice());
    // ---- Browse: the real file chooser, a real .gba from disk
    await page.send('DOM.enable'); await page.send('Page.setInterceptFileChooserDialog', { enabled: true });
    const chooser = new Promise((resolve) => { const h = (m) => { if (m.method === 'Page.fileChooserOpened') { page.handlers = page.handlers.filter((x) => x !== h); resolve(m.params); } }; page.handlers.push(h); });
    await clickCentre(page, '#btnBrowse');
    const fc = await Promise.race([chooser, sleep(8000).then(() => null)]);
    ok('Browse… opens the file chooser, which accepts only .gba', !!fc && fc.backendNodeId > 0 && (await ev(page, () => document.getElementById('fileInput').accept)) === '.gba', fc ? 'mode ' + fc.mode : 'no chooser');
    if (fc) await page.send('DOM.setFileInputFiles', { files: [path.join(ROMDIR, 'Sim City 2000 (U).gba')], backendNodeId: fc.backendNodeId });
    await page.waitFor("myApp.isRunning === true && myApp.frameCnt > 30 && /Sim City/.test(myApp.rom_name)", { timeoutMs: 30000 }).catch(() => {});
    ok('the .gba chosen from disk is running under its own file name', (await ev(page, () => myApp.isRunning && myApp.rom_name)) === 'Sim City 2000 (U).gba', await ev(page, () => myApp.rom_name));
    // ---- drag and drop onto the stage
    const dropped = await evAsync(page, async () => {
      const ab = await (await fetch(ROMLIST.find((r) => /Bust-A-Move/.test(r.title)).url)).arrayBuffer();
      const dt = new DataTransfer(); dt.items.add(new File([ab], 'Dropped Game.gba'));
      const fire = (t) => window.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      fire('dragenter'); fire('dragover');
      const marked = document.getElementById('canvasWrap').classList.contains('dropping');
      fire('drop');
      return { marked, unmarked: !document.getElementById('canvasWrap').classList.contains('dropping') };
    });
    await page.waitFor("myApp.isRunning === true && myApp.rom_name === 'Dropped Game.gba' && myApp.frameCnt > 20", { timeoutMs: 30000 }).catch(() => {});
    ok('dragging a .gba over the page marks the stage (.dropping) and dropping it starts the game under the dropped name', dropped.marked && dropped.unmarked && (await ev(page, () => myApp.rom_name)) === 'Dropped Game.gba', JSON.stringify(dropped));
    const notRom = await evAsync(page, async () => {
      const name0 = myApp.rom_name; const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(0x400)], 'notes.txt'));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 600));
      return { same: myApp.rom_name === name0, running: myApp.isRunning, toast: (window.__gbaToasts || []).slice(-1)[0] };
    });
    ok('a dropped file that is not a GBA ROM is refused with a message and the running game is left alone', notRom.same && notRom.running && /^error: Not a valid GBA ROM/.test(notRom.toast || ''), JSON.stringify(notRom));
    const textDrop = await evAsync(page, async () => { const dt = new DataTransfer(); dt.setData('text/plain', 'hello'); const before = (window.__gbaToasts || []).length; window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return (window.__gbaToasts || []).length === before; });
    ok('control: dragging plain text over the page is ignored (only files are taken)', textDrop);
    // back to a title with an animated picture for the rest
    await ev(page, () => { const s = document.getElementById('romSelect'); s.value = ROMLIST.find((r) => /SoulGold/.test(r.title)).url; });
    await clickCentre(page, '#btnStart');
    await page.waitFor("myApp.isRunning && /SoulGold/.test(myApp.rom_name) && myApp.frameCnt > 90", { timeoutMs: 60000 });
    // ---- Reset
    await ev(page, () => { myApp.setGameSpeed(5); }); await page.waitFor('myApp.core.frames(0) > 400', { timeoutMs: 60000 }); await ev(page, () => { myApp.setGameSpeed(1); });
    await clickCentre(page, '#btnReset');
    const rs = await ev(page, () => ({ frames: myApp.core.frames(0), toast: (window.__gbaToasts || []).slice(-1)[0], running: myApp.isRunning }));
    ok('Reset power-cycles the game (the core\'s own frame counter restarts) and the game keeps running', rs.frames < 30 && rs.running && /Reset/.test(rs.toast), JSON.stringify(rs));
    // ---- Mute (the button; the volume slider is lib/volume.js and is measured above)
    await clickCentre(page, '#btnMute');
    await sleep(300);
    const m1 = await ev(page, () => ({ label: document.getElementById('btnMute').textContent, muted: myApp.muted, ctx: myApp.audioContext && myApp.audioContext.state, menu: document.getElementById('mMute').textContent }));
    await clickCentre(page, '#btnMute'); await sleep(400);
    const m2 = await ev(page, () => ({ label: document.getElementById('btnMute').textContent, muted: myApp.muted, ctx: myApp.audioContext && myApp.audioContext.state }));
    ok('Mute suspends the AudioContext and says Unmute; pressing it again resumes (both labels follow)', m1.muted && m1.ctx === 'suspended' && /Unmute/.test(m1.label) && m1.menu === 'Unmute' && !m2.muted && m2.ctx === 'running' && /Mute/.test(m2.label) && !/Unmute/.test(m2.label), JSON.stringify({ m1, m2 }));
    // ---- Fullscreen: the STAGE goes fullscreen (the canvas alone would be fine on desktop, but the stage is the standard)
    const fsT = await ev(page, () => { let t = null; const w = document.getElementById('canvasWrap'), c = document.getElementById('canvas'); w.requestFullscreen = () => { t = 'canvasWrap'; return Promise.resolve(); }; c.requestFullscreen = () => { t = 'canvas'; return Promise.resolve(); }; document.getElementById('btnFull').click(); return t; });
    ok('Fullscreen asks #canvasWrap (the stage) to go fullscreen, not the bare canvas', fsT === 'canvasWrap', String(fsT));
    // ---- Save State -> Export State downloads exactly what is stored -> Import State through the real chooser
    await clickCentre(page, '#btnSave');
    await page.waitFor('document.getElementById("btnExport").disabled === false', { timeoutMs: 20000 });
    await clickCentre(page, '#btnExport');
    let got = null; for (let i = 0; i < 60 && !got; i++) { const f = fs.readdirSync(dl).filter((x) => /mgba\.state\.gz$/.test(x) && !x.endsWith('.crdownload')); if (f.length) got = path.join(dl, f[0]); else await sleep(150); }
    const stored = got ? fs.readFileSync(got) : null;
    const inDb = await evAsync(page, async () => { const key = myApp._key('state'); const v = await myApp._dbGet(key); return v ? Array.from(new Uint8Array(v.buffer ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v)).length : 0; });
    ok('Export State downloaded "<rom>.mgba.state.gz": a gzip, the same size as the stored state', !!stored && stored[0] === 0x1f && stored[1] === 0x8b && stored.length === inDb, got ? `${path.basename(got)} ${stored.length} B vs stored ${inDb} B` : 'no file');
    const chooser2 = new Promise((resolve) => { const h = (m) => { if (m.method === 'Page.fileChooserOpened') { page.handlers = page.handlers.filter((x) => x !== h); resolve(m.params); } }; page.handlers.push(h); });
    await clickCentre(page, '#btnImport');
    const fc2 = await Promise.race([chooser2, sleep(8000).then(() => null)]);
    ok('Import State opens a file chooser', !!fc2 && fc2.backendNodeId > 0);
    if (fc2 && got) { await page.send('DOM.setFileInputFiles', { files: [got], backendNodeId: fc2.backendNodeId }); await sleep(800); }
    ok('and importing the exported file says so (a refusal would say why)', /^info: Imported \d+ KB/.test((await toasts()).slice(-1)[0] || ''), (await toasts()).slice(-1)[0]);
    // ---- keyboard: a key typed into the ROM picker is not a game key
    const kb = async (key, code, vk) => { await page.key('keyDown', key, code, { windowsVirtualKeyCode: vk }); await sleep(60); const v = await ev(page, () => myApp.rivetsData.inputController.Key_Down); await page.key('keyUp', key, code, { windowsVirtualKeyCode: vk }); return v; };
    await ev(page, () => document.getElementById('romSelect').focus());
    const typedInSelect = await kb('ArrowDown', 'ArrowDown', 40);
    await ev(page, () => document.getElementById('romSelect').blur());
    const typedInBody = await kb('ArrowDown', 'ArrowDown', 40);
    ok('an arrow key pressed while the ROM picker has focus does NOT press the game\'s D-pad (it moves the picker)', typedInSelect === false, `picker focused: Key_Down=${typedInSelect}`);
    control('...and the same key with focus on the page DOES press it (so the check above can fail)', typedInBody === true, `body focused: Key_Down=${typedInBody}`);
    const shifted = await ev(page, () => { const ic = myApp.rivetsData.inputController; ic.keyDown({ key: 'M', target: document.body }); const a = ic.Key_Action_A; ic.keyUp({ key: 'M', target: document.body }); return a && !ic.Key_Action_A; });
    ok('a game key still answers with Shift / Caps Lock down (M presses A)', shifted === true);
    // ---- gamepad (a stubbed Gamepad API: the pad the page would see)
    const padRead = await evAsync(page, async () => {
      const pad = (btn, ax) => ({ index: 0, id: 'stub pad', connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === btn, value: i === btn ? 1 : 0 })), axes: ax || [0, 0, 0, 0] });
      const ic = myApp.rivetsData.inputController; const out = {};
      navigator.getGamepads = () => [pad(-1)]; await new Promise((r) => setTimeout(r, 120)); out.idle = ic.Key_Action_A;
      // an idle pad that is merely plugged in must NOT cancel a key held on the keyboard (the old controller released it every frame)
      ic.keyDown({ key: 'm', target: document.body }); await new Promise((r) => setTimeout(r, 150)); out.kbSurvives = ic.Key_Action_A; ic.keyUp({ key: 'm', target: document.body });
      navigator.getGamepads = () => [pad(0)]; await new Promise((r) => setTimeout(r, 120)); out.a = ic.Key_Action_A;
      navigator.getGamepads = () => [pad(9)]; await new Promise((r) => setTimeout(r, 120)); out.start = ic.Key_Action_Start; out.aReleased = !ic.Key_Action_A;
      navigator.getGamepads = () => [pad(-1, [-1, 0, 0, 0])]; await new Promise((r) => setTimeout(r, 120)); out.left = ic.Key_Left;
      navigator.getGamepads = () => [pad(-1)]; await new Promise((r) => setTimeout(r, 120)); out.leftReleased = !ic.Key_Left;
      return out;
    });
    ok('a gamepad drives the same flags the keyboard does: button 0 = A, button 9 = Start, stick left = D-pad Left, all released again', padRead.a === true && padRead.start === true && padRead.aReleased && padRead.left === true && padRead.leftReleased, JSON.stringify(padRead));
    ok('an idle gamepad that is merely connected does not cancel a key held on the keyboard (the pad releases only what the pad pressed)', padRead.kbSurvives === true, JSON.stringify({ kbSurvives: padRead.kbSurvives }));
    control('control: an idle pad presses nothing', padRead.idle === false);
    // ---- Remap: the n64-style dialog, end to end
    await clickCentre(page, '#btnRemap');
    await clickCentre(page, '[data-remap="Mapping_Action_A"]');
    const capturing = await ev(page, () => document.querySelector('[data-remap="Mapping_Action_A"]').classList.contains('capturing') && /Press a key/.test(document.getElementById('remapHint').textContent));
    await page.press('k', 'KeyK', 75);
    const afterKey = await ev(page, () => ({ text: document.querySelector('[data-remap="Mapping_Action_A"]').textContent, liveStillM: myApp.rivetsData.inputController.KeyMappings.Mapping_Action_A }));
    ok('Remap: clicking a binding arms capture, the next key becomes the binding (shown on the button) and is not yet live until Save', capturing && afterKey.text === 'k' && afterKey.liveStillM === 'm', JSON.stringify({ capturing, afterKey }));
    await clickCentre(page, '#remapSave');
    const saved = await ev(page, () => ({ km: myApp.rivetsData.inputController.KeyMappings.Mapping_Action_A, ls: JSON.parse(localStorage.getItem('gbawasm_mappings_v1') || '{}').Mapping_Action_A, help: document.getElementById('keyHelp').innerHTML.includes('<b>k</b> A'), closed: !document.getElementById('remapPanel').classList.contains('open') }));
    ok('Save applies it live, stores it under the SAME key the old page used (gbawasm_mappings_v1), updates the keyboard line and closes the dialog', saved.km === 'k' && saved.ls === 'k' && saved.help && saved.closed, JSON.stringify(saved));
    const flag = async (key, code, vk) => { await page.key('keyDown', key, code, { windowsVirtualKeyCode: vk }); await sleep(60); const v = await ev(page, () => myApp.rivetsData.inputController.Key_Action_A); await page.key('keyUp', key, code, { windowsVirtualKeyCode: vk }); return v; };
    const kA = await flag('k', 'KeyK', 75), mA = await flag('m', 'KeyM', 77);
    ok('after the remap K presses A and M no longer does', kA === true && mA === false, `k=${kA} m=${mA}`);
    // Escape cancels a capture; Defaults restores
    await clickCentre(page, '#btnRemap');
    await clickCentre(page, '[data-remap="Mapping_Action_B"]');
    await page.press('Escape', 'Escape', 27);
    const esc = await ev(page, () => ({ text: document.querySelector('[data-remap="Mapping_Action_B"]').textContent, still: myApp.rivetsData.inputController.KeyMappings.Mapping_Action_B }));
    ok('Escape cancels a capture and leaves the binding as it was', esc.text === 'n' && esc.still === 'n', JSON.stringify(esc));
    // joystick capture through the stubbed pad
    await evAsync(page, async () => { window.__pressed = -1; navigator.getGamepads = () => [{ index: 0, id: 'stub', connected: true, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === window.__pressed })), axes: [0, 0, 0, 0] }]; return true; });
    await clickCentre(page, '[data-remap="Joy_Mapping_Action_B"]');
    await sleep(150); await ev(page, () => { window.__pressed = 3; });
    await sleep(300);
    const joy = await ev(page, () => ({ text: document.querySelector('[data-remap="Joy_Mapping_Action_B"]').textContent }));
    ok('a controller button pressed while a joystick binding is armed becomes the binding ("Btn 3")', joy.text === 'Btn 3', JSON.stringify(joy));
    await ev(page, () => { window.__pressed = -1; });
    await clickCentre(page, '#remapDefaults');
    await clickCentre(page, '#remapSave');
    const def = await ev(page, () => ({ a: myApp.rivetsData.inputController.KeyMappings.Mapping_Action_A, jb: myApp.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_B }));
    ok('Defaults then Save restores the shipped bindings (A = m, B button = 1)', def.a === 'm' && def.jb === 1, JSON.stringify(def));
    ok('the page raised no script error through the behaviour session', page.errors.length === 0, JSON.stringify(page.errors.slice(0, 3)));
  });
}

async function main() {
  console.log(`gba_page_standard_test: ${os.platform()} node ${process.version}`);
  staticLeg();
  if (flag('--browser')) {
    spawnSync(process.execPath, [path.join(ROOT, 'tools/browser_leak_guard.js'), 'reap'], { stdio: 'inherit' });
    const load0 = cpuLoad(); info(`machine: Windows CPU busy ${load0 === null ? 'n/a' : load0 + '%'} at start (Windows has no load average; nothing here is a timing result)`);
    const srv = await ensureServer();
    const std = computeStandard();
    try {
      if (want('desktop')) await desktopSession(std);
      if (want('behaviour')) await behaviourSession();
      if (want('early')) await earlyPaintSession();
      if (want('gate')) await gateSession();
      if (want('console')) await consoleSession();
      if (want('mobile')) await mobileSession(std);
      if (want('captest')) await captestSession();
    } finally { srv.stop(); }
    info(`machine: Windows CPU busy ${cpuLoad()}% at the end`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
