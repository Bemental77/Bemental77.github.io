// tools/pokemonarena_hub_test.mjs - tests for the HUB (pokemonarena/index.html): its state machine, its ROM-drawn screens, its store reader, and
// every way a player can drive it (touch, mouse, keyboard, a synthetic controller), in a real headless Chrome.
//
//   node tools/pokemonarena_hub_test.mjs                 # everything: Node units, then the browser sessions (starts PORT=8097 node tools/devserver.mjs)
//   node tools/pokemonarena_hub_test.mjs --unit          # Node only
//   node tools/pokemonarena_hub_test.mjs --update        # rewrite pokemonarena/hub.golden.json (hashes only) after an intended look change
//   ARENA_PORT=8097 ARENA_CDP=9291 ARENA_OUT=<dir> ARENA_ROM=<gba> ARENA_BASE=<running server>
//
// NODE UNITS
//   M  hub_model.js (pure state machine): navigation, wrap, back, choice rows, START effects, the team screen (loading / none / unavailable /
//      legal / illegal / small teams / several profiles), hit testing, pointer = cursor + A, wheel, determinism, plain-JSON views.
//      Each check family has MUTANTS (hub_model.js source with one defect, loaded from a temp copy) that must trip a NAMED check, and an unmutated twin.
//   R  hub_screen.js (ROM renderer): every view draws opaque 240x160, every text fits its window, every mascot species draws, frames change with
//      cursor / terrain / mascot, a zeroed ROM font / text colours / textbox art changes the picture, hashes match hub.golden.json (and a one-pixel
//      change does not).
//   D  hub_data.js against a memory-backed store: summaries, legality, team codes round-trip, battle / editor links, findTeamForCode.
// BROWSER (tools/headless_cdp.mjs: one Chrome at a time, throwaway profile, bare CDP, --mute-audio; AudioContext and Gamepad are TEST DOUBLES)
//   phone    touch only: tap rows, tap the on-screen pad, the Controls dialog, address hash and history, START url validated by battle_boot.js
//   desktop  keyboard + mouse: keys, hover, click, right click = back, wheel, left/right on choice rows, sound (default off, gesture, persisted,
//            double counts), Controls dialog (focus, B closes, menu inert while open), history back/forward, deep link, hostile hash
//   pad      the synthetic controller alone
//   teams    a seeded IndexedDB profile: MY TEAM rows, legal / illegal / two-Pokemon teams, START url decoded back to the team, active profile
//            recorded, remembered settings, storage blocked -> memory notice
// Screenshots go to ARENA_OUT and are meant to be opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withBrowser, armFacts } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';
import { copyTree, mutateFile, startOverlay } from './pokemonarena_overlay.mjs';

const { root, ROM_PATH, CDP0, BASE, sleep, mod, loadPct, key, errsOf, tapLogical, clickLogical, logicalToPage, moveMouse, rightClick, wheel, padPress, tapSel, clickSel, AUDIO_DOUBLE, PAD_DOUBLE, addInit } = L;
const J = L.J;
const OUT = process.env.ARENA_OUT || L.DEFAULT_OUT;
const UNIT_ONLY = process.argv.includes('--unit') || process.env.ARENA_SKIP_BROWSER === '1';
const UPDATE = process.argv.includes('--update');
const C = L.makeCounter('hub');
const ok = C.ok;
const HM = await mod('hub_model.js');
const HS = await mod('hub_screen.js');
const HD = await mod('hub_data.js');
const B = await mod('battle_ui.js');
const T = await mod('tables.js');
const ST = await mod('store.js');
const P = await mod('profile.js');
const RU = await mod('rules.js');
const TC = await mod('teamcode.js');
const BB = await mod('battle_boot.js');
const EL = await mod('editor_links.js');
const rom = L.readRom();
const GOLDEN = path.join(root, 'pokemonarena', 'hub.golden.json');
console.log('pokemonarena hub test; ROM', ROM_PATH, rom.length, 'B; node', process.version);

/* ================================================================================================ M. the state machine */

const SRC = fs.readFileSync(path.join(root, 'pokemonarena', 'js', 'hub_model.js'), 'utf8');
const mutantCache = new Map();
async function loadModel(mutation) {
  if (!mutation) return HM;
  if (mutantCache.has(mutation.name)) return mutantCache.get(mutation.name);
  const n = SRC.split(mutation.find).length - 1;
  if (n !== 1) throw new Error('mutant "' + mutation.name + '": the text to replace occurs ' + n + ' times (must be 1)');
  // the mutant is written to the temp folder, so its relative import of record_model.js (ST1) is pointed at the real file
  const src = SRC.replace(mutation.find, mutation.replace).replace("from './record_model.js'", "from '" + pathToFileURL(path.join(root, 'pokemonarena', 'js', 'record_model.js')).href + "'");
  const f = path.join(os.tmpdir(), 'arena-hub-mutant-' + process.pid + '-' + mutantCache.size + '.mjs');
  fs.writeFileSync(f, src);
  const m = await import(pathToFileURL(f).href);
  mutantCache.set(mutation.name, m);
  return m;
}

const FAKE = {
  state: 'ready', activeId: 'p1',
  profiles: [
    { id: 'p1', name: 'RED', teams: [
      { id: 't1', name: 'Kanto Squad', size: 3, legal: true, problems: 0, names: ['Pikachu', 'Charizard', 'Snorlax'], lead: { species: 25 } },
      { id: 't2', name: 'Duo', size: 2, legal: false, problems: 2, names: ['Mew', 'Mewtwo'], lead: { species: 150 } },
      { id: 't3', name: 'Full Six', size: 6, legal: true, problems: 0, names: ['A', 'B', 'C', 'D', 'E', 'F'], lead: { species: 9 } },
      { id: 't4', name: 'Five', size: 5, legal: true, problems: 0, names: ['A', 'B', 'C', 'D', 'E'], lead: { species: 3 } },
      { id: 't5', name: 'Solo', size: 1, legal: true, problems: 0, names: ['Ditto'], lead: { species: 132 } },
    ] },
    { id: 'p2', name: 'BLUE', teams: [{ id: 't9', name: 'Blue Team', size: 4, legal: true, problems: 0, names: ['A', 'B', 'C', 'D'], lead: { species: 131 } }] },
  ],
};
const eff = (list, type) => list.filter((e) => e.type === type);
const labels = (m) => m.view().menu.rows.map((r) => r.label);
const rowValue = (m, id) => { const r = m.view().menu.rows.find((x) => x.id === id); return r ? r.value : undefined; };
const press = (m, ...as) => { let out = []; for (const a of as) out = out.concat(m.press(a)); return out; };
const plainOk = (v) => { const seen = []; (function walk(x, p) { if (x === undefined || typeof x === 'function') seen.push(p); else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], p + '.' + k); })(v, 'view'); return seen; };

function checkModel(M) {
  const f = []; const t = (name, cond, detail) => { if (!cond) f.push(name + (detail ? ' [' + detail + ']' : '')); };
  const mk = (o) => M.createHubModel({ mascot: 25, ...(o || {}) });
  // ---- main menu
  let m = mk();
  t('main: eight items in order (W1 added IMPORT SAVE, ST1 added RECORD)', J(labels(m)) === J(['QUICK BATTLE', 'BATTLE WITH MY TEAM', 'RECORD', 'TEAM BUILDER', 'IMPORT SAVE', 'CONTROLS', 'SOUND: OFF', 'ABOUT']), J(labels(m)));
  t('main: the cursor starts on the first row', m.view().menu.cursor === 0);
  press(m, 'up'); t('main: up from the first row wraps to the last', m.view().menu.cursor === 7, String(m.view().menu.cursor));
  press(m, 'down'); t('main: down from the last row wraps to the first', m.view().menu.cursor === 0);
  press(m, 'down', 'down', 'down', 'down', 'down'); t('main: five downs reach CONTROLS', m.view().menu.cursor === 5);
  t('main: B on the main menu does nothing (a menu is not an exit)', m.press('b').length === 0 && m.path() === 'main');
  // ---- QUICK BATTLE
  m = mk();
  let e = m.press('a'); t('quick: A on QUICK BATTLE opens the quick screen', m.path() === 'quick' && eff(e, 'screen').length === 1 && e[0].path === 'quick');
  t('quick: rows FORMAT / CPU / START / BACK', J(labels(m)) === J(['FORMAT', 'CPU', 'START', 'BACK']));
  t('quick: defaults 3v3 and NORMAL', rowValue(m, 'format') === '3v3' && rowValue(m, 'cpu') === 'NORMAL');
  press(m, 'right'); t('quick: right on FORMAT -> 6v6', rowValue(m, 'format') === '6v6');
  press(m, 'right'); t('quick: and wraps back to 3v3', rowValue(m, 'format') === '3v3');
  press(m, 'left'); t('quick: left goes the other way', rowValue(m, 'format') === '6v6');
  m.press('a'); t('quick: A on a choice row also cycles it', rowValue(m, 'format') === '3v3');
  press(m, 'down', 'right'); t('quick: right on CPU -> HARD', rowValue(m, 'cpu') === 'HARD');
  press(m, 'right'); t('quick: and wraps to EASY', rowValue(m, 'cpu') === 'EASY');
  press(m, 'left'); t('quick: left from EASY wraps to HARD', rowValue(m, 'cpu') === 'HARD');
  press(m, 'up', 'right'); // format 6v6
  press(m, 'down', 'down'); e = m.press('a');
  t('quick: START emits one battle effect carrying the chosen format and CPU', e.length === 1 && e[0].type === 'battle' && e[0].mode === 'quick' && e[0].format === '6v6' && e[0].cpu === 'hard', J(e));
  press(m, 'down'); e = m.press('a'); t('quick: BACK returns to the main menu', m.path() === 'main' && e[0].path === 'main');
  t('quick: the main cursor is where it was left (QUICK BATTLE)', m.view().menu.cursor === 0);
  m = mk(); m.press('a'); m.press('b'); t('quick: B goes back too', m.path() === 'main');
  // ---- TEAM BUILDER / CONTROLS / SOUND / ABOUT
  m = mk(); press(m, 'down', 'down', 'down'); e = m.press('a');
  t('main: TEAM BUILDER navigates to the team builder', e.length === 1 && e[0].type === 'navigate' && e[0].url === '/pokemonarena/editor.html', J(e));
  m = mk(); press(m, 'down', 'down', 'down', 'down'); e = m.press('a'); t('main: IMPORT SAVE navigates to the team builder save-import screen', e.length === 1 && e[0].type === 'navigate' && e[0].url === '/pokemonarena/editor.html#/import' && M.IMPORT_URL === e[0].url, J(e));
  m = mk(); press(m, 'down', 'down', 'down', 'down', 'down'); e = m.press('a'); t('main: CONTROLS asks the page to open the Controls panel', e.length === 1 && e[0].type === 'controls', J(e));
  m = mk(); press(m, 'down', 'down', 'down', 'down', 'down', 'down'); e = m.press('a');
  t('main: SOUND toggles on and tells the page', e.length === 1 && e[0].type === 'sound' && e[0].on === true && labels(m)[6] === 'SOUND: ON', J(e) + J(labels(m)));
  e = m.press('a'); t('main: and off again', (e[0] || {}).on === false && labels(m)[6] === 'SOUND: OFF');
  m = mk({ sound: true }); t('main: a remembered "sound on" shows ON', labels(m)[6] === 'SOUND: ON');
  m = mk(); press(m, 'down', 'down', 'down', 'down', 'down', 'down', 'down'); e = m.press('a');
  t('about: A on ABOUT opens page 1 of 4', m.path() === 'about' && m.view().about.page === 0 && m.view().about.pages === 4 && e[0].path === 'about');
  press(m, 'a'); t('about: A turns the page', m.view().about.page === 1);
  press(m, 'up'); t('about: up turns back', m.view().about.page === 0);
  press(m, 'up'); t('about: up on page 1 stays', m.view().about.page === 0);
  press(m, 'a', 'a', 'a'); t('about: three A reach the last page', m.view().about.page === 3 && m.view().about.last === true);
  e = m.press('a'); t('about: A on the last page goes back to the main menu', m.path() === 'main' && e[0].path === 'main');
  m = mk(); press(m, 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'a'); press(m, 'a'); e = m.press('b'); t('about: B leaves from any page', m.path() === 'main');
  // ---- MY TEAM: no data yet / no profile / blocked storage
  m = mk(); press(m, 'down', 'a');
  t('team: while the store is being read the screen says so and offers TEAM BUILDER and BACK', m.path() === 'team' && J(labels(m)) === J(['TEAM BUILDER', 'BACK']) && /Looking for your teams/.test(m.view().msg[0]), J(m.view().msg));
  m.setData({ state: 'ready', profiles: [] }); t('team: with no profile it says "You have no team yet."', /You have no team yet/.test(m.view().msg[0]) && /TEAM BUILDER/.test(m.view().msg[1]), J(m.view().msg));
  e = m.press('a'); t('team: A on TEAM BUILDER leaves for the team builder', e[0].type === 'navigate' && /editor\.html$/.test(e[0].url));
  m.setData({ state: 'ready', profiles: [{ id: 'p1', name: 'RED', teams: [] }] }); t('team: a profile with no teams says so', /no team yet/.test(m.view().msg[0]), J(m.view().msg));
  m.setData({ state: 'unavailable', profiles: [], note: 'Storage could not be read.' }); t('team: unavailable storage is named', /could not be read/.test(m.view().msg[0]) && /Storage/.test(m.view().msg[1]), J(m.view().msg));
  // ---- MY TEAM with data
  m = mk(); m.setData(FAKE); press(m, 'down', 'a');
  t('team: rows TRAINER / TEAM / FORMAT / CPU / START / BACK when there are two profiles', J(labels(m)) === J(['TRAINER', 'TEAM', 'FORMAT', 'CPU', 'START', 'BACK']), J(labels(m)));
  t('team: the active profile and its first team are chosen', rowValue(m, 'profile') === 'RED' && rowValue(m, 'teamsel') === 'Kanto Squad');
  t('team: a 3-Pokemon team defaults to 3v3', rowValue(m, 'format') === '3v3');
  t('team: the lead Pokemon stands on the screen', m.view().mascot.species === 25, J(m.view().mascot));
  press(m, 'down', 'right'); t('team: right on TEAM picks the next team (Duo)', rowValue(m, 'teamsel') === 'Duo' && m.view().mascot.species === 150, rowValue(m, 'teamsel'));
  t('team: a 2-Pokemon team may only play 6v6 (allowed formats)', M.allowedFormats(2).join() === '6v6' && M.allowedFormats(1).join() === '6v6' && M.allowedFormats(3).join() === '3v3,6v6' && M.allowedFormats(6).join() === '3v3,6v6');
  t('allowedFormats(2) has no 3v3', !M.allowedFormats(2).includes('3v3'));
  t('team: the 2-Pokemon team starts on 6v6', rowValue(m, 'format') === '6v6');
  press(m, 'down', 'right', 'right'); t('team: cycling FORMAT on a 2-Pokemon team never reaches 3v3', rowValue(m, 'format') === '6v6');
  press(m, 'down', 'down'); e = m.press('a');
  t('team: START on an illegal team is blocked, with a reason in the text box and no battle', e.length === 1 && e[0].type === 'blocked' && eff(e, 'battle').length === 0 && /Fix 2 problems/.test(m.view().msg[0]), J(e) + J(m.view().msg));
  press(m, 'up', 'up', 'up', 'left'); // back on TEAM -> Kanto Squad
  t('team: left on TEAM goes back to the first team', rowValue(m, 'teamsel') === 'Kanto Squad');
  press(m, 'down', 'down', 'right'); // CPU -> HARD
  t('team: CPU is its own setting', rowValue(m, 'cpu') === 'HARD');
  press(m, 'down'); e = m.press('a');
  t('team: START on a legal team emits one battle effect with the profile, team, format and CPU', e.length === 1 && e[0].type === 'battle' && e[0].mode === 'team' && e[0].profileId === 'p1' && e[0].teamId === 't1' && e[0].format === '3v3' && e[0].cpu === 'hard', J(e));
  press(m, 'up', 'up', 'up', 'right', 'right'); // TEAM -> Full Six
  t('team: a 6-Pokemon team defaults to 6v6', rowValue(m, 'teamsel') === 'Full Six' && rowValue(m, 'format') === '6v6', rowValue(m, 'format'));
  press(m, 'right'); t('team: a 5-Pokemon team defaults to 6v6', rowValue(m, 'teamsel') === 'Five' && rowValue(m, 'format') === '6v6', rowValue(m, 'format'));
  press(m, 'down', 'left'); t('team: the player may pick 3v3 on a 5-Pokemon team', rowValue(m, 'format') === '3v3');
  press(m, 'up', 'right'); t('team: changing team forgets a manual format choice', rowValue(m, 'teamsel') === 'Solo' && rowValue(m, 'format') === '6v6');
  m = mk(); m.setData(FAKE); press(m, 'down', 'a', 'right');
  t('team: right on TRAINER switches profile and shows its team', rowValue(m, 'profile') === 'BLUE' && rowValue(m, 'teamsel') === 'Blue Team' && m.view().mascot.species === 131, J(m.view().menu.rows));
  press(m, 'down', 'down', 'down', 'down'); e = m.press('a');
  t('team: START uses the chosen profile and team ids', e[0].profileId === 'p2' && e[0].teamId === 't9' && e[0].format === '6v6', J(e));
  const one = { state: 'ready', profiles: [FAKE.profiles[0]] };
  m = mk(); m.setData(one); press(m, 'down', 'a'); t('team: with one profile there is no TRAINER row', J(labels(m)) === J(['TEAM', 'FORMAT', 'CPU', 'START', 'BACK']));
  m = mk({ selection: { profileId: 'p2', teamId: 't9', cpu: 'easy' } }); m.setData(FAKE); press(m, 'down', 'a');
  t('team: a remembered selection is restored when it still exists', rowValue(m, 'profile') === 'BLUE' && rowValue(m, 'teamsel') === 'Blue Team' && rowValue(m, 'cpu') === 'EASY');
  m = mk(); m.setData({ ...FAKE, activeId: 'p2' }); press(m, 'down', 'a');
  t('team: the active profile is preselected', rowValue(m, 'profile') === 'BLUE' && rowValue(m, 'teamsel') === 'Blue Team', rowValue(m, 'profile'));
  m = mk({ selection: { profileId: 'gone', teamId: 'gone' } }); m.setData(FAKE); press(m, 'down', 'a');
  t('team: a remembered team that was deleted falls back to the first one', rowValue(m, 'profile') === 'RED' && rowValue(m, 'teamsel') === 'Kanto Squad');
  // ---- hit testing and pointers
  m = mk();
  const rects = m.rects();
  t('hit: eight main rows (RECORD joined the seven)', rects.length === 8);
  t('hit: eight rows sit 12 px apart and end above the text box (y 112); seven rows keep 14 px, six-row and shorter menus 16 px', rects.every((r, i) => r.y === 10 + i * 12 && r.h === 12) && rects[7].y + rects[7].h <= 108 && M.menuPitch(8) === 12 && M.menuPitch(7) === 14 && M.menuPitch(6) === 16 && M.menuPitch(4) === 16, J(rects.map((r) => r.y)));
  let allRows = true; rects.forEach((r, i) => { const h = m.hit(r.x + r.w / 2, r.y + r.h / 2); if (!h || h.kind !== 'row' || h.index !== i) allRows = false; const top = m.hit(r.x + r.w / 2, r.y + 1), bot = m.hit(r.x + r.w / 2, r.y + r.h - 1); if (!top || top.index !== i || !bot || bot.index !== i) allRows = false; });
  t('hit: the middle, top edge and bottom edge of every row map to that row', allRows);
  t('hit: left of the window and below the last row are misses', m.hit(2, 20) === null && m.hit(70, 10 + 7 * 14 + 1) === null && m.hit(200, 20) === null && m.hit(70, 5) === null);
  let ev = m.pointer({ kind: 'move', x: 60, y: 10 + 4 * 12 + 4 }); t('pointer: hover moves the cursor and activates nothing', ev.length === 0 && m.view().menu.cursor === 4);
  ev = m.pointer({ kind: 'click', x: 60, y: 10 + 4 * 14 + 4 }); t('pointer: a click is cursor + A (CONTROLS)', ev.length === 1 && ev[0].type === 'controls', J(ev));
  m = mk(); ev = m.pointer({ kind: 'click', x: 60, y: 14 }); t('pointer: clicking QUICK BATTLE opens it', m.path() === 'quick' && ev[0].path === 'quick');
  ev = m.pointer({ kind: 'click', x: 100, y: 10 + 1 * 16 + 4 }); t('pointer: clicking a choice row cycles it (CPU -> HARD)', rowValue(m, 'cpu') === 'HARD', rowValue(m, 'cpu'));
  ev = m.pointer({ kind: 'click', x: 60, y: 10 + 1 * 16 + 4 }); t('pointer: clicking the left half of a choice row steps BACK (CPU HARD -> NORMAL)', rowValue(m, 'cpu') === 'NORMAL' && m.view().menu.cursor === 1, rowValue(m, 'cpu'));
  ev = m.pointer({ kind: 'click', x: 130, y: 10 + 1 * 16 + 4 }); t('pointer: clicking the right arrow steps forward (CPU NORMAL -> HARD)', rowValue(m, 'cpu') === 'HARD', rowValue(m, 'cpu'));
  ev = m.pointer({ kind: 'click', x: 2, y: 20 }); t('pointer: a click outside the menu does nothing', ev.length === 0 && m.path() === 'quick');
  m = mk(); m.pointer({ kind: 'wheel', steps: 2 }); t('wheel: two notches down move the cursor two rows', m.view().menu.cursor === 2, String(m.view().menu.cursor));
  m.pointer({ kind: 'wheel', steps: -1 }); t('wheel: one notch up moves back', m.view().menu.cursor === 1);
  m = mk(); press(m, 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'a'); ev = m.pointer({ kind: 'click', x: 100, y: 60 }); t('pointer: a click on the ABOUT window turns the page', m.view().about.page === 1);
  t('pointer: a click outside the ABOUT window does nothing', m.pointer({ kind: 'click', x: 1, y: 150 }).length === 0 && m.view().about.page === 1);
  // ---- determinism and plain views
  const script = (mm) => { const out = []; for (const a of ['down', 'a', 'right', 'down', 'right', 'b', 'down', 'a', 'down', 'right']) { mm.press(a); out.push(J(mm.view())); } return out.join('|'); };
  const d1 = script(mk()), d2 = script(mk()); t('determinism: the same presses give the same views', d1 === d2);
  m = mk(); m.setData(FAKE); press(m, 'down', 'a'); t('views are plain JSON (no undefined, no functions)', plainOk(m.view()).length === 0, plainOk(m.view()).join(','));
  t('views carry no ROM text and no live objects (a JSON round trip is lossless)', J(JSON.parse(J(m.view()))) === J(m.view()));
  m = mk(); t('goto: an unknown screen is ignored', m.goto('nowhere').length === 0 && m.goto('__proto__').length === 0 && m.path() === 'main');
  t('goto: a known screen is entered once', m.goto('quick').length === 1 && m.goto('quick').length === 0 && m.path() === 'quick');
  t('presses of unknown actions are ignored', mk().press('banana').length === 0 && mk().press(undefined).length === 0);
  return f;
}

const MUTANTS = [
  { name: 'START ignores the legality of the team', find: 'if (!t.legal) { S.flash', replace: 'if (false) { S.flash', expect: 'START on an illegal team is blocked' },
  { name: 'a 2-Pokemon team may pick 3v3', find: "return size >= 3 ? ['3v3', '6v6'] : ['6v6'];", replace: "return ['3v3', '6v6'];", expect: 'allowedFormats(2) has no 3v3' },
  { name: 'B on the main menu leaves the game', find: "if (S.path === 'main') return [];\n    const eff", replace: "if (S.path === 'main') return [{ type: 'navigate', url: '/' }];\n    const eff", expect: 'B on the main menu does nothing' },
  { name: 'up does not wrap', find: 'S.cursor[S.path] = (cur + rs.length - 1) % rs.length;', replace: 'S.cursor[S.path] = Math.max(0, cur - 1);', expect: 'up from the first row wraps' },
  { name: 'SOUND toggles without telling the page', find: "S.sound = !S.sound; return [{ type: 'sound', on: S.sound }];", replace: 'S.sound = !S.sound; return [];', expect: 'SOUND toggles on and tells the page' },
  { name: 'the row hit test is half a row low', find: 'const index = Math.floor((y - m.y) / pitch);', replace: 'const index = Math.floor((y - m.y + 6) / pitch);', expect: 'the middle, top edge and bottom edge' },
  { name: 'a click only moves the cursor', find: "if (row && row.kind === 'choice' && h.zone === 'prev') return change(row, -1);\n        return api.press('a');", replace: "if (row && row.kind === 'choice' && h.zone === 'prev') return change(row, -1);\n        return [];", expect: 'a click is cursor + A' },
  { name: 'quick START sends the wrong format', find: 'format: S.quick.format, cpu: S.quick.cpu }]', replace: "format: '3v3', cpu: S.quick.cpu }]", expect: 'START emits one battle effect carrying the chosen format' },
  { name: 'team START loses the team id', find: 'profileId: p.id, teamId: t.id }]', replace: 'profileId: p.id, teamId: null }]', expect: 'START on a legal team emits one battle effect' },
  { name: 'a 5-Pokemon team starts on 3v3', find: "size >= 4 ? '6v6' : size === 3 ? '3v3' : '6v6'", replace: "size >= 6 ? '6v6' : '3v3'", expect: 'a 5-Pokemon team defaults to 6v6' },
  { name: 'the wheel is ignored', find: "      if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); const act", replace: "      if (ev.kind === 'wheel' && false) { const n = Math.abs(ev.steps || 0); const act", expect: 'two notches down move the cursor' },
  { name: 'the TEAM BUILDER row goes to the wrong page', find: "export const BUILDER_URL = '/pokemonarena/editor.html';", replace: "export const BUILDER_URL = '/pokemonarena/editor.htm';", expect: 'TEAM BUILDER navigates to the team builder' },
  { name: 'the left half of a choice row cannot step back', find: "h.zone === 'prev') return change(row, -1);", replace: "h.zone === 'never') return change(row, -1);", expect: 'clicking the left half of a choice row steps BACK' },
  { name: 'A on the last ABOUT page does not go back', find: "return action === 'a' ? back() : [];", replace: 'return [];', expect: 'A on the last page goes back' },
  { name: 'the active profile is not preselected', find: 'S.team.profileId = d.activeId;', replace: 'void 0;', expect: 'the active profile is preselected' },
  // W1: the IMPORT SAVE row and the seven-row geometry
  { name: 'IMPORT SAVE opens the team builder instead of the save-import screen', find: "case 'import': return [{ type: 'navigate', url: IMPORT_URL }];", replace: "case 'import': return [{ type: 'navigate', url: BUILDER_URL }];", expect: 'IMPORT SAVE navigates to the team builder save-import screen' },
  { name: 'IMPORT SAVE does nothing', find: "case 'import': return [{ type: 'navigate', url: IMPORT_URL }];", replace: "case 'import': return [];", expect: 'IMPORT SAVE navigates to the team builder save-import screen' },
  { name: 'the eight-row main menu keeps the 16 px pitch (it would run into the text box)', find: 'return n > 7 ? GEOM.menu.pitchEight : n > 6 ? GEOM.menu.pitchTight : GEOM.menu.pitch;', replace: 'return GEOM.menu.pitch;', expect: 'eight rows sit 12 px apart' },
  { name: 'seven rows are squeezed like eight (the 14 px pitch is lost)', find: 'return n > 7 ? GEOM.menu.pitchEight : n > 6 ? GEOM.menu.pitchTight : GEOM.menu.pitch;', replace: 'return n > 6 ? GEOM.menu.pitchEight : GEOM.menu.pitch;', expect: 'eight rows sit 12 px apart' },
  { name: 'IMPORT SAVE row is dropped from the main menu', find: "  { id: 'import', label: 'IMPORT SAVE',", replace: "  { id: 'importX', label: 'IMPORT SAVE',", expect: 'IMPORT SAVE navigates to the team builder save-import screen' },
];
{
  const real = checkModel(HM);
  ok(real.length === 0, 'M. the state machine passes every check', real.slice(0, 5).join('; '));
  ok(checkModel(HM).length === 0, 'M. unmutated twin stays quiet');
  for (const mu of MUTANTS) {
    let r; try { const M = await loadModel(mu); r = checkModel(M); } catch (e) { r = ['threw: ' + e.message]; }
    ok(r.length > 0 && r.some((x) => x.includes(mu.expect)), 'M. mutant "' + mu.name + '" trips the named check "' + mu.expect + '"', r.length ? r.slice(0, 3).join(' || ') : 'NOT CAUGHT');
  }
}

/* ================================================================================================ R. the ROM renderer */

const ui = B.createBattleUi(rom);
const screen = HS.createHubScreen(ui);
const pack = T.loadPack(rom, { verify: 'header', dexText: false });
const view0 = (fn) => { const m = HM.createHubModel({ mascot: 25, env: 0 }); m.setData(FAKE); if (fn) fn(m); return m.view(); };
const frameHash = (v, s = screen) => L.fnv(s.render(v).rgba);
{
  const f = screen.render(view0());
  ok(f.width === 240 && f.height === 160 && f.rgba.length === 240 * 160 * 4, 'R. a frame is 240x160 RGBA');
  let opaque = true; for (let i = 3; i < f.rgba.length; i += 4) if (f.rgba[i] !== 255) { opaque = false; break; }
  ok(opaque, 'R. every pixel is opaque (nothing is left transparent)');
  const distinct = new Set(); for (let i = 0; i < f.rgba.length; i += 4) distinct.add((f.rgba[i] << 16) | (f.rgba[i + 1] << 8) | f.rgba[i + 2]);
  ok(distinct.size >= 30, 'R. the main screen is a real picture (' + distinct.size + ' distinct colours)');
  ok(frameHash(view0()) === frameHash(view0()), 'R. rendering is deterministic');
  ok(frameHash(view0((m) => m.press('down'))) !== frameHash(view0()), 'R. moving the cursor changes the picture');
  ok(frameHash(view0((m) => m.setEnv(10))) !== frameHash(view0()), 'R. a different terrain changes the picture');
  ok(frameHash(view0((m) => m.setMascot(6))) !== frameHash(view0()), 'R. a different mascot changes the picture');
  ok(frameHash(view0((m) => m.setTick(40))) !== frameHash(view0((m) => m.setTick(0))), 'R. the idle animation frame changes the picture (tick 0 vs 40)');
  ok(frameHash(view0((m) => m.setTick(5))) === frameHash(view0((m) => m.setTick(0))), 'R. ... but only every 32 ticks (tick 5 = tick 0)');
  // every text fits its window: walk the whole state space the menu can reach
  const states = [];
  const walk = (label, fn) => states.push([label, view0(fn)]);
  walk('main', null); for (let i = 1; i < 7; i++) walk('main' + i, (m) => { for (let k = 0; k < i; k++) m.press('down'); });
  walk('sound on', (m) => { for (let k = 0; k < 5; k++) m.press('down'); m.press('a'); });
  for (const fmt of [0, 1]) for (const cpu of [0, 1, 2]) for (const row of [0, 1, 2, 3]) walk('quick f' + fmt + ' c' + cpu + ' r' + row, (m) => { m.press('a'); if (fmt) m.press('right'); m.press('down'); for (let k = 0; k < cpu; k++) m.press('right'); for (let k = 1; k < row; k++) m.press('down'); if (row === 0) { m.press('up'); } if (row === 3) m.press('down'); });
  for (let ti = 0; ti < 5; ti++) for (const row of [0, 1, 2, 3, 4, 5]) walk('team t' + ti + ' r' + row, (m) => { m.press('down'); m.press('a'); m.press('down'); for (let k = 0; k < ti; k++) m.press('right'); for (let k = 0; k < row - 1; k++) m.press('down'); if (row === 0) m.press('up'); });
  walk('team start illegal', (m) => { m.press('down'); m.press('a'); m.press('down'); m.press('right'); m.press('down'); m.press('down'); m.press('down'); m.press('a'); });
  walk('team loading', (m) => { m.setData({ state: 'ready', profiles: [] }); m.press('down'); m.press('a'); });
  for (let p = 0; p < 4; p++) walk('about ' + p, (m) => { for (let k = 0; k < 6; k++) m.press('down'); m.press('a'); for (let k = 0; k < p; k++) m.press('a'); });
  let overflow = [];
  for (const [label, v] of states) for (const w of screen.widths(v)) if (w.px > w.max) overflow.push(label + ': ' + w.what + ' ' + w.px + ' > ' + w.max);
  ok(overflow.length === 0, 'R. every help line, message and about line fits its window in all ' + states.length + ' reachable states', overflow.slice(0, 4).join('; '));
  // the menu labels fit the menu window (the widest is BATTLE WITH MY TEAM) and are drawn in the ROM's NORMAL font
  ok(ui.measure('normal', 'BATTLE WITH MY TEAM') + 12 <= HM.GEOM.menu.w, 'R. the longest menu label fits the menu window in the normal ROM font (' + ui.measure('normal', 'BATTLE WITH MY TEAM') + ' px of ' + (HM.GEOM.menu.w - 12) + ')');
  // long names (a 16-letter team name, a long trainer name) never leave the window
  const long = { state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'WWWWWWWWWWWWWWW', teams: [{ id: 't', name: 'WWWWWWWWWWWWWWWW', size: 3, legal: true, problems: 0, names: ['W'.repeat(10), 'W'.repeat(10), 'W'.repeat(10)], lead: { species: 25 } }] }, { id: 'p2', name: 'B', teams: [] }] };
  const lv = (() => { const m = HM.createHubModel({ mascot: 25 }); m.setData(long); m.press('down'); m.press('a'); return m.view(); })();
  const lf = screen.render(lv);
  const menuRightEdge = HM.GEOM.menu.x + HM.GEOM.menu.w;
  let spill = 0; for (let y = HM.GEOM.menu.y; y < HM.GEOM.menu.y + 4 * 16; y++) for (let x = menuRightEdge - 1; x < menuRightEdge + 5; x++) { const o = (y * 240 + x) * 4; if (lf.rgba[o] === 255 && lf.rgba[o + 1] === 255 && lf.rgba[o + 2] === 255) spill++; }
  ok(frameHash(lv) !== frameHash(view0()), 'R. a 16-letter team name still draws (and differs from the short-name picture)');
  // every mascot species draws a sprite (the frame differs from a frame whose mascot is an id with no art)
  const noArt = frameHash(view0((m) => m.setMascot(1575)));
  const mascots = HD.mascotIds(pack);
  ok(mascots.length >= 10, 'R. at least ten of the mascot names exist in this ROM (' + mascots.length + ' of ' + HD.MASCOT_NAMES.length + ')');
  const missing = mascots.filter((id) => frameHash(view0((m) => m.setMascot(id))) === noArt);
  ok(missing.length === 0, 'R. every mascot species draws its own sprite', J(missing));
  const hashes = new Set(mascots.map((id) => frameHash(view0((m) => m.setMascot(id))))); ok(hashes.size === mascots.length, 'R. and each mascot gives a different picture');
  // provenance: change ROM bytes and the picture must change (the pixels come from the ROM)
  const base = frameHash(view0());
  const zap = (off, len) => { const z = rom.slice(); z.fill(0, off, off + len); return frameHash(view0(), HS.createHubScreen(B.createBattleUi(z))); };
  ok(zap(0x60df24, 0x2000) !== base, 'R. provenance: zeroing the ROM\'s normal-font glyph bytes changes the picture');
  ok(zap(0x6cd02c, 32) !== base, 'R. provenance: zeroing the ROM\'s text colour palette changes the picture');
  ok(zap(0x73a130, 32) !== base, 'R. provenance: zeroing the ROM\'s textbox palette changes the picture');
  const untouched = rom.slice(); ok(frameHash(view0(), HS.createHubScreen(B.createBattleUi(untouched))) === base, 'R. twin: a byte-identical copy of the ROM gives the identical picture');
  // golden hashes
  const GV = {
    'main-0': view0(), 'main-sound': view0((m) => { for (let k = 0; k < 6; k++) m.press('down'); m.press('a'); }), 'quick-format': view0((m) => { m.press('a'); }),
    'quick-6v6-hard': view0((m) => { m.press('a'); m.press('right'); m.press('down'); m.press('right'); }), 'team-kanto': view0((m) => { m.press('down'); m.press('a'); }),
    'team-illegal-start': view0((m) => { m.press('down'); m.press('a'); m.press('down'); m.press('right'); m.press('down'); m.press('down'); m.press('down'); m.press('a'); }),
    'team-empty': view0((m) => { m.setData({ state: 'ready', profiles: [] }); m.press('down'); m.press('a'); }), 'about-0': view0((m) => { for (let k = 0; k < 7; k++) m.press('down'); m.press('a'); }),
    'about-3': view0((m) => { for (let k = 0; k < 7; k++) m.press('down'); m.press('a'); m.press('a'); m.press('a'); m.press('a'); }),
  };
  const got = {}; for (const [k, v] of Object.entries(GV)) got[k] = frameHash(v);
  if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'hashes only (fnv1a of the 240x160 RGBA frame); regenerate with node tools/pokemonarena_hub_test.mjs --update', rom: 'Pokemon SoulGold v1.1.1', views: got }, null, 2) + '\n'); console.log('hub.golden.json written'); }
  const gold = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).views : null;
  ok(!!gold, 'R. golden file exists (pokemonarena/hub.golden.json)');
  if (gold) {
    const bad = Object.keys(got).filter((k) => gold[k] !== got[k]);
    ok(bad.length === 0 && Object.keys(gold).length === Object.keys(got).length, 'R. every golden frame hash matches (' + Object.keys(got).length + ' views)', bad.map((k) => k + ' ' + gold[k] + ' != ' + got[k]).join('; '));
    const f2 = screen.render(GV['main-0']); f2.rgba[(80 * 240 + 120) * 4] ^= 1;
    ok(L.fnv(f2.rgba) !== gold['main-0'], 'R. control: flipping one bit of one pixel no longer matches the golden hash');
  }
}

/* ================================================================================================ D. the store reader */

async function newStore(name) { return ST.openStore({ adapter: ST.createMemoryAdapter({ name, durable: true }), channel: false }); }
function legalMon(name, extra = {}) {
  const sid = pack.species.findIndex((s) => s && s.legal && s.name === name);
  const rec = RU.blankRec(sid, pack, RU.DEFAULT_RULESET_ID);
  const ratio = pack.species[sid].genderRatio;
  return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M', ...extra });
}
async function seedProfile(store, trainerName, teams) {
  const created = await store.createProfile({ trainerName });
  const box = [], tms = [];
  for (const [tname, names] of teams) { const mons = names.map((n) => legalMon(n)); box.push(...mons); tms.push(P.createTeam({ name: tname, monIds: mons.map((m) => m.id) })); }
  return store.saveProfile({ ...created, box, teams: tms }, { reason: 'seed' });
}
{
  const store = await newStore('hubtest-1');
  const p = await seedProfile(store, 'RED', [['Kanto Squad', ['Pikachu', 'Charizard', 'Snorlax']], ['Duo', ['Pikachu', 'Pikachu']], ['Empty', []], ['Solo', ['Eevee']], ['Pair', ['Blastoise', 'Gengar']]]);
  await store.setActiveId(p.id);
  const q = await seedProfile(store, 'BLUE', [['Blue Team', ['Blastoise', 'Gengar']]]);
  const data = await HD.readHubData(store, pack);
  ok(data.state === 'ready' && data.profiles.length === 2 && data.activeId === p.id, 'D. readHubData lists both profiles and the active one', J({ s: data.state, n: data.profiles.length, a: data.activeId }));
  const red = data.profiles.find((x) => x.name === 'RED'), teamOf = (n) => red.teams.find((t) => t.name === n);
  ok(red.teams.length === 5 && teamOf('Kanto Squad').size === 3 && teamOf('Kanto Squad').legal === true && teamOf('Kanto Squad').problems === 0, 'D. a legal 3-Pokemon team is summarised as legal with 0 problems', J(teamOf('Kanto Squad')));
  ok(J(teamOf('Kanto Squad').names) === J(['Pikachu', 'Charizard', 'Snorlax']) && teamOf('Kanto Squad').lead.species === pack.species.findIndex((s) => s && s.legal && s.name === 'Pikachu'), 'D. names and the lead Pokemon are read from the pack');
  ok(teamOf('Duo').legal === false && teamOf('Duo').problems >= 1, 'D. two Pikachu break the species clause: illegal with a problem count', J(teamOf('Duo')));
  ok(teamOf('Empty').legal === false && teamOf('Empty').size === 0 && teamOf('Empty').lead === null, 'D. an empty team is not legal and has no lead');
  ok(teamOf('Solo').legal === true && teamOf('Solo').size === 1, 'D. a one-Pokemon team is legal', J(teamOf('Solo')));
  const r = await HD.teamCodeFor(store, p.id, red.teams[0].id);
  ok(r.ok && /^ARENA1\.[A-Za-z0-9_-]+\.[0-9a-f]{4}$/.test(r.code), 'D. teamCodeFor returns an ARENA1 code', r.code && r.code.slice(0, 30));
  const dec = await TC.decodeTeamCode(r.code);
  ok(dec.ok && dec.team.mons.length === 3 && dec.team.mons[0].species === teamOf('Kanto Squad').lead.species, 'D. the code decodes back to the same three Pokemon');
  ok((await HD.teamCodeFor(store, p.id, 'nope')).ok === false && (await HD.teamCodeFor(store, 'nobody', 'nope')).ok === false, 'D. a missing team / profile gives { ok: false } and never throws');
  const hit = await HD.findTeamForCode(store, r.code);
  ok(hit && hit.profileId === p.id && hit.teamId === red.teams[0].id, 'D. findTeamForCode finds the saved team the code came from', J(hit));
  ok((await HD.findTeamForCode(store, r.code.slice(0, -1) + (r.code.endsWith('0') ? '1' : '0'))) === null, 'D. control: a code that is one character off finds nothing');
  ok((await HD.findTeamForCode(store, '')) === null && (await HD.findTeamForCode(store, null)) === null && (await HD.findTeamForCode(store, 'ARENA1.x.0000')) === null, 'D. empty / hostile codes find nothing and never throw');
  // the rule the hub enforces (a team under 3 plays 6v6 only) is battle.html's own: its resolver refuses 3v3 for two Pokemon and accepts 6v6
  const pairCode = (await HD.teamCodeFor(store, p.id, red.teams.find((t) => t.name === 'Pair').id)).code;
  const r3 = await BB.resolveBattle(pack, { team: pairCode, foe: 'random', seed: 5, format: '3v3', cpu: 'normal' });
  const r6 = await BB.resolveBattle(pack, { team: pairCode, foe: 'random', seed: 5, format: '6v6', cpu: 'normal' });
  ok(r3.ok === false && r3.error.param === 'format' && r6.ok === true && r6.spec.teams[0].length === 2, 'D. the battle page resolver refuses a 2-Pokemon team at 3v3 (param format) and accepts it at 6v6 - the rule the FORMAT row of the hub enforces', J(r3).slice(0, 160));
  ok(!HM.allowedFormats(2).includes('3v3') && HM.allowedFormats(2).includes('6v6'), 'D. and the hub offers exactly the formats the resolver accepts for a 2-Pokemon team');
  // an edit changes the code: the old battle no longer matches (documented behaviour of "Edit team")
  const cur = await store.loadProfile(p.id); const edited = { ...cur.profile, box: cur.profile.box.map((m, i) => (i === 0 ? { ...m, nature: (m.nature + 1) % 25 } : m)) }; await store.saveProfile(edited, { reason: 'edit' });
  ok((await HD.findTeamForCode(store, r.code)) === null, 'D. after the team is edited, its old code no longer matches (Edit team then opens the profile list instead)');
  // links
  ok(HD.battleHref({ mode: 'quick', format: '6v6', cpu: 'hard', seed: 5 }) === '/pokemonarena/battle.html?format=6v6&cpu=hard&seed=5', 'D. battleHref quick');
  const href = HD.battleHref({ mode: 'team', code: r.code, format: '3v3', cpu: 'easy', seed: 4294967295 });
  const pq = BB.parseBattleQuery(href.slice(href.indexOf('?')));
  ok(pq.ok && pq.params.team === r.code && pq.params.format === '3v3' && pq.params.cpu === 'easy' && pq.params.seed === 4294967295, 'D. a team battle link is accepted by battle.html\'s own parser and carries the code', J(pq).slice(0, 160));
  const qh = HD.battleHref({ mode: 'quick', format: '3v3', cpu: 'normal', seed: 0 });
  const qq = BB.parseBattleQuery(qh.slice(qh.indexOf('?')));
  ok(qq.ok && qq.params.quick === true && qq.params.team === null, 'D. a quick battle link is a Quick Battle for battle.html (no team)');
  const bad = (fn) => { try { fn(); return false; } catch (e) { return e instanceof RangeError; } };
  ok(bad(() => HD.battleHref({ mode: 'quick', format: '9v9', cpu: 'hard', seed: 1 })) && bad(() => HD.battleHref({ mode: 'quick', format: '3v3', cpu: 'godlike', seed: 1 })) && bad(() => HD.battleHref({ mode: 'quick', format: '3v3', cpu: 'hard', seed: -1 })) && bad(() => HD.battleHref({ mode: 'quick', format: '3v3', cpu: 'hard', seed: 1.5 })) && bad(() => HD.battleHref({ mode: 'team', code: '<script>', format: '3v3', cpu: 'hard', seed: 1 })) && bad(() => HD.battleHref({ mode: 'nope', format: '3v3', cpu: 'hard', seed: 1 })), 'D. battleHref refuses every value outside the contract (RangeError)');
  ok(HD.editorHref('t_1') === '/pokemonarena/editor.html#/team/t_1' && HD.editorHref('"><x') === '/pokemonarena/editor.html' && HD.editorHref(null) === '/pokemonarena/editor.html', 'D. editorHref links a team id and refuses a hostile one');
  const mascotsD = HD.mascotIds(pack);
  ok(HD.pickMascot(pack, 0) === mascotsD[0] && HD.pickMascot(pack, mascotsD.length) === mascotsD[0] && HD.pickMascot(pack, -1) === mascotsD[mascotsD.length - 1] && HD.pickMascot(pack, 3) === mascotsD[3 % mascotsD.length], 'D. pickMascot is a pure function of the day number and wraps both ways');
  // a store that is memory-only (not saved) is reported
  const mem = await ST.openStore({ adapter: ST.createMemoryAdapter({ name: 'hubtest-2', durable: false }), channel: false });
  const d2 = await HD.readHubData(mem, pack); ok(d2.notSaved === true && d2.state === 'unavailable', 'D. a memory-only store is reported as not saved / unavailable', J({ n: d2.notSaved, s: d2.state }));
  const broken = { status: {}, getActiveId: async () => { throw new Error('x'); }, listProfiles: async () => { throw new Error('boom'); } };
  const d3 = await HD.readHubData(broken, pack); ok(d3.state === 'unavailable' && d3.profiles.length === 0, 'D. a store that throws gives state "unavailable", not an exception');
}

if (UNIT_ONLY) { for (const f of mutantCache.values()) void f; C.finish(); process.exit(process.exitCode || 0); }

/* ================================================================================================ browser sessions */

const url = (q = '') => BASE + '/pokemonarena/' + q;
const HUB = '__arenaHub';
const hv = (page) => page.eval(`${HUB}.view()`);
const where = (page) => page.eval(`${HUB}.model.path()`);
const cursor = (page) => page.eval(`${HUB}.view().menu ? ${HUB}.view().menu.cursor : -1`);
const rowVal = (page, id) => page.eval(`(() => { const r = ${HUB}.view().menu.rows.find((x) => x.id === ${J(id)}); return r ? r.value : null; })()`);
const msgOf = (page) => page.eval(`${HUB}.view().msg.join(' ')`);
const shot = async (page, name) => { await page.screenshot(path.join(OUT, name + '.png')); return name; };
async function boot(page, q = '', { pause = true } = {}) {
  await page.navigate(url(q));
  await page.waitFor(`window.${HUB} && ${HUB}.state !== 'boot'`, { timeoutMs: 90000 });
  const st = await page.eval(`({ state: ${HUB}.state, error: ${HUB}.error })`);
  if (st.state === 'ready') { if (pause) await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`); await page.eval(`window.__nav = []; window.__arenaNavigate = (u) => { window.__nav.push(u); }`); }
  return st.state;
}
const navs = (page) => page.eval('window.__nav.slice()');
// logical y of row i of the menu window (centre), for taps and clicks
// (the main menu has eight rows and so a tighter pitch: mainY(i); every other menu has six or fewer: rowY(i))
const rowY = (i, n = 6) => HM.GEOM.menu.y + i * HM.menuPitch(n) + (HM.menuPitch(n) >> 1);
const mainY = (i) => rowY(i, 8);

async function runSession(name, opts, fn) {
  console.log('--- ' + name + ' (' + opts.width + 'x' + opts.height + (opts.dpr ? ' @' + opts.dpr + 'x' : '') + (opts.mobile ? ' mobile' : '') + ') ' + loadPct());
  try {
    await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
      await page.setViewport(opts.width, opts.height, { mobile: !!opts.mobile, dpr: opts.dpr || 1 });
      if (opts.audio !== false) await addInit(page, AUDIO_DOUBLE);
      if (opts.pad) await addInit(page, PAD_DOUBLE);
      if (opts.init) await addInit(page, opts.init);
      await fn(page);
    });
  } catch (e) { ok(false, name + ': session threw', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}

// seeds IndexedDB from inside the page with the game's own modules (what the editor would have saved)
const SEED_JS = (spec) => `(async () => {
  const S = await import('/pokemonarena/js/store.js'), P = await import('/pokemonarena/js/profile.js'), R = await import('/pokemonarena/js/rules.js'), TB = await import('/pokemonarena/js/tables.js'), RF = await import('/pokemonarena/js/romfetch.js');
  const { bytes } = await RF.loadVerifiedRom();
  const pack = TB.loadPack(bytes, { verify: 'header', dexText: false });
  const store = await S.openStore();
  const mk = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name); const rec = R.blankRec(sid, pack, R.DEFAULT_RULESET_ID); const ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
  const out = [];
  let firstId = null;
  for (const [trainer, teams] of ${J(spec)}) {
    const created = await store.createProfile({ trainerName: trainer });
    const box = [], tms = [];
    for (const [tname, names] of teams) { const mons = names.map(mk); box.push(...mons); tms.push(P.createTeam({ name: tname, monIds: mons.map((m) => m.id) })); }
    const saved = await store.saveProfile({ ...created, box, teams: tms }, { reason: 'seed' });
    if (!firstId) firstId = saved.id;
    out.push({ id: saved.id, teams: saved.teams.map((t) => t.id), species: saved.teams.map((t) => t.monIds.map((id) => saved.box.find((m) => m.id === id).species)) });
  }
  await store.setActiveId(firstId);
  const st = store.status;
  await store.close();
  return { profiles: out, notSaved: st.notSaved };
})()`;
const ACTIVE_JS = `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); const id = await store.getActiveId(); await store.close(); return id; })()`;

let server = null;
try {
  console.log('before the browser: ' + loadPct() + '; reaping leaked browsers');
  L.reapLeaks();
  server = await L.startServer();
  console.log('dev server up on ' + BASE + ' (node tools/devserver.mjs, Range-capable)');
  fs.mkdirSync(OUT, { recursive: true });
  let cdp = CDP0;

  /* ---------------------------------------------------------------------------------------- phone: touch only */
  await runSession('phone, touch only', { width: 390, height: 844, mobile: true, dpr: 3, port: cdp++ }, async (page) => {
    const tag = 'touch: ';
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    ok((await page.eval(`document.body.dataset.pad`)) === 'on', tag + 'the on-screen pad is shown on a touch screen');
    await shot(page, 'hub_touch_1_main');
    // tap QUICK BATTLE on the canvas
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(0)); await sleep(150);
    ok((await where(page)) === 'quick', tag + 'tapping QUICK BATTLE opens the quick screen', await where(page));
    ok((await page.eval('location.hash')) === '#quick', tag + 'the address carries #quick');
    await shot(page, 'hub_touch_2_quick');
    // tap FORMAT (right half cycles forward), tap CPU twice
    await tapLogical(page, `${HUB}.canvas`, 120, rowY(0)); await sleep(120);
    ok((await rowVal(page, 'format')) === '6v6', tag + 'tapping the right half of FORMAT -> 6v6', await rowVal(page, 'format'));
    await tapLogical(page, `${HUB}.canvas`, 110, rowY(1)); await sleep(120); await tapLogical(page, `${HUB}.canvas`, 110, rowY(1)); await sleep(120);
    ok((await rowVal(page, 'cpu')) === 'EASY', tag + 'two taps on CPU: NORMAL -> HARD -> EASY (wraps)', await rowVal(page, 'cpu'));
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(1)); await sleep(120);
    ok((await rowVal(page, 'cpu')) === 'HARD', tag + 'tapping the left half of CPU steps back (EASY -> HARD)', await rowVal(page, 'cpu'));
    // START
    await tapLogical(page, `${HUB}.canvas`, 60, rowY(2)); await sleep(250);
    const n1 = await navs(page);
    ok(n1.length === 1 && /^\/pokemonarena\/battle\.html\?format=6v6&cpu=hard&seed=\d+$/.test(n1[0]), tag + 'tapping START goes to battle.html with the chosen format, CPU and a fresh seed', J(n1));
    const pq = BB.parseBattleQuery(n1[0].slice(n1[0].indexOf('?')));
    ok(pq.ok && pq.params.quick && pq.params.format === '6v6' && pq.params.cpu === 'hard', tag + 'battle.html\'s own parser accepts that address as a Quick Battle', J(pq).slice(0, 120));
    // BACK with the on-screen B button
    await tapSel(page, '#bB'); await sleep(150);
    ok((await where(page)) === 'main', tag + 'the on-screen B button goes back');
    // on-screen pad: down x3 then A -> TEAM BUILDER navigates (ST1: RECORD is the third row, TEAM BUILDER the fourth)
    await tapSel(page, '#bDown'); await sleep(100); await tapSel(page, '#bDown'); await sleep(100); await tapSel(page, '#bDown'); await sleep(100);
    ok((await cursor(page)) === 3, tag + 'the on-screen pad moves the cursor (three downs -> TEAM BUILDER)', String(await cursor(page)));
    await tapSel(page, '#bA'); await sleep(200);
    const n2 = await navs(page); ok(n2.length === 2 && n2[1] === '/pokemonarena/editor.html', tag + 'A on TEAM BUILDER goes to the team builder', J(n2));
    // MY TEAM with no profile
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(1)); await sleep(300);
    ok((await where(page)) === 'team', tag + 'tapping BATTLE WITH MY TEAM opens the team screen');
    ok(/no team yet/i.test(await msgOf(page)) && (await page.eval(`${HUB}.view().menu.rows.map((r) => r.label).join()`)) === 'TEAM BUILDER,BACK', tag + 'with no profile it offers TEAM BUILDER (message: ' + await msgOf(page) + ')');
    await shot(page, 'hub_touch_3_team_empty');
    await tapSel(page, '#bB'); await sleep(120);
    // ABOUT by tapping its window
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(7)); await sleep(150);
    ok((await where(page)) === 'about', tag + 'tapping ABOUT opens it');
    await tapLogical(page, `${HUB}.canvas`, 100, 50); await sleep(120);
    ok((await page.eval(`${HUB}.view().about.page`)) === 1, tag + 'tapping the page turns it');
    await shot(page, 'hub_touch_4_about');
    await tapSel(page, '#bB'); await sleep(100);
    // the Controls dialog from the header button
    await tapSel(page, '#controlsBtn'); await page.waitFor(`${HUB}.dialogOpen()`, { timeoutMs: 8000 });
    const dlg = await page.eval(`(() => { const d = document.getElementById('controlsDialog'); const r = d.getBoundingClientRect(); const btns = [...d.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => { const q = b.getBoundingClientRect(); return [q.width, q.height]; }); return { shown: !d.hidden, panel: !!d.querySelector('.ip'), w: r.width, iw: innerWidth, small: btns.filter(([w, h]) => w < 43.5 || h < 43.5).length, n: btns.length, sw: document.documentElement.scrollWidth }; })()`);
    ok(dlg.shown && dlg.panel && dlg.n >= 4 && dlg.small === 0 && dlg.sw <= dlg.iw, tag + 'the Controls dialog shows the input layer\'s panel, every button >= 44 px, no sideways scroll', J(dlg));
    await shot(page, 'hub_touch_5_controls');
    await tapSel(page, '#controlsClose'); await sleep(200);
    ok(!(await page.eval(`${HUB}.dialogOpen()`)) && (await page.eval(`document.getElementById('controlsDialog').hidden`)), tag + 'Close closes it');
    ok((await page.eval('document.activeElement && document.activeElement.id')) === 'hub', tag + 'and focus goes back to the menu canvas', await page.eval('document.activeElement && document.activeElement.id'));
    // sound button via touch: counted on the double, never real. MU3's policy: sound is ON by default (heard from the first tap / click / key) and the header button OPENS the SOUND panel, it does not toggle
    await tapSel(page, '#soundBtn'); await sleep(400);
    const lg = await page.eval('window.__audioLog');
    ok((await page.eval(`${HUB}.sound.on()`)) === true && lg.ctor === 1, tag + 'sound is on by default and the taps so far created exactly one (fake) AudioContext, none of them a toggle', J(lg));
    ok((await page.eval(`(() => { const d = document.getElementById('soundDialog'); const b = document.getElementById('soundBtn'); return !!d && !d.hidden && b.textContent === 'Sound: on' && b.getAttribute('aria-haspopup') === 'dialog' && !b.hasAttribute('aria-pressed'); })()`)), tag + 'the Sound button reads "Sound: on", is a dialog opener (no aria-pressed) and opened the SOUND panel');
    await tapSel(page, '#soundDialog [data-snd="close"]'); await sleep(250);
    ok((await page.eval(`document.getElementById('soundDialog').hidden`)) === true, tag + 'Close closes the SOUND panel');
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- desktop: keyboard + mouse */
  await runSession('desktop, keyboard and mouse', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'kbd+mouse: ';
    // the arm-difference proof: this arm must really be a desktop (hover:hover + pointer:fine), and the check that says so must be able to fail
    ok(!!page.arm && page.arm.ok && page.arm.claimed === 'desktop', tag + 'ARM: the desktop arm reports hover:hover + pointer:fine (' + J(page.arm && page.arm.media) + ')');
    ok((await armFacts({ eval: async () => ({ hoverHover: false, hoverNone: true, ptrFine: false, ptrCoarse: false, maxTouch: 0 }) }, 'desktop')).ok === false, tag + 'ARM control: a page that reports hover:none is NOT accepted as a desktop arm (the arm check is not a placebo)');
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    ok((await page.eval(`document.body.dataset.pad`)) === 'off', tag + 'no touch pad on a desktop');
    ok((await page.eval(`${HUB}.sound.on()`)) === true && (await page.eval(`localStorage.getItem('arena.audio')`)) === null && (await page.eval(`localStorage.getItem('arena.sound')`)) === null && (await page.eval('window.__audioLog.ctor')) === 0, tag + 'SOUND IS ON BY DEFAULT (MU3): nothing stored, and no AudioContext is created before the first click, tap or key');
    // keyboard: down x3, Enter -> TEAM BUILDER (ST1: RECORD sits between BATTLE WITH MY TEAM and TEAM BUILDER)
    await key(page, 'down'); await key(page, 'down'); await key(page, 'down'); await sleep(80);
    ok((await cursor(page)) === 3, tag + 'three ArrowDown presses reach TEAM BUILDER');
    await key(page, 'a'); await sleep(200);
    ok(J(await navs(page)) === J(['/pokemonarena/editor.html']), tag + 'Enter on TEAM BUILDER navigates to the team builder', J(await navs(page)));
    // Z opens quick, ArrowRight cycles, Backspace goes back
    await page.eval(`${HUB}.press('up'); ${HUB}.press('up'); ${HUB}.press('up')`);
    await key(page, 'z'); await sleep(120);
    ok((await where(page)) === 'quick', tag + 'Z opens QUICK BATTLE');
    await key(page, 'right'); await sleep(80);
    ok((await rowVal(page, 'format')) === '6v6', tag + 'ArrowRight changes FORMAT to 6v6');
    await key(page, 'left'); await sleep(80); ok((await rowVal(page, 'format')) === '3v3', tag + 'ArrowLeft changes it back');
    await key(page, 'b'); await sleep(120); ok((await where(page)) === 'main', tag + 'Backspace goes back');
    await key(page, 'z'); await sleep(100); await key(page, 'esc'); await sleep(120); ok((await where(page)) === 'main', tag + 'Escape goes back too');
    // mouse: hover moves the cursor without activating
    const p3 = await logicalToPage(page, `${HUB}.canvas`, 60, mainY(5));
    await moveMouse(page, p3.x, p3.y); await sleep(120);
    ok((await cursor(page)) === 5 && (await where(page)) === 'main', tag + 'hovering the CONTROLS row moves the cursor and activates nothing');
    ok((await page.eval(`getComputedStyle(${HUB}.canvas).cursor`)) === 'pointer', tag + 'the mouse pointer becomes a hand over a row', await page.eval(`getComputedStyle(${HUB}.canvas).cursor`));
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(0)); await sleep(150);
    ok((await where(page)) === 'quick', tag + 'a click on QUICK BATTLE opens it');
    await clickLogical(page, `${HUB}.canvas`, 110, rowY(1)); await sleep(100);
    ok((await rowVal(page, 'cpu')) === 'HARD', tag + 'a click on CPU cycles it');
    const pb = await logicalToPage(page, `${HUB}.canvas`, 60, rowY(1));
    await rightClick(page, pb.x, pb.y); await sleep(150);
    ok((await where(page)) === 'main', tag + 'a RIGHT click on the canvas is B (back) and opens no context menu');
    // wheel
    const pw = await logicalToPage(page, `${HUB}.canvas`, 60, mainY(0));
    await moveMouse(page, pw.x, pw.y); await sleep(60); await wheel(page, pw.x, pw.y, 100); await sleep(150);
    const c1 = await cursor(page); await wheel(page, pw.x, pw.y, -100); await sleep(150); const c0 = await cursor(page);
    ok(c1 > c0 && c1 - c0 === 1, tag + 'the mouse wheel moves the cursor down and up one row per notch', c0 + ' -> ' + c1);
    await shot(page, 'hub_kbd_1_main');
    // history: screens are real history entries
    const hist0 = await page.eval('history.length');
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(7)); await sleep(150);   // ABOUT
    ok((await where(page)) === 'about' && (await page.eval('location.hash')) === '#about' && (await page.eval('history.state && history.state.arenaHub')) === 'about', tag + 'opening ABOUT pushes a history entry for it (#about, state arenaHub=about)');
    await page.eval('history.back()'); await sleep(250);
    ok((await where(page)) === 'main' && (await page.eval('location.hash')) === '', tag + 'the browser Back button returns to the main menu', await page.eval('location.hash'));
    await page.eval('history.forward()'); await sleep(250);
    ok((await where(page)) === 'about', tag + 'and Forward returns to ABOUT');
    await shot(page, 'hub_kbd_2_about');
    for (let i = 0; i < 3; i++) { await key(page, 'a'); await sleep(60); }
    ok((await page.eval(`${HUB}.view().about.last`)) === true, tag + 'Enter x3 reaches the last ABOUT page');
    await key(page, 'a'); await sleep(150); ok((await where(page)) === 'main', tag + 'Enter on the last page returns to the menu');
    // B and the browser's Back button share ONE history: opening a screen and leaving it with B must not pile up entries
    await boot(page);
    const L0 = await page.eval('history.length');
    for (let i = 0; i < 3; i++) { await clickLogical(page, `${HUB}.canvas`, 60, mainY(7)); await sleep(120); await key(page, 'b'); await sleep(250); }
    const L1 = await page.eval('history.length');
    ok(L1 - L0 <= 1 && (await page.eval('location.hash')) === '' && (await where(page)) === 'main', tag + 'three ABOUT / B round trips add at most one history entry in total, not six (' + L0 + ' -> ' + L1 + ')', L0 + ' -> ' + L1);
    // control: make the page's "step back" push a NEW entry instead (the old behaviour) and the same round trips must pile the history up
    await page.eval(`history.back = () => history.pushState({}, '', location.pathname)`);
    const L2 = await page.eval('history.length');
    for (let i = 0; i < 3; i++) { await clickLogical(page, `${HUB}.canvas`, 60, mainY(7)); await sleep(120); await key(page, 'b'); await sleep(250); }
    const L3 = await page.eval('history.length');
    ok(L3 - L2 >= 5, tag + 'control: when B pushes a new entry instead of stepping back, three round trips pile up ' + (L3 - L2) + ' entries (so the check above can fail)', L2 + ' -> ' + L3);
    await boot(page);
    // sound: Enter on SOUND (cursor 6); double counts; persisted
    await page.eval(`${HUB}.model.goto('main')`);
    while ((await cursor(page)) !== 6) await key(page, 'down');
    await key(page, 'a'); await sleep(400);
    // MU3's policy: Enter on SOUND OPENS the SOUND panel (it no longer toggles); that Enter is the first gesture, so it created the page's one (fake) AudioContext
    const soundOpen = () => page.eval(`(() => { const d = document.getElementById('soundDialog'); return !!d && !d.hidden; })()`);
    let lg = await page.eval('window.__audioLog');
    ok((await soundOpen()) && lg.ctor === 1 && (await page.eval(`${HUB}.sound.on()`)) === true, tag + 'Enter on SOUND opens the SOUND panel; the key press created exactly one fake AudioContext and sound is on', J(lg));
    ok((await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: on' && (await page.eval(`${HUB}.view().menu.rows[6].label`)) === 'SOUND: ON', tag + 'the header button and the menu row both say ON');
    await shot(page, 'hub_kbd_3_sound_on');
    await key(page, 'esc'); await sleep(300);
    ok(!(await soundOpen()), tag + 'Esc closes the SOUND panel in one press');
    // the M key mutes and unmutes on any page; the setting is stored as arena.audio (JSON, v:1)
    const pressM = async () => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', text: 'm', windowsVirtualKeyCode: 77 }); await sleep(40); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }); await sleep(250); };
    await pressM();
    const st1 = JSON.parse((await page.eval(`localStorage.getItem('arena.audio')`)) || 'null');
    ok(st1 && st1.v === 1 && st1.muted === true && (await page.eval(`${HUB}.sound.on()`)) === false && (await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: off' && (await page.eval(`${HUB}.view().menu.rows[6].label`)) === 'SOUND: OFF', tag + 'M mutes: arena.audio {v:1, muted:true}, the button and the menu row say OFF', J(st1));
    await pressM();
    const st2 = JSON.parse((await page.eval(`localStorage.getItem('arena.audio')`)) || 'null');
    ok(st2 && st2.muted === false && (await page.eval(`${HUB}.sound.on()`)) === true, tag + 'M again unmutes', J(st2));
    // a muted setting survives a reload (and creates no AudioContext before a gesture); the old arena.sound key is migrated once
    await page.eval(`localStorage.setItem('arena.audio', JSON.stringify({ v: 1, master: 0.7, music: 0.6, fx: 0.8, muted: true, soundtrack: 'soulgold' }))`);
    await boot(page);
    ok((await page.eval(`${HUB}.sound.on()`)) === false && (await page.eval('window.__audioLog.ctor')) === 0 && (await page.eval(`document.getElementById('soundBtn').textContent`)) === 'Sound: off', tag + 'after a reload a muted setting is still muted and no AudioContext exists before a gesture');
    await key(page, 'down'); await sleep(200);
    ok((await page.eval('window.__audioLog.ctor')) === 1, tag + 'the first key press creates the (fake) AudioContext even when muted (a controller can unmute later)');
    await page.eval(`localStorage.removeItem('arena.audio'); localStorage.setItem('arena.sound', '0')`);
    await boot(page);
    ok((await page.eval(`${HUB}.sound.on()`)) === false && JSON.parse((await page.eval(`localStorage.getItem('arena.audio')`)) || 'null') !== null, tag + 'the old arena.sound "0" is migrated once: muted, and arena.audio is written');
    await page.eval(`localStorage.removeItem('arena.audio'); localStorage.setItem('arena.sound', '0')`);
    // Controls dialog by keyboard
    await boot(page);
    while ((await cursor(page)) !== 5) await key(page, 'down');
    await key(page, 'a'); await page.waitFor(`${HUB}.dialogOpen()`, { timeoutMs: 8000 });
    const c3 = await cursor(page);
    ok((await page.eval(`document.getElementById('controlsDialog').getAttribute('aria-modal')`)) === 'true' && (await page.eval(`!!document.querySelector('#controlsDialog .ip')`)), tag + 'Enter on CONTROLS opens the modal dialog with the input panel');
    await shot(page, 'hub_kbd_4_controls');
    ok((await page.eval(`document.activeElement && document.activeElement.closest('#controlsDialog') !== null`)) === true, tag + 'focus moved into the dialog', await page.eval('document.activeElement && document.activeElement.tagName + "#" + document.activeElement.id'));
    await page.eval(`window.__nav.length = 0`);
    await key(page, 'esc'); await sleep(250);
    ok(!(await page.eval(`${HUB}.dialogOpen()`)), tag + 'Escape (B) closes the dialog', await page.eval(`${HUB}.dialogOpen()`));
    ok((await cursor(page)) === c3 && (await where(page)) === 'main' && (await navs(page)).length === 0, tag + 'the key that closed the dialog did not also act on the menu behind it (cursor stays on CONTROLS, nothing navigated)', c3 + ' / ' + (await cursor(page)));
    ok((await page.eval('document.activeElement && document.activeElement.id')) === 'hub', tag + 'focus returns to the canvas');
    // the menu is inert while the dialog is open
    await key(page, 'a'); await page.waitFor(`${HUB}.dialogOpen()`, { timeoutMs: 8000 });
    const before = await cursor(page);
    await page.eval(`${HUB}.canvas.focus()`); await key(page, 'down'); await key(page, 'down'); await sleep(100);
    ok((await cursor(page)) === before, tag + 'while the dialog is open the menu cursor does not move', before + ' -> ' + (await cursor(page)));
    await key(page, 'esc'); await sleep(250);
    // deep links
    await boot(page, '#about');
    ok((await where(page)) === 'about' && (await page.eval('document.title')) === 'Pokemon Arena - About', tag + 'a #about deep link opens ABOUT (title follows)');
    await boot(page, '#%3Cscript%3Ewindow.__x=1%3C/script%3E');
    ok((await where(page)) === 'main' && (await page.eval('window.__x')) === undefined, tag + 'a hostile #hash is ignored: the main menu opens, nothing runs');
    await boot(page, '?team=ARENA1.zzz.0000&seed=7&x=<b>');
    ok((await where(page)) === 'main' && (await page.eval(`document.body.innerHTML.includes('<b>')`)) === false, tag + 'battle parameters on the hub address are ignored (nothing echoed)');
    // layout
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- the synthetic controller alone */
  await runSession('synthetic controller only', { width: 1280, height: 800, port: cdp++, pad: true }, async (page) => {
    const tag = 'pad: ';
    ok((await boot(page)) === 'ready', tag + 'the hub reaches ready');
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await padPress(page, 13);                                           // d-pad down
    ok((await cursor(page)) === 1, tag + 'D-pad down moves the cursor (SYNTHETIC controller)', String(await cursor(page)));
    await padPress(page, 12);
    ok((await cursor(page)) === 0, tag + 'D-pad up moves it back');
    await padPress(page, 0);                                            // A (Xbox south)
    ok((await where(page)) === 'quick', tag + 'A opens QUICK BATTLE');
    await padPress(page, 15);
    ok((await rowVal(page, 'format')) === '6v6', tag + 'D-pad right changes FORMAT');
    await page.eval(`window.__pad.axes[1] = 1`); await sleep(160); await page.eval(`window.__pad.axes[1] = 0`); await sleep(120);
    ok((await cursor(page)) === 1, tag + 'the left stick down moves the cursor', String(await cursor(page)));
    await padPress(page, 1);                                            // B
    ok((await where(page)) === 'main', tag + 'B goes back');
    await padPress(page, 9);                                            // Start: nothing on the hub
    ok((await where(page)) === 'main', tag + 'Start does nothing harmful on the menu');
    // W1 fix A7: a controller had no way off the main menu: B asks, a second B leaves for the site (the navigation is stubbed so the page stays)
    await page.eval(`window.__arenaNavigate = (u) => { window.__navTo = u; }`);
    await padPress(page, 1);
    ok((await page.eval(`JSON.stringify(${HUB}.view()).includes('Press B again')`)) && !(await page.eval(`window.__navTo`)), tag + 'A7: B on the main menu asks "Press B again to leave" and does not leave yet');
    await padPress(page, 1);
    ok((await page.eval(`window.__navTo`)) === '/', tag + 'A7: a second B leaves for the site', String(await page.eval(`window.__navTo`)));
    await page.eval(`window.__navTo = null`);
    for (let i = 0; i < 5; i++) await padPress(page, 13);
    await padPress(page, 0); await page.waitFor(`${HUB}.dialogOpen()`, { timeoutMs: 8000 });
    ok(true, tag + 'A on CONTROLS opens the dialog');
    await padPress(page, 1); await sleep(200);
    ok(!(await page.eval(`${HUB}.dialogOpen()`)), tag + 'B closes the Controls dialog (a controller user is never trapped)');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- teams from a seeded IndexedDB */
  await runSession('teams from IndexedDB', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'teams: ';
    await page.navigate(url());
    await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready'`, { timeoutMs: 90000 });
    const spec = [['RED', [['Kanto Squad', ['Pikachu', 'Charizard', 'Snorlax']], ['Pair', ['Pikachu', 'Pikachu']], ['Duo', ['Blastoise', 'Gengar']], ['Empty', []]]], ['BLUE', [['Blue Team', ['Lapras', 'Eevee', 'Gyarados', 'Venusaur']]]]];
    const seeded = await page.eval(SEED_JS(spec));
    ok(seeded.profiles.length === 2 && seeded.notSaved === false, tag + 'two profiles were seeded into real IndexedDB', J(seeded).slice(0, 200));
    const [red, blue] = seeded.profiles;
    ok((await boot(page)) === 'ready', tag + 'the hub boots with the seeded store');
    await page.waitFor(`${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 2`, { timeoutMs: 15000 });
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(1)); await sleep(250);
    ok((await where(page)) === 'team', tag + 'BATTLE WITH MY TEAM opens the team screen');
    ok((await page.eval(`${HUB}.view().menu.rows.map((r) => r.label).join()`)) === 'TRAINER,TEAM,FORMAT,CPU,START,BACK', tag + 'rows: TRAINER, TEAM, FORMAT, CPU, START, BACK (two profiles)', await page.eval(`${HUB}.view().menu.rows.map((r) => r.label).join()`));
    ok((await rowVal(page, 'profile')) === 'RED' && (await rowVal(page, 'teamsel')) === 'Kanto Squad' && (await rowVal(page, 'format')) === '3v3', tag + 'the active profile RED and its first team are preselected, 3v3');
    ok((await page.eval(`${HUB}.view().mascot.species`)) === red.species[0][0], tag + 'the team\'s lead (Pikachu) stands on the screen');
    await shot(page, 'hub_teams_1_team');
    // START -> the url carries a code that decodes to the same three species
    await page.eval(`${HUB}.model.pointer({ kind: 'move', x: 60, y: ${rowY(4)} })`);
    await key(page, 'a'); await sleep(500);
    const n = await navs(page);
    ok(n.length === 1 && /^\/pokemonarena\/battle\.html\?team=ARENA1\./.test(n[0]), tag + 'START on the legal team goes to battle.html?team=ARENA1...', J(n).slice(0, 120));
    const q = n[0] ? n[0].slice(n[0].indexOf('?')) : '';
    const pq = BB.parseBattleQuery(q);
    ok(pq.ok && pq.params.format === '3v3' && pq.params.cpu === 'normal' && pq.params.foe === 'random' && pq.params.seed !== null, tag + 'battle.html\'s parser accepts it: 3v3, normal CPU, random foe, a seed', J(pq).slice(0, 160));
    const dec = pq.ok ? await TC.decodeTeamCode(pq.params.team) : { ok: false };
    ok(dec.ok && J(dec.team.mons.map((m) => m.species)) === J(red.species[0]), tag + 'the team code in the address decodes to exactly the saved team (species ' + (dec.ok ? dec.team.mons.map((m) => m.species).join(',') : '?') + ')');
    ok((await page.eval(ACTIVE_JS)) === red.id, tag + 'the store\'s active profile is the one used (RED)');
    // illegal team: Pair (two Pikachu) -> START blocked
    const goRow = (id) => page.eval(`(() => { for (let i = 0; i < 8; i++) { const v = ${HUB}.view(); if (v.menu.rows[v.menu.cursor].id === ${J(id)}) return true; ${HUB}.press('down'); } return false; })()`);
    const pressA = (a) => page.eval(`${HUB}.press(${J(a)})`);
    await page.eval(`window.__nav.length = 0; ${HUB}.model.goto('main'); ${HUB}.model.goto('team')`);
    await goRow('teamsel'); await pressA('right');
    ok((await rowVal(page, 'teamsel')) === 'Pair', tag + 'right on TEAM selects the next team (Pair)', await rowVal(page, 'teamsel'));
    ok((await rowVal(page, 'format')) === '6v6', tag + 'a 2-Pokemon team is on 6v6');
    await goRow('format'); await pressA('right'); await pressA('right');
    ok((await rowVal(page, 'format')) === '6v6', tag + 'FORMAT cannot be moved to 3v3 on a 2-Pokemon team (battle.html would refuse it)');
    await goRow('start');
    await key(page, 'a'); await sleep(300);
    ok((await navs(page)).length === 0 && /problem/.test(await msgOf(page)), tag + 'START on the illegal team does not leave the hub and says why: "' + await msgOf(page) + '"');
    await shot(page, 'hub_teams_2_illegal');
    ok((await page.eval(`${HUB}.view().menu.rows.find((r) => r.id === 'start').disabled`)) === true, tag + 'the START row is drawn greyed out');
    // legal two-Pokemon team: Duo -> 6v6 only, START works
    await goRow('teamsel'); await pressA('right');
    ok((await rowVal(page, 'teamsel')) === 'Duo' && (await rowVal(page, 'format')) === '6v6', tag + 'Duo (Blastoise, Gengar) is legal and starts on 6v6', (await rowVal(page, 'teamsel')) + ' ' + (await rowVal(page, 'format')));
    await goRow('start'); await key(page, 'a'); await sleep(500);
    const n2 = await navs(page);
    ok(n2.length === 1 && /format=6v6/.test(n2[0]), tag + 'START on Duo goes to battle.html with format=6v6', J(n2).slice(0, 100));
    // empty team
    await page.eval(`window.__nav.length = 0`);
    await goRow('teamsel'); await pressA('right');
    ok((await rowVal(page, 'teamsel')) === 'Empty', tag + 'the empty team is listed', await rowVal(page, 'teamsel'));
    await goRow('start'); await pressA('a'); await sleep(200);
    ok((await navs(page)).length === 0, tag + 'START on an empty team goes nowhere');
    // second trainer
    await page.eval(`${HUB}.model.goto('main'); ${HUB}.model.goto('team')`);
    await goRow('profile'); await pressA('right');
    ok((await rowVal(page, 'profile')) === 'BLUE' && (await rowVal(page, 'teamsel')) === 'Blue Team' && (await rowVal(page, 'format')) === '6v6', tag + 'right on TRAINER switches to BLUE (a 4-Pokemon team starts on 6v6)', (await rowVal(page, 'profile')) + ' ' + (await rowVal(page, 'teamsel')) + ' ' + (await rowVal(page, 'format')));
    await goRow('cpu'); await pressA('right'); await goRow('start'); await pressA('a'); await sleep(500);
    const n3 = await navs(page);
    ok(n3.length === 1 && /cpu=hard/.test(n3[0]), tag + 'BLUE, CPU hard: START goes to battle.html with cpu=hard', J(n3).slice(0, 120));
    ok((await page.eval(ACTIVE_JS)) === blue.id, tag + 'and the active profile becomes BLUE');
    // remembered settings
    await boot(page);
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(0)); await sleep(150);
    await page.eval(`${HUB}.press('right'); ${HUB}.press('down'); ${HUB}.press('right')`);
    await page.eval(`${HUB}.press('down'); ${HUB}.press('a')`); await sleep(300);           // START quick (saves settings)
    await boot(page, '#quick');
    ok((await rowVal(page, 'format')) === '6v6' && (await rowVal(page, 'cpu')) === 'HARD', tag + 'quick-battle settings (6v6 / HARD) are remembered across a reload', (await rowVal(page, 'format')) + ' ' + (await rowVal(page, 'cpu')));
    await boot(page);
    await page.eval(`${HUB}.model.goto('team')`);
    ok((await rowVal(page, 'profile')) === 'BLUE' && (await rowVal(page, 'cpu')) === 'HARD', tag + 'the last team selection (BLUE, CPU HARD) is remembered across a reload', (await rowVal(page, 'profile')) + ' ' + (await rowVal(page, 'cpu')));
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- a hover:none laptop / tablet with a mouse attached (W1 fix A4)
     the page cannot know which device the player will use next: the on-screen pad shows at the first TOUCH and goes away at the first MOUSE move */
  async function padFollowsDevice(page, base) {
    const r = {};
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });                         // the arm: a touch device (pointer:coarse, hover:none) ...
    r.arm = await page.eval(`({ hoverNone: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches })`);
    await page.navigate(base + '/pokemonarena/');
    await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready'`, { timeoutMs: 90000 });
    await page.eval(`${HUB}.pause(true)`);
    r.start = await page.eval(`document.body.dataset.pad`);
    const p = await logicalToPage(page, `${HUB}.canvas`, 60, mainY(2));
    await moveMouse(page, p.x, p.y); await sleep(800);                                               // ... with a real mouse attached (the layout follows the gesture by 450 ms)
    r.afterMouse = await page.eval(`document.body.dataset.pad`);
    await page.tap(p.x, p.y); await sleep(800);
    r.afterTouch = await page.eval(`document.body.dataset.pad`);
    return r;
  }
  const PADFOLLOW_CHECKS = (r) => [['the arm is a touch device (hover:none, pointer:coarse)', r.arm.hoverNone && r.arm.coarse], ['the pad is shown at the start on a touch device', r.start === 'on'], ['the first mouse move takes the pad away', r.afterMouse === 'off'], ['the next touch brings it back', r.afterTouch === 'on']];
  await runSession('touch laptop with a mouse', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const r = await padFollowsDevice(page, BASE);
    for (const [n, c] of PADFOLLOW_CHECKS(r)) ok(c === true, 'pad-follows-device: ' + n, J(r));
  });
  await runSession('touch laptop with a mouse negative control', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hub-pad-'));
    const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
    mutateFile(d, 'js/boot.js', "else if (e.source === 'mouse' && touchPad) padTo(false); });", '});');
    const ov = await startOverlay({ dir: d, port: L.PORT + 11, upstream: BASE });
    try {
      const r = await padFollowsDevice(page, ov.url);
      ok(PADFOLLOW_CHECKS(r).some(([, c]) => c !== true) && r.afterMouse !== 'off', 'pad-follows-device negative control: without the mouse rule the pad stays and the check FAILS', J(r));
    } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  });

  /* ---------------------------------------------------------------------------------------- negative control for the sound default (MU3's policy: ON) */
  await runSession('sound default negative control', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'default-control: ';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-hub-snd-'));
    const d = copyTree(path.join(root, 'pokemonarena'), path.join(tmp, 'pokemonarena'));
    mutateFile(d, 'js/audio_mixer.js', "muted: false, soundtrack: 'soulgold' });", "muted: true, soundtrack: 'soulgold' });");          // the OLD default: sound off until the player turns it on
    const ov = await startOverlay({ dir: d, port: L.PORT + 10, upstream: BASE });
    try {
      await page.navigate(ov.url + '/pokemonarena/');
      await page.waitFor(`window.${HUB} && ${HUB}.state === 'ready'`, { timeoutMs: 90000 });
      ok((await page.eval(`${HUB}.sound.on()`)) === false, tag + 'with the old default restored the "SOUND IS ON BY DEFAULT" check FAILS (sound.on() is false), so that check can fail');
    } finally { ov.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  });

  /* ---------------------------------------------------------------------------------------- a tampered remembered value */
  // (the value is planted before any page script runs: the page writes its own settings back on pagehide, so a planted value could not survive a reload)
  const TAMPER = "try { localStorage.setItem('arena.hub', JSON.stringify({ quick: { format: '13v13', cpu: '<b>' }, team: { profileId: { x: 1 }, teamId: 'x'.repeat(500), cpu: 'godlike' } })); localStorage.setItem('arena.sound', 'yes'); } catch (e) {}";
  await runSession('tampered remembered settings', { width: 1280, height: 800, port: cdp++, init: TAMPER }, async (page) => {
    const tag = 'tamper: ';
    ok((await boot(page, '#quick')) === 'ready', tag + 'the hub boots with a tampered settings value');
    ok((await rowVal(page, 'format')) === '3v3' && (await rowVal(page, 'cpu')) === 'NORMAL', tag + 'a tampered remembered value falls back to the defaults (3v3 / NORMAL)', (await rowVal(page, 'format')) + ' ' + (await rowVal(page, 'cpu')));
    // MU3: the old arena.sound is migrated only when it is exactly "1" or "0"; anything else is ignored and the default (sound ON, nothing created before a gesture) applies
    ok((await page.eval(`${HUB}.sound.on()`)) === true && (await page.eval('window.__audioLog.ctor')) === 0, tag + 'a tampered old sound value ("yes") is ignored: the default applies (sound on, no AudioContext before a gesture)');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ---------------------------------------------------------------------------------------- storage blocked */
  await runSession('storage blocked', { width: 390, height: 844, mobile: true, dpr: 3, port: cdp++, init: "(() => { const bad = () => { throw new DOMException('blocked', 'SecurityError'); }; try { Object.defineProperty(window, 'indexedDB', { get: bad, configurable: true }); } catch (_e) {} })();" }, async (page) => {
    const tag = 'blocked: ';
    ok((await boot(page)) === 'ready', tag + 'the hub still boots with IndexedDB blocked');
    await page.waitFor(`${HUB}.data && ${HUB}.data.state`, { timeoutMs: 20000 });
    const note = await page.eval(`({ hidden: document.getElementById('note').hidden, text: document.getElementById('note').textContent })`);
    ok(note.hidden === false && /not keeping profiles/.test(note.text), tag + 'a visible notice says teams cannot be kept here', J(note));
    await clickLogical(page, `${HUB}.canvas`, 60, mainY(1)); await sleep(250);
    ok(/could not be read|no team yet|not keeping/i.test(await msgOf(page)) || (await page.eval(`${HUB}.data.state`)) === 'unavailable', tag + 'MY TEAM says so instead of showing an empty list', await msgOf(page));
    await shot(page, 'hub_blocked_team');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });
} finally {
  L.stopServer(server);
  L.reapLeaks();
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith('arena-hub-mutant-' + process.pid)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_e) { /* ignore */ } }
}
C.finish();
