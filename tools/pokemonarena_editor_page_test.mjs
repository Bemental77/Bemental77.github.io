#!/usr/bin/env node
// POKEMONARENA EDITOR PAGE TEST  (stage T1)
//
// Drives /pokemonarena/editor.html in a REAL headless Chrome (tools/headless_cdp.mjs: ONE browser at a time machine-wide, throwaway profile,
// bare CDP, --mute-audio, never the user's browser) against REAL IndexedDB, and checks what a player would do:
//
//   MAIN FLOW (390x844 phone): create a profile -> a team of 3 -> pick species through the search -> set nature, hidden ability, held item, moves,
//   EVs (typed, stepper and slider), IVs (preset) -> wait for the autosave -> RELOAD the page (real IndexedDB) and read everything back from the
//   screen -> compare the on-screen derived stats with what rules.js computes in Node -> Export -> delete the profile -> import the file back
//   through the real file input -> copy the team code, import it into a second profile -> read the Test battle link (assert its query) and the
//   "vs my other team" link -> undo with the keyboard -> the autosave indicator -> hostile import files.
//   OTHER CASES: IndexedDB blocked (memory fallback banner, nothing survives a reload), a second writer (compare-and-swap conflict banner; "Keep my edits here" keeps a battle the other tab recorded meanwhile, with a negative control), a
//   missing ROM (error screen), and screenshots + layout predicates at 390x844, 320x568 and 1280x800 of: profile list, team list, mon editor top,
//   EV panel, move picker, validation errors.
//   RECORDS THIS ROM CANNOT SHOW: re-sealed (valid checksum) files naming species 5000 / an empty slot, a move and an item the ROM lacks, and 20
//   teams; team codes naming such species; and a stored profile already holding them. The screen must still draw (it used to go BLANK, on import
//   and on every reload), the records are set aside or named by number, and a draws() predicate with negative controls proves it can fail.
//   FOUR DEVICES, EACH ALONE: the same job (profile -> team -> Pokemon -> Attack EV 3 x "+" -> reload) with real mouse events, real touch events,
//   real key events (Tab / Enter) and a faked Gamepad (navigator.getGamepads) through the shared input layer (js/input.js + js/uinav.js, which
//   another stage owns). Then the controller alone: every control on every screen and dialog is reachable (breadth-first over the layer's own
//   chooseNext), and every KIND of control (select, radio-like buttons, checkbox, number field, slider, preset, dialog, link) is operated.
//   A negative control blocks uinav.js and shows the controller then does nothing while the mouse still works.
//
// NEGATIVE CONTROLS (a test that cannot fail is decoration): the layout predicates are run against an injected stylesheet that breaks them and
// must fail; the persistence comparison is run against a corrupted snapshot and must fail; a blocked-IndexedDB reload must LOSE the profile
// (so the persistence check can tell a real store from memory); the on-screen art is compared with Node's render of the same ROM bytes and with
// a render from a ROM whose bytes were zeroed (which must differ); each hostile file is refused while the valid twin imports.
//
// Screenshots go to ARENA_OUT and are meant to be opened and looked at.
//
// USAGE   node tools/pokemonarena_editor_page_test.mjs          (starts PORT=8093 node tools/devserver.mjs itself)
// ENV     ARENA_PORT (default 8093)  ARENA_CDP (first CDP port, default 9261)  ARENA_OUT  ARENA_ROM  ARENA_BASE (use a running server)
//         ARENA_CASES=records,device   run only the cases whose name contains one of these words (the main-flow cases the others do not need are skipped)
//
// Reads the ROM, writes screenshots and temp files only. Pure ASCII.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-editor-shots');
const PORT = Number(process.env.ARENA_PORT || 8093);
const CDP = Number(process.env.ARENA_CDP || 9261);
const BASE = process.env.ARENA_BASE || `http://localhost:${PORT}`;
const PAGE = BASE + '/pokemonarena/editor.html';
const mod = (n) => import(pathToFileURL(path.join(root, 'pokemonarena', 'js', n)).href);
const ED = await mod('editor_data.js');
const TB = await mod('tables.js'), R = await mod('rules.js'), P = await mod('profile.js'), T = await mod('teamcode.js'), ST = await mod('stats.js'), L = await mod('editor_links.js'), A = await mod('editor_art.js');
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-editor-page-'));
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const pack = TB.loadPack(rom, { dexText: false });
const art = A.createArtKit(rom);
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('  ok  ', name); } else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('FAIL', name, detail ? ':: ' + String(detail).slice(0, 300) : ''); } }
const nameId = (n) => pack.species.findIndex((s) => s && s.legal && s.name === n);
const moveId = (n) => pack.moves.findIndex((m) => m && m.name === n);
const itemId = (n) => pack.items.find((i) => i.name === n).id;
const PIKACHU = 25, CHARIZARD = 6, SNORLAX = 143;
const sha = (u8) => { let h = 2166136261 >>> 0; for (const b of u8) { h ^= b; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };

console.log('pokemonarena editor page test; ROM ' + ROM_PATH + '; node ' + process.version + '; cpus ' + os.cpus().length);

/* ------------------------------------------------------------------------------------------------ server */
async function startServer() {
  if (process.env.ARENA_BASE) return null;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/pokemonarena/editor.html'); if (r.ok) return child; } catch (_e) { /* not up yet */ } await sleep(250); }
  child.kill(); throw new Error('dev server did not start on ' + PORT);
}
const loadPct = () => { try { const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8' }); return (r.stdout || '').trim() + '%'; } catch (_e) { return '?'; } };

/* ------------------------------------------------------------------------------------------------ page helpers */
const q = (sel) => `document.querySelector(${J(sel)})`;
async function click(page, sel) { return page.eval(`(() => { const e = ${q(sel)}; if (!e) throw new Error('no element ' + ${J(sel)}); e.click(); return true; })()`); }
async function exists(page, sel) { return page.eval(`!!${q(sel)}`); }
async function setVal(page, sel, v, evt = 'input') { return page.eval(`(() => { const e = ${q(sel)}; if (!e) throw new Error('no element ' + ${J(sel)}); e.value = ${J(String(v))}; e.dispatchEvent(new Event(${J(evt)}, { bubbles: true })); return true; })()`); }
async function clickText(page, scope, text) { return page.eval(`(() => { const e = [...document.querySelectorAll(${J(scope)})].find((b) => b.textContent.trim() === ${J(text)}); if (!e) throw new Error('no ' + ${J(scope)} + ' with text ' + ${J(text)}); e.click(); return true; })()`); }
const go = async (page, hash) => { await page.eval(`location.hash = ${J(hash)}`); await sleep(200); };
const st = (page) => page.eval('JSON.parse(JSON.stringify({ route: __editor.route(), save: __editor.saveState, seq: __editor.state() && __editor.state().seq, saved: __editor.state() && __editor.state().savedSeq }))');
const profileOf = (page) => page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
const flush = (page) => page.eval('__editor.flush().then(() => true)');
const canon = ST.canonicalJSON;
// the persisted content, minus what the store owns (rev, updatedAt) and what a re-import regenerates (ids)
function content(p) { const c = JSON.parse(JSON.stringify(p)); delete c.rev; delete c.updatedAt; delete c.id; return canon(c); }
async function bootPage(page, url = PAGE) { await page.navigate(url); await page.waitFor('window.__editor && (window.__editor.ready || window.__editor.error)', { timeoutMs: 90000 }); return page.eval('({ ready: __editor.ready, error: __editor.error || null })'); }
const errsOf = (page) => page.errors.concat(page.console.filter((m) => m.type === 'error').map((m) => 'console.error: ' + m.text));
const canvasHash = (page, sel) => page.eval(`(() => { const c = ${q(sel)}; if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 2166136261 >>> 0; for (const b of d) { h ^= b; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); })()`);
// Enter on a focused button needs the character as well as the key (that is how Chrome turns it into a click)
const pressEnter = async (page) => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(60); };
const keyCombo = async (page, key, code, vk, modifiers) => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers }); };

// layout predicates, evaluated in the page; returns a list of findings ([] = fine)
const layoutJs = (mobile) => `(() => {
  const f = [];
  const MOBILE = ${mobile};
  const iw = window.innerWidth, de = document.documentElement;
  if (de.scrollWidth > iw + 0.5) f.push('horizontal scroll: scrollWidth ' + de.scrollWidth + ' > innerWidth ' + iw);
  if (document.body.scrollWidth > iw + 0.5) f.push('body is wider than the viewport: ' + document.body.scrollWidth);
  if (MOBILE && window.innerWidth > window.screen.width + 1) f.push('the layout viewport widened: innerWidth ' + window.innerWidth + ' vs the device ' + window.screen.width);
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]') && !e.closest('.skip'); };
  const small = [];
  for (const e of document.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button]')) {
    if (!vis(e)) continue;
    let t = e; const r0 = e.getBoundingClientRect();
    if ((e.type === 'checkbox' || e.type === 'radio') && e.closest('label')) t = e.closest('label');
    if (e.type === 'file') continue;
    const r = t.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5 && !(e.tagName === 'A' && e.closest('#crumbs') )) small.push((e.tagName + '.' + (e.className || e.type || '') + ' ' + (e.dataset && (e.dataset.act || e.dataset.fk) || e.textContent.trim().slice(0, 16))).trim() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (r0.right > iw + 0.5 || r0.left < -0.5) f.push('control outside the viewport: ' + (e.dataset && (e.dataset.act || e.dataset.fk) || e.tagName) + ' ' + Math.round(r0.left) + '..' + Math.round(r0.right));
  }
  if (small.length) f.push('touch targets under 44 px: ' + small.slice(0, 5).join('; '));
  const bad = [];
  for (const c of document.querySelectorAll('canvas.rom')) {
    if (!vis(c)) continue;
    const rr = c.getBoundingClientRect(), k = rr.width / c.width, kh = rr.height / c.height;
    if (!(k >= 1) || Math.abs(k - Math.round(k)) > 0.01 || Math.abs(kh - Math.round(kh)) > 0.01) bad.push(c.width + 'x' + c.height + ' drawn at ' + rr.width.toFixed(1) + 'x' + rr.height.toFixed(1));
  }
  if (bad.length) f.push('art not on a whole-number scale: ' + bad.slice(0, 3).join('; '));
  // text that spills out of the box that should hold it (a squashed flex row, a fixed height that is too small): scrollHeight > clientHeight
  const clipped = [];
  for (const e of document.querySelectorAll('.pick, .mvrow, .slot, .statrow, .card, .badge, .banner, .problems li, .tag, .btn')) {
    if (!vis(e)) continue;
    if (getComputedStyle(e).overflowY !== 'visible' && e.scrollHeight <= e.clientHeight + 1) continue;
    if (e.scrollHeight > e.clientHeight + 2) clipped.push(e.tagName + '.' + String(e.className).split(' ')[0] + ' ' + (e.textContent || '').trim().slice(0, 24) + ' (' + e.scrollHeight + ' > ' + e.clientHeight + ')');
  }
  if (clipped.length) f.push('content spills out of its box: ' + clipped.slice(0, 3).join('; '));
  return f;
})()`;
const LAYOUT_JS = layoutJs(true);
// accessibility basics, evaluated in the page: every control has a name, art is labelled or hidden, dialogs are modal and named, one h1, a live region
const A11Y_JS = `(() => {
  const f = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]') && !e.closest('.skip'); };
  const nameOf = (e) => {
    const t = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    if (t(e.getAttribute('aria-label'))) return t(e.getAttribute('aria-label'));
    const lb = e.getAttribute('aria-labelledby'); if (lb) { const x = t(lb.split(' ').map((id) => (document.getElementById(id) || {}).textContent).join(' ')); if (x) return x; }
    if (e.labels && e.labels.length) { const x = t([...e.labels].map((l) => l.textContent).join(' ')); if (x) return x; }
    if (['BUTTON', 'A', 'SUMMARY'].includes(e.tagName) || e.getAttribute('role')) { const x = t(e.textContent); if (x) return x; }
    return t(e.title);
  };
  for (const e of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=radio], [role=option], [role=button], [role=link]')) {
    if (!vis(e)) continue;
    if (!nameOf(e)) f.push('no accessible name: ' + e.tagName + ' ' + (e.dataset.act || e.dataset.fk || e.className));
  }
  for (const c of document.querySelectorAll('canvas.rom')) {
    if (!vis(c)) continue;
    if (c.getAttribute('role') === 'img' && !c.getAttribute('aria-label')) f.push('a picture canvas without a label');
    if (c.getAttribute('role') !== 'img' && c.getAttribute('aria-hidden') !== 'true') f.push('a canvas that is neither labelled nor hidden');
  }
  for (const d of document.querySelectorAll('[role=dialog]')) if (d.getAttribute('aria-modal') !== 'true' || !document.getElementById(d.getAttribute('aria-labelledby') || 'x')) f.push('a dialog without aria-modal / aria-labelledby');
  if (!document.querySelector('[aria-live]')) f.push('no aria-live region on the page');
  if (document.querySelectorAll('h1').length !== 1) f.push('expected exactly one h1');
  return f;
})()`;
const STRIP_NAMES_JS = `(() => { for (const e of document.querySelectorAll('[aria-label]')) e.removeAttribute('aria-label'); for (const e of document.querySelectorAll('label')) e.replaceWith(...[...e.childNodes].filter((n) => n.nodeType === 1)); return true; })()`;
const BREAK_CSS = '.slot { height: 40px !important } .screen, .card, .slots { min-width: 640px !important } .btn, select, input[type=text], input[type=number] { min-height: 28px !important; height: 28px !important } canvas.rom { width: 37px !important }';

/* ------------------------------------------------------------------------------------------------ seed a rich profile through the app */
const SEED = `(async () => {
  const E = window.__editor;
  const r = await E.actions.createProfile('RED');
  const d = (a) => E.dispatch(a);
  let s = d({ type: 'teamCreate', name: 'RAIN TEAM' });
  const t1 = s.result.teamId;
  const add = (sp) => d({ type: 'monAdd', teamId: t1, species: sp }).result.monId;
  const pika = add(${PIKACHU}), zard = add(${CHARIZARD}), snor = add(${SNORLAX});
  d({ type: 'monSet', monId: pika, field: 'nature', value: 3 });
  d({ type: 'monSet', monId: pika, field: 'abilitySlot', value: 2 });
  d({ type: 'monSet', monId: pika, field: 'heldItem', value: ${itemId('Leftovers')} });
  d({ type: 'moveSet', monId: pika, slot: 1, moveId: ${moveId('Thunderbolt')} });
  d({ type: 'evSet', monId: pika, stat: 'atk', value: 252, mode: 'ev' });
  d({ type: 'evSet', monId: pika, stat: 'spe', value: 252, mode: 'ev' });
  d({ type: 'monSet', monId: zard, field: 'nature', value: 10 });
  d({ type: 'moveSet', monId: zard, slot: 1, moveId: ${moveId('Flamethrower')} });
  d({ type: 'ivPreset', monId: zard, preset: 'hp:Ice' });
  d({ type: 'monSet', monId: snor, field: 'nature', value: 23 });
  d({ type: 'evSet', monId: snor, stat: 'hp', value: 252, mode: 'ev' });
  // a second team that breaks its own rules: standard-built, then switched to Champions without converting
  s = d({ type: 'teamCreate', name: 'CHAMPIONS' });
  const t2 = s.result.teamId;
  const a2 = d({ type: 'monAdd', teamId: t2, species: ${PIKACHU} }).result.monId;
  const b2 = d({ type: 'monAdd', teamId: t2, species: ${PIKACHU} }).result.monId;
  d({ type: 'evSet', monId: a2, stat: 'atk', value: 255, mode: 'ev' });
  d({ type: 'ivSet', monId: b2, stat: 'spe', value: 3 });
  d({ type: 'teamRuleset', teamId: t2, ruleset: 'arena-gen3-standard+strict-champions' });
  await E.flush();
  return { t1, t2, pika, zard, snor, a2, b2 };
})()`;

/* ------------------------------------------------------------------------------------------------ the cases */
let server = null;
const lock = { n: 0 };
const ONLY = (process.env.ARENA_CASES || '').split(',').map((x) => x.trim()).filter(Boolean);
process.setMaxListeners(60);                   // tools/headless_cdp.mjs registers one exit hook per browser; this test launches about 17
async function runCase(name, opts, fn) {
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) return;      // ARENA_CASES=records,device  runs only the cases whose name contains one of these
  console.log('-- ' + name);
  try { await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
    if (opts.dpr) await page.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr, mobile: !!opts.mobile });
    if (opts.init) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.init });
    await fn(page);
  }); } catch (e) { ok(false, name + ': the case ran to completion', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
}

try {
  console.log('machine load before the browser: ' + loadPct() + '; reaping leaked browsers');
  spawnSync(process.execPath, [path.join(root, 'tools', 'browser_leak_guard.js'), 'reap'], { stdio: 'inherit', cwd: root });
  server = await startServer();
  console.log('dev server up on ' + PORT + ' (node tools/devserver.mjs, Range-capable)');

  /* ================================================================================ the main flow, on a phone */
  let exportedText = null, exportedProfile = null, teamCode = null, teamViews = null;
  await runCase('main flow, phone 390x844 @2x', { port: CDP, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    const tag = 'M390: ';
    const b = await bootPage(page);
    ok(b.ready && !b.error, tag + 'the page boots (ROM fetched, verified, data decoded)', J(b));
    const caps = await page.eval('JSON.parse(JSON.stringify(__editor.caps))');
    ok(caps.indexedDB && caps.webcrypto && caps.compression, tag + 'the capability probe says IndexedDB, WebCrypto and CompressionStream work here', J(caps));
    ok((await page.eval('document.getElementById("saveState").dataset.state')) === 'saved', tag + 'the save indicator starts at "saved"');
    ok((await page.eval('document.documentElement.lang')) === 'en' && (await exists(page, 'main#app')) && (await exists(page, 'header#top')), tag + 'page landmarks exist (lang, header, main)');
    ok((await page.eval('getComputedStyle(document.getElementById("top")).position')) === 'sticky', tag + 'the header (with the save indicator) is sticky');
    ok((await page.eval(`document.querySelector('.back').getAttribute('href')`)) === '/pokemonarena/', tag + 'the back link goes to the hub');

    // ---- create a profile through the form
    await setVal(page, '[data-fk="new-name"]', 'RED');
    await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 15000 });
    await flush(page);
    ok((await page.eval('__editor.state().profile.trainerName')) === 'RED', tag + 'creating a profile opens it (name RED)');
    ok((await page.eval('__editor.store.listProfiles().then((l) => l.length)')) === 1, tag + 'the profile is in IndexedDB (1 row)');
    // rename through the dialog, then back
    await go(page, '#/profiles');
    await click(page, '[data-profile] [data-act="rename"]');
    await setVal(page, '[data-fk="rename-in"]', 'ASH');
    await click(page, '[data-act="rename-ok"]');
    await page.waitFor('__editor.state().profile.trainerName === "ASH"');
    await flush(page);
    ok(true, tag + 'a profile can be renamed');
    await go(page, '#/profiles');
    await click(page, '[data-profile] [data-act="rename"]');
    await setVal(page, '[data-fk="rename-in"]', 'WAYTOOLONGNAME1');
    await click(page, '[data-act="rename-ok"]');
    ok(/At most 10/.test(await page.eval('document.querySelector(".sheet .field-error").textContent')), tag + 'an over-long name is refused with a message');
    await page.eval('document.querySelector(".sheet header button").click()');
    await setVal(page, '[data-fk="new-name"]', 'A{B');
    await click(page, '[data-act="create"]');
    ok(/Braces/.test(await page.eval('document.querySelector(".field-error").textContent')), tag + 'a name with braces is refused');
    await go(page, '#/profiles'); await click(page, '[data-profile] [data-act="rename"]'); await setVal(page, '[data-fk="rename-in"]', 'RED'); await click(page, '[data-act="rename-ok"]');
    await page.waitFor('__editor.state().profile.trainerName === "RED"');

    // ---- a team of three through the species search
    await go(page, '#/teams');
    await click(page, '[data-act="new-team"]');
    await page.waitFor('__editor.route().name === "team"');
    const teamId = await page.eval('__editor.route().teamId');
    for (const [q1, sp] of [['pikachu', PIKACHU], ['charizard', CHARIZARD], ['snorlax', SNORLAX]]) {
      await click(page, '[data-act="add-mon"]');
      await page.waitFor('!!document.querySelector("[data-fk=sp-q]")');
      await setVal(page, '[data-fk="sp-q"]', q1);
      await sleep(150);
      const rowsFound = await page.eval(`[...document.querySelectorAll('.vrow')].map((r) => Number(r.dataset.species))`);
      ok(rowsFound.includes(sp), tag + `searching "${q1}" lists species ${sp}`, J(rowsFound));
      await click(page, `.vrow[data-species="${sp}"]`);
      await page.waitFor('__editor.route().name === "mon"');
      if (sp !== SNORLAX) await go(page, '#/team/' + teamId);
    }
    const monIds = await page.eval(`__editor.state().profile.teams[0].monIds`);
    ok(monIds.length === 3, tag + 'three Pokemon are on the team');
    // the search by number and by type
    await go(page, '#/team/' + teamId);
    await page.eval(`document.querySelector('[data-act="add-mon"]').focus()`);
    await click(page, '[data-act="add-mon"]'); await page.waitFor('!!document.querySelector("[data-fk=sp-q]")');
    await setVal(page, '[data-fk="sp-q"]', '#6'); await sleep(150);
    ok((await page.eval(`document.querySelector('.vrow') && Number(document.querySelector('.vrow').dataset.species)`)) === 6, tag + 'searching "#6" finds Charizard first');
    await setVal(page, '[data-fk="sp-q"]', 'fire flying'); await sleep(150);
    const ff = await page.eval(`[...document.querySelectorAll('.vrow')].map((r) => Number(r.dataset.species))`);
    ok(ff.length > 0 && ff.includes(6) && ff.every((id) => pack.species[id].types.includes(11) && pack.species[id].types.includes(3) || pack.species[id].name.toLowerCase().includes('fire')), tag + 'searching a pair of types lists only species with both', J(ff.slice(0, 6)));
    // keyboard: Escape closes, focus returns to the button that opened it
    await page.press('Escape', 'Escape', 27);
    await sleep(150);
    ok(!(await exists(page, '.sheet')) && (await page.eval('document.activeElement && document.activeElement.dataset.act')) === 'add-mon', tag + 'Escape closes the picker and puts focus back on the button that opened it');

    // ---- Pikachu: nature, hidden ability, item, moves
    const pika = monIds[0];
    await go(page, `#/team/${teamId}/mon/${pika}`);
    await setVal(page, '[data-fk="nature"]', '3', 'change');
    await page.waitFor('__editor.state().profile.box.find((m) => m.species === 25).nature === 3');
    ok((await page.eval(`document.querySelector('[data-nature-summary]').dataset.natureSummary`)) === 'atk/spa', tag + 'the nature summary names the raised and lowered stat (Adamant: atk up, spa down)');
    await click(page, '[data-slot="2"]');
    await page.waitFor('__editor.state().profile.box.find((m) => m.species === 25).abilitySlot === 2');
    await click(page, '[data-act="pick-item"]');
    await page.waitFor('!!document.querySelector("[data-fk=it-q]")');
    await setVal(page, '[data-fk="it-q"]', 'leftovers'); await sleep(150);
    await click(page, `[data-item="${itemId('Leftovers')}"]`);
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).heldItem === ${itemId('Leftovers')}`);
    const itemText = (await page.eval(`document.querySelector('[data-act="pick-item"]').textContent`)).replace(/\s+/g, ' ');
    ok(itemText.includes('Leftovers') && itemText.includes(pack.items[itemId('Leftovers')].desc.replace(/\s+/g, ' ')), tag + 'the item button shows the name and the ROM description of Leftovers', itemText.slice(0, 120));
    await go(page, `#/team/${teamId}/mon/${pika}/moves`);
    await click(page, '[data-act="pick-move"][data-slot="1"]');
    await page.waitFor('!!document.querySelector("[data-fk=mv-q]")');
    await setVal(page, '[data-fk="mv-q"]', 'thunder'); await sleep(200);
    const thundersRows = await page.eval(`[...document.querySelectorAll('.mvrow')].map((r) => ({ id: Number(r.dataset.move), dis: r.getAttribute('aria-disabled') === 'true', tags: [...r.querySelectorAll('.tag')].map((t) => t.textContent), why: (r.querySelector('.why') || {}).textContent || '' }))`);
    ok(thundersRows.length >= 2 && thundersRows.every((r) => !r.id || pack.moves[r.id].name.toLowerCase().includes('thunder')), tag + 'the move search narrows to "thunder" moves', J(thundersRows.slice(0, 3)));
    const tbRow = thundersRows.find((r) => r.id === moveId('Thunderbolt'));
    ok(tbRow && !tbRow.dis && tbRow.tags.some((t) => /^TM\d\d$/.test(t)), tag + 'Thunderbolt is available and carries its TM tag', J(tbRow));
    const hydro = moveId('Hydro Cannon');
    await setVal(page, '[data-fk="mv-q"]', ''); await setVal(page, '[data-fk="mv-type"]', '12', 'change');
    await page.eval(`document.querySelector('.sheet input[type=checkbox][aria-label="Include moves this Pokemon cannot learn"]').click()`);
    await sleep(250);
    const water = await page.eval(`[...document.querySelectorAll('.mvrow')].map((r) => ({ id: Number(r.dataset.move), dis: r.getAttribute('aria-disabled') === 'true', why: (r.querySelector('.why') || {}).textContent || '' }))`);
    const hc = water.find((r) => r.id === hydro);
    ok(water.length > 0 && water.every((r) => pack.moves[r.id].type === 12), tag + 'the type filter shows only Water moves', J(water.slice(0, 3)));
    ok(!hc || (hc.dis && hc.why === R.RULE_CODES['move.illegal'] || hc.dis && hc.why.startsWith(R.RULE_CODES['move.illegal'])), tag + 'a move Pikachu cannot learn is shown disabled with the rules.js reason text', J(hc));
    await page.screenshot(path.join(OUT, 'main_move_picker_disabled.png'));
    await page.eval(`document.querySelector('.sheet header button').click()`);
    await click(page, '[data-act="pick-move"][data-slot="1"]');
    await page.waitFor('!!document.querySelector("[data-fk=mv-q]")');
    await setVal(page, '[data-fk="mv-q"]', 'thunderbolt'); await sleep(150);
    await click(page, `.mvrow[data-move="${moveId('Thunderbolt')}"]`);
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).moves.length === 2`);

    // ---- Pikachu: stats (typed EV, stepper, slider, IV preset)
    await go(page, `#/team/${teamId}/mon/${pika}/stats`);
    await page.waitFor('!!document.querySelector("[data-fk=ev-atk]")');
    await setVal(page, '[data-fk="ev-atk"]', '252', 'change');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).ev.atk === 252`);
    await click(page, '[data-fk="ev-inc-spd"]');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).ev.spd === 4`);
    await setVal(page, '[data-fk="slider-spe"]', '252', 'input');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).ev.spe === 252`);
    const counter = await page.eval(`document.querySelector('[data-counter="ev"] .num').textContent`);
    ok(counter === '2', tag + 'the remaining counter reads 510 - 252 - 4 - 252 = 2', counter);
    await setVal(page, '[data-fk="ev-hp"]', '200', 'change');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).ev.hp === 2`);
    ok((await page.eval(`document.querySelector('[data-fk="ev-hp"]').value`)) === '2', tag + 'typing 200 into HP with 2 left clamps to 2 and the field shows 2');
    await setVal(page, '[data-fk="ev-hp"]', 'abc', 'change'); await sleep(100);
    ok((await page.eval(`document.querySelector('[data-fk="ev-hp"]').value`)) === '2' && /whole number/.test(await page.eval('document.getElementById("toast").textContent')), tag + 'typing text into an EV field is rejected with a message and the field reverts');
    await click(page, '[data-preset="zeroAtk"]');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).iv.atk === 0`);
    ok((await page.eval(`document.querySelector('[data-fk="iv-atk"]').value`)) === '0', tag + 'the IV preset "0 Attack" shows in the IV field');
    // points view is linked
    await page.eval(`[...document.querySelectorAll('.seg[aria-label="Effort view"] button')].find((b) => b.dataset.v === 'points').click()`);
    await sleep(200);
    ok((await page.eval(`document.querySelector('[data-fk="pts-atk"]').value`)) === '31' && (await page.eval(`document.querySelector('[data-fk="pts-spe"]').value`)) === '32', tag + 'the points view reads 252 EV as 32 points at IV 31 and as 31 points at IV 0 (the even-IV parity; the two views are linked)');
    await setVal(page, '[data-fk="pts-def"]', '10', 'change');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 25).ev.def === 0`, { timeoutMs: 3000 }).catch(() => {});
    const defEv = await page.eval(`__editor.state().profile.box.find((m) => m.species === 25).ev.def`);
    ok(defEv === 0 || defEv === ST.pointsToEv(Math.min(10, ST.evToPoints(defEv, 31)), 31), tag + 'a points edit that does not fit the 510 cap is limited, not applied blindly', String(defEv));
    await page.eval(`[...document.querySelectorAll('.seg[aria-label="Effort view"] button')].find((b) => b.dataset.v === 'ev').click()`);
    await sleep(150);

    // ---- on-screen stats vs rules.js in Node; stat bars vs Node's render of the same ROM
    const pikaRec = await page.eval(`JSON.parse(JSON.stringify(__editor.state().profile.box.find((m) => m.species === 25)))`);
    const want = R.battleStats(P.toRulesRec(pikaRec, R.DEFAULT_RULESET_ID), pack, R.DEFAULT_RULESET_ID);
    const shown = await page.eval(`Object.fromEntries([...document.querySelectorAll('.val[data-stat]')].map((e) => [e.dataset.stat, Number(e.textContent)]))`);
    ok(canon(shown) === canon(want), tag + 'the six derived stats on screen equal rules.battleStats in Node', canon(shown) + ' vs ' + canon(want));
    const barNode = art.statBar(want.atk, Math.floor(1.1 * (Math.floor(((2 * 150 + 31 + 63) * 50) / 100) + 5)));
    const barHashPage = await canvasHash(page, '[data-row="atk"] .barwrap canvas');
    ok(barHashPage === sha(barNode.rgba), tag + 'the Attack bar on screen is the ROM HP-bar tile art, pixel for pixel what Node renders', barHashPage + ' vs ' + sha(barNode.rgba));
    const badRom = rom.slice(); for (const off of [0x7202e0, 0x7208c0, 0x7209e0]) badRom.fill(0xff, off, off + 0x200);
    const barBad = A.createArtKit(badRom).statBar(want.atk, Math.floor(1.1 * (Math.floor(((2 * 150 + 31 + 63) * 50) / 100) + 5)));
    ok(sha(barNode.rgba) !== sha(barBad.rgba), tag + 'control: a ROM with damaged HP-bar tiles renders a different bar (so the comparison above can fail)');
    ok((await page.eval(`document.querySelector('[data-row="atk"]').className`)).includes('up') && (await page.eval(`document.querySelector('[data-row="spa"]').className`)).includes('down'), tag + 'under Adamant the Attack row is highlighted as raised and Sp. Atk as lowered');
    await page.screenshot(path.join(OUT, 'main_390_stats.png'));

    // ---- Charizard and Snorlax
    const zard = monIds[1], snor = monIds[2];
    await go(page, `#/team/${teamId}/mon/${zard}`);
    await setVal(page, '[data-fk="nature"]', '10', 'change');
    await go(page, `#/team/${teamId}/mon/${zard}/moves`);
    await click(page, '[data-act="pick-move"][data-slot="1"]'); await page.waitFor('!!document.querySelector("[data-fk=mv-q]")');
    await setVal(page, '[data-fk="mv-q"]', 'flamethrower'); await sleep(150);
    await click(page, `.mvrow[data-move="${moveId('Flamethrower')}"]`);
    await go(page, `#/team/${teamId}/mon/${zard}/stats`);
    await page.eval(`document.querySelector('[data-fk="hp-type"]').value = 'Ice'; document.querySelector('[data-fk="hp-type"]').dispatchEvent(new Event('change', { bubbles: true }))`);
    await page.waitFor(`document.querySelector('[data-hidden-power]') && document.querySelector('[data-hidden-power]').dataset.hiddenPower === 'Ice'`);
    await go(page, `#/team/${teamId}/mon/${snor}`);
    await setVal(page, '[data-fk="nature"]', '23', 'change');
    await go(page, `#/team/${teamId}/mon/${snor}/stats`);
    await setVal(page, '[data-fk="ev-hp"]', '252', 'change');
    await page.waitFor(`__editor.state().profile.box.find((m) => m.species === 143).ev.hp === 252`);

    // ---- the autosave indicator: saving, then saved
    await setVal(page, '[data-fk="ev-def"]', '40', 'change');
    const sv0 = await page.eval('document.getElementById("saveState").dataset.state');
    ok(sv0 === 'saving', tag + 'right after an edit the indicator says Saving', sv0);
    await page.waitFor('document.getElementById("saveState").dataset.state === "saved"', { timeoutMs: 8000 });
    ok((await page.eval('document.getElementById("saveText").textContent')) === 'Saved', tag + 'then it says Saved');
    // undo / redo from the keyboard
    const evBefore = await page.eval(`__editor.state().profile.box.find((m) => m.species === 143).ev.def`);
    await page.eval('document.activeElement && document.activeElement.blur()');
    await keyCombo(page, 'z', 'KeyZ', 90, 2);
    await sleep(150);
    ok((await page.eval(`__editor.state().profile.box.find((m) => m.species === 143).ev.def`)) === 0 && evBefore === 40, tag + 'Ctrl+Z undoes the last EV edit (40 -> 0)');
    await keyCombo(page, 'y', 'KeyY', 89, 2);
    await sleep(150);
    ok((await page.eval(`__editor.state().profile.box.find((m) => m.species === 143).ev.def`)) === 40, tag + 'Ctrl+Y redoes it');
    await flush(page);
    await page.waitFor('document.getElementById("saveState").dataset.state === "saved"', { timeoutMs: 8000 });

    // ---- the whole thing survives a RELOAD (real IndexedDB)
    const before = await profileOf(page);
    exportedProfile = before;
    const b2 = await bootPage(page);
    ok(b2.ready && !b2.error, tag + 'reload: the page boots again');
    const after = await profileOf(page);
    ok(content(after) === content(before), tag + 'RELOAD: the whole profile (teams, mons, natures, moves, EVs, IVs, items) comes back identical from IndexedDB', 'differs at ' + [...canon(content(after))].findIndex((c, i) => c !== canon(content(before))[i]));
    const corrupted = JSON.parse(JSON.stringify(after)); corrupted.box[0].nature = (corrupted.box[0].nature + 1) % 25;
    ok(content(corrupted) !== content(before), tag + 'control: the comparison notices a single changed nature (so the reload check can fail)');
    ok((await page.eval('__editor.route().name')) === 'teams', tag + 'reload: the active profile was remembered and its teams are shown');
    // read persisted values back from the SCREEN
    await go(page, `#/team/${teamId}/mon/${pika}`);
    ok((await page.eval(`document.querySelector('[data-fk="nature"]').value`)) === '3' && (await page.eval(`document.querySelector('[data-slot="2"]').getAttribute('aria-checked')`)) === 'true' && /Leftovers/.test(await page.eval(`document.querySelector('[data-act="pick-item"]').textContent`)), tag + 'reload: the editor shows Adamant, the hidden ability and Leftovers');
    await go(page, `#/team/${teamId}/mon/${pika}/moves`);
    ok((await page.eval(`[...document.querySelectorAll('[data-move-slot]')].map((e) => Number(e.dataset.move))`)).includes(moveId('Thunderbolt')), tag + 'reload: Thunderbolt is still in the move list');
    await go(page, `#/team/${teamId}/mon/${pika}/stats`);
    ok((await page.eval(`document.querySelector('[data-fk="ev-atk"]').value`)) === '252' && (await page.eval(`document.querySelector('[data-fk="ev-spe"]').value`)) === '252' && (await page.eval(`document.querySelector('[data-fk="iv-atk"]').value`)) === '0', tag + 'reload: the EV and IV fields show 252 / 252 / IV 0');
    const shown2 = await page.eval(`Object.fromEntries([...document.querySelectorAll('.val[data-stat]')].map((e) => [e.dataset.stat, Number(e.textContent)]))`);
    ok(canon(shown2) === canon(want), tag + 'reload: the derived stats are unchanged');
    // sprite animation: the header sprite alternates between the ROM's two frames
    await go(page, `#/team/${teamId}/mon/${pika}`);
    const h1 = await canvasHash(page, '.monhead canvas.rom'); await sleep(1400); const h2 = await canvasHash(page, '.monhead canvas.rom'); await sleep(700); const h3 = await canvasHash(page, '.monhead canvas.rom');
    ok(new Set([h1, h2, h3]).size === 2, tag + 'the front sprite alternates between two different frames over 2 seconds', [h1, h2, h3].join(' '));
    const spr = art.frontSprite(PIKACHU);
    ok(spr.frames.length === 2 && [h1, h2, h3].every((h) => h === sha(spr.frames[0].rgba) || h === sha(spr.frames[1].rgba)), tag + 'the sprite frames on screen are exactly the two frames Node decodes from the ROM', [h1, h2, h3, sha(spr.frames[0].rgba), sha(spr.frames[1].rgba)].join(' '));

    // ---- the team screen: validation, code, test battle
    await go(page, '#/team/' + teamId);
    ok((await page.eval(`document.querySelector('[data-team-validation]').dataset.teamValidation`)) === 'ok', tag + 'the finished team passes its rules (the validation summary says so)');
    await page.waitFor('document.querySelector("[data-team-code]").dataset.teamCode === "1"', { timeoutMs: 8000 });
    teamCode = await page.eval(`document.querySelector('[data-team-code]').value`);
    ok(/^ARENA1\.[A-Za-z0-9_-]+\.[0-9a-f]{4}$/.test(teamCode), tag + 'the team code has the ARENA1.<payload>.<check> shape', teamCode.slice(0, 40));
    const dec = await T.decodeTeamCode(teamCode);
    const profileNow = await profileOf(page);
    const inNode = T.teamFromProfile(profileNow, teamId).mons.map(T.battleView);
    ok(dec.ok && canon(dec.team.mons) === canon(inNode), tag + 'Node decodes the code to the same three Pokemon the editor holds', dec.ok ? '' : J(dec));
    teamViews = inNode;
    await click(page, '[data-act="copy-code"]');
    await sleep(200);
    ok(/copied|selected/.test(await page.eval('document.getElementById("toast").textContent')), tag + 'Copy code answers with a toast (copied, or "selected: copy it by hand")');
    const href = await page.eval(`document.querySelector('[data-act="test-battle"]').getAttribute('href')`);
    const parsed = L.parseBattleUrl(href);
    ok(parsed.path === '/pokemonarena/battle.html' && parsed.team === teamCode && parsed.foe === 'random' && Number.isInteger(parsed.seed) && parsed.seed >= 0 && parsed.seed <= 0xffffffff && parsed.format === '3v3' && ['easy', 'normal', 'hard'].includes(parsed.cpu), tag + 'Test battle opens battle.html?team=<code>&foe=random&seed=<u32>&format=3v3&cpu=...', href.slice(0, 120));
    ok(href.indexOf('team=ARENA1.') > 0 && !href.includes(' ') && /^[\x21-\x7e]+$/.test(href), tag + 'the link is plain printable ASCII');
    await page.screenshot(path.join(OUT, 'main_390_team.png'));

    // ---- the second team in this profile: test vs my other team
    await go(page, '#/teams');
    await click(page, '[data-act="new-team"]'); await page.waitFor('__editor.route().name === "team"');
    const team2 = await page.eval('__editor.route().teamId');
    await click(page, '[data-act="add-mon"]'); await page.waitFor('!!document.querySelector("[data-fk=sp-q]")'); await setVal(page, '[data-fk="sp-q"]', 'blastoise'); await sleep(150);
    await click(page, '.vrow'); await page.waitFor('__editor.route().name === "mon"');
    await go(page, '#/team/' + team2);
    await page.waitFor('document.querySelector("[data-team-code]").dataset.teamCode === "1"', { timeoutMs: 8000 });
    await page.eval(`(() => { const s = document.querySelector('select[aria-label="Opponent team"]'); s.value = ${J(teamId)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(300);
    await page.eval('__editor.actions.openUrl = (u) => { window.__opened = u; }');
    await click(page, '[data-act="test-vs-other"]');
    await page.waitFor('!!window.__opened', { timeoutMs: 5000 });
    const opened = L.parseBattleUrl(await page.eval('window.__opened'));
    ok(opened.team !== teamCode && opened.foe === teamCode && L.isTeamCode(opened.team) && opened.format === '6v6', tag + '"Test vs my other team" puts this team in ?team= and the other team\'s code in &foe=, on 6v6 (W1: this team has ONE Pokemon and battle.html refuses 3v3 under three; it used to say 3v3 here)', J({ foeIsCode: opened.foe === teamCode }));
    ok((await page.eval(`document.querySelector('[data-act="test-vs-other"]').getAttribute('href')`)) === await page.eval('window.__opened'), tag + 'the same link is on the button');

    // ---- export, delete, import back
    await go(page, '#/profiles');
    await click(page, '[data-profile] [data-act="export"]');
    await sleep(500);
    const le = await page.eval('JSON.parse(JSON.stringify(__editor.lastExport || null))');
    ok(le && /^pokemonarena-RED-\d{8}\.pokemonarena\.json$/.test(le.name) && le.size > 1000 && /pokemonarena-profile/.test(le.head), tag + 'Export names the file pokemonarena-RED-<date>.pokemonarena.json and writes the export format', J(le));
    const text = await page.eval(`(async () => { const P = await import('/pokemonarena/js/profile.js'); const r = await __editor.store.loadProfile(__editor.state().profile.id); const out = await P.exportBytes(r.profile, { gzip: false }); let s = ''; for (const b of out.bytes) s += String.fromCharCode(b); return btoa(s); })()`);
    exportedText = Buffer.from(text, 'base64');
    const exportFile = path.join(TMP, 'RED.pokemonarena.json'); fs.writeFileSync(exportFile, exportedText);
    const parsedExport = await P.parseExport(exportedText, { pack });
    ok(parsedExport.ok && parsedExport.checksum === 'ok' && parsedExport.rules.ok, tag + 'Node accepts the exported file (checksum ok, every team legal)', J(parsedExport).slice(0, 160));
    const idBefore = await page.eval('__editor.state().profile.id');
    exportedProfile = await profileOf(page);   // exactly what the export above contains
    await click(page, '[data-profile] [data-act="delete"]');
    await page.waitFor('!!document.querySelector(".sheet")');
    await clickText(page, '.sheet footer button', 'Delete profile');
    await page.waitFor('document.querySelectorAll("[data-profile]").length === 0', { timeoutMs: 8000 });
    ok((await page.eval('__editor.store.listProfiles().then((l) => l.length)')) === 0 && !(await page.eval('!!__editor.state()')), tag + 'deleting the profile removes it from IndexedDB and from the screen');
    await fileInput(page, exportFile);
    await page.waitFor('!!document.querySelector("[data-import-preview]")', { timeoutMs: 8000 });
    ok(/Ready to import "RED"/.test(await page.eval('document.querySelector("[data-import-preview] h3").textContent')) && /2 teams, 4 Pokemon/.test(await page.eval('document.querySelector("[data-import-preview] p").textContent')), tag + 'the import preview names the profile and counts 2 teams and 4 Pokemon');
    ok(/Its battle record is empty./.test(await page.eval('document.querySelector("[data-import-record]").textContent')) && (await page.eval('document.querySelector("[data-import-record]").dataset.importRecord')) === 'new', tag + 'ST1: the import preview says what happens with the battle record (as a new profile: the record in the file comes along; this one is empty)');
    await click(page, '[data-act="import-apply"]');
    await page.waitFor('__editor.route().name === "teams" && !!__editor.state()', { timeoutMs: 8000 });
    await flush(page);
    const back = await profileOf(page);
    ok(content(back) === content(exportedProfile), tag + 'IMPORT: the profile that comes back equals the one exported (every Pokemon, team and setting)', '');
    ok(back.id !== idBefore, tag + 'an imported-as-new profile gets a fresh id');

    // ---- a second profile imports the team code
    await go(page, '#/profiles');
    await setVal(page, '[data-fk="new-name"]', 'BLUE'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams" && __editor.state().profile.trainerName === "BLUE"');
    await click(page, '[data-act="import-code"]');
    await page.waitFor('!!document.querySelector("[data-fk=code-in]")');
    await setVal(page, '[data-fk="code-in"]', 'ARENA1.notacode.0000');
    await sleep(500);
    ok(await exists(page, '[data-code-error]'), tag + 'a garbage code shows an error and no Add button works', await page.eval('(document.querySelector("[data-code-error]") || {}).textContent'));
    ok((await page.eval(`document.querySelector('[data-act="code-add"]').disabled`)) === true, tag + 'the Add button stays disabled for a bad code');
    await setVal(page, '[data-fk="code-in"]', teamCode.slice(0, -1) + (teamCode.slice(-1) === '0' ? '1' : '0'));
    await sleep(500);
    ok((await page.eval('(document.querySelector("[data-code-error]") || {}).dataset && document.querySelector("[data-code-error]").dataset.codeError')) === 'code.crc', tag + 'a code with one mistyped check character is reported as a check-value error (code.crc)');
    await setVal(page, '[data-fk="code-in"]', '  ' + teamCode.slice(0, 20) + '\n' + teamCode.slice(20) + '  ');
    await page.waitFor('!!document.querySelector("[data-code-preview]")', { timeoutMs: 8000 });
    await click(page, '[data-act="code-add"]');
    await page.waitFor('__editor.route().name === "team"');
    const bluePro = await profileOf(page);
    const imported = bluePro.teams[0].monIds.map((id) => bluePro.box.find((m) => m.id === id)).map(T.battleView);
    ok(canon(imported) === canon(teamViews), tag + 'the pasted code (with stray whitespace) becomes a team of the same three Pokemon in the second profile');
    ok(bluePro.teams[0].name === 'TEAM 1' || bluePro.teams[0].name.length > 0, tag + 'the imported team has a name');
    await flush(page);

    // ---- hostile import files
    await go(page, '#/profiles');
    const countBefore = await page.eval('__editor.store.listProfiles().then((l) => l.length)');
    const mk = (name, bytes) => { const f = path.join(TMP, name); fs.writeFileSync(f, bytes); return f; };
    const exportObj = JSON.parse(exportedText.toString('utf8'));
    const badChecksum = JSON.parse(JSON.stringify(exportObj)); badChecksum.profile.trainerName = 'HACKED';
    const otherRom = JSON.parse(JSON.stringify(exportObj)); otherRom.profile.romSha256 = 'f'.repeat(64); otherRom.romSha256 = 'f'.repeat(64); otherRom.checksum = P.buildExport(otherRom.profile, { deps: { now: () => 1 } }).checksum;
    const pollution = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},"format":"nope"}';
    const pollution2 = '{"format":"pokemonarena-profile","exportVersion":1,"profile":{"__proto__":{"polluted3":"yes"},"constructor":{"prototype":{"polluted4":"yes"}},"app":"pokemonarena","schemaVersion":2},"checksum":"sha256:00"}';
    const withKey = JSON.parse(JSON.stringify(exportObj)); withKey.profile.identity.publicKeyJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), d: 'C'.repeat(43) };
    const hostile = [
      ['import.too-large', mk('huge.pokemonarena.json', Buffer.alloc(9 * 1024 * 1024, 0x7b)), 'a 9 MB file'],
      ['import.checksum', mk('edited.pokemonarena.json', JSON.stringify(badChecksum)), 'a file edited after export (wrong checksum)'],
      ['import.rom-mismatch', mk('otherrom.pokemonarena.json', JSON.stringify(otherRom)), 'a profile built for another ROM (valid checksum)'],
      ['import.private-key', mk('key.pokemonarena.json', JSON.stringify(withKey)), 'a file carrying a private key'],
      ['import.corrupt', mk('cut.pokemonarena.json', exportedText.subarray(0, 700)), 'a truncated file'],
      ['import.not-an-export', mk('proto.pokemonarena.json', pollution), 'a prototype-pollution JSON'],
      ['import.checksum', mk('proto2.pokemonarena.json', pollution2), 'a prototype-pollution JSON inside a well-formed envelope'],
      ['import.not-an-export', mk('array.pokemonarena.json', '[1,2,3]'), 'a JSON array'],
      ['import.empty', mk('empty.pokemonarena.json', ''), 'an empty file'],
    ];
    for (const [code, file, label] of hostile) {
      await fileInput(page, file);
      await page.waitFor('!!document.querySelector("[data-import-error]") || !!document.querySelector("[data-import-preview]")', { timeoutMs: 10000 });
      const got = await page.eval('document.querySelector("[data-import-error]") ? document.querySelector("[data-import-error]").dataset.importError : "PREVIEW"');
      const msg = await page.eval('document.querySelector("[data-import-error]") ? document.querySelector("[data-import-error]").textContent : ""');
      ok(got === code && msg.length > 20, tag + `hostile import (${label}) is refused with ${code} and a message`, got + ' ' + msg.slice(0, 120));
      await page.eval('document.querySelector("[data-import-error]") && (document.querySelector("[data-import-error]").remove())');
    }
    ok((await page.eval('({}).polluted === undefined && ({}).polluted2 === undefined && ({}).polluted3 === undefined && ({}).polluted4 === undefined && Object.prototype.polluted === undefined')), tag + 'no hostile file polluted Object.prototype');
    ok((await page.eval('__editor.store.listProfiles().then((l) => l.length)')) === countBefore, tag + 'no hostile file changed what is stored');
    // the twin: the unmodified export still imports (so the refusals above are about the files, not the importer)
    await fileInput(page, exportFile);
    await page.waitFor('!!document.querySelector("[data-import-preview]")', { timeoutMs: 8000 });
    ok(true, tag + 'twin: the untouched export is accepted by the same importer');
    const anywayFile = mk('edited2.pokemonarena.json', JSON.stringify(badChecksum));
    await fileInput(page, anywayFile);
    await page.waitFor('!!document.querySelector("[data-import-error]")');
    await click(page, '[data-act="import-anyway"]');
    await page.waitFor('!!document.querySelector("[data-import-preview]")', { timeoutMs: 8000 });
    ok(/OVERRIDDEN/.test(await page.eval('document.querySelector("[data-import-preview] p").textContent')), tag + 'a checksum mismatch can be imported only through an explicit "Import anyway", and the preview says the checksum was overridden');

    // ---- identity
    await page.eval('document.querySelector("[data-import-preview] .btn:not(.primary)").click()');
    const idSt = await page.eval('document.querySelector("[data-identity]").dataset.identity');
    ok(idSt === 'none', tag + 'a new profile has no identity key yet', idSt);
    ok((await page.eval('!!document.querySelector("[data-key-loss]")')) && /lose this identity/.test(await page.eval('document.querySelector("[data-key-loss]").textContent')), tag + 'the key-loss warning is shown');
    await click(page, '[data-act="identity-create"]');
    await page.waitFor('document.querySelector("[data-identity]").dataset.identity === "ok"', { timeoutMs: 8000 });
    const fpr = await page.eval('document.querySelector("[data-fingerprint]").dataset.fingerprint');
    ok(/^[0-9a-f]{16,}$/i.test(fpr) || fpr.length >= 8, tag + 'creating an identity shows its public-key fingerprint', fpr);
    await flush(page);
    const pk = await page.eval('JSON.stringify(__editor.state().profile.identity.publicKeyJwk)');
    ok(!/"d":/.test(pk) && /"kty":"EC"/.test(pk), tag + 'only the PUBLIC key is in the profile document');

    // ---- delete everything
    await click(page, '[data-act="delete-all"]');
    await page.waitFor('!!document.querySelector(".sheet")');
    const okBtn = await page.eval(`[...document.querySelectorAll('.sheet footer button')].find((b) => b.textContent === 'Delete everything').disabled`);
    ok(okBtn === true, tag + 'Delete everything stays disabled until DELETE is typed');
    await setVal(page, '.sheet [data-fk="confirm-text"]', 'DELETE');
    await clickText(page, '.sheet footer button', 'Delete everything');
    await page.waitFor('document.querySelectorAll("[data-profile]").length === 0', { timeoutMs: 8000 });
    const left = await page.eval(`(async () => { const s = await __editor.store.listProfiles(); const q = await __editor.store.listQuarantine(); return [s.length, q.length, await __editor.store.getActiveId()]; })()`);
    ok(left[0] === 0 && left[1] === 0 && left[2] === null, tag + 'Delete everything leaves no profile, no quarantine and no active-profile pointer', J(left));
    await page.screenshot(path.join(OUT, 'main_390_after_delete_all.png'));
    const errs = errsOf(page);
    ok(errs.length === 0, tag + 'no page errors or console errors during the whole main flow', errs.slice(0, 3).join(' | '));
  });

  /* ================================================================================ IndexedDB blocked */
  await runCase('IndexedDB blocked', { port: CDP + 1, width: 390, height: 844, mobile: true, dpr: 2, init: "Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked by test', 'SecurityError'); }, configurable: true });" }, async (page) => {
    const tag = 'IDB-blocked: ';
    const b = await bootPage(page);
    ok(b.ready && !b.error, tag + 'the page still boots', J(b));
    const caps = await page.eval('JSON.parse(JSON.stringify(__editor.caps))');
    ok(caps.indexedDB === false && caps.reasons.some((r) => /IndexedDB/.test(r)), tag + 'the capability probe reports IndexedDB as unavailable', J(caps));
    ok((await page.eval('document.getElementById("saveState").dataset.state')) === 'notsaved' && (await page.eval('document.getElementById("saveText").textContent')) === 'NOT SAVED', tag + 'the sticky indicator says NOT SAVED from the start');
    ok(/NOT SAVED/.test(await page.eval('document.getElementById("banners").textContent')) && /Export/.test(await page.eval('document.getElementById("banners").textContent')), tag + 'a banner explains that nothing is kept and points at Export');
    await setVal(page, '[data-fk="new-name"]', 'MEM'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 10000 });
    await click(page, '[data-act="new-team"]'); await page.waitFor('__editor.route().name === "team"');
    await page.eval(`document.querySelector('[data-act="add-mon"]').focus()`);
    await pressEnter(page);
    await page.waitFor('!!document.querySelector("[data-fk=sp-q]")');
    ok((await page.eval(`(() => { const s = document.querySelector('.sheet'); return s.getAttribute('role') === 'dialog' && s.getAttribute('aria-modal') === 'true' && document.activeElement === document.querySelector('[data-fk=sp-q]'); })()`)), tag + 'Enter on the Add button opens a modal dialog and focuses its search box (keyboard only)');
    for (let i = 0; i < 14; i++) await page.press('Tab', 'Tab', 9, 20);
    ok(await page.eval(`document.querySelector('.sheet').contains(document.activeElement)`), tag + 'after 14 Tab presses focus is still inside the dialog (focus trap)');
    await page.eval(`document.querySelector('[data-fk=sp-q]').focus()`);
    await setVal(page, '[data-fk="sp-q"]', 'eevee'); await sleep(150);
    await page.press('ArrowDown', 'ArrowDown', 40);
    ok((await page.eval(`document.activeElement && document.activeElement.classList.contains('vrow')`)), tag + 'ArrowDown moves from the search box to the first result');
    await pressEnter(page);
    await page.waitFor('__editor.route().name === "mon"');
    ok((await page.eval('__editor.state().profile.box.length')) === 1 && (await page.eval('__editor.state().profile.box[0].species')) === 133, tag + 'Enter on the focused result picks Eevee: editing works in memory-only mode, by keyboard alone');
    await sleep(600);
    ok((await page.eval('document.getElementById("saveState").dataset.state')) === 'notsaved', tag + 'the indicator stays NOT SAVED after edits (it does not flip back to Saved)');
    await page.screenshot(path.join(OUT, 'idb_blocked_390.png'));
    await bootPage(page);
    ok((await page.eval('__editor.profiles().length')) === 0 && (await page.eval('__editor.route().name')) === 'profiles', tag + 'CONTROL: after a reload the memory-only profile is GONE (a persistence check against a real store can fail)');
  });

  /* ================================================================================ a second writer */
  // THE COMPARE-AND-SWAP SCENARIO, shared by the case below and its negative control (a copy of the page without the F67 fix, further down). Another tab (a second store instance) saves a newer
  // revision of the profile AND records an ONLINE battle in it; this tab, still holding the revision it loaded, edits a team, meets the conflict banner and presses "Keep my edits here".
  // -> what the page showed, and what the store and this tab hold afterwards. The Team Builder never edits a record, so the stored one must come through that save untouched.
  const CAS_MATCH = `{ id: 'cas-online-1', at: 1800000000000, fmt: '3v3', cpu: 'online', opp: 'Zed', ruleset: 'arena-gen3-standard', result: 'w', turns: 9, playMs: 50000, mvp: 25, team: [25, 6, 9], species: [25, 6], moves: [[85, 3], [33, 2]], me: { kos: 2, faints: 1, dealt: 300, taken: 200, hits: 5, crits: 1, superEffective: 2, resisted: 1, noEffect: 0, misses: 1, statusInflicted: 1, healed: 20, switches: 1, koStreak: 2, biggestHit: { sp: 25, mv: 85, dmg: 120, pct: 70, vs: 6 } }, foeFaints: 3 }`;
  const CAS_READ = `(async () => { const r = await __editor.store.loadProfile(__editor.state().profile.id); const s = r.profile.stats, o = s.byCpu.online, t = __editor.state().profile.stats; return { monIds: r.profile.teams[0].monIds.length, online: o.w + o.l + o.dr + o.f, wins: s.wins, recent: s.recent.map((x) => x.id), tabOnline: t.byCpu.online.w + t.byCpu.online.l + t.byCpu.online.dr + t.byCpu.online.f, tabRecent: t.recent.map((x) => x.id) }; })()`;
  const casKeepMine = async (page, url) => {
    await bootPage(page, url);
    await page.eval(SEED);
    await page.eval(`(async () => { const S = await import('/pokemonarena/js/store.js'); const other = await S.openStore({ channel: false }); const id = __editor.state().profile.id; const r = await other.loadProfile(id); const p = r.profile; p.trainerName = 'OTHER'; await other.saveProfile(p, { reason: 'other tab' }); await other.recordMatch(id, ${CAS_MATCH}); await other.close(); return true; })()`);
    const teamId = await page.eval('__editor.state().profile.teams[0].id');
    await go(page, '#/team/' + teamId);
    await click(page, '[data-act="mon-copy"]');
    await page.waitFor('document.getElementById("saveState").dataset.state === "conflict"', { timeoutMs: 8000 });
    const out = { banner: await page.eval('document.getElementById("banners").textContent'), onScreen: await page.eval('__editor.state().profile.teams[0].monIds.length') };
    await click(page, '#banners .btn.danger');
    await page.waitFor('document.getElementById("saveState").dataset.state === "saved"', { timeoutMs: 8000 });
    out.after = await page.eval(CAS_READ);
    return out;
  };
  await runCase('second writer (compare-and-swap)', { port: CDP + 2, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    const tag = 'CAS: ';
    const cas = await casKeepMine(page);
    ok(/changed in another tab/.test(cas.banner), tag + 'saving over another writer is refused and the banner says the profile changed in another tab');
    ok(cas.onScreen === 4, tag + 'the player\'s own edit is still on screen (nothing was thrown away)');
    ok(cas.after.monIds === 4, tag + '"Keep my edits here" saves this tab\'s version over the other one', String(cas.after.monIds));
    ok(cas.after.online === 1 && cas.after.wins === 1 && cas.after.recent.join() === 'cas-online-1' && cas.after.tabOnline === 1 && cas.after.tabRecent.join() === 'cas-online-1', tag + '"Keep my edits here" also keeps the ONLINE battle the other tab recorded in the meantime (the stored record and this tab\'s both still hold it: the team save carries the record that is stored now, not the one this tab loaded)', J(cas.after));
    await page.eval(`(async () => { const S = await import('/pokemonarena/js/store.js'); const other = await S.openStore({ channel: false }); const id = __editor.state().profile.id; const r = await other.loadProfile(id); const p = r.profile; p.trainerName = 'THIRD'; await other.saveProfile(p, { reason: 'third' }); await other.close(); return true; })()`);
    await click(page, '[data-act="mon-copy"]');
    await page.waitFor('document.getElementById("saveState").dataset.state === "conflict"', { timeoutMs: 8000 });
    await click(page, '#banners .btn:not(.danger)');
    await page.waitFor('document.getElementById("saveState").dataset.state === "saved" && __editor.state().profile.trainerName === "THIRD"', { timeoutMs: 8000 });
    ok(true, tag + '"Use the other tab\'s version" reloads it (name THIRD)');
  });

  /* ================================================================================ missing ROM */
  await runCase('ROM missing', { port: CDP + 3, width: 390, height: 844, mobile: true, dpr: 2, init: "Object.defineProperty(window, 'ASSET_BASE', { value: '/nowhere', writable: false, configurable: false });" }, async (page) => {
    const tag = 'E-missing: ';
    await page.navigate(PAGE);
    await page.waitFor('window.__editor && window.__editor.error', { timeoutMs: 30000 });
    const vis = await page.eval(`({ err: !document.getElementById('error').hidden, view: !document.getElementById('view').hidden, title: document.getElementById('errTitle').textContent, msg: document.getElementById('errMsg').textContent, text: document.getElementById('error').innerText, tech: document.getElementById('errDetail').title, save: getComputedStyle(document.getElementById('saveState')).display, buttons: [...document.querySelectorAll('#error button, #error a')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim()), sw: document.documentElement.scrollWidth, iw: innerWidth })`);
    ok(vis.err && !vis.view && /could not be loaded/.test(vis.title) && /404/.test(vis.msg), tag + 'a missing ROM shows the shared error screen saying what failed in plain words (HTTP 404)', J(vis).slice(0, 200));
    ok(!/nowhere|gbaWasm|\.gba|\/roms\//.test(vis.text) && /nowhere/.test(vis.tech), tag + 'no server path on the screen (it is in the detail line\'s hover text)', vis.text.slice(0, 120));
    ok(vis.save === 'none', tag + 'the green "Saved" badge is not shown on the error screen (the editor header carries no stale status)', vis.save);
    ok(vis.buttons.join('|') === 'Try again|Back to the Arena', tag + 'the buttons are Try again and Back to the Arena, as on the battle page', vis.buttons.join('|'));
    ok(vis.sw <= vis.iw, tag + 'the error screen does not scroll sideways');
    ok((await page.eval(`(() => { const r = document.getElementById('retry').getBoundingClientRect(); return r.height >= 44 && r.width >= 44; })()`)), tag + 'Try again is a 44 px target');
    await page.screenshot(path.join(OUT, 'error_missing_390.png'));
  });

  /* ================================================================================ WebCrypto missing */
  await runCase('WebCrypto missing', { port: CDP + 7, width: 390, height: 844, mobile: true, dpr: 2, init: "Object.defineProperty(window.crypto, 'subtle', { get() { return undefined; }, configurable: true });" }, async (page) => {
    const tag = 'NoCrypto: ';
    const b = await bootPage(page);
    ok(b.ready && !b.error, tag + 'the page boots without WebCrypto (the ROM hash falls back to the page\'s own SHA-256)', J(b));
    const caps = await page.eval('JSON.parse(JSON.stringify(__editor.caps))');
    ok(caps.webcrypto === false && caps.indexedDB === true && caps.reasons.some((r) => /WebCrypto/.test(r)), tag + 'the capability probe reports WebCrypto as unavailable and IndexedDB as fine', J(caps));
    ok(/WebCrypto/.test(await page.eval('document.getElementById("banners").textContent')), tag + 'a banner says WebCrypto is missing and identity keys are off');
    await setVal(page, '[data-fk="new-name"]', 'NOKEY'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 15000 });
    await flush(page);
    ok((await page.eval('document.getElementById("saveState").dataset.state')) === 'saved', tag + 'profiles still save to IndexedDB');
    await go(page, '#/profiles');
    ok(/no WebCrypto|WebCrypto/.test(await page.eval('document.querySelector("[data-identity]").textContent')) && !(await exists(page, '[data-act="identity-create"]')), tag + 'the identity card explains the limit and offers no Create button');
  });

  /* ================================================================================ 16 teams of 6 */
  await runCase('16 teams of 6', { port: CDP + 8, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    const tag = 'Full: ';
    await bootPage(page);
    const r = await page.eval(`(async () => {
      const E = window.__editor;
      await E.actions.createProfile('BIG');
      const sp = E.pack.roster.slice(0, 400);
      let errors = 0;
      for (let t = 0; t < 16; t++) {
        const s = E.dispatch({ type: 'teamCreate' });
        const tid = s.result.teamId;
        for (let m = 0; m < 6; m++) { const x = E.dispatch({ type: 'monAdd', teamId: tid, species: sp[(t * 6 + m) * 3 % sp.length] }); if (x.error) errors++; }
      }
      const rej = E.dispatch({ type: 'teamCreate' });
      E.navigate({ name: 'teams' });
      await new Promise((r) => setTimeout(r, 300));
      const t0 = performance.now(); E.render(); const t1 = performance.now();
      await E.flush();
      return { teams: E.state().profile.teams.length, mons: E.state().profile.box.length, errors, seventeenth: rej.error && rej.error.code, renderMs: Math.round(t1 - t0), btn: document.querySelector('[data-act="new-team"]').textContent, dis: document.querySelector('[data-act="new-team"]').disabled, cards: document.querySelectorAll('[data-team]').length, saved: document.getElementById('saveState').dataset.state };
    })()`);
    ok(r.teams === 16 && r.mons === 96 && r.errors === 0, tag + '16 teams of 6 Pokemon (96 records) can be built', J(r));
    ok(r.seventeenth === 'teams.full' && r.dis === true && /limit/i.test(r.btn), tag + 'the 17th team is refused in the reducer and the New team button says the limit is reached', J(r));
    ok(r.cards === 16 && r.saved === 'saved', tag + 'all 16 team cards render and the whole profile is saved', J(r));
    console.log('  info: re-render of the 16-team list took ' + r.renderMs + ' ms (machine load ' + loadPct() + '; not a device number)');
    ok(r.renderMs < 1500, tag + 'rendering the 16-team list stays well under 1.5 s on this machine', String(r.renderMs));
    const f1 = await page.eval(layoutJs(true));
    ok(f1.length === 0, tag + 'the full team list has no horizontal scroll and 44 px targets', f1.join(' | '));
    await page.eval('document.getElementById("toast").hidden = true');
    await page.screenshot(path.join(OUT, 'full_16_teams_390.png'));
    // reload with 96 records: still all there
    await bootPage(page);
    ok((await page.eval('__editor.state().profile.teams.length')) === 16 && (await page.eval('__editor.state().profile.box.length')) === 96, tag + 'after a reload all 16 teams and 96 Pokemon are still there');
  });

  /* ================================================================================ screenshots + layout */
  const viewports = [
    { name: '390x844', w: 390, h: 844, mobile: true, dpr: 3, port: CDP + 4 },
    { name: '320x568', w: 320, h: 568, mobile: true, dpr: 2, port: CDP + 5 },
    { name: '1280x800', w: 1280, h: 800, mobile: false, dpr: 1, port: CDP + 6 },
  ];
  for (const v of viewports) {
    await runCase('screens at ' + v.name, { port: v.port, width: v.w, height: v.h, mobile: v.mobile, dpr: v.dpr }, async (page) => {
      const tag = 'V' + v.name + ': ';
      await bootPage(page);
      const ids = await page.eval(SEED);
      const shot = async (n) => { await page.eval('document.getElementById("toast").hidden = true'); const f = path.join(OUT, `${n}_${v.name}.png`); await page.screenshot(f); return f; };
      const check = async (what) => {
        const f1 = await page.eval(layoutJs(v.mobile));
        ok(f1.length === 0, tag + what + ': no horizontal scroll, every target >= 44 px, art on whole-number scales', f1.join(' | '));
        const a1 = await page.eval(A11Y_JS);
        ok(a1.length === 0, tag + what + ': every control has an accessible name, art is labelled or hidden, dialogs are modal', a1.slice(0, 3).join(' | '));
        return f1;
      };
      // profile list
      await go(page, '#/profiles'); await sleep(300);
      await check('profile list'); await shot('1_profile_list');
      // team list
      await go(page, '#/teams'); await sleep(300);
      await check('team list'); await shot('2_team_list');
      ok((await page.eval(`document.querySelectorAll('[data-team]').length`)) === 2 && (await page.eval(`document.querySelectorAll('[data-team] canvas.rom').length`)) >= 5, tag + 'the team list shows both teams with ROM party icons');
      // team screen (validation errors on the champions team)
      await go(page, '#/team/' + ids.t2); await sleep(400);
      await check('team with problems'); await shot('3_team_validation_errors');
      const probs = await page.eval(`[...document.querySelectorAll('[data-team-validation] .problems li')].map((li) => li.dataset.code)`);
      ok(probs.includes('level.fixed') && probs.includes('points.ev-mismatch') && probs.includes('team.species-clause'), tag + 'the validation list carries level.fixed, points.ev-mismatch and team.species-clause (as the rows\' data-code / hover text)', J(probs));
      const texts = await page.eval(`[...document.querySelectorAll('[data-team-validation] .problems li')].map((li) => li.textContent)`);
      ok(texts.every((x) => !/\b[a-z]{2,}\.[a-z][a-z-]{2,}\b/.test(x) && !/\([a-z]+(?:-[a-z]+)+\)/.test(x)), tag + 'W1 D6: no rules code is printed on the screen (it is the row\'s hover text only)', J(texts).slice(0, 300));
      ok(texts.some((x) => x.includes(R.RULE_CODES['level.fixed'])) && texts.some((x) => x.includes(R.RULE_CODES['team.species-clause'])), tag + 'each problem shows its RULE_CODES text from rules.js');
      ok((await page.eval(`document.querySelector('[data-act="test-battle"]').getAttribute('aria-disabled')`)) === 'true' && !(await page.eval(`document.querySelector('[data-act="test-battle"]').hasAttribute('href')`)), tag + 'Test battle is disabled (no link) while the team has problems');
      await click(page, '[data-act="conform"]'); await sleep(400);
      ok((await page.eval(`document.querySelector('[data-team-validation]').dataset.teamValidation`)) === 'bad', tag + 'Convert fixes the per-Pokemon problems; the species clause (two Pikachu) rightly remains');
      await page.eval('document.getElementById("undoBtn").click()'); await sleep(300);
      ok((await page.eval(`document.querySelectorAll('[data-team-validation] .problems li').length`)) > 2, tag + 'Undo puts the problems back');
      // mon editor top
      await go(page, `#/team/${ids.t1}/mon/${ids.pika}`); await sleep(600);
      await check('mon editor, Build'); await shot('4_mon_editor_top');
      await page.eval('window.scrollTo(0, document.body.scrollHeight)'); await sleep(200);
      const sv = await page.eval(`(() => { const r = document.getElementById('saveState').getBoundingClientRect(); return r.top >= 0 && r.bottom <= 120; })()`);
      ok(sv, tag + 'after scrolling to the bottom the save indicator is still pinned at the top');
      await shot('4b_mon_editor_bottom');
      // moves + picker
      await go(page, `#/team/${ids.t1}/mon/${ids.pika}/moves`); await sleep(300);
      await check('mon editor, Moves'); await shot('5_moves_tab');
      await click(page, '[data-act="pick-move"][data-slot="2"]'); await page.waitFor('!!document.querySelector("[data-fk=mv-q]")'); await sleep(500);
      await check('move picker'); await shot('6_move_picker');
      ok(await page.eval(`(() => { const r = document.querySelector('.sheet .mvrow').getBoundingClientRect(); return r.top < window.innerHeight - 60 && r.bottom > 0; })()`), tag + 'the first move row is on screen without scrolling (the filters are folded away on a phone, open where there is room)');
      ok((await page.eval(`getComputedStyle(document.querySelector('.sheet .body')).overflowY`)) === 'hidden' && (await page.eval(`getComputedStyle(document.querySelector('.sheet .movelist')).overflowY`)) === 'auto', tag + 'one scroller: the sheet does not scroll, the move list does');
      const foldBtn = await page.eval(`(() => { const b = document.querySelector('.sheet .fold-btn'); const box = document.getElementById(b.getAttribute('aria-controls')); return { exp: b.getAttribute('aria-expanded'), hidden: box.hidden, w: window.innerWidth }; })()`);
      ok(foldBtn.exp === String(!foldBtn.hidden) && (v.w >= 700 && v.h >= 760 ? !foldBtn.hidden : foldBtn.hidden), tag + 'the Filters block is folded on a phone or a short window and open on a wide, tall screen (>= 700 x 760), and aria-expanded says which', J(foldBtn));
      if (!(v.w >= 700 && v.h >= 760)) { await click(page, '.sheet .fold-btn'); ok((await page.eval(`document.getElementById(document.querySelector('.sheet .fold-btn').getAttribute('aria-controls')).hidden`)) === false, tag + 'the Filters button unfolds the filters'); await click(page, '.sheet .fold-btn'); }
      ok((await page.eval(`document.querySelectorAll('.mvrow canvas.rom').length`)) >= 20, tag + 'the move picker rows carry ROM type badges and category icons');
      await page.eval(`document.querySelector('.sheet input[type=checkbox][aria-label="Include moves this Pokemon cannot learn"]').click()`); await sleep(500);
      await shot('6b_move_picker_unlearnable');
      // scroll to the first DISABLED row so the screenshot shows the reason text rules.js gave
      for (let i = 0; i < 3; i++) { await page.eval(`(() => { const b = [...document.querySelectorAll('.sheet .movelist > button.btn')].pop(); if (b) b.click(); })()`); await sleep(120); }
      await page.eval(`(() => { const r = [...document.querySelectorAll('.sheet .mvrow[aria-disabled="true"]')].find((x) => !/already knows/.test(x.textContent)); if (r) { r.dataset.shot = '1'; r.scrollIntoView({ block: 'center' }); } })()`); await sleep(250);
      const disabledRow = await page.eval(`(() => { const r = document.querySelector('.sheet .mvrow[data-shot="1"]'); return r ? { why: (r.querySelector('.why') || {}).textContent || '', id: Number(r.dataset.move) } : null; })()`);
      ok(disabledRow && disabledRow.why.length > 10 && Object.values(R.RULE_CODES).some((t) => disabledRow.why.startsWith(t)), tag + 'a disabled move row shows a RULE_CODES reason from rules.js', J(disabledRow));
      await shot('6c_move_picker_disabled_row');
      await page.press('Escape', 'Escape', 27); await sleep(200);
      // EV panel
      await go(page, `#/team/${ids.t1}/mon/${ids.pika}/stats`); await sleep(500);
      await check('EV panel'); await shot('7_ev_panel');
      await page.eval('window.scrollTo(0, 700)'); await sleep(200); await shot('7b_ev_panel_scrolled');
      await page.eval(`[...document.querySelectorAll('.seg[aria-label="Effort view"] button')].find((b) => b.dataset.v === 'points').click()`); await sleep(300);
      await shot('7c_points_view');
      // champions team stats panel: points are the stored form
      await go(page, `#/team/${ids.t2}/mon/${ids.a2}/stats`); await sleep(500);
      await check('Champions EV panel'); await shot('8_champions_stats');
      ok((await page.eval(`document.querySelector('.seg[aria-label="Effort view"] button[data-v="ev"]').disabled`)) === true && (await page.eval(`document.querySelector('[data-iv-note]') !== null`)), tag + 'under Champions the EV view is locked and the IV fields say the rules fix them');
      // species picker
      await go(page, '#/team/' + ids.t1); await sleep(200);
      await page.eval('document.querySelector(\'[data-act="add-mon"]\') && document.querySelector(\'[data-act="add-mon"]\').click()'); await sleep(500);
      if (await exists(page, '.sheet')) { await check('species picker'); await shot('9_species_picker'); await page.press('Escape', 'Escape', 27); }
      // item picker
      await go(page, `#/team/${ids.t1}/mon/${ids.pika}`); await sleep(300);
      await click(page, '[data-act="pick-item"]'); await sleep(400); await check('item picker'); await shot('10_item_picker'); await page.press('Escape', 'Escape', 27); await sleep(200);
      // import a team code dialog
      await go(page, '#/teams'); await sleep(200);
      await click(page, '[data-act="import-code"]'); await sleep(300); await check('import dialog'); await shot('11_import_code'); await page.press('Escape', 'Escape', 27);
      // negative control for the layout predicate
      await go(page, `#/team/${ids.t1}`); await sleep(400);
      const twin = await page.eval(layoutJs(v.mobile));
      ok(twin.length === 0, tag + 'twin: the unmodified team screen passes the layout predicate a second time', twin.join(' | '));
      await page.eval(`(() => { const s = document.createElement('style'); s.id = 'mutant'; s.textContent = ${J(BREAK_CSS)}; document.head.appendChild(s); })()`);
      await sleep(250);
      const mutant = await page.eval(layoutJs(v.mobile));
      ok(mutant.length >= 2, tag + 'mutant: a stylesheet that widens the page, shrinks the buttons and scales art by a fraction is caught', mutant.length ? mutant.join(' | ').slice(0, 200) : 'NOT CAUGHT');
      await page.eval(`document.getElementById('mutant').remove()`);
      const a11yTwin = await page.eval(A11Y_JS);
      ok(a11yTwin.length === 0, tag + 'twin: the unmodified team screen passes the accessibility predicate a second time', a11yTwin.join(' | '));
      await page.eval(STRIP_NAMES_JS);
      const a11yMut = await page.eval(A11Y_JS);
      ok(a11yMut.length >= 3, tag + 'mutant: stripping every aria-label and label is caught by the accessibility predicate', a11yMut.length ? a11yMut.slice(0, 2).join(' | ') : 'NOT CAUGHT');
      const errs = errsOf(page);
      ok(errs.length === 0, tag + 'no page errors or console errors', errs.slice(0, 3).join(' | '));
    });
  }

  /* ================================================================================ records this ROM cannot show (verifier defect D1) */
  // A profile that holds a Pokemon whose number this ROM has no entry for (species 5000 is past the table, 21 is an EMPTY slot), a move or an
  // item it lacks, or more than 16 teams. Before the fix the species cases blanked the teams screen on import AND on every reload (a
  // TypeError / GfxError in the icon painter) and the unknown move blanked the Moves tab.
  const ROMJS = await mod('rom.js');
  const emptySlot = pack.species.findIndex((x, i) => i > 0 && x === null);
  ok(emptySlot > 0, 'this ROM has an empty species slot to test with (' + emptySlot + ')');
  const forge = (name, mutate) => {
    const prof = P.createProfile({ trainerName: 'RED' }, { now: () => 1700000000000, randomBytes: (k) => Uint8Array.from({ length: k }, (_, i) => (i * 29 + 7) & 255) });
    const mons = [PIKACHU, CHARIZARD, SNORLAX].map((sp, i) => { const rec = R.blankRec(sp, pack, 'arena-gen3-standard'); return P.createMon({ species: sp, level: rec.level, abilitySlot: rec.abilitySlot, moves: rec.moves, gender: pack.species[sp].genderRatio === 255 ? '-' : pack.species[sp].genderRatio === 254 ? 'F' : 'M' }, { now: () => 1700000000000 + i, randomBytes: (k) => Uint8Array.from({ length: k }, (_, j) => (i * 53 + j * 11 + 3) & 255) }); });
    prof.box.push(...mons); prof.teams.push(P.createTeam({ name: 'RAIN TEAM', monIds: mons.map((m) => m.id) }, { now: () => 1700000000000, randomBytes: (k) => Uint8Array.from({ length: k }, (_, j) => (j * 7 + 1) & 255) }));
    const e = P.buildExport(prof, { deps: { now: () => 1700000000000 } });
    mutate(e.profile);
    e.checksum = 'sha256:' + ROMJS.sha256Hex(new TextEncoder().encode(canon(e.profile)));       // re-sealed: the checksum is no defence against a hand edit
    const f = path.join(TMP, name + '.pokemonarena.json'); fs.writeFileSync(f, P.serializeExport(e)); return f;
  };
  const forged = {
    control: forge('control', () => {}),
    emptySlot: forge('species-empty-slot', (p) => { p.box[1].species = emptySlot; }),
    past: forge('species-5000', (p) => { p.box[1].species = 5000; }),
    move: forge('move-60000', (p) => { p.box[0].moves[0].id = 60000; }),
    item: forge('item-60000', (p) => { p.box[0].heldItem = 60000; }),
    teams20: forge('teams-20', (p) => { for (let i = 0; i < 19; i++) p.teams.push({ ...JSON.parse(JSON.stringify(p.teams[0])), id: 't_extra' + i, name: 'T' + i }); }),
  };
  await runCase('records this ROM cannot show (imports)', { port: CDP + 1, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    const tag = 'H390: ';
    await bootPage(page);
    await setVal(page, '[data-fk="new-name"]', 'GOOD'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 15000 });
    const draws = async () => page.eval(`document.getElementById('view').children.length > 0 && !document.getElementById('view').hidden`);
    const walk = async () => {                     // open every Pokemon of the first team on every tab; nothing may throw or blank the screen
      const bad = [];
      await go(page, '#/teams');
      if (!(await exists(page, '[data-act="open-team"]'))) return bad;
      const teamId = await page.eval(`document.querySelector('[data-team]').dataset.team`);
      await go(page, '#/team/' + teamId);
      const monIds = await page.eval(`[...document.querySelectorAll('[data-mon]')].map((e) => e.dataset.mon)`);
      for (const m of monIds) for (const tab of ['build', 'moves', 'stats']) {
        page.errors.length = 0;
        await go(page, `#/team/${teamId}/mon/${m}/${tab}`); await sleep(150);
        if (page.errors.length || !(await draws())) bad.push(`${m}/${tab}: ${page.errors.slice(0, 1).map((x) => x.split('\n')[0]).join('')}`);
      }
      return bad;
    };
    const cases = [
      ['control', forged.control, { preview: /Ready to import "RED" 1 team, 3 Pokemon/, teams: 1, quarantined: 0 }],
      ['species in an empty slot', forged.emptySlot, { preview: /1 damaged record was set aside/, teams: 1, quarantined: 1 }],
      ['species past the end of the table', forged.past, { preview: /1 damaged record was set aside/, teams: 1, quarantined: 1 }],
      ['a move this ROM lacks', forged.move, { preview: /does not pass the rules/, teams: 1, quarantined: 0 }],
      ['a held item this ROM lacks', forged.item, { preview: /does not pass the rules/, teams: 1, quarantined: 0 }],
      ['20 teams (the limit is 16)', forged.teams20, { preview: /16 teams.*4 damaged records were set aside/, teams: 16, quarantined: 4 }],
    ];
    for (const [label, file, want] of cases) {
      await go(page, '#/profiles'); await sleep(150);
      page.errors.length = 0;
      await fileInput(page, file);
      await page.waitFor('!!document.querySelector("[data-import-preview]") || !!document.querySelector("[data-import-error]")', { timeoutMs: 10000 });
      const pv = await page.eval('document.querySelector("[data-import-preview]") ? document.querySelector("[data-import-preview]").innerText : "NO PREVIEW: " + (document.querySelector("[data-import-error]") || {}).textContent');
      ok(want.preview.test(pv.replace(/\s+/g, ' ')), tag + `${label}: the preview says what will happen`, pv.replace(/\s+/g, ' ').slice(0, 200));
      await click(page, '[data-act="import-apply"]');
      await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 10000 }); await sleep(300);
      ok(errsOf(page).length === 0 && (await draws()), tag + `${label}: the teams screen draws after the import`, errsOf(page).slice(0, 2).join(' | '));
      ok((await page.eval(`document.querySelectorAll('[data-team]').length`)) === want.teams, tag + `${label}: ${want.teams} team card(s) (a profile never shows more than 16)`, await page.eval(`document.querySelectorAll('[data-team]').length`));
      ok((await page.eval(`__editor.state().profile.teams.length <= 16`)), tag + `${label}: the stored profile holds at most 16 teams`);
      await flush(page);
      page.errors.length = 0;
      await bootPage(page);                           // the player closes the tab and comes back
      ok(errsOf(page).length === 0 && (await draws()), tag + `${label}: the page draws after a reload (it used to stay blank)`, errsOf(page).slice(0, 2).join(' | '));
      const bad = await walk();
      ok(bad.length === 0, tag + `${label}: every Pokemon opens on Build, Moves and Stats`, bad.slice(0, 2).join(' | '));
      const kept = await page.eval(`__editor.state().profile.box.every((m) => !!__editor.pack.species[m.species])`);
      ok(kept, tag + `${label}: no record that this ROM cannot draw was kept`);
      if (label === 'a move this ROM lacks') {
        const t = await page.eval(`__editor.state().profile.teams[0].id`); const m = await page.eval(`__editor.state().profile.teams[0].monIds[0]`);
        await go(page, `#/team/${t}/mon/${m}/moves`); await sleep(300);
        ok(/unknown move #60000/.test(await page.eval(`(document.querySelector('[data-unknown-move]') || {}).innerText || ''`)), tag + 'the unknown move is named by its number and can be replaced');
      }
      if (label === 'a held item this ROM lacks') {
        const t = await page.eval(`__editor.state().profile.teams[0].id`); const m = await page.eval(`__editor.state().profile.teams[0].monIds[0]`);
        await go(page, `#/team/${t}/mon/${m}/build`); await sleep(300);
        ok(/Unknown item #60000/.test(await page.eval(`document.querySelector('[data-act="pick-item"]').innerText`)), tag + 'the unknown held item is named by its number and can be removed');
      }
      await go(page, '#/profiles');
    }
    // team codes (on a fresh profile: the imported one above holds 16 teams, so its Import button is rightly disabled)
    await page.eval(`__editor.actions.createProfile('CODES').then(() => true)`); await sleep(400);
    await go(page, '#/teams'); await sleep(200);
    const mkCode = (sp) => T.encodeTeamCode({ name: 'X', ruleset: 'arena-gen3-standard', mons: [{ species: sp, nickname: '', level: 50, nature: 0, abilitySlot: 0, heldItem: 0, moves: [{ id: moveId('Tackle'), ppUps: 0 }], ev: { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 }, iv: { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 }, gender: '-', shiny: false, friendship: 70 }] });
    for (const sp of [5000, emptySlot, 65535, PIKACHU]) {
      page.errors.length = 0;
      await click(page, '[data-act="import-code"]'); await sleep(200);
      await setVal(page, '[data-fk="code-in"]', await mkCode(sp)); await sleep(700);
      const body = await page.eval(`document.querySelector('#modalRoot .sheet .body').innerText`);
      const dis = await page.eval(`document.querySelector('[data-act="code-add"]').disabled`);
      if (sp === PIKACHU) ok(!dis && errsOf(page).length === 0, tag + 'control: a code for a Pokemon this ROM has can be added', body.slice(0, 120));
      else ok(dis && /does not have/.test(body) && /code\.species-unknown/.test(body) && errsOf(page).length === 0, tag + `a code naming species ${sp} is refused with a message and a code, and no page error`, body.replace(/\s+/g, ' ').slice(0, 200));
      await page.eval(`document.querySelector('#modalRoot .sheet header button').click()`); await sleep(150);
    }
    // a profile ALREADY in IndexedDB with such records (a stale or hand-edited store: no import path to filter it)
    await go(page, '#/profiles'); await sleep(200);
    await page.eval(`(async () => { const E = __editor; await E.actions.createProfile('STALE'); const d = (a) => E.dispatch(a); const t = d({ type: 'teamCreate', name: 'MIXED' }).result.teamId;
      for (const sp of [25, 6, 143, 149]) d({ type: 'monAdd', teamId: t, species: sp }); await E.flush();
      const Pr = JSON.parse(JSON.stringify(E.state().profile)); Pr.box[1].species = 5000; Pr.box[2].species = ${emptySlot}; Pr.box[3].moves[0].id = 60000; Pr.box[3].heldItem = 60000;
      await E.store.saveProfile(Pr, { reason: 'test' }); return true; })()`);
    page.errors.length = 0;
    await bootPage(page); await sleep(300);
    ok(errsOf(page).length === 0 && (await draws()), tag + 'a stored profile holding unknown records still draws the teams screen', errsOf(page).slice(0, 2).join(' | '));
    await click(page, '[data-act="open-team"]'); await page.waitFor('__editor.route().name === "team"');
    const names = await page.eval(`[...document.querySelectorAll('.slot .name')].map((e) => e.textContent)`);
    ok(names.filter((n) => /^Unknown #/.test(n)).length === 2 && names.includes('Pikachu') && names.includes('Dragonite'), tag + 'the team lists the two unknown records by number next to the real ones', J(names));
    ok((await page.eval(`document.querySelectorAll('.slot canvas.rom[role=img][aria-label^="Unknown"], .slot .nopic').length`)) >= 2, tag + 'the unknown records show a ROM-font "?" box (no invented picture)');
    await page.eval('document.getElementById("toast").hidden = true');
    await page.screenshot(path.join(OUT, 'unknown_records_team_390.png'));
    await click(page, '[data-act="open-mon"]'); // first = Pikachu; open the unknown one by index instead
    await go(page, '#/team/' + (await page.eval('__editor.route().teamId')));
    await page.eval(`document.querySelectorAll('[data-act="open-mon"]')[1].click()`); await sleep(400);
    const head = await page.eval(`(document.querySelector('.monhead') || {}).innerText || ''`);
    ok(/Unknown Pokemon #5000/.test(head) && (await exists(page, '[data-act="mon-remove"]')) && (await exists(page, '[data-act="change-species"]')) && errsOf(page).length === 0, tag + 'an unknown-species record opens its own screen with Change species and Remove', head.replace(/\s+/g, ' ').slice(0, 160));
    await page.eval('document.getElementById("toast").hidden = true');
    await page.screenshot(path.join(OUT, 'unknown_records_mon_390.png'));
    await click(page, '[data-act="mon-remove"]'); await sleep(300);
    ok((await page.eval(`document.querySelectorAll('[data-act="open-mon"]').length`)) === 3 && errsOf(page).length === 0, tag + 'Remove from team deletes it and returns to the team');
    // the art kit may be rude: an exception from it must never take the screen down (iconEl and spriteEl guard the call themselves)
    await go(page, '#/teams'); await sleep(200);
    page.errors.length = 0;
    await page.eval(`(() => { const real = __editorApp.art.monIcon; __editorApp.art.monIcon = (id, o) => { if (!__editor.pack.species[id]) throw new Error('GfxError: species id out of range: ' + id); return real(id, o); }; return true; })()`);
    await page.eval(`(() => { const q = JSON.parse(JSON.stringify(__editor.state().profile)); q.box[0].species = 5000; __editor.dispatch({ type: 'load', profile: q }, { quiet: true }); __editor.render(); return true; })()`);
    await sleep(300);
    ok(errsOf(page).length === 0 && (await draws()), tag + 'with an art kit that THROWS for an unknown species the teams screen still draws', errsOf(page).slice(0, 1).join(''));
    // NEGATIVE CONTROL: the predicate used throughout this case can say no
    await page.eval(`document.getElementById('view').hidden = true`);
    ok(!(await draws()), tag + 'negative control: draws() is false for a hidden view (the predicate can fail)');
    await page.eval(`document.getElementById('view').hidden = false`);
    await page.eval(`document.getElementById('view').replaceChildren()`);
    ok(!(await draws()), tag + 'negative control: draws() is false for an empty view');
  });

  /* ================================================================================ the four devices, each on its own (the shared input layer) */
  const PAD_INIT = `(() => {
    const pad = { id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
    window.__pad = pad; window.__padOn = false;
    navigator.getGamepads = () => [window.__padOn ? pad : null, null, null, null];
    window.__padConnect = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = pad; window.dispatchEvent(e); };
    window.__padTap = (i, ms) => new Promise((res) => { pad.buttons[i].pressed = true; pad.buttons[i].value = 1; setTimeout(() => { pad.buttons[i].pressed = false; pad.buttons[i].value = 0; setTimeout(res, 70); }, ms || 100); });
  })()`;
  const BTN = { a: 0, b: 1, l: 4, r: 5, up: 12, down: 13, left: 14, right: 15 };
  const padTap = (page, n) => page.eval(`window.__padTap(${BTN[n]})`);
  // The page-side model of uinav.js: candidates = what its collect() returns, next control = its chooseNext() over the live rects, else DOM order.
  const NAV_PRELUDE = (scopeSel) => `
    const U = await import('/pokemonarena/js/uinav.js');
    const root = ${J(scopeSel || '')} ? document.querySelector(${J(scopeSel || '')}) : document.body;
    const COMPOSITE = new Set(['option', 'radio', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'gridcell', 'switch', 'checkbox']);
    const usable = (el) => { if (el.disabled) return false; if (el.closest('[data-nav-skip], [inert], [hidden], fieldset[disabled], [aria-hidden="true"]')) return false; const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const isCand = (el) => el.matches(U.NAV_SELECTOR) && (el.tabIndex >= 0 || el.hasAttribute('data-nav') || (el.hasAttribute('tabindex') && COMPOSITE.has(String(el.getAttribute('role') || '').toLowerCase())));
    const cands = [...root.querySelectorAll(U.NAV_SELECTOR)].filter((el) => isCand(el) && usable(el));
    const rects = new Map(cands.map((e) => [e, e.getBoundingClientRect()]));
    const nextOf = (cur, dir) => {
      const others = cands.filter((c) => c !== cur && !cur.contains(c) && !c.contains(cur));
      const hit = U.chooseNext(rects.get(cur), others.map((el) => ({ el, rect: rects.get(el) })), dir);
      if (hit) return hit.cand.el;
      if (dir === 'down' || dir === 'right') return others.find((c) => cur.compareDocumentPosition(c) & 4) || null;
      for (let i = others.length - 1; i >= 0; i--) if (cur.compareDocumentPosition(others[i]) & 2) return others[i];
      return null;
    };
    const nm = (el) => (el.tagName + ' ' + (el.dataset.act || el.dataset.fk || '') + ' ' + (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 36)).trim();
  `;
  // Plan the d-pad presses from the focused control to `sel` over the LIVE layout; padGoto presses them, verifies, and re-plans if the layout shifted.
  const PLAN_JS = (targetSel, scopeSel) => `(async () => { ${NAV_PRELUDE(scopeSel)}
    const target = cands.find((c) => c.matches(${J(targetSel)}));
    if (!target) return { error: 'not a candidate: ' + ${J(targetSel)} };
    const cur = document.activeElement && cands.includes(document.activeElement) ? document.activeElement : null;
    if (cur === target) return { path: [] };
    if (!cur) return { path: ['down'] };            // the first press only focuses the default control
    const prev = new Map([[cur, null]]); const q = [cur];
    while (q.length) { const c = q.shift(); if (c === target) break; for (const d of ['down', 'up', 'right', 'left']) { const n = nextOf(c, d); if (n && !prev.has(n)) { prev.set(n, [c, d]); q.push(n); } } }
    if (!prev.has(target)) return { error: 'unreachable from the focused control' };
    const path = []; for (let n = target; prev.get(n); n = prev.get(n)[0]) path.unshift(prev.get(n)[1]);
    return { path };
  })()`;
  // Reachability: breadth-first over all four directions from the default control; returns the controls NO sequence of moves reaches.
  const REACH_JS = (scopeSel) => `(async () => { ${NAV_PRELUDE(scopeSel)}
    const start = cands.find((c) => c.hasAttribute('data-nav-default') || c.hasAttribute('autofocus')) || cands[0];
    if (!start) return { n: 0, lost: [] };
    const seen = new Set([start]), qq = [start];
    while (qq.length) { const c = qq.shift(); for (const d of ['up', 'down', 'left', 'right']) { const n = nextOf(c, d); if (n && !seen.has(n)) { seen.add(n); qq.push(n); } } }
    return { n: cands.length, lost: cands.filter((c) => !seen.has(c)).map(nm) };
  })()`;
  async function padGoto(page, sel, { scope = '' } = {}) {
    for (let t = 0; t < 4; t++) {
      if (await page.eval(`!!document.activeElement && document.activeElement.matches(${J(sel)})`)) return true;
      const plan = await page.eval(PLAN_JS(sel, scope));
      if (plan.error) throw new Error('padGoto ' + sel + ': ' + plan.error);
      for (const d of plan.path) await padTap(page, d);
    }
    return page.eval(`!!document.activeElement && document.activeElement.matches(${J(sel)})`);
  }
  const rectOf = (page, sel) => page.eval(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return { x, y, hit: !!top && (top === el || el.contains(top)), top: top ? top.tagName + '.' + top.className : null }; })()`);
  const kbTo = async (page, sel) => { for (let i = 0; i < 140; i++) { if (await page.eval(`!!document.activeElement && document.activeElement.matches(${J(sel)})`)) return true; await page.press('Tab', 'Tab', 9, 25); await sleep(15); } return false; };
  const keyEnter = async (page) => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await sleep(30); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(80); };
  const typeInto = async (page, sel, text) => { await page.eval(`(() => { const e = document.querySelector(${J(sel)}); e.focus(); e.select && e.select(); })()`); await page.send('Input.insertText', { text }); await sleep(80); };

  for (const device of ['mouse', 'touch', 'keyboard', 'controller']) {
    await runCase('device: ' + device + ' only', { port: CDP + 2, width: 390, height: 844, mobile: device === 'touch', dpr: 2, init: PAD_INIT }, async (page) => {
      const tag = 'D-' + device + ': ';
      const b = await bootPage(page);
      ok(b.ready && !b.error, tag + 'the page boots', J(b));
      await page.waitFor('window.__editor.inputState', { timeoutMs: 20000 });
      ok((await page.eval('__editor.inputState')) === 'on', tag + 'the shared input layer (input.js + uinav.js) is up', await page.eval('__editor.inputState'));
      if (device === 'controller') { await page.eval('window.__padConnect()'); await sleep(200); }
      // one activation per device; for a pad: plan the d-pad path then A, for the keyboard Tab to it then Enter, for mouse and touch a real pointer event at its centre
      const act = async (sel) => {
        if (device === 'mouse' || device === 'touch') {
          const r = await rectOf(page, sel);
          if (!r || !r.hit) throw new Error(`${device}: ${sel} is not hittable (${r && r.top})`);
          if (device === 'mouse') await page.click(r.x, r.y); else await page.tap(r.x, r.y);
        } else if (device === 'keyboard') { if (!(await kbTo(page, sel))) throw new Error('keyboard: Tab never reached ' + sel); await keyEnter(page); }
        else { if (!(await padGoto(page, sel, { scope: (await exists(page, '#modalRoot .sheet')) ? '#modalRoot .sheet' : '' }))) throw new Error('controller: the d-pad never reached ' + sel); await padTap(page, 'a'); }
        await sleep(260);
      };
      const typeText = async (sel, text) => {
        if (device === 'controller') return false;                       // a pad has no keys: it keeps the default name and picks from the list
        if (device === 'keyboard') { await kbTo(page, sel); await page.send('Input.insertText', { text }); await sleep(80); }
        else { const r = await rectOf(page, sel); if (device === 'mouse') await page.click(r.x, r.y); else await page.tap(r.x, r.y); await page.send('Input.insertText', { text }); await sleep(80); }
        return true;
      };
      const named = await typeText('[data-fk="new-name"]', 'DEV');
      await act('[data-act="create"]');
      ok((await page.eval('__editor.route().name')) === 'teams' && (await page.eval('__editor.state().profile.trainerName')) === (named ? 'DEV' : 'TRAINER'), tag + 'a profile is created (name ' + (named ? 'DEV, typed' : 'TRAINER, the default') + ')', await page.eval('__editor.state().profile.trainerName'));
      await act('[data-act="new-team"]');
      ok((await page.eval('__editor.route().name')) === 'team', tag + 'New team opens the team screen');
      await act('[data-act="add-mon"]');
      ok(await exists(page, '#modalRoot .sheet'), tag + 'Add a Pokemon opens the species picker');
      if (device === 'controller') {
        await padTap(page, 'b'); await sleep(250);
        ok(!(await exists(page, '#modalRoot .sheet')), tag + 'B closes the picker');
        ok(await page.eval(`document.activeElement.matches('[data-act="add-mon"]')`), tag + 'focus returns to the button that opened it');
        await act('[data-act="add-mon"]');
      }
      const typed = await typeText('[data-fk="sp-q"]', 'pikachu'); if (typed) await sleep(450);
      await act('.sheet [data-species]');
      ok((await page.eval('__editor.route().name')) === 'mon', tag + 'choosing a species opens the Pokemon editor');
      const spName = await page.eval('__editor.pack.species[__editor.state().profile.box[0].species].name');
      ok(typed ? spName === 'Pikachu' : !!spName, tag + 'the species is ' + (typed ? 'Pikachu (searched)' : spName + ' (the first row)'), spName);
      if (device === 'controller') { await padTap(page, 'r'); await sleep(200); await padTap(page, 'r'); await sleep(350); } else await act('[data-tab="stats"]');
      ok((await page.eval('__editor.route().tab')) === 'stats', tag + 'the Stats tab opens' + (device === 'controller' ? ' (R shoulder twice: Build -> Moves -> Stats)' : ''), await page.eval('__editor.route().tab'));
      await sleep(300);
      for (let i = 0; i < 3; i++) await act('[data-fk="ev-inc-atk"]');
      const ev = await page.eval('__editor.state().profile.box[0].ev.atk');
      ok(ev === 12, tag + 'three presses of "+" on Attack EVs give exactly 12 (one activation = one step; a double fire would give 24)', ev);
      if (device === 'keyboard') {                  // Space on the focused button is one more step, not two (the layer and the browser must not both activate it)
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }); await sleep(30);
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await sleep(250);
        ok((await page.eval('__editor.state().profile.box[0].ev.atk')) === 16, tag + 'Space on the focused "+" button is exactly one more step (12 -> 16)', await page.eval('__editor.state().profile.box[0].ev.atk'));
        await page.eval('window.__editor.dispatch({ type: "evSet", monId: __editor.state().profile.box[0].id, stat: "atk", value: 12, mode: "ev" })');
      }
      if (device === 'controller') { await padTap(page, 'b'); await sleep(300); ok((await page.eval('__editor.route().name')) === 'team', tag + 'B steps back to the team screen'); }
      await flush(page); await sleep(300);
      await bootPage(page);
      ok((await page.eval('__editor.state().profile.box[0].ev.atk')) === 12, tag + 'after a reload the Attack EVs are still 12 (saved)');
      const errs = errsOf(page);
      ok(errs.length === 0, tag + 'no page errors or console errors', errs.slice(0, 2).join(' | '));
    });
  }

  /* ================================================================================ the controller reaches and drives EVERY kind of control */
  await runCase('controller: every control reachable, every kind operable', { port: CDP + 3, width: 390, height: 844, mobile: true, dpr: 2, init: PAD_INIT }, async (page) => {
    const tag = 'C390: ';
    await bootPage(page);
    await page.waitFor('window.__editor.inputState', { timeoutMs: 20000 });
    // reachability: breadth-first over the four directions with the layer's own chooseNext, from the default control of every screen and dialog
    const reach = async (label, scope) => { await sleep(250); const r = await page.eval(REACH_JS(scope)); ok(r.n >= 2 && r.lost.length === 0, tag + label + `: all ${r.n} controls are reachable by moves`, J(r.lost)); };
    await page.eval(`(async () => { const E = __editor; await E.actions.createProfile('ONE'); await E.actions.createProfile('TWO'); await E.actions.openProfile(E.profiles()[0].id); return true; })()`);
    await sleep(400); await go(page, '#/profiles'); await reach('profile list', '#view');
    const ids = await page.eval(`(async () => { const E = __editor; const d = (a) => E.dispatch(a);
      const t = d({ type: 'teamCreate', name: 'RAIN' }).result.teamId; for (const sp of [25, 6, 143]) d({ type: 'monAdd', teamId: t, species: sp });
      const t2 = d({ type: 'teamCreate', name: 'SECOND' }).result.teamId; d({ type: 'monAdd', teamId: t2, species: 25 }); d({ type: 'teamRuleset', teamId: t2, ruleset: 'arena-gen3-standard+strict-champions' });
      await E.flush(); return { t, t2, mons: E.state().profile.teams[0].monIds }; })()`);
    await go(page, '#/teams'); await reach('team list', '#view');
    await go(page, '#/team/' + ids.t); await reach('team screen', '#view');
    await go(page, '#/team/' + ids.t2); await reach('team screen with problems', '#view');
    for (const tab of ['build', 'moves', 'stats']) { await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/${tab}`); await sleep(300); await reach('Pokemon ' + tab, '#view'); }
    const dlg = async (label, open) => { await open(); await sleep(500); await reach(label, '#modalRoot .sheet'); await page.eval(`document.querySelector('#modalRoot .sheet header button').click()`); await sleep(200); };
    await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/moves`); await sleep(300);
    await dlg('move picker', () => click(page, '[data-act="pick-move"]'));
    await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/build`); await sleep(300);
    await dlg('item picker', () => click(page, '[data-act="pick-item"]'));
    await dlg('species picker', () => click(page, '[data-act="change-species"]'));
    await go(page, '#/teams'); await sleep(200);
    await dlg('team-code dialog', () => click(page, '[data-act="import-code"]'));
    await dlg('confirm dialog', () => click(page, '[data-act="delete-team"]'));
    await go(page, '#/profiles'); await sleep(200);
    await dlg('portrait picker', () => click(page, '[data-act="avatar"]'));
    // no control hides behind a role without keyboard support: every ARIA-role "button-like" thing is a native control or focusable
    const orphan = await page.eval(`(() => { const out = []; for (const e of document.querySelectorAll('[role=button], [role=link], [role=radio], [role=checkbox], [role=option], [role=tab], [role=switch]')) { const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0) || e.closest('[hidden]')) continue; if (e.tabIndex < 0 && !e.matches('button, a[href], input, select, textarea')) out.push(e.tagName + '.' + e.className); } return out; })()`);
    ok(orphan.length === 0, tag + 'no ARIA control is unreachable without a mouse', orphan.join(', '));
    // operate every kind
    await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/build`); await sleep(400);
    await page.eval('window.__padConnect()'); await sleep(200);
    const mon = () => page.eval(`JSON.parse(JSON.stringify(__editor.state().profile.box[0]))`);
    const m0 = await mon();
    const to = (sel) => padGoto(page, sel, { scope: '' });
    ok(await to('[data-fk="nature"]'), tag + 'the d-pad reaches the Nature select');
    await padTap(page, 'a'); await sleep(200);
    ok(await page.eval(`document.activeElement.hasAttribute('data-nav-editing')`), tag + 'A on a select starts edit mode (a dashed ring)');
    await padTap(page, 'right'); await padTap(page, 'right'); await sleep(150); await padTap(page, 'a'); await sleep(300);
    ok((await mon()).nature !== m0.nature, tag + 'right x2 then A changes the nature', J([m0.nature, (await mon()).nature]));
    ok(await to('[data-fk="ab2"]'), tag + 'the d-pad reaches the hidden-ability button'); await padTap(page, 'a'); await sleep(250);
    ok((await mon()).abilitySlot === 2, tag + 'A chooses the hidden ability');
    ok(await to('[data-fk="shiny"]'), tag + 'the d-pad reaches the Shiny checkbox'); await padTap(page, 'a'); await sleep(250);
    ok((await mon()).shiny === true, tag + 'A ticks the checkbox'); await padTap(page, 'a'); await sleep(250);
    ok((await mon()).shiny === false, tag + 'A unticks it');
    ok(await to('[data-fk="item"]'), tag + 'the d-pad reaches the held-item button'); await padTap(page, 'a'); await sleep(450);
    ok(await exists(page, '#modalRoot .sheet'), tag + 'A opens the item picker');
    ok(await padGoto(page, '.sheet [data-item]', { scope: '#modalRoot .sheet' }), tag + 'the d-pad moves into the item list inside the dialog (and cannot leave it)');
    await padTap(page, 'b'); await sleep(300);
    ok(!(await exists(page, '#modalRoot .sheet')) && (await page.eval(`document.activeElement.matches('[data-fk="item"]')`)), tag + 'B closes the picker and focus returns to the item button');
    await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/stats`); await sleep(500);
    ok(await to('[data-fk="ev-atk"]'), tag + 'the d-pad reaches the Attack EV number field'); await padTap(page, 'a'); await sleep(200);
    for (let i = 0; i < 3; i++) { await padTap(page, 'right'); await sleep(60); }
    await padTap(page, 'a'); await sleep(600);
    ok((await mon()).ev.atk === 3, tag + 'A, right x3, A sets the number field to 3', (await mon()).ev.atk);
    ok(await to('[data-fk="slider-spe"]'), tag + 'the d-pad reaches the Speed slider'); await padTap(page, 'a'); await sleep(200);
    for (let i = 0; i < 4; i++) { await padTap(page, 'right'); await sleep(60); }
    await padTap(page, 'a'); await sleep(600);
    ok((await mon()).ev.spe === 16, tag + 'the slider moves four steps of 4 EVs in edit mode', (await mon()).ev.spe);
    ok(await to('[data-preset="zeroAtk"]'), tag + 'the d-pad reaches the "0 Attack" IV preset'); await padTap(page, 'a'); await sleep(300);
    ok((await mon()).iv.atk === 0, tag + 'A applies the IV preset');
    ok(await to('#undoBtn'), tag + 'the d-pad reaches Undo in the header'); await padTap(page, 'a'); await sleep(300);
    ok((await mon()).iv.atk === 31, tag + 'Undo through the controller restores the IV');
    // THE AUDIO BAR STAYS REACHABLE (js/audiobar.js: mute, volume and the menu-music changer live in the sticky header, a row of their own on a phone). It once also broke the routes above: a header one row
    // taller flipped the tie in uinav's loose fallback and Left from the stats presets jumped INTO the header (the Speed slider and the "0 Attack" preset became unreachable).
    ok(await to('#abMute') && await to('#abVolume') && await to('#abMusic'), tag + 'the d-pad reaches the audio bar: mute, volume and menu music');
    await padTap(page, 'a'); await sleep(350);
    ok(await page.eval(`(() => { const m = document.getElementById('abMenu'); return !!m && !m.hidden && m.contains(document.activeElement); })()`), tag + 'A on Menu music opens the list with the focus inside it');
    for (let i = 0; i < 8; i++) { await padTap(page, 'up'); await sleep(60); }
    ok(await page.eval(`document.getElementById('abMenu').contains(document.activeElement)`), tag + 'the d-pad cannot leave the open list upwards (it is a modal dialog for navigation: the header behind it is out of reach)');
    await padTap(page, 'b'); await sleep(350);
    ok(await page.eval(`document.getElementById('abMenu').hidden === true && !!document.activeElement && document.activeElement.id === 'abMusic'`), tag + 'B closes the list and the focus is back on Menu music');
    await go(page, `#/team/${ids.t}/mon/${ids.mons[0]}/moves`); await sleep(400);
    ok(await to('[data-act="pick-move"][data-slot="3"]') || await to('[data-act="pick-move"]'), tag + 'the d-pad reaches a move slot'); await padTap(page, 'a'); await sleep(500);
    ok(await exists(page, '#modalRoot .sheet'), tag + 'A opens the move picker');
    ok(await padGoto(page, '.sheet .mvrow', { scope: '#modalRoot .sheet' }), tag + 'the d-pad reaches a move row'); await padTap(page, 'a'); await sleep(500);
    ok(!(await exists(page, '#modalRoot .sheet')), tag + 'A on a usable move picks it and closes the picker');
    await go(page, '#/team/' + ids.t); await sleep(500);
    ok(await to('[data-act="test-battle"]') && /^\/pokemonarena\/battle\.html\?team=ARENA1\./.test(await page.eval(`document.activeElement.getAttribute('href') || ''`)), tag + 'the d-pad reaches Test battle and it carries the battle URL');
    const errs = errsOf(page);
    ok(errs.length === 0, tag + 'no page errors or console errors', errs.slice(0, 2).join(' | '));
  });

  // NEGATIVE CONTROL for the device cases: with uinav.js blocked the page degrades to mouse / touch / plain keyboard, and the controller does nothing.
  await runCase('negative control: the input layer is blocked', { port: CDP + 4, width: 390, height: 844, mobile: true, dpr: 2, init: PAD_INIT }, async (page) => {
    const tag = 'N390: ';
    await page.send('Network.enable'); await page.send('Network.setBlockedURLs', { urls: ['*/pokemonarena/js/uinav.js'] });
    await bootPage(page);
    await page.waitFor('window.__editor.inputState', { timeoutMs: 20000 });
    ok(/^off/.test(await page.eval('__editor.inputState')), tag + 'with uinav.js blocked the editor reports the input layer off and keeps running', await page.eval('__editor.inputState'));
    await page.eval('window.__padConnect()'); await sleep(200);
    for (let i = 0; i < 4; i++) await padTap(page, 'down');
    ok((await page.eval(`document.activeElement === document.body`)), tag + 'the controller moves nothing without the layer (so the controller checks elsewhere really exercise the layer)');
    const r = await rectOf(page, '[data-fk="new-name"]'); await page.click(r.x, r.y); await page.send('Input.insertText', { text: 'MOUSE' });
    const r2 = await rectOf(page, '[data-act="create"]'); await page.click(r2.x, r2.y); await sleep(500);
    ok((await page.eval('__editor.state() && __editor.state().profile.trainerName')) === 'MOUSE', tag + 'the mouse still creates a profile (graceful degradation)');
  });

  /* ================================================================================ a write that fails for lack of space */
  await runCase('storage quota exceeded', { port: CDP + 5, width: 390, height: 844, mobile: true, dpr: 2, init: "(() => { const put = IDBObjectStore.prototype.put, add = IDBObjectStore.prototype.add; window.__failWrites = false; IDBObjectStore.prototype.put = function (...a) { if (window.__failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, a); }; IDBObjectStore.prototype.add = function (...a) { if (window.__failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return add.apply(this, a); }; })()" }, async (page) => {
    const tag = 'Q390: ';
    await bootPage(page);
    await setVal(page, '[data-fk="new-name"]', 'FULL'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 15000 });
    await page.eval('__editor.dispatch({ type: "teamCreate", name: "A" })'); await flush(page); await sleep(300);
    ok((await page.eval('__editor.saveState')) === 'saved', tag + 'before the failure the indicator says Saved');
    await page.eval('window.__failWrites = true');
    await page.eval('__editor.dispatch({ type: "teamCreate", name: "B" })'); await sleep(900); await flush(page); await sleep(300);
    ok((await page.eval('__editor.saveState')) === 'notsaved' && /NOT SAVED/.test(await page.eval('document.getElementById("saveText").textContent')), tag + 'a QuotaExceededError turns the indicator to NOT SAVED (it is not reported as a save)');
    ok(/QuotaExceededError/.test(await page.eval('document.getElementById("banners").innerText')) && (await exists(page, '#banners button')), tag + 'a banner names the cause and offers Export');
    await page.eval('window.__failWrites = false');
    const exp = await page.eval('(async () => { await __editor.actions.exportProfile(__editor.state().profile.id); return __editor.lastExport && __editor.lastExport.name; })()');
    ok(/^pokemonarena-FULL/.test(exp || ''), tag + 'Export still works while storage is failing', exp);
    ok(errsOf(page).length === 0, tag + 'no uncaught page errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================ W1 fixes D2 / D9 / D10, each with a negative control (the same check on a copy with the fix removed) */
  const realKey = async (page, key, code, vk, text) => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }); await sleep(30); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await sleep(50); };
  const centre = (page, sel) => page.eval(`(() => { const r = document.querySelector(${J(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const realClick = async (page, sel) => { const c = await centre(page, sel); await page.click(c.x, c.y); await sleep(350); };
  const activeOf = (page) => page.eval(`(() => { const a = document.activeElement; return (a && (a.id || a.tagName)) || 'none'; })()`);
  const withMutant = async (rel, from, to, portOff, fn) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ed-mut-'));
    const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
    mutateFile(d, rel, from, to);
    const ov = await startOverlay({ dir: d, port: PORT + portOff, upstream: BASE });
    try { return await fn(ov.url + '/pokemonarena/editor.html'); } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  };

  // F67 NEGATIVE CONTROL for the second-writer case: the same scenario on a copy of the page whose "Keep my edits here" no longer carries the stored record over (the line that calls
  // profile.withStoredRecord). The team edit is still saved, and the battle the other tab recorded must now be GONE -- so the assertion in the real case above can fail.
  await runCase('second writer: Keep my edits here without the stored record erases the other tab\'s battle (negative control)', { port: CDP + 2, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    const tag = 'CAS-mutant: ';
    const cas = await withMutant('js/editor_app.js', ' S = { ...S, profile: withStoredRecord(S.profile, cur.profile) };', '', 19, (url) => casKeepMine(page, url));
    ok(cas.after.monIds === 4 && cas.after.online === 0 && cas.after.wins === 0 && cas.after.recent.length === 0, tag + 'on a copy without the fix the same scenario saves the team and ERASES the other tab\'s battle (stored record empty), which is what the real case asserts against', J(cas.after));
  });

  // D2: a dialog opened from the editor header gives focus back to the button that opened it, whether it was opened with the mouse or the keyboard
  async function headerFocus(page, url) {
    const r = {};
    await bootPage(page, url);
    const dlgOpen = () => page.eval(`(() => { const d = document.getElementById('controlsDialog'); return !!d && !d.hidden; })()`);
    // MOUSE first
    await realClick(page, '#controlsBtn');
    r.mouseOpen = await dlgOpen();
    r.mouseFocusIn = await page.eval(`(() => { const d = document.getElementById('controlsDialog'); return !!d && d.contains(document.activeElement); })()`);
    await realKey(page, 'Escape', 'Escape', 27);
    r.mouseClosed = !(await dlgOpen());
    r.stayed = await page.eval(`location.pathname`);                                 // the same Escape must not ALSO be the page's "B goes up" (it threw the player out to the hub)
    r.mouseBack = await activeOf(page);                                              // the Controls button again
    await realKey(page, 'Tab', 'Tab', 9);
    r.mouseTabOn = await activeOf(page);                                             // Tab carries on from the header, it does not restart at the top of the page
    // KEYS: Tab to the button, Enter opens, Escape closes, Enter opens again
    await bootPage(page, url);
    await page.eval(`document.getElementById('soundBtn').focus()`);
    await realKey(page, 'Tab', 'Tab', 9);
    r.kbOnControls = (await activeOf(page)) === 'controlsBtn';
    await realKey(page, 'Enter', 'Enter', 13, '\r'); await sleep(300);
    r.kbOpen = await dlgOpen();
    await realKey(page, 'Escape', 'Escape', 27); await sleep(200);
    r.kbBack = await activeOf(page);
    await realKey(page, 'Enter', 'Enter', 13, '\r'); await sleep(300);
    r.kbReopen = await dlgOpen();
    return r;
  }
  const HF_CHECKS = (r) => [
    ['a click on the header Controls button opens the dialog with focus inside', r.mouseOpen && r.mouseFocusIn],
    ['Escape closes it and the editor stays open (the same Escape does not also go up a level to the hub)', r.mouseClosed && r.stayed === '/pokemonarena/editor.html'],
    ['... and focus is back on the Controls button (not dropped on the page)', r.mouseClosed && r.mouseBack === 'controlsBtn'],
    ['Tab then carries on from the header (it does not restart at the top of the page)', r.mouseTabOn !== 'backLink' && r.mouseTabOn !== 'BODY' && r.mouseTabOn !== 'none' && r.mouseTabOn !== 'controlsBtn'],
    ['keyboard: Tab to Controls, Enter opens it, Escape closes it with focus back on the button, Enter opens it again', r.kbOnControls && r.kbOpen && r.kbBack === 'controlsBtn' && r.kbReopen],
  ];
  await runCase('header focus after a click (W1 fix D2)', { port: CDP + 12, width: 1280, height: 800 }, async (page) => {
    const r = await headerFocus(page, PAGE);
    for (const [n, c] of HF_CHECKS(r)) ok(c === true, 'D2 editor: ' + n, J(r));
  });
  await runCase('header focus negative control (W1 fix D2)', { port: CDP + 13, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/controls_dialog.js', 'if (opener && opener.isConnected) {', 'if (false) {', 10, async (url) => {
      const r = await headerFocus(page, url);
      const failed = HF_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.some((n) => /focus is back on the Controls button/.test(n)) && failed.some((n) => /keyboard: Tab to Controls/.test(n)), 'D2 editor negative control: with the refocus removed the same real-key check FAILS (' + failed.length + ' of 5)', J(r));
    });
  });
  await runCase('header Escape negative control (W1 fix D2)', { port: CDP + 22, width: 1280, height: 800 }, async (page) => {
    // the dialog's second Escape closer restored (the original fault: Escape shut the dialog AND went up a level): the same check must FAIL on "the editor stays open"
    await withMutant('js/controls_dialog.js', 'if (open && ownNav && e.key', 'if (open && e.key', 15, async (url) => {
      const r = await headerFocus(page, url);
      const failed = HF_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.some((n) => /the editor stays open/.test(n)), 'D2 editor negative control: with the second Escape closer back, Escape leaves the editor and the same check FAILS (' + failed.length + ' of 5)', J(r));
    });
  });

  // D9: a nickname is saved while typing (debounced) and on blur, not only on change; "type, wait, reload" keeps it
  async function nickCheck(page, url) {
    const r = {};
    await bootPage(page, url);
    await setVal(page, '[data-fk="new-name"]', 'NIK'); await click(page, '[data-act="create"]');
    await page.waitFor('__editor.route().name === "teams"', { timeoutMs: 15000 });
    await click(page, '[data-act="new-team"]'); await page.waitFor('__editor.route().name === "team"');
    await click(page, '[data-act="add-mon"]'); await page.waitFor('!!document.querySelector("[data-fk=sp-q]")');
    await setVal(page, '[data-fk="sp-q"]', 'pikachu'); await sleep(150);
    await click(page, `.vrow[data-species="${PIKACHU}"]`); await page.waitFor('__editor.route().name === "mon"');
    const storedNick = () => page.eval(`(async () => { const l = await __editor.store.listProfiles(); const x = await __editor.store.loadProfile(l[0].id); const m = x.profile.box.find((b) => b.species === ${PIKACHU}); return m ? m.nickname : null; })()`);
    // typed with real input events; no Enter, no blur
    await page.eval(`document.querySelector('[data-fk="nick"]').focus()`);
    await page.send('Input.insertText', { text: 'Sparky' });
    await sleep(900);
    await flush(page);
    r.typedState = await page.eval(`__editor.state().profile.box.find((m) => m.species === ${PIKACHU}).nickname`);
    r.typedStored = await storedNick();
    await page.eval('window.__marker = 1; true');                                    // (Page.reload answers before the old document goes away: wait for the NEW one)
    await page.send('Page.reload', {});
    await page.waitFor('window.__marker === undefined && window.__editor && window.__editor.ready && document.querySelector(\'[data-fk="nick"]\')', { timeoutMs: 60000 });
    await sleep(300);
    r.afterReload = await page.eval(`(document.querySelector('[data-fk="nick"]') || {}).value`);
    // leaving the field commits at once
    await page.eval(`document.querySelector('[data-fk="nick"]').select()`);
    await page.send('Input.insertText', { text: 'Zap' });
    await realKey(page, 'Tab', 'Tab', 9);
    r.blurState = await page.eval(`__editor.state().profile.box.find((m) => m.species === ${PIKACHU}).nickname`);
    return r;
  }
  const NICK_CHECKS = (r) => [
    ['a nickname typed and left alone (no Enter, no blur) is in the profile after the debounce', r.typedState === 'Sparky'],
    ['... and in IndexedDB', r.typedStored === 'Sparky'],
    ['... and still in the field after a reload', r.afterReload === 'Sparky'],
    ['leaving the field (Tab) commits it at once', r.blurState === 'Zap'],
  ];
  await runCase('nickname saved while typing (W1 fix D9)', { port: CDP + 14, width: 1280, height: 800 }, async (page) => {
    const r = await nickCheck(page, PAGE);
    for (const [n, c] of NICK_CHECKS(r)) ok(c === true, 'D9: ' + n, J(r));
  });
  await runCase('nickname negative control (W1 fix D9)', { port: CDP + 15, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', "nick.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => commit(true), NICK_DEBOUNCE_MS); });", '', 11, async (url) => {
      const r = await nickCheck(page, url);
      const failed = NICK_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.length >= 3 && failed.some((n) => /after the debounce/.test(n)), 'D9 negative control: with the typing listener removed the same check FAILS (' + failed.length + ' of 4)', J(r));
    });
  });

  // D10: after a file is DROPPED on the import screen, the file chooser shows that file (it kept the name of the one picked before)
  // A6: while a controller is the device in use, the import screen says the pad cannot open the file chooser (and says nothing otherwise)
  const PAD_INIT_A6 = "window.__pad = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] }; navigator.getGamepads = () => [{ id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons.map((v) => ({ pressed: v > 0.5, value: v })) }];";
  async function padNoteCheck(page, url) {
    const r = {};
    await bootPage(page, url + '#/import');
    await page.waitFor(`!!document.querySelector('[data-pad-note]') && !!window.__editor.input`, { timeoutMs: 30000 });
    const hid = () => page.eval(`document.querySelector('[data-pad-note]').hidden`);
    r.before = await hid();
    await page.eval(`(() => { window.dispatchEvent(new Event('gamepadconnected')); window.__pad.buttons[14] = 1; })()`); await sleep(150);
    await page.eval(`window.__pad.buttons[14] = 0`); await sleep(300);
    r.afterPad = await hid();
    r.text = await page.eval(`document.querySelector('[data-pad-note]').textContent`);
    { const c = await centre(page, '#h-import'); await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await page.click(c.x, c.y); await sleep(300); }
    r.afterMouse = await hid();
    return r;
  }
  const PADNOTE_CHECKS = (r) => [['no note before any controller input', r.before === true], ['after a controller press the note says it cannot open the file chooser', r.afterPad === false && /cannot open the file chooser/.test(r.text)], ['after a mouse click the note is gone again', r.afterMouse === true]];
  await runCase('import screen controller note (W1 fix A6)', { port: CDP + 18, width: 1280, height: 800, init: PAD_INIT_A6 }, async (page) => {
    const r = await padNoteCheck(page, PAGE);
    for (const [n, c] of PADNOTE_CHECKS(r)) ok(c === true, 'A6: ' + n, J(r));
  });
  await runCase('import screen controller note negative control (W1 fix A6)', { port: CDP + 19, width: 1280, height: 800, init: PAD_INIT_A6 }, async (page) => {
    await withMutant('js/editor_import.js', "i.lastSource === 'gamepad'", 'false', 13, async (url) => {
      const r = await padNoteCheck(page, url);
      ok(PADNOTE_CHECKS(r).some(([, c]) => c !== true), 'A6 negative control: with the pad test removed the same check FAILS', J(r));
    });
  });

  // A8: a mouse alone can type: clicking into a text field offers a "Keyboard" button that opens the on-screen keyboard (the controller's), whose keys a mouse can press
  async function mouseTypeCheck(page, url) {
    const r = {};
    await bootPage(page, url);
    await page.waitFor(`!!window.__editor.input && !!window.__editor.osk && !!document.querySelector('[data-fk="new-name"]')`, { timeoutMs: 30000 });
    const btn = () => page.eval(`(() => { const b = document.querySelector('[data-osk-open]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; })()`);
    r.before = await btn();
    { const c = await centre(page, '[data-fk="new-name"]'); await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await page.click(c.x, c.y); await sleep(300); }
    r.offered = await btn();
    if (r.offered) {
      await page.click(r.offered.x, r.offered.y); await sleep(400);
      r.open = await page.eval(`document.body.dataset.osk === 'open'`);
      for (const k of ['a', 'b']) { await clickSelectorMouse(page, `.arena-osk [data-key="${k}"]`); }
      await clickSelectorMouse(page, '.arena-osk [data-role="ok"]'); await sleep(300);
      r.value = await page.eval(`document.querySelector('[data-fk="new-name"]').value`);
    }
    // a key press takes the button away again
    { const c = await centre(page, '[data-fk="new-name"]'); await page.click(c.x, c.y); await sleep(300); }
    r.again = !!(await btn());
    await realKey(page, 'x', 'KeyX', 88); await sleep(200);
    r.goneAfterKey = !(await btn());
    return r;
  }
  async function clickSelectorMouse(page, sel) { const c = await centre(page, sel); await page.click(c.x, c.y); await sleep(150); }
  const MOUSETYPE_CHECKS = (r) => [
    ['no keyboard button before a text field is clicked', r.before === null],
    ['clicking into a text field with the mouse offers a Keyboard button (a 44 px target, inside the window)', !!r.offered && r.offered.h >= 44 && r.offered.inside],
    ['the button opens the on-screen keyboard and the mouse can press its keys: "ab" ends up in the field', r.open === true && /^Ab$/i.test(String(r.value))],
    ['pressing a physical key makes the button go away', r.again === true && r.goneAfterKey === true],
  ];
  await runCase('mouse can type (W1 fix A8)', { port: CDP + 20, width: 1280, height: 800 }, async (page) => {
    const r = await mouseTypeCheck(page, PAGE);
    for (const [n, c] of MOUSETYPE_CHECKS(r)) ok(c === true, 'A8: ' + n, J(r));
  });
  await runCase('mouse can type negative control (W1 fix A8)', { port: CDP + 21, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/osk.js', "input.sourceKnown && input.lastSource === 'mouse') placeKb(f); else hideKb(); };", 'false) placeKb(f); else hideKb(); };', 14, async (url) => {
      const r = await mouseTypeCheck(page, url);
      ok(MOUSETYPE_CHECKS(r).some(([, c]) => c !== true), 'A8 negative control: with the button never offered the same check FAILS', J(r));
    });
  });

  const dropA = path.join(TMP, 'first.sav'), dropB = path.join(TMP, 'second.sav');
  fs.writeFileSync(dropA, Buffer.alloc(1000, 0x11)); fs.writeFileSync(dropB, Buffer.alloc(1000, 0x22));
  async function dropCheck(page, url) {
    const r = {};
    await bootPage(page, url + '#/import');
    await page.waitFor(`!!document.querySelector('[data-save-file]')`, { timeoutMs: 20000 });
    const doc = await page.send('DOM.getDocument', { depth: 1 });
    const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-save-file]' });
    await page.send('DOM.setFileInputFiles', { files: [dropA], nodeId: node.nodeId });
    await sleep(500);
    r.first = await page.eval(`(document.querySelector('[data-save-file]').files[0] || {}).name || null`);
    // a real drop; when this Chrome cannot synthesise one, a DOM drop event carrying the same bytes
    let real = false;
    try {
      const c = await page.eval(`({ x: innerWidth / 2, y: innerHeight / 2 })`);
      const data = { items: [], files: [dropB], dragOperationsMask: 1 };
      await page.send('Input.dispatchDragEvent', { type: 'dragEnter', x: c.x, y: c.y, data }); await page.send('Input.dispatchDragEvent', { type: 'dragOver', x: c.x, y: c.y, data });
      await page.send('Input.dispatchDragEvent', { type: 'drop', x: c.x, y: c.y, data }); await sleep(600);
      real = (await page.eval(`(document.querySelector('[data-save-file]').files[0] || {}).name || null`)) === 'second.sav' || (await page.eval(`document.body.innerText.includes('second.sav')`));
    } catch (_e) { real = false; }
    if (!real) await page.eval(`(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(1000).fill(0x22)], 'second.sav')); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    await sleep(700);
    r.how = real ? 'real drop' : 'synthetic drop';
    r.afterDrop = await page.eval(`(document.querySelector('[data-save-file]').files[0] || {}).name || null`);
    return r;
  }
  const DROP_CHECKS = (r) => [['the chooser shows the first file after choosing it', r.first === 'first.sav'], ['after dropping a second file the chooser shows THAT file, not the first', r.afterDrop === 'second.sav']];
  await runCase('drop mirrored into the file chooser (W1 fix D10)', { port: CDP + 16, width: 1280, height: 800 }, async (page) => {
    const r = await dropCheck(page, PAGE);
    for (const [n, c] of DROP_CHECKS(r)) ok(c === true, 'D10: ' + n + ' (' + r.how + ')', J(r));
  });
  await runCase('drop negative control (W1 fix D10)', { port: CDP + 17, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_import.js', 'offerFile: (f) => { if (f) mirrorIntoInput(f); return read(f); }', 'offerFile: (f) => { return read(f); }', 12, async (url) => {
      const r = await dropCheck(page, url);
      ok(r.first === 'first.sav' && r.afterDrop !== 'second.sav', 'D10 negative control: with the mirroring removed the chooser keeps the first file (' + r.afterDrop + ') and the check FAILS (' + r.how + ')', J(r));
    });
  });

  /* ================================================================================ sort and filter the Pokemon list by type (the picker) and sort a team by type */
  // The picker is virtual (only the rows on screen exist), so every rendered row is checked against the list worked out in Node from the same ROM tables: row idx -> species.
  const DEFRS = R.DEFAULT_RULESET_ID;
  const wantList = (o) => ED.speciesSearch(pack, o.q || '', DEFRS, { unavailable: 'hide', sort: o.sort, type: o.type });
  const pickerRows = (page) => page.eval("[...document.querySelectorAll('.sheet .vrow')].map((r) => [Number(r.dataset.idx), Number(r.dataset.species)]).sort((a, b) => a[0] - b[0])");
  const rowsMatch = (rows, want) => rows.length >= 6 && rows.every(([i, sp]) => want[i] === sp);
  const countText = (page) => page.eval("document.querySelector('.sheet [role=status]').textContent");
  const activeFk = (page) => page.eval("(() => { const a = document.activeElement; return a ? (a.dataset && a.dataset.fk) || (a.classList.contains('fold-btn') ? 'fold-btn' : a.tagName) : 'none'; })()");
  const openPicker = async (page) => { await click(page, '[data-act="add-mon"]'); await page.waitFor('!!document.querySelector("[data-fk=sp-sort]")'); await sleep(200); };
  const openFold = async (page) => { if (!(await page.eval("document.querySelector('.sheet .fold-body').hidden === false"))) { await click(page, '.sheet .fold-btn'); await sleep(100); } };
  // The open picker must FIT: the sheet inside the window, the list not cut off, and ONE scrollbar (the list's). layoutJs never looks at the sheet body or the list, so when the
  // open "Sort and filter" block pushed the 52dvh list past the sheet's 86vh cap (nested scrollbars, the last rows hidden below the fold, on every desktop window under about 1150 px
  // tall) nothing noticed. Returns a list of findings ([] = fine).
  const SHEET_JS = `(() => {
    const f = [], s = document.querySelector('#modalRoot .sheet');
    if (!s) return ['no dialog is open'];
    const body = s.querySelector(':scope > .body'), list = s.querySelector('.vlist');
    if (!body || !list) return ['the dialog has no body or no list'];
    const ih = window.innerHeight, sr = s.getBoundingClientRect(), lr = list.getBoundingClientRect(), br = body.getBoundingClientRect();
    if (body.scrollHeight > body.clientHeight + 1) f.push('the sheet body scrolls (' + body.scrollHeight + ' > ' + body.clientHeight + ')');
    if (sr.top < -0.5 || sr.bottom > ih + 0.5) f.push('the sheet leaves the window: ' + Math.round(sr.top) + '..' + Math.round(sr.bottom) + ' of ' + ih);
    if (lr.bottom > br.bottom + 0.5 || lr.bottom > ih + 0.5) f.push('the list is cut off: its bottom is at ' + Math.round(lr.bottom) + ', the body ends at ' + Math.round(br.bottom) + ', the window at ' + ih);
    if (lr.height < 219.5) f.push('the list is only ' + Math.round(lr.height) + ' px tall');
    const scrollers = [s, ...s.querySelectorAll('*')].filter((e) => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1; }).map((e) => String(e.className || e.tagName));
    if (scrollers.length !== 1 || scrollers[0] !== 'vlist') f.push('scrollbars in the sheet: ' + JSON.stringify(scrollers) + ' (want only the list)');
    return f;
  })()`;
  // the picker open with Sort and filter open, at several window heights (CDP metrics override: the layout re-flows, nothing reloads): { height: findings }
  async function sheetProbe(page, url, heights) {
    const out = {};
    await bootPage(page, url);
    const ids = await page.eval(SEED);
    await go(page, '#/team/' + ids.t1);
    await openPicker(page); await openFold(page);
    for (const hh of heights) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: hh, deviceScaleFactor: 1, mobile: false }); await sleep(250);
      out[hh] = await page.eval(SHEET_JS);
      out['list' + hh] = await page.eval("Math.round(document.querySelector('.sheet .vlist').getBoundingClientRect().height)");
    }
    return out;
  }
  async function typeSortProbe(page, url) {
    const r = {};
    await bootPage(page, url);
    const ids = await page.eval(SEED);
    await go(page, '#/team/' + ids.t1);
    await openPicker(page); await openFold(page);
    r.sheet = await page.eval(SHEET_JS);
    r.controls = await page.eval("(() => { const s = document.querySelector('[data-fk=sp-sort]'), t = document.querySelector('[data-fk=sp-type]'); return { sort: s && s.value, opts: s && [...s.options].map((o) => o.value + '=' + o.textContent), type: t && t.value, types: t && [...t.options].map((o) => o.textContent) }; })()");
    r.defaultOrder = rowsMatch(await pickerRows(page), wantList({}));
    await setVal(page, '[data-fk="sp-sort"]', 'type', 'change'); await sleep(250);
    r.typeOrder = rowsMatch(await pickerRows(page), wantList({ sort: 'type' }));
    r.typeCount = await countText(page);
    await page.eval("document.querySelector('.sheet .vlist').scrollTop = 56 * 400"); await sleep(300);
    const deep = await pickerRows(page);
    r.deepOrder = rowsMatch(deep, wantList({ sort: 'type' })) && deep[0][0] > 300;
    await setVal(page, '[data-fk="sp-sort"]', 'name', 'change'); await sleep(250);
    r.nameOrder = rowsMatch(await pickerRows(page), wantList({ sort: 'name' }));
    await setVal(page, '[data-fk="sp-sort"]', 'type', 'change'); await sleep(150);
    await setVal(page, '[data-fk="sp-type"]', '11', 'change'); await sleep(250);
    r.fireOrder = rowsMatch(await pickerRows(page), wantList({ sort: 'type', type: 11 }));
    r.fireCount = await countText(page);
    r.fireN = wantList({ sort: 'type', type: 11 }).length;
    // a Pokemon with two types is in both lists; pick it from a filtered, sorted list (the row index must not be mistaken for the species)
    await setVal(page, '[data-fk="sp-type"]', '3', 'change'); await setVal(page, '[data-fk="sp-q"]', 'zard', 'input'); await sleep(300);
    const zRows = await pickerRows(page);
    const zWant = wantList({ q: 'zard', sort: 'type', type: 3 });          // a short list: every row is rendered, so the whole list is compared
    r.flyingHasCharizard = zRows.some(([, sp]) => sp === CHARIZARD) && zRows.length === zWant.length && zRows.every(([i, sp]) => zWant[i] === sp);
    const boxBefore = await page.eval("__editor.state().profile.box.filter((m) => m.species === 6).length");
    await click(page, '.sheet .vrow[data-species="6"]'); await page.waitFor('__editor.route().name === "mon"'); await sleep(200);
    r.picked = (await page.eval("__editor.state().profile.box.filter((m) => m.species === 6).length")) === boxBefore + 1;
    // the order is remembered, and the filter is not
    r.stored = await page.eval("localStorage.getItem('arena.editor.speciesSort')");
    await bootPage(page, url); await go(page, '#/team/' + ids.t1);
    await openPicker(page); await openFold(page);
    r.afterReload = await page.eval("({ sort: document.querySelector('[data-fk=sp-sort]').value, type: document.querySelector('[data-fk=sp-type]').value })");
    r.reloadOrder = rowsMatch(await pickerRows(page), wantList({ sort: 'type' }));
    // keyboard: Tab from the search box reaches the fold, then Sort, then Type; ArrowDown on the focused Sort changes it
    await page.eval("document.querySelector('[data-fk=sp-q]').focus()");
    const tabs = [];
    for (let i = 0; i < 3; i++) { await realKey(page, 'Tab', 'Tab', 9); await sleep(60); tabs.push(await activeFk(page)); }
    r.tabOrder = tabs;
    await setVal(page, '[data-fk="sp-sort"]', 'dex', 'change'); await sleep(200);
    await page.eval("document.querySelector('[data-fk=sp-sort]').focus()");
    await realKey(page, 'ArrowDown', 'ArrowDown', 40); await sleep(250);
    r.keyboardSort = await page.eval("document.querySelector('[data-fk=sp-sort]').value");
    r.keyboardOrder = rowsMatch(await pickerRows(page), wantList({ sort: r.keyboardSort }));
    r.keyboardCount = await countText(page);
    r.layout = await page.eval(layoutJs(false));
    r.pageErrors = errsOf(page);
    return r;
  }
  const TS_CHECKS = (r) => [
    ['the picker has Sort (Pokedex number, Name, Type; Pokedex number first) and a Type filter that offers the 18 real types', r.controls && r.controls.sort === 'dex' && J(r.controls.opts) === J(['dex=Pokedex number', 'name=Name', 'type=Type']) && r.controls.type === '' && r.controls.types.length === 19 && r.controls.types[0] === 'Any type' && r.controls.types[1] === 'Normal' && r.controls.types[18] === 'Fairy' && !r.controls.types.includes('???')],
    ['untouched, the list is in the Pokedex order it always had', r.defaultOrder],
    ['Sort: Type puts every row in the first-then-second type order of the ROM (checked against Node on the rows on screen)', r.typeOrder],
    ['... also deep in the list, where the virtual rows are far from the top', r.deepOrder],
    ['the count line says what is applied ("sorted by type")', /sorted by type/.test(r.typeCount)],
    ['Sort: Name orders by name', r.nameOrder],
    ['Type: Fire keeps exactly the Fire Pokemon (either slot), still in type order', r.fireOrder && new RegExp('^' + r.fireN + ' Pokemon, type Fire, sorted by type').test(r.fireCount)],
    ['a Fire/Flying Pokemon is in the Flying list and picking it from the sorted, filtered list adds that species (' + r.flyingHasCharizard + ', ' + r.picked + ')', r.flyingHasCharizard && r.picked],
    ['the order is remembered (stored: ' + r.stored + ') and survives a reload; the type filter starts empty again', r.stored === 'type' && r.afterReload && r.afterReload.sort === 'type' && r.afterReload.type === '' && r.reloadOrder],
    ['keyboard: Tab goes search -> Sort and filter -> Sort -> Type (' + J(r.tabOrder) + ')', J(r.tabOrder) === J(['fold-btn', 'sp-sort', 'sp-type'])],
    ['keyboard: ArrowDown on Sort changes the order and the list follows (' + r.keyboardSort + ')', r.keyboardSort === 'name' && r.keyboardOrder && /sorted by name/.test(r.keyboardCount)],
    ['no layout findings with the picker open (44 px targets, no horizontal overflow, nothing outside the screen)', Array.isArray(r.layout) && r.layout.length === 0],
    ['the sheet fits the window with Sort and filter open: the list is not cut off and the list is the only scrollbar (' + J(r.sheet) + ')', Array.isArray(r.sheet) && r.sheet.length === 0],
    ['no page errors', r.pageErrors.length === 0],
  ];
  await runCase('sort the Pokemon picker by type, desktop 1280x800', { port: CDP + 23, width: 1280, height: 800 }, async (page) => {
    const r = await typeSortProbe(page, PAGE);
    for (const [n, c] of TS_CHECKS(r)) ok(c === true, 'TS1280: ' + n, J(r).slice(0, 400));
    await page.press('Escape', 'Escape', 27); await sleep(200);
    await go(page, '#/team/' + (await page.eval('__editor.state().profile.teams[0].id')));
    await openPicker(page); await openFold(page);
    await setVal(page, '[data-fk="sp-sort"]', 'type', 'change'); await sleep(300);
    await page.screenshot(path.join(OUT, 'typesort_1280.png'));
  });
  await runCase('sort the Pokemon picker by type, phone 390x844', { port: CDP + 24, width: 390, height: 844, mobile: true, dpr: 2 }, async (page) => {
    await bootPage(page, PAGE);
    const ids = await page.eval(SEED);
    await go(page, '#/team/' + ids.t1);
    await openPicker(page);
    const closed = await page.eval("({ hidden: document.querySelector('.sheet .fold-body').hidden, btn: document.querySelector('.sheet .fold-btn').textContent })");
    ok(closed.hidden === true && closed.btn === 'Sort and filter', 'TS390: on a phone the Sort and filter block starts folded, so the list gets the screen', J(closed));
    const sheetClosed = await page.eval(SHEET_JS);
    ok(sheetClosed.length === 0, 'TS390: the sheet fits the phone with the block folded (list not cut off, one scrollbar)', J(sheetClosed));
    await openFold(page);
    const sheetOpen = await page.eval(SHEET_JS);
    ok(sheetOpen.length === 0, 'TS390: ... and with the block open', J(sheetOpen));
    await setVal(page, '[data-fk="sp-sort"]', 'type', 'change'); await sleep(300);
    ok(rowsMatch(await pickerRows(page), wantList({ sort: 'type' })), 'TS390: sorting by type works on a phone');
    const f = await page.eval(layoutJs(true));
    ok(f.length === 0, 'TS390: no layout findings with the block open (44 px targets, no overflow)', J(f));
    const sizes = await page.eval("['sp-sort', 'sp-type'].map((k) => { const r = document.querySelector('[data-fk=' + k + ']').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })");
    ok(sizes.every(([w, h]) => w >= 44 && h >= 44), 'TS390: Sort and Type are at least 44 css px', J(sizes));
    ok(errsOf(page).length === 0, 'TS390: no page errors', errsOf(page).slice(0, 2).join(' | '));
    await page.screenshot(path.join(OUT, 'typesort_390.png'));
  });
  // the same check against a copy where each control does nothing: it must FAIL (a test that cannot fail is decoration)
  await runCase('negative control: the Sort and Type controls do nothing', { port: CDP + 25, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', 'sortBy = speciesSortPref(e.target.value); refresh();', 'refresh();', 13, async (url) => {
      const r = await typeSortProbe(page, url);
      const failed = TS_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.length >= 3 && failed.some((n) => /Sort: Type puts every row/.test(n)), 'TS negative control (Sort does nothing): the same checks FAIL (' + failed.length + ' of ' + TS_CHECKS(r).length + ')', J(failed).slice(0, 300));
    });
  });
  await runCase('negative control: the Type filter does nothing', { port: CDP + 26, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', 'typeF = e.target.value; refresh();', 'refresh();', 14, async (url) => {
      const r = await typeSortProbe(page, url);
      const failed = TS_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.some((n) => /Type: Fire keeps exactly/.test(n)), 'TS negative control (Type does nothing): the Fire check FAILS (' + failed.length + ' failed)', J(failed).slice(0, 300));
    });
  });

  // The picker must fit its sheet at the window heights a laptop or a desktop has (CDP metrics override: the layout re-flows, nothing reloads). It used to fit none of them under about 1150 px.
  const SHEET_HEIGHTS = [800, 768, 900, 1080, 1440];
  await runCase('sort picker fits its sheet at desktop heights', { port: CDP + 28, width: 1280, height: 800 }, async (page) => {
    const r = await sheetProbe(page, PAGE, SHEET_HEIGHTS);
    for (const hh of SHEET_HEIGHTS) ok(Array.isArray(r[hh]) && r[hh].length === 0, `SH${hh}: the Pokemon picker fits a 1280x${hh} window with Sort and filter open (one scrollbar, the list not cut off; the list is ${r['list' + hh]} px tall)`, J(r[hh]));
    ok(errsOf(page).length === 0, 'SH: no page errors', errsOf(page).slice(0, 2).join(' | '));
  });
  // the same probe against a copy where the picker sheet is not "fixed" (the old code): it must FAIL at the common laptop heights
  await runCase('negative control: sort picker sheet is not fixed', { port: CDP + 29, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', "{ title, fixed: true, sheetClass: 'picker', bodyClass: 'has-vlist', body: [h('label', null, 'Search', search), fold('Sort and filter'", "{ title, sheetClass: 'picker', bodyClass: 'has-vlist', body: [h('label', null, 'Search', search), fold('Sort and filter'", 15, async (url) => {
      const r = await sheetProbe(page, url, [800, 768]);
      ok(r[800].length > 0 && r[768].length > 0, 'SH negative control (the sheet is not fixed): the same predicate FAILS at 1280x800 and 1280x768 (at 800: ' + J(r[800]).slice(0, 260) + ')', J(r).slice(0, 400));
    });
  });

  /* ================================================================================ the picker on a SHORT window (#14 residual) */
  // Measured before the fix, 1280 wide, Sort and filter open (it started open from 700 px WIDE up, however short the window): the picker fitted one scrollbar from about 725 px tall; below that the
  // list sat on its 220 px floor and the body scrolled too: 720 -> 3 px over, 700 -> 20, 640 -> 72 (list bottom 653, body bottom 594), 585 -> 119; an 844x390 phone held sideways -> 287, the whole list
  // below the window. Now the block starts FOLDED unless the window is >= 700 wide AND >= 760 tall (js/editor_views.js FOLD_ROOMY), and editor.css lets the picker's sheet use the window.
  // TWO predicates, both run in the page:
  //   FIT   (SHEET_JS above, unchanged)  the sheet is inside the window, the sheet body does not scroll, the list is >= 220 px and inside the body, and the ONLY scroller is the list.
  //   REACH (PICKER_REACH_JS below)             (a) the sheet is inside the window; (b) the only scrollers are the sheet body (class "body fixed has-vlist") and the list; (c) with the body at scroll
  //                                      0, at least PICKER_MIN_SHOWN px of the list lie inside the body's box; (d) with the body scrolled to its end the WHOLE list (>= 220 px tall) lies inside the body's box;
  //                                      (e) if the body overflows, its computed overflow-y is auto / scroll (script can scroll an overflow:hidden box, a visitor cannot, so (d) alone proves nothing).
  // Asserted: folded as it starts below 760 px tall; FIT with the block folded at 1280x{720,700,640,585}; REACH in every case (folded as it starts, and opened by hand) incl. 844x390; FIT with
  // the block opened by hand at 1280x{760,720,700} (it is NOT asserted at 640 and 585, where the open block cannot fit and the body is allowed to scroll).
  const PICKER_MIN_SHOWN = 24;
  const PICKER_REACH_JS = `(() => {
    const f = [], s = document.querySelector('#modalRoot .sheet');
    if (!s) return ['no dialog is open'];
    const body = s.querySelector(':scope > .body'), list = s.querySelector('.vlist');
    if (!body || !list) return ['the dialog has no body or no list'];
    const ih = window.innerHeight, sr = s.getBoundingClientRect(), box = (e) => e.getBoundingClientRect();
    if (sr.top < -0.5 || sr.bottom > ih + 0.5) f.push('the sheet leaves the window: ' + Math.round(sr.top) + '..' + Math.round(sr.bottom) + ' of ' + ih);
    const scrollers = [s, ...s.querySelectorAll('*')].filter((e) => { const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 1; }).map((e) => String(e.className || e.tagName));
    const stray = scrollers.filter((n) => n !== 'vlist' && n !== 'body fixed has-vlist');
    if (stray.length) f.push('scrollers other than the sheet body and the list: ' + JSON.stringify(stray));
    if (body.scrollHeight > body.clientHeight + 1 && !/^(auto|scroll)$/.test(getComputedStyle(body).overflowY)) f.push('the sheet body overflows (' + body.scrollHeight + ' > ' + body.clientHeight + ') but a visitor cannot scroll it: overflow-y is ' + getComputedStyle(body).overflowY);
    body.scrollTop = 0;
    const l0 = box(list), b0 = box(body), shown = Math.min(l0.bottom, b0.bottom) - Math.max(l0.top, b0.top);
    if (shown < ${PICKER_MIN_SHOWN}) f.push('only ' + Math.round(shown) + ' px of the list show before the body is scrolled (want ${PICKER_MIN_SHOWN}): list ' + Math.round(l0.top) + '..' + Math.round(l0.bottom) + ', body ends at ' + Math.round(b0.bottom));
    body.scrollTop = body.scrollHeight;
    const l1 = box(list), b1 = box(body);
    if (l1.top < b1.top - 0.5 || l1.bottom > b1.bottom + 0.5) f.push('the list cannot be scrolled fully into view: list ' + Math.round(l1.top) + '..' + Math.round(l1.bottom) + ', body ' + Math.round(b1.top) + '..' + Math.round(b1.bottom));
    if (l1.height < 219.5) f.push('the list is only ' + Math.round(l1.height) + ' px tall');
    body.scrollTop = 0;
    return f;
  })()`;
  const SHORT_SIZES = [[1280, 760], [1280, 759], [1280, 720], [1280, 700], [1280, 640], [1280, 585], [844, 390]];
  // for each window size: open a FRESH picker (the fold decides its state when the picker opens), record how it started and both predicates, open the block by hand, record both again
  async function shortProbe(page, url, sizes = SHORT_SIZES) {
    const out = {};
    await bootPage(page, url);
    const ids = await page.eval(SEED);
    await go(page, '#/team/' + ids.t1);
    for (const [w, hh] of sizes) {
      const o = (out[w + 'x' + hh] = {});
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: hh, deviceScaleFactor: 1, mobile: false }); await sleep(250);
      await openPicker(page);
      o.startedOpen = await page.eval("document.querySelector('.sheet .fold-body').hidden === false");
      o.expanded = await page.eval("document.querySelector('.sheet .fold-btn').getAttribute('aria-expanded')");
      o.body = await page.eval("(() => { const b = document.querySelector('.sheet > .body'); return { cls: b.className, overflowY: getComputedStyle(b).overflowY }; })()");
      o.startFit = await page.eval(SHEET_JS); o.startReach = await page.eval(PICKER_REACH_JS);
      await openFold(page); await sleep(150);
      o.openFit = await page.eval(SHEET_JS); o.openReach = await page.eval(PICKER_REACH_JS);
      await page.press('Escape', 'Escape', 27); await sleep(200);
    }
    out.errs = errsOf(page);
    return out;
  }
  const SHORT_CHECKS = (r, sizes = SHORT_SIZES) => {
    const c = [];
    for (const [w, hh] of sizes) {
      const k = w + 'x' + hh, o = r[k], tall = w >= 700 && hh >= 760;
      if (!o) { c.push([`SHORT ${k}: the window was probed`, false]); continue; }
      c.push([`SHORT ${k}: the Sort and filter block starts ${tall ? 'OPEN' : 'FOLDED'} (aria-expanded ${tall})`, o.startedOpen === tall && o.expanded === String(tall)]);
      c.push([`SHORT ${k}: the picker body carries the has-vlist class and scrolls itself (computed overflow-y auto), so the short-window rule does not depend on :has()`, !!o.body && /\bhas-vlist\b/.test(o.body.cls) && o.body.overflowY === 'auto']);
      c.push([`SHORT ${k}: the list is reachable as the picker starts (REACH)`, Array.isArray(o.startReach) && o.startReach.length === 0, J(o.startReach)]);
      c.push([`SHORT ${k}: ... and with the block opened by hand (REACH)`, Array.isArray(o.openReach) && o.openReach.length === 0, J(o.openReach)]);
      if (w === 1280 && hh >= 585) c.push([`SHORT ${k}: as it starts the picker fits with one scrollbar, the list's (FIT)`, Array.isArray(o.startFit) && o.startFit.length === 0, J(o.startFit)]);
      if (w === 1280 && hh >= 700) c.push([`SHORT ${k}: ... and with the block opened by hand (FIT)`, Array.isArray(o.openFit) && o.openFit.length === 0, J(o.openFit)]);
    }
    return c;
  };
  await runCase('sort picker on a short window', { port: CDP + 34, width: 1280, height: 800 }, async (page) => {
    const r = await shortProbe(page, PAGE);
    for (const [n, cond, d] of SHORT_CHECKS(r)) ok(cond === true, n, d);
    ok(r.errs.length === 0, 'SHORT: no page errors', r.errs.slice(0, 2).join(' | '));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false }); await sleep(250);
    await openPicker(page); await openFold(page); await sleep(150);
    await page.screenshot(path.join(OUT, 'picker_844x390_open.png'));
  });
  // each guarantee against a copy that breaks it: the same checks must FAIL, and the failures must name the guarantee
  const shortMutant = (name, rel, from, to, portOff, cdpOff, want, sizes) => runCase('negative control: ' + name, { port: CDP + cdpOff, width: 1280, height: 800 }, async (page) => {
    await withMutant(rel, from, to, portOff, async (url) => {
      const r = await shortProbe(page, url, sizes);
      const failed = SHORT_CHECKS(r, sizes).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.length > 0 && want.every((re) => failed.some((n) => re.test(n))), 'SHORT negative control (' + name + '): the checks FAIL, naming ' + want.map(String).join(' and ') + ' (' + failed.length + ' failed)', J(failed).slice(0, 500));
    });
  });
  // 1. the fold ignores the window's height (the old rule: wide enough is room enough) -> it starts open on every short window
  await shortMutant('the Sort and filter block ignores the window height', 'js/editor_views.js', "'(min-width: 700px) and (min-height: 760px)'", "'(min-width: 700px)'", 19, 35,
    [/1280x720: the Sort and filter block starts FOLDED/, /1280x585: the Sort and filter block starts FOLDED/, /844x390: the Sort and filter block starts FOLDED/, /1280x585: as it starts the picker fits/]);
  // 2. the picker sheet keeps 86vh on a short window (no whole-window cap) -> the folded picker no longer fits one scrollbar at 585
  await shortMutant('the picker sheet does not use the short window', 'editor.css', '#modalRoot .sheet.picker { max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); }', '#modalRoot .sheet.picker { }', 20, 36,
    [/1280x585: as it starts the picker fits/], [[1280, 585]]);
  // 3. the body class is gone (the old :has() rule written as a class that nothing sets) -> the picker body is overflow hidden, the list is cut off on a window where the block cannot fit
  await shortMutant('the picker body has no has-vlist class', 'js/editor_views.js', "bodyClass: 'has-vlist', ", '', 21, 37,
    [/has-vlist class/, /1280x585: \.\.\. and with the block opened by hand \(REACH\)/, /844x390: the list is reachable as the picker starts \(REACH\)/], [[1280, 585], [844, 390]]);
  // 4. no tightening on a window under 520 px tall -> on the 844x390 phone held sideways nothing of the list shows once the block is opened by hand
  await shortMutant('the sideways-phone layout is not tightened', 'editor.css', '@media (max-height: 519px) {', '@media (max-height: 1px) {', 22, 38,
    [/844x390: \.\.\. and with the block opened by hand \(REACH\)/], [[844, 390]]);

  // Enter in the search box: the species whose whole name was typed, else the first row in the Pokedex order, else (a partial name under a Type / Name order) nothing, and it says so
  async function enterProbe(page, url) {
    const r = {};
    await bootPage(page, url);
    const ids = await page.eval(SEED);
    const boxLen = () => page.eval('__editor.state().profile.box.length');
    const lastSpecies = () => page.eval('(() => { const b = __editor.state().profile.box; return b[b.length - 1].species; })()');
    const toastNow = () => page.eval("(() => { const t = document.getElementById('toast'); return t.hidden ? '' : t.textContent; })()");
    // open the picker on the seeded team, set the order, type `q`, press a REAL Enter in the search box; report what was added and what is still on screen, then put things back
    async function enter(q, sort, showAll) {
      await go(page, '#/team/' + ids.t1);
      await openPicker(page);
      await setVal(page, '[data-fk="sp-sort"]', sort, 'change');
      if (showAll) await page.eval("document.querySelector('.sheet input[type=checkbox]').click()");
      await setVal(page, '[data-fk="sp-q"]', q); await sleep(250);
      const n0 = await boxLen();
      await page.eval("document.querySelector('[data-fk=sp-q]').focus()");
      await realKey(page, 'Enter', 'Enter', 13, '\r'); await sleep(400);
      const added = (await boxLen()) - n0;
      const out = { added, species: added ? pack.species[await lastSpecies()].name : null, open: await page.eval("!!document.querySelector('#modalRoot .sheet')"), toast: await toastNow() };
      if (out.open) { await page.press('Escape', 'Escape', 27); await sleep(150); }
      if (added) { await page.eval("__editor.dispatch({ type: 'undo' })"); await sleep(250); }       // the team has room for three more, not for every case
      return out;
    }
    r.dexAbra = await enter('abra', 'dex');
    r.typeAbra = await enter('abra', 'type');
    r.nameNatu = await enter('natu', 'name');
    r.typeAron = await enter('aron', 'type');
    r.dexMew = await enter('mew', 'dex');
    r.typeChar = await enter('char', 'type');
    r.nameChar = await enter('char', 'name');
    r.dexChar = await enter('char', 'dex');
    r.typeOne = await enter('bulbasa', 'type');
    r.none = await enter('zzzzzz', 'type');
    r.out = await enter('zorua', 'type', true);
    r.pageErrors = errsOf(page);
    return r;
  }
  const firstOf = (q, sort) => pack.species[wantList({ q, sort })[0]].name;
  const EN_CHECKS = (r) => [
    ['Pokedex order: "abra" + Enter adds Abra (' + r.dexAbra.species + ')', r.dexAbra.species === 'Abra'],
    ['Type order puts ' + firstOf('abra', 'type') + ' on top of "abra"; Enter still adds Abra, the Pokemon that was typed (' + r.typeAbra.species + ')', firstOf('abra', 'type') !== 'Abra' && r.typeAbra.species === 'Abra'],
    ['Name order puts ' + firstOf('natu', 'name') + ' on top of "natu"; Enter adds Natu (' + r.nameNatu.species + ')', firstOf('natu', 'name') !== 'Natu' && r.nameNatu.species === 'Natu'],
    ['Type order puts ' + firstOf('aron', 'type') + ' on top of "aron"; Enter adds Aron (' + r.typeAron.species + ')', firstOf('aron', 'type') !== 'Aron' && r.typeAron.species === 'Aron'],
    ['Pokedex order puts ' + firstOf('mew', 'dex') + ' on top of "mew"; Enter adds Mew (' + r.dexMew.species + ')', firstOf('mew', 'dex') !== 'Mew' && r.dexMew.species === 'Mew'],
    ['Type order, a partial name ("char", ' + wantList({ q: 'char', sort: 'type' }).length + ' Pokemon): Enter adds nothing, the picker stays open and the live region says why', wantList({ q: 'char', sort: 'type' }).length > 1 && r.typeChar.added === 0 && r.typeChar.open && /Enter does not choose/.test(r.typeChar.toast) && /sorted by type/.test(r.typeChar.toast)],
    ['Name order, a partial name: the same (adds nothing, says "sorted by name")', r.nameChar.added === 0 && r.nameChar.open && /sorted by name/.test(r.nameChar.toast)],
    ['Pokedex order, a partial name ("char"): Enter adds the first row, as it always did (' + r.dexChar.species + ')', r.dexChar.species === firstOf('char', 'dex')],
    ['Type order, one hit left ("bulbasa"): Enter adds it (' + r.typeOne.species + ')', wantList({ q: 'bulbasa', sort: 'type' }).length === 1 && r.typeOne.species === 'Bulbasaur'],
    ['no hits: Enter adds nothing and the picker stays open', r.none.added === 0 && r.none.open],
    ['a Pokemon these rules leave out ("zorua", shown with "Also list ..."): Enter adds nothing and gives the reason', r.out.added === 0 && r.out.open && /^Zorua: ./.test(r.out.toast)],
    ['no page errors', r.pageErrors.length === 0],
  ];
  await runCase('sort picker: Enter in the search box', { port: CDP + 30, width: 1280, height: 800 }, async (page) => {
    const r = await enterProbe(page, PAGE);
    for (const [n, c] of EN_CHECKS(r)) ok(c === true, 'EN: ' + n, J(r).slice(0, 500));
  });
  await runCase('negative control: sort picker Enter takes the first row', { port: CDP + 31, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', 'const id = speciesEnterChoice(app.pack, ids, q, sortBy);', 'const id = ids[0];', 16, async (url) => {
      const r = await enterProbe(page, url);
      const failed = EN_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.length >= 4 && failed.some((n) => /"abra"; Enter still adds Abra/.test(n)) && failed.some((n) => /partial name \("char"/.test(n)), 'EN negative control (Enter takes ids[0]): the same checks FAIL (' + failed.length + ' of ' + EN_CHECKS(r).length + ')', J(failed).slice(0, 400));
    });
  });

  // the team: one button puts the members in type order, one undo step. A keyboard or pad user must keep their place (the redraw replaces the button) and be told what happened.
  async function teamSortProbe(page, url) {
    const r = {};
    await bootPage(page, url);
    const ids = await page.eval(SEED);
    await go(page, '#/team/' + ids.t1);
    const btn = "[data-act='sort-team-type']";
    const speciesNow = () => page.eval("__editor.state().profile.teams[0].monIds.map((id) => __editor.state().profile.box.find((m) => m.id === id).species)");
    const domOrder = () => page.eval("[...document.querySelectorAll('.slot[data-mon]')].map((e) => e.dataset.mon)");
    const attr = (a) => page.eval('document.querySelector(' + J(btn) + ').getAttribute(' + J(a) + ')');
    const active = () => page.eval("(() => { const a = document.activeElement; return a ? ((a.dataset && a.dataset.act) || a.tagName) : 'none'; })()");
    const toastNow = () => page.eval("(() => { const t = document.getElementById('toast'); return { text: t.hidden ? '' : t.textContent, role: t.getAttribute('role'), live: t.getAttribute('aria-live') }; })()");
    const codeNow = () => page.eval("document.querySelector('[data-team-code]').value");
    r.start = await speciesNow();
    await page.waitFor("document.querySelector('[data-team-code]') && document.querySelector('[data-team-code]').value !== ''", { timeoutMs: 15000 });
    const code0 = await codeNow();
    r.enabled = (await exists(page, btn)) && (await attr('aria-disabled')) === null && (await attr('disabled')) === null;
    r.title = await attr('title');
    const seq0 = await page.eval('__editor.state().seq');
    // KEYBOARD: focus the button, press a real Enter; then wait for the team code to be redrawn for the new order (a second redraw, which must not take focus either)
    await page.eval('document.querySelector(' + J(btn) + ').focus()');
    await pressEnter(page); await sleep(300);
    await page.waitFor('document.querySelector("[data-team-code]").value !== ' + J(code0), { timeoutMs: 15000 }); await sleep(200);
    r.after = await speciesNow();
    r.domOk = J(await domOrder()) === J(await page.eval('__editor.state().profile.teams[0].monIds'));
    r.activeAfter = await active();
    r.toast = await toastNow();
    r.ariaDisabledAfter = await attr('aria-disabled');
    r.disabledAfter = await page.eval('document.querySelector(' + J(btn) + ').disabled');
    r.titleAfter = await attr('title');
    r.seq1 = (await page.eval('__editor.state().seq')) - seq0;
    r.label = await page.eval('(() => { const u = __editor.state().undo; return u[u.length - 1].label; })()');
    // Enter again, on the sorted team: nothing moves, and the live region says why
    await pressEnter(page); await sleep(300);
    r.again = { seq: (await page.eval('__editor.state().seq')) - seq0, species: await speciesNow(), active: await active(), toast: await toastNow() };
    await page.eval("__editor.dispatch({ type: 'undo' })"); await sleep(300);
    r.undone = J(await speciesNow()) === J([PIKACHU, CHARIZARD, SNORLAX]) && (await attr('aria-disabled')) === null;
    await go(page, '#/team/' + ids.t2);
    r.pikaDisabled = await page.eval('(() => { const b = document.querySelector(' + J(btn) + '); return b ? b.getAttribute("aria-disabled") : "missing"; })()');
    await go(page, '#/team/' + ids.t1);
    r.errs = errsOf(page);
    return r;
  }
  const ST_CHECKS = (r) => [
    ['the seeded team is Pikachu, Charizard, Snorlax', J(r.start) === J([PIKACHU, CHARIZARD, SNORLAX])],
    ['a team out of type order has an enabled "Sort team by type" button', r.enabled],
    ['its hover text says it is the SLOT order: the first Pokemon leads in 6v6, in 3v3 you choose the lead at team preview (it must not say the first Pokemon leads, flat)', typeof r.title === 'string' && /6v6/.test(r.title) && /3v3/.test(r.title) && /team preview/.test(r.title) && !/The first Pokemon leads\./.test(r.title), r.title],
    ['keyboard: Enter puts Normal (Snorlax), Fire/Flying (Charizard), Electric (Pikachu) in that order', J(r.after) === J([SNORLAX, CHARIZARD, PIKACHU]), J(r.after)],
    ['the slots on screen follow', r.domOk],
    ['keyboard focus is still on the Sort button after the redraw replaced it (it must not fall to the page)', r.activeAfter === 'sort-team-type', r.activeAfter],
    ['the live region (#toast, role status, aria-live polite) announces the result', r.toast.text === 'sorted by type: Snorlax, Charizard, Pikachu' && r.toast.role === 'status' && r.toast.live === 'polite', J(r.toast)],
    ['once sorted the button is aria-disabled (still focusable: not "disabled") and its hover text says why', r.ariaDisabledAfter === 'true' && r.disabledAfter === false && /Already in type order/.test(r.titleAfter), J([r.ariaDisabledAfter, r.disabledAfter, r.titleAfter])],
    ['one edit, labelled "sort Pokemon" in the undo list (the stack is capped at 20, so the length cannot be compared)', r.seq1 === 1 && r.label === 'sort Pokemon', J([r.seq1, r.label])],
    ['Enter again on the sorted team: nothing moves, no new edit, focus stays, and the live region says it is already sorted', r.again.seq === 1 && J(r.again.species) === J(r.after) && r.again.active === 'sort-team-type' && r.again.toast.text === 'the team is already sorted by type', J(r.again)],
    ['undo brings the old order back and the button is live again', r.undone],
    ['a team of two Pikachu is already in order, so the button is aria-disabled', r.pikaDisabled === 'true', r.pikaDisabled],
    ['no page errors', r.errs.length === 0, r.errs.slice(0, 2).join(' | ')],
  ];
  await runCase('sort a team by type', { port: CDP + 27, width: 1280, height: 800 }, async (page) => {
    const r = await teamSortProbe(page, PAGE);
    for (const [n, c, d] of ST_CHECKS(r)) ok(c === true, 'ST: ' + n, d);
    await page.screenshot(path.join(OUT, 'typesort_team_1280.png'));
  });
  // the same probe against copies with the fix removed: the original defect (a disabled button, no focus key) and no focus key alone. Each must FAIL the focus check.
  await runCase('negative control: sort team button is disabled when sorted', { port: CDP + 32, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', "'aria-disabled': inOrder ? 'true' : null, dataset: { act: 'sort-team-type', fk: 'sort-team-type' },", "disabled: inOrder, dataset: { act: 'sort-team-type' },", 17, async (url) => {
      const r = await teamSortProbe(page, url);
      const failed = ST_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.some((n) => /keyboard focus is still on the Sort button/.test(n)) && failed.some((n) => /Enter again on the sorted team/.test(n)), 'ST negative control (disabled button): the focus and Enter-again checks FAIL (' + failed.length + ' failed)', J(failed).slice(0, 400));
    });
  });
  await runCase('negative control: sort team button has no focus key', { port: CDP + 33, width: 1280, height: 800 }, async (page) => {
    await withMutant('js/editor_views.js', "dataset: { act: 'sort-team-type', fk: 'sort-team-type' },", "dataset: { act: 'sort-team-type' },", 18, async (url) => {
      const r = await teamSortProbe(page, url);
      const failed = ST_CHECKS(r).filter(([, c]) => c !== true).map(([n]) => n);
      ok(failed.some((n) => /keyboard focus is still on the Sort button/.test(n)), 'ST negative control (no data-fk): the focus check FAILS (' + failed.length + ' failed)', J(failed).slice(0, 400));
    });
  });

} finally {
  if (server) { try { server.kill(); } catch (_e) { /* gone */ } }
  spawnSync(process.execPath, [path.join(root, 'tools', 'browser_leak_guard.js'), 'reap'], { stdio: 'ignore', cwd: root });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
}
console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed; machine load after: ' + loadPct());
if (fail) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);

// set the hidden file input through CDP (the real input, the real change event)
async function fileInput(page, file) {
  const doc = await page.send('DOM.getDocument', { depth: 1 });
  const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[data-import-file]' });
  if (!node.nodeId) throw new Error('no import file input on this screen');
  await page.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] });
}
