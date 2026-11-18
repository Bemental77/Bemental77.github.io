// tools/pokemonarena_hub_online_browser.mjs -- the BROWSER half of tools/pokemonarena_hub_online_test.mjs (that file's header lists the sessions; it imports this one). TEST-ONLY.
//
// Real headless Chrome through tools/headless_cdp.mjs (muted, a throwaway profile, bare CDP), one browser at a time. Two players are two tabs of that one browser, paired by the same-browser
// transport (net=local), as tools/pokemonarena_online_page_test.mjs does. The HUB is driven through window.__arenaHub, real keys, real taps and a synthetic controller. THE BATTLE PAGE IS READ
// ONLY THROUGH ITS HOOKS (window.__arenaOnline: state, nm(); window.__arenaBattle.state) and its address: never through a DOM id of its panel, which another team is replacing with screens in the
// battle canvas. What a session needs of that page is what the one-time tokens start.
//
// TWO TABS SHARE ONE BROWSER PROFILE, so they share localStorage: the online preferences and the typed name are one value for both "players". The sessions therefore go in order (player A
// chooses and leaves for the battle page, which reads its choices as it comes up; only then does player B choose). "This browser has read the long notice" (arena.online.told) is shared too:
// the first YES of a session is to the long notice (NO under the cursor), the later ones to its one-page form.
//
// THE MUTANTS (--browser --mutants; BROWSER_MUTANTS at the end): a copy of pokemonarena/ with ONE defect is served by tools/pokemonarena_overlay.mjs in front of the dev server (ARENA_PORT + 40),
// the session the defect names is run against it, and the case it names must fail. They are the guards only a real page can prove (a real key landing on a screen that has only just taken
// another's place; what the board hears against what the picture said); every other guard has its mutant in the Node part.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { BASE, CDP0, sleep, J, key, tapLogical, padPress, PAD_DOUBLE, addInit, tapSel } = L;
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-hub-online-shots');
let SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';          // (off while a mutant runs: a picture of a broken copy must not replace the picture of the game)
let ORIGIN = BASE;          // where the sessions open the game: the dev server, or (a mutant run) an overlay that serves a copy of the game with ONE defect in it
const hubUrl = () => ORIGIN + '/pokemonarena/';
const H = 'window.__arenaHub', A = H + '.model.apps.online';
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=BackForwardCache'];
const CHANNEL = 'bemental-arena-open-1';
const MIN_FREE_MB = 3500;

/**
 * Four tracks share this machine and a browser session takes about 1.3 GB: under MIN_FREE_MB free, wait 90 s and read again (pokemonarena/INAPP.md "Working rules": before each browser SUITE).
 * The suite's FIRST browser waits for as long as it takes within half an hour; the sessions after it start one browser where this suite has just closed one, so they read the memory too but
 * wait at most three times (when another track took the room in between) before they go on.
 */
let gated = false;
async function memoryGate(label) {
  const tries = gated ? 3 : 20;
  gated = true;
  for (let i = 0; i < tries; i++) {
    let free = NaN;
    try { free = Number((spawnSync('powershell.exe', ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)'], { encoding: 'utf8' }).stdout || '').trim()); } catch (_e) { free = NaN; }
    if (!Number.isFinite(free) || free >= MIN_FREE_MB) { console.log('  [' + label + '] free memory ' + (Number.isFinite(free) ? free + ' MB' : 'unknown')); return; }
    console.log('  [' + label + '] free memory ' + free + ' MB < ' + MIN_FREE_MB + ': waiting 90 s');
    await sleep(90000);
  }
}

/* ------------------------------------------------------------------------------------------------ the hub */
const shot = async (p, name) => { if (SHOTS) { try { await p.screenshot(path.join(OUT, name + '.png')); } catch (_e) { /* a screenshot is evidence, not the test */ } } };
const errs = (...ps) => ps.flatMap((p) => p.errors).filter((e) => !/favicon\.ico/.test(e));
/** The hub is up, its PLAY ONLINE ctl is awake and the presence service has said where it stands. */
async function hubUp(p, query = '', hash = '') {
  await p.navigate(hubUrl() + '?net=local' + query + hash);
  await hubWoke(p);
}
async function hubWoke(p) {
  await p.waitFor(`${H} && ${H}.state === "ready" && ${H}.apps && !!${H}.apps.ctl("online") && ${H}.apps.ctl("online").state().woke === true && !!${H}.presence`, { timeoutMs: 120000 });
  await p.eval(`${H}.presence.ready`);
  await p.waitFor(`${H}.apps.state().online.open !== "loading"`, { timeoutMs: 20000 });
}
const st = (p) => p.eval(`${H}.apps.state().online`);
const where = (p) => p.eval(`${H}.model.path()`);
const press = (p, a) => p.eval(`(${H}.press(${J(a)}), true)`);
const sel = (p, id) => p.eval(`(${A}.select(${J(id)}), ${H}.tick(0), true)`);
const row = (p, id) => p.eval(`(${A}.allRows().find((r) => r.id === ${J(id)}) || null)`);
const typeText = (p, s) => p.eval(`(() => { for (const ch of ${J(s)}) ${H}.type({ text: ch }); return true; })()`);
const typeKey = (p, k) => p.eval(`(${H}.type({ key: ${J(k)} }), true)`);
const entry = (p) => p.eval(`(() => { const e = ${H}.view().entry; return e ? { id: e.id, value: e.value, note: e.note } : null; })()`);
const until = async (p, expr, ms = 15000) => { try { await p.waitFor(expr, { timeoutMs: ms, pollMs: 80 }); return true; } catch (_e) { return false; } };
const front = (p) => p.send('Page.bringToFront');
const Q = (id) => `(() => { const d = ${H}.dialog.current(); return !!d && d.id === ${J(id)}; })()`;
const Q_ARMED = (id) => `(() => { const d = ${H}.dialog.current(); return !!d && d.id === ${J(id)} && d.armed === true; })()`;
const Q_GONE = (id) => `(() => { const d = ${H}.dialog.current(); return !d || d.id !== ${J(id)}; })()`;
const q = (p) => p.eval(`(() => { const d = ${H}.dialog.current(), v = ${H}.view().dialog; return d ? { id: d.id, page: d.page, pages: d.pages, armed: d.armed, text: v.lines.filter(Boolean).join(' '), options: d.choice ? d.choice.options : null, on: d.choice ? d.choice.options[d.choice.cursor] : null } : null; })()`);
/** Every page of the question that is up, read by turning them with A; it ends on the last page (the options), unanswered. */
const qPages = (p) => p.eval(`(() => { const out = [], d = ${H}.dialog.current(); if (!d) return out; for (let i = d.page; i < d.pages; i++) { out.push(${H}.view().dialog.lines.filter(Boolean).join(' ')); if (i < d.pages - 1) ${H}.press('a'); } return out; })()`);
/** The first option (YES / GO ON), the long way: A to the last page, the d-pad up onto it from wherever the cursor stands, A. (A dialog that is not armed yet answers nothing: firstOf() waits for it.) */
const first = (p) => p.eval(`(() => { const d = ${H}.dialog.current(); if (!d) return false; for (let i = d.page; i < d.pages - 1; i++) ${H}.press('a'); const c = ${H}.dialog.current(); for (let i = 0; c && c.choice && i < c.choice.cursor; i++) ${H}.press('up'); ${H}.press('a'); return true; })()`);
/** Wait for the question `id` to be up AND listening, read its pages, answer YES. -> { asked, pages, on: the option that was under the cursor, armedLate: it was up before it listened } */
async function firstOf(p, id, ms = 15000) {
  const asked = await until(p, Q(id), ms);
  const early = asked ? await p.eval(`${H}.dialog.current().armed`) : null;
  await until(p, Q_ARMED(id), 5000);
  const pages = asked ? await qPages(p) : [], last = await q(p);
  await first(p);
  return { asked, pages, text: pages.join(' '), on: last ? last.on : null, armedLate: early === false };
}
/** The invite screen is up and has started to listen (it answers nothing for its first 0.6 s). */
const inviteArmed = (p, ms = 15000) => until(p, `${H}.apps.state().online.screen === "invite" && ${H}.model.path() === "online" && ${H}.apps.state().online.armed === true`, ms);
const noOnlineDom = (p) => p.eval(`({ row: document.querySelectorAll('#onlineLink, #playFriend, #trainerCenter, #openToggle').length, links: document.querySelectorAll('a[href*="battle.html?online"], a[href*="center.html"]').length, dialogs: document.querySelectorAll('#challenge, #openInfo, .arena-chal').length })`);
const mainRow = (p) => p.eval(`(() => { const m = ${H}.view().menu; const r = m ? m.rows.find((x) => x.id === 'online') : null; return r ? r.label : null; })()`);

/* ------------------------------------------------------------------------------------------------ the board, and the battle page through its hooks */
const spyOn = async (p) => { await p.navigate(ORIGIN + '/pokemonarena/input.css'); await p.eval(`(() => { window.__spy = []; const c = new BroadcastChannel(${J(CHANNEL)}); c.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = c; return true; })()`); };
const spied = (p) => p.eval('window.__spy');
const battleUp = (p) => p.waitFor('window.__arenaOnline && window.__arenaBattle && window.__arenaBattle.state === "online"', { timeoutMs: 90000 });
const bst = (p) => p.eval('(() => { const O = window.__arenaOnline, s = O.state, n = O.nm() ? O.nm().status() : null; return { stage: s.stage, role: s.role, room: s.room, name: s.name, fmt: s.fmt, size: s.mine ? s.mine.size : null, profileId: s.profileId || null, code: s.myTeamCode || null, quick: !!s.quick, open: !!s.open, phase: n ? n.phase : null, opponent: n ? n.opponent : null, search: location.search, path: location.pathname, tok: sessionStorage.getItem("arena.go"), meet: sessionStorage.getItem("arena.meet") }; })()');
async function bothPlaying(a, b, ms = 60000) {
  for (let i = 0; i < ms / 250; i++) {
    const [x, y] = [await bst(a), await bst(b)];
    if ((x.phase === 'playing' || x.phase === 'failed') && (y.phase === 'playing' || y.phase === 'failed')) return [x, y];
    await sleep(250);
  }
  return [await bst(a), await bst(b)];
}
/** Profiles with legal teams in this browser's store: spec = [[trainer, [[team, [species names]], ...]], ...]. -> { profiles: [{ id, teams: [ids] }], notSaved } */
const SEED_PROFILES_JS = (spec) => `(async () => {
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
    out.push({ id: saved.id, teams: saved.teams.map((t) => t.id) });
  }
  await store.setActiveId(firstId);
  const st = store.status;
  await store.close();
  return { profiles: out, notSaved: st.notSaved };
})()`;
const TEAM_CODE_JS = (pid, tid) => `(async () => { const S = await import('/pokemonarena/js/store.js'), D = await import('/pokemonarena/js/hub_data.js'); const store = await S.openStore(); try { const r = await D.teamCodeFor(store, ${J(pid)}, ${J(tid)}); return r.ok ? r.code : null; } finally { await store.close(); } })()`;

/* ================================================================================================ the sessions */

/* ---- invite: INVITE A FRIEND in one tab and JOIN A FRIEND by the typed code in the other end in a battle on both screens, with the team chosen and the name typed ---- */
async function sInvite(ok) {
  await withBrowser({ port: CDP0 + 1, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 }), spy = await a.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    await front(a);
    await hubUp(a);
    const seeded = await a.eval(SEED_PROFILES_JS([['RED', [['ALPHA', ['Pikachu', 'Charizard', 'Snorlax', 'Blastoise', 'Gengar', 'Eevee']], ['BETA', ['Lapras', 'Gyarados', 'Lucario']]]]]));
    const pid = seeded.profiles[0].id, [tA, tB] = seeded.profiles[0].teams, keyB = 'saved:' + pid + ':' + tB;
    await a.eval(`${H}.refresh()`);
    await until(a, `(${A}.allRows().find((r) => r.id === 'team') || {}).kind === 'choice'`);
    // PLAY ONLINE with real keys: down, down, Enter
    await key(a, 'down'); await key(a, 'down'); await key(a, 'a'); await sleep(200);
    const s0 = await st(a);
    ok((await where(a)) === 'online' && (await a.eval('location.hash')) === '#online' && s0.screen === 'menu' && s0.row === 'center' && s0.team === 'saved:' + pid + ':' + tA && s0.fmt === '6v6' && s0.name === 'RED' && !seeded.notSaved,
      'BI1 down, down, Enter on the main menu opens PLAY ONLINE (#online): with no preference it shows the first saved team, 6 V 6, the trainer\'s name', J(s0));
    await shot(a, 'invite-1-menu');
    // TEAM: four rows down, right -> BETA.  SIZE: one down, right -> 6 V 6 (a team of three starts 3 V 3).
    for (let i = 0; i < 4; i++) await key(a, 'down');
    await key(a, 'right'); await sleep(120);
    await key(a, 'down'); await key(a, 'right'); await sleep(120);
    const s1 = await st(a);
    ok(s1.team === keyB && s1.fmt === '6v6' && s1.row === 'size' && (await a.eval('localStorage.getItem("arena.online.team")')) === J({ teamKey: keyB, fmt: '6v6' }), 'BI2 the arrow keys choose the second team and switch the size; both are stored where the battle page reads them', J([s1, await a.eval('localStorage.getItem("arena.online.team")')]));
    // NAME: one down, Enter opens the entry; a REAL keyboard types; Enter is OK
    await key(a, 'down'); await key(a, 'a'); await sleep(150);
    for (const [k, code, vk] of [['A', 'KeyA', 65], ['s', 'KeyS', 83], ['h', 'KeyH', 72]]) await a.press(k, code, vk, 30);
    await sleep(100);
    const e1 = await entry(a);
    await shot(a, 'invite-2-name-entry');
    await a.press('Enter', 'Enter', 13, 30); await sleep(150);
    const s2 = await st(a);
    ok(e1 && e1.id === 'name' && e1.value === 'Ash' && s2.typed === 'Ash' && s2.name === 'Ash' && s2.entry === null && (await a.eval('localStorage.getItem("arena.online.name")')) === 'Ash', 'BI3 NAME: a real keyboard types into the entry in the picture, Enter accepts, and the name is stored where the battle page reads it', J([e1, s2.typed]));
    await shot(a, 'invite-3-chosen');
    // INVITE A FRIEND: four rows up, Enter. NOTHING LEAVES YET: the picture first says what the battle page will connect to (that page dials the public servers by itself the moment it opens)
    for (let i = 0; i < 4; i++) await key(a, 'up');
    const s3 = await st(a);
    await key(a, 'a');
    const up0 = await until(a, Q('online:friend'));
    await shot(a, 'invite-4a-notice');
    const pagesA = await qPages(a), textA = pagesA.join(' '), qA = await q(a);
    await shot(a, 'invite-4b-question');
    await sleep(600);
    const quiet = { board: (await spied(spy)).length, path: await a.eval('location.pathname'), tok: await a.eval('sessionStorage.getItem("arena.go")') };
    ok(s3.row === 'invite' && up0 && pagesA.length > 3 && /broker\.emqx\.io/.test(textA) && /cdnjs\.cloudflare\.com/.test(textA) && /IP address/.test(textA) && /never listed/.test(textA) && /public relay/.test(textA) && /Open a room for a friend\?/.test(qA.text) && qA.on === 'NO' && quiet.board === 0 && quiet.path === '/pokemonarena/' && quiet.tok === null,
      'BI4a Enter on INVITE A FRIEND starts NOTHING: the picture says which public servers the battle page will connect to, that they see the IP address, that the room is never listed and that the team played goes to the other player; then OPEN A ROOM FOR A FRIEND? with NO under the cursor. Meanwhile the board hears nothing and no token is written', J([pagesA.length, qA, quiet]));
    await first(a);
    await battleUp(a);
    const opened = await until(a, 'window.__arenaOnline.state.stage === "open"', 40000);
    const v = await bst(a), u = new URLSearchParams(v.search);
    ok(opened && v.role === 'host' && /^[A-Z0-9]{4,8}$/.test(v.room || '') && v.tok === null && u.get('ask') === null && u.get('net') === 'local' && !v.open && !v.quick && (await spied(spy)).filter((m) => m && m.k === 'open' && m.room === v.room).length === 0,
      'BI4 YES leaves for the battle page, which OPENS A PRIVATE ROOM BY ITSELF (the one-time token is used up, nothing asks, the room is not on the board)', J(v));
    const codeB = await a.eval(TEAM_CODE_JS(pid, tB));
    ok(v.code && v.code === codeB && v.size === 3 && v.profileId === pid && v.fmt === '6v6' && v.name === 'Ash', 'BI5 THE TEAM THAT WILL FIGHT IS THE TEAM CHOSEN in the hub (the second saved team, by its code), at the size chosen, under the name typed', J({ size: v.size, fmt: v.fmt, name: v.name, sameCode: v.code === codeB }));
    // the friend: another tab. RANDOM TEAM, another name, the room code typed
    await front(b);
    await hubUp(b);
    await b.eval(`(${H}.goto('online'), true)`);
    await sel(b, 'team');
    for (let i = 0; i < 4 && (await st(b)).team !== 'random'; i++) await press(b, 'right');
    await sel(b, 'name'); await press(b, 'a');
    for (let i = 0; i < 10; i++) await typeKey(b, 'backspace');
    await typeText(b, 'Misty'); await typeKey(b, 'enter');
    const sb = await st(b);
    await sel(b, 'join'); await press(b, 'a');
    await typeText(b, v.room.toLowerCase());
    const eb = await entry(b);
    await shot(b, 'invite-4-room-entry');
    await b.eval(`(${H}.pause(true), true)`);          // (the hub's clock is held, so "the first moments" of the question last as long as this check needs, however loaded the machine is)
    await typeKey(b, 'enter');
    // the code is checked, then the picture asks (this browser has said YES to the long notice in the other tab: one page, YES under the cursor). It did not come under the Enter: it listens after 0.6 s
    const upB = await until(b, Q('online:friend'));
    await b.press('Enter', 'Enter', 13, 30); await b.press('z', 'KeyZ', 90, 30);          // the Enter that was still on its way, and an A
    await sleep(120);
    const earlyB = { up: await b.eval(Q('online:friend')), path: await b.eval('location.pathname'), meet: await b.eval('sessionStorage.getItem("arena.meet")') };
    await shot(b, 'invite-4c-join-question');
    await b.eval(`(${H}.pause(false), true)`);
    const jb = await firstOf(b, 'online:friend');
    await battleUp(b);
    const [pa, pb] = await bothPlaying(a, b);
    const ub = new URLSearchParams(pb.search);
    ok(upB && earlyB.up === true && earlyB.path === '/pokemonarena/' && earlyB.meet === null && jb.text.includes('Room ' + v.room + ', over public servers.') && jb.text.includes('Join room ' + v.room + '?') && jb.on === 'YES',
      'BI6a JOIN A FRIEND: the code typed starts nothing either. The picture says ROOM <CODE>, OVER PUBLIC SERVERS and asks JOIN ROOM <CODE>?; real keys pressed in its first moments (Enter, Z) answer nothing', J([earlyB, jb]));
    ok(sb.team === 'random' && sb.typed === 'Misty' && eb && eb.id === 'room' && eb.value === v.room && ub.get('np') === v.room && ub.get('join') === '1' && pb.meet === null && pa.phase === 'playing' && pb.phase === 'playing',
      'BI6 YES: the room code typed in the picture (lower case is typed as capitals) leaves for ?np=ROOM&join=1, the battle page joins BY ITSELF, and THE BATTLE IS ON ON BOTH SCREENS', J([pa.phase, pb.phase, pb.search]));
    ok(pa.opponent === 'Misty' && pb.opponent === 'Ash' && pb.name === 'Misty' && pb.profileId === null && pb.size === 6, 'BI7 THE NAME TYPED IS THE NAME THE OPPONENT SEES, on both sides; the friend plays the random team they chose', J([pa.opponent, pb.opponent, pb.size]));
    await shot(a, 'invite-5-battle-host'); await shot(b, 'invite-6-battle-guest');
    ok(errs(a, b).length === 0, 'BI8 no page errors', J(errs(a, b)).slice(0, 400));
  });
}

/* ---- anyone: BATTLE ANYONE in both tabs pairs them; nothing is on the board before the notice's YES ---- */
async function sAnyone(ok) {
  await withBrowser({ port: CDP0 + 2, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (a) => {
    const b = await a.openTab({ width: 900, height: 760 }), spy = await a.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    await front(a);
    await hubUp(a, '&openquick=500');
    await a.eval(`(${H}.goto('online'), true)`);
    await sel(a, 'name'); await press(a, 'a'); await typeText(a, 'Zed'); await typeKey(a, 'enter');          // a name of the player's own: it is the one BATTLE ANYONE lists
    await sel(a, 'anyone');
    const rowSays = await a.eval(`${H}.view().msg.join(' ')`);
    await press(a, 'a');
    const q0 = await q(a);
    await shot(a, 'anyone-1-notice');
    const pages = await qPages(a), text = pages.join(' '), q1 = await q(a);
    await shot(a, 'anyone-2-question');
    const named = (text.match(/see the name ([A-Za-z0-9 .'_!?-]+?)(?: and your online record|\. A random team)/) || [])[1] || null;
    ok(q0 && q0.id === 'online:quick' && pages.length > 3 && named === 'Zed' && /Lists Zed, no online record/.test(rowSays) && /online record/.test(text) && /IP address/.test(text) && /broker\.emqx\.io/.test(text) && /cdnjs\.cloudflare\.com/.test(text) && /public relay/.test(text) && q1.on === 'NO' && J(q1.options) === J(['YES', 'NO']) && /Find an opponent\?/.test(q1.text),
      'BA1 BATTLE ANYONE first says, in the picture, what other players will see (the name, BY NAME, and whether a record goes with it), which public servers the battle page connects to, and that the team played goes to the other player; then FIND AN OPPONENT? with NO under the cursor', J([pages.length, named, q1]));
    await sleep(700);
    ok((await spied(spy)).length === 0 && (await a.eval('location.pathname')) === '/pokemonarena/' && (await a.eval('sessionStorage.getItem("arena.go")')) === null, 'BA2 NOTHING IS PUBLISHED while the notice is up: the board hears nothing, no token is written, the page has not left', J((await spied(spy)).length));
    await press(a, 'b'); await sleep(600);
    ok(!(await q(a)) && (await spied(spy)).length === 0 && (await where(a)) === 'online' && (await a.eval('localStorage.getItem("arena.online.told")')) === null, 'BA3 NO (B): still in the menu, nothing published, nothing remembered', '');
    await press(a, 'a'); await first(a);
    await battleUp(a);
    const listed = await until(a, 'window.__arenaOnline.state.stage === "open" && window.__arenaOnline.state.quick === true', 40000);
    const va = await bst(a), ua = new URLSearchParams(va.search);
    const heard = async (room) => (await spied(spy)).filter((m) => m && m.k === 'open' && m.room === room && m.q === 1).length;
    let onBoard = 0; for (let i = 0; i < 40 && !onBoard; i++) { onBoard = await heard(va.room); if (!onBoard) await sleep(150); }
    ok(listed && va.tok === null && ua.get('ask') === null && va.quick && va.open && onBoard > 0, 'BA4 YES leaves for the battle page, which FINDS AN OPPONENT BY ITSELF: nobody was waiting, so a game is opened and (only now) listed', J(va));
    const beacon = (await spied(spy)).find((m) => m && m.k === 'open' && m.room === va.room && m.q === 1) || {};
    ok(!!named && beacon.name === named, 'BA4b THE NAME THE NOTICE NAMED IS THE NAME ON THE BOARD: the listing the board hears carries exactly the name the picture said other players would see', J([named, beacon.name]));
    // the second player: the same row. This browser has said YES before, so the notice is the short one
    await front(b);
    await hubUp(b, '&openquick=500');
    await b.eval(`(${H}.goto('online'), true)`);
    await sel(b, 'anyone'); await press(b, 'a');
    const pb = await qPages(b), qb = await q(b);
    ok(pb.length <= 3 && /will see the name /.test(pb.join(' ')) && qb.on === 'NO', 'BA5 a browser that has said YES before gets the short notice (the name, by name), and the same question with NO first', J(pb));
    await first(b);
    await battleUp(b);
    const [x, y] = await bothPlaying(a, b);
    ok(x.phase === 'playing' && y.phase === 'playing', 'BA6 BATTLE ANYONE in both tabs PAIRS THEM: the battle is on on both screens', J([x.phase, y.phase, y.search]));
    ok(errs(a, b).length === 0, 'BA7 no page errors', J(errs(a, b)).slice(0, 400));
  });
}

/* ---- open: OPEN TO BATTLES asks once, NO is not remembered; stored on = listening from the page's load on every screen; the main menu says so ---- */
async function sOpen(ok) {
  await withBrowser({ port: CDP0 + 3, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    const spy = await p.openTab({ width: 900, height: 760 });
    await spyOn(spy);
    await front(p);
    await hubUp(p, '&opendisc=1');
    // a trainer, CASEY, with a team; and a NAME of the player's own, ZED (the name a battle shows). OPEN TO BATTLES lists the TRAINER: the picture must say CASEY, and the board must hear CASEY
    const seeded = await p.eval(SEED_PROFILES_JS([['CASEY', [['ALPHA', ['Pikachu', 'Charizard', 'Snorlax', 'Blastoise', 'Gengar', 'Eevee']]]]]));
    await p.eval(`${H}.refresh()`);
    await until(p, `(${A}.allRows().find((r) => r.id === 'team') || {}).kind === 'choice'`);
    await p.eval(`(${H}.goto('online'), true)`);
    await sel(p, 'name'); await press(p, 'a'); await typeText(p, 'ZED'); await typeKey(p, 'enter');
    const nameSays = await p.eval(`({ value: ${A}.allRows().find((r) => r.id === 'name').value, help: ${H}.view().msg.join(' ') })`);
    await press(p, 'b'); await sleep(150);
    await key(p, 'down'); await key(p, 'down'); await key(p, 'a'); await sleep(200);
    for (let i = 0; i < 7; i++) await key(p, 'down');
    const r0 = await row(p, 'open'), offSays = await p.eval(`${H}.view().msg.join(' ')`);
    await shot(p, 'open-0-row-off');
    ok(!seeded.notSaved && nameSays.value === 'ZED' && /OPEN TO BATTLES lists CASEY\./.test(nameSays.help) && /Lists trainer name CASEY and online record on public servers/.test(offSays) && !/ZED/.test(offSays),
      'BO0 WHICH NAME IS LISTED IS SAID BEFORE THE SWITCH: with the trainer CASEY and ZED typed on the NAME row, that row says OPEN TO BATTLES lists CASEY, and the OPEN TO BATTLES row says it lists the trainer name CASEY and the online record on public servers', J([nameSays, offSays]));
    await key(p, 'a');
    const asked = await until(p, Q('presence:disclosure'));
    const q0 = await q(p), dom0 = await noOnlineDom(p);
    await shot(p, 'open-1-disclosure');
    ok((await st(p)).row === 'open' && r0.value === 'OFF' && asked && q0.id === 'presence:disclosure' && dom0.dialogs === 0 && (await st(p)).open === 'off' && (await spied(spy)).length === 0,
      'BO1 Enter on OPEN TO BATTLES publishes nothing: it asks the disclosure IN THE PICTURE (no DOM dialog is built)', J([q0, dom0]));
    await key(p, 'b');
    await until(p, Q_GONE('presence:disclosure'));
    await sleep(700);
    ok((await st(p)).open === 'off' && (await p.eval('localStorage.getItem("arena.open")')) !== '1' && (await p.eval('localStorage.getItem("arena.open.seen")')) !== '1' && (await spied(spy)).length === 0, 'BO2 Backspace (B) is NO: nothing is published, nothing is stored', J(await st(p)));
    await key(p, 'a');
    const again = await until(p, Q('presence:disclosure'));
    const pages = await qPages(p), ql = await q(p);
    await first(p);
    const on = await until(p, `${H}.apps.state().online.open === "on"`, 20000);
    let listing = null; for (let i = 0; i < 40 && !listing; i++) { listing = (await spied(spy)).find((m) => m && m.name) || null; if (!listing) await sleep(150); }
    ok(again && pages.length > 2 && /public servers/.test(pages.join(' ')) && ql.on === 'NO' && on && (await row(p, 'open')).value === 'ON' && (await p.eval('localStorage.getItem("arena.open")')) === '1' && !!listing,
      'BO3 NO IS NOT REMEMBERED: the next Enter asks again (NO first); YES lists the player (the board hears it), the switch is stored and the row says ON', J([again, pages.length, on, listing && listing.name]));
    await shot(p, 'open-2-on');
    const onSays = await p.eval(`({ help: ${H}.view().msg.join(' '), name: ${A}.allRows().find((r) => r.id === 'name').value, listed: ${H}.apps.state().online.listed })`);
    ok(!!listing && listing.name === 'CASEY' && onSays.listed === 'CASEY' && /You are listed as CASEY:/.test(onSays.help) && onSays.name === 'ZED',
      'BO3b THE NAME ON THE BOARD IS THE NAME THE PICTURE SAYS: the listing the board hears is CASEY (the trainer), and the row says YOU ARE LISTED AS CASEY, while the NAME row still holds ZED', J([listing && listing.name, onSays]));
    await key(p, 'b'); await sleep(250);
    const live = await p.eval('document.getElementById("live").textContent');
    ok((await where(p)) === 'main' && (await mainRow(p)) === 'PLAY ONLINE: OPEN' && /PLAY ONLINE: OPEN/.test(live) && /open to battles/.test(live), 'BO4 THE MAIN MENU SAYS IT AT A GLANCE: the row reads PLAY ONLINE: OPEN (and a screen reader is told the same)', J([await mainRow(p), live]));
    await shot(p, 'open-3-main-menu');
    // a reload: stored on. The service listens from the page's load, the online menu never opened
    await hubUp(p, '&opendisc=1');
    const up = await until(p, `${H}.apps.state().online.open === "on"`, 20000);
    const fam = await p.eval(`({ family: ${H}.apps.family(), loaded: ${H}.apps.loaded(), path: ${H}.model.path(), on: ${H}.presence.isOn(), asked: !!${H}.dialog.current() })`);
    ok(up && fam.family === null && fam.path === 'main' && fam.loaded.includes('online') && fam.on === true && !fam.asked && (await mainRow(p)) === 'PLAY ONLINE: OPEN', 'BO5 OPEN STORED ON: after a reload the player is listed again from the page\'s load, on the main menu, the online menu never opened, nothing asked again; the main menu says OPEN', J(fam));
    await p.eval(`(${H}.goto('tower'), true)`); await sleep(200);
    ok((await where(p)) === 'tower' && (await p.eval(`${H}.presence.isOn()`)) === true, 'BO6 ... and stays listed on another screen (the Tower)', await where(p));
    await p.eval(`(${H}.goto('main'), ${H}.goto('online'), true)`);
    await sel(p, 'open'); await press(p, 'a');
    const off = await until(p, `${H}.apps.state().online.open === "off"`, 10000);
    await press(p, 'b'); await sleep(200);
    ok(off && (await p.eval('localStorage.getItem("arena.open")')) !== '1' && (await mainRow(p)) === 'PLAY ONLINE', 'BO7 A on the row switches it off at once (nothing is asked), and the main menu reads PLAY ONLINE again', J(await mainRow(p)));
    await p.eval(`(${H}.goto('online'), true)`); await sel(p, 'open'); await press(p, 'a');
    const onAgain = await until(p, `${H}.apps.state().online.open === "on"`, 20000);
    ok(onAgain && !(await q(p)), 'BO8 ASKED ONCE: switching it on again asks nothing', J(await q(p)));
    ok(errs(p).length === 0, 'BO9 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- ask: "<name> wants to battle you" on the main menu, on a Tower screen and inside a text entry ---- */
async function sAsk(ok) {
  await withBrowser({ port: CDP0 + 4, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (h) => {
    const x = await h.openTab({ width: 900, height: 760 });
    await front(h);
    await hubUp(h);
    // the owner switches OPEN TO BATTLES on from the row (the same-browser transport publishes nothing anywhere: no disclosure is asked)
    await h.eval(`(${H}.goto('online'), true)`); await sel(h, 'open'); await press(h, 'a');
    const hOn = await until(h, `${H}.apps.state().online.open === "on"`, 20000);
    await press(h, 'b'); await sleep(150);
    // the asker: another hub tab of this browser (the switch is stored on, so it is on from its load); it asks through the service, as the Trainer Center does
    await hubUp(x);
    const xOn = await until(x, `${H}.apps.state().online.open === "on"`, 20000);
    await x.eval(`(${H}.presence.watchPlayers(true), true)`);
    const seesOwner = () => until(x, `${H}.presence.players().some((p) => p.doing === 'menu')`, 15000);
    const ask = () => x.eval(`(() => { const S = ${H}.presence, pl = S.players().find((p) => p.doing === 'menu'); window.__ans = null; window.__chal = pl ? S.challenge(pl, { state() {}, accepted: (room) => { window.__ans = { ok: room }; }, failed: (why) => { window.__ans = { no: why }; } }) : null; return !!window.__chal; })()`);
    const answer = () => x.eval('window.__ans');
    // (somebody who was told no is answered no quietly for a while: the asker takes a new id on the board before it asks again)
    const newAsker = async () => { await x.eval(`${H}.presence.turnOff({ persist: false }).then(() => ${H}.presence.turnOn({ persist: false }))`); await until(x, `${H}.presence.isOn() && !!${H}.presence.boardId()`, 15000); await seesOwner(); };
    ok(hOn && xOn && (await seesOwner()), 'BQ0 (the rig) two hub tabs are open to battles and one sees the other', J([hOn, xOn]));

    // 1: on the main menu
    await front(h);
    const asked1 = (await ask()) && (await until(h, Q('presence:challenge')));
    const q1 = await q(h);
    await shot(h, 'ask-1-main-menu');
    await until(h, Q_ARMED('presence:challenge'), 5000);
    await key(h, 'b');
    const gone1 = await until(h, Q_GONE('presence:challenge'));
    await until(x, 'window.__ans !== null', 8000);
    ok(asked1 && (await where(h)) === 'main' && /wants to battle you/.test(q1.text) && gone1 && J(await answer()) === J({ no: 'declined' }) && (await noOnlineDom(h)).dialogs === 0,
      'BQ1 a challenge that arrives ON THE MAIN MENU is asked in the picture over it; B is NO and the asker is told', J([q1, await answer()]));

    // 2: on a Tower screen (the asker withdraws)
    await newAsker();
    await h.eval(`(${H}.goto('tower'), true)`); await sleep(200);
    await front(h);
    const asked2 = (await ask()) && (await until(h, Q('presence:challenge')));
    const at2 = await where(h);
    await shot(h, 'ask-2-tower');
    await x.eval('(window.__chal.cancel(), true)');
    const gone2 = await until(h, Q_GONE('presence:challenge'));
    ok(asked2 && at2 === 'tower' && gone2 && (await where(h)) === 'tower', 'BQ2 ... and ON A TOWER SCREEN, over it; the asker\'s cancel takes the question away and the Tower screen is as it was', J([asked2, at2, gone2]));

    // 3: inside a text entry
    await h.eval(`(${H}.goto('main'), ${H}.goto('online'), true)`);
    await sel(h, 'name'); await press(h, 'a'); await typeText(h, 'Ab');
    const typing = await h.eval(`${H}.wantsText()`);
    await front(h);
    const asked3 = (await ask()) && (await until(h, Q('presence:challenge')));
    const under = await h.eval(`({ wants: ${H}.wantsText(), under: ${H}.model.textUnder(), dropped: ${H}.dropped | 0 })`);
    await shot(h, 'ask-3-over-text-entry');
    await until(h, Q_ARMED('presence:challenge'), 5000);
    await h.press('z', 'KeyZ', 90, 30); await h.press('x', 'KeyX', 88, 30); await sleep(150);
    const after = await h.eval(`({ asked: ${Q('presence:challenge')}, dropped: ${H}.dropped | 0, value: (${H}.model.apps.online.state().entry) })`);
    await h.press('Escape', 'Escape', 27, 30);
    const gone3 = await until(h, Q_GONE('presence:challenge'));
    await until(x, 'window.__ans !== null', 8000);
    const e3 = await entry(h);
    ok(typing && asked3 && under.wants === false && under.under === true && after.asked === true && after.dropped >= under.dropped + 2 && gone3 && J(await answer()) === J({ no: 'declined' }) && e3 && e3.id === 'name' && e3.value === 'Ab' && (await h.eval(`${H}.wantsText()`)) === true,
      'BQ3 ... and INSIDE A TEXT ENTRY: the question covers it, the letters being typed (Z, X) neither answer it nor reach the field, Escape is NO, and the entry is still there with what was typed', J([under, after, e3, await answer()]));

    // 4: YES leaves for the battle
    await typeKey(h, 'escape');
    await newAsker();
    await front(h);
    const asked4 = (await ask()) && (await until(h, Q('presence:challenge')));
    await until(h, Q_ARMED('presence:challenge'), 5000);
    await first(h);
    await battleUp(h);
    await until(x, 'window.__ans !== null', 30000);
    const ans = await answer(), vh = await bst(h);
    ok(asked4 && ans && /^[A-Z0-9]{4,8}$/.test(ans.ok || '') && vh.path === '/pokemonarena/battle.html' && vh.role === 'host', 'BQ4 YES leaves for the battle page, which opens the room, and the asker is told the room', J([ans, vh.stage, vh.search]));
    ok(errs(h, x).length === 0, 'BQ5 no page errors', J(errs(h, x)).slice(0, 400));
  });
}

/* ---- blocked: sessionStorage refuses writes: the picture says so, GO ON opens the fallback address, the battle page starts nothing by itself ---- */
const BLOCK_SESSION = `(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (this === window.sessionStorage) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return set.call(this, k, v); }; })();`;
async function sBlocked(ok) {
  await withBrowser({ port: CDP0 + 5, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await addInit(p, BLOCK_SESSION);
    await hubUp(p);
    await p.eval(`(${H}.goto('online'), true)`);
    await sel(p, 'invite'); await press(p, 'a');
    const f1 = await firstOf(p, 'online:friend');          // (what the battle page connects to, then YES: only now is the token tried)
    const asked = await until(p, Q('online:blocked'));
    const stays = await p.eval('location.pathname');
    await until(p, Q_ARMED('online:blocked'), 5000);
    const pages = await qPages(p), ql = await q(p);
    await shot(p, 'blocked-1-question');
    ok(f1.asked && asked && stays === '/pokemonarena/' && /blocks the storage/.test(pages.join(' ')) && /Go on\?/.test(ql.text) && J(ql.options) === J(['GO ON', 'BACK']), 'BB1 with sessionStorage refusing every write, INVITE A FRIEND (after its YES) does not leave: the picture says the browser blocks the storage, and asks GO ON / BACK', J([pages, ql]));
    await press(p, 'b'); await sleep(300);
    ok(!(await q(p)) && (await p.eval('location.pathname')) === '/pokemonarena/' && (await where(p)) === 'online', 'BB2 BACK (B) stays in the menu', '');
    await press(p, 'a'); await firstOf(p, 'online:friend'); await until(p, Q_ARMED('online:blocked'), 5000); await qPages(p); await press(p, 'a');
    await battleUp(p);
    await sleep(2500);
    const v = await bst(p), u = new URLSearchParams(v.search);
    ok(u.get('online') === '1' && u.get('ask') === 'host' && u.get('net') === 'local' && v.stage === 'setup' && !v.room && v.tok === null, 'BB3 GO ON opens ?online=1&ask=host (never a bare ?online=1), and the battle page starts NOTHING by itself there', J(v));
    // JOIN A FRIEND: the plain invite address, with no meet=1
    await hubUp(p);
    await p.eval(`(${H}.goto('online'), true)`);
    await sel(p, 'join'); await press(p, 'a'); await typeText(p, 'K7Q2P'); await typeKey(p, 'enter');
    await firstOf(p, 'online:friend');
    const asked2 = await until(p, Q('online:blocked'));
    await until(p, Q_ARMED('online:blocked'), 5000); await qPages(p); await press(p, 'a');
    await battleUp(p);
    await sleep(2500);
    const v2 = await bst(p), u2 = new URLSearchParams(v2.search);
    ok(asked2 && u2.get('np') === 'K7Q2P' && u2.get('join') === '1' && u2.get('meet') === null && v2.stage === 'setup' && v2.role === 'guest' && v2.room === 'K7Q2P' && v2.phase === null, 'BB4 JOIN A FRIEND: the plain invite address ?np=ROOM&join=1 (no meet=1), where the battle page waits for a press', J(v2));
    ok(errs(p).length === 0, 'BB5 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- address: the invite screens from the hub's own address; a malformed room; BACK and a reload ---- */
async function sAddress(ok) {
  await withBrowser({ port: CDP0 + 6, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    // an old bookmark: no #screen in the address
    await p.navigate(hubUrl() + '?np=k7q2p&join=1&net=local');
    await hubWoke(p);
    const up = await until(p, `${H}.apps.state().online.screen === "invite" && ${H}.model.path() === "online"`);
    const s0 = await st(p), head = await p.eval(`${H}.view().online.head`), hist = await p.eval(`${H}.history()`);
    await shot(p, 'address-1-invited');
    ok(up && J(head) === J(["YOU'RE INVITED", 'ROOM K7Q2P']) && s0.row === 'team' && (await p.eval('location.hash')) === '#online' && J(hist.hist) === J(['online']) && J(await p.eval(`${A}.allRows().map((r) => r.id)`)) === J(['team', 'name', 'go', 'back']),
      'BD1 the hub page opened with ?np=ROOM&join=1 in its address goes to PLAY ONLINE and shows YOU\'RE INVITED / ROOM <CODE> (TEAM under the cursor, NAME, JOIN THE BATTLE, BACK), with a history entry of its own', J([s0, head, hist]));
    // BACK puts the room away; the address loses it; a reload does not bring it back
    await inviteArmed(p);
    await key(p, 'b'); await sleep(250);
    const s1 = await st(p), loc1 = await p.eval('location.search + location.hash');
    ok(s1.screen === 'menu' && (await where(p)) === 'online' && loc1 === '?net=local#online' && (await p.eval('sessionStorage.getItem("arena.online.away")')) === 'K7Q2P', 'BD2 Backspace (B) puts the room away: the PLAY ONLINE menu is shown, and the room has left the address', J([s1.screen, loc1]));
    await p.send('Page.reload', { ignoreCache: false }); await sleep(300);
    await hubWoke(p);
    ok((await st(p)).screen === 'menu' && (await st(p)).invite === null && (await where(p)) === 'online', 'BD3 a reload shows the menu, not the room', J(await st(p)));
    // ... nor does the browser's Back onto the older entry that still names it, reloaded
    await key(p, 'b');
    await until(p, `${H}.model.path() === "main" && ${H}.history().flying === false`, 5000);
    const older = await p.eval('location.search');
    await p.send('Page.reload', { ignoreCache: false }); await sleep(300);
    await hubWoke(p);
    await sleep(400);
    ok(/np=k7q2p/.test(older) && (await where(p)) === 'main' && (await st(p)).screen === 'menu' && (await st(p)).invite === null, 'BD4 ... nor a reload of the older history entry whose address still names the room: it STAYS away in this tab', J([older, await where(p), await st(p)]));
    // a fresh arrival with the same room (the battle page's CHANGE TEAM row) is a new invitation; JOIN THE BATTLE joins by itself
    await p.navigate(ORIGIN + '/pokemonarena/input.css');
    await p.navigate(hubUrl() + '?np=K7Q2P&join=1&net=local#online');
    await hubWoke(p);
    const fresh = await inviteArmed(p);
    await sel(p, 'team'); await press(p, 'a');          // (no saved team in this browser: TEAM offers the Team Builder; B comes back to the invitation)
    const builder = await where(p);
    await press(p, 'b'); await sleep(200);
    const backAt = await st(p);
    await sel(p, 'go'); await key(p, 'a');
    const jq = await firstOf(p, 'online:friend');          // (the first time in this browser: the whole notice, NO under the cursor)
    await battleUp(p);
    const joined = await until(p, 'window.__arenaOnline.state.stage !== "setup"', 20000);
    const v = await bst(p), u = new URLSearchParams(v.search);
    ok(fresh && builder === 'builder' && backAt.screen === 'invite' && backAt.row === 'team' && jq.asked && /You join room K7Q2P/.test(jq.text) && /IP address/.test(jq.text) && /Join room K7Q2P\?/.test(jq.text) && jq.on === 'NO' && u.get('np') === 'K7Q2P' && u.get('join') === '1' && joined && v.role === 'guest' && v.room === 'K7Q2P' && v.meet === null,
      'BD5 a FRESH arrival with that room is a new invitation; TEAM leads to the Team Builder and B back to the invitation (on TEAM); JOIN THE BATTLE says what joining connects to and asks; YES leaves for ?np=ROOM&join=1 and the battle page starts joining BY ITSELF', J([fresh, builder, jq.on, v.stage, v.search]));
    // the host's room
    await p.navigate(hubUrl() + '?np=AXYZ1&host=1&net=local#online');
    await hubWoke(p);
    const hostUp = await inviteArmed(p);
    const hh = await p.eval(`({ head: ${H}.view().online.head, rows: ${A}.allRows().map((r) => r.id), row: ${H}.apps.state().online.row })`);
    await shot(p, 'address-2-your-room');
    await key(p, 'down'); await key(p, 'down'); await key(p, 'down'); await key(p, 'a');          // TEAM, SIZE, NAME, OPEN THE ROOM
    const hq = await firstOf(p, 'online:friend');          // (this browser has said YES to the long notice: one page, YES under the cursor)
    await battleUp(p);
    const opened = await until(p, 'window.__arenaOnline.state.stage === "open"', 40000);
    const vh = await bst(p);
    ok(hostUp && J(hh.head) === J(['YOUR ROOM', 'ROOM AXYZ1']) && J(hh.rows) === J(['team', 'size', 'name', 'go', 'back']) && hh.row === 'team' && hq.asked && hq.text.includes('Room AXYZ1, over public servers.') && hq.text.includes('Open room AXYZ1?') && hq.on === 'YES' && opened && vh.role === 'host' && vh.room === 'AXYZ1' && vh.tok === null,
      'BD6 ?np=ROOM&host=1 shows YOUR ROOM (TEAM, SIZE, NAME, OPEN THE ROOM, BACK); OPEN THE ROOM asks OPEN ROOM AXYZ1? (one page now, YES first), and YES opens THAT room on the battle page by itself', J([hh, hq, vh.stage, vh.room]));
    // a room that is not one
    await p.navigate(hubUrl() + '?np=AB!CD&join=1&net=local');
    await hubWoke(p);
    const told = await until(p, Q_ARMED('online:note'));
    const words = (await qPages(p)).join(' ');
    await shot(p, 'address-3-refused');
    ok(told && /not a valid room code/.test(words) && /PLAY ONLINE menu/.test(words) && (await where(p)) === 'online' && (await st(p)).screen === 'menu', 'BD7 a room in the address that is not a room code is refused IN WORDS, in the picture, and the plain menu is shown', words);
    ok(errs(p).length === 0, 'BD8 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- swap: the invite screen takes the place of the menu BY ITSELF; a press that was on its way to the menu starts nothing ---- */
// (records, in the page, when the hub became usable and when the invite screen took the menu's place)
const TIMELINE = `(() => { const T = window.__tl = { ready: null, invite: null }; const tick = () => { try { const h = window.__arenaHub; if (h && h.state === 'ready') { if (T.ready === null) T.ready = performance.now(); const s = h.apps && h.apps.state().online; if (s && s.screen === 'invite' && h.model.path() === 'online' && T.invite === null) T.invite = performance.now(); } } catch (_e) { /* not up yet */ } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();`;
async function sSwap(ok) {
  await withBrowser({ port: CDP0 + 10, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await addInit(p, TIMELINE);
    await addInit(p, 'window.__arenaNavigate = (u) => { window.__nav = u; };');
    await hubUp(p);          // (the first load fetches and verifies the ROM; the next ones recall it, so the menu and the swap come quickly: the case a press in flight can hit)
    const runs = [];
    for (const [label, addr] of [['a friend\'s link to the hub, no #screen', '?np=EVIL7&join=1&net=local'], ['the battle page\'s CHANGE TEAM link', '?np=EVIL7&join=1&net=local#online'], ['a host link', '?np=EVIL7&host=1&net=local']]) {
      for (const delay of [0, 40, 90, 160, 280, 450]) {
        await p.navigate(ORIGIN + '/pokemonarena/input.css'); await p.eval('(sessionStorage.clear(), true)');
        await p.navigate(hubUrl() + addr, { waitMs: 100 });
        await p.waitFor('window.__tl && window.__tl.ready !== null', { timeoutMs: 60000, pollMs: 10 });
        await sleep(delay);
        await p.press('z', 'KeyZ', 90, 20);                 // A ...
        await p.press('Enter', 'Enter', 13, 20);            // ... and START / Enter, a double press
        await sleep(900);
        runs.push(await p.eval(`(() => { const s = ${H}.apps.state().online, d = ${H}.dialog.current(); return { label: ${J(label)}, delay: ${delay}, path: ${H}.model.path(), screen: s.screen, row: s.row, nav: window.__nav || null, meet: sessionStorage.getItem('arena.meet'), go: sessionStorage.getItem('arena.go'), asked: d ? d.id : null, gap: window.__tl.invite === null ? null : Math.round(window.__tl.invite - window.__tl.ready) }; })()`));
      }
    }
    const bad = runs.filter((r) => r.nav !== null || r.meet !== null || r.go !== null || r.asked === 'online:friend');
    ok(runs.length === 18 && bad.length === 0, 'BS1 A LINK TO THE HUB WITH A ROOM IN IT, PLUS A PRESS, JOINS NOBODY: A and Enter pressed 0 to 450 ms after the hub became usable (three kinds of link, six delays) start nothing: no MEET or START token, no navigation, not even the question', J(bad.length ? bad : runs.map((r) => [r.delay, r.path, r.screen, r.gap])));
    const landed = runs.filter((r) => r.path === 'online' && r.screen === 'invite' && r.gap !== null && r.gap < r.delay);
    ok(landed.length >= 3, 'BS2 (the rig) in several of those loads the invite screen was already up when the keys were pressed (the press landed ON it, in its first 0.6 s): the check is not vacuous', J(runs.map((r) => [r.delay, r.gap, r.path])));
    // ... and once it listens, nothing but a deliberate walk to the button and a YES joins: the cursor is on TEAM
    const rest = [];
    for (const addr of ['?np=EVIL7&join=1&net=local', '?np=EVIL7&join=1&net=local#online']) {
      await p.navigate(ORIGIN + '/pokemonarena/input.css'); await p.eval('(sessionStorage.clear(), true)');
      await p.navigate(hubUrl() + addr);
      await hubWoke(p);
      const armed = await inviteArmed(p);
      const s = await st(p);
      rest.push([armed, s.row, s.armed, await p.eval('window.__nav || null')]);
    }
    await shot(p, 'swap-1-invite-armed');
    ok(rest.every((r) => r[0] && r[1] === 'team' && r[2] === true && r[3] === null), 'BS3 when it starts to listen the cursor is on TEAM, not on JOIN THE BATTLE (a link with no #screen, and one that opens at #online)', J(rest));
    ok(errs(p).length === 0, 'BS4 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- devices: a touch-only phone and a controller reach every row ---- */
async function sDevices(ok) {
  const rectOf = (p, id) => p.eval(`(() => { const r = ${H}.model.rects().find((x) => x.id === ${J(id)}); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h } : null; })()`);
  await memoryGate('devices: phone');
  await withBrowser({ port: CDP0 + 7, width: 390, height: 844, mobile: true, lock: false, args: NO_THROTTLE }, async (p) => {
    await hubUp(p);
    await p.eval('(window.__arenaNavigate = (u) => { window.__nav = u; }, true)');
    const tapRow = async (id, dx = 0) => { const r = await rectOf(p, id); if (!r) return false; await tapLogical(p, `${H}.canvas`, r.x + dx, r.y); await sleep(220); return true; };
    // the main menu's row: its third
    const m = await p.eval(`${H}.model.rects()[2]`);
    await tapLogical(p, `${H}.canvas`, m.x + 40, m.y + m.h / 2); await sleep(700);          // (the on-screen pad appears with the first touch and the picture is laid out again)
    const got = {};
    got.menu = (await where(p)) === 'online';
    await shot(p, 'devices-1-phone-menu');
    got.center = (await tapRow('center')) && (await where(p)) === 'center'; await tapSel(p, '#bB'); await sleep(250);
    got.anyone = (await tapRow('anyone')) && !!(await q(p)) && (await q(p)).id === 'online:quick'; await tapSel(p, '#bB'); await sleep(250);
    // INVITE A FRIEND: one tap on its row asks (it does not leave); taps on the words turn the pages, a tap on YES answers
    got.inviteAsks = (await tapRow('invite')) && ((await q(p)) || {}).id === 'online:friend' && !(await p.eval('window.__nav'));
    for (let i = 0; i < 16; i++) { const d = await q(p); if (!d || d.page >= d.pages - 1) break; await tapLogical(p, `${H}.canvas`, 120, 136); await sleep(160); }
    await tapLogical(p, `${H}.canvas`, 120, 136); await sleep(160);          // (one more tap on the words, on the question's own page: a tap on the text never answers)
    const strayTap = ((await q(p)) || {}).id === 'online:friend' ? await p.eval('window.__nav || null') : 'THE QUESTION WAS ANSWERED BY A TAP ON ITS TEXT';
    const yes = await p.eval(`${H}.model.rects()[0]`);
    await tapLogical(p, `${H}.canvas`, yes.x + yes.w / 2, yes.y + yes.h / 2); await sleep(250);
    got.invite = strayTap === null && /battle\.html\?online=1&net=local$/.test((await p.eval('window.__nav')) || '');
    got.join = (await tapRow('join')) && ((await entry(p)) || {}).id === 'room';
    // (the keys of the entry are taps too: a letter, then CANCEL)
    const k = await p.eval(`(() => { const r = ${H}.model.rects(); const a = r.find((x) => x.id === 'K'), c = r.find((x) => x.id === 'cancel'); return { a: { x: a.x + a.w / 2, y: a.y + a.h / 2 }, c: { x: c.x + c.w / 2, y: c.y + c.h / 2 } }; })()`);
    await tapLogical(p, `${H}.canvas`, k.a.x, k.a.y); await sleep(200);
    got.key = ((await entry(p)) || {}).value === 'K';
    await tapLogical(p, `${H}.canvas`, k.c.x, k.c.y); await sleep(250);
    got.cancel = (await entry(p)) === null;
    const t0 = (await st(p)).fmt;
    got.size = (await tapRow('size', 40)) && (await st(p)).fmt !== t0;
    got.team = (await tapRow('team')) && (await where(p)) === 'builder'; await tapSel(p, '#bB'); await sleep(250);          // (no saved team in this browser: the row offers the Team Builder)
    got.name = (await tapRow('name')) && ((await entry(p)) || {}).id === 'name'; await typeKey(p, 'escape');
    got.open = (await tapRow('open')) && (await until(p, `${H}.apps.state().online.open === "on"`, 20000));
    got.openOff = (await tapRow('open')) && (await until(p, `${H}.apps.state().online.open === "off"`, 10000));
    // the ninth row is below the eight shown: the on-screen d-pad walks there, the on-screen A presses it
    await sel(p, 'center');
    for (let i = 0; i < 8; i++) { await tapSel(p, '#bDown'); await sleep(130); }
    got.padDown = (await st(p)).row === 'back';
    await shot(p, 'devices-2-phone-scrolled');
    await tapSel(p, '#bA'); await sleep(300);
    got.back = (await where(p)) === 'main';
    // how big a row is under a thumb
    const size = await p.eval(`(() => { const c = ${H}.canvas.getBoundingClientRect(); return { rowCss: Math.round(12 * c.height / 160), width: Math.round(c.width) }; })()`);
    ok(Object.values(got).every(Boolean), 'BV1 A TOUCH-ONLY PHONE (390x844, taps on the picture and on the on-screen pad, nothing else) reaches every row: TRAINER CENTER, BATTLE ANYONE, INVITE A FRIEND, JOIN A FRIEND and its keys, TEAM, SIZE, NAME, OPEN TO BATTLES on and off, and BACK below the fold', J(got));
    ok(size.width >= 380 && size.rowCss >= 19, 'BV2 the picture runs edge to edge; a row is ' + size.rowCss + ' css px tall under a thumb (12 logical px, the spacing of the main menu too: a known limit, and why the on-screen pad is there)', J(size));
    ok(p.arm.ok && errs(p).length === 0, 'BV3 no page errors (and the arm is a phone: hover none, pointer coarse)', J(errs(p)).slice(0, 400));
  });
  await memoryGate('devices: pad');
  await withBrowser({ port: CDP0 + 8, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    await addInit(p, PAD_DOUBLE);
    await hubUp(p);
    await p.eval(`(window.dispatchEvent(new Event('gamepadconnected')), true)`);
    await p.eval('(window.__arenaNavigate = (u) => { window.__nav = u; }, true)');
    const PAD = { a: 0, b: 1, up: 12, down: 13, left: 14, right: 15 };
    await padPress(p, PAD.down); await padPress(p, PAD.down); await padPress(p, PAD.a); await sleep(200);
    const rows = [(await st(p)).row];
    for (let i = 0; i < 8; i++) { await padPress(p, PAD.down); rows.push((await st(p)).row); }
    ok((await where(p)) === 'online' && J(rows) === J(['center', 'anyone', 'invite', 'join', 'team', 'size', 'name', 'open', 'back']), 'BV4 A CONTROLLER ALONE walks every row with the d-pad', J(rows));
    await padPress(p, PAD.up); await padPress(p, PAD.a);
    const on = await until(p, `${H}.apps.state().online.open === "on"`, 20000);
    await padPress(p, PAD.up); await padPress(p, PAD.a); await sleep(200);
    const e = await entry(p);
    await padPress(p, PAD.a); await sleep(120);          // A types the key under the cursor ("A")
    const e2 = await entry(p);
    await p.eval(`(window.__pad.buttons[9] = 1, true)`); await sleep(160); await p.eval(`(window.__pad.buttons[9] = 0, true)`); await sleep(200);          // START = OK
    const named = (await st(p)).typed;
    await padPress(p, PAD.up); await padPress(p, PAD.right); await sleep(150);
    const fmt = (await st(p)).fmt;
    for (let i = 0; i < 3; i++) await padPress(p, PAD.up);
    await padPress(p, PAD.a); await sleep(200);
    // INVITE A FRIEND asks first: A turns the pages of the notice, the d-pad goes up to YES, A answers
    const asks = await q(p), navEarly = await p.eval('window.__nav || null');
    for (let i = 0; i < 16; i++) { const d = await q(p); if (!d || d.page >= d.pages - 1) break; await padPress(p, PAD.a); }
    const onNo = ((await q(p)) || {}).on;
    await padPress(p, PAD.up); await padPress(p, PAD.a); await sleep(200);
    const nav = await p.eval('window.__nav');
    await padPress(p, PAD.b); await sleep(300);
    ok(on && e && e.id === 'name' && e2 && e2.value === 'A' && named === 'A' && fmt === '6v6' && asks && asks.id === 'online:friend' && navEarly === null && onNo === 'NO' && /battle\.html\?online=1&net=local$/.test(nav || '') && (await where(p)) === 'main', 'BV5 ... switches OPEN TO BATTLES, types a name on the picture\'s keys (A types, START accepts), changes SIZE, reads the notice of INVITE A FRIEND and answers YES (up, A), and B leaves the menu', J([on, e2, named, fmt, asks && asks.id, onNo, nav, await where(p)]));
    ok(errs(p).length === 0, 'BV6 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- html: the page has no online control ---- */
async function sHtml(ok) {
  await withBrowser({ port: CDP0 + 9, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    const html = await (await fetch(hubUrl())).text();
    ok(!/onlineLink|playFriend|trainerCenter|openToggle/.test(html) && !/battle\.html\?online/.test(html), 'BH1 the page that is SERVED has no #onlineLink, #playFriend, #trainerCenter or #openToggle, and no link to the online battle page', '');
    await hubUp(p);
    const d0 = await noOnlineDom(p);
    await p.eval(`(${H}.goto('online'), true)`);
    await sel(p, 'open'); await press(p, 'a');
    await until(p, `${H}.apps.state().online.open === "on"`, 20000);
    await sel(p, 'anyone'); await press(p, 'a');
    const d1 = await noOnlineDom(p);
    const under = await p.eval(`[...document.body.children].filter((e) => !['SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK'].includes(e.tagName) && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0).map((e) => e.id || e.tagName.toLowerCase())`);
    await press(p, 'b');
    const rows = await p.eval(`${A}.allRows().map((r) => r.label)`);
    ok(J(d0) === J({ row: 0, links: 0, dialogs: 0 }) && J(d1) === J({ row: 0, links: 0, dialogs: 0 }), 'BH2 nothing creates them either: with the menu open, OPEN TO BATTLES on and the BATTLE ANYONE notice up, the document has no online control, link or dialog', J([d0, d1]));
    ok(J(rows) === J(['TRAINER CENTER', 'BATTLE ANYONE', 'INVITE A FRIEND', 'JOIN A FRIEND', 'TEAM', 'SIZE', 'NAME', 'OPEN TO BATTLES', 'BACK']), 'BH3 ... because they are rows of the picture', J(rows));
    ok(under.every((id) => ['top', 'play', 'note', 'romStatus', 'keys', 'live', 'soundPrompt', 'fullExit'].includes(id) || /^(main|header|div|p)$/.test(id)), 'BH4 what the page shows around the picture is the header, the picture with its pad, and the footer lines', J(under));
    ok(errs(p).length === 0, 'BH5 no page errors', J(errs(p)).slice(0, 400));
  });
}

const SESSIONS = { html: sHtml, open: sOpen, address: sAddress, swap: sSwap, blocked: sBlocked, invite: sInvite, anyone: sAnyone, ask: sAsk, devices: sDevices };

/* ================================================================================================ the browser mutants */
// One defect each, in a copy of the game that an overlay serves in front of the dev server (tools/pokemonarena_overlay.mjs); the session named is run against it and must fail the case named.
// They are the guards only a real page can prove: a real key that lands on a screen that has only just taken another's place, what the board hears against what the picture said.
export const BROWSER_MUTANTS = [
  { id: 'swap-as-reviewed', run: 'swap', fails: 'BS1', file: 'js/online_hub.js', what: 'the invite screen listens at once, with the cursor on the button (the defect the review found: a link plus one press joined the room)',
    from: '      S.arm = ok ? INVITE_ARM_TICKS : 0;\n', to: "      S.arm = 0;\n      if (ok) selectRow('go');\n" },
  { id: 'swap-on-button', run: 'swap', fails: 'BS3', file: 'js/online_hub.js', what: 'the invite screen opens with the cursor on the button that joins',
    from: '      S.arm = ok ? INVITE_ARM_TICKS : 0;\n', to: "      S.arm = ok ? INVITE_ARM_TICKS : 0;\n      if (ok) selectRow('go');\n" },
  { id: 'invite-unasked', run: 'invite', fails: 'BI4a', file: 'js/online_hub.js', what: 'INVITE A FRIEND leaves for the battle page at once (it connects to the public servers with nothing said)',
    from: "case 'invite': return askFriend('host', null, false);", to: "case 'invite': return start('host', null);" },
  { id: 'join-question-unarmed', run: 'invite', fails: 'BI6a', file: 'js/online_hub.js', what: 'the question that follows the room code answers the Enter that was still on its way',
    from: '...(late ? { armTicks: DIALOG_ARM_TICKS } : {}) });', to: '});' },
  { id: 'open-names-the-name-row', run: 'open', fails: 'BO0', file: 'js/online_hub.js', what: 'the menu says OPEN TO BATTLES lists the NAME row\'s name (the board hears the trainer\'s)',
    from: "return onlineName(act ? act.name : '', 'Player');", to: "return nameNow(selection()).text || 'Player';" },
  { id: 'anyone-names-the-trainer', run: 'anyone', fails: 'BA4b', file: 'js/online_hub.js', what: 'BATTLE ANYONE says the trainer\'s name is listed (the board hears the NAME row\'s)',
    from: "const quickWho = (sel) => ({ name: nameNow(sel).text || 'Host',", to: 'const quickWho = (sel) => ({ name: trainerListed(),' },
];

async function runBrowserMutants(ok, wanted, one) {
  const { copyTree, mutateFile, startOverlay } = await import('./pokemonarena_overlay.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ho-bmut-'));
  const shotsWere = SHOTS;
  SHOTS = false;
  let killed = 0, ran = 0;
  try {
    for (const mu of BROWSER_MUTANTS) {
      if ((wanted.length && !wanted.includes(mu.run)) || (one && mu.id !== one)) continue;
      ran++;
      const failed = [];
      const rec = (cond, name, detail) => { if (!cond) failed.push(name + (detail ? ' :: ' + String(detail).slice(0, 200) : '')); };
      const dir = copyTree(path.join(L.root, 'pokemonarena'), path.join(tmp, mu.id));
      let ov = null;
      const t0 = Date.now();
      try {
        try { mutateFile(dir, mu.file, mu.from, mu.to); } catch (e) { ok(false, 'BMUT ' + mu.id + ' could not be applied', e.message); continue; }
        ov = await startOverlay({ dir, port: L.PORT + 40, upstream: BASE });
        ORIGIN = ov.url;
        await memoryGate('mutant ' + mu.id);
        try { await SESSIONS[mu.run](rec); } catch (e) { failed.push('B session ' + mu.run + ' crashed :: ' + (e && e.message ? e.message : String(e)).slice(0, 200)); }
      } finally { ORIGIN = BASE; if (ov) ov.stop(); }
      const hit = failed.find((f) => f.startsWith(mu.fails + ' '));
      ok(!!hit, 'BMUT ' + mu.id + ' (' + mu.what + ') fails ' + mu.fails, hit ? '' : 'it did NOT: failed cases = ' + J(failed.map((f) => f.slice(0, 70))));
      console.log('  ' + (hit ? 'killed  ' : 'SURVIVED') + ' ' + mu.id + ' [' + mu.run + ' -> ' + mu.fails + ', ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s]' + (hit ? '' : '  failed: ' + J(failed.map((f) => f.split(' ')[0]))));
      if (hit) killed++;
    }
  } finally { SHOTS = shotsWere; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  console.log(`browser mutants: ${killed}/${ran} killed by the case they name`);
}

/** names: the sessions to run (none = all). mutants: ALSO run BROWSER_MUTANTS (those whose session is among `names`, or all); one: only the mutant with this id. onlyMutants: skip the plain sessions. */
export async function runBrowser({ ok, names = [], mutants = false, one = '', onlyMutants = false }) {
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = names.filter((n) => Object.prototype.hasOwnProperty.call(SESSIONS, n));
  const server = await L.startServer('/pokemonarena/');
  try {
    for (const [name, fn] of Object.entries(SESSIONS)) {
      if (onlyMutants || (wanted.length && !wanted.includes(name))) continue;
      await memoryGate(name);
      const t0 = Date.now();
      try { await fn(ok); } catch (e) { ok(false, 'B session ' + name + ' crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
      console.log('  [' + name + '] ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    }
    if (mutants) await runBrowserMutants(ok, wanted, one);
  } finally { L.stopServer(server); }
  console.log('screenshots: ' + OUT);
}
