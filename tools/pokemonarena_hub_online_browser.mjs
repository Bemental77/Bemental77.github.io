// tools/pokemonarena_hub_online_browser.mjs -- the BROWSER half of tools/pokemonarena_hub_online_test.mjs (that file's header lists the sessions; it imports this one). TEST-ONLY.
//
// Real headless Chrome through tools/headless_cdp.mjs (muted, a throwaway profile, bare CDP), one browser at a time. Two players are two tabs of that one browser, paired by the same-browser
// transport (net=local), as tools/pokemonarena_online_page_test.mjs does. The HUB is driven through window.__arenaHub, real keys, real taps and a synthetic controller. THE BATTLE PAGE IS READ
// ONLY THROUGH ITS HOOKS (window.__arenaOnline: state, nm(); window.__arenaBattle.state) and its address: never through a DOM id of its panel, which another team is replacing with screens in the
// battle canvas. What a session needs of that page is what the one-time tokens start.
//
// TWO TABS SHARE ONE BROWSER PROFILE, so they share localStorage: the online preferences and the typed name are one value for both "players". The sessions therefore go in order (player A
// chooses and leaves for the battle page, which reads its choices as it comes up; only then does player B choose).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withBrowser } from './headless_cdp.mjs';
import * as L from './pokemonarena_hub_lib.mjs';

const { BASE, CDP0, sleep, J, key, tapLogical, padPress, PAD_DOUBLE, addInit, tapSel } = L;
const OUT = process.env.ARENA_OUT || path.join(os.tmpdir(), 'arena-hub-online-shots');
const SHOTS = process.env.ARENA_SKIP_SHOTS !== '1';
const HUBURL = BASE + '/pokemonarena/';
const H = 'window.__arenaHub', A = H + '.model.apps.online';
const NO_THROTTLE = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=BackForwardCache'];
const CHANNEL = 'bemental-arena-open-1';
const MIN_FREE_MB = 3500;

/** Four tracks share this machine and a browser session takes about 1.3 GB: under MIN_FREE_MB free, wait 90 s and read again (pokemonarena/INAPP.md "Working rules"). */
async function memoryGate(label) {
  for (let i = 0; i < 20; i++) {
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
  await p.navigate(HUBURL + '?net=local' + query + hash);
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
/** The first option, the long way: A to the last page, the d-pad up onto it, A. */
const first = (p) => p.eval(`(() => { const d = ${H}.dialog.current(); if (!d) return false; for (let i = d.page; i < d.pages - 1; i++) ${H}.press('a'); ${H}.press('up'); ${H}.press('a'); return true; })()`);
const noOnlineDom = (p) => p.eval(`({ row: document.querySelectorAll('#onlineLink, #playFriend, #trainerCenter, #openToggle').length, links: document.querySelectorAll('a[href*="battle.html?online"], a[href*="center.html"]').length, dialogs: document.querySelectorAll('#challenge, #openInfo, .arena-chal').length })`);
const mainRow = (p) => p.eval(`(() => { const m = ${H}.view().menu; const r = m ? m.rows.find((x) => x.id === 'online') : null; return r ? r.label : null; })()`);

/* ------------------------------------------------------------------------------------------------ the board, and the battle page through its hooks */
const spyOn = async (p) => { await p.navigate(BASE + '/pokemonarena/input.css'); await p.eval(`(() => { window.__spy = []; const c = new BroadcastChannel(${J(CHANNEL)}); c.onmessage = (e) => window.__spy.push(e.data); window.__spyCh = c; return true; })()`); };
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
    // INVITE A FRIEND: four rows up, Enter. The page leaves; the battle page opens a private room BY ITSELF.
    for (let i = 0; i < 4; i++) await key(a, 'up');
    const s3 = await st(a);
    await key(a, 'a');
    await battleUp(a);
    const opened = await until(a, 'window.__arenaOnline.state.stage === "open"', 40000);
    const v = await bst(a), u = new URLSearchParams(v.search);
    ok(s3.row === 'invite' && opened && v.role === 'host' && /^[A-Z0-9]{4,8}$/.test(v.room || '') && v.tok === null && u.get('ask') === null && u.get('net') === 'local' && !v.open && !v.quick && (await spied(spy)).filter((m) => m && m.k === 'open' && m.room === v.room).length === 0,
      'BI4 INVITE A FRIEND leaves for the battle page, which OPENS A PRIVATE ROOM BY ITSELF (the one-time token is used up, nothing asks, the room is not on the board)', J(v));
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
    await typeKey(b, 'enter');
    await battleUp(b);
    const [pa, pb] = await bothPlaying(a, b);
    const ub = new URLSearchParams(pb.search);
    ok(sb.team === 'random' && sb.typed === 'Misty' && eb && eb.id === 'room' && eb.value === v.room && ub.get('np') === v.room && ub.get('join') === '1' && pb.meet === null && pa.phase === 'playing' && pb.phase === 'playing',
      'BI6 JOIN A FRIEND: the room code typed in the picture (lower case is typed as capitals) leaves for ?np=ROOM&join=1, the battle page joins BY ITSELF, and THE BATTLE IS ON ON BOTH SCREENS', J([pa.phase, pb.phase, pb.search]));
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
    await sel(a, 'anyone'); await press(a, 'a');
    const q0 = await q(a);
    await shot(a, 'anyone-1-notice');
    const pages = await qPages(a), text = pages.join(' '), q1 = await q(a);
    await shot(a, 'anyone-2-question');
    ok(q0 && q0.id === 'online:quick' && pages.length > 3 && /trainer name/.test(text) && /online record/.test(text) && /IP address/.test(text) && /broker\.emqx\.io/.test(text) && /cdnjs\.cloudflare\.com/.test(text) && q1.on === 'NO' && J(q1.options) === J(['YES', 'NO']) && /Find an opponent\?/.test(q1.text),
      'BA1 BATTLE ANYONE first says, in the picture, what other players will see and which public servers the battle page connects to; then FIND AN OPPONENT? with NO under the cursor', J([pages.length, q1]));
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
    // the second player: the same row. This browser has said YES before, so the notice is the short one
    await front(b);
    await hubUp(b, '&openquick=500');
    await b.eval(`(${H}.goto('online'), true)`);
    await sel(b, 'anyone'); await press(b, 'a');
    const pb = await qPages(b), qb = await q(b);
    ok(pb.length <= 3 && /trainer name/.test(pb.join(' ')) && qb.on === 'NO', 'BA5 a browser that has said YES before gets the short notice, and the same question with NO first', J(pb));
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
    await key(p, 'down'); await key(p, 'down'); await key(p, 'a'); await sleep(200);
    for (let i = 0; i < 7; i++) await key(p, 'down');
    const r0 = await row(p, 'open');
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
    const asked = await until(p, Q('online:blocked'));
    const stays = await p.eval('location.pathname');
    await until(p, Q_ARMED('online:blocked'), 5000);
    const pages = await qPages(p), ql = await q(p);
    await shot(p, 'blocked-1-question');
    ok(asked && stays === '/pokemonarena/' && /blocks the storage/.test(pages.join(' ')) && /Go on\?/.test(ql.text) && J(ql.options) === J(['GO ON', 'BACK']), 'BB1 with sessionStorage refusing every write, INVITE A FRIEND does not leave: the picture says the browser blocks the storage, and asks GO ON / BACK', J([pages, ql]));
    await press(p, 'b'); await sleep(300);
    ok(!(await q(p)) && (await p.eval('location.pathname')) === '/pokemonarena/' && (await where(p)) === 'online', 'BB2 BACK (B) stays in the menu', '');
    await press(p, 'a'); await until(p, Q_ARMED('online:blocked'), 5000); await qPages(p); await press(p, 'a');
    await battleUp(p);
    await sleep(2500);
    const v = await bst(p), u = new URLSearchParams(v.search);
    ok(u.get('online') === '1' && u.get('ask') === 'host' && u.get('net') === 'local' && v.stage === 'setup' && !v.room && v.tok === null, 'BB3 GO ON opens ?online=1&ask=host (never a bare ?online=1), and the battle page starts NOTHING by itself there', J(v));
    // JOIN A FRIEND: the plain invite address, with no meet=1
    await hubUp(p);
    await p.eval(`(${H}.goto('online'), true)`);
    await sel(p, 'join'); await press(p, 'a'); await typeText(p, 'K7Q2P'); await typeKey(p, 'enter');
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
    await p.navigate(HUBURL + '?np=k7q2p&join=1&net=local');
    await hubWoke(p);
    const up = await until(p, `${H}.apps.state().online.screen === "invite" && ${H}.model.path() === "online"`);
    const s0 = await st(p), head = await p.eval(`${H}.view().online.head`), hist = await p.eval(`${H}.history()`);
    await shot(p, 'address-1-invited');
    ok(up && J(head) === J(["YOU'RE INVITED", 'ROOM K7Q2P']) && s0.row === 'go' && (await p.eval('location.hash')) === '#online' && J(hist.hist) === J(['online']) && J(await p.eval(`${A}.allRows().map((r) => r.id)`)) === J(['team', 'name', 'go', 'back']),
      'BD1 the hub page opened with ?np=ROOM&join=1 in its address goes to PLAY ONLINE and shows YOU\'RE INVITED / ROOM <CODE> (TEAM, NAME, JOIN THE BATTLE, BACK), with a history entry of its own', J([s0, head, hist]));
    // BACK puts the room away; the address loses it; a reload does not bring it back
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
    await p.navigate(BASE + '/pokemonarena/input.css');
    await p.navigate(HUBURL + '?np=K7Q2P&join=1&net=local#online');
    await hubWoke(p);
    const fresh = await until(p, `${H}.apps.state().online.screen === "invite"`);
    await sel(p, 'team'); await press(p, 'a');          // (no saved team in this browser: TEAM offers the Team Builder; B comes back to the invitation)
    const builder = await where(p);
    await press(p, 'b'); await sleep(200);
    const backAt = await st(p);
    await sel(p, 'go'); await key(p, 'a');
    await battleUp(p);
    const joined = await until(p, 'window.__arenaOnline.state.stage !== "setup"', 20000);
    const v = await bst(p), u = new URLSearchParams(v.search);
    ok(fresh && builder === 'builder' && backAt.screen === 'invite' && u.get('np') === 'K7Q2P' && u.get('join') === '1' && joined && v.role === 'guest' && v.room === 'K7Q2P' && v.meet === null,
      'BD5 a FRESH arrival with that room is a new invitation; TEAM leads to the Team Builder and B back to the invitation; JOIN THE BATTLE leaves for ?np=ROOM&join=1 and the battle page starts joining BY ITSELF', J([fresh, builder, v.stage, v.search]));
    // the host's room
    await p.navigate(HUBURL + '?np=AXYZ1&host=1&net=local#online');
    await hubWoke(p);
    const hostUp = await until(p, `${H}.apps.state().online.screen === "invite"`);
    const hh = await p.eval(`({ head: ${H}.view().online.head, rows: ${A}.allRows().map((r) => r.id) })`);
    await shot(p, 'address-2-your-room');
    await key(p, 'a');
    await battleUp(p);
    const opened = await until(p, 'window.__arenaOnline.state.stage === "open"', 40000);
    const vh = await bst(p);
    ok(hostUp && J(hh.head) === J(['YOUR ROOM', 'ROOM AXYZ1']) && J(hh.rows) === J(['team', 'size', 'name', 'go', 'back']) && opened && vh.role === 'host' && vh.room === 'AXYZ1' && vh.tok === null, 'BD6 ?np=ROOM&host=1 shows YOUR ROOM (TEAM, SIZE, NAME, OPEN THE ROOM, BACK), and OPEN THE ROOM opens THAT room on the battle page by itself', J([hh, vh.stage, vh.room]));
    // a room that is not one
    await p.navigate(HUBURL + '?np=AB!CD&join=1&net=local');
    await hubWoke(p);
    const told = await until(p, Q('notice:online'));
    const words = (await qPages(p)).join(' ');
    await shot(p, 'address-3-refused');
    ok(told && /not a valid room code/.test(words) && /PLAY ONLINE menu/.test(words) && (await where(p)) === 'online' && (await st(p)).screen === 'menu', 'BD7 a room in the address that is not a room code is refused IN WORDS, in the picture, and the plain menu is shown', words);
    ok(errs(p).length === 0, 'BD8 no page errors', J(errs(p)).slice(0, 400));
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
    got.invite = (await tapRow('invite')) && /battle\.html\?online=1&net=local$/.test((await p.eval('window.__nav')) || '');
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
    const nav = await p.eval('window.__nav');
    await padPress(p, PAD.b); await sleep(300);
    ok(on && e && e.id === 'name' && e2 && e2.value === 'A' && named === 'A' && fmt === '6v6' && /battle\.html\?online=1&net=local$/.test(nav || '') && (await where(p)) === 'main', 'BV5 ... switches OPEN TO BATTLES, types a name on the picture\'s keys (A types, START accepts), changes SIZE, starts INVITE A FRIEND, and B leaves the menu', J([on, e2, named, fmt, nav, await where(p)]));
    ok(errs(p).length === 0, 'BV6 no page errors', J(errs(p)).slice(0, 400));
  });
}

/* ---- html: the page has no online control ---- */
async function sHtml(ok) {
  await withBrowser({ port: CDP0 + 9, width: 900, height: 760, lock: false, args: NO_THROTTLE }, async (p) => {
    const html = await (await fetch(HUBURL)).text();
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

const SESSIONS = { html: sHtml, open: sOpen, address: sAddress, blocked: sBlocked, invite: sInvite, anyone: sAnyone, ask: sAsk, devices: sDevices };

export async function runBrowser({ ok, names = [] }) {
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = names.filter((n) => Object.prototype.hasOwnProperty.call(SESSIONS, n));
  const server = await L.startServer('/pokemonarena/');
  try {
    for (const [name, fn] of Object.entries(SESSIONS)) {
      if (wanted.length && !wanted.includes(name)) continue;
      await memoryGate(name);
      const t0 = Date.now();
      try { await fn(ok); } catch (e) { ok(false, 'B session ' + name + ' crashed', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
      console.log('  [' + name + '] ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    }
  } finally { L.stopServer(server); }
  console.log('screenshots: ' + OUT);
}
