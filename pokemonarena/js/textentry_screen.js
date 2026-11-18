// pokemonarena/js/textentry_screen.js -- draws a TEXT ENTRY (textentry.js view -> pixels) from the ROM, over the whole 240x160 picture.
//
// Pure ES module (browser + Node): no DOM, no timers. hub_screen.js makes one and calls draw(f, view.entry, tick) after the screen under it, for ANY view that carries `entry`.
// What it is made of: the ROM's party-menu teal behind everything, one ROM window for the title and the field, one ROM window for the keys, the ROM font for every letter, the ROM's menu cursor
// beside the key the d-pad is on, the ROM's party-menu chips for abc / SPACE / DEL / CANCEL / OK (the selected one in the ROM's selected colours), the ROM's small up-arrow as the caret and its
// left / right arrows where a long value goes on past the field. Nothing is drawn by hand: the only rectangles are the teal fill and the white window interiors the ROM's windows have.
//
// THE FIELD NEVER OVERFLOWS: layout() picks the part of the value that fits TEGEOM.field (textentry.js fieldWindow: around the caret), so a 1024-character team code scrolls under the caret
// instead of running out of its window. A team code is set in the ROM's small font (more of it shows); everything else in the normal one.

import { TEGEOM, keyRect, fieldWindow, glyphOf } from './textentry.js';

const SCREEN_W = 240, SCREEN_H = 160;

export function createTextEntryScreen(ui, h) {
  const { text, textRight, textCentre, width } = h;
  const TEXT = ui.TEXT;
  const fieldFont = (ev) => (ev.charset === 'teamcode' ? 'small' : 'normal');
  const glyph = (ch) => ui.safeText(glyphOf(ch));

  /**
   * Where everything of an entry view goes (the tests check it; draw() uses nothing else):
   *   { title: { text, font, px, max }, count: { text, px }, field: { font, text, px, max, start, end, caretX, clippedLeft, clippedRight },
   *     keys: [{ row, col, label, font, x, y, w, h, gx, gw, selected }], chips: [{ id, label, font, x, y, w, h, px, selected }], note: { text, font, px, max }, win: { x, y, w, h } }
   */
  function layout(ev) {
    const G = TEGEOM, rows = ev.rows.length, fnN = ev.fn.length;
    const count = ev.length + '/' + ev.max, countPx = width('normal', count);
    const titleMax = G.head.x + G.head.w - 2 - countPx - 6 - G.title.x;
    const titleFont = h.fitFont(ev.title, titleMax, ['normal', 'narrow', 'smallNarrow']);
    const titleText = h.fitText(titleFont, ev.title, titleMax);
    const font = fieldFont(ev), units = [...ev.value].map(glyph), widths = units.map((u) => width(font, u));
    const fw = fieldWindow(widths, ev.caret, G.field.w);
    const shown = units.slice(fw.start, fw.end).join('');
    const keys = [];
    ev.rows.forEach((row, r) => row.forEach((ch, c) => {
      const q = keyRect(rows, fnN, r, c), label = glyph(ch), gw = width('normal', label);
      keys.push({ row: r, col: c, label, font: 'normal', ...q, gx: q.x + G.keys.glyph + Math.max(0, Math.floor((q.w - G.keys.glyph - gw) / 2)), gw, selected: ev.cursor.row === r && ev.cursor.col === c });
    }));
    const chips = ev.fn.map((k, c) => { const q = keyRect(rows, fnN, rows, c), f = h.fitFont(k.label, q.w - 6, ['normal', 'narrow', 'smallNarrow']); return { id: k.id, label: k.label, font: f, ...q, px: width(f, k.label), selected: ev.cursor.row === rows && ev.cursor.col === c }; });
    const noteText = ev.note || ev.hint || '', noteFont = h.fitFont(noteText, G.note.w, ['normal', 'narrow', 'smallNarrow']);
    return {
      title: { text: titleText, font: titleFont, px: width(titleFont, titleText), max: titleMax }, count: { text: count, px: countPx },
      field: { font, text: shown, px: width(font, shown), max: G.field.w, start: fw.start, end: fw.end, caretX: fw.caretX, clippedLeft: fw.start > 0, clippedRight: fw.end < units.length },
      keys, chips, note: { text: h.fitText(noteFont, noteText, G.note.w), font: noteFont, px: Math.min(width(noteFont, noteText), G.note.w), max: G.note.w },
      win: { x: G.head.x, y: G.keys.y, w: G.head.w, h: rows * G.keys.pitch + 2 },
    };
  }

  /** Draw the entry over the whole frame. `tick` is the hub's clock: the caret shows for 32 ticks and hides for 32 (the rate the hub already redraws at). */
  function draw(f, ev, tick) {
    const G = TEGEOM, L = layout(ev);
    f.rect(0, 0, SCREEN_W, SCREEN_H, ui.partyArt().bg);
    // the title, the count and the field
    ui.drawWindow(f, G.head.x, G.head.y, G.head.w, G.head.h);
    text(f, L.title.font, L.title.text, G.title.x, G.title.y, TEXT.dark);
    textRight(f, 'normal', L.count.text, G.head.x + G.head.w - 2, G.title.y, ev.length >= ev.max ? TEXT.red : TEXT.dark);
    if (L.field.text) text(f, L.field.font, L.field.text, G.field.x, G.field.y, TEXT.dark);
    if (L.field.clippedLeft) text(f, 'normal', '{LEFT}', G.marks.left, G.field.y, TEXT.dark);
    if (L.field.clippedRight) text(f, 'normal', '{RIGHT}', G.marks.right, G.field.y, TEXT.dark);
    if ((((tick | 0) >> 5) & 1) === 0) text(f, 'small', '{UP}', G.field.x + L.field.caretX + G.caret.dx, G.field.y + G.caret.dy, TEXT.red, TEXT.shadow);
    // the keys
    ui.drawWindow(f, L.win.x, L.win.y, L.win.w, L.win.h);
    for (const k of L.keys) {
      text(f, k.font, k.label, k.gx, k.y, TEXT.dark);
      if (k.selected) text(f, 'normal', '{CURSOR}', k.x - 1, k.y, TEXT.dark);
    }
    // the chips
    for (const c of L.chips) { ui.panel(f, c.x, c.y, c.w, c.h, c.selected ? 'sel' : 'normal', true); textCentre(f, c.font, c.label, c.x + c.w / 2, c.y, TEXT.dark, TEXT.shadow); }
    if (L.note.text) text(f, L.note.font, L.note.text, G.note.x, G.note.y, TEXT.white, TEXT.dark);
  }

  return { draw, layout };
}
