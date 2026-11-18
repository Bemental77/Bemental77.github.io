// pokemonarena/js/online_hub.js -- PLAY ONLINE in the hub's picture: the app's state machine. Everything a player decides about online play is a row here, drawn from the ROM by
// online_screen.js; online_ctl.js carries the effects out. There is no HTML for any of it (pokemonarena/INAPP.md: "everything in the app"; "The app interface" is the contract this file follows).
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no network, no randomness. It is loaded with the hub's first paint, so its imports are the light pure ones only.
//
// SCREENS (one hub path, 'online'; which of the two is up is this app's state)
//   the menu      TRAINER CENTER / BATTLE ANYONE / INVITE A FRIEND / JOIN A FRIEND / TEAM / SIZE / NAME / OPEN TO BATTLES / BACK   (nine rows, ONLINE_VISIBLE shown: it scrolls)
//   the invite    the hub page was opened with a room in its address (?np=ROOM&join=1 or &host=1: the battle page's CHANGE TEAM row, an old bookmark):
//                 "YOU'RE INVITED / ROOM <CODE>"  TEAM / NAME / JOIN THE BATTLE / BACK        "YOUR ROOM / ROOM <CODE>"  TEAM / SIZE / NAME / OPEN THE ROOM / BACK
//                 BACK (or B) puts the room away and shows the menu
// WHAT A ROW DOES
//   TRAINER CENTER     ctx.go('center')
//   BATTLE ANYONE      a notice in message pages of what it publishes, then FIND AN OPPONENT? YES / NO (NO first). YES -> { type: 'start', kind: 'quick' }
//   INVITE A FRIEND    { type: 'start', kind: 'host' }: the ctl writes the one-time START token and leaves for the battle page (INAPP.md "Contract 1"), whose waiting screen shows the link and the code
//   JOIN A FRIEND      the text entry for the room code -> { type: 'join', code }: the ctl reduces what was typed to a code and checks it (js/online.js roomFromInput, ROOM_RE), then leaves
//   TEAM               a choice over the saved LEGAL teams (the active trainer's first: the battle page's own order) and RANDOM TEAM -> { type: 'prefs', teamKey }. With no saved team: A opens the Team Builder
//   SIZE               3 V 3 / 6 V 6 -> { type: 'prefs', fmt }; a team of fewer than three Pokemon plays 6 V 6 only
//   NAME               the text entry (NAME_MAX characters, the rule of the battle page's name field: onlineName) -> { type: 'name', value | null (empty: the trainer's own name again) }
//   OPEN TO BATTLES    { type: 'open' }: the ctl asks the hub page's presence service to switch (the first ON asks the disclosure in the picture)
// WHICH TEAM AND SIZE ARE SHOWN is online_prefs.js preselect() over the same list, in the same order, as the battle page builds: what is shown here is what fights there.
// EFFECTS (every one carries app: 'online' and is carried out by online_ctl.js)
//   { type: 'data' }                         from onData(): it is what wakes the ctl at page load (OPEN TO BATTLES listens on every hub screen, and the main menu says whether the player is open)
//   { type: 'start', kind: 'quick' | 'host' | 'room' | 'join', room?, seen? }      leave for the battle page (the token first)
//   { type: 'join-open' }  { type: 'join', code }  { type: 'paste', text }          the room code entry was opened / accepted / given a paste
//   { type: 'prefs', teamKey?, fmt? }  { type: 'name', value }  { type: 'open' }
//   { type: 'invite-away' }                  BACK on the invite screen: the room is put away (the ctl takes it out of the page's address)
//   { type: 'leave' } | { type: 'stay' }     the answer to "this browser blocks the storage ... GO ON / BACK"
// WHAT THE CTL TELLS THIS MODEL (its own methods, at the end): the stored preferences and name, the presence status, the public servers the notice names, the room in the address, what became of a
// room code, that the browser's storage is blocked.
// THE MAIN MENU'S ROW (mainRow()): hub_model.js asks every app how its row of the main menu reads; PLAY ONLINE says there, at a glance, whether the player is open to battles.

import { MENU } from './hub_menu.js';
import { createEntrySlot } from './textentry.js';
import { wrapDialog, DIALOG_ARM_TICKS } from './hub_dialog.js';
import { preselect, savedTeamKey, RANDOM_TEAM } from './online_prefs.js';

const ID = 'online';
const PATHS = Object.freeze(['online']);
const parent = () => 'main';

export const ONLINE_VISIBLE = 8;                       // the menu shows this many rows; the ninth scrolls into view
export const NAME_MAX = 10;                            // netmatch.js NAME_MAX (a test compares them)
export const ROOM_MAX = 8;                             // the longest room code (openlobby.js ROOM_RE)
export const QUICK_ID = 'online:quick';                // the dialog: what BATTLE ANYONE publishes, FIND AN OPPONENT?
export const BLOCKED_ID = 'online:blocked';            // the dialog: the storage is blocked, GO ON / BACK
export const BUSY_TICKS = 600;                         // how long the menu waits for its ctl to answer (a room code being checked) before it gives the buttons back: ten seconds
export const MORE_PX = 14;                             // the room the "more" arrow takes at the end of a page's second line (hub_presence.js MORE_PX: a test compares them)
export const HOSTS_SHOWN = 6;                          // the notice names at most this many servers (a ?wsbroker= list could be any length)
export const YES = 0, NO = 1;
export const GO_ON = 0;

// geometry shared with the renderer and with hit testing (logical 240x160 pixels)
export const OGEOM = Object.freeze({
  menu: Object.freeze({ x: MENU.x, y: MENU.y, w: 148, pitch: 12 }),                                  // the menu: nine rows, eight shown, 12 px apart (the main menu's own spacing)
  invite: Object.freeze({ x: MENU.x, y: 34, w: 148, pitch: 14 }),                                    // the invite screen's rows (four or five), under its banner
  banner: Object.freeze({ x: 12, y: 6, w: 216, h: 16 }),                                             // the invite screen's banner: "YOU'RE INVITED" on the left, "ROOM K7Q2P" on the right
  title: Object.freeze({ x: 172, y: 84, w: 60, h: 16 }),                                             // the menu's name, where the main menu has the game's
  lead: Object.freeze({ cx: 202, cy: 38, cyInvite: 70 }),                                            // the lead Pokemon of the team chosen
  label: 12,                                                                                         // a row's label starts this far into the window (the cursor stands before it)
  value: 38,                                                                                         // a CHOICE row under the cursor: its left arrow stands here, its right arrow at the row's right end, the value between them
  arrow: 10,                                                                                         // the room a value leaves at the right end of its row (the scroll arrow stands there on the first / last row shown; a choice's right arrow)
});

export const FMT_LABEL = Object.freeze({ '3v3': '3 V 3', '6v6': '6 V 6' });
/** The words this site writes for the screen (the ROM has no such menu); every line is measured against its window by tools/pokemonarena_hub_online_test.mjs. */
export const WORDS = Object.freeze({
  title: 'PLAY ONLINE',
  center: ['Meet everyone who is open to battle.', 'Walking in lists your name and look.'],
  anyone: ['Get matched with whoever is looking.', 'They see your name and online record.'],
  invite: ['Open a private room and get a link', 'for a friend. It is never listed.'],
  join: ['Type the room code a friend sent', 'you. Nothing is listed.'],
  teamLoading: ['Looking for your teams...', ''],
  teamNone: ['You have no saved team yet, so a', 'random one is used. A: TEAM BUILDER.'],
  teamNoneLegal: ['Your teams cannot battle yet, so a', 'random one is used. A: TEAM BUILDER.'],
  teamRandom: ['Six random Pokemon, new every battle.', 'A random team lists no record.'],
  size3: ['3 V 3: each player picks 3 of 6.', 'Used for a battle that you open.'],
  size6: ['6 V 6: the whole team fights.', 'Used for a battle that you open.'],
  sizeFixed: ['A team of fewer than 3 Pokemon', 'plays 6 V 6 only.'],
  nameTyped: ['Other players see this name. A', "changes it; empty = your trainer's."],
  nameTrainer: ['Other players see your trainer name.', 'A types another one.'],
  nameNone: ['Other players see you as Host or', 'Guest. A types a name.'],
  openOff: ['Lists your name and online record', 'so anyone can challenge you. A: on.'],
  openOn: ['You are listed: anyone can challenge', 'you while you are here. A: off.'],
  openStarting: ['Going open to battles...', ''],
  openOffline: ['On, but no public server can be', 'reached: nobody can see you now.'],
  openLoading: ['Lists your name and online record', 'so anyone can challenge you.'],
  openNone: ['Open to battles could not load.', 'Reload the page to try again.'],
  back: ['Back to the main menu.', ''],
  inviteBack: ['Put this room away and show the', 'PLAY ONLINE menu.'],
  joinGo: (room) => ['Join room ' + room + ' with this team.', 'Your friend sees your name and team.'],
  hostGo: (room) => ['Open room ' + room + ' for your friend.', 'It is never listed.'],
  invited: "YOU'RE INVITED",
  yourRoom: 'YOUR ROOM',
  room: (room) => 'ROOM ' + room,
  checking: ['Checking the room code...', ''],
  slow: ['That took too long.', 'Try again.'],
  notReady: ['Online play is still loading.', 'Try again in a moment.'],
  noStore: ['This browser is not keeping settings,', 'so the battle may not follow this.'],
  nameTitle: 'YOUR NAME ONLINE?',
  nameNote: "Online names: A-Z a-z 0-9 . ' ! ? -",
  roomTitle: "YOUR FRIEND'S ROOM CODE?",
  noRoomInLink: 'That link names no room.',
  quickShort: 'Other players will see your trainer name and your online record.',
  quickAsk: 'Find an opponent?',
  blocked: 'This browser blocks the storage the Arena uses to carry your choice to the battle. The next screen will ask you once more.',
  blockedAsk: 'Go on?',
  blockedOptions: ['GO ON', 'BACK'],
  answers: ['YES', 'NO'],
  // the main menu's PLAY ONLINE row (mainRow): what it reads while the player is open to battles, and while that is on but no public server can be reached
  mainOpen: 'PLAY ONLINE: OPEN',
  mainOpenHelp: ['You are open to battles: anyone can', 'challenge you. A opens PLAY ONLINE.'],
  mainOffline: 'PLAY ONLINE: OFFLINE',
  mainOfflineHelp: ['Open to battles is on, but no public', 'server can be reached right now.'],
});

/**
 * A trainer name as it goes online: netmatch.js cleanName's rule (ASCII letters, digits and . ' _ ! ? -, single spaces, at most NAME_MAX), kept here so that this file does not import the
 * engine's module graph into the hub's first paint. tools/pokemonarena_hub_online_test.mjs compares the two over thousands of strings.
 */
export function onlineName(s, fallback = '') {
  let t = '';
  try { t = String(s === null || s === undefined ? '' : s).normalize('NFKC'); } catch (_e) { t = String(s === null || s === undefined ? '' : s); }
  t = t.replace(/[^A-Za-z0-9 .'_!?-]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return t || fallback;
}

/** What BATTLE ANYONE publishes and to whom, said BEFORE anything is. board: { hosts: the public servers the battle page dials, cdn: the host its script comes from } (the ctl reads them off openlobby.js). */
export function quickWords(board) {
  const b = board || {}, all = Array.isArray(b.hosts) ? b.hosts.filter((x) => typeof x === 'string' && x) : [];
  const hosts = all.slice(0, HOSTS_SHOWN), more = all.length - hosts.length;
  const servers = all.length ? all.length + ' public server' + (all.length === 1 ? '' : 's') + ' (' + hosts.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') + ')' : 'public servers';
  return 'BATTLE ANYONE matches you with whoever is looking right now. Other players see your trainer name and your online record (wins and losses). '
    + 'The battle page connects to ' + servers + ' and loads a script from ' + (typeof b.cdn === 'string' && b.cdn ? b.cdn : 'a public CDN') + '. They can see your IP address. '
    + 'If nobody is waiting, your game is listed there until someone joins.';
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const STATUSES = Object.freeze(['loading', 'unavailable', 'off', 'starting', 'on', 'offline']);

export function createOnlineHub(ctx) {
  const entry = createEntrySlot();
  const S = {
    cursor: 0, offset: 0,                              // the menu's cursor (an index into the rows of the screen that is up) and the first row shown
    prefs: { teamKey: null, fmt: null },               // online_prefs.js: what the browser has stored (the ctl reads it, and is told every change)
    typed: null,                                       // the name the player typed (localStorage 'arena.online.name'), or null: the trainer's own name is used
    open: 'loading',                                   // the presence service's status (hub_presence.js status())
    board: null,                                       // { hosts, cdn }: what the BATTLE ANYONE notice names; null until the ctl has said
    seen: false,                                       // the player has said YES to the long BATTLE ANYONE notice in this browser before: the short one is shown
    invite: null, inviteUp: false,                     // the room in the page's address, { room, role: 'guest' | 'host' }; inviteUp: its screen is the one shown
    flash: null,                                       // two lines that stand in the message box until the next move
    busy: null, busyTicks: 0,                          // 'join': a room code is with the ctl
    entryId: null, room: '',                           // which text entry is open ('name' | 'room'); the room code last typed
  };

  /* ------------------------------------------------------------------------------------------ the team, the size and the name that will be used */
  // THE BATTLE PAGE'S OWN LIST, IN ITS OWN ORDER (js/online.js gatherTeams): the saved LEGAL teams, the active trainer's first, then the random team. preselect() then says which one is selected,
  // exactly as that page asks it: so the team shown here is the team that fights.
  function choices() {
    const act = ctx.activeId(), out = [];
    const ps = ctx.profiles().slice().sort((a, b) => (a.id === act ? -1 : 0) - (b.id === act ? -1 : 0));
    for (const p of ps) for (const t of p.teams || []) {
      if (!t.legal) continue;
      const key = savedTeamKey(p.id, t.id);
      if (key) out.push({ key, size: t.size, label: t.name, trainer: p.name, names: t.names || [], lead: t.lead || null });
    }
    out.push({ key: RANDOM_TEAM, size: 6, label: 'RANDOM TEAM', trainer: null, names: [], lead: null });
    return out;
  }
  function selection() {
    const list = choices(), pre = preselect(S.prefs, list, {});
    const choice = list.find((c) => c.key === pre.teamKey) || list[list.length - 1];
    return { list, choice, fmt: pre.fmt, saved: list.length - 1, formats: choice.size >= 3 ? ['3v3', '6v6'] : ['6v6'] };
  }
  // the name the battle page will use: the one typed; else the trainer who owns the team chosen; else the active trainer; else none (that page then says Host or Guest)
  function nameNow(sel) {
    if (S.typed) return { text: S.typed, from: 'typed' };
    const ps = ctx.profiles(), act = ps.find((p) => p.id === ctx.activeId()) || ps[0] || null;
    const t = onlineName(sel.choice.trainer || '', '') || onlineName(act ? act.name : '', '');
    return t ? { text: t, from: 'trainer' } : { text: '', from: 'none' };
  }

  /* ------------------------------------------------------------------------------------------ the rows of each screen */
  // kinds: 'item' / 'button' (a label; A does it), 'choice' (a label and a value with the ROM's arrows; left / right / A change it), 'value' (a label and a value; A does something about it)
  const inviteShown = () => !!S.invite && S.inviteUp;
  const teamRow = (sel) => (ctx.dataState() === 'loading' ? { id: 'team', kind: 'value', label: 'TEAM', value: '...', disabled: true }
    : sel.saved ? { id: 'team', kind: 'choice', label: 'TEAM', value: sel.choice.label } : { id: 'team', kind: 'value', label: 'TEAM', value: sel.choice.label });
  const sizeRow = (sel) => (sel.formats.length > 1 ? { id: 'size', kind: 'choice', label: 'SIZE', value: FMT_LABEL[sel.fmt] } : { id: 'size', kind: 'value', label: 'SIZE', value: FMT_LABEL[sel.fmt], disabled: true });
  const nameRow = (sel) => ({ id: 'name', kind: 'value', label: 'NAME', value: nameNow(sel).text || '(NONE)' });
  const openRow = () => ({ id: 'open', kind: 'value', label: 'OPEN TO BATTLES', value: S.open === 'on' || S.open === 'starting' || S.open === 'offline' ? 'ON' : 'OFF', ...(S.open === 'unavailable' ? { disabled: true } : {}) });
  function rowsOf(sel) {
    if (inviteShown()) {
      const host = S.invite.role === 'host';
      return [teamRow(sel)].concat(host ? [sizeRow(sel)] : [], [nameRow(sel), { id: 'go', kind: 'button', label: host ? 'OPEN THE ROOM' : 'JOIN THE BATTLE' }, { id: 'back', kind: 'button', label: 'BACK' }]);
    }
    return [
      { id: 'center', kind: 'item', label: 'TRAINER CENTER' },
      { id: 'anyone', kind: 'item', label: 'BATTLE ANYONE' },
      { id: 'invite', kind: 'item', label: 'INVITE A FRIEND' },
      { id: 'join', kind: 'item', label: 'JOIN A FRIEND' },
      teamRow(sel), sizeRow(sel), nameRow(sel), openRow(),
      { id: 'back', kind: 'button', label: 'BACK' },
    ];
  }
  const rows = () => rowsOf(selection());
  /** Where the rows of the screen that is up stand: { x, y, w, pitch }. */
  const geom = () => (inviteShown() ? OGEOM.invite : OGEOM.menu);
  /** The rows shown: { off, size } for n rows with the cursor at S.cursor and the window at `offset`, moved just far enough to keep the cursor in it. */
  function windowOf(n, offset) {
    const size = Math.min(n, ONLINE_VISIBLE), cur = clamp(S.cursor, 0, Math.max(0, n - 1));
    let off = clamp(offset, 0, Math.max(0, n - size));
    if (cur < off) off = cur; else if (cur >= off + size) off = cur - size + 1;
    return { off, size };
  }
  /** After anything that may have moved the cursor or changed the rows: the cursor is on a row and the window holds it. (view() only reads: it is called several times a frame.) */
  function settle() { const n = rows().length; S.cursor = clamp(S.cursor, 0, Math.max(0, n - 1)); S.offset = windowOf(n, S.offset).off; }
  function selectRow(id) { const i = rows().findIndex((r) => r.id === id); if (i < 0) return false; S.cursor = i; settle(); return true; }

  /* ------------------------------------------------------------------------------------------ the two lines under the list: what the row does and what it shares */
  // a team's Pokemon, as many to a line as fit the box; what does not fit two lines is counted ("+2")
  function nameLines(names) {
    const fits = (s) => ctx.measure('normal', s) <= ctx.msgPx, out = [];
    let i = 0;
    for (let line = 0; line < 2 && i < names.length; line++) {
      let s = String(names[i++]);
      while (i < names.length && fits(s + ', ' + names[i])) s += ', ' + names[i++];
      out.push(s);
    }
    if (i < names.length) {
      const parts = out[out.length - 1].split(', ');
      while (parts.length > 1 && !fits(parts.join(', ') + ' +' + (names.length - i))) { parts.pop(); i--; }
      out[out.length - 1] = parts.join(', ') + ' +' + (names.length - i);
    }
    return out;
  }
  function teamHelp(sel) {
    if (ctx.dataState() === 'loading') return WORDS.teamLoading;
    const c = sel.choice;
    if (c.key === RANDOM_TEAM) return sel.saved ? WORDS.teamRandom : ctx.profiles().some((p) => (p.teams || []).length > 0) ? WORDS.teamNoneLegal : WORDS.teamNone;
    const ln = nameLines(c.names);
    return [ln[0] || '(empty)', ln[1] || (c.trainer ? 'A team of ' + c.trainer + '.' : '')];
  }
  function help(row, sel) {
    if (S.flash) return S.flash;
    if (S.busy === 'join') return WORDS.checking;
    switch (row ? row.id : '') {
      case 'center': return WORDS.center;
      case 'anyone': return WORDS.anyone;
      case 'invite': return WORDS.invite;
      case 'join': return WORDS.join;
      case 'team': return teamHelp(sel);
      case 'size': return sel.formats.length < 2 ? WORDS.sizeFixed : sel.fmt === '3v3' ? WORDS.size3 : WORDS.size6;
      case 'name': { const n = nameNow(sel); return n.from === 'typed' ? WORDS.nameTyped : n.from === 'trainer' ? WORDS.nameTrainer : WORDS.nameNone; }
      case 'open': return S.open === 'on' ? WORDS.openOn : S.open === 'starting' ? WORDS.openStarting : S.open === 'offline' ? WORDS.openOffline : S.open === 'unavailable' ? WORDS.openNone : S.open === 'loading' ? WORDS.openLoading : WORDS.openOff;
      case 'go': return S.invite.role === 'host' ? WORDS.hostGo(S.invite.room) : WORDS.joinGo(S.invite.room);
      case 'back': return inviteShown() ? WORDS.inviteBack : WORDS.back;
      default: return ['', ''];
    }
  }

  /* ------------------------------------------------------------------------------------------ the text entries */
  // NAME: what is typed goes through the battle page's own rule. A name that rule would change (a character it drops) is shown again as it would be used, with the reason, for the player to accept.
  function openName(value, note) {
    S.entryId = 'name';
    const e = entry.open({ id: 'name', title: WORDS.nameTitle, value: value === undefined ? S.typed || '' : value, max: NAME_MAX, charset: 'name', allowEmpty: true }, (r) => {
      S.entryId = null;
      if (!r.ok) return [];
      const raw = r.value.replace(/\s+/g, ' ').trim();
      if (!raw) { S.typed = null; return [{ app: ID, type: 'name', value: null }]; }          // an empty name: the typed one is forgotten, the trainer's own is used again
      const clean = onlineName(raw, '');
      if (clean !== raw) { openName(clean, WORDS.nameNote); return []; }
      S.typed = clean;
      return [{ app: ID, type: 'name', value: clean }];
    });
    if (note) e.setNote(note);
    return [];
  }
  // THE ROOM CODE: the ctl reduces what was typed or pasted with the battle page's own function (js/online.js roomFromInput) and says whether it is a room code (ROOM_RE); this file knows neither
  function openRoom(value, note) {
    S.entryId = 'room';
    const e = entry.open({ id: 'room', title: WORDS.roomTitle, value: value || '', max: ROOM_MAX, charset: 'code', allowEmpty: true }, (r) => {
      S.entryId = null;
      if (!r.ok) return [];
      S.room = r.value; S.busy = 'join'; S.busyTicks = BUSY_TICKS;
      return [{ app: ID, type: 'join', code: r.value }];
    });
    if (note) e.setNote(note);
  }

  /* ------------------------------------------------------------------------------------------ what a press does */
  const start = (kind, room) => [{ app: ID, type: 'start', kind, room: room || null }];
  // BATTLE ANYONE: NOTHING IS PUBLISHED BEFORE THE PLAYER HAS BEEN TOLD WHAT IS. The words first, then the question with NO under the cursor; only its YES starts anything (onDialog)
  function askQuick() {
    if (!S.board) { S.flash = WORDS.notReady; return []; }
    const px = ctx.msgPx - MORE_PX;
    const pages = wrapDialog(S.seen ? WORDS.quickShort : quickWords(S.board), ctx.measure, px).concat([[WORDS.quickAsk, '']]);
    if (!ctx.dialog.open({ id: QUICK_ID, pages, choice: { options: WORDS.answers.slice(), cursor: NO } })) S.flash = WORDS.notReady;
    return [];
  }
  function change(row, dir) {
    S.flash = null;
    if (!row || row.kind !== 'choice' || row.disabled) return [];
    const sel = selection();
    if (row.id === 'team') {
      const i = sel.list.indexOf(sel.choice), next = sel.list[(i + dir + sel.list.length) % sel.list.length];
      S.prefs = { ...S.prefs, teamKey: next.key };
      return [{ app: ID, type: 'prefs', teamKey: next.key }];
    }
    if (row.id === 'size') {
      const i = sel.formats.indexOf(sel.fmt), fmt = sel.formats[(i + dir + sel.formats.length) % sel.formats.length];
      S.prefs = { ...S.prefs, fmt };
      return [{ app: ID, type: 'prefs', fmt }];
    }
    return [];
  }
  function goBack() {
    if (inviteShown()) { S.inviteUp = false; S.cursor = 0; S.offset = 0; S.flash = null; return [{ app: ID, type: 'invite-away' }]; }          // the room is put away: the menu is shown (B from there leaves)
    return ctx.back();
  }
  function activate(row) {
    S.flash = null;
    if (!row || row.disabled || S.busy) return [];          // (a row that cannot be used says why in the box, which it already does: the press changes nothing)
    switch (row.id) {
      case 'center': return ctx.go('center');
      case 'anyone': return askQuick();
      case 'invite': return start('host');
      case 'join': openRoom(S.invite ? S.invite.room : ''); return [{ app: ID, type: 'join-open' }];
      case 'team': return row.kind === 'choice' ? change(row, 1) : ctx.go('builder');
      case 'size': return change(row, 1);
      case 'name': return openName();
      case 'open': return [{ app: ID, type: 'open' }];
      case 'go': return start(S.invite.role === 'host' ? 'room' : 'join', S.invite.room);
      case 'back': return goBack();
      default: return [];
    }
  }
  function press(_path, action) {
    const efx = entry.press(action);
    if (efx) return efx;
    const rs = rows(), n = rs.length;
    S.cursor = clamp(S.cursor, 0, n - 1);
    let fx = [];
    switch (action) {
      case 'up': S.flash = null; S.cursor = (S.cursor + n - 1) % n; break;
      case 'down': S.flash = null; S.cursor = (S.cursor + 1) % n; break;
      case 'left': fx = change(rs[S.cursor], -1); break;
      case 'right': fx = change(rs[S.cursor], 1); break;
      case 'a': fx = activate(rs[S.cursor]); break;
      case 'b': fx = goBack(); break;
      default: break;
    }
    settle();
    return fx;
  }

  /* ------------------------------------------------------------------------------------------ the pointer */
  /** Which row is under the logical point? { kind: 'row', index, zone } | null. zone 'prev' = the left half of a choice row's value (its left arrow's side). */
  function hitRow(x, y) {
    const rs = rows(), g = geom(rs.length), w = windowOf(rs.length, S.offset);
    if (x < g.x - 6 || x >= g.x + g.w + 6 || y < g.y || y >= g.y + w.size * g.pitch) return null;
    const index = w.off + Math.floor((y - g.y) / g.pitch), row = rs[index];
    const mid = g.x + OGEOM.value + (g.w - 4 - OGEOM.value) / 2;          // (the middle of the value, between its two arrows: online_screen.js draws them from OGEOM.value to the row's right end)
    return { kind: 'row', index, zone: row && row.kind === 'choice' && x >= g.x + OGEOM.value - 4 && x < mid ? 'prev' : 'main' };
  }
  function pointer(_path, ev) {
    const efx = entry.pointer(ev);
    if (efx) return efx;
    if (!ev) return [];
    if (ev.kind === 'wheel') { const k = Math.abs(ev.steps || 0); let out = []; for (let i = 0; i < k; i++) out = out.concat(press(null, (ev.steps || 0) > 0 ? 'down' : 'up')); return out; }
    const h = ev.x === undefined || ev.x === null ? null : hitRow(ev.x, ev.y);
    if (!h) return [];
    if (S.cursor !== h.index) S.flash = null;
    S.cursor = h.index;
    if (ev.kind !== 'click') return [];
    const row = rows()[h.index];
    const fx = row && row.kind === 'choice' && !row.disabled && h.zone === 'prev' ? change(row, -1) : activate(row);
    settle();
    return fx;
  }

  const model = {
    id: ID, paths: PATHS, parent,
    enter() { S.flash = null; settle(); },          // (the cursor stays where the player left it: coming back from the Team Builder is still on TEAM)
    leave() { entry.close(); S.entryId = null; S.busy = null; S.flash = null; ctx.dialog.close(QUICK_ID); ctx.dialog.close(BLOCKED_ID); },          // (a question of this screen makes no sense on another: it is taken back, unanswered)
    press,
    hit: (_path, x, y) => (entry.isOpen() ? entry.hit(x, y) : hitRow(x, y)),
    pointer,
    rects() {
      if (entry.isOpen()) return entry.rects();
      const rs = rows(), g = geom(rs.length), w = windowOf(rs.length, S.offset);
      return rs.slice(w.off, w.off + w.size).map((r, i) => ({ x: g.x - 4, y: g.y + i * g.pitch, w: g.w + 8, h: g.pitch, id: r.id }));
    },
    tick() { if (S.busy && --S.busyTicks <= 0) { S.busy = null; S.flash = WORDS.slow; } },
    // the effect that wakes online_ctl.js when the page comes up, whatever screen is open (INAPP.md "A ctl that must run from the page's load")
    onData() { settle(); return [{ app: ID, type: 'data' }]; },
    onDialog(id, value) {
      if (id === QUICK_ID) { if (value !== YES) return []; S.seen = true; return [{ app: ID, type: 'start', kind: 'quick', room: null, seen: true }]; }
      if (id === BLOCKED_ID) return [{ app: ID, type: value === GO_ON ? 'leave' : 'stay' }];
      return [];
    },
    wantsText: () => entry.isOpen(),
    type(_path, input) {
      if (!entry.isOpen()) return [];
      // a PASTE into the room code (more than one character at once) may be a friend's whole link: the ctl reduces it to its code (the entry's own filter would make letters of the address)
      if (S.entryId === 'room' && input && typeof input.text === 'string' && input.text.length > 1) return [{ app: ID, type: 'paste', text: input.text.slice(0, 2048) }];
      return entry.type(input) || [];
    },
    view(path, base) {
      const sel = selection(), rs = rowsOf(sel), g = geom(rs.length), w = windowOf(rs.length, S.offset), cur = clamp(S.cursor, 0, rs.length - 1), up = inviteShown();
      const lead = sel.choice.lead || (base && base.mascot) || null;
      return {
        ...base, screen: path, app: ID, mascot: null,
        menu: { rows: rs.slice(w.off, w.off + w.size), cursor: cur - w.off, offset: w.off, total: rs.length, up: w.off > 0, down: w.off + w.size < rs.length, x: g.x, y: g.y, w: g.w, pitch: g.pitch },
        msg: help(rs[cur], sel).slice(0, 2),
        entry: entry.view(),
        online: {
          screen: up ? 'invite' : 'menu',
          head: up ? [S.invite.role === 'host' ? WORDS.yourRoom : WORDS.invited, WORDS.room(S.invite.room)] : [WORDS.title],
          lead: lead ? { species: lead.species, shiny: !!lead.shiny, gender: lead.gender || null } : null,
        },
      };
    },
    speak(v) {
      const o = v.online || {}, m = v.menu || { rows: [], cursor: 0 }, r = m.rows[m.cursor];
      return (o.screen === 'invite' ? (o.head || []).join(', ') + '. ' : 'Play online. ') + (r ? r.label + (r.value !== undefined ? ' ' + r.value : '') + '. ' : '') + (v.msg || []).filter(Boolean).join(' ');
    },
    title: () => 'Pokemon Arena - Play Online',
    state() {
      const sel = selection(), rs = rowsOf(sel), cur = clamp(S.cursor, 0, rs.length - 1);
      return { screen: inviteShown() ? 'invite' : 'menu', row: rs[cur].id, cursor: cur, offset: windowOf(rs.length, S.offset).off, team: sel.choice.key, fmt: sel.fmt, name: nameNow(sel).text, typed: S.typed, open: S.open, invite: S.invite ? { ...S.invite } : null, busy: S.busy, entry: S.entryId, seen: S.seen, flash: !!S.flash };
    },

    /* ---- the app's own methods ---- */
    /** THE MAIN MENU'S PLAY ONLINE ROW (hub_model.js asks): while the player is open to battles the row says so, on every visit to the main menu. null = the row as the menu words it. */
    mainRow() {
      if (S.open === 'on') return { label: WORDS.mainOpen, help: WORDS.mainOpenHelp };
      if (S.open === 'offline') return { label: WORDS.mainOffline, help: WORDS.mainOfflineHelp };
      return null;
    },
    /* ---- what online_ctl.js tells the model (it then calls env.redraw()) ---- */
    /** The stored preferences (online_prefs.js readOnlinePrefs). */
    setPrefs(p) { S.prefs = { teamKey: p && typeof p.teamKey === 'string' ? p.teamKey : null, fmt: p && typeof p.fmt === 'string' ? p.fmt : null }; settle(); },
    /** The name the player typed on an earlier visit (localStorage 'arena.online.name'), or nothing. */
    setName(v) { S.typed = onlineName(v, '') || null; },
    /** The presence service's status: 'loading' | 'unavailable' | 'off' | 'starting' | 'on' | 'offline'. */
    setPresence(status) { S.open = STATUSES.includes(status) ? status : 'off'; },
    /** What the BATTLE ANYONE notice names: { hosts: [...], cdn }. */
    setBoard(b) { S.board = b && typeof b === 'object' ? { hosts: Array.isArray(b.hosts) ? b.hosts.map(String) : [], cdn: typeof b.cdn === 'string' ? b.cdn : '' } : null; },
    /** Has the player said YES to the long BATTLE ANYONE notice in this browser before? */
    setSeen(v) { S.seen = !!v; },
    /** THE ROOM IN THE PAGE'S ADDRESS: { room, role: 'guest' | 'host' } shows the invite screen; null takes it away. -> true when the screen is (now) the one shown on PLAY ONLINE. */
    setInvite(inv) {
      const ok = !!inv && typeof inv.room === 'string' && /^[A-Za-z0-9]{4,8}$/.test(inv.room) && (inv.role === 'guest' || inv.role === 'host');
      entry.close(); S.entryId = null; S.flash = null;
      S.invite = ok ? { room: inv.room.toUpperCase(), role: inv.role } : null; S.inviteUp = ok; S.cursor = 0; S.offset = 0;
      if (ok) selectRow('go');
      settle();
      return ok;
    },
    /** A notice in the picture (the address named a room that is not one, both roles ...). */
    say(words) { return ctx.notify(String(words || '')); },
    /** The room code that was typed is not one: the entry comes back with what was typed, under the reason (the battle page's own words, from the ctl). */
    roomRefused(words) { S.busy = null; if (ctx.path() === ID && !entry.isOpen()) { openRoom(S.room); ctx.notify(String(words || '')); } },
    /** The room code was taken (the ctl is leaving for the battle page). */
    roomTaken() { S.busy = null; },
    /** What a paste into the room code came to: a code (it takes the field's place; `note`: a line under the keys, e.g. that it was cut), or null (an address that names no room). -> whether the entry was there to take it */
    roomPasted(code, note) {
      if (!entry.isOpen() || S.entryId !== 'room') return false;
      if (typeof code === 'string' && code) openRoom(code, note); else entry.entry().setNote(WORDS.noRoomInLink);
      return true;
    },
    /** The one-time token could not be written (the browser blocks the storage): say so, and ask before going on to the address where the battle page asks once more. -> was the question put */
    blocked() {
      const pages = wrapDialog(WORDS.blocked, ctx.measure, ctx.msgPx - MORE_PX).concat([[WORDS.blockedAsk, '']]);
      return ctx.dialog.open({ id: BLOCKED_ID, pages, choice: { options: WORDS.blockedOptions.slice(), cursor: GO_ON }, armTicks: DIALOG_ARM_TICKS });          // (it arrives when the ctl has tried the storage, not under the press: the A that is still on its way answers nothing)
    },
    /** A preference could not be stored: the battle page will not see it. */
    notStored() { S.flash = WORDS.noStore; },
    /** Put the cursor on the row with this id (the tests; a ctl that opens the screen on a row). -> whether there is one. */
    select: (id) => selectRow(id),
    /** The rows of the screen that is up, ALL of them (hub.rows() gives the ones shown). */
    allRows: () => rows(),
  };
  return model;
}

export const APP = Object.freeze({ id: ID, paths: PATHS, parent, create: createOnlineHub });
