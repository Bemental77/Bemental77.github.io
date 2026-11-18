// pokemonarena/js/online_view.js -- WHAT THE ONLINE HALF OF THE BATTLE PAGE SHOWS, as plain data: one pure function of a snapshot of online.js's state, the rows a player can press on
// each screen, where everything stands in the 240x160 picture, and the cursor over the rows.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no network, no imports. online.js takes the snapshot and answers view() with onlineView(snapshot); online_draw.js draws
// that view from the ROM; battle_boot.js routes the buttons and the pointer to createOnlinePanel(); tools/pokemonarena_online_page_test.mjs reads the same view through the page's hook (__arenaOnline view()).
//
// THE SCREENS (INAPP.md "Wave 2": everything a player CHOOSES is in the hub's online menu; the battle page only asks what an address without the hub's one-time token must ask, and waits)
//   confirm    nothing is under way, and the page ASKS before it starts anything ("an address does not start a game"). view.kind says which question:
//                'invited'    ?np=ROOM&join=1   YOU'RE INVITED TO A BATTLE   the room, the team that will be used      JOIN THE BATTLE / CHANGE TEAM / BACK
//                'room'       ?np=ROOM&host=1   YOUR ROOM <ROOM>            the room, the team, the battle size        OPEN THE ROOM / CHANGE TEAM / BACK
//                'ask-host'   ?online=1&ask=host (the hub could not leave its token), or a room of this page that was closed or could not open      OPEN A ROOM FOR A FRIEND?   YES / BACK
//                'ask-quick'  ?online=1&ask=quick, or a search of this page that was stopped or found nothing                                       FIND AN OPPONENT?           YES / BACK
//                'ignored'    an Accept address without its token (a link from anywhere, Back, a restored tab): the words say so                    BACK
//   wait       something is under way: who the player is in it, what is happening now, the numbered steps, one sentence, how long this step has taken; for the host the room code LARGE with
//              COPY LINK / SHARE / COPY CODE; and the way out (CLOSE THE ROOM / STOP LOOKING / CANCEL) until the other player is connected. Nothing can be pressed once connected.
//              While a token of the hub is starting something (view.kind 'starting': the teams are being read and checked) it is the same screen with no rows: who the player will be in it,
//              GETTING READY..., and never the question the address would ask without the token.
//   hidden     a battle (or the error screen) has the page.
//
// THE SNAPSHOT (online.js snapshot())
//   { stage, role, room, codeShown, open, quick, invite, admitted, defecting, listedName, played (a battle of this page has been mounted), starting (a token of the hub is starting something), status: { text, bad }, since (ms this stage has
//     lasted, or null), board (the address named no room and no role), ask ('host' | 'quick' | null: what a board page asks), ignored, ready (the team list is loaded), canGo, canQuick,
//     cancel: { shown, label }, link, canShare, copied ('link' | 'code' | null), team: { key, label, size } | null, name, fmt, bar }
// THE VIEW
//   { screen, kind, stage, role ('host' | 'guest' | 'either'), heading, lede, ask (the question of an ask screen), info (the lines of a confirm screen: [{ label, value, right? }]),
//     who, title, steps, at, status: { text, bad }, hint, elapsed, code, codeLabel, friendRoom, link, canShare, copied, cancel: { shown, label }, team, name, fmt, fmtShown, ready, canGo, canQuick,
//     rows: [{ id, label, disabled? }] (what can be pressed, in order; the ids are online.js act()'s), bar }

export const UNDER_WAY = Object.freeze(['waiting', 'open', 'searching', 'asking', 'handshake', 'resuming']);
/** A join by code that has not connected after this long says what to check. */
export const SLOW_JOIN_MS = 12000;
export const fmtClock = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
export const fmtWords = (fmt) => (fmt === '6v6' ? '6 V 6' : '3 V 3');

/** The words of the confirm screens (written by this site, set in the ROM font). */
export const WORDS = Object.freeze({
  invited: 'YOU\'RE INVITED TO A BATTLE',
  room: 'YOUR ROOM',
  host: 'INVITE A FRIEND', askHost: 'OPEN A ROOM FOR A FRIEND?',
  quick: 'BATTLE ANYONE', askQuick: 'FIND AN OPPONENT?',
  ignored: 'PLAY ONLINE',
  hostLede: 'You get a link and a room code to send your friend. They open it, press Join, and the battle starts.',
  quickLede: 'Get matched with whoever is looking now. Other players see your trainer name and your online record.',
  ROWS: Object.freeze({ go: 'JOIN THE BATTLE', open: 'OPEN THE ROOM', yes: 'YES', team: 'CHANGE TEAM', back: 'BACK', copyLink: 'COPY LINK', share: 'SHARE', copyCode: 'COPY CODE', copied: 'COPIED' }),
  codeFriend: 'ROOM CODE', codeAnyone: 'CODE FOR A FRIEND',
  starting: 'Getting ready...',
});

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
    // (the ROM font has no middle dot: the room follows a comma. It is also the code drawn LARGE under the heading once the room is open)
    return { role: 'You\'re hosting' + (room && st !== 'waiting' ? ', room ' + room : ''), title, steps: ['Open room', s.open ? 'Someone joins' : s.invite ? 'They join' : 'Friend joins', 'Check teams', 'Battle'], at };
  }
  const g = s.listedName;
  return { role: g ? 'You\'re joining ' + g : 'You\'re joining, room ' + room, title: st === 'handshake' ? 'Connected! Checking the teams...' : g ? 'Joining ' + g + '...' : 'Connecting to your friend...', steps: ['Connect', 'Check teams', 'Battle'], at: st === 'handshake' ? 1 : 0 };
}

/** The view of a snapshot (the header says what each is). Never throws on a snapshot online.js makes; changes nothing. */
export function onlineView(s) {
  const st = s.stage, going = UNDER_WAY.includes(st) && !s.played, board = !!s.board;
  // a token of the hub is starting something: not a question (it would be the one the token answers), until a refusal says why it did not start
  const starting = st === 'setup' && !!s.starting && !(s.status && s.status.bad), setup = st === 'setup' && !starting;
  const ms = going && s.since !== null && s.since !== undefined ? Math.max(0, s.since) : null;
  const role = s.role === 'host' ? 'host' : s.role === 'guest' ? 'guest' : 'either';
  // the invite (the link, the code large) is for a PRIVATE room a friend is coming to; a game waiting for anyone shows its code as a fallback, under a label that says so
  const friendRoom = s.role === 'host' && !s.open && !s.quick;
  const R = WORDS.ROWS;
  const v = {
    screen: setup ? 'confirm' : going || starting ? 'wait' : 'hidden', kind: starting ? 'starting' : null, stage: st, role,
    heading: '', lede: '', ask: '', info: [], who: '', title: '', steps: [], at: 0,
    status: { text: (s.status && s.status.text) || '', bad: !!(s.status && s.status.bad) },
    hint: '', elapsed: ms === null ? '' : fmtClock(ms),
    code: going && s.codeShown && s.room ? s.room : '', codeLabel: friendRoom ? WORDS.codeFriend : WORDS.codeAnyone, friendRoom,
    link: going && s.codeShown && friendRoom ? (s.link || '') : '', canShare: !!s.canShare, copied: s.copied || null,
    cancel: { shown: going && !!(s.cancel && s.cancel.shown), label: (s.cancel && s.cancel.label) || 'Cancel' },
    team: s.team || null, name: s.name || '', fmt: s.fmt || null, fmtShown: board || s.role === 'host',
    ready: !!s.ready, canGo: !!s.ready && !!s.canGo, canQuick: !!s.ready && !!s.canQuick, rows: [], bar: s.bar || null,
  };
  if (setup) {
    const room = s.room || '', team = { label: 'TEAM', value: v.team ? v.team.label : '...' };
    v.kind = s.ignored ? 'ignored' : board || (s.role === 'host' && !room) ? (s.ask === 'quick' ? 'ask-quick' : 'ask-host') : s.role === 'guest' ? 'invited' : 'room';
    if (v.kind === 'invited') {
      v.heading = WORDS.invited; v.lede = 'Check your team, then press JOIN THE BATTLE.';
      v.info = [{ label: 'ROOM', value: room, right: v.name ? 'AS ' + v.name : '' }, team];
      v.rows = [{ id: 'go', label: R.go, disabled: !v.canGo }, { id: 'team', label: R.team }, { id: 'back', label: R.back }];
    } else if (v.kind === 'room') {
      v.heading = WORDS.room + ' ' + room; v.lede = 'Check your team and the battle size, then press OPEN THE ROOM. Your friend joins with the code ' + room + '.';
      v.info = [{ label: 'ROOM', value: room, right: v.name ? 'AS ' + v.name : '' }, { ...team, right: fmtWords(v.fmt) }];
      v.rows = [{ id: 'go', label: R.open, disabled: !v.canGo }, { id: 'team', label: R.team }, { id: 'back', label: R.back }];
    } else if (v.kind === 'ask-host') {
      v.heading = WORDS.host; v.ask = WORDS.askHost; v.lede = WORDS.hostLede;
      v.info = [{ label: '', value: v.ask }, { ...team, right: fmtWords(v.fmt) }];
      v.rows = [{ id: 'host', label: R.yes, disabled: !v.canGo }, { id: 'back', label: R.back }];
    } else if (v.kind === 'ask-quick') {
      v.heading = WORDS.quick; v.ask = WORDS.askQuick; v.lede = WORDS.quickLede;
      v.info = [{ label: '', value: v.ask }, { ...team, right: fmtWords(v.fmt) }];
      v.rows = [{ id: 'quick', label: R.yes, disabled: !v.canQuick }, { id: 'back', label: R.back }];
    } else {
      v.heading = WORDS.ignored;
      v.rows = [{ id: 'back', label: R.back }];
    }
  } else if (starting) {
    v.who = s.role === 'guest' ? 'You\'re joining' + (s.room ? ', room ' + s.room : '') : s.ask === 'quick' ? 'Battle anyone' : 'You\'re hosting';
    v.title = WORDS.starting;
  } else if (going) {
    const n = stepsNow(s);
    v.who = n.role; v.title = n.title; v.steps = n.steps.slice(); v.at = n.at;
    // A JOIN BY CODE THAT IS TAKING A WHILE says what to check. A code nobody has opened is not refused by the network at once (lib/netplay.js keeps trying), so the player is told what usually causes it.
    if (ms !== null && ms >= SLOW_JOIN_MS && st === 'waiting' && s.role === 'guest' && !s.listedName) v.hint = 'Taking a while? Check the code ' + (s.room || '') + ' with your friend, and that their screen still says "Waiting for your friend".';
    // WHAT CAN BE PRESSED. The way out is there until the other player is connected (cancel.shown); the copies are there while a room's code is on the screen. Once connected: nothing.
    if (st !== 'handshake' && st !== 'resuming') {
      if (v.code && friendRoom) { v.rows.push({ id: 'copy-link', label: v.copied === 'link' ? R.copied : R.copyLink }); if (v.canShare) v.rows.push({ id: 'share', label: R.share }); }
      if (v.code) v.rows.push({ id: 'copy-code', label: v.copied === 'code' ? R.copied : R.copyCode });
      if (v.cancel.shown) v.rows.push({ id: 'cancel', label: v.cancel.label.toUpperCase() });
    }
  }
  return v;
}

/* ------------------------------------------------------------------------------------------------ where everything stands (logical 240x160 pixels) */

/** A window's INTERIOR is what is listed here; battle_ui.js drawWindow draws its 6 px ring outside it. Rows are ROW_PITCH apart, the lines of the sentence LINE_PITCH (the small ROM font inks rows 2..12). */
export const OGEOM = Object.freeze({
  W: 240, H: 160, x: 8, w: 224, gap: 12,
  top: Object.freeze({ y: 0 }),                                   // the line over the first window: the heading of a confirm screen; who the player is, and the elapsed time, on a wait screen
  first: 20,                                                      // the first window's top
  info: Object.freeze({ line: 15 }),                              // a confirm screen's lines (the room, the team): normal font
  head: Object.freeze({ title: 15, steps: 11 }),                  // a wait screen's first window: what is happening now, then the numbered steps
  rows: Object.freeze({ pitch: 12, w: 120, wNarrow: 104, x2: 128 }),
  code: Object.freeze({ w: 104, h: 38, label: 10 }),              // the room code LARGE (the normal font at 2x) under its label
  status: Object.freeze({ bottom: 154 }),
});
/** How a sentence is set in its window, per ROM font: the line pitch, the rows of a line that hold ink (with the shadow), and where a line stands above its first inked row. */
export const SENTENCE = Object.freeze({ normal: Object.freeze({ pitch: 15, ink: 14, dy: -1 }), small: Object.freeze({ pitch: 11, ink: 11, dy: -2 }) });
const linesIn = (font, h) => { const m = SENTENCE[font]; return h < m.ink ? 0 : Math.floor((h - m.ink) / m.pitch) + 1; };

/** Where the parts of a view stand: { top, info | head, code, rows: { x, y, w, h, pitch, n }, status: { x, y, w, h, lines } } (each null when the screen has none). Pure. */
export function layoutOf(v) {
  const G = OGEOM, n = v.rows.length;
  const out = { top: { x: G.x, y: G.top.y, w: G.w }, info: null, head: null, code: null, rows: null, status: null };
  let y = G.first;
  if (v.screen === 'confirm') {
    if (v.info.length) { out.info = { x: G.x, y, w: G.w, h: v.info.length * G.info.line, line: G.info.line }; y += out.info.h + G.gap; }
    if (n) { out.rows = { x: G.x, y, w: G.rows.w, h: n * G.rows.pitch, pitch: G.rows.pitch, n }; y += out.rows.h + G.gap; }
  } else if (v.screen === 'wait') {
    out.head = { x: G.x, y, w: G.w, h: G.head.title + G.head.steps, steps: y + G.head.title }; y += out.head.h + G.gap;
    if (v.code) {
      const h = Math.max(G.code.h, n * G.rows.pitch);
      out.code = { x: G.x, y, w: G.code.w, h, label: G.code.label };
      if (n) out.rows = { x: G.rows.x2, y, w: G.rows.wNarrow, h: n * G.rows.pitch, pitch: G.rows.pitch, n };
      y += h + G.gap;
    } else if (n) { out.rows = { x: G.x, y, w: G.rows.w, h: n * G.rows.pitch, pitch: G.rows.pitch, n }; y += out.rows.h + G.gap; }
  } else return out;
  const h = G.status.bottom - y;
  out.status = { x: G.x, y, w: G.w, h, lines: linesIn('small', h) };
  return out;
}

/** The rectangles a pointer can take (one per row, as wide as the row's window with its ring). */
export function rowRects(v) {
  const L = layoutOf(v);
  return L.rows ? v.rows.map((r, i) => ({ x: L.rows.x - 4, y: L.rows.y + i * L.rows.pitch, w: L.rows.w + 8, h: L.rows.pitch, id: r.id, index: i })) : [];
}

/** Word wrap by a measure function: (font, text) -> px. A word wider than the line stands alone on one. -> lines. */
export function wrapWords(measure, font, text, px) {
  const out = []; let cur = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + ' ' + w : w;
    if (!cur || measure(font, t) <= px) cur = t; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out;
}

/** The sentence a screen says under its rows: the status when there is one, else the screen's own words. A slow join's hint TAKES THE PLACE of a status that is not a refusal ("Connecting to the
 *  room..." only repeats the heading above it), and follows one that is. -> [{ text, bad }] (paragraphs, in order). */
export function sentencesOf(v) {
  const out = [];
  if (v.status.text && !(v.hint && !v.status.bad)) out.push({ text: v.status.text, bad: v.status.bad }); else if (!v.status.text && v.lede) out.push({ text: v.lede, bad: false });
  if (v.hint) out.push({ text: v.hint, bad: false });
  return out;
}

/**
 * How the sentence of a view is set in its window: in the NORMAL ROM font when that fits (its letters read best: the small font's w is hard to tell from an H), in the small one when it does not.
 * measure: (font, text) -> px. -> { font, pitch, dy, lines: [{ text, bad }] (what is drawn), fits (false: the sentence is longer than the window even in the small font, and its end is not drawn) }
 */
export function sentenceLayout(measure, v, L = layoutOf(v)) {
  const s = L.status, ps = sentencesOf(v);
  if (!s) return { font: 'normal', pitch: SENTENCE.normal.pitch, dy: SENTENCE.normal.dy, lines: [], fits: ps.length === 0 };
  let out = null;
  for (const font of ['normal', 'small']) {
    const m = SENTENCE[font], room = linesIn(font, s.h), lines = [];
    for (const p of ps) for (const t of wrapWords(measure, font, p.text, s.w - 4)) lines.push({ text: t, bad: p.bad });
    out = { font, pitch: m.pitch, dy: m.dy, lines: lines.slice(0, room), fits: lines.length <= room };
    if (out.fits) break;
  }
  // (a sentence too long even for the small font - a judge's list of reasons, a network's own words - ends in "..." where the window ends, so it does not read as if it stopped there)
  if (!out.fits && out.lines.length) { const last = out.lines[out.lines.length - 1]; let t = last.text; while (t.length > 1 && measure(out.font, t + '...') > s.w - 4) t = t.slice(0, -1); out.lines[out.lines.length - 1] = { text: t + '...', bad: last.bad }; }
  return out;
}

/* ------------------------------------------------------------------------------------------------ the cursor over the rows */

/**
 * The cursor of the online screens: which row is highlighted, and what a button or the pointer MEANS there. It holds no other state: the rows are the view's.
 *   press(action, view)   -> null | { kind: 'move', index } | { kind: 'act', id } (A on a row; B on a confirm screen is its BACK row) | { kind: 'refused', id } (A on a row that cannot be pressed yet)
 *   pointer(ev, view)     ev: { kind: 'move' | 'click', x, y } -> the same results (a move or a finger going down highlights the row under it, a click presses it)
 *   hit(x, y, view)       -> { kind: 'row', index, id } | null          rects(view) -> rowRects(view)          cursor(view) -> the highlighted row's index (0 when there is none)
 * B ON A WAIT SCREEN NEVER CLOSES ANYTHING: it only moves the cursor onto the way out (CLOSE THE ROOM / STOP LOOKING / CANCEL), which A then presses. A room is not closed by the B that was meant
 * for the screen before.
 */
export function createOnlinePanel() {
  let cursor = 0, sig = '', onId = null, moved = false;          // moved: the PLAYER put the cursor where it is (a button, the pointer), on this screen
  function sync(v) {
    const s = v.screen + '|' + (v.kind || '') + '|' + v.rows.map((r) => r.id).join(',');
    // ANOTHER SCREEN, OR OTHER ROWS. The cursor stays on the row it was on only if the player put it there and that row is still there (SHARE appearing does not move it off COPY CODE). A cursor
    // nobody moved starts at the top: when a room opens it stands on COPY LINK, not on the way out it stood on while CLOSE THE ROOM was the only row (an A meant for nothing would close the room).
    if (s !== sig) {
      const keep = moved && sig.split('|')[0] === v.screen ? v.rows.findIndex((r) => r.id === onId) : -1;
      sig = s; cursor = keep >= 0 ? keep : 0; if (keep < 0) moved = false;
    }
    cursor = v.rows.length ? Math.max(0, Math.min(v.rows.length - 1, cursor)) : 0;
    onId = v.rows[cursor] ? v.rows[cursor].id : null;
    return cursor;
  }
  const setCursor = (v, i) => { cursor = i; moved = true; onId = v.rows[i] ? v.rows[i].id : null; return { kind: 'move', index: i }; };
  const activate = (v) => { const r = v.rows[cursor]; return !r ? null : r.disabled ? { kind: 'refused', id: r.id } : { kind: 'act', id: r.id }; };
  function hit(x, y, v) {
    for (const r of rowRects(v)) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return { kind: 'row', index: r.index, id: r.id };
    return null;
  }
  return {
    cursor: (v) => sync(v),
    press(action, v) {
      sync(v);
      const n = v.rows.length;
      if (!n || v.screen === 'hidden') return null;
      if (action === 'up') return setCursor(v, (cursor + n - 1) % n);
      if (action === 'down') return setCursor(v, (cursor + 1) % n);
      if (action === 'a') return activate(v);
      if (action === 'b') {
        const i = v.rows.findIndex((r) => r.id === (v.screen === 'confirm' ? 'back' : 'cancel'));
        if (i < 0) return null;
        if (v.screen === 'confirm') return { kind: 'act', id: 'back' };
        return i === cursor ? null : setCursor(v, i);
      }
      return null;
    },
    pointer(ev, v) {
      sync(v);
      if (!ev || v.screen === 'hidden' || ev.x === undefined || ev.x === null) return null;
      const h = hit(ev.x, ev.y, v);
      if (!h) return null;
      const moved = h.index !== cursor;
      setCursor(v, h.index);
      if (ev.kind === 'click') return activate(v);
      return moved ? { kind: 'move', index: h.index } : null;
    },
    hit, rects: (v) => rowRects(v),
  };
}

/** The screen reader's words for a view (the canvas has only a static label). The elapsed time is left out: it changes by itself and would be read out every second. */
export function speakOnline(v, cursor = 0) {
  if (v.screen === 'hidden') return '';
  const row = v.rows[cursor] ? ' ' + v.rows[cursor].label + ', ' + (cursor + 1) + ' of ' + v.rows.length + '.' : '';
  const says = sentencesOf(v).map((p) => p.text).join(' ');
  if (v.screen === 'confirm') return [v.heading + '.', v.info.map((l) => [l.label, l.value, l.right].filter(Boolean).join(' ')).join('. ') + (v.info.length ? '.' : ''), says].filter(Boolean).join(' ') + row;
  return [v.who + '.', v.title, v.steps.length ? 'Step ' + (v.at + 1) + ' of ' + v.steps.length + ': ' + (v.steps[v.at] || '') + '.' : '', v.code ? v.codeLabel + ' ' + v.code.split('').join(' ') + '.' : '', says].filter(Boolean).join(' ') + row;
}
