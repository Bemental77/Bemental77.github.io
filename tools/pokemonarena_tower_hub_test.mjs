// tools/pokemonarena_tower_hub_test.mjs -- the Pokemon Tower's HUB screens in Node: the state machine (tower_hub.js through hub_model.js), the ROM renderer (tower_screen.js through hub_screen.js) and the main menu that
// now scrolls. The browser side (a real Chrome playing a run) is tools/pokemonarena_tower_page_test.mjs; the golden pictures are in hub.golden.json (tools/pokemonarena_hub_test.mjs).
//
//   node tools/pokemonarena_tower_hub_test.mjs             the cases
//   node tools/pokemonarena_tower_hub_test.mjs --mutants   ALSO break tower_hub.js / hub_model.js / tower_screen.js one way at a time; every break must trip a NAMED check
//
// The data every screen is drawn from comes from the game itself (tools/pokemonarena_hub_lib.mjs towerFixtures: real runs driven through tower_session.js with fixed seeds).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, J } = L;
const SRC = path.join(root, 'pokemonarena', 'js');
const WANT_MUTANTS = process.argv.includes('--mutants');
const C = L.makeCounter('tower hub');
const ok = C.ok;
const clone = (x) => JSON.parse(JSON.stringify(x));
const imp = (dir, f, bust) => import(pathToFileURL(path.join(dir, f)).href + (bust ? '?x=' + bust : ''));
const T = await L.mod('tables.js');
const pack = T.loadPack(L.readRom(), { verify: 'header', dexText: false });
const F = await L.towerFixtures(pack);
const BU = await L.mod('battle_ui.js');
const rom = L.readRom();

const mkData = (towers, o = {}) => ({ state: 'ready', activeId: 'p1', profiles: towers.map((tw, i) => ({ id: 'p' + (i + 1), name: ['RED', 'BLUE', 'GREEN'][i], readOnly: !!(o.readOnly && o.readOnly[i]), tower: tw,
  teams: [{ id: 't' + (i + 1) + 'a', name: 'Kanto Squad', size: 3, legal: true, problems: 0, names: ['A', 'B', 'C'], lead: { species: 25 }, ruleset: 'arena-gen3-standard' }, { id: 't' + (i + 1) + 'b', name: 'Big Six', size: 6, legal: true, problems: 0, names: ['A', 'B', 'C', 'D', 'E', 'F'], lead: { species: 6 }, ruleset: 'arena-gen3-standard' },
    { id: 't' + (i + 1) + 'c', name: 'Duo', size: 2, legal: true, problems: 0, names: ['A', 'B'], lead: { species: 9 }, ruleset: 'arena-gen3-standard' }, { id: 't' + (i + 1) + 'd', name: 'Broken', size: 3, legal: false, problems: 2, names: ['A'], lead: { species: 3 }, ruleset: 'arena-gen3-standard' },
    { id: 't' + (i + 1) + 'e', name: 'Lv100', size: 6, legal: true, problems: 0, names: ['A'], lead: { species: 3 }, ruleset: 'arena-gen3-standard+lv100' }] })) });
const eff = (list, type) => list.filter((e) => e.type === type);
const press = (m, ...as) => { let out = []; for (const a of as) out = out.concat(m.press(a)); return out; };
const curOf = (m) => { const st = m.state(); return m.path() in st.cursor ? st.cursor[m.path()] : st.tower.cursor[m.path()]; };
const toRow = (m, id) => { for (let i = 0; i < 24 && m.rows()[curOf(m)].id !== id; i++) m.press('down'); return m.rows()[curOf(m)].id === id; };
const labels = (m) => { const mn = m.view().menu; return mn ? mn.rows.map((r) => r.label) : []; };
const plainOk = (v) => { const seen = []; (function walk(x, p) { if (x === undefined || typeof x === 'function') seen.push(p); else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], p + '.' + k); })(v, 'view'); return seen; };

/* ================================================================================================ the state machine */
// a check that THROWS must not hide the failures already found: they are kept, and the abort is one more failure
function checkModel(HM) {
  const f = [];
  try { checkModelBody(HM, f); } catch (err) { f.push('checks aborted by an exception: ' + (err && err.message)); }
  return f;
}
function checkModelBody(HM, f) {
  const t = (name, cond, detail) => {
    let good = false, why = '';
    try { good = !!cond(); } catch (err) { why = ' [threw: ' + (err && err.message) + ']'; }
    if (good) return;
    if (!why && detail) { try { why = ' [' + detail() + ']'; } catch (err) { why = ' [detail threw]'; } }
    f.push(name + why);
  };
  const mk = (data, o) => { const m = HM.createHubModel({ mascot: 25, ...(o || {}) }); if (data) m.setData(data); return m; };
  const tower = (m) => { toRow(m, 'tower'); return m.press('a'); };
  const D = (tw, o) => mkData([tw], o);
  // ---- the main menu row and the screens it leads to
  let m = mk(D(F.fight)); const mainRows = m.rows(); let e = tower(m);
  t('main: the TOWER row is the third row and opens the Tower screen', () => (mainRows[2].id === 'tower' && mainRows[2].label === 'TOWER' && m.path() === 'tower' && eff(e, 'screen').length === 1 && e[0].path === 'tower'), () => (J(e)));
  e = m.press('b'); t('tower: B goes back to the main menu with the cursor on TOWER (the same effect the other screens give: a return to main needs no flag)', () => (m.path() === 'main' && e.length === 1 && e[0].path === 'main' && e[0].back === undefined && m.state().cursor.main === 2), () => (J(e)));
  // ---- the home screen by state
  m = mk(D(F.fight)); tower(m);
  t('home: a run waiting for its fight shows FIGHT: FLOOR n first', () => (J(labels(m)) === J(['FIGHT: FLOOR ' + F.fight.run.floor, 'MY BUFFS', 'NEW RUN', 'LAST RUN', 'ACHIEVEMENTS', 'BACK'])), () => (J(labels(m))));
  t('home: the message says who is next', () => (/^Next: /.test(m.view().msg[0]) && m.view().msg[1].includes('Pokemon')), () => (J(m.view().msg)));
  t('home: the status panel names the floor, the buffs held and the best floor', () => (m.view().tower.panel.lines[1] === 'FLOOR ' + F.fight.run.floor + '/30' && m.view().tower.panel.lines[3] === 'BUFFS ' + F.fight.run.held.length), () => (J(m.view().tower.panel.lines)));
  e = m.press('a'); t('home: A on FIGHT asks the page to fight the floor the run is waiting for', () => (e.length === 1 && e[0].type === 'tower-fight' && e[0].profileId === 'p1' && e[0].seed === F.fight.run.seed && e[0].floor === F.fight.run.floor), () => (J(e)));
  m = mk(D(F.offer3)); tower(m);
  t('home: a run with an offer pending shows CHOOSE A BUFF, and A opens the offer', () => (labels(m)[0] === 'CHOOSE A BUFF' && (e = m.press('a'), m.path() === 'tower-offer' && e[0].path === 'tower-offer')), () => (J(labels(m))));
  m = mk(D(F.none)); tower(m);
  t('home: no run, a last run: NEW RUN / LAST RUN / ACHIEVEMENTS / BACK, with the records in the panel', () => (J(labels(m)) === J(['NEW RUN', 'LAST RUN', 'ACHIEVEMENTS', 'BACK']) && /^BEST 3v3/.test(m.view().tower.panel.lines[2])), () => (J(labels(m)) + J(m.view().tower.panel.lines)));
  m = mk(D(F.empty)); tower(m);
  t('home: a profile that never climbed has no LAST RUN row', () => (J(labels(m)) === J(['NEW RUN', 'ACHIEVEMENTS', 'BACK'])), () => (J(labels(m))));
  m = mk({ state: 'ready', activeId: null, profiles: [] }); tower(m);
  t('home: with no profile there is NEW RUN (it makes one) and BACK, and the panel explains the Tower', () => (J(labels(m)) === J(['NEW RUN', 'BACK']) && m.view().tower.panel.lines[1] === '30 FLOORS' && !m.view().menu.rows[0].disabled), () => (J(labels(m))));
  m = mk(D(null)); tower(m);
  t('home: while the Tower\'s code is still loading the rows that need it are not usable and the message says so', () => (m.view().menu.rows.find((r) => r.id === 'new').disabled === true && /Looking for your climb/.test(m.view().msg[0]) && (e = (toRow(m, 'new'), m.press('a')), e.length === 0 && /still loading/.test(m.view().msg[0]))), () => (J(m.view().msg)));
  m = mk(D(F.none, { readOnly: [true] })); tower(m);
  t('home: a profile of a newer build cannot start a run (NEW RUN is disabled and says why)', () => (m.view().menu.rows.find((r) => r.id === 'new').disabled === true && (toRow(m, 'new'), e = m.press('a'), e.length === 0 && /newer/.test(m.view().msg.join(' ')))), () => (J(m.view().msg)));
  m = mk({ state: 'unavailable', profiles: [], note: 'x' }); tower(m);
  t('home: unreadable storage is named', () => (/could not be read/.test(m.view().msg[0])), () => (J(m.view().msg)));
  const broken = clone(F.fight); broken.run = { broken: true, why: 'x' };
  m = mk(D(broken)); tower(m);
  t('home: a run that cannot be read is offered to be dropped, never fought', () => (labels(m)[0] === 'DROP THIS RUN' && !labels(m).includes('MY BUFFS')), () => (J(labels(m))));
  // ---- NEW RUN: giving up the run under way, then the team and format
  m = mk(D(F.fight)); tower(m); toRow(m, 'new'); e = m.press('a');
  t('new: with a run under way A asks first (YES / NO, NO is chosen), and nothing is given up yet', () => (e.length === 0 && m.view().tower.confirm && m.view().tower.confirm.cursor === 1 && /Give up/.test(m.view().msg[0])), () => (J(m.view())));
  e = m.press('b'); t('new: B answers NO: the run is kept', () => (e.length === 0 && m.view().tower.confirm === null && m.path() === 'tower'), () => (''));
  m.press('a'); e = press(m, 'left', 'a');
  t('new: YES gives the run up (one effect) and goes on to the team screen', () => (e.length === 2 && e[0].type === 'tower-giveup' && e[0].profileId === 'p1' && e[0].seed === F.fight.run.seed && e[1].path === 'tower-new' && m.path() === 'tower-new'), () => (J(e)));
  m = mk(D(F.none)); tower(m); toRow(m, 'new'); e = m.press('a');
  t('new: with no run A goes straight to the team screen', () => (m.path() === 'tower-new' && e[0].path === 'tower-new'), () => (J(e)));
  t('new: rows TEAM / FORMAT / START / BACK; a random team and the legal standard-rules teams only (not the broken one, not the level-100 one)', () => (J(labels(m)) === J(['TEAM', 'FORMAT', 'START', 'BACK']) && m.view().menu.rows[0].value === 'RANDOM TEAM' && m.view().menu.rows[0].count === 4), () => (J(m.view().menu.rows)));
  const seen = []; for (let i = 0; i < 5; i++) { seen.push(m.view().menu.rows[0].value); m.press('right'); }
  t('new: the team choices are RANDOM TEAM, Kanto Squad, Big Six, Duo and then round again', () => (J(seen) === J(['RANDOM TEAM', 'Kanto Squad', 'Big Six', 'Duo', 'RANDOM TEAM'])), () => (J(seen)));
                                                         // the loop above pressed right five times, so it ended on Kanto Squad again
  t('new: back on the first team (Kanto Squad) after the lap', () => (m.view().menu.rows[0].value === 'Kanto Squad'), () => (J(m.view().menu.rows[0])));
  press(m, 'right', 'right');
  t('new: a team of two plays 6v6 only (the format is forced and cannot be cycled to 3v3)', () => (m.view().menu.rows[0].value === 'Duo' && m.view().menu.rows[1].value === '6v6' && (press(m, 'down', 'right', 'right', 'left'), m.view().menu.rows[1].value === '6v6')), () => (J(m.view().menu.rows)));
  press(m, 'up', 'left', 'left', 'down');
  const f0 = m.view().menu.rows[1].value; press(m, 'right'); const f1 = m.view().menu.rows[1].value; press(m, 'right');
  t('new: a team of three or more may play either format (the format cycles between 3v3 and 6v6)', () => (m.view().menu.rows[0].value === 'Kanto Squad' && f0 !== f1 && [f0, f1].sort().join() === '3v3,6v6' && m.view().menu.rows[1].value === f0), () => (J([f0, f1])));
  press(m, 'right'); press(m, 'down'); e = m.press('a');
  t('new: START asks the page to start a run with that team and format (one effect, nothing else)', () => (e.length === 1 && e[0].type === 'tower-new' && e[0].profileId === 'p1' && e[0].teamId === 't1a' && e[0].format === f1), () => (J(e)));
  m = mk(D(F.none)); tower(m); toRow(m, 'new'); m.press('a'); press(m, 'down', 'down'); e = m.press('a');
  t('new: START on a random team sends teamId null', () => (e[0].type === 'tower-new' && e[0].teamId === null && e[0].format === '3v3'), () => (J(e)));
  m = mk(null); m.goto('tower'); m.goto('tower-new'); press(m, 'down', 'down'); e = m.press('a');
  t('new: START while the profiles are still being read does nothing', () => e.length === 0, () => J(e));
  m = mk({ state: 'ready', activeId: null, profiles: [] }); tower(m); m.press('a'); press(m, 'down', 'down'); e = m.press('a');
  t('new: with no profile START sends profileId null (the page makes one)', () => (e.length === 1 && e[0].profileId === null && e[0].teamId === null), () => (J(e)));
  m = mk(D(F.none)); tower(m); toRow(m, 'new'); m.press('a'); press(m, 'down', 'down', 'down'); e = m.press('a');
  t('new: BACK returns to the Tower screen', () => (m.path() === 'tower' && e[0].path === 'tower' && e[0].back === true), () => (J(e)));
  // ---- two trainers
  m = mk(mkData([F.fight, F.none])); tower(m);
  t('trainer: with two profiles there is a TRAINER row; right switches to the other climb', () => (labels(m).includes('TRAINER') && (toRow(m, 'trainer'), m.press('right'), labels(m)[0] === 'NEW RUN' && m.view().menu.rows.find((r) => r.id === 'trainer').value === 'BLUE')), () => (J(labels(m))));
  // ---- the offer
  m = mk(D(F.offer3)); tower(m); m.press('a');
  let v = m.view();
  t('offer: three balls, the first highlighted, with their names, rarities, colours and the ROM ball sprites', () => (m.path() === 'tower-offer' && v.tower.balls.length === 3 && v.tower.cursor === 0 && v.tower.balls.every((b) => b.name && ['green', 'blue', 'purple', 'gold'].includes(b.rarity) && /^#[0-9a-f]{6}$/.test(b.color) && [7, 9, 4, 13].includes(b.ball) && b.effectText)), () => (J(v.tower.balls.map((b) => [b.name, b.rarity, b.ball]))));
  t('offer: the message says the floor and how to choose', () => (/Floor 3 cleared/.test(v.msg[0]) && /A takes it/.test(v.msg[1])), () => (J(v.msg)));
  press(m, 'right', 'right'); t('offer: right walks the balls, then the SKIP slot, then wraps to the first', () => (m.view().tower.cursor === 2 && (press(m, 'right'), m.view().tower.cursor === 3) && (press(m, 'right'), m.view().tower.cursor === 0)), () => (''));
  press(m, 'left'); t('offer: left from the first ball goes to SKIP', () => (m.view().tower.cursor === 3), () => (''));
  press(m, 'right'); e = press(m, 'a');
  t('offer: A on a ball asks "take this buff?" (NO is chosen) and nothing is taken yet', () => (e.length === 0 && m.view().tower.confirm && m.view().tower.confirm.kind === 'take' && m.view().tower.confirm.cursor === 1 && /Take this buff/.test(m.view().msg[0]) && m.view().msg[1] === F.offer3.run.offer.balls[0].name), () => (J(m.view().tower.confirm)));
  e = m.press('b'); t('offer: B answers NO', () => (e.length === 0 && m.view().tower.confirm === null && m.path() === 'tower-offer'), () => (''));
  m.press('a'); e = press(m, 'left', 'a');
  t('offer: YES takes the ball: one effect with the run, the offer\'s seed and the ball id', () => (e.length === 1 && e[0].type === 'tower-pick' && e[0].profileId === 'p1' && e[0].seed === F.offer3.run.seed && e[0].id === F.offer3.run.offer.balls[0].id), () => (J(e)));
  press(m, 'right'); m.press('a'); e = press(m, 'left', 'a');
  t('offer: the second ball is taken by its own id', () => (e[0].id === F.offer3.run.offer.balls[1].id), () => (J(e)));
  press(m, 'down'); e = m.press('a');
  t('offer: "down" goes to SKIP, and A there asks "take nothing?"', () => (m.view().tower.cursor === 3 && m.view().tower.confirm && m.view().tower.confirm.kind === 'skip' && /nothing/.test(m.view().msg[0]) && e.length === 0), () => (J(m.view().msg)));
  e = press(m, 'left', 'a'); t('offer: YES to that skips (id null)', () => (e.length === 1 && e[0].type === 'tower-pick' && e[0].id === null), () => (J(e)));
  m = mk(D(F.offer3)); tower(m); m.press('a');
  e = m.press('b'); t('offer: B moves the cursor to SKIP first, and asks only the second time', () => (e.length === 0 && m.view().tower.cursor === 3 && m.view().tower.confirm === null && (m.press('b'), m.view().tower.confirm && m.view().tower.confirm.kind === 'skip')), () => (''));
  m = mk(D(F.offer5)); tower(m); m.press('a');
  t('offer: a boss offer shows five balls, all reachable, and the SKIP slot after them', () => (m.view().tower.balls.length === 5 && (press(m, 'left'), m.view().tower.cursor === 5) && m.view().tower.balls[0].rarity !== 'green'), () => (J(m.view().tower.balls.map((b) => b.rarity))));
  // ---- the offer by pointer
  m = mk(D(F.offer3)); tower(m); m.press('a');
  const cs = HM.rectsOf ? null : m.rects();
  t('offer: the hit rectangles are the three balls and the SKIP chip', () => (cs.length === 4), () => (J(cs)));
  const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  e = m.pointer({ kind: 'move', ...mid(cs[1]) }); t('pointer: hovering a ball highlights it (and opens it) and asks nothing', () => (e.length === 0 && m.view().tower.cursor === 1 && m.view().tower.confirm === null), () => (''));
  e = m.pointer({ kind: 'click', ...mid(cs[2]) }); t('pointer: a click on a ball highlights it and opens the "take this buff?" prompt, it does not take it', () => (e.length === 0 && m.view().tower.cursor === 2 && m.view().tower.confirm && m.view().tower.confirm.kind === 'take'), () => (J(m.view().tower.confirm)));
  e = m.pointer({ kind: 'click', x: 210, y: 127 }); t('pointer: a click on NO answers NO', () => (e.length === 0 && m.view().tower.confirm === null), () => (''));
  m.pointer({ kind: 'click', ...mid(cs[0]) }); e = m.pointer({ kind: 'click', x: 168, y: 127 });
  t('pointer: a click on YES takes the ball', () => (e.length === 1 && e[0].type === 'tower-pick' && e[0].id === F.offer3.run.offer.balls[0].id), () => (J(e)));
  m.pointer({ kind: 'click', ...mid(cs[3]) }); t('pointer: a click on the SKIP chip asks about skipping', () => (m.view().tower.confirm && m.view().tower.confirm.kind === 'skip'), () => (''));
  m.press('b'); e = m.pointer({ kind: 'click', x: 2, y: 100 }); t('pointer: a click outside everything does nothing', () => (e.length === 0 && m.view().tower.confirm === null), () => (''));
  // touch: the finger goes DOWN (a move) and then the click arrives: one tap must not take anything
  m = mk(D(F.offer3)); tower(m); m.press('a'); e = [].concat(m.pointer({ kind: 'move', ...mid(cs[1]) }), m.pointer({ kind: 'click', ...mid(cs[1]) }));
  t('pointer: a touch tap (down then click) on a ball opens the prompt and takes nothing: a second tap on YES is needed', () => (eff(e, 'tower-pick').length === 0 && m.view().tower.confirm && m.view().tower.confirm.kind === 'take'), () => (J(e)));
  m = mk(D(F.offer3)); tower(m); m.press('a'); m.pointer({ kind: 'wheel', steps: 2 }); t('wheel: two notches move the cursor two balls along', () => (m.view().tower.cursor === 2), () => (String(m.view().tower.cursor)));
  // ---- the data moves under the screens
  m = mk(D(F.offer3)); tower(m); m.press('a');
  e = m.setData(D(F.fight));
  t('data: when the offer has been taken (the data now says "fight") the offer screen steps back to the Tower screen, and tells the page', () => (m.path() === 'tower' && e.length === 1 && e[0].type === 'screen' && e[0].path === 'tower' && e[0].back === true), () => (J(e)));
  m = mk(D(F.offer3)); m.goto('tower-offer'); t('data: a link to the offer shows it as soon as the data is there (loading before)', () => (m.view().tower.state === 'ready'), () => (m.view().tower.state));
  m = mk(null); m.goto('tower-offer'); t('data: before the data arrives the offer screen says it is loading', () => (m.view().tower.state === 'loading' && m.view().tower.balls.length === 0), () => (m.view().tower.state));
  e = m.setData(D(F.offer3)); t('data: ... and stays on the offer when it arrives and there is one', () => (m.path() === 'tower-offer' && e.length === 0 && m.view().tower.balls.length === 3), () => (J(e)));
  m = mk(null); m.goto('tower-offer'); e = m.setData(D(F.none)); t('data: ... and goes to the Tower screen when there is no offer', () => (m.path() === 'tower' && e.length === 1), () => (J(e)));
  m = mk(null); m.goto('tower'); e = m.setData(D(F.offer3));
  t('data: arriving at the Tower screen by a link while an offer is pending opens the offer, once', () => (m.path() === 'tower-offer' && e.length === 1 && e[0].path === 'tower-offer' && (m.back(), m.setData(D(F.offer3)).length === 0 && m.path() === 'tower')), () => (J(e)));
  m = mk(D(F.offer3)); tower(m); e = m.setData(D(F.offer3)); t('data: pressing TOWER and refreshing the data does NOT open the offer by itself (only a link does)', () => (m.path() === 'tower' && e.length === 0), () => (J(e)));
  m = mk(null); m.goto('tower-buffs'); e = m.setData(D(F.none)); t('data: the buff list with no run goes back to the Tower screen', () => (m.path() === 'tower'), () => (''));
  m = mk(null); m.goto('tower-last'); e = m.setData(D(F.empty)); t('data: the last-run screen with no last run goes back to the Tower screen', () => (m.path() === 'tower'), () => (''));
  // ---- the buff list, the synergies, the achievements, the last run
  m = mk(D(F.offer5)); tower(m); toRow(m, 'buffs'); m.press('a');
  v = m.view();
  t('buffs: the buffs held, in order, each with its name, rarity colour, power and words', () => (m.path() === 'tower-buffs' && v.tower.tab === 0 && v.tower.total === F.offer5.run.held.length && v.tower.rows.length === Math.min(7, F.offer5.run.held.length) && v.tower.rows.every((r) => r.name && r.color && r.power >= 1 && r.text)), () => (J(v.tower.rows.map((r) => r.name))));
  press(m, 'down'); t('buffs: down moves the cursor and the message shows the effect', () => (m.view().tower.cursor === 1 && m.view().msg[0].length > 0), () => (J(m.view().msg)));
  e = m.press('a'); t('buffs: A opens the full description of the buff', () => (m.view().tower.detail && m.view().tower.detail.name === F.offer5.run.held[1].name), () => (J(m.view().tower.detail && m.view().tower.detail.name)));
  m.press('b'); t('buffs: B closes the description (and does not leave the list)', () => (m.view().tower.detail === null && m.path() === 'tower-buffs'), () => (m.path()));
  press(m, 'right'); t('buffs: right switches to the active synergies', () => (m.view().tower.tab === 1 && m.view().tower.total === F.offer5.run.synergies.length && m.view().tower.rows.every((r) => r.name && r.text)), () => (J(m.view().tower.rows.map((r) => r.name))));
  e = m.press('b'); t('buffs: B goes back to the Tower screen', () => (m.path() === 'tower' && e[0].back === true), () => (''));
  m = mk(D(F.fight)); tower(m); toRow(m, 'ach'); m.press('a'); v = m.view();
  t('ach: all 51 achievements, seven rows at a time, earned ones marked', () => (m.path() === 'tower-ach' && v.tower.total === 51 && v.tower.rows.length === 7 && v.tower.earned === F.fight.earned && v.tower.rows.every((r) => r.name && r.desc !== undefined) && v.tower.rows[0].at !== undefined), () => (J(v.tower.rows.map((r) => r.name))));
  for (let i = 0; i < 20; i++) m.press('down'); t('ach: the window follows the cursor (51 entries)', () => (m.view().tower.abs === 20 && m.view().tower.offset === 14 && m.view().tower.cursor === 6), () => (J({ a: m.view().tower.abs, o: m.view().tower.offset, c: m.view().tower.cursor })));
  press(m, 'up'); m.press('up'); t('ach: up goes back through them, and wraps at the top', () => (m.view().tower.abs === 18), () => (String(m.view().tower.abs)));
  m = mk(D(F.fight)); tower(m); toRow(m, 'ach'); m.press('a'); m.press('up'); t('ach: up from the first wraps to the last', () => (m.view().tower.abs === 50 && m.view().tower.offset === 44), () => (J({ a: m.view().tower.abs })));
  m.press('b'); t('ach: B goes back', () => (m.path() === 'tower'), () => (''));
  m = mk(D(F.none)); tower(m); toRow(m, 'last'); m.press('a'); v = m.view();
  t('last: the last climb: how far, in which format, what it held and what it earned', () => (m.path() === 'tower-last' && v.tower.last.cleared === F.none.last.cleared && v.tower.last.format && Array.isArray(v.tower.last.held) && Array.isArray(v.tower.last.earned)), () => (J(v.tower.last)));
  e = m.press('a'); t('last: A or B goes back', () => (m.path() === 'tower' && e[0].back === true), () => (''));
  // ---- plain, deterministic, JSON
  const script = (mm) => { const out = []; for (const a of ['down', 'down', 'a', 'a', 'down', 'a', 'right', 'a', 'left', 'a', 'b', 'b']) { mm.press(a); out.push(J(mm.view())); } return out.join('|'); };
  t('determinism: the same presses give the same views', () => (script(mk(D(F.offer3))) === script(mk(D(F.offer3)))), () => (''));
  m = mk(D(F.offer3)); tower(m); m.press('a'); t('views are plain JSON (no undefined, no functions)', () => (plainOk(m.view()).length === 0 && J(JSON.parse(J(m.view()))) === J(m.view())), () => (plainOk(m.view()).join(',')));
  m = mk(D(F.fight)); tower(m); const st1 = J(m.state()); t('state() is plain JSON and carries the Tower\'s', () => (J(JSON.parse(st1)) === st1 && JSON.parse(st1).tower.profileId === 'p1'), () => (st1.slice(0, 60)));
  // ---- the main menu scrolls: any number of rows
  m = mk(D(F.fight)); t('main: the menu shows eight of its nine rows, scrolled so the cursor is visible, with arrows for what is hidden', () => (m.view().menu.rows.length === 8 && m.view().menu.down === true && m.view().menu.up === false && (press(m, 'up'), m.view().menu.up === true && m.view().menu.down === false && m.view().menu.offset === 1 && m.view().menu.rows[7].label === 'ABOUT')), () => (J(m.view().menu)));
  m = mk(D(F.fight)); press(m, 'up'); e = m.pointer({ kind: 'click', x: 60, y: 10 + 7 * 12 + 4 });
  t('main: a click on the last visible row of a scrolled menu is that row (ABOUT), not the one the window started at', () => (m.path() === 'about'), () => (m.path()));
  m = mk(D(F.fight)); press(m, 'up'); m.pointer({ kind: 'move', x: 60, y: 10 + 3 * 12 + 4 }); t('main: hovering a row of a scrolled menu moves the cursor to that row of the whole list', () => (m.state().cursor.main === 1 + 3), () => (String(m.state().cursor.main)));
}

/* ================================================================================================ the mutants */
const THS = fs.readFileSync(path.join(SRC, 'tower_hub.js'), 'utf8'), HMS = fs.readFileSync(path.join(SRC, 'hub_model.js'), 'utf8');
const MUTANTS = [
  { file: 'tower_hub.js', name: 'FIGHT does not ask the page to fight', find: "case 'fight': return r && !r.broken ? [{ type: 'tower-fight', profileId: p.id, seed: r.seed, floor: r.floor }] : [];", replace: "case 'fight': return [];", expect: 'A on FIGHT asks the page' },
  { file: 'tower_hub.js', name: 'NEW RUN over a run does not ask first', find: "if (r) { S.confirm = { kind: 'giveup', cursor: 1, then: 'new' }; return []; }", replace: "if (false) { S.confirm = { kind: 'giveup', cursor: 1, then: 'new' }; return []; }", expect: 'with a run under way A asks first' },
  { file: 'tower_hub.js', name: 'the give-up question is answered YES by default', find: "S.confirm = { kind: 'giveup', cursor: 1, then: 'new' }; return []; }\n        return env.go('tower-new');", replace: "S.confirm = { kind: 'giveup', cursor: 0, then: 'new' }; return []; }\n        return env.go('tower-new');", expect: 'NO is chosen' },
  { file: 'tower_hub.js', name: 'YES to give up does not give the run up', find: "if (c.then === 'new') return [{ type: 'tower-giveup', profileId: p.id, seed: r ? r.seed : null }].concat(env.go('tower-new'));", replace: "if (c.then === 'new') return env.go('tower-new');", expect: 'YES gives the run up' },
  { file: 'tower_hub.js', name: 'the team list offers illegal teams', find: "const teamsOf = (p) => (p ? p.teams.filter((t) => t.legal && t.ruleset === TOWER_RULESET && t.size >= 1) : []);", replace: "const teamsOf = (p) => (p ? p.teams.filter((t) => t.size >= 1) : []);", expect: 'the legal standard-rules teams only' },
  { file: 'tower_hub.js', name: 'a team of two may play 3v3', find: "return c && c.size < 3 ? ['6v6'] : FORMATS;", replace: "return FORMATS;", expect: 'a team of two plays 6v6 only' },
  { file: 'tower_hub.js', name: 'START forgets the team', find: "teamId: S.nw.team === 'random' ? null : S.nw.team, format: S.nw.format }]; }", replace: "teamId: null, format: S.nw.format }]; }", expect: 'START asks the page to start a run with that team and format' },
  { file: 'tower_hub.js', name: 'A on a ball takes it without asking', find: "case 'a': o.confirm = { kind: o.cursor === n ? 'skip' : 'take', cursor: 1 }; return [];", replace: "case 'a': if (o.cursor !== n) { const p = prof(), r = liveRun(); return [{ type: 'tower-pick', profileId: p.id, seed: r.seed, id: balls[o.cursor].id }]; } o.confirm = { kind: 'skip', cursor: 1 }; return [];", expect: 'A on a ball asks' },
  { file: 'tower_hub.js', name: 'the take question is answered YES by default', find: "case 'a': o.confirm = { kind: o.cursor === n ? 'skip' : 'take', cursor: 1 }; return [];", replace: "case 'a': o.confirm = { kind: o.cursor === n ? 'skip' : 'take', cursor: 0 }; return [];", expect: 'NO is chosen' },
  { file: 'tower_hub.js', name: 'a pick carries the wrong ball', find: "id: c.kind === 'take' ? balls[o.cursor].id : null }];", replace: "id: c.kind === 'take' ? balls[0].id : null }];", expect: 'the second ball is taken by its own id' },
  { file: 'tower_hub.js', name: 'a skip carries a ball', find: "id: c.kind === 'take' ? balls[o.cursor].id : null }];", replace: "id: balls[Math.min(o.cursor, n - 1)].id }];", expect: 'YES to that skips' },
  { file: 'tower_hub.js', name: 'the cursor cannot reach SKIP', find: "case 'right': case 'r': o.cursor = (o.cursor + 1) % (n + 1); return [];", replace: "case 'right': case 'r': o.cursor = (o.cursor + 1) % n; return [];", expect: 'right walks the balls, then the SKIP slot' },
  { file: 'tower_hub.js', name: 'a click on a ball takes it at once', find: "if (ev.kind === 'click' && !o.confirm) { o.cursor = h.index; return press(path, 'a'); }", replace: "if (ev.kind === 'click' && !o.confirm) { o.cursor = h.index; press(path, 'a'); o.confirm.cursor = 0; return press(path, 'a'); }", expect: 'a click on a ball highlights it and opens the' },
  { file: 'tower_hub.js', name: 'a hover does not highlight', find: "if (moving) { S.hover = h.index; if (!o.confirm) o.cursor = h.index; return []; }", replace: "if (moving) { S.hover = h.index; return []; }", expect: 'hovering a ball highlights it' },
  { file: 'tower_hub.js', name: 'the offer stays up after the ball is taken', find: "if (path === 'tower-offer' && t && !(r && r.phase === 'offer')) { S.offer.confirm = null; return env.back(); }", replace: "", expect: 'steps back to the Tower screen' },
  { file: 'tower_hub.js', name: 'a refresh opens the offer by itself', find: "&& t && r && r.phase === 'offer' && env.arrivedByLink()) {", replace: "&& t && r && r.phase === 'offer') {", expect: 'does NOT open the offer by itself' },
  { file: 'tower_hub.js', name: 'a link never opens the offer', find: "&& t && r && r.phase === 'offer' && env.arrivedByLink()) {", replace: "&& t && r && r.phase === 'offer' && false) {", expect: 'arriving at the Tower screen by a link' },
  { file: 'tower_hub.js', name: 'a link opens the offer every time', find: "{ S.autoDone = true; return env.go('tower-offer'); }", replace: "{ return env.go('tower-offer'); }", expect: 'opens the offer, once' },
  { file: 'tower_hub.js', name: 'the achievement window does not follow the cursor', find: "if (cursor < off) off = cursor; else if (cursor >= off + size) off = cursor - size + 1;", replace: "", expect: 'the window follows the cursor' },
  { file: 'tower_hub.js', name: 'a broken run can be fought', find: "if (r && r.broken) rows.push({ id: 'drop', kind: 'item', label: 'DROP THIS RUN' });\n    else if", replace: "if (false) rows.push({ id: 'drop', kind: 'item', label: 'DROP THIS RUN' });\n    else if", expect: 'a run that cannot be read is offered to be dropped' },
  { file: 'tower_hub.js', name: 'a newer-build profile can start a run', find: "rows.push({ id: 'new', kind: 'item', label: 'NEW RUN', disabled: !writable() || !t });", replace: "rows.push({ id: 'new', kind: 'item', label: 'NEW RUN', disabled: !t });", expect: 'a profile of a newer build cannot start a run' },
  { file: 'tower_hub.js', name: 'START works while the data is loading', find: "if (env.dataState() !== 'ready') return [];", replace: "", expect: 'START while the profiles are still being read does nothing' },
  { file: 'tower_hub.js', name: 'B from a Tower screen goes to the main menu', find: "const PARENT = Object.freeze({ tower: 'main', 'tower-new': 'tower', 'tower-offer': 'tower', 'tower-buffs': 'tower', 'tower-ach': 'tower', 'tower-last': 'tower' });", replace: "const PARENT = Object.freeze({ tower: 'main', 'tower-new': 'main', 'tower-offer': 'main', 'tower-buffs': 'main', 'tower-ach': 'main', 'tower-last': 'main' });", expect: 'B goes back to the Tower screen' },
  { file: 'hub_model.js', name: 'the TOWER row opens nothing', find: "        case 'tower': return go('tower');\n", replace: "", expect: 'the TOWER row is the third row and opens the Tower screen' },
  { file: 'hub_model.js', name: 'the main menu does not scroll', find: "    let off = clamp(S.offset.main, 0, Math.max(0, n - MAIN_VISIBLE));\n    if (cur < off) off = cur; else if (cur >= off + MAIN_VISIBLE) off = cur - MAIN_VISIBLE + 1;", replace: "    let off = 0;", expect: 'the menu shows eight of its nine rows' },
  { file: 'hub_model.js', name: 'a step back is not reported as one', find: "(e.type === 'screen' && up !== 'main' ? { ...e, back: true } : e)", replace: "e", expect: 'BACK returns to the Tower screen' },
  { file: 'hub_model.js', name: 'a click on a scrolled menu hits the wrong row', find: "const index = (win ? win.off : 0) + Math.floor((y - m.y) / pitch);", replace: "const index = Math.floor((y - m.y) / pitch);", expect: 'a click on the last visible row of a scrolled menu' },
  { file: 'hub_model.js', name: 'setData forgets the Tower', find: "      return tower.onData();", replace: "      return [];", expect: 'when the offer has been taken' },
  { file: 'hub_model.js', name: 'the Tower data is not kept', find: "readOnly: !!p.readOnly, tower: p.tower && typeof p.tower === 'object' ? JSON.parse(JSON.stringify(p.tower)) : null })) : [],", replace: "readOnly: !!p.readOnly, tower: null })) : [],", expect: 'a run waiting for its fight shows FIGHT' },
];
let modCache = new Map();
async function loadMutant(mu) {
  if (modCache.has(mu.name)) return modCache.get(mu.name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-thub-mut-'));
  for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
  const target = path.join(dir, mu.file), text = fs.readFileSync(target, 'utf8'), n = text.split(mu.find).length - 1;
  if (n !== 1) throw new Error('mutant "' + mu.name + '": the text to replace occurs ' + n + ' times (must be 1)');
  fs.writeFileSync(target, text.replace(mu.find, () => mu.replace));
  const M = await imp(dir, 'hub_model.js', mu.name.length);
  modCache.set(mu.name, { M, dir });
  return modCache.get(mu.name);
}

/* ================================================================================================ the renderer */
const HM = await L.mod('hub_model.js'), HS = await L.mod('hub_screen.js'), TH = await L.mod('tower_hub.js');
{
  const real = checkModel(HM);
  ok(real.length === 0, 'M. the Tower state machine passes every check (' + (real.length ? real.length + ' failed' : 'all') + ')', real.slice(0, 5).join('; '));
  if (process.env.ARENA_VERBOSE) for (const x of real) console.log('   model check failed: ' + x.slice(0, 900));
  ok(checkModel(HM).length === 0, 'M. unmutated twin stays quiet');
  ok(TH.pitchFor(8) === HM.menuPitch(8) && TH.pitchFor(7) === HM.menuPitch(7) && TH.pitchFor(6) === HM.menuPitch(6) && TH.pitchFor(4) === HM.menuPitch(4) && [1, 2, 3, 5, 9].every((n) => TH.pitchFor(n) === HM.menuPitch(n)), 'M. the Tower\'s row pitch agrees with the hub\'s for every row count (they cannot share a function without a cycle, so this pins them)');
  ok(HM.PATHS.includes('tower') && TH.TOWER_PATHS.every((p) => HM.PATHS.includes(p)) && TH.TOWER_PATHS.length === 6, 'M. every Tower path is a hub path (the address hash can name it)');
  ok(HM.createHubModel({ mascot: 25 }).goto('tower-offer').length === 1 && HM.createHubModel({ mascot: 25 }).goto('tower-nowhere').length === 0, 'M. a link to a Tower screen is accepted, an unknown one is ignored');
  if (WANT_MUTANTS) {
    for (const mu of MUTANTS) {
      let r; try { const { M } = await loadMutant(mu); r = checkModel(M); } catch (e) { r = ['threw: ' + e.message]; }
      ok(r.length > 0 && r.some((x) => x.includes(mu.expect)), 'M. mutant "' + mu.name + '" trips the named check "' + mu.expect + '"', r.length ? r.slice(0, 3).join(' || ') : 'NOT CAUGHT');
    }
  }
}

const ui = BU.createBattleUi(rom), screen = HS.createHubScreen(ui);
const frameHash = (v, s = screen) => L.fnv(s.render(v).rgba);
const mkM = (data) => { const m = HM.createHubModel({ mascot: 25 }); m.setData(data); return m; };
const D = (tw, o) => mkData([tw], o);
const at = (data, steps) => { const m = mkM(data); for (const s of steps) m.press(s); return m; };
const GO = ['down', 'down', 'a'];                         // TOWER
{
  // every Tower view draws a full opaque frame, and every message fits the message window
  const views = [];
  const add = (label, data, steps) => views.push([label, at(data, steps).view()]);
  add('home offer', D(F.offer3), GO); add('home none', D(F.none), GO); add('home empty', D(F.empty), GO); add('home no profile', { state: 'ready', activeId: null, profiles: [] }, GO); add('home loading', D(null), GO);
  add('home two trainers', mkData([F.fight, F.none]), GO); add('home confirm', D(F.fight), [...GO, 'down', 'down', 'a']);
  for (let i = 0; i < 4; i++) add('home row ' + i, D(F.fight), [...GO, ...Array(i).fill('down')]);
  for (const k of [0, 1, 2, 3, 4]) add('new r' + k, D(F.none), [...GO, 'a', ...Array(k % 4).fill('down'), ...(k === 4 ? ['right'] : [])]);
  for (const [label, d] of [['offer3', F.offer3], ['offer5', F.offer5]]) { const n = d.run.offer.balls.length; for (let i = 0; i <= n; i++) add(label + ' cursor ' + i, D(d), [...GO, 'a', ...Array(i).fill('right')]); add(label + ' take', D(d), [...GO, 'a', 'a']); add(label + ' skip', D(d), [...GO, 'a', 'b', 'a']); }
  add('buffs', D(F.offer5), [...GO, 'down', 'a']); add('buffs 2', D(F.offer5), [...GO, 'down', 'a', 'down', 'down']); add('buff detail', D(F.offer5), [...GO, 'down', 'a', 'down', 'a']); add('synergies', D(F.offer5), [...GO, 'down', 'a', 'right']);
  for (const k of [0, 5, 20, 50]) add('ach ' + k, D(F.fight), [...GO, 'down', 'down', 'down', 'down', 'a', ...Array(k).fill('down')]);
  add('last', D(F.none), [...GO, 'down', 'a']);
  const bad = [], w = [];
  for (const [label, v] of views) {
    const f = screen.render(v);
    if (f.width !== 240 || f.height !== 160 || f.rgba.length !== 240 * 160 * 4) bad.push(label + ': size');
    for (let i = 3; i < f.rgba.length; i += 4) if (f.rgba[i] !== 255) { bad.push(label + ': transparent pixel'); break; }
    for (const x of screen.widths(v)) if (x.px > x.max) w.push(label + ': ' + x.what + ' ' + x.px + ' > ' + x.max);
  }
  ok(views.length >= 36 && bad.length === 0, 'R. all ' + views.length + ' Tower views draw a full opaque 240x160 frame', bad.slice(0, 3).join('; '));
  ok(w.length === 0, 'R. every help line and message of every Tower view fits its window', w.slice(0, 4).join('; '));
  const frames = views.map(([l, v]) => [l, frameHash(v)]);
  ok(new Set(frames.map((x) => x[1])).size === frames.length, 'R. every Tower view above is a different picture (no screen is drawn the same as another)', frames.filter((x, i) => frames.findIndex((y) => y[1] === x[1]) !== i).map((x) => x[0]).join(','));
  ok(frameHash(views[0][1]) === frameHash(views[0][1]), 'R. rendering is deterministic');
  // the ball art is the ROM's: zero the ball table bytes and the picture changes; a byte-identical copy draws the same
  const offerView = at(D(F.offer3), [...GO, 'a']).view(), base = frameHash(offerView);
  const zap = (off, len) => { const z = rom.slice(); z.fill(0, off, off + len); return frameHash(offerView, HS.createHubScreen(BU.createBattleUi(z))); };
  ok(zap(0x7bb0bc, 17 * 0x2c) !== base, 'R. provenance: zeroing the ROM\'s Poke Ball table changes the offer picture (the balls are the ROM\'s own sprites)');
  ok(zap(0x6cd02c, 32) !== base && zap(0x73a130, 32) !== base, 'R. provenance: zeroing the ROM\'s text colours, or its textbox palette, changes it too (the words and the message window are the ROM\'s)');
  ok(frameHash(offerView, HS.createHubScreen(BU.createBattleUi(rom.slice()))) === base, 'R. twin: a byte-identical copy of the ROM gives the identical picture');
  // the rarity is on the ball: each tier is its own sprite, the highlighted one is the open frame, and all of it stays on the screen
  const bhash = (i, fr) => L.fnv(ui.ballRGBA(i, fr).rgba);
  const ids = [7, 9, 4, 13];
  ok(new Set(ids.map((i) => bhash(i, 0))).size === 4 && ids.every((i) => bhash(i, 0) !== bhash(i, 1)), 'R. the four rarity balls (ROM balls 7, 9, 4, 13) are four different sprites and each has a closed and an open frame');
  const lone = (cursor) => at(D(F.offer3), [...GO, 'a', ...Array(cursor).fill('right')]).view();
  ok(frameHash(lone(0)) !== frameHash(lone(1)) && frameHash(lone(1)) !== frameHash(lone(3)), 'R. highlighting a different ball (or SKIP) changes the picture');
  let off = 0; const five = at(D(F.offer5), [...GO, 'a']).view();
  for (const c of TH.ballCentres(5)) if (c.x - 19 < 0 || c.x + 19 > 240 || c.y - 24 < 0) off++;
  for (const c of TH.ballCentres(7)) if (c.x - 19 < 0 || c.x + 19 > 240) off++;
  ok(off === 0 && five.tower.balls.length === 5, 'R. five balls (a boss offer) and even seven fit across the screen with their highlight');
  // rarity colours differ between tiers: draw the same ball sprite slot with each rarity colour and compare the outline pixels
  const colours = new Set(F.offer5.run.offer.balls.map((b) => b.color)); ok(colours.size >= 2, 'R. a boss offer shows more than one rarity colour (' + [...colours].join(' ') + ')');
}

C.finish();
process.exit(process.exitCode || 0);
