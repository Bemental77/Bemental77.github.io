// tools/pokemonarena_trainer_page_test.mjs -- THE FIRST VISIT AND THE TRAINER, in a real headless Chrome with real IndexedDB (pokemonarena/INAPP.md "TRAINER", APP-SHELL's part):
// an EMPTY browser that opens /pokemonarena/ is greeted IN THE PICTURE by the NEW TRAINER screens; a trainer is made with the KEYBOARD ONLY (M = A, N = B, the arrows, a typed name)
// or with TAPS ONLY on a phone; the main menu then names the trainer and shows the PARTNER; LATER is remembered for the tab and asked again in a new one; a schema 5 profile is greeted
// "welcome back", pre-filled, and keeps its teams; the test rigs' switch (localStorage arena.welcome = off, seeded by tools/headless_cdp.mjs) stops the greeting; a page opened at
// another address is not interrupted; the Team Builder's NEW TRAINER goes through the same screens and back; the Trainer Center's LOOK is the trainer's card.look.
//
//   node tools/pokemonarena_trainer_page_test.mjs                 the Node checks (the rigs' seed), then every browser group
//   node tools/pokemonarena_trainer_page_test.mjs --mutants       ALSO break the source one way at a time (the seed in Node; the pages through an overlay; the rigs' launcher): each break must fail
//                                                                 the named check it is aimed at
//   node tools/pokemonarena_trainer_page_test.mjs empty later     only the named browser groups (rigs empty card later back phone off address builder center)
//   env: ARENA_PORT (the dev server, 8301), ARENA_CDP (9501, +1 per browser), ARENA_OVERLAY_PORT (8311), ARENA_OUT (screenshots), ARENA_VERBOSE=1 (every check)
//
// Browsers: tools/headless_cdp.mjs only (bare CDP, a throwaway profile per browser, --mute-audio). withBrowser({ welcome: true }) leaves the greeting ON (every other suite has it seeded off).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser as realWithBrowser, WELCOME_SEED } from './headless_cdp.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';
import { tapLogical } from './pokemonarena_hub_lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const WANT_MUTANTS = args.includes('--mutants');
const ONLY = args.filter((a) => !a.startsWith('--'));
const PORT = Number(process.env.ARENA_PORT || 8301), CDP0 = Number(process.env.ARENA_CDP || 9501), OVL = Number(process.env.ARENA_OVERLAY_PORT || 8311);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-trainer-shots');
const H = 'window.__arenaHub';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
fs.mkdirSync(OUT, { recursive: true });

/* ============================================================================================================ checks (a sink collects them while a mutant runs) */
let pass = 0, fail = 0, sink = null;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { if (!sink) pass++; if (process.env.ARENA_VERBOSE && !sink) console.log('ok  ', name); return; }
  const line = name + (detail !== undefined && detail !== '' ? ' :: ' + String(detail).slice(0, 300) : '');
  if (sink) { sink.push(line); return; }
  fail++; failures.push(line); console.log('FAIL', line);
}

/* ============================================================================================================ N. the rigs' seed, in Node */
// WELCOME_SEED (tools/headless_cdp.mjs) runs before every document of every page the rigs make. It must set localStorage arena.welcome = 'off' on a /pokemonarena/ page while the key is unset,
// and do nothing anywhere else, nothing over a value already there, and never throw.
function runSeed(src, pathname, store, { throws = false } = {}) {
  const ls = { getItem: (k) => { if (throws) throw new Error('SecurityError'); return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: (k, v) => { if (throws) throw new Error('SecurityError'); store[k] = String(v); } };
  const ctx = { location: { pathname }, window: null };
  ctx.window = { localStorage: ls };
  let threw = null;
  try { vm.runInNewContext(src, ctx); } catch (e) { threw = e; }
  return { store, threw };
}
function seedChecks(src) {
  const a = runSeed(src, '/pokemonarena/', {});
  ok(a.store['arena.welcome'] === 'off' && !a.threw, 'N1 the seed switches the greeting off on the hub (/pokemonarena/, key unset)', J(a));
  const b = runSeed(src, '/pokemonarena/battle.html', {});
  ok(b.store['arena.welcome'] === 'off', 'N2 ... on every /pokemonarena/ page (the battle page, the editor)', J(b));
  const c = runSeed(src, '/pokemonarena/', { 'arena.welcome': 'on' });
  ok(c.store['arena.welcome'] === 'on', 'N3 a value already there (a test that set the key itself) is left as it is', J(c));
  const d = runSeed(src, '/gba.html', {}), e = runSeed(src, '/', {}), f = runSeed(src, '/pokemonarena.html', {});
  ok(!('arena.welcome' in d.store) && !('arena.welcome' in e.store) && !('arena.welcome' in f.store), 'N4 any other page of the site is not touched', J([d, e, f]));
  const g = runSeed(src, '/pokemonarena/', {}, { throws: true });
  ok(!g.threw, 'N5 storage that throws (blocked) does not throw out of the seed', String(g.threw));
}
const SEED_MUTANTS = [
  { id: 'SM1', what: 'the seed is installed on every path', from: "location.pathname.indexOf('/pokemonarena/') === 0 && ", to: '', expect: 'N4' },
  { id: 'SM2', what: 'the seed overwrites a value already there', from: " && window.localStorage.getItem('arena.welcome') === null", to: '', expect: 'N3' },
  { id: 'SM3', what: 'the seed writes the wrong value', from: "setItem('arena.welcome', 'off')", to: "setItem('arena.welcome', 'later')", expect: 'N1' },
  { id: 'SM4', what: 'the seed does not catch a storage that throws', from: 'try { if (', to: '{ if (', expect: 'N5', also: [" } catch (_e) { /* storage blocked: the page cannot keep a profile either, and does not greet */ }", ' }'] },
];

/* ============================================================================================================ the page helpers */
const KEY = { m: ['m', 'KeyM', 77], n: ['n', 'KeyN', 78], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], enter: ['Enter', 'Enter', 13] };
const press = async (page, k, wait = 110) => { const [key, code, vk] = KEY[k]; await page.press(key, code, vk, 30); await sleep(wait); };
async function typeWord(page, s) { for (const ch of s) { const up = ch.toUpperCase(); await page.press(ch, /[a-z]/i.test(ch) ? 'Key' + up : 'Digit' + ch, up.charCodeAt(0), 20); await sleep(50); } }
const where = (page) => page.eval(`${H} && ${H}.model ? ${H}.model.path() : null`);
const tr = (page) => page.eval(`${H}.model.state().apps.trainer`);
const until = async (page, expr, ms = 30000) => { try { await page.waitFor(expr, { timeoutMs: ms, pollMs: 100 }); return true; } catch (_e) { return false; } };
const shot = async (page, name) => { try { await page.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* a picture is a courtesy */ } };
async function openHub(page, base, hash = '') {
  await page.navigate('about:blank');
  await page.navigate(base + '/pokemonarena/' + hash);
  const up = await until(page, `${H} && ${H}.state === 'ready'`, 60000);
  if (up) await until(page, `${H}.welcome !== undefined || ${H}.data !== undefined`, 20000);
  if (up) await until(page, `${H}.data !== undefined`, 20000);
  return up;
}
/** Walk the open picker of the new-trainer screens / the editor: A until `step` is no longer the open one (a bound on presses). */
async function stepPast(page, step, how) {
  for (let i = 0; i < 4; i++) {
    const t = await tr(page), now = t.wiz ? t.wiz.step : t.edit ? t.edit.step : null;
    if (now !== step) return true;
    await how();
    await sleep(120);
  }
  const t = await tr(page); return (t.wiz ? t.wiz.step : t.edit ? t.edit.step : null) !== step;
}
const armed = (page) => until(page, `${H}.dialog.current() && ${H}.dialog.current().armed === true`, 8000);
const asking = (page) => page.eval(`!!(${H}.dialog.current() && ${H}.dialog.current().id === 'trainer:welcome')`);
/** LET'S GO on the welcome question: A turns its pages and, on the last one, takes the highlighted option (LET'S GO, the first). Keyboard: M; phone: a tap on the text, then on the option. */
async function letsGo(page, how) {
  for (let i = 0; i < 12 && (await asking(page)); i++) {
    if (how === 'tap') { const rs = await page.eval(`${H}.model.rects()`); if (rs.length) await tapRect(page, rs[0]); else { await tapLogical(page, `${H}.canvas`, 120, 136); await sleep(160); } }
    else await press(page, 'm', 160);
  }
  return !(await asking(page));
}
/** The visible page controls (buttons, fields, dialogs): what a screen of the picture must not add. */
const controls = (page) => page.eval(`[...document.querySelectorAll('button, input, select, textarea, dialog, form, [role=dialog]')].filter((e) => !e.hidden && (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map((e) => e.tagName + '#' + (e.id || e.className)).sort().join()`);
const madeCount = `(${H}.data && ${H}.data.profiles ? ${H}.data.profiles.filter((p) => p.card && p.card.made).length : 0)`;
/** In the page: the store's view of the profiles (store.js through its own module). */
const storeRead = (page) => page.eval(`(async () => { const S = await import('/pokemonarena/js/store.js'); const st = await S.openStore(); const out = []; for (const r of await st.listProfiles()) { if (!r || !r.id) continue; const l = await st.loadProfile(r.id); if (l.ok) out.push({ id: l.profile.id, name: l.profile.trainerName, schema: l.profile.schemaVersion, card: l.profile.card, avatar: l.profile.avatar, teams: l.profile.teams.map((t) => t.name), box: l.profile.box.length }); } return { active: await st.getActiveId(), list: out }; })()`);
const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const tapRect = async (page, r) => { const c = centerOf(r); await tapLogical(page, `${H}.canvas`, c.x, c.y); await sleep(160); };

/* ============================================================================================================ the browser groups */
// Each group gets (base: the server the page comes from, wb: withBrowser, port: a CDP port of its own). Every check is named; a mutant names the check it must fail.
const GROUPS = {
  // R. the rigs' switch: every suite that launches through withBrowser lands on the main menu
  async rigs(base, wb, port) {
    await wb({ port, width: 1100, height: 760 }, async (page) => {
      await page.navigate(base + '/lib/capability.js'); await sleep(200);
      const other = await page.eval(`localStorage.getItem('arena.welcome')`);
      const up = await openHub(page, base);
      const v = await page.eval(`({ path: ${H}.model.path(), key: localStorage.getItem('arena.welcome'), plan: ${H}.welcome ? ${H}.welcome.plan : 'none', profiles: ${H}.data.profiles.length })`);
      ok(up && v.path === 'main' && v.key === 'off' && v.plan === null && v.profiles === 0, 'R1 a suite launched through withBrowser() (no welcome option) lands on the MAIN MENU of an empty browser: arena.welcome is off, nothing is asked', J(v));
      ok(other === null, 'R2 the seed does not touch another page of the site (a document outside /pokemonarena/ has no arena.welcome)', String(other));
      await page.eval(`localStorage.setItem('arena.welcome', 'on')`);
      await openHub(page, base);
      const w = await page.eval(`({ path: ${H}.model.path(), key: localStorage.getItem('arena.welcome') })`);
      ok(w.key === 'on' && w.path === 'trainer-new', 'R3 a value the test set itself is kept (on): the same empty browser is then greeted, so the seed is what keeps the old suites on the menu', J(w));
    });
  },

  // E. an EMPTY browser, the KEYBOARD ONLY (M = A, N = B, the arrows, the letters of a name, Enter)
  async empty(base, wb, port) {
    await wb({ port, width: 1100, height: 760, welcome: true }, async (page) => {
      const up = await openHub(page, base);
      await until(page, `${H}.model.path() === 'trainer-new'`, 8000);
      const g = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome && ${H}.welcome.plan, opened: ${H}.welcome && ${H}.welcome.opened, key: localStorage.getItem('arena.welcome'), dlg: ${H}.dialog.current(), hash: location.hash, trail: ${H}.model.trail(), title: document.title })`);
      ok(up && g.path === 'trainer-new' && g.opened === true && g.plan && g.plan.kind === 'new' && g.key === null && g.dlg && g.dlg.id === 'trainer:welcome', 'E1 an empty browser that opens /pokemonarena/ is GREETED in the picture: the NEW TRAINER screens open by themselves and ask (trainer:welcome)', J(g));
      ok(g.hash === '#trainer-new' && J(g.trail) === J(['trainer', 'trainer-new']) && /Trainer/.test(g.title), 'E1b the greeting is a real screen: its address, its trail and its title', J({ hash: g.hash, trail: g.trail, title: g.title }));
      await shot(page, 'trainer_E1_greeting');
      const greetedControls = await controls(page);
      // the question is armed: the A that was on its way to the main menu cannot answer it
      const isArmed = await armed(page);
      await letsGo(page, 'keys');
      let t = await tr(page);
      ok(isArmed && t.wiz && t.wiz.step === 'name' && t.wiz.kind === 'new' && t.wiz.mode === 'create', 'E2 M (A) on LET\'S GO starts the screens at the NAME step (a new trainer is CREATED)', J(t && t.wiz));
      // NEW NAME: the in-picture keyboard, typed on the real keyboard
      for (let i = 0; i < 6 && (await tr(page)).wiz.cur !== 0; i++) await press(page, 'up');          // the cursor opens on the first offered name: up to NEW NAME
      await press(page, 'm');
      const typing = await page.eval(`${H}.wantsText()`);
      await typeWord(page, 'Casey'); await sleep(100);
      const typed = await page.eval(`${H}.view().entry ? ${H}.view().entry.value : null`);
      await press(page, 'enter', 200);
      t = await tr(page);
      ok(typing && typed === 'Casey' && t.wiz.draft.name === 'Casey' && t.wiz.step === 'look', 'E3 NEW NAME opens the in-picture keyboard; the name is TYPED on the real keyboard (M and N are letters there) and Enter keeps it', J({ typing, typed, wiz: t.wiz }));
      // every other step opens on a default: M, M, M ...
      // (the PARTNER: one down from the default, the day's mascot, so that the main menu's partner can be told from the mascot it replaces)
      for (const step of ['look', 'front', 'back', 'portrait', 'partner']) await stepPast(page, step, async () => { if (step === 'partner') await press(page, 'down'); await press(page, 'm'); });
      t = await tr(page);
      const dayMascot = await page.eval(`(async () => { const HD = await import('/pokemonarena/js/hub_data.js'); return HD.pickMascot(${H}.pack, Math.floor(Date.now() / 86400000)); })()`);
      ok(t.wiz.step === 'card' && t.wiz.focus === 'yes' && Number.isInteger(t.wiz.draft.partner) && t.wiz.draft.partner !== dayMascot, 'E4a every step opens on a default, so M M M ... reaches the TRAINER CARD, asking YES (the partner taken one below the day\'s mascot)', J({ wiz: t.wiz, dayMascot }));
      await shot(page, 'trainer_E4_card');
      const draft = await page.eval(`${H}.model.app('trainer').draft()`);
      await press(page, 'm', 300);
      const saved = await until(page, `${madeCount} === 1`, 15000);
      const st = await storeRead(page), p = st.list[0] || {};
      ok(saved && st.list.length === 1 && p.name === 'Casey' && p.card && p.card.made === true && p.card.partner === draft.partner && p.card.look === draft.look && p.card.front === draft.front && st.active === p.id, 'E4 YES makes the trainer in IndexedDB: the typed name, card.made, the look / figure / partner chosen, and it is the ACTIVE one', J({ st, draft }));
      // a fresh visit: the main menu, the name and the partner, no greeting
      await openHub(page, base);
      await sleep(300);
      const m = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome && ${H}.welcome.plan, name: ${H}.view().trainer, mascot: (${H}.view().mascot || {}).species })`);
      ok(m.path === 'main' && m.plan === null, 'E5a the next visit lands on the MAIN MENU and nothing is asked', J(m));
      ok(m.name === 'Casey' && m.mascot === p.card.partner && m.mascot !== dayMascot, 'E5 the main menu names the trainer and the PARTNER stands where the day\'s mascot stood', J({ m, partner: p.card && p.card.partner, dayMascot }));
      const menuControls = await controls(page);
      ok(greetedControls === menuControls, 'E1c everything the greeting asked was in the picture: the page showed the same controls while greeting as on the main menu (no form, field, button or dialog of its own)', J({ greetedControls, menuControls }));
      await shot(page, 'trainer_E5_main');
      ok(page.errors.length === 0, 'E6 no page error on the way', J(page.errors.slice(0, 3)));
      // C. the TRAINER CARD row, in the same browser: the card, then the LOOK and the FIGURE changed from it
      if (GROUPS._withCard) await GROUPS._withCard(page, base, p);
    });
  },

  // L. LATER: remembered for this tab, asked again in a new one
  async later(base, wb, port) {
    await wb({ port, width: 1100, height: 760, welcome: true }, async (page) => {
      await openHub(page, base);
      await until(page, `${H}.model.path() === 'trainer-new'`, 8000);
      await armed(page);
      await press(page, 'n', 250);
      const a = await page.eval(`({ path: ${H}.model.path(), later: sessionStorage.getItem('arena.welcome'), profiles: ${H}.data.profiles.length, dlg: ${H}.dialog.current() })`);
      ok(a.path === 'main' && a.later === 'later' && a.profiles === 0 && a.dlg === null, 'L1 N (B) on the greeting is LATER: back to the main menu, remembered for the tab (sessionStorage arena.welcome = later), nothing made', J(a));
      await openHub(page, base);
      await sleep(400);
      const b = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome && ${H}.welcome.plan })`);
      ok(b.path === 'main' && b.plan === null, 'L2 the same tab opened again is not asked again', J(b));
      const tab = await page.openTab({ width: 1100, height: 760 });
      await openHub(tab, base);
      await until(tab, `${H}.model.path() === 'trainer-new'`, 8000);
      const c = await tab.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome && ${H}.welcome.plan, later: sessionStorage.getItem('arena.welcome') })`);
      ok(c.path === 'trainer-new' && c.plan && c.plan.kind === 'new' && c.later === null, 'L3 a NEW tab is asked again (LATER was for that tab only)', J(c));
    });
  },

  // W. a profile from before schema 6: "welcome back", pre-filled, its teams kept
  async back(base, wb, port) {
    const v5 = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'fixtures', 'pokemonarena', 'profile-v5-current.json'), 'utf8'));
    await wb({ port, width: 1100, height: 760, welcome: true }, async (page) => {
      await page.navigate(base + '/pokemonarena/manifest.json');
      // the database as the store makes it, then the schema 5 document written into it RAW (as an older build left it), and made the active one
      const put = await page.eval(`(async () => { const S = await import('/pokemonarena/js/store.js'); const st = await S.openStore(); await st.listProfiles(); const doc = ${J(v5)};
        const db = await new Promise((res, rej) => { const r = indexedDB.open(S.DB_NAME); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        await new Promise((res, rej) => { const tx = db.transaction(['profiles'], 'readwrite'); tx.objectStore('profiles').put(doc); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        db.close(); await st.setActiveId(doc.id); return { id: doc.id, schema: doc.schemaVersion }; })()`);
      await openHub(page, base);
      await until(page, `${H}.model.path() === 'trainer-new'`, 8000);
      const g = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome && ${H}.welcome.plan, dlg: ${H}.dialog.current(), words: ${H}.view().dialog ? ${H}.view().dialog.lines.join(' ') : '', wiz: ${H}.model.state().apps.trainer.wiz })`);
      ok(put.schema === 5 && g.path === 'trainer-new' && g.plan && g.plan.kind === 'back' && g.plan.name === 'GREEN' && /Welcome back, GREEN!/.test(g.words), 'W1 a schema 5 profile in IndexedDB is greeted "Welcome back, GREEN!"', J(g));
      ok(g.wiz && g.wiz.kind === 'back' && g.wiz.mode === 'update' && g.wiz.draft.name === 'GREEN', 'W2 ... and the screens are PRE-FILLED with its name, to UPDATE it (not to make another)', J(g.wiz));
      await shot(page, 'trainer_W1_back');
      await armed(page); await letsGo(page, 'keys');
      for (const step of ['name', 'look', 'front', 'back', 'portrait', 'partner']) await stepPast(page, step, () => press(page, 'm'));
      const t = await tr(page);
      await press(page, 'm', 300);
      const saved = await until(page, `${madeCount} === 1`, 15000);
      const st = await storeRead(page), p = st.list.find((x) => x.id === put.id) || {};
      ok(t.wiz && t.wiz.step === 'card' && saved && st.list.length === 1 && p.name === 'GREEN' && p.card && p.card.made === true && J(p.teams) === J(['STRICT SIX']) && p.box === 2 && p.schema >= 6, 'W3 M through the screens and YES: the SAME profile (one trainer, GREEN) now has its card made and keeps its team and its Pokemon', J({ st, wiz: t.wiz }));
    });
  },

  // P. a PHONE: taps only, on the picture
  async phone(base, wb, port) {
    await wb({ port, width: 390, height: 844, mobile: true, welcome: true }, async (page) => {
      await openHub(page, base);
      await until(page, `${H}.model.path() === 'trainer-new'`, 8000);
      await armed(page);
      const went = await letsGo(page, 'tap');
      let t = await tr(page);
      ok(went && t.wiz && t.wiz.step === 'name', 'P1 taps on the question\'s text turn its pages, and a tap on LET\'S GO starts the screens', J({ wiz: t.wiz }));
      // each step: tap the thing the cursor is on (the default)
      for (let i = 0; i < 8; i++) {
        t = await tr(page);
        if (!t.wiz || t.wiz.step === 'card') break;
        const rs = await page.eval(`${H}.model.rects()`), r = rs.find((x) => (x.kind === 'row' || x.kind === 'cell') && x.index === t.wiz.cur);
        if (!r) break;
        await tapRect(page, r);
      }
      t = await tr(page);
      const yes = (await page.eval(`${H}.model.rects()`)).find((x) => x.kind === 'chip' && x.id === 'yes');
      ok(t.wiz && t.wiz.step === 'card' && !!yes && t.wiz.draft.name === 'GOLD', 'P2 one tap per step reaches the TRAINER CARD (the name GOLD, the first of the offered names)', J({ wiz: t.wiz, yes }));
      await shot(page, 'trainer_P2_card');
      if (yes) await tapRect(page, yes);
      const saved = await until(page, `${madeCount} === 1`, 15000);
      const st = await storeRead(page);
      ok(saved && st.list.length === 1 && st.list[0].name === 'GOLD' && st.list[0].card.made === true, 'P3 a tap on YES makes the trainer', J(st));
      await openHub(page, base); await sleep(300);
      const m = await page.eval(`({ path: ${H}.model.path(), name: ${H}.view().trainer })`);
      ok(m.path === 'main' && m.name === 'GOLD', 'P4 the phone then lands on the main menu with the trainer named', J(m));
    });
  },

  // O. the switch: localStorage arena.welcome = off stops the greeting (a player never sets it)
  async off(base, wb, port) {
    await wb({ port, width: 1100, height: 760, welcome: true }, async (page) => {
      await page.navigate(base + '/pokemonarena/manifest.json'); await page.eval(`localStorage.setItem('arena.welcome', 'off')`);
      await openHub(page, base); await sleep(500);
      const v = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome ? ${H}.welcome.plan : 'none', profiles: ${H}.data.profiles.length, rows: ${H}.model.rows().map((r) => r.id).join() })`);
      ok(v.path === 'main' && v.plan === null && v.profiles === 0, 'O1 with arena.welcome = off an empty browser is NOT greeted: the main menu', J(v));
      ok(/builder,trainer,record/.test(v.rows), 'O2 ... and the TRAINER CARD row is there all the same', v.rows);
    });
  },

  // A. a page opened at another address is not interrupted
  async address(base, wb, port) {
    await wb({ port, width: 1100, height: 760, welcome: true }, async (page) => {
      await openHub(page, base, '#online'); await sleep(500);
      const v = await page.eval(`({ path: ${H}.model.path(), plan: ${H}.welcome ? ${H}.welcome.plan : 'none' })`);
      ok(v.path === 'online' && v.plan === null, 'A1 an empty browser opened at #online (an invite link) is NOT interrupted', J(v));
    });
  },

  // B. the Team Builder's NEW TRAINER goes through the same screens and comes back to the builder (the rigs' switch is on here: the menu is where the player starts)
  async builder(base, wb, port) {
    await wb({ port, width: 1100, height: 760 }, async (page) => {
      await openHub(page, base);
      for (let i = 0; i < 12 && (await page.eval(`${H}.model.rows()[${H}.model.state().cursor.main].id`)) !== 'builder'; i++) await press(page, 'down');
      await press(page, 'm', 600);
      await until(page, `${H}.model.state().apps.builder.phase === 'ready'`, 15000);
      const rows = await page.eval(`${H}.view().menu ? ${H}.view().menu.rows.map((r) => r.id) : []`);
      for (let i = 0; i < 4 && (await page.eval(`${H}.view().menu.rows[${H}.view().menu.cursor].id`)) !== 'new'; i++) await press(page, 'down');
      await press(page, 'm', 300);
      const a = await page.eval(`({ path: ${H}.model.path(), trail: ${H}.model.trail(), wiz: ${H}.model.state().apps.trainer.wiz })`);
      ok(J(rows) === J(['new', 'back']) && a.path === 'trainer-new' && J(a.trail) === J(['builder', 'trainer-new']) && a.wiz && a.wiz.kind === 'another', 'B1 the Team Builder\'s NEW TRAINER opens the NEW TRAINER screens over the builder (one way to make a trainer)', J({ rows, a }));
      await letsGo(page, 'keys');
      for (const step of ['name', 'look', 'front', 'back', 'portrait', 'partner']) await stepPast(page, step, () => press(page, 'm'));
      await press(page, 'm', 300);
      await until(page, `${madeCount} === 1`, 15000);
      await until(page, `${H}.model.path() === 'builder' && ${H}.model.state().apps.builder.profile !== null`, 15000);
      const b = await page.eval(`({ path: ${H}.model.path(), act: (${H}.view().builder.list.rows.find((r) => r.tag === 'ACTIVE') || {}).label, open: ${H}.model.state().apps.builder.profile })`);
      const st = await storeRead(page);
      ok(b.path === 'builder' && b.act === 'GOLD' && st.list.length === 1 && b.open === st.list[0].id && st.active === b.open, 'B2 YES comes back to the builder, which shows the new trainer ACTIVE and open', J({ b, st }));
    });
  },

  // C. the Trainer Center's LOOK is the trainer's (card.look first, arena.avatar second; the Center's LOOK writes both)
  async center(base, wb, port) {
    await wb({ port, width: 1100, height: 760 }, async (page) => {
      await openHub(page, base);
      // a trainer, and two looks the ROM has (read from the Center's own world)
      const prep = await page.eval(`(async () => { const W = await import('/pokemonarena/js/center_world.js'), L = await import('/pokemonarena/js/center_look.js'), T = await import('/pokemonarena/js/trainer_store.js'), S = await import('/pokemonarena/js/store.js');
        const av = W.centerWorld(${H}.ui.rom).world.ow.avatars; const a = L.lookCode(av[3]), b = L.lookCode(av[7]);
        const st = await S.openStore(); const made = await T.createTrainer(st, { name: 'RED', card: { made: true, look: a } });
        localStorage.setItem(L.LOOK_KEY, b); return { a, b, id: made.id, ok: made.ok }; })()`);
      await page.eval(`${H}.refresh()`); await sleep(300);
      await page.eval(`${H}.goto('center')`);
      await until(page, `${H}.center && ${H}.center.me && ${H}.center.me().look`, 15000);
      const r = await page.eval(`({ look: ${H}.center.me().look, stored: localStorage.getItem('arena.avatar') })`);
      ok(prep.ok && r.look === prep.a && r.stored === prep.a, 'C1 the Center dresses the player in the ACTIVE trainer\'s card.look (not the browser\'s arena.avatar), and copies it to arena.avatar', J({ prep, r }));
      // the Center's LOOK (its ctl's 'look' effect, as the LOOK picker sends it)
      const c = await page.eval(`(async () => { const W = await import('/pokemonarena/js/center_world.js'), L = await import('/pokemonarena/js/center_look.js'); const code = L.lookCode(W.centerWorld(${H}.ui.rom).world.ow.avatars[11]);
        await ${H}.apps.effect({ app: 'center', type: 'look', code }); await ${H}.apps.idle('center'); for (let i = 0; i < 40 && !(${H}.center.state().lookWrite); i++) await new Promise((r) => setTimeout(r, 50)); return { code, write: ${H}.center.state().lookWrite }; })()`);
      await sleep(300);
      const st = await storeRead(page), p = st.list.find((x) => x.id === prep.id) || {};
      const hubCard = await page.eval(`(${H}.data.profiles.find((x) => x.id === ${J(prep.id)}) || {}).card`);
      ok(p.card && p.card.look === c.code && (await page.eval(`localStorage.getItem('arena.avatar')`)) === c.code && hubCard && hubCard.look === c.code, 'C2 the Center\'s LOOK writes the active trainer\'s card.look (IndexedDB) and arena.avatar together, and the hub\'s data follows', J({ c, card: p.card, hubCard }));
    });
  },
};
const ORDER = ['rigs', 'empty', 'later', 'back', 'phone', 'off', 'address', 'builder', 'center'];

// C (card): run inside the 'empty' group's browser, after the trainer was made
GROUPS._withCard = async (page, base, made) => {
  for (let i = 0; i < 12 && (await page.eval(`${H}.model.rows()[${H}.model.state().cursor.main].id`)) !== 'trainer'; i++) await press(page, 'down');
  await press(page, 'm', 300);
  const c0 = await page.eval(`({ path: ${H}.model.path(), card: ${H}.view().trainer, focus: ${H}.model.state().apps.trainer.card.focus })`);
  ok(c0.path === 'trainer' && !!c0.focus, 'K1 the TRAINER CARD row (keyboard) shows the active trainer\'s card', J(c0));
  await shot(page, 'trainer_K1_card');
  const PARTS = ['look', 'portrait', 'figure', 'partner'];
  const focusTo = async (id) => {          // down to the row of the card's four pictures, then right along it
    for (let i = 0; i < 6 && !PARTS.includes((await tr(page)).card.focus); i++) await press(page, 'down');
    for (let i = 0; i < 6 && (await tr(page)).card.focus !== id; i++) await press(page, 'right');
    return (await tr(page)).card.focus === id;
  };
  // the LOOK
  const onLook = await focusTo('look');
  await press(page, 'm');
  const e0 = await tr(page);
  await press(page, 'right'); await press(page, 'm', 400);
  await until(page, `(${H}.data.profiles[0].card || {}).look !== ${J(made.card.look)}`, 10000);
  const st1 = await storeRead(page);
  ok(onLook && e0.edit && e0.edit.field === 'look' && st1.list[0].card.look !== made.card.look && /^w[0-9a-z]{6}$/.test(st1.list[0].card.look), 'K2 from the card: LOOK, RIGHT, M changes the trainer\'s look in IndexedDB', J({ e0: e0.edit, before: made.card.look, after: st1.list[0].card }));
  // the FIGURE (front, then back)
  await until(page, `${H}.model.path() === 'trainer'`, 5000);
  const onFig = await focusTo('figure');
  await press(page, 'm');
  const f0 = await tr(page);
  await press(page, 'right'); await press(page, 'm');
  await stepPast(page, 'back', () => press(page, 'm'));
  await sleep(400);
  await until(page, `(${H}.data.profiles[0].card || {}).front !== ${J(made.card.front)}`, 10000);
  const st2 = await storeRead(page);
  ok(onFig && f0.edit && f0.edit.field === 'figure' && st2.list[0].card.front !== made.card.front && Number.isInteger(st2.list[0].card.front), 'K3 from the card: BATTLE FIGURE, RIGHT, M (and the back) changes the trainer\'s front figure in IndexedDB', J({ f0: f0.edit, before: made.card.front, after: st2.list[0].card }));
};

/* ============================================================================================================ the page mutants (an overlay serves a copy of pokemonarena/ with ONE defect) */
const PAGE_MUTANTS = [
  { id: 'PM1', what: 'the page never greets', file: 'js/boot.js', from: 'if (!welcomed) { welcomed = true; greet(d); }', to: 'if (!welcomed) { welcomed = true; }', groups: ['empty'], expect: 'E1 ' },
  { id: 'PM2', what: 'the rigs\' switch is not read', file: 'js/boot.js', from: 'off: read(storage)', to: 'off: null', groups: ['off'], expect: 'O1 ' },
  { id: 'PM3', what: 'LATER is not read back', file: 'js/boot.js', from: 'later: read(session)', to: 'later: null', groups: ['later'], expect: 'L2 ' },
  { id: 'PM4', what: 'the partner does not stand on the title screen', file: 'js/hub_model.js', from: '    if (partner) return { species: partner, shiny: false, gender: null };\n', to: '', groups: ['empty'], expect: 'E5 ' },
  { id: 'PM5', what: 'the main menu does not name the trainer', file: 'js/hub_model.js', from: 'trainer: who ? who.name : null, menu:', to: 'trainer: null, menu:', groups: ['empty'], expect: 'E5 ' },
  { id: 'PM6', what: 'the builder\'s NEW TRAINER opens nothing', file: 'js/builder_home.js', from: "const newTrainer = () => X.go('trainer-new');", to: 'const newTrainer = () => [];', groups: ['builder'], expect: 'B1 ' },
  { id: 'PM7', what: 'the greeting interrupts a page opened at another address', file: 'js/hub_model.js', from: "if (o.openedAt !== 'main' || o.path !== 'main') return null;", to: "if (o.path !== 'main' && o.path !== 'online') return null;", groups: ['address'], expect: 'A1 ' },
  { id: 'PM8', what: 'the Center ignores the trainer\'s card look', file: 'js/center_ctl.js', from: 'if (card && isLook(card, room.looks)) {', to: 'if (false) {', groups: ['center'], expect: 'C1 ' },
  { id: 'PM9', what: 'the Center\'s LOOK does not write the card', file: 'js/center_ctl.js', from: 'const r = await updateTrainer(store, a.id, { card: { look: code } });', to: 'const r = { ok: true, changed: false };', groups: ['center'], expect: 'C2 ' },
  { id: 'PM10', what: 'a profile whose card is made is greeted again', file: 'js/hub_model.js', from: 'if (!p || p.readOnly || cardOf(p).made) return null;', to: 'if (!p || p.readOnly) return null;', groups: ['empty'], expect: 'E5a ' },
];
// the rigs' launcher itself: a Page that does not install the seed
const CDP_MUTANTS = [
  { id: 'CM1', what: 'the rigs do not install the seed', from: "if (this.seedWelcome) await this.send('Page.addScriptToEvaluateOnNewDocument', { source: WELCOME_SEED });", to: '', groups: ['rigs'], expect: 'R1 ' },
  { id: 'CM3', what: 'a second tab does not inherit withBrowser({ welcome: true })', from: 'tab.port = this.port; tab.seedWelcome = this.seedWelcome;', to: 'tab.port = this.port;', groups: ['later'], expect: 'L3 ' },
  { id: 'CM2', what: 'withBrowser({ welcome: true }) still seeds it', from: 'page.seedWelcome = !welcome;', to: 'page.seedWelcome = true;', groups: ['later'], expect: 'L1 ' },
];

/* ============================================================================================================ the run */
function listening(port) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count`], { encoding: 'utf8' });
  return Number((r.stdout || '0').trim()) > 0;
}
async function startServer() {
  if (listening(PORT)) throw new Error('something already listens on ' + PORT + ' (a stale dev server would make this suite test another tree): stop it or pass another ARENA_PORT');
  const child = spawn(process.execPath, [path.join(root, 'tools', 'devserver.mjs')], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/pokemonarena/'); if (r.ok) return child; } catch (_e) { /* not up yet */ } await sleep(250); }
  throw new Error('the dev server did not come up on ' + PORT);
}
const killTree = (pid) => { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_e) { /* gone */ } };
let cdp = CDP0;
async function runGroup(name, base, wb) {
  const t0 = Date.now();
  try { await GROUPS[name](base, wb, cdp++); } catch (e) { ok(false, name + ': the group ran to its end', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e); }
  if (!sink) console.log('  group ' + name + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
}

console.log('pokemonarena trainer page test; node', process.version, '; port', PORT, 'cdp', CDP0, '; shots', OUT);
seedChecks(WELCOME_SEED);
if (WANT_MUTANTS) {
  for (const mu of SEED_MUTANTS) {
    let src = WELCOME_SEED; const n = src.split(mu.from).length - 1;
    if (n !== 1) { ok(false, 'mutant ' + mu.id + ' (' + mu.what + '): its text occurs ' + n + ' times'); continue; }
    src = src.replace(mu.from, mu.to); if (mu.also) src = src.replace(mu.also[0], mu.also[1]);
    sink = []; try { seedChecks(src); } catch (e) { sink.push('threw ' + e.message); } const got = sink; sink = null;
    ok(got.some((x) => x.startsWith(mu.expect)), 'mutant ' + mu.id + ' (' + mu.what + ') fails ' + mu.expect, got.length ? got.join(' || ') : 'NOT CAUGHT');
  }
}
const groups = ORDER.filter((g) => !ONLY.length || ONLY.includes(g) || (g === 'empty' && ONLY.includes('card')));
let server = null, overlay = null;
try {
  if (groups.length) server = await startServer();
  for (const g of groups) await runGroup(g, BASE, realWithBrowser);
  if (WANT_MUTANTS && groups.length) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-trainer-mut-'));
    for (const mu of PAGE_MUTANTS) {
      if (!mu.groups.some((g) => groups.includes(g))) continue;
      const dir = path.join(tmpRoot, mu.id);
      copyTree(path.join(root, 'pokemonarena'), dir);
      let setup = null; try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { setup = e.message; }
      if (setup) { ok(false, 'mutant ' + mu.id + ' (' + mu.what + '): ' + setup); continue; }
      overlay = await startOverlay({ dir, port: OVL, upstream: BASE });
      sink = [];
      for (const g of mu.groups) await runGroup(g, overlay.url, realWithBrowser);
      const got = sink; sink = null; overlay.stop(); overlay = null;
      ok(got.some((x) => x.startsWith(mu.expect)), 'mutant ' + mu.id + ' (' + mu.what + ') fails ' + mu.expect.trim(), got.length ? got.slice(0, 3).join(' || ') : 'NOT CAUGHT');
    }
    const cdpSrc = fs.readFileSync(path.join(here, 'headless_cdp.mjs'), 'utf8');
    for (const mu of CDP_MUTANTS) {
      if (!mu.groups.some((g) => groups.includes(g))) continue;
      const n = cdpSrc.split(mu.from).length - 1;
      if (n !== 1) { ok(false, 'mutant ' + mu.id + ' (' + mu.what + '): its text occurs ' + n + ' times'); continue; }
      const f = path.join(tmpRoot, mu.id + '_headless_cdp.mjs');
      fs.writeFileSync(f, cdpSrc.replace(mu.from, mu.to));
      const M = await import(pathToFileURL(f).href);
      sink = [];
      for (const g of mu.groups) await runGroup(g, BASE, M.withBrowser);
      const got = sink; sink = null;
      ok(got.some((x) => x.startsWith(mu.expect)), 'mutant ' + mu.id + ' (' + mu.what + ') fails ' + mu.expect.trim(), got.length ? got.slice(0, 3).join(' || ') : 'NOT CAUGHT');
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { /* temp */ }
  }
} finally {
  if (overlay) overlay.stop();
  if (server) killTree(server.pid);
}
console.log('\n' + (fail ? 'FAILED' : 'OK') + ': ' + pass + ' passed, ' + fail + ' failed (trainer page)');
for (const f of failures) console.log('  ' + f);
process.exit(fail ? 1 : 0);
