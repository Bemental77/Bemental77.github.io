// pokemonarena/js/online_hub.js -- PLAY ONLINE in the hub's picture: the app's state machine. Everything a player decides about online play is a row here, drawn from the ROM by
// online_screen.js; online_ctl.js carries the effects out. There is no HTML for any of it (pokemonarena/INAPP.md: "everything in the app"; "The app interface" is the contract this file follows).
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no network, no randomness. It is loaded with the hub's first paint, so its imports are the light pure ones only.
//
// SCREENS (one hub path, 'online'; which of the two is up is this app's state)
//   the menu      TRAINER CENTER / BATTLE ANYONE / INVITE A FRIEND / JOIN A FRIEND / TEAM / SIZE / NAME / OPEN TO BATTLES / BACK   (nine rows, ONLINE_VISIBLE shown: it scrolls)
//   the invite    the hub page was opened with a room in its address (?np=ROOM&join=1 or &host=1: the battle page's CHANGE TEAM row, an old bookmark, a link somebody sent):
//                 "YOU'RE INVITED / ROOM <CODE>"  TEAM / NAME / JOIN THE BATTLE / BACK        "YOUR ROOM / ROOM <CODE>"  TEAM / SIZE / NAME / OPEN THE ROOM / BACK
//                 BACK (or B) puts the room away and shows the menu. IT APPEARS BY ITSELF, so for its first INVITE_ARM_TICKS it answers nothing but the d-pad's up and down, and its cursor
//                 starts on TEAM, never on the button: a press that was on its way to the main menu joins nobody
// WHAT A ROW DOES
//   TRAINER CENTER     ctx.go('center')
//   BATTLE ANYONE      a notice in message pages of what it publishes and connects to, then FIND AN OPPONENT? YES / NO (NO first). YES -> { type: 'start', kind: 'quick' }
//   INVITE A FRIEND    a notice of what a battle with a friend connects to, then OPEN A ROOM FOR A FRIEND? YES / NO. YES -> { type: 'start', kind: 'host' }: the ctl writes the one-time START token
//                      and leaves for the battle page (INAPP.md "Contract 1"), whose waiting screen shows the link and the code
//   JOIN A FRIEND      the text entry for the room code -> { type: 'join', code, req }: the ctl reduces what was typed to a code and checks it (js/online.js roomFromInput, ROOM_RE) and answers
//                      roomTaken(req, room) / roomRefused(req, words). A room code: the same notice, then JOIN ROOM <CODE>? YES / NO. YES -> { type: 'start', kind: 'join', room }
//   TEAM               a choice over the saved LEGAL teams (the active trainer's first: the battle page's own order) and RANDOM TEAM -> { type: 'prefs', teamKey }. With no saved team: A opens the Team Builder
//   SIZE               3 V 3 / 6 V 6 -> { type: 'prefs', fmt }; a team of fewer than three Pokemon plays 6 V 6 only
//   NAME               the text entry (NAME_MAX characters, the rule of the battle page's name field: onlineName) -> { type: 'name', value | null (empty: the trainer's own name again) }
//   OPEN TO BATTLES    { type: 'open' }: the ctl asks the hub page's presence service to switch (the first ON asks the disclosure in the picture)
// NOTHING LEAVES FOR THE BATTLE PAGE BEFORE THE PLAYER HAS BEEN TOLD what that page connects to and what it shows of them: every start is the YES of a question whose pages say it. The long
// notice (the public servers by name, the host its script comes from, that they see the IP address, that the team played goes to the other player) is read once per browser; after its YES the
// question comes with one line.
// WHICH NAME IS WHERE. The NAME row is the name an opponent sees in a battle and the one BATTLE ANYONE lists. OPEN TO BATTLES and the Trainer Center list the ACTIVE TRAINER's name
// (presence_boot.js readTrainer), whatever the NAME row holds: every line that speaks of a listing says the name that is listed.
// WHICH TEAM AND SIZE ARE SHOWN is online_prefs.js preselect() over the same list, in the same order, as the battle page builds: what is shown here is what fights there.
// EFFECTS (every one carries app: 'online' and is carried out by online_ctl.js)
//   { type: 'data' }                         from onData(): it is what wakes the ctl at page load (OPEN TO BATTLES listens on every hub screen, and the main menu says whether the player is open)
//   { type: 'start', kind: 'quick' | 'host' | 'room' | 'join', room?, seen? }      leave for the battle page (the token first)
//   { type: 'join-open' }  { type: 'join', code, req }  { type: 'paste', text }    the room code entry was opened / accepted (req: the number of that request) / given a paste
//   { type: 'prefs', teamKey?, fmt? }  { type: 'name', value }  { type: 'open' }
//   { type: 'invite-away' }                  BACK on the invite screen: the room is put away (the ctl takes it out of the page's address)
//   { type: 'leave' } | { type: 'stay' }     the answer to "this browser blocks the storage ... GO ON / BACK"
// WHAT THE CTL TELLS THIS MODEL (its own methods, at the end): the stored preferences and name, the presence status and what the listing says, the public servers the notices name, the room in
// the address, what became of a room code, that the browser's storage is blocked.
// THE MAIN MENU'S ROW (mainRow()): hub_model.js asks every app how its row of the main menu reads; PLAY ONLINE says there, at a glance, whether the player is open to battles.

import { MENU } from './hub_menu.js';
import { createEntrySlot } from './textentry.js';
import { wrapDialog, DIALOG_ARM_TICKS, DIALOG_MAX_PAGES } from './hub_dialog.js';
import { preselect, savedTeamKey, RANDOM_TEAM } from './online_prefs.js';

const ID = 'online';
const PATHS = Object.freeze(['online']);
const parent = () => 'main';

export const ONLINE_VISIBLE = 8;                       // the menu shows this many rows; the ninth scrolls into view
export const NAME_MAX = 10;                            // netmatch.js NAME_MAX (a test compares them)
export const ROOM_MAX = 8;                             // the longest room code (openlobby.js ROOM_RE)
export const QUICK_ID = 'online:quick';                // the dialog: what BATTLE ANYONE publishes, FIND AN OPPONENT?
export const FRIEND_ID = 'online:friend';              // the dialog: what a battle with a friend connects to, OPEN A ROOM FOR A FRIEND? / JOIN ROOM <CODE>? / OPEN ROOM <CODE>?
export const BLOCKED_ID = 'online:blocked';            // the dialog: the storage is blocked, GO ON / BACK
export const NOTE_ID = 'online:note';                  // a notice of this app (a room code that is not one, an address that names no room, a switch that failed)
export const BUSY_TICKS = 600;                         // how long the menu waits for its ctl to answer (a room code being checked) before it gives the buttons back: ten seconds
export const INVITE_ARM_TICKS = DIALOG_ARM_TICKS;      // how long the invite screen answers nothing after it appeared by itself (0.6 s: what a question nobody asked for waits)
export const MORE_PX = 14;                             // the room the "more" arrow takes at the end of a page's second line (hub_presence.js MORE_PX: a test compares them)
export const HOSTS_SHOWN = 6;                          // a notice names at most this many servers (a ?wsbroker= list could be any length)
export const PASTE_MAX = 2048;                         // the most of a paste that is handed to the ctl (an invite link is far shorter)
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
/**
 * The words this site writes for the screen (the ROM has no such menu); every line is measured against its window by tools/pokemonarena_hub_online_test.mjs, with the widest name (ten
 * capitals) and the widest room code. A function takes the NAME THAT IS LISTED or shown (`who`), or the room.
 */
export const WORDS = Object.freeze({
  title: 'PLAY ONLINE',
  center: (who) => ['Meet everyone who is open. Walking in', 'lists ' + who + ' and your look.'],
  anyone: (who, rec) => ['Get matched with whoever is looking.', 'Lists ' + who + (rec ? ' with online record.' : ', no online record.')],
  invite: ['Open a private room and get a link', 'for a friend. It is never listed.'],
  join: ['Type the room code a friend sent', 'you. Nothing is listed.'],
  teamLoading: ['Looking for your teams...', ''],
  teamNone: ['You have no saved team yet, so a', 'random one is used. A: TEAM BUILDER.'],
  teamNoneLegal: ['Your teams cannot battle yet, so a', 'random one is used. A: TEAM BUILDER.'],
  teamUnavailable: ['Your saved teams cannot be read in', 'this browser: a random one is used.'],
  teamRandom: ['Six random Pokemon, new every battle.', 'A random team lists no record.'],
  size3: ['3 V 3: each player picks 3 of 6.', 'Used for a battle that you open.'],
  size6: ['6 V 6: the whole team fights.', 'Used for a battle that you open.'],
  sizeFixed: ['A team of fewer than 3 Pokemon', 'plays 6 V 6 only.'],
  name: (who) => ['Shown in a battle and BATTLE ANYONE.', 'OPEN TO BATTLES lists ' + who + '.'],
  nameNone: (who) => ['You are Host or Guest in a battle.', 'OPEN TO BATTLES lists ' + who + '.'],
  openOff: (who) => ['Lists trainer name ' + who + ' and', 'online record on public servers. A: on.'],
  openOn: (who) => ['You are listed as ' + who + ': anyone', 'can challenge you here. A: off.'],
  openStarting: ['Going open to battles...', ''],
  openOffline: ['On, but no public server can be', 'reached: nobody can see you now.'],
  openLoading: (who) => ['Lists trainer name ' + who + ' and', 'online record on public servers.'],
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
  nameHint: "Empty: your trainer's name is used.",
  nameNote: "Online names: A-Z a-z 0-9 . ' ! ? -",
  roomTitle: "YOUR FRIEND'S ROOM CODE?",
  noRoomInLink: 'That link names no room.',
  quickAsk: 'Find an opponent?',
  // a battle with a friend: the question (kind: 'host' = INVITE A FRIEND, 'join' = a room code or JOIN THE BATTLE, 'room' = OPEN THE ROOM), and the one line that comes with it once the long notice was read
  friendAsk: (kind, room) => (kind === 'host' ? 'Open a room for a friend?' : kind === 'room' ? 'Open room ' + room + '?' : 'Join room ' + room + '?'),
  friendShort: (kind, room) => (kind === 'host' ? 'A private room, over public servers.' : 'Room ' + room + ', over public servers.'),
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

/** A name kept in this browser (a team, a trainer, a nickname) as plain text for the picture: the ROM font's own tokens ({CURSOR}, {UP} ...) are written with braces, and a name is not one. */
const plain = (s) => String(s === null || s === undefined ? '' : s).replace(/\{/g, '(').replace(/\}/g, ')');

/** The public servers the battle page dials, in words. named: with their host names (at most HOSTS_SHOWN; false: the number alone, for a list too long to read). */
function serversText(board, named) {
  const b = board || {}, all = Array.isArray(b.hosts) ? b.hosts.filter((x) => typeof x === 'string' && x) : [];
  const hosts = all.slice(0, HOSTS_SHOWN), more = all.length - hosts.length;
  const servers = all.length ? all.length + ' public server' + (all.length === 1 ? '' : 's') + (named ? ' (' + hosts.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') + ')' : '') : 'public servers';
  return { servers, cdn: named && typeof b.cdn === 'string' && b.cdn ? b.cdn : 'a public CDN' };
}
/** What the battle page connects to as soon as it is opened with a token, and what those servers learn. s: serversText(). */
const connects = (s) => 'The battle page connects to ' + s.servers + ' and loads a script from ' + s.cdn + '. They can see your IP address.';
/** What every online battle hands to the other player, and how (the old Play online page said it under its three cards). */
const TEAM_GOES = 'The team you play and your choices go to the other player, over a public relay when there is no direct path.';
/** What BATTLE ANYONE shows of the player: the name (the battle page says "Host" when there is none) and, unless the team is a random one, an online record. */
const seenAs = (w, brief) => 'the name ' + (typeof w.name === 'string' && w.name ? w.name : 'Host') + (w.rec === false ? '. A random team lists no online record.' : ' and your online record' + (brief ? '.' : ' (wins and losses).'));
/** A press that does nothing and is not heard (INAPP.md "Sound"). */
const SILENT = Object.freeze([Object.freeze({ type: 'sfx', key: null })]);

/**
 * What BATTLE ANYONE publishes and to whom, said BEFORE anything is. board: { hosts: the public servers the battle page dials, cdn: the host its script comes from } (the ctl reads them off
 * openlobby.js). who: { name: the name that will be listed (the NAME row's), rec: is an online record listed with it (a saved team's; a random team has none) }.
 */
export function quickWords(board, who, named = true) {
  return 'Other players see ' + seenAs(who || {}) + ' ' + connects(serversText(board, named)) + ' If nobody is waiting, your game is listed there until someone joins. ' + TEAM_GOES;
}
/** The same, for a player who has read the long notice in this browser before. */
export function quickShort(who) { return 'Other players will see ' + seenAs(who || {}, true); }

/**
 * What a battle with a friend connects to, said BEFORE the page leaves. kind: 'host' (INVITE A FRIEND) | 'join' (a room code, JOIN THE BATTLE) | 'room' (OPEN THE ROOM); board as quickWords.
 * Nothing is listed, but the pairing goes through the same public servers, and the team played goes to the other player.
 */
export function friendWords(kind, room, board, named = true) {
  const what = kind === 'host' ? 'A private room for a friend is never listed.' : kind === 'room' ? 'You open room ' + room + ' for your friend. It is never listed.' : 'You join room ' + room + '. Nothing is listed.';
  return what + ' ' + connects(serversText(board, named)) + ' ' + TEAM_GOES;
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
    listed: null,                                      // the name the presence service's listing carries while it is on (svc.trainer()), or null: the active trainer's name is what it will carry
    board: null,                                       // { hosts, cdn }: what the notices name; null until the ctl has said
    seen: false,                                       // the player has said YES to a long notice in this browser before: the short ones are shown
    invite: null, inviteUp: false,                     // the room in the page's address, { room, role: 'guest' | 'host' }; inviteUp: its screen is the one shown
    arm: 0,                                            // ticks for which the invite screen, which appeared by itself, still answers nothing
    flash: null,                                       // two lines that stand in the message box until the next move
    busy: null, busyTicks: 0, req: 0,                  // 'join': a room code is with the ctl; req: the number of that request (every OK takes the next one: an answer to an older one is dropped)
    friend: null,                                      // { kind, room }: the start the question that is up (FRIEND_ID) asks about
    entryId: null, room: '',                           // which text entry is open ('name' | 'room'); the room code last typed
    deeper: false,                                     // the screen was left for one this menu opened (the Trainer Center, the Team Builder): B there comes back to the row it was opened from
    noteLocal: false,                                  // the notice that is up is about this screen only (a room code refused): it goes when the screen is left
  };

  /* ------------------------------------------------------------------------------------------ the team, the size and the names that will be used */
  // THE BATTLE PAGE'S OWN LIST, IN ITS OWN ORDER (js/online.js gatherTeams): the saved LEGAL teams, the active trainer's first, then the random team. preselect() then says which one is selected,
  // exactly as that page asks it: so the team shown here is the team that fights.
  function choices() {
    const act = ctx.activeId(), out = [];
    const ps = ctx.profiles().slice().sort((a, b) => (a.id === act ? -1 : 0) - (b.id === act ? -1 : 0));
    for (const p of ps) for (const t of p.teams || []) {
      if (!t.legal) continue;
      const key = savedTeamKey(p.id, t.id);
      if (key) out.push({ key, size: t.size, label: plain(t.name), trainer: p.name, names: (t.names || []).map(plain), lead: t.lead || null });
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
  // THE NAME OPEN TO BATTLES AND THE TRAINER CENTER LIST: what the listing says while it is up; before that, what it will say: the ACTIVE trainer's name, or "Player" when there is none
  // (presence_boot.js readTrainer and its identity). It is not the NAME row's: the lines that speak of that listing name it
  function trainerListed() {
    if (S.listed) return S.listed;
    const act = ctx.profiles().find((p) => p.id === ctx.activeId()) || null;
    return onlineName(act ? act.name : '', 'Player');
  }
  // what BATTLE ANYONE lists: the NAME row's name ("Host" when there is none: the battle page's own word) and, for a saved team, its trainer's online record
  const quickWho = (sel) => ({ name: nameNow(sel).text || 'Host', rec: sel.choice.key !== RANDOM_TEAM });

  /* ------------------------------------------------------------------------------------------ the rows of each screen */
  // kinds: 'item' / 'button' (a label; A does it), 'choice' (a label and a value with the ROM's arrows; left / right / A change it), 'value' (a label and a value; A does something about it)
  const inviteShown = () => !!S.invite && S.inviteUp;
  /** The invite screen appeared by itself a moment ago: it does not answer yet (only up and down move its cursor). */
  const unarmed = () => inviteShown() && S.arm > 0;
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
    if (c.key === RANDOM_TEAM) {
      if (sel.saved) return WORDS.teamRandom;
      if (ctx.dataState() === 'unavailable') return WORDS.teamUnavailable;          // (the store could not be opened: "you have no saved team" would be the wrong reason)
      return ctx.profiles().some((p) => (p.teams || []).length > 0) ? WORDS.teamNoneLegal : WORDS.teamNone;
    }
    const ln = nameLines(c.names);
    return [ln[0] || '(empty)', ln[1] || (c.trainer ? 'A team of ' + plain(c.trainer) + '.' : '')];
  }
  function help(row, sel) {
    if (S.flash) return S.flash;
    if (S.busy === 'join') return WORDS.checking;
    const who = trainerListed();
    switch (row ? row.id : '') {
      case 'center': return WORDS.center(who);
      case 'anyone': { const q = quickWho(sel); return WORDS.anyone(q.name, q.rec); }
      case 'invite': return WORDS.invite;
      case 'join': return WORDS.join;
      case 'team': return teamHelp(sel);
      case 'size': return sel.formats.length < 2 ? WORDS.sizeFixed : sel.fmt === '3v3' ? WORDS.size3 : WORDS.size6;
      case 'name': return nameNow(sel).from === 'none' ? WORDS.nameNone(who) : WORDS.name(who);
      case 'open': return S.open === 'on' ? WORDS.openOn(who) : S.open === 'starting' ? WORDS.openStarting : S.open === 'offline' ? WORDS.openOffline : S.open === 'unavailable' ? WORDS.openNone : S.open === 'loading' ? WORDS.openLoading(who) : WORDS.openOff(who);
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
    e.setNote(note || WORDS.nameHint);
    return [];
  }
  // THE ROOM CODE: the ctl reduces what was typed or pasted with the battle page's own function (js/online.js roomFromInput) and says whether it is a room code (ROOM_RE); this file knows neither.
  // EVERY OK IS A REQUEST OF ITS OWN (S.req): the ctl's answer names the request it answers, and one that is not the request in hand is dropped. A flag alone was not enough: a second code typed
  // while the first was still being checked raised it again, and the first check's answer then opened the first room.
  function openRoom(value, note) {
    S.entryId = 'room';
    const e = entry.open({ id: 'room', title: WORDS.roomTitle, value: value || '', max: ROOM_MAX, charset: 'code', allowEmpty: true }, (r) => {
      S.entryId = null;
      if (!r.ok) return [];
      S.room = r.value; S.busy = 'join'; S.busyTicks = BUSY_TICKS; S.req++;
      return [{ app: ID, type: 'join', code: r.value, req: S.req }];
    });
    if (note) e.setNote(note);
  }

  /* ------------------------------------------------------------------------------------------ what this app says and asks in the dialog layer */
  /** Message pages of a text, each leaving the room of the "more" arrow, then the question's own page. */
  const pagesFor = (text, ask) => wrapDialog(text, ctx.measure, ctx.msgPx - MORE_PX).concat([[ask, '']]);
  /**
   * A notice in the picture (the address named a room that is not one, a room code was refused, the switch failed). It is never the answer to the press under it (it comes from the ctl: after
   * a check, or by itself at the page's load), so it listens only after the arm delay: the A that was on its way does not dismiss words nobody has read. local: it is about this screen only.
   */
  function note(words, local) {
    const text = String(words === undefined || words === null ? '' : words);
    if (!text.trim()) return false;
    ctx.dialog.close(NOTE_ID);
    S.noteLocal = !!local;
    return ctx.dialog.open({ id: NOTE_ID, pages: wrapDialog(text, ctx.measure, ctx.msgPx - MORE_PX), choice: null, armTicks: DIALOG_ARM_TICKS });
  }
  const start = (kind, room) => [{ app: ID, type: 'start', kind, room: room || null, seen: true }];
  // BATTLE ANYONE: NOTHING IS PUBLISHED BEFORE THE PLAYER HAS BEEN TOLD WHAT IS. The words first, then the question with NO under the cursor; only its YES starts anything (onDialog)
  function askQuick() {
    if (!S.board) { S.flash = WORDS.notReady; return []; }
    const who = quickWho(selection());
    const make = (named) => pagesFor(S.seen ? quickShort(who) : quickWords(S.board, who, named), WORDS.quickAsk);
    let pages = make(true);
    if (pages.length > DIALOG_MAX_PAGES) pages = make(false);          // (a ?wsbroker= list of very long names: the number of servers is said, not their names)
    if (!ctx.dialog.open({ id: QUICK_ID, pages, choice: { options: WORDS.answers.slice(), cursor: NO } })) S.flash = WORDS.notReady;
    return [];
  }
  // A BATTLE WITH A FRIEND (INVITE A FRIEND, a room code that was checked, JOIN THE BATTLE, OPEN THE ROOM): nothing is listed, but the battle page connects to the public servers by itself as
  // soon as it is opened with the token, and nothing there says so first. So it is said HERE, before the page leaves: the long notice with NO under the cursor until this browser has said YES
  // to one; after that one line with the question, YES under the cursor. late: the question does not come under the press (the ctl checked a code first): it listens only after the arm delay.
  function askFriend(kind, room, late) {
    if (!S.board) { S.flash = WORDS.notReady; return []; }
    const ask = WORDS.friendAsk(kind, room);
    const make = (named) => pagesFor(friendWords(kind, room, S.board, named), ask);
    let pages = S.seen ? [[WORDS.friendShort(kind, room), ask]] : make(true);
    if (pages.length > DIALOG_MAX_PAGES) pages = make(false);
    S.friend = { kind, room: room || null };
    const took = ctx.dialog.open({ id: FRIEND_ID, pages, choice: { options: WORDS.answers.slice(), cursor: S.seen ? YES : NO }, ...(late ? { armTicks: DIALOG_ARM_TICKS } : {}) });
    if (!took) { S.friend = null; S.flash = WORDS.notReady; }
    return [];
  }

  /* ------------------------------------------------------------------------------------------ what a press does */
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
  /** Open another hub screen from a row of this one: B there comes back to that row (enter() keeps the cursor). */
  function deeper(path) { const fx = ctx.go(path); if (fx.length) S.deeper = true; return fx; }
  function activate(row) {
    S.flash = null;
    if (!row || row.disabled || S.busy) return [];          // (a row that cannot be used says why in the box, which it already does: the press changes nothing)
    switch (row.id) {
      case 'center': return deeper('center');
      case 'anyone': return askQuick();
      case 'invite': return askFriend('host', null, false);
      case 'join': openRoom(S.invite ? S.invite.room : ''); return [{ app: ID, type: 'join-open' }];
      case 'team': return row.kind === 'choice' ? change(row, 1) : deeper('builder');
      case 'size': return change(row, 1);
      case 'name': return openName();
      case 'open': return [{ app: ID, type: 'open' }];
      case 'go': return askFriend(S.invite.role === 'host' ? 'room' : 'join', S.invite.room, false);
      case 'back': return goBack();
      default: return [];
    }
  }
  function press(_path, action) {
    const efx = entry.press(action);
    if (efx) return efx;
    const rs = rows(), n = rs.length;
    S.cursor = clamp(S.cursor, 0, n - 1);
    if (unarmed() && action !== 'up' && action !== 'down') return SILENT.slice();          // THE INVITE SCREEN APPEARED BY ITSELF: the press that was on its way to the screen it replaced does nothing here
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
    if (unarmed()) return SILENT.slice();          // (the cursor follows the pointer; a tap on a row of an invite screen that has only just appeared presses nothing)
    const row = rows()[h.index];
    const fx = row && row.kind === 'choice' && !row.disabled && h.zone === 'prev' ? change(row, -1) : activate(row);
    settle();
    return fx;
  }

  const model = {
    id: ID, paths: PATHS, parent,
    // ENTERED FROM THE MAIN MENU THE CURSOR STARTS ON THE FIRST ROW: a second press of the A that opened the screen must not land on whatever row was left under the cursor last time (OPEN TO
    // BATTLES would switch). Coming back from a screen this menu opened (the Trainer Center, the Team Builder) it is where it was.
    enter() { if (!S.deeper) { S.cursor = 0; S.offset = 0; } S.deeper = false; S.flash = null; settle(); },
    // (a question of this screen makes no sense on another: it is taken back, unanswered; a room code that is still being checked is given up: its answer finds nobody waiting)
    leave() {
      entry.close(); S.entryId = null; S.busy = null; S.flash = null; S.friend = null;
      ctx.dialog.close(QUICK_ID); ctx.dialog.close(FRIEND_ID); ctx.dialog.close(BLOCKED_ID);
      if (S.noteLocal) { ctx.dialog.close(NOTE_ID); S.noteLocal = false; }
    },
    press,
    hit: (_path, x, y) => (entry.isOpen() ? entry.hit(x, y) : hitRow(x, y)),
    pointer,
    rects() {
      if (entry.isOpen()) return entry.rects();
      const rs = rows(), g = geom(rs.length), w = windowOf(rs.length, S.offset);
      return rs.slice(w.off, w.off + w.size).map((r, i) => ({ x: g.x - 4, y: g.y + i * g.pitch, w: g.w + 8, h: g.pitch, id: r.id }));
    },
    tick() {
      if (unarmed()) S.arm--;          // (it counts only while the invite screen is the one shown: an invitation that waits behind another screen starts to listen 0.6 s after it is seen)
      if (S.busy && --S.busyTicks <= 0) { S.busy = null; S.flash = WORDS.slow; }
    },
    // the effect that wakes online_ctl.js when the page comes up, whatever screen is open (INAPP.md "A ctl that must run from the page's load")
    onData() { settle(); return [{ app: ID, type: 'data' }]; },
    onDialog(id, value) {
      if (id === QUICK_ID) { if (value !== YES) return []; S.seen = true; return start('quick', null); }
      if (id === FRIEND_ID) { const f = S.friend; S.friend = null; if (value !== YES || !f) return []; S.seen = true; return start(f.kind, f.room); }
      if (id === BLOCKED_ID) return [{ app: ID, type: value === GO_ON ? 'leave' : 'stay' }];
      if (id === NOTE_ID) S.noteLocal = false;
      return [];
    },
    wantsText: () => entry.isOpen(),
    type(_path, input) {
      if (!entry.isOpen()) return [];
      // a PASTE into the room code (more than one character at once) may be a friend's whole link: the ctl reduces it to its code (the entry's own filter would make letters of the address)
      if (S.entryId === 'room' && input && typeof input.text === 'string' && input.text.length > 1) return [{ app: ID, type: 'paste', text: input.text.slice(0, PASTE_MAX) }];
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
          armed: !unarmed(),          // false: the screen does not answer yet (the renderer leaves the cursor out, as the dialog layer does)
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
      return { screen: inviteShown() ? 'invite' : 'menu', row: rs[cur].id, cursor: cur, offset: windowOf(rs.length, S.offset).off, team: sel.choice.key, fmt: sel.fmt, name: nameNow(sel).text, typed: S.typed, open: S.open, listed: trainerListed(), invite: S.invite ? { ...S.invite } : null, armed: !unarmed(), busy: S.busy, req: S.req, entry: S.entryId, seen: S.seen, flash: !!S.flash };
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
    /** The presence service's status: 'loading' | 'unavailable' | 'off' | 'starting' | 'on' | 'offline'; and, while it is on, what its listing says (svc.trainer(): { name }), else null. */
    setPresence(status, listing) {
      S.open = STATUSES.includes(status) ? status : 'off';
      S.listed = listing && typeof listing.name === 'string' ? onlineName(listing.name, 'Player') : null;
    },
    /** What the notices name: { hosts: [...], cdn }. */
    setBoard(b) { S.board = b && typeof b === 'object' ? { hosts: Array.isArray(b.hosts) ? b.hosts.map(String) : [], cdn: typeof b.cdn === 'string' ? b.cdn : '' } : null; },
    /** Has the player said YES to a long notice in this browser before? */
    setSeen(v) { S.seen = !!v; },
    /**
     * THE ROOM IN THE PAGE'S ADDRESS: { room, role: 'guest' | 'host' } shows the invite screen; null takes it away. -> true when the screen is (now) the one shown on PLAY ONLINE.
     * The screen appears BY ITSELF (the ctl read the address; the player may be looking at the main menu, a press already on its way): it answers nothing for INVITE_ARM_TICKS, and its cursor
     * is on its first row (TEAM), not on the button that joins.
     */
    setInvite(inv) {
      const ok = !!inv && typeof inv.room === 'string' && /^[A-Za-z0-9]{4,8}$/.test(inv.room) && (inv.role === 'guest' || inv.role === 'host');
      entry.close(); S.entryId = null; S.flash = null;
      S.invite = ok ? { room: inv.room.toUpperCase(), role: inv.role } : null; S.inviteUp = ok; S.cursor = 0; S.offset = 0;
      S.arm = ok ? INVITE_ARM_TICKS : 0;
      settle();
      return ok;
    },
    /** A notice in the picture (the address named a room that is not one, both roles; the switch failed). -> was it put */
    say(words) { return note(words, false); },
    /**
     * THE CTL'S ANSWER TO A ROOM CODE (req: the request it answers, from the `join` effect). It counts only while that request is the one the menu is waiting on: after the player left the
     * screen, after the menu gave up, or after another code was typed, it is dropped. -> was it taken
     * roomTaken: the code is a room code. Nothing leaves yet: the question says what joining connects to, and it listens only after the arm delay (it does not come under a press).
     */
    roomTaken(req, room) {
      if (S.busy !== 'join' || req !== S.req) return false;
      S.busy = null;
      askFriend('join', String(room), true);
      return true;
    },
    /** ... roomRefused: it is not one. The entry comes back with what was typed, under the reason (the battle page's own words, from the ctl). */
    roomRefused(req, words) {
      if (S.busy !== 'join' || req !== S.req) return false;
      S.busy = null;
      openRoom(S.room); note(words, true);
      return true;
    },
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
