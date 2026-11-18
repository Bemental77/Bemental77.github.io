// pokemonarena/js/hub_dialog.js -- the HUB's DIALOG LAYER: a message box (pages of two lines) with an optional list of options, that sits over ANY hub screen (the main menu, the Tower, an app).
//
// Pure ES module (browser + Node): no DOM, no ROM, no clock, no storage, no randomness. hub_model.js owns one layer (hub.dialog) and, while a dialog is open, hands it EVERY press and pointer event;
// hub_screen.js draws what view() returns with the ROM message box and the ROM window ring. It is what "<name> wants to battle you" uses, so it does not care which screen is under it.
//
//   const d = createDialogLayer({ measure: (font, s) => px });
//   d.open({ id: 'challenge', app: 'online', pages: [['RED wants to battle you.', '3v3, standard rules.']], choice: { options: ['YES', 'NO'], cursor: 1 }, ticksLeft: 1800 });   // -> true
//   d.press('up'); d.press('a');            // -> [{ type: 'dialog', id: 'challenge', value: 0, app: 'online' }]   (the answer is an EFFECT; hub_model.js also tells the app's model: app.onDialog(id, value))
//
// A DIALOG   { id, pages, choice, ticksLeft?, app? }
//   id         a non-empty string (at most 64 characters): names the question in its answer
//   pages      1..16 pages; a page is one or two lines (a string is a one-line page). A turns the page; the options are shown with the LAST page
//   choice     null (a notice: A / B / a tap closes it, value 'closed') or { options: 1..4 non-empty strings, cursor: the option highlighted first }
//   ticksLeft  optional: frames (hub ticks, 59.7275 a second) until the dialog answers 'timeout' by itself. Counted only while the dialog is the one SHOWN (a queued dialog does not age)
//   app        optional: the id of the hub app that asked. The answer effect then carries `app`, so boot.js hands it to that app's ctl and hub_model.js to that app's model
// THE ANSWER { type: 'dialog', id, value, app? }   value = the index of the option chosen | 'timeout' | 'closed' (a notice was read to its end, or dismissed with B)
// INPUT      A        the next page; on the last page: the highlighted option (a notice: closes)
//            B        the LAST option (NO), from any page (a notice: closes)
//            d-pad    up / left = the option above, down / right = the option below (they wrap); L / R likewise
//            pointer  move / down on an option highlights it, a click on it chooses it; a click on the message box is A while there are pages to turn or when the dialog is a notice
//                     (it never chooses an option: a stray tap on the text must not answer YES); a click anywhere else does nothing. The wheel moves the highlight
// A SECOND open() WHILE ONE IS OPEN IS QUEUED (first in, first shown), up to DIALOG_QUEUE_MAX dialogs in all. open() REFUSES (returns false, changes nothing) a malformed dialog, an id that is already
// open or queued, and a full queue. close(id) removes that dialog whether it is shown or queued and emits NO effect (the caller that closes it knows).

export const DIALOG_MAX_OPTIONS = 4;
export const DIALOG_MAX_PAGES = 16;
export const DIALOG_QUEUE_MAX = 8;
export const DIALOG_FONT = 'normal';

// geometry shared with the renderer and the hit test (logical 240x160 pixels)
export const DGEOM = Object.freeze({
  msg: Object.freeze({ x: 0, y: 112, w: 240, h: 48 }),                                    // the ROM message box (the bottom 48 px, as in a battle)
  opt: Object.freeze({ right: 226, bottom: 100, pitch: 16, pad: 12, tail: 6, min: 36, ring: 6 }),   // the options window's INTERIOR: its right and bottom edges, the row pitch, the room the cursor takes left of a label, the room right of it
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const inR = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const isStr = (s) => typeof s === 'string';

/** A dialog as the layer keeps it, or null when `spec` is not one (open() refuses it). Never throws. */
export function normalizeDialog(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (!isStr(spec.id) || !spec.id || spec.id.length > 64) return null;
  if (!Array.isArray(spec.pages) || spec.pages.length < 1 || spec.pages.length > DIALOG_MAX_PAGES) return null;
  const pages = [];
  for (const p of spec.pages) {
    const lines = isStr(p) ? [p] : Array.isArray(p) ? p : null;
    if (!lines || lines.length > 2 || !lines.every(isStr)) return null;
    pages.push([lines[0] || '', lines[1] || '']);
  }
  let choice = null;
  if (spec.choice !== null && spec.choice !== undefined) {
    const c = spec.choice;
    if (!c || typeof c !== 'object' || !Array.isArray(c.options) || c.options.length < 1 || c.options.length > DIALOG_MAX_OPTIONS || !c.options.every((o) => isStr(o) && o.length > 0)) return null;
    choice = { options: c.options.slice(), cursor: clamp(Number.isInteger(c.cursor) ? c.cursor : 0, 0, c.options.length - 1) };
  }
  let ticksLeft = null;
  if (spec.ticksLeft !== null && spec.ticksLeft !== undefined) {
    if (!Number.isInteger(spec.ticksLeft) || spec.ticksLeft < 1) return null;
    ticksLeft = spec.ticksLeft;
  }
  if (spec.app !== null && spec.app !== undefined && (!isStr(spec.app) || !spec.app)) return null;
  return { id: spec.id, app: spec.app || null, pages, page: 0, choice, ticksLeft };
}

/**
 * `text` as dialog pages: word-wrapped to lines no wider than `px` in the dialog's font (measure(font, s) -> pixels), two lines to a page. Words stay whole (one wider than a line is cut where it
 * must be) and none is dropped; '\n' starts a new line. An empty text gives one empty page.
 */
export function wrapDialog(text, measure, px) {
  const m = (s) => measure(DIALOG_FONT, s), lines = [];
  for (const para of String(text === undefined || text === null ? '' : text).split('\n')) {
    let cur = '';
    for (const w0 of para.split(/\s+/).filter(Boolean)) {
      let w = w0;
      while (m(w) > px && w.length > 1) { let k = w.length - 1; while (k > 1 && m(w.slice(0, k)) > px) k--; if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, k)); w = w.slice(k); }
      const t = cur ? cur + ' ' + w : w;
      if (m(t) <= px) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
  }
  const pages = [];
  for (let i = 0; i < lines.length; i += 2) pages.push([lines[i], lines[i + 1] || '']);
  return pages.length ? pages : [['', '']];
}

/** The interior of the options window and the row of each option, for these labels: { x, y, w, h, pitch, rows: [{ x, y, w, h }] }. `measure(font, s)` -> pixels. */
export function optionRects(options, measure) {
  const g = DGEOM.opt, n = options.length;
  let widest = 0; for (const o of options) widest = Math.max(widest, Math.ceil(measure(DIALOG_FONT, o)));
  const w = clamp(widest + g.pad + g.tail, g.min, g.right - 16), h = n * g.pitch, x = g.right - w, y = g.bottom - h;
  return { x, y, w, h, pitch: g.pitch, rows: options.map((_, i) => ({ x, y: y + i * g.pitch, w, h: g.pitch })) };
}

/** opts: { measure(font, s) -> pixels } (default: 6 px a character, which is the ROM's normal font for capitals and digits). */
export function createDialogLayer(opts = {}) {
  const measure = typeof opts.measure === 'function' ? opts.measure : (_font, s) => String(s).length * 6;
  const Q = [];                                    // Q[0] is the dialog shown; the rest wait their turn
  const cur = () => Q[0] || null;
  const lastPage = (d) => d.page >= d.pages.length - 1;
  const rectsOf = (d) => (d.choice ? optionRects(d.choice.options, measure) : null);

  function answer(value) {
    const d = Q.shift();
    const e = { type: 'dialog', id: d.id, value };
    if (d.app) e.app = d.app;
    return [e];
  }
  function move(d, dir) { const n = d.choice.options.length; d.choice.cursor = (d.choice.cursor + dir + n) % n; return []; }

  function press(action) {
    const d = cur(); if (!d) return [];
    if (action === 'a') {
      if (!lastPage(d)) { d.page++; return []; }
      return answer(d.choice ? d.choice.cursor : 'closed');
    }
    if (action === 'b') return answer(d.choice ? d.choice.options.length - 1 : 'closed');
    if (d.choice && lastPage(d)) {
      if (action === 'up' || action === 'left' || action === 'l') return move(d, -1);
      if (action === 'down' || action === 'right' || action === 'r') return move(d, 1);
    }
    return [];
  }

  /** What is under the logical point? { kind: 'option', index } | { kind: 'msg' } | null. */
  function hit(x, y) {
    const d = cur(); if (!d) return null;
    if (d.choice && lastPage(d)) {
      const r = rectsOf(d), k = DGEOM.opt.ring;
      if (inR({ x: r.x - k, y: r.y, w: r.w + 2 * k, h: r.h }, x, y)) return { kind: 'option', index: clamp(Math.floor((y - r.y) / r.pitch), 0, d.choice.options.length - 1) };
    }
    return inR(DGEOM.msg, x, y) ? { kind: 'msg' } : null;
  }

  function pointer(ev) {
    const d = cur(); if (!d || !ev) return [];
    if (ev.kind === 'wheel') { if (d.choice && lastPage(d)) { const n = Math.abs(ev.steps || 0); for (let i = 0; i < n; i++) move(d, (ev.steps || 0) > 0 ? 1 : -1); } return []; }
    const h = ev.x === undefined || ev.x === null ? null : hit(ev.x, ev.y);
    if (!h) return [];
    if (h.kind === 'option') {
      d.choice.cursor = h.index;
      return ev.kind === 'click' ? answer(h.index) : [];
    }
    if (ev.kind !== 'click') return [];
    if (!lastPage(d)) { d.page++; return []; }                 // a tap on the text turns the page ...
    return d.choice ? [] : answer('closed');                    // ... and closes a notice, but never answers a question
  }

  function tick() {
    const d = cur(); if (!d || d.ticksLeft === null) return [];
    d.ticksLeft--;
    return d.ticksLeft <= 0 ? answer('timeout') : [];
  }

  return {
    /** Show the dialog, or queue it behind the one that is open. -> true when it was taken, false when it was refused (malformed, an id already open or queued, a full queue). */
    open(spec) {
      const d = normalizeDialog(spec);
      if (!d || Q.length >= DIALOG_QUEUE_MAX || Q.some((x) => x.id === d.id)) return false;
      Q.push(d); return true;
    },
    /** Remove the dialog with this id (shown or queued). No effect is emitted. -> true when there was one. */
    close(id) { const i = Q.findIndex((x) => x.id === id); if (i < 0) return false; Q.splice(i, 1); return true; },
    /** The dialog shown, as plain JSON, or null: { id, app, page, pages, choice: { options, cursor } | null, ticksLeft }. */
    current() { const d = cur(); return d ? { id: d.id, app: d.app, page: d.page, pages: d.pages.length, choice: d.choice ? { options: d.choice.options.slice(), cursor: d.choice.cursor } : null, ticksLeft: d.ticksLeft } : null; },
    isOpen: () => Q.length > 0,
    press, hit, pointer, tick,
    /** The rows of the options shown (logical pixels), [] when none are. */
    rects() { const d = cur(); return d && d.choice && lastPage(d) ? rectsOf(d).rows : []; },
    /** What hub_screen.js draws, or null: { id, app, page, pages, lines: [a, b], more, choice: { options, cursor, x, y, w, h, pitch } | null, queued }. The options come with the LAST page. */
    view() {
      const d = cur(); if (!d) return null;
      const last = lastPage(d), r = d.choice && last ? rectsOf(d) : null;
      return { id: d.id, app: d.app, page: d.page, pages: d.pages.length, lines: d.pages[d.page].slice(), more: !last, choice: r ? { options: d.choice.options.slice(), cursor: d.choice.cursor, x: r.x, y: r.y, w: r.w, h: r.h, pitch: r.pitch } : null, queued: Q.length - 1 };
    },
    state: () => ({ open: Q.length ? Q[0].id : null, page: Q.length ? Q[0].page : 0, cursor: Q.length && Q[0].choice ? Q[0].choice.cursor : null, queued: Q.slice(1).map((x) => x.id) }),
  };
}

/** The text a screen reader gets while a dialog is shown (the canvas itself has only a static label). */
export function speakDialog(dv) {
  if (!dv) return '';
  const parts = [dv.lines.filter(Boolean).join(' ')];
  if (dv.pages > 1) parts.push('Page ' + (dv.page + 1) + ' of ' + dv.pages + '.');
  if (dv.choice) parts.push('Choose: ' + dv.choice.options.map((o, i) => (i === dv.choice.cursor ? 'selected ' : '') + o).join(', ') + '.');
  else parts.push(dv.more ? 'A turns the page.' : 'A closes this.');
  return parts.filter(Boolean).join(' ');
}
