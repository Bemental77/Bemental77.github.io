#!/usr/bin/env node
// POKEMON ARENA TOWER PAGE TEST -- the playable Tower in real headless Chrome: the hub's TOWER screens, a floor on battle.html, and the way back, by touch, by keyboard and by controller.
//
//   node tools/pokemonarena_tower_page_test.mjs        ARENA_PORT=8660 ARENA_CDP=10200 ARENA_OUT=<dir for screenshots (open them)>
//
// SESSIONS (tools/headless_cdp.mjs: one muted headless Chrome per session with a throwaway profile, bare CDP; AudioContext and the gamepad are test doubles)
//   phone    390x844 @2x, TOUCH ONLY (the on-screen pad and taps on the canvas): a plain Quick Battle first, a run made in the real IndexedDB, TOWER row -> MY BUFFS -> FIGHT; floor 1 won; the offer by TOUCH
//            (tap a ball -> "take this buff?" -> NO -> tap it again -> YES); floor 2 with that buff on the page; the second offer SKIPPED by touch; floor 3 LEFT through the pause menu = a loss that ENDS the run;
//            the LAST RUN and ACHIEVEMENTS screens; the profile's career record is byte-identical to before the climb; a plain Quick Battle in the same browser plays EXACTLY the battle it played before
//   desktop  1280x800, keyboard + the synthetic controller: a mid-fight RELOAD resumes the floor (and the floor counts once); the offer by CONTROLLER; a fight LEFT by a typed address is a loss; hostile Tower
//            addresses are refused and write nothing; NEW RUN from the hub (a random team) opens floor 1 by itself
//   integrity  1280x800: a double START with no profile makes ONE profile and ONE run; no OPEN TO BATTLES in a Tower fight; the Tower has the result when the ENGINE ends the match (before the result screen), and
//            a reload there shows "already counted"; B, B from #tower-offer and from #tower-last stay inside the hub; the note after a ball is taken shows; a regular battle still mounts OPEN TO BATTLES
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

async function session(name, opts, fn) {
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

    // ---- floor 3: LEFT in the middle = a loss, and with no Extra Life the run ENDS
    await until(async () => (await where(page)) === 'tower');
    await tapRect(page, 0);
    ok((await toBattle(page)) === 'ready', tag + 'floor 3 opens');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 1"))) === 'action', tag + 'floor 3 is played by hand to turn 1');
    const t3b = await until(async () => { const t = await tw(page, pid); return t.current && t.current.fighting ? t : null; });
    ok(!!t3b, tag + 'the profile now says the fight has BEGUN (leaving it from here on is a loss)');
    await ev(page, LEAVE);
    await page.waitFor(`location.pathname.endsWith('/pokemonarena/') && window.__arenaHub && ${HUB}.state === 'ready'`, { timeoutMs: 60000 });
    await hubReady(page);
    const t4 = await tw(page, pid);
    ok(t4.current === null && t4.last && t4.last.cleared === 2 && t4.runs === 1, tag + 'LEAVE TOWER ended the run: no current run, a last run that cleared 2 floors, one run counted', J({ cur: t4.current, last: t4.last && t4.last.cleared, runs: t4.runs }));
    ok(t4.best['3v3'] === 2 && t4.floors === 2, tag + 'the best floor for 3v3 is 2', J(t4.best));
    ok((await where(page)) === 'tower-last', tag + 'the hub opens on the LAST RUN screen (#tower-last)', await where(page));
    const lv = (await hview(page)).tower;
    ok(lv.state === 'ready' && lv.last.cleared === 2 && lv.last.format === '3v3', tag + 'it shows how far the climb got', J(lv.last && [lv.last.cleared, lv.last.format]));
    await shot(page, 'phone_7_last');
    await tapSel(page, '#bB'); await sleep(250);
    const hl = await labelsOf(page);
    ok(hl[0] === 'NEW RUN' && hl.includes('LAST RUN'), tag + 'the Tower screen now offers NEW RUN (and LAST RUN)', J(hl));
    ok((await page.eval(`${HUB}.model.view().tower.panel.lines[2]`)) === 'BEST 3v3 2', tag + 'the panel shows BEST 3v3 2');
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
    ok(/loss/i.test(await ev(page, `document.body.innerText`)), tag + 'and the page says it counted as a loss');
    const t3 = await tw(page, pid);
    ok(t3.current === null && t3.last && t3.last.cleared === 1 && t3.runs === 1, tag + 'the run is over (no Extra Life): it cleared 1 floor', J({ cur: t3.current, last: t3.last && t3.last.cleared, runs: t3.runs }));
    await shot(page, 'desk_4_refused');

    // ---- hostile addresses: refused, and nothing is written
    const before = J(await tw(page, pid));
    const bad = ['?tower=1', '?tower=1&floor=0&run=5', '?tower=1&floor=31&run=5', '?tower=1&floor=abc&run=5', '?tower=2&floor=1&run=5', '?tower=1&floor=1&run=-1', '?tower=1&floor=1&run=99999999999', '?tower=1&floor=1&run=5&life=x',
      '?tower=1&floor=1&run=5&p=../../x', '?tower=1&floor=1&run=5&team=ARENA1.AAAA', '?tower=1&floor=1&run=5&seed=1', '?tower=1&floor=1&run=5&np=host', '?tower=1&floor=1&run=5&p=' + 'x'.repeat(80)];
    const results = [];
    for (const q of bad) { const st = await openBattle(page, q); results.push([q, st, await ev(page, `${B}.tower === undefined || ${B}.tower === null`)]); }
    ok(results.every(([, st, none]) => st === 'error' && none), tag + 'all ' + bad.length + ' hostile Tower addresses are refused on an error screen, with no Tower controller', J(results.filter(([, st, none]) => st !== 'error' || !none)));
    ok(J(await tw(page, pid)) === before, tag + 'and none of them wrote anything to the profile');
    // `floor` / `run` / `life` / `p` WITHOUT tower=1 are not Tower parameters: the address is a regular one and they are ignored, as before the Tower existed
    const stray = [];
    for (const q of ['?floor=1&run=5&seed=11&format=3v3&cpu=easy', '?p=1&seed=11&format=3v3&cpu=easy', '?life=2&run=7&seed=11&format=3v3&cpu=easy']) { const st = await openBattle(page, q); stray.push([q, st, await ev(page, `${B}.tower === undefined || ${B}.tower === null`)]); }
    ok(stray.every(([, st, none]) => st === 'ready' && none), tag + 'an address with floor / run / life / p but no tower=1 is a regular battle that ignores them (as the build before the Tower did)', J(stray));
    ok(J(await tw(page, pid)) === before, tag + 'and wrote nothing to the profile');
    const ghost = await openBattle(page, '?tower=1&floor=1&run=123456');
    ok(ghost === 'error' && J(await tw(page, pid)) === before, tag + 'a well-formed address for a run that does not exist is refused too, and writes nothing', ghost);

    // ---- NEW RUN from the hub: a random team, floor 1 opens by itself
    await openHub(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await key(page, 'down'); await key(page, 'down'); await key(page, 'a'); await sleep(300);
    const h2 = await labelsOf(page);
    ok(h2[0] === 'NEW RUN', tag + 'with the run over the Tower screen offers NEW RUN first', J(h2));
    await key(page, 'a'); await sleep(250);
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
    ok(t5.current === null && t5.runs === 2 && t5.last.cleared === 0, tag + 'leaving at once ends that run with nothing cleared (two runs counted)', J({ cur: t5.current, runs: t5.runs }));
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
    ok(!!rec && modeNow !== 'result' && (rec.current ? rec.current.fighting === false && rec.current.attempt === 0 : rec.last && rec.last.won === false), tag + 'the Tower had ALREADY recorded the result (' + (rec && rec.current ? 'a win: the offer is open' : 'a loss: the run is over') + ') when the scene was not yet on the result screen (so closing the page there can no longer dodge a loss)', J({ mode: modeNow, cur: !!(rec && rec.current), runs: rec && rec.runs }));
    const afterEnd = J(await tw(page, pid1));
    await page.send('Page.reload', {});
    await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
    ok((await ev(page, `${B}.state`)) === 'error' && (await ev(page, `${B}.towerRefused`)).status === 'stale' && /already counted/.test(await ev(page, `document.body.innerText`)), tag + 'RELOADING there shows "the result is already counted", not a fresh fight at the team preview', J(await ev(page, `${B}.towerRefused`)));
    ok(J(await tw(page, pid1)) === afterEnd, tag + 'and nothing was written by the reload (counted once, no free retry, no second loss)');

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
    ok((await where(page)) === 'tower-last', tag + 'LEAVE TOWER lands on the last-run screen (#tower-last)', await where(page));
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
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
