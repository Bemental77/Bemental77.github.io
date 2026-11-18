// pokemonarena/js/builder_parts.js -- THE TEAM BUILDER's shared furniture, model side: the pieces every builder screen is made of, so a new screen is rows and a few lines, not another cursor.
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. builder_screen.js draws what these return; builder_geom.js has the rectangles.
//
//   createList(geom)          a cursor over ANY number of rows, seven of them visible: it scrolls, pages, wraps, hit-tests and takes taps. The result vocabulary is hub_menu.js's
//                             (move / choose / change / refused / back), so a builder list behaves as the hub's menus do
//   createPopupSlot(measure)  at most one POP-UP MENU over a screen (a slot menu, a team menu, a filter panel, "type a number"): while it is open it takes every press and pointer event
//   pagesOf(text, ...)        a text as message-box pages of two lines (hub_dialog.js wrapDialog, less the room the "more" arrow keeps)
//   chapterStep(...)          the next / previous "chapter" of a long sorted list (a first letter, a type, a hundred Pokedex numbers)
//   sentence(s)               a reducer's message as a sentence: its own words, a capital first, a full stop last
//
// A ROW      { id, kind: 'item' | 'button' | 'choice', label, value?, tag?, dim?, disabled?, ... }   (any other key rides along to the view)
// ROWS       an array, or { n, at(i) } for a list too long to build on every press (the species picker: 1018 rows, seven of them made per frame)

import { clamp, inR, rowRect, popupRect, BG } from './builder_geom.js';
import { wrapDialog } from './hub_dialog.js';

const src = (rows) => (Array.isArray(rows) ? { n: rows.length, at: (i) => rows[i] } : rows);

/** g: { x, y, w, pitch, rows } (builder_geom.js BG.list / BG.wide / BG.mon.list). */
export function createList(g) {
  let cur = 0, off = 0;
  function fit(n) {
    cur = n > 0 ? clamp(cur, 0, n - 1) : 0;
    off = clamp(off, 0, Math.max(0, n - g.rows));
    if (cur < off) off = cur; else if (cur >= off + g.rows) off = cur - g.rows + 1;
    return cur;
  }
  const shown = (n) => Math.min(g.rows, Math.max(0, n - off));
  /** Which row is under the logical point? { kind: 'row', index, zone } | null. zone 'prev' = the left half of a choice row. */
  function hit(x, y, rows) {
    const R = src(rows), n = R.n; fit(n);
    const k = shown(n);
    if (!k || x < g.x - 6 || x >= g.x + g.w + 6 || y < g.y || y >= g.y + k * g.pitch) return null;
    const index = off + Math.floor((y - g.y) / g.pitch), row = R.at(index);
    return { kind: 'row', index, zone: row && row.kind === 'choice' && x < g.x + g.w / 2 ? 'prev' : 'main' };
  }
  function activate(R, dir) {
    const row = R.at(fit(R.n));
    if (!row) return null;
    if (row.disabled) return { kind: 'refused', row, index: cur };
    return row.kind === 'choice' ? { kind: 'change', row, index: cur, dir } : { kind: 'choose', row, index: cur };
  }
  /** One step. A held direction's repeat stops at the ends (it does not wrap: holding DOWN must not fly past the last row back to the first). */
  function step(dir, n, repeat) {
    if (!n) return null;
    const was = fit(n), to = cur + dir;
    cur = to < 0 ? (repeat ? 0 : n - 1) : to >= n ? (repeat ? n - 1 : 0) : to;
    fit(n);
    return cur !== was ? { kind: 'move', index: cur } : null;
  }
  /** A page up (-1) or down (+1): the window and the cursor move together, and stop at the ends. */
  function page(dir, rows) {
    const n = src(rows).n; if (!n) return null;
    const was = fit(n), wasOff = off;
    off = clamp(off + dir * g.rows, 0, Math.max(0, n - g.rows));
    cur = clamp(cur + dir * g.rows, 0, n - 1);
    fit(n);
    return cur !== was || off !== wasOff ? { kind: 'move', index: cur } : null;
  }
  /** info: { repeat } (hub_model.js): true for the repeat of a held direction. */
  function press(action, rows, info) {
    const R = src(rows), n = R.n; fit(n);
    switch (action) {
      case 'up': return step(-1, n, !!(info && info.repeat));
      case 'down': return step(1, n, !!(info && info.repeat));
      case 'left': case 'right': { const row = R.at(cur); if (!row || row.kind !== 'choice') return null; return row.disabled ? { kind: 'refused', row, index: cur } : { kind: 'change', row, index: cur, dir: action === 'left' ? -1 : 1 }; }
      case 'l': return page(-1, R);
      case 'r': return page(1, R);
      case 'a': return activate(R, 1);
      case 'b': return { kind: 'back' };
      default: return null;
    }
  }
  function pointer(ev, rows) {
    if (!ev) return null;
    const R = src(rows), n = R.n; fit(n);
    if (ev.kind === 'wheel') { const k = ev.steps | 0; if (!k || !n) return null; const was = cur; cur = clamp(cur + k, 0, n - 1); fit(n); return cur !== was ? { kind: 'move', index: cur } : null; }
    const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y, R);
    if (!h) return null;
    const moved = cur !== h.index; cur = h.index; fit(n);
    if (ev.kind !== 'click') return moved ? { kind: 'move', index: cur } : null;
    return activate(R, h.zone === 'prev' ? -1 : 1);
  }
  return {
    geom: g, press, pointer, hit, page,
    /** The cursor's row (clamped to `n` rows when given). */
    cursor: (n) => (n === undefined ? cur : fit(n)),
    set(i, n) { cur = Math.max(0, i | 0); if (n !== undefined) fit(n); },
    /** Put the cursor on the first row `test(row)` accepts. -> whether there was one. */
    seek(rows, test) { const R = src(rows); for (let i = 0; i < R.n; i++) if (test(R.at(i))) { cur = i; fit(R.n); return true; } return false; },
    rects(rows) { const n = src(rows).n; fit(n); return Array.from({ length: shown(n) }, (_, i) => rowRect(g, i)); },
    /** What builder_screen.js draws: the rows in the window, the cursor among them, and whether there is more above / below. */
    view(rows) {
      const R = src(rows), n = R.n; fit(n);
      const out = [];
      for (let i = off; i < Math.min(n, off + g.rows); i++) out.push({ ...R.at(i) });
      return { rows: out, cursor: n ? cur - off : -1, offset: off, total: n, up: off > 0, down: off + g.rows < n };
    },
    state: () => ({ cursor: cur, offset: off }),
  };
}

/**
 * At most one pop-up menu. spec: { id, rows: () => [row], pick(result) -> effects, help?(row) -> text | [a, b], title? }.
 *   result  { kind: 'choose', row, index } (A or a tap on an item row; the pop-up CLOSES first unless the row has `stay: true`), { kind: 'change', row, index, dir } (left / right, A or a tap on a
 *           choice row; the pop-up stays), { kind: 'refused', row, index } (a disabled row)
 * Every input method answers `undefined` while no pop-up is open (the screen's own handling follows), else effects. B, and a tap outside the pop-up, close it.
 */
export function createPopupSlot(measure) {
  let P = null, cur = 0;
  const m = (s) => { try { const px = measure('normal', String(s)); return Number.isFinite(px) ? px : String(s).length * 6; } catch (_e) { return String(s).length * 6; } };
  const rowsNow = () => { const r = P.rows(); cur = r.length ? clamp(cur, 0, r.length - 1) : 0; return r; };
  // as wide as its widest row: the cursor's lane, the label, and for a choice row its WIDEST value between the two arrows (row.wide, so the window does not change size as the value does)
  function geom(rows) {
    let w = 0;
    for (const r of rows) {
      const val = r.value === undefined ? null : (r.wide === undefined ? String(r.value) : String(r.wide));
      w = Math.max(w, BG.popup.lead + m(r.label) + (val === null ? 0 : 8 + m(val) + (r.kind === 'choice' ? 22 : 0)) + BG.popup.tail);
    }
    if (P.title) w = Math.max(w, 4 + m(P.title) + 4);
    return popupRect(rows.length + (P.title ? 1 : 0), w);
  }
  const rowY0 = () => (P.title ? 1 : 0);
  function close() { P = null; cur = 0; }
  const fx = (r) => (Array.isArray(r) ? r : []);
  function act(rows, dir) {
    const row = rows[cur]; if (!row) return [];
    if (row.disabled) return fx(P.pick({ kind: 'refused', row, index: cur }));
    if (row.kind === 'choice') return fx(P.pick({ kind: 'change', row, index: cur, dir }));
    const spec = P; if (!row.stay) close();
    return fx(spec.pick({ kind: 'choose', row, index: cur }));
  }
  function hit(x, y) {
    if (!P) return undefined;
    const rows = rowsNow(), g = geom(rows), k = rowY0();
    for (let i = 0; i < rows.length; i++) if (inR(g.rows[i + k], x, y)) return { kind: 'option', index: i, zone: rows[i].kind === 'choice' && x < g.x + g.w / 2 ? 'prev' : 'main' };
    return inR({ x: g.x - 6, y: g.y - 6, w: g.w + 12, h: g.h + 12 }, x, y) ? { kind: 'popup' } : { kind: 'outside' };
  }
  return {
    open(spec) { P = spec; cur = Number.isInteger(spec.cursor) ? spec.cursor : 0; },
    close, isOpen: () => !!P, id: () => (P ? P.id : null),
    press(action) {
      if (!P) return undefined;
      const rows = rowsNow(), n = rows.length;
      switch (action) {
        case 'up': if (n) cur = (cur + n - 1) % n; return [];
        case 'down': if (n) cur = (cur + 1) % n; return [];
        case 'left': case 'right': { const row = rows[cur]; return row && row.kind === 'choice' ? act(rows, action === 'left' ? -1 : 1) : []; }
        case 'a': return act(rows, 1);
        case 'b': close(); return [];
        default: return [];
      }
    },
    pointer(ev) {
      if (!P) return undefined;
      if (!ev) return [];
      if (ev.kind === 'wheel') { const rows = rowsNow(), n = rows.length; if (n) cur = clamp(cur + (ev.steps | 0), 0, n - 1); return []; }
      const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y);
      if (!h) return [];
      if (h.kind === 'outside') { if (ev.kind === 'click') close(); return []; }
      if (h.kind !== 'option') return [];
      cur = h.index;
      return ev.kind === 'click' ? act(rowsNow(), h.zone === 'prev' ? -1 : 1) : [];
    },
    hit,
    rects() { if (!P) return []; const rows = rowsNow(), g = geom(rows); return g.rows.slice(rowY0()); },
    /** The help of the highlighted row (text or two lines), or null. */
    help() { if (!P) return null; const rows = rowsNow(), row = rows[cur]; return row ? (typeof P.help === 'function' ? P.help(row) : row.help) || null : null; },
    /** What the renderer draws, or null: { id, title, x, y, w, h, pitch, rows: [{ id, kind, label, value?, disabled? }], cursor }. */
    view() {
      if (!P) return null;
      const rows = rowsNow(), g = geom(rows);
      return { id: P.id, title: P.title || null, x: g.x, y: g.y, w: g.w, h: g.h, pitch: g.pitch, rows: rows.map((r) => ({ id: r.id, kind: r.kind || 'item', label: r.label, ...(r.value === undefined ? {} : { value: String(r.value) }), ...(r.disabled ? { disabled: true } : {}) })), cursor: cur };
    },
    state: () => (P ? { id: P.id, cursor: cur } : null),
  };
}

/**
 * `text` as message-box pages of two lines. A string is word-wrapped to lines no wider than `px` (the box, less the room the "more" arrow keeps). TWO LINES written by hand ([a, b]) are
 * kept as written when both fit the whole box (`full` pixels); if one does not, the two are wrapped like any other text, so a line can never be drawn past the box. measure(font, s) -> pixels.
 */
export function pagesOf(text, measure, px, full = px) {
  if (!Array.isArray(text)) return wrapDialog(text, measure, px);
  const lines = text.map((s) => String(s === undefined || s === null ? '' : s));
  if (lines.length <= 2 && lines.every((s) => measure('normal', s) <= full)) return [[lines[0] || '', lines[1] || '']];
  return wrapDialog(lines.filter(Boolean).join(' '), measure, px);
}

/** A reducer's (or a store's) message as a sentence: its own words, a capital first, a full stop last. */
export function sentence(s) {
  const t = String(s === undefined || s === null ? '' : s).trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

/**
 * The first row of the next (dir +1) or the previous (dir -1) CHAPTER of a list of `n` rows, where keyOf(i) names the chapter row i is in (rows of one chapter are neighbours). Going back from
 * the middle of a chapter lands on its first row; from its first row, on the first row of the chapter before. -> the index (the cursor's own when there is nowhere to go).
 */
export function chapterStep(n, cur, dir, keyOf) {
  if (!n) return 0;
  const c = clamp(cur, 0, n - 1), k = keyOf(c);
  if (dir > 0) { for (let i = c + 1; i < n; i++) if (keyOf(i) !== k) return i; return c; }
  let first = c; while (first > 0 && keyOf(first - 1) === k) first--;
  if (first < c || first === 0) return first;
  const pk = keyOf(first - 1); let p = first - 1; while (p > 0 && keyOf(p - 1) === pk) p--;
  return p;
}

/** s, or s + 's' for anything but one. */
export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
