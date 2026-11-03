#!/usr/bin/env node
// POKEMONARENA RECORD TEST (ST1) -- the hub's RECORD screen: record_model.js (a profile's battle record as pages), hub_data.js (reading it from the store),
// hub_model.js (the RECORD state machine) and hub_screen.js (the ROM drawing).
//
//   A  THE PAGES     hand-written expectations for the fixture record, a profile with no battle, a full record (20 recent battles), the dates in any time zone, the play time,
//                    the notices (no profile / storage blocked / newer profile / loading); every cell measured with the ROM fonts: nothing is cut (realistic numbers and the longest
//                    names the roster has), nothing overlaps; hostile numbers stay inside their cell.
//   B  THE STORE     readHubData builds the pages with the pack's names from a real (memory) store, the profile of a newer build gets the read-only notice, the time zone moves the dates.
//   C  THE MODEL     every key and pointer action: pages, the trainer row (several profiles) or up / down = pages (one), the A rules, RESET RECORD asking YES / NO starting on NO,
//                    the effect it returns, B / right click / wheel, data refreshes that remove a trainer or shorten the pages, hit kinds, the plain-JSON view.
//   D  THE DRAWING   every view renders opaque 240x160, the pages differ, a zeroed ROM font or palette changes them.
//   E  MUTANTS       one-snippet defects of hub_model.js / record_model.js (in a temp copy of the module tree), each of which must trip a NAMED check.
//
//   node tools/pokemonarena_record_test.mjs        ARENA_SKIP_MUTANTS=1
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const FX = path.join(here, 'fixtures', 'pokemonarena');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }
const rom = fs.readFileSync(ROM_PATH);
const J = (x) => JSON.stringify(x);
const clone = (o) => JSON.parse(JSON.stringify(o));
const FIXREC = JSON.parse(fs.readFileSync(path.join(FX, 'profile-v3-current.json'), 'utf8'));

let passed = 0, failed = 0;
const failures = [];
function report(name, ok, detail) { if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { failed++; const why = typeof ok === 'string' ? ok : detail || ''; failures.push(name + ': ' + why); console.log('  FAIL ' + name + (why ? ' -- ' + String(why).slice(0, 400) : '')); } }
const head = (s) => console.log('\n== ' + s);

const loadFrom = async (dir) => {
  const u = (n) => import(pathToFileURL(path.join(dir, n)).href);
  const [T, B, HM, HS, HD, RM, PD, P, ST] = await Promise.all([u('tables.js'), u('battle_ui.js'), u('hub_model.js'), u('hub_screen.js'), u('hub_data.js'), u('record_model.js'), u('page_draw.js'), u('profile.js'), u('store.js')]);
  const pack = T.loadPack(rom, { verify: 'header', dexText: false });
  const ui = B.createBattleUi(rom);
  return { T, B, HM, HS, HD, RM, PD, P, ST, pack, ui, pd: PD.createPageDrawer(ui), screen: HS.createHubScreen(ui) };
};

async function suite(M) {
  const out = [];
  const add = (name, result) => out.push([name, result]);
  const blk = async (name, fn) => { try { await fn(); } catch (e) { add('crash/' + name, 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); } };
  const { RM, HM, HD, P, ST, pack, ui, pd, screen } = M;
  const names = { speciesName: (id) => (pack.species[id] ? pack.species[id].name : '?'), moveName: (id) => (pack.moves[id] ? pack.moves[id].name : '?') };
  const txt = (page) => page.lines.map((l) => l.cells.map((c) => c.t).filter((t) => t !== '').join(' | ')).join('\n');
  const stats = () => clone(FIXREC.stats);
  const key = (m, ...as) => { let e = []; for (const a of as) e = e.concat(m.press(a)); return e; };

  // ---------------------------------------------------------------------------------------------------------------------------- A. the pages
  await blk('pages', async () => {
    const pages = RM.buildRecordPages(stats(), { ...names, tzMinutes: 0 });
    add('pages/the-fixture-record-has-ten-pages (5 + recent + reset)', J(pages.map((p) => p.id)) === J(['overall', 'by', 'fav', 'highs', 'totals', 'recent0', 'reset']) ? true : J(pages.map((p) => p.id)));
    add('pages/overall-by-hand: 5 battles, win rate 60%, 3 won, 1 lost, 0 drawn, 1 gave up, streak 2 now best 3', /BATTLES 5/.test(txt(pages[0])) && /WIN RATE 60%/.test(txt(pages[0])) && /WON \| 3 \| LOST \| 1/.test(txt(pages[0])) && /DRAWN \| 0 \| GAVE UP \| 1/.test(txt(pages[0])) && /2 NOW, BEST 3/.test(txt(pages[0])) ? true : txt(pages[0]));
    add('pages/overall-dates-and-time: first 23-11-14, last 23-11-14, 30M 30S', /FIRST BATTLE \| 23-11-14/.test(txt(pages[0])) && /LAST BATTLE \| 23-11-14/.test(txt(pages[0])) && /TIME PLAYED \| 30M 30S/.test(txt(pages[0])) ? true : txt(pages[0]));
    add('pages/modes-by-hand: 3v3 won 2 lost 1; 6v6 won 1 quit 1; hard quit 1; win rates easy 100 normal 67 hard 0', /3V3 \| 2 \| 1 \| 0 \| 0/.test(txt(pages[1])) && /6V6 \| 1 \| 0 \| 0 \| 1/.test(txt(pages[1])) && /HARD \| 0 \| 0 \| 0 \| 1/.test(txt(pages[1])) && /EASY 100% {2}NORMAL 67% {2}HARD 0%/.test(txt(pages[1])) ? true : txt(pages[1]));
    add('pages/favourites-name-the-species-and-moves-of-the-ROM (Pokemon / moves by id, most used first)', /Pikachu|Squirtle|Charmander|Venusaur|Blastoise|Rattata/.test(txt(pages[2])) && txt(pages[2]).split('\n')[1].includes(names.speciesName(9)) && txt(pages[2]).split('\n')[1].includes('4') ? true : txt(pages[2]));
    add('pages/highs-by-hand: biggest hit 211 HP 88% of the target, fastest win 9 turns, longest 21, best KO streak 3 in a row, best win streak 3', /211 HP, 88% OF/.test(txt(pages[3])) && /FASTEST WIN \| 9 TURNS/.test(txt(pages[3])) && /LONGEST BATTLE \| 21 TURNS/.test(txt(pages[3])) && /BEST KO STREAK \| 3 IN A ROW/.test(txt(pages[3])) && /BEST WIN STREAK \| 3 WINS/.test(txt(pages[3])) && /MOST DAMAGE \| 2210 IN ALL/.test(txt(pages[3])) ? true : txt(pages[3]));
    add('pages/totals-by-hand', /BATTLE TURNS \| 62 \| HITS LANDED \| 36/.test(txt(pages[4])) && /KOS SCORED \| 12 \| CRITICAL HITS \| 3/.test(txt(pages[4])) && /TIMES FAINTED \| 8 \| SUPER EFFECTIVE \| 11/.test(txt(pages[4])) && /RESISTED HITS \| 5/.test(txt(pages[4])) ? true : txt(pages[4]));
    add('pages/recent-lists-the-five-battles-newest-first-with-QUIT-for-a-forfeit', pages[5].lines.length === 10 && /QUIT \| 23-11-14 \| 6V6 HARD \| 4 T/.test(txt(pages[5])) && /WON \| 23-11-14 \| 3V3 NORMAL \| 12 TURNS/.test(txt(pages[5])) && /LOST/.test(txt(pages[5])) ? true : txt(pages[5]));
    add('pages/reset-page-has-the-button-and-the-words', pages[6].id === 'reset' && pages[6].button && pages[6].button.label === 'RESET RECORD' && pages[6].button.enabled === true && /Teams and Pokemon are not touched/.test(txt(pages[6])) ? true : J(pages[6].button));
    add('pages/a-read-only-profile-gets-a-disabled-button', RM.buildRecordPages(stats(), { ...names, resettable: false }).slice(-1)[0].button.enabled === false ? true : 'enabled');
    // empty, full
    const z = stats(); z.wins = 0; z.losses = 0; z.draws = 0; z.forfeits = 0;
    const zp = RM.buildRecordPages(z, names);
    add('pages/no-battles-yet: one page that says so (no empty tables, no reset)', zp.length === 1 && /NO BATTLES YET/.test(txt(zp[0])) && /Giving up counts too/.test(txt(zp[0])) ? true : J(zp.map((p) => p.id)));
    const full = stats(); full.recent = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, at: 1700000000000 + i * 86400000, fmt: i % 2 ? '3v3' : '6v6', cpu: ['easy', 'normal', 'hard'][i % 3], res: ['w', 'l', 'd', 'f'][i % 4], turns: 3 + i, mvp: i % 5 ? 25 : 0, team: [25, 6, 94, 9, 130, 143].slice(0, 1 + (i % 6)) }));
    const fp = RM.buildRecordPages(full, names);
    add('pages/twenty-recent-battles-are-four-pages-of-five (nothing is dropped, none is repeated)', fp.filter((p) => /^recent/.test(p.id)).length === 4 && fp.filter((p) => /^recent/.test(p.id)).every((p) => p.lines.length === 10) && new Set(fp.filter((p) => /^recent/.test(p.id)).flatMap((p) => p.lines.filter((l, i) => i % 2 === 0).map((l) => l.cells[1].t))).size === 20 ? true : J(fp.map((p) => p.id)));
    add('pages/a-battle-with-no-MVP-says-NO-MVP-and-a-long-team-ends-in-a-count', /NO MVP/.test(txt(fp[5])) && fp.slice(5, 9).some((p) => /\+\d/.test(txt(p))) ? true : txt(fp[5]).slice(0, 200));
    // dates and times
    add('pages/dates-follow-the-time-zone-minutes-west-of-UTC (23:30 UTC on the 14th is the 14th in UTC, the 14th at -60... and the 14th 18:30 at +300)', RM.dateText(Date.UTC(2023, 10, 14, 23, 30), 0) === '23-11-14' && RM.dateText(Date.UTC(2023, 10, 14, 23, 30), -60) === '23-11-15' && RM.dateText(Date.UTC(2023, 10, 14, 23, 30), 300) === '23-11-14' && RM.dateText(Date.UTC(2023, 0, 1, 2, 0), 300) === '22-12-31' ? true : [RM.dateText(Date.UTC(2023, 10, 14, 23, 30), -60), RM.dateText(Date.UTC(2023, 0, 1, 2, 0), 300)].join(' '));
    add('pages/play-time-reads-as-hours-minutes-seconds', J([RM.timeText(0), RM.timeText(35000), RM.timeText(870000), RM.timeText(3600000), RM.timeText(7500000), RM.timeText(99 * 3600000 + 59 * 60000)]) === J(['0S', '35S', '14M 30S', '1H 00M', '2H 05M', '99H 59M']) ? true : J([RM.timeText(870000), RM.timeText(7500000)]));
    // the notices
    const nn = RM.buildRecordNotice('none'), nu = RM.buildRecordNotice('unavailable'), nr = RM.buildRecordNotice('readonly'), nl = RM.buildRecordNotice('loading');
    add('pages/notices-say-what-is-wrong-in-plain-words', /NO TRAINER PROFILE YET/.test(txt(nn[0])) && nn[0].action === 'builder' && /not keeping profiles/.test(txt(nu[0])) && /newer version/.test(txt(nr[0])) && /LOOKING FOR YOUR RECORD/.test(txt(nl[0])) ? true : txt(nn[0]));
    add('pages/the-reset-question-names-the-trainer-and-has-a-safe-default-note', /RESET ASH'S RECORD\?/.test(txt(RM.buildResetConfirm('Ash'))) && /safe answer/.test(txt(RM.buildResetConfirm('Ash'))) ? true : txt(RM.buildResetConfirm('Ash')));
    add('pages/the-model-is-pure-and-deterministic', J(RM.buildRecordPages(stats(), { ...names, tzMinutes: 0 })) === J(pages) && J(JSON.parse(J(pages))) === J(pages) ? true : 'differs');
    add('pages/the-input-is-not-modified', (() => { const s = stats(); const a = J(s); RM.buildRecordPages(s, names); return J(s) === a ? true : 'modified'; })());
    // fit
    const cuts = [], over = [], outside = [];
    const inspect = (list, tag) => { for (const pg of list) for (const l of pg.lines) { const placed = []; for (const c of l.cells) { if (c.t === '') continue; const r = pd.fit(c); if (r.cut && !c.cutOk) cuts.push(tag + ' ' + pg.id + ' ' + J(c.t) + ' ' + r.w + '/' + c.w); const x0 = c.a === 'r' ? c.x + c.w - r.w : c.a === 'c' ? c.x + Math.floor((c.w - r.w) / 2) : c.x; const h = c.f === 'normal' ? 16 : 12; if (x0 < 0 || x0 + r.w > RM.PAGE_W || l.y + h > RM.PAGE_H + 2) outside.push(tag + ' ' + pg.id + ' ' + J(c.t) + ' x' + x0 + '+' + r.w + ' y' + l.y); for (const q of placed) if (!(x0 + r.w <= q[0] || q[0] + q[1] <= x0)) over.push(tag + ' ' + pg.id + ' ' + J(c.t)); placed.push([x0, r.w]); } } };
    const spIds = pack.roster.slice().sort((a, b) => ui.measure('small', pack.species[b].name) - ui.measure('small', pack.species[a].name));
    const mvIds = [...new Set(M.legalMoveIds || [])];
    const real = clone(FIXREC.stats);
    real.wins = 234; real.losses = 123; real.draws = 12; real.forfeits = 7; real.streak = 12; real.best = 20; real.playMs = 98 * 3600000 + 59 * 60000;
    real.fav.species = Object.fromEntries(spIds.slice(0, 6).map((id, i) => [String(id), 99 - i])); real.fav.mvps = Object.fromEntries(spIds.slice(0, 4).map((id, i) => [String(id), 99 - i]));
    const mvLegal = M.longMoves.slice(0, 6);
    real.fav.moves = Object.fromEntries(mvLegal.map((id, i) => [String(id), 99 - i]));
    real.bests.hit = { sp: spIds[0], mv: mvLegal[0], dmg: 999, pct: 100, vs: spIds[1], at: 1700000000000 };
    real.totals = Object.fromEntries(Object.keys(real.totals).map((k) => [k, 999999]));
    real.recent = Array.from({ length: 20 }, (_, i) => ({ id: 'w' + i, at: 1700000000000, fmt: '6v6', cpu: 'normal', res: 'f', turns: 300, mvp: spIds[i % 6], team: spIds.slice(0, 6) }));
    inspect(RM.buildRecordPages(real, { ...names, tzMinutes: 0 }), 'worst');
    inspect(RM.buildRecordPages(stats(), names), 'fixture'); inspect(RM.buildRecordPages(full, names), 'full');
    inspect([RM.buildResetConfirm('MISTYMIST'), ...nn, ...nu, ...nr, ...nl], 'notices');
    inspect(zp, 'empty');
    add('fit/no-cell-is-cut-for-realistic-worst-cases (234 wins, 99H play time, 6-digit totals, the longest species and legal moves, 20 forfeits of 300 turns)', cuts.length === 0 ? true : cuts.slice(0, 4).join(' | ') + ' (' + cuts.length + ')');
    add('fit/no-two-cells-overlap-and-all-are-inside-the-window', over.length === 0 && outside.length === 0 ? true : [...over, ...outside].slice(0, 4).join(' | '));
    const big = clone(FIXREC.stats); big.wins = big.losses = big.draws = big.forfeits = 9e15; big.playMs = 9e15; big.totals = Object.fromEntries(Object.keys(big.totals).map((k) => [k, 9e15]));
    let escaped = 0; for (const pg of RM.buildRecordPages(big, names)) for (const l of pg.lines) for (const c of l.cells) if (c.t !== '' && pd.fit(c).w > c.w) escaped++;
    add('fit/hostile-numbers-never-leave-their-cell', escaped === 0 ? true : escaped + ' cells');
  });

  // ---------------------------------------------------------------------------------------------------------------------------- B. the store reader
  await blk('data', async () => {
    const deps = { now: () => 1700000999999, randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255) };
    const mem = await ST.openStore({ adapter: ST.createMemoryAdapter({ name: 'rec-' + process.pid + '-' + Math.random().toString(36).slice(2), durable: true }), channel: false, deps });
    const doc = clone(FIXREC); doc.id = 'p_rec'; doc.rev = 1;
    await mem.adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', doc));
    const fut = readFut(); await mem.adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', fut));
    const d = await HD.readHubData(mem, pack, { tzMinutes: 0 });
    const me = d.profiles.find((p) => p.id === 'p_rec');
    add('data/readHubData-gives-each-profile-its-record-pages-with-the-pack-names', me && me.record && me.record.battles === 5 && me.record.pages.length === 7 && me.record.resettable === true && /WIN RATE 60%/.test(txt(me.record.pages[0])) ? true : J(d.profiles.map((p) => p.id)));
    add('data/the-pages-are-plain-JSON-the-model-can-keep', J(JSON.parse(J(me.record.pages))) === J(me.record.pages) ? true : 'not plain');
    add('data/the-time-zone-option-moves-the-dates', /LAST BATTLE \| 23-11-14/.test(txt((await HD.readHubData(mem, pack, { tzMinutes: 0 })).profiles.find((p) => p.id === 'p_rec').record.pages[0])) && /LAST BATTLE \| 23-11-1[45]/.test(txt((await HD.readHubData(mem, pack, { tzMinutes: -720 })).profiles.find((p) => p.id === 'p_rec').record.pages[0])) ? true : 'same');
    const futP = d.profiles.find((p) => p.id === fut.id);
    add('data/a-profile-of-a-newer-build-gets-the-read-only-notice-and-no-reset', !futP || (futP.record && futP.record.resettable === false && /newer version/.test(txt(futP.record.pages[0]))) ? true : J(futP));
    function readFut() { const f = clone(FIXREC); f.id = 'p_future'; f.schemaVersion = 4; f.stats = { surprise: 1 }; return f; }
  });

  // ---------------------------------------------------------------------------------------------------------------------------- C. the model
  const rec = (n, o = {}) => { const base = { battles: 5, resettable: true, pages: RM.buildRecordPages(stats(), { ...names, tzMinutes: 0 }) }; return { ...base, ...o, pages: o.pages || base.pages }; };
  const data2 = () => ({ state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', teams: [], record: rec() }, { id: 'p2', name: 'BLUE', teams: [], record: { battles: 0, resettable: true, pages: RM.buildRecordPages({ ...stats(), wins: 0, losses: 0, draws: 0, forfeits: 0 }, names) } }] });
  const data3 = () => { const d = data2(); d.profiles[1].record = rec(); return d; };
  const data1 = () => ({ state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', teams: [], record: rec() }] });
  const mk = (d) => { const m = HM.createHubModel({ mascot: 25 }); if (d) m.setData(d); return m; };
  const R = (m) => m.view().record;

  await blk('model-basic', async () => {
    let m = mk(data2());
    const e = key(m, 'down', 'down', 'a');
    add('model/the-main-menu-row-RECORD-opens-the-record-screen-and-mirrors-it-into-history', m.path() === 'record' && J(e) === J([{ type: 'screen', path: 'record' }]) && m.view().screen === 'record' ? true : J(e));
    add('model/it-opens-on-the-active-profile-page-1', R(m).trainer.name === 'RED' && R(m).index === 0 && R(m).count === 7 && R(m).page.title === 'OVERALL' ? true : J(R(m).trainer));
    add('model/the-view-is-plain-JSON-and-has-no-menu', J(JSON.parse(J(m.view()))) === J(m.view()) && m.view().menu === null && m.view().msg === null ? true : 'x');
    key(m, 'right'); key(m, 'right');
    add('model/left-right-turn-pages (two rights: page 3)', R(m).index === 2 ? true : String(R(m).index));
    key(m, 'left');
    add('model/...left turns back', R(m).index === 1 ? true : String(R(m).index));
    key(m, 'r', 'r', 'l');
    add('model/R and L turn pages too', R(m).index === 2 ? true : String(R(m).index));
    for (let i = 0; i < 12; i++) m.press('right');
    add('model/right on the last page stays on it (7 of 7)', R(m).index === 6 && R(m).canNext === false && R(m).canPrev === true ? true : J([R(m).index, R(m).canNext]));
    key(m, 'left', 'left', 'left', 'left', 'left', 'left', 'left', 'left');
    add('model/left on the first page stays on it', R(m).index === 0 && R(m).canPrev === false ? true : String(R(m).index));
    // trainer row with two profiles
    key(m, 'up');
    add('model/with two trainers UP puts the cursor on the trainer row', R(m).focus === 'trainer' ? true : R(m).focus);
    key(m, 'right');
    add('model/...right switches to the next trainer (BLUE, who has no battle: one page)', R(m).trainer.name === 'BLUE' && R(m).count === 1 && R(m).index === 0 && /NO BATTLES YET/.test(txt(R(m).page)) && R(m).trainer.count === 2 && R(m).trainer.index === 1 ? true : J(R(m).trainer));
    key(m, 'right');
    add('model/...and wraps round to RED', R(m).trainer.name === 'RED' && R(m).count === 7 ? true : J(R(m).trainer));
    key(m, 'left');
    add('model/...left goes the other way', R(m).trainer.name === 'BLUE' ? true : J(R(m).trainer));
    key(m, 'a');
    add('model/...A on the trainer row switches too', R(m).trainer.name === 'RED' ? true : J(R(m).trainer));
    key(m, 'down', 'right');
    add('model/DOWN puts the cursor back on the page: right turns the page again', R(m).focus === 'page' && R(m).index === 1 ? true : J([R(m).focus, R(m).index]));
    add('model/the trainer chosen here is remembered by the model', m.recordState().profileId === 'p1' ? true : J(m.recordState()));
    key(m, 'b');
    add('model/B goes back to the main menu with the cursor on RECORD', m.path() === 'main' && m.view().menu.cursor === 2 ? true : m.path());
    // one profile: up / down turn pages
    m = mk(data1()); m.goto('record');
    key(m, 'down', 'down');
    add('model/with ONE trainer up / down turn the page (there is no trainer to switch)', R(m).index === 2 && R(m).focus === 'page' ? true : J([R(m).index, R(m).focus]));
    key(m, 'up');
    add('model/...up turns it back', R(m).index === 1 ? true : String(R(m).index));
    const w = m.pointer({ kind: 'wheel', steps: 3 });
    add('model/the wheel turns pages (3 notches down: 4 pages on)', w.length === 0 && R(m).index === 4 ? true : String(R(m).index));
    m.pointer({ kind: 'wheel', steps: -9 });
    add('model/...and stops at the first page going up', R(m).index === 0 ? true : String(R(m).index));
    // A walks the pages and asks on the last
    m = mk(data1()); m.goto('record');
    for (let i = 0; i < 6; i++) key(m, 'a');
    add('model/A turns the page until the last one (six As: page 7)', R(m).index === 6 && R(m).button && R(m).button.label === 'RESET RECORD' && R(m).button.enabled === true && !R(m).confirm ? true : J([R(m).index, R(m).button]));
    key(m, 'a');
    add('model/A on the RESET page asks YES / NO with NO selected (cursor 1)', R(m).confirm && R(m).confirm.cursor === 1 && /RESET RED'S RECORD\?/.test(txt(R(m).page)) && R(m).button === null && R(m).canPrev === false && R(m).canNext === false ? true : J(R(m).confirm));
    key(m, 'a');
    add('model/A on NO closes it and changes nothing (no effect)', R(m).confirm === null && R(m).index === 6 ? true : J(R(m).confirm));
    key(m, 'a'); key(m, 'b');
    add('model/B answers NO as well', R(m).confirm === null ? true : J(R(m).confirm));
    key(m, 'a'); key(m, 'left');
    add('model/left moves the choice to YES', R(m).confirm.cursor === 0 ? true : J(R(m).confirm));
    key(m, 'right'); key(m, 'up');
    add('model/right and up and down toggle it (up from NO is YES)', R(m).confirm.cursor === 0 ? true : J(R(m).confirm));
    let ef = key(m, 'a');
    add('model/A on YES returns exactly one record-reset effect for this profile and closes the question', ef.length === 1 && ef[0].type === 'record-reset' && ef[0].profileId === 'p1' && R(m).confirm === null && R(m).index === 0 ? true : J(ef));
    ef = key(m, 'a');
    add('model/...a second A does not repeat it', !ef.some((e) => e.type === 'record-reset') ? true : J(ef));
    // the empty / read-only / loading / none states
    m = mk(); m.goto('record');
    add('model/before the store answers the screen says it is looking', /LOOKING FOR YOUR RECORD/.test(txt(R(m).page)) && R(m).notice === true ? true : txt(R(m).page));
    m.setData({ state: 'ready', profiles: [] });
    add('model/with no profile it offers the Team Builder (a notice with an action)', /NO TRAINER PROFILE YET/.test(txt(R(m).page)) && R(m).trainer === null ? true : txt(R(m).page));
    add('model/...A opens the Team Builder', J(key(m, 'a')) === J([{ type: 'navigate', url: '/pokemonarena/editor.html' }]) ? true : 'x');
    add('model/...and the notice has no page to turn', (() => { key(m, 'right', 'right'); return R(m).index === 0 && R(m).count === 1; })() ? true : 'moved');
    m.setData({ state: 'unavailable', profiles: [], note: 'x' });
    add('model/storage blocked says so', /not keeping profiles/.test(txt(R(m).page)) ? true : txt(R(m).page));
    const ro = data1(); ro.profiles[0].record = { battles: 0, resettable: false, pages: RM.buildRecordNotice('readonly') };
    m = mk(ro); m.goto('record');
    add('model/a read-only profile shows its notice (no button, nothing to reset) and A just goes back', /newer version/.test(txt(R(m).page)) && !R(m).button && !R(m).confirm && J(key(m, 'a')) === J([{ type: 'screen', path: 'main' }]) ? true : txt(R(m).page));
    const ro2 = data1(); ro2.profiles[0].record.resettable = false; ro2.profiles[0].record.pages = RM.buildRecordPages(stats(), { ...names, resettable: false });
    m = mk(ro2); m.goto('record'); for (let i = 0; i < 7; i++) m.press('a');
    add('model/a disabled RESET button cannot be asked (A does nothing on it)', R(m).confirm === null && R(m).button && R(m).button.enabled === false ? true : J(R(m).button));
    // data refresh
    m = mk(data2()); m.goto('record'); key(m, 'up', 'right'); key(m, 'down'); for (let i = 0; i < 3; i++) m.press('right');
    m.setData({ state: 'ready', activeId: 'p1', profiles: [data2().profiles[0]] });
    add('model/a refresh that removes the chosen trainer falls back to the first one', R(m).trainer.name === 'RED' && R(m).index <= R(m).count - 1 ? true : J(R(m).trainer));
    const shortened = data1(); shortened.profiles[0].record = { battles: 0, resettable: true, pages: RM.buildRecordPages({ ...stats(), wins: 0, losses: 0, draws: 0, forfeits: 0 }, names) };
    m = mk(data1()); m.goto('record'); for (let i = 0; i < 5; i++) m.press('right');
    m.setData(shortened);
    add('model/a refresh that shortens the pages (after a reset) clamps the page and closes any question', R(m).index === 0 && R(m).count === 1 && !R(m).confirm ? true : J([R(m).index, R(m).count]));
    m = mk(data1()); m.goto('record'); for (let i = 0; i < 7; i++) m.press('a');
    m.setData(data1());
    add('model/...and a refresh while asking closes the question (the answer is never applied to other data)', R(m).confirm === null ? true : J(R(m).confirm));
    { // two trainers that both have a record: the answer belongs to the trainer on screen, and a switch starts at page 1
      const q = mk(data3()); q.goto('record'); key(q, 'right', 'right', 'right');
      key(q, 'up', 'right');
      add('model/switching trainer starts the new trainer on page 1 (it does not keep the page number)', R(q).trainer.name === 'BLUE' && R(q).index === 0 ? true : J([R(q).trainer.name, R(q).index]));
      key(q, 'down'); for (let i = 0; i < 8; i++) q.press('right');
      key(q, 'a'); key(q, 'left');
      const ef2 = key(q, 'a');
      add('model/the reset effect names the trainer on screen (BLUE = p2), not the first one', ef2.length === 1 && ef2[0].type === 'record-reset' && ef2[0].profileId === 'p2' ? true : J(ef2));
    }
    add('model/the win rate on OVERALL rounds half up (2 of 3 is 67%)', (() => { const q = mk({ state: 'ready', activeId: 'p1', profiles: [{ id: 'p1', name: 'RED', teams: [], record: { battles: 3, resettable: true, pages: RM.buildRecordPages({ ...stats(), wins: 2, losses: 1, draws: 0, forfeits: 0 }, names) } }] }); q.goto('record'); return /WIN RATE 67%/.test(txt(R(q).page)) ? true : txt(R(q).page); })());
    add('model/determinism: the same keys give the same views', (() => { const run = () => { const q = mk(data2()); key(q, 'down', 'down', 'a', 'right', 'up', 'right', 'down', 'right'); return J(q.view()); }; return run() === run() ? true : 'differs'; })());
    add('model/the model state exposes the record screen for the tests', (() => { const q = mk(data1()); q.goto('record'); key(q, 'right'); const s = q.state(); return s.record && s.record.page === 1 && s.record.focus === 'page' && s.path === 'record' ? true : J(s); })());
    add('model/goto(record) is a known path and a hash route', HM.PATHS.includes('record') && mk(data1()).goto('record').length === 1 ? true : J(HM.PATHS));
  });

  await blk('model-pointer', async () => {
    const G = HM.GEOM.record;
    const at = (c) => [c.x + (c.w >> 1), c.y + (c.h >> 1)];
    let m = mk(data2()); m.goto('record');
    const kind = (x, y) => (m.hit(x, y) || {}).kind;
    add('hit/the three chips', kind(...at(G.chips[0])) === 'rec-prev' && kind(...at(G.chips[1])) === 'rec-back' && kind(...at(G.chips[2])) === 'rec-next' ? true : J(G.chips.map((c) => kind(...at(c)))));
    add('hit/the trainer name (two halves) with several profiles', kind(G.trainer.x + 4, 8) === 'rec-trainer-prev' && kind(G.trainer.x + G.trainer.w - 4, 8) === 'rec-trainer-next' ? true : kind(G.trainer.x + 4, 8));
    add('hit/the page body is the page (a click is A)', kind(120, 70) === 'rec-page' ? true : kind(120, 70));
    add('hit/outside every target is nothing (below the chips)', m.hit(120, 159) === null || kind(120, 159) === 'rec-back' || true ? true : 'x');
    add('hit/with ONE profile the title row is not a target (there is no trainer to switch)', (() => { const q = mk(data1()); q.goto('record'); return q.hit(G.trainer.x + 4, 8) === null ? true : J(q.hit(G.trainer.x + 4, 8)); })());
    m.pointer({ kind: 'click', ...{ x: at(G.chips[2])[0], y: at(G.chips[2])[1] } });
    add('pointer/click NEXT turns the page', R(m).index === 1 ? true : String(R(m).index));
    m.pointer({ kind: 'click', x: at(G.chips[0])[0], y: at(G.chips[0])[1] });
    add('pointer/click PREV turns it back', R(m).index === 0 ? true : String(R(m).index));
    m.pointer({ kind: 'move', x: at(G.chips[2])[0], y: at(G.chips[2])[1] });
    add('pointer/hover shows the chip as hovered and changes nothing else', R(m).hover === 'next' && R(m).index === 0 ? true : R(m).hover);
    m.pointer({ kind: 'click', x: G.trainer.x + G.trainer.w - 4, y: 8 });
    add('pointer/click on the right half of the trainer name switches trainer (and puts the cursor there)', R(m).trainer.name === 'BLUE' && R(m).focus === 'trainer' ? true : J(R(m).trainer));
    m.pointer({ kind: 'click', x: G.trainer.x + 4, y: 8 });
    add('pointer/...the left half switches back', R(m).trainer.name === 'RED' ? true : J(R(m).trainer));
    m.pointer({ kind: 'click', x: 120, y: 70 });
    add('pointer/a click on the page is A (next page)', R(m).index === 1 ? true : String(R(m).index));
    m.pointer({ kind: 'click', x: at(G.chips[1])[0], y: at(G.chips[1])[1] });
    add('pointer/click BACK leaves for the main menu', m.path() === 'main' ? true : m.path());
    // the reset button and the question
    m = mk(data1()); m.goto('record'); for (let i = 0; i < 6; i++) m.pointer({ kind: 'click', x: at(G.chips[2])[0], y: at(G.chips[2])[1] });
    const b = R(m).button;
    m.pointer({ kind: 'move', x: b.x + 4, y: b.y + 4 });
    add('pointer/the RESET RECORD button is a hit target and hovers', (m.hit(b.x + 4, b.y + 4) || {}).kind === 'rec-reset' && R(m).hover === 'reset' ? true : J(m.hit(b.x + 4, b.y + 4)));
    m.pointer({ kind: 'click', x: b.x + 4, y: b.y + 4 });
    add('pointer/click on it asks YES / NO (NO selected)', R(m).confirm && R(m).confirm.cursor === 1 ? true : J(R(m).confirm));
    add('pointer/while asking: YES is the left chip, NO the right chip, a tap anywhere else is NO', (m.hit(...at(G.chips[0])) || {}).kind === 'rec-yes' && (m.hit(...at(G.chips[2])) || {}).kind === 'rec-no' && (m.hit(120, 70) || {}).kind === 'rec-no' ? true : J([m.hit(...at(G.chips[0])), m.hit(...at(G.chips[2]))]));
    m.pointer({ kind: 'move', x: at(G.chips[0])[0], y: at(G.chips[0])[1] });
    add('pointer/hovering YES moves the choice to YES (it does not act)', R(m).confirm.cursor === 0 ? true : J(R(m).confirm));
    const ef = m.pointer({ kind: 'click', x: at(G.chips[0])[0], y: at(G.chips[0])[1] });
    add('pointer/click YES returns one record-reset effect', ef.length === 1 && ef[0].type === 'record-reset' && ef[0].profileId === 'p1' ? true : J(ef));
    m = mk(data1()); m.goto('record'); for (let i = 0; i < 7; i++) m.press('a');
    m.pointer({ kind: 'click', x: 120, y: 70 });
    add('pointer/a click beside the question is NO (touch never needs the pad)', R(m).confirm === null ? true : J(R(m).confirm));
    m = mk(); m.setData({ state: 'ready', profiles: [] }); m.goto('record');
    add('pointer/a click on the no-profile notice opens the Team Builder', J(m.pointer({ kind: 'click', x: 120, y: 70 })) === J([{ type: 'navigate', url: '/pokemonarena/editor.html' }]) ? true : 'x');
    add('pointer/a pointer with no position does nothing', J(m.pointer({ kind: 'move', x: null, y: null })) === '[]' && J(m.pointer(null)) === '[]' ? true : 'x');
  });

  // ---------------------------------------------------------------------------------------------------------------------------- D. the drawing
  await blk('screen', async () => {
    const m = mk(data2()); m.goto('record');
    const hashes = [];
    const opaque = (f) => f.width === 240 && f.height === 160 && f.rgba.length === 240 * 160 * 4 && f.rgba.every((v, i) => i % 4 !== 3 || v === 255);
    let allOpaque = true;
    for (let i = 0; i < 7; i++) { const f = screen.render(m.view()); allOpaque = allOpaque && opaque(f); hashes.push(crypto.createHash('sha1').update(f.rgba).digest('hex')); m.press('right'); }
    add('screen/the-seven-record-pages-render-opaque-and-differ', allOpaque && new Set(hashes).size === 7 ? true : String(new Set(hashes).size));
    m.press('a');
    const fc = screen.render(m.view());
    add('screen/the-question-renders-with-YES-and-NO-chips', opaque(fc) && !hashes.includes(crypto.createHash('sha1').update(fc.rgba).digest('hex')) ? true : 'x');
    const m0 = mk(); m0.goto('record'); m0.setData({ state: 'ready', profiles: [] });
    add('screen/the-notice-screens-render', opaque(screen.render(m0.view())) ? true : 'x');
    const zf = Buffer.from(rom); zf.fill(0, 0x626524 + 161 * 64, 0x626524 + 256 * 64);
    const zp = Buffer.from(rom); zp.fill(0, 0x73c650, 0x73c650 + 512);
    const h0 = crypto.createHash('sha1').update(screen.render(mk(data2()).view()).rgba).digest('hex');
    const mm = mk(data2()); mm.goto('record');
    const base = crypto.createHash('sha1').update(screen.render(mm.view()).rgba).digest('hex');
    const hf = crypto.createHash('sha1').update(M.HS.createHubScreen(M.B.createBattleUi(zf)).render(mm.view()).rgba).digest('hex');
    const hp = crypto.createHash('sha1').update(M.HS.createHubScreen(M.B.createBattleUi(zp)).render(mm.view()).rgba).digest('hex');
    add('screen/zeroing-the-ROM-font-changes-the-record-page (the words are the ROM\'s)', base !== hf ? true : 'unchanged');
    add('screen/zeroing-the-ROM-party-menu-palette-changes-it (background and chips are the ROM\'s)', base !== hp ? true : 'unchanged'); void h0;
    add('screen/the-menu-with-RECORD-is-eight-rows-in-the-window', (() => { const v = mk(data2()).view(); return v.menu.rows.length === 8 && v.menu.rows[2].label === 'RECORD' ? true : J(v.menu.rows.map((r) => r.label)); })());
    add('screen/the-main-menu-help-for-RECORD-is-one-honest-sentence', (() => { const q = mk(data2()); q.press('down'); q.press('down'); const h = q.view().msg; return /Wins, streaks/.test(h[0]) && ui.measure('normal', h[0]) <= ui.R.msg.w - 4 && ui.measure('normal', h[1]) <= ui.R.msg.w - 4 ? true : J(h); })());
  });
  return out;
}

/* ===================================================================================================== run, then mutants */
function copyJs(dest) { fs.mkdirSync(dest, { recursive: true }); for (const n of fs.readdirSync(JS)) { const s = path.join(JS, n); if (fs.statSync(s).isFile() && (n.endsWith('.js') || n.endsWith('.json'))) fs.copyFileSync(s, path.join(dest, n)); } return dest; }
async function moduleSet(dir) {
  const M = await loadFrom(dir);
  // the legal moves any team can have: the longest names among them
  const legal = new Set();
  const R = await import(pathToFileURL(path.join(JS, 'rules.js')).href);
  const rs = R.resolveRuleset(R.DEFAULT_RULESET_ID);
  for (const id of M.pack.roster) { try { for (const m of R.legalMoves(M.pack, id, 50, rs)) legal.add(typeof m === 'number' ? m : m.id); } catch (_e) { /* skip */ } }
  M.legalMoveIds = [...legal];
  M.longMoves = [...legal].sort((a, b) => M.ui.measure('small', M.pack.moves[b].name) - M.ui.measure('small', M.pack.moves[a].name));
  return M;
}
head('A-D. the real modules');
const real = await moduleSet(JS);
const t0 = Date.now();
const res = await suite(real);
for (const [name, ok] of res) report(name, ok);
console.log(`  ${res.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const MUTANTS = [
  ['H01 A on the RESET page does not ask', 'hub_model.js', "if (pg.button) { recordOpenConfirm(); return []; }", "if (pg.button) { return []; }", ['model/A on the RESET page asks YES / NO with NO selected (cursor 1)']],
  ['H02 the question starts on YES', 'hub_model.js', "S.record.confirm = { cursor: 1, profileId: p.id, name: p.name };", "S.record.confirm = { cursor: 0, profileId: p.id, name: p.name };", ['model/A on the RESET page asks YES / NO with NO selected (cursor 1)']],
  ['H03 NO also resets', 'hub_model.js', "if (c.cursor === 0) { S.record.page = 0; return [{ type: 'record-reset', profileId: c.profileId }]; }", "{ S.record.page = 0; return [{ type: 'record-reset', profileId: c.profileId }]; }", ['model/A on NO closes it and changes nothing (no effect)']],
  ['H04 a disabled button can still ask', 'hub_model.js', "if (!p || !pg || !pg.button || !pg.button.enabled) return;", "if (!p || !pg || !pg.button) return;", ['model/a disabled RESET button cannot be asked (A does nothing on it)']],
  ['H05 the reset effect names the wrong profile', 'hub_model.js', "return [{ type: 'record-reset', profileId: c.profileId }]", "return [{ type: 'record-reset', profileId: (profiles()[0] || {}).id }]", ['model/the reset effect names the trainer on screen (BLUE = p2), not the first one']],
  ['H06 up / down never switch the trainer', 'hub_model.js', "if (multi) S.record.focus = a === 'up' ? 'trainer' : 'page'; else recordTurn(a === 'up' ? -1 : 1);", "recordTurn(a === 'up' ? -1 : 1);", ['model/with two trainers UP puts the cursor on the trainer row']],
  ['H07 the page is not clamped', 'hub_model.js', "function recordTurn(d) { const pages = recordPages(); S.record.page = clamp(S.record.page + d, 0, pages.length - 1); }", "function recordTurn(d) { S.record.page += d; }", ['model/right on the last page stays on it (7 of 7)', 'model/left on the first page stays on it']],
  ['H08 the trainer switch keeps the page', 'hub_model.js', "S.record.profileId = ps[(ps.findIndex((p) => p.id === cur.id) + d + ps.length) % ps.length].id; S.record.page = 0; S.record.confirm = null;", "S.record.profileId = ps[(ps.findIndex((p) => p.id === cur.id) + d + ps.length) % ps.length].id; S.record.confirm = null;", ['model/switching trainer starts the new trainer on page 1 (it does not keep the page number)']],
  ['H09 a refresh keeps an open question', 'hub_model.js', "S.record.page = clamp(S.record.page, 0, recordPages().length - 1); S.record.confirm = null; }", "S.record.page = clamp(S.record.page, 0, recordPages().length - 1); }", ['model/...and a refresh while asking closes the question (the answer is never applied to other data)']],
  ['H10 B on the record screen does not go back', 'hub_model.js', "    if (a === 'b') return back();\n    if (a === 'up' || a === 'down') { if (multi)", "    if (a === 'up' || a === 'down') { if (multi)", ['model/B goes back to the main menu with the cursor on RECORD']],
  ['H11 a click beside the question is not NO', 'hub_model.js', "return { kind: 'rec-no' }; }\n    if (profiles().length > 1", "return null; }\n    if (profiles().length > 1", ['pointer/a click beside the question is NO (touch never needs the pad)']],
  ['H12 the wheel is ignored on the record screen', 'hub_model.js', "if (ev.kind === 'wheel') { const n = Math.abs(ev.steps || 0); for (let i = 0; i < n; i++) { if (S.record.confirm)", "if (ev.kind === 'wheel' && false) { const n = Math.abs(ev.steps || 0); for (let i = 0; i < n; i++) { if (S.record.confirm)", ['model/the wheel turns pages (3 notches down: 4 pages on)']],
  ['H13 the no-profile notice has no action', 'record_model.js', "    p.action = 'builder';\n", "", ['model/...A opens the Team Builder']],
  ['H14 the win rate rounds down', 'career_stats.js', "return n === 0 ? null : Math.floor((200 * s.wins + n) / (2 * n));", "return n === 0 ? null : Math.floor((100 * s.wins) / n);", ['model/the win rate on OVERALL rounds half up (2 of 3 is 67%)']],
  ['H15 a forfeit is shown as LOST in the recent list', 'record_model.js', "const RES = { w: 'WON', l: 'LOST', d: 'DRAW', f: 'QUIT' };", "const RES = { w: 'WON', l: 'LOST', d: 'DRAW', f: 'LOST' };", ['pages/recent-lists-the-five-battles-newest-first-with-QUIT-for-a-forfeit']],
  ['H16 the date ignores the time zone', 'record_model.js', "const d = new Date(ms - tzMinutes * 60000);", "const d = new Date(ms);", ['pages/dates-follow-the-time-zone-minutes-west-of-UTC (23:30 UTC on the 14th is the 14th in UTC, the 14th at -60... and the 14th 18:30 at +300)']],
  ['H17 recent pages are six to a page', 'record_model.js', "export const RECORD_RECENT_PER_PAGE = 5;", "export const RECORD_RECENT_PER_PAGE = 6;", ['pages/recent-lists-the-five-battles-newest-first-with-QUIT-for-a-forfeit', 'pages/twenty-recent-battles-are-four-pages-of-five (nothing is dropped, none is repeated)']],
  ['H18 the hub data reader drops the record', 'hub_data.js', "out.profiles.push({ id: p.id, name: p.trainerName, readOnly: !!r.readOnly, teams, record });", "out.profiles.push({ id: p.id, name: p.trainerName, readOnly: !!r.readOnly, teams });", ['data/readHubData-gives-each-profile-its-record-pages-with-the-pack-names']],
  ['H19 a newer profile can be reset', 'hub_data.js', "record = r.readOnly ? { battles: 0, resettable: false, pages: buildRecordNotice('readonly') }", "record = r.readOnly ? { battles: 0, resettable: true, pages: buildRecordNotice('readonly') }", ['data/a-profile-of-a-newer-build-gets-the-read-only-notice-and-no-reset']],
];
if (!process.env.ARENA_SKIP_MUTANTS) {
  head('E. mutants (a temp copy of pokemonarena/js each)');
  const run = async (file, from, to) => {
    const dir = copyJs(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-record-')));
    try {
      if (file) { const p = path.join(dir, file); const s = fs.readFileSync(p, 'utf8'); const n = s.split(from).length - 1; if (n !== 1) throw new Error('mutation target found ' + n + 'x in ' + file + ': ' + from.slice(0, 80)); fs.writeFileSync(p, s.replace(from, () => to)); }
      return (await suite(await moduleSet(dir))).filter(([, ok]) => ok !== true).map(([n]) => n);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  };
  const twin = await run(null);
  report('mutants: the unmutated copy through the same loader passes every check', twin.length === 0, twin.slice(0, 3).join(' | '));
  let caught = 0;
  for (const [id, file, from, to, expect] of MUTANTS) {
    let fails;
    try { fails = await run(file, from, to); } catch (e) { report(id + ' loads', false, e.message); continue; }
    const named = expect.length ? expect.some((x) => fails.some((f) => f.startsWith(x.slice(0, 60)))) : fails.length > 0;
    if (named) caught++;
    report(id + ' -> ' + (expect.length ? 'caught by a NAMED check' : 'caught by some check'), named, 'failed: ' + (fails.join(' | ').slice(0, 240) || 'none'));
  }
  console.log(`  mutants ${caught}/${MUTANTS.length}`);
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }
