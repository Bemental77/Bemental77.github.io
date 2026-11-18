#!/usr/bin/env node
// POKEMON ARENA TOWER PAGE TEST -- the playable Tower in real headless Chrome: the hub's TOWER screens, a floor on battle.html, and the way back, by touch, by keyboard and by controller.
//
//   node tools/pokemonarena_tower_page_test.mjs        ARENA_PORT=8660 ARENA_CDP=10200 ARENA_OUT=<dir for screenshots (open them)>
//
// SESSIONS (tools/headless_cdp.mjs: one muted headless Chrome per session with a throwaway profile, bare CDP; AudioContext and the gamepad are test doubles)
//   phone    390x844 @2x, TOUCH ONLY (the on-screen pad and taps on the canvas): a plain Quick Battle first, a run made in the real IndexedDB, TOWER row -> MY BUFFS -> FIGHT; floor 1 won; the offer by TOUCH
//            (tap a ball -> "take this buff?" -> NO -> tap it again -> YES); floor 2 with that buff on the page; the second offer SKIPPED by touch; floor 3, THE RETRIES: a loss (FORFEIT), RETRY FLOOR offered,
//            the retry counted once, a reload at the result that does not count it again, LEAVE TOWER before a choice that costs nothing, the hub showing RETRY FLOOR 3 and RETRIES LEFT 2/3, a fight left
//            mid-way that costs one retry while the run goes on, and the loss after the third retry of the floor that ENDS the run; what LEAVE TOWER / FORFEIT say it costs at each point;
//            the LAST RUN (with its retries) and ACHIEVEMENTS screens; the profile's career record is byte-identical to before the climb; a plain Quick Battle in the same browser plays EXACTLY the battle it played before
//   desktop  1280x800, keyboard + the synthetic controller: a mid-fight RELOAD resumes the floor (and the floor counts once); the offer by CONTROLLER; a fight LEFT by a typed address is a lost try (it costs
//            one retry and the run goes on); hostile Tower addresses are refused and write nothing; NEW RUN from the hub gives the run under way up (counted, with its retry) and opens floor 1 of a new one
//   history  1280x800: THE BROWSER'S BACK AND FORWARD IN THE MIDDLE OF A RETRY (the review of 2026-11-17: Back out of a retry cost a retry at once, and ended the climb on the last try). A retry opened from the
//            hub (Back past the hub lands on the LOST try's battle page: "Another try of this floor", nothing counted); a retry opened by RETRY FLOOR on the result screen (it REPLACES the lost try's page,
//            so Back is the hub); the last try with TWO pages of it in the history, their addresses spelled differently (Back onto the other one RESUMES the fight there). At each: nothing is counted, the
//            climb does not end, Forward resumes the fight at the same battle state; a page that opens another try than its address names puts the try into its address
//   residual  1280x800: START, START, B, NEW RUN, START in one tick makes ONE profile and ONE run; LEAVE TOWER before any choice costs NOTHING (the same run still waits); TWO TABS on one floor (the second is
//            told it is a duplicate, and RELOADED it does not take over the first's fight: the fight counts as left, one retry); three reloads at #tower-last add nothing to the history, B, B still ends on the
//            main menu, a Back arrival keeps Forward
//   integrity  1280x800: a double START with no profile makes ONE profile and ONE run; no OPEN TO BATTLES in a Tower fight; the Tower has the result when the ENGINE ends the match (before the result screen), and
//            a reload there writes nothing (a won floor shows "already counted", a lost one opens its next try); four fights of a floor left in a row end the run; B, B from #tower-offer and from #tower-last stay inside the hub; the note after a ball is taken shows; a regular battle still mounts OPEN TO BATTLES
// Every check that reads the store reads the REAL IndexedDB through the game's own store.js. Screenshots go to ARENA_OUT.
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { BASE, sleep, key, tapLogical, clickLogical, padPress, tapSel, errsOf, AUDIO_DOUBLE, PAD_DOUBLE, addInit } = L;
const J = L.J;
const OUT = process.env.ARENA_OUT || L.DEFAULT_OUT;
const CDP0 = L.CDP0;
const C = L.makeCounter('tower-page');
const ok = C.ok;
fs.mkdirSync(OUT, { recursive: true });
const HM = await L.mod('hub_model.js');
const B = '(window.__arenaBattle)';
const HUB = '(window.__arenaHub)';
const ev = (page, e) => page.eval(e);
const shot = async (page, name) => { await page.screenshot(path.join(OUT, 'tower_' + name + '.png')); return name; };
const SEED_A = 4242, SEED_B = 1;      // the run seeds of the two climbs (a run's seed fixes its trainers, its offers and every battle: the plays below are the same every time)
const TEAM = ['Charizard', 'Blastoise', 'Venusaur', 'Snorlax', 'Dragonite', 'Tyranitar'];

/* ---------------------------------------------------------------------------------------------------------------- in-page helpers */
const IMPORTS = `const S = await import('/pokemonarena/js/store.js'), P = await import('/pokemonarena/js/profile.js'), R = await import('/pokemonarena/js/rules.js'), TB = await import('/pokemonarena/js/tables.js'), RF = await import('/pokemonarena/js/romfetch.js'), TS = await import('/pokemonarena/js/tower_session.js');
  const { bytes } = await RF.loadVerifiedRom(); const pack = TB.loadPack(bytes, { verify: 'header', dexText: false });`;
const SEED_TEAM = (trainer, names) => `(async () => { ${IMPORTS}
  const store = await S.openStore();
  const mk = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name); if (sid < 0) throw new Error('no species ' + name); const rec = R.blankRec(sid, pack, R.DEFAULT_RULESET_ID); const ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
  const created = await store.createProfile({ trainerName: ${J(trainer)} });
  const mons = ${J(names)}.map(mk);
  const saved = await store.saveProfile({ ...created, box: mons, teams: [P.createTeam({ name: 'Six', monIds: mons.map((m) => m.id) })] }, { reason: 'seed' });
  await store.setActiveId(saved.id); await store.close();
  return { id: saved.id, team: saved.teams[0].id };
})()`;
// a run in the profile, with a seed that fixes it (the hub's NEW RUN picks a fresh one)
const START_RUN = (pid, tid, seed, fmt) => `(async () => { ${IMPORTS}
  const store = await S.openStore();
  try { const l = await store.loadProfile(${J(pid)}); const team = TS.teamSnapshot(l.profile, ${J(tid)});
    const ses = TS.createTowerSession({ pack, persist: TS.storePersist(store, ${J(pid)}) });
    const r = await ses.startRun({ seed: ${seed}, format: ${J(fmt)}, team, replace: true });
    return { applied: !!(r && r.applied), why: r && r.why || null, floor: r && r.run && r.run.floor, phase: r && r.run && r.run.phase };
  } finally { await store.close(); } })()`;
const READ = (pid) => `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); try { const l = await store.loadProfile(${J(pid)}); return { stats: l.profile.stats, tower: l.profile.tower, rev: l.profile.rev, readOnly: !!l.readOnly }; } finally { await store.close(); } })()`;
const tw = async (page, pid) => (await ev(page, READ(pid))).tower;
const statsJ = async (page, pid) => J((await ev(page, READ(pid))).stats);
const until = async (fn, ms = 20000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(150); } return v; };
const nBattles = (s) => s.wins + s.losses + s.draws + s.forfeits;

/* ---------------------------------------------------------------------------------------------------------------- page helpers */
const hubReady = async (page) => {
  await page.waitFor(`window.__arenaHub && ${HUB}.state === 'ready' && ${HUB}.data && ${HUB}.data.state === 'ready'`, { timeoutMs: 90000 });
  await page.waitFor(`${HUB}.tower && ${HUB}.tower.loaded()`, { timeoutMs: 30000 });
  await sleep(250);
};
const openHub = async (page, hash = '') => { await page.navigate(BASE + '/pokemonarena/' + hash); await hubReady(page); };
const where = (page) => ev(page, `${HUB}.model.path()`);
const hview = (page) => ev(page, `${HUB}.model.view()`);
const rowsOf = (page) => ev(page, `${HUB}.model.rows().map((r) => r.id)`);
const labelsOf = (page) => ev(page, `${HUB}.model.view().menu ? ${HUB}.model.view().menu.rows.map((r) => r.label) : []`);
const rectMid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const hubRects = (page) => ev(page, `${HUB}.model.rects()`);
// the main menu has eight rows shown at the 8-row pitch: row i of the window
const mainY = (i) => HM.GEOM.menu.y + i * HM.menuPitch(8) + (HM.menuPitch(8) >> 1);
const tapRect = async (page, i) => { const r = (await hubRects(page))[i]; const m = rectMid(r); await tapLogical(page, `${HUB}.canvas`, m.x - 20, m.y); await sleep(220); };
const tapRow = async (page, id) => { const i = (await rowsOf(page)).indexOf(id); if (i < 0) throw new Error('no row ' + id); await tapRect(page, i); };
const YES = { x: 170, y: 127 }, NO = { x: 210, y: 127 };
const tapAt = async (page, p) => { await tapLogical(page, `${HUB}.canvas`, p.x, p.y); await sleep(220); };

const toBattle = async (page) => {
  await page.waitFor(`location.pathname.endsWith('battle.html') && window.__arenaBattle && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
  return ev(page, `${B}.state`);
};
const openBattle = async (page, query) => { await page.navigate(BASE + '/pokemonarena/battle.html' + (query || '')); await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 }); return ev(page, `${B}.state`); };
// plays the human's seat by hand (team preview, confirm, action, moves, party, text) until `cond` holds or the battle is over
const DRIVE = (cond) => `(() => { const a = ${B}; for (let g = 0; g < 600000; g++) { a.scene.tick(); if (${cond}) return a.mode; if (a.mode === 'result') return a.mode; const m = a.mode; if (m === 'preview') { const p = a.scene.S.preview; if (p.picks.length < p.pick) { a.press('a'); if (a.mode === 'preview') a.press('down'); } } else if (m === 'confirm') { if (a.scene.S.confirm.kind === 'team') a.press('a'); } else if (m === 'action' || m === 'moves' || m === 'party') a.press('a'); else if (m === 'steps' && g % 61 === 0) a.press('a'); } return a.mode; })()`;
const finish = async (page) => { const r = await ev(page, `${B}.autoplay(900000, 'hard')`); await page.waitFor(`${B}.mode === 'result'`, { timeoutMs: 20000 }); await page.waitFor(`${B}.scene.state().resultArmed`, { timeoutMs: 25000 }); return r; };
const barOf = (page) => ev(page, `(() => { const b = document.getElementById('towerBar'); return b ? { hidden: b.hidden, text: b.textContent } : null; })()`);
const resultOpts = (page) => ev(page, `(() => { const v = ${B}.view(); return v.result ? v.result.options : null; })()`);
// the pause menu: START opens it, UP wraps to the last row (LEAVE TOWER), A asks, UP flips to YES, A answers
const LEAVE = `(() => { const a = ${B}; a.press('start'); a.press('up'); a.press('a'); a.press('up'); a.press('a'); return a.mode; })()`;
// ... and its two questions, read off the scene: LEAVE TOWER is the last row (UP wraps to it), FORFEIT the row above. ASK opens the question and says what it asks; ANSWER(true) is YES, ANSWER(false) is NO
const ASK = (row) => `(() => { const a = ${B}; a.press('start'); a.press('up'); ${row === 'forfeit' ? "a.press('up');" : ''} a.press('a'); const v = a.view(), c = a.scene.S.confirm; return { mode: a.mode, kind: c ? c.kind : null, text: v.preview ? v.preview.title : v.box && v.box.text ? v.box.text.join(' ') : null }; })()`;
const ANSWER = (yes) => `(() => { const a = ${B}; ${yes ? "a.press('up'); a.press('a');" : "a.press('b');"} return a.mode; })()`;
// lose the floor the run is on until the run is over, through the game's own session (the history checks of the residual session need a run that ENDED)
const LOSE_OUT = (pid) => `(async () => { ${IMPORTS}
  const store = await S.openStore();
  try { const ses = TS.createTowerSession({ pack, persist: TS.storePersist(store, ${J(pid)}) }); let n = 0;
    for (let g = 0; g < 8; g++) { const t = await ses.read(); if (!t.current) break; const r = await ses.finishFloor({ floor: t.current.floor, seed: t.current.seed, result: { floor: t.current.floor, result: 'l', turns: 3, faints: 3 } }); if (r && r.applied) n++; }
    const t = await ses.read(); return { n, current: t.current, last: t.last, runs: t.runs };
  } finally { await store.close(); } })()`;

/* ---------------------------------------------------------------------------------------------------------------- the quick battle that must be the same before and after a climb */
const QUICK = '?seed=11&format=3v3&cpu=easy';
const playQuick = async (page) => {
  const st = await openBattle(page, QUICK);
  if (st !== 'ready') return { state: st };
  const r = await ev(page, `${B}.autoplay(900000, 'normal')`);
  const info = await ev(page, `({ tower: ${B}.tower === undefined || ${B}.tower === null ? null : 'present', bar: (document.getElementById('towerBar') || {}).hidden, title: document.title })`);
  await page.waitFor(`${B}.career && ['saved', 'duplicate', 'none', 'error'].includes(${B}.career.state)`, { timeoutMs: 20000 });
  return { state: st, hash: r.hash, turns: r.turns, winner: r.winner, ...info, career: await ev(page, `${B}.career.state`) };
};

const ONLY_SESSIONS = (process.env.ARENA_SESSIONS || '').split(',').filter(Boolean);          // ARENA_SESSIONS=residual runs just the sessions whose name starts with one of these
async function session(name, opts, fn) {
  if (ONLY_SESSIONS.length && !ONLY_SESSIONS.some((s) => name.startsWith(s))) return;
  console.log('--- ' + name + ' (' + opts.width + 'x' + opts.height + (opts.dpr ? ' @' + opts.dpr + 'x' : '') + (opts.mobile ? ' mobile' : '') + ') ' + L.loadPct());
  try {
    await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
      await page.setViewport(opts.width, opts.height, { mobile: !!opts.mobile, dpr: opts.dpr || 1 });
      await addInit(page, AUDIO_DOUBLE);
      if (opts.pad) await addInit(page, PAD_DOUBLE);
      await fn(page);
    });
  } catch (e) { ok(false, name + ': session threw', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
}

let server = null;
try {
  console.log('before the browser: ' + L.loadPct());
  L.reapLeaks();
  server = await L.startServer('/pokemonarena/');
  console.log('dev server up on ' + BASE);
  let cdp = CDP0;

  /* ================================================================================================================ phone */
  await session('phone: touch only', { width: 390, height: 844, mobile: true, dpr: 2, port: cdp++ }, async (page) => {
    const tag = 'phone: ';
    await openHub(page);
    const seeded = await ev(page, SEED_TEAM('ASH', TEAM)); const pid = seeded.id;
    ok(!!pid && !!seeded.team, tag + 'a trainer with a team of six is in the real IndexedDB');
    // ---- the baseline: a plain Quick Battle, played before there is any Tower run
    const q0 = await playQuick(page);
    ok(q0.state === 'ready' && q0.tower === null && q0.bar === true && !/Tower/.test(q0.title) && q0.career === 'saved', tag + 'a plain Quick Battle has no Tower on it (no bar, no controller, the career saves it)', J(q0));
    const s0 = await statsJ(page, pid);
    const n0 = nBattles(JSON.parse(s0));
    ok(n0 === 1, tag + 'and the career counted it (one battle)', String(n0));

    // ---- a run in the profile, then the hub
    const started = await ev(page, START_RUN(pid, seeded.team, SEED_A, '3v3'));
    ok(started.applied && started.floor === 1 && started.phase === 'battle', tag + 'a run starts at floor 1, waiting for its fight', J(started));
    await openHub(page);
    ok((await where(page)) === 'main' && (await rowsOf(page)).indexOf('tower') === 2, tag + 'the hub opens on the main menu; TOWER is its third row');
    await tapLogical(page, `${HUB}.canvas`, 60, mainY(2)); await sleep(300);
    ok((await where(page)) === 'tower', tag + 'tapping TOWER opens the Tower screen');
    const home = await labelsOf(page);
    ok(home[0] === 'FIGHT: FLOOR 1' && home.includes('MY BUFFS') && home.includes('ACHIEVEMENTS'), tag + 'it offers FIGHT: FLOOR 1, MY BUFFS and ACHIEVEMENTS', J(home));
    ok((await page.eval(`${HUB}.model.view().tower.panel.lines[1]`)) === 'FLOOR 1/30', tag + 'the status panel says FLOOR 1/30');
    await shot(page, 'phone_1_home');
    await tapRow(page, 'buffs');
    ok((await where(page)) === 'tower-buffs' && (await hview(page)).tower.total === 0, tag + 'MY BUFFS opens, with nothing held yet');
    await tapSel(page, '#bB'); await sleep(250);
    ok((await where(page)) === 'tower', tag + 'the on-screen B steps back to the Tower screen');
    await tapRect(page, 0);                                                      // FIGHT
    ok((await toBattle(page)) === 'ready', tag + 'FIGHT opens the floor on the battle page', await ev(page, `${B}.state`));
    ok((await ev(page, 'location.search')).includes('floor=1') && (await ev(page, 'location.search')).includes('run=' + SEED_A), tag + 'the address names the floor and the run, nothing else', await ev(page, 'location.search'));
    let bar = await barOf(page);
    ok(bar && bar.hidden === false && /FLOOR 1/.test(bar.text), tag + 'the Tower bar is shown and names the floor', J(bar));
    ok((await ev(page, `${B}.tower.spec.tower.buffs`)) === 0 && (await ev(page, `${B}.tower.spec.tower.floor`)) === 1 && (await ev(page, `Object.values(${B}.tower.spec.tower.effects).some((v) => v)`)) === false, tag + 'floor 1 carries no buffs and no buff effects', J(await ev(page, `${B}.tower.spec.tower`)));
    const tag1 = await ev(page, `${B}.tower.tag`);
    await shot(page, 'phone_2_floor1');
    await finish(page);
    ok((await ev(page, `${B}.ctl.winner`)) === 0, tag + 'floor 1 is won (the calibrated seed: if this fails the seed or the engine changed)', String(await ev(page, `${B}.ctl.winner`)));
    const o1 = await resultOpts(page);
    ok(J(o1) === J(['PICK A BUFF', 'BACK TO HUB']), tag + 'the result offers PICK A BUFF and BACK TO HUB', J(o1));
    let t1 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'offer' ? t : null; });
    ok(!!t1 && t1.current.floor === 2 && t1.current.offer && t1.current.offer.length === 3 && t1.current.fighting === false, tag + 'the profile holds the run at the floor-2 offer: three balls, fight flag cleared', J(t1 && t1.current && t1.current.phase));
    ok(statsJ && (await statsJ(page, pid)) === s0, tag + 'the career record is untouched by the Tower floor');
    await shot(page, 'phone_3_result');
    await tapSel(page, '#bA');                                                    // PICK A BUFF (first option)
    await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 });
    await hubReady(page);
    ok((await where(page)) === 'tower-offer' && (await page.eval('location.hash')) === '#tower-offer', tag + 'the hub opens on the buff offer by itself (the address carries #tower-offer)', (await where(page)) + ' ' + await page.eval('location.hash'));
    const offer = (await hview(page)).tower;
    ok(offer.balls.length === 3 && offer.balls.every((b) => b.name && b.color && b.ball >= 0) && J(offer.balls.map((b) => b.id)) === J(t1.current.offer.map((b) => b.id)), tag + 'three Poke Balls show the three buffs that were stored', J(offer.balls.map((b) => b.rarity)));
    await shot(page, 'phone_4_offer');
    // by TOUCH: a tap on a ball opens the prompt; a tap on NO answers no; a tap on the ball and YES takes it
    await tapRect(page, 1);
    let v = (await hview(page)).tower;
    ok(v.cursor === 1 && v.confirm && v.confirm.kind === 'take', tag + 'a tap on the second ball opens "take this buff?" and takes nothing', J(v.confirm));
    await shot(page, 'phone_5_offer_confirm');
    await tapAt(page, NO);
    ok(!(await hview(page)).tower.confirm && (await tw(page, pid)).current.phase === 'offer', tag + 'a tap on NO keeps the offer');
    await tapRect(page, 1); await tapAt(page, YES);
    const t2 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'battle' ? t : null; });
    ok(!!t2 && t2.current.held.length === 1 && t2.current.held[0].id === offer.balls[1].id && t2.current.floor === 2, tag + 'YES takes that ball: the run now holds it and waits for floor 2', J(t2 && t2.current.held));
    ok((await until(async () => (await where(page)) === 'tower')) === true && (await labelsOf(page))[0] === 'FIGHT: FLOOR 2', tag + 'the hub is back on the Tower screen: FIGHT: FLOOR 2', J(await labelsOf(page)));
    ok((await page.eval(`${HUB}.model.view().tower.panel.lines[3]`)) === 'BUFFS 1', tag + 'the panel says BUFFS 1');
    await tapRow(page, 'buffs');
    const bv = (await hview(page)).tower;
    ok(bv.total === 1 && bv.rows[0].name === offer.balls[1].name, tag + 'MY BUFFS lists the buff that was taken', J(bv.rows.map((r) => r.name)));
    await shot(page, 'phone_6_buffs');
    await tapSel(page, '#bB'); await sleep(250);

    // ---- floor 2 carries the buff
    await tapRect(page, 0);
    ok((await toBattle(page)) === 'ready', tag + 'floor 2 opens');
    bar = await barOf(page);
    ok(/FLOOR 2/.test(bar.text) && /BUFFS? 1|1 BUFF/i.test(bar.text), tag + 'the bar names floor 2 and the buff held', J(bar));
    const sp2 = await ev(page, `${B}.tower.spec.tower`);
    const tag2 = await ev(page, `${B}.tower.tag`);
    ok(sp2.floor === 2 && sp2.buffs === 1 && /^tower:4242:2:0:[0-9a-f]+$/.test(tag2) && tag2.split(':')[4] !== tag1.split(':')[4], tag + 'the buff is in the floor\'s spec (the only place a buff reaches a battle); the resume tag now names what is held', J([tag1, tag2]));
    await finish(page);
    ok((await ev(page, `${B}.ctl.winner`)) === 0, tag + 'floor 2 is won', String(await ev(page, `${B}.ctl.winner`)));
    await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'offer' && t.current.floor === 3; });
    await tapSel(page, '#bA');
    await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 });
    await hubReady(page);
    ok((await where(page)) === 'tower-offer', tag + 'the second offer opens');
    // SKIP by touch: the SKIP chip, then YES
    const rr = await hubRects(page);
    await tapRect(page, rr.length - 1);
    v = (await hview(page)).tower;
    ok(v.confirm && v.confirm.kind === 'skip', tag + 'a tap on SKIP asks "take nothing?"', J(v.confirm));
    await tapAt(page, YES);
    const t3 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'battle' && t.current.floor === 3 ? t : null; });
    ok(!!t3 && t3.current.held.length === 1, tag + 'skipping takes nothing: still one buff, floor 3 is next', J(t3 && t3.current.held.length));

    // ---- floor 3, THE RETRIES (2026-11-17: a loss no longer ends the climb at once; every floor has three retries)
    const toHubP = async () => { await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 }); await hubReady(page); };
    const begin = async () => { const m = await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1")); await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; }); return m; };
    const panelOf = () => page.eval(`${HUB}.model.view().tower.panel.lines`);
    await until(async () => (await where(page)) === 'tower');
    await tapRect(page, 0);
    ok((await toBattle(page)) === 'ready', tag + 'floor 3 opens');
    bar = await barOf(page);
    ok(/FLOOR 3/.test(bar.text) && /RETRIES 3\/3$/.test(bar.text), tag + 'the Tower bar shows the retries left on this floor: RETRIES 3/3', J(bar));
    const askPre = await ev(page, ASK('quit')); await ev(page, ANSWER(false));
    ok(askPre.kind === 'quit' && askPre.text === 'Leave? Costs nothing.', tag + 'before the first choice LEAVE TOWER asks "Leave? Costs nothing."', J(askPre));
    ok((await begin()) === 'action', tag + 'floor 3 is played by hand to turn 1');
    ok(!!(await tw(page, pid)).current.fighting, tag + 'the profile now says the fight has BEGUN (leaving it from here on is a lost try)');
    const askQ = await ev(page, ASK('quit')); await ev(page, ANSWER(false));
    const askF = await ev(page, ASK('forfeit'));
    ok(askQ.kind === 'quit' && askQ.text === 'Leave? It costs 1 of the 3 retries left on this floor.' && askF.kind === 'forfeit' && askF.text === 'Give up? It costs 1 of the 3 retries left on this floor.', tag + 'after it LEAVE TOWER and FORFEIT both say what leaving costs NOW: 1 of the 3 retries left on this floor', J([askQ, askF]));
    await shot(page, 'phone_7a_forfeit_ask');
    await ev(page, ANSWER(true));                                                 // FORFEIT, YES: the floor is LOST
    await finish(page);
    ok((await ev(page, `${B}.ctl.winner`)) === 1, tag + 'floor 3 is lost (a forfeit)', String(await ev(page, `${B}.ctl.winner`)));
    const oL = await resultOpts(page);
    ok(J(oL) === J(['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB']), tag + 'after a loss with a retry left the result screen offers RETRY FLOOR first, then BACK TO TOWER, then BACK TO HUB', J(oL));
    const tL1 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.history.length === 3 && !t.current.fighting ? t : null; });
    ok(!!tL1 && tL1.current.phase === 'battle' && tL1.current.floor === 3 && tL1.current.history[2].result === 'l' && tL1.current.history[2].retry === true && tL1.current.held.length === 1 && tL1.runs === 0 && tL1.last === null, tag + 'A LOSS NO LONGER ENDS THE CLIMB: the run is still on floor 3 with its buff, and the lost try is counted as ONE retry (nothing folded, no last run)', J(tL1 && tL1.current.history.map((h) => h.result + (h.retry ? '*' : ''))));
    await shot(page, 'phone_7b_lost_result');
    // a RELOAD at the result screen: the retry is not counted again; the page opens the next try of the floor
    const revL = (await ev(page, READ(pid))).rev;
    await ev(page, `window.__marker = 1; true`); await page.send('Page.reload', {});
    await page.waitFor(`window.__marker === undefined && ${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    const afterReload = await ev(page, READ(pid));
    ok((await ev(page, `${B}.state`)) === 'ready' && (await ev(page, `${B}.tower.status`)) === 'ok' && (await ev(page, `${B}.tower.spec.tower.tries`)) === 1 && afterReload.rev === revL && J(afterReload.tower) === J(tL1), tag + 'A RELOAD AT THE RESULT DOES NOT COUNT IT AGAIN: the profile is untouched (the same revision), and the page opens the next try of floor 3 (try 1)', J({ st: await ev(page, `${B}.state`), rev: [revL, afterReload.rev] }));
    bar = await barOf(page);
    ok(/RETRIES 2\/3$/.test(bar.text), tag + 'whose bar says RETRIES 2/3', J(bar));
    // LEAVE TOWER before any choice of that try is free; the hub shows the climb where it stands
    await ev(page, LEAVE); await toHubP();
    const tL2 = await tw(page, pid);
    ok(J(tL2) === J(tL1) && (await where(page)) === 'tower', tag + 'LEAVE TOWER before the first choice of the new try cost nothing: the profile is as it was, and the hub opens on the Tower screen', await where(page));
    const homeR = await labelsOf(page), panelR = await panelOf(), msgR = await page.eval(`${HUB}.model.view().msg`);
    ok(homeR[0] === 'RETRY FLOOR 3' && homeR.includes('MY BUFFS') && homeR.includes('NEW RUN'), tag + 'THE HUB SHOWS RETRY FLOOR 3 (instead of FIGHT) as its first row', J(homeR));
    ok(panelR[1] === 'FLOOR 3/30' && panelR[4] === 'RETRIES LEFT 2/3' && panelR[5] === 'RETRIES USED 1', tag + 'the status panel shows the floor, RETRIES LEFT 2/3 and RETRIES USED 1', J(panelR));
    ok(J(msgR) === J(['The climb is saved on floor 3.', '2 of 3 retries left here, 1 used.']), tag + 'and the message says the climb is saved, how many retries this floor has left and how many the climb has used', J(msgR));
    await shot(page, 'phone_7c_retry_home');
    // RETRY FLOOR: a new try of the same floor, at its own address
    await tapRect(page, 0);
    ok((await toBattle(page)) === 'ready', tag + 'RETRY FLOOR opens floor 3 again');
    const sR = await ev(page, 'location.search'), tagR = await ev(page, `${B}.tower.tag`);
    ok(sR.includes('floor=3') && /[?&]try=1(&|$)/.test(sR) && /^tower:4242:3:1:[0-9a-f]+$/.test(tagR) && tagR !== tag2, tag + 'the address names the try (try=1), and so does the saved battle\'s tag', sR + ' ' + tagR);
    // leaving MID-FIGHT costs one retry, and the run goes on
    ok((await begin()) === 'action', tag + 'the retry is begun');
    await ev(page, LEAVE); await toHubP();
    const tL3 = await tw(page, pid);
    ok(!!tL3.current && tL3.current.floor === 3 && tL3.current.history.length === 4 && tL3.current.history[3].retry === true && tL3.current.fighting === false && tL3.runs === 0 && tL3.last === null && (await where(page)) === 'tower', tag + 'LEAVING MID-FIGHT COSTS ONE RETRY AND THE RUN GOES ON: two retries counted, still floor 3, nothing folded; the hub opens on the Tower screen (not on a last run)', J({ h: tL3.current && tL3.current.history.length, path: await where(page) }));
    const panel3 = await panelOf();
    ok((await labelsOf(page))[0] === 'RETRY FLOOR 3' && panel3[4] === 'RETRIES LEFT 1/3' && panel3[5] === 'RETRIES USED 2', tag + 'the hub shows RETRY FLOOR 3 with RETRIES LEFT 1/3, RETRIES USED 2', J(panel3));
    // the third retry: lost, and RETRY FLOOR on the result screen goes straight to the last try
    await tapRect(page, 0);
    ok((await toBattle(page)) === 'ready' && (await begin()) === 'action', tag + 'the second retry opens and is begun');
    await ev(page, ASK('forfeit')); await ev(page, ANSWER(true)); await finish(page);
    const tL4 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.history.length === 5 && !t.current.fighting ? t : null; });
    ok(!!tL4 && tL4.current.history.slice(2).every((h) => h.result === 'l' && h.retry === true) && tL4.current.floor === 3, tag + 'it is lost: the third retry of floor 3 is counted (3 used)', J(tL4 && tL4.current.history.length));
    await tapSel(page, '#bA');                                                    // RETRY FLOOR (the first option)
    await page.waitFor(`/[?&]try=3(&|$)/.test(location.search) && window.__arenaBattle && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    bar = await barOf(page);
    ok((await ev(page, `${B}.state`)) === 'ready' && /RETRIES 0\/3$/.test(bar.text) && (await ev(page, `${B}.tower.spec.tower.tries`)) === 3, tag + 'RETRY FLOOR on the result screen opens the floor again at once (try=3); its bar says RETRIES 0/3: the last try', J(bar));
    ok((await begin()) === 'action', tag + 'the last try is begun');
    const askEnd = await ev(page, ASK('quit')); await ev(page, ANSWER(false));
    ok(askEnd.text === 'Leave? No retry is left on this floor: the climb ends here.', tag + 'LEAVE TOWER now says that leaving ends the climb', J(askEnd));
    await ev(page, ASK('forfeit')); await ev(page, ANSWER(true)); await finish(page);
    const oEnd = await resultOpts(page);
    ok(J(oEnd) === J(['TO THE TOWER', 'BACK TO HUB']), tag + 'the loss after the third retry: the result screen is the one a lost run always had', J(oEnd));
    const t4 = await until(async () => { const t = await tw(page, pid); return t.current === null ? t : null; });
    ok(!!t4 && t4.last && t4.last.cleared === 2 && t4.last.retries === 3 && t4.runs === 1 && t4.retries === 3, tag + 'THE LOSS AFTER THE THIRD RETRY OF A FLOOR ENDED THE RUN: no current run, a last run that cleared 2 floors with 3 retries, one run counted', J(t4 && { cur: t4.current, last: t4.last, runs: t4.runs }));
    ok(t4.best['3v3'] === 2 && t4.floors === 2, tag + 'the best floor for 3v3 is 2', J(t4.best));
    await shot(page, 'phone_7d_end_result');
    await tapSel(page, '#bA');                                                    // TO THE TOWER
    await toHubP();
    ok((await where(page)) === 'tower-last', tag + 'the hub opens on the LAST RUN screen (#tower-last)', await where(page));
    const lv = (await hview(page)).tower;
    ok(lv.state === 'ready' && lv.last.cleared === 2 && lv.last.format === '3v3' && lv.last.retries === 3, tag + 'it shows how far the climb got, and its 3 retries', J(lv.last && [lv.last.cleared, lv.last.format, lv.last.retries]));
    await shot(page, 'phone_7_last');
    await tapSel(page, '#bB'); await sleep(250);
    const hl = await labelsOf(page);
    ok(hl[0] === 'NEW RUN' && hl.includes('LAST RUN'), tag + 'the Tower screen now offers NEW RUN (and LAST RUN)', J(hl));
    ok((await page.eval(`${HUB}.model.view().tower.panel.lines[2]`)) === 'BEST 3v3 2', tag + 'the panel shows BEST 3v3 2');
    ok((await page.eval(`${HUB}.model.view().tower.panel.lines[5]`)) === 'RETRIES 3', tag + 'and the retries of the finished climb: RETRIES 3');
    await tapRow(page, 'ach');
    const av = (await hview(page)).tower;
    const earnedIds = Object.keys(t4.achievements);
    ok((await where(page)) === 'tower-ach' && av.total === 51 && av.earned === earnedIds.length && earnedIds.length >= 1, tag + 'ACHIEVEMENTS lists all 51, and the ones the climb earned are marked (' + earnedIds.length + ')', J({ total: av.total, earned: av.earned }));
    await shot(page, 'phone_8_ach');
    await tapSel(page, '#bB'); await sleep(250);

    // ---- nothing the Tower did touched the career; and the plain Quick Battle is the same battle as before
    ok((await statsJ(page, pid)) === s0, tag + 'the career record is BYTE-IDENTICAL to before the climb (no Tower floor was a career battle)');
    const q1 = await playQuick(page);
    ok(q1.state === 'ready' && q1.tower === null && q1.bar === true, tag + 'a plain Quick Battle in the same browser, with buffs just taken, still has no Tower on it', J(q1));
    ok(q1.hash === q0.hash && q1.turns === q0.turns && q1.winner === q0.winner, tag + 'and it plays EXACTLY the battle it played before the climb (same final state hash ' + q0.hash + ', same turns)', J([q0.hash, q1.hash, q0.turns, q1.turns]));
    const after = await ev(page, READ(pid));
    ok(nBattles(after.stats) === 2 && J(after.tower.last) === J(t4.last) && after.tower.runs === 1, tag + 'the Quick Battle counted for the career (two now) and changed nothing in the Tower');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ desktop */
  await session('desktop: keyboard + controller', { width: 1280, height: 800, pad: true, port: cdp++ }, async (page) => {
    const tag = 'desktop: ';
    await openHub(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    const seeded = await ev(page, SEED_TEAM('MISTY', TEAM)); const pid = seeded.id;
    const started = await ev(page, START_RUN(pid, seeded.team, SEED_B, '3v3'));
    ok(started.applied, tag + 'a run starts', J(started));
    await openHub(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    ok((await where(page)) === 'tower', tag + 'down, down, Enter opens the Tower screen');
    await shot(page, 'desk_1_home');
    await key(page, 'a');
    ok((await toBattle(page)) === 'ready', tag + 'Enter on FIGHT opens floor 1');

    // ---- a reload in the middle of the fight resumes it; the floor counts ONCE
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'floor 1 is played by hand to turn 1');
    ok(!!(await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; })), tag + 'the profile says the fight has begun');
    await sleep(250);
    const hist0 = await ev(page, `${B}.ctl.battle.hash()`);
    await ev(page, `window.__marker = 1; true`); await page.send('Page.reload', {});
    await page.waitFor(`window.__marker === undefined && ${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    ok((await ev(page, `${B}.state`)) === 'ready' && (await ev(page, `${B}.resume.restored`)) === true, tag + 'the reload RESUMED the floor (not a new fight, not a refusal)', J(await ev(page, `${B}.resume`)));
    ok((await ev(page, `${B}.ctl.battle.hash()`)) === hist0 && (await ev(page, `${B}.tower.status`)) === 'resume', tag + 'at the very state it was left in (same battle hash)');
    await finish(page);
    ok((await ev(page, `${B}.ctl.winner`)) === 0, tag + 'the resumed floor is won (the calibrated seed: if this fails the seed or the engine changed)', J(await ev(page, `({ w: ${B}.ctl.winner, turns: ${B}.ctl.turn })`)));
    const t1 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'offer' ? t : null; });
    ok(!!t1 && t1.current.floor === 2 && t1.floors === 0 && t1.current.history.length === 1, tag + 'it was counted ONCE: one floor in the run\'s history, floor 2 is next', J(t1 && [t1.current.floor, t1.current.history.length]));
    await shot(page, 'desk_2_result');
    await key(page, 'a');                                                         // PICK A BUFF
    await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 });
    await hubReady(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    ok((await where(page)) === 'tower-offer', tag + 'the offer opens');
    // by CONTROLLER: right (ball 2), A -> prompt (NO chosen), left -> YES, A
    await padPress(page, 15); await padPress(page, 0);
    let v = (await hview(page)).tower;
    ok(v.cursor === 1 && v.confirm && v.confirm.cursor === 1, tag + 'D-pad right then A asks, with NO chosen', J(v.confirm));
    await shot(page, 'desk_3_offer_pad');
    await padPress(page, 1);
    ok(!(await hview(page)).tower.confirm, tag + 'B on the pad answers NO');
    const ballId = (await hview(page)).tower.balls[1].id;
    await padPress(page, 0); await padPress(page, 14); await padPress(page, 0);
    const t2 = await until(async () => { const t = await tw(page, pid); return t.current && t.current.phase === 'battle' ? t : null; });
    ok(!!t2 && t2.current.held.length === 1 && t2.current.held[0].id === ballId, tag + 'D-pad left (YES) then A takes the ball', J(t2 && t2.current.held.map((h) => h.id)));

    // ---- a fight LEFT by a typed address is a loss (the browser's reload is not)
    await until(async () => (await where(page)) === 'tower');
    await key(page, 'a');
    ok((await toBattle(page)) === 'ready', tag + 'floor 2 opens');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'floor 2 is begun');
    await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; });
    const url2 = await ev(page, 'location.href');
    await page.navigate(url2);                                                    // the same address typed again: a NEW visit to a fight already begun
    await page.waitFor(`${B} && ${B}.state === 'error'`, { timeoutMs: 60000 });
    const refused = await ev(page, `${B}.towerRefused`);
    ok(refused && refused.status === 'abandoned', tag + 'a typed address for a fight that was begun is refused as "abandoned"', J(refused));
    const body2 = await ev(page, `document.body.innerText`);
    ok(/loss/i.test(body2) && /cost one retry/.test(body2) && /2 of 3 retries are left on this floor/.test(body2) && /saved/.test(body2), tag + 'and the page says it counted as a loss that cost one retry, how many are left, and that the climb is saved', body2.slice(0, 200));
    const t3 = await tw(page, pid);
    ok(!!t3.current && t3.current.floor === 2 && t3.current.phase === 'battle' && t3.current.fighting === false && t3.current.history.length === 2 && t3.current.history[1].retry === true && t3.runs === 0 && t3.last === null, tag + 'THE RUN GOES ON (a left fight costs one retry of the floor): still floor 2, one retry counted, nothing folded', J({ cur: t3.current && t3.current.floor, h: t3.current && t3.current.history.length, runs: t3.runs }));
    await shot(page, 'desk_4_refused');

    // ---- hostile addresses: refused, and nothing is written
    const before = J(await tw(page, pid));
    const bad = ['?tower=1', '?tower=1&floor=0&run=5', '?tower=1&floor=31&run=5', '?tower=1&floor=abc&run=5', '?tower=2&floor=1&run=5', '?tower=1&floor=1&run=-1', '?tower=1&floor=1&run=99999999999', '?tower=1&floor=1&run=5&life=x', '?tower=1&floor=1&run=5&try=x', '?tower=1&floor=1&run=5&try=-1',
      '?tower=1&floor=1&run=5&p=../../x', '?tower=1&floor=1&run=5&team=ARENA1.AAAA', '?tower=1&floor=1&run=5&seed=1', '?tower=1&floor=1&run=5&np=host', '?tower=1&floor=1&run=5&p=' + 'x'.repeat(80)];
    const results = [];
    for (const q of bad) { const st = await openBattle(page, q); results.push([q, st, await ev(page, `${B}.tower === undefined || ${B}.tower === null`)]); }
    ok(results.every(([, st, none]) => st === 'error' && none), tag + 'all ' + bad.length + ' hostile Tower addresses are refused on an error screen, with no Tower controller', J(results.filter(([, st, none]) => st !== 'error' || !none)));
    ok(J(await tw(page, pid)) === before, tag + 'and none of them wrote anything to the profile');
    // `floor` / `run` / `life` / `p` WITHOUT tower=1 are not Tower parameters: the address is a regular one and they are ignored, as before the Tower existed
    const stray = [];
    for (const q of ['?floor=1&run=5&seed=11&format=3v3&cpu=easy', '?p=1&seed=11&format=3v3&cpu=easy', '?life=2&run=7&seed=11&format=3v3&cpu=easy', '?try=2&seed=11&format=3v3&cpu=easy']) { const st = await openBattle(page, q); stray.push([q, st, await ev(page, `${B}.tower === undefined || ${B}.tower === null`)]); }
    ok(stray.every(([, st, none]) => st === 'ready' && none), tag + 'an address with floor / run / life / p but no tower=1 is a regular battle that ignores them (as the build before the Tower did)', J(stray));
    ok(J(await tw(page, pid)) === before, tag + 'and wrote nothing to the profile');
    const ghost = await openBattle(page, '?tower=1&floor=1&run=123456');
    ok(ghost === 'error' && J(await tw(page, pid)) === before, tag + 'a well-formed address for a run that does not exist is refused too, and writes nothing', ghost);

    // ---- NEW RUN from the hub: a random team, floor 1 opens by itself
    await openHub(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    const h2 = await labelsOf(page);
    ok(h2[0] === 'RETRY FLOOR 2' && h2[2] === 'NEW RUN', tag + 'with the run still under way the Tower screen offers RETRY FLOOR 2 first (and NEW RUN as its third row)', J(h2));
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(250);          // NEW RUN over a run: it asks first
    ok(!!(await hview(page)).tower.confirm && /Give up/.test((await hview(page)).msg[0]), tag + 'NEW RUN over a run asks "Give up this climb?"', J((await hview(page)).msg));
    await key(page, 'left'); await key(page, 'a'); await sleep(400);                                  // YES
    const tGave = await until(async () => { const t = await tw(page, pid); return t.current === null ? t : null; });
    ok(!!tGave && tGave.runs === 1 && tGave.last && tGave.last.won === false && tGave.last.cleared === 1 && tGave.last.retries === 1 && tGave.retries === 1, tag + 'YES gives the run up: it is counted where it stood (1 floor cleared, 1 retry)', J(tGave && { runs: tGave.runs, last: tGave.last }));
    ok((await where(page)) === 'tower-new' && J(await labelsOf(page)) === J(['TEAM', 'FORMAT', 'START', 'BACK']), tag + 'NEW RUN opens the team screen: TEAM / FORMAT / START / BACK');
    const tv = (await hview(page)).menu.rows;
    ok(tv[0].value === 'RANDOM TEAM' && tv[0].count === 2, tag + 'the choices are a random team and the saved team of six', J(tv[0]));
    await shot(page, 'desk_5_new');
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a');
    ok((await toBattle(page)) === 'ready', tag + 'START opens floor 1 of a new run');
    const t4 = await tw(page, pid);
    const bar2 = await barOf(page);
    ok(t4.current && t4.current.floor === 1 && t4.current.team && t4.current.format === '3v3' && /FLOOR 1/.test(bar2.text), tag + 'a new run exists at floor 1 (random team, 3v3) and the bar says so', J(bar2));
    ok((await ev(page, `location.search`)).includes('run=' + t4.current.seed), tag + 'its address carries the new run\'s seed');
    await ev(page, LEAVE);
    await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 });
    await hubReady(page);
    const t5 = await tw(page, pid);
    ok(!!t5.current && t5.current.seed === t4.current.seed && t5.current.floor === 1 && t5.current.history.length === 0 && t5.current.fighting === false && t5.runs === 1 && J(t5.last) === J(tGave.last) && (await where(page)) === 'tower' && (await labelsOf(page))[0] === 'FIGHT: FLOOR 1', tag + 'leaving at once (no choice made) COSTS NOTHING: the new run still waits on floor 1 (it used to be dropped), nothing is counted, and the hub offers FIGHT: FLOOR 1', J({ cur: t5.current && t5.current.floor, runs: t5.runs }));
    ok(errsOf(page).filter((e) => !/status of (4\d\d)|Failed to load resource/.test(e)).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ history */
  // THE BROWSER'S BACK AND FORWARD IN THE MIDDLE OF A RETRY (the review of 2026-11-17 found that Back out of a retry cost a retry at once, and ended the climb on the last try: the page before a retry in the
  // tab's history was the LOST try's battle page, which took the fight under way for its own, found nothing saved under its own address and counted the fight as left). Three ways a retry is reached, and at each
  // one the fight is left by the browser's Back and come back to by Forward: NOTHING may be counted, and the fight must go on where it was.
  await session('history: Back and Forward in the middle of a retry', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'history: ';
    await openHub(page);
    const seeded = await ev(page, SEED_TEAM('BROCK', TEAM)); const pid = seeded.id;
    ok((await ev(page, START_RUN(pid, seeded.team, SEED_B, '3v3'))).applied, tag + 'a run starts');
    const rows = (t) => (t && t.current ? t.current.history.map((h) => h.result + (h.retry ? '*' : h.life ? '+' : '')).join('') : null);
    const begin = async () => { const m = await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1")); await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; }); await sleep(300); return m; };
    const lose = async (n) => { await ev(page, ASK('forfeit')); await ev(page, ANSWER(true)); await finish(page); return until(async () => { const t = await tw(page, pid); return t.current && t.current.history.length === n && !t.current.fighting ? t : null; }); };
    const info = () => ev(page, `(() => { const a = ${B}; return a ? { state: a.state, status: a.tower ? a.tower.status : null, tries: a.tower && a.tower.spec ? a.tower.spec.tower.tries : null, restored: a.resume ? a.resume.restored : null, refused: a.towerRefused || null, search: location.search, nav: (performance.getEntriesByType('navigation')[0] || {}).type, hash: a.ctl ? a.ctl.battle.hash() : null } : null; })()`);
    const stored = async () => { const r = await ev(page, READ(pid)); return J([r.rev, r.tower]); };
    const onHub = `location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`;
    const onBattle = `location.pathname.endsWith('battle.html') && window.__arenaBattle && (${B}.state === 'ready' || ${B}.state === 'error')`;
    const tryOf = (search) => { const m = /[?&]try=(\d+)(&|$)/.exec(search || ''); return m ? Number(m[1]) : 0; };
    // ONE STEP through the tab's history (n = -1: the browser's Back, 1: Forward). -> where it landed: { hub | battle, try (of a battle page's address), fresh (the page was LOADED AGAIN: a new document) }.
    // A battle page is always loaded again here (the dev server's no-store headers keep the back / forward cache out of this rig); the hub's own screens are entries of one document.
    const go = async (n) => {
      const before = await ev(page, `(window.__stale = 1, location.href)`);
      await ev(page, `history.go(${n}); true`);
      await page.waitFor(`window.__stale === undefined || location.href !== ${J(before)}`, { timeoutMs: 30000 });
      await page.waitFor(`(${onHub}) || (${onBattle})`, { timeoutMs: 90000 });
      await sleep(400);
      const at = await ev(page, `({ path: location.pathname, search: location.search, fresh: window.__stale === undefined })`);
      const hub = at.path.endsWith('/pokemonarena/');
      if (hub) await hubReady(page);
      return { hub, battle: !hub, try: hub ? null : tryOf(at.search), fresh: at.fresh, search: at.search };
    };
    // Back (or Forward) until a battle page is reached: the hub's screens in between are stepped over (the hub seeds a screen opened by address with the entries it would have been walked through)
    const toBattlePage = async (n) => { for (let i = 1; i <= 5; i++) { const at = await go(n); if (at.battle) return { ...at, steps: i }; } return { battle: false, steps: -1, try: null }; };
    const result = (label) => ev(page, `(() => { const a = ${B}, i = a.view().result.options.indexOf(${J(label)}); if (i < 0) return 'no ' + ${J(label)}; a.scene.choose.result(i); return 'ok'; })()`);
    const hubMsg = async (at) => (at.hub ? page.eval(`${HUB}.model.view().msg`) : null);
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    await key(page, 'a');
    ok((await toBattle(page)) === 'ready' && (await begin()) === 'action', tag + 'FIGHT opens floor 1 and it is begun');

    // ---- 1. THE RETRY IS OPENED FROM THE HUB: the lost try's battle page stays in the tab's history, behind the hub
    const l1 = await lose(1);
    ok(rows(l1) === 'l*', tag + 'the first try is lost: one retry counted', rows(l1));
    ok((await result('BACK TO TOWER')) === 'ok', tag + 'BACK TO TOWER is on the result screen');
    await page.waitFor(onHub, { timeoutMs: 60000 }); await hubReady(page);
    ok((await labelsOf(page))[0] === 'RETRY FLOOR 1', tag + 'the hub offers RETRY FLOOR 1', J(await labelsOf(page)));
    await key(page, 'a');
    await page.waitFor(`${onBattle} && /[?&]try=1(&|$)/.test(location.search)`, { timeoutMs: 90000 });
    ok((await begin()) === 'action', tag + 'the retry (try 1) opens from the hub and is begun');
    const a1 = await info(), s1 = await stored();
    const back1 = await toBattlePage(-1);                                         // BACK, past the hub, onto the battle page of the LOST try
    const b1 = await info(), s1b = await stored(), body1 = await ev(page, 'document.body.innerText');
    ok(back1.battle && back1.try === 0 && back1.fresh && b1.nav === 'back_forward' && b1.state === 'error' && !!b1.refused && b1.refused.status === 'elsewhere', tag + 'the browser\'s BACK, past the hub, lands on the LOST try\'s battle page, which says it is an earlier try: it neither takes the fight under way for its own nor counts it as left', J([back1, b1]));
    ok(s1b === s1 && /Nothing was counted/.test(body1), tag + 'NOTHING WAS COUNTED by that Back (the profile is the same revision, value for value, and the fight is still marked), and the page says so', body1.replace(/\s+/g, ' ').slice(0, 200));
    const fwd1 = await toBattlePage(1);                                           // FORWARD, past the hub: the page of the fight
    const c1 = await info();
    ok(fwd1.battle && fwd1.try === 1 && c1.state === 'ready' && c1.status === 'resume' && c1.restored === true && c1.hash === a1.hash && (await stored()) === s1, tag + 'FORWARD is the fight again, RESUMED at the very state it was left in (same battle hash), with nothing written', J([fwd1, c1]));

    // ---- 2. THE RETRY IS OPENED BY "RETRY FLOOR" ON THE RESULT SCREEN: it takes the lost try's place in the history, so Back from it is the hub (as from a first try)
    const l2 = c1.state === 'ready' ? await lose(2) : null;
    ok(rows(l2) === 'l*l*', tag + 'that try is lost too: two retries counted', String(rows(l2)));
    const len2 = await ev(page, 'history.length');
    ok((await result('RETRY FLOOR')) === 'ok', tag + 'RETRY FLOOR is on the result screen');
    await page.waitFor(`${onBattle} && /[?&]try=2(&|$)/.test(location.search)`, { timeoutMs: 90000 });
    ok((await ev(page, 'history.length')) === len2, tag + 'RETRY FLOOR REPLACES the lost try\'s page in the tab\'s history (its length stays ' + len2 + '): the page before a retry is never the battle that was just lost', String(await ev(page, 'history.length')));
    ok((await begin()) === 'action', tag + 'try 2 is begun');
    const a2 = await info(), s2 = await stored();
    const back2 = await go(-1);                                                   // BACK: the hub
    const msg2 = await hubMsg(back2);
    ok(back2.hub && (await where(page)) === 'tower' && J(msg2) === J(['You left a fight unfinished.', 'That costs 1 of the 1 retry left.']) && (await stored()) === s2, tag + 'BACK in the middle of that retry is the hub\'s Tower screen, which says what leaving the fight would cost; nothing is counted', J([back2, msg2]));
    const fwd2 = await go(1);                                                     // FORWARD: the fight
    const c2 = await info();
    ok(fwd2.battle && fwd2.try === 2 && c2.state === 'ready' && c2.status === 'resume' && c2.restored === true && c2.hash === a2.hash && (await stored()) === s2, tag + 'FORWARD resumes the retry where it was (same battle hash), with nothing written', J([fwd2, c2]));

    // ---- 3. THE LAST TRY, and TWO PAGES OF ONE TRY. A page reached again with no fight marked opens the try the run is on and puts that try into its own address; so the tab's history can hold two pages
    //         of the last try whose addresses are spelled differently. The fight is begun on one; Back in the middle of it must not end the climb, wherever it lands.
    const l3 = c2.state === 'ready' ? await lose(3) : null;
    ok(rows(l3) === 'l*l*l*', tag + 'the third try is lost: the floor\'s three retries are counted', String(rows(l3)));
    const s3r = await stored();
    const old3 = await toBattlePage(-1);                                          // BACK past the hub, with NO fight marked: the first try's page (its address names no try)
    const r3a = await info();
    ok(old3.battle && r3a.state === 'ready' && r3a.status === 'ok' && r3a.tries === 3 && /[?&]try=3(&|$)/.test(r3a.search) && (await stored()) === s3r, tag + 'with no fight marked, the first try\'s page reached by Back opens the try the run is on (the LAST try), writes nothing, and PUTS THAT TRY INTO ITS OWN ADDRESS (try=3)', J([old3, r3a]));
    const new3 = await toBattlePage(1);                                           // FORWARD past the hub: the page of the try that was just lost
    const r3 = await info(), bar3 = await barOf(page);
    ok(new3.battle && r3.state === 'ready' && r3.status === 'ok' && r3.tries === 3 && /[?&]try=3(&|$)/.test(r3.search) && r3.search !== r3a.search && !!bar3 && /RETRIES 0\/3$/.test(bar3.text) && (await stored()) === s3r, tag + 'and so does the page of the try that was just lost, reached by Forward (RETRIES 0/3): two pages of the last try, their addresses spelled differently, nothing written', J([r3a.search, r3.search]));
    ok((await begin()) === 'action', tag + 'the last try is begun on that page');
    const a3 = await info(), s3 = await stored();
    await ev(page, `window.__stale = 1; true`); await page.send('Page.reload', {});
    await page.waitFor(`window.__stale === undefined && ${onBattle}`, { timeoutMs: 90000 });
    const r3b = await info();
    ok(r3b.state === 'ready' && r3b.status === 'resume' && r3b.restored === true && r3b.hash === a3.hash && (await stored()) === s3, tag + 'a reload in the middle of it resumes it (the page knows itself for a page of the fight\'s try by the address it gave itself)', J(r3b));
    const back3 = await go(-1);                                                   // BACK: the hub
    const msg3 = await hubMsg(back3), t3h = await tw(page, pid);
    ok(back3.hub && J(msg3) === J(['You left a fight unfinished.', 'No retry is left: the climb ends.']) && !!t3h.current && t3h.runs === 0 && t3h.last === null && (await stored()) === s3, tag + 'BACK IN THE MIDDLE OF THE LAST TRY DOES NOT END THE CLIMB: the hub says what leaving would cost, and the run is still under way', J({ back3, msg3, cur: !!t3h.current, runs: t3h.runs }));
    const back3b = await toBattlePage(-1);                                        // BACK again, past the hub: the OTHER page of the last try
    const b3 = await info(), t3b = await tw(page, pid);
    ok(back3b.battle && b3.search === r3a.search && b3.state === 'ready' && b3.status === 'resume' && b3.restored === true && b3.hash === a3.hash && !!t3b.current && t3b.current.fighting === true && t3b.runs === 0 && (await stored()) === s3, tag + 'and BACK again, onto the OTHER page of the last try (another spelling of the address), RESUMES THE FIGHT there at the same battle state: the saved battle belongs to the fight, not to an address (kept under the address, this page found nothing and ENDED THE CLIMB: "No retry was left, so the run is over")', J([back3b, b3]));
    const fwd3 = await toBattlePage(1);                                           // FORWARD, past the hub: the page the fight was begun on
    const c3 = await info(), t3c = await tw(page, pid);
    ok(fwd3.battle && c3.search === r3.search && c3.state === 'ready' && c3.status === 'resume' && c3.restored === true && c3.hash === a3.hash && rows(t3c) === 'l*l*l*' && t3c.runs === 0 && (await stored()) === s3, tag + 'FORWARD resumes the last try on the page it was begun on; the climb still has its three retries, counted once each', J([fwd3, c3]));
    ok(errsOf(page).filter((e) => !/status of (4\d\d)|Failed to load resource/.test(e)).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ integrity */
  await session('integrity: one START, the engine end, the history, the note, no challenge', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'integrity: ';
    const PROFILES = `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); try { const ps = await store.listProfiles(); const out = []; for (const p of ps) { const l = await store.loadProfile(p.id); out.push({ id: p.id, tower: l.profile.tower }); } return out; } finally { await store.close(); } })()`;
    const toHubFromBattle = async () => { await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 }); await hubReady(page); };
    const pressB = async () => { await ev(page, `${HUB}.press('b')`); await sleep(300); };
    await openHub(page);
    // ---- NO PROFILE YET: START pressed twice in the same moment makes ONE profile and ONE run (not two profiles, not a run made and at once given up)
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    ok((await where(page)) === 'tower', tag + 'with no profile the Tower screen opens');
    await key(page, 'a'); await sleep(250);
    ok((await where(page)) === 'tower-new', tag + 'NEW RUN opens the team screen');
    await key(page, 'down'); await key(page, 'down');
    await ev(page, `(() => { ${HUB}.press('a'); ${HUB}.press('a'); return true; })()`);                 // a double tap on START
    ok((await toBattle(page)) === 'ready', tag + 'START opens floor 1');
    const ps1 = await ev(page, PROFILES);
    ok(ps1.length === 1 && ps1[0].tower.current && ps1[0].tower.current.floor === 1 && ps1[0].tower.runs === 0 && ps1[0].tower.last === null, tag + 'a double START made exactly ONE profile and ONE run (no run was made and abandoned, none is counted)', J(ps1.map((p) => [p.id, p.tower.runs, !!p.tower.current])));
    ok((await ev(page, `window.__arenaPresence === undefined && ${B}.presence === undefined && document.getElementById('openBtn').hidden === true`)) === true, tag + 'OPEN TO BATTLES is not mounted in a Tower fight (no challenge dialog can take the player away mid-fight; the header button stays hidden)');
    // ---- THE ENGINE END: the Tower hears the match the moment the engine ends it, before the result screen is up
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'floor 1 is played by hand to turn 1');
    const pid1 = ps1[0].id;
    ok(!!(await until(async () => { const t = await tw(page, pid1); return t.current && t.current.fighting; })), tag + 'the profile says the fight has begun, and carries this page\'s attempt number', J((await tw(page, pid1)).current && (await tw(page, pid1)).current.attempt));
    const att = (await tw(page, pid1)).current.attempt;
    ok(Number.isInteger(att) && att >= 1, tag + 'the attempt number is a whole number from 1', String(att));
    const ended = await ev(page, `(() => { const a = ${B}; let g = 0; while (a.ctl.winner === null && g++ < 100000) a.autoplay(10); return { winner: a.ctl.winner, mode: a.mode }; })()`);
    ok(ended.winner !== null && ended.mode !== 'result', tag + 'the ENGINE has ended the match while the scene is still playing it out (not yet on the result screen)', J(ended));
    const rec = await until(async () => { const t = await tw(page, pid1); return (t.current === null && t.runs === 1) || (t.current && t.current.history && t.current.history.length === 1) ? t : null; }, 8000);
    const modeNow = await ev(page, `${B}.mode`);
    ok(!!rec && modeNow !== 'result' && (rec.current ? rec.current.fighting === false && rec.current.attempt === 0 : rec.last && rec.last.won === false), tag + 'the Tower had ALREADY recorded the result (' + (rec && rec.current && rec.current.phase === 'offer' ? 'a win: the offer is open' : 'a loss: a retry is counted') + ') when the scene was not yet on the result screen (so closing the page there can no longer dodge a loss)', J({ mode: modeNow, cur: !!(rec && rec.current), runs: rec && rec.runs }));
    const afterEnd = J(await tw(page, pid1));
    await page.send('Page.reload', {});
    await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    if (rec && rec.current && rec.current.phase === 'offer') ok((await ev(page, `${B}.state`)) === 'error' && (await ev(page, `${B}.towerRefused`)).status === 'stale' && /already counted/.test(await ev(page, `document.body.innerText`)), tag + 'RELOADING there (the floor was won) shows "the result is already counted", not a fresh fight at the team preview', J(await ev(page, `${B}.towerRefused`)));
    else ok((await ev(page, `${B}.state`)) === 'ready' && (await ev(page, `${B}.tower.status`)) === 'ok' && (await ev(page, `${B}.tower.spec.tower.tries`)) === 1, tag + 'RELOADING there (the floor was lost) opens the NEXT try of the floor: the lost one is counted, not offered again', J(await ev(page, `${B}.state`)));
    ok(J(await tw(page, pid1)) === afterEnd, tag + 'and nothing was written by the reload (counted once: no second win, no second retry)');

    // ---- a run with the seeded team: the way back from a won floor lands on #tower-offer; B and B stay inside the hub
    const seeded = await ev(page, SEED_TEAM('MISTY', TEAM)); const pid = seeded.id;
    const started = await ev(page, START_RUN(pid, seeded.team, SEED_B, '3v3'));
    ok(started.applied, tag + 'a run with the seeded team starts', J(started));
    await openHub(page);
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    await key(page, 'a');
    ok((await toBattle(page)) === 'ready', tag + 'FIGHT opens floor 1');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'it is begun');
    await finish(page);
    ok((await ev(page, `${B}.ctl.winner`)) === 0, tag + 'floor 1 is won (the calibrated seed)', String(await ev(page, `${B}.ctl.winner`)));
    await key(page, 'a');                                                         // PICK A BUFF
    await toHubFromBattle();
    ok((await where(page)) === 'tower-offer', tag + 'the hub opens on the offer (#tower-offer)', await where(page));
    await ev(page, `window.__m = 7; true`);
    const len0 = await ev(page, 'history.length');
    await pressB();
    ok((await where(page)) === 'tower', tag + 'B on the offer steps back to the Tower menu (the offer is still there: CHOOSE A BUFF)', (await where(page)) + ' ' + J(await labelsOf(page)));
    ok((await labelsOf(page))[0] === 'CHOOSE A BUFF', tag + 'the first row is CHOOSE A BUFF: the offer was not lost', J(await labelsOf(page)));
    await pressB();
    ok((await where(page)) === 'main' && (await ev(page, `location.pathname.endsWith('/pokemonarena/') && window.__m === 7`)) === true, tag + 'B again lands on the hub\'s MAIN MENU, in the same page: B, B never leaves the hub for the battle page it came from', J({ path: await where(page), href: await ev(page, 'location.href'), m: await ev(page, 'window.__m') }));
    ok((await ev(page, 'history.length')) === len0 + 1 || (await ev(page, 'history.length')) === len0, tag + 'and the history did not run away (' + len0 + ' -> ' + (await ev(page, 'history.length')) + ')');
    // the browser's own Back steps through the same screens
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(250);
    await key(page, 'a'); await sleep(250);
    ok((await where(page)) === 'tower-offer', tag + 'CHOOSE A BUFF opens the same offer');
    await ev(page, `history.back()`); await sleep(400);
    ok((await where(page)) === 'tower' && (await ev(page, `window.__m === 7`)) === true, tag + 'the browser\'s Back from the offer is the Tower menu (not the page before the hub)', await where(page));
    // take a ball: the note says what was taken
    await key(page, 'a'); await sleep(250);
    await key(page, 'a'); await sleep(200); await key(page, 'left'); await key(page, 'a');
    await until(async () => (await where(page)) === 'tower' && /^You took /.test((await hview(page)).msg[0]));
    const noted = (await hview(page)).msg;
    ok(/^You took /.test(noted[0]) && /Floor 2 is next/.test(noted[1]), tag + 'after a ball is taken the Tower menu SAYS what was taken ("You took X!", "Floor 2 is next.")', J(noted));
    await key(page, 'a');                                                         // FIGHT: FLOOR 2
    ok((await toBattle(page)) === 'ready', tag + 'floor 2 opens');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'floor 2 is begun');
    await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; });
    await ev(page, LEAVE);
    await toHubFromBattle();
    ok((await where(page)) === 'tower' && (await labelsOf(page))[0] === 'RETRY FLOOR 2', tag + 'LEAVE TOWER mid-fight costs one retry and lands on the Tower screen, which offers RETRY FLOOR 2', (await where(page)) + ' ' + J(await labelsOf(page)));
    // three more fights of floor 2, each begun and left: the floor's retries are used up, and the fourth one left ENDS the run
    for (let i = 0; i < 3; i++) {
      await key(page, 'a'); if ((await toBattle(page)) !== 'ready') break;
      await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1")); await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting; });
      await ev(page, LEAVE); await toHubFromBattle();
    }
    const tEnd = await tw(page, pid);
    ok(tEnd.current === null && tEnd.last && tEnd.last.cleared === 1 && tEnd.last.retries === 3 && tEnd.runs === 1, tag + 'the fourth fight of floor 2 that is left ENDS the run: its three retries were used up (1 floor cleared, 3 retries)', J({ cur: tEnd.current, last: tEnd.last }));
    ok((await where(page)) === 'tower-last', tag + 'and that lands on the last-run screen (#tower-last)', await where(page));
    await ev(page, `window.__m = 8; true`);
    await pressB();
    ok((await where(page)) === 'tower', tag + 'B on the last-run screen is the Tower menu');
    await pressB();
    ok((await where(page)) === 'main' && (await ev(page, `location.pathname.endsWith('/pokemonarena/') && window.__m === 8`)) === true, tag + 'B again is the main menu, still in the hub page (#tower-last used to leave the hub on the third B)', J({ path: await where(page), href: await ev(page, 'location.href') }));
    // ---- a regular battle still mounts OPEN TO BATTLES (the Tower's exception is only the Tower's)
    await openBattle(page, QUICK);
    ok(!!(await page.waitFor(`${B}.presence`, { timeoutMs: 20000 }).then(() => true, () => false)), tag + 'a regular Quick Battle still mounts OPEN TO BATTLES', '');
    ok(errsOf(page).filter((e) => !/status of (4\d\d)|Failed to load resource/.test(e)).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ residual */
  await session('residual: one START, a quit before any choice, two tabs, the history', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'residual: ';
    const PROFILES = `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); try { const ps = await store.listProfiles(); const out = []; for (const p of ps) { const l = await store.loadProfile(p.id); out.push({ id: p.id, tower: l.profile.tower }); } return out; } finally { await store.close(); } })()`;
    const toHubFromBattle = async () => { await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 }); await hubReady(page); };
    const tower1 = async () => { const ps = await ev(page, PROFILES); return ps.length === 1 ? ps[0] : null; };
    await openHub(page);
    // ---- START, B, NEW RUN, START inside ONE tick: two visits to NEW RUN (two tokens), and still ONE profile and ONE run (the guard is page-wide, not per token)
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    await key(page, 'a'); await sleep(250);
    ok((await where(page)) === 'tower-new', tag + 'with no profile NEW RUN opens the team screen');
    await key(page, 'down'); await key(page, 'down');
    await ev(page, `(() => { ${HUB}.press('a'); ${HUB}.press('a'); ${HUB}.press('b'); ${HUB}.press('a'); ${HUB}.press('down'); ${HUB}.press('down'); ${HUB}.press('a'); return true; })()`);          // START (twice: a double tap), B, NEW RUN, START
    ok((await toBattle(page)) === 'ready', tag + 'START opens floor 1');
    const ps1 = await ev(page, PROFILES);
    ok(ps1.length === 1 && ps1[0].tower.current && ps1[0].tower.current.floor === 1 && ps1[0].tower.runs === 0 && ps1[0].tower.last === null, tag + 'START, START, B, NEW RUN, START in one tick made exactly ONE profile and ONE run (none made and abandoned, none counted)', J(ps1.map((p) => [p.id, p.tower.runs, !!p.tower.current])));
    ok((await ev(page, `${B}.tower && ${B}.tower.status`)) === 'ok', tag + 'and the page that opened is the fight of that run (status ok: nothing was fighting)');
    // ---- LEAVE TOWER before any choice: it costs NOTHING and changes nothing (THE RULE CHANGED 2026-11-17: it used to drop the run)
    await ev(page, LEAVE);
    await toHubFromBattle();
    const pq = await tower1();
    ok(pq && J(pq.tower) === J(ps1[0].tower) && pq.tower.current && pq.tower.current.floor === 1 && pq.tower.current.history.length === 0 && pq.tower.runs === 0 && pq.tower.last === null && Object.keys(pq.tower.achievements).length === 0, tag + 'LEAVE TOWER with no choice made cost NOTHING: the record is exactly what it was (the same run still waits on floor 1; no run counted, no last run, no achievement)', J(pq && { cur: pq.tower.current && pq.tower.current.floor, runs: pq.tower.runs, last: !!pq.tower.last, ach: Object.keys(pq.tower.achievements) }));
    ok((await where(page)) === 'tower' && (await labelsOf(page))[0] === 'FIGHT: FLOOR 1', tag + 'and the hub opens on the Tower screen, which still offers FIGHT: FLOOR 1', (await where(page)) + ' ' + J(await labelsOf(page)));
    // ---- tab A on floor 1 of that run
    const pid = pq.id;
    await key(page, 'a');
    ok((await toBattle(page)) === 'ready', tag + 'FIGHT opens floor 1 again (tab A)');
    const search = await ev(page, 'location.search');
    // ---- TWO TABS: the second tab opens the same floor BEFORE any choice (so it is not told the fight is left); A chooses first and marks the fight; B's first choice is refused as a duplicate
    const tabB = await page.openTab();
    await addInit(tabB, AUDIO_DOUBLE);
    ok((await openBattle(tabB, search)) === 'ready', tag + 'tab B opens the same floor 1 (the fight has not begun yet)');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'tab A plays to turn 1: it made the first choice');
    const marked = await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting ? t : null; });
    const attemptA = marked && marked.current.attempt;
    ok(!!marked && Number.isInteger(attemptA) && attemptA >= 1, tag + 'the run is marked as fighting with tab A\'s attempt number', String(attemptA));
    ok((await ev(tabB, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'tab B plays to turn 1 as well (its first choice)');
    ok(!!(await tabB.waitFor(`${B}.towerDuplicate === true`, { timeoutMs: 15000 }).then(() => true, () => false)), tag + 'tab B is told it is a duplicate (the fight is being fought in another tab)');
    const stillA = (await tw(page, pid)).current;
    ok(stillA && stillA.fighting === true && stillA.attempt === attemptA && stillA.history.length === 0, tag + 'and the run still carries tab A\'s attempt (B did not take the fight over)', J(stillA && [stillA.fighting, stillA.attempt, attemptA]));
    // ---- the duplicate tab is RELOADED: it must NOT resume (and finish) A's fight; the fight counts as left
    await tabB.eval(`window.__marker = 1; true`);
    await tabB.send('Page.reload', {});
    await tabB.waitFor(`window.__marker === undefined && window.__arenaBattle && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    const bState = await ev(tabB, `({ state: ${B}.state, restored: ${B}.resume ? ${B}.resume.restored : null, reason: ${B}.resume ? ${B}.resume.reason : null, refused: ${B}.towerRefused || null })`);
    ok(bState.state === 'error' && bState.restored === false && /another page/.test(String(bState.reason)) && bState.refused && bState.refused.status === 'abandoned', tag + 'tab B reloaded does NOT take over tab A\'s fight: its saved battle is refused as another page\'s, and the fight is counted as left', J(bState));
    const afterB = await tw(page, pid);
    ok(!!afterB.current && afterB.current.floor === 1 && afterB.current.fighting === false && afterB.current.history.length === 1 && afterB.current.history[0].result === 'l' && afterB.current.history[0].retry === true && afterB.runs === 0, tag + 'so the abandoned scouting costs what leaving costs: ONE RETRY of floor 1 (and the run goes on)', J({ cur: afterB.current && afterB.current.history, runs: afterB.runs }));
    try { tabB.ws.close(); } catch (_e) { /* the tab dies with the browser */ }
    // (the history checks below need a run that ENDED: the floor is lost three more times through the game's own session, which uses its retries up)
    const lostOut = await ev(page, LOSE_OUT(pid));
    ok(lostOut.current === null && lostOut.n === 3 && lostOut.last && lostOut.last.retries === 3 && lostOut.last.cleared === 0 && lostOut.runs === 1, tag + 'three more lost tries use the floor\'s retries up: the third of them ends the run (3 retries, one run counted)', J(lostOut));

    // ---- THE HISTORY: a hub screen opened by address is seeded ONCE; reloads add nothing, and B, B still ends on the main menu
    await page.navigate(BASE + '/pokemonarena/#tower-last');
    await hubReady(page);
    ok((await where(page)) === 'tower-last', tag + 'the hub opens at #tower-last (the run just ended)', await where(page));
    const len0 = await ev(page, 'history.length');
    ok((await ev(page, `history.state && history.state.arenaHub`)) === 'tower-last', tag + 'the current history entry carries the hub\'s marker', J(await ev(page, 'history.state')));
    const lens = [];
    for (let i = 0; i < 3; i++) { await page.send('Page.reload', {}); await hubReady(page); lens.push(await ev(page, 'history.length')); }
    ok(lens.every((n) => n === len0) && (await where(page)) === 'tower-last', tag + 'three reloads at #tower-last add NOTHING to the history (it stays ' + len0 + ')', J({ len0, lens }));
    await ev(page, `window.__m = 9; true`);
    await ev(page, `${HUB}.press('b')`); await sleep(300);
    ok((await where(page)) === 'tower', tag + 'B on the last-run screen is the Tower menu');
    await ev(page, `${HUB}.press('b')`); await sleep(300);
    ok((await where(page)) === 'main' && (await ev(page, `location.pathname.endsWith('/pokemonarena/') && window.__m === 9`)) === true, tag + 'B again is the MAIN MENU, in the same page, after the reloads: B, B never leaves the hub for the page before it', J({ path: await where(page), href: await ev(page, 'location.href') }));
    // the Forward entry survives a back arrival (the hub is rebooted or restored; either way nothing is rewritten)
    await ev(page, `${HUB}.press('down')`); await ev(page, `${HUB}.press('down')`); await ev(page, `${HUB}.press('a')`); await sleep(300);
    const lenIn = await ev(page, 'history.length');
    await page.navigate(BASE + '/pokemonarena/js/battle_resume.js');
    await ev(page, `history.back()`); await sleep(500);
    await hubReady(page);
    ok((await ev(page, 'history.length')) === lenIn + 1 && (await ev(page, `history.state && history.state.arenaHub`)) === 'tower', tag + 'a Back arrival onto a hub entry adds nothing to the history and keeps the entry it came from as Forward (' + lenIn + ' + 1)', J({ lenIn, now: await ev(page, 'history.length'), state: await ev(page, 'history.state') }));
    await ev(page, `history.forward()`); await sleep(500);
    ok(/battle_resume\.js$/.test(await ev(page, 'location.pathname')), tag + 'and Forward still goes to it', await ev(page, 'location.pathname'));
    ok(errsOf(page).filter((e) => !/status of (4\d\d)|Failed to load resource/.test(e)).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
