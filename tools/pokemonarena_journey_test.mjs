// tools/pokemonarena_journey_test.mjs - the PLAYER JOURNEY, end to end, in a real headless Chrome, at three screen sizes.
//
//   node tools/pokemonarena_journey_test.mjs                       # all three viewports (starts PORT=8097 node tools/devserver.mjs itself)
//   ARENA_VP=phone,desk node tools/pokemonarena_journey_test.mjs   # a subset: phone (390x844 @3x touch), land (844x390 @3x touch), desk (1280x800 keyboard + mouse)
//   ARENA_PORT=8097 ARENA_CDP=9291 ARENA_OUT=<dir> ARENA_ROM=<gba> ARENA_BASE=<running server>
//
// THE JOURNEY (one fresh browser profile per viewport; real navigation between pages, nothing intercepted):
//   1 hub                      -> boots from the ROM, menu drawn
//   2 TEAM BUILDER             -> chosen on the hub menu (tap / click / keys), the editor opens
//   3 create a profile         -> the name is typed into the field, Create is tapped / clicked
//   4 build a 3-Pokemon team   -> each Pokemon found through the species search (typed), a nature, a held item, three more moves picked from the
//                                 move search, EVs typed into the number fields, an IV preset; the team is named. (Native <select> values are
//                                 set by script: a headless Chrome cannot open a native picker.)
//   5 save, RELOAD             -> the autosave indicator says Saved; after a real reload everything is read back from IndexedDB and compared
//   6 hub                      -> the editor's "Arena" link; BATTLE WITH MY TEAM shows the saved team; START
//   7 battle 1 (3v3, normal)   -> team preview picks, FIGHT / move / forced switches / text, all by REAL key presses or touch taps on the on-screen pad,
//                                 until the result screen; the team that fought is decoded from the address and compared with the saved one
//   8 REMATCH                  -> the same team, a fresh seed
//   9 forfeit, EDIT TEAM       -> RUN -> YES by real input, the result screen, EDIT TEAM opens the team builder on THAT team
//  10 back to the hub          -> the editor's Arena link
//  11 QUICK BATTLE 6v6         -> FORMAT changed to 6v6, START, the CPU plays the human seat to the end (the page's own autoplay hook), BACK TO HUB
// Screenshots of every step go to ARENA_OUT as j_<viewport>_<nn>_<step>.png and are meant to be opened and judged.
// Console / page errors anywhere in the journey fail it. AudioContext is a test double; nothing here can reach an audio device.
// Negative controls: the saved-team comparison, the battle-team comparison and the "no console errors" predicate are each run against a corrupted
// input and must fail.
import fs from 'node:fs';
import path from 'node:path';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, ROM_PATH, CDP0, BASE, sleep, mod, loadPct, key, errsOf, tapSel, clickSel, elementCentre, tapLogical, clickLogical, AUDIO_DOUBLE, addInit } = L;
const J = L.J;
const OUT = process.env.ARENA_OUT || L.DEFAULT_OUT;
const C = L.makeCounter('journey');
const ok = C.ok;
const TB = await mod('tables.js');
const RU = await mod('rules.js');
const TC = await mod('teamcode.js');
const ST = await mod('stats.js');
const rom = L.readRom();
const pack = TB.loadPack(rom, { verify: 'header', dexText: false });
const sup = RU.engineSupports(pack);
console.log('pokemonarena journey test; ROM', ROM_PATH, rom.length, 'B; node', process.version);

const VPS = [
  { name: 'phone', width: 390, height: 844, dpr: 3, mobile: true, touch: true },
  { name: 'land', width: 844, height: 390, dpr: 3, mobile: true, touch: true },
  { name: 'desk', width: 1280, height: 800, dpr: 1, mobile: false, touch: false },
].filter((v) => !process.env.ARENA_VP || process.env.ARENA_VP.split(',').includes(v.name));

/* ------------------------------------------------------------------------------------------------ the team to build */
const speciesId = (n) => pack.species.findIndex((s) => s && s.legal && s.name === n);
const R0 = RU.resolveRuleset(RU.DEFAULT_RULESET_ID);
// three Pokemon, their natures, items, wanted moves (the first that this ROM lets the species learn AND the engine can run are taken), EVs, IV preset
const PLAN = [
  { name: 'Pikachu', nature: 3, item: ['Leftovers', 'Sitrus Berry'], moves: ['Thunderbolt', 'Quick Attack', 'Iron Tail', 'Thunder Wave', 'Surf', 'Body Slam'], ev: { atk: 252, spe: 252 }, preset: null },
  { name: 'Charizard', nature: 10, item: ['Sitrus Berry', 'Lum Berry', 'Leftovers'], moves: ['Flamethrower', 'Dragon Claw', 'Earthquake', 'Air Slash', 'Fire Blast', 'Slash'], ev: { spa: 252, spe: 252 }, preset: 'zeroAtk' },
  { name: 'Snorlax', nature: 23, item: ['Lum Berry', 'Leftovers', 'Sitrus Berry'], moves: ['Body Slam', 'Earthquake', 'Rest', 'Crunch', 'Shadow Ball', 'Return'], ev: { hp: 252, def: 252 }, preset: null },
].map((m) => {
  const id = speciesId(m.name), rec = RU.blankRec(id, pack, RU.DEFAULT_RULESET_ID), pool = new Set(RU.legalMoves(pack, id, rec.level, R0));
  const moveOf = (n) => { const mv = pack.moves.find((x) => x && x.name === n); return mv && pool.has(mv.id) && sup.moves.has(mv.id) ? mv.id : null; };
  const chosen = []; for (const n of m.moves) { const mid = moveOf(n); if (mid !== null && !chosen.includes(mid) && !(rec.moves || []).includes(mid) && chosen.length < 3) chosen.push(mid); }
  const items = pack.items.filter((it) => m.item.includes(it.name) && sup.items.has(it.id));
  const item = m.item.map((n) => items.find((it) => it.name === n)).find(Boolean);
  return { ...m, id, chosen, firstMove: rec.moves[0], item };
});
// the item clause forbids duplicates: make the three choices distinct
{ const seen = new Set(); for (const m of PLAN) { const cands = m.item ? [m.item] : []; for (const n of ['Leftovers', 'Sitrus Berry', 'Lum Berry', 'Choice Band', 'Focus Sash', 'Life Orb']) { const it = pack.items.find((x) => x.name === n && sup.items.has(x.id)); if (it) cands.push(it); } m.item = cands.find((it) => !seen.has(it.id)); if (m.item) seen.add(m.item.id); } }
console.log('team plan: ' + PLAN.map((m) => m.name + ' (' + m.chosen.map((id) => pack.moves[id].name).join(', ') + '; ' + (m.item ? m.item.name : 'no item') + ')').join(' | '));
ok(PLAN.every((m) => m.id > 0 && m.chosen.length === 3 && m.item), 'journey setup: every planned Pokemon exists in this ROM with three extra legal, engine-supported moves and a held item', J(PLAN.map((m) => [m.name, m.chosen.length, !!m.item])));

/* ------------------------------------------------------------------------------------------------ comparison predicates (with controls) */
const canon = ST.canonicalJSON;
const mons = (profile, teamIx = 0) => { const t = profile.teams[teamIx]; return t.monIds.map((id) => profile.box.find((m) => m.id === id)); };
const monKey = (m) => canon({ species: m.species, nature: m.nature, abilitySlot: m.abilitySlot, heldItem: m.heldItem, moves: m.moves.map((x) => (typeof x === 'number' ? x : x.id)), ev: m.ev, iv: m.iv, level: m.level, nickname: m.nickname || '' });
const sameTeam = (a, b) => a.length === b.length && a.every((m, i) => monKey(m) === monKey(b[i]));
{
  const fake = PLAN.map((p) => ({ species: p.id, nature: p.nature, abilitySlot: 0, heldItem: p.item.id, moves: [{ id: p.firstMove, ppUps: 0 }, ...p.chosen.map((id) => ({ id, ppUps: 0 }))], ev: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, iv: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, level: 50, nickname: '' }));
  const twin = JSON.parse(JSON.stringify(fake)), bad = JSON.parse(JSON.stringify(fake)); bad[1].nature = (bad[1].nature + 1) % 25;
  const bad2 = JSON.parse(JSON.stringify(fake)); bad2[2].moves[1].id += 1;
  const bad3 = JSON.parse(JSON.stringify(fake)); bad3.reverse();
  ok(sameTeam(fake, twin) && !sameTeam(fake, bad) && !sameTeam(fake, bad2) && !sameTeam(fake, bad3) && !sameTeam(fake, fake.slice(0, 2)), 'journey control: the team comparison notices one changed nature, one changed move, a reordered team and a missing Pokemon (and accepts a clone)');
  const quiet = { errors: [], console: [] }, noisy = { errors: ['x'], console: [] }, noisy2 = { errors: [], console: [{ type: 'error', text: 'y' }] };
  ok(errsOf(quiet).length === 0 && errsOf(noisy).length === 1 && errsOf(noisy2).length === 1, 'journey control: the error predicate sees a page error and a console.error (and is quiet otherwise)');
}

/* ------------------------------------------------------------------------------------------------ helpers */
const HUB = '__arenaHub', BAT = '__arenaBattle';
const q = (s) => J(s);
let SHOT_N = 0;
const shot = async (page, vp, label) => { const f = path.join(OUT, `j_${vp.name}_${String(++SHOT_N).padStart(2, '0')}_${label}.png`); await page.screenshot(f); return f; };
const waitFor = (page, expr, ms = 90000) => page.waitFor(expr, { timeoutMs: ms });

// "tap or click" an element by selector, scrolling it into view first
async function actOn(page, vp, sel) {
  await page.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('no element ' + ${q(sel)}); e.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`);
  await sleep(60);
  return vp.touch ? tapSel(page, sel) : clickSel(page, sel);
}
// type into a text / number field: focus it with a real tap or click, select its content, insert the text, press Tab (commits a number field)
async function typeInto(page, vp, sel, text, { commit = true } = {}) {
  await actOn(page, vp, sel);
  await page.eval(`(() => { const e = document.querySelector(${q(sel)}); e.focus(); if (e.select) e.select(); return true; })()`);
  await page.send('Input.insertText', { text: String(text) });
  if (commit) { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); }
  await sleep(120);
}
// a real reload (Page.navigate to the same address with only a fragment would not reload)
async function reload(page) { await page.eval('window.__marker = 1; location.reload(); true'); await sleep(400); await page.waitFor('window.__marker === undefined && document.readyState === "complete"', { timeoutMs: 60000 }); }
const setSelect = (page, sel, v) => page.eval(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(String(v))}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

// the on-screen pad (touch) or the keyboard (desktop): ONE vocabulary
const DIRKEY = { up: 'up', down: 'down', left: 'left', right: 'right', a: 'a', b: 'b' };
async function press(page, vp, a) { if (vp.touch) await tapSel(page, `[data-btn="${a}"]`); else await key(page, DIRKEY[a], 40); }

/* ------------------------------------------------------------------------------------------------ the battle bot (real inputs only) */
async function playBattle(page, vp, label, { forfeit = false, maxMs = 420000 } = {}) {
  const t0 = Date.now(); let n = 0; const modes = {}; let last = '', same = 0, switches = 0, turns = 0, maxTurn = 0;
  const S = () => page.eval(`(() => { const a = ${BAT}; const S = a.scene.S; return { mode: a.mode, picks: S.preview ? S.preview.picks.slice() : null, pick: S.preview ? S.preview.pick : 0, pcur: S.preview ? S.preview.cursor : 0, cur: S.cursor, mc: S.moveCursor, nm: S.req && S.req.moves ? S.req.moves.length : 0, struggle: !!(S.req && S.req.struggle), ck: S.confirm ? S.confirm.kind : null, cc: S.confirm ? S.confirm.cursor : -1, turn: a.ctl.turn, rc: S.result ? S.result.cursor : -1 }; })()`);
  for (;;) {
    if (Date.now() - t0 > maxMs) throw new Error('battle bot timed out after ' + maxMs + ' ms in mode ' + last);
    const s = await S();
    modes[s.mode] = (modes[s.mode] || 0) + 1; maxTurn = Math.max(maxTurn, s.turn || 0);
    const sig = s.mode + s.turn + (s.picks ? s.picks.join() : '') + s.cur + s.mc;
    if (sig === last) same++; else { same = 0; last = sig; }
    if (s.mode === 'result') return { ms: Date.now() - t0, actions: n, modes, turns: maxTurn, switches };
    if (s.mode === 'preview') {
      const target = [...Array(8).keys()].find((i) => !s.picks.includes(i));
      if (s.pcur < target) await press(page, vp, 'down'); else if (s.pcur > target) await press(page, vp, 'up'); else await press(page, vp, 'a');
    } else if (s.mode === 'confirm') {
      if (s.ck === 'forfeit' && forfeit && s.cc === 1) await press(page, vp, 'up'); else await press(page, vp, 'a');
    } else if (s.mode === 'action') {
      if (forfeit) { if (s.cur === 3) await press(page, vp, 'a'); else if (s.cur === 0) await press(page, vp, 'down'); else if (s.cur === 1) await press(page, vp, 'down'); else await press(page, vp, 'right'); }
      else await press(page, vp, 'a');
    } else if (s.mode === 'moves') {
      const want = s.nm ? turns % s.nm : 0;
      if ((s.mc & 1) !== (want & 1)) await press(page, vp, 'right'); else if ((s.mc >> 1) !== (want >> 1)) await press(page, vp, 'down'); else { await press(page, vp, 'a'); turns++; }
    } else if (s.mode === 'party') { switches++; await press(page, vp, 'a'); }
    else if (s.mode === 'menu') await press(page, vp, 'b');
    else await press(page, vp, 'a');                                                     // typed text: A skips ahead
    n++;
    await sleep(vp.touch ? 40 : 30);
    if (same > 600) throw new Error('battle bot made no progress for 600 inputs in mode ' + s.mode);
  }
}

async function chooseResult(page, vp, index) {
  await page.waitFor(`${BAT}.scene.state().resultArmed`, { timeoutMs: 20000 });          // W1 D1: the result screen takes no choice until it has been readable (about 1.5 s)
  const s = await page.eval(`(() => ({ opts: ${BAT}.scene.S.result.options.slice(), cur: ${BAT}.scene.S.result.cursor, recap: !!${BAT}.scene.S.result.recap }))()`);
  if (vp.touch) {
    const r = await page.eval(`(() => { const g = ${BAT}.ui.resultRects(${BAT}.scene.S.result).options[${index}]; return { x: g.x + g.w / 2, y: g.y + g.h / 2 }; })()`);
    await tapLogical(page, `${BAT}.canvas`, r.x, r.y);
  } else {
    // the result ring is CYCLIC and, since ST1, has a RECAP chip at the far left (cursor -1) before the caller's options (0..n-1): n + 1 stops, and left of the first option is RECAP
    const lo = s.recap ? -1 : 0, span = s.opts.length - lo;
    let p = s.cur - lo; const t = index - lo;
    for (let g = 0; p !== t && g < 2 * span; g++) { const right = (t - p + span) % span <= span / 2; await press(page, vp, right ? 'right' : 'left'); p = (p + (right ? 1 : span - 1)) % span; }
    const land = await page.eval(`${BAT}.scene.S.result ? ${BAT}.scene.S.result.cursor : 'left the result'`);
    if (land !== index) throw new Error('chooseResult: the cursor is on ' + land + ', not on option ' + index + ' (' + s.opts[index] + '); the ring model is out of step with the scene');
    await press(page, vp, 'a');
  }
  return s.opts[index];
}

/* ------------------------------------------------------------------------------------------------ the journey */
async function journey(vp, port) {
  const tag = vp.name + ': ';
  console.log('--- journey at ' + vp.name + ' ' + vp.width + 'x' + vp.height + ' @' + vp.dpr + 'x' + (vp.touch ? ' touch' : ' keyboard+mouse') + ' ' + loadPct());
  SHOT_N = 0;
  await withBrowser({ port, width: vp.width, height: vp.height, mobile: vp.mobile }, async (page) => {
    await page.setViewport(vp.width, vp.height, { mobile: vp.mobile, dpr: vp.dpr });
    await addInit(page, AUDIO_DOUBLE);
    // hub rows are found by their ID, never by a position: the main menu has gained rows (IMPORT SAVE, then RECORD) and its pitch changes with the row count
    const rowY = (i) => 10 + i * 16 + 8;       // the FORMAT row of the 16 px QUICK BATTLE menu only (row 0)
    const hubRows = () => page.eval(`${HUB}.view().menu.rows.map((r) => r.id)`);
    const hubRowRect = async (id) => { const r = await page.eval(`(() => { const i = ${HUB}.view().menu.rows.findIndex((r) => r.id === ${JSON.stringify(id)}); return i < 0 ? null : ${HUB}.model.rects()[i]; })()`); if (!r) throw new Error('no hub row ' + id + ' in ' + JSON.stringify(await hubRows())); return r; };
    const hubRow = async (id) => { const r = await hubRowRect(id); const x = r.x + r.w / 2 - 20, y = r.y + r.h / 2; if (vp.touch) await tapLogical(page, `${HUB}.canvas`, x, y); else await clickLogical(page, `${HUB}.canvas`, x, y); };
    // keyboard: walk the cursor to the row (up or down, whichever way it is) and press A
    const hubKeys = async (id) => {
      const idx = (await hubRows()).indexOf(id); if (idx < 0) throw new Error('no hub row ' + id + ' in ' + JSON.stringify(await hubRows()));
      for (let g = 0; g < 14; g++) { const cur = await page.eval(`${HUB}.model.state().cursor[${HUB}.model.path()]`); if (cur === idx) break; await key(page, cur < idx ? 'down' : 'up'); }
      await key(page, 'a');
    };
    const hubPick = async (id) => { if (vp.touch) await hubRow(id); else await hubKeys(id); };

    // ---- 1 hub
    await page.navigate(BASE + '/pokemonarena/');
    await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
    await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
    ok((await hubRows()).join() === 'quick,team,record,builder,import,controls,sound,about', tag + '1 hub: the main menu has its eight rows (IMPORT SAVE and RECORD included)', JSON.stringify(await hubRows()));
    await shot(page, vp, 'hub_main');

    // ---- 2 TEAM BUILDER from the menu (a mix of devices on the desktop run: keys, then the mouse)
    await hubPick('builder');
    await waitFor(page, 'window.__editor && (window.__editor.ready || window.__editor.error)');
    ok(/\/pokemonarena\/editor\.html/.test(await page.eval('location.pathname')) && (await page.eval('__editor.ready')) === true, tag + '2 TEAM BUILDER on the hub menu opens the team editor', await page.eval('location.pathname'));
    await shot(page, vp, 'editor_profiles_empty');

    // ---- 3 create a profile (typed name, tapped / clicked button)
    await typeInto(page, vp, '[data-fk="new-name"]', 'ASH', { commit: false });
    await shot(page, vp, 'editor_name_typed');
    await actOn(page, vp, '[data-act="create"]');
    await waitFor(page, '__editor.state() && __editor.route().name === "teams"', 20000);
    ok((await page.eval('__editor.state().profile.trainerName')) === 'ASH', tag + '3 the profile ASH was created (the typed name arrived)', await page.eval('__editor.state().profile.trainerName'));
    await shot(page, vp, 'editor_teams_empty');

    // ---- 4 build a three-Pokemon team
    await actOn(page, vp, '[data-act="new-team"]');
    await waitFor(page, '__editor.route().name === "team"', 20000);
    const teamId = await page.eval('__editor.route().teamId');
    await typeInto(page, vp, '[data-fk="team-name"]', 'Kanto Squad');
    for (const m of PLAN) {
      await actOn(page, vp, '[data-act="add-mon"]');
      await waitFor(page, '!!document.querySelector("[data-fk=sp-q]")', 20000);
      await typeInto(page, vp, '[data-fk="sp-q"]', m.name, { commit: false });
      await waitFor(page, `!!document.querySelector('.vrow[data-species="${m.id}"]')`, 20000);
      if (m === PLAN[0]) await shot(page, vp, 'editor_species_search');
      await actOn(page, vp, `.vrow[data-species="${m.id}"]`);
      await waitFor(page, '__editor.route().name === "mon"', 20000);
      await setSelect(page, '[data-fk="nature"]', m.nature);
      // held item
      await actOn(page, vp, '[data-act="pick-item"]');
      await waitFor(page, '!!document.querySelector("[data-fk=it-q]")', 20000);
      await typeInto(page, vp, '[data-fk="it-q"]', m.item.name, { commit: false });
      await waitFor(page, `!!document.querySelector('[data-item="${m.item.id}"]')`, 20000);
      await actOn(page, vp, `[data-item="${m.item.id}"]`);
      await waitFor(page, `__editor.state().profile.box.find((x) => x.species === ${m.id}).heldItem === ${m.item.id}`, 20000);
      // three more moves
      await page.eval(`location.hash = '#/team/${teamId}/mon/' + __editor.route().monId + '/moves'`); await sleep(250);
      for (let k = 0; k < m.chosen.length; k++) {
        await actOn(page, vp, `[data-act="pick-move"][data-slot="${k + 1}"]`);
        await waitFor(page, '!!document.querySelector("[data-fk=mv-q]")', 20000);
        await typeInto(page, vp, '[data-fk="mv-q"]', pack.moves[m.chosen[k]].name, { commit: false });
        await waitFor(page, `!!document.querySelector('.mvrow[data-move="${m.chosen[k]}"]')`, 20000);
        if (m === PLAN[0] && k === 0) await shot(page, vp, 'editor_move_search');
        await actOn(page, vp, `.mvrow[data-move="${m.chosen[k]}"]`);
        await waitFor(page, `__editor.state().profile.box.find((x) => x.species === ${m.id}).moves.length === ${k + 2}`, 20000);
      }
      // EVs typed, IV preset tapped
      await page.eval(`location.hash = '#/team/${teamId}/mon/' + __editor.route().monId + '/stats'`);
      await waitFor(page, '!!document.querySelector("[data-fk=ev-atk]")', 20000);
      for (const [stat, v] of Object.entries(m.ev)) await typeInto(page, vp, `[data-fk="ev-${stat}"]`, v);
      if (m.preset) await actOn(page, vp, `[data-preset="${m.preset}"]`);
      if (m === PLAN[0]) await shot(page, vp, 'editor_stats');
      await waitFor(page, `(() => { const x = __editor.state().profile.box.find((y) => y.species === ${m.id}); return ${J(Object.entries(m.ev))}.every(([k, v]) => x.ev[k] === v); })()`, 20000);
      await page.eval(`location.hash = '#/team/${teamId}'`); await sleep(250);
    }
    const built = await page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
    ok(built.teams[0].name === 'Kanto Squad' && built.teams[0].monIds.length === 3, tag + '4 the team "Kanto Squad" has three Pokemon', J(built.teams[0]));
    const bm = mons(built);
    ok(bm.every((m, i) => m.species === PLAN[i].id && m.nature === PLAN[i].nature && m.heldItem === PLAN[i].item.id && m.moves.length === 4 && Object.entries(PLAN[i].ev).every(([k, v]) => m.ev[k] === v)) && bm[1].iv.atk === 0, tag + '4 species, natures, items, four moves each, typed EVs and the IV preset are all in the profile', J(bm.map((m) => [m.species, m.nature, m.heldItem, m.moves.length, m.ev, m.iv.atk])).slice(0, 300));
    await waitFor(page, `document.getElementById('saveText').textContent === 'Saved' && __editor.saveState === 'saved'`, 20000);
    ok(true, tag + '5 the header says "Saved"');
    await shot(page, vp, 'editor_team_built');

    // ---- 5 RELOAD: read everything back from IndexedDB
    await reload(page);
    await waitFor(page, 'window.__editor && __editor.ready');
    const after = await page.eval('JSON.parse(JSON.stringify(__editor.state().profile))');
    ok(after.trainerName === 'ASH' && after.teams.length === 1 && sameTeam(mons(after), bm), tag + '5 RELOAD: the profile, the team and every Pokemon come back identical from IndexedDB');
    ok((await page.eval('__editor.route().name')) === 'team' && (await page.eval('__editor.route().teamId')) === teamId, tag + '5 RELOAD: the editor reopens on the same team screen');
    await shot(page, vp, 'editor_after_reload');

    // ---- 6 hub via the editor's Arena link; BATTLE WITH MY TEAM
    await actOn(page, vp, '#backLink');
    await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
    ok((await page.eval('location.pathname')) === '/pokemonarena/', tag + '6 the editor\'s "Arena" link returns to the hub', await page.eval('location.pathname'));
    await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
    await waitFor(page, `${HUB}.data && ${HUB}.data.profiles && ${HUB}.data.profiles.length === 1`, 15000);
    await hubRow('team'); await sleep(300);
    ok((await page.eval(`${HUB}.model.path()`)) === 'team' && (await page.eval(`${HUB}.view().menu.rows.find((r) => r.id === 'teamsel').value`)) === 'Kanto Squad', tag + '6 BATTLE WITH MY TEAM lists the saved team "Kanto Squad"');
    ok((await page.eval(`${HUB}.view().menu.rows.find((r) => r.id === 'format').value`)) === '3v3', tag + '6 a three-Pokemon team starts on 3v3');
    ok((await page.eval(`${HUB}.view().mascot.species`)) === PLAN[0].id, tag + '6 the team lead (Pikachu) stands on the hub');
    await shot(page, vp, 'hub_my_team');
    // START (the row with id 'start' of TEAM / FORMAT / CPU / START / BACK)
    await hubPick('start');
    await waitFor(page, `window.${BAT} && ${BAT}.state !== 'boot'`);
    ok((await page.eval(`${BAT}.state`)) === 'ready' && /\/pokemonarena\/battle\.html/.test(await page.eval('location.pathname')), tag + '6 START opens battle.html and it reaches ready', await page.eval(`${BAT}.state + ' ' + ${BAT}.error`));
    const par = await page.eval(`({ team: ${BAT}.params.team, format: ${BAT}.params.format, cpu: ${BAT}.params.cpu, seed: ${BAT}.seed, quick: ${BAT}.params.quick, opts: ${BAT}.resultOptions })`);
    const dec = await TC.decodeTeamCode(par.team, {});
    ok(dec.ok && dec.team.name === 'Kanto Squad' && sameTeam(dec.team.mons.map((m) => ({ ...m, moves: m.moves.map((x) => x.id) })), bm), tag + '7 the team in the battle address decodes to EXACTLY the team that was built (names, natures, items, moves, EVs, IVs)');
    ok(J(par.opts) === J(['REMATCH', 'EDIT TEAM', 'BACK TO HUB']) && par.format === '3v3' && par.cpu === 'normal' && par.quick === false, tag + '7 a battle with a team offers REMATCH / EDIT TEAM / BACK TO HUB; 3v3 against the normal CPU', J(par));
    await waitFor(page, `${BAT}.mode === 'preview'`, 20000);
    await sleep(300);
    await shot(page, vp, 'battle_preview');

    // ---- 7 battle 1: real inputs to a result
    const r1 = await playBattle(page, vp, 'battle 1');
    console.log('  ' + vp.name + ' battle 1: ' + r1.ms + ' ms, ' + r1.actions + ' inputs, ' + r1.turns + ' turns, ' + r1.switches + ' forced-switch inputs, modes ' + J(r1.modes) + '; ' + loadPct());
    const won = await page.eval(`${BAT}.ctl.winner`);
    ok(r1.turns >= 3 && won !== null && (won === 0 || won === 1 || won === -1), tag + '7 battle 1 played to a result with real inputs (' + r1.turns + ' turns, winner side ' + won + ', ' + r1.actions + ' inputs)');
    ok(r1.modes.moves > 0 && r1.modes.action > 0 && r1.modes.preview > 0 && r1.modes.steps > 0, tag + '7 the bot really went through preview, action, moves and message screens', J(r1.modes));
    await page.eval(`${BAT}.pause(true)`); await sleep(120);
    ok((await page.eval(`${BAT}.scene.S.result.head.join(' ')`)).length > 4 && /^[\x20-\x7e]+$/.test(await page.eval(`${BAT}.scene.S.result.head.join(' ')`)), tag + '7 the result screen shows the ROM\'s own line: "' + await page.eval(`${BAT}.scene.S.result.head.join(' ')`) + '"');
    await shot(page, vp, 'battle1_result');
    await page.eval(`${BAT}.pause(false)`);

    // ---- 8 REMATCH
    const seed1 = par.seed;
    const picked = await chooseResult(page, vp, 0);
    ok(picked === 'REMATCH', tag + '8 option 0 is REMATCH', picked);
    await waitFor(page, `window.${BAT} && ${BAT}.state === 'ready' && ${BAT}.seed !== ${seed1}`, 60000);
    const par2 = await page.eval(`({ team: ${BAT}.params.team, seed: ${BAT}.seed, mode: ${BAT}.mode })`);
    ok(par2.team === par.team && par2.seed !== seed1, tag + '8 REMATCH reloads the SAME team with a fresh seed (' + seed1 + ' -> ' + par2.seed + ')');
    await waitFor(page, `${BAT}.mode === 'preview'`, 20000);

    // ---- 9 forfeit with real input, then EDIT TEAM
    const r2 = await playBattle(page, vp, 'battle 2 (forfeit)', { forfeit: true });
    ok((await page.eval(`${BAT}.ctl.winner`)) === 1, tag + '9 RUN -> YES forfeits: the CPU wins', await page.eval(`${BAT}.ctl.winner`));
    await page.eval(`${BAT}.pause(true)`); await sleep(120);
    await shot(page, vp, 'battle2_forfeit_result');
    await page.eval(`${BAT}.pause(false)`);
    const edit = await chooseResult(page, vp, 1);
    ok(edit === 'EDIT TEAM', tag + '9 option 1 is EDIT TEAM', edit);
    await waitFor(page, 'window.__editor && (__editor.ready || __editor.error)', 60000);
    await sleep(500);
    ok((await page.eval('location.pathname')) === '/pokemonarena/editor.html' && (await page.eval('__editor.route().name')) === 'team' && (await page.eval('__editor.route().teamId')) === teamId, tag + '9 EDIT TEAM opens the team builder on THE team that fought (route team ' + teamId + ')', await page.eval('location.pathname + location.hash'));
    await shot(page, vp, 'editor_after_edit_team');

    // ---- 10 back to the hub
    await actOn(page, vp, '#backLink');
    await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`);
    ok((await page.eval('location.pathname')) === '/pokemonarena/', tag + '10 back at the hub');

    // ---- 11 QUICK BATTLE 6v6, CPU plays the human seat, BACK TO HUB
    await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
    await hubRow('quick'); await sleep(250);
    ok((await page.eval(`${HUB}.model.path()`)) === 'quick', tag + '11 QUICK BATTLE opens');
    if (vp.touch) await tapLogical(page, `${HUB}.canvas`, 120, rowY(0)); else await key(page, 'right');
    await sleep(150);
    ok((await page.eval(`${HUB}.view().menu.rows[0].value`)) === '6v6', tag + '11 FORMAT is now 6v6');
    await shot(page, vp, 'hub_quick_6v6');
    await hubPick('start');
    await waitFor(page, `window.${BAT} && ${BAT}.state !== 'boot'`);
    const par3 = await page.eval(`({ state: ${BAT}.state, format: ${BAT}.params.format, cpu: ${BAT}.params.cpu, quick: ${BAT}.params.quick, team: ${BAT}.params.team, opts: ${BAT}.resultOptions })`);
    ok(par3.state === 'ready' && par3.format === '6v6' && par3.quick === true && par3.team === null && J(par3.opts) === J(['REMATCH', 'NEW BATTLE', 'BACK TO HUB']), tag + '11 the Quick Battle (6v6, random teams) offers REMATCH / NEW BATTLE / BACK TO HUB', J(par3));
    await shot(page, vp, 'battle3_quick_start');
    const ap = await page.eval(`${BAT}.autoplay(600000, 'normal')`);
    ok(ap.mode === 'result' && ap.winner !== null && ap.turns >= 3, tag + '11 the 6v6 Quick Battle ran to a result with the CPU in the human seat (' + ap.turns + ' turns)', J(ap));
    await page.eval(`${BAT}.pause(true)`); await sleep(120);
    await shot(page, vp, 'battle3_quick_result');
    await page.eval(`${BAT}.pause(false)`);
    const back = await chooseResult(page, vp, 2);
    ok(back === 'BACK TO HUB', tag + '11 option 2 is BACK TO HUB', back);
    try { await waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`, 60000); }
    catch (e) {      // say WHERE the page is and what it reports, instead of a bare timeout
      const where = await page.eval(`JSON.stringify({ href: location.href, ready: document.readyState, hub: window.${HUB} ? { state: ${HUB}.state, error: ${HUB}.error || null } : null, bat: window.${BAT} ? { state: ${BAT}.state, mode: ${BAT}.mode, choice: ${BAT}.resultChoice || null, career: ${BAT}.career ? { state: ${BAT}.career.state, error: ${BAT}.career.error } : null } : null, err: document.getElementById('error') ? !document.getElementById('error').hidden : null })`).catch((x) => 'page not reachable: ' + x);
      throw new Error('after BACK TO HUB the hub never became ready; page: ' + where + '; page errors: ' + JSON.stringify(errsOf(page).slice(0, 5)));
    }
    ok((await page.eval('location.pathname')) === '/pokemonarena/', tag + '11 BACK TO HUB lands on the hub');
    await page.eval(`${HUB}.pause(true); ${HUB}.setMascot(25)`);
    await shot(page, vp, 'hub_final');

    // ---- the whole journey: no errors, no real audio
    const errs = errsOf(page);
    ok(errs.length === 0, tag + 'the whole journey raised no page errors and no console errors', errs.slice(0, 3).join(' | '));
    const lg = await page.eval('window.__audioLog');
    ok(lg.ctor === 0 && lg.start === 0, tag + 'sound stayed off: no AudioContext was created and nothing started (the double counted ' + J(lg) + ')');
  });
}

let server = null;
try {
  console.log('before the browser: ' + loadPct() + '; reaping leaked browsers');
  L.reapLeaks();
  server = await L.startServer();
  console.log('dev server up on ' + BASE + ' (node tools/devserver.mjs, Range-capable)');
  fs.mkdirSync(OUT, { recursive: true });
  let port = CDP0;
  for (const vp of VPS) { try { await journey(vp, port++); } catch (e) { ok(false, vp.name + ': the journey threw', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); } }
} finally {
  L.stopServer(server);
  L.reapLeaks();
}
C.finish();
