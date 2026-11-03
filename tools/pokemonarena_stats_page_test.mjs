#!/usr/bin/env node
// POKEMONARENA STATS PAGE TEST (ST1) -- the match RECAP and the career RECORD in real headless Chrome, one input device at a time.
//
//   node tools/pokemonarena_stats_page_test.mjs        ARENA_PORT=8160 ARENA_CDP=9780 ARENA_OUT=<dir for screenshots (open them)>
//
// SESSIONS (tools/headless_cdp.mjs: one muted headless Chrome per session with a throwaway profile, bare CDP; AudioContext and the gamepad are test doubles)
//   desktop   battle.html with NO profile (recap yes, nothing written), then with a profile in the real IndexedDB: a quick battle is written ONCE, a reload is a new battle and
//             changes nothing, a reload in the middle of a battle that is then finished is counted exactly once, a forfeit is a forfeit, leaving with BACK TO HUB records nothing,
//             a team battle goes to the profile that owns the team (not the active one), two connections finishing matches at once lose none, the recap by keyboard and by mouse
//   phone     390x844, touch only: the RECAP chip, the three recap buttons and the on-screen pad
//   pad       the synthetic controller alone: d-pad left to RECAP, A, left / right, B
//   record    the hub's RECORD row: keyboard, mouse, touch and controller; the trainer switch; RESET RECORD behind YES / NO; the backup it takes; the record text
// Every check that reads the store reads the REAL IndexedDB through the game's own store.js. Screenshots go to ARENA_OUT.
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, BASE, sleep, key, clickLogical, tapLogical, logicalToPage, moveMouse, rightClick, wheel, padPress, tapSel, errsOf, AUDIO_DOUBLE, PAD_DOUBLE, addInit } = L;
const J = L.J;
const OUT = process.env.ARENA_OUT || L.DEFAULT_OUT;
const CDP0 = L.CDP0;
const C = L.makeCounter('stats-page');
const ok = C.ok;
fs.mkdirSync(OUT, { recursive: true });
const HM = await L.mod('hub_model.js');
const UI = await L.mod('battle_ui.js');
const B = '(window.__arenaBattle)';
const HUB = '(window.__arenaHub)';
const ev = (page, e) => page.eval(e);
const shot = async (page, name) => { await page.screenshot(path.join(OUT, name + '.png')); return name; };

/* ---------------------------------------------------------------------------------------------------------------- in-page helpers */
const STORE_JS = (body) => `(async () => { const S = await import('/pokemonarena/js/store.js'); const store = await S.openStore(); try { ${body} } finally { await store.close(); } })()`;
const READ_ALL = STORE_JS(`const out = []; for (const row of await store.listProfiles()) { const r = await store.loadProfile(row.id); out.push({ id: row.id, name: r.profile.trainerName, rev: r.profile.rev, stats: r.profile.stats }); } return { notSaved: store.status.notSaved, active: await store.getActiveId(), profiles: out };`);
const SEED = (spec) => `(async () => {
  const S = await import('/pokemonarena/js/store.js'), P = await import('/pokemonarena/js/profile.js'), R = await import('/pokemonarena/js/rules.js'), TB = await import('/pokemonarena/js/tables.js'), RF = await import('/pokemonarena/js/romfetch.js');
  const { bytes } = await RF.loadVerifiedRom();
  const pack = TB.loadPack(bytes, { verify: 'header', dexText: false });
  const store = await S.openStore();
  const mk = (name) => { const sid = pack.species.findIndex((s) => s && s.legal && s.name === name); const rec = R.blankRec(sid, pack, R.DEFAULT_RULESET_ID); const ratio = pack.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
  const out = []; let firstId = null;
  for (const [trainer, teams] of ${J(spec)}) {
    const created = await store.createProfile({ trainerName: trainer });
    const box = [], tms = [];
    for (const [tname, names] of teams) { const mons = names.map(mk); box.push(...mons); tms.push(P.createTeam({ name: tname, monIds: mons.map((m) => m.id) })); }
    const saved = await store.saveProfile({ ...created, box, teams: tms }, { reason: 'seed' });
    if (!firstId) firstId = saved.id;
    out.push({ id: saved.id, teams: saved.teams.map((t) => t.id) });
  }
  await store.setActiveId(firstId);
  await store.close();
  return out;
})()`;
const TEAM_CODE = (profileId, teamId) => `(async () => { const S = await import('/pokemonarena/js/store.js'), D = await import('/pokemonarena/js/hub_data.js'); const store = await S.openStore(); const r = await D.teamCodeFor(store, ${J(profileId)}, ${J(teamId)}); await store.close(); return r; })()`;
// a plain match for the in-page store calls (the shape career_stats.js matchFromSummary produces)
const MATCH_JS = (o) => `Object.assign({ id: 'x', at: 1800000000000, fmt: '3v3', cpu: 'normal', ruleset: 'arena-gen3-standard', result: 'w', turns: 9, playMs: 50000, mvp: 25, team: [25, 6, 9], species: [25, 6], moves: [[85, 3], [33, 2]], me: { kos: 2, faints: 1, dealt: 300, taken: 200, hits: 5, crits: 1, superEffective: 2, resisted: 1, noEffect: 0, misses: 1, statusInflicted: 1, healed: 20, switches: 1, koStreak: 2, biggestHit: { sp: 25, mv: 85, dmg: 120, pct: 70, vs: 6 } }, foeFaints: 3 }, ${J(o || {})})`;

/* ---------------------------------------------------------------------------------------------------------------- battle page helpers */
const openBattle = async (page, query, { nav = true } = {}) => {
  await page.navigate(BASE + '/pokemonarena/battle.html' + (query || ''));
  await page.waitFor(`${B} && (${B}.state === 'ready' || ${B}.state === 'error')`, { timeoutMs: 90000 });
  const st = await ev(page, `${B}.state`);
  if (nav && st === 'ready') await ev(page, `window.__nav = []; window.__arenaNavigate = (u) => { window.__nav.push(u); }; true`);
  return st;
};
// plays the human's seat by hand (team preview, confirm, action, moves, party, text) until `cond` holds or the battle is over
const DRIVE = (cond) => `(() => { const a = ${B}; for (let g = 0; g < 600000; g++) { a.scene.tick(); if (${cond}) return a.mode; if (a.mode === 'result') return a.mode; const m = a.mode; if (m === 'preview') { const p = a.scene.S.preview; if (p.picks.length < p.pick) { a.press('a'); if (a.mode === 'preview') a.press('down'); } } else if (m === 'confirm') { if (a.scene.S.confirm.kind === 'team') a.press('a'); } else if (m === 'action' || m === 'moves' || m === 'party') a.press('a'); else if (m === 'steps' && g % 61 === 0) a.press('a'); } return a.mode; })()`;
const careerState = (page) => ev(page, `${B}.career.state`);
const waitCareer = async (page) => { await page.waitFor(`${B}.career && ['saved', 'duplicate', 'none', 'error'].includes(${B}.career.state)`, { timeoutMs: 20000 }); return careerState(page); };
const finishBattle = async (page) => { await ev(page, `${B}.autoplay(600000)`); await page.waitFor(`${B}.mode === 'result'`, { timeoutMs: 20000 }); };
const armed = (page) => page.waitFor(`${B}.scene.state().resultArmed`, { timeoutMs: 25000 });
const mode = (page) => ev(page, `${B}.mode`);
const scene = (page) => ev(page, `(() => { const s = ${B}.scene.state(); return { mode: s.mode, page: s.recapPage, count: s.recapCount, cursor: s.resultCursor, career: s.career }; })()`);
const titles = (page) => ev(page, `${B}.scene.view().recap ? ${B}.scene.view().recap.page.title : null`);
const readAll = (page) => ev(page, READ_ALL);
const pageText = (page) => ev(page, `(() => { const v = ${B}.scene.view(); return v.recap ? v.recap.page.lines.map((l) => l.cells.map((c) => c.t).filter(Boolean).join(' ')).join(' / ') : ''; })()`);

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
  server = await L.startServer('/pokemonarena/battle.html');
  console.log('dev server up on ' + BASE);
  let cdp = CDP0;

  /* ================================================================================================================ desktop */
  await session('desktop: recap, career, reload, forfeit, leave, team, two connections', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'desktop: ';
    // ---- no profile at all: the recap works, nothing is written
    ok((await openBattle(page, '?seed=5&format=3v3&cpu=easy')) === 'ready', tag + 'the battle page is ready (no profile in this browser)');
    await finishBattle(page);
    ok((await waitCareer(page)) === 'none', tag + 'with no profile the career line is "none" (nothing is written)', await careerState(page));
    const store0 = await readAll(page);
    ok(store0.profiles.length === 0 && store0.active === null, tag + 'and the store still holds no profile', J(store0).slice(0, 120));
    await armed(page);
    await shot(page, 'desk_1_result_with_recap_chip');
    await key(page, 'left');
    ok((await scene(page)).cursor === -1, tag + 'LEFT from REMATCH puts the cursor on the RECAP chip', J(await scene(page)));
    await key(page, 'a');
    let s = await scene(page);
    ok(s.mode === 'recap' && s.page === 0 && s.count === 7, tag + 'A on RECAP opens the recap (page 1 of 7)', J(s));
    const seen = [];
    for (let i = 0; i < 7; i++) { seen.push(await titles(page)); if (i < 2 || i === 6) await shot(page, 'desk_2_recap_p' + (i + 1)); await key(page, 'right'); }
    ok(J(seen) === J(['SUMMARY', 'MOMENTS', 'YOUR TEAM', 'FOE TEAM', 'MOVES', 'COMPARE', 'RECORD']), tag + 'ArrowRight walks the seven pages in order', J(seen));
    ok(/NOT SAVED/.test(await pageText(page)) && /No trainer profile is in use/.test(await pageText(page)), tag + 'the RECORD page says plainly that the battle is not kept (no profile)', await pageText(page));
    await key(page, 'b');
    ok((await scene(page)).mode === 'result', tag + 'B goes back to the result screen');
    ok((await ev(page, `window.__nav.length`)) === 0, tag + 'nothing navigated while the recap was used');

    // ---- a profile in the real IndexedDB
    const seeded = await ev(page, SEED([['ASH', [['Trio', ['Pikachu', 'Charizard', 'Snorlax']]]], ['MISTY', [['Water', ['Blastoise', 'Gyarados', 'Lapras']]]]]));
    const [ash, misty] = seeded;
    ok(seeded.length === 2, tag + 'two profiles were seeded into real IndexedDB (ASH is the active one)');
    ok((await openBattle(page, '?seed=3&format=3v3&cpu=normal')) === 'ready', tag + 'a quick battle opens');
    await finishBattle(page);
    ok((await waitCareer(page)) === 'saved', tag + 'a quick battle is SAVED to the active profile', await careerState(page));
    let all = await readAll(page);
    let a = all.profiles.find((p) => p.id === ash.id).stats, m = all.profiles.find((p) => p.id === misty.id).stats;
    const n1 = a.wins + a.losses + a.draws + a.forfeits;
    ok(n1 === 1 && m.wins + m.losses + m.draws + m.forfeits === 0, tag + 'exactly one battle is on ASH and none on MISTY', J([n1, a.recent.length]));
    const id1 = a.recent[0].id;
    ok(/^3_3v3_normal_[0-9a-z]+$/.test(id1) && (await ev(page, `${B}.career.matchId`)) === id1 && (await ev(page, `${B}.career.profileId`)) === ash.id, tag + 'its id is seed_format_cpu_time and the page reports the same id and profile', id1);
    const summ = await ev(page, `${B}.scene.summary()`);
    ok(a.totals.turns === summ.turns && a.totals.kos === summ.sides[0].kos && a.totals.dealt === summ.sides[0].dealt && a.recent[0].res === summ.result && a.recent[0].turns === summ.turns, tag + 'what was written is what the recap shows (turns, KOs, damage, result)', J({ a: a.totals, s: [summ.turns, summ.sides[0].kos] }));
    await armed(page);
    await key(page, 'left'); await key(page, 'a');
    for (let i = 0; i < 6; i++) await key(page, 'right');
    const rtxt = await pageText(page);
    ok(/SAVED TO ASH'S RECORD/.test(rtxt) && /BATTLES\s+1/.test(rtxt), tag + 'the RECORD page of the recap says SAVED TO ASH\'S RECORD with the battle count', rtxt);
    await shot(page, 'desk_3_recap_record_saved');
    await key(page, 'b');

    // ---- a reload is a new battle: nothing is counted twice
    await page.send('Page.reload', {});
    await page.waitFor(`${B} && ${B}.state === 'ready'`, { timeoutMs: 90000 });
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.wins + a.losses + a.draws + a.forfeits === 1, tag + 'reloading the result page starts a fresh battle and the record still says ONE battle');
    await ev(page, `window.__nav = []; true`);
    await finishBattle(page); await waitCareer(page);
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.wins + a.losses + a.draws + a.forfeits === 2 && new Set(a.recent.map((r) => r.id)).size === 2, tag + 'finishing that battle makes it two, with two different ids (same seed, a new play)', J(a.recent.map((r) => r.id)));

    // ---- a reload in the middle of a battle: resumed, and counted once at the end
    ok((await openBattle(page, '?seed=11&format=3v3&cpu=easy')) === 'ready', tag + 'a new battle opens');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 3"))) === 'action', tag + 'a battle is played by hand to turn 3');
    await sleep(250);
    await ev(page, `window.__marker = 1; true`); await page.send('Page.reload', {});
    await page.waitFor(`window.__marker === undefined && ${B} && ${B}.state === 'ready'`, { timeoutMs: 90000 });
    ok((await ev(page, `${B}.resume.restored`)) === true, tag + 'the reload in the middle RESUMED the battle (D11)', J(await ev(page, `${B}.resume`)));
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.wins + a.losses + a.draws + a.forfeits === 2, tag + 'the replayed history of a resumed battle wrote nothing (still two)');
    await ev(page, `window.__nav = []; window.__arenaNavigate = (u) => { window.__nav.push(u); }; true`);
    await finishBattle(page); await waitCareer(page);
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.wins + a.losses + a.draws + a.forfeits === 3, tag + 'finishing the resumed battle counts it exactly ONCE (three, not four)', J(a.recent.map((r) => r.id)));

    // ---- a forfeit is a forfeit
    await openBattle(page, '?seed=13&format=3v3&cpu=normal');
    ok((await ev(page, DRIVE("a.mode === 'action' && a.ctl.turn >= 2"))) === 'action', tag + 'the forfeit battle is played to turn 2');
    await ev(page, `(() => { const a = ${B}; a.press('down'); a.press('right'); a.press('a'); a.press('up'); a.press('a'); return a.mode; })()`);
    await ev(page, `(() => { const a = ${B}; for (let k = 0; k < 600000 && a.mode !== 'result'; k++) { a.scene.tick(); if (a.mode === 'steps' && a.scene.S.cur && a.scene.S.cur.t === 'text') a.press('a'); } return a.mode; })()`);
    ok((await waitCareer(page)) === 'saved', tag + 'a forfeited battle is recorded');
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.forfeits === 1 && a.recent[0].res === 'f' && a.byFormat['3v3'].f === 1 && a.byCpu.normal.f === 1, tag + 'as a FORFEIT (not a loss): forfeits 1, the recent list says QUIT', J([a.forfeits, a.losses, a.recent[0].res]));
    await armed(page); await key(page, 'left'); await key(page, 'a');
    ok(/YOU GAVE UP/.test(await pageText(page)), tag + 'its recap says YOU GAVE UP', await pageText(page));
    await key(page, 'b');

    // ---- leaving in the middle records nothing
    const before = a.wins + a.losses + a.draws + a.forfeits;
    await openBattle(page, '?seed=17&format=3v3&cpu=easy');
    ok((await ev(page, DRIVE("a.mode === 'action'"))) === 'action', tag + 'the next battle is at its first action menu');
    await ev(page, `(() => { const a = ${B}; a.press('start'); const rows = a.scene.S.menu.rows.length; for (let i = 0; i < rows - 1; i++) a.press('down'); a.press('a'); a.press('up'); a.press('a'); return a.mode; })()`);
    await sleep(300);
    ok((await ev(page, `window.__nav.length`)) === 1 && (await ev(page, `window.__nav[0]`)) === '/pokemonarena/', tag + 'BACK TO HUB from the pause menu leaves for the hub');
    all = await readAll(page); a = all.profiles.find((p) => p.id === ash.id).stats;
    ok(a.wins + a.losses + a.draws + a.forfeits === before, tag + 'and leaving a battle in the middle records NOTHING', String(before));

    // ---- a team battle goes to the profile that OWNS the team, not the active one
    const code = await ev(page, TEAM_CODE(misty.id, misty.teams[0]));
    ok(code.ok === true, tag + 'a team code for MISTY\'s team');
    const mBefore = all.profiles.find((p) => p.id === misty.id).stats; const mN = mBefore.wins + mBefore.losses + mBefore.draws + mBefore.forfeits;
    await openBattle(page, '?team=' + encodeURIComponent(code.code) + '&foe=random&seed=23&format=3v3&cpu=easy');
    ok((await ev(page, `${B}.state`)) === 'ready' && (await ev(page, `${B}.params.quick`)) === false, tag + 'a team battle with MISTY\'s team code opens (ASH is still the active profile)');
    await finishBattle(page); await waitCareer(page);
    all = await readAll(page);
    const am = all.profiles.find((p) => p.id === misty.id).stats, aa = all.profiles.find((p) => p.id === ash.id).stats;
    ok(am.wins + am.losses + am.draws + am.forfeits === mN + 1 && aa.wins + aa.losses + aa.draws + aa.forfeits === before, tag + 'the team battle is written to MISTY (who owns the team), ASH is unchanged', J([mN, am.recent.length, before]));
    ok((await ev(page, `${B}.career.profileId`)) === misty.id && am.recent[0].team.length === 3, tag + 'and the recent entry holds the three species of the team that fought', J(am.recent[0]));
    await armed(page);

    // ---- BACK TO HUB right after the result waits for the write (nothing is cut off)
    const nBefore = (await readAll(page)).profiles.find((p) => p.id === ash.id).stats; const nb = nBefore.wins + nBefore.losses + nBefore.draws + nBefore.forfeits;
    await openBattle(page, '?seed=29&format=3v3&cpu=easy');
    await finishBattle(page);
    await armed(page);
    await ev(page, `(() => { const a = ${B}; a.scene.S.result.cursor = 2; a.press('a'); return true; })()`);
    await page.waitFor(`window.__nav.length === 1`, { timeoutMs: 8000 });
    const nAfter = (await readAll(page)).profiles.find((p) => p.id === ash.id).stats;
    ok(nAfter.wins + nAfter.losses + nAfter.draws + nAfter.forfeits === nb + 1, tag + 'choosing BACK TO HUB at once after the result still leaves the battle written (it waited for the store)');

    // ---- two connections to the real IndexedDB finishing matches at the same moment lose none
    const two = await ev(page, `(async () => {
      const S = await import('/pokemonarena/js/store.js');
      const a = await S.openStore(), b = await S.openStore();
      const id = ${J(ash.id)};
      const before = (await a.loadProfile(id)).profile.stats;
      const jobs = [];
      for (let i = 0; i < 20; i++) jobs.push((i % 2 ? a : b).recordMatch(id, Object.assign(${MATCH_JS({})}, { id: 'two' + i, at: 1800000100000 + i })));
      const done = await Promise.all(jobs);
      const after = (await a.loadProfile(id)).profile.stats;
      await a.close(); await b.close();
      return { wins0: before.wins, wins1: after.wins, ok: done.every((d) => d.ok && !d.duplicate), revs: new Set(done.map((d) => d.saved.rev)).size, recent: after.recent.length };
    })()`);
    ok(two.ok && two.wins1 === two.wins0 + 20 && two.revs === 20 && two.recent === 20, tag + 'two real IndexedDB connections recording 20 matches at once lose none (20 wins added, 20 distinct revisions)', J(two));

    // ---- the recap with the mouse
    await openBattle(page, '?seed=31&format=3v3&cpu=easy');
    await finishBattle(page); await waitCareer(page); await armed(page);
    const rr = await ev(page, `(() => { const r = ${B}.ui.resultRects(${B}.scene.view().result); return { recap: r.recap, opt: r.options }; })()`);
    await clickLogical(page, `${B}.canvas`, rr.recap.x + rr.recap.w / 2, rr.recap.y + rr.recap.h / 2); await sleep(150);
    ok((await scene(page)).mode === 'recap', tag + 'a mouse click on the RECAP chip opens the recap');
    const ch = await ev(page, `${B}.ui.GEOM.recap.chips`);
    const nextC = ch.find((c) => c.id === 'next'), prevC = ch.find((c) => c.id === 'prev'), backC = ch.find((c) => c.id === 'back');
    await clickLogical(page, `${B}.canvas`, nextC.x + nextC.w / 2, nextC.y + nextC.h / 2); await sleep(100);
    ok((await scene(page)).page === 1, tag + 'a click on NEXT turns the page');
    await clickLogical(page, `${B}.canvas`, prevC.x + prevC.w / 2, prevC.y + prevC.h / 2); await sleep(100);
    ok((await scene(page)).page === 0, tag + 'a click on PREV turns it back');
    await clickLogical(page, `${B}.canvas`, 120, 70); await sleep(100);
    ok((await scene(page)).page === 1, tag + 'a click on the page itself is A (next page)');
    const pw = await logicalToPage(page, `${B}.canvas`, 120, 70);
    await moveMouse(page, pw.x, pw.y); await sleep(150);
    ok((await ev(page, `getComputedStyle(${B}.canvas).cursor`)) === 'pointer', tag + 'the mouse pointer is a hand over the page (a click does something)');
    await wheel(page, pw.x, pw.y, 100); await sleep(120);
    ok((await scene(page)).page === 2, tag + 'the mouse wheel turns the page (down = next)');
    await rightClick(page, pw.x, pw.y); await sleep(150);
    ok((await scene(page)).mode === 'result', tag + 'a right click is B: back to the result screen');
    await armed(page);
    await key(page, 'a'); await key(page, 'right');                          // the cursor is still on the RECAP chip: A opens the recap again
    await clickLogical(page, `${B}.canvas`, backC.x + backC.w / 2, backC.y + backC.h / 2); await sleep(120);
    ok((await scene(page)).mode === 'result', tag + 'a click on BACK returns to the result screen');
    // the mash: A pressed 60 times from the RECAP chip never reaches an option
    await ev(page, `window.__nav = []; true`);
    for (let i = 0; i < 60; i++) await key(page, 'a', 8);
    ok((await ev(page, `window.__nav.length`)) === 0, tag + '60 presses of Enter from the RECAP chip start nothing (the recap loops, REMATCH is never reached)', J(await scene(page)));
    // sound: the recap uses the menu sounds
    const sfx = await ev(page, `window.__arenaSound ? window.__arenaSound.state().menuSfx.slice(-6) : null`);
    ok(Array.isArray(sfx) && sfx.length > 0 && sfx.every((x) => ['se_cursor', 'se_select', 'se_back', 'se_error'].includes(x)), tag + 'the recap plays the same menu sounds as the other menus (cursor / select / back)', J(sfx));
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ phone */
  await session('phone: touch only', { width: 390, height: 844, mobile: true, dpr: 3, port: cdp++ }, async (page) => {
    const tag = 'touch: ';
    await openBattle(page, '?seed=3&format=3v3&cpu=easy');
    await finishBattle(page); await waitCareer(page); await armed(page);
    await shot(page, 'phone_1_result');
    ok((await ev(page, `document.body.dataset.pad`)) === 'on', tag + 'the on-screen pad is shown');
    const rr = await ev(page, `(() => { const r = ${B}.ui.resultRects(${B}.scene.view().result); return r.recap; })()`);
    await tapLogical(page, `${B}.canvas`, rr.x + rr.w / 2, rr.y + rr.h / 2); await sleep(200);
    ok((await scene(page)).mode === 'recap', tag + 'a tap on the RECAP chip opens the recap');
    await shot(page, 'phone_2_recap_p1');
    const ch = await ev(page, `${B}.ui.GEOM.recap.chips`);
    const nextC = ch.find((c) => c.id === 'next'), backC = ch.find((c) => c.id === 'back');
    await tapLogical(page, `${B}.canvas`, nextC.x + nextC.w / 2, nextC.y + nextC.h / 2); await sleep(150);
    ok((await scene(page)).page === 1, tag + 'a tap on NEXT turns the page');
    await tapSel(page, '#bA'); await sleep(150);
    ok((await scene(page)).page === 2, tag + 'the on-screen A turns the page too');
    await tapSel(page, '#bRight'); await sleep(120);
    ok((await scene(page)).page === 3, tag + 'the on-screen pad\'s right turns the page');
    await tapSel(page, '#bLeft'); await sleep(120);
    ok((await scene(page)).page === 2, tag + 'the on-screen pad\'s left turns it back');
    await shot(page, 'phone_3_recap_p3');
    await tapLogical(page, `${B}.canvas`, backC.x + backC.w / 2, backC.y + backC.h / 2); await sleep(150);
    ok((await scene(page)).mode === 'result', tag + 'a tap on BACK returns to the result screen');
    await tapLogical(page, `${B}.canvas`, rr.x + rr.w / 2, rr.y + rr.h / 2); await sleep(150);
    await tapSel(page, '#bB'); await sleep(150);
    ok((await scene(page)).mode === 'result', tag + 'the on-screen B leaves the recap');
    const t = await ev(page, `(() => { const c = ${B}.canvas.getBoundingClientRect(); return { w: c.width, h: c.height }; })()`);
    ok(t.w >= 240, tag + 'the picture is at least 2x on a phone (' + t.w + ' css px wide)', J(t));
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ controller */
  await session('pad: the synthetic controller alone', { width: 1280, height: 800, port: cdp++, pad: true }, async (page) => {
    const tag = 'pad: ';
    await openBattle(page, '?seed=3&format=3v3&cpu=easy');
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await finishBattle(page); await waitCareer(page); await armed(page);
    await padPress(page, 14);                                        // d-pad left
    ok((await scene(page)).cursor === -1, tag + 'D-pad left puts the cursor on RECAP', J(await scene(page)));
    await padPress(page, 0);                                         // A
    ok((await scene(page)).mode === 'recap', tag + 'A opens the recap');
    await padPress(page, 15); await padPress(page, 15);
    ok((await scene(page)).page === 2, tag + 'D-pad right twice turns two pages');
    await padPress(page, 13);                                        // down = next
    ok((await scene(page)).page === 3, tag + 'D-pad down turns the page too');
    await padPress(page, 12); await padPress(page, 14);
    ok((await scene(page)).page === 1, tag + 'D-pad up and left turn back');
    await padPress(page, 9);                                         // Start
    ok((await scene(page)).mode === 'result', tag + 'Start leaves the recap (it does not open the pause menu)');
    await padPress(page, 0);                                         // A again: RECAP is still the cursor
    await padPress(page, 1);                                         // B
    ok((await scene(page)).mode === 'result', tag + 'B leaves the recap');
    ok((await ev(page, `window.__nav.length`)) === 0, tag + 'nothing navigated');
    await shot(page, 'pad_1_result_back_from_recap');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  /* ================================================================================================================ the hub's RECORD */
  const hubUrl = (q = '') => BASE + '/pokemonarena/' + q;
  const bootHub = async (page, q = '') => { await page.navigate(hubUrl(q)); await page.waitFor(`${HUB} && ${HUB}.state !== 'boot'`, { timeoutMs: 90000 }); await ev(page, `window.__nav = []; window.__arenaNavigate = (u) => { window.__nav.push(u); }; true`); return ev(page, `${HUB}.state`); };
  const hv = (page) => ev(page, `${HUB}.view()`);
  const rec = (page) => ev(page, `(() => { const v = ${HUB}.view(); return v.record ? { title: v.record.page.title, index: v.record.index, count: v.record.count, trainer: v.record.trainer && v.record.trainer.name, confirm: v.record.confirm, notice: v.record.notice, text: v.record.page.lines.map((l) => l.cells.map((c) => c.t).filter(Boolean).join(' ')).join(' / ') } : null; })()`);
  const where = (page) => ev(page, `${HUB}.model.path()`);
  const RECORD_Y = HM.GEOM.menu.y + 2 * HM.menuPitch(8) + (HM.menuPitch(8) >> 1);

  await session('record: keyboard + mouse', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'record kbd+mouse: ';
    ok((await bootHub(page)) === 'ready', tag + 'the hub is ready (no profile yet)');
    await key(page, 'down'); await key(page, 'down'); await sleep(80);
    ok((await ev(page, `${HUB}.view().menu.rows[${HUB}.view().menu.cursor].label`)) === 'RECORD', tag + 'two ArrowDown presses reach the RECORD row');
    await key(page, 'a'); await sleep(200);
    ok((await where(page)) === 'record' && (await page.eval('location.hash')) === '#record' && (await page.eval('document.title')) === 'Pokemon Arena - Record', tag + 'Enter opens RECORD (address #record, the title follows)');
    let r = await rec(page);
    ok(r && r.notice === true && /NO TRAINER PROFILE YET/.test(r.text), tag + 'with no profile it says so and offers the Team Builder', J(r).slice(0, 200));
    await shot(page, 'rec_1_no_profile');
    await key(page, 'a'); await sleep(200);
    ok((await ev(page, `window.__nav[0]`)) === '/pokemonarena/editor.html', tag + 'A on that page opens the Team Builder');
    await key(page, 'b'); await sleep(150);
    ok((await where(page)) === 'main', tag + 'B goes back to the main menu');

    // seed two profiles; give ASH a record through the real store
    const seeded = await ev(page, SEED([['ASH', [['Trio', ['Pikachu', 'Charizard', 'Snorlax']]]], ['MISTY', [['Water', ['Blastoise', 'Gyarados', 'Lapras']]]]]));
    const [ash, misty] = seeded;
    await ev(page, STORE_JS(`const id = ${J(ash.id)}; const res = ['w', 'w', 'l', 'f', 'd', 'w', 'w']; for (let i = 0; i < res.length; i++) await store.recordMatch(id, Object.assign(${MATCH_JS({})}, { id: 'rec' + i, at: 1800000000000 + i * 86400000, result: res[i], turns: 5 + i, fmt: i % 2 ? '6v6' : '3v3', cpu: ['easy', 'normal', 'hard'][i % 3] })); return true;`));
    await bootHub(page);
    await page.waitFor(`${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 2 && ${HUB}.data.profiles[0].record`, { timeoutMs: 15000 });
    await ev(page, `${HUB}.pause(true)`);
    await clickLogical(page, `${HUB}.canvas`, 60, RECORD_Y); await sleep(200);
    r = await rec(page);
    ok(r && r.trainer === 'ASH' && r.title === 'OVERALL' && r.count === 8 && /BATTLES 7/.test(r.text) && /WIN RATE 57%/.test(r.text), tag + 'a click on RECORD opens ASH\'s record: OVERALL 1/8 (7 battles: two RECENT pages), BATTLES 7, WIN RATE 57%', J(r).slice(0, 260));
    await shot(page, 'rec_2_overall');
    const titles = [];
    for (let i = 0; i < 8; i++) { titles.push((await rec(page)).title); await key(page, 'right'); }
    ok(J(titles) === J(['OVERALL', 'MODES', 'FAVOURITES', 'HIGHS', 'TOTALS', 'RECENT', 'RECENT', 'RESET']), tag + 'ArrowRight walks OVERALL, MODES, FAVOURITES, HIGHS, TOTALS, RECENT, RECENT, RESET', J(titles));
    ok((await rec(page)).index === 7, tag + 'and stops on the last page');
    await key(page, 'left'); await key(page, 'left');
    ok((await rec(page)).title === 'RECENT' && (await rec(page)).index === 5, tag + 'ArrowLeft turns back');
    await key(page, 'up'); await sleep(80);
    ok((await ev(page, `${HUB}.view().record.focus`)) === 'trainer', tag + 'with two trainers ArrowUp puts the cursor on the trainer');
    await key(page, 'right'); await sleep(100);
    r = await rec(page);
    ok(r.trainer === 'MISTY' && r.index === 0 && r.count === 1 && /NO BATTLES YET/.test(r.text), tag + 'ArrowRight there switches to MISTY (no battles yet: one page that says so)', J(r).slice(0, 200));
    await shot(page, 'rec_3_trainer_misty');
    await key(page, 'left'); await sleep(100);
    ok((await rec(page)).trainer === 'ASH', tag + 'and back to ASH');
    await key(page, 'down');
    // the hub text for screen readers follows
    const live = await ev(page, `document.getElementById('live').textContent`);
    ok(/Record of ASH, page 1 of 8: OVERALL/.test(live), tag + 'the screen-reader line names the record, the trainer and the page', live.slice(0, 120));
    for (let i = 0; i < 7; i++) await key(page, 'right');
    await shot(page, 'rec_4_reset_page');
    await key(page, 'a'); await sleep(100);
    r = await rec(page);
    ok(r.confirm && r.confirm.cursor === 1 && /RESET ASH'S RECORD/.test(r.text), tag + 'A on the last page asks RESET ASH\'S RECORD? with NO selected', J(r).slice(0, 200));
    await shot(page, 'rec_5_confirm');
    await key(page, 'b'); await sleep(80);
    ok((await rec(page)).confirm === null && (await readAll(page)).profiles.find((p) => p.id === ash.id).stats.wins === 4, tag + 'B answers NO: nothing changed (4 wins still there)');
    await key(page, 'a'); await key(page, 'a'); await sleep(100);
    ok((await rec(page)).confirm === null && (await readAll(page)).profiles.find((p) => p.id === ash.id).stats.wins === 4, tag + 'A on the default answer NO changes nothing either');
    await key(page, 'a'); await key(page, 'left'); await key(page, 'a'); await sleep(500);
    const after = (await readAll(page)).profiles.find((p) => p.id === ash.id);
    ok(after.stats.wins === 0 && after.stats.recent.length === 0 && after.stats.totals.turns === 0 && (await ev(page, `${HUB}.recordReset`)) === 1, tag + 'YES empties ASH\'s record in the store (the hub reports one reset)', J(after.stats).slice(0, 160));
    const bk = await ev(page, STORE_JS(`const b = await store.getAutoBackup(${J(ash.id)}); return b ? { reason: b.reason, wins: b.file.profile.stats.wins } : null;`));
    ok(bk && bk.reason === 'pre-reset-record' && bk.wins === 4, tag + 'an automatic backup of the OLD record (4 wins) was taken before the reset', J(bk));
    ok((await readAll(page)).profiles.find((p) => p.id === ash.id).teams === undefined && (await ev(page, STORE_JS(`const r = await store.loadProfile(${J(ash.id)}); return r.profile.teams.length + ':' + r.profile.box.length;`))) === '1:3', tag + 'the teams and the box are untouched by a reset (1 team, 3 Pokemon)');
    r = await rec(page);
    ok(r.trainer === 'ASH' && /NO BATTLES YET/.test(r.text), tag + 'the screen now shows an empty record', J(r).slice(0, 160));
    // mouse: chips
    await ev(page, STORE_JS(`await store.recordMatch(${J(ash.id)}, Object.assign(${MATCH_JS({})}, { id: 'after', at: 1800000900000 })); return true;`));
    await sleep(500);
    const G = HM.GEOM.record;
    await key(page, 'b'); await sleep(100);
    await clickLogical(page, `${HUB}.canvas`, 60, RECORD_Y); await sleep(200);
    await clickLogical(page, `${HUB}.canvas`, G.chips[2].x + 20, G.chips[2].y + 8); await sleep(120);
    ok((await rec(page)).index === 1, tag + 'a click on NEXT turns the page');
    await clickLogical(page, `${HUB}.canvas`, G.chips[0].x + 20, G.chips[0].y + 8); await sleep(120);
    ok((await rec(page)).index === 0, tag + 'a click on PREV turns it back');
    await clickLogical(page, `${HUB}.canvas`, G.trainer.x + G.trainer.w - 8, 8); await sleep(150);
    ok((await rec(page)).trainer === 'MISTY', tag + 'a click on the right half of the trainer name switches trainer');
    await clickLogical(page, `${HUB}.canvas`, G.trainer.x + 8, 8); await sleep(150);
    ok((await rec(page)).trainer === 'ASH', tag + '...the left half switches back');
    const pw = await logicalToPage(page, `${HUB}.canvas`, 120, 70);
    await moveMouse(page, pw.x, pw.y); await wheel(page, pw.x, pw.y, 100); await sleep(120);
    ok((await rec(page)).index === 1, tag + 'the wheel turns pages');
    await clickLogical(page, `${HUB}.canvas`, G.chips[1].x + 20, G.chips[1].y + 8); await sleep(150);
    ok((await where(page)) === 'main', tag + 'a click on BACK returns to the main menu');
    await clickLogical(page, `${HUB}.canvas`, 60, RECORD_Y); await sleep(200);
    ok((await where(page)) === 'record', tag + 'RECORD opens again');
    await page.eval('history.back()'); await sleep(300);
    ok((await where(page)) === 'main', tag + 'the browser Back button leaves RECORD (screens are history entries)');
    ok(errsOf(page).length === 0, tag + 'no console errors in the whole session', errsOf(page).slice(0, 2).join(' | '));
  });

  await session('record: phone touch', { width: 390, height: 844, mobile: true, dpr: 3, port: cdp++ }, async (page) => {
    const tag = 'record touch: ';
    await bootHub(page);
    const seeded = await ev(page, SEED([['ASH', [['Trio', ['Pikachu', 'Charizard', 'Snorlax']]]]]));
    await ev(page, STORE_JS(`const id = ${J(seeded[0].id)}; for (let i = 0; i < 5; i++) await store.recordMatch(id, Object.assign(${MATCH_JS({})}, { id: 'p' + i, at: 1800000000000 + i * 3600000, result: i % 4 === 3 ? 'l' : 'w' })); return true;`));
    await bootHub(page);
    await page.waitFor(`${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 1 && ${HUB}.data.profiles[0].record`, { timeoutMs: 15000 });
    await ev(page, `${HUB}.pause(true)`);
    await tapLogical(page, `${HUB}.canvas`, 60, RECORD_Y); await sleep(250);
    ok((await where(page)) === 'record', tag + 'tapping RECORD opens it');
    await shot(page, 'rec_phone_1');
    const G = HM.GEOM.record;
    await tapLogical(page, `${HUB}.canvas`, G.chips[2].x + 20, G.chips[2].y + 8); await sleep(150);
    ok((await rec(page)).index === 1, tag + 'a tap on NEXT turns the page');
    await tapSel(page, '#bA'); await sleep(150);
    ok((await rec(page)).index === 2, tag + 'the on-screen A turns the page');
    await tapSel(page, '#bLeft'); await sleep(120);
    ok((await rec(page)).index === 1, tag + 'the on-screen left turns it back');
    await shot(page, 'rec_phone_2_modes');
    await tapLogical(page, `${HUB}.canvas`, 120, 70); await sleep(120);
    await tapSel(page, '#bB'); await sleep(200);
    ok((await where(page)) === 'main', tag + 'the on-screen B goes back');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });

  await session('record: controller', { width: 1280, height: 800, port: cdp++, pad: true }, async (page) => {
    const tag = 'record pad: ';
    await bootHub(page);
    const seeded = await ev(page, SEED([['ASH', [['Trio', ['Pikachu', 'Charizard', 'Snorlax']]]]]));
    await ev(page, STORE_JS(`const id = ${J(seeded[0].id)}; for (let i = 0; i < 4; i++) await store.recordMatch(id, Object.assign(${MATCH_JS({})}, { id: 'c' + i, at: 1800000000000 + i * 3600000 })); return true;`));
    await bootHub(page);
    await page.waitFor(`${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 1 && ${HUB}.data.profiles[0].record`, { timeoutMs: 15000 });
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    await padPress(page, 13); await padPress(page, 13); await padPress(page, 0);
    ok((await where(page)) === 'record', tag + 'D-pad down twice + A opens RECORD');
    await padPress(page, 15);
    ok((await rec(page)).index === 1, tag + 'D-pad right turns the page');
    await padPress(page, 13);
    ok((await rec(page)).index === 2, tag + 'with one trainer D-pad down turns the page too');
    for (let i = 0; i < 12; i++) await padPress(page, 15, 60);
    await padPress(page, 0);
    ok((await rec(page)).confirm !== null, tag + 'A on the last page asks YES / NO');
    await padPress(page, 1);
    ok((await rec(page)).confirm === null, tag + 'B answers NO');
    await padPress(page, 1);
    ok((await where(page)) === 'main', tag + 'B goes back to the menu');
    ok(errsOf(page).length === 0, tag + 'no console errors', errsOf(page).slice(0, 2).join(' | '));
  });
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
