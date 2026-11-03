#!/usr/bin/env node
// tools/pokemonarena_coherence_test.mjs -- is Pokemon Arena ONE game or a pile of pages?  (stage W1)
//
//   node tools/pokemonarena_coherence_test.mjs                 # static scan + browser at 320 / 360 / 390 / 412 / 768 / 1280 + mutants
//   node tools/pokemonarena_coherence_test.mjs --static        # Node only (no browser)
//   node tools/pokemonarena_coherence_test.mjs --no-mutants
//   ARENA_PORT=8101 ARENA_CDP=9331 ARENA_OUT=<dir>
//
// WHAT IS CHECKED
//  static   (Node, every file a player can reach)
//     * no player-visible "demo" anywhere (pages, scripts, styles, README): the one internal hit that must remain (the demoTeam() helper of the dev IndexedDB fixture,
//       owned by another stage) is listed explicitly and anything else fails; pokemonarena/demo.html does not exist; the root pokemonarena.html redirects to /pokemonarena/
//     * every page title is "Pokemon Arena" or "Pokemon Arena - <screen>"; every page has a language, a viewport, a favicon that cannot 404 (data:,)
//       and loads the shared input.css
//  browser  (one headless Chrome at a time, muted, throwaway profile; the ROM is the real one)
//     * at 320 / 360 / 390 / 412 / 768 / 1280 px wide, each of the hub, the battle page, the team editor (profile list AND import screen):
//       it boots, it has NO horizontal scroll, NO console error / page error / failed or 4xx request, the title follows the format, no rendered text says
//       demo / lorem / TODO / placeholder / [object / undefined / NaN, and its Controls button opens the SAME Controls panel dialog and closes again
//     * the header chrome is the same on all three pages: body colours + font, the title's size / weight / colour / letter-spacing / case, the back
//       link, and the header buttons (colour, border, corner, size, >= 44 px) -- computed styles, compared page against page
//  mutants  each must fail its NAMED check while the unmutated twin stays quiet: a "demo" string re-added to the hub, the editor's old title format,
//       the editor header title one pixel too big, the battle page without a Controls dialog hook
//
// Pure ASCII output. Never touches a real audio device (the browser is muted and AudioContext is a test double).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const { root, BASE, sleep, errsOf, AUDIO_DOUBLE, PAD_DOUBLE, addInit, J } = L;
const ARGS = new Set(process.argv.slice(2));
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-coherence-shots');
const PA = path.join(root, 'pokemonarena');
const C = L.makeCounter('coherence');
const ok = C.ok;

/* ============================================================================================ static */
const PAGES = [
  { name: 'hub', file: 'index.html', url: '/pokemonarena/', ready: `window.__arenaHub && __arenaHub.state === 'ready'` },
  { name: 'battle', file: 'battle.html', url: '/pokemonarena/battle.html?seed=5&format=3v3', ready: `window.__arenaBattle && __arenaBattle.state === 'ready'` },
  { name: 'editor', file: 'editor.html', url: '/pokemonarena/editor.html', ready: `window.__editor && __editor.ready` },
  { name: 'import', file: 'editor.html', url: '/pokemonarena/editor.html#/import', ready: `window.__editor && __editor.ready && __editor.route().name === 'import'` },
];
const TITLE_RE = /^Pokemon Arena( - [A-Z][A-Za-z ]*)?$/;
const DEMO_RE = /\b[Dd]emo\b|\bDEMO\b|\b[Dd]emo[A-Z]/g;
// the internal names a "demo" scan must still find (and nowhere else): since the S1 stage finished, DemoBattle is ScriptedBattle (battle_ui.js) and only the
// demoTeam() helper of a dev fixture page remains (renaming it means editing a file and a test this stage does not own)
const INTERNAL_DEMO = [];     // nothing is left: DemoBattle became ScriptedBattle and the fixture's demoTeam() became sampleTeam()

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); } else if (/\.(html|js|css|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function staticScan(paDir, rootDir) {
  const problems = [];
  const files = walk(paDir).concat([path.join(rootDir, 'pokemonarena.html')].filter((f) => fs.existsSync(f)));
  const hits = [];
  for (const f of files) {
    const rel = path.relative(paDir, f).split(path.sep).join('/');
    if (/\.golden\.json$|_manifest\.json$|^engine_coverage\.json$/.test(rel)) continue;     // hashes and offsets only
    const s = fs.readFileSync(f, 'utf8');
    const m = s.match(DEMO_RE);
    if (m) hits.push({ rel, n: m.length });
  }
  const allowed = new Set(INTERNAL_DEMO.map((x) => x.file));
  const stray = hits.filter((h) => !allowed.has(h.rel) && !h.rel.startsWith('..'));
  if (stray.length) problems.push('"demo" found in: ' + stray.map((h) => h.rel + ' x' + h.n).join(', '));
  if (fs.existsSync(path.join(paDir, 'demo.html'))) problems.push('pokemonarena/demo.html exists');
  const titles = {};
  for (const p of PAGES.filter((x) => x.name !== 'import')) {
    const s = fs.readFileSync(path.join(paDir, p.file), 'utf8');
    const t = (/<title>([^<]*)<\/title>/.exec(s) || [])[1];
    titles[p.name] = t;
    if (!t || !TITLE_RE.test(t)) problems.push(p.file + ' has the title "' + t + '" (want "Pokemon Arena" or "Pokemon Arena - <screen>")');
    if (!/<html lang="[a-z]{2}"/.test(s)) problems.push(p.file + ' has no lang');
    if (!/name="viewport"[^>]*width=device-width/.test(s)) problems.push(p.file + ' has no viewport');
    if (!/<link rel="icon" href="data:,"/.test(s)) problems.push(p.file + ' has no favicon that cannot 404');
    if (!/href="\/pokemonarena\/input\.css"/.test(s)) problems.push(p.file + ' does not load the shared input.css');
  }
  // D5: the developer fixtures are never deployed
  const dx = path.join(rootDir, 'deploy.exclude');
  if (!fs.existsSync(dx) || !/^\/pokemonarena\/dev[ \t]*$/m.test(fs.readFileSync(dx, 'utf8'))) problems.push('deploy.exclude does not exclude /pokemonarena/dev (the developer fixtures would be served)');
  const redirect = path.join(rootDir, 'pokemonarena.html');
  if (!fs.existsSync(redirect) || !/\/pokemonarena\//.test(fs.readFileSync(redirect, 'utf8'))) problems.push('the root redirect pokemonarena.html is missing or does not point at /pokemonarena/');
  return { problems, hits, titles };
}

console.log('pokemonarena coherence test; node ' + process.version);
{
  const r = staticScan(PA, root);
  ok(r.problems.length === 0, 'static: no player-visible demo, every title / lang / viewport / favicon in order, no demo.html, the root redirect works', r.problems.join(' | '));
  console.log('  internal "demo" names that remain (not player-visible): ' + r.hits.map((h) => h.rel + ' x' + h.n).join(', ') + '  titles: ' + J(r.titles));
  ok(r.hits.every((h) => INTERNAL_DEMO.some((x) => x.file === h.rel)), 'static: every remaining "demo" is on the internal list', J(r.hits));
}
// static mutants (Node only, on a temp copy)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-coherence-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ } });
{
  const muts = [
    { id: 'S1 a demo string is re-added to the hub help text', file: 'js/hub_model.js', from: "help: ['Random teams against the CPU.',", to: "help: ['A demo of random teams.',", expect: 'no player-visible demo' },
    { id: 'S2 the editor page keeps its old title format', file: 'editor.html', from: '<title>Pokemon Arena - Team Editor</title>', to: '<title>Team Editor - Pokemon Arena</title>', expect: 'every title' },
    { id: 'S3 a demo page comes back', file: 'demo.html', create: '<!doctype html><title>Pokemon Arena - Battle screen demo</title>', expect: 'no player-visible demo' },
    { id: 'S5 the dev fixtures are no longer excluded from the deploy', root: 'deploy.exclude', from: '/pokemonarena/dev', to: '/pokemonarena/dev-not', expect: 'deploy.exclude' },
    { id: 'S4 the battle page loses its favicon guard (a 404 for /favicon.ico)', file: 'battle.html', from: '<link rel="icon" href="data:," />', to: '', expect: 'every title' },
  ];
  const twin = copyTree(PA, path.join(TMP, 'twin'));
  const t = staticScan(twin, root);
  ok(t.problems.length === 0, 'static mutants: the unmutated twin stays quiet', t.problems.join(' | '));
  for (const m of muts) {
    let d = PA, rd = root;
    if (m.root) { rd = fs.mkdtempSync(path.join(TMP, 'root-')); for (const fn of ['pokemonarena.html', 'deploy.exclude']) fs.copyFileSync(path.join(root, fn), path.join(rd, fn)); mutateFile(rd, m.root, m.from, m.to); }
    else { d = copyTree(PA, path.join(TMP, 'm' + m.id.split(' ')[0])); if (m.create) fs.writeFileSync(path.join(d, m.file), m.create); else mutateFile(d, m.file, m.from, m.to); }
    const r = staticScan(d, rd);
    ok(r.problems.length > 0 && /demo|title|favicon|lang|viewport|deploy/.test(r.problems.join(' ')), 'static mutant "' + m.id + '" trips the "' + m.expect + '" check', r.problems.join(' | '));
  }
}
if (ARGS.has('--static')) { C.finish(); process.exit(process.exitCode || 0); }

/* ============================================================================================ browser */
const WIDTHS = [320, 360, 390, 412, 768, 1280];
const SIG = `(() => {
  const q = (s) => document.querySelector(s);
  const pick = (el, props) => { if (!el) return null; const s = getComputedStyle(el); const o = {}; for (const p of props) o[p] = s[p]; return o; };
  const T = ['fontSize', 'fontWeight', 'color', 'letterSpacing', 'textTransform', 'fontFamily'];
  const bt = q('#soundBtn') || q('#controlsBtn');
  const btn = pick(bt, ['backgroundColor', 'color', 'borderTopColor', 'borderTopWidth', 'borderTopLeftRadius', 'fontSize']);
  const r = bt ? bt.getBoundingClientRect() : null;
  if (btn && r) { btn.h = Math.round(r.height); btn.w = Math.round(r.width); }
  const ctl = q('#controlsBtn');                                                       // W1 fix D8: the battle header has the same Controls button as the hub and the editor (Menu is an extra)
  const h1r = q('#top h1') ? q('#top h1').getBoundingClientRect() : null;
  const backEl = q('#top .home, #top .back');
  return {
    title: document.title, lang: document.documentElement.lang,
    body: pick(document.body, ['backgroundColor', 'color', 'fontFamily']),
    h1: pick(q('#top h1'), T), h1Shown: !!h1r && h1r.width > 2 && h1r.height > 2, back: pick(backEl, ['fontSize', 'color', 'textDecorationLine']),
    backGlyph: backEl ? backEl.textContent.trim().charCodeAt(0) : null,                  // D8: the same back glyph everywhere (U+2039)
    menuBtn: !!q('#menuBtn'),
    btn, controlsBtn: !!ctl,
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    dataStr: document.body.innerText + ' ' + document.title + ' ' + [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].map((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a) || '').join(' ')).join(' '),
  };
})()`;
const BAD_WORDS = /demo|lorem|todo|placeholder|coming soon|\[object|undefined|NaN/i;
const same = (a, b) => J(a) === J(b);

async function openCloseControls(page, pg) {
  const open = await page.eval(`(async () => {
    const btn = document.getElementById('controlsBtn'); if (!btn) return { err: 'no Controls button' };
    btn.click();
    for (let i = 0; i < 60; i++) { const d = document.getElementById('controlsDialog'); if (d && !d.hidden && d.querySelector('.ip')) break; await new Promise((r) => setTimeout(r, 100)); }
    const d = document.getElementById('controlsDialog');
    // W1 fix D8: the dialog fits the viewport (it was 3039 px tall on a phone), scrolls INSIDE, names itself once, and its Close targets are 44 px
    const dlg = d && d.querySelector('.dlg'), host = document.getElementById('controlsHost');
    const box = dlg ? dlg.getBoundingClientRect() : null;
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const heads = d ? [...d.querySelectorAll('h1, h2')].filter(shown).map((e) => e.textContent.trim()) : [];
    const closes = d ? [...d.querySelectorAll('#controlsClose, #controlsClose2')].map((e) => Math.round(e.getBoundingClientRect().height)) : [];
    const fit = { dlgH: box ? Math.round(box.height) : -1, top: box ? Math.round(box.top) : -1, bottom: box ? Math.round(box.bottom) : -1, innerH: innerHeight, docH: document.documentElement.scrollHeight, hostScrolls: !!host && host.scrollHeight > host.clientHeight, heads, closes };
    return { open: !!d && !d.hidden, role: d && d.getAttribute('role'), modal: d && d.getAttribute('aria-modal'), panel: !!(d && d.querySelector('.ip')), rows: d ? d.querySelectorAll('tr[data-action]').length : 0, focusIn: !!(d && d.contains(document.activeElement)), btnW: btn.getBoundingClientRect().width, fit };
  })()`);
  const shot = pg.shot;
  if (shot) await page.screenshot(shot);
  await page.eval(`document.getElementById('controlsClose').click()`);
  await sleep(150);
  const closed = await page.eval(`(() => { const d = document.getElementById('controlsDialog'); return !!d && d.hidden; })()`);
  return { ...open, closed };
}
const CTL_FIT = (f) => !!f && f.dlgH > 0 && f.dlgH <= f.innerH && f.top >= 0 && f.bottom <= f.innerH + 1 && f.heads.length === 1 && f.heads[0] === 'Controls' && f.closes.length >= 1 && f.closes.every((h) => h >= 44);

// MU3: the header Sound button opens the ONE SOUND panel (sound_panel.js) -- the same dialog, the same controls and words on every page
async function openCloseSound(page) {
  const open = await page.eval(`(async () => {
    const btn = document.getElementById('soundBtn'); if (!btn) return { err: 'no Sound button' };
    btn.click();
    for (let i = 0; i < 60; i++) { const d = document.getElementById('soundDialog'); if (d && !d.hidden) break; await new Promise((r) => setTimeout(r, 100)); }
    const d = document.getElementById('soundDialog');
    return { open: !!d && !d.hidden, role: d && d.getAttribute('role'), modal: d && d.getAttribute('aria-modal'), sliders: d ? d.querySelectorAll('input[type=range]').length : 0, mute: !!(d && d.querySelector('[data-snd=mute]')), radios: d ? d.querySelectorAll('[role=radio]').length : 0,
      test: !!(d && d.querySelector('[data-snd=test]')), focusIn: !!(d && d.contains(document.activeElement)), noScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth, sig: d ? [...d.querySelectorAll('[data-snd]')].map((e) => e.dataset.snd).join(',') : '' };
  })()`);
  if (open.err) return { ...open, closed: false };
  await page.eval(`document.querySelector('#soundDialog [data-snd="close"]').click()`);
  await sleep(150);
  const closed = await page.eval(`(() => { const d = document.getElementById('soundDialog'); return !!d && d.hidden; })()`);
  return { ...open, closed };
}
const SOUND_OK = (sp) => sp.open && sp.role === 'dialog' && sp.modal === 'true' && sp.sliders === 3 && sp.mute && sp.radios === 2 && sp.test && sp.focusIn && sp.noScroll && sp.closed;

async function pageAt(page, pg, width, collect) {
  await page.navigate(BASE + pg.url);
  await page.waitFor(pg.ready, { timeoutMs: 120000 });
  await sleep(250);
  if (pg.name === 'battle') await page.eval('__arenaBattle.pause(true)');
  const sig = await page.eval(SIG);
  const tag = pg.name + '@' + width + ': ';
  ok(sig.scrollW <= sig.innerW, tag + 'no horizontal scroll (scrollWidth ' + sig.scrollW + ' <= ' + sig.innerW + ')');
  ok(TITLE_RE.test(sig.title), tag + 'the title follows "Pokemon Arena - <screen>": "' + sig.title + '"');
  ok(!BAD_WORDS.test(sig.dataStr), tag + 'no rendered text says demo / lorem / todo / placeholder / [object / undefined / NaN', (sig.dataStr.match(BAD_WORDS) || [''])[0]);
  ok(sig.controlsBtn, tag + 'there is a Controls button in the header');
  if (collect) collect[pg.name] = sig;
  if (pg.name === 'battle') {
    // the battle page: the header Menu button (and Start / Esc) opens the pause menu, whose CONTROLS row opens the SAME dialog
    const c = await page.eval(`(async () => {
      const a = window.__arenaBattle; a.pause(false); for (let i = 0; i < 900 && !['preview', 'action'].includes(a.mode); i++) { a.press('a'); await new Promise((r) => setTimeout(r, 15)); }
      document.getElementById('menuBtn').click(); await new Promise((r) => setTimeout(r, 120));
      const rows = a.scene.S.menu ? a.scene.S.menu.rows.slice() : [];
      a.press('down'); a.press('a');
      for (let i = 0; i < 60; i++) { const d = document.getElementById('controlsDialog'); if (d && !d.hidden && d.querySelector('.ip')) break; await new Promise((r) => setTimeout(r, 100)); }
      const d = document.getElementById('controlsDialog');
      const o = { rows, open: !!d && !d.hidden, role: d && d.getAttribute('role'), modal: d && d.getAttribute('aria-modal'), panel: !!(d && d.querySelector('.ip')), n: d ? d.querySelectorAll('tr[data-action]').length : 0, focusIn: !!(d && d.contains(document.activeElement)) };
      a.closeControls(); await new Promise((r) => setTimeout(r, 200)); o.closed = !!d && d.hidden; return o;
    })()`);
    if (pg.shotControls) await page.screenshot(pg.shotControls);
    ok(c.rows.includes('CONTROLS') && c.open && c.role === 'dialog' && c.modal === 'true' && c.panel && c.n === 12 && c.focusIn && c.closed, tag + 'the pause menu (header Menu button) lists CONTROLS and opens the SAME panel dialog with the 12 actions, focus inside, and it closes again', J(c));
    // W1 fix D8: ... and the battle header also has the same Controls button as the hub and the editor
    const hc = await openCloseControls(page, { shot: width === 390 || width === 1280 ? path.join(OUT, `co_${pg.name}_${width}_controls.png`) : null });
    ok(hc.open && hc.role === 'dialog' && hc.modal === 'true' && hc.panel && hc.rows === 12 && hc.focusIn && hc.closed, tag + 'the battle header Controls button opens the same panel (12 actions, focus inside) and closes again', J(hc));
    ok(CTL_FIT(hc.fit), tag + 'the Controls dialog fits the viewport (scrolls inside, one heading, Close >= 44 px)', J(hc.fit));
  } else if (sig.controlsBtn) {
    const c = await openCloseControls(page, { shot: width === 390 || width === 1280 ? path.join(OUT, `co_${pg.name}_${width}_controls.png`) : null });
    ok(c.open && c.role === 'dialog' && c.modal === 'true' && c.panel && c.rows === 12 && c.focusIn && c.closed, tag + 'Controls opens the shared panel (a modal dialog with the 12 actions, focus inside) and closes again', J(c));
    ok(CTL_FIT(c.fit), tag + 'the Controls dialog fits the viewport (scrolls inside, one heading, Close >= 44 px)', J(c.fit));
  }
  // MU3: and every page has the Sound button that opens the same SOUND panel
  const sp = await openCloseSound(page);
  ok(SOUND_OK(sp), tag + 'Sound opens the shared SOUND panel (a modal dialog: 3 sliders, Mute, 2 soundtracks, Test; focus inside; no horizontal scroll) and closes again', J(sp));
  if (collect) collect[pg.name].soundSig = sp.sig;
  return sig;
}

async function browserSession(base, widths, label, opts = {}) {
  const sigs = {};
  let port = Number(process.env.ARENA_CDP || 9331);
  for (const width of widths) {
    const height = width >= 768 ? 900 : 844;
    await withBrowser({ port: port++, width, height, mobile: width < 768 }, async (page) => {
      if (width < 768) await page.setViewport(width, height, { mobile: true, dpr: 3 });
      await addInit(page, AUDIO_DOUBLE);
      const per = {};
      for (const pg of PAGES) {
        if (opts.only && !opts.only.includes(pg.name)) continue;
        await pageAt(page, pg, width, per);
        if (width === 390 || width === 1280) await page.screenshot(path.join(OUT, `co_${pg.name}_${width}.png`));
      }
      sigs[width] = per;
      const errs = errsOf(page);
      ok(errs.length === 0, label + '@' + width + ': no console error, page error, 404 or failed request across the pages', errs.slice(0, 3).join(' | '));
    });
  }
  return sigs;
}

function headerChecks(sigs, label) {
  for (const width of Object.keys(sigs)) {
    const s = sigs[width];
    if (!s.hub || !s.battle || !s.editor) continue;
    const tag = label + '@' + width + ': ';
    for (const k of ['body', 'h1', 'back', 'btn']) {
      const ref = s.hub[k];
      const a = { ...ref }, b = { ...s.battle[k] }, e = { ...s.editor[k] };
      if (k === 'btn') { for (const o of [a, b, e]) { delete o.w; } }
      ok(same(a, b) && same(a, e), tag + 'header chrome "' + k + '" is identical on the hub, the battle page and the editor', J({ hub: a, battle: b, editor: e }).slice(0, 400));
    }
    ok(s.hub.btn.h >= 44 && s.battle.btn.h >= 44 && s.editor.btn.h >= 44, tag + 'the header buttons are at least 44 px tall (' + [s.hub.btn.h, s.battle.btn.h, s.editor.btn.h].join(' / ') + ')');
    // W1 fix D8: the same title visibility (the battle page showed a "BATTLE" h1 on a phone while the hub and the editor hid theirs), the same back glyph, the same buttons
    ok(s.hub.h1Shown === s.battle.h1Shown && s.hub.h1Shown === s.editor.h1Shown, tag + 'the header title is shown on all three pages or hidden on all three (' + [s.hub.h1Shown, s.battle.h1Shown, s.editor.h1Shown].join(' / ') + ')');
    ok(s.hub.backGlyph === s.battle.backGlyph && s.hub.backGlyph === s.editor.backGlyph, tag + 'the back link starts with the same glyph on all three pages (' + [s.hub.backGlyph, s.battle.backGlyph, s.editor.backGlyph].join(' / ') + ')');
    ok(s.hub.controlsBtn && s.battle.controlsBtn && s.editor.controlsBtn && s.battle.menuBtn && !s.hub.menuBtn && !s.editor.menuBtn, tag + 'every header has Controls; only the battle header adds Menu');
    ok(!!s.hub.soundSig && s.hub.soundSig === s.battle.soundSig && s.hub.soundSig === s.editor.soundSig, tag + 'the SOUND panel has the same controls on the hub, the battle page and the editor', J({ hub: s.hub.soundSig, battle: s.battle.soundSig, editor: s.editor.soundSig }).slice(0, 300));
  }
}

/* ------------------------------------------------------------------------------------------------ W1 fix D6 / D7: ONE error experience
   The same fault (the game file answers 404) on the hub, the battle page and the team editor, at 390 px: the same title, the same words, the same detail line, the same
   buttons (Try again + a way back), no server path or hash on the screen, and no stale editor chrome (the green "Saved" badge, Undo / Redo) on top of an error. */
const ERR_PATH = /gbaWasm|\.gba\b|\/roms\/|Pokemon%20|SoulGold \(v|https?:|localhost|127\.0\.0\.1|sha-?256|[0-9a-f]{32,}/i;      // (the game's NAME, "Pokemon SoulGold v1.1.1", is fine to say; its file name, path, URL or hash is not)
async function errorExperience(base) {
  const per = {};
  let port = Number(process.env.ARENA_CDP || 9331) + 60;
  for (const pg of PAGES.filter((x) => x.name !== 'import')) {
    await withBrowser({ port: port++, width: 390, height: 844, mobile: true }, async (page) => {
      await page.setViewport(390, 844, { mobile: true, dpr: 2 });
      await addInit(page, AUDIO_DOUBLE); await addInit(page, PAD_DOUBLE);
      let romReq = 0;
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*Pokemon*SoulGold*', requestStage: 'Request' }] });
      page.handlers.push((m) => { if (m.method === 'Fetch.requestPaused') romReq++; });
      page.handlers.push((m) => { if (m.method === 'Fetch.requestPaused') page.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }], body: Buffer.from('nope').toString('base64') }); });
      await page.navigate(base + pg.url);
      try { await page.waitFor(`(() => { const e = document.getElementById('error'); return !!e && !e.hidden; })()`, { timeoutMs: 90000 }); } catch (e) { per[pg.name] = { missing: String(e.message).slice(0, 80) }; return; }
      await sleep(300);
      per[pg.name] = await page.eval(`(() => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const $ = (id) => document.getElementById(id);
        return { title: $('errTitle').textContent.trim(), msg: $('errMsg').textContent.trim(), detail: $('errDetail') ? $('errDetail').textContent.trim() : null, text: $('error').innerText,
          retry: vis($('retry')), buttons: [...document.querySelectorAll('#error button, #error a')].filter(vis).map((e) => e.textContent.trim()),
          save: vis($('saveState')), undo: vis($('undoBtn')) || vis($('redoBtn')), quick: vis($('quickBtn')),
          header: [...document.querySelectorAll('#top button')].filter(vis).map((e) => e.id), sw: document.documentElement.scrollWidth, iw: innerWidth };
      })()`);
      // W1 fix A2: a CONTROLLER alone can operate the error screen: A presses the focused default control (Try again asks for the game file again), B leaves
      const padTap = async (idx) => { await page.eval(`(() => { if (!window.__w1woke) { window.__w1woke = 1; window.dispatchEvent(new Event('gamepadconnected')); } window.__pad.buttons[${idx}] = 1; })()`); await sleep(110); await page.eval(`window.__pad.buttons[${idx}] = 0`); await sleep(160); };
      await padTap(14);                                                                  // wake the pad and put the ring on the screen's first control (a left press is harmless)
      const before = romReq;
      await padTap(0); await sleep(1500);
      per[pg.name].padRetry = romReq > before;
      await padTap(1); await sleep(2500);
      per[pg.name].padLeft = await page.eval(`location.pathname`).catch(() => 'navigating');
    });
  }
  return per;
}
function errChecks(per, probe) {
  const names = ['hub', 'battle', 'editor'];
  for (const n of names) {
    const p = per[n];
    if (!p || p.missing) { probe(false, n + ': the error screen appeared', p && p.missing); continue; }
    probe(!ERR_PATH.test(p.text), n + ': no server path, file name or hash on the error screen', p.text.slice(0, 160));
    probe(p.sw <= p.iw, n + ': the error screen does not scroll sideways');
    probe(!p.save && !p.undo, n + ': no "Saved" badge and no Undo / Redo on the error screen', J({ save: p.save, undo: p.undo }));
    probe(p.retry && p.buttons[0] === 'Try again' && p.buttons.length === 2 && !p.quick, n + ': the buttons are Try again and one way back', J(p.buttons));
    probe(p.padRetry === true && p.padLeft === (n === 'hub' ? '/' : '/pokemonarena/'), n + ': a controller alone can operate the error screen (A = Try again fetches the game file again, B leaves for ' + (n === 'hub' ? 'the site' : 'the Arena') + ')', J({ padRetry: p.padRetry, padLeft: p.padLeft }));
  }
  const ok3 = names.every((n) => per[n] && !per[n].missing);
  if (ok3) {
    const key = (n) => J({ title: per[n].title, msg: per[n].msg, detail: per[n].detail });
    probe(key('hub') === key('battle') && key('hub') === key('editor'), 'the same title, message and explanation on all three pages', J({ hub: per.hub.title + ' / ' + per.hub.msg.slice(0, 40), battle: per.battle.title + ' / ' + per.battle.msg.slice(0, 40), editor: per.editor.title + ' / ' + per.editor.msg.slice(0, 40) }));
    const hdr = (n) => per[n].header.filter((id) => id !== 'menuBtn').sort().join(',');
    probe(hdr('hub') === hdr('battle') && hdr('hub') === hdr('editor'), 'the same header buttons on all three error screens', J({ hub: per.hub.header, battle: per.battle.header, editor: per.editor.header }));
    probe(!per.battle.header.includes('menuBtn'), 'the battle error screen has no pause-menu button (there is no battle to pause)', J(per.battle.header));
  }
}

let server = null;
try {
  console.log('before the browser: ' + L.loadPct() + '; reaping leaked browsers');
  L.reapLeaks();
  server = await L.startServer();
  fs.mkdirSync(OUT, { recursive: true });
  const sigs = await browserSession(BASE, WIDTHS, 'real');
  headerChecks(sigs, 'real');

  // THE PICTURE FILLS A PHONE (js/screenfit.js): held upright it runs edge to edge, the whole width of the screen, no gutters and no frame. This block used to assert the opposite
  // (a whole number of device pixels INSIDE the 16 px gutters: 240 css px on a 390 px phone at DPR 2, 324 at DPR 3), which is exactly the small picture a phone owner complained about.
  {
    const cases = [{ w: 390, dpr: 2, css: 390 }, { w: 396, dpr: 2, css: 396 }, { w: 412, dpr: 2, css: 412 }, { w: 390, dpr: 3, css: 390 }, { w: 360, dpr: 3, css: 360 }, { w: 360, dpr: 2, css: 360 }, { w: 320, dpr: 2, css: 320 }];
    let port = Number(process.env.ARENA_CDP || 9331) + 40;
    for (const c of cases) {
      await withBrowser({ port: port++, width: c.w, height: 844, mobile: true }, async (page) => {
        await page.setViewport(c.w, 844, { mobile: true, dpr: c.dpr });
        await addInit(page, AUDIO_DOUBLE);
        for (const pg of PAGES.filter((x) => x.name === 'hub' || x.name === 'battle')) {
          await page.navigate(BASE + pg.url);
          await page.waitFor(pg.ready, { timeoutMs: 120000 });
          const g = await page.eval(`(() => { const c = document.querySelector('canvas#hub, canvas#battle'); const b = c.getBoundingClientRect(); return { css: Math.round(parseFloat(c.style.width) * 100) / 100, total: Math.round(b.width), left: Math.round(b.left), scrollW: document.documentElement.scrollWidth, innerW: innerWidth }; })()`);
          ok(g.css === c.css && g.left === 0 && g.total === c.w && g.scrollW <= g.innerW, pg.name + ' at ' + c.w + ' px, DPR ' + c.dpr + ': the canvas is ' + c.css + ' css px, the whole width of the phone (' + (c.css * c.dpr / 240).toFixed(2) + ' device pixels per source pixel), edge to edge, no sideways scroll', J(g));
        }
      });
    }
  }

  {   // W1 fix D6 / D7: the one error experience (the same fault on all three pages)
    const per = await errorExperience(BASE);
    errChecks(per, (cond, name, detail) => ok(cond, 'error screens: ' + name, detail));
    console.log('  error screens: ' + J(Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { title: v.title, buttons: v.buttons, header: v.header }]))));
  }

  /* ---------------------------------------------------------------------------------------- mutants (browser) */
  if (!ARGS.has('--no-mutants')) {
    const BMUT = [
      { id: 'B1 the editor header title is one pixel too big', rel: 'editor.css', from: '#top h1 { font-size: 17px;', to: '#top h1 { font-size: 18px;', widths: [1280], expect: 'header chrome "h1"' },
      { id: 'B2 the editor header buttons use a different corner', rel: 'editor.css', from: '#top .btn { font-size: 14px; border-radius: 6px; }', to: '#top .btn { font-size: 14px; border-radius: 12px; }', widths: [1280], expect: 'header chrome "btn"' },
      { id: 'B3 the editor loses its Controls button wiring', rel: 'editor.html', from: ' id="controlsBtn"', to: ' id="controlsBtnX"', widths: [1280], only: ['editor'], expect: 'there is a Controls button' },
      { id: 'B4 the battle pause menu cannot open the Controls dialog (the hook is gone)', rel: 'js/battle_boot.js', from: "onControls: openControls,\n      onSendOut:", to: "onSendOut:", widths: [1280], only: ['battle'], expect: 'battle pause menu lists CONTROLS', pauseCheck: true },
      { id: 'B5 the editor header loses its Sound button', rel: 'editor.html', from: ' id="soundBtn"', to: ' id="soundBtnX"', widths: [1280], only: ['editor'], expect: 'Sound opens the shared SOUND panel', soundCheck: true },
      // W1 fix D6 / D7 / D8
      { id: 'B6 the battle page shows its title on a phone (the hub and the editor hide theirs)', rel: 'battle.css', from: '#top h1 { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }', to: '#top h1 { }', widths: [390], expect: 'header title is shown on all three' },
      { id: 'B7 the battle page keeps a different back glyph', rel: 'battle.html', from: '&lsaquo; Arena', to: '&larr; Arena', widths: [1280], expect: 'same glyph' },
      { id: 'B8 the Controls dialog is taller than the viewport again', rel: 'js/controls_dialog.js', from: 'max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); display: flex;', to: 'display: flex;', widths: [390], only: ['hub'], expect: 'Controls dialog fits the viewport', fitCheck: true },
      { id: 'E1 the editor error screen keeps the green Saved badge', rel: 'editor.css', from: 'body[data-state="boot"] #saveState, body[data-state="error"] #saveState, ', to: '', errCheck: true, expect: '"Saved" badge' },
      { id: 'E2 the missing-file message prints the server address', rel: 'js/rom_error.js', from: 'where it looked (error 404).', to: "where it looked (error 404, ' + safeUrl() + ').", errCheck: true, expect: 'no server path' },
      { id: 'E4 the hub error screen cannot be operated by a controller', rel: 'js/boot.js', from: "if (input && nav && typeof nav.enableDomNav === 'function') {", to: 'if (false) {', errCheck: true, expect: 'a controller alone can operate the error screen' },
      { id: 'E5 the editor error screen cannot be operated by a controller', rel: 'js/editor_app.js', from: 'enableErrorNav();\n  };', to: '};', errCheck: true, expect: 'a controller alone can operate the error screen' },
      { id: 'E3 the hub error screen keeps its Sound button', rel: 'arena.css', from: '#controlsBtn, body[data-state="error"] #soundBtn { visibility: hidden; }', to: '#controlsBtn { visibility: hidden; }', errCheck: true, expect: 'same header buttons' },
    ];
    let overlayPort = Number(process.env.ARENA_PORT || 8101) + 10;
    for (const m of BMUT) {
      const d = copyTree(PA, path.join(TMP, 'b' + m.id.split(' ')[0]));
      mutateFile(d, m.rel, m.from, m.to);
      const ov = await startOverlay({ dir: d, port: overlayPort++, upstream: BASE });
      try {
        const r = m.errCheck ? await probeErrors(ov.url) : await probeOverlay(ov.url, m);       // collects the names of the checks that FAIL on the mutant; never touches this run's counters
        ok(r.tripped.some((x) => x.includes(m.expect)), 'mutant "' + m.id + '" trips the named check "' + m.expect + '"', J(r.tripped).slice(0, 300));
      } finally { ov.stop(); }
    }
  }
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();

// run the header / Controls checks against an overlay URL and report which checks FAIL (the unmutated twin passes all of them above)
async function probeOverlay(url, m) {
  const tripped = [];
  const probe = (cond, name, detail) => { if (!cond) tripped.push(name + (detail ? ' :: ' + String(detail).slice(0, 120) : '')); return cond; };
  const sigs = {};
  let port = Number(process.env.ARENA_CDP || 9331) + 20;
  for (const width of m.widths) {
    await withBrowser({ port: port++, width, height: 900 }, async (page) => {
      await addInit(page, AUDIO_DOUBLE);
      const per = {};
      for (const pg of PAGES) {
        if (m.only && !m.only.includes(pg.name)) continue;
        await page.navigate(url + pg.url);
        try { await page.waitFor(pg.ready, { timeoutMs: 120000 }); } catch (e) { probe(false, 'page ' + pg.name + ' did not become ready', e.message); continue; }
        await sleep(200);
        const sig = await page.eval(SIG);
        per[pg.name] = sig;
        probe(sig.controlsBtn, pg.name + ': there is a Controls button');
        if (m.fitCheck) { const c = await openCloseControls(page, {}); probe(CTL_FIT(c.fit), pg.name + ': the Controls dialog fits the viewport', J(c.fit)); }
        if (m.soundCheck) probe(SOUND_OK(await openCloseSound(page)), pg.name + ': Sound opens the shared SOUND panel');
        if (m.pauseCheck && pg.name === 'battle') {
          await page.eval('__arenaBattle.pause(true)');
          for (let i = 0; i < 600 && !['preview', 'action'].includes(await page.eval('__arenaBattle.mode')); i++) { await page.eval('__arenaBattle.press("a")'); await sleep(30); }
          await page.eval('__arenaBattle.press("start")'); await sleep(100);
          const rows = await page.eval('__arenaBattle.scene.S.menu ? __arenaBattle.scene.S.menu.rows : []');
          probe(rows.includes('CONTROLS'), 'battle pause menu lists CONTROLS', J(rows));
        }
      }
      sigs[width] = per;
    });
  }
  for (const width of Object.keys(sigs)) {
    const s = sigs[width];
    if (!s.hub || !s.battle || !s.editor) continue;
    for (const k of ['body', 'h1', 'back', 'btn']) {
      const a = { ...s.hub[k] }, b = { ...s.battle[k] }, e = { ...s.editor[k] };
      if (k === 'btn') { delete a.w; delete b.w; delete e.w; }
      probe(same(a, b) && same(a, e), 'header chrome "' + k + '" is identical on the hub, the battle page and the editor', J({ hub: a, editor: e }).slice(0, 200));
    }
    probe(s.hub.h1Shown === s.battle.h1Shown && s.hub.h1Shown === s.editor.h1Shown, 'the header title is shown on all three pages or hidden on all three', J([s.hub.h1Shown, s.battle.h1Shown, s.editor.h1Shown]));
    probe(s.hub.backGlyph === s.battle.backGlyph && s.hub.backGlyph === s.editor.backGlyph, 'the back link starts with the same glyph on all three pages', J([s.hub.backGlyph, s.battle.backGlyph, s.editor.backGlyph]));
  }
  return { tripped };
}

// the error-experience checks against an overlay URL (the mutants E1-E3); returns the names of the checks that FAIL
async function probeErrors(url) {
  const tripped = [];
  const probe = (cond, name, detail) => { if (!cond) tripped.push(name + (detail ? ' :: ' + String(detail).slice(0, 120) : '')); return cond; };
  errChecks(await errorExperience(url), probe);
  return { tripped };
}
