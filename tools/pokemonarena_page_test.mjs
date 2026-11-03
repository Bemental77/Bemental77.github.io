// tools/pokemonarena_page_test.mjs - tests for the /pokemonarena/ page (the HUB): Node units first, then headless Chrome.
//
//   node tools/pokemonarena_page_test.mjs            # starts PORT=8097 node tools/devserver.mjs itself
//   ARENA_SKIP_BROWSER=1 node tools/pokemonarena_page_test.mjs   # Node units only
//   ARENA_PORT=8097 ARENA_CDP=9291 ARENA_OUT=<dir> ARENA_ROM=<gba> ARENA_BASE=<running server>   # overrides
//
// NODE UNITS (no browser): romfetch (every failure kind, progress, the typeof-not-|| ASSET_BASE rule), computeScale (integer device-pixel
// scale), the hub's address-hash and remembered-settings readers. Each has mutants that must be caught and an unmutated twin that must stay quiet.
//
// BROWSER (tools/headless_cdp.mjs: ONE headless Chrome at a time, throwaway profile, bare CDP, --mute-audio, never the user's browser): mobile
// 390x844 @3x, landscape 844x390, small phones 320x568 and 568x320, desktop 1280x800, plus the two ROM error screens. Per case it asserts the
// canvas is non-blank, the page raised no console errors, scrollWidth <= innerWidth, every touch button is >= 44 px, the canvas is a whole
// number of device pixels per source pixel, the canvas pixels EQUAL what Node renders for the same hub view, the header does not wrap, the page
// shows no word "demo" anywhere (text, title, labels), touch taps and keys move the menu cursor, and a missing / wrong ROM shows the error
// screen. The old single-screen "battle screen demo" page is gone: its checks live on as the hub's. Screenshots go to ARENA_OUT and are meant
// to be opened and looked at.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, ROM_PATH, CDP0, BASE, sleep, mod, loadPct, key, tapSel, errsOf } = L;
const J = L.J;
const OUT = process.env.ARENA_OUT || L.DEFAULT_OUT;
const C = L.makeCounter('page');
const ok = C.ok;
const RF = await mod('romfetch.js');
const BOOT = await mod('boot.js');
const B = await mod('battle_ui.js');
const T = await mod('tables.js');
const ROMJS = await mod('rom.js');
const HM = await mod('hub_model.js');
const HS = await mod('hub_screen.js');

const sha1 = (...p) => { const h = crypto.createHash('sha1'); for (const x of p) h.update(x); return h.digest('hex'); };
const rom = L.readRom();
console.log('pokemonarena page test (the hub); ROM', ROM_PATH, rom.length, 'B; node', process.version);

/* ============================================================================ Node units: romfetch */

function fakeResponse(bytes, { status = 200, chunk = 4 * 1048576, length = true } = {}) {
  let o = 0;
  const body = { getReader: () => ({ read: async () => { if (o >= bytes.length) return { done: true }; const v = bytes.subarray(o, Math.min(bytes.length, o + chunk)); o += v.length; return { done: false, value: v }; } }) };
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (k.toLowerCase() === 'content-length' && length ? String(bytes.length) : null) }, body, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}
async function expectKind(fn, kind) { try { await fn(); return 'no error'; } catch (e) { return e instanceof RF.RomLoadError && e.kind === kind ? true : (e.kind || e.name) + ': ' + e.message; } }

async function checkRomfetch(R) {
  const f = [];
  const t = (name, cond) => { if (cond !== true) f.push(name + (cond === false ? '' : ' [' + cond + ']')); };
  // ASSET_BASE rule: a string (even '') is used verbatim, anything else falls back
  t('empty-string ASSET_BASE is honoured (not replaced by the default)', R.romUrl({ window: { ASSET_BASE: '' } }) === '/gba/gbaWasm/roms/Pokemon%20SoulGold%20(v1.1.1).gba');
  t('/gamedata ASSET_BASE', R.romUrl({ window: { ASSET_BASE: '/gamedata' } }) === '/gamedata/gba/gbaWasm/roms/Pokemon%20SoulGold%20(v1.1.1).gba');
  t('missing ASSET_BASE falls back to /gamedata', R.romUrl({ window: {} }).startsWith('/gamedata/gba/'));
  t('non-string ASSET_BASE falls back to /gamedata', R.romUrl({ window: { ASSET_BASE: 123 } }).startsWith('/gamedata/gba/'));
  t('another host base is kept', R.romUrl({ window: { ASSET_BASE: 'https://x.example/lib' } }).startsWith('https://x.example/lib/gba/'));
  // happy path with progress
  { const prog = [];
    const bytes = await R.fetchRom({ url: 'u', fetchImpl: async () => fakeResponse(rom), onProgress: (g, tot) => prog.push([g, tot]) });
    t('fetch returns every byte', bytes.length === rom.length && sha1(bytes) === sha1(rom));
    t('progress is monotonic, ends at the total, and has several steps', prog.length >= 4 && prog.every((p, i) => i === 0 || p[0] > prog[i - 1][0]) && prog[prog.length - 1][0] === rom.length && prog.every((p) => p[1] === rom.length));
    const v = await R.verifyRom(bytes); t('verifyRom accepts the pinned ROM and returns its sha256', v.sha256 === ROMJS.PINNED.sha256);
    const lv = await R.loadVerifiedRom({ url: 'u', fetchImpl: async () => fakeResponse(rom) }); t('loadVerifiedRom end to end', lv.sha256 === ROMJS.PINNED.sha256 && lv.bytes.length === rom.length); }
  // failure kinds
  t('HTTP 404 -> missing', await expectKind(() => R.fetchRom({ url: 'u', fetchImpl: async () => fakeResponse(new Uint8Array(10), { status: 404 }) }), 'missing'));
  t('network failure -> missing', await expectKind(() => R.fetchRom({ url: 'u', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), 'missing'));
  t('truncated download -> length', await expectKind(() => R.verifyRom(rom.subarray(0, rom.length - 1)), 'length'));
  t('an HTML page served with 200 -> length', await expectKind(() => R.verifyRom(new TextEncoder().encode('<html>404</html>')), 'length'));
  { const bad = rom.slice(); bad[0xAC] = 0x41; t('wrong game code -> format', await expectKind(() => R.verifyRom(bad), 'format')); }
  { const bad = new Uint8Array(rom.length); t('all zeros of the right length -> format', await expectKind(() => R.verifyRom(bad), 'format')); }
  { let msg = ''; try { await R.verifyRom(new Uint8Array(rom.length)); } catch (e) { msg = String(e.message); } t('a zeroed header reads as "(blank)", never as a literal backslash-u escape or a raw control character', msg.includes('(blank)') && !/\\u[0-9a-f]{4}/i.test(msg) && !/[\x00-\x1f]/.test(msg)); }
  { const bad = rom.slice(); bad[0x200000] ^= 1; t('one flipped bit outside the header -> hash', await expectKind(() => R.verifyRom(bad), 'hash')); }
  { const bad = rom.slice(); bad[rom.length - 1] ^= 0x80; t('last byte changed -> hash', await expectKind(() => R.verifyRom(bad), 'hash')); }
  t('interrupted stream -> missing', await expectKind(() => R.fetchRom({ url: 'u', fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => { throw new Error('reset'); } }) } }) }), 'missing'));
  return f;
}
{
  const real = await checkRomfetch(RF), twin = await checkRomfetch(RF);
  ok(real.length === 0, 'U1. romfetch passes every check', real.slice(0, 5).join('; '));
  ok(twin.length === 0, 'U1. unmutated twin stays quiet');
  const mutants = {
    'ASSET_BASE read with || (the documented worst failure)': { ...RF, romUrl: (s) => { const w = s.window || s; return (w.ASSET_BASE || '/gamedata') + RF.ROM_PATH; } },
    'skips the SHA-256 check': { ...RF, verifyRom: (b) => RF.verifyRom(b, async () => ROMJS.PINNED.sha256) },
    'skips the length check': { ...RF, verifyRom: async (b) => { const pad = new Uint8Array(ROMJS.PINNED.length); pad.set(b.subarray(0, Math.min(b.length, pad.length))); return RF.verifyRom(pad); } },
    'prints the raw JSON escapes of a zeroed title (the shipped format-screen defect)': { ...RF, verifyRom: async (b, h) => { try { return await RF.verifyRom(b, h); } catch (e) { if (e.kind === 'format') e.message = e.message.replace('(blank)', JSON.stringify('\0\0').slice(1, -1)); throw e; } } },
    'treats 404 as success': { ...RF, fetchRom: (o) => RF.fetchRom({ ...o, fetchImpl: async () => { const r = await o.fetchImpl(); return { ...r, ok: true }; } }) },
  };
  for (const [name, m] of Object.entries(mutants)) { const r = await checkRomfetch(m); ok(r.length > 0, 'U1. mutant "' + name + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
}

/* ============================================================================ Node units: scale / query / keys */

// THE RULE (js/screenfit.js): the picture takes the whole room it is given (3:2), snapped to a whole device-pixel scale only when that costs under 6 %.
// The old rule was floor-only, which is why a phone showed a small picture: 358 css px @3x was given 4x = 320 px, 390 @3x was given 324, 360 @2x was given 244.
function checkScale(computeScale) {
  const f = []; const t = (n, c) => { if (!c) f.push(n); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  let r = computeScale({ availW: 390, availH: 600, dpr: 3 }); t('iPhone-wide room 390x600 @3x FILLS the width (390 css px, not the 324 a whole 4x gave)', near(r.cssW, 390) && near(r.cssH, 260) && !r.whole && near(r.k, 4.875));
  r = computeScale({ availW: 358, availH: 600, dpr: 3 }); t('358x600 @3x fills 358 css px (the old rule gave 320)', near(r.cssW, 358));
  r = computeScale({ availW: 360, availH: 600, dpr: 2 }); t('a 360 px phone @2x fills 360 css px (3x exactly; the old rule gave 2x = 240)', r.k === 3 && r.whole && near(r.cssW, 360));
  r = computeScale({ availW: 1248, availH: 600, dpr: 1 }); t('desktop 1248x600 @1x fills the height: 900x600 (the old rule gave 720x480)', near(r.cssH, 600) && near(r.cssW, 900));
  r = computeScale({ availW: 1248, availH: 640, dpr: 1 }); t('height exactly 4x -> 4x, whole', r.k === 4 && r.whole && r.cssW === 960);
  r = computeScale({ availW: 1248, availH: 639, dpr: 1 }); t('one pixel short of 4x fills the 639 (it does not drop to 3x)', near(r.cssH, 639) && !r.whole);
  r = computeScale({ availW: 1248, availH: 650, dpr: 1 }); t('within 6 % above a whole scale: keeps the whole 4x (650 -> 640)', r.k === 4 && r.whole && r.cssH === 640);
  r = computeScale({ availW: 1248, availH: 680, dpr: 1 }); t('4.25x of room (4 is 94.1 % of it): keeps 4x', r.k === 4 && r.whole);
  r = computeScale({ availW: 1248, availH: 683.2, dpr: 1 }); t('4.27x of room (4 is 93.7 % of it): fills', !r.whole && near(r.cssH, 683.2));
  r = computeScale({ availW: 1248, availH: 560, dpr: 1 }); t('3.5x of room fills (a 3x here would waste 14 %)', !r.whole && near(r.cssH, 560));
  r = computeScale({ availW: 358, availH: 500, dpr: 1.5 }); t('fractional dpr 1.5: 358 css fills 358 css', near(r.cssW, 358));
  r = computeScale({ availW: 100, availH: 50, dpr: 1 }); t('a room smaller than the picture still draws it 1:1', r.k === 1 && r.cssW === 240 && r.cssH === 160);
  r = computeScale({ availW: 400, availH: 4000, dpr: 2 }); t('width-limited @2x: 400 css fills 400 css', near(r.cssW, 400));
  // properties over a grid of rooms and densities
  for (let w = 120; w <= 1600; w += 37) for (const h of [200, 333, 640, 901]) for (const dpr of [1, 1.25, 1.5, 2, 2.625, 3]) {
    const s = computeScale({ availW: w, availH: h, dpr });
    const room = Math.min((w * dpr) / 240, (h * dpr) / 160);
    const where = ' at ' + w + 'x' + h + '@' + dpr;
    if (Math.abs((s.cssW * 2) / 3 - s.cssH) > 1e-6) { t('the picture keeps its 3:2 shape' + where, false); w = 1e9; break; }
    if (room < 1) { if (!(s.k === 1 && s.cssW === 240 / dpr)) { t('below 1x of room it is drawn 1:1' + where, false); w = 1e9; break; } continue; }
    if (s.cssW > w + 1e-6 || s.cssH > h + 1e-6) { t('it never exceeds its room' + where, false); w = 1e9; break; }
    if (Math.max(s.cssW / w, s.cssH / h) < 0.94 - 1e-9) { t('it fills at least 94 % of one axis of its room' + where, false); w = 1e9; break; }
    if (s.whole && Math.abs(s.k - Math.round(s.k)) > 1e-9) { t('"whole" means a whole number of device pixels' + where, false); w = 1e9; break; }
    if (!s.whole && !(near(s.cssW, w) || near(s.cssH, h))) { t('a filled picture touches the room on one axis' + where, false); w = 1e9; break; }
    if (Math.abs(s.cssW * dpr - 240 * s.k) > 1e-6) { t('k is the number of device pixels per source pixel' + where, false); w = 1e9; break; }
  }
  return f;
}
{
  const real = checkScale(BOOT.computeScale);
  ok(real.length === 0, 'U2. computeScale passes every check', real.slice(0, 4).join('; '));
  ok(checkScale(BOOT.computeScale).length === 0, 'U2. unmutated twin stays quiet');
  const floorOnly = ({ availW, availH, dpr = 1 }) => { const k = Math.max(1, Math.floor(Math.min((availW * dpr) / 240, (availH * dpr) / 160) + 1e-9)); return { k, cssW: (240 * k) / dpr, cssH: (160 * k) / dpr, whole: true }; };
  const fill = (snap) => ({ availW, availH, dpr = 1 }) => { const e = Math.min((availW * dpr) / 240, (availH * dpr) / 160); if (!(e >= 1)) return { k: 1, cssW: 240 / dpr, cssH: 160 / dpr, whole: true }; const wk = Math.floor(e + 1e-9); if (wk / e >= snap) return { k: wk, cssW: (240 * wk) / dpr, cssH: (160 * wk) / dpr, whole: true }; const cssW = Math.min(availW, (availH * 240) / 160); return { k: (cssW * dpr) / 240, cssW, cssH: (cssW * 160) / 240, whole: false }; };
  const mut = {
    'the OLD rule: a whole scale only (floor) - the picture is small on a phone': floorOnly,
    'rounds instead of flooring (overflows)': ({ availW, availH, dpr = 1 }) => { const k = Math.max(1, Math.round(Math.min((availW * dpr) / 240, (availH * dpr) / 160))); return { k, cssW: (240 * k) / dpr, cssH: (160 * k) / dpr, whole: true }; },
    'ignores devicePixelRatio': ({ availW, availH }) => { const k = Math.max(1, Math.floor(Math.min(availW / 240, availH / 160))); return { k, cssW: 240 * k, cssH: 160 * k, whole: true }; },
    'always fractional (never snaps to a whole scale)': fill(2),
    'snaps too eagerly (whole scale kept down to 80 %)': fill(0.8),
    'snaps to a whole scale at 99.9 % only': fill(0.999),
    'fills with the larger axis (overflows)': ({ availW, availH, dpr = 1 }) => { const cssW = Math.max(availW, (availH * 240) / 160); return { k: (cssW * dpr) / 240, cssW, cssH: (cssW * 160) / 240, whole: false }; },
    'a room under 1x shrinks the picture below its own size': ({ availW, availH, dpr = 1 }) => { const k = Math.min((availW * dpr) / 240, (availH * dpr) / 160); return { k, cssW: (240 * k) / dpr, cssH: (160 * k) / dpr, whole: false }; },
    'stretches to the room (loses the 3:2 shape)': ({ availW, availH, dpr = 1 }) => ({ k: (availW * dpr) / 240, cssW: availW, cssH: availH, whole: false }),
  };
  for (const [n, m] of Object.entries(mut)) { const r = checkScale(m); ok(r.length > 0, 'U2. mutant "' + n + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
}

/* ============================================================================ Node units: the hub's address hash and remembered settings */
{
  const fns = (pathFromHash, readSettings, writeSettings) => {
    const f = []; const t = (n, c) => { if (!c) f.push(n); };
    t('"" -> main', pathFromHash('') === 'main');
    t('#quick -> quick', pathFromHash('#quick') === 'quick');
    t('#/team -> team (a leading slash is tolerated)', pathFromHash('#/team') === 'team');
    t('#about -> about', pathFromHash('#about') === 'about');
    t('an unknown hash -> main', pathFromHash('#nowhere') === 'main');
    t('a hostile hash is never echoed: -> main', pathFromHash('#<img src=x onerror=1>') === 'main' && pathFromHash('#__proto__') === 'main' && pathFromHash('#constructor') === 'main');
    const mem = (v) => ({ getItem: () => v, setItem() {} });
    let s = readSettings(mem('{"quick":{"format":"6v6","cpu":"hard"},"team":{"profileId":"p_1","teamId":"t_2","cpu":"easy"}}'));
    t('settings round-trip', s.quick.format === '6v6' && s.quick.cpu === 'hard' && s.selection.profileId === 'p_1' && s.selection.teamId === 't_2' && s.selection.cpu === 'easy');
    s = readSettings(mem('{not json')); t('corrupt JSON -> defaults, no throw', !!(s && s.quick && s.selection && Object.keys(s.quick).length === 0));
    s = readSettings(mem('x'.repeat(5000))); t('an oversized value is ignored', Object.keys(s.quick).length === 0);
    s = readSettings(mem('{"team":{"profileId":123,"teamId":{"a":1}}}')); t('wrong types are not trusted', s.selection.profileId === null && s.selection.teamId === null);
    s = readSettings({ getItem() { throw new Error('blocked'); } }); t('throwing storage -> defaults, no throw', !!(s && s.quick));
    t('write survives throwing storage', writeSettings({ setItem() { throw new Error('quota'); } }, {}, {}) === false && writeSettings(null, {}, {}) === false);
    const m = HM.createHubModel({ quick: { format: '9v9', cpu: '__proto__' }, selection: { cpu: 'godlike' } });
    t('the model refuses out-of-contract remembered values', m.quickSettings().format === '3v3' && m.quickSettings().cpu === 'normal' && m.teamSettings().cpu === 'normal');
    return f;
  };
  const real = fns(BOOT.pathFromHash, BOOT.readSettings, BOOT.writeSettings);
  ok(real.length === 0, 'U3. hash and settings readers pass every check', real.slice(0, 4).join('; '));
  ok(fns(BOOT.pathFromHash, BOOT.readSettings, BOOT.writeSettings).length === 0, 'U3. unmutated twin stays quiet');
  const mut = {
    'any hash value is trusted as a screen': [(h) => String(h).replace(/^#\/?/, '') || 'main', BOOT.readSettings, BOOT.writeSettings],
    'a corrupt settings value throws': [BOOT.pathFromHash, (st) => JSON.parse(st.getItem('x') || '{}'), BOOT.writeSettings],
    'a throwing store is not survived on write': [BOOT.pathFromHash, BOOT.readSettings, (st, q, t2) => { st.setItem('k', JSON.stringify({ q, t2 })); return true; }],
    'wrong-typed ids are accepted': [BOOT.pathFromHash, (st) => { const j = JSON.parse(st.getItem('x')); return { quick: j.quick || {}, selection: j.team || {} }; }, BOOT.writeSettings],
  };
  for (const [n, m] of Object.entries(mut)) { let r; try { r = fns(...m); } catch (e) { r = ['threw: ' + e.message]; } ok(r.length > 0, 'U3. mutant "' + n + '" is caught', r.length ? r[0] : 'NOT CAUGHT'); }
  // the old demo surface is gone from the module
  ok(BOOT.keyToButton === undefined && BOOT.parseQuery === undefined, 'U3. boot.js no longer exports the old demo page helpers (keyToButton, parseQuery)');
}

/* ============================================================================ Node units: deploy plumbing (the ROM URL the pages fetch is a URL the site's catalogs already check) */
{
  const CU = await import(pathToFileURL(path.join(root, 'tools', 'catalog_urls.mjs')));
  const readFile = (f) => { const p = path.join(root, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const want = decodeURI(RF.romUrl({ window: { ASSET_BASE: '/gamedata' } }));
  const urlsOf = (read) => CU.extractAll(read).urls.map((u) => u[0]);
  ok(urlsOf(readFile).includes(want), 'U4. tools/catalog_urls.mjs already names the exact ROM URL the Arena pages fetch (' + want + ') through gba/gbaWasm/dist/romlist.js, so the deploy check covers it');
  const without = (f) => { const t = readFile(f); return f === 'gba/gbaWasm/dist/romlist.js' && t ? t.split('\n').filter((l) => !/SoulGold/.test(l)).join('\n') : t; };
  ok(!urlsOf(without).includes(want), 'U4. control: with the SoulGold line removed from the GBA romlist the catalog no longer names it (so the check above can fail)');
}

/* ============================================================================ Node units: deploy hygiene (every file a page references exists) */
{
  const importsOf = (entry) => {
    const seen = new Set(), missing = [], stack = [entry];
    while (stack.length) {
      const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
      if (!fs.existsSync(f)) { missing.push(path.relative(root, f)); continue; }
      const t = fs.readFileSync(f, 'utf8');
      for (const m of t.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) stack.push(path.resolve(path.dirname(f), m[1]));
    }
    return { count: seen.size, missing };
  };
  const refsOf = (html) => [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]).filter((u) => u !== '/' && !u.startsWith('//'));
  const missingRefs = (html) => refsOf(html).filter((u) => !fs.existsSync(path.join(root, decodeURI(u.split('#')[0].split('?')[0]))));
  const html = fs.readFileSync(path.join(root, 'pokemonarena', 'index.html'), 'utf8');
  ok(refsOf(html).length >= 4 && missingRefs(html).length === 0, 'U5. every file index.html references exists on disk (' + refsOf(html).join(', ') + ')', missingRefs(html).join(', '));
  ok(missingRefs(html.replace('/pokemonarena/arena.css', '/pokemonarena/arena2.css')).length === 1, 'U5. control: a renamed stylesheet reference is reported missing');
  for (const entry of ['boot.js', 'battle_boot.js', 'editor_app.js']) {
    const r = importsOf(path.join(root, 'pokemonarena', 'js', entry));
    ok(r.count >= 8 && r.missing.length === 0, 'U5. every module reachable from ' + entry + ' exists (' + r.count + ' files)', r.missing.join(', '));
  }
  const tmp = path.join(os.tmpdir(), 'arena-hygiene-' + process.pid + '.mjs'); fs.writeFileSync(tmp, "import x from './nowhere_at_all.js';\n");
  ok(importsOf(tmp).missing.length === 1, 'U5. control: an import of a file that does not exist is reported missing'); fs.unlinkSync(tmp);
  const romish = (f) => { const t = fs.readFileSync(f, 'utf8'); return /\[(?:\s*(?:0x[0-9a-f]{2}|\d{1,3}),){400,}/i.test(t); };
  const newFiles = ['index.html', 'arena.css', 'js/boot.js', 'js/hub_model.js', 'js/hub_screen.js', 'js/hub_data.js', 'README.md'].map((f) => path.join(root, 'pokemonarena', f));
  ok(newFiles.every((f) => !romish(f)) && fs.statSync(path.join(root, 'pokemonarena', 'hub.golden.json')).size < 4000, 'U5. none of the hub files holds a long literal byte array, and the golden is a short list of hashes');
  ok(romish(path.join(root, 'pokemonarena', 'js', 'hub_model.js')) === false && /\[(?:\s*\d{1,3},){400,}/.test('[' + Array(401).fill('7').join(',') + ',]'), 'U5. control: the byte-array pattern does match a 400-number literal');
}

if (process.env.ARENA_SKIP_BROWSER === '1') { C.finish(); process.exit(process.exitCode || 0); }

/* ============================================================================ browser */

const url = (q = '') => BASE + '/pokemonarena/' + q;
const nodeUi = B.createBattleUi(rom);
const nodeScreen = HS.createHubScreen(nodeUi);
const px = `(() => { const c = document.getElementById('hub'); const d = c.getContext('2d').getImageData(0, 0, 240, 160).data; const m = new Map(); for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; m.set(k, (m.get(k) || 0) + 1); } let top = 0; for (const v of m.values()) if (v > top) top = v; return { distinct: m.size, topShare: top / 38400 }; })()`;
const canvasSha1 = `(async () => { const c = document.getElementById('hub'); const d = c.getContext('2d').getImageData(0, 0, 240, 160).data; const h = await crypto.subtle.digest('SHA-1', d); return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join(''); })()`;

async function waitReady(page, ms = 90000) {
  await page.waitFor("window.__arenaHub && window.__arenaHub.state !== 'boot'", { timeoutMs: ms });
  return page.eval('({ state: __arenaHub.state, kind: __arenaHub.kind, error: __arenaHub.error })');
}
async function runCase(name, { width, height, mobile, dpr, port }, fn) {
  console.log('--- ' + name + ' (' + width + 'x' + height + ' @' + dpr + 'x' + (mobile ? ' mobile' : '') + ') ' + loadPct());
  try {
    await withBrowser({ port, width, height, mobile }, async (page) => { await page.setViewport(width, height, { mobile, dpr }); await fn(page); });
  } catch (e) { ok(false, name + ': case threw', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}

// words a player must never see on a finished game (text, title, labels, the screen-reader mirror)
const DEMO_JS = `(() => { const t = document.body.innerText + ' ' + document.title + ' ' + [...document.querySelectorAll('[aria-label],[title],[alt],[placeholder]')].map((e) => ['aria-label', 'title', 'alt', 'placeholder'].map((a) => e.getAttribute(a) || '').join(' ')).join(' ') + ' ' + (document.getElementById('live') ? document.getElementById('live').textContent : ''); return t.match(/demo|lorem|todo|placeholder|coming soon|\\[object|undefined|NaN/ig) || []; })()`;

async function commonChecks(page, tag, { pad }) {
  const t0 = Date.now();
  const st = await waitReady(page);
  console.log('  ' + tag + ': ready (ROM fetched, SHA-256 checked, art decoded, first frame drawn) ' + (Date.now() - t0) + ' ms after the load event; ' + loadPct());
  ok(st.state === 'ready', tag + ': page reaches ready', J(st));
  if (st.state !== 'ready') return false;
  await page.eval('__arenaHub.pause(true)');                   // freeze the idle animation: the frame is then a pure function of the view
  await sleep(150);
  const c = await page.eval(px);
  ok(c.distinct >= 30 && c.distinct <= 4096 && c.topShare < 0.6, tag + ': canvas is not blank (distinct colours ' + c.distinct + ', most common share ' + c.topShare.toFixed(2) + ')', J(c));
  const scroll = await page.eval('({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth })');
  ok(scroll.sw <= scroll.iw && scroll.bw <= scroll.iw, tag + ': no horizontal scroll (scrollWidth ' + scroll.sw + ' / body ' + scroll.bw + ' <= innerWidth ' + scroll.iw + ')', J(scroll));
  const sc = await page.eval("(() => { const c = document.getElementById('hub'), r = c.getBoundingClientRect(), k = window.__arenaHub.scale; return { w: parseFloat(c.style.width), h: parseFloat(c.style.height), cw: r.width, ch: r.height, dpr: window.devicePixelRatio, vw: document.documentElement.clientWidth, vh: innerHeight, k: k && k.k, whole: k && k.whole, edge: document.body.dataset.edge, pad: document.body.dataset.pad, border: parseFloat(getComputedStyle(c).borderLeftWidth) }; })()");
  // THE PICTURE FILLS ITS ROOM (screenfit.js). On a phone held upright it runs edge to edge: the whole width of the screen. On a desktop it is 3:2 and either a whole scale or the room's full size.
  const inW = sc.cw - 2 * sc.border, inH = sc.ch - 2 * sc.border;         // the frame (2 px on a desktop, none on a touch screen) is outside the 240x160 picture
  ok(Math.abs(inW / inH - 1.5) < 0.01 && Math.abs(sc.w - inW) < 0.5, tag + ': the picture is 3:2 and the size the page set (' + inW.toFixed(1) + 'x' + inH.toFixed(1) + ' css @' + sc.dpr + 'x, k=' + (sc.k && sc.k.toFixed(3)) + ')', J(sc));
  ok(Math.abs(sc.w * sc.dpr - 240 * sc.k) < 0.02, tag + ': k is the device pixels per source pixel the picture really has', J(sc));
  if (pad && sc.vw < sc.vh) ok(sc.edge === '1' && sc.border === 0 && Math.abs(sc.cw - sc.vw) < 0.5, tag + ': a phone held upright: the picture runs edge to edge (' + sc.cw.toFixed(1) + ' of ' + sc.vw + ' css px wide, no frame)', J(sc));
  const aspect = await page.eval("(() => { const r = document.getElementById('hub').getBoundingClientRect(); const cs = getComputedStyle(document.getElementById('hub')); return { r: [r.left, r.right, r.top, r.bottom], ir: cs.imageRendering, vw: document.documentElement.clientWidth, vh: innerHeight }; })()");
  ok(/pixelated|crisp/.test(aspect.ir), tag + ': image-rendering is ' + aspect.ir);
  ok(aspect.r[0] >= 0 && aspect.r[1] <= aspect.vw + 0.5, tag + ': the canvas sits inside the viewport width');
  // the pixels in the page equal what Node renders for the SAME view (so the page runs the same renderer, from the same ROM bytes)
  const view = await page.eval('__arenaHub.view()');
  const browserHash = await page.eval(canvasSha1);
  const nodeHash = sha1(nodeScreen.render(view).rgba);
  ok(browserHash === nodeHash, tag + ': canvas pixels equal the Node render of the same hub view', browserHash + ' vs ' + nodeHash);
  const zeroed = rom.slice(); zeroed.fill(0, 0x60df24, 0x60df24 + 0x2000);       // the normal font's glyph bytes: the menu text must change
  let zeroHash = null; try { zeroHash = sha1(HS.createHubScreen(B.createBattleUi(zeroed)).render(view).rgba); } catch (_e) { zeroHash = 'threw'; }
  ok(zeroHash !== nodeHash, tag + ': control: the same view rendered from a ROM with the font bytes zeroed is a DIFFERENT picture (so the equality above can fail)');
  // touch buttons
  const btns = await page.eval("[...document.querySelectorAll('.pbtn')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, w: r.width, h: r.height, vis: r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' && b.offsetParent !== null }; })");
  if (pad) ok(btns.length === 6 && btns.every((b) => b.vis && b.w >= 44 && b.h >= 44), tag + ': all 6 touch buttons are visible and >= 44 px (min ' + Math.min(...btns.map((b) => Math.min(b.w, b.h))).toFixed(0) + ' px)', J(btns));
  else ok(btns.every((b) => !b.vis), tag + ': touch buttons are hidden on a desktop without touch');
  // header: one row at every width (the way back, Sound, Controls and the Fullscreen switch fit in 288 px; a second row pushed the bottom touch buttons off a 568 px screen), every control >= 44 px, nothing wrapped
  const head = await page.eval("(() => { const t = document.getElementById('top'); const kids = [...t.querySelectorAll('a, button')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className, w: r.width, h: r.height, top: r.top, l: r.left, r: r.right }; }); const home = document.getElementById('homeLink'); const hr = home.getBoundingClientRect(); return { kids, homeH: hr.height, tops: [...new Set(kids.map((k) => Math.round(k.top)))], vw: document.documentElement.clientWidth }; })()");
  ok(head.kids.every((k) => k.w >= 43.5 && k.h >= 43.5), tag + ': header controls are >= 44 px', J(head.kids));
  ok(head.tops.length === 1, tag + ': the header is one row (controls share one top edge)', J(head.tops));
  { const fb = head.kids.find((x) => x.id === 'fullBtn'), sb = head.kids.find((x) => x.id === 'soundBtn'), cb = head.kids.find((x) => x.id === 'controlsBtn');
    ok(fb && fb.w >= 43.5 && fb.h >= 43.5 && fb.r <= head.vw - 15.5 + 0.5, tag + ': the Fullscreen button is on screen, >= 44 px, inside the gutter', J(fb));
    ok(sb && cb && fb && sb.l >= 15.5 && sb.r <= cb.l && cb.r <= fb.l + 0.5, tag + ': Sound, Controls and Fullscreen sit in that order without overlapping', J([sb, cb, fb])); }
  ok(head.homeH < 60, tag + ': the Home link does not wrap onto two lines (height ' + head.homeH.toFixed(0) + ')', J(head));
  const dem = await page.eval(DEMO_JS);
  ok(dem.length === 0, tag + ': no "demo" / placeholder / [object / undefined / NaN anywhere in the text, title, labels or live region', J(dem));
  const errs = errsOf(page);
  ok(errs.length === 0, tag + ': no page errors or console errors', errs.slice(0, 3).join(' | '));
  return true;
}

const cursorOf = (page) => page.eval('__arenaHub.view().menu.cursor');
async function interact(page, tag, { touch }) {
  const h0 = await page.eval(canvasSha1);
  ok((await cursorOf(page)) === 0, tag + ': the cursor starts on QUICK BATTLE');
  if (touch) { await tapSel(page, '#bDown'); } else await key(page, 'down');
  await sleep(120);
  ok((await cursorOf(page)) === 1, tag + ': ' + (touch ? 'tapping the on-screen down button' : 'ArrowDown') + ' moves the cursor to BATTLE WITH MY TEAM', String(await cursorOf(page)));
  ok((await page.eval(canvasSha1)) !== h0, tag + ': the canvas changes when the cursor moves');
  if (touch) await tapSel(page, '#bUp'); else await key(page, 'up');
  await sleep(120);
  ok((await cursorOf(page)) === 0, tag + ': and back up');
  ok((await page.eval(canvasSha1)) === h0, tag + ': back on the first row the canvas is byte-identical to the start (deterministic redraw)');
  // A opens QUICK BATTLE, B comes back
  if (touch) await tapSel(page, '#bA'); else await key(page, 'a');
  await sleep(150);
  ok((await page.eval('__arenaHub.model.path()')) === 'quick' && (await page.eval('location.hash')) === '#quick', tag + ': A opens the quick-battle screen and the address carries #quick', await page.eval('location.hash'));
  ok((await page.eval('document.title')) === 'Pokemon Arena - Quick Battle', tag + ': the document title follows the screen', await page.eval('document.title'));
  if (touch) await tapSel(page, '#bB'); else await key(page, 'b');
  await sleep(150);
  ok((await page.eval('__arenaHub.model.path()')) === 'main', tag + ': B goes back to the main menu');
}

let server = null;
try {
  console.log('before the browser: ' + loadPct() + '; reaping leaked browsers');
  L.reapLeaks();
  server = await L.startServer();
  console.log('dev server up on ' + BASE + ' (node tools/devserver.mjs, Range-capable)');
  fs.mkdirSync(OUT, { recursive: true });

  // ---------------------------------------------------------------- the root redirect keeps working
  await runCase('root redirect', { width: 1280, height: 800, mobile: false, dpr: 1, port: CDP0 }, async (page) => {
    await page.navigate(BASE + '/pokemonarena.html?x=1');
    await sleep(1500);
    const where = await page.eval('location.pathname + location.search');
    ok(where === '/pokemonarena/?x=1', 'redirect: /pokemonarena.html?x=1 lands on /pokemonarena/ with the query carried', where);
    await waitReady(page);
    ok((await page.eval('__arenaHub.state')) === 'ready', 'redirect: and the hub boots');
  });

  // ---------------------------------------------------------------- mobile portrait
  await runCase('mobile portrait', { width: 390, height: 844, mobile: true, dpr: 3, port: CDP0 }, async (page) => {
    const tag = 'M390x844';
    await page.navigate(url());
    if (!(await commonChecks(page, tag, { pad: true }))) return;
    await page.eval('__arenaHub.setMascot(25)');
    await page.screenshot(path.join(OUT, 'page_mobile_390x844.png'));
    await interact(page, tag, { touch: true });
  });

  // ---------------------------------------------------------------- mobile landscape
  await runCase('mobile landscape', { width: 844, height: 390, mobile: true, dpr: 3, port: CDP0 }, async (page) => {
    const tag = 'L844x390';
    await page.navigate(url());
    if (!(await commonChecks(page, tag, { pad: true }))) return;
    await page.eval('__arenaHub.setMascot(25)');
    await page.screenshot(path.join(OUT, 'page_landscape_844x390.png'));
    const lay = await page.eval("({ layout: document.body.dataset.layout })");
    ok(lay.layout === 'landscape', tag + ': landscape layout engaged', J(lay));
    await interact(page, tag, { touch: true });
  });

  // ---------------------------------------------------------------- small phones: the pad must fit and clip nothing
  const GEOM = `(() => { const bt = [...document.querySelectorAll('.pbtn')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.id, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; }); const c = document.getElementById('hub').getBoundingClientRect(); return { iw: innerWidth, sw: document.documentElement.scrollWidth, btns: bt, canvas: { l: c.left, r: c.right, t: c.top, b: c.bottom, w: c.width } }; })()`;
  const smallFindings = (g, deviceW, minCanvas, portrait) => {
    const f = []; const t = (n, c) => { if (!c) f.push(n); };
    t('the layout viewport did not widen (innerWidth ' + g.iw + ' vs device ' + deviceW + ')', g.iw === deviceW);
    t('no horizontal scroll (scrollWidth ' + g.sw + ' <= ' + g.iw + ')', g.sw <= g.iw);
    t('every touch button lies inside the viewport (max right ' + Math.max(...g.btns.map((b) => b.r)).toFixed(0) + ')', g.btns.length === 6 && g.btns.every((b) => b.l >= 0 && b.r <= g.iw + 0.5));
    t('every touch button is >= 44 px (min ' + Math.min(...g.btns.map((b) => Math.min(b.w, b.h))).toFixed(0) + ')', g.btns.every((b) => b.w >= 44 && b.h >= 44));
    if (portrait) t('the canvas is centred (left ' + g.canvas.l.toFixed(1) + ', right gap ' + (g.iw - g.canvas.r).toFixed(1) + ')', Math.abs(g.canvas.l - (g.iw - g.canvas.r)) <= 1.5);
    t('the canvas lies inside the viewport and overlaps no button', g.canvas.l >= 0 && g.canvas.r <= g.iw + 0.5 && g.btns.every((b) => b.r <= g.canvas.l + 0.5 || b.l >= g.canvas.r - 0.5 || b.b <= g.canvas.t + 0.5 || b.t >= g.canvas.b - 0.5));
    t('the canvas is at least ' + minCanvas + ' css px wide (' + g.canvas.w.toFixed(0) + ')', g.canvas.w >= minCanvas);
    return f;
  };
  // negative control: oversized pad buttons (what a pad not sized for 320 px would be) must trip the same predicate
  const BIG_PAD_CSS = '#dpad{grid-template-columns:repeat(3,72px)!important;grid-template-rows:repeat(3,72px)!important;gap:4px!important} #dpad .pbtn{width:72px!important;height:72px!important} #ab .abrow{gap:30px!important} #ab .pbtn{width:80px!important;height:80px!important}';
  for (const [name, W, H, tag, minCanvas, shot, portrait] of [['phone 320 portrait', 320, 568, 'P320x568', 240, 'page_small_320x568.png', true], ['phone 568x320 landscape', 568, 320, 'L568x320', 240, 'page_small_568x320.png', false]]) {
    await runCase(name, { width: W, height: H, mobile: true, dpr: 2, port: CDP0 }, async (page) => {
      await page.navigate(url());
      if (!(await commonChecks(page, tag, { pad: true }))) return;
      const g = await page.eval(GEOM);
      const f1 = smallFindings(g, W, minCanvas, portrait);
      ok(f1.length === 0, tag + ': the small-screen layout fits (no widening, no clipping, buttons >= 44 px, canvas >= ' + minCanvas + ' css px)', f1.join('; '));
      ok(smallFindings(await page.eval(GEOM), W, minCanvas, portrait).length === 0, tag + ': unmutated twin (second measurement) stays quiet');
      await page.eval('__arenaHub.setMascot(25)');
      await page.screenshot(path.join(OUT, shot));
      await page.eval("(async () => { const s = document.createElement('style'); s.id = 'mutant'; s.textContent = " + J(BIG_PAD_CSS) + "; document.head.appendChild(s); window.dispatchEvent(new Event('resize')); await new Promise((r) => setTimeout(r, 250)); return true; })()");
      const gm = await page.eval(GEOM), fm = smallFindings(gm, W, minCanvas, portrait);
      ok(fm.length > 0, tag + ': mutant "oversized pad buttons" is caught', fm.length ? fm[0] : 'NOT CAUGHT ' + J(gm).slice(0, 200));
    });
  }

  // ---------------------------------------------------------------- desktop
  await runCase('desktop', { width: 1280, height: 800, mobile: false, dpr: 1, port: CDP0 }, async (page) => {
    const tag = 'D1280x800';
    await page.navigate(url());
    if (!(await commonChecks(page, tag, { pad: false }))) return;
    await page.eval('__arenaHub.setMascot(25)');
    await page.screenshot(path.join(OUT, 'page_desktop_1280x800.png'));
    await interact(page, tag, { touch: false });
    const status = await page.eval("document.getElementById('romStatus').textContent");
    ok(/ROM verified: Pokemon SoulGold v1\.1\.1 \(SHA-256 8071e2c3/.test(status), tag + ': the visible ROM status says the ROM was verified', status);
    const keysHint = await page.eval("getComputedStyle(document.getElementById('keys')).display");
    ok(keysHint !== 'none', tag + ': the keyboard hint is shown on a desktop');
    // negative control for the "no demo wording" predicate: put the words on the page and the predicate must see them
    await page.eval("(() => { const p = document.createElement('p'); p.id = 'mutant'; p.textContent = 'Battle screen demo'; document.body.appendChild(p); return true; })()");
    ok((await page.eval(DEMO_JS)).length > 0, tag + ': mutant "a Battle screen demo line" is caught by the no-demo predicate');
    await page.eval("document.getElementById('mutant').remove()");
    ok((await page.eval(DEMO_JS)).length === 0, tag + ': twin: with the line removed the predicate is quiet again');
  });

  // ---------------------------------------------------------------- ROM missing
  await runCase('ROM missing', { width: 390, height: 844, mobile: true, dpr: 2, port: CDP0 }, async (page) => {
    const tag = 'E-missing';
    // lib/asset_base.js assigns window.ASSET_BASE = '/gamedata'; make that assignment a no-op and point it nowhere
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window, 'ASSET_BASE', { value: '/nowhere', writable: false, configurable: false });" });
    await page.navigate(url());
    const st = await waitReady(page, 30000);
    ok(st.state === 'error' && st.kind === 'missing', tag + ': a missing ROM ends in the error state, kind "missing"', J(st));
    const vis = await page.eval("({ err: !document.getElementById('error').hidden, canvas: !document.getElementById('hub').hidden, boot: !document.getElementById('boot').hidden, title: document.getElementById('errTitle').textContent, msg: document.getElementById('errMsg').textContent, text: document.getElementById('error').innerText, tech: document.getElementById('errDetail').title, sw: document.documentElement.scrollWidth, iw: innerWidth, retry: !document.getElementById('retry').hidden, controls: getComputedStyle(document.getElementById('controlsBtn')).visibility })");
    ok(vis.err && !vis.canvas && !vis.boot, tag + ': the error screen is shown, the canvas and boot panel are hidden', J(vis));
    // W1 fix D6/D7: plain words for the player (what failed, what to do); the server path and status go to the console and the hover text, never to the screen
    ok(/game file/.test(vis.title + vis.msg) && /404/.test(vis.msg), tag + ': it says in plain words what failed (the game file, error 404)', vis.title + ' | ' + vis.msg);
    ok(!/\/nowhere|gbaWasm|\.gba|\/roms\//.test(vis.text) && /\/nowhere\/gba\/gbaWasm\/roms\//.test(vis.tech), tag + ': no server path on the screen; it is in the detail line\'s hover text for a developer', vis.text.slice(0, 120) + ' || ' + vis.tech);
    ok(vis.sw <= vis.iw, tag + ': the error screen does not scroll sideways');
    ok(vis.retry && vis.controls === 'hidden', tag + ': Try again is offered and the Controls button (which needs the ROM) is not');
    const btn = await page.eval("[...document.querySelectorAll('#error button, #error a')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return [e.textContent.trim(), r.width, r.height]; })");
    ok(btn.length === 2 && btn.every(([, w, h]) => w >= 44 && h >= 44), tag + ': Try again and Back to the site are both >= 44 px', J(btn));
    ok((await page.eval(DEMO_JS)).length === 0, tag + ': the error screen has no demo / placeholder wording');
    await page.screenshot(path.join(OUT, 'page_error_missing.png'));
  });

  // ---------------------------------------------------------------- wrong ROM (one flipped byte, served with a 200)
  await runCase('wrong ROM', { width: 1280, height: 800, mobile: false, dpr: 1, port: CDP0 }, async (page) => {
    const tag = 'E-wrongrom';
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { const orig = window.fetch.bind(window); window.fetch = async (u, o) => { const r = await orig(u, o); if (/\\.gba/.test(String(u))) { const b = new Uint8Array(await r.arrayBuffer()); b[0x200000] ^= 1; return new Response(b, { status: 200 }); } return r; }; })();" });
    await page.navigate(url());
    const st = await waitReady(page, 90000);
    ok(st.state === 'error' && st.kind === 'hash', tag + ': a ROM with one flipped bit is refused, kind "hash"', J(st));
    const vis = await page.eval("({ err: !document.getElementById('error').hidden, canvas: !document.getElementById('hub').hidden, title: document.getElementById('errTitle').textContent, msg: document.getElementById('errMsg').textContent })");
    ok(vis.err && !vis.canvas && /not the game file/.test(vis.title) && /v1\.1\.1/.test(vis.msg), tag + ': the screen says this is not the v1.1.1 game file', vis.title + ' | ' + vis.msg.slice(0, 100));
    await page.screenshot(path.join(OUT, 'page_error_wrongrom.png'));
  });
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
