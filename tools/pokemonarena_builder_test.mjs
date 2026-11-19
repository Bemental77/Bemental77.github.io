// tools/pokemonarena_builder_test.mjs -- THE TEAM BUILDER in the hub's picture, in Node: the state machine driven action by action through the real hub model (builder_hub.js and its screen
// families), its ctl against a memory-backed profile store (builder_ctl.js: load, edit, autosave, conflict, read-only), and the ROM renderer (builder_screen.js and its painters).
// The browser side (a real Chrome, real IndexedDB) is tools/pokemonarena_builder_page_test.mjs.
//
//   node tools/pokemonarena_builder_test.mjs               the checks, then every source mutant (each must trip the NAMED check it is aimed at)
//   node tools/pokemonarena_builder_test.mjs --no-mutants  the checks only
//   node tools/pokemonarena_builder_test.mjs --update      rewrite pokemonarena/builder.golden.json (hashes only) after an intended change of look
//   node tools/pokemonarena_builder_test.mjs --shots DIR   also write a PNG of every catalogued screen into DIR (to LOOK at them; nothing ROM-made is committed)
//   ARENA_VERBOSE=1                                         print every check
//
// GROUPS  A the registry and the router   B trainers   C teams   D team, rules, check   E the Pokemon screen (BUILD)   F the pickers   G the ctl and the store
//         H the MOVES tab and the move picker   I the STATS tab   J the portrait, the team code, the test battle   K undo and redo   R the renderer
// Every check is named; a mutant names the group it runs in and a piece of the name of the check that must fail. The reducer itself is tools/pokemonarena_editor_test.mjs's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';
import { makeWorld, base, fakeDeps, fakeStorage, SRC, rom, msg } from './pokemonarena_builder_lib.mjs';

const { root, J } = L;
const ARGS = process.argv.slice(2);
const WANT_MUTANTS = !ARGS.includes('--no-mutants') && process.env.ARENA_SKIP_MUTANTS !== '1';
const UPDATE = ARGS.includes('--update');
const SHOTS = ARGS.includes('--shots') ? ARGS[ARGS.indexOf('--shots') + 1] : null;
const ONLY = ARGS.filter((a) => /^[A-Z]$/.test(a));
const GOLDEN = path.join(root, 'pokemonarena', 'builder.golden.json');
const C = L.makeCounter('builder');
const ok = C.ok;
const S0 = await base();
const { M, pack, ui } = S0;
const ST = await L.mod('stats.js'), EL = await L.mod('editor_links.js');
console.log('pokemonarena builder test; ROM', L.ROM_PATH, rom.length, 'B; node', process.version);

const STD = 'arena-gen3-standard', CHAMP = 'arena-gen3-standard+strict-champions';
const sid = (name) => { const id = pack.species.findIndex((s) => s && s.legal && s.name === name); if (id < 0) throw new Error('no species ' + name); return id; };
const plain = (v) => { const bad = []; (function walk(x, p) { if (x === undefined || typeof x === 'function') bad.push(p); else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], p + '.' + k); })(v, 'view'); return bad; };
const eff = (fx, type) => (fx || []).filter((e) => e.type === type);
const optionsOf = (W) => { const d = W.hub.view().dialog; return d && d.choice ? d.choice.options : null; };

/**
 * A profile made through the REDUCER and saved in the store (never a hand-made document): seed(W.store, deps, 'RED', [{ name, ruleset, mons: ['Pikachu', ...] }]) -> the saved profile.
 * o.active: make it the store's active profile (default true).
 */
async function seed(store, deps, trainer, teams = [], o = {}) {
  const kit = M.BK.createBuilderKit({ pack, deps });
  const saved = await store.createProfile({ trainerName: trainer });
  let s = kit.initialState(saved);
  for (const t of teams) {
    s = kit.reduce(s, { type: 'teamCreate', ...(t.name ? { name: t.name } : {}), ...(t.ruleset ? { ruleset: t.ruleset } : {}) });
    if (s.error) throw new Error('seed teamCreate: ' + s.error.message);
    const teamId = s.result.teamId;
    for (const name of t.mons || []) { s = kit.reduce(s, { type: 'monAdd', teamId, species: typeof name === 'number' ? name : sid(name) }); if (s.error) throw new Error('seed monAdd ' + name + ': ' + s.error.message); }
    if (t.then) { s = kit.reduce(s, { type: 'teamRuleset', teamId, ruleset: t.then }); if (s.error) throw new Error('seed teamRuleset: ' + s.error.message); }          // (built under one ruleset, judged under another: that is how a team comes to have problems)
  }
  const out = teams.length ? await store.saveProfile(s.profile, { reason: 'seed' }) : saved;
  if (o.active !== false) await store.setActiveId(out.id);
  return out;
}

/* ================================================================================================ the checks */
// Every check is t(name, async () => truthy, () => detail). A check that throws is a failure with what it threw; nothing a check does can hide the ones before it.
async function runChecks(dir, groups) {
  const fails = [], names = [];
  const want = (g) => !groups || groups.includes(g);
  const mk = (o) => makeWorld({ dir, ...(o || {}) });
  const t = async (name, fn, detail) => {
    names.push(name);
    let good = false, why = '';
    try { good = !!(await fn()); } catch (err) { why = ' [threw: ' + (err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' / ') : err) + ']'; }
    if (good) { if (process.env.ARENA_VERBOSE && dir === SRC) console.log('  ok  ', name); return; }
    if (!why && detail) { try { why = ' [' + String(await detail()).slice(0, 400) + ']'; } catch (_e) { why = ' [detail threw]'; } }
    fails.push(name + why);
  };
  /** A world with one trainer whose teams were seeded, opened at the trainers screen. */
  const seeded = async (teams, o) => { const W = await mk(o); const p = await seed(W.store, W.deps, (o && o.trainer) || 'RED', teams); await W.open(); W.pid = p.id; return W; };
  /** ... and walked to the first team's screen. */
  const atTeam = async (teams, o) => { const W = await seeded(teams, o); await W.press('a'); await W.press('a'); return W; };
  /** ... and to the first Pokemon of that team. */
  const atMon = async (teams, o) => { const W = await atTeam(teams, o); await W.press('a'); await W.press('a'); return W; };
  const teamOf = (W, i = 0) => W.profile().teams[i];
  const monOf = (W, i = 0, ti = 0) => W.profile().box.find((m) => m.id === teamOf(W, ti).monIds[i]);
  const cursorSlot = (W) => W.st().screens['builder-team'].cursor;
  const clickSlot = async (W, i) => { const r = W.hub.rects()[i]; return W.click(r.x + 40, r.y + 8); };
  const find = async (W, word) => { await W.press('start'); return W.enter(word); };
  /** Answer the open YES / NO question: read its pages, then YES (up, A) or NO (A: NO is where the cursor starts). */
  const answer = async (W, yes) => { for (let i = 0; i < 6 && W.hub.view().dialog && W.hub.view().dialog.more; i++) await W.press('a'); if (yes) await W.press('up'); return W.press('a'); };
  const asked = (W) => { const d = W.hub.dialog.current(), v = W.hub.view().dialog; return d ? { options: d.choice ? d.choice.options.join() : '', cursor: d.choice ? d.choice.cursor : -1, text: v.lines.join(' '), id: d.id } : null; };

  /* ---------------------------------------------------------------------------------------------- A: the registry and the router */
  if (want('A')) {
    const BH = dir === SRC ? M.BH : await import(pathToFileURL(path.join(dir, 'builder_hub.js')).href);
    const HM = dir === SRC ? M.HM : await import(pathToFileURL(path.join(dir, 'hub_model.js')).href);
    const PATHS = ['builder', 'builder-teams', 'builder-team', 'builder-rules', 'builder-check', 'builder-mon', 'builder-species', 'builder-item', 'builder-move', 'builder-portrait', 'builder-code', 'builder-test'];
    await t('A. registry: the builder owns twelve paths, each "builder" or "builder-...", and every one is a hub path the address may name', () => J(BH.APP.paths) === J(PATHS) && PATHS.every((p) => HM.PATHS.includes(p)) && BH.APP.id === 'builder', () => J(BH.APP.paths));
    await t('A. registry: parent(path) is a function of the path alone and leads every screen back to the main menu (trainers < teams < team < rules / check / Pokemon / species picker / test; the item and move pickers under the Pokemon; the portrait under the trainers; the code under the teams)', () => {
      const up = (p) => BH.APP.parent(p);
      return up('builder') === 'main' && up('builder-teams') === 'builder' && up('builder-team') === 'builder-teams' && ['builder-rules', 'builder-check', 'builder-mon', 'builder-species', 'builder-test'].every((p) => up(p) === 'builder-team') && up('builder-item') === 'builder-mon'
        && up('builder-move') === 'builder-mon' && up('builder-portrait') === 'builder' && up('builder-code') === 'builder-teams'
        && J(HM.arrivalTrail('builder-item')) === J(['builder', 'builder-teams', 'builder-team', 'builder-mon', 'builder-item']);
    }, () => J(PATHS.map((p) => BH.APP.parent(p))));
    await t('A. registry: every screen has a page title that says Team Builder', async () => { const W = await mk(); return PATHS.every((p) => /^Pokemon Arena - Team Builder/.test(W.hub.title(p))) && W.hub.title('builder') === 'Pokemon Arena - Team Builder'; });
    await t('A. registry: a family with a path defined twice, or a screen without { parent, title, need, create }, is refused by name when the app is made', () => {
      const dup = { id: 'x', screens: { builder: { parent: 'main', title: 'x', need: 'none', create: () => ({}) } } };
      let a = '', b = '';
      try { BH.makeApp([...BH.FAMILIES, dup]); } catch (e) { a = e.message; }
      try { BH.makeApp([{ id: 'y', screens: { 'builder-y': { parent: 'main', need: 'everything', create: () => ({}) } } }]); } catch (e) { b = e.message; }
      return /builder is defined twice/.test(a) && /builder-y needs/.test(b);
    });
    await t('A. before the ctl has loaded every builder screen says it is opening, takes no press but B, and B goes back', async () => {
      const W = await mk(); W.hub.goto('builder');                        // (the effects are NOT carried out: no ctl ever enters)
      const v = W.view(), fx0 = W.hub.press('a'), fx1 = W.hub.press('down'), fx2 = W.hub.press('b');
      return v.builder.kind === 'wait' && /Opening the Team Builder/.test(v.msg[0]) && fx0.length === 0 && fx1.length === 0 && W.path() === 'main' && fx2[0].type === 'screen' && W.hub.faults().length === 0 && W.st().phase === 'boot';
    });
    await t('A. a screen opened by its address before any profile is read waits, and settles on the nearest screen that can be shown once the ctl is ready (a team screen with no team: the teams; with no profile: the trainers)', async () => {
      const W = await mk(); await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]);
      await W.refreshData(); await W.arrive('builder-team');
      const a = W.path() === 'builder-teams' && J(W.hub.trail()) === J(['builder', 'builder-teams']);
      const V = await mk(); await V.refreshData(); await V.arrive('builder-mon');
      return a && V.path() === 'builder' && J(V.hub.trail()) === J(['builder']) && W.hub.faults().length === 0 && V.hub.faults().length === 0;
    });
    await t('A. a screen whose team is gone (deleted under it) is left for the teams list, and one whose Pokemon is gone for the team', async () => {
      const W = await atMon([{ mons: ['Pikachu', 'Gengar'] }]);
      const mid = monOf(W, 0).id, tid = teamOf(W).id;
      W.app.edit({ type: 'monRemove', teamId: tid, monId: mid }); W.run(W.app.settle());
      const a = W.path() === 'builder-team';
      W.app.edit({ type: 'teamDelete', teamId: tid }); W.run(W.app.settle());
      return a && W.path() === 'builder-teams';
    });
    await t('A. an edit asks the ctl to save: one "edited" effect however the edit was made, and none for a press that edits nothing', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]);
      await W.toRow('shiny');
      const a = await W.press('right'), b = await W.press('down');
      return eff(a, 'edited').length === 1 && a.every((e) => e.app === 'builder') && eff(b, 'edited').length === 0 && monOf(W).shiny === true;
    });
    await t('A. a pop-up menu takes every press while it is open (the list under it does not move) and B closes it', async () => {
      const W = await seeded([{ mons: ['Pikachu'] }, {}]); await W.press('a');
      await W.press('right');
      const open = !!W.b().popup, cur = W.st().screens['builder-teams'].cursor;
      await W.press('down', 'down');
      const same = W.st().screens['builder-teams'].cursor === cur && W.b().popup.cursor === 2;
      await W.press('b');
      return open && same && !W.b().popup && W.path() === 'builder-teams';
    });
    await t('A. a screen that closes takes its text entry and its pop-up with it', async () => {
      const W = await seeded([{ mons: ['Pikachu'] }]);
      await W.press('right'); await W.toPop('rename'); await W.press('a');          // (the trainer's RENAME: the list's own NEW TRAINER entry is gone, it is the trainer app's screens now)
      const typing = W.hub.wantsText() && W.st().entry !== null;
      await W.arrive('main'); const gone = W.st().entry === null; await W.goto('builder');
      const closed = !W.hub.wantsText() && !W.view().entry;
      await W.press('right'); const pop = !!W.b().popup && W.st().popup !== null;
      await W.arrive('main'); const gone2 = W.st().popup === null; await W.goto('builder');
      return typing && gone && closed && pop && gone2 && !W.b().popup;
    });
    await t('A. leaving closes the builder\'s own question (DELETE THIS TEAM? does not follow the player to another screen)', async () => {
      const W = await seeded([{ mons: ['Pikachu'] }]); await W.press('a'); await W.press('right'); await W.toPop('delete'); await W.press('a');
      const asked = W.hub.dialog.isOpen();
      await W.arrive('builder');
      return asked && !W.hub.dialog.isOpen() && W.profile().teams.length === 1;
    });
    await t('A. A reads a long note to its end before it acts: a notice of three lines shows its first page with the "more" arrow, A turns the page (and changes nothing), and only the next A acts', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]);
      await W.press('down', 'down', 'down'); await W.press('a'); await W.press('right');          // RULES: MODE becomes LEVEL 5, and the reducer's notice is three lines long
      const v1 = W.view(), r1 = teamOf(W).ruleset;
      await W.press('a'); const v2 = W.view(), r2 = teamOf(W).ruleset;
      await W.press('a'); const r3 = teamOf(W).ruleset;
      return v1.builder.pages === 2 && v1.builder.page === 1 && v1.builder.more === true && v1.builder.note === true && /^Rules changed/.test(v1.msg[0]) && v2.builder.page === 2 && v2.builder.more === false && r2 === r1 && r3 !== r1;
    }, async () => 'x');
    await t('A. SELECT and a tap on the message box turn the page of a long message and come round to the first', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]);
      await W.press('down', 'down', 'down'); await W.press('a'); await W.press('right');
      const n = W.b().pages; await W.press('select'); const p2 = W.b().page; await W.click(120, 136); const p3 = W.b().page;
      return n === 2 && p2 === 2 && p3 === 1 && J(W.hub.hit(120, 136)) === J({ kind: 'msg' });
    });
    await t('A. a note stays while a pointer only passes over the row it is about, and goes with the next press', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]);
      await W.press('start'); await W.toPop('conform'); await W.press('a');
      const note = W.st().note; W.run(W.hub.pointer({ kind: 'move', x: 20, y: 24 }));
      const kept = W.st().note === note; await W.press('right');
      return /already fits its rules/.test(note) && kept && W.st().note === null;
    });
    await t('A. speak: every builder view words itself (the screen, what is highlighted, the whole message) and says nothing that changes by itself', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]);
      const a = W.hub.speak(W.view()); W.hub.setTick(4000); const b = W.hub.speak(W.view());
      await W.press('b'); const c = W.hub.speak(W.view()); await W.press('b'); const d = W.hub.speak(W.view());
      return a === b && /^Pikachu, level 100, BUILD tab\. SPECIES Pikachu\./.test(a) && /^Team TEAM 1, Legal\. Slot 1: Pikachu\./.test(c) && /^Team Builder, teams of RED\. TEAM 1\./.test(d) && !/SAV/.test(a + c + d);
    }, async () => 'x');
    await t('A. purity: the builder\'s model and renderer files touch no DOM, storage, network, clock, timer or randomness, and import nothing lazily; only the ctl and the kit may be heavy', () => {
      const strip = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
      const dirty = [], heavy = [];
      for (const file of fs.readdirSync(dir).filter((f) => /^builder_.*\.js$/.test(f) && f !== 'builder_ctl.js')) {
        const txt = strip(fs.readFileSync(path.join(dir, file), 'utf8'));
        const hit = txt.match(/\b(localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|location\.|history\.|fetch\(|XMLHttpRequest|Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|requestAnimationFrame|import\s*\()/);
        if (hit) dirty.push(file + ': ' + hit[1]);
        if (file !== 'builder_kit.js' && /from '\.\/(editor_state|editor_data|rules|profile|store|teamcode|stats|tables|engine[a-z_]*)\.js'/.test(txt)) heavy.push(file);
      }
      return dirty.length === 0 && heavy.length === 0;
    });
    await t('A. a later stage adds a screen with a family and a few registration lines: its path opens, its chip stands in the team\'s chip row, its tab replaces the one registered before it, its row joins the trainer list', async () => {
      const log = [];
      const EXTRA = { id: 'extra', screens: { 'builder-extra': { parent: 'builder-team', title: 'Team Builder: Extra', need: 'team', create: (X) => ({ view: () => ({ kind: 'extra', title: 'EXTRA: ' + X.team().name, help: ['A test screen.', ''], say: 'Extra.' }), press: (a) => (a === 'b' ? X.back() : []), pointer: () => [], hit: () => null, rects: () => [], state: () => ({}) }) } },
        ext: { 'team.chips': [{ id: 'extra', label: 'EXTRA', help: ['Open the extra screen.', ''], run: (X) => X.go('builder-extra') }],
          'mon.tabs': [{ id: 'moves', label: 'MOVES', create: () => ({ view: () => ({ layout: 'note', lines: ['MY MOVES'], help: ['The moves tab of the test.', ''], say: 'Moves.' }), press: (a) => (a === 'b' ? null : []), pointer: () => [], hit: () => null, rects: () => [], state: () => ({}) }) }],
          'trainers.rows': [{ id: 'data', label: 'DATA', help: ['Where the data lives.', ''], run: () => { log.push('data'); return []; } }] } };
      const app2 = BH.makeApp([...BH.FAMILIES, EXTRA]);
      const hub = HM.createHubModel({ apps: [app2], measure: S0.screen.measure, msgPx: S0.screen.msgPx, measureFont: S0.screen.measureFont });
      const A = hub.apps.builder, kit = M.BK.createBuilderKit({ pack, deps: fakeDeps(3) });
      let s = kit.initialState(M.P.createProfile({ trainerName: 'RED' }, fakeDeps(4)));
      s = kit.reduce(s, { type: 'teamCreate' }); const tid = s.result.teamId; s = kit.reduce(s, { type: 'monAdd', teamId: tid, species: sid('Pikachu') });
      hub.setData({ state: 'ready', activeId: null, profiles: [] }); hub.goto('builder'); A.attach(kit); A.setEditor(s); A.setPhase('ready');
      const rows = hub.view().menu.rows.map((r) => r.id);
      for (let i = 0; i < 4 && hub.view().menu.rows[hub.view().menu.cursor].id !== 'x:data'; i++) hub.press('down');
      hub.press('a');
      A.setFocus({ teamId: tid, monId: s.result.monId, tab: 'build' }); hub.goto('builder-team');
      const chips = hub.view().builder.chips.map((c) => c.label);
      hub.press('down'); hub.press('down'); hub.press('down'); for (let i = 0; i < 4; i++) hub.press('right'); hub.press('a');
      const opened = hub.path() === 'builder-extra' && hub.view().builder.title === 'EXTRA: TEAM 1' && hub.title('builder-extra') === 'Pokemon Arena - Team Builder: Extra';
      hub.press('b'); hub.press('up'); hub.press('a'); hub.press('a'); hub.press('r');
      const tab = hub.path() === 'builder-mon' && hub.view().builder.tab === 'moves' && J(hub.view().builder.lines) === J(['MY MOVES']);
      const BS = dir === SRC ? M.BS : await import(pathToFileURL(path.join(dir, 'builder_screen.js')).href), HS = dir === SRC ? M.HS : await import(pathToFileURL(path.join(dir, 'hub_screen.js')).href);
      const scr = HS.createHubScreen(ui, { appScreens: { builder: (u, h) => BS.createScreen(u, h, [...BS.PAINTER_SETS, (K) => ({ extra: (f, b) => { K.strip(f, b); } })]) } });
      hub.press('b'); hub.goto('builder-extra'); const fr = scr.render(hub.view());
      return rows.includes('x:data') && J(log) === J(['data']) && J(chips) === J(['RULES', 'CHECK', 'CODE', 'TEST', 'EXTRA', 'MENU']) && opened && tab && !fr.fault && hub.faults().length === 0 && app2.paths.includes('builder-extra');
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- B: trainers */
  if (want('B')) {
    await t('B. trainers: with no profile the list is NEW TRAINER and BACK, and the message says what a trainer is', async () => {
      const W = await mk(); await W.open();
      return W.path() === 'builder' && J(W.rows().map((r) => r.id)) === J(['new', 'back']) && W.b().kind === 'trainers' && /No trainer yet/.test(msg(W)) && W.b().tag === null && W.st().phase === 'ready';
    }, async () => 'x');
    await t('B. NEW TRAINER opens the trainer app\'s NEW TRAINER screens (trainer-new) on top of the list, with no text entry of the builder\'s own and nothing asked of the store; B there comes back to the list', async () => {
      const W = await mk(); await W.open(); const fx = await W.press('a');
      const opened = W.path() === 'trainer-new' && J(W.hub.trail()) === J(['builder', 'trainer-new']) && W.view().app === 'trainer' && !W.st().entry && fx.every((e) => e.app !== 'builder' || e.type !== 'profile-create');
      W.run(W.hub.back()); await W.idle();
      return opened && W.path() === 'builder' && W.b().kind === 'trainers' && (await W.store.listProfiles()).length === 0;
    }, async () => 'x');
    await t('B. a trainer made while the builder is open (by the NEW TRAINER screens, or in another tab) is picked up at the next data refresh: the list reads it, it is the ACTIVE one, and it is open', async () => {
      const W = await seeded([{ mons: ['Pikachu'] }]);
      const red = W.profile().id, made = await W.store.createProfile({ trainerName: 'ASH' }); await W.store.setActiveId(made.id);
      await W.refreshData(); await W.idle();
      const rs = W.b().list.rows, act = rs.find((r) => r.tag === 'ACTIVE');
      const W2 = await seeded([{ mons: ['Pikachu'] }]); const before = W2.log.effects.length; await W2.refreshData(); await W2.idle();
      const quiet = !W2.log.effects.slice(before).some((e) => e.app === 'builder' && e.type === 'sync') && W2.profile().trainerName === 'RED';
      return W.path() === 'builder' && W.profile().id === made.id && W.profile().trainerName === 'ASH' && act && act.pid === made.id && rs.some((r) => r.pid === red) && quiet;
    }, async () => 'x');
    await t('B. the profile being edited is marked ACTIVE; A on it shows its teams with no store call; A on another trainer asks the ctl to open it (flush, load, make it active)', async () => {
      const W = await mk(); const blue = await seed(W.store, W.deps, 'BLUE', [{ mons: ['Gengar'] }]); const red = await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }, {}]);
      await W.open();
      const rs = W.b().list.rows, act = rs.find((r) => r.tag === 'ACTIVE');
      const fx1 = await W.press('a'); const direct = W.path() === 'builder-teams' && eff(fx1, 'profile-open').length === 0;
      await W.press('b'); await W.toRow('p:' + blue.id);
      const fx2 = W.hub.press('a'); const asked = eff(fx2, 'profile-open').length === 1 && fx2[0].id === blue.id && W.path() === 'builder';
      W.run(fx2); await W.idle();
      return rs.length === 4 && act && act.pid === red.id && direct && asked && W.path() === 'builder-teams' && W.profile().id === blue.id && (await W.store.getActiveId()) === blue.id && /BLUE TEAMS 1\/16/.test(W.b().title);
    }, async () => 'x');
    await t('B. the trainer menu opens on RIGHT, START, X and a tap on the MENU chip (for the trainer being edited: OPEN, RENAME, PORTRAIT, UNDO, REDO, DELETE) and not on a row that is no trainer', async () => {
      const W = await seeded([{}]);
      const seen = [];
      for (const a of ['right', 'start', 'x']) { await W.press(a); seen.push(W.b().popup ? W.b().popup.rows.map((r) => r.label).join() : ''); await W.press('b'); }
      const chip = W.b().chips[0]; await W.click(chip.x + 4, chip.y + 4); seen.push(W.b().popup ? W.b().popup.rows.map((r) => r.label).join() : ''); await W.press('b');
      await W.toRow('new'); await W.press('right'); const none = !W.b().popup && W.b().chips[0].off === true;
      return seen.every((s) => s === 'OPEN,RENAME,PORTRAIT,UNDO,REDO,DELETE') && none && W.hub.hit(chip.x + 4, chip.y + 4) === null;
    }, async () => 'x');
    await t('B. RENAME: the active trainer is renamed by the reducer (and saved); another trainer is renamed in the store without being opened', async () => {
      const W = await mk(); const blue = await seed(W.store, W.deps, 'BLUE', []); const red = await seed(W.store, W.deps, 'RED', []);
      await W.open(); await W.press('right'); await W.toPop('rename'); await W.press('a');
      const e = W.view().entry; for (let i = 0; i < 3; i++) await W.type({ key: 'backspace' }); const fx = await W.enter('Crimson'); await W.saved();
      const a = e.value === 'RED' && e.max === 10 && W.profile().trainerName === 'Crimson' && (await W.stored(red.id)).trainerName === 'Crimson' && eff(fx, 'edited').length === 1 && eff(fx, 'profile-rename').length === 0;
      await W.toRow('p:' + blue.id); await W.press('right'); await W.toPop('rename'); await W.press('a');
      for (let i = 0; i < 4; i++) await W.type({ key: 'backspace' }); const fx2 = await W.enter('Azure');
      return a && eff(fx2, 'profile-rename').length === 1 && eff(fx2, 'edited').length === 0 && (await W.stored(blue.id)).trainerName === 'Azure' && W.profile().id === red.id && W.b().list.rows.some((r) => r.label === 'Azure');
    }, async () => 'x');
    await t('B. DELETE asks first and starts on NO: NO (and B) keep the trainer, YES removes it from the store; deleting the trainer being edited leaves no one ACTIVE', async () => {
      const W = await mk(); const blue = await seed(W.store, W.deps, 'BLUE', []); const red = await seed(W.store, W.deps, 'RED', []);
      await W.open(); await W.press('right'); await W.toPop('delete'); await W.press('a');
      const d = asked(W), startsNo = d && d.options === 'YES,NO' && d.cursor === 1 && /"RED" and all of its teams/.test(d.text);
      await answer(W, false); await W.idle(); const kept = (await W.store.listProfiles()).length === 2 && !W.hub.dialog.isOpen();
      await W.press('right'); await W.toPop('delete'); await W.press('a'); await W.press('b'); await W.idle(); const keptB = (await W.store.listProfiles()).length === 2 && !W.hub.dialog.isOpen();
      await W.press('right'); await W.toPop('delete'); await W.press('a'); await answer(W, true); await W.idle();
      const left = await W.store.listProfiles();
      return startsNo && kept && keptB && left.length === 1 && left[0].id === blue.id && W.profile() === null && !W.b().list.rows.some((r) => r.tag === 'ACTIVE') && /Profile deleted/.test(msg(W)) && W.path() === 'builder';
    }, async () => 'x');
    await t('B. a profile saved by a newer version shows READ-ONLY, its edits are refused in the reducer\'s own words, and nothing is written', async () => {
      const W = await mk(); const p = await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]);
      await W.store.adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...p, schemaVersion: M.P.SCHEMA_VERSION + 1 }));
      await W.open(); await W.press('a'); await W.press('a');
      const tag = W.b().tag; await W.press('start'); await W.toPop('sort'); await W.press('a');
      const said = W.b().text; await W.saved();
      const raw = await W.store.adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', p.id));
      return tag.text === 'READ-ONLY' && tag.bad && said === 'This profile was saved by a newer version of the app and is read-only here.' && raw.rev === p.rev && W.timers.length === 0 && /read-only/.test(W.hub.speak(W.view()));
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- C: teams */
  if (want('C')) {
    await t('C. teams: NEW TEAM makes TEAM 1 through the reducer and opens it; back on the list it is a row marked "--" (empty) and the message names its rules and says Empty', async () => {
      const W = await seeded([]); await W.press('a');
      const empty = J(W.rows().map((r) => r.id)) === J(['new', 'x:code', 'x:undo', 'x:redo', 'back']) && /No team yet/.test(msg(W));
      const fx = await W.press('a'); const opened = W.path() === 'builder-team' && W.b().title === 'TEAM 1' && eff(fx, 'edited').length === 1;
      await W.press('b');
      const r = W.b().list.rows[0];
      return empty && opened && r.label === 'TEAM 1' && r.tag === '--' && msg(W) === 'Standard (Lv 50, 510 EV). Empty. | ' && /RED TEAMS 1\/16/.test(W.b().title);
    }, async () => msg(await seeded([])));
    await t('C. the list says Legal / N problems for a team with Pokemon (OK, !n on the row) and shows its party in the side window', async () => {
      const W = await seeded([{ mons: ['Pikachu', 'Gengar'] }, { then: CHAMP, mons: ['Snorlax'] }]); await W.press('a');
      const a = W.b().list.rows[0], sideA = W.b().side, m1 = msg(W);
      await W.press('down'); const b = W.b().list.rows[1], m2 = W.b().text;
      return a.tag === 'OK' && !a.bad && sideA.icons.length === 2 && sideA.icons[0].species === sid('Pikachu') && /Legal\./.test(m1) && /^![1-9]/.test(b.tag) && b.bad === true && /Champions/.test(m2) && /\d+ problems?\./.test(m2);
    }, async () => 'x');
    await t('C. at 16 teams NEW TEAM reads TEAM LIMIT REACHED and does nothing but say why; DUPLICATE is refused in the reducer\'s words', async () => {
      const W = await seeded(Array.from({ length: 16 }, () => ({}))); await W.press('a');
      await W.toRow('new'); const row = W.row(); await W.press('a');
      const said = msg(W), n = W.profile().teams.length;
      await W.press('up'); await W.press('right'); await W.toPop('duplicate'); await W.press('a');
      return row.label === 'TEAM LIMIT REACHED' && row.disabled === true && /at most 16 teams/.test(said) && n === 16 && W.profile().teams.length === 16 && /A profile holds at most 16 teams\./.test(msg(W)) && /TEAMS 16\/16/.test(W.b().title);
    }, async () => 'x');
    await t('C. the team menu: RENAME (sixteen characters), DUPLICATE (the copy sits after the original, under the cursor), MOVE UP / MOVE DOWN (the menu stays open and the cursor follows the team)', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu'] }, { name: 'BETA' }, { name: 'GAMMA' }]); await W.press('a');
      await W.press('right'); const labels = W.b().popup.rows.map((r) => r.label).join();
      await W.toPop('rename'); await W.press('a'); const e = W.view().entry; await W.type('WWWWWWWWWWWWWWWWWWWW'); const len = W.view().entry.value.length;
      for (let i = 0; i < 20; i++) await W.type({ key: 'backspace' }); await W.enter('First');
      const renamed = W.profile().teams[0].name === 'First' && e.max === 16 && len === 16;
      await W.press('right'); await W.toPop('duplicate'); await W.press('a');
      const dup = W.profile().teams.map((x) => x.name).join() === 'First,First 2,BETA,GAMMA' && W.row().label === 'First 2';
      await W.press('right'); await W.toPop('down'); await W.press('a'); const stay = !!W.b().popup; await W.press('a');
      const down = W.profile().teams.map((x) => x.name).join() === 'First,BETA,GAMMA,First 2' && W.b().list.rows[W.b().list.cursor].label === 'First 2';
      await W.toPop('up'); await W.press('a');
      return labels === 'OPEN,RENAME,DUPLICATE,MOVE UP,MOVE DOWN,DELETE' && renamed && dup && stay && down && W.profile().teams.map((x) => x.name).join() === 'First,BETA,First 2,GAMMA' && W.b().list.rows[W.b().list.cursor].label === 'First 2';
    }, async () => 'x');
    await t('C. DELETE (a team) asks first, starts on NO and names what goes with it; YES deletes the team through the reducer', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar'] }, { name: 'BETA' }]); await W.press('a');
      await W.press('right'); await W.toPop('delete'); await W.press('a');
      const d = asked(W), q = d.text;
      await answer(W, false); const kept = W.profile().teams.length === 2;
      await W.press('right'); await W.toPop('delete'); await W.press('a'); const fx = await answer(W, true);
      return /Delete "ALPHA" and its 2 Pok/.test(q) && d.cursor === 1 && kept && W.profile().teams.length === 1 && W.profile().box.length === 0 && eff(fx, 'edited').length === 1 && W.path() === 'builder-teams';
    }, async () => 'x');
    await t('C. REMOVE UNUSED appears only when the box holds Pokemon that are on no team, says how many, and removes them through the reducer (boxCleanup)', async () => {
      const W = await mk(); const p = await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]);
      const stray = M.P.createMon({ species: sid('Gengar'), level: 50, moves: [247] }, W.deps);
      await W.store.saveProfile({ ...p, box: p.box.concat([stray]) }, { reason: 'test' });
      await W.open(); await W.press('a');
      const has = W.rows().some((r) => r.id === 'unused'); await W.toRow('unused'); const said = msg(W); await W.press('a');
      const V = await seeded([{ mons: ['Pikachu'] }]); await V.press('a');
      return has && /1 Pok.E.mon in the box are on no/.test(said) && W.profile().box.length === 1 && !W.rows().some((r) => r.id === 'unused') && /Removed 1 Pokemon that were on no team\./.test(msg(W).replace(' | ', ' ')) && !V.rows().some((r) => r.id === 'unused');
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- D: the team, its rules, its check */
  if (want('D')) {
    await t('D. team: six slots (the Pokemon, then + ADD on the first empty one) and the chips RULES, CHECK, CODE, TEST, MENU; the strip says the name and LEGAL / EMPTY', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]);
      const b = W.b(), V = await atTeam([{}]);
      return b.kind === 'team' && b.slots.length === 6 && b.slots[0].name === 'Pikachu' && b.slots[0].level === 100 && b.slots[0].problems === 0 && b.slots[2].empty && b.slots[2].add === true && b.slots[3].add === false
        && b.chips.map((c) => c.label).join() === 'RULES,CHECK,CODE,TEST,MENU' && b.status.text === 'LEGAL' && V.b().status.text === 'EMPTY' && V.b().slots[0].add === true;
    }, async () => 'x');
    await t('D. the d-pad walks two columns of three slots over the chips, and a tap goes straight to a slot or a chip', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
      const seq = []; for (const a of ['right', 'down', 'down', 'down', 'left', 'left', 'up', 'left', 'up', 'up', 'up']) { await W.press(a); seq.push(cursorSlot(W)); }
      const r = W.hub.rects(); W.run(W.hub.pointer({ kind: 'move', x: r[4].x + 5, y: r[4].y + 5 }));
      return J(seq) === J([1, 3, 5, 10, 9, 8, 4, 5, 3, 1, 10]) && cursorSlot(W) === 4 && r.length === 11;
    }, async () => { const W = await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax'] }]); const seq = []; for (const a of ['right', 'down', 'down', 'down', 'left', 'left', 'up', 'left', 'up', 'up', 'up']) { await W.press(a); seq.push(cursorSlot(W)); } return J(seq); });
    await t('D. A on an empty slot opens the species picker to ADD, and the Pokemon picked is added by the reducer (monAdd) and opened in the picker\'s place: B from it is the team, with the cursor on its slot', async () => {
      const W = await atTeam([{ mons: ['Pikachu'] }]);
      await W.press('right'); const fx = await W.press('a');
      const inPicker = W.path() === 'builder-species' && W.st().screens['builder-species'].purpose === 'add' && fx[0].type === 'screen';
      const fx2 = await find(W, 'Gengar');
      const t2 = teamOf(W), added = t2.monIds.length === 2 && monOf(W, 1).species === sid('Gengar') && W.path() === 'builder-mon' && J(W.hub.trail()) === J(['builder', 'builder-teams', 'builder-team', 'builder-mon'])
        && fx2.some((e) => e.type === 'screen' && e.replace === true) && eff(fx2, 'edited').length === 1 && W.b().title === 'Gengar';
      await W.press('b');
      return inPicker && added && W.path() === 'builder-team' && cursorSlot(W) === 1;
    }, async () => 'x');
    await t('D. the slot menu: EDIT opens the Pokemon; EARLIER / LATER reorder (the menu stays, the cursor follows); COPY adds a copy after it', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
      await W.press('a'); const labels = W.b().popup.rows.map((r) => r.label).join(), title = W.b().popup.title;
      await W.toPop('later'); await W.press('a'); const a = teamOf(W).monIds.map((id) => W.profile().box.find((m) => m.id === id).species).join() === [sid('Gengar'), sid('Pikachu'), sid('Snorlax')].join() && !!W.b().popup && cursorSlot(W) === 1;
      await W.toPop('earlier'); await W.press('a'); const b = monOf(W, 0).species === sid('Pikachu') && cursorSlot(W) === 0;
      await W.toPop('copy'); await W.press('a'); const c = teamOf(W).monIds.length === 4 && monOf(W, 1).species === sid('Pikachu') && cursorSlot(W) === 1 && !W.b().popup;
      await W.press('a'); await W.press('a');
      return labels === 'EDIT,EARLIER,LATER,COPY,REMOVE' && title === 'Pikachu' && a && b && c && W.path() === 'builder-mon' && W.st().at.monId === teamOf(W).monIds[1];
    }, async () => 'x');
    await t('D. REMOVE (a Pokemon) asks first and starts on NO; YES removes it through the reducer', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]);
      await W.press('a'); await W.toPop('remove'); await W.press('a');
      const d = asked(W); await answer(W, false); const kept = teamOf(W).monIds.length === 2;
      await W.press('a'); await W.toPop('remove'); await W.press('a'); await answer(W, true);
      return /Take Pikachu out of TEAM 1\?/.test(d.text) && d.cursor === 1 && kept && teamOf(W).monIds.length === 1 && monOf(W, 0).species === sid('Gengar');
    }, async () => 'x');
    await t('D. a full team takes no seventh Pokemon: A on nothing adds nothing, and COPY is refused in the reducer\'s words', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax', 'Mewtwo', 'Charizard', 'Lapras'] }]);
      await W.press('a'); await W.toPop('copy'); await W.press('a');
      return teamOf(W).monIds.length === 6 && /The team is full\./.test(msg(W)) && W.b().slots.every((s) => !s.empty);
    }, async () => msg(await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax', 'Mewtwo', 'Charizard', 'Lapras'] }])));
    await t('D. the team menu opens on START, X and the MENU chip: RENAME, SORT BY TYPE (the reducer says what it did), CONVERT TO RULES, DUPLICATE, UNDO, REDO, DELETE (asks; YES returns to the teams); it is longer than the room and scrolls', async () => {
      const W = await atTeam([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
      const seen = []; for (const a of ['start', 'x']) { await W.press(a); seen.push(W.b().popup ? W.popRows().map((r) => r.label).join() : ''); await W.press('b'); }
      const chip = W.b().chips.find((c) => c.id === 'menu'); await W.click(chip.x + 5, chip.y + 5); seen.push(W.b().popup ? W.popRows().map((r) => r.label).join() : '');
      const scrolls = W.b().popup.rows.length === 6 && W.b().popup.total === 7 && W.b().popup.down === true && W.b().popup.lane === true;
      await W.toPop('sort'); await W.press('a'); const sorted = /^Sorted by type: Snorlax, Gengar, Pikachu\.?/.test(msg(W).replace(' | ', ' ')) && monOf(W, 0).species === sid('Snorlax');
      await W.press('start'); await W.toPop('duplicate'); await W.press('a'); const dup = W.profile().teams.length === 2 && /Copied as ALPHA 2\./.test(msg(W));
      await W.press('start'); await W.toPop('rename'); await W.press('a'); for (let i = 0; i < 5; i++) await W.type({ key: 'backspace' }); await W.enter('Omega'); const ren = teamOf(W).name === 'Omega' && W.b().title === 'Omega';
      await W.press('start'); await W.toPop('delete'); await W.press('a'); const fx = await answer(W, true);
      return seen.every((s) => s === 'RENAME,SORT BY TYPE,CONVERT TO RULES,DUPLICATE,UNDO,REDO,DELETE') && scrolls && sorted && dup && ren && W.path() === 'builder-teams' && W.profile().teams.length === 1 && W.profile().teams[0].name === 'ALPHA 2' && fx.some((e) => e.type === 'screen' && e.back === true);
    }, async () => 'x');
    await t('D. RULES: MODE, ITEM CLAUSE and DUPLICATES change the team\'s ruleset AT ONCE through the reducer (teamRuleset: only the id changes, no Pokemon is edited) and the reducer\'s notice is shown', async () => {
      const W = await atMon([{ mons: ['Pikachu', 'Gengar'] }]); await W.press('b');          // (a Pokemon was opened and left: the focus remembers it)
      await W.press('down', 'down', 'down'); await W.press('a');
      const before = J(W.profile().box), rows0 = W.rows().map((r) => r.label + '=' + r.value).join();
      const seen = []; for (let i = 0; i < 4; i++) { await W.press('right'); seen.push(teamOf(W).ruleset); }
      await W.press('left'); const champ = teamOf(W).ruleset, note = msg(W).replace(' | ', ' '), same = J(W.profile().box) === before;
      await W.press('down'); await W.press('a'); const item = teamOf(W).ruleset;
      await W.press('down'); await W.press('left'); const dupes = teamOf(W).ruleset;
      await W.press('b');
      return W.path() === 'builder-team' && rows0 === 'MODE=STANDARD,ITEM CLAUSE=OFF,DUPLICATES=OFF,UNDO=undefined,REDO=undefined,BACK=undefined' && J(seen) === J([STD + '+lv5', STD + '+lv100', CHAMP, STD]) && champ === CHAMP && same
        && /Rules changed; nothing in the team was edited\./.test(note) && /item-clause/.test(item) && /no-species-clause/.test(dupes) && /strict-champions/.test(dupes) && cursorSlot(W) === 6;
    }, async () => 'x');
    await t('D. CHECK lists every problem the rules module finds, one row each (who, and which field); the reason is in the message box, word-wrapped and paged; A turns its pages and then opens that Pokemon', async () => {
      const W = await atTeam([{ then: CHAMP, mons: ['Pikachu', 'Gengar'] }]);
      // (the lead is given a move its species cannot know: the reason for that is the longest text the rules module has, and needs two pages)
      const lead = monOf(W, 0), badMove = pack.moves.findIndex((mv, id) => id > 0 && mv && M.ED.moveStatuses(pack, M.P.toRulesRec(lead, M.RU.resolveRuleset(CHAMP)), [id], CHAMP)[id].code === 'move.illegal');
      W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m) => (m.id === lead.id ? { ...m, moves: [{ id: badMove, ppUps: 0 }] } : m)) } }));
      const st = W.b().status; await W.press('down', 'down', 'down', 'right', 'a');
      const rows = W.b().list.rows, want = M.ED.validationView(pack, M.ES.teamMonsOf(W.profile(), teamOf(W).id), CHAMP), k = want.mons[0].findIndex((p) => p.code === 'move.illegal');
      for (let i = 0; i < k; i++) await W.press('down');
      const first = W.b().list.rows[W.b().list.cursor], total = W.b().list.total, pages = W.b().pages, text = W.b().text, more = W.b().more;
      let turns = 0; while (W.path() === 'builder-check' && turns < 8) { await W.press('a'); turns++; }
      return badMove > 0 && k >= 0 && st.bad && /PROBLEMS/.test(st.text) && W.b().kind === 'mon' && total === want.count + 4 && first.label === '1 Pikachu' && first.value === 'Move 1' && text === M.BP.sentence(want.mons[0][k].text) && pages === 2 && more === true && turns === pages
        && W.st().at.monId === teamOf(W).monIds[0] && rows.every((r) => ['conform', 'undo', 'redo', 'back'].includes(r.id) || /^[A-Z].*\.$/.test(r.text));
    }, async () => { const W = await atTeam([{ then: CHAMP, mons: ['Pikachu', 'Gengar'] }]); await W.press('down', 'down', 'down', 'right', 'a'); return J([W.b().list.total, W.b().pages, W.b().text, W.b().list.rows[0]]); });
    await t('D. CHECK: CONVERT TO RULES fixes what the rules say how to fix (teamConform) and the screen then says every Pokemon passes; the cursor is then on UNDO, which takes the conversion back; an empty team is told to add one', async () => {
      const W = await atTeam([{ then: CHAMP, mons: ['Pikachu', 'Gengar'] }]);
      await W.press('down', 'down', 'down', 'right', 'a'); await W.toRow('conform'); await W.press('a');
      const note = msg(W).replace(' | ', ' '), onUndo = W.row().id === 'undo'; await W.toRow('back');
      const legal = W.b().title === 'CHECK: LEGAL' && J(W.rows().map((r) => r.id)) === J(['undo', 'redo', 'back']) && /Yes\. Every Pok.E.mon passes Champions/.test(msg(W).replace(' | ', ' '));
      await W.toRow('undo'); await W.press('a');
      const undone = W.b().title !== 'CHECK: LEGAL' && W.row().id === 'undo' && /Undid: convert team to its rules\./.test(msg(W)) && W.rows().some((r) => r.id === 'conform');
      const V = await atTeam([{}]); await V.press('down', 'down', 'down', 'right', 'a');
      return /^Converted 2 Pokemon/.test(note) && onUndo && legal && undone && /Add a Pok.E.mon to check it\./.test(msg(V)) && V.b().title === 'CHECK: EMPTY' && V.row().id === 'back' && J(V.rows().map((r) => r.id)) === J(['undo', 'redo', 'back']);
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- E: the Pokemon screen, BUILD */
  if (want('E')) {
    await t('E. BUILD: the rows are SPECIES, NICKNAME, LEVEL, GENDER, SHINY, NATURE, ABILITY, ITEM, FRIENDSHIP, RULES (OK), UNDO and REDO, seven at a time; the left column has the species, its Pokedex number, level and types', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]);
      const b = W.b(), all = []; for (let i = 0; i < 12; i++) { all.push(W.b().list.rows[W.b().list.cursor].label); await W.press('down'); }
      return b.kind === 'mon' && b.tab === 'build' && b.layout === 'build' && b.tabs.map((x) => x.label).join() === 'BUILD,MOVES,STATS' && b.list.rows.length === 7 && b.list.total === 12 && b.list.down === true
        && all.join() === 'SPECIES,NICKNAME,LEVEL,GENDER,SHINY,NATURE,ABILITY,ITEM,FRIENDSHIP,RULES,UNDO,REDO' && J(b.mon) === J({ species: sid('Pikachu'), known: true, shiny: false, female: false, dex: 25, level: 100, types: [14] }) && b.title === 'Pikachu';
    }, async () => J((await atMon([{ mons: ['Pikachu'] }])).b().mon));
    await t('E. LEVEL: left / right step by one through the reducer, a held direction is ONE undo step (the coalesce key), 100 is the limit and the reducer says so', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('level');
      await W.press('left'); await W.hold('left', 4);
      const lv = monOf(W).level, undo = W.app.editor().undo.length;
      for (let i = 0; i < 6; i++) await W.press('right');
      return lv === 95 && undo === 1 && monOf(W).level === 100 && /Level was limited to 100\./.test(msg(W)) && W.app.editor().undo.length === 1;
    }, async () => { const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('level'); await W.press('left'); await W.hold('left', 4); return monOf(W).level + ' undo ' + W.app.editor().undo.length; });
    await t('E. LEVEL under rules that fix it is refused in the reducer\'s words, and the row\'s help says the level is fixed', async () => {
      const W = await atMon([{ then: CHAMP, mons: ['Pikachu'] }]); await W.toRow('level');
      const help = msg(W); await W.press('left');
      return /These rules fix the level at 50\./.test(help) && W.b().note === true && /These rules fix the level at 50\./.test(msg(W)) && monOf(W).level === 100;
    }, async () => 'x');
    await t('E. A on LEVEL opens "type a number": TYPE A NUMBER takes digits (37), refuses letters with the DOM editor\'s words, and MAX / MIN set the ends', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('level'); await W.press('a');
      const rows = W.b().popup.rows.map((r) => r.label + (r.value ? ' ' + r.value : '')).join();
      await W.press('a'); const e = W.view().entry; for (let i = 0; i < 3; i++) await W.type({ key: 'backspace' }); await W.enter('37'); const typed = monOf(W).level;
      await W.press('a'); await W.press('a'); for (let i = 0; i < 3; i++) await W.type({ key: 'backspace' }); await W.enter('AB'); const refused = msg(W), kept = monOf(W).level;
      await W.press('a'); await W.toPop('min'); await W.press('a'); const min = monOf(W).level;
      await W.press('a'); await W.toPop('max'); await W.press('a');
      return rows === 'TYPE A NUMBER,MAX 100,MIN 1' && e.charset === 'code' && e.value === '100' && typed === 37 && /Level: enter a whole number\./.test(refused) && kept === 37 && min === 1 && monOf(W).level === 100;
    }, async () => 'x');
    await t('E. GENDER, SHINY and NATURE change at once: the gender walks the species\' own options, a genderless species says so, and the nature\'s message names the stat it raises and the one it lowers', async () => {
      const W = await atMon([{ mons: ['Pikachu', 'Mewtwo'] }]);
      await W.toRow('gender'); const g0 = monOf(W).gender; await W.press('right'); const g1 = monOf(W).gender; await W.press('right');
      await W.toRow('shiny'); await W.press('a'); const sh = monOf(W).shiny;
      await W.toRow('nature'); await W.press('right'); const n1 = monOf(W).nature, m1 = msg(W); await W.press('left', 'left'); const n24 = monOf(W).nature;
      await W.press('b'); await W.press('right'); await W.press('a'); await W.press('a'); await W.toRow('gender'); const help = msg(W); await W.press('right');
      return g0 !== g1 && ['M', 'F'].includes(g1) && monOf(W).gender === g0 && sh === true && n1 === 1 && /Lonely: Attack up, \| Defense down\./.test(m1) && n24 === 24 && /no gender/.test(help) && /This species has no gender\./.test(msg(W)) && W.b().note === true && monOf(W, 1).gender === '-';
    }, async () => 'x');
    await t('E. ABILITY steps to the next slot the rules allow, and the message box has the ability\'s own line from the ROM', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('ability');
      const slots = M.ED.abilityOptions(pack, sid('Pikachu'), STD).slots, a0 = monOf(W).abilitySlot, help = W.b().text;
      await W.press('right'); const a1 = monOf(W).abilitySlot, v1 = W.row().value;
      const s0 = slots.find((s) => s.slot === a0), s1 = slots.find((s) => s.slot === a1);
      return slots.length >= 2 && a1 !== a0 && s1.allowed && v1 === s1.name && help === s0.name + ': ' + s0.short;
    }, async () => msg(await atMon([{ mons: ['Pikachu'] }])));
    await t('E. NICKNAME is typed in the text entry (ten characters, it may be empty) and set by the reducer; an empty one clears it', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('nickname'); await W.press('a');
      const e = W.view().entry; await W.enter('Sparky'); const set = monOf(W).nickname, title = W.b().title, shown = W.row().value;
      await W.press('a'); for (let i = 0; i < 6; i++) await W.type({ key: 'backspace' }); await W.enter('');
      return e.max === 10 && e.charset === 'name' && set === 'Sparky' && title === 'Sparky' && shown === 'Sparky' && monOf(W).nickname === '' && W.b().title === 'Pikachu';
    }, async () => 'x');
    await t('E. FRIENDSHIP steps by ten and stops at 255 with the reducer\'s notice; the PROBLEMS row says whether the Pokemon passes and A on it opens CHECK on its first problem', async () => {
      const W = await atMon([{ then: CHAMP, mons: ['Gengar', 'Pikachu'] }]);
      await W.press('b'); await W.press('right'); await W.press('a'); await W.press('a');
      await W.toRow('friendship'); const f0 = monOf(W, 1).friendship; await W.press('right'); const f1 = monOf(W, 1).friendship; for (let i = 0; i < 30; i++) await W.hold('right'); const top = monOf(W, 1).friendship, note = msg(W);
      await W.toRow('problems'); const row = W.b().list.rows[W.b().list.cursor], help = W.b().text; await W.press('a');
      const first = W.b().list.rows[W.b().list.cursor];
      return f1 === f0 + 10 && top === 255 && /Friendship was limited to 255\./.test(note) && row.label === 'PROBLEMS' && Number(row.value) > 0 && row.bad === true && help.length > 10 && W.path() === 'builder-check' && first.monId === teamOf(W).monIds[1];
    }, async () => 'x');
    await t('E. the tabs: L and R (and a tap on a tab) change the tab, round and round: BUILD, MOVES, STATS, each drawn by a painter of its own (no placeholder is left); B from any tab is the team', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]);
      const fx = await W.press('r'); const moves = W.b().tab === 'moves' && W.b().layout === 'moves' && fx[0].type === 'opened' && fx[0].at.tab === 'moves';
      await W.press('r'); const stats = W.b().tab + ':' + W.b().layout; await W.press('r'); const wrap = W.b().tab; await W.press('l'); const back = W.b().tab;
      const tr = W.b().tabs[1]; await W.click(tr.x + 5, tr.y + 5); const tapped = W.b().tab;
      W.frame(); const kinds = W.screen.app('builder').kinds();
      const src = fs.readFileSync(path.join(dir, 'builder_mon.js'), 'utf8');
      await W.press('b');
      return moves && stats === 'stats:stats' && wrap === 'build' && back === 'stats' && tapped === 'moves' && ['tab:build', 'tab:moves', 'tab:stats'].every((k) => kinds.includes(k)) && !/next stage|noteTab/.test(src) && W.path() === 'builder-team';
    }, async () => 'x');
    await t('E. a record of a species this ROM lacks still draws: its rows are SPECIES and REMOVE FROM TEAM, and the message says why it cannot be edited', async () => {
      const W = await mk(); const p = await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]);
      await W.open();
      const gone = pack.species.length + 7;                               // (an id past the end of the ROM's species table: a profile written for another ROM, a hand-edited file)
      W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m) => ({ ...m, species: gone })) } }));
      await W.press('a'); await W.press('a'); const slot = W.b().slots[0]; await W.press('a'); await W.press('a');
      const rows = W.rows ? W.b().list.rows.map((r) => r.label).join() : '', txt = W.b().text, fr = W.frame();
      return slot.known === false && slot.name === 'Unknown ' + gone && /^SPECIES,REMOVE FROM TEAM,/.test(rows) && /This ROM has no Pok.E.mon with that number/.test(txt) && !fr.fault && W.hub.faults().length === 0 && W.b().mon.known === false && p.id === W.profile().id;
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- F: the pickers */
  if (want('F')) {
    const picker = async (o) => { const W = await atTeam([{ mons: ['Pikachu'] }], o); await W.press('right'); await W.press('a'); return W; };
    const cur = (W) => W.st().screens['builder-species'].cursor;
    const idAt = (W) => W.b().list.rows[W.b().list.cursor].sid;
    const all = M.ED.speciesSearch(pack, '', STD, { sort: 'dex', unavailable: 'hide' }), every = M.ED.speciesSearch(pack, '', STD, { sort: 'dex', unavailable: 'last' });
    await t('F. species: the list is what the rules module allows (' + all.length + ' under the standard rules), seven rows at a time in Pokedex order, with the highlighted one\'s types for the side window', async () => {
      const W = await picker();
      const b = W.b();
      return b.kind === 'species' && b.list.total === all.length && b.list.rows.length === 7 && b.list.rows.map((r) => r.sid).join() === all.slice(0, 7).join() && b.title === 'POK{E}MON: ' + all.length && b.side.species === all[0] && J(b.side.types) === J(M.ED.uniqueTypes(pack.species[all[0]]))
        && b.tag === null && b.chips.map((c) => c.id).join() === 'filter,pgup,pgdn' && b.chips[1].off === true && b.chips[2].off === false && b.text === 'Bulbasaur: Grass / Poison. A adds it to the team.' && b.list.rows[0].tag === '1' && b.list.rows.filter((r) => r.tag === 'FORM').length === 2;
    }, async () => 'x');
    await t('F. species: up / down move a row (up from the first row is the last; a HELD direction stops at the end), L / R and the two page chips move a page of seven, the wheel moves rows', async () => {
      const W = await picker();
      await W.press('down', 'down'); const two = cur(W); await W.press('r'); const page = cur(W); await W.press('l', 'l'); const top = cur(W);
      await W.press('up'); const last = cur(W); await W.hold('down', 3); const stays = cur(W); await W.press('down'); const first = cur(W);
      const c = W.b().chips[2]; await W.click(c.x + 3, c.y + 3); await W.click(c.x + 3, c.y + 3); const chips = cur(W); const u = W.b().chips[1]; await W.click(u.x + 3, u.y + 3); const up = cur(W);
      W.run(W.hub.pointer({ kind: 'wheel', steps: 3 }));
      return two === 2 && page === 9 && top === 0 && last === all.length - 1 && stays === all.length - 1 && first === 0 && chips === 14 && up === 7 && cur(W) === 10;
    }, async () => 'x');
    await t('F. species: left / right jump a CHAPTER: a hundred Pokedex numbers under the Pokedex order, a first letter under NAME, a type under TYPE; back from the middle of a chapter is its first row', async () => {
      const W = await picker();
      const dexOf = () => pack.species[idAt(W)].natDex;
      await W.press('right'); const d1 = dexOf(); await W.press('right'); const d2 = dexOf(); await W.press('down', 'down', 'left'); const d3 = dexOf(); await W.press('left'); const d4 = dexOf();
      await W.press('y'); await W.press('right'); await W.press('b');
      const byName = W.st().screens['builder-species'].sort, n0 = pack.species[idAt(W)].name[0]; await W.press('right'); const n1 = pack.species[idAt(W)].name[0];
      await W.press('y'); await W.press('right'); await W.press('b'); const t0 = pack.species[idAt(W)].types[0]; await W.press('right'); const t1 = pack.species[idAt(W)].types[0];
      return d1 === 100 && d2 === 200 && d3 === 200 && d4 === 100 && byName === 'name' && n0 === 'A' && n1 === 'B' && W.st().screens['builder-species'].sort === 'type' && t1 !== t0;
    }, async () => 'x');
    await t('F. species: any of the ' + all.length + ' is a few presses away: the last one is one press (UP), one in the middle at most 25 (chapters, pages, rows), and FIND goes straight to a name', async () => {
      const W = await picker();
      await W.press('up'); const last = idAt(W) === all[all.length - 1];
      const V = await picker(), target = Math.floor(all.length / 2); let n = 0;
      const keyOf = (i) => Math.floor(pack.species[all[i]].natDex / 100);
      while (keyOf(cur(V)) < keyOf(target) && n < 60) { await V.press('right'); n++; }
      while (cur(V) + 7 <= target && n < 60) { await V.press('r'); n++; }
      while (cur(V) < target && n < 60) { await V.press('down'); n++; }
      const U = await picker(); await find(U, 'Sandy Shocks');
      return last && cur(V) === target && n <= 25 && monOf(U, 1).species === sid('Sandy Shocks');
    }, async () => 'x');
    await t('F. species filter (Y, X or the FILTER chip): SORT is remembered as a preference (an effect for the ctl, which keeps it), TYPE narrows the list, CLEAR shows everything again', async () => {
      const W = await picker();
      const seen = []; for (const a of ['y', 'x']) { await W.press(a); seen.push(W.b().popup ? W.b().popup.rows.map((r) => r.label + (r.value !== undefined ? '=' + r.value : '')).join() : ''); await W.press('b'); }
      const c = W.b().chips[0]; await W.click(c.x + 3, c.y + 3);
      const fx = await W.press('right'); const pref = eff(fx, 'pref').length === 1 && fx[0].key === 'speciesSort' && fx[0].value === 'name' && W.storage.getItem('arena.editor.speciesSort') === 'name';
      await W.toPop('type'); await W.press('right'); await W.press('right');
      const typed = W.b().list.total, tname = W.b().popup.rows[1].value, title = W.b().title;
      const fighting = M.ED.speciesSearch(pack, '', STD, { sort: 'name', type: 2, unavailable: 'hide' }).length;
      await W.toPop('clear'); await W.press('a'); const cleared = W.b().list.total === all.length && !!W.b().popup;
      await W.toPop('done'); await W.press('a');
      const V = await picker({ storage: fakeStorage({ 'arena.editor.speciesSort': 'type' }) });
      return seen.every((s) => s === 'SORT=POK{E}DEX,TYPE=ANY,EXCLUDED=HIDE,FIND=-,CLEAR,DONE') && pref && tname === 'FIGHTING' && typed === fighting && title === 'FIGHTING: ' + fighting && cleared && !W.b().popup && V.st().screens['builder-species'].sort === 'type';
    }, async () => 'x');
    await t('F. species: with EXCLUDED: SHOW the Pokemon the rules leave out are listed last, greyed; A on one picks NOTHING and the message says the rules module\'s reason', async () => {
      const W = await picker(); await W.press('y'); await W.toPop('excluded'); await W.press('right'); await W.press('b');
      const total = W.b().list.total; await W.press('up');
      const row = W.b().list.rows[W.b().list.cursor], info = M.ED.speciesRow(pack, row.sid, STD), help = W.b().text, before = teamOf(W).monIds.length;
      const fx = await W.press('a');
      return total === every.length && every.length > all.length && row.dim === true && info.available === false && help === M.BP.sentence(pack.species[row.sid].name + ': ' + info.text) && W.path() === 'builder-species' && teamOf(W).monIds.length === before
        && eff(fx, 'edited').length === 0 && W.b().text === M.BP.sentence(pack.species[row.sid].name + ': ' + info.text) && W.b().note === true && W.b().side.dim === true;
    }, async () => 'x');
    await t('F. FIND (START, or the FILTER panel\'s row) types a word in the text entry; THE ENTER RULE: a whole name is taken, the only match is taken, a partial name with several matches takes nothing and shows them with the count', async () => {
      const W = await picker(); await W.press('start');
      const e = W.view().entry; await W.enter('char');
      const several = W.path() === 'builder-species' && teamOf(W).monIds.length === 1 && /Pok.E.mon match "char"/.test(msg(W)) && W.b().title === '"char": ' + W.b().list.total && W.b().list.total > 1 && cur(W) === 0;
      const V = await picker(); await find(V, 'pikachu'); const whole = monOf(V, 1) && monOf(V, 1).species === sid('Pikachu') && V.path() === 'builder-mon';
      const U = await picker(); await find(U, 'sandy sh'); const only = monOf(U, 1) && monOf(U, 1).species === sid('Sandy Shocks');
      const Z = await picker(); await find(Z, 'zzzz'); const none = Z.b().list.total === 0 && /No Pok.E.mon match "zzzz"/.test(msg(Z)); await Z.press('a');
      await Z.press('y'); await Z.toPop('find'); await Z.press('a'); const viaPanel = Z.hub.wantsText() && Z.view().entry.value === 'zzzz'; for (let i = 0; i < 4; i++) await Z.type({ key: 'backspace' }); await Z.enter('');
      return e.charset === 'search' && e.max === 16 && e.title === 'FIND A POK{E}MON' && several && whole && only && none && teamOf(Z).monIds.length === 1 && viaPanel && Z.b().list.total === all.length && Z.path() === 'builder-species';
    }, async () => 'x');
    let stripNote = '';
    await t('F. species: the strip names the type AND the word looked for only while both fit the room left of the chips; with the widest type name and a sixteen-W word it keeps the word, and the title is never cut', async () => {
      const W = await picker();
      const px = (s) => S0.screen.measureFont('smallNarrow', s);
      const types = M.ED.speciesTypeChoices(pack), at = types.reduce((a, c, i) => (px(c[1].toUpperCase()) > px(types[a][1].toUpperCase()) ? i : a), 0), tname = types[at][1].toUpperCase();
      await W.press('y'); await W.toPop('type'); for (let i = 0; i <= at; i++) await W.press('right'); await W.press('b');
      const cut = () => W.texts().filter((x) => x.what === 'title' && (x.cut || x.px > x.max)).length;
      const onlyType = W.b().title === tname + ': ' + W.b().list.total && cut() === 0;
      await find(W, 'a'); const n1 = W.b().list.total, both = W.b().title === tname + ' "a": ' + n1 && cut() === 0 && n1 > 1;
      await find(W, 'WWWWWWWWWWWWWWW');                                   // (the entry opens on the word in use: sixteen characters now)
      const word = W.b().title === '"aWWWWWWWWWWWWWWW": 0' && cut() === 0 && W.st().screens['builder-species'].type === types[at][0];
      stripNote = J([tname, W.b().title, cut(), onlyType, both, word, W.b().say]);
      return onlyType && both && word && new RegExp(', type ' + types[at][1] + ', matching "aWWWWWWWWWWWWWWW"').test(W.b().say) && M.BH && px(tname + ' "aWWWWWWWWWWWWWWW": 0') > 122;
    }, async () => stripNote);
    await t('F. changing a Pokemon\'s species (SPECIES on the BUILD tab) goes through the reducer and returns to the Pokemon; B in the picker changes nothing; every opening starts from the whole list', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.press('a');
      const p = W.path() === 'builder-species' && W.st().screens['builder-species'].purpose === 'change' && /A changes the species to it\./.test(W.b().text);
      await W.press('b'); const same = monOf(W).species === sid('Pikachu') && W.path() === 'builder-mon';
      await W.press('a'); await find(W, 'rai'); const narrowed = W.path() === 'builder-species' && W.b().list.total < 20; await W.press('b');
      await W.press('a'); const whole = W.b().list.total === all.length && W.st().screens['builder-species'].q === ''; await find(W, 'Raichu');
      return p && same && narrowed && whole && monOf(W).species === sid('Raichu') && W.path() === 'builder-mon' && W.b().title === 'Raichu' && teamOf(W).monIds.length === 1;
    }, async () => 'x');
    await t('F. the species picker opened with nothing to pick for (its address, a reload) is left for the team', async () => {
      const W = await atTeam([{ mons: ['Pikachu'] }]); await W.goto('builder-species');
      return W.path() === 'builder-team';
    });
    const items = M.ED.itemCatalog(pack, STD, { holdEffectOnly: true }), usable = items.filter((e) => e.status.ok), allItems = M.ED.itemCatalog(pack, STD, { holdEffectOnly: false }).filter((e) => e.status.ok);
    const itemPicker = async () => { const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('item'); await W.press('a'); return W; };
    await t('F. items: NO ITEM first, then the ' + usable.length + ' usable hold items by name; the message box has the ROM\'s description; A sets the item through the reducer and returns', async () => {
      const W = await itemPicker();
      const b = W.b(), first = b.list.rows[0]; await W.press('down'); const e = usable[0], text = W.b().text; await W.press('down', 'down'); const third = usable[2];
      const fx = await W.press('a');
      return b.kind === 'item' && b.title === 'HELD ITEMS: ' + usable.length && first.id === 'none' && b.list.total === usable.length + 1 && text === M.CS.displayText(e.desc).split('\n').join(' ').replace(/\s+/g, ' ').trim()
        && monOf(W).heldItem === third.id && W.path() === 'builder-mon' && eff(fx, 'edited').length === 1 && W.row().value === M.CS.displayText(third.name);
    }, async () => 'x');
    await t('F. items: opened on a Pokemon that holds one, the cursor starts on it; NO ITEM takes it away', async () => {
      const W = await itemPicker(); await W.press('down', 'down', 'a'); await W.press('a');
      const on = W.b().list.rows[W.b().list.cursor].iid === usable[1].id; await W.press('up', 'up'); await W.press('a');
      return on && monOf(W).heldItem === 0 && W.row().value === 'NONE';
    }, async () => 'x');
    await t('F. items filter: HOLD ITEMS: ALL lists every named item (' + allItems.length + '), EXCLUDED: SHOW adds the ones the rules leave out (greyed; A says why and sets nothing), FIND narrows by a word of the name or the description', async () => {
      const W = await itemPicker(); await W.press('y');
      const rows = W.b().popup.rows.map((r) => r.label + (r.value !== undefined ? '=' + r.value : '')).join();
      await W.press('right'); const allN = W.b().list.total - 1; await W.press('left');
      await W.toPop('excluded'); await W.press('right'); await W.press('b'); const withEx = W.b().list.total - 1;
      await W.press('up'); const row = W.b().list.rows[W.b().list.cursor], bad = items.find((e) => e.id === row.iid); await W.press('a');
      const refused = W.path() === 'builder-item' && monOf(W).heldItem === 0 && W.b().text === M.BP.sentence(M.CS.displayText(bad.name) + ': ' + bad.status.text);
      await W.press('start'); await W.enter('berry'); const found = W.b().list.total - 1, want = M.ED.itemCatalog(pack, STD, { holdEffectOnly: true, q: 'berry' }).length;
      return rows === 'HOLD ITEMS=ONLY,EXCLUDED=HIDE,FIND=-,CLEAR,DONE' && allN === allItems.length && withEx === items.length && row.dim === true && bad && !bad.status.ok && refused && found === want && want > 5 && /items match "berry"/.test(msg(W));
    }, async () => 'x');
    await t('F. items: left / right jump to the next first letter', async () => {
      const W = await itemPicker(); await W.press('right'); const a = W.b().list.rows[W.b().list.cursor].label[0]; await W.press('right'); const b = W.b().list.rows[W.b().list.cursor].label[0]; await W.press('left'); const c = W.b().list.rows[W.b().list.cursor].label[0];
      return a === 'A' && b === 'B' && c === 'A';
    });
  }

  /* ---------------------------------------------------------------------------------------------- G: the ctl and the store */
  if (want('G')) {
    await t('G. entering loads the store\'s ACTIVE profile; with none active the only one; with several and none active, nobody (the player chooses)', async () => {
      const W = await mk(); await seed(W.store, W.deps, 'BLUE', []); const red = await seed(W.store, W.deps, 'RED', []); await W.open();
      const V = await mk(); const solo = await seed(V.store, V.deps, 'SOLO', [], { active: false }); await V.open();
      const U = await mk(); await seed(U.store, U.deps, 'A', [], { active: false }); await seed(U.store, U.deps, 'B', [], { active: false }); await U.open();
      return W.profile().id === red.id && V.profile().id === solo.id && (await V.store.getActiveId()) === solo.id && U.profile() === null && U.b().list.rows.filter((r) => r.pid).length === 2;
    }, async () => 'x');
    await t('G. the autosave waits 250 ms after the last edit (one debounce however many edits), then writes with the store\'s compare-and-swap: the tag goes SAVING then SAVED and the stored rev moves by one', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); const rev0 = (await W.stored()).rev;
      await W.toRow('shiny'); await W.press('a'); await W.press('a'); await W.press('a');
      const tag1 = W.st().tag, timers = W.timers.length, ms = W.timers[0] && W.timers[0].ms, notYet = (await W.stored()).rev === rev0;
      await W.fire();
      const s = await W.stored();
      return tag1 === 'SAVING' && timers === 1 && ms === 250 && notYet && s.rev === rev0 + 1 && s.box[0].shiny === true && W.st().tag === 'SAVED' && W.profile().rev === s.rev && !M.ES.isDirty(W.app.editor());
    }, async () => 'x');
    await t('G. after a save the hub is told, so the main menu\'s team rows follow the edit (the team just built is there, legal, with its lead)', async () => {
      const W = await atTeam([{}]); const n0 = W.log.refreshes;
      await W.press('a'); await find(W, 'Gengar'); await W.saved();
      await W.goto('main'); W.hub.arrive('team');
      const v = W.hub.view(), row = v.menu.rows.find((r) => r.id === 'teamsel'), start = v.menu.rows.find((r) => r.id === 'start');
      return W.log.refreshes > n0 && row && row.value === 'TEAM 1' && start && !start.disabled && v.mascot.species === sid('Gengar');
    }, async () => 'x');
    await t('G. an edit made WHILE a write is in flight stays dirty: the write is acknowledged with the seq it started from, and a second write follows by itself', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny');
      const real = W.store.saveProfile.bind(W.store); let release = null, calls = 0;
      W.store.saveProfile = (p, o) => { calls++; if (calls > 1) return real(p, o); return new Promise((res, rej) => { release = () => real(p, o).then(res, rej); }); };
      W.run(W.hub.press('a')); const due = W.timers.splice(0); for (const x of due) x.fn();
      await new Promise((r) => setImmediate(r));
      W.run(W.hub.press('down')); W.run(W.hub.press('right'));          // NATURE, while the first write hangs
      const nat = monOf(W).nature; release(); await W.idle();
      const mid = M.ES.isDirty(W.app.editor()), tagMid = W.st().tag, pending = W.timers.length;
      await W.saved(); const s = await W.stored();
      return nat === 1 && mid === true && tagMid === 'SAVING' && pending === 1 && calls === 2 && s.box[0].nature === 1 && s.box[0].shiny === true && W.st().tag === 'SAVED';
    }, async () => 'x');
    await t('G. another writer saved first: the save is refused (ConflictError), the tag reads CHANGED, and the question USE THE OTHER / KEEP MINE / LATER is asked, armed, with LATER under the cursor; LATER keeps both and the next edit asks again', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny');
      const other = await W.stored(); await W.store.saveProfile({ ...other, trainerName: 'OTHER' }, { reason: 'other tab' });
      await W.press('a'); await W.saved();
      const d = W.hub.dialog.current(), opts = d && d.choice ? d.choice.options : null, tag = W.st().tag, armed = d && d.armed === false;
      W.run(W.hub.press('a')); const stillOpen = W.hub.dialog.isOpen();            // not armed yet: the A that was on its way answers nothing
      for (let i = 0; i < 40; i++) W.run(W.hub.tick());
      await W.press('b'); await W.idle();
      const later = !W.hub.dialog.isOpen() && W.st().tag === 'CHANGED' && (await W.stored()).trainerName === 'OTHER' && monOf(W).shiny === true;
      await W.press('down'); await W.press('right'); await W.idle();
      return d && d.id === 'builder:conflict' && J(opts) === J(['USE THE OTHER', 'KEEP MINE', 'LATER']) && d.choice.cursor === 2 && tag === 'CHANGED' && armed && stillOpen && later && W.hub.dialog.isOpen() && W.timers.length === 0;
    }, async () => 'x');
    await t('G. USE THE OTHER loads the stored version over the edits here', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny');
      const other = await W.stored(); await W.store.saveProfile({ ...other, trainerName: 'OTHER' }, { reason: 'other tab' });
      await W.press('a'); await W.saved(); for (let i = 0; i < 40; i++) W.run(W.hub.tick());
      await W.press('a'); await W.press('up', 'up'); await W.press('a'); await W.idle();          // (the second page, then USE THE OTHER, two above LATER)
      return W.profile().trainerName === 'OTHER' && monOf(W).shiny === false && W.st().tag === 'SAVED' && !W.hub.dialog.isOpen() && /other tab's version/.test(msg(W));
    }, async () => 'x');
    await t('G. KEEP MINE saves the edits here over the other version AND keeps a battle the other tab recorded meanwhile (the stored record is carried, never the copy loaded long ago)', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny');
      const other = await W.stored(); await W.store.saveProfile({ ...other, stats: { ...other.stats, wins: 7 } }, { reason: 'a battle in another tab' });
      await W.press('a'); await W.saved(); for (let i = 0; i < 40; i++) W.run(W.hub.tick());
      await W.press('a'); await W.press('up'); await W.press('a'); await W.saved();          // (the second page, then KEEP MINE, one above LATER)
      const s = await W.stored();
      return s.box[0].shiny === true && s.stats.wins === 7 && W.st().tag === 'SAVED' && !W.hub.dialog.isOpen() && W.profile().stats.wins === 7;
    }, async () => 'x');
    await t('G. another tab ANNOUNCES a save (the store\'s external event) while nothing was edited here: the tag reads CHANGED and the question is asked before any write is tried', async () => {
      // two stores on one database that hear each other, as two tabs do through the BroadcastChannel
      const subs = new Set();
      class Chan { constructor() { subs.add(this); this.onmessage = null; } postMessage(d) { for (const s of subs) if (s !== this && s.onmessage) s.onmessage({ data: JSON.parse(JSON.stringify(d)) }); } close() { subs.delete(this); } }
      const name = 'builder-two-tabs-' + Math.random().toString(36).slice(2);
      const open = (seed) => M.ST.openStore({ adapter: M.ST.createMemoryAdapter({ name, durable: true }), channel: Chan, deps: fakeDeps(seed), storage: null });
      const mine = await open(21), theirs = await open(22);
      const W = await mk({ store: mine }); await seed(mine, W.deps, 'RED', [{ mons: ['Pikachu'] }]); await W.open(); await W.press('a'); await W.press('a');
      const quiet = W.st().tag === 'SAVED' && !W.hub.dialog.isOpen();
      const cur = (await theirs.loadProfile((await theirs.getActiveId()))).profile;
      await theirs.saveProfile({ ...cur, trainerName: 'THEIRS' }, { reason: 'the other tab' }); await W.idle();
      const d = W.hub.dialog.current();
      return quiet && subs.size === 2 && W.st().tag === 'CHANGED' && d && d.id === 'builder:conflict' && W.timers.length === 0 && W.profile().trainerName === 'RED' && /Changed in another tab\./.test(W.hub.speak({ ...W.view(), dialog: undefined }));
    }, async () => 'x');
    await t('G. a write that fails (the storage refuses it): the tag reads NOT SAVED and TRY AGAIN / LATER is asked, armed; TRY AGAIN writes', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny');
      const real = W.store.saveProfile.bind(W.store); let fail = true;
      W.store.saveProfile = (p, o) => (fail ? Promise.reject(new Error('the disk is full')) : real(p, o));
      await W.press('a'); await W.saved();
      const d = W.hub.dialog.current(), v = W.hub.view().dialog, tag = W.st().tag;
      fail = false; for (let i = 0; i < 40; i++) W.run(W.hub.tick());
      await W.press('a'); await W.saved();
      const s = await W.stored();
      return d && d.id === 'builder:save-failed' && d.armed === false && d.choice.options.join() === 'TRY AGAIN,LATER' && /The last save failed\. Could not write to/.test(v.lines.join(' ')) && tag === 'NOT SAVED' && s.box[0].shiny === true && W.st().tag === 'SAVED' && !W.hub.dialog.isOpen();
    }, async () => 'x');
    await t('G. leaving the builder saves at once (no debounce to wait for) and DROPS the editor state; entering again loads from the store, so a write the hub made in between (RESET RECORD, the Tower) is not a conflict', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny'); await W.press('a');
      await W.goto('main');
      const s1 = await W.stored(), dropped = W.app.editor() === null && W.timers.length === 0;
      await W.store.saveProfile({ ...s1, stats: { ...s1.stats, losses: 3 } }, { reason: 'the hub wrote' });
      await W.goto('builder'); await W.press('a'); await W.press('a'); await W.press('a'); await W.press('a'); await W.toRow('nature'); await W.press('right'); await W.saved();
      const s2 = await W.stored();
      return s1.box[0].shiny === true && dropped && W.profile() !== null && s2.box[0].nature === 1 && s2.stats.losses === 3 && W.st().tag === 'SAVED' && !W.hub.dialog.isOpen();
    }, async () => 'x');
    await t('G. the focus is kept for the tab: a reload (a new page on the same store and session) opened at the Pokemon\'s address shows the same Pokemon and tab; a tab that never was there settles on the teams', async () => {
      const W = await atMon([{ mons: ['Pikachu', 'Gengar'] }]); await W.press('b'); await W.press('right'); await W.press('a'); await W.press('a'); await W.press('r'); await W.saved();
      const kept = JSON.parse(W.session.getItem('arena.builder.at'));
      const V = await mk({ store: W.store, session: W.session }); await V.refreshData(); await V.arrive('builder-mon');
      const same = V.path() === 'builder-mon' && V.b().title === 'Gengar' && V.b().tab === 'moves';
      const U = await mk({ store: W.store }); await U.refreshData(); await U.arrive('builder-mon');
      return kept.monId === teamOf(W).monIds[1] && kept.tab === 'moves' && same && U.path() === 'builder-teams';
    }, async () => 'x');
    await t('G. storage that could not be opened: the builder says so and edits nothing; a store that keeps nothing: the tag reads NOT SAVED and a notice says the work lives in memory', async () => {
      const W = await mk({ noStore: true }); await W.goto('builder');
      const a = W.st().phase === 'nostore' && /Storage could not be opened/.test(msg(W)) && W.b().kind === 'wait'; await W.press('a'); await W.press('b');
      const V = await mk({ durable: false }); await seed(V.store, V.deps, 'Ash'); await V.open();
      const d = V.hub.view().dialog; for (let i = 0; i < 40; i++) V.run(V.hub.tick()); await V.press('a'); await V.press('a'); await V.press('a');
      return a && W.path() === 'main' && d && d.id === 'builder:not-kept' && /not keeping your profiles/.test(d.lines.join(' ')) && V.profile() && V.st().tag === 'NOT SAVED' && /Not saved\./.test(V.hub.speak(V.view()));
    }, async () => 'x');
    await t('G. the kit makes every ROM string drawable: all ' + pack.items.length + ' item names and descriptions, every ability line, species, move and nature name measure in the ROM font without a throw and without a character lost to "?" (the raw strings do throw)', async () => {
      const BK = dir === SRC ? M.BK : await import(pathToFileURL(path.join(dir, 'builder_kit.js')).href);
      const kit = BK.createBuilderKit({ pack, deps: fakeDeps(9) }), A = ui.assets;
      let n = 0, bad = 0, rawThrows = 0, lost = 0;
      const marks = (s) => s.split('?').length;
      const each = (s) => { if (typeof s !== 'string' || !s) return; n++; try { A.measureText('normal', s) ; } catch (_e) { rawThrows++; } for (const ln of kit.lines(s)) { try { A.measureText('normal', ui.safeText(ln)); A.measureText('small', ui.safeText(kit.flow(s))); if (marks(ui.safeText(ln)) > marks(ln)) lost++; } catch (_e) { bad++; } } };
      for (const it of pack.items) if (it) { each(it.name); each(it.desc); }
      for (const ab of pack.abilities) if (ab) { each(ab.name); each(ab.short); each(ab.long); }
      for (const sp of pack.species) if (sp) each(sp.name);
      for (const mv of pack.moves) if (mv) { each(mv.name); each(mv.desc); }
      for (const na of pack.natures) each(na.name);
      return n > 5000 && bad === 0 && lost === 0 && rawThrows > 10 && kit.text('{PO}{K\u00e9}{BL}{OC}{K} Case') === 'POK\u00e9BLOCK Case' && kit.text('\u201cx\u201d') === '"x"';
    });
  }
  /* ---------------------------------------------------------------------------------------------- shared by H..K */
  const toTab = async (W, id) => { for (let i = 0; i < 4 && W.b().tab !== id; i++) await W.press('r'); return W.b().tab === id; };
  const moveId = (name) => { const id = pack.moves.findIndex((mv) => mv && mv.name === name); if (id < 0) throw new Error('no move ' + name); return id; };
  const flow = (s) => M.CS.displayText(String(s)).split('\n').join(' ').replace(/\s+/g, ' ').trim();
  const rowNow = (W) => W.b().list.rows[W.b().list.cursor];
  const tabCur = (W) => W.st().screens['builder-mon'].cursor;
  const chipOf = async (W, id) => { const c = W.b().chips.find((x) => x.id === id); return W.click(c.x + 4, c.y + 4); };
  const said = (W) => msg(W).replace(' | ', ' ').trim();
  const ctrl = (W, key, more) => W.key({ ctrlKey: true, key, ...(more || {}) });
  /** Give the first Pokemon these moves THROUGH THE REDUCER (the slots fill in order). */
  const learn = (W, names) => { const m = monOf(W); names.forEach((n, i) => { const s = W.app.edit({ type: 'moveSet', monId: m.id, slot: m.moves.length + i, moveId: moveId(n) }); if (s.error) throw new Error('learn ' + n + ': ' + s.error.message); }); };

  /* ---------------------------------------------------------------------------------------------- H: the MOVES tab and the move picker */
  if (want('H')) {
    const atMoves = async (teams, o) => { const W = await atMon(teams, o); await toTab(W, 'moves'); return W; };
    /** ... and into the picker for the first empty slot. */
    const picker = async (teams, o) => { const W = await atMoves(teams || [{ mons: ['Pikachu'] }], o); await W.toRow('m:' + monOf(W).moves.length); await W.press('a'); return W; };
    const pst = (W) => W.st().screens['builder-move'];
    const findMove = async (W, word) => { await W.press('start'); return W.enter(word); };
    const catOf = (W, o) => M.ED.moveCatalog(pack, monOf(W), teamOf(W).ruleset, o || {});
    const byName = (W, f) => M.ED.filterMoves(catOf(W), { sort: 'name', ...(f || {}) });
    await t('H. MOVES: four slots (the moves, "+ ADD A MOVE" on the first empty one, "-" on the rest), then UNDO and REDO; a move\'s row has its type, category, power, accuracy and PP from the ROM, the line under the rows says the numbers, and the message box has the ROM\'s description', async () => {
      const W = await atMoves([{ mons: ['Pikachu'] }]);
      const b = W.b(), id = monOf(W).moves[0].id, mv = pack.moves[id], r0 = b.list.rows[0];
      const all = []; for (let i = 0; i < 6; i++) { all.push(rowNow(W).label); await W.press('down'); }
      return b.tab === 'moves' && b.layout === 'moves' && b.list.rows.length === 4 && b.list.total === 6 && b.list.down === true
        && r0.mid === id && r0.label === mv.name && r0.type === mv.type && r0.category === mv.category && r0.power === mv.power && r0.accuracy === mv.accuracy && r0.pp === mv.pp
        && J(b.info) === J({ power: mv.category === 2 || !mv.power ? '-' : String(mv.power), accuracy: mv.accuracy ? mv.accuracy + '%' : '-', pp: String(mv.pp) }) && b.text === flow(mv.desc)
        && all.join() === [mv.name, '+ ADD A MOVE', '-', '-', 'UNDO', 'REDO'].join() && b.list.rows[1].dim !== true && b.list.rows[2].dim === true && /^Move 1: /.test(W.hub.speak(W.view()).split('tab. ')[1] || '');
    }, async () => J((await atMoves([{ mons: ['Pikachu'] }])).b().list.rows[0]));
    await t('H. A on the first empty slot opens the move picker for that slot (a "-" slot adds the NEXT move too); the move taken is set by the reducer (moveSet) and the picker returns to the tab', async () => {
      const W = await atMoves([{ mons: ['Pikachu'] }]);
      await W.press('down'); const fx = await W.press('a');
      const opened = W.path() === 'builder-move' && pst(W).slot === 1 && fx[0].type === 'screen' && W.b().kind === 'move' && J(W.hub.trail().slice(-2)) === J(['builder-mon', 'builder-move']);
      await findMove(W, 'thunderbolt'); const row = rowNow(W); const fx2 = await W.press('a');
      const set = monOf(W).moves.length === 2 && monOf(W).moves[1].id === moveId('Thunderbolt') && W.path() === 'builder-mon' && W.b().tab === 'moves' && eff(fx2, 'edited').length === 1 && fx2.some((e) => e.type === 'screen' && e.back === true);
      await W.toRow('m:3'); await W.press('a');
      return opened && row.label === 'Thunderbolt' && set && W.path() === 'builder-move' && pst(W).slot === 2;
    }, async () => 'x');
    await t('H. the move menu (A on a move): CHANGE opens the picker on that slot with the cursor on the move it has; UP / DOWN reorder through the reducer (moveReorder: the menu stays open, the cursor follows, and an end is grey and says so); REMOVE clears the slot', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); learn(W, ['Thunderbolt', 'Thunder Wave']); await toTab(W, 'moves');
      const first = monOf(W).moves[0].id, ids = () => monOf(W).moves.map((x) => x.id).join();
      await W.press('a'); const p = W.b().popup, labels = p.rows.map((r) => r.label + (r.disabled ? '*' : '')).join(), title = p.title;
      await W.toPop('down'); await W.press('a'); const a = ids() === [moveId('Thunderbolt'), first, moveId('Thunder Wave')].join() && !!W.b().popup && tabCur(W) === 1;
      await W.press('a'); const b2 = monOf(W).moves[2].id === first && tabCur(W) === 2 && W.b().popup.rows.find((r) => r.id === 'down').disabled === true;
      await W.press('a'); const end = said(W) === 'It is already the last move.' && monOf(W).moves[2].id === first && W.b().note === true;
      await W.toPop('up'); await W.press('a'); const up = monOf(W).moves[1].id === first && tabCur(W) === 1;
      await W.toPop('remove'); await W.press('a'); const removed = monOf(W).moves.length === 2 && !monOf(W).moves.some((x) => x.id === first) && !W.b().popup;
      await W.press('a'); await W.toPop('change'); await W.press('a');
      const onIt = W.path() === 'builder-move' && pst(W).slot === 1 && rowNow(W).mid === monOf(W).moves[1].id;
      return labels === 'CHANGE,UP*,DOWN,REMOVE' && title === pack.moves[first].name && a && b2 && end && up && removed && onIt;
    }, async () => 'x');
    await t('H. the last move cannot be removed: REMOVE is grey, and A says why in the reducer\'s words', async () => {
      const W = await atMoves([{ mons: ['Pikachu'] }]); await W.press('a');
      const row = W.b().popup.rows.find((r) => r.id === 'remove'); await W.toPop('remove'); await W.press('a');
      return row.disabled === true && monOf(W).moves.length === 1 && said(W) === 'A Pokemon needs at least one move.';
    }, async () => 'x');
    await t('H. the picker lists what the Pokemon\'s line can learn, six rows at a time, the moves that can be taken first by name; a row has where the move comes from (Lv, TM, Tutor, Egg), the foot line its numbers, type and category, the message box the ROM\'s description; every opening starts from the whole list', async () => {
      const W = await picker(); const want = byName(W), b = W.b(), e0 = want[0];
      const tags = b.list.rows.map((r, i) => r.tag === want[i].tags.map((x) => x.label).join(' ').slice(0, r.tag.length) && r.tag.length > 0).every(Boolean);
      await W.press('y'); await W.press('right'); await W.press('b'); const narrowed = W.b().list.total < want.length; await W.press('b');
      await W.toRow('m:1'); await W.press('a');
      return want.length > 60 && want.every((e) => e.learnable) && b.kind === 'move' && b.title === 'MOVE 2: ' + want.length && b.list.total === want.length && b.list.rows.length === 6 && b.list.rows.map((r) => r.mid).join() === want.slice(0, 6).map((e) => e.id).join()
        && tags && J(b.info) === J({ type: e0.type, category: e0.category, power: e0.category === 2 || !e0.power ? '-' : String(e0.power), accuracy: e0.accuracy ? e0.accuracy + '%' : '-', pp: String(e0.pp) }) && b.text === flow(e0.desc)
        && b.tag === null && b.chips.map((c) => c.id).join() === 'filter,pgup,pgdn' && narrowed && W.b().list.total === want.length && pst(W).type === null;
    }, async () => { const W = await picker(); return J([W.b().title, W.b().list.rows.slice(0, 2), byName(W).length]); });
    await t('H. a move the Pokemon already knows is grey and A takes NOTHING (it says so); a level-up move above the Pokemon\'s level is grey and A says the rules module\'s reason and the level it needs', async () => {
      const W = await picker(); const known = pack.moves[monOf(W).moves[0].id].name;
      await findMove(W, known.toLowerCase()); const row = rowNow(W); const fx = await W.press('a');
      const dup = row.dim === true && row.label === known && W.path() === 'builder-move' && monOf(W).moves.length === 1 && eff(fx, 'edited').length === 0 && W.b().text === 'This Pok{E}mon already knows this move.' && W.b().note === true;
      const V = await atMon([{ mons: ['Pikachu'] }]); V.app.edit({ type: 'monSet', monId: monOf(V).id, field: 'level', value: 5 });
      await toTab(V, 'moves'); await V.toRow('m:1'); await V.press('a');
      const cat = catOf(V), gated = cat.find((e) => !e.status.ok && e.status.why === 'level-too-low');
      await findMove(V, gated.name.toLowerCase()); for (let i = 0; i < 8 && rowNow(V).mid !== gated.id; i++) await V.press('down');
      const grey = rowNow(V).dim === true, help = V.b().text; await V.press('a');
      return dup && gated && grey && help === M.BP.sentence(gated.status.text) + ' It needs level ' + gated.status.needLevel + '.' && V.b().text === help && V.b().note === true && monOf(V).moves.length === 1 && V.path() === 'builder-move';
    }, async () => 'x');
    await t('H. with UNLEARNABLE: SHOW the moves the Pokemon cannot learn are listed too, last and grey; A on one takes NOTHING and says the rules module\'s reason', async () => {
      const W = await picker(); const all = catOf(W, { allMoves: true });
      await W.press('y'); await W.toPop('all'); await W.press('right'); await W.press('b');
      const total = W.b().list.total; await W.press('up');
      const row = rowNow(W), e = all.find((x) => x.id === row.mid); const fx = await W.press('a');
      return total === all.length && all.length > 900 && row.dim === true && e && !e.learnable && !e.status.ok && W.b().text === M.BP.sentence(e.status.text) && W.b().note === true && W.path() === 'builder-move' && monOf(W).moves.length === 1 && eff(fx, 'edited').length === 0;
    }, async () => 'x');
    await t('H. the filter panel (Y, X or the FILTER chip) scrolls through TYPE, CATEGORY, POWER, SOURCE, SORT, USABLE, UNLEARNABLE, FIND, CLEAR and DONE; each narrows or orders the list as editor_data.js filterMoves does, and CLEAR shows everything again', async () => {
      const W = await picker(); const n0 = W.b().list.total;
      const seen = []; for (const a of ['y', 'x']) { await W.press(a); seen.push(W.b().popup ? W.popRows().map((r) => r.label + (r.value !== undefined ? '=' + r.value : '')).join() : ''); await W.press('b'); }
      const c = W.b().chips[0]; await W.click(c.x + 3, c.y + 3); const viaChip = !!W.b().popup && W.b().popup.id === 'move-filter' && W.b().popup.rows.length === 6 && W.b().popup.total === 10;
      const setTo = async (id, value) => { await W.toPop(id); for (let i = 0; i < 24 && W.b().popup.rows[W.b().popup.cursor].value !== value; i++) await W.press('right'); return W.b().list.total; };
      const nType = await setTo('type', 'ELECTRIC'), wType = byName(W, { type: 14 }).length;
      const nCat = await setTo('category', 'SPECIAL'), wCat = byName(W, { type: 14, category: 1 }).length;
      const nPow = await setTo('power', '81-110'), wPow = byName(W, { type: 14, category: 1, powerMin: 81, powerMax: 110 }).length;
      await W.toPop('clear'); await W.press('a'); const cleared = W.b().list.total === n0 && !!W.b().popup && pst(W).type === null && pst(W).power === '';
      const nSrc = await setTo('source', 'TM / HM'), wSrc = byName(W, { source: 'machine' }).length;
      await setTo('source', 'ANY'); await setTo('power', 'NONE'); const nNone = W.b().list.total, wNone = byName(W, { powerMax: 0 }).length; await setTo('power', 'ANY');
      await setTo('sort', 'POWER'); await W.toPop('done'); await W.press('a');
      const top = rowNow(W), wantTop = M.ED.filterMoves(catOf(W), { sort: 'power' })[0];
      return seen.every((s) => s === 'TYPE=ANY,CATEGORY=ANY,POWER=ANY,SOURCE=ANY,SORT=NAME,USABLE=ALL,UNLEARNABLE=HIDE,FIND=-,CLEAR,DONE') && viaChip && nType === wType && wType > 3 && wType < n0 && nCat === wCat && wCat > 0 && nPow === wPow && cleared
        && nSrc === wSrc && wSrc > 5 && nNone === wNone && wNone > 5 && !W.b().popup && top.mid === wantTop.id && pst(W).sort === 'power';
    }, async () => 'x');
    await t('H. USABLE: ONLY leaves out the moves that cannot be taken', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); W.app.edit({ type: 'monSet', monId: monOf(W).id, field: 'level', value: 5 });
      await toTab(W, 'moves'); await W.toRow('m:1'); await W.press('a');
      const all = W.b().list.total, ok = catOf(W).filter((e) => e.status.ok).length;
      await W.press('y'); await W.toPop('usable'); await W.press('right'); await W.press('b');
      return all > ok && ok > 10 && W.b().list.total === ok && pst(W).usable === true;
    });
    await t('H. picker: up / down move a row, L / R and the two page chips a page of six, left / right a CHAPTER (the next first letter under NAME), the wheel rows; FIND (START, or the panel\'s row) narrows by a part of the name and says how many match', async () => {
      const W = await picker(); const want = byName(W), cur = () => pst(W).cursor;
      await W.press('down', 'down'); const two = cur(); await W.press('r'); const page = cur(); await W.press('l', 'l'); const top = cur();
      const dn = W.b().chips[2]; await W.click(dn.x + 3, dn.y + 3); const chip = cur(); const up = W.b().chips[1]; await W.click(up.x + 3, up.y + 3); const chipUp = cur();
      await W.press('right'); const l0 = want[0].name[0], l1 = rowNow(W).label[0], ch = cur(); await W.press('down', 'left'); const backTo = cur();
      W.run(W.hub.pointer({ kind: 'wheel', steps: 2 })); const wheel = cur();
      await W.press('start'); const e = W.view().entry; await W.enter('thunder');
      const n = M.ED.filterMoves(catOf(W), { q: 'thunder' }).length, found = W.b().list.total === n && n > 1 && said(W) === n + ' moves match "thunder". A takes the one highlighted.' && W.b().title === '"thunder": ' + n && cur() === 0;
      await W.press('y'); await W.toPop('find'); await W.press('a'); const viaPanel = W.hub.wantsText() && W.view().entry.value === 'thunder'; for (let i = 0; i < 7; i++) await W.type({ key: 'backspace' }); await W.enter('zzzz');
      return two === 2 && page === 8 && top === 0 && chip === 6 && chipUp === 0 && l1 !== l0 && ch === want.findIndex((x) => x.name[0] !== l0) && backTo === ch && wheel === ch + 2
        && e.charset === 'search' && e.max === 16 && e.title === 'FIND A MOVE' && found && viaPanel && W.b().list.total === 0 && said(W) === 'No move matches "zzzz".' && W.b().info === null;
    }, async () => 'x');
    await t('H. the move picker opened with no slot to fill (its address, a reload) is left for the Pokemon', async () => {
      const W = await atMoves([{ mons: ['Pikachu'] }]); await W.goto('builder-move');
      return W.path() === 'builder-mon' && W.hub.faults().length === 0;
    });
    await t('H. a move this ROM lacks still draws: "Unknown move N" in its slot, the message says why it cannot be shown, and its menu can change it or remove it', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); learn(W, ['Thunderbolt']);
      const gone = pack.moves.length + 5, m = monOf(W);
      W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((x) => (x.id === m.id ? { ...x, moves: [{ id: gone, ppUps: 0 }, x.moves[1]] } : x)) } }));
      await toTab(W, 'moves'); const r0 = W.b().list.rows[0], text = W.b().text, fr = W.frame(), info = W.b().info;
      await W.press('a'); await W.toPop('remove'); await W.press('a');
      return r0.label === 'Unknown move ' + gone && r0.unknown === true && /This ROM has no move with that number/.test(text) && info === null && !fr.fault && W.hub.faults().length === 0 && monOf(W).moves.length === 1 && monOf(W).moves[0].id === moveId('Thunderbolt');
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- I: the STATS tab */
  if (want('I')) {
    const atStats = async (teams, o) => { const W = await atMon(teams, o); await toTab(W, 'stats'); return W; };
    const srow = (W, k) => W.b().list.rows.find((r) => r.stat === k);
    const der = (W) => M.ED.derived(pack, monOf(W), teamOf(W).ruleset);
    const budget = (W) => W.b().list.rows[0].budget.text;
    const ORDER = M.ED.STAT_ORDER;
    await t('I. STATS: EDIT (EVS, and the budget "510 LEFT OF 510"), six stat rows (the battle stat editor_data.js works out, a bar on the DOM editor\'s scale, the EVs and the IV, the nature\'s arrow), then HIDDEN POWER, QUICK ACTIONS, UNDO and REDO', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); W.app.edit({ type: 'monSet', monId: monOf(W).id, field: 'nature', value: 1 }); await toTab(W, 'stats');       // Lonely: +Atk -Def
      const b = W.b(), d = der(W), m = monOf(W), L0 = d.level, core = Math.floor(((2 * 150 + 31 + 63) * L0) / 100), sc = { hp: core + L0 + 10, other: Math.floor(1.1 * (core + 5)) };
      const okRows = ORDER.every((k, i) => { const r = b.list.rows[i + 1]; return r.stat === k && r.value === String(d.stats[k]) && r.eff === String(d.evs[k]) && r.iv === String(m.iv[k]) && r.bar.value === d.stats[k] && r.bar.max === (k === 'hp' ? sc.hp : sc.other) && r.live === 'eff'; });
      const ids = []; for (let i = 0; i < 11; i++) { ids.push(W.row().id); await W.press('down'); }
      return b.layout === 'stats' && b.mode === 'ev' && b.list.rows[0].id === 'edit' && b.list.rows[0].value === 'EVS' && J(b.list.rows[0].budget) === J({ text: '510 LEFT OF 510', bad: false, say: '510 EV left of 510.' }) && okRows && b.list.rows.length === 7 && b.list.total === 11
        && ids.join() === 'edit,s:hp,s:atk,s:def,s:spa,s:spd,s:spe,hp,actions,undo,redo' && L0 === 50 && sc.hp === 257 && sc.other === 222 && srow(W, 'atk').nat === 1 && srow(W, 'def').nat === -1 && srow(W, 'hp').nat === 0;
    }, async () => J((await atStats([{ mons: ['Pikachu'] }])).b().list.rows.slice(0, 2)));
    await t('I. LEFT / RIGHT on a stat step its EVs by 4 through the reducer (evSet); a HELD direction is ONE undo step and another stat starts a new one; the budget follows; LEFT at 0 does nothing', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); await W.toRow('s:atk');
      const fx = await W.press('right'); await W.hold('right', 10);
      const ev = monOf(W).ev.atk, undo1 = W.app.editor().undo.length, left = budget(W);
      await W.press('down'); const fx0 = await W.press('left'); const none = eff(fx0, 'edited').length === 0 && monOf(W).ev.def === 0 && W.app.editor().undo.length === undo1;
      await W.press('right'); await W.press('right');
      await W.press('up'); await W.press('left');
      return eff(fx, 'edited').length === 1 && ev === 44 && undo1 === 1 && left === '466 LEFT OF 510' && none && monOf(W).ev.def === 8 && monOf(W).ev.atk === 40 && W.app.editor().undo.length === 3 && srow(W, 'atk').eff === '40' && srow(W, 'atk').value === String(der(W).stats.atk);
    }, async () => { const W = await atStats([{ mons: ['Pikachu'] }]); await W.toRow('s:atk'); await W.press('right'); await W.hold('right', 10); return monOf(W).ev.atk + ' undo ' + W.app.editor().undo.length + ' ' + budget(W); });
    await t('I. the reducer\'s "was limited to" is shown: with 504 of the 510 EVs spent a third stat stops at 6 (and steps back onto the grid of four), and one stat alone stops at 255', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); const m = monOf(W);
      W.app.edit({ type: 'evSet', monId: m.id, stat: 'atk', value: 252, mode: 'ev' }); W.app.edit({ type: 'evSet', monId: m.id, stat: 'spe', value: 252, mode: 'ev' });
      await W.toRow('s:hp'); await W.press('right'); const four = monOf(W).ev.hp; await W.press('right');
      const lim = monOf(W).ev.hp === 6 && said(W) === 'EV was limited to 6.' && W.b().note === true && budget(W) === '0 LEFT OF 510';
      await W.press('left'); const back = monOf(W).ev.hp;
      W.app.edit({ type: 'evReset', monId: m.id }); await W.toRow('s:def'); await W.hold('right', 64);
      return four === 4 && lim && back === 4 && monOf(W).ev.def === 255 && said(W) === 'EV was limited to 255.';
    }, async () => 'x');
    await t('I. A on a stat opens the numbers for what is being edited: TYPE A NUMBER (digits; letters are refused with the DOM editor\'s words), MAX, +40 and -40 (the menu stays open), MIN', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); await W.toRow('s:atk'); await W.press('a');
      const p = W.b().popup, rows = p.rows.map((r) => r.label + (r.value ? ' ' + r.value : '')).join(), title = p.title;
      await W.toPop('up:40'); await W.press('a'); await W.press('a'); const up = monOf(W).ev.atk === 80 && !!W.b().popup;
      await W.toPop('down:40'); await W.press('a'); const down = monOf(W).ev.atk === 40 && !!W.b().popup;
      await W.toPop('max'); await W.press('a'); const max = monOf(W).ev.atk === 255 && !W.b().popup;
      await W.press('a'); await W.toPop('min'); await W.press('a'); const min = monOf(W).ev.atk === 0;
      await W.press('a'); await W.press('a'); const e = W.view().entry; await W.type({ key: 'backspace' }); await W.enter('100'); const typed = monOf(W).ev.atk === 100;
      await W.press('a'); await W.press('a'); for (let i = 0; i < 3; i++) await W.type({ key: 'backspace' }); await W.enter('AB');
      return rows === 'TYPE A NUMBER,MAX 255,+40,-40,MIN 0' && title === 'ATTACK EV' && up && down && max && min && e.charset === 'code' && e.value === '0' && typed && said(W) === 'Attack: enter a whole number.' && monOf(W).ev.atk === 100;
    }, async () => 'x');
    await t('I. EDIT changes what left / right edit: POINTS shows stat points (one a step; the choice is a preference the ctl keeps), IVS makes them change the IV (one a step, a held direction ONE undo step) and greys the effort column', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]);
      const fx = await W.press('right');
      const pref = eff(fx, 'pref').length === 1 && fx.find((e) => e.type === 'pref').key === 'statsView' && W.storage.getItem('arena.editor.statsView') === 'points' && W.b().mode === 'points' && W.b().list.rows[0].value === 'POINTS' && budget(W) === '66 LEFT OF 66';
      await W.toRow('s:spe'); await W.press('right'); await W.press('right');
      const pts = der(W).points.spe === 2 && monOf(W).ev.spe === ST.pointsToEv(2, 31) && srow(W, 'spe').eff === '2' && budget(W) === '64 LEFT OF 66';
      await W.toRow('edit'); const fx2 = await W.press('right'); const iv = W.b().mode === 'iv' && W.b().list.rows[0].value === 'IVS' && eff(fx2, 'pref').length === 0 && srow(W, 'spe').live === 'iv';
      await W.toRow('s:atk'); const u0 = W.app.editor().undo.length; await W.press('left'); await W.hold('left', 4);
      const ivs = monOf(W).iv.atk === 26 && W.app.editor().undo.length === u0 + 1 && srow(W, 'atk').iv === '26';
      await W.press('a'); const ivMenu = W.b().popup.title === 'ATTACK IV' && W.b().popup.rows.map((r) => r.label + (r.value ? ' ' + r.value : '')).join() === 'TYPE A NUMBER,MAX 31,MIN 0'; await W.press('b');
      await W.toRow('edit'); await W.press('right'); const back = W.b().mode === 'ev' && W.storage.getItem('arena.editor.statsView') === 'ev';
      const V = await atStats([{ mons: ['Pikachu'] }], { storage: fakeStorage({ 'arena.editor.statsView': 'points' }) });
      return pref && pts && iv && ivs && ivMenu && back && V.b().mode === 'points';
    }, async () => 'x');
    await t('I. under rules that store stat points (Champions) there are no EVs to edit: EDIT is POINTS or IVS, the budget is the 66 points, a step is a point, and an IV edit is refused in the reducer\'s words; the viewer\'s own choice of view is left alone', async () => {
      const W = await atStats([{ then: CHAMP, mons: ['Pikachu'] }]);
      const b = W.b(); await W.press('left'); const m1 = W.b().mode; await W.press('left'); await W.press('right'); const m2 = W.b().mode; await W.press('right'); const m3 = W.b().mode;
      await W.toRow('s:atk'); await W.press('right'); const pts = der(W).points.atk, left = budget(W);
      await W.toRow('edit'); await W.press('right'); await W.toRow('s:atk'); await W.press('left');
      return b.mode === 'points' && b.list.rows[0].value === 'POINTS' && b.list.rows[0].budget.text === '66 LEFT OF 66' && m1 === 'iv' && m2 === 'iv' && m3 === 'points' && pts === 1 && left === '65 LEFT OF 66'
        && said(W) === 'These rules fix every IV at 31.' && W.b().note === true && W.storage.getItem('arena.editor.statsView') === null && srow(W, 'atk').iv === '31';
    }, async () => 'x');
    await t('I. HIDDEN POWER shows the type the IVs make and the ROM\'s fixed power; A lists the sixteen types (the list scrolls) with the cursor on the one it has, and the one taken sets the IVs through the reducer (ivPreset), which the line then shows', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); await W.toRow('hp');
      const r0 = rowNow(W), d0 = der(W).hiddenPower;
      await W.press('a'); const p = W.b().popup, all = W.popRows().map((r) => r.label).sort().join();
      await W.toPop('hp:Fire'); const fx = await W.press('a');
      const r1 = rowNow(W), want = ST.hiddenPowerIvs('Fire');
      return r0.value === d0.type && r0.type === d0.typeId && r0.power === '60' && p.title === 'HIDDEN POWER' && p.rows.length === 6 && p.total === 16 && (p.up || p.down) && p.lane === true && all === ST.HIDDEN_POWER_TYPES.map((x) => x.name.toUpperCase()).sort().join()
        && p.rows[p.cursor].id === 'hp:' + d0.type && ORDER.every((k) => monOf(W).iv[k] === want[k]) && r1.value === 'Fire' && r1.type === 11 && eff(fx, 'edited').length === 1 && !W.b().popup;
    }, async () => 'x');
    await t('I. QUICK ACTIONS (the row, START or X): RESET, SNAP, ALL 31, 0 ATK, 0 SPE, 0 ATK+SPE, ALL 0, each sent to the reducer as the DOM editor sent it', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); const m = monOf(W);
      const seen = []; for (const a of ['start', 'x']) { await W.press(a); seen.push(W.b().popup ? W.popRows().map((r) => r.label).join() : ''); await W.press('b'); }
      await W.toRow('actions'); await W.press('a'); const viaRow = W.b().popup && W.b().popup.title === 'QUICK ACTIONS' && W.b().popup.id === 'quick'; await W.press('b');
      const act = async (id) => { await W.press('start'); await W.toPop(id); await W.press('a'); return ORDER.map((k) => monOf(W).iv[k]).join(); };
      const a1 = await act('zeroAtk'), a2 = await act('zeroSpe'), a3 = await act('zeroAtkSpe'), a4 = await act('all0'), a5 = await act('all31');
      W.app.edit({ type: 'evSet', monId: m.id, stat: 'atk', value: 6, mode: 'ev' }); W.app.edit({ type: 'evSet', monId: m.id, stat: 'spe', value: 252, mode: 'ev' });
      await act('snap'); const snapped = monOf(W).ev.atk === 4 && monOf(W).ev.spe === 252 && /^Snapped EVs to the cheapest values; 2 EV freed\.$/.test(said(W));
      await act('reset');
      return seen.every((s) => s === 'RESET,SNAP,ALL 31,0 ATK,0 SPE,0 ATK+SPE,ALL 0') && viaRow && a1 === '31,0,31,31,31,31' && a2 === '31,31,31,31,31,0' && a3 === '31,0,31,31,31,0' && a4 === '0,0,0,0,0,0' && a5 === '31,31,31,31,31,31' && snapped
        && ORDER.every((k) => monOf(W).ev[k] === 0);
    }, async () => 'x');
    await t('I. a tap on a number\'s right half steps it up and on its left half down; a tap on the OTHER number makes that one the one edited (and changes nothing); a tap elsewhere on the row opens the numbers', async () => {
      const W = await atStats([{ mons: ['Pikachu'] }]); const c = M.BG.statCells(2), y = c.eff.y + 5;          // (row 2 of the window is Attack)
      await W.click(c.eff.x + c.eff.w - 4, y); await W.click(c.eff.x + c.eff.w - 4, y); const up = monOf(W).ev.atk;
      await W.click(c.eff.x + 4, y); const down = monOf(W).ev.atk;
      await W.click(c.iv.x + c.iv.w - 4, y); const sw = W.b().mode === 'iv' && monOf(W).iv.atk === 31 && srow(W, 'atk').live === 'iv';
      await W.click(c.iv.x + 4, y); const ivDown = monOf(W).iv.atk === 30;
      await W.click(c.eff.x + 4, y); const swBack = W.b().mode === 'ev' && monOf(W).ev.atk === down;
      const hit = W.hub.hit(c.eff.x + 4, y); await W.click(30, y); const pop = W.b().popup;
      return up === 8 && down === 4 && sw && ivDown && swBack && pop && pop.title === 'ATTACK EV' && tabCur(W) === 2 && J(hit) === J({ kind: 'row', index: 2, zone: 'main' });
    }, async () => 'x');
    await t('I. a record of a species this ROM lacks has no stats to show: the tab says so, and nothing faults', async () => {
      const W = await mk(); await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]); await W.open();
      W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m) => ({ ...m, species: pack.species.length + 7 })) } }));
      await W.press('a'); await W.press('a'); await W.press('a'); await W.press('a'); await toTab(W, 'stats');
      const b = W.b(), fr = W.frame(); await W.press('start'); await W.press('right'); await W.press('a');
      return b.layout === 'stats' && b.list.rows.map((r) => r.id).join() === 'none,undo,redo' && /no stats to show/.test(b.text) && !fr.fault && !W.b().popup && W.hub.faults().length === 0;
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- J: the portrait, the team code, the test battle */
  if (want('J')) {
    const codeOf = (W, i = 0) => M.TC.encodeTeamCode(M.TC.teamFromProfile(W.profile(), teamOf(W, i).id));
    const cst = (W) => W.st().screens['builder-code'];
    /** A on the highlighted row, carried out, and the ctl's answer waited for. */
    const go = async (W) => { const fx = W.hub.press('a'); W.run(fx); await W.idle(); return fx; };
    /** The teams list's IMPORT A CODE, with `text` on the clipboard and the cursor on PASTE A CODE. */
    const atImport = async (W, text) => { await W.toRow('x:code'); await W.press('a'); if (text !== undefined) W.clip.text = text; await W.toRow('paste'); return W; };
    await t('J. PORTRAIT is in the ACTIVE trainer\'s menu and in no other; the picker shows three of the ROM\'s 52 heads at a time and opens on the one in use; LEFT / RIGHT step a head, UP / DOWN / L / R and the page chips a page of three; A takes the head through the reducer (avatar) and goes back; B changes nothing', async () => {
      const W = await mk(); const blue = await seed(W.store, W.deps, 'BLUE', []); const red = await seed(W.store, W.deps, 'RED', []);
      await W.open(); await W.press('right'); const mine = W.b().popup.rows.map((r) => r.label).join(); await W.press('b');
      await W.toRow('p:' + blue.id); await W.press('right'); const other = W.b().popup.rows.map((r) => r.label).join(); await W.press('b');
      await W.toRow('p:' + red.id); await W.press('right'); await W.toPop('x:portrait'); await W.press('a');
      const b = W.b(), used = W.profile().avatar.id, cur = () => W.st().screens['builder-portrait'].cursor, c0 = cur();
      await W.press('right'); const c1 = cur(); await W.press('down'); const c2 = cur(); await W.press('r'); const c3 = cur(); await W.press('l', 'up'); const c4 = cur(); await W.press('left'); const c5 = cur(); await W.press('left'); const c6 = cur();
      const upChip = W.b().chips.find((c) => c.id === 'pgup'); await W.click(upChip.x + 3, upChip.y + 3); const c7 = cur();
      await W.press('b'); const kept = W.path() === 'builder' && W.profile().avatar.id === used;
      await W.press('right'); await W.toPop('x:portrait'); await W.press('a'); await W.press('right', 'right', 'right', 'right'); const fx = await W.press('a');
      const took = W.path() === 'builder' && W.profile().avatar.kind === 'preset' && W.profile().avatar.id === used + 4 && eff(fx, 'edited').length === 1 && W.b().side.avatar.id === used + 4;
      await W.press('right'); await W.toPop('x:portrait'); await W.press('a');
      const again = W.b();
      return mine === 'OPEN,RENAME,PORTRAIT,UNDO,REDO,DELETE' && other === 'OPEN,RENAME,DELETE' && b.kind === 'portrait' && b.tag === null && b.cells.length === 3 && b.cells.map((c) => c.id).join() === [used, used + 1, used + 2].join() && used === 0 && c0 === used
        && b.cells[0].used === true && b.cells[0].on === true && b.title === 'PORTRAIT 1/52' && J([c1, c2, c3, c4, c5, c6, c7]) === J([1, 4, 7, 1, 0, 51, 48]) && kept && took
        && cur() === used + 4 && again.cells.find((c) => c.used).id === used + 4 && again.cells.find((c) => c.on).id === used + 4 && again.cells.map((c) => c.id).join() === '3,4,5';
    }, async () => 'x');
    await t('J. CODE (the team\'s chip): the ctl says how long the team\'s code is; COPY CODE puts the ARENA1 code on the clipboard, NEVER in the view or the state, and says how many characters it is; an empty team has no code', async () => {
      const W = await atTeam([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar'] }, {}]);
      await chipOf(W, 'x:code'); await W.idle();
      const b = W.b(), want = await codeOf(W);
      const fx = await go(W);
      const d = await M.TC.decodeTeamCode(W.clip.text);
      const hidden = !J(W.view()).includes(want.slice(7, 30)) && !J(W.hub.state()).includes(want.slice(7, 30));
      const V = await atTeam([{}]); await chipOf(V, 'x:code'); await V.idle(); const vHelp = said(V); const vfx = await go(V);
      return W.path() === 'builder-code' && b.kind === 'code' && b.title === 'CODE: ALPHA' && b.list.rows.map((r) => r.label).join() === 'COPY CODE,PASTE A CODE,ENTER A CODE,BACK' && b.side.lines[0] === want.length + ' CHARACTERS' && cst(W).chars === want.length
        && b.text === 'This team as a code of ' + want.length + ' characters. A copies it to the clipboard.' && eff(fx, 'code-copy').length === 1 && W.clip.text === want && EL.CODE_RE.test(W.clip.text) && d.ok && d.team.name === 'ALPHA' && d.team.mons.length === 2
        && hidden && said(W) === 'Team code copied: ' + want.length + ' characters. Paste it wherever you like.' && W.clip.writes === 1
        && /An empty team has no code\./.test(vHelp) && vfx.length === 0 && V.clip.writes === 0 && /An empty team has no code\. Add a Pok.E.mon first\./.test(said(V)) && V.b().note === true;
    }, async () => 'x');
    await t('J. a browser that will not let the page copy, or has no clipboard at all, is said in the picture', async () => {
      const W = await atTeam([{ mons: ['Pikachu'] }]); await chipOf(W, 'x:code'); await W.idle(); W.clip.refuse.write = true; await go(W);
      const V = await atTeam([{ mons: ['Pikachu'] }], { clipboard: false }); await chipOf(V, 'x:code'); await V.idle(); await go(V);
      return /^This browser did not let the page copy\./.test(said(W)) && W.b().note === true && W.clip.text === '' && /^This browser did not let the page copy\./.test(said(V)) && W.hub.faults().length === 0;
    }, async () => 'x');
    let copyNote = '';
    await t('J. COPY CODE starts its write in the very call that asked once the code is made (a browser that lets a page copy only from inside a press or a tap would refuse a later one); a team edited since is encoded again first, so the code copied is always the team as it is NOW', async () => {
      const W = await atTeam([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar'] }]);
      await chipOf(W, 'x:code'); await W.idle();
      const id = teamOf(W).id, n0 = W.clip.writes;
      const p = W.ctl.effect({ app: 'builder', type: 'code-copy', teamId: id });
      const atOnce = W.clip.writes - n0;                                  // (read before anything is awaited: the write was started by the call itself)
      await p; await W.idle();
      const d1 = await M.TC.decodeTeamCode(W.clip.text);
      W.app.edit({ type: 'teamRename', teamId: id, name: 'BETA' });       // the team is another document now: the code made for ALPHA must not be the one copied
      const q = W.ctl.effect({ app: 'builder', type: 'code-copy', teamId: id });
      const late = W.clip.writes - n0;
      await q; await W.idle();
      const d2 = await M.TC.decodeTeamCode(W.clip.text);
      copyNote = J([atOnce, late, W.clip.writes - n0, d1.ok && d1.team.name, d2.ok && d2.team.name]);
      return atOnce === 1 && late === 1 && W.clip.writes - n0 === 2 && d1.ok && d1.team.name === 'ALPHA' && d2.ok && d2.team.name === 'BETA' && /^Team code copied: \d+ characters\./.test(said(W));
    }, async () => copyNote);
    await t('J. PASTE A CODE reads the clipboard on that press and shows the PREVIEW: the team\'s name, its rules, its Pokemon, LEGAL; ADD AS A NEW TEAM adds it through the reducer (teamImport) and opens it in the screen\'s place (B from it is the teams list); CANCEL and B forget it', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar', 'Snorlax'] }]); await W.press('a');
      const code = await codeOf(W);
      await W.toRow('x:code'); await W.press('a'); const b0 = W.b();
      W.clip.text = '  ' + code.slice(0, 30) + '\n' + code.slice(30) + ' '; await W.toRow('paste'); const fx = await go(W);
      const p = W.b(), reads = W.clip.reads;
      await W.press('down'); await W.press('a'); const cancelled = W.b().list.rows[0].id === 'paste' && !cst(W).preview && W.profile().teams.length === 1;
      await W.toRow('paste'); await go(W); await W.press('b'); const backed = W.path() === 'builder-code' && !cst(W).preview;
      await W.toRow('paste'); await go(W); const fx2 = await W.press('a');
      const t2 = W.profile().teams[1], opened = W.path() === 'builder-team' && t2 && W.b().title === t2.name && W.st().at.teamId === t2.id;
      await W.press('b');
      return b0.title === 'TEAM CODE' && b0.list.rows.map((r) => r.id).join() === 'paste,enter,back' && eff(fx, 'code-paste').length === 1 && reads === 1 && p.title === 'CODE: ALPHA' && p.list.rows.map((r) => r.label).join() === 'ADD AS A NEW TEAM,CANCEL'
        && p.side.icons.map((i) => i.species).join() === [sid('Pikachu'), sid('Gengar'), sid('Snorlax')].join() && J(p.side.lines) === J(['3 POK{E}MON', 'LEGAL']) && p.side.bad === false && p.text === 'Standard (Lv 50, 510 EV). Every Pok{E}mon passes the rules.'
        && cancelled && backed && eff(fx2, 'edited').length === 1 && fx2.some((e) => e.type === 'screen' && e.replace === true) && opened && t2.monIds.length === 3 && W.profile().box.length === 6 && W.path() === 'builder-teams';
    }, async () => 'x');
    await t('J. a code whose team does not pass its own rules still shows: n PROBLEMS, and the message has how many and the first reasons in the rules module\'s words; it is added as it is', async () => {
      const W = await seeded([{ name: 'CH', then: CHAMP, mons: ['Pikachu', 'Gengar'] }]); await W.press('a');
      const code = await codeOf(W), v = M.TC.validateDecodedTeam((await M.TC.decodeTeamCode(code)).team, pack), first = v.reasons[0];
      await atImport(W, code); await go(W);
      const p = W.b(); await W.press('a');
      return v.reasons.length >= 2 && p.side.bad === true && p.side.lines[1] === v.reasons.length + ' PROBLEMS' && p.pages >= 2
        && p.text.startsWith('Champions (Lv 50, stat points). ' + v.reasons.length + ' problems under its rules; it is added as it is and CHECK lists them. Slot ' + (first.mon + 1) + ', ' + M.ED.fieldLabel(first.path) + ': ' + M.ED.reasonText(first.code, first.message) + '.')
        && W.profile().teams.length === 2 && W.path() === 'builder-team' && W.b().status.bad === true;
    }, async () => 'x');
    await t('J. a code that does not read is refused IN WORDS the ROM font can draw: a mistyped character, a text that is no code, a code of another version, a team built for another ROM, a Pokemon this ROM lacks; an empty clipboard and a clipboard the browser will not let the page read are said too', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu'] }]); await W.press('a');
      const t0 = M.TC.teamFromProfile(W.profile(), teamOf(W).id), code = await M.TC.encodeTeamCode(t0);
      const tries = [
        [code.slice(0, -1) + (code.slice(-1) === '0' ? '1' : '0'), /^That code cannot be used: The check value does not match: a character was mistyped or the code was cut short\.$/],
        ['hello there', /^That code cannot be used: A team code has the form ARENA1\.payload\.check\.$/],
        ['ARENA2.abcd.0000', /^That code cannot be used: ARENA2 codes are not supported by this build\.$/],
        [await M.TC.encodeTeamCode({ ...t0, romSha256: 'f'.repeat(64) }), /^That code cannot be used: This team was built for a different ROM\.$/],
        [await M.TC.encodeTeamCode({ ...t0, mons: t0.mons.map((m) => ({ ...m, species: pack.species.length + 3 })) }), /^That code cannot be used: This code holds a Pokemon that this ROM does not have \(slot 1: number \d+\), so it cannot be opened here\.$/],
        ['   ', /^The clipboard holds no text\. Copy a team code first\.$/],
      ];
      await atImport(W); const bad = [];
      for (const [text, re] of tries) {
        W.clip.text = text; await W.press('up'); await W.toRow('paste'); await go(W);
        const s = W.b().text;
        if (!(re.test(s) && W.b().note === true && !cst(W).preview && ui.safeText(s) === s)) bad.push(s);
      }
      W.clip.refuse.read = true; W.clip.text = code; await W.press('up'); await W.toRow('paste'); await go(W);
      const refused = /^This browser did not let the page read the clipboard\. Use ENTER A CODE and paste there/.test(W.b().text) && W.b().note === true && !cst(W).preview;
      return bad.length === 0 && refused && W.profile().teams.length === 1 && W.hub.faults().length === 0;
    }, async () => 'x');
    await t('J. ENTER A CODE opens the text entry with the code\'s alphabet (1024 characters): a paste arrives whole with its white space dropped, and OK shows the same preview', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar'] }]); await W.press('a'); const code = await codeOf(W);
      await atImport(W); await W.toRow('enter'); await W.press('a');
      const e = W.view().entry; await W.type({ text: code.slice(0, 20) + ' \n\t' + code.slice(20) + '\n' });
      const whole = W.view().entry.value === code; const fx = W.hub.type({ key: 'enter' }); W.run(fx); await W.idle();
      return W.hub.wantsText() === false && e.charset === 'teamcode' && e.max === 1024 && e.value === '' && whole && eff(fx, 'code-decode').length === 1 && cst(W).preview === true && W.b().title === 'CODE: ALPHA' && W.clip.reads === 0;
    }, async () => 'x');
    await t('J. with sixteen teams ADD AS A NEW TEAM is refused in the reducer\'s words, and the preview stays', async () => {
      const W = await seeded([{ name: 'ALPHA', mons: ['Pikachu'] }, ...Array.from({ length: 15 }, () => ({}))]); await W.press('a'); const code = await codeOf(W);
      await atImport(W, code); await go(W); await W.press('a');
      return W.profile().teams.length === 16 && W.path() === 'builder-code' && cst(W).preview === true && said(W) === 'A profile holds at most 16 teams.';
    }, async () => 'x');
    await t('J. TEST (the team\'s chip): FORMAT (3v3 only with three Pokemon or more), CPU, FOE, START; START saves the edits first, then leaves for the battle page at the DOM editor\'s address: the team\'s code, foe=random, a fresh seed, the format and the CPU', async () => {
      const W = await atTeam([{ name: 'ALPHA', mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
      await W.press('start'); await W.toPop('sort'); await W.press('a');          // an edit that is not saved yet (the debounce is pending)
      const pendingSave = W.timers.length === 1 && W.st().tag === 'SAVING';
      await chipOf(W, 'x:test'); const b = W.b(), rows = W.rows().map((r) => r.label + (r.value !== undefined ? '=' + r.value : '')).join(), onStart = W.row().id === 'start';
      await W.toRow('format'); await W.press('right'); const f2 = W.row().value; await W.toRow('cpu'); await W.press('right'); const c2 = W.row().value; await W.toRow('start');
      const fx = await go(W); await W.idle();
      const url = W.log.navigated[0], q = EL.parseBattleUrl(url || ''), d = await M.TC.decodeTeamCode(q.team || ''), s = await W.stored();
      const V = await atTeam([{ mons: ['Pikachu', 'Gengar'] }]); await chipOf(V, 'x:test'); await V.toRow('format'); const v1 = V.row().value; await V.press('right');
      return pendingSave && b.kind === 'test' && b.title === 'TEST: ALPHA' && rows === 'FORMAT=3v3,CPU=NORMAL,FOE=RANDOM,START,BACK' && onStart && f2 === '6v6' && c2 === 'HARD' && eff(fx, 'test-start').length === 1
        && W.log.navigated.length === 1 && q.path === '/pokemonarena/battle.html' && q.foe === 'random' && q.seed === 0x12345678 && q.format === '6v6' && q.cpu === 'hard' && q.team === (await codeOf(W)) && d.ok
        && d.team.mons.map((m) => m.species).join() === s.teams[0].monIds.map((id) => s.box.find((m) => m.id === id).species).join() && d.team.mons[0].species === sid('Snorlax') && W.st().tag === 'SAVED' && W.timers.length === 0
        && v1 === '6v6' && V.row().value === '6v6' && /A team of fewer than three plays 6v6/.test(said(V));
    }, async () => 'x');
    await t('J. START is refused in words while the team is empty or has problems, or the other team chosen has problems: nothing is opened', async () => {
      const W = await atTeam([{}]); await chipOf(W, 'x:test'); const fx = await go(W); const empty = said(W) === 'Add a Pok{E}mon first.' && fx.length === 0 && W.b().note === true;
      const V = await atTeam([{ then: CHAMP, mons: ['Pikachu', 'Gengar'] }]); const n = V.b().status.text; await chipOf(V, 'x:test'); const help = said(V); const vfx = await go(V);
      const probs = /^Fix the \d+ problems first: CHECK lists them\.$/.test(said(V)) && help === said(V) && vfx.length === 0 && /PROBLEMS/.test(n);
      const U = await atTeam([{ name: 'GOOD', mons: ['Pikachu'] }, { name: 'BAD', then: CHAMP, mons: ['Gengar'] }]); await chipOf(U, 'x:test'); await U.toRow('foe'); await U.press('right'); const foe = U.row().value; await U.toRow('start'); const ufx = await go(U);
      return empty && probs && foe === 'BAD' && /^"BAD" has \d+ problems?; fix (it|them) first\.$/.test(said(U)) && ufx.length === 0 && W.log.navigated.length + V.log.navigated.length + U.log.navigated.length === 0;
    }, async () => 'x');
    await t('J. FOE: RANDOM, or another of this trainer\'s teams (only those with Pokemon are offered); START then carries that team\'s code as the foe', async () => {
      const W = await atTeam([{ name: 'ALPHA', mons: ['Pikachu'] }, { name: 'BETA', mons: ['Gengar'] }, { name: 'EMPTY' }]);
      await chipOf(W, 'x:test'); await W.toRow('foe'); const seen = [W.row().value]; for (let i = 0; i < 3; i++) { await W.press('right'); seen.push(W.row().value); }
      await W.toRow('start'); await go(W); await W.idle();
      const q = EL.parseBattleUrl(W.log.navigated[0] || ''), d = await M.TC.decodeTeamCode(q.foe || '');
      const V = await atTeam([{ mons: ['Pikachu'] }, {}]); await chipOf(V, 'x:test'); await V.toRow('foe'); await V.press('right');
      return seen.join() === 'RANDOM,BETA,RANDOM,BETA' && W.log.navigated.length === 1 && q.team === (await codeOf(W, 0)) && q.foe === (await codeOf(W, 1)) && d.ok && d.team.name === 'BETA' && q.format === '6v6' && q.cpu === 'normal'
        && V.row().value === 'RANDOM' && /no other team with Pok.E.mon/.test(said(V));
    }, async () => 'x');
  }

  /* ---------------------------------------------------------------------------------------------- K: undo and redo */
  if (want('K')) {
    const st = (W) => W.st();
    await t('K. Ctrl+Z undoes and Ctrl+Y (or Ctrl+Shift+Z) redoes through the reducer, from any builder screen; the reducer\'s words are shown and the change is saved like any edit', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('shiny'); await W.press('a'); await W.saved();
      const took = await ctrl(W, 'z'); const undone = monOf(W).shiny === false && said(W) === 'Undid: edit shiny.' && st(W).tag === 'SAVING' && W.timers.length === 1 && st(W).undo === 0 && st(W).redo === 1;
      await W.saved(); const stored = (await W.stored()).box[0].shiny === false && st(W).tag === 'SAVED';
      const tookY = await ctrl(W, 'y'); const redone = monOf(W).shiny === true && said(W) === 'Redid: edit shiny.';
      await ctrl(W, 'z'); await W.key({ metaKey: true, shiftKey: true, key: 'Z' }); const shiftZ = monOf(W).shiny === true && st(W).redo === 0;
      await W.press('b'); await ctrl(W, 'z'); const onTeam = W.path() === 'builder-team' && monOf(W).shiny === false && said(W) === 'Undid: edit shiny.';
      await W.press('b'); await ctrl(W, 'y'); const onTeams = W.path() === 'builder-teams' && monOf(W).shiny === true;
      return took === true && undone && stored && tookY === true && redone && shiftZ && onTeam && onTeams;
    }, async () => 'x');
    await t('K. Ctrl+Z is left alone while a text entry is open, while a question is asked, while a DOM panel is up and when the key goes to a text field of the page; Z without Ctrl is no undo; outside the builder nothing listens', async () => {
      const W = await atMon([{ mons: ['Pikachu', 'Gengar'] }]); await W.toRow('shiny'); await W.press('a');
      await W.toRow('nickname'); await W.press('a'); const typing = W.hub.wantsText();
      const t1 = await ctrl(W, 'z'), direct = W.app.undo().length === 0, s1 = monOf(W).shiny; await W.type({ key: 'escape' });
      await W.press('b'); await W.press('a'); await W.toPop('remove'); await W.press('a'); const asking = W.hub.dialog.isOpen();
      const t2 = await ctrl(W, 'z'), s2 = monOf(W).shiny; await answer(W, false);
      W.log.domPanel = true; const t3 = await ctrl(W, 'z'); W.log.domPanel = false;
      const t4 = await ctrl(W, 'z', { target: { tagName: 'INPUT' } }), t5 = await W.key({ key: 'z' }), t6 = await ctrl(W, 'z', { altKey: true }), t7 = await ctrl(W, 'x');
      const still = monOf(W).shiny === true && st(W).undo === 1;
      const t8 = await ctrl(W, 'z'), worked = monOf(W).shiny === false;
      await W.goto('main'); const t9 = await ctrl(W, 'y');
      return typing && asking && J([t1, t2, t3, t4, t5, t6, t7]) === J([false, false, false, false, false, false, false]) && direct && s1 === true && s2 === true && still && t8 === true && worked && t9 === false && W.path() === 'main';
    }, async () => 'x');
    await t('K. the stack is the reducer\'s: twenty steps and no more, and a new edit clears what could be redone', async () => {
      const W = await atMon([{ mons: ['Pikachu'] }]); await W.toRow('nature');
      for (let i = 0; i < 23; i++) await W.press('right');
      const deep = st(W).undo; for (let i = 0; i < 20; i++) await ctrl(W, 'z');
      const at = monOf(W).nature; await ctrl(W, 'z'); const bottom = monOf(W).nature === at && said(W) === 'Nothing to undo.' && st(W).undo === 0 && st(W).redo === 20;
      await ctrl(W, 'y'); const one = monOf(W).nature === at + 1; await W.press('right');
      const cleared = st(W).redo === 0; await ctrl(W, 'y');
      return monOf(W).nature === at + 2 && deep === 20 && at === 3 && bottom && one && cleared && said(W) === 'Nothing to redo.';
    }, async () => 'x');
    await t('K. every editing screen has UNDO and REDO in the picture: the active trainer\'s menu, the teams list, the team\'s menu, RULES, CHECK, and the last two rows of BUILD, MOVES and STATS; they are grey while there is nothing to undo, and A then says so', async () => {
      const W = await seeded([{ mons: ['Pikachu'] }]);
      const seen = {}, greyOf = (rows) => ['undo', 'redo'].map((id) => { const r = rows.find((x) => x.id === id || x.id === 'x:' + id); return r ? r.label + (r.disabled ? '*' : '') : '?'; }).join();
      // (a list shows seven rows at most: its two rows are read where the cursor stands on them; then A on one of them, grey as it is)
      const list = async (name, pre, id) => { const two = []; for (const k of ['undo', 'redo']) { await W.toRow(pre + k); two.push(rowNow(W)); } await W.toRow(pre + id); await W.press('a'); seen[name] = greyOf(two) + ' ' + said(W); };
      await W.press('right'); seen.trainer = greyOf(W.popRows()); await W.toPop('x:undo'); await W.press('a'); seen.trainer += ' ' + said(W) + ' ' + !!W.b().popup; await W.press('b');
      await W.press('a'); await list('teams', 'x:', 'undo');
      await W.toRow('t:' + teamOf(W).id); await W.press('a'); await W.press('start'); seen.team = greyOf(W.popRows()); await W.toPop('x:redo'); await W.press('a'); seen.team += ' ' + said(W); await W.press('b');
      await chipOf(W, 'rules'); await list('rules', '', 'undo'); await W.press('b');
      await chipOf(W, 'check'); await list('check', '', 'redo'); await W.press('b');
      await clickSlot(W, 0); await W.toPop('edit'); await W.press('a'); await list('build', '', 'undo');
      await toTab(W, 'moves'); await list('moves', '', 'undo'); await toTab(W, 'stats'); await list('stats', '', 'redo');
      const grey = J(seen) === J({ trainer: 'UNDO*,REDO* Nothing to undo. true', teams: 'UNDO*,REDO* Nothing to undo.', team: 'UNDO*,REDO* Nothing to redo.', rules: 'UNDO*,REDO* Nothing to undo.', check: 'UNDO*,REDO* Nothing to redo.',
        build: 'UNDO*,REDO* Nothing to undo.', moves: 'UNDO*,REDO* Nothing to undo.', stats: 'UNDO*,REDO* Nothing to redo.' });
      // ... and after an edit every one of them can undo it
      await toTab(W, 'build'); await W.toRow('shiny'); await W.press('a'); const live = [];
      await W.toRow('undo'); live.push(rowNow(W).disabled !== true && said(W) === 'Undo: edit shiny.'); await W.press('a'); live.push(monOf(W).shiny === false && said(W) === 'Undid: edit shiny.' && rowNow(W).id === 'undo');
      await W.toRow('redo'); await W.press('a'); live.push(monOf(W).shiny === true);
      await toTab(W, 'stats'); await W.toRow('undo'); await W.press('a'); live.push(monOf(W).shiny === false); await ctrl(W, 'y');
      await toTab(W, 'moves'); await W.toRow('undo'); await W.press('a'); live.push(monOf(W).shiny === false); await ctrl(W, 'y');
      await W.press('b'); await chipOf(W, 'rules'); await W.toRow('undo'); await W.press('a'); live.push(monOf(W).shiny === false); await ctrl(W, 'y'); await W.press('b');
      await chipOf(W, 'check'); await W.toRow('undo'); await W.press('a'); live.push(monOf(W).shiny === false); await ctrl(W, 'y'); await W.press('b');
      await W.press('start'); await W.toPop('x:undo'); await W.press('a'); live.push(monOf(W).shiny === false && !!W.b().popup); await W.press('b'); await ctrl(W, 'y');
      await W.press('b'); await W.toRow('x:undo'); await W.press('a'); live.push(monOf(W).shiny === false); await ctrl(W, 'y');
      await W.press('b'); await W.press('right'); await W.toPop('x:undo'); await W.press('a'); live.push(monOf(W).shiny === false);
      return grey && live.length === 10 && live.every(Boolean);
    }, async () => 'x');
    await t('K. an undo that takes away what the screen shows leaves it for the nearest screen that can be shown: the team just made (its menu\'s UNDO), the Pokemon just added (Ctrl+Z); REDO on the teams list brings the team back, and the cursor stays on REDO', async () => {
      const W = await seeded([]); await W.press('a'); await W.press('a');
      const onTeam = W.path() === 'builder-team'; await W.press('start'); await W.toPop('x:undo'); const fx = await W.press('a');
      const gone = W.path() === 'builder-teams' && W.profile().teams.length === 0 && !W.b().popup && fx.some((e) => e.type === 'screen') && said(W) === 'Undid: new team.';
      await W.toRow('x:redo'); await W.press('a'); const back = W.profile().teams.length === 1 && W.row().id === 'x:redo' && said(W) === 'Redid: new team.';
      await W.toRow('t:' + W.profile().teams[0].id); await W.press('a'); await W.press('a'); await find(W, 'Gengar'); const onMon = W.path() === 'builder-mon';
      await ctrl(W, 'z');
      return onTeam && gone && back && onMon && W.path() === 'builder-team' && teamOf(W).monIds.length === 0 && said(W) === 'Undid: add Pokemon.' && W.hub.faults().length === 0;
    }, async () => 'x');
    let goneNote = '';
    await t('K. UNDO on the CHECK or the RULES screen of a team that was just made takes the team away under the screen: it is left for the teams list with no fault, and the undo still reaches the ctl (one "edited", the move to the list)', async () => {
      const out = [];
      for (const chip of ['check', 'rules']) {
        const W = await seeded([]); await W.press('a'); await W.press('a');          // NEW TEAM: the team opens
        await chipOf(W, chip); await W.toRow('undo'); const on = W.path() === 'builder-' + chip && rowNow(W).disabled !== true;
        const fx = await W.press('a');
        out.push(on && W.path() === 'builder-teams' && W.profile().teams.length === 0 && eff(fx, 'edited').length === 1 && fx.some((e) => e.type === 'screen') && said(W) === 'Undid: new team.' && W.hub.faults().length === 0 && W.log.failed === undefined);
        await W.saved(); out.push((await W.stored()).teams.length === 0);
      }
      goneNote = J(out);
      return out.length === 4 && out.every(Boolean);
    }, async () => goneNote);
    await t('K. UNDO in a menu keeps the menu open and the reducer\'s words in the message box: A again undoes the step before; the words go with the next press, and do not come back when the menu closes', async () => {
      const W = await atTeam([{ mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
      await W.press('a'); await W.toPop('later'); await W.press('a'); await W.press('a'); await W.press('b');          // two reorders: two steps
      const two = st(W).undo === 2 && monOf(W, 2).species === sid('Pikachu');
      await W.press('start'); await W.toPop('x:undo'); await W.press('a');
      const one = st(W).undo === 1 && !!W.b().popup && said(W) === 'Undid: reorder Pokemon.' && W.b().note === true && monOf(W, 1).species === sid('Pikachu');
      await W.press('a'); const none = st(W).undo === 0 && !!W.b().popup && monOf(W, 0).species === sid('Pikachu');
      await W.press('a'); const empty = said(W) === 'Nothing to undo.' && !!W.b().popup && W.b().popup.rows[W.b().popup.cursor].disabled === true;
      await W.press('down'); const help = said(W), noNote = W.b().note === false; await W.press('b');
      return two && one && none && empty && /^Redo: reorder Pokemon\./.test(help) && noNote && !W.b().popup && W.b().note === false && !/Nothing to undo/.test(said(W));
    }, async () => 'x');
  }
  return { fails, names };
}

/* ================================================================================================ the renderer */
// THE CATALOGUE: every builder screen in the states a player meets, each as [name, view]. The golden hashes, the opaque-frame check, the fit check and the PNGs all walk it.
async function catalogue(dir) {
  const out = [], add = (name, W) => out.push([name, W.view()]);
  const chip = async (W, id) => { const c = W.b().chips.find((x) => x.id === id); return W.click(c.x + 4, c.y + 4); };          // (a tap on a chip / a slot: where the cursor was before does not matter)
  const slot = async (W, i) => { const r = W.hub.rects()[i]; W.run(W.hub.pointer({ kind: 'move', x: r.x + 40, y: r.y + 8 })); };
  const mk = (o) => makeWorld({ dir, ...(o || {}) });
  const W0 = await mk(); W0.hub.goto('builder'); add('wait boot', W0);
  const W1 = await mk(); await W1.open(); add('trainers none', W1);
  const W = await mk();
  await seed(W.store, W.deps, 'BLUE', [{ mons: ['Gengar'] }]);
  await seed(W.store, W.deps, 'RED', [{ name: 'KANTO', mons: ['Pikachu', 'Charizard', 'Snorlax', 'Gengar', 'Mewtwo', 'Lapras'] }, { name: 'CHAMPS', then: CHAMP, mons: ['Pikachu', 'Sandy Shocks'] }, { name: 'EMPTY' }]);
  await W.open(); add('trainers', W); await W.press('down'); add('trainers other', W); await W.press('up', 'right'); add('trainer menu', W); await W.toPop('delete'); await W.press('a'); add('trainer delete ask', W); await W.press('b');
  await W.press('a'); add('teams', W); await W.press('down'); add('teams problems', W); await W.press('down'); add('teams empty row', W); await W.press('down'); add('teams new', W); await W.press('up', 'up', 'up', 'right'); add('teams menu', W); await W.press('b');
  await W.press('a'); add('team full', W); await slot(W, 3); add('team slot 4', W); await W.press('a'); add('slot menu', W); await W.press('b'); await W.press('down', 'down'); add('team chip menu', W); await W.press('a'); add('team menu', W);
  await W.toPop('sort'); await W.press('a'); add('team sorted note', W);
  await chip(W, 'rules'); add('rules', W); await W.press('down'); add('rules item', W); await W.press('right'); add('rules note', W); await W.press('select'); add('rules note page 2', W); await W.press('left', 'b');
  await chip(W, 'check'); add('check legal', W); await W.press('b');
  await slot(W, 0); await W.press('a', 'a'); add('mon build', W); await W.toRow('level'); add('mon level', W); await W.press('a'); add('number menu', W); await W.press('a'); add('number entry', W); await W.type({ key: 'escape' });
  await W.toRow('gender'); add('mon gender', W); await W.toRow('nature'); add('mon nature', W); await W.toRow('ability'); add('mon ability', W); await W.toRow('item'); add('mon item', W); await W.toRow('problems'); add('mon rules ok', W);
  await W.press('r'); add('mon moves', W); await W.press('r'); add('mon stats', W); await W.press('r');
  await W.toRow('item'); await W.press('a'); add('items', W); await W.press('down', 'down', 'down'); add('items row', W); await W.press('y'); add('items filter', W); await W.press('b'); await W.press('a'); await W.toRow('item'); add('mon item set', W);
  await W.toRow('shiny'); await W.press('a'); add('mon shiny', W);
  await W.toRow('species'); await W.press('a'); add('species', W); await W.press('r', 'down'); add('species page', W); await W.press('right'); add('species chapter', W); await W.press('y'); add('species filter', W);
  await W.toPop('excluded'); await W.press('right'); await W.toPop('sort'); await W.press('right'); await W.press('b'); await W.press('up'); add('species excluded', W); await W.press('select'); add('species excluded page 2', W);
  await W.press('start'); add('find entry', W); await W.enter('char'); add('species found', W); await W.press('b');
  await W.press('b'); await W.press('b'); await W.press('down'); await W.press('a'); await slot(W, 0); add('team champs', W); await chip(W, 'check'); add('check problems', W); await W.press('down'); add('check row 2', W); await W.toRow('conform'); add('check convert', W);
  await W.press('b'); await slot(W, 1); await W.press('a', 'a'); await W.toRow('level'); add('mon level fixed', W); await W.toRow('problems'); add('mon problems', W);
  await W.press('b', 'b'); await W.press('down'); await W.press('a'); await slot(W, 0); add('team empty', W);
  // the bad-news tags
  const R = await mk(); const p = await seed(R.store, R.deps, 'OLD', [{ mons: ['Pikachu'] }]);
  await R.store.adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...p, schemaVersion: M.P.SCHEMA_VERSION + 1 }));
  await R.open(); await R.press('a'); await R.press('a'); add('team read-only', R);
  const N = await mk({ durable: false }); await N.open(); for (let i = 0; i < 40; i++) N.run(N.hub.tick()); add('not kept notice', N);
  // a record of a species this ROM lacks (a profile written for another ROM)
  const U = await mk(); await seed(U.store, U.deps, 'RED', [{ mons: ['Pikachu', 'Gengar'] }]); await U.open();
  U.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m, i) => (i === 0 ? { ...m, species: pack.species.length + 7 } : m)) } }));
  await U.press('a'); await U.press('a'); add('team unknown species', U); await U.press('a', 'a'); add('mon unknown species', U);
  await U.press('r'); add('moves unknown species', U); await U.press('r'); add('stats unknown species', U);
  // ---- stage 2: the portrait, the MOVES tab and the move picker, the STATS tab, undo, the team code, the test battle
  const X = await mk();
  await seed(X.store, X.deps, 'RED', [{ name: 'KANTO', mons: ['Pikachu', 'Charizard', 'Snorlax', 'Gengar', 'Mewtwo', 'Lapras'] }, { name: 'CHAMPS', then: CHAMP, mons: ['Pikachu', 'Sandy Shocks'] }, { name: 'EMPTY' }]);
  await X.open(); await X.press('right'); await X.toPop('x:portrait'); add('trainer menu portrait', X); await X.press('a'); add('portrait', X); await X.press('down', 'right'); add('portrait page 2', X); await X.press('up', 'left', 'left'); add('portrait last', X); await X.press('b');
  await X.press('a'); await X.toRow('x:code'); add('teams import row', X); await X.toRow('x:undo'); add('teams undo row', X);
  await X.toRow('t:' + X.profile().teams[0].id); await X.press('a'); await X.press('start'); await X.toPop('x:undo'); add('team menu undo', X); await X.press('b');
  await slot(X, 0); await X.press('a', 'a'); await X.press('r'); add('moves', X); await X.press('down'); add('moves add', X);
  await X.press('a'); add('move picker', X); await X.press('down', 'down', 'down'); add('move picker row', X); await X.press('r'); add('move picker page', X);
  await X.press('y'); add('move filter', X); await X.toPop('all'); await X.press('right'); add('move filter scrolled', X); await X.press('b'); await X.press('up'); add('move unlearnable', X);
  await X.press('y'); await X.toPop('clear'); await X.press('a'); await X.toPop('type'); await X.press('left'); add('move filter type', X); await X.toPop('clear'); await X.press('a'); await X.press('b');
  await X.press('start'); add('move find entry', X); await X.enter('thunder'); add('move found', X); await X.press('a'); add('moves two', X);
  await X.press('a'); add('move menu', X); await X.toPop('up'); await X.press('a'); add('move menu moved', X); await X.press('b'); await X.toRow('undo'); add('moves undo row', X);
  await X.press('r'); add('stats', X); await X.toRow('s:atk'); await X.hold('right', 63); add('stats atk 252', X); await X.toRow('s:spe'); await X.hold('right', 64); add('stats spe limited', X);
  await X.press('a'); add('stats number menu', X); await X.press('a'); add('stats number entry', X); await X.type({ key: 'escape' });
  await X.toRow('edit'); await X.press('right'); add('stats points', X); await X.press('right'); add('stats ivs', X); await X.toRow('s:atk'); await X.press('left'); add('stats iv atk', X);
  await X.toRow('hp'); add('stats hidden power', X); await X.press('a'); add('stats hp menu', X); await X.toPop('hp:Fire'); add('stats hp menu fire', X); await X.press('a'); add('stats hp set', X);
  await X.toRow('actions'); await X.press('a'); add('stats actions', X); await X.toPop('all0'); add('stats actions scrolled', X); await X.press('b'); await X.toRow('undo'); add('stats undo row', X);
  await X.press('r'); await X.toRow('undo'); add('build undo row', X); await X.press('a'); add('build undone', X); await X.press('b');
  await chip(X, 'x:code'); await X.idle(); add('code', X); await X.press('a'); await X.idle(); add('code copied', X);
  await X.toRow('paste'); await X.press('a'); await X.idle(); add('code preview', X); await X.press('down'); add('code preview cancel', X); await X.press('a');
  X.clip.text = 'hello there'; await X.toRow('paste'); await X.press('a'); await X.idle(); add('code refused', X); await X.toRow('enter'); await X.press('a'); add('code entry', X); await X.type({ key: 'escape' }); await X.press('b');
  await chip(X, 'x:test'); add('test', X); await X.toRow('foe'); await X.press('right'); add('test foe', X); await X.press('b');
  await X.press('b'); await X.toRow('t:' + X.profile().teams[1].id); await X.press('a'); await chip(X, 'x:test'); await X.press('a'); add('test refused', X); await X.press('b');
  await slot(X, 0); await X.press('a', 'a'); await X.press('r', 'r'); add('stats champions', X); await X.toRow('s:hp'); await X.press('right'); add('stats champions point', X); await X.press('b');
  await chip(X, 'check'); await X.toRow('conform'); await X.press('a'); add('check converted', X); await X.press('a'); add('check convert undone', X); await X.press('b');
  await chip(X, 'rules'); await X.toRow('undo'); add('rules undo row', X);
  // a code whose team has problems under its own rules
  const Y = await mk(); const yp = await seed(Y.store, Y.deps, 'RED', [{ name: 'CHAMPS', then: CHAMP, mons: ['Pikachu', 'Gengar', 'Snorlax'] }]);
  await Y.open(); await Y.press('a'); Y.clip.text = await M.TC.encodeTeamCode(M.TC.teamFromProfile(yp, yp.teams[0].id));
  await Y.toRow('x:code'); await Y.press('a'); add('code import', Y); await Y.toRow('paste'); await Y.press('a'); await Y.idle(); add('code preview problems', Y); await Y.press('select'); add('code preview problems page 2', Y);
  return out;
}

async function renderChecks() {
  const cat = await catalogue(SRC);
  const frames = cat.map(([name, v]) => [name, S0.screen.render(v), v]);
  { const bad = [];
    for (const [name, f, v] of frames) {
      if (f.width !== 240 || f.height !== 160 || f.rgba.length !== 240 * 160 * 4) bad.push(name + ': size');
      if (f.fault) bad.push(name + ': fault ' + f.fault.message);
      for (let i = 3; i < f.rgba.length; i += 4) if (f.rgba[i] !== 255) { bad.push(name + ': transparent pixel'); break; }
      const p = plain(v); if (p.length) bad.push(name + ': not plain JSON at ' + p[0]);
    }
    ok(cat.length >= 110 && bad.length === 0, 'R. all ' + cat.length + ' catalogued builder views are plain JSON and draw a full opaque 240x160 frame with no fault', bad.slice(0, 4).join('; '));
    const hs = frames.map(([n, f]) => [n, L.fnv(f.rgba)]), dup = hs.filter((x, i) => hs.findIndex((y) => y[1] === x[1]) !== i).map((x) => x[0]);
    ok(dup.length === 0, 'R. every catalogued view is a different picture', dup.join(','));
    ok(L.fnv(S0.screen.render(cat[5][1]).rgba) === hs[5][1], 'R. rendering is deterministic');
    if (SHOTS) { const { writePNG, scaleRGBA } = await import('./arena_png.mjs'); fs.mkdirSync(SHOTS, { recursive: true }); frames.forEach(([n, f], i) => { const s = scaleRGBA(240, 160, f.rgba, 3); writePNG(path.join(SHOTS, String(i + 1).padStart(2, '0') + '_' + n.replace(/[^a-z0-9]+/gi, '_') + '.png'), 720, 480, s.rgba || s); }); console.log('  wrote ' + frames.length + ' PNGs to ' + SHOTS); }
    // golden hashes
    const got = Object.fromEntries(hs);
    if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'hashes only (fnv1a of the 240x160 RGBA frame); regenerate with node tools/pokemonarena_builder_test.mjs --update', rom: 'Pokemon SoulGold v1.1.1', views: got }, null, 2) + '\n'); console.log('  builder.golden.json rewritten (' + hs.length + ' views)'); }
    const gold = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).views : null;
    ok(!!gold, 'R. the golden file exists (pokemonarena/builder.golden.json)');
    if (gold) {
      const badg = Object.keys(got).filter((k) => gold[k] !== got[k]);
      ok(badg.length === 0 && Object.keys(gold).length === hs.length, 'R. every golden frame hash matches (' + hs.length + ' views)', badg.slice(0, 5).map((k) => k + ' ' + gold[k] + ' != ' + got[k]).join('; '));
      const f2 = S0.screen.render(cat[5][1]); f2.rgba[4000] ^= 1;
      ok(L.fnv(f2.rgba) !== gold[cat[5][0]], 'R. control: flipping one bit of one pixel no longer matches the golden hash');
      ok(fs.statSync(GOLDEN).size < 9000 && !/\[(?:\s*\d{1,3},){40,}/.test(fs.readFileSync(GOLDEN, 'utf8')), 'R. the golden file is a short list of hashes: nothing made from the ROM is committed');
    }
  }
  // EVERY TEXT FITS ITS WINDOW: each text the renderer writes is handed back with the room it had (builder_screen.js measure)
  const fitsOf = (v) => { const bad = []; for (const x of S0.screen.app('builder').measure(S0.screen.frame(), v)) { if (x.cut) bad.push(x.what + ' cut: ' + x.s); else if (x.max !== null && x.px > x.max) bad.push(x.what + ' ' + x.px + ' > ' + x.max + ': ' + x.s); if (x.x < 0 || x.right > 240) bad.push(x.what + ' off the screen: ' + x.s); } for (const x of S0.screen.widths(v)) if (x.px > x.max) bad.push(x.what + ' ' + x.px + ' > ' + x.max); return bad; };
  { const bad = []; let n = 0;
    for (const [name, v] of cat) { n += S0.screen.app('builder').measure(S0.screen.frame(), v).length; for (const b of fitsOf(v)) bad.push(name + ': ' + b); }
    ok(n > 1500 && bad.length === 0, 'R. fit: every text of every catalogued view (' + n + ' texts) fits the room it is drawn in, uncut, and on the screen; every message line fits the message box', bad.slice(0, 4).join('; '));
  }
  // ... AT THE EXTREMES no fixture reaches
  const widest = (list, font = 'normal') => list.filter(Boolean).slice().sort((a, b) => ui.measure(font, ui.safeText(M.CS.displayText(b))) - ui.measure(font, ui.safeText(M.CS.displayText(a))))[0];
  {
    const bad = [];
    const W = await makeWorld();
    const names = pack.roster.map((id) => pack.species[id].name), wide5 = names.slice().sort((a, b) => ui.measure('normal', b) - ui.measure('normal', a)).slice(0, 6);
    const longNick = 'WWWWWWWWWW';
    await seed(W.store, W.deps, 'WWWWWWWWWW', [{ name: 'WWWWWWWWWWWWWWWW', then: CHAMP + '+item-clause+no-species-clause', mons: wide5 }, ...Array.from({ length: 15 }, () => ({ name: 'WWWWWWWWWWWWWWWW' }))]);
    await W.open(); bad.push(...fitsOf(W.view()).map((x) => 'trainers: ' + x)); await W.press('right'); bad.push(...fitsOf(W.view()).map((x) => 'trainer menu: ' + x)); await W.press('b');
    await W.press('a'); bad.push(...fitsOf(W.view()).map((x) => 'teams 16: ' + x)); await W.press('right'); bad.push(...fitsOf(W.view()).map((x) => 'teams menu: ' + x)); await W.press('b');
    await W.press('a');
    // every Pokemon: the widest names, a ten-W nickname, level 100, and as many problems as the rules find
    const tid = W.profile().teams[0].id;
    for (const id of W.profile().teams[0].monIds.slice(0, 2)) W.app.edit({ type: 'monSet', monId: id, field: 'nickname', value: longNick });
    bad.push(...fitsOf(W.view()).map((x) => 'team: ' + x));
    await W.press('a'); bad.push(...fitsOf(W.view()).map((x) => 'slot menu: ' + x)); await W.press('b'); await W.press('start'); bad.push(...fitsOf(W.view()).map((x) => 'team menu: ' + x)); await W.press('b');
    await W.press('down', 'down', 'down'); await W.press('a'); for (let i = 0; i < 3; i++) { bad.push(...fitsOf(W.view()).map((x) => 'rules: ' + x)); await W.press('down'); } await W.press('b');
    await W.press('right'); await W.press('a'); const total = W.b().list.total; for (let i = 0; i < total; i++) { for (let pg = 0; pg < W.b().pages; pg++) { bad.push(...fitsOf(W.view()).map((x) => 'check row ' + i + ': ' + x)); await W.press('select'); } await W.press('down'); } await W.press('b');
    ok(total >= 8 && bad.length === 0, 'R. fit at the extremes: a ten-W trainer, sixteen teams named with sixteen Ws, the six widest species of the ROM with ten-W nicknames, the longest ruleset name, and every page of every reason of ' + total + ' check rows all fit', bad.slice(0, 4).join('; '));
  }
  {
    // the BUILD tab's value column: EVERY ability, item, species and nature name of this ROM, in the room the row gives it (a synthetic row list through the real painter)
    const W = await makeWorld(); await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]); await W.open(); await W.press('a'); await W.press('a'); await W.press('a'); await W.press('a');
    const v0 = W.view(), bad = []; let n = 0;
    const tryRow = (label, kind, value) => { const v = JSON.parse(JSON.stringify(v0)); v.builder.list.rows = [{ id: 'x', kind, label, value }]; v.builder.list.cursor = 0; n++; for (const b of fitsOf(v)) bad.push(label + ' ' + value + ': ' + b); };
    for (const ab of pack.abilities) if (ab && ab.name) tryRow('ABILITY', 'choice', M.CS.displayText(ab.name));
    for (const it of pack.items) if (it && it.name && !/^\?+$/.test(it.name)) tryRow('ITEM', 'item', M.CS.displayText(it.name));
    for (const id of pack.roster) tryRow('SPECIES', 'item', pack.species[id].name);
    for (const na of pack.natures) tryRow('NATURE', 'choice', na.name);
    for (const val of ['WWWWWWWWWW']) tryRow('NICKNAME', 'item', val);
    for (const val of ['100', '255']) { tryRow('LEVEL', 'choice', val); tryRow('FRIENDSHIP', 'choice', val); }
    ok(n > 2400 && bad.length === 0, 'R. fit: all ' + n + ' values the BUILD tab can show (every ability, every named item, every roster species, every nature, a ten-W nickname, the largest numbers) fit beside their label, uncut (the longest: ' + widest(pack.abilities.map((a) => a && a.name)) + ', ' + widest(pack.items.map((a) => a && a.name)) + ')', bad.slice(0, 3).join('; '));
  }
  {
    // the pickers: every species row and every item row, and the message of every row
    const W = await makeWorld(); await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu'] }]); await W.open(); await W.press('a'); await W.press('a'); await W.press('right'); await W.press('a');
    await W.press('y'); await W.toPop('excluded'); await W.press('right'); await W.press('b');
    const bad = []; let rows = 0, pages = 0;
    const total = W.b().list.total;
    for (let i = 0; i < total; i += 7) { const v = W.view(); rows += v.builder.list.rows.length; for (const b of fitsOf(v)) bad.push('species page ' + i + ': ' + b); await W.press('r'); }
    await W.press('l'); for (let i = 0; i < 30; i++) await W.press('l');
    for (let i = 0; i < total; i++) { const v = W.view(); for (const x of S0.screen.widths(v)) if (x.px > x.max) bad.push('species msg ' + i + ': ' + v.msg.join('|')); pages = Math.max(pages, v.builder.pages); W.hub.press('down'); }
    await W.press('b'); await W.press('a'); await W.press('a'); await W.toRow('item'); await W.press('a'); await W.press('y'); await W.press('right'); await W.toPop('excluded'); await W.press('right'); await W.press('b');
    const itotal = W.b().list.total; let irows = 0, ipages = 0, multi = 0;
    for (let i = 0; i < itotal; i++) {
      const v = W.view(); if (i % 7 === 0) { irows += v.builder.list.rows.length; for (const b of fitsOf(v)) bad.push('item page ' + i + ': ' + b); }
      for (let pg = 0; pg < v.builder.pages; pg++) { for (const x of S0.screen.widths(W.view())) if (x.px > x.max) bad.push('item msg ' + i + ': ' + W.view().msg.join('|')); W.hub.press('select'); }
      ipages = Math.max(ipages, v.builder.pages); if (v.builder.pages > 1) multi++;
      W.hub.press('down');
    }
    ok(rows >= total && total > 1030 && irows >= itotal / 7 && itotal > 900 && bad.length === 0, 'R. fit: all ' + total + ' species rows and all ' + itotal + ' item rows fit their list, and the message of every one fits the message box on every page (' + multi + ' item descriptions need a second page, none more than ' + ipages + '; a species message at most ' + pages + ')', bad.slice(0, 3).join('; '));
  }
  // STAGE 2 AT THE EXTREMES no fixture reaches
  {
    const bad = [], seen = { moves: 0, pickerRows: 0, pickerMsgs: 0, stats: 0, menus: 0, portraits: 0 };
    const allPages = (W, tag) => { const n = W.b().pages; for (let pg = 0; pg < n; pg++) { for (const x of S0.screen.widths(W.view())) if (x.px > x.max) bad.push(tag + ' msg: ' + W.view().msg.join('|')); W.hub.press('select'); } };
    const take = (W, tag) => { for (const b of fitsOf(W.view())) bad.push(tag + ': ' + b); };
    const rowAt = (W) => W.b().list.rows[W.b().list.cursor];
    const wideMoves = pack.moves.map((mv, id) => (mv && mv.name && mv.name !== '-' ? id : 0)).filter(Boolean).sort((a, b) => ui.measure('normal', M.CS.displayText(pack.moves[b].name)) - ui.measure('normal', M.CS.displayText(pack.moves[a].name))).slice(0, 4);
    const W = await makeWorld();
    await seed(W.store, W.deps, 'WWWWWWWWWW', [{ name: 'WWWWWWWWWWWWWWWW', ruleset: STD + '+lv100', mons: ['Blissey', 'Pikachu'] }, { name: 'MMMMMMMMMMMMMMMM', mons: ['Gengar'] }]);
    await W.open(); await W.press('a'); await W.press('a'); await W.press('a'); await W.press('a');
    const mid = W.profile().teams[0].monIds[0];
    W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m) => (m.id === mid ? { ...m, level: 100, nickname: 'WWWWWWWWWW', moves: wideMoves.map((id) => ({ id, ppUps: 0 })), ev: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 } } : m)) } }));
    // the MOVES tab: the four widest names, each highlighted in turn, then UNDO / REDO; the menu titled with the widest
    await W.press('r');
    for (let i = 0; i < 6; i++) { take(W, 'moves row ' + i); allPages(W, 'moves row ' + i); seen.moves++; await W.press('down'); }
    await W.press('a'); take(W, 'move menu'); seen.menus++;
    // the move picker with every move of the ROM listed: every page of rows, the foot line and the message (all its pages) of every row
    await W.press('a'); await W.press('y'); await W.toPop('all'); await W.press('right');
    for (let i = 0; i < 10; i++) { take(W, 'move filter ' + i); await W.press('down'); }
    await W.press('b');
    const total = W.b().list.total;
    for (let i = 0; i < total; i += 6) { take(W, 'move page ' + i); seen.pickerRows += W.b().list.rows.length; W.hub.press('r'); }
    for (let i = 0; i < 200; i++) W.hub.press('l');
    for (let i = 0; i < total; i++) { const v = W.view(); if (v.builder.pages > 1) allPages(W, 'move ' + i); else for (const x of S0.screen.widths(v)) if (x.px > x.max) bad.push('move msg ' + i + ': ' + v.msg.join('|')); seen.pickerMsgs++; W.hub.press('down'); }
    await W.press('b');
    // the STATS tab of the species with the largest stat, at level 100, every number at its largest: each row in each view, each numbers pop-up and its entry, the type list, the quick actions
    await W.press('r');
    const biggest = Math.max(...W.b().list.rows.filter((r) => r.stat).map((r) => Number(r.value)));
    for (const mode of ['ev', 'points', 'iv']) {
      for (let i = 0; i < 11; i++) {
        take(W, 'stats ' + mode + ' row ' + i); allPages(W, 'stats ' + mode + ' row ' + i); seen.stats++;
        if (rowAt(W) && rowAt(W).stat) { await W.press('a'); for (let k = 0; k < 6; k++) { take(W, 'stats ' + mode + ' numbers ' + i); await W.press('down'); } seen.menus++; await W.toPop('type'); await W.press('a'); take(W, 'stats ' + mode + ' entry ' + i); await W.type({ key: 'escape' }); }
        await W.press('down');
      }
      await W.toRow('edit'); await W.press('right');
    }
    await W.toRow('hp'); await W.press('a'); for (let i = 0; i < 16; i++) { take(W, 'hp menu ' + i); await W.press('down'); } await W.press('b');
    await W.press('start'); for (let i = 0; i < 7; i++) { take(W, 'quick ' + i); await W.press('down'); } await W.press('b');
    // over the budget (a record from elsewhere): the Champions points, overdrawn
    await W.press('b');
    W.app.edit({ type: 'teamRuleset', teamId: W.profile().teams[0].id, ruleset: CHAMP });
    W.app.mapEditor((s) => ({ ...s, profile: { ...s.profile, box: s.profile.box.map((m) => (m.id === mid ? { ...m, ev: { hp: 252, atk: 252, def: 252, spa: 252, spd: 252, spe: 252 } } : m)) } }));
    await W.press('a'); await W.press('a'); await W.press('r'); await W.press('r'); await W.toRow('edit'); const over = W.b().list.rows[0].budget || null; take(W, 'stats over'); allPages(W, 'stats over');
    // the code: the preview of a sixteen-W team with problems (every page), and the same name as a foe
    await W.press('b'); const code = await M.TC.encodeTeamCode(M.TC.teamFromProfile(W.profile(), W.profile().teams[0].id));
    { const c = W.b().chips.find((x) => x.id === 'x:code'); await W.click(c.x + 4, c.y + 4); await W.idle(); } take(W, 'code'); allPages(W, 'code');
    W.clip.text = code; await W.toRow('paste'); await W.press('a'); await W.idle(); take(W, 'code preview'); allPages(W, 'code preview'); const previewPages = W.b().pages; await W.press('b'); await W.press('b');
    await W.press('b'); await W.toRow('t:' + W.profile().teams[1].id); await W.press('a');
    { const c = W.b().chips.find((x) => x.id === 'x:test'); await W.click(c.x + 4, c.y + 4); } await W.toRow('foe'); await W.press('right'); const foe = W.row().value; take(W, 'test foe'); await W.toRow('start'); take(W, 'test start'); await W.press('a'); take(W, 'test refused'); allPages(W, 'test refused');
    // every page of the portraits
    await W.press('b'); await W.press('b'); await W.press('b'); await W.press('right'); await W.toPop('x:portrait'); await W.press('a');
    for (let i = 0; i < 18; i++) { take(W, 'portrait page ' + i); seen.portraits += W.b().cells.length; await W.press('down'); }
    ok(biggest === 714 && over && over.bad === true && / OVER 66$/.test(over.text) && foe === 'WWWWWWWWWWWWWWWW' && previewPages >= 2 && seen.pickerRows >= total && total > 900 && seen.pickerMsgs === total && seen.portraits === 52 && seen.stats === 33 && W.hub.faults().length === 0 && bad.length === 0,
      'R. fit at the extremes of stage 2: the four widest move names of the ROM on the MOVES tab; all ' + total + ' rows of the move picker with the unlearnable moves listed, the foot line and every page of the message of each; the STATS tab of Blissey at level 100 (HP ' + biggest
      + ') in its three views, each numbers pop-up and its text entry, the sixteen types, the quick actions, an overdrawn budget; a sixteen-W team in the code preview (' + previewPages + ' pages) and as a foe; all 52 portraits', bad.slice(0, 4).join('; ') + ' ' + J(seen) + ' ' + J(over) + ' ' + foe);
  }
  // PROVENANCE: the pictures are the ROM's. Zero the bytes a piece of art is read from and the picture changes; a byte-identical copy of the ROM draws the identical picture.
  {
    const SG = await L.mod('speciesgfx.js');
    const view = (name) => cat.find((x) => x[0] === name)[1];
    const draw = (bytes, v) => L.fnv(M.HS.createHubScreen(M.BU.createBattleUi(bytes)).render(v).rgba);
    const zap = (v, off, len) => { const z = rom.slice(); z.fill(0, off, off + len); return draw(z, v); };
    const mon = view('mon build'), team = view('team full'), tr = view('trainers'), sp = view('species');
    const hMon = L.fnv(S0.screen.render(mon).rgba), hTeam = L.fnv(S0.screen.render(team).rgba), hTr = L.fnv(S0.screen.render(tr).rgba), hSp = L.fnv(S0.screen.render(sp).rgba);
    ok(draw(rom.slice(), mon) === hMon && draw(rom.slice(), team) === hTeam, 'R. twin: a byte-identical copy of the ROM gives the identical pictures');
    ok(zap(mon, 0x6cd02c, 32) !== hMon && zap(mon, 0x73a130, 32) !== hMon, 'R. provenance: zeroing the ROM\'s text colours, or its textbox palette, changes the Pokemon screen (the words and the message box are the ROM\'s)');
    const rec = SG.speciesRecord(rom, mon.builder.mon.species);
    ok(zap(mon, rec.pal, 32) !== hMon && zap(mon, rec.front, 64) !== hMon, 'R. provenance: zeroing the palette or the first bytes of the species\' front picture changes the Pokemon screen (the sprite is the ROM\'s)');
    ok(zap(mon, 0x6a3e98, 96) !== hMon, 'R. provenance: zeroing the ROM\'s type-badge palettes changes the Pokemon screen (the badges are the ROM\'s)');
    const lead = SG.speciesRecord(rom, team.builder.slots[0].species);
    ok(zap(team, lead.icon, 256) !== hTeam, 'R. provenance: zeroing the lead\'s party-icon bytes changes the team screen (the icons are the ROM\'s)');
    ok(zap(team, M.BU.PARTY_ART.palette, 64) !== hTeam, 'R. provenance: zeroing the ROM\'s party-menu palette changes the team screen (the slot panels, the chips and the teal are the ROM\'s)');
    ok(zap(tr, SG.TRAINER_HEAD_TABLE, 16 * 52) !== hTr, 'R. provenance: zeroing the ROM\'s trainer-head table changes the trainers screen (the portrait is the ROM\'s)');
    const first = SG.speciesRecord(rom, sp.builder.side.species);
    ok(zap(sp, first.pal, 32) !== hSp, 'R. provenance: zeroing the highlighted species\' palette changes the species picker');
    // stage 2: the category icons, the type badges of the moves, the HP-bar tiles of the stat bars, the trainer heads of the portrait picker
    const man = ui.assets.manifest(), offs = (key) => man.find((x) => x.key === key).offsets;
    const mv = view('moves'), pk = view('move picker'), stv = view('stats atk 252'), po = view('portrait'), hp = view('stats hidden power');
    const h = (v) => L.fnv(S0.screen.render(v).rgba);
    ok(zap(mv, offs('icon.category').palette, 32) !== h(mv) && zap(pk, offs('icon.category').palette, 32) !== h(pk), 'R. provenance: zeroing the palette of the ROM\'s category icons changes the MOVES tab and the move picker (the icons are the ROM\'s)');
    ok(zap(mv, 0x6a3e98, 96) !== h(mv) && zap(pk, 0x6a3e98, 96) !== h(pk) && zap(hp, 0x6a3e98, 96) !== h(hp), 'R. provenance: zeroing the ROM\'s type-badge palettes changes the MOVES tab, the move picker and the HIDDEN POWER line (the badges are the ROM\'s)');
    ok(zap(stv, offs('healthbox.hpGreen').palette, 32) !== h(stv) && ['healthbox.hpGreen', 'healthbox.hpYellow', 'healthbox.hpRed'].some((k) => zap(stv, offs(k).tiles, 32 * 9) !== h(stv)), 'R. provenance: zeroing the palette, or the tiles, of the ROM\'s HP bar changes the STATS tab (the stat bars are built from the ROM\'s tiles)');
    ok(zap(po, SG.TRAINER_HEAD_TABLE, 16 * 52) !== h(po), 'R. provenance: zeroing the ROM\'s trainer-head table changes the portrait picker (the heads are the ROM\'s)');
    ok(draw(rom.slice(), stv) === h(stv) && draw(rom.slice(), pk) === h(pk), 'R. twin: a byte-identical copy of the ROM gives the identical STATS tab and move picker');
  }
  {
    // the picture says what the model says: the number being edited is dark and the other grey; a nature's arrows; a move that cannot be taken is grey; the cell under the cursor in the portraits
    const cv = (name) => JSON.parse(JSON.stringify(cat.find((x) => x[0] === name)[1])), h = (v) => L.fnv(S0.screen.render(v).rgba);
    const st0 = cv('stats atk 252'), h0 = h(st0), alt = (fn) => { const c = cv('stats atk 252'); fn(c.builder.list.rows); return h(c); };
    ok(alt((r) => { r[2].live = 'iv'; }) !== h0 && alt((r) => { r[2].nat = 1; }) !== h0 && alt((r) => { r[3].nat = -1; }) !== h0 && alt((r) => { r[2].bar.value = 1; }) !== h0 && alt((r) => { r[0].budget.bad = true; }) !== h0 && alt((r) => { r[0].value = 'IVS'; }) !== h0,
      'R. the STATS picture changes with the number being edited (dark, between the arrows), the nature\'s arrows, a bar\'s fill, an overdrawn budget and the EDIT value');
    const p0 = cv('move picker'), dim = cv('move picker'); dim.builder.list.rows[1].dim = true; const noTag = cv('move picker'); noTag.builder.list.rows[1].tag = '';
    const po0 = cv('portrait'), po1 = cv('portrait'); po1.builder.cells[0].on = false; po1.builder.cells[1].on = true; const po2 = cv('portrait'); po2.builder.cells[0].used = false;
    ok(h(dim) !== h(p0) && h(noTag) !== h(p0) && h(po1) !== h(po0) && h(po2) !== h(po0), 'R. a move that cannot be taken is drawn grey, a row shows where its move comes from, and the portrait picker shows the cursor and the portrait in use');
    // SPEED: a key in the move picker with every move of the ROM listed (the press, the view, the frame)
    const W = await makeWorld(); await seed(W.store, W.deps, 'RED', [{ mons: ['Mew'] }]); await W.open(); await W.press('a'); await W.press('a'); await W.press('a'); await W.press('a'); await W.press('r'); await W.press('down'); await W.press('a');
    await W.press('y'); await W.toPop('all'); await W.press('right'); await W.press('b');
    const fresh = M.HS.createHubScreen(ui); fresh.render(W.view());
    const t0 = performance.now(); let worst = 0;
    for (let i = 0; i < 200; i++) { const a = performance.now(); W.hub.press(i % 9 === 8 ? 'right' : i % 9 === 7 ? 'r' : 'down'); fresh.render(W.view()); worst = Math.max(worst, performance.now() - a); }
    const avg = (performance.now() - t0) / 200;
    console.log('  move picker (' + W.b().list.total + ' moves): a key (press + view + frame) takes ' + avg.toFixed(2) + ' ms on average, ' + worst.toFixed(1) + ' ms at worst, in Node on this machine');
    ok(avg < 12 && W.b().list.total > 900, 'R. speed: a key in the move picker with all ' + W.b().list.total + ' moves listed (press, view and frame) averages under 12 ms in Node (' + avg.toFixed(2) + ' ms; worst ' + worst.toFixed(1) + ' ms)');
  }
  {
    // an excluded row is greyed, a problem is red, the highlighted slot and tab are the selected panel: the picture says so
    const W = await makeWorld(); await seed(W.store, W.deps, 'RED', [{ mons: ['Pikachu', 'Gengar'] }]); await W.open(); await W.press('a'); await W.press('a');
    const v = W.view(), h0 = L.fnv(S0.screen.render(v).rgba);
    const alt = (fn) => { const c = JSON.parse(JSON.stringify(v)); fn(c.builder); return L.fnv(S0.screen.render(c).rgba); };
    ok(alt((b) => { b.cursor = 1; }) !== h0 && alt((b) => { b.slots[1].problems = 2; }) !== h0 && alt((b) => { b.status = { text: 'LEGAL', bad: true }; }) !== h0 && alt((b) => { b.tag = { text: 'NOT SAVED', bad: true }; }) !== h0 && alt((b) => { b.slots[0].shiny = true; }) !== h0,
      'R. the team picture changes with the highlighted slot, a problem mark, a bad status, the autosave tag and a shiny Pokemon (its ROM shiny palette)');
    { const r = W.hub.rects()[2]; await W.click(r.x + 40, r.y + 8); }
    const pv = W.view(), p0 = L.fnv(S0.screen.render(pv).rgba), dim = JSON.parse(JSON.stringify(pv)); dim.builder.list.rows[1].dim = true;
    ok(L.fnv(S0.screen.render(dim).rgba) !== p0, 'R. a row the rules leave out is drawn differently (the ROM\'s grey)');
    // LAZY ART: the species picker decodes the highlighted sprite and nothing else
    const fresh = M.HS.createHubScreen(ui), before = 0;
    fresh.render(pv); const afterOne = fresh.app('builder').art().cacheSize();
    for (let i = 0; i < 40; i++) { W.hub.press('down'); fresh.render(W.view()); }
    const after41 = fresh.app('builder').art().cacheSize();
    ok(afterOne <= 4 && after41 <= 24 + 26 && before === 0, 'R. lazy art: the first picker frame decodes ' + afterOne + ' pictures (one sprite and its badges), and 41 rows walked leave ' + after41 + ' in the cache (the art kit keeps the last 24 sprites and the type badges, never the whole roster)', afterOne + ' ' + after41);
    // SPEED: a key in the species picker (the press, the view, the frame)
    const t0 = performance.now(); let worst = 0;
    for (let i = 0; i < 200; i++) { const a = performance.now(); W.hub.press(i % 9 === 8 ? 'right' : 'down'); fresh.render(W.view()); worst = Math.max(worst, performance.now() - a); }
    const avg = (performance.now() - t0) / 200;
    console.log('  species picker: a key (press + view + frame) takes ' + avg.toFixed(2) + ' ms on average, ' + worst.toFixed(1) + ' ms at worst, in Node on this machine (a frame is 16.7 ms)');
    ok(avg < 12, 'R. speed: a key in the species picker (press, view and frame) averages under 12 ms in Node (' + avg.toFixed(2) + ' ms; worst ' + worst.toFixed(1) + ' ms)');
  }
  {
    // A RANDOM WALK through the builder: what no scripted check thought of (the first walks found a picker title that did not fit and an UNDO that faulted). Presses (some the repeat of a held
    // direction), taps and hovers anywhere in the picture, the wheel, words typed into whatever entry is open, an answer to whatever question is asked, Ctrl+Z / Ctrl+Y, the autosave's timer, a
    // clipboard that sometimes refuses. After EVERY input: no fault, a plain view, a whole frame, words for the screen reader, and every text inside the room it is drawn in.
    const bad = [], kinds = new Set(); let steps = 0;
    const ACTS = ['up', 'down', 'left', 'right', 'a', 'a', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select', 'down', 'down', 'right', 'a'];
    const WORDS = ['thunder', 'A', '12', '300', 'ARENA1.abc.def', 'pika', '0', 'Zz'];
    for (const sd of [11, 12, 31]) {
      let n = sd; const rnd = (k) => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return Math.floor((n / 4294967296) * k); };
      const W = await makeWorld({ seed: sd });
      await seed(W.store, W.deps, 'BLUE', [], { active: false });
      await seed(W.store, W.deps, 'RED', [{ name: 'KANTO', mons: ['Pikachu', 'Charizard', 'Snorlax', 'Gengar', 'Mewtwo', 'Lapras'] }, { name: 'CHAMPS', mons: ['Pikachu', 'Gengar'], then: CHAMP }, { name: 'EMPTY' }]);
      await W.open();
      const trail = [];
      for (let i = 0; i < 2000 && bad.length < 4; i++) {
        const r = rnd(100); let what = '';
        try {
          if (W.hub.dialog.isOpen()) { what = rnd(3) === 0 ? 'b' : rnd(2) ? 'a' : 'down'; W.run(W.hub.press(what)); what = '?' + what; }
          else if (W.hub.wantsText() && r < 55) { const k = rnd(8); if (k < 3) { what = WORDS[rnd(WORDS.length)]; W.run(W.hub.type({ text: what })); what = '"' + what + '"'; } else { what = k < 5 ? 'enter' : k < 6 ? 'escape' : 'backspace'; W.run(W.hub.type({ key: what })); } }
          else if (r < 62) { what = ACTS[rnd(ACTS.length)]; W.run(W.hub.press(what, { repeat: rnd(6) === 0 })); }
          else if (r < 84) { const x = rnd(240), y = rnd(160), kind = rnd(4) === 0 ? 'move' : 'click'; what = kind + '@' + x + ',' + y; W.run(W.hub.pointer({ kind, x, y })); }
          else if (r < 88) { const k = rnd(7) - 3; what = 'wheel' + k; W.run(W.hub.pointer({ kind: 'wheel', steps: k })); }
          else if (r < 94) { const k = rnd(3); what = 'ctrl+' + 'zyZ'[k]; await W.key({ ctrlKey: true, key: k === 1 ? 'y' : 'z', shiftKey: k === 2 }); }
          else if (r < 96) { what = 'timers'; await W.fire(); }
          else if (r < 98) { what = 'tick'; W.run(W.hub.tick([])); }
          else { what = 'clipboard'; if (rnd(2)) W.clip.text = 'garbage'; W.clip.refuse.read = rnd(4) === 0; W.clip.refuse.write = rnd(4) === 0; }
          trail.push(what); steps++;
          await W.idle();
          W.log.navigated.length = 0;                                                                        // (a test battle "left the page": the walk goes on)
          if (!W.app.paths.includes(W.path())) await W.goto(W.app.paths[rnd(W.app.paths.length)]);          // (B on the trainers left the builder: back in by an address, any of the twelve)
          const v = W.hub.view(), f = W.screen.render(v), say = (m) => bad.push('seed ' + sd + ', input ' + i + ': ' + m + ' on ' + W.path() + ' after ' + trail.slice(-8).join(' '));
          if (plain(v).length) say('the view is not plain JSON (' + plain(v)[0] + ')');
          if (f.fault || f.rgba.length !== 240 * 160 * 4) say('the frame faulted');
          const faults = W.hub.faults(); if (faults.length) say('fault ' + J(faults[0]));
          if (W.log.failed) { say('the ctl failed: ' + W.log.failed); W.log.failed = undefined; }
          if (typeof W.app.speak(v) !== 'string') say('speak() gave no words');
          if (!v.dialog && !v.entry && v.builder) { const x = W.texts(v).find((q) => q.cut || (q.max !== null && q.px > q.max) || q.right > 240 || q.x < 0); if (x) say('a text does not fit: ' + J(x)); }
          if (v.builder) kinds.add(v.builder.kind + ':' + (v.builder.layout || '') + ':' + (v.builder.popup ? String(v.builder.popup.id).split(':')[0] : '') + (v.entry ? ':entry' : '') + (v.dialog ? ':dialog' : ''));
        } catch (e) { bad.push('seed ' + sd + ', input ' + i + ' (' + what + ') threw ' + (e && e.message ? e.message : e) + ' after ' + trail.slice(-8).join(' ')); }
      }
      await W.saved();
    }
    ok(steps >= 6000 && kinds.size >= 30 && bad.length === 0, 'R. a random walk of ' + steps + ' inputs through the builder (presses and held directions, taps, the wheel, typing, answers, Ctrl+Z / Ctrl+Y, the autosave, a clipboard that sometimes refuses; ' + kinds.size + ' different screens, menus and entries met) raises no fault, keeps every view plain, draws every frame, words every screen and keeps every text in its room', bad.slice(0, 3).join(' ;; ').slice(0, 900));
  }
}

/* ================================================================================================ mutants */
// { group, file, name, find, replace, expect }: the text `find` occurs ONCE in pokemonarena/js/<file>; with it replaced, the check whose name contains `expect` (in group `group`) must fail.
const MUTANTS = [
  // ---- the router
  { group: 'A', file: 'builder_hub.js', name: 'an edit is not told to the ctl', find: "if (next.seq !== prev.seq) pending.push({ app: ID, type: 'edited' });", replace: '', expect: 'an edit asks the ctl to save' },
  { group: 'B', file: 'builder_hub.js', name: 'the reducer\'s refusal is not shown', find: "if (next.error) flash(sentence(next.error.message), true); else if (next.notice)", replace: 'if (next.notice)', expect: 'refused in the reducer\'s own words' },
  { group: 'A', file: 'builder_hub.js', name: 'a screen without its profile is shown anyway', find: "    if (!S.ed) return ID;\n", replace: '', expect: 'settles on the nearest screen' },
  { group: 'A', file: 'builder_hub.js', name: 'a screen whose team is gone is shown anyway', find: "      if (!team()) return 'builder-teams';\n", replace: '', expect: 'whose team is gone' },
  { group: 'A', file: 'builder_hub.js', name: 'a screen whose Pokemon is gone is shown anyway', find: "      if (d.need === 'mon' && !mon()) return 'builder-team';\n", replace: '', expect: 'whose team is gone' },
  { group: 'A', file: 'builder_hub.js', name: 'a closed screen keeps its text entry', find: "      entry.close(); popup.close();                                     // a screen that closes", replace: "      popup.close();                                     // a screen that closes", expect: 'takes its text entry and its pop-up with it' },
  // ---- ONE way to make a trainer (INAPP.md TRAINER decision 4): NEW TRAINER is the trainer app's screens; the builder follows a trainer made there
  { group: 'B', file: 'builder_home.js', name: 'NEW TRAINER opens nothing', find: "const newTrainer = () => X.go('trainer-new');", replace: 'const newTrainer = () => [];', expect: 'NEW TRAINER opens the trainer app' },
  { group: 'B', file: 'builder_hub.js', name: 'a data refresh never asks the ctl to follow a trainer made elsewhere', find: "return fresh || moved ? [{ app: ID, type: 'sync' }] : [];", replace: 'return [];', expect: 'a trainer made while the builder is open' },
  { group: 'B', file: 'builder_hub.js', name: 'every data refresh asks the ctl to follow (a refresh after the builder\'s own save would reload the profile)', find: "return fresh || moved ? [{ app: ID, type: 'sync' }] : [];", replace: "return [{ app: ID, type: 'sync' }];", expect: 'a trainer made while the builder is open' },
  { group: 'B', file: 'builder_ctl.js', name: 'the sync reads the list but does not open the active trainer', find: "if (active && (!S || S.profile.id !== active) && list.some((t) => t.id === active && !t.unreadable)) {", replace: 'if (false) {', expect: 'a trainer made while the builder is open' },
  { group: 'A', file: 'builder_hub.js', name: 'a closed screen keeps its question', find: "      for (const id of asks.keys()) ctx.dialog.close(id);\n", replace: '', expect: 'leaving closes the builder\'s own question' },
  { group: 'A', file: 'builder_hub.js', name: 'A acts under an unread note', find: 'if (m.first && m.page < m.pages.length - 1) { S.pager = { key: m.key, page: m.page + 1 }; return out([]); }', replace: '', expect: 'A reads a long note to its end' },
  { group: 'A', file: 'builder_hub.js', name: 'the list under a pop-up hears the presses', find: 'const pfx = popup.press(action); if (pfx) { dropStale(); return out(pfx); }', replace: 'popup.press(action);', expect: 'a pop-up menu takes every press' },
  { group: 'A', file: 'builder_hub.js', name: 'SELECT does not turn the page', find: "if (action === 'select') { turnPage(path, true); return out([]); }", replace: "if (action === 'select') return out([]);", expect: 'SELECT and a tap on the message box' },
  { group: 'A', file: 'builder_hub.js', name: 'a pointer passing over clears the note', find: "if (S.flash && JSON.stringify(s.state()) !== before) S.flash = null;", replace: 'S.flash = null;', expect: 'a note stays while a pointer only passes' },
  { group: 'A', file: 'builder_hub.js', name: 'the model answers presses before it is ready', find: "if (S.phase !== 'ready' || target(path)) return out(action === 'b' ? ctx.back() : []);", replace: "if (S.phase !== 'ready' || target(path)) return out(ctx.back());", expect: 'takes no press but B' },
  { group: 'B', file: 'builder_hub.js', name: 'the read-only tag is not shown', find: "if (S.ed.readOnly) return { text: 'READ-ONLY', bad: true };", replace: '', expect: 'shows READ-ONLY' },
  { group: 'G', file: 'builder_hub.js', name: 'the CHANGED tag is not shown', find: "if (S.flags.conflict) return { text: 'CHANGED', bad: true };", replace: '', expect: 'the tag reads CHANGED' },
  { group: 'B', file: 'builder_hub.js', name: 'a question starts on YES', find: "cursor: spec.cursor === undefined ? options.length - 1 : spec.cursor", replace: 'cursor: spec.cursor === undefined ? 0 : spec.cursor', expect: 'DELETE asks first and starts on NO' },
  // ---- trainers and teams
  { group: 'B', file: 'builder_home.js', name: 'another trainer is shown without being loaded', find: "const open = (id) => (id === X.activeId() ? X.go('builder-teams') : [X.eff('profile-open', { id })]);", replace: "const open = (id) => X.go('builder-teams');", expect: 'asks the ctl to open it' },
  { group: 'B', file: 'builder_home.js', name: 'NO deletes the trainer', find: "(v) => (v === 0 ? [X.eff('profile-delete', { id: t.id })] : []));", replace: "() => [X.eff('profile-delete', { id: t.id })]);", expect: 'NO (and B) keep the trainer' },
  { group: 'B', file: 'builder_home.js', name: 'the active trainer is renamed past the reducer', find: "if (t.id === X.activeId()) { X.dispatch({ type: 'rename', name }); return []; }", replace: '', expect: 'the active trainer is renamed by the reducer' },
  { group: 'B', file: 'builder_home.js', name: 'the trainer menu opens on a row that is no trainer', find: "    if (!t || t.unreadable) return [];\n    X.popup.open({\n      id: 'trainer', title: t.name,", replace: "    X.popup.open({\n      id: 'trainer', title: t ? t.name : '',", expect: 'not on a row that is no trainer' },
  { group: 'C', file: 'builder_home.js', name: 'NEW TEAM is offered at the limit', find: "const full = () => teams().length >= ES().EDITOR_LIMITS.teamsMax;", replace: 'const full = () => false;', expect: 'reads TEAM LIMIT REACHED' },
  { group: 'C', file: 'builder_home.js', name: 'REMOVE UNUSED is always there', find: "if (unused() > 0) out.push({ id: 'unused', kind: 'button', label: 'REMOVE UNUSED' });", replace: "out.push({ id: 'unused', kind: 'button', label: 'REMOVE UNUSED' });", expect: 'REMOVE UNUSED appears only when' },
  { group: 'C', file: 'builder_home.js', name: 'NO deletes the team', find: "(v) => { if (v === 0) X.dispatch({ type: 'teamDelete', teamId: t.id }); return []; });\n    return [];\n  }\n  const MENU_HELP = {\n    open:", replace: "() => { X.dispatch({ type: 'teamDelete', teamId: t.id }); return []; });\n    return [];\n  }\n  const MENU_HELP = {\n    open:", expect: 'DELETE (a team) asks first' },
  { group: 'C', file: 'builder_home.js', name: 'MOVE DOWN moves up', find: "case 'down': X.dispatch({ type: 'teamMove', teamId: tid, to: i + 1 }); seek(tid); return [];", replace: "case 'down': X.dispatch({ type: 'teamMove', teamId: tid, to: i - 1 }); seek(tid); return [];", expect: 'MOVE UP / MOVE DOWN' },
  { group: 'C', file: 'builder_home.js', name: 'the cursor does not follow a moved team', find: "case 'up': X.dispatch({ type: 'teamMove', teamId: tid, to: i - 1 }); seek(tid); return [];", replace: "case 'up': X.dispatch({ type: 'teamMove', teamId: tid, to: i - 1 }); return [];", expect: 'MOVE UP / MOVE DOWN' },
  { group: 'C', file: 'builder_home.js', name: 'a new team is not opened', find: "    seek(r.result.teamId);\n    return openTeam(r.result.teamId);", replace: "    seek(r.result.teamId);\n    return [];", expect: 'NEW TEAM makes TEAM 1 through the reducer and opens it' },
  { group: 'C', file: 'builder_home.js', name: 'a team with problems is marked OK', find: "const tagOf = (c) => (c.status === 'empty' ? '--' : c.status === 'legal' ? 'OK' : '!' + Math.min(c.count, 99));", replace: "const tagOf = (c) => (c.status === 'empty' ? '--' : 'OK');", expect: 'Legal / N problems for a team' },
  // ---- the team, the rules, the check
  { group: 'D', file: 'builder_team.js', name: 'an empty slot does not open the picker', find: "    return monAt(cur) ? slotMenu(cur) : addMon();", replace: "    return monAt(cur) ? slotMenu(cur) : [];", expect: 'A on an empty slot opens the species picker' },
  { group: 'D', file: 'builder_team.js', name: 'REMOVE does not ask', find: "X.ask({ id: 'remove-mon', text: 'Take ' + name + ' out of ' + team().name + '?' }, (v) => { if (v === 0) X.dispatch({ type: 'monRemove', teamId: tid, monId: mid }); return []; }); return [];", replace: "X.dispatch({ type: 'monRemove', teamId: tid, monId: mid }); return [];", expect: 'REMOVE (a Pokemon) asks first' },
  { group: 'D', file: 'builder_team.js', name: 'LATER moves earlier', find: "case 'later': X.dispatch({ type: 'monMove', teamId: tid, monId: mid, to: where() + 1 });", replace: "case 'later': X.dispatch({ type: 'monMove', teamId: tid, monId: mid, to: where() - 1 });", expect: 'EARLIER / LATER reorder' },
  { group: 'D', file: 'builder_team.js', name: 'deleting the team stays on its screen', find: "return r && !r.error ? X.go('builder-teams') : []; });", replace: 'return []; });', expect: 'the team menu opens on START' },
  { group: 'D', file: 'builder_team.js', name: 'the chip row is not reached by DOWN', find: "else cur = r === 2 ? SLOTS + Math.min(nc - 1, Math.round(c * (nc - 1))) : cur + COLS;", replace: "else cur = r === 2 ? cur : cur + COLS;", expect: 'the d-pad walks two columns' },
  { group: 'D', file: 'builder_team.js', name: 'back from RULES jumps the cursor to a slot', find: "if (t && at.monId && cur < SLOTS) {", replace: 'if (t && at.monId) {', expect: 'MODE, ITEM CLAUSE and DUPLICATES change' },
  { group: 'D', file: 'builder_team.js', name: 'ITEM CLAUSE changes nothing', find: "else if (row.id === 'item') patch.itemClause = !p.itemClause;", replace: "else if (row.id === 'item') patch.itemClause = p.itemClause;", expect: 'MODE, ITEM CLAUSE and DUPLICATES change' },
  { group: 'D', file: 'builder_team.js', name: 'the rules panel drops the layers it does not show', find: "ES().buildRulesetId({ ...p, keep: p.unknown, ...patch })", replace: 'ES().buildRulesetId({ ...patch })', expect: 'MODE, ITEM CLAUSE and DUPLICATES change' },
  { group: 'D', file: 'builder_team.js', name: 'A on a problem acts before its reason is read', find: "help: helpOf(row, c), pagesFirst: !!(row && row.text),", replace: 'help: helpOf(row, c), pagesFirst: false,', expect: 'A turns its pages and then opens that Pokemon' },
  { group: 'D', file: 'builder_team.js', name: 'A on a problem does not open its Pokemon', find: "if (r.row.monId) { X.setAt({ monId: r.row.monId, tab: 'build' }); return X.go('builder-mon'); }", replace: '', expect: 'A turns its pages and then opens that Pokemon' },
  { group: 'D', file: 'builder_team.js', name: 'the check screen has no CONVERT row', find: "if (out.length) out.push({ id: 'conform', kind: 'button', label: 'CONVERT TO RULES' });", replace: '', expect: 'CONVERT TO RULES fixes' },
  { group: 'D', file: 'builder_team.js', name: 'a seventh Pokemon may be added', find: "if (check().mons.length >= maxMons()) {", replace: 'if (false) {', expect: 'a full team takes no seventh' , also: { find: "    return monAt(cur) ? slotMenu(cur) : addMon();", replace: "    return addMon();" } },
  // ---- the Pokemon
  { group: 'E', file: 'builder_mon.js', name: 'a held LEVEL is one undo step each', find: "case 'level': set('level', m.level + dir, 'level:' + m.id); return [];", replace: "case 'level': set('level', m.level + dir); return [];", expect: 'a held direction is ONE undo step' },
  { group: 'E', file: 'builder_mon.js', name: 'TYPE A NUMBER takes letters', find: "if (!/^\\d{1,6}$/.test(r.value)) {", replace: 'if (false) {', expect: 'refuses letters with the DOM editor' },
  { group: 'E', file: 'builder_mon.js', name: 'MIN sets the largest', find: "if (res.row.id === 'min') { spec.set(spec.min); return []; }", replace: "if (res.row.id === 'min') { spec.set(spec.max); return []; }", expect: 'MAX / MIN set the ends' },
  { group: 'E', file: 'builder_mon.js', name: 'the nickname cannot be cleared', find: "charset: 'name', allowEmpty: true }, (r) => { if (r.ok) set('nickname', r.value.trim()); return []; });", replace: "charset: 'name' }, (r) => { if (r.ok) set('nickname', r.value.trim()); return []; });", expect: 'an empty one clears it' },
  { group: 'E', file: 'builder_mon.js', name: 'L does not change the tab', find: "if (action === 'l') return show(index() - 1);", replace: "if (action === 'l') return [];", expect: 'L and R (and a tap on a tab)' },
  { group: 'E', file: 'builder_mon.js', name: 'a tap on a tab does nothing', find: "if (i >= 0) return ev.kind === 'click' ? show(i) : [];", replace: 'if (i >= 0) return [];', expect: 'L and R (and a tap on a tab)' },
  { group: 'E', file: 'builder_mon.js', name: 'a genderless species is sent to the reducer', find: "if (g.length < 2) { X.flash(g[0] === '-' ? 'This species has no gender.' : 'This species has one gender.'); return []; }", replace: '', expect: 'a genderless species says so' },
  { group: 'E', file: 'builder_mon.js', name: 'FRIENDSHIP steps by one', find: "set('friendship', m.friendship + dir * 10, 'friend:' + m.id)", replace: "set('friendship', m.friendship + dir, 'friend:' + m.id)", expect: 'FRIENDSHIP steps by ten' },
  { group: 'E', file: 'builder_mon.js', name: 'an unknown species gets the full row list', find: "if (!sp) return [{ id: 'species', kind: 'item', label: 'SPECIES', value: 'Unknown ' + m.species }, { id: 'remove', kind: 'button', label: 'REMOVE FROM TEAM' }, last, ...undoRows(X)];", replace: '', expect: 'a species this ROM lacks still draws' },
  // ---- the pickers
  { group: 'F', file: 'builder_pick.js', name: 'an excluded Pokemon is picked', find: "    if (!r.available) { X.flash(sentence(kit().text(r.name) + ': ' + r.text), true); return []; }\n", replace: '', expect: 'A on one picks NOTHING' },
  { group: 'D', file: 'builder_pick.js', name: 'the new Pokemon opens on top of the picker', find: "return X.go('builder-mon', { replace: true });", replace: "return X.go('builder-mon');", expect: 'opened in the picker\'s place' },
  { group: 'F', file: 'builder_pick.js', name: 'a partial name takes the first row', find: "const pick = kit().ED.speciesEnterChoice(pack(), f.ids, P.q, 'name');", replace: "const pick = kit().ED.speciesEnterChoice(pack(), f.ids, P.q, 'dex');", expect: 'THE ENTER RULE' },
  { group: 'F', file: 'builder_pick.js', name: 'the excluded Pokemon are always listed', find: "const shown = P.excluded ? all : kit().ED.speciesSearch(pack(), P.q, ruleset(), { ...o, unavailable: 'hide' });", replace: 'const shown = all;', expect: 'the list is what the rules module allows' },
  { group: 'F', file: 'builder_pick.js', name: 'the sort is not kept as a preference', find: "X.setPref('speciesSort', all[(all.indexOf(sort()) + res.dir + all.length) % all.length]);", replace: "X.prefs().speciesSort = all[(all.indexOf(sort()) + res.dir + all.length) % all.length];", expect: 'SORT is remembered as a preference' },
  { group: 'F', file: 'builder_pick.js', name: 'CLEAR keeps the type filter', find: "if (res.row.id === 'clear') { P.q = ''; P.type = null; P.excluded = false; list.set(0); }", replace: "if (res.row.id === 'clear') { P.q = ''; P.excluded = false; list.set(0); }", expect: 'CLEAR shows everything again' },
  { group: 'F', file: 'builder_pick.js', name: 'the picker opens with nothing to pick for', find: "    ready: () => P.purpose === 'add' || (P.purpose === 'change' && !!X.mon()),", replace: '    ready: () => true,', expect: 'opened with nothing to pick for' },
  { group: 'F', file: 'builder_pick.js', name: 'an opening keeps the last search', find: "P.purpose = o && (o.purpose === 'add' || o.purpose === 'change') ? o.purpose : null; P.q = ''; P.type = null;", replace: "P.purpose = o && (o.purpose === 'add' || o.purpose === 'change') ? o.purpose : null; P.type = null;", expect: 'every opening starts from the whole list' },
  { group: 'F', file: 'builder_pick.js', name: 'an excluded item is set', find: "    if (e && !e.status.ok) { X.flash(sentence(kit().text(e.name) + ': ' + e.status.text), true); return []; }\n", replace: '', expect: 'items filter' },
  { group: 'F', file: 'builder_pick.js', name: 'the item picker does not start on the held item', find: "list.set(i >= 0 ? i + 1 : 0);", replace: 'list.set(0);', expect: 'the cursor starts on it' },
  { group: 'F', file: 'builder_pick.js', name: 'NO ITEM is not the first row', find: "const source = (f) => ({ n: f.items.length + 1, at: (i) => (i === 0 ? NONE : rowOf(f.items[i - 1])) });", replace: "const source = (f) => ({ n: f.items.length + 1, at: (i) => (i === f.items.length ? NONE : rowOf(f.items[i])) });", expect: 'NO ITEM first' },
  { group: 'F', file: 'builder_parts.js', name: 'a held direction wraps past the end', find: "cur = to < 0 ? (repeat ? 0 : n - 1) : to >= n ? (repeat ? n - 1 : 0) : to;", replace: 'cur = to < 0 ? n - 1 : to >= n ? 0 : to;', expect: 'a HELD direction stops at the end' },
  { group: 'F', file: 'builder_parts.js', name: 'a page is six rows', find: "cur = clamp(cur + dir * g.rows, 0, n - 1);", replace: 'cur = clamp(cur + dir * (g.rows - 1), 0, n - 1);', expect: 'L / R and the two page chips move a page of seven' },
  { group: 'F', file: 'builder_parts.js', name: 'back from the middle of a chapter skips its first row', find: "  if (first < c || first === 0) return first;\n", replace: '', expect: 'left / right jump a CHAPTER' },
  { group: 'F', file: 'builder_pick.js', name: 'the strip always names the type and the word', find: "X.measure(TITLE_FONT, both + ': ' + n) <= TITLE_PX ? both : word || type;", replace: 'both;', expect: 'and the title is never cut' },
  { group: 'F', file: 'builder_pick.js', name: 'the strip drops the word and keeps the type', find: "<= TITLE_PX ? both : word || type;", replace: '<= TITLE_PX ? both : type || word;', expect: 'it keeps the word' },
  // ---- the ctl
  { group: 'G', file: 'builder_ctl.js', name: 'the autosave waits 25 ms', find: 'export const SAVE_DEBOUNCE_MS = 250;', replace: 'export const SAVE_DEBOUNCE_MS = 25;', expect: 'the autosave waits 250 ms' },
  { group: 'G', file: 'builder_ctl.js', name: 'a write is acknowledged with the seq of NOW', find: "app.apply({ type: 'saved', rev: saved.rev, seq: seq0, updatedAt: saved.updatedAt });", replace: "app.apply({ type: 'saved', rev: saved.rev, seq: now.seq, updatedAt: saved.updatedAt });", expect: 'an edit made WHILE a write is in flight stays dirty' },
  { group: 'G', file: 'builder_ctl.js', name: 'a conflict is treated as a failed write', find: "if (e instanceof ConflictError) conflict = e.detail || {};\n        else if (e instanceof ReadOnlyError)", replace: 'if (e instanceof ReadOnlyError)', expect: 'USE THE OTHER / KEEP MINE / LATER is asked' },
  { group: 'G', file: 'builder_ctl.js', name: 'the conflict question is not armed', find: "d.open({ id: CONFLICT_ID, app: ID, armTicks: DIALOG_ARM_TICKS, pages: pagesOf(CONFLICT_TEXT),", replace: 'd.open({ id: CONFLICT_ID, app: ID, pages: pagesOf(CONFLICT_TEXT),', expect: 'is asked, armed' },
  { group: 'G', file: 'builder_ctl.js', name: 'the conflict question starts on USE THE OTHER', find: 'choice: { options: CONFLICT_OPTIONS.slice(), cursor: CONFLICT_OPTIONS.length - 1 } });', replace: 'choice: { options: CONFLICT_OPTIONS.slice(), cursor: 0 } });', expect: 'with LATER under the cursor' },
  { group: 'G', file: 'builder_ctl.js', name: 'an edit under a conflict is saved anyway', find: "case 'edited': if (conflict || stale) askConflict(); else scheduleSave(); sync(); return undefined;", replace: "case 'edited': scheduleSave(); sync(); return undefined;", expect: 'the next edit asks again' },
  { group: 'G', file: 'builder_ctl.js', name: 'KEEP MINE drops the stored battle record', find: "      app.mapEditor((s) => ({ ...s, profile: withStoredRecord(s.profile, cur.profile) }));\n", replace: '', expect: 'keeps a battle the other tab recorded' },
  { group: 'G', file: 'builder_ctl.js', name: 'KEEP MINE does not rebase', find: "      app.apply({ type: 'rebase', rev: cur.profile.rev });\n", replace: '', expect: 'KEEP MINE saves the edits here' },
  { group: 'G', file: 'builder_ctl.js', name: 'USE THE OTHER keeps the edits', find: "    const r = await loadInto(S.profile.id);\n    if (r.ok) app.note('Loaded the other tab\\'s version.');", replace: "    const r = { ok: true };\n    if (r.ok) app.note('Loaded the other tab\\'s version.');", expect: 'USE THE OTHER loads the stored version' },
  { group: 'G', file: 'builder_ctl.js', name: 'leaving waits for the debounce', find: "    inside = false;\n    await flush();\n", replace: '    inside = false;\n', expect: 'leaving the builder saves at once' },
  { group: 'G', file: 'builder_ctl.js', name: 'leaving keeps the editor state', find: "    conflict = null; stale = false; saveError = null;\n    app.setEditor(null);\n    if (kit) app.setPhase('loading');", replace: "    conflict = null; stale = false; saveError = null;\n    if (kit) app.setPhase('loading');", expect: 'DROPS the editor state' },
  { group: 'G', file: 'builder_ctl.js', name: 'another tab\'s announcement is not heard', find: "if (inside && S && !stale && store.isStale(S.profile)) { stale = true; sync(); askConflict(); }", replace: '', expect: 'another tab ANNOUNCES a save' },
  { group: 'G', file: 'builder_ctl.js', name: 'a failed write is not said', find: "    else if (saveError) askFailed();\n", replace: '', expect: 'a write that fails' },
  { group: 'G', file: 'builder_hub.js', name: 'a failed write keeps the SAVED tag', find: "if (S.flags.notSaved || S.flags.failed) return { text: 'NOT SAVED', bad: true };", replace: "if (S.flags.notSaved) return { text: 'NOT SAVED', bad: true };", expect: 'a write that fails' },
  { group: 'G', file: 'builder_ctl.js', name: 'the hub is not told after a save', find: "    if (wrote) tellHub();                                             // the main menu", replace: '    // the main menu', expect: 'after a save the hub is told' },
  { group: 'G', file: 'builder_ctl.js', name: 'the first profile is loaded whatever is active', find: "const pick = ids.includes(active) ? active : ids.length === 1 ? ids[0] : null;", replace: 'const pick = ids.length ? ids[0] : null;', expect: 'entering loads the store\'s ACTIVE profile' },
  { group: 'G', file: 'builder_ctl.js', name: 'a loaded profile is not made the active one', find: "    try { await store.setActiveId(id); } catch (_e) { /* the list still shows it */ }\n", replace: '', expect: 'with none active the only one' },
  { group: 'G', file: 'builder_ctl.js', name: 'the focus of another profile is put back', find: "if (at && S && at.profileId === S.profile.id) app.setFocus(at);", replace: '', expect: 'the focus is kept for the tab' },
  { group: 'G', file: 'builder_ctl.js', name: 'a store that keeps nothing is not said', find: "if (store.status.notSaved && !warned && dialog()) {", replace: 'if (false) {', expect: 'a notice says the work lives in memory' },
  { group: 'B', file: 'builder_ctl.js', name: 'a deleted trainer stays loaded', find: "closeQuestions(); app.setEditor(null); }\n      await store.deleteProfile(id);", replace: 'closeQuestions(); }\n      await store.deleteProfile(id);', expect: 'leaves no one ACTIVE' },
  // ---- stage 2: the MOVES tab and the move picker
  { group: 'H', file: 'builder_moves.js', name: 'an empty slot does not open the picker', find: "if (r.row.empty) return openPicker(mon().moves.length);", replace: 'if (r.row.empty) return [];', expect: 'A on the first empty slot opens the move picker' },
  { group: 'H', file: 'builder_moves.js', name: 'a "-" slot asks for a slot the reducer would refuse', find: "if (r.row.empty) return openPicker(mon().moves.length);", replace: 'if (r.row.empty) return openPicker(r.row.slot);', expect: 'A on the first empty slot opens the move picker' },
  { group: 'H', file: 'builder_moves.js', name: 'the picker takes a move the Pokemon already knows', find: "    if (!okRow(e)) { X.flash(why(e), true); return []; }\n", replace: '', expect: 'already knows is grey and A takes NOTHING' },
  { group: 'H', file: 'builder_moves.js', name: 'a move it already knows is not grey', find: "const dup = (e) => known().has(e.id) && e.id !== currentId();", replace: 'const dup = () => false;', expect: 'already knows is grey and A takes NOTHING' },
  { group: 'H', file: 'builder_moves.js', name: 'a level-gated move loses the level it needs', find: "return st.why === 'level-too-low' && st.needLevel ? s + ' It needs level ' + st.needLevel + '.' : s;", replace: 'return s;', expect: 'the level it needs' },
  { group: 'H', file: 'builder_moves.js', name: 'DOWN moves a move up', find: "case 'down': X.dispatch({ type: 'moveReorder', monId, from: i, to: i + 1 });", replace: "case 'down': X.dispatch({ type: 'moveReorder', monId, from: i, to: i - 1 });", expect: 'UP / DOWN reorder through the reducer' },
  { group: 'H', file: 'builder_moves.js', name: 'the cursor does not follow a moved move', find: "case 'down': X.dispatch({ type: 'moveReorder', monId, from: i, to: i + 1 }); list.set(Math.max(0, where())); return [];", replace: "case 'down': X.dispatch({ type: 'moveReorder', monId, from: i, to: i + 1 }); return [];", expect: 'UP / DOWN reorder through the reducer' },
  { group: 'H', file: 'builder_moves.js', name: 'REMOVE on the last move is silent', find: "if (res.row.id === 'remove') X.dispatch({ type: 'moveSet', monId, slot: i, moveId: null });          // (the reducer says why", replace: "if (res.row.id === 'remove') { /* nothing */ }          // (the reducer says why", expect: 'the last move cannot be removed' },
  { group: 'H', file: 'builder_moves.js', name: 'the last move\'s REMOVE is not grey', find: "{ id: 'remove', label: 'REMOVE', ...(n <= 1 ? { disabled: true } : {}) }", replace: "{ id: 'remove', label: 'REMOVE' }", expect: 'the last move cannot be removed' },
  { group: 'H', file: 'builder_moves.js', name: 'the unlearnable moves are always listed', find: "kit().ED.moveCatalog(pack(), m, X.team().ruleset, { allMoves: P.all })", replace: 'kit().ED.moveCatalog(pack(), m, X.team().ruleset, { allMoves: true })', expect: 'the picker lists what the Pokemon\'s line can learn' },
  { group: 'H', file: 'builder_moves.js', name: 'UNLEARNABLE: SHOW lists nothing more', find: "kit().ED.moveCatalog(pack(), m, X.team().ruleset, { allMoves: P.all })", replace: 'kit().ED.moveCatalog(pack(), m, X.team().ruleset, { allMoves: false })', expect: 'with UNLEARNABLE: SHOW' },
  { group: 'H', file: 'builder_moves.js', name: 'a row does not say where its move comes from', find: "label: kit().text(e.name), tag: tagOf(e), mid: e.id,", replace: "label: kit().text(e.name), tag: '', mid: e.id,", expect: 'the picker lists what the Pokemon\'s line can learn' },
  { group: 'H', file: 'builder_moves.js', name: 'an opening keeps the last filter', find: "? o.slot : null; reset(); list.set(0); },", replace: '? o.slot : null; list.set(0); },', expect: 'every opening starts from the whole list' },
  { group: 'H', file: 'builder_moves.js', name: 'the TYPE filter does nothing', find: "case 'type': P.type = cycle(typeChoices(), P.type, res.dir); break;", replace: "case 'type': break;", expect: 'the filter panel (Y, X or the FILTER chip)' },
  { group: 'H', file: 'builder_moves.js', name: 'the POWER band is ignored', find: "const range = P.power === 'none' ? { powerMax: 0 } : pm ? { powerMin: Number(pm[1]), powerMax: pm[2] === '' ? undefined : Number(pm[2]) } : {};", replace: 'const range = {};', expect: 'the filter panel (Y, X or the FILTER chip)' },
  { group: 'H', file: 'builder_moves.js', name: 'CLEAR keeps the filters', find: "if (res.row.id === 'clear') { reset(); list.set(0); }", replace: "if (res.row.id === 'clear') { list.set(0); }", expect: 'the filter panel (Y, X or the FILTER chip)' },
  { group: 'H', file: 'builder_moves.js', name: 'USABLE: ONLY lists everything', find: "sort: P.sort, onlyAvailable: P.usable, ...range", replace: 'sort: P.sort, onlyAvailable: false, ...range', expect: 'USABLE: ONLY leaves out' },
  { group: 'H', file: 'builder_moves.js', name: 'the picker opens with no slot to fill', find: "    ready: () => P.slot !== null && !!mon() && P.slot <= mon().moves.length,", replace: '    ready: () => true,', expect: 'opened with no slot to fill' },
  { group: 'H', file: 'builder_moves.js', name: 'the cursor does not start on the slot\'s move', find: "enter() { const id = currentId(), f = found(); if (id !== null) list.seek(source(f), (r) => r.mid === id); },", replace: 'enter() {},', expect: 'with the cursor on the move it has' },
  { group: 'H', file: 'builder_moves.js', name: 'FIND does not narrow the list', find: "P.q = r.value.trim().replace(/\\s+/g, ' '); list.set(0);\n      const n = found().length;", replace: "list.set(0);\n      const n = found().length;", expect: 'FIND (START, or the panel\'s row) narrows' },
  { group: 'H', file: 'builder_moves.js', name: 'an unknown move is shown as a move', find: ": { id: 'm:' + i, kind: 'item', slot: i, label: 'Unknown move ' + mv.id, mid: mv.id, unknown: true });", replace: ": { id: 'm:' + i, kind: 'item', slot: i, label: 'Unknown move ' + mv.id, mid: mv.id });", expect: 'a move this ROM lacks still draws' },
  // ---- the STATS tab
  { group: 'I', file: 'builder_stats.js', name: 'a step is one EV', find: "export const STEP = Object.freeze({ ev: 4, points: 1, iv: 1 });", replace: 'export const STEP = Object.freeze({ ev: 1, points: 1, iv: 1 });', expect: 'step its EVs by 4' },
  { group: 'I', file: 'builder_stats.js', name: 'every held step is an undo step', find: "X.dispatch({ type: 'evSet', monId: m.id, stat: k, value, mode: md, coalesce: key });", replace: "X.dispatch({ type: 'evSet', monId: m.id, stat: k, value, mode: md });", expect: 'a HELD direction is ONE undo step and another stat' },
  { group: 'I', file: 'builder_stats.js', name: 'one key for every stat', find: "key = 'spin:' + m.id + ':' + k + ':' + md;", replace: "key = 'spin:' + m.id;", expect: 'a HELD direction is ONE undo step and another stat' },
  { group: 'I', file: 'builder_stats.js', name: 'LEFT at 0 is sent to the reducer', find: "    if (dir < 0 && cur <= 0) return [];\n", replace: '', expect: 'LEFT at 0 does nothing' },
  { group: 'I', file: 'builder_stats.js', name: 'an odd EV steps off the grid', find: "dir > 0 ? Math.floor(cur / STEP.ev) * STEP.ev + STEP.ev : Math.ceil(cur / STEP.ev) * STEP.ev - STEP.ev;", replace: 'cur + dir * STEP.ev;', expect: 'steps back onto the grid of four' },
  { group: 'I', file: 'builder_stats.js', name: 'the numbers pop-up has no jumps', find: "export const JUMPS = Object.freeze({ ev: [40], points: [8], iv: [] });", replace: 'export const JUMPS = Object.freeze({ ev: [], points: [8], iv: [] });', expect: 'A on a stat opens the numbers' },
  { group: 'I', file: 'builder_mon.js', name: '-40 adds forty', find: "spec.set(Math.max(spec.min, now() - Number(res.row.id.slice(5))))", replace: 'spec.set(now() + Number(res.row.id.slice(5)))', expect: 'A on a stat opens the numbers' },
  { group: 'I', file: 'builder_stats.js', name: 'the numbers are for the EVs whatever is edited', find: "    if (md === 'iv') return numberMenu(X, { id: 'iv:' + k,", replace: "    if (false) return numberMenu(X, { id: 'iv:' + k,", expect: 'IVS makes them change the IV' },
  { group: 'I', file: 'builder_stats.js', name: 'the view is not kept as a preference', find: "if (!ivMode && !R().points) X.setPref('statsView', next);", replace: "if (!ivMode && !R().points) X.prefs().statsView = next;", expect: 'the choice is a preference the ctl keeps' },
  { group: 'I', file: 'builder_ctl.js', name: 'the ctl does not keep the stats view', find: "const PREF_KEYS = Object.freeze({ speciesSort: SORT_KEY, statsView: VIEW_KEY });", replace: 'const PREF_KEYS = Object.freeze({ speciesSort: SORT_KEY });', expect: 'the choice is a preference the ctl keeps' },
  { group: 'I', file: 'builder_stats.js', name: 'an IV run is many undo steps', find: "X.dispatch({ type: 'ivSet', monId: m.id, stat: k, value: cur + dir, coalesce: key });", replace: "X.dispatch({ type: 'ivSet', monId: m.id, stat: k, value: cur + dir });", expect: 'IVS makes them change the IV' },
  { group: 'I', file: 'builder_stats.js', name: 'a points-rules team overwrites the viewer\'s view', find: "if (!ivMode && !R().points) X.setPref('statsView', next);", replace: "if (!ivMode) X.setPref('statsView', next);", expect: 'the viewer\'s own choice of view is left alone' },
  { group: 'I', file: 'builder_stats.js', name: 'EVS is offered under points rules', find: "const modes = () => (R().points ? ['points', 'iv'] : STAT_MODES);", replace: 'const modes = () => STAT_MODES;', expect: 'there are no EVs to edit' },
  { group: 'I', file: 'builder_stats.js', name: 'the points view shows the EV budget', find: "const x = effView() === 'points' ? b.points : b.ev;", replace: 'const x = b.ev;', expect: 'there are no EVs to edit' },
  { group: 'I', file: 'builder_stats.js', name: 'the bar\'s scale forgets the level', find: "return { hp: core + level + 10, other: Math.floor(1.1 * (core + 5)) };", replace: 'return { hp: core + 10, other: Math.floor(1.1 * (core + 5)) };', expect: 'a bar on the DOM editor\'s scale' },
  { group: 'I', file: 'builder_stats.js', name: 'the nature\'s arrows are swapped', find: "nat: nat && nat.up === k ? 1 : nat && nat.down === k ? -1 : 0,", replace: 'nat: nat && nat.up === k ? -1 : nat && nat.down === k ? 1 : 0,', expect: 'a bar on the DOM editor\'s scale' },
  { group: 'I', file: 'builder_stats.js', name: 'a Hidden Power type sets every IV to 31', find: "pick(res) { if (res.kind === 'choose') X.dispatch({ type: 'ivPreset', monId: id, preset: res.row.id }); return []; },", replace: "pick(res) { if (res.kind === 'choose') X.dispatch({ type: 'ivPreset', monId: id, preset: 'all31' }); return []; },", expect: 'HIDDEN POWER shows the type the IVs make' },
  { group: 'I', file: 'builder_stats.js', name: 'the type list does not start on the type it has', find: "cursor: Math.max(0, types.findIndex((t) => t.id === d.hiddenPower.typeId)),", replace: 'cursor: 0,', expect: 'HIDDEN POWER shows the type the IVs make' },
  { group: 'I', file: 'builder_parts.js', name: 'a long menu does not scroll', find: "const cap = () => BG.popup.lines - (P.title ? 1 : 0);", replace: 'const cap = () => 99;', expect: 'HIDDEN POWER shows the type the IVs make' },
  { group: 'I', file: 'builder_stats.js', name: '0 SPE zeroes the Attack IV', find: "{ id: 'zeroSpe', label: '0 SPE', action: { type: 'ivPreset', preset: 'zeroSpe' },", replace: "{ id: 'zeroSpe', label: '0 SPE', action: { type: 'ivPreset', preset: 'zeroAtk' },", expect: 'QUICK ACTIONS (the row, START or X)' },
  { group: 'I', file: 'builder_stats.js', name: 'START does not open the quick actions', find: "if ((action === 'start' || action === 'x') && derived().ok) return actions();", replace: "if (action === 'x' && derived().ok) return actions();", expect: 'QUICK ACTIONS (the row, START or X)' },
  { group: 'I', file: 'builder_stats.js', name: 'a tap on the other number steps it at once', find: "        if (name !== live) { ivMode = name === 'iv'; return []; }          // a tap on the OTHER number", replace: "        if (name !== live) ivMode = name === 'iv';          // a tap on the OTHER number", expect: 'a tap on the OTHER number makes that one the one edited' },
  { group: 'I', file: 'builder_stats.js', name: 'a tap on the left half steps up', find: "return step(row.stat, ev.x < c.x + c.w / 2 ? -1 : 1);", replace: 'return step(row.stat, 1);', expect: 'a tap on a number\'s right half steps it up and on its left half down' },
  { group: 'I', file: 'builder_stats.js', name: 'an unknown species gets stat rows', find: "    if (!d.ok) return [{ id: 'none', kind: 'item', label: 'NO STATS TO SHOW', dim: true }].concat(undoRows(X));\n", replace: '', expect: 'has no stats to show' },
  // ---- the portrait, the team code, the test battle
  { group: 'J', file: 'builder_portrait.js', name: 'PORTRAIT is offered for every trainer', find: "when: (X, t) => !!t && t.id === X.activeId(), run: (X) => X.go('builder-portrait')", replace: "run: (X) => X.go('builder-portrait')", expect: 'PORTRAIT is in the ACTIVE trainer\'s menu and in no other' },
  { group: 'J', file: 'builder_undo.js', name: 'every trainer\'s menu has UNDO', find: "const onActive = { when: (X, t) => !!t && t.id === X.activeId() };", replace: 'const onActive = {};', expect: 'PORTRAIT is in the ACTIVE trainer\'s menu and in no other' },
  { group: 'J', file: 'builder_portrait.js', name: 'the picker opens on the first head', find: "enter() { cur = Math.max(0, inUse()); fit(); },", replace: 'enter() { cur = 0; },', expect: 'opens on the one in use' },
  { group: 'J', file: 'builder_portrait.js', name: 'B takes the head', find: "case 'b': return X.back();", replace: "case 'b': return take(cur);", expect: 'B changes nothing' },
  { group: 'J', file: 'builder_portrait.js', name: 'a page is one head', find: "function page(dir) { const n = count(), to = cur + dir * PER;", replace: 'function page(dir) { const n = count(), to = cur + dir;', expect: 'a page of three' },
  { group: 'J', file: 'builder_portrait.js', name: 'A takes the first head of the page', find: "case 'a': return take(cur);", replace: "case 'a': return take(first());", expect: 'A takes the head through the reducer' },
  { group: 'J', file: 'builder_io.js', name: 'COPY CODE on an empty team asks the ctl', find: "    if (!t.monIds.length) { X.flash('An empty team has no code. Add a Pok{E}mon first.', true); return []; }\n", replace: '', expect: 'an empty team has no code' },
  { group: 'J', file: 'builder_io.js', name: 'the screen never asks for the code\'s length', find: "      if (t && t.monIds.length && !fresh()) X.emit(X.eff('code-length', { teamId: t.id }));", replace: '', expect: 'the ctl says how long the team\'s code is' },
  { group: 'J', file: 'builder_ctl.js', name: 'a refused copy is said to have worked', find: "    catch (_e) { tell('builder-code', { type: 'copy-refused' }); return; }\n", replace: "    catch (_e) { /* said below */ }\n", expect: 'will not let the page copy' },
  { group: 'J', file: 'builder_ctl.js', name: 'the code is said to be copied before it is', find: "await c.writeText(code); }", replace: '}', expect: 'COPY CODE puts the ARENA1 code on the clipboard' },
  { group: 'J', file: 'builder_ctl.js', name: 'the copy always waits for the code to be made again', find: "let code = madeFor(teamId);", replace: "let code = null;", expect: 'COPY CODE starts its write in the very call that asked' },
  { group: 'J', file: 'builder_ctl.js', name: 'the code made before an edit is copied after it', find: "return S && made.profile === S.profile && made.teamId === teamId ? made.code : null; };", replace: "return S && made.teamId === teamId ? made.code : null; };", expect: 'COPY CODE starts its write in the very call that asked' },
  { group: 'J', file: 'builder_io.js', name: 'ADD does not open the team', find: "    return X.go('builder-team', { replace: true });", replace: '    return [];', expect: 'opens it in the screen\'s place' },
  { group: 'J', file: 'builder_io.js', name: 'the new team opens on top of the code screen', find: "    return X.go('builder-team', { replace: true });", replace: "    return X.go('builder-team');", expect: 'opens it in the screen\'s place' },
  { group: 'J', file: 'builder_io.js', name: 'CANCEL keeps the preview', find: "case 'cancel': C.preview = null; list.set(0); return [];", replace: "case 'cancel': return [];", expect: 'CANCEL and B forget it' },
  { group: 'J', file: 'builder_io.js', name: 'B leaves under a preview', find: "if (r.kind === 'back') { if (C.preview) { C.preview = null; list.set(0); return []; } return X.back(); }", replace: "if (r.kind === 'back') return X.back();", expect: 'CANCEL and B forget it' },
  { group: 'J', file: 'builder_io.js', name: 'the first reasons are left out of the preview', find: "    return label + plural(p.validation.count, 'problem') + ' under its rules; it is added as it is and CHECK lists them. ' + first;", replace: "    return label + plural(p.validation.count, 'problem') + ' under its rules; it is added as it is and CHECK lists them.';", expect: 'the first reasons in the rules module\'s words' },
  { group: 'J', file: 'builder_io.js', name: 'a refused code is previewed', find: "          if (!msg.ok) { X.flash('That code cannot be used: ' + sentence(drawable(msg.message || msg.code || 'it could not be read')), true); return []; }\n", replace: '', expect: 'refused IN WORDS the ROM font can draw' },
  { group: 'J', file: 'builder_io.js', name: 'a reason is drawn with characters the font lacks', find: "const drawable = (s) => String(s === undefined || s === null ? '' : s).replace(/[<>]/g, '');", replace: "const drawable = (s) => String(s === undefined || s === null ? '' : s);", expect: 'refused IN WORDS the ROM font can draw' },
  { group: 'J', file: 'builder_kit.js', name: 'a code naming a Pokemon the ROM lacks is previewed', find: "    if (missing.length) return { ok: false, code: 'code.species-unknown',", replace: "    if (false) return { ok: false, code: 'code.species-unknown',", expect: 'refused IN WORDS the ROM font can draw' },
  { group: 'J', file: 'builder_ctl.js', name: 'an empty clipboard is decoded', find: "    if (typeof text !== 'string' || !text.trim()) { tell('builder-code', { type: 'paste-empty' }); return; }\n", replace: '', expect: 'an empty clipboard and a clipboard' },
  { group: 'J', file: 'builder_ctl.js', name: 'a clipboard that refuses is not said', find: "    catch (_e) { tell('builder-code', { type: 'paste-refused' }); return; }", replace: '    catch (_e) { return; }', expect: 'an empty clipboard and a clipboard' },
  { group: 'J', file: 'builder_io.js', name: 'the code entry takes the name keys', find: "max: CODE_MAX, charset: 'teamcode' }", replace: "max: CODE_MAX, charset: 'name' }", expect: 'ENTER A CODE opens the text entry' },
  { group: 'J', file: 'builder_ctl.js', name: 'the test battle leaves without saving', find: "    if (!app.editor()) return;\n    await flush();\n", replace: "    if (!app.editor()) return;\n", expect: 'START saves the edits first' },
  { group: 'J', file: 'builder_ctl.js', name: 'the seed is always the same', find: "seed: env.freshSeed() >>> 0,", replace: 'seed: 1,', expect: 'a fresh seed' },
  { group: 'J', file: 'builder_ctl.js', name: 'the foe is always random', find: "    if (eff.foeId) { const f = await kit.encodeTeam(S.profile, eff.foeId); if (!f.ok) { say(f.message); return; } foe = f.code; }\n", replace: '', expect: 'carries that team\'s code as the foe' },
  { group: 'J', file: 'builder_io.js', name: 'an empty team may start a battle', find: "    if (!c.mons.length) return 'Add a Pok{E}mon first.';\n", replace: '', expect: 'START is refused in words' },
  { group: 'J', file: 'builder_io.js', name: 'a team with problems may start a battle', find: "    if (c.status === 'bad') return 'Fix the ' + plural(c.count, 'problem')", replace: "    if (false) return 'Fix the ' + plural(c.count, 'problem')", expect: 'START is refused in words' },
  { group: 'J', file: 'builder_io.js', name: 'the foe\'s problems are not looked at', find: "if (fc.status === 'bad') return '\"' + f.name", replace: "if (false) return '\"' + f.name", expect: 'START is refused in words' },
  { group: 'J', file: 'builder_io.js', name: 'empty teams are offered as foes', find: "const foes = () => X.profile().teams.filter((t) => t.id !== team().id && t.monIds.length > 0);", replace: 'const foes = () => X.profile().teams.filter((t) => t.id !== team().id);', expect: 'only those with Pokemon are offered' },
  { group: 'J', file: 'builder_io.js', name: 'FORMAT keeps a choice the team is too small for', find: "const format = () => (T.format && formats().includes(T.format) ? T.format : LINKS().formatForTeamSize(check().mons.length));", replace: "const format = () => (T.format ? T.format : '3v3');", expect: '3v3 only with three Pokemon or more' },
  // ---- undo and redo
  { group: 'K', file: 'builder_ctl.js', name: 'Ctrl+Z undoes under a text entry and a question', find: "    if (m && ((typeof m.wantsText === 'function' && m.wantsText()) || (typeof m.textUnder === 'function' && m.textUnder()) || (m.dialog && m.dialog.isOpen()))) return;", replace: '    if (!m) return;', expect: 'Ctrl+Z is left alone while a text entry is open' },
  { group: 'K', file: 'builder_hub.js', name: 'the model undoes under a text entry', find: "    if (S.phase !== 'ready' || !S.ed || entry.isOpen()) return [];\n    S.input++;\n    dispatch({ type });", replace: "    if (S.phase !== 'ready' || !S.ed) return [];\n    S.input++;\n    dispatch({ type });", expect: 'Ctrl+Z is left alone while a text entry is open' },
  { group: 'K', file: 'builder_ctl.js', name: 'Ctrl+Z undoes under a DOM panel', find: "    if (hk && typeof hk.dialogOpen === 'function' && hk.dialogOpen()) return;", replace: '', expect: 'Ctrl+Z is left alone while a text entry is open' },
  { group: 'K', file: 'builder_ctl.js', name: 'Ctrl+Z undoes a text field\'s typing', find: "    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName || '')) || t.isContentEditable)) return;", replace: '', expect: 'Ctrl+Z is left alone while a text entry is open' },
  { group: 'K', file: 'builder_ctl.js', name: 'Z without Ctrl undoes', find: "if (!inside || !e || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;", replace: 'if (!inside || !e || e.defaultPrevented || e.altKey) return;', expect: 'Z without Ctrl is no undo' },
  { group: 'K', file: 'builder_ctl.js', name: 'the key is heard outside the builder', find: "if (!inside || !e || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;", replace: 'if (!e || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;', expect: 'outside the builder nothing listens' },
  { group: 'K', file: 'builder_ctl.js', name: 'Ctrl+Y undoes', find: "run(type === 'undo' ? app.undo() : app.redo());", replace: 'run(app.undo());', expect: 'Ctrl+Y (or Ctrl+Shift+Z) redoes' },
  { group: 'K', file: 'builder_ctl.js', name: 'Ctrl+Shift+Z undoes', find: "const type = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : null;", replace: "const type = k === 'z' ? 'undo' : k === 'y' && !e.shiftKey ? 'redo' : null;", expect: 'Ctrl+Y (or Ctrl+Shift+Z) redoes' },
  { group: 'K', file: 'builder_hub.js', name: 'an undo leaves a screen that lost what it shows', find: "    dispatch({ type });\n    return out(settle());", replace: "    dispatch({ type });\n    return out([]);", expect: 'takes away what the screen shows' },
  { group: 'K', file: 'builder_undo.js', name: 'a row\'s undo does not settle', find: "  X.dispatch({ type: id });\n  return X.settle();", replace: "  X.dispatch({ type: id });\n  return [];", expect: 'takes away what the screen shows' },
  { group: 'K', file: 'builder_undo.js', name: 'REDO undoes', find: "  X.dispatch({ type: id });\n  return X.settle();", replace: "  X.dispatch({ type: 'undo' });\n  return X.settle();", expect: 'takes away what the screen shows' },
  { group: 'K', file: 'builder_home.js', name: 'the cursor leaves REDO when a team comes back', find: "const extra = (row) => { const fx = extRun(X, 'teams.rows', row.id, null); list.seek(rows(), (x) => x.id === row.id); return fx; };", replace: "const extra = (row) => extRun(X, 'teams.rows', row.id, null);", expect: 'the cursor stays on REDO' },
  { group: 'K', file: 'builder_undo.js', name: 'the rows are never grey', find: "export const canUndo = (X, id) => stackOf(X, id).length > 0;", replace: 'export const canUndo = () => true;', expect: 'they are grey while there is nothing to undo' },
  { group: 'K', file: 'builder_mon.js', name: 'BUILD has no UNDO and REDO', find: "      last,\n      ...undoRows(X),\n    ];", replace: "      last,\n    ];", expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_moves.js', name: 'MOVES has no UNDO and REDO', find: "    return out.concat(undoRows(X));\n  }\n  function openPicker", replace: "    return out;\n  }\n  function openPicker", expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_team.js', name: 'RULES has no UNDO and REDO', find: "      ...undoRows(X),\n      { id: 'back', kind: 'button', label: 'BACK' },\n    ];", replace: "      { id: 'back', kind: 'button', label: 'BACK' },\n    ];", expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_team.js', name: 'CHECK has no UNDO and REDO', find: "    out.push(...undoRows(X), { id: 'back', kind: 'button', label: 'BACK' });", replace: "    out.push({ id: 'back', kind: 'button', label: 'BACK' });", expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_home.js', name: 'the teams list has no rows of other families', find: "    out.push(...extRows(X, 'teams.rows', null, 'button'));\n", replace: '', expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_team.js', name: 'the team menu has no rows of other families', find: "        .concat(extRows(X, 'team.menu', team()), [{ id: 'delete', label: 'DELETE' }]),", replace: "        .concat([{ id: 'delete', label: 'DELETE' }]),", expect: 'every editing screen has UNDO and REDO in the picture' },
  { group: 'K', file: 'builder_hub.js', name: 'a note is hidden under a menu that stays open', find: "    const ph = !S.flash && popup.isOpen() ? popup.help() : null;\n    if (S.flash) { pages = S.flash.pages; key = 'f:' + S.flash.seq + ':' + S.flash.text; first = true; }\n    else if (ph) {", replace: "    const ph = popup.isOpen() ? popup.help() : null;\n    if (S.flash && !ph) { pages = S.flash.pages; key = 'f:' + S.flash.seq + ':' + S.flash.text; first = true; }\n    else if (ph) {", expect: 'keeps the menu open and the reducer\'s words in the message box' },
  { group: 'K', file: 'builder_hub.js', name: 'an old note comes back when the menu closes', find: "  const dropStale = () => { if (S.flash && S.flash.seq !== S.input) S.flash = null; };", replace: '  const dropStale = () => {};', expect: 'keeps the menu open and the reducer\'s words in the message box' },
  { group: 'K', file: 'builder_undo.js', name: 'UNDO closes its menu', find: "const entry = (id, more) => ({ id, label: LABEL[id], stay: true,", replace: 'const entry = (id, more) => ({ id, label: LABEL[id],', expect: 'keeps the menu open and the reducer\'s words in the message box' },
  { group: 'K', file: 'builder_team.js', name: 'the CHECK screen looks for its rows after an undo took its team away', find: "if (X.team()) keep(r.row.id); return fx; }", replace: 'keep(r.row.id); return fx; }', expect: 'takes the team away under the screen' },
  { group: 'D', file: 'builder_team.js', name: 'after a conversion the cursor is not on UNDO', find: "if (s && !s.error) keep('undo');", replace: '', expect: 'the cursor is then on UNDO' },
  { group: 'D', file: 'builder_parts.js', name: 'a scrolling menu loses its cursor', find: "    if (cur < off) off = cur; else if (cur >= off + k) off = cur - k + 1;\n    return r;", replace: '    return r;', expect: 'it is longer than the room and scrolls' },
  // ---- the kit
  { group: 'G', file: 'builder_kit.js', name: 'ROM strings are drawn raw', find: "const text = (s) => displayText(String(s === undefined || s === null ? '' : s))", replace: "const text = (s) => String(s === undefined || s === null ? '' : s)", expect: 'the kit makes every ROM string drawable' },
];

async function runMutants(realNames) {
  const live = MUTANTS.filter((m) => !ONLY.length || ONLY.includes(m.group));
  const t0 = Date.now(); let n = 0;
  for (const mu of live) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-builder-mut-'));
    let r;
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file); let text = fs.readFileSync(target, 'utf8');
      for (const ed of [mu, ...(mu.also ? [mu.also] : [])]) { const k = text.split(ed.find).length - 1; if (k !== 1) throw new Error('the text to replace occurs ' + k + ' times (must be 1): ' + ed.find.slice(0, 60)); text = text.replace(ed.find, () => ed.replace); }
      fs.writeFileSync(target, text);
      if (!realNames.some((x) => x.includes(mu.expect))) throw new Error('no check is named "' + mu.expect + '"');
      r = (await runChecks(dir, [mu.group])).fails;
    } catch (e) { r = ['SETUP: ' + e.message]; }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* a temp dir */ } }
    n++;
    ok(r.length > 0 && !/^SETUP/.test(r[0]) && r.some((x) => x.includes(mu.expect)), 'M. mutant "' + mu.name + '" (' + mu.file + ') trips the named check "' + mu.expect + '"', r.length ? r.slice(0, 2).join(' || ').slice(0, 300) : 'NOT CAUGHT');
  }
  console.log('  ' + n + ' mutants in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
}

/* ================================================================================================ run */
{
  const groups = ONLY.length ? ONLY.filter((g) => g !== 'R') : null;
  const real = await runChecks(SRC, groups);
  for (const g of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    if (groups && !groups.includes(g)) continue;
    const mine = real.names.filter((n) => n.startsWith(g + '. ')), bad = real.fails.filter((n) => n.startsWith(g + '. '));
    ok(mine.length > 0 && bad.length === 0, g + '. ' + mine.length + ' checks of group ' + g + ' pass' + (bad.length ? ' (' + bad.length + ' failed)' : ''), bad.slice(0, 3).join(' ;; ').slice(0, 280));
    for (const b of bad.slice(3)) console.log('   also failed: ' + b.slice(0, 300));
    if (process.env.ARENA_VERBOSE) for (const b of bad) console.log('   FAILED: ' + b);
  }
  if (!ONLY.length || ONLY.includes('R')) await renderChecks();
  if (!ONLY.length) {
    const twin = await runChecks(SRC, null);
    ok(twin.fails.length === 0 && twin.names.length === real.names.length, 'M. the unmutated twin stays quiet (' + twin.names.length + ' checks, twice)');
    const unnamed = real.names.filter((n) => !MUTANTS.some((m) => n.includes(m.expect)));
    console.log('  ' + real.names.length + ' named checks; ' + (real.names.length - unnamed.length) + ' are the target of a source mutant');
  }
  if (WANT_MUTANTS) await runMutants(real.names);
}
C.finish();
process.exit(process.exitCode || 0);
