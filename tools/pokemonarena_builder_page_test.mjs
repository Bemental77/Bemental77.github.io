// tools/pokemonarena_builder_page_test.mjs -- THE TEAM BUILDER in the hub's picture, in a real (headless, muted, throwaway-profile) Chrome with real IndexedDB, driven only through what a
// player has: real key events, taps on the picture and on the on-screen pad, a (synthetic) controller. The state is READ through window.__arenaHub; nothing is ever done through a DOM
// control a player does not have. The Node side (the model action by action, the ctl against a memory store, the renderer, the mutants) is tools/pokemonarena_builder_test.mjs.
//
//   node tools/pokemonarena_builder_page_test.mjs            every session
//   node tools/pokemonarena_builder_page_test.mjs keys       one session: keys | touch | pad
//   ARENA_PORT / ARENA_CDP (default 8097 / 9291; this track runs on 8541 / 9741), ARENA_OUT (a folder for screenshots), ARENA_BASE (a server that is already running)
//
// SESSIONS
//   keys    a desktop with a keyboard: from an EMPTY browser a trainer is made, a team, SIX Pokemon found by name; one of them gets a level, a nature, an ability, an item and a nickname; the
//           autosave tag reaches SAVED; the page is RELOADED and the team is found saved (in IndexedDB, read by the game's own store module) and on the screen; the hub's BATTLE WITH MY TEAM
//           offers it. The canvas shows exactly what the model's view renders
//   touch   a phone (touch only): taps on the picture and the on-screen pad's d-pad / A / B. Everything a keyboard reaches with L / R / START / X / Y is reached by a chip or a row: the MENU
//           chips, FILTER and its FIND row, the page chips, the tab chips, the in-picture keyboard's keys
//   pad     a synthetic controller alone: the d-pad, A, B, X, Y, L, R, START, SELECT
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { root, J, sleep, errsOf, tapLogical, tapSel, padPress, AUDIO_DOUBLE, PAD_DOUBLE, addInit, BASE, CDP0, loadPct } = L;
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wants = (s) => !ARGS.length || ARGS.includes(s);
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-builder-shots');
fs.mkdirSync(OUT, { recursive: true });
const C = L.makeCounter('builder page');
const ok = C.ok;
const HUB = '__arenaHub';
const T = await L.mod('tables.js');
const pack = T.loadPack(L.readRom(), { verify: 'header', dexText: false });
const sid = (name) => pack.species.findIndex((s) => s && s.legal && s.name === name);
console.log('pokemonarena builder page test; server', BASE, 'CDP from', CDP0, loadPct());

/* ------------------------------------------------------------------------------------------------ reading the page */
const st = (page) => page.eval(`${HUB}.model.state().apps.builder`);
const b = (page) => page.eval(`${HUB}.view().builder`);
const where = (page) => page.eval(`${HUB}.model.path()`);
const waitFor = (page, expr, ms = 30000) => page.waitFor(expr, { timeoutMs: ms });
const waitPath = (page, p) => waitFor(page, `${HUB}.model.path() === ${J(p)}`);
const waitReady = (page) => waitFor(page, `window.${HUB} && ${HUB}.state === 'ready'`, 90000);
const waitBuilder = (page) => waitFor(page, `${HUB}.model.state().apps.builder.phase === 'ready'`);
const waitTag = (page, tag) => waitFor(page, `${HUB}.model.state().apps.builder.tag === ${J(tag)}`);
const settle = async (page) => { await page.eval(`${HUB}.apps.idle('builder')`); await sleep(60); };
const shot = (page, name) => page.screenshot(path.join(OUT, name + '.png')).catch(() => {});
/** The stored profiles, read from this browser's IndexedDB by the game's own store module (what any page of the game would find). */
const stored = (page) => page.eval(`(async () => { const S = await import('/pokemonarena/js/store.js'); const s = await S.openStore(); const out = []; for (const r of await s.listProfiles()) { const l = await s.loadProfile(r.id); if (l.ok) out.push(l.profile); } const active = await s.getActiveId(); await s.close(); return { active, profiles: out }; })()`);
const faults = (page) => page.eval(`({ app: ${HUB}.appFaults || [], render: ${HUB}.renderError || null, loop: ${HUB}.loopError || null, ctl: ${HUB}.apps.errors() })`);
const clean = (f) => f.app.length === 0 && !f.render && !f.loop && Object.keys(f.ctl).length === 0;
const same = (page) => page.eval(`${HUB}.canvasHash() === ${HUB}.frameHash()`);

/* ------------------------------------------------------------------------------------------------ a keyboard */
const KEY = {
  up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  a: ['Enter', 'Enter', 13], b: ['Escape', 'Escape', 27], x: ['c', 'KeyC', 67], y: ['v', 'KeyV', 86], l: ['q', 'KeyQ', 81], r: ['e', 'KeyE', 69], start: ['p', 'KeyP', 80], select: ['i', 'KeyI', 73],
};
const key = async (page, k, n = 1) => { for (let i = 0; i < n; i++) { await page.press(KEY[k][0], KEY[k][1], KEY[k][2], 30); await sleep(45); } };
/** Type a word on the REAL keyboard (key events, as a person types), then Enter. */
async function typeWord(page, word, enter = true) {
  for (const ch of word) {
    const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : 'Unidentified', vk = ch.toUpperCase().charCodeAt(0);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
    await sleep(25);
  }
  if (enter) { await page.press('Enter', 'Enter', 13, 30); await sleep(80); }
}
/** Walk the open list's cursor to the row with this id, with the given "down" gesture. */
async function toRow(page, id, down) {
  for (let i = 0; i < 40; i++) {
    const cur = await page.eval(`(() => { const m = ${HUB}.view().menu; return m && m.rows[m.cursor] ? m.rows[m.cursor].id : null; })()`);
    if (cur === id) return true;
    await down();
  }
  return false;
}
async function toPop(page, id, down) {
  for (let i = 0; i < 12; i++) {
    const cur = await page.eval(`(() => { const p = ${HUB}.view().builder.popup; return p ? p.rows[p.cursor].id : null; })()`);
    if (cur === id) return true;
    await down();
  }
  return false;
}
/** The team screen's cursor to slot i (two columns of three over the chips), with the d-pad. */
async function toSlot(page, i, press) {
  for (let g = 0; g < 12; g++) {
    const c = (await st(page)).screens['builder-team'].cursor;
    if (c === i) return true;
    if (c >= 6) await press('up');
    else if ((c % 2) !== (i % 2)) await press('right');
    else await press(Math.floor(c / 2) < Math.floor(i / 2) ? 'down' : 'up');
  }
  return false;
}

async function session(name, opts, fn) {
  console.log('--- ' + name + ' (' + opts.width + 'x' + opts.height + (opts.mobile ? ' mobile' : '') + ') ' + loadPct());
  try {
    await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
      await page.setViewport(opts.width, opts.height, { mobile: !!opts.mobile, dpr: opts.dpr || 1 });
      await addInit(page, AUDIO_DOUBLE);
      if (opts.pad) await addInit(page, PAD_DOUBLE);
      await fn(page);
    });
  } catch (e) { ok(false, name + ': the session threw', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
const openHub = async (page, hash = '') => { await page.navigate(BASE + '/pokemonarena/' + hash); await waitReady(page); await page.eval(`${HUB}.setMascot(25)`); };
const reload = async (page) => { await page.eval('window.__marker = 1; location.reload(); true'); await sleep(400); await page.waitFor('window.__marker === undefined && document.readyState === "complete"', { timeoutMs: 60000 }); await waitReady(page); };

const server = await L.startServer('/pokemonarena/');
let cdp = CDP0;
try {
  /* ============================================================================================== keys: a full legal team from an empty browser, reload, saved */
  if (wants('keys')) await session('keyboard: build a full team from nothing, reload, find it saved', { width: 1280, height: 800, port: cdp++ }, async (page) => {
    const tag = 'keys: ';
    const TEAM = ['Pikachu', 'Charizard', 'Snorlax', 'Gengar', 'Lapras', 'Dragonite'];
    await openHub(page);
    const empty = await stored(page);
    ok(empty.profiles.length === 0 && empty.active === null, tag + 'the browser starts with no profile at all (a throwaway Chrome profile)', J(empty.active));
    // the main menu's TEAM BUILDER row
    for (let i = 0; i < 12; i++) { const id = await page.eval(`(() => { const m = ${HUB}.view().menu; return m.rows[m.cursor].id; })()`); if (id === 'builder') break; await key(page, 'down'); }
    await key(page, 'a'); await waitPath(page, 'builder'); await waitBuilder(page);
    ok((await page.eval('location.hash')) === '#builder' && /Team Builder/.test(await page.eval('document.title')) && (await b(page)).kind === 'trainers', tag + 'TEAM BUILDER opens the trainers screen in the picture (#builder; the same page)', await page.eval('location.pathname + location.hash'));
    ok((await page.eval(`${HUB}.apps.loaded().includes('builder')`)) && clean(await faults(page)), tag + 'the builder\'s ctl loaded (and with it the kit) and nothing faulted', J(await faults(page)));
    await shot(page, 'keys_01_trainers_none');
    // NEW TRAINER, typed on the real keyboard
    await key(page, 'a'); await waitFor(page, `${HUB}.wantsText()`);
    await typeWord(page, 'Ash'); await waitPath(page, 'builder-teams');
    ok((await st(page)).tag === 'SAVED' && /ASH|Ash/.test((await b(page)).title) && (await page.eval('location.hash')) === '#builder-teams', tag + 'a trainer typed on the real keyboard is made and its (empty) teams are shown', (await b(page)).title);
    // NEW TEAM
    await key(page, 'a'); await waitPath(page, 'builder-team');
    ok((await b(page)).title === 'TEAM 1' && (await b(page)).status.text === 'EMPTY', tag + 'NEW TEAM opens TEAM 1, empty');
    // six Pokemon, each found by its name
    for (let i = 0; i < TEAM.length; i++) {
      await toSlot(page, i, (k) => key(page, k));
      await key(page, 'a'); await waitPath(page, 'builder-species');
      if (i === 0) { ok((await b(page)).list.total > 1000 && (await same(page)), tag + 'an empty slot opens the species picker (' + (await b(page)).list.total + ' Pokemon; the canvas shows the frame the view renders)'); await shot(page, 'keys_02_species'); }
      await key(page, 'start'); await waitFor(page, `${HUB}.wantsText()`);
      await typeWord(page, TEAM[i].toLowerCase()); await waitPath(page, 'builder-mon');
      if (i === 0) await shot(page, 'keys_03_mon');
      await key(page, 'b'); await waitPath(page, 'builder-team');
    }
    const full = await b(page);
    ok(full.slots.every((s, i) => !s.empty && s.name === TEAM[i]) && full.status.text === 'LEGAL', tag + 'six Pokemon were added through the picture, each found by typing its name: ' + full.slots.map((s) => s.name).join(', ') + ' (' + full.status.text + ')', J(full.slots.map((s) => s.name)));
    await shot(page, 'keys_04_team_full');
    // one of them is edited: level, nature, ability, item, nickname
    await toSlot(page, 0, (k) => key(page, k)); await key(page, 'a'); await key(page, 'a'); await waitPath(page, 'builder-mon');
    const down = () => key(page, 'down');
    await toRow(page, 'level', down); await key(page, 'left', 3);
    await toRow(page, 'nature', down); await key(page, 'right', 2);
    await toRow(page, 'ability', down); await key(page, 'right');
    await toRow(page, 'item', down); await key(page, 'a'); await waitPath(page, 'builder-item'); await key(page, 'down', 3);
    const itemName = await page.eval(`(() => { const m = ${HUB}.view().menu; return m.rows[m.cursor].label; })()`);
    await key(page, 'a'); await waitPath(page, 'builder-mon');
    await toRow(page, 'nickname', down); await key(page, 'a'); await waitFor(page, `${HUB}.wantsText()`); await typeWord(page, 'Sparky');
    await waitTag(page, 'SAVED'); await settle(page);
    await shot(page, 'keys_05_mon_edited');
    const mid = await stored(page), p1 = mid.profiles[0], t1 = p1 && p1.teams[0], lead = p1 && p1.box.find((m) => m.id === t1.monIds[0]);
    ok(mid.profiles.length === 1 && p1.trainerName === 'Ash' && mid.active === p1.id && t1.monIds.length === 6 && J(t1.monIds.map((id) => p1.box.find((m) => m.id === id).species)) === J(TEAM.map(sid)),
      tag + 'the autosave tag reached SAVED and IndexedDB holds the trainer Ash with the team of six, in order', J(t1 && t1.monIds.length));
    const item = pack.items.find((it) => it && it.name === itemName);
    ok(lead && lead.level === 97 && lead.nature === 2 && lead.nickname === 'Sparky' && item && lead.heldItem === item.id && lead.abilitySlot !== 0, tag + 'the edits of the first Pokemon are stored: level 97, nature 2, another ability, ' + itemName + ', nicknamed Sparky', J(lead && { l: lead.level, n: lead.nature, a: lead.abilitySlot, i: lead.heldItem, k: lead.nickname }));
    const hubTeam = await page.eval(`${HUB}.data.profiles[0].teams[0]`);
    ok(hubTeam && hubTeam.size === 6 && hubTeam.legal === true && hubTeam.names[0] === 'Sparky', tag + 'the hub was told after the save: its own team list has the team, six strong and legal', J(hubTeam));
    // RELOAD: a real reload of the page, at the Pokemon's address
    const before = J(p1.box.map((m) => [m.species, m.level, m.nature, m.heldItem, m.nickname]));
    await reload(page); await waitBuilder(page); await settle(page);
    const after = await stored(page), p2 = after.profiles[0];
    ok(after.profiles.length === 1 && J(p2.box.map((m) => [m.species, m.level, m.nature, m.heldItem, m.nickname])) === before && p2.teams[0].monIds.length === 6, tag + 'RELOAD: the profile read back from IndexedDB is the team that was built');
    ok((await where(page)) === 'builder-mon' && (await b(page)).title === 'Sparky' && (await b(page)).mon.level === 97 && (await page.eval('location.hash')) === '#builder-mon', tag + 'RELOAD: the picture comes back on the same Pokemon (the tab keeps its focus)', (await where(page)) + ' ' + J((await b(page)).title));
    await key(page, 'b'); await waitPath(page, 'builder-team');
    const again = await b(page);
    ok(again.slots.map((s) => s.name).join() === ['Sparky', ...TEAM.slice(1)].join() && again.status.text === 'LEGAL' && again.tag.text === 'SAVED' && (await same(page)), tag + 'RELOAD: the team screen shows the six again, LEGAL and SAVED', again.slots.map((s) => s.name).join());
    await shot(page, 'keys_06_after_reload');
    // back to the main menu: B walks the trail, and BATTLE WITH MY TEAM offers the team
    await key(page, 'b'); await waitPath(page, 'builder-teams'); await key(page, 'b'); await waitPath(page, 'builder'); await key(page, 'b'); await waitPath(page, 'main');
    ok((await page.eval('location.hash')) === '' && (await page.eval(`${HUB}.trail().length`)) === 0, tag + 'B walks back up to the main menu (the address follows)');
    for (let i = 0; i < 12; i++) { const id = await page.eval(`(() => { const m = ${HUB}.view().menu; return m.rows[m.cursor].id; })()`); if (id === 'team') break; await key(page, 'up'); }
    await key(page, 'a'); await waitPath(page, 'team');
    const rows = await page.eval(`${HUB}.view().menu.rows`);
    ok(rows.some((r) => r.id === 'teamsel' && r.value === 'TEAM 1') && rows.some((r) => r.id === 'start' && !r.disabled), tag + 'BATTLE WITH MY TEAM offers TEAM 1 and START is enabled (the team is legal)', J(rows.map((r) => r.id + '=' + r.value)));
    ok(clean(await faults(page)) && errsOf(page).length === 0, tag + 'no fault and no console error in the whole session', J(await faults(page)) + ' ' + errsOf(page).slice(0, 2).join(' | '));
  });

  /* ============================================================================================== touch: a phone, taps and the on-screen pad only */
  if (wants('touch')) await session('touch phone: everything by taps and the on-screen pad', { width: 390, height: 844, mobile: true, dpr: 2, port: cdp++ }, async (page) => {
    const tag = 'touch: ';
    const tap = async (x, y) => { await tapLogical(page, `${HUB}.canvas`, x, y); await sleep(140); };
    const tapRect = async (expr) => { const r = await page.eval(expr); if (!r) throw new Error('nothing to tap: ' + expr); await tap(r.x + Math.min(r.w / 2, 30), r.y + r.h / 2); return r; };
    const pad = async (k) => { await tapSel(page, `[data-btn="${k}"]`); await sleep(120); };
    const rowRect = (id) => `(() => { const m = ${HUB}.view().menu, i = m.rows.findIndex((r) => r.id === ${J(id)}); return i < 0 ? null : ${HUB}.model.rects()[i]; })()`;
    const chipRect = (id) => `(${HUB}.view().builder.chips || []).find((c) => c.id === ${J(id)}) || null`;
    const popRect = (id) => `(() => { const p = ${HUB}.view().builder.popup; if (!p) return null; const i = p.rows.findIndex((r) => r.id === ${J(id)}); return i < 0 ? null : ${HUB}.model.rects()[i]; })()`;
    const keyRect = (id) => `${HUB}.model.rects().find((k) => k.id === ${J(id)}) || null`;
    const tapWord = async (word) => { for (const ch of word) await tapRect(keyRect(ch)); await tapRect(keyRect('ok')); };
    await openHub(page);
    ok((await page.eval(`document.querySelectorAll('[data-btn]').length`)) === 6 && (await page.eval(`[...document.querySelectorAll('[data-btn]')].map((e) => e.dataset.btn).sort().join()`)) === 'a,b,down,left,right,up', tag + 'the on-screen pad has the d-pad, A and B and nothing else (so every other function needs a chip or a row)');
    // the main menu: a tap on TEAM BUILDER
    await tapRect(rowRect('builder')); await waitPath(page, 'builder'); await waitBuilder(page);
    await tapRect(rowRect('new')); await waitFor(page, `${HUB}.wantsText()`);
    await shot(page, 'touch_01_entry');
    await tapWord('RED'); await waitPath(page, 'builder-teams');
    ok((await st(page)).profile !== null && /RED TEAMS 0\/16/.test((await b(page)).title), tag + 'NEW TRAINER, the name tapped key by key on the in-picture keyboard, its OK chip: the trainer RED is made', (await b(page)).title);
    await tapRect(rowRect('new')); await waitPath(page, 'builder-team');
    // a tap on the first slot: the species picker
    await tapRect(`${HUB}.model.rects()[0]`); await waitPath(page, 'builder-species');
    const c0 = (await st(page)).screens['builder-species'].cursor;
    await tapRect(chipRect('pgdn')); const c1 = (await st(page)).screens['builder-species'].cursor;
    await tapRect(chipRect('pgup')); const c2 = (await st(page)).screens['builder-species'].cursor;
    ok(c0 === 0 && c1 === 7 && c2 === 0, tag + 'the page chips move a page of seven down and back up (what L / R do on a keyboard)', J([c0, c1, c2]));
    await pad('right'); const dex = await page.eval(`(() => { const l = ${HUB}.view().builder.list; return l.rows[l.cursor].tag; })()`);
    ok(dex === '100', tag + 'the pad\'s RIGHT jumps a chapter (to Pokedex number 100)', dex);
    // FILTER chip -> the panel -> FIND -> the in-picture keyboard
    await tapRect(chipRect('filter')); ok(!!(await b(page)).popup, tag + 'a tap on the FILTER chip opens the filter panel (what Y / X do on a keyboard)');
    await shot(page, 'touch_02_filter');
    await tapRect(popRect('find')); await waitFor(page, `${HUB}.wantsText()`);
    await tapWord('CHAR');
    const found = await b(page);
    ok((await where(page)) === 'builder-species' && found.list.total >= 2 && found.list.total < 40 && /match "CHAR"/.test(found.text), tag + 'FIND through the panel\'s row and the in-picture keyboard: "CHAR" matches ' + found.list.total + ' Pokemon and takes none by itself (a part of a name, several matches)', found.title + ' ' + found.text);
    const mew = sid('Charmander');
    await tapRect(rowRect('s:' + mew)); await waitPath(page, 'builder-mon');
    ok((await b(page)).title === 'Charmander', tag + 'a tap on the row picks Charmander, and the new Pokemon opens');
    // the tabs by their chips, a choice row by a tap on its right half, a long list by the pad
    await tapRect(`${HUB}.view().builder.tabs[1]`); const tab1 = (await b(page)).tab; await tapRect(`${HUB}.view().builder.tabs[2]`); const tab2 = (await b(page)).tab; await tapRect(`${HUB}.view().builder.tabs[0]`);
    ok(tab1 === 'moves' && tab2 === 'stats' && (await b(page)).tab === 'build', tag + 'the tab chips change the tab (what L / R do on a keyboard)', tab1 + ' ' + tab2);
    const shinyRow = await page.eval(rowRect('shiny')); await tap(shinyRow.x + shinyRow.w - 20, shinyRow.y + shinyRow.h / 2);
    ok((await b(page)).mon.shiny === true, tag + 'a tap on the right half of SHINY switches it');
    await shot(page, 'touch_03_mon_shiny');
    await pad('b'); await waitPath(page, 'builder-team');
    // the team menu by its chip: RENAME, typed on the in-picture keyboard
    await tapRect(chipRect('menu')); ok((await b(page)).popup && (await b(page)).popup.id === 'team', tag + 'the MENU chip opens the team menu (what START / X do on a keyboard)');
    await tapRect(popRect('rename')); await waitFor(page, `${HUB}.wantsText()`);
    for (let i = 0; i < 6; i++) await tapRect(keyRect('del'));
    await tapWord('ACE');
    ok((await b(page)).title === 'ACE', tag + 'RENAME through the menu and the in-picture keyboard (DEL, the letters, OK)', (await b(page)).title);
    // CHECK by its chip; RULES by its chip and a tap on a row's right half
    await tapRect(chipRect('check')); await waitPath(page, 'builder-check'); await pad('b'); await waitPath(page, 'builder-team');
    await tapRect(chipRect('rules')); await waitPath(page, 'builder-rules');
    const itemRow = await page.eval(rowRect('item')); await tap(itemRow.x + itemRow.w - 20, itemRow.y + itemRow.h / 2);
    const note = await b(page);
    ok(/item clause/.test(note.side.label) && note.pages === 2 && note.more === true, tag + 'ITEM CLAUSE switched by a tap; the reducer\'s notice is two pages long', note.side.label);
    await tap(120, 136); ok((await b(page)).page === 2, tag + 'a tap on the message box turns its page (what SELECT does on a keyboard)');
    await pad('b'); await waitPath(page, 'builder-team'); await pad('b'); await waitPath(page, 'builder-teams');
    // the teams list's MENU chip, and a tap outside a pop-up closes it
    await tapRect(chipRect('menu')); const pop = (await b(page)).popup; await tap(40, 100);
    ok(pop && pop.id === 'teams' && pop.rows.map((r) => r.label).join() === 'OPEN,RENAME,DUPLICATE,MOVE UP,MOVE DOWN,DELETE' && !(await b(page)).popup, tag + 'the MENU chip of the teams list opens the team\'s menu, and a tap outside closes it');
    await waitTag(page, 'SAVED'); await settle(page);
    await reload(page); await waitBuilder(page); await settle(page);
    const s = await stored(page), p = s.profiles[0], mon = p && p.box[0];
    ok(s.profiles.length === 1 && p.trainerName === 'RED' && p.teams.length === 1 && p.teams[0].name === 'ACE' && /item-clause/.test(p.teams[0].ruleset) && p.box.length === 1 && mon.species === mew && mon.shiny === true,
      tag + 'RELOAD: IndexedDB holds what the taps made: RED, the team ACE under the item clause, a shiny Charmander', J(p && [p.trainerName, p.teams[0].name, p.teams[0].ruleset, mon && mon.species, mon && mon.shiny]));
    ok((await where(page)) === 'builder-teams' && (await b(page)).list.rows[0].label === 'ACE', tag + 'RELOAD: the picture is back on the teams list with ACE');
    ok(clean(await faults(page)) && errsOf(page).length === 0, tag + 'no fault and no console error in the whole session', J(await faults(page)) + ' ' + errsOf(page).slice(0, 2).join(' | '));
  });

  /* ============================================================================================== pad: a synthetic controller alone */
  if (wants('pad')) await session('controller only (synthetic)', { width: 1280, height: 800, pad: true, port: cdp++ }, async (page) => {
    const tag = 'pad: ';
    const P = { a: 0, b: 1, x: 2, y: 3, l: 4, r: 5, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
    const btn = async (k, n = 1) => { for (let i = 0; i < n; i++) await padPress(page, P[k]); };
    await openHub(page);
    await page.send('Runtime.evaluate', { expression: `window.dispatchEvent(new Event('gamepadconnected'))` });
    for (let i = 0; i < 12; i++) { const id = await page.eval(`(() => { const m = ${HUB}.view().menu; return m.rows[m.cursor].id; })()`); if (id === 'builder') break; await btn('down'); }
    await btn('a'); await waitPath(page, 'builder'); await waitBuilder(page);
    // NEW TRAINER: the in-picture keyboard, walked with the d-pad; START accepts
    await btn('a'); await waitFor(page, `${HUB}.wantsText()`);
    await btn('a'); await btn('right'); await btn('a'); await btn('right'); await btn('a');          // A, B, C
    const typed = await page.eval(`${HUB}.view().entry.value`);
    await btn('start'); await waitPath(page, 'builder-teams');
    ok(typed === 'ABC' && /ABC TEAMS/.test((await b(page)).title), tag + 'a name is typed with the d-pad and A on the in-picture keyboard and accepted with START', typed);
    await btn('a'); await waitPath(page, 'builder-team');
    await btn('a'); await waitPath(page, 'builder-species');
    await btn('r', 2); const c1 = (await st(page)).screens['builder-species'].cursor; await btn('l'); const c2 = (await st(page)).screens['builder-species'].cursor;
    ok(c1 === 14 && c2 === 7, tag + 'R and L page the species list', J([c1, c2]));
    await btn('y'); const viaY = !!(await b(page)).popup; await btn('b'); await btn('x'); const viaX = !!(await b(page)).popup; await btn('b');
    ok(viaY && viaX && !(await b(page)).popup, tag + 'Y and X open the filter panel, B closes it');
    await btn('right'); await btn('down', 2);
    const picked = await page.eval(`(() => { const l = ${HUB}.view().builder.list; return l.rows[l.cursor].sid; })()`);
    await btn('a'); await waitPath(page, 'builder-mon');
    await btn('r'); const t1 = (await b(page)).tab; await btn('l');
    ok(t1 === 'moves' && (await b(page)).tab === 'build', tag + 'R and L change the tab of the Pokemon screen');
    await btn('down', 2); await btn('left', 2);
    await btn('b'); await waitPath(page, 'builder-team');
    await btn('start'); const menu = (await b(page)).popup; await btn('b');
    ok(menu && menu.id === 'team', tag + 'START opens the team menu');
    await waitTag(page, 'SAVED'); await settle(page);
    const s = await stored(page), p = s.profiles[0], mon = p && p.box[0];
    ok(s.profiles.length === 1 && p.trainerName === 'ABC' && p.box.length === 1 && mon.species === picked && mon.level === 98 && pack.species[picked].natDex >= 100, tag + 'IndexedDB holds what the controller made: ABC, one ' + (pack.species[picked] && pack.species[picked].name) + ' at level 98', J(mon && [mon.species, mon.level]));
    ok(clean(await faults(page)) && errsOf(page).length === 0, tag + 'no fault and no console error in the whole session', J(await faults(page)) + ' ' + errsOf(page).slice(0, 2).join(' | '));
  });
} finally { L.stopServer(server); }
C.finish();
process.exit(process.exitCode || 0);
