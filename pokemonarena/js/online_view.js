// pokemonarena/js/online_view.js -- WHAT THE ONLINE HALF OF THE BATTLE PAGE SHOWS, as plain data: one pure function of a snapshot of online.js's state.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no network. online.js takes the snapshot (snapshot()) and answers view() with onlineView(snapshot); whatever presents the
// page reads that one object and nothing else, and tools/pokemonarena_online_page_test.mjs reads it through window.__arenaOnline.view().
//
// THE SNAPSHOT  { stage, role, room, codeShown, open, quick, invite, admitted, defecting, listedName, status: { text, bad }, since (ms this stage has lasted, or null), board (the address named
//                 no room and no role), ready (the team list is loaded), canGo, canQuick, cancel: { shown, label }, link, canShare, copied ('link' | 'code' | null), team: { key, label, size } | null,
//                 name, fmt, bar }
// THE VIEW      { screen: 'confirm' (nothing is under way: the page asks) | 'wait' (something is under way) | 'hidden' (a battle, or the error screen, has the page),
//                 kind (which confirm screen), stage, role ('host' | 'guest' | 'either'), heading, lede, who, title, steps, at, status, hint, elapsed, code, codeLabel, friendRoom, link, canShare,
//                 copied, cancel, team, name, fmt, fmtShown, ready, canGo, canQuick, bar }

export const UNDER_WAY = Object.freeze(['waiting', 'open', 'searching', 'asking', 'handshake', 'resuming']);
/** A join by code that has not connected after this long says what to check. */
export const SLOW_JOIN_MS = 12000;
export const fmtClock = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const HOME_LEDE = 'Battle someone on another phone or computer. Pick how:';

/** Who the player is in what is under way (`role`), what is happening now (`title`), and the numbered steps with the one it is at. s: the snapshot (stage, role, room, open, quick, invite, admitted, defecting, listedName). */
export function stepsNow(s) {
  const st = s.stage, host = s.role === 'host', room = s.room || '';
  if (st === 'resuming') return { role: 'Your battle', title: 'Reconnecting to your battle...', steps: ['Reconnect', 'Battle'], at: 0 };
  if (st === 'asking') return { role: 'Challenge', title: 'Waiting for an answer...', steps: ['Ask', 'They accept', 'Check teams', 'Battle'], at: 1 };
  if (s.quick || st === 'searching' || (s.defecting && !host)) {
    const at = st === 'searching' ? 0 : st === 'handshake' ? 2 : 1;
    const title = st === 'searching' ? 'Looking for an opponent...' : st === 'handshake' ? 'Opponent found! Checking the teams...' : host ? (s.admitted ? 'Someone is joining...' : 'Waiting for an opponent...') : 'Opponent found! Connecting...';
    return { role: 'Battle anyone', title, steps: ['Search', 'Opponent joins', 'Check teams', 'Battle'], at };
  }
  if (host) {
    const at = st === 'waiting' ? 0 : st === 'open' ? 1 : 2;
    const who = s.open ? 'Someone' : s.invite ? 'Your challenger' : 'Your friend';
    const title = st === 'waiting' ? 'Opening your room...' : st === 'handshake' ? who + ' is here! Checking the teams...' : s.admitted ? who + ' is joining...' : s.invite ? 'Waiting for your challenger...' : s.open ? 'Waiting for someone to join...' : 'Waiting for your friend to join';
    return { role: 'You\'re hosting' + (room && st !== 'waiting' ? ' · room ' + room : ''), title, steps: ['Open room', s.open ? 'Someone joins' : s.invite ? 'They join' : 'Friend joins', 'Check teams', 'Battle'], at };
  }
  const g = s.listedName;
  return { role: g ? 'You\'re joining ' + g : 'You\'re joining · room ' + room, title: st === 'handshake' ? 'Connected! Checking the teams...' : g ? 'Joining ' + g + '...' : 'Connecting to your friend...', steps: ['Connect', 'Check teams', 'Battle'], at: st === 'handshake' ? 1 : 0 };
}

/** The view of a snapshot (the header says what each is). Never throws on a snapshot online.js makes; changes nothing. */
export function onlineView(s) {
  const st = s.stage, setup = st === 'setup', going = UNDER_WAY.includes(st), board = !!s.board;
  const ms = going && s.since !== null && s.since !== undefined ? Math.max(0, s.since) : null;
  const role = s.role === 'host' ? 'host' : s.role === 'guest' ? 'guest' : 'either';
  // the invite (the link, the code large) is for a PRIVATE room a friend is coming to; a game waiting for anyone shows its code as a fallback, under a label that says so
  const friendRoom = s.role === 'host' && !s.open && !s.quick;
  const v = {
    screen: setup ? 'confirm' : going ? 'wait' : 'hidden', kind: null, stage: st, role,
    heading: '', lede: '', who: '', title: '', steps: [], at: 0,
    status: { text: (s.status && s.status.text) || '', bad: !!(s.status && s.status.bad) },
    hint: '', elapsed: ms === null ? '' : fmtClock(ms),
    code: s.codeShown && s.room ? s.room : '', codeLabel: friendRoom ? 'or tell them the room code' : 'Your room code (a friend can use it too)', friendRoom,
    link: s.codeShown && friendRoom ? (s.link || '') : '', canShare: !!s.canShare, copied: s.copied || null,
    cancel: { shown: !!(s.cancel && s.cancel.shown), label: (s.cancel && s.cancel.label) || 'Cancel' },
    team: s.team || null, name: s.name || '', fmt: s.fmt || null, fmtShown: board || s.role === 'host',
    ready: !!s.ready, canGo: !!s.canGo, canQuick: !!s.canQuick, bar: s.bar || null,
  };
  if (setup) {
    v.kind = board ? 'choose' : s.role === 'guest' ? 'invited' : 'room';
    if (board) { v.heading = 'Battle online'; v.lede = HOME_LEDE; }
    else if (s.role === 'guest') { v.heading = 'You\'re invited to a battle'; v.lede = 'Room ' + (s.room || '') + '. Check your team, then press Join the battle.'; }
    else { v.heading = 'Your room' + (s.room ? ' ' + s.room : ''); v.lede = 'Pick your team and the battle size, then open the room. Your friend joins with the code ' + (s.room || '') + '.'; }
  } else if (going) {
    const n = stepsNow(s);
    v.who = n.role; v.title = n.title; v.steps = n.steps.slice(); v.at = n.at;
    // A JOIN BY CODE THAT IS TAKING A WHILE says what to check. A code nobody has opened is not refused by the network at once (lib/netplay.js keeps trying), so the player is told what usually causes it.
    if (ms !== null && ms >= SLOW_JOIN_MS && st === 'waiting' && s.role === 'guest' && !s.listedName) v.hint = 'Taking a while? Check the code ' + (s.room || '') + ' with your friend, and that their screen still says "Waiting for your friend". If they closed it, ask them for a new link.';
  }
  return v;
}
