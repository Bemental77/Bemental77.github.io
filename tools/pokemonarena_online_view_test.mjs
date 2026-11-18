// tools/pokemonarena_online_view_test.mjs -- THE BATTLE PAGE'S ONLINE SCREENS (pokemonarena/js/online_view.js: what the page shows, the rows, the layout, the cursor; js/online_draw.js: the pixels,
// from the ROM), in Node, with the real ROM renderer.
//
//   node tools/pokemonarena_online_view_test.mjs             the cases
//   node tools/pokemonarena_online_view_test.mjs --mutants   ALSO break online_view.js / online_draw.js one way at a time; every break must fail the case it names
//   node tools/pokemonarena_online_view_test.mjs --update    rewrite pokemonarena/online_screens.golden.json (frame HASHES only: nothing of the ROM is stored)
//   ARENA_OUT=<dir>                                          also write every screen as a PNG there (3x), to look at
//
// What is proved: each address without the hub's token has its own confirm screen and rows (V); a wait shows who, what, the steps, the code and only the rows that can be pressed then, and a
// battle hides the screen (W); the cursor wraps, A presses, a row that cannot be pressed refuses, B is BACK on a confirm screen and NEVER closes a wait, the cursor keeps its row when a row
// appears, the pointer highlights and presses (P); nothing overlaps and everything is inside the 240x160 picture (L); EVERY sentence the page can say fits its window, in the normal ROM font
// where the layout was made for it (F); the renderer draws every screen from the ROM, the code large, the cursor where the model says (D, with golden frame hashes); the screen reader's words
// leave out the clock (S); and the page files hold no panel any more (X). The page half (real tabs, real keys) is tools/pokemonarena_online_page_test.mjs, groups `easyjoin` and `screens`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from './pokemonarena_hub_lib.mjs';
import { writePNG, scaleRGBA } from './arena_png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const GOLDEN = path.join(root, 'pokemonarena', 'online_screens.golden.json');
const WANT_MUTANTS = process.argv.includes('--mutants'), UPDATE = process.argv.includes('--update');
const OUT = process.env.ARENA_OUT || '';
const J = (x) => JSON.stringify(x);
let pass = 0, fail = 0;
const failures = [];
let quiet = false;
function ok(cond, name, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); if (!quiet) console.log('FAIL', name, detail ? String(detail).slice(0, 300) : ''); } }
const fnv = (u8) => { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0; return h.toString(16).padStart(8, '0'); };

const HS = await L.mod('hub_screen.js'), B = await L.mod('battle_ui.js');
const ui = B.createBattleUi(L.readRom());

/* ------------------------------------------------------------------------------------------------ snapshots (what online.js snapshot() makes) */
const LINK = 'https://caseybement.com/pokemonarena/battle.html?np=K7Q2P&join=1';
const base = { stage: 'setup', role: 'guest', room: 'K7Q2P', codeShown: false, open: false, quick: false, invite: false, admitted: false, defecting: false, listedName: null, played: false, status: { text: '', bad: false }, since: null, board: false, ask: null, ignored: false, ready: true, canGo: true, canQuick: true, cancel: { shown: false, label: 'Cancel' }, link: LINK, canShare: false, copied: null, team: { key: 'saved:a:b', label: 'RED - Sun team (6)', size: 6 }, name: 'RED', fmt: '3v3', bar: null };
const snap = (patch) => ({ ...base, ...patch });
const say = (text, bad = false) => ({ status: { text, bad } });
const NAME = 'WWWWWWWWWW', CODE8 = 'WWWWWWWW';          // the widest a name (10) and a room code (8) can be in the ROM font
const HOST_OPEN = { stage: 'open', role: 'host', codeShown: true, since: 42000, cancel: { shown: true, label: 'Close the room' } };
const QUICK_OPEN = { stage: 'open', role: 'host', open: true, quick: true, codeShown: true, since: 61000, cancel: { shown: true, label: 'Stop looking' } };
const GUEST_WAIT = { stage: 'waiting', role: 'guest', since: 3000, cancel: { shown: true, label: 'Cancel' } };
const HOST_WAIT = { stage: 'waiting', role: 'host', since: 800, cancel: { shown: true, label: 'Close the room' } };
const ASK_HOST = { role: 'host', room: null, board: true, ask: 'host' }, ASK_QUICK = { role: 'host', room: null, board: true, ask: 'quick' };
// the screens kept as golden frames, and written as PNGs: one of each kind and each stage
const SCREENS = {
  invited: {}, invited_loading: { ready: false, team: null }, invited_refused: say('That room already has two players. Ask your friend for a new code, or create a room of your own.', true),
  room: { role: 'host', room: 'A7Q2P', fmt: '6v6', team: { key: 'random', label: 'A random team (6 Pokemon)', size: 6 }, name: 'Host' },
  ask_host: ASK_HOST, ask_quick: ASK_QUICK, ask_quick_stopped: { ...ASK_QUICK, ...say('Stopped looking for an opponent.') },
  ignored: { role: null, room: null, board: true, ignored: true, ...say('That address tried to open a game for you without you pressing Accept, so it was ignored.') },
  host_opening: { ...HOST_WAIT, ...say('Opening your room...') },
  host_open: { ...HOST_OPEN, ...say('Waiting for your friend. The battle starts by itself when they join.') },
  host_open_share: { ...HOST_OPEN, canShare: true, copied: 'link', ...say('Waiting for your friend. The battle starts by itself when they join.') },
  host_copy_refused: { ...HOST_OPEN, ...say('Copy was refused. Tell your friend the room code K7Q2P on this screen.', true) },
  host_handshake: { stage: 'handshake', role: 'host', codeShown: true, admitted: true, since: 1500, ...say('Connected. Checking the teams...') },
  quick_search: { stage: 'searching', role: 'host', room: null, since: 1200, cancel: { shown: true, label: 'Cancel' }, ...say('Looking for a player who is waiting...') },
  quick_open: { ...QUICK_OPEN, ...say('Nobody was waiting, so your game is open: anyone who picks BATTLE ANYONE can join it.') },
  guest_join: { ...GUEST_WAIT, ...say('Connecting to the room K7Q2P...') },
  guest_slow: { ...GUEST_WAIT, since: 15000, ...say('Connecting to the room K7Q2P...') },
  starting: { ...ASK_HOST, starting: true, ready: false, team: null },
  asking: { stage: 'asking', role: 'guest', since: 4000, cancel: { shown: true, label: 'Cancel' }, ...say('Asked HUBHERO to battle. Waiting for an answer...') },
  resuming: { stage: 'resuming', role: 'host', since: 500, ...say('Picking your battle up again...') },
};
// EVERY SENTENCE js/online.js can say (its say(...) calls and the ledes), each in the state it is said in, with the widest name and room code. font: the font the layout was made for
// ('normal': it must be set in the normal ROM font there; 'any': it must fit, in either font). X = the room code, N = a name.
const SENTENCES = [
  ['invited', {}, 'normal', [
    'Checking your team...', 'Cancelled.', 'That is not a room code. A code is 4 to 8 letters and numbers, like K7Q2P.', 'This page has no room code to join. Open your friend\'s link again.',
    'This browser cannot connect two players. Try a current Chrome, Firefox, Safari or Edge.', 'That room already has two players. Ask your friend for a new code, or create a room of your own.',
    'The host did not let you in.', 'The other player is on a different version of the site. Reload and try again.', 'Could not reach that room. Check the code, and that your friend has opened it.',
    'Could not connect. Check the code and try again.', 'The team code could not be read.', 'Your battle could not be picked up again: a team no longer checks out. You can start a new battle here.',
    'This browser cannot connect two players any more. You can start a new battle here.' ]],
  ['room', { role: 'host' }, 'normal', ['A 3v3 battle needs at least 3 Pokemon on your team.', 'Room closed.', 'Opening a game for the player who challenged you...']],
  ['ask-host', ASK_HOST, 'normal', ['Room closed.', 'Checking your team...', 'This browser cannot connect two players. Try a current Chrome, Firefox, Safari or Edge.']],
  ['ask-quick', ASK_QUICK, 'normal', [
    'Stopped looking for an opponent.', 'The list of players online could not be reached, so there is nobody to find. Try again later.', 'That game was just taken by someone else. Try again to find another.',
    'That game is not open any more. Try again to find another.', 'That game is played under different rules than your team. Pick a team that matches, or another game.',
    'That game is 3 v 3 and your team has fewer than 3 Pokemon.', NAME + ' is not available for a battle right now.', NAME + ' is answering another challenge. Try again in a moment.', NAME + ' did not answer.' ]],
  ['ask-quick', ASK_QUICK, 'any', ['This browser cannot challenge a player in private (it has no WebCrypto), so challenging is not available here.', 'That game is not open any more (' + 'x'.repeat(60) + '). Try again to find another.']],
  ['ignored', { role: null, room: null, board: true, ignored: true }, 'normal', ['That address tried to open a game for you without you pressing Accept, so it was ignored.']],
  ['host waiting', HOST_WAIT, 'normal', ['Opening your room...', 'The other player left before the battle began. Opening your game again...', 'The other player is on a different version of the Arena. Reload the page on both sides and try again. Opening your game again...']],
  ['host open (friend)', HOST_OPEN, 'normal', ['Waiting for your friend. The battle starts by itself when they join.', 'Someone is joining with your code. Connecting...', 'That player could not connect. Still waiting for your friend.', 'Waiting for the player who challenged you to connect.', 'The player who challenged you is connecting...']],
  ['host open (friend, a browser that can share)', { ...HOST_OPEN, canShare: true }, 'normal', ['Waiting for your friend. The battle starts by itself when they join.', 'That player could not connect. Still waiting for your friend.', 'Waiting for the player who challenged you to connect.']],
  ['host open (friend)', { ...HOST_OPEN, room: CODE8 }, 'any', ['Copy was refused. Tell your friend the room code ' + CODE8 + ' on this screen.', 'The player who challenged you could not be told your room. A friend can still use the code ' + CODE8 + '.']],
  ['host open (friend, a browser that can share)', { ...HOST_OPEN, room: CODE8, canShare: true }, 'any', ['Copy was refused. Tell your friend the room code ' + CODE8 + ' on this screen.', 'The player who challenged you could not be told your room. A friend can still use the code ' + CODE8 + '.']],
  ['open game', QUICK_OPEN, 'normal', [
    'Nobody was waiting, so your game is open: anyone who picks BATTLE ANYONE can join it.', 'Your game is open, but the list of open games is not connected yet: nobody can see it yet.',
    'Your game is open, but the list of open games cannot be reached: nobody can find it.', 'A player is joining your game. It is off the list of open games while they connect.' ]],
  ['open game', { ...QUICK_OPEN, room: CODE8 }, 'any', ['The game you tried to join was not there. Nobody was waiting, so your game is open: anyone who picks BATTLE ANYONE can join it.', 'Your room is open, but it could not be listed (' + 'x'.repeat(40) + '). A friend can still use the code ' + CODE8 + '.']],
  ['guest waiting', { ...GUEST_WAIT, room: CODE8 }, 'normal', ['Connecting to the room ' + CODE8 + '...', 'Found a game: joining ' + NAME + '...', NAME + ' accepted. Connecting...']],
  ['guest waiting (a listed game)', { ...GUEST_WAIT, listedName: NAME }, 'normal', ['Joining ' + NAME + '... It gives up after 40 seconds if nobody answers; Cancel stops it sooner.']],
  ['guest waiting, slow', { ...GUEST_WAIT, room: CODE8, since: 20000 }, 'normal', ['Connecting to the room ' + CODE8 + '...']],
  ['asking', { stage: 'asking', role: 'guest', since: 4000, cancel: { shown: true, label: 'Cancel' } }, 'normal', ['Asked ' + NAME + ' to battle. Waiting for an answer...']],
  ['searching', { stage: 'searching', role: 'host', room: null, since: 100, cancel: { shown: true, label: 'Cancel' } }, 'normal', ['Looking for a player who is waiting...']],
  ['handshake', { stage: 'handshake', role: 'guest', since: 100 }, 'normal', ['Connected. Checking the teams...']],
  ['resuming', { stage: 'resuming', role: 'host', since: 100 }, 'normal', ['Picking your battle up again...']],
];

async function suite(V, D, who) {
  const T = (s) => s;
  const hs = HS.createHubScreen(ui, { appScreens: { online: D.createScreen } });
  const measure = hs.measureFont;
  const view = (patch) => V.onlineView(snap(patch));
  const render = (v, cursor = 0) => hs.render({ app: 'online', screen: 'online', env: 0, tick: 0, online: v, cursor });
  const screen = hs.app('online');
  const ids = (v) => v.rows.map((r) => r.id).join(','), labels = (v) => v.rows.map((r) => r.label).join('|');

  /* V. the confirm screens: one per kind of address that arrives without the hub's token */
  {
    const inv = view({}), room = view(SCREENS.room), ah = view(ASK_HOST), aq = view(ASK_QUICK), ig = view(SCREENS.ignored);
    ok(inv.screen === 'confirm' && inv.kind === 'invited' && inv.heading === 'YOU\'RE INVITED TO A BATTLE' && labels(inv) === 'JOIN THE BATTLE|CHANGE TEAM|BACK' && ids(inv) === 'go,team,back' && !inv.fmtShown, T('V1 ?np=ROOM&join=1 is YOU\'RE INVITED: JOIN THE BATTLE / CHANGE TEAM / BACK, and no battle size'), J([inv.kind, labels(inv)]));
    ok(inv.info.some((l) => l.label === 'ROOM' && l.value === 'K7Q2P') && inv.info.some((l) => l.label === 'TEAM' && l.value === 'RED - Sun team (6)'), T('V2 it names the room and the team that will be used'), J(inv.info));
    ok(room.kind === 'room' && room.heading === 'YOUR ROOM A7Q2P' && labels(room) === 'OPEN THE ROOM|CHANGE TEAM|BACK' && room.fmtShown && room.info.some((l) => l.right === '6 V 6'), T('V3 ?np=ROOM&host=1 is YOUR ROOM: OPEN THE ROOM / CHANGE TEAM / BACK, with the battle size'), J([room.kind, room.heading, labels(room), room.info]));
    ok(ah.kind === 'ask-host' && ah.ask === 'OPEN A ROOM FOR A FRIEND?' && labels(ah) === 'YES|BACK' && ids(ah) === 'host,back', T('V4 ?online=1&ask=host asks OPEN A ROOM FOR A FRIEND? YES / BACK'), J([ah.kind, ah.ask, ids(ah)]));
    ok(aq.kind === 'ask-quick' && aq.ask === 'FIND AN OPPONENT?' && ids(aq) === 'quick,back' && /Other players see your trainer name and your online record/.test(aq.lede), T('V5 ?online=1&ask=quick asks FIND AN OPPONENT? YES / BACK, and says what other players will see'), J([aq.kind, aq.ask, ids(aq), aq.lede]));
    ok(ig.kind === 'ignored' && ids(ig) === 'back' && /ignored/.test(ig.status.text), T('V6 an Accept address without its token has one row, BACK, and the words say it was ignored'), J([ig.kind, ids(ig)]));
    const loading = view({ ready: false, team: null });
    ok(loading.rows[0].disabled === true && loading.canGo === false && loading.info.some((l) => l.label === 'TEAM' && l.value === '...'), T('V7 until the teams are read the first row cannot be pressed'), J(loading.rows));
    ok(view({ ...ASK_QUICK, canQuick: false }).rows[0].disabled === true && view({ ...ASK_HOST, canGo: false }).rows[0].disabled === true, T('V8 while the team is being checked YES cannot be pressed twice'), '');
    ok(view({ role: 'host', room: null, board: false }).kind === 'ask-host', T('V9 an accepted challenge whose room could not be opened comes back to OPEN A ROOM FOR A FRIEND?'), '');
    const stale = view({ ...say('x'), cancel: { shown: true, label: 'Cancel' }, codeShown: true });
    ok(inv.cancel.shown === false && inv.code === '' && inv.link === '' && inv.elapsed === '' && stale.cancel.shown === false && stale.code === '' && stale.rows.every((r) => r.id !== 'cancel' && r.id !== 'copy-code'), T('V10 a confirm screen has no way out of a wait, no code and no clock, whatever the last wait left behind'), '');
  }

  /* W. the waiting screens */
  {
    const ho = view(SCREENS.host_open), hs2 = view(SCREENS.host_open_share), q = view(SCREENS.quick_open), g = view(SCREENS.guest_join), slow = view(SCREENS.guest_slow), hk = view(SCREENS.host_handshake);
    ok(ho.screen === 'wait' && ho.code === 'K7Q2P' && ho.link === LINK && ids(ho) === 'copy-link,copy-code,cancel' && labels(ho) === 'COPY LINK|COPY CODE|CLOSE THE ROOM' && ho.codeLabel === 'ROOM CODE', T('W1 the host of a friend\'s room: the code, COPY LINK / COPY CODE / CLOSE THE ROOM'), J([ids(ho), labels(ho)]));
    ok(ids(hs2) === 'copy-link,share,copy-code,cancel' && ids(view({ ...HOST_OPEN, canShare: false })) === 'copy-link,copy-code,cancel', T('W2 SHARE is a row only where the browser can share'), ids(hs2));
    ok(hs2.rows[0].label === 'COPIED' && hs2.rows.find((r) => r.id === 'copy-code').label === 'COPY CODE' && view({ ...HOST_OPEN, copied: 'code' }).rows.find((r) => r.id === 'copy-code').label === 'COPIED' && view({ ...HOST_OPEN, copied: 'code' }).rows[0].label === 'COPY LINK', T('W3 the row that was pressed says COPIED (and only that row)'), labels(hs2));
    ok(ho.who === 'You\'re hosting, room K7Q2P' && ho.title === 'Waiting for your friend to join' && J(ho.steps) === J(['Open room', 'Friend joins', 'Check teams', 'Battle']) && ho.at === 1 && ho.elapsed === '0:42', T('W4 who the player is, what is happening, the numbered steps with the one it is at, the time this step has taken'), J([ho.who, ho.title, ho.steps, ho.at, ho.elapsed]));
    ok(ids(q) === 'copy-code,cancel' && labels(q) === 'COPY CODE|STOP LOOKING' && q.codeLabel === 'CODE FOR A FRIEND' && q.link === '' && q.who === 'Battle anyone', T('W5 a game open to anyone: its code as a fallback for a friend, COPY CODE / STOP LOOKING, no invite link'), J([ids(q), labels(q), q.codeLabel]));
    ok(ids(g) === 'cancel' && labels(g) === 'CANCEL' && g.code === '' && g.hint === '' && /joining, room K7Q2P/.test(g.who), T('W6 a join by code: CANCEL, no code of its own, no hint yet'), J([ids(g), g.who]));
    ok(/Taking a while\? Check the code K7Q2P/.test(slow.hint) && view({ ...GUEST_WAIT, since: 11999 }).hint === '' && view({ ...GUEST_WAIT, since: 20000, listedName: 'Ann' }).hint === '' && view({ ...HOST_WAIT, since: 20000 }).hint === '', T('W7 a join by code that has taken 12 s says what to check (not a listed game\'s join, not a host)'), slow.hint);
    ok(hk.rows.length === 0 && view(SCREENS.resuming).rows.length === 0 && view({ ...HOST_OPEN, stage: 'handshake', cancel: { shown: true, label: 'x' } }).rows.length === 0, T('W8 once connected (checking the teams, reconnecting) nothing can be pressed'), ids(hk));
    ok(view({ ...HOST_OPEN, cancel: { shown: false, label: 'Close the room' } }).rows.every((r) => r.id !== 'cancel'), T('W9 the way out is a row only while the wait can still be given up'), '');
    ok(view({ ...HOST_OPEN, played: true, stage: 'handshake' }).screen === 'hidden' && view({ stage: 'playing' }).screen === 'hidden' && view({ stage: 'failed' }).screen === 'hidden' && view({ stage: 'left' }).screen === 'hidden', T('W10 a battle (also the handshake of a rematch), the error screen and a page that is leaving have no online screen'), '');
    ok(view({ ...HOST_WAIT, codeShown: false }).code === '' && view({ ...HOST_OPEN, codeShown: false }).rows.every((r) => !/copy/.test(r.id)), T('W11 a room\'s code is on the screen only once the room is open'), '');
    const sg = view({ ...ASK_HOST, starting: true, ready: false, team: null }), sj = view({ starting: true, ...say('Checking your team...') });
    ok(sg.screen === 'wait' && sg.kind === 'starting' && sg.rows.length === 0 && sg.title === 'Getting ready...' && sg.who === 'You\'re hosting' && sg.steps.length === 0 && sg.code === '' && sg.elapsed === '' && sj.screen === 'wait' && sj.who === 'You\'re joining, room K7Q2P' && sj.status.text === 'Checking your team...' && view({ ...ASK_QUICK, starting: true }).who === 'Battle anyone', T('W13 while a token of the hub is starting something the screen says what is starting (no rows), never the question the address would ask without the token'), J([sg.screen, sg.kind, sg.who, sj.who]));
    ok(view({ ...ASK_HOST, starting: true, ...say('The team code could not be read.', true) }).kind === 'ask-host' && view({ ...ASK_HOST, starting: false }).kind === 'ask-host' && view({ ...HOST_OPEN, starting: true }).kind === null, T('W14 a refusal ends it (the question, with the reason), and a wait that is under way is the waiting screen'), '');
    const st = V.stepsNow;
    ok(st({ stage: 'asking' }).at === 1 && st({ stage: 'searching' }).title === 'Looking for an opponent...' && st({ stage: 'open', role: 'host', invite: true, room: 'X' }).steps[1] === 'They join' && st({ stage: 'handshake', role: 'guest', room: 'X' }).at === 1 && st({ stage: 'resuming' }).steps.length === 2, T('W12 the steps of each kind of wait'), '');
  }

  /* P. the cursor over the rows */
  {
    const inv = view({}), P = V.createOnlinePanel();
    ok(P.cursor(inv) === 0 && J([P.press('down', inv), P.press('down', inv), P.press('down', inv)].map((r) => r.index)) === J([1, 2, 0]) && P.press('up', inv).index === 2, T('P1 the d-pad moves the cursor over the rows and wraps'), '');
    const P2 = V.createOnlinePanel();
    ok(J(P2.press('a', inv)) === J({ kind: 'act', id: 'go' }) && J(P2.press('a', view({ ready: false }))) === J({ kind: 'refused', id: 'go' }), T('P2 A presses the highlighted row; a row that cannot be pressed yet refuses'), '');
    ok(J(V.createOnlinePanel().press('b', inv)) === J({ kind: 'act', id: 'back' }), T('P3 B on a confirm screen is its BACK row'), '');
    const ho = view(SCREENS.host_open), P4 = V.createOnlinePanel();
    const b1 = P4.press('b', ho), b2 = P4.press('b', ho);
    ok(b1 && b1.kind === 'move' && b1.index === 2 && b2 === null && P4.cursor(ho) === 2 && J(P4.press('a', ho)) === J({ kind: 'act', id: 'cancel' }), T('P4 B on a waiting screen NEVER closes anything: it puts the cursor on the way out, which A then presses'), J([b1, b2]));
    ok(V.createOnlinePanel().press('b', view(SCREENS.host_handshake)) === null && V.createOnlinePanel().press('a', view(SCREENS.host_handshake)) === null, T('P5 with no rows a button means nothing'), '');
    const P6 = V.createOnlinePanel();
    P6.press('down', ho);                                  // on COPY CODE
    const withShare = view({ ...HOST_OPEN, canShare: true });
    ok(P6.cursor(withShare) === 2 && withShare.rows[2].id === 'copy-code' && P6.cursor(view({ ...HOST_OPEN, copied: 'code' })) === 1, T('P6 when a row appears (SHARE) or changes its words (COPIED) the cursor stays on the row it was on'), String(P6.cursor(withShare)));
    P6.press('down', ho);
    ok(P6.cursor(view({})) === 0, T('P7 another screen starts with the cursor on its first row'), '');
    const P11 = V.createOnlinePanel(), opening = P11.cursor(view(SCREENS.host_opening)), opened = P11.cursor(view(SCREENS.host_open));
    ok(opening === 0 && opened === 0 && view(SCREENS.host_open).rows[opened].id === 'copy-link', T('P11 a cursor nobody moved starts at the top when rows appear: when the room opens it stands on COPY LINK, not on CLOSE THE ROOM (the only row while the room was opening)'), String(opened));
    const P8 = V.createOnlinePanel(), rects = P8.rects(inv), r1 = rects[1];
    const mv = P8.pointer({ kind: 'move', x: r1.x + 5, y: r1.y + 5 }, inv), again = P8.pointer({ kind: 'move', x: r1.x + 6, y: r1.y + 6 }, inv), cl = P8.pointer({ kind: 'click', x: rects[0].x + 5, y: rects[0].y + 5 }, inv);
    ok(J(mv) === J({ kind: 'move', index: 1 }) && again === null && J(cl) === J({ kind: 'act', id: 'go' }) && P8.pointer({ kind: 'click', x: 230, y: 80 }, inv) === null && J(P8.hit(r1.x + 1, r1.y + 1, inv)) === J({ kind: 'row', index: 1, id: 'team' }) && P8.hit(1, 1, inv) === null, T('P8 the pointer highlights the row under it, a click presses it, and a click beside the rows does nothing'), J([mv, again, cl]));
    ok(J(V.createOnlinePanel().pointer({ kind: 'click', x: rects[0].x + 5, y: rects[0].y + 5 }, view({ ready: false }))) === J({ kind: 'refused', id: 'go' }), T('P9 a click on a row that cannot be pressed yet refuses'), '');
    ok(V.createOnlinePanel().press('a', view({ stage: 'playing' })) === null && V.createOnlinePanel().pointer({ kind: 'click', x: 20, y: 70 }, view({ stage: 'playing' })) === null, T('P10 a hidden screen takes no press'), '');
  }

  /* L. the layout: inside the picture, nothing over anything, a sentence always has room */
  {
    const boxes = (v) => { const Lo = V.layoutOf(v); return ['info', 'head', 'code', 'rows', 'status'].filter((k) => Lo[k]).map((k) => ({ k, x: Lo[k].x - 6, y: Lo[k].y - 6, w: Lo[k].w + 12, h: Lo[k].h + 12, lines: Lo[k].lines })); };
    const over = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const bad = [];
    for (const [name, patch] of Object.entries(SCREENS)) for (const share of [false, true]) {
      const v = view({ ...patch, canShare: share }), bs = boxes(v);
      for (const b of bs) if (b.x < 0 || b.y < 14 || b.x + b.w > 240 || b.y + b.h > 160) bad.push(name + ': ' + b.k + ' leaves the picture or the top line ' + J(b));
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (over(bs[i], bs[j]) && !(bs[i].k === 'code' && bs[j].k === 'rows' ? false : false)) bad.push(name + ': ' + bs[i].k + ' over ' + bs[j].k);
      const st = bs.find((b) => b.k === 'status');
      if (!st || st.lines < 2) bad.push(name + ': the sentence has ' + (st ? st.lines : 0) + ' line(s)');
      for (const r of V.rowRects(v)) if (r.x < 0 || r.y < 0 || r.x + r.w > 240 || r.y + r.h > 160 || r.h < 12) bad.push(name + ': row ' + r.id + ' ' + J(r));
    }
    ok(bad.length === 0, T('L1 on every screen (with and without SHARE) each window with its ring is inside the picture and under the top line, no two overlap, the sentence has at least two lines, and every row can be hit'), bad.slice(0, 4).join('; '));
    const rr = V.rowRects(view(SCREENS.host_open_share));
    ok(rr.length === 4 && rr.every((r, i) => i === 0 || r.y === rr[i - 1].y + rr[i - 1].h), T('L2 the rows\' rectangles are one under the other with no gap (a pointer between two rows is on one of them)'), J(rr.map((r) => [r.y, r.h])));
  }

  /* F. every sentence fits its window */
  {
    const clipped = [], small = [], wide = [];
    let n = 0;
    for (const [where, patch, font, texts] of SENTENCES) for (const text of texts) for (const bad of [false, true]) {
      const v = view({ ...patch, status: { text, bad } }), f = screen.fits(v);
      n++;
      if (!f.fits) clipped.push(where + ': ' + text.slice(0, 50));
      else if (font === 'normal' && f.font !== 'normal') small.push(where + ': ' + text.slice(0, 50));
      for (const w of f.widths) if (w.px > w.max) wide.push(where + ': ' + w.what + ' ' + w.px + ' > ' + w.max);
    }
    ok(clipped.length === 0, T('F1 every sentence the page can say fits its window (' + n + ' checked, with the widest name and room code)'), clipped.slice(0, 4).join('; '));
    ok(small.length === 0, T('F2 ... and is set in the NORMAL ROM font wherever the layout was made for it (the small font\'s m and w read as n and H)'), small.slice(0, 4).join('; '));
    ok(wide.length === 0, T('F3 the headings, the rows and the code fit theirs'), wide.slice(0, 4).join('; '));
    // the ledes (a confirm screen with nothing to report) and the slow-join hint
    const ledes = [view({ room: CODE8 }), view({ ...SCREENS.room, room: CODE8 }), view(ASK_HOST), view(ASK_QUICK), view({ ...GUEST_WAIT, room: CODE8, since: 20000 })].map((v) => [v.kind || 'slow join', screen.fits(v)]);
    ok(ledes.every(([, f]) => f.fits && f.font === 'normal'), T('F4 each confirm screen\'s own words, and the slow-join hint, fit in the normal font'), J(ledes.filter(([, f]) => !f.fits || f.font !== 'normal').map(([k, f]) => [k, f.font, f.lines])));
    // the widest things a heading can hold
    const heads = [view({ ...HOST_OPEN, room: CODE8, since: 3599000 }), view({ ...GUEST_WAIT, listedName: NAME }), view({ stage: 'handshake', role: 'host', invite: true, room: CODE8, codeShown: true, since: 1 }), view({ stage: 'handshake', role: 'host', quick: true, open: true, room: CODE8, since: 1 }), view({ ...SCREENS.room, room: CODE8, name: NAME, team: { key: 'x', label: NAME + ' - ' + 'W'.repeat(12) + ' (6)', size: 6 } })];
    const hw = heads.flatMap((v) => screen.fits(v).widths.filter((w) => w.px > w.max).map((w) => (v.kind || v.stage) + ': ' + w.what + ' ' + w.px + ' > ' + w.max));
    ok(hw.length === 0, T('F5 the longest who-line (an 8-character room, an hour on the clock), the longest headings and the widest code fit'), hw.join('; '));
    // a sentence too long even for the small font ends in "..." where the window ends
    const long = view({ ...HOST_OPEN, canShare: true, ...say('The team breaks the rules of its ruleset: ' + 'a very long reason; '.repeat(12), true) }), t = V.sentenceLayout(measure, long);
    ok(t.fits === false && t.font === 'small' && t.lines.length === V.layoutOf(long).status.lines && /\.\.\.$/.test(t.lines[t.lines.length - 1].text) && measure('small', t.lines[t.lines.length - 1].text) <= 220, T('F6 a sentence too long even for the small font ends in "..." where its window ends, inside the window'), J([t.fits, t.font, t.lines.length]));
    // the slow-join hint takes the place of a status that only repeats the heading; a refusal is kept and the hint follows
    const s1 = V.sentencesOf(view(SCREENS.guest_slow)), s2 = V.sentencesOf(view({ ...SCREENS.guest_slow, ...say('Could not connect.', true) }));
    ok(s1.length === 1 && /Taking a while/.test(s1[0].text) && s2.length === 2 && s2[0].bad && /Taking a while/.test(s2[1].text), T('F7 the slow-join hint takes the place of "Connecting to the room..." (the heading says it), and follows a refusal'), J([s1.length, s2.length]));
    ok(V.sentencesOf(view({})).length === 1 && /JOIN THE BATTLE/.test(V.sentencesOf(view({}))[0].text) && J(V.sentencesOf(view(say('Cancelled.')))) === J([{ text: 'Cancelled.', bad: false }]), T('F8 a confirm screen says its own words until there is something to report'), '');
  }

  /* D. the renderer */
  {
    const frames = {}, faults = [];
    for (const [name, patch] of Object.entries(SCREENS)) { const f = render(view(patch)); if (f.fault) faults.push(name + ': ' + f.fault.message); frames[name] = f; }
    ok(faults.length === 0, T('D1 every screen is drawn by the ROM renderer without a fault'), faults.join('; '));
    const hashes = Object.fromEntries(Object.entries(frames).map(([k, f]) => [k, fnv(f.rgba)]));
    ok(new Set(Object.values(hashes)).size === Object.keys(hashes).length, T('D2 no two screens are the same picture'), '');
    const teal = ui.partyArt().bg, px = (f, x, y) => [f.rgba[(y * 240 + x) * 4], f.rgba[(y * 240 + x) * 4 + 1], f.rgba[(y * 240 + x) * 4 + 2]];
    ok(J(px(frames.invited, 236, 80)) === J(teal) && J(px(frames.host_open, 118, 80)) === J(teal), T('D3 the party-menu teal is behind the windows'), J(px(frames.invited, 236, 80)));
    const dark = (f, r) => { let n = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const p = px(f, x, y); if (p[0] < 60 && p[1] < 60 && p[2] < 60) n++; } return n; };
    const Lo = V.layoutOf(view(SCREENS.host_open)), small = measure('normal', 'K7Q2P');
    ok(dark(frames.host_open, Lo.code) > 4 * 30 * 5 * 0.5 && dark(frames.host_open, Lo.code) > 2.5 * dark(render(view(SCREENS.host_open)), { x: Lo.head.x, y: Lo.head.y, w: small + 60, h: 15 }) * 0.5, T('D4 the room code is drawn LARGE (the normal ROM font at twice its size: four times the ink)'), String(dark(frames.host_open, Lo.code)));
    const c0 = render(view(SCREENS.host_open), 0), c2 = render(view(SCREENS.host_open), 2), rr = V.rowRects(view(SCREENS.host_open));
    const diffIn = (a, b, r) => { let n = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const o = (y * 240 + x) * 4; if (a.rgba[o] !== b.rgba[o] || a.rgba[o + 1] !== b.rgba[o + 1] || a.rgba[o + 2] !== b.rgba[o + 2]) n++; } return n; };
    ok(diffIn(c0, c2, rr[0]) > 0 && diffIn(c0, c2, rr[2]) > 0 && diffIn(c0, c2, rr[1]) === 0 && diffIn(c0, c2, { x: 0, y: 0, w: 240, h: rr[0].y }) === 0, T('D5 the ROM cursor stands on the highlighted row and nowhere else'), '');
    const red = (f, r) => { let n = 0; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const p = px(f, x, y); if (p[0] > 200 && p[1] < 60 && p[2] < 60) n++; } return n; };
    const Li = V.layoutOf(view(SCREENS.invited_refused));
    ok(red(frames.invited_refused, Li.status) > 100 && red(frames.invited, V.layoutOf(view({})).status) === 0, T('D6 a refusal is set in the ROM\'s red, anything else is not'), String(red(frames.invited_refused, Li.status)));
    ok(fnv(render(view(SCREENS.host_open)).rgba) !== fnv(render(view({ ...SCREENS.host_open, since: 43000 })).rgba) && fnv(render(view({ stage: 'playing' })).rgba) === fnv(render(view({ stage: 'failed' })).rgba), T('D7 the clock is in the picture; a hidden screen draws nothing of its own'), '');
    if (OUT && who === 'the game') for (const [name, f] of Object.entries(frames)) writePNG(path.join(OUT, name + '.png'), 720, 480, scaleRGBA(240, 160, f.rgba, 3).rgba);
    if (who === 'the game') {
      if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify({ note: 'frame hashes (FNV-1a of the 240x160 RGBA) of the battle page\'s online screens: tools/pokemonarena_online_view_test.mjs --update. Hashes only: nothing of the ROM is stored.', frames: hashes }, null, 1) + '\n'); console.log('golden written: ' + Object.keys(hashes).length + ' frames'); }
      let golden = null; try { golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).frames; } catch (_e) { golden = null; }
      const off = golden ? Object.keys(hashes).filter((k) => golden[k] !== hashes[k]).concat(Object.keys(golden).filter((k) => !(k in hashes))) : ['no golden file'];
      ok(off.length === 0, T('D8 every screen is the picture the golden file holds (pokemonarena/online_screens.golden.json; --update after a deliberate change)'), off.join(', '));
    }
  }

  /* S. the screen reader's words */
  {
    const a = V.speakOnline(view(SCREENS.host_open), 0), b = V.speakOnline(view({ ...SCREENS.host_open, since: 99000 }), 0), c = V.speakOnline(view(SCREENS.host_open), 2), d = V.speakOnline(view({}), 1);
    ok(a === b && !/\d:\d\d/.test(a), T('S1 the words leave out the running clock (a live region would read it out every second)'), a);
    ok(!/Step/.test(V.speakOnline(view({ ...ASK_HOST, starting: true }), 0)) && /You're hosting, room K7Q2P/.test(a) && /Waiting for your friend to join/.test(a) && /Step 2 of 4: Friend joins/.test(a) && /ROOM CODE K 7 Q 2 P/.test(a) && /COPY LINK, 1 of 3/.test(a) && /CLOSE THE ROOM, 3 of 3/.test(c), T('S2 they say who, what, the step, the code letter by letter, the sentence and the highlighted row'), a);
    ok(/YOU'RE INVITED TO A BATTLE/.test(d) && /ROOM K7Q2P/.test(d) && /TEAM RED - Sun team/.test(d) && /CHANGE TEAM, 2 of 3/.test(d) && V.speakOnline(view({ stage: 'playing' }), 0) === '', T('S3 a confirm screen says its heading, its lines, its words and the row; a hidden screen says nothing'), d);
  }
}

/* ------------------------------------------------------------------------------------------------ X. the page files hold no panel any more (read as text) */
function pageFiles() {
  const read = (f) => fs.readFileSync(path.join(root, 'pokemonarena', f), 'utf8');
  const online = read('js/online.js'), css = read('battle.css'), html = read('battle.html'), boot = read('js/battle_boot.js'), view = read('js/online_view.js'), draw = read('js/online_draw.js');
  ok((online.match(/createElement/g) || []).length === 1 && !/doc\.querySelector|\broot\.|getElementById|innerHTML|\.focus\(|classList|\.hidden\b/.test(online), 'X1 js/online.js makes one thing in the page (the status line of a battle, through its one createElement) and reads no node', String((online.match(/createElement/g) || []).length));
  ok(!/#online\b|#ol[A-Z]|\.olcard|\.openlist/.test(css) && !/id="online"|id="ol[A-Z]/.test(html), 'X2 battle.css styles no panel and battle.html holds none', '');
  ok(/id: 'netbar'/.test(online) && /#netbar \{/.test(css) && /barTimer = win\.setInterval\(tick, 250\)/.test(online) && /startBar\(\); startTick\(\);/.test(online), 'X3 the slim status line of a battle stays, and the 250 ms tick of a match is started with the match, not by the line', '');
  ok(/session\.on\('join-request'/.test(online) && /if \(role === 'host'\) session\.on\('join-request'/.test(online), 'X4 the join-request handler is still registered for every host (it is what keeps the library\'s own Allow dialog away)', '');
  for (const [name, src] of [['js/online_view.js', view], ['js/online_draw.js', draw]]) ok(!/\bdocument\.|\bwindow\.|localStorage|sessionStorage|setTimeout|setInterval|Date\.now|Math\.random|performance\./.test(src), 'X5 ' + name + ' is pure: no DOM, no storage, no clock, no randomness', '');
  ok(/import \{ readBack, passThrough \} from '\.\/hub_presence\.js'/.test(boot) && !/navigate\(HUB_PAGE_URL\)/.test(boot.replace(/returnToHub[^\n]*/g, '')), 'X6 js/battle_boot.js leaves for the hub through hubUrl() (INAPP.md "Contract 6": arena.back, read by hub_presence.js readBack) and never for the bare address', '');
}

/* ------------------------------------------------------------------------------------------------ the mutants: each breaks ONE thing in a copy of the two pure files, and the case it names must fail */
const MUTANTS = [
  { id: 'kind-quick-as-host', file: 'online_view.js', from: "(s.ask === 'quick' ? 'ask-quick' : 'ask-host')", to: "'ask-host'", fails: 'V5' },
  { id: 'invited-with-size', file: 'online_view.js', from: "fmtShown: board || s.role === 'host',", to: 'fmtShown: true,', fails: 'V1' },
  { id: 'go-pressable-unready', file: 'online_view.js', from: "canGo: !!s.ready && !!s.canGo,", to: 'canGo: !!s.canGo,', fails: 'V7' },
  { id: 'yes-pressable-twice', file: 'online_view.js', from: "v.rows = [{ id: 'quick', label: R.yes, disabled: !v.canQuick }, { id: 'back', label: R.back }];", to: "v.rows = [{ id: 'quick', label: R.yes }, { id: 'back', label: R.back }];", fails: 'V8' },
  { id: 'confirm-keeps-cancel', file: 'online_view.js', from: "cancel: { shown: going && !!(s.cancel && s.cancel.shown),", to: "cancel: { shown: !!(s.cancel && s.cancel.shown),", fails: 'V10' },
  { id: 'share-everywhere', file: 'online_view.js', from: "if (v.canShare) v.rows.push({ id: 'share', label: R.share });", to: "v.rows.push({ id: 'share', label: R.share });", fails: 'W2' },
  { id: 'copied-both', file: 'online_view.js', from: "label: v.copied === 'code' ? R.copied : R.copyCode", to: "label: v.copied ? R.copied : R.copyCode", fails: 'W3' },
  { id: 'anyone-gets-link', file: 'online_view.js', from: "if (v.code && friendRoom) { v.rows.push({ id: 'copy-link'", to: "if (v.code) { v.rows.push({ id: 'copy-link'", fails: 'W5' },
  { id: 'hint-for-listed', file: 'online_view.js', from: "st === 'waiting' && s.role === 'guest' && !s.listedName) v.hint", to: "st === 'waiting' && s.role === 'guest') v.hint", fails: 'W7' },
  { id: 'rows-when-connected', file: 'online_view.js', from: "if (st !== 'handshake' && st !== 'resuming') {", to: 'if (true) {', fails: 'W8' },
  { id: 'cancel-always', file: 'online_view.js', from: "if (v.cancel.shown) v.rows.push({ id: 'cancel'", to: "if (true) v.rows.push({ id: 'cancel'", fails: 'W9' },
  { id: 'starting-asks', file: 'online_view.js', from: "const starting = st === 'setup' && !!s.starting && !(s.status && s.status.bad), setup = st === 'setup' && !starting;", to: "const starting = false, setup = st === 'setup';", fails: 'W13' },
  { id: 'refusal-hidden-by-starting', file: 'online_view.js', from: "const starting = st === 'setup' && !!s.starting && !(s.status && s.status.bad), setup = st === 'setup' && !starting;", to: "const starting = st === 'setup' && !!s.starting, setup = st === 'setup' && !starting;", fails: 'W14' },
  { id: 'rematch-shows-screen', file: 'online_view.js', from: 'going = UNDER_WAY.includes(st) && !s.played,', to: 'going = UNDER_WAY.includes(st),', fails: 'W10' },
  { id: 'code-before-open', file: 'online_view.js', from: "code: going && s.codeShown && s.room ? s.room : '',", to: "code: going && s.room ? s.room : '',", fails: 'W11' },
  { id: 'no-wrap', file: 'online_view.js', from: "if (action === 'down') return setCursor(v, (cursor + 1) % n);", to: "if (action === 'down') return setCursor(v, Math.min(n - 1, cursor + 1));", fails: 'P1' },
  { id: 'disabled-acts', file: 'online_view.js', from: "return !r ? null : r.disabled ? { kind: 'refused', id: r.id } : { kind: 'act', id: r.id }; };", to: "return !r ? null : { kind: 'act', id: r.id }; };", fails: 'P2' },
  { id: 'b-closes-wait', file: 'online_view.js', from: "        return i === cursor ? null : setCursor(v, i);\n", to: "        return { kind: 'act', id: 'cancel' };\n", fails: 'P4' },
  { id: 'cursor-by-index', file: 'online_view.js', from: "const keep = moved && sig.split('|')[0] === v.screen ? v.rows.findIndex((r) => r.id === onId) : -1;", to: "const keep = moved && sig.split('|')[0] === v.screen ? cursor : -1;", fails: 'P6' },
  { id: 'cursor-kept-across', file: 'online_view.js', from: "const keep = moved && sig.split('|')[0] === v.screen ? v.rows.findIndex((r) => r.id === onId) : -1;", to: "const keep = v.rows.length ? Math.min(cursor, v.rows.length - 1) : -1;", fails: 'P7' },
  { id: 'unmoved-cursor-on-way-out', file: 'online_view.js', from: "const keep = moved && sig.split('|')[0] === v.screen ?", to: "const keep = sig.split('|')[0] === v.screen ?", fails: 'P11' },
  { id: 'hover-does-not-move', file: 'online_view.js', from: "      const moved = h.index !== cursor;\n      setCursor(v, h.index);\n", to: "      const moved = h.index !== cursor;\n      if (ev.kind === 'click') setCursor(v, h.index);\n", fails: 'P8' },
  { id: 'hidden-takes-press', file: 'online_view.js', from: "      if (!n || v.screen === 'hidden') return null;\n", to: "      if (!n) return null;\n", fails: 'P10', also: [{ file: 'online_view.js', from: "} else if (going) {\n    const n = stepsNow(s);", to: "} else {\n    const n = stepsNow(s); v.rows.push({ id: 'cancel', label: 'X' });" }] },
  { id: 'rows-over-sentence', file: 'online_view.js', from: "    if (n) { out.rows = { x: G.x, y, w: G.rows.w, h: n * G.rows.pitch, pitch: G.rows.pitch, n }; y += out.rows.h + G.gap; }\n  } else if (v.screen === 'wait') {", to: "    if (n) { out.rows = { x: G.x, y, w: G.rows.w, h: n * G.rows.pitch, pitch: G.rows.pitch, n }; y += out.rows.h; }\n  } else if (v.screen === 'wait') {", fails: 'L1' },
  { id: 'rects-with-gaps', file: 'online_view.js', from: "y: L.rows.y + i * L.rows.pitch, w: L.rows.w + 8, h: L.rows.pitch,", to: "y: L.rows.y + i * L.rows.pitch, w: L.rows.w + 8, h: L.rows.pitch - 2,", fails: 'L2' },
  { id: 'always-small', file: 'online_view.js', from: "  for (const font of ['normal', 'small']) {\n    const m = SENTENCE[font]", to: "  for (const font of ['small']) {\n    const m = SENTENCE[font]", fails: 'F2' },
  { id: 'never-small', file: 'online_view.js', from: "  for (const font of ['normal', 'small']) {\n    const m = SENTENCE[font]", to: "  for (const font of ['normal']) {\n    const m = SENTENCE[font]", fails: 'F1' },
  { id: 'no-ellipsis', file: 'online_view.js', from: "  if (!out.fits && out.lines.length) {", to: '  if (false) {', fails: 'F6' },
  { id: 'hint-appended', file: 'online_view.js', from: "if (v.status.text && !(v.hint && !v.status.bad)) out.push", to: 'if (v.status.text) out.push', fails: 'F7' },
  { id: 'lede-over-status', file: 'online_view.js', from: "else if (!v.status.text && v.lede) out.push({ text: v.lede, bad: false });", to: "if (v.lede) out.push({ text: v.lede, bad: false });", fails: 'F8' },
  { id: 'clock-spoken', file: 'online_view.js', from: "return [v.who + '.', v.title,", to: "return [v.who + '.', v.elapsed, v.title,", fails: 'S1' },
  { id: 'row-not-spoken', file: 'online_view.js', from: "const row = v.rows[cursor] ? ' ' + v.rows[cursor].label + ', ' + (cursor + 1) + ' of ' + v.rows.length + '.' : '';", to: "const row = '';", fails: 'S2' },
  { id: 'code-small', file: 'online_draw.js', from: "      text2x(f, v.code, Math.floor(c.x + (c.w - w) / 2), c.y + c.label - 2);\n", to: "      h.text(f, 'normal', v.code, Math.floor(c.x + (c.w - w / 2) / 2), c.y + c.label);\n", fails: 'D4' },
  { id: 'cursor-on-first', file: 'online_draw.js', from: "      if (i === cursor) h.text(f, 'normal', '{CURSOR}', r.x + 2, y, TEXT.dark);\n", to: "      if (i === 0) h.text(f, 'normal', '{CURSOR}', r.x + 2, y, TEXT.dark);\n", fails: 'D5' },
  { id: 'refusal-not-red', file: 'online_draw.js', from: "ln.bad ? TEXT.red : TEXT.dark", to: 'TEXT.dark', fails: 'D6' },
  { id: 'no-clock-drawn', file: 'online_draw.js', from: "    if (v.elapsed) { const x = L.top.x + L.top.w - measure('normal', v.elapsed); white(f, 'normal', v.elapsed, x, L.top.y); }\n", to: '', fails: 'D7' },
  { id: 'terrain-behind', file: 'online_draw.js', from: "      f.rect(0, 0, OGEOM.W, OGEOM.H, bg);\n", to: '', fails: 'D3' },
];

async function loadFrom(dir, file) { return import(pathToFileURL(path.join(dir, file)).href + '?x=' + Math.random().toString(36).slice(2)); }
const V0 = await loadFrom(SRC, 'online_view.js'), D0 = await loadFrom(SRC, 'online_draw.js');
await suite(V0, D0, 'the game');
pageFiles();
console.log(`online view: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.join('\n')); process.exitCode = 1; }

if (WANT_MUTANTS && !fail) {
  const res = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-olview-mut-'));
    try {
      const texts = { 'online_view.js': fs.readFileSync(path.join(SRC, 'online_view.js'), 'utf8'), 'online_draw.js': fs.readFileSync(path.join(SRC, 'online_draw.js'), 'utf8') };
      let bad = '';
      for (const step of [mu, ...(mu.also || [])]) { const n = texts[step.file].split(step.from).length - 1; if (n !== 1) { bad = 'PATTERN FOUND ' + n + 'x (the mutant did not apply once): ' + step.from.slice(0, 60); break; } texts[step.file] = texts[step.file].replace(step.from, () => step.to); }
      if (bad) { res.push({ id: mu.id, ok: false, why: bad }); continue; }
      for (const [f, t] of Object.entries(texts)) fs.writeFileSync(path.join(dir, f), t);
      const before = { pass, fail, n: failures.length };
      quiet = true;
      let threw = null;
      try { await suite(await loadFrom(dir, 'online_view.js'), await loadFrom(dir, 'online_draw.js'), 'a mutant'); } catch (e) { threw = e; }
      quiet = false;
      const mine = failures.splice(before.n); pass = before.pass; fail = before.fail;
      const hit = mine.find((f) => f.startsWith(mu.fails + ' '));
      res.push({ id: mu.id, ok: !!hit, why: hit ? '' : threw ? 'it CRASHED instead of failing ' + mu.fails + ': ' + String(threw && threw.message).slice(0, 120) : 'it did NOT fail ' + mu.fails + ' (failed: ' + mine.map((f) => f.split(' ')[0]).join(',') + ')' });
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  }
  for (const r of res) if (!r.ok) console.log('SURVIVED', r.id, '--', r.why);
  const survived = res.filter((r) => !r.ok).length;
  console.log(`mutants: ${res.length - survived}/${res.length} killed`);
  if (survived) process.exitCode = 1;
}
