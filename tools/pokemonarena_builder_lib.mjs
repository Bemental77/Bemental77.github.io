// tools/pokemonarena_builder_lib.mjs -- helpers shared by the Team Builder's tests (pokemonarena_builder_test.mjs, pokemonarena_builder_page_test.mjs): a WORLD in Node (the hub model with the
// real ROM fonts, the builder's ctl, a memory-backed profile store, a page double that carries effects out the way boot.js does), and the PNG writer for looking at the screens. TEST-ONLY.
//
//   const W = await makeWorld();                 // the game's own modules; makeWorld({ dir }) loads a mutated copy of pokemonarena/js instead
//   await W.open();                              // the main menu's TEAM BUILDER: the ctl enters, loads, the model is ready
//   await W.press('a', 'down');                  // presses, carried out; awaits the ctl (not its debounce: W.fire() runs the pending timers, W.saved() waits for the write)
//   W.view(), W.b() (view.builder), W.app (the builder's model), W.ctl, W.store, W.hub, W.frame() (the 240x160 picture), W.texts() (every text drawn, with its room)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';
import { writePNG, scaleRGBA } from './arena_png.mjs';

export const SRC = path.join(L.root, 'pokemonarena', 'js');
export const rom = L.readRom();
const imp = (dir, f) => import(pathToFileURL(path.join(dir, f)).href);
let shared = null;
const trees = new Map();
/** The game's own modules and the ROM-made things every world shares (the pack, the renderer). */
export async function base() {
  if (shared) return shared;
  const M = {};
  for (const [k, f] of Object.entries({ HM: 'hub_model.js', HS: 'hub_screen.js', BU: 'battle_ui.js', T: 'tables.js', ST: 'store.js', P: 'profile.js', HD: 'hub_data.js', BK: 'builder_kit.js', BC: 'builder_ctl.js', BH: 'builder_hub.js', BS: 'builder_screen.js', BG: 'builder_geom.js', BP: 'builder_parts.js', ES: 'editor_state.js', ED: 'editor_data.js', RU: 'rules.js', TC: 'teamcode.js', CS: 'charset.js', DG: 'hub_dialog.js' })) M[k] = await imp(SRC, f);
  const ui = M.BU.createBattleUi(rom), pack = M.T.loadPack(rom, { verify: 'header', dexText: false });
  shared = { M, ui, pack, screen: M.HS.createHubScreen(ui) };
  return shared;
}

/** Deterministic ids and a clock that moves one millisecond a call. */
export function fakeDeps(seed = 1) {
  let n = seed >>> 0, t = 1700000000000;
  return { now: () => ++t, randomBytes: (k) => { const b = new Uint8Array(k); for (let i = 0; i < k; i++) { n = (Math.imul(n, 1103515245) + 12345) >>> 0; b[i] = (n >>> 16) & 255; } return b; } };
}
/** localStorage / sessionStorage as a Map. */
export function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

/**
 * opts: { dir (a js/ directory to load the hub, the builder and the kit from: a mutant), store (reuse one: a "second tab", a "reload"), session, storage, deps, noStore: true (storage could
 * not be opened), durable (false: a store that keeps nothing), data: false (do not give the hub its first data) }
 */
export async function makeWorld(opts = {}) {
  const S0 = await base();
  const dir = opts.dir || SRC, own = dir !== SRC;
  // (a mutated tree gets its own modules, loaded once; the ROM-made renderer underneath is shared: the mutants are in the hub, the builder and its ctl, never in battle_ui.js)
  let T = trees.get(dir);
  if (!T) { T = own ? { HM: await imp(dir, 'hub_model.js'), HS: await imp(dir, 'hub_screen.js'), BC: await imp(dir, 'builder_ctl.js'), ST: await imp(dir, 'store.js'), HD: await imp(dir, 'hub_data.js') } : { HM: S0.M.HM, HS: S0.M.HS, BC: S0.M.BC, ST: S0.M.ST, HD: S0.M.HD }; T.screen = own ? T.HS.createHubScreen(S0.ui) : S0.screen; trees.set(dir, T); }
  const { HM, BC, ST, HD } = T;
  const ui = S0.ui, screen = T.screen, pack = S0.pack;
  const deps = opts.deps || fakeDeps(opts.seed || 1);
  const store = opts.noStore ? null : opts.store || await ST.openStore({ adapter: ST.createMemoryAdapter({ name: 'builder-test-' + Math.random().toString(36).slice(2), durable: opts.durable !== false }), channel: false, deps, storage: null });
  const hub = HM.createHubModel({ mascot: 25, env: 0, measure: screen.measure, msgPx: screen.msgPx, measureFont: screen.measureFont });
  const app = hub.apps.builder;
  const timers = [], log = { effects: [], sfx: [], redraws: 0, refreshes: 0, navigated: [] };
  let tid = 0, family = null, familyPath = null, ctl = null;
  const session = opts.session || fakeStorage(), storage = opts.storage || fakeStorage();
  const isMine = (p) => app.paths.includes(p);
  async function refreshData() { if (!store) return; log.refreshes++; run(hub.setData(await HD.readHubData(store, pack, { tzMinutes: 0 }))); }
  const env = {
    win: null, doc: null, hook: {}, model: hub, app, store: () => store, whenStore: async () => store, pack, rom, ui, navigate: (u) => log.navigated.push(u), input: null, storage, session, deps,
    refreshData, redraw: () => { log.redraws++; }, run: (fx) => run(fx), freshSeed: () => 1, sound: { sfx: (k) => { log.sfx.push(k); return true; }, music: () => true, system: () => null },
    timers: { set: (fn, ms) => { const t = { id: ++tid, fn, ms }; timers.push(t); return t.id; }, clear: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); } },
  };
  ctl = BC.createCtl(env);
  // what boot.js does with effects: an app's go to its ctl, a screen change syncs the family (the ctl's enter / leave)
  function syncFamily() {
    const p = hub.path(), now = isMine(p) ? 'builder' : null;
    if (now === family) { familyPath = p; return; }
    if (family) ctl.leave(familyPath);
    family = now; familyPath = p;
    if (now) ctl.enter(p);
  }
  function run(fx) {
    for (const e of fx || []) {
      log.effects.push(e);
      if (e.app === 'builder') { const r = ctl.effect(e); if (r && typeof r.then === 'function') r.catch((err) => { log.failed = String(err && err.message ? err.message : err); }); }
      else if (e.type === 'screen') syncFamily();
    }
    syncFamily();
  }
  const turn = () => new Promise((r) => setImmediate(r));
  /** Wait for the ctl: its queue and a write in flight (NOT its debounce timer). */
  async function idle() { for (let i = 0; i < 50; i++) { await ctl.idle(); await turn(); if (!ctl.state().saving) { await ctl.idle(); await turn(); if (!ctl.state().saving) return; } } }
  /** Run the timers that are pending (the autosave's debounce) and wait for what they started. -> how many ran. */
  async function fire() { const due = timers.splice(0); for (const t of due) t.fn(); await idle(); return due.length; }
  /** The debounce, the write, and the hub's refresh after it. */
  async function saved() { await idle(); for (let i = 0; i < 8 && timers.length; i++) await fire(); await idle(); }
  const W = {
    hub, app, ctl, store, env, log, screen, ui, pack, timers, session, storage, deps, M: S0.M,
    run, idle, fire, saved, refreshData,
    /** Presses, each carried out; then the ctl is awaited. -> the effects of the LAST press. */
    async press(...actions) { let fx = []; for (const a of actions) { fx = hub.press(a); run(fx); } await idle(); return fx; },
    /** One press with the repeat flag of a held direction. */
    async hold(action, n = 1) { for (let i = 0; i < n; i++) run(hub.press(action, { repeat: true })); await idle(); },
    async type(input) { const fx = hub.type(typeof input === 'string' ? { text: input } : input); run(fx); await idle(); return fx; },
    /** Type a word into the open text entry and accept it. */
    async enter(text) { if (text) run(hub.type({ text })); const fx = hub.type({ key: 'enter' }); run(fx); await idle(); return fx; },
    async click(x, y) { const fx = hub.pointer({ kind: 'click', x, y }); run(fx); await idle(); return fx; },
    async goto(p, o) { const fx = hub.goto(p, o); run(fx); await idle(); return fx; },
    async arrive(p, trail) { const fx = hub.arrive(p, trail); run(fx); syncFamily(); await idle(); return fx; },
    /** The main menu's TEAM BUILDER row, as a player reaches it. */
    async open() { if (opts.data !== false && hub.state().data.state === 'loading') await refreshData(); return W.goto('builder'); },
    view: () => hub.view(), b: () => hub.view().builder, path: () => hub.path(), st: () => hub.state().apps.builder,
    rows: () => { const v = hub.view(); return v.menu ? v.menu.rows : []; },
    row: () => { const v = hub.view(); return v.menu ? v.menu.rows[v.menu.cursor] || null : null; },
    /** Walk the open list's cursor to the row with this id (the list wraps, so it is found within its length). -> whether it was. */
    async toRow(id, max = 1200) { for (let i = 0; i < max; i++) { const r = W.row(); if (r && r.id === id) return true; run(hub.press('down')); } return false; },
    /** The pop-up's row with this id: put the cursor on it. */
    async toPop(id) { for (let i = 0; i < 12; i++) { const p = W.b().popup; if (!p) return false; if (p.rows[p.cursor].id === id) return true; run(hub.press('down')); } return false; },
    profile: () => (app.editor() ? app.editor().profile : null),
    /** The 240x160 frame of the view now. */
    frame: (v) => screen.render(v || hub.view()),
    hash: (v) => L.fnv(screen.render(v || hub.view()).rgba),
    /** Every text the builder's renderer draws for the view now, with the room each had (builder_screen.js measure). */
    texts: (v) => screen.app('builder').measure(screen.frame(), v || hub.view()),
    /** A stored profile, read back from the store (what a reload would find). */
    async stored(id) { const r = await store.loadProfile(id || (await store.getActiveId())); return r.ok ? r.profile : null; },
    png(file, v) { const f = screen.render(v || hub.view()); fs.mkdirSync(path.dirname(file), { recursive: true }); const s = scaleRGBA(240, 160, f.rgba, 3); writePNG(file, 720, 480, s.rgba || s); return f; },
  };
  return W;
}

/** Text of a view an assertion can read: the message's two lines. */
export const msg = (W) => W.view().msg.join(' | ');
