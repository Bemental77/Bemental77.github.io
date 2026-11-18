// pokemonarena/js/textentry.js -- TEXT ENTRY in the 240x160 picture: one shared component for every name, nickname, search word, room code and team code a player types.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. The model is here; textentry_screen.js draws its view with the ROM font, the ROM window ring and the ROM
// party-menu chips; hub_screen.js lays that over whatever screen carries `view.entry`; boot.js sends a real keyboard's keys and a paste here while the open app says wantsText().
//
//   const e = createTextEntry({ id: 'nick', title: 'NICKNAME?', value: 'Sparky', max: 10, charset: 'name' });
//   e.press('a')                    // the key under the cursor is typed          -> null while the entry stays open
//   e.type({ text: 'abc' })         // a real keyboard, or a paste                -> null
//   e.type({ key: 'enter' })        // OK                                          -> { id: 'nick', ok: true, value: 'SparkyAabc' }   (the RESULT: the entry is finished)
//   e.view()                        // plain JSON for the renderer (and for view.entry)
//
// AN APP EMBEDS ONE THROUGH A SLOT (createEntrySlot): the slot holds at most one open entry and the function that takes its result, and answers `undefined` to every input while no entry is open,
// so the app's own handling follows on the same line:
//
//   const entry = createEntrySlot();
//   press(path, a) { const fx = entry.press(a); if (fx) return fx; ... the app's own keys ... }
//   entry.open({ id: 'name', title: 'YOUR NAME?', value: S.name, max: 10, charset: 'name' }, (r) => { if (r.ok) S.name = r.value; return []; });      // the function returns EFFECTS
//
// OPTIONS    id          names the entry in its result
//            title       the line above the field (written by the caller, set in the ROM font)
//            value       the text the field starts with (characters the charset refuses are dropped, the rest is cut to `max`); the caret starts at its end
//            max         the longest value, 1..ENTRY_MAX (1024)
//            charset     'name' | 'code' | 'teamcode' | 'search' (CHARSETS below)
//            allowEmpty  true: OK accepts an empty (or all-spaces) field. Default false: OK then needs `min` characters (default 1) and says so otherwise
//            min         the shortest value OK accepts when allowEmpty is not set (default 1)
//            mask        a one-character string: the field shows that character for every character typed (view.value never holds the real text; value() does)
// CHARSETS   name      what profile.js textIssue accepts, one character at a time: every character of the Gen-3 charset (charset.js) that survives an encode / decode round trip, no braces, no
//                      control characters. U+2019 (a phone's curly apostrophe) is typed as the plain apostrophe. Keys: A-Z, a-z (SHIFT), 0-9, - ' . ! ? , / & + : ; ( ) e-acute, the two
//                      gender signs, SPACE
//            code      room codes: A-Z and 0-9; a lower-case letter is typed as its capital. No SHIFT, no SPACE
//            teamcode  the ARENA1 team code alphabet (teamcode.js): A-Z a-z 0-9 . - _ ; '/' is typed as '_' and '+' as '-' (the standard base64 spellings), white space in a paste is dropped.
//                      THE ROM FONT HAS NO UNDERSCORE: the key and the field show '_' as the ROM's '/' glyph (glyphOf), which is not a character of the alphabet, so it cannot be misread
//            search    A-Z a-z 0-9, space, hyphen, apostrophe (U+2019 is typed as the plain apostrophe)
// INPUT      d-pad     moves the key cursor (left / right wrap in a row, up / down wrap through the rows; a shorter row takes the nearest key)
//            A         types the key under the cursor (or does what it says: abc / ABC, SPACE, DEL, CANCEL, OK)
//            B         deletes the character before the caret (the one after it when the caret is at the start); B ON AN EMPTY FIELD CANCELS
//            START     OK            SELECT   abc / ABC (charsets with two pages)            L / R   move the caret
//            pointer   move / down on a key puts the cursor on it, a click on it presses it
//            type({ text })   inserts at the caret every character the charset takes, as far as `max` allows (a real keyboard's key, or a paste)
//            type({ key })    'backspace' | 'delete' | 'left' | 'right' | 'home' | 'end' | 'enter' (OK) | 'escape' (CANCEL). A real keyboard's Backspace on an empty field does NOTHING
//                             (only the B button cancels there: holding Backspace to clear a field must not throw the player out)
// RESULT     every input method returns null while the entry stays open, and { id, ok: true, value } (OK) or { id, ok: false } (CANCEL) when it finishes; after that the entry takes no more input.

import { defaultCodec } from './charset.js';

export const CHARSETS = Object.freeze(['name', 'code', 'teamcode', 'search']);
export const ENTRY_MAX = 1024;
export const ENTRY_COLS = 13;

// geometry shared with the renderer and the hit test (logical 240x160 pixels)
export const TEGEOM = Object.freeze({
  head: Object.freeze({ x: 12, y: 6, w: 216, h: 36 }),                 // the ROM window that holds the title line and the field (its interior)
  title: Object.freeze({ x: 14, y: 6 }),                              // the title's left edge; the "length/max" count is right-aligned at head.x + head.w - 2 on the same line
  field: Object.freeze({ x: 26, y: 21, w: 188, h: 16 }),               // where the value is drawn: never a pixel wider (a longer value scrolls: fieldWindow)
  marks: Object.freeze({ left: 13, right: 216 }),                      // where the ROM's left / right arrows stand when the value goes on past the field's edge
  caret: Object.freeze({ dx: -3, dy: 7 }),                             // the caret is the ROM's small up-arrow glyph, drawn under the place the next character goes
  keys: Object.freeze({ x: 16, y: 54, cell: 16, pitch: 14, glyph: 8 }),   // the key grid: ENTRY_COLS cells of 16 px, rows 14 px apart; a key's glyph is drawn 8 px into its cell (the cursor stands in the first 8)
  fn: Object.freeze({ x: 8, y: 120, w: 224, h: 16, gap: 4 }),          // the row of chips under the grid: abc / SPACE / DEL / CANCEL / OK share this width
  note: Object.freeze({ x: 8, y: 139, w: 224 }),                       // the line under the chips: a hint, or why the last key did nothing
});

const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LO = UP.toLowerCase(), DIG = '0123456789';
const NAME_SYM = "!?,/&+:;()\u00e9\u2642\u2640";
const two = (letters, third, fourth) => [letters.slice(0, 13), letters.slice(13), third].concat(fourth ? [fourth] : []);
// the key rows of each charset, by page (a charset with one page has no SHIFT)
const KEYROWS = Object.freeze({
  name: { upper: two(UP, DIG + "-'.", NAME_SYM), lower: two(LO, DIG + "-'.", NAME_SYM) },
  code: { upper: two(UP, DIG) },
  teamcode: { upper: two(UP, DIG + '-_.'), lower: two(LO, DIG + '-_.') },
  search: { upper: two(UP, DIG + "-'"), lower: two(LO, DIG + "-'") },
});
const HAS_SPACE = Object.freeze({ name: true, code: false, teamcode: false, search: true });
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;           // (the same class profile.js textIssue refuses)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const romOk = new Map();
/** Does the Gen-3 charset hold this ONE character, canonically (profile.js textIssue's rule for a single character)? */
function romChar(ch) {
  let ok = romOk.get(ch);
  if (ok === undefined) {
    ok = false;
    if (ch.length === 1 && ch !== '{' && ch !== '}' && !CONTROL_RE.test(ch)) { try { ok = defaultCodec.decode(defaultCodec.encode(ch, { terminate: false })) === ch; } catch (_e) { ok = false; } }
    romOk.set(ch, ok);
  }
  return ok;
}

/** The character `ch` becomes when typed into a field of this charset, or null when the charset refuses it. `ch` is ONE character (anything longer is refused). */
export function mapChar(charset, ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  switch (charset) {
    case 'name': if (ch === '\u2019') return "'"; return romChar(ch) ? ch : null;
    case 'code': return /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase() : null;
    case 'teamcode': if (ch === '/') return '_'; if (ch === '+') return '-'; return /^[A-Za-z0-9._-]$/.test(ch) ? ch : null;
    case 'search': if (ch === '\u2019') return "'"; return /^[A-Za-z0-9 '-]$/.test(ch) ? ch : null;
    default: return null;
  }
}
/** `text` as this charset takes it: every character mapped (mapChar), the refused ones dropped. -> { text, dropped } (dropped = how many characters were refused). */
export function filterText(charset, text) {
  let out = '', dropped = 0;
  for (const ch of String(text === undefined || text === null ? '' : text)) { const c = mapChar(charset, ch); if (c === null) dropped++; else out += c; }
  return { text: out, dropped };
}
/** What the ROM font draws for a character of a value or a key: itself, except '_' (the font has none: the ROM's '/' stands for it). */
export function glyphOf(ch) { return ch === '_' ? '/' : ch; }

/** The key pages of a charset: { pages: ['upper', 'lower'?], rows(page) -> [[ch, ...], ...], fn(page) -> [{ id, label }] }. */
export function keyboardOf(charset) {
  const K = KEYROWS[charset];
  if (!K) throw new RangeError('unknown charset ' + JSON.stringify(charset));
  const pages = Object.keys(K);
  return {
    pages,
    rows: (page) => (K[page] || K.upper).map((r) => [...r]),
    fn(page) {
      const out = [];
      if (pages.length > 1) out.push({ id: 'shift', label: page === 'lower' ? 'ABC' : 'abc' });          // the label is the page the key goes TO
      if (HAS_SPACE[charset]) out.push({ id: 'space', label: 'SPACE' });
      out.push({ id: 'del', label: 'DEL' }, { id: 'cancel', label: 'CANCEL' }, { id: 'ok', label: 'OK' });
      return out;
    },
  };
}

/** The rectangle of key (row, col) of a keyboard with `rows` character rows and `fnCount` chips (row === rows is the chip row). */
export function keyRect(rows, fnCount, row, col) {
  const k = TEGEOM.keys, f = TEGEOM.fn;
  if (row < rows) return { x: k.x + col * k.cell, y: k.y + row * k.pitch, w: k.cell, h: k.pitch };
  const w = Math.floor((f.w - (fnCount - 1) * f.gap) / fnCount);
  return { x: f.x + col * (w + f.gap), y: f.y, w, h: f.h };
}

/**
 * Which part of a value the field shows. widths[i] = the pixels character i takes; caret = 0..n; px = the field's width. -> { start, end, caretX }: characters start..end-1 are drawn from the
 * field's left edge and the caret stands caretX pixels in. A value that fits is shown whole. A longer one is shown around the caret: up to three characters after it, as many before it as fit,
 * and then more after it if there is still room. Stateless, so the same value and caret always give the same picture.
 */
export function fieldWindow(widths, caret, px) {
  const n = widths.length, c = clamp(caret | 0, 0, n);
  let total = 0; for (const w of widths) total += w;
  const sum = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += widths[i]; return s; };
  if (total <= px) return { start: 0, end: n, caretX: sum(0, c) };
  let end = c, used = 0;
  while (end < n && end < c + 3 && used + widths[end] <= px) { used += widths[end]; end++; }
  let start = c;
  while (start > 0 && used + widths[start - 1] <= px) { start--; used += widths[start]; }
  while (end < n && used + widths[end] <= px) { used += widths[end]; end++; }
  return { start, end, caretX: sum(start, c) };
}

/** opts: see the header. Throws RangeError on an unknown charset or a `max` outside 1..ENTRY_MAX (a programming error, not player input). */
export function createTextEntry(opts = {}) {
  const charset = opts.charset || 'name';
  const KB = keyboardOf(charset);
  const max = opts.max;
  if (!Number.isInteger(max) || max < 1 || max > ENTRY_MAX) throw new RangeError('max must be an integer 1..' + ENTRY_MAX);
  const id = typeof opts.id === 'string' ? opts.id : '';
  const title = typeof opts.title === 'string' ? opts.title : '';
  const allowEmpty = !!opts.allowEmpty;
  const min = allowEmpty ? 0 : clamp(Number.isInteger(opts.min) ? opts.min : 1, 1, max);
  const mask = typeof opts.mask === 'string' && opts.mask.length === 1 ? opts.mask : null;
  const S = { value: filterText(charset, typeof opts.value === 'string' ? opts.value : '').text.slice(0, max), caret: 0, page: KB.pages[0], row: 0, col: 0, note: '', result: null };
  S.caret = S.value.length;

  const charRows = () => KB.rows(S.page);
  const fnKeys = () => KB.fn(S.page);
  const rowCount = () => charRows().length + 1;                        // the chip row is the last one
  const rowLen = (r) => { const cr = charRows(); return r < cr.length ? cr[r].length : fnKeys().length; };
  const rectOf = (r, c) => keyRect(charRows().length, fnKeys().length, r, c);
  const keyAt = (r, c) => { const cr = charRows(); return r < cr.length ? { kind: 'char', ch: cr[r][c] } : { kind: 'fn', id: fnKeys()[c].id }; };
  // moving to another row keeps the cursor where it is across the screen: the key of the new row whose centre is nearest
  function nearestCol(fromRow, fromCol, toRow) {
    const a = rectOf(fromRow, fromCol), cx = a.x + a.w / 2;
    let best = 0, bd = Infinity;
    for (let c = 0; c < rowLen(toRow); c++) { const b = rectOf(toRow, c), d = Math.abs(b.x + b.w / 2 - cx); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  /* ------------------------------------------------------------------------------------------ editing */
  function insert(text) {
    const f = filterText(charset, text), room = max - S.value.length, ins = f.text.slice(0, Math.max(0, room));
    S.value = S.value.slice(0, S.caret) + ins + S.value.slice(S.caret); S.caret += ins.length;
    S.note = ins.length < f.text.length ? 'That is as long as it can be (' + max + ').' : f.dropped ? (f.dropped === 1 ? 'That character cannot be used here.' : 'Some characters cannot be used here.') : '';
    return null;
  }
  function backspace() { if (S.caret > 0) { S.value = S.value.slice(0, S.caret - 1) + S.value.slice(S.caret); S.caret--; } S.note = ''; return null; }
  function del() { if (S.caret < S.value.length) S.value = S.value.slice(0, S.caret) + S.value.slice(S.caret + 1); S.note = ''; return null; }
  function caretTo(c) { S.caret = clamp(c, 0, S.value.length); return null; }
  function shift() { if (KB.pages.length > 1) { S.page = S.page === 'upper' ? 'lower' : 'upper'; S.col = clamp(S.col, 0, rowLen(S.row) - 1); } return null; }
  function finish(ok) { S.result = ok ? { id, ok: true, value: S.value } : { id, ok: false }; return S.result; }
  function submit() {
    const n = S.value.trim() === '' ? 0 : S.value.length;
    if (n < min) { S.note = n === 0 ? 'Type something first.' : 'It needs at least ' + min + ' characters.'; return null; }
    return finish(true);
  }
  function activate() {
    const k = keyAt(S.row, S.col);
    if (k.kind === 'char') return insert(k.ch);
    switch (k.id) {
      case 'shift': return shift();
      case 'space': return insert(' ');
      case 'del': return S.caret > 0 ? backspace() : del();
      case 'cancel': return finish(false);
      default: return submit();
    }
  }

  /* ------------------------------------------------------------------------------------------ input */
  function press(action) {
    if (S.result) return S.result;
    const rows = rowCount();
    switch (action) {
      case 'left': S.col = (S.col + rowLen(S.row) - 1) % rowLen(S.row); return null;
      case 'right': S.col = (S.col + 1) % rowLen(S.row); return null;
      case 'up': { const r = (S.row + rows - 1) % rows; S.col = nearestCol(S.row, S.col, r); S.row = r; return null; }
      case 'down': { const r = (S.row + 1) % rows; S.col = nearestCol(S.row, S.col, r); S.row = r; return null; }
      case 'a': return activate();
      case 'b': if (S.value.length === 0) return finish(false); return S.caret > 0 ? backspace() : del();
      case 'start': return submit();
      case 'select': return shift();
      case 'l': return caretTo(S.caret - 1);
      case 'r': return caretTo(S.caret + 1);
      default: return null;
    }
  }
  /** Which key is under the logical point? { kind: 'key', row, col } | null. */
  function hit(x, y) {
    for (let r = 0; r < rowCount(); r++) for (let c = 0; c < rowLen(r); c++) { const q = rectOf(r, c); if (x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h) return { kind: 'key', row: r, col: c }; }
    return null;
  }
  function pointer(ev) {
    if (S.result) return S.result;
    if (!ev || ev.kind === 'wheel' || ev.x === undefined || ev.x === null) return null;
    const h = hit(ev.x, ev.y);
    if (!h) return null;
    S.row = h.row; S.col = h.col;
    return ev.kind === 'click' ? activate() : null;
  }
  function type(input) {
    if (S.result) return S.result;
    if (!input || typeof input !== 'object') return null;
    if (typeof input.text === 'string') return insert(input.text);
    switch (input.key) {
      case 'backspace': return backspace();
      case 'delete': return del();
      case 'left': return caretTo(S.caret - 1);
      case 'right': return caretTo(S.caret + 1);
      case 'home': return caretTo(0);
      case 'end': return caretTo(S.value.length);
      case 'enter': return submit();
      case 'escape': return finish(false);
      default: return null;
    }
  }

  return {
    id, charset, max,
    press, pointer, hit, type,
    /** The real value (never masked). */
    value: () => S.value,
    /** The result once the entry has finished ({ id, ok, value? }), else null. */
    done: () => S.result,
    /** Show a line under the keys until the next edit (e.g. why the app refused the value and opened the entry again). */
    setNote(s) { S.note = String(s || ''); },
    /** The rectangle of every key, row by row: [{ row, col, id, x, y, w, h }] (id = the character, or the chip's id). */
    rects() { const out = []; for (let r = 0; r < rowCount(); r++) for (let c = 0; c < rowLen(r); c++) { const k = keyAt(r, c); out.push({ row: r, col: c, id: k.kind === 'char' ? k.ch : k.id, ...rectOf(r, c) }); } return out; },
    state: () => ({ id, charset, value: S.value, caret: S.caret, page: S.page, row: S.row, col: S.col, note: S.note, done: !!S.result }),
    /** Plain JSON for the renderer: what an app puts in view.entry. A masked entry shows `mask` for every character (the real text is not in the view). */
    view() {
      return {
        id, title, charset, value: mask ? mask.repeat(S.value.length) : S.value, masked: !!mask, length: S.value.length, max, caret: S.caret, page: S.page,
        rows: charRows(), fn: fnKeys(), cursor: { row: S.row, col: S.col }, note: S.note,
        hint: 'B: delete   START: OK' + (KB.pages.length > 1 ? '   SELECT: ' + (S.page === 'lower' ? 'ABC' : 'abc') : ''),
      };
    },
  };
}

/**
 * One place for an app's text entry: at most one is open. Every input method answers `undefined` while none is open (the app's own handling then runs), and the EFFECTS of the entry otherwise:
 * [] while it stays open, and what `onDone(result)` returned when it finished (the slot is then empty again).
 *   open(spec, onDone)   spec: createTextEntry's options; onDone(result) -> effects | undefined   (result: { id, ok: true, value } | { id, ok: false })
 *   isOpen()  close()    close() drops the entry without a result (leave(path) should call it)
 *   press(a)  pointer(ev)  type(input)   -> undefined | effects
 *   hit(x, y)            -> undefined when closed, else { kind: 'key', row, col } | null
 *   rects()              -> [] when closed
 *   view()               -> null when closed (so `entry: slot.view()` is right in every view)
 *   entry()              -> the open entry (createTextEntry's object) or null
 */
export function createEntrySlot() {
  let cur = null, onDone = null;
  function settle(r) {
    if (!r) return [];
    const fn = onDone; cur = null; onDone = null;
    const fx = typeof fn === 'function' ? fn(r) : null;
    return Array.isArray(fx) ? fx : [];
  }
  return {
    open(spec, done) { cur = createTextEntry(spec); onDone = done || null; return cur; },
    close() { cur = null; onDone = null; },
    isOpen: () => !!cur,
    entry: () => cur,
    press: (a) => (cur ? settle(cur.press(a)) : undefined),
    pointer: (ev) => (cur ? settle(cur.pointer(ev)) : undefined),
    type: (input) => (cur ? settle(cur.type(input)) : undefined),
    hit: (x, y) => (cur ? cur.hit(x, y) : undefined),
    rects: () => (cur ? cur.rects() : []),
    view: () => (cur ? cur.view() : null),
  };
}

/** The text a screen reader gets while a text entry is open (the canvas itself has only a static label). */
export function speakEntry(ev) {
  if (!ev) return '';
  const cr = ev.rows, k = ev.cursor.row < cr.length ? cr[ev.cursor.row][ev.cursor.col] : (ev.fn[ev.cursor.col] || {}).label;
  return (ev.title ? ev.title + ' ' : '') + 'Text entry: ' + (ev.length ? (ev.masked ? ev.length + ' characters' : '"' + ev.value + '"') : 'empty') + ', ' + ev.length + ' of ' + ev.max + '. Key: ' + (k === ' ' ? 'space' : k) + '.' + (ev.note ? ' ' + ev.note : '') + ' Type on a keyboard, or move with the arrows and press A.';
}
