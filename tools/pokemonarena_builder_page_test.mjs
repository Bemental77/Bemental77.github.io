// tools/pokemonarena_builder_page_test.mjs -- THE TEAM BUILDER in the hub's picture, in a real (headless, muted, throwaway-profile) Chrome with real IndexedDB, driven only through what a
// player has: real key events, taps on the picture and on the on-screen pad, a (synthetic) controller. The state is READ through window.__arenaHub; nothing is ever done through a DOM
// control a player does not have. The Node side (the model action by action, the ctl against a memory store, the renderer, the mutants) is tools/pokemonarena_builder_test.mjs.
//
//   node tools/pokemonarena_builder_page_test.mjs            every session
//   node tools/pokemonarena_builder_page_test.mjs keys       one session: keys | touch | pad
//   ARENA_PORT / ARENA_CDP (default 8097 / 9291; this track runs on 8541 / 9741), ARENA_OUT (a folder for screenshots), ARENA_BASE (a server that is already running)
//
// SESSIONS
//   keys    a desktop with a keyboard: from an EMPTY browser a trainer is made, a team, SIX Pokemon found by name; one of them gets a level, a nature, an ability, an item and a nickname, a
//           second MOVE found by typing its name, EVs (left / right, the numbers pop-up), a Hidden Power type; Ctrl+Z and Ctrl+Y (real key events) undo and redo, and are left alone while a
//           text entry is open; the autosave tag reaches SAVED; the page is RELOADED and the team is found saved (in IndexedDB, read by the game's own store module) and on the screen; COPY
//           CODE puts the team's code on the clipboard; ENTER A CODE takes it back by a paste (Ctrl+V) and ADD AS A NEW TEAM adds it; TEST leaves for the battle page at the DOM editor's
//           address; the hub's BATTLE WITH MY TEAM offers the team. The canvas shows exactly what the model's view renders
//   touch   a phone (touch only): taps on the picture and the on-screen pad's d-pad / A / B. Everything a keyboard reaches with L / R / START / X / Y is reached by a chip or a row: the MENU
//           chips, FILTER and its FIND row, the page chips, the tab chips, the in-picture keyboard's keys; a move is added and moved by taps; an EV and an IV are stepped by taps on their
//           numbers; QUICK ACTIONS and UNDO are rows; the PORTRAIT is a tap on a head; PASTE A CODE reads the clipboard on that tap; TEST starts with a tap
//   pad     a synthetic controller alone: the d-pad, A, B, X, Y, L, R, START, SELECT; a HELD direction on a stat is ONE undo step
// THE MACHINE'S CLIPBOARD IS NEVER READ OR WRITTEN: the page's navigator.clipboard is replaced by a double before the page loads (the ctl reaches the real one the same way), and a paste is
// delivered as the browser delivers one (a ClipboardEvent). Leaving for the battle page is caught by window.__arenaNavigate, which boot.js calls instead of location.assign when it is there.
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
const moveId = (name) => pack.moves.findIndex((m) => m && m.name === name);
const ST = await L.mod('stats.js');
// the page's clipboard (never the machine's) and the page's "leave for another page"
const CLIP_DOUBLE = `(() => { const c = { text: '', refuse: false, reads: 0, writes: 0 }; window.__clip = c;
  const api = { writeText: async (s) => { c.writes++; if (c.refuse) throw new DOMException('denied', 'NotAllowedError'); c.text = String(s); }, readText: async () => { c.reads++; if (c.refuse) throw new DOMException('denied', 'NotAllowedError'); return c.text; } };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => api });
  window.__went = []; window.__arenaNavigate = (u) => { window.__went.push(String(u)); }; })();`;
const BATTLE_RE = /^\/pokemonarena\/battle\.html\?team=(ARENA1\.[A-Za-z0-9_-]+\.[0-9a-f]{4})&foe=random&seed=(\d+)&format=(6v6|3v3)&cpu=(easy|normal|hard)$/;
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
const rowNow = (page) => page.eval(`(() => { const l = ${HUB}.view().builder.list; return l ? l.rows[l.cursor] || null : null; })()`);
const said = (page) => page.eval(`${HUB}.view().msg.join(' ').trim()`);
const monNow = (page) => page.eval(`(() => { const A = ${HUB}.model.apps.builder, p = A.editor().profile, at = A.focus(); return p.box.find((m) => m.id === at.monId) || null; })()`);
const clip = (page) => page.eval('window.__clip');
/** What the page's own teamcode.js makes of a code. */
const decoded = (page, code) => page.eval(`(async () => { const T = await import('/pokemonarena/js/teamcode.js'); const r = await T.decodeTeamCode(${J(code)}); return r.ok ? { ok: true, name: r.team.name, species: r.team.mons.map((m) => m.species) } : { ok: false, code: r.code }; })()`);
/** A real key event with Ctrl held. */
async function ctrlKey(page, ch) {
  const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await sleep(90);
}
/** A paste, as the browser delivers one: a ClipboardEvent on the focused element. */
const paste = (page, text) => page.eval(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${J(text)}); const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); (document.activeElement || document.body).dispatchEvent(ev); return ev.defaultPrevented; })()`);
/** The team screen's cursor onto the chip with this id (down to the chip row, then along it). */
async function toChip(page, id, press) {
  for (let g = 0; g < 16; g++) {
    const c = (await st(page)).screens['builder-team'].cursor, chips = (await b(page)).chips, want = 6 + chips.findIndex((x) => x.id === id);
    if (c === want) return true;
    await press(c < 6 ? 'down' : 'right');
  }
  return false;
}

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

/* ------------------------------------------------------------------------------------------------ NEW TRAINER: the trainer app's screens (pokemonarena/INAPP.md TRAINER: one way to make a trainer) */
const trw = (page) => page.eval(`${HUB}.model.state().apps.trainer.wiz`);
const asking = (page) => page.eval(`!!(${HUB}.dialog.current() && ${HUB}.dialog.current().id === 'trainer:welcome')`);
/**
 * The builder's NEW TRAINER was pressed: walk the NEW TRAINER screens it opened with one device's gestures (act: { welcome() (a page or the answer of the welcome), up(), pick(index) (take a row or a picture), yes() }), name the trainer
 * with `typeName()` at NEW NAME, take every other step's default, YES; then wait for the builder's list, where the trainer made is ACTIVE.
 */
async function walkNewTrainer(page, act, typeName) {
  await waitPath(page, 'trainer-new');
  for (let i = 0; i < 12 && (await asking(page)); i++) await act.welcome();          // the welcome's pages, then LET'S GO
  for (let i = 0; i < 8 && (await trw(page)) && (await trw(page)).cur !== 0; i++) await act.up();          // NEW NAME is the first row; the cursor opens on the first offered name
  await act.pick(0); await waitFor(page, `${HUB}.wantsText()`);
  await typeName();
  for (let i = 0; i < 12; i++) { const w = await trw(page); if (!w || w.step === 'card') break; await act.pick(w.cur); }
  await act.yes();
  await waitPath(page, 'builder'); await waitBuilder(page);
  await waitFor(page, `(${HUB}.view().builder.list.rows || []).some((r) => r.tag === 'ACTIVE')`);
}

async function session(name, opts, fn) {
  console.log('--- ' + name + ' (' + opts.width + 'x' + opts.height + (opts.mobile ? ' mobile' : '') + ') ' + loadPct());
  try {
    await withBrowser({ port: opts.port, width: opts.width, height: opts.height, mobile: !!opts.mobile }, async (page) => {
      await page.setViewport(opts.width, opts.height, { mobile: !!opts.mobile, dpr: opts.dpr || 1 });
      await addInit(page, AUDIO_DOUBLE);
      await addInit(page, CLIP_DOUBLE);
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
    // NEW TRAINER (the trainer app's screens), the name typed on the real keyboard; back on the list A opens the new trainer's teams
    await key(page, 'a');
    await walkNewTrainer(page, { welcome: () => key(page, 'a'), up: () => key(page, 'up'), pick: () => key(page, 'a'), yes: () => key(page, 'a') }, () => typeWord(page, 'Ash'));
    await key(page, 'a'); await waitPath(page, 'builder-teams');
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
    // STAGE 2, on the same Pokemon. MOVES: R, the first empty slot, the picker, FIND typed on the real keyboard, A takes the move
    await key(page, 'r');
    const mv0 = await b(page);
    ok(mv0.tab === 'moves' && mv0.layout === 'moves' && mv0.list.rows[1].label === '+ ADD A MOVE' && mv0.list.rows[0].type !== undefined && (await same(page)), tag + 'R opens the MOVES tab: the move it has (its ROM type, category and numbers) and "+ ADD A MOVE" (the canvas shows the frame the view renders)', J(mv0.list.rows.slice(0, 2)));
    await shot(page, 'keys_05a_moves');
    await toRow(page, 'm:1', down); await key(page, 'a'); await waitPath(page, 'builder-move');
    const nMoves = (await b(page)).list.total;
    await key(page, 'start'); await waitFor(page, `${HUB}.wantsText()`); await typeWord(page, 'thunderbolt');
    const found = await b(page), row = await rowNow(page);
    ok(nMoves > 60 && found.list.total >= 1 && found.list.total < nMoves && row && row.label === 'Thunderbolt' && !row.dim && found.info && found.info.power === String(pack.moves[moveId('Thunderbolt')].power) && (await same(page)), tag + 'the move picker (' + nMoves + ' moves this Pokemon can learn): FIND typed on the real keyboard narrows it to ' + found.list.total + ', Thunderbolt highlighted with its numbers in the foot line', J(row));
    await shot(page, 'keys_05b_move_picker');
    await key(page, 'a'); await waitPath(page, 'builder-mon');
    ok((await monNow(page)).moves.length === 2 && (await monNow(page)).moves[1].id === moveId('Thunderbolt') && (await b(page)).tab === 'moves', tag + 'A takes the move: the Pokemon knows Thunderbolt, and the picture is back on the MOVES tab');
    // STATS: R; Attack: RIGHT three times (12 EVs); A -> MAX (255)
    await key(page, 'r'); await toRow(page, 's:atk', down); await key(page, 'right', 3);
    const s1 = await b(page);
    ok(s1.layout === 'stats' && s1.mode === 'ev' && (await monNow(page)).ev.atk === 12 && s1.list.rows[0].budget.text === '498 LEFT OF 510' && (await same(page)), tag + 'R opens the STATS tab; RIGHT three times on Attack gives it 12 EVs and the budget reads ' + s1.list.rows[0].budget.text, J(s1.list.rows[0]));
    await key(page, 'a'); await toPop(page, 'max', down); await key(page, 'a');
    ok((await monNow(page)).ev.atk === 255 && !(await b(page)).popup, tag + 'A opens the numbers; MAX sets the Attack EVs to 255');
    // Ctrl+Z / Ctrl+Y: real key events with the Ctrl modifier
    await ctrlKey(page, 'z');
    const u1 = (await monNow(page)).ev.atk, saidUndo = await said(page);
    await ctrlKey(page, 'y');
    ok(u1 === 12 && /^Undid: change atk EVs\.$/.test(saidUndo) && (await monNow(page)).ev.atk === 255 && /^Redid: change atk EVs\.$/.test(await said(page)), tag + 'Ctrl+Z undoes (255 back to 12: the three presses were one step) and Ctrl+Y redoes, each with the reducer\'s words in the message box', u1 + ' ' + saidUndo);
    // ... and under a text entry Ctrl+Z is no undo and Z is a letter
    await key(page, 'a'); await key(page, 'a'); await waitFor(page, `${HUB}.wantsText()`);
    await ctrlKey(page, 'z'); const stillEntry = await page.eval(`${HUB}.wantsText()`), evTyping = (await monNow(page)).ev.atk; await key(page, 'b');
    ok(stillEntry && evTyping === 255 && !(await page.eval(`${HUB}.wantsText()`)), tag + 'while the numbers\' text entry is open Ctrl+Z undoes nothing (a word being typed is not an edit); Escape closes it');
    // HIDDEN POWER: its row, the list of sixteen types (it scrolls), Ice
    await toRow(page, 'hp', down); await key(page, 'a'); const hpPop = (await b(page)).popup; await toPop(page, 'hp:Ice', () => key(page, 'up')); await key(page, 'a');
    const iceIvs = ST.hiddenPowerIvs('Ice'), ivNow = (await monNow(page)).iv;
    ok(hpPop && hpPop.total === 16 && hpPop.rows.length === 6 && ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every((k) => ivNow[k] === iceIvs[k]) && (await rowNow(page)).value === 'Ice' && (await same(page)), tag + 'HIDDEN POWER: the list of sixteen types scrolls; ICE sets the IVs and the line shows the ROM\'s Ice badge', J(ivNow));
    await shot(page, 'keys_05c_stats');
    await waitTag(page, 'SAVED'); await settle(page);
    await shot(page, 'keys_05_mon_edited');
    const mid = await stored(page), p1 = mid.profiles[0], t1 = p1 && p1.teams[0], lead = p1 && p1.box.find((m) => m.id === t1.monIds[0]);
    ok(mid.profiles.length === 1 && p1.trainerName === 'Ash' && mid.active === p1.id && t1.monIds.length === 6 && J(t1.monIds.map((id) => p1.box.find((m) => m.id === id).species)) === J(TEAM.map(sid)),
      tag + 'the autosave tag reached SAVED and IndexedDB holds the trainer Ash with the team of six, in order', J(t1 && t1.monIds.length));
    const item = pack.items.find((it) => it && it.name === itemName);
    ok(lead && lead.level === 97 && lead.nature === 2 && lead.nickname === 'Sparky' && item && lead.heldItem === item.id && lead.abilitySlot !== 0, tag + 'the edits of the first Pokemon are stored: level 97, nature 2, another ability, ' + itemName + ', nicknamed Sparky', J(lead && { l: lead.level, n: lead.nature, a: lead.abilitySlot, i: lead.heldItem, k: lead.nickname }));
    ok(lead && lead.moves.length === 2 && lead.moves[1].id === moveId('Thunderbolt') && lead.ev.atk === 255 && lead.iv.atk === iceIvs.atk && lead.iv.spe === iceIvs.spe, tag + '... and so are its second move (Thunderbolt), its 255 Attack EVs and its Hidden Power Ice IVs', J(lead && { m: lead.moves, e: lead.ev, i: lead.iv }));
    const hubTeam = await page.eval(`${HUB}.data.profiles[0].teams[0]`);
    ok(hubTeam && hubTeam.size === 6 && hubTeam.legal === true && hubTeam.names[0] === 'Sparky', tag + 'the hub was told after the save: its own team list has the team, six strong and legal', J(hubTeam));
    // RELOAD: a real reload of the page, at the Pokemon's address
    const before = J(p1.box.map((m) => [m.species, m.level, m.nature, m.heldItem, m.nickname, m.moves, m.ev, m.iv]));
    await reload(page); await waitBuilder(page); await settle(page);
    const after = await stored(page), p2 = after.profiles[0];
    ok(after.profiles.length === 1 && J(p2.box.map((m) => [m.species, m.level, m.nature, m.heldItem, m.nickname, m.moves, m.ev, m.iv])) === before && p2.teams[0].monIds.length === 6, tag + 'RELOAD: the profile read back from IndexedDB is the team that was built (species, levels, natures, items, moves, EVs, IVs)');
    ok((await where(page)) === 'builder-mon' && (await b(page)).title === 'Sparky' && (await b(page)).mon.level === 97 && (await b(page)).tab === 'stats' && (await page.eval('location.hash')) === '#builder-mon', tag + 'RELOAD: the picture comes back on the same Pokemon and the same tab (the tab keeps its focus)', (await where(page)) + ' ' + J((await b(page)).title));
    await key(page, 'b'); await waitPath(page, 'builder-team');
    const again = await b(page);
    ok(again.slots.map((s) => s.name).join() === ['Sparky', ...TEAM.slice(1)].join() && again.status.text === 'LEGAL' && again.tag.text === 'SAVED' && (await same(page)), tag + 'RELOAD: the team screen shows the six again, LEGAL and SAVED', again.slots.map((s) => s.name).join());
    await shot(page, 'keys_06_after_reload');
    // THE TEAM CODE: the CODE chip; COPY CODE puts it on the (page's) clipboard and never in the picture
    await toChip(page, 'x:code', (k) => key(page, k)); await key(page, 'a'); await waitPath(page, 'builder-code');
    await waitFor(page, `${HUB}.model.state().apps.builder.screens['builder-code'].chars > 0`);
    const chars = (await st(page)).screens['builder-code'].chars;
    await key(page, 'a'); await waitFor(page, 'window.__clip.writes === 1');
    const code = (await clip(page)).text, dec = await decoded(page, code), viewText = await page.eval(`JSON.stringify(${HUB}.view())`);
    ok(/^ARENA1\./.test(code) && code.length === chars && dec.ok && J(dec.species) === J(TEAM.map(sid)) && !viewText.includes(code.slice(7, 40)) && new RegExp('^Team code copied: ' + chars + ' characters\\.').test(await said(page)) && (await same(page)),
      tag + 'COPY CODE: the team\'s ARENA1 code (' + chars + ' characters, which the picture says) is on the clipboard, decodes to the six, and is nowhere in the view', code.slice(0, 16) + ' ' + J(dec) + ' ' + (await said(page)));
    await shot(page, 'keys_07_code_copied');
    // ENTER A CODE: the text entry; the code arrives by a paste (Ctrl+V), white space and all; OK shows the preview; ADD AS A NEW TEAM
    await toRow(page, 'enter', down); await key(page, 'a'); await waitFor(page, `${HUB}.wantsText()`);
    const took = await paste(page, ' ' + code.slice(0, 25) + '\n' + code.slice(25) + '\n');
    const entered = await page.eval(`${HUB}.view().entry.value`);
    await page.press('Enter', 'Enter', 13, 30); await waitFor(page, `${HUB}.model.state().apps.builder.screens['builder-code'].preview === true`);
    const prev = await b(page);
    ok(took === true && entered === code && prev.title === 'CODE: TEAM 1' && prev.side.icons.length === 6 && J(prev.side.lines) === J(['6 POK{E}MON', 'LEGAL']) && prev.list.rows.map((r) => r.id).join() === 'add,cancel' && (await clip(page)).reads === 0,
      tag + 'ENTER A CODE: a paste (as Ctrl+V delivers it) arrives whole in the text entry, Enter shows the preview: TEAM 1, six Pokemon, LEGAL', entered.length + ' ' + J(prev.side));
    await shot(page, 'keys_08_code_preview');
    await key(page, 'a'); await waitPath(page, 'builder-team');
    const twoTeams = await page.eval(`${HUB}.model.apps.builder.editor().profile.teams.length`);
    ok(twoTeams === 2 && (await b(page)).slots.filter((s) => !s.empty).length === 6 && (await page.eval(`${HUB}.trail().join()`)) === 'builder,builder-teams,builder-team', tag + 'ADD AS A NEW TEAM: the trainer has two teams, and the new one is open in the code screen\'s place (B from it is the teams list)');
    // THE TEST BATTLE: the TEST chip, START
    await toChip(page, 'x:test', (k) => key(page, k)); await key(page, 'a'); await waitPath(page, 'builder-test');
    await key(page, 'a'); await waitFor(page, 'window.__went.length === 1');
    const went = (await page.eval('window.__went'))[0], m = BATTLE_RE.exec(went || ''), decT = m ? await decoded(page, m[1]) : { ok: false };
    ok(m && decT.ok && J(decT.species) === J(TEAM.map(sid)) && m[3] === '6v6' && m[4] === 'normal' && Number(m[2]) <= 0xffffffff && (await st(page)).tag === 'SAVED', tag + 'TEST, START: the page leaves for the battle page at the DOM editor\'s address (team=<this team\'s code>&foe=random&seed=..&format=6v6&cpu=normal), the edits saved first', String(went).slice(0, 80));
    await key(page, 'b'); await waitPath(page, 'builder-team');
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
    await tapRect(rowRect('new'));
    const tapIndex = async (i) => { const r = await page.eval(`${HUB}.model.rects().find((x) => (x.kind === 'row' || x.kind === 'cell') && x.index === ${i}) || null`); if (r) await tap(r.x + r.w / 2, r.y + r.h / 2); };
    await walkNewTrainer(page, {
      welcome: async () => { const rs = await page.eval(`${HUB}.model.rects()`); if (rs.length) await tap(rs[0].x + rs[0].w / 2, rs[0].y + rs[0].h / 2); else await tap(120, 136); },
      up: () => pad('up'), pick: tapIndex, yes: () => tapRect(`${HUB}.model.rects().find((x) => x.kind === 'chip' && x.id === 'yes') || null`),
    }, async () => { await shot(page, 'touch_01_entry'); await tapWord('RED'); });
    await tapRect(`(() => { const m = ${HUB}.view().menu, i = m.rows.findIndex((r) => r.tag === 'ACTIVE'); return i < 0 ? null : ${HUB}.model.rects()[i]; })()`); await waitPath(page, 'builder-teams');
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
    // STAGE 2 by taps. MOVES: the tab chip, a tap on "+ ADD A MOVE", a tap on a row of the picker; then the move's menu, UP
    await tapRect(`${HUB}.view().builder.tabs[1]`); await tapRect(rowRect('m:1')); await waitPath(page, 'builder-move');
    const pick = await page.eval(`(() => { const l = ${HUB}.view().builder.list; return l.rows.find((r) => !r.dim); })()`);
    await tapRect(rowRect(pick.id)); await waitPath(page, 'builder-mon');
    const m2 = await monNow(page);
    ok(m2.moves.length === 2 && m2.moves[1].id === pick.mid && (await b(page)).tab === 'moves', tag + 'MOVES: a tap on "+ ADD A MOVE" opens the picker, a tap on ' + pick.label + ' takes it');
    await tapRect(rowRect('m:1')); const mm = (await b(page)).popup; await tapRect(popRect('up'));
    ok(mm && mm.id === 'move' && mm.rows.map((r) => r.label).join() === 'CHANGE,UP,DOWN,REMOVE' && (await monNow(page)).moves[0].id === pick.mid && !!(await b(page)).popup, tag + 'a tap on the move opens its menu; UP moves it to the first slot and the menu stays open');
    await tap(30, 100);                                                 // (a tap outside the menu closes it)
    await shot(page, 'touch_04_moves');
    // STATS: the tab chip; a tap on the right half of a number steps it up, on the left half down; a tap on the IV makes the IV the number edited
    await tapRect(`${HUB}.view().builder.tabs[2]`);
    const cell = (i, which) => ({ eff: { x: 143, w: 40 }, iv: { x: 184, w: 32 } }[which].x + ({ l: 5, r: which === 'eff' ? 35 : 27 }[i]));
    const yAtk = 19 + 2 * 12 + 6;
    await tap(cell('r', 'eff'), yAtk); await tap(cell('r', 'eff'), yAtk); await tap(cell('l', 'eff'), yAtk);
    const e1 = (await monNow(page)).ev.atk;
    await tap(cell('r', 'iv'), yAtk); const modeIv = (await b(page)).mode, ivSame = (await monNow(page)).iv.atk; await tap(cell('l', 'iv'), yAtk);
    ok(e1 === 4 && modeIv === 'iv' && ivSame === 31 && (await monNow(page)).iv.atk === 30 && (await same(page)), tag + 'STATS: taps on the Attack EVs (right half twice, left half once: 4 EVs); a tap on its IV makes the IV the number edited, and a tap on its left half takes one off (30)', e1 + ' ' + modeIv);
    await shot(page, 'touch_05_stats');
    // QUICK ACTIONS and UNDO are rows of the list (the pad's DOWN reaches them): RESET, then UNDO brings the EVs back
    await toRow(page, 'actions', () => pad('down')); await pad('a'); const qa = (await b(page)).popup; await tapRect(popRect('reset'));
    const zero = (await monNow(page)).ev.atk; await toRow(page, 'undo', () => pad('down')); await pad('a');
    ok(qa && qa.id === 'quick' && zero === 0 && (await monNow(page)).ev.atk === 4 && /^Undid: reset EVs\.$/.test(await said(page)), tag + 'QUICK ACTIONS (a row) -> RESET by a tap sets the EVs to 0; the UNDO row brings them back', zero + ' ' + (await said(page)));
    await tapRect(`${HUB}.view().builder.tabs[0]`);
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
    ok(mon.moves.length === 2 && mon.moves[0].id === pick.mid && mon.ev.atk === 4 && mon.iv.atk === 30, tag + '... with the move the taps added (in the first slot), 4 Attack EVs and an Attack IV of 30', J([mon.moves, mon.ev.atk, mon.iv.atk]));
    ok((await where(page)) === 'builder-teams' && (await b(page)).list.rows[0].label === 'ACE', tag + 'RELOAD: the picture is back on the teams list with ACE');
    // THE PORTRAIT: the trainer list's MENU chip, PORTRAIT, a tap on a head
    await pad('b'); await waitPath(page, 'builder'); await tapRect(chipRect('menu')); await tapRect(popRect('x:portrait')); await waitPath(page, 'builder-portrait');
    const heads = await b(page); await tapRect(`${HUB}.model.rects()[2]`); await waitPath(page, 'builder');
    ok(heads.kind === 'portrait' && heads.cells.length === 3 && heads.cells[0].used === true && (await page.eval(`${HUB}.model.apps.builder.editor().profile.avatar.id`)) === 2 && (await b(page)).side.avatar.id === 2, tag + 'PORTRAIT (the trainer\'s MENU chip): three of the ROM\'s heads; a tap on the third takes it');
    await shot(page, 'touch_06_portrait_taken');
    // THE TEAM CODE by taps: COPY CODE, then PASTE A CODE reads the clipboard ON THAT TAP, the preview, ADD AS A NEW TEAM
    await tapRect(rowRect('p:' + p.id)); await waitPath(page, 'builder-teams'); await tapRect(rowRect('t:' + p.teams[0].id)); await waitPath(page, 'builder-team');
    await tapRect(chipRect('x:code')); await waitPath(page, 'builder-code'); await waitFor(page, `${HUB}.model.state().apps.builder.screens['builder-code'].chars > 0`);
    await tapRect(rowRect('copy')); await waitFor(page, 'window.__clip.writes === 1');
    const code = (await clip(page)).text;
    await tapRect(rowRect('paste')); await waitFor(page, `${HUB}.model.state().apps.builder.screens['builder-code'].preview === true`);
    const prev = await b(page), reads = (await clip(page)).reads;
    await shot(page, 'touch_07_code_preview');
    await tapRect(rowRect('add')); await waitPath(page, 'builder-team');
    ok(/^ARENA1\./.test(code) && reads === 1 && prev.title === 'CODE: ACE' && prev.side.icons.length === 1 && (await page.eval(`${HUB}.model.apps.builder.editor().profile.teams.length`)) === 2,
      tag + 'COPY CODE by a tap; PASTE A CODE reads the clipboard on that tap and shows the preview (ACE, one Pokemon); ADD AS A NEW TEAM by a tap: two teams', code.slice(0, 12) + ' ' + reads + ' ' + prev.title);
    // a clipboard the browser will not let the page read is said in the picture
    await tapRect(chipRect('x:code')); await waitPath(page, 'builder-code'); await page.eval('window.__clip.refuse = true; true');
    await tapRect(rowRect('paste')); await waitFor(page, `${HUB}.view().builder.note === true`);
    ok(/^This browser did not let the page read the clipboard\./.test(await said(page)), tag + 'a clipboard the browser will not let the page read is said in the picture, which points at ENTER A CODE', await said(page));
    await pad('b'); await waitPath(page, 'builder-team');
    // THE TEST BATTLE by taps
    await tapRect(chipRect('x:test')); await waitPath(page, 'builder-test'); await tapRect(rowRect('start')); await waitFor(page, 'window.__went.length === 1');
    const went = (await page.eval('window.__went'))[0];
    ok(BATTLE_RE.test(went || ''), tag + 'TEST, a tap on START: the page leaves for the battle page with the team\'s code', String(went).slice(0, 70));
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
    await btn('a');
    let typed = null;
    await walkNewTrainer(page, { welcome: () => btn('a'), up: () => btn('up'), pick: () => btn('a'), yes: () => btn('a') }, async () => {
      await btn('a'); await btn('right'); await btn('a'); await btn('right'); await btn('a');          // A, B, C
      typed = await page.eval(`${HUB}.view().entry.value`);
      await btn('start');
    });
    await btn('a'); await waitPath(page, 'builder-teams');
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
    // STATS with the controller: R twice; a HELD right on Attack runs through several steps and is ONE undo step; X and START open the quick actions
    await btn('r', 2); await btn('down', 2);
    const u0 = (await st(page)).undo; await padPress(page, P.right, 1100);
    const held = (await monNow(page)).ev.atk, u1 = (await st(page)).undo;
    await btn('x'); const qx = (await b(page)).popup; await btn('b'); await btn('start'); const qs = (await b(page)).popup; await btn('b');
    ok((await b(page)).tab === 'stats' && held >= 12 && held % 4 === 0 && u1 === u0 + 1 && qx && qx.id === 'quick' && qs && qs.id === 'quick', tag + 'STATS: RIGHT held on Attack steps its EVs to ' + held + ' as ONE undo step; X and START open the quick actions', held + ' ' + u0 + ' ' + u1);
    await btn('b'); await waitPath(page, 'builder-team');
    await btn('start'); const menu = (await b(page)).popup; await btn('b');
    ok(menu && menu.id === 'team', tag + 'START opens the team menu');
    await waitTag(page, 'SAVED'); await settle(page);
    const s = await stored(page), p = s.profiles[0], mon = p && p.box[0];
    ok(s.profiles.length === 1 && p.trainerName === 'ABC' && p.box.length === 1 && mon.species === picked && mon.level === 98 && mon.ev.atk === held && pack.species[picked].natDex >= 100, tag + 'IndexedDB holds what the controller made: ABC, one ' + (pack.species[picked] && pack.species[picked].name) + ' at level 98 with ' + held + ' Attack EVs', J(mon && [mon.species, mon.level, mon.ev.atk]));
    ok(clean(await faults(page)) && errsOf(page).length === 0, tag + 'no fault and no console error in the whole session', J(await faults(page)) + ' ' + errsOf(page).slice(0, 2).join(' | '));
  });
} finally { L.stopServer(server); }
C.finish();
process.exit(process.exitCode || 0);
