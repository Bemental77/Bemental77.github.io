// tools/pokemonarena_trainer_test.mjs -- THE TRAINER app in the hub's picture (pokemonarena/js/trainer_*.js; pokemonarena/INAPP.md "TRAINER" and "APP-UI: as built"): the new-trainer screens,
// the trainer card and the one-choice editor, driven through the REAL hub model (createHubModel, the real ROM font) and drawn by the REAL renderer from the ROM.
//
//   node tools/pokemonarena_trainer_test.mjs              the Node checks
//   node tools/pokemonarena_trainer_test.mjs --mutants    also: a copy of pokemonarena/js with ONE defect at a time (each in a process of its own); each must fail the check it names.
//                                                         TRAINER_MUT=<id> runs one
//   node tools/pokemonarena_trainer_test.mjs --update     write pokemonarena/trainer.golden.json (FNV-1a hashes of the pictures, never pixels) from what the ROM gives now
//   TRAINER_WALK=<n> inputs of the random walk (default 3000); TRAINER_VERBOSE=1 prints every check; TRAINER_SHOTS=<dir> writes the golden screens as PNG there (to look at;
//   never committed); ARENA_ROM=<gba>
//
// FAMILIES (a check's name starts with its family letter and number: a mutant names the check it must trip)
//   R  the registry: the three files registered with the paths and parents of the contract; the model and the renderer are pure (no DOM, storage, clock, randomness)
//   W  the welcome: the hub's dialog layer asks LET'S GO / LATER, ARMED on a first visit; LATER (and B) on a first visit goes home with the 'later' effect; the screen's own question when
//      the dialog layer refused it; 'back' pre-fills from the profile it names and UPDATES it; 'another' CREATES
//   A  A, A, A ... makes the default trainer: the save effect carries every default; the ctl saves it through trainer_store.js into a memory store, writes the look, refreshes, plays the
//      success sound, and the screen comes back to the card
//   B  B on every step goes to the step before
//   K  every picker: the d-pad, L / R, held repeats that stop at the ends, wrapping, taps, the wheel, the page chips
//   N  the name: NEW NAME's in-picture keyboard, a real keyboard, CANCEL, an empty name refused in words, the presets, a pre-schema-6 profile's own name
//   P  the partner: the search (a text entry, charset 'search'), no match, paging
//   C  the card step: YES, CHANGE, a part changed and back to the card, the figure's two pictures
//   E  the card screen and the editor: no trainer, one, two (SWITCH), read-only refusals, an edit saved / unchanged / cancelled, the editor opened by its address
//   F  failures: every refusal of the store said in words, the screen stays; nothing is pressed while saving
//   G  the pictures against trainer.golden.json; every text inside its room at the longest values; every front choice draws
//   Z  a random walk of thousands of inputs: no fault, no text out of its room, the view stays plain JSON
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const MUTANTS = args.includes('--mutants');
const UPDATE = args.includes('--update');
const ONE = process.env.TRAINER_MUT || '';
const VERBOSE = !!process.env.TRAINER_VERBOSE;
const WALK = Number(process.env.TRAINER_WALK || 3000);
const SRC = path.join(root, 'pokemonarena', 'js');
const GOLDEN = path.join(root, 'pokemonarena', 'trainer.golden.json');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const J = (x) => JSON.stringify(x);
const fnv = (u8) => { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };
const romBytes = (() => { const b = fs.readFileSync(ROM_PATH); return new Uint8Array(b.buffer, b.byteOffset, b.length); })();
const SEED = 12345, MASCOT = 25;

function mapStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ================================================================================================ the checks (on the tree `jsDir`) */
async function runNode(jsDir, verbose) {
  const results = [];
  async function check(name, fn) {
    let r;
    try { r = await fn(); } catch (e) { r = 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
    results.push({ name, ok: r === true });
    if (verbose && (r !== true || VERBOSE)) console.log(r === true ? 'ok  ' : 'FAIL', name, r === true ? '' : String(r).slice(0, 600));
  }
  const mod = (n) => import(pathToFileURL(path.join(jsDir, n)).href);
  const [HM, HS, B, T, TH, TS, TC, TGm, TF, ST, TST, HA, HAS, CL, HDL, HD, SG, TE] = await Promise.all(['hub_model.js', 'hub_screen.js', 'battle_ui.js', 'tables.js', 'trainer_hub.js', 'trainer_screen.js', 'trainer_ctl.js', 'trainer_geom.js',
    'trainer_figures.js', 'store.js', 'trainer_store.js', 'hub_apps.js', 'hub_app_screens.js', 'center_look.js', 'hub_dialog.js', 'hub_data.js', 'speciesgfx.js', 'textentry.js'].map(mod));
  const read = (f) => fs.readFileSync(path.join(jsDir, f), 'utf8');
  const ui = B.createBattleUi(romBytes), screen = HS.createHubScreen(ui);
  const pack = T.loadPack(romBytes, { verify: 'header', dexText: false });
  const CH = TC.choicesOf(romBytes, pack);
  const tscreen = TS.createScreen(ui, screen.helpers);
  const W = TH.WORDS;

  /* ---------------------------------------------------------------------------------------------- helpers */
  const prof = (id, name, o = {}) => ({ id, name, readOnly: !!o.readOnly, teams: [], record: o.record || null, avatar: o.avatar || { kind: 'preset', id: 0 }, card: o.card || { made: false, look: null, front: null, back: null, partner: null } });
  function mk(data, o = {}) {
    const hub = HM.createHubModel({ mascot: MASCOT, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
    hub.setData(data || { state: 'ready', activeId: null, profiles: [] });
    const app = hub.apps.trainer;
    if (o.choices !== false) { app.setChoices(CH); app.setSeed(SEED); app.setMascot(MASCOT); }
    if (o.list && data) app.setTrainers({ activeId: data.activeId, list: data.profiles.map((p) => ({ id: p.id, name: p.name, readOnly: p.readOnly, avatar: p.avatar, card: p.card })) });          // (the store's list, as the ctl hands it)
    return { hub, app, st: () => hub.state().apps.trainer };
  }
  const arm = (hub) => { for (let i = 0; i < HDL.DIALOG_ARM_TICKS + 2; i++) hub.tick(); };
  /** Answer the welcome question with the option at `index` (A through its pages, the d-pad to the option). -> the effects of the answer. */
  function answer(hub, index = 0) {
    let fx = [];
    for (let i = 0; i < 20 && hub.dialog.isOpen(); i++) {
      const d = hub.dialog.current();
      if (d.page < d.pages - 1) { hub.press('a'); continue; }
      if (d.choice.cursor !== index) { hub.press('down'); continue; }
      fx = hub.press('a');
    }
    return fx;
  }
  function visit(kind = 'new', data, o) {
    const m = mk(data, o);
    if (kind) m.app.welcome({ kind, name: o && o.name, profileId: o && o.profileId });
    m.goFx = m.hub.goto('trainer-new');
    arm(m.hub);
    return m;
  }
  const step = (m) => (m.st().wiz ? m.st().wiz.step : null);
  const has = (fx, pred) => (fx || []).some(pred);
  /** Put the card screen's highlight on a part by hovering it. */
  const focus = (m, id) => { const r = m.hub.rects().find((x) => x.kind === 'part' && x.id === id); m.hub.pointer({ kind: 'move', x: r.x + 3, y: r.y + 3 }); };
  const fxOf = (fx, type) => (fx || []).find((e) => e.app === 'trainer' && e.type === type) || null;
  const frame = (hub) => screen.render(hub.view());
  /** Every text of the open view against its room: [] when all fit, else the ones that do not. */
  function overflow(hub) {
    const v = hub.view(), bad = [];
    if (v.app === 'trainer' && v.trainer) {
      const f = screen.frame();
      for (const t of tscreen.measure(f, v)) if (t.cut || (t.max !== null && t.px > t.max)) bad.push(t.what + ' "' + t.s + '" ' + t.px + '>' + t.max);
    }
    for (const w of screen.widths(v)) if (w.px > w.max) bad.push(w.what + ' ' + w.px + '>' + w.max);
    return bad;
  }
  async function memStore(o = {}) {
    const name = 'tt-' + Math.random().toString(36).slice(2);
    const inner = ST.createMemoryAdapter({ name, durable: true });
    const adapter = o.wrap ? o.wrap(inner) : inner;
    const store = await ST.openStore({ adapter, channel: false });
    return { store, name, done: async () => { try { await store.close(); } catch (_e) { /* closed */ } ST.dropMemoryDb(name); } };
  }
  /** A ctl on a played page: the memory store, Map storages, a recording sound; refreshData reads the store into the hub as the page does. */
  function ctlFor(m, store, o = {}) {
    const env = {
      win: {}, doc: {}, hook: {}, model: m.hub, app: m.app, store: () => store, whenStore: async () => store, pack, rom: romBytes, ui, navigate: () => {}, input: null,
      storage: o.storage || mapStorage(), session: o.session || mapStorage(), refreshes: 0, sounds: [], ran: [],
      async refreshData() { env.refreshes++; m.hub.setData(await HD.readHubData(store, pack)); },
      redraw() {}, run(fx) { env.ran.push(...(fx || [])); }, freshSeed: () => SEED,
      sound: { sfx: (k) => env.sounds.push(k), music: () => {}, system: () => null },
    };
    env.ctl = TC.createCtl(env);
    return env;
  }

  /* ---------------------------------------------------------------------------------------------- R: the registry */
  await check('R1 the trainer app is registered once in each of the three registries, with the contract\'s paths and parents', () => {
    const a = HA.APPS.find((x) => x.id === 'trainer');
    const ctlText = read('hub_app_ctls.js');
    return !!a && J(a.paths) === J(['trainer', 'trainer-new', 'trainer-edit']) && a.parent('trainer') === 'main' && a.parent('trainer-new') === 'trainer' && a.parent('trainer-edit') === 'trainer'
      && typeof HAS.APP_SCREENS.trainer === 'function' && /trainer: \(\) => import\('\.\/trainer_ctl\.js'\)/.test(ctlText) && HM.PATHS.includes('trainer-edit') && HA.checkRegistry(HA.APPS, ['main']).length >= 0 ? true : J([a && a.paths, Object.keys(HAS.APP_SCREENS)]);
  });
  await check('R2 the model, the geometry and the renderer are pure: no DOM, no storage, no clock, no randomness, no dynamic import', () => {
    const bad = [];
    for (const f of ['trainer_hub.js', 'trainer_geom.js', 'trainer_screen.js']) {
      const s = read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
      for (const re of [/\bdocument\./, /\bwindow\./, /localStorage/, /sessionStorage/, /Date\.now/, /new Date/, /Math\.random/, /\bimport\(/, /setTimeout/, /fetch\(/]) if (re.test(s)) bad.push(f + ' ' + re);
    }
    return bad.length ? J(bad) : true;
  });
  await check('R3 the hub model made with the real registry hosts the trainer app, and its state and title answer', () => {
    const m = mk();
    return m.hub.title('trainer') === 'Pokemon Arena - Trainer Card' && m.hub.title('trainer-new') === 'Pokemon Arena - New Trainer' && m.st() && m.st().ready === true ? true : J([m.hub.title('trainer'), m.st()]);
  });

  /* ---------------------------------------------------------------------------------------------- W: the welcome */
  await check('W1 a first visit (welcome kind new) opens on the hub\'s dialog: LET\'S GO / LATER, LET\'S GO highlighted, the trail is the card then the new-trainer screens', () => {
    const m = mk(); m.app.welcome({ kind: 'new' });
    const fx = m.hub.goto('trainer-new'), d = m.hub.dialog.current();
    return J(m.hub.trail()) === J(['trainer', 'trainer-new']) && d && d.id === TH.DIALOG_ID && J(d.choice.options) === J(W.options.slice()) && d.choice.cursor === 0 && has(fx, (e) => e.type === 'opened' && e.app === 'trainer') && step(m) === 'welcome' ? true : J([m.hub.trail(), d, fx]);
  });
  await check('W2 the first-visit question is ARMED: an A pressed before it listens answers nothing; after the arm ticks A turns its pages and LET\'S GO opens NAME', () => {
    const m = mk(); m.app.welcome({ kind: 'new' }); m.hub.goto('trainer-new');
    const early = m.hub.press('a'), d0 = m.hub.dialog.current();
    arm(m.hub); answer(m.hub, 0);
    return early.length === 0 && d0 && d0.page === 0 && d0.armed === false && !m.hub.dialog.isOpen() && step(m) === 'name' ? true : J([early, d0, step(m)]);
  });
  await check('W3 LATER on a first visit: the effect { app: trainer, type: later, kind } and home to the main menu', () => {
    const m = visit('new'); const fx = answer(m.hub, 1);
    return has(fx, (e) => e.app === 'trainer' && e.type === 'later' && e.kind === 'new') && m.hub.path() === 'main' && J(m.hub.trail()) === J([]) ? true : J([fx, m.hub.path()]);
  });
  await check('W4 B on the welcome is LATER (the dialog\'s B is its last option)', () => {
    const m = visit('new'); const fx = m.hub.press('b');
    return has(fx, (e) => e.type === 'later') && m.hub.path() === 'main' ? true : J([fx, m.hub.path()]);
  });
  await check('W5 NEW TRAINER from the card (no welcome): not armed, LATER goes back to where it was opened from, a trainer is CREATED', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: { made: true, look: null, front: null, back: null, partner: null } })] });
    m.hub.goto('trainer'); m.hub.goto('trainer-new');
    const d = m.hub.dialog.current(), armed = d && d.armed;
    const fx = answer(m.hub, 1);
    return armed === true && m.hub.path() === 'trainer' && has(fx, (e) => e.type === 'later' && e.kind === 'another') ? true : J([d, fx, m.hub.path()]);
  });
  await check('W6 a profile from before schema 6 (welcome kind back): the greeting names it, the steps start on its own name and portrait (read from the store\'s list even when it arrives after the screens opened), and YES UPDATES it (made: true)', () => {
    const data = { state: 'ready', activeId: 'p1', profiles: [prof('p1', 'BLUE'), prof('p2', 'MISTY')] };
    const m = visit('back', data, { name: 'MISTY', profileId: 'p2' });
    m.app.setTrainers({ activeId: 'p1', list: [{ id: 'p1', name: 'BLUE', avatar: { kind: 'preset', id: 1 }, card: null }, { id: 'p2', name: 'MISTY', avatar: { kind: 'preset', id: 7 }, card: { made: false, look: null, front: 3, back: null, partner: null } }] });
    const pages = m.hub.dialog.current().pages;
    const said = m.hub.view().dialog.lines.join(' ');
    answer(m.hub, 0);
    const nameCur = m.st().wiz.cur, rows = m.hub.view().trainer.rows.map((r) => r.label);
    let fx = []; for (let i = 0; i < 7; i++) fx = m.hub.press('a');
    const s = fxOf(fx, 'save');
    return pages >= 1 && /MISTY/.test(said) && rows[nameCur] === 'MISTY' && s && s.mode === 'update' && s.profileId === 'p2' && s.name === 'MISTY' && s.avatar.id === 7 && s.card.front === 3 && s.card.made === true ? true : J([said, rows, nameCur, s]);
  });
  await check('W7 when the dialog layer cannot show the welcome (its queue is full), the screen asks itself: the d-pad, A, B and a tap answer', () => {
    const m = mk();
    for (let i = 0; i < 8; i++) m.hub.dialog.open({ id: 'x:' + i, pages: [['x', '']], choice: null });
    m.app.welcome({ kind: 'new' }); m.hub.goto('trainer-new');
    for (let i = 0; i < 8; i++) m.hub.dialog.close('x:' + i);
    const v = m.hub.view(), asks = v.trainer.ask;
    m.hub.press('down'); const c1 = m.hub.view().trainer.ask.cursor; m.hub.press('up');
    const r = m.hub.rects().find((x) => x.kind === 'ask' && x.index === 0);
    m.hub.pointer({ kind: 'click', x: r.x + 4, y: r.y + 4 });
    const s1 = step(m);
    const m2 = mk(); for (let i = 0; i < 8; i++) m2.hub.dialog.open({ id: 'x:' + i, pages: [['x', '']], choice: null }); m2.app.welcome({ kind: 'new' }); m2.hub.goto('trainer-new'); for (let i = 0; i < 8; i++) m2.hub.dialog.close('x:' + i);
    const fx2 = m2.hub.press('b');
    return asks && c1 === 1 && s1 === 'name' && has(fx2, (e) => e.type === 'later') && m2.hub.path() === 'main' ? true : J([asks, c1, s1, fx2]);
  });
  await check('W8 the Pokemon standing on the welcome is the hub\'s mascot of the day until the ctl (which loads after the welcome opens) names one: no change under the player\'s eyes', () => {
    const hub = HM.createHubModel({ mascot: 6, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
    hub.setData({ state: 'ready', activeId: null, profiles: [] });
    hub.apps.trainer.welcome({ kind: 'new' }); hub.goto('trainer-new');
    const before = hub.view().trainer.species;
    hub.apps.trainer.setMascot(9);
    const after = hub.view().trainer.species;
    return before === 6 && after === 9 ? true : J([before, after]);
  });

  /* ---------------------------------------------------------------------------------------------- A: A, A, A ... */
  const defaults = () => ({ name: TH.PRESET_NAMES[0], look: CL.pickLook(CH.looks, SEED), front: CH.fronts.some((c) => c.pic === TH.FRONT_DEFAULT_PIC) ? TH.FRONT_DEFAULT_PIC : CH.fronts[0].pic, back: CH.backs.includes(0) ? 0 : CH.backs[0], head: 0, partner: MASCOT });
  function aThrough(m) { answer(m.hub, 0); let fx = []; const seen = []; for (let i = 0; i < 8 && step(m) !== null && !m.app.saving(); i++) { seen.push(step(m)); fx = m.hub.press('a'); } return { fx, seen }; }
  await check('A1 A through every step makes the default trainer: GOLD, the seeded look, the PKMN Trainer figure, back 0, portrait 0, the day\'s mascot; card.made true', () => {
    const m = visit('new'); const { fx, seen } = aThrough(m), s = fxOf(fx, 'save'), d = defaults();
    return J(seen) === J(['name', 'look', 'front', 'back', 'portrait', 'partner', 'card']) && s && s.mode === 'create' && s.name === d.name && s.card.look === d.look && s.card.front === d.front && s.card.back === d.back && s.avatar.kind === 'preset' && s.avatar.id === d.head
      && s.card.partner === d.partner && s.card.made === true && m.app.saving() ? true : J([seen, s, d]);
  });
  await check('A2 the ctl saves A-through into a memory store: one trainer, active, card made with the defaults; the look in localStorage arena.avatar; refreshData; the success sound; back on the card', async () => {
    const M = await memStore();
    try {
      const m = visit('new'); const env = ctlFor(m, M.store); await env.ctl.refresh();
      const { fx } = aThrough(m), s = fxOf(fx, 'save');
      await env.ctl.effect(s);
      const list = await TST.listTrainers(M.store), t = list[0], d = defaults(), today = HD.pickMascot(pack, Math.floor(Date.now() / 86400000));
      return list.length === 1 && t.active && t.name === 'GOLD' && t.card.made === true && t.card.look === d.look && t.card.front === d.front && t.card.partner === today && env.storage.getItem('arena.avatar') === d.look
        && env.refreshes >= 1 && env.sounds.includes('se_success') && m.hub.path() === 'trainer' && J(m.hub.trail()) === J(['trainer']) && !m.app.saving() && m.hub.view().trainer.card.name === 'GOLD' ? true : J([list, env.storage.map.get('arena.avatar'), env.refreshes, env.sounds, m.hub.path()]);
    } finally { await M.done(); }
  });
  await check('A3 a pre-schema-6 profile A-through: the ctl UPDATES it (same id, its name kept, made true), nothing new is created', async () => {
    const M = await memStore();
    try {
      const old = await M.store.createProfile({ trainerName: 'MISTY', avatar: { kind: 'preset', id: 9 } });
      const data = await HD.readHubData(M.store, pack);
      const m = visit('back', data, { name: 'MISTY', profileId: old.id }); const env = ctlFor(m, M.store); await env.ctl.refresh();
      const { fx } = aThrough(m); await env.ctl.effect(fxOf(fx, 'save'));
      const list = await TST.listTrainers(M.store);
      return list.length === 1 && list[0].id === old.id && list[0].name === 'MISTY' && list[0].card.made === true && list[0].avatar.id === 9 && m.hub.path() === 'trainer' ? true : J(list);
    } finally { await M.done(); }
  });
  await check('A4 the ctl hands the model the ROM\'s choices: every look, the figures (read from trainer_figures.js), 52 heads, the legal species; a seed and the stored look', async () => {
    const m = mk(null, { choices: false });
    const env = ctlFor(m, null, { storage: mapStorage({ 'arena.avatar': CL.lookCode(CH.looks[5]) }) });
    const st = m.st(), v = (m.hub.goto('trainer-new'), answer(m.hub, 0), m.hub.press('a'), m.hub.view().trainer);
    return st.ready === true && CH.looks.length > 0 && CH.fronts.length === TF.frontChoices(romBytes).length && CH.heads === 52 && CH.species.length > 0 && v.kind === 'grid' && v.items.includes(CH.looks[5]) && m.st().wiz.cur === 5 && env.ctl ? true : J([st, v.kind, m.st().wiz]);
  });

  /* ---------------------------------------------------------------------------------------------- B: back */
  await check('B1 B on every step goes to the step before (NAME back to the welcome, which asks again)', () => {
    const m = visit('new'); answer(m.hub, 0);
    for (let i = 0; i < 6; i++) m.hub.press('a');
    const order = [];
    for (let i = 0; i < 7; i++) { order.push(step(m)); m.hub.press('b'); }
    return J(order) === J(['card', 'partner', 'portrait', 'back', 'front', 'look', 'name']) && step(m) === 'welcome' && m.hub.dialog.isOpen() && m.hub.dialog.current().armed === true ? true : J([order, step(m)]);
  });

  /* ---------------------------------------------------------------------------------------------- K: the pickers */
  await check('K1 moveCursor: lists wrap on up / down, a HELD repeat stops at the ends, left / right turn the page; grids wrap left / right, up / down a row, L / R a page', () => {
    const mc = TH.moveCursor, out = [
      mc(0, 10, 1, 6, 'up', false) === 9, mc(0, 10, 1, 6, 'up', true) === 0, mc(9, 10, 1, 6, 'down', false) === 0, mc(9, 10, 1, 6, 'down', true) === 9, mc(2, 10, 1, 6, 'right') === 8, mc(8, 10, 1, 6, 'left') === 2, mc(8, 10, 1, 6, 'right') === 8,
      mc(0, 20, 8, 16, 'left', false) === 19, mc(0, 20, 8, 16, 'left', true) === 0, mc(19, 20, 8, 16, 'right', false) === 0, mc(3, 20, 8, 16, 'down') === 11, mc(11, 20, 8, 16, 'down') === 19, mc(3, 20, 8, 16, 'up') === 3, mc(3, 20, 8, 16, 'r') === 19, mc(19, 20, 8, 16, 'l') === 3,
      mc(1, 52, 3, 3, 'down') === 4, mc(4, 52, 3, 3, 'up') === 1, mc(0, 0, 3, 3, 'down') === 0,
    ];
    return out.every(Boolean) ? true : J(out);
  });
  await check('K2 the LOOK grid in the hub: right / left / down / up / L / R / taps on a cell (a click takes it) / the wheel / the page chips', () => {
    const m = visit('new'); answer(m.hub, 0); m.hub.press('a');
    const c0 = m.st().wiz.cur; m.hub.press('right'); const c1 = m.st().wiz.cur; m.hub.press('down'); const c2 = m.st().wiz.cur; m.hub.press('r'); const c3 = m.st().wiz.cur;
    m.hub.pointer({ kind: 'wheel', steps: -1 }); const c4 = m.st().wiz.cur;
    const chip = m.hub.rects().find((r) => r.kind === 'chip' && r.id === 'pgdn'); m.hub.pointer({ kind: 'click', x: chip.x + 2, y: chip.y + 2 }); const c5 = m.st().wiz.cur;
    const cell = m.hub.rects().find((r) => r.kind === 'cell' && r.index !== c5); m.hub.pointer({ kind: 'move', x: cell.x + 3, y: cell.y + 3 }); const c6 = m.st().wiz.cur;
    m.hub.pointer({ kind: 'click', x: cell.x + 3, y: cell.y + 3 });
    const n = CH.looks.length, per = 16;
    return c1 === (c0 + 1) % n && c2 === Math.min(c1 + 8, n - 1) && c3 === Math.min(c2 + per, n - 1) && c4 === c2 && c5 === c3 && c6 === cell.index && step(m) === 'front' && m.st().wiz.draft.look === CL.lookCode(CH.looks[cell.index]) ? true : J([c0, c1, c2, c3, c4, c5, c6, step(m)]);
  });
  await check('K3 the picture pickers (figure, back, portrait): left / right one picture (wrapping), up / down and L / R a page of three, a click takes one', () => {
    const m = visit('new'); answer(m.hub, 0); m.hub.press('a'); m.hub.press('a');
    const f0 = m.st().wiz.cur; m.hub.press('left'); const f1 = m.st().wiz.cur; m.hub.press('down'); const f2 = m.st().wiz.cur;
    const n = CH.fronts.length;
    const cells = m.hub.rects().filter((r) => r.kind === 'cell');
    m.hub.pointer({ kind: 'click', x: cells[2].x + 10, y: cells[2].y + 10 });
    const took = m.st().wiz.draft.front;
    m.hub.press('a'); m.hub.press('left'); m.hub.press('left'); const pc0 = m.st().wiz.cur; m.hub.press('l'); const pc1 = m.st().wiz.cur;
    return f1 === (f0 + n - 1) % n && f2 === Math.min(f1 + 3, n - 1) && took === CH.fronts[cells[2].index].pic && step(m) === 'portrait' && pc0 === 50 && pc1 === 47 && cells.length === 3 ? true : J([f0, f1, f2, took, step(m), pc0, pc1]);
  });
  await check('K4 a held direction repeats to the end of a picker and stops there (never wraps)', () => {
    const m = visit('new'); answer(m.hub, 0); m.hub.press('a'); m.hub.press('a'); m.hub.press('a'); m.hub.press('a');
    for (let i = 0; i < 80; i++) m.hub.press('right', { repeat: true });
    const end = m.st().wiz.cur;
    for (let i = 0; i < 80; i++) m.hub.press('left', { repeat: true });
    return end === 51 && m.st().wiz.cur === 0 ? true : J([end, m.st().wiz.cur]);
  });

  /* ---------------------------------------------------------------------------------------------- N: the name */
  await check('N1 NEW NAME opens the in-picture keyboard (charset name, max 10); a real keyboard types; START keeps it and goes on to LOOK', () => {
    const m = visit('new'); answer(m.hub, 0);
    m.hub.press('up'); m.hub.press('a');
    const e = m.hub.view().entry, want = m.hub.wantsText();
    m.hub.type({ text: 'Casey Bement!' });
    const typed = m.st().entry.value;
    m.hub.press('start');
    return want && e && e.max === TH.NAME_MAX && typed === 'Casey Beme' && step(m) === 'look' && m.st().wiz.draft.name === 'Casey Beme' ? true : J([e, typed, step(m), m.st().wiz.draft]);
  });
  await check('N2 a name of spaces is not a name (the keyboard says so and stays open); CANCEL stays on NAME with no name; the typed name is a row, highlighted, when the player comes back', () => {
    const m = visit('new'); answer(m.hub, 0);
    m.hub.press('up'); m.hub.press('a'); m.hub.type({ text: '   ' }); m.hub.press('start');
    const still = m.hub.wantsText(), note = m.hub.view().entry.note, s1 = step(m);
    m.hub.type({ key: 'escape' }); const s2 = step(m), n2 = m.st().wiz.draft.name, closed = !m.hub.wantsText();
    m.hub.press('a'); m.hub.type({ text: 'Zed' }); m.hub.press('start'); m.hub.press('b');
    const rows = m.hub.view().trainer.rows.map((r) => r.label);
    return still && !!note && s1 === 'name' && s2 === 'name' && n2 === '' && closed && rows.includes('Zed') && rows[m.st().wiz.cur] === 'Zed' ? true : J([still, note, s1, s2, n2, rows]);
  });
  await check('N3 the preset names: each row takes its name; the list is NEW NAME and the presets', () => {
    const m = visit('new'); answer(m.hub, 0);
    const rows = m.hub.view().trainer.rows.map((r) => r.label);
    m.hub.press('down'); m.hub.press('a');
    return J(rows) === J(['NEW NAME'].concat(TH.PRESET_NAMES)) && m.st().wiz.draft.name === TH.PRESET_NAMES[1] ? true : J([rows, m.st().wiz.draft]);
  });

  /* ---------------------------------------------------------------------------------------------- P: the partner */
  const toPartner = () => { const m = visit('new'); answer(m.hub, 0); for (let i = 0; i < 5; i++) m.hub.press('a'); return m; };
  await check('P1 the partner list opens on the day\'s mascot; SEARCH (its row, or Y) takes a word and lists only the species whose names hold it', () => {
    const m = toPartner();
    const v0 = m.hub.view().trainer, onMascot = v0.side.id === MASCOT;
    m.hub.press('y'); const e = m.st().entry;
    m.hub.type({ text: 'chu' }); m.hub.press('start');
    const v1 = m.hub.view().trainer, names = v1.rows.slice(1).map((r) => r.label), want = CH.species.filter((s) => s.name.toLowerCase().includes('chu')).map((s) => s.name);
    m.hub.press('a');
    return onMascot && e && e.charset === undefined ? 'entry ' + J(e) : onMascot && e && v1.rows[0].label === 'SEARCH: chu' && want.length > 0 && J(names) === J(want.slice(0, names.length)) && m.st().wiz.draft.partner === CH.species.find((s) => s.name === want[0]).id && step(m) === 'card' ? true : J([onMascot, e, v1.rows, want]);
  });
  await check('P2 a search with no match says so; an empty search lists every species again; the wheel and L / R page the list', () => {
    const m = toPartner();
    m.hub.press('y'); m.hub.type({ text: 'zzzq' }); m.hub.press('start');
    const none = m.hub.view(), noWords = none.msg[0] === W.noMatch && none.trainer.rows.length === 1;
    m.hub.press('a'); m.hub.type({ key: 'backspace' }); for (let i = 0; i < 5; i++) m.hub.type({ key: 'backspace' }); m.hub.press('start');
    const all = m.hub.view().trainer.title;
    const c0 = m.st().wiz.cur; m.hub.pointer({ kind: 'wheel', steps: 3 }); const c1 = m.st().wiz.cur; m.hub.press('r'); const c2 = m.st().wiz.cur;
    return noWords && /\/1038$|\/\d+$/.test(all) && Number(all.split('/')[1]) === CH.species.length && c1 === c0 + 3 && c2 === c1 + 6 ? true : J([none.msg, none.trainer.rows, all, c0, c1, c2]);
  });

  /* ---------------------------------------------------------------------------------------------- C: the card step */
  const toCard = () => { const m = visit('new'); answer(m.hub, 0); for (let i = 0; i < 6; i++) m.hub.press('a'); return m; };
  await check('C1 the card step shows every choice and asks "Is this right?" with YES / CHANGE; CHANGE moves to the card\'s parts', () => {
    const m = toCard(), v = m.hub.view(), d = defaults();
    const ok1 = v.trainer.kind === 'card' && v.trainer.card.name === d.name && v.trainer.card.front === d.front && v.trainer.card.partner === MASCOT && v.trainer.card.head === 0 && J(v.msg) === J(W.confirm.slice()) && J(v.trainer.chips.map((c) => c.label)) === J(['YES', 'CHANGE']);
    m.hub.press('right'); m.hub.press('a');
    return ok1 && m.st().wiz.focus === 'name' && J(m.hub.view().msg) === J(['Change your NAME?', 'A: change it   B: back']) ? true : J([v.trainer, v.msg, m.st().wiz]);
  });
  await check('C2 a part changed from the card comes back to the card (the figure through its two pictures); B from it comes back unchanged', () => {
    const m = toCard();
    const part = m.hub.rects().find((r) => r.kind === 'part' && r.id === 'figure');
    m.hub.pointer({ kind: 'click', x: part.x + 5, y: part.y + 5 });
    const s1 = step(m); m.hub.press('right'); m.hub.press('a'); const s2 = step(m); m.hub.press('right'); m.hub.press('a'); const s3 = step(m);
    const fr = m.st().wiz.draft.front, bk = m.st().wiz.draft.back;
    const lookBefore = m.st().wiz.draft.look;
    const look = m.hub.rects().find((r) => r.kind === 'part' && r.id === 'look'); m.hub.pointer({ kind: 'click', x: look.x + 3, y: look.y + 3 });
    const s4 = step(m); m.hub.press('right'); m.hub.press('b');
    return s1 === 'front' && s2 === 'back' && s3 === 'card' && fr !== defaults().front && bk !== defaults().back && s4 === 'look' && step(m) === 'card' && m.st().wiz.draft.look === lookBefore && !!lookBefore ? true : J([s1, s2, s3, fr, bk, s4, step(m), m.st().wiz.draft]);
  });

  /* ---------------------------------------------------------------------------------------------- E: the card screen and the editor */
  const made = { made: true, look: null, front: 3, back: 1, partner: 6 };
  await check('E1 no trainer: the card says so and offers NEW TRAINER (highlighted) and BACK; A opens the new-trainer screens, B goes back', () => {
    const m = mk(); m.hub.goto('trainer');
    const v = m.hub.view();
    const fx = m.hub.press('a');
    return v.trainer.empty === true && J(v.trainer.chips.map((c) => c.id)) === J(['new', 'back']) && v.trainer.focus === 'new' && J(v.msg) === J(W.none.slice()) && m.hub.path() === 'trainer-new' && J(m.hub.trail()) === J(['trainer', 'trainer-new']) && fx.length ? true : J([v.trainer, v.msg, m.hub.path()]);
  });
  await check('E2 one trainer: the card shows it; the d-pad walks NAME, the four pictures and the chips (no SWITCH with one trainer)', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made, avatar: { kind: 'preset', id: 4 }, record: { battles: 12, resettable: true, pages: [{}] } })] });
    m.app.setTrainers({ activeId: 'p1', list: [{ id: 'p1', name: 'RED', avatar: { kind: 'preset', id: 4 }, card: made }] });
    m.hub.goto('trainer');
    const v = m.hub.view().trainer, seen = [v.focus];
    for (const a of ['down', 'right', 'right', 'right', 'down', 'right', 'right', 'up', 'up']) { m.hub.press(a); seen.push(m.st().card.focus); }
    return v.card.name === 'RED' && v.card.head === 4 && v.card.front === 3 && v.card.partner === 6 && v.card.rec === 'BATTLES 12' && J(v.chips.map((c) => c.id)) === J(['new', 'back'])
      && J(seen) === J(['name', 'portrait', 'figure', 'partner', 'look', 'new', 'back', 'new', 'portrait', 'name']) ? true : J([v.card, seen]);
  });
  await check('E3 the editor: A on LOOK opens trainer-edit on the look; A keeps another one (an update effect with the card patch) and goes back to the card when saved; B cancels', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made })] }, { list: true });
    m.hub.goto('trainer'); focus(m, 'look'); m.hub.press('a');
    const p1 = m.hub.path(), st = m.st().edit, c0 = st.cur; m.hub.press('right'); const fx = m.hub.press('a'), u = fxOf(fx, 'update');
    const back = m.app.saved({ ok: true });
    focus(m, 'look'); m.hub.press('a'); m.hub.press('right'); const fxB = m.hub.press('b');
    return p1 === 'trainer-edit' && st.field === 'look' && st.step === 'look' && u && u.profileId === 'p1' && u.field === 'look' && J(Object.keys(u.patch)) === J(['card']) && u.patch.card.look === CL.lookCode(CH.looks[(c0 + 1) % CH.looks.length])
      && has(back, (e) => e.type === 'screen') && !fxOf(fxB, 'update') && m.hub.path() === 'trainer' ? true : J([p1, st, u, back, m.hub.path()]);
  });
  await check('E4 an edit that changes nothing saves nothing (A on the choice in use goes back without an effect)', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made })] }, { list: true });
    m.hub.goto('trainer'); focus(m, 'figure'); m.hub.press('a');
    const s = m.st().edit; const fx1 = m.hub.press('a'); const fx2 = m.hub.press('a');
    return s.field === 'figure' && !fxOf(fx2, 'update') && !fxOf(fx1, 'update') && m.hub.path() === 'trainer' && !m.app.saving() ? true : J([s, fx1, fx2, m.hub.path()]);
  });
  await check('E5 a read-only trainer: A on any part is refused in words (the failure sound) and opens nothing', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made, readOnly: true })] });
    m.hub.goto('trainer');
    const v0 = m.hub.view(), fx = m.hub.press('a'), v = m.hub.view();
    return m.hub.path() === 'trainer' && J(v.msg) === J(W.readOnly.slice()) && has(fx, (e) => e.type === 'sfx' && e.key === 'se_failure') && v0.msg[1] === W.readOnly[1] ? true : J([v.msg, fx, m.hub.path()]);
  });
  await check('E6 two trainers: SWITCH opens the list on the active one; another one chosen is a switch effect; the active one again is nothing; B closes it', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made }), prof('p2', 'BLUE', { card: made })] });
    m.hub.goto('trainer');
    const chips = m.hub.view().trainer.chips.map((c) => c.id);
    for (let i = 0; i < 5; i++) if (m.st().card.focus !== 'switch') m.hub.press(i === 0 ? 'up' : 'left');
    m.hub.press('a'); const sw0 = m.st().card.sw;
    const same = m.hub.press('a');
    m.hub.press('a'); m.hub.press('down'); const fx = m.hub.press('a');
    m.hub.press('a'); m.hub.press('b'); const closed = m.st().card.sw;
    return J(chips) === J(['switch', 'new', 'back']) && sw0 === 0 && same.length === 0 && has(fx, (e) => e.type === 'switch' && e.id === 'p2') && closed === null ? true : J([chips, sw0, same, fx, closed]);
  });
  await check('E7 trainer-edit opened by its address (no choice in hand) steps back to the card', () => {
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made })] }, { list: true });
    const fx = m.hub.arrive('trainer-edit', ['trainer', 'trainer-edit']);
    return m.hub.path() === 'trainer' && has(fx, (e) => e.type === 'screen' && e.path === 'trainer') ? true : J([fx, m.hub.path()]);
  });
  await check('E8 the ctl: an edited name is written by updateTrainer, SWITCH makes the other trainer active, LATER is kept in sessionStorage', async () => {
    const M = await memStore();
    try {
      const a = await TST.createTrainer(M.store, { name: 'RED', card: { made: true } }), b = await TST.createTrainer(M.store, { name: 'BLUE', card: { made: true } });
      const m = mk(await HD.readHubData(M.store, pack)); const env = ctlFor(m, M.store); await env.ctl.refresh();
      await env.ctl.effect({ app: 'trainer', type: 'update', profileId: a.id, field: 'name', patch: { name: 'ROSSO' } });
      await env.ctl.effect({ app: 'trainer', type: 'switch', id: a.id });
      await env.ctl.effect({ app: 'trainer', type: 'later', kind: 'new' });
      const list = await TST.listTrainers(M.store);
      return list.find((t) => t.id === a.id).name === 'ROSSO' && list.find((t) => t.id === a.id).active && !list.find((t) => t.id === b.id).active && env.session.getItem('arena.welcome') === 'later' ? true : J([list, env.session.map]);
    } finally { await M.done(); }
  });
  await check('E9 a data refresh asks a LOADED ctl to read the trainers again (another tab renamed one: the card shows it); before the ctl has handed a list, a refresh asks nothing (the ctl stays unloaded)', async () => {
    const M = await memStore();
    try {
      const a = await TST.createTrainer(M.store, { name: 'RED', card: { made: true } });
      const m = mk(await HD.readHubData(M.store, pack));
      const quiet = m.hub.setData(await HD.readHubData(M.store, pack)).filter((e) => e.app === 'trainer');
      const env = ctlFor(m, M.store); await env.ctl.refresh(); m.hub.goto('trainer');
      await TST.updateTrainer(M.store, a.id, { name: 'ROSSO' });          // (another tab)
      const fx = m.hub.setData(await HD.readHubData(M.store, pack)).filter((e) => e.app === 'trainer');
      for (const e of fx) await env.ctl.effect(e);
      return quiet.length === 0 && fx.length === 1 && fx[0].type === 'data' && m.hub.view().trainer.card.name === 'ROSSO' ? true : J([quiet, fx, m.hub.view().trainer.card]);
    } finally { await M.done(); }
  });

  /* ---------------------------------------------------------------------------------------------- F: failures */
  await check('F1 every refusal of a save is said in the picture and the screen stays (read-only, not saved, a conflict, refused, no storage, anything else)', () => {
    const bad = [];
    for (const why of ['readonly', 'notsaved', 'conflict', 'invalid', 'nostore', 'failed']) {
      const m = toCard(); m.hub.press('a');
      const fx = m.app.saved({ ok: false, why });
      if (fx.length || m.hub.path() !== 'trainer-new' || m.app.saving() || J(m.hub.view().msg) !== J(W.failed[why].slice())) bad.push(why + ' ' + J(m.hub.view().msg));
    }
    return bad.length ? J(bad) : true;
  });
  await check('F2 the ctl turns trainer_store.js\'s codes into those words: a read-only database refuses with the read-only words; a refused write with the not-saved words', async () => {
    const M = await memStore(); const name = M.name;
    try {
      await TST.createTrainer(M.store, { name: 'RED' });
      const ro = ST.createMemoryAdapter({ name, durable: true, readOnly: true }); await ro.open();
      const st2 = await ST.openStore({ adapter: ro, channel: false });
      const m = toCard(); const env = ctlFor(m, st2); await env.ctl.refresh();
      m.hub.press('a'); await env.ctl.effect({ app: 'trainer', type: 'save', mode: 'create', profileId: null, name: 'GOLD', avatar: { kind: 'preset', id: 0 }, card: { made: true, look: null, front: 3, back: 0, partner: 25 } });
      const w1 = m.hub.view().msg;
      const M2 = await memStore({ wrap: (inner) => ({ ...inner, transact: (n, mode, fn) => (mode === 'readwrite' && n.includes('profiles') ? Promise.reject(Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' })) : inner.transact(n, mode, fn)) }) });
      const m2 = toCard(); const env2 = ctlFor(m2, M2.store); m2.hub.press('a');
      await env2.ctl.effect({ app: 'trainer', type: 'save', mode: 'create', profileId: null, name: 'GOLD', avatar: { kind: 'preset', id: 0 }, card: { made: true, look: null, front: 3, back: 0, partner: 25 } });
      const w2 = m2.hub.view().msg; await M2.done();
      return J(w1) === J(W.failed.readonly.slice()) && m.hub.path() === 'trainer-new' && J(w2) === J(W.failed.notsaved.slice()) && TC.whyOf('conflict') === 'conflict' && TC.whyOf('name') === 'invalid' && TC.whyOf('???') === 'failed' ? true : J([w1, w2]);
    } finally { await M.done(); }
  });
  await check('F3 nothing is pressed or tapped while a save is under way (the screen says Saving...)', () => {
    const m = toCard(); m.hub.press('a');
    const before = J(m.st()), after = [];
    for (const a of ['b', 'a', 'left', 'up']) { const fx = m.hub.press(a); after.push(fx.length === 0 && J(m.st()) === before); }
    const r = m.hub.rects().length, fx = m.hub.pointer({ kind: 'click', x: 40, y: 100 });
    return after.every(Boolean) && r === 0 && fx.length === 0 && J(m.st()) === before && J(m.hub.view().msg) === J(W.saving.slice()) ? true : J([after, r, fx, step(m)]);
  });
  await check('F4 a browser that is not keeping profiles: the trainer is made, the screen goes back, and a notice says it is for this visit only', async () => {
    const name = 'tt-ns-' + Math.random().toString(36).slice(2);
    const st = await ST.openStore({ adapter: ST.createMemoryAdapter({ name, durable: false }), channel: false });
    try {
      const m = toCard(); const env = ctlFor(m, st); m.hub.press('a');
      await env.ctl.effect({ app: 'trainer', type: 'save', mode: 'create', profileId: null, name: 'GOLD', avatar: { kind: 'preset', id: 0 }, card: { made: true, look: null, front: 3, back: 0, partner: 25 } });
      const d = m.hub.dialog.current();
      const fits = screen.widths(m.hub.view()).every((w) => w.px <= w.max);
      return m.hub.path() === 'trainer' && d && d.id === 'notice:trainer' && J(m.hub.view().dialog.lines) === J(W.notKept.slice()) && fits && (await TST.listTrainers(st)).length === 1 ? true : J([m.hub.path(), d, screen.widths(m.hub.view())]);
    } finally { await st.close(); ST.dropMemoryDb(name); }
  });
  await check('F5 SWITCH TRAINER refused by the store (the trainer is gone) is said in the picture and nothing changes', async () => {
    const M = await memStore();
    try {
      const a = await TST.createTrainer(M.store, { name: 'RED', card: { made: true } });
      const m = mk(await HD.readHubData(M.store, pack)); const env = ctlFor(m, M.store); await env.ctl.refresh(); m.hub.goto('trainer');
      await env.ctl.effect({ app: 'trainer', type: 'switch', id: 'p_gone' });
      return J(m.hub.view().msg) === J(W.failed.failed.slice()) && (await M.store.getActiveId()) === a.id ? true : J([m.hub.view().msg]);
    } finally { await M.done(); }
  });

  /* ---------------------------------------------------------------------------------------------- G: pictures and words */
  const widest = (chars) => { let best = chars[0], bw = 0; for (const c of chars) { const w = screen.measureFont('normal', c); if (w > bw) { bw = w; best = c; } } return best; };
  // the widest character a name may hold (textentry.js mapChar 'name', every code point below U+3000), ten of it
  const NAME_CHARS = []; for (let cp = 32; cp < 0x3000; cp++) { let c = null; try { c = TE.mapChar('name', String.fromCodePoint(cp)); } catch (_e) { c = null; } if (c) NAME_CHARS.push(c); }
  const LONG_NAME = widest(NAME_CHARS).repeat(10);
  const longestBy = (list, f) => list.reduce((a, b) => (screen.measureFont('normal', f(b)) > screen.measureFont('normal', f(a)) ? b : a));
  const LONG_SPECIES = longestBy(CH.species, (s) => s.name), LONG_FRONT = longestBy(CH.fronts, (c) => c.cls);
  await check('G1 every front choice is drawn by the ROM (none excluded by FRONT_EXCLUDE is offered; none offered throws)', () => {
    const bad = [];
    for (const c of TF.frontChoices(romBytes)) { try { SG.trainerFront(romBytes, c.pic); } catch (e) { bad.push(c.pic + ' ' + c.cls); } if (TF.FRONT_EXCLUDE.includes(c.pic)) bad.push('excluded ' + c.pic); }
    return bad.length ? J(bad) : true;
  });
  const shots = {};
  const SHOTS = process.env.TRAINER_SHOTS && jsDir === SRC ? process.env.TRAINER_SHOTS : null, PNG = SHOTS ? await import(pathToFileURL(path.join(root, 'tools', 'arena_png.mjs')).href) : null;
  function shoot(name, m) { const fr = frame(m.hub); if (fr.fault) throw new Error(name + ' ' + J(fr.fault)); shots[name] = fnv(fr.rgba); if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); PNG.writePNG(path.join(SHOTS, String(Object.keys(shots).length).padStart(2, '0') + '-' + name + '.png'), 240, 160, fr.rgba); } }
  await check('G2 every screen draws without a fault, and every text is inside its room AT THE LONGEST VALUES (a 10-letter name of the widest letter, the longest species, class and record)', () => {
    const bad = [];
    const look = (name, m) => { shoot(name, m); const o = overflow(m.hub); if (o.length) bad.push(name + ': ' + o.join('; ')); };
    // the new-trainer screens, a long name typed
    let m = visit('new'); look('welcome', m); m.hub.press('a'); look('welcome-2', m); answer(m.hub, 0); look('name', m);
    m.hub.press('up'); m.hub.press('a'); look('name-entry', m); m.hub.type({ text: LONG_NAME }); look('name-entry-long', m); m.hub.press('start'); look('look', m);
    m.hub.press('a'); look('front', m);
    while (m.st().wiz.cur !== CH.fronts.indexOf(LONG_FRONT)) m.hub.press('right');
    look('front-long', m); m.hub.press('a'); look('back', m); m.hub.press('a'); look('portrait', m); m.hub.press('a'); look('partner', m);
    m.hub.press('y'); m.hub.type({ text: LONG_SPECIES.name.replace(/\{[A-Z]+\}/g, '').slice(0, 12) }); m.hub.press('start'); look('partner-long', m);
    m.hub.press('a'); look('card-confirm', m); m.hub.press('right'); look('card-change', m); m.hub.press('a'); look('card-part', m);
    { const c = m.hub.rects().find((x) => x.kind === 'chip' && x.id === 'yes'); m.hub.pointer({ kind: 'move', x: c.x + 3, y: c.y + 3 }); } m.hub.press('a'); if (!m.app.saving()) bad.push('YES did not save'); look('saving', m); m.app.saved({ ok: false, why: 'conflict' }); look('save-failed', m);
    // 'back' with the longest name
    m = visit('back', { state: 'ready', activeId: 'p1', profiles: [prof('p1', LONG_NAME)] }, { name: LONG_NAME, profileId: 'p1' }); look('welcome-back', m); answer(m.hub, 0); look('name-own-long', m);
    // the card screen: none, one (longest everything, read-only), two with the list open
    m = mk(); m.hub.goto('trainer'); look('card-none', m);
    m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', LONG_NAME, { readOnly: true, card: { made: true, look: null, front: LONG_FRONT.pic, back: 1, partner: LONG_SPECIES.id }, record: { battles: 99999, resettable: true, pages: [{}] } })] }, { list: true });
    m.hub.goto('trainer'); look('card-one', m); for (const a of ['down', 'right', 'right', 'right']) { m.hub.press(a); look('card-' + a + m.st().card.focus, m); } m.hub.press('a'); look('card-readonly', m);
    const many = []; for (let i = 0; i < 10; i++) many.push(prof('p' + i, LONG_NAME.slice(0, 10 - (i % 3)), { card: made }));
    m = mk({ state: 'ready', activeId: 'p3', profiles: many }, { list: true }); m.hub.goto('trainer'); { const c = m.hub.rects().find((x) => x.kind === 'chip' && x.id === 'switch'); m.hub.pointer({ kind: 'move', x: c.x + 3, y: c.y + 3 }); } look('card-switch-chip', m); m.hub.press('a'); if (m.st().card.sw === null) bad.push('the switch list did not open'); look('card-switch', m); for (let i = 0; i < 8; i++) m.hub.press('down'); look('card-switch-scrolled', m);
    // the editor
    m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made })] }); m.hub.goto('trainer'); focus(m, 'figure'); m.hub.press('a'); look('edit-figure', m); m.hub.press('a'); look('edit-back', m);
    // with no ROM choices yet (the ctl still loading)
    m = visit('new', null, { choices: false }); answer(m.hub, 0); m.hub.press('a'); look('loading', m);
    return bad.length ? J(bad) : true;
  });
  await check('G3 the pictures are the ones the ROM gave when they were looked at (trainer.golden.json: hashes only)', () => {
    if (UPDATE && jsDir === SRC) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'tools/pokemonarena_trainer_test.mjs --update: FNV-1a hashes of the trainer app\'s screens rendered from the ROM. Hashes only, never pixels.', hashes: shots }, null, 2) + '\n'); console.log('wrote', GOLDEN); }
    let golden = {}; try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).hashes || {}; } catch (_e) { golden = {}; }
    const off = Object.keys(shots).filter((k) => golden[k] !== shots[k]);
    const onlyHashes = Object.values(golden).every((h) => /^[0-9a-f]{8}$/.test(h));
    return !off.length && Object.keys(golden).length === Object.keys(shots).length && Object.keys(shots).length > 20 && onlyHashes ? true : J(off);
  });
  await check('G4 the screen reader is told each screen (and the welcome\'s {E} is read as E)', () => {
    const m = toCard(); const s1 = m.hub.speak(m.hub.view());
    const p = toPartner(); const s2 = p.hub.speak(p.hub.view());
    return /trainer card/i.test(s1) && /Is this right/.test(s1) && /Selected: Pikachu/.test(s2) && /POKEMON/.test(s2) && !/\{E\}/.test(s2) ? true : J([s1, s2]);
  });

  /* ---------------------------------------------------------------------------------------------- Z: the random walk */
  await check('Z1 a random walk of ' + WALK + ' inputs over the three screens (presses, held repeats, taps, hovers, the wheel, typing, ticks, saves answered, the browser\'s Back): no fault, every text in its room, a plain-JSON view', () => {
    const r = rng(7), acts = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];
    const m = mk({ state: 'ready', activeId: 'p1', profiles: [prof('p1', 'RED', { card: made }), prof('p2', 'BLUE', { readOnly: true })] });
    m.app.welcome({ kind: 'new' }); m.hub.goto('trainer-new');
    let bad = null;
    for (let i = 0; i < WALK && !bad; i++) {
      const k = r();
      if (m.hub.wantsText() && k < 0.15) m.hub.type(r() < 0.8 ? { text: String.fromCharCode(32 + Math.floor(r() * 95)) } : { key: ['backspace', 'enter', 'escape', 'left'][Math.floor(r() * 4)] });
      else if (k < 0.62) m.hub.press(acts[Math.floor(r() * acts.length)], { repeat: r() < 0.15 });
      else if (k < 0.75) m.hub.pointer({ kind: r() < 0.5 ? 'click' : 'move', x: Math.floor(r() * 240), y: Math.floor(r() * 160) });
      else if (k < 0.8) m.hub.pointer({ kind: 'wheel', steps: Math.floor(r() * 7) - 3 });
      else if (k < 0.9) for (let t = Math.floor(r() * 10); t >= 0; t--) m.hub.tick();
      else if (k < 0.94) { if (m.app.saving()) m.app.saved(r() < 0.5 ? { ok: true } : { ok: false, why: ['readonly', 'conflict', 'nope'][Math.floor(r() * 3)] }); }
      else if (k < 0.97) { const p = ['trainer', 'trainer-new', 'trainer-edit', 'main'][Math.floor(r() * 4)]; if (p === 'trainer-new' && r() < 0.5) m.app.welcome({ kind: r() < 0.5 ? 'new' : 'back' }); m.hub.goto(p); }
      else { const tr = m.hub.trail(); if (tr.length) m.hub.arrive(tr.length > 1 ? tr[tr.length - 2] : 'main', tr.slice(0, -1)); }
      const f = m.hub.faults(); if (f.length) { bad = 'fault at ' + i + ' ' + J(f); break; }
      const v = m.hub.view();
      if (J(JSON.parse(J(v))) !== J(v)) { bad = 'view not plain JSON at ' + i; break; }
      if (v.app === 'trainer' || v.dialog || v.entry) { const o = overflow(m.hub); if (o.length) { bad = 'overflow at ' + i + ' ' + m.hub.path() + ' ' + o.join('; '); break; } }
      const fr = screen.render(v); if (fr.fault) { bad = 'render fault at ' + i + ' ' + J(fr.fault); break; }
    }
    return bad || true;
  });

  const failed = results.filter((x) => !x.ok).map((x) => x.name);
  failed.checks = results.length;
  return failed;
}

/* ================================================================================================ mutants: one defect at a time, each must fail the check it names */
const NODE_MUTANTS = [
  { id: 'M1', file: 'hub_apps.js', from: 'export const APPS = Object.freeze([ONLINE, CENTER, BUILDER, TRAINER]);', to: 'export const APPS = Object.freeze([ONLINE, CENTER, BUILDER]);', fails: 'R1' },
  { id: 'M2', file: 'trainer_hub.js', from: "armTicks: w.auto ? DIALOG_ARM_TICKS : 0 });", to: 'armTicks: 0 });', fails: 'W2' },
  { id: 'M3', file: 'trainer_hub.js', from: "return [{ app: ID, type: 'later', kind }].concat(kind === 'another' ? ctx.back() : ctx.go('main'));", to: "return [{ app: ID, type: 'later', kind }].concat(ctx.back());", fails: 'W3' },
  { id: 'M4', file: 'trainer_hub.js', from: "      if (action === 'b') return later();\n      if (action === 'up'", to: "      if (action === 'b') return ctx.back();\n      if (action === 'up'", fails: 'W7' },
  { id: 'M5', file: 'trainer_hub.js', from: "const a = (p.profileId && trainerList().find((t) => t.id === p.profileId)) || active();", to: 'const a = active();', fails: 'W6' },
  { id: 'M6', file: 'trainer_hub.js', from: "return i >= 0 ? i : pk.items.findIndex((x) => x.id === 'preset'); }", to: 'return i >= 0 ? i : 0; }', fails: 'A1' },
  { id: 'M7', file: 'trainer_hub.js', from: "const w = S.wiz, t = w.mode === 'update' ? trainerList().find((x) => x.id === w.profileId) : null,", to: 'const w = S.wiz, t = null,', fails: 'W6' },
  { id: 'M8', file: 'trainer_hub.js', from: "case 'up': return cur > 0 ? cur - 1 : repeat ? 0 : n - 1;", to: "case 'up': return cur > 0 ? cur - 1 : n - 1;", fails: 'K1' },
  { id: 'M9', file: 'trainer_hub.js', from: "case 'right': return cur < n - 1 ? cur + 1 : repeat ? n - 1 : 0;\n    case 'up': return cur - cols", to: "case 'right': return cur < n - 1 ? cur + 1 : 0;\n    case 'up': return cur - cols", fails: 'K4' },
  { id: 'M10', file: 'trainer_hub.js', from: '      if (t.readOnly) return refuse(WORDS.readOnly);\n      S.edit =', to: '      S.edit =', fails: 'E5' },
  { id: 'M11', file: 'trainer_hub.js', from: '    if (same) return ctx.back();', to: '    if (false) return ctx.back();', fails: 'E4' },
  { id: 'M12', file: 'trainer_hub.js', from: '    if (a && t.id === a.id) return [];\n', to: '', fails: 'E6' },
  { id: 'M13', file: 'trainer_hub.js', from: "else if (path === 'trainer-edit') { if (!S.edit) return ctx.go('trainer'); }", to: "else if (path === 'trainer-edit') { /* no guard */ }", fails: 'E7' },
  { id: 'M14', file: 'trainer_hub.js', from: '    if (S.saving) return [];\n    const step = stepNow(path);\n    if (path === \'trainer\')', to: '    const step = stepNow(path);\n    if (path === \'trainer\')', fails: 'F3' },
  { id: 'M15', file: 'trainer_hub.js', from: "const list = q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;", to: "const list = q ? all.filter((s) => s.name.toLowerCase().startsWith(q)) : all;", fails: 'P1' },
  { id: 'M16', file: 'trainer_hub.js', from: "    if (w.ret === 'card' && w.step !== 'front') { w.ret = null; w.step = 'card'; return []; }", to: "    if (w.ret === 'card') { w.ret = null; w.step = 'card'; return []; }", fails: 'C2' },
  { id: 'M17', file: 'trainer_hub.js', from: "      const why = r && WORDS.failed[r.why] ? r.why : 'failed';\n      note(WORDS.failed[why], true);\n", to: '', fails: 'F1' },
  { id: 'M18', file: 'trainer_ctl.js', from: "    if (look) { try { saveLook(env.storage, look); } catch (_e) { /* the Center falls back to the card's look */ } }\n", to: '', fails: 'A2' },
  { id: 'M19', file: 'trainer_ctl.js', from: "export const WHY = Object.freeze({ 'read-only': 'readonly',", to: "export const WHY = Object.freeze({ 'read-only': 'failed',", fails: 'F2' },
  { id: 'M20', file: 'trainer_ctl.js', from: "try { if (env.session) env.session.setItem(LATER.key, LATER.value); }", to: 'try { /* not kept */ }', fails: 'E8' },
  { id: 'M21', file: 'trainer_ctl.js', from: "const r = eff.mode === 'update' && eff.profileId ? await updateTrainer(store, eff.profileId, input) : await createTrainer(store, input);", to: 'const r = await createTrainer(store, input);', fails: 'A3' },
  { id: 'M22', file: 'trainer_screen.js', from: '    const font = o.max ? h.fitFont(s, o.max, fonts) : fonts[0];', to: '    const font = fonts[0];', fails: 'G2' },
  { id: 'M23', file: 'trainer_figures.js', from: 'export const FRONT_EXCLUDE = Object.freeze([67, 78, 137, 138, 139]);', to: 'export const FRONT_EXCLUDE = Object.freeze([67, 78, 137, 139]);', fails: 'G1' },
  { id: 'M25', file: 'trainer_hub.js', from: "        if (it.id === 'new') return openName(host);\n", to: '', fails: 'N1' },
  { id: 'M26', file: 'trainer_ctl.js', from: '    if (ok) env.sound.sfx(\'se_success\');', to: '', fails: 'A2' },
  { id: 'M27', file: 'trainer_hub.js', from: "    onData() { return S.trainers ? [{ app: ID, type: 'data' }] : []; },", to: '    onData() { return []; },', fails: 'E9' },
  { id: 'M29', file: 'trainer_hub.js', from: 'species = isInt(seen.partner) ? seen.partner : S.mascotSet || !isInt(hubMascot) ? S.mascot : hubMascot;', to: 'species = isInt(seen.partner) ? seen.partner : S.mascot;', fails: 'W8' },
  { id: 'M30', file: 'trainer_hub.js', from: '        if (r.notSaved) ctx.notify(WORDS.notKept.slice());', to: '', fails: 'F4' },
  { id: 'M31', file: 'trainer_ctl.js', from: '    if (!r.ok) { app.failed(whyOf(r.code)); env.redraw(); return; }', to: '    if (!r.ok) { env.redraw(); return; }', fails: 'F5' },
  { id: 'M28', file: 'trainer_hub.js', from: "    onData() { return S.trainers ? [{ app: ID, type: 'data' }] : []; },", to: "    onData() { return [{ app: ID, type: 'data' }]; },", fails: 'E9' },
];
async function runMutants() {
  let killed = 0, ran = 0;
  for (const m of NODE_MUTANTS) {
    if (ONE && ONE !== m.id) continue;
    ran++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trn-mut-'));
    for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
    const fp = path.join(dir, m.file);
    const body = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
    const n = body.split(m.from).length - 1;
    if (n !== 1) { console.log('MUTANT', m.id, 'snippet occurs', n, 'times in', m.file); fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.writeFileSync(fp, body.replace(m.from, () => m.to));
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '__child', dir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000, windowsHide: true, env: { ...process.env, TRAINER_WALK: '400' } });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('CHILD_FAILED '));
    let failed = [];
    try { failed = line ? JSON.parse(line.slice('CHILD_FAILED '.length)) : ['threw: the run did not finish (' + String(r.stderr || r.error || '').slice(0, 300) + ')']; } catch (_e) { failed = ['threw: unreadable result']; }
    const hit = failed.some((f) => f.startsWith(m.fails + ' '));
    if (hit) killed++; else console.log('MUTANT SURVIVED', m.id, m.file, '(expected', m.fails, 'to fail; failed:', J(failed.map((f) => f.split(' ')[0])) + ')');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('node mutants killed', killed + '/' + ran);
  return killed === ran;
}

/* ================================================================================================ main */
if (args[0] === '__child') {
  let failed = [];
  try { failed = await runNode(args[1], false); } catch (e) { failed = ['threw: ' + e.message]; }
  console.log('CHILD_FAILED ' + JSON.stringify(failed));
  process.exit(0);
}
console.log('pokemonarena trainer test; ROM', ROM_PATH, romBytes.length, 'B; node', process.version);
const failed = await runNode(SRC, true);
console.log('node checks: ' + (failed.length ? failed.length + ' failed of ' + failed.checks : 'all passed (' + failed.checks + ')'));
let mutOk = true;
if (MUTANTS) mutOk = await runMutants();
if (failed.length || !mutOk) { console.log('FAILED'); process.exit(1); }
console.log('OK');
